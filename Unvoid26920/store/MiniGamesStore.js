// store/MiniGamesStore.js — 互动组件的数据层
//
// 只负责 IndexedDB，不依赖页面、不操作 DOM、不写 localStorage。
//
// 两个 store：
//   components  组件本体（id / 标题 / 标签 / 一份自包含的 HTML 源码）
//   runs        一次运行记录（组件 id + 组件自己上报的结果 + 用时）——**只有组件调了
//               window.mgReport() 才会有**，多数玩具组件不产生记录
//
// ⚠️ 两条踩过的坑（与 TextgameStore 同一套，别抄老 Store 的 tx.done）：
//   1. `tx.done` 不是 IndexedDB 的标准属性。
//   2. 事务里只许 await 来自**本事务**的 IDB promise。中途 await 了别的事务/定时器，
//      事务会自动提交，后续 put 抛 TransactionInactiveError——症状是「偶发丢一步」。
//      所以级联删除一律走「同一个事务 + 游标回调」。

// ========== 常量 ==========
const DB_NAME = 'miniGamesDB';
const DB_VERSION = 1;

const S_COMPONENTS = 'components';
const S_RUNS = 'runs';

const LIMITS = {
    TITLE: 120,
    TAG: 24,           // 单个标签
    TAGS: 8,           // 标签个数
    HTML: 200000,      // 一份组件的源码上限
    MESSAGE: 300,      // 结果里的一句话
    RESULT: 4000       // 结果 JSON 序列化后的上限
};

const CHANGED_EVENT = 'minigames-changed';

// ========== 数据库连接 ==========
let dbPromise = null;
let dbInstance = null;

function openDB() {
    if (dbPromise) return dbPromise;

    const pending = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = event => {
            const db = event.target.result;

            // 幂等建：缺什么建什么，跑一百遍也没事，不需要 oldVersion 守卫
            // （只有「删 store / 改形状」这类破坏性步骤才要 e.oldVersion < N）
            if (!db.objectStoreNames.contains(S_COMPONENTS)) {
                const c = db.createObjectStore(S_COMPONENTS, { keyPath: 'id' });
                c.createIndex('updatedAt', 'updatedAt', { unique: false });
            }

            if (!db.objectStoreNames.contains(S_RUNS)) {
                const r = db.createObjectStore(S_RUNS, { keyPath: 'id' });
                r.createIndex('componentId', 'componentId', { unique: false });
                r.createIndex('createdAt', 'createdAt', { unique: false });
            }
        };

        request.onsuccess = () => {
            dbInstance = request.result;

            dbInstance.onversionchange = () => {
                console.warn('[MiniGamesStore] 数据库版本变更，关闭连接');
                dbInstance.close();
                dbInstance = null;
                dbPromise = null;
            };

            dbInstance.onclose = () => {
                console.warn('[MiniGamesStore] 数据库连接已关闭');
                dbInstance = null;
                dbPromise = null;
            };

            resolve(dbInstance);
        };

        request.onerror = () => {
            const error = request.error || new Error('互动组件数据库打开失败');
            console.error('[MiniGamesStore]', error);
            reject(error);
        };

        request.onblocked = () => {
            console.warn('[MiniGamesStore] 数据库打开被阻止，可能有其他标签页占用');
        };
    });

    // 失败一律先清 memo 再往外抛，否则一次失败会被永久缓存
    dbPromise = pending.catch(error => {
        dbPromise = null;
        throw error;
    });
    return dbPromise;
}

export function closeDB() {
    if (dbInstance) {
        dbInstance.close();
        dbInstance = null;
        dbPromise = null;
    }
}

// ========== 小工具 ==========
function requestToPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('请求失败'));
    });
}

function generateId(prefix) {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 9);
    const counter = (generateId.counter = (generateId.counter || 0) + 1).toString(36);
    return `${prefix}_${timestamp}_${random}_${counter}`;
}

function clampText(value, max) {
    const s = String(value ?? '');
    return s.length > max ? s.slice(0, max) : s;
}

function normalizeTags(tags) {
    const list = Array.isArray(tags) ? tags : String(tags || '').split(/\s+/);
    const out = [];
    for (const t of list) {
        const s = clampText(String(t || '').trim(), LIMITS.TAG).trim();
        if (s && !out.includes(s)) out.push(s);
        if (out.length >= LIMITS.TAGS) break;
    }
    return out;
}

function emitChange(detail) {
    try {
        window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail }));
    } catch { /* 非浏览器环境（纯函数单测）忽略 */ }
}

export function onMiniGamesChange(callback) {
    const handler = event => callback(event.detail);
    window.addEventListener(CHANGED_EVENT, handler);
    return () => window.removeEventListener(CHANGED_EVENT, handler);
}

// ========== 组件 ==========

/** 全部组件（含源码；列表渲染只需要标题和字符数，小体量够用），按最近更新降序 */
export async function listComponents() {
    const db = await openDB();
    const tx = db.transaction(S_COMPONENTS, 'readonly');
    const all = await requestToPromise(tx.objectStore(S_COMPONENTS).getAll());
    return (all || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getComponent(id) {
    if (!id) return null;
    const db = await openDB();
    const tx = db.transaction(S_COMPONENTS, 'readonly');
    return (await requestToPromise(tx.objectStore(S_COMPONENTS).get(id))) || null;
}

/**
 * 存一份组件。带 id = 就地更新（createdAt 保留原值），不带 = 新建。
 * 返回落库后的记录。
 */
export async function saveComponent({ id, title, html, tags } = {}) {
    const db = await openDB();
    const now = Date.now();
    const componentId = id || generateId('mgc');

    const tx = db.transaction(S_COMPONENTS, 'readwrite');
    const store = tx.objectStore(S_COMPONENTS);
    const existing = id ? await requestToPromise(store.get(componentId)) : null;

    const body = clampText(html, LIMITS.HTML);
    const record = {
        id: componentId,
        title: clampText(String(title || '').trim(), LIMITS.TITLE) || '未命名组件',
        html: body,
        tags: normalizeTags(tags),
        charCount: body.length,
        createdAt: existing ? (existing.createdAt || now) : now,
        updatedAt: now
    };

    store.put(record);
    await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('保存组件失败'));
        tx.onabort = () => reject(tx.error || new Error('保存组件已中止'));
    });

    emitChange({ type: 'component-saved', componentId });
    return record;
}

/** 删除组件，连同它的全部运行记录。级联必须在同一个事务里用游标。 */
export async function deleteComponent(componentId) {
    if (!componentId) return false;
    const db = await openDB();

    await new Promise((resolve, reject) => {
        const tx = db.transaction([S_COMPONENTS, S_RUNS], 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('删除组件失败'));
        tx.onabort = () => reject(tx.error || new Error('删除组件已中止'));

        tx.objectStore(S_COMPONENTS).delete(componentId);

        const cursorReq = tx.objectStore(S_RUNS).index('componentId').openCursor(IDBKeyRange.only(componentId));
        cursorReq.onsuccess = () => {
            const cur = cursorReq.result;
            if (!cur) return;
            cur.delete();
            cur.continue();
        };
    });

    emitChange({ type: 'component-deleted', componentId });
    return true;
}

// ========== 运行记录 ==========

/** 某个组件的运行记录，按时间降序 */
export async function listRuns(componentId) {
    const db = await openDB();
    const tx = db.transaction(S_RUNS, 'readonly');
    const store = tx.objectStore(S_RUNS);
    const all = componentId
        ? await requestToPromise(store.index('componentId').getAll(IDBKeyRange.only(componentId)))
        : await requestToPromise(store.getAll());
    return (all || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/** 记一次运行。result 是组件上报的任意结构（已由调用方截断/防脏）。 */
export async function addRun({ componentId, result, duration } = {}) {
    if (!componentId) return null;
    const db = await openDB();
    const record = {
        id: generateId('mgr'),
        componentId,
        result: result === undefined ? null : result,
        duration: Math.max(0, Math.round(Number(duration) || 0)),
        createdAt: Date.now()
    };

    const tx = db.transaction(S_RUNS, 'readwrite');
    tx.objectStore(S_RUNS).add(record);
    await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('保存运行记录失败'));
        tx.onabort = () => reject(tx.error || new Error('保存运行记录已中止'));
    });

    emitChange({ type: 'run-added', componentId, runId: record.id });
    return record;
}

/** 清掉某个组件的运行记录 */
export async function clearRuns(componentId) {
    if (!componentId) return false;
    const db = await openDB();

    await new Promise((resolve, reject) => {
        const tx = db.transaction(S_RUNS, 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('清空运行记录失败'));
        tx.onabort = () => reject(tx.error || new Error('清空运行记录已中止'));

        const cursorReq = tx.objectStore(S_RUNS).index('componentId').openCursor(IDBKeyRange.only(componentId));
        cursorReq.onsuccess = () => {
            const cur = cursorReq.result;
            if (!cur) return;
            cur.delete();
            cur.continue();
        };
    });

    emitChange({ type: 'runs-cleared', componentId });
    return true;
}

export { LIMITS, DB_NAME };

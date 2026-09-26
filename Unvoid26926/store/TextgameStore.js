// store/TextgameStore.js — 文游模块的数据层
//
// 只负责 IndexedDB，不依赖页面、不操作 DOM、不写 localStorage。
//
// 五个 store（文本量与指针分开，理由见每个 store 的注释）：
//   scripts     剧本元信息（列表渲染只读这张，绝不能把全部原文读进内存）
//   scriptTexts 剧本原文（**主键 = scriptId，一份剧本一条**；改名不动它，
//               但在剧本页保存正文 = 就地重写这一条 ⇒ 那个剧本下面每一局取到的都是新那份）
//   playthroughs 一遍游玩 = 剧本引用 + 临时主角 + 当前节点指针
//   nodes       每个节点一条，只增不改
//   presets     风格预设库 = 一份份预设，每份里一串条目
//               （**整个数组存一条记录**，见那个小节的注释）
//
// ⚠️ 两条踩过的坑：
//   1. `tx.done` 不是 IndexedDB 的标准属性（老 Store 里有，别抄）。
//   2. 事务里只许 await 来自**本事务**的 IDB promise。中途 await 了 fetch / setTimeout /
//      另一个事务的读，事务会自动提交，后续 put 抛 TransactionInactiveError——
//      症状是「偶发丢一步」，最难查的一类 bug。所以下面凡是要跨 store 的写，一律
//      走「同一个事务 + 游标回调」，绝不在中间 await 别的东西。

// ========== 常量 ==========
const DB_NAME = 'textgameDB';
// v2 = 加了 presets（风格预设库）。**加 store 才升版本**；加字段（如游玩上的 presetIds）不升、不迁移。
const DB_VERSION = 2;

const S_SCRIPTS = 'scripts';
const S_TEXTS = 'scriptTexts';
const S_PLAYS = 'playthroughs';
const S_NODES = 'nodes';
const S_PRESETS = 'presets';

/** presets 是 out-of-line key：整个数组装在一条记录里（同 werewolfStore 的 rules） */
const PRESETS_KEY = 'presets';

// 导出是给导入那条路用的：解析出来的条目**先量一下**再落库，超长就报给用户看
// （消毒层会照这里的数截断，别让截断悄悄发生——两处必须是同一个数）
export const LIMITS = {
    TITLE: 120,
    TEXT: 300000,      // 单份剧本原文上限（约 30 万字符）
    SOURCE_NAME: 200,
    PLAY_TITLE: 60,
    NAME: 24,          // 主角名
    NOTE: 300,         // 主角设定
    CHAR_REF: 120,     // 引用的角色 id（只防呆，不是内容长度）
    INPUT: 2000,       // 一步的玩家输入
    AI_TEXT: 60000,    // 一步的 AI 输出
    PREVIEW: 120,
    PRESET_NAME: 40,
    PRESET_TEXT: 20000
};

const CHANGED_EVENT = 'textgame-changed';

// ========== 数据库连接 ==========
let dbPromise = null;
let dbInstance = null;

function openDB() {
    if (dbPromise) return dbPromise;

    const pending = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = event => {
            const db = event.target.result;

            if (!db.objectStoreNames.contains(S_SCRIPTS)) {
                const s = db.createObjectStore(S_SCRIPTS, { keyPath: 'id' });
                s.createIndex('updatedAt', 'updatedAt', { unique: false });
            }

            // keyPath 就是 scriptId，一对一
            if (!db.objectStoreNames.contains(S_TEXTS)) {
                db.createObjectStore(S_TEXTS, { keyPath: 'scriptId' });
            }

            if (!db.objectStoreNames.contains(S_PLAYS)) {
                const p = db.createObjectStore(S_PLAYS, { keyPath: 'id' });
                p.createIndex('scriptId', 'scriptId', { unique: false });
                p.createIndex('updatedAt', 'updatedAt', { unique: false });
            }

            if (!db.objectStoreNames.contains(S_NODES)) {
                const n = db.createObjectStore(S_NODES, { keyPath: 'id' });
                n.createIndex('playthroughId', 'playthroughId', { unique: false });
                n.createIndex('byParent', ['playthroughId', 'parentId'], { unique: false });
            }

            // 风格预设库：**out-of-line key**，整个数组装在 PRESETS_KEY 那一条记录里
            // （同 werewolfStore 的 rules）。库里就几份短文本，一次读一次写、导入与排序都是原子的；
            // 所以不怕「列表把全部内容读进内存」——那条顾虑是给三十万字的剧本原文说的，不是给它。
            //
            // ⚠️ 这里**只建不删**。别处有「先 deleteObjectStore 再建」的样板，那是给「键形状变了」
            // 用的（狼人杀 v1→v2 那次）；这里没有形状变化，照抄那句就是把用户的库抹了。
            if (!db.objectStoreNames.contains(S_PRESETS)) {
                db.createObjectStore(S_PRESETS);
            }
        };

        request.onsuccess = () => {
            dbInstance = request.result;

            dbInstance.onversionchange = () => {
                console.warn('[TextgameStore] 数据库版本变更，关闭连接');
                dbInstance.close();
                dbInstance = null;
                dbPromise = null;
            };

            dbInstance.onclose = () => {
                console.warn('[TextgameStore] 数据库连接已关闭');
                dbInstance = null;
                dbPromise = null;
            };

            resolve(dbInstance);
        };

        request.onerror = () => {
            const error = request.error || new Error('文游数据库打开失败');
            console.error('[TextgameStore]', error);
            reject(error);
        };

        request.onblocked = () => {
            console.warn('[TextgameStore] 数据库打开被阻止，可能有其他标签页占用');
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

// 取一段文本的「尾句预览」：去 Markdown 记号、去换行，取末尾若干个字
export function tailPreview(text, len = 40) {
    const flat = String(text || '')
        .replace(/[#*`>_~\-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return flat.length > len ? '…' + flat.slice(-len) : flat;
}

function emitChange(detail) {
    try {
        window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail }));
    } catch { /* 非浏览器环境（纯函数单测）忽略 */ }
}

export function onTextgameChange(callback) {
    const handler = event => callback(event.detail);
    window.addEventListener(CHANGED_EVENT, handler);
    return () => window.removeEventListener(CHANGED_EVENT, handler);
}

// ========== 剧本 ==========

/** 全部剧本元信息（不含原文），按最近更新降序 */
export async function listScripts() {
    const db = await openDB();
    const tx = db.transaction(S_SCRIPTS, 'readonly');
    const all = await requestToPromise(tx.objectStore(S_SCRIPTS).getAll());
    return (all || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** 单份剧本 = 元信息 + 原文 */
export async function getScript(scriptId) {
    if (!scriptId) return null;
    const db = await openDB();
    const tx = db.transaction([S_SCRIPTS, S_TEXTS], 'readonly');
    const meta = await requestToPromise(tx.objectStore(S_SCRIPTS).get(scriptId));
    if (!meta) return null;
    const body = await requestToPromise(tx.objectStore(S_TEXTS).get(scriptId));
    return { ...meta, text: body?.text || '' };
}

/**
 * 新建或改写一份剧本。
 * @param {object} input
 * @param {string} [input.id] 传了就覆盖元信息；**原文只有在 text 也传了时才写**
 * @param {string} input.title
 * @param {string} [input.text]
 * @param {string} [input.sourceName]
 */
export async function saveScript({ id, title, text, sourceName = '' } = {}) {
    const db = await openDB();
    const now = Date.now();
    const scriptId = id || generateId('scr');

    const tx = db.transaction([S_SCRIPTS, S_TEXTS], 'readwrite');
    const scripts = tx.objectStore(S_SCRIPTS);
    const existing = id ? await requestToPromise(scripts.get(scriptId)) : null;

    const record = {
        id: scriptId,
        title: clampText(title || existing?.title || '未命名剧本', LIMITS.TITLE),
        charCount: existing?.charCount || 0,
        preview: existing?.preview || '',
        sourceName: clampText(sourceName || existing?.sourceName || '', LIMITS.SOURCE_NAME),
        // 「自由模式」（正文当 HTML 画）跟着剧本走，**默认开**：美化格式的剧本一进来就该是画好的样子，
        // 普通模式 = 正常的文字格式 md 解析（HTML 标签剥掉），不是「看原文」那一档。
        // 老剧本没有这个字段 ⇒ 也按开算。
        freeMode: existing ? existing.freeMode !== false : true,
        // 剧本级的两个提示词块（开关 + 文字）。**只搬运、不补默认**——
        // 没设过就是 null，取的时候由 textgameCore 的 normalizePrompts 兜底。
        prompts: existing?.prompts || null,
        createdAt: existing?.createdAt || now,
        updatedAt: now
    };

    if (typeof text === 'string') {
        const body = clampText(text, LIMITS.TEXT);
        record.charCount = body.length;
        record.preview = body.slice(0, LIMITS.PREVIEW).replace(/\s+/g, ' ').trim();
        tx.objectStore(S_TEXTS).put({ scriptId, text: body, updatedAt: now });
    }

    scripts.put(record);
    await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('保存剧本失败'));
        tx.onabort = () => reject(tx.error || new Error('保存剧本已中止'));
    });

    emitChange({ type: 'script-saved', scriptId });
    return record;
}

/** 只改名（不动原文） */
export async function renameScript(scriptId, title) {
    return saveScript({ id: scriptId, title });
}

/**
 * 只切「自由模式」（不动原文、不动标题）。
 * 这是**剧本级**的显示口径：同一份剧本下面的每一局都照它画，所以不放在 playthrough 上。
 */
export async function setScriptFreeMode(scriptId, freeMode) {
    const db = await openDB();
    const tx = db.transaction(S_SCRIPTS, 'readwrite');
    const scripts = tx.objectStore(S_SCRIPTS);
    const record = await requestToPromise(scripts.get(scriptId));
    if (!record) return null;

    record.freeMode = !!freeMode;
    record.updatedAt = Date.now();
    scripts.put(record);

    await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('切换自由模式失败'));
        tx.onabort = () => reject(tx.error || new Error('切换自由模式已中止'));
    });
    emitChange({ type: 'script-saved', scriptId });
    return record;
}

/**
 * 写剧本级的两块提示词（开关 + 文字）。传进来的是**整份 prompts**，不是补丁——
 * 两个块各自独立，调用方自己合并好；只写空块就是「退回没动过」。
 * 同 setScriptFreeMode：这是剧本的属性，同一份剧本下面每一局都照它发。
 */
export async function setScriptPrompts(scriptId, prompts) {
    const db = await openDB();
    const tx = db.transaction(S_SCRIPTS, 'readwrite');
    const scripts = tx.objectStore(S_SCRIPTS);
    const record = await requestToPromise(scripts.get(scriptId));
    if (!record) return null;

    record.prompts = prompts || null;
    record.updatedAt = Date.now();
    scripts.put(record);

    await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('保存提示词设置失败'));
        tx.onabort = () => reject(tx.error || new Error('保存提示词设置已中止'));
    });
    emitChange({ type: 'script-saved', scriptId });
    return record;
}

/**
 * 级联删除：剧本 + 原文 + 它的全部游玩 + 那些游玩的全部节点。
 * 整件事在**一个事务**里用游标完成——不能先另开事务读 playId 列表再删。
 */
export async function deleteScript(scriptId) {
    if (!scriptId) return false;
    const db = await openDB();

    await new Promise((resolve, reject) => {
        const tx = db.transaction([S_SCRIPTS, S_TEXTS, S_PLAYS, S_NODES], 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('删除剧本失败'));
        tx.onabort = () => reject(tx.error || new Error('删除剧本已中止'));

        tx.objectStore(S_SCRIPTS).delete(scriptId);
        tx.objectStore(S_TEXTS).delete(scriptId);

        const nodes = tx.objectStore(S_NODES);
        const playCursor = tx.objectStore(S_PLAYS).index('scriptId').openCursor(IDBKeyRange.only(scriptId));
        playCursor.onsuccess = () => {
            const cur = playCursor.result;
            if (!cur) return;
            const playId = cur.value.id;
            cur.delete();

            const nodeCursor = nodes.index('playthroughId').openCursor(IDBKeyRange.only(playId));
            nodeCursor.onsuccess = () => {
                const nc = nodeCursor.result;
                if (!nc) return;
                nc.delete();
                nc.continue();
            };
            cur.continue();
        };
    });

    emitChange({ type: 'script-deleted', scriptId });
    return true;
}

// ========== 游玩 ==========

/** 某份剧本下的全部游玩 */
export async function listPlaythroughs(scriptId) {
    const db = await openDB();
    const tx = db.transaction(S_PLAYS, 'readonly');
    const all = await requestToPromise(tx.objectStore(S_PLAYS).index('scriptId').getAll(scriptId));
    return (all || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/**
 * 全部游玩，按最近更新降序。
 * 首页「继续游玩」和各剧本的游玩数都从这一次读取里分组算出来，不逐个剧本查。
 */
export async function listAllPlaythroughs() {
    const db = await openDB();
    const tx = db.transaction(S_PLAYS, 'readonly');
    const all = await requestToPromise(tx.objectStore(S_PLAYS).getAll());
    return (all || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getPlaythrough(playId) {
    if (!playId) return null;
    const db = await openDB();
    const tx = db.transaction(S_PLAYS, 'readonly');
    return (await requestToPromise(tx.objectStore(S_PLAYS).get(playId))) || null;
}

/**
 * 开一遍新游玩。**不生成开场**——开场由玩家在游玩页自己点（避免误烧一次调用）。
 */
export async function createPlaythrough({ scriptId, protagonist } = {}) {
    const db = await openDB();
    const now = Date.now();
    const name = clampText(protagonist?.name || '', LIMITS.NAME);

    const existing = await listPlaythroughs(scriptId);

    const record = {
        id: generateId('play'),
        scriptId,
        title: `${name || '主角'} · 第 ${existing.length + 1} 局`,
        protagonist: {
            name,
            note: clampText(protagonist?.note || '', LIMITS.NOTE),
            // 从名册引用来的那个角色的 id（**只存 id，不抄它的正文**：详细设定与秘密每轮
            // 现读角色卡，所以角色改了下一轮就变、角色没了那两截就没了）；
            // 缺省 null = 没引用任何角色，老记录零迁移。
            ref: clampText(protagonist?.ref || '', LIMITS.CHAR_REF) || null
        },
        currentNodeId: null,
        rootNodeId: null,
        nodeCount: 0,
        nodeSeq: 0,
        lastPreview: '',
        pending: null,
        // 这一局用哪一份风格预设（**只存 id**，名字与条目每轮现读库）。null = 不选，
        // 一条都不发，提示词逐字节与加这个功能之前相同。
        presetPackId: null,
        // 那一份预设里**这一局开着**的条目 id。选预设时铺成「全开」，之后在 ⋯ 菜单里关。
        // 老记录没有这两个字段，读侧 presetPackIdOf / presetIdsOf 兜底，零迁移。
        presetIds: [],
        // 「这份预设被你手调成什么样了」的记忆：{预设 id → 条目 id 数组}，**只在 ⋯ 菜单里
        // 手动勾/取消条目时才写**（只挑一份、没碰条目列表的不写 ⇒ 手滑点一下不留痕）。
        // 唯一读它的时候是「重新选某份预设」那一下（core 的 presetIdsForPack）：
        // 记忆里的条目还在 ⇒ 恢复成离开时的样子；全被删光了 ⇒ 当没记忆、回到全开。
        // ⚠️ 它**不参与拼提示词**（那是 presetIds 的事），歪不到生成上去。
        presetPicks: {},
        createdAt: now,
        updatedAt: now
    };

    const tx = db.transaction(S_PLAYS, 'readwrite');
    tx.objectStore(S_PLAYS).put(record);
    await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('创建游玩失败'));
        tx.onabort = () => reject(tx.error || new Error('创建游玩已中止'));
    });

    emitChange({ type: 'play-created', playId: record.id, scriptId });
    return record;
}

/** 改游玩记录上的若干字段（改名、挪指针、写/清 pending 都走这里） */
export async function updatePlaythrough(playId, patch = {}) {
    if (!playId) return null;
    const db = await openDB();
    const tx = db.transaction(S_PLAYS, 'readwrite');
    const plays = tx.objectStore(S_PLAYS);
    const play = await requestToPromise(plays.get(playId));
    if (!play) return null;

    const next = { ...play, ...patch, id: play.id, updatedAt: Date.now() };
    next.protagonist = { ...play.protagonist, ...(patch.protagonist || {}) };
    plays.put(next);

    await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('更新游玩失败'));
        tx.onabort = () => reject(tx.error || new Error('更新游玩已中止'));
    });
    return next;
}

/** 把指针挪到某个节点（点路径卡「切到这里」就是它） */
export async function setCurrentNode(playId, nodeId) {
    return updatePlaythrough(playId, { currentNodeId: nodeId });
}

/** 写/清生成票据。清就是传 null。 */
export async function setPending(playId, pending) {
    return updatePlaythrough(playId, { pending: pending || null });
}

export async function deletePlaythrough(playId) {
    if (!playId) return false;
    const db = await openDB();
    await new Promise((resolve, reject) => {
        const tx = db.transaction([S_PLAYS, S_NODES], 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('删除游玩失败'));
        tx.onabort = () => reject(tx.error || new Error('删除游玩已中止'));

        tx.objectStore(S_PLAYS).delete(playId);
        const nodes = tx.objectStore(S_NODES);
        const nodeCursor = nodes.index('playthroughId').openCursor(IDBKeyRange.only(playId));
        nodeCursor.onsuccess = () => {
            const nc = nodeCursor.result;
            if (!nc) return;
            nc.delete();
            nc.continue();
        };
    });

    emitChange({ type: 'play-deleted', playId });
    return true;
}

// ========== 节点 ==========

/** 一遍游玩的全部节点，按 seq 升序。树在内存里拼，库里只存平铺的节点。 */
export async function listNodes(playId) {
    if (!playId) return [];
    const db = await openDB();
    const tx = db.transaction(S_NODES, 'readonly');
    const all = await requestToPromise(tx.objectStore(S_NODES).index('playthroughId').getAll(playId));
    return (all || []).sort((a, b) => (a.seq || 0) - (b.seq || 0));
}

/**
 * 落一步：挂一个新节点 + 指针前移 + 清 pending，**一个事务**。
 *
 * 为什么必须原子：分开写会出现「节点落了但指针没挪」（孤儿节点）或
 * 「指针指向不存在的节点」（整条路径断掉），两种都很难手工修。
 *
 * requestId 是防呆：如果票已经被更晚的一次请求换掉了（双标签页、迟到的响应），
 * 这次结果作废，不写库。
 *
 * @returns {Promise<{ok:true, node:object, play:object}|{ok:false, reason:string}>}
 */
export async function commitTurn({ playId, parentId, playerInput, aiText, kind = 'advance', requestId } = {}) {
    if (!playId || !aiText) return { ok: false, reason: 'missing' };
    const db = await openDB();

    return new Promise((resolve, reject) => {
        const tx = db.transaction([S_PLAYS, S_NODES], 'readwrite');
        let settled = null;

        tx.oncomplete = () => {
            if (settled?.ok) emitChange({ type: 'turn', playId, nodeId: settled.node.id });
            resolve(settled || { ok: false, reason: 'missing' });
        };
        tx.onerror = () => reject(tx.error || new Error('写入节点失败'));
        // 中止是「主动 abort」这条路的正常出口（票对不上、或这局已经不在了）。
        // 结论已经在 settled 里了，这里照搬——写死 stale-pending 会把 missing 吞掉，
        // 调用方就拿不到「这一局不在了」，只会报成「另开了一个窗口在玩同一局」。
        tx.onabort = () => resolve(settled || { ok: false, reason: 'stale-pending' });

        const plays = tx.objectStore(S_PLAYS);
        const getReq = plays.get(playId);

        getReq.onsuccess = () => {
            const play = getReq.result;
            // 票对不上 / 根本没有票 ⇒ 这次结果作废。
            // 中途只碰本事务的请求，不 await 任何外部 promise（见文件头注释）。
            if (!play || !play.pending || play.pending.requestId !== requestId) {
                settled = { ok: false, reason: play ? 'stale-pending' : 'missing' };
                try { tx.abort(); } catch { /* 已结束就忽略 */ }
                return;
            }

            const now = Date.now();
            const seq = (play.nodeSeq || 0) + 1;
            const node = {
                id: generateId('nd'),
                playthroughId: playId,
                parentId: parentId || null,
                playerInput: clampText(playerInput, LIMITS.INPUT),
                aiText: clampText(aiText, LIMITS.AI_TEXT),
                kind,
                seq,
                createdAt: now
            };
            tx.objectStore(S_NODES).put(node);

            play.currentNodeId = node.id;
            if (!play.rootNodeId) play.rootNodeId = node.id;
            play.nodeCount = (play.nodeCount || 0) + 1;
            play.nodeSeq = seq;
            play.lastPreview = tailPreview(node.aiText, 40);
            play.pending = null;
            play.updatedAt = now;
            plays.put(play);

            settled = { ok: true, node, play };
        };
    });
}

/** 删掉一步（「丢弃这一步」用）。只允许删叶节点，避免把子树挂空。 */
export async function deleteNode(nodeId) {
    if (!nodeId) return false;
    const db = await openDB();
    const tx = db.transaction(S_NODES, 'readwrite');
    tx.objectStore(S_NODES).delete(nodeId);
    await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('删除节点失败'));
        tx.onabort = () => reject(tx.error || new Error('删除节点已中止'));
    });
    return true;
}

// ========== 风格预设（模块级一个库：一份份「预设」，每份里一串条目） ==========
//
// 一层「预设」= 一套方案 `{ id, name, entries }`；一局**选一份预设**（也可以不选），
// 局内的 ⋯ 菜单只决定这份预设里的条目**这一局开不开**。
//
// 一个条目 = `{ id, name, text, where }`：
//   name  给它起的名字（列表与菜单上显示的都只是它，**名字绝不进提示词**）
//   text  真正发出去的那段字（原样，模块不加标题也不加工）
//   where 装在哪：'system' = 接在 system 最末尾；'current' = 附在末尾那条 user 里、行动之前
//
// **预设里数组的下标就是注入顺序**（用户口径：A 在上 B 在下 ⇒ 先 A 后 B）。所以这一层只要
// 老老实实把数组按顺序存下来；排序（↑↓ 换位）在页面里做，落回来还是这个整条数组。
//
// 内置那一份（id = 'builtin'，见 textgameCore 的 BUILTIN_PACK）也走这里，但它存的是
// **覆盖层**：字节与内置相同、或是空白的字段，一律当「没改过」——解析时补回内置的值，
// 于是模块以后改进内置文案，没动过的那几条还跟得上（同两块提示词的「存空 = 从没动过」）。
// 这一层**只管存**，覆盖怎么合并归 core 的 resolvePackEntries。
//
// 引用语义同主角引用：游玩记录上只存 id（哪份预设 + 开了哪几条）。**删掉一份预设 / 一条条目
// 不回头改任何一份游玩记录**——那些 id 静静地不参与（读侧 presetPackIdOf / presetIdsOf +
// resolvePresetTexts 三处都跳过），不留「（预设已删除）」这种话：
// 那一刻那一局照旧跑得下去，缺口不是事实。

/**
 * 只留四个字段、别的全丢。**读和写都过这一遍**：store 里是自由结构，
 * 读出来什么形状不该漏进提示词（同 werewolfStore 的 sanitizeTemplates）。
 * `where` 在这一层**只保证是个字符串**——枚举归 textgameCore 管
 * （PRESET_WHERE 住那儿；认不出的值由 core 回落到 'system'），免得同一条白名单抄两份。
 * `name` / `text` 的**空串要原样留着**：对内置那份来说，空 = 没改过（不是「改成了空」）。
 */
function sanitizeEntries(list) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(list) ? list : []) {
        if (!raw || typeof raw !== 'object') continue;
        const id = clampText(raw.id, 120).trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({
            id,
            name: clampText(raw.name, LIMITS.PRESET_NAME),
            text: clampText(raw.text, LIMITS.PRESET_TEXT),
            where: typeof raw.where === 'string' ? raw.where : ''
        });
    }
    return out;
}

/** 一份预设：名字 + 它自己的条目表（条目不再分家，一份预设就是一套） */
function sanitizePacks(list) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(list) ? list : []) {
        if (!raw || typeof raw !== 'object') continue;
        const id = clampText(raw.id, 120).trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({
            id,
            name: clampText(raw.name, LIMITS.PRESET_NAME),
            entries: sanitizeEntries(raw.entries)
        });
    }
    return out;
}

/**
 * 整个库（一份份预设）。没载过 / 库是空的 → []。
 * ⚠️ 读取只认 `packs` 这个键：更早那一版存的是扁平条目表（键 `list`），形状对不上，
 * 宁可从空开始也不去猜着搬家——那一版从来没发出去过，歪着读反而会把脏数据喂进提示词。
 */
export async function listPresets() {
    const db = await openDB();
    const tx = db.transaction(S_PRESETS, 'readonly');
    const record = await requestToPromise(tx.objectStore(S_PRESETS).get(PRESETS_KEY));
    return sanitizePacks(record?.packs);
}

/** 整个库一次性写回（新建/改名/删除一份预设、加/改/删/换位一条条目，**都走这一个口**） */
export async function savePresets(packs) {
    const db = await openDB();
    const clean = sanitizePacks(packs);
    const tx = db.transaction(S_PRESETS, 'readwrite');
    tx.objectStore(S_PRESETS).put({ packs: clean }, PRESETS_KEY);
    await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('保存预设失败'));
        tx.onabort = () => reject(tx.error || new Error('保存预设已中止'));
    });
    emitChange({ type: 'preset-saved', count: clean.length });
    return clean;
}

/** 新预设（一份方案）的 id。`pack_` 前缀，与内置那份的 `builtin`、与条目 id 都从字面上分得开 */
export function newPackId() {
    return generateId('pack');
}

/** 新条目的 id。`entry_` 前缀——内置那 6 条是 `builtin_` 开头，一眼看得出哪些不给删 */
export function newEntryId() {
    return generateId('entry');
}

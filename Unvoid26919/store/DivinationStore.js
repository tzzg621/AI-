// store/DivinationStore.js
// 占卜屋记录存储：签筒每日一签 + 塔罗占卜历史，按 owner（主视角角色）归属。
// 只负责 IndexedDB，不依赖页面、不操作 DOM、不写 localStorage。
// 持久层语义（引用化为设计取向，2026-09-05 拍板；倾向非铁律，个别场景确需
//   少量副本/快照时说明理由即可）：payload 默认不落正文副本，只存引用键——
//   签 = stickId；塔罗牌 = cardNo/orientation/posKey。正文本体在内容库
//   divinationContent.js，回看/列表经引用现查（修订优先）。保留的小字段：
//   ownerNameSnapshot（归属显示名）+ payload.ai（AI 动态产物，本体唯一一份）。
//   白名单即取向落点：读写两侧 normalize 同款收窄，旧版记录（已含副本）不迁移，
//   读回时经同一白名单自然剥离，零迁移成本。
// 备份说明：本库由备份 v2 的 indexedDB.databases() 全量枚举自动纳入（settingsDataBackup.js
// FALLBACK_DB_NAMES 兜底名单无需登记，保持不变；若未来需要支持无 databases() 的浏览器再补名单）。

const DB_NAME = 'divinationDB';
const DB_VERSION = 1;

const STORE_RECORDS = 'records';

const MAX_PER_OWNER = 120;   // 每角色历史上限（含签 + 塔罗合计），超限删最旧
const VALID_KINDS = ['sign', 'tarot-one', 'tarot-three'];
const VALID_ORIENTATIONS = ['upright', 'reversed'];

// ---- 文本长度上限（normalize 用；签/牌正文不在此列——payload 不落正文副本）----
const L_OWNER_NAME = 40;
const L_STICK_ID = 40;
const L_QUESTION = 80;
const L_POS_KEY = 20;
const L_AI_STYLE = 32;      // AI 细解：占卜师风格 id
const L_AI_TITLE = 16;      // AI 细解：占卜师称号
const L_AI_TEXT = 12000;    // AI 细解：解文上限（防单条撑爆配额）

let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = event => {
            const db = event.target.result;

            let recordStore;
            if (db.objectStoreNames.contains(STORE_RECORDS)) {
                recordStore = event.target.transaction.objectStore(STORE_RECORDS);
            } else {
                recordStore = db.createObjectStore(STORE_RECORDS, { keyPath: 'id' });
            }

            if (!recordStore.indexNames.contains('ownerId')) {
                recordStore.createIndex('ownerId', 'ownerId', { unique: false });
            }

            if (!recordStore.indexNames.contains('createdAt')) {
                recordStore.createIndex('createdAt', 'createdAt', { unique: false });
            }
        };

        request.onsuccess = () => {
            const db = request.result;

            db.onversionchange = () => {
                db.close();
                dbPromise = null;
            };

            resolve(db);
        };

        request.onerror = () => reject(request.error);
    }).catch(error => {
        dbPromise = null;
        throw error;
    });

    return dbPromise;
}

function makeId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve(true);
        transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
        transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
    });
}

// ---- normalize：白名单 + 长度截断，引用化入库（旧记录读回经同款收窄自然剥离）----
// AI 细解段（只挂塔罗 payload）：白名单 + 截断；空/无效 → undefined（读回即未解态）
function normalizeTarotAiReading(input) {
    if (!input || typeof input !== 'object') return undefined;
    const text = String(input.text || '').trim();
    if (!text) return undefined;

    return {
        style: String(input.style || '').slice(0, L_AI_STYLE),
        title: String(input.title || '').slice(0, L_AI_TITLE),
        text: text.slice(0, L_AI_TEXT),
        createdAt: Number(input.createdAt) || Date.now()
    };
}

// 签 payload 引用化：只留 stickId。签文正文/层级在内容库，回看现查，不落副本。
function normalizeStickPayload(input) {
    return {
        stickId: String(input?.stickId || '').slice(0, L_STICK_ID)
    };
}

// 塔罗 payload 引用化：每张牌只留 cardNo/orientation/posKey（正文本体在内容库，
// 展示经 divinationContent.expandTarotCards 现查）；spread/question/ai 照存
// （ai 是 AI 动态产物，本体唯一一份）。
// 扩展位（2026-09-05 构想）：未来「牌面专属改写」= 卡结构加 override 覆盖层字段
// 并同步扩白名单，原文默认不落库；老记录与读侧 normalize 天然兼容，零迁移。
function normalizeTarotPayload(input) {
    const cards = Array.isArray(input?.cards)
        ? input.cards
            .map(card => ({
                cardNo: Number(card?.cardNo),
                orientation: VALID_ORIENTATIONS.includes(card?.orientation)
                    ? card.orientation
                    : 'upright',
                posKey: String(card?.posKey || '').slice(0, L_POS_KEY)
            }))
            .slice(0, 3)
        : [];

    return {
        spread: input?.spread === 'three' ? 'three' : 'single',
        question: String(input?.question || '').trim().slice(0, L_QUESTION),
        cards,
        ai: normalizeTarotAiReading(input?.ai)   // AI 细解（签路径永不出现）
    };
}

function normalizeRecord(input) {
    const kind = VALID_KINDS.includes(input?.kind) ? input.kind : null;
    const ownerId = String(input?.ownerId || '').trim();
    const dateKey = String(input?.dateKey || '');

    return {
        id: String(input?.id || makeId('div')),
        kind,
        ownerId,
        ownerNameSnapshot: String(input?.ownerNameSnapshot || '').slice(0, L_OWNER_NAME),
        dateKey,                             // 本地时区 YYYY-MM-DD（门禁只比字符串）
        createdAt: Number(input?.createdAt) || Date.now(),
        payload: kind === 'sign'
            ? normalizeStickPayload(input?.payload)
            : normalizeTarotPayload(input?.payload)
    };
}

// ============================================================
// 导出 API
// ============================================================

export function createRecordId() {
    return makeId('div');
}

export async function addRecord(input) {
    const normalized = normalizeRecord(input);

    if (!normalized.ownerId || !normalized.kind || !/^\d{4}-\d{2}-\d{2}$/.test(normalized.dateKey)) {
        console.warn('[DivinationStore] 记录缺少 ownerId/kind/dateKey，拒绝写入');
        return null;
    }

    try {
        const db = await openDB();
        const transaction = db.transaction(STORE_RECORDS, 'readwrite');
        transaction.objectStore(STORE_RECORDS).put(normalized);
        await transactionDone(transaction);
        await pruneOwner(normalized.ownerId);
        dispatchChange({ type: 'add', record: normalized });
        return normalized;
    } catch (error) {
        console.warn('[DivinationStore] 写入记录失败', error);
        return null;
    }
}

// AI 细解回写：单事务内存在性检查后更新 payload.ai。
// 记录已删 → 返回 null，绝不复活；不触发 prune（条数不变）。
export async function attachTarotAi(recordId, ai) {
    if (!recordId) return null;

    const normalizedAi = normalizeTarotAiReading(ai);
    if (!normalizedAi) return null;

    try {
        const db = await openDB();
        const transaction = db.transaction(STORE_RECORDS, 'readwrite');
        const store = transaction.objectStore(STORE_RECORDS);

        const record = await new Promise(resolve => {
            const request = store.get(recordId);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => resolve(null);
        });
        if (!record) return null;    // 已被删除 → 丢弃回写

        const merged = normalizeRecord({
            ...record,
            payload: { ...record.payload, ai: normalizedAi }
        });
        store.put(merged);
        await transactionDone(transaction);
        return merged;
    } catch (error) {
        console.warn('[DivinationStore] AI 细解读写失败', error);
        return null;
    }
}

export async function getRecord(recordId) {
    if (!recordId) return null;

    try {
        const db = await openDB();

        return await new Promise(resolve => {
            const transaction = db.transaction(STORE_RECORDS, 'readonly');
            const request = transaction.objectStore(STORE_RECORDS).get(recordId);

            request.onsuccess = () => resolve(request.result ? normalizeRecord(request.result) : null);
            request.onerror = () => resolve(null);
            transaction.onabort = () => resolve(null);
        });
    } catch (error) {
        console.warn('[DivinationStore] 读取记录失败', error);
        return null;
    }
}

export async function listByOwner(ownerId, { limit = 30, kind = null } = {}) {
    if (!ownerId) return [];

    try {
        const db = await openDB();

        return await new Promise(resolve => {
            const transaction = db.transaction(STORE_RECORDS, 'readonly');
            const request = transaction.objectStore(STORE_RECORDS).index('ownerId').getAll(ownerId);

            request.onsuccess = () => {
                const list = (request.result || [])
                    .map(normalizeRecord)
                    .filter(record => !kind || record.kind === kind)
                    .sort((a, b) => b.createdAt - a.createdAt)
                    .slice(0, limit);
                resolve(list);
            };

            request.onerror = () => resolve([]);
            transaction.onabort = () => resolve([]);
        });
    } catch (error) {
        console.warn('[DivinationStore] 读取角色占卜记录失败', error);
        return [];
    }
}

export async function deleteRecord(recordId) {
    if (!recordId) return false;

    try {
        const db = await openDB();
        const transaction = db.transaction(STORE_RECORDS, 'readwrite');
        transaction.objectStore(STORE_RECORDS).delete(recordId);
        await transactionDone(transaction);
        dispatchChange({ type: 'delete', id: recordId });
        return true;
    } catch (error) {
        console.warn('[DivinationStore] 删除记录失败', error);
        return false;
    }
}

export async function clearOwner(ownerId) {
    if (!ownerId) return false;

    try {
        const records = await listByOwner(ownerId, { limit: MAX_PER_OWNER + 50 });
        if (!records.length) return true;

        const db = await openDB();
        const transaction = db.transaction(STORE_RECORDS, 'readwrite');
        const store = transaction.objectStore(STORE_RECORDS);
        for (const record of records) store.delete(record.id);
        await transactionDone(transaction);
        dispatchChange({ type: 'clear', ownerId });
        return true;
    } catch (error) {
        console.warn('[DivinationStore] 清空角色记录失败', error);
        return false;
    }
}

// 超限裁剪：只删该 owner 最旧的超量部分（单事务批量删）
async function pruneOwner(ownerId) {
    try {
        const records = await listByOwner(ownerId, { limit: MAX_PER_OWNER + 20 });
        if (records.length <= MAX_PER_OWNER) return;

        const db = await openDB();
        const transaction = db.transaction(STORE_RECORDS, 'readwrite');
        const store = transaction.objectStore(STORE_RECORDS);
        for (const record of records.slice(MAX_PER_OWNER)) store.delete(record.id);
        await transactionDone(transaction);
    } catch (error) {
        console.warn('[DivinationStore] 裁剪旧记录失败', error);
    }
}

// ---- 变更事件（模块内订阅，用于缓存失效）----
const CHANGE_EVENT = 'divination-changed';

function dispatchChange(detail) {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail }));
}

export function onDivinationChange(callback) {
    const handler = event => {
        try { callback(event.detail); } catch (e) { console.warn('[DivinationStore] 变更回调异常', e); }
    };
    window.addEventListener(CHANGE_EVENT, handler);
    return () => window.removeEventListener(CHANGE_EVENT, handler);
}

console.log('[DivinationStore] 模块已加载');

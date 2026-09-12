// apps/games/werewolfStore.js — 狼人杀独立 IndexedDB 存储
// DB: werewolfDB v2
//   sessions（keyPath id）+ 索引 status / participantIds(multiEntry)：一桌一局的完整记录（含 forming 准备态）
//   stats（keyPath characterId）：按角色累计的战绩
//   npcs（keyPath npcId）：临时路人池（不在名册里，只在本库）
//   rooms（keyPath typeId）：房间分类配置 + 该类累计开桌数（本期由代码常量种子写入）
//
// 约定：
// - 只存角色 id（关联角色），不复制角色卡正文。
// - 占用判定 = sessions 里 status ∈ {forming, ongoing} 且 participantIds 含该 id（跨桌、跨分类互斥）。
// - 一类房间下可以同时存在多张桌：sessions 里同 typeId 的多条记录，各占一个 tableNo。

const DB_NAME = 'werewolfDB';
const DB_VERSION = 2;

const STORE_SESSIONS = 'sessions';
const STORE_STATS = 'stats';
const STORE_NPCS = 'npcs';
const STORE_ROOMS = 'rooms';

// 占用中的局状态（其余状态一律视为解锁）
export const ACTIVE_STATUS = ['forming', 'ongoing'];

let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = e => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
                const store = db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
                store.createIndex('status', 'status');
                store.createIndex('participantIds', 'participantIds', { multiEntry: true });
            }
            if (!db.objectStoreNames.contains(STORE_STATS)) {
                // out-of-line key = characterId（照 simCityStore 的 profiles 范式）
                db.createObjectStore(STORE_STATS);
            }
            if (!db.objectStoreNames.contains(STORE_NPCS)) {
                db.createObjectStore(STORE_NPCS, { keyPath: 'npcId' });
            }
            // v2：rooms 从「一桌一条」改成「一个分类一条」（键 roomId → typeId）
            if (db.objectStoreNames.contains(STORE_ROOMS)) db.deleteObjectStore(STORE_ROOMS);
            db.createObjectStore(STORE_ROOMS, { keyPath: 'typeId' });
        };
        req.onsuccess = () => {
            const db = req.result;
            db.onversionchange = () => {
                db.close();
                dbPromise = null;
            };
            resolve(db);
        };
        req.onerror = () => reject(req.error);
    }).catch(error => {
        dbPromise = null;
        throw error;
    });

    return dbPromise;
}

// 统一的三重兜底读（onerror / abort / 异常都返回 fallback）
function readStore(storeName, fn, fallback) {
    return openDB().then(db => new Promise(resolve => {
        const tx = db.transaction(storeName, 'readonly');
        const out = fn(tx.objectStore(storeName));
        out.onsuccess = () => resolve(out.result);
        out.onerror = () => resolve(fallback);
        tx.onabort = () => resolve(fallback);
    })).catch(error => {
        console.error('[werewolfDB] 读取失败', storeName, error);
        return fallback;
    });
}

// 统一的三重兜底写
function writeStore(storeName, fn) {
    return openDB().then(db => new Promise(resolve => {
        const tx = db.transaction(storeName, 'readwrite');
        fn(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
    })).catch(error => {
        console.error('[werewolfDB] 写入失败', storeName, error);
        return false;
    });
}

export function newSessionId() {
    return 'ww_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

/* ================================================================ */
/*  sessions（局）                                                    */
/* ================================================================ */

export async function getSession(id) {
    if (!id) return null;
    return (await readStore(STORE_SESSIONS, s => s.get(id), null)) || null;
}

export async function saveSession(session) {
    if (!session?.id) return false;
    session.updatedAt = Date.now();
    // 索引字段：参与者（角色 id，去重、不含路人）
    session.participantIds = [...new Set((session.seats || [])
        .filter(x => x.kind === 'character' && x.characterId)
        .map(x => x.characterId))];
    return writeStore(STORE_SESSIONS, s => s.put(session));
}

export async function listSessions() {
    return (await readStore(STORE_SESSIONS, s => s.getAll(), [])) || [];
}

export async function deleteSession(id) {
    if (!id) return false;
    return writeStore(STORE_SESSIONS, s => s.delete(id));
}

/** 所有未结束（占用中）的局 */
export async function listActiveSessions() {
    const all = await listSessions();
    return all.filter(s => ACTIVE_STATUS.includes(s.status));
}

/** 某类房间下所有未结束的桌（一类可以同时开多张桌） */
export async function listActiveSessionsByType(typeId) {
    const active = await listActiveSessions();
    return active.filter(s => s.typeId === typeId).sort((a, b) => (a.tableNo || 0) - (b.tableNo || 0));
}

/** 某角色参与的占用中的局（局未结束 / 未流局时不许进别的房间） */
export async function getActiveSessionForCharacter(characterId) {
    if (!characterId) return null;
    const active = await listActiveSessions();
    return active.find(s => (s.participantIds || []).includes(characterId)) || null;
}

/** 全部被锁住的角色 id（邀请 / 匹配 / 落座的排除名单） */
export async function getBusyCharacterIds() {
    const active = await listActiveSessions();
    const set = new Set();
    for (const s of active) for (const id of s.participantIds || []) set.add(id);
    return set;
}

/* ================================================================ */
/*  stats（按角色累计）                                                */
/* ================================================================ */

function emptyStat(characterId) {
    return {
        characterId,
        played: 0,
        win: 0,
        lose: 0,
        byRole: {},        // { 身份id: { played, win } }
        byType: {},        // { 房间分类id: { played, win } }
        streak: 0,         // 当前连胜
        survival: 0,       // 活到最后的局数
        lastPlayedAt: 0,
        version: 1         // 扩展位：以后加字段只加不改结构
    };
}

export async function getStat(characterId) {
    if (!characterId) return null;
    return (await readStore(STORE_STATS, s => s.get(characterId), null)) || null;
}

/** 全部角色的战绩（「我的」页以后用；本期只写不读） */
export async function listStats() {
    const db = await openDB().catch(() => null);
    if (!db) return [];
    return new Promise(resolve => {
        const tx = db.transaction(STORE_STATS, 'readonly');
        const req = tx.objectStore(STORE_STATS).openCursor();
        const out = [];
        req.onsuccess = () => {
            const cursor = req.result;
            if (cursor) {
                out.push({ ...cursor.value, characterId: cursor.value.characterId || cursor.key });
                cursor.continue();
            } else resolve(out);
        };
        req.onerror = () => resolve([]);
        tx.onabort = () => resolve([]);
    });
}

/**
 * 一局结束后累加某个角色的战绩
 * @param {string} characterId
 * @param {{ role: string, win: boolean, survived: boolean, typeId: string }} detail
 */
export async function applyGameResult(characterId, detail) {
    if (!characterId || !detail) return false;
    const current = (await getStat(characterId)) || emptyStat(characterId);
    const stat = { ...emptyStat(characterId), ...current };
    stat.byRole = { ...(current.byRole || {}) };
    stat.byType = { ...(current.byType || {}) };

    const win = !!detail.win;
    stat.played += 1;
    if (win) { stat.win += 1; stat.streak = (current.streak || 0) + 1; }
    else { stat.lose += 1; stat.streak = 0; }
    if (detail.survived) stat.survival = (current.survival || 0) + 1;

    if (detail.role) {
        const cell = stat.byRole[detail.role] || { played: 0, win: 0 };
        stat.byRole[detail.role] = { played: cell.played + 1, win: cell.win + (win ? 1 : 0) };
    }
    if (detail.typeId) {
        const cell = stat.byType[detail.typeId] || { played: 0, win: 0 };
        stat.byType[detail.typeId] = { played: cell.played + 1, win: cell.win + (win ? 1 : 0) };
    }

    stat.lastPlayedAt = Date.now();
    return writeStore(STORE_STATS, s => s.put(stat, characterId));
}

/* ================================================================ */
/*  npcs（路人池）                                                    */
/* ================================================================ */

export function newNpcId() {
    return 'npc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

export async function getNpc(npcId) {
    if (!npcId) return null;
    return (await readStore(STORE_NPCS, s => s.get(npcId), null)) || null;
}

export async function saveNpc(npc) {
    if (!npc?.npcId) return false;
    npc.lastSeenAt = Date.now();
    return writeStore(STORE_NPCS, s => s.put(npc));
}

export async function listNpcs() {
    return (await readStore(STORE_NPCS, s => s.getAll(), [])) || [];
}

/** 路人打完一局：累计局数与胜场（不进角色战绩） */
export async function recordNpcGame(npcId, win) {
    const npc = await getNpc(npcId);
    if (!npc) return false;
    npc.games = (npc.games || 0) + 1;
    npc.wins = (npc.wins || 0) + (win ? 1 : 0);
    return saveNpc(npc);
}

/* ================================================================ */
/*  rooms（房间分类配置 + 该类累计开桌数）                              */
/* ================================================================ */

export async function listRoomTypes() {
    return (await readStore(STORE_ROOMS, s => s.getAll(), [])) || [];
}

/** 用代码常量播种分类配置（已存在的不覆盖，保留 tableSeq 与以后手改的可能） */
export async function seedRoomTypes(list) {
    if (!list?.length) return false;
    return writeStore(STORE_ROOMS, store => {
        for (const type of list) {
            const get = store.get(type.typeId);
            get.onsuccess = () => {
                if (!get.result) store.put({ ...type, tableSeq: 0, updatedAt: Date.now() });
            };
        }
    });
}

/**
 * 取该类下一个桌号（「第 N 桌」）。
 * tableSeq 只增不减：桌被打散、流局、删掉都不会让号重复。
 */
export async function nextTableNo(typeId) {
    const db = await openDB().catch(() => null);
    if (!db) return 1;
    return new Promise(resolve => {
        let seq = 1;
        const tx = db.transaction(STORE_ROOMS, 'readwrite');
        const store = tx.objectStore(STORE_ROOMS);
        const get = store.get(typeId);
        get.onsuccess = () => {
            const rec = get.result || { typeId, tableSeq: 0 };
            seq = (rec.tableSeq || 0) + 1;
            store.put({ ...rec, typeId, tableSeq: seq, updatedAt: Date.now() });
        };
        tx.oncomplete = () => resolve(seq);
        tx.onerror = () => resolve(1);
        tx.onabort = () => resolve(1);
    });
}

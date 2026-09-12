// apps/games/werewolfStore.js — 狼人杀独立 IndexedDB 存储
// DB: werewolfDB v2
//   sessions（keyPath id）+ 索引 status / participantIds(multiEntry)：一桌一局的完整记录（含 forming 准备态）
//   stats（**out-of-line key = characterId**）：真实角色的角色档案 = 战绩 + 档位 + 点亮
//     （名册里的、网络里的都算「真实角色」——能不能上桌和坐不坐主视角是两回事：
//      参与只要求它是个角色，主视角才必须是名册角色；所以这里按 characterId 存，不查名册）
//   npcs（keyPath npcId）：临时路人池（凑人数现造的，只在本库）；路人档案**与 stats 同形**
//   rooms（keyPath typeId）：房间分类配置 + 该类累计开桌数（本期由代码常量种子写入）
//
// 约定：
// - 只存角色 id（关联角色），不复制角色卡正文。
// - 占用判定 = sessions 里 status ∈ {forming, ongoing} 且 participantIds 含该 id（跨桌、跨分类互斥）。
// - 一类房间下可以同时存在多张桌：sessions 里同 typeId 的多条记录，各占一个 tableNo。
// - session 是自由结构（phase/votes/revealMode 明牌暗牌等字段由引擎与界面往上挂）：
//   新加字段只要不建索引就不用升 DB_VERSION，老记录缺字段时由读侧兜底。
// - **档案（stats / npcs）不加新 store、不升版本**：档位与点亮是往既有记录上挂的扩展字段，
//   `{ ...blank(), ...current }` 保得住未知字段，老记录照旧读得出。升 DB_VERSION 会顺手
//   重建 rooms（onupgradeneeded 里那次 deleteObjectStore 没有版本守卫），桌号会从头再来。
// - 战绩的累加只有一份（本文件的 accumulate），真实角色与临时路人两条档案线共用；
//   手册/界面只**读**这里写好的字段，本文件不 import apps/ 里任何模块（依赖只向下）。

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
/*  档案底座（stats 与 npcs 共用同一个形状）                            */
/* ================================================================ */

/**
 * 一份角色档案：战绩 + 档位 + 点亮。真实角色（名册/网络）与临时路人**共用这一套字段**，
 * 所以累加与点亮都只有一份逻辑，两条线不会漂。
 * 后半段（level/flair/why/at/unlocked）全部**可缺**——「谁先来谁先建档案」：
 * 先测评就先有档位，先打完就先有战绩，另一块留着是空的。
 */
function blank() {
    return {
        played: 0,
        win: 0,
        lose: 0,
        byRole: {},        // { 身份id: { played, win } }
        byType: {},        // { 房间分类id: { played, win } }
        streak: 0,         // 当前连胜
        survival: 0,       // 活到最后的局数
        lastPlayedAt: 0,
        level: null,       // 落座测评：水平档（werewolfCodex.TIERS 的 key）
        flair: null,       // 落座测评：悟性档（FLAIR_TIERS 的 key）
        why: '',           // 那一句依据（没依据不算数，见 werewolfCodex）
        at: 0,             // 测评时间
        unlocked: [],      // 结算时按条件授予的条目 id（werewolfCodex.earnedIds）
        version: 1         // 扩展位：以后加字段只加不改结构
    };
}

function emptyStat(characterId) {
    return { characterId, ...blank() };
}

/** 新的路人记录（名字 + 人设 + 同一套档案字段） */
export function emptyNpc({ npcId, name = '', persona = '', typeId = '' }) {
    return { ...blank(), npcId, name, persona, typeId, createdAt: Date.now() };
}

/* ---------------- 战绩累加（本层私有：档案怎么长，由记录的主人说了算） ----------------
 * 名册角色（applyGameResult）与路人（recordNpcGame）共用这一段，两条档案线不会各算各的。
 * 依赖方向：store 不 import apps/ 里任何东西——手册/界面读的是这里写好的字段，
 * 反过来 store 一个字都不关心「什么叫点亮」。纯函数，不改入参；时间戳由落库处打。
 */

function bump(map, key, win) {
    const out = { ...(map || {}) };
    if (key) {
        const cell = out[key] || { played: 0, win: 0 };
        out[key] = { played: (Number(cell.played) || 0) + 1, win: (Number(cell.win) || 0) + (win ? 1 : 0) };
    }
    return out;
}

/**
 * 一局打完，往记录上累一笔（缺字段、空记录都不炸）。
 * @param {object} record 上一份记录
 * @param {{role?:string, win?:boolean, survived?:boolean, typeId?:string}} detail
 */
export function accumulate(record, detail = {}) {
    const base = record || {};
    const win = !!detail.win;
    return {
        ...base,
        played: (Number(base.played) || 0) + 1,
        win: (Number(base.win) || 0) + (win ? 1 : 0),
        lose: (Number(base.lose) || 0) + (win ? 0 : 1),
        streak: win ? (Number(base.streak) || 0) + 1 : 0,
        survival: (Number(base.survival) || 0) + (detail.survived ? 1 : 0),
        byRole: bump(base.byRole, detail.role, win),
        byType: bump(base.byType, detail.typeId, win)
    };
}

/** 已授予的 ∪ 这次算出的（去重保序） */
function mergeIds(oldIds, ids) {
    const out = [...(oldIds || [])];
    const have = new Set(out);
    for (const id of ids || []) if (id && !have.has(id)) { have.add(id); out.push(id); }
    return out;
}

/**
 * 点亮 = 往档案上并上一批条目 id（幂等；stats 与 npcs 共用这一段读写）。
 * 记录还不存在就先建一条——「谁先来谁先建档案」。
 * @param {boolean} outOfLine stats 是 out-of-line key（put 要带键），npcs 是 keyPath（不能带）
 */
async function lightIds(storeName, key, ids, makeBlank, outOfLine = true) {
    if (!key || !ids?.length) return false;
    const current = (await readStore(storeName, s => s.get(key), null)) || makeBlank();
    const merged = mergeIds(current.unlocked, ids);
    if (merged.length === (current.unlocked || []).length) return true;   // 没有新点亮的，不写这一次
    const next = { ...makeBlank(), ...current, unlocked: merged };
    return writeStore(storeName, s => (outOfLine ? s.put(next, key) : s.put(next)));
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
 * 一局结束后累加某个真实角色的战绩（名册里的、网络里的都走这一条）。
 * 累加走本文件的 accumulate（与路人那一条线共用），这里只负责读改写与落库。
 * @param {string} characterId
 * @param {{ role: string, win: boolean, survived: boolean, typeId: string }} detail
 * @returns {Promise<object|null>} 写成功返回**新的档案**（调用方接着算该点亮哪些），失败 null
 */
export async function applyGameResult(characterId, detail) {
    if (!characterId || !detail) return null;
    const current = (await getStat(characterId)) || emptyStat(characterId);
    const stat = { ...emptyStat(characterId), ...accumulate(current, detail) };
    stat.lastPlayedAt = Date.now();
    return (await writeStore(STORE_STATS, s => s.put(stat, characterId))) ? stat : null;
}

/**
 * 把这次算出来该点亮的条目授予某个角色（并集去重，幂等）。
 * 读侧一律用「授予 ∪ 现在算得出」，所以这里少写一笔也不会让手册缺一条——
 * 它的作用是**记住**：条件将来改严了，也不该把已经点亮的灭掉。
 * @returns {Promise<boolean>} 没有新增时也算成功（不写库）
 */
export async function lightEntries(characterId, ids) {
    return lightIds(STORE_STATS, characterId, ids, () => emptyStat(characterId));
}

/**
 * 落座测评的那一笔：水平 / 悟性 / 依据 / 时间。缺一项都不写（没依据不算数）。
 * **第一次估的算数**：已经有档位的不再覆盖——点数只在落座那一刻生成一次，
 * 又邀请一次不等于重估一次（本轮没有重测入口，用户 2026-09-12 定）。
 * 问不问是 AI 层的事（有档位就不问），这里是**真正管用的那道**：万一还是送到了，也不覆盖。
 * @returns {Promise<boolean>} 写进去、或本来就有档位无须写，都算成功
 */
export async function upsertCodex(characterId, codex) {
    if (!characterId || !codex?.level) return false;
    const current = await getStat(characterId);
    if (current?.level) return true;
    const stat = {
        ...emptyStat(characterId), ...(current || {}),
        level: codex.level, flair: codex.flair || null, why: codex.why || '', at: Date.now()
    };
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

/**
 * 路人打完一局：往他**自己那一份**档案上累一笔（与名册角色同一套字段、同一段累加逻辑）。
 * 路人不上名册，所以数据只在本库里；记全是为了以后能复用同一个路人，而不是每次重造。
 * @param {{ role: string, win: boolean, survived: boolean, typeId: string }} detail
 * @returns {Promise<object|null>} 写成功返回新的档案（调用方接着算该点亮哪些），失败 null
 */
export async function recordNpcGame(npcId, detail) {
    if (!npcId || !detail) return null;
    const npc = await getNpc(npcId);
    if (!npc) return null;
    const next = { ...npc, ...accumulate(npc, detail), lastPlayedAt: Date.now(), lastSeenAt: Date.now() };
    return (await writeStore(STORE_NPCS, s => s.put(next))) ? next : null;
}

/** 路人该点亮哪些（与名册角色同一套条件判定） */
export async function lightNpcEntries(npcId, ids) {
    return lightIds(STORE_NPCS, npcId, ids, () => emptyNpc({ npcId }), false);
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

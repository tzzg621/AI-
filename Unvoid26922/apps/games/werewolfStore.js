// apps/games/werewolfStore.js — 狼人杀独立 IndexedDB 存储
// DB: werewolfDB v3
//   sessions（keyPath id）+ 索引 status / participantIds(multiEntry)：一桌一局的完整记录（含 forming 准备态）
//   stats（**out-of-line key = characterId**）：真实角色的角色档案 = 战绩 + 档位 + 点亮
//     （名册里的、网络里的都算「真实角色」——能不能上桌和坐不坐主视角是两回事：
//      参与只要求它是个角色，主视角才必须是名册角色；所以这里按 characterId 存，不查名册）
//   npcs（keyPath npcId）：临时路人池（凑人数现造的，只在本库）；路人档案**与 stats 同形**
//   rooms（keyPath typeId）：房间分类配置 + 该类累计开桌数（本期由代码常量种子写入）
//   rules（**out-of-line key**）：这一桌的做法约定模板库，一条记录（键 'templates'）装下整个数组
//
// 约定：
// - 只存角色 id（关联角色），不复制角色卡正文。
// - 占用判定 = sessions 里 status ∈ {forming, ongoing} 且 participantIds 含该 id（跨桌、跨分类互斥）。
// - 一类房间下可以同时存在多张桌：sessions 里同 typeId 的多条记录，各占一个 tableNo。
// - session 是自由结构（phase/votes/revealMode 明牌暗牌等字段由引擎与界面往上挂）：
//   新加字段只要不建索引就不用升 DB_VERSION，老记录缺字段时由读侧兜底。
// - **加字段不升版本，加 store 才升**：档案（stats / npcs）的档位、点亮、钻石都是往既有记录上挂的
//   扩展字段，`{ ...blank(), ...current }` 保得住未知字段，老记录照旧读得出；加一个新 store（v3 的 rules）
//   才需要升 DB_VERSION，而「缺什么建什么」是幂等的、免守卫的——见 onupgradeneeded 顶部那段说明。
// - 战绩的累加只有一份（本文件的 accumulate），真实角色与临时路人两条档案线共用；
//   手册/界面只**读**这里写好的字段，本文件不 import apps/ 里任何模块（依赖只向下）。

const DB_NAME = 'werewolfDB';
const DB_VERSION = 3;

const STORE_SESSIONS = 'sessions';
const STORE_STATS = 'stats';
const STORE_NPCS = 'npcs';
const STORE_ROOMS = 'rooms';
const STORE_RULES = 'rules';

// rules 里那条记录的键：一条装下整个模板数组 [{ id, name, text }]
const RULES_KEY = 'templates';

// 占用中的局状态（其余状态一律视为解锁）
export const ACTIVE_STATUS = ['forming', 'ongoing'];

let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = e => {
            const db = e.target.result;

            /*
             * 迁移只有两种，照 simCityStore 的形状排（那里是 `else if (e.oldVersion < 4)` 配 clear()）：
             *
             * ① **破坏性步骤**（删 store / 改形状）：形状变了的 store 没别的办法，只能重建。
             *    这类步骤必须写 `e.oldVersion < N`——它不是补丁，是这步迁移的**身份**：
             *    「这一档还没跑过」才跑，一个库一生只跑一次。rooms 的键从 roomId 变成 typeId
             *    就是这种（v2）。漏了守卫的后果不是「这次多删一次」，而是**以后每次**加 store
             *    都会顺手把它重建一遍、各类房间的累计开桌数从头再来（v3 才补上）。
             *
             * ② **幂等建**（缺什么建什么）：跑一百遍也没事，所以**不需要守卫**，也不需要
             *    记住任何规矩——以后加 store 就往下面那块加一行。升 DB_VERSION 只是为了
             *    让 onupgradeneeded 有机会跑，不为别的。
             */

            if (e.oldVersion < 2 && db.objectStoreNames.contains(STORE_ROOMS)) {
                db.deleteObjectStore(STORE_ROOMS);   // v1→v2：rooms 的键 roomId → typeId，形状变了
            }

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
            if (!db.objectStoreNames.contains(STORE_ROOMS)) {
                db.createObjectStore(STORE_ROOMS, { keyPath: 'typeId' });
            }
            if (!db.objectStoreNames.contains(STORE_RULES)) {
                db.createObjectStore(STORE_RULES);   // v3：做法约定模板库（out-of-line key = 'templates'）
            }
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

/**
 * 最近结束的几桌（打完的、流局的都算）——**打完就地在桌上复盘，退出后靠它回来**。
 * 排序看结束时间；老记录没有 endedAt/voidedAt 就退到 updatedAt：结算那一下必然写过它。
 */
export async function listRecentEndedSessions(limit = 3) {
    const stampOf = s => s.endedAt || s.voidedAt || s.updatedAt || 0;
    return (await listSessions())
        .filter(s => s.status === 'ended' || s.status === 'voided')
        .sort((a, b) => stampOf(b) - stampOf(a))
        .slice(0, limit);
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

/* ---------------- 钻石（角色私有的货币） ----------------
 * 用户 2026-09-13 定：钻石是这个游戏的货币资源，**每个角色初始 100**、**赢一局 +100**；
 * **货币与道具都是角色私有**——换主视角就是换一个钱包，不是全局账。
 * 花处有两处：看一条「心声」（HEART_COST × openHeart）、在活动页买许愿水晶（CRYSTAL_COST ×
 * 商店的购买钮），以及赢一局进账（accumulate）。
 *
 * **老档案没有 coins 这个字段**：读侧一律走 coinsOf（缺就是初始值），
 * 所以这里不加新 store、不升版本——与 level/flair/unlocked 那几个扩展字段一个待遇。
 * 后来的 `items`（背包）也是同一套待遇，见下面那一段。
 */

export const START_COINS = 100;   // 每个角色的初始钻石
export const WIN_COINS = 100;     // 赢一局加多少
export const HEART_COST = 1;      // 看一条心声花几颗
export const CRYSTAL = 'crystal'; // 背包里「许愿水晶」的键（名字与价钱属于界面，见 werewolf.js 的商店）
export const CRYSTAL_COST = 20;   // 许愿水晶一颗几钻

/** 读一份档案的余额：没这个字段（老档案、还没打过的新角色）就是初始值；脏值兜到 0 以上 */
export function coinsOf(record) {
    const n = Number(record?.coins);
    if (!Number.isFinite(n)) return START_COINS;
    return Math.max(0, Math.floor(n));
}

/**
 * 扣钻的**纯算术**：够就返回扣完的余额，不够返回 null。
 * 算账与写账分开：调用方先问「够不够、剩多少」，写不写由落库那一步定（见 `spendCoins`）。
 */
export function spendFrom(record, n = HEART_COST) {
    const cost = Math.max(0, Math.floor(Number(n) || 0));
    const left = coinsOf(record) - cost;
    return left < 0 ? null : left;
}

/**
 * 读改写**这一个角色**的档案（角色私有）。`mutate` 拿到库里那份旧记录、返回要盖上去的几格；
 * 返回 null 就整个不动、也返回 null。买钻、买道具、用道具都走这一段，读改写只有一份。
 */
async function withStat(characterId, mutate) {
    if (!characterId) return null;
    const current = await getStat(characterId);
    const patch = mutate(current);
    if (!patch) return null;
    const stat = { ...emptyStat(characterId), ...(current || {}), ...patch };
    return (await writeStore(STORE_STATS, s => s.put(stat, characterId))) ? stat : null;
}

/**
 * 花掉 n 颗钻石：不够就一颗不扣、返回 null；写库失败也返回 null。
 * **只动钻石**——买了什么由调用方自己决定往背包里放（见 buyItem），这一层不猜。
 */
export async function spendCoins(characterId, n = HEART_COST) {
    const stat = await withStat(characterId, rec => {
        const left = spendFrom(rec, n);
        return left === null ? null : { coins: left };
    });
    return stat ? coinsOf(stat) : null;
}

/* ---------------- 背包（角色私有的道具） ----------------
 * 用户 2026-09-18 定：活动页商店上架**许愿水晶 20 钻一颗**，买下的存在角色自己的背包里，
 * 开局前可以花一颗把这一局的身份许成自选的（见 werewolf.js 的 askWish / 引擎 startGame 的 claims）。
 *
 * 形状只有一格 `items: { crystal: n }`，跟 coins 一样**不升版本、读侧兜底**：
 * 老档案没这个字段就是空背包（一律走 itemsOf）。**仍然不记流水**——
 * 这一层只回答「现在背包里有几件」，不回答「什么时候花的、花在哪一局」：
 * 许愿那件事记在**那一局**的 claim 上（开局动作的参数），不记在钱包里，两本账不混。
 */

/** 读一份档案的背包：没这个字段 / 脏值（负数、非数、空键）一律当没有那件 */
export function itemsOf(record) {
    const raw = record?.items;
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [id, n] of Object.entries(raw)) {
        const count = Math.floor(Number(n));
        if (id && Number.isFinite(count) && count > 0) out[id] = count;
    }
    return out;
}

/** 收进 n 件的**纯算术**：返回新的背包（算账与写账分开，同 `spendFrom`） */
export function addItemsOf(record, itemId, n = 1) {
    const add = Math.max(0, Math.floor(Number(n) || 0));
    const bag = itemsOf(record);
    if (!itemId || !add) return bag;
    return { ...bag, [itemId]: (bag[itemId] || 0) + add };
}

/** 用掉 n 件的**纯算术**：够就返回扣完的背包，不够返回 null（不是扣成负数）；扣到 0 就把那格删掉 */
export function takeItemsOf(record, itemId, n = 1) {
    const take = Math.max(0, Math.floor(Number(n) || 0));
    const bag = itemsOf(record);
    const left = (bag[itemId] || 0) - take;
    if (!itemId || left < 0) return null;
    const out = { ...bag };
    if (left > 0) out[itemId] = left; else delete out[itemId];
    return out;
}

/**
 * 买 n 件：钻石够就扣钻、收进背包。返回**新的档案**（调用方接着读 coinsOf / itemsOf），
 * 不够或写库失败返回 null（那种情况下钻石与背包都不动）。
 */
export async function buyItem(characterId, itemId, cost, n = 1) {
    return withStat(characterId, rec => {
        const left = spendFrom(rec, cost * n);
        if (left === null) return null;
        return { coins: left, items: addItemsOf(rec, itemId, n) };
    });
}

/** 用掉 n 件：背包够就扣一件、**不碰钻石**。返回新档案，不够或写库失败返回 null */
export async function useItem(characterId, itemId, n = 1) {
    return withStat(characterId, rec => {
        const bag = takeItemsOf(rec, itemId, n);
        return bag === null ? null : { items: bag };
    });
}

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
        coins: START_COINS,   // 钻石余额（角色私有，读侧一律走 coinsOf；见上面的那一段）
        items: {},         // 背包：{ 道具id: 件数 }（角色私有，读侧一律走 itemsOf；见上面的那一段）
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
        insights: [],      // 逐局累积的「复盘心得」（玩家亲手点出来的，见 appendInsight）
        exp: {},           // 身份经验：{ 身份id: 累计得分 }。分由引擎在结算那一刻算好（scoreGame），
                           // 这里只负责累加。**含负数照加**——减分不咬到经验，「猎人无脑开枪」就没代价了
        scoreLog: [],      // 逐局明细：{at, sessionId, role, total, items}。留着是为了以后那句
                           // 「你在 XX 局打 XX 得了负分」能说清为什么——不存就永远补不回来
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
 * 身份经验加一笔（与 `bump` 不同形：这里是一格数，不是一份子记录）。
 * 读侧兜底照 `coinsOf` 的规矩：老档案没有 `exp` 就是空的、脏值当 0。
 * 得分为 0 的局不建键（免得每个身份都挂一个 0）；**负分照加**，这是用户要的机制。
 */
function addExp(map, role, score) {
    const out = { ...(map || {}) };
    const n = Number(score);
    if (role && Number.isFinite(n) && n !== 0) out[role] = (Number(out[role]) || 0) + n;
    return out;
}

/**
 * 逐局明细追加一条（同上：老档案没有 `scoreLog` 就是空的）。
 * 只留引擎算好的那几格。`at` 也是由**落库处**传进来的（`detail.at`）——这一层是纯函数，
 * 不自己取时间，规矩见上面那段注释。
 */
function pushScore(log, detail) {
    const list = Array.isArray(log) ? log : [];
    if (!detail.role || !Number.isFinite(Number(detail.score))) return list;
    return [...list, {
        at: Number(detail.at) || 0,
        sessionId: detail.sessionId || '',
        role: detail.role,
        total: Number(detail.score),
        items: Array.isArray(detail.items) ? detail.items : []
    }];
}

/**
 * 一局打完，往记录上累一笔（缺字段、空记录都不炸）。
 * @param {object} record 上一份记录
 * @param {{role?:string, win?:boolean, survived?:boolean, typeId?:string,
 *          sessionId?:string, score?:number, items?:Array<{k:string,v:number}>}} detail
 *   `score`/`items` 是引擎 `scoreGame` 在结算那一刻算好的这一个座位的分与明细；
 *   缺了就当没有（老调用点、老档案都不炸）。
 */
export function accumulate(record, detail = {}) {
    const base = record || {};
    const win = !!detail.win;
    return {
        ...base,
        played: (Number(base.played) || 0) + 1,
        win: (Number(base.win) || 0) + (win ? 1 : 0),
        lose: (Number(base.lose) || 0) + (win ? 0 : 1),
        // 赢一局进账（角色私有；输了不动——钻石只增不减，唯一的花处是买心声）
        coins: coinsOf(base) + (win ? WIN_COINS : 0),
        streak: win ? (Number(base.streak) || 0) + 1 : 0,
        survival: (Number(base.survival) || 0) + (detail.survived ? 1 : 0),
        byRole: bump(base.byRole, detail.role, win),
        byType: bump(base.byType, detail.typeId, win),
        exp: addExp(base.exp, detail.role, detail.score),
        scoreLog: pushScore(base.scoreLog, detail)
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
    const now = Date.now();
    const current = (await getStat(characterId)) || emptyStat(characterId);
    const stat = { ...emptyStat(characterId), ...accumulate(current, { at: now, ...detail }) };
    stat.lastPlayedAt = now;
    return (await writeStore(STORE_STATS, s => s.put(stat, characterId))) ? stat : null;
}

/* ---------------- 复盘心得（角色数据，逐局累积） ----------------
 * 这一栏装的是「这个角色自己复盘出来的东西」：心得正文 + 它派生的那条记忆。
 * 归属与去处是两件事（用户 2026-09-16 定）——
 *   · **心得**是狼人杀的履历 ⇒ 就留在这里；
 *   · **记忆**是角色自己的 ⇒ 经 `saveInsightMemory`（werewolf.js）写进 `char_<id>.memories`，
 *     这里那一份只是**这次调用产出了什么**的底账（对外模块不作数，谁也不该来这儿读记忆）。
 * **一局一条**：同一个 sessionId 已经有了就不再追加——重进房间再点一次头像不该烧第二次调用，
 * 也不该在档案里留两条。**不设条数上限**（玩家亲手点出来的东西，用户口径：不设计上限截断）。
 */

/**
 * 追加一条本局心得。already-there 时原样返回**已有档案**（不写库），调用方据此判断「这局已经做过了」。
 * @param {string} characterId
 * @param {{sessionId:string, at?:number, text:string, memory?:string, ...}} entry
 * @returns {Promise<object|null>} 新的（或原有的）档案；没写成功 null
 */
export async function appendInsight(characterId, entry) {
    if (!characterId || !entry?.sessionId || !entry?.text) return null;
    const current = (await getStat(characterId)) || emptyStat(characterId);
    if ((current.insights || []).some(i => i.sessionId === entry.sessionId)) return current;
    const stat = {
        ...emptyStat(characterId), ...current,
        insights: [...(current.insights || []), { at: Date.now(), ...entry }]
    };
    return (await writeStore(STORE_STATS, s => s.put(stat, characterId))) ? stat : null;
}

/** 某条心得里派生的记忆被写进角色记忆了（存一次时间戳；记忆正文不在这儿放第二份） */
export async function markInsightMemorySaved(characterId, sessionId, at = Date.now()) {
    if (!characterId || !sessionId) return null;
    const current = await getStat(characterId);
    if (!current) return null;
    const stat = {
        ...current,
        insights: (current.insights || []).map(i => (i.sessionId === sessionId ? { ...i, memorySavedAt: at } : i))
    };
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
    const now = Date.now();
    const next = { ...npc, ...accumulate(npc, { at: now, ...detail }), lastPlayedAt: now, lastSeenAt: now };
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

/* ================================================================ */
/*  rules（这一桌的做法约定：模板库 + 同步缓存）                        */
/* ================================================================ */

/*
 * 模板库是**全局**的（作者写一份，各桌按 id 勾选引用）：桌只存「勾了哪几条 + 自己写的一段补充」，
 * 正文永远从这里现取——所以改一条模板，引用了它的桌（含正在打的）下一次调用就是新文字。
 * 这就是「引用」与「复制快照」的分界，也是这个功能的命门。
 * 桌的 `ruleTemplateIds` 里留着一个已删模板的 id 是**允许的**：读侧 `find` 不到就跳过，不回头清引用。
 *
 * 那份缓存是必需的，不是偷懒：提示词组装（roleHead → roleHeadText）是**同步**的，每个对局内
 * 调用都要用，不可能每处去读库。ensureRuleTemplates() 在开桌流程里载一次，之后一律
 * cachedRuleTemplates()；唯一的写入口是 saveRuleTemplates()，它顺手更新缓存，两边不会不同步。
 */

/**
 * 一条模板只用这三样：id（各桌按它引用）、name（列表上的大字）、text（进提示词的正文）。
 * 别的字段一律丢掉——store 是自由结构，读出来什么形状不该漏进提示词。
 */
function sanitizeTemplates(list) {
    return (Array.isArray(list) ? list : [])
        .filter(t => t && typeof t.id === 'string' && t.id)
        .map(t => ({
            id: t.id,
            name: typeof t.name === 'string' ? t.name : '',
            text: typeof t.text === 'string' ? t.text : ''
        }));
}

let rulesCache = [];      // 模块级缓存：提示词侧同步读它
let rulesLoaded = false;  // 载过没有——载过就不再读库（写入时同步更新缓存）
let rulesLoading = null;  // 并发的 ensure 共用同一次读

/** 同步取缓存。没载过 / 库里是空的 → []（**不预置任何模板**，空库起步） */
export function cachedRuleTemplates() {
    return rulesCache;
}

/** 开桌流程里调一次：把库读进缓存。读不动就当空库，不抛（提示词那边要的只是「有个数组」） */
export async function ensureRuleTemplates() {
    if (rulesLoaded) return rulesCache;
    if (!rulesLoading) {
        rulesLoading = readStore(STORE_RULES, s => s.get(RULES_KEY), null).then(raw => {
            if (!rulesLoaded) {
                rulesCache = sanitizeTemplates(raw);
                rulesLoaded = true;
            }
            rulesLoading = null;
            return rulesCache;
        });
    }
    return rulesLoading;
}

/** 整条数组写回 + 同步更新缓存（模板的增删改都走这里，改完对新老各桌一起生效） */
export async function saveRuleTemplates(list) {
    rulesCache = sanitizeTemplates(list);
    rulesLoaded = true;
    return writeStore(STORE_RULES, s => s.put(rulesCache, RULES_KEY));
}

export function newTemplateId() {
    return 'rule_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

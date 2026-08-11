// apps/games/simCityStore.js — 模拟小城独立 IndexedDB 存储
// DB: simCityDB / store: profiles（key=角色id）+ stories（key=剧情id）

const DB_NAME = 'simCityDB';
const DB_VERSION = 4;   // ★ 升到 4：chats 改为分块存储
const STORE_PROFILES = 'profiles';
const STORE_STORIES = 'stories';
const STORE_CHATS = 'chats';

let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_PROFILES)) db.createObjectStore(STORE_PROFILES);
            if (!db.objectStoreNames.contains(STORE_STORIES)) db.createObjectStore(STORE_STORIES);
            if (!db.objectStoreNames.contains(STORE_CHATS)) db.createObjectStore(STORE_CHATS);
            else if (e.oldVersion < 4) {
                // ★ v3→v4：旧结构（每消息一key）清空，改用分块
                e.target.transaction.objectStore(STORE_CHATS).clear();
            }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
    });
    return dbPromise;
}

export async function getProfile(roleId) {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_PROFILES, 'readonly');
        const req = tx.objectStore(STORE_PROFILES).get(roleId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
    });
}

export async function getAllProfiles() {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_PROFILES, 'readonly');
        const req = tx.objectStore(STORE_PROFILES).openCursor();
        const result = [];
        req.onsuccess = () => {
            const cursor = req.result;
            if (cursor) {
                result.push({ ...cursor.value, id: cursor.key });   // ★ 把 key 贴回档案
                cursor.continue();
            } else {
                resolve(result);
            }
        };
        req.onerror = () => resolve([]);
    });
}

export async function saveProfile(profile, roleId) {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_PROFILES, 'readwrite');
        tx.objectStore(STORE_PROFILES).put(profile, roleId);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
    });
}

// 批量写：单事务多次 put（工资结算 / 约定清理等场景用，避免 N 次串行事务）
export async function saveProfiles(list) {
    if (!list || !list.length) return true;
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_PROFILES, 'readwrite');
        const store = tx.objectStore(STORE_PROFILES);
        for (const { profile, roleId } of list) store.put(profile, roleId);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
    });
}

// ---- 剧情（互动记忆雏形）----
export async function saveStory(story) {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_STORIES, 'readwrite');
        tx.objectStore(STORE_STORIES).put(story, story.id);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
    });
}

// 某角色参与的所有剧情（时间倒序）
export async function getStories(roleId) {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_STORIES, 'readonly');
        const req = tx.objectStore(STORE_STORIES).getAll();
        req.onsuccess = () => resolve(
            (req.result || [])
                .filter(s => s.participants && s.participants.includes(roleId))
                .sort((a, b) => b.timestamp - a.timestamp)
        );
        req.onerror = () => resolve([]);
    });
}

// 两个角色之间的所有剧情（pairKey 双向匹配）
export async function getPairStories(roleIdA, roleIdB) {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_STORIES, 'readonly');
        const req = tx.objectStore(STORE_STORIES).getAll();
        req.onsuccess = () => resolve(
            (req.result || []).filter(s => s.pairKey === [roleIdA, roleIdB].sort().join('_'))
        );
        req.onerror = () => resolve([]);
    });
}

// ============================================================
//  日程地点倒排索引（地点名 → 小时 → 角色id列表）
// ============================================================

function hourOf(t) {
    const m = /^(\d{1,2}):/.exec(String(t || ''));
    return m ? parseInt(m[1]) : NaN;
}

function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 单个角色：schedule + 今天约定 → hourMap（末条循环覆盖次日首条；今天约定覆盖对应小时）
export function buildCharHourMap(p, today) {
    const hourMap = {};
    const sorted = [...(p.schedule || [])].sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
    sorted.forEach((s, i) => {
        const h = hourOf(s.time);
        if (!s.place || Number.isNaN(h)) return;
        const endH = sorted[i + 1] ? hourOf(sorted[i + 1].time) : hourOf(sorted[0].time);   // ★ 末条循环到次日首条
        if (Number.isNaN(endH)) return;
        if (i < sorted.length - 1) {
            for (let hh = h; hh < endH && hh < 24; hh++) hourMap[hh] = s.place;
        } else {
            for (let hh = h; hh < 24; hh++) hourMap[hh] = s.place;      // [末条时间, 24)
            for (let hh = 0; hh < endH; hh++) hourMap[hh] = s.place;    // [0, 首条时间) 跨天
        }
    });
    (p.appointments || []).filter(a => (a.date || '') === today).forEach(a => {
        const h = hourOf(a.time);
        if (!a.place || Number.isNaN(h)) return;
        hourMap[h] = a.place;
    });
    return hourMap;
}

// ★ 局部更新：只重算一个角色的贡献，摘旧写新（等价于全量重建中该角色的结果）
//   id 可选：getProfile 返回的档案没有 id 字段时显式传入 roleId
export function upsertCharPlaceIndex(index, p, today, id) {
    const cid = id || p.id;
    if (!cid) return;
    for (const place in index) {
        for (const hour in index[place]) {
            const arr = index[place][hour];
            if (arr.includes(cid)) index[place][hour] = arr.filter(x => x !== cid);
        }
    }
    const hourMap = buildCharHourMap(p, today);
    for (const [hh, place] of Object.entries(hourMap)) {
        index[place] = index[place] || {};
        index[place][hh] = index[place][hh] || [];
        if (!index[place][hh].includes(cid)) index[place][hh].push(cid);
    }
}

// 纯内存：从快照构建索引；过期约定就地清理并回调 onChanged（由调用方决定何时写库）
export function buildPlaceIndexFrom(profiles, today, onChanged) {
    const index = {};
    for (const p of profiles) {
        if (p.appointments && p.appointments.length) {
            const before = p.appointments.length;
            p.appointments = p.appointments.filter(a => (a.date || '') >= today);
            if (p.appointments.length !== before && onChanged) onChanged(p);
        }
        const schedule = p.schedule || [];
        if (!schedule.length && !(p.appointments || []).length) continue;
        const hourMap = buildCharHourMap(p, today);
        for (const [hh, place] of Object.entries(hourMap)) {
            index[place] = index[place] || {};
            index[place][hh] = index[place][hh] || [];
            if (!index[place][hh].includes(p.id)) index[place][hh].push(p.id);
        }
    }
    return index;
}

// 全量重建（AI 评估后刷新用）：读库 → 清理过期约定（批量写）→ 构建索引
export async function buildPlaceIndex() {
    const profiles = await getAllProfiles();
    const writes = [];
    const index = buildPlaceIndexFrom(profiles, todayStr(), p => writes.push(p));
    if (writes.length) await saveProfiles(writes.map(p => ({ profile: p, roleId: p.id })));
    return index;
}


// O(1) 查询：某地点某小时在场角色
export function getPresentAt(index, placeName, hour) {
    try { return index[placeName]?.[hour] || []; } catch { return []; }
}

// 删除剧情（回忆册用）
export async function deleteStory(storyId) {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_STORIES, 'readwrite');
        tx.objectStore(STORE_STORIES).delete(storyId);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
    });
}

// ============================================================
//  小城对话（分块存储）
//  持久对话：convId = pairKey，块 key = convId + '#' + 块号
//  临时对话：convId = pairKey + '@' + 地点，块 key = 同规则
//  每块 ≤ CHUNK_SIZE 条，满块自动开新块（写入成本封顶在块大小）
// ============================================================
export function chatPairKey(a, b) { return [a, b].sort().join('_'); }

const CHUNK_SIZE = 200;   // ★ 每块上限，可调

// 读某 conv 全部消息（按块号合并）
function readConv(convId) {
    return new Promise((resolve) => {
        openDB().then((db) => {
            const tx = db.transaction(STORE_CHATS, 'readonly');
            const range = IDBKeyRange.bound(convId + '#', convId + '#\uffff');
            const req = tx.objectStore(STORE_CHATS).getAll(range);
            req.onsuccess = () => resolve(
                (req.result || [])
                    .sort((a, b) => a.chunk - b.chunk)
                    .flatMap(c => c.messages || [])
            );
            req.onerror = () => resolve([]);
        }).catch(() => resolve([]));   // ★ openDB 失败兜底，避免挂起
    });
}

// 追加一条消息到 conv（单事务：反向游标找最后一块 → push/开新块 → put）
function appendMessage(convId, message) {
    return new Promise((resolve) => {
        openDB().then((db) => {
            const tx = db.transaction(STORE_CHATS, 'readwrite');
            const store = tx.objectStore(STORE_CHATS);
            const range = IDBKeyRange.bound(convId + '#', convId + '#\uffff');
            const creq = store.openCursor(range, 'prev');
            creq.onsuccess = () => {
                const cursor = creq.result;
                let chunkKey = cursor ? cursor.key : null;
                let chunk = cursor ? cursor.value : null;
                if (chunk && Array.isArray(chunk.messages) && chunk.messages.length >= CHUNK_SIZE) chunk = null;
                if (!chunk) {
                    const next = chunkKey ? parseInt(String(chunkKey).split('#').pop(), 10) + 1 : 0;
                    chunk = { convId, chunk: next, messages: [] };
                    chunkKey = convId + '#' + next;
                }
                chunk.messages.push(message);
                store.put(chunk, chunkKey);
            };
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        }).catch(() => resolve(false));
    });
}

// 读某 pair 全部消息（持久 + 所有临时地点，混合按时间排序）——保持原 API 语义
export async function getChatMessages(pairKey) {
    const [persist, temps] = await Promise.all([
        readConv(pairKey),
        new Promise((resolve) => {
            openDB().then((db) => {
                const tx = db.transaction(STORE_CHATS, 'readonly');
                const range = IDBKeyRange.bound(pairKey + '@', pairKey + '@\uffff');
                const req = tx.objectStore(STORE_CHATS).getAll(range);
                req.onsuccess = () => resolve(
                    (req.result || [])
                        .sort((a, b) => a.convId === b.convId ? a.chunk - b.chunk : a.convId.localeCompare(b.convId))   // ★ 数字比较，修块号10<2错序
                        .flatMap(c => c.messages || [])
                );
                req.onerror = () => resolve([]);
            }).catch(() => resolve([]));
        }),
    ]);
    return [...persist, ...temps].sort((a, b) => a.time - b.time);
}

// 保存一条消息：按 temp/place 自动定位到持久或临时对话；带 groupId → 存群聊共享窗口
export function saveChatMessage(pairKey, message) {
    const convId = message.groupId
        ? `${message.groupId}${message.temp && message.place ? '@' + message.place : ''}`
        : ((message.temp && message.place) ? `${pairKey}@${message.place}` : pairKey);
    return appendMessage(convId, message);
}

// 读某群聊全部消息（群聊共享窗口，读 gcId@ 前缀所有块）
export function getGroupChatMessages(gcId) {
    return new Promise((resolve) => {
        openDB().then((db) => {
            const tx = db.transaction(STORE_CHATS, 'readonly');
            const range = IDBKeyRange.bound(gcId + '@', gcId + '@\uffff');
            const req = tx.objectStore(STORE_CHATS).getAll(range);
            req.onsuccess = () => resolve(
                (req.result || [])
                    .sort((a, b) => a.convId === b.convId ? a.chunk - b.chunk : a.convId.localeCompare(b.convId))
                    .flatMap(c => c.messages || [])
            );
            req.onerror = () => resolve([]);
        }).catch(() => resolve([]));
    });
}

// ---- 群聊集中注册表（chats store 特殊 key，getAllChats 天然过滤；角色档案零残留）----
const GROUP_REGISTRY_KEY = '__gc_registry__';

export async function getGroupRegistry() {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_CHATS, 'readonly');
        const req = tx.objectStore(STORE_CHATS).get(GROUP_REGISTRY_KEY);
        req.onsuccess = () => resolve(req.result || {});
        req.onerror = () => resolve({});
    });
}

export async function saveGroupRegistry(registry) {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_CHATS, 'readwrite');
        tx.objectStore(STORE_CHATS).put(registry, GROUP_REGISTRY_KEY);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
    });
}

// ---- 小城世界状态（天气 + 当日见闻；chats store 特殊 key，getAllChats 天然过滤，与 __gc_registry__ 同模式）----
const SIMCITY_WORLD_KEY = '__simcity_world__';

export async function getSimCityWorld() {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_CHATS, 'readonly');
        const req = tx.objectStore(STORE_CHATS).get(SIMCITY_WORLD_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
    });
}

export async function saveSimCityWorld(world) {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_CHATS, 'readwrite');
        tx.objectStore(STORE_CHATS).put(world, SIMCITY_WORLD_KEY);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
    });
}

// 某角色参与的所有小城对话（展平消息，按角色过滤）
export async function getRoleChats(roleId) {
    const all = await getAllChats();
    return all.filter(m => m.from === roleId || m.to === roleId).sort((a, b) => a.time - b.time);
}

// 全部聊天消息（展平所有块）——供清理/统计
export async function getAllChats() {
    return new Promise((resolve) => {
        openDB().then((db) => {
            const tx = db.transaction(STORE_CHATS, 'readonly');
            const req = tx.objectStore(STORE_CHATS).getAll();
            req.onsuccess = () => resolve(
                (req.result || [])
                    .filter(r => Array.isArray(r.messages))
                    .sort((a, b) => a.convId === b.convId ? a.chunk - b.chunk : a.convId.localeCompare(b.convId))
                    .flatMap(r => r.messages)
            );
            req.onerror = () => resolve([]);
        }).catch(() => resolve([]));
    });
}

// 删除单条消息（找到所在块移除，空块删除）
export async function deleteChatMessage(id) {
    return new Promise((resolve) => {
        openDB().then((db) => {
            const tx = db.transaction(STORE_CHATS, 'readwrite');
            const store = tx.objectStore(STORE_CHATS);
            const req = store.getAll();
            req.onsuccess = () => {
                for (const rec of (req.result || [])) {
                    if (!Array.isArray(rec.messages)) continue;
                    const idx = rec.messages.findIndex(m => m.id === id);
                    if (idx >= 0) {
                        rec.messages.splice(idx, 1);
                        if (rec.messages.length) store.put(rec, rec.convId + '#' + rec.chunk);
                        else store.delete(rec.convId + '#' + rec.chunk);
                        resolve(true);
                        return;
                    }
                }
                resolve(false);
            };
            tx.onerror = () => resolve(false);
        }).catch(() => resolve(false));
    });
}

// 批量删除消息（单事务一次扫块，替代逐条 deleteChatMessage 的全表扫描循环）
export async function deleteChatMessages(ids) {
    const idSet = new Set(ids || []);
    if (!idSet.size) return true;
    return new Promise((resolve) => {
        openDB().then((db) => {
            const tx = db.transaction(STORE_CHATS, 'readwrite');
            const store = tx.objectStore(STORE_CHATS);
            const req = store.getAll();
            req.onsuccess = () => {
                for (const rec of (req.result || [])) {
                    if (!Array.isArray(rec.messages)) continue;
                    const before = rec.messages.length;
                    rec.messages = rec.messages.filter(m => !idSet.has(m.id));
                    if (rec.messages.length !== before) {
                        if (rec.messages.length) store.put(rec, rec.convId + '#' + rec.chunk);
                        else store.delete(rec.convId + '#' + rec.chunk);
                    }
                }
                resolve(true);
            };
            tx.onerror = () => resolve(false);
        }).catch(() => resolve(false));
    });
}

// 清空某对角色间某个地点的临时对话（整 conv 删除，一次删所有块）
export async function deleteTempChats(pairKey, place) {
    const convId = `${pairKey}@${place}`;
    return new Promise((resolve) => {
        openDB().then((db) => {
            const tx = db.transaction(STORE_CHATS, 'readwrite');
            const store = tx.objectStore(STORE_CHATS);
            const range = IDBKeyRange.bound(convId + '#', convId + '#\uffff');
            const req = store.getAllKeys(range);
            req.onsuccess = () => {
                (req.result || []).forEach(k => store.delete(k));
                resolve(true);
            };
            tx.onerror = () => resolve(false);
        }).catch(() => resolve(false));
    });
}

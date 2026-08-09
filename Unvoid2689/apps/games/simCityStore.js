// apps/games/simCityStore.js — 模拟小城独立 IndexedDB 存储
// DB: simCityDB / store: profiles（key=角色id）+ stories（key=剧情id）

const DB_NAME = 'simCityDB';
const DB_VERSION = 3;                        // ★ 升到 3：新增 chats
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

// // 遍历所有小城居民，把 schedule 展开成"地点×小时"倒排索引
// export async function buildPlaceIndex() {
//     const profiles = await getAllProfiles();
//     const index = {};
//     for (const p of profiles) {
//         const schedule = p.schedule || [];
//         if (!schedule.length) continue;
//         // 按时间排序，条目 i 覆盖 [time_i 的小时, time_{i+1} 的小时) 
//         const sorted = [...schedule].sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
//         sorted.forEach((s, i) => {
//             const h = hourOf(s.time);
//             if (!s.place || Number.isNaN(h)) return;
//             const endH = sorted[i + 1] ? hourOf(sorted[i + 1].time) : 24;
//             if (Number.isNaN(endH)) return;
//             for (let hh = h; hh < endH && hh < 24; hh++) {
//                 index[s.place] = index[s.place] || {};
//                 index[s.place][hh] = index[s.place][hh] || [];
//                 if (!index[s.place][hh].includes(p.id)) index[s.place][hh].push(p.id);
//             }
//         });
//     }
//     return index;
// }

export async function buildPlaceIndex() {
    const profiles = await getAllProfiles();
    const index = {};
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    for (const p of profiles) {
        // ★ 清理过期约定（昨天及更早）
        if (p.appointments && p.appointments.length) {
            const before = p.appointments.length;
            p.appointments = p.appointments.filter(a => (a.date || '') >= today);
            if (p.appointments.length !== before) await saveProfile(p, p.id);
        }
        const schedule = p.schedule || [];
        if (!schedule.length && !(p.appointments || []).length) continue;

        // 该角色 hourMap：base 先填，今天的约定覆盖
        const hourMap = {};
        const sorted = [...schedule].sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
        // sorted.forEach((s, i) => {
        //     const h = hourOf(s.time);
        //     if (!s.place || Number.isNaN(h)) return;
        //     const endH = sorted[i + 1] ? hourOf(sorted[i + 1].time) : 24;
        //     if (Number.isNaN(endH)) return;
        //     for (let hh = h; hh < endH && hh < 24; hh++) hourMap[hh] = s.place;
        // });
        // simCityStore.js buildPlaceIndex，只改 sorted.forEach 这一处（约4行）
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

        // ★ 临时约定覆盖对应小时
        (p.appointments || []).filter(a => (a.date || '') === today).forEach(a => {
            const h = hourOf(a.time);
            if (!a.place || Number.isNaN(h)) return;
            hourMap[h] = a.place;
        });

        for (const [hh, place] of Object.entries(hourMap)) {
            index[place] = index[place] || {};
            index[place][hh] = index[place][hh] || [];
            if (!index[place][hh].includes(p.id)) index[place][hh].push(p.id);
        }
    }
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
//  小城对话（独立 IndexedDB，关联角色 id，不写角色本体）
// ============================================================
export function chatPairKey(a, b) { return [a, b].sort().join('_'); }

export async function getChatMessages(pairKey) {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_CHATS, 'readonly');
        const req = tx.objectStore(STORE_CHATS).getAll();
        req.onsuccess = () => resolve(
            (req.result || []).filter(m => m.pairKey === pairKey).sort((a, b) => a.time - b.time)
        );
        req.onerror = () => resolve([]);
    });
}

export async function saveChatMessage(pairKey, message) {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_CHATS, 'readwrite');
        tx.objectStore(STORE_CHATS).put({ ...message, pairKey }, message.id);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
    });
}

// 某角色参与的所有小城对话（按角色 id 查询）
export async function getRoleChats(roleId) {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_CHATS, 'readonly');
        const req = tx.objectStore(STORE_CHATS).getAll();
        req.onsuccess = () => resolve(
            (req.result || []).filter(m => m.from === roleId || m.to === roleId).sort((a, b) => a.time - b.time)
        );
        req.onerror = () => resolve([]);
    });
}

// 获取全部聊天（供批量清理临时对话）
export async function getAllChats() {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_CHATS, 'readonly');
        const req = tx.objectStore(STORE_CHATS).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
    });
}

// 删除单条聊天
export async function deleteChatMessage(id) {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_CHATS, 'readwrite');
        tx.objectStore(STORE_CHATS).delete(id);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
    });
}

// 清空某对角色间（可选按地点）的临时对话
export async function deleteTempChats(pairKey, place) {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_CHATS, 'readwrite');
        const store = tx.objectStore(STORE_CHATS);
        const req = store.getAll();
        req.onsuccess = () => {
            (req.result || [])
                .filter(m => m.pairKey === pairKey && m.temp && (!place || m.place === place))
                .forEach(m => store.delete(m.id));
            resolve(true);
        };
        req.onerror = () => resolve(false);
    });
}

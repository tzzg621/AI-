// apps/games/gameCenterDB.js — 游戏中心统一 IndexedDB 存储
// 所有游戏中心内游戏共用；key = `${gameId}:${roleId}`（roleId 传 'global' 表示与角色无关）
// 数据单向：游戏写入自己的 key，不反向影响外部角色/联系人系统

const DB_NAME = 'gameCenterDB';
const DB_VERSION = 1;
const STORE_SAVES = 'saves';

let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_SAVES)) {
                const store = db.createObjectStore(STORE_SAVES, { keyPath: 'key' });
                store.createIndex('game', 'game', { unique: false });   // 按游戏枚举（游戏中心列表用）
                store.createIndex('role', 'role', { unique: false });   // 按角色枚举
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}

export function saveKey(gameId, roleId = 'global') {
    return `${gameId}:${roleId}`;
}

// ---- 读 ----
export async function getGameSave(gameId, roleId = 'global') {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_SAVES, 'readonly');
        const req = tx.objectStore(STORE_SAVES).get(saveKey(gameId, roleId));
        req.onsuccess = () => resolve(req.result?.data ?? null);
        req.onerror = () => resolve(null);
    });
}

// ---- 写（整个存档覆盖）----
export async function saveGameSave(gameId, roleId, data) {
    if (!data) return false;
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_SAVES, 'readwrite');
        tx.objectStore(STORE_SAVES).put({
            key: saveKey(gameId, roleId),
            game: gameId,
            role: roleId,
            data,
            updatedAt: Date.now()
        });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
    });
}

// ---- 删 ----
export async function deleteGameSave(gameId, roleId = 'global') {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_SAVES, 'readwrite');
        tx.objectStore(STORE_SAVES).delete(saveKey(gameId, roleId));
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
    });
}

// ---- 按游戏枚举（游戏中心"我的存档"列表等场景）----
export async function listSaves(gameId) {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_SAVES, 'readonly');
        const req = tx.objectStore(STORE_SAVES).index('game').getAll(gameId);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
    });
}

// ---- 按角色枚举（如切换角色后迁移/清理）----
export async function listSavesByRole(roleId) {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_SAVES, 'readonly');
        const req = tx.objectStore(STORE_SAVES).index('role').getAll(roleId);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
    });
}

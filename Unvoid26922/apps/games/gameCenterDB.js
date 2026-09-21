const DB_NAME = 'gameCenterDB';
const DB_VERSION = 1;
const STORE_SAVES = 'saves';
let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = event => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_SAVES)) {
                const store = db.createObjectStore(STORE_SAVES, { keyPath: 'key' });
                store.createIndex('game', 'game');
                store.createIndex('role', 'role');
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

export function saveKey(gameId, roleId = 'global') {
    return `${gameId}:${roleId}`;
}

export async function getGameSave(gameId, roleId = 'global') {
    try {
        const db = await openDB();
        return await new Promise(resolve => {
            const tx = db.transaction(STORE_SAVES, 'readonly');
            const req = tx.objectStore(STORE_SAVES).get(saveKey(gameId, roleId));
            req.onsuccess = () => resolve(req.result?.data ?? null);
            req.onerror = () => resolve(null);
            tx.onabort = () => resolve(null);
        });
    } catch (error) {
        console.error('[gameCenterDB] 读取失败', error);
        return null;
    }
}

export async function hasGameSave(gameId, roleId = 'global') {
    const data = await getGameSave(gameId, roleId);
    return Boolean(data?.registered);
}

export async function saveGameSave(gameId, roleId, data) {
    if (!gameId || !roleId || !data) return false;
    try {
        const db = await openDB();
        return await new Promise(resolve => {
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
            tx.onabort = () => resolve(false);
        });
    } catch (error) {
        console.error('[gameCenterDB] 保存失败', error);
        return false;
    }
}

export async function deleteGameSave(gameId, roleId = 'global') {
    try {
        const db = await openDB();
        return await new Promise(resolve => {
            const tx = db.transaction(STORE_SAVES, 'readwrite');
            tx.objectStore(STORE_SAVES).delete(saveKey(gameId, roleId));
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
            tx.onabort = () => resolve(false);
        });
    } catch {
        return false;
    }
}

export async function listSaves(gameId) {
    try {
        const db = await openDB();
        return await new Promise(resolve => {
            const tx = db.transaction(STORE_SAVES, 'readonly');
            const req = tx.objectStore(STORE_SAVES)
                .index('game')
                .getAll(gameId);

            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
            tx.onabort = () => resolve([]);
        });
    } catch {
        return [];
    }
}

export async function listSavesByRole(roleId) {
    try {
        const db = await openDB();
        return await new Promise(resolve => {
            const tx = db.transaction(STORE_SAVES, 'readonly');
            const req = tx.objectStore(STORE_SAVES)
                .index('role')
                .getAll(roleId);

            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
            tx.onabort = () => resolve([]);
        });
    } catch {
        return [];
    }
}

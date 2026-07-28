const DB_NAME = 'DataSyncDB';
const DB_VERSION = 2;
const STORE_NAME = 'dataStore';

const MANAGED_PREFIXES = ['char_', 'rolebook_', 'worldbook_', 'worldnet_'];

const cache = new Map();
let _db = null;
let _hooked = false;

function isManagedKey(key) {
    return MANAGED_PREFIXES.some(p => typeof key === 'string' && key.startsWith(p));
}

// ---- IndexedDB ---- //

export function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'key' });
            }
        };
        req.onsuccess = () => {
            _db = req.result;
            _db.onclose = () => { _db = null; };
            resolve(_db);
        };
        req.onerror = () => reject(req.error);
    });
}

async function loadAllFromDB() {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    return new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => {
            const entries = req.result || [];
            cache.clear();
            for (const entry of entries) {
                cache.set(entry.key, entry.data);
            }
            resolve(entries.length);
        };
        req.onerror = () => reject(req.error);
    });
}

async function saveToDB(key) {
    const data = cache.get(key);
    if (data === undefined) return;
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({ key, data });
    return tx.done;
}

async function deleteFromDB(key) {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    return tx.done;
}

async function migrateFromLS() {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    let count = 0;
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (isManagedKey(key)) {
            const data = localStorage.getItem(key);
            if (data !== null) {
                store.put({ key, data });
                cache.set(key, data);
                count++;
            }
        }
    }
    await tx.done;
    return count;
}

// ---- Hook ---- //

function hookLocalStorage() {
    if (_hooked) return;
    _hooked = true;

    const origGetItem = Storage.prototype.getItem;
    const origSetItem = Storage.prototype.setItem;
    const origRemoveItem = Storage.prototype.removeItem;

    Storage.prototype.getItem = function (key) {
        if (isManagedKey(key) && cache.has(key)) {
            return cache.get(key);
        }
        return origGetItem.call(this, key);
    };

    Storage.prototype.setItem = function (key, value) {
        if (isManagedKey(key)) {
            const str = String(value);
            cache.set(key, str);
            saveToDB(key).catch(() => {});
            return;
        }
        origSetItem.call(this, key, value);
    };

    Storage.prototype.removeItem = function (key) {
        if (isManagedKey(key)) {
            cache.delete(key);
            deleteFromDB(key).catch(() => {});
            return;
        }
        origRemoveItem.call(this, key);
    };
}

// ---- 导出 ---- //

export async function init() {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const count = await new Promise((resolve, reject) => {
        const req = store.count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });

    if (count === 0) {
        await migrateFromLS();
    } else {
        await loadAllFromDB();
    }

    // 清理 localStorage（此时 hook 未装，操作真实）
    for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (isManagedKey(key)) {
            localStorage.removeItem(key);
        }
    }

    hookLocalStorage();
    console.log('📦 [DataSync] 初始化完成');
}

// store/sketchStore.js — 灵光库：独立 IndexedDB，不走 DataSync、无迁移
const DB_NAME = 'SketchDB';
const STORE_NAME = 'sketches';
const MAX_SKETCHES = 200;

let _db = null;

function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
        req.onsuccess = () => { _db = req.result; _db.onclose = () => { _db = null; }; resolve(_db); };
        req.onerror = () => reject(req.error);
    });
}

export async function getSketches() {
    const db = await openDB();
    const all = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
    return all.sort((a, b) => b.createdAt - a.createdAt);   // 最新在前
}

export async function addSketch({ sourceName = '', content = '' } = {}) {
    if (!content.trim()) return null;
    const sketch = {
        id: 'sk_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
        sourceName, content: content.trim(), createdAt: Date.now()
    };
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(sketch);
    await tx.done;

    // 超上限删最旧
    const all = await getSketches();
    if (all.length > MAX_SKETCHES) {
        const tx2 = db.transaction(STORE_NAME, 'readwrite');
        const store2 = tx2.objectStore(STORE_NAME);
        all.slice(MAX_SKETCHES).forEach(s => store2.delete(s.id));
        await tx2.done;
    }
    return sketch;
}

export async function deleteSketch(id) {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    await tx.done;
}

// ★ 一次性搬迁旧数据（搬完即删 localStorage key，幂等）
export async function migrateLegacy() {
    const raw = localStorage.getItem('sketch_library');
    if (!raw) return 0;
    let list = [];
    try { list = JSON.parse(raw); } catch { return 0; }
    let n = 0;
    for (const s of list) {
        if (s?.id && s?.content) { await addSketch({ sourceName: s.sourceName, content: s.content }); n++; }
    }
    localStorage.removeItem('sketch_library');
    return n;
}

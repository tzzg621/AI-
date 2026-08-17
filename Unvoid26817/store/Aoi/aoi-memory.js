// store/Aoi/aoi-memory.js — Aoi 的私有记忆体
// 使用 IndexedDB 存储，空间更大、性能更好

const DB_NAME = 'AoiMemory';
const DB_VERSION = 1;
const STORE_NAME = 'entries';

export class AoiMemory {
    constructor() {
        this._entries = [];
        this._loaded = false;
        this._db = null;
    }

    // ---- IndexedDB 连接 ----

    _openDB() {
        return new Promise((resolve, reject) => {
            if (this._db) return resolve(this._db);

            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    // 创建一个对象仓库，用自增 id 作为主键
                    const store = db.createObjectStore(STORE_NAME, {
                        keyPath: 'id',
                        autoIncrement: true
                    });
                    // 按时间戳建索引，方便排序查询
                    store.createIndex('timestamp', '_timestamp', { unique: false });
                    store.createIndex('type', '_type', { unique: false });
                }
            };

            request.onsuccess = (event) => {
                this._db = event.target.result;
                resolve(this._db);
            };

            request.onerror = (event) => {
                reject(new Error('IndexedDB 打开失败: ' + event.target.error));
            };
        });
    }

    // ---- 初始化：从 IndexedDB 加载所有记忆到内存 ----

    async load() {
        if (this._loaded) return;

        const db = await this._openDB();
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);

        this._entries = await new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });

        this._loaded = true;
    }

    // ---- 保存到 IndexedDB（全量覆盖，保持内存与 DB 一致）----

    async _save() {
        const db = await this._openDB();
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);

        // 清空旧数据
        store.clear();

        // 批量写入
        for (const entry of this._entries) {
            store.add(entry);
        }

        await new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    }

    // ---- 写入 ----

    async record(type, data) {
        const entry = {
            ...data,
            _type: type,
            _timestamp: Date.now()
        };
        this._entries.push(entry);
        await this._save();  // 每次写入后同步到 IndexedDB
        return entry;
    }

    // ---- 文件存储与查询 ----

    async storeFile(fileName, content) {
        const entry = {
            fileName,
            content,
            _type: 'file',
            _timestamp: Date.now()
        };
        this._entries.push(entry);
        await this._save();
        return entry;
    }

    getFile(fileName) {
        return this._entries
            .filter(e => e._type === 'file' && e.fileName === fileName)
            .sort((a, b) => (b._timestamp || 0) - (a._timestamp || 0))[0];
    }

    listFiles() {
        return this._entries
            .filter(e => e._type === 'file')
            .map(e => ({ fileName: e.fileName, timestamp: e._timestamp }));
    }


    // ---- 读取 ----

    getRecent(count = 10) {
        return this._entries
            .slice()
            .sort((a, b) => (b._timestamp || 0) - (a._timestamp || 0))
            .slice(0, count);
    }

    getByType(type) {
        return this._entries
            .filter(e => e._type === type)
            .sort((a, b) => (b._timestamp || 0) - (a._timestamp || 0));
    }

    isEmpty() {
        return this._entries.length === 0;
    }

    // ---- 记忆整理 ----

    async compress() {
        const types = ['chat', 'observation', 'emotion', 'inspiration'];
        for (const type of types) {
            const entries = this._entries.filter(e => e._type === type);
            if (entries.length > 50) {
                entries.sort((a, b) => (a._timestamp || 0) - (b._timestamp || 0));

                const toCompress = entries.slice(0, entries.length - 30);
                const summary = toCompress
                    .map(e => e.content || '')
                    .filter(Boolean)
                    .join('；');

                this._entries.push({
                    content: summary,
                    count: toCompress.length,
                    _type: type + '_compressed',
                    _timestamp: Date.now(),
                    originalRange: {
                        from: toCompress[0]._timestamp,
                        to: toCompress[toCompress.length - 1]._timestamp
                    }
                });

                const deleteSet = new Set(toCompress);
                this._entries = this._entries.filter(e => !deleteSet.has(e));
            }
        }
        await this._save();
    }

    // ---- 清空 ----

    async clear() {
        this._entries = [];
        const db = await this._openDB();
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).clear();
        await new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
        this._loaded = false;
    }
}

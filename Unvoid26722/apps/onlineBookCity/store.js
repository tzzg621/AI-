// apps/onlineBookCity/store.js — 书城 IndexedDB 数据层

const DB_NAME = 'OnlineBookCity';
const DB_VERSION = 3;                   // ★ 版本号 +1
const STORE_NAME = 'books';
const DISCOVER_STORE = 'discover';      // 发现页引用仓库

let _db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (_db) return resolve(_db);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;

      // 原有的 books 仓库
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
        store.createIndex('title', 'title', { unique: false });
        store.createIndex('status', 'status', { unique: false }); // ★ 新增
      } else {
        // ★ 版本升级：检查并添加 status 索引
        const store = req.transaction.objectStore(STORE_NAME);
        if (!store.indexNames.contains('status')) {
          store.createIndex('status', 'status', { unique: false });
        }
      }

      // 原有的 discover 仓库（只存引用）
      if (!db.objectStoreNames.contains(DISCOVER_STORE)) {
        db.createObjectStore(DISCOVER_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * 按状态查询小说（不包含章节内容，只含元数据）
 * @param {string} status - 'discover' | 'collected' | 'pinned' | 'creator'
 */
export async function getBooksByStatus(status) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('status');
    const req = index.getAll(status);
    req.onsuccess = () => {
      const books = req.result.map(b => ({
        ...b,
        chapters: (b.chapters || []).map(ch => ({
          ...ch,
          content: undefined
        }))
      }));
      resolve(books);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * 获取所有小说（不包含章节内容）
 */
export async function getAllBooks() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => {
      const books = req.result.map(b => ({
        ...b,
        chapters: (b.chapters || []).map(ch => ({
          ...ch,
          content: undefined
        }))
      }));
      resolve(books);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * 获取单本小说（含所有章节内容）
 */
export async function getBook(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * 保存/更新小说
 */
export async function putBook(book) {
  const db = await openDB();
  const data = {
    ...book,
    updatedAt: new Date().toISOString(),
    chapters: book.chapters || []
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(data);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * 删除小说
 */
export async function deleteBook(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * 清理发现页数据（删除所有 status='discover' 的书）
 * @returns {Promise<number>} 删除的数量
 */
export async function cleanupDiscoverBooks() {
  const db = await openDB();
  const books = await getBooksByStatus('discover');
  const ids = books.map(b => b.id);

  if (ids.length === 0) return 0;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    let deleted = 0;
    ids.forEach(id => {
      store.delete(id);
      deleted++;
    });
    tx.oncomplete = () => resolve(deleted);
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================================
//  发现页引用数据读写（只存 ID，不存完整书数据）
// ============================================================

export async function getDiscoverData(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DISCOVER_STORE, 'readonly');
    const store = tx.objectStore(DISCOVER_STORE);
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result ? req.result.data : null);
    req.onerror = () => reject(req.error);
  });
}

export async function putDiscoverData(id, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DISCOVER_STORE, 'readwrite');
    const store = tx.objectStore(DISCOVER_STORE);
    const req = store.put({ id, data });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function deleteDiscoverData(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DISCOVER_STORE, 'readwrite');
    const store = tx.objectStore(DISCOVER_STORE);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export function genId(prefix = 'obc') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).substr(2, 4)}`;
}

/**
 * 获取发现页废弃数据的数量和估算大小
 * @returns {Promise<{count: number, sizeBytes: number}>}
 */
export async function getDiscoverWasteStats() {
  const books = await getBooksByStatus('discover');
  let size = 0;
  for (const b of books) {
    // 估算：章节内容 + 元数据
    const chSize = (b.chapters || []).reduce((sum, ch) => sum + (ch.content?.length || 0), 0);
    size += JSON.stringify(b).length + chSize;
  }
  return { count: books.length, sizeBytes: size };
}

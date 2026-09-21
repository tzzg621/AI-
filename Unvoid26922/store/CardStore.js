// store/CardStore.js — 角色卡数据层
// ★ card_ 前缀 + 独立 IndexedDB（同 ImageCache 模式），不走 DataSync 托管
// ★ 备份时需单独收集（待办）

export const CARDS_CHANGED_EVENT = 'cards-changed';

const DB_NAME = 'cardStore';
const DB_VERSION = 1;
const STORE_NAME = 'cards';
const IDS_KEY = 'card_index';   // localStorage 索引：card id 数组

// ---- IndexedDB 封装（打开失败自动回退 localStorage） ----
let dbPromise = null;
function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = () => { console.warn('⚠️ cardStore 打开失败，回退 localStorage'); resolve(null); };
    });
    return dbPromise;
}

function dbPut(key, value) {
    return openDB().then(db => {
        if (!db) { localStorage.setItem('card_' + key, JSON.stringify(value)); return; }
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    });
}

function dbGet(key) {
    return openDB().then(db => {
        if (!db) {
            try { return JSON.parse(localStorage.getItem('card_' + key)); } catch { return null; }
        }
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    });
}

function dbDelete(key) {
    return openDB().then(db => {
        if (!db) { localStorage.removeItem('card_' + key); return; }
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    });
}

function dbGetAll() {
    return openDB().then(db => {
        if (!db) {
            const ids = getIds();
            return ids.map(id => { try { return JSON.parse(localStorage.getItem('card_' + id)); } catch { return null; } }).filter(Boolean);
        }
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
        });
    });
}

// ---- 索引 ----
function getIds() {
    try { return JSON.parse(localStorage.getItem(IDS_KEY) || '[]'); } catch { return []; }
}
function saveIds(ids) {
    localStorage.setItem(IDS_KEY, JSON.stringify(ids));
}

// ---- 卡片结构模板 ----
export function createCardData(partial = {}) {
    return {
        id: partial.id || 'card_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
        name: partial.name || '未命名角色卡',
        gender: partial.gender || '未知',
        age: partial.age || '未知',
        orientation: partial.orientation || '未知',
        tag: partial.tag || '',
        emoji: partial.emoji || '🎴',
        desc: partial.desc || '',
        detail: partial.detail || '',
        secret: partial.secret || '',
        style: partial.style || '',
        memories: partial.memories || [],      // [{time, content}]
        relations: partial.relations || [],   // [{name, relation, perspective}]
        profile: partial.profile || {},
        firstMessage: partial.firstMessage || '',
        cardImage: partial.cardImage || '',   // 卡面图 gallery key（后续接图片）
        createdAt: partial.createdAt || Date.now(),
        updatedAt: Date.now()
    };
}

// ---- CRUD ----
export async function getAllCards() {
    const cards = await dbGetAll();
    cards.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return cards;
}

export async function createCard(partial) {
    const card = createCardData(partial);
    await dbPut(card.id, card);
    const ids = getIds();
    if (!ids.includes(card.id)) { ids.push(card.id); saveIds(ids); }
    emitChanged('create', [card.id]);
    return card;
}

export async function updateCard(id, patch) {
    const card = await dbGet(id);
    if (!card) return null;
    const updated = { ...card, ...patch, id, updatedAt: Date.now() };
    await dbPut(id, updated);
    emitChanged('update', [id]);
    return updated;
}

export async function deleteCard(id) {
    await dbDelete(id);
    saveIds(getIds().filter(x => x !== id));
    emitChanged('delete', [id]);
}

/** 批量导入（生成器用）：单次写入 + 只广播一次事件，避免事件风暴 */
export async function importCards(list) {
    const created = [];
    const ids = getIds();
    for (const item of list || []) {
        const card = createCardData(item);
        await dbPut(card.id, card);
        if (!ids.includes(card.id)) ids.push(card.id);
        created.push(card);
    }
    if (created.length) {
        saveIds(ids);
        emitChanged('create', created.map(c => c.id));   // ★ 只广播一次
    }
    return created;
}

// ---- 事件广播 ----
function emitChanged(action, ids) {
    window.dispatchEvent(new CustomEvent(CARDS_CHANGED_EVENT, { detail: { action, ids } }));
}

// apps/roleData.js — 角色数据管理
// 负责角色的存储、读取、预设管理，与 UI 无关

import { CharacterStore } from '../store/CharacterStore.js';

const STORAGE_KEY = 'rolebook_characters';
export const ACTIVE_KEY = 'rolebook_activeIndex';



// ============================================================
//  角色数据存取
// ============================================================

export function loadCharacters() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        try { return JSON.parse(saved); } catch { /* 忽略 */ }
    }
    return [];   // ★ 无数据 = 空名册
}

/**
 * 保存角色列表到 localStorage
 * @param {Array} data - 角色数据数组
 */
export function saveCharacters(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

/**
 * 读取当前主视角索引
 * @returns {number} 索引，-1 表示未选择
 */
export function loadActiveIndex() {
    const saved = localStorage.getItem(ACTIVE_KEY);
    if (saved !== null) return parseInt(saved);
    return -1;
}

/**
 * 保存主视角索引
 * @param {number} index
 */
export function saveActiveIndex(index) {
    localStorage.setItem(ACTIVE_KEY, index);
}

/**
 * 获取当前主视角角色
 * @param {Array} characters - 角色列表
 * @param {number} activeIndex - 当前索引
 * @returns {object|null}
 */
export function getActiveCharacter(characters, activeIndex) {
    if (activeIndex < 0 || activeIndex >= characters.length) return null;
    return characters[activeIndex];
}


// ============================================================
//  工具函数
// ============================================================

/**
 * 通过 ID 查找角色
 * @param {Array} characters - 角色列表
 * @param {string} id - 角色 ID
 * @returns {object|null}
 */
export function findCharacterById(characters, id) {
    return characters.find(c => c.id === id) || null;
}

/**
 * 通过名称查找角色
 * @param {Array} characters - 角色列表
 * @param {string} name - 角色名称
 * @returns {object|null}
 */
export function findCharacterByName(characters, name) {
    return characters.find(c => c.base.name === name) || null;
}

/**
 * 从角色名册数据中提取联系人列表格式
 * @param {Array} characters - 角色列表
 * @param {Array} [excludeIds=[]] - 排除的 ID 列表
 * @returns {Array} 联系人格式数组
 */
export function getCharacterContacts(characters, excludeIds = []) {
    return characters
        .filter(c => !excludeIds.includes(c.id))
        .map(c => ({
            id: c.id,
            name: c.base.name,
            avatar: c.id,
            note: c.base.desc,
            isCharacter: true
        }));
}


// ============================================================
//  角色分类（独立映射，不改变角色数据，不重复存储）
// ============================================================

const CATEGORIES_KEY = 'role_categories';

export function loadCategories() {
    try { return JSON.parse(localStorage.getItem(CATEGORIES_KEY) || '{}'); }
    catch { return {}; }
}

function saveCategories(cats) {
    localStorage.setItem(CATEGORIES_KEY, JSON.stringify(cats));
}

/** 获取角色所属分类名（未分类返回 null） */
export function getCategoryOf(charId, cats) {
    for (const [name, ids] of Object.entries(cats)) {
        if (ids.includes(charId)) return name;
    }
    return null;
}

/** 归入分类（单选：先把它从所有其他分类移除） */
export function assignCategory(charId, catName, cats) {
    for (const name of Object.keys(cats)) {
        cats[name] = (cats[name] || []).filter(id => id !== charId);
    }
    if (catName) {
        if (!cats[catName]) cats[catName] = [];
        if (!cats[catName].includes(charId)) cats[catName].push(charId);
    }
    saveCategories(cats);
    return cats;
}

export function createCategory(name, cats) {
    if (!cats[name]) cats[name] = [];
    saveCategories(cats);
    return cats;
}

export function deleteCategory(name, cats) {
    delete cats[name];
    saveCategories(cats);
    return cats;
}

export function renameCategory(oldName, newName, cats) {
    if (cats[oldName] && newName && !cats[newName]) {
        cats[newName] = cats[oldName];
        delete cats[oldName];
        saveCategories(cats);
    }
    return cats;
}

/** 角色删除时清理它在所有分类里的引用 */
export function removeCharFromAll(charId, cats) {
    for (const name of Object.keys(cats)) {
        cats[name] = cats[name].filter(id => id !== charId);
    }
    saveCategories(cats);
    return cats;
}

/** 批量设置某分类的成员（一次写入，避免频繁单个操作） */
export function setCategoryMembers(catName, charIds, cats) {
    cats[catName] = [...charIds];
    // 单选语义：勾选的角色从其他分类移除
    for (const name of Object.keys(cats)) {
        if (name === catName) continue;
        cats[name] = (cats[name] || []).filter(id => !charIds.includes(id));
    }
    saveCategories(cats);
    return cats;
}

// 追加到 roleData.js 末尾

// ============================================================
//  角色状态：归档（软删除）/ 彻底删除
// ============================================================
const ARCHIVED_KEY = 'rolebook_archived';

export function loadArchived() {
    try { return JSON.parse(localStorage.getItem(ARCHIVED_KEY) || '[]'); }
    catch { return []; }
}
function saveArchived(list) {
    localStorage.setItem(ARCHIVED_KEY, JSON.stringify(list));
}

export function isArchived(characterId) {
    if (!characterId) return false;
    // 名册条目标记
    try {
        const book = JSON.parse(localStorage.getItem('rolebook_characters') || '[]');
        if (book.find(c => c.id === characterId)?.archived) return true;
    } catch {}
    // 网络条目标记
    try {
        const net = JSON.parse(localStorage.getItem('worldnet_extra_characters') || '[]');
        if (net.find(c => c.id === characterId)?.archived) return true;
    } catch {}
    // ③ 本体标记（唯一事实来源兜底）
    try {
        const data = JSON.parse(localStorage.getItem('char_' + characterId) || '{}');
        if (data.archived) return true;
    } catch {}
    return false;
}

export async function archiveCharacter(characterId) {
    if (!characterId || isArchived(characterId)) return false;

    // ① 名册条目打标记（保留在数组里，数据只有一份）
    const book = loadCharacters();
    const idx = book.findIndex(c => c.id === characterId);
    if (idx !== -1) { book[idx].archived = true; saveCharacters(book); }

    // ② 网络条目打标记
    try {
        const net = JSON.parse(localStorage.getItem('worldnet_extra_characters') || '[]');
        const nIdx = net.findIndex(c => c.id === characterId);
        if (nIdx !== -1) { net[nIdx].archived = true; localStorage.setItem('worldnet_extra_characters', JSON.stringify(net)); }
    } catch {}

    // ③ 本体打标记
    try {
        const data = JSON.parse(localStorage.getItem('char_' + characterId) || '{}');
        data.archived = true;
        localStorage.setItem('char_' + characterId, JSON.stringify(data));
    } catch {}
    return true;
}

// ★ 恢复归档
export function unarchiveCharacter(characterId) {
    // ① 名册条目清标记
    const book = loadCharacters();
    const idx = book.findIndex(c => c.id === characterId);
    if (idx !== -1) { delete book[idx].archived; saveCharacters(book); }

    // ② 网络条目清标记
    try {
        const net = JSON.parse(localStorage.getItem('worldnet_extra_characters') || '[]');
        const nIdx = net.findIndex(c => c.id === characterId);
        if (nIdx !== -1) { delete net[nIdx].archived; localStorage.setItem('worldnet_extra_characters', JSON.stringify(net)); }
    } catch {}

    // ③ 本体清标记
    try {
        const data = JSON.parse(localStorage.getItem('char_' + characterId) || '{}');
        delete data.archived;
        localStorage.setItem('char_' + characterId, JSON.stringify(data));
    } catch {}
    return true;
}

// ★ 彻底删除
export async function deleteCharacterDeep(characterId) {
    saveArchived(loadArchived().filter(c => c.id !== characterId));

    try {
        const book = loadCharacters();
        saveCharacters(book.filter(c => c.id !== characterId));
    } catch {}
    try {
        const net = JSON.parse(localStorage.getItem('worldnet_extra_characters') || '[]');
        localStorage.setItem('worldnet_extra_characters', JSON.stringify(net.filter(c => c.id !== characterId)));
    } catch {}

    try { localStorage.removeItem('char_' + characterId); } catch {}

    try {
        const chatMap = JSON.parse(localStorage.getItem('chat_messages') || '{}');
        let changed = false;
        Object.keys(chatMap).forEach(pairKey => {
            if (pairKey.includes(characterId)) { delete chatMap[pairKey]; changed = true; }
        });
        if (changed) localStorage.setItem('chat_messages', JSON.stringify(chatMap));
    } catch {}

    try {
        const { keys } = await import('../store/DataSync.js');
        keys().filter(k => k.startsWith('char_')).forEach(k => {
            if (k === 'char_' + characterId) return;
            try {
                const data = JSON.parse(localStorage.getItem(k));
                let changed = false;
                if (data.friends && characterId in data.friends) { delete data.friends[characterId]; changed = true; }
                if (Array.isArray(data.memories)) {
                    const before = data.memories.length;
                    data.memories = data.memories.filter(m => !(m.participants && m.participants.includes(characterId)));
                    if (data.memories.length !== before) changed = true;
                }
                if (changed) localStorage.setItem(k, JSON.stringify(data));
            } catch {}
        });
    } catch {}
}

// apps/characterManager.js — 角色管理

import { CharacterStore } from '../store/CharacterStore.js';

// ★ 获取角色 ID（统一写法）
export function getCharacterId(character) {
    if (!character) return 'unknown';
    return character.id || character.base?.name || 'unknown';
}

// ★ 通过角色 ID 查找显示名
export function getCharacterNameById(id) {
    // ① 从角色名册（rolebook_characters）查找
    try {
        const saved = localStorage.getItem('rolebook_characters');
        if (saved) {
            const characters = JSON.parse(saved);
            const found = characters.find(c => c.id === id);
            if (found) return found.base.name;
        }
    } catch { /* 忽略 */ }

    // ② 从 NPC 的 CharacterStore 查找
    try {
        const store = new CharacterStore(id);
        const info = store.getInfo();
        if (info.name) return info.name;
    } catch { /* 忽略 */ }

    // ③ 都没找到，返回 ID 本身
    return id;
}


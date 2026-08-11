// apps/characterManager.js — 角色管理
import { CharacterStore } from '../store/CharacterStore.js';

// ★ 获取角色 ID（统一写法）
export function getCharacterId(character) {
    if (!character) return 'unknown';
    return character.id || character.base?.name || 'unknown';
}

// ★ 通过角色 ID 查找显示名（名册 → 网络 → 归档表 → char_ info → id）
export function getCharacterNameById(id) {
    // ① 从角色名册（rolebook_characters）查找
    try {
        const saved = localStorage.getItem('rolebook_characters');
        if (saved) {
            const found = JSON.parse(saved).find(c => c.id === id);
            if (found?.base?.name) return found.base.name;
        }
    } catch { }

    // ② 从网络（worldnet_extra_characters）查找
    try {
        const saved = localStorage.getItem('worldnet_extra_characters');
        if (saved) {
            const found = JSON.parse(saved).find(c => c.id === id);
            if (found?.base?.name) return found.base.name;
        }
    } catch { }

    // ③ 从归档表（rolebook_archived）查找——软删除角色的名字快照
    try {
        const saved = localStorage.getItem('rolebook_archived');
        if (saved) {
            const found = JSON.parse(saved).find(c => c.id === id);
            if (found?.base?.name) return found.base.name;
        }
    } catch { }

    // ④ 从 NPC 的 CharacterStore 查找
    try {
        const store = new CharacterStore(id);
        const info = store.getInfo();
        if (info.name) return info.name;
    } catch { }

    // ⑤ 都没找到，返回 ID 本身
    return id;
}

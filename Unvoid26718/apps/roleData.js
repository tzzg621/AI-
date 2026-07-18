// apps/roleData.js — 角色数据管理
// 负责角色的存储、读取、预设管理，与 UI 无关

import { createDefaultCharacterData, generateId, CharacterStore } from '../store/CharacterStore.js';
import { createCharacterByName } from './characterCreator.js';

const STORAGE_KEY = 'rolebook_characters';
export const ACTIVE_KEY = 'rolebook_activeIndex';

// ============================================================
//  预设角色数据
// ============================================================

export const PRESET_CHARACTERS = [
    createDefaultCharacterData(generateId(), {
        name: '主角',
        emoji: '👑',
        desc: '世界的核心人物，命运之线的编织者。',
        stats: { 力量: 70, 智力: 85, 魅力: 90 },
        secret: '内心深处惧怕自己配不上"主角"的身份，害怕某天被所有人看穿。',
        style: '语气坚定，偶尔流露出孤独感，习惯用"我们"而不是"我"。',
        memories: [
            { time: '2026-07-01', content: '在古塔顶端第一次看见世界的全貌，意识到自己肩负的责任。' },
            { time: '2026-06-28', content: '与法师在月光下交谈，得知关于远古诅咒的秘密。' }
        ]
    }, 'character', { switchable: true }),

    createDefaultCharacterData(generateId(), {
        name: '法师',
        emoji: '🧙',
        desc: '精通元素魔法，掌握古老咒语。',
        stats: { 力量: 40, 智力: 95, 魅力: 65 },
        secret: '曾因实验失控导致一座城镇毁灭，至今未向任何人提起。',
        style: '说话带书卷气，喜欢用比喻，偶尔会自言自语念咒语。',
        memories: [
            { time: '2026-06-25', content: '在禁书区发现了一本记载着时空魔法的古籍。' },
            { time: '2026-06-20', content: '用魔法为主角占卜，看到了一片模糊的血色未来。' }
        ]
    }, 'character', { switchable: true }),

    createDefaultCharacterData(generateId(), {
        name: '弓手',
        emoji: '🏹',
        desc: '百步穿杨的神射手，林间漫步的精灵。',
        stats: { 力量: 75, 智力: 60, 魅力: 80 },
        secret: '并非纯血精灵，体内流淌着一半暗夜族的血液，一直在隐藏这个身份。',
        style: '话语简洁直接，不爱长篇大论，但关键时刻总能一语中的。',
        memories: [
            { time: '2026-06-30', content: '在暮色森林中独自追踪一只发狂的魔兽，发现它被某种黑暗力量控制。' },
            { time: '2026-06-22', content: '教主角射箭时，不经意间露出的暗夜族身法令自己后怕。' }
        ]
    }, 'character', { switchable: true })
];


// ============================================================
//  角色数据存取
// ============================================================

/**
 * 从 localStorage 读取角色列表（无数据时返回预设）
 * @returns {Array} 角色数据数组
 */
export function loadCharacters() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        try { return JSON.parse(saved); } catch (e) { /* 忽略 */ }
    }

    // 首次使用：存入预设数据并初始化 CharacterStore
    const defaults = [...PRESET_CHARACTERS];
    defaults.forEach(char => {
        if (char.id) {
            const store = new CharacterStore(char.id);
            const info = store.getInfo();
            if (!info.name) {
                store.setInfo({
                    name: char.base.name,
                    emoji: char.base.emoji,
                    desc: char.base.desc || '',
                    type: char.type,
                    label: ''
                });
            }
        }
    });

    localStorage.setItem(STORAGE_KEY, JSON.stringify(defaults));
    return defaults;
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

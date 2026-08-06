// store/profileAccess.js — 角色公开信息分层访问控制
// ★ 两个权威、各管一摊：
//   - base（角色特性）→ 按分类从 rolebook/worldnet 读（名册/网络特性不同）
//   - profile（公开信息）→ 从 char_<id> 读（每个角色统一，不分来源）
//   - 可见层级 → 由查看者(viewer) 的 char_ 数据计算
// ★ profile 结构（纯文本版）：
//   L1: '熟人层文本'（字符串）
//   L2: '密友层文本'（字符串）
//   L3: { viewerId: '专属文本' }
//   manual: { viewerId: 0|1|2 }

import { CharacterStore } from './CharacterStore.js';

// ---- 读取角色特性 base（按分类：名册优先，其次网络）----
function getRoleBase(id) {
    if (!id) return {};
    try {
        const list = JSON.parse(localStorage.getItem('rolebook_characters') || '[]');
        const found = list.find(c => c.id === id);
        if (found?.base) return found.base;
    } catch { }
    try {
        const list = JSON.parse(localStorage.getItem('worldnet_extra_characters') || '[]');
        const found = list.find(c => c.id === id);
        if (found?.base) return found.base;
    } catch { }
    return {};
}

// ---- 默认分层模板 ----
export function createDefaultProfile(partial = {}) {
    return {
        L1: partial.L1 || '',        // 纯文本
        L2: partial.L2 || '',        // 纯文本
        L3: partial.L3 || {},        // { viewerId: '文本' }
        manual: partial.manual || {} // { viewerId: 0|1|2 }
    };
}

function clampLevel(n) { return Math.max(0, Math.min(2, Math.round(n))); }

const DEEP_RELATIONS = ['挚友', '恋人', '生死之交', '家人', '灵魂伴侣', '至交', '爱人'];
const FRIEND_RELATIONS = ['好友', '同伴', '同事', '盟友', '旧友', '师徒', '朋友', '搭档'];

// ---- 计算可见层级（核心打分）----
export function getVisibleLevel(viewerId, targetId, opts = {}) {
    if (!viewerId || !targetId) return 0;
    if (opts.forceLevel !== undefined) return clampLevel(opts.forceLevel);
    if (viewerId === targetId) return 2;

    const targetStore = new CharacterStore(targetId);
    const profile = targetStore.getProfile();

    // ① 手动指定（最高优先）
    if (profile?.manual?.[viewerId] !== undefined) return clampLevel(profile.manual[viewerId]);

    let level = 0;
    const viewerStore = new CharacterStore(viewerId);

    // ② 好友 → 至少 L1
    if (viewerStore.isFriend(targetId)) level = Math.max(level, 1);

    // ③ 关系标签
    const rel = viewerStore.getRelationById(targetId);
    if (rel) {
        if (DEEP_RELATIONS.includes(rel.relation)) level = Math.max(level, 2);
        else if (FRIEND_RELATIONS.includes(rel.relation)) level = Math.max(level, 1);
    }

    // ④ 互动深度
    const total = viewerStore.getAllPairKeys()
        .filter(k => k.includes(targetId))
        .reduce((sum, k) => sum + viewerStore.getMessages(k).length, 0);
    if (total >= 100) level = Math.max(level, 2);
    else if (total >= 30) level = Math.max(level, 1);

    // ⑤ 态度修正
    if (rel?.attitudes?.length) {
        if (rel.attitudes.some(a => ['信任', '依赖', '崇拜', '亲近'].includes(a))) level = Math.min(level + 1, 2);
        if (rel.attitudes.some(a => ['怀疑', '戒备', '敌视', '恐惧', '厌恶'].includes(a))) level = Math.max(level - 1, 0);
    }

    return clampLevel(level);
}

// ---- 按权限组装公开信息 ----
export function getVisibleProfile(targetId, viewerId, opts = {}) {
    const base = getRoleBase(targetId);
    const profile = { ...createDefaultProfile(), ...new CharacterStore(targetId).getProfile() };
    const level = getVisibleLevel(viewerId, targetId, opts);

    const visible = {
        level,
        name: base.name || '未知角色',
        gender: base.gender || '未知',   // ← L0 必带性别
        age: base.age || '未知',
        desc: base.desc || '',
        emoji: base.emoji || '❓',
        extra: {}
    };

    if (level >= 1 && profile.L1) visible.extra['熟人层'] = profile.L1;
    if (level >= 2 && profile.L2) visible.extra['密友层'] = profile.L2;
    if (profile.L3?.[viewerId]) visible.extra['专属信息'] = profile.L3[viewerId];

    return visible;
}

// ---- 格式化为 prompt 文本 ----
export function formatProfilePrompt(targetId, viewerId, targetName, opts = {}) {
    const info = getVisibleProfile(targetId, viewerId, opts);
    const lines = [
        `【你对 ${targetName || info.name} 的了解（可见层级 L${info.level}）】`,
        `性别：${info.gender}`,
        `年龄：${info.age}`,
        `一句话人设：${info.desc}`
    ];
    for (const [label, text] of Object.entries(info.extra)) {
        if (text) lines.push(`${label}：${text}`);
    }
    if (info.level === 0) lines.push('（你们还不熟，以上仅为公开可见信息，请勿臆断更多）');
    return lines.join('\n');
}

// ============================================================
//  文本 ⇄ 结构（编辑 UI 用）
//  编辑框格式：
//    【L1】\n 熟人层文本
//    【L2】\n 密友层文本
//    【L3】\n 角色ID：专属文本
//    【manual】\n 角色ID：0/1/2
// ============================================================

// "角色ID：内容" 行 → { id: 内容 }
// "角色ID：内容" 行 → { id: 内容 }
export function parseIdText(text = '') {
    const map = {};
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const idx = line.search(/[：:]/);
        if (idx > 0) {
            const id = line.slice(0, idx).trim();
            const v = line.slice(idx + 1).trim();
            if (id && v) map[id] = v;
        }
    }
    return map;
}

// { id: 内容 } → 行文本
export function formatIdText(map = {}) {
    return Object.entries(map).map(([id, v]) => `${id}：${v}`).join('\n');
}

// "角色ID：0/1/2" 行 → { id: 层级 }
export function parseIdLevel(text = '') {
    const map = {};
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const idx = line.search(/[：:]/);
        if (idx > 0) {
            const lv = parseInt(line.slice(idx + 1).trim());
            if (!isNaN(lv)) map[line.slice(0, idx).trim()] = clampLevel(lv);
        }
    }
    return map;
}

// { id: 层级 } → 行文本
export function formatManualText(map = {}) {
    return Object.entries(map).map(([id, lv]) => `${id}：${lv}`).join('\n');
}

export function parseProfileText(text = '') {
    const chunks = { L1: [], L2: [], L3: [], manual: [] };
    let section = null;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('【L1】')) { section = 'L1'; continue; }
        if (line.startsWith('【L2】')) { section = 'L2'; continue; }
        if (line.startsWith('【L3】')) { section = 'L3'; continue; }
        if (line.startsWith('【manual】') || line.startsWith('【手动】')) { section = 'manual'; continue; }
        chunks[section || 'L1'].push(line);
    }
    return {
        L1: chunks.L1.join('\n'),
        L2: chunks.L2.join('\n'),
        L3: parseIdText(chunks.L3.join('\n')),
        manual: parseIdLevel(chunks.manual.join('\n'))
    };
}

export function formatProfileText(profile = {}) {
    const p = { ...createDefaultProfile(), ...profile };
    const lines = [];
    lines.push('【L1】');
    if (p.L1) lines.push(p.L1);
    lines.push('【L2】');
    if (p.L2) lines.push(p.L2);
    lines.push('【L3】（每行：角色ID：内容）');
    for (const [vid, v] of Object.entries(p.L3 || {})) lines.push(`${vid}：${v}`);
    lines.push('【manual】（每行：角色ID：0/1/2）');
    for (const [vid, lv] of Object.entries(p.manual || {})) lines.push(`${vid}：${lv}`);
    return lines.join('\n');
}

// apps/chat/momentsAI.js — 朋友圈 AI 生成（通用：任何角色都能以自己身份发朋友圈）
// ★ 一次调用产出【朋友圈】+【小剧场】；自动修正开启时两阶段：草稿→检测提及角色→注入认知→重生成
// ★ 小剧场自动存入"灵光"库（sketch_library）

import { CharacterStore } from '../../store/CharacterStore.js';
import { callAIWithMessages } from '../aiService.js';
import { getVisibleProfile } from '../../store/profileAccess.js';
import { getCharacterNameById } from '../characterManager.js';


// ============================================================
//  小剧场库（灵光）—— 独立 IndexedDB，不绑角色 id，只存来源名字
// ============================================================
import { getSketches, addSketch, deleteSketch, migrateLegacy } from '../../store/sketchStore.js';
export { getSketches, addSketch, deleteSketch, migrateLegacy };

// ============================================================
//  工具
// ============================================================

// 读取角色设定 base（名册优先，其次网络）
function getRoleBase(id) {
    if (!id) return {};
    try {
        const list = JSON.parse(localStorage.getItem('rolebook_characters') || '[]');
        const f = list.find(c => c.id === id);
        if (f?.base) return f.base;
    } catch { }
    try {
        const list = JSON.parse(localStorage.getItem('worldnet_extra_characters') || '[]');
        const f = list.find(c => c.id === id);
        if (f?.base) return f.base;
    } catch { }
    return {};
}

// 角色本人信息注入（不含 profile——那是给别人看的）
function buildRoleContext(base, info, memories) {
    return [
        '【角色信息】',
        `名称：${base.name || info.name || '未知角色'}`,
        base.gender ? `性别：${base.gender}` : '',
        base.age ? `年龄：${base.age}` : '',
        base.desc ? `人设：${base.desc}` : '',
        base.style ? `说话风格：${base.style}` : '',
        base.secret ? `内心秘密：${base.secret}` : '',
        base.detail ? `详细设定：${base.detail}` : '',
        memories.length ? `近期经历（记忆）：\n${memories.slice(-8).map(m => `- ${m.time || ''}：${m.content}`).join('\n')}` : ''
    ].filter(Boolean).join('\n');
}

// 收集所有角色名 → id（名册 + 网络）
function getAllRoleNames() {
    const map = {};
    try {
        JSON.parse(localStorage.getItem('rolebook_characters') || '[]')
            .forEach(c => { if (c.base?.name) map[c.base.name] = c.id; });
    } catch { }
    try {
        JSON.parse(localStorage.getItem('worldnet_extra_characters') || '[]')
            .forEach(c => { if (c.base?.name) map[c.base.name] = c.id; });
    } catch { }
    return map;
}

// 检测文本里提到的角色（跳过自己）
function findMentionedRoles(text, selfId) {
    const map = getAllRoleNames();
    const found = [];
    for (const [name, id] of Object.entries(map)) {
        if (id === selfId) continue;
        if (text.includes(name)) found.push({ id, name });
    }
    return found;
}

// 组装"该角色对提及角色的认知"（公开 profile + 认知笔记 + 关系态度）
function buildKnowledge(viewerId, mentioned) {
    const store = new CharacterStore(viewerId);          // 只建一次
    const myRelations = store.getRelations() || [];
    return mentioned.map(({ id, name }) => {
        const v = getVisibleProfile(id, viewerId);
        const lines = [`【你认识的 ${name}】`, `性别：${v.gender}`, `年龄：${v.age}`];
        if (v.extra['表象']) lines.push(`你对ta的表面印象：${v.extra['表象']}`);
        if (v.extra['熟人层']) lines.push(`你对ta的了解：${v.extra['熟人层']}`);
        if (v.extra['密友层']) lines.push(`你与ta更深的了解：${v.extra['密友层']}`);

        // ★ 认知笔记（私有，key = 对方 id）
        const note = store.getCognitiveNote(id);
        if (note) lines.push(`你对ta的私人认知笔记：${note}`);

        // ★ 关系态度（relations 里 id 匹配那条）
        const rel = myRelations.find(r => r.id === id);
        if (rel) {
            if (rel.relation) lines.push(`你和ta的关系：${rel.relation}`);
            if (rel.perspective) lines.push(`你对这段关系的视角：${rel.perspective}`);
            if (rel.attitudes) lines.push(`你对ta的态度：${rel.attitudes}`);
        }

        return lines.join('\n');
    }).join('\n\n');
}

// 读取该角色自己最近 n 条朋友圈（高权重，防重复）
function getRecentMoments(characterId, n = 5) {
    try {
        const store = new CharacterStore(characterId);
        const moments = store.getMoments() || [];
        return moments.slice(-n).map(m => m.text).filter(Boolean);
    } catch { return []; }
}

// 发布者可见的角色 id（自己 + 好友，与 moments.js 保持一致）
function getVisibleIds(characterId) {
    const me = new CharacterStore(characterId);
    return [characterId, ...me.getFriendIds()];
}

// 读取可见好友的最近朋友圈（低权重背景，不含自己）
// ★ 与 moments.js collectMoments 同规则：聚合全部动态，纯时间倒序取前 n 条
async function getFriendsRecentMoments(characterId, n = 8) {
    try {
        const ids = getVisibleIds(characterId).filter(id => id !== characterId);
        const all = [];
        ids.forEach(id => {
            try {
                const store = new CharacterStore(id);
                const name = getCharacterNameById(id) || id;
                (store.getMoments() || []).forEach(m => {
                    all.push({ name, text: m.text, ts: m.timestamp });
                });
            } catch { /* 跳过损坏数据 */ }
        });
        return all.sort((a, b) => b.ts - a.ts).slice(0, n);
    } catch { return []; }
}

// 解析一次调用的产出（【朋友圈】...【小剧场】...）
function parseBoth(raw) {
    const s = raw.indexOf('【小剧场】');
    if (s === -1) return { momentText: raw.trim(), sketchText: '' };
    return {
        momentText: raw.slice(0, s).replace(/【朋友圈】/g, '').trim(),
        sketchText: raw.slice(s).replace(/【小剧场】/g, '').trim()
    };
}

// ============================================================
//  生成
// ============================================================

// 一次调用：产出 朋友圈草稿 + 小剧场片段
async function generateBoth(characterId, topic, extraKnowledge = '') {
    const base = getRoleBase(characterId);
    const store = new CharacterStore(characterId);
    const info = store.getInfo();
    const memories = [...(store.getMemories() || []), ...(base.memories || [])];   // 聊天记忆 + 基础记忆
    const roleContext = buildRoleContext(base, info, memories);

    // ★ 自己的最近朋友圈（高权重防重复）+ 好友动态（低权重背景）
    const myRecent = getRecentMoments(characterId, 5);
    const friendsRecent = await getFriendsRecentMoments(characterId, 8);

    const systemPrompt = '你是一个角色扮演助手。请完全以给定角色的身份、性格和说话风格，模拟该角色发布一条朋友圈动态。' +
        '这是该角色本人的独立表达，不是回复任何人，不需要回应或讨好任何人，也不需要考虑别人会怎么看。' +
        '请严格按以下格式输出：\n【朋友圈】\n<朋友圈正文>\n【小剧场】\n<以该角色为视角的一小段日常小剧场/生活片段>' +
        '。朋友圈可以是一两句话，也可以是较长的一段，长度自然决定。只输出这两部分，不要任何额外解释。' +
        // ★ 防重复 + 权重声明
        '重要：新的朋友圈【绝不能】与你自己最近发布过的任何一条重复或高度相似（包括主题、措辞、场景、开头句式）。' +
        '你看到的朋友们的动态只是低权重的背景参考：不要复述、模仿或直接回应它们，' +
        '你的朋友圈应主要围绕你自己的记忆、生活细节和当前心境展开。';

    const userContent = `请以以下角色本人的身份发布一条朋友圈，并附带一段小剧场：\n\n${roleContext}\n\n` +
        (extraKnowledge ? `${extraKnowledge}\n\n` : '') +
        (topic ? `这次朋友圈相关的事件或主题：${topic}\n\n` : '') +
        // ★ 自己的最近动态（防重复，高权重）
        (myRecent.length
            ? `你最近发布过的朋友圈（新的朋友圈请避免与这些重复或雷同）：\n${myRecent.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\n`
            : '') +
        // ★ 好友动态（低权重背景）
        (friendsRecent.length
            ? `你最近看到的朋友们的动态（仅作低权重背景参考，无需直接关联）：\n${friendsRecent.map(f => `- ${f.name}：${f.text}`).join('\n')}\n\n`
            : '') +
        '按【朋友圈】【小剧场】格式输出。';

    const raw = await callAIWithMessages({
        systemPrompt,
        userContent,
        maxTokens: 12000,
        temperature: 0.9
    });
    return parseBoth(raw || '');
}

// 修正/重写一条朋友圈（按提及角色的认知修正称呼与描述）
export async function fixMomentText(characterId, originalText) {
    const mentioned = findMentionedRoles(originalText, characterId);
    if (!mentioned.length) return originalText;   // 没提到任何角色，无需修正

    const base = getRoleBase(characterId);
    const store = new CharacterStore(characterId);
    const info = store.getInfo();
    const memories = [...(store.getMemories() || []), ...(base.memories || [])];
    const roleContext = buildRoleContext(base, info, memories);
    const knowledge = buildKnowledge(characterId, mentioned);

    const systemPrompt = '你是一个角色扮演助手。请以给定角色的身份，重写这条朋友圈。要求：' +
        '1.保持原意和情感基调 2.严格依据"你认识的XX"信息来称呼和描述其他角色（性别、印象等）' +
        '3.保持角色本人的说话风格 4.只输出修正后的朋友圈正文，不要任何解释、标题或标记。';

    const userContent = `角色信息：\n${roleContext}\n\n${knowledge}\n\n你之前发的一条朋友圈：\n${originalText}\n\n请修正并重写这条朋友圈（重点修正对其他角色的称呼与描述），只输出正文。`;

    const text = await callAIWithMessages({
        systemPrompt,
        userContent,
        maxTokens: 12000,
        temperature: 0.9
    });
    return (text || originalText).trim();
}

/**
 * 以任意角色本人的身份生成一条朋友圈（自动入库小剧场）
 * @param {string} characterId
 * @param {object} [opts]
 * @param {string} [opts.topic]
 * @param {boolean} [opts.autoFix=true] - 自动修正开关：开=两阶段，关=一次调用直接返回
 * @returns {Promise<string>} 朋友圈正文
 */
export async function generateMomentForCharacter(characterId, { topic = '', autoFix = true } = {}) {
    // ★ 兜底：已归档角色不生成新动态（防止未来新入口漏网）
    try {
        const { isArchived } = await import('../roleData.js');
        if (isArchived(characterId)) {
            throw new Error('该角色已归档，无法发布朋友圈');
        }
    } catch (e) {
        if (e.message?.includes('归档')) throw e;
    }
    const base = getRoleBase(characterId);
    const info = new CharacterStore(characterId).getInfo();
    const selfName = base.name || info.name || characterId;

    // 第一轮：朋友圈草稿 + 小剧场（小剧场直接入库，不浪费调用）
    const first = await generateBoth(characterId, topic, '');
    if (first.sketchText) await addSketch({ sourceName: selfName, content: first.sketchText });

    const draft = first.momentText;
    if (!autoFix) return draft;

    // 自动修正：检测提及角色 → 修正重写
    return await fixMomentText(characterId, draft);
}

// apps/games/werewolfAI.js — 狼人杀的 AI 层
//
// 边界（红线，改这个文件前先读 AI/07）：
// - **无上帝视角**：每次调用只装一个角色的视角。全场身份表、他人的身份、他人的私有信息、
//   任何人贴的标签都绝不下发。批量调用时每个块也只装它自己的信息。
// - 只做「组装提示词 / 调用 / 超时 / 宽松解析 / 模板兜底」，不做流程与落座决策（那是 werewolf.js 的事）。
// - 所有调用走 taskManager，label 必须模糊化（不含角色名）。
// - 降级状态（连续失败、要不要转模板）挂在 session.ai 上，由 modeOf/afterCall 读写。

import { callAIWithMessages, hasApiKey } from '../aiService.js';
import { taskManager } from '../../store/AITaskManager.js';
import { CharacterStore } from '../../store/CharacterStore.js';
import { getVisibleProfile } from '../../store/profileAccess.js';
import { getCharacterRecordById, getCharacterNameById } from '../characterManager.js';
import { MARK_TAGS } from './werewolfRooms.js';
import {
    seatAt, aliveSeats, wolvesOf, seatsOfRole, wolfTargets, seerTargets,
    viewOf, publicFeed
} from './werewolfEngine.js';

export const DEFAULT_TIMEOUT = 120000;   // 单次调用超时（照占卜/日记口径）
/**
 * 单次调用的默认输出上限：调用点自己写了 maxTokens 就以调用点为准。
 * 这里的调用大多只要一两句或一小段 JSON，本来几百 token 就够——但**按次数计费**时，
 * 截断等于这一整次调用白烧：被切掉的往往正是末尾那几行标记（邀请的【同意】、投票的 JSON），
 * 于是还得再打一次。所以默认给足；哪一步想单独调高调低，就在那个调用点写自己的值。
 */
export const DEFAULT_MAX_TOKENS = 2000;

/* ---------------- 调用基础设施 ---------------- */

export function hasKey() {
    try { return hasApiKey(); } catch { return false; }
}

function withTimeout(promise, ms) {
    let timer = null;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('AI 响应超时')), ms);
        })
    ]).finally(() => clearTimeout(timer));
}

/**
 * 统一的调用出口：超时保护 + 任务中心登记（label 模糊化）
 * @returns {Promise<string>} 模型原文
 */
async function callAI({ systemPrompt, userContent, maxTokens = DEFAULT_MAX_TOKENS, temperature = 0.9, label, timeoutMs = DEFAULT_TIMEOUT }) {
    if (!hasKey()) throw new Error('NO_API_KEY');
    return taskManager.watch('werewolf', label, async () => {
        const raw = await withTimeout(
            callAIWithMessages({ systemPrompt, userContent, maxTokens, temperature }),
            timeoutMs
        );
        return String(raw || '').trim();
    });
}

/* ---------------- 视角组装（各角色共用） ---------------- */

/**
 * 某个角色的自我卡：名册角色读自己的记录，路人用内联人设
 * @param {{id?:string, name?:string, persona?:string}} who
 */
export function selfCard(who = {}) {
    const name = who.name || (who.id ? getCharacterNameById(who.id) : '') || '某人';
    const rec = who.id ? getCharacterRecordById(who.id) : null;
    const base = rec?.base || {};
    const memories = (rec?.memories || []).slice(-5).map(m => `- ${m.time || ''}：${m.content || ''}`);
    return [
        `你叫${name}。`,
        base.gender ? `性别：${base.gender}` : '',
        base.age ? `年龄：${base.age}` : '',
        base.desc ? `人设：${base.desc}` : (who.persona ? `人设：${who.persona}` : ''),
        base.style ? `说话风格：${base.style}` : '',
        memories.length ? `你最近的记忆：\n${memories.join('\n')}` : ''
    ].filter(Boolean).join('\n');
}

/**
 * 某角色对在场其他人的私人认知（可见 profile + 认知笔记 + 关系态度）
 * —— 与朋友圈 momentsAI 的 buildKnowledge 同一条数据路径，只是这里独立了一份
 * @param {string} viewerId 视角角色（路人没有名册身份，直接返回空）
 * @param {Array<{id?:string,name?:string,persona?:string}>} others
 */
export function buildKnowledge(viewerId, others = []) {
    if (!viewerId) return '';
    let store = null, relations = [];
    try {
        store = new CharacterStore(viewerId);
        relations = store.getRelations() || [];
    } catch { return ''; }

    return others
        .filter(o => o && o.id && o.id !== viewerId)
        .map(o => {
            const lines = [`【你认识的 ${o.name || o.id}】`];
            try {
                const v = getVisibleProfile(o.id, viewerId);
                if (v.extra?.['表象']) lines.push(`你对ta的表面印象：${v.extra['表象']}`);
                if (v.extra?.['熟人层']) lines.push(`你对ta的了解：${v.extra['熟人层']}`);
                if (v.extra?.['密友层']) lines.push(`你与ta更深的了解：${v.extra['密友层']}`);
            } catch { }
            try {
                const note = store.getCognitiveNote(o.id);
                if (note) lines.push(`你对ta的私人认知笔记：${note}`);
            } catch { }
            const rel = relations.find(r => r.id === o.id);
            if (rel?.relation) lines.push(`你和ta的关系：${rel.relation}`);
            if (rel?.perspective) lines.push(`你对这段关系的视角：${rel.perspective}`);
            if (rel?.attitudes) lines.push(`你对ta的态度：${rel.attitudes}`);
            return lines.join('\n');
        })
        .join('\n\n');
}

/** 座位表文案（只含公开信息：谁坐在几号） */
function seatLines(seated = [], freeSeats = []) {
    const taken = seated.map(s => `${s.seat} 号 · ${s.name || '有人'}`);
    return [
        taken.length ? `已坐下：${taken.join('；')}` : '目前还没有人坐下。',
        freeSeats.length ? `还空着的座位：${freeSeats.join('、')} 号` : '座位已经坐满了。'
    ].join('\n');
}

/* ---------------- 邀请（一次调用 = 一位被邀请者） ---------------- */

const GAME_BRIEF = '「狼人杀」是一种靠发言和推理找出隐藏狼人的桌上游戏：'
    + '每局 2 名狼人、1 名预言家、1 名猎人、2 名村民，身份由发牌随机决定，开局前谁也不知道自己拿到什么。'
    + '玩法是白天轮流发言、一起投票放逐一个人，夜里狼人杀人、预言家查身份。';

/**
 * 邀请一位角色上桌
 * @param {object} p
 * @param {object} p.type 房间分类（新手局/速战局/扮演局…）
 * @param {object} p.board 板子
 * @param {string} p.inviterId 邀请者角色 id
 * @param {string} p.inviterName
 * @param {{id:string,name:string}} p.target 被邀请者
 * @param {Array} p.seated 当前座位 [{seat, characterId, name}]
 * @param {number[]} p.freeSeats 可落座空位
 * @returns {Promise<{agreed:boolean, seat:number|null, reaction:string, reply:string, degraded:boolean}>}
 */
export async function inviteCharacter({ type, board, inviterId, inviterName, target, seated = [], freeSeats = [] }) {
    const inviter = { id: inviterId, name: inviterName };
    // 已经在座的人 + 邀请者（邀请者若已坐下就不重复列）
    const others = [];
    const seen = new Set([target.id]);
    for (const o of [...seated.filter(s => s.characterId).map(s => ({ id: s.characterId, name: s.name })), inviter]) {
        if (!o.id || seen.has(o.id)) continue;
        seen.add(o.id);
        others.push(o);
    }
    const knowledge = buildKnowledge(target.id, others);

    const systemPrompt = [
        '你在扮演一个角色。请完全以这个角色的人设说话，用第一人称，不要跳出角色，'
            + '不要提到「AI」「模型」「提示词」「系统」，也不要替别人说话。',
        '',
        '【你】',
        selfCard(target),
        knowledge ? `\n【你认识的在场者】\n${knowledge}` : '',
        '',
        '【背景】',
        GAME_BRIEF
    ].filter(Boolean).join('\n');

    const userContent = [
        `「${inviterName}」邀请你加入一桌狼人杀。`,
        `房间类型：${type?.name || '一个房间'}（${type?.desc || '几个人围一桌'}）`,
        `板子：${board?.label || '6 人标准板'}`,
        seatLines(seated, freeSeats),
        '',
        '请写一段自然的回应（1~2 句，符合你的性格与说话风格），然后在最后另起三行给出标记，格式必须完全一致：',
        '【同意】 或 【拒绝】',
        '【座位】 一个还空着的座位号（同意时才写）',
        '【进场】 你进场后的一句话（打招呼、对熟人说点什么；不想说话就写：沉默）',
        '只输出回应正文与这三行标记，不要解释游戏规则。'
    ].join('\n');

    try {
        // 正文只有 1~2 句，但末尾那三行标记一旦被截断，整次邀请就会被判成「没答应」
        const raw = await callAI({
            systemPrompt, userContent,
            temperature: 0.9,
            label: '狼人杀 · 邀请一位朋友'
        });
        return { ...parseInviteReply(raw), degraded: false };
    } catch (e) {
        // 兜底：没配 key / 超时 / 调用失败 → 照常上桌，用模板反应，不阻塞组局
        return { agreed: true, seat: null, reaction: '', reply: '', degraded: true, reason: e.message || String(e) };
    }
}

/** 模型常常自己给台词裹一层引号，展示时外面还要再包一层，这里先剥掉 */
function stripQuotes(text) {
    const s = String(text || '').trim();
    return /^[「『]/.test(s) && /[」』]$/.test(s) ? s.slice(1, -1).trim() : s;
}

/** 宽松解析邀请回复：自由文本 + 标记行 */
export function parseInviteReply(raw) {
    const text = String(raw || '');
    const agreeAt = text.search(/【同意】/);
    const denyAt = text.search(/【拒绝】/);
    const agreed = agreeAt >= 0 && (denyAt < 0 || agreeAt < denyAt);

    const seatMatch = text.match(/【座位】[^\d\n]*(\d+)/);
    const reactMatch = text.match(/【进场】\s*([^\n]*)/);

    // 展示用的正文：剔掉标记行（照 chat.js 剔标记的先例）
    const reply = text
        .replace(/【(同意|拒绝|座位|进场)】[^\n]*/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return {
        agreed,
        seat: seatMatch ? Number(seatMatch[1]) : null,
        reaction: stripQuotes(reactMatch?.[1]),
        reply: stripQuotes(reply)
    };
}

/* ---------------- 匹配（一次调用 = 整批候选） ---------------- */

/**
 * 批量匹配：一次调用让所有被选中的角色各自选座 + 给进场反应
 * @param {object} p
 * @param {object} p.type 房间分类
 * @param {object} p.board
 * @param {Array} p.seated 已坐下的 [{seat, characterId, name}]
 * @param {number[]} p.freeSeats
 * @param {Array<{id:string,name:string}>} p.candidates 被选中的角色（已排除占用与预留）
 * @returns {Promise<{list:Array<{characterId:string, seat:number|null, reaction:string}>, degraded:boolean}>}
 */
export async function matchCharacters({ type, board, seated = [], freeSeats = [], candidates = [] }) {
    if (!candidates.length) return { list: [], degraded: false };

    const seatedOthers = seated.filter(s => s.characterId).map(s => ({ id: s.characterId, name: s.name }));
    const blocks = candidates.map((c, i) => {
        const knowledge = buildKnowledge(c.id, seatedOthers.filter(o => o.id !== c.id));
        return `### 角色 ${i + 1}（characterId: ${c.id}）\n`
            + `${selfCard(c)}\n`
            + (knowledge ? `${knowledge}\n` : '')
            + `（该角色对场上其他人的了解只包含上面这些，不要替它编造更多）`;
    });

    const systemPrompt = '你是一个桌游房间的入场模拟器。'
        + '给定若干被邀请上桌的角色，每个角色都带着自己的人设，以及他自己对场上其他人的了解。'
        + `这一桌是${GAME_BRIEF}`
        + '请模拟每个角色入座时的表现：他会挑哪个空座位，以及坐下后说的一句话。'
        + '每个角色只能基于【他自己的人设与他对场上这些人的了解】来行动，不要替别人说话，也不要编造他没有的认知。'
        + '性格外向的可能主动打招呼、对熟人说话，性格冷淡的可能只写「沉默」。'
        + '输出 JSON 数组，每个元素对应一个角色：'
        + '{"characterId":"角色id","seat":座位号(数字),"reaction":"进场后的一句话，不想说话就写 沉默"}。'
        + '只输出 JSON 数组，不要任何其他文字。';

    const userContent = blocks.join('\n\n---\n\n')
        + `\n\n【本桌信息】\n房间类型：${type?.name || '一个房间'}（${type?.desc || ''}）\n板子：${board?.label || '6 人标准板'}\n`
        + seatLines(seated, freeSeats)
        + '\n\n请为上述每个角色分别生成入座结果（JSON 数组，seat 必须从上空着的座位里选）。';

    try {
        const raw = await callAI({
            systemPrompt, userContent,
            maxTokens: 4000, temperature: 0.85,   // 一次要点满整批候选的选座与台词，比默认多给
            label: '狼人杀 · 匹配入座'
        });
        return { list: parseMatchReply(raw), degraded: false };
    } catch (e) {
        return { list: [], degraded: true, reason: e.message || String(e) };
    }
}

/** 宽松解析批量匹配 JSON */
export function parseMatchReply(raw) {
    const out = [];
    const apply = arr => {
        if (!Array.isArray(arr)) return;
        for (const item of arr) {
            if (!item?.characterId) continue;
            const seat = Number(item.seat);
            out.push({
                characterId: String(item.characterId),
                seat: Number.isFinite(seat) && seat > 0 ? seat : null,
                reaction: String(item.reaction || '').trim()
            });
        }
    };
    try { apply(JSON.parse(raw)); if (out.length) return out; } catch { }
    try {
        const m = String(raw || '').match(/\[[\s\S]*\]/);
        if (m) apply(JSON.parse(m[0]));
    } catch { }
    return out;
}

/* ================= 对局内调用（发言 / 投票 / 夜晚 / 代笔） =================
 *
 * 和邀请、匹配同一条边界：一次调用只装**一个座位此刻自己知道的事**（viewBlock）。
 * 全场身份表、他人的身份、他人的验人结果、任何人贴的标签都不进来。
 * 主视角的标记只有一个出口：ghostwrite（那是玩家让 AI 顺着自己的判断代笔）。
 */

/* ---- 调用模式（三级降级） ---- */

export const FAIL_LIMIT = 3;      // 连续失败到这个数，整局转模板模式
export const CALL_BUDGET = 60;    // 一局最多打多少次对局内调用（邀请与匹配另算）

/**
 * 这次调用该不该真打出去。
 * ① 没配 key ② 已经连续失败到 FAIL_LIMIT ③ 超过调用预算 → 'template'
 */
export function modeOf(session) {
    if (!hasKey()) return 'template';
    if (session?.ai?.template) return 'template';
    if ((session?.callCount || 0) >= CALL_BUDGET) return 'template';
    return 'ai';
}

/**
 * 记一次调用的结果，返回此后该用的模式。
 * 单次失败只是这一次走模板；连续失败到 FAIL_LIMIT 就整局转模板——
 * 与其让玩家一直等超时，不如先把这局点完。转了就转不回来（这一局）。
 */
export function afterCall(session, { ok = true } = {}) {
    if (!session) return 'ai';
    const state = session.ai = session.ai || { fails: 0, template: false };
    if (ok) { state.fails = 0; return state.template ? 'template' : 'ai'; }
    state.fails += 1;
    if (state.fails >= FAIL_LIMIT) state.template = true;
    return state.template ? 'template' : 'ai';
}

/**
 * 收下某个 AI 给自己视角下的他人贴的标签。
 * 存进 session.aiLabels[它自己]，只回灌它自己后续的提示词——别人（含主视角）看不到。
 */
export function mergeLabels(session, seatNo, marks = {}) {
    if (!session || !marks || !Object.keys(marks).length) return;
    const all = session.aiLabels = session.aiLabels || {};
    all[seatNo] = { ...(all[seatNo] || {}), ...marks };
}

/* ---- 视角块 ---- */

/**
 * 这个座位此刻知道的事：自己（身份/阵营/同伴/验人记录）+ 公开场上信息 +
 * 自己对在场者的私人认知 + **它自己**此前贴的判断。
 * 公开那一段各座位逐字一致（都是 publicFeed 出来的）。
 */
function viewBlock(session, seatNo) {
    const seat = seatAt(session, seatNo);
    if (!seat) return '';
    const view = viewOf(session, seatNo) || {};
    // 路人没有名册记录，只能靠座位上那句人设扮演；它的存在感也只到「名字」为止
    const mine = seat.kind === 'npc'
        ? { name: seat.name, persona: seat.persona }
        : { id: seat.characterId, name: seat.name };
    const others = (session.seats || [])
        .filter(s => s.seat !== seatNo && s.kind !== 'npc' && s.characterId)
        .map(s => ({ id: s.characterId, name: s.name }));
    const knowledge = seat.kind === 'npc' ? '' : buildKnowledge(seat.characterId, others);
    const myLabels = (session.aiLabels || {})[seatNo] || {};
    const labelLine = Object.entries(myLabels).map(([s, t]) => `${s} 号=${t}`).join('、');

    return [
        '【你】',
        selfCard(mine),
        `你的身份：${view.roleLabel}（${view.faction === 'wolf' ? '狼人阵营' : '好人阵营'}）`,
        view.faction === 'wolf' ? '你是狼人：白天要装成好人，别把同伴供出去；夜里你和同伴一起决定刀谁。' : '',
        view.teammates?.length ? `你的狼同伴：${view.teammates.map(t => `${t.seat} 号 ${t.name}`).join('、')}` : '',
        view.checks?.length
            ? `你验过的人：\n${view.checks.map(c => `- 第 ${c.round} 夜 ${c.seat} 号 ${c.name}：${c.isWolf ? '狼人' : '好人'}`).join('\n')}`
            : '',
        '',
        publicFeed(session),     // 自带「【场上】存活：…」这一段
        knowledge ? `\n【你对在场各人的了解】\n${knowledge}` : '',
        labelLine ? `\n【你之前对他们的判断】\n${labelLine}` : ''
    ].filter(Boolean).join('\n');
}

/** 玩家的口吻提示（语气按房间分类走） */
function toneLine(type) {
    return type?.tone ? `这一桌的气氛：${type.tone}。` : '';
}

/** 角色扮演的通用头（每个对局内调用都用它做 systemPrompt 开头） */
const ROLE_HEAD = '你在扮演一个角色，正在玩一桌狼人杀（2 狼人、1 预言家、1 猎人、2 村民，靠发言和投票找出狼人）。'
    + '完全以这个角色的人设说话，用第一人称，不要跳出角色；'
    + '不要提到「AI」「模型」「提示词」「系统」，不要替别人说话，不要复述规则。';

/* ---- 发言 ---- */

const FALLBACK_SPEECHES = [
    '我先听听大家怎么说，暂时没有别的想法。',
    '我这边没什么信息，跟大多数人的判断走吧。',
    '我暂时看不出谁是狼，先不给人乱扣帽子。',
    '今天先过一轮吧，我保留意见。',
    '我是好人，没有什么要辩解的。'
];

/** 模板台词（无 key / 连续失败时用），按座位取，稳定不随机 */
export function fallbackSpeech(seatNo) {
    return FALLBACK_SPEECHES[(Math.max(1, seatNo) - 1) % FALLBACK_SPEECHES.length];
}

/**
 * 一次调用 = 一位角色的发言
 * @param {object} p
 * @param {object} p.session
 * @param {number} p.seatNo 说话的座位
 * @param {object} [p.type] 房间分类（取发言字数上限与语气）
 * @returns {Promise<{text:string, marks:Object<number,string>, degraded:boolean, reason?:string}>}
 */
export async function speakCharacter({ session, seatNo, type }) {
    const limit = type?.speechLimit || 120;
    const fallback = { text: fallbackSpeech(seatNo), marks: {}, degraded: true };
    if (modeOf(session) === 'template') return { ...fallback, reason: 'template' };

    const systemPrompt = [ROLE_HEAD, '', viewBlock(session, seatNo)].join('\n');
    const userContent = [
        `轮到你发言了。${toneLine(type)}`,
        `请说一段自然的话（不超过 ${limit} 字）：可以表态、可以怀疑谁、可以解释自己，也可以顺着你之前的判断说。`,
        '只写你说出口的话，不要写「XX 说：」这样的前缀。',
        '',
        '最后另起一行，可选地写下你此刻对其他人的判断（没有新想法就不写这行），格式必须完全一致：',
        '【判断】3号=狼人 5号=存疑',
        `（标签只能用：${MARK_TAGS.join('、')}）`
    ].join('\n');

    try {
        const raw = await callAI({
            systemPrompt, userContent,
            temperature: 0.95,
            label: '狼人杀 · 一位发言'
        });
        const parsed = parseSpeakReply(raw);
        if (!parsed.text) throw new Error('空回复');
        return { ...parsed, degraded: false };
    } catch (e) {
        return { ...fallback, reason: e.message || String(e) };
    }
}

/** 发言解析：正文 + 可选的【判断】行（判断行从正文里剔掉，只入标签） */
export function parseSpeakReply(raw) {
    const text = String(raw || '');
    const judge = text.match(/【判断】\s*([^\n]*)/);
    const marks = parseMarks(judge?.[1] || '');
    const body = text.replace(/【判断】[^\n]*/g, '').replace(/\n{3,}/g, '\n\n').trim();
    return { text: stripQuotes(body), marks };
}

/**
 * 「3号=狼人、5号存疑」→ { 3: '狼人', 5: '存疑' }
 * 只认预设标签（狼/民 这类简写归一到词表里的写法），认不出的整条丢掉。
 */
export function parseMarks(text) {
    const out = {};
    const re = /(\d{1,2})\s*号?\s*(?:=|＝|：|:|是|为|->|→)?\s*(狼人|狼|好人|预言家|猎人|村民|存疑|民)/g;
    let m;
    while ((m = re.exec(String(text || '')))) {
        const seat = Number(m[1]);
        if (seat < 1 || seat > 20) continue;
        out[seat] = m[2] === '狼' ? '狼人' : (m[2] === '民' ? '村民' : m[2]);
    }
    return out;
}

/* ---- 投票 ---- */

/**
 * 一次调用 = 一位角色投票
 * @returns {Promise<{vote:number|null, reason:string, marks:Object, degraded:boolean, reason?:string}>}
 *   vote 只可能是「场上的活人（不含自己）」或 null（弃票/认不出）——脏目标一律收成弃票
 */
export async function voteCharacter({ session, seatNo, type }) {
    const legal = aliveSeats(session).filter(s => s.seat !== seatNo).map(s => s.seat);
    const fallback = { vote: null, reason: '', marks: {}, degraded: true };
    if (!legal.length || modeOf(session) === 'template') return { ...fallback, reason: 'template' };

    const systemPrompt = [ROLE_HEAD, '', viewBlock(session, seatNo)].join('\n');
    const userContent = [
        `投票时间。${toneLine(type)}`,
        `你要投一个人出局，或者弃票。可以投的座位：${legal.join('、')} 号。`,
        '输出 JSON，不要任何别的文字：',
        '{"vote":座位号(数字，弃票写 null),"reason":"一句话理由","marks":{"座位号":"标签"}}',
        `（marks 可省略；写的话标签只能用：${MARK_TAGS.join('、')}）`
    ].join('\n');

    try {
        const raw = await callAI({
            systemPrompt, userContent,
            temperature: 0.85,
            label: '狼人杀 · 一次投票'
        });
        return { ...parseVoteReply(raw, legal), degraded: false };
    } catch (e) {
        return { ...fallback, reason: e.message || String(e) };
    }
}

/** 投票解析：JSON 优先，认不出就退到「投 N 号」的字面匹配，仍认不出算弃票 */
export function parseVoteReply(raw, legal = []) {
    const pick = obj => ({
        vote: legal.includes(Number(obj?.vote)) ? Number(obj.vote) : null,
        reason: String(obj?.reason || '').trim(),
        marks: parseMarks(typeof obj?.marks === 'string'
            ? obj.marks
            : Object.entries(obj?.marks || {}).map(([s, t]) => `${s}号=${t}`).join(' '))
    });
    const text = String(raw || '');
    try { const obj = JSON.parse(text); if (obj && typeof obj === 'object') return pick(obj); } catch { }
    try {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) { const obj = JSON.parse(m[0]); if (obj && typeof obj === 'object') return pick(obj); }
    } catch { }
    const said = text.match(/(?:投|票给|出局)\s*(\d{1,2})\s*号/);
    const vote = said && legal.includes(Number(said[1])) ? Number(said[1]) : null;
    return { vote, reason: stripQuotes(text.split('\n')[0] || ''), marks: parseMarks(text) };
}

/* ---- 夜晚：狼刀 / 验人 / 开枪 ---- */

const NIGHT_ASK = {
    wolf: '你们狼队今晚要刀一个人。',
    seer: '你今晚要验一个人，验出他是好人还是狼人。',
    hunter: '你出局了，你是猎人，可以开枪带走场上一人，也可以弃枪。'
};

/**
 * 一次调用 = 一个夜晚决策（狼队一次调用，算整队的决定）
 * @param {object} p
 * @param {'wolf'|'seer'|'hunter'} p.kind
 * @param {number} [p.seatNo] 视角座位；不给就按 kind 推断（狼队取座号最小的活狼）
 * @returns {Promise<{target:number|null, reason:string, degraded:boolean}>}
 */
export async function nightAction({ session, kind, seatNo = null }) {
    const who = seatNo ?? defaultActor(session, kind);
    const targets = nightTargets(session, kind, who);
    const fallback = { target: templateNightTarget(session, kind, who), reason: '', degraded: true };
    if (!targets.length || modeOf(session) === 'template') return { ...fallback, reason: 'template' };
    const seat = seatAt(session, who);
    if (!seat) return { ...fallback, reason: 'no-actor' };

    const systemPrompt = [ROLE_HEAD, '', viewBlock(session, who)].join('\n');
    const userContent = [
        `${NIGHT_ASK[kind] || '你要行动了。'}`,
        kind === 'wolf' ? `可以刀的座位：${targets.join('、')} 号（狼同伴不在其中）。` : '',
        kind === 'seer' ? `可以验的座位：${targets.join('、')} 号。` : '',
        kind === 'hunter' ? `可以带走的座位：${targets.join('、')} 号。` : '',
        kind === 'hunter' ? '输出 JSON：{"target":座位号(数字，弃枪写 null),"reason":"一句话理由"}' : '输出 JSON：{"target":座位号(数字),"reason":"一句话理由"}',
        '只输出 JSON，不要任何别的文字。'
    ].filter(Boolean).join('\n');

    try {
        const raw = await callAI({
            systemPrompt, userContent,
            temperature: 0.85,
            label: kind === 'seer' ? '狼人杀 · 一次验人' : '狼人杀 · 一个夜晚决策'
        });
        return { ...parseNightReply(raw, targets, kind), degraded: false };
    } catch (e) {
        return { ...fallback, reason: e.message || String(e) };
    }
}

/** 夜晚决策的视角座位：狼队用座号最小的活狼 */
export function defaultActor(session, kind) {
    if (kind === 'hunter') return session?.pendingShot?.seat ?? null;
    if (kind === 'seer') return (seatsOfRole(session, 'seer').find(s => s.alive !== false) || {}).seat ?? null;
    return (wolvesOf(session).find(s => s.alive !== false) || {}).seat ?? null;
}

/** 这一个决策的合法目标（引擎的规则也拦一遍，这里只是别把非法选项喂给模型） */
export function nightTargets(session, kind, seatNo) {
    if (kind === 'wolf') return wolfTargets(session).map(s => s.seat);
    if (kind === 'seer') return seerTargets(session, seatNo).map(s => s.seat);
    return aliveSeats(session).filter(s => s.seat !== seatNo).map(s => s.seat);
}

/** 夜晚决策解析：JSON 优先，认不出就退到「刀/验/带 3 号」的字面匹配 */
export function parseNightReply(raw, legal = [], kind = 'wolf') {
    const text = String(raw || '');
    const take = v => { const n = Number(v); return legal.includes(n) ? n : null; };
    try { const obj = JSON.parse(text); if (obj && typeof obj === 'object') return { target: take(obj.target), reason: String(obj.reason || '').trim() }; } catch { }
    try {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) { const obj = JSON.parse(m[0]); if (obj && typeof obj === 'object') return { target: take(obj.target), reason: String(obj.reason || '').trim() }; }
    } catch { }
    const said = text.match(/(\d{1,2})\s*号/);
    return { target: said ? take(said[1]) : null, reason: stripQuotes(text.split('\n')[0] || '') };
}

/** 模板模式的夜晚行动：狼刀座号最小的好人，预言家验第一个没验过的，猎人弃枪 */
export function templateNightTarget(session, kind, seatNo) {
    if (kind === 'hunter') return null;
    const legal = nightTargets(session, kind, seatNo);
    if (!legal.length) return null;
    if (kind === 'seer') {
        const checked = new Set((session?.seerLog || []).filter(e => e.by === seatNo).map(e => e.seat));
        return legal.find(s => !checked.has(s)) ?? legal[0];
    }
    return legal[0];
}

/* ---- 代笔（唯一允许主视角标记进入的调用） ---- */

/**
 * 玩家打了一半（或者只贴了标签），让 AI 按玩家角色的口吻替他把话写完。
 * 标记是玩家自己贴的，只在这一路进入提示词；AI 角色的调用里永远没有它。
 * @returns {Promise<{text:string, degraded:boolean, reason?:string}>}
 */
export async function ghostwrite({ session, seatNo, draft = '', marks = {}, type }) {
    const limit = type?.speechLimit || 120;
    const mine = { text: String(draft || '').trim(), degraded: true };
    if (modeOf(session) === 'template') return mine;

    const marked = Object.entries(marks).map(([s, t]) => `${s} 号=${t}`).join('、');
    const systemPrompt = [ROLE_HEAD, '', viewBlock(session, seatNo)].join('\n');
    const userContent = [
        `轮到你发言，你自己先打了半句草稿，想让别人（同样是你）替你把话说完。`,
        mine.text ? `你的草稿：${mine.text}` : '你还没打草稿，只给了自己的判断。',
        marked ? `你自己给场上的人贴的判断（顺着它说）：${marked}` : '',
        `请以你的口吻写成一段完整的发言（不超过 ${limit} 字），保留草稿的原意，可以补上理由与态度。`,
        '只写你说出口的话，不要写「XX 说：」，不要提到草稿、标签、AI。'
    ].filter(Boolean).join('\n');

    try {
        const raw = await callAI({
            systemPrompt, userContent,
            temperature: 0.9,
            label: '狼人杀 · 代笔'
        });
        const text = stripQuotes(String(raw || '').trim());
        if (!text) throw new Error('空回复');
        return { text, degraded: false };
    } catch (e) {
        // 失败就把玩家自己打的字原样还给他，绝不吞掉
        return { ...mine, reason: e.message || String(e) };
    }
}

/* ---------------- 模板兜底（邀请 / 匹配的进场台词；发言的模板在发言那一节） ---------------- */

const FALLBACK_REACTIONS = [
    '没多说什么，拉了把椅子坐下。',
    '点头应了一声，坐下了。',
    '看了圈桌子，安静地坐下。',
    '「行，玩一把。」',
    '沉默着坐到了位子上。'
];

export function fallbackReaction(name, i = 0) {
    if (i < 0) return '沉默';
    return i < FALLBACK_REACTIONS.length ? FALLBACK_REACTIONS[i] : FALLBACK_REACTIONS[0];
}

export { FALLBACK_REACTIONS };

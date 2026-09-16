// apps/games/werewolfAI.js — 狼人杀的 AI 层
//
// 边界（红线，改这个文件前先读 AI/07）：
// - **无上帝视角**：每次调用只装一个角色的视角。全场身份表、他人的身份、他人的私有信息、
//   任何人贴的标签都绝不下发。批量调用时每个块也只装它自己的信息。
// - 只做「组装提示词 / 调用 / 超时 / 宽松解析 / 模板兜底」，不做流程与落座决策（那是 werewolf.js 的事）。
// - 所有调用走 taskManager，label 必须模糊化（不含角色名）。
// - **用哪条 API 预设**：只扮演**一个**角色的那一拍，用那个角色在名册里绑的预设
//   （presetOfSeat / presetOfChar，绑定表在 apps/roleData.js 的 ai_char_presets）；多人同场
//   （狼队 ≥2 只、一次匹配一批候选人）不传 ⇒ 走默认。绑的那条不在了就让 aiService 报错，**不回退**。
// - 降级状态（连续失败、要不要转模板）挂在 session.ai 上，由 modeOf/afterCall 读写。

import { callAIWithMessages, hasApiKey } from '../aiService.js';
import { getCharPresetId } from '../roleData.js';
import { taskManager } from '../../store/AITaskManager.js';
import { CharacterStore } from '../../store/CharacterStore.js';
import { getVisibleProfile } from '../../store/profileAccess.js';
import { getCharacterRecordById, getCharacterNameById } from '../characterManager.js';
import { boardProse, roleLabel, markTagsOf, roleHeadText } from './werewolfRooms.js';
import { getStat, getNpc, cachedRuleTemplates } from './werewolfStore.js';
import { codexBlock, parseTier, parseFlair, watchPlan, TIERS, FLAIR_TIERS } from './werewolfCodex.js';
import {
    seatAt, aliveSeats, wolvesOf, seatsOfRole, wolfTargets, seerTargets, guardTargets, witchTargets,
    hunterTargets, hunterWakesTonight, currentDeath, hasLastWords, draftsWordsAtNight, voteTargets,
    pkVoteTargets, onPkStage, speakOrderSeats, speakOrderLine,
    speakOrderOptions, sheriffSeatOf, isSheriff, sheriffCandidates, sheriffPkVoteTargets,
    sheriffSpeakOrderSeats, badgeTargets,
    viewOf, publicFeed, finalResult, nightTruth, reviewTranscript, parseMentions, parseWatchTargets,
    parseMarks, labelLineOf
} from './werewolfEngine.js';

export const DEFAULT_TIMEOUT = 120000;   // 单次调用超时（照占卜/日记口径）
/**
 * 单次调用的默认输出上限：调用点自己写了 maxTokens 就以调用点为准。
 * 这里的调用大多只要一两句或一小段 JSON，本来几百 token 就够——但**按次数计费**时，
 * 截断等于这一整次调用白烧：被切掉的往往正是末尾那几行标记（邀请的【同意】、投票的 JSON），
 * 于是还得再打一次。所以默认给足；哪一步想单独调高调低，就在那个调用点写自己的值。
 *
 * **2026-09-13 从 2000 提到 12000**（用户实测定：一局打下来投票阶段**全员弃票**）。
 * 投票是纯 JSON 调用，被截在 JSON 中间 → `parseVoteReply` 认不出 → **按弃票收场**，
 * 而弃票在界面上看不出是「它真想弃」还是「这次调用废了」，所以集体弃票往往就是集体截断。
 * 现在的模型会先吐一段思考链（aiService 的返回结构里记着「有思考链」），
 * 而**思考链也算在这个上限里**——2000 被它吃掉大半，正文就所剩无几了。
 * 上限只是上限，用不完不额外计费（用户按次计费），给宽一点没有代价。
 */
export const DEFAULT_MAX_TOKENS = 12000;

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
 * @param {string} [presetId] 这一拍**只扮演一个角色**时，用它绑的那条 API 预设（见 presetOfSeat / presetOfChar）；
 *   空 = 走默认预设。绑的那条找不到时 aiService 会直接报错，**不回退**（用户口径）。
 * @returns {Promise<string>} 模型原文
 */
async function callAI({ systemPrompt, userContent, maxTokens = DEFAULT_MAX_TOKENS, temperature = 0.9, label, timeoutMs = DEFAULT_TIMEOUT, presetId = '' }) {
    if (!hasKey()) throw new Error('NO_API_KEY');
    return taskManager.watch('werewolf', label, async () => {
        const raw = await withTimeout(
            callAIWithMessages({ systemPrompt, userContent, maxTokens, temperature, presetId: presetId || undefined }),
            timeoutMs
        );
        return String(raw || '').trim();
    });
}

/**
 * 角色绑的 AI 预设（2026-09-15 用户口径）：**只有被设置过的角色**才有值，
 * 没设过 / 是路人（没有 characterId）⇒ '' ⇒ 走默认预设，和以前一模一样。
 */
function presetOfChar(characterId) {
    return characterId ? getCharPresetId(characterId) : '';
}

/** 这一拍扮演的是哪一座，就用哪一座绑的预设 */
function presetOfSeat(session, seatNo) {
    return presetOfChar(seatAt(session, seatNo)?.characterId || '');
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

/**
 * 这个座位的狼人杀档案（战绩 + 档位 + 点亮）：真实角色读 stats，临时路人读 npcs。
 * viewBlock 是同步的，所以读书这一步必须在调用点做完再传进去。
 * 读不到（没打过、没测评过）就返回 null——**别给没上过桌的人凭空发知识**。
 */
export async function loadCodex(seat) {
    if (!seat) return null;
    try {
        if (seat.kind === 'npc') return seat.npcId ? await getNpc(seat.npcId) : null;
        return seat.characterId ? await getStat(seat.characterId) : null;
    } catch (e) {
        return null;   // 读档失败不该让这一局打不下去
    }
}

/** 按座位批量取（狼队一次调用要装好几只狼，别一个一个 await） */
async function loadCodexMap(session, seatNos = []) {
    const pairs = await Promise.all(seatNos.map(async n => [n, await loadCodex(seatAt(session, n))]));
    return Object.fromEntries(pairs);
}

/* ---------------- 落座测评（角色「狼人杀点数」） ----------------
 * 口径（用户 2026-09-12 定）：点数**只在落座那一刻**生成一次，两栏 = 水平 + 悟性，另附一句依据。
 * 搭在邀请/匹配那次调用上顺带要（不加请求次数），**而且要按需**：
 * 邀请之前先看他有没有档位，没有才把这三行加进提示词（用户 2026-09-13 定）——
 * 又邀请一次不等于重估一次，本轮也没有重测入口。因为多问一次不写、少问一次下次再问，
 * 所以不需要「事后补打」那一路：漏答的（模型没给、或当时没配 key）下次被邀请时自然会再问一次。
 */

const labelList = list => list.map(t => t.label).join(' / ');

/**
 * 这个人有没有测评档位。跟 loadCodex 一样，读档失败一律按「没有」处理——
 * 顶多多问一次，而写入处还挡了一道（upsertCodex 不覆盖已有档位），不会把档位估跑偏。
 */
async function hasLevel(characterId) {
    if (!characterId) return false;
    try {
        return !!(await getStat(characterId))?.level;
    } catch (e) {
        return false;
    }
}

/** 没有档位时才追加的三行标记（邀请与匹配共用同一套格式、同一个解析） */
const CODEX_ASK = [
    '另外，再以狼人杀老手的眼光，估一下**这个人**打狼人杀的水平（按他的性格、阅历、脑子快不快估，不必客气），另起三行给出标记：',
    `【水平】 从「${labelList(TIERS)}」里挑一个`,
    `【悟性】 从「${labelList(FLAIR_TIERS)}」里挑一个：他学新东西、看穿套路的快慢`,
    '【依据】 一句话说明理由（说不出理由就别写这三行）'
];

/**
 * 从回复里读那三行标记。**没依据不算数**、**认不出不算数**：
 * 宁可这个角色暂时没有档位（界面上显示「未测评」），也不给他落一个默认档——
 * 第一个不按格式回答的模型会把角色永久钉死在错误的水平上。
 * @returns {{level:string, flair:string|null, why:string}|null}
 */
export function readCodexMarkers(raw) {
    const text = String(raw || '');
    const pick = re => ((text.match(re) || [])[1] || '').trim();
    const level = parseTier(pick(/【水平】\s*([^\n]*)/));
    const flair = parseFlair(pick(/【悟性】\s*([^\n]*)/));
    const why = pick(/【依据】\s*([^\n]*)/);
    return level && why ? { level, flair, why } : null;
}

/* ---------------- 邀请（一次调用 = 一位被邀请者） ---------------- */

/**
 * 规则简介（邀请与匹配共用）。板子构成按实际板子生成——换板子只改 BOARDS.roles，这里不用动。
 */
function gameBrief(board) {
    return '「狼人杀」是一种靠发言和推理找出隐藏狼人的桌上游戏：'
        + `每局 ${boardProse(board?.id)}，身份由发牌随机决定，开局前谁也不知道自己拿到什么。`
        + '玩法是白天轮流发言、一起投票放逐一个人，夜里狼人杀人、有身份的人各自行动。';
}

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
    const needCodex = !(await hasLevel(target.id));   // 有档位就不再问（他那一份就在档案里）

    const systemPrompt = [
        '你在扮演一个角色。请完全以这个角色的人设说话，用第一人称，不要跳出角色，'
            + '不要提到「AI」「模型」「提示词」「系统」，也不要替别人说话。',
        '',
        '【你】',
        selfCard(target),
        knowledge ? `\n【你认识的在场者】\n${knowledge}` : '',
        '',
        '【背景】',
        gameBrief(board)
    ].filter(Boolean).join('\n');

    const userContent = [
        `「${inviterName}」邀请你加入一桌狼人杀。`,
        `房间类型：${type?.name || '一个房间'}（${type?.desc || '几个人围一桌'}）`,
        `板子：${board?.label || '6 人标准板'}`,
        seatLines(seated, freeSeats),
        '',
        '请写一段自然的回应（1~2 句，符合你的性格与说话风格），然后在最后另起几行给出标记，格式必须完全一致：',
        '【同意】 或 【拒绝】',
        '【座位】 一个还空着的座位号（同意时才写）',
        '【进场】 你进场后的一句话（打招呼、对熟人说点什么；不想说话就写：沉默）',
        ...(needCodex ? CODEX_ASK : []),
        '只输出回应正文与这些标记行，不要解释游戏规则。'
    ].join('\n');

    try {
        // 正文只有 1~2 句，但末尾那三行标记一旦被截断，整次邀请就会被判成「没答应」
        const raw = await callAI({
            systemPrompt, userContent,
            temperature: 0.9,
            label: '狼人杀 · 邀请一位朋友',
            presetId: presetOfChar(target.id)      // 被邀请的那一位
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

    // 展示用的正文：剔掉标记行（照 chat.js 剔标记的先例）。
    // 【水平】【悟性】【依据】也必须在这里剥掉——它们要被写进真实聊天记录，
    // 漏一个就会原样出现在「来打狼人杀吗」那段对话里。
    const reply = text
        .replace(/【(同意|拒绝|座位|进场|水平|悟性|依据)】[^\n]*/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return {
        agreed,
        seat: seatMatch ? Number(seatMatch[1]) : null,
        reaction: stripQuotes(reactMatch?.[1]),
        reply: stripQuotes(reply),
        codex: readCodexMarkers(text)
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

    // 谁还没有档位（与邀请同一条口径：有档位就不再问，免得把估好的东西重新估一遍）。
    // 批量调用里没法一个人一个人地问，于是**点名**：只在 JSON 里给这几个人加测评字段。
    const assessNos = [];
    for (let i = 0; i < candidates.length; i++) {
        if (!(await hasLevel(candidates[i].id))) assessNos.push(i + 1);
    }

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
        + `这一桌是${gameBrief(board)}`
        + '请模拟每个角色入座时的表现：他会挑哪个空座位，以及坐下后说的一句话。'
        + '每个角色只能基于【他自己的人设与他对场上这些人的了解】来行动，不要替别人说话，也不要编造他没有的认知。'
        + '性格外向的可能主动打招呼、对熟人说话，性格冷淡的可能只写「沉默」。'
        + '输出 JSON 数组，每个元素对应一个角色：'
        + '{"characterId":"角色id","seat":座位号(数字),"reaction":"进场后的一句话，不想说话就写 沉默"'
        + (assessNos.length
            ? `,"level":"${TIERS.map(t => t.label).join('/')} 里挑一个，按这个人打狼人杀的水平估",`
                + `"flair":"${FLAIR_TIERS.map(t => t.label).join('/')} 里挑一个",`
                + '"why":"一句话说明你这么估的理由（说不出理由就留空这些字段）"}。'
                + `其中只有 ${assessNos.map(n => `角色 ${n}`).join('、')} 还没有测评数据，`
                + '请只给这几位写 level/flair/why，其余角色这三个字段一律留空。'
            : '}。')
        + '只输出 JSON 数组，不要任何其他文字。';

    const userContent = blocks.join('\n\n---\n\n')
        + `\n\n【本桌信息】\n房间类型：${type?.name || '一个房间'}（${type?.desc || ''}）\n板子：${board?.label || '6 人标准板'}\n`
        + seatLines(seated, freeSeats)
        + '\n\n请为上述每个角色分别生成入座结果（JSON 数组，seat 必须从上空着的座位里选）。';

    try {
        const raw = await callAI({
            systemPrompt, userContent,
            temperature: 0.85,   // 一次要点满整批候选的选座与台词；原来单独要 4000，现在整层的 12000 够用
            label: '狼人杀 · 匹配入座'   // 一次演一排候选人 = 多人同场 ⇒ 不传 presetId，走默认预设
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
            // 档位与依据缺一不可（与邀请那条路径同一个口径）
            const level = parseTier(item.level || '');
            const why = String(item.why || '').trim();
            out.push({
                characterId: String(item.characterId),
                seat: Number.isFinite(seat) && seat > 0 ? seat : null,
                reaction: String(item.reaction || '').trim(),
                codex: level && why ? { level, flair: parseFlair(item.flair || ''), why } : null
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
 * 主视角的标记只有一个出口：ghostwrite（那是玩家让 AI 顺着自己的判断代笔）；
 * 主视角对狼队友说的话也只有一个出口：wolfPackAction 的 player（**一次性入参**，不落 session、不进 events）。
 */

/* ---- 调用模式（三级降级） ---- */

export const FAIL_LIMIT = 3;      // 连续失败到这个数，整局转模板模式
// 一局最多打多少次对局内调用。**暂时不封顶**（2026-09-13 用户定：预算这件事先放一放）。
// 机制与读侧都还在，想收回来就把上面这个 Infinity 换成一个数字——
// 也可以由板子下发（BOARDS[x].callBudget → session.callBudget，12 人局参考值 150）。
export const CALL_BUDGET = Infinity;

/**
 * 这一局的预算：板子写了自己的就是它，没写就用默认值。
 * 读 session 的字段而不是板子本身——对局记录因此自带当时的预算（改了板子也不追溯老局）。
 */
export function budgetOf(session) {
    return Number(session?.callBudget) || CALL_BUDGET;
}

/**
 * 这次调用该不该真打出去。
 * ① 没配 key ② 已经连续失败到 FAIL_LIMIT ③ 超过调用预算 → 'template'
 */
export function modeOf(session) {
    if (!hasKey()) return 'template';
    if (session?.ai?.template) return 'template';
    if ((session?.callCount || 0) >= budgetOf(session)) return 'template';
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

/* ---- 私有笔记（每个 AI 决策的副产物） ----
 * 存储与写入在引擎（addNote，跟 seerLog/guardLog 一处），这里只管怎么讲给模型听。
 * **整局一条不落地回灌**（用户 2026-09-15 定）：笔记就是"早期的发言已经记不清了"之后的依靠，
 * 所以这里既不截条数、也不截时间窗——它写下的每一笔都在，从第一天到出局。
 * （流水的记忆是按 `tail` 按人截的，笔记不是那一路：那一套管的是"听别人说话记不记得住"。）
 */

/** 笔记抬头「第 N 夜 / 第 N 天」：夜里干的活按夜算，白天的按天算 */
const NIGHT_KINDS = new Set(['wolf', 'seer', 'guard', 'witch', 'hunter']);
const NOTE_KIND_LABEL = {
    wolf: '狼刀', seer: '验人', guard: '守人', witch: '用药', hunter: '开枪',
    speak: '发言', vote: '投票', ghost: '代笔',
    // 警长每天多出来的那一笔（见 sheriffOrder）。不登记的话这条笔记在提示词里会落成
    // 默认的「判断」，与投票那一次记的分不出来——他多做的那个动作就白写了
    order: '定次序'
};

function noteHead(note) {
    const day = NIGHT_KINDS.has(note.kind) ? '夜' : '天';
    return `第 ${note.round || 1} ${day}·${NOTE_KIND_LABEL[note.kind] || '判断'}`;
}

/* ---- 白天的发言秩序 ----
 * 秩序不是策略：这一轮每人只说一次、按次序挨个说、出局的人不再开口——
 * 这些不该由角色的「水平」决定，所有座位无条件拿到（策略知识才归手册）。
 * 次序本身随这一桌的规矩变（可能从座号最小的人起，也可能从死者的下家/上家起，见引擎 speakOrderSeats），
 * 但这件事照旧不是策略：**这一桌怎么定的、这一轮从谁起，所有人都一样地知道**。
 */

/**
 * 这一轮轮得到谁、谁已经说完了。
 * 实测症状：靠后的发言者会说「想听 3 号再说说」——他不知道 3 号这一轮已经说完，
 * 等不到回应；这里给他秩序事实 + 「要追问就往下轮压」这个唯一可行的说法。
 * 只读公开信息（spokeThisRound + 存活名单），别人的私有数据一个字都不进来。
 */
function speakOrderBlock(session, seatNo) {
    // 竞选那两拍另有一套次序（台上的人各说一轮，见 sheriffOrderBlock），别拿白天的次序混进去
    if (session?.phase === 'day_sheriff_speak' || session?.phase === 'day_sheriff_pk') {
        return sheriffOrderBlock(session, seatNo);
    }
    if (session?.phase !== 'day_speak') return '';
    const spoke = new Set(session.spokeThisRound || []);
    // 次序按**这一轮真正在用的那一份**（这一桌选了死左/死右，起点就不是 1 号了，见引擎的 speakOrderSeats）
    const order = speakOrderSeats(session);
    const done = order.filter(n => spoke.has(n));
    const after = order.filter(n => !spoke.has(n) && n !== seatNo);
    const names = list => list.map(n => {
        const s = seatAt(session, n);
        return `${s.seat} 号 ${s.name}`;
    }).join('、');

    return [
        `【这一轮的发言秩序】${speakOrderLine(session)}，每人这一轮只说一次；出局的人不再发言、不再投票。`,
        done.length
            ? `已经说过的：${names(done)}——他们这一轮不会再开口，你追着问也等不到回应；要压谁就直说，或者说明「下一轮要他讲清楚」。`
            : '你是这一轮第一个说的：前面还没人开口，不会有人当场接你的话，要等下一轮。',
        after.length
            ? `还没轮到（在你之后）：${names(after)}。`
            : '你是这一轮最后一个说的：你之后直接进投票，本轮不会再有发言了。'
    ].join('\n');
}

/**
 * 竞选的秩序块（警上发言 / 平票后加说一轮）：台上这几位按掷出来的次序各说一次。
 * 与白天那份**刻意不同**：这一轮说话的人只有台上几位、台下不开口，
 * 而且说完就进投票——所以不写「出局的人不再发言」那套，只报次序与进度。
 */
function sheriffOrderBlock(session, seatNo) {
    const pk = session.phase === 'day_sheriff_pk';
    const spoke = new Set((pk ? session.sheriffPk?.spoke : session.sheriffStage?.spoke) || []);
    const order = sheriffSpeakOrderSeats(session);
    const done = order.filter(n => spoke.has(n));
    const after = order.filter(n => !spoke.has(n) && n !== seatNo);
    const names = list => list.map(n => {
        const s = seatAt(session, n);
        return `${s.seat} 号 ${s.name}`;
    }).join('、');

    return [
        `【这一轮的发言秩序】${pk
            ? '你们几位刚才同票，现在按次序各再说一轮，说完由台下没上台的人补投'
            : '现在是上警发言：台上这几位按次序各说一次，说完由没上警的这些人投票选警长'}；`
        + '这一轮说话的就是台上这几位，台下不开口。',
        done.length
            ? `已经说过的：${names(done)}——他们这一轮不会再开口。`
            : '你是台上第一个说的：前面还没人开口。',
        after.length
            ? `还没轮到（在你之后）：${names(after)}。`
            : '你是台上最后一个说的：你之后直接进投票，本轮不会再有发言了。'
    ].join('\n');
}

/* ---- 视角块 ---- */

/**
 * 这个座位此刻知道的事：自己（身份/阵营/同伴/验人记录）+ 公开场上信息 +
 * 自己对在场者的私人认知 + **它自己**此前贴的判断 + 它自己的狼人杀档案。
 * 公开那一段各座位逐字一致（都是 publicFeed 出来的）。
 * @param {object} [record] 这个座位**自己**的档案（由调用点先 await loadCodex 取好，见那里的说明）
 */
function viewBlock(session, seatNo, record = null) {
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
    // 它自己那份判断表（读侧归一在引擎 labelsOf：老数据、不在这一桌词表里的标签都在那儿清掉）
    const labelLine = labelLineOf(session, seatNo);
    // 笔记只读**它自己**那一份：狼队批量调用时，每只狼的块里只有它自己写过的东西
    const myNotes = (session.aiNotes || {})[seatNo] || [];
    // 手册：只装**它自己**点亮的条目（路人固定拿通用基础那一档，见 werewolfCodex）
    const codexText = codexBlock(record, { isGuest: seat.kind === 'npc', roomScope: session.typeId });
    const order = speakOrderBlock(session, seatNo);

    return [
        '【你】',
        selfCard(mine),
        `你的身份：${view.roleLabel}（${view.faction === 'wolf' ? '狼人阵营' : '好人阵营'}）`,
        view.faction === 'wolf' ? '你是狼人：白天要装成好人，别把同伴供出去；夜里你和同伴一起决定刀谁。' : '',
        view.teammates?.length ? `你的狼同伴：${view.teammates.map(t => `${t.seat} 号 ${t.name}`).join('、')}` : '',
        view.checks?.length
            ? `你验过的人：\n${view.checks.map(c => `- 第 ${c.round} 夜 ${c.seat} 号 ${c.name}：${c.isWolf ? '狼人' : '好人'}`).join('\n')}`
            : '',
        view.guarded?.length
            ? `你守过的人：\n${view.guarded.map(g => `- 第 ${g.round} 夜 ${g.seat} 号 ${g.name}`).join('\n')}`
            : '',
        // 女巫：手里还剩什么药、以及**每一夜被告知过的刀口**——她夜里听过就永远记得（白天也照样有牌可打）
        view.role === 'witch'
            ? [
                `你的药：解药${view.potions?.heal ? '还在' : '已经用掉了'}、毒药${view.potions?.poison ? '还在' : '已经用掉了'}；同一夜只能用一瓶，不能毒自己。`,
                view.witchLog?.length
                    ? `你夜里的记录：\n${view.witchLog.map(w => `- 第 ${w.round} 夜：${w.told === false
                        ? '法官没有告诉你刀口（你的解药已经用掉了，之后也不再告诉你）'
                        : (w.killed ? `${w.killed} 号 ${w.killedName} 被刀` : '没有人被刀')}`
                        + `${w.saved ? '，你用了救药' : ''}${w.poisoned ? `，你毒了 ${w.poisoned} 号 ${w.poisonedName}` : ''}`).join('\n')}`
                    : '',
                view.tonight ? `今晚狼刀的是 ${view.tonight.seat} 号 ${view.tonight.name}。` : ''
            ].filter(Boolean).join('\n')
            : '',
        // 猎人只多知道一件事：自己被刀了没有（法官叫醒他才会说这一句）
        view.role === 'hunter' && view.knifed ? '你今晚被狼刀了，天亮就会出局。' : '',
        // 白痴翻过牌之后：全桌都知道他是谁了，他还能说话、还能被狼刀，就是没有票、也不会再被投出去
        view.flipped
            ? '你已经翻过牌，全桌都知道你是白痴：你还能发言、夜里照样会被狼杀，但你没有投票权，'
                + '别人也不会再投你，警徽也接不到你手里（传给你不算数）。'
            : '',
        // 他戴着警徽。**警徽是公开信息**（谁在任全场都知道，撕没撕也当场报过），写进来不违红线；
        // 这里只说这一桌的规矩与他的处境，怎么用徽是策略，归手册
        isSheriff(session, seatNo)
            ? seatAt(session, seatNo)?.flipped === true
                // 翻过牌的警长：徽还在他手里，但**立马就得交出去**（这一拍就是来问这个的）
                ? '你现在还戴着这一局的警徽，但你翻过牌了：你手里没有票，警徽也不能留在你手里——'
                    + '得当众交给一个还有票的人，或者当场撕掉。'
                : '你现在是这一局的警长：你的票按 1.5 票算；每天天亮由你定从警左还是警右开口；'
                    + '你出局时要把警徽交给一个还有票的人，或者当场撕掉。'
            : '',
        '',
        // **手册与秩序一起排在流水之前**（2026-09-16 挪位，用户实测提出）。
        // 原先秩序块压在数组末位——也就是整个 system 的最后一行，而它自己的最后一行是
        // 「还没轮到（在你之后）：7 号 C、9 号 D」。模型开口前读到的最后一句就是一张后置位
        // 名单，于是发言的后半段老是挨个点名后面的人。
        // **名单本身留着**（想压后置位是正当打法，那是个真事实），只是不再占「最后一行」这个位子；
        // 手册是「他一贯懂的东西」，与此刻的秩序同属背景，跟着一起挪过来。
        // ⇒ 现在离发言题面最近的是流水，以及他自己那两笔账（判断 / 笔记）。
        codexText ? `\n${codexText}` : '',
        order ? `\n${order}` : '',
        // 自带「【场上】存活：…」这一段。**按人截**（2026-09-13 起）：流水不再人人逐字一致，
        // 同一个座位能记住多少由它的悟性定（watchPlan），自己说的和当时盯着的人的话不砍
        publicFeed(session, { viewer: seatNo, tail: watchPlan(record).tail }),
        knowledge ? `\n【你对在场各人的了解】\n${knowledge}` : '',
        // 「之前」写在抬头里：这一块是**此前记下的一笔账**，不是这一轮定下的结论——
        // 谁在它眼里变了就写新的盖掉，写 `取消` 就能把这个人划掉（用户 2026-09-14）
        labelLine ? `\n【你之前对场上这些人的判断】（你此前一轮轮记下来的，随时可以改）\n${labelLine}` : '',
        myNotes.length
            ? `\n【你自己之前记的笔记】\n${myNotes.map(n => `- ${noteHead(n)}：${n.text}`).join('\n')}`
            : ''
    ].filter(Boolean).join('\n');
}

/** 玩家的口吻提示（语气按房间分类走） */
function toneLine(type) {
    return type?.tone ? `这一桌的气氛：${type.tone}。` : '';
}

/**
 * 对局内 6 处调用共用的**唯一** system 头积木。
 * 正文与措辞纪律都在 `roleHeadText`（werewolfRooms.js，纯函数、零 import、A 段整段测得到）——
 * 要加东西加在那里，别在这个文件里拼字符串。这里只负责把模板库的同步缓存递进去。
 */
function roleHead(session) {
    return roleHeadText(session, cachedRuleTemplates());
}

/* ---- 发言 ---- */

const FALLBACK_SPEECHES = [
    '我先听听大家怎么说，暂时没有别的想法。',
    '我这边没什么信息，跟大多数人的判断走吧。',
    '我暂时看不出谁是狼，先不给人乱扣帽子。',
    '今天先过一轮吧，我保留意见。',
    '我是好人，没有什么要辩解的。'
];

/** 上警发言的模板台词：这一轮要当着全桌争取那张票，说法与白天发言不是一回事 */
const FALLBACK_CANDIDATE_SPEECHES = [
    '我上警是想给好人带个方向：拿到警徽我会把发言次序定清楚，也不乱归票。',
    '我先说我的想法：这一轮发言里我觉得最可疑的是后置位，警徽给我，我会盯着继续盘。',
    '我上警不是为了抢话，是怕好人这一轮投散了——票集中在我身上，出了事我认。',
    '我的身份很干净，警徽交给我比交给一个说半天没立场的人稳妥。',
    '我这一轮就想听清楚每个人站谁的边，警徽在我手里，我会把问题一个个问过去。'
];

/** 竞选平票后再加说一轮：台上几位同票，说的是「为什么该补投给我」 */
const FALLBACK_PK_SPEECHES = [
    '我和他票一样多，说明这桌一半的人信我：那就把票补给我，我不会乱用这枚徽。',
    '刚刚那一轮我该说的都说了，现在只补一句——票给我，方向我来定，错了我担着。',
    '台上这几位里我最有把握带好人，补投这一票别弃。',
    '我们俩票数一样，你们不投我就等于让这一局没有警长，那对好人更亏。'
];

/**
 * 模板台词（无 key / 连续失败时用），按座位取，稳定不随机。
 * 上警那一轮另有说法（这一轮是来争票的，与白天的泛泛而谈不是一回事），照阶段分三套。
 */
export function fallbackSpeech(seatNo, phase = '') {
    const pool = phase === 'day_sheriff_pk' ? FALLBACK_PK_SPEECHES
        : (phase === 'day_sheriff_speak' ? FALLBACK_CANDIDATE_SPEECHES : FALLBACK_SPEECHES);
    return pool[(Math.max(1, seatNo) - 1) % pool.length];
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
    const fallback = { text: fallbackSpeech(seatNo, session.phase), marks: {}, note: '', degraded: true };
    if (modeOf(session) === 'template') return { ...fallback, reason: 'template' };

    const record = await loadCodex(seatAt(session, seatNo));
    const cap = watchPlan(record).watch;
    const systemPrompt = [roleHead(session), '', viewBlock(session, seatNo, record)].join('\n');
    const userContent = [
        `轮到你发言了。${toneLine(type)}`,
        // PK 发言与白天发言共用这一次调用，只在题面上多一句限定（调用点因此不必分两处）
        session.phase === 'day_pk' ? '现在是 PK 发言：你们几位票数相同、都站在台上，台下的票还没投——'
            + '为自己辩白，或者指认台上另一个人更像狼。台上其他人的发言你也听得到。' : '',
        // 上警发言：这一轮台下没上警的人马上要投票选警长，说的是「为什么把徽给我」
        session.phase === 'day_sheriff_speak' ? '现在是你的上警发言：这一轮台上只有你们几位在说，'
            + '说完之后，没上警的那些人要在你们当中投票选警长——所以这一段是说给他们听的。'
            : '',
        // 竞选平票后的加说一轮：还是台上这几位，台下补投
        session.phase === 'day_sheriff_pk' ? '现在是竞选平票后的加说一轮：你们几位刚才票数相同、都站在台上，'
            + '台下没上台的人马上要在你们当中补投一次——再平票这一局就没有警徽了。' : '',
        `请说一段自然的话（不超过 ${limit} 字）：可以表态、可以怀疑谁、可以解释自己，也可以顺着你之前的判断说。`
        // 防「雷同螺旋」（用户 2026-09-13 提）：一桌人轮流读同一份流水，最容易越说越像。
        // 写法是**给许可 + 指他自己手里有的东西**（这一轮的视角、他的笔记、他的人设），
        // 不写「别跟别人一样」——那等于把「跟别人一样」这个词塞到它眼前（同日提示词教训）。
        + '用你自己的角度说这一段：你这一轮看到了什么、你最在意谁、你心里那笔账是怎么算的——'
        + '同一件事各人有各人的讲法，你可以跟别人说得不一样。',
        '只写你说出口的话，不要写「XX 说：」这样的前缀。',
        '',
        session.phase === 'day_sheriff_speak'
            ? '最后另起几行，可选地写下此刻的判断、一句给自己留的笔记、你要重点盯谁，以及**你要不要退水**（不写的行就都空着），格式必须完全一致：'
            : '最后另起几行，可选地写下此刻的判断、一句给自己留的笔记，和你要重点盯谁（没有就不写那行），格式必须完全一致：',
        '【判断】3号=狼人 5号=存疑',
        '【笔记】私下记的一句话',
        '【关注】3号 5号',
        // 退水：只有上警发言那一拍才问（平票加说那一轮已经退不了了，台上就剩这几位）
        session.phase === 'day_sheriff_speak' ? '【退水】' : '',
        `（判断的标签只能用：${markTagsOf(session).join('、')}；这只是你自己记的一笔账，一个人一个标签——`
        + '写到谁就是改他那一条、没写到的人维持原样，想撤掉对某个人的判断就写 `7号=取消`；'
        + '笔记不会给别人看，是你自己的复盘素材；'
        + `【关注】是你接下来要重点盯的人——你只盯得住 ${cap} 个，没盯上的人说过的话你后面会渐渐记不清；`
        + '写座号或名字都行，**写了这一行就是重新定一张表、只留你写上的这几个，不写才维持你现在盯的人**'
        + (session.phase === 'day_sheriff_speak'
            ? '；【退水】那一行是你要不要退出竞选——想退就写「退」两个字，不退就整行都别写。'
                + '退了水你就不争这个警徽了，这一轮的票也没有你的（平票之后的补投你还能投）'
            : '') + '）'
    ].join('\n');

    try {
        const raw = await callAI({
            systemPrompt, userContent,
            temperature: 0.95,
            label: '狼人杀 · 一位发言',
            presetId: presetOfSeat(session, seatNo)
        });
        const parsed = parseSpeakReply(raw, session);
        // 退水是上警发言那一拍才认的（其余阶段这一行即使写出来也一律作废）
        if (session.phase !== 'day_sheriff_speak') parsed.withdraw = false;
        if (!parsed.text) throw new Error('空回复');
        return { ...parsed, watch: watchSeats(parsed.watchText, session, seatNo, cap), degraded: false };
    } catch (e) {
        return { ...fallback, reason: e.message || String(e) };
    }
}

/**
 * `【关注】` 那一行 → 这个座位真的能盯的人（活人、不含自己、最多 cap 个）。
 * **没写这一行（或写了却没点出人来）返回 undefined = 维持原样**——不写是常态，
 * 别让「这轮没提」被当成「谁都不盯了」。
 *
 * 座号与名字的认法在引擎里（parseWatchTargets，与 @ 点名同一套），这里只管
 * 「这一桌上还有谁能盯」；导出是为了让 A 段能在不开网络的地方验这一层。
 */
export function watchSeats(line, session, seatNo, cap = Infinity) {
    if (!line) return undefined;
    const live = new Set(aliveSeats(session).map(s => s.seat));
    const ids = parseWatchTargets(line, session).filter(n => n !== seatNo && live.has(n));
    return ids.length ? ids.slice(0, cap) : undefined;
}

/**
 * 发言解析：正文 + 可选的【判断】行、【笔记】行、【关注】行、【退水】行（标记行都从正文里剔掉）。
 * 返回 `watchText` 是**那一行的原文**（没写就是 null）：转成座号要这一桌的座位表，
 * 那是调用方的事（这里保持纯解析，照 parseMentions 在引擎里、解析在解析层的分工）。
 *
 * `withdraw` **只有上警发言那一拍有意义**（调用点负责在别处把它清成 false，见 speakCharacter）：
 * 认「退」这一个字，但要排除「不退」「不打算退」这类否定——整行没东西也算没写。
 */
export function parseSpeakReply(raw, session = null) {
    const text = String(raw || '');
    const judge = text.match(/【判断】\s*([^\n]*)/);
    const marks = parseMarks(judge?.[1] || '', session);   // 词表跟着这一桌的板子走
    const note = String((text.match(/【笔记】\s*([^\n]*)/) || [])[1] || '').trim();
    const watch = text.match(/【关注】\s*([^\n]*)/);
    const quit = String((text.match(/【退水】\s*([^\n]*)/) || [])[1] || '').trim();
    // 「不退」「继续上警」「不」都算不退；空行（只写了标记、没写内容）也算不退
    const withdraw = /退/.test(quit) && !/不\s*退|不退|继续|接着争|不参/.test(quit);
    const body = text
        .replace(/【判断】[^\n]*/g, '')
        .replace(/【笔记】[^\n]*/g, '')
        .replace(/【关注】[^\n]*/g, '')
        .replace(/【退水】[^\n]*/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return {
        text: stripQuotes(body), marks, note, withdraw,
        watchText: watch ? String(watch[1] || '').trim() : null
    };
}

/* ---- 遗言 ---- */

/**
 * 一次调用 = 一位出局者的遗言。
 *
 * 与 speakCharacter **刻意不同**：那一版的口径是「你在装、别露身份」（活人还得接着打），
 * 一个已经出局的人照那个口径说，等于白留一段遗言。这里是最后一段公开话，所以放开手脚：
 * 可以摊牌、可以报验人结果或用药、可以点名、可以给活人留话；字数也比平时宽一点。
 *
 * 这也是**夜里被刀的猎人在「猎人」那一拍顺手写好**的那段话（`session.wordsDraft`）：
 * 公布死讯、轮到他时直接取用，不再打一次调用（按次数计费，能省一次是一次）。
 * 有上警阶段的板子不走这条捷径——他要等竞选之后再自己说（见 engine.draftsWordsAtNight）。
 *
 * **他是在任警长时，这一次调用顺手把警徽的去向也定了**（用户 2026-09-15 定：同一次 AI 调用）——
 * 与上面那条「顺手把遗言写好」是同一个 idiom，只是方向相反：这次顺手定的是身后事。
 * 于是 `badge_wait` 那一拍不再打 AI，只是把定好的去向当众走一遍（见 UI 的 badgeWalkThrough）。
 * 返回里带不带 `badgeTarget` 是有讲究的：**没有这个键 = 他不是警长 / 他没答**（那一拍自己再问），
 * **键在而值是 null = 他要当场撕掉**（不可逆，只有他明说了才算）。
 * @returns {Promise<{text:string, badgeTarget?:number|null, degraded:boolean, reason?:string}>}
 */
export async function lastWords({ session, seatNo, type }) {
    const limit = Math.round((type?.speechLimit || 120) * 1.5);
    const fallback = { text: fallbackSpeech(seatNo), degraded: true };
    if (modeOf(session) === 'template') return { ...fallback, reason: 'template' };

    // 警徽的去向只问他一个人（他是在任警长才有这一问），合法集是引擎那一份
    const badge = isSheriff(session, seatNo);
    const legal = badge ? badgeTargets(session, seatNo).map(s => s.seat) : [];

    const record = await loadCodex(seatAt(session, seatNo));
    const systemPrompt = [roleHead(session), '', viewBlock(session, seatNo, record)].join('\n');
    const userContent = [
        '你已经出局了，现在轮到你留遗言——这是你这一局最后一段公开的话。',
        toneLine(type),
        '想说什么都行：亮出你的身份、报出你夜里的验人或用药、点名你认定的狼、',
        `给活着的人留一句话。不用再藏着掖着了（不超过 ${limit} 字）。`,
        badge
            ? `你还是这一局的警长，顺带把警徽的去向定下来：交给一个还有票的人（${legal.join('、')} 号），或者当场撕掉。`
                + '写完遗言之后另起一行写你的决定，格式必须完全一致：【警徽】5号　或者　【警徽】撕掉'
            : '只写你说出口的话，不要写「XX 说：」这样的前缀，也不要写任何标记行。'
    ].filter(Boolean).join('\n');

    try {
        const raw = await callAI({
            systemPrompt, userContent,
            temperature: 0.95,
            label: '狼人杀 · 遗言',
            presetId: presetOfSeat(session, seatNo)
        });
        const text = parseLastWordsReply(raw);
        if (!text) throw new Error('空回复');
        if (!badge) return { text, degraded: false };
        const pulled = pullBadgeLine(text, legal);
        // 没写这一行就不带 `badgeTarget` 这个键——调用方（UI）靠键在不在决定要不要存草稿
        return pulled.badgeTarget === undefined
            ? { text: pulled.text, degraded: false }
            : { text: pulled.text, badgeTarget: pulled.badgeTarget, degraded: false };
    } catch (e) {
        return { ...fallback, reason: e.message || String(e) };
    }
}

/**
 * 警徽去向的**三档判据**：遗言里的【警徽】行与白天补枪那一拍的 JSON `badge` 栏共用这一份
 * （两处都是「他顺口把身后事一起答了」，判法必须一模一样，不然同一句话在两个入口会落成两种结果）。
 * - 数字且在合法集里 = 他明说交给谁
 * - 明写「撕」字 = `null`，当场撕掉（不可逆，所以**只认明说**）
 * - 其余（认不出的座号、空、压根没写、JSON 里的 null）= `undefined` = 他没答 → 那一拍自己再定
 *
 * ⚠️ 认不出**绝不等于撕**：与 parseBadgeReply 的 `torn` 闸同一个精神（那一版问的是另一形状的题，
 * 判据留在它自己那儿）。别处不许再写第四份。
 */
function pickBadgeValue(v, legal = []) {
    const said = String(v ?? '').trim();
    const n = Number((said.match(/(\d{1,2})/) || [])[1]);
    if (legal.includes(n)) return n;
    return /撕/.test(said) ? null : undefined;
}

/**
 * 从遗言正文里摘出【警徽】那一行（只有**在任警长**的遗言才有这一行）。
 * 返回值那三档见 pickBadgeValue；正文里一个字都不留。
 */
export function pullBadgeLine(raw, legal = []) {
    const text = String(raw || '');
    const line = text.match(/【警徽】\s*([^\n]*)/);
    const body = stripQuotes(text.replace(/【警徽】[^\n]*/g, '').replace(/\n{3,}/g, '\n\n').trim());
    if (!line) return { text: body, badgeTarget: undefined };
    return { text: body, badgeTarget: pickBadgeValue(line[1], legal) };
}

/**
 * 遗言解析：只取正文（剥掉引号那一步与发言同一套），**不认【判断】【笔记】【关注】那几行**——
 * 那三行都是「还要接着打的人改自己的表」用的，出局的人改不动任何表；
 * 他若照着发言的习惯写了，也只当正文里的字，别顺手当成有效指令。
 */
export function parseLastWordsReply(raw) {
    return stripQuotes(String(raw || '').trim());
}

/* 【判断】那一行的认法在引擎里（`parseMarks`，与 `parseWatchTargets` 同一个地方）：
 * 词表、简写、撤掉的写法都只有那一份，别在这里再抄一套。
 */

/* ---- 投票 ---- */

/**
 * 一次调用 = 一位角色投票。**四个落点共用这一次调用**（合法集各有各的算法，都是引擎给的那一份）：
 * 白天的放逐票、PK 台上那一轮的补投票、警长板第一天**警下投票**（只有没上警的人走到这一拍）、
 * 以及竞选一次平票之后的**补投**（选民含退过水的人）。
 * 竞选那一轮只是题面不同——JSON 契约一字不变，所以 parseVoteReply 也不必分叉：
 * 票、理由、笔记、心声、判断表、关注表，六样照样一次拿回来（顺带把第一天的表初始化了一遍）。
 * @returns {Promise<{vote:number|null, reason:string, note:string, heart:string, marks:Object, degraded:boolean, reason?:string}>}
 *   vote 只可能是「场上的活人（不含自己）」或 null（弃票/认不出）——脏目标一律收成弃票
 *   heart 是这次投票的副产物（没说出口的那句话），存进 session.aiHearts，**不进任何提示词**
 */
export async function voteCharacter({ session, seatNo, type }) {
    // PK 台上那一轮只能投台上的人（投台下的人等于把这一轮又摊开重来），其余照旧。
    // 与界面芯片、引擎校验仍是同一份合法集（翻过牌的白痴不再被放逐）
    const election = session.phase === 'day_sheriff';          // 警下投票：只有没上警的人走到这儿
    const pkSheriff = session.phase === 'day_sheriff_pk_vote'; // 竞选平票的补投：选民含退过水的人
    const pk = session.phase === 'day_pk_vote' ? session.pk : null;
    const legal = (election ? sheriffCandidates(session, seatNo)
        : pkSheriff ? sheriffPkVoteTargets(session)
            : (pk ? pkVoteTargets(session) : voteTargets(session, seatNo))).map(s => s.seat);
    // 模板模式（无 key）在竞选这两拍**必须照样投出一个真人**：全场弃票 = 没有警长 = 这个板子白做，
    // 而「选警长」本来就是一件全桌都有共识的事（不像刀人验人非要有判断）。
    // 其余两拍弃票仍然是对的：没人可投、或者干脆不想投，都是合法结局。
    const fallback = {
        vote: election || pkSheriff ? templateSheriffPick(session, seatNo) : null,
        reason: '', note: '', marks: {}, degraded: true
    };
    if (!legal.length || modeOf(session) === 'template') return { ...fallback, reason: 'template' };

    const record = await loadCodex(seatAt(session, seatNo));
    const cap = watchPlan(record).watch;
    const systemPrompt = [roleHead(session), '', viewBlock(session, seatNo, record)].join('\n');
    const userContent = [
        election ? `现在选警长：上警的人已经各说了一轮，轮到你们没上警的人投票。${toneLine(type)}`
            : pkSheriff ? `竞选平票了，现在补投一轮。${toneLine(type)}`
                : `投票时间。${toneLine(type)}`,
        election
            ? `你要在他们当中选一个人当警长——他这一局的票算 1.5 票，每天天亮由他定从谁开口，`
                + `他出局时还要把警徽交出去或撕掉。可以投的座位：${legal.join('、')} 号。`
                + `弃票也可以，但那一票就等于白过（票数最高的那位当选）。`
            : pkSheriff
                ? `台上这几位刚才同票，现在由你们台下的人在他们当中补投一次。只能投：${legal.join('、')} 号，或者弃票。`
                    + `再平票这一局就没有警徽了。`
                : pk
                    ? `台上这几位刚才同票，现在由你们台下的人在他们当中补投一次。只能投：${legal.join('、')} 号，或者弃票。`
                    : `你要投一个人出局，或者弃票。可以投的座位：${legal.join('、')} 号。`,
        '输出 JSON，不要任何别的文字：',
        '{"vote":座位号(数字，弃票写 null),"reason":"一句话理由","note":"你自己私下记的一句话","heart":"投这一票时心里冒出来的那句话","marks":{"座位号":"标签"},"watch":[重点盯的座位号]}',
        // 心声（用户 2026-09-13 提）：投票那一刻没说出口的那句话，**今天只写不读**（见引擎 addHeart）。
        // 刻意**不给限制**——用户明确「不需要完全要求真」，就是当轮的一个阶段性内心想法：
        // 犹豫、嘴硬、说错了都行，不必跟 reason 一致。加了「要真实」「别暴露身份」反而
        // 既毁掉味道，又把身份两个字塞到它眼前（同日「不设警长」那条教训）。
        // **长度也一样不给限制**（用户 2026-09-14 定）：原来写「一句就够」，现在按他说的
        // 「根据每个角色的性格来走，从一句话到一长串都有可能；内容从游戏到投票到发言到场外
        // 发散都有可能」——所以只**给范围**（写出来的是"可能是"），不写「可以写长一点」那种
        // 叮嘱：叮嘱一样是往它眼前塞一个「长度」的念头。引擎那边同步去掉了 80 字硬截。
        `（note、heart 与 marks 可省略；heart 就是你投完这一票时心里冒出来的那句话——`
        + `多长看你这个人此刻是什么状态：可能就一句，也可能是一长串，这一票、场上这些人、`
        + `谁刚说的那句话、甚至跟这一局没关系的什么，想到哪儿是哪儿；`
        + `不必跟 reason 一个说法，也不需要多正确；marks 的标签只能用：${markTagsOf(session).join('、')}，`
        + '那只是你自己记的一笔账，一个人一个标签——写到谁就是改他那一条、没写到的人维持原样，'
        + '想撤掉对某个人的判断就把那一栏写成 null；'
        + `watch 是接下来你要重点盯的人——你只盯得住 ${cap} 个，没盯上的人说过的话你后面会渐渐记不清；`
        + '**写了这一栏就是重新定一张表、只留你写上的这几个，不写才维持你现在盯的人**）'
    ].join('\n');

    try {
        const raw = await callAI({
            systemPrompt, userContent,
            temperature: 0.85,
            label: '狼人杀 · 一次投票',
            presetId: presetOfSeat(session, seatNo)
        });
        return { ...parseVoteReply(raw, legal, { cap, session }), degraded: false };
    } catch (e) {
        return { ...fallback, reason: e.message || String(e) };
    }
}

/**
 * 投票解析：JSON 优先，认不出就退到「投 N 号」的字面匹配，仍认不出算弃票。
 * `watch` 用与投票同一张白名单（活人、不含自己）；**没这个字段返回 undefined = 维持**。
 * `heart`（心声）不验收也不过滤：它不进任何提示词，写什么就是什么（见引擎 addHeart）。
 * `marks` 那一栏**原样交给引擎的 mergeLabels** 归一（词表只有那一个门口）：JSON 里
 * 写 null / 空串 = 撤掉，写数组（老写法）按最后一个算；认不出的整条丢掉。
 */
export function parseVoteReply(raw, legal = [], { cap = Infinity, session = null } = {}) {
    const pickWatch = obj => {
        const list = Array.isArray(obj?.watch) ? obj.watch : null;
        if (!list) return undefined;
        const ids = [...new Set(list.map(Number).filter(n => legal.includes(n)))].sort((a, b) => a - b);
        return ids.length ? ids.slice(0, cap) : undefined;
    };
    const pick = obj => ({
        vote: legal.includes(Number(obj?.vote)) ? Number(obj.vote) : null,
        reason: String(obj?.reason || '').trim(),
        note: String(obj?.note || '').trim(),
        heart: String(obj?.heart || '').trim(),
        marks: typeof obj?.marks === 'string' ? parseMarks(obj.marks, session) : (obj?.marks || {}),
        watch: pickWatch(obj)
    });
    const text = String(raw || '');
    try { const obj = JSON.parse(text); if (obj && typeof obj === 'object') return pick(obj); } catch { }
    try {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) { const obj = JSON.parse(m[0]); if (obj && typeof obj === 'object') return pick(obj); }
    } catch { }
    const said = text.match(/(?:投|票给|出局)\s*(\d{1,2})\s*号/);
    const vote = said && legal.includes(Number(said[1])) ? Number(said[1]) : null;
    return { vote, reason: stripQuotes(text.split('\n')[0] || ''), note: '', heart: '', marks: parseMarks(text, session) };
}

/* ---- 上警表态 ---- */

/**
 * 一次调用 = 一位角色「要不要上警」。
 *
 * **刻意不塞进 voteCharacter**：那一支明写着「JSON 契约一字不变」（选警长、放逐、PK 补投
 * 三处共用），而 `run` 是一个布尔——塞进 `vote` 那一栏会让两边都变形。这里另起一次调用，
 * 但**六样契约照旧**（票改成一栏 run）：理由、笔记、心声、判断表、关注表一样不落，
 * 顺带把第一天的表初始化一遍（与选警长那一轮同一个理由）。
 *
 * 上警的代价必须写清楚（不然模型只会照「要不要出风头」来答）：上了警这一轮就没有投票权，
 * 但进了台上才有资格拿徽；警徽是 1.5 票 + 每天定发言方向。
 * @returns {Promise<{run:boolean, reason:string, note:string, heart:string, marks:Object, degraded:boolean, reason?:string}>}
 */
export async function declareCandidacy({ session, seatNo, type }) {
    // 模板模式必须给出一个稳定的答案：**认不出也退到模板**，绝不能收成「不上警」——
    // 模板局全体不上警 = 这个板子白做（与 templateSheriffPick 同一个理由）。
    const fallback = {
        run: templateSignup(seatNo),
        reason: '', note: '', marks: {}, degraded: true
    };
    if (modeOf(session) === 'template') return { ...fallback, reason: 'template' };

    const record = await loadCodex(seatAt(session, seatNo));
    const cap = watchPlan(record).watch;
    const systemPrompt = [roleHead(session), '', viewBlock(session, seatNo, record)].join('\n');
    const userContent = [
        `现在上警表态。${toneLine(type)}`,
        '这一局要选警长：拿到警徽的人这一局的票算 1.5 票，每天天亮由他定从谁开口说话，'
        + '他出局时还要把警徽交给别人或撕掉。',
        '上警的意思：你会站到台上，先当着全桌说一轮；台上的人**这一轮没有投票权**，'
        + '但只有台上的人能当选。没上警的人这一轮都有一票，在台上的人里选一个。',
        '全体一个一个表态，**每人只有一次机会、说了就不能改**；大家是同时举手、同时公布的，'
        + '所以别指望看到别人举不举手再决定。',
        '你要不要上警？想上就上，不想上就不上，这是你自己的判断：上警可能拿到警徽带队，也可能白送一轮发言；'
        + '不上警就安稳拿一票。',
        '输出 JSON，不要任何别的文字：',
        '{"run":true,"reason":"一句话理由","note":"你自己私下记的一句话","heart":"这一刻心里冒出来的那句话","marks":{"座位号":"标签"},"watch":[重点盯的座位号]}',
        `（run 只能写 true 或 false：true＝上警，false＝不上警；note、heart、marks、watch 可省略；`
        + `heart 是你此刻心里冒出来的那句话，多长看你这个人是什么状态，不必跟 reason 一个说法；`
        + `marks 的标签只能用：${markTagsOf(session).join('、')}，一个人一个标签，不写的人维持原样；`
        + `watch 是你接下来要重点盯的人——你只盯得住 ${cap} 个，写了这一栏就是重新定一张表、只留你写上的这几个）`
    ].join('\n');

    try {
        const raw = await callAI({
            systemPrompt, userContent,
            temperature: 0.85,
            label: '狼人杀 · 一次上警表态',
            presetId: presetOfSeat(session, seatNo)
        });
        const parsed = parseDeclareReply(raw, { cap, session });
        if (parsed.run == null) throw new Error('认不出上不上警');
        return { ...parsed, degraded: false };
    } catch (e) {
        return { ...fallback, reason: e.message || String(e) };
    }
}

/**
 * 上警表态的解析：JSON 优先，认不出再扫字面。
 * **认不出返回 run:null**（不是 false）——调用方据此退到模板兜底（见 declareCandidacy 的说明）。
 * 字面兜底里「不上警」必须先判：只扫「上警」两个字会把否定读成肯定，那一票就成了反的。
 * `watch` 用「这一桌还有谁能盯」（活人、不含自己）当白名单；没这一栏返回 undefined＝维持。
 */
export function parseDeclareReply(raw, { cap = Infinity, session = null } = {}) {
    const live = new Set(aliveSeats(session).map(s => s.seat));
    const asBool = v => {
        if (v === true || v === false) return v;
        const s = String(v ?? '').trim().toLowerCase();
        if (['true', '1', '是', '上', '上警', '要', 'yes'].includes(s)) return true;
        if (['false', '0', '否', '不上警', '不上', '不', 'no'].includes(s)) return false;
        return null;
    };
    const pickWatch = obj => {
        const list = Array.isArray(obj?.watch) ? obj.watch : null;
        if (!list) return undefined;
        const ids = [...new Set(list.map(Number).filter(n => live.has(n)))].sort((a, b) => a - b);
        return ids.length ? ids.slice(0, cap) : undefined;
    };
    const pick = obj => ({
        run: asBool(obj?.run),
        reason: String(obj?.reason || '').trim(),
        note: String(obj?.note || '').trim(),
        heart: String(obj?.heart || '').trim(),
        marks: typeof obj?.marks === 'string' ? parseMarks(obj.marks, session) : (obj?.marks || {}),
        watch: pickWatch(obj)
    });
    const text = String(raw || '');
    try { const obj = JSON.parse(text); if (obj && typeof obj === 'object') return pick(obj); } catch { }
    try {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) { const obj = JSON.parse(m[0]); if (obj && typeof obj === 'object') return pick(obj); }
    } catch { }
    // 整段没有 JSON：只认不含糊的那几种说法。既要否定词在前，也要「上警」在后面单独出现
    const said = text.split('\n')[0] || '';
    const run = /不上警|不参与|不争|放弃|退出|退水/.test(said) ? false
        : (/上警|竞选|参选/.test(said) ? true : null);
    return { run, reason: stripQuotes(said), note: '', heart: '', marks: parseMarks(text, session), watch: undefined };
}

/* ---- 夜晚：狼刀 / 验人 / 守人 / 用药 / 开枪 ---- */

const NIGHT_ASK = {
    wolf: '你们狼队今晚要刀一个人。',
    seer: '你今晚要验一个人，验出他是好人还是狼人。',
    guard: '你今晚要守护一个人，被守护的人当夜不会被刀；不能连续两夜守同一个人。',
    witch: '你今晚要用药。解药只有一瓶，只能救回今晚被狼刀的那个人；毒药只有一瓶，能毒场上任意一人（不能毒自己）。'
        + '同一夜只能用一瓶药；今晚不想用药，也要明确说不用。',
    hunter: '你今晚被狼刀了，你是猎人：可以开枪带走场上一人，也可以弃枪。'
};

/** 猎人被叫到夜里那一拍、但今晚没被刀：他必须交一次空过（不然全场都在等他），但没什么可决定的 */
const NIGHT_ASK_IDLE = {
    hunter: '今晚没有你的事：你是猎人，没有被狼刀，也没有别的动作。直接回一个「过」就行。'
};

/**
 * 白天补枪那一拍（出局者流程里轮到他）：与夜里那一拍**是同一个技能，话却不是同一句**——
 * 他不是「今晚被狼刀了」，是已经出局、正在走自己的流程（被票出局，或者夜里出局却没在夜里被问过）。
 * ⚠️ 这一拍绝不能沿用 NIGHT_ASK_IDLE 那句「今晚没有你的事」：那会让他以为这一枪不归他开，
 * 白白把技能放掉。判据是**阶段与队列**（`skill_wait` + 队首那条的 act 是 shot），不是夜里的刀口。
 */
const SHOT_ASK = '你已经出局了，现在轮到你发动技能：你是猎人，可以开枪带走场上一人，也可以弃枪。';

/**
 * 一次调用 = 扮演这一夜里**所有非主视角的狼**：每只狼各自的视角入场、各自的行为出场。
 * 每个块只装那一位自己知道的事（本文件头部的红线：批量调用时块与块之间不串信息）。
 * 主视角留在狼队频道的话与他的提案照旧是**一次性入参**：不落 session、不进 events、不进 viewBlock。
 *
 * @param {object} p
 * @param {object} p.session
 * @param {number[]} p.actorSeats 这一夜要 AI 扮演的狼（不含主视角那一位）。
 *   只剩一只时这一拍就是「单个角色」：用那一座绑的预设（托管独狼时那一座是主视角，用主视角的）；两只以上走默认
 * @param {{seat:number, target:number|null, note:string}|null} [p.player] 主视角的提案
 * @returns {Promise<{wolves:Array<{seat:number,target:number|null,reason:string,note:string}>, chat:Array<{seat:number,text:string}>, degraded:boolean, reason?:string}>}
 */
export async function wolfPackAction({ session, actorSeats = [], player = null }) {
    const legal = wolfTargets(session).map(s => s.seat);
    const nameOf = seatNo => seatAt(session, seatNo)?.name || '';
    // 降级（没 key / 连续失败 / 超预算）：不发请求，但照样给每只狼一个刀口，别让这一夜空着
    const template = () => ({
        wolves: actorSeats.map(seat => ({
            seat, target: templateNightTarget(session, 'wolf', seat), reason: '', note: ''
        })),
        chat: [], degraded: true
    });
    if (!actorSeats.length || !legal.length) return { ...template(), reason: 'no-actor' };
    if (modeOf(session) === 'template') return { ...template(), reason: 'template' };

    const codexes = await loadCodexMap(session, actorSeats);
    const blocks = actorSeats.map(seatNo => [
        `### ${seatNo} 号 ${nameOf(seatNo)}`,
        viewBlock(session, seatNo, codexes[seatNo]),
        `（以上只有 ${seatNo} 号自己知道，别替别的成员用上）`
    ].join('\n'));
    const playerBlock = player ? [
        `### ${player.seat} 号 ${nameOf(player.seat)}（玩家本人操作，不用你扮演）`,
        player.note ? `他在狼队频道说：「${player.note}」` : '他在狼队频道没说话',
        player.target != null ? `他提的刀口：${player.target} 号 ${nameOf(player.target)}` : '他还没定刀口'
    ].join('\n') : '';

    const systemPrompt = [
        roleHead(session),
        '',
        '这一夜你同时扮演狼队的每一位成员，各自独立判断；下面每个块只包含那一位自己知道的事，'
            + '块与块之间不要串信息，也别替别的成员用它不该知道的线索。'
    ].join('\n');
    const userContent = [
        '【狼队夜间行动】',
        blocks.join('\n\n'),
        playerBlock,
        `可以刀的座位：${legal.join('、')} 号（狼同伴不在其中）。`,
        `请为 ${actorSeats.map(s => `${s} 号`).join('、')} 各报一个自己的刀口（各自独立判断，不必互相迁就）。`,
        '输出 JSON，不要任何别的文字：',
        '{"chat":[{"seat":座位号,"text":"他在狼队频道说的话"}],'
            + '"wolves":[{"seat":座位号,"target":座位号(数字),"reason":"一句话理由","note":"他自己私下记的一句话"}]}',
        '（每个被扮演的座位在 wolves 里各有一条；note 不会给别人看，可省略）'
    ].filter(Boolean).join('\n');

    try {
        const raw = await callAI({
            systemPrompt, userContent,
            temperature: 0.9,   // 每只狼一整块视角 + 各自的输出；原来单独要 4000，现在整层的 12000 够用
            label: '狼人杀 · 一次狼队夜间',
            // 只扮演**一只**狼时，用那一座绑的预设（主视角托管独狼时，那一座就是主视角，用他的）；
            // 两只以上 = 多人同场，不符合「单个角色」⇒ 不传 ⇒ 走默认（2026-09-15 用户口径）
            presetId: actorSeats.length === 1 ? presetOfSeat(session, actorSeats[0]) : ''
        });
        return { ...parseWolfPackReply(raw, actorSeats, legal), degraded: false };
    } catch (e) {
        return { ...template(), reason: e.message || String(e) };
    }
}

/**
 * 狼队批量回复解析：**按座位分条**，缺的那只算弃权（不整体降级——别人说好的刀口不该被它拖着）。
 * seat 必须是本次被扮演的那些座位之一（防模型串座位），target 只认合法刀口。
 */
export function parseWolfPackReply(raw, actorSeats = [], legal = []) {
    const found = new Map();
    const chat = [];
    const text = String(raw || '');

    const apply = obj => {
        for (const item of (Array.isArray(obj?.wolves) ? obj.wolves : [])) {
            const seat = Number(item?.seat);
            if (!actorSeats.includes(seat) || found.has(seat)) continue;
            const target = Number(item?.target);
            found.set(seat, {
                seat,
                target: legal.includes(target) ? target : null,
                reason: String(item?.reason || '').trim(),
                note: String(item?.note || '').trim()
            });
        }
        for (const item of (Array.isArray(obj?.chat) ? obj.chat : [])) {
            const seat = Number(item?.seat);
            const body = String(item?.text || '').trim();
            if (!actorSeats.includes(seat) || !body) continue;
            chat.push({ seat, text: body });
        }
    };

    let parsed = null;
    try { parsed = JSON.parse(text); } catch { }
    if (!parsed) {
        try { const m = text.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); } catch { }
    }
    if (parsed) apply(parsed);

    return {
        wolves: actorSeats.map(seat => found.get(seat) || { seat, target: null, reason: '', note: '' }),
        chat
    };
}

/**
 * 一次调用 = 一个夜晚决策（只服务 seer / guard / witch / hunter；狼队走 wolfPackAction）
 * @param {object} p
 * @param {'wolf'|'seer'|'guard'|'witch'|'hunter'} p.kind
 * @param {number} [p.seatNo] 视角座位；不给就按 kind 推断
 * @param {number|null} [p.playerSeat] 主视角的座位（没有主视角时 null）。只有「要不要顺手打包后面几拍」
 *   那一处用它：主视角自己那一座只问这一拍，见下面的 bundle
 * @returns {Promise<{target:number|null, action?:string, words?:string, badge?:number|null, reason:string, note:string, degraded:boolean}>}
 *   `words` / `badge` 只在**这一拍之后紧接着轮得到他说话 / 他还拿着警徽**时才多要一栏
 *   （白天补枪那一拍要，夜里那一拍看板子；`badge` 没有这个键＝这一拍根本没问 / 他答不认）
 */
export async function nightAction({ session, kind, seatNo = null, playerSeat = null }) {
    const who = seatNo ?? defaultActor(session, kind);
    const targets = nightTargets(session, kind, who);
    const fallback = { target: templateNightTarget(session, kind, who), reason: '', note: '', degraded: true };
    if (!targets.length || modeOf(session) === 'template') return { ...fallback, reason: 'template' };
    const seat = seatAt(session, who);
    if (!seat) return { ...fallback, reason: 'no-actor' };

    // 女巫：解药与毒药是两套目标，得分开说（界面上也是两排）。她只有一瓶能用，模型别想着两手都开。
    const heal = kind === 'witch' ? witchTargets(session, who, 'heal') : [];
    const poison = kind === 'witch' ? witchTargets(session, who, 'poison') : [];
    // 解药没了就**不再告诉她刀口**（见引擎 witchKnifeOf）：这里也别写成「今晚没人被刀」，那是另一回事
    const healNote = !session.potions?.[who]?.heal
        ? '（解药已经用掉了，这一夜法官也不再告诉你刀口）'
        : (heal.length ? `${heal.join('、')} 号` : '（今晚没有人被刀，救不了人）');
    // 猎人：三条路上各是一套话——夜里被刀那一拍、白天补枪那一拍（出局者流程）、夜里的空过。
    // ⚠️ `asksWords` 与 `badgeLegal` 只管**要不要多要一栏**——这一次调用本身（开枪还是弃枪、带走谁）
    // 在任何一条路上都照打：那是他自己要决定的事，与板子无关。
    const woken = kind === 'hunter' ? hunterWakesTonight(session) === who : false;
    // 白天补枪那一拍：队列里轮到的就是他，而这一拍**不是「今晚被狼刀」**（见 SHOT_ASK）。
    // 判据取自阶段与队列（谁在队首、队首欠哪一拍），不能拿夜里的刀口去推——那个刀口跟他没关系。
    const shot = kind === 'hunter' && session.phase === 'skill_wait'
        && currentDeath(session)?.seat === who && currentDeath(session)?.act === 'shot';
    const idle = kind === 'hunter' && !woken && !shot;
    // 顺手把**后面紧接着那几拍**要用的东西一次问完（按次数计费，能省一次是一次）：
    //   白天补枪：技能→遗言→警徽是他一个人的连续动作（用户 2026-09-15 定），一次调用就够。
    //             遗言权照引擎的 hasLastWords 问他**自己那条死亡记录**（白天出局一律有；
    //             夜里出局却没在夜里被问过的，只有第一夜还有）——别在这儿另写一份规则。
    //             警徽是他还拿着的时候才问。
    //   夜里那一拍：照旧只看第一夜出局、还有遗言权的那种，且受 draftsWordsAtNight 的板子闸
    //             （有上警阶段的板子上他要等竞选之后再自己说）；警徽更晚，那要等竞选之后才谈得上。
    // 这条捷径**只对 AI 扮演的座位走**：主视角自己那一座点了「让 AI 决定」时，只问这一拍。
    // 他后面的遗言与警徽本来就是自己动手的（界面上就是那个发言框与那排芯片），替他提前定了
    // 等于把那两拍从他手里拿走，而那一座**本来就没有调用要省**（见 UI 的 nightTurn 传的 playerSeat）。
    const bundle = shot && who !== playerSeat;
    const asksWords = kind === 'hunter' && (shot
        ? bundle && hasLastWords(session, seatAt(session, who))
        : (woken && willHaveWords(session, 'wolf', 'night') && draftsWordsAtNight(session)));
    // 还能接警徽的人（引擎那一份，与遗言、与界面芯片同源）。空集就别问了——那一拍自己会兜底
    const badgeLegal = (bundle && isSheriff(session, who))
        ? badgeTargets(session, who).map(s => s.seat) : [];

    const systemPrompt = [roleHead(session), '', viewBlock(session, who, await loadCodex(seat))].join('\n');
    const userContent = [
        shot ? SHOT_ASK : (idle ? NIGHT_ASK_IDLE[kind] : (NIGHT_ASK[kind] || '你要行动了。')),
        kind === 'wolf' ? `可以刀的座位：${targets.join('、')} 号（狼同伴不在其中）。` : '',
        kind === 'seer' ? `可以验的座位：${targets.join('、')} 号。` : '',
        kind === 'guard' ? `可以守护的座位：${targets.join('、')} 号。` : '',
        kind === 'witch' ? `解药能救的：${healNote}；毒药能毒的：${poison.join('、')} 号。` : '',
        kind === 'hunter' ? `可以带走的座位：${targets.join('、')} 号。` : '',
        // 警徽那一栏的合法集是**枪响之前**算的——他要带走的人也在里头。
        // 所以先写一句规则，让模型别往那儿挑；落库那一步还会拿枪响之后的活人再拦一道
        // （见 UI 的 applyNightDecision）。
        badgeLegal.length
            ? `你还拿着警徽，顺带定下它的去向：交给一个还有票的人（${badgeLegal.join('、')} 号），或者当场撕掉。`
                + '你要带走的那个人接不了警徽。'
            : '',
        kind === 'witch'
            ? '输出 JSON：{"action":"heal"（用解药）/ "poison"（用毒药）/ "none"（不用药）,"target":座位号(数字，不用药写 null),"reason":"一句话理由","note":"你自己私下记的一句话"}'
            : kind === 'hunter'
                ? `输出 JSON：{"target":座位号(数字，弃枪写 null),"reason":"一句话理由","note":"你自己私下记的一句话"`
                    + `${asksWords ? ',"words":"' + (shot
                        ? '你留给活着的人的遗言（一到三句，过一会儿会当众念出来、之后回不来了）'
                        : '你留给白天的遗言（一到三句，公布你的死讯之后会当众念出来）') + '"' : ''}`
                    + `${badgeLegal.length ? ',"badge":交给谁就写座位号，当场撕掉就写「撕掉」' : ''}}`
                : '输出 JSON：{"target":座位号(数字),"reason":"一句话理由","note":"你自己私下记的一句话"}',
        '只输出 JSON，不要任何别的文字。'
    ].filter(Boolean).join('\n');

    try {
        const raw = await callAI({
            systemPrompt, userContent,
            temperature: 0.85,
            label: kind === 'seer' ? '狼人杀 · 一次验人' : '狼人杀 · 一个夜晚决策',
            presetId: presetOfSeat(session, who)     // 注意是 who —— 入参 seatNo 可能没给，座位是这里推断出来的（1006 行）
        });
        // badgeLegal 是空集时当没问过（传 null）：解析层多出来的那一栏也就不会凭空冒出来
        return { ...parseNightReply(raw, targets, kind, badgeLegal.length ? badgeLegal : null), degraded: false };
    } catch (e) {
        return { ...fallback, reason: e.message || String(e) };
    }
}

/** 夜晚决策的视角座位：狼队用座号最小的活狼 */
export function defaultActor(session, kind) {
    if (kind === 'hunter') {
        // 白天补枪那一拍：队列里轮到的那个就是他；夜里那一拍：被刀的那个（没被刀时为 null，压根不用问）
        const cur = currentDeath(session);
        if (cur?.act === 'shot') return cur.seat;
        return hunterWakesTonight(session);
    }
    if (kind === 'seer') return (seatsOfRole(session, 'seer').find(s => s.alive !== false) || {}).seat ?? null;
    if (kind === 'guard') return (seatsOfRole(session, 'guard').find(s => s.alive !== false) || {}).seat ?? null;
    if (kind === 'witch') return (seatsOfRole(session, 'witch').find(s => s.alive !== false) || {}).seat ?? null;
    return (wolvesOf(session).find(s => s.alive !== false) || {}).seat ?? null;
}

/**
 * 猎人能带走的座位：夜里那一拍是「被叫醒才有」的 hunterTargets；
 * 白天补枪那一拍（被票出局的那个）就是场上活人除他自己——那一步走的是队列，不在夜里的规则里。
 */
export function hunterLegal(session, seatNo) {
    const cur = currentDeath(session);
    if (cur?.act === 'shot' && cur.seat === seatNo) {
        return aliveSeats(session).filter(s => s.seat !== seatNo).map(s => s.seat);
    }
    return hunterTargets(session, seatNo);
}

/** 这一个决策的合法目标（引擎的规则也拦一遍，这里只是别把非法选项喂给模型） */
export function nightTargets(session, kind, seatNo) {
    if (kind === 'wolf') return wolfTargets(session).map(s => s.seat);
    if (kind === 'seer') return seerTargets(session, seatNo).map(s => s.seat);
    // 守卫走引擎的 guardTargets：可自守，且已经排掉上一夜守过的那位（下面那条通用尾巴会把「自己」排掉）
    if (kind === 'guard') return guardTargets(session, seatNo).map(s => s.seat);
    // 女巫两瓶药的目标并成一个集合（救的只有刀口那一个，毒的是场上除她以外的活人）
    if (kind === 'witch') {
        return [...new Set([...witchTargets(session, seatNo, 'heal'), ...witchTargets(session, seatNo, 'poison')])];
    }
    if (kind === 'hunter') return hunterLegal(session, seatNo);
    return aliveSeats(session).filter(s => s.seat !== seatNo).map(s => s.seat);
}

/**
 * 这个人今夜出局的话，轮得到他留遗言吗——照引擎的 hasLastWords 探一下，不在这儿另写一份规则。
 * 只有在**用得上**的时候才在夜里的调用里顺手要遗言：用不上还要，等于白占他的输出。
 */
function willHaveWords(session, by, when) {
    return hasLastWords(session, { death: { round: session.round || 1, by, when } });
}

/**
 * 夜晚决策解析：JSON 优先，认不出就退到「刀/验/带 3 号」的字面匹配。
 * `badgeLegal` 只有**白天补枪那一拍**才传（他在任警长时，同一句话里把警徽的去向也答了）：
 * 传了就多认一栏 `badge`，不传就一个字都不多认——夜里那一拍与警徽无关。
 */
export function parseNightReply(raw, legal = [], kind = 'wolf', badgeLegal = null) {
    const text = String(raw || '');
    const take = v => { const n = Number(v); return legal.includes(n) ? n : null; };
    const pick = obj => {
        const out = {
            target: take(obj?.target),
            reason: String(obj?.reason || '').trim(),
            note: String(obj?.note || '').trim()
        };
        // 女巫：一个座号分不出是救还是毒，得看她自己说用哪瓶药。认不出 = 今晚不用药（绝不替她乱开药）
        if (kind === 'witch') out.action = ['heal', 'poison', 'none'].includes(obj?.action) ? obj.action : 'none';
        // 猎人被刀那一拍顺手写下的遗言（收不收由调用方定：只有他真用得上才收）
        if (kind === 'hunter') out.words = String(obj?.words || '').trim();
        // 白天补枪那一拍顺手带回的警徽去向（三档判据与遗言里那行完全同源）
        if (badgeLegal) out.badge = pickBadgeValue(obj?.badge, badgeLegal);
        return out;
    };
    try { const obj = JSON.parse(text); if (obj && typeof obj === 'object') return pick(obj); } catch { }
    try {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) { const obj = JSON.parse(m[0]); if (obj && typeof obj === 'object') return pick(obj); }
    } catch { }
    const said = text.match(/(\d{1,2})\s*号/);
    const target = said ? take(said[1]) : null;
    const out = { target, reason: stripQuotes(text.split('\n')[0] || ''), note: '' };
    // 字面兜底也认得出她说的是哪瓶药：「毒 3 号」/「救 5 号」/「今晚不用药」
    if (kind === 'witch') out.action = /毒/.test(text) ? 'poison' : (/救/.test(text) ? 'heal' : 'none');
    return out;
}

/** 模板模式的夜晚行动：狼刀座号最小的好人，预言家验第一个没验过的，猎人弃枪，女巫今晚不用药 */
export function templateNightTarget(session, kind, seatNo) {
    if (kind === 'hunter' || kind === 'witch') return null;
    const legal = nightTargets(session, kind, seatNo);
    if (!legal.length) return null;
    if (kind === 'seer') {
        const checked = new Set((session?.seerLog || []).filter(e => e.by === seatNo).map(e => e.seat));
        return legal.find(s => !checked.has(s)) ?? legal[0];
    }
    return legal[0];
}

/* ---- 警长：定发言方向 / 移交警徽 ----
 * 这两拍**各自一个函数**，不塞进 nightAction 的 kind：那一套的 defaultActor / nightTargets
 * 全是夜间形状（活人、不含自己、按角色推座位），尾巴还会把认不出的 kind 落到 applyHunterShot
 * ——警徽塞进去就是把警徽当开枪（UI 那一侧同一个坑，见 actMyNight 的 badge 支）。
 */

/**
 * 一次调用 = 警长定今天从谁开口。**只有两项**（警左 / 警右），锚在他自己身上，所以
 * 他永远有得选、与昨晚死没死人无关（见引擎 speakOrderOptions——三处共用那一份选项表）。
 *
 * **明面上他这一步只做了"定个方向"这一件事**：流水里照旧只有 `speakOrderLine` 那一句
 * （「警长 N 号定了方向：…」，进的是公开流水，谁都看得到），他没有借这一拍发言、
 * 也不占他这一轮的发言——他自己那一段话要等次序轮到他。
 * 但这一次调用**照样把他私有的那几样一起收回来**（用户 2026-09-15 定：警长每天多一次行动，
 * 就该多留下一份更厚的私有记录）：判断表 / 笔记 / 心声 / 关注表。于是这里的「笔记」不只是
 * 复述决定，而是**这一天的打算**——它下一轮回灌他自己的提示词，到他发言、投票、夜里行动时
 * 都还在，等于他每天多记一笔账：别人一天只有发言与投票两次记账，他有三次。
 * 认不出、或者 AI 没回话，`order` 返回 null，交给引擎的宽容写法（退回第一项），这一天不会卡住。
 * @returns {Promise<{order:{side:string,dir:number}|null, reason:string, note:string, heart:string, marks:Object, watch:(number[]|undefined), degraded:boolean}>}
 */
export async function sheriffOrder({ session, seatNo = null, type }) {
    const who = seatNo ?? sheriffSeatOf(session);
    const options = speakOrderOptions(session);
    const first = options[0] ? { side: options[0].side, dir: options[0].dir } : null;
    const fallback = { order: first, reason: '', note: '', heart: '', marks: {}, degraded: true };
    if (who == null || !options.length) return { ...fallback, reason: 'no-actor' };
    if (modeOf(session) === 'template') return { ...fallback, reason: 'template' };

    const record = await loadCodex(seatAt(session, who));
    const cap = watchPlan(record).watch;
    // 盯得住谁与投票那一拍同一个口径：场上的活人、不含自己
    const legal = aliveSeats(session).filter(s => s.seat !== who).map(s => s.seat);
    const systemPrompt = [roleHead(session), '', viewBlock(session, who, record)].join('\n');
    const userContent = [
        '天亮了，你是这一局的警长：今天从谁开口由你定。',
        toneLine(type),
        '你只能定一个方向，不点名、也不能跳过谁：'
            + '「从警左开始」= 从你的下家那头顺着座号数，「从警右开始」= 从你的上家那头倒着数；'
            + '起点就落在那个方向上的第一个活人身上。',
        '你今天是第一个有动作的人：定完方向，顺手把你自己这一天的账也记一遍——'
            + '理由、打算、判断表、关注表都**只有你自己看得到**，别人看不到，也不会因为你写了就露出去；'
            + '公开的只有"你定了从哪边开始"这一件事。',
        '输出 JSON，不要任何别的文字：',
        `{"order":"${options.map(o => o.side).join('" 或 "')}",`
            + '"reason":"你心里为什么这么定（一两句，不公开）",'
            + '"note":"你私下记的一句话：这一天你打算怎么带、要重点听谁说",'
            + '"heart":"定完方向这一刻心里冒出来的那句话","marks":{"座位号":"标签"},"watch":[重点盯的座位号]}',
        `（reason 与 note 都是写给自己的：reason 是此刻的理由，note 是往后要用的那一句——`
            + `两个都有就都收下，只写一个也行；heart 是没说出口的那句话，长短随你，不必跟 reason 一个说法；`
            + `marks 的标签只能用：${markTagsOf(session).join('、')}，一个人一个标签——写到谁就是改他那一条、`
            + `没写到的人维持原样，想撤掉对某个人的判断就把那一栏写成 null；`
            + `watch 是你接下来要重点盯的人——你只盯得住 ${cap} 个，没盯上的人说过的话你后面会渐渐记不清；`
            + '**写了这一栏就是重新定一张表、只留你写上的这几个，不写才维持你现在盯的人**）'
    ].filter(Boolean).join('\n');

    try {
        const raw = await callAI({
            systemPrompt, userContent,
            temperature: 0.85,
            label: '狼人杀 · 定发言方向',
            presetId: presetOfSeat(session, who)
        });
        return { ...parseOrderReply(raw, options, { cap, legal, session }), degraded: false };
    } catch (e) {
        return { ...fallback, reason: e.message || String(e) };
    }
}

/**
 * 定发言方向的解析。`order` 那一支：JSON 优先（`{"order":"left"}`，也认 `side` / `dir` 两种写法），
 * 认不出再认字面的「警左 / 警右」；**都认不出返回 null**（不是"第一个选项"）——退回哪一项是
 * 引擎的决定（applySpeakOrder 里那一句宽容写法），解析层不替它拍板，两边各写一份就会走岔。
 *
 * 其余几样（理由 / 笔记 / 心声 / 判断表 / 关注）与投票那一拍同一套收法，**"没写就是维持原样"
 * 这一条也照旧**：`watch` 没写（或一个合法座号都没点出来）返回 undefined，调用方据此不碰他那张表；
 * `marks` 同理走 mergeLabels（空对象不落库、不冲掉旧标签）。
 */
export function parseOrderReply(raw, options = [], { cap = Infinity, legal = [], session = null } = {}) {
    const text = String(raw || '').trim();
    const out = hit => (hit ? { side: hit.side, dir: hit.dir } : null);
    const bySide = v => options.find(o => o.side === String(v ?? '').trim().toLowerCase()) || null;
    const byDir = v => (v == null || v === '' ? null : options.find(o => Number(o.dir) === Number(v)) || null);
    const pickWatch = obj => {
        const list = Array.isArray(obj?.watch) ? obj.watch : null;
        if (!list) return undefined;
        const ids = [...new Set(list.map(Number).filter(n => legal.includes(n)))].sort((a, b) => a - b);
        return ids.length ? ids.slice(0, cap) : undefined;
    };
    const pick = (order, obj) => ({
        order,
        reason: String(obj?.reason || '').trim(),
        note: String(obj?.note || '').trim(),
        heart: String(obj?.heart || '').trim(),
        marks: typeof obj?.marks === 'string' ? parseMarks(obj.marks, session) : (obj?.marks || {}),
        watch: pickWatch(obj)
    });

    let obj = null;
    try { obj = JSON.parse(text); } catch { }
    if (!obj) { try { const m = text.match(/\{[\s\S]*\}/); if (m) obj = JSON.parse(m[0]); } catch { } }
    if (obj && typeof obj === 'object') {
        const hit = bySide(obj.order) || bySide(obj.side) || byDir(obj.dir);
        if (hit) return pick(out(hit), obj);
    }
    // 字面兜底（只在模型没按 JSON 来时走到）。规则：一句里同时提了「左」和「右」的，按**先出口的那个**算。
    // ⚠️ 已知取舍：这条认不了否定语气——「不是警右，是从警左」会判成右。别顺手去"修"成认否定：
    // 那会换来新的误判（「警右太吃亏，我从警左」先说的是右），而正路是 JSON，这层只是兜底，不值当。
    const said = text.match(/警?[左右]/g);
    if (said) {
        for (const s of said) {
            const hit = bySide(s.includes('左') ? 'left' : 'right');
            if (hit) return pick(out(hit), obj);
        }
    }
    // 连方向都认不出：order 是 null（引擎会退回第一项），但认得出 JSON 时其余几样照收——
    // 他白写了理由与笔记的话，不该跟着一起扔掉
    return { ...pick(null, obj), reason: obj ? '' : stripQuotes(text.split('\n')[0] || '') };
}

/**
 * 一次调用 = 警长把警徽交出去或当场撕掉。两种人走到这儿：**出局**的警长（只有他没有遗言权时才
 * 单独走这一拍——有遗言的时候，去向已经在遗言那一次调用里顺手定了，见 lastWords，这一拍只是
 * 当众走一遍），以及**翻过牌**的警长（他没出局，是徽不能留在没有票的人手里，见 executeOut）。
 * 两者的差别只在开场那半句：前者「你出局了」，后者「你翻牌了」。
 * `torn: true` 才是撕（不可逆），所以模板兜底与解析失败都**不撕**：交给座号最小的活人
 * （名单由 badgeTargets 给，翻过牌的白痴不在里面）。
 */
export async function badgeHandover({ session, seatNo = null, type }) {
    const who = seatNo ?? currentDeath(session)?.seat ?? null;
    const legal = who == null ? [] : badgeTargets(session, who).map(s => s.seat);
    // 没人可交（场上就剩他自己）＝ 只能撕。这是规则算出来的结果，不是"没解析出来"
    if (who == null) return { target: null, torn: true, reason: 'no-actor', note: '', degraded: true };
    if (!legal.length) return { target: null, torn: true, reason: 'no-target', note: '', degraded: true };
    // 模板模式（无 key / 连续失败）：交给座号最小的活人，**绝不默认撕掉**
    const bye = { target: templateBadgeTarget(session, who), torn: false, reason: '', note: '', degraded: true };
    if (modeOf(session) === 'template') return { ...bye, reason: 'template' };

    const systemPrompt = [roleHead(session), '', viewBlock(session, who, await loadCodex(seatAt(session, who)))].join('\n');
    const flipped = seatAt(session, who)?.flipped === true;
    const userContent = [
        // 走到这一拍的**不一定是出局的人**：翻过牌的警长也得当众把徽交出去（他没出局，是徽不能留在他手里）
        flipped
            ? '你翻牌了：你还留在场上，但警徽不能留在没有票的人手里——现在当众交出去，也可以当场撕掉。'
            : '你出局了，现在要把警徽交出去——也可以当场撕掉。',
        toneLine(type),
        `可以交的座位：${legal.join('、')} 号（都是活人、且都还有票，不含你自己）。`,
        '警徽交给谁，谁就接着当这一局的警长：他的票算 1.5 票，每天天亮由他定从谁开口；'
            + '撕掉的话，这一局就再没有警长了。',
        '输出 JSON，不要任何别的文字：',
        '{"target":座位号(数字，撕掉写 null),"torn":true或false,"reason":"一句话理由","note":"你自己私下记的一句话"}',
        '（要撕掉就写 "torn":true 并把 target 写成 null；要交给谁就把 torn 写成 false。）'
    ].filter(Boolean).join('\n');

    try {
        const raw = await callAI({
            systemPrompt, userContent,
            temperature: 0.85,
            label: '狼人杀 · 移交警徽',
            presetId: presetOfSeat(session, who)
        });
        return { ...parseBadgeReply(raw, legal), degraded: false };
    } catch (e) {
        return { ...bye, reason: e.message || String(e) };
    }
}

/**
 * 交警徽的解析。**闸口就在这一条**：撕警徽是不可逆的一步，所以只有他**明确说了撕**才算撕
 * ——JSON 里 `"torn":true`（**只看这一栏**）、或者整段没有 JSON 时字面写着「撕」。
 * 除此之外一律 `torn:false`：`"target":null`、乱码、空回复都只是"没认出去向"，
 * 调用方会退到模板兜底（座号最小的活人）。**解析失败绝不能等于撕徽。**
 *
 * 对照 parseNightReply：那边 `target:null` 同时代表"模型说要 null"与"没解析出来"，
 * 对开枪来说无害（弃枪与解析失败是同一个结果）；对警徽不行，所以这里不能照抄那条。
 */
export function parseBadgeReply(raw, legal = []) {
    const text = String(raw || '');
    const take = v => { const n = Number(v); return legal.includes(n) ? n : null; };
    const out = (torn, target, reason) => ({
        target: torn ? null : take(target),
        torn: Boolean(torn),
        reason: String(reason || '').trim()
    });
    const truthy = v => v === true || String(v).trim().toLowerCase() === 'true';

    let obj = null;
    try { obj = JSON.parse(text); } catch { }
    if (!obj) { try { const m = text.match(/\{[\s\S]*\}/); if (m) obj = JSON.parse(m[0]); } catch { } }
    // 认得出 JSON：**只看 torn 那一栏，不扫正文里的「撕」字**——理由里写「撕掉对谁都没好处」
    // 而实际交给了 5 号的那种回复，扫字会把它读成撕徽，而这一步回不了头
    if (obj && typeof obj === 'object') return out(truthy(obj.torn), obj.target, obj.reason);
    // 整段没有 JSON（模板般的短回复）：字面兜底。明说撕才算撕，认不出座号就交给模板兜底
    return out(/撕/.test(text), (text.match(/(\d{1,2})\s*号/) || [])[1], text.split('\n')[0]);
}

/**
 * 模板模式的竞选票：座号最小的**候选人**（名单已按座号排好，且撤掉了自己与翻过牌的白痴）。
 * 全场都这么投 ⇒ 最小的那位必然当选：无 key 用户也有警长，不然这个板子对模板模式等于不存在。
 * 平票补投那一拍换一份名单（台上就剩那几位，照 sheriffPkVoteTargets）。
 */
export function templateSheriffPick(session, seatNo) {
    const list = session?.phase === 'day_sheriff_pk_vote'
        ? sheriffPkVoteTargets(session)
        : sheriffCandidates(session, seatNo);
    return list[0]?.seat ?? null;
}

/**
 * 模板模式的上警表态：**每三个座位里最低的那个上警**（1、4、7、10 号）。
 * 为什么不能全体不上警：没有候选人这一局就没有警徽，而「选警长」是全桌有共识的事
 * ——无 key 用户也照样该打得出警长板子（与 templateSheriffPick 同一条理由）。
 * 也不能全体上警：那样台下一个能投票的都没有，同样是白做。取每三个里最低的那一位，
 * 既保证了至少两个人上警（不会一上警就独苗），也保证台下永远有人。
 */
export function templateSignup(seatNo) {
    return Math.max(1, Number(seatNo) || 1) % 3 === 1;
}

/** 模板模式的警徽去向：交给座号最小、**还有票**的活人（翻过牌的白痴不算）；
 *  没人可交返回 null（＝撕，场上就剩他一个了） */
export function templateBadgeTarget(session, seatNo) {
    return badgeTargets(session, seatNo)[0]?.seat ?? null;
}

/* ---- 代笔（唯一允许主视角标记进入的调用） ---- */

/**
 * 玩家打了一半（或者只贴了标签），让 AI 按玩家角色的口吻替他把话写完。
 * 标记是玩家自己贴的，只在这一路进入提示词；AI 角色的调用里永远没有它。
 * @returns {Promise<{text:string, degraded:boolean, reason?:string}>}
 */
export async function ghostwrite({ session, seatNo, draft = '', marks = {}, type }) {
    const limit = type?.speechLimit || 120;
    const mine = { text: String(draft || '').trim(), note: '', degraded: true };
    if (modeOf(session) === 'template') return mine;

    const marked = Object.entries(marks).map(([s, t]) => `${s} 号=${t}`).join('、');
    const systemPrompt = [roleHead(session), '', viewBlock(session, seatNo, await loadCodex(seatAt(session, seatNo)))].join('\n');
    const userContent = [
        `轮到你发言，你自己先打了半句草稿，想让别人（同样是你）替你把话说完。`,
        mine.text ? `你的草稿：${mine.text}` : '你还没打草稿，只给了自己的判断。',
        marked ? `你自己给场上的人贴的判断（顺着它说）：${marked}` : '',
        `请以你的口吻写成一段完整的发言（不超过 ${limit} 字），保留草稿的原意，可以补上理由与态度。`,
        '只写你说出口的话，不要写「XX 说：」，不要提到草稿、标签、AI。',
        '',
        '最后另起一行，可选地写一句你私下记的笔记（不公开，给以后的自己看；没有就不写），格式必须完全一致：',
        '【笔记】……'
    ].filter(Boolean).join('\n');

    try {
        const raw = await callAI({
            systemPrompt, userContent,
            temperature: 0.9,
            label: '狼人杀 · 代笔',
            presetId: presetOfSeat(session, seatNo)
        });
        // 笔记先剥掉再判空：模型只回一行笔记不算有正文，但那行笔记也不能被当成正文
        const parsed = parseSpeakReply(raw);
        if (!parsed.text) throw new Error('空回复');
        return { text: parsed.text, note: parsed.note, degraded: false };
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

/* ---------------- 赛后复盘（牌摊开之后的桌边聊天） ---------------- */

/**
 * 复盘专用的角色扮演头。与对局中那句的唯一区别：**这一局已经打完了**——
 * 身份亮牌、夜里的事摊开（只有狼队夜里的悄悄话没公开），别的规矩照旧（不跳出角色、不替别人说话）。
 */
function reviewHead() {
    return '你和几个人刚打完一桌狼人杀，牌已经摊开了，大家还没散，正在桌边复盘聊天。'
        + '你在扮演这一桌里的一个玩家：完全以这个角色的人设说话，用第一人称，不要跳出角色；'
        + '不要提到「AI」「模型」「提示词」「系统」，不要替别人说话，不要复述规则。'
        + '身份已经全部亮牌，夜里谁做了什么大家也都知道了——只有狼队在夜里的悄悄话没有公开。';
}

/**
 * 复盘的视角块：**比对局中的 viewBlock 宽得多**——游戏结束了，全员亮牌与夜里的真相都摊开
 * （用户 2026-09-13 的口径：全员亮牌 + 夜间行动公开）。
 *
 * 仍然守住的：**别人的私有笔记不给**；**狼队频道只给那局里是狼的人**（「狼队聊天不公开」）；
 * 每个座位的块仍只装他自己那一份。
 */
function reviewViewBlock(session, seatNo, record = null) {
    const seat = seatAt(session, seatNo);
    if (!seat) return '';
    const mine = seat.kind === 'npc'
        ? { name: seat.name, persona: seat.persona }
        : { id: seat.characterId, name: seat.name };
    const others = (session.seats || [])
        .filter(s => s.seat !== seatNo && s.kind !== 'npc' && s.characterId)
        .map(s => ({ id: s.characterId, name: s.name }));
    const knowledge = seat.kind === 'npc' ? '' : buildKnowledge(seat.characterId, others);
    const myNotes = (session.aiNotes || {})[seatNo] || [];
    const codexText = codexBlock(record, { isGuest: seat.kind === 'npc', roomScope: session.typeId });
    const isWolf = seat.role === 'werewolf';
    const rows = finalResult(session);
    const truth = nightTruth(session);

    // 狼队频道（对局中 isPublic:false 的私有事件）：复盘也只给**那局里是狼的人**，非狼一个字都看不到
    const wolfChat = isWolf
        ? (session.events || []).filter(e => e.type === 'wolfchat').map(e => `· ${e.text}`)
        : [];
    const transcript = reviewTranscript(session, { limit: 40 });
    const mentionedBy = [...new Set((session.review || [])
        .filter(m => (m.mentions || []).includes(seatNo))
        .slice(-6)
        .map(m => `${m.seat} 号 ${m.name}`))];

    return [
        '【你】',
        selfCard(mine),
        `你的身份：${rows.find(r => r.seat === seatNo)?.role ? roleLabel(rows.find(r => r.seat === seatNo).role) : ''}（这一局你在${isWolf ? '狼人' : '好人'}阵营）`,
        '',
        '【这一局的结果】（已经亮牌）',
        session.winner === 'wolf' ? '狼人获胜' : session.winner === 'good' ? '好人获胜' : '本局结束',
        rows.map(r => `· ${r.seat} 号 ${r.name}：${roleLabel(r.role)}，${r.faction === 'wolf' ? '狼人阵营' : '好人阵营'}，${r.alive ? '活到最后' : '出局'}${r.win ? '（赢了）' : ''}`).join('\n'),
        truth ? `\n【夜里的真相】（打完了才摊开的）\n${truth}` : '',
        '',
        publicFeed(session),
        knowledge ? `\n【你对在场各人的了解】\n${knowledge}` : '',
        myNotes.length
            ? `\n【你自己之前记的笔记】\n${myNotes.map(n => `- ${noteHead(n)}：${n.text}`).join('\n')}`
            : '',
        wolfChat.length ? `\n【这一局你们狼队在夜里说过的话】（只有你们自己看得到）\n${wolfChat.join('\n')}` : '',
        codexText ? `\n${codexText}` : '',
        transcript ? `\n【赛后大家说的话】\n${transcript}` : '',
        mentionedBy.length ? `\n【有人点名了你】\n${mentionedBy.join('、')} 刚才 @ 了你。` : ''
    ].filter(Boolean).join('\n');
}

const FALLBACK_REVIEWS = [
    '这一局打得挺乱的，我下把注意点。',
    '说实话我当时也没想明白，就跟着感觉走了。',
    '打完了就好，下局再来一把。',
    '我这边没什么好说的，大家打得都不错。',
    '刚才那几步我确实走错了，认了。'
];

/** 复盘发言的模板台词（无 key / 调用失败时用），按座位取，稳定不随机 */
export function fallbackReview(seatNo) {
    return FALLBACK_REVIEWS[(Math.max(1, seatNo) - 1) % FALLBACK_REVIEWS.length];
}

/**
 * 一次调用 = 一位角色的复盘发言。**每个被点名的角色各调一次**（用户 2026-09-13 定，
 * 不是一次调用扮演全员）——每块只装这个座位自己的视角，包括他自己的私有笔记。
 * @param {object} p
 * @param {object} p.session
 * @param {number} p.seatNo 说话的座位
 * @param {object} [p.type] 房间分类（只取语气）
 * @param {object} [p.record] 这个座位自己的档案（由调用点先 await loadCodex 取好）
 * @returns {Promise<{text:string, mentions:number[], degraded:boolean, reason?:string}>}
 */
export async function reviewSpeak({ session, seatNo, type, record = null }) {
    const seat = seatAt(session, seatNo);
    const fallback = { text: fallbackReview(seatNo), mentions: [], degraded: true };
    if (!seat) return { ...fallback, reason: 'no-seat' };

    const systemPrompt = [reviewHead(), '', reviewViewBlock(session, seatNo, record)].join('\n');
    const userContent = [
        '赛后大家正在桌边聊这一局。轮到你说话了：可以复盘、吐槽、辩解、认栽、夸谁玩得好，也可以回应刚才点你名的人。',
        '像真人在群里聊天那样：想跟谁说话就直接说，**回应别人不必写 @**——谁在跟谁说话，大家都看得出来。',
        '@ 的意思是「我要你接话、想听你的回答」，真需要他回你的时候才写：写在句子里，@ 加他的座号或名字（例如「@3号」「@小明」都行）。'
        + '一条话里跟好几个人打招呼、回应好几个人都没问题，但不必挨个 @ 一遍；一个 @ 都不写也完全可以。',
        `说得自然些，像真的坐在桌边聊天，别写成总结报告。${toneLine(type)}`,
        '只写你说出口的话，不要写「XX 说：」这样的前缀，也不要写【判断】【笔记】这类标记行。'
    ].join('\n');

    try {
        const raw = await callAI({ systemPrompt, userContent, temperature: 0.95, label: '狼人杀 · 赛后复盘', presetId: presetOfSeat(session, seatNo) });
        const text = stripQuotes(String(raw || '')
            .replace(/^【[^】]*】[^\n]*$/gm, '')     // 模型偶尔仍会写标记行，整行剔掉
            .replace(/\n{3,}/g, '\n\n')
            .trim());
        if (!text) throw new Error('空回复');
        return { text, mentions: parseMentions(text, session), degraded: false };
    } catch (e) {
        return { ...fallback, reason: e.message || String(e) };
    }
}

/* ---------------- 复盘心得（牌摊开之后，角色自己对着这一局想一想） ----------------
 * 与上面的 `reviewSpeak` 是**同一个视角、不同的题目**：head 与视角块一个字都不另造
 * （`reviewHead` + `reviewViewBlock`，全员亮牌 / 夜里的真相 / 自己的私有笔记 / 狼队频道都在），
 * 换的只是题面——那次是「轮到你说话了」，这次是「你自己复盘一下」。
 *
 * **一次调用拿两样**（用户 2026-09-16 定口径）：**心得**偏「复盘＋成长」，**记忆**偏日常。
 * 两样分开要，是因为**去处不同**：心得进狼人杀档案（角色数据，留在本模块），
 * 记忆进角色的长期记忆（`char_<id>.memories`，此后每次对话都在提示词里，别的模块也读得到）。
 *
 * **按需触发**：玩家点了谁的头像才做谁——一桌 12 人不会因为这一条变成 12 次调用。
 */

/** 「复盘心得」的题面 */
function insightUserContent(type) {
    return [
        '这一局已经打完了，桌上的人也散了。现在没有别人在问你话——你自己对着这一局想一想。',
        '写两块，每块各起一行写标记，标记单独占一行：',
        '',
        '【心得】',
        '以你自己的视角评价这一局：哪几步走对了、哪几步走错了、当时是怎么想的、下回再碰上类似的局面打算怎么办。',
        '这是写给自己看的，不用客气、不用照顾别人的面子，也别替别人做总结。三五句就够。',
        '',
        '【记忆】',
        '这一局里，往后日子里你偶尔还会想起来的那点事。写成你日后回想起来的口气（「那天跟谁打了一桌……」），像平常记着一件事，别写成总结报告。',
        '一两句。提别人的时候用名字——座号出了这张桌子就没人懂了。',
        '',
        `两块都用第一人称，不要写「XX 说：」这样的前缀，不要复述规则。${toneLine(type)}`
    ].join('\n');
}

/**
 * 从回复里切出两块。**认不出第二块就整段当心得、记忆留空**：
 * 宁可这一次少一条记忆（玩家还能再点一次），也不把一篇复盘报告整段灌进角色的长期记忆——
 * 记忆此后会跟着他进每一次对话，灌错了是一直跟着的。
 * @returns {{insight:string, memory:string}}
 */
export function parseInsightReply(raw) {
    const text = stripQuotes(String(raw || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim());
    const cut = text.search(/【记忆】/);
    const head = cut >= 0 ? text.slice(0, cut) : text;
    const tail = cut >= 0 ? text.slice(cut) : '';
    return {
        insight: stripQuotes(head.replace(/【心得】/g, '').trim()),
        memory: stripQuotes(tail.replace(/【记忆】/g, '').trim())
    };
}

/** 心得正文的兜底：调用失败时**不给模板台词**——这是玩家亲手点出来的，
 *  编一段假心得塞进他的档案里比空着更糟。失败就如实说失败，让他自己决定要不要再来一次。
 *  @returns {Promise<{insight:string, memory:string, degraded:boolean, reason?:string}>} */
export async function reviewInsight({ session, seatNo, type, record = null }) {
    const seat = seatAt(session, seatNo);
    if (!seat) return { insight: '', memory: '', degraded: true, reason: 'no-seat' };

    const systemPrompt = [reviewHead(), '', reviewViewBlock(session, seatNo, record)].join('\n');
    try {
        const raw = await callAI({
            systemPrompt, userContent: insightUserContent(type),
            temperature: 0.9, label: '狼人杀 · 复盘心得',
            presetId: presetOfSeat(session, seatNo)
        });
        const { insight, memory } = parseInsightReply(raw);
        if (!insight) throw new Error('空回复');
        return { insight, memory, degraded: false };
    } catch (e) {
        return { insight: '', memory: '', degraded: true, reason: e.message || String(e) };
    }
}

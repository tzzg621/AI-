// apps/games/werewolfEngine.js — 狼人杀规则引擎
//
// 边界：**纯规则，无 DOM、无存储、无 AI、无随机副作用**（随机数从参数传进来，默认 Math.random）。
// 谁该说话、谁该投票是规则；「他说了什么」是 AI/玩家的事——引擎只管把状态推到下一步。
//
// 一局的状态都在 session 上：
//   phase       当前阶段（见 PHASES）
//   round       第几天（1 起）
//   roundId     每推进一个「结算」自增，用来丢弃过期响应（照 textAdventure 的比对思路）
//   revealMode  'open'（明牌：出局即报身份）| 'hidden'（暗牌：出局不带身份，技能没发动就静默）
//   seats[]     { seat, kind, characterId|npcId, name, role, alive }
//   events[]    事件流水（type/text/round/seat）；isPublic:false 的（目前只有狼队频道 wolfchat）
//               永不进 publicFeed，界面侧另按 type 过一遍才决定给谁看
//   votes{}     本轮投票 { 投票者座号: 目标座号 }——投票时静默，开票（settleVote）时才一次性进流水
//   seerLog[]   验人结果（私有，只有那个预言家能看到自己的）
//   guardLog[]  守过谁（私有，只有那个守卫能看到自己的；「不能连守」也读它）
//   aiNotes{}   各座位的 AI 私有笔记（按座号分组，只有本人能看到自己的；写入走 addNote）
//   pendingShot 死掉的猎人还没开枪时挂在这里
//   winner      'wolf' | 'good' | null
//
// 两条与「谁能知道什么」有关的规则：
// ① 阶段固定走：不因为某个身份死了就跳过它对应的阶段（比如守卫不在世也照样进 night_guard、预言家死了照样进 night_seer），
//    否则「阶段变了」本身就泄漏了「那个人不在了」。跳过逻辑在 UI 侧（没人可行动时点一下过去）。
// ② 文案里带不带身份由 revealMode 决定：明牌局把「（猎人）」写进流水，暗牌局一个字都不提。
// ③ 私有事件靠两道闸：isPublic:false 挡住 AI（publicFeed 是白名单），type 挡住界面（renderFeed 只给该看的人）。

import { getBoard, factionOf, roleLabel, revealModeOf } from './werewolfRooms.js';

/* ---------------- 阶段 ---------------- */

export const PHASES = [
    'night_guard',    // 守卫守人（排在狼前面：先守后刀，守卫手里不可能有今晚的刀口）
    'night_wolf',     // 狼队商量刀谁
    'night_seer',     // 预言家验人
    'night_resolve',  // 夜里的事落定（进 dawn 之前）
    'dawn',           // 公布死讯 / 平安夜
    'day_speak',      // 依次发言
    'day_vote',       // 全员投票
    'day_verdict',    // 开票处决
    'hunter_shot',    // 猎人开枪（夜里或白天出局都会停在这里）
    'ended'
];

export const PHASE_LABEL = {
    night_guard: '第一夜 · 守卫守护',
    night_wolf: '第一夜 · 狼人行动',
    night_seer: '第一夜 · 预言家验人',
    night_resolve: '天快亮了',
    dawn: '天亮',
    day_speak: '白天 · 依次发言',
    day_vote: '白天 · 投票',
    day_verdict: '开票',
    hunter_shot: '猎人开枪',
    ended: '本局结束'
};

export function phaseLabel(session) {
    const base = PHASE_LABEL[session?.phase] || '';
    if (!base) return '';
    if (session.phase.startsWith('night')) return base.replace('第一夜', `第 ${session.round || 1} 夜`);
    if (session.phase.startsWith('day')) return base.replace('白天', `第 ${session.round || 1} 天`);
    return base;
}

/* ---------------- 查询 ---------------- */

export function seatAt(session, seatNo) {
    return (session?.seats || []).find(s => s.seat === seatNo) || null;
}

export function aliveSeats(session) {
    return (session?.seats || []).filter(s => s.alive !== false)
        .slice().sort((a, b) => a.seat - b.seat);
}

export function deadSeats(session) {
    return (session?.seats || []).filter(s => s.alive === false)
        .slice().sort((a, b) => a.seat - b.seat);
}

export function seatsOfRole(session, roleId) {
    return (session?.seats || []).filter(s => s.role === roleId);
}

export function wolvesOf(session) {
    return seatsOfRole(session, 'werewolf');
}

/** 场上还有活着的这个身份吗（界面判断「这一步有没有人可行动」用；引擎不据此跳阶段——见头部规则①） */
export function hasLiveRole(session, roleId) {
    return seatsOfRole(session, roleId).some(s => s.alive !== false);
}

export function aliveCountOf(session, faction) {
    return aliveSeats(session).filter(s => factionOf(s.role) === faction).length;
}

/** 谁是下一个还没发言的活人（发言按座号顺序） */
export function currentSpeaker(session) {
    const spoke = new Set(session?.spokeThisRound || []);
    return aliveSeats(session).find(s => !spoke.has(s.seat)) || null;
}

/** 谁是下一个还没投票的活人 */
export function currentVoter(session) {
    const voted = new Set(Object.keys(session?.votes || {}).map(Number));
    return aliveSeats(session).find(s => !voted.has(s.seat)) || null;
}

export function wolfTargets(session) {
    return aliveSeats(session).filter(s => s.role !== 'werewolf');
}

export function seerTargets(session, seatNo) {
    // 验过的人不必再验；同一个人可以重复验，但 AI 一般不会
    return aliveSeats(session).filter(s => s.seat !== seatNo);
}

/**
 * 这个守卫**上一夜**守过谁（或 null）。
 * 「不能连续两夜守同一人」的唯一数据源：引擎校验、AI 层挑目标、界面禁用位三处共用同一份判断。
 * 只看上一夜（round 恰好是 session.round - 1）的记录——隔了一夜再守同一个人是合规的，
 * 所以这里不能写成「最后一条记录」。
 */
export function lastGuardTarget(session, seatNo) {
    const prev = (session.round || 1) - 1;
    if (prev < 1) return null;
    const mine = (session.guardLog || []).filter(g => g.by === seatNo && g.round === prev);
    return mine.length ? mine[mine.length - 1].seat : null;
}

/** 守卫今晚能守谁：所有活人（含自己，也可含狼）减去上一夜守过的那位 */
export function guardTargets(session, seatNo) {
    const prev = lastGuardTarget(session, seatNo);
    return aliveSeats(session).filter(s => s.seat !== prev);
}

/** 该角色（AI 或玩家）这一局自己知道的事 */
export function viewOf(session, seatNo) {
    const me = seatAt(session, seatNo);
    if (!me) return null;
    const out = {
        seat: me.seat,
        name: me.name,
        role: me.role,
        roleLabel: roleLabel(me.role),
        faction: factionOf(me.role),
        alive: me.alive !== false
    };
    if (me.role === 'werewolf') {
        out.teammates = wolvesOf(session).filter(s => s.seat !== seatNo).map(s => ({ seat: s.seat, name: s.name }));
    }
    if (me.role === 'seer') {
        out.checks = (session.seerLog || []).filter(e => e.by === seatNo)
            .map(e => ({ round: e.round, seat: e.seat, name: seatAt(session, e.seat)?.name || '', isWolf: e.isWolf }));
    }
    // 守卫只知道「我守了谁」，**不知道守中没有**（守中与狼空刀在公开流水上一样），所以这里没有 saved
    if (me.role === 'guard') {
        out.guarded = (session.guardLog || []).filter(g => g.by === seatNo)
            .map(g => ({ round: g.round, seat: g.seat, name: seatAt(session, g.seat)?.name || '' }));
    }
    return out;
}

/* ---------------- 发牌与开局 ---------------- */

/* ---------------- 出局文案（明牌局才带身份） ---------------- */

function isOpen(session) {
    return revealModeOf(session) === 'open';
}

/** 明牌局给死者补上「（猎人）」，暗牌局返回空串——流水里一个字都不提身份 */
function roleTag(session, seat) {
    return isOpen(session) && seat?.role ? `（${roleLabel(seat.role)}）` : '';
}

/**
 * 「名字（身份）」/「名字 」——出局文案里名字与动词之间要一个空格，
 * 但全角括号后面不必再空一格（否则会读成「戊（村民） 被投出局」）。
 */
function nameWithRole(session, seat) {
    const tag = roleTag(session, seat);
    return tag ? `${seat.name}${tag}` : `${seat.name} `;
}

function shuffle(list, rng) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

export function pushEvent(session, { round = session.round || 1, type = 'system', seat = null, text = '', isPublic = true } = {}) {
    session.events = [...(session.events || []), { t: Date.now(), round, type, seat, text, isPublic }].slice(-200);
    return session.events[session.events.length - 1];
}

/* ---------------- 私有笔记（每个 AI 决策的副产物） ---------------- */

export const NOTE_LIMIT_PER_SEAT = 30;   // 每个座位最多留多少条（截尾，新的留着）
export const NOTE_MAX_CHARS = 80;        // 一条笔记的长度上限

/**
 * 收下某个 AI 给**自己座位**记的一条私有笔记（它这一轮决策的副产物）。
 * 只进 session.aiNotes[它自己]，下轮回灌它自己的提示词；不进 events、不进 publicFeed，别人看不到。
 *
 * 放在引擎里跟 seerLog/guardLog 一处：这就是「session 上的私有记录」，与 AI 无关
 * （谁来写、写成什么格式是上层的事）。**调用点必须在 runTurn 的 apply 回调里**——
 * call 阶段改的是内存副本，mutateSession 会重新从库里读，写在那儿会丢。
 */
export function addNote(session, seatNo, { kind = '', text = '' } = {}) {
    const body = String(text || '').trim().slice(0, NOTE_MAX_CHARS);
    if (!session || !seatNo || !body) return false;
    const all = session.aiNotes = session.aiNotes || {};
    all[seatNo] = [...(all[seatNo] || []), { round: session.round || 1, kind, text: body }]
        .slice(-NOTE_LIMIT_PER_SEAT);
    return true;
}

/**
 * 发牌开局（座位必须坐满）
 * @returns {boolean} 是否开成
 */
export function startGame(session, { rng = Math.random } = {}) {
    const board = getBoard(session?.boardId);
    const seats = [...(session.seats || [])].sort((a, b) => a.seat - b.seat);
    if (seats.length !== board.seats) return false;

    const roles = [];
    for (const [role, n] of Object.entries(board.roles)) for (let i = 0; i < n; i++) roles.push(role);
    const dealt = shuffle(roles, rng);
    seats.forEach((s, i) => { s.role = dealt[i]; s.alive = true; });

    session.seats = seats;
    session.status = 'ongoing';
    session.phase = 'night_guard';
    session.round = 1;
    session.roundId = (session.roundId || 0) + 1;
    session.events = [];
    session.votes = {};
    session.spokeThisRound = [];
    session.seerLog = [];
    session.guardLog = [];
    session.aiNotes = {};
    session.pendingShot = null;
    session.pending = null;
    session.winner = null;
    session.night = {};
    // 流水只记「发生了什么」：板子构成是规则，不进公开事件（否则 publicFeed 里会多出身份词）
    pushEvent(session, { type: 'system', text: '第 1 夜：天黑请闭眼' });
    return true;
}

/* ---------------- 夜晚 ---------------- */

/**
 * 守卫守人。只写自己的 guardLog（私有），**不进公开流水**——守没守中由 settleNight 结算，
 * 而且守中与狼空刀对外的说法逐字相同，谁也不知道这一守有没有用（守卫自己也不知道）。
 * 拒绝时零写入：阶段不对 / 不是活守卫 / 目标不在场或已出局 / 连守同一个人。
 */
export function applyGuard(session, seatNo, targetSeat) {
    if (session.phase !== 'night_guard') return false;
    const me = seatAt(session, seatNo);
    if (!me || me.role !== 'guard' || me.alive === false) return false;
    const target = seatAt(session, targetSeat);
    if (!target || target.alive === false) return false;
    if (targetSeat === lastGuardTarget(session, seatNo)) return false;
    session.night = { ...(session.night || {}), guardTarget: targetSeat };
    session.guardLog = [...(session.guardLog || []), { by: seatNo, seat: targetSeat, round: session.round || 1 }];
    // 阶段固定走：狼人不在世也进 night_wolf（UI 侧没人可行动时点一下直接过去）
    session.phase = 'night_wolf';
    return true;
}

/** 狼队刀人 */
export function applyWolfKill(session, targetSeat) {
    if (session.phase !== 'night_wolf') return false;
    const target = seatAt(session, targetSeat);
    if (!target || target.alive === false || target.role === 'werewolf') return false;
    session.night = { ...(session.night || {}), wolfTarget: targetSeat };
    // 阶段固定走：预言家不在世也进 night_seer（UI 侧没人可行动时点一下直接过去）
    session.phase = 'night_seer';
    return true;
}

/**
 * 狼队各提各的，合成一个：**多数说了算**；没人过半（含两只狼提得不一样）时只在并列最多的那几个里摇号。
 * 一致时【不摇号】——调用方和测试都靠这一点区分「商量好了」与「摇出来的」。
 * 并列时先按座号升序再摇：不然「谁先提」会悄悄决定结果，同一份提名换个顺序就换个人死。
 * 全弃权返回 null。rng 从参数进来，跟 shuffle/startGame 一个规矩。
 */
function pickWolfTarget(targets = [], rng = Math.random) {
    const named = targets.filter(t => t != null);
    if (!named.length) return null;
    const counts = new Map();
    for (const t of named) counts.set(t, (counts.get(t) || 0) + 1);
    const max = Math.max(...counts.values());
    const top = [...counts.keys()].filter(t => counts.get(t) === max).sort((a, b) => a - b);
    return top.length === 1 ? top[0] : top[Math.floor(rng() * top.length)];
}

/**
 * 两只狼的刀口合并（`pickWolfTarget` 的两票版，单独导出给测试与老调用点用）。
 * 四种情形与从前逐字等价：一边只提一个就用那个、提得一样就用那个、不一样才摇号、都没提就是弃权。
 */
export function resolveWolfKill(mineTarget, mateTarget, rng = Math.random) {
    return pickWolfTarget([mineTarget, mateTarget], rng);
}

/**
 * 狼队定案：每只狼各自的提名、模型模拟的频道对话、合并结果都写进「狼队频道」，然后落刀。
 *
 * 频道行是**私有事件**（isPublic:false）——publicFeed 的白名单会滤掉，永远进不了任何 AI 的提示词；
 * 文案一律只写名字、不碰 roleTag，免得暗牌局从频道里漏出「（狼人）」。
 * 「写频道」和「落刀」放在同一次调用里：不然会出现库里记了提案、刀却没落上的中间态。
 *
 * @param {object} session
 * @param {object} plan
 * @param {Array<{seat:number, target:number|null, reason?:string}>} plan.plans 每只狼的提名（含主视角）
 * @param {Array<{seat:number, text:string}>} [plan.chat]  模型模拟的频道对话，原样入频道
 * @param {number|null} [plan.playerSeat]  主视角座位；他那一行按「原话（提议刀 N 号）」写
 * @param {string} [plan.note]             主视角留给队友的那句话（可空）
 * @param {function} [plan.rng]
 * @returns {boolean}
 */
export function applyWolfPlan(session, plan = {}) {
    // 阶段闸门：night_wolf→night_seer 这一步 roundId 不变，runTurn 的过期比对拦不住重入，这一行才是闸
    if (session.phase !== 'night_wolf') return false;
    const { chat = [], playerSeat = null, note = '', rng = Math.random } = plan;
    const raw = Array.isArray(plan.plans) ? plan.plans : [];
    if (!raw.length) return false;

    // 校验：每条提名都得是一只还活着的狼，同一个人不能提两次；目标要么在合法刀口里、要么弃权
    const nameOf = seatNo => seatAt(session, seatNo)?.name || '';
    const legal = wolfTargets(session).map(s => s.seat);
    const seen = [];
    for (const p of raw) {
        const seat = seatAt(session, Number(p?.seat));
        if (!seat || seat.role !== 'werewolf' || seat.alive === false || seen.includes(seat.seat)) return false;
        seen.push(seat.seat);
    }
    const picks = raw.map(p => ({
        seat: Number(p.seat),
        target: legal.includes(Number(p?.target)) ? Number(p.target) : null,
        reason: String(p?.reason || '')
    }));

    const line = (seat, text) => pushEvent(session, { type: 'wolfchat', seat, text, isPublic: false });
    const minePick = picks.find(p => p.seat === playerSeat) || null;

    // 主视角那一行：他留了话、或者提了刀，才写
    if (playerSeat != null && (note || minePick?.target != null)) {
        line(playerSeat, minePick?.target != null
            ? `${playerSeat} 号 ${nameOf(playerSeat)}${note ? `：${note}` : ''}（提议刀 ${minePick.target} 号 ${nameOf(minePick.target)}）`
            : `${playerSeat} 号 ${nameOf(playerSeat)}：${note}`);
    }
    // 模型模拟的对话原样进频道（座位必须是这轮真的在场的狼，防模型串座位）
    for (const c of (Array.isArray(chat) ? chat : [])) {
        const seat = seatAt(session, Number(c?.seat));
        const body = String(c?.text || '').trim();
        if (!seat || !seen.includes(seat.seat) || !body) continue;
        line(seat.seat, `${seat.seat} 号 ${seat.name}：${body}`);
    }

    const pick = pickWolfTarget(picks.map(p => p.target), rng) ?? legal[0] ?? null;

    // 提名不一致时补一条汇总：多数说了算，票数一样才是摇号——别把「多数」说成「随机」
    const named = picks.filter(p => p.target != null);
    const distinct = [...new Set(named.map(p => p.target))];
    if (pick != null && distinct.length >= 2) {
        const counts = new Map();
        for (const p of named) counts.set(p.target, (counts.get(p.target) || 0) + 1);
        const majority = counts.get(pick) > 1;
        line(null, majority
            ? `你们说的不一样，多数要刀 ${pick} 号 ${nameOf(pick)}`
            : `你们说的不一样（${distinct.slice().sort((a, b) => a - b).join('、')} 号），随机取了一个：刀 ${pick} 号 ${nameOf(pick)}`);
    }
    // 规则上一个合法目标都没有（对局里不该出现）：别把人卡在点不动的夜里
    if (pick == null) { session.phase = 'night_seer'; return true; }
    return applyWolfKill(session, pick);
}

/** 预言家验人：结果只进它自己的 seerLog */
export function applySeerCheck(session, seatNo, targetSeat) {
    if (session.phase !== 'night_seer') return false;
    const me = seatAt(session, seatNo);
    const target = seatAt(session, targetSeat);
    if (!me || me.role !== 'seer' || me.alive === false) return false;
    if (!target || target.alive === false) return false;
    const isWolf = target.role === 'werewolf';
    session.night = { ...(session.night || {}), seerTarget: targetSeat };
    session.seerLog = [...(session.seerLog || []), { by: seatNo, seat: targetSeat, isWolf, round: session.round }];
    session.phase = 'night_resolve';
    return true;
}

/**
 * 结算夜里的事：刀口落定、死讯上流水、猎人挂起待开枪
 * 守卫守中刀口就是平安夜，走的是与「狼空刀」**逐字相同**的那条分支——公开流水里分不出这两种，
 * 这是刻意的：暗牌局不能从死讯反推守卫守了谁。
 * @returns {{deaths:number[], peaceful:boolean}}
 */
export function settleNight(session) {
    const night = session.night || {};
    const target = night.wolfTarget;
    const guarded = target != null && night.guardTarget === target;
    const seat = target ? seatAt(session, target) : null;
    const deaths = [];

    if (seat && seat.alive !== false && !guarded) {
        seat.alive = false;
        deaths.push(seat.seat);
        pushEvent(session, { type: 'death', seat: seat.seat, text: `${seat.seat} 号 ${nameWithRole(session, seat)}昨夜出局` });
    } else {
        pushEvent(session, { type: 'system', text: '昨晚是平安夜，没有人出局' });
    }

    session.roundId = (session.roundId || 0) + 1;
    session.spokeThisRound = [];
    session.votes = {};
    session.night = {};

    // 猎人被刀：先停下来等它开枪
    const shot = deaths.map(s => seatAt(session, s)).find(s => s.role === 'hunter');
    if (shot) {
        session.pendingShot = { seat: shot.seat, name: shot.name, after: 'dawn' };
        session.phase = 'hunter_shot';
        return { deaths, peaceful: !deaths.length };
    }
    session.phase = nextOrEnd(session, 'dawn');
    return { deaths, peaceful: !deaths.length };
}

/* ---------------- 白天 ---------------- */

/** 天亮那一拍看完死讯，进白天的发言环节 */
export function startDay(session) {
    if (session.phase !== 'dawn') return false;
    session.phase = 'day_speak';
    pushEvent(session, { type: 'system', text: '天亮了，从活着的人里按座号挨个发言' });
    return true;
}

/** 记一段发言（正文由 AI 或玩家给，引擎只记账） */
export function applySpeech(session, seatNo, text) {
    if (session.phase !== 'day_speak') return false;
    const me = seatAt(session, seatNo);
    if (!me || me.alive === false) return false;
    if ((session.spokeThisRound || []).includes(seatNo)) return false;
    session.spokeThisRound = [...(session.spokeThisRound || []), seatNo];
    pushEvent(session, { type: 'speak', seat: seatNo, text: `${seatNo} 号 ${me.name}：${text}` });
    const next = currentSpeaker(session);
    if (!next) session.phase = 'day_vote';
    return true;
}

/**
 * 记一张票。投票阶段是**静默**的：只记进 session.votes，不进公开流水——
 * 票型由开票（settleVote）一次性摊开，否则后面的投票者（尤其 AI）
 * 会照着已经投出来的票走，票型也提前透明了。
 */
export function applyVote(session, fromSeat, targetSeat) {
    if (session.phase !== 'day_vote') return false;
    const from = seatAt(session, fromSeat);
    const target = seatAt(session, targetSeat);
    if (!from || from.alive === false) return false;
    // 弃票也占位（存 null）：投过就不能再投，与 currentVoter 的口径一致
    if (Object.prototype.hasOwnProperty.call(session.votes || {}, fromSeat)) return false;
    // 目标必须是场上真的存在的座位：AI 报一个不存在的座号不能把票记进去（结算时会找不到人）
    if (targetSeat != null && !target) return false;
    // 可以弃票（targetSeat 为 null）——弃票不进目标票数
    session.votes = { ...(session.votes || {}), [fromSeat]: targetSeat ?? null };
    if (!currentVoter(session)) session.phase = 'day_verdict';
    return true;
}

/** 计票：返回每个目标得几票，以及票数最高的（可能并列） */
export function tallyVotes(votes) {
    const counts = {};
    for (const target of Object.values(votes || {})) {
        if (target == null) continue;
        counts[target] = (counts[target] || 0) + 1;
    }
    const max = Math.max(0, ...Object.values(counts));
    const top = max > 0 ? Object.keys(counts).filter(k => counts[k] === max).map(Number).sort((a, b) => a - b) : [];
    return { counts, top, tie: top.length > 1, max };
}

/**
 * 开票：把这一轮静默收下来的票**一次性**摊开——逐票明细（座号升序）+ 一条汇总。
 * 投票过程中票不进流水，就是在这里补上的；AI 也是到这一刻才在 publicFeed 里看到票型。
 */
function revealVotes(session, counts) {
    const votes = session.votes || {};
    const froms = Object.keys(votes).map(Number).sort((a, b) => a - b);

    for (const fromSeat of froms) {
        const from = seatAt(session, fromSeat);
        const target = votes[fromSeat] != null ? seatAt(session, votes[fromSeat]) : null;
        pushEvent(session, {
            type: 'vote', seat: fromSeat,
            text: target
                ? `${fromSeat} 号 ${from?.name || ''} 投了 ${target.seat} 号 ${target.name}`
                : `${fromSeat} 号 ${from?.name || ''} 弃票`
        });
    }

    const lines = Object.keys(counts).map(Number)
        .sort((a, b) => counts[b] - counts[a] || a - b)
        .map(seatNo => `${seatNo} 号 ${seatAt(session, seatNo)?.name || ''} ${counts[seatNo]} 票`);
    const abstained = froms.filter(s => votes[s] == null).length;
    if (abstained) lines.push(`弃票 ${abstained} 人`);
    pushEvent(session, { type: 'tally', text: lines.length ? `票数：${lines.join('｜')}` : '没有人得票' });
}

/**
 * 开票：票最高者出局，平票或全弃票则本轮无人出局
 * @returns {{out:number|null, tie:boolean, counts:object}}
 */
export function settleVote(session) {
    const { counts, top, tie } = tallyVotes(session.votes);
    const out = top.length === 1 ? top[0] : null;

    revealVotes(session, counts);

    if (out === null) {
        pushEvent(session, { type: 'system', text: tie ? `平票（${top.join('、')} 号同票），本轮没有人出局` : '没有人得票，本轮没有人出局' });
    } else {
        const seat = seatAt(session, out);
        seat.alive = false;
        pushEvent(session, { type: 'verdict', seat: out, text: `${out} 号 ${nameWithRole(session, seat)}被投出局（${counts[out]} 票）` });
    }

    session.roundId = (session.roundId || 0) + 1;
    const shot = out !== null ? seatAt(session, out) : null;
    if (shot && shot.role === 'hunter') {
        session.pendingShot = { seat: shot.seat, name: shot.name, after: 'night' };
        session.phase = 'hunter_shot';
        return { out, tie, counts };
    }
    return { out, tie, counts, phase: startNextNightPhase(session) };
}

/** 猎人开枪（弃枪传 null）。文案按明牌/暗牌分叉——暗牌局里「没发动」一个字都不留 */
export function applyHunterShot(session, targetSeat) {
    const pending = session.pendingShot;
    if (!pending) return false;
    const after = pending.after || 'dawn';

    if (targetSeat == null) {
        // 暗牌局不写「没有开枪」：那等于告诉全场他是猎人
        if (isOpen(session)) {
            pushEvent(session, { type: 'system', text: `${pending.seat} 号 ${pending.name}（猎人）没有开枪` });
        }
    } else {
        const target = seatAt(session, targetSeat);
        if (!target || target.alive === false) return false;
        target.alive = false;
        pushEvent(session, {
            type: 'shot', seat: pending.seat,
            text: isOpen(session)
                ? `${pending.seat} 号 ${pending.name}（猎人）开枪带走了 ${target.seat} 号 ${target.name}`
                : `${pending.seat} 号 ${pending.name} 发动了技能，${target.seat} 号 ${target.name} 出局`
        });
    }
    session.pendingShot = null;
    session.roundId = (session.roundId || 0) + 1;

    // 白天被投出局的猎人：天亮前还有一夜要过；夜里被刀的猎人：接着走白天
    session.phase = nextOrEnd(session, after === 'night' ? startNextNightPhase(session) : 'dawn');
    return true;
}

function startNextNightPhase(session) {
    session.round = (session.round || 1) + 1;
    session.spokeThisRound = [];
    session.votes = {};
    session.night = {};
    pushEvent(session, { type: 'system', text: `第 ${session.round} 夜：天黑请闭眼` });
    return nextOrEnd(session, 'night_guard');
}

/* ---------------- 胜负 ---------------- */

/** @returns {'wolf'|'good'|null} */
export function checkWinner(session) {
    const seats = session?.seats || [];
    if (!seats.length || seats.some(s => !s.role)) return null;
    const wolves = aliveCountOf(session, 'wolf');
    const goods = aliveCountOf(session, 'good');
    if (wolves === 0) return 'good';
    if (wolves >= goods) return 'wolf';
    return null;
}

/** 判胜负；结束了就停在 ended，没结束就进 nextPhase */
function nextOrEnd(session, nextPhase) {
    const winner = checkWinner(session);
    if (winner) {
        session.status = 'ended';
        session.phase = 'ended';
        session.winner = winner;
        session.endedAt = Date.now();
        pushEvent(session, {
            type: 'end',
            text: winner === 'wolf' ? '狼人获胜：存活狼数已追平好人' : '好人获胜：狼人全部出局'
        });
        return 'ended';
    }
    session.phase = nextPhase;
    return nextPhase;
}

/* ---------------- 公开信息（④的提示词就吃这个） ---------------- */

/**
 * 公开事件白名单：每个角色看到的这一段必须逐字一致。
 * 只取 isPublic 的事件 + 存活/出局名单；私有的验人结果、任何人的标签都不在这里。
 */
export function publicFeed(session, { limit = 40 } = {}) {
    const alive = aliveSeats(session).map(s => `${s.seat} 号 ${s.name}`).join('、');
    const dead = deadSeats(session).map(s => `${s.seat} 号 ${s.name}`).join('、');
    const events = (session.events || []).filter(e => e.isPublic).slice(-limit);
    return [
        `【场上】存活：${alive || '无'}${dead ? `｜已出局：${dead}` : ''}`,
        events.length ? `【已经发生的事】\n${events.map(e => `· ${e.text}`).join('\n')}` : ''
    ].filter(Boolean).join('\n');
}

/** 一局结束后各座位的结果（结算与战绩用） */
export function finalResult(session) {
    const winner = session.winner;
    return (session.seats || []).map(s => ({
        seat: s.seat,
        name: s.name,
        characterId: s.characterId || null,
        npcId: s.npcId || null,
        role: s.role,
        faction: factionOf(s.role),
        alive: s.alive !== false,
        win: winner ? factionOf(s.role) === winner : false
    }));
}

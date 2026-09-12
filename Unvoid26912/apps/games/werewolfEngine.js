// apps/games/werewolfEngine.js — 狼人杀规则引擎
//
// 边界：**纯规则，无 DOM、无存储、无 AI、无随机副作用**（随机数从参数传进来，默认 Math.random）。
// 谁该说话、谁该投票是规则；「他说了什么」是 AI/玩家的事——引擎只管把状态推到下一步。
//
// 一局的状态都在 session 上：
//   phase       当前阶段（见 PHASES）
//   round       第几天（1 起）
//   roundId     每推进一个「结算」自增，用来丢弃过期响应（照 textAdventure 的比对思路）
//   seats[]     { seat, kind, characterId|npcId, name, role, alive }
//   events[]    公开事件流水（type/text/round/seat），【判断】这类私有信息不进这里
//   votes{}     本轮投票 { 投票者座号: 目标座号 }
//   seerLog[]   验人结果（私有，只有那个预言家能看到自己的）
//   pendingShot 死掉的猎人还没开枪时挂在这里
//   winner      'wolf' | 'good' | null

import { getBoard, factionOf, roleLabel } from './werewolfRooms.js';

/* ---------------- 阶段 ---------------- */

export const PHASES = [
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
    return out;
}

/* ---------------- 发牌与开局 ---------------- */

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
    session.phase = 'night_wolf';
    session.round = 1;
    session.roundId = (session.roundId || 0) + 1;
    session.events = [];
    session.votes = {};
    session.spokeThisRound = [];
    session.seerLog = [];
    session.pendingShot = null;
    session.pending = null;
    session.winner = null;
    session.night = {};
    // 流水只记「发生了什么」：板子构成是规则，不进公开事件（否则 publicFeed 里会多出身份词）
    pushEvent(session, { type: 'system', text: '第 1 夜：天黑请闭眼' });
    return true;
}

/* ---------------- 夜晚 ---------------- */

/** 狼队刀人 */
export function applyWolfKill(session, targetSeat) {
    if (session.phase !== 'night_wolf') return false;
    const target = seatAt(session, targetSeat);
    if (!target || target.alive === false || target.role === 'werewolf') return false;
    session.night = { ...(session.night || {}), wolfTarget: targetSeat };
    session.phase = seatsOfRole(session, 'seer').some(s => s.alive !== false) ? 'night_seer' : 'night_resolve';
    return true;
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
 * @returns {{deaths:number[], peaceful:boolean}}
 */
export function settleNight(session) {
    const target = (session.night || {}).wolfTarget;
    const seat = target ? seatAt(session, target) : null;
    const deaths = [];

    if (seat && seat.alive !== false) {
        seat.alive = false;
        deaths.push(seat.seat);
        pushEvent(session, { type: 'death', seat: seat.seat, text: `${seat.seat} 号 ${seat.name} 昨夜出局` });
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

/** 记一张票（投票是公开的，当场记流水） */
export function applyVote(session, fromSeat, targetSeat) {
    if (session.phase !== 'day_vote') return false;
    const from = seatAt(session, fromSeat);
    const target = seatAt(session, targetSeat);
    if (!from || from.alive === false) return false;
    if (session.votes?.[fromSeat] != null) return false;
    // 可以弃票（targetSeat 为 null）——弃票不进目标票数
    session.votes = { ...(session.votes || {}), [fromSeat]: targetSeat ?? null };
    const t = targetSeat ? seatAt(session, targetSeat) : null;
    pushEvent(session, {
        type: 'vote', seat: fromSeat,
        text: t ? `${fromSeat} 号 ${from.name} 投了 ${t.seat} 号 ${t.name}` : `${fromSeat} 号 ${from.name} 弃票`
    });
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
 * 开票：票最高者出局，平票或全弃票则本轮无人出局
 * @returns {{out:number|null, tie:boolean, counts:object}}
 */
export function settleVote(session) {
    const { counts, top, tie } = tallyVotes(session.votes);
    const out = top.length === 1 ? top[0] : null;

    if (out === null) {
        pushEvent(session, { type: 'system', text: tie ? `平票（${top.join('、')} 号同票），本轮没有人出局` : '没有人得票，本轮没有人出局' });
    } else {
        const seat = seatAt(session, out);
        seat.alive = false;
        pushEvent(session, { type: 'verdict', seat: out, text: `${out} 号 ${seat.name} 被投出局（${counts[out]} 票）` });
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

/** 猎人开枪（弃枪传 null） */
export function applyHunterShot(session, targetSeat) {
    const pending = session.pendingShot;
    if (!pending) return false;
    const after = pending.after || 'dawn';
    const me = seatAt(session, pending.seat);

    if (targetSeat == null) {
        pushEvent(session, { type: 'system', text: `${pending.seat} 号 ${pending.name} 没有开枪` });
    } else {
        const target = seatAt(session, targetSeat);
        if (!target || target.alive === false) return false;
        target.alive = false;
        pushEvent(session, { type: 'shot', seat: pending.seat, text: `${pending.seat} 号 ${pending.name}（猎人）开枪带走了 ${target.seat} 号 ${target.name}` });
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
    return nextOrEnd(session, 'night_wolf');
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

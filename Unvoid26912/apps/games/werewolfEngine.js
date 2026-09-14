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
//   morningDeaths 昨夜的死者（公布次序：刀→毒→枪），结算时记；下一天结算时被覆盖
//   speakPlan   这一天的发言次序：{ side, dir, anchor, start }。**没有警长时由系统掷**
//               （rollSpeakPlan，掷一次管一整天：发言与 PK 台上同一条次序）
//   seats[]     { seat, kind, characterId|npcId, name, role, alive }
//   events[]    事件流水（type/text/round/seat）；isPublic:false 的（目前只有狼队频道 wolfchat）
//               永不进 publicFeed，界面侧另按 type 过一遍才决定给谁看
//   votes{}     本轮投票 { 投票者座号: 目标座号 }——投票时静默，开票（settleVote）时才一次性进流水
//   pk          平票开的那一台 { seats[], spoke[], votes{} }；台上的人不投票、台下只能投台上的人。
//               补投的票同样静默（存 pk.votes），开票也走 settleVote（认 pk 分流到 settlePk）
//   seerLog[]   验人结果（私有，只有那个预言家能看到自己的）
//   guardLog[]  守过谁（私有，只有那个守卫能看到自己的；「不能连守」也读它）
//   aiNotes{}   各座位的 AI 私有笔记（按座号分组，只有本人能看到自己的；写入走 addNote）
//   aiLabels{}  各座位给场上的人贴的判断（`{ 目标座号: '标签' }`，只有本人能看到自己的；
//               写入走 mergeLabels——一个人只有一个标签，能改能撤，见那里的说明）
//   aiHearts{}  各座位投票那一刻的「心声」（按座号分组，写入走 addHeart）。**今天只写不读**：
//               它天生带身份，进别人的视角就是上帝视角；但它**属于写出它的那个角色**，
//               以后要给它自己用（比如聊天）是另一回事——红线是「不进别人的提示词」，不是「永不读」
//   deathQueue[] 刚出局的人挨个走的流程（`{seat, act, done}`，见 startDeathQueue）；走完这批才继续
//   deathAfter  这批人走完去哪：'day' 进白天发言（夜里的死讯）/ 'night' 入夜（白天票出的）
//   lastWordsSpoken[] 已经留过遗言的座位（一局内记账，与「这一轮说过话」无关）
//   potions{}   女巫的药 { 座号: {heal, poison} }（私有）；witchLog[] 她历夜被告知过的刀口
//   wordsDraft{} 各座位**出局前就写好的遗言**（按座号存，公布死讯后轮到他时直接取用，省一次调用）
//   winner      'wolf' | 'good' | null
//
// 两条与「谁能知道什么」有关的规则：
// ① 阶段固定走：不因为某个身份死了就跳过它对应的阶段（比如守卫不在世也照样进 night_guard、预言家死了照样进 night_seer），
//    否则「阶段变了」本身就泄漏了「那个人不在了」。跳过逻辑在 UI 侧（没人可行动时点一下过去）。
// ② 文案里带不带身份由 revealMode 决定：明牌局把「（猎人）」写进流水，暗牌局一个字都不提。
// ③ 私有事件靠两道闸：isPublic:false 挡住 AI（publicFeed 是白名单），type 挡住界面（renderFeed 只给该看的人）。

import { getBoard, factionOf, roleLabel, revealModeOf, winModeOf, sideOf, wordsEnabled, pkEnabled, markTagsOf } from './werewolfRooms.js';

/* ---------------- 阶段 ---------------- */

export const PHASES = [
    'night_guard',    // 守卫守人（排在狼前面：先守后刀，守卫手里不可能有今晚的刀口）
    'night_wolf',     // 狼队商量刀谁
    'night_witch',    // 女巫用药（12 人板才有这一步：放在狼刀之后，她得先看到刀口）
    'night_seer',     // 预言家验人
    'night_hunter',   // 叫醒猎人（面杀里每夜都有这一拍：被刀会死的那个才被告知「你被刀了」并决定开不开枪）
    'night_resolve',  // 夜里的事落定（进 dawn 之前）
    'dawn',           // 天亮了：公布死讯 / 平安夜；出局者的流程接在这一拍之后
    'day_speak',      // 依次发言
    'day_vote',       // 全员投票
    'day_verdict',    // 开票处决（PK 台下的补投也停在这一拍：settleVote 看有没有 pk 分流）
    'day_pk',         // 平票上台的人各自再说一轮
    'day_pk_vote',    // 台下的人补投一轮（只能投台上的人或弃票）
    'skill_wait',     // 出局者的流程（一次一个：等待发动技能 →［遗言］）。夜里的死讯与白天被票出都走这里
    'last_words',     // 同一个人的第二拍：该他留遗言（板子开了遗言、而他又有遗言权时才走到）
    'ended'
];

export const PHASE_LABEL = {
    night_guard: '第一夜 · 守卫守护',
    night_wolf: '第一夜 · 狼人行动',
    night_witch: '第一夜 · 女巫用药',
    night_seer: '第一夜 · 预言家验人',
    night_hunter: '第一夜 · 猎人',
    night_resolve: '天快亮了',
    dawn: '天亮',
    day_speak: '白天 · 依次发言',
    day_vote: '白天 · 投票',
    day_verdict: '开票',
    day_pk: '白天 · PK 发言',
    day_pk_vote: '白天 · PK 投票',
    skill_wait: '等待发动技能',
    last_words: '遗言',
    ended: '本局结束'
};

export function phaseLabel(session) {
    const base = PHASE_LABEL[session?.phase] || '';
    if (!base) return '';
    if (session.phase.startsWith('night')) return base.replace('第一夜', `第 ${session.round || 1} 夜`);
    if (session.phase.startsWith('day')) return base.replace('白天', `第 ${session.round || 1} 天`);
    return base;
}

/**
 * 夜里依次走哪几步。板子写了 `nightOrder` 就按它的：12 人板写了自己那一份——
 * 守卫排在狼刀之前（先守后刀，他手里不可能有今晚的刀口）、女巫排在狼刀之后预言家之前
 * （她得先看到刀口才谈得上救不救）；没写就是下面这套默认序，6 人板至今不写，
 * 所以它**逐字就是 6 人板那份流程**（老板子与老 session 因此一个字不用改）。
 */
const DEFAULT_NIGHT_ORDER = ['night_guard', 'night_wolf', 'night_seer'];

function nightOrderOf(session) {
    return getBoard(session?.boardId).nightOrder || DEFAULT_NIGHT_ORDER;
}

/**
 * 夜里的下一步：走完最后一步就回 night_resolve 结算。
 * 导出给 UI 的「这一步没人可行动，点一下过去」用——**顺序只有这一份**，界面别再抄一套三元组。
 * 认不出的来路（不在这一桌的夜里顺序里）直接回结算，宁可早一步，也别卡在点不动的夜里。
 */
export function nextNightPhase(session, from) {
    const order = nightOrderOf(session);
    const i = order.indexOf(from);
    return (i >= 0 && i + 1 < order.length) ? order[i + 1] : 'night_resolve';
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

/**
 * 发言次序：起点不定，方向不定（每个天亮现掷，见 rollSpeakPlan），掷出来钉在 `session.speakPlan` 上。
 * 次序 = 活人座号从起点起**按这一轮的方向**挨个往下数、绕过座位表末尾接回开头（出局的人本就不在名单里）。
 * 没掷过（老 session、测试里手搓的局面）就是座号从小到大——今天之前的行为。
 */
function rotateFrom(list, start, dir) {
    const walk = dir === -1 ? [...list].reverse() : list;
    const i = walk.indexOf(start);
    return i > 0 ? [...walk.slice(i), ...walk.slice(0, i)] : walk;
}

export function speakOrderSeats(session) {
    const plan = session?.speakPlan;
    return rotateFrom(aliveSeats(session).map(s => s.seat), plan?.start, plan?.dir === -1 ? -1 : 1);
}

/** 谁是下一个还没发言的活人（按这一轮的次序，见 speakOrderSeats） */
export function currentSpeaker(session) {
    const spoke = new Set(session?.spokeThisRound || []);
    for (const n of speakOrderSeats(session)) {
        if (!spoke.has(n)) return seatAt(session, n);
    }
    return null;
}

/* ---- 每个天亮：这一轮从谁开口、朝哪边数 ----
 * 用户 2026-09-14 定：**没有警长的时候这一手由系统掷**（将来 sheriffOf 的板子上交给警长定，
 * 钩子就在 rollSpeakPlan 这里）。三条一起掷：
 *   ① 从死者的**左边**（下家，座号 +1 那边）还是**右边**（上家，−1 那边）起；
 *   ② **顺着**数（座号递增）还是**倒着**数（递减）；
 *   ③ 锚——**起点本身也是随机挑的**：昨夜走了不止一个人，就从他们中间随机挑一个当锚；
 *      平安夜一个死者都没有，起点直接从活人里随机挑。
 * 掷一次管一整天（发言与 PK 台上同一条次序），进白天发言那一步落定（toDaySpeak），
 * 之后中途有人出局也不会把次序重算成另一个样子。公开流水与 AI 的秩序块读的都是它。
 */

/**
 * 掷这一天的发言次序。返回值一律**放在 session.speakPlan 上**（`{side, dir, anchor, start}`）。
 * rng 从参数进来（跟 shuffle/startGame 一个规矩），测试里喂一串定值就能把四种组合都走一遍。
 */
export function rollSpeakPlan(session, rng = Math.random) {
    const side = rng() < 0.5 ? 'left' : 'right';     // 死左 / 死右
    const dir = rng() < 0.5 ? 1 : -1;                // 顺序 / 逆序
    const total = (session.seats || []).length;
    const dead = (session.morningDeaths || []).filter(n => seatAt(session, n));
    const anchor = dead.length ? dead[Math.floor(rng() * dead.length)] : null;
    const alive = act => { const s = seatAt(session, act); return s && s.alive !== false; };
    const nbr = step => {                             // 死者旁边可能也是空的：挨个往下找到第一个活人
        for (let i = 1; i <= total; i++) {
            const n = ((anchor - 1 + step * i) % total + total) % total + 1;
            if (alive(n)) return n;
        }
        return null;
    };
    let start;
    if (anchor == null) {                             // 平安夜：起点也是随机挑一个活人
        const live = aliveSeats(session).map(s => s.seat);
        start = live.length ? live[Math.floor(rng() * live.length)] : null;
    } else {
        start = nbr(side === 'left' ? 1 : -1);        // 左 = 下家(+1)，右 = 上家(−1)
    }
    return { side, dir, anchor, start };
}

/**
 * 这一轮从谁开口这一句话——**公开流水与 AI 的秩序块共用这一份说法**（单条判定只写在这里，不会漂）。
 * 措辞照 [[prompt-write-facts-not-bans]]：只报事实（谁走、从谁起、朝哪边），不写成禁令。
 * 没掷过（speakPlan 还没落）就说按座号——老 session 与老测试看到的仍是原来那句。
 */
export function speakOrderLine(session) {
    const plan = session?.speakPlan;
    const way = plan?.dir === -1 ? '倒着数（座号递减）' : '顺着数（座号递增）';
    if (!plan || plan.start == null) return '天亮后从活着的人里按座号依次发言';
    if (plan.anchor == null) {
        return `昨夜是平安夜，没有死者可锚——从 ${plan.start} 号起${way}`;
    }
    return `昨夜走的是 ${plan.anchor} 号，从他的${plan.side === 'left' ? '左边' : '右边'}（`
        + `${plan.side === 'left' ? '下家' : '上家'}）起${way}，所以这一轮从 ${plan.start} 号说起`;
}

/**
 * 这一轮有投票权的人：活人减去**翻过牌的白痴**。
 * 白痴翻牌之后还留在场上、还能发言，但不再有票——所以「谁投完了」与投票进度的分母
 * 都得按这个集合算，不能按 aliveseats 算，否则开票永远等不到头。
 */
export function votersOf(session) {
    return aliveSeats(session).filter(s => s.flipped !== true);
}

/** 谁是下一个还没投票、且有投票权的人 */
export function currentVoter(session) {
    const voted = new Set(Object.keys(session?.votes || {}).map(Number));
    return votersOf(session).find(s => !voted.has(s.seat)) || null;
}

/**
 * 白天投票能投谁：活人、不是自己、**没翻过牌的白痴**（翻牌之后他不再被放逐，但夜里照旧会被狼杀）。
 * 界面的芯片、AI 的合法集、引擎的校验三处共用这一个口径——三处各写一份就一定会走岔。
 */
export function voteTargets(session, seatNo = null) {
    return aliveSeats(session).filter(s => s.seat !== seatNo && s.flipped !== true);
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
        alive: me.alive !== false,
        flipped: me.flipped === true,     // 白痴翻过牌（全桌都知道他是谁了，包括他自己）
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
    // 女巫知道自己还剩什么药、**每一夜被告知过的刀口**、自己用没用——这是她的私人信息，白天也照样留着：
    // 面杀里她夜里被告知过，就永远记得（「昨晚为什么不杀我」「他明明被刀了却没死」都是她的牌）。
    // `tonight` 只是「这一夜还没结算时的当前刀口」——结算后 night 清空，那一份就落到 witchLog 里了。
    if (me.role === 'witch') {
        out.potions = { ...(session.potions?.[seatNo] || { heal: false, poison: false }) };
        out.witchLog = (session.witchLog || []).filter(w => w.by === seatNo)
            .map(w => ({
                round: w.round, told: w.told !== false,        // 老 session 没这个字段：那时每夜都告诉她
                killed: w.killed, killedName: seatAt(session, w.killed)?.name || '',
                saved: w.saved, poisoned: w.poisoned, poisonedName: seatAt(session, w.poisoned)?.name || ''
            }));
        // 今晚的刀口只在**她自己那一拍**、且**解药还在**时给（见 witchKnifeOf）：
        // 解药用掉之后就没人再告诉她了，死人也不再有人告诉她
        const t = witchKnifeOf(session, seatNo);
        out.tonight = t == null ? null : { seat: t, name: seatAt(session, t)?.name || '' };
    }
    // 猎人只多知道一件事：**自己被刀了没有**——面杀里法官叫醒他才会说这一句。
    // 没被刀、被救回来、被守住、被毒死都不叫醒他，他也就什么都不知道（别在这儿替他推）。
    if (me.role === 'hunter') {
        out.knifed = me.death ? me.death.by === 'wolf' : hunterWakesTonight(session) === seatNo;
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
    // `n` 是这一局的单调序号（**不是数组下标**）：events 有 200 条上限、是从前面截的，
    // 关注表要拿它当时间锚（见 setWatch / publicFeed）。
    session.eventN = (Number(session.eventN) || 0) + 1;
    session.events = [...(session.events || []), { n: session.eventN, t: Date.now(), round, type, seat, text, isPublic }].slice(-200);
    return session.events[session.events.length - 1];
}

/** 事件的时间锚：老记录（本字段 2026-09-13 才加）没有 `n`，一律当 0——只会「记不住」，不会记错 */
const seqOf = e => Number(e?.n) || 0;

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

/* ---------------- 心声（投票那一刻没说出口的那句话） ----------------
 * 用户 2026-09-13 提：投票那次调用顺手多要一句心声，**算投票的副产物、不进任何提示词**，
 * 留给以后的道具——不明局势的人（以及观战的人）消耗道具看某人的心声。
 *
 * 与 aiNotes 是**两个柜子，别合并**：aiNotes 会回灌它自己的提示词（那是它的记忆），
 * aiHearts **今天没人读**。心声天然会带出身份、同伴、验人，**进到别人的视角里就是给
 * 全场开了上帝视角**（本文件顶部那条红线）——所以今天一处都不读。但它**不是「永远
 * 不许读」的数据**：它属于写出它的那个角色，以后要拿它给**它自己**用（用户 2026-09-13
 * 提过，比如聊天那一类的改动）是另一回事——**界线划在「谁看」，不是「能不能看」**。
 *
 * 用户当天还定了一条：**不要求它「真」**——就是当轮投票时的一个阶段性内心想法，
 * 可以犹豫、可以嘴硬、可以就是错的。所以提示词那边不加限制（见 werewolfAI）。
 */

export const HEART_LIMIT_PER_SEAT = 30;   // 每个座位最多留多少条（截尾，新的留着）

/**
 * 收下某个座位这一轮的心声。**今天只写不读**——但要读也只能给它自己读（见上面那段）。
 * 与 addNote 同理，**写点必须在 runTurn 的 apply 回调里**（call 阶段改的是内存副本）。
 *
 * **一条心声不设字数上限**（用户 2026-09-14 定，此前是 80 字硬截）：多长看这个角色自己——
 * 一句话到一长串都可能，内容从这一局发散到别的什么也都由他。理由是他那句话：
 * **「无论写多长都不会占用下一次提示词」**（心声不进任何提示词，见上面那段红线），
 * 所以长度在这里没有下游代价，截断反而把「这个人此刻是什么状态」砍掉了。
 * 唯一的上游边界是投票那次调用自己的输出上限（见 werewolfAI 的 DEFAULT_MAX_TOKENS）——
 * 那是「这一次调用说了多少话」的账，不该由这里再补一刀。**别把上限加回来。**
 */
export function addHeart(session, seatNo, { kind = 'vote', text = '' } = {}) {
    const body = String(text || '').trim();
    if (!session || !seatNo || !body) return false;
    const all = session.aiHearts = session.aiHearts || {};
    all[seatNo] = [...(all[seatNo] || []), { round: session.round || 1, kind, text: body }]
        .slice(-HEART_LIMIT_PER_SEAT);
    return true;
}

/* ---------------- 关注对象（每个座位的「这一局我在盯着谁」） ----------------
 * 用户 2026-09-13 定的口径（逐例核对过），机制见 AI/06 与 00-功能总览：
 * **一段发言对某人不可清理 ⟺ 那句话出口的那一刻，这个人正把它挂在关注里**；
 * 外加一条**回填**——某人改换关注表时，把他新挂上的人「本轮已经说过」的那几句也补记进去（只补本轮）。
 * 于是同一句话，对不同的观众各有一份留不留（4 号盯 2 号 ≠ 6 号也记得）；
 * 而**已经记进去的不撤销**（换关注只影响还没发生的）。
 */

export const WATCH_LIMIT_PER_SEAT = 40;   // 每个座位最多留多少次「改换」（截尾，新的留着）

/**
 * 收下某个座位这一轮的关注表。
 *
 * 一条记录 = 一次改换：`{ from, at, ids }`——`from` 是**这一天的开头**（决定之前已经说过的
 * 也算），`at` 是决定那一刻的事件序号。**这条表管的是 `[from, 下一次改换]` 这一段**：
 * 段里说过的都算数（说在决定之前是「回填」，说在之后是「在效」——本来就是一整段，不用分开讲）。
 *
 * **不调用 = 维持**（调用方看到 AI 没给这一行就别调这里，别拿空数组顶）；
 * 传空数组 = 明确地「谁都不盯了」。
 *
 * 与 addNote 同理，**写点必须在 runTurn 的 apply 回调里**（call 阶段改的是内存副本）。
 */
export function setWatch(session, seatNo, ids = []) {
    if (!session || !seatNo) return false;
    const me = Number(seatNo);
    const list = [...new Set((ids || []).map(Number).filter(n => Number.isFinite(n) && n > 0 && n !== me))].sort((a, b) => a - b);
    const all = session.watch = session.watch || {};
    all[me] = [...(all[me] || []), {
        from: Number(session.dayStartN) || 0,
        at: Number(session.eventN) || 0,
        ids: list
    }].slice(-WATCH_LIMIT_PER_SEAT);
    return true;
}

/**
 * 事件序号 `n` 那一刻，这位观众正盯着谁。
 *
 * 每条记录管 `[from, 下一条改换]` 这一段（见 setWatch），凡是「已经挂上」又「还没被后来的
 * 改换顶掉」的记录都在算：同一段里可能压着两条（新表往回填 + 旧表还在效），**取并集**——
 * 旧表在那一刻确实在效，不能因为后来换了人就当她没盯过。
 */
function watchedAt(entries, n) {
    const ids = new Set();
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (Number(e.from) > n) continue;                 // 那时还没轮到它（前一天的表不往更早的日子回头管）
        const until = Number(entries[i + 1]?.at);         // 下一条改换：到它那一刻为止这条都算数
        if (Number.isFinite(until) && n > until) continue;
        for (const s of e.ids || []) ids.add(Number(s));
    }
    return ids;
}

/* ---------------- 标记（AI 给场上的人贴的「他是什么」） ----------------
 * 存 `session.aiLabels[它自己] = { 目标座号: '标签' }`，只回灌它自己后续的提示词——
 * 别人（含主视角）看不到，界面也不显示。
 *
 * 口径（用户 2026-09-14 定）：**一个人只有一个标签：能改、能撤，不能多贴**，
 * 主视角那侧（session.marks）照同一套走；**词表也只有一张**——`markTagsOf(session)`
 * （跟着这一桌的板子走），主视角点的芯片与 AI 写的标签都从它里面挑，认不出的一律丢掉。
 * 语义照关注表那套心智：**写到谁就重定谁，没写的人维持原样**；撤掉 = 传 null / 空
 * （写出来就是从这个人的名字上把标签拿掉，不是留一个空格）。
 *
 * 认（`parseMarks`）/ 落库（`mergeLabels`）/ 读侧归一（`labelsOf`）/ 提示词那一行
 * （`labelLineOf`）**四件都在这里**——放引擎只有一个理由：A 段 `--engine` 跑得到
 * （`werewolfAI.js` 的依赖链读 localStorage，Node 里 import 不进来）。
 */

/** `狼`/`民` 这类简写归一到词表里的写法；「撤掉」的两种写法（文本那行与 JSON 那条路） */
const MARK_ALIAS = { 狼: '狼人', 民: '村民' };
const MARK_CLEAR = ['取消', '清除'];

/**
 * 【判断】那一行 → `{ 3: '狼人', 5: '存疑', 7: null }`
 * 认法与 `parseWatchTargets`（【关注】那一行）同一处、同一套宽进严出：
 * 只认**这一桌词表里**的标签（跟着板子走，见 markTagsOf），`狼`/`民` 这类简写归一到词表里的写法，
 * 认不出的整条丢掉；**null = 撤掉**——与「认不出」分开：认不出的是丢掉这一条、不动原来的表。
 * @param {string} text 那一行的原文
 * @param {object} [session] 这一桌（词表跟着板子走；不给就按 6 人板的词表认）
 */
export function parseMarks(text, session = null) {
    const tags = [...markTagsOf(session), ...Object.keys(MARK_ALIAS), ...MARK_CLEAR];
    // 每次新起一个正则，免得 lastIndex 带着上一轮的游标
    const re = new RegExp(`(\\d{1,2})\\s*号?\\s*(?:=|＝|：|:|是|为|->|→)?\\s*(${tags.join('|')})`, 'g');
    const out = {};
    let m;
    while ((m = re.exec(String(text || '')))) {
        const seat = Number(m[1]);
        if (seat < 1 || seat > 20) continue;
        const tag = m[2];
        out[seat] = MARK_CLEAR.includes(tag) ? null : (MARK_ALIAS[tag] || tag);
    }
    return out;
}

/**
 * 一个值 → 标签／null（明确撤掉）／''（认不出，丢掉这一条）。
 * 老数据里主视角那份是数组：按**最后一个**算（那时候是多选，最后点的是最后写的）。
 */
function tagOf(v, tags) {
    if (v == null) return null;
    if (Array.isArray(v)) return v.length ? tagOf(v[v.length - 1], tags) : null;
    const s = String(v).trim();
    if (!s) return null;
    if (MARK_CLEAR.includes(s)) return null;
    const tag = MARK_ALIAS[s] || s;
    return tags.includes(tag) ? tag : '';
}

/**
 * 收下某个座位这一轮写的判断：**写到谁重定谁，没写的人维持原样**；
 * 传 null / 空串 = 把这个人从表里划掉。
 * 认不出的那一条整条丢掉、不动这个人已有的标签（脏数据不该把整张表带走）。
 * 与 addNote / setWatch 同理，**写点必须在 runTurn 的 apply 回调里**（call 阶段改的是内存副本）。
 */
export function mergeLabels(session, seatNo, marks = {}) {
    if (!session || !seatNo || !marks) return false;
    const me = Number(seatNo);
    const tags = markTagsOf(session);
    const cur = labelsOf(session, me);
    let touched = false;
    for (const [key, val] of Object.entries(marks)) {
        const target = Number(String(key).replace(/[^\d]/g, ''));   // 容忍 "3号" 这种键
        // 表是「对场上这些人」的：不给自己贴，也不给这桌上没有的座号贴（死了的照收——他的身份已经明了）
        if (!(target >= 1 && target <= 20) || target === me || !seatAt(session, target)) continue;
        const tag = tagOf(val, tags);
        if (tag === null) { delete cur[target]; touched = true; continue; }
        if (!tag) continue;
        cur[target] = tag;
        touched = true;
    }
    if (!touched) return false;
    (session.aiLabels = session.aiLabels || {})[me] = cur;
    return true;
}

/** 某个座位此刻那张表（读侧归一：老数据的数组只留最后一个、不在词表里的标签丢掉） */
export function labelsOf(session, seatNo) {
    const raw = (session?.aiLabels || {})[seatNo];
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    const tags = markTagsOf(session);
    for (const [key, val] of Object.entries(raw)) {
        const target = Number(key);
        const tag = tagOf(val, tags);
        if (target >= 1 && target <= 20 && tag) out[target] = tag;
    }
    return out;
}

/** 提示词要的那一行：`3号=狼人、5号=存疑`（空表给空串，调用方自己决定要不要抬头） */
export function labelLineOf(session, seatNo) {
    const map = labelsOf(session, seatNo);
    return Object.keys(map).map(Number).sort((a, b) => a - b).map(n => `${n}号=${map[n]}`).join('、');
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
    // 座位对象是复用的（同一张桌再来一局）：死因、翻牌这些**座位级**的上一局残留要一起清
    seats.forEach((s, i) => { s.role = dealt[i]; s.alive = true; s.death = null; s.flipped = false; });

    session.seats = seats;
    session.status = 'ongoing';
    session.phase = nightOrderOf(session)[0] || 'night_guard';
    session.round = 1;
    session.roundId = (session.roundId || 0) + 1;
    session.events = [];
    session.votes = {};
    session.spokeThisRound = [];
    session.seerLog = [];
    session.guardLog = [];
    session.wolfLog = [];
    session.witchLog = [];
    // 女巫的药按座位记（一人两格，各只能用一次）。只有她本人的视角里看得到——见 viewOf
    session.potions = {};
    for (const s of seats) if (s.role === 'witch') session.potions[s.seat] = { heal: true, poison: true };
    session.aiNotes = {};
    session.aiHearts = {};       // 心声：投票的副产物，今天只写不读（见 addHeart）
    session.aiLabels = {};       // 判断表（上一局的标签不能跟着这一局走；2026-09-14 补——一直漏了这一张）
    session.watch = {};          // 关注表（一局内、按座位）：见 setWatch
    session.eventN = 0;          // 事件序号从这个 0 起（上面 events 也清空了）
    session.dayStartN = 0;       // 第一个白天由 startDay 盖上
    session.deathQueue = [];     // 出局者流程的队列（上一局的死人不能跟着这一局走）
    session.deathAfter = null;
    session.lastWordsSpoken = [];// 留过遗言的座位（上一局说过的遗言不能跟着这一局走）
    session.wordsDraft = {};     // 出局前就写好的遗言，按座位一张表（见 setWordsDraft）
    session.pk = null;           // 平票开的那一台（上一局没走完的 PK 不能跟着这一局走）
    // 上一局的调用账与降级状态：同一张桌再开一局，不能在开局就带着「连续失败已转模板」
    // （那会让新的一局一句 AI 都不打），调用计数也该从 0 重新数
    session.callCount = 0;
    session.ai = null;
    session.pending = null;
    session.winner = null;
    session.night = {};
    // 流水只记「发生了什么」：板子构成是规则，不进公开事件（否则 publicFeed 里会多出身份词）
    pushEvent(session, { type: 'system', text: '第 1 夜：天黑请闭眼' });
    return true;
}

/* ---------------- 出局 ---------------- */

/**
 * 记一个人出局：**只有这一个地方写 `alive = false`**，顺带把他怎么死的、死在哪一轮记下来
 * （遗言、复盘、结算面板都读这一格；从前这些信息只有一个 alive 布尔，谁也说不清他是被刀的）。
 *   by   'wolf' 被刀｜'poison' 被女巫毒｜'vote' 被投票出局｜'shot' 被开枪带走
 *   when 'night' 夜里｜'day' 白天（由调用点给：枪在天亮后响，那个死者仍算昨夜的）
 */
function markDead(session, seat, by, when) {
    if (!seat) return null;
    seat.alive = false;
    seat.death = { round: session.round || 1, by, when };
    return seat;
}

/**
 * 白痴翻牌：**他不死**，只是身份当众亮了（明牌暗牌都亮——翻牌本来就是亮给全场看的），
 * 此后没有投票权、也不会再被投票放逐，但夜里照样会被狼杀。
 * 与 markDead 一样是座位级的写入，只有这一个地方写 `flipped = true`。
 */
function flipIdiot(session, seat, votes) {
    seat.flipped = true;
    pushEvent(session, {
        type: 'flip', seat: seat.seat,
        text: `${seat.seat} 号 ${seat.name} 翻开底牌：白痴，没有出局（${votes} 票）`
    });
    return seat;
}

/**
 * 这个人还有遗言权吗（用户 2026-09-13 定）：白天被投票出局的一律有；
 * 第一夜的死者一律有（被刀、被毒、被猎人带走的都算）；第二夜起夜里出局的人不再开口。
 * 板子没开遗言（`lastWords`）就一个都没有——6 人板因此完全不受影响。
 */
export function hasLastWords(session, seat) {
    if (!wordsEnabled(getBoard(session?.boardId))) return false;
    const d = seat?.death;
    if (!d) return false;
    if (d.by === 'vote') return true;
    return d.when === 'night' && d.round === 1;
}

/**
 * 收下某个座位**出局前就写好的遗言**：公布死讯、轮到他说话时直接取用，不必再打一次 AI
 * （按次数计费，能省一次是一次）。被刀的猎人是在夜里的「猎人」那一拍顺手写好交上来的。
 *
 * **按座位存一张表**，不是「一个坑」：同一局里可以先有好几个人各写好各的（夜里的死者可能不止一个），
 * 谁也不会把谁的顶掉；一局一份、跟着 session 存库，几局同时开着也各是各的。
 */
export function setWordsDraft(session, seatNo, text) {
    const body = String(text || '').trim();
    if (!session || !seatNo || !body) return false;
    session.wordsDraft = { ...(session.wordsDraft || {}), [seatNo]: body };
    return true;
}

/** 取走某个座位现成的遗言草稿（取过就删，免得他下辈子还用这段）：没有就给空串 */
export function takeWordsDraft(session, seatNo) {
    const all = session?.wordsDraft || {};
    const body = all[seatNo] || '';
    if (body) {
        const rest = { ...all };
        delete rest[seatNo];
        session.wordsDraft = rest;
    }
    return body;
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
    // 阶段固定走：狼人不在世也走下一步（UI 侧没人可行动时点一下直接过去）
    session.phase = nextNightPhase(session, 'night_guard');
    return true;
}

/** 狼队刀人 */
export function applyWolfKill(session, targetSeat) {
    if (session.phase !== 'night_wolf') return false;
    const target = seatAt(session, targetSeat);
    if (!target || target.alive === false || target.role === 'werewolf') return false;
    session.night = { ...(session.night || {}), wolfTarget: targetSeat };
    // 阶段固定走：预言家不在世也走下一步（UI 侧没人可行动时点一下直接过去）
    session.phase = nextNightPhase(session, 'night_wolf');
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
    if (pick == null) { session.phase = nextNightPhase(session, 'night_wolf'); return true; }
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
    session.phase = nextNightPhase(session, 'night_seer');
    return true;
}

/**
 * 女巫今晚能救谁、能毒谁（UI 与 AI 用同一个合法集，跟 wolfTargets/seerTargets 一路）。
 *   'heal'   只有今晚的刀口这一个（还得她手里有解药）；**首夜能救自己，之后不能自救**
 *   'poison' 场上所有活人**除她自己**（还得她手里有毒药）
 * 药没了、她出局了、今晚没人被刀——一律空数组：界面点不动，引擎也落不下。
 */
export function witchTargets(session, seatNo, kind) {
    const me = seatAt(session, seatNo);
    const potions = session?.potions?.[seatNo];
    if (!me || me.role !== 'witch' || me.alive === false || !potions) return [];
    if (kind === 'heal') {
        const t = session.night?.wolfTarget;
        if (!potions.heal || t == null) return [];
        return (t === seatNo && (session.round || 1) > 1) ? [] : [t];
    }
    if (kind !== 'poison' || !potions.poison) return [];
    return aliveSeats(session).filter(s => s.seat !== seatNo).map(s => s.seat);
}

/**
 * 女巫用药：`{ save: true }` 解药 / `{ poison: N }` 毒药 / `{}` 今晚不用药。
 * **必须显式提交**（不用药也要提交一次）——不然阶段推不动，别人还在等她。
 * 同一夜只能开一瓶；解药只能救今晚的刀口，第二夜起不能自救；毒药不能毒自己。
 * 拒绝时零写入：药不会白扣，她也不算用过。
 *
 * 每一夜都往 witchLog 记一条（**含不用药的夜**）：那是「她夜里被告知过什么」的底账，
 * 复盘与她的提示词都读它。`told` 记的是**这一夜法官有没有告诉她刀口**——
 * 解药还在时说（她要用它救人），解药一用掉就不再说了：剩下的毒药不需要知道刀口，
 * 告诉她就等于每夜白送她一条狼的信息（见 witchKnifeOf）。
 */
export function applyWitch(session, seatNo, plan = {}) {
    if (session.phase !== 'night_witch') return false;
    const me = seatAt(session, seatNo);
    const potions = session?.potions?.[seatNo];
    if (!me || me.role !== 'witch' || me.alive === false || !potions) return false;

    const save = plan?.save === true;
    const poison = plan?.poison == null ? null : Number(plan.poison);
    if (save && poison != null) return false;                                  // 同一夜只能开一瓶
    if (save && !witchTargets(session, seatNo, 'heal').length) return false;   // 只能救今晚的刀口（且那一夜她救得了）
    if (poison != null && !witchTargets(session, seatNo, 'poison').includes(poison)) return false;

    const night = session.night || {};
    const told = potions.heal === true;                                        // 解药还在，才轮得到她听刀口
    session.night = { ...night, saved: save, poisoned: poison };
    session.potions = {
        ...session.potions,
        [seatNo]: { heal: potions.heal && !save, poison: potions.poison && poison == null }
    };
    session.witchLog = [...(session.witchLog || []), {
        by: seatNo, round: session.round || 1, told,
        killed: told ? (night.wolfTarget ?? null) : null, saved: save, poisoned: poison
    }];
    session.phase = nextNightPhase(session, 'night_witch');
    return true;
}

/**
 * 这一夜（还没结算的那一夜）该不该把刀口告诉某个女巫：**解药还在才告诉她**。
 * 解药是唯一需要刀口的决定；用完之后她只剩毒药，再每夜听刀口就是白拿一条狼的信息。
 * @returns {number|null} 告诉她刀口就返回那个座位，不该说就返回 null
 */
function witchKnifeOf(session, seatNo) {
    const me = seatAt(session, seatNo);
    if (!me || me.role !== 'witch' || me.alive === false) return null;
    if (session.phase !== 'night_witch') return null;      // 只在她自己那一拍：别的时候还没告诉她
    if (session.potions?.[seatNo]?.heal !== true) return null;
    return session.night?.wolfTarget ?? null;
}

/* ---------------- 猎人 ---------------- */

/**
 * 猎人今晚会不会被叫醒。面杀里那一段「猎人请睁眼」**只对今夜会被刀死的那个猎人**做：
 * 没被刀、被守卫守住、被女巫救回来——他根本不死，叫醒他等于白告诉他「你被刀了」；
 * 被女巫毒死——规则上开不了枪（口径：被毒不能开枪），叫醒他只是把女巫的用药白送给他。
 * 被叫醒 = 法官告诉他「你被狼刀了」+ 让他决定开不开枪（他就是在这里才第一次知道的）。
 * @returns {number|null} 被叫醒的猎人座位
 */
export function hunterWakesTonight(session) {
    const night = session?.night || {};
    const target = night.wolfTarget;
    if (target == null) return null;
    const seat = seatAt(session, target);
    if (!seat || seat.role !== 'hunter' || seat.alive === false) return null;
    if (night.guardTarget === target) return null;      // 守住了：他不死，也就没有枪
    if (night.saved === true) return null;              // 救回来了：同上
    if (night.poisoned === target) return null;         // 被毒死：开不了枪
    return seat.seat;
}

/** 猎人这一夜能带走谁（被叫醒才有这一步）：场上活人，除他自己 */
export function hunterTargets(session, seatNo) {
    const me = seatAt(session, seatNo);
    if (!me || me.role !== 'hunter' || me.alive === false) return [];
    if (hunterWakesTonight(session) !== seatNo) return [];
    return aliveSeats(session).filter(s => s.seat !== seatNo).map(s => s.seat);
}

/**
 * 猎人在夜里那一拍给的答复：`target` = 带走谁，`null` = 弃枪。
 * **没被叫醒的猎人也得交一次空过**（`target` 传 null）——不然阶段推不动，全场都在等他。
 * 记进 `session.night.hunter`（弃枪也记）：结算时看这一格就知道「他已经被叫醒过、当场给了答复」，
 * 于是不必再把他挂到天亮——那条旧路只留给夜里没有这一步的板子（6 人板）走。
 */
export function applyHunterNight(session, seatNo, targetSeat = null) {
    if (session.phase !== 'night_hunter') return false;
    const me = seatAt(session, seatNo);
    if (!me || me.role !== 'hunter' || me.alive === false) return false;

    let target = null;
    if (targetSeat != null) {
        if (hunterWakesTonight(session) !== seatNo) return false;
        if (!hunterTargets(session, seatNo).includes(Number(targetSeat))) return false;
        target = Number(targetSeat);
    }
    session.night = { ...(session.night || {}), hunter: { by: seatNo, target } };
    session.phase = nextNightPhase(session, 'night_hunter');
    return true;
}

/** 枪声的公开说法：明牌局点名身份，暗牌局只说「发动了技能」（夜里那一枪与白天补的那一枪逐字同一句） */
function shotText(session, shooter, victim) {
    return isOpen(session)
        ? `${shooter.seat} 号 ${shooter.name}（猎人）开枪带走了 ${victim.seat} 号 ${victim.name}`
        : `${shooter.seat} 号 ${shooter.name} 发动了技能，${victim.seat} 号 ${victim.name} 出局`;
}

/* ---------------- 出局者的流程 ---------------- */

/**
 * 这个人出局之后还有没有要**亲自发动**的东西：今天只有「猎人补枪」一种
 * （被毒死开不了枪，见下面 settleNight 的口径）。出局者流程与「终局要不要先让他走完」
 * 两处都读它，规则只写一遍。
 */
function skillBeatOf(session, seat) {
    const s = seatAt(session, seat);
    return s?.role === 'hunter' && s.death?.by !== 'poison' ? 'shot' : null;
}

/**
 * 出局之后要走的流程：**一次一个人、按座号来**，每个人把自己那几拍走完
 * （今天只有「等待发动技能」这一拍；遗言接在同一个人的后面，见 last_words）。
 *
 * 死讯先公布（settleNight / settleVote 已经把「谁出局」推上流水），然后**只有这一批出局的人**
 * 才走流程——没出局的人一步都不走。走的是同一套，所以「谁是死者」摆在明面上，
 * 而「谁是有技能的那个」看不出来：他在这一拍里到底发动了什么，是内部的事。
 *
 * 队伍什么时候开始走由调用点定：白天票出是当场就走（见 startDeathQueue），
 * 夜里的死讯要等天亮那一拍（见 startDay）——次序是**天亮 → 公布死讯 → 遗言 → 白天发言**。
 *
 * `act` = 这个人要在这里亲手做的事。今天只有一种：**猎人补那一枪**——
 * 他被投出去的那一刻才知道自己出局，只能在这儿开枪；夜里被刀的猎人不一样，他在夜里的
 * 「猎人」那一拍就被告知并定好了（`asked` 就是那个座位），枪连着他的死讯一起在结算时公布，
 * 到这一拍就只剩走个过场。夜里的死讯里没被问过的猎人（这一桌的夜里没有「猎人」那一步）
 * 也就没别的地方开枪了，照样在他自己这一拍补上。
 */
function setupDeathQueue(session, seats, after, asked = null) {
    session.deathQueue = seats.map(seat => {
        const act = skillBeatOf(session, seat);
        return { seat, act: act && (after === 'night' || seat !== asked) ? act : null, done: false };
    });
    session.deathAfter = after;      // 这批人走完去哪：'day' 进白天发言 / 'night' 入夜
}

/** 白天票出的那一批：死讯当场已经报过，队伍也当场就走 */
function startDeathQueue(session, seats, after, asked = null) {
    setupDeathQueue(session, seats, after, asked);
    session.phase = 'skill_wait';
}

/** 出局者流程里当前轮到的那个（走完一个换下一个）；没人排队时为 null */
export function currentDeath(session) {
    return (session?.deathQueue || [])[0] || null;
}

/**
 * 这个人还有遗言没留吗（流程里用）：有遗言权（见 hasLastWords）**且这一局还没说过**。
 * 记在 `lastWordsSpoken` 上而不是靠队列状态——他可能先被枪带走、再轮到自己说话，
 * 中间隔着好几拍，拿队列位置推「说过没有」迟早会错。
 */
function hasPendingWords(session, seatNo) {
    if (!hasLastWords(session, seatAt(session, seatNo))) return false;
    return !(session.lastWordsSpoken || []).includes(seatNo);
}

/** 遗言这一拍轮到谁（不在这一拍时为 null） */
export function currentLastWordSpeaker(session) {
    if (session?.phase !== 'last_words') return null;
    return currentDeath(session)?.seat ?? null;
}

/**
 * 挨个往下走：一个人自己的几拍是**技能 → 遗言**，两拍都走完才换下一个人；
 * 队列空了才按这一批的 `deathAfter` 继续（夜里的死讯 → 白天发言，白天票出 → 入夜）。
 * 判胜负不在这儿——见 advanceDeathQueue 的说明。
 */
function stepDeathQueue(session) {
    let queue = session.deathQueue || [];
    while (queue.length) {
        const head = queue[0];
        if (!head.done) { session.phase = 'skill_wait'; return true; }
        // 遗言只在**还没分出胜负**的时候走：这批人里有人带着枪（上面那道 pendingShot 的例外），
        // 枪一响可能就把胜负定了——面杀里游戏结束就不再留遗言，结果面板也不会先亮完再冒出一段话。
        if (hasPendingWords(session, head.seat) && !checkWinner(session)) { session.phase = 'last_words'; return true; }
        // 走完一个人的两拍就把他从队列里摘掉——**当场写回 session**，
        // 只改这个函数里的局部变量的话，下一次推进还会读到同一个队首（人就走不动了）
        queue = queue.slice(1);
        session.deathQueue = queue;
    }
    session.deathQueue = [];
    const after = session.deathAfter;
    session.deathAfter = null;
    if (after === 'night') startNextNightPhase(session);   // 白天票出 → 入夜
    else toDaySpeak(session);                              // 夜里的死讯 → 白天发言
    return true;
}

/**
 * 当前这个人走完了这一拍（技能拍点「继续」，或者他根本没技能要发动）：换自己的下一拍，
 * 或者换下一个人；都走完了就按这一批的 `deathAfter` 继续。
 * **判胜负放在这一批人全走完之后**（`stepDeathQueue` 的出口）：技能可能改变结局
 * （枪打死最后一只狼），中途判会判早了。
 */
export function advanceDeathQueue(session) {
    const queue = session?.deathQueue || [];
    if (!queue.length) return false;
    const [head, ...rest] = queue;
    session.deathQueue = [{ ...head, done: true }, ...rest];
    session.roundId = (session.roundId || 0) + 1;
    return stepDeathQueue(session);
}

/**
 * 记一段遗言（正文由 AI 或玩家给，引擎只记账）。只认**队列里当前那个人**说的话：
 * 遗言是他自己那一拍的事，别人插不进嘴。
 * 事件用 `lastword` 而不是 `speak`：`pruneFor` 只砍 `speak`，遗言是他这一局最后一句公开话，
 * 不能被「按人截记忆」顺手砍掉（别人记不清他说过什么，等于规则白写）。
 */
export function applyLastWords(session, seatNo, text) {
    if (session.phase !== 'last_words') return false;
    const cur = currentDeath(session);
    if (!cur || cur.seat !== seatNo) return false;
    const me = seatAt(session, seatNo);
    const body = String(text ?? '').trim();
    if (!me || !body) return false;
    session.lastWordsSpoken = [...(session.lastWordsSpoken || []), seatNo];
    pushEvent(session, { type: 'lastword', seat: seatNo, text: `${seatNo} 号 ${me.name} 的遗言：${body}` });
    return advanceDeathQueue(session);
}

/**
 * 结算夜里的事：刀口、毒药、猎人那一枪一起落定，死讯一次报完（都算**昨夜的死讯**，天亮公布完才发言）。
 * 守卫守中刀口就是平安夜，走的是与「狼空刀」**逐字相同**的那条分支——公开流水里分不出这两种，
 * 这是刻意的：暗牌局不能从死讯反推守卫守了谁。
 * @returns {{deaths:number[], peaceful:boolean}}
 */
export function settleNight(session, rng = Math.random) {
    const night = session.night || {};
    const target = night.wolfTarget;
    const guarded = target != null && night.guardTarget === target;
    const seat = target ? seatAt(session, target) : null;
    // 同一夜既守又救 = 救不回来（两个人都使了劲，反而把人救死）：恰好一个人保他，他才活
    const protectedBy = (guarded ? 1 : 0) + (target != null && night.saved === true ? 1 : 0);
    const deaths = [];

    // **先「天亮了」，再报谁出局**（面杀就是这个次序）：死讯是天亮那一刻公布的，
    // 出局者要走的那几拍（等待发动技能 → 遗言）接在天亮之后、白天发言之前（见 startDay）
    pushEvent(session, { type: 'system', text: '天亮了' });

    if (seat && seat.alive !== false && protectedBy !== 1) {
        markDead(session, seat, 'wolf', 'night');
        deaths.push(seat.seat);
        pushEvent(session, { type: 'death', seat: seat.seat, text: `${seat.seat} 号 ${nameWithRole(session, seat)}昨夜出局` });
    }

    // 毒药另算一个死者（可能与下面被枪带走的是同一个人，所以每杀一个人之前都先看他还在不在）
    const poisoned = night.poisoned != null ? seatAt(session, night.poisoned) : null;
    if (poisoned && poisoned.alive !== false) {
        markDead(session, poisoned, 'poison', 'night');
        deaths.push(poisoned.seat);
        pushEvent(session, { type: 'death', seat: poisoned.seat, text: `${poisoned.seat} 号 ${nameWithRole(session, poisoned)}昨夜出局` });
    }

    // 猎人在夜里那一拍已经定下了带走谁：他先出局，枪才响——与刀、毒同一批夜间死讯
    const hs = night.hunter;
    const shooter = hs ? seatAt(session, hs.by) : null;
    const victim = hs && hs.target != null ? seatAt(session, hs.target) : null;
    if (victim && victim.alive !== false) {
        markDead(session, victim, 'shot', 'night');
        deaths.push(victim.seat);
        pushEvent(session, { type: 'shot', seat: shooter.seat, text: shotText(session, shooter, victim) });
    } else if (hs && shooter && isOpen(session)) {
        // 明牌局：手里有枪却没带走人（弃枪，或打在同夜已经被毒死的那个人身上），照旧写明「没有开枪」。
        // 与守卫「守中 / 狼空刀同一句话」一个口径：公开的说法只说结果，不说中间到底发生过什么。
        pushEvent(session, { type: 'system', text: `${shooter.seat} 号 ${shooter.name}（猎人）没有开枪` });
    }

    if (!deaths.length) pushEvent(session, { type: 'system', text: '昨晚是平安夜，没有人出局' });
    // 死左/死右的锚要的是**昨夜的死者**（deaths 上面是照刀→毒→枪的公布次序攒的）：
    // 在这一步记下来（下面 sort 之后就分不出公布次序了），随即把这一天的发言次序掷出来——
    // 掷的时机就放在死人已经落定、天还没亮的这一刻：掷一次管一整天，之后谁再说谁的话都不影响它。
    session.morningDeaths = deaths.slice();
    session.speakPlan = rollSpeakPlan(session, rng);
    deaths.sort((a, b) => a - b);

    // 复盘要用的「这一夜到底刀了谁」：下面一清空 night 就永远没了。
    // 对局中谁也不读它（只有 nightTruth 读，而它只在复盘时被调用），所以公开流水依旧分不出
    // 「守中」与「狼空刀」；但在复盘里这两者就不再是一回事了——守中会写成平安夜。
    if (target != null) {
        session.wolfLog = [...(session.wolfLog || []), { seat: target, round: session.round || 1, guarded }];
    }

    session.roundId = (session.roundId || 0) + 1;
    session.spokeThisRound = [];
    session.votes = {};
    // 今夜哪个猎人在「猎人」那一拍答复过了（清空 night 之前先记下来，出局流程要拿它分辨
    // 「已经定过的」与「这一桌夜里没有那一步、只能在自己这一拍补枪的」）
    const askedHunter = night.hunter?.by ?? null;
    session.night = {};

    // 出局的人挨个走一遍自己的流程（只有他们走）：队伍在这儿**只摆好、先不走**，
    // 等天亮这一拍公布完死讯再开走（见 startDay）——次序是 天亮 → 死讯 → 遗言 → 白天发言。
    // 这一批已经把胜负定下来了就直接收场——终局不再走流程、不再留遗言。唯一的例外是
    // **这一桌夜里没问过他**的猎人：他那一枪要到自己的流程里才开得出来，所以照旧让他走完
    // （枪可能把最后一只狼带走，胜负得等这一批人走完再判，见 advanceDeathQueue）。
    // 被问过的猎人不在例外里——他的枪在结算那一批里就已经响了。
    const pendingShot = deaths.some(s => skillBeatOf(session, s) === 'shot' && s !== askedHunter);
    if (deaths.length && (pendingShot || !checkWinner(session))) {
        setupDeathQueue(session, deaths, 'day', askedHunter);
        session.phase = 'dawn';        // 天亮了：死讯刚报完，出局者的流程等下一拍
        return { deaths, peaceful: false };
    }
    session.phase = nextOrEnd(session, 'dawn');
    return { deaths, peaceful: !deaths.length };
}

/* ---------------- 白天 ---------------- */

/**
 * 天亮那一拍看完死讯，接着走：**出局的人先挨个走完自己的流程（等待发动技能 → 遗言），
 * 走完才轮到活人发言**（次序是 天亮 → 死讯 → 遗言 → 白天发言）。
 * 昨夜没人出局（平安夜）就没有队伍，直接进发言。
 */
export function startDay(session) {
    if (session.phase !== 'dawn') return false;
    // 「本轮」的起点：关注表回填到这一天开头（见 setWatch）。先把锚压在上，再推下面那条事件
    session.dayStartN = (Number(session.eventN) || 0) + 1;
    if ((session.deathQueue || []).length) return stepDeathQueue(session);
    return toDaySpeak(session);
}

/** 进白天发言（队列走完、或本来就没人的时候都走这儿）：天亮与死讯在上一拍已经报过了 */
function toDaySpeak(session) {
    session.phase = nextOrEnd(session, 'day_speak');
    if (session.phase !== 'day_speak') return true;     // 已经分出胜负：收场，不再多推一条发言提示
    // 这一轮从谁开口、朝哪边数：天亮前结算时就已经掷好钉在 session 上了（见 settleNight / rollSpeakPlan），
    // 这里只把结果当场公布（公开流水与 AI 的秩序块读的是同一句话）
    pushEvent(session, { type: 'system', text: speakOrderLine(session) });
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
    if (!from || from.alive === false || from.flipped === true) return false;   // 翻过牌的白痴没有票
    // 弃票也占位（存 null）：投过就不能再投，与 currentVoter 的口径一致
    if (Object.prototype.hasOwnProperty.call(session.votes || {}, fromSeat)) return false;
    // 目标必须是场上真的存在的座位：AI 报一个不存在的座号不能把票记进去（结算时会找不到人）
    // 翻过牌的白痴也不能再被投（他可以继续说话，只是不能再被放逐）
    if (targetSeat != null && (!target || target.flipped === true)) return false;
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
function revealVotes(session, counts, from = null) {
    const votes = from || session.votes || {};
    const froms = Object.keys(votes).map(Number).sort((a, b) => a - b);

    for (const fromSeat of froms) {
        const from = seatAt(session, fromSeat);
        const target = votes[fromSeat] != null ? seatAt(session, votes[fromSeat]) : null;
        pushEvent(session, {
            // round 是给「心声」道具用的：流水里同一个人会有好几条投票记录，得能对上
            // 到底是哪一轮那一票（心声明细见 addHeart / heartOf）
            type: 'vote', seat: fromSeat, round: session.round || 1,
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
 * 票最高的那一位出局：唯一的例外是**还没翻过牌的白痴**——他翻牌免死，本轮谁也没出局。
 * 白天那一轮票与 PK 台下的补投**共用这一份**：两处的差别只有「谁被投出去」这一句文案。
 *
 * 被投出局的人也要走一遍自己的流程（等待发动技能 →［遗言］），走完才入夜。
 * 不管他是不是猎人——只给猎人停这一下，等于把「他是不是猎人」写在流程上。
 * 两种情形直接收场、不走流程：这一票**已经分出胜负**、而他手里又没有要发动的东西。
 * （终局不再走流程，结果面板本来就会亮出所有人的身份，所以跳过他这一拍也藏不住什么。）
 * 猎人被投出去照常开枪——票出不是毒，规则上他开得了；他的枪可能把最后一只狼带走，
 * 所以胜负得等这一批人走完再判（见 advanceDeathQueue）。
 * @returns {{flipped:boolean, phase:string|null}} `phase` 为 null = 没人出局，交调用方去写那一句文案
 */
function executeOut(session, out, counts, after, label) {
    if (out == null) return { flipped: false, phase: null };
    const seat = seatAt(session, out);
    if (seat?.role === 'idiot') {
        // 翻牌免死：当众亮底牌（明暗牌都亮——翻牌本来就是亮给全场看的），他留在场上。
        // 没死人就没有出局流程，也不判猎人：这一轮到此为止。
        // 已经翻过牌的**不会再被放逐**——正常走不到这一支（他的票根本投不上去），
        // 这里只是把规则说圆：老 session 或旧界面留下来的票也不能把他票死。
        if (seat.flipped !== true) flipIdiot(session, seat, counts[out]);
        else pushEvent(session, { type: 'system', text: `${out} 号 ${seat.name} 已经翻过牌，本轮没有人出局` });
        return { flipped: true, phase: startNextNightPhase(session) };
    }
    markDead(session, seat, 'vote', 'day');
    pushEvent(session, { type: 'verdict', seat: out, text: `${out} 号 ${nameWithRole(session, seat)}${label}（${counts[out]} 票）` });
    const shoots = skillBeatOf(session, out) === 'shot';
    if (shoots || !checkWinner(session)) {
        startDeathQueue(session, [out], after);
        return { flipped: false, phase: session.phase };
    }
    return { flipped: false, phase: nextOrEnd(session, 'ended') };
}

/**
 * 开票：票最高者出局，平票或全弃票则本轮无人出局。
 * 板子开了 PK 而票又平了，就改走 PK（见 startPk）；PK 台下的补投也停在这一拍开票，
 * 由 `session.pk` 分流——**入口只有一个**，界面点「开票」不必分两处。
 * @returns {{out:number|null, tie:boolean, counts:object, flipped?:boolean, pk?:number[]}}
 *   `out` 是票最高的那个座号（白痴也照报，他是被投的那个），`flipped` 说明他没死
 */
export function settleVote(session) {
    if (session.pk) return settlePk(session);
    const { counts, top, tie } = tallyVotes(session.votes);
    const out = top.length === 1 ? top[0] : null;

    revealVotes(session, counts);

    session.roundId = (session.roundId || 0) + 1;
    // 平票而这一桌又开了 PK：不写「本轮没有人出局」，这几位上台再走一轮
    if (out === null && tie && pkEnabled(getBoard(session.boardId))) return startPk(session, top, counts);

    const res = executeOut(session, out, counts, 'night', '被投出局');
    if (res.phase) return { out, tie, counts, flipped: res.flipped, phase: res.phase };
    pushEvent(session, { type: 'system', text: tie ? `平票（${top.join('、')} 号同票），本轮没有人出局` : '没有人得票，本轮没有人出局' });
    return { out: null, tie, counts, phase: startNextNightPhase(session) };
}

/* ---------------- 平票 PK（板子开了 pk 才走得到） ---------------- */

/**
 * 台上那几个人的那一台：`session.pk = { seats, spoke, votes }`（一局里同时只会有一台）。
 * 规矩：台上的人各自再说一轮，**台上的人不投票**，台下活人只能投台上的人或弃票，
 * 再平票就本轮无人出局——一轮白天只 PK 一次，不然能无限投下去。
 */
export function pkOf(session) {
    return session?.pk || null;
}

export function onPkStage(session, seatNo) {
    return (session?.pk?.seats || []).includes(seatNo);
}

/**
 * 台上第一个还没说话的。**与白天发言同一份次序**（同一天里 speakPlan 是同一个）：
 * 台上这一轮也从同一个起点、同一个方向说起，不然台上台下的次序对不上。
 */
export function currentPkSpeaker(session) {
    if (session?.phase !== 'day_pk') return null;
    const spoke = new Set(session.pk?.spoke || []);
    // 台上这几个在这一天的次序里谁靠前谁先说（起点不在台上就顺延到台上第一个轮到的）
    const stage = session.pk?.seats || [];
    return speakOrderSeats(session).filter(n => stage.includes(n))
        .map(n => seatAt(session, n))
        .find(s => s && !spoke.has(s.seat)) || null;
}

/** 台上的人各自再说一轮（发言事件仍是普通 speak：这一轮的话大家都听得到） */
export function applyPkSpeech(session, seatNo, text) {
    if (session.phase !== 'day_pk') return false;
    const me = seatAt(session, seatNo);
    if (!me || me.alive === false || !onPkStage(session, seatNo)) return false;
    if ((session.pk.spoke || []).includes(seatNo)) return false;
    session.pk = { ...session.pk, spoke: [...(session.pk.spoke || []), seatNo] };
    pushEvent(session, { type: 'speak', seat: seatNo, text: `${seatNo} 号 ${me.name}：${text}` });
    // 台上说完了就该台下补投；台下一个人都没有（活人只剩台上这几位，或有票的都翻过牌了）
    // 就直接开票——不然会卡在一个没人能动的阶段上
    if (!currentPkSpeaker(session)) session.phase = currentPkVoter(session) ? 'day_pk_vote' : 'day_verdict';
    return true;
}

/** 台下有票的人：活人减去翻过牌的白痴，再减去台上那几个 */
export function pkVotersOf(session) {
    return votersOf(session).filter(s => !onPkStage(session, s.seat));
}

export function currentPkVoter(session) {
    const voted = new Set(Object.keys(session.pk?.votes || {}).map(Number));
    return pkVotersOf(session).find(s => !voted.has(s.seat)) || null;
}

/** 台下的票能投谁：台上还活着的那几个（投票的人自己就在台下，不必再减自己） */
export function pkVoteTargets(session) {
    return aliveSeats(session).filter(s => onPkStage(session, s.seat));
}

/** 记一张 PK 票。与白天那一轮一样是静默的：票一次性摊在开票那一刻（revealVotes） */
export function applyPkVote(session, fromSeat, targetSeat) {
    if (session.phase !== 'day_pk_vote') return false;
    const from = seatAt(session, fromSeat);
    if (!from || from.alive === false || from.flipped === true || onPkStage(session, fromSeat)) return false;
    if (Object.prototype.hasOwnProperty.call(session.pk?.votes || {}, fromSeat)) return false;
    // 只能投台上的人，或者弃票（null）——投台下的人等于把这一轮又摊开重来
    if (targetSeat != null && !onPkStage(session, targetSeat)) return false;
    session.pk = { ...session.pk, votes: { ...(session.pk.votes || {}), [fromSeat]: targetSeat ?? null } };
    if (!currentPkVoter(session)) session.phase = 'day_verdict';
    return true;
}

/** 平票开台：台上按座号排好，上一轮的「谁说过话」清掉——他们重新说一轮 */
function startPk(session, seats, counts) {
    const stage = seats.slice().sort((a, b) => a - b);
    session.pk = { seats: stage, spoke: [], votes: {} };
    session.spokeThisRound = [];
    pushEvent(session, {
        type: 'system',
        text: `平票（${stage.join('、')} 号同票）：这几位上台 PK，各自再说一轮，然后台下的人在他们当中补投一次`
    });
    session.phase = 'day_pk';
    return { out: null, tie: true, counts, pk: stage, phase: 'day_pk' };
}

/**
 * PK 台下的补投开票：出结果就按常规出局走（出局者照样走自己的流程、猎人照样开枪），
 * 又平票就直接收场——一轮白天只 PK 一次。
 */
export function settlePk(session) {
    const votes = session.pk?.votes || {};
    const { counts, top, tie } = tallyVotes(votes);
    const out = top.length === 1 ? top[0] : null;
    revealVotes(session, counts, votes);

    session.roundId = (session.roundId || 0) + 1;
    session.pk = null;      // 这一台到此为止：出结果也好、再平票也好，都不再补投第二轮

    if (out === null) {
        pushEvent(session, {
            type: 'system',
            text: tie ? `再次平票（${top.join('、')} 号同票），本轮没有人出局` : '台上没有人得票，本轮没有人出局'
        });
        return { out: null, tie: true, counts, phase: startNextNightPhase(session) };
    }
    const res = executeOut(session, out, counts, 'night', 'PK 后被投出局');
    return { out, tie, counts, flipped: res.flipped, phase: res.phase };
}

/**
 * 猎人开枪（弃枪传 null）：只发生在**出局者流程**里的那一拍，也就是被投票出局的那个猎人
 * （夜里的死讯里没被问过的猎人也走这里，见 startDeathQueue）。
 * 夜里被刀的猎人是在夜里的「猎人」那一拍定下的，枪连着死讯一起在结算时公布，不走这里。
 * 文案按明牌/暗牌分叉——暗牌局里「没发动」一个字都不留。
 */
export function applyHunterShot(session, targetSeat) {
    const cur = currentDeath(session);
    if (!cur || cur.act !== 'shot') return false;
    const me = seatAt(session, cur.seat);
    if (!me) return false;

    if (targetSeat == null) {
        // 暗牌局不写「没有开枪」：那等于告诉全场他是猎人
        if (isOpen(session)) {
            pushEvent(session, { type: 'system', text: `${me.seat} 号 ${me.name}（猎人）没有开枪` });
        }
    } else {
        const target = seatAt(session, targetSeat);
        if (!target || target.alive === false) return false;
        // 这一批走完要进夜（'night'）= 白天被投出局之后补的枪，是**白天**的事；
        // 走完要进白天（'day'）= 夜里的死讯那一批，枪下亡魂算**昨夜**的死者
        // （首夜被带走的照规矩也有遗言权）
        markDead(session, target, 'shot', session.deathAfter === 'night' ? 'day' : 'night');
        pushEvent(session, { type: 'shot', seat: me.seat, text: shotText(session, me, target) });
    }
    return advanceDeathQueue(session);
}

function startNextNightPhase(session) {
    // 先判胜负再决定进不进夜：已经分出胜负就直接收场，不再多报一条「天黑请闭眼」
    // （夜里死者的枪可能刚好带走最后一只狼，胜负要等这一批人走完才知道）
    if (checkWinner(session)) return nextOrEnd(session, 'ended');
    session.round = (session.round || 1) + 1;
    session.spokeThisRound = [];
    session.votes = {};
    session.pk = null;           // 天黑了：台上那一轮到此散场（正常在 settlePk 就清了，这里兜底）
    session.night = {};
    pushEvent(session, { type: 'system', text: `第 ${session.round} 夜：天黑请闭眼` });
    return nextOrEnd(session, nightOrderOf(session)[0] || 'night_guard');
}

/* ---------------- 胜负 ---------------- */

/**
 * 谁赢了。板子决定按哪套数：
 *   'city' 屠城（默认，6 人板至今的口径）：狼全灭 → 好人；狼数追平好人 → 狼。
 *   'side' 屠边（12 人板）：狼全灭 → 好人；神职清空 或 平民清空 → 狼。
 * 屠边只数**这一桌本来就有的那一边**——板子上没有神职，就不存在「屠神」这回事。
 * 数的是 side（神/民）不是 faction：狼不站在任何一边，别把它算进任何一类。
 * @returns {'wolf'|'good'|null}
 */
export function checkWinner(session) {
    const seats = session?.seats || [];
    if (!seats.length || seats.some(s => !s.role)) return null;
    const board = getBoard(session?.boardId);
    const wolves = aliveCountOf(session, 'wolf');
    if (wolves === 0) return 'good';
    if (winModeOf(board) === 'side') {
        const live = aliveSeats(session);
        const left = side => live.filter(s => sideOf(s.role) === side).length;
        if (seats.some(s => sideOf(s.role) === 'god') && left('god') === 0) return 'wolf';
        if (seats.some(s => sideOf(s.role) === 'folk') && left('folk') === 0) return 'wolf';
        return null;
    }
    if (wolves >= aliveCountOf(session, 'good')) return 'wolf';
    return null;
}

/**
 * 狼人赢在哪里（只给文案用）：屠边局得说清是哪一边先没的，
 * 不然「屠神」与「屠民」在结算面板上长得一模一样。
 */
function winReason(session) {
    if (winModeOf(getBoard(session?.boardId)) === 'side') {
        const live = aliveSeats(session);
        if (!live.some(s => sideOf(s.role) === 'god')) return '神职已全部出局';
        if (!live.some(s => sideOf(s.role) === 'folk')) return '平民已全部出局';
    }
    return '存活狼数已追平好人';
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
            text: winner === 'wolf' ? `狼人获胜：${winReason(session)}` : '好人获胜：狼人全部出局'
        });
        return 'ended';
    }
    session.phase = nextPhase;
    return nextPhase;
}

/* ---------------- 公开信息（④的提示词就吃这个） ---------------- */

/**
 * 公开事件白名单：私有的验人结果、任何人的标签都不在这里，只取 isPublic 的事件 + 存活/出局名单。
 *
 * **带上 `viewer` 就不再是「人人逐字一致」**（2026-09-13 起）：每个座位记得多少不一样——
 * 自己的发言、**当时正盯着的人**的发言、以及**所有非发言的事件**（`system` 天亮/平安夜/出局公告、
 * `tally` 票数、`verdict` 谁被投出去、`death`、`vote`，全是硬信息）一律留着；
 * 只有「别人的普通发言」按 `tail`（这一局记得住几条）截断——**砍发言不砍事实**，
 * 否则他会忘了谁已经死了，后面整段垮掉。判断只在装配提示词时做，**引擎不落任何额外记录**。
 *
 * 不传 `viewer`（复盘读流水、或任何要完整原貌的场合）就还是老样子：一刀不砍，
 * 只受 `limit` 约束。`tail` 缺省也行（等于不按人截），由调用方按悟性给（见 werewolfCodex 的 watchPlan）。
 *
 * @param {{limit?:number, viewer?:number|null, tail?:number}} opts
 */
export function publicFeed(session, { limit = 40, viewer = null, tail = Infinity } = {}) {
    const alive = aliveSeats(session).map(s => `${s.seat} 号 ${s.name}`).join('、');
    const dead = deadSeats(session).map(s => `${s.seat} 号 ${s.name}`).join('、');
    const mine = (session.events || []).filter(e => e.isPublic);
    const events = (viewer ? pruneFor(session, mine, Number(viewer), tail) : mine).slice(-limit);
    return [
        `【场上】存活：${alive || '无'}${dead ? `｜已出局：${dead}` : ''}`,
        events.length ? `【已经发生的事】\n${events.map(e => `· ${e.text}`).join('\n')}` : ''
    ].filter(Boolean).join('\n');
}

/** 按人截流水（顺序原样保留，只挑留哪几条）：见 publicFeed 的说明 */
function pruneFor(session, events, viewer, tail) {
    const entries = (session.watch || {})[viewer] || [];
    const kept = [];
    const others = [];
    for (const e of events) {
        if (e.type !== 'speak') { kept.push(e); continue; }        // 事实类：一律不砍
        if (Number(e.seat) === viewer) { kept.push(e); continue; }  // 自己说的：都记得
        if (watchedAt(entries, seqOf(e)).has(Number(e.seat))) { kept.push(e); continue; }   // 当时正盯着他
        others.push(e);
    }
    // 别人那些：留最近 tail 条。tail ≤ 0 = 一条不留；不是有限数（没传）＝ 不截断。
    // 别写成 `others.slice(-tail)`——`slice(-0)` 就是 `slice(0)`，会从「一条不留」变成「全都留」。
    const rest = !Number.isFinite(tail) ? others : (tail > 0 ? others.slice(-tail) : []);
    const live = new Set([...kept, ...rest]);
    return events.filter(e => live.has(e));
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

/* ---------------- 赛后复盘（游戏已结束，这些数据才允许摊开） ---------------- */

/**
 * 复盘用的「夜里的真相」：每一夜谁被刀、谁验了谁、谁守了谁，一夜一行。
 *
 * **只在对局结束后调用**（复盘提示词与复盘界面）。对局中这些数据要么分身份私有
 * （seerLog / guardLog 只进当事人自己的提示词），要么被刻意做成不可区分
 * （守中与狼空刀在公开流水上逐字一样）——这里摊开给所有座位，唯一的前提是「游戏已经打完了」。
 *
 * 老局没有 wolfLog（本字段 2026-09-13 随复盘一起加），那一夜的刀口就只剩「有没有人出局」：
 * 不猜、不编，缺就缺。
 */
export function nightTruth(session) {
    const nameOf = n => {
        const s = seatAt(session, n);
        return s ? `${n} 号 ${s.name}` : `${n} 号`;
    };
    // 「有人出局」和「报过平安夜」得分开：老局没有 wolfLog，只有「平安夜」这一条流水时
    // 它同样是个说不清的结果（可能守中、可能空刀），不能当成死讯写。
    const reported = (session.events || []).filter(e => e.type === 'death' || /平安夜/.test(e.text || ''));
    const deaths = new Set(reported.filter(e => e.type === 'death').map(e => e.round));
    const peaceful = new Set(reported.filter(e => /平安夜/.test(e.text || '')).map(e => e.round));
    const rounds = [...new Set([
        ...(session.wolfLog || []).map(w => w.round),
        ...(session.seerLog || []).map(e => e.round),
        ...(session.guardLog || []).map(g => g.round),
        ...deaths, ...peaceful
    ])].sort((a, b) => a - b);

    return rounds.map(round => {
        const bits = [];
        const kill = (session.wolfLog || []).find(w => w.round === round);
        if (kill) bits.push(kill.guarded ? `狼刀 ${nameOf(kill.seat)}，被守卫挡下（平安夜）` : `狼刀 ${nameOf(kill.seat)}`);
        else if (deaths.has(round)) bits.push('这一夜有人出局（刀口没有记录）');
        else if (peaceful.has(round)) bits.push('这一夜是平安夜（刀口没有记录）');
        for (const c of (session.seerLog || []).filter(e => e.round === round)) {
            bits.push(`预言家验了 ${nameOf(c.seat)}：${c.isWolf ? '狼人' : '好人'}`);
        }
        for (const g of (session.guardLog || []).filter(g => g.round === round)) {
            bits.push(`守卫守了 ${nameOf(g.seat)}`);
        }
        return bits.length ? `第 ${round} 夜：${bits.join('；')}` : '';
    }).filter(Boolean).join('\n');
}

/** 复盘对话（session.review）转成提示词里读的文本流：一行一句 `N 号 名字：内容` */
export function reviewTranscript(session, { limit = 40 } = {}) {
    return (session.review || []).slice(-limit)
        .map(m => `${m.seat} 号 ${m.name}：${m.text}`)
        .join('\n');
}

/**
 * 从一段话里找出被 @ 到的座位（复盘点名用）。
 * 认两种写法：`@3号` / `@3`（按座号）与 `@名字`（与这一桌的座位名比对，认前缀）。
 * 座号必须真的在这桌上、名字必须真的匹配得上，认不出的 @ 一律当没写——不报错、不猜。
 * @returns {number[]} 座号，升序、去重
 */
export function parseMentions(text, session) {
    const raw = String(text || '');
    const seats = session?.seats || [];
    const hits = new Set();
    for (const m of raw.matchAll(/@\s*(\d{1,2})\s*号?/g)) {
        const n = Number(m[1]);
        if (seats.some(s => s.seat === n)) hits.add(n);
    }
    for (const m of raw.matchAll(/@\s*([^\s@，。！？、,.!?：:；;]{1,16})/g)) {
        const frag = m[1];
        if (/^\d/.test(frag)) continue;      // 座号写法在上面处理过
        let best = null;
        for (const s of seats) {
            const name = String(s.name || '');
            if (name && (name === frag || frag.startsWith(name))) {
                if (!best || name.length > String(best.name).length) best = s;
            }
        }
        if (best) hits.add(best.seat);
    }
    return [...hits].sort((a, b) => a - b);
}

/**
 * 从一行字里找出「重点关注对象」（AI 写的那行 `【关注】3号 小明`）。
 * 不像 @ 点名那样必须带 @：座号（`3号` / `3`）与座位名（含在句子里即可）都认。
 * 只认这一桌上真的有的座位，认不出的一律当没写——不报错、不猜。
 * @returns {number[]} 座号，升序、去重
 */
export function parseWatchTargets(text, session) {
    const raw = String(text || '');
    const seats = session?.seats || [];
    const hits = new Set();
    for (const m of raw.matchAll(/(\d{1,2})\s*号/g)) {
        const n = Number(m[1]);
        if (seats.some(s => s.seat === n)) hits.add(n);
    }
    for (const s of seats) {
        const name = String(s.name || '').trim();
        if (name && raw.includes(name)) hits.add(s.seat);
    }
    return [...hits].sort((a, b) => a - b);
}

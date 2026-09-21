// apps/games/werewolf.js — 狼人杀（游戏中心接入）
//
// 边界：
// - 规则引擎在 werewolfEngine.js（纯函数），AI 在 werewolfAI.js，存储 in werewolfStore.js。
// - 一局 = 一张 6 人板子；座位上的都是真实角色（路人临时补齐，只进路人池）。
// - 无上帝视角：每次 AI 调用只喂一个角色的视角。
// - 推进方式：玩家点一下走一步。**「全桌都要拿主意、又没话可读」的那几拍可以交给半自动**
//   （桌内顶栏那个圆形钮，默认关闭）：四个投票阶段 + **上警表态**。都是按座位顺序一座一座问，
//   主视角那一座留着（自己拿主意，或者点「让 AI 代投 / 让 AI 决定」）。发言照旧一句一句点着听。

import { getActiveCharacterId, CharacterStore } from '../../store/CharacterStore.js';
import { getAllCharacterIds, getCharacterNameById } from '../characterManager.js';
import { getAvatarHtml } from '../../store/ImageCache.js';
import { esc } from '../../store/utils.js';
import {
    ROOM_TYPES, getRoomType, getBoard, markTagsOf, markShortOf, buildRulesPage, roleLabel, randomNpcIdentity,
    revealModeOf, revealLabel, tableColumnsOf, BOARDS, ruleTemplateIdsOf, ruleNoteOf,
    AUTO_MODE_KEY, AUTO_DEFAULT, autoModeOf, autoModeMeta
} from './werewolfRooms.js';
import { showConfirm } from '../../store/dialog.js';
import * as store from './werewolfStore.js';
import * as engine from './werewolfEngine.js';
import * as ai from './werewolfAI.js';
import * as codex from './werewolfCodex.js';

export const id = 'werewolf';
export const label = '狼人杀';
export const icon = '🐺';
export const color = '#a75d3d';

/* ---------------- 样式注入 ---------------- */

(function loadWerewolfStyle() {
    const styleId = 'werewolf-style';
    if (document.getElementById(styleId)) return;
    const link = document.createElement('link');
    link.id = styleId;
    link.rel = 'stylesheet';
    link.href = 'apps/games/werewolf.css';
    document.head.appendChild(link);
})();

/* ---------------- 入口 ---------------- */

export async function start(overlay, globalState, onBack) {
    const roleId = getActiveCharacterId(globalState);
    if (!roleId || roleId === 'unknown') {
        alert('请先选择一个主视角角色');
        onBack?.();
        return;
    }

    const root = document.createElement('div');
    root.id = 'werewolfRoot';
    root.style.cssText = 'position:absolute;inset:0;z-index:500;';
    overlay.appendChild(root);

    const app = {
        root,
        overlay,
        globalState,
        me: roleId,
        meName: getCharacterNameById(roleId) || '我',
        page: { name: 'rooms' },
        boardOpen: false,     // 阶段条下那块「场上」小面板展没展开（只在内存里，默认收着）
        typeTables: {},       // typeId -> [未结束的桌]
        lockedSession: null,  // 主视角角色正锁在里面的那局（没结束没流局就不能开新桌）
        session: null,        // 当前正在看的桌
        readonly: false,      // 旁观 / 非参与者时为 true
        busy: false,
        wolfPick: null,       // 狼队这一刀我挑的座号（还没提交给队友，只在内存里）
        wolfNote: '',         // 我留给队友的那句话
        inflight: new Map(),  // inviteId -> { characterId, seat, name }：还在飞的邀请
        settling: new Set(),  // 已经认领了结算的那几局（防同一次结束被算两遍战绩）
        meStat: null,         // 主视角自己的档案（「我的」页与手册页读它；活动页的余额与背包也读它）
        buying: false,        // 活动页正在买那一件（连点两下不该买成两颗）
        recentEnded: [],      // 最近结束、还能回去复盘的桌（打完就地在桌上聊，退出后靠它回来）
        review: {
            draft: '',          // 复盘输入框草稿（不落库，跟 app.draft 一个性质）
            timers: new Map(),  // 座号 -> 计时器：谁正攒着一次「窗口尽头再补」的调用
            readyAt: new Map(), // 座号 -> 这个座位下一次可以直接开口的时刻
            thinking: new Set(),// 座号 -> 正在调 AI（渲染成「正在想…」）
            pending: new Set(), // 座号 -> 他还在说的时候又被点了一次：这一段落地后接着再说
            picker: null        // @ 候选项（只在内存里，跟着输入框光标走）
        },
        reviewChain: Promise.resolve(),   // 复盘消息的写队列：落库是「读-改-写」，必须串起来
        autoRun: null,                    // 半自动正在跑的那一轮（null = 没在跑；`mine` = 我那一份也交给它了）
        closed: false
    };

    const close = () => {
        if (app.closed) return;
        app.closed = true;
        app.autoRun = null;               // 关了就不再有下一座：循环每一轮开头都会查它
        clearReviewTimers(app);           // 关掉整个模块 = 退出房间：不再触发任何新调用
        document.removeEventListener('click', app.backHandler, true);
        root.remove();
        onBack?.();
    };
    // 状态栏返回键：监听在祖先上走捕获阶段，才抢得过 app.js:469 挂在按钮上的监听
    app.backHandler = e => {
        if (!e.target?.closest?.('#statusBackBtn')) return;
        e.stopPropagation();
        e.preventDefault();
        handleBack(app, close);
    };
    document.addEventListener('click', app.backHandler, true);

    // 做法约定的模板库读一次进缓存：提示词组装（roleHead → roleHeadText）是同步的，
    // 必须在任何一次 AI 调用之前就位；读不动时它自己认空库，不影响开局。
    await store.ensureRuleTemplates();
    await store.seedRoomTypes(ROOM_TYPES);
    await refreshTables(app);
    await refreshMe(app);
    renderApp(app, close);
}

/* ---------------- 返回 ---------------- */

function handleBack(app, close) {
    const name = app.page.name;
    if (name === 'handbook') {
        app.page = { name: 'me' };
        renderApp(app, close);
        return;
    }
    if (name === 'type' || name === 'room' || name === 'rules' || name === 'table' || name === 'spectate') {
        leaveSubPage(app, close);
        return;
    }
    close();
}

async function leaveSubPage(app, close) {
    const page = app.page;
    // 从手册里翻开的「完整规则」，退回来还是手册（别把人甩到分类页去）
    if (page.from === 'handbook') {
        app.page = { name: 'handbook' };
        renderApp(app, close);
        return;
    }
    if (page.name === 'room' && !app.readonly) {
        // 散桌：准备态里一个人都没坐、也没有在飞邀请时，就别留着这张空桌。
        // **只散自己开的**（hostId）——2026-09-14 起准备中的桌谁都能进去坐，
        // 不加这一道，路过看一眼别人的空桌再退出去就会把它删了。
        const s = app.session;
        if (s && s.status === 'forming' && s.hostId === app.me
            && !(s.seats || []).length && !Object.keys(s.reservations || {}).length) {
            await store.deleteSession(s.id);
            app.session = null;
        }
    }
    app.session = null;
    app.readonly = false;
    clearReviewTimers(app);   // 退出这张桌：还在等的窗口全掐掉，不再触发新调用
    // 从桌/规则页回分类页，从分类页回首页；**从首页那列「最近结束」进的桌，退回首页**
    // （那一列长在首页上，房型页他根本没去过，别把人甩到一个没去过的页面）
    app.page = (page.name === 'type' || page.from === 'rooms')
        ? { name: 'rooms' }
        : (page.typeId ? { name: 'type', typeId: page.typeId } : { name: app.tab || 'rooms' });
    await refreshTables(app);
    renderApp(app, close);
}

/* ---------------- 数据 ---------------- */

/** 拉一遍所有未结束的桌，按分类归好；顺带看主视角有没有被锁在某一桌里 */
async function refreshTables(app) {
    const active = await store.listActiveSessions();
    const map = {};
    for (const s of active) (map[s.typeId] || (map[s.typeId] = [])).push(s);
    for (const list of Object.values(map)) list.sort((a, b) => (a.tableNo || 0) - (b.tableNo || 0));
    app.typeTables = map;
    app.lockedSession = active.find(s => (s.participantIds || []).includes(app.me)) || null;
    // 打完的桌不在活动列表里，但它还开着口子让人回去复盘
    app.recentEnded = await store.listRecentEndedSessions(3);
}

function tablesOf(app, typeId) {
    return app.typeTables[typeId] || [];
}

/**
 * 主视角自己的档案。**不开档**（他那一座是本地坐下、没有 AI 邀请可搭，用户 2026-09-12 定的口径）：
 * 所以这里读的只有战绩与点亮，没有档位；没打过就是 null，页面照显示，只是写着「还没打过」。
 */
async function refreshMe(app) {
    app.meStat = app.me ? await store.getStat(app.me) : null;
}

/** 主视角被锁在别桌时，给一句能照着做的提示 */
function blockedByLock(app, targetTypeId) {
    const lock = app.lockedSession;
    if (!lock) return '';
    if (lock.typeId === targetTypeId) return `${lock.name || '第 ? 桌'} 还没结束，先回去把它打完或流局`;
    const type = getRoomType(lock.typeId);
    return `你在「${type?.name || '别的分类'}」的 ${lock.name || '一桌'} 上还有没结束的一局，先回去打完或流局`;
}

function iAmIn(session, app) {
    return (session?.participantIds || []).includes(app.me);
}

/* 落库的写队列：局 id -> 这一条的队尾（见 mutateSession）。
   放在模块级、按局各记一条，是因为 `app` 每次进模块都会重建——挂在 app 上，
   「退出模块前还在飞的那一笔」与「回来之后写的那一笔」会各排各的队，照样叠上。 */
const writeChains = new Map();

/**
 * 落库的唯一入口：改动前重读库里那一局、改完整条存回去（三步都在 mutateSessionNow 里）。
 * 这里多一道**排队**，只为让这三步不会两笔叠在一起。
 *
 * 不排队会丢东西，因为存的是**整条记录**：A 读到旧记录、B 也读到同一份旧记录，
 * A 存（带 A 的改动）、B 存（带 B 的改动，可 B 手里那份里没有 A 的改动）⇒ A 那一笔没了。
 * 半自动放开之后这一幕是真会发生的：AI 回话落库的那一瞬，玩家正好点了自己那一票。
 *
 * 排队只压这一小段（重读到存完，几毫秒），**不压 AI 请求**（几秒）：玩家点自己那一票
 * 不必等 AI 回话，只是落地那一下排在队尾——要的就是「AI 没返回时我也能投」。
 *
 * 存进表里的那条一律是 catch 过的：一笔写失败不该把这条队列变成坏掉的链、拖着后面全不动。
 * 调用方拿到的返回值与以前一样（该 await 的照旧 await，该判成功没有的照旧判）。
 */
function mutateSession(app, sessionId, mutator) {
    const run = () => mutateSessionNow(app, sessionId, mutator);
    // 接在上一笔后面：上一笔存完了，这一笔才开始重读，于是读到的必是带前一笔改动的新记录
    const tail = (writeChains.get(sessionId) || Promise.resolve()).then(run);
    const settled = tail.catch(() => {});
    writeChains.set(sessionId, settled);
    // 这一笔落地就把这一局的账收掉（表不长生）；后面还有人排队的话，下一个队尾自己会收
    settled.then(() => { if (writeChains.get(sessionId) === settled) writeChains.delete(sessionId); });
    return tail;
}

/**
 * 读改写：改动前重读一遍库里的这一局，避免旧的异步结果覆盖新状态
 * （照 textAdventure 的 roundId 比对思路，这里是每次重读 + 落库前判活）
 */
async function mutateSessionNow(app, sessionId, mutator) {
    const fresh = await store.getSession(sessionId);
    if (!fresh || !store.ACTIVE_STATUS.includes(fresh.status)) return null;
    const out = await mutator(fresh);

    // 这一局是不是就在这一步结束的。结束只能在**这一次**调用里认领：
    // 开头那道 ACTIVE_STATUS 早退会让「结束之后」的写入被静默拒绝，所以
    // 「置 settled + 写战绩」必须挂在这儿。settled 落库 = 真正的防重；
    // 内存里的 app.settling 是补另一个洞：两个按钮都没有忙碌闸门，
    // 连点两下会有两次 mutateSession 各自读到「还没结束」的同一个旧记录。
    const justEnded = fresh.status === 'ended' && !fresh.settled;
    const claimed = justEnded && !app.settling.has(sessionId);
    if (justEnded) {
        fresh.settled = true;
        fresh.settledAt = Date.now();
    }
    if (claimed) app.settling.add(sessionId);

    const saved = await store.saveSession(fresh);
    if (claimed) {
        // 落库成功才算这一局真的打完了；写失败就放开认领，别把这一局钉死在「已结算」上
        if (saved) await settleProfile(fresh);
        else app.settling.delete(sessionId);
    }
    if (app.session?.id === sessionId) app.session = fresh;
    return out === undefined ? fresh : out;
}

/**
 * 一局打完：把这一局的战绩、身份经验与点亮写进每个座位的档案。
 * 真实角色（名册里的、网络里的、含主视角）走 stats，临时路人走 npcs——两条线同一套字段、同一段累加。
 * 档位不在这里：档位只在落座那一刻生成（见 werewolfAI 的落座测评）。
 * **失败只 warn**：战绩没写上也不该让这一局打不完、界面卡住。
 *
 * 防重复不在这里，在调用方 `mutateSession` 那一道 `settled` 闸（落库成功才算打完）——
 * 所以这里只管写，不必再自己认一遍「这一局结算过没有」。
 */
async function settleProfile(session) {
    // 评分算一次就好（纯函数，每座一行，形状跟着 finalResult）。**它坏了也不能拖累结算**：
    // 战绩是这一局的本分，经验只是附赠——所以包一层，真出意外就退成「这一局没记经验」。
    let scores = new Map();
    try {
        scores = new Map(engine.scoreGame(session).map(r => [r.seat, r]));
    } catch (e) {
        console.warn('[werewolf] 身份评分算失败（这一局不记经验，战绩照写）', e);
    }
    for (const row of engine.finalResult(session)) {
        const scored = scores.get(row.seat);
        const detail = {
            role: row.role, win: row.win, survived: row.alive, typeId: session.typeId,
            // 身份经验（见 werewolfStore 的 exp / scoreLog）：这是**这一个座位**的分，
            // 一桌几个真角色就写几份，不是只写主视角那一份
            sessionId: session.id, score: scored?.total, items: scored?.items
        };
        try {
            if (row.characterId) {
                const stat = await store.applyGameResult(row.characterId, detail);
                if (stat) await store.lightEntries(row.characterId, codex.earnedIds(stat));
            } else if (row.npcId) {
                const npc = await store.recordNpcGame(row.npcId, detail);
                if (npc) await store.lightNpcEntries(row.npcId, codex.earnedIds(npc));
            }
        } catch (e) {
            console.warn('[werewolf] 战绩写入失败', row.name, e);
        }
    }
}

function pushLog(session, text, type = 'system') {
    session.log = [...(session.log || []), { t: Date.now(), type, text }].slice(-120);
}

/* ---------------- 座位 / 预留 ---------------- */

function newInviteId() {
    return 'inv_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

function seatNumbers(board) {
    return Array.from({ length: board.seats }, (_, i) => i + 1);
}

function occupiedSeats(session) {
    return new Set((session.seats || []).map(s => s.seat));
}

/** 已被在飞邀请预定的座位（exceptSeat = 本次要用的那个预留座，对它是可用的） */
function reservedSeats(session, exceptSeat = null) {
    const out = new Set();
    for (const key of Object.keys(session.reservations || {})) {
        const n = Number(key);
        if (n !== exceptSeat) out.add(n);
    }
    return out;
}

/** 现在可以落座的空位（不含别人预定的） */
function freeSeats(session, board) {
    const taken = occupiedSeats(session);
    const held = reservedSeats(session);
    return seatNumbers(board).filter(n => !taken.has(n) && !held.has(n));
}

/** 为一次在飞邀请预留一个座位（预留座对匹配与其他邀请不可用） */
function reserveSeat(session, board, characterId, name) {
    const open = freeSeats(session, board);
    if (!open.length) return null;
    const seat = open[Math.floor(Math.random() * open.length)];
    const inviteId = newInviteId();
    session.reservations = { ...(session.reservations || {}) };
    session.reservations[seat] = { characterId, name, inviteId, at: Date.now() };
    return { seat, inviteId };
}

/** 释放一次邀请占的座位，返回释放出来的座号 */
function releaseReservation(session, inviteId) {
    const current = session.reservations || {};
    for (const [seat, r] of Object.entries(current)) {
        if (r.inviteId !== inviteId) continue;
        const copy = { ...current };
        delete copy[seat];
        session.reservations = copy;
        return Number(seat);
    }
    return null;
}

/**
 * 落座收口（想坐的号 → 自己的预留座 → 随机空位）
 * @returns {number|null} 落下的座号；没位子返回 null
 */
function landOn(session, board, { characterId, name, kind = 'character', persona = '', preferred = null, ownReserved = null }) {
    const taken = occupiedSeats(session);
    const held = reservedSeats(session, ownReserved);
    const open = seatNumbers(board).filter(n => !taken.has(n) && !held.has(n));

    let seat = null;
    if (preferred && open.includes(preferred)) seat = preferred;
    if (seat === null && ownReserved && open.includes(ownReserved)) seat = ownReserved;
    if (seat === null && open.length) seat = open[Math.floor(Math.random() * open.length)];
    if (seat === null) return null;

    const rec = { seat, kind, name, role: null, alive: true };
    if (kind === 'npc') {
        rec.npcId = characterId;
        // 座位自带一句人设：AI 要照着它扮演这个人，路人没有名册记录可读
        if (persona) rec.persona = persona;
    } else {
        rec.characterId = characterId;
    }
    session.seats = [...(session.seats || []).filter(s => s.characterId !== characterId && s.npcId !== characterId), rec]
        .sort((a, b) => a.seat - b.seat);
    return seat;
}

/**
 * 放掉「这次邀请已经没有结果可言」的预留座位。
 * 一次邀请的落座是靠内存里的 Promise 完成的（app.inflight）；关掉游戏窗口或刷新页面后，
 * Promise 连同内存一起没了，库里那条预留就成了孤儿——座位会一直显示「邀请中」却永远不会有人来。
 * 所以重进房间时，凡是内存里没有对应邀请的预留，一律放掉。
 */
function releaseOrphanReservations(app, session) {
    const orphans = Object.entries(session.reservations || {}).filter(([, r]) => !app.inflight.has(r.inviteId));
    if (!orphans.length) return false;
    const copy = { ...session.reservations };
    for (const [seat, r] of orphans) {
        delete copy[seat];
        pushLog(session, `等不到 ${r.name || '对方'} 回话，${seat} 号座放出来了`);
    }
    session.reservations = copy;
    return true;
}

/* ---------------- 渲染壳 ---------------- */

function renderApp(app, close) {
    const scrollTop = app.root.querySelector('#wwScroll')?.scrollTop || 0;
    app.root.innerHTML = `
        <div class="ww-app">
            ${renderTopbar(app)}
            ${renderStage(app)}
            <main class="ww-scroll" id="wwScroll">${renderBody(app)}</main>
            ${renderBottom(app)}
            <div class="ww-toast"></div>
        </div>
    `;
    bindApp(app, close);
    const scroller = app.root.querySelector('#wwScroll');
    if (scroller) {
        // 发言流跟着新内容走；正在往上翻旧账时不打扰，停在原地
        scroller.scrollTop = app.stickBottom === false ? scrollTop : scroller.scrollHeight;
        scroller.addEventListener('scroll', () => {
            app.stickBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
        });
    }
}

/**
 * 阶段条与「场上」小面板：挂在发言流**上方**（`.ww-scroll` 之外），滚到多深都看得见。
 * 面板高度是格子尺寸算出来的确定值（6 列 × 人数行），**不设 max-height 裁断**：
 * 12 人也不过两行，天然落在三分之一屏内。其他页面返回空串——这两块只服务对局页。
 *
 * 外面这层 `.ww-stage` 只为定位而存在：**阶段条照旧在流里占位，面板绝对定位挂在它下沿**（覆盖式）。
 * 这样展开/收起时 `.ww-scroll` 的几何一点不变——滚动位置没有需要恢复的东西，也不用补偿。
 * 开着时壳子带 `open`：阶段条与面板**贴上并当一张卡看**（贴合的那两条边拍平、面板顶上那道白描边
 * 断开），接缝处不留空底色，只剩「上深下浅」一次换色，不是两张卡摞着。收起来时它就是一张独立的
 * 圆角卡、下面直接是发言流（原来那道 9px 的空底色也去掉了）。
 * 代价写在 `renderBoardPanel` 上（盖住的那一截），取舍过程见 `AI/06` 2026-09-15。
 */
function renderStage(app) {
    const name = app.page.name;
    if (name !== 'table' && name !== 'spectate') return '';
    const session = app.session;
    if (!session) return '';
    const type = getRoomType(session.typeId);
    const board = getBoard(session.boardId || type?.boardId);
    const panel = app.boardOpen ? renderBoardPanel(app, session) : '';
    return `<div class="ww-stage${app.boardOpen ? ' open' : ''}">${renderPhaseBar(app, session, board)}${panel}</div>`;
}

function renderTopbar(app) {
    const name = app.page.name;
    const isRoot = ['rooms', 'activity', 'me'].includes(name);
    const titles = { rooms: '狼人杀', activity: '活动', me: '我的' };
    let subtitle = 'WEREWOLF';
    let title = titles[name] || '狼人杀';

    if (name === 'type') {
        subtitle = '房间分类';
        title = getRoomType(app.page.typeId)?.name || '房间';
    } else if (name === 'room') {
        subtitle = '准备中';
        title = app.session?.name || '这一桌';
    } else if (name === 'rules') {
        subtitle = '规则';
        title = getRoomType(app.page.typeId)?.name || '规则';
    } else if (name === 'handbook') {
        subtitle = '手册';
        title = '狼人杀手册';
    } else if (name === 'table' || name === 'spectate') {
        subtitle = name === 'table' ? '对局' : '旁观';
        title = app.session?.name || (name === 'table' ? '牌桌' : '旁观');
    }

    const canGiveUp = (name === 'room' || name === 'table') && !app.readonly;
    // 「这一桌的做法约定」入口：准备页与对局页都有，但只在还打得动的局里出现——
    // 打完/流局的局 mutateSession 一律拒收（ACTIVE_STATUS），别摆一个按了不生效的按钮；
    // 旁观局 app.readonly，天然不出现。
    const canRules = (name === 'room' || name === 'table') && !app.readonly && !isOver(app.session);
    // 自动推进那一档：**只有桌内两页挂它**（准备页 + 对局页，与 📜 同一个口径）。值本身仍然是
    // 模块级的（localStorage 的 `global_werewolf_auto`）——用户 2026-09-17 问「在桌内设置不能将
    // 配置写入跨桌吗？」，能：画在哪跟存哪是两件事，桌内设置、跨桌生效。
    // 图标不用 emoji：一个圆 + 中间一道分割线（CSS 画的，见 .ww-auto-dot）——左半点亮＝半自动
    // （今天只有这一档会亮）、全亮留给还没做出来的全自动、只描边＝关闭。
    const autoCur = autoMode();
    const canAuto = (name === 'room' || name === 'table') && !app.readonly && !isOver(app.session);
    const rightBtns = [
        canRules ? '<button id="wwRulesBtn" aria-label="这一桌的做法约定">📜</button>' : '',
        canAuto
            ? `<button id="wwAutoBtn" data-auto="${autoCur}" aria-label="自动推进：${autoModeMeta(autoCur).name}"><i class="ww-auto-dot"></i></button>`
            : '',
        canGiveUp
            ? `<button id="wwGiveUp" aria-label="${name === 'table' ? '流局' : '放弃'}">✕</button>`
            : (isRoot ? `<button id="wwAbout" aria-label="说明">?</button>` : '')
    ].filter(Boolean).join('');

    // 两侧各自包一层等宽容器：.ww-topbar 是 space-between，右边多一个按钮而左边还是一个，
    // 标题就会被挤偏 20px（.ww-topbar-l/-r 的 min-width 是 CSS 里那道配重）
    return `
        <header class="ww-topbar">
            <div class="ww-topbar-l"><button id="wwBack" aria-label="返回">‹</button></div>
            <div class="ww-brand">
                <small>${subtitle}</small>
                <strong>${esc(title)}</strong>
            </div>
            <div class="ww-topbar-r">${rightBtns}</div>
        </header>
    `;
}

function renderBottom(app) {
    const name = app.page.name;
    // 手册挂在「我的」下面，所以底栏照旧是这三个页签，「我的」保持高亮
    if (['rooms', 'activity', 'me', 'handbook'].includes(name)) {
        const tabs = [
            { id: 'rooms', icon: '🏠', label: '房间' },
            { id: 'activity', icon: '🎁', label: '活动' },
            { id: 'me', icon: '👤', label: '我的' }
        ];
        return `<nav class="ww-tabbar">
            ${tabs.map(t => `<button class="ww-tab ${app.tab === t.id || (!app.tab && t.id === 'rooms') ? 'active' : ''}" data-tab="${t.id}"><i>${t.icon}</i>${t.label}</button>`).join('')}
        </nav>`;
    }
    if (name === 'type') {
        const type = getRoomType(app.page.typeId);
        const lock = blockedByLock(app, app.page.typeId);
        const label = lock ? '先处理没结束的那局' : '开一桌';
        return `<footer class="ww-bottom">
            <button id="wwOpenTable" class="primary" ${lock ? 'disabled' : ''}>${esc(label)}</button>
        </footer>`;
    }
    if (name === 'room' && !app.readonly) {
        const off = app.busy ? 'disabled' : '';
        const seated = iAmIn(app.session, app);
        return `<footer class="ww-bottom">
            <button id="wwInvite" class="ghost" ${off || (seated ? '' : 'disabled')}>邀请</button>
            <button id="wwMatch" class="ghost" ${off || (seated ? '' : 'disabled')}>${app.busy ? '⏳ 匹配' : '匹配'}</button>
            <button id="wwStart" class="primary" ${seated ? off : 'disabled'}>${seated ? '开始游戏' : '先坐下'}</button>
        </footer>`;
    }
    if (name === 'table' || name === 'spectate') return renderTableBottom(app);
    return '';
}

function renderBody(app) {
    switch (app.page.name) {
        case 'rooms': return renderRoomList(app);
        case 'type': return renderTypePage(app);
        case 'activity': return renderActivity(app);
        case 'me': return renderMe(app);
        case 'handbook': return renderHandbook(app);
        case 'rules': return renderRules(app);
        case 'room': return renderRoom(app);
        case 'table':
        case 'spectate': return renderTable(app);
        default: return renderRoomList(app);
    }
}

/* ---------------- 首页：房间分类入口 ---------------- */

function renderRoomList(app) {
    return `
        <section class="ww-hero">
            <div class="ww-hero-moon"></div>
            <div class="ww-eyebrow">WEREWOLF</div>
            <h2>今晚，谁在说谎</h2>
            <p>${esc(app.meName)} 上桌，身份由发牌决定。<br>选一类房间进去开一桌，邀请朋友或直接匹配。</p>
        </section>

        ${renderRulesCard(app)}

        <div class="ww-section-title"><strong>房间分类</strong><span>${ROOM_TYPES.length} 类</span></div>
        ${ROOM_TYPES.map(type => renderTypeCard(app, type)).join('')}

        ${(app.recentEnded || []).length ? `
            <div class="ww-section-title"><strong>最近结束</strong><span>可以回去复盘</span></div>
            ${app.recentEnded.map(s => renderTableCard(app, s)).join('')}
        ` : ''}
    `;
}

function renderRulesCard() {
    return `
        <button class="ww-card ww-rules-card" id="wwOpenRules">
            <div class="ww-card-icon">📖</div>
            <div class="ww-card-main">
                <div class="ww-card-title">规则与角色</div>
                <div class="ww-card-desc">各类板子怎么打、各角色的能力、胜负条件</div>
            </div>
            <span class="ww-card-go">查看 ›</span>
        </button>
    `;
}

function renderTypeCard(app, type) {
    const board = getBoard(type.boardId);
    const tables = tablesOf(app, type.typeId);
    const mine = tables.find(s => iAmIn(s, app));
    const meta = `${board.label} · ${board.seats} 人 · ${revealLabel(type.reveal)} · ${tables.length ? `${tables.length} 张桌在开` : '还没开桌'}`;

    return `
        <button class="ww-card ww-type-card" data-type="${type.typeId}">
            <div class="ww-card-icon">${type.icon}</div>
            <div class="ww-card-main">
                <div class="ww-card-title">${esc(type.name)}${mine ? `<span class="ww-pill ${mine.status === 'forming' ? 'muted' : 'good'}">${mine.status === 'forming' ? '你在准备中' : '你在局中'}</span>` : ''}</div>
                <div class="ww-card-desc">${esc(type.desc)}</div>
                <div class="ww-card-meta">${esc(meta)}</div>
            </div>
            <span class="ww-card-go">进入 ›</span>
        </button>
    `;
}

/* ---------------- 分类页：这一类下的所有桌 ---------------- */

function renderTypePage(app) {
    const type = getRoomType(app.page.typeId);
    if (!type) return `<div class="ww-empty">这类房间不在了</div>`;
    const board = getBoard(type.boardId);
    const tables = tablesOf(app, type.typeId);
    const roles = Object.entries(board.roles).map(([r, n]) => `${roleLabel(r)}×${n}`).join(' · ');

    return `
        <div class="ww-section-title"><strong>${esc(board.label)}</strong><span>${esc(roles)}</span></div>
        <button class="ww-card ww-rules-card" id="wwOpenRules">
            <div class="ww-card-icon">📖</div>
            <div class="ww-card-main">
                <div class="ww-card-title">规则与角色</div>
                <div class="ww-card-desc">${esc(type.desc)}｜${esc(revealLabel(type.reveal))}局｜单次发言上限约 ${type.speechLimit} 字</div>
            </div>
            <span class="ww-card-go">查看 ›</span>
        </button>

        <div class="ww-section-title"><strong>桌</strong><span>${tables.length ? `${tables.length} 张没结束` : '还没有桌'}</span></div>
        ${tables.length
            ? tables.map(s => renderTableCard(app, s)).join('')
            : `<div class="ww-empty">这一类还没有开桌。<br>点下面的「开一桌」，坐下再邀请朋友。</div>`}

        ${renderLockNote(app, type.typeId)}
    `;
}

/** 主视角被锁在别处时的说明条 */
function renderLockNote(app, typeId) {
    const note = blockedByLock(app, typeId);
    return note
        ? `<div class="ww-line system" style="margin-top:10px;">${esc(note)}</div>`
        : '';
}

function renderTableCard(app, session) {
    const type = getRoomType(session.typeId);
    const board = getBoard(type?.boardId);
    const mine = iAmIn(session, app);
    const seated = (session.seats || []).length;
    const holding = Object.keys(session.reservations || {}).length;

    let action, pill, cls = '';
    if (session.status === 'forming') {
        pill = `<span class="ww-pill muted">准备中</span>`;
        // 卡片上写的就是进去之后能做的事：自己开的写「继续准备」，还有空位、你自己也没被
        // 别的局锁住就写「去坐下」（见 enterTable 的 readonly 口径），其余才是「旁观」
        const canJoin = !mine && !app.lockedSession && freeSeats(session, board).length > 0;
        action = mine ? '继续准备' : (canJoin ? '去坐下' : '旁观');
        cls = mine || canJoin ? '' : 'is-quiet';
    } else if (session.status === 'ended' || session.status === 'voided') {
        // 打完的桌不回牌桌，回桌边——就地复盘那一摊
        const over = session.status === 'ended'
            ? (session.winner === 'wolf' ? '狼人赢' : session.winner === 'good' ? '好人赢' : '打完了')
            : '流局';
        pill = `<span class="ww-pill muted">${over}</span>`;
        action = '去复盘';
        cls = mine ? '' : 'is-quiet';
    } else {
        pill = `<span class="ww-pill good">进行中</span>`;
        action = mine ? '回到牌桌' : '旁观';
    }

    return `
        <button class="ww-card ww-table-card ${cls}" data-session="${session.id}">
            <div class="ww-card-icon">🪑</div>
            <div class="ww-card-main">
                <div class="ww-card-title">${esc(session.name || '这一桌')}${mine ? '<span class="ww-pill">你在这桌</span>' : ''}${pill}</div>
                <div class="ww-card-desc">${esc((session.seats || []).map(s => s.name).filter(Boolean).slice(0, 6).join('、') || '还没有人坐下')}</div>
                <div class="ww-card-meta">${seated}/${board.seats} 人${holding ? ` · ${holding} 个邀请在路上` : ''}${session.status === 'forming' || session.status === 'ended' || session.status === 'voided' ? '' : ` · 第 ${session.round || 1} 天`}${(session.review || []).length ? ` · 桌边聊了 ${session.review.length} 句` : ''}</div>
            </div>
            <span class="ww-card-go">${action} ›</span>
        </button>
    `;
}

/* ---------------- 活动（商店） ----------------
 * 今天只有一件商品：**许愿水晶**——买下存在角色自己的背包里（`store.itemsOf`），
 * 开局点「开始游戏」时问一句要不要花一颗，把这一局的身份许成自选的（见 askWish）。
 * 名字、图标、说明都是界面的话，放这儿；`store` 那边只管道具 id 与价钱那个数。
 * 价钱与余额的比较也在这儿——余额不够**照旧可点**，点一下告诉你还差多少（比一个按不动的按钮清楚）。
 */
const SHOP = [
    {
        id: store.CRYSTAL,
        icon: '🔮',
        name: '许愿水晶',
        desc: '开一局之前用它许愿，这一局的身份由你自己挑——相当于提前把那张牌拿到手。一颗管一局。',
        cost: store.CRYSTAL_COST
    }
];

function renderActivity(app) {
    if (!app.me) {
        return `<div class="ww-empty">还没有主视角角色，钻石与道具都挂在角色身上——先在小手机里选一个主视角。</div>`;
    }
    const coins = store.coinsOf(app.meStat);
    const bag = store.itemsOf(app.meStat);
    return `
        <div class="ww-section-title"><strong>商店</strong><span>你有 ${coins} 钻</span></div>
        ${SHOP.map(item => renderShopCard(item, coins, bag[item.id] || 0)).join('')}
        <div class="ww-empty"><p>钻石是每个角色自己的：赢一局进账 ${store.WIN_COINS} 颗。<br>以后这里还会有抽卡与限时玩法。</p></div>
    `;
}

function renderShopCard(item, coins, held) {
    return `
        <button class="ww-card ww-shop-card${coins < item.cost ? ' is-poor' : ''}" data-item="${esc(item.id)}">
            <div class="ww-card-icon">${item.icon}</div>
            <div class="ww-card-main">
                <div class="ww-card-title">${esc(item.name)}${held ? `<span class="ww-pill">持有 ${held}</span>` : ''}</div>
                <div class="ww-card-desc">${esc(item.desc)}</div>
            </div>
            <span class="ww-shop-price">${item.cost} 钻</span>
        </button>
    `;
}

/** 买一件：先看一眼余额（不够就报还差多少），买成了刷新档案再重画这一页（余额与持有都要跟着动） */
async function buyShopItem(app, close, item) {
    if (app.buying || !app.me) return;
    const bal = store.coinsOf(await store.getStat(app.me));
    if (bal < item.cost) return toast(app, `还差 ${item.cost - bal} 钻——赢一局进账 ${store.WIN_COINS} 颗`);
    app.buying = true;   // 连点两下不该买成两颗（扣钻与进包是同一笔写，这里只管别叠上第二笔）
    const stat = await store.buyItem(app.me, item.id, item.cost, 1);
    app.buying = false;
    if (!stat) return toast(app, '这一颗没买上，再点一次试试');
    app.meStat = stat;
    renderApp(app, close);
    toast(app, `${item.name} ×1 · 背包里有 ${store.itemsOf(stat)[item.id] || 0} 颗`);
}

/* ---------------- 我的（主视角自己的档案） ----------------
 * 三块：档位（落座测评给的）｜战绩（结算写的）｜手册入口。
 * 「档案不是测评的产物」：谁先来谁先建，缺哪块就说缺哪块——**空着也照显示**，
 * 不隐藏页面（这一份档案此刻就是这样）。
 */

function tierBadge(kind, key) {
    const t = kind === 'flair' ? codex.flairByKey(key) : codex.tierByKey(key);
    if (!t) return '';
    const name = kind === 'flair' ? `悟性 · ${t.label}` : t.label;
    return `<span class="ww-tier-badge ${kind}-${t.key}">${esc(name)}</span>`;
}

function renderMe(app) {
    const stat = app.meStat;
    const played = Number(stat?.played) || 0;
    const win = Number(stat?.win) || 0;
    const lose = Number(stat?.lose) || 0;
    // 每个身份后面挂上它的身份经验（`exp` 是逐局评分攒出来的，含负分；老档案没有就是 0）。
    // 经验为 0 也照显示——诚实，而且让这个数字看得见地在动。
    const byRole = Object.entries(stat?.byRole || {})
        .map(([r, cell]) => `${roleLabel(r)}：${Number(cell?.played) || 0} 局（胜 ${Number(cell?.win) || 0} · ${Number(stat?.exp?.[r]) || 0} 经验）`)
        .join('　');

    const tiers = stat?.level
        ? `${tierBadge('tier', stat.level)}${tierBadge('flair', stat.flair)}`
        : `<span class="ww-tier-badge is-none">未测评</span>`;

    return `
        <section class="ww-card ww-codex-card">
            <div class="ww-codex-head">
                ${avatarHtml(app.me, app.meName)}
                <div class="ww-codex-name">
                    <strong>${esc(app.meName)}</strong>
                    <div class="ww-codex-tiers">${tiers}</div>
                </div>
            </div>
            <p class="ww-codex-why">${stat?.why ? esc(stat.why) : '还没人估过你打狼人杀的水平——等你被邀请上桌，对面会先看看你是个什么样的人。'}</p>
        </section>

        <div class="ww-section-title"><strong>战绩</strong><span>${played ? `${played} 局` : '还没打过'}</span></div>
        ${played
            ? `<div class="ww-line" style="line-height:2;">
                    <div>${win} 胜　${lose} 负${Number(stat.streak) > 1 ? `　当前 ${Number(stat.streak)} 连胜` : ''}</div>
                    ${byRole ? `<div style="color:var(--muted);">${esc(byRole)}</div>` : ''}
                </div>`
            : `<div class="ww-empty">还没打过一局。<br>打完一局，这里会记下胜负与各身份的战绩。</div>`}

        <div class="ww-section-title"><strong>手册</strong><span>知识随经历点亮</span></div>
        ${renderHandbookCard()}
    `;
}

function renderHandbookCard() {
    return `
        <button class="ww-card ww-rules-card" id="wwOpenHandbook">
            <div class="ww-card-icon">📖</div>
            <div class="ww-card-main">
                <div class="ww-card-title">狼人杀手册</div>
                <div class="ww-card-desc">基础通用规则 + 各房型规则；坐过、打过才点亮的那部分是策略</div>
            </div>
            <span class="ww-card-go">翻开 ›</span>
        </button>
    `;
}

/* ---------------- 手册页 ---------------- */

/**
 * 一条条目：点亮的给正文，没点亮的**只给标题 + 点亮条件**（用户 2026-09-12 定的口径）。
 * 判定与注入提示词用的是同一个 isLit，所以「手册上亮着的」=「他真拿得到的」；
 * 正文也同源（`entryTextOf`）——亮着的那条就是他这一档看得到的深浅。还没够着的层**不剧透正文**，
 * 只报一句差什么（`deepLockText`）。
 */
function renderEntry(entry, record) {
    const lit = codex.isLit(entry, record);
    const cond = lit ? '' : codex.condText(entry.cond);
    const deep = lit ? codex.deepLockText(entry, record) : '';
    // 房型角标：只标有房型门槛的条目，通用条目不标（roomLabelOf 对 scope:'common' 返回空串）。
    // 跟点亮判定读的是同一个 scope —— 画出来的就是筛选真正用的那一份。
    const room = codex.roomLabelOf(entry);
    return `
        <div class="ww-entry ${lit ? '' : 'is-locked'}">
            <div class="ww-entry-head">
                <strong>${esc(entry.title)}</strong>
                ${room ? `<span class="ww-entry-room">${esc(room)}</span>` : ''}
                <span class="ww-entry-tier">${esc(codex.ENTRY_TIER_LABEL[entry.tier] || '')}</span>
            </div>
            ${lit ? `<p>${esc(codex.entryTextOf(entry, record))}</p>` : `<p class="ww-entry-cond">🔒 ${esc(cond || '还没点亮')}</p>`}
            ${deep ? `<p class="ww-entry-cond">🔒 再往下：${esc(deep)}</p>` : ''}
        </div>
    `;
}

/**
 * 手册 = 阵营（狼 / 好人 / 两边通用）→ 组（狼人 / 预言家 / 女巫…）→ 条目，最后是各房型的完整规则。
 *
 * 分组轴是**纯组织轴**（用户 2026-09-16 定）：它只决定这一页怎么归类，
 * **注入侧一个字不读它**——筛选继续走现成的 cond + scope（全桌都注入、不排序）。
 * 这一页的亮用的是**角色级**的 `isLit`（他解锁了什么，与今天坐哪张桌无关）；
 * 注入那一份是它再过一遍筛选。两者**允许不等**（用户 2026-09-17：不等的地方（注入的地方）
 * 是由房型筛选产生的），所以角色这一侧不需要再另做一份整理。
 *
 * 房型的「完整规则」仍走 buildRulesPage（规则正文的唯一出处），这里只摆入口卡，不重复写规则。
 */
function renderHandbook(app) {
    const record = app.meStat;

    // 页面真正显示的那些条目——分组轴是全量的，每个组的每一条都渲染出来。
    // ⚠️ 别再用 litIds(record)（改之前的写法）：它不传 roomScope 就**只放行 common 条目**
    // （见 werewolfCodex 的 inRoom），分子上限被钉在 common 的条数上，而分母是全表——
    // 满配档案也会报「已点亮 18 / 42」，可页面上 51 张卡全亮着。
    // 这里逐条 isLit，与 renderEntry 同一个判定 ⇒ 分子分母与卡片颜色同源，不会漂。
    const shown = codex.CODEX_GROUPS.flatMap(g => codex.groupEntries(g.key));
    const litCount = shown.filter(e => codex.isLit(e, record)).length;

    /** 组一节：标题是组名，`<span>` 位放组说明（.ww-section-title span 就是给这种小字准备的） */
    const groupSection = group => {
        const entries = codex.groupEntries(group.key);
        if (!entries.length) return '';   // 空组不摆空标题（数据侧另有断言钉「没有空组」）
        return `
            <div class="ww-section-title"><strong>${esc(group.name)}</strong><span class="ww-group-desc">${esc(group.desc)}</span></div>
            ${entries.map(e => renderEntry(e, record)).join('')}
        `;
    };

    /** 阵营一层：比组标题粗一档，右侧挂本阵营的点亮账（CSS 见 .ww-camp-title） */
    const campSection = camp => {
        const groups = codex.groupsOfCamp(camp.key);
        const mine = groups.flatMap(g => codex.groupEntries(g.key));
        if (!mine.length) return '';
        return `
            <div class="ww-camp-title">
                <strong>${esc(camp.name)}</strong>
                <span>${mine.filter(e => codex.isLit(e, record)).length} / ${mine.length} 条</span>
            </div>
            ${groups.map(groupSection).join('')}
        `;
    };

    // 各房型的完整规则：正文仍走 buildRulesPage，这里只摆入口卡。
    // ⚠️ **不设 `entries.length` 开关**——原先那个开关埋着「房型条目哪天全搬进通用组，
    // 这张卡就跟着静默消失」的坑。这里无条件遍历 ROOM_TYPES。
    const rulesSection = () => `
        <div class="ww-section-title"><strong>各房型的完整规则</strong><span>这一桌怎么打</span></div>
        ${ROOM_TYPES.map(type => `
            <button class="ww-card ww-rules-card" data-rules-type="${type.typeId}">
                <div class="ww-card-icon">📜</div>
                <div class="ww-card-main">
                    <div class="ww-card-title">${esc(type.name)} · 完整规则</div>
                    <div class="ww-card-desc">这一桌怎么打、一夜之间、一个白天、桌上的规矩</div>
                </div>
                <span class="ww-card-go">查看 ›</span>
            </button>`).join('')}
    `;

    return `
        <div class="ww-line" style="line-height:1.9;">
            <div>已点亮 <strong>${litCount}</strong> / ${shown.length} 条。</div>
            <div style="color:var(--muted);">灰色的还没亮——条件写在卡片上，坐过、打过自然就有了。</div>
        </div>
        ${codex.CODEX_CAMPS.map(campSection).join('')}
        ${rulesSection()}
    `;
}

/* ---------------- 规则页 ---------------- */

function renderRules(app) {
    const type = getRoomType(app.page.typeId) || ROOM_TYPES[0];
    const board = getBoard(type?.boardId);
    const sections = buildRulesPage(type);
    return `
        <div class="ww-section-title"><strong>${esc(board.label)}</strong><span>${Object.entries(board.roles).map(([r, n]) => `${roleLabel(r)}×${n}`).join(' · ')}</span></div>
        ${sections.map(sec => `
            <div class="ww-section-title"><strong>${esc(sec.title)}</strong><span></span></div>
            <div class="ww-line" style="line-height:1.9;">
                ${sec.lines.map(l => `<div>· ${esc(l)}</div>`).join('')}
            </div>
        `).join('')}
    `;
}

/* ---------------- 房间页 ---------------- */

function renderRoom(app) {
    const session = app.session;
    if (!session) return `<div class="ww-empty">这一桌不在了</div>`;
    const type = getRoomType(session.typeId);
    const board = getBoard(type?.boardId);
    const seatMap = {};
    for (const s of session.seats || []) seatMap[s.seat] = s;
    const reserved = session.reservations || {};
    const mine = (session.seats || []).find(s => s.characterId === app.me);

    const seats = [];
    for (let n = 1; n <= board.seats; n++) seats.push(renderSeat(app, n, seatMap[n], reserved[n]));

    const log = (session.log || []).slice(-40);

    return `
        <div class="ww-section-title">
            <strong>${esc(session.name || type?.name || '这一桌')}</strong>
            <span>${esc(`${revealLabel(revealModeOf(session))} · ${(session.seats || []).length}/${board.seats} 人`)}</span>
        </div>

        <div class="ww-seats ${board.columns === 1 ? 'single' : ''}">
            ${seats.join('')}
        </div>

        ${app.readonly ? renderLockNote(app, session.typeId) : ''}

        <div class="ww-section-title"><strong>房间动态</strong><span>${esc([
            mine ? `你坐在 ${mine.seat} 号` : '还没落座',
            app.inflight.size ? `${app.inflight.size} 个邀请在路上` : ''
        ].filter(Boolean).join(' · '))}</span></div>
        ${log.length
            ? log.map(item => `<div class="ww-line ${item.type === 'system' ? 'system' : ''}">${esc(item.text)}</div>`).join('')
            : `<div class="ww-empty">点一个空座位坐下，然后邀请朋友或匹配</div>`}

        <div class="ww-section-title"><strong>说明</strong><span></span></div>
        <div class="ww-line" style="color:var(--muted);">
            · 一类房间里可以同时开好几桌，这桌坐满了就回分类页再开一桌<br>
            · 邀请一位朋友 ≈ 一次 AI 请求；匹配一次可以补齐多名<br>
            · 邀请的对话会记进你和他的聊天记录里<br>
            · 人不满也能开始，系统会用临时路人补齐<br>
            · 座位一旦被邀请中的人预定，匹配会绕开它
        </div>
    `;
}

function renderSeat(app, n, seat, reservation) {
    if (seat) {
        const isMe = seat.characterId === app.me;
        const avatar = seat.characterId
            ? `<div class="ww-avatar">${getAvatarHtml(seat.characterId, esc((seat.name || '?').charAt(0)))}</div>`
            : `<div class="ww-avatar-fallback">${esc((seat.name || '?').charAt(0))}</div>`;
        const sub = isMe ? '你' : (seat.kind === 'npc' ? '临时路人' : '玩家');
        return `
            <button class="ww-seat ${isMe ? 'is-me' : ''}" data-seat="${n}" ${app.readonly || !isMe ? 'disabled' : ''}>
                <span class="ww-seat-num">${n}</span>
                ${avatar}
                <span class="ww-seat-main">
                    <span class="ww-seat-name">${esc(seat.name || '')}</span>
                    <span class="ww-seat-sub">${esc(sub)}</span>
                </span>
            </button>
        `;
    }
    if (reservation) {
        const name = reservation.name || getCharacterNameById(reservation.characterId) || '有人';
        return `
            <button class="ww-seat is-reserved" disabled>
                <span class="ww-seat-num">${n}</span>
                <span class="ww-avatar-fallback">…</span>
                <span class="ww-seat-main">
                    <span class="ww-seat-name">邀请中</span>
                    <span class="ww-seat-sub">${esc(name)}</span>
                </span>
            </button>
        `;
    }
    return `
        <button class="ww-seat is-empty" data-seat="${n}" ${app.readonly ? 'disabled' : ''}>
            <span class="ww-seat-num">${n}</span>
            <span class="ww-avatar-fallback" style="background:transparent;">＋</span>
            <span class="ww-seat-main">
                <span class="ww-seat-name">空位</span>
                <span class="ww-seat-sub">${app.readonly ? '空着' : '点一下坐下'}</span>
            </span>
        </button>
    `;
}

/* ---------------- 对局页（旁观共用同一套渲染） ---------------- */

/** 我在这一局里的座位；旁观（我不在桌上）时为 null */
function mySeatOf(app, session) {
    return (session?.seats || []).find(s => s.characterId && s.characterId === app.me) || null;
}

/**
 * 夜里这一步该不该我亲手做：'guard' | 'wolf' | 'seer' | 'witch' | 'hunter' | null（不属于我就交给 AI）。
 * 只看「阶段 + 我在这一局里的身份」，**不能拿 ai.defaultActor 比对**——狼永远返回座号最小的活狼，
 * 坐在 4 号的狼玩家会永远轮不到自己动手。
 *
 * 猎人两条都得在「我还活着」之前判，因为轮到他时他都已经出局了：
 * 夜里被刀那一拍（他还没死，但已经知道自己要死），以及白天被票出局后补枪那一拍。
 * 没被刀的那些夜他什么都不做，也就不该给他一条选人条（跟「预言家不在世」那一拍一样点一下就过去）。
 */
function myNightDuty(app, session) {
    if (!session || app.readonly || isOver(session)) return null;
    const mine = mySeatOf(app, session);
    if (!mine) return null;
    // 被票出局的人挨个走流程：轮到我的那一下，若我要补的那一枪由我自己决定
    if (session.phase === 'skill_wait') {
        const cur = engine.currentDeath(session);
        return cur?.seat === mine.seat && cur.act === 'shot' ? 'hunter' : null;
    }
    if (session.phase === 'night_hunter') {
        return (mine.role === 'hunter' && mine.alive !== false
            && engine.hunterWakesTonight(session) === mine.seat) ? 'hunter' : null;
    }
    // 交警徽是他自己那一拍——与「技能」同一层，所以得排在存活判定之前
    // （出局的那位这时 `alive === false`，会被下面那一行挡掉；**翻过牌的警长还活着**，
    //   同样得把这一拍拿到手：他没出局，只是徽不能留在手里，见引擎的 executeOut）
    if (session.phase === 'badge_wait') {
        const cur = engine.currentDeath(session);
        return (cur?.seat === mine.seat && cur.badge === true
            && engine.isSheriff(session, mine.seat)) ? 'badge' : null;
    }
    if (mine.alive === false) return null;
    if (session.phase === 'night_guard') return mine.role === 'guard' ? 'guard' : null;
    if (session.phase === 'night_wolf') return mine.role === 'werewolf' ? 'wolf' : null;
    if (session.phase === 'night_seer') return mine.role === 'seer' ? 'seer' : null;
    // 女巫：两瓶药都用完了就没什么可点的（跟守卫不在世那一拍一样，点一下就过去）
    if (session.phase === 'night_witch') {
        if (mine.role !== 'witch') return null;
        return ai.nightTargets(session, 'witch', mine.seat).length ? 'witch' : null;
    }
    return null;
}

/** 还活着的狼队友（wolvesOf 含死人，得自己过一遍）；我是独狼时为 null */
function wolfMateOf(app, session, mine) {
    if (!mine || mine.role !== 'werewolf') return null;
    return engine.wolvesOf(session).find(s => s.alive !== false && s.seat !== mine.seat) || null;
}

function isOver(session) {
    return !session || session.status === 'ended' || session.status === 'voided' || session.phase === 'ended';
}

/**
 * 这局里「我」能看到的身份：自己的、狼同伴的、以及局终之后的全场。
 * 座位上的 seat.role 是引擎发的底牌，界面得按视角过滤一遍再渲染——
 * 把底牌直接铺在屏幕上就等于给玩家开了上帝视角。
 */
function visibleRoleOf(app, session, seat) {
    if (!seat?.role) return '';
    const mine = mySeatOf(app, session);
    if (isOver(session)) return roleLabel(seat.role);                 // 局终：全场公开
    if (mine && seat.seat === mine.seat) return roleLabel(seat.role); // 自己的底牌
    if (seat.flipped === true) return roleLabel(seat.role);           // 翻过牌的白痴：底牌当众亮过
    // 明牌局：出局就公开身份（流水里已经公告过，围观的人也看得到）
    if (revealModeOf(session) === 'open' && seat.alive === false) return roleLabel(seat.role);
    if (mine && mine.role === 'werewolf' && seat.role === 'werewolf') return roleLabel(seat.role); // 狼看同伴
    return '';
}

/**
 * 该谁动了；夜里是谁在行动是秘密，不标。
 * **发言的那四拍不从这儿出**（`day_speak` / `day_pk` / 上警发言 / 竞选平票加说一轮）——
 * 那几拍的高亮是「你刚叫起来的那一位」，见 `calledSeatOf`。
 */
function actingSeat(session) {
    if (session?.status !== 'ongoing') return null;
    if (session.phase === 'day_vote') return engine.currentVoter(session)?.seat ?? null;
    if (session.phase === 'day_pk_vote') return engine.currentPkVoter(session)?.seat ?? null;
    // 竞选那条链：表态与两轮投票都是**静默**的（流水里没有逐座的话可读，高亮就是进度本身）
    if (session.phase === 'day_sheriff_signup') return engine.currentSheriffSignup(session)?.seat ?? null;
    if (session.phase === 'day_sheriff') return engine.currentSheriffVoter(session)?.seat ?? null;
    if (session.phase === 'day_sheriff_pk_vote') return engine.currentSheriffPkVoter(session)?.seat ?? null;
    // 定发言方向：高亮在任警长（警徽是公开信息，标出来不泄漏什么）
    if (session.phase === 'day_order') return engine.sheriffSeatOf(session);
    // 出局的人走流程时高亮他：**谁出局是公开的**，看不出的是他到底有没有技能
    if (session.phase === 'skill_wait') return engine.currentDeath(session)?.seat ?? null;
    if (session.phase === 'badge_wait') return engine.currentDeath(session)?.seat ?? null;
    if (session.phase === 'last_words') return engine.currentLastWordSpeaker(session);
    return null;
}

/** 四拍「让 X 号 X 发言」（见 renderTableBottom 里那四个按钮） */
const SPEAK_PHASES = ['day_speak', 'day_pk', 'day_sheriff_speak', 'day_sheriff_pk'];

/**
 * 该给谁打高亮。
 *
 * 发言那四拍**不按「谁该开口」**：`actingSeat` 指的是**下一位**，而他的那段话还在路上
 * （点一下 → 等 AI 回话 → 落进流水，是同一拍里的事）⇒ 高亮会比读到的东西快一步：
 * 你正在读某人的发言，亮的却是下一位（用户 2026-09-17 报的「高亮快了一点」）。这四拍
 * 因此改成「**你刚叫起来的那一位**」——`speakTurn` 在点下去那一刻落笔，连同相位与轮次
 * 一起记（换一天、换一拍，旧记录自然作废），这一拍一次都没点过就不亮。
 *
 * 其余阶段照旧走 `actingSeat`：那几拍高亮的就是正在发生的事（「等待发动技能」亮的是
 * 正在走流程的那一位），投票与表态那几拍没有逐座的话可读、高亮就是进度。
 */
function calledSeatOf(app, session) {
    if (!session || !SPEAK_PHASES.includes(session.phase)) return actingSeat(session);
    const c = app.calledSeat;
    return c && c.phase === session.phase && c.round === session.round ? c.seat : null;
}

/** 阶段条右边那句「现在到谁了」 */
function turnHint(app, session) {
    if (session.status !== 'ongoing') return '';
    const mine = mySeatOf(app, session);
    const at = seat => (seat ? `${seat.seat} 号 ${seat.name}` : '');
    const isMine = seat => !!mine && seat?.seat === mine.seat;
    switch (session.phase) {
        case 'night_guard': return myNightDuty(app, session) === 'guard' ? '轮到你守人' : '守卫正在守人';
        case 'night_wolf': return myNightDuty(app, session) === 'wolf' ? '轮到你下刀（先跟队友商量）' : '狼队正在商量';
        case 'night_seer': return myNightDuty(app, session) === 'seer' ? '轮到你验人' : '预言家正在验人';
        case 'night_witch': return myNightDuty(app, session) === 'witch' ? '轮到你用药' : '女巫正在用药';
        case 'night_hunter': return myNightDuty(app, session) === 'hunter' ? '轮到你决定开不开枪' : '猎人正在行动';
        case 'night_resolve': return '等天亮';
        case 'dawn': return '天亮了';
        // 上警表态：举手是同时的，**连进度都不能给**（那等于告诉别人「谁已经举了」）
        case 'day_sheriff_signup': {
            const seat = engine.currentSheriffSignup(session);
            if (!seat) return '等公布名单';
            return isMine(seat) ? '轮到你上警表态（只有一次机会）' : `轮到 ${at(seat)} 上警表态`;
        }
        // 警上发言：当众说的，谁说到哪儿大家都听得到
        case 'day_sheriff_speak': {
            const seat = engine.currentSheriffSpeaker(session);
            return seat ? (isMine(seat) ? '轮到你上警发言' : `轮到 ${at(seat)} 上警发言`) : '';
        }
        // 警下投票：与白天投票同一套说法（静默收票，进度只能从这儿给）。
        // 分母是**这一轮有票的人**（有票权的人减掉上过警的），与引擎那边同一个集合，不然进度条永远走不满
        case 'day_sheriff': {
            const seat = engine.currentSheriffVoter(session);
            const votes = session.sheriffVotes || {};
            const progress = `（${Object.keys(votes).length}/${engine.sheriffVotersOf(session).length}）`;
            if (!seat) return '等开票';
            if (isMine(seat)) return `轮到你选警长${progress}`;
            if (mine && Object.prototype.hasOwnProperty.call(votes, mine.seat)) return `你已投票，等其他人${progress}`;
            return `轮到 ${at(seat)} 选警长${progress}`;
        }
        case 'day_sheriff_verdict': return '等开票';
        // 竞选平票的加说一轮与补投：与白天 PK 那两拍同一个手感
        case 'day_sheriff_pk': {
            const seat = engine.currentSheriffPkSpeaker(session);
            return seat ? (isMine(seat) ? '轮到你竞选 PK 发言' : `轮到 ${at(seat)} 竞选 PK 发言`) : '';
        }
        case 'day_sheriff_pk_vote': {
            const seat = engine.currentSheriffPkVoter(session);
            const votes = session.sheriffPk?.votes || {};
            const progress = `（${Object.keys(votes).length}/${engine.sheriffPkVotersOf(session).length}）`;
            if (!seat) return '等开票';
            if (isMine(seat)) return `轮到你补投${progress}`;
            if (mine && Object.prototype.hasOwnProperty.call(votes, mine.seat)) return `你已投过，等其他人${progress}`;
            return `轮到 ${at(seat)} 补投${progress}`;
        }
        // 公布昨夜死讯：死讯在结算时就算定了，这一拍是当众念出来——念完才轮到出局者走流程
        case 'day_deaths': return '公布昨夜的死讯';
        // 定发言方向：轮到在任警长（警徽公开，点着名说没问题）
        case 'day_order': {
            const who = engine.seatAt(session, engine.sheriffSeatOf(session));
            return isMine(who) ? '轮到你定从谁开口' : `轮到 ${at(who)} 定从谁开口`;
        }
        case 'day_speak': {
            const seat = engine.currentSpeaker(session);
            return seat ? (isMine(seat) ? '轮到你发言' : `轮到 ${at(seat)} 发言`) : '';
        }
        case 'day_vote': {
            const seat = engine.currentVoter(session);
            const votes = session.votes || {};
            // 分母是**有投票权的人**（活人减去翻过牌的白痴），不是活人数——不然进度条永远走不满
            const progress = `（${Object.keys(votes).length}/${engine.votersOf(session).length}）`;
            // 票是静默的：投过之后流里看不到自己那一票，进度只能靠这里给
            if (!seat) return '等开票';
            if (isMine(seat)) return `轮到你投票${progress}`;
            if (mine && Object.prototype.hasOwnProperty.call(votes, mine.seat)) return `你已投票，等其他人${progress}`;
            return `轮到 ${at(seat)} 投票${progress}`;
        }
        // PK 台上那一轮：台上的人挨个说一遍，说的还是同一个发言框
        case 'day_pk': {
            const seat = engine.currentPkSpeaker(session);
            return seat ? (isMine(seat) ? '轮到你 PK 发言' : `轮到 ${at(seat)} PK 发言`) : '';
        }
        case 'day_pk_vote': {
            const seat = engine.currentPkVoter(session);
            const votes = session.pk?.votes || {};
            const progress = `（${Object.keys(votes).length}/${engine.pkVotersOf(session).length}）`;
            if (!seat) return '等开票';
            if (isMine(seat)) return `轮到你补投${progress}`;
            if (mine && Object.prototype.hasOwnProperty.call(votes, mine.seat)) return `你已投过，等其他人${progress}`;
            return `轮到 ${at(seat)} 补投${progress}`;
        }
        case 'day_verdict': return '等开票';
        // 出局的人挨个走自己的流程（等待发动技能）。轮到谁就是谁，走完一个换下一个。
        // 轮到自己时跟别处一样说「轮到你了」：所有人都是同一句，看不出这一拍里谁有技能要发动。
        case 'skill_wait': {
            const cur = engine.currentDeath(session);
            if (!cur) return '';
            const who = engine.seatAt(session, cur.seat);
            return isMine(who) ? '轮到你了' : `轮到 ${at(who)}`;
        }
        // 交警徽：同一个人的第三拍（技能 → 遗言 → 警徽）。他是在任警长这件事全场都知道
        case 'badge_wait': {
            const who = engine.seatAt(session, engine.currentDeath(session)?.seat);
            return isMine(who) ? '轮到你移交警徽' : `轮到 ${at(who)} 移交警徽`;
        }
        // 遗言是同一个人的第二拍：谁出局是公开的，所以这一句可以点着名说
        case 'last_words': {
            const who = engine.seatAt(session, engine.currentLastWordSpeaker(session));
            return isMine(who) ? '轮到你留遗言' : `轮到 ${at(who)} 留遗言`;
        }
        default: return '';
    }
}

function renderPhaseBar(app, session, board) {
    const alive = engine.aliveSeats(session).length;
    const label = session.status === 'voided' ? '本局已流局'
        : (isOver(session) ? '本局结束' : (engine.phaseLabel(session) || '准备中'));
    const hint = turnHint(app, session);
    const open = !!app.boardOpen;
    return `
        <section class="ww-phase">
            <div class="ww-phase-main"><span class="ww-dot"></span><strong>${esc(label)}</strong></div>
            <div class="ww-phase-sub">${esc(`存活 ${alive}/${board.seats} 人`)}${hint ? ` · ${esc(hint)}` : ''}</div>
            <button class="ww-phase-more${open ? ' open' : ''}" id="wwBoardBtn"
                    aria-label="${open ? '收起场上' : '展开场上'}" aria-expanded="${open}">${open ? '▴' : '▾'}</button>
        </section>
    `;
}

/**
 * 「场上」小面板：一行 6 个的座位一览，滚到多深都能扫一眼、顺手贴标记。
 * 点格子走的是与主视图座位**同一条路**（`openMarkPanel`），不另写一套。
 * 它**浮在发言流上面**（CSS 里绝对定位，不在流里）——开合不改任何人的几何，所以发言流不会
 * 被推走；代价是它盖住的那一截在开着的时候看不见：滚动能把下面的文字送到它边上、也能把
 * 被压住的中段露出来，唯独 **feed 最开头那截露不出来**——它跟面板一样高（12 人局 136px），
 * 要露出来得让滚动位置变成负数，做不到，只能先把面板收起。
 * （用户 2026-09-15 在「占位+滚动补偿」和「覆盖」之间选的覆盖。）
 * 高度是格子尺寸算出来的确定值（6 列 × 人数行），没有 max-height 兜底——
 * 12 人也不过两行，天然落在三分之一屏内。名字溢出在自己格里省略，不参与撑高。
 */
function renderBoardPanel(app, session) {
    const mine = mySeatOf(app, session);
    return `
        <div class="ww-board">
            ${(session.seats || []).map(s => renderBoardCell(app, session, s, mine)).join('')}
        </div>
    `;
}

function renderBoardCell(app, session, seat, mine) {
    const isMe = !!mine && seat.seat === mine.seat;
    const dead = seat.alive === false;
    const role = visibleRoleOf(app, session, seat);   // 视角里明确的身份，不是底牌
    const mark = myMarkOf(session, seat.seat);
    // 标记只服务代笔，旁观者用不上；自己也不需要给自己贴（跟主视图同一套口径）
    const canMark = !isOver(session) && !app.readonly && !!mine && !isMe;
    // 复盘期这一格改用另一路：点它 = 让这个角色自己复盘这一局（标记那一路整局都关了）
    const grow = canInsight(app, session, seat);
    const cls = [
        isMe ? 'is-me' : '',
        dead ? 'is-dead' : '',                                  // 离场只灰暗，不写字
        calledSeatOf(app, session) === seat.seat ? 'is-turn' : ''
    ].filter(Boolean).join(' ');
    const who = grow ? `让 ${seat.name} 复盘这一局` : `${seat.seat} 号 ${seat.name || ''}`;
    // 两个角标一律**常驻**（没内容时 CSS 自己藏），这样就地更新只改文字、不用管增删。
    // 位置的分工写在 werewolf.css 的 .ww-mini-badge 那一块（右上身份 / 右下我贴的 / 左下留给金水银水）
    return `
        <button class="ww-mini-seat ${cls}" ${grow ? `data-insight="${seat.seat}"` : `data-board-seat="${seat.seat}"`}
                ${grow || canMark ? '' : 'disabled'}
                title="${esc(who)}" aria-label="${esc(who)}">
            <span class="ww-mini-num">${seat.seat}</span>
            <span class="ww-mini-face">
                ${avatarHtml(seat.characterId, seat.name)}
                <span class="ww-mini-badge role">${esc(markShortOf(role))}</span>
                <span class="ww-mini-badge mark">${esc(markShortOf(mark))}</span>
                <span class="ww-mini-badge sheriff">${engine.isSheriff(session, seat.seat) ? '警' : ''}</span>
            </span>
            <span class="ww-mini-name">${esc(seat.name || '')}</span>
        </button>
    `;
}

/** 只有本局的玩家能看自己的底牌；旁观页上没有这张卡 */
function renderIdentityCard(app, session, mine) {
    if (!mine || isOver(session)) return '';
    const view = engine.viewOf(session, mine.seat);
    if (!view) return '';
    const wolf = view.faction === 'wolf';
    const checks = view.checks || [];
    const guarded = view.guarded || [];
    const witchLog = view.witchLog || [];
    return `
        <section class="ww-identity ${wolf ? 'wolf' : 'good'}">
            <div class="ww-identity-head">
                <small>你的身份</small>
                <strong>${esc(`${view.roleLabel} · ${wolf ? '狼人阵营' : '好人阵营'}`)}</strong>
            </div>
            ${view.teammates?.length ? `<p>狼同伴：${esc(view.teammates.map(t => `${t.seat} 号 ${t.name}`).join('、'))}</p>` : ''}
            ${checks.length ? `<p>验过的人：${checks.map((c, i) => {
                const one = esc(`${c.seat} 号 ${c.name} 是${c.isWolf ? '狼人' : '好人'}`);
                return i === checks.length - 1 ? `<em class="ww-check-latest">${one}</em>` : one;
            }).join('；')}</p>` : ''}
            ${guarded.length ? `<p>守过的人：${guarded.map((g, i) => {
                const one = esc(`第 ${g.round} 夜 ${g.seat} 号 ${g.name}`);
                return i === guarded.length - 1 ? `<em class="ww-check-latest">${one}</em>` : one;
            }).join('；')}</p>` : ''}
            ${view.potions ? `<p>药：解药${view.potions.heal ? '还在' : '已用'}、毒药${view.potions.poison ? '还在' : '已用'}</p>` : ''}
            ${witchLog.length ? `<p>夜里的记录：${witchLog.map((w, i) => {
                // 解药用了之后法官就不再告诉她刀口了，那些夜只记她做了什么
                const knife = w.told === false ? '没告诉你刀口'
                    : (w.killed ? `${w.killed} 号 ${w.killedName}` : '没有人被刀');
                const one = esc(`第 ${w.round} 夜 ${knife}`
                    + `${w.saved ? '（你救了）' : ''}${w.poisoned ? `（你毒了 ${w.poisoned} 号 ${w.poisonedName}）` : ''}`);
                return i === witchLog.length - 1 ? `<em class="ww-check-latest">${one}</em>` : one;
            }).join('；')}</p>` : ''}
            ${engine.isSheriff(session, mine.seat) ? '<p>你现在是警长：你那一票算 1.5 票；每天天亮由你定从警左还是警右开口；你出局时要把警徽当众交给一个还有票的人，也可以当场撕掉。</p>' : ''}
            ${view.knifed ? '<p>你今晚被狼刀了，天亮就会出局。</p>' : ''}
        </section>
    `;
}

function renderTableSeat(app, session, seat, mine, over) {
    const isMe = !!mine && seat.seat === mine.seat;
    const dead = seat.alive === false;
    const role = visibleRoleOf(app, session, seat);
    const mark = myMarkOf(session, seat.seat);
    // 上警与退水都是**公布之后**的公开事实（名单是收齐那一刻当众念的），所以只在名单落下来之后才画；
    // 竞选结束也不清（sheriffStage 留着），这一局谁上过警、谁退了水，翻到哪儿都看得到
    const stage = session.sheriffStage;
    const withdrew = (stage?.withdrew || []).includes(seat.seat);
    const ran = !!stage && stage.seats.includes(seat.seat) && !withdrew;
    const tags = [
        // 警徽是公开信息（谁都知道警长是谁），所以这一枚不按视角过滤，也不受「局终才公开」那条管
        engine.isSheriff(session, seat.seat) ? '<span class="ww-pill sheriff">警长</span>' : '',
        ran ? '<span class="ww-pill candidate">上警</span>' : '',
        withdrew ? '<span class="ww-pill muted">已退水</span>' : '',
        role ? `<span class="ww-pill ${seat.role === 'werewolf' ? 'wolf' : 'good'}">${esc(role)}</span>` : '',
        mark ? `<span class="ww-pill muted">${esc(mark)}</span>` : ''
    ].filter(Boolean).join('');
    // 标记只服务代笔，旁观者用不上；自己也不需要给自己贴
    const canMark = !over && !app.readonly && !isMe;
    // 复盘期这一格改用另一路：点它 = 让这个角色自己复盘这一局（标记那一路整局都关了）。
    // 自己那一格照样点得动——复盘是每个角色自己的事，主视角的角色也要能想想这一局
    const grow = canInsight(app, session, seat);
    return `
        <button class="ww-seat ${isMe ? 'is-me' : ''} ${dead ? 'is-dead' : ''} ${calledSeatOf(app, session) === seat.seat ? 'is-turn' : ''}"
                ${grow ? `data-insight="${seat.seat}"` : `data-mark="${seat.seat}"`} ${grow || canMark ? '' : 'disabled'}>
            <span class="ww-seat-num">${seat.seat} 号</span>
            ${avatarHtml(seat.characterId, seat.name)}
            <span class="ww-seat-main">
                <span class="ww-seat-name">${esc(seat.name || '')}${isMe ? '（你）' : ''}</span>
                <span class="ww-seat-sub">${dead ? '已出局' : (seat.flipped === true ? '已翻牌 · 没有票' : '存活')}${seat.kind === 'npc' ? ' · 路人' : ''}</span>
                ${tags ? `<span class="ww-seat-tags">${tags}</span>` : ''}
            </span>
        </button>
    `;
}

/**
 * 事件流水：发言带头像与名字，其余是系统行。
 * 公开事件谁都看得到；狼队频道（isPublic 为假）只给「这一局里我是狼」的那块屏幕——
 * 判定按**渲染这一刻**的视角算，旁观者与其他人一个字都拿不到。
 */
function renderFeed(app, session, mine) {
    const isWolf = !!mine && mine.role === 'werewolf';
    const events = (session.events || []).filter(ev =>
        ev.isPublic !== false || (isWolf && ev.type === 'wolfchat'));
    const feed = !events.length ? `<div class="ww-empty">还没发生什么</div>` : events.map(ev => {
        // 遗言与发言是同一段版式（都是「谁在说话」），只有一个小标记不同：
        // 它是那个人的最后一段话，翻流水时得一眼看得出来
        if (ev.type === 'speak' || ev.type === 'lastword') {
            const words = ev.type === 'lastword';
            const seat = engine.seatAt(session, ev.seat);
            const body = String(ev.text || '').replace(/^\d+ 号 [^：]*：/, '');
            const isMine = !!mine && ev.seat === mine.seat;
            return `
                <div class="ww-line ${isMine ? 'mine' : ''} ${words ? 'words' : ''}">
                    <div class="ww-line-head">
                        ${avatarHtml(seat?.characterId, seat?.name || '')}
                        <strong>${esc(`${ev.seat} 号 ${seat?.name || ''}`)}</strong>
                        ${words ? '<span class="ww-pill muted">遗言</span>' : ''}
                        ${isMine ? '<span class="ww-dot"></span>' : ''}
                    </div>
                    <div class="ww-line-body">${esc(body)}</div>
                </div>
            `;
        }
        // 投票那条消息尾巴上多一个小圆点：点开可以花钻石看**投这一票的人**当时的心声
        // （道具，用户 2026-09-13 定）。只在真有那一条心声时才画——没有的是主视角
        // 自己手投的那票（他没打过 AI 调用）。**托管的那票照画**（用户当天定的）：
        // 那一票是 AI 替他决定的，不摆出来他根本不知道 AI 给他写了什么心声。
        if (ev.type === 'vote') {
            const has = !!heartOf(session, ev.seat, ev.round);
            return `<div class="ww-line system">${FEED_ICON.vote} ${esc(ev.text || '')}`
                + (has ? `<button type="button" class="ww-heart-dot" title="看这一票的心声"`
                    + ` aria-label="看这一票的心声" data-heart-seat="${ev.seat}"`
                    + ` data-heart-round="${ev.round ?? ''}"></button>` : '')
                + `</div>`;
        }
        const night = ev.type === 'system' && /夜/.test(ev.text || '');
        const whisper = ev.isPublic === false;
        const icon = FEED_ICON[ev.type] || '';
        return `<div class="ww-line system ${night ? 'night' : ''} ${whisper ? 'whisper' : ''}">${icon ? `${icon} ` : ''}${esc(ev.text || '')}</div>`;
    }).join('');
    return feed + renderReviewMessages(app, session, mine);
}

const FEED_ICON = {
    death: '⚰️', vote: '🗳️', tally: '📊', verdict: '⚖️', shot: '🔫', flip: '🃏', end: '🏁', wolfchat: '🐺',
    sheriff: '👮', badge: '🎖️',
    // 竞选那一条链里只有「退水」是单独一个 type（名单公布与当选共用 sheriff，见引擎 applySheriffSignup）
    withdraw: '🚪'
};

/** 结束（或流局）之后的那一小段结算：谁能赢、谁活到了最后 */
function renderEnding(app, session, mine) {
    if (session.status === 'voided') {
        return `<div class="ww-line system">这一局流局了，桌上的人都已经解锁，战绩不计入。</div>`;
    }
    const rows = engine.finalResult(session);
    const winner = session.winner === 'wolf' ? '狼人获胜' : session.winner === 'good' ? '好人获胜' : '本局结束';
    const mineRow = mine ? rows.find(r => r.seat === mine.seat) : null;
    return `
        <div class="ww-section-title"><strong>${esc(winner)}</strong><span>${esc(mineRow ? (mineRow.win ? '你赢了' : '你输了') : '旁观')}</span></div>
        ${mineRow ? `<div class="ww-line ${mineRow.win ? 'mine' : ''}">你是 ${esc(roleLabel(mineRow.role))}（${esc(mineRow.faction === 'wolf' ? '狼人阵营' : '好人阵营')}），${esc(mineRow.alive ? '活到了最后' : '中途出局')}。</div>` : ''}
        ${rows.map(r => `<div class="ww-line">${esc(`${r.seat} 号 ${r.name} · ${roleLabel(r.role)} · ${r.faction === 'wolf' ? '狼人' : '好人'} · ${r.alive ? '活到最后' : '出局'}${r.characterId ? '' : '（路人）'}`)}</div>`).join('')}
    `;
}

/* ---------------- 赛后复盘（牌摊开之后的桌边群聊） ----------------
 * 机制（用户 2026-09-13 定）：点名制——被 @ 到的角色才说话，不轮流、不自动。
 *
 * **冷却只管自动接话那一路**（用户 2026-09-13 后补的口径）：
 *  · 自动接话**关**（默认）——能叫人的只有主视角自己，没有 AI 互相接话就没有失控的链，
 *    于是**没有冷却**：点一次叫一次，冷启动立刻开口。
 *  · 自动接话**开**——AI 点谁就能接着叫谁，链子会长。这里才用窗口把冷却期里重复点他的
 *    那几次**并成一次调用**：不重置、不排队，话留在消息流里，攒到窗口尽头补一次，
 *    那一次喂的是那一刻的场上全量信息，由他自己决定说什么、回谁。每座每 60s 至多一次调用。
 * 两种状态下正在说的是本人时，新点名都不丢：关着 = 等这一段落地就接着说（`pending`），
 * 开着 = 并进他的下一个窗口。
 *
 * 「停」和「退出房间」都掐掉所有还在计的窗口：不再触发任何新调用（成本由玩家在不在场决定）。
 */

const REVIEW_CD = 60000;

/** 复盘消息流最多留多少条（一桌一局，够了） */
const REVIEW_KEEP = 200;

/** 复盘里主视角能不能说话：这一局真打完了，而且他在座上（旁观只能看） */
function canReview(app, session) {
    return !!session && session.status === 'ended' && !app.readonly && !!mySeatOf(app, session);
}

/** @ 到空白为止都高亮：不追求每个 @ 都解析成座位，视觉上那一段字是一个整体 */
function highlightAt(text) {
    return esc(String(text || '')).replace(/@[^\s@，。！？、,.!?：:；;]*/g, m => `<span class="ww-rv-at">${m}</span>`);
}

/** 复盘消息流：接在公开流水后面。
 *  **CD 在后台走，界面上一笔都不画**（用户 2026-09-13：「cd 中不用明确显示」）——
 *  能看见的停顿只有一个：调用已经发出、结果还没回来的那一段（`thinking`）。 */
function renderReviewMessages(app, session, mine) {
    const list = session.review || [];
    const thinking = [...(app.review?.thinking || [])];
    if (!list.length && !thinking.length) return '';
    const nameOf = n => `${n} 号 ${engine.seatAt(session, n)?.name || ''}`;
    return `
        <div class="ww-review-title">—— 赛后复盘 ——</div>
        <div class="ww-review">
            ${list.map(m => {
                const isMine = !!mine && m.seat === mine.seat;
                return `
                    <div class="ww-rv-line ${isMine ? 'mine' : ''}">
                        <div class="ww-rv-head">${isMine ? '你' : esc(`${m.seat} 号 ${m.name}`)}</div>
                        <div class="ww-rv-bubble">${highlightAt(m.text)}</div>
                    </div>
                `;
            }).join('')}
            ${thinking.map(n => `<div class="ww-rv-line thinking"><div class="ww-rv-bubble">${esc(nameOf(n))} 正在想…</div></div>`).join('')}
        </div>
    `;
}

/**
 * 复盘期的座位点不点得动（点了 = 让那个角色自己复盘这一局，见 openInsightPanel）。
 *
 * 点的是**座位本身**——与对局中「点座位贴标记」是同一处，复盘期标记那一路关掉了，换成这一路。
 * 两处座位区（主视图的 `.ww-seat` 与「场上」小面板的 `.ww-mini-seat`）共用这一个口径。
 *
 * 只有**真角色**（名册/网络里有 characterId 的）点得动：心得要进他的狼人杀档案、
 * 记忆要进他的角色记忆，两样都得有个能**跨局积累**的角色接着——路人没有这一端。
 * 局还得是**打完的**（流局没有「这一局」可复盘），旁观者点不了。
 */
function canInsight(app, session, seat) {
    return isOver(session) && session.status === 'ended' && !app.readonly
        && !!seat && seat.kind !== 'npc' && !!seat.characterId;
}

/** 复盘期的底部：输入框（打 @ 弹人）+ 自动接话开关 + 发送；旁观与不在座上只给「回列表」 */
function renderReviewComposer(app, session, mine) {
    // 复盘里的 AI 调用**不走 `app.review.thinking`**（那是「谁在说话」那一路，界面自己画「正在想…」）。
    // 心得这一路是玩家点出来的、期间不打字也不该再点，所以借桌子那条同样的忙碌态顶一下——
    // 没有这一段，界面上就是一个字都不动的输入框，最长要等两分钟。
    if (app.busy) {
        return `<footer class="ww-bottom"><button class="primary" disabled>⏳ 正在复盘这一局…</button></footer>`;
    }
    if (!canReview(app, session)) {
        return `<footer class="ww-bottom"><button id="wwLeaveTable" class="primary">回房间列表</button></footer>`;
    }
    return `
        <footer class="ww-bottom column">
            <div id="wwMentionList" class="ww-mention-list"></div>
            <div class="ww-hint">赛后桌边：@ 谁，谁就说（打 @ 弹出这桌的人）。</div>
            <textarea id="wwReviewDraft" class="ww-input" placeholder="想听谁说话就 @ 他">${esc(app.review.draft || '')}</textarea>
            <div class="ww-composer-row">
                <button id="wwAutoReply" class="ghost ${session.autoReply ? 'on' : ''}">自动接话：${session.autoReply ? '开' : '关'}</button>
                <button id="wwReviewSend" class="primary">发送</button>
                <button id="wwLeaveTable" class="ghost">回列表</button>
            </div>
        </footer>
    `;
}

/**
 * 这一局结束之后的所有写入都走这条队列。**不能用 mutateSession**：它开头那道
 * ACTIVE_STATUS 早退会把 ended 的局整个拒掉（结算钩子正靠它防重入）。
 * 所以这里自己读-改-写；多个角色的 CD 可能同时到点，不串起来会互相覆盖。
 */
function queueSessionWrite(app, mutate) {
    const sid = app.session?.id;
    if (!sid) return Promise.resolve(null);
    app.reviewChain = (app.reviewChain || Promise.resolve()).then(async () => {
        const fresh = await store.getSession(sid);
        if (!fresh) return null;
        if (mutate(fresh) === false) return null;
        const ok = await store.saveSession(fresh);
        if (ok && app.session?.id === sid) app.session = fresh;
        return ok ? fresh : null;
    }).catch(e => {
        console.warn('[werewolf] 复盘写入失败', e);
        return null;
    });
    return app.reviewChain;
}

/** 往复盘里落一条。消息流本身封顶，免得一桌聊到天荒地老把存档撑大 */
function pushReview(app, msg) {
    return queueSessionWrite(app, s => {
        s.review = [...(s.review || []), msg].slice(-REVIEW_KEEP);
    });
}

/**
 * 排一次「被点名」。冷却只属于自动接话：那条链是 AI 自己接的，得有个闸；
 * 主视角手点出来的每一次 @ 都是一句话，不该被上一个 60s 挡住。
 */
function scheduleSummon(app, close, seatNo) {
    const session = app.session;
    if (!session || session.status !== 'ended') return;
    if (app.review.timers.has(seatNo)) return;      // 已经在攒了，这一次并进去
    if (!engine.seatAt(session, seatNo)) return;
    // 主视角那一座不自动叫（用户 2026-09-13）：自动接话是角色之间的链，@ 到他头上不该由 AI 代言。
    // 他被 @ 了会在气泡里看见，回不回是他自己的事。放在这个唯一入口上，以后谁再加路径都自动继承。
    if (seatNo === mySeatOf(app, session)?.seat) return;
    if (!session.autoReply) { fireReview(app, close, seatNo); return; }
    const wait = (app.review.readyAt.get(seatNo) || 0) - Date.now();
    if (wait <= 0) { fireReview(app, close, seatNo); return; }
    armReview(app, close, seatNo, wait);
}

/** 排一个延时窗口 */
function armReview(app, close, seatNo, delay) {
    const timer = setTimeout(() => {
        app.review.timers.delete(seatNo);
        fireReview(app, close, seatNo);
    }, Math.max(0, delay));
    app.review.timers.set(seatNo, timer);
}

/** 真的开一次口：先把这个座位的下一个窗口定下来，再决定现在说不说 */
function fireReview(app, close, seatNo) {
    app.review.readyAt.set(seatNo, Date.now() + REVIEW_CD);
    // 上一段还在说（窗口是它说话时被点起来的）：等它说完再说，别把点名丢了
    if (app.review.thinking.has(seatNo)) {
        // 自动接话关着：没有窗口可并，等这一段落地就接着说
        if (app.session?.autoReply) armReview(app, close, seatNo, REVIEW_CD);
        else app.review.pending.add(seatNo);
        return;
    }
    runReviewSpeak(app, close, seatNo);
}

/** 这位座位的档案（知识块用）：真角色读 stats，路人读 npcs */
function seatRecord(seat) {
    if (!seat) return Promise.resolve(null);
    return seat.kind === 'npc'
        ? store.getNpc(seat.npcId).catch(() => null)
        : store.getStat(seat.characterId).catch(() => null);
}

/** 一次调用 = 这位角色的一段复盘发言。降级（没 key / 超时）走模板台词，绝不让桌子卡住 */
async function runReviewSpeak(app, close, seatNo) {
    const session = app.session;
    if (!session || session.status !== 'ended' || app.review.thinking.has(seatNo)) return;
    const seat = engine.seatAt(session, seatNo);
    if (!seat) return;

    app.review.thinking.add(seatNo);
    renderApp(app, close);
    let res;
    try {
        const record = await seatRecord(seat);
        res = await ai.reviewSpeak({ session, seatNo, type: getRoomType(session.typeId), record });
    } catch (e) {
        console.warn('[werewolf] 复盘调用失败', e);
        res = { text: ai.fallbackReview(seatNo), mentions: [], degraded: true };
    }
    app.review.thinking.delete(seatNo);
    // 说这段的时候又被点了一次（自动接话关着才会攒这个）：这段话落地后接着再说一轮。
    // 先取走再用，保证一条点名只兑现一次调用。
    const again = app.review.pending.delete(seatNo);

    // 这一局可能已经被换掉 / 已经退出房间了：落库前再确认一次
    if (app.session?.id !== session.id) { renderApp(app, close); return; }
    await pushReview(app, {
        seat: seatNo, name: seat.name, text: res.text,
        t: Date.now(), mentions: res.mentions || [], degraded: !!res.degraded
    });
    // 自动接话：他点名了谁就接着叫谁（开关关着就到此为止）
    if (app.session?.autoReply) {
        for (const n of (res.mentions || [])) if (n !== seatNo) scheduleSummon(app, close, n);
    }
    renderApp(app, close);
    if (again) fireReview(app, close, seatNo);
}

/** 主视角在复盘里说话：自己的先落，再给被点到的人排窗口（自己被 @ 不算） */
async function sendReview(app, close) {
    const session = app.session;
    if (!canReview(app, session)) return;
    const text = String(app.review.draft || '').trim();
    if (!text) return;
    const mine = mySeatOf(app, session);
    const mentions = engine.parseMentions(text, session).filter(n => n !== mine.seat);
    app.review.draft = '';
    app.review.picker = null;
    await pushReview(app, { seat: mine.seat, name: mine.name, text, t: Date.now(), mentions });
    renderApp(app, close);
    for (const n of mentions) scheduleSummon(app, close, n);
}

/* ---------------- 复盘心得（点座位头像 → 角色自己复盘这一局） ----------------
 * 链：点座位 → 问一句要不要做 →（**一次调用**）→ 预览 → 记忆由玩家决定写不写。
 *
 * 为什么先问一句：这一下要花掉一次调用（玩家按次数计费），写进去的又是**角色自己的档案**。
 * **已经做过的那一局不再问、也不再调用**——按 `sessionId` 在档案里认出来，直接把存下的端出来看。
 *
 * 两样东西的去处分得很开（用户 2026-09-16 定）：
 *   · **心得**（偏复盘＋成长）＝ 狼人杀的履历 ⇒ `werewolfStore.appendInsight`，就留在本模块；
 *   · **记忆**（偏日常）＝ 角色自己的 ⇒ 玩家点头后才写进 `char_<id>.memories`（**默认不写**）。
 */

/** 点座位的入口（主视图那一栏与「场上」小面板共用）。判定与 `canInsight` 逐条对齐——
 *  这边再拦一道，是因为它是唯一的执行口，不能让一个画得出来的格子决定能不能调用。 */
async function openInsightPanel(app, close, seatNo) {
    const session = app.session;
    if (!session || session.status !== 'ended' || app.readonly || app.busy) return;
    const seat = engine.seatAt(session, seatNo);
    if (!seat || seat.kind === 'npc' || !seat.characterId) return;

    const record = await seatRecord(seat).catch(() => null);   // 顺手读了：判重与调用都要它
    if (app.session?.id !== session.id) return;

    const done = (record?.insights || []).find(i => i.sessionId === session.id);
    if (done) return showInsightPanel(app, session, seat, done);

    modal(app, {
        title: `让 ${seat.name} 复盘这一局？`,
        sub: `${seat.name} 会以他自己的视角把这一局过一遍，留下一份心得，和一条他自己的记忆。花一次调用。`,
        actions: [{ label: '让他复盘', run: () => runInsight(app, close, seat, record) }]
    });
}

/** 真的调一次。失败**不给模板顶**——这是玩家亲手点出来的，编一段假心得塞进他档案里比空着更糟 */
async function runInsight(app, close, seat, record) {
    const session = app.session;
    if (!session || app.busy) return;
    app.busy = true;
    renderApp(app, close);

    let res;
    try {
        res = await ai.reviewInsight({
            session, seatNo: seat.seat, type: getRoomType(session.typeId), record
        });
    } catch (e) {
        console.warn('[werewolf] 复盘心得调用失败', e);
        res = { insight: '', memory: '', degraded: true, reason: e?.message || String(e) };
    }
    app.busy = false;

    // 这一局可能已经被换掉 / 已经退出房间了：落库前再确认一次
    if (app.session?.id !== session.id) { renderApp(app, close); return; }
    if (res.degraded || !res.insight) {
        renderApp(app, close);
        modal(app, {
            title: '这次没拿到结果',
            sub: '调用没成功，档案里什么都没留下。要再来一次吗？',
            actions: [{ label: '重试', run: () => runInsight(app, close, seat, record) }]
        });
        return;
    }

    const row = engine.finalResult(session).find(r => r.seat === seat.seat);
    const fresh = await store.appendInsight(seat.characterId, {
        sessionId: session.id,
        tableNo: session.tableNo || 0,
        role: seat.role,
        win: !!row?.win,
        text: res.insight,
        memory: res.memory || ''
    });
    renderApp(app, close);
    const entry = (fresh?.insights || []).find(i => i.sessionId === session.id);
    showInsightPanel(app, session, seat, entry || { text: res.insight, memory: res.memory });
}

/** 预览这一局的心得：心得已经入档；记忆等他点头 */
function showInsightPanel(app, session, seat, entry) {
    const saved = !!entry?.memorySavedAt;
    const memory = String(entry?.memory || '').trim();
    const pending = !!memory && !saved;   // 还有一件事等他点头：写不写进角色记忆
    modal(app, {
        title: `${seat.name} 的赛后心得`,
        sub: `第 ${session.tableNo || '?'} 桌 · ${roleLabel(seat.role)}${entry?.win ? ' · 赢了' : ''}`,
        bodyHtml: `
            <div class="ww-insight">
                <div class="ww-insight-label">心得 · 已记进他的狼人杀档案</div>
                <div class="ww-insight-text">${esc(entry?.text || '')}</div>
            </div>
            ${memory ? `
            <div class="ww-insight">
                <div class="ww-insight-label">记忆 · ${saved ? '已写进他的记忆' : '还没写进他的记忆'}</div>
                <div class="ww-insight-text">${esc(memory)}</div>
            </div>` : ''}
        `,
        // 没有待办时那一颗就只剩「关掉」，再叫「取消」就不对了
        closeLabel: pending ? '取消' : '关闭',
        actions: pending ? [{ label: '写进他的记忆', run: () => saveInsightMemory(app, close, seat, memory) }] : []
    });
}

/**
 * 把这一条记忆写进**角色自己的记忆**（`char_<id>.memories`）。
 *
 * 走的是聊天记忆**同一个入口**（`CharacterStore.addMemory`）⇒ 此后每一次对话的
 * 【角色的长期记忆】里都有它，别的模块（日记等）照读不误，**那一侧一个字都不用改**。
 * `source` / `participants` 是记忆条目本来就有的两栏（聊天那边写的是 `source:'chat'`，见 chat.js）：
 * 写明白来源与在场的人，读取侧不受影响。**只此一份**——心得档案里那一份是「这次调用产出了什么」
 * 的底账，外部模块读记忆一律认 `char_<id>.memories`。
 */
async function saveInsightMemory(app, close, seat, text) {
    const session = app.session;
    if (!session || seat.kind === 'npc' || !seat.characterId || !text) return;
    const others = (session.seats || []).filter(s => s.seat !== seat.seat && s.characterId).map(s => s.characterId);
    try {
        new CharacterStore(seat.characterId).addMemory({
            time: new Date().toLocaleString('zh-CN'),
            content: text,
            participants: [seat.characterId, ...others],
            source: 'werewolf'
        });
    } catch (e) {
        console.warn('[werewolf] 写入角色记忆失败', e);
        toast(app, '没写进去，再点一次试试');
        return;
    }
    await store.markInsightMemorySaved(seat.characterId, session.id);
    renderApp(app, close);
    toast(app, `已写进 ${seat.name} 的记忆`);
}

/** 「自动接话」开关：AI 之间能不能自己接下去。默认关，直接写在这局的存档上 */
async function toggleAutoReply(app, close) {
    if (!app.session) return;
    const next = !app.session.autoReply;
    app.session.autoReply = next;                 // 先动内存：开关要有即时反馈
    renderApp(app, close);
    await queueSessionWrite(app, s => { s.autoReply = next; });
}

/** 停 / 退出：把还在计的窗口全掐掉——「给停或者退出房间都不再触发新的调用」 */
function clearReviewTimers(app) {
    for (const t of app.review.timers.values()) clearTimeout(t);
    app.review.timers.clear();
    app.review.readyAt.clear();   // 离开过再回来算冷启动：别让他还记得上一轮的冷却
    app.review.thinking.clear();
    app.review.pending.clear();
    app.review.picker = null;
    app.review.draft = '';
}

/** @ 候选浮层：只在光标前一段刚好是「@ + 无空白」时弹，点谁插谁 */
function updateMentionList(app, root) {
    const box = root.querySelector('#wwMentionList');
    const ta = root.querySelector('#wwReviewDraft');
    if (!box || !ta) return;
    const session = app.session;
    const mine = mySeatOf(app, session);
    const before = String(ta.value || '').slice(0, ta.selectionStart);
    const m = before.match(/@([^\s@]{0,12})$/);
    if (!m || !session) { box.innerHTML = ''; box.classList.remove('open'); app.review.picker = null; return; }
    const q = m[1];
    const items = (session.seats || [])
        .filter(s => s.seat !== mine?.seat)
        .filter(s => !q || String(s.name || '').includes(q) || String(s.seat) === q);
    if (!items.length) { box.innerHTML = ''; box.classList.remove('open'); app.review.picker = null; return; }
    app.review.picker = { from: ta.selectionStart - m[0].length };
    box.innerHTML = items.map(s => `<button class="ww-at-item" data-at="${s.seat}">${s.seat} 号 ${esc(s.name)}</button>`).join('');
    box.classList.add('open');
}

/** 选中一个候选：把 @ 那一小段换成「@名字 」，光标落在后面（拿名字而不是号数，读着自然） */
function insertMention(app, root, seatNo) {
    const ta = root.querySelector('#wwReviewDraft');
    const picker = app.review.picker;
    const seat = engine.seatAt(app.session, seatNo);
    if (!ta || !picker || !seat) return;
    const value = String(ta.value || '');
    // 名字里带空白就退回座号：@ 后面一遇空白就断，插了名字等于白点
    const insert = /\s/.test(seat.name || '') ? `@${seat.seat}号 ` : `@${seat.name} `;
    const next = value.slice(0, picker.from) + insert + value.slice(ta.selectionStart);
    const pos = picker.from + insert.length;
    app.review.draft = next;
    ta.value = next;
    ta.setSelectionRange(pos, pos);
    ta.focus();
    app.review.picker = null;
    updateMentionList(app, root);
}

function renderTable(app) {
    const session = app.session;
    if (!session) return `<div class="ww-empty">这局不在了</div>`;
    const type = getRoomType(session.typeId);
    const board = getBoard(session.boardId || type?.boardId);
    const mine = mySeatOf(app, session);
    const over = isOver(session);
    const canMark = !over && !app.readonly && !!mine;
    // 打完的桌上座位又活了一次，只是换成另一路（让他自己复盘这一局）。这一行把新用法说出来，
    // 否则那些格子刚从「按不动」变成「按得动」，谁也不会去试
    const canReplay = (session.seats || []).some(s => canInsight(app, session, s));
    const how = canMark ? '点座位贴标记' : (canReplay ? '点座位让他复盘这一局' : '');
    // 「模板模式」照 modeOf 算，不照某个开关：没配 key / 超出预算**本来**就是每句话都在走模板，
    // 标出来才对得上。以前读的是 `session.ai.template`（那个开关 2026-09-21 去掉了，见 modeOf）。
    const note = [
        `存活 ${engine.aliveSeats(session).length} 人`,
        ai.modeOf(session) === 'template' ? '模板模式' : ''
    ].filter(Boolean).join(' · ');

    return `
        ${renderIdentityCard(app, session, mine)}
        <div class="ww-section-title">
            <strong>场上</strong>
            <span>${esc(how ? `${note} · ${how}` : note)}</span>
        </div>
        <div class="ww-seats compact${tableColumnsOf(board) === 4 ? ' c4' : ''}">
            ${(session.seats || []).map(s => renderTableSeat(app, session, s, mine, over)).join('')}
        </div>
        ${over ? renderEnding(app, session, mine) : `<div class="ww-section-title"><strong>发言</strong><span>${esc(engine.speakOrderShort(session))}</span></div>`}
        ${renderFeed(app, session, mine)}
    `;
}

/* ---------------- 对局页：底部动作条 ---------------- */

function renderTableBottom(app) {
    const session = app.session;
    if (!session) return '';
    const mine = mySeatOf(app, session);

    if (isOver(session)) return renderReviewComposer(app, session, mine);
    // 没等到 AI 回话的那一拍：底栏整个交给那两颗按钮（重试 / 用模板顶上，见 runTurn）。
    // 排在最前面——这一步还没落库，这会儿别的动作都不该点得动
    if (app.pendingStep && app.pendingStep.sid === session.id) return renderStalled(app);
    // 半自动跑着的时候不盖底栏：它替别人拿主意与我那一份无关，我那一份得照样点得动
    if (app.busy && !app.autoRun) {
        return `<footer class="ww-bottom"><button class="primary" disabled>⏳ 等 AI 回话…</button></footer>`;
    }

    // 夜里轮到我：我的身份我自己动手（不想动手就点「让 AI 决定」）
    const duty = myNightDuty(app, session);
    // 交警徽那一拍：**去向已经定好了就只是当众走一遍**（遗言那一次调用顺手定的，见 engine.badgeDraft）
    // ——这一条对玩家与 AI 是同一个规矩，所以排在 duty 之前，看草稿而不看是谁在点
    if (duty === 'badge') {
        const walked = badgeWalkThrough(session);
        if (walked) return walked;
    }
    if (duty) return renderNightAct(app, session, mine, duty);

    const speaker = (session.phase === 'day_speak' ? engine.currentSpeaker(session)
        : session.phase === 'day_pk' ? engine.currentPkSpeaker(session)
            : session.phase === 'day_sheriff_speak' ? engine.currentSheriffSpeaker(session)
                : session.phase === 'day_sheriff_pk' ? engine.currentSheriffPkSpeaker(session) : null);
    const voter = (session.phase === 'day_vote' ? engine.currentVoter(session)
        : session.phase === 'day_pk_vote' ? engine.currentPkVoter(session)
            : session.phase === 'day_sheriff' ? engine.currentSheriffVoter(session)
                : session.phase === 'day_sheriff_pk_vote' ? engine.currentSheriffPkVoter(session) : null);
    // 上警表态：两枚芯片（上警 / 不上警），**没有进度、也看不到别人**（举手是同时的）
    const declarer = session.phase === 'day_sheriff_signup' ? engine.currentSheriffSignup(session) : null;
    // 遗言那一拍：队列里当前那个人说最后一段话（用的是同一个发言框，只是提示与落点不同）
    const mourner = session.phase === 'last_words' ? engine.currentDeath(session) : null;
    // 轮到我：发言框 / 投票点选；否则给出「让某位 AI 行动」那一个按钮
    // （上警发言用的是第三个档的发言框：同一个 textarea，多一排「退水」开关）
    if (speaker && mine && speaker.seat === mine.seat) {
        return renderComposer(app, session, session.phase === 'day_sheriff_speak' ? 'candidate' : 'speak');
    }
    if (mourner && mine && mourner.seat === mine.seat) return renderComposer(app, session, 'lastwords');
    // 轮到我投票：**半自动跑着时也照画**（我这一票随时能点），所以照旧排在这里
    if (voter && mine && voter.seat === mine.seat) return renderVoteRow(app, session, mine, !!app.autoRun);
    // 半自动跑着时**不看轮没轮到我**：这一拍只要还有我的一票没投，格子就先给我（自己投 / 弃票 /
    // 让 AI 代投），投过了才落回下面那条进度行等别人。名单用的是引擎那一份——与循环读的是同一个
    // （`pendingVoters` 自带阶段闸：不是投票的那几拍它本来就是空表）
    if (app.autoRun && mine
        && engine.pendingVoters(session).some(x => x.seat === mine.seat)) {
        return renderVoteRow(app, session, mine, true);
    }
    if (declarer && mine && declarer.seat === mine.seat) return renderDeclareRow(app, session, !!app.autoRun);
    // 上警表态与投票同一条口径（见上面那一段）：这一拍只要我还没举手，芯片就先给我，
    // 举过了才落回进度行等别人。名单同样是引擎那一份（`pendingDeclarers`）
    if (app.autoRun && mine
        && engine.pendingDeclarers(session).some(x => x.seat === mine.seat)) {
        return renderDeclareRow(app, session, true);
    }
    // 定发言方向：轮到在任警长自己点（他只能定从警左还是警右开始）
    if (session.phase === 'day_order' && mine && engine.sheriffSeatOf(session) === mine.seat) {
        return renderOrderRow(session);
    }
    // 半自动正在替别人拿主意：底栏只报一句进度。**不给任何会再打一次 AI 的按钮**——
    // 那会和循环撞成两位同时在被问（一次一位是这一档的前提）
    if (app.autoRun) return `<footer class="ww-bottom">${renderAutoHint(app, session)}</footer>`;
    // 半自动开着、名单上还有别人没拿主意、可是循环没在跑（被打断了，或者刚回到这张桌）：
    // 给一个「继续…」把同一段再跑一遍。没等到 AI 回话的那几位也留在名单里，
    // 所以这一个按钮同时就是「重试」——不必再单独记「上一次谁失败了」。
    // 两个落点同一颗按钮（投票 / 上警表态），文案跟着这一拍走
    if ((engine.VOTE_PHASES.includes(session.phase) || session.phase === 'day_sheriff_signup')
        && autoMode() === 'half'
        && pendingActors(session).some(s => s.seat !== mine?.seat)) {
        const more = session.phase === 'day_sheriff_signup' ? '▶ 继续表态' : '▶ 继续投票';
        return `<footer class="ww-bottom"><button id="wwAutoMore" class="primary">${more}</button></footer>`;
    }

    const act = label => `<footer class="ww-bottom"><button id="wwAct" class="primary">${esc(label)}</button></footer>`;
    const advance = label => `<footer class="ww-bottom"><button id="wwAdvance" class="primary">${esc(label)}</button></footer>`;
    switch (session.phase) {
        // 文案不随存活状态变：守卫不在世时这一步点一下就过去，按钮换个说法等于公告「守卫死了」
        case 'night_guard': return act('让守卫守护');
        case 'night_wolf': return act('让狼队行动');
        case 'night_seer': return act('让预言家验人');
        case 'night_witch': return act('让女巫用药');
        case 'night_hunter': return act('让猎人行动');
        case 'night_resolve': return advance('公布今晚的结果');
        // 天亮了：昨夜有人出局的话，这一下先送他们挨个走完自己的流程（等待发动技能 → 遗言），
        // 走完才轮到活人发言；平安夜就直接开始这一天。谁出局是公开的，按钮随它换个说法不泄漏什么
        case 'dawn': return advance((session.deathQueue || []).length ? '继续' : `开始第 ${session.round || 1} 天`);
        // 竞选那条链的五拍：逐座表态 → 台上各说一轮 → 警下投票 → 开票（平票那两拍在下头）
        case 'day_sheriff_signup':
            return declarer ? act(`让 ${declarer.seat} 号 ${declarer.name} 上警表态`) : '';
        case 'day_sheriff_speak': return speaker ? act(`让 ${speaker.seat} 号 ${speaker.name} 发言`) : '';
        // 警下投票与白天投票一个手感：轮到他选警长 / 等开票
        case 'day_sheriff': return voter ? act(`让 ${voter.seat} 号 ${voter.name} 选警长`) : '';
        case 'day_sheriff_verdict': return advance('开票');
        // 竞选平票的两拍：台上加说一轮（文案与白天 PK 那两拍一致，不点破谁在台上）、台下补投
        case 'day_sheriff_pk': return speaker ? act(`让 ${speaker.seat} 号 ${speaker.name} 发言`) : '';
        case 'day_sheriff_pk_vote': return voter ? act(`让 ${voter.seat} 号 ${voter.name} 补投`) : '';
        // 公布死讯：算定了一整夜的几条，点这一下当众念出来（只有警长板的第一天有这一拍）
        case 'day_deaths': return advance('公布昨夜的死讯');
        // 定发言方向：轮到在任警长（他定完才轮到活人发言）
        case 'day_order': {
            const sh = engine.sheriffSeatOf(session);
            const who = engine.seatAt(session, sh);
            return who ? act(`让 ${who.seat} 号 ${who.name} 定发言方向`) : '';
        }
        case 'day_speak': return speaker ? act(`让 ${speaker.seat} 号 ${speaker.name} 发言`) : '';
        case 'day_vote': return voter ? act(`让 ${voter.seat} 号 ${voter.name} 投票`) : '';
        // PK 两拍与白天那两拍是同一个手感：台上说话、台下补投，按钮文案照旧不点破谁在台上
        case 'day_pk': return speaker ? act(`让 ${speaker.seat} 号 ${speaker.name} 发言`) : '';
        case 'day_pk_vote': return voter ? act(`让 ${voter.seat} 号 ${voter.name} 投票`) : '';
        case 'day_verdict': return advance('开票');
        // 出局的人挨个走流程：走完一个换下一个。**按钮文案对每个人都一样**——
        // 被票出局的猎人要在这里补一枪，但写成「让 X 号 开枪」就等于当众点破他是猎人。
        case 'skill_wait': {
            const cur = engine.currentDeath(session);
            return cur?.act === 'shot' ? act('继续') : advance('继续');
        }
        // 交警徽：有定好的去向就点一下走完（与轮到我自己的时候同一条路）；没有才交给 AI 定
        // ——他是在任警长这件事公开，所以那个按钮可以点着名说
        case 'badge_wait': {
            const walked = badgeWalkThrough(session);
            if (walked) return walked;
            const who = engine.seatAt(session, engine.currentDeath(session)?.seat);
            return who ? act(`让 ${who.seat} 号 ${who.name} 移交警徽`) : '';
        }
        // 遗言：轮到他就是他的最后一段话。谁出局是公开的，所以这儿点着名让他说没问题
        case 'last_words': {
            const cur = engine.currentDeath(session);
            return cur ? act(`听 ${cur.seat} 号 ${engine.seatAt(session, cur.seat)?.name || ''} 的遗言`) : '';
        }
        default: return '';
    }
}

/**
 * 轮到我说话的那一个框：白天发言与遗言共用（`mode` 只换提示与文案）。
 * 遗言那一版把「代笔」说成「让 AI 替你写」——他已经出局了，没什么身份要藏。
 */
function renderComposer(app, session, mode = 'speak') {
    const limit = getRoomType(session.typeId)?.speechLimit || 120;
    const hasMarks = Object.keys(marksForPrompt(session.marks)).length > 0;
    const mine = mySeatOf(app, session);
    if (mode === 'lastwords') {
        // 在任警长留遗言：警徽的去向**在同一次里定下来**（与 AI 那一侧同一条路——遗言那一次调用
        // 顺手把去向一起答了，badge_wait 那一拍只是当众走一遍）。不选也行，到那一拍再定。
        const badge = engine.isSheriff(session, mine?.seat) ? engine.badgeTargets(session, mine?.seat) : [];
        // 选过的芯处要亮着——代笔那一次调用可能已经把去向答出来了（见 ghostSpeak）
        const pick = app.badgePick == null ? null : Number(app.badgePick);
        return `
        <footer class="ww-bottom column">
            <div class="ww-hint">这是你的遗言（${mine?.seat || ''} 号）：最后一段公开的话，说给活着的人听。</div>
            ${badge.length ? `
            <div class="ww-hint">你还是警长：顺手定下警徽交给谁（也可以当场撕掉）。</div>
            <div class="ww-vote-row">
                ${badge.map(t => `<button class="ww-mark-chip${pick === t.seat ? ' active' : ''}" data-badge="${t.seat}">${t.seat} 号 ${esc(t.name)}</button>`).join('')}
                <button class="ww-mark-chip${pick === 0 ? ' active' : ''}" data-badge="0">撕掉警徽</button>
            </div>` : ''}
            <textarea id="wwDraft" class="ww-input" placeholder="你的遗言（不超过 ${limit} 字）">${esc(app.draft || '')}</textarea>
            <div class="ww-composer-row">
                <button id="wwGhost" class="ghost">代笔</button>
                <button id="wwSend" class="primary">说完</button>
            </div>
        </footer>
    `;
    }
    // 上警发言：同一个框，多一排「退水」开关。**退了水也能不说一句话**（引擎允许空正文），
    // 所以这一档的「发送」在没有正文、也没退水时才拦（见 sendMySpeech）
    if (mode === 'candidate') {
        const out = !!app.withdraw;
        return `
        <footer class="ww-bottom column">
            <div class="ww-hint">轮到你上警发言：台下没上警的人马上要在你们当中投票选警长，这一段是说给他们听的。</div>
            <textarea id="wwDraft" class="ww-input" placeholder="你要说的话（不超过 ${limit} 字）">${esc(app.draft || '')}</textarea>
            <div class="ww-vote-row">
                <button class="ww-mark-chip${out ? ' active' : ''}" data-withdraw="1">${out ? '✓ 退水（不争这个警徽）' : '退水（不争这个警徽）'}</button>
            </div>
            <div class="ww-composer-row">
                <button id="wwGhost" class="ghost">代笔</button>
                <button id="wwSend" class="primary">${out ? '退水' : '发送'}</button>
            </div>
            <div class="ww-hint">退了水这一轮没有票，平票之后的补投还能投。</div>
        </footer>
    `;
    }
    return `
        <footer class="ww-bottom column">
            <div class="ww-hint">轮到你了：自己打，或者让 AI 顺着你的草稿${hasMarks ? '与标记' : ''}代笔。</div>
            <textarea id="wwDraft" class="ww-input" placeholder="你要说的话（不超过 ${limit} 字）">${esc(app.draft || '')}</textarea>
            <div class="ww-composer-row">
                <button id="wwGhost" class="ghost">代笔</button>
                <button id="wwSend" class="primary">发送</button>
            </div>
        </footer>
    `;
}

/** 交给 AI 的那个按钮：白天投票、上警表态、夜里三步，出处都在这儿（data-delegate 分派） */
function renderDelegate(kind, label = '让 AI 决定') {
    return `<div class="ww-composer-row"><button id="wwDelegate" class="ghost" data-delegate="${kind}">${esc(label)}</button></div>`;
}

/**
 * 半自动那一行进度（正在挨个问的时候挂在底栏）。数的是**还没落地的那几份**（含正在飞的那一位）——
 * 「还差 3 票」比「正在问第 7 位」诚实：在飞的那一位也可能没等到回话、留在名单里等重试。
 * 两个落点各说各的：投票那一拍数票，上警表态那一拍数人（举手不进流水，进度就是这一行）。
 */
function renderAutoHint(app, session) {
    const signup = session?.phase === 'day_sheriff_signup';
    const left = pendingActors(session);
    const mineLeft = left.some(s => s.seat === mySeatOf(app, session)?.seat);
    const what = signup ? '上警表态' : '问票';
    const unit = signup ? '位' : '票';
    const mine = mineLeft ? (signup ? '（其中一位是你）' : '（其中一票是你的）') : '';
    return `<div class="ww-auto-hint">🤖 半自动正在挨个${what} · 还差 ${left.length} ${unit}${mine}</div>`;
}

function renderVoteRow(app, session, mine, auto = false) {
    // 四个落点，四个合法集（都是引擎给的那一份）：白天放逐 / 白天 PK 补投（只能投台上的人）
    // / 警下投票（只有上警且没退水的那几位）/ 竞选平票的补投（台上那几位）
    const pk = session.phase === 'day_pk_vote';
    const election = session.phase === 'day_sheriff';
    const pkSheriff = session.phase === 'day_sheriff_pk_vote';
    const targets = election ? engine.sheriffCandidates(session, mine.seat)
        : pkSheriff ? engine.sheriffPkVoteTargets(session)
            : (pk ? engine.pkVoteTargets(session) : engine.voteTargets(session, mine.seat));
    const hint = election
        ? '轮到你选警长了：上警的人各说完一轮了，点一个人投给他，或者弃票。票数最高的当选，平票再走一轮。'
        : pkSheriff ? '轮到你补投了：在他们几位中间点一个（也可以弃票）。再平票这一局就没有警徽了。'
            : (pk ? '轮到你补投了：在他们几位中间点一个（也可以弃票）。'
                : '轮到你投票了：点一个人投他出局，或者弃票。');
    return `
        <footer class="ww-bottom column">
            <div class="ww-hint">${hint}</div>
            <div class="ww-vote-row">
                ${targets.map(t => `<button class="ww-mark-chip" data-vote="${t.seat}">${t.seat} 号 ${esc(t.name)}</button>`).join('')}
                <button class="ww-mark-chip" data-vote="0">弃票</button>
            </div>
            ${renderDelegate('vote', auto ? '让 AI 代投' : '让 AI 决定')}
            ${auto ? renderAutoHint(app, session) : ''}
        </footer>
    `;
}

/**
 * 轮到我上警表态：两枚芯片（上警 / 不上警）。
 * **刻意不报别人的进度、也不列别人举没举**：全桌一个一个表态、收齐了才公布名单，
 * 界面先说出去就等于把「后决定的人可以照着改主意」这扇门打开了（引擎那边同理，见 applySheriffSignup）。
 * 半自动跑着时（`auto`）底下多挂一行它自己的进度——那一行只说**还差几个人**（含我自己），
 * 不含任何「谁举了没举」的信息，与上面这条纪律不冲突。
 */
function renderDeclareRow(app, session, auto = false) {
    return `
        <footer class="ww-bottom column">
            <div class="ww-hint">轮到你上警表态了：只有一次机会，说了不能改。上警的人这一轮没有投票权，但只有台上的人能当选；不上警就安稳拿一票。</div>
            <div class="ww-vote-row">
                <button class="ww-mark-chip" data-declare="1">上警</button>
                <button class="ww-mark-chip" data-declare="0">不上警</button>
            </div>
            ${renderDelegate('declare')}
            ${auto ? renderAutoHint(app, session) : ''}
        </footer>
    `;
}

/**
 * 定发言方向那一拍：警长自己点的两枚芯片（警左 / 警右）。
 * 选项表由引擎给（`speakOrderOptions`）——界面、AI 提示词、引擎校验共用同一份，三处不会走岔。
 */
function renderOrderRow(session) {
    const opts = engine.speakOrderOptions(session);
    return `
        <footer class="ww-bottom column">
            <div class="ww-hint">轮到你了：今天从谁开口由你定。你只能定从警左还是警右开始，不点名。</div>
            <div class="ww-vote-row">
                ${opts.map(o => `<button class="ww-mark-chip" data-order="${o.side}:${o.dir}">${esc(o.label)}</button>`).join('')}
            </div>
            ${renderDelegate('order')}
        </footer>
    `;
}

/**
 * 交警徽那一拍的去向**已经定好了**（遗言那一次调用顺手定的，见 engine.badgeDraft）：
 * 那就当众走一遍——不再打一次 AI、也不再问玩家一遍。返回那一行按钮，没定好时返回 null。
 * 两边共用同一条判定（轮到我自己的时候见 renderTableBottom 顶部，轮到 AI 时见 badge_wait 那个 case）。
 */
function badgeWalkThrough(session) {
    const head = engine.currentDeath(session);
    if (!head || !session.badgeDraft) return null;
    if (Number(session.badgeDraft.from) !== Number(head.seat)) return null;
    return `<footer class="ww-bottom"><button id="wwAdvance" class="primary">继续</button></footer>`;
}

/**
 * 轮到我动手的夜间行动条，跟投票行同一套手感：点一下就是决定。
 * 只有狼多一步（先挑目标、给队友留一句话，提交之后 AI 队友各自复议）。
 * 目标一律取自 ai.nightTargets——跟 AI 与模板用的是同一个合法集，不会出现点得动却落不下的座号。
 */
function renderNightAct(app, session, mine, kind) {
    const nameOf = seatNo => `${seatNo} 号 ${engine.seatAt(session, seatNo)?.name || ''}`;
    const chip = (target, label, active) =>
        `<button class="ww-mark-chip ${active ? 'active' : ''}" data-night="${kind}" data-target="${target}">${esc(label)}</button>`;

    // 交警徽：这不是夜间行动，没有「夜间合法集」可问，所以排在 ai.nightTargets 之前。
    // 交出去就收不回（撕掉更是不可逆），所以提示里把这一条写明白
    if (kind === 'badge') {
        const targets = engine.badgeTargets(session, mine.seat);
        return `
            <footer class="ww-bottom column">
                <div class="ww-hint">${mine.flipped === true
        ? '你翻牌了，警徽不能留在没有票的人手里：点一个人当众交给他，或者当场撕掉。'
        : '你出局了，警徽得有个去处：点一个人当众交给他，或者当场撕掉。'}定了就收不回。</div>
                <div class="ww-vote-row">
                    ${targets.map(t => chip(t, nameOf(t), false)).join('')}
                    ${chip(0, '撕掉警徽', false)}
                </div>
                ${renderDelegate('badge')}
            </footer>
        `;
    }

    const targets = ai.nightTargets(session, kind, mine.seat);

    // 守卫：上一夜守过的那位**连渲染都不渲染**（引擎必拒，点了也落不下），
    // 剩下的就是 ai.nightTargets 给的合法集。提示里可以点名「昨晚守过 N 号」——那是他自己干的事。
    if (kind === 'guard') {
        const warned = engine.lastGuardTarget(session, mine.seat);
        return `
            <footer class="ww-bottom column">
                <div class="ww-hint">今晚守谁：点一个人，他当夜不会被刀。${warned ? `昨晚守过 ${nameOf(warned)}，今晚不能接着守。` : ''}</div>
                <div class="ww-vote-row">${targets.map(t => chip(t, nameOf(t), false)).join('')}</div>
                ${renderDelegate('guard')}
            </footer>
        `;
    }

    if (kind === 'wolf') {
        const mate = wolfMateOf(app, session, mine);
        if (!mate) {
            return `
                <footer class="ww-bottom column">
                    <div class="ww-hint">没有同伴了，这一刀你自己定。</div>
                    <div class="ww-vote-row">${targets.map(t => chip(t, nameOf(t), false)).join('')}</div>
                    ${renderDelegate('wolf')}
                </footer>
            `;
        }
        return `
            <footer class="ww-bottom column">
                <div class="ww-hint">今晚刀谁：先点一个，再给队友留一句话。他看过会自己再提一个，你俩说的不一样就随机取一个。</div>
                <div class="ww-vote-row">${targets.map(t => chip(t, nameOf(t), app.wolfPick === t)).join('')}</div>
                <textarea id="wwNote" class="ww-input ww-note" maxlength="60" placeholder="留给队友的话（可留空）">${esc(app.wolfNote || '')}</textarea>
                <div class="ww-composer-row">
                    <button id="wwDelegate" class="ghost" data-delegate="wolf">让 AI 决定</button>
                    <button id="wwSubmit" class="primary" ${app.wolfPick ? '' : 'disabled'}>提交给队友</button>
                </div>
            </footer>
        `;
    }

    if (kind === 'seer') {
        const seen = new Map((engine.viewOf(session, mine.seat)?.checks || []).map(c => [c.seat, c]));
        return `
            <footer class="ww-bottom column">
                <div class="ww-hint">今晚验谁：点一下就能看到结果，只有你自己知道。</div>
                <div class="ww-vote-row">
                    ${targets.map(t => {
                        const c = seen.get(t);
                        return chip(t, c ? `${nameOf(t)}（验过：${c.isWolf ? '狼人' : '好人'}）` : nameOf(t), false);
                    }).join('')}
                </div>
                ${renderDelegate('seer')}
            </footer>
        `;
    }

    // 女巫：两瓶药是两回事，分两排点；「不用药」也得点一下——不点这一步就推不走，全场都在等她
    if (kind === 'witch') {
        const view = engine.viewOf(session, mine.seat) || {};
        const heal = engine.witchTargets(session, mine.seat, 'heal');
        const poison = engine.witchTargets(session, mine.seat, 'poison');
        const pick = (target, label, act) =>
            `<button class="ww-mark-chip" data-night="witch" data-act="${act}" data-target="${target}">${esc(label)}</button>`;
        const stock = `解药${view.potions?.heal ? '还在' : '已用'}、毒药${view.potions?.poison ? '还在' : '已用'}；同一夜只能用一瓶，选了就收不回。`;
        // 解药那一路点不动时写明是哪种「没有」：药已经用掉了、今晚压根没人被刀、还是刀在她自己身上
        const healNote = !view.potions?.heal ? '解药：已经用掉了'
            : (view.tonight?.seat === mine.seat ? '解药：救不了自己，过了首夜就不能自救' : '解药：今晚没有人被刀');
        return `
            <footer class="ww-bottom column">
                <div class="ww-hint">今晚用药：解药只能救今晚被刀的人，毒药能毒场上任意一人（不能毒自己）。${stock}</div>
                <div class="ww-vote-row">
                    ${heal.length
                        ? heal.map(t => pick(t, `救 ${nameOf(t)}`, 'heal')).join('')
                        : `<span class="ww-hint">${healNote}</span>`}
                    ${pick('', '不用药', 'none')}
                </div>
                ${poison.length ? `<div class="ww-vote-row">${poison.map(t => pick(t, `毒 ${nameOf(t)}`, 'poison')).join('')}</div>` : ''}
                ${renderDelegate('witch')}
            </footer>
        `;
    }

    // 猎人：开枪的决策只有一次，但**说法的来路不同**——夜里被刀（法官叫醒他）与白天被票出局（他刚知道自己出局）
    const knifed = session.phase === 'night_hunter';
    return `
        <footer class="ww-bottom column">
            <div class="ww-hint">${knifed
                ? '你今晚被狼刀了：可以带走场上一个人，也可以弃枪。你的死讯天亮公布，那时才轮到你说遗言。'
                : '你被投票出局了：可以带走场上一个人，也可以弃枪。'}</div>
            <div class="ww-vote-row">
                ${targets.map(t => chip(t, nameOf(t), false)).join('')}
                ${chip(0, '弃枪', false)}
            </div>
            ${renderDelegate('hunter')}
        </footer>
    `;
}

/* ---------------- 对局页：动作 ---------------- */

/**
 * 对局内一次 AI 调用 + 落库的统一收口。
 * ① 记下 roundId，回来时局面已经往前走过就把这次结果丢掉（照 textAdventure 的比对思路）
 * ② 真的打出去了才计调用数、记成败；模板模式下这些函数根本不会发请求
 * ③ 调用点自己决定怎么把结果落到状态上（apply）
 * ④ **没等到回话就不落模板**：这一步原样挂在 `app.pendingStep` 上，底栏摆两颗按钮让玩家选
 *    「重新问一次」还是「用模板顶上」（2026-09-21 用户口径：「在失败默认返回模板台词之前，
 *    加一个手动选择是否重试的选项」）。见 renderStalled。
 *
 * 半自动那一档（`strict`）照旧：它本来就不落库，失败的那位留在名单里、底栏那颗
 * 「继续投票 / 继续表态」就是重试——两条路是同一个路子，不必再摆一次选择。
 *
 * `pendingStep` 只在内存里（跟 app.draft 一个性质），**离开这个模块就没了**——不需要清理，
 * 也不需要守卫：失败那一次什么都没落库，局面本来就没往前动，回来还是那一拍。
 */
async function runTurn(app, close, { call, apply, strict = false }) {
    const session = app.session;
    if (!session || app.busy) return null;
    const sid = session.id;
    const roundId = session.roundId || 0;
    const willCall = ai.modeOf(session) === 'ai';

    app.busy = true;
    renderApp(app, close);
    let res = null;
    try { res = await call(session); } catch { res = null; }
    app.busy = false;

    // `!res` 也要算「没等到回话」：`call` 抛出来时上面那个 catch 把 res 收成了 null，
    // 只查 `degraded` 的话它会漏到下一行、被 apply 记成一票弃票——正是这一档要防的那件事
    const failed = willCall && !strict && (!res || res.degraded);

    const out = await mutateSession(app, sid, s => {
        if ((s.roundId || 0) !== roundId) return { dropped: true };
        // 调用照样计数（它真打出去了，成败都算一次），只是失败那一下**不落地**
        if (willCall) s.callCount = (s.callCount || 0) + 1;
        if (failed) return { dropped: false, stalled: true };
        if (strict && (!res || res.degraded)) return { dropped: false, skipped: true };
        return { dropped: false, done: !!apply(s, res) };
    });

    // 停住这一拍：这一步原样留着，等玩家在底栏选（`res` 也留着——选「用模板顶上」要用它）
    if (out?.stalled) app.pendingStep = { sid, roundId, call, apply, res };

    renderApp(app, close);
    if (out?.dropped) toast(app, '局面已经往前走了，这次结果作废');
    // 下面这两路都不在这儿报：停住那一路由底栏两颗按钮自己说（见 renderStalled），
    // 半自动那一路留给循环收尾时统一报——一句顶一句地弹两个 toast 只会互相盖掉
    else if (out?.stalled || out?.skipped) { /* 见上 */ }
    else if (out && out.done === false) toast(app, '这一步没生效，再点一次试试');
    // 停住 / 跳过的那两拍**不能**再往下推：局面没往前动，尾巴上这个自动推进会踩着它往下跑一整轮
    if (!out?.stalled && !out?.skipped) maybeAutoRun(app, close);
    return { res, ...out };
}

/**
 * 停住的那一拍：局面一步没动，这一步原样留在 `app.pendingStep` 里。
 * 两颗按钮——**重试**（把同一次调用再打一遍）/ **用模板顶上**（走原来那条降级路）。
 *
 * 不用弹窗：弹窗关掉就找不回来了，而这一档的全部意义就是「找得回来」。
 * `res` 为 null 时（`call` 整个抛出来）没有模板可落，那只给重试。
 */
function renderStalled(app) {
    return `
        <footer class="ww-bottom column ww-stalled">
            <div class="ww-stalled-tip">这一步没等到 AI 回话，局面没有动。</div>
            <div class="ww-stalled-row">
                <button id="wwRetryBtn" class="primary">🔄 重新问一次</button>
                ${app.pendingStep?.res ? '<button id="wwFallbackBtn">用模板顶上</button>' : ''}
            </div>
        </footer>
    `;
}

/** 重试：把同一次调用原样再打一遍。再失败就再停一次（runTurn 会把 pendingStep 重新挂上） */
function retryStalled(app, close) {
    const step = app.pendingStep;
    if (!step || app.busy) return;
    app.pendingStep = null;
    return runTurn(app, close, { call: step.call, apply: step.apply });
}

/** 用模板顶上：把那次没等到的结果当成结果落下去——就是这次改动之前的老行为 */
async function fallbackStalled(app, close) {
    const step = app.pendingStep;
    if (!step || app.busy) return;
    app.pendingStep = null;
    const out = await mutateSession(app, step.sid, s =>
        ((s.roundId || 0) !== step.roundId ? { dropped: true } : { dropped: false, done: !!step.apply(s, step.res) }));
    renderApp(app, close);
    if (out?.dropped) toast(app, '局面已经往前走了，这次结果作废');
    else if (out && out.done === false) toast(app, '这一步没生效，再点一次试试');
    else toast(app, '先用模板顶上了');
    maybeAutoRun(app, close);
}

/**
 * 发言：一次调用换一段话。四个落点走同一个入口，只在 apply 里按阶段分流：
 * 白天发言 / 白天 PK 台上那一轮 / **上警发言**（多带一个「退不退水」）/ **竞选平票后的加说一轮**。
 * 退水那一下允许空正文（主视角可以只点退水不说话，引擎那边同样允许）。
 */
function speakTurn(app, close, seatNo, type) {
    // 高亮跟着**这一下点击**走（见 calledSeatOf）：点下去就亮他，回话落进流水之后你读到的那段
    // 话就是他的。**写在 runTurn 之前**——点下去要先重绘一次「等待中」那一态，那一刻高亮就得在
    const s0 = app.session;
    if (s0) app.calledSeat = { phase: s0.phase, round: s0.round, seat: seatNo };
    return runTurn(app, close, {
        call: s => ai.speakCharacter({ session: s, seatNo, type }),
        apply: (s, res) => {
            engine.mergeLabels(s, seatNo, res?.marks || {});
            engine.addNote(s,seatNo, { kind: 'speak', text: res?.note });
            // 关注表：这次改了就换，没写就维持（res.watch 是 undefined，不是空数组）
            if (res?.watch) engine.setWatch(s, seatNo, res.watch);
            const text = res?.text || ai.fallbackSpeech(seatNo, s.phase);
            if (s.phase === 'day_sheriff_speak') {
                return engine.applySheriffSpeech(s, seatNo, text, !!res?.withdraw);
            }
            if (s.phase === 'day_sheriff_pk') return engine.applySheriffPkSpeech(s, seatNo, text);
            return s.phase === 'day_pk' ? engine.applyPkSpeech(s, seatNo, text) : engine.applySpeech(s, seatNo, text);
        }
    });
}

/**
 * 上警表态：一次调用换一个「上不上警」，落点是 `applySheriffSignup`。
 * **静默收齐**（与投票同一手感）：表态本身不进流水，收满那一刻引擎自己公布名单。
 * 认不出（run 为 null）时引擎收 `false`＝不上警——AI 层那边已经保证「认不出退到模板」，
 * 走到这里还是 null 的只有模板兜底也判不出来的脏值，收成不上警不会把局面卡住。
 *
 * `strict` 只有半自动那一段传（没等到回话就整笔不落，见 runTurn）：AI 层那一档的兜底是
 * `templateSignup`（每三个座位里最低的那个举手），静默换成一个模板答的「上不上」同样是事后
 * 谁也认不出来的东西——没问到就留在名单里等重试，与投票同一条口径。
 */
function declareTurn(app, close, seatNo, type, strict = false) {
    return runTurn(app, close, {
        strict,
        call: s => ai.declareCandidacy({ session: s, seatNo, type }),
        apply: (s, res) => {
            engine.mergeLabels(s, seatNo, res?.marks || {});
            engine.addNote(s, seatNo, { kind: 'declare', text: res?.note });
            engine.addHeart(s, seatNo, {
                kind: seatNo === mySeatOf(app, s)?.seat ? 'ghost' : 'declare',
                text: res?.heart
            });
            if (res?.watch) engine.setWatch(s, seatNo, res.watch);
            return engine.applySheriffSignup(s, seatNo, res?.run === true);
        }
    });
}

/**
 * 遗言：一次调用换最后一段话，落点是 `applyLastWords`（不是普通发言）。
 *
 * **先看有没有现成的**，草稿有两个来源，都发生在「他自己那一拍」上（见 applyNightDecision）：
 *   - 夜里被刀的猎人，在夜里的「猎人」那一拍顺手写好了白天要说的那段；
 *   - 白天补枪的猎人，在技能那一拍**连遗言带警徽一起**答了（技能→遗言→警徽是他的连续动作，
 *     用户 2026-09-15 定：一次调用问完）。
 * 轮到他时直接取用，不再打一次调用——按次数计费，能省一次是一次。取用发生在写库那一趟里
 * （`takeWordsDraft` 顺手清掉，免得他下辈子还用这段）。
 *
 * **夜里那条路在有上警阶段的板子上不会有草稿**（见 engine.draftsWordsAtNight）：那一段死在夜里的人
 * 天亮还要参加竞选，遗言得等到公布死讯、拿着竞选之后的局面自己说。所以那条捷径在那张板子上
 * 自然失效——`ready` 是空串，照走下面那次调用（白天补枪那条路不受这道闸管，照常有草稿）。
 *
 * 没等到 AI 回话时这一拍会停住（见 renderStalled）：选「用模板顶上」才落到 `ai.fallbackSpeech`。
 * 以前是不问就落模板，2026-09-21 改成先问一声。
 *
 * **待查**：这里原来写的是「遗言这一拍不能卡住，卡住的不是一个人，是整局」。那是写这段代码
 * 的人留的判断，不是定论——正常拿到回复时流程不卡，那么失败之后重试成功也不该卡（只多一条
 * 失败记录）。**要是哪儿非用模板顶上不可、不然就推不动，那大概是那个地方出了问题。**
 * 死人不再改表：这一段只写正文，不合并判断、不记笔记、不动关注表。
 */
function lastWordsTurn(app, close, seatNo, type) {
    const ready = (app.session?.wordsDraft || {})[seatNo] || '';
    if (ready) {
        return mutateSession(app, app.session.id, s =>
            engine.applyLastWords(s, seatNo, engine.takeWordsDraft(s, seatNo) || ready))
            .then(() => renderApp(app, close));
    }
    return runTurn(app, close, {
        call: s => ai.lastWords({ session: s, seatNo, type }),
        apply: (s, res) => {
            const done = engine.applyLastWords(s, seatNo, res?.text || ai.fallbackSpeech(seatNo));
            // 他是在任警长时，遗言这一次调用顺手把警徽的去向也定了（见 ai.lastWords）——
            // 存成草稿，badge_wait 那一拍只是当众走一遍，不再打一次 AI
            if (done && res && 'badgeTarget' in res) engine.setBadgeDraft(s, seatNo, res.badgeTarget ?? null);
            return done;
        }
    });
}

/** `strict` 只有半自动那一段传（没等到回话就整笔不落，见 runTurn）——手动点「让 X 号 投票」照旧走模板兜底 */
function voteTurn(app, close, seatNo, type, strict = false) {
    return runTurn(app, close, {
        strict,
        call: s => ai.voteCharacter({ session: s, seatNo, type }),
        apply: (s, res) => {
            engine.mergeLabels(s, seatNo, res?.marks || {});
            engine.addNote(s,seatNo, { kind: 'vote', text: res?.note });
            // 心声：这一票的副产物，只写不读（留给以后的道具，用户 2026-09-13 定）。
            // 主视角把这一票交给 AI 时走的是同一个入口，同样记上；kind 跟「代笔」那一路一致
            engine.addHeart(s, seatNo, {
                kind: seatNo === mySeatOf(app, s)?.seat ? 'ghost' : 'vote',
                text: res?.heart
            });
            if (res?.watch) engine.setWatch(s, seatNo, res.watch);   // 投票时再决定一次关注
            // 四个落点走同一个入口：竞选警下投票（只有没上警的人）/ 竞选平票后的补投（台上那几位）/
            // 白天 PK 台下补投 / 白天放逐。合法集都在 ai 那一侧拦过一遍，这里只按阶段分派
            const target = res?.vote ?? null;
            if (s.phase === 'day_sheriff') return engine.applySheriffVote(s, seatNo, target);
            if (s.phase === 'day_sheriff_pk_vote') return engine.applySheriffPkVote(s, seatNo, target);
            return s.phase === 'day_pk_vote' ? engine.applyPkVote(s, seatNo, target) : engine.applyVote(s, seatNo, target);
        }
    });
}

/** 狼队夜里走 wolfPackTurn（一次调用扮演全队）；这里只管 seer / guard / witch / hunter 这几个单座位决策 */
function nightTurn(app, close, kind) {
    if (kind === 'wolf') return packTurn(app, close, { player: null });
    return runTurn(app, close, {
        // playerSeat 只影响猎人补枪那一拍要不要顺手打包遗言与警徽（见 ai.nightAction）：
        // 主视角自己那一座点「让 AI 决定」时只问技能——后面的遗言与警徽他自己动手，那边一次调用都省不下来
        call: s => ai.nightAction({ session: s, kind, playerSeat: mySeatOf(app, s)?.seat ?? null }),
        apply: (s, res) => {
            // 笔记先记（此时阶段还没推走，defaultActor 拿到的就是刚刚行动的那个人）
            engine.addNote(s, ai.defaultActor(s, kind), { kind, text: res?.note });
            return applyNightDecision(s, kind, res || {});
        }
    });
}

/**
 * 狼队：一次调用扮演**要交给 AI 的那几只狼**（每只狼各自的视角入场、各自的行为出场）。
 * player 是主视角的提案（他亲手提刀时才有）；他是狼点「让 AI 决定」、或者他根本不是狼（旁观/好人看 AI 打）时都给 null。
 *
 * 主视角那一座只有在他已经亲手提过刀时才排除（他那一票不该由 AI 代打）；
 * 托管时连他自己那一座一起交给 AI 扮演——不然独狼托管会因为「一只可扮演的狼都没有」卡死在夜里。
 */
function packTurn(app, close, { player = null } = {}) {
    const mine = mySeatOf(app, app.session);
    const skip = player ? mine?.seat : null;
    return runTurn(app, close, {
        call: s => ai.wolfPackAction({
            session: s,
            actorSeats: engine.aliveSeats(s)
                .filter(x => x.role === 'werewolf' && x.seat !== skip)
                .map(x => x.seat),
            player
        }),
        apply: (s, res) => applyWolfPack(s, res, player)
    });
}

/**
 * 狼队结果落库：每只狼各记一条自己的笔记，再交给引擎写频道 + 定刀口。
 * 降级（超时/没等到回话）时 AI 狼等于没表态——既不顶掉主视角的选择，也不参与合并；
 * 但没有主视角提案的那条路（整队交给 AI）不能跟着弃权，那会把这一夜空成死局。
 */
function applyWolfPack(s, res, player) {
    const usable = (player && res?.degraded) ? [] : (res?.wolves || []);
    const plans = usable.map(w => {
        engine.addNote(s, w.seat, { kind: 'wolf', text: w.note });
        return { seat: w.seat, target: w.target, reason: w.reason || '' };
    });
    if (player && player.target != null) plans.push({ seat: player.seat, target: player.target, reason: '' });
    return engine.applyWolfPlan(s, {
        plans,
        chat: res?.chat || [],
        playerSeat: player?.seat ?? null,
        note: player?.note || ''
    });
}

/**
 * 夜晚决策落库：模型给的目标不合法就退到模板目标；一个合法目标都没有（规则上不该出现）
 * 也把阶段推过去——玩家不该卡在一个点不动的夜里。
 */
function applyNightDecision(s, kind, res) {
    const who = ai.defaultActor(s, kind);
    const legal = ai.nightTargets(s, kind, who);
    const target = res?.target ?? null;
    const pick = legal.includes(target) ? target : (ai.templateNightTarget(s, kind, who) ?? null);
    // 落空时推到**夜里的下一步**（顺序问引擎要，别在这里另抄一份）
    if (kind === 'wolf') return engine.applyWolfKill(s, pick) || skipNight(s, engine.nextNightPhase(s, 'night_wolf'));
    if (kind === 'seer') return engine.applySeerCheck(s, who, pick) || skipNight(s, engine.nextNightPhase(s, 'night_seer'));
    // 守卫推的是他后面那一步（默认序里是狼），别推成结算——那会把后面的一夜整段跳过去
    if (kind === 'guard') return engine.applyGuard(s, who, pick) || skipNight(s, engine.nextNightPhase(s, 'night_guard'));
    if (kind === 'witch') return engine.applyWitch(s, who, witchPlanOf(s, who, res))
        || skipNight(s, engine.nextNightPhase(s, 'night_witch'));
    if (s.phase === 'night_hunter') {
        // 被刀的那一夜：AI 顺手写好的遗言先收着（公布死讯、轮到他说话时直接取用，省一次调用）。
        // 提示词那一侧本来就不会再要（见 ai 的 asksWords），这里再挡一道：模型自己多写了一个
        // words 也当没看见——有上警阶段的板子上他要等竞选之后再自己说，别把旧局面那段存下来
        const woken = engine.hunterWakesTonight(s) === who;
        if (woken && res?.words && engine.draftsWordsAtNight(s)) engine.setWordsDraft(s, who, res.words);
        return engine.applyHunterNight(s, who, woken ? pick : null)
            || skipNight(s, engine.nextNightPhase(s, 'night_hunter'));
    }
    // 白天补枪那一拍：他刚走完出局流程技能那一步，这一枪只能在队列里开。
    // 这一次调用**把后面紧接着两拍要用的东西一起带回来了**（技能→遗言→警徽是他一个人的连续动作，
    // 用户 2026-09-15 定：一次调用问完，按次数计费）——遗言与警徽先落草稿，轮到那两拍时直接取用
    // （见 lastWordsTurn 的 ready 捷径与 badgeWalkThrough），那两拍因此一次 AI 都不打。
    // ⚠️ 只有 AI 扮演的座位会带回来（主视角自己那一座走的是「只问技能」，见 nightTurn 的 playerSeat）：
    // 那两种情况下 res 里没有这两栏，下面的两个 if 自然都不进。
    // ⚠️ 这里存遗言**不受 draftsWordsAtNight 那道闸管**：那道闸的理由是「天亮了还要参加竞选」，
    // 而他这里紧接着就是遗言，中间没有竞选（见 engine.draftsWordsAtNight 的说明）。
    if (!engine.applyHunterShot(s, pick)) return false;
    if (res?.words) engine.setWordsDraft(s, who, res.words);
    // 警徽：**枪先响，再看他挑的那位还在不在**——这一枪完全可能正好把接徽人带走。
    // 那就整份作废（不落草稿），交徽那一拍自己再问一次；认不出那一栏（根本没写／没按 JSON 来）
    // 同样不落。绝不拿模板去替他挑一个——那是不可逆的一步，只有他自己说了才算。
    if (res && 'badge' in res) {
        const legal = engine.badgeTargets(s, who).map(x => x.seat);
        if (res.badge === null || legal.includes(res.badge)) engine.setBadgeDraft(s, who, res.badge);
    }
    return true;
}

/**
 * 女巫的用药计划。模型说的动作认不出、或者目标不在她那瓶药的合法集里，一律按「今晚不用药」
 * ——宁可这一夜白过，也绝不替她乱开一瓶药（毒错了人是不可逆的）。
 */
function witchPlanOf(s, who, res) {
    const target = res?.target ?? null;
    if (res?.action === 'heal' && engine.witchTargets(s, who, 'heal').includes(target)) return { save: true };
    if (res?.action === 'poison' && engine.witchTargets(s, who, 'poison').includes(target)) return { poison: target };
    return {};
}

function skipNight(s, phase) {
    s.phase = phase;
    return true;
}

/** 底部那一个按钮：按阶段决定是「让谁行动」还是本地推进 */
async function runTableAction(app, close) {
    const session = app.session;
    if (!session || app.busy) return;
    const type = getRoomType(session.typeId);
    // 轮到我动手时底部是选人条，#wwAct 根本不渲染；这一行只是防脏 DOM 的兜底
    if (myNightDuty(app, session)) return;
    if (session.phase === 'night_guard') {
        // 阶段固定走，但场上没有活守卫时不必白打一次 AI：交给本地推进那一步（按钮文案照旧，看不出差别）
        if (!engine.hasLiveRole(session, 'guard')) return runTableAdvance(app, close);
        return nightTurn(app, close, 'guard');
    }
    if (session.phase === 'night_wolf') return nightTurn(app, close, 'wolf');
    if (session.phase === 'night_seer') {
        // 阶段固定走，但场上没人可验时不必白打一次 AI：交给本地推进那一步（按钮文案照旧，看不出差别）
        if (!engine.seatsOfRole(session, 'seer').some(s => s.alive !== false)) return runTableAdvance(app, close);
        return nightTurn(app, close, 'seer');
    }
    if (session.phase === 'night_witch') {
        // 同上：她不在世、药都用完了、或者今晚没有一步是她能走的，都不必白打一次 AI
        const who = ai.defaultActor(session, 'witch');
        if (!who || !ai.nightTargets(session, 'witch', who).length) return runTableAdvance(app, close);
        return nightTurn(app, close, 'witch');
    }
    if (session.phase === 'night_hunter') {
        // 猎人这一拍只有**真被刀的那个**才有决策；没被刀的夜里点一下就过去（文案照旧，看不出差别）
        if (engine.hunterWakesTonight(session) == null) return runTableAdvance(app, close);
        return nightTurn(app, close, 'hunter');
    }
    // 出局的人挨个走流程：轮到他补那一枪就让 AI 定，别人（只是走个过场）点一下就换下一个
    if (session.phase === 'skill_wait') {
        const cur = engine.currentDeath(session);
        if (cur?.act !== 'shot') return runTableAdvance(app, close);
        return nightTurn(app, close, 'hunter');
    }
    // 遗言那一拍（轮到我时底部是发言框，#wwAct 不渲染，走不到这儿）
    if (session.phase === 'last_words') {
        const seat = engine.currentLastWordSpeaker(session);
        return seat != null ? lastWordsTurn(app, close, seat, type) : undefined;
    }
    if (session.phase === 'day_speak') {
        const seat = engine.currentSpeaker(session);
        return seat ? speakTurn(app, close, seat.seat, type) : undefined;
    }
    // PK 的两拍与白天的两拍共用同一对 turn：落点由 apply 里按阶段分流
    if (session.phase === 'day_pk') {
        const seat = engine.currentPkSpeaker(session);
        return seat ? speakTurn(app, close, seat.seat, type) : undefined;
    }
    // 上警表态：逐座问「上不上警」，收齐那一刻引擎自己公布名单（这里不加按钮，见 applySheriffSignup）
    if (session.phase === 'day_sheriff_signup') {
        const seat = engine.currentSheriffSignup(session);
        return seat ? declareTurn(app, close, seat.seat, type) : undefined;
    }
    // 警上发言与竞选 PK 的加说一轮：与白天发言同一个 turn，落点由 apply 里按阶段分流（见 speakTurn）
    if (session.phase === 'day_sheriff_speak') {
        const seat = engine.currentSheriffSpeaker(session);
        return seat ? speakTurn(app, close, seat.seat, type) : undefined;
    }
    if (session.phase === 'day_sheriff_pk') {
        const seat = engine.currentSheriffPkSpeaker(session);
        return seat ? speakTurn(app, close, seat.seat, type) : undefined;
    }
    // 竞选那两拍投票与白天投票同一个 turn，落点由 apply 里按阶段分流（见 voteTurn）
    if (session.phase === 'day_sheriff') {
        const seat = engine.currentSheriffVoter(session);
        return seat ? voteTurn(app, close, seat.seat, type) : undefined;
    }
    if (session.phase === 'day_sheriff_pk_vote') {
        const seat = engine.currentSheriffPkVoter(session);
        return seat ? voteTurn(app, close, seat.seat, type) : undefined;
    }
    if (session.phase === 'day_order') return orderTurn(app, close);
    // 交警徽：有草稿时底部是「继续」那个本地推进按钮，走不到这儿（这里必然要打一次 AI）
    if (session.phase === 'badge_wait') return badgeTurn(app, close);
    if (session.phase === 'day_vote') {
        const seat = engine.currentVoter(session);
        return seat ? voteTurn(app, close, seat.seat, type) : undefined;
    }
    if (session.phase === 'day_pk_vote') {
        const seat = engine.currentPkVoter(session);
        return seat ? voteTurn(app, close, seat.seat, type) : undefined;
    }
}

/** 不用 AI 的那几步：结算夜里的事、进白天、开票——都是引擎算的 */
async function runTableAdvance(app, close) {
    const session = app.session;
    if (!session || app.busy) return;
    const phase = session.phase;
    const out = await mutateSession(app, session.id, s => {
        if (s.phase !== phase) return null;
        if (phase === 'night_resolve') { engine.settleNight(s); return true; }
        // 守卫不在世时的 night_guard：阶段照走，点一下就过去（后面接的是狼，不是结算）
        if (phase === 'night_guard') {
            if (engine.hasLiveRole(s, 'guard')) return null;
            s.phase = engine.nextNightPhase(s, 'night_guard');
            return true;
        }
        // 预言家不在世时的 night_seer：阶段照走，点一下就过去
        if (phase === 'night_seer') {
            if (engine.seatsOfRole(s, 'seer').some(x => x.alive !== false)) return null;
            s.phase = engine.nextNightPhase(s, 'night_seer');
            return true;
        }
        // 女巫不在世 / 药都用完了的 night_witch：同上
        if (phase === 'night_witch') {
            const who = ai.defaultActor(s, 'witch');
            if (who && ai.nightTargets(s, 'witch', who).length) return null;
            s.phase = engine.nextNightPhase(s, 'night_witch');
            return true;
        }
        // 今晚没被刀的 night_hunter：他没有可决定的（枪只在被刀那一刻定），点一下就过去
        if (phase === 'night_hunter') {
            if (engine.hunterWakesTonight(s) != null) return null;
            s.phase = engine.nextNightPhase(s, 'night_hunter');
            return true;
        }
        if (phase === 'dawn') return engine.startDay(s);
        // 竞选开票：票高的当选；平票进 PK（那一台也是停在这个阶段，引擎自己按 sheriffPk 分流），
        // 补投再平票就是这一局没有警徽（见 settleSheriff / settleSheriffPk）
        if (phase === 'day_sheriff_verdict') { engine.settleSheriff(s); return true; }
        // 公布昨夜死讯：算定了一整夜的那几条在这一拍一次落（日子只有警长板的第一天有）
        if (phase === 'day_deaths') return engine.announceDeaths(s);
        if (phase === 'day_verdict') { engine.settleVote(s); return true; }
        // 出局者的流程：换下一个（最后一个走完，这一批才真的散场——天亮，或者入夜）
        if (phase === 'skill_wait') return engine.advanceDeathQueue(s);
        // 交警徽那一拍：遗言那次调用顺手定好的去向在这儿当众走一遍。
        // 没有草稿时这一步不该是本地推进（底部是「让 X 号 移交警徽」那个按钮）——返回 null 空转
        if (phase === 'badge_wait') {
            const head = engine.currentDeath(s);
            const draft = engine.takeBadgeDraft(s, head?.seat);
            return draft ? engine.applyBadge(s, draft.to) : null;
        }
        return null;
    });
    renderApp(app, close);
    // 这一下是不是把局面送进了「全桌挨个拿主意」的那几拍——今天只有一条：警长板第一天的
    // 「开始第 1 天」→ 上警表态（这一步不打 AI，走不到 runTurn 的尾巴上去，见 maybeAutoRun）
    maybeAutoRun(app, close);
}

/** 玩家自己发言：手打，或者代笔之后发出去（这一步不打 AI）；遗言那一拍走的是同一段话，落点不同 */
async function sendMySpeech(app, close) {
    const session = app.session;
    const mine = mySeatOf(app, session);
    if (!session || !mine || app.busy) return;
    const words = session.phase === 'last_words';
    // 上警发言那一拍：**退了水可以一句话都不说**（引擎允许空正文，见 applySheriffSpeech），
    // 所以这一档的空正文只在「又不退水」时才拦——退水本身就是一次完整的表态
    const candidacy = session.phase === 'day_sheriff_speak';
    const withdraw = candidacy && !!app.withdraw;
    const text = String(app.draft || '').trim();
    if (!text && !withdraw) { toast(app, words ? '遗言总得写两句，或者让 AI 代笔' : '先打两句，或者让 AI 代笔'); return; }
    // 在任警长留遗言时顺手定下的警徽去向（0 = 撕掉；没点过就是 null，留到交徽那一拍再定）
    // ⚠️ 两件事必须分开：**选没选过**（`hasPick`）与**选了去哪儿**（`badgeTo`）。芯片上 0 是
    // 「撕掉」，而引擎里只有 null 是撕掉、0 是个不存在的座号——直接落 0 会被交徽那一拍的
    // applyBadge 挡下，而 takeBadgeDraft **已经先把草稿清了**，等于白选一次。
    const rawPick = (words && engine.isSheriff(session, mine.seat)) ? app.badgePick : null;
    const hasPick = rawPick != null;
    const badgeTo = hasPick && Number(rawPick) !== 0 ? Number(rawPick) : null;
    // 高亮跟着「我开口」这一下走，与 AI 那一路同一条口径（见 calledSeatOf）；遗言那一拍不在那张表里，
    // 它本来就归 actingSeat 管。空正文被上面拦下时不记——没说出来就不点亮
    const hl = SPEAK_PHASES.includes(session.phase)
        ? { phase: session.phase, round: session.round, seat: mine.seat } : null;
    // 五种落点：遗言 / 上警发言（多带一个退不退水）/ 竞选 PK 台上那一轮 / 白天 PK 台上那一轮 /
    // 普通白天发言——都是同一段话，去处不同
    const ok = await mutateSession(app, session.id, s => {
        const done = words
            ? engine.applyLastWords(s, mine.seat, text)
            : candidacy ? engine.applySheriffSpeech(s, mine.seat, text, withdraw)
                : s.phase === 'day_sheriff_pk' ? engine.applySheriffPkSpeech(s, mine.seat, text)
                    : s.phase === 'day_pk' ? engine.applyPkSpeech(s, mine.seat, text)
                        : engine.applySpeech(s, mine.seat, text);
        if (done && hasPick) engine.setBadgeDraft(s, mine.seat, badgeTo);
        return done;
    });
    app.draft = '';
    app.badgePick = null;
    app.withdraw = false;
    if (ok && hl) app.calledSeat = hl;
    renderApp(app, close);
    if (!ok) toast(app, '这一步没生效，再点一次试试');
    // 我自己那一段说完，也可能正好把这一天送进投票阶段（见 maybeAutoRun 的三个入口）
    maybeAutoRun(app, close);
}

/** 代笔：带上玩家自己打的草稿与标记，让 AI 以它的口吻写完；失败就原样留草稿 */
async function ghostSpeak(app, close) {
    const session = app.session;
    const mine = mySeatOf(app, session);
    if (!session || !mine || app.busy) return;
    const type = getRoomType(session.typeId);
    const draft = String(app.draft || '');
    const willCall = ai.modeOf(session) === 'ai';

    app.busy = true;
    renderApp(app, close);
    let res = null;
    try {
        // 遗言那一拍走的是**另一套提示词**：他不用再装好人，可以摊牌、可以报验人
        res = session.phase === 'last_words'
            ? await ai.lastWords({ session, seatNo: mine.seat, type })
            : await ai.ghostwrite({
                session, seatNo: mine.seat, draft,
                marks: marksForPrompt(session.marks), type
            });
    } catch { res = null; }
    app.busy = false;

    if (res && !res.degraded) app.draft = res.text;
    // 在任警长的遗言代笔：那一次调用顺手把警徽的去向也答了（见 ai.lastWords）——预选到芯片上，
    // 「说完」那一下与手选走同一条路（见 sendMySpeech 的 hasPick / badgeTo）。null = 他当场撕掉
    if (res && 'badgeTarget' in res) app.badgePick = res.badgeTarget == null ? 0 : Number(res.badgeTarget);
    await mutateSession(app, session.id, s => {
        // 代笔写出来的东西算「AI 替主视角做的判断」，笔记记在**主视角自己**的座位上
        engine.addNote(s, mine.seat, { kind: 'ghost', text: res?.note });
        if (!willCall) return true;
        s.callCount = (s.callCount || 0) + 1;
        return true;
    });
    renderApp(app, close);
    if (!res || res.degraded) toast(app, '代笔没等来回话，草稿原样留着');
    else if (!draft.trim()) toast(app, '代笔写好了，改完再发');
}

/** 玩家自己定发言方向：点选（警左 / 警右），不打 AI */
async function castMyOrder(app, close, raw) {
    const session = app.session;
    const mine = mySeatOf(app, session);
    if (!session || !mine || app.busy) return;
    const [side, dir] = String(raw || '').split(':');
    const ok = await mutateSession(app, session.id, s =>
        engine.applySpeakOrder(s, { side, dir: Number(dir) }));
    renderApp(app, close);
    if (!ok) toast(app, '这一步没生效，再点一次试试');
}

/**
 * 玩家自己投票：点选，不打 AI。
 * **半自动跑着时这一票不排队**：AI 那一头可能正替别人通话（`app.busy`），可我这一票与
 * 它无关——照旧立刻落库（写队列那一道只管让两笔写不叠上，见 mutateSession）。
 */
async function castMyVote(app, close, target) {
    const session = app.session;
    const mine = mySeatOf(app, session);
    if (!session || !mine || (app.busy && !app.autoRun)) return;
    const pick = target === 0 ? null : target;
    const ok = await mutateSession(app, session.id, s => (
        s.phase === 'day_sheriff' ? engine.applySheriffVote(s, mine.seat, pick)
            : s.phase === 'day_sheriff_pk_vote' ? engine.applySheriffPkVote(s, mine.seat, pick)
                : s.phase === 'day_pk_vote' ? engine.applyPkVote(s, mine.seat, pick)
                    : engine.applyVote(s, mine.seat, pick)));
    renderApp(app, close);
    if (!ok) toast(app, '这一票没记上，再点一次试试');
    else if (app.autoRun) toast(app, '你这一票记上了，剩下的半自动在问');   // 底栏这一下会翻成进度行，说一声
}

/**
 * 玩家自己的上警表态：两枚芯片点一下就落（不打 AI，同 castMyVote）。
 * 表态本身不进流水，所以手动那一档不给 toast——问一句「你要不要上警」再自己回答一遍很怪；
 * 收满那一刻引擎自己公布名单，那一条会浮上来。
 * **半自动跑着时这一下不排队**：AI 那一头可能正替别人问（`app.busy`），可我举不举手与它无关
 * ——照旧立刻落库（与 castMyVote 同一条口径，见那里的说明）。
 */
async function castMyDeclare(app, close, run) {
    const session = app.session;
    const mine = mySeatOf(app, session);
    if (!session || !mine || (app.busy && !app.autoRun)) return;
    const ok = await mutateSession(app, session.id, s => engine.applySheriffSignup(s, mine.seat, run === true));
    renderApp(app, close);
    if (!ok) toast(app, '这一步没记上，再点一次试试');
    // 半自动跑着时才说一声：那一下底栏会从我这两枚芯片翻成进度行，不解释一句像是点丢了
    else if (app.autoRun) toast(app, '你的表态记上了，剩下的半自动在问');
}

/**
 * 夜间选人条的点击总入口。
 * 「不是我的回合就静默返回」同时挡掉三种噪声：双击的第二下、别人已经推进过、托管之后残留的点击。
 */
function onNightChip(app, close, kind, target, act = '') {
    const session = app.session;
    const mine = mySeatOf(app, session);
    if (!session || !mine || app.busy) return;
    if (myNightDuty(app, session) !== kind) return;
    // 有队友的狼：点一下只是挑中（还要写话、还要提交），再点一下取消
    if (kind === 'wolf' && wolfMateOf(app, session, mine)) {
        app.wolfPick = app.wolfPick === target ? null : target;
        renderApp(app, close);
        return;
    }
    return actMyNight(app, close, kind, target, '', act);
}

/** 守卫守人 / 预言家验人 / 女巫用药 / 猎人开枪 / 独狼下刀：点一下就是决定，不打 AI */
async function actMyNight(app, close, kind, target, note = '', act = '') {
    const session = app.session;
    const mine = mySeatOf(app, session);
    if (!session || !mine || app.busy) return;
    const before = session.phase;
    const ok = await mutateSession(app, session.id, s => {
        if (kind === 'wolf') {
            return engine.applyWolfPlan(s, {
                plans: [{ seat: mine.seat, target, reason: '' }],
                playerSeat: mine.seat,
                note
            });
        }
        if (kind === 'guard') return engine.applyGuard(s, mine.seat, target);
        if (kind === 'seer') return engine.applySeerCheck(s, mine.seat, target);
        // 女巫：两排芯片靠 data-act 分开——一个座号分不出是救还是毒
        if (kind === 'witch') {
            const plan = act === 'heal' ? { save: true }
                : (act === 'poison' ? { poison: target } : {});
            return engine.applyWitch(s, mine.seat, plan);
        }
        // 交警徽 / 当场撕掉（0 = 撕）。**必须排在猎人那两行之前**：尾巴那句 applyHunterShot
        // 是「剩下的都当开枪」的收口，警徽掉进去就成了把警徽打出去
        if (kind === 'badge') return engine.applyBadge(s, target === 0 ? null : target);
        // 猎人：夜里被刀那一拍交给引擎的夜间答复；白天补枪那一拍才是队列里的那一枪
        if (s.phase === 'night_hunter') return engine.applyHunterNight(s, mine.seat, target === 0 ? null : target);
        return engine.applyHunterShot(s, target === 0 ? null : target);   // 0 = 弃枪
    });
    renderApp(app, close);
    if (!ok) {
        // 只在局面真的没动时才提示；已经往前走过的那种「没生效」是正常的
        if (app.session?.phase === before) toast(app, '这一步没生效，再点一次试试');
        return;
    }
    if (kind === 'seer') {
        const last = (engine.viewOf(app.session, mine.seat)?.checks || []).slice(-1)[0];
        if (last) toast(app, `你验了 ${last.seat} 号 ${last.name}：${last.isWolf ? '狼人' : '好人'}`);
    }
    // 守没守中不告诉他：平安夜也可能是狼空刀，说破了就等于把守卫的规则白送
    if (kind === 'guard') {
        const seat = engine.seatAt(app.session, target);
        if (seat) toast(app, `你今晚守着 ${seat.seat} 号 ${seat.name}`);
    }
    // 用药只有他自己看得见（流水里一个字都不写）；说给他自己听，不构成泄漏
    if (kind === 'witch') {
        const seat = engine.seatAt(app.session, target);
        if (act === 'heal' && seat) toast(app, `你用了救药，救回 ${seat.seat} 号 ${seat.name}`);
        else if (act === 'poison' && seat) toast(app, `你用了毒药，毒了 ${seat.seat} 号 ${seat.name}`);
        else toast(app, '今晚不用药');
    }
    // 夜里那一拍点了之后死讯还没公布（结算时才连着他的枪一起报）；这里只跟他自己确认一声
    if (kind === 'hunter' && before === 'night_hunter') toast(app, '记住了：你的这一枪跟你的死讯一起公布');
}

/**
 * 狼队：把提案和留给队友的话交过去，AI 队友各按自己的视角复议一次，多数说了算（并列才随机）。
 * 队友不在（被刀/被票出）就跳过 AI，我挑谁就是谁——别为了统一去空打一次 AI，
 * 那会虚增 callCount、还会往 ai.fails 里记一次假成功。
 */
async function submitWolfPlan(app, close, { pick = null, note = '' } = {}) {
    const session = app.session;
    const mine = mySeatOf(app, session);
    if (!session || !mine || app.busy) return;
    if (myNightDuty(app, session) !== 'wolf') return;
    if (pick == null) { toast(app, '先挑一个今晚的目标'); return; }
    const mate = wolfMateOf(app, session, mine);
    const text = String(note || '').trim().slice(0, 60);
    app.wolfPick = null;
    app.wolfNote = '';

    if (!mate) return actMyNight(app, close, 'wolf', pick, text);

    const out = await packTurn(app, close, { player: { seat: mine.seat, target: pick, note: text } });
    if (out?.done && out.res?.degraded) toast(app, '队友没回话，就按你说的刀');
}

/** 这一步交给 AI：全走原来的那几个 turn，零新逻辑（我是狼时 packTurn 会连我一起替掉） */
function delegateMyTurn(app, close, kind) {
    const session = app.session;
    const mine = mySeatOf(app, session);
    if (!session || !mine) return;
    // 半自动正在替别人拿主意：这一下别另开一次调用去跟它挤——挂个旗子，循环轮到我就一起问了。
    // **这一支必须排在 busy 守卫之前**：循环几乎一直处在「一次调用在飞」的状态里，而这一下
    // 不打 API、只是挂个旗子（与 castMyVote 的 `app.busy && !app.autoRun` 是同一条口径）。
    // 投票与上警表态两个落点共用这一支：都是「我这一份也交给它」，只是说的时候分个说法
    if ((kind === 'vote' || kind === 'declare') && app.autoRun) {
        app.autoRun.mine = true;
        toast(app, kind === 'declare' ? '好，你的上警表态也交给 AI' : '好，你这一票也交给 AI');
        return;
    }
    if (app.busy) return;
    if (kind === 'vote') return voteTurn(app, close, mine.seat, getRoomType(session.typeId));
    // 上警表态：与投票同款的逐座调用，只是问的不是「投谁」而是「上不上」（见 declareTurn）
    if (kind === 'declare') return declareTurn(app, close, mine.seat, getRoomType(session.typeId));
    // 警长那两拍不是「夜间行动」，各有自己的调用（见 ai.sheriffOrder / ai.badgeHandover）
    if (kind === 'order') return orderTurn(app, close);
    if (kind === 'badge') return badgeTurn(app, close);
    return nightTurn(app, close, kind);
}

/**
 * 警长定发言方向：一次调用换一个选项，落点只有警左 / 警右两项（见 engine.speakOrderOptions）。
 * 认不出、或者 AI 没回话，就交给引擎的宽容写法（退回第一项），这一天不会卡住。
 *
 * **明面上只有"定了方向"这一件事，私下的那几样跟投票那一拍一样落地**（用户 2026-09-15 定）：
 * 判断表 / 笔记 / 心声 / 关注表。警长每天多这一次行动，也就多一笔账——笔记在这里记的是
 * **他这一天的打算**，回灌他自己的提示词，发言与投票时都还在。
 * 理由（reason）与笔记（note）都记成笔记：两个都写了就两条，只写一个就那一条，
 * 一个字都没写就一条都不记（`addNote` 空文本自己会拒绝）。
 */
function orderTurn(app, close) {
    return runTurn(app, close, {
        call: s => ai.sheriffOrder({ session: s, seatNo: engine.sheriffSeatOf(s) }),
        apply: (s, res) => {
            const seatNo = engine.sheriffSeatOf(s);
            engine.mergeLabels(s, seatNo, res?.marks || {});
            engine.addNote(s, seatNo, { kind: 'order', text: res?.reason });
            engine.addNote(s, seatNo, { kind: 'order', text: res?.note });
            engine.addHeart(s, seatNo, { kind: 'order', text: res?.heart });   // 心声不进任何提示词（见引擎 addHeart）
            if (res?.watch) engine.setWatch(s, seatNo, res.watch);             // 没写那一栏 = 维持原样
            return engine.applySpeakOrder(s, res?.order || null);
        }
    });
}

/**
 * 交警徽：一次调用定去向（活人 / 撕掉）。**有草稿的时候轮不到它**——遗言那一次调用已经
 * 顺手定好了，`badge_wait` 那一拍只是当众走一遍（见 badgeWalkThrough）。
 * 他是在任警长、而且已经出局了。这里原来写着「这一拍不能卡住」，同上——当**待查的优化点**看
 * （见 lastWordsTurn 那段），不是约束。没等到回话就停住等玩家选，选「用模板顶上」才落到
 * `ai.templateBadgeTarget`（座号最小的活人）。
 */
function badgeTurn(app, close) {
    return runTurn(app, close, {
        call: s => ai.badgeHandover({ session: s, seatNo: engine.currentDeath(s)?.seat }),
        apply: (s, res) => engine.applyBadge(s, res?.torn === true ? null
            : (res?.target ?? ai.templateBadgeTarget(s, engine.currentDeath(s)?.seat)))
    });
}

/* ---------------- 半自动：全桌挨个拿主意的那几拍交给 AI ----------------
 *
 * 三档存在 localStorage 的一个 `global_*` 键里（AUTO_MODES）：**整个模块一档，不是某一桌的**。
 * 「半自动」只改一件事：进这几拍的那一下就自己按座位顺序、一次一位地问完；主视角那一座
 * 留着（自己拿主意，或者点「让 AI 代投 / 让 AI 决定」）。
 *
 * **哪几拍算「这几拍」**：全桌都要拿主意、而且**没有话可读**的那几拍——四个投票阶段
 * （VOTE_PHASES，票是静默收的）+ **上警表态**（举手也是静默的，而且十二个人一个不落）。
 * 发言不收：那是要一句一句读的公开内容，谁先说谁后说本身也是戏（用户 2026-09-18 定的口径）。
 * 名单两个落点各一张（`pendingVoters` / `pendingDeclarers`），循环走哪一张由 `pendingActors` 分流。
 *
 * **开工口三个**（`maybeAutoRun` 的调用点）：runTurn 的尾巴（AI 那一步把局面送进投票阶段，或者
 * 手动点了一位让他表态）、sendMySpeech 的尾巴（我这一段说完正好进投票）、runTableAdvance 的
 * 尾巴（「开始第 N 天」那一下把局面送进上警表态——那一步不打 AI，走不到 runTurn 里）。
 * 万一哪天真漏了一条（或者中途被打断），底栏那个「继续投票 / 继续表态」就是兜底
 * （见 renderTableBottom）。
 *
 * 中途被打断（退出这张桌 / 把档位调回「关闭」）的处理是**停下、不追**：已经飞出去的那一次
 * 照旧落库（落库认的是「哪一局」，不看模块还开着没有——`mutateSession` 从库里重读那一局），
 * 没发起的就此停住。再回到这张桌时，底栏出现「继续…」，点它就是把同一段再跑一遍——
 * 所以这一摊**不需要记「上次跑到哪儿了」**，也不需要一整串状态：循环每一轮现读名单就够了。
 */
function autoMode() {
    return autoModeOf(localStorage.getItem(AUTO_MODE_KEY));
}

function setAutoMode(key) {
    localStorage.setItem(AUTO_MODE_KEY, autoModeOf(key));
}

/**
 * 点一下循环一格：**关闭 ↔ 半自动**（用户 2026-09-17 定的这一版）。
 *
 * 全自动那一档还没做（`AUTO_MODES` 里 `ready: false`），**先不进循环**——等它真做出来再把它
 * 接进来（那时圆的「全亮」那一态才有意义）。认不出的值（老值、脏值）都当「关闭」起步。
 *
 * 改动只落 localStorage + 重绘，**不主动开工**：开工口还是那三个（进了那几拍才动，见
 * maybeAutoRun）；那几拍中途打开它，底栏那颗「继续…」就是入口。
 */
function cycleAutoMode(app, close) {
    const next = autoMode() === 'half' ? AUTO_DEFAULT : 'half';
    setAutoMode(next);
    renderApp(app, close);
    toast(app, next === 'half' ? '半自动：进投票阶段与上警表态就自己挨个问' : '改回手动：一位一位点');
}

/**
 * 这一拍还没拿主意的人：四个投票阶段＝票箱里还差谁（`pendingVoters`），
 * 上警表态＝还没举手的人（`pendingDeclarers`）。都不是那几拍就是空表——半自动据此判断开工。
 */
function pendingActors(session) {
    return session?.phase === 'day_sheriff_signup'
        ? engine.pendingDeclarers(session)
        : engine.pendingVoters(session);
}

/** 这一拍该不该由半自动开工（不然就什么都不做，照旧手动一位一位点） */
function maybeAutoRun(app, close) {
    if (app.autoRun || app.closed || app.busy || app.readonly) return;
    if (autoMode() !== 'half') return;
    const session = app.session;
    if (!session || isOver(session)) return;
    const mine = mySeatOf(app, session)?.seat;
    if (!pendingActors(session).some(s => s.seat !== mine)) return;
    runAutoRound(app, close);
}

/**
 * 把这一拍挨个问完：**一次一位、按座号顺序**（同时走十位既容易失败，也不好读流水）。
 *
 * 主视角那一座跳过，除非他自己点了「让 AI 代投 / 让 AI 决定」（`autoRun.mine`）。每一轮都现读
 * 名单——我这一份、别的 AI 那一份都可能刚落地，读库里的那份才算数。
 *
 * 四条停下来的理由，都在循环开头：① 人不在这一桌了（关了 / 被换页拆了）② **这一轮不再是
 * 当前那一轮**（换桌 / 离桌把旗子清了——用户 2026-09-16 原话：「退出该桌的时候，自动流程关闭」）
 * ③ 档位不是半自动了 ④ 名单上没别人了。**没有「失败」这一条**：某一位没等到回话就跳过
 * 他往下走（他留在名单里），一拍问完还剩谁就是失败的那几位，报一句、底栏那个
 * 「继续…」就是重试——不必另立一份「上次谁失败了」的状态。
 *
 * 两个落点走同一个循环，只是每一次问的那一下不同（投票问票 / 表态问上不上警），
 * 两边的调用都传 `strict`：**没等到回话就整笔不落**（见 runTurn），所以失败的那位留在名单里。
 */
async function runAutoRound(app, close) {
    const run = { mine: false };          // 挂在 app.autoRun 上：这一轮的旗子（见 delegateMyTurn）
    app.autoRun = run;
    const asked = new Set();              // 这一拍问过谁：没成的那位别在同一拍里死磕
    const onTable = () => !app.closed && app.root.isConnected;   // 界面都没了就别再打 API
    let count = 0;
    let failed = 0;
    let finished = false;
    let phase = null;      // 循环眼睛底下那一拍（换拍就重新记名用）
    let worked = null;     // 真问过人的最后一拍（收工那句话认它，不认退出时的那一拍）
    try {
        while (true) {
            // 旗子被换掉 = 这一轮作废：换桌 / 离桌（resetTransient 清旗子）与「又开了一轮」都在内。
            // 只看 onTable() 不够——换了桌界面还在，循环会跟着 app.session 跑到**新那一桌**去问
            if (app.autoRun !== run || !onTable() || autoMode() !== 'half') return;
            const session = app.session;
            if (!session || app.readonly || isOver(session)) return;
            // 换了一拍就重新记名：白天投平了会直接翻到 PK 补投，而台上那两位在主投那一拍
            // 已经投过、都在名册里——不清的话这一拍会一位都不问就收工（名单里明明还有人）。
            // 上警表态收满会当场翻到警上发言，那一下也走这里：名单空了，循环自然收工
            if (session.phase !== phase) { phase = session.phase; asked.clear(); }
            const mine = mySeatOf(app, session)?.seat;
            const next = pendingActors(session)
                .find(s => (run.mine || s.seat !== mine) && !asked.has(s.seat));
            if (!next) { finished = true; return; }
            asked.add(next.seat);
            count += 1;
            // 问哪一位之前先把落点定下来：这一位问完可能就把局面送进下一拍了（表态收满＝名单公布），
            // `out` 回来时 session.phase 已经不是出发时那一拍——认 `here` 才不会把票记到表态头上
            const here = session.phase;
            const type = getRoomType(session.typeId);
            const out = here === 'day_sheriff_signup'
                ? await declareTurn(app, close, next.seat, type, true)
                : await voteTurn(app, close, next.seat, type, true);
            worked = here;
            if (out?.skipped) failed += 1;
        }
    } finally {
        // 只收自己那一面旗子。旗子已经不是自己的（被打断、或者新的一轮接了手）就不重绘也不报账：
        // 接手的那一轮自己会收尾，这里顺手一清就会把**它**的旗子抹掉（代投旗子与进度行一起消失）
        if (app.autoRun === run) {
            app.autoRun = null;
            // 收工这一下要自己重绘：最后一次落库时循环还没跑完，底栏那会儿还写着进度行
            if (!app.closed && app.session) renderApp(app, close);
            // 重试那个按钮的文案跟着**当前**这一拍走（与 renderTableBottom 同一条判据）；
            // 收工那句话说的是刚刚跑完的那一拍（`worked`）——那两位不一定同一拍
            const more = app.session?.phase === 'day_sheriff_signup' ? '继续表态' : '继续投票';
            const signup = worked === 'day_sheriff_signup';
            if (failed) toast(app, `${failed} 位没等到 AI 回话，点「${more}」再问一次`);
            else if (finished && count) toast(app, signup ? '这一拍的上警表态都问完了' : '这一拍的票都问完了');
        }
    }
}

/** 换桌 / 重开 / 离桌时把只在内存里的草稿清干净（跟 app.draft 一个性质，都不落库） */
function resetTransient(app) {
    app.draft = '';
    app.wolfPick = null;
    app.wolfNote = '';
    app.badgePick = null;    // 遗言那一屏顺手选的警徽去向（还没发出去，不落库）
    app.withdraw = false;    // 上警发言那屏的「退水」开关（同上，发送那一刻才算数）
    app.calledSeat = null;   // 发言那四拍的高亮（见 calledSeatOf）：换桌 / 离桌 = 重新数
    app.autoRun = null;       // 换桌 / 离桌 = 这一轮半自动到此为止（循环每一轮开头都查它）
    clearReviewTimers(app);   // 换桌 / 离桌 = 退出这一场：还在等的窗口全掐掉
}

/** 离开牌桌（局还在原地：回列表能看到「回到牌桌」） */
async function leaveTable(app, close) {
    app.session = null;
    app.readonly = false;
    resetTransient(app);
    app.page = { name: app.tab || 'rooms' };
    await refreshTables(app);
    renderApp(app, close);
}

/**
 * 主视角给某个人贴的那个标签（`session.marks` 里一个人只有一个：能改、能撤，不能多贴，
 * 与 AI 那份判断表同一套口径，见引擎 mergeLabels）。
 * 老数据是数组（那时候可以多贴）：读的时候按**最后一个**算——只读归一，不迁移、不回写。
 */
function myMarkOf(session, seatNo) {
    const v = (session?.marks || {})[seatNo];
    if (Array.isArray(v)) return String(v[v.length - 1] || '');
    return v ? String(v) : '';
}

/** 主视角的标记 → 代笔提示词要的 { 座号: '标签' }（认不出的位置直接不出现） */
function marksForPrompt(marks) {
    const out = {};
    for (const [seat, v] of Object.entries(marks || {})) {
        const tag = Array.isArray(v) ? v[v.length - 1] : v;
        if (tag) out[seat] = String(tag);
    }
    return out;
}

/**
 * 贴标记：只在代笔那一次调用里起作用，不进任何 AI 角色的提示词。
 * **一个人一个标签**（点一个就换成它；再点已选中的那个＝撤掉）——词表跟着这一桌的板子走。
 * 面板自己刷新，不走整页重渲染（重渲染会把弹窗一起抹掉）。
 */
/** 主视图座位上「点一下贴标记」那一路：bindApp 首次绑、就地重画某一格后重绑，共用这一份 */
function bindSeatMark(app, close, btn) {
    btn.addEventListener('click', () => openMarkPanel(app, close, Number(btn.dataset.mark)));
}

/**
 * 贴完标记后，把这一格**就地**再画一遍。
 * 浮层里的 `paint()` 只管浮层自己那行芯片，**浮层外的东西谁都不会重画**；可标记就是要在座位格子上
 * 看见的，不跟着变会像「点了没生效」。不走 renderApp——那会把还挂着的浮层一起抹掉（openMarkPanel
 * 那条纪律）。两边都补，位置不同、补法也不同：
 *   · 主视图那格：整格重画。它的标记是**条件渲染**（`renderTableSeat` 里连 `.ww-seat-tags` 都是有
 *     标记才建、还得跟身份 pill 拼在一起），逐块去补等于把那份结构抄第二遍 ⇒ 不如让渲染函数自己
 *     再画一次，然后补上点击。
 *   · 「场上」小面板那格：标记槽常驻（空的时候 CSS 藏起来），改个文字就够。
 */
function syncSeatMark(app, close, seatNo) {
    const session = app.session;
    const cell = app.root.querySelector(`.ww-seat[data-mark="${seatNo}"]`);
    if (cell) {
        const box = document.createElement('div');
        box.innerHTML = renderTableSeat(app, session, engine.seatAt(session, seatNo),
            mySeatOf(app, session), isOver(session)).trim();
        const fresh = box.firstElementChild;
        bindSeatMark(app, close, fresh);
        cell.replaceWith(fresh);
    }
    const slot = app.root.querySelector(`.ww-mini-seat[data-board-seat="${seatNo}"] .ww-mini-badge.mark`);
    if (slot) slot.textContent = markShortOf(myMarkOf(session, seatNo));
}

function openMarkPanel(app, close, seatNo) {
    const session = app.session;
    const mine = mySeatOf(app, session);
    if (!session || app.readonly || !mine || seatNo === mine.seat) return;
    const seat = engine.seatAt(session, seatNo);
    if (!seat) return;

    modal(app, {
        title: `给 ${seat.seat} 号 ${seat.name} 贴标记`,
        sub: '只有你自己看得到，也只在这一局里有效；一个人一个标签，再点一下已选中的那个就撤掉。代笔时 AI 会顺着它写。',
        bodyHtml: `<div class="ww-mark-row" id="wwMarkRow"></div>`,
        onMount: mask => {
            const row = mask.querySelector('#wwMarkRow');
            const paint = () => {
                const cur = myMarkOf(app.session, seatNo);
                row.innerHTML = markTagsOf(session).map(t => `
                    <button class="ww-mark-chip ${cur === t ? 'active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>
                `).join('');
                row.querySelectorAll('.ww-mark-chip').forEach(btn => {
                    btn.addEventListener('click', async () => {
                        const tag = btn.dataset.tag;
                        await mutateSession(app, session.id, s => {
                            const all = { ...(s.marks || {}) };
                            const had = myMarkOf(s, seatNo) === tag;   // 就是现在点着的那个 ⇒ 撤掉
                            if (had) delete all[seatNo]; else all[seatNo] = tag;
                            s.marks = all;
                            return true;
                        });
                        paint();
                        syncSeatMark(app, close, seatNo);   // 浮层外的两处格子也跟着变
                    });
                });
            };
            paint();
        }
    });
}

/* ---------------- 这一桌的做法约定（作者自定义的规则提示词） ----------------
 * 模板库是**全局**的（一份模板，各桌勾选引用），桌只存「勾了哪几条 + 自己写的一段」。
 * 所以在这里改一条模板，所有勾了它的桌（含正在打的）下一次调用就是新文字——这是用户要的语义，
 * 与「建桌时复制一份快照」正相反。正文怎么拼进提示词全在 werewolfRooms.tableRulesBlock。
 *
 * 界面照「世界词典 / 世界书」那个形状来，但用的是狼人杀自己的零件：一张模板一张卡（.ww-entry），
 * 卡上名字 + 正文，选中与否用手册那套 is-locked 压暗表示；新建与改都在原位（卡即编辑器），
 * 删除收进编辑态（平时列表上只挂一枚低调的 ✎）。两块内容用 .ww-section-title 分开，
 * 右侧那行小字写清各自的生效范围。
 *
 * **重绘一律走局部 paint()，绝不 renderApp**——那会把还挂着的弹层一起抹掉（同 openMarkPanel）。
 * 同一时刻只有一张卡在编辑态，所以编辑态里那几个单例选择器不会撞车。
 */
async function openRulesPanel(app, close) {
    const session = app.session;
    if (!session || app.readonly || isOver(session)) return;
    await store.ensureRuleTemplates();   // 一路都是热的，这里只是别让面板读到空缓存

    let checked = [...ruleTemplateIdsOf(session)];   // 勾了哪几条（按「保存」才落库）
    let note = ruleNoteOf(session);                  // 自己写的那段（同上）
    let editingId = null;   // 哪张卡在编辑态（null = 都收着）
    let draft = null;       // 正在新建的那张：还没进库，保存时才 append

    // 保存要读输入框的值：modal 的按钮是**先关弹层再 await run()**，那会儿 mask 已经摘掉、
    // 查不到任何元素了，所以在 onMount 里把元素本身抓进闭包（元素脱离了文档，.value 照样读得到）
    let noteEl = null;
    let countEl = null;

    modal(app, {
        title: '这一桌的做法约定',
        sub: 'AI 每次开口都会看到：这桌勾的模板 + 你写的那段。勾选与这段文字按「保存」生效；'
            + '模板的增删改是立刻存的，对所有桌一样。',
        bodyHtml: `
            <div class="ww-section-title"><strong>做法模板</strong><span>勾了的才进这一桌</span></div>
            <div id="wwRuleList"></div>
            <button class="ww-btn ghost block" id="wwRuleNew">＋ 新建模板</button>
            <div class="ww-section-title"><strong>自己写的</strong><span>只这一桌，接在模板后面</span></div>
            <textarea class="ww-input" id="wwRuleNote" placeholder="留空也行：只勾模板就够用">${esc(note)}</textarea>
            <div class="ww-rule-count" id="wwRuleCount"></div>
        `,
        actions: [{
            label: '保存',
            run: async () => {
                const text = noteEl ? noteEl.value : note;
                const ok = await mutateSession(app, session.id, s => {
                    s.ruleNote = text;
                    s.ruleTemplateIds = [...checked];
                    return true;
                });
                renderApp(app, close);
                toast(app, ok ? '这一桌的做法记住了' : '这一局已经结束了，没能存下');
            }
        }],
        onMount: mask => {
            const listEl = mask.querySelector('#wwRuleList');
            const newBtn = mask.querySelector('#wwRuleNew');
            noteEl = mask.querySelector('#wwRuleNote');
            countEl = mask.querySelector('#wwRuleCount');

            // 这段每个对局内调用都要带一次，字数值得让作者看得见（不设上限，只是显示）
            const syncCount = () => { countEl.textContent = `已写 ${noteEl.value.length} 字`; };
            noteEl.addEventListener('input', syncCount);
            syncCount();

            // 一张卡：编辑态是一张能改的卡，平时是一张点了就勾上/取消的卡
            const cardHtml = t => {
                const on = checked.includes(t.id);
                if (editingId === t.id) {
                    return `
                        <div class="ww-entry ww-rule-tpl is-editing" data-id="${esc(t.id)}">
                            <div class="ww-entry-head">
                                <input class="ww-input ww-note ww-rule-name" value="${esc(t.name)}" placeholder="这条叫什么">
                                <button class="ww-rule-icon ww-rule-close" aria-label="收起">✕</button>
                            </div>
                            <textarea class="ww-input ww-rule-text" placeholder="想让 AI 怎么做？比如：两三句说完，别写小作文">${esc(t.text)}</textarea>
                            <div class="ww-rule-actions">
                                <button class="ww-small-button ww-rule-save">保存</button>
                                <button class="ww-small-button ghost ww-rule-cancel">取消</button>
                                <button class="ww-small-button ghost ww-rule-del">删除</button>
                            </div>
                        </div>
                    `;
                }
                return `
                    <div class="ww-entry ww-rule-tpl ${on ? '' : 'is-locked'}" role="button" tabindex="0" data-id="${esc(t.id)}">
                        <div class="ww-entry-head">
                            <strong>${esc(t.name || '未命名')}</strong>
                            <span class="ww-pill ${on ? 'good' : 'muted'}">${on ? '已选中' : '未选中'}</span>
                            <button class="ww-rule-icon" data-edit="1" aria-label="改这条">✎</button>
                        </div>
                        <p>${esc(t.text || '（还没写内容）')}</p>
                    </div>
                `;
            };

            const closeCard = () => { editingId = null; draft = null; paint(); };

            const saveCard = async () => {
                const name = listEl.querySelector('.ww-rule-name')?.value.trim() || '';
                const text = listEl.querySelector('.ww-rule-text')?.value || '';
                if (!name && !text.trim()) { toast(app, '写点内容再保存'); return; }
                const all = store.cachedRuleTemplates();
                const next = draft && draft.id === editingId
                    ? [...all, { id: editingId, name, text }]
                    : all.map(t => (t.id === editingId ? { ...t, name, text } : t));
                await store.saveRuleTemplates(next);   // 模板立刻存：它是全局的，改完对新老各桌一起生效
                closeCard();
            };

            const delCard = async id => {
                const t = store.cachedRuleTemplates().find(x => x.id === id);
                if (!t) { closeCard(); return; }   // 草稿本来就没进库，删除＝取消
                const yes = await showConfirm(`删掉模板「${t.name || '未命名'}」？所有勾了它的桌都会少这一条。`);
                if (!yes) return;
                await store.saveRuleTemplates(store.cachedRuleTemplates().filter(x => x.id !== id));
                // 各桌 ruleTemplateIds 里那个 id 留着不管：读侧 find 不到就跳过（见 werewolfRooms）
                closeCard();
            };

            const bindCards = () => {
                listEl.querySelectorAll('.ww-rule-tpl[data-id]').forEach(card => {
                    const id = card.dataset.id;
                    if (editingId === id) {
                        card.querySelector('.ww-rule-save').addEventListener('click', saveCard);
                        card.querySelector('.ww-rule-cancel').addEventListener('click', closeCard);
                        card.querySelector('.ww-rule-close').addEventListener('click', closeCard);
                        card.querySelector('.ww-rule-del').addEventListener('click', () => delCard(id));
                        // 新建的先填名字，改已有的多半是改正文
                        card.querySelector(draft && draft.id === id ? '.ww-rule-name' : '.ww-rule-text')?.focus();
                        return;
                    }
                    const toggle = () => {
                        checked = checked.includes(id) ? checked.filter(x => x !== id) : [...checked, id];
                        paint();
                    };
                    // ✎ 别顺手把卡也切了（它长在可点的卡里面）
                    card.querySelector('[data-edit]').addEventListener('click', ev => {
                        ev.stopPropagation();
                        editingId = id;
                        paint();
                    });
                    card.addEventListener('click', toggle);
                    card.addEventListener('keydown', ev => {
                        // ✎ 自己有一套键盘行为：回车落在它身上不该顺手把这张卡也切了
                        if (ev.target !== card) return;
                        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); }
                    });
                });
            };

            const paint = () => {
                const all = store.cachedRuleTemplates();
                // 空库起步，不预置任何模板（用户定）：给一句话说清这地方是干什么的
                listEl.innerHTML = (!all.length && !draft)
                    ? '<div class="ww-empty">还没有模板。把常用的做法写成一条，以后每一桌都能勾它。</div>'
                    : [...all, ...(draft ? [draft] : [])].map(cardHtml).join('');
                newBtn.disabled = !!draft;
                bindCards();
            };

            newBtn.addEventListener('click', () => {
                if (draft) return;
                draft = { id: store.newTemplateId(), name: '', text: '' };
                editingId = draft.id;
                paint();
            });

            paint();
        }
    });
}

/* ---------------- 心声（道具：花钻石看某一票当时没说出口的那句话） ----------------
 * 写点在票投出去那一刻（voteTurn 的 apply 里 engine.addHeart），这里只管看。
 * **今天读它的只有这一处，也不进任何人的提示词**——心声天然带身份，进别人的视角就是
 * 给全场开上帝视角（见 werewolfEngine.js 顶部那条红线）。但它属于写出它的那个角色，
 * 以后拿它给**它自己**用是另一回事——界线划在「谁看」，不是「永远不许读」。
 */

/**
 * 某个座位在某一轮留下的**投票那一类**心声；没有就空串（界面上就不画那个小圆点）。
 *
 * ⚠️ 必须按 `kind` 挑，不能只看轮次：**第 1 天不止投票会留心声**——上警表态（`declare`）与
 * 警长定发言方向（`order`）都在同一轮里、而且都排在投票之前，而 `find` 取的是这一轮的
 * **第一条**。不挑的话，点开某人的投票小圆点读到的是他前几拍心里那句话——花钻石买到了
 * 别人的另一句话，这是实打实的错。
 * 今天算「投票那一类」的只有两种：AI 自己投的（vote）与 AI 替主视角投的（ghost，
 * 见 voteTurn）。其余几种一次都不会被这里读到——与「今天只写不读」同一条口径：
 * 它们留着给以后**它自己**用（见引擎 addHeart 那段）。
 */
function heartOf(session, seatNo, round, kinds = ['vote', 'ghost']) {
    const list = ((session?.aiHearts || {})[seatNo] || []).filter(h => kinds.includes(h.kind || 'vote'));
    if (round == null) return list.slice(-1)[0]?.text || '';   // 老流水没有轮次：取最近一条
    return list.find(h => h.round === round)?.text || '';
}

/** 点小圆点：先问要不要花钻石，确认了才扣钻、才给看 */
async function openHeart(app, seatNo, round) {
    const session = app.session;
    const seat = engine.seatAt(session, seatNo);
    const who = `${seatNo} 号 ${seat?.name || ''}`;
    const text = heartOf(session, seatNo, round);
    if (!text) return toast(app, '这一票没有留下心声');
    // **没坐上这一桌的观战局照样能看**（用户 2026-09-13 定）：钻石扣的是「看的人」自己
    // 那个角色的钱包，跟他坐没坐上这一桌无关。只有压根没有主视角角色时才没处扣。
    if (!app.me) return toast(app, '还没有主视角角色，钻石没处扣');
    const bal = store.coinsOf(await store.getStat(app.me));
    if (bal < store.HEART_COST) {
        return modal(app, {
            title: '心声',
            sub: `看一条心声要 ${store.HEART_COST} 钻石，你现在有 ${bal} 颗。`,
            bodyHtml: '<div class="ww-heart-hint">钻石是每个角色自己的，赢一局进账。</div>'
        });
    }
    modal(app, {
        title: `${who}的心声`,
        sub: `消耗 ${store.HEART_COST} 钻石查看 · 你现在有 ${bal} 颗`,
        // 不写「谁谁看不到」（用户 2026-09-13 纠正）：这句只讲它是什么。事实上能进这一桌、
        // 有钻石的人都能看任何人的心声——它不进的是**别人的视角**（见引擎 addHeart）。
        bodyHtml: '<div class="ww-heart-hint">投那一票那一刻没说出口的一句话。</div>',
        actions: [{
            label: `花 ${store.HEART_COST} 钻石看`,
            // 就地换成正文，**不关掉再开一个**：扣钻要两趟 IDB（读档案 + 写档案），关→开中间
            // 那一段遮罩整块不在（含 4px 背板模糊）⇒ 整张牌桌闪一下（用户 2026-09-14 报的）。
            keepOpen: true,
            run: async mask => {
                const pay = mask.querySelector('.ww-choice');
                pay.disabled = true;              // 等库的这段时间别让人点第二下
                const left = await store.spendCoins(app.me, store.HEART_COST);
                if (left === null) {
                    pay.disabled = false;
                    return toast(app, '钻石不够了');
                }
                const box = mask.querySelector('.ww-modal');
                box.innerHTML = `<h3>${esc(`${who}的心声`)}</h3>`
                    + `<p class="ww-modal-sub">花掉 ${store.HEART_COST} 钻石 · 还剩 ${left} 颗</p>`
                    + `<div class="ww-heart-text">${esc(text)}</div>`
                    + '<button class="ww-modal-close">知道了</button>';
                box.querySelector('.ww-modal-close').addEventListener('click', () => mask.remove());
            }
        }]
    });
}

/* ---------------- 事件绑定 ---------------- */

function bindApp(app, close) {
    const root = app.root;
    root.querySelector('#wwBack')?.addEventListener('click', () => handleBack(app, close));
    // 板子不止一张了：说明里点一下就说清这一版有哪几张，别只报第一张
    root.querySelector('#wwAbout')?.addEventListener('click',
        () => toast(app, `狼人杀 · ${Object.values(BOARDS).map(b => b.label).join(' / ')}`));
    root.querySelector('#wwGiveUp')?.addEventListener('click', () => confirmGiveUp(app, close));
    // 这一桌的做法约定：只有准备页/对局页、且这一局还打得动时才有这个按钮（见 renderTopbar）
    root.querySelector('#wwRulesBtn')?.addEventListener('click', () => openRulesPanel(app, close));
    // 自动推进那一档：桌内两页才有（见 renderTopbar）；点一下循环「关闭 ↔ 半自动」
    root.querySelector('#wwAutoBtn')?.addEventListener('click', () => cycleAutoMode(app, close));
    // 继续（投票 / 表态）：半自动开着但循环没在跑（被打断了 / 刚回到这张桌），
    // 点一下把同一段接着跑——同一颗按钮，两个落点都走 maybeAutoRun
    root.querySelector('#wwAutoMore')?.addEventListener('click', () => maybeAutoRun(app, close));
    // 没等到 AI 回话那一拍的两颗按钮（见 renderStalled）：这一步还没落库，别的动作都点不动
    root.querySelector('#wwRetryBtn')?.addEventListener('click', () => retryStalled(app, close));
    root.querySelector('#wwFallbackBtn')?.addEventListener('click', () => fallbackStalled(app, close));

    // 活动页那件商品：卡片整张就是按钮（data-item 认是哪一件），价钱与余额的账在 buyShopItem 里算
    root.querySelectorAll('.ww-shop-card').forEach(btn => {
        btn.addEventListener('click', () => {
            const item = SHOP.find(x => x.id === btn.dataset.item);
            if (item) buyShopItem(app, close, item);
        });
    });

    root.querySelectorAll('.ww-tab').forEach(btn => {
        btn.addEventListener('click', async () => {
            app.tab = btn.dataset.tab;
            app.page = { name: app.tab };
            await refreshTables(app);
            // 战绩与点亮可能刚被上一局的结算改过；活动页那一页整页读的是档案（余额 + 背包）
            if (app.tab === 'me' || app.tab === 'activity') await refreshMe(app);
            renderApp(app, close);
        });
    });

    root.querySelector('#wwOpenRules')?.addEventListener('click', () => {
        app.page = { name: 'rules', typeId: app.page.typeId || null };
        renderApp(app, close);
    });

    root.querySelector('#wwOpenHandbook')?.addEventListener('click', () => {
        app.page = { name: 'handbook' };
        renderApp(app, close);
    });

    // 手册里翻开的房型完整规则：原路退回手册
    root.querySelectorAll('[data-rules-type]').forEach(btn => {
        btn.addEventListener('click', () => {
            app.page = { name: 'rules', typeId: btn.dataset.rulesType, from: 'handbook' };
            renderApp(app, close);
        });
    });

    root.querySelectorAll('.ww-type-card').forEach(btn => {
        btn.addEventListener('click', async () => {
            app.page = { name: 'type', typeId: btn.dataset.type };
            await refreshTables(app);   // 进分类页重读一遍：别的标签页可能刚开了一桌
            renderApp(app, close);
        });
    });

    root.querySelectorAll('.ww-table-card').forEach(btn => {
        btn.addEventListener('click', () => enterTable(app, close, btn.dataset.session));
    });

    root.querySelector('#wwOpenTable')?.addEventListener('click', () => openTable(app, close, app.page.typeId));

    root.querySelectorAll('.ww-seat[data-seat]').forEach(btn => {
        btn.addEventListener('click', () => onSeatTap(app, close, Number(btn.dataset.seat)));
    });

    root.querySelector('#wwInvite')?.addEventListener('click', () => openInvitePanel(app, close));
    root.querySelector('#wwMatch')?.addEventListener('click', () => runMatch(app, close));
    root.querySelector('#wwStart')?.addEventListener('click', () => runStart(app, close));

    // 对局页
    root.querySelectorAll('.ww-seat[data-mark]').forEach(btn => bindSeatMark(app, close, btn));
    // 阶段条那颗展开/收起「场上」小面板的按钮。面板是浮在滚动区上面的（覆盖式），
    // 这一下不改滚动区几何，所以重绘里那条滚动恢复规则对这个动作是空转，不用额外管
    root.querySelector('#wwBoardBtn')?.addEventListener('click', () => {
        app.boardOpen = !app.boardOpen;
        renderApp(app, close);
    });
    // 小面板里的格子：与上面那行是同一路（openMarkPanel），只是属性名不同，两边不会互相抓错
    root.querySelectorAll('.ww-mini-seat[data-board-seat]').forEach(btn => {
        btn.addEventListener('click', () => openMarkPanel(app, close, Number(btn.dataset.boardSeat)));
    });
    // 复盘期的座位（主视图那一栏 + 「场上」小面板，两处共用 data-insight）：点一下让这个角色
    // 自己复盘这一局。同一时刻每格只会带其中一个属性——打完的桌上 data-mark 那个已经换掉了
    root.querySelectorAll('[data-insight]').forEach(btn => {
        btn.addEventListener('click', () => openInsightPanel(app, close, Number(btn.dataset.insight)));
    });
    // 投票消息尾巴上的小圆点：花钻石看那一票的心声（老流水没有轮次 → 传 null 取最近一条）
    root.querySelectorAll('.ww-heart-dot').forEach(btn => {
        btn.addEventListener('click', () => openHeart(app, Number(btn.dataset.heartSeat),
            btn.dataset.heartRound ? Number(btn.dataset.heartRound) : null));
    });
    root.querySelector('#wwAct')?.addEventListener('click', () => runTableAction(app, close));
    root.querySelector('#wwAdvance')?.addEventListener('click', () => runTableAdvance(app, close));
    root.querySelector('#wwSend')?.addEventListener('click', () => sendMySpeech(app, close));
    root.querySelector('#wwGhost')?.addEventListener('click', () => ghostSpeak(app, close));
    root.querySelector('#wwDraft')?.addEventListener('input', e => { app.draft = e.target.value; });
    root.querySelector('#wwLeaveTable')?.addEventListener('click', () => leaveTable(app, close));
    root.querySelectorAll('.ww-mark-chip[data-vote]').forEach(btn => {
        btn.addEventListener('click', () => castMyVote(app, close, Number(btn.dataset.vote)));
    });
    // 上警表态：两枚芯片，点了就是决定（不打 AI）；按下那一刻全桌的表态还没收齐，什么都不报
    root.querySelectorAll('.ww-mark-chip[data-declare]').forEach(btn => {
        btn.addEventListener('click', () => castMyDeclare(app, close, btn.dataset.declare === '1'));
    });
    // 「退水」开关：与遗言那屏的警徽芯片同一个道理——只翻高亮、**不整块重渲染**
    // （他可能正打着一半的发言，重绘会把光标顶掉）。真正的落库在「发送 / 退水」那一下
    root.querySelectorAll('.ww-mark-chip[data-withdraw]').forEach(btn => {
        btn.addEventListener('click', () => {
            app.withdraw = !app.withdraw;
            // 按钮文案跟着变（「发送」↔「退水」）：就地改这两处，不动 textarea
            root.querySelectorAll('.ww-mark-chip[data-withdraw]').forEach(b => {
                b.classList.toggle('active', app.withdraw);
                b.textContent = app.withdraw ? '✓ 退水（不争这个警徽）' : '退水（不争这个警徽）';
            });
            const send = root.querySelector('#wwSend');
            if (send) send.textContent = app.withdraw ? '退水' : '发送';
        });
    });
    root.querySelectorAll('.ww-mark-chip[data-night]').forEach(btn => {
        // data-act 是女巫那两排药用的（救/毒/不用，一个座号分不出是哪种）；没有它的芯片走原路
        const target = btn.dataset.target ? Number(btn.dataset.target) : null;
        btn.addEventListener('click', () => onNightChip(app, close, btn.dataset.night, target, btn.dataset.act || ''));
    });
    // 定发言方向：两枚芯片，点了就是决定（不打 AI）
    root.querySelectorAll('.ww-mark-chip[data-order]').forEach(btn => {
        btn.addEventListener('click', () => castMyOrder(app, close, btn.dataset.order));
    });
    // 遗言那一屏顺手选的警徽去向：只改高亮，不整块重渲染——他可能正打着一半的遗言，
    // 重绘会把光标顶掉。真正的落库在「说完」那一下（见 sendMySpeech）
    root.querySelectorAll('.ww-mark-chip[data-badge]').forEach(btn => {
        btn.addEventListener('click', () => {
            app.badgePick = Number(btn.dataset.badge);
            root.querySelectorAll('.ww-mark-chip[data-badge]')
                .forEach(b => b.classList.toggle('active', b === btn));
        });
    });
    root.querySelector('#wwNote')?.addEventListener('input', e => { app.wolfNote = e.target.value; });
    root.querySelector('#wwSubmit')?.addEventListener('click', () => submitWolfPlan(app, close, { pick: app.wolfPick, note: app.wolfNote }));
    root.querySelector('#wwDelegate')?.addEventListener('click', e => delegateMyTurn(app, close, e.currentTarget.dataset.delegate));

    // 赛后复盘
    root.querySelector('#wwReviewSend')?.addEventListener('click', () => sendReview(app, close));
    root.querySelector('#wwAutoReply')?.addEventListener('click', () => toggleAutoReply(app, close));
    const reviewDraft = root.querySelector('#wwReviewDraft');
    if (reviewDraft) {
        // 不整块重渲染（会丢焦点与光标），就地更新草稿与候选浮层
        const sync = () => { app.review.draft = reviewDraft.value; updateMentionList(app, root); };
        reviewDraft.addEventListener('input', sync);
        reviewDraft.addEventListener('click', sync);
        reviewDraft.addEventListener('keyup', sync);
    }
    // 委托在浮层上，不在候选按钮上：候选是输入时按需 innerHTML 生成的，
    // 渲染那一刻一个都还不存在，直接挂按钮等于挂给空气。
    // mousedown 而不是 click：textarea 先失焦会把浮层关掉，click 就点不着了。
    root.querySelector('#wwMentionList')?.addEventListener('mousedown', e => {
        const item = e.target?.closest?.('.ww-at-item[data-at]');
        if (!item) return;
        e.preventDefault();
        insertMention(app, root, Number(item.dataset.at));
    });
}

/** 进已有的桌：准备中 → 准备页；已开局 → 牌桌（参与）或旁观页；打完的 → 同一张桌上复盘 */
async function enterTable(app, close, sessionId) {
    const inTypes = app.typeTables ? Object.values(app.typeTables).flat() : [];
    // 打完的桌已经不在活动列表里了，从「最近结束」里捞
    const existing = inTypes.find(s => s.id === sessionId)
        || (app.recentEnded || []).find(s => s.id === sessionId);
    if (!existing) { toast(app, '这一桌不在了'); return; }
    app.session = existing;
    // 准备中的桌**能进去就能坐**（用户 2026-09-14 问的：「不在任何对局中的主视角角色，
    // 应该可以加入准备中还有空位的其他对局吧」）：只要没被别的局锁住，空位就是可点的，
    // 底栏写「先坐下」，坐下之后一切照旧。换成别的角色当主视角、或自己那张桌站起来之后
    // 再回来，走的都是这一条。
    // 「旁观」只剩两种人：这一局已经打起来了（进不去），以及**已经被别的局锁住**的人（坐不下）。
    app.readonly = existing.status === 'forming'
        ? !!(app.lockedSession && app.lockedSession.id !== existing.id)
        : !iAmIn(existing, app);
    resetTransient(app);
    // 记住是从哪一页点进来的：首页那列「最近结束」不挂在房型页上，退出去得还回首页
    const from = app.page?.name || null;

    if (existing.status === 'forming') {
        app.page = { name: 'room', typeId: existing.typeId, sessionId: existing.id, from };
        // 重进桌：把没有对应在飞邀请的预留放掉
        const freed = await mutateSession(app, existing.id, s => releaseOrphanReservations(app, s));
        if (freed) await refreshTables(app);
    } else {
        app.page = { name: app.readonly ? 'spectate' : 'table', typeId: existing.typeId, sessionId: existing.id, from };
        // 中途退出去过又回来：先把库里这一局的最新状态读回来（阶段、票、发言都在库里）
        app.session = (await store.getSession(existing.id)) || existing;
    }
    renderApp(app, close);
}

/** 开一桌新的（一类可以同时开多张桌；同一角色不能同时占两局） */
async function openTable(app, close, typeId) {
    const type = getRoomType(typeId);
    if (!type) return;
    const lock = blockedByLock(app, typeId);
    if (lock) { toast(app, lock); return; }

    await refreshTables(app);          // 开桌前再确认一次没有别的桌已经锁住我
    if (app.lockedSession) { toast(app, blockedByLock(app, typeId)); return; }

    const tableNo = await store.nextTableNo(typeId);
    const session = {
        id: store.newSessionId(),
        typeId,
        tableNo,
        name: `第 ${tableNo} 桌`,
        boardId: getBoard(type.boardId).id,
        // 出局信息公开方式跟着房型走（新手局明牌，速战/扮演暗牌）；存进本局，记录自带当时的规则
        revealMode: type.reveal || 'hidden',
        // 这一桌的做法约定：只记「勾了哪几条模板 + 自己写的一段」，正文在全局模板库里现取——
        // 是**引用**不是快照，所以改一条模板对老桌（含正在打的）也生效（用户定）。
        // 老记录缺这两个字段由读侧兜底（ruleTemplateIdsOf / ruleNoteOf）
        ruleTemplateIds: [],
        ruleNote: '',
        status: 'forming',
        hostId: app.me,
        createdAt: Date.now(),
        seats: [],
        reservations: {},
        log: [{ t: Date.now(), type: 'system', text: `${app.meName} 开了第 ${tableNo} 桌` }],
        marks: {},
        aiLabels: {},
        // 各座位的 AI 私有笔记：发牌时由 startGame 清空，这里先占位（老记录读不到时按空处理）
        aiNotes: {},
        events: [],
        round: 0,
        roundId: 0,
        pending: null,
        callCount: 0
    };
    await store.saveSession(session);
    app.session = session;
    app.readonly = false;
    app.page = { name: 'room', typeId, sessionId: session.id };
    await refreshTables(app);
    warnNoKey(app);
    renderApp(app, close);
}

/** 没配 AI 接口时先说一声：邀请与匹配会走模板，但人照样能凑齐 */
function warnNoKey(app) {
    if (app.keyWarned || ai.hasKey()) return;
    app.keyWarned = true;
    setTimeout(() => toast(app, '没有配置 AI 接口，邀请与匹配会以模板模式进行'), 400);
}

async function onSeatTap(app, close, seatNo) {
    const session = app.session;
    if (!session || app.busy || app.readonly) return;
    const seats = session.seats || [];
    const occupied = seats.find(s => s.seat === seatNo);
    const mine = seats.find(s => s.characterId === app.me);

    if (occupied && occupied.characterId !== app.me) return;

    if (occupied && occupied.characterId === app.me) {
        // 再点自己的座位 = 站起来
        session.seats = seats.filter(s => s.characterId !== app.me);
        session.log.push({ t: Date.now(), type: 'system', text: `${app.meName} 起身离开了 ${seatNo} 号座` });
    } else {
        // 没结束的一局里已经坐着我了，就不能再坐别的桌（它自己这桌随便换）
        const lock = app.lockedSession;
        if (lock && lock.id !== session.id) { toast(app, blockedByLock(app, session.typeId)); return; }

        const next = seats.filter(s => s.characterId !== app.me);
        next.push({ seat: seatNo, kind: 'character', characterId: app.me, name: app.meName, role: null, alive: true });
        next.sort((a, b) => a.seat - b.seat);
        session.seats = next;
        session.log.push({
            t: Date.now(),
            type: 'system',
            text: mine ? `${app.meName} 换到了 ${seatNo} 号座` : `${app.meName} 坐到了 ${seatNo} 号座`
        });
    }

    await store.saveSession(session);
    await refreshTables(app);
    renderApp(app, close);
}

/* ---------------- 组局：邀请 / 匹配 / 路人补齐 ---------------- */

/**
 * 现在能上桌的候选：没归档、没锁在别的局里、不在这桌上、也没有在飞邀请
 * （「锁在别的局里」= 它在某局 status ∈ {forming, ongoing} 的 participantIds 里）
 */
async function candidatesFor(app, session) {
    const busy = await store.getBusyCharacterIds();
    const seated = new Set((session.seats || []).filter(s => s.characterId).map(s => s.characterId));
    const flying = new Set([...app.inflight.values()].map(v => v.characterId));
    return getAllCharacterIds({ includeArchived: false })
        .filter(id => id && id !== app.me && !busy.has(id) && !seated.has(id) && !flying.has(id));
}

/**
 * 邀请面板要列的人：**主视角角色自己的联系人**（CharacterStore 的好友表，
 * 模拟小城里判断「真实联系人」用的也是它）。陌生人不在名单里——请人上桌本来就是给自己的朋友发消息。
 * 请不动的人也要列出来，各自带一句状态；联系人忽然从列表里消失会让人以为名册出了问题。
 */
const INVITE_RANK = { ok: 0, inviting: 1, seated: 2, elsewhere: 3 };

async function inviteRoster(app, session) {
    const active = await store.listActiveSessions();
    const place = new Map();                       // 角色 id → 它现在在哪一桌
    for (const s of active) for (const id of s.participantIds || []) place.set(id, s);

    const seated = new Set((session.seats || []).filter(s => s.characterId).map(s => s.characterId));
    const flying = new Set([...app.inflight.values()].map(v => v.characterId));
    const known = new Set(getAllCharacterIds({ includeArchived: false }));

    let friendIds = [];
    try { friendIds = new CharacterStore(app.me).getFriendIds(); } catch { }

    return friendIds
        .filter(id => id && id !== app.me && known.has(id))    // 已归档/已删掉的联系人不再列
        .map(id => {
            let status = 'ok';
            if (seated.has(id)) status = 'seated';
            else if (flying.has(id)) status = 'inviting';
            else if (place.has(id)) status = 'elsewhere';
            return { id, name: getCharacterNameById(id) || id, status, at: place.get(id) || null };
        })
        .sort((a, b) => (INVITE_RANK[a.status] - INVITE_RANK[b.status])
            || a.name.localeCompare(b.name, 'zh'));
}

/** 不能邀请时的那句话 */
function rosterNote(app, row) {
    if (row.status === 'seated') return '已经在这桌了';
    if (row.status === 'inviting') return '邀请还在路上';
    if (row.status === 'elsewhere') {
        const type = getRoomType(row.at?.typeId);
        return `在「${type?.name || '别的局'}」的 ${row.at?.name || '一桌'}上`;
    }
    return '邀请 ›';
}

function shuffle(list) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

function avatarHtml(id, name) {
    const initial = esc((name || '?').charAt(0));
    if (!id) return `<span class="ww-avatar-fallback">${initial}</span>`;
    return `<span class="ww-avatar">${getAvatarHtml(id, initial)}</span>`;
}

function openInvitePanel(app, close) {
    // 与 runInvite / runMatch / runStart 同一个口径：**坐下来的人**才谈得上请人
    // （底栏那颗按钮本来就没坐下时是灰的，这里是第二道）
    if (app.busy || app.readonly || !app.session || !iAmIn(app.session, app)) return;
    const session = app.session;
    const board = getBoard(getRoomType(session.typeId)?.boardId);

    inviteRoster(app, session).then(list => {
        if (app.session?.id !== session.id) return;   // 期间已经离开这桌了
        const open = freeSeats(app.session, board);
        const canAsk = list.filter(r => r.status === 'ok').length;
        const body = list.length
            ? list.map(row => {
                const invitable = row.status === 'ok' && open.length > 0;
                const note = open.length ? rosterNote(app, row) : '没有空位了';
                return `<button class="ww-choice" data-invite="${invitable ? esc(row.id) : ''}" ${invitable ? '' : 'disabled'}>
                    <span class="ww-choice-row">
                        ${avatarHtml(row.id, row.name)}
                        <span class="ww-choice-main">${esc(row.name)}</span>
                        <span class="ww-choice-go">${esc(note)}</span>
                    </span>
                </button>`;
            }).join('')
            : `<div class="ww-empty">你的联系人里还没有别人<br>（先去名册把想请的角色「添加为联系人」，再回来组局）</div>`;

        modal(app, {
            title: '邀请谁上桌',
            sub: `${open.length ? `还剩 ${open.length} 个空位，${canAsk} 位联系人可以请。` : '现在没有空位了。'}每位朋友单独一次 AI 请求，同意与否由他自己决定；这段对话会记进你们的聊天记录。`,
            bodyHtml: body,
            onMount: mask => {
                mask.querySelectorAll('[data-invite]').forEach(btn => {
                    if (!btn.dataset.invite) return;
                    btn.addEventListener('click', () => {
                        mask.remove();
                        runInvite(app, close, btn.dataset.invite);
                    });
                });
            }
        });
    });
}

/** 邀请一位角色：先留座 → 一次 AI 调用 → 回话后再落座（或放座） */
async function runInvite(app, close, targetId) {
    const session = app.session;
    if (!session || app.busy || app.readonly || !iAmIn(session, app)) return;
    const sid = session.id;
    const type = getRoomType(session.typeId);
    const board = getBoard(type?.boardId);
    const name = getCharacterNameById(targetId) || targetId;

    if ([...app.inflight.values()].some(v => v.characterId === targetId)) {
        toast(app, `${name} 的邀请还在路上`);
        return;
    }
    // 面板可能是几分钟前打开的：真正发邀请前再确认一次他还上得了桌
    if ((session.seats || []).some(s => s.characterId === targetId)) { toast(app, `${name} 已经在这桌上了`); return; }
    const elsewhere = await store.getActiveSessionForCharacter(targetId);
    if (elsewhere) { toast(app, `${name} 正在 ${elsewhere.name || '别的桌'} 上，先等那一局结束`); return; }

    const held = reserveSeat(session, board, targetId, name);
    if (!held) { toast(app, '没有空位了'); return; }

    const snapshot = (session.seats || []).slice();          // 邀请时的座位快照（给 AI 看的公开信息）
    const freeForTarget = [held.seat, ...freeSeats(session, board)].sort((a, b) => a - b);
    // 动态里要写清是谁请的：主视角可以随时换角色，只写「邀请 XX」会看不出发起人
    const inviterName = snapshot.find(s => s.characterId === app.me)?.name || app.meName;

    app.inflight.set(held.inviteId, { characterId: targetId, seat: held.seat, name });
    pushLog(session, `${inviterName} 邀请 ${name} 上桌（先给他留着 ${held.seat} 号座）`);
    await store.saveSession(session);
    await refreshTables(app);
    renderApp(app, close);

    const res = await ai.inviteCharacter({
        type, board,
        inviterId: app.me, inviterName,
        target: { id: targetId, name },
        seated: snapshot,
        freeSeats: freeForTarget
    });

    app.inflight.delete(held.inviteId);
    let landedSeat = null;
    await mutateSession(app, sid, s => {
        s.callCount = (s.callCount || 0) + 1;
        const released = releaseReservation(s, held.inviteId);

        if (!res.agreed) {
            pushLog(s, `${name} 没答应 ${inviterName} 的这次邀请${res.reply ? `：「${res.reply}」` : ''}`);
            if (released) pushLog(s, `${released} 号座放出来了`);
            return;
        }
        // 落座收口：它想坐的号 → 留给它的号 → 随机空位
        const seat = landOn(s, board, {
            characterId: targetId, name,
            preferred: res.seat >= 1 && res.seat <= board.seats ? res.seat : null,
            ownReserved: released
        });
        if (seat === null) { pushLog(s, `${name} 答应了，但已经没座位了`); return; }
        landedSeat = seat;
        if (res.reply) pushLog(s, `${name}：${res.reply}`);
        const react = res.reaction && res.reaction !== '沉默' ? `——「${res.reaction}」` : '';
        pushLog(s, `${name} 坐到了 ${seat} 号座${react}`);
        if (res.degraded) pushLog(s, `（${name} 那边没有响应，先按模板入场）`);
    });

    // 落座那一刻的测评：**人真坐下了才写**——他这次没答应/没坐上，就等于还没测过，
    // 下次再请自然还会问一遍；而问过又写不下（写入处挡了已有档位）也不会把估好的东西冲掉。
    if (landedSeat !== null && res.codex) await store.upsertCodex(targetId, res.codex);

    // 这段对话同时也是一段真实的聊天记录：存进去，打开聊天就能看见，不用玩家自己复述
    await postInviteChat(app, {
        targetId, targetName: name, type, session,
        seat: held.seat, reply: res.reply, degraded: res.degraded
    });

    await refreshTables(app);
    renderApp(app, close);
}

/**
 * 把这次邀请的对话写进真实聊天记录。
 * 走 chat.js 的 injectChatMessage（模拟小城分享游戏用的同一个接口），
 * reply: false —— 回话已经让被邀请者在自己视角里说过了，不再多打一次 AI；
 * 调用失败也不能影响组局（房间动态里本来就有这段对话）。
 */
async function postInviteChat(app, { targetId, targetName, type, session, seat, reply, degraded }) {
    const mine = `来打狼人杀吗？${type?.name || '开一桌'}${session?.name ? ` · ${session.name}` : ''}，我给你占了 ${seat} 号座。`;
    try {
        const { injectChatMessage } = await import('../chat.js');
        await injectChatMessage(app.me, targetId, {
            senderId: app.me, senderDisplayName: app.meName, text: mine
        }, { reply: false });
        // 没等到回话（超时/没配 key）时不替他编一句
        if (reply && !degraded) {
            await injectChatMessage(targetId, app.me, {
                senderId: targetId, senderDisplayName: targetName, text: reply
            }, { reply: false });
        }
    } catch (e) {
        console.warn('[werewolf] 邀请对话没能写进聊天记录', e);
    }
}

/** 匹配：一次批量调用，让被选中的角色各自选座 + 给进场反应 */
async function runMatch(app, close) {
    const session = app.session;
    if (!session || app.busy || app.readonly || !iAmIn(session, app)) return;
    const sid = session.id;
    const type = getRoomType(session.typeId);
    const board = getBoard(type?.boardId);

    const open = freeSeats(session, board);          // 已排除别人预定的座位
    if (!open.length) { toast(app, '座位已经满了'); return; }

    const pool = await candidatesFor(app, session);
    if (!pool.length) { toast(app, '暂时没有可以匹配的角色'); return; }
    const picked = shuffle(pool).slice(0, open.length).map(id => ({ id, name: getCharacterNameById(id) || id }));

    app.busy = true;
    renderApp(app, close);
    let res;
    try {
        res = await ai.matchCharacters({ type, board, seated: session.seats || [], freeSeats: open, candidates: picked });
    } catch (e) {
        res = { list: [], degraded: true };
    }
    app.busy = false;

    // 谁先落座：先按模型给的顺序，没被安排到的人再补在后面（解析失败时整批退化为随机落座 + 沉默）
    const pickedIds = new Set(picked.map(c => c.id));
    const seen = new Set();
    const order = [];
    for (const item of res.list || []) {
        if (!pickedIds.has(item.characterId) || seen.has(item.characterId)) continue;
        seen.add(item.characterId);
        order.push(item);
    }
    for (const c of picked) if (!seen.has(c.id)) { seen.add(c.id); order.push({ characterId: c.id, seat: null, reaction: '' }); }

    const seatedNow = new Set();
    await mutateSession(app, sid, s => {
        s.callCount = (s.callCount || 0) + 1;
        let landed = 0;
        for (const item of order) {
            const who = picked.find(c => c.id === item.characterId);
            const seat = landOn(s, board, { characterId: item.characterId, name: who.name, preferred: item.seat });
            if (seat === null) continue;
            landed += 1;
            seatedNow.add(item.characterId);
            const react = item.reaction && item.reaction !== '沉默' ? `——「${item.reaction}」` : '';
            pushLog(s, `${who.name} 坐到了 ${seat} 号座${react}`);
        }
        pushLog(s, res.degraded
            ? `${app.meName} 匹配到 ${landed} 个人（这次没等到 AI 回应，先按模板入座）`
            : `${app.meName} 匹配到 ${landed} 个人`);
    });

    // 落座那一刻的测评（与邀请那条路同一个口径）：只给真坐下的人写，没坐上的下次再问
    for (const item of order) {
        if (item.codex && seatedNow.has(item.characterId)) await store.upsertCodex(item.characterId, item.codex);
    }

    await refreshTables(app);
    renderApp(app, close);
}

/** 开始游戏：不满席就用临时路人来补（路人只进路人池，不算任何角色的战绩），满席即发牌 */
async function runStart(app, close) {
    const session = app.session;
    if (!session || app.busy || app.readonly || !iAmIn(session, app)) return;
    if (app.inflight.size) { toast(app, '还有邀请在路上，等回话再开'); return; }

    // 背包里揣着许愿水晶就先问一句（用户 2026-09-18 定）；不问 / 答了不用，都照常发牌
    const mine = mySeatOf(app, session);
    const held = app.me ? (store.itemsOf(await store.getStat(app.me))[store.CRYSTAL] || 0) : 0;
    if (mine && held > 0) return askWish(app, close, held);
    return dealStart(app, close);
}

/**
 * 开局前问一句要不要用许愿水晶。分成两步是**为了不用它的人**：背包里揣着水晶的人每次开局
 * 都先推开一张身份清单，那才叫烦；先问一句，不用就一下点掉。
 */
function askWish(app, close, held) {
    modal(app, {
        title: '用一颗许愿水晶？',
        sub: `背包里有 ${held} 颗。用一颗，这一局的身份由你自己挑。`,
        bodyHtml: '<div class="ww-wish-hint">许愿是从这一桌的牌堆里挑走一张、钉给你那一座，再发其余的牌——别人拿到什么不受影响。</div>',
        closeLabel: '不用，正常发牌',
        onClose: () => dealStart(app, close),   // 「不用」也得把牌发下去，不是把这一下取消掉
        actions: [{ label: '用一颗，挑身份', run: () => pickWish(app, close, held) }]
    });
}

/**
 * 挑身份：摊开的就是**这张板子本身**（`board.roles` 的份数）——许愿是从池子里预扣一份，
 * 板子上没有的身份压根不该出现在选项里（引擎那边兑不出来会就地作废，界面这道是别让它发生）。
 */
function pickWish(app, close, held) {
    const session = app.session;
    const board = getBoard(session?.boardId || getRoomType(session?.typeId)?.boardId);
    const rows = Object.entries(board.roles)
        .map(([role, n]) => `<button class="ww-wish-role" data-role="${esc(role)}">`
            + `<strong>${esc(roleLabel(role))}</strong><span>${n} 张</span></button>`)
        .join('');
    let picked = null;   // run 抓不到弹层里的东西（见 modal 的说明），所以先在 onMount 里收进闭包
    modal(app, {
        title: '许愿哪个身份',
        sub: `消耗 1 颗许愿水晶 · 你现在有 ${held} 颗`,
        bodyHtml: `<div class="ww-wish-list">${rows}</div>`,
        closeLabel: '算了，正常发牌',
        onClose: () => dealStart(app, close),   // 同上：挑到一半改主意，也是「正常发牌」，不是取消开局
        actions: [{
            label: '就许这个身份',
            run: () => {
                const mine = mySeatOf(app, app.session);
                // 挑到了、也有座可钉才许愿；缺一样就照常发牌——**不能点完什么都不发生**
                if (!picked || !mine) return dealStart(app, close);
                return dealStart(app, close, { seat: mine.seat, role: picked });
            }
        }],
        onMount: mask => {
            const go = mask.querySelector('.ww-choice');
            go.disabled = true;   // 还没挑就不给按（.ww-choice:disabled 有样式）
            mask.querySelectorAll('.ww-wish-role').forEach(btn => btn.addEventListener('click', () => {
                picked = btn.dataset.role;
                mask.querySelectorAll('.ww-wish-role').forEach(b => b.classList.toggle('is-picked', b === btn));
                go.disabled = false;
            }));
        }
    });
}

/**
 * 真的发牌：满席就用临时路人补位（路人只进路人池，不算任何角色的战绩），补满即发。
 * `claim` = `{ seat, role }` 或空——有的话交给引擎在**发牌之前**从池子里扣掉那一份、
 * 钉给那一座（见引擎 `startGame` 的 claims：先扣后发，不是洗完再换）。
 * 水晶**发牌成功之后**才扣：扣了没开成，那一颗就白花了。
 */
async function dealStart(app, close, claim = null) {
    const session = app.session;
    if (!session || app.busy || app.readonly || !iAmIn(session, app)) return;
    const sid = session.id;
    const board = getBoard(session.boardId || getRoomType(session.typeId)?.boardId);

    if (app.inflight.size) { toast(app, '还有邀请在路上，等回话再开'); return; }

    // 生成临时路人：名字 + 一句人设，沉淀进路人池
    const open = freeSeats(session, board);
    const usedNames = new Set((session.seats || []).map(s => s.name));
    const npcs = [];
    for (const seat of open) {
        let identity = randomNpcIdentity();
        for (let i = 0; i < 8 && usedNames.has(identity.name); i++) identity = randomNpcIdentity();
        usedNames.add(identity.name);
        // 路人档案与真实角色同形（战绩 / 档位 / 点亮都留好了位置），以后要复用同一个路人才有东西可读
        const npcId = store.newNpcId();
        await store.saveNpc(store.emptyNpc({
            npcId, name: identity.name, persona: identity.persona, typeId: session.typeId
        }));
        npcs.push({ seat, npcId, name: identity.name, persona: identity.persona });
    }

    const wish = claim?.role ? { seat: Number(claim.seat), role: claim.role } : null;
    const dealt = await mutateSession(app, sid, s => {
        for (const n of npcs) {
            const seat = landOn(s, board, { characterId: n.npcId, name: n.name, kind: 'npc', persona: n.persona, preferred: n.seat });
            if (seat !== null) pushLog(s, `${n.name} 补上了 ${seat} 号座（临时路人）`);
        }
        if ((s.seats || []).length !== board.seats) return false;
        const ok = engine.startGame(s, { claims: wish ? [wish] : [] });
        if (ok) pushLog(s, `人齐了，发牌开局（${s.seats.length} 人）`);
        return ok;
    });

    if (!dealt) {
        renderApp(app, close);
        toast(app, '还差人，凑不齐就开不了');
        return;
    }

    let note = npcs.length ? `${npcs.length} 位临时路人补位，发牌了` : '发牌了，看好你的身份';
    if (wish) {
        // 引擎对兑不出来的许愿是就地作废（不抛错），所以回读一眼那一座真拿到了许的那张才扣水晶；
        // 理论上到不了「没兑上」那一步（选项就是这张板子摊开的），真到了也不能白扣人家一颗
        const landed = (app.session?.seats || []).find(s => s.seat === wish.seat)?.role === wish.role;
        const spent = landed && app.me ? await store.useItem(app.me, store.CRYSTAL, 1) : null;
        if (spent) app.meStat = spent;
        note = landed
            ? `许愿成了，你这一局是${roleLabel(wish.role)}${spent ? '' : '（这颗水晶没扣上）'}`
            : '这一局没许上愿，水晶还在你背包里';
    }

    app.readonly = false;
    resetTransient(app);
    app.page = { name: 'table', typeId: session.typeId, sessionId: sid };
    await refreshTables(app);
    renderApp(app, close);
    toast(app, note);
}

function confirmGiveUp(app, close) {
    if (app.busy) return;
    const session = app.session;
    if (!session) return;
    const isForming = session.status === 'forming';
    const typeId = session.typeId;
    modal(app, {
        title: isForming ? '散掉这一桌？' : '流局？',
        sub: isForming
            ? '这一桌会被撤掉，座位上的安排都会清掉；分类下可以再开新的一桌。'
            : '这一局判为流局：桌上所有人立刻解锁，这一局不算任何人的战绩。',
        actions: [
            { label: isForming ? '散桌并离开' : '确认流局', danger: true, run: async () => {
                if (isForming) {
                    await store.deleteSession(session.id);
                } else {
                    // 流局不是删除：记录留着，只是状态翻过去让所有人解锁
                    await mutateSession(app, session.id, s => {
                        s.status = 'voided';
                        s.voidedAt = Date.now();
                        engine.pushEvent(s, { type: 'end', text: '这一局流局了' });
                        return true;
                    });
                }
                app.session = null;
                app.readonly = false;
                resetTransient(app);
                app.page = { name: 'type', typeId };
                await refreshTables(app);
                renderApp(app, close);
                toast(app, isForming ? '这桌已经撤掉了' : '已流局，桌上的人都解锁了');
            } }
        ]
    });
}

/* ---------------- 小工具 ---------------- */

function toast(app, text) {
    const el = app.root.querySelector('.ww-toast');
    if (!el) return;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(app._toastTimer);
    app._toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

/**
 * 弹层。`closeLabel` 是**底下那颗按钮上写的字**——它要是写的是一个动作（比如「不用，正常发牌」），
 * 那关掉它就得真去做那件事：`onClose` 就是给这种场合留的（只挂底下那颗，动作按钮走各自的 run）。
 */
function modal(app, { title, sub = '', bodyHtml = '', actions = [], closeLabel = '取消', onMount = null, onClose = null }) {
    const mask = document.createElement('div');
    mask.className = 'ww-modal-mask';
    mask.innerHTML = `
        <div class="ww-modal">
            <h3>${esc(title)}</h3>
            ${sub ? `<p class="ww-modal-sub">${esc(sub)}</p>` : ''}
            ${bodyHtml}
            ${actions.map((a, i) => `<button class="ww-choice ${a.danger ? 'danger' : ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}
            <button class="ww-modal-close">${esc(closeLabel)}</button>
        </div>
    `;
    app.root.appendChild(mask);
    mask.querySelectorAll('.ww-choice[data-i]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const a = actions[Number(btn.dataset.i)];
            // 默认「先关弹层、再跑 run」：所以 run 里再去 querySelector 是抓不到的——要用的值
            // 一律在 onMount 里先收进闭包。**标了 keepOpen 的按钮例外**：弹层不关，run 拿到
            // mask 自己把内容换掉（同一块面板就地翻页）。要它是因为「关掉再开一个」中间那段
            // 遮罩整块不在（含背板模糊）⇒ 底下整页会闪一下，见 openHeart。
            if (!a?.keepOpen) mask.remove();
            await a?.run?.(mask);
        });
    });
    mask.querySelector('.ww-modal-close').addEventListener('click', () => { mask.remove(); onClose?.(); });
    onMount?.(mask);
    return mask;
}

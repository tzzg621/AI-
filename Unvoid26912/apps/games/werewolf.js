// apps/games/werewolf.js — 狼人杀（游戏中心接入）
//
// 边界：
// - 规则引擎在 werewolfEngine.js（纯函数），AI 在 werewolfAI.js，存储 in werewolfStore.js。
// - 一局 = 一张 6 人板子；座位上的都是真实角色（路人临时补齐，只进路人池）。
// - 无上帝视角：每次 AI 调用只喂一个角色的视角。
// - 推进方式：玩家点一下走一步，不做全自动。

import { getActiveCharacterId, CharacterStore } from '../../store/CharacterStore.js';
import { getAllCharacterIds, getCharacterNameById } from '../characterManager.js';
import { getAvatarHtml } from '../../store/ImageCache.js';
import { esc } from '../../store/utils.js';
import {
    ROOM_TYPES, getRoomType, getBoard, markTagsOf, buildRulesPage, roleLabel, randomNpcIdentity,
    revealModeOf, revealLabel, tableColumnsOf, BOARDS
} from './werewolfRooms.js';
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
        typeTables: {},       // typeId -> [未结束的桌]
        lockedSession: null,  // 主视角角色正锁在里面的那局（没结束没流局就不能开新桌）
        session: null,        // 当前正在看的桌
        readonly: false,      // 旁观 / 非参与者时为 true
        busy: false,
        wolfPick: null,       // 狼队这一刀我挑的座号（还没提交给队友，只在内存里）
        wolfNote: '',         // 我留给队友的那句话
        inflight: new Map(),  // inviteId -> { characterId, seat, name }：还在飞的邀请
        settling: new Set(),  // 已经认领了结算的那几局（防同一次结束被算两遍战绩）
        meStat: null,         // 主视角自己的档案（「我的」页与手册页读它）
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
        closed: false
    };

    const close = () => {
        if (app.closed) return;
        app.closed = true;
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
        // 散桌：准备态里一个人都没坐、也没有在飞邀请时，就别留着这张空桌
        const s = app.session;
        if (s && s.status === 'forming' && !(s.seats || []).length && !Object.keys(s.reservations || {}).length) {
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

/**
 * 读改写：改动前重读一遍库里的这一局，避免旧的异步结果覆盖新状态
 * （照 textAdventure 的 roundId 比对思路，这里是每次重读 + 落库前判活）
 */
async function mutateSession(app, sessionId, mutator) {
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
 * 一局打完：把这一局的战绩与点亮写进每个座位的档案。
 * 真实角色（名册里的、网络里的、含主视角）走 stats，临时路人走 npcs——两条线同一套字段、同一段累加。
 * 档位不在这里：档位只在落座那一刻生成（见 werewolfAI 的落座测评）。
 * **失败只 warn**：战绩没写上也不该让这一局打不完、界面卡住。
 */
async function settleProfile(session) {
    for (const row of engine.finalResult(session)) {
        const detail = { role: row.role, win: row.win, survived: row.alive, typeId: session.typeId };
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
    const rightBtn = canGiveUp
        ? `<button id="wwGiveUp" aria-label="${name === 'table' ? '流局' : '放弃'}">✕</button>`
        : (isRoot ? `<button id="wwAbout" aria-label="说明">?</button>` : `<span style="width:34px"></span>`);

    return `
        <header class="ww-topbar">
            <button id="wwBack" aria-label="返回">‹</button>
            <div class="ww-brand">
                <small>${subtitle}</small>
                <strong>${esc(title)}</strong>
            </div>
            ${rightBtn}
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
        case 'activity': return renderActivity();
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
        action = mine ? '继续准备' : (seated ? '旁观' : '空桌');
        cls = mine ? '' : 'is-quiet';
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

/* ---------------- 活动 ---------------- */

function renderActivity() {
    return `
        <div class="ww-empty">
            <div style="font-size:28px;">🎁</div>
            <p>活动与道具还在准备中。<br>以后这里会有抽卡、道具与限时玩法。</p>
        </div>
    `;
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
    const byRole = Object.entries(stat?.byRole || {})
        .map(([r, cell]) => `${roleLabel(r)}：${Number(cell?.played) || 0} 局（胜 ${Number(cell?.win) || 0}）`)
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
 * 判定与注入提示词用的是同一个 isLit，所以「手册上亮着的」=「他真拿得到的」。
 */
function renderEntry(entry, record) {
    const lit = codex.isLit(entry, record);
    const cond = lit ? '' : codex.condText(entry.cond);
    return `
        <div class="ww-entry ${lit ? '' : 'is-locked'}">
            <div class="ww-entry-head">
                <strong>${esc(entry.title)}</strong>
                <span class="ww-entry-tier">${esc(codex.ENTRY_TIER_LABEL[entry.tier] || '')}</span>
            </div>
            ${lit ? `<p>${esc(entry.text)}</p>` : `<p class="ww-entry-cond">🔒 ${esc(cond || '还没点亮')}</p>`}
        </div>
    `;
}

/**
 * 手册 = 通用规则一节 + 各房型一节（只列有条例的房型）。
 * 房型那一节的「完整规则」仍走 buildRulesPage（规则正文的唯一出处），这里只加条目层，不重复写规则。
 */
function renderHandbook(app) {
    const record = app.meStat;
    const litCount = codex.litIds(record).length;

    const section = (title, entries, typeId = null) => {
        if (!entries.length) return '';
        return `
            <div class="ww-section-title"><strong>${esc(title)}</strong><span></span></div>
            ${typeId ? `<button class="ww-card ww-rules-card" data-rules-type="${typeId}">
                <div class="ww-card-icon">📜</div>
                <div class="ww-card-main">
                    <div class="ww-card-title">${esc(title)} · 完整规则</div>
                    <div class="ww-card-desc">这一桌怎么打、一夜之间、一个白天、桌上的规矩</div>
                </div>
                <span class="ww-card-go">查看 ›</span>
            </button>` : ''}
            ${entries.map(e => renderEntry(e, record)).join('')}
        `;
    };

    return `
        <div class="ww-line" style="line-height:1.9;">
            <div>已点亮 <strong>${litCount}</strong> / ${codex.ENTRIES.length} 条。</div>
            <div style="color:var(--muted);">灰色的还没亮——条件写在卡片上，坐过、打过自然就有了。</div>
        </div>
        ${section('基础通用规则', codex.entriesIn('common'))}
        ${ROOM_TYPES.map(type => section(type.name, codex.entriesIn(type.typeId), type.typeId)).join('')}
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

/** 该谁动了（高亮用）；夜里是谁在行动是秘密，不标 */
function actingSeat(session) {
    if (session?.status !== 'ongoing') return null;
    if (session.phase === 'day_speak') return engine.currentSpeaker(session)?.seat ?? null;
    if (session.phase === 'day_pk') return engine.currentPkSpeaker(session)?.seat ?? null;
    if (session.phase === 'day_vote') return engine.currentVoter(session)?.seat ?? null;
    if (session.phase === 'day_pk_vote') return engine.currentPkVoter(session)?.seat ?? null;
    // 出局的人走流程时高亮他：**谁出局是公开的**，看不出的是他到底有没有技能
    if (session.phase === 'skill_wait') return engine.currentDeath(session)?.seat ?? null;
    if (session.phase === 'last_words') return engine.currentLastWordSpeaker(session);
    return null;
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
    return `
        <section class="ww-phase">
            <div class="ww-phase-main"><span class="ww-dot"></span><strong>${esc(label)}</strong></div>
            <div class="ww-phase-sub">${esc(`存活 ${alive}/${board.seats} 人`)}${hint ? ` · ${esc(hint)}` : ''}</div>
        </section>
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
            ${view.knifed ? '<p>你今晚被狼刀了，天亮就会出局。</p>' : ''}
        </section>
    `;
}

function renderTableSeat(app, session, seat, mine, over) {
    const isMe = !!mine && seat.seat === mine.seat;
    const dead = seat.alive === false;
    const role = visibleRoleOf(app, session, seat);
    const marks = (session.marks || {})[seat.seat] || [];
    const tags = [
        role ? `<span class="ww-pill ${seat.role === 'werewolf' ? 'wolf' : 'good'}">${esc(role)}</span>` : '',
        ...marks.map(t => `<span class="ww-pill muted">${esc(t)}</span>`)
    ].filter(Boolean).join('');
    // 标记只服务代笔，旁观者用不上；自己也不需要给自己贴
    const canMark = !over && !app.readonly && !isMe;
    return `
        <button class="ww-seat ${isMe ? 'is-me' : ''} ${dead ? 'is-dead' : ''} ${actingSeat(session) === seat.seat ? 'is-turn' : ''}"
                data-mark="${seat.seat}" ${canMark ? '' : 'disabled'}>
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

const FEED_ICON = { death: '⚰️', vote: '🗳️', tally: '📊', verdict: '⚖️', shot: '🔫', flip: '🃏', end: '🏁', wolfchat: '🐺' };

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

/** 复盘期的底部：输入框（打 @ 弹人）+ 自动接话开关 + 发送；旁观与不在座上只给「回列表」 */
function renderReviewComposer(app, session, mine) {
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
    const note = [
        `存活 ${engine.aliveSeats(session).length} 人`,
        session.ai?.template ? '模板模式' : ''
    ].filter(Boolean).join(' · ');

    return `
        ${renderPhaseBar(app, session, board)}
        ${renderIdentityCard(app, session, mine)}
        <div class="ww-section-title">
            <strong>场上</strong>
            <span>${esc(canMark ? `${note} · 点座位贴标记` : note)}</span>
        </div>
        <div class="ww-seats compact${tableColumnsOf(board) === 4 ? ' c4' : ''}">
            ${(session.seats || []).map(s => renderTableSeat(app, session, s, mine, over)).join('')}
        </div>
        ${over ? renderEnding(app, session, mine) : `<div class="ww-section-title"><strong>发言</strong><span>${esc('按座号挨个来')}</span></div>`}
        ${renderFeed(app, session, mine)}
    `;
}

/* ---------------- 对局页：底部动作条 ---------------- */

function renderTableBottom(app) {
    const session = app.session;
    if (!session) return '';
    const mine = mySeatOf(app, session);

    if (isOver(session)) return renderReviewComposer(app, session, mine);
    if (app.busy) {
        return `<footer class="ww-bottom"><button class="primary" disabled>⏳ 等 AI 回话…</button></footer>`;
    }

    // 夜里轮到我：我的身份我自己动手（不想动手就点「让 AI 决定」）
    const duty = myNightDuty(app, session);
    if (duty) return renderNightAct(app, session, mine, duty);

    const speaker = (session.phase === 'day_speak' ? engine.currentSpeaker(session)
        : session.phase === 'day_pk' ? engine.currentPkSpeaker(session) : null);
    const voter = (session.phase === 'day_vote' ? engine.currentVoter(session)
        : session.phase === 'day_pk_vote' ? engine.currentPkVoter(session) : null);
    // 遗言那一拍：队列里当前那个人说最后一段话（用的是同一个发言框，只是提示与落点不同）
    const mourner = session.phase === 'last_words' ? engine.currentDeath(session) : null;
    // 轮到我：发言框 / 投票点选；否则给出「让某位 AI 行动」那一个按钮
    if (speaker && mine && speaker.seat === mine.seat) return renderComposer(app, session);
    if (mourner && mine && mourner.seat === mine.seat) return renderComposer(app, session, 'lastwords');
    if (voter && mine && voter.seat === mine.seat) return renderVoteRow(app, session, mine);

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
        return `
        <footer class="ww-bottom column">
            <div class="ww-hint">这是你的遗言（${mine?.seat || ''} 号）：最后一段公开的话，说给活着的人听。</div>
            <textarea id="wwDraft" class="ww-input" placeholder="你的遗言（不超过 ${limit} 字）">${esc(app.draft || '')}</textarea>
            <div class="ww-composer-row">
                <button id="wwGhost" class="ghost">代笔</button>
                <button id="wwSend" class="primary">说完</button>
            </div>
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

/** 交给 AI 的那个按钮：白天投完票、夜里三步，出处都在这儿（data-delegate 分派） */
function renderDelegate(kind) {
    return `<div class="ww-composer-row"><button id="wwDelegate" class="ghost" data-delegate="${kind}">让 AI 决定</button></div>`;
}

function renderVoteRow(app, session, mine) {
    // PK 台下补投那一轮只能投台上的人；其余时候照旧（同一份合法集：翻过牌的白痴也不在芯片上）
    const pk = session.phase === 'day_pk_vote';
    const targets = pk ? engine.pkVoteTargets(session) : engine.voteTargets(session, mine.seat);
    return `
        <footer class="ww-bottom column">
            <div class="ww-hint">${pk
                ? '轮到你补投了：在他们几位中间点一个（也可以弃票）。'
                : '轮到你投票了：点一个人投他出局，或者弃票。'}</div>
            <div class="ww-vote-row">
                ${targets.map(t => `<button class="ww-mark-chip" data-vote="${t.seat}">${t.seat} 号 ${esc(t.name)}</button>`).join('')}
                <button class="ww-mark-chip" data-vote="0">弃票</button>
            </div>
            ${renderDelegate('vote')}
        </footer>
    `;
}

/**
 * 轮到我动手的夜间行动条，跟投票行同一套手感：点一下就是决定。
 * 只有狼多一步（先挑目标、给队友留一句话，提交之后 AI 队友各自复议）。
 * 目标一律取自 ai.nightTargets——跟 AI 与模板用的是同一个合法集，不会出现点得动却落不下的座号。
 */
function renderNightAct(app, session, mine, kind) {
    const targets = ai.nightTargets(session, kind, mine.seat);
    const nameOf = seatNo => `${seatNo} 号 ${engine.seatAt(session, seatNo)?.name || ''}`;
    const chip = (target, label, active) =>
        `<button class="ww-mark-chip ${active ? 'active' : ''}" data-night="${kind}" data-target="${target}">${esc(label)}</button>`;

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
 */
async function runTurn(app, close, { call, apply }) {
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

    const out = await mutateSession(app, sid, s => {
        if ((s.roundId || 0) !== roundId) return { dropped: true };
        if (willCall) {
            s.callCount = (s.callCount || 0) + 1;
            ai.afterCall(s, { ok: !res?.degraded });
        }
        return { dropped: false, done: !!apply(s, res) };
    });

    renderApp(app, close);
    if (out?.dropped) toast(app, '局面已经往前走了，这次结果作废');
    else if (res?.degraded && !app.session?.ai?.template) toast(app, '这次没等到 AI 回应，先用模板顶上');
    else if (out && out.done === false) toast(app, '这一步没生效，再点一次试试');
    return { res, ...out };
}

/** 发言：一次调用换一段话（PK 台上那一轮走的是同一个入口，落点换成 applyPkSpeech） */
function speakTurn(app, close, seatNo, type) {
    return runTurn(app, close, {
        call: s => ai.speakCharacter({ session: s, seatNo, type }),
        apply: (s, res) => {
            ai.mergeLabels(s, seatNo, res?.marks || {});
            engine.addNote(s,seatNo, { kind: 'speak', text: res?.note });
            // 关注表：这次改了就换，没写就维持（res.watch 是 undefined，不是空数组）
            if (res?.watch) engine.setWatch(s, seatNo, res.watch);
            const text = res?.text || ai.fallbackSpeech(seatNo);
            return s.phase === 'day_pk' ? engine.applyPkSpeech(s, seatNo, text) : engine.applySpeech(s, seatNo, text);
        }
    });
}

/**
 * 遗言：一次调用换最后一段话，落点是 `applyLastWords`（不是普通发言）。
 *
 * **先看有没有现成的**：夜里被刀的猎人早在「猎人」那一拍就顺手写好了白天要说的那段
 * （`session.wordsDraft`，见 applyNightDecision）。公布死讯、轮到他时直接取用，不再打一次调用
 * ——按次数计费，能省一次是一次。取用发生在写库那一趟里（`takeWordsDraft` 顺手清掉，
 * 免得他下辈子还用这段）。
 *
 * AI 没回话就用模板台词顶上：遗言这一拍**不能卡住**，卡住的不是一个人，是整局。
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
        apply: (s, res) => engine.applyLastWords(s, seatNo, res?.text || ai.fallbackSpeech(seatNo))
    });
}

function voteTurn(app, close, seatNo, type) {
    return runTurn(app, close, {
        call: s => ai.voteCharacter({ session: s, seatNo, type }),
        apply: (s, res) => {
            ai.mergeLabels(s, seatNo, res?.marks || {});
            engine.addNote(s,seatNo, { kind: 'vote', text: res?.note });
            // 心声：这一票的副产物，只写不读（留给以后的道具，用户 2026-09-13 定）。
            // 主视角把这一票交给 AI 时走的是同一个入口，同样记上；kind 跟「代笔」那一路一致
            engine.addHeart(s, seatNo, {
                kind: seatNo === mySeatOf(app, s)?.seat ? 'ghost' : 'vote',
                text: res?.heart
            });
            if (res?.watch) engine.setWatch(s, seatNo, res.watch);   // 投票时再决定一次关注
            // PK 台下补投的那一轮走同一个入口：合法集在 AI 层就换成了台上那几位
            const target = res?.vote ?? null;
            return s.phase === 'day_pk_vote' ? engine.applyPkVote(s, seatNo, target) : engine.applyVote(s, seatNo, target);
        }
    });
}

/** 狼队夜里走 wolfPackTurn（一次调用扮演全队）；这里只管 seer / guard / witch / hunter 这几个单座位决策 */
function nightTurn(app, close, kind) {
    if (kind === 'wolf') return packTurn(app, close, { player: null });
    return runTurn(app, close, {
        call: s => ai.nightAction({ session: s, kind }),
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
        // 被刀的那一夜：AI 顺手写好的遗言先收着（公布死讯、轮到他说话时直接取用，省一次调用）
        const woken = engine.hunterWakesTonight(s) === who;
        if (woken && res?.words) engine.setWordsDraft(s, who, res.words);
        return engine.applyHunterNight(s, who, woken ? pick : null)
            || skipNight(s, engine.nextNightPhase(s, 'night_hunter'));
    }
    // 白天补枪那一拍：他刚知道自己被票出局，这一枪只能在队列里开
    return engine.applyHunterShot(s, pick);
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
        if (phase === 'day_verdict') { engine.settleVote(s); return true; }
        // 出局者的流程：换下一个（最后一个走完，这一批才真的散场——天亮，或者入夜）
        if (phase === 'skill_wait') return engine.advanceDeathQueue(s);
        return null;
    });
    renderApp(app, close);
}

/** 玩家自己发言：手打，或者代笔之后发出去（这一步不打 AI）；遗言那一拍走的是同一段话，落点不同 */
async function sendMySpeech(app, close) {
    const session = app.session;
    const mine = mySeatOf(app, session);
    if (!session || !mine || app.busy) return;
    const words = session.phase === 'last_words';
    const text = String(app.draft || '').trim();
    if (!text) { toast(app, words ? '遗言总得写两句，或者让 AI 代笔' : '先打两句，或者让 AI 代笔'); return; }
    // 三种落点：遗言 / PK 台上那一轮 / 普通白天发言——都是同一段话，去处不同
    const ok = await mutateSession(app, session.id, s => (words
        ? engine.applyLastWords(s, mine.seat, text)
        : s.phase === 'day_pk' ? engine.applyPkSpeech(s, mine.seat, text)
            : engine.applySpeech(s, mine.seat, text)));
    app.draft = '';
    renderApp(app, close);
    if (!ok) toast(app, '这一步没生效，再点一次试试');
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
    await mutateSession(app, session.id, s => {
        // 代笔写出来的东西算「AI 替主视角做的判断」，笔记记在**主视角自己**的座位上
        engine.addNote(s, mine.seat, { kind: 'ghost', text: res?.note });
        if (!willCall) return true;
        s.callCount = (s.callCount || 0) + 1;
        ai.afterCall(s, { ok: !res?.degraded });
        return true;
    });
    renderApp(app, close);
    if (!res || res.degraded) toast(app, '代笔没等来回话，草稿原样留着');
    else if (!draft.trim()) toast(app, '代笔写好了，改完再发');
}

/** 玩家自己投票：点选，不打 AI */
async function castMyVote(app, close, target) {
    const session = app.session;
    const mine = mySeatOf(app, session);
    if (!session || !mine || app.busy) return;
    const pick = target === 0 ? null : target;
    const ok = await mutateSession(app, session.id, s => (s.phase === 'day_pk_vote'
        ? engine.applyPkVote(s, mine.seat, pick)
        : engine.applyVote(s, mine.seat, pick)));
    renderApp(app, close);
    if (!ok) toast(app, '这一票没记上，再点一次试试');
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
    if (!session || !mine || app.busy) return;
    if (kind === 'vote') return voteTurn(app, close, mine.seat, getRoomType(session.typeId));
    return nightTurn(app, close, kind);
}

/** 换桌 / 重开 / 离桌时把只在内存里的草稿清干净（跟 app.draft 一个性质，都不落库） */
function resetTransient(app) {
    app.draft = '';
    app.wolfPick = null;
    app.wolfNote = '';
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
 * 主视角的标记（{ 座号: [标签] }）→ 代笔提示词要的 { 座号: '标签·标签' }。
 * 同一个人可以贴多个标签；单标签的写法也认（兼容老数据）。
 */
function marksForPrompt(marks) {
    const out = {};
    for (const [seat, list] of Object.entries(marks || {})) {
        if (Array.isArray(list) && list.length) out[seat] = list.join('·');
        else if (typeof list === 'string' && list) out[seat] = list;
    }
    return out;
}

/**
 * 贴标记：只在代笔那一次调用里起作用，不进任何 AI 角色的提示词。
 * 面板自己刷新，不走整页重渲染（重渲染会把弹窗一起抹掉）。
 */
function openMarkPanel(app, close, seatNo) {
    const session = app.session;
    const mine = mySeatOf(app, session);
    if (!session || app.readonly || !mine || seatNo === mine.seat) return;
    const seat = engine.seatAt(session, seatNo);
    if (!seat) return;

    modal(app, {
        title: `给 ${seat.seat} 号 ${seat.name} 贴标记`,
        sub: '只有你自己看得到，也只在这一局里有效；代笔时 AI 会顺着它写。',
        bodyHtml: `<div class="ww-mark-row" id="wwMarkRow"></div>`,
        onMount: mask => {
            const row = mask.querySelector('#wwMarkRow');
            const paint = () => {
                const cur = (app.session?.marks || {})[seatNo] || [];
                row.innerHTML = markTagsOf(session).map(t => `
                    <button class="ww-mark-chip ${cur.includes(t) ? 'active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>
                `).join('');
                row.querySelectorAll('.ww-mark-chip').forEach(btn => {
                    btn.addEventListener('click', async () => {
                        const tag = btn.dataset.tag;
                        await mutateSession(app, session.id, s => {
                            const all = { ...(s.marks || {}) };
                            const list = all[seatNo] || [];
                            all[seatNo] = list.includes(tag) ? list.filter(x => x !== tag) : [...list, tag];
                            if (!all[seatNo].length) delete all[seatNo];
                            s.marks = all;
                            return true;
                        });
                        paint();
                    });
                });
            };
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

/** 某个座位在某一轮留下的心声；没有就空串（界面上就不画那个小圆点） */
function heartOf(session, seatNo, round) {
    const list = (session?.aiHearts || {})[seatNo] || [];
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
            run: async () => {
                const left = await store.spendCoins(app.me, store.HEART_COST);
                if (left === null) return toast(app, '钻石不够了');
                modal(app, {
                    title: `${who}的心声`,
                    sub: `花掉 ${store.HEART_COST} 钻石 · 还剩 ${left} 颗`,
                    bodyHtml: `<div class="ww-heart-text">${esc(text)}</div>`
                });
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

    root.querySelectorAll('.ww-tab').forEach(btn => {
        btn.addEventListener('click', async () => {
            app.tab = btn.dataset.tab;
            app.page = { name: app.tab };
            await refreshTables(app);
            if (app.tab === 'me') await refreshMe(app);   // 战绩与点亮可能刚被上一局的结算改过
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
    root.querySelectorAll('.ww-seat[data-mark]').forEach(btn => {
        btn.addEventListener('click', () => openMarkPanel(app, close, Number(btn.dataset.mark)));
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
    root.querySelectorAll('.ww-mark-chip[data-night]').forEach(btn => {
        // data-act 是女巫那两排药用的（救/毒/不用，一个座号分不出是哪种）；没有它的芯片走原路
        const target = btn.dataset.target ? Number(btn.dataset.target) : null;
        btn.addEventListener('click', () => onNightChip(app, close, btn.dataset.night, target, btn.dataset.act || ''));
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
    app.readonly = !iAmIn(existing, app);
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
    if (app.busy || app.readonly || !app.session) return;
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

    const dealt = await mutateSession(app, sid, s => {
        for (const n of npcs) {
            const seat = landOn(s, board, { characterId: n.npcId, name: n.name, kind: 'npc', persona: n.persona, preferred: n.seat });
            if (seat !== null) pushLog(s, `${n.name} 补上了 ${seat} 号座（临时路人）`);
        }
        if ((s.seats || []).length !== board.seats) return false;
        const ok = engine.startGame(s);
        if (ok) pushLog(s, `人齐了，发牌开局（${s.seats.length} 人）`);
        return ok;
    });

    if (!dealt) {
        renderApp(app, close);
        toast(app, '还差人，凑不齐就开不了');
        return;
    }

    app.readonly = false;
    resetTransient(app);
    app.page = { name: 'table', typeId: session.typeId, sessionId: sid };
    await refreshTables(app);
    renderApp(app, close);
    toast(app, npcs.length ? `${npcs.length} 位临时路人补位，发牌了` : '发牌了，看好你的身份');
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

function modal(app, { title, sub = '', bodyHtml = '', actions = [], onMount = null }) {
    const mask = document.createElement('div');
    mask.className = 'ww-modal-mask';
    mask.innerHTML = `
        <div class="ww-modal">
            <h3>${esc(title)}</h3>
            ${sub ? `<p class="ww-modal-sub">${esc(sub)}</p>` : ''}
            ${bodyHtml}
            ${actions.map((a, i) => `<button class="ww-choice ${a.danger ? 'danger' : ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}
            <button class="ww-modal-close">取消</button>
        </div>
    `;
    app.root.appendChild(mask);
    mask.querySelectorAll('.ww-choice[data-i]').forEach(btn => {
        btn.addEventListener('click', async () => {
            mask.remove();
            await actions[Number(btn.dataset.i)]?.run?.();
        });
    });
    mask.querySelector('.ww-modal-close').addEventListener('click', () => mask.remove());
    onMount?.(mask);
    return mask;
}

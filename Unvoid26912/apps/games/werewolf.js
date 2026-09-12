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
    ROOM_TYPES, getRoomType, getBoard, MARK_TAGS, buildRulesPage, roleLabel, randomNpcIdentity,
    revealModeOf, revealLabel
} from './werewolfRooms.js';
import * as store from './werewolfStore.js';
import * as engine from './werewolfEngine.js';
import * as ai from './werewolfAI.js';

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
        closed: false
    };

    const close = () => {
        if (app.closed) return;
        app.closed = true;
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
    renderApp(app, close);
}

/* ---------------- 返回 ---------------- */

function handleBack(app, close) {
    const name = app.page.name;
    if (name === 'type' || name === 'room' || name === 'rules' || name === 'table' || name === 'spectate') {
        leaveSubPage(app, close);
        return;
    }
    close();
}

async function leaveSubPage(app, close) {
    const page = app.page;
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
    // 从桌/规则页回分类页，从分类页回首页
    app.page = page.name === 'type'
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
}

function tablesOf(app, typeId) {
    return app.typeTables[typeId] || [];
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
    await store.saveSession(fresh);
    if (app.session?.id === sessionId) app.session = fresh;
    return out === undefined ? fresh : out;
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
    if (['rooms', 'activity', 'me'].includes(name)) {
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
    `;
}

function renderRulesCard() {
    return `
        <button class="ww-card ww-rules-card" id="wwOpenRules">
            <div class="ww-card-icon">📖</div>
            <div class="ww-card-main">
                <div class="ww-card-title">规则与角色</div>
                <div class="ww-card-desc">6 人板子怎么打、各角色的能力、胜负条件</div>
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
                <div class="ww-card-meta">${seated}/${board.seats} 人${holding ? ` · ${holding} 个邀请在路上` : ''}${session.status === 'forming' ? '' : ` · 第 ${session.round || 1} 天`}</div>
            </div>
            <span class="ww-card-go">${action} ›</span>
        </button>
    `;
}

/* ---------------- 活动 / 我的（占位） ---------------- */

function renderActivity() {
    return `
        <div class="ww-empty">
            <div style="font-size:28px;">🎁</div>
            <p>活动与道具还在准备中。<br>以后这里会有抽卡、道具与限时玩法。</p>
        </div>
    `;
}

function renderMe(app) {
    return `
        <div class="ww-empty">
            <div style="font-size:28px;">👤</div>
            <p>${esc(app.meName)} 的个人信息页还没开放。<br>对局数据已经在记录（局数、胜负、各身份战绩）。</p>
        </div>
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
 * 夜里这一步该不该我亲手做：'guard' | 'wolf' | 'seer' | 'hunter' | null（不属于我就交给 AI）。
 * 只看「阶段 + 我在这一局里的身份」，**不能拿 ai.defaultActor 比对**——狼永远返回座号最小的活狼，
 * 坐在 4 号的狼玩家会永远轮不到自己动手。
 * 猎人那一条必须在「我还活着」之前判：轮到他开枪的时候他已经出局了。
 */
function myNightDuty(app, session) {
    if (!session || app.readonly || isOver(session)) return null;
    const mine = mySeatOf(app, session);
    if (!mine) return null;
    if (session.phase === 'hunter_shot') return session.pendingShot?.seat === mine.seat ? 'hunter' : null;
    if (mine.alive === false) return null;
    if (session.phase === 'night_guard') return mine.role === 'guard' ? 'guard' : null;
    if (session.phase === 'night_wolf') return mine.role === 'werewolf' ? 'wolf' : null;
    if (session.phase === 'night_seer') return mine.role === 'seer' ? 'seer' : null;
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
    // 明牌局：出局就公开身份（流水里已经公告过，围观的人也看得到）
    if (revealModeOf(session) === 'open' && seat.alive === false) return roleLabel(seat.role);
    if (mine && mine.role === 'werewolf' && seat.role === 'werewolf') return roleLabel(seat.role); // 狼看同伴
    return '';
}

/** 该谁动了（高亮用）；夜里是谁在行动是秘密，不标 */
function actingSeat(session) {
    if (session?.status !== 'ongoing') return null;
    if (session.phase === 'day_speak') return engine.currentSpeaker(session)?.seat ?? null;
    if (session.phase === 'day_vote') return engine.currentVoter(session)?.seat ?? null;
    if (session.phase === 'hunter_shot') return session.pendingShot?.seat ?? null;
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
        case 'night_resolve': return '等天亮';
        case 'dawn': return '天亮了';
        case 'day_speak': {
            const seat = engine.currentSpeaker(session);
            return seat ? (isMine(seat) ? '轮到你发言' : `轮到 ${at(seat)} 发言`) : '';
        }
        case 'day_vote': {
            const seat = engine.currentVoter(session);
            const votes = session.votes || {};
            const progress = `（${Object.keys(votes).length}/${engine.aliveSeats(session).length}）`;
            // 票是静默的：投过之后流里看不到自己那一票，进度只能靠这里给
            if (!seat) return '等开票';
            if (isMine(seat)) return `轮到你投票${progress}`;
            if (mine && Object.prototype.hasOwnProperty.call(votes, mine.seat)) return `你已投票，等其他人${progress}`;
            return `轮到 ${at(seat)} 投票${progress}`;
        }
        case 'day_verdict': return '等开票';
        case 'hunter_shot': {
            if (myNightDuty(app, session) === 'hunter') return '轮到你决定开不开枪';
            return `${session.pendingShot ? at(session.pendingShot) : '猎人'} 要开枪`;
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
                <span class="ww-seat-sub">${dead ? '已出局' : '存活'}${seat.kind === 'npc' ? ' · 路人' : ''}</span>
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
    if (!events.length) return `<div class="ww-empty">还没发生什么</div>`;
    return events.map(ev => {
        if (ev.type === 'speak') {
            const seat = engine.seatAt(session, ev.seat);
            const body = String(ev.text || '').replace(/^\d+ 号 [^：]*：/, '');
            const isMine = !!mine && ev.seat === mine.seat;
            return `
                <div class="ww-line ${isMine ? 'mine' : ''}">
                    <div class="ww-line-head">
                        ${avatarHtml(seat?.characterId, seat?.name || '')}
                        <strong>${esc(`${ev.seat} 号 ${seat?.name || ''}`)}</strong>
                        ${isMine ? '<span class="ww-dot"></span>' : ''}
                    </div>
                    <div class="ww-line-body">${esc(body)}</div>
                </div>
            `;
        }
        const night = ev.type === 'system' && /夜/.test(ev.text || '');
        const whisper = ev.isPublic === false;
        const icon = FEED_ICON[ev.type] || '';
        return `<div class="ww-line system ${night ? 'night' : ''} ${whisper ? 'whisper' : ''}">${icon ? `${icon} ` : ''}${esc(ev.text || '')}</div>`;
    }).join('');
}

const FEED_ICON = { death: '⚰️', vote: '🗳️', tally: '📊', verdict: '⚖️', shot: '🔫', end: '🏁', wolfchat: '🐺' };

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
        <div class="ww-seats compact">
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

    if (isOver(session)) {
        return `<footer class="ww-bottom"><button id="wwLeaveTable" class="primary">回房间列表</button></footer>`;
    }
    if (app.busy) {
        return `<footer class="ww-bottom"><button class="primary" disabled>⏳ 等 AI 回话…</button></footer>`;
    }

    // 夜里轮到我：我的身份我自己动手（不想动手就点「让 AI 决定」）
    const duty = myNightDuty(app, session);
    if (duty) return renderNightAct(app, session, mine, duty);

    const speaker = session.phase === 'day_speak' ? engine.currentSpeaker(session) : null;
    const voter = session.phase === 'day_vote' ? engine.currentVoter(session) : null;
    // 轮到我：发言框 / 投票点选；否则给出「让某位 AI 行动」那一个按钮
    if (speaker && mine && speaker.seat === mine.seat) return renderComposer(app, session);
    if (voter && mine && voter.seat === mine.seat) return renderVoteRow(app, session, mine);

    const act = label => `<footer class="ww-bottom"><button id="wwAct" class="primary">${esc(label)}</button></footer>`;
    const advance = label => `<footer class="ww-bottom"><button id="wwAdvance" class="primary">${esc(label)}</button></footer>`;
    switch (session.phase) {
        // 文案不随存活状态变：守卫不在世时这一步点一下就过去，按钮换个说法等于公告「守卫死了」
        case 'night_guard': return act('让守卫守护');
        case 'night_wolf': return act('让狼队行动');
        case 'night_seer': return act('让预言家验人');
        case 'night_resolve': return advance('公布今晚的结果');
        case 'dawn': return advance(`开始第 ${session.round || 1} 天`);
        case 'day_speak': return speaker ? act(`让 ${speaker.seat} 号 ${speaker.name} 发言`) : '';
        case 'day_vote': return voter ? act(`让 ${voter.seat} 号 ${voter.name} 投票`) : '';
        case 'day_verdict': return advance('开票');
        case 'hunter_shot': {
            const p = session.pendingShot;
            return act(p ? `让 ${p.seat} 号 ${p.name} 开枪` : '让猎人开枪');
        }
        default: return '';
    }
}

function renderComposer(app, session) {
    const limit = getRoomType(session.typeId)?.speechLimit || 120;
    const hasMarks = Object.keys(marksForPrompt(session.marks)).length > 0;
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
    const targets = engine.aliveSeats(session).filter(s => s.seat !== mine.seat);
    return `
        <footer class="ww-bottom column">
            <div class="ww-hint">轮到你投票了：点一个人投他出局，或者弃票。</div>
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

    return `
        <footer class="ww-bottom column">
            <div class="ww-hint">你出局了：可以带走一个人，也可以弃枪。</div>
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

/** 发言：一次调用换一段话；AI 顺手贴的判断只回灌它自己 */
function speakTurn(app, close, seatNo, type) {
    return runTurn(app, close, {
        call: s => ai.speakCharacter({ session: s, seatNo, type }),
        apply: (s, res) => {
            ai.mergeLabels(s, seatNo, res?.marks || {});
            engine.addNote(s,seatNo, { kind: 'speak', text: res?.note });
            return engine.applySpeech(s, seatNo, res?.text || ai.fallbackSpeech(seatNo));
        }
    });
}

function voteTurn(app, close, seatNo, type) {
    return runTurn(app, close, {
        call: s => ai.voteCharacter({ session: s, seatNo, type }),
        apply: (s, res) => {
            ai.mergeLabels(s, seatNo, res?.marks || {});
            engine.addNote(s,seatNo, { kind: 'vote', text: res?.note });
            return engine.applyVote(s, seatNo, res?.vote ?? null);
        }
    });
}

/** 狼队夜里走 wolfPackTurn（一次调用扮演全队）；这里只管 seer / guard / hunter 这三个单座位决策 */
function nightTurn(app, close, kind) {
    if (kind === 'wolf') return packTurn(app, close, { player: null });
    return runTurn(app, close, {
        call: s => ai.nightAction({ session: s, kind }),
        apply: (s, res) => {
            // 笔记先记（此时阶段还没推走，defaultActor 拿到的就是刚刚行动的那个人）
            engine.addNote(s, ai.defaultActor(s, kind), { kind, text: res?.note });
            return applyNightDecision(s, kind, res?.target ?? null);
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
function applyNightDecision(s, kind, target) {
    const who = ai.defaultActor(s, kind);
    const legal = ai.nightTargets(s, kind, who);
    const pick = legal.includes(target) ? target : (ai.templateNightTarget(s, kind, who) ?? null);
    if (kind === 'wolf') return engine.applyWolfKill(s, pick) || skipNight(s, 'night_resolve');
    if (kind === 'seer') return engine.applySeerCheck(s, who, pick) || skipNight(s, 'night_resolve');
    // 守卫推的是 night_wolf（他后面才是狼），别推 night_resolve——那会把狼的一夜跳过去
    if (kind === 'guard') return engine.applyGuard(s, who, pick) || skipNight(s, 'night_wolf');
    return engine.applyHunterShot(s, pick);
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
    if (session.phase === 'hunter_shot') return nightTurn(app, close, 'hunter');
    if (session.phase === 'day_speak') {
        const seat = engine.currentSpeaker(session);
        return seat ? speakTurn(app, close, seat.seat, type) : undefined;
    }
    if (session.phase === 'day_vote') {
        const seat = engine.currentVoter(session);
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
            s.phase = 'night_wolf';
            return true;
        }
        // 预言家不在世时的 night_seer：阶段照走，点一下就过去
        if (phase === 'night_seer') {
            if (engine.seatsOfRole(s, 'seer').some(x => x.alive !== false)) return null;
            s.phase = 'night_resolve';
            return true;
        }
        if (phase === 'dawn') return engine.startDay(s);
        if (phase === 'day_verdict') { engine.settleVote(s); return true; }
        return null;
    });
    renderApp(app, close);

    // 暗牌局：技能的决策并进这一拍——不停在「猎人开枪」阶段，免得阶段条与按钮把死者身份说破。
    // 明牌局照旧分步。例外：死者就是玩家自己时必须停下来让他决定（这一步只有他自己看得见，
    // 他本来就知道自己的底牌；不停下来他就永远没机会开枪）。
    const now = app.session;
    const mineNow = mySeatOf(app, now);
    if (out && now && now.pendingShot && revealModeOf(now) !== 'open'
        && now.pendingShot.seat !== mineNow?.seat) {
        return nightTurn(app, close, 'hunter');
    }
}

/** 玩家自己发言：手打，或者代笔之后发出去（这一步不打 AI） */
async function sendMySpeech(app, close) {
    const session = app.session;
    const mine = mySeatOf(app, session);
    if (!session || !mine || app.busy) return;
    const text = String(app.draft || '').trim();
    if (!text) { toast(app, '先打两句，或者让 AI 代笔'); return; }
    const ok = await mutateSession(app, session.id, s => engine.applySpeech(s, mine.seat, text));
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
        res = await ai.ghostwrite({
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
    const ok = await mutateSession(app, session.id, s => engine.applyVote(s, mine.seat, target === 0 ? null : target));
    renderApp(app, close);
    if (!ok) toast(app, '这一票没记上，再点一次试试');
}

/**
 * 夜间选人条的点击总入口。
 * 「不是我的回合就静默返回」同时挡掉三种噪声：双击的第二下、别人已经推进过、托管之后残留的点击。
 */
function onNightChip(app, close, kind, target) {
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
    return actMyNight(app, close, kind, target);
}

/** 守卫守人 / 预言家验人 / 猎人开枪 / 独狼下刀：点一下就是决定，不打 AI */
async function actMyNight(app, close, kind, target, note = '') {
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
                row.innerHTML = MARK_TAGS.map(t => `
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

/* ---------------- 事件绑定 ---------------- */

function bindApp(app, close) {
    const root = app.root;
    root.querySelector('#wwBack')?.addEventListener('click', () => handleBack(app, close));
    root.querySelector('#wwAbout')?.addEventListener('click', () => toast(app, '狼人杀 · 6 人标准板'));
    root.querySelector('#wwGiveUp')?.addEventListener('click', () => confirmGiveUp(app, close));

    root.querySelectorAll('.ww-tab').forEach(btn => {
        btn.addEventListener('click', async () => {
            app.tab = btn.dataset.tab;
            app.page = { name: app.tab };
            await refreshTables(app);
            renderApp(app, close);
        });
    });

    root.querySelector('#wwOpenRules')?.addEventListener('click', () => {
        app.page = { name: 'rules', typeId: app.page.typeId || null };
        renderApp(app, close);
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
        btn.addEventListener('click', () => onNightChip(app, close, btn.dataset.night, Number(btn.dataset.target)));
    });
    root.querySelector('#wwNote')?.addEventListener('input', e => { app.wolfNote = e.target.value; });
    root.querySelector('#wwSubmit')?.addEventListener('click', () => submitWolfPlan(app, close, { pick: app.wolfPick, note: app.wolfNote }));
    root.querySelector('#wwDelegate')?.addEventListener('click', e => delegateMyTurn(app, close, e.currentTarget.dataset.delegate));
}

/** 进已有的桌：准备中 → 准备页；已开局 → 牌桌（参与）或旁观页 */
async function enterTable(app, close, sessionId) {
    const existing = (app.typeTables && Object.values(app.typeTables).flat())
        ? Object.values(app.typeTables).flat().find(s => s.id === sessionId)
        : null;
    if (!existing) { toast(app, '这一桌不在了'); return; }
    app.session = existing;
    app.readonly = !iAmIn(existing, app);
    resetTransient(app);

    if (existing.status === 'forming') {
        app.page = { name: 'room', typeId: existing.typeId, sessionId: existing.id };
        // 重进桌：把没有对应在飞邀请的预留放掉
        const freed = await mutateSession(app, existing.id, s => releaseOrphanReservations(app, s));
        if (freed) await refreshTables(app);
    } else {
        app.page = { name: app.readonly ? 'spectate' : 'table', typeId: existing.typeId, sessionId: existing.id };
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
        if (res.reply) pushLog(s, `${name}：${res.reply}`);
        const react = res.reaction && res.reaction !== '沉默' ? `——「${res.reaction}」` : '';
        pushLog(s, `${name} 坐到了 ${seat} 号座${react}`);
        if (res.degraded) pushLog(s, `（${name} 那边没有响应，先按模板入场）`);
    });

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

    await mutateSession(app, sid, s => {
        s.callCount = (s.callCount || 0) + 1;
        let landed = 0;
        for (const item of order) {
            const who = picked.find(c => c.id === item.characterId);
            const seat = landOn(s, board, { characterId: item.characterId, name: who.name, preferred: item.seat });
            if (seat === null) continue;
            landed += 1;
            const react = item.reaction && item.reaction !== '沉默' ? `——「${item.reaction}」` : '';
            pushLog(s, `${who.name} 坐到了 ${seat} 号座${react}`);
        }
        pushLog(s, res.degraded
            ? `${app.meName} 匹配到 ${landed} 个人（这次没等到 AI 回应，先按模板入座）`
            : `${app.meName} 匹配到 ${landed} 个人`);
    });

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
        const npcId = store.newNpcId();
        await store.saveNpc({
            npcId, name: identity.name, persona: identity.persona,
            games: 0, wins: 0, typeId: session.typeId, createdAt: Date.now()
        });
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

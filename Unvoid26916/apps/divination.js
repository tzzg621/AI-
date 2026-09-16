// apps/divination.js — 占卜屋（签筒每日一签 + 塔罗单张/三张 + 占卜手记）
// 世界观红线（AI/07）：占卜人与记录归属 = 当前主视角角色；无「用户/使用者」主语；文案不迎合。
// 解读：本地即时解读（内容库 apps/divinationContent.js）保持默认；v1.1 起塔罗解读后可另请
//   「占卜师」做 AI 细解（占卜师注册表/提示词在 divinationContent.js）：解读尾部名片 →
//   store/AITaskManager.js 任务中心（type='divination'）→ 产物落 record.payload.ai（快照，
//   与牌局同存；attachTarotAi 事务化回写）。签筒不做细解，保持纯本地。
//   细解入口两处：翻牌完成当下（tarot-flow done 态）+ 手记详情（未解记录可补解）；
//   已解记录永不出现入口（不重解，防重复消耗）。
// 存储：store/DivinationStore.js（divinationDB / records，payload 引用化——签/牌只存键
//   stickId、cardNo+orientation+posKey，不落正文副本；回看/列表经内容库现查，修订优先。
//   ownerNameSnapshot、payload.ai 照存：归属显示名 + AI 动态产物（本体唯一一份）。
// 每日一签门禁：本地时区 dateKey 字符串比较，每角色每天一签；渲染层不出现入口 + 动作层落库前
//   异步重查，双保险。
// 页面：home | sign-result（摇签后沉浸回看）| tarot-flow（选阵→问题→翻牌→自动落库）|
//       history（手记列表）| record（单条详情/删除，recordBackTo 决定返回点）。
// 异步渲染约定：同步出骨架，挂载点回填；每次回填/延时链带 pageGen + isConnected 双守卫，
//   模块被重渲染/离开后旧任务自然作废。AI 细解回写后「就地补 DOM」用状态比对
//   （page+recordId）而非 pageGen——跨路由重进不递增 pageGen，故不可单独作守卫。

import { MAJOR_ARCANA, STICKS, STICK_LEVELS, SPREADS, ORIENTATION_LABEL, expandTarotCards, stickById, buildSingleReading, buildThreeReading, getDefaultDiviner, getDivinerStyle, buildDivinerUserText, splitAiText } from './divinationContent.js';
import { getActiveCharacterId } from '../store/CharacterStore.js';
import { getCharacterNameById } from './characterManager.js';
import { esc } from '../store/utils.js';
import { showConfirm } from '../store/dialog.js';
import { addRecord, createRecordId, getRecord, listByOwner, deleteRecord, attachTarotAi } from '../store/DivinationStore.js';
import { callAIWithMessages, hasApiKey } from './aiService.js';
import { taskManager } from '../store/AITaskManager.js';

export const id = 'divination';
export const label = '占卜屋';
export const icon = '🔮';
export const color = '#7B5EA7';

const HISTORY_LIST_LIMIT = 50;
const HOME_PREVIEW_LIMIT = 5;
const SIGN_LIST_LIMIT = 31;      // 31 天足够找到「今日」这一条（每角色每天最多一条）
const MAX_QUESTION_LEN = 80;
const QUESTION_MAX_HINT = '问题请控制在 80 字以内。';

const SHAKE_HOLD_MS = 950;       // 与 .dv-shake 关键帧时长一致（0.9s）
const FLIP_MS = 620;             // 与 .dv-card-inner transition 一致
const PAUSE_AFTER_FLIP_MS = 430;

const KIND_ICON = { sign: '🪷', 'tarot-one': '🃏', 'tarot-three': '🃏' };

const LEVEL_LABEL_MAP = Object.fromEntries(STICK_LEVELS.map(item => [item.key, item.label]));

const AI_TIMEOUT_MS = 120000;   // 与 aiService callAIForStory 超时一致
const AI_NO_KEY_HINT = 'AI 服务还没配好——先到「设置 → API」填好密钥，星语者才点得亮灯。';

// ============================================================
// 模块状态
// ============================================================

const view = {
    page: 'home',            // home | sign-result | tarot-flow | history | record
    recordId: null,          // record / sign-result 正在展示的记录 id
    recordBackTo: 'home'     // record 页返回点：history | home
};

const tarot = {
    spread: 'single',
    question: '',
    savedRecordId: null
};

// AI 细解提交中锁（recordId → true）。只存内存：刷新即清空 = 自愈（刷新打断的任务
// 会被任务中心标 failed 且不触发 onError，重进详情页卡片回到未解态可重试）。
const aiPending = new Map();

let flowBusy = false;
let pageGen = 0;
let currentContainer = null;
let currentGlobalState = null;

const boundPageRoots = new WeakSet();
const recentToast = { el: null, timer: null };

// ============================================================
// 小工具
// ============================================================

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function localDateKey() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toast(message) {
    if (recentToast.el) recentToast.el.remove();
    if (recentToast.timer) clearTimeout(recentToast.timer);

    const el = document.createElement('div');
    el.className = 'dv-toast';
    el.textContent = message;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('dv-toast-show'));

    recentToast.el = el;
    recentToast.timer = setTimeout(() => {
        el.classList.remove('dv-toast-show');
        setTimeout(() => el.remove(), 220);
        recentToast.el = null;
        recentToast.timer = null;
    }, 2100);
}

function getCurrentActorId() {
    const directId = currentGlobalState?.activeCharacter?.id;
    if (directId && directId !== 'unknown') return directId;

    const resolvedId = getActiveCharacterId(currentGlobalState);
    return resolvedId && resolvedId !== 'unknown' ? resolvedId : null;
}

function getActorName(actorId) {
    return getCharacterNameById(actorId) || actorId || '角色';
}

function pickRandom(list) {
    return list[Math.floor(Math.random() * list.length)];
}

function getLevelLabel(levelKey) {
    return LEVEL_LABEL_MAP[levelKey] || levelKey;
}

// 任务守卫：页面代号没变、模块还在 DOM 里才算数
function isTaskAlive(startGen) {
    return pageGen === startGen
        && currentContainer
        && currentContainer.isConnected;
}

function getPageRoot() {
    return currentContainer?.querySelector('.dv-page') || null;
}

// ============================================================
// 重渲染（模块内页面切换统一走这里）
// ============================================================

function rerender() {
    pageGen += 1;
    flowBusy = false;
    currentContainer.innerHTML = renderPage();
    bindEvents(currentContainer, { globalState: currentGlobalState });
}

// ============================================================
// 骨架渲染
// ============================================================

function pageShell(innerHtml) {
    // data-dv-page 标记页面形态，供 divination.css 用 :has() 在子页把整条
    // 全局返回栏 #topBar 让位（同 bookClub.css 先例）——子页返回由内容区自画 ← 承担。
    return `
        <section class="screen-page dv-page" data-dv-page="${view.page}">
            <div class="screen-header">
                <div class="screen-title">占卜屋</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                ${innerHtml}
            </div>
        </section>
    `;
}

function subnav(title, note) {
    return `
        <div class="dv-subnav">
            <button class="dv-back-btn" data-action="back" title="返回">←</button>
            <div class="dv-subnav-title">${esc(title)}</div>
            ${note ? `<div class="dv-subnav-note">${esc(note)}</div>` : ''}
        </div>
    `;
}

function loaderHtml(text) {
    return `<div class="dv-loading">${esc(text || '正在翻阅…')}</div>`;
}

const LOADER_SIGN = '正在问询签筒…';

function pageHomeHtml() {
    const actorId = getCurrentActorId();

    if (!actorId) {
        return pageShell(`
            <div class="dv-no-actor">
                占卜总要有问卜之人——先到角色名册把主视角切换到一位角色，<br>
                再来摇签问牌。签与牌的记录，都会记在角色名下。
            </div>
        `);
    }

    const actorName = getActorName(actorId);

    return pageShell(`
        <div class="dv-intro">
            <div class="dv-intro-icon">🔮</div>
            <div>
                <h2>占卜屋</h2>
                <p>签与牌皆有回应；占卜记录只与问卜的角色相关。</p>
            </div>
        </div>
        <div class="dv-actor-row">问卜之人 · <strong>${esc(actorName)}</strong></div>

        <section class="dv-sec">
            <div class="dv-sec-title"><span>每日一签</span></div>
            <div class="dv-card-box dv-sign-zone" id="dvSignZone">${loaderHtml(LOADER_SIGN)}</div>
        </section>

        <div class="dv-entries">
            <button class="dv-entry" data-action="dv-tarot">
                <div class="dv-entry-icon">🃏</div>
                <div class="dv-entry-main">
                    <div class="dv-entry-title">塔罗启示</div>
                    <div class="dv-entry-desc">单张「当下启示」· 三张「过去 · 现在 · 未来」</div>
                </div>
                <div class="dv-entry-chevron">›</div>
            </button>
        </div>

        <section class="dv-sec">
            <div class="dv-sec-title">
                <span>占卜手记</span>
                <button class="dv-link-btn" data-action="dv-history">全部 ›</button>
            </div>
            <div id="dvHistoryZone" class="dv-record-list dv-mini">${loaderHtml('正在翻开手记…')}</div>
        </section>
    `);
}

function pageSignResultHtml() {
    return pageShell(`
        <div class="dv-subnav">
            <button class="dv-back-btn" data-action="back" title="返回">←</button>
            <div class="dv-subnav-title">签文</div>
            <div class="dv-subnav-note">今日一签</div>
        </div>
        <div id="dvSignBody">${loaderHtml('正在展开签文…')}</div>
    `);
}

function pageTarotFlowHtml() {
    const spread = SPREADS[tarot.spread];
    const questionLen = [...tarot.question].length;
    const over = questionLen > MAX_QUESTION_LEN;

    return pageShell(`
        ${subnav('塔罗启示', spread.title)}
        <div class="dv-flow-body">
            <div class="dv-spread-options">
                <button class="dv-spread-card ${tarot.spread === 'single' ? 'on' : ''}" data-dv-spread="single">
                    单张<small>当下启示</small>
                </button>
                <button class="dv-spread-card ${tarot.spread === 'three' ? 'on' : ''}" data-dv-spread="three">
                    三张<small>过去 · 现在 · 未来</small>
                </button>
            </div>

            <div id="dvQuestionBox" class="dv-question-box" style="${tarot.spread === 'three' ? '' : 'display:none'}">
                <textarea id="dvQuestionInput" rows="2"
                    placeholder="想问什么？（选填，80 字以内）">${esc(tarot.question)}</textarea>
                <div class="dv-char-count ${over ? 'over' : ''}" id="dvQCount">${questionLen}/${MAX_QUESTION_LEN}</div>
            </div>

            <div class="dv-flow-actions">
                <button class="dv-btn dv-ghost-btn" data-action="dv-cancel">取消</button>
                <button class="dv-btn dv-primary-btn" data-action="dv-tarot-deal">洗牌 · 开牌</button>
            </div>

            <div class="dv-spread" id="dvTarotArea"></div>
            <div class="dv-tarot-reading" id="dvTarotRead"></div>
        </div>
    `);
}

function pageHistoryHtml() {
    return pageShell(`
        ${subnav('占卜手记')}
        <div id="dvHistoryList" class="dv-record-list">${loaderHtml('正在翻开手记…')}</div>
    `);
}

function pageRecordHtml() {
    return pageShell(`
        ${subnav('占卜记录')}
        <div id="dvRecordWrap">
            <div class="dv-detail-header" id="dvRecordHeader"></div>
            <div id="dvRecordBody">${loaderHtml('正在展开记录…')}</div>
            <div class="dv-delete-row" id="dvDeleteRow">
                <button class="dv-btn dv-danger-btn" data-action="dv-del-record">删除这条记录</button>
            </div>
        </div>
    `);
}

function renderPage() {
    switch (view.page) {
        case 'sign-result': return pageSignResultHtml();
        case 'tarot-flow': return pageTarotFlowHtml();
        case 'history': return pageHistoryHtml();
        case 'record': return pageRecordHtml();
        default: return pageHomeHtml();
    }
}

export function render(context = {}) {
    currentGlobalState = context.globalState || currentGlobalState;
    return renderPage();
}

// ============================================================
// 解读段 HTML 组装（直播与回看共用同一来源，保证措辞一致）
// ============================================================

function readingPartsHtml(parts) {
    const clsMap = { head: 'dv-rp-head', pos: 'dv-rp-pos', meaning: 'dv-rp-meaning', advice: 'dv-rp-advice', note: 'dv-rp-note' };
    return parts
        .map(part => `<p class="dv-reading-p ${clsMap[part.cls] || ''} in">${esc(part.text)}</p>`)
        .join('');
}

function poemPaperHtml(poem) {
    return `
        <div class="dv-poem-paper">
            ${(poem || []).map(line => `<span class="dv-poem-line">${esc(line)}</span>`).join('')}
        </div>
    `;
}

// 签记录 → 阅读正文（摇签结果页 / 手记详情共用）
// payload 引用态只存 stickId——签文/白话/指引经内容库现查（修订优先）；条目找不到按缺失兜底。
function signReadingHtml(payload) {
    const stick = stickById(payload && payload.stickId);
    if (!stick) {
        return `<div class="dv-empty">这条签文的内容已不在签谱里了。</div>`;
    }
    const parts = [
        { cls: 'meaning', text: stick.plain },
        { cls: 'advice', text: stick.guidance }
    ];
    return `${poemPaperHtml(stick.poem)}<div class="dv-reading">${readingPartsHtml(parts)}</div>`;
}

// 塔罗记录 → 阅读正文（用与直播相同的组合函数，payload 引用态经 expandTarotCards
// 现查内容库展开成完整牌，文案修订历史同步生效）。尾部按解态续接：已解 → 解文卡；
// 未解 → 占卜师名片（详情页第二入口，cards 空无名片）
function tarotReadingHtml(record) {
    const payload = record.payload || {};
    const ownerName = record.ownerNameSnapshot || '你';
    const cards = expandTarotCards(payload);

    const parts = payload.spread === 'three'
        ? buildThreeReading({ ownerName, question: payload.question || '', cards })
        : buildSingleReading({
            ownerName,
            name: cards[0]?.name || '牌',
            orientation: cards[0]?.orientation || 'upright',
            meaning: cards[0]?.meaning || '',
            advice: cards[0]?.advice || ''
        });

    const base = `<div class="dv-reading">${readingPartsHtml(parts)}</div>`;

    if (payload.ai) return base + aiReadingHtml(payload.ai);

    const diviner = getDefaultDiviner();
    if (diviner && cards.length) {
        return base + divinerCardHtml(record.id, record.ownerNameSnapshot || '问卜者', diviner,
            aiPending.has(record.id));
    }
    return base;
}

// ============================================================
// AI 细解 · 占卜师名片 / 解文（直播 done 态与详情回看共用）
// ============================================================

function formatClock(timestamp) {
    const d = new Date(timestamp);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 名片 = 召唤按钮（data-action="dv-ai-read"，携带 data-record-id）。pending 时 disabled，
// 文案切换为「正在观牌」；名片样式与称号全部由风格注册表条目驱动（未来多占卜师直接加条目）。
function divinerCardHtml(recordId, ownerName, style, pending) {
    const safeName = ownerName || '问卜者';
    return `
        <button type="button" class="dv-diviner-card" data-action="dv-ai-read"
            data-record-id="${esc(recordId)}" ${pending ? 'disabled' : ''}>
            <span class="dv-diviner-inner">
                <span class="dv-diviner-avatar">${style.emoji || '✨'}</span>
                <span class="dv-diviner-main">
                    <span class="dv-diviner-name">${pending ? esc(style.title) + '正在观牌…' : esc(style.title)}</span>
                    <span class="dv-diviner-motto">${pending
                        ? esc('星灯已亮，解文将至——可先离开，稍后在手记里回看。')
                        : esc(style.motto(safeName))}</span>
                </span>
                <span class="dv-diviner-sign">${pending ? '✦' : '›'}</span>
            </span>
        </button>
    `;
}

// 解文卡：AI 产物展示（live 就地插入 / 详情回看共用），全部经 esc 消毒。
// 存储不含 emoji（白名单），徽标头像一律回注册表按 style 取，未来换风格自动跟随。
function aiReadingHtml(ai) {
    const style = ai && ai.style ? getDivinerStyle(ai.style) : null;
    const emoji = (style && style.emoji) || '✨';
    const title = (ai && ai.title) || (style && style.title) || '占卜师';
    const timeText = ai && ai.createdAt ? formatClock(ai.createdAt) : '';
    const paragraphs = splitAiText((ai && ai.text) || '');

    return `
        <div class="dv-ai-reading">
            <div class="dv-ai-reading-head">
                <span class="dv-ai-reading-badge">${esc(emoji)} ${esc(title)} · 细解</span>
                ${timeText ? `<span class="dv-ai-reading-time">解于 ${esc(timeText)}</span>` : ''}
            </div>
            ${paragraphs.map(paragraph => `<p class="dv-ai-reading-p">${esc(paragraph)}</p>`).join('')}
        </div>
    `;
}

// 把仍在页面上的名片原位替换为给定 HTML（名片已不在 DOM 则跳过）
function swapDivinerCard(recordId, html) {
    const card = (currentContainer || document).querySelector(`.dv-diviner-card[data-record-id="${recordId}"]`);
    if (!card || !card.isConnected) return false;
    card.insertAdjacentHTML('beforebegin', html);
    card.remove();
    return true;
}

// ============================================================
// 记录条目（首页预览 / 手记列表共用）
// ============================================================

// 列表标题/摘要同样走引用现查（payload 只存键，正文唯一来源 = 内容库）
function recordItemTitle(record) {
    const payload = record.payload || {};
    if (record.kind === 'sign') {
        const stick = stickById(payload.stickId);
        return stick ? `签文 · ${getLevelLabel(stick.level)}` : '签文';
    }
    const cards = expandTarotCards(payload);
    if (record.kind === 'tarot-three') {
        return `三张 · ${cards.map(card => card.name).join('、')}`;
    }
    const card = cards[0];
    return card ? `${card.name}（${ORIENTATION_LABEL[card.orientation] || ''}）` : '单张';
}

function recordItemSnippet(record) {
    const payload = record.payload || {};
    if (record.kind === 'sign') {
        const stick = stickById(payload.stickId);
        return stick ? stick.poem.join('') : '';
    }
    const first = expandTarotCards(payload)[0];
    return first ? `${first.name}（${ORIENTATION_LABEL[first.orientation] || ''}）：${first.meaning}` : '';
}

function recordItemHtml(record, mini) {
    const kindIcon = KIND_ICON[record.kind] || '🔮';
    return `
        <button class="dv-record-item ${mini ? 'dv-mini' : ''}" data-action="dv-open-record"
            data-record-id="${esc(record.id)}" title="${esc(record.dateKey)}">
            <div class="dv-record-icon">${kindIcon}</div>
            <div class="dv-record-main">
                <div class="dv-record-title">${esc(recordItemTitle(record))}</div>
                <div class="dv-record-snippet">${esc(recordItemSnippet(record))}</div>
            </div>
            <div class="dv-record-date">${esc(record.dateKey.slice(5))}</div>
            <div class="dv-record-chevron">›</div>
        </button>
    `;
}

function recordListHtml(records, emptyText) {
    if (!records.length) {
        return `<div class="dv-empty">${esc(emptyText || '还没有记录。')}</div>`;
    }
    return records.map(record => recordItemHtml(record, false)).join('');
}

function recordKindLabel(record) {
    if (record.kind === 'sign') return '签文';
    if (record.kind === 'tarot-three') return '塔罗 · 三张';
    return '塔罗 · 单张';
}

// ============================================================
// 异步挂载点回填（全部带 pageGen + isConnected 双守卫）
// ============================================================

function fillSignZone() {
    const startGen = pageGen;
    const zone = currentContainer?.querySelector('#dvSignZone');
    if (!zone) return;

    void (async () => {
        const actorId = getCurrentActorId();
        if (!actorId) return;
        const today = localDateKey();

        const signs = await listByOwner(actorId, { limit: SIGN_LIST_LIMIT, kind: 'sign' });
        if (!isTaskAlive(startGen) || !zone.isConnected) return;

        const todayRecord = signs.find(record => record.dateKey === today) || null;

        if (!todayRecord) {
            zone.innerHTML = `
                <div class="dv-zone-title">摇一签</div>
                <div class="dv-sign-jar">
                    <i class="dv-stick"></i><i class="dv-stick"></i><i class="dv-stick"></i>
                    <i class="dv-stick"></i><i class="dv-stick"></i>
                </div>
                <button class="dv-btn dv-primary-btn dv-shake-btn" data-action="dv-shake">摇一签</button>
                <div class="dv-hint dv-hint-center">每角色每天一签 · 明日再来，便是一支新签</div>
            `;
            return;
        }

        const payload = todayRecord.payload || {};
        const stick = stickById(payload.stickId);   // 引用态：签文正文经内容库现查
        const levelKey = (stick && stick.level) || 'zhongping';
        zone.innerHTML = `
            <div class="dv-signed-info">
                <div class="dv-signed-date">今日已摇 · ${esc(todayRecord.dateKey)}</div>
                <span class="dv-level-chip dv-level-${esc(levelKey)}">${esc(stick ? getLevelLabel(stick.level) : '')}</span>
                <div class="dv-signed-poem-line">${esc((stick && stick.poem[0]) || '')}</div>
                <button class="dv-btn dv-ghost-btn" data-action="dv-view-today"
                    data-record-id="${esc(todayRecord.id)}">回看今日签</button>
            </div>
        `;
    })();
}

function fillHomeHistory() {
    const startGen = pageGen;
    const zone = currentContainer?.querySelector('#dvHistoryZone');
    if (!zone) return;

    void (async () => {
        const actorId = getCurrentActorId();
        if (!actorId) return;

        const records = await listByOwner(actorId, { limit: HOME_PREVIEW_LIMIT });
        if (!isTaskAlive(startGen) || !zone.isConnected) return;

        if (!records.length) {
            zone.innerHTML = `<div class="dv-empty">手记还是空的——摇一签或抽张牌，这里会记下每一回。</div>`;
            return;
        }
        zone.innerHTML = records.map(record => recordItemHtml(record, true)).join('');
    })();
}

function fillSignBody() {
    const startGen = pageGen;
    const zone = currentContainer?.querySelector('#dvSignBody');
    if (!zone || !view.recordId) return;

    void (async () => {
        const record = await getRecord(view.recordId);
        if (!isTaskAlive(startGen) || !zone.isConnected) return;

        if (!record) {
            zone.innerHTML = `<div class="dv-empty">这条签文已不在了。</div>`;
            return;
        }

        const payload = record.payload || {};
        const stick = stickById(payload.stickId);   // 引用态：层级经内容库现查
        const levelKey = (stick && stick.level) || 'zhongping';
        zone.innerHTML = `
            <div class="dv-result-meta">
                <span>${esc(record.dateKey)}</span>
                <span class="dv-level-chip dv-level-${esc(levelKey)}">${esc(stick ? getLevelLabel(stick.level) : '')}</span>
                <span>记于 ${esc(record.ownerNameSnapshot || '')} 名下</span>
            </div>
            <div class="dv-gap"></div>
            ${signReadingHtml(payload)}
        `;
    })();
}

function fillHistoryList() {
    const startGen = pageGen;
    const zone = currentContainer?.querySelector('#dvHistoryList');
    if (!zone) return;

    void (async () => {
        const actorId = getCurrentActorId();
        if (!actorId) return;

        const records = await listByOwner(actorId, { limit: HISTORY_LIST_LIMIT });
        if (!isTaskAlive(startGen) || !zone.isConnected) return;

        zone.innerHTML = recordListHtml(records, '手记还是空的——摇一签或抽张牌，这里会记下每一回。');
    })();
}

function fillRecord() {
    const startGen = pageGen;
    const wrap = currentContainer?.querySelector('#dvRecordWrap');
    if (!wrap || !view.recordId) return;

    void (async () => {
        const record = await getRecord(view.recordId);
        if (!isTaskAlive(startGen) || !wrap.isConnected) return;

        const headerEl = wrap.querySelector('#dvRecordHeader');
        const bodyEl = wrap.querySelector('#dvRecordBody');
        const deleteRowEl = wrap.querySelector('#dvDeleteRow');
        if (!headerEl || !bodyEl || !deleteRowEl) return;

        if (!record) {
            headerEl.innerHTML = '';
            deleteRowEl.style.display = 'none';
            bodyEl.innerHTML = `<div class="dv-empty">这条记录已不在了。</div>`;
            return;
        }

        const payload = record.payload || {};
        const kindIcon = KIND_ICON[record.kind] || '🔮';
        headerEl.innerHTML = `
            <div class="dv-record-icon">${kindIcon}</div>
            <div class="dv-detail-meta">
                <strong>${esc(recordKindLabel(record))}</strong>
                <span>${esc(record.dateKey)} · 记于 ${esc(record.ownerNameSnapshot || '')} 名下</span>
            </div>
        `;

        bodyEl.innerHTML = record.kind === 'sign'
            ? signReadingHtml(payload)
            : tarotReadingHtml(record);
    })();
}

function runZoneFills() {
    switch (view.page) {
        case 'sign-result': fillSignBody(); break;
        case 'history': fillHistoryList(); break;
        case 'record': fillRecord(); break;
        default: {
            fillSignZone();
            fillHomeHistory();
        }
    }
}

// ============================================================
// 页面动作（导航）
// ============================================================

function goHome() {
    view.page = 'home';
    view.recordId = null;
    view.recordBackTo = 'home';
    tarot.spread = 'single';
    tarot.question = '';
    tarot.savedRecordId = null;
    rerender();
}

function openTarotFlow() {
    view.page = 'tarot-flow';
    tarot.spread = 'single';
    tarot.question = '';
    tarot.savedRecordId = null;
    rerender();
}

function openHistory() {
    view.page = 'history';
    rerender();
}

function openRecord(recordId, backTo) {
    view.recordId = recordId;
    view.recordBackTo = backTo || 'home';
    view.page = 'record';
    rerender();
}

// ============================================================
// 摇签（每日一签）
// ============================================================

function doShake() {
    const startGen = pageGen;
    const zone = currentContainer?.querySelector('#dvSignZone');
    const btn = zone?.querySelector('[data-action="dv-shake"]');
    const jar = zone?.querySelector('.dv-sign-jar');

    if (!btn || !jar || btn.disabled) return;

    const actorId = getCurrentActorId();
    if (!actorId) return;

    btn.disabled = true;
    btn.textContent = '签筒摇动中…';
    jar.classList.add('shake');

    void (async () => {
        const today = localDateKey();

        // 动作层重查门禁（双保险：渲染层不出现入口 + 落库前复查）
        const signs = await listByOwner(actorId, { limit: SIGN_LIST_LIMIT, kind: 'sign' });
        const existed = signs.find(record => record.dateKey === today);

        await delay(SHAKE_HOLD_MS);
        if (!isTaskAlive(startGen) || !zone.isConnected) return;

        if (existed) {
            toast('今日已摇过一签，明日再来。');
            rerender();
            return;
        }

        const stick = pickRandom(STICKS);
        const record = await addRecord({
            id: createRecordId(),
            kind: 'sign',
            ownerId: actorId,
            ownerNameSnapshot: getActorName(actorId),
            dateKey: today,
            payload: { stickId: stick.id }   // 引用化：签文只存引用键，正文不落副本
        });

        if (!isTaskAlive(startGen)) return;

        if (!record) {
            toast('这一签没能记下，请再摇一次。');
            rerender();
            return;
        }

        view.recordId = record.id;
        view.page = 'sign-result';
        rerender();
    })();
}

// ============================================================
// 塔罗流程
// ============================================================

function tarotPickCards(count) {
    const deck = [...MAJOR_ARCANA];
    const picked = [];

    for (let i = 0; i < count && deck.length; i += 1) {
        const index = Math.floor(Math.random() * deck.length);
        picked.push(deck.splice(index, 1)[0]);
    }

    return picked;
}

function buildTarotCards(spreadKey, slots, picked) {
    return picked.map((card, i) => {
        const orientation = Math.random() < 0.5 ? 'upright' : 'reversed';
        const reading = card[orientation];
        return {
            cardNo: card.no,
            name: card.name,
            orientation,
            posKey: slots[i].key,
            posTitle: slots[i].title,
            meaning: reading.meaning,
            advice: reading.advice
        };
    });
}

function selectSpread(spreadKey) {
    if (view.page !== 'tarot-flow' || flowBusy || tarot.savedRecordId || tarot.spread === spreadKey) return;
    tarot.spread = spreadKey;
    tarot.question = '';
    rerender();
}

function updateQuestionInput(inputEl) {
    tarot.question = inputEl.value;
    const counter = currentContainer?.querySelector('#dvQCount');
    if (!counter) return;

    const len = [...inputEl.value].length;
    counter.textContent = `${len}/${MAX_QUESTION_LEN}`;
    counter.classList.toggle('over', len > MAX_QUESTION_LEN);
}

// 把组合函数输出切成「开场段 / 每张牌一段 / 收尾段」，翻一张放一段
function chunkReadingParts(parts, cardCount, spreadKey, hasQuestion) {
    const leadLen = spreadKey === 'single' ? 1 : 1 + (hasQuestion ? 1 : 0);
    const perCard = spreadKey === 'single' ? parts.length - leadLen : 3;
    const lead = parts.slice(0, leadLen);
    const groups = [];
    for (let c = 0; c < cardCount; c += 1) {
        groups.push(parts.slice(leadLen + c * perCard, leadLen + (c + 1) * perCard));
    }
    const tail = parts.slice(leadLen + cardCount * perCard);
    return { lead, groups, tail };
}

function startDeal() {
    if (flowBusy) return;
    if (view.page !== 'tarot-flow') return;

    const actorId = getCurrentActorId();
    if (!actorId) return;

    const spreadKey = tarot.spread;
    const spread = SPREADS[spreadKey];
    const question = tarot.question.trim();

    if (spreadKey === 'three' && [...question].length > MAX_QUESTION_LEN) {
        toast(QUESTION_MAX_HINT);
        return;
    }

    const startGen = pageGen;
    const root = getPageRoot();
    const area = currentContainer?.querySelector('#dvTarotArea');
    const readEl = currentContainer?.querySelector('#dvTarotRead');
    const actionsEl = currentContainer?.querySelector('.dv-flow-actions');
    const questionBox = currentContainer?.querySelector('#dvQuestionBox');
    const optionsEl = currentContainer?.querySelector('.dv-spread-options');
    if (!root || !area || !readEl || !actionsEl) return;

    flowBusy = true;

    const slots = spread.slots;
    const picked = tarotPickCards(slots.length);
    const cards = buildTarotCards(spreadKey, slots, picked);

    // 入场文案（与手记回看完全同源）
    const ownerName = getActorName(actorId);
    const parts = spreadKey === 'three'
        ? buildThreeReading({ ownerName, question, cards })
        : buildSingleReading({
            ownerName,
            name: cards[0].name,
            orientation: cards[0].orientation,
            meaning: cards[0].meaning,
            advice: cards[0].advice
        });

    const { lead, groups, tail } = chunkReadingParts(parts, cards.length, spreadKey, spreadKey === 'three' && !!question);

    // 进入翻牌布局：收起选项与问题，按钮转忙碌
    optionsEl?.remove();
    questionBox?.remove();
    actionsEl.innerHTML = `<button class="dv-btn dv-primary-btn" disabled>翻牌中…</button>`;

    area.innerHTML = `
        <div class="dv-spread ${spreadKey === 'single' ? 'dv-spread-single' : ''}">
            ${slots.map((slot, i) => `
                <div class="dv-card" data-idx="${i}">
                    <div class="dv-card-inner">
                        <div class="dv-card-back">✦</div>
                        <div class="dv-card-face">
                            <div class="dv-card-pos">${esc(slot.title)}</div>
                            <div class="dv-card-name">${esc(cards[i].name)}</div>
                            <div class="dv-card-ori ${cards[i].orientation === 'reversed' ? 'reversed' : ''}">${ORIENTATION_LABEL[cards[i].orientation]}</div>
                        </div>
                    </div>
                </div>
            `).join('')}
        </div>
    `;

    readEl.innerHTML = '';
    readEl.insertAdjacentHTML('beforeend', readingPartsHtml(lead));

    void (async () => {
        for (let i = 0; i < cards.length; i += 1) {
            await delay(FLIP_MS);
            if (!isTaskAlive(startGen)) return;

            const cardEl = area.querySelector(`[data-idx="${i}"]`);
            if (!cardEl) return;
            cardEl.classList.add('dv-card-flip');

            await delay(PAUSE_AFTER_FLIP_MS);
            if (!isTaskAlive(startGen)) return;

            if (groups[i]) {
                readEl.insertAdjacentHTML('beforeend', readingPartsHtml(groups[i]));
            }
        }

        await delay(380);
        if (!isTaskAlive(startGen)) return;

        // 收尾段（三张的结语）在全部翻完后浮现
        if (tail.length) {
            readEl.insertAdjacentHTML('beforeend', readingPartsHtml(tail));
        }

        // 自动落库（payload 引用化：牌只落 cardNo/orientation/posKey，正文在内容库，
        // 回看/细解经 expandTarotCards 现查；直播渲染仍用上面的全量 cards）
        const record = await addRecord({
            id: createRecordId(),
            kind: spreadKey === 'three' ? 'tarot-three' : 'tarot-one',
            ownerId: actorId,
            ownerNameSnapshot: ownerName,
            dateKey: localDateKey(),
            payload: {
                spread: spreadKey,
                question,
                cards: cards.map(card => ({
                    cardNo: card.cardNo,
                    orientation: card.orientation,
                    posKey: card.posKey
                }))
            }
        });

        if (!isTaskAlive(startGen)) return;

        if (record) {
            tarot.savedRecordId = record.id;
            readEl.insertAdjacentHTML('afterbegin', '<div class="dv-saved-tag">已记入手记</div>');

            // v1.1：解读段尾部挂占卜师名片（细解入口一：直播 done 态）。
            // 写入失败（record 假）不挂 —— 细解需要 recordId 落库。
            const diviner = getDefaultDiviner();
            if (diviner && cards.length) {
                readEl.insertAdjacentHTML('beforeend',
                    divinerCardHtml(record.id, ownerName, diviner, false));
            }
        } else {
            toast('这一局没能记入手记（写入失败），翻开的牌仍然有效。');
        }

        flowBusy = false;
        actionsEl.innerHTML = `
            <button class="dv-btn dv-ghost-btn" data-action="dv-tarot-again">再抽一张</button>
            <button class="dv-btn dv-primary-btn" data-action="dv-home">回首页</button>
        `;
    })();
}

function tarotAgain() {
    if (flowBusy) return;
    view.page = 'tarot-flow';
    tarot.spread = 'single';
    tarot.question = '';
    tarot.savedRecordId = null;
    rerender();
}

// ============================================================
// AI 细解：名片点击 → 任务中心 → 落库 + 就地补挂
// ============================================================

// 失败 toast 保持中性（不给「设备使用者」主语）；细节进 console 供排查
function aiFailToast(errMsg) {
    console.warn('[divination] 细解失败:', errMsg || '');
    toast('星语者这次没能开解，稍后再点一次试试。');
}

async function requestDivinerReading(recordId) {
    if (!recordId || aiPending.has(recordId)) return;
    const diviner = getDefaultDiviner();
    if (!diviner) return;

    // 内存锁先占位（双入口/双击并发防双花），任何早退都必须释放
    aiPending.set(recordId, true);

    // 记录现场取（不信任过时快照）：已删 / 已解 → 直接退，页面现状不动
    let record = null;
    try { record = await getRecord(recordId); } catch (error) { record = null; }
    if (!record || record.payload?.ai) {
        aiPending.delete(recordId);
        return;
    }

    // 无 key 预检：卡片尚未换 pending 态，保持可点
    if (!hasApiKey()) {
        aiPending.delete(recordId);
        toast(AI_NO_KEY_HINT);
        return;
    }

    const ownerName = record.ownerNameSnapshot || '问卜者';
    const spread = record.payload.spread || 'single';

    // 名片 → 「观牌中」态（原位置换；若此刻卡片不在 DOM，下次渲染靠 aiPending 锁补 disabled）
    swapDivinerCard(recordId, divinerCardHtml(recordId, ownerName, diviner, true));

    const userContent = buildDivinerUserText(record);

    taskManager.submit('divination', `占卜屋 · ${diviner.title}细解`, async () =>
        Promise.race([
            callAIWithMessages({
                systemPrompt: diviner.buildSystemPrompt({ ownerName, spread }),
                userContent,
                maxTokens: diviner.maxTokens || 1800,
                temperature: diviner.temperature
            }),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error('AI 服务响应超时（已自动放弃，可稍后再试）')),
                AI_TIMEOUT_MS
            ))
        ]),
    {
        // 回调在模块离开后仍会执行：先无条件落库，再按现场状态决定补 DOM 方式
        onComplete: async (text) => {
            aiPending.delete(recordId);

            const aiText = typeof text === 'string' ? text.trim() : '';
            if (!aiText) {   // 空解文 → 视作未成，名片复位可重试
                swapDivinerCard(recordId, divinerCardHtml(recordId, ownerName, diviner, false));
                toast('星语者这回没说出话来，可以再点一次。');
                return;
            }

            const ai = { style: diviner.id, title: diviner.title, text: aiText, createdAt: Date.now() };
            const updated = await attachTarotAi(recordId, ai);
            if (!updated) {   // 记录已被删除 → 丢弃回写（不复活）
                toast('星语者已解完，但这局已不在手记里了。');
                return;
            }

            // 就地补挂：直播 done 态原位换卡最顺；详情页骨架固定，整页重渲最稳
            const onLive = view.page === 'tarot-flow' && tarot.savedRecordId === recordId;
            const onDetail = view.page === 'record' && view.recordId === recordId;

            if (onLive && swapDivinerCard(recordId, aiReadingHtml(ai))) {
                toast('星语者已开解，解文附在牌局下方。');
                return;
            }
            if (onDetail) {
                rerender();
                toast('星语者已开解，解文在下方。');
                return;
            }
            toast('星语者已解完，可在占卜手记中回看。');
        },
        onError: (errMsg) => {
            aiPending.delete(recordId);
            // 名片复位原文案（若还在页面上），可再次尝试
            swapDivinerCard(recordId, divinerCardHtml(recordId, ownerName, diviner, false));
            aiFailToast(errMsg);
        }
    }).catch(() => { /* 失败已由 onError 处理 UI，吞掉 reject 防未捕获告警 */ });
}

// ============================================================
// 记录删除
// ============================================================

async function deleteCurrentRecord() {
    if (!view.recordId || view.page !== 'record') return;

    const ok = await showConfirm('删除后不可恢复。确定删除这条占卜记录吗？');
    if (!ok) return;
    if (view.recordId === null || view.page !== 'record') return;

    const removed = await deleteRecord(view.recordId);
    toast(removed ? '记录已删除。' : '删除失败，请重试。');

    const backTo = view.recordBackTo === 'history' ? 'history' : 'home';
    if (backTo === 'history') {
        view.page = 'history';
        rerender();
    } else {
        goHome();
    }
}

// ============================================================
// 返回处理（子页消费返回；home 交还路由回桌面）
// ============================================================

export function handleBack(container, context = {}) {
    if (view.page === 'home') return false;

    currentContainer = container || currentContainer;
    currentGlobalState = context.globalState || currentGlobalState;

    if (view.page === 'record') {
        if (view.recordBackTo === 'history') {
            view.page = 'history';
            rerender();
        } else {
            goHome();
        }
        return true;
    }

    goHome();
    return true;
}

// ============================================================
// 事件绑定（节点级委托，.dv-page 每轮重建后只绑一次）
// ============================================================

function handleRootClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const spreadBtn = target.closest('[data-dv-spread]');
    if (spreadBtn) {
        selectSpread(spreadBtn.dataset.dvSpread);
        return;
    }

    const actionEl = target.closest('[data-action]');
    if (!actionEl) return;

    switch (actionEl.dataset.action) {
        case 'dv-shake': doShake(); break;
        case 'dv-tarot': openTarotFlow(); break;
        case 'dv-history': openHistory(); break;
        case 'dv-cancel': goHome(); break;
        case 'dv-tarot-deal': startDeal(); break;
        case 'dv-tarot-again': tarotAgain(); break;
        case 'dv-ai-read': {
            const recordEl = actionEl.closest('[data-record-id]');
            if (recordEl) void requestDivinerReading(recordEl.dataset.recordId);
            break;
        }
        case 'dv-home': goHome(); break;
        case 'dv-del-record': void deleteCurrentRecord(); break;
        case 'dv-open-record':
        case 'dv-view-today': {
            const recordEl = actionEl.closest('[data-record-id]');
            if (recordEl) {
                openRecord(recordEl.dataset.recordId, view.page === 'history' ? 'history' : 'home');
            }
            break;
        }
        // data-action="back" 由 app.js 的全局监听处理（会再调 handleBack）
        default: break;
    }
}

function handleRootInput(event) {
    if (event.target && event.target.id === 'dvQuestionInput') {
        updateQuestionInput(event.target);
    }
}

export function bindEvents(container, context = {}) {
    currentContainer = container;
    currentGlobalState = context.globalState || currentGlobalState;

    const pageRoot = getPageRoot();
    if (pageRoot && !boundPageRoots.has(pageRoot)) {
        boundPageRoots.add(pageRoot);
        pageRoot.addEventListener('click', handleRootClick);
        pageRoot.addEventListener('input', handleRootInput);
    }

    runZoneFills();
}

// ============================================================
// 模块注册
// ============================================================

if (!window.__moduleRegistry) window.__moduleRegistry = [];
window.__moduleRegistry.push({ id, label, icon, color, render, bindEvents, handleBack });

console.log('[divination] 模块已加载');

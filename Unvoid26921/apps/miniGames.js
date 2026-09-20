// apps/miniGames.js — 互动组件
//
// 一份自包含的 HTML（含脚本）存下来，在沙箱里跑起来，能点能玩。
// 沙箱的墙怎么砌的、为什么这么砌，写在 miniGamesCore.js 的文件头（有实测结论）。
//
// 四页：list（示例 + 我的组件）→ detail / edit → play（iframe 沙箱）
// 示例组件只在代码里，不进数据库。

import { esc } from '../store/utils.js';
import { showAlert, showConfirm } from '../store/dialog.js';
import * as db from '../store/MiniGamesStore.js';
import {
    buildSandboxDoc, clampHeight, boundResult, summarizeResult, previewOf,
    parseTags, formatDate, formatDuration, charCountText,
    BRIDGE_MARK, MSG_RESIZE, MSG_REPORT, MSG_ERROR
} from './miniGamesCore.js';
import { SAMPLE_COMPONENTS, findSample } from './miniGamesLib.js';

const id = 'miniGames';
const label = '互动组件';
const icon = '🎮';
const color = '#7C4DFF';

// ============================================================
// 模块状态
// ============================================================

const view = {
    page: 'list',        // list | detail | edit | play
    componentId: null,   // detail / play 指向谁（示例也走这个字段，值是 sample_*）
    from: 'list',        // 这一局是从哪页进 play 的，返回按它走
    editingId: null      // edit 页在改谁；null = 新建
};

const cache = {
    components: [],
    component: null,
    runs: [],
    // rerender 会重建 DOM，表单内容得留在内存里，否则光标和没提交的字都会丢
    form: { title: '', tags: '', html: '' },
    error: '',           // 沙箱报回来的错
    lastResult: null     // 组件刚上报的结果（只在内存里，不落库——落库的那份在 runs）
};

const runtime = {
    frame: null,
    handler: null,
    startedAt: 0,
    height: 0
};

let pageGen = 0;
let currentContainer = null;
let scrollTo = 'top';    // 'top' | 'keep'
const boundRoots = new WeakSet();
let toastEl = null;
let toastTimer = null;

// ============================================================
// 小工具
// ============================================================

function toast(message) {
    if (toastEl) toastEl.remove();
    if (toastTimer) clearTimeout(toastTimer);

    const el = document.createElement('div');
    el.className = 'mg-toast';
    el.textContent = message;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-show'));

    toastEl = el;
    toastTimer = setTimeout(() => {
        el.classList.remove('is-show');
        setTimeout(() => el.remove(), 220);
        toastEl = null;
        toastTimer = null;
    }, 2100);
}

function isAlive(gen) {
    return pageGen === gen && currentContainer && currentContainer.isConnected;
}

/** 当前页的滚动容器 */
function scroller() {
    if (!currentContainer) return null;
    return currentContainer.querySelector('.mg-scroll');
}

// ============================================================
// 数据
// ============================================================

async function reload() {
    cache.components = await db.listComponents();

    if (view.page === 'detail' || view.page === 'play') {
        cache.component = await resolveComponent(view.componentId);
        cache.runs = cache.component && !cache.component.sample
            ? await db.listRuns(view.componentId)
            : [];   // 示例不落库，自然也没有记录
    }

    if (view.page === 'edit') {
        if (view.editingId) {
            const c = await db.getComponent(view.editingId);
            if (c) {
                cache.component = c;
                cache.form = { title: c.title, tags: (c.tags || []).join(' '), html: c.html };
            } else {
                view.editingId = null;
            }
        } else {
            cache.component = null;
        }
    }
}

/** 组件可能是库里的，也可能是代码里的示例 */
async function resolveComponent(componentId) {
    if (!componentId) return null;
    const sample = findSample(componentId);
    if (sample) return { ...sample, sample: true };
    return db.getComponent(componentId);
}

async function goList() {
    cleanupRuntime();
    view.page = 'list';
    view.componentId = null;
    view.editingId = null;
    cache.error = '';
    cache.lastResult = null;
    await reload();
    scrollTo = 'top';
    rerender();
}

async function goDetail(componentId) {
    cleanupRuntime();
    view.page = 'detail';
    view.componentId = componentId;
    cache.error = '';
    cache.lastResult = null;
    await reload();
    scrollTo = 'top';
    rerender();
}

async function goEdit(componentId) {
    cleanupRuntime();
    view.page = 'edit';
    view.editingId = componentId || null;
    cache.form = { title: '', tags: '', html: '' };
    await reload();
    scrollTo = 'top';
    rerender();
}

async function goPlay(componentId) {
    cleanupRuntime();
    view.from = view.page;
    view.page = 'play';
    view.componentId = componentId;
    cache.error = '';
    cache.lastResult = null;
    await reload();
    scrollTo = 'top';
    rerender();
}

// ============================================================
// 沙箱
// ============================================================

/**
 * 收掉当前这个 iframe。
 * iframe 元素本身随 DOM 重建就没了，但 message 监听挂在 window 上，**必须手动摘**——
 * 这是全项目唯一需要手动清监听的地方（别处的监听都挂在会被重建的 DOM 上，随元素回收）。
 */
function cleanupRuntime() {
    if (runtime.handler) {
        window.removeEventListener('message', runtime.handler);
        runtime.handler = null;
    }
    if (runtime.frame) {
        runtime.frame.remove();
        runtime.frame = null;
    }
    runtime.height = 0;
}

function applyHeight(raw) {
    const h = clampHeight(raw);
    if (!h || !runtime.frame) return;
    if (Math.abs(h - runtime.height) < 4) return;   // 抖一下不动，省得来回重排
    runtime.height = h;
    runtime.frame.style.height = `${h}px`;
}

function showError(message, line) {
    if (!currentContainer) return;
    const slot = currentContainer.querySelector('[data-mg-error]');
    if (!slot) return;
    slot.innerHTML = `<div class="mg-error">组件报错了：${esc(message)}${line ? `（第 ${line} 行）` : ''}</div>`;
}

function showResult(result) {
    if (!currentContainer) return;
    const slot = currentContainer.querySelector('[data-mg-result]');
    if (!slot) return;
    slot.innerHTML = resultCardHtml(result);
}

/**
 * 起沙箱。**只认自己那个 iframe 发来的消息**（e.source 比对），别人的一律丢。
 * 组件把 iframe 顶掉之后（用户切走/重画），监听里会自查一次 isConnected 自愈，
 * 免得漏掉某条离开路径就在 window 上留一根监听。
 */
function startSandbox(container, html) {
    cleanupRuntime();

    const frame = document.createElement('iframe');
    frame.className = 'mg-frame';
    frame.setAttribute('sandbox', 'allow-scripts');   // 不给 allow-same-origin：不透明源
    frame.title = '互动组件沙箱';

    runtime.frame = frame;
    runtime.startedAt = Date.now();

    runtime.handler = (e) => {
        if (!runtime.frame || e.source !== runtime.frame.contentWindow) return;
        if (!runtime.frame.isConnected) { cleanupRuntime(); return; }

        const msg = e.data;
        if (!msg || typeof msg !== 'object' || msg[BRIDGE_MARK] !== 1) return;

        if (msg.type === MSG_RESIZE) {
            applyHeight(msg.payload);
        } else if (msg.type === MSG_REPORT) {
            handleReport(msg.payload);
        } else if (msg.type === MSG_ERROR) {
            const p = msg.payload || {};
            showError(String(p.message || '未知错误'), p.line);
        }
    };

    window.addEventListener('message', runtime.handler);
    frame.srcdoc = buildSandboxDoc(html);     // 属性赋值，不需要再做 HTML 转义
    container.appendChild(frame);
}

async function handleReport(data) {
    const bounded = boundResult(data);
    cache.lastResult = bounded;
    showResult(bounded);

    // 示例不落库（它压根不在 components 里，落进去就是孤儿记录）
    const c = cache.component;
    if (!c || c.sample) return;

    try {
        await db.addRun({
            componentId: c.id,
            result: bounded,
            duration: Date.now() - runtime.startedAt
        });
        cache.runs = await db.listRuns(c.id);
    } catch (e) {
        console.warn('[miniGames] 运行记录没存上', e);
    }
}

// ============================================================
// 保存 / 删除
// ============================================================

async function saveForm() {
    const html = cache.form.html.trim();
    if (!html) {
        await showAlert('还没贴组件代码');
        return;
    }

    try {
        const saved = await db.saveComponent({
            id: view.editingId || undefined,
            title: cache.form.title,
            tags: parseTags(cache.form.tags),
            html
        });
        toast(view.editingId ? '已保存' : '组件已存进库');
        await goDetail(saved.id);
    } catch (e) {
        console.warn('[miniGames] 保存失败', e);
        await showAlert('保存失败：' + (e && e.message ? e.message : e));
    }
}

async function saveSampleAsMine() {
    const c = cache.component;
    if (!c) return;
    try {
        const saved = await db.saveComponent({ title: c.title, tags: c.tags, html: c.html });
        toast('已存为我的组件');
        await goDetail(saved.id);
    } catch (e) {
        console.warn('[miniGames] 保存失败', e);
        await showAlert('保存失败：' + (e && e.message ? e.message : e));
    }
}

async function deleteCurrent() {
    const c = cache.component;
    if (!c || c.sample) return;
    const ok = await showConfirm(`删掉「${c.title}」？它的运行记录也一起删。`);
    if (!ok) return;
    try {
        await db.deleteComponent(c.id);
        toast('已删除');
        await goList();
    } catch (e) {
        console.warn('[miniGames] 删除失败', e);
        await showAlert('删除失败：' + (e && e.message ? e.message : e));
    }
}

async function clearRunsConfirm() {
    const c = cache.component;
    if (!c) return;
    const ok = await showConfirm(`清掉「${c.title}」的全部运行记录？`);
    if (!ok) return;
    await db.clearRuns(c.id);
    cache.runs = [];
    scrollTo = 'keep';
    rerender();
}

// ============================================================
// 渲染
// ============================================================

function renderPage() {
    switch (view.page) {
        case 'detail': return pageShellHtml('detail', pageDetailHtml());
        case 'edit': return pageShellHtml('edit', pageEditHtml());
        case 'play': return pageShellHtml('play', pagePlayHtml());
        default: return pageShellHtml('list', pageListHtml());
    }
}

// data-mg-page 标记页面形态，供 miniGames.css 用 :has() 在子页把整条全局返回栏 #topBar
// 让位（同 textgame.css / divination.css / bookClub.css 先例）——子页返回由页内自画的 ← 承担。
function pageShellHtml(page, inner) {
    return `<section class="screen-page mg-page" data-mg-page="${page}">${inner}</section>`;
}

function subnavHtml(title, note, actions = '') {
    return `
        <div class="mg-subnav">
            <button class="mg-icon-btn" data-action="back" title="返回">←</button>
            <div class="mg-subnav-main">
                <div class="mg-subnav-title">${esc(title)}</div>
                ${note ? `<div class="mg-subnav-note">${esc(note)}</div>` : ''}
            </div>
            ${actions}
        </div>
    `;
}

function pageListHtml() {
    const samples = SAMPLE_COMPONENTS.map(s => `
        <div class="mg-card mg-item" data-mg-act="open" data-mg-id="${esc(s.id)}">
            <div class="mg-item-title">${esc(s.title)}<span class="mg-badge">示例</span></div>
            <div class="mg-item-note">${esc((s.tags || []).join(' · '))}</div>
        </div>
    `).join('');

    const mine = cache.components.length
        ? cache.components.map(c => `
            <div class="mg-card mg-item" data-mg-act="open" data-mg-id="${esc(c.id)}">
                <div class="mg-item-title">${esc(c.title)}</div>
                <div class="mg-item-note">${esc((c.tags || []).join(' · ') || '无标签')} · ${charCountText(c.charCount)}</div>
            </div>
        `).join('')
        : '<div class="mg-empty">还没有自己的组件。点右上角「＋ 导入」贴一段 HTML 进来。</div>';

    return `
        <div class="screen-header">
            <div class="screen-title">互动组件</div>
            <button class="mg-head-btn" data-mg-act="new">＋ 导入</button>
        </div>
        <div class="mg-scroll">
            <div class="mg-sec-title">示例</div>
            ${samples}
            <div class="mg-sec-title">我的组件（${cache.components.length}）</div>
            ${mine}
        </div>
    `;
}

function pageDetailHtml() {
    const c = cache.component;
    if (!c) return '<div class="mg-empty">这个组件不在了</div>';

    const tags = (c.tags || []).join(' · ');
    const actions = c.sample ? '' : '<button class="mg-icon-btn" data-mg-act="delete" title="删除">🗑️</button>';

    return subnavHtml(c.title, tags, actions) + `
        <div class="mg-scroll">
            ${c.sample ? '<div class="mg-note">示例组件，不会存进库里。想留着玩就「存为我的组件」。</div>' : ''}
            <div class="mg-actions">
                <button class="mg-btn mg-btn-primary" data-mg-act="play">▶ 开始游玩</button>
                ${c.sample
                    ? '<button class="mg-btn" data-mg-act="save-sample">存为我的组件</button>'
                    : '<button class="mg-btn" data-mg-act="edit">改源码</button>'}
            </div>
            <div data-mg-runs>${runsHtml(cache.runs)}</div>
            <div class="mg-sec-title">源码</div>
            <div class="mg-card"><div class="mg-source">${esc(previewOf(c.html))}</div></div>
        </div>
    `;
}

function runsHtml(runs) {
    if (!runs || !runs.length) return '';
    const rows = runs.slice(0, 10).map(r => `
        <div class="mg-card mg-run">
            <div class="mg-run-line">${esc(summarizeResult(r.result))}</div>
            <div class="mg-run-note">${esc(formatDate(r.createdAt))} · ${esc(formatDuration(r.duration))}</div>
        </div>
    `).join('');

    return `
        <div class="mg-sec-title mg-sec-row">
            <span>运行记录（${runs.length}）</span>
            <button class="mg-link-btn" data-mg-act="clear-runs">清空</button>
        </div>
        ${rows}
    `;
}

function pageEditHtml() {
    const editing = !!view.editingId;
    const f = cache.form;

    return subnavHtml(editing ? '改源码' : '导入组件', editing ? '' : '贴一份自包含的 HTML') + `
        <div class="mg-scroll">
            <div class="mg-field">
                <div class="mg-label">名称</div>
                <input class="mg-input" data-mg-field="title" value="${esc(f.title)}" placeholder="给它起个名字">
            </div>
            <div class="mg-field">
                <div class="mg-label">标签</div>
                <input class="mg-input" data-mg-field="tags" value="${esc(f.tags)}" placeholder="空格分开，如：解谜 推理">
            </div>
            <div class="mg-field">
                <div class="mg-label">HTML</div>
                <textarea class="mg-textarea" data-mg-field="html" placeholder="&lt;div&gt;…&lt;/div&gt;&lt;script&gt;…&lt;/script&gt;">${esc(f.html)}</textarea>
            </div>
            <div class="mg-note">
                组件在沙箱里跑：拿不到小手机的数据，也发不出网络请求。<br>
                想上报结果就调 <code>window.mgReport(任意结构)</code>——可选，不调也能玩。
            </div>
            <div class="mg-actions">
                <button class="mg-btn mg-btn-primary" data-mg-act="save">保存</button>
            </div>
        </div>
    `;
}

function pagePlayHtml() {
    const c = cache.component;
    if (!c) return '<div class="mg-empty">这个组件不在了</div>';

    return subnavHtml(c.title, c.sample ? '示例' : '') + `
        <div class="mg-scroll">
            ${c.sample ? '<div class="mg-note">示例组件不会存进库里。</div>' : ''}
            <div data-mg-error>${cache.error ? `<div class="mg-error">${esc(cache.error)}</div>` : ''}</div>
            <div data-mg-result>${cache.lastResult ? resultCardHtml(cache.lastResult) : ''}</div>
            <div class="mg-stage" data-mg-stage></div>
        </div>
    `;
}

function resultCardHtml(result) {
    return `
        <div class="mg-card mg-result">
            <div class="mg-result-title">组件上报了结果</div>
            <div class="mg-result-line">${esc(summarizeResult(result))}</div>
        </div>
    `;
}

// ============================================================
// 重画
// ============================================================

function rerender() {
    if (!currentContainer || !currentContainer.isConnected) return;
    const box = scroller();
    const keepTop = box ? box.scrollTop : 0;

    pageGen += 1;
    currentContainer.innerHTML = renderPage();
    bindEvents(currentContainer, {});
    afterRender(keepTop);
}

/**
 * 重画之后把滚动位置摆回去。keepTop 是重画**之前**量到的 scrollTop——
 * 重画会把滚动容器整个换掉，不还回去的话每次重画都弹回页首。
 */
function afterRender(keepTop = null) {
    if (!currentContainer) return;
    const box = scroller();
    if (box) {
        if (scrollTo === 'keep') {
            if (keepTop !== null) box.scrollTop = keepTop;
        } else {
            box.scrollTop = 0;
        }
    }
    scrollTo = 'keep';

    if (view.page === 'play' && cache.component) {
        const stage = currentContainer.querySelector('[data-mg-stage]');
        if (stage) startSandbox(stage, cache.component.html);
    }
}

// ============================================================
// 事件
// ============================================================

export function render(context = {}) {
    currentContainer = document.getElementById('pageContainer');
    const gen = pageGen + 1;
    pageGen = gen;

    // 先用手里的数据画一版（首次进模块就是骨架），取完数再画一遍
    void (async () => {
        try {
            await reload();
        } catch (error) {
            console.error('[miniGames] 取数失败', error);
        }
        if (!isAlive(gen)) return;
        currentContainer.innerHTML = renderPage();
        bindEvents(currentContainer, context || {});
        afterRender();
    })();

    return renderPage();
}

export function handleBack(container, context = {}) {
    if (view.page === 'list') return false;   // 交还给路由，回桌面

    currentContainer = container || currentContainer;
    if (view.page === 'play') {
        // 原路来、原路回：从列表点示例直接进 play 的，别把人丢到一个示例详情页去
        if (view.from === 'list') goList();
        else goDetail(view.componentId);
    } else if (view.page === 'edit') {
        if (view.editingId) goDetail(view.editingId);
        else goList();
    } else {
        goList();
    }
    return true;
}

export function bindEvents(container, context = {}) {
    currentContainer = container || currentContainer;
    const root = currentContainer && currentContainer.querySelector('.mg-page');
    if (!root || boundRoots.has(root)) return;
    boundRoots.add(root);

    root.addEventListener('click', onRootClick);
    root.addEventListener('input', onRootInput);
}

function onRootInput(e) {
    const field = e.target.closest('[data-mg-field]');
    if (!field) return;
    const key = field.dataset.mgField;
    if (key) cache.form[key] = field.value;
}

function onRootClick(e) {
    const el = e.target.closest('[data-mg-act]');
    if (!el) return;
    const act = el.dataset.mgAct;

    switch (act) {
        case 'open': {
            const cid = el.dataset.mgId;
            if (findSample(cid)) goPlay(cid);
            else goDetail(cid);
            break;
        }
        case 'new': goEdit(null); break;
        case 'edit': goEdit(view.componentId); break;
        case 'play': goPlay(view.componentId); break;
        case 'save': saveForm(); break;
        case 'save-sample': saveSampleAsMine(); break;
        case 'delete': deleteCurrent(); break;
        case 'clear-runs': clearRunsConfirm(); break;
    }
}

// ============================================================
// 注册
// ============================================================

if (!window.__moduleRegistry) window.__moduleRegistry = [];
window.__moduleRegistry.push({ id, label, icon, color, render, bindEvents, handleBack });

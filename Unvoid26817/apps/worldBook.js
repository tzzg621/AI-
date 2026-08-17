// apps/worldBook.js — 世界书（提示词仓库）
import { esc } from '../store/utils.js';
import { showConfirm } from '../store/dialog.js';

export const id = 'worldBookPage';
export const label = '世界书';
export const icon = '📖';
export const color = '#9c27b0';
export const title = '📖 世界书';
export const memoryOptions = {
    mode: 'global',
    description: '世界书中的设定条目可以选择与全局记忆联动。',
    enabled: true
};

// ---- localStorage 工具 ----
const STORAGE_KEY = 'worldbook_entries';

function loadEntries() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        try { return JSON.parse(saved); } catch (e) { /* 忽略 */ }
    }
    return [
        { id: genId(), title: '世界设定', text: '这里是你的世界观设定条目……', priority: 6, enabled: true, activation: 'global', tags: [] },
        { id: genId(), title: '人物关系', text: '描述主要人物之间的关系网。', priority: 6, enabled: true, activation: 'global', tags: [] },
        { id: genId(), title: '历史年表', text: '记录世界的重要事件。', priority: 6, enabled: true, activation: 'global', tags: [] }
    ];
}
function saveEntries(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}
function genId() {
    return 'entry_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
}

let entries = loadEntries();

function activationLabel(item) {
    if (item.activation === 'global') return '全局生效';
    if (item.activation?.startsWith('char_')) return '指定角色生效';
    if (item.activation?.startsWith('scene_')) return '特定场景生效';
    return '全局生效';
}

function findItem(id) {
    return entries.find(x => x.id === id);
}

// ---- 单一模板（render 与新增共用） ----
function renderEntryCard(item) {
    const enabled = item.enabled !== false;
    return `
    <div class="wb-entry ${enabled ? '' : 'is-disabled'}" data-id="${item.id}">
        <div class="wb-entry-top">
            <button class="wb-toggle ${enabled ? 'on' : ''}" aria-label="启用/禁用"></button>
            <input class="wb-title-input" value="${esc(item.title)}" placeholder="输入标题…" />
            <select class="wb-priority" aria-label="优先级">
                ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(v =>
        `<option value="${v}" ${(item.priority ?? 6) === v ? 'selected' : ''}>P${v}</option>`
    ).join('')}
            </select>
        </div>
        <textarea class="wb-text-input" rows="2" placeholder="输入内容……">${esc(item.text)}</textarea>
        <div class="wb-entry-foot">
            <span class="wb-activation">${activationLabel(item)}</span>
            <button class="wb-delete-btn">🗑 删除</button>
        </div>
    </div>`;
}

// ---- 单卡片事件绑定（render 时逐卡调用；新增后对新卡调用） ----
function bindEntryEvents(entryEl) {
    entryEl.querySelector('.wb-toggle')?.addEventListener('click', () => {
        const item = findItem(entryEl.dataset.id);
        if (!item) return;
        item.enabled = !(item.enabled !== false);
        saveEntries(entries);
        entryEl.classList.toggle('is-disabled', item.enabled === false);
        entryEl.querySelector('.wb-toggle')?.classList.toggle('on', item.enabled !== false);
        updateStats(entryEl.closest('.screen-content'));
    });

    entryEl.querySelector('.wb-title-input')?.addEventListener('input', (e) => {
        const item = findItem(entryEl.dataset.id);
        if (!item) return;
        item.title = e.target.value;
        saveEntries(entries);
    });

    entryEl.querySelector('.wb-text-input')?.addEventListener('input', (e) => {
        const item = findItem(entryEl.dataset.id);
        if (!item) return;
        item.text = e.target.value;
        saveEntries(entries);
    });

    entryEl.querySelector('.wb-priority')?.addEventListener('change', (e) => {
        const item = findItem(entryEl.dataset.id);
        if (!item) return;
        item.priority = parseInt(e.target.value, 10);
        saveEntries(entries);
    });

    entryEl.querySelector('.wb-delete-btn')?.addEventListener('click', async () => {
        const item = findItem(entryEl.dataset.id);
        if (!item) return;
        const ok = await showConfirm('确定删除「' + (item.title || '未命名') + '」吗？');
        if (!ok) return;
        const idx = entries.findIndex(x => x.id === item.id);
        if (idx >= 0) entries.splice(idx, 1);
        saveEntries(entries);
        const container = entryEl.closest('.screen-content');   // ★ 先取，再移除
        entryEl.remove();
        updateStats(container);
    });
}

function updateStats(container) {
    if (!container) return;
    const nodes = container.querySelectorAll('.wb-stat b');
    if (nodes.length < 2) return;
    nodes[0].textContent = entries.length;
    nodes[1].textContent = entries.filter(e => e.enabled !== false).length;
}

// ---- 渲染 ----
export function render() {
    entries = loadEntries();
    const enabledCount = entries.filter(e => e.enabled !== false).length;
    return `
    <div class="screen-page">
        <div class="screen-header">
            <div class="screen-title">${title}</div>
            <div class="header-spacer"></div>
        </div>
        <div class="screen-content">
            <div class="wb-stats">
                <span class="wb-stat"><b>${entries.length}</b> 条条目</span>
                <span class="wb-stat"><b>${enabledCount}</b> 条启用</span>
            </div>
            <div class="wb-list">
                ${entries.map(renderEntryCard).join('')}
            </div>
            <button class="wb-add-btn">＋ 新增条目</button>
        </div>
    </div>`;
}

// ---- 事件绑定（子元素逐个绑定：随 render 重建，无监听累积） ----
export function bindEvents(container) {
    container.querySelectorAll('.wb-entry').forEach(bindEntryEvents);

    const addBtn = container.querySelector('.wb-add-btn');
    if (addBtn) {
        addBtn.addEventListener('click', () => {
            const item = { id: genId(), title: '新条目', text: '', priority: 6, enabled: true, activation: 'global', tags: [] };
            entries.push(item);
            saveEntries(entries);
            const wrap = document.createElement('div');
            wrap.innerHTML = renderEntryCard(item);
            const node = wrap.firstElementChild;
            container.querySelector('.wb-list').appendChild(node);
            bindEntryEvents(node);                    // 新卡单独绑定
            updateStats(container);
            node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            node.querySelector('.wb-title-input')?.focus();
        });
    }
}

if (!window.__moduleRegistry) window.__moduleRegistry = [];
window.__moduleRegistry.push({ id, label, icon, color, render, bindEvents });

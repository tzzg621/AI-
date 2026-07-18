// apps/worldBook.js — 世界书（提示词仓库）

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

// ---- 辅助函数：创建条目 DOM ----
function createEntryElement(item, index) {
    const div = document.createElement('div');
    div.className = 'world-entry';
    div.dataset.index = index;
    div.dataset.id = item.id;

    const activationLabel = item.activation === 'global' ? '全局生效'
        : item.activation?.startsWith('char_') ? '指定角色生效'
        : item.activation?.startsWith('scene_') ? '特定场景生效'
        : '全局生效';

    div.innerHTML = `
        <div style="display:flex;align-items:flex-start;gap:10px;">
            <!-- 启用开关 -->
            <div class="entry-toggle" style="flex-shrink:0;margin-top:2px;width:36px;height:20px;border-radius:10px;background:${item.enabled !== false ? '#4CAF50' : '#ccc'};cursor:pointer;position:relative;transition:background 0.2s;">
                <div style="width:16px;height:16px;border-radius:50%;background:white;position:absolute;top:2px;${item.enabled !== false ? 'right:2px;' : 'left:2px;'};transition:left 0.2s,right 0.2s;box-shadow:0 1px 3px rgba(0,0,0,0.2);"></div>
            </div>
            <div style="flex:1;min-width:0;">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                    <input class="entry-title-input" value="${item.title}"
                           placeholder="输入标题..."
                           style="flex:1;border:none;font-size:15px;font-weight:600;color:#333;background:transparent;outline:none;padding:0;" />
                    <select class="entry-priority" style="padding:2px 6px;border-radius:8px;border:1px solid #e0e0e0;font-size:11px;color:#888;background:white;">
                        ${[1,2,3,4,5,6,7,8,9,10].map(v =>
                            `<option value="${v}" ${(item.priority ?? 6) === v ? 'selected' : ''}>P${v}</option>`
                        ).join('')}
                    </select>
                </div>
                <textarea class="entry-text-input" rows="2"
                          placeholder="输入内容……"
                          style="width:100%;border:none;font-size:13px;color:#666;background:transparent;resize:vertical;outline:none;padding:0;font-family:inherit;line-height:1.5;">${item.text}</textarea>
                <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
                    <span style="font-size:11px;color:#999;background:#f5f5f5;padding:2px 8px;border-radius:6px;">${activationLabel}</span>
                    <button class="delete-entry-btn" style="padding:2px 8px;border-radius:6px;border:none;background:transparent;color:#e53935;cursor:pointer;font-size:11px;opacity:0.5;transition:opacity 0.2s;"
                            onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.5">🗑️ 删除</button>
                </div>
            </div>
        </div>
    `;

    // 绑定开关事件
    const toggle = div.querySelector('.entry-toggle');
    toggle.addEventListener('click', function() {
        const idx = parseInt(div.dataset.index);
        entries[idx].enabled = !(entries[idx].enabled !== false);
        saveEntries(entries);
        // 刷新开关样式
        this.style.background = entries[idx].enabled !== false ? '#4CAF50' : '#ccc';
        const dot = this.querySelector('div');
        if (entries[idx].enabled !== false) {
            dot.style.left = 'auto';
            dot.style.right = '2px';
        } else {
            dot.style.left = '2px';
            dot.style.right = 'auto';
        }
    });

    // 绑定标题输入
    div.querySelector('.entry-title-input').addEventListener('input', function() {
        const idx = parseInt(div.dataset.index);
        entries[idx].title = this.value;
        saveEntries(entries);
    });

    // 绑定内容输入
    div.querySelector('.entry-text-input').addEventListener('input', function() {
        const idx = parseInt(div.dataset.index);
        entries[idx].text = this.value;
        saveEntries(entries);
    });

    // 绑定优先级变更
    div.querySelector('.entry-priority').addEventListener('change', function() {
        const idx = parseInt(div.dataset.index);
        entries[idx].priority = parseInt(this.value);
        saveEntries(entries);
    });

    // 绑定删除
    div.querySelector('.delete-entry-btn').addEventListener('click', function() {
        const idx = parseInt(div.dataset.index);
        entries.splice(idx, 1);
        saveEntries(entries);
        div.remove();
        updateAllIndices();
    });

    return div;
}

// ---- 更新所有 data-index ----
function updateAllIndices() {
    const container = document.querySelector('.entries-container');
    if (!container) return;
    const items = container.querySelectorAll('.world-entry');
    items.forEach((el, i) => { el.dataset.index = i; });
}

// ---- 渲染 ----
export function render({ memoryService } = {}) {
    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">${title}</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card" style="padding:0;">
                    <div style="padding:14px 16px;border-bottom:1px solid #f0f0f0;">
                        <div style="font-size:13px;color:#888;">共 ${entries.length} 条 · 已启用 ${entries.filter(e => e.enabled !== false).length} 条</div>
                    </div>
                    <div class="entries-container" style="padding:10px 14px;">
                        ${entries.map((item, index) => {
                            const activationLabel = item.activation === 'global' ? '全局生效'
                                : item.activation?.startsWith('char_') ? '指定角色生效'
                                : item.activation?.startsWith('scene_') ? '特定场景生效' : '全局生效';
                            return `
                                <div class="world-entry" data-index="${index}" data-id="${item.id}" style="
                                    background:${item.enabled !== false ? 'white' : '#f9f9f9'};
                                    border-radius:14px;padding:12px 14px;margin-bottom:8px;
                                    border:1px solid ${item.enabled !== false ? '#f0f0f0' : '#eee'};
                                    opacity:${item.enabled !== false ? '1' : '0.6'};
                                ">
                                    <div style="display:flex;align-items:flex-start;gap:10px;">
                                        <div class="entry-toggle" style="flex-shrink:0;margin-top:3px;width:36px;height:20px;border-radius:10px;background:${item.enabled !== false ? '#4CAF50' : '#ccc'};cursor:pointer;position:relative;transition:background 0.2s;">
                                            <div style="width:16px;height:16px;border-radius:50%;background:white;position:absolute;top:2px;${item.enabled !== false ? 'right:2px;' : 'left:2px;'};transition:left 0.2s,right 0.2s;box-shadow:0 1px 3px rgba(0,0,0,0.2);"></div>
                                        </div>
                                        <div style="flex:1;min-width:0;">
                                            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                                                <input class="entry-title-input" value="${item.title}"
                                                       placeholder="输入标题..."
                                                       style="flex:1;border:none;font-size:15px;font-weight:600;color:#333;background:transparent;outline:none;padding:0;" />
                                                <select class="entry-priority" style="padding:2px 6px;border-radius:8px;border:1px solid #e0e0e0;font-size:11px;color:#888;background:white;">
                                                    ${[1,2,3,4,5,6,7,8,9,10].map(v =>
                                                        `<option value="${v}" ${(item.priority ?? 6) === v ? 'selected' : ''}>P${v}</option>`
                                                    ).join('')}
                                                </select>
                                            </div>
                                            <textarea class="entry-text-input" rows="2"
                                                      placeholder="输入内容……"
                                                      style="width:100%;border:none;font-size:13px;color:#666;background:transparent;resize:vertical;outline:none;padding:0;font-family:inherit;line-height:1.5;">${item.text}</textarea>
                                            <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
                                                <span style="font-size:11px;color:#999;background:#f5f5f5;padding:2px 8px;border-radius:6px;">${activationLabel}</span>
                                                <button class="delete-entry-btn" style="padding:2px 8px;border-radius:6px;border:none;background:transparent;color:#e53935;cursor:pointer;font-size:11px;opacity:0.5;"
                                                        onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.5">🗑️ 删除</button>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                    <div style="padding:10px 14px 14px;">
                        <button id="addEntryBtn" style="
                            width:100%;padding:10px;border-radius:12px;border:2px dashed #9c27b0;
                            background:white;color:#9c27b0;cursor:pointer;font-size:14px;font-weight:600;
                        ">➕ 新增条目</button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// ---- 事件绑定 ----
export function bindEvents(container, { memoryService } = {}) {
    const entriesContainer = container.querySelector('.entries-container');

    // 开关点击
    container.querySelectorAll('.world-entry .entry-toggle').forEach(toggle => {
        toggle.addEventListener('click', function() {
            const div = this.closest('.world-entry');
            const idx = parseInt(div.dataset.index);
            entries[idx].enabled = !(entries[idx].enabled !== false);
            saveEntries(entries);
            // 刷新 UI
            const idx2 = parseInt(div.dataset.index);
            const newHtml = renderEntryCard(entries[idx2], idx2);
            div.outerHTML = newHtml;
            rebindEntry(entriesContainer.querySelector(`.world-entry[data-index="${idx2}"]`), parseInt(idx2));
        });
    });

    // 标题输入
    container.querySelectorAll('.entry-title-input').forEach(input => {
        input.addEventListener('input', function() {
            const div = this.closest('.world-entry');
            const idx = parseInt(div.dataset.index);
            entries[idx].title = this.value;
            saveEntries(entries);
        });
    });

    // 内容输入
    container.querySelectorAll('.entry-text-input').forEach(textarea => {
        textarea.addEventListener('input', function() {
            const div = this.closest('.world-entry');
            const idx = parseInt(div.dataset.index);
            entries[idx].text = this.value;
            saveEntries(entries);
        });
    });

    // 优先级变更
    container.querySelectorAll('.entry-priority').forEach(select => {
        select.addEventListener('change', function() {
            const div = this.closest('.world-entry');
            const idx = parseInt(div.dataset.index);
            entries[idx].priority = parseInt(this.value);
            saveEntries(entries);
        });
    });

    // 删除
    container.querySelectorAll('.delete-entry-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const div = this.closest('.world-entry');
            const idx = parseInt(div.dataset.index);
            entries.splice(idx, 1);
            saveEntries(entries);
            div.remove();
            updateAllIndices();
        });
    });

    // 新增
    const addBtn = container.querySelector('#addEntryBtn');
    if (addBtn) {
        addBtn.addEventListener('click', function() {
            const newItem = {
                id: genId(),
                title: '新条目',
                text: '在这里输入内容……',
                priority: 6,
                enabled: true,
                activation: 'global',
                tags: []
            };
            entries.push(newItem);
            saveEntries(entries);
            const newIndex = entries.length - 1;
            const newEl = createEntryElement(newItem, newIndex);
            entriesContainer.appendChild(newEl);
            newEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
    }
}

// ---- 辅助：渲染单条卡片（用于开关刷新）- 与上面 render 里的模板一致 ----
function renderEntryCard(item, index) {
    const activationLabel = item.activation === 'global' ? '全局生效'
        : item.activation?.startsWith('char_') ? '指定角色生效'
        : item.activation?.startsWith('scene_') ? '特定场景生效' : '全局生效';
    return `
        <div class="world-entry" data-index="${index}" data-id="${item.id}" style="
            background:${item.enabled !== false ? 'white' : '#f9f9f9'};
            border-radius:14px;padding:12px 14px;margin-bottom:8px;
            border:1px solid ${item.enabled !== false ? '#f0f0f0' : '#eee'};
            opacity:${item.enabled !== false ? '1' : '0.6'};
        ">
            <div style="display:flex;align-items:flex-start;gap:10px;">
                <div class="entry-toggle" style="flex-shrink:0;margin-top:3px;width:36px;height:20px;border-radius:10px;background:${item.enabled !== false ? '#4CAF50' : '#ccc'};cursor:pointer;position:relative;transition:background 0.2s;">
                    <div style="width:16px;height:16px;border-radius:50%;background:white;position:absolute;top:2px;${item.enabled !== false ? 'right:2px;' : 'left:2px;'};transition:left 0.2s,right 0.2s;box-shadow:0 1px 3px rgba(0,0,0,0.2);"></div>
                </div>
                <div style="flex:1;min-width:0;">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                        <input class="entry-title-input" value="${item.title}"
                               placeholder="输入标题..."
                               style="flex:1;border:none;font-size:15px;font-weight:600;color:#333;background:transparent;outline:none;padding:0;" />
                        <select class="entry-priority" style="padding:2px 6px;border-radius:8px;border:1px solid #e0e0e0;font-size:11px;color:#888;background:white;">
                            ${[1,2,3,4,5,6,7,8,9,10].map(v =>
                                `<option value="${v}" ${(item.priority ?? 6) === v ? 'selected' : ''}>P${v}</option>`
                            ).join('')}
                        </select>
                    </div>
                    <textarea class="entry-text-input" rows="2"
                              placeholder="输入内容……"
                              style="width:100%;border:none;font-size:13px;color:#666;background:transparent;resize:vertical;outline:none;padding:0;font-family:inherit;line-height:1.5;">${item.text}</textarea>
                    <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
                        <span style="font-size:11px;color:#999;background:#f5f5f5;padding:2px 8px;border-radius:6px;">${activationLabel}</span>
                        <button class="delete-entry-btn" style="padding:2px 8px;border-radius:6px;border:none;background:transparent;color:#e53935;cursor:pointer;font-size:11px;opacity:0.5;"
                                onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.5">🗑️ 删除</button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// ---- 辅助：重新绑定单条卡片的事件 ----
function rebindEntry(div, index) {
    if (!div) return;
    const toggle = div.querySelector('.entry-toggle');
    if (toggle) {
        toggle.addEventListener('click', function() {
            entries[index].enabled = !(entries[index].enabled !== false);
            saveEntries(entries);
            const newHtml = renderEntryCard(entries[index], index);
            div.outerHTML = newHtml;
            rebindEntry(document.querySelector(`.world-entry[data-index="${index}"]`), index);
        });
    }
    div.querySelector('.entry-title-input')?.addEventListener('input', function() {
        entries[index].title = this.value;
        saveEntries(entries);
    });
    div.querySelector('.entry-text-input')?.addEventListener('input', function() {
        entries[index].text = this.value;
        saveEntries(entries);
    });
    div.querySelector('.entry-priority')?.addEventListener('change', function() {
        entries[index].priority = parseInt(this.value);
        saveEntries(entries);
    });
    div.querySelector('.delete-entry-btn')?.addEventListener('click', function() {
        entries.splice(index, 1);
        saveEntries(entries);
        div.remove();
        updateAllIndices();
    });
}

if (!window.__moduleRegistry) window.__moduleRegistry = [];
window.__moduleRegistry.push({ id, label, icon, color, render, bindEvents });

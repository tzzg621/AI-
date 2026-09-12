// apps/worldDictionary.js - 优化版
// 世界词典页面模块
// 页面只负责展示和编辑，实际数据由 DictionaryStore 管理

import { esc } from '../store/utils.js';
import {
    listDictionaryEntries,
    saveDictionaryEntry,
    deleteDictionaryEntry,
    setDictionaryEntryEnabled
} from '../store/DictionaryStore.js';

export const id = 'worldDictionary';
export const label = '世界词典';
export const icon = '📖';
export const color = '#6f72c9';
export const title = '📖 世界词典';

// ========== 常量定义 ==========
const KIND_LABELS = {
    world_fact: '世界事实',
    character_belief: '角色认知',
    event: '事件',
    character_profile: '角色设定',
    world_rule: '世界规则'
};

const POLICY_LABELS = {
    manual: '手动维护',
    suggest: '建议更新',
    auto: '自动更新'
};

const SCOPE_LABELS = {
    global: '全局世界',
    character: '当前主视角',
    chat: '当前聊天'
};

// ========== 状态管理 ==========
class PageState {
    constructor() {
        this.pageRoot = null;
        this.pageContext = null;
        this.allEntries = [];
        this.filteredEntries = [];
        this.editingId = null;
        this.editorOpen = false;
        this.selectedEntryId = null;
        this.searchText = '';
        this.activeCategory = '全部';
        this.filterEnabled = 'all';
        this.isLoading = false;
        this.categories = [];
    }

    reset() {
        this.editingId = null;
        this.editorOpen = false;
        this.selectedEntryId = null;
    }

    updateEntries(entries) {
        this.allEntries = entries;
        this.categories = this.extractCategories();
        this.filteredEntries = this.filterEntries();
    }

    extractCategories() {
        const categorySet = new Set();

        for (const entry of this.allEntries) {
            if (Array.isArray(entry.categories)) {
                for (const category of entry.categories) {
                    const trimmed = String(category || '').trim();
                    if (trimmed) {
                        categorySet.add(trimmed);
                    }
                }
            }
        }

        return [...categorySet].sort((a, b) =>
            a.localeCompare(b, 'zh-CN')
        );
    }

    filterEntries() {
        const query = this.searchText.trim().toLocaleLowerCase();

        return this.allEntries.filter(entry => {
            // 类别过滤
            if (
                this.activeCategory !== '全部' &&
                !this.hasCategory(entry, this.activeCategory)
            ) {
                return false;
            }

            // 启用状态过滤
            if (this.filterEnabled === 'enabled' && entry.enabled === false) {
                return false;
            }
            if (this.filterEnabled === 'disabled' && entry.enabled !== false) {
                return false;
            }

            // 搜索过滤
            if (!query) return true;

            return this.matchesSearch(entry, query);
        });
    }

    hasCategory(entry, category) {
        return Array.isArray(entry.categories) &&
            entry.categories.includes(category);
    }

    matchesSearch(entry, query) {
        const searchableText = [
            entry.title,
            entry.content,
            ...(entry.categories || []),
            ...(entry.keywords || []),
            ...(entry.aliases || [])
        ]
            .filter(Boolean)
            .join('\n')
            .toLocaleLowerCase();

        return searchableText.includes(query);
    }

    setFilter(key, value) {
        this[key] = value;
        this.filteredEntries = this.filterEntries();
    }

    getEntry(id) {
        return this.allEntries.find(entry => entry.id === id);
    }
}

const state = new PageState();
let disposeCurrentPage = null;
let pageGeneration = 0;

// ========== 工具函数 ==========
function getCurrentActorId() {
    return state.pageContext?.globalState?.activeCharacter?.id || null;
}

function getCurrentActorName() {
    const active = state.pageContext?.globalState?.activeCharacter;
    return active?.base?.name || active?.name || '当前主视角';
}

function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '未知时间';
    }

    return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function splitList(value) {
    return String(value || '')
        .split(/[,，、\n]/)
        .map(item => item.trim())
        .filter(Boolean);
}

function getScopeLabel(entry) {
    const scope = entry.scope || {};

    if (scope.type === 'character') {
        const isCurrentActor = scope.characterId === getCurrentActorId();
        return isCurrentActor
            ? '当前主视角'
            : scope.characterNameSnapshot || `角色：${scope.characterId}`;
    }

    if (scope.type === 'chat') {
        return `聊天：${scope.pairKey || '未指定'}`;
    }

    return '全局世界';
}

// ========== 渲染函数 ==========
function renderCategoryTabs() {
    const categories = ['全部', ...state.categories];

    return `
        <div class="wd-category-scroll" role="tablist" aria-label="词条类别">
            ${categories.map(category => `
                <button
                    type="button"
                    class="wd-category-tab ${state.activeCategory === category ? 'is-active' : ''}"
                    data-action="category"
                    data-category="${esc(category)}"
                    role="tab"
                    aria-selected="${state.activeCategory === category}"
                >${esc(category)}</button>
            `).join('')}
        </div>
    `;
}

function renderEntry(entry) {
    const categories = entry.categories || [];
    const keywords = [
        ...(entry.keywords || []),
        ...(entry.aliases || [])
    ];

    return `
        <article
            class="wd-entry ${entry.enabled === false ? 'is-disabled' : ''}"
            data-action="open-detail"
            data-id="${esc(entry.id)}"
            tabindex="0"
            role="button"
            aria-label="查看词条：${esc(entry.title)}"
        >
            <div class="wd-entry-main">
                <div class="wd-entry-topline">
                    <h3>${esc(entry.title)}</h3>
<button
    type="button"
    class="wd-entry-toggle ${entry.enabled === false
            ? 'is-off'
            : 'is-on'
        }"
    data-action="toggle-enabled"
    data-id="${esc(entry.id)}"
    aria-label="${entry.enabled === false
            ? `启用词条：${entry.title}`
            : `停用词条：${entry.title}`
        }"
    aria-pressed="${entry.enabled !== false}"
>
    <span class="wd-toggle-dot"></span>
    <span class="wd-toggle-label">
        ${entry.enabled === false ? '已停用' : '已启用'}
    </span>
</button>
                </div>

                ${categories.length ? `
                    <div class="wd-entry-categories">
                        ${categories.map(cat => `
                            <span>${esc(cat)}</span>
                        `).join('')}
                    </div>
                ` : ''}

                <div class="wd-entry-meta">
                    <span>${esc(KIND_LABELS[entry.kind] || entry.kind)}</span>
                    <span>${esc(getScopeLabel(entry))}</span>
                    ${entry.priority !== 50 ? `<span>优先级 ${entry.priority}</span>` : ''}
                </div>

                <p class="wd-entry-content">${esc(entry.content)}</p>

                <div class="wd-entry-bottom">
                    <span>
                        ${keywords.length
            ? `${keywords.length} 个触发词`
            : '无触发词'}
                    </span>
                    <span class="wd-entry-arrow">›</span>
                </div>
            </div>
        </article>
    `;
}

function renderDetailModal() {
    const entry = state.getEntry(state.selectedEntryId);
    if (!entry) return '';

    const categories = entry.categories || [];
    const keywords = [...(entry.keywords || []), ...(entry.aliases || [])];

    return `
        <div class="wd-modal-backdrop" data-action="close-detail">
            <section
                class="wd-detail-modal"
                data-modal-panel
                role="dialog"
                aria-modal="true"
                aria-labelledby="modal-title"
            >
                <div class="wd-detail-head">
                    <div>
                        <div class="wd-detail-kicker">世界词典条目</div>
                        <h2 id="modal-title">${esc(entry.title)}</h2>
                    </div>
                    <button
                        type="button"
                        class="wd-icon-btn"
                        data-action="close-detail"
                        aria-label="关闭详情"
                    >×</button>
                </div>

                <div class="wd-detail-status-row">
                    <span class="wd-kind">
                        ${esc(KIND_LABELS[entry.kind] || entry.kind)}
                    </span>
<button
    type="button"
    class="wd-entry-toggle ${entry.enabled === false
            ? 'is-off'
            : 'is-on'
        }"
    data-action="toggle-enabled"
    data-id="${esc(entry.id)}"
    aria-label="${entry.enabled === false
            ? `启用词条：${entry.title}`
            : `停用词条：${entry.title}`
        }"
    aria-pressed="${entry.enabled !== false}"
>
    <span class="wd-toggle-dot"></span>
    <span class="wd-toggle-label">
        ${entry.enabled === false ? '已停用' : '已启用'}
    </span>
</button>
                </div>

                <div class="wd-detail-section">
                    <div class="wd-detail-label">类别标签</div>
                    <div class="wd-detail-tags">
                        ${categories.length
            ? categories.map(cat => `<span>${esc(cat)}</span>`).join('')
            : '<em>未设置类别</em>'}
                    </div>
                </div>

                <div class="wd-detail-section">
                    <div class="wd-detail-label">提示词内容</div>
                    <div class="wd-detail-content">${esc(entry.content)}</div>
                </div>

                <div class="wd-detail-section">
                    <div class="wd-detail-label">触发关键词与别名</div>
                    <div class="wd-detail-tags">
                        ${keywords.length
            ? keywords.map(kw => `<span>${esc(kw)}</span>`).join('')
            : '<em>未设置触发词</em>'}
                    </div>
                </div>

                <div class="wd-detail-info">
                    <div>
                        <span>作用范围</span>
                        <strong>${esc(getScopeLabel(entry))}</strong>
                    </div>
                    <div>
                        <span>优先级</span>
                        <strong>${entry.priority}</strong>
                    </div>
                    <div>
                        <span>更新方式</span>
                        <strong>${esc(POLICY_LABELS[entry.updatePolicy] || entry.updatePolicy)}</strong>
                    </div>
                </div>

                ${entry.createdAt ? `
                    <div class="wd-detail-section">
                        <div class="wd-detail-label">时间信息</div>
                        <div class="wd-detail-tags">
                            <em>创建：${formatDate(entry.createdAt)}</em>
                            ${entry.updatedAt ? `<em>更新：${formatDate(entry.updatedAt)}</em>` : ''}
                        </div>
                    </div>
                ` : ''}

                <div class="wd-detail-actions">
                    <button
                        type="button"
                        class="wd-btn wd-btn-primary"
                        data-action="edit"
                        data-id="${esc(entry.id)}"
                    >编辑词条</button>
                    <button
                        type="button"
                        class="wd-btn wd-btn-danger"
                        data-action="delete"
                        data-id="${esc(entry.id)}"
                    >删除</button>
                </div>
            </section>
        </div>
    `;
}

function renderForm() {
    const entry = state.editingId ? state.getEntry(state.editingId) : null;
    const currentActorId = getCurrentActorId();

    return `
        <section class="wd-editor" role="region" aria-label="词条编辑器">
            <div class="wd-editor-head">
                <div>
                    <strong>${entry ? '编辑词条' : '新增词条'}</strong>
                    <span>词条会保存到独立的世界词典数据库</span>
                </div>
                <button
                    type="button"
                    class="wd-icon-btn"
                    data-action="cancel-edit"
                    aria-label="关闭编辑器"
                >×</button>
            </div>

            <form id="wdEntryForm" class="wd-form">
                <label class="wd-field">
                    <span>词条名称 <abbr title="必填项">*</abbr></span>
                    <input
                        name="title"
                        maxlength="120"
                        required
                        value="${esc(entry?.title || '')}"
                        placeholder="例如：白塔禁区"
                        aria-required="true"
                    >
                </label>

                <label class="wd-field">
                    <span>提示词内容 <abbr title="必填项">*</abbr></span>
                    <textarea
                        name="content"
                        maxlength="12000"
                        required
                        placeholder="写入希望 AI 遵守的稳定设定……"
                        aria-required="true"
                    >${esc(entry?.content || '')}</textarea>
                </label>

                <label class="wd-field">
                    <span>类别标签</span>
                    <input
                        name="categories"
                        value="${esc((entry?.categories || []).join('、'))}"
                        placeholder="例如：地点、人物、组织、规则（用顿号或逗号分隔）"
                    >
                </label>

                <label class="wd-field">
                    <span>触发关键词</span>
                    <input
                        name="keywords"
                        value="${esc((entry?.keywords || []).join('、'))}"
                        placeholder="对话中提到这些词时触发，用顿号或逗号分隔"
                    >
                </label>

                <label class="wd-field">
                    <span>别名</span>
                    <input
                        name="aliases"
                        value="${esc((entry?.aliases || []).join('、'))}"
                        placeholder="可选，例如：白塔三层、禁塔"
                    >
                </label>

                <div class="wd-form-grid">
                    <label class="wd-field">
                        <span>词条类型</span>
                        <select name="kind">
                            ${Object.entries(KIND_LABELS).map(([value, label]) => `
                                <option
                                    value="${value}"
                                    ${(entry?.kind || 'world_fact') === value ? 'selected' : ''}
                                >${label}</option>
                            `).join('')}
                        </select>
                    </label>

                    <label class="wd-field">
                        <span>作用范围</span>
                        <select name="scopeType">
                            <option
                                value="global"
                                ${(!entry || entry.scope?.type === 'global') ? 'selected' : ''}
                            >全局世界</option>
                            <option
                                value="character"
                                ${entry?.scope?.type === 'character' ? 'selected' : ''}
                                ${currentActorId ? '' : 'disabled'}
                            >${currentActorId ? '当前主视角' : '（无主视角）'}</option>
                        </select>
                    </label>
                </div>

                <div class="wd-form-grid">
                    <label class="wd-field">
                        <span>优先级 (0-100)</span>
                        <input
                            name="priority"
                            type="number"
                            min="0"
                            max="100"
                            value="${entry?.priority ?? 50}"
                        >
                    </label>

                    <label class="wd-field">
                        <span>更新方式</span>
                        <select name="updatePolicy">
                            ${Object.entries(POLICY_LABELS).map(([value, label]) => `
                                <option
                                    value="${value}"
                                    ${(entry?.updatePolicy || 'manual') === value ? 'selected' : ''}
                                >${label}</option>
                            `).join('')}
                        </select>
                    </label>
                </div>

                <label class="wd-switch-row">
                    <input
                        name="enabled"
                        type="checkbox"
                        ${entry?.enabled === false ? '' : 'checked'}
                    >
                    <span>启用这个词条</span>
                </label>

                <button class="wd-submit" type="submit">
                    ${entry ? '💾 保存修改' : '✨ 创建词条'}
                </button>
            </form>
        </section>
    `;
}

function renderEmptyState() {
    const hasSearch = state.searchText.trim().length > 0;
    const hasCategory = state.activeCategory !== '全部';
    const hasFilter = state.filterEnabled !== 'all';

    return `
        <div class="wd-empty">
            <div>📖</div>
            <strong>
                ${hasSearch || hasCategory || hasFilter
            ? '没有匹配的词条'
            : '还没有世界词条'}
            </strong>
            <span>
                ${hasSearch || hasCategory || hasFilter
            ? '尝试更换分类、状态筛选或搜索内容'
            : '点击右上角"新词条"按钮添加第一条设定'}
            </span>
        </div>
    `;
}

function renderPage() {
    if (!state.pageRoot) return;

    const entries = state.filteredEntries;

    state.pageRoot.innerHTML = `
        <div class="screen-page wd-page">
            <div class="screen-header wd-header">
                <div class="screen-title">
                    <span class="wd-title-icon">📖</span>
                    世界词典
                </div>
                <button
                    type="button"
                    class="wd-add-btn"
                    data-action="new"
                    aria-label="新增词条"
                >＋ 新词条</button>
            </div>

            <div class="screen-content wd-content">
                <div class="wd-intro">
                    <strong>让世界设定在需要时自动出现</strong>
                    <span>
                        使用类别整理词条，通过关键词在对话中自动触发。支持角色专属设定和全局世界观。
                    </span>
                </div>

                ${state.editorOpen ? renderForm() : ''}

                <section class="wd-list-section">
                    <div class="wd-list-toolbar">
                        <input
                            class="wd-search"
                            type="search"
                            placeholder="🔍 搜索词条、类别、关键词或内容"
                            value="${esc(state.searchText)}"
                            aria-label="搜索词条"
                        >
                        <select
                            class="wd-filter-enabled"
                            aria-label="按状态筛选"
                        >
                            <option value="all">全部状态</option>
                            <option
                                value="enabled"
                                ${state.filterEnabled === 'enabled' ? 'selected' : ''}
                            >仅启用</option>
                            <option
                                value="disabled"
                                ${state.filterEnabled === 'disabled' ? 'selected' : ''}
                            >仅停用</option>
                        </select>
                    </div>

                    ${renderCategoryTabs()}

                    <div class="wd-list-head">
                        <strong>
                            ${state.activeCategory === '全部'
            ? '全部词条'
            : esc(state.activeCategory)}
                            · ${entries.length}
                        </strong>
                        <span>按优先级和更新时间排序</span>
                    </div>

                    ${state.isLoading ? `
                        <div class="wd-loading">加载中...</div>
                    ` : `
                        <div class="wd-list" role="list">
                            ${entries.length
            ? entries.map(renderEntry).join('')
            : renderEmptyState()}
                        </div>
                    `}
                </section>
            </div>

            ${state.selectedEntryId ? renderDetailModal() : ''}
        </div>
    `;
}

// ========== 数据操作 ==========
async function reload(generation = pageGeneration) {
    try {
        // 如果这次加载属于已经离开的旧页面，直接放弃。
        if (generation !== pageGeneration) {
            return;
        }

        state.isLoading = true;
        renderPage();

        const entries = await listDictionaryEntries({
            includeDisabled: true
        });

        // IndexedDB 返回期间用户可能已经切换页面。
        // 旧页面的异步结果不能再写入当前状态。
        if (generation !== pageGeneration) {
            return;
        }

        state.updateEntries(entries);
        state.isLoading = false;
        renderPage();
    } catch (error) {
        if (generation !== pageGeneration) {
            return;
        }

        state.isLoading = false;
        showError(error);
    }
}

function showError(error) {
    console.error('[WorldDictionary]', error);
    const message = error?.message || '世界词典操作失败';
    window.alert(message);
}

async function handleSubmit(form) {
    const formData = new FormData(form);
    const scopeType = formData.get('scopeType');
    const actorId = getCurrentActorId();

    if (scopeType === 'character' && !actorId) {
        throw new Error('当前没有可用的主视角角色，无法创建角色专属词条');
    }

    const existing = state.editingId ? state.getEntry(state.editingId) : null;

    const entryData = {
        id: state.editingId || undefined,
        title: formData.get('title'),
        content: formData.get('content'),
        keywords: splitList(formData.get('keywords')),
        aliases: splitList(formData.get('aliases')),
        categories: splitList(formData.get('categories')),
        kind: formData.get('kind'),
        priority: Number(formData.get('priority')),
        updatePolicy: formData.get('updatePolicy'),
        enabled: formData.get('enabled') === 'on',
        scope: scopeType === 'character'
            ? {
                type: 'character',
                characterId: actorId,
                characterNameSnapshot: getCurrentActorName()
            }
            : { type: 'global' },
        createdAt: existing?.createdAt
    };

    await saveDictionaryEntry(entryData);

    state.reset();
    await reload();
}


const pendingToggleIds = new Set();

async function handleToggleEnabled(id, event) {
    if (!id || pendingToggleIds.has(id)) {
        return;
    }

    const entry = state.getEntry(id);

    if (!entry) {
        return;
    }

    pendingToggleIds.add(id);

    const button = event.target.closest(
        '[data-action="toggle-enabled"]'
    );

    button?.classList.add('is-busy');
    button?.setAttribute('aria-busy', 'true');

    try {
        await setDictionaryEntryEnabled(
            id,
            entry.enabled === false
        );

        // setDictionaryEntryEnabled 已经发出
        // world-dictionary-changed 事件。
        // 由当前页面监听器统一 reload。
    } catch (error) {
        showError(error);
    } finally {
        pendingToggleIds.delete(id);
    }
}

// ========== 事件处理 ==========
function handleClick(event) {
    const actionElement = event.target.closest('[data-action]');
    if (!actionElement || !state.pageRoot.contains(actionElement)) {
        return;
    }

    const action = actionElement.dataset.action;
    const idValue = actionElement.dataset.id;

    switch (action) {
        case 'category':
            handleCategoryClick(actionElement);
            break;
        case 'toggle-enabled':
            event.preventDefault();
            event.stopPropagation();
            void handleToggleEnabled(idValue, event);
            break;

        case 'open-detail':
            handleOpenDetail(idValue);
            break;
        case 'close-detail':
            handleCloseDetail(event, actionElement);
            break;
        case 'new':
            handleNewEntry();
            break;
        case 'cancel-edit':
            handleCancelEdit();
            break;
        case 'edit':
            handleEditEntry(idValue);
            break;
        case 'delete':
            handleDeleteEntry(idValue);
            break;
    }
}

function handleCategoryClick(element) {
    state.setFilter('activeCategory', element.dataset.category || '全部');
    renderPage();
}

function handleOpenDetail(id) {
    state.selectedEntryId = id || null;
    state.editorOpen = false;
    state.editingId = null;
    renderPage();
}

function handleCloseDetail(event, actionElement) {
    const isBackdrop = event.target.classList.contains('wd-modal-backdrop');
    const isCloseButton = actionElement.matches('button[data-action="close-detail"]');

    if (isBackdrop || isCloseButton) {
        state.selectedEntryId = null;
        renderPage();
    }
}

function handleNewEntry() {
    state.reset();
    state.editorOpen = true;
    renderPage();

    requestAnimationFrame(() => {
        state.pageRoot.querySelector('#wdEntryForm input[name="title"]')?.focus();
    });
}

function handleCancelEdit() {
    state.reset();
    renderPage();
}

function handleEditEntry(id) {
    state.editingId = id || null;
    state.selectedEntryId = null;
    state.editorOpen = true;
    renderPage();

    requestAnimationFrame(() => {
        state.pageRoot.querySelector('#wdEntryForm input[name="title"]')?.focus();
    });
}

function handleDeleteEntry(id) {
    const entry = state.getEntry(id);
    if (!entry) return;

    const confirmed = window.confirm(
        `确定要删除词条"${entry.title}"吗？\n\n此操作无法撤销。`
    );

    if (!confirmed) return;

    deleteDictionaryEntry(id)
        .then(async () => {
            state.reset();
            await reload();
        })
        .catch(showError);
}

function handleSubmitEvent(event) {
    const form = event.target.closest('#wdEntryForm');
    if (!form || !state.pageRoot.contains(form)) return;

    event.preventDefault();
    handleSubmit(form).catch(showError);
}

function handleInput(event) {
    if (event.target.matches('.wd-search')) {
        state.setFilter('searchText', event.target.value);
        renderPage();

        // 保持焦点和光标位置
        const search = state.pageRoot.querySelector('.wd-search');
        if (search) {
            const cursorPos = event.target.selectionStart;
            requestAnimationFrame(() => {
                search.focus();
                search.setSelectionRange(cursorPos, cursorPos);
            });
        }
    }
}

function handleChange(event) {
    if (event.target.matches('.wd-filter-enabled')) {
        state.setFilter('filterEnabled', event.target.value);
        renderPage();
    }
}

function handleKeyDown(event) {
    // ESC 键关闭模态框或编辑器
    if (event.key === 'Escape') {
        if (state.selectedEntryId) {
            state.selectedEntryId = null;
            renderPage();
        } else if (state.editorOpen) {
            state.reset();
            renderPage();
        }
    }

    // Enter 键在条目上打开详情
    if (event.key === 'Enter') {
        const entry = event.target.closest('.wd-entry');
        if (entry) {
            const id = entry.dataset.id;
            if (id) {
                handleOpenDetail(id);
            }
        }
    }
}

export function handleBack() {
    disposeCurrentPage?.();
    return false;
}

// ========== 公共 API ==========
export function render(context = {}) {
    state.pageContext = context;
    return '<div class="wd-mount"></div>';
}

export function bindEvents(container, context = {}) {
    // 如果宿主没有调用上一次的清理函数，
    // 在重新进入世界词典时主动清理旧实例。
    disposeCurrentPage?.();

    pageGeneration += 1;
    const generation = pageGeneration;

    state.pageContext = context;
    state.pageRoot = container.querySelector('.wd-mount');

    if (!state.pageRoot) {
        return null;
    }

    state.reset();

    const root = state.pageRoot;
    let disposed = false;
    let domObserver = null;

    root.addEventListener('click', handleClick);
    root.addEventListener('submit', handleSubmitEvent);
    root.addEventListener('input', handleInput);
    root.addEventListener('change', handleChange);
    root.addEventListener('keydown', handleKeyDown);

    const handleDataChange = () => {
        // 页面已经被路由移除。
        // 这里主要是保险判断，真正的清理由 MutationObserver 完成。
        if (!root.isConnected) {
            dispose();
            return;
        }

        // 不是当前页面实例的事件，不处理。
        if (generation !== pageGeneration) {
            return;
        }

        void reload(generation);
    };

    window.addEventListener(
        'world-dictionary-changed',
        handleDataChange
    );

    /*
     * app.js 切换模块时会替换 pageContainer 内部的 DOM。
     * 观察 container，而不是观察 root：
     *
     * - root 被移除时，可以发现并清理；
     * - root 内部 renderPage() 更新 HTML 时，root 仍然存在，不会误清理。
     */
    if (typeof MutationObserver === 'function') {
        domObserver = new MutationObserver(() => {
            if (!root.isConnected) {
                dispose();
            }
        });

        domObserver.observe(container, {
            childList: true,
            subtree: true
        });
    }

    const dispose = () => {
        if (disposed) {
            return;
        }

        disposed = true;

        /*
         * 让当前页面正在进行的旧异步加载失效。
         * 例如 IndexedDB 读取尚未完成时切换了页面，
         * 读取完成后不会再更新旧页面状态。
         */
        if (generation === pageGeneration) {
            pageGeneration += 1;
        }

        root.removeEventListener('click', handleClick);
        root.removeEventListener('submit', handleSubmitEvent);
        root.removeEventListener('input', handleInput);
        root.removeEventListener('change', handleChange);
        root.removeEventListener('keydown', handleKeyDown);

        window.removeEventListener(
            'world-dictionary-changed',
            handleDataChange
        );

        domObserver?.disconnect();
        domObserver = null;

        if (state.pageRoot === root) {
            state.pageRoot = null;
        }

        /*
         * 只有当前 dispose 仍然是活跃实例的清理函数时，
         * 才清空引用，避免误清理后来创建的新实例。
         */
        if (disposeCurrentPage === dispose) {
            disposeCurrentPage = null;
        }
    };

    disposeCurrentPage = dispose;

    // 只让当前页面实例执行首次加载。
    void reload(generation);

    /*
     * 当前 app.js 暂时不会接收这个返回值，
     * 但保留返回值方便以后接入统一生命周期管理。
     */
    return dispose;
}

// ========== 模块注册 ==========
if (!window.__moduleRegistry) {
    window.__moduleRegistry = [];
}

window.__moduleRegistry.push({
    id,
    label,
    icon,
    color,
    render,
    bindEvents,
    handleBack
});
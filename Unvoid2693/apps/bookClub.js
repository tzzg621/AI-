// apps/bookClub.js
// 茶舍：缔造者维护的世界故事库 / 说书剧场
//
// 数据边界：
// - 所有剧目独立保存于 teaHouseDB / stories。
// - 角色只以 narratorCharacterId、relatedCharacterIds 形式被引用。
// - 不向 CharacterStore 写入故事，不复制角色档案。
// - 旧 localStorage['bookclub_novels'] 由 TeaHouseStore 首次初始化时安全迁移。

import { callAIForStory } from './aiService.js';
import { STORY_WRITING_PROMPT } from './prompts.js';
import { taskManager } from '../store/AITaskManager.js';

import {
    initTeaHouseStore,
    getAllStories,
    getStory,
    createStory,
    updateStory,
    deleteStory,
    normalizeStory
} from '../store/TeaHouseStore.js';

import {
    getAllCharacterIds,
    getCharacterNameById,
    getCharacterRecordById
} from './characterManager.js';

// -----------------------------------------------------------------------------
// 动态加载模块样式
// -----------------------------------------------------------------------------

(function loadTeaHouseStyle() {
    const styleId = 'bookClub-style';

    if (document.getElementById(styleId)) return;

    const link = document.createElement('link');
    link.id = styleId;
    link.rel = 'stylesheet';
    link.href = 'apps/bookClub.css';
    document.head.appendChild(link);
})();

// -----------------------------------------------------------------------------
// 状态
// -----------------------------------------------------------------------------

let stories = [];
let storeReady = false;
let storeLoading = false;
let storeError = null;

let viewingStoryId = null;
let viewingChapterId = null;

let showCreateForm = false;
let showEditForm = false;
let showChapterForm = false;
let editingChapterId = null;

let selectedCharacterFilterId = '';
let aiGenerating = false;

// pageContainer 在 app.js 中会被反复替换内容。
// WeakSet 确保同一个容器只注册一次委托事件。
const boundContainers = new WeakSet();

// -----------------------------------------------------------------------------
// 基础工具
// -----------------------------------------------------------------------------

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function escapeAttr(value) {
    return escapeHtml(value);
}

function createId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
}

function nowISO() {
    return new Date().toISOString();
}

function uniqueStringIds(values) {
    if (!Array.isArray(values)) return [];

    return [...new Set(
        values
            .map(value => String(value || '').trim())
            .filter(Boolean)
    )];
}

function getCharacterIds() {
    try {
        return uniqueStringIds(getAllCharacterIds());
    } catch (error) {
        console.warn('[茶舍] 角色目录读取失败：', error);
        return [];
    }
}

function getCharacterName(id) {
    if (!id) return '';

    try {
        return getCharacterNameById(id) || String(id);
    } catch {
        return String(id);
    }
}

function getStoryFromCache(storyId) {
    return stories.find(story => story.id === storyId) || null;
}

function getNarratorLabel(story) {
    if (story?.narratorCharacterId) {
        return getCharacterName(story.narratorCharacterId);
    }

    // 兼容旧书社中 author 字段迁移得到的 legacyAuthor。
    if (story?.legacyAuthor) {
        return story.legacyAuthor;
    }

    return '无名说书人';
}

function getRelatedNames(story, maximum = 3) {
    const ids = uniqueStringIds(story?.relatedCharacterIds);
    const names = ids.slice(0, maximum).map(getCharacterName);

    if (ids.length > maximum) {
        names.push(`另${ids.length - maximum}位`);
    }

    return names;
}

function getFoldLabel(index) {
    return `第${index + 1}折`;
}

function storyMatchesFilter(story) {
    if (!selectedCharacterFilterId) return true;

    return story.narratorCharacterId === selectedCharacterFilterId
        || story.relatedCharacterIds.includes(selectedCharacterFilterId);
}

function getFilteredStories() {
    return stories.filter(storyMatchesFilter);
}

function isTeaHouseVisible() {
    return Boolean(document.querySelector('.th-page'));
}

function showToast(message, type = 'normal') {
    const toast = document.createElement('div');
    toast.className = `th-toast th-toast--${type}`;
    toast.textContent = message;

    document.body.appendChild(toast);

    window.setTimeout(() => {
        toast.classList.add('is-leaving');

        window.setTimeout(() => {
            toast.remove();
        }, 180);
    }, 2600);
}

function showConfirm(message, confirmText = '确定') {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'th-dialog-overlay';

        overlay.innerHTML = `
            <div class="th-dialog-card" role="dialog" aria-modal="true">
                <div class="th-dialog-seal">茶</div>
                <div class="th-dialog-message">${escapeHtml(message)}</div>

                <div class="th-dialog-actions">
                    <button type="button" class="th-dialog-cancel">取消</button>
                    <button type="button" class="th-dialog-confirm">
                        ${escapeHtml(confirmText)}
                    </button>
                </div>
            </div>
        `;

        function finish(result) {
            overlay.remove();
            resolve(result);
        }

        overlay.querySelector('.th-dialog-cancel')
            .addEventListener('click', () => finish(false));

        overlay.querySelector('.th-dialog-confirm')
            .addEventListener('click', () => finish(true));

        overlay.addEventListener('click', event => {
            if (event.target === overlay) finish(false);
        });

        document.body.appendChild(overlay);
    });
}

// -----------------------------------------------------------------------------
// 异步初始化与页面刷新
// -----------------------------------------------------------------------------

async function loadStories() {
    storeLoading = true;
    storeError = null;

    try {
        await initTeaHouseStore();
        stories = await getAllStories();
        storeReady = true;
    } catch (error) {
        console.error('[茶舍] IndexedDB 初始化失败：', error);
        storeError = error;
        storeReady = false;
    } finally {
        storeLoading = false;
    }

    return stories;
}

function ensureStoreReady() {
    if (storeReady || storeLoading) return;

    void loadStories().then(() => {
        // 若用户已经离开茶舍，不得把其他模块页面覆盖掉。
        refreshTeaHouseIfVisible();
    });
}

function refresh(container) {
    if (!container) return;

    container.innerHTML = render();
    bindEvents(container);
}

function refreshTeaHouseIfVisible() {
    if (!isTeaHouseVisible()) return;

    const container = document.getElementById('pageContainer');

    if (container) {
        refresh(container);
    }
}

function resetToHome() {
    viewingStoryId = null;
    viewingChapterId = null;

    showCreateForm = false;
    showEditForm = false;
    showChapterForm = false;

    editingChapterId = null;
}

// -----------------------------------------------------------------------------
// 页面 HTML：公共片段
// -----------------------------------------------------------------------------

function renderLoadingPage() {
    return `
        <div class="screen-page th-page" data-tea-house-page="home">
            <div class="screen-header th-screen-header">
                <div class="screen-title">🍵 茶舍</div>
                <div class="header-spacer"></div>
            </div>

            <div class="screen-content th-screen-content">
                <div class="th-ai-generating">
                    <div class="th-ai-generating__seal">茶</div>
                    <div class="th-ai-generating__spark">✦</div>
                    <strong>正在整理茶舍卷宗</strong>
                    <span>茶舍故事库正在从本地资料中读取。</span>
                </div>
            </div>
        </div>
    `;
}

function renderStoreErrorPage() {
    return `
        <div class="screen-page th-page" data-tea-house-page="home">
            <div class="screen-header th-screen-header">
                <div class="screen-title">🍵 茶舍</div>
                <div class="header-spacer"></div>
            </div>

            <div class="screen-content th-screen-content">
                <div class="th-ai-generating">
                    <div class="th-ai-generating__seal">！</div>
                    <strong>茶舍卷宗暂时无法打开</strong>
                    <span>
                        ${escapeHtml(
                            storeError?.message
                            || '浏览器未能访问 IndexedDB。'
                        )}
                    </span>

                    <button type="button" data-action="retry-store">
                        再试一次
                    </button>
                </div>
            </div>
        </div>
    `;
}

function renderCharacterOptions(selectedId = '', allowEmpty = true) {
    const ids = getCharacterIds();

    const emptyOption = allowEmpty
        ? `<option value="">不指定（以缔造者口吻收录）</option>`
        : '';

    return emptyOption + ids.map(id => `
        <option
            value="${escapeAttr(id)}"
            ${id === selectedId ? 'selected' : ''}
        >
            ${escapeHtml(getCharacterName(id))}
        </option>
    `).join('');
}

function renderCharacterChecklist(selectedIds = []) {
    const selectedIdSet = new Set(uniqueStringIds(selectedIds));
    const ids = getCharacterIds();

    if (ids.length === 0) {
        return `
            <div class="th-character-empty">
                角色目录暂为空。故事可先行收录，日后再补充关联。
            </div>
        `;
    }

    return `
        <div class="th-character-list">
            ${ids.map(id => `
                <label class="th-character-check">
                    <input
                        type="checkbox"
                        name="thRelatedCharacter"
                        value="${escapeAttr(id)}"
                        ${selectedIdSet.has(id) ? 'checked' : ''}
                    />
                    <span class="th-character-check__mark">✓</span>
                    <span class="th-character-check__name">
                        ${escapeHtml(getCharacterName(id))}
                    </span>
                </label>
            `).join('')}
        </div>
    `;
}

function renderRelatedLine(story) {
    const names = getRelatedNames(story);

    if (!names.length) {
        return `<span class="th-story-meta__muted">未系角色</span>`;
    }

    return `
        <span class="th-story-meta__label">牵连</span>
        <span>${escapeHtml(names.join('、'))}</span>
    `;
}

function renderStoryShelfItem(story) {
    const foldCount = story.chapters.length;

    return `
        <button
            type="button"
            class="th-shelf-book"
            data-action="open-story"
            data-story-id="${escapeAttr(story.id)}"
        >
            <span class="th-shelf-book__spine"></span>
            <span class="th-shelf-book__cover">
                ${escapeHtml(story.emoji || '📜')}
            </span>

            <span class="th-shelf-book__body">
                <span class="th-shelf-book__title">
                    ${escapeHtml(story.title)}
                </span>

                <span class="th-shelf-book__sub">
                    ${escapeHtml(getNarratorLabel(story))} · ${foldCount} 折
                </span>

                <span class="th-shelf-book__related">
                    ${renderRelatedLine(story)}
                </span>
            </span>

            <span class="th-shelf-book__arrow">›</span>
        </button>
    `;
}

function renderFilterBar() {
    const selectedLabel = selectedCharacterFilterId
        ? getCharacterName(selectedCharacterFilterId)
        : '全部故事';

    const ids = getCharacterIds();

    return `
        <div class="th-filter-bar">
            <button
                type="button"
                class="th-filter-current"
                data-action="toggle-filter"
                aria-expanded="false"
            >
                <span class="th-filter-current__prefix">书架</span>
                <span class="th-filter-current__value">
                    ${escapeHtml(selectedLabel)}
                </span>
                <span class="th-filter-current__arrow">⌄</span>
            </button>

            <div class="th-filter-menu" hidden>
                <button
                    type="button"
                    class="th-filter-option ${!selectedCharacterFilterId ? 'is-selected' : ''}"
                    data-action="set-filter"
                    data-character-id=""
                >
                    全部故事
                </button>

                ${ids.length
                    ? ids.map(id => `
                        <button
                            type="button"
                            class="th-filter-option ${
                                selectedCharacterFilterId === id ? 'is-selected' : ''
                            }"
                            data-action="set-filter"
                            data-character-id="${escapeAttr(id)}"
                        >
                            ${escapeHtml(getCharacterName(id))}
                        </button>
                    `).join('')
                    : `<div class="th-filter-empty">暂无可筛选角色</div>`
                }
            </div>
        </div>
    `;
}

// -----------------------------------------------------------------------------
// 首页：场景式茶舍
// -----------------------------------------------------------------------------

function renderTeaHouseHome() {
    const filteredStories = getFilteredStories();
    const filterName = selectedCharacterFilterId
        ? getCharacterName(selectedCharacterFilterId)
        : '';

    return `
        <div class="screen-page th-page" data-tea-house-page="home">
            <div class="screen-header th-screen-header">
                <div class="screen-title">🍵 茶舍</div>
                <div class="header-spacer"></div>
            </div>

            <div class="screen-content th-screen-content">
                <section class="th-hero">
                    <div class="th-hero__steam th-hero__steam--one"></div>
                    <div class="th-hero__steam th-hero__steam--two"></div>
                    <div class="th-hero__seal">茶</div>

                    <div class="th-hero__text">
                        <div class="th-hero__eyebrow">WORLD STORYHOUSE</div>
                        <h2>一盏茶，听一段人间旧闻</h2>
                        <p>缔造者收录的剧目，静待翻阅。</p>
                    </div>

                    <div class="th-hero__cup" aria-hidden="true">🍵</div>
                </section>

                <section class="th-scene-section th-scene-section--shelf">
                    <div class="th-section-heading">
                        <div>
                            <span class="th-section-heading__eyebrow">第一席</span>
                            <h3>故事书架</h3>
                        </div>

                        <button
                            type="button"
                            class="th-create-story-btn"
                            data-action="create-story"
                        >
                            <span>＋</span> 收录剧目
                        </button>
                    </div>

                    ${renderFilterBar()}

                    <div class="th-shelf">
                        <div class="th-shelf__wood th-shelf__wood--top"></div>

                        ${filteredStories.length
                            ? filteredStories.map(renderStoryShelfItem).join('')
                            : `
                                <div class="th-shelf-empty">
                                    <div class="th-shelf-empty__icon">📜</div>

                                    <div class="th-shelf-empty__title">
                                        ${filterName
                                            ? `暂无与“${escapeHtml(filterName)}”有关的剧目`
                                            : '书架尚未收录剧目'
                                        }
                                    </div>

                                    <div class="th-shelf-empty__desc">
                                        ${stories.length
                                            ? '换一位角色看看，或收录新的故事。'
                                            : '惊堂木未响，先为这方世界记下一段故事吧。'
                                        }
                                    </div>

                                    <button
                                        type="button"
                                        class="th-empty-create-btn"
                                        data-action="create-story"
                                    >
                                        收录第一则剧目
                                    </button>
                                </div>
                            `
                        }

                        <div class="th-shelf__wood th-shelf__wood--bottom"></div>
                    </div>
                </section>

                <section class="th-scene-section th-scene-section--stage">
                    <div class="th-section-heading">
                        <div>
                            <span class="th-section-heading__eyebrow">第二席</span>
                            <h3>说书台 · 事件</h3>
                        </div>

                        <span class="th-section-heading__future">敬请期待</span>
                    </div>

                    <div class="th-stage-placeholder">
                        <div class="th-stage-placeholder__curtain th-stage-placeholder__curtain--left"></div>
                        <div class="th-stage-placeholder__curtain th-stage-placeholder__curtain--right"></div>
                        <div class="th-stage-placeholder__wood">▰</div>

                        <div class="th-stage-placeholder__text">
                            <strong>惊堂木未落，今日暂无新事。</strong>
                            <span>未来将在这里呈现角色个人事件剧场。</span>
                        </div>
                    </div>
                </section>

                <section class="th-scene-section th-scene-section--guests">
                    <div class="th-section-heading">
                        <div>
                            <span class="th-section-heading__eyebrow">第三席</span>
                            <h3>茶席 · 在场角色</h3>
                        </div>

                        <span class="th-section-heading__future">敬请期待</span>
                    </div>

                    <div class="th-guests-placeholder">
                        <div class="th-guests-placeholder__table"></div>
                        <div class="th-guests-placeholder__cup">◡</div>

                        <div class="th-guests-placeholder__text">
                            茶席尚空，静候来客。
                            <small>未来可在此承接阅读反应与角色互动。</small>
                        </div>
                    </div>
                </section>
            </div>
        </div>
    `;
}

// -----------------------------------------------------------------------------
// 剧目详情
// -----------------------------------------------------------------------------

function renderStoryDetail(storyId) {
    const story = getStoryFromCache(storyId);

    if (!story) {
        resetToHome();
        return renderTeaHouseHome();
    }

    const relatedNames = getRelatedNames(story, 99);

    return `
        <div class="screen-page th-page" data-tea-house-page="detail">
            <div class="screen-header th-screen-header">
                <button
                    type="button"
                    class="th-header-back"
                    data-action="back-home"
                    aria-label="返回茶舍书架"
                >←</button>

                <div class="screen-title th-screen-title">
                    ${escapeHtml(story.emoji)} ${escapeHtml(story.title)}
                </div>

                <div class="header-spacer"></div>
            </div>

            <div class="screen-content th-screen-content">
                <section class="th-story-banner">
                    <div class="th-story-banner__emoji">
                        ${escapeHtml(story.emoji)}
                    </div>

                    <div class="th-story-banner__content">
                        <span class="th-story-banner__eyebrow">茶舍收录剧目</span>
                        <h2>${escapeHtml(story.title)}</h2>
                        <p>${escapeHtml(story.synopsis || '暂无题记。')}</p>
                    </div>
                </section>

                <section class="th-story-info-card">
                    <div class="th-story-info-row">
                        <span>说书人</span>
                        <strong>${escapeHtml(getNarratorLabel(story))}</strong>
                    </div>

                    <div class="th-story-info-row">
                        <span>关联角色</span>
                        <strong>
                            ${escapeHtml(
                                relatedNames.length ? relatedNames.join('、') : '未指定'
                            )}
                        </strong>
                    </div>

                    <div class="th-story-info-row">
                        <span>已收录</span>
                        <strong>${story.chapters.length} 折</strong>
                    </div>

                    ${story.writingStyle ? `
                        <div class="th-story-info-note">
                            <span>文风</span>
                            ${escapeHtml(story.writingStyle)}
                        </div>
                    ` : ''}

                    ${story.notes ? `
                        <div class="th-story-info-note">
                            <span>备忘</span>
                            ${escapeHtml(story.notes)}
                        </div>
                    ` : ''}
                </section>

                <section class="th-fold-section">
                    <div class="th-section-heading th-section-heading--compact">
                        <div>
                            <span class="th-section-heading__eyebrow">剧目目录</span>
                            <h3>回目与折子</h3>
                        </div>
                    </div>

                    ${story.chapters.length
                        ? `
                            <div class="th-fold-list">
                                ${story.chapters.map((chapter, index) => `
                                    <button
                                        type="button"
                                        class="th-fold-item ${
                                            chapter._generating ? 'is-generating' : ''
                                        }"
                                        data-action="open-chapter"
                                        data-chapter-id="${escapeAttr(chapter.id)}"
                                    >
                                        <span class="th-fold-item__number">
                                            ${chapter._generating ? '⋯' : index + 1}
                                        </span>

                                        <span class="th-fold-item__body">
                                            <strong>
                                                ${chapter._generating
                                                    ? '茶烟未散，正在续写…'
                                                    : escapeHtml(
                                                        chapter.title || getFoldLabel(index)
                                                    )
                                                }
                                            </strong>

                                            <small>
                                                ${chapter._generating
                                                    ? 'AI 正在撰写这一折'
                                                    : escapeHtml(
                                                        chapter.summary
                                                        || chapter.content.slice(0, 34)
                                                        || '这一折尚未落字'
                                                    )
                                                }
                                            </small>
                                        </span>

                                        <span class="th-fold-item__arrow">›</span>
                                    </button>
                                `).join('')}
                            </div>
                        `
                        : `
                            <div class="th-fold-empty">
                                <span>惊堂木尚未敲响。</span>
                                <small>为这则剧目添上第一折吧。</small>
                            </div>
                        `
                    }
                </section>

                <div class="th-story-actions">
                    <button
                        type="button"
                        class="th-action-btn th-action-btn--primary"
                        data-action="add-chapter"
                    >
                        ✍️ 新添一折
                    </button>

                    <button
                        type="button"
                        class="th-action-btn"
                        data-action="edit-story"
                        aria-label="编辑剧目"
                    >
                        ✏️
                    </button>

                    <button
                        type="button"
                        class="th-action-btn th-action-btn--danger"
                        data-action="delete-story"
                        aria-label="删除剧目"
                    >
                        🗑️
                    </button>
                </div>
            </div>
        </div>
    `;
}

// -----------------------------------------------------------------------------
// 剧目收录 / 编辑页
// -----------------------------------------------------------------------------

function renderStoryForm(story, mode) {
    const isEdit = mode === 'edit';

    const safeStory = story || normalizeStory({
        emoji: '📜',
        title: '',
        synopsis: '',
        narratorCharacterId: '',
        relatedCharacterIds: [],
        writingStyle: '',
        notes: ''
    });

    return `
        <div class="screen-page th-page" data-tea-house-page="story-form">
            <div class="screen-header th-screen-header">
                <button
                    type="button"
                    class="th-header-back"
                    data-action="cancel-story-form"
                    aria-label="返回"
                >←</button>

                <div class="screen-title">
                    ${isEdit ? '✏️ 修订剧目' : '📜 收录新剧目'}
                </div>

                <div class="header-spacer"></div>
            </div>

            <div class="screen-content th-screen-content">
                <form class="th-form" id="thStoryForm">
                    <div class="th-form__intro">
                        <span>
                            ${isEdit
                                ? '修订茶舍卷宗'
                                : '为世界留下一段可被讲述的旧闻'
                            }
                        </span>
                    </div>

                    <div class="th-form-row th-form-row--emoji-title">
                        <label class="th-field th-field--emoji">
                            <span>卷面</span>
                            <input
                                id="thStoryEmoji"
                                type="text"
                                maxlength="4"
                                value="${escapeAttr(safeStory.emoji || '📜')}"
                            />
                        </label>

                        <label class="th-field th-field--grow">
                            <span>剧目标题 <em>*</em></span>
                            <input
                                id="thStoryTitle"
                                type="text"
                                maxlength="80"
                                placeholder="例如：春雨旧闻"
                                value="${escapeAttr(safeStory.title)}"
                            />
                        </label>
                    </div>

                    <label class="th-field">
                        <span>题记 / 简介</span>
                        <textarea
                            id="thStorySynopsis"
                            rows="3"
                            maxlength="500"
                            placeholder="这则故事想讲述什么？"
                        >${escapeHtml(safeStory.synopsis)}</textarea>
                    </label>

                    <label class="th-field">
                        <span>
                            说书人
                            <small>可选，仅代表叙述口吻，不代表故事归属</small>
                        </span>

                        <select id="thNarratorCharacter">
                            ${renderCharacterOptions(
                                safeStory.narratorCharacterId,
                                true
                            )}
                        </select>
                    </label>

                    <div class="th-field">
                        <span>
                            关联角色
                            <small>故事仅保存角色 ID，不复制角色资料</small>
                        </span>

                        ${renderCharacterChecklist(safeStory.relatedCharacterIds)}
                    </div>

                    <label class="th-field">
                        <span>文风与偏好</span>
                        <textarea
                            id="thStoryStyle"
                            rows="2"
                            maxlength="500"
                            placeholder="例如：说书人口吻、克制留白、偏古风……"
                        >${escapeHtml(safeStory.writingStyle)}</textarea>
                    </label>

                    <label class="th-field">
                        <span>缔造者备忘</span>
                        <textarea
                            id="thStoryNotes"
                            rows="2"
                            maxlength="500"
                            placeholder="角色关系、伏笔、后续构思等，仅供创作参考。"
                        >${escapeHtml(safeStory.notes)}</textarea>
                    </label>

                    <div class="th-form-actions">
                        <button
                            type="button"
                            class="th-action-btn"
                            data-action="cancel-story-form"
                        >
                            取消
                        </button>

                        <button
                            type="submit"
                            class="th-action-btn th-action-btn--primary"
                        >
                            ${isEdit ? '保存修订' : '收录剧目'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    `;
}

// -----------------------------------------------------------------------------
// 新增 / 编辑折子
// -----------------------------------------------------------------------------

function renderChapterForm(storyId, chapterId) {
    const story = getStoryFromCache(storyId);

    if (!story) {
        resetToHome();
        return renderTeaHouseHome();
    }

    const isEdit = Boolean(chapterId);
    const chapter = isEdit
        ? story.chapters.find(item => item.id === chapterId)
        : null;

    if (isEdit && !chapter) {
        viewingChapterId = null;
        return renderStoryDetail(storyId);
    }

    return `
        <div class="screen-page th-page" data-tea-house-page="fold-form">
            <div class="screen-header th-screen-header">
                <button
                    type="button"
                    class="th-header-back"
                    data-action="cancel-chapter-form"
                    aria-label="返回"
                >←</button>

                <div class="screen-title">
                    ${isEdit ? '✏️ 修订一折' : '✍️ 新添一折'}
                </div>

                <div class="header-spacer"></div>
            </div>

            <div class="screen-content th-screen-content">
                <form class="th-form" id="thChapterForm">
                    <div class="th-form__intro">
                        <span>剧目：《${escapeHtml(story.title)}》</span>
                    </div>

                    <label class="th-field">
                        <span>回目</span>
                        <input
                            id="thChapterTitle"
                            type="text"
                            maxlength="100"
                            placeholder="例如：第一折：檐下避雨"
                            value="${escapeAttr(chapter?.title || '')}"
                        />
                    </label>

                    <label class="th-field">
                        <span>正文</span>
                        <textarea
                            id="thChapterContent"
                            class="th-story-editor"
                            rows="15"
                            maxlength="30000"
                            placeholder="且说……"
                        >${escapeHtml(chapter?.content || '')}</textarea>
                    </label>

                    <label class="th-field">
                        <span>本折摘要</span>
                        <input
                            id="thChapterSummary"
                            type="text"
                            maxlength="300"
                            placeholder="这一折讲了什么？"
                            value="${escapeAttr(chapter?.summary || '')}"
                        />
                    </label>

                    <div class="th-form-actions th-form-actions--three">
                        <button
                            type="button"
                            class="th-action-btn th-action-btn--ai"
                            data-action="ai-write"
                            ${aiGenerating ? 'disabled' : ''}
                        >
                            🤖 AI 续写
                        </button>

                        <button
                            type="button"
                            class="th-action-btn"
                            data-action="cancel-chapter-form"
                        >
                            取消
                        </button>

                        <button
                            type="submit"
                            class="th-action-btn th-action-btn--primary"
                        >
                            保存此折
                        </button>
                    </div>
                </form>
            </div>
        </div>
    `;
}

// -----------------------------------------------------------------------------
// 阅读折子
// -----------------------------------------------------------------------------

function renderChapterReader(storyId, chapterId) {
    const story = getStoryFromCache(storyId);

    if (!story) {
        resetToHome();
        return renderTeaHouseHome();
    }

    const chapterIndex = story.chapters.findIndex(
        chapter => chapter.id === chapterId
    );

    const chapter = story.chapters[chapterIndex];

    if (!chapter) {
        viewingChapterId = null;
        return renderStoryDetail(storyId);
    }

    if (chapter._generating) {
        return `
            <div class="screen-page th-page" data-tea-house-page="reading">
                <div class="screen-header th-screen-header">
                    <button
                        type="button"
                        class="th-header-back"
                        data-action="back-story"
                        aria-label="返回目录"
                    >←</button>

                    <div class="screen-title">茶烟未散</div>
                    <div class="header-spacer"></div>
                </div>

                <div class="screen-content th-screen-content">
                    <div class="th-ai-generating">
                        <div class="th-ai-generating__seal">茶</div>
                        <div class="th-ai-generating__spark">✦</div>

                        <strong>说书人正在续写这一折</strong>

                        <span>
                            可先离开茶舍，任务完成后会自动写入 IndexedDB。
                        </span>

                        <button type="button" data-action="back-story">
                            返回剧目目录
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    const previousChapter = chapterIndex > 0
        ? story.chapters[chapterIndex - 1]
        : null;

    const nextChapter = chapterIndex < story.chapters.length - 1
        ? story.chapters[chapterIndex + 1]
        : null;

    const contentHtml = chapter.content
        ? chapter.content.split('\n').map(line => {
            const text = line.trim();

            return text
                ? `<p>${escapeHtml(text)}</p>`
                : `<div class="th-reading-gap"></div>`;
        }).join('')
        : `<p class="th-reading-empty">（这一折尚未落字。）</p>`;

    return `
        <div class="screen-page th-page" data-tea-house-page="reading">
            <div class="screen-header th-screen-header">
                <button
                    type="button"
                    class="th-header-back"
                    data-action="back-story"
                    aria-label="返回目录"
                >←</button>

                <div class="screen-title th-screen-title">
                    ${escapeHtml(chapter.title || getFoldLabel(chapterIndex))}
                </div>

                <div class="header-spacer"></div>
            </div>

            <div class="screen-content th-screen-content">
                <article class="th-reading-paper">
                    <div class="th-reading-paper__top">
                        <span>《${escapeHtml(story.title)}》</span>
                        <span>
                            ${escapeHtml(
                                chapter.title || getFoldLabel(chapterIndex)
                            )}
                        </span>
                    </div>

                    ${chapter.summary ? `
                        <button
                            type="button"
                            class="th-summary-toggle"
                            data-action="toggle-summary"
                            aria-expanded="false"
                        >
                            <span>本折提要</span>
                            <i>⌄</i>
                        </button>

                        <div class="th-summary-body" hidden>
                            ${escapeHtml(chapter.summary)}
                        </div>
                    ` : ''}

                    <div class="th-reading-content">
                        ${contentHtml}
                    </div>

                    <div class="th-reading-paper__end">
                        — 此折暂歇 —
                    </div>
                </article>

                <div class="th-reading-actions">
                    <button
                        type="button"
                        class="th-action-btn th-action-btn--primary"
                        data-action="edit-chapter"
                    >
                        ✏️ 修订此折
                    </button>

                    <button
                        type="button"
                        class="th-action-btn th-action-btn--danger"
                        data-action="delete-chapter"
                    >
                        🗑️ 删除
                    </button>
                </div>

                <div class="th-reading-nav">
                    ${previousChapter
                        ? `
                            <button
                                type="button"
                                data-action="open-chapter"
                                data-chapter-id="${escapeAttr(previousChapter.id)}"
                            >
                                <small>上一折</small>
                                <span>
                                    ${escapeHtml(
                                        previousChapter.title
                                        || getFoldLabel(chapterIndex - 1)
                                    )}
                                </span>
                            </button>
                        `
                        : '<span></span>'
                    }

                    ${nextChapter
                        ? `
                            <button
                                type="button"
                                class="th-reading-nav__next"
                                data-action="open-chapter"
                                data-chapter-id="${escapeAttr(nextChapter.id)}"
                            >
                                <small>下一折</small>
                                <span>
                                    ${escapeHtml(
                                        nextChapter.title
                                        || getFoldLabel(chapterIndex + 1)
                                    )}
                                </span>
                            </button>
                        `
                        : '<span></span>'
                    }
                </div>

                <button
                    type="button"
                    class="th-back-story-btn"
                    data-action="back-story"
                >
                    ← 返回剧目目录
                </button>
            </div>
        </div>
    `;
}

// -----------------------------------------------------------------------------
// render：app.js 需要同步返回 HTML
// IndexedDB 初始化会在后台进行，期间展示加载页。
// -----------------------------------------------------------------------------

export function render() {
    ensureStoreReady();

    if (storeLoading || !storeReady) {
        return storeError
            ? renderStoreErrorPage()
            : renderLoadingPage();
    }

    if (showCreateForm) {
        return renderStoryForm(null, 'create');
    }

    if (showEditForm && viewingStoryId) {
        return renderStoryForm(
            getStoryFromCache(viewingStoryId),
            'edit'
        );
    }

    if (showChapterForm && viewingStoryId) {
        return renderChapterForm(viewingStoryId, editingChapterId);
    }

    if (viewingStoryId && viewingChapterId) {
        return renderChapterReader(viewingStoryId, viewingChapterId);
    }

    if (viewingStoryId) {
        return renderStoryDetail(viewingStoryId);
    }

    return renderTeaHouseHome();
}

// -----------------------------------------------------------------------------
// 表单提交
// -----------------------------------------------------------------------------

function getSelectedRelatedCharacterIds(container) {
    return [...container.querySelectorAll(
        'input[name="thRelatedCharacter"]:checked'
    )]
        .map(input => input.value)
        .filter(Boolean);
}

async function handleStoryFormSubmit(event, container) {
    event.preventDefault();

    const titleInput = container.querySelector('#thStoryTitle');
    const title = titleInput?.value.trim() || '';

    if (!title) {
        titleInput?.classList.add('is-invalid');
        titleInput?.focus();

        window.setTimeout(() => {
            titleInput?.classList.remove('is-invalid');
        }, 1200);

        showToast('请先写下剧目标题。', 'error');
        return;
    }

    const storyPatch = {
        title,
        emoji: container.querySelector('#thStoryEmoji')?.value.trim() || '📜',
        synopsis: container.querySelector('#thStorySynopsis')?.value.trim() || '',
        narratorCharacterId:
            container.querySelector('#thNarratorCharacter')?.value || '',
        relatedCharacterIds: uniqueStringIds(
            getSelectedRelatedCharacterIds(container)
        ),
        writingStyle:
            container.querySelector('#thStoryStyle')?.value.trim() || '',
        notes: container.querySelector('#thStoryNotes')?.value.trim() || '',
        source: 'creator',
        status: 'published'
    };

    try {
        let savedStory;

        if (showEditForm && viewingStoryId) {
            savedStory = await updateStory(viewingStoryId, story => ({
                ...story,
                ...storyPatch
            }));
        } else {
            savedStory = await createStory(storyPatch);
        }

        if (!savedStory) {
            showToast('未能保存剧目。', 'error');
            return;
        }

        stories = await getAllStories();

        viewingStoryId = savedStory.id;
        viewingChapterId = null;
        showCreateForm = false;
        showEditForm = false;

        refresh(container);
    } catch (error) {
        console.error('[茶舍] 剧目保存失败：', error);
        showToast('剧目保存失败，请稍后再试。', 'error');
    }
}

async function handleChapterFormSubmit(event, container) {
    event.preventDefault();

    if (!viewingStoryId) return;

    const title = container.querySelector('#thChapterTitle')?.value.trim() || '';
    const content = container.querySelector('#thChapterContent')?.value || '';
    const summary = container.querySelector('#thChapterSummary')?.value.trim() || '';

    try {
        const savedStory = await updateStory(viewingStoryId, story => {
            let chapter;

            if (editingChapterId) {
                chapter = story.chapters.find(
                    item => item.id === editingChapterId
                );
            }

            if (!chapter) {
                chapter = {
                    id: createId('fold'),
                    title: '',
                    content: '',
                    summary: '',
                    createdAt: nowISO(),
                    updatedAt: nowISO()
                };

                story.chapters.push(chapter);
            }

            chapter.title = title || getFoldLabel(story.chapters.indexOf(chapter));
            chapter.content = content;
            chapter.summary = summary;
            chapter.updatedAt = nowISO();

            return story;
        });

        if (!savedStory) {
            showToast('未找到当前剧目。', 'error');
            return;
        }

        stories = await getAllStories();

        const savedChapterId = editingChapterId
            || savedStory.chapters[savedStory.chapters.length - 1]?.id;

        viewingChapterId = savedChapterId || null;
        showChapterForm = false;
        editingChapterId = null;

        refresh(container);
    } catch (error) {
        console.error('[茶舍] 折子保存失败：', error);
        showToast('此折保存失败，请稍后再试。', 'error');
    }
}

// -----------------------------------------------------------------------------
// AI 续写
// -----------------------------------------------------------------------------

function parseAiResult(result) {
    const text = String(result || '').trim();

    const chapterMatch = text.match(
        /---CHAPTER---\n([\s\S]+?)(?=\n---(?:SUMMARY|SYNOPSIS_UPDATE|STYLE_UPDATE)---|$)/
    );

    const summaryMatch = text.match(
        /---SUMMARY---\n([\s\S]+?)(?=\n---(?:CHAPTER|SYNOPSIS_UPDATE|STYLE_UPDATE)---|$)/
    );

    const synopsisMatch = text.match(
        /---SYNOPSIS_UPDATE---\n([\s\S]+?)(?=\n---(?:CHAPTER|SUMMARY|STYLE_UPDATE)---|$)/
    );

    const styleMatch = text.match(
        /---STYLE_UPDATE---\n([\s\S]+?)(?=\n---(?:CHAPTER|SUMMARY|SYNOPSIS_UPDATE)---|$)/
    );

    return {
        chapterContent: chapterMatch ? chapterMatch[1].trim() : text,
        chapterSummary: summaryMatch ? summaryMatch[1].trim() : '',
        synopsisUpdate: synopsisMatch ? synopsisMatch[1].trim() : '',
        styleUpdate: styleMatch ? styleMatch[1].trim() : ''
    };
}

// -----------------------------------------------------------------------------
// AI 创作参考：按需读取角色资料
//
// 注意：这些信息只在调用 AI 时临时拼入 prompt。
// 不会保存到 teaHouseDB，也不会复制进故事记录。
// -----------------------------------------------------------------------------

function toPromptText(value, fallback = '未设定') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function compactPromptValue(value, maximum = 700) {
    if (value === null || value === undefined || value === '') {
        return '';
    }

    let text = '';

    if (typeof value === 'string') {
        text = value.trim();
    } else {
        try {
            text = JSON.stringify(value);
        } catch {
            text = String(value);
        }
    }

    if (!text) return '';

    return text.length > maximum
        ? `${text.slice(0, maximum)}……`
        : text;
}

/**
 * 把角色已有的单向关系记录整理为 AI 可理解的文字。
 *
 * CharacterStore 的关系是“当前角色看向对方”的方向性记录：
 * A 的 relations 中写 B，表示 A 对 B 的认知、关系或态度；
 * 它不自动代表 B 对 A 的看法。
 */
function buildRelationNetworkReference(record) {
    const relations = Array.isArray(record?.relations)
        ? record.relations
        : [];

    if (!relations.length) {
        return '该角色当前没有已记录的关系。';
    }

    return relations.map(relation => {
        const targetId = String(relation?.id || '').trim();

        // 优先用内部 ID 查询展示名；提示词里只输出名称。
        const targetName = targetId
            ? getCharacterName(targetId)
            : toPromptText(relation?.name, '未知对象');

        const parts = [`对象：${targetName}`];

        if (relation?.relation) {
            parts.push(
                `关系定位：${compactPromptValue(relation.relation, 240)}`
            );
        }

        if (relation?.perspective) {
            parts.push(
                `该角色视角：${compactPromptValue(relation.perspective, 360)}`
            );
        }

        if (relation?.attitudes) {
            parts.push(
                `态度：${compactPromptValue(relation.attitudes, 360)}`
            );
        }

        return `- ${parts.join('；')}`;
    }).join('\n');
}

/**
 * 构建一个角色的“创作参考卡”。
 *
 * 只在 AI 任务开始时读取；不写进茶舍 IndexedDB。
 * narrator 表示该角色是叙述口吻参考；
 * related 表示该角色是故事选择的关联/出场角色。
 */
function buildCharacterReference(characterId, roleLabel = '关联角色') {
    const record = getCharacterRecordById(characterId);

    // 角色可能已经被删除、归档，或目录尚未加载。
    // 不把内部 ID 发送给 AI。
    if (!record) {
        return [
            `【${roleLabel}】`,
            '该角色的资料暂不可读取。',
            '请不要自行补造其确定的人设、经历或关系。'
        ].join('\n');
    }

    const base = record.base || {};
    const info = record.info || {};
    const profile = record.profile || {};

    const characterName =
        base.name
        || info.name
        || getCharacterName(characterId)
        || '未知角色';

    const lines = [
        `【${roleLabel}：${characterName}】`
    ];

    // 基础人设
    if (base.gender) {
        lines.push(`性别：${compactPromptValue(base.gender, 80)}`);
    }

    if (base.age) {
        lines.push(`年龄：${compactPromptValue(base.age, 80)}`);
    }

    if (base.orientation) {
        lines.push(`取向：${compactPromptValue(base.orientation, 80)}`);
    }

    if (base.desc) {
        lines.push(`简介：${compactPromptValue(base.desc, 700)}`);
    }

    if (base.detail) {
        lines.push(`详细设定：${compactPromptValue(base.detail, 1400)}`);
    }

    if (base.style) {
        lines.push(`言行 / 风格：${compactPromptValue(base.style, 700)}`);
    }

    if (base.secret) {
        lines.push(
            `隐秘设定（仅供创作参考，不必直接揭露）：${
                compactPromptValue(base.secret, 700)
            }`
        );
    }

    if (base.stats && Object.keys(base.stats).length) {
        lines.push(`角色特质：${compactPromptValue(base.stats, 500)}`);
    }

    // CharacterStore 中的公开资料层
    if (profile && Object.keys(profile).length) {
        lines.push(`公开资料：${compactPromptValue(profile, 900)}`);
    }

    // 关系是单向认知，避免模型理解为双方确认过的客观关系。
    lines.push('关系网（均为该角色单向视角，不自动代表对方态度）：');
    lines.push(buildRelationNetworkReference(record));

    return lines.join('\n');
}

/**
 * 根据故事中选择的角色，收集本次 AI 创作应参考的人物。
 *
 * - narratorCharacterId：作为“说书口吻”参考；
 * - relatedCharacterIds：视为本故事关联 / 出场角色；
 * - 同一角色若同时是两者，只保留一份资料卡。
 */
function buildSelectedCharacterReferences(story) {
    const narratorId = String(story?.narratorCharacterId || '').trim();
    const relatedIds = uniqueStringIds(story?.relatedCharacterIds);

    const references = [];
    const addedIds = new Set();

    if (narratorId) {
        references.push(
            buildCharacterReference(narratorId, '说书人口吻参考')
        );
        addedIds.add(narratorId);
    }

    for (const characterId of relatedIds) {
        if (addedIds.has(characterId)) continue;

        references.push(
            buildCharacterReference(characterId, '出场 / 关联角色')
        );
        addedIds.add(characterId);
    }

    return references.length
        ? references.join('\n\n')
        : '本剧目未指定角色。请不要凭空认定既有角色参与故事。';
}

// AI 续写时带入最近已完成一折的正文末尾。
// 取“末尾”而非开头，是为了让模型直接承接上一段的场景、对白和动作。
const AI_RECENT_CONTEXT_MAX_CHARS = 1000;

function getRecentChapterExcerpt(story, maximum = AI_RECENT_CONTEXT_MAX_CHARS) {
    const completedChapters = (story?.chapters || [])
        .filter(chapter => !chapter?._generating)
        .filter(chapter => String(chapter?.content || '').trim());

    const latestChapter = completedChapters[completedChapters.length - 1];

    if (!latestChapter) {
        return '';
    }

    const content = String(latestChapter.content).trim();

    if (!content) {
        return '';
    }

    // 正文不长时，完整带入；太长时只带最后一段上下文。
    if (content.length <= maximum) {
        return [
            `上一折《${latestChapter.title || '未命名回目'}》正文：`,
            content
        ].join('\n');
    }

    return [
        `上一折《${latestChapter.title || '未命名回目'}》正文末段（为保持续写连贯，仅节选最后 ${maximum} 字）：`,
        `……${content.slice(-maximum)}`
    ].join('\n');
}

function buildAiContext(story) {
    const characterReferences = buildSelectedCharacterReferences(story);
    const recentChapterExcerpt = getRecentChapterExcerpt(story);

    // 最近三折仍只给摘要，防止上文过长。
    const recentFolds = story.chapters
        .filter(chapter => !chapter._generating)
        .slice(-3)
        .map(chapter => {
            const index = story.chapters.findIndex(
                item => item.id === chapter.id
            );

            return `${getFoldLabel(index)}《${chapter.title || ''}》：${
                chapter.summary || '（无摘要）'
            }`;
        })
        .join('\n');

    return [
        '【茶舍创作任务说明】',
        '你正在为缔造者维护的世界故事库续写一折。',
        '故事的实际创作者是缔造者；下方角色资料只用于保持人物、关系与叙述口吻的一致。',
        '角色关系网是方向性资料：某角色对另一角色的关系、认知或态度，不自动等于对方也如此看待。',
        '若既有资料存在空白或矛盾，应以本次缔造者引子和已写内容为优先，不要擅自把不确定内容写成绝对事实。',
        '不要输出任何内部角色 ID、故事 ID 或系统字段。',
        '',

        '【当前剧目信息】',
        `剧目标题：${story.title}`,
        story.synopsis ? `题记：${story.synopsis}` : '',
        story.writingStyle ? `文风偏好：${story.writingStyle}` : '',
        story.notes ? `缔造者备忘：${story.notes}` : '',
        '',

        '【本剧目角色创作参考】',
        characterReferences,
        '',

        recentFolds
            ? '【最近已写折子摘要】'
            : '【当前尚无已写折子】',
        recentFolds || '（这是剧目的第一折。）',

        // 这一段是新增的正文上下文。
        recentChapterExcerpt ? '' : null,
        recentChapterExcerpt ? '【与本折直接相连的上文】' : null,
        recentChapterExcerpt || null
    ].filter(Boolean).join('\n');
}

function showAiDescriptionDialog(onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'th-dialog-overlay';

    overlay.innerHTML = `
        <div class="th-dialog-card th-ai-dialog" role="dialog" aria-modal="true">
            <div class="th-dialog-seal">墨</div>
            <div class="th-dialog-title">请为这一折留一句引子</div>

            <div class="th-dialog-message">
                描述情节走向、情绪、冲突或希望出现的场景。
            </div>

            <textarea
                class="th-ai-dialog__input"
                rows="5"
                maxlength="1000"
                placeholder="例如：雨夜里，二人在旧茶舍避雨；一封迟到多年的信被重新交到对方手中……"
            ></textarea>

            <div class="th-dialog-actions">
                <button type="button" class="th-dialog-cancel">取消</button>
                <button type="button" class="th-dialog-confirm">请君续写</button>
            </div>
        </div>
    `;

    const input = overlay.querySelector('.th-ai-dialog__input');

    overlay.querySelector('.th-dialog-cancel').addEventListener('click', () => {
        overlay.remove();
    });

    overlay.querySelector('.th-dialog-confirm').addEventListener('click', () => {
        const description = input.value.trim();

        if (!description) {
            input.classList.add('is-invalid');
            input.focus();

            window.setTimeout(() => {
                input.classList.remove('is-invalid');
            }, 1200);

            return;
        }

        overlay.remove();
        onConfirm(description);
    });

    overlay.addEventListener('click', event => {
        if (event.target === overlay) {
            overlay.remove();
        }
    });

    document.body.appendChild(overlay);
    window.setTimeout(() => input.focus(), 0);
}

async function startAiGeneration(container, description, isEditing, chapterId) {
    if (aiGenerating || !viewingStoryId) return;

    const savedStoryId = viewingStoryId;
    let placeholderId = chapterId;
    const isNewChapter = !isEditing;

    aiGenerating = true;

    try {
        const updatedStory = await updateStory(savedStoryId, story => {
            if (isEditing && chapterId) {
                const chapter = story.chapters.find(
                    item => item.id === chapterId
                );

                if (!chapter) return story;

                chapter._generating = true;
                chapter.updatedAt = nowISO();
                return story;
            }

            const newChapter = {
                id: createId('fold'),
                title: getFoldLabel(story.chapters.length),
                content: '',
                summary: '',
                _generating: true,
                createdAt: nowISO(),
                updatedAt: nowISO()
            };

            story.chapters.push(newChapter);
            placeholderId = newChapter.id;

            return story;
        });

        if (!updatedStory || !placeholderId) {
            throw new Error('无法创建 AI 续写占位折子。');
        }

        stories = await getAllStories();

        viewingChapterId = placeholderId;
        showChapterForm = false;
        editingChapterId = null;

        refresh(container);

        const latestStory = stories.find(item => item.id === savedStoryId);
        const aiContext = buildAiContext(latestStory || updatedStory);

        // 任务名不包含剧目标题或角色名，避免在任务中心泄漏具体内容。
        taskManager.submit(
            'story',
            '茶舍 · 续写一折',
            async () => callAIForStory({
                systemPrompt: STORY_WRITING_PROMPT,
                description: `${aiContext}\n\n【缔造者对本折的引子】\n${description}`
            }),
            {
                onComplete: async result => {
                    try {
                        const parsed = parseAiResult(result);

                        await updateStory(savedStoryId, story => {
                            const chapter = story.chapters.find(
                                item => item.id === placeholderId
                            );

                            if (!chapter) return story;

                            chapter.content = parsed.chapterContent;
                            chapter.summary =
                                parsed.chapterSummary || chapter.summary;
                            chapter.updatedAt = nowISO();

                            delete chapter._generating;

                            if (
                                parsed.synopsisUpdate
                                && parsed.synopsisUpdate !== '无'
                            ) {
                                story.synopsis = story.synopsis
                                    ? `${story.synopsis}\n${parsed.synopsisUpdate}`
                                    : parsed.synopsisUpdate;
                            }

                            if (
                                parsed.styleUpdate
                                && parsed.styleUpdate !== '无'
                            ) {
                                story.writingStyle = story.writingStyle
                                    ? `${story.writingStyle}\n${parsed.styleUpdate}`
                                    : parsed.styleUpdate;
                            }

                            return story;
                        });

                        stories = await getAllStories();

                        // 用户仍在茶舍时才刷新；已经切模块则仅保存数据。
                        refreshTeaHouseIfVisible();
                    } catch (error) {
                        console.error('[茶舍] AI 结果写入失败：', error);
                        showToast('AI 已完成，但结果写入失败。', 'error');
                    } finally {
                        aiGenerating = false;
                    }
                },

                onError: async error => {
                    try {
                        await updateStory(savedStoryId, story => {
                            if (isNewChapter) {
                                story.chapters = story.chapters.filter(
                                    item => item.id !== placeholderId
                                );
                            } else {
                                const chapter = story.chapters.find(
                                    item => item.id === placeholderId
                                );

                                if (chapter) {
                                    delete chapter._generating;
                                    chapter.updatedAt = nowISO();
                                }
                            }

                            return story;
                        });

                        stories = await getAllStories();
                        refreshTeaHouseIfVisible();
                    } catch (saveError) {
                        console.error('[茶舍] AI 失败状态清理失败：', saveError);
                    } finally {
                        aiGenerating = false;
                    }

                    showToast(
                        `续写未完成：${String(error || '未知错误')}`,
                        'error'
                    );
                }
            }
        );
    } catch (error) {
        aiGenerating = false;

        console.error('[茶舍] 启动 AI 续写失败：', error);
        showToast('无法开始续写，请稍后再试。', 'error');

        stories = await getAllStories().catch(() => stories);
        refreshTeaHouseIfVisible();
    }
}

// -----------------------------------------------------------------------------
// 点击事件
// -----------------------------------------------------------------------------

function toggleFilterMenu(container) {
    const menu = container.querySelector('.th-filter-menu');
    const button = container.querySelector('[data-action="toggle-filter"]');

    if (!menu || !button) return;

    const opening = menu.hidden;
    menu.hidden = !opening;
    button.setAttribute('aria-expanded', String(opening));
}

function closeFilterMenu(container) {
    const menu = container.querySelector('.th-filter-menu');
    const button = container.querySelector('[data-action="toggle-filter"]');

    if (menu) menu.hidden = true;
    if (button) button.setAttribute('aria-expanded', 'false');
}

async function handleAction(action, target, container) {
    switch (action) {
        case 'retry-store':
            storeError = null;
            storeReady = false;
            await loadStories();
            refresh(container);
            return;

        case 'toggle-filter':
            toggleFilterMenu(container);
            return;

        case 'set-filter':
            selectedCharacterFilterId = target.dataset.characterId || '';
            closeFilterMenu(container);
            refresh(container);
            return;

        case 'open-story':
            viewingStoryId = target.dataset.storyId || null;
            viewingChapterId = null;
            refresh(container);
            return;

        case 'back-home':
            resetToHome();
            refresh(container);
            return;

        case 'create-story':
            viewingStoryId = null;
            viewingChapterId = null;
            showCreateForm = true;
            showEditForm = false;
            refresh(container);
            return;

        case 'edit-story':
            showEditForm = true;
            showCreateForm = false;
            refresh(container);
            return;

        case 'cancel-story-form':
            if (showEditForm && viewingStoryId) {
                showEditForm = false;
            } else {
                resetToHome();
            }

            refresh(container);
            return;

        case 'delete-story': {
            if (!viewingStoryId) return;

            const story = getStoryFromCache(viewingStoryId);

            const ok = await showConfirm(
                `确定从茶舍撤下《${story?.title || '此剧目'}》吗？所有折子也会一并删除。`,
                '撤下剧目'
            );

            if (!ok) return;

            try {
                await deleteStory(viewingStoryId);
                stories = await getAllStories();

                resetToHome();
                refresh(container);

                showToast('剧目已从茶舍撤下。');
            } catch (error) {
                console.error('[茶舍] 剧目删除失败：', error);
                showToast('剧目删除失败。', 'error');
            }

            return;
        }

        case 'add-chapter':
            showChapterForm = true;
            editingChapterId = null;
            viewingChapterId = null;
            refresh(container);
            return;

        case 'open-chapter':
            viewingChapterId = target.dataset.chapterId || null;
            refresh(container);
            return;

        case 'back-story':
            viewingChapterId = null;
            showChapterForm = false;
            editingChapterId = null;
            refresh(container);
            return;

        case 'edit-chapter':
            editingChapterId = viewingChapterId;
            showChapterForm = true;
            refresh(container);
            return;

        case 'cancel-chapter-form':
            showChapterForm = false;
            editingChapterId = null;
            refresh(container);
            return;

        case 'delete-chapter': {
            if (!viewingStoryId || !viewingChapterId) return;

            const ok = await showConfirm(
                '确定要撤下这一折吗？',
                '删除此折'
            );

            if (!ok) return;

            try {
                const storyId = viewingStoryId;
                const chapterId = viewingChapterId;

                await updateStory(storyId, story => {
                    story.chapters = story.chapters.filter(
                        chapter => chapter.id !== chapterId
                    );

                    return story;
                });

                stories = await getAllStories();
                viewingChapterId = null;

                refresh(container);
                showToast('这一折已撤下。');
            } catch (error) {
                console.error('[茶舍] 折子删除失败：', error);
                showToast('折子删除失败。', 'error');
            }

            return;
        }

        case 'toggle-summary': {
            const summary = container.querySelector('.th-summary-body');

            if (!summary) return;

            const expanded = target.getAttribute('aria-expanded') === 'true';

            summary.hidden = expanded;
            target.setAttribute('aria-expanded', String(!expanded));
            target.classList.toggle('is-open', !expanded);

            return;
        }

        case 'ai-write':
            if (!viewingStoryId || aiGenerating) return;

            showAiDescriptionDialog(description => {
                void startAiGeneration(
                    container,
                    description,
                    Boolean(editingChapterId),
                    editingChapterId
                );
            });

            return;

        default:
            return;
    }
}

// -----------------------------------------------------------------------------
// 页面内部事件委托
// -----------------------------------------------------------------------------

export function bindEvents(container) {
    if (!container || boundContainers.has(container)) return;

    boundContainers.add(container);

    container.addEventListener('click', event => {
        const target = event.target.closest('[data-action]');

        if (!target || !container.contains(target)) {
            if (!event.target.closest('.th-filter-bar')) {
                closeFilterMenu(container);
            }

            return;
        }

        void handleAction(target.dataset.action, target, container);
    });

    container.addEventListener('submit', event => {
        if (event.target.matches('#thStoryForm')) {
            void handleStoryFormSubmit(event, container);
            return;
        }

        if (event.target.matches('#thChapterForm')) {
            void handleChapterFormSubmit(event, container);
        }
    });
}

// -----------------------------------------------------------------------------
// 全局返回键：
// 首页时返回 false，由 app.js 执行“返回桌面”。
// 茶舍子页面时返回 true，只在茶舍内部回退。
// -----------------------------------------------------------------------------

export function handleBack(container) {
    if (showCreateForm) {
        resetToHome();
        refresh(container);
        return true;
    }

    if (showEditForm) {
        showEditForm = false;
        refresh(container);
        return true;
    }

    if (showChapterForm) {
        showChapterForm = false;
        editingChapterId = null;
        refresh(container);
        return true;
    }

    if (viewingChapterId) {
        viewingChapterId = null;
        refresh(container);
        return true;
    }

    if (viewingStoryId) {
        viewingStoryId = null;
        refresh(container);
        return true;
    }

    return false;
}

// -----------------------------------------------------------------------------
// 模块注册
//
// 保留 id: 'bookClub'：不破坏既有桌面布局 / 路由记录。
// 前台名称改为“茶舍”。
// -----------------------------------------------------------------------------

if (!window.__moduleRegistry) {
    window.__moduleRegistry = [];
}

window.__moduleRegistry.push({
    id: 'bookClub',
    label: '茶舍',
    icon: '🍵',
    color: '#8a6244',
    render,
    bindEvents,
    handleBack
});

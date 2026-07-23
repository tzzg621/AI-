// apps/bookClub.js — 书社：创作与阅读小说
import { callAIForStory } from './aiService.js';
import { STORY_WRITING_PROMPT } from './prompts.js';
import { taskManager } from '../store/AITaskManager.js';
// ★ 动态加载书社专属样式
(function () {
    const id = 'bookClub-style';
    if (!document.getElementById(id)) {
        const link = document.createElement('link');
        link.id = id;
        link.rel = 'stylesheet';
        link.href = 'apps/bookClub.css';
        document.head.appendChild(link);
    }
})();


const STORAGE_KEY = 'bookclub_novels';

// ---- 自定义确认弹窗（替代原生 confirm）----
function showConfirm(message) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:200;display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = `
            <div style="background:white;border-radius:20px;padding:24px 20px;width:280px;text-align:center;">
                <div style="font-size:15px;color:#333;margin-bottom:20px;line-height:1.5;">${message}</div>
                <div style="display:flex;gap:10px;">
                    <button class="confirm-yes" style="flex:1;padding:8px;border-radius:12px;border:none;background:#e53935;color:white;cursor:pointer;font-size:14px;">确定</button>
                    <button class="confirm-no" style="flex:1;padding:8px;border-radius:12px;border:1px solid #ccc;background:white;color:#666;cursor:pointer;font-size:14px;">取消</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.querySelector('.confirm-yes').onclick = () => { overlay.remove(); resolve(true); };
        overlay.querySelector('.confirm-no').onclick = () => { overlay.remove(); resolve(false); };
    });
}

// ---- 数据管理 ----
function getNovels() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        return saved ? JSON.parse(saved) : [];
    } catch { return []; }
}

function saveNovels(novels) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(novels));
}

function genId(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
}

// ---- 状态 ----
let viewingNovelId = null;
let viewingChapterId = null;
let showCreateForm = false;
let showEditForm = false;
let showChapterForm = false;
let editingChapterId = null;
let aiGenerating = false;

// ---- 渲染 ----

function renderLibrary() {
    const novels = getNovels();
    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">📚 书社</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card" style="padding:0;">
                    ${novels.length === 0 ? `
                        <p style="text-align:center; color:#888; padding:40px 16px; font-size:14px;">
                            还没有作品<br>
                            <span style="font-size:12px;">点击下方开始创作</span>
                        </p>
                    ` : novels.map(n => `
                        <div class="bk-novel-item" data-id="${n.id}" style="
                            display:flex; align-items:center; gap:14px; padding:16px 18px;
                            cursor:pointer; border-bottom:1px solid #f0f0f0;
                        ">
                            <span style="font-size:32px;">${n.emoji || '📖'}</span>
                            <div style="flex:1; min-width:0;">
                                <div style="font-weight:600; font-size:15px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${n.title}</div>
                                <div style="font-size:12px; color:#999; margin-top:2px;">
                                    ${(n.chapters || []).length} 章 · ${n.author || '佚名'}
                                </div>
                            </div>
                            <span style="color:#ccc; font-size:18px;">›</span>
                        </div>
                    `).join('')}
                    <div id="bkCreateBtn" style="
                        display:flex; align-items:center; gap:14px; padding:16px 18px;
                        cursor:pointer; color:#8e24aa;
                    ">
                        <span style="font-size:28px;">✍️</span>
                        <div style="font-weight:600; font-size:15px;">创作新作品</div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function renderCreateForm() {
    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">✍️ 新作品</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card">
                    <div style="margin-bottom:14px;">
                        <label style="font-size:12px; color:#888; margin-bottom:4px; display:block;">封面图标</label>
                        <input id="bkEmoji" type="text" value="📖" maxlength="2"
                               style="width:60px; border:1px solid #ccc; border-radius:8px; padding:8px; font-size:20px; text-align:center;" />
                    </div>
                    <div style="margin-bottom:14px;">
                        <label style="font-size:12px; color:#888; margin-bottom:4px; display:block;">作品标题</label>
                        <input id="bkTitle" type="text" placeholder="输入小说标题..."
                               style="width:100%; border:1px solid #ccc; border-radius:8px; padding:10px 12px; font-size:15px; box-sizing:border-box;" />
                    </div>
                    <div style="margin-bottom:14px;">
                        <label style="font-size:12px; color:#888; margin-bottom:4px; display:block;">作者</label>
                        <input id="bkAuthor" type="text" placeholder="笔名或角色名..."
                               style="width:100%; border:1px solid #ccc; border-radius:8px; padding:10px 12px; font-size:14px; box-sizing:border-box;" />
                    </div>
<div style="display:flex; gap:8px;">
    <button id="bkCancelCreate" class="bk-btn bk-btn--secondary" style="flex:1;">取消</button>
    <button id="bkConfirmCreate" class="bk-btn bk-btn--primary" style="flex:1;">✨ 创建</button>
</div>
                </div>
            </div>
        </div>
    `;
}

function renderNovelDetail(novelId) {
    const novels = getNovels();
    const novel = novels.find(n => n.id === novelId);
    if (!novel) return renderLibrary();

    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title" style="font-size:16px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                    ${novel.emoji || '📖'} ${novel.title}
                </div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card" style="padding:0;">
                    <div style="padding:14px 18px; border-bottom:1px solid #f0f0f0;">
                        <div style="font-size:13px; color:#666; margin-bottom:6px;">
                            <span style="font-weight:600;">简介：</span>
                            ${novel.synopsis || '暂无'}
                        </div>
                        <div style="font-size:13px; color:#666; margin-bottom:6px;">
                            <span style="font-weight:600;">文风偏好：</span>
                            ${novel.writingStyle || '暂无'}
                        </div>
                        <div style="font-size:13px; color:#666;">
                            <span style="font-weight:600;">注意点：</span>
                            ${novel.notes || '暂无'}
                        </div>
                    </div>
                    <div style="padding:12px 18px; border-bottom:1px solid #f0f0f0; font-size:13px; color:#888;">
                        作者：${novel.author || '佚名'} · ${(novel.chapters || []).length} 章
                    </div>
                    ${(!novel.chapters || novel.chapters.length === 0) ? `
                        <p style="text-align:center; color:#888; padding:30px 16px;">暂无章节</p>
                    ` : novel.chapters.map((ch, i) => `
                        <div class="bk-chapter" data-chapter-id="${ch.id}" style="
                            display:flex; align-items:center; gap:12px; padding:14px 18px;
                            cursor:pointer; border-bottom:1px solid #f0f0f0;
                            ${ch._generating ? 'opacity:0.6;' : ''}
                        ">
                            <span style="
                                width:26px; height:26px; border-radius:50%; flex-shrink:0;
                                background:${ch._generating ? '#fff3e0' : '#f3e5f5'};
                                display:flex; align-items:center; justify-content:center;
                                font-size:12px; color:${ch._generating ? '#ff9800' : '#8e24aa'};
                                font-weight:600;
                            ">${ch._generating ? '✨' : (i + 1)}</span>
                            <div style="flex:1; min-width:0;">
                                <div style="font-weight:500; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                                    ${ch._generating ? '生成中…' : (ch.title || `第${i + 1}章`)}
                                </div>
                                <div style="font-size:11px; color:#999; margin-top:1px;">
                                    ${ch._generating ? 'AI 正在创作……' : ((ch.content || '').substring(0, 28) + (ch.content && ch.content.length > 28 ? '...' : ''))}
                                </div>
                            </div>
                            <span style="color:#ccc; font-size:16px;">›</span>
                        </div>
                    `).join('')}
<div style="display:flex; gap:8px; padding:14px 18px;">
    <button id="bkAddChapter" class="bk-btn" style="
        flex:1; background:white; color:#8e24aa; border:1px solid #8e24aa;
    ">✍️ 手写新章节</button>
    <button id="bkEditNovel" class="bk-btn bk-btn--secondary">✏️</button>
    <button id="bkDeleteNovel" class="bk-btn bk-btn--danger">🗑️</button>
</div>
                </div>
            </div>
        </div>
    `;
}

function renderChapterReader(novelId, chapterId) {
    const novels = getNovels();
    const novel = novels.find(n => n.id === novelId);
    if (!novel) return renderLibrary();
    const chapter = (novel.chapters || []).find(c => c.id === chapterId);
    if (!chapter) return renderNovelDetail(novelId);

    // ★ 如果章节正在生成中，显示加载提示
    if (chapter._generating) {
        const idx = novel.chapters.findIndex(c => c.id === chapterId);
        return `
            <div class="screen-page">
                <div class="screen-header">
                    <div class="screen-title">${chapter.title || `第${idx + 1}章`}</div>
                    <div class="header-spacer"></div>
                </div>
                <div class="screen-content" style="display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px; padding:40px 20px;">
                    <div style="font-size:40px; animation:bkPulse 1.5s ease-in-out infinite;">✨</div>
                    <div style="font-size:15px; color:#888;">AI 正在生成本章内容……</div>
                    <div style="width:180px; height:3px; background:#f0f0f0; border-radius:2px; overflow:hidden;">
                        <div style="width:30%; height:100%; background:linear-gradient(90deg, #0b93f6, #8e24aa); border-radius:2px; animation:bkLoading 2s ease-in-out infinite;"></div>
                    </div>
                    <button id="bkBackToNovel" style="
                        margin-top:8px; padding:8px 20px; border-radius:14px;
                        border:1px solid #ddd; background:white; color:#666; cursor:pointer; font-size:13px;
                    ">← 返回目录</button>
                </div>
            </div>
            <style>
                @keyframes bkPulse { 0%,100%{transform:scale(1);} 50%{transform:scale(1.15);} }
                @keyframes bkLoading { 0%{transform:translateX(-100%);} 100%{transform:translateX(220px);} }
            </style>
        `;
    }

    const chapters = novel.chapters || [];
    const idx = chapters.findIndex(c => c.id === chapterId);

    // ★ 计算前后章节
    const prevChapter = idx > 0 ? chapters[idx - 1] : null;
    const nextChapter = idx < chapters.length - 1 ? chapters[idx + 1] : null;

    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title" style="font-size:15px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                    ${chapter.title || `第${idx + 1}章`}
                </div>
                <div class="header-spacer"></div>
            </div>
           <div class="screen-content" style="padding:16px;">
                <div class="page-card" style="padding:20px 18px; line-height:1.9; font-size:15px; color:#333;">
                ${chapter.summary ? `
    <div class="bk-summary-toggle" id="bkSummaryToggle">
        <span class="arrow">▶</span> 本章概要
    </div>
    <div class="bk-summary-body" id="bkSummaryBody">
        ${chapter.summary}
    </div>
` : ''} 
                    ${chapter.content ? chapter.content.split('\n').map(p => p.trim() ? `<p style="margin-bottom:8px; text-indent:2em;">${p}</p>` : '<br>').join('') : '<p style="color:#ccc; text-align:center;">（空章节）</p>'}
                </div>
<div style="display:flex; gap:8px; margin-top:12px;">
    <button id="bkEditChapter" data-chapter-id="${chapter.id}" class="bk-btn bk-btn--primary" style="flex:1;">✏️ 编辑</button>
    <button id="bkDeleteChapter" data-chapter-id="${chapter.id}" class="bk-btn bk-btn--danger">🗑️ 删除</button>
</div>
                <!-- ★ 前后章导航 -->
<div style="display:flex; gap:8px; margin-top:8px;">
    ${prevChapter ? `
        <button id="bkPrevChapter" data-chapter-id="${prevChapter.id}" class="bk-btn bk-btn--nav" style="flex:1;">← ${prevChapter.title || `第${idx}章`}</button>
    ` : `<div style="flex:1;"></div>`}
    ${nextChapter ? `
        <button id="bkNextChapter" data-chapter-id="${nextChapter.id}" class="bk-btn bk-btn--nav-next" style="flex:1;">${nextChapter.title || `第${idx + 2}章`} →</button>
    ` : `<div style="flex:1;"></div>`}
</div>
<button id="bkBackToNovel" class="bk-btn bk-btn--nav" style="width:100%;">← 返回目录</button>
            </div>
        </div>
    `;
}

function renderEditForm(novelId) {
    const novels = getNovels();
    const novel = novels.find(n => n.id === novelId);
    if (!novel) return renderLibrary();

    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">✏️ 编辑作品</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card">
                    <div style="margin-bottom:14px;">
                        <label style="font-size:12px; color:#888; margin-bottom:4px; display:block;">封面图标</label>
                        <input id="bkEditEmoji" type="text" value="${novel.emoji || '📖'}" maxlength="2"
                               style="width:60px; border:1px solid #ccc; border-radius:8px; padding:8px; font-size:20px; text-align:center;" />
                    </div>
                    <div style="margin-bottom:14px;">
                        <label style="font-size:12px; color:#888; margin-bottom:4px; display:block;">作品标题</label>
                        <input id="bkEditTitle" type="text" value="${novel.title}"
                               style="width:100%; border:1px solid #ccc; border-radius:8px; padding:10px 12px; font-size:15px; box-sizing:border-box;" />
                    </div>
                    <div style="margin-bottom:14px;">
                        <label style="font-size:12px; color:#888; margin-bottom:4px; display:block;">作者</label>
                        <input id="bkEditAuthor" type="text" value="${novel.author || ''}"
                               style="width:100%; border:1px solid #ccc; border-radius:8px; padding:10px 12px; font-size:14px; box-sizing:border-box;" />
                    </div>
                    <div style="margin-bottom:14px;">
                        <label style="font-size:12px; color:#888; margin-bottom:4px; display:block;">全本简介</label>
                        <textarea id="bkEditSynopsis" rows="3" placeholder="小说的整体简介……"
                                  style="width:100%; border:1px solid #ccc; border-radius:8px; padding:10px 12px; font-size:14px; line-height:1.5; resize:vertical; box-sizing:border-box; font-family:inherit;">${novel.synopsis || ''}</textarea>
                    </div>
                    <div style="margin-bottom:14px;">
                        <label style="font-size:12px; color:#888; margin-bottom:4px; display:block;">文风与偏好</label>
                        <textarea id="bkEditStyle" rows="2" placeholder="例如：第三人称、偏沉郁、多描写……"
                                  style="width:100%; border:1px solid #ccc; border-radius:8px; padding:10px 12px; font-size:14px; line-height:1.5; resize:vertical; box-sizing:border-box; font-family:inherit;">${novel.writingStyle || ''}</textarea>
                    </div>
                    <div style="margin-bottom:14px;">
                        <label style="font-size:12px; color:#888; margin-bottom:4px; display:block;">注意点</label>
                        <textarea id="bkEditNotes" rows="2" placeholder="写作时需要注意的事项……"
                                  style="width:100%; border:1px solid #ccc; border-radius:8px; padding:10px 12px; font-size:14px; line-height:1.5; resize:vertical; box-sizing:border-box; font-family:inherit;">${novel.notes || ''}</textarea>
                    </div>

<div style="display:flex; gap:8px;">
    <button id="bkCancelEdit" class="bk-btn bk-btn--secondary" style="flex:1;">取消</button>
    <button id="bkConfirmEdit" class="bk-btn bk-btn--primary" style="flex:1;">💾 保存</button>
</div>
                </div>
            </div>
        </div>
    `;
}

function renderChapterForm(novelId, chapterId) {
    const novels = getNovels();
    const novel = novels.find(n => n.id === novelId);
    if (!novel) return renderLibrary();
    const isNew = !chapterId;
    const chapter = isNew ? null : (novel.chapters || []).find(c => c.id === chapterId);

    const title = chapter ? chapter.title || '' : '';
    const content = chapter ? chapter.content || '' : '';
    const summary = chapter ? chapter.summary || '' : '';

    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">${isNew ? '✍️ 写新章节' : '✏️ 编辑章节'}</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card">
                    <div style="margin-bottom:12px;">
                        <label style="font-size:12px; color:#888; margin-bottom:4px; display:block;">章节标题</label>
                        <input id="bkChTitle" type="text" value="${title}" placeholder="章节标题（可选）"
                               style="width:100%; border:1px solid #ccc; border-radius:8px; padding:10px 12px; font-size:14px; box-sizing:border-box;" />
                    </div>
                    <div style="margin-bottom:12px;">
                        <label style="font-size:12px; color:#888; margin-bottom:4px; display:block;">正文</label>
                        <textarea id="bkChContent" rows="14" placeholder="开始写作..."
                                  style="width:100%; border:1px solid #ccc; border-radius:8px; padding:10px 12px; font-size:14px; line-height:1.7; resize:vertical; box-sizing:border-box; font-family:inherit;">${content}</textarea>
                    </div>
                    <div style="margin-bottom:12px;">
                        <label style="font-size:12px; color:#888; margin-bottom:4px; display:block;">本章摘要</label>
                        <input id="bkChSummary" type="text" value="${summary}" placeholder="本章讲了什么……"
                               style="width:100%; border:1px solid #ccc; border-radius:8px; padding:10px 12px; font-size:13px; box-sizing:border-box;" />
                    </div>
<div style="display:flex; gap:8px;">
    <button id="bkAiWrite" class="bk-btn bk-btn--gradient">🤖 AI 生成本章</button>
    <button id="bkCancelCh" class="bk-btn bk-btn--secondary" style="flex:1;">取消</button>
    <button id="bkSaveCh" class="bk-btn bk-btn--primary" style="flex:1;">💾 保存</button>
</div>
                </div>
            </div>
        </div>
    `;
}

// ---- 主渲染入口 ----
export function render() {
    if (showCreateForm) return renderCreateForm();
    if (showEditForm && viewingNovelId) return renderEditForm(viewingNovelId);
    if (showChapterForm && viewingNovelId) return renderChapterForm(viewingNovelId, editingChapterId);
    if (viewingNovelId && viewingChapterId) return renderChapterReader(viewingNovelId, viewingChapterId);
    if (viewingNovelId) return renderNovelDetail(viewingNovelId);
    return renderLibrary();
}

// ---- 工具 ----
function refresh(container) {
    const appContainer = container.closest('.screen-page') || container;
    appContainer.innerHTML = render();
    bindEvents(appContainer);
}

// ★ 检测当前页面是否仍然在书社模块内
function isBookClubVisible() {
    const pageContainer = document.getElementById('pageContainer');
    if (!pageContainer) return false;
    const html = pageContainer.innerHTML;
    return html.includes('bk-novel-item') ||
        html.includes('bk-chapter') ||
        html.includes('bkCreateBtn') ||
        html.includes('bkAiWrite');
}

function parseAiResult(result) {
    let chapterContent = '';
    let chapterSummary = '';
    let synopsisUpdate = '';
    let styleUpdate = '';

    // ★ 正文：用前瞻找下一个标记或结尾，优先保证正文捕获
    const chapterMatch = result.match(/---CHAPTER---\n([\s\S]+?)(?=\n---(?:SUMMARY|SYNOPSIS_UPDATE|STYLE_UPDATE)---|$)/);
    if (chapterMatch) {
        chapterContent = chapterMatch[1].trim();
    } else {
        // 完全没找到标记时，整个返回作为正文
        chapterContent = result.trim();
    }

    // ★ 概要：用前瞻找下一个标记
    const summaryMatch = result.match(/---SUMMARY---\n([\s\S]+?)(?=\n---(?:CHAPTER|SYNOPSIS_UPDATE|STYLE_UPDATE)---|$)/);
    if (summaryMatch) chapterSummary = summaryMatch[1].trim();

    // ★ 以下两个只在有对应标记时才解析，没有也不影响
    const synopsisMatch = result.match(/---SYNOPSIS_UPDATE---\n([\s\S]+?)(?=\n---(?:CHAPTER|SUMMARY|STYLE_UPDATE)---|$)/);
    const styleMatch = result.match(/---STYLE_UPDATE---\n([\s\S]+?)(?=\n---(?:CHAPTER|SUMMARY|SYNOPSIS_UPDATE)---|$)/);

    if (synopsisMatch) synopsisUpdate = synopsisMatch[1].trim();
    if (styleMatch) styleUpdate = styleMatch[1].trim();

    return { chapterContent, chapterSummary, synopsisUpdate, styleUpdate };
}

function buildAiContext(novel) {
    const chCount = (novel.chapters || []).length;
    const recentSummaries = novel.chapters
        .slice(-3)
        .map((ch, i) => `第${chCount - 3 + i + 1}章《${ch.title || ''}》：${ch.summary || '（无摘要）'}`)
        .join('\n');

    return [
        '【当前作品信息】',
        `标题：${novel.title}`,
        novel.synopsis ? `简介：${novel.synopsis}` : '',
        novel.writingStyle ? `文风偏好：${novel.writingStyle}` : '',
        novel.notes ? `注意点：${novel.notes}` : '',
        '',
        chCount > 0 ? '【已有章节概要（最近3章）】' : '【尚无已写章节】',
        recentSummaries || '（这是新作品的第一章）',
    ].filter(Boolean).join('\n');
}

// ---- 核心：AI 生成章节并直接创建 ----
function startAiGeneration(container, description, isEdit, chapterId) {
    showChapterForm = false;
    editingChapterId = null;
    const novels = getNovels();
    const novel = novels.find(n => n.id === viewingNovelId);
    if (!novel) return;

    if (!novel.chapters) novel.chapters = [];

    // ★ 保存到局部变量，闭包中使用它，不受 handleBack 影响
    const savedNovelId = viewingNovelId;
    const savedPlaceholderId = (() => {
        if (isEdit && chapterId) {
            const ch = novel.chapters.find(c => c.id === chapterId);
            if (ch) ch._generating = true;
            return chapterId;
        } else {
            const ch = {
                id: genId('ch'),
                title: `第${novel.chapters.length + 1}章`,
                content: '',
                summary: '',
                _generating: true,
                createdAt: new Date().toISOString()
            };
            novel.chapters.push(ch);
            viewingChapterId = ch.id;
            return ch.id;
        }
    })();

    const isNewChapter = !isEdit;

    saveNovels(novels);
    refresh(container);

    const context = buildAiContext(novel);

    taskManager.submit('story', `生成《${novel.title}》章节`, async () => {
        return await callAIForStory({
            systemPrompt: STORY_WRITING_PROMPT,
            description: context + '\n\n【用户对本章的描述】\n' + description
        });
    }, {
        onComplete: (result) => {
            const { chapterContent, chapterSummary, synopsisUpdate, styleUpdate } = parseAiResult(result);
            const novels = getNovels();
            // ★ 用局部变量 savedNovelId，而不是 viewingNovelId
            const novel = novels.find(n => n.id === savedNovelId);
            if (!novel) return;

            const ch = novel.chapters?.find(c => c.id === savedPlaceholderId);
            if (ch) {
                ch.content = chapterContent;
                ch.summary = chapterSummary || ch.summary;
                delete ch._generating;
            }

            novel.updatedAt = new Date().toISOString();
            if (synopsisUpdate && synopsisUpdate !== '无') {
                novel.synopsis = novel.synopsis ? novel.synopsis + '\n' + synopsisUpdate : synopsisUpdate;
            }
            if (styleUpdate && styleUpdate !== '无') {
                novel.writingStyle = novel.writingStyle ? novel.writingStyle + '\n' + styleUpdate : styleUpdate;
            }

            saveNovels(novels);

            if (isBookClubVisible()) {
                const freshContainer = document.querySelector('.screen-page');
                if (freshContainer) refresh(freshContainer);
            }
        },
        onError: (error) => {
            const novels = getNovels();
            // ★ 同样用局部变量
            const novel = novels.find(n => n.id === savedNovelId);
            if (novel) {
                if (isNewChapter) {
                    novel.chapters = novel.chapters.filter(c => c.id !== savedPlaceholderId);
                } else {
                    const ch = novel.chapters.find(c => c.id === savedPlaceholderId);
                    if (ch) delete ch._generating;
                }
                saveNovels(novels);
            }

            if (isBookClubVisible()) {
                const freshContainer = document.querySelector('.screen-page');
                if (freshContainer) refresh(freshContainer);
            }

            const toast = document.createElement('div');
            toast.textContent = '❌ ' + error;
            toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#c62828;color:white;padding:10px 20px;border-radius:12px;z-index:10000;font-size:13px;max-width:80%;text-align:center;';
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 3500);
        }
    });
}

// ---- 事件绑定 ----
export function bindEvents(container) {
    // ---- 书社列表页 ----
    if (!viewingNovelId && !showCreateForm && !showEditForm && !showChapterForm) {
        container.querySelectorAll('.bk-novel-item').forEach(item => {
            item.addEventListener('click', () => {
                viewingNovelId = item.dataset.id;
                refresh(container);
            });
        });
        container.querySelector('#bkCreateBtn')?.addEventListener('click', () => {
            showCreateForm = true;
            refresh(container);
        });
        return;
    }

    // ---- 创建表单 ----
    if (showCreateForm) {
        container.querySelector('#bkCancelCreate')?.addEventListener('click', () => {
            showCreateForm = false;
            refresh(container);
        });
        container.querySelector('#bkConfirmCreate')?.addEventListener('click', () => {
            const title = document.getElementById('bkTitle')?.value.trim();
            if (!title) {
                const hint = document.createElement('div');
                hint.textContent = '⚠️ 请输入作品标题';
                hint.style.cssText = 'color:#c62828; font-size:12px; margin:4px 0 8px;';
                const input = document.getElementById('bkTitle');
                input.parentNode.insertBefore(hint, input.nextSibling);
                setTimeout(() => hint.remove(), 2000);
                return;
            }
            const novels = getNovels();
            novels.push({
                id: genId('novel'),
                title,
                emoji: document.getElementById('bkEmoji')?.value || '📖',
                author: document.getElementById('bkAuthor')?.value.trim() || '',
                chapters: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });
            saveNovels(novels);
            showCreateForm = false;
            refresh(container);
        });
        return;
    }

    // ---- 编辑作品表单 ----
    if (showEditForm && viewingNovelId) {
        container.querySelector('#bkCancelEdit')?.addEventListener('click', () => {
            showEditForm = false;
            refresh(container);
        });
        container.querySelector('#bkConfirmEdit')?.addEventListener('click', () => {
            const title = document.getElementById('bkEditTitle')?.value.trim();
            if (!title) {
                const hint = document.createElement('div');
                hint.textContent = '⚠️ 请输入作品标题';
                hint.style.cssText = 'color:#c62828; font-size:12px; margin:4px 0 8px;';
                const input = document.getElementById('bkEditTitle');
                input.parentNode.insertBefore(hint, input.nextSibling);
                setTimeout(() => hint.remove(), 2000);
                return;
            }
            const novels = getNovels();
            const novel = novels.find(n => n.id === viewingNovelId);
            if (novel) {
                novel.title = title;
                novel.emoji = document.getElementById('bkEditEmoji')?.value || '📖';
                novel.author = document.getElementById('bkEditAuthor')?.value.trim() || '';
                novel.synopsis = document.getElementById('bkEditSynopsis')?.value || '';
                novel.writingStyle = document.getElementById('bkEditStyle')?.value || '';
                novel.notes = document.getElementById('bkEditNotes')?.value || '';
                novel.updatedAt = new Date().toISOString();
                saveNovels(novels);
            }
            showEditForm = false;
            refresh(container);
        });
        return;
    }

    // ---- 章节编辑/新建表单 ----
    if (showChapterForm && viewingNovelId) {
        container.querySelector('#bkCancelCh')?.addEventListener('click', () => {
            showChapterForm = false;
            editingChapterId = null;
            refresh(container);
        });
        container.querySelector('#bkSaveCh')?.addEventListener('click', () => {
            const chTitle = document.getElementById('bkChTitle')?.value.trim() || '';
            const content = document.getElementById('bkChContent')?.value || '';
            const summary = document.getElementById('bkChSummary')?.value || '';
            const novels = getNovels();
            const novel = novels.find(n => n.id === viewingNovelId);
            if (!novel) return;
            if (!novel.chapters) novel.chapters = [];

            if (editingChapterId) {
                const ch = novel.chapters.find(c => c.id === editingChapterId);
                if (ch) {
                    ch.title = chTitle;
                    ch.content = content;
                    ch.summary = summary;
                }
            } else {
                novel.chapters.push({
                    id: genId('ch'),
                    title: chTitle,
                    content,
                    summary,
                    createdAt: new Date().toISOString()
                });
            }
            novel.updatedAt = new Date().toISOString();
            saveNovels(novels);
            showChapterForm = false;
            editingChapterId = null;
            refresh(container);
        });

        // AI 辅助：点击后直接生成章节，不填入文本框
        container.querySelector('#bkAiWrite')?.addEventListener('click', () => {
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:300;display:flex;align-items:center;justify-content:center;';
            overlay.innerHTML = `
                <div style="background:white;border-radius:20px;padding:20px;width:300px;">
                    <div style="font-weight:600;font-size:16px;margin-bottom:4px;">🤖 AI 生成本章</div>
                    <div style="font-size:12px;color:#888;margin-bottom:12px;">描述本章的情节走向：</div>
                    <textarea id="aiGenDesc" rows="4" placeholder="例如：主角第一次踏入暮色森林，遇到了一个神秘的精灵……"
                              style="width:100%;border:1px solid #ccc;border-radius:8px;padding:10px;font-size:14px;line-height:1.5;resize:vertical;box-sizing:border-box;font-family:inherit;"></textarea>
                    <div style="display:flex;gap:8px;margin-top:12px;">
                        <button id="aiGenCancel" style="flex:1;padding:8px;border-radius:12px;border:1px solid #ccc;background:white;color:#666;cursor:pointer;font-size:13px;">取消</button>
                        <button id="aiGenConfirm" style="flex:1;padding:8px;border-radius:12px;border:none;background:linear-gradient(135deg,#0b93f6,#8e24aa);color:white;cursor:pointer;font-size:13px;font-weight:600;">✨ 生成</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);

            overlay.querySelector('#aiGenCancel').onclick = () => overlay.remove();

            overlay.querySelector('#aiGenConfirm').onclick = () => {
                const desc = overlay.querySelector('#aiGenDesc').value.trim();
                if (!desc) {
                    overlay.querySelector('#aiGenDesc').style.borderColor = '#e53935';
                    setTimeout(() => overlay.querySelector('#aiGenDesc').style.borderColor = '#ccc', 1500);
                    return;
                }
                overlay.remove();
                startAiGeneration(container, desc, !!editingChapterId, editingChapterId);
            };
        });

        return;
    }

    // ---- 小说详情页 ----
    if (viewingNovelId && !viewingChapterId) {
        container.querySelectorAll('.bk-chapter').forEach(item => {
            item.addEventListener('click', () => {
                viewingChapterId = item.dataset.chapterId;
                refresh(container);
            });
        });
        container.querySelector('#bkAddChapter')?.addEventListener('click', () => {
            showChapterForm = true;
            editingChapterId = null;
            refresh(container);
        });
        container.querySelector('#bkEditNovel')?.addEventListener('click', () => {
            showEditForm = true;
            refresh(container);
        });
        container.querySelector('#bkDeleteNovel')?.addEventListener('click', async () => {
            const ok = await showConfirm('确定要删除这部作品吗？所有章节将一并删除。');
            if (!ok) return;
            let novels = getNovels();
            novels = novels.filter(n => n.id !== viewingNovelId);
            saveNovels(novels);
            viewingNovelId = null;
            refresh(container);
        });
        return;
    }

    // ---- 阅读章节页 ----
    if (viewingNovelId && viewingChapterId) {
        container.querySelector('#bkEditChapter')?.addEventListener('click', () => {
            editingChapterId = viewingChapterId;
            showChapterForm = true;
            refresh(container);
        });
        container.querySelector('#bkDeleteChapter')?.addEventListener('click', async () => {
            const ok = await showConfirm('确定要删除此章节吗？');
            if (!ok) return;
            const novels = getNovels();
            const novel = novels.find(n => n.id === viewingNovelId);
            if (novel && novel.chapters) {
                novel.chapters = novel.chapters.filter(c => c.id !== viewingChapterId);
                novel.updatedAt = new Date().toISOString();
                saveNovels(novels);
            }
            viewingChapterId = null;
            refresh(container);
        });
        // ★ 前后章跳转
        container.querySelector('#bkPrevChapter')?.addEventListener('click', () => {
            const id = container.querySelector('#bkPrevChapter')?.dataset.chapterId;
            if (id) { viewingChapterId = id; refresh(container); }
        });
        container.querySelector('#bkNextChapter')?.addEventListener('click', () => {
            const id = container.querySelector('#bkNextChapter')?.dataset.chapterId;
            if (id) { viewingChapterId = id; refresh(container); }
        });
        container.querySelector('#bkBackToNovel')?.addEventListener('click', () => {
            viewingChapterId = null;
            refresh(container);
        });

        // 概要折叠
        const summaryToggle = container.querySelector('#bkSummaryToggle');
        const summaryBody = container.querySelector('#bkSummaryBody');
        if (summaryToggle && summaryBody) {
            summaryToggle.addEventListener('click', () => {
                const isOpen = summaryBody.classList.toggle('open');
                summaryToggle.querySelector('.arrow')?.classList.toggle('open', isOpen);
            });
        }

        return;


    }
}

// ---- 返回处理 ----
export function handleBack(container) {
    if (showCreateForm || showEditForm || showChapterForm) {
        showCreateForm = false;
        showEditForm = false;
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
    if (viewingNovelId) {
        viewingNovelId = null;
        refresh(container);
        return true;
    }
    return false;
}

// ---- 注册 ----
if (!window.__moduleRegistry) window.__moduleRegistry = [];
window.__moduleRegistry.push({ id: 'bookClub', label: '书社', icon: '📚', color: '#8e24aa', render, bindEvents, handleBack });

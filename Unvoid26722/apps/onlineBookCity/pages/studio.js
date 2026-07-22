// apps/onlineBookCity/pages/studio.js — 创作中心

import { getBook, putBook, genId } from '../store.js';
import { getCurrentPreset } from '../api.js';
import { taskManager } from '../../../store/AITaskManager.js';
import { showPrompt, showConfirm } from '../../../store/dialog.js';

export function render(state) {
  const editingBookId = state.params?.bookId || null;
  return `
    <div class="obc-studio">
      <div class="obc-section-title">✍️ 创作中心</div>
      <div id="obcStudioContent">
        ${editingBookId ? renderEditor(state, editingBookId) : renderLanding()}
      </div>
    </div>
  `;
}

function renderLanding() {
  return `
    <div class="obc-studio-landing">
      <button class="obc-btn obc-btn-primary" id="obcCreateBookBtn" style="width:100%;padding:16px;font-size:16px;">
        ✨ 创建新作品
      </button>
      <div style="margin-top:16px;color:#999;font-size:13px;text-align:center;">
        或在「我的书架」中选择已有作品进行编辑
      </div>
    </div>
  `;
}

function renderEditor(state, bookId) {
  // 使用异步渲染，这里先返回骨架
  return `<div id="obcEditorMount" data-book-id="${bookId}">加载中...</div>`;
}

export async function bindEvents(container, state) {
  const createBtn = container.querySelector('#obcCreateBookBtn');
  if (createBtn) {
    createBtn.addEventListener('click', async () => {
      const title = await showPrompt('请输入作品标题');
      if (!title) return;
      const author = await showPrompt('作者名（可选）', '佚名');
      const synopsis = await showPrompt('作品简介（可选）');

      const book = {
        id: genId('book'),
        title,
        author: author || '佚名',
        cover: '📖',
        synopsis: synopsis || '',
        tags: [],
        status: 'ongoing',
        chapters: [],
        wordCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await putBook(book);
      state.navigateTo('detail', { bookId: book.id });
    });
  }

  // 渲染编辑器（异步加载数据后）
  const mountEl = container.querySelector('#obcEditorMount');
  if (mountEl) {
    const bookId = mountEl.dataset.bookId;
    const book = await getBook(bookId);
    if (!book) {
      mountEl.innerHTML = '<div style="color:#e53935;padding:20px;">作品不存在</div>';
      return;
    }
    mountEl.innerHTML = renderEditorContent(book);
    bindEditorEvents(container, mountEl, book, state);
  }
}

function renderEditorContent(book) {
  return `
    <div class="obc-edit-header">
      <input class="obc-input obc-edit-title" value="${book.title}" placeholder="作品标题" />
      <input class="obc-input obc-edit-author" value="${book.author}" placeholder="作者" />
    </div>
    <div class="obc-edit-section">
      <div class="obc-edit-section-label">作品简介</div>
      <textarea class="obc-textarea obc-edit-synopsis" placeholder="写一段简介..." rows="3">${book.synopsis}</textarea>
    </div>
    <div class="obc-edit-section">
      <div class="obc-edit-section-label">章节列表</div>
      <div class="obc-chapter-list" id="obcChapterList">
        ${(book.chapters || []).map((ch, i) => `
          <div class="obc-chapter-item" data-chapter-id="${ch.id}">
            <span class="obc-chapter-num">第${i + 1}章</span>
            <span class="obc-chapter-title">${ch.title}</span>
            <span class="obc-chapter-summary">${ch.summary || ''}</span>
          </div>
        `).join('')}
      </div>
    </div>
    <div class="obc-edit-actions">
      <button class="obc-btn obc-btn-primary" id="obcGenChapterBtn">🤖 AI 生成新章节</button>
      <button class="obc-btn obc-btn-secondary" id="obcSaveBookBtn">💾 保存</button>
    </div>
  `;
}

function bindEditorEvents(container, mountEl, book, state) {
  // 保存
  mountEl.querySelector('#obcSaveBookBtn').addEventListener('click', async () => {
    book.title = mountEl.querySelector('.obc-edit-title').value || book.title;
    book.author = mountEl.querySelector('.obc-edit-author').value || book.author;
    book.synopsis = mountEl.querySelector('.obc-edit-synopsis').value || book.synopsis;
    await putBook(book);
    // 用 toast 提示（暂用 alert 替代）
    alert('✅ 保存成功');
  });

  // AI 生成章节
  mountEl.querySelector('#obcGenChapterBtn').addEventListener('click', async () => {
    const preset = await getCurrentPreset();
    if (!preset) {
      alert('⚠️ 请先在「书城设置」中添加 API 预设');
      return;
    }

    const description = await showPrompt('描述你想写的情节（或留空让 AI 自由发挥）');
    if (description === null) return;

    const chNum = (book.chapters || []).length + 1;
    const chId = genId('ch');

    // 先插入占位章节
    const newChapter = {
      id: chId,
      num: chNum,
      title: `第${chNum}章`,
      summary: '生成中...',
      content: '',
      createdAt: new Date().toISOString()
    };
    if (!book.chapters) book.chapters = [];
    book.chapters.push(newChapter);
    await putBook(book);
    // 刷新 UI
    mountEl.innerHTML = renderEditorContent(book);
    bindEditorEvents(container, mountEl, book, state);

    // 通过任务中心生成
    const { OBC_STORY_WRITING_PROMPT } = await import('../../prompts.js');
    const systemPrompt = OBC_STORY_WRITING_PROMPT + `\n\n作品信息：\n标题：${book.title}\n作者：${book.author}\n简介：${book.synopsis}\n` +
      (book.chapters.length > 1 ? `前情概要：\n${book.chapters.slice(-3).map(c => `- 第${c.num}章 ${c.title}：${c.summary}`).join('\n')}` : '');

    try {
      const result = await taskManager.watch('story', `生成《${book.title}》第${chNum}章`, async () => {
        const { callAIWithMessages } = await import('../../aiService.js');
        const content = await callAIWithMessages({
          systemPrompt,
          userContent: description || `请写第${chNum}章的内容`,
          maxTokens: preset.maxTokens || 8000,
          temperature: preset.temperature || 0.7,
          presetId: preset.id
        });
        return content;
      });

      // 解析结果
      const chapterMatch = result.match(/---CHAPTER---\n([\s\S]+?)(?=\n---(?:SUMMARY|SYNOPSIS_UPDATE|STYLE_UPDATE)---|$)/);
      const summaryMatch = result.match(/---SUMMARY---\n([\s\S]+?)(?=\n---(?:SYNOPSIS_UPDATE|STYLE_UPDATE)---|$)/);

      const ch = book.chapters.find(c => c.id === chId);
      if (ch) {
        ch.content = chapterMatch ? chapterMatch[1].trim() : result;
        ch.summary = summaryMatch ? summaryMatch[1].trim() : '（无摘要）';
        ch.title = `第${chNum}章`;
      }

      // 更新字数
      book.wordCount = (book.wordCount || 0) + ch.content.length;
      await putBook(book);
      mountEl.innerHTML = renderEditorContent(book);
      bindEditorEvents(container, mountEl, book, state);
    } catch (e) {
      alert(`❌ 生成失败：${e.message}`);
      // 保留占位章节，用户可手动删除
    }
  });
}

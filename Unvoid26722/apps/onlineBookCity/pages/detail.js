// apps/onlineBookCity/pages/detail.js — 小说详情页

import { getBook, putBook, genId } from '../store.js';
import { getDiscoverData, putDiscoverData } from '../store.js';
import { showPrompt, showConfirm } from '../../../store/dialog.js';
import { taskManager } from '../../../store/AITaskManager.js';

// ============================================================
//  数据获取
// ============================================================

async function getBookData(bookId) {
  return getBook(bookId);
}

// ============================================================
//  渲染
// ============================================================

export function render() {
  return `<div id="obcDetailMount" class="obc-detail-mount">加载中...</div>`;
}

export async function bindEvents(container, state) {
  const mountEl = container.querySelector('#obcDetailMount');
  const bookId = state.params?.bookId;
  if (!bookId) {
    mountEl.innerHTML = '<div style="padding:20px;color:#e53935;">缺少作品 ID</div>';
    return;
  }

  const book = await getBookData(bookId);
  if (!book) {
    mountEl.innerHTML = '<div style="padding:20px;color:#e53935;">作品不存在</div>';
    return;
  }

  // 检查是否已收藏
  const isCollected = book.status === 'collected';
  const chCount = (book.chapters || []).length;
  const wordCount = book.wordCount || 0;

  mountEl.innerHTML = `
    <div class="obc-detail-page">

      <!-- 第一部分：封面 + 信息（～1/3屏高） -->
<div class="obc-detail-header-section">
  <div class="obc-detail-cover-wrap">
    <div class="obc-detail-cover"></div>
  </div>
  <div class="obc-detail-info">
    <div class="obc-detail-title">${book.title}</div>
    <div class="obc-detail-author">${book.author}</div>
    <div class="obc-detail-tags">
      ${(book.tags || []).slice(0, 1).map(t => `<span class="obc-detail-tag">${t}</span>`).join('')}
      ${book.highlight ? book.highlight.split(',').map(h => `<span class="obc-detail-tag">${h.trim()}</span>`).join('') : ''}
      ${(!book.tags || book.tags.length === 0) && !book.highlight ? '<span class="obc-detail-tag obc-detail-tag-empty">未分类</span>' : ''}
    </div>
    <div class="obc-detail-wordcount">共 ${wordCount.toLocaleString()} 字</div>
  </div>
</div>

<!-- ★ 功能按钮区移到封面和信息下面，紧跟着 -->
<div class="obc-detail-actions">
  <button class="obc-detail-action-btn" id="obcActionRead">
    <span>开始阅读</span>
  </button>
  <button class="obc-detail-action-btn ${isCollected ? 'obc-action-collected' : ''}" id="obcActionCollect">
    <span>🤍 收藏</span>
  </button>
  <button class="obc-detail-action-btn" id="obcActionUrge">
    <span>⚡ 催更</span>
  </button>
  <button class="obc-detail-action-btn" id="obcActionPromote">
    <span>👑 推金</span>
  </button>
</div>
      <!-- 第三部分：简介区（～2/5屏高，可展开收起） -->
      <div class="obc-detail-section">
        <div class="obc-detail-section-title">📖 简介</div>
        <div class="obc-detail-synopsis-wrap" id="obcSynopsisWrap">
          <div class="obc-detail-synopsis ${book.synopsis && book.synopsis.length > 80 ? 'obc-synopsis-clamped' : ''}"
               id="obcSynopsisText">${book.synopsis || '（暂无简介）'}</div>
          ${book.synopsis && book.synopsis.length > 80 ? '<button class="obc-synopsis-toggle" id="obcSynopsisToggle">展开全部</button>' : ''}
        </div>
      </div>

      <!-- 第四部分：章节目录区 -->
      <div class="obc-detail-section obc-detail-chapter-section">
        <div class="obc-detail-section-title">
          📑 目录（共 ${chCount} 章）
          ${chCount === 0 ? '<span style="font-size:12px;color:#999;font-weight:400;"> 暂无章节，点击「催更」生成</span>' : ''}
        </div>
        <div class="obc-detail-chapter-list" id="obcChapterList">
          ${(book.chapters || []).map((ch, i) => `
            <div class="obc-detail-chapter-row" data-chapter-id="${ch.id}">
              <span class="obc-chapter-num">${i + 1}</span>
              <div class="obc-chapter-info">
                <span class="obc-chapter-title">${ch.title}</span>
                <span class="obc-chapter-summary">${ch.summary || ''}</span>
              </div>
            </div>
          `).join('')}
          ${chCount === 0 ? '<div class="obc-chapter-empty">暂无章节</div>' : ''}
        </div>
      </div>
    </div>
  `;

  // ============================================================
  //  绑定事件
  // ============================================================


  // 简介展开/收起
  const toggleBtn = mountEl.querySelector('#obcSynopsisToggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const textEl = mountEl.querySelector('#obcSynopsisText');
      const isClamped = textEl.classList.contains('obc-synopsis-clamped');
      textEl.classList.toggle('obc-synopsis-clamped');
      toggleBtn.textContent = isClamped ? '收起' : '展开全部';
    });
  }

  // 收藏/取消收藏
  mountEl.querySelector('#obcActionCollect').addEventListener('click', async () => {
    if (isCollected) {
      // 已收藏 → 取消收藏
      const confirmed = await showConfirm('确定取消收藏吗？章节内容将保留。');
      if (!confirmed) return;
      // 从 books 仓库删除
      book.status = 'discover';
      await putBook(book);
      // 刷新页面
      bindEvents(container, state);
    } else {
      // 未收藏 → 收藏
      const newBook = {
        id: book.id,
        title: book.title,
        author: book.author || '佚名',
        cover: book.cover || '📖',
        synopsis: book.synopsis || '',
        tags: book.tags || [],
        categoryId: book.categoryId,
        highlight: book.highlight || '',
        status: 'collected',
        chapters: book.chapters || [],
        wordCount: book.wordCount || 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await putBook(newBook);
      // 刷新页面
      bindEvents(container, state);
    }
  });

  // 开始阅读 / 继续阅读
  mountEl.querySelector('#obcActionRead').addEventListener('click', () => {
    const chapters = book.chapters || [];
    if (chapters.length === 0) {
      alert('还没有章节，点击「催更」生成第一章吧');
      return;
    }
    // 跳转到第一章或上次阅读的章节
    state.navigateTo('reader', { bookId, chapterId: chapters[0].id });
  });

  // 催更
  mountEl.querySelector('#obcActionUrge').addEventListener('click', async () => {
    // 先确认是否已收藏（催更需要存章节内容）
    let targetBook = book;

    // 如果书还没收藏，自动收藏
    if (book.status === 'discover') {
      book.status = 'collected';
      await putBook(book);
    }

    const description = await showPrompt('描述下一章的情节（或留空让 AI 自由发挥）');
    if (description === null) return;

    const chNum = (targetBook.chapters || []).length + 1;
    const chId = genId('ch');

    // 插入占位章节
    const newChapter = {
      id: chId,
      num: chNum,
      title: `第${chNum}章`,
      summary: '生成中...',
      content: '',
      createdAt: new Date().toISOString()
    };
    if (!targetBook.chapters) targetBook.chapters = [];
    targetBook.chapters.push(newChapter);
    await putBook(targetBook);

    // 刷新 UI
    bindEvents(container, state);

    // 通过任务中心生成
    const { OBC_STORY_WRITING_PROMPT } = await import('../../prompts.js');

    const prevChapter = targetBook.chapters.length > 1
      ? targetBook.chapters[targetBook.chapters.length - 2]
      : null;

    let context = `作品信息：\n标题：${targetBook.title}\n作者：${targetBook.author}\n简介：${targetBook.synopsis}\n`;
    if ((targetBook.tags || []).length > 0) {
      context += `标签：${targetBook.tags.join('、')}\n`;
    }
    context += `\n各章要点：\n`;
    context += (targetBook.chapters || [])
      .filter(c => c.id !== chId) // 排除当前占位章节
      .map((c, i) => `第${i + 1}章 ${c.title}：${c.summary || '（无摘要）'}`)
      .join('\n');

    if (prevChapter && prevChapter.content) {
      context += `\n\n上一章正文：\n${prevChapter.content.slice(0, 2000)}`;
    }

    const systemPrompt = OBC_STORY_WRITING_PROMPT + `\n\n${context}`;

    try {
      const { getCurrentPreset } = await import('../api.js');
      const preset = await getCurrentPreset();

      const result = await taskManager.watch('story', `催更《${targetBook.title}》第${chNum}章`, async () => {
        const { callAIWithMessages } = await import('../../aiService.js');
        return callAIWithMessages({
          systemPrompt,
          userContent: description || `请写第${chNum}章的内容`,
          maxTokens: preset?.maxTokens || 8000,
          temperature: preset?.temperature || 0.7,
          presetId: preset?.id
        });
      });

      // 解析结果
      const chapterMatch = result.match(/---CHAPTER---\n([\s\S]+?)(?=\n---(?:SUMMARY|SYNOPSIS_UPDATE|STYLE_UPDATE)---|$)/);
      const summaryMatch = result.match(/---SUMMARY---\n([\s\S]+?)(?=\n---(?:SYNOPSIS_UPDATE|STYLE_UPDATE)---|$)/);

      // 重新读取最新数据
      const freshBook = await getBook(targetBook.id);
      if (!freshBook) return;

      const ch = freshBook.chapters.find(c => c.id === chId);
      if (ch) {
        ch.content = chapterMatch ? chapterMatch[1].trim() : result;
        ch.summary = summaryMatch ? summaryMatch[1].trim() : '（无摘要）';
        ch.title = `第${chNum}章`;
      }

      freshBook.wordCount = (freshBook.wordCount || 0) + (ch?.content?.length || 0);
      await putBook(freshBook);

      // 刷新页面
      bindEvents(container, state);

    } catch (e) {
      alert(`❌ 催更失败：${e.message}`);
      // 保留占位章节
    }
  });

  // 推金
  mountEl.querySelector('#obcActionPromote').addEventListener('click', async () => {
    const pinned = await getDiscoverData('pinned') || [];

    // 检查是否已在金榜
    if (pinned.find(p => p.id === bookId)) {
      alert('👑 本书已在金榜中');
      return;
    }

    // 获取所属类别
    const catId = book.categoryId;
    if (!catId) {
      alert('⚠️ 只有发现页推荐的书才能推金');
      return;
    }

    pinned.push({
      id: bookId,
      title: book.title,
      categoryId: book.categoryId,  // ★ 加上分类
      highlight: book.highlight || book.synopsis?.slice(0, 12) || '精彩作品'
    });

    await putDiscoverData('pinned', pinned);
    // ★ 通知发现页缓存更新
    const { addToPinnedCache } = await import('./discover.js');
    addToPinnedCache({
      id: bookId,
      title: book.title,
      categoryId: book.categoryId,
    });
    alert('✅ 已推上金榜！可在发现页查看');
  });
}

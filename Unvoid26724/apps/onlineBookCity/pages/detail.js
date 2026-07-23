// apps/onlineBookCity/pages/detail.js — 小说详情页

import { getBook, putBook, genId } from '../store.js';
import { getDiscoverData, putDiscoverData } from '../store.js';
import { showAlert, showPrompt, showConfirm } from '../../../store/dialog.js';
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
  if (!mountEl) return;
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
          <div class="obc-detail-synopsis ${book.synopsis ? 'obc-synopsis-clamped' : ''}"
               id="obcSynopsisText">${book.synopsis || '（暂无简介）'}</div>
          ${book.synopsis ? '<button class="obc-synopsis-toggle" id="obcSynopsisToggle">展开全部</button>' : ''}
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
      <span class="obc-chapter-title">${ch.title}</span>
      <span class="obc-chapter-summary">${ch.summary || ''}</span>
    </div>
  `).join('')}
</div>
      </div>
    </div>
  `;

  // ★ 检测简介是否真的被裁剪，决定是否显示展开按钮
  const synopsisText = mountEl.querySelector('#obcSynopsisText');
  const toggleBtn = mountEl.querySelector('#obcSynopsisToggle');
  if (synopsisText && toggleBtn) {
    // scrollHeight 是实际内容高度，offsetHeight 是显示出来的高度
    // 如果内容没被裁剪，隐藏按钮
    if (synopsisText.scrollHeight <= synopsisText.offsetHeight) {
      toggleBtn.style.display = 'none';
    }
  }


  // ============================================================
  //  绑定事件
  // ============================================================


  // 简介展开/收起
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

      // ★ 收藏成功后，如果这本书在金榜引用中，自动转入 pinned
      const catId = book.categoryId;
      if (catId) {
        const contentRefs = await getDiscoverData(`content_${catId}`);
        if (contentRefs && contentRefs.golden) {
          const idx = contentRefs.golden.indexOf(book.id);
          if (idx !== -1) {
            contentRefs.golden.splice(idx, 1);

            const pinned = await getDiscoverData('pinned') || [];
            if (!pinned.find(p => p.id === book.id)) {
              pinned.push({
                id: book.id,
                title: book.title,
                categoryId: book.categoryId,
                highlight: book.highlight || book.synopsis?.slice(0, 12) || '精彩作品'
              });
            }

            await putDiscoverData(`content_${catId}`, contentRefs);
            await putDiscoverData('pinned', pinned);
          }
        }
      }

      // 刷新页面
      bindEvents(container, state);
    }
  });

  // 开始阅读 / 继续阅读
  mountEl.querySelector('#obcActionRead').addEventListener('click', async () => {
    const chapters = book.chapters || [];
    if (chapters.length === 0) {
      await showAlert('还没有章节，点击「催更」生成第一章吧');
      return;
    }
    // ★ 尝试跳转到上次阅读的章节，不存在则返回第一章
    const lastReadId = book.lastReadChapterId;
    const targetChapter = chapters.find(ch => ch.id === lastReadId);
    state.navigateTo('reader', {
      bookId,
      chapterId: targetChapter ? targetChapter.id : chapters[0].id
    });
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
    const { buildStylePromptFromSettings } = await import('../styleTemplates.js');

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
      context += `\n\n上一章正文：\n${prevChapter.content}`;
    }

    // 第 265 行（改 systemPrompt 的构建方式）
    const stylePrompt = buildStylePromptFromSettings();
    let systemPrompt = OBC_STORY_WRITING_PROMPT;
    if (stylePrompt) systemPrompt += `\n\n${stylePrompt}`;
    systemPrompt += `\n\n${context}`;
    // ★ 追加选中的提示词条目（全书城生效）
    try {
      const wbIds = JSON.parse(localStorage.getItem('obookcity_worldbook_ids') || '[]');
      if (wbIds.length > 0) {
        const allEntries = JSON.parse(localStorage.getItem('worldbook_entries') || '[]');
        const selected = allEntries.filter(e => wbIds.includes(e.id) && e.enabled !== false);
        if (selected.length > 0) {
          const wbText = selected
            .sort((a, b) => (b.priority || 6) - (a.priority || 6))
            .map(e => `- ${e.title}：${e.text}`)
            .join('\n');
          systemPrompt = `参考设定：\n${wbText}\n\n` + systemPrompt;
        }
      }
    } catch { /* 静默忽略 */ }

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
      const contentEl = container.closest('#obcContent') || container;
      if (!contentEl.querySelector('#obcDetailMount')) return;  // ← 页面已切换
      bindEvents(container, state);

    } catch (e) {
      await showAlert(`❌ 催更失败：${e.message}`);
      // 回滚：删掉刚加的占位章节
      const idx = targetBook.chapters.findIndex(c => c.id === chId);
      if (idx !== -1) {
        targetBook.chapters.splice(idx, 1);
        await putBook(targetBook);
      }
    }
  });

  // 推金
  mountEl.querySelector('#obcActionPromote').addEventListener('click', async () => {
    const pinned = await getDiscoverData('pinned') || [];

    // 获取所属类别
    const catId = book.categoryId;
    if (!catId) {
      await showAlert('⚠️ 只有发现页推荐的书才能推金');
      return;
    }

    // 检查是否已在金榜
    if (pinned.find(p => p.id === bookId)) {
      await showAlert('👑 本书已在金榜中');
      return;
    }

    const contentRefs = await getDiscoverData(`content_${catId}`);
    if (contentRefs && contentRefs.golden && contentRefs.golden.includes(bookId)) {
      await showAlert('👑 本书已在金榜中');
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
    await showAlert('✅ 已推上金榜！可在发现页查看');
  });

  // 章节行点击 → 跳转阅读器
  mountEl.querySelectorAll('.obc-detail-chapter-row').forEach(row => {
    row.addEventListener('click', () => {
      const chapters = book.chapters || [];
      if (chapters.length === 0) return;
      state.navigateTo('reader', { bookId, chapterId: row.dataset.chapterId });
    });
  });

}

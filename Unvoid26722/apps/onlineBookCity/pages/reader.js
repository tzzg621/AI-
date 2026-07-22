// apps/onlineBookCity/pages/reader.js — 章节阅读器

import { getBook } from '../store.js';

export function render(/* state */) {
  return `<div id="obcReaderMount">加载中...</div>`;
}

export async function bindEvents(container, state) {
  const mountEl = container.querySelector('#obcReaderMount');
  const { bookId, chapterId } = state.params || {};
  if (!bookId || !chapterId) {
    mountEl.innerHTML = '<div style="padding:20px;color:#e53935;">参数错误</div>';
    return;
  }

  const book = await getBook(bookId);
  if (!book) {
    mountEl.innerHTML = '<div style="padding:20px;color:#e53935;">作品不存在</div>';
    return;
  }

  const chapters = book.chapters || [];
  const currentIdx = chapters.findIndex(ch => ch.id === chapterId);
  const chapter = chapters[currentIdx];
  if (!chapter) {
    mountEl.innerHTML = '<div style="padding:20px;color:#e53935;">章节不存在</div>';
    return;
  }

  const prevCh = currentIdx > 0 ? chapters[currentIdx - 1] : null;
  const nextCh = currentIdx < chapters.length - 1 ? chapters[currentIdx + 1] : null;

  mountEl.innerHTML = `
    <div class="obc-reader">
      <div class="obc-reader-header">
        <div class="obc-reader-title">${book.title} · 第${currentIdx + 1}章 ${chapter.title}</div>
      </div>

      <div class="obc-reader-content" id="obcReaderContent">
        ${chapter.content || '<div style="color:#bbb;padding:40px 0;text-align:center;">（本章暂无内容）</div>'}
      </div>

      <div class="obc-reader-nav">
        ${prevCh ? `<button class="obc-btn obc-btn-secondary" data-chapter-id="${prevCh.id}">‹ 上一章</button>` : '<div></div>'}
        ${nextCh ? `<button class="obc-btn obc-btn-secondary" data-chapter-id="${nextCh.id}">下一章 ›</button>` : '<div></div>'}
      </div>
    </div>
  `;


  // 切换章节
  mountEl.querySelectorAll('.obc-reader-nav button[data-chapter-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.navigateTo('reader', { bookId, chapterId: btn.dataset.chapterId });
    });
  });
}

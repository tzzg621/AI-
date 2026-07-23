// apps/onlineBookCity/pages/bookshelf.js — 我的书架

import { getBooksByStatus } from '../store.js';

export function render(/* state */) {
  return `
    <div class="obc-bookshelf">
      <div class="obc-section-title">📚 我的书架</div>
      <div id="obcBookList" class="obc-book-list"></div>
      <div class="obc-empty-state" id="obcBookshelfEmpty" style="display:none;">
        <div style="font-size:40px;margin-bottom:12px;">📖</div>
        <div style="color:#999;font-size:14px;">还没有作品</div>
        <div style="color:#bbb;font-size:12px;margin-top:4px;">去「发现」或「创作中心」添加作品吧</div>
      </div>
    </div>
  `;
}

export async function bindEvents(container, state) {
  const listEl = container.querySelector('#obcBookList');
  const emptyEl = container.querySelector('#obcBookshelfEmpty');
  const books = await getBooksByStatus('collected');   // ★ 只查已收藏的

  if (!books || books.length === 0) {
    listEl.innerHTML = '';
    emptyEl.style.display = 'block';
    return;
  }

  emptyEl.style.display = 'none';
  listEl.innerHTML = books.map(book => {
    const chCount = (book.chapters || []).length;
    const wordCount = book.wordCount || 0;
    return `
      <div class="obc-book-card" data-book-id="${book.id}">
        <div class="obc-book-cover">${book.cover || '📖'}</div>
        <div class="obc-book-meta">
          <div class="obc-book-title">${book.title}</div>
          <div class="obc-book-sub">
            ${book.author || '佚名'} · ${book.status === 'finished' ? '✅ 已完结' : '📝 连载中'}
          </div>
          <div class="obc-book-stats">${chCount} 章 · ${wordCount.toLocaleString()} 字</div>
        </div>
        <div class="obc-book-arrow">›</div>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('.obc-book-card').forEach(card => {
    card.addEventListener('click', () => {
      state.navigateTo('detail', { bookId: card.dataset.bookId });
    });
  });
}

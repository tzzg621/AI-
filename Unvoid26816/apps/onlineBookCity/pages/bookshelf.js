// apps/onlineBookCity/pages/bookshelf.js — 我的书架

import { getBooksByStatus, putBook } from '../store.js';
import { showPrompt, showConfirm } from '../../../store/dialog.js';

const CATEGORIES_KEY = 'obookcity_shelf_categories';

function loadCategories() {
  try { return JSON.parse(localStorage.getItem(CATEGORIES_KEY) || '[]'); }
  catch { return []; }
}

function saveCategories(cats) {
  localStorage.setItem(CATEGORIES_KEY, JSON.stringify(cats));
}

const CAT_ORDERS_KEY = 'obookcity_cat_orders';

function getCatOrders() {
  try { return JSON.parse(localStorage.getItem(CAT_ORDERS_KEY) || '{}'); }
  catch { return {}; }
}

function saveCatOrders(orders) {
  localStorage.setItem(CAT_ORDERS_KEY, JSON.stringify(orders));
}

function addToCatOrder(category, bookId) {
  const orders = getCatOrders();
  if (!orders[category]) orders[category] = [];
  orders[category] = orders[category].filter(id => id !== bookId);
  orders[category].unshift(bookId);
  saveCatOrders(orders);
}


export function render() {
  return `
    <div class="obc-bookshelf">
      <div class="obc-bookshelf-layout">
        <div class="obc-shelf-sidebar" id="obcShelfSidebar">
          <div class="obc-shelf-sidebar-title">分类</div>
          <div class="obc-shelf-cat-list" id="obcShelfCatList"></div>
        </div>
        <div class="obc-shelf-main" id="obcShelfMain">
          <div class="obc-shelf-header" id="obcShelfHeader">📚 全部</div>
          <div class="obc-shelf-book-area" id="obcShelfBookArea"></div>
          <div class="obc-shelf-empty" id="obcShelfEmpty" style="display:none;">
            <div style="color:#999;font-size:14px;padding:40px 0;text-align:center;">还没有作品</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

export async function bindEvents(container, state) {
  // ★ 清理可能残留的面板 DOM
  container.closest('.obc-container').querySelectorAll('.obc-book-action-overlay').forEach(el => el.remove());
  // ★ 恢复之前的书架分类状态
  const savedState = state.shelfState || {};
  console.log('[书架] 恢复状态:', savedState);  // ← 加这行
  let activeCat = savedState.activeCat || 'all';
  const savedScrollTop = savedState.scrollTop || 0;  // ★ 恢复滚动位置
  const catListEl = container.querySelector('#obcShelfCatList');
  const bookAreaEl = container.querySelector('#obcShelfBookArea');
  const headerEl = container.querySelector('#obcShelfHeader');
  const emptyEl = container.querySelector('#obcShelfEmpty');

  const allBooks = await getBooksByStatus('collected');

  // ─── 渲染分类栏 ───
  function renderCategories() {
    const cats = loadCategories();
    const items = [
      { id: 'all', name: '全部' },
      ...cats.map(c => ({ id: c, name: c })),
      { id: 'uncategorized', name: '未分类' }
    ];

    catListEl.innerHTML = items.map(cat => {
      const count = cat.id === 'all' ? allBooks.length
        : cat.id === 'uncategorized'
          ? allBooks.filter(b => !b.shelfCategory).length
          : allBooks.filter(b => b.shelfCategory === cat.id).length;

      return `
  <div class="obc-shelf-cat-item ${activeCat === cat.id ? 'obc-shelf-cat-active' : ''}"
       data-cat-id="${cat.id}">
    <span class="obc-shelf-cat-name">${cat.name}</span>
    <span class="obc-shelf-cat-count">${count}</span>
  </div>
`;

    }).join('') + `
      <div class="obc-shelf-cat-add" id="obcShelfCatAdd">+ 新建分类</div>
    `;

    // 点击分类（已有）
    catListEl.querySelectorAll('.obc-shelf-cat-item').forEach(item => {
      item.addEventListener('click', (e) => {
        activeCat = item.dataset.catId;
        renderCategories();
        renderBooks();
      });

      // ★ 双击分类 → 改名或删除
      item.addEventListener('dblclick', async (e) => {
        const catId = item.dataset.catId;
        if (catId === 'all' || catId === 'uncategorized') return;
        e.stopPropagation();

        // 弹出操作菜单
        const action = await showCategoryAction(catId, container);
        if (!action) return;

        if (action === 'rename') {
          const cats = loadCategories();
          const oldName = cats.find(c => c === catId);
          if (!oldName) return;
          const newName = await showPrompt('请输入新的分类名称', oldName);
          if (!newName || newName === oldName) return;
          if (cats.includes(newName)) {
            await showAlert('该名称已存在');
            return;
          }
          // 重命名：更新分类列表 + 更新所有书的 shelfCategory
          const newCats = cats.map(c => c === catId ? newName : c);
          saveCategories(newCats);
          const booksInCat = allBooks.filter(b => b.shelfCategory === catId);
          for (const b of booksInCat) {
            b.shelfCategory = newName;
            await putBook(b);
          }
          if (activeCat === catId) activeCat = newName;
          renderCategories();
          renderBooks();

        } else if (action === 'delete') {
          // 复用已有的删除逻辑
          const confirmed = await showConfirm(`确定删除分类「${catId}」吗？\n分类中的书不会丢失，将变为「未分类」。`);
          if (!confirmed) return;
          const cats = loadCategories().filter(c => c !== catId);
          saveCategories(cats);
          const booksInCat = allBooks.filter(b => b.shelfCategory === catId);
          for (const b of booksInCat) {
            delete b.shelfCategory;
            await putBook(b);
          }
          if (activeCat === catId) activeCat = 'all';
          renderCategories();
          renderBooks();
        }
      });
    });


    // 新建分类
    catListEl.querySelector('#obcShelfCatAdd').addEventListener('click', async () => {
      const name = await showPrompt('请输入新分类名称');
      if (!name) return;
      const cats = loadCategories();
      if (cats.includes(name)) return;
      cats.push(name);
      saveCategories(cats);
      activeCat = name;
      renderCategories();
      renderBooks();
    });
  }

  // ─── 渲染书目 ───
  function renderBooks() {
    const rawFiltered = activeCat === 'all' ? allBooks
      : activeCat === 'uncategorized' ? allBooks.filter(b => !b.shelfCategory)
        : allBooks.filter(b => b.shelfCategory === activeCat);

    // ★ 按分类保存的顺序排列
    const orders = getCatOrders();
    const catOrder = orders[activeCat] || [];
    if (catOrder.length > 0 && activeCat !== 'all' && activeCat !== 'uncategorized') {
      const orderMap = new Map(catOrder.map((id, i) => [id, i]));
      rawFiltered.sort((a, b) => {
        const ia = orderMap.get(a.id) ?? Infinity;
        const ib = orderMap.get(b.id) ?? Infinity;
        return ia - ib;
      });
    }
    const filtered = rawFiltered;

    headerEl.textContent = activeCat === 'all' ? '📚 全部'
      : activeCat === 'uncategorized' ? '📚 未分类'
        : `📚 ${activeCat}`;

    if (filtered.length === 0) {
      bookAreaEl.innerHTML = '';
      emptyEl.style.display = 'block';
      return;
    }

    emptyEl.style.display = 'none';
    bookAreaEl.innerHTML = filtered.map(book => {
      const tags = [...(book.tags || []), ...(book.highlight ? book.highlight.split(',') : [])].filter(Boolean).slice(0, 4);

      return `
    <div class="obc-shelf-book-card" data-book-id="${book.id}">
      <div class="obc-shelf-book-top">
        <div class="obc-shelf-book-cover"></div>
        <div class="obc-shelf-book-info">
          <div class="obc-shelf-book-title">${book.title}</div>
<div class="obc-shelf-book-author">${book.author || '佚名'}</div>
          <div class="obc-shelf-book-tags">
            ${tags.map(t => `<span class="obc-shelf-tag">${t}</span>`).join('')}
            ${tags.length === 0 ? '<span class="obc-shelf-tag obc-shelf-tag-empty">未标签</span>' : ''}
          </div>
          <div class="obc-shelf-book-words">${(book.wordCount || 0).toLocaleString()} 字</div>
        </div>
      </div>
      <div class="obc-shelf-book-synopsis">${book.synopsis || '（暂无简介）'}</div>
    </div>
  `;
    }).join('');


    // 点击卡片 → 详情页
    bookAreaEl.querySelectorAll('.obc-shelf-book-card').forEach(card => {
      let holdTimer = null;
      let startX = 0, startY = 0;
      const MOVE_THRESHOLD = 10;

      card.addEventListener('pointerdown', (e) => {
        startX = e.clientX;
        startY = e.clientY;
        holdTimer = setTimeout(() => {
          holdTimer = null;
          card.dataset.longPress = 'true';
          const bookId = card.dataset.bookId;
          const book = allBooks.find(b => b.id === bookId);
          if (book) showBookActionPanel(book, card, container, state, () => {
            renderCategories();
            renderBooks();
          });
        }, 500);
      });

      card.addEventListener('pointermove', (e) => {
        if (!holdTimer) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) > MOVE_THRESHOLD || Math.abs(dy) > MOVE_THRESHOLD) {
          clearTimeout(holdTimer);
          holdTimer = null;
        }
      });

      card.addEventListener('pointerup', () => {
        clearTimeout(holdTimer);
        holdTimer = null;
        setTimeout(() => { card.dataset.longPress = 'false'; }, 100);
      });

      card.addEventListener('pointercancel', () => {
        clearTimeout(holdTimer);
        holdTimer = null;
        card.dataset.longPress = 'false';
      });

      card.addEventListener('click', (e) => {
        if (card.dataset.longPress === 'true') {
          e.stopPropagation();
          return;
        }
        if (e.target.closest('.obc-shelf-book-cat-select')) return;
        state.shelfState = { activeCat, scrollTop: bookAreaEl.scrollTop };
        state.navigateTo('detail', { bookId: card.dataset.bookId });
      });
    });



    // ★ 恢复滚动位置（只在首次加载时）
    if (savedScrollTop > 0) {
      requestAnimationFrame(() => {
        bookAreaEl.scrollTop = savedScrollTop;
      });
    }

  }

  renderCategories();
  renderBooks();
}

// ★ 分类操作菜单（重命名/删除）
function showCategoryAction(catId, container) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'obc-book-action-overlay';
    overlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:190;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="background:white;border-radius:20px;width:280px;padding:20px 20px 30px;box-shadow:0 4px 20px rgba(0,0,0,0.15);">
        <div style="font-size:15px;font-weight:600;color:#333;margin-bottom:14px;">分类「${catId}」</div>
        <div class="obc-book-action-item" id="catActionRename" style="display:flex;align-items:center;gap:12px;padding:14px 12px;border-radius:12px;cursor:pointer;font-size:15px;">
          <span style="font-size:20px;">✏️</span>
          <span>重命名</span>
        </div>
        <div class="obc-book-action-item" id="catActionDelete" style="display:flex;align-items:center;gap:12px;padding:14px 12px;border-radius:12px;cursor:pointer;font-size:15px;color:#e53935;">
          <span style="font-size:20px;">🗑️</span>
          <span>删除此分类</span>
        </div>
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid #f0f0f0;">
          <button id="catActionCancel" style="width:100%;padding:12px;border-radius:12px;border:none;background:#f5f5f5;color:#666;cursor:pointer;font-size:15px;">取消</button>
        </div>
      </div>
    `;
    container.closest('.obc-container').appendChild(overlay);

    overlay.querySelector('#catActionRename').onclick = () => {
      overlay.remove();
      resolve('rename');
    };
    overlay.querySelector('#catActionDelete').onclick = () => {
      overlay.remove();
      resolve('delete');
    };
    overlay.querySelector('#catActionCancel').onclick = () => {
      overlay.remove();
      resolve(null);
    };
    // 点击外部关闭
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { overlay.remove(); resolve(null); }
    });
  });
}

// ★ 长按操作面板
function showBookActionPanel(book, cardEl, container, state, onRefresh) {
  const tags = [...(book.tags || []), ...(book.highlight ? book.highlight.split(',') : [])].filter(Boolean).slice(0, 4);

  const overlay = document.createElement('div');
  overlay.className = 'obc-book-action-overlay';
  overlay.innerHTML = `
    <div class="obc-book-action-backdrop"></div>
    <div class="obc-book-action-panel">
      <div class="obc-book-action-info">
        <div class="obc-book-action-cover"></div>
        <div class="obc-book-action-meta">
          <div class="obc-book-action-title">${book.title}</div>
          <div class="obc-book-action-author">${book.author || '佚名'} · ${(book.wordCount || 0).toLocaleString()} 字</div>
        </div>
      </div>
      <div class="obc-book-action-divider"></div>
      <div class="obc-book-action-list">
        <div class="obc-book-action-item" data-action="category">
          <span class="obc-book-action-icon">📂</span>
          <span>切换分类</span>
          <span style="margin-left:auto;color:#bbb;font-size:12px;">${book.shelfCategory || '未分类'} →</span>
        </div>
        <div class="obc-book-action-item" data-action="export">
          <span class="obc-book-action-icon">📤</span>
          <span>导出TXT</span>
        </div>
        <div class="obc-book-action-item" data-action="uncollect">
          <span class="obc-book-action-icon">💔</span>
          <span>取消收藏</span>
        </div>
      </div>
    </div>
  `;

  container.closest('.obc-container').appendChild(overlay);

  // 点击遮罩关闭
  overlay.querySelector('.obc-book-action-backdrop').addEventListener('click', () => {
    overlay.remove();
    cardEl.dataset.longPress = 'false';
  });

  // 切换分类
  overlay.querySelector('[data-action="category"]').addEventListener('click', async () => {
    const cats = loadCategories();
    const options = ['未分类', ...cats];
    const current = book.shelfCategory || '未分类';

    const pickerOverlay = document.createElement('div');
    pickerOverlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:250;display:flex;align-items:center;justify-content:center;';
    pickerOverlay.innerHTML = `
      <div style="background:white;border-radius:20px;padding:20px;width:260px;">
        <div style="font-weight:600;font-size:15px;margin-bottom:14px;">移动《${book.title}》到</div>
        ${options.map(o => `
          <label style="display:flex;align-items:center;gap:10px;padding:10px;border-radius:10px;cursor:pointer;${o === current ? 'background:#f3e5f5;' : ''}">
            <input type="radio" name="actionCatPick" value="${o}" ${o === current ? 'checked' : ''}>
            <span style="font-size:14px;">${o}</span>
          </label>
        `).join('')}
        <div style="display:flex;gap:10px;margin-top:14px;">
          <button id="actionCatCancel" style="flex:1;padding:10px;border-radius:12px;border:1px solid #ccc;background:white;color:#666;cursor:pointer;">取消</button>
          <button id="actionCatConfirm" style="flex:1;padding:10px;border-radius:12px;border:none;background:#8e24aa;color:white;cursor:pointer;font-weight:600;">确定</button>
        </div>
      </div>
    `;
    container.closest('.obc-container').appendChild(pickerOverlay);

    pickerOverlay.querySelector('#actionCatCancel').onclick = () => pickerOverlay.remove();
    pickerOverlay.querySelector('#actionCatConfirm').onclick = async () => {
      const selected = pickerOverlay.querySelector('input[name="actionCatPick"]:checked');
      if (selected) {
        // ✅ 修复：重新获取完整数据再保存
        const { getBook } = await import('../store.js');
        const fullBook = await getBook(book.id);
        if (!fullBook) return;
        if (selected.value === '未分类') delete fullBook.shelfCategory;
        else fullBook.shelfCategory = selected.value;
        await putBook(fullBook);  // 现在存的是完整数据
        addToCatOrder(selected.value, book.id);   // ★ 记录新分类的顺序
      }
      pickerOverlay.remove();
      overlay.remove();
      cardEl.dataset.longPress = 'false';
      onRefresh();
    };
  });

  // 取消收藏
  overlay.querySelector('[data-action="uncollect"]').addEventListener('click', async () => {
    const confirmed = await showConfirm(`确定取消收藏《${book.title}》吗？`);
    if (!confirmed) return;
    // ✅ 修复
    const { getBook } = await import('../store.js');
    const fullBook = await getBook(book.id);
    if (!fullBook) return;
    fullBook.status = 'discover';
    await putBook(fullBook);
    overlay.remove();
    cardEl.dataset.longPress = 'false';
    onRefresh();
  });

  // ★ 导出 TXT
  overlay.querySelector('[data-action="export"]').addEventListener('click', async () => {
    overlay.remove();
    cardEl.dataset.longPress = 'false';

    // 书架列表不包含章节正文，需要重新获取完整数据
    const { getBook } = await import('../store.js');
    const fullBook = await getBook(book.id);
    if (!fullBook) {
      await showAlert('⚠️ 作品数据不存在');
      return;
    }

    try {
      const txtContent = buildExportText(fullBook);
      downloadTextFile(txtContent, `${fullBook.title}_${Date.now()}.txt`);
    } catch (e) {
      await showAlert(`❌ 导出失败：${e.message}`);
    }
  });

}


// ============================================================
//  TXT 导出工具
// ============================================================

function buildExportText(book) {
  const lines = [];

  lines.push('========================================');
  lines.push('            作品卡片');
  lines.push('========================================');
  lines.push('');
  lines.push(`【标题】${book.title || '未命名'}`);
  lines.push(`【作者】${book.author || '佚名'}`);
  lines.push(`【字数】${(book.wordCount || 0).toLocaleString()} 字`);
  lines.push(`【标签】${(book.tags || []).join('、') || '无'}`);
  lines.push(`【创建时间】${book.createdAt || '未知'}`);
  lines.push(`【最后更新】${book.updatedAt || '未知'}`);
  lines.push('');

  if (book.synopsis) {
    lines.push('━━━ 简介 ━━━');
    lines.push('');
    lines.push(book.synopsis);
    lines.push('');
  }

  const chapters = book.chapters || [];
  if (chapters.length === 0) {
    lines.push('（暂无章节）');
  } else {
    lines.push(`━━━ 共 ${chapters.length} 章 ━━━`);
    lines.push('');
    chapters.forEach((ch, index) => {
      lines.push(`【第 ${index + 1} 章】${ch.title}`);
      if (ch.summary) lines.push(`  摘要：${ch.summary}`);
      lines.push('');
      if (ch.content) {
        const paragraphs = ch.content.split('\n').filter(p => p.trim()).join('\n\n');
        lines.push(paragraphs);
        lines.push('');
      } else {
        lines.push('  （本章暂无内容）');
        lines.push('');
      }
      if (index < chapters.length - 1) {
        lines.push('─── ─── ───');
        lines.push('');
      }
    });
  }

  lines.push('========================================');
  lines.push(`  由「缔造者空间 · 线上书城」导出`);
  lines.push(`  导出时间：${new Date().toLocaleString()}`);
  lines.push('========================================');

  return lines.join('\n');
}

function downloadTextFile(content, filename) {
  // ★ 加 BOM：\uFEFF 告诉手机 "我是 UTF-8"
  const blob = new Blob(['\uFEFF' + content], { type: 'text/plain;charset=utf-8' });
  // const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

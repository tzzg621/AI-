// apps/onlineBookCity/pages/discover.js — 发现页

import { showPrompt, showConfirm } from '../../../store/dialog.js';
import { taskManager } from '../../../store/AITaskManager.js';
import { genId, getDiscoverData, putDiscoverData, getBook, putBook } from '../store.js';

// ============================================================
//  数据层
// ============================================================

// ★ 内存缓存（只对当前页面生效，刷新即释放）
const _cache = {};

const DEFAULT_CATEGORIES = [
  { id: 'all', name: '全部' },
  { id: 'fantasy', name: '奇幻' },
  { id: 'sci_fi', name: '科幻' },
  { id: 'mystery', name: '悬疑' },
  { id: 'romance', name: '言情' },
  { id: 'martial', name: '武侠' },
  { id: 'daily', name: '日常' }
];

// ★ 从 localStorage 迁移一次（如果还有旧数据）
async function migrateFromLocalStorage() {
  const oldCats = localStorage.getItem('obc_discover_categories');
  const oldPinned = localStorage.getItem('obc_discover_pinned');
  const oldContent = localStorage.getItem('obc_discover_content');

  if (oldCats) {
    try {
      const data = JSON.parse(oldCats);
      await putDiscoverData('categories', data);
    } catch { /* ignore */ }
    localStorage.removeItem('obc_discover_categories');
  }

  if (oldPinned) {
    try {
      const data = JSON.parse(oldPinned);
      await putDiscoverData('pinned', data);
    } catch { /* ignore */ }
    localStorage.removeItem('obc_discover_pinned');
  }

  if (oldContent) {
    try {
      const all = JSON.parse(oldContent);
      for (const [catId, content] of Object.entries(all)) {
        await putDiscoverData(`content_${catId}`, content);
      }
    } catch { /* ignore */ }
    localStorage.removeItem('obc_discover_content');
  }
}
migrateFromLocalStorage();

// ★ 以下全部改为 IndexedDB + 内存缓存

async function getCategories() {
  if (_cache.categories) return _cache.categories;
  const saved = await getDiscoverData('categories');
  _cache.categories = saved || DEFAULT_CATEGORIES;
  return _cache.categories;
}

async function saveCategories(cats) {
  _cache.categories = cats;
  await putDiscoverData('categories', cats);
}

async function getPinnedBooks() {
  if (_cache.pinned) return _cache.pinned;
  const saved = await getDiscoverData('pinned');
  _cache.pinned = saved || [];
  return _cache.pinned;
}

async function savePinnedBooks(books) {
  _cache.pinned = books;
  await putDiscoverData('pinned', books);
}

async function getContent(categoryId) {
  const cacheKey = `content_${categoryId}`;
  if (_cache[cacheKey]) return _cache[cacheKey];
  const saved = await getDiscoverData(cacheKey);
  _cache[cacheKey] = saved;
  return saved;
}

async function saveContent(categoryId, data) {
  _cache[`content_${categoryId}`] = data;
  await putDiscoverData(`content_${categoryId}`, data);
}

// ★ 新增辅助函数：从 books 按 ID 数组批量读取书
async function getBooksByIds(ids) {
  if (!ids || ids.length === 0) return [];
  const results = [];
  for (const id of ids) {
    const book = await getBook(id);  // 从 store.js 导入
    if (book) results.push(book);
  }
  return results;
}


// ============================================================
//  渲染
// ============================================================

export function render(/* state */) {
  return `
    <div class="obc-discover">
      <div class="obc-category-bar" id="obcCategoryBar"></div>
      <div class="obc-discover-content" id="obcDiscoverContent">
        <div style="padding:40px 0;text-align:center;color:#999;font-size:14px;">
          选择一个类别，点击「AI 生成」创建内容
        </div>
      </div>
    </div>
  `;
}

// ============================================================
//  事件绑定
// ============================================================

export async function bindEvents(container, state) {
  // ★ 确保 discoverState 存在
  if (!state.discoverState) state.discoverState = { categoryId: 'all', scrollTop: 0 };
  renderCategoryBar(container, state);
  const cats = await getCategories();

  // ★ 从保存的状态恢复分类
  const savedCategoryId = state.discoverState?.categoryId;
  const defaultCat = savedCategoryId || (cats.length > 1 ? cats[1].id : 'all');
  await switchCategory(container, state, defaultCat);

  // ★ 恢复滚动位置
  const savedScrollTop = state.discoverState?.scrollTop || 0;
  if (savedScrollTop > 0) {
    requestAnimationFrame(() => {
      const scrollEl = container.querySelector('#obcDiscoverContent') || container;
      scrollEl.scrollTop = savedScrollTop;
    });
  }
}

async function renderCategoryBar(container, state) {
  const bar = container.querySelector('#obcCategoryBar');
  const cats = await getCategories();
  const activeCat = bar.dataset.activeCategory || 'all';

  bar.innerHTML = cats.map(c => `
    <button class="obc-cat-btn ${c.id === activeCat ? 'obc-cat-active' : ''}"
            data-cat-id="${c.id}">${c.name}</button>
  `).join('') + `
    <button class="obc-cat-add-btn" id="obcAddCatBtn">＋</button>
  `;

  bar.querySelectorAll('.obc-cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const catId = btn.dataset.catId;
      switchCategory(container, state, catId);
    });
  });

  bar.querySelector('#obcAddCatBtn').addEventListener('click', async () => {
    const name = await showPrompt('请输入新类别名称');
    if (!name) return;
    const cats = await getCategories();
    const id = 'cat_' + Date.now().toString(36);
    cats.push({ id, name });
    await saveCategories(cats);
    renderCategoryBar(container, state);
    switchCategory(container, state, id);
  });
}

async function switchCategory(container, state, catId) {
  const bar = container.querySelector('#obcCategoryBar');
  bar.dataset.activeCategory = catId;

  bar.querySelectorAll('.obc-cat-btn').forEach(btn => {
    btn.classList.toggle('obc-cat-active', btn.dataset.catId === catId);
  });

  // ★ 保存当前分类到 state
  if (state.discoverState) {
    state.discoverState.categoryId = catId;
  }

  const contentEl = container.querySelector('#obcDiscoverContent');
  const cats = await getCategories();
  const cat = cats.find(c => c.id === catId);
  const catName = cat ? cat.name : '全部';

  const existing = await getContent(catId);

  if (catId === 'all') {
    await renderAllContent(contentEl, state, catName);
    return;
  }

  if (existing) {
    await renderCategoryContent(contentEl, state, catName, catId, existing, container);
  } else {
    contentEl.innerHTML = `
      <div style="text-align:center;padding:60px 20px;">
        <div style="font-size:40px;margin-bottom:12px;">📭</div>
        <div style="color:#999;font-size:14px;margin-bottom:16px;">
          「${catName}」类别还没有内容
        </div>
        <button class="obc-btn obc-btn-primary" id="obcGenDiscoverBtn">🤖 AI 生成内容</button>
      </div>
    `;
    contentEl.querySelector('#obcGenDiscoverBtn').addEventListener('click', () => {
      generateDiscoverContent(container, state, catId, catName);
    });
  }
}

// ---- "全部"类别的聚合渲染 ----
async function renderAllContent(contentEl, state, catName) {
  const cats = (await getCategories()).filter(c => c.id !== 'all');

  // ★ 统一转为 ID 字符串
  let allGolden = [...(await getPinnedBooks())];
  allGolden = allGolden.map(item => typeof item === 'string' ? item : item.id);
  let allNewWorkIds = [];
  let allCardIds = [];

  for (const c of cats) {
    const data = await getContent(c.id);
    if (data) {
      if (data.newWorks) {
        allNewWorkIds = allNewWorkIds.concat(
          data.newWorks.map(n => typeof n === 'string' ? n : n.id)
        );
      }
      if (data.cards) {
        allCardIds = allCardIds.concat(
          data.cards.map(c => typeof c === 'string' ? c : c.id)
        );
      }
    }
  }

  if (allGolden.length === 0 && allNewWorkIds.length === 0 && allCardIds.length === 0) {
    contentEl.innerHTML = `
      <div style="text-align:center;padding:60px 20px;">
        <div style="font-size:40px;margin-bottom:12px;">📭</div>
        <div style="color:#999;font-size:14px;">还没有内容，请先在各个类别中生成</div>
      </div>
    `;
    return;
  }

  contentEl.innerHTML = `
  ${allGolden.length > 0 ? await renderGoldenSection(allGolden, state) : ''}
  ${allNewWorkIds.length > 0 ? await renderNewWorksSection(allNewWorkIds, state, catName) : ''}
  ${allCardIds.length > 0 ? await renderCardSection(allCardIds, state, catName) : ''}
`;
  bindContentEvents(contentEl, state, 'all');
}

// ---- 单个类别的渲染 ----
async function renderCategoryContent(contentEl, state, catName, catId, data, container) {
  const pinned = await getPinnedBooks();

  // ★ 统一转为 ID 字符串，兼容新旧格式
  const pinnedIds = pinned.map(p => typeof p === 'string' ? p : p.id);
  const goldenIds = (data.golden || []).map(g => typeof g === 'string' ? g : g.id);
  const newWorkIds = (data.newWorks || []).map(n => typeof n === 'string' ? n : n.id);
  const cardIds = (data.cards || []).map(c => typeof c === 'string' ? c : c.id);

  contentEl.innerHTML = `
    ${await renderGoldenSection([...pinnedIds, ...goldenIds], state, catId)}
    ${newWorkIds.length > 0 ? await renderNewWorksSection(newWorkIds, state, catName) : ''}
    ${cardIds.length > 0 ? await renderCardSection(cardIds, state, catName) : ''}
    <div style="text-align:center;margin-top:20px;padding-bottom:20px;">
      <button class="obc-btn obc-btn-secondary" id="obcRegenDiscoverBtn">🔄 重新生成</button>
    </div>
  `;

  bindContentEvents(contentEl, state, catId);

  contentEl.querySelector('#obcRegenDiscoverBtn')?.addEventListener('click', () => {
    generateDiscoverContent(container, state, catId, catName);
    switchCategory(contentEl.closest('.obc-discover')?.parentElement || document, state, catId);
  });
}

// ---- 金榜推荐区域 ----
async function renderGoldenSection(bookIds, state, catId) {
  const books = await getBooksByIds(bookIds);
  // ★ 按分类过滤金榜书（'all' 显示全部）
  const filtered = catId === 'all' ? books : books.filter(b => b.categoryId === catId);
  const displayBooks = filtered.slice(0, 10);
  return `
    <div class="obc-golden-section">
      <div class="obc-section-header">
        <span class="obc-section-label">👑 金榜推荐</span>
        <button class="obc-section-action obc-manage-golden-btn">管理</button>
      </div>
      <div class="obc-golden-scroll" id="obcGoldenScroll">
        ${displayBooks.length === 0 ? '<div style="color:#bbb;font-size:13px;padding:20px;">暂无推荐</div>' : ''}
        ${displayBooks.map(b => `
          <div class="obc-golden-card" data-book-id="${b.id || ''}">
            <div class="obc-golden-cover" style="background:#ccc;"></div>
            <div class="obc-golden-highlight">${(b.highlight || '精彩作品').slice(0, 12)}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

// ---- 新作展示区域 ----
async function renderNewWorksSection(newWorkIds, state, catName) {
  const books = await getBooksByIds(newWorkIds);
  const items = books.slice(0, 10);
  while (items.length < 10) items.push(null);
  return `
    <div class="obc-new-works-section">
      <div class="obc-section-header">
        <span class="obc-section-label">✨ 新作展示</span>
      </div>
      <div class="obc-new-works-grid">
        ${items.map(item => item ? `
          <div class="obc-new-work-item" data-book-id="${item.id || ''}">${item.title || item}</div>
        ` : `<div class="obc-new-work-item obc-new-work-empty"></div>`).join('')}
      </div>
    </div>
  `;
}

// ---- 卡片式单本展示 ----
async function renderCardSection(cardIds, state, catName) {
  const cards = await getBooksByIds(cardIds);
  return `
    <div class="obc-card-section">
      <div class="obc-section-header">
        <span class="obc-section-label">📚 作品列表</span>
      </div>
      <div class="obc-card-grid" id="obcCardGrid">
        ${cards.map(c => `
          <div class="obc-discover-card" data-book-id="${c.id || ''}">
            <div class="obc-card-top">
              <div class="obc-card-cover" style="background:#bbb;"></div>
              <div class="obc-card-info">
                <div class="obc-card-title">${c.title || '未命名'}</div>
                <div class="obc-card-author">${c.author || '佚名'}</div>
              </div>
            </div>
            <div class="obc-card-summary">${(c.synopsis || '暂无简介').slice(0, 60)}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

// ---- 绑定内容区事件 ----
function bindContentEvents(contentEl, state, catId) {
  contentEl.querySelector('.obc-manage-golden-btn')?.addEventListener('click', async () => {
    const pinned = await getPinnedBooks();
    if (pinned.length === 0) {
      alert('暂无金榜书目。在 AI 生成后，可点击卡片标记为金榜。');
      return;
    }
    const list = pinned.map((b, i) => `${i + 1}. ${b.title}${b.highlight ? ' - ' + b.highlight : ''}`).join('\n');
    const choice = await showPrompt(`当前金榜书目：\n${list}\n\n输入序号删除（留空取消）`);
    if (choice !== null) {
      const idx = parseInt(choice) - 1;
      if (idx >= 0 && idx < pinned.length) {
        pinned.splice(idx, 1);
        await savePinnedBooks(pinned);
        location.reload();
      }
    }
  });

  contentEl.querySelectorAll('.obc-golden-card').forEach(card => {
    card.addEventListener('dblclick', async () => {
      const bookId = card.dataset.bookId;
      if (!bookId) return;
      const pinned = await getPinnedBooks();
      const idx = pinned.findIndex(b => b.id === bookId);
      if (idx >= 0) {
        pinned.splice(idx, 1);
        await savePinnedBooks(pinned);
        card.style.border = 'none';
      } else {
        alert('已标记为金榜展示（功能完善中）');
      }
    });

    card.addEventListener('click', () => {
      const bookId = card.dataset.bookId;
      if (bookId) {
        state.navigateTo('detail', { bookId });
      }
    });
  });

  contentEl.querySelectorAll('.obc-new-work-item[data-book-id]').forEach(item => {
    item.addEventListener('click', () => {
      const bookId = item.dataset.bookId;
      if (bookId) {
        state.navigateTo('detail', { bookId });
      }
    });
  });

  contentEl.querySelectorAll('.obc-discover-card').forEach(card => {
    card.addEventListener('click', () => {
      const bookId = card.dataset.bookId;
      if (bookId) {
        state.navigateTo('detail', { bookId });
      }
    });
  });
}

// ============================================================
//  AI 生成内容
// ============================================================

// ★ 在 generateDiscoverContent 里，AI 返回后改为：
// 1. 每本书存到 books 仓库，status: 'discover'
// 2. discover 仓库只存 ID 数组

async function generateDiscoverContent(container, state, catId, catName) {
  const cats = await getCategories();
  const cat = cats.find(c => c.id === catId);
  const name = cat ? cat.name : catName;

  if (!container) return;

  const contentEl = container.querySelector('#obcDiscoverContent');

  contentEl.innerHTML = `
    <div style="text-align:center;padding:60px 20px;">
      <div style="font-size:32px;margin-bottom:12px;">⏳</div>
      <div style="color:#888;font-size:14px;">正在为「${name}」生成内容...</div>
    </div>
  `;

  try {
    const { callAIWithMessages } = await import('../../aiService.js');
    const systemPrompt = `你是一个小说推荐助手。根据类别"${name}"，生成一批小说推荐内容。

请严格按以下 JSON 格式返回，不要加其他文字：
{
  "golden": [
    { "title": "书名", "author": "作者名", "highlight": "用逗号分隔的标签，如：'现代魔法,魔法与科学,热血战斗'" }
  ],
  "newWorks": [
    { "title": "书名" }
  ],
  "cards": [
    { "title": "书名", "author": "作者名", "highlight": "用逗号分隔的标签，如：'现代魔法,魔法与科学,热血战斗'", "summary": "内容简介（20-50字）" }
  ]
}

要求：
- golden 数组：3~5本
- newWorks 数组：10本（只给书名）
- cards 数组：6~10本
- 所有书名、作者、看点、简介需贴合"${name}"类别`;

    const result = await taskManager.watch('story', `生成「${name}」推荐内容`, async () => {
      return callAIWithMessages({
        systemPrompt,
        userContent: `请为「${name}」类别生成推荐内容`,
        maxTokens: 4096,
        temperature: 0.8
      });
    });

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('AI 返回格式错误');
    const data = JSON.parse(jsonMatch[0]);

    const bookIds = { golden: [], newWorks: [], cards: [] };

    // 保存金榜书
    for (const item of (data.golden || [])) {
      const id = genId('book');
      const book = {
        id,
        title: item.title,
        author: item.author || '佚名',
        cover: '📖',
        synopsis: item.highlight || '',
        tags: [name],
        status: 'discover',
        categoryId: catId,
        chapters: [],
        wordCount: 0,
        highlight: item.highlight || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await putBook(book);
      bookIds.golden.push(id);
    }

    // 保存新作书
    for (const item of (data.newWorks || [])) {
      const id = genId('book');
      const book = {
        id,
        title: item.title,
        author: '佚名',
        cover: '📖',
        synopsis: '',
        tags: [name],
        status: 'discover',
        categoryId: catId,
        chapters: [],
        wordCount: 0,
        highlight: item.title || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await putBook(book);
      bookIds.newWorks.push(id);
    }

    // 保存卡片书
    for (const item of (data.cards || [])) {
      const id = genId('book');
      const book = {
        id,
        title: item.title,
        author: item.author || '佚名',
        cover: '📖',
        synopsis: item.summary || '',
        tags: [name],
        status: 'discover',
        categoryId: catId,
        chapters: [],
        wordCount: 0,
        highlight: item.highlight || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await putBook(book);
      bookIds.cards.push(id);
    }

    // saveContent 现在只存 ID 引用
    await saveContent(catId, bookIds);

    // 渲染（需要改为从 books 按 ID 读取数据）
    await renderCategoryContent(contentEl, state, catName, catId, bookIds, container);
    bindContentEvents(contentEl, state, catId);

  } catch (e) {
    contentEl.innerHTML = `
  <div style="text-align:center;padding:60px 20px;">
    <div style="font-size:40px;margin-bottom:12px;">❌</div>
    <div style="color:#e53935;font-size:14px;margin-bottom:16px;">生成失败：${e.message}</div>
    <button class="obc-btn obc-btn-secondary" id="obcRetryGenBtn">🔄 重试</button>
  </div>
`;

    contentEl.querySelector('#obcRetryGenBtn')?.addEventListener('click', () => {
      generateDiscoverContent(container, state, catId, catName);
    });
  }
}

// ★ 导出：供其他模块更新金榜缓存
export function addToPinnedCache(bookData) {
    if (_cache.pinned && !_cache.pinned.find(p => p.id === bookData.id)) {
        _cache.pinned.push(bookData);
    }
}

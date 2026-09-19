// apps/onlineBookCity/index.js — 线上书城主模块入口

const TABS = [
  { id: 'bookshelf', label: '📚 我的书架', file: 'bookshelf' },
  { id: 'discover', label: '🔍 发现', file: 'discover', disabled: false },
  { id: 'studio', label: '✍️ 创作中心', file: 'studio' },
  { id: 'settings', label: '⚙️ 设置', file: 'settings' }
];

// ---- 页面状态 ----
const state = {
  currentTab: 'bookshelf',
  navStack: [],
  params: {},          // { bookId, chapterId } 等
  navigateTo(tabId, params = {}) {
    const isSubPage = !TABS.find(t => t.id === tabId);
    if (isSubPage) {
      // ★ 把当前页面压入导航栈
      this.navStack.push({ tab: this.currentTab, params: { ...this.params } });
      // ★ 新增：记录发现页状态
      if (this.currentTab === 'discover') {
        const contentEl = document.querySelector('#obcDiscoverContent') || document.querySelector('.obc-content');
        this.discoverState = {
          categoryId: this.discoverState?.categoryId || 'all',
          scrollTop: contentEl?.scrollTop || 0
        };
      }
    }
    this.currentTab = tabId;
    this.params = params;
    const tab = TABS.find(t => t.id === tabId);
    if (tab) {
      this.navStack = [];   // ← 加这一行，切主 Tab 时清空导航栈
      this.params = {};
    }
    refresh();
  }

};

let _currentContainer = null;

// ---- 动态加载页面模块 ----
async function loadPage(tabId) {
  // 如果 tabId 不是直接 tab，看是不是 detail 或 reader
  const pageMap = {
    bookshelf: () => import('./pages/bookshelf.js'),
    discover: () => import('./pages/discover.js'),
    studio: () => import('./pages/studio.js'),
    settings: () => import('./pages/settings.js'),
    detail: () => import('./pages/detail.js'),
    reader: () => import('./pages/reader.js')
  };
  const loader = pageMap[tabId];
  if (!loader) {
    // fallback 到 bookshelf
    const fallback = await import('./pages/bookshelf.js');
    return fallback;
  }
  return loader();
}

// ---- 主渲染 ----
export function render() {
  return `
    <div class="obc-container">
      <div class="obc-tab-bar" id="obcTabBar">
        ${TABS.map(t => `
          <button class="obc-tab ${t.id === state.currentTab ? 'obc-tab-active' : ''} ${t.disabled ? 'obc-tab-disabled' : ''}"
                  data-tab="${t.id}" ${t.disabled ? 'disabled' : ''}>
            ${t.label}
          </button>
        `).join('')}
      </div>
      <div class="obc-content" id="obcContent">
        <div style="padding:20px;text-align:center;color:#999;">加载中...</div>
      </div>
    </div>
  `;
}

// ---- 事件绑定 ----
export async function bindEvents(container) {
  _currentContainer = container;

  // Tab 切换
  container.querySelectorAll('.obc-tab:not(.obc-tab-disabled)').forEach(btn => {
    btn.addEventListener('click', () => {
      state.currentTab = btn.dataset.tab;
      state.params = {};
      refresh();
    });
  });

  await refresh();
}

// ---- 刷新内容区域 ----
async function refresh() {
  const contentEl = _currentContainer?.querySelector('#obcContent');
  if (!contentEl) return;

  // ★ 子页面（详情/阅读器）隐藏底部 Tab 栏
  const tabBar = _currentContainer?.querySelector('#obcTabBar');
  if (tabBar) {
    const isSubPage = ['detail', 'reader'].includes(state.currentTab);
    tabBar.style.display = isSubPage ? 'none' : '';
  }

  // 激活的 tab 高亮
  if (_currentContainer) {
    _currentContainer.querySelectorAll('.obc-tab').forEach(t => {
      t.classList.toggle('obc-tab-active', t.dataset.tab === state.currentTab);
    });
  }

  try {
    const page = await loadPage(state.currentTab);
    contentEl.innerHTML = page.render(state);
    if (page.bindEvents) {
      await page.bindEvents(contentEl, state);
    }
  } catch (e) {
    console.error('书城页面加载失败:', e);
    contentEl.innerHTML = `<div style="padding:20px;color:#e53935;">页面加载失败：${e.message}</div>`;
  }
}

// ---- 返回处理 ----
export function handleBack(container) {
  if (['detail', 'reader', 'studio'].includes(state.currentTab)) {
    const prev = state.navStack.pop();
    if (prev) {
      state.currentTab = prev.tab;
      state.params = prev.params;
    } else {
      state.currentTab = 'bookshelf';
      state.params = {};
    }
    refresh();
    return true;
  }
  return false;
}

// ---- 注册模块 ----
if (!window.__moduleRegistry) window.__moduleRegistry = [];
window.__moduleRegistry.push({
  id: 'onlineBookCity',
  label: '线上书城',
  icon: '📚',
  color: '#8e24aa',
  render,
  bindEvents,
  handleBack
});

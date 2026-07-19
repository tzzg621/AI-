import { navItems } from './data.js';
import { importWithRetry } from './store/utils.js';


const elements = {
    clockDisplay: document.getElementById('clockDisplay'),
    dateDisplay: document.getElementById('dateDisplay'),
    mockStatusBar: document.getElementById('mockStatusBar'),  // ← 新增
    // avatarUploader: document.getElementById('avatarUploader'),
    // avatarImg: document.getElementById('avatarImg'),
    // ★ 修改：直接用 document.getElementById 获取，更清晰
    // placeholder: document.querySelector('#avatarUploader .placeholder'),
    creatorOverlay: document.getElementById('creatorOverlay'),
    pageContainer: document.getElementById('pageContainer'),
    bottomNav: document.getElementById('bottomNav'),
    statusBackBtn: document.getElementById('statusBackBtn')
};

const state = { stack: ['home'] };
const appMap = new Map((window.__moduleRegistry || []).map((mod) => [mod.id, mod]));

// const appMap = new Map((window.__moduleRegistry || []).map((mod) => [
//     mod.id,
//     {
//         // 保留模块注册的所有信息
//         ...mod,
//         // 缺失的字段补上默认值
//         render: mod.render || (() => '<p>待开发</p>'),
//         bindEvents: mod.bindEvents || (() => { }),
//         handleBack: mod.handleBack || (() => false),
//     }
// ]));

const STORAGE_KEY_MEMORIES = 'global_memories';

const memoryService = {
    addMemory(memory) {
        const list = this.getMemories();
        list.unshift(memory);
        localStorage.setItem(STORAGE_KEY_MEMORIES, JSON.stringify(list));
        if (getCurrentRoute() === 'memory') {
            render();
        }
    },
    getMemories() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY_MEMORIES);
            if (saved) return JSON.parse(saved);
        } catch (e) { /* 忽略 */ }
        // 首次使用：用 data.js 的默认值初始化
        const defaults = [...memories];
        localStorage.setItem(STORAGE_KEY_MEMORIES, JSON.stringify(defaults));
        return defaults;
    }
};

const globalState = {
    activeCharacter: null,     // 当前主视角角色
    activeCharacterId: -1,     // 对应的索引
};

// ---- 更新主视角角色的函数 ----
function setActiveCharacter(character, index) {
    globalState.activeCharacter = character;
    globalState.activeCharacterId = index;
}

function updateClock() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    elements.clockDisplay.textContent = `${hours}:${minutes}`;
    elements.dateDisplay.textContent = `${now.getMonth() + 1}月${now.getDate()}日`;
}

function navigateTo(route) {
    if (route === 'home') {
        state.stack = ['home'];
    } else if (state.stack[state.stack.length - 1] !== route) {
        state.stack.push(route);
    }
    render();
}

function goBack() {
    if (elements.creatorOverlay.classList.contains('show')) {
        elements.creatorOverlay.classList.remove('show');
        return;
    }

    // ★ 尝试调用模块的 handleBack 函数
    const handled = callModule(getCurrentRoute(), 'handleBack', elements.pageContainer, { memoryService, globalState });
    if (handled) return;

    if (state.stack.length > 1) {
        state.stack.pop();
        render();
    }
}

function getCurrentRoute() {
    return state.stack[state.stack.length - 1];
}

function renderHome() {
    const modules = window.__moduleRegistry || [];

    const bottomNavIds = ['settings', 'market', 'memory'];
    const displayModules = modules.filter(mod =>
        !bottomNavIds.includes(mod.id) && mod.id !== 'creatorSpace'
    );

    // ★ 问候语
    const now = new Date();
    const hour = now.getHours();
    let greeting;
    if (hour < 6) greeting = '夜深了';
    else if (hour < 9) greeting = '早上好';
    else if (hour < 12) greeting = '上午好';
    else if (hour < 14) greeting = '中午好';
    else if (hour < 18) greeting = '下午好';
    else greeting = '晚上好';

    const month = now.getMonth() + 1;
    const day = now.getDate();
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const weekday = weekdays[now.getDay()];
    const dateStr = `${month}月${day}日 周${weekday}`;

    // ★ 桌宠配置
    const currentTheme = localStorage.getItem('desk_theme') || 'warm';

    // ★ 同步当前主题到 <html> 元素（全页面所有组件都能感知）
    document.documentElement.setAttribute('data-theme', currentTheme);

    return `
<div class="home-screen theme-${currentTheme}">
        <div class="home-greeting">
            <div class="greeting-text">${greeting} 👋</div>
            <div class="greeting-date">${dateStr}</div>
        </div>
        <div class="desk-pet-module">
            <div class="pet-area" id="petArea">
                <!-- SVG 桌宠由 DeskPet.js 渲染 -->
                <div class="pet-platform"></div>
            </div>
        </div>            
            <div class="home-subtitle">选择一个功能进入</div>
            <div class="home-grid">
                ${displayModules.map((app) => `
                    <button class="app-card" data-route="${app.id}">
                        <div class="icon-box" style="background:${app.color};">${app.icon}</div>
                        <div class="label">${app.label}</div>
                    </button>
                `).join('')}
            </div>
        </div>
    `;
}

function render() {
    const route = getCurrentRoute();
    elements.statusBackBtn.style.visibility = route === 'home' ? 'hidden' : 'visible';
    elements.statusBackBtn.style.display = 'inline-flex';  // 始终占位
    elements.creatorOverlay.classList.remove('show');

    // ★ 读取全局设置，控制状态栏显示
    const showStatusBar = localStorage.getItem('global_show_status_bar') !== 'false';
    elements.mockStatusBar.classList.toggle('hidden', !showStatusBar);

    if (route === 'home') {
        elements.pageContainer.innerHTML = renderHome();
        elements.pageContainer.dataset.homeBound = 'false';
        // ★ 首页放开溢出限制（让桌宠能跳）
        elements.pageContainer.style.overflow = 'visible';
        renderBottomNav();
        bindHomeEvents();
        // ★ 通知 DeskPet 重新渲染
        window.dispatchEvent(new CustomEvent('desk-rendered'));
        return;
    }
    // ★ 非首页恢复 overflow hidden（保证其他页面内容正常）
    elements.pageContainer.style.overflow = 'hidden';

    // ★ 不再单独处理 settings/market/memory，统一走模块调用
    const renderResult = callModule(route, 'render', { memoryService, globalState });
    if (renderResult) {
        elements.pageContainer.innerHTML = renderResult;
        callModule(route, 'bindEvents', elements.pageContainer, { memoryService, globalState });
    } else {
        elements.pageContainer.innerHTML = `...内容暂未准备好...`;
    }

    elements.bottomNav.classList.add('hidden');
}

function renderBottomNav() {
    elements.bottomNav.innerHTML = navItems.map((item) => `
        <button class="nav-item" data-route="${item.id}">
            <span class="nav-icon">${item.icon}</span>${item.label}
        </button>
    `).join('');
    elements.bottomNav.classList.toggle('hidden', getCurrentRoute() !== 'home');
}

function bindHomeEvents() {
    // ★ 如果已绑定，跳过
    if (elements.pageContainer.dataset.homeBound === 'true') return;
    elements.pageContainer.dataset.homeBound = 'true';

    elements.pageContainer.querySelectorAll('.app-card[data-route]').forEach((button) => {
        button.addEventListener('click', () => navigateTo(button.dataset.route));
    });

}

function bindAppEvents(route) {
    const module = appMap.get(route);
    if (module && typeof module.bindEvents === 'function') {
        module.bindEvents(elements.pageContainer, { memoryService, globalState });
    }
}

function attachEvents() {

    const goldenCord = document.getElementById('goldenCord');

    goldenCord.addEventListener('click', async () => {
        goldenCord.classList.add('pulled');
        setTimeout(() => goldenCord.classList.remove('pulled'), 500);

        // ★ 导航到缔造者空间页面
        navigateTo('creatorSpace');
    });

    // 下滑手势
    let touchStartY = 0;
    goldenCord.addEventListener('touchstart', (e) => {
        touchStartY = e.touches[0].clientY;
    }, { passive: true });




    elements.statusBackBtn.addEventListener('click', goBack);

    document.addEventListener('click', (event) => {
        const backButton = event.target.closest('[data-action="back"]');
        if (backButton) {
            goBack();
            return;
        }

        const navItem = event.target.closest('.bottom-nav .nav-item');
        if (navItem) {
            navigateTo(navItem.dataset.route);
        }

    });

    // ★ 监听 chatUI 组件发出的事件
    window.addEventListener('chat-clear', (e) => {
        const { otherId } = e.detail;
        // 清空对话逻辑，由 chat.js 的 handleBack 或外部函数处理
        console.log('清空对话:', otherId);
    });

    window.addEventListener('chat-view-memories', (e) => {
        const { charId, charName } = e.detail;
        // 跳转到记忆簿页面
        console.log('查看记忆:', charName);
    });

    window.addEventListener('chat-extension', (e) => {
        const { ext, pairKey, otherId } = e.detail;
        console.log('扩展功能:', ext);
    });

}

// ★ 通用调用函数：调用模块的某个功能，没有就返回 null
function callModule(route, fnName, ...args) {
    // 先查缓存
    let mod = appMap.get(route);

    // 没找到 → 查实时注册表（动态加载的模块）
    if (!mod) {
        mod = (window.__moduleRegistry || []).find(m => m.id === route);
        if (mod) appMap.set(route, mod); // 加入缓存
    }

    if (!mod) return null;
    const fn = mod[fnName];
    if (typeof fn === 'function') return fn(...args);
    return null;
}

function init() {
    // ★ 初始化时同步已保存的主题
    const savedTheme = localStorage.getItem('desk_theme') || 'warm';
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateClock();
    setInterval(updateClock, 1000);
    attachEvents();

    // ★ 遍历注册表，执行所有标记了 bootInit 的 init 函数
    (window.__moduleRegistry || []).forEach(mod => {
        if (mod.init && mod.bootInit) {
            try {
                mod.init(globalState);
            } catch (e) {
                console.warn(`模块 ${mod.id} 初始化失败：`, e);
            }
        }
    });

    // ★ 监听主题变更
    window.addEventListener('theme-changed', () => {
        if (getCurrentRoute() === 'home') {
            render();
        }
    });

    // init() 函数中
    const showPhoneFrame = localStorage.getItem('global_show_phone_frame') !== 'false';
    if (!showPhoneFrame) {
        const wrapper = document.querySelector('.phone-wrapper');
        if (wrapper) {
            wrapper.style.background = 'transparent';
            wrapper.style.padding = '0';
            wrapper.style.borderRadius = '0';
            wrapper.style.boxShadow = 'none';
            const screen = wrapper.querySelector('.phone-screen');
            if (screen) screen.style.borderRadius = '0';
        }
    }



    render();
}

// ★ 注册缔造者空间模块
importWithRetry('./creator-space/crystal.js').then(mod => {
    if (!window.__moduleRegistry) window.__moduleRegistry = [];
    window.__moduleRegistry.push({
        id: mod.id,
        label: mod.label,
        icon: mod.icon,
        color: mod.color,
        render: mod.render,
        bindEvents: mod.bindEvents,
        handleBack: mod.handleBack
    });
});


init();



// creator-space/crystal.js — 缔造者空间（Aoi 的家）

import { setAgent, render as renderChat, bindEvents as bindChatEvents, resetDisplayLimit } from './chat-window.js';

// ★ 模块级变量，用于清理
let _clockInterval = null;


export const id = 'creatorSpace';
export const label = '缔造者空间';
export const icon = '✨';
export const color = '#5b6abf';

export function render() {
    const chatHtml = renderChat();

    const hour = new Date().getHours();
    let timeGreeting = '下午好';
    if (hour < 6) timeGreeting = '夜深了';
    else if (hour < 9) timeGreeting = '早上好';
    else if (hour < 12) timeGreeting = '上午好';
    else if (hour < 18) timeGreeting = '下午好';
    else timeGreeting = '晚上好';

    return `
        <div class="creator-room">
            <!-- 房间顶部：房间名 + 退出门 -->
            <div class="room-top-bar">
                <span class="room-name">🚪 我的房间</span>
                <button class="room-exit-btn" id="roomExitBtn" title="走出房间">🚪</button>
            </div>

            <!-- 房间主体 -->
            <div class="room-main">
                <!-- 房间氛围 -->
                <div class="room-atmosphere">
                    <div class="room-window">
                        <span id="roomWindowScene">${getWindowScene()}</span>
                    </div>
                    <div class="room-clock" id="roomClock">${getClockTime()}</div>
                    <div class="room-greeting">${timeGreeting}，缔造者。</div>
                </div>

                <!-- 设置区 -->
                <div class="page-card creator-card-flat">
                    <div class="creator-padded" id="settingsSlot"></div>
                </div>

                <!-- Aoi 入口 -->
                <button class="aoi-fab" id="aoiFab">💠</button>

                <!-- 聊天窗口 -->
                ${chatHtml}
            </div>
        </div>
    `;
}

function getWindowScene() {
    const hour = new Date().getHours();
    if (hour < 6 || hour >= 19) return '🌙 夜晚';
    if (hour < 12) return '☀️ 上午';
    return '🌤️ 下午';
}

function getClockTime() {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

export function bindEvents(container) {
    // ★ 隐藏外部的 topBar（返回按钮栏）
    const topBar = document.getElementById('topBar');
    if (topBar) topBar.style.display = 'none';

    // ★ 退出房间按钮
    const exitBtn = container.querySelector('#roomExitBtn');
    exitBtn?.addEventListener('click', () => {
        if (topBar) topBar.style.display = '';
        // 触发返回（app.js 的 goBack 会处理）
        const backBtn = document.getElementById('statusBackBtn');
        if (backBtn) backBtn.click();
    });

    // ★ 时钟更新
    const clockEl = container.querySelector('#roomClock');
    if (clockEl) {
        // ★ 清除旧定时器（防止多次进入累积）
        if (_clockInterval) clearInterval(_clockInterval);

        _clockInterval = setInterval(() => {
            const now = new Date();
            clockEl.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        }, 10000);
    }

    // ★ 设置插槽（不变）
    const slot = container.querySelector('#settingsSlot');
    if (slot) {
        import('../store/Aoi/aoi-api.js').then(aoiApi => {
            const panel = aoiApi.renderSlot();
            slot.innerHTML = panel.html;
            panel.bind(slot);
        }).catch(() => { });
    }

    // ★ 聊天窗口控制（不变）
    const fab = container.querySelector('#aoiFab');
    const chatWindow = container.querySelector('#chatWindow');
    let agentReady = false;

    import('../store/Aoi/aoi.js').then(({ Aoi }) => {
        const aoi = new Aoi();
        setAgent({
            name: 'Aoi',
            avatar: '💠',
            chat: (text) => aoi.chat(text),
            bootstrap: () => aoi.bootstrap(),
            get ready() { return aoi._ready; }
        });
    });

    fab?.addEventListener('click', () => {
        resetDisplayLimit();  // ★ 每次打开重置为 20 条
        chatWindow.style.display = 'flex';
        fab.style.display = 'none';
        setTimeout(() => {
            const msgEl = container.querySelector('#chatMessages');
            if (msgEl) msgEl.scrollTop = msgEl.scrollHeight;
        }, 50);
        setTimeout(() => container.querySelector('#chatInput')?.focus(), 100);
    });

    bindChatEvents(container, {
        onClose: () => {
            chatWindow.style.display = 'none';
            fab.style.display = 'flex';
        }
    });
}

export function handleBack() {
    // ★ 清除时钟定时器
    if (_clockInterval) {
        clearInterval(_clockInterval);
        _clockInterval = null;
    }

    // ★ 恢复 topBar
    const topBar = document.getElementById('topBar');
    if (topBar) topBar.style.display = '';
    return false;
}

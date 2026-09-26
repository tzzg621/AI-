// creator-space/crystal.js — 缔造者空间（Aoi 的家）

import { setAgent, render as renderChat, bindEvents as bindChatEvents, resetDisplayLimit } from './chat-window.js';
import { importWithRetry } from '../store/utils.js';

// ★ 模块级变量，用于清理
let _clockInterval = null;

/**
 * 操作台浮层的**唯一**开合入口。
 * 状态只住在 DOM 类（.room-terminal.open / .creator-room.room-terminal-open）里，
 * 模块不另存一份 —— 离开房间时 render() 重建 pageContainer.innerHTML，
 * 状态自然归零，所以 handleBack() 不需要为浮层加任何清理。
 */
function setTerminalOpen(open) {
    const room = document.querySelector('.creator-room');
    if (!room) return;
    const terminal = room.querySelector('#roomTerminal');
    const pcBtn = room.querySelector('#roomPc');
    terminal?.classList.toggle('open', open);
    room.classList.toggle('room-terminal-open', open);
    pcBtn?.setAttribute('aria-expanded', open ? 'true' : 'false');
    pcBtn?.setAttribute('aria-label', open ? '收起操作台' : '打开操作台');
}

/**
 * Aoi 设置浮层此刻是否开着。
 * 房间**只读**它的显隐结果（用来收操作台、给 FAB 让位），不碰它的状态 ——
 * aoi-api.js 按约定不联动，显隐仍由它自己的 bind() 管。
 */
function isAoiFloatOpen(container) {
    const body = container.querySelector('#aoiApiBody');
    return !!body && getComputedStyle(body).display !== 'none';
}

/** 房间拿到的 Aoi 实例（模块作用域缓存，就是 aoi.js 自己那个单例）。只读它的公开字段。 */
let _aoiInstance = null;

/**
 * Aoi 此刻在不在缔造者空间。判据与桌面那边桥接**同一句**
 * （store/desktop/DesktopInteraction.js 的 aoi-runtime-changed 处理）：
 * scene === 'pond' 且没到 until 就算「在外面」。
 *
 * 取值**优先问实例**（`aoi.runtime` 是真值，桌面那边读的也是它），实例还没生出来
 * 才退回落 `localStorage['aoi_runtime']`：aoi.js 的构造函数就是从那个键把值读进实例的
 * （`aoi.js:20-23`），`setRuntime` 也是两个一起写（`47/49`）⇒ 这是**同一个值的两条取路**，
 * 不是两份状态。退路的价值是**同步可得** —— 进房间那一帧实例往往还没到（要 import +
 * bootstrap），走退路才不会出现「门口灯先亮一下再熄」。两条路还互为备份：将来 Aoi 侧
 * 谁改了名，`?.` / `??` 会让它自动落到另一条上（不会崩，最坏是暂时退回旧读法）。
 */
function isAoiAway() {
    const rt = _aoiInstance?.runtime ?? readStoredRuntime();
    return rt.scene === 'pond' && (!rt.until || Date.now() < rt.until);
}

function readStoredRuntime() {
    try { return JSON.parse(localStorage.getItem('aoi_runtime') || '{}'); } catch { return {}; }
}

/**
 * Aoi 不在家 → 房间收起 💠 门。它不在，门口就不该亮着灯。
 *
 * **自查，不挂全局监听** —— 会写 Aoi 去向的地方全项目只有三处（DesktopInteraction
 * 的 442 / 522 / 740 行），其中只有 740 那条够得到房间里来：它由 aoi.js 的
 * `decide_fishing` 工具调用，而那个工具只在 `aoi.chat()` 的工具循环里跑，
 * 也就是下面交给 setAgent 的那个闭包。于是三个时机就够覆盖全部：
 *   ① 进房间时对一次；
 *   ② 每轮对话收尾对一次（它去钓鱼了 → 门口的灯当轮就熄）；
 *   ③ 10s 时钟兜一次 —— `until` 到期**没有任何代码写它**（判据自然失效、
 *      不会有事件），这条只归时钟管。
 * 因此也不必假设 aoi.js 会发 `aoi-runtime-changed`（桌面那边的桥接仍用它，各走各的）。
 * 代价写在这里：将来若有别的模块在房间开着的时候改它，门口灯最晚 10 秒才熄 ——
 * 时钟会兜回来，不会停在错的状态。
 */
function syncAoiPresence() {
    const room = document.querySelector('.creator-room');
    if (room) room.classList.toggle('room-aoi-away', isAoiAway());
}

/**
 * 点浮层外面收起操作台。监听挂在 `.creator-room` **自己**身上，不是 `document`：
 * 房间铺满整个手机屏（rect 实测就是整屏），落在房间外的点击本来就打不着东西；
 * 而挂房间节点上会随重渲染自然重绑、随节点销毁自然回收 —— 不需要「只绑一次」的闸，
 * 也不占全应用每次点击。唯一够不着的是顶部那条被金色拉绳压住的窄条，
 * 但点那儿会重新导航进房间、整棵重渲染，浮层照样收。
 */
function bindDismiss(container) {
    const room = container.querySelector('.creator-room');
    room?.addEventListener('click', (event) => {
        const terminalEl = room.querySelector('.room-terminal.open');
        if (!terminalEl) return;
        if (room.querySelector('#roomPc')?.contains(event.target)) return;
        if (terminalEl.contains(event.target)) return;
        setTerminalOpen(false);
    }, { passive: true });
}


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

                <!-- 桌面场景：一张桌子，桌上一台电脑（可点，通往操作台） -->
                <div class="room-desk-scene">
                    <div class="room-pc-wrap">
                        <!-- 操作台浮层：往上弹，挂在电脑上沿（内容先占位） -->
                        <div class="room-terminal" id="roomTerminal">
                            <div class="room-terminal-head">
                                <span class="room-terminal-title">🖥️ 操作台</span>
                                <button class="room-terminal-close" id="roomTerminalClose"
                                    title="收起操作台" aria-label="收起操作台">✕</button>
                            </div>
                            <div class="room-terminal-body">
                                <p class="room-terminal-note">屏上还空着——以后与缔造者有关的事，都从这台电脑进。</p>
                            </div>
                        </div>

                        <button class="room-pc" id="roomPc" aria-expanded="false" aria-label="打开操作台">
                            <span class="room-pc-screen"></span>
                            <span class="room-pc-neck"></span>
                            <span class="room-pc-base"></span>
                        </button>
                    </div>

                    <div class="room-desk"></div>
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
            // Aoi 的 until 到期没有任何代码写它（判据自然失效，不会有事件），
            // 这条时钟就是它的唯一归宿 —— 借已经在跳的它顺手对一次，不新增定时器。
            syncAoiPresence();
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

    // ★ 桌面场景：电脑 ↔ 操作台浮层
    bindDismiss(container);
    syncAoiPresence();   // 进房间先对一次 Aoi 在不在家

    container.querySelector('#roomPc')?.addEventListener('click', () => {
        // 互斥：先收掉设置浮层，再开自己。**顺序不能反** ——
        // 收设置浮层走它自己的 click（显隐/箭头只有一个真源），
        // 而那次 click 会冒泡到下面 #settingsSlot 的委托监听里把操作台关掉。
        if (isAoiFloatOpen(container)) container.querySelector('#aoiApiToggle')?.click();
        setTerminalOpen(!container.querySelector('#roomTerminal')?.classList.contains('open'));
    });

    container.querySelector('#roomTerminalClose')
        ?.addEventListener('click', () => setTerminalOpen(false));

    // 点设置区 = 收掉操作台，并顺手同步 FAB 的淡出态。
    // 委托挂在 #settingsSlot（房间自己的元素）上：不依赖 aoi 的 id 就能拿到这次点击。
    // 读 #aoiApiBody 只为给 FAB 让位 —— aoi 自己的处理器挂在内层元素上、先跑，
    // 所以这里同步读到的就是这次点击之后的结果。
    slot?.addEventListener('click', () => {
        setTerminalOpen(false);
        container.querySelector('.creator-room')
            ?.classList.toggle('room-aoi-float', isAoiFloatOpen(container));
    });

    // ★ 聊天窗口控制（不变）
    const fab = container.querySelector('#aoiFab');
    const chatWindow = container.querySelector('#chatWindow');
    let agentReady = false;

    importWithRetry(() => import('../store/Aoi/aoi.js')).then(({ getAoiInstance }) => {
        getAoiInstance().then(aoi => {
            _aoiInstance = aoi;     // 真值到手：此后判据都问它（见 isAoiAway）
            syncAoiPresence();      // 校准一次（通常与退路同值；两条路分叉时以它为准）
            setAgent({
                name: 'Aoi',
                avatar: '💠',
                // 房间自查 Aoi 去向的那条缝（见 syncAoiPresence 的注释）：
                // 它决定去钓鱼就发生在这一轮 chat 里，收尾对一次现状。
                chat: async (text) => {
                    try { return await aoi.chat(text); }
                    finally { syncAoiPresence(); }
                },
                bootstrap: () => aoi.bootstrap(),
                get ready() { return aoi._ready; }
            });
        });
    });

    fab?.addEventListener('click', () => {
        resetDisplayLimit();  // ★ 每次打开重置为 20 条
        setTerminalOpen(false);   // 聊天窗是全屏的，开着操作台没意义
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

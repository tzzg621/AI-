// apps/chat/chatUI.js — 聊天界面 UI 组件
// 独立于 chat.js，出问题不影响核心聊天功能

/**
 * 初始化聊天 UI 组件
 * @param {HTMLElement} container - 聊天详情页的容器
 * @param {object} context - 上下文数据
 * @param {object} context.globalState
 * @param {string} context.otherId
 * @param {string} context.activeId
 * @param {object} context.contact
 */
export function initChatUI(container, context) {
    // ★ 应用保存的字体大小
    const savedSize = localStorage.getItem('chat_font_size') || '14';
    applyChatFontSize(savedSize);

    // 点击头像弹出角色信息
    bindAvatarClick(container, context);

    // 右上角设置菜单
    bindSettingsMenu(container, context);

    // 输入框扩展键
    bindInputExtensions(container, context);
}

// ============================================================
//  1. 点击头像弹出角色信息
// ============================================================

function bindAvatarClick(container, context) {
    // 监听所有头像点击
    container.addEventListener('click', (e) => {
        const avatarEl = e.target.closest('.msg-avatar, .chat-avatar, .contact-avatar');
        if (!avatarEl) return;

        // 判断点击的是对方还是自己
        const isOther = avatarEl.closest('.msg-row.other');
        const charId = isOther ? context.otherId : context.activeId;
        const charName = isOther ? context.contact?.name : '我';

        showCharInfoPopover(charId, charName);
    });
}

function showCharInfoPopover(charId, charName) {
    // 移除旧的弹窗
    document.querySelector('.char-popover')?.remove();

    // 读取角色信息
    let charInfo = { name: charName, desc: '', emoji: '👤' };
    try {
        const roleData = localStorage.getItem('rolebook_characters');
        if (roleData) {
            const chars = JSON.parse(roleData);
            const found = chars.find(c => c.id === charId);
            if (found) {
                charInfo = {
                    name: found.base.name || charName,
                    desc: found.base.desc || '',
                    emoji: found.base.emoji || '👤',
                    style: found.base.style || '',
                    secret: found.base.secret || ''
                };
            }
        }
    } catch (e) { }

    const popover = document.createElement('div');
    popover.className = 'char-popover';
    popover.style.cssText = `
        position:fixed;top:0;left:0;right:0;bottom:0;z-index:250;
        background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;
    `;
    popover.innerHTML = `
        <div style="background:white;border-radius:20px;width:280px;overflow:hidden;">
            <div style="text-align:center;padding:24px 20px 16px;">
                <div style="font-size:48px;margin-bottom:8px;">${charInfo.emoji}</div>
                <div style="font-size:18px;font-weight:700;">${charInfo.name}</div>
                ${charInfo.desc ? `<div style="font-size:13px;color:#666;margin-top:6px;">${charInfo.desc}</div>` : ''}
            </div>
            ${charInfo.style ? `
                <div style="padding:0 20px 8px;">
                    <div style="font-size:12px;color:#999;">说话风格</div>
                    <div style="font-size:13px;color:#333;">${charInfo.style}</div>
                </div>
            ` : ''}
            ${charInfo.secret ? `
                <div style="padding:0 20px 16px;">
                    <div style="font-size:12px;color:#999;">内心秘密</div>
                    <div style="font-size:13px;color:#c62828;">${charInfo.secret}</div>
                </div>
            ` : ''}
            <div style="padding:12px 20px;border-top:1px solid #f0f0f0;">
                <button class="popover-close" style="
                    width:100%;padding:8px;border-radius:12px;border:none;
                    background:#f5f5f5;color:#666;cursor:pointer;font-size:13px;
                ">关闭</button>
            </div>
        </div>
    `;
    document.body.appendChild(popover);

    popover.addEventListener('click', (e) => {
        if (e.target === popover || e.target.classList.contains('popover-close')) {
            popover.remove();
        }
    });
}

// ============================================================
//  2. 右上角设置菜单
// ============================================================

function bindSettingsMenu(container, context) {
    // 在标题栏右侧加一个菜单按钮
    const header = container.querySelector('.chat-detail-header');
    if (!header) return;

    // 避免重复添加
    if (header.querySelector('.chat-settings-btn')) return;

    const btn = document.createElement('button');
    btn.className = 'chat-settings-btn';
    btn.textContent = '⋯';
    btn.style.cssText = `
        background:none;border:none;font-size:20px;color:#888;
        cursor:pointer;padding:4px 8px;flex-shrink:0;
    `;
    header.appendChild(btn);

    btn.addEventListener('click', () => {
        const existing = document.querySelector('.chat-settings-menu');
        if (existing) { existing.remove(); return; }

        const menu = document.createElement('div');
        menu.className = 'chat-settings-menu';
        menu.style.cssText = `
            position:absolute;top:50px;right:10px;z-index:240;
            background:white;border-radius:14px;box-shadow:0 4px 20px rgba(0,0,0,0.15);
            width:180px;overflow:hidden;
        `;
        const currentSize = localStorage.getItem('chat_font_size') || '14';
        const sizeLabels = { '12': '小', '14': '中', '16': '大' };

        menu.innerHTML = `
    <div class="settings-menu-item" data-action="clear-chat" style="padding:12px 16px;cursor:pointer;font-size:14px;color:#e53935;border-bottom:1px solid #f5f5f5;">
        🗑️ 清空对话
    </div>
<div style="padding:10px 16px;border-bottom:1px solid #f5f5f5;">
    <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-size:13px;color:#666;flex-shrink:0;">🔤</span>
        <span style="font-size:13px;color:#666;flex:1;">字体大小</span>
        <span id="fontSizeValue" style="font-size:13px;color:#333;font-weight:600;">${currentSize}px</span>
    </div>
    <input type="range" id="fontSizeSlider" min="10" max="22" value="${currentSize}" step="1"
           style="width:100%;margin-top:4px;accent-color:#0b93f6;cursor:pointer;">
</div>
    <div class="settings-menu-item" data-action="view-memories" style="padding:12px 16px;cursor:pointer;font-size:14px;color:#333;">
        📜 查看记忆
    </div>
`;
        header.style.position = 'relative';
        header.appendChild(menu);

        // 点击外部关闭
        const closeMenu = (e) => {
            if (!menu.contains(e.target) && e.target !== btn) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        };
        setTimeout(() => document.addEventListener('click', closeMenu), 0);

        menu.querySelector('[data-action="clear-chat"]')?.addEventListener('click', () => {
            menu.remove();
            // 通过事件触发，不直接调用 chat.js 的函数
            window.dispatchEvent(new CustomEvent('chat-clear', { detail: { otherId: context.otherId } }));
        });

        menu.querySelector('[data-action="view-memories"]')?.addEventListener('click', () => {
            menu.remove();
            window.dispatchEvent(new CustomEvent('chat-view-memories', {
                detail: { charId: context.otherId, charName: context.contact?.name }
            }));
        });

        // 字体大小滑块
        const slider = menu.querySelector('#fontSizeSlider');
        const valueLabel = menu.querySelector('#fontSizeValue');
        if (slider) {
            slider.addEventListener('input', () => {
                const size = slider.value;
                valueLabel.textContent = size + 'px';
                localStorage.setItem('chat_font_size', size);
                applyChatFontSize(size);
            });
        }

    });
}

// ============================================================
//  3. 输入框扩展键
// ============================================================

function bindInputExtensions(container, context) {
    const inputArea = container.querySelector('.chat-input-area');
    if (!inputArea) return;
    // 避免重复初始化
    if (container.querySelector('.chat-bottom-area')) return;

    // 1. 把 .chat-input-area 包一层
    const bottomArea = document.createElement('div');
    bottomArea.className = 'chat-bottom-area';
    inputArea.parentNode.insertBefore(bottomArea, inputArea);
    bottomArea.appendChild(inputArea);

    // 2. 创建可展开的面板
    const panel = document.createElement('div');
    panel.className = 'chat-ext-panel';
    panel.id = 'chatExtPanel';
    panel.innerHTML = `
        <button class="chat-ext-btn" data-ext="gallery">
            <span class="ext-icon">🖼️</span>
            <span class="ext-label">相册</span>
        </button>
        <button class="chat-ext-btn" data-ext="emoji">
            <span class="ext-icon">😊</span>
            <span class="ext-label">表情</span>
        </button>
    `;
    bottomArea.insertBefore(panel, inputArea);

    // 3. 输入框左侧加一个展开按钮
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'chat-ext-toggle';
    toggleBtn.textContent = '📎';
    toggleBtn.type = 'button';
    toggleBtn.style.cssText = `
        background:none; border:none; font-size:18px; cursor:pointer;
        padding:4px 6px; flex-shrink:0; border-radius:50%;
        transition:transform 0.2s;
    `;
    inputArea.insertBefore(toggleBtn, inputArea.firstChild);

    // 4. 点击切换展开/收起
    let isOpen = false;
    toggleBtn.addEventListener('click', () => {
        isOpen = !isOpen;
        panel.classList.toggle('open', isOpen);
        toggleBtn.style.transform = isOpen ? 'rotate(45deg)' : '';
    });

    // 5. 面板按钮点击（复用 CustomEvent）
    panel.addEventListener('click', (e) => {
        const btn = e.target.closest('.chat-ext-btn');
        if (!btn) return;
        window.dispatchEvent(new CustomEvent('chat-extension', {
            detail: { ext: btn.dataset.ext, pairKey: context.pairKey, otherId: context.otherId }
        }));
        // 点击后自动收起
        isOpen = false;
        panel.classList.remove('open');
        toggleBtn.style.transform = '';
    });
}
// ---- 应用聊天字体大小 ----
function applyChatFontSize(size) {
    const chatDetail = document.querySelector('.chat-detail');
    if (chatDetail) chatDetail.style.setProperty('--chat-font-size', size + 'px');
}

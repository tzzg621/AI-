// apps/chat/chatUI.js — 聊天界面 UI 组件
// 独立于 chat.js，出问题不影响核心聊天功能

import { esc } from '../../store/utils.js';

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
                <div style="font-size:48px;margin-bottom:8px;">${esc(charInfo.emoji)}</div>
                <div style="font-size:18px;font-weight:700;">${esc(charInfo.name)}</div>
                ${charInfo.desc ? `<div style="font-size:13px;color:#666;margin-top:6px;">${esc(charInfo.desc)}</div>` : ''}
            </div>
            ${charInfo.style ? `
                <div style="padding:0 20px 8px;">
                    <div style="font-size:12px;color:#999;">说话风格</div>
                    <div style="font-size:13px;color:#333;">${esc(charInfo.style)}</div>
                </div>
            ` : ''}
            ${charInfo.secret ? `
                <div style="padding:0 20px 16px;">
                    <div style="font-size:12px;color:#999;">内心秘密</div>
                    <div style="font-size:13px;color:#c62828;">${esc(charInfo.secret)}</div>
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
    <div class="settings-menu-item" data-action="edit-messages" style="padding:12px 16px;cursor:pointer;font-size:14px;color:#e53935;border-bottom:1px solid #f5f5f5;">
        ✏️ 编辑消息
    </div>
    <div class="settings-menu-item" data-action="toggle-mode" style="padding:12px 16px;cursor:pointer;font-size:14px;color:#333;border-bottom:1px solid #f5f5f5;">
        ⚡ 自动回复
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

        menu.querySelector('[data-action="edit-messages"]')?.addEventListener('click', () => {
            menu.remove();
            window.dispatchEvent(new CustomEvent('chat-edit-messages', {
                detail: { pairKey: context.pairKey, otherId: context.otherId }
            }));
        });


        menu.querySelector('[data-action="toggle-mode"]')?.addEventListener('click', () => {
            menu.remove();
            window.dispatchEvent(new CustomEvent('chat-toggle-mode', { detail: { otherId: context.otherId } }));
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
        <button class="chat-ext-btn" data-ext="cognitive">
            <span class="ext-icon">📝</span>
            <span class="ext-label">认知</span>
        </button>        
        <button class="chat-ext-btn" data-ext="summary">
            <span class="ext-icon">📋</span>
            <span class="ext-label">总结</span>
        </button>
        <button class="chat-ext-btn" data-ext="ifbranch">
            <span class="ext-icon">📖</span>
            <span class="ext-label">平行剧情</span>
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

        // ★ 认知笔记：直接处理，不触发事件
        if (btn.dataset.ext === 'cognitive') {
            // showCognitiveNoteEditor(context.activeId, context.contact?.name || context.otherId);
            showCognitiveNoteEditor(context.activeId, context.otherId, context.contact?.name || context.otherId);
            isOpen = false;
            panel.classList.remove('open');
            toggleBtn.style.transform = '';
            return;
        }

        // ★ 窗口总结：直接处理      ← 加这一段
        if (btn.dataset.ext === 'summary') {
            showWindowSummary(context);
            isOpen = false;
            panel.classList.remove('open');
            toggleBtn.style.transform = '';
            return;
        }

        // ★ 平行剧情
        if (btn.dataset.ext === 'ifbranch') {
            import('./ifBranch.js').then(mod => {
                mod.showIfBranchViewer(context.pairKey, context);
            });
            isOpen = false;
            panel.classList.remove('open');
            toggleBtn.style.transform = '';
            return;
        }

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

// ★ 认知笔记编辑弹窗
// function showCognitiveNoteEditor(charId, charName) {
function showCognitiveNoteEditor(activeId, otherId, otherName) {
    import('../../store/CharacterStore.js').then(({ CharacterStore }) => {
        const store = new CharacterStore(activeId);
        // const currentNote = store.getCognitiveNote(charName);
        const currentNote = store.getCognitiveNote(otherId);

        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:300;display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = `
            <div style="background:white; border-radius:20px; width:300px; padding:20px;">
                <div style="font-weight:600; font-size:16px; margin-bottom:4px;">📝 我对${esc(otherName)}的认知</div>
                <div style="font-size:12px; color:#888; margin-bottom:12px;">记录你对该角色的了解，比如外貌、性格、你们之间发生过的事</div>
                <textarea id="cognitiveText" rows="6" placeholder="……"
                          style="width:100%; border:1px solid #ccc; border-radius:8px; padding:8px; font-size:13px; resize:vertical; box-sizing:border-box; font-family:inherit;">${esc(currentNote)}</textarea>
                <div style="display:flex; gap:8px; margin-top:10px;">
                    <button class="cognitive-save-btn" style="flex:1; padding:8px; border:none; background:#0b93f6; color:white; border-radius:10px; cursor:pointer; font-size:13px;">保存</button>
                    <button class="cognitive-cancel-btn" style="flex:1; padding:8px; border:1px solid #ccc; background:white; color:#666; border-radius:10px; cursor:pointer; font-size:13px;">取消</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        // ★ AbortController 统一管理
        const controller = new AbortController();
        const { signal } = controller;

        function close() {
            controller.abort();
            overlay.remove();
        }

        // 点击遮罩层关闭
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close();
        }, { signal });

        // 保存
        overlay.querySelector('.cognitive-save-btn').addEventListener('click', () => {
            const text = overlay.querySelector('#cognitiveText').value.trim();
            // store.setCognitiveNote(charName, text);
            store.setCognitiveNote(otherId, text);
            close();
            window.dispatchEvent(new CustomEvent('cognitive-saved'));
        }, { signal });

        // 取消
        overlay.querySelector('.cognitive-cancel-btn').addEventListener('click', close, { signal });
    });
}

function showWindowSummary(context) {
    const { pairKey, otherId, activeId, contact, globalState } = context;
    const otherName = contact?.name || otherId;
    const activeName = globalState?.activeCharacter?.base?.name || '我';

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:300;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
        <div style="background:white;border-radius:20px;width:320px;padding:20px;">
            <div style="font-weight:600;font-size:16px;margin-bottom:4px;">📋 窗口总结</div>
            <div style="font-size:12px;color:#888;margin-bottom:12px;">${esc(activeName)} 与 ${esc(otherName)} 的对话总结</div>
            <div id="summaryContent" style="
                background:#f9f9f9;border-radius:10px;padding:12px;font-size:13px;
                min-height:80px;max-height:300px;overflow-y:auto;line-height:1.6;
                color:#333;white-space:pre-wrap;
            ">暂无总结，点击下方按钮提取</div>
            <div style="display:flex;gap:8px;margin-top:12px;">
                <button id="extractSummaryBtn" style="flex:1;padding:8px;border:none;background:#0b93f6;color:white;border-radius:10px;cursor:pointer;font-size:13px;">🔄 提取总结</button>
                <button class="summary-close-btn" style="flex:1;padding:8px;border:1px solid #ccc;background:white;color:#666;border-radius:10px;cursor:pointer;font-size:13px;">关闭</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const summaryEl = overlay.querySelector('#summaryContent');
    const extractBtn = overlay.querySelector('#extractSummaryBtn');
    const controller = new AbortController();
    const { signal } = controller;

    function close() {
        controller.abort();
        overlay.remove();
    }

    // ★ 读取已有总结（独立 key，按 pairKey 索引）
    try {
        const summaries = JSON.parse(localStorage.getItem('chat_summaries') || '{}');
        if (summaries[pairKey]) {
            summaryEl.textContent = summaries[pairKey];
        }
    } catch { }

    extractBtn.addEventListener('click', async () => {
        extractBtn.textContent = '⏳ 提取中...';
        extractBtn.disabled = true;

        try {
            const { callAIWithMessages } = await import('../aiService.js');
            // ★ 修改：不再从 CharacterStore 读取，改为从 chat_messages 全局存储读取
            const chatMessagesMap = JSON.parse(localStorage.getItem('chat_messages') || '{}');
            const messages = chatMessagesMap[pairKey] || [];

            if (messages.length < 3) {
                summaryEl.textContent = '对话太短，暂无总结价值。';
                extractBtn.textContent = '🔄 提取总结';
                extractBtn.disabled = false;
                return;
            }

            const convText = messages.map(m => {
                const name = m.senderId === activeId ? activeName : otherName;
                return `${name}：${(m.text || '').replace(/\|/g, '')}`;
            }).join('\n');

            const summary = await callAIWithMessages({
                systemPrompt: `你是一个对话总结助手。请以纯客观的第三人称视角，总结以下两个角色之间的对话。

要求：
- 概括对话的起因、经过、关键转折点和当前状态
- 保持客观，不要加入主观评价
- 控制在 150 字以内
- 直接输出总结内容，不要标题和前缀`,
                userContent: convText,
                maxTokens: 1024,
                temperature: 0.5
            });

            // ★ 保存到独立 key
            const summaries = JSON.parse(localStorage.getItem('chat_summaries') || '{}');
            summaries[pairKey] = summary;
            localStorage.setItem('chat_summaries', JSON.stringify(summaries));

            summaryEl.textContent = summary;
        } catch (e) {
            summaryEl.textContent = '❌ 提取失败：' + e.message;
        }

        extractBtn.textContent = '🔄 提取总结';
        extractBtn.disabled = false;
    }, { signal });

    overlay.querySelector('.summary-close-btn').addEventListener('click', close, { signal });
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    }, { signal });
}

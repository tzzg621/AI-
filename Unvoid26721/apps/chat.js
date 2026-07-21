import { CharacterStore, getActiveCharacterId } from '../store/CharacterStore.js';
import { getCharacterId, getCharacterNameById } from './characterManager.js';
import { buildPrompt, buildMemoryExtractPrompt } from './promptBuilder.js';
import { callAI, callAIForMemoryExtract } from './aiService.js';
import { getAvatarHtml, setImage, clearImageCache, setImageFromGallery, setCropParams, getImageDataUrl, getImageHtml } from '../store/ImageCache.js';
import { showCropEditor, showConfirm } from '../store/dialog.js';
import { initChatUI } from './chat/chatUI.js';


// ---- Toast 通知 ----
function showToast(msg, color = '#333') {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:${color};color:#fff;padding:10px 20px;border-radius:12px;z-index:10000;font-size:13px;box-shadow:0 4px 20px rgba(0,0,0,0.2);max-width:80%;text-align:center;`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
}

// ---- 记忆保存（可替换） ----
function saveMemoryToBoth(senderId, receiverId, senderName, receiverName, text) {
    const time = new Date().toLocaleString('zh-CN');

    // 存到发送方
    const storeSender = new CharacterStore(senderId);
    storeSender.addMemory({
        time,
        content: `对 ${receiverName} 说：${text}`,
        participants: [senderId, receiverId],
        source: 'chat'
    });

    // 存到接收方
    const storeReceiver = new CharacterStore(receiverId);
    storeReceiver.addMemory({
        time,
        content: `${senderName}对我说：${text}`,
        participants: [senderId, receiverId],
        source: 'chat'
    });
}


export const id = 'chatPage';
export const label = '聊天';
export const icon = '💬';
export const color = '#0b93f6';
export const title = '💬 聊天';
export const memoryOptions = {
    mode: 'manual',
    description: '聊天内容可手动选择与记忆联动。',
    enabled: true
};

const tabPages = [
    { id: 'chats', label: '聊天', icon: '💬' },
    { id: 'contacts', label: '通讯录', icon: '👥' },
    { id: 'discover', label: '发现', icon: '✨' },
    { id: 'me', label: '我', icon: '👤' }
];

// 联系人数据
const contacts = [
    { id: 'ai', name: 'AI助手', avatar: '🤖', note: '智能建议，快速生成故事' },
    { id: 'world', name: '世界书小助手', avatar: '📖', note: '协助整理设定' },
    { id: 'role', name: '角色协作者', avatar: '👤', note: '帮助管理角色' },
    { id: 'system', name: '系统通知', avatar: '🔔', note: '接收系统更新' }
];

// 获取所有可联系人（从角色名册读取）
function getAllAvailableContacts() {
    const result = [...contacts];
    try {
        const roleData = localStorage.getItem('rolebook_characters');
        if (roleData) {
            const characters = JSON.parse(roleData);
            characters.forEach(char => {
                if (char.id && !result.some(c => c.id === char.id)) {
                    result.push({
                        id: char.id,
                        name: char.base.name,       // ← 新格式，name 在 base 里
                        avatar: char.id,    // ← 新格式
                        note: char.base.desc,       // ← 新格式
                        isCharacter: true
                    });
                }
            });
        }
    } catch (e) { }
    // ★ 从 CharacterStore 读取 NPC 数据
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('char_')) {
                const id = key.replace('char_', '');
                // 排除已在角色名册中的角色
                if (!id.startsWith('default-') && !result.some(c => c.id === id)) {
                    const store = new CharacterStore(id);
                    const info = store.getInfo();
                    if (info.name) {
                        result.push({
                            id: id,
                            name: info.name,
                            avatar: id,
                            note: info.desc || '世界角色网络',
                            isNpc: true
                        });
                    }
                }
            }
        }
    } catch (e) { }

    return result;
}

// ---- 好友系统 ---- 统一使用 CharacterStore
// （删掉 FRIENDS_KEY、loadFriends、saveFriends、addFriend 这4个旧函数）

function getMyFriends(activeId) {
    if (!activeId) return [];
    try {
        const store = new CharacterStore(activeId);
        return store.getFriendIds();
    } catch (e) {
        return [];
    }
}

const moments = [
    { title: '银河漫步', subtitle: '我发布了一张动态', time: '刚刚' },
    { title: '创作灵感', subtitle: '今天的主角设定完成了', time: '1小时前' },
    { title: '世界观更新', subtitle: '加入了新的文明设定', time: '昨天' }
];

let activePage = 'chats';

const STATS_KEY = 'chat_conversation_stats';
let conversationStats = (() => {
    try {
        const saved = localStorage.getItem(STATS_KEY);
        return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
})();
let activeChatId = null;
let activePairKey = null;

function renderTabBar() {
    return `
        <div class="chat-tab-bar">
            ${tabPages.map((tab) => `
                <button class="chat-tab-item ${activePage === tab.id ? 'active' : ''}" data-page="${tab.id}">
                    <span class="tab-icon">${tab.icon}</span>
                    <span class="tab-label">${tab.label}</span>
                </button>
            `).join('')}
        </div>
    `;
}

// ---- 聊天记录持久化（按角色对存储） ----
const CHAT_STORAGE_KEY = 'chat_messages';

function loadChatMessages() {
    const saved = localStorage.getItem(CHAT_STORAGE_KEY);
    if (saved) {
        try { return JSON.parse(saved); } catch (e) { }
    }
    return {};
}

function saveChatMessages(data) {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(data));
}

let chatMessagesMap = loadChatMessages();

function getOrCreateMessages(pairKey) {
    if (!chatMessagesMap[pairKey]) {
        chatMessagesMap[pairKey] = [];
    }
    return chatMessagesMap[pairKey];
}

function getPairKey(id1, id2) {
    return [id1, id2].sort().join('||');
}

function getContactInfo(id) {
    const all = getAllAvailableContacts();
    return all.find(c => c.id === id) || { name: id, avatar: '?' };
}

// ---- 渲染函数 ----

function renderChatsPage(globalState) {
    const activeChar = globalState?.activeCharacter;
    if (!activeChar) {
        return `
            <div class="chat-section">
                <p style="text-align:center; padding:20px; color:#888;">
                    请先在角色名册中设置主视角角色
                </p>
            </div>
        `;
    }

    const activeId = getActiveCharacterId(globalState);
    const chatEntries = [];

    Object.keys(chatMessagesMap).forEach(pairKey => {
        const ids = pairKey.split('||');
        const otherId = ids[0] === activeId ? ids[1] : (ids[1] === activeId ? ids[0] : null);
        if (otherId) {
            const messages = chatMessagesMap[pairKey];
            const lastMsg = messages[messages.length - 1];
            const contact = getContactInfo(otherId);
            let preview = '暂无消息';
            if (lastMsg) {
                const senderName = lastMsg.senderId === activeId ? '我' : (contact.name || lastMsg.senderId);
                preview = `${senderName}：${lastMsg.text}`;
            }
            chatEntries.push({
                pairKey,
                otherId,
                name: contact.name,
                avatar: contact.avatar,
                preview,
                status: '在线'
            });
        }
    });

    chatEntries.sort((a, b) => {
        const aMsgs = chatMessagesMap[a.pairKey] || [];
        const bMsgs = chatMessagesMap[b.pairKey] || [];
        return (bMsgs.length) - (aMsgs.length);
    });

    if (chatEntries.length === 0) {
        return `
            <div class="chat-section">
                <p style="text-align:center; padding:20px; color:#888;">
                    暂无聊天记录，去通讯录找人聊聊吧
                </p>
            </div>
        `;
    }

    return `
        <div class="chat-section">
            <div class="chat-list">
                ${chatEntries.map((item) => `
                    <button class="chat-item" data-chat-id="${item.otherId}" data-pair-key="${item.pairKey}">
<div class="chat-avatar" style="width:36px; height:36px; border-radius:50%; overflow:hidden; flex-shrink:0; background:#e0e0e0;">
    ${getAvatarHtml(item.otherId, '?')}
</div>
                        <div class="chat-main">
                            <div class="chat-name-row">
                                <span class="chat-name">${item.name}</span>
                                <span class="chat-status">${item.status}</span>
                            </div>
                            <div class="chat-preview">${item.preview}</div>
                        </div>
                    </button>
                `).join('')}
            </div>
        </div>
    `;
}

function renderContactsPage(globalState) {
    const activeChar = globalState?.activeCharacter;
    const activeId = getActiveCharacterId(globalState);
    const friendIds = getMyFriends(activeId);
    const allContacts = getAllAvailableContacts();

    // ★ 从聊天记录中找出所有聊过天的联系人
    const chattedIds = new Set();
    Object.keys(chatMessagesMap).forEach(pairKey => {
        const ids = pairKey.split('||');
        const otherId = ids[0] === activeId ? ids[1] : (ids[1] === activeId ? ids[0] : null);
        if (otherId) {
            chattedIds.add(otherId);
        }
    });

    // ★ 合并好友 + 聊过天的人（去重）
    const contactIds = new Set([...friendIds, ...chattedIds]);
    const contacts = allContacts.filter(c => contactIds.has(c.id));

    return `
        <div class="contacts-section">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                <span style="font-weight:600;">联系人（${contacts.length}）</span>
                <button id="addFriendBtn" style="padding:6px 14px; border-radius:16px; border:none; 
                        background:#ccc; color:#888; cursor:not-allowed; font-size:12px;">
                    ➕ 添加好友（功能开发中）
                </button>
            </div>
            <div class="contacts-list">
                ${contacts.length === 0 ? '<p style="text-align:center; padding:20px; color:#888;">暂无联系人</p>' : ''}
                ${contacts.map((item) => `
<div class="contact-card" style="display:flex; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid #eee;">
    <div class="contact-avatar-wrapper" data-contact-id="${item.id}" style="width:36px; height:36px; border-radius:50%; overflow:hidden; flex-shrink:0; background:#e0e0e0; cursor:pointer; position:relative;">
        ${getAvatarHtml(item.id, '?')}
        <div style="position:absolute; bottom:0; left:0; right:0; background:rgba(0,0,0,0.4); color:white; font-size:10px; text-align:center; padding:2px 0; opacity:0; transition:opacity 0.2s;">更换</div>
    </div>
                        <div style="flex:1;">
                            <div class="contact-name" style="font-weight:600;">${item.name}</div>
                            <div class="contact-note" style="font-size:13px; color:#888;">${item.note || ''}</div>
                        </div>
                        <button class="start-chat-btn" data-contact-id="${item.id}"
                                style="padding:6px 14px; border-radius:16px; border:none; 
                                       background:#0b93f6; color:white; cursor:pointer; font-size:12px;">
                            💬 聊天
                        </button>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

function renderDiscoverPage() {
    return `
        <div class="discover-section">
            <div class="discover-card">
                <div class="discover-title">朋友圈</div>
                ${moments.map((item) => `
                    <div class="moment-item">
                        <div class="moment-title">${item.title}</div>
                        <div class="moment-subtitle">${item.subtitle}</div>
                        <div class="moment-time">${item.time}</div>
                    </div>
                `).join('')}
            </div>
            <div class="discover-card">
                <div class="discover-title">更多功能</div>
                <div class="discover-grid">
                    <button class="discover-action">小程序</button>
                    <button class="discover-action">扫一扫</button>
                    <button class="discover-action">摇一摇</button>
                    <button class="discover-action">游戏</button>
                </div>
            </div>
        </div>
    `;
}

function renderMePage(globalState) {
    const chara = globalState?.activeCharacter;
    if (!chara) {
        return `
            <div class="me-section">
                <div class="profile-card">
                    <p style="text-align:center; padding:20px; color:#888;">请先在角色名册中设置主视角角色</p>
                </div>
            </div>
        `;
    }
    return `
        <div class="me-section">
            <div class="profile-card">
<div id="avatarUploadContainer" style="width:60px; height:60px; border-radius:50%; overflow:hidden; margin:0 auto; background:#e0e0e0; cursor:pointer;">
    ${getAvatarHtml(chara.id)}
</div>
<div style="font-size:11px; color:#888; margin-top:4px; text-align:center;">点击更换头像</div>
                <div class="profile-info" style="text-align:center; margin-top:8px;">
                    <div class="profile-name" style="font-size:20px; font-weight:600;">${chara.base.name}</div>
                    <div class="profile-desc" style="font-size:13px; color:#666; margin-top:4px;">${chara.base.desc}</div>
                </div>
            </div>
            <div style="margin-top:12px; background:#fff3e0; border-radius:12px; padding:12px;">
                <div style="font-weight:600; margin-bottom:4px;">🔒 内心秘密</div>
                <div style="font-size:14px; color:#e65100;">${chara.base.secret || '无'}</div>
            </div>
            <div style="margin-top:8px; background:#e3f2fd; border-radius:12px; padding:12px;">
                <div style="font-weight:600; margin-bottom:4px;">📜 独立记忆</div>
                ${(chara.base.memories || []).map(m => `
                    <div style="padding:4px 0; font-size:13px; color:#1565c0;">
                        <span style="font-size:11px;">${m.time}</span>
                        <div>${m.content}</div>
                    </div>
                `).join('') || '<div style="font-size:13px; color:#888;">暂无记忆</div>'}
            </div>
        </div>
                </div>
            <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:white;border-radius:12px;margin-top:12px;">
                <div>
                    <div style="font-weight:600;font-size:15px;">📝 自动提取记忆</div>
                    <div style="font-size:12px;color:#999;">每次对话满10轮或关闭对话框时自动总结记忆</div>
                </div>
                <button id="autoExtractToggle" style="
                    padding:6px 16px;border-radius:14px;border:none;
                    background:${localStorage.getItem('auto_extract_memory_' + getActiveCharacterId(globalState)) !== 'false' ? '#4CAF50' : '#ccc'};
                    color:white;cursor:pointer;font-size:13px;font-weight:600;
                ">${localStorage.getItem('auto_extract_memory_' + getActiveCharacterId(globalState)) !== 'false' ? '🟢 开启' : '⚪ 关闭'}</button>
            </div>
        
    `;

}

function renderChatDetail(pairKey, otherId, globalState) {
    const messages = getOrCreateMessages(pairKey);
    const contact = getContactInfo(otherId);
    const activeChar = globalState?.activeCharacter;
    const activeId = getActiveCharacterId(globalState);

    return `
        <div class="chat-detail">
            <div class="chat-detail-header">
                <div class="chat-detail-title">${contact.name}</div>
                <div class="header-spacer"></div>
                <button id="autoMemoryToggle" class="btn-sm" style="
                    background:${localStorage.getItem('auto_memory_' + otherId) === 'true' ? '#4CAF50' : '#ccc'};
                    margin-right:8px;
                ">${localStorage.getItem('auto_memory_' + otherId) === 'true' ? '🧠' : '🧠 off'}</button>
                <button id="extractMemoryBtn" class="btn-sm" style="background:#ff9800;margin-right:4px;">📝 提取记忆</button>
            </div>
            <div class="chat-messages" id="chatMessages">
${messages.map((msg) => {
        const isMe = msg.senderId === activeId;
        if (isMe) {
            return `<div class="msg-row me">
    <div style="min-width:0;">
        <div class="msg-bubble me">${msg.text}</div>
    </div>
    <div class="msg-avatar">${getAvatarHtml(msg.senderId)}</div>
</div>`;
        } else {
            return `<div class="msg-row other">
                <div class="msg-avatar">${getAvatarHtml(msg.senderId)}</div>
                <div style="min-width:0;">
                    <div class="msg-bubble other">${msg.text}</div>
                </div>
            </div>`;
        }
    }).join('')}
            </div>
            <div class="chat-input-area">
                <input type="text" id="chatInput" placeholder="输入消息..." autofocus>
                <button id="chatSendBtn">➤</button>
            </div>
        </div>
    `;
}

export function render({ globalState } = {}) {
    const pageContent = activePage === 'chats'
        ? renderChatsPage(globalState)
        : activePage === 'contacts'
            ? renderContactsPage(globalState)
            : activePage === 'discover'
                ? renderDiscoverPage()
                : renderMePage(globalState);

    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">${title}</div>
                ${globalState?.activeCharacter ? `
                <div style="text-align:center; padding:6px; background:#e8eaf6; font-size:13px; color:#283593;">
当前扮演：${globalState.activeCharacter.base.name}
                </div>` : ''}
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content chat-shell">
                <div class="page-card chat-app-shell">
                    ${pageContent}
                </div>
            </div>
            ${renderTabBar()}
        </div>
    `;
}

export function bindEvents(container, { memoryService, globalState }) {
    bindTabButtons(container, memoryService, globalState);
    bindPageInteractions(container, memoryService, globalState);

    // ★ 监听头像加载完成，自动刷新显示
    window.addEventListener('image-loaded', function __refreshChatAvatars(e) {
        const { charId, type } = e.detail || {};
        if (!charId) return;

        const selector = `[data-char-id="${charId}"][data-img-type="${type}"]`;
        document.querySelectorAll(selector).forEach(el => {
            const isRound = el.style.borderRadius === '50%';
            el.outerHTML = getImageHtml(charId, type, { round: isRound });
        });
    });
}

function bindTabButtons(container, memoryService, globalState) {
    container.querySelectorAll('.chat-tab-item').forEach((button) => {
        button.addEventListener('click', () => {
            activePage = button.dataset.page;
            activeChatId = null;
            activePairKey = null;
            const appContainer = container.closest('.screen-page') || container;
            appContainer.innerHTML = render({ globalState });
            // ★ 切回列表时清除详情标记
            appContainer.querySelector('.screen-content.chat-shell')?.classList.remove('chat-in-detail');
            bindEvents(appContainer, { memoryService, globalState });
        });
    });
}

function bindPageInteractions(container, memoryService, globalState) {
    // 聊天列表
    if (activePage === 'chats') {
        container.querySelectorAll('.chat-item').forEach((item) => {
            item.addEventListener('click', () => {
                activeChatId = item.dataset.chatId;
                activePairKey = item.dataset.pairKey;
                const appContainer = container.closest('.screen-page') || container;
                const shell = appContainer.querySelector('.chat-app-shell');
                shell.innerHTML = renderChatDetail(activePairKey, activeChatId, globalState);
                appContainer.querySelector('.screen-content.chat-shell')?.classList.add('chat-in-detail');
                bindChatDetailEvents(appContainer, activePairKey, activeChatId, memoryService, globalState);
            });
        });
    }

    // 通讯录
    if (activePage === 'contacts') {
        container.querySelectorAll('.start-chat-btn').forEach(btn => {
            btn.addEventListener('click', function () {
                const otherId = this.dataset.contactId;
                const activeChar = globalState?.activeCharacter;
                if (!activeChar) {
                    alert('请先在角色名册中设置主视角角色');
                    return;
                }
                const activeId = getActiveCharacterId(globalState);
                const pairKey = getPairKey(activeId, otherId);
                activeChatId = otherId;
                activePairKey = pairKey;
                const appContainer = container.closest('.screen-page') || container;
                const shell = appContainer.querySelector('.chat-app-shell');
                shell.innerHTML = renderChatDetail(pairKey, otherId, globalState);
                appContainer.querySelector('.screen-content.chat-shell')?.classList.add('chat-in-detail');
                bindChatDetailEvents(appContainer, pairKey, otherId, memoryService, globalState);
            });

        });

        // ★ 联系人头像上传
        container.querySelectorAll('.contact-avatar-wrapper').forEach(wrapper => {
            wrapper.addEventListener('mouseenter', () => {
                const tip = wrapper.querySelector('div:last-child');
                if (tip) tip.style.opacity = '1';
            });
            wrapper.addEventListener('mouseleave', () => {
                const tip = wrapper.querySelector('div:last-child');
                if (tip) tip.style.opacity = '0';
            });
            wrapper.addEventListener('click', async () => {
                const contactId = wrapper.dataset.contactId;
                const choice = await showConfirm('点击「确定」从相册选择\n点击「取消」从本地文件上传');
                if (choice) {
                    // 从相册选择
                    import('./gallery.js').then(gallery => {
                        gallery.renderGalleryPicker(async (galleryKey) => {
                            setImageFromGallery(contactId, 'avatar', galleryKey);
                            const dataUrl = await getImageDataUrl(galleryKey);
                            const crop = await showCropEditor(dataUrl || galleryKey, { ratio: 1 });
                            setCropParams(contactId, 'avatar', crop);
                            const appContainer = container.closest('.screen-page') || container;
                            appContainer.innerHTML = render({ globalState });
                            bindEvents(appContainer, { memoryService, globalState });
                        });
                    });
                } else {
                    // 从文件上传（原有逻辑）
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.accept = 'image/*';
                    input.onchange = (e) => {
                        const file = e.target.files[0];
                        if (!file) return;
                        const reader = new FileReader();
                        reader.onload = async (ev) => {
                            const dataUrl = ev.target.result;
                            setImage(contactId, 'avatar', file);
                            const crop = await showCropEditor(dataUrl, { ratio: 1 });
                            setCropParams(contactId, 'avatar', crop);
                            const appContainer = container.closest('.screen-page') || container;
                            appContainer.innerHTML = render({ globalState });
                            bindEvents(appContainer, { memoryService, globalState });
                        };
                        reader.readAsDataURL(file);
                    };
                    input.click();
                }
            });
        });

    }

    // ★ 我页面：头像上传
    if (activePage === 'me') {
        container.querySelector('#avatarUploadContainer')?.addEventListener('click', async () => {
            const chara = globalState?.activeCharacter;
            if (!chara) { showToast('请先设置主视角角色', '#c62828'); return; }  // 用 toast 替代 alert
            const choice = await showConfirm('点击「确定」从相册选择\n点击「取消」从本地文件上传');
            if (choice) {
                import('./gallery.js').then(gallery => {
                    gallery.renderGalleryPicker(async (galleryKey) => {
                        setImageFromGallery(chara.id, 'avatar', galleryKey);
                        const dataUrl = await getImageDataUrl(galleryKey);
                        const crop = await showCropEditor(dataUrl || galleryKey, { ratio: 1 });
                        setCropParams(chara.id, 'avatar', crop);
                        const appContainer = container.closest('.screen-page') || container;
                        appContainer.innerHTML = render({ globalState });
                        bindEvents(appContainer, { memoryService, globalState });
                    });
                });
            } else {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = 'image/*';
                input.onchange = (e) => {
                    const file = e.target.files[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = async (ev) => {
                        const dataUrl = ev.target.result;
                        setImage(chara.id, 'avatar', dataUrl);
                        const crop = await showCropEditor(dataUrl, { ratio: 1 });
                        setCropParams(chara.id, 'avatar', crop);
                        const appContainer = container.closest('.screen-page') || container;
                        appContainer.innerHTML = render({ globalState });
                        bindEvents(appContainer, { memoryService, globalState });
                    };
                    reader.readAsDataURL(file);
                };
                input.click();
            }
        });

        // ★ 自动提取记忆开关
        container.querySelector('#autoExtractToggle')?.addEventListener('click', () => {
            const key = 'auto_extract_memory_' + getActiveCharacterId(globalState);
            const current = localStorage.getItem(key) !== 'false';
            localStorage.setItem(key, current ? 'false' : 'true');
            const appContainer = container.closest('.screen-page') || container;
            appContainer.innerHTML = render({ globalState });
            bindEvents(appContainer, { memoryService, globalState });
        });

    }

}

function bindChatDetailEvents(container, pairKey, otherId, memoryService, globalState) {
    const chatInput = container.querySelector('#chatInput');
    const chatSendBtn = container.querySelector('#chatSendBtn');
    const chatMessages = container.querySelector('#chatMessages');
    const contact = getContactInfo(otherId);

    const activeChar = globalState?.activeCharacter;
    const activeId = getActiveCharacterId(globalState);
    // const charName = activeChar ? `${activeChar.base.emoji} ${activeChar?.base?.name}` : '我';

    function sendChat() {
        const text = chatInput.value.trim();
        if (!text) return;

        const userMsg = document.createElement('div');
        userMsg.className = 'msg user';
        const userDisplayName = activeChar ? activeChar.base.name : '我';
        const otherDisplayName = contact.name;  // ★ 只显示纯名字
        const aiRoleName = contact.name;                               // ★ AI 用：纯名字

        userMsg.innerHTML = `
    <div class="msg-row me">
        <div style="min-width:0;">
            <div class="msg-bubble me">${text}</div>
        </div>
        <div class="msg-avatar">${getAvatarHtml(activeId)}</div>
    </div>
`;
        chatMessages.appendChild(userMsg);
        chatInput.value = '';
        const messages = getOrCreateMessages(pairKey);
        messages.push({ senderId: activeId, senderDisplayName: userDisplayName, text: text });

        saveChatMessages(chatMessagesMap);
        // saveMemoryToBoth(activeId, otherId, userDisplayName, otherDisplayName, text);

        // ★ 显示"对方正在输入……"
        const typingMsg = document.createElement('div');
        typingMsg.className = 'msg ai';
        typingMsg.id = 'typingIndicator';
        typingMsg.innerHTML = `
    <div style="display:flex; align-items:flex-start; gap:10px; padding-right:50px;">
        <div style="flex-shrink:0; width:24px; height:24px; margin-top:6px;">
            ${getAvatarHtml(otherId)}
        </div>
        <div style="min-width:0;">
            <div style="background:white; padding:8px 14px; border-radius:16px; border-bottom-left-radius:4px; box-shadow:0 1px 3px rgba(0,0,0,0.1); color:#999;">
                ✏️ 正在输入……
            </div>
        </div>
    </div>
`;
        chatMessages.appendChild(typingMsg);
        chatMessages.scrollTop = chatMessages.scrollHeight;

        // 第 527-547 行（setTimeout 内部，改成这样）
        setTimeout(async () => {
            // ① 获取对手的角色信息
            let characterData = null;
            try {
                const roleData = localStorage.getItem('rolebook_characters');
                if (roleData) {
                    const characters = JSON.parse(roleData);
                    characterData = characters.find(c => c.id === otherId);
                }
                // ★ 如果在角色名册找不到，从 NPC 的 CharacterStore 找
                if (!characterData) {
                    const store = new CharacterStore(otherId);
                    const info = store.getInfo();
                    if (info.name) {
                        characterData = { base: info };
                    }
                }
            } catch (e) { }

            const allMessages = getOrCreateMessages(pairKey);

            const { systemPrompt, assistantContext } = buildPrompt({
                character: characterData,
                characterId: otherId,
                messages: allMessages.slice(-50),
                aiRoleName: aiRoleName,
                autoMemory: localStorage.getItem('auto_memory_' + otherId) === 'true'
            });

            // ... 后面不变

            console.log('📝 systemPrompt:', systemPrompt);
            console.log('📝 assistantContext:', assistantContext);


            let reply;
            try {
                reply = await callAI({
                    systemPrompt,
                    assistantContext  // ★ 角色卡+世界书+记忆+对话历史，放 assistant
                });
            } catch (e) {
                reply = `⚠️ ${e.message}`;
            }

            // ★ 自动记忆处理
            if (localStorage.getItem('auto_memory_' + otherId) === 'true') {
                const store = new CharacterStore(otherId);
                const lines = reply.split('\n');
                lines.forEach(line => {
                    line = line.trim();
                    const addMatch = line.match(/^【记忆】(.+)/);
                    if (addMatch) {
                        store.addMemory({
                            id: 'mem_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
                            time: new Date().toLocaleString('zh-CN'),
                            content: addMatch[1].trim(),
                            source: 'auto_extract'
                        });
                        return;
                    }
                    const modifyMatch = line.match(/^【修改记忆】(.+?) → (.+)/);
                    if (modifyMatch) {
                        const memories = store.getMemories();
                        const idx = memories.findIndex(m => m.content === modifyMatch[1].trim());
                        if (idx >= 0) {
                            memories[idx].content = modifyMatch[2].trim();
                            memories[idx].time = new Date().toLocaleString('zh-CN');
                            store._save();
                        }
                        return;
                    }
                    // const deleteMatch = line.match(/^【删除记忆】(.+)/);
                    // if (deleteMatch) {
                    //     const memories = store.getMemories();
                    //     const idx = memories.findIndex(m => m.content === deleteMatch[1].trim());
                    //     if (idx >= 0) {
                    //         memories.splice(idx, 1);
                    //         store._save();
                    //     }
                    //     return;
                    // }
                });
            }

            // ★ 对方 API 调用计数 + 检查是否触发提取
            if (localStorage.getItem('auto_extract_memory_' + activeId) !== 'false') {
                if (!conversationStats[pairKey]) {
                    conversationStats[pairKey] = { totalApiCalls: 0, lastExtractCount: 0 };
                }
                const stats = conversationStats[pairKey];
                stats.totalApiCalls++;
                if (stats.totalApiCalls - stats.lastExtractCount >= 10) {
                    stats.lastExtractCount = stats.totalApiCalls;
                    localStorage.setItem(STATS_KEY, JSON.stringify(conversationStats));
                    extractMemoriesForActiveChar(activeId, otherId, otherDisplayName, allMessages);
                } else {
                    localStorage.setItem(STATS_KEY, JSON.stringify(conversationStats));
                }
            }


            // ★ 清理回复文本（去掉记忆操作行）
            const displayReply = reply.replace(/【(记忆|修改记忆|删除记忆)】.+(\n|$)/g, '').trim();

            // ④ 移除"正在输入……"
            const typingEl = document.getElementById('typingIndicator');
            if (typingEl) typingEl.remove();

            // ⑤ 显示回复
            const aiMsg = document.createElement('div');
            aiMsg.className = 'msg ai';
            aiMsg.innerHTML = `
    <div class="msg-row other">
        <div class="msg-avatar">${getAvatarHtml(otherId)}</div>
        <div style="min-width:0;">
            <div class="msg-bubble other">${displayReply}</div>
        </div>
    </div>
`;
            chatMessages.appendChild(aiMsg);
            chatMessages.scrollTop = chatMessages.scrollHeight;
            messages.push({ senderId: otherId, senderDisplayName: otherDisplayName, text: displayReply });

            saveChatMessages(chatMessagesMap);
            // ★ 不再自动将每轮对话写入记忆簿
            // saveMemoryToBoth(otherId, activeId, otherDisplayName, userDisplayName, displayReply);
        }, 300);
    }

    chatSendBtn?.addEventListener('click', sendChat);
    // ★ 自动记忆开关
    container.querySelector('#autoMemoryToggle')?.addEventListener('click', () => {
        const key = 'auto_memory_' + otherId;
        const current = localStorage.getItem(key) === 'true';
        localStorage.setItem(key, current ? 'false' : 'true');
        // 重渲染聊天界面
        const appContainer = container.closest('.screen-page') || container;
        appContainer.innerHTML = render({ globalState });
        bindEvents(appContainer, { memoryService, globalState });
    });

    chatInput?.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') sendChat();
    });


    // ★ 提取记忆按钮（手动触发）
    container.querySelector('#extractMemoryBtn')?.addEventListener('click', async () => {
        const btn = container.querySelector('#extractMemoryBtn');
        btn.textContent = '⏳ 提取中...';
        btn.disabled = true;
        try {
            const allMessages = getOrCreateMessages(pairKey);
            if (allMessages.length < 3) { showToast('对话太短，暂无提取价值', '#888'); return; }
            await extractMemoriesForActiveChar(activeId, otherId, otherDisplayName, allMessages);
            if (conversationStats[pairKey]) {
                conversationStats[pairKey].lastExtractCount = conversationStats[pairKey].totalApiCalls;
                localStorage.setItem(STATS_KEY, JSON.stringify(conversationStats));
            }
            showToast('✅ 记忆提取完成', '#4CAF50');
        } catch (e) {
            showToast('❌ 提取失败', '#c62828');
        } finally {
            btn.textContent = '📝 提取记忆';
            btn.disabled = false;
        }
    });

    // ★ 初始化聊天 UI 组件（头像弹窗、设置菜单、扩展键）
    try {
        const chatDetail = container.querySelector('.chat-detail');
        if (chatDetail) {
            initChatUI(chatDetail, { globalState, otherId, activeId, contact });
        }
    } catch (e) {
        console.warn('聊天UI组件初始化失败，不影响核心功能', e);
    }


    // ★ 滚动到底部
    const msgContainer = container.querySelector('#chatMessages');
    if (msgContainer) {
        msgContainer.scrollTop = msgContainer.scrollHeight;
    }

    //     // 加图片后的版本
    // const msgContainer = container.querySelector('#chatMessages');
    // if (msgContainer) {
    //     // 直接滚到底部，不闪动
    //     msgContainer.scrollTop = msgContainer.scrollHeight;

    //     // 监听尺寸变化（图片加载后自动补滚）
    //     const resizeObserver = new ResizeObserver(() => {
    //         msgContainer.scrollTop = msgContainer.scrollHeight;
    //     });
    //     resizeObserver.observe(msgContainer);

    //     // 页面离开时断开监听，防止内存泄漏
    //     window.addEventListener('beforeunload', () => resizeObserver.disconnect(), { once: true });
    // }


}

// ---- 主动提取记忆 ----
async function extractMemoriesForActiveChar(activeId, otherId, otherName, allMessages) {
    try {
        const recentMessages = allMessages.slice(-20);
        if (recentMessages.length === 0) return;

        const convText = recentMessages.map(m => {
            const displayName = m.senderId === activeId ? '我' : (otherName || m.senderDisplayName || m.senderId);
            return `${displayName}：${m.text}`;
        }).join('\n');

        // ★ 读取主视角已有的记忆列表，拼接到对话文本后面
        let fullContext = '【对话文本】\n' + convText;
        try {
            // 角色信息
            let charInfo = '';
            const roleData = localStorage.getItem('rolebook_characters');
            if (roleData) {
                const characters = JSON.parse(roleData);
                const me = characters.find(c => c.id === activeId);
                if (me && me.base) {
                    charInfo = '【我的角色信息】\n' +
                        `名称：${me.base.name || '未知'}\n` +
                        `性格描述：${me.base.desc || '无'}\n` +
                        `说话风格：${me.base.style || '无'}\n` +
                        `内心秘密：${me.base.secret || '无'}`;
                }
            }
            if (charInfo) {
                fullContext = charInfo + '\n\n' + fullContext;
            }

            const store = new CharacterStore(activeId);
            const existingMemories = store.getMemories();
            if (existingMemories.length > 0) {
                fullContext += '\n\n【我已有的记忆】\n' + existingMemories.map(m => `- ${m.content}`).join('\n');
            }
        } catch (e) { /* 忽略 */ }

        const activeCharName = getCharacterNameById(activeId) || '我';
        const { systemPrompt, assistantContext } = buildMemoryExtractPrompt(otherName, fullContext, activeCharName);
        const reply = await callAIForMemoryExtract({
            systemPrompt,
            assistantContext
        });

        let memories;
        try {
            memories = JSON.parse(reply);
        } catch {
            const match = reply.match(/\[[\s\S]*?\]/);
            if (match) memories = JSON.parse(match[0]);
            else return;
        }

        if (!Array.isArray(memories) || memories.length === 0) return;

        const store = new CharacterStore(activeId);
        memories.forEach(m => {
            store.addMemory({
                id: 'mem_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
                time: new Date().toLocaleString('zh-CN'),
                content: m.content,
                source: 'auto_extract'
            });
        });
    } catch (e) {
        console.warn('记忆提取失败:', e);
    }
}


export function handleBack(container, { memoryService, globalState }) {
    if (!activeChatId) return false;
    // ★ 离开聊天时，检查是否需要提取记忆
    const activeId = getActiveCharacterId(globalState);
    if (activePairKey && localStorage.getItem('auto_extract_memory_' + activeId) !== 'false') {
        const stats = conversationStats[activePairKey];
        if (stats && stats.totalApiCalls > stats.lastExtractCount) {
            const messages = getOrCreateMessages(activePairKey);
            const ids = activePairKey.split('||');
            const otherId = ids[0] === activeId ? ids[1] : ids[0];
            const contact = getContactInfo(otherId);
            extractMemoriesForActiveChar(activeId, otherId, contact.name, messages);
            stats.lastExtractCount = stats.totalApiCalls;
            localStorage.setItem(STATS_KEY, JSON.stringify(conversationStats));
        }
    }

    activeChatId = null;
    activePairKey = null;
    const appContainer = container.closest('.screen-page') || container;

    // ★ 根据当前是哪个 tab，返回对应的页面
    if (activePage === 'contacts') {
        appContainer.querySelector('.chat-app-shell').innerHTML = renderContactsPage(globalState);
    } else {
        appContainer.querySelector('.chat-app-shell').innerHTML = renderChatsPage(globalState);
    }
    // ★ 返回列表时清除详情标记
    appContainer.querySelector('.screen-content.chat-shell')?.classList.remove('chat-in-detail');

    bindPageInteractions(appContainer, memoryService, globalState);
    const tabBar = appContainer.querySelector('.chat-tab-bar');
    if (tabBar) tabBar.style.display = '';
    return true;
}



if (!window.__moduleRegistry) window.__moduleRegistry = [];
window.__moduleRegistry.push({ id, label, icon, color, render, bindEvents, handleBack });

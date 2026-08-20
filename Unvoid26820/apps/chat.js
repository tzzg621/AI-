// apps/chat.js — 聊天模块
import { CharacterStore, getActiveCharacterId, addBidirectionalFriend } from '../store/CharacterStore.js';
import { getCharacterId, getCharacterNameById } from './characterManager.js';
import { buildPrompt, buildMemoryExtractPrompt } from './promptBuilder.js';
import { callAI, callAIForMemoryExtract } from './aiService.js';
import { getAvatarHtml, setImage, clearImageCache, setImageFromGallery, setCropParams, getImageDataUrl, getImageHtml } from '../store/ImageCache.js';
import { showCropEditor, showConfirm } from '../store/dialog.js';
import { initChatUI } from './chat/chatUI.js';
import { esc } from '../store/utils.js';
import { isArchived } from './roleData.js';


// ---- Toast 通知 ----
function showToast(msg, color = '#333') {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:${color};color:#fff;padding:10px 20px;border-radius:12px;z-index:10000;font-size:13px;box-shadow:0 4px 20px rgba(0,0,0,0.2);max-width:80%;text-align:center;`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
}

// ---- 推荐好友名片 ----
function resolveCardNameToId(name, senderId) {
    if (!name) return null;
    try {
        const store = new CharacterStore(senderId);
        for (const fid of store.getFriendIds()) {
            if (getCharacterNameById(fid) === name && !isArchived(fid)) return fid;
        }
    } catch { }
    return null;
}

// 把一段文本拆成「文本段 / 名片段」；名片名不匹配 → 直接丢弃（剥离）
function splitMessageText(text, senderId, pairKey) {
    const parts = [];
    let last = 0;
    const re = /【名片:(.+?)】|【接受好友:(.+?)】/g;
    let m;
    while ((m = re.exec(text))) {
        const before = text.slice(last, m.index);
        if (before.trim()) parts.push({ type: 'text', text: before });

        if (m[1] !== undefined) {
            // 【名片:名字】→ 名片块
            const id = resolveCardNameToId(m[1].trim(), senderId);
            if (id) {
                addFriendCard(pairKey, m[1].trim(), id, senderId);
                parts.push({ type: 'card', id, name: m[1].trim() });
            }
        } else if (m[2] !== undefined) {
            // 【接受好友:名字】→ 独立提示块（查对话名片记录，查不到剥离）
            const card = getFriendCards(pairKey).find(c => c.name === m[2].trim());
            if (card) parts.push({ type: 'accept', id: card.id, name: m[2].trim() });
        }
        last = m.index + m[0].length;
    }
    const after = text.slice(last);
    if (after.trim()) parts.push({ type: 'text', text: after });
    return parts;
}

// 独立名片卡（无气泡，白底圆角，靠发送方一侧）
function friendCardBlockHtml(id, name, senderId) {
    return `<div class="friend-card" data-friend-id="${esc(id)}" data-sender-id="${esc(senderId)}"
             style="display:flex;align-items:center;gap:10px;background:white;border:1px solid #e0e0e0;
                    border-radius:14px;padding:10px 12px;width:200px;cursor:pointer;margin:6px 0;
                    box-shadow:0 1px 6px rgba(0,0,0,0.08);">
        <div style="width:40px;height:40px;border-radius:50%;overflow:hidden;flex-shrink:0;">${getAvatarHtml(id)}</div>
        <div style="flex:1;min-width:0;">
            <div style="font-size:14px;font-weight:600;">${esc(name)}</div>
            <div style="font-size:11px;color:#999;">个人名片 · 点击查看</div>
        </div>
        <span style="color:#0b93f6;font-size:12px;flex-shrink:0;">查看 ➤</span>
    </div>`;
}

// 接受好友提示块（独立成行，绿色小条，不带气泡）
function acceptFriendBlockHtml(name) {
    return `<div style="display:inline-flex;align-items:center;gap:6px;background:#e8f5e9;color:#2e7d32;
                        border:1px solid #c8e6c9;border-radius:14px;padding:8px 12px;margin:6px 0;font-size:13px;">
        🤝 已添加 ${esc(name)} 为好友
    </div>`;
}

// 统一渲染：文本段→气泡，名片段→独立名片块
function renderMsgContent(text, senderId, isMe, pairKey) {
    const sentences = (text || '').split('|').map(s => s.trim()).filter(s => s);
    return sentences.flatMap(sentence =>
        splitMessageText(sentence, senderId, pairKey).map(p =>
            p.type === 'card'
                ? friendCardBlockHtml(p.id, p.name, senderId)
                : p.type === 'accept'
                    ? acceptFriendBlockHtml(p.name)
                    : `<div class="msg-bubble ${isMe ? 'me' : 'other'}">${esc(p.text)}</div>`
        )
    ).join('');
}

// ---- 对话级名片记录：名字+id 只存在该角色对的对话里 ----
const CARDS_KEY = 'chat_friend_cards';

export function getFriendCards(pairKey) {
    try { return JSON.parse(localStorage.getItem(CARDS_KEY) || '{}')[pairKey] || []; }
    catch { return []; }
}

// 登记（按 id 去重：重复推荐只更新时间/名字，不新增）
function addFriendCard(pairKey, name, id, senderId) {
    try {
        const all = JSON.parse(localStorage.getItem(CARDS_KEY) || '{}');
        const list = all[pairKey] || [];
        const idx = list.findIndex(c => c.id === id);
        const entry = { name, id, senderId, ts: Date.now() };
        if (idx !== -1) list[idx] = entry; else list.unshift(entry);
        all[pairKey] = list;
        localStorage.setItem(CARDS_KEY, JSON.stringify(all));
    } catch { }
}

// 处理【接受好友:名字】：从当前对话的名片记录按名字查 id，执行加好友
function processFriendRequest(text, otherId, pairKey) {
    const otherName = getCharacterNameById(otherId) || otherId;
    return text.replace(/【接受好友:(.+?)】/g, (whole, name) => {
        const card = getFriendCards(pairKey).find(c => c.name === name.trim());
        if (card && !isArchived(card.id)) {
            const already = new CharacterStore(otherId).isFriend(card.id);
            if (!already) {
                addBidirectionalFriend(otherId, card.id);
                showToast(`🤝 ${otherName} 已添加 ${name.trim()} 为好友`, '#2e7d32');
            } else {
                showToast(`ℹ️ ${otherName} 与 ${name.trim()} 已是好友`, '#999');
            }
            return `🤝 已添加 ${name.trim()} 为好友`;
        }
        return '';
    });
}


// 名片详情弹窗：点击名片弹出，弹窗内点击才真正添加好友
export function showFriendCard(friendId, senderId, activeId) {
    let info = { name: friendId, desc: '' };
    try {
        const f = JSON.parse(localStorage.getItem('rolebook_characters') || '[]').find(c => c.id === friendId);
        if (f?.base) info = { name: f.base.name || friendId, desc: f.base.desc || '' };
    } catch { }
    if (!info.name || info.name === friendId) {
        try {
            const f = JSON.parse(localStorage.getItem('worldnet_extra_characters') || '[]').find(c => c.id === friendId);
            if (f?.base) info = { name: f.base.name || friendId, desc: f.base.desc || '' };
        } catch { }
    }
    try { if (new CharacterStore(friendId).getInfo().name) info.name = new CharacterStore(friendId).getInfo().name; } catch { }

    let relationText = '';
    try {
        const rel = new CharacterStore(senderId).getRelationById(friendId);
        if (rel?.relation) relationText = `推荐人说：${rel.relation}`;
    } catch { }

    const isAlreadyFriend = new CharacterStore(activeId).isFriend(friendId);

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:400;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
        <div style="background:white;border-radius:20px;width:280px;padding:20px;text-align:center;">
            <div style="width:64px;height:64px;border-radius:50%;overflow:hidden;margin:0 auto 8px;">
                ${getAvatarHtml(friendId, '?')}
            </div>
            <div style="font-size:18px;font-weight:700;">${esc(info.name)}</div>
            ${info.desc ? `<div style="font-size:13px;color:#666;margin-top:6px;">${esc(info.desc)}</div>` : ''}
            ${relationText ? `<div style="font-size:12px;color:#7c4dff;margin-top:8px;">${esc(relationText)}</div>` : ''}
            <div style="display:flex;gap:8px;margin-top:16px;">
                <button id="friendCardAddBtn" style="flex:1;padding:10px;border:none;border-radius:12px;cursor:pointer;font-size:14px;
                    ${isAlreadyFriend ? 'background:#f0f0f0;color:#999;cursor:not-allowed;' : 'background:#0b93f6;color:white;'}">
                    ${isAlreadyFriend ? '✅ 已是好友' : '➕ 添加为联系人'}
                </button>
                <button id="friendCardCloseBtn" style="flex:1;padding:10px;border:1px solid #ccc;background:white;color:#666;border-radius:12px;cursor:pointer;font-size:14px;">关闭</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('#friendCardCloseBtn').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    if (!isAlreadyFriend) {
        overlay.querySelector('#friendCardAddBtn').addEventListener('click', () => {
            addBidirectionalFriend(activeId, friendId);
            const btn = overlay.querySelector('#friendCardAddBtn');
            btn.textContent = '✅ 已是好友';
            btn.style.background = '#f0f0f0';
            btn.style.color = '#999';
            btn.disabled = true;
            showToast(`✅ 已添加 ${info.name} 为联系人`, '#2e7d32');
        });
    }
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
    // ★ 从世界角色网络读取 NPC 数据（和名册角色一样走缓存）
    try {
        const worldData = localStorage.getItem('worldnet_extra_characters');
        if (worldData) {
            const worldNpcs = JSON.parse(worldData);
            worldNpcs.forEach(npc => {
                if (npc.base?.name && !result.some(c => c.id === npc.id)) {
                    result.push({
                        id: npc.id,
                        name: npc.base.name,
                        avatar: npc.base.emoji || '💬',
                        note: npc.base.desc || '',
                        isCharacter: true
                    });
                }
            });
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

// ★ 聊天上下文（供模块级监听函数使用）
let _chatCtx = { memoryService: null, globalState: null };

// ★ 进入编辑模式
function __onEditMessages(e) {
    const { pairKey } = e.detail || {};
    if (!pairKey) return;
    chatEditMode = true;
    const { memoryService, globalState } = _chatCtx;
    const shell = document.querySelector('.chat-app-shell');
    if (shell && activePairKey === pairKey) {
        shell.innerHTML = renderChatDetail(activePairKey, activeChatId, globalState);
        const appContainer = shell.closest('.screen-page') || document.body;
        bindChatDetailEvents(appContainer, activePairKey, activeChatId, memoryService, globalState);
    }
}

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

// ---- 聊天模式切换：单一全局监听器（防止每次绑定累积泄漏） ----
let _chatToggleOtherId = null;
let _toggleHandler = null;


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

let chatMessagesMap = {};

// ★ DataSync 就绪后一次性装载（模块加载时 hook 未装，直接读会拿到空）
window.addEventListener('datasync-ready', () => {
    chatMessagesMap = loadChatMessages();
});

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
    // ★ 找不到时用 getCharacterNameById 兜底（会查归档表的名字快照）
    return all.find(c => c.id === id) || { name: getCharacterNameById(id), avatar: '?' };
}

/**
 * ★ 通用对外接口：向角色对注入一条消息，可选触发对方 AI 回复（真实聊天逻辑）
 * 供任何外部模块（模拟小城等）从外部引入聊天使用
 * @param {string} activeId  - 发起方角色 id
 * @param {string} otherId   - 对方角色 id
 * @param {object} message   - { senderId, senderDisplayName, text }
 * @param {object} [options]
 * @param {boolean} [options.reply=false] - 是否触发对方 AI 回复
 * @param {string} [options.replyHint=''] - 追加到 systemPrompt 的提示（模块自定义）
 * @returns {Promise<{ reply: string|null }>}
 */
export async function injectChatMessage(activeId, otherId, message, options = {}) {
    const pairKey = getPairKey(activeId, otherId);
    const messages = getOrCreateMessages(pairKey);
    const activeName = message.senderDisplayName || getCharacterNameById(activeId) || activeId;
    const otherName = getCharacterNameById(otherId) || otherId;

    // ① 注入消息入真实聊天历史（内存 + 落库，打开即见）
    messages.push({ senderId: message.senderId || activeId, senderDisplayName: activeName, text: message.text });
    saveChatMessages(chatMessagesMap);

    if (!options.reply) return { reply: null };

    // ② 对方角色数据（rolebook → worldnet → CharacterStore）
    let characterData = null;
    try {
        characterData = JSON.parse(localStorage.getItem('rolebook_characters') || '[]').find(c => c.id === otherId) || null;
        if (!characterData) characterData = JSON.parse(localStorage.getItem('worldnet_extra_characters') || '[]').find(c => c.id === otherId) || null;
        if (!characterData) { const info = new CharacterStore(otherId).getInfo(); if (info) characterData = { base: info }; }
    } catch (e) { }

    // ③ 真实 prompt（含记忆/关系）+ 模块自定义提示
    const { systemPrompt, assistantContext } = buildPrompt({
        character: characterData, characterId: otherId, messages: messages.slice(-50),
        aiRoleName: otherName, targetId: activeId, targetName: activeName,
        autoMemory: localStorage.getItem('auto_memory_' + otherId) === 'true'
    });

    let reply = '';
    try {
        const aiResult = await callAI({
            systemPrompt: systemPrompt + (options.replyHint ? '\n\n' + options.replyHint : ''),
            assistantContext, maxTokens: options.maxTokens || 4096
        });
        reply = (aiResult?.content || aiResult || '').trim();
    } catch (e) { reply = `⚠️ ${e.message}`; }
    const displayReply = reply.replace(/【(记忆|修改记忆|删除记忆)】.+?(?=\n|$)/g, '').trim();

    // ④ 回复入同一角色对历史
    messages.push({ senderId: otherId, senderDisplayName: otherName, text: displayReply });
    saveChatMessages(chatMessagesMap);
    return { reply: displayReply };
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
                const previewText = (lastMsg.text || '').split('|').pop().trim();
                preview = `${senderName}：${previewText}`;
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
                                <span class="chat-name">${esc(item.name)}</span>
                                <span class="chat-status">${item.status}</span>
                            </div>
                            <div class="chat-preview">${esc(item.preview)}</div>
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

    // 312-316 行，改成：
    // ★ 合并好友 + 聊过天的人（去重）
    const contactIds = new Set([...friendIds, ...chattedIds]);
    const contacts = allContacts.filter(c => contactIds.has(c.id) && !isArchived(c.id));         // ← 正常联系人
    const archivedContacts = allContacts.filter(c => contactIds.has(c.id) && isArchived(c.id));  // ← 归档联系人
    return `
        <div class="contacts-section">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                <span style="font-weight:600;">联系人（${contacts.length}）</span>
                <button id="addFriendBtn" style="padding:6px 14px; border-radius:16px; border:none; 
                        background:#ccc; color:#888; cursor:not-allowed; font-size:12px;">
                    ➕ 添加好友（功能开发中）
                </button>
            </div>
            ${archivedContacts.length ? `
    <div style="display:flex; justify-content:space-between; align-items:center; margin:16px 0 8px;">
        <span style="font-weight:600; color:#999;">📦 已归档（${archivedContacts.length}）</span>
    </div>
    <div class="contacts-list">
        ${archivedContacts.map((item) => `
            <div class="contact-card" style="display:flex; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid #eee; opacity:0.6;">
                <div style="width:36px; height:36px; border-radius:50%; overflow:hidden; flex-shrink:0; background:#e0e0e0; display:flex; align-items:center; justify-content:center; font-size:16px;">${getAvatarHtml(item.id, '?')}</div>
                <div style="flex:1; min-width:0;">
                    <div class="contact-name" style="font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(item.name)}</div>
                    <div style="font-size:12px; color:#aaa;">已归档 · 可查看历史</div>
                </div>
                <button class="start-chat-btn" data-contact-id="${item.id}" style="padding:6px 14px; border-radius:16px; border:none; background:#bbb; color:white; cursor:pointer; font-size:12px;">📦 查看</button>
            </div>
        `).join('')}
    </div>
` : ''}
            
            <div class="contacts-list">
                ${contacts.length === 0 ? '<p style="text-align:center; padding:20px; color:#888;">暂无联系人</p>' : ''}
                ${contacts.map((item) => `
<div class="contact-card" style="display:flex; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid #eee;">
    <div class="contact-avatar-wrapper" data-contact-id="${item.id}" style="width:36px; height:36px; border-radius:50%; overflow:hidden; flex-shrink:0; background:#e0e0e0; cursor:pointer; position:relative;">
        ${getAvatarHtml(item.id, '?')}
        <div style="position:absolute; bottom:0; left:0; right:0; background:rgba(0,0,0,0.4); color:white; font-size:10px; text-align:center; padding:2px 0; opacity:0; transition:opacity 0.2s;">更换</div>
    </div>
                        <div style="flex:1; min-width:0;">
                            <div class="contact-name" style="font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(item.name)}</div>
                            <div class="contact-note" style="font-size:13px; color:#888;">${esc(item.note) || ''}</div>
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
                <div style="display:flex;align-items:center;justify-content:space-between;">
    <div class="discover-title">朋友圈</div>
    <button id="momentsEntryBtn" style="border:none;background:#0b93f6;color:#fff;border-radius:16px;padding:5px 12px;font-size:12px;cursor:pointer;">进入 ›</button>
</div>
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
                    <button class="discover-action" id="shakeEntryBtn">摇一摇</button>
                    <button class="discover-action" id="gameEntryBtn">游戏</button>
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
                    <div class="profile-name" style="font-size:20px; font-weight:600;">${esc(chara.base.name)}</div>
                    <div class="profile-desc" style="font-size:13px; color:#666; margin-top:4px;">${esc(chara.base.desc)}</div>
                </div>
            </div>
            <div style="margin-top:12px; background:#fff3e0; border-radius:12px; padding:12px;">
                <div style="font-weight:600; margin-bottom:4px;">🔒 内心秘密</div>
                <div style="font-size:14px; color:#e65100;">${esc(chara.base.secret) || '无'}</div>
            </div>
            <div style="margin-top:8px; background:#e3f2fd; border-radius:12px; padding:12px;">
                <div style="font-weight:600; margin-bottom:4px;">📜 独立记忆</div>
                ${(chara.base.memories || []).map(m => `
                    <div style="padding:4px 0; font-size:13px; color:#1565c0;">
                        <span style="font-size:11px;">${esc(m.time)}</span>
                        <div>${esc(m.content)}</div>
                    </div>
                `).join('') || '<div style="font-size:13px; color:#888;">暂无记忆</div>'}
            </div>
            
<div style="margin-top:8px; background:#f3e5f5; border-radius:12px; padding:12px;">
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
        <div style="font-weight:600;">🌐 关系网</div>
        <button id="editRelationsBtn" style="padding:3px 10px; border-radius:8px; border:1px solid #ce93d8; background:white; color:#8e24aa; cursor:pointer; font-size:11px;">编辑</button>
    </div>
    ${(() => {
            const store = new CharacterStore(chara.id);
            const rels = store.getRelations();
            if (rels.length === 0) return '<div style="font-size:13px; color:#888;">(无)</div>';
            return rels.map(r => `
            <div style="margin-bottom:6px; padding:6px 8px; background:rgba(255,255,255,0.5); border-radius:8px;">
    <div style="font-size:13px; font-weight:600; color:#333;">${esc(r.relation || '未知')} · ${esc(r.name)}</div>
    <div style="font-size:12px; color:#666; margin-top:2px; line-height:1.4;">${esc(r.perspective || '(无看法)')}</div>
    ${r.attitudes?.length ? `
        <div style="display:flex; gap:4px; margin-top:4px; flex-wrap:wrap;">
            ${r.attitudes.map(a => `
                <span style="font-size:11px; padding:2px 8px; background:#e1bee7; border-radius:10px; color:#7b1fa2;">
                    ${esc(a)}
                </span>
            `).join('')}
        </div>
    ` : ''}
</div>

        `).join('');
        })()}
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

let chatEditMode = false;   // ★ 编辑模式状态

function renderChatDetail(pairKey, otherId, globalState) {
    const messages = getOrCreateMessages(pairKey);
    const contact = getContactInfo(otherId);
    const activeChar = globalState?.activeCharacter;
    const activeId = getActiveCharacterId(globalState);
    const archivedContact = isArchived(otherId);

    return `
        <div class="chat-detail">
            <div class="chat-detail-header">
                <div class="chat-detail-title">${esc(contact.name)}</div>
                <div class="header-spacer"></div>
                <button id="autoMemoryToggle" class="btn-sm" style="
                    background:${localStorage.getItem('auto_memory_' + otherId) === 'true' ? '#4CAF50' : '#ccc'};
                    margin-right:8px;
                ">${localStorage.getItem('auto_memory_' + otherId) === 'true' ? '🧠' : '🧠 off'}</button>
                <button id="extractMemoryBtn" class="btn-sm" style="background:#ff9800;margin-right:4px;">📝 提取记忆</button>
                ${chatEditMode ? `<button id="editDoneBtn" class="btn-sm" style="background:#2c2c2c;margin-right:4px;">完成</button>` : ''}

            </div>
            <div class="chat-messages" id="chatMessages">
${messages.map((msg, msgIndex) => {
        const isMe = msg.senderId === activeId;
        const bubbleHtml = renderMsgContent(msg.text, msg.senderId, isMe, pairKey);
        const delBtn = chatEditMode
            ? `<button class="msg-delete-btn" data-msg-index="${msgIndex}" style="
            position:absolute; top:6px; ${isMe ? 'left:6px' : 'right:6px'}; z-index:5;
            width:22px; height:22px; border-radius:50%; border:none;
            background:#e53935; color:white; font-size:12px; cursor:pointer;
            line-height:22px; padding:0;
        ">✕</button>` : '';
        if (isMe) {
            return `<div class="msg-row me" style="position:relative;">
    ${delBtn}
    <div style="min-width:0;">
        ${bubbleHtml}
    </div>
    <div class="msg-avatar">${getAvatarHtml(msg.senderId)}</div>
</div>`;
        } else {
            return `<div class="msg-row other" style="position:relative;">
    ${delBtn}
    <div class="msg-avatar">${getAvatarHtml(msg.senderId)}</div>
    <div style="min-width:0;">
        ${bubbleHtml}
    </div>
</div>`;
        }
    }).join('')}
            </div>
<!-- 改成 -->
<div class="chat-input-area">
        <input type="text" id="chatInput" placeholder="输入消息..."
   autocomplete="one-time-code" inputmode="text" name="chat_msg_${pairKey}">
        <button id="chatSendBtn">➤</button>
    <button id="chatSendAiBtn" style="
        display:none; background:#0b93f6; color:white; border:none;
        border-radius:50%; width:36px; height:36px; cursor:pointer;
        font-size:16px; flex-shrink:0;
    " title="请求 AI 回复">⚡</button>
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
当前扮演：${esc(globalState.activeCharacter.base.name)}
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

// ★ 头像刷新回调（单独定义，供 add/removeEventListener 复用同一引用）
function __refreshChatAvatars(e) {
    const { charId, type } = e.detail || {};
    if (!charId) return;
    const selector = `[data-char-id="${charId}"][data-img-type="${type}"]`;
    document.querySelectorAll(selector).forEach(el => {
        const isRound = el.style.borderRadius === '50%';
        el.outerHTML = getImageHtml(charId, type, { round: isRound });
    });
}


export function bindEvents(container, { memoryService, globalState }) {
    _chatCtx = { memoryService, globalState };   // ★ 保存上下文

    // ★ 监听进入编辑模式（先移除再添加，避免累积）
    window.removeEventListener('chat-edit-messages', __onEditMessages);
    window.addEventListener('chat-edit-messages', __onEditMessages);

    bindTabButtons(container, memoryService, globalState);
    bindPageInteractions(container, memoryService, globalState);

    // ★ 监听头像加载完成，自动刷新显示（先移除旧监听，确保唯一）
    window.removeEventListener('image-loaded', __refreshChatAvatars);
    window.addEventListener('image-loaded', __refreshChatAvatars);
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

        // ★ 编辑关系网
        container.querySelector('#editRelationsBtn')?.addEventListener('click', () => {
            const chara = globalState?.activeCharacter;
            if (!chara) { showToast('请先在角色名册中设置主视角角色'); return; }
            showRelationEditor(chara, () => {
                const appContainer = container.closest('.screen-page') || container;
                appContainer.innerHTML = render({ globalState });
                bindEvents(appContainer, { memoryService, globalState });
            });
        });

    }

    // ★ 发现页：朋友圈入口
    if (activePage === 'discover') {
        container.querySelector('#momentsEntryBtn')?.addEventListener('click', () => {
            import('./chat/moments.js').then(m => m.showMomentsViewer(globalState));
        });

        // ★ 发现页：游戏入口
        container.querySelector('#gameEntryBtn')?.addEventListener('click', () => {
            import('./games/gameCenter.js').then(m => m.openGameCenter(globalState));
        });

        // ★ 发现页：摇一摇（匿名匹配聊天）
        container.querySelector('#shakeEntryBtn')?.addEventListener('click', () => {
            const overlay = document.createElement('div');
            (document.querySelector('.phone-screen') || document.body).appendChild(overlay);
            import('./chat/shakeMatch.js').then(m => m.start(overlay, globalState, () => overlay.remove()));
        });

    }
}

// ★ 关系网编辑弹窗
function showRelationEditor(chara, onSave) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:300;display:flex;align-items:center;justify-content:center;';

    const store = new CharacterStore(chara.id);
    const rels = store.getRelations();

    overlay.innerHTML = `
        <div style="background:white; border-radius:20px; width:300px; max-height:70vh; overflow-y:auto; padding:20px;">
            <div style="font-weight:600; font-size:16px; margin-bottom:12px;">🌐 编辑关系网</div>
            <div id="relationList">
                ${rels.map((r, i) => `
                    <div style="margin-bottom:10px; padding:8px; background:#f5f5f5; border-radius:10px;">
                        <div style="display:flex; gap:4px; margin-bottom:4px;">
                            <input id="rel-name-${i}" value="${esc(r.name)}" placeholder="对方名字"
                                   style="flex:1; border:1px solid #ccc; border-radius:6px; padding:5px 8px; font-size:12px;">
                            <input id="rel-def-${i}" value="${esc(r.relation)}" placeholder="关系定义（如：挚友）"
                                   style="flex:1; border:1px solid #ccc; border-radius:6px; padding:5px 8px; font-size:12px;">
                            <button class="del-rel-btn" data-index="${i}"
                                    style="padding:4px 8px; border:none; background:#e53935; color:white; border-radius:6px; cursor:pointer; font-size:11px;">✕</button>
                        </div>
                        <textarea id="rel-persp-${i}" rows="2" placeholder="你的看法（可选）"
                                  style="width:100%; border:1px solid #ccc; border-radius:6px; padding:5px 8px; font-size:12px; resize:vertical; box-sizing:border-box; font-family:inherit;">${esc(r.perspective) || ''}</textarea>
                                  <input id="rel-attitudes-${i}" value="${esc((r.attitudes || []).join('、'))}" 
       placeholder="倾向标签（用、隔开）"
       style="width:100%; border:1px solid #ccc; border-radius:6px; padding:5px 8px; font-size:12px; margin-top:4px; box-sizing:border-box;">

                    </div>
                `).join('')}
            </div>
            <button id="addRelInEditor" style="width:100%; padding:6px; border:1px dashed #8e24aa; border-radius:8px; background:white; color:#8e24aa; cursor:pointer; font-size:12px; margin-bottom:10px;">➕ 添加关系</button>
            <div style="display:flex; gap:8px;">
                <button id="saveRelBtn" style="flex:1; padding:8px; border:none; background:#8e24aa; color:white; border-radius:10px; cursor:pointer; font-size:13px;">✅ 保存</button>
                <button id="cancelRelBtn" style="flex:1; padding:8px; border:1px solid #ccc; background:white; color:#666; border-radius:10px; cursor:pointer; font-size:13px;">取消</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    // 添加关系
    overlay.querySelector('#addRelInEditor').addEventListener('click', () => {
        const list = overlay.querySelector('#relationList');
        const i = list.children.length;
        const div = document.createElement('div');
        div.style.cssText = 'margin-bottom:10px; padding:8px; background:#f5f5f5; border-radius:10px;';
        div.innerHTML = `
            <div style="display:flex; gap:4px; margin-bottom:4px;">
                <input id="rel-name-${i}" placeholder="对方名字"
                       style="flex:1; border:1px solid #ccc; border-radius:6px; padding:5px 8px; font-size:12px;">
                <input id="rel-def-${i}" placeholder="关系定义（如：挚友）"
                       style="flex:1; border:1px solid #ccc; border-radius:6px; padding:5px 8px; font-size:12px;">
                <button class="del-rel-btn" data-index="${i}"
                        style="padding:4px 8px; border:none; background:#e53935; color:white; border-radius:6px; cursor:pointer; font-size:11px;">✕</button>
            </div>
            <textarea id="rel-persp-${i}" rows="2" placeholder="你的看法（可选）"
                      style="width:100%; border:1px solid #ccc; border-radius:6px; padding:5px 8px; font-size:12px; resize:vertical; box-sizing:border-box; font-family:inherit;"></textarea>
        `;
        list.appendChild(div);
    });

    // 删除（事件委托）
    overlay.addEventListener('click', (e) => {
        const delBtn = e.target.closest('.del-rel-btn');
        if (!delBtn) return;
        const item = delBtn.closest('div[style*="margin-bottom:10px"]');
        if (item) item.remove();
    });

    overlay.querySelector('#cancelRelBtn').addEventListener('click', () => overlay.remove());

    overlay.querySelector('#saveRelBtn').addEventListener('click', () => {
        const newRels = [];
        const items = overlay.querySelector('#relationList').children;
        for (let i = 0; i < items.length; i++) {
            const name = items[i].querySelector('[id^="rel-name-"]')?.value.trim();
            const def = items[i].querySelector('[id^="rel-def-"]')?.value.trim();
            const persp = items[i].querySelector('[id^="rel-persp-"]')?.value.trim();
            const attInput = items[i].querySelector('[id^="rel-attitudes-"]');
            const attitudes = attInput?.value.split('、').map(s => s.trim()).filter(Boolean);
            if (name && def) {
                const entry = { name, relation: def, perspective: persp || '' };
                if (attitudes?.length > 0) entry.attitudes = attitudes;
                newRels.push(entry);
            }
        }

        const store = new CharacterStore(chara.id);
        store.setRelations(newRels);

        overlay.remove();
        showToast('✅ 关系网已更新');
        if (onSave) onSave();
    });
}


function bindChatDetailEvents(container, pairKey, otherId, memoryService, globalState) {
    chatEditMode = false;   // ★ 每次进入聊天详情都重置编辑模式
    const chatInput = container.querySelector('#chatInput');
    const chatSendBtn = container.querySelector('#chatSendBtn');
    const chatMessages = container.querySelector('#chatMessages');
    // ★ 名片卡片点击 → 弹出名片详情
    chatMessages?.addEventListener('click', (e) => {
        const card = e.target.closest('.friend-card');
        if (!card) return;
        showFriendCard(card.dataset.friendId, card.dataset.senderId, activeId);
    });
    const contact = getContactInfo(otherId);

    const activeChar = globalState?.activeCharacter;
    const activeId = getActiveCharacterId(globalState);
    // const charName = activeChar ? `${activeChar.base.emoji} ${activeChar?.base?.name}` : '我';

    // ── 函数 A：只发用户消息 ──
    function sendChat() {
        const text = chatInput.value.trim();
        if (!text) return;

        const userMsg = document.createElement('div');
        userMsg.className = 'msg user';
        const userDisplayName = activeChar ? activeChar.base.name : '我';
        const otherDisplayName = contact.name;
        const aiRoleName = contact.name;

        userMsg.innerHTML = `
    <div class="msg-row me">
        <div style="min-width:0;">
            ${renderMsgContent(text, activeId, true, pairKey)}
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

        chatMessages.scrollTop = chatMessages.scrollHeight;

        // ★ 自动模式才调 AI
        if (!manualMode) {
            callAIAndRenderReply();
        }
    }

    // ── 函数 B：AI 调用 + 渲染回复 ──
    async function callAIAndRenderReply() {
        if (isArchived(otherId)) return;   // ★ 归档角色：所有 AI 调用直接短路
        const otherDisplayName = contact.name;
        const aiRoleName = contact.name;

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

            // ★ 预处理关系网：只有当前对话对象的看法才保留
            const processedCharacterData = characterData ? {
                ...characterData,
                extended: {
                    relations: (() => {
                        const store = new CharacterStore(characterData.id);
                        const allRelations = store.getRelations();
                        const activeCharName = globalState?.activeCharacter?.base?.name;
                        return allRelations.map(r => {
                            if (activeCharName && r.name === activeCharName) {
                                return r;  // 当前对话对象：完整数据（含看法）
                            }
                            // 其他角色：保留定位 + 态度标签，只过滤看法
                            const filtered = { name: r.name, relation: r.relation };
                            if (r.attitudes?.length > 0) filtered.attitudes = r.attitudes;
                            return filtered;
                        });
                    })()
                }
            } : characterData;

            const activeDisplayName = globalState?.activeCharacter?.base?.name || '我';
            const { systemPrompt, assistantContext } = buildPrompt({
                character: processedCharacterData,
                characterId: otherId,
                messages: allMessages.slice(-50),
                aiRoleName: aiRoleName,
                targetId: activeId,
                targetName: activeDisplayName,
                autoMemory: localStorage.getItem('auto_memory_' + otherId) === 'true'
            });

            console.log('📝 systemPrompt:', systemPrompt);
            console.log('📝 assistantContext:', assistantContext);

            let reply;
            let reasoningContent = '';
            try {
                const aiResult = await callAI({
                    systemPrompt,
                    assistantContext,
                    maxTokens: 4096
                });
                reply = aiResult.content || aiResult;
                reasoningContent = aiResult.reasoningContent;
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
                });
                // ★ 关系网解析
                const relMatch = reply.match(/【关系】(.+?)\s*→\s*(.+)/);
                if (relMatch) {
                    const displayName = relMatch[1].trim();
                    const newRelation = relMatch[2].trim();
                    reply = reply.replace(/【关系】.+/, '').trim();
                    const store = new CharacterStore(characterData.id);
                    store.updateRelation(displayName, newRelation, undefined, activeId);
                }
                // ★ 态度标签解析
                const attMatch = reply.match(/【态度】(.+?)\s*→\s*(.+)/);
                if (attMatch) {
                    const attDisplayName = attMatch[1].trim();
                    const newAttitude = attMatch[2].trim();
                    reply = reply.replace(/【态度】.+/, '').trim();
                    const store = new CharacterStore(characterData.id);
                    const rels = store.getRelations();
                    const target = rels.find(r => r.id === activeId)
                        || rels.find(r => r.name === attDisplayName);
                    if (target) {
                        target.attitudes = target.attitudes || [];
                        if (!target.attitudes.includes(newAttitude)) {
                            target.attitudes.push(newAttitude);
                            if (target.attitudes.length > 5) target.attitudes.shift();
                            store.updateAttitudes(target.name, target.attitudes);
                        }
                    }
                }
                const noteMatch = reply.match(/【认知】(.+)/);
                if (noteMatch) {
                    const noteContent = noteMatch[1].trim();
                    reply = reply.replace(/【认知】.+/, '').trim();
                    const noteStore = new CharacterStore(otherId);
                    noteStore.setCognitiveNote(activeId, noteContent);
                }
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
            const displayReply = reply.replace(/【(记忆|修改记忆|删除记忆)】.+(\\n|$)/g, '').trim();

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
            ${reasoningContent ? `
            <div class="reasoning-block" style="
                background:#fff8e1; border-radius:12px;
                margin-bottom:8px; font-size:12px; color:#795548;
                border-left:3px solid #ff9800; cursor:pointer;
            ">
                <div onclick="this.nextElementSibling.classList.toggle('reasoning-expanded'); this.querySelector('.arrow').textContent = this.nextElementSibling.classList.contains('reasoning-expanded') ? '▼' : '▶';" style="padding:8px 12px; display:flex; align-items:center; gap:6px; font-weight:600; color:#e65100; user-select:none;">
                    <span class="arrow">▶</span> 🤔 思考过程
                </div>
                <div style="
                    max-height:0; overflow:hidden; transition:max-height 0.3s ease;
                    padding:0 12px;
                ">
                    <div style="padding:0 0 10px 0;line-height:1.6;">${esc(reasoningContent)}</div>
                </div>
            </div>
            <style>
                .reasoning-expanded {
                    max-height: 3000px !important;
                    padding: 0 12px 10px 12px !important;
                }
            </style>
            ` : ''}
        </div>
    </div>
`;
            chatMessages.appendChild(aiMsg);

            // ★ 逐句填充气泡（每句独立气泡）
            const sentences = displayReply.split('|').map(s => s.trim()).filter(s => s);
            const finalSentences = sentences.length > 1 ? sentences : [displayReply];
            const msgContentDiv = aiMsg.querySelector('div[style="min-width:0;"]');

            let si = 0;
            function showNextSentence() {
                if (si < finalSentences.length) {
                    const bubble = document.createElement('div');
                    bubble.className = 'msg-bubble other';
                    bubble.textContent = finalSentences[si];
                    msgContentDiv.appendChild(bubble);
                    si++;
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                    setTimeout(showNextSentence, 500);
                } else {
                    // ★ 流式结束：把含【名片:】的气泡替换成「文本气泡 + 独立名片块」
                    msgContentDiv.querySelectorAll('.msg-bubble').forEach(b => {
                        const t = b.textContent;
                        if (t.includes('【名片:') || t.includes('【接受好友:')) {
                            if (t.includes('【接受好友:')) processFriendRequest(t, otherId, pairKey);   // 只取副作用（执行加好友）
                            b.outerHTML = renderMsgContent(t, otherId, false, pairKey);                  // 统一渲染成名片块/提示块
                        }
                    });


                }
            }
            showNextSentence();

            chatMessages.scrollTop = chatMessages.scrollHeight;
            const messages = getOrCreateMessages(pairKey);
            messages.push({ senderId: otherId, senderDisplayName: otherDisplayName, text: displayReply });

            saveChatMessages(chatMessagesMap);
        }, 300);
    }

    // ★ 读取手动模式状态
    let manualMode = localStorage.getItem('chat_manual_mode_' + otherId) === 'true';
    const chatSendAiBtn = container.querySelector('#chatSendAiBtn');

    function updateModeUI() {
        chatSendAiBtn.style.display = manualMode ? '' : 'none';
        chatInput.placeholder = manualMode ? '输入消息...（手动触发 AI）' : '输入消息...';
    }
    updateModeUI();

    // ★ 监听模式切换事件（来自 chatUI 设置菜单）
    // 单一 handler + 模块级记录当前聊天，remove/add 同一引用，净增 0
    _chatToggleOtherId = otherId;
    if (_toggleHandler) window.removeEventListener('chat-toggle-mode', _toggleHandler);
    _toggleHandler = (e) => {
        if (e.detail.otherId !== _chatToggleOtherId) return;
        manualMode = !manualMode;
        localStorage.setItem('chat_manual_mode_' + _chatToggleOtherId, manualMode);
        updateModeUI();
    };
    window.addEventListener('chat-toggle-mode', _toggleHandler);

    // ★ ⚡ 按钮：手动触发 AI
    chatSendAiBtn?.addEventListener('click', () => {
        callAIAndRenderReply();
    });

    // ★ 编辑模式：删除消息
    chatMessages?.addEventListener('click', (e) => {
        const delBtn = e.target.closest('.msg-delete-btn');
        if (!delBtn) return;
        const idx = parseInt(delBtn.dataset.msgIndex);
        const map = chatMessagesMap;
        const messages = map[pairKey];
        if (!messages || !messages[idx]) return;
        messages.splice(idx, 1);
        saveChatMessages(map);

        // 重渲染当前详情
        const shell = chatMessages.closest('.chat-app-shell');
        if (shell) {
            shell.innerHTML = renderChatDetail(pairKey, otherId, globalState);
            bindChatDetailEvents(shell.closest('.screen-page') || container, pairKey, otherId, memoryService, globalState);
        }
    });

    // ★ 编辑模式：完成
    container.querySelector('#editDoneBtn')?.addEventListener('click', () => {
        chatEditMode = false;
        const shell = chatMessages.closest('.chat-app-shell');
        if (shell) {
            shell.innerHTML = renderChatDetail(pairKey, otherId, globalState);
            bindChatDetailEvents(shell.closest('.screen-page') || container, pairKey, otherId, memoryService, globalState);
        }
    });

    // ★ 原事件绑定
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
            console.log('🟡 准备获取消息');
            const allMessages = getOrCreateMessages(pairKey);
            console.log('🟡 消息数:', allMessages.length);
            if (allMessages.length < 3) { showToast('对话太短，暂无提取价值', '#888'); return; }
            console.log('🟡 准备调用 extractMemoriesForActiveChar');
            console.log('🔍 extractMemoriesForActiveChar 类型:', typeof extractMemoriesForActiveChar);
            console.log('🔍 函数源码:', extractMemoriesForActiveChar?.toString().slice(0, 50));

            const result = await extractMemoriesForActiveChar(activeId, otherId, contact.name, allMessages);
            console.log('🟡 result 类型:', typeof result, '是否有 then:', typeof result?.then);
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
            initChatUI(chatDetail, { globalState, otherId, activeId, contact, pairKey });
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
// ---- 健壮的 JSON 数组提取 ----
function extractJsonArray(text) {
    if (!text) return null;

    // 1. 直接解析
    try { const p = JSON.parse(text); if (Array.isArray(p)) return p; } catch { }

    // 2. markdown 代码块
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
        try { const p = JSON.parse(fenced[1]); if (Array.isArray(p)) return p; } catch { }
    }

    // 3. 第一个 [ 到最后一个 ]（处理嵌套数组，替代原非贪婪正则）
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start !== -1 && end > start) {
        const sliced = text.slice(start, end + 1);
        try { const p = JSON.parse(sliced); if (Array.isArray(p)) return p; } catch { }
    }

    return null;
}

// ---- 主动提取记忆 ----
async function extractMemoriesForActiveChar(activeId, otherId, otherName, allMessages) {
    try {
        console.log('🔵 函数内部执行了', { activeId, otherId, otherName, msgCount: allMessages.length });
        const recentMessages = allMessages.slice(-20);
        if (recentMessages.length === 0) return;

        const convText = recentMessages.map(m => {
            const displayName = m.senderId === activeId ? '我' : (otherName || m.senderDisplayName || m.senderId);
            return `${displayName}：${(m.text || '').replace(/\|/g, '')}`;
        }).join('\n');

        // ★ 读取主视角已有的记忆列表，放在对话文本前面
        let fullContext = '';

        // 角色信息放在最前面
        try {
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
                fullContext = charInfo;
            }

            // ★ 已有记忆放在对话文本前面
            const store = new CharacterStore(activeId);
            const existingMemories = store.getMemories();
            if (existingMemories.length > 0) {
                fullContext += '\n\n【我已有的记忆】\n' + existingMemories.map(m => `- ${m.content}`).join('\n');
            }

            // ★ 我对对方的认知
            try {
                const myStore = new CharacterStore(activeId);
                const myRelations = myStore.getRelations();
                console.log('🔍 关系数据:', myRelations, '查找目标:', otherName);  // ★ 调试
                // const aboutThem = myRelations.find(r => r.name === otherName);
                const aboutThem = myStore.getRelationById(otherId);
                console.log('🔍 找到:', aboutThem);  // ★ 调试
                if (aboutThem) {
                    let aboutText = '【我对' + otherName + '的认知】\n';
                    if (aboutThem.relation) aboutText += `定位：${aboutThem.relation}\n`;
                    if (aboutThem.perspective) aboutText += `看法：${aboutThem.perspective}\n`;
                    if (aboutThem.attitudes?.length > 0) aboutText += `倾向：${aboutThem.attitudes.join('、')}\n`;
                    fullContext += '\n\n' + aboutText.trim();
                }
            } catch (e) { /* 忽略 */ }

            // ★ 我对对方的认知笔记
            try {
                const noteStore = new CharacterStore(activeId);
                // const note = noteStore.getCognitiveNote(otherName);
                const note = noteStore.getCognitiveNote(otherId);
                if (note) {
                    fullContext += '\n\n【我对' + otherName + '的认知笔记】\n' + note;
                }
            } catch (e) { /* 忽略 */ }

            // ★ 我对对方的公开信息认知（分层，按当前可见层级注入）
            try {
                const { formatProfilePrompt } = await import('../store/profileAccess.js');
                const profileKnow = formatProfilePrompt(otherId, activeId, otherName);
                if (profileKnow) {
                    fullContext += '\n\n' + profileKnow;
                }
            } catch (e) { /* 忽略 */ }

            // ★ 对话文本放在最后
            fullContext += '\n\n【对话文本】\n' + convText;
        } catch (e) { /* 忽略 */ }

        const activeCharName = getCharacterNameById(activeId) || '我';
        const { systemPrompt, assistantContext } = buildMemoryExtractPrompt(otherName, fullContext, activeCharName);
        const reply = await callAIForMemoryExtract({
            systemPrompt,       // 角色记忆提取助手 + 当前角色信息
            assistantContext,   // 对话历史
            userMessage: '根据以上对话文本输出符合格式的内容'  // ★ 新增
        });

        let memories;
        try {
            memories = extractJsonArray(reply);
        } catch (e) {
            console.warn('记忆提取 JSON 解析失败，原始回复:', reply);
            return;
        }

        if (!Array.isArray(memories) || memories.length === 0) return;

        const store = new CharacterStore(activeId);
        memories.forEach(m => {
            if (m.modify) {
                // 修改已有记忆
                const existingMemories = store.getMemories();
                const idx = existingMemories.findIndex(em => em.content === m.modify);
                if (idx >= 0) {
                    existingMemories[idx].content = m.content;
                    existingMemories[idx].time = new Date().toLocaleString('zh-CN');
                    store._save();
                }
            } else if (m.content) {
                // 新增记忆（自动去重）
                const existingMemories = store.getMemories();
                const isDuplicate = existingMemories.some(em => em.content === m.content);
                if (!isDuplicate) {
                    store.addMemory({
                        id: 'mem_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
                        time: new Date().toLocaleString('zh-CN'),
                        content: m.content,
                        source: 'auto_extract'
                    });
                }
            }
        });
        // ★ 认知笔记更新
        memories.forEach(m => {
            if (m.cognitiveNote) {
                const noteStore = new CharacterStore(activeId);
                noteStore.setCognitiveNote(otherId, m.cognitiveNote);
            }
        });

        // ★ 关系/看法/态度更新
        memories.forEach(m => {
            if (m.updateRelation) {
                const relStore = new CharacterStore(activeId);
                // 用 ID 查找已有关系的显示名，没有则用 otherName
                const existingRel = relStore.getRelationById(otherId);
                const displayName = existingRel?.name || otherName;

                relStore.updateRelation(
                    displayName,
                    m.updateRelation.relation || (existingRel?.relation || ''),
                    m.updateRelation.perspective !== undefined ? m.updateRelation.perspective : undefined,
                    otherId
                );
                if (m.updateRelation.attitudes) {
                    relStore.updateAttitudes(displayName, m.updateRelation.attitudes);
                }
            }
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

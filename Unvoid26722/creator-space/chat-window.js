// creator-space/chat-window.js — 通用聊天窗口组件
// 不绑定特定聊天对象，可更换聊天代理

import { mdToHtml, esc } from './md-renderer.js';

// ---- IndexedDB 存储（独立于 Aoi 的记忆）----

const DB_NAME = 'CreatorChatHistory';
const DB_VERSION = 1;
const STORE_NAME = 'messages';

let _db = null;

function openDB() {
    return new Promise((resolve, reject) => {
        if (_db) return resolve(_db);

        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, {
                    keyPath: 'id',
                    autoIncrement: true
                });
                store.createIndex('timestamp', 'timestamp', { unique: false });
            }
        };

        request.onsuccess = (event) => {
            _db = event.target.result;
            resolve(_db);
        };

        request.onerror = () => {
            reject(new Error('IndexedDB 打开失败'));
        };
    });
}

async function loadHistory() {
    try {
        const db = await openDB();
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('timestamp');

        const messages = await new Promise((resolve) => {
            const request = index.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => resolve([]);
        });

        return messages.map(m => ({ role: m.role, html: m.html }));
    } catch {
        return [];
    }
}

async function saveMessage(role, html) {
    try {
        const db = await openDB();
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        store.add({ role, html, timestamp: Date.now() });
        await new Promise((resolve, reject) => {
            transaction.oncomplete = resolve;
            transaction.onerror = reject;
        });
    } catch (e) {
        console.warn('聊天历史保存失败:', e);
    }
}

async function clearHistory() {
    try {
        const db = await openDB();
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).clear();
        await new Promise((resolve, reject) => {
            transaction.oncomplete = resolve;
            transaction.onerror = reject;
        });
    } catch { }
}

// ---- 模块级状态 ----

let _messages = [];
let _agent = null;
let _ready = false;
// ★ 消息显示限制：进入时只显示最近 N 条
let _displayLimit = 20;
// ★ 重置显示限制（供外部调用，如每次打开窗口时）
export function resetDisplayLimit() {
    _displayLimit = 20;
}


// ★ 初始化时从 IndexedDB 加载
loadHistory().then(saved => {
    if (saved.length > 0) {
        _messages = saved;
    }
});

// ★ 构建消息列表的 HTML，支持折叠更早的历史
function buildMessagesHTML() {
    const total = _messages.length;
    const showCount = Math.min(_displayLimit, total);
    const messagesToShow = _messages.slice(-showCount);

    let html = '';
    if (total > showCount) {
        const hiddenCount = total - showCount;
        const nextBatch = Math.min(20, hiddenCount);
        html += `<button class="chat-show-more" id="chatShowMoreBtn">📜 查看更早的 ${nextBatch} 条消息（共 ${hiddenCount} 条被折叠）</button>`;
    }
    html += messagesToShow.map(buildMsgHTML).join('');
    return html;
}

// ... 以下部分不变 ...

/**
 * 设置聊天代理
 * 代理需实现：{ name, avatar, chat(text), bootstrap(), ready }
 */
export function setAgent(agent) {
    _agent = agent;
    _ready = false;
}

export function getAgent() {
    return _agent;
}

function buildMsgHTML(msg) {
    const dir = msg.role === 'user' ? ' style="flex-direction:row-reverse;"' : '';
    const avatar = msg.role === 'user' ? '👤' : (_agent?.avatar || '💠');
    return `<div class="chat-msg ${msg.role}"${dir}>
        <span class="chat-avatar">${avatar}</span>
        <span class="chat-bubble">${msg.html}</span>
    </div>`;
}

export function render() {
    const agentName = _agent?.name || 'Aoi';
    const agentAvatar = _agent?.avatar || '💠';

    const msgsHtml = _messages.length > 0
        ? buildMessagesHTML()
        : `<div class="chat-msg agent">
        <span class="chat-avatar">${agentAvatar}</span>
        <span class="chat-bubble">你好，我是 ${agentName}。</span>
    </div>`;

    return `
        <div class="chat-window" id="chatWindow" style="display:none;">
            <div class="chat-header">
                <span class="chat-title">${agentAvatar} ${agentName}</span>
                <button class="chat-close-btn" id="chatCloseBtn">✕</button>
            </div>
            <div class="chat-messages" id="chatMessages">${msgsHtml}</div>
<div class="chat-input-row">
    <input type="file" id="chatFileInput" accept=".txt,.js,.json,.html,.css,.md,.jsx,.ts,.tsx,.py,.java,.xml,.yaml,.yml,.csv,.sh,.sql,.rb,.php,.c,.cpp,.h,.hpp,.swift,.kt,.go,.rs,.vue,.svelte,.scss,.less" multiple style="display:none;" />
    <button class="chat-file-btn" id="chatFileBtn" title="上传文件">📎</button>
    <input type="text" id="chatInput" placeholder="说点什么..." />
    <button class="chat-send-btn" id="chatSendBtn">发送</button>
</div>
        </div>
    `;
}

export function bindEvents(container, options = {}) {
    const { onClose } = options;

    const messagesEl = container.querySelector('#chatMessages');
    const inputEl = container.querySelector('#chatInput');
    const sendBtn = container.querySelector('#chatSendBtn');
    const closeBtn = container.querySelector('#chatCloseBtn');

    closeBtn?.addEventListener('click', () => {
        if (onClose) onClose();
    });

    // ★ 文件上传状态
    let attachedFiles = [];  // [{ name, content }, ...]

    // ★ 长消息折叠
    function makeCollapsible(html, text, maxLength = 500) {
        if (text.length <= maxLength) return html;

        const previewText = text.slice(0, maxLength) + '...';
        const previewHtml = mdToHtml(previewText);

        return `
            <div class="collapsible-wrap">
                <div class="collapsible-preview">${previewHtml}</div>
                <div class="collapsible-full" style="display:none;">${html}</div>
                <button class="collapsible-toggle" data-expanded="false">展开全部 (${text.length} 字)</button>
            </div>
        `;
    }


    // ★ 文件选择按钮
    const fileBtn = container.querySelector('#chatFileBtn');
    const fileInput = container.querySelector('#chatFileInput');

    fileBtn?.addEventListener('click', () => fileInput.click());

    fileInput?.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        if (files.length === 0) return;

        const MAX_SIZE = 500 * 1024;
        const validFiles = [];
        let hasError = false;

        for (const file of files) {
            if (file.size > MAX_SIZE) {
                appendMessage('agent', `❌ ${file.name} 文件过大（超过 500KB），已跳过`);
                hasError = true;
                continue;
            }
            try {
                const content = await file.text();
                validFiles.push({ name: file.name, content });
            } catch (e) {
                appendMessage('agent', `❌ ${file.name} 读取失败: ${e.message}`);
                hasError = true;
            }
        }

        if (validFiles.length === 0) {
            fileInput.value = '';
            return;
        }

        attachedFiles = validFiles;
        const fileNames = validFiles.map(f => f.name).join('、');
        fileBtn.textContent = `📎✅ ${validFiles.length}`;
        inputEl.placeholder = `已附加 ${validFiles.length} 个文件: ${fileNames}，继续输入或直接发送...`;

        fileInput.value = '';
    });


    async function send() {
        let text = inputEl.value.trim();
        let displayHtml;
        const userText = text;

        // ★ 如果有附加文件，拼到消息里
        if (attachedFiles.length > 0) {
            // 拼多个文件的内容给 Aoi
            const fileSections = attachedFiles.map(f =>
                `\n\n📎 **${f.name}**\n\`\`\`\n${f.content}\n\`\`\``
            ).join('');
            text = text ? text + fileSections : fileSections.trim();

            // 界面只显示文件名列表
            const fileList = attachedFiles.map(f =>
                `<strong>${esc(f.name)}</strong> (${f.content.length} 字符)`
            ).join('<br>📎 ');
            const fileInfo = `📎 已附加文件:<br>📎 ${fileList}`;
            // ★ 用 userText 判断，而不是靠 replace 匹配
            displayHtml = userText
                ? esc(userText) + '<br>' + fileInfo
                : fileInfo;
        }
        else {
            displayHtml = esc(text);
        }
        if (!text) return;

        appendMessage('user', displayHtml);
        inputEl.value = '';

        // ★ 重置文件状态
        attachedFiles = [];
        fileBtn.textContent = '📎';
        inputEl.placeholder = '说点什么...';

        // ★ 加载消息：直接创建 DOM，不经过 appendMessage（不保存到 DB）
        const loadingEl = document.createElement('div');
        loadingEl.className = 'chat-msg agent';
        const avatar = _agent?.avatar || '💠';
        loadingEl.innerHTML = `<span class="chat-avatar">${avatar}</span><span class="chat-bubble">⏳ 思考中...</span>`;
        messagesEl.appendChild(loadingEl);
        messagesEl.scrollTop = messagesEl.scrollHeight;

        try {
            if (!_ready) {
                await _agent.bootstrap();
                _ready = true;
            }

            const result = await _agent.chat(text);
            loadingEl.remove();

            let html;
            const replyHtml = mdToHtml(result.reply);
            const collapsibleReply = makeCollapsible(replyHtml, result.reply);

            if (result.reasoning) {
                html = `
                <details style="font-size:12px;color:#888;margin-bottom:6px;cursor:pointer;">
                    <summary style="font-weight:500;">💭 AI 思考过程</summary>
                    <div style="margin-top:4px;padding:8px;background:#f8f8fc;border-radius:6px;line-height:1.5;white-space:pre-wrap;color:#555;">${esc(result.reasoning)}</div>
                </details>
                <div style="white-space:pre-wrap;">${collapsibleReply}</div>
            `;
            } else {
                html = `<div style="white-space:pre-wrap;">${collapsibleReply}</div>`;
            }
            // ★ 显示 token 用量（如果 API 返回了的话）
            if (result.usage) {
                const usageHtml = `<div style="font-size:11px;color:#aaa;text-align:right;margin-top:4px;padding-top:4px;border-top:1px solid #f0f0f0;">
        ⚡ ${result.usage.total_tokens} tokens（输入 ${result.usage.prompt_tokens} / 输出 ${result.usage.completion_tokens}）
    </div>`;
                html += usageHtml;
            }

            appendMessage('agent', html);

        } catch (e) {
            loadingEl.remove();
            appendMessage('agent', '❌ ' + e.message);
        }
    }

    function appendMessage(role, html) {
        _messages.push({ role, html });
        saveMessage(role, html);  // ★ 存到 IndexedDB

        const el = document.createElement('div');
        el.className = 'chat-msg ' + role;
        const avatar = role === 'user' ? '👤' : (_agent?.avatar || '💠');
        el.innerHTML = `<span class="chat-avatar">${avatar}</span><span class="chat-bubble">${html}</span>`;
        if (role === 'user') el.style.flexDirection = 'row-reverse';
        messagesEl.appendChild(el);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return el;
    }


    sendBtn?.addEventListener('click', send);

    // ★ 折叠按钮事件委托 + 显示更早消息
    messagesEl.addEventListener('click', (e) => {
        // ★ 显示更早消息
        const showMoreBtn = e.target.closest('.chat-show-more');
        if (showMoreBtn) {
            _displayLimit += 20;
            messagesEl.innerHTML = buildMessagesHTML();  // 重新构建，按钮会自动重新出现
            messagesEl.scrollTop = 0;
            return;
        }

        // ★ 长消息折叠（原有）
        const toggle = e.target.closest('.collapsible-toggle');
        if (!toggle) return;

        const wrap = toggle.closest('.collapsible-wrap');
        const preview = wrap.querySelector('.collapsible-preview');
        const full = wrap.querySelector('.collapsible-full');
        const expanded = toggle.dataset.expanded === 'true';

        if (expanded) {
            preview.style.display = 'block';
            full.style.display = 'none';
            toggle.textContent = toggle.textContent.replace('收起', `展开全部`);
            toggle.dataset.expanded = 'false';
        } else {
            preview.style.display = 'none';
            full.style.display = 'block';
            toggle.textContent = '收起';
            toggle.dataset.expanded = 'true';
        }
        messagesEl.scrollTop = messagesEl.scrollHeight;
    });

    inputEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

}


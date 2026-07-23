// apps/bulletin.js — 告示栏

import { CharacterStore } from '../store/CharacterStore.js';
import { getCharacterNameById } from './characterManager.js';

export const id = 'bulletin';
export const label = '告示栏';
export const icon = '📋';
export const color = '#795548';

// ★ 调试开关：设为 true 可切换查看所有角色的个人告示（测试用）
// ★ 设为 false 时，个人告示直接显示当前主视角角色的内容，无角色切换界面
const DEBUG_CHAR_SELECT = false;

const STORAGE_PUBLIC = 'bulletin_public';
const STORAGE_PRIVATE_PREFIX = 'bulletin_private_';

// ---- 子页面状态 ----
let viewingTab = 'public';    // 'public' | 'private'
let viewingDetail = null;     // 正在查看的告警 id（null=列表）
let viewingCharId = null;     // 个人告示当前查看的角色ID


// ---- 数据读写 ----
function getPublicNotices() {
    try {
        const saved = localStorage.getItem(STORAGE_PUBLIC);
        return saved ? JSON.parse(saved) : [];
    } catch { return []; }
}

function savePublicNotices(notices) {
    localStorage.setItem(STORAGE_PUBLIC, JSON.stringify(notices));
}

function getPrivateNotices(charId) {
    if (!charId) return [];
    try {
        const saved = localStorage.getItem(STORAGE_PRIVATE_PREFIX + charId);
        return saved ? JSON.parse(saved) : [];
    } catch { return []; }
}

function savePrivateNotices(charId, notices) {
    localStorage.setItem(STORAGE_PRIVATE_PREFIX + charId, JSON.stringify(notices));
}

function generateNoticeId() {
    return 'notice_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
}

// ---- 获取所有有个人告示的角色 ----
function getAllCharactersWithPrivateNotices() {
    const result = [];
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(STORAGE_PRIVATE_PREFIX)) {
                const charId = key.replace(STORAGE_PRIVATE_PREFIX, '');
                const notices = getPrivateNotices(charId);
                if (notices.length > 0) {
                    result.push({ id: charId, count: notices.length });
                }
            }
        }
    } catch (e) { }
    return result;
}

// ============================================================
//  渲染
// ============================================================

// ---- 主渲染 ----
export function render({ globalState } = {}) {
    // ★ 非调试模式：个人 tab 直接锁定主视角角色
    if (!DEBUG_CHAR_SELECT && viewingTab === 'private') {
        const activeChar = globalState?.activeCharacter;
        if (activeChar) {
            const charId = activeChar.id || activeChar.base?.name;
            if (!viewingCharId) viewingCharId = charId;
        }
    }

    // 详情页
    if (viewingDetail) {
        return renderDetail();
    }

    // tab 切换（调试模式才显示角色选择）
    if (DEBUG_CHAR_SELECT && viewingTab === 'private' && !viewingCharId) {
        return renderCharSelect(globalState);
    }

    if (viewingTab === 'private' && viewingCharId) {
        return renderPrivateList(viewingCharId);
    }

    return renderPublicList();
}

// ---- tab 栏 ----
function renderTabBar() {
    return `
        <div style="display:flex; gap:2px; margin-bottom:10px; background:#f0f0f0; border-radius:12px; padding:3px;">
            <button class="bulletin-tab" data-tab="public"
                    style="flex:1; padding:6px 12px; border-radius:10px; border:none;
                           background:${viewingTab === 'public' ? 'white' : 'transparent'};
                           color:${viewingTab === 'public' ? '#795548' : '#888'};
                           cursor:pointer; font-size:13px; font-weight:${viewingTab === 'public' ? '600' : '400'};
                           box-shadow:${viewingTab === 'public' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none'};">
                📢 公共
            </button>
            <button class="bulletin-tab" data-tab="private"
                    style="flex:1; padding:6px 12px; border-radius:10px; border:none;
                           background:${viewingTab === 'private' ? 'white' : 'transparent'};
                           color:${viewingTab === 'private' ? '#795548' : '#888'};
                           cursor:pointer; font-size:13px; font-weight:${viewingTab === 'private' ? '600' : '400'};
                           box-shadow:${viewingTab === 'private' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none'};">
                🔒 个人
            </button>
        </div>
    `;
}

// ---- 公共告示列表 ----
function renderPublicList() {
    const notices = getPublicNotices();

    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">📋 告示栏</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card" style="padding:0;">
                    ${renderTabBar()}

                    <div style="padding:0 14px 14px;">
                        ${notices.length === 0 ? `
                            <p style="text-align:center; color:#888; padding:20px 0; font-size:14px;">
                                暂无公共告示<br>
                                <span style="font-size:12px;">点击下方按钮添加</span>
                            </p>
                        ` : notices.map(n => `
                            <div class="bulletin-item" data-id="${n.id}"
                                 style="padding:10px 12px; margin-bottom:6px; background:white;
                                        border-radius:10px; cursor:pointer;
                                        border:1px solid #f0f0f0; transition:all 0.15s;">
                                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                                    <div style="font-weight:600; font-size:14px; color:#333; flex:1;">${n.title}</div>
                                    <span style="font-size:11px; color:#999; white-space:nowrap; margin-left:8px;">${n.time || ''}</span>
                                </div>
                                <div style="font-size:12px; color:#888; margin-top:4px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">
                                    ${(n.content || '').substring(0, 60)}${(n.content || '').length > 60 ? '...' : ''}
                                </div>
                                ${n.author ? `<div style="font-size:11px; color:#aaa; margin-top:4px;">发布者：${n.author}</div>` : ''}
                            </div>
                        `).join('')}
                    </div>

                    <button id="addPublicNoticeBtn"
                            style="width:calc(100% - 28px); margin:0 14px 14px; padding:10px;
                                   border-radius:14px; border:2px dashed #795548;
                                   background:white; color:#795548; cursor:pointer;
                                   font-size:14px; font-weight:600;">
                        ➕ 添加告示
                    </button>
                </div>
            </div>
        </div>
    `;
}

// ---- 角色选择页（个人告示） ----
function renderCharSelect(globalState) {
    const activeChar = globalState?.activeCharacter;
    const charsWithNotices = getAllCharactersWithPrivateNotices();

    // 从角色名册读取所有角色
    let allCharacters = [];
    try {
        const roleData = localStorage.getItem('rolebook_characters');
        if (roleData) allCharacters = JSON.parse(roleData);
    } catch (e) { }

    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">📋 告示栏</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card" style="padding:0;">
                    ${renderTabBar()}

                    <div style="padding:0 14px 14px;">
                        <p style="font-size:13px; color:#666; margin-bottom:10px;">选择要查看个人告示的角色：</p>

                        ${activeChar ? `
                            <div class="bulletin-char-select" data-charid="${activeChar.id || activeChar.base?.name}"
                                 style="display:flex; align-items:center; gap:12px; padding:12px 14px;
                                        background:white; border-radius:12px; cursor:pointer; margin-bottom:8px;
                                        border:2px solid #795548;">
                                <span style="font-size:28px;">${activeChar.base?.emoji || '👤'}</span>
                                <div style="flex:1;">
                                    <div style="font-weight:600; font-size:15px;">${activeChar.base?.name || '当前主视角'}</div>
                                    <div style="font-size:12px; color:#999;">当前主视角角色</div>
                                </div>
                                <span style="font-size:11px; background:#795548; color:white; padding:2px 8px; border-radius:10px;">${getPrivateNotices(activeChar.id || activeChar.base?.name).length}</span>
                            </div>
                        ` : ''}

                        ${allCharacters.filter(c => !activeChar || c.id !== (activeChar.id || activeChar.base?.name)).map(char => `
                            <div class="bulletin-char-select" data-charid="${char.id}"
                                 style="display:flex; align-items:center; gap:12px; padding:12px 14px;
                                        background:white; border-radius:12px; cursor:pointer; margin-bottom:6px;
                                        border:1px solid #f0f0f0;">
                                <span style="font-size:28px;">${char.base?.emoji || '👤'}</span>
                                <div style="flex:1;">
                                    <div style="font-weight:600; font-size:15px;">${char.base?.name || char.id}</div>
                                </div>
                                <span style="font-size:11px; color:#999; background:#f5f5f5; padding:2px 8px; border-radius:10px;">${getPrivateNotices(char.id).length}</span>
                            </div>
                        `).join('')}

                        ${(!activeChar && allCharacters.length === 0) ? `
                            <p style="text-align:center; color:#888; padding:20px 0; font-size:13px;">暂无角色数据，请先在角色名册中创建角色</p>
                        ` : ''}
                    </div>
                </div>
            </div>
        </div>
    `;
}

// ---- 个人告示列表 ----
function renderPrivateList(charId) {
    const notices = getPrivateNotices(charId);
    const charName = getCharacterNameById(charId);

    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">📋 告示栏</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card" style="padding:0;">
                    ${renderTabBar()}

                    ${DEBUG_CHAR_SELECT ? `
                    <div style="display:flex; align-items:center; gap:8px; padding:0 14px 8px;">
                        <button id="backToCharSelectBtn" style="background:none; border:none; cursor:pointer; font-size:16px; color:#795548;">←</button>
                        <span style="font-weight:600; font-size:14px; color:#555;">${charName || charId} 的个人告示</span>
                    </div>
                    ` : `
                    <div style="padding:0 14px 8px;">
                        <span style="font-weight:600; font-size:14px; color:#555;">${charName || charId} 的个人告示</span>
                    </div>
                    `}

                    <div style="padding:0 14px 14px;">
                        ${notices.length === 0 ? `
                            <p style="text-align:center; color:#888; padding:20px 0; font-size:14px;">
                                暂无个人告示<br>
                                <span style="font-size:12px;">点击下方按钮添加</span>
                            </p>
                        ` : notices.map(n => `
                            <div class="bulletin-item" data-id="${n.id}"
                                 style="padding:10px 12px; margin-bottom:6px; background:white;
                                        border-radius:10px; cursor:pointer;
                                        border:1px solid #f0f0f0;">
                                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                                    <div style="font-weight:600; font-size:14px; color:#333; flex:1;">${n.title}</div>
                                    <span style="font-size:11px; color:#999; white-space:nowrap; margin-left:8px;">${n.time || ''}</span>
                                </div>
                                <div style="font-size:12px; color:#888; margin-top:4px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">
                                    ${(n.content || '').substring(0, 60)}${(n.content || '').length > 60 ? '...' : ''}
                                </div>
                                ${n.source ? `<div style="font-size:11px; color:#aaa; margin-top:4px;">来源：${n.source}</div>` : ''}
                            </div>
                        `).join('')}
                    </div>

                    <button id="addPrivateNoticeBtn" data-charid="${charId}"
                            style="width:calc(100% - 28px); margin:0 14px 14px; padding:10px;
                                   border-radius:14px; border:2px dashed #795548;
                                   background:white; color:#795548; cursor:pointer;
                                   font-size:14px; font-weight:600;">
                        ➕ 添加告示
                    </button>
                </div>
            </div>
        </div>
    `;
}

// ---- 详情/编辑页 ----
function renderDetail() {
    // viewingDetail = { id, type: 'public'|'private', charId? }
    if (!viewingDetail) return '';

    const { id, type, charId } = viewingDetail;

    let notices, titlePrefix;
    if (type === 'public') {
        notices = getPublicNotices();
        titlePrefix = '📢 公共告示';
    } else {
        notices = getPrivateNotices(charId);
        titlePrefix = `🔒 ${getCharacterNameById(charId)} 的个人告示`;
    }

    const notice = notices.find(n => n.id === id);
    if (!notice) {
        viewingDetail = null;
        return render();
    }

    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">📋 告示</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card">
                    <div style="font-size:12px; color:#888; margin-bottom:4px;">${titlePrefix}</div>
                    <h3 style="margin:4px 0 8px; font-size:18px;">${notice.title}</h3>
                    <div style="font-size:12px; color:#999; margin-bottom:12px;">
                        ${notice.time || ''}
                        ${notice.author ? ` · ${notice.author}` : ''}
                        ${notice.source ? ` · ${notice.source}` : ''}
                    </div>
                    <div style="font-size:14px; color:#333; line-height:1.7; white-space:pre-wrap; word-break:break-word;">
                        ${notice.content || ''}
                    </div>

                    <div style="display:flex; gap:8px; margin-top:16px;">
                        <button id="editNoticeBtn"
                                style="flex:1; padding:10px; border-radius:14px; border:1px solid #795548;
                                       background:white; color:#795548; cursor:pointer; font-size:14px;">
                            ✏️ 编辑
                        </button>
                        <button id="deleteNoticeBtn"
                                style="flex:1; padding:10px; border-radius:14px; border:none;
                                       background:#e53935; color:white; cursor:pointer; font-size:14px;">
                            🗑️ 删除
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// ---- 添加/编辑弹窗 ----
function showNoticeEditor({ title = '', content = '', author = '', source = '', onSave }) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); z-index:300; display:flex; align-items:center; justify-content:center;';

    overlay.innerHTML = `
        <div style="background:white; border-radius:20px; padding:20px; width:300px;">
            <div style="font-weight:600; font-size:16px; margin-bottom:12px;">${title ? '编辑告示' : '新建告示'}</div>
            <input id="editorTitle" type="text" placeholder="标题" value="${title}"
                   style="width:100%; border:1px solid #ccc; border-radius:8px; padding:8px 10px; font-size:14px; margin-bottom:8px; box-sizing:border-box;" />
            <textarea id="editorContent" placeholder="内容" rows="5"
                      style="width:100%; border:1px solid #ccc; border-radius:8px; padding:8px 10px; font-size:14px; margin-bottom:8px; resize:vertical; box-sizing:border-box; font-family:inherit;">${content}</textarea>
            <div style="display:flex; gap:8px;">
                <button id="editorCancelBtn"
                        style="flex:1; padding:8px; border-radius:12px; border:1px solid #ccc; background:white; color:#666; cursor:pointer; font-size:13px;">取消</button>
                <button id="editorSaveBtn"
                        style="flex:1; padding:8px; border-radius:12px; border:none; background:#795548; color:white; cursor:pointer; font-size:13px;">保存</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('#editorCancelBtn').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#editorSaveBtn').addEventListener('click', () => {
        const newTitle = overlay.querySelector('#editorTitle').value.trim();
        const newContent = overlay.querySelector('#editorContent').value.trim();
        if (!newTitle || !newContent) { alert('标题和内容不能为空'); return; }
        overlay.remove();
        onSave({ title: newTitle, content: newContent });
    });
}

// ============================================================
//  事件绑定
// ============================================================
export function bindEvents(container, { globalState } = {}) {
    // ---- tab 切换 ----
    container.querySelectorAll('.bulletin-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            viewingTab = btn.dataset.tab;
            viewingDetail = null;
            viewingCharId = null;
            const appContainer = container.closest('.page-container') || container;
            appContainer.innerHTML = render({ globalState });
            bindEvents(appContainer, { globalState });
        });
    });

    // ---- 角色选择 ----
    container.querySelectorAll('.bulletin-char-select').forEach(item => {
        item.addEventListener('click', () => {
            viewingCharId = item.dataset.charid;
            viewingDetail = null;
            const appContainer = container.closest('.page-container') || container;
            appContainer.innerHTML = render({ globalState });
            bindEvents(appContainer, { globalState });
        });
    });

    // ---- 返回角色选择 ----
    if (DEBUG_CHAR_SELECT) {
        container.querySelector('#backToCharSelectBtn')?.addEventListener('click', () => {
            viewingCharId = null;
            viewingDetail = null;
            const appContainer = container.closest('.page-container') || container;
            appContainer.innerHTML = render({ globalState });
            bindEvents(appContainer, { globalState });
        });
    }

    // ---- 告示条目点击 ----
    container.querySelectorAll('.bulletin-item').forEach(item => {
        item.addEventListener('click', () => {
            const id = item.dataset.id;
            viewingDetail = { id, type: viewingTab, charId: viewingCharId };
            const appContainer = container.closest('.page-container') || container;
            appContainer.innerHTML = render({ globalState });
            bindEvents(appContainer, { globalState });
        });
    });

    // ---- 添加公共告示 ----
    container.querySelector('#addPublicNoticeBtn')?.addEventListener('click', () => {
        showNoticeEditor({
            onSave: ({ title, content }) => {
                const notices = getPublicNotices();
                notices.unshift({
                    id: generateNoticeId(),
                    title,
                    content,
                    author: globalState?.activeCharacter?.base?.name || '未知',
                    time: new Date().toLocaleString('zh-CN')
                });
                savePublicNotices(notices);
                const appContainer = container.closest('.page-container') || container;
                appContainer.innerHTML = render({ globalState });
                bindEvents(appContainer, { globalState });
            }
        });
    });

    // ---- 添加个人告示 ----
    container.querySelector('#addPrivateNoticeBtn')?.addEventListener('click', function () {
        const charId = this.dataset.charid;
        showNoticeEditor({
            onSave: ({ title, content }) => {
                const notices = getPrivateNotices(charId);
                notices.unshift({
                    id: generateNoticeId(),
                    title,
                    content,
                    source: globalState?.activeCharacter?.base?.name || '未知',
                    time: new Date().toLocaleString('zh-CN')
                });
                savePrivateNotices(charId, notices);
                const appContainer = container.closest('.page-container') || container;
                appContainer.innerHTML = render({ globalState });
                bindEvents(appContainer, { globalState });
            }
        });
    });

    // ---- 删除告示 ----
    container.querySelector('#deleteNoticeBtn')?.addEventListener('click', () => {
        if (!viewingDetail) return;
        if (!confirm('确定要删除这条告示吗？')) return;

        const { id, type, charId } = viewingDetail;
        if (type === 'public') {
            const notices = getPublicNotices().filter(n => n.id !== id);
            savePublicNotices(notices);
        } else {
            const notices = getPrivateNotices(charId).filter(n => n.id !== id);
            savePrivateNotices(charId, notices);
        }
        viewingDetail = null;
        const appContainer = container.closest('.page-container') || container;
        appContainer.innerHTML = render({ globalState });
        bindEvents(appContainer, { globalState });
    });

    // ---- 编辑告示 ----
    container.querySelector('#editNoticeBtn')?.addEventListener('click', () => {
        if (!viewingDetail) return;
        const { id, type, charId } = viewingDetail;

        let notices;
        if (type === 'public') notices = getPublicNotices();
        else notices = getPrivateNotices(charId);

        const notice = notices.find(n => n.id === id);
        if (!notice) return;

        showNoticeEditor({
            title: notice.title,
            content: notice.content,
            onSave: ({ title, content }) => {
                notice.title = title;
                notice.content = content;
                if (type === 'public') savePublicNotices(notices);
                else savePrivateNotices(charId, notices);

                viewingDetail = null;
                const appContainer = container.closest('.page-container') || container;
                appContainer.innerHTML = render({ globalState });
                bindEvents(appContainer, { globalState });
            }
        });
    });
}

// ============================================================
//  返回处理
// ============================================================
export function handleBack(container, { globalState } = {}) {
    if (viewingDetail) {
        viewingDetail = null;
        const appContainer = container.closest('.page-container') || container;
        appContainer.innerHTML = render({ globalState });
        bindEvents(appContainer, { globalState });
        return true;
    }
    // ★ 调试模式才返回角色选择，非调试模式直接返回列表
    if (DEBUG_CHAR_SELECT && viewingCharId) {
        viewingCharId = null;
        const appContainer = container.closest('.page-container') || container;
        appContainer.innerHTML = render({ globalState });
        bindEvents(appContainer, { globalState });
        return true;
    }
    if (viewingTab !== 'public') {
        viewingTab = 'public';
        viewingCharId = null;  // ★ 切回公共时重置角色选择
        const appContainer = container.closest('.page-container') || container;
        appContainer.innerHTML = render({ globalState });
        bindEvents(appContainer, { globalState });
        return true;
    }
    return false;
}

if (!window.__moduleRegistry) window.__moduleRegistry = [];
window.__moduleRegistry.push({ id, label, icon, color, render, bindEvents, handleBack });

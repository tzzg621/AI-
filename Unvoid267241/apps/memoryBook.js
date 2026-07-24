import { CharacterStore } from '../store/CharacterStore.js';

export const id = 'memoryBookPage';
export const label = '记忆簿';
export const icon = '📜';
export const color = '#607d8b';
export const title = '📜 记忆簿';

// 当前正在查看哪个角色的记忆（null 表示列表页）
let viewingCharacterId = null;

// ---- 获取所有有记忆的角色 ----
function getAllCharactersWithMemories() {
    const result = [];

    // ① 从角色名册（rolebook_characters）读取
    try {
        const roleData = localStorage.getItem('rolebook_characters');
        if (roleData) {
            const characters = JSON.parse(roleData);
            characters.forEach(char => {
                const store = new CharacterStore(char.id);
                const chatMemories = store.getMemories();
                const baseMemories = char.base.memories || [];
                const allMemories = [...chatMemories, ...baseMemories];

                if (allMemories.length > 0) {
                    result.push({
                        id: char.id,
                        name: char.base.name,
                        emoji: char.base.emoji,
                        memories: allMemories
                    });
                }
            });
        }
    } catch (e) { /* 忽略 */ }

    // ② 从 NPC（char_ 开头的 localStorage）读取
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('char_')) {
                const id = key.replace('char_', '');
                if (!result.some(c => c.id === id)) {
                    const store = new CharacterStore(id);
                    const info = store.getInfo();
                    const memories = store.getMemories();
                    if (info.name && memories.length > 0) {
                        result.push({
                            id: id,
                            name: info.name,
                            emoji: info.emoji || '💬',
                            memories: memories
                        });
                    }
                }
            }
        }
    } catch (e) { /* 忽略 */ }

    return result;
}

// ---- 渲染函数 ----
export function render() {
    // 如果正在查看某个角色的记忆，显示详情页
    if (viewingCharacterId !== null) {
        return renderCharacterMemories(viewingCharacterId);
    }

    // 否则显示列表页
    const characters = getAllCharactersWithMemories();

    if (characters.length === 0) {
        return `
            <div class="screen-page">
                <div class="screen-header">
                    <div class="screen-title">${title}</div>
                    <div class="header-spacer"></div>
                </div>
                <div class="screen-content">
                    <div class="page-card">
                        <p style="text-align:center; color:#888; padding:20px 0;">
                            📭 暂无记忆<br>
                            <span style="font-size:13px;">去聊天试试？对话会自动保存为角色的记忆。</span>
                        </p>
                    </div>
                </div>
            </div>
        `;
    }

    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">${title}</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card">
                    <p style="margin-bottom:12px; color:#666;">点击角色查看其记忆：</p>
                    <div class="memory-character-list">
                        ${characters.map(char => `
                            <div class="memory-char-item" data-id="${char.id}" style="
                                display:flex; align-items:center; gap:12px;
                                padding:12px 16px; margin-bottom:8px;
                                background:white; border-radius:14px;
                                box-shadow:0 1px 4px rgba(0,0,0,0.08);
                                cursor:pointer; transition:all 0.2s;
                            ">
                                <span style="font-size:28px;">${char.emoji}</span>
                                <div style="flex:1;">
                                    <div style="font-weight:600; font-size:15px;">${char.name}</div>
                                    <div style="font-size:12px; color:#999;">${char.memories.length} 条记忆</div>
                                </div>
                                <span style="color:#ccc;">›</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>
        </div>
    `;
}

// ---- 渲染某个角色的记忆详情页 ----
function renderCharacterMemories(charId) {
    const store = new CharacterStore(charId);
    const info = store.getInfo();
    const chatMemories = store.getMemories();

    // 也读一下角色名册里的 base.memories
    let baseMemories = [];
    try {
        const roleData = localStorage.getItem('rolebook_characters');
        if (roleData) {
            const characters = JSON.parse(roleData);
            const found = characters.find(c => c.id === charId);
            if (found && found.base.memories) {
                baseMemories = found.base.memories;
            }
        }
    } catch (e) { /* 忽略 */ }

    const allMemories = [...chatMemories, ...baseMemories];
    const charName = info.name || charId;
    const charEmoji = info.emoji || '💬';

    // 按时间倒序排列
    allMemories.sort((a, b) => {
        const timeA = a.time || '';
        const timeB = b.time || '';
        return timeB.localeCompare(timeA);
    });

    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">${charEmoji} ${charName}</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card">
                    ${allMemories.length === 0 ? `
                        <p style="text-align:center; color:#888; padding:20px 0;">暂无记忆</p>
                    ` : `
                        <div style="position:relative; padding-left:20px; border-left:2px solid #e0e0e0;">
                            ${allMemories.map(m => `
                                <div style="margin-bottom:16px; position:relative;">
                                    <div style="
                                        position:absolute; left:-26px; top:4px;
                                        width:12px; height:12px; border-radius:50%;
                                        background:#607d8b; border:2px solid white;
                                        box-shadow:0 0 0 2px #607d8b;
                                    "></div>
                                    <div style="font-size:12px; color:#999; margin-bottom:2px;">${m.time || '未知时间'}</div>
                                    <div style="font-size:14px; color:#333; line-height:1.5;">${m.content || m.text || ''}</div>
                                </div>
                            `).join('')}
                        </div>
                    `}
                </div>
            </div>
        </div>
    `;
}

// ---- 事件绑定 ----
export function bindEvents(container) {
    // 只有在列表页才绑定点角色事件
    if (viewingCharacterId === null) {
        container.querySelectorAll('.memory-char-item').forEach(item => {
            item.addEventListener('click', function() {
                viewingCharacterId = this.dataset.id;
                const appContainer = container.closest('.screen-page') || container;
                appContainer.innerHTML = render();
                bindEvents(appContainer);
            });
        });
    }
}

// ---- 拦截全局返回键 ----
export function handleBack(container) {
    if (viewingCharacterId !== null) {
        viewingCharacterId = null;
        const appContainer = container.closest('.screen-page') || container;
        appContainer.innerHTML = render();
        bindEvents(appContainer);
        return true;  // 表示已处理，app.js 不用再执行默认返回
    }
    return false;  // 没处理，让 app.js 执行默认返回
}

if (!window.__moduleRegistry) window.__moduleRegistry = [];
window.__moduleRegistry.push({ id, label, icon, color, render, bindEvents, handleBack });

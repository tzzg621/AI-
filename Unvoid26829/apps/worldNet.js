// apps/worldNet.js

import { CharacterStore, addBidirectionalFriend } from '../store/CharacterStore.js';
import { clearImageCache, getPortraitHtml, setImage } from '../store/ImageCache.js';
import { esc } from '../store/utils.js';
import { showAlert, showConfirm } from '../store/dialog.js';
import { createCharacterFromNpc } from './characterCreator.js';
import { archiveCharacter, deleteCharacterDeep } from './roleData.js';
import {
    renderWorldNetGraph,
    mountWorldNetGraph,
    unmountWorldNetGraph
} from './worldNetGraphDemo.js';

export const id = 'worldNetPage';
export const label = '角色网络';
export const icon = '🌐';
export const color = '#ff9800';
export const title = '🌐 世界角色网络';
export const memoryOptions = {
    mode: 'manual',
    description: '可将世界角色网络内容手动保存为记忆。',
    enabled: true
};


const STORAGE_KEY_EXTRA = 'worldnet_extra_characters';

function loadExtraNpcs() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY_EXTRA);
        if (saved) return JSON.parse(saved);
    } catch { }
    return [];
}


// 动态合并函数
let npcs = [];
function rebuildNpcList() {
    npcs = [...loadExtraNpcs()];   // ★ 只加载用户创建的 NPC
}
rebuildNpcList();  // 模块初始化时合并一次

// ★ 初始化：确保每个 NPC 的显示信息已存储到 CharacterStore
function ensureNpcInfoStored() {
    rebuildNpcList();  // ← 加这一行，确保合并
    npcs.forEach(npc => {
        const store = new CharacterStore(npc.id);
        const info = store.getInfo();
        if (!info.name) {
            store.setInfo({
                name: npc.base.name,
                emoji: npc.base.emoji,
                desc: npc.base.desc,
                type: npc.type,
                label: npc.flags.label || ''
            });
        }
    });
}

ensureNpcInfoStored();

// ---- 添加为联系人 ----
function addNpcAsFriend(npcId, npcName) {
    const activeIndex = parseInt(localStorage.getItem('rolebook_activeIndex') || '-1');
    if (activeIndex < 0) return false;

    let activeChar = null;
    try {
        const chars = JSON.parse(localStorage.getItem('rolebook_characters') || '[]');
        activeChar = chars[activeIndex] || null;
    } catch (e) { }

    if (!activeChar) return false;

    const activeId = activeChar.id || activeChar.base.name;
    return addBidirectionalFriend(activeId, npcId);
}

function isNpcFriend(npcId) {
    const activeIndex = parseInt(localStorage.getItem('rolebook_activeIndex') || '-1');
    if (activeIndex < 0) return false;
    try {
        const chars = JSON.parse(localStorage.getItem('rolebook_characters') || '[]');
        const activeChar = chars[activeIndex];
        if (activeChar) {
            const activeId = activeChar.id || activeChar.base.name;
            const store = new CharacterStore(activeId);
            return store.isFriend(npcId);
        }
    } catch (e) { }
    return false;
}

// ---- 已转化记录 ----
const CONVERTED_KEY = 'worldnet_converted';

function getConvertedIds() {
    const saved = localStorage.getItem(CONVERTED_KEY);
    if (saved) {
        try { return JSON.parse(saved); } catch (e) { }
    }
    return [];
}

function saveConvertedIds(ids) {
    localStorage.setItem(CONVERTED_KEY, JSON.stringify(ids));
}

// ---- 默认角色数据 ----
function getDefaultCharacters() {
    return [
        {
            id: 'default-hero',
            name: '主角',
            emoji: '👑',
            desc: '世界的核心人物，命运之线的编织者。',
            stats: { 力量: 70, 智力: 85, 魅力: 90 },
            secret: '内心深处惧怕自己配不上"主角"的身份，害怕某天被所有人看穿。',
            style: '语气坚定，偶尔流露出孤独感，习惯用"我们"而不是"我"。',
            memories: [
                { time: '2026-07-01', content: '在古塔顶端第一次看见世界的全貌，意识到自己肩负的责任。' },
                { time: '2026-06-28', content: '与法师在月光下交谈，得知关于远古诅咒的秘密。' }
            ]
        },
        {
            id: 'default-mage',
            name: '法师',
            emoji: '🧙',
            desc: '精通元素魔法，掌握古老咒语。',
            stats: { 力量: 40, 智力: 95, 魅力: 65 },
            secret: '曾因实验失控导致一座城镇毁灭，至今未向任何人提起。',
            style: '说话带书卷气，喜欢用比喻，偶尔会自言自语念咒语。',
            memories: [
                { time: '2026-06-25', content: '在禁书区发现了一本记载着时空魔法的古籍。' },
                { time: '2026-06-20', content: '用魔法为主角占卜，看到了一片模糊的血色未来。' }
            ]
        },
        {
            id: 'default-archer',
            name: '弓手',
            emoji: '🏹',
            desc: '百步穿杨的神射手，林间漫步的精灵。',
            stats: { 力量: 75, 智力: 60, 魅力: 80 },
            secret: '并非纯血精灵，体内流淌着一半暗夜族的血液，一直在隐藏这个身份。',
            style: '话语简洁直接，不爱长篇大论，但关键时刻总能一语中的。',
            memories: [
                { time: '2026-06-30', content: '在暮色森林中独自追踪一只发狂的魔兽，发现它被某种黑暗力量控制。' },
                { time: '2026-06-22', content: '教主角射箭时，不经意间露出的暗夜族身法令自己后怕。' }
            ]
        }
    ];
}

// ---- 渲染 NPC 卡片 ----
// ---- 联系人 / 归档 / 删除 操作组（普通、可转化、已转化、特殊共用） ----
function renderContactActions(npc, index, hasActiveChar) {
    if (!hasActiveChar) {
        return `
            <div class="wn-hint">
                ⚠️ 请先在角色名册中设置主视角角色
            </div>
        `;
    }

    if (isNpcFriend(npc.id)) {
        return `
            <button class="wn-btn wn-btn--muted wn-btn--block" disabled>
                ✅ 已是联系人
            </button>
        `;
    }

    return `
        <button
            class="add-friend-from-npc-btn wn-btn wn-btn--outline wn-btn--block"
            data-npc-index="${index}"
        >➕ 添加为联系人</button>
        <div class="wn-action-row">
            <button
                class="npc-archive-btn wn-btn wn-btn--warn"
                data-npc-index="${index}"
            >📦 归档</button>
            <button
                class="npc-delete-btn wn-btn wn-btn--danger"
                data-npc-index="${index}"
            >🗑️ 删除</button>
        </div>
    `;
}

// ---- 卡片头部（头像 + 名称 + 状态角标 + 描述） ----
function renderCardHead(npc, { avatarClass, badge }) {
    return `
        <div class="wn-card-head">
            <div class="${avatarClass} wn-avatar" data-npc-id="${npc.id}">
                ${getPortraitHtml(npc.id)}
            </div>
            <div class="wn-card-meta">
                <div class="wn-card-title">
                    <span class="wn-card-name">${esc(npc.base.name)}</span>
                    ${badge}
                </div>
                <p class="wn-card-desc">${esc(npc.base.desc)}</p>
            </div>
        </div>
    `;
}

// ---- NPC 卡片（统一模板 + 状态修饰） ----
function createNPCCardHTML(npc, index, isConverted) {
    // 已归档：灰卡，只保留删除
    if (npc.archived) {
        return `
            <article
                class="world-entry wn-card wn-card--archived"
                data-npc-index="${index}"
            >
                ${renderCardHead(npc, {
            avatarClass: 'worldnet-portrait-disabled',
            badge: '<span class="wn-badge wn-badge--archived">📦 已归档</span>'
        })}
                <div class="wn-card-body">
                    <button
                        class="npc-delete-btn wn-btn wn-btn--danger wn-btn--block"
                        data-npc-index="${index}"
                    >🗑️ 删除</button>
                </div>
            </article>
        `;
    }

    const hasActiveChar = (() => {
        const idx = parseInt(localStorage.getItem('rolebook_activeIndex') || '-1');
        if (idx < 0) return false;
        try {
            const chars = JSON.parse(localStorage.getItem('rolebook_characters') || '[]');
            return chars[idx] != null;
        } catch (e) {
            return false;
        }
    })();

    // 特殊角色（不可转化）
    if (npc.type === 'special' && !npc.flags.convertible) {
        return `
            <article
                class="world-entry wn-card wn-card--special"
                data-npc-index="${index}"
            >
                ${renderCardHead(npc, {
            avatarClass: 'worldnet-portrait',
            badge: `<span class="wn-badge wn-badge--special">🔒 ${esc(npc.flags.label || '特殊角色')}</span>`
        })}
                <div class="wn-card-body">
                    ${renderContactActions(npc, index, hasActiveChar)}
                </div>
            </article>
        `;
    }

    // 已转化
    if (isConverted) {
        return `
            <article
                class="world-entry wn-card wn-card--converted"
                data-npc-index="${index}"
            >
                ${renderCardHead(npc, {
            avatarClass: 'worldnet-portrait',
            badge: '<span class="wn-badge wn-badge--converted">✅ 已转化</span>'
        })}
                <div class="wn-card-body">
                    ${renderContactActions(npc, index, hasActiveChar)}
                </div>
            </article>
        `;
    }

    // 可转化（常规 / 非常规）
    const isUnconventional = npc.type === 'unconventional';
    const typeBadge = isUnconventional
        ? '<span class="wn-badge wn-badge--unconventional">⚡ 非常规角色</span>'
        : '<span class="wn-badge wn-badge--regular">📋 常规角色</span>';

    return `
        <article
            class="world-entry wn-card wn-card--convertible"
            data-npc-index="${index}"
        >
            ${renderCardHead(npc, {
        avatarClass: 'worldnet-portrait',
        badge: typeBadge
    })}
            <div class="wn-card-body">
                <button
                    class="convert-btn wn-btn wn-btn--primary wn-btn--block"
                    data-npc-index="${index}"
                >➕ 转化为角色卡</button>
                ${renderContactActions(npc, index, hasActiveChar)}
            </div>
        </article>
    `;
}

// ---- ★ 转化确认页面 ----
function renderConfirmPage(npc, memoryService) {
    const canCustomize = npc.flags.customizable;

    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">✨ 角色卡确认</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card wn-confirm">
                    <p class="wn-confirm-lead">
                        ${canCustomize
            ? '原始设定已保留，可补充以下详细信息。'
            : '确认后将直接转化为角色卡，内容不可修改。'}
                    </p>

                    <section class="wn-panel wn-panel--readonly">
                        <div class="wn-panel-title">📋 原始设定（不可修改）</div>

                        <div class="wn-identity">
                            <span class="wn-identity-emoji">${esc(npc.base.emoji)}</span>
                            <div class="wn-identity-name">${esc(npc.base.name)}</div>
                        </div>

                        <div class="wn-field">
                            <div class="wn-field-label">简介</div>
                            <div class="wn-field-value">${esc(npc.base.desc || '无')}</div>
                        </div>

                        <div class="wn-field">
                            <div class="wn-field-label">📊 属性</div>
                            <div class="wn-stats">
                                ${Object.entries(npc.base.stats || {}).map(([key, val]) => `
                                    <span class="wn-stat">
                                        ${esc(key)}: <strong>${esc(val)}</strong>
                                    </span>
                                `).join('') || '<span class="wn-stat">无</span>'}
                            </div>
                        </div>

                        <div class="wn-field">
                            <div class="wn-field-label">🔒 内心秘密</div>
                            <div class="wn-field-value">${esc(npc.base.secret || '无')}</div>
                        </div>

                        <div class="wn-field">
                            <div class="wn-field-label">🗣️ 说话风格</div>
                            <div class="wn-field-value">${esc(npc.base.style || '无')}</div>
                        </div>
                    </section>

                    ${canCustomize ? `
                        <section class="wn-panel wn-panel--edit">
                            <div class="wn-panel-title">✏️ 补充详细信息（可选）</div>

                            <div class="wn-field">
                                <div class="wn-field-label">详细背景故事</div>
                                <textarea id="newBackstory" class="wn-textarea" rows="3"
                                          placeholder="可以在这里补充角色的更多背景故事……"></textarea>
                            </div>

                            <div class="wn-field">
                                <div class="wn-field-label">专属技能 / 能力</div>
                                <input type="text" id="newSkills" class="wn-input"
                                       placeholder="例如：火焰魔法、剑术精通……">
                            </div>

                            <div class="wn-field">
                                <div class="wn-field-label">人际关系</div>
                                <input type="text" id="newRelations" class="wn-input"
                                       placeholder="例如：与主角是旧识，与法师有恩怨……">
                            </div>
                        </section>
                    ` : `
                        <div class="wn-note">
                            ⚡ 非常规角色，转化后不可编辑设定。
                        </div>
                    `}

                    <button id="confirmConvertBtn" class="wn-confirm-submit">
                        ✅ 确认转化
                    </button>
                </div>
            </div>
        </div>
    `;
}

function getActiveCharacterIdFromStorage() {
    try {
        const index = parseInt(
            localStorage.getItem('rolebook_activeIndex') || '-1',
            10
        );

        const characters = JSON.parse(
            localStorage.getItem('rolebook_characters') || '[]'
        );

        return characters[index]?.id || null;
    } catch {
        return null;
    }
}

export function render({ memoryService }) {
    rebuildNpcList();  // ← 加这一行，切页面时读最新数据
    const convertedIds = getConvertedIds();

    return `
    <div class="screen-page">
        <div class="screen-header">
            <div class="screen-title">${title}</div>
            <div class="header-spacer"></div>
        </div>
        <div class="screen-content">
            <div class="page-card wn-page">
                <div class="wn-graph-style-setting">
                    <div>
                        <strong>关系网样式</strong>
                        <span>关系网样式将在下次进入角色网络时生效</span>
                    </div>    
                    <select
                        id="worldnetGraphStyle"
                        class="wn-input"
                    >    
                        <option
                            value="demo"
                            ${getWorldNetGraphVersion() === 'demo'
            ? 'selected'
            : ''
        }   
                        >   
                            动态版  
                        </option>    
                        <option
                            value="classic"
                            ${getWorldNetGraphVersion() === 'classic'
            ? 'selected'
            : ''
        }  
                        >    
                            标准版
                        </option>   
                    </select>        
                </div>    
                 ${renderWorldNetGraph({
            activeId: getActiveCharacterIdFromStorage()
        })}    

                <div class="wn-section-head">
                    <div>
                        <strong>角色管理</strong>
                        <span>NPC 转化、归档、删除与联系人操作</span>
                    </div>
                    <span class="wn-count">共 ${npcs.length}</span>
                </div>

                <p class="wn-intro">没有角色卡的 NPC 可以转变为角色卡。</p>

                <div class="wn-list">
                    ${npcs.map((npc, index) => {
            const isConverted = getConvertedIds().includes(npc.id);
            if (isConverted) return '';
            return createNPCCardHTML(npc, index, isConverted);
        }).join('')}
                </div>
            </div>
        </div>
    </div>
`;
}

export function bindEvents(container, { memoryService }) {
    mountWorldNetGraph(container, {
        activeId: getActiveCharacterIdFromStorage()
    });
    const graphStyleSelect =
        container.querySelector(
            '#worldnetGraphStyle'
        );

    if (graphStyleSelect) {
        graphStyleSelect.value =
            getWorldNetGraphVersion();

        graphStyleSelect.addEventListener(
            'change',
            () => {
                const version =
                    setWorldNetGraphVersion(
                        graphStyleSelect.value
                    );

                graphStyleSelect.value = version;

                showAlert(
                    '请退出并重新进入角色网络以应用样式'
                );
            }
        );
    }

    // ---- ★ 转化确认页面的事件 ----
    const confirmBtn = container.querySelector('#confirmConvertBtn');
    if (confirmBtn) {
        const npcIndex = window.__confirmNpcIndex;
        if (npcIndex !== undefined && npcIndex !== null) {
            const npc = npcs[npcIndex];
            if (npc) {
                confirmBtn.addEventListener('click', () => {
                    const STORAGE_KEY = 'rolebook_characters';
                    let characters = [];
                    const saved = localStorage.getItem(STORAGE_KEY);
                    if (saved) {
                        try { characters = JSON.parse(saved); } catch (e) { }
                    }
                    if (characters.length === 0) {
                        characters = getDefaultCharacters();
                    }

                    if (characters.some(c => c.id === npc.id)) {
                        showAlert(`${npc.base.name} 已经是角色卡了！`);
                        return;
                    }

                    // 使用统一结构创建角色
                    const newCharacter = createCharacterFromNpc(npc);

                    characters.push(newCharacter);
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(characters));

                    const convertedIds = getConvertedIds();
                    convertedIds.push(npc.id);
                    saveConvertedIds(convertedIds);

                    window.__confirmNpcIndex = null;
                    showAlert(`✅ ${npc.base.name} 已成功转化为角色卡！`);

                    const appContainer = container.closest('.screen-page') || container;
                    appContainer.innerHTML = render({ memoryService });
                    bindEvents(appContainer, { memoryService });
                });
            }
        }
        return;
    }

    // ---- 列表页事件 ----
    container.querySelectorAll('.convert-btn').forEach(btn => {
        btn.addEventListener('click', function () {
            const index = parseInt(this.dataset.npcIndex);
            window.__confirmNpcIndex = index;
            const npc = npcs[index];
            if (!npc) return;
            const appContainer = container.closest('.screen-page') || container;
            appContainer.innerHTML = renderConfirmPage(npc, memoryService);
            bindEvents(appContainer, { memoryService });
        });
    });

    // ★ NPC 归档 / 删除
    container.querySelectorAll('.npc-archive-btn').forEach(btn => {
        btn.addEventListener('click', async function () {
            const npc = npcs[parseInt(this.dataset.npcIndex)];
            if (!npc) return;
            await archiveCharacter(npc.id);
            showAlert(`📦 已归档「${npc.base.name}」`);
            rebuildNpcList();
            const appContainer = container.closest('.screen-page') || container;
            appContainer.innerHTML = render({ memoryService });
            bindEvents(appContainer, { memoryService });
        });
    });
    container.querySelectorAll('.npc-delete-btn').forEach(btn => {
        btn.addEventListener('click', async function () {
            const npc = npcs[parseInt(this.dataset.npcIndex)];
            if (!npc) return;
            const ok = await showConfirm(`确定彻底删除「${npc.base.name}」？将删除其全部数据。`);
            if (!ok) return;
            await deleteCharacterDeep(npc.id);
            showAlert(`🗑️ 已彻底删除「${npc.base.name}」`);
            rebuildNpcList();
            const appContainer = container.closest('.screen-page') || container;
            appContainer.innerHTML = render({ memoryService });
            bindEvents(appContainer, { memoryService });
        });
    });

    container.querySelectorAll('.add-friend-from-npc-btn').forEach(btn => {
        btn.addEventListener('click', function () {
            const index = parseInt(this.dataset.npcIndex);
            const npc = npcs[index];
            if (!npc) return;

            const success = addNpcAsFriend(npc.id, npc.base.name);
            if (success) {
                this.textContent = '✅ 已是联系人';
                this.disabled = true;
                // 从描边样式切换成禁用态样式
                this.classList.remove('wn-btn--outline');
                this.classList.add('wn-btn--muted');
            }
        });
    });

    // ★ NPC 形象卡上传
    container.querySelectorAll('.worldnet-portrait').forEach(el => {
        el.addEventListener('click', function () {
            const npcId = this.dataset.npcId;
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.onchange = (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (ev) => {
                    const dataUrl = ev.target.result;
                    setImage(npcId, 'portrait', dataUrl);
                    // 重新渲染列表
                    const appContainer = container.closest('.screen-page') || container;
                    appContainer.innerHTML = render({ memoryService });
                    bindEvents(appContainer, { memoryService });
                };
                reader.readAsDataURL(file);
            };
            input.click();
        });
    });

}

export function handleBack(container) {
    unmountWorldNetGraph(container);
    return false;
}

if (!window.__moduleRegistry) window.__moduleRegistry = [];
window.__moduleRegistry.push({
    id,
    label,
    icon,
    color,
    render,
    bindEvents,
    handleBack
});

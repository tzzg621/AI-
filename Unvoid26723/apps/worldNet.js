import { CharacterStore, addBidirectionalFriend, createDefaultCharacterData } from '../store/CharacterStore.js';
import { clearImageCache, getPortraitHtml, setImage } from '../store/ImageCache.js';


export const id = 'worldNetPage';
export const label = '世界角色网络';
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
    } catch {}
    return [];
}

// ---- NPC 数据（扩充分类） ----
const BUILTIN_NPCS = [
    createDefaultCharacterData('farmer', {
        name: '张三',
        emoji: '🧑‍🌾',
        desc: '善良的农夫，日出而作，日落而息。',
        stats: { 体力: 80, 智慧: 45, 魅力: 55 },
        secret: '年轻时曾是一名冒险者，因一次失败而隐居。',
        style: '说话朴实，偶尔露出沧桑。',
        memories: [
            { time: '2026-07-01', content: '在田里捡到一块发光的石头，藏在了床底。' }
        ]
    }, 'npc', {
        convertible: true,
        customizable: true
    }),
    createDefaultCharacterData('doctor', {
        name: '李四',
        emoji: '👩‍⚕️',
        desc: '医术高明的游方医生，救死扶伤。',
        stats: { 体力: 50, 智慧: 90, 魅力: 70 },
        secret: '掌握一种禁忌的治疗术，使用后会损耗自身寿命。',
        style: '温柔而坚定，从不透露病人的秘密。',
        memories: [
            { time: '2026-06-28', content: '治好了村长的怪病，得到了一个古老的药方。' }
        ]
    }, 'npc', {
        convertible: true,
        customizable: true
    }),
    createDefaultCharacterData('ancient-dragon', {
        name: '远古龙魂',
        emoji: '🐉',
        desc: '沉睡了千年的远古龙魂，世界规则的守护者。',
        stats: { 力量: 99, 智慧: 99, 魅力: 99 },
        secret: '它知晓这个世界的真实起源，但从不直言。',
        style: '话语如同雷鸣，每个字都带着古老的回响。',
        memories: [
            { time: '远古', content: '见证了这个世界的诞生。' }
        ]
    }, 'special', {
        convertible: false,
        switchable: false,
        customizable: false,
        label: '特殊角色·不可转化'
    })
];

// 动态合并函数
let npcs = [];
function rebuildNpcList() {
    npcs = [...BUILTIN_NPCS, ...loadExtraNpcs()];
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
function createNPCCardHTML(npc, index, isConverted) {
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

    // 特殊角色
    if (npc.type === 'special') {
        return `
            <div class="world-entry" data-npc-index="${index}" 
                 style="display:flex; flex-direction:column; gap:8px; opacity:0.7;">
                <div style="display:flex; align-items:center; gap:10px;">
<div class="worldnet-portrait" data-npc-id="${npc.id}" style="width:48px; height:48px; border-radius:12px; overflow:hidden; flex-shrink:0; background:#e0e0e0; cursor:pointer;">
    ${getPortraitHtml(npc.id)}
</div>
                    <div>
                        <div style="font-weight:600;">${npc.base.name}</div>
                        <div style="font-size:13px; color:#666;">${npc.base.desc}</div>
                        <div style="font-size:12px; color:#9c27b0; margin-top:2px;">🔒 ${npc.flags.label || '特殊角色·不可转化'}</div>
                    </div>
                </div>
${!hasActiveChar ? `
    <button disabled style="width:100%; padding:8px; border-radius:12px; border:1px solid #ccc; 
           background:#f5f5f5; color:#999; cursor:not-allowed; font-size:12px; margin-top:8px;">
        ⚠️ 请先在角色名册中设置主视角角色
    </button>
` : (isNpcFriend(npc.id) ? `
    <button disabled style="width:100%; padding:8px; border-radius:12px; border:1px solid #ccc; 
           background:#f5f5f5; color:#888; cursor:not-allowed; font-size:12px; margin-top:8px;">
        ✅ 已是联系人
    </button>
` : `
    <button class="add-friend-from-npc-btn" data-npc-index="${index}"
            style="width:100%; padding:8px; border-radius:12px; border:1px solid #0b93f6; 
                   background:white; color:#0b93f6; cursor:pointer; font-size:12px; margin-top:8px;">
        ➕ 添加为联系人
    </button>
`)}
            </div>
        `;
    }

    // 已转化的 NPC
    if (isConverted) {
        return `
            <div class="world-entry" data-npc-index="${index}" 
                 style="display:flex; flex-direction:column; gap:8px; opacity:0.5;">
                <div style="display:flex; align-items:center; gap:10px;">
                    <div class="worldnet-portrait" data-npc-id="${npc.id}" style="width:48px; height:48px; border-radius:12px; overflow:hidden; flex-shrink:0; background:#e0e0e0; cursor:pointer;">
    ${getPortraitHtml(npc.id)}
</div>

                    <div>
                        <div style="font-weight:600;">${npc.base.name}</div>
                        <div style="font-size:13px; color:#666;">${npc.base.desc}</div>
                    </div>
                </div>
                <button disabled
                        style="padding:8px; border-radius:12px; border:none; 
                               background:#ccc; color:#666; cursor:not-allowed; font-size:13px;">
                    ✅ 已转化为角色卡
                </button>
${!hasActiveChar ? `
    <button disabled style="width:100%; padding:8px; border-radius:12px; border:1px solid #ccc; 
           background:#f5f5f5; color:#999; cursor:not-allowed; font-size:12px; margin-top:8px;">
        ⚠️ 请先在角色名册中设置主视角角色
    </button>
` : (isNpcFriend(npc.id) ? `
    <button disabled style="width:100%; padding:8px; border-radius:12px; border:1px solid #ccc; 
           background:#f5f5f5; color:#888; cursor:not-allowed; font-size:12px; margin-top:8px;">
        ✅ 已是联系人
    </button>
` : `
    <button class="add-friend-from-npc-btn" data-npc-index="${index}"
            style="width:100%; padding:8px; border-radius:12px; border:1px solid #0b93f6; 
                   background:white; color:#0b93f6; cursor:pointer; font-size:12px; margin-top:8px;">
        ➕ 添加为联系人
    </button>
`)}
            </div>
        `;
    }

    // 可转化的 NPC
    return `
        <div class="world-entry" data-npc-index="${index}" 
             style="display:flex; flex-direction:column; gap:8px;">
            <div style="display:flex; align-items:center; gap:10px;">
                <div class="worldnet-portrait" data-npc-id="${npc.id}" style="width:48px; height:48px; border-radius:12px; overflow:hidden; flex-shrink:0; background:#e0e0e0; cursor:pointer;">
    ${getPortraitHtml(npc.id)}
</div>

                <div>
                    <div style="font-weight:600;">${npc.base.name}</div>
                    <div style="font-size:13px; color:#666;">${npc.base.desc}</div>
                    <div style="font-size:12px; color:#ff9800; margin-top:2px;">
                        ${npc.type === 'unconventional' ? '⚡ 非常规角色' : '📋 常规角色'}
                    </div>
                </div>
            </div>
            <div style="display:flex; gap:8px;">
                <button class="convert-btn" data-npc-index="${index}"
                        style="flex:1; padding:8px; border-radius:12px; border:none; 
                               background:#ff9800; color:white; cursor:pointer; font-size:13px;">
                    ➕ 转化为角色卡
                </button>
            </div>
${!hasActiveChar ? `
    <button disabled style="width:100%; padding:8px; border-radius:12px; border:1px solid #ccc; 
           background:#f5f5f5; color:#999; cursor:not-allowed; font-size:12px; margin-top:8px;">
        ⚠️ 请先在角色名册中设置主视角角色
    </button>
` : (isNpcFriend(npc.id) ? `
    <button disabled style="width:100%; padding:8px; border-radius:12px; border:1px solid #ccc; 
           background:#f5f5f5; color:#888; cursor:not-allowed; font-size:12px; margin-top:8px;">
        ✅ 已是联系人
    </button>
` : `
    <button class="add-friend-from-npc-btn" data-npc-index="${index}"
            style="width:100%; padding:8px; border-radius:12px; border:1px solid #0b93f6; 
                   background:white; color:#0b93f6; cursor:pointer; font-size:12px; margin-top:8px;">
        ➕ 添加为联系人
    </button>
`)}
        </div>
    `;
}

// ---- ★ 转化确认页面 ----
function renderConfirmPage(npc, memoryService) {
    const canCustomize = npc.flags.customizable;
    const readOnlyStyle = 'background:#f5f5f5; color:#888; cursor:not-allowed; border:1px solid #ddd;';

    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">✨ 角色卡确认</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content" style="overflow-y:auto;">
                <div class="page-card">
                    <p style="margin-bottom:12px; color:#666;">
                        ${canCustomize ? '原始设定已保留，可补充以下详细信息。' : '确认后将直接转化为角色卡，内容不可修改。'}
                    </p>

                    <div style="background:#fff8e1; border-radius:12px; padding:12px; margin-bottom:16px;">
                        <div style="font-weight:600; margin-bottom:8px; color:#e65100;">📋 原始设定（不可修改）</div>
                        
                        <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
                            <span style="font-size:40px;">${npc.base.emoji}</span>
                            <div style="flex:1; font-size:18px; font-weight:600; word-break:break-word; overflow-y:auto; max-height:60px; line-height:1.3;">${npc.base.name}</div>
                        </div>
                        
                        <textarea rows="2" readonly
                                  style="width:100%; padding:8px; border-radius:8px; ${readOnlyStyle} font-size:13px; margin-bottom:8px;">${npc.base.desc}</textarea>

                        <div style="font-size:13px; color:#666; margin-bottom:4px;">📊 属性</div>
                        <div style="display:flex; gap:16px; margin-bottom:8px; flex-wrap:wrap;">
                            ${Object.entries(npc.base.stats || {}).map(([key, val]) => `
                                <span style="background:#fff; padding:4px 10px; border-radius:8px; font-size:13px;">
                                    ${key}: <strong>${val}</strong>
                                </span>
                            `).join('')}
                        </div>

                        <div style="margin-bottom:4px;">
                            <div style="font-size:13px; color:#666;">🔒 内心秘密</div>
                            <div style="font-size:13px; background:#fff; padding:6px 10px; border-radius:8px; margin-top:2px;">${npc.base.secret || '无'}</div>
                        </div>
                        <div style="margin-bottom:4px;">
                            <div style="font-size:13px; color:#666;">🗣️ 说话风格</div>
                            <div style="font-size:13px; background:#fff; padding:6px 10px; border-radius:8px; margin-top:2px;">${npc.base.style || '无'}</div>
                        </div>
                    </div>

                    ${canCustomize ? `
                        <div style="background:#e3f2fd; border-radius:12px; padding:12px; margin-bottom:16px;">
                            <div style="font-weight:600; margin-bottom:8px; color:#1565c0;">✏️ 补充详细信息（可选）</div>
                            
                            <div style="margin-bottom:8px;">
                                <div style="font-size:13px; color:#666; margin-bottom:2px;">详细背景故事</div>
                                <textarea id="newBackstory" rows="3" placeholder="可以在这里补充角色的更多背景故事……"
                                          style="width:100%; padding:8px; border-radius:8px; border:1px solid #ccc; font-size:13px;"></textarea>
                            </div>
                            
                            <div style="margin-bottom:8px;">
                                <div style="font-size:13px; color:#666; margin-bottom:2px;">专属技能 / 能力</div>
                                <input type="text" id="newSkills" placeholder="例如：火焰魔法、剑术精通……"
                                       style="width:100%; padding:8px; border-radius:8px; border:1px solid #ccc; font-size:13px;">
                            </div>
                            
                            <div>
                                <div style="font-size:13px; color:#666; margin-bottom:2px;">人际关系</div>
                                <input type="text" id="newRelations" placeholder="例如：与主角是旧识，与法师有恩怨……"
                                       style="width:100%; padding:8px; border-radius:8px; border:1px solid #ccc; font-size:13px;">
                            </div>
                        </div>
                    ` : `
                        <div style="background:#f5f5f5; border-radius:12px; padding:12px; margin-bottom:16px; text-align:center; color:#888;">
                            ⚡ 非常规角色，转化后不可编辑设定。
                        </div>
                    `}

                    <button id="confirmConvertBtn" style="width:100%; padding:12px; border-radius:24px; border:none; 
                            background:#ff9800; color:white; cursor:pointer; font-size:16px; font-weight:600;">
                        ✅ 确认转化
                    </button>
                </div>
            </div>
        </div>
    `;
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
                <div class="page-card">
                    <p>没有角色卡的NPC可以转变为角色卡。</p>
                    <div class="npc-list" style="margin-top:12px; display:flex; flex-direction:column; gap:12px;">
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
                        alert(`${npc.base.name} 已经是角色卡了！`);
                        return;
                    }

                    // 使用统一结构创建角色
                    const newCharacter = createDefaultCharacterData(
                        npc.id,
                        {
                            name: npc.base.name,
                            emoji: npc.base.emoji,
                            desc: npc.base.desc,
                            stats: { ...npc.base.stats },
                            secret: npc.base.secret,
                            style: npc.base.style,
                            memories: npc.base.memories ? [...npc.base.memories] : []
                        },
                        'character',  // 转化为角色卡
                        { switchable: true }
                    );

                    // 补充转化时填写的扩展信息
                    newCharacter.extended.backstory = container.querySelector('#newBackstory')?.value?.trim() || '';
                    newCharacter.extended.skills = container.querySelector('#newSkills')?.value?.trim() || '';
                    newCharacter.extended.relations = container.querySelector('#newRelations')?.value?.trim() || '';

                    characters.push(newCharacter);
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(characters));

                    const convertedIds = getConvertedIds();
                    convertedIds.push(npc.id);
                    saveConvertedIds(convertedIds);

                    window.__confirmNpcIndex = null;
                    alert(`✅ ${npc.base.name} 已成功转化为角色卡！`);

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

    container.querySelectorAll('.add-friend-from-npc-btn').forEach(btn => {
        btn.addEventListener('click', function () {
            const index = parseInt(this.dataset.npcIndex);
            const npc = npcs[index];
            if (!npc) return;

            const success = addNpcAsFriend(npc.id, npc.base.name);
            if (success) {
                this.textContent = '✅ 已是联系人';
                this.disabled = true;
                this.style.borderColor = '#ccc';
                this.style.background = '#f5f5f5';
                this.style.color = '#888';
                this.style.cursor = 'not-allowed';
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

if (!window.__moduleRegistry) window.__moduleRegistry = [];
window.__moduleRegistry.push({ id, label, icon, color, render, bindEvents });

import { CharacterStore, generateId, addBidirectionalFriend, createDefaultCharacterData } from '../store/CharacterStore.js';
import { clearImageCache, getPortraitHtml, setImage, setImageFromGallery, setCropParams, getImageDataUrl, preloadAllImages } from '../store/ImageCache.js';
import { showCropEditor, showConfirm, showPrompt } from '../store/dialog.js';
import { createCharacterByName, createCharacterByAI, autoAddFriend } from './characterCreator.js';
import {
    loadCharacters, saveCharacters, loadActiveIndex, saveActiveIndex, getActiveCharacter, ACTIVE_KEY,
    loadCategories, assignCategory, createCategory, deleteCategory, removeCharFromAll, setCategoryMembers, archiveCharacter, unarchiveCharacter, deleteCharacterDeep
} from './roleData.js';
import { esc } from '../store/utils.js';
import { parseIdText, parseIdLevel, formatIdText, formatManualText } from '../store/profileAccess.js';



// ---- Toast 通知（替代 alert）----
function showToast(msg, bg = '#333') {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:${bg};color:#fff;padding:10px 20px;border-radius:12px;z-index:10000;font-size:13px;box-shadow:0 4px 20px rgba(0,0,0,0.2);max-width:80%;text-align:center;`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
}


export const id = 'roleBookPage';
export const label = '角色名册';
export const icon = '👤';
export const color = '#e91e63';
export const title = '👤 角色名册';
export const memoryOptions = {
    mode: 'manual',
    description: '角色名册记忆联动需要手动触发。',
    enabled: false
};




// ---- 数据 ----
let characters = loadCharacters();
let activeIndex = loadActiveIndex();
let selectedIndex = null;
let viewingIndex = null;
let isEditing = false;
let savedScrollLeft = 0;  // ★ 保存列表滚动位置
let categories = loadCategories();       // 分类映射 { 组名: [charId...] }
let activeCategory = null;               // null = 全部


// ---- 卡片渲染（新：形象卡模式）----
function createCardHTML(item, index) {
    const isActive = index === activeIndex;
    const isSelected = index === selectedIndex;
    const isArchivedCard = !!item.archived;
    const borderColor = isSelected ? '#0b93f6' : 'transparent';

    // ★ 获取形象卡 HTML，如果没有设置 getPortraitHtml 返回空
    const portraitHtml = getPortraitHtml(item.id);
    const hasPortrait = portraitHtml && portraitHtml.length > 20;  // 简单判断是否有图

    return `
        <div class="role-card" data-index="${index}" 
             style="flex-shrink:0; width:150px; height:210px; border-radius:16px; 
                    display:flex; flex-direction:column; align-items:center; 
                    cursor:pointer; transition:all 0.2s; 
                    box-shadow:0 2px 12px rgba(0,0,0,0.1);
                    background:white; color:#333; position:relative;
                    border:3px solid ${borderColor}; overflow:hidden;
                    ${isSelected ? 'transform:scale(1.03);' : ''};
                    ${isArchivedCard ? 'filter:grayscale(0.9); opacity:0.55;' : ''}   // ★ 灰卡
                    "
            
            <!-- 形象卡区域 -->
            <div style="
                width:100%; height:150px; 
                background:${hasPortrait ? 'transparent' : 'linear-gradient(135deg, #e0e0e0, #f5f5f5)'};
                display:flex; align-items:center; justify-content:center;
                overflow:hidden; flex-shrink:0;
            ">
                ${hasPortrait
            ? portraitHtml.replace('object-fit:cover', 'object-fit:cover;width:100%;height:100%')
            : `<span style="font-size:40px; color:#bbb; opacity:0.5;">${esc(item.base.name.charAt(0))}</span>`
        }
            </div>
            
            ${isArchivedCard ? `
    <div style="position:absolute; top:6px; left:6px; background:#999; color:white;
                border-radius:8px; padding:2px 6px; font-size:10px;">📦 已归档</div>
` : ''}

            
            <!-- 角色信息 -->
            <div style="flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:8px 6px; width:100%;">
                <div style="font-size:14px; font-weight:600; text-align:center; width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                    ${esc(item.base.name)}
                </div>
                ${item.base.gender || item.base.age ? `
                <div style="font-size:11px; color:#999; margin-top:2px; text-align:center;">
                    ${esc(item.base.gender || '')}${item.base.gender && item.base.age ? ' · ' : ''}${esc(item.base.age || '')}
                </div>
                ` : ''}
            </div>
            
            <!-- 当前主视角标记 -->
            ${isActive ? `
            <div style="position:absolute; top:6px; right:6px; background:#e91e63; color:white; 
                        border-radius:50%; width:22px; height:22px; display:flex; 
                        align-items:center; justify-content:center; font-size:12px;
                        box-shadow:0 1px 4px rgba(233,30,99,0.4);">✓</div>
            ` : ''}
        </div>
    `;
}

// ---- 渲染列表页 ----
function renderListView() {
    const activeChar = getActiveCharacter(characters, activeIndex);
    // 过滤：保留原始索引，否则卡片 data-index 会错位
    const displayChars = activeCategory
        ? characters.map((c, idx) => ({ c, idx }))
            .filter(({ c }) => (categories[activeCategory] || []).includes(c.id))
        : characters.map((c, idx) => ({ c, idx }));

    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">${title}</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card">
${activeChar ? `
    <div style="text-align:center; padding:8px; margin-bottom:12px; 
                background:#fce4ec; border-radius:12px; font-size:14px; color:#c62828;">
        当前选中角色：${esc(activeChar.base.name)}
    </div>
` : `
    <div style="text-align:center; padding:8px; margin-bottom:12px; 
                background:#f5f5f5; border-radius:12px; font-size:14px; color:#888;">
        尚未选中主视角角色，请选择一个角色
    </div>
`}

<div style="display:flex; gap:8px; overflow-x:auto; padding:0 16px 8px; flex-shrink:0;">
    <button class="cat-chip ${activeCategory === null ? 'cat-chip-active' : ''}"
            data-cat="__all__"
            style="flex-shrink:0; padding:6px 14px; border-radius:20px; border:none; cursor:pointer;
                   font-size:13px; background:${activeCategory === null ? '#e91e63' : '#f0f0f0'};
                   color:${activeCategory === null ? '#fff' : '#666'};">全部</button>
    ${Object.keys(categories).map(name => `
        <button class="cat-chip ${activeCategory === name ? 'cat-chip-active' : ''}"
                data-cat="${esc(name)}"
                style="flex-shrink:0; padding:6px 14px; border-radius:20px; border:none; cursor:pointer;
                       font-size:13px; background:${activeCategory === name ? '#e91e63' : '#f0f0f0'};
                       color:${activeCategory === name ? '#fff' : '#666'};">${esc(name)}</button>
    `).join('')}
    
    <button class="cat-chip" id="addCategoryBtn"
            style="flex-shrink:0; padding:6px 14px; border-radius:20px; border:1px dashed #ccc;
                   cursor:pointer; font-size:13px; color:#999; background:transparent;">＋</button>
</div>


                    <p>自身角色卡 + 可切换的角色列表。</p>
                    
                    <!-- 横向滚动角色列表 -->
                    <div style="position:relative; margin-top:12px;">
                        <!-- 左箭头 -->
                        <button class="scroll-arrow scroll-left" data-scroll="-1" style="
                            position:absolute; left:0; top:75px; transform:translateY(-50%);
                            width:28px; height:28px; border-radius:50%; border:none;
                            background:rgba(255,255,255,0.9); color:#666;
                            cursor:pointer; z-index:2; font-size:14px;
                            box-shadow:0 1px 4px rgba(0,0,0,0.15);
                            display:flex; align-items:center; justify-content:center;
                        ">‹</button>
                        
                        <!-- 卡片容器（横向滚动） -->
                        <div class="card-scroll" style="
                            display:flex; gap:12px; overflow-x:auto; 
                            padding:8px 32px; scroll-behavior:smooth;
                            scrollbar-width:none; -ms-overflow-style:none;
                            -webkit-overflow-scrolling:touch;
                        ">
                            ${displayChars.map(({ c, idx }) => createCardHTML(c, idx)).join('')}
                        </div>
                        
                        <!-- 右箭头 -->
                        <button class="scroll-arrow scroll-right" data-scroll="1" style="
                            position:absolute; right:0; top:75px; transform:translateY(-50%);
                            width:28px; height:28px; border-radius:50%; border:none;
                            background:rgba(255,255,255,0.9); color:#666;
                            cursor:pointer; z-index:2; font-size:14px;
                            box-shadow:0 1px 4px rgba(0,0,0,0.15);
                            display:flex; align-items:center; justify-content:center;
                        ">›</button>
                    </div>
                    <button id="createCharBtn" style="
    margin-top:16px; width:100%; padding:12px;
    border-radius:20px; border:2px dashed #e91e63;
    background:white; color:#e91e63;
    cursor:pointer; font-size:15px; font-weight:600;
">
    ➕ 新建角色
</button>

                    <div class="memory-card disabled" style="margin-top:16px;">
                        <div>记忆联动：${memoryOptions.enabled ? '可用' : '当前未启用'}</div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function showCategoryEditor(catName, container, memoryService, globalState) {
    document.querySelector('.cat-editor-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'cat-editor-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:400;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
        <div style="background:white;border-radius:20px;width:300px;max-height:80vh;display:flex;flex-direction:column;overflow:hidden;">
            <div style="padding:16px;font-weight:600;font-size:15px;border-bottom:1px solid #f0f0f0;">
                ✏️ 编辑「${esc(catName)}」— 勾选属于该分类的角色
            </div>
            <div style="flex:1;overflow-y:auto;padding:12px 16px;font-size:14px;line-height:2.2;">
                ${characters.map(c => `
                    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                        <input type="checkbox" data-char-id="${esc(c.id)}"
                            ${(categories[catName] || []).includes(c.id) ? 'checked' : ''}>
                        <span>${esc(c.base.name)}</span>
                    </label>
                `).join('')}
            </div>
            <div style="display:flex;gap:10px;padding:12px 16px;border-top:1px solid #f0f0f0;">
                <button id="catEditorSave" style="flex:1;padding:9px;border:none;border-radius:12px;background:#e91e63;color:white;cursor:pointer;font-size:14px;font-weight:600;">保存</button>
                <button id="catEditorCancel" style="flex:1;padding:9px;border:1px solid #ccc;border-radius:12px;background:white;color:#666;cursor:pointer;font-size:14px;">取消</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#catEditorSave').addEventListener('click', () => {
        const checkedIds = [...overlay.querySelectorAll('input[type="checkbox"]:checked')]
            .map(input => input.dataset.charId);
        setCategoryMembers(catName, checkedIds, categories);   // ★ 一次批量写入
        overlay.remove();
        const appContainer = container.closest('.screen-page') || container;
        appContainer.innerHTML = render({ memoryService, globalState });
        bindEvents(appContainer, { memoryService, globalState });
    });

    overlay.querySelector('#catEditorCancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// ★ 名册详情页：展示分层公开信息
function renderDetailProfileSection(chara) {
    let p = {};
    try {
        p = new CharacterStore(chara.id || chara.base?.name).getProfile();
    } catch (e) { return ''; }

    const l0 = typeof p.L0 === 'string' ? p.L0 : '';
    const l1 = typeof p.L1 === 'string' ? p.L1 : '';
    const l2 = typeof p.L2 === 'string' ? p.L2 : '';
    const l3 = Object.entries(p.L3 || {}).map(([vid, v]) => `【${vid}】${v}`).join('\n');
    const manual = Object.entries(p.manual || {}).map(([vid, lv]) => `${vid} → L${lv}`).join('\n');

    if (!l0 && !l1 && !l2 && !l3 && !manual) return '';

    return `
        <div style="background:#f3e5f5; border-radius:12px; padding:12px; margin-bottom:12px;">
            <div style="font-weight:600; margin-bottom:4px;">📖 公开信息（分层）</div>
            ${l0 ? `<div style="font-size:12px; color:#7b1fa2; margin-bottom:2px;">【L0 表象层】</div><div style="font-size:13px; color:#6a1b9a; white-space:pre-wrap; margin-bottom:8px;">${esc(l0)}</div>` : ''}
            ${l1 ? `<div style="font-size:12px; color:#7b1fa2; margin-bottom:2px;">【L1 熟人层】</div><div style="font-size:13px; color:#6a1b9a; white-space:pre-wrap; margin-bottom:8px;">${esc(l1)}</div>` : ''}
            ${l2 ? `<div style="font-size:12px; color:#7b1fa2; margin-bottom:2px;">【L2 密友层】</div><div style="font-size:13px; color:#6a1b9a; white-space:pre-wrap; margin-bottom:8px;">${esc(l2)}</div>` : ''}
            ${l3 ? `<div style="font-size:12px; color:#7b1fa2; margin-bottom:2px;">【L3 专属层】</div><div style="font-size:13px; color:#6a1b9a; white-space:pre-wrap; margin-bottom:8px;">${esc(l3)}</div>` : ''}
            ${manual ? `<div style="font-size:12px; color:#7b1fa2; margin-bottom:2px;">【手动指定】</div><div style="font-size:13px; color:#6a1b9a; white-space:pre-wrap;">${esc(manual)}</div>` : ''}
        </div>`;
}

// ---- 渲染详情页 ----
function renderDetailView(index) {
    const chara = characters[index];
    const isActive = index === activeIndex;

    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">${esc(chara.base.name)}</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card">
<div style="text-align:center; margin:8px 0;">
    <div id="portraitContainer" style="
        width:80px; height:80px; border-radius:12px; 
        background:#f0f0f0; margin:0 auto; 
        display:flex; align-items:center; justify-content:center;
        cursor:pointer; overflow:hidden;
        border:2px dashed #ccc;
    ">
        ${getPortraitHtml(chara.id)}
    </div>
    <div style="font-size:11px; color:#888; margin-top:4px;">点击更换形象卡</div>
</div>
                    <h3 style="text-align:center; margin-bottom:8px;">${esc(chara.base.name)}</h3>
                    <p style="text-align:center; color:#666; margin-bottom:16px;">${esc(chara.base.desc)}</p>

                    <div style="background:#f3e5f5; border-radius:12px; padding:12px; margin-bottom:16px;">
    <div style="font-weight:600; margin-bottom:4px;">📖 详细设定</div>
    <div style="font-size:14px; color:#6a1b9a; white-space:pre-wrap;">${esc(chara.base.detail || '无')}</div>
</div>


                    
                    <div style="background:#fff3e0; border-radius:12px; padding:12px; margin-bottom:16px;">
                        <div style="font-weight:600; margin-bottom:4px;">🔒 内心秘密</div>
                        <div style="font-size:14px; color:#e65100;">${esc(chara.base.secret || '无')}</div>
                    </div>

                                    ${renderDetailProfileSection(chara)}

                    <div style="background:#e8f5e9; border-radius:12px; padding:12px; margin-bottom:16px;">
                        <div style="font-weight:600; margin-bottom:4px;">🗣️ 说话风格</div>
                        <div style="font-size:14px; color:#2e7d32;">${esc(chara.base.style || '无')}</div>
                    </div>

                    <div style="background:#e3f2fd; border-radius:12px; padding:12px; margin-bottom:16px;">
                        <div style="font-weight:600; margin-bottom:8px;">📜 独立记忆</div>
                        ${(chara.base.memories || []).map(m => `
                            <div style="padding:6px 0; border-bottom:1px solid #bbdefb; font-size:14px;">
                                <span style="color:#1565c0; font-size:12px;">${esc(m.time)}</span>
                                <div style="margin-top:2px;">${esc(m.content)}</div>
                            </div>
                        `).join('') || '<div style="font-size:14px; color:#888;">暂无记忆</div>'}
                    </div>

                    ${isEditing || chara.archived ? '' : `
                    <button id="switchCharBtn" style="width:100%; padding:12px; border-radius:24px; border:none;
                            ${isActive ? 'background:#ccc; color:#666; cursor:not-allowed;' : 'background:#e91e63; color:white; cursor:pointer;'}
                            font-size:16px; font-weight:600;" ${isActive ? 'disabled' : ''}>
                        ${isActive ? '✅ 当前已是此角色' : '🔄 切换为此角色'}
                    </button>
                    `}
                    
${!chara.archived ? `
<button id="editCharBtn" style="width:100%; padding:12px; border-radius:24px; border:none;
        background:#ff9800; color:white; cursor:pointer;
        font-size:16px; font-weight:600; margin-top:8px;">
    ${isEditing ? '💾 保存修改' : '✏️ 编辑角色'}
</button>
` : `
<button id="restoreCharBtn" style="width:100%; padding:12px; border-radius:24px; border:none;
        background:#4caf50; color:white; cursor:pointer;
        font-size:16px; font-weight:600; margin-top:8px;">
    ♻️ 恢复为未归档
</button>
`}

                    
${(() => {
            const currentActive = getActiveCharacter(characters, activeIndex);
            const currentActiveId = currentActive?.id || currentActive?.base?.name;
            const charaId = chara?.id || chara?.base?.name;

            if (currentActiveId === charaId) return '';
            if (!currentActiveId) return '';

            let isFriend = false;
            try {
                const store = new CharacterStore(currentActiveId);
                isFriend = store.isFriend(charaId);
            } catch (e) { }

            if (isFriend) return '';

            return `<button id="addFriendFromRoleBtn" style="width:100%; padding:12px; border-radius:24px; border:none; 
            background:#0b93f6; color:white; cursor:pointer; font-size:16px; font-weight:600; margin-top:8px;">
        ➕ 添加为联系人
    </button>`;
        })()}

                    <div class="memory-card disabled" style="margin-top:12px;">
                        <div>记忆联动：${memoryOptions.enabled ? '可用' : '当前未启用'}</div>
                    </div>
                    
                    <!-- ★ 删除按钮（当前角色不显示） -->
                    ${!isActive ? `
                    <button id="deleteCharBtn" style="
                        width:100%; padding:12px; border-radius:24px; border:1px solid #e53935;
                        background:white; color:#e53935; cursor:pointer;
                        font-size:14px; font-weight:600; margin-top:16px;
                    ">🗑️ 删除此角色</button>
                    ` : `
                    <div style="text-align:center; margin-top:16px; font-size:12px; color:#ccc;">
                        ⚠️ 当前主视角角色不能删除，请先切换后再来
                    </div>
                    `}
                </div>
            </div>
        </div>
    `;
}

// ---- 渲染编辑表单 ----
function renderEditForm(index) {
    const chara = characters[index];
    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">✏️ 编辑 ${esc(chara.base.name)}</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card">
                    <div style="margin-bottom:12px;">
                        <label style="font-size:12px; color:#888; display:block; margin-bottom:4px;">名称</label>
                        <input id="editName" type="text" value="${esc(chara.base.name)}"
                               style="width:100%; border:1px solid #ccc; border-radius:8px; padding:10px; font-size:15px; box-sizing:border-box;" />
                    </div>
                    <div style="margin-bottom:12px;">
                        <label style="font-size:12px; color:#888; display:block; margin-bottom:4px;">描述</label>
                        <textarea id="editDesc" rows="2"
                                  style="width:100%; border:1px solid #ccc; border-radius:8px; padding:10px; font-size:14px; resize:vertical; box-sizing:border-box; font-family:inherit;">${esc(chara.base.desc || '')}</textarea>
                    </div>
                    <div style="margin-bottom:12px;">
    <label style="font-size:12px; color:#888; display:block; margin-bottom:4px;">详细设定</label>
    <textarea id="editDetail" rows="6"
              style="width:100%; border:1px solid #ccc; border-radius:8px; padding:10px; font-size:14px; resize:vertical; box-sizing:border-box; font-family:inherit;">${esc(chara.base.detail || '')}</textarea>
</div>

                    <div style="margin-bottom:12px;">
                        <label style="font-size:12px; color:#888; display:block; margin-bottom:4px;">说话风格</label>
                        <textarea id="editStyle" rows="2"
                                  style="width:100%; border:1px solid #ccc; border-radius:8px; padding:10px; font-size:14px; resize:vertical; box-sizing:border-box; font-family:inherit;">${esc(chara.base.style || '')}</textarea>
                    </div>
                    <div style="margin-bottom:12px;">
                        <label style="font-size:12px; color:#888; display:block; margin-bottom:4px;">内心秘密</label>
                        <textarea id="editSecret" rows="2"
                                  style="width:100%; border:1px solid #ccc; border-radius:8px; padding:10px; font-size:14px; resize:vertical; box-sizing:border-box; font-family:inherit;">${esc(chara.base.secret || '')}</textarea>
                    </div>
                                        <div style="display:flex; gap:8px; margin-bottom:12px;">
                        <div style="flex:1;">
                            <label style="font-size:12px; color:#888; display:block; margin-bottom:4px;">性别</label>
                            <input id="editGender" type="text" value="${esc(chara.base.gender || '未知')}"
                                   style="width:100%; border:1px solid #ccc; border-radius:8px; padding:10px; font-size:14px; box-sizing:border-box;" />
                        </div>
                        <div style="flex:1;">
                            <label style="font-size:12px; color:#888; display:block; margin-bottom:4px;">年龄</label>
                            <input id="editAge" type="text" value="${esc(chara.base.age || '未知')}"
                                   style="width:100%; border:1px solid #ccc; border-radius:8px; padding:10px; font-size:14px; box-sizing:border-box;" />
                        </div>
                    </div>
                    <div style="margin-bottom:12px;">
                        <label style="font-size:12px; color:#888; display:block; margin-bottom:6px;">📖 公开信息（分层）</label>

                        <!-- L0 表象层 -->
<div style="font-size:12px; color:#7b1fa2; margin-bottom:2px;">【L0 表象层】</div>
<textarea id="editProfileL0" rows="2" placeholder="第一眼看到的表象：表面性别、长相、气质……"
          style="width:100%; border:1px solid #ccc; border-radius:8px; padding:8px 10px; font-size:13px; box-sizing:border-box; resize:vertical; margin-bottom:10px;">${esc((() => { try { const p = new CharacterStore(chara.id || chara.base?.name).getProfile(); return typeof p.L0 === 'string' ? p.L0 : ''; } catch { return ''; } })())}</textarea>

                        <!-- L1 熟人层 -->
                        <div style="font-size:12px; color:#7b1fa2; margin-bottom:2px;">【L1 熟人层】</div>
                        <textarea id="editProfileL1" rows="2" placeholder="好友能看到的性格细节……"
                                  style="width:100%; border:1px solid #ccc; border-radius:8px; padding:8px 10px; font-size:13px; box-sizing:border-box; resize:vertical; margin-bottom:10px;">${esc((() => { try { const p = new CharacterStore(chara.id || chara.base?.name).getProfile(); return typeof p.L1 === 'string' ? p.L1 : ''; } catch { return ''; } })())}</textarea>

                        <!-- L2 密友层 -->
                        <div style="font-size:12px; color:#7b1fa2; margin-bottom:2px;">【L2 密友层】</div>
                        <textarea id="editProfileL2" rows="2" placeholder="挚友才知道的秘密、弱点……"
                                  style="width:100%; border:1px solid #ccc; border-radius:8px; padding:8px 10px; font-size:13px; box-sizing:border-box; resize:vertical; margin-bottom:10px;">${esc((() => { try { const p = new CharacterStore(chara.id || chara.base?.name).getProfile(); return typeof p.L2 === 'string' ? p.L2 : ''; } catch { return ''; } })())}</textarea>

                        <!-- L3 专属层 -->
                        <div style="font-size:12px; color:#7b1fa2; margin-bottom:2px;">【L3 专属层】每行：角色ID：内容</div>
                        <textarea id="editProfileL3" rows="2" placeholder="char_主角：只有TA知道的秘密"
                                  style="width:100%; border:1px solid #ccc; border-radius:8px; padding:8px 10px; font-size:13px; box-sizing:border-box; resize:vertical; margin-bottom:10px;">${esc((() => { try { const p = new CharacterStore(chara.id || chara.base?.name).getProfile(); return formatIdText(p.L3 || {}); } catch { return ''; } })())}</textarea>

                        <!-- 手动指定 -->
                        <div style="font-size:12px; color:#7b1fa2; margin-bottom:2px;">【手动指定】每行：角色ID：0/1/2</div>
                        <textarea id="editProfileManual" rows="2" placeholder="char_法师：2"
                                  style="width:100%; border:1px solid #ccc; border-radius:8px; padding:8px 10px; font-size:13px; box-sizing:border-box; resize:vertical;">${esc((() => { try { const p = new CharacterStore(chara.id || chara.base?.name).getProfile(); return formatManualText(p.manual || {}); } catch { return ''; } })())}</textarea>
                    </div>

                    <div style="display:flex; gap:8px;">
                        <button id="saveEditBtn" style="flex:1; padding:12px; border-radius:24px; border:none;
                                background:#4caf50; color:white; cursor:pointer; font-size:16px; font-weight:600;">
                            💾 保存
                        </button>
                        <button id="cancelEditBtn" style="flex:1; padding:12px; border-radius:24px; border:1px solid #ccc;
                                background:white; color:#666; cursor:pointer; font-size:16px; font-weight:600;">
                            ↩ 取消
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
}


// ---- DOM 操作：切换高亮 ----
function toggleSelection(index, globalState) {
    const grid = document.querySelector('.card-scroll');
    if (!grid) return;

    if (selectedIndex === index) {
        selectedIndex = null;
        const card = grid.querySelector(`.role-card[data-index="${index}"]`);
        if (card) {
            card.style.border = '3px solid #eee';
            const btn = card.querySelector('.view-detail-btn');
            if (btn) btn.remove();
        }
        return;
    }

    if (selectedIndex !== null) {
        const oldCard = grid.querySelector(`.role-card[data-index="${selectedIndex}"]`);
        if (oldCard) {
            oldCard.style.border = '3px solid #eee';
            const oldBtn = oldCard.querySelector('.view-detail-btn');
            if (oldBtn) oldBtn.remove();
        }
    }

    selectedIndex = index;
    const newCard = grid.querySelector(`.role-card[data-index="${index}"]`);
    if (newCard) {
        newCard.style.border = '3px solid #0b93f6';
        if (!newCard.querySelector('.view-detail-btn')) {
            const btn = document.createElement('button');
            btn.textContent = '📖 详情';
            btn.className = 'view-detail-btn';
            btn.dataset.index = index;
            btn.style.cssText = `
    position:absolute; top:140px; left:50%; transform:translateX(-50%);
    padding:4px 14px; border-radius:12px; 
    border:none; background:#0b93f6; color:white; font-size:11px; cursor:pointer;
    z-index:5; box-shadow:0 1px 4px rgba(0,0,0,0.2); white-space:nowrap;
`;
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                const idx = parseInt(this.dataset.index);
                viewingIndex = idx;
                const scrollEl = document.querySelector('.card-scroll');
                if (scrollEl) savedScrollLeft = scrollEl.scrollLeft;
                selectedIndex = null;
                const appContainer = document.querySelector('.page-container');
                appContainer.innerHTML = render({ globalState });
                const module = { bindEvents, handleBack };
                module.bindEvents(appContainer, { memoryService: window.__memoryService, globalState });
            });
            newCard.appendChild(btn);
        }
    }
}


// ---- handleBack 同样加保护 ----
export function handleBack(container, { memoryService, globalState }) {
    if (viewingIndex !== null) {
        // ★ 新增：检查 viewingIndex 是否仍有效
        const valid = viewingIndex >= 0 && viewingIndex < characters.length;
        isEditing = false;
        viewingIndex = null;
        const appContainer = container.closest('.screen-page') || container;
        appContainer.innerHTML = render({ memoryService, globalState });
        bindEvents(appContainer, { memoryService, globalState });
        if (savedScrollLeft > 0) {
            const scrollEl = document.querySelector('.card-scroll');
            if (scrollEl) setTimeout(() => scrollEl.scrollLeft = savedScrollLeft, 50);
        }

        return true;
    }
    return false;
}

// ---- 事件绑定 ----
export function bindEvents(container, { memoryService, globalState }) {
    window.__memoryService = memoryService;

    if (viewingIndex !== null) {
        const switchBtn = container.querySelector('#switchCharBtn');
        // ★ 编辑按钮
        const editBtn = container.querySelector('#editCharBtn');
        if (editBtn) {
            editBtn.addEventListener('click', () => {
                isEditing = !isEditing;
                const appContainer = container.closest('.screen-page') || container;
                appContainer.innerHTML = render({ memoryService, globalState });
                bindEvents(appContainer, { memoryService, globalState });
            });
        }

        // ★ 保存编辑
        const saveBtn = container.querySelector('#saveEditBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                const chara = characters[viewingIndex];
                if (!chara) return;

                // 读取表单值
                const newName = document.getElementById('editName')?.value.trim();
                if (!newName) {
                    // 显示红色提示
                    const hint = document.createElement('div');
                    hint.textContent = '⚠️ 名称不能为空';
                    hint.style.cssText = 'color:#c62828; font-size:12px; margin-bottom:8px;';
                    document.getElementById('editName')?.parentNode?.insertBefore(hint, null);
                    setTimeout(() => hint.remove(), 2000);
                    return;
                }

                // 更新角色数据
                chara.base.name = newName;
                chara.base.desc = document.getElementById('editDesc')?.value || '';
                chara.base.style = document.getElementById('editStyle')?.value || '';
                chara.base.secret = document.getElementById('editSecret')?.value || '';
                chara.base.detail = document.getElementById('editDetail')?.value || '';
                chara.base.gender = document.getElementById('editGender')?.value.trim() || '未知';   // ★ 新增
                chara.base.age = document.getElementById('editAge')?.value.trim() || '未知';         // ★ 新增

                // ★ 保存分层公开信息到 char_<id>（4 个独立填空区）
                try {
                    new CharacterStore(chara.id || chara.base?.name).setProfile({
                        L0: document.getElementById('editProfileL0')?.value.trim() || '',
                        L1: document.getElementById('editProfileL1')?.value.trim() || '',
                        L2: document.getElementById('editProfileL2')?.value.trim() || '',
                        L3: parseIdText(document.getElementById('editProfileL3')?.value || ''),
                        manual: parseIdLevel(document.getElementById('editProfileManual')?.value || '')
                    });
                } catch (e) { /* 忽略 */ }


                // 更新属性
                document.querySelectorAll('.editStat').forEach(input => {
                    const key = input.dataset.key;
                    const val = parseInt(input.value);
                });

                saveCharacters(characters);

                // 同步更新 CharacterStore
                try {
                    const store = new CharacterStore(chara.id);
                    store.setInfo({
                        name: chara.base.name,
                        emoji: chara.base.emoji,
                        desc: chara.base.desc,
                    });
                } catch (e) { /* 忽略 */ }

                isEditing = false;
                const appContainer = container.closest('.screen-page') || container;
                appContainer.innerHTML = render({ memoryService, globalState });
                bindEvents(appContainer, { memoryService, globalState });
            });
        }

        // ★ 取消编辑
        const cancelBtn = container.querySelector('#cancelEditBtn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                isEditing = false;
                const appContainer = container.closest('.screen-page') || container;
                appContainer.innerHTML = render({ memoryService, globalState });
                bindEvents(appContainer, { memoryService, globalState });
            });
        }

        // ★ 恢复未归档按钮
        const restoreBtn = container.querySelector('#restoreCharBtn');
        restoreBtn?.addEventListener('click', () => {
            const chara = characters[viewingIndex];
            if (!chara) return;
            const charId = chara.id || chara.base?.name;
            unarchiveCharacter(charId);          // 名册 / 网络 / 本体三处清标记
            characters = loadCharacters();
            showToast(`♻️ 已恢复「${chara.base.name}」为未归档`, '#4caf50');
            const appContainer = container.closest('.screen-page') || container;
            appContainer.innerHTML = render({ memoryService, globalState });
            bindEvents(appContainer, { memoryService, globalState });
        });


        // ★ 删除角色（归档 / 彻底删除 二选一）
        const deleteBtn = container.querySelector('#deleteCharBtn');
        deleteBtn?.addEventListener('click', async () => {
            const chara = characters[viewingIndex];
            if (!chara) return;
            const charId = chara.id || chara.base?.name;
            const isArchived = !!chara.archived;

            // 二选一弹窗
            const action = await new Promise(resolve => {
                const overlay = document.createElement('div');
                overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:950;display:flex;align-items:center;justify-content:center;';
                overlay.innerHTML = `
            <div style="background:white;border-radius:20px;padding:20px;width:280px;text-align:center;">
                <div style="font-size:15px;font-weight:600;margin-bottom:4px;">${esc(chara.base.name)}</div>
                <div style="font-size:12px;color:#999;margin-bottom:16px;">${isArchived ? '当前已归档，可选择恢复或彻底删除' : '请选择处理方式'}</div>
                <button id="softDelBtn" style="width:100%;padding:10px;border-radius:12px;border:none;background:${isArchived ? '#4caf50' : '#ff9800'};color:white;cursor:pointer;font-size:14px;margin-bottom:8px;">${isArchived ? '♻️ 恢复（取消归档，重新活跃）' : '📦 归档（保留名字，不再活跃）'}</button>
                <button id="hardDelBtn" style="width:100%;padding:10px;border-radius:12px;border:none;background:#e53935;color:white;cursor:pointer;font-size:14px;margin-bottom:8px;">🗑️ 彻底删除（全部清除）</button>
                <button id="cancelDelBtn" style="width:100%;padding:10px;border-radius:12px;border:1px solid #ccc;background:white;color:#666;cursor:pointer;font-size:14px;">取消</button>
            </div>`;
                document.body.appendChild(overlay);
                overlay.querySelector('#softDelBtn').onclick = () => { overlay.remove(); resolve('soft'); };
                overlay.querySelector('#hardDelBtn').onclick = () => { overlay.remove(); resolve('hard'); };
                overlay.querySelector('#cancelDelBtn').onclick = () => { overlay.remove(); resolve(null); };
            });
            if (!action) return;

            if (action === 'soft') {
                if (isArchived) {
                    // ★ 恢复未归档（不碰分类）
                    unarchiveCharacter(charId);
                    characters = loadCharacters();
                    showToast(`♻️ 已恢复「${chara.base.name}」为未归档`, '#4caf50');
                } else {
                    // ★ 归档（不碰分类，该是什么分类还是什么分类）
                    await archiveCharacter(charId);
                    if (viewingIndex === activeIndex) { activeIndex = -1; saveActiveIndex(-1); }
                    else if (viewingIndex < activeIndex) { activeIndex--; saveActiveIndex(activeIndex); }
                    showToast(`📦 已归档「${chara.base.name}」`, '#ff9800');
                }
            }
            else {
                // ★ 彻底删除
                await deleteCharacterDeep(charId);
                removeCharFromAll(charId, categories);
                if (viewingIndex === activeIndex) { activeIndex = -1; saveActiveIndex(-1); }
                else if (viewingIndex < activeIndex) { activeIndex--; saveActiveIndex(activeIndex); }
                showToast(`🗑️ 已彻底删除「${chara.base.name}」`, '#e53935');
            }

            // 返回列表页
            viewingIndex = null;
            const appContainer = container.closest('.screen-page') || container;
            appContainer.innerHTML = render({ memoryService, globalState });
            bindEvents(appContainer, { memoryService, globalState });
        });


        // ★ 头像上传
        const portraitContainer = container.querySelector('#portraitContainer');
        if (portraitContainer) {
            portraitContainer.addEventListener('click', () => {
                // 自定义选择弹窗
                const choiceOverlay = document.createElement('div');
                choiceOverlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:200;display:flex;align-items:center;justify-content:center;';
                choiceOverlay.innerHTML = `
                <div style="background:white;border-radius:20px;padding:20px;width:260px;text-align:center;">
                    <div style="font-size:15px;color:#333;margin-bottom:16px;">选择形象卡来源</div>
                    <div style="display:flex;gap:10px;">
                        <button class="choice-album" style="flex:1;padding:10px;border-radius:12px;border:none;background:#0b93f6;color:white;cursor:pointer;font-size:14px;">🖼️ 相册</button>
                        <button class="choice-file" style="flex:1;padding:10px;border-radius:12px;border:none;background:#4caf50;color:white;cursor:pointer;font-size:14px;">📁 文件</button>
                    </div>
                    <button class="choice-cancel" style="margin-top:10px;padding:6px 16px;border-radius:10px;border:1px solid #ccc;background:white;color:#888;cursor:pointer;font-size:12px;">取消</button>
                </div>
            `;
                document.body.appendChild(choiceOverlay);

                choiceOverlay.querySelector('.choice-album').onclick = () => {
                    choiceOverlay.remove();
                    import('./gallery.js').then(gallery => {
                        gallery.renderGalleryPicker(async (galleryKey) => {
                            const charId = characters[viewingIndex].id;
                            await setImageFromGallery(charId, 'portrait', galleryKey);
                            const dataUrl = await getImageDataUrl(galleryKey);
                            const crop = await showCropEditor(dataUrl || galleryKey);
                            if (crop !== null) {
                                setCropParams(charId, 'portrait', crop);
                            } const appContainer = container.closest('.screen-page') || container;
                            appContainer.innerHTML = renderDetailView(viewingIndex);
                            bindEvents(appContainer, { memoryService: window.__memoryService, globalState });
                        });
                    });
                };

                choiceOverlay.querySelector('.choice-file').onclick = () => {
                    choiceOverlay.remove();
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.accept = 'image/*';
                    input.onchange = (e) => {
                        const file = e.target.files[0];
                        if (!file) return;
                        const reader = new FileReader();
                        reader.onload = async (ev) => {
                            const dataUrl = ev.target.result;
                            const charId = characters[viewingIndex].id;
                            await setImage(charId, 'portrait', file);
                            const crop = await showCropEditor(dataUrl);
                            if (crop !== null) {
                                setCropParams(charId, 'portrait', crop);
                            } const appContainer = container.closest('.screen-page') || container;
                            appContainer.innerHTML = renderDetailView(viewingIndex);
                            bindEvents(appContainer, { memoryService: window.__memoryService, globalState });
                        };
                        reader.readAsDataURL(file);
                    };
                    input.click();
                };

                choiceOverlay.querySelector('.choice-cancel').onclick = () => choiceOverlay.remove();
            });
        }

        if (switchBtn && !switchBtn.disabled) {
            switchBtn.addEventListener('click', () => {
                activeIndex = viewingIndex;
                saveActiveIndex(activeIndex);
                if (globalState) {
                    globalState.activeCharacter = characters[activeIndex];
                    globalState.activeCharacterId = activeIndex;
                }
                const appContainer = container.closest('.screen-page') || container;
                appContainer.innerHTML = render({ memoryService, globalState });
                bindEvents(appContainer, { memoryService, globalState });
            });
        }

        const currentActive = getActiveCharacter(characters, activeIndex);
        const currentActiveId = currentActive?.id || currentActive?.base?.name;
        const charaId = characters[viewingIndex]?.id || characters[viewingIndex]?.base?.name;
        if (currentActiveId !== charaId) {
            const addFriendBtn = container.querySelector('#addFriendFromRoleBtn');
            if (addFriendBtn) {
                addFriendBtn.addEventListener('click', () => {
                    const chara = characters[viewingIndex];
                    if (!chara) return;
                    const activeChar = globalState?.activeCharacter;
                    if (!activeChar) {
                        showToast('⚠️ 请先设置主视角角色', '#c62828');
                        return;
                    }
                    const activeId = activeChar?.id || activeChar?.base?.name || 'unknown';
                    const success = addBidirectionalFriend(activeId, chara.id);
                    if (!success) {
                        showToast(`ℹ️ ${chara.base.name} 已经是你的联系人了`, '#ff9800');
                        return;
                    }
                    showToast(`✅ 已添加 ${chara.base.name} 为联系人`, '#2e7d32');
                    addFriendBtn.textContent = '✅ 已是联系人';
                    addFriendBtn.disabled = true;
                    addFriendBtn.style.background = '#ccc';
                    addFriendBtn.style.cursor = 'not-allowed';
                });
            }
        }

    } else {
        // ★ 卡片点击（事件委托）
        const cardScroll = container.querySelector('.card-scroll');
        if (cardScroll) {
            cardScroll.addEventListener('click', (e) => {
                const card = e.target.closest('.role-card');
                if (!card) return;

                // 如果点的是详情按钮，走详情逻辑
                if (e.target.closest('.view-detail-btn')) {
                    // 详情按钮的点击由它自己处理，这里跳过
                    return;
                }

                const index = parseInt(card.dataset.index);
                if (isNaN(index)) return;
                toggleSelection(index, globalState);
            });
        }

        // ★ 详情按钮点击（事件委托，不需要重复绑定）
        // ★ 分类过滤 + 新建分类
        container.querySelectorAll('.cat-chip[data-cat]').forEach(chip => {
            chip.addEventListener('click', () => {
                activeCategory = chip.dataset.cat === '__all__' ? null : chip.dataset.cat;
                const appContainer = container.closest('.screen-page') || container;
                appContainer.innerHTML = render({ memoryService, globalState });
                bindEvents(appContainer, { memoryService, globalState });
            });
            // ★ 双击分类：弹出勾选编辑
            chip.addEventListener('dblclick', () => {
                const catName = chip.dataset.cat;
                if (catName === '__all__') return;
                showCategoryEditor(catName, container, memoryService, globalState);
            });

        });
        container.querySelector('#addCategoryBtn')?.addEventListener('click', async () => {
            const name = await showPrompt('新分类名称（如：艾泽拉斯世界观）');
            if (name && name.trim()) {
                createCategory(name.trim(), categories);
                const appContainer = container.closest('.screen-page') || container;
                appContainer.innerHTML = render({ memoryService, globalState });
                bindEvents(appContainer, { memoryService, globalState });
            }
        });

        // ★ 左右滚动箭头
        container.querySelectorAll('.scroll-arrow').forEach(btn => {
            btn.addEventListener('click', () => {
                const dir = parseInt(btn.dataset.scroll);
                const scrollAmount = 320;
                const scrollContainer = container.querySelector('.card-scroll');
                if (scrollContainer) {
                    scrollContainer.scrollBy({ left: dir * scrollAmount, behavior: 'smooth' });
                }
            });
        }); container.querySelector('#createCharBtn')?.addEventListener('click', async () => {
            // ★ 弹出一个简单的完整表单
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:200;display:flex;align-items:center;justify-content:center;';
            overlay.innerHTML = `
        <div style="background:white;border-radius:20px;padding:24px;width:300px;max-height:80%;overflow-y:auto;">
            <h3 style="margin-bottom:16px;">📝 新建角色</h3>
            <div style="margin-bottom:10px;">
                <label style="font-size:12px;color:#888;">名称</label>
                <input id="newCharName" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:8px;font-size:14px;" placeholder="必填" />
            </div>
            <!-- ★ 新增：AI 辅助生成按钮 -->
<button id="aiGenerateBtn" style="
    width:100%; margin-bottom:12px; padding:8px;
    border-radius:12px; border:1px solid #0b93f6;
    background:#e3f2fd; color:#0b93f6;
    cursor:pointer; font-size:13px; font-weight:600;
">
    🤖 AI 辅助生成角色
</button>
            <!-- ★ AI 角色描述 -->
            <div style="margin-bottom:10px;">
                <label style="font-size:12px;color:#888;">AI 角色描述</label>
                <textarea id="aiDescInput" style="width:100%;padding:8px;border:1px solid #0b93f6;border-radius:8px;font-size:13px;resize:vertical;" rows="2" placeholder="例如：一个冷酷的暗夜精灵刺客……"></textarea>
                <div id="aiDescStatus" style="font-size:12px; min-height:18px; margin-top:2px;"></div>
            </div>

            <div style="margin-bottom:10px;">
                <label style="font-size:12px;color:#888;">描述</label>
                <textarea id="newCharDesc" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:8px;font-size:13px;resize:vertical;" rows="2" placeholder="角色的基本情况……"></textarea>
            </div>
            <div style="margin-bottom:10px;">
                <label style="font-size:12px;color:#888;">性别</label>
                <input id="newCharGender" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:8px;font-size:14px;" placeholder="男 / 女 / 非二元 / 未知……" />
            </div>
            <div style="margin-bottom:10px;">
                <label style="font-size:12px;color:#888;">年龄</label>
                <input id="newCharAge" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:8px;font-size:14px;" placeholder="例如：24岁 / 少年 / 古老的存在……" />
            </div>
            <div style="margin-bottom:10px;">
                <label style="font-size:12px;color:#888;">性取向</label>
                <input id="newCharOrientation" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:8px;font-size:14px;" placeholder="异性恋 / 同性恋 / 双性恋 / 未知……" />
            </div>
            <div style="margin-bottom:10px;">
                <label style="font-size:12px;color:#888;">说话风格</label>
                <textarea id="newCharStyle" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:8px;font-size:13px;resize:vertical;" rows="2" placeholder="说话方式、语气特点……"></textarea>
            </div>
                        <div style="margin-bottom:10px;">
                <label style="font-size:12px;color:#888;">详细设定</label>
                <textarea id="newCharDetail" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:8px;font-size:13px;resize:vertical;" rows="4" placeholder="外貌特征、性格特点、背景故事等详细设定……"></textarea>
            </div>

            <div style="margin-bottom:10px;">
                <label style="font-size:12px;color:#888;">内心秘密</label>
                <textarea id="newCharSecret" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:8px;font-size:13px;resize:vertical;" rows="2" placeholder="这个角色不为人知的秘密……"></textarea>
            </div>
            <details style="margin-bottom:10px;">
                <summary style="font-size:12px;color:#888;cursor:pointer;">📖 公开信息（分层，可选）</summary>
                <div style="font-size:11px;color:#999;margin-top:4px;margin-bottom:4px;">好友/挚友能看到的额外信息，留空则只有公开名片</div>
                <div style="font-size:12px;color:#7b1fa2;margin-bottom:2px;">【L0 表象层】</div>
<textarea id="newCharProfileL0" rows="2" placeholder="第一眼看到的表象：表面性别、长相、气质……"
          style="width:100%;padding:8px;border:1px solid #ccc;border-radius:8px;font-size:12px;resize:vertical;box-sizing:border-box;margin-bottom:8px;"></textarea>

                <div style="font-size:12px;color:#7b1fa2;margin-bottom:2px;">【L1 熟人层】</div>
                <textarea id="newCharProfileL1" rows="2" placeholder="好友能看到的性格细节……"
                          style="width:100%;padding:8px;border:1px solid #ccc;border-radius:8px;font-size:12px;resize:vertical;box-sizing:border-box;margin-bottom:8px;"></textarea>
                <div style="font-size:12px;color:#7b1fa2;margin-bottom:2px;">【L2 密友层】</div>
                <textarea id="newCharProfileL2" rows="2" placeholder="挚友才知道的秘密、弱点……"
                          style="width:100%;padding:8px;border:1px solid #ccc;border-radius:8px;font-size:12px;resize:vertical;box-sizing:border-box;margin-bottom:8px;"></textarea>
                <div style="font-size:12px;color:#7b1fa2;margin-bottom:2px;">【L3 专属层】每行：角色ID：内容</div>
                <textarea id="newCharProfileL3" rows="2" placeholder="char_主角：只有TA知道的秘密"
                          style="width:100%;padding:8px;border:1px solid #ccc;border-radius:8px;font-size:12px;resize:vertical;box-sizing:border-box;margin-bottom:8px;"></textarea>
                <div style="font-size:12px;color:#7b1fa2;margin-bottom:2px;">【手动指定】每行：角色ID：0/1/2</div>
                <textarea id="newCharProfileManual" rows="2" placeholder="char_法师：2"
                          style="width:100%;padding:8px;border:1px solid #ccc;border-radius:8px;font-size:12px;resize:vertical;box-sizing:border-box;"></textarea>
            </details>

            <div style="margin-bottom:10px; display:flex; align-items:center; gap:8px;">
    <input type="checkbox" id="newCharAutoFriend" checked 
           style="width:16px; height:16px; cursor:pointer;" />
    <label for="newCharAutoFriend" style="font-size:13px; color:#555; cursor:pointer;">
        自动加为当前主视角的好友
    </label>
</div>
            <div style="display:flex;gap:8px;margin-top:16px;">
                <button id="cancelNewChar" style="flex:1;padding:10px;border-radius:20px;border:1px solid #ccc;background:white;cursor:pointer;">取消</button>
                <button id="confirmNewChar" style="flex:1;padding:10px;border-radius:20px;border:none;background:#e91e63;color:white;cursor:pointer;font-weight:600;">✅ 创建</button>
            </div>
            <div id="createCharStatus" style="font-size:12px; min-height:18px; text-align:center; margin-top:8px;"></div>

        </div>
    `;
            document.body.appendChild(overlay);

            // 取消
            overlay.querySelector('#cancelNewChar').addEventListener('click', () => overlay.remove());

            // AI 辅助生成
            overlay.querySelector('#aiGenerateBtn').addEventListener('click', async () => {
                const desc = overlay.querySelector('#aiDescInput')?.value?.trim();
                if (!desc) {
                    const statusEl = overlay.querySelector('#aiDescStatus');
                    if (statusEl) {
                        statusEl.textContent = '⚠️ 请先在描述框中填写角色描述';
                        statusEl.style.color = '#c62828';
                        setTimeout(() => { statusEl.textContent = ''; }, 2000);
                    }
                    return;
                }

                // ★ 收集用户已填内容，作为AI的上下文
                const existing = {
                    name: document.getElementById('newCharName')?.value.trim(),
                    gender: document.getElementById('newCharGender')?.value.trim(),     // ★ 新增
                    age: document.getElementById('newCharAge')?.value.trim(),           // ★ 新增
                    orientation: document.getElementById('newCharOrientation')?.value.trim(), // ★ 新增
                    desc: document.getElementById('newCharDesc')?.value.trim(),
                    style: document.getElementById('newCharStyle')?.value.trim(),
                    secret: document.getElementById('newCharSecret')?.value.trim()
                };
                const filledFields = Object.entries(existing)
                    .filter(([, v]) => v && v !== '❓')
                    .map(([k, v]) => `${k}：${v}`)
                    .join('，');

                const btn = overlay.querySelector('#aiGenerateBtn');
                btn.textContent = '⏳ 生成中……';
                btn.disabled = true;

                try {
                    // ★ 把已填内容传给 AI
                    const fullDescription = filledFields
                        ? `用户已设定：${filledFields}。在此基础上，${desc}`
                        : desc;

                    const result = await createCharacterByAI(fullDescription);

                    // 只填补空白字段
                    const nameInput = document.getElementById('newCharName');
                    const genderInput = document.getElementById('newCharGender');     // ★ 新增
                    const ageInput = document.getElementById('newCharAge');           // ★ 新增
                    const orientationInput = document.getElementById('newCharOrientation'); // ★ 新增
                    const descInput = document.getElementById('newCharDesc');
                    const styleInput = document.getElementById('newCharStyle');
                    const secretInput = document.getElementById('newCharSecret');
                    const detailInput = document.getElementById('newCharDetail');

                    if (!nameInput.value.trim()) nameInput.value = result.name;
                    if (!genderInput.value.trim()) genderInput.value = result.gender || '未知';         // ★ 新增
                    if (!ageInput.value.trim()) ageInput.value = result.age || '未知';                   // ★ 新增
                    if (!orientationInput.value.trim()) orientationInput.value = result.orientation || '未知'; // ★ 新增
                    if (!descInput.value.trim()) descInput.value = result.desc;
                    if (!styleInput.value.trim()) styleInput.value = result.style;
                    if (!secretInput.value.trim()) secretInput.value = result.secret;
                    if (detailInput && !detailInput.value.trim()) detailInput.value = result.detail || '';

                    // ★ 新增：AI 生成的公开信息填入表单（4 个框）
                    if (result.profile) {
                        const l0 = result.profile.L0;
                        const l0Input = document.getElementById('newCharProfileL0');
                        if (l0Input && typeof l0 === 'string' && !l0Input.value.trim()) l0Input.value = l0;
                        const l1 = result.profile.L1, l2 = result.profile.L2;
                        const l1Input = document.getElementById('newCharProfileL1');
                        const l2Input = document.getElementById('newCharProfileL2');
                        if (l1Input && typeof l1 === 'string' && !l1Input.value.trim()) l1Input.value = l1;
                        if (l2Input && typeof l2 === 'string' && !l2Input.value.trim()) l2Input.value = l2;
                    }

                    btn.textContent = '✅ 已生成';
                    setTimeout(() => {
                        btn.textContent = '🤖 AI 辅助生成角色';
                        btn.disabled = false;
                    }, 2000);
                } catch (e) {
                    const statusEl = overlay.querySelector('#aiDescStatus');
                    if (statusEl) {
                        statusEl.textContent = '❌ ' + e.message;
                        statusEl.style.color = '#c62828';
                    }
                    btn.textContent = '🤖 AI 辅助生成角色';
                    btn.disabled = false;
                }
            });

            // 确认创建
            overlay.querySelector('#confirmNewChar').addEventListener('click', () => {
                const name = document.getElementById('newCharName')?.value.trim();
                if (!name) {
                    const statusEl = overlay.querySelector('#createCharStatus');
                    if (statusEl) {
                        statusEl.textContent = '⚠️ 请输入角色名称';
                        statusEl.style.color = '#c62828';
                        setTimeout(() => { statusEl.textContent = ''; }, 2000);
                    }
                    return;
                }

                const newChar = createCharacterByName(name, {
                    gender: document.getElementById('newCharGender')?.value.trim() || '未知',       // ★ 新增
                    age: document.getElementById('newCharAge')?.value.trim() || '未知',             // ★ 新增
                    orientation: document.getElementById('newCharOrientation')?.value.trim() || '未知', // ★ 新增
                    desc: document.getElementById('newCharDesc')?.value.trim() || '',
                    style: document.getElementById('newCharStyle')?.value.trim() || '',
                    secret: document.getElementById('newCharSecret')?.value.trim() || '',
                    detail: document.getElementById('newCharDetail')?.value.trim() || ''


                });

                characters.push(newChar);
                saveCharacters(characters);

                // ★ 新增：把公开信息写入 char_<id>（4 个独立填空区）
                try {
                    new CharacterStore(newChar.id).setProfile({
                        L0: document.getElementById('newCharProfileL0')?.value.trim() || '',
                        L1: document.getElementById('newCharProfileL1')?.value.trim() || '',
                        L2: document.getElementById('newCharProfileL2')?.value.trim() || '',
                        L3: parseIdText(document.getElementById('newCharProfileL3')?.value || ''),
                        manual: parseIdLevel(document.getElementById('newCharProfileManual')?.value || '')
                    });
                } catch (e) { /* 忽略 */ }

                // ★ 新增：在分类视图下新建 → 自动归入当前分类
                if (activeCategory) {
                    assignCategory(newChar.id, activeCategory, categories);
                }


                // ★ 根据复选框决定是否自动加好友
                if (document.getElementById('newCharAutoFriend')?.checked) {
                    const activeChar = globalState?.activeCharacter;
                    autoAddFriend(newChar, activeChar);
                }
                overlay.remove();

                const appContainer = container.closest('.screen-page') || container;
                appContainer.innerHTML = render({ memoryService, globalState });
                bindEvents(appContainer, { memoryService, globalState });
            });
        });
    }
}

// roleBook.js 新增导出
export function restoreActiveCharacter(globalState) {
    const savedIndex = localStorage.getItem(ACTIVE_KEY);
    if (savedIndex === null) return;
    const characters = loadCharacters();
    const idx = parseInt(savedIndex);
    if (characters[idx]) {
        globalState.activeCharacter = characters[idx];
        globalState.activeCharacterId = idx;
    }
}

// ★ 主渲染函数（保留原有列表/详情/编辑切换逻辑）
export function render({ memoryService, globalState } = {}) {
    characters = loadCharacters();
    activeIndex = loadActiveIndex();

    if (viewingIndex !== null && (viewingIndex < 0 || viewingIndex >= characters.length)) {
        viewingIndex = null;
    }

    let html;
    if (viewingIndex !== null) {
        if (isEditing) {
            html = renderEditForm(viewingIndex);
        } else {
            html = renderDetailView(viewingIndex);
        }
    } else {
        html = renderListView();
    }

    // ★ 后台预加载，完成后自动替换灰色占位为图片
    preloadAllImages(characters);

    return html;
}


// ★ 监听形象卡加载完成，自动刷新（作为兜底）
window.addEventListener('image-loaded', function __refreshRolePortrait(e) {
    const { charId, type } = e.detail || {};
    if (!charId) return;

    // ★ 不再依赖 viewingIndex，直接刷新页面上所有匹配的容器
    const selector = `[data-char-id="${charId}"][data-img-type="${type}"]`;
    document.querySelectorAll(selector).forEach(el => {
        const isRound = el.style.borderRadius === '50%';
        el.outerHTML = getImageHtml(charId, type, { round: isRound });
    });
});

// ★ 自我注册（含 init 函数）
if (!window.__moduleRegistry) window.__moduleRegistry = [];
window.__moduleRegistry.push({
    id, label, icon, color, render, bindEvents, handleBack,
    init: restoreActiveCharacter,
    bootInit: true
});

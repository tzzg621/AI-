import { CharacterStore, generateId, addBidirectionalFriend, createDefaultCharacterData } from '../store/CharacterStore.js';
import { clearImageCache, getPortraitHtml, setImage, setImageFromGallery, setCropParams, getImageDataUrl, preloadAllImages } from '../store/ImageCache.js';
import { showCropEditor } from '../store/dialog.js';
// clearImageCache 预留，后续删除角色形象卡时使用
import { createCharacterByName, createCharacterByAI, autoAddFriend } from './characterCreator.js';
// ★ 新增：导入 roleData
import { loadCharacters, saveCharacters, loadActiveIndex, saveActiveIndex, getActiveCharacter, ACTIVE_KEY } from './roleData.js';
import { callAI } from './aiService.js';

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


// ---- 卡片渲染 ----
function createCardHTML(item, index) {
    const isActive = index === activeIndex;
    const isSelected = index === selectedIndex;
    const borderColor = isSelected ? '#0b93f6' : '#eee';

    return `
        <div class="role-card" data-index="${index}"
             style="width:100px; height:130px; border-radius:16px; display:flex; 
                    flex-direction:column; align-items:center; justify-content:center; 
                    cursor:pointer; transition:all 0.2s; box-shadow:0 2px 8px rgba(0,0,0,0.1);
                    background:white; color:#333;
                    border:3px solid ${borderColor};">
            <span style="font-size:32px; margin-bottom:4px;">${item.base.emoji}</span>
            <span style="font-size:14px; font-weight:600;">${item.base.name}</span>
            ${isSelected ? `
                <button class="view-detail-btn" data-index="${index}"
                        style="margin-top:6px; padding:3px 10px; border-radius:12px; 
                               border:none; background:#0b93f6; color:white; font-size:11px; cursor:pointer;">
                    📖 详情
                </button>
            ` : ''}
        </div>
    `;
}

// ---- 渲染列表页 ----
function renderListView() {
    const activeChar = getActiveCharacter(characters, activeIndex);

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
        当前选中角色：${activeChar.base.emoji} ${activeChar.base.name}
    </div>
` : `
    <div style="text-align:center; padding:8px; margin-bottom:12px; 
                background:#f5f5f5; border-radius:12px; font-size:14px; color:#888;">
        尚未选中主视角角色，请选择一个角色
    </div>
`}

                    <p>自身角色卡 + 可切换的角色列表。</p>
                    
                    <div class="card-grid" style="display:flex; gap:12px; flex-wrap:wrap; justify-content:center; margin-top:12px;">
                        ${characters.map((item, index) => createCardHTML(item, index)).join('')}
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

// ---- 渲染详情页 ----
function renderDetailView(index) {
    const chara = characters[index];
    const isActive = index === activeIndex;

    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">${chara.base.emoji} ${chara.base.name}</div>
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
                    <h3 style="text-align:center; margin-bottom:8px;">${chara.base.name}</h3>
                    <p style="text-align:center; color:#666; margin-bottom:16px;">${chara.base.desc}</p>

                    <div style="background:#f5f5f5; border-radius:12px; padding:12px; margin-bottom:16px;">
                        <div style="font-weight:600; margin-bottom:8px;">📊 属性</div>
                        ${Object.entries(chara.base.stats || {}).map(([key, val]) => `
                            <div style="display:flex; justify-content:space-between; padding:4px 0; font-size:14px;">
                                <span>${key}</span>
                                <span style="font-weight:600;">${val}</span>
                            </div>
                        `).join('')}
                    </div>
                    
                    <div style="background:#fff3e0; border-radius:12px; padding:12px; margin-bottom:16px;">
                        <div style="font-weight:600; margin-bottom:4px;">🔒 内心秘密</div>
                        <div style="font-size:14px; color:#e65100;">${chara.base.secret || '无'}</div>
                    </div>

                    <div style="background:#e8f5e9; border-radius:12px; padding:12px; margin-bottom:16px;">
                        <div style="font-weight:600; margin-bottom:4px;">🗣️ 说话风格</div>
                        <div style="font-size:14px; color:#2e7d32;">${chara.base.style || '无'}</div>
                    </div>

                    <div style="background:#e3f2fd; border-radius:12px; padding:12px; margin-bottom:16px;">
                        <div style="font-weight:600; margin-bottom:8px;">📜 独立记忆</div>
                        ${(chara.base.memories || []).map(m => `
                            <div style="padding:6px 0; border-bottom:1px solid #bbdefb; font-size:14px;">
                                <span style="color:#1565c0; font-size:12px;">${m.time}</span>
                                <div style="margin-top:2px;">${m.content}</div>
                            </div>
                        `).join('') || '<div style="font-size:14px; color:#888;">暂无记忆</div>'}
                    </div>

                    ${isEditing ? '' : `
                    <button id="switchCharBtn" style="width:100%; padding:12px; border-radius:24px; border:none;
                            ${isActive ? 'background:#ccc; color:#666; cursor:not-allowed;' : 'background:#e91e63; color:white; cursor:pointer;'}
                            font-size:16px; font-weight:600;" ${isActive ? 'disabled' : ''}>
                        ${isActive ? '✅ 当前已是此角色' : '🔄 切换为此角色'}
                    </button>
                    `}
                    
                    <button id="editCharBtn" style="width:100%; padding:12px; border-radius:24px; border:none;
                            background:#ff9800; color:white; cursor:pointer;
                            font-size:16px; font-weight:600; margin-top:8px;">
                        ${isEditing ? '💾 保存修改' : '✏️ 编辑角色'}
                    </button>
                    
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
                <div class="screen-title">✏️ 编辑 ${chara.base.name}</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card">
                    <div style="margin-bottom:12px;">
                        <label style="font-size:12px; color:#888; display:block; margin-bottom:4px;">图标</label>
                        <input id="editEmoji" type="text" value="${chara.base.emoji}" maxlength="2"
                               style="width:60px; border:1px solid #ccc; border-radius:8px; padding:8px; font-size:20px; text-align:center;" />
                    </div>
                    <div style="margin-bottom:12px;">
                        <label style="font-size:12px; color:#888; display:block; margin-bottom:4px;">名称</label>
                        <input id="editName" type="text" value="${chara.base.name}"
                               style="width:100%; border:1px solid #ccc; border-radius:8px; padding:10px; font-size:15px; box-sizing:border-box;" />
                    </div>
                    <div style="margin-bottom:12px;">
                        <label style="font-size:12px; color:#888; display:block; margin-bottom:4px;">描述</label>
                        <textarea id="editDesc" rows="2"
                                  style="width:100%; border:1px solid #ccc; border-radius:8px; padding:10px; font-size:14px; resize:vertical; box-sizing:border-box; font-family:inherit;">${chara.base.desc || ''}</textarea>
                    </div>
                    <div style="margin-bottom:12px;">
                        <label style="font-size:12px; color:#888; display:block; margin-bottom:4px;">说话风格</label>
                        <textarea id="editStyle" rows="2"
                                  style="width:100%; border:1px solid #ccc; border-radius:8px; padding:10px; font-size:14px; resize:vertical; box-sizing:border-box; font-family:inherit;">${chara.base.style || ''}</textarea>
                    </div>
                    <div style="margin-bottom:12px;">
                        <label style="font-size:12px; color:#888; display:block; margin-bottom:4px;">内心秘密</label>
                        <textarea id="editSecret" rows="2"
                                  style="width:100%; border:1px solid #ccc; border-radius:8px; padding:10px; font-size:14px; resize:vertical; box-sizing:border-box; font-family:inherit;">${chara.base.secret || ''}</textarea>
                    </div>
                    <div style="background:#f5f5f5; border-radius:12px; padding:12px; margin-bottom:16px;">
                        <div style="font-weight:600; margin-bottom:8px;">📊 属性</div>
                        ${Object.entries(chara.base.stats || {}).map(([key, val]) => `
                            <div style="display:flex; align-items:center; gap:8px; padding:4px 0;">
                                <span style="width:40px; font-size:14px;">${key}</span>
                                <input type="number" class="editStat" data-key="${key}" value="${val}" min="1" max="99"
                                       style="flex:1; border:1px solid #ccc; border-radius:6px; padding:4px 8px; font-size:14px;" />
                            </div>
                        `).join('')}
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
    const grid = document.querySelector('.card-grid');
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
                margin-top:6px; padding:3px 10px; border-radius:12px; 
                border:none; background:#0b93f6; color:white; font-size:11px; cursor:pointer;
            `;
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                const idx = parseInt(this.dataset.index);
                viewingIndex = idx;
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
                chara.base.emoji = document.getElementById('editEmoji')?.value || chara.base.emoji;
                chara.base.name = newName;
                chara.base.desc = document.getElementById('editDesc')?.value || '';
                chara.base.style = document.getElementById('editStyle')?.value || '';
                chara.base.secret = document.getElementById('editSecret')?.value || '';

                // 更新属性
                document.querySelectorAll('.editStat').forEach(input => {
                    const key = input.dataset.key;
                    const val = parseInt(input.value);
                    if (key && !isNaN(val)) {
                        chara.base.stats[key] = Math.max(1, Math.min(99, val));
                    }
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
        container.querySelectorAll('.role-card').forEach(card => {
            card.addEventListener('click', function (e) {
                if (e.target.closest('.view-detail-btn')) return;
                const index = parseInt(this.dataset.index);
                toggleSelection(index, globalState);
            });
        });

        container.querySelectorAll('.view-detail-btn').forEach(btn => {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                const index = parseInt(this.dataset.index);
                viewingIndex = index;
                selectedIndex = null;
                const appContainer = container.closest('.screen-page') || container;
                appContainer.innerHTML = render({ memoryService, globalState });
                bindEvents(appContainer, { memoryService, globalState });
            });
        });
        container.querySelector('#createCharBtn')?.addEventListener('click', async () => {
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
                <label style="font-size:12px;color:#888;">图标（Emoji）</label>
                <input id="newCharEmoji" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:8px;font-size:14px;" placeholder="❓" value="❓" />
            </div>
            <div style="margin-bottom:10px;">
                <label style="font-size:12px;color:#888;">描述</label>
                <textarea id="newCharDesc" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:8px;font-size:13px;resize:vertical;" rows="2" placeholder="角色的基本情况……"></textarea>
            </div>
            <div style="margin-bottom:10px;">
                <label style="font-size:12px;color:#888;">说话风格</label>
                <textarea id="newCharStyle" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:8px;font-size:13px;resize:vertical;" rows="2" placeholder="说话方式、语气特点……"></textarea>
            </div>
            <div style="margin-bottom:10px;">
                <label style="font-size:12px;color:#888;">内心秘密</label>
                <textarea id="newCharSecret" style="width:100%;padding:8px;border:1px solid #ccc;border-radius:8px;font-size:13px;resize:vertical;" rows="2" placeholder="这个角色不为人知的秘密……"></textarea>
            </div>
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
                    emoji: document.getElementById('newCharEmoji')?.value.trim(),
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

                    const result = await createCharacterByAI(fullDescription, {
                        callAIFn: callAI
                    });

                    // 只填补空白字段
                    const nameInput = document.getElementById('newCharName');
                    const emojiInput = document.getElementById('newCharEmoji');
                    const descInput = document.getElementById('newCharDesc');
                    const styleInput = document.getElementById('newCharStyle');
                    const secretInput = document.getElementById('newCharSecret');

                    if (!nameInput.value.trim()) nameInput.value = result.name;
                    if (!emojiInput.value.trim() || emojiInput.value === '❓') emojiInput.value = result.emoji;
                    if (!descInput.value.trim()) descInput.value = result.desc;
                    if (!styleInput.value.trim()) styleInput.value = result.style;
                    if (!secretInput.value.trim()) secretInput.value = result.secret;

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
                    emoji: document.getElementById('newCharEmoji')?.value.trim() || '❓',
                    desc: document.getElementById('newCharDesc')?.value.trim() || '',
                    style: document.getElementById('newCharStyle')?.value.trim() || '',
                    secret: document.getElementById('newCharSecret')?.value.trim() || ''
                });

                characters.push(newChar);
                saveCharacters(characters);

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

// apps/location.js — 角色定位

import { getCharacterNameById } from './characterManager.js';

export const id = 'location';
export const label = '定位';
export const icon = '📍';
export const color = '#4CAF50';

const STORAGE_KEY = 'location_data';

// ---- 数据读写 ----
function getData() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        return saved ? JSON.parse(saved) : { enabled: true, locations: {} };
    } catch { return { enabled: true, locations: {} }; }
}

function saveData(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

// ---- 获取所有角色（从角色名册 + CharacterStore）----
function getAllCharacters() {
    const result = [];

    // 从角色名册读取
    try {
        const roleData = localStorage.getItem('rolebook_characters');
        if (roleData) {
            const characters = JSON.parse(roleData);
            characters.forEach(char => {
                if (char.id) {
                    result.push({
                        id: char.id,
                        name: char.base?.name || char.id,
                        emoji: char.base?.emoji || '👤',
                    });
                }
            });
        }
    } catch (e) { }

    // 从 NPC 的 CharacterStore 读取
    try {
        const { CharacterStore } = await_import_CharacterStore();
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('char_')) {
                const id = key.replace('char_', '');
                if (!result.some(c => c.id === id)) {
                    const store = new CharacterStore(id);
                    const info = store.getInfo();
                    if (info.name) {
                        result.push({
                            id: id,
                            name: info.name,
                            emoji: info.emoji || '💬',
                        });
                    }
                }
            }
        }
    } catch (e) { }

    return result;
}

// ---- 懒加载 CharacterStore ----
function await_import_CharacterStore() {
    return import('../store/CharacterStore.js');
}

// ---- 渲染 ----
export function render() {
    const data = getData();
    const characters = getAllCharacters();
    const locations = data.locations || {};

    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">📍 定位</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card" style="padding:0;">

                    <!-- 开关 -->
                    <div style="display:flex; align-items:center; justify-content:space-between; padding:14px 18px; border-bottom:1px solid #f0f0f0;">
                        <div>
                            <div style="font-weight:600; font-size:15px;">📍 定位功能</div>
                            <div style="font-size:12px; color:#999; margin-top:2px;">${data.enabled ? '已开启，角色位置将显示在相关界面' : '已关闭，角色位置信息不可见'}</div>
                        </div>
                        <button id="toggleLocationBtn"
                                style="padding:6px 16px; border-radius:14px; border:none;
                                       background:${data.enabled ? '#4CAF50' : '#ccc'};
                                       color:white; cursor:pointer; font-size:13px; font-weight:600;">
                            ${data.enabled ? '🟢 开启' : '⚪ 关闭'}
                        </button>
                    </div>

                    <!-- 角色列表 -->
                    <div style="padding:10px 14px;">
                        ${!data.enabled ? `
                            <p style="text-align:center; color:#888; padding:20px 0; font-size:13px;">定位功能已关闭，开启后可设置角色位置</p>
                        ` : characters.length === 0 ? `
                            <p style="text-align:center; color:#888; padding:20px 0; font-size:13px;">暂无角色数据</p>
                        ` : characters.map(char => {
                            const loc = locations[char.id];
                            return `
                                <div class="location-char-item" data-charid="${char.id}"
                                     style="display:flex; align-items:center; gap:12px; padding:10px 14px;
                                            background:white; border-radius:12px; margin-bottom:6px;
                                            cursor:pointer; border:1px solid #f0f0f0;">
                                    <span style="font-size:24px;">${char.emoji}</span>
                                    <div style="flex:1;">
                                        <div style="font-weight:600; font-size:14px;">${char.name}</div>
                                        <div style="font-size:12px; color:${loc ? '#4CAF50' : '#ccc'}; margin-top:2px;">
                                            ${loc ? `📍 ${loc.location}` : '未设置位置'}
                                        </div>
                                    </div>
                                    ${loc ? `
                                        <span style="font-size:11px; color:#999;">${formatTime(loc.updatedAt)}</span>
                                    ` : ''}
                                    <span style="color:#ccc; font-size:16px;">›</span>
                                </div>
                            `;
                        }).join('')}
                    </div>

                    ${data.enabled && characters.length > 0 ? `
                    <div style="padding:0 14px 14px;">
                        <button id="clearAllLocationsBtn"
                                style="width:100%; padding:8px; border-radius:12px; border:1px solid #e53935;
                                       background:white; color:#e53935; cursor:pointer; font-size:12px;">
                            🗑️ 清空所有位置
                        </button>
                    </div>
                    ` : ''}
                </div>
            </div>
        </div>
    `;
}

function formatTime(timeStr) {
    if (!timeStr) return '';
    try {
        const date = new Date(timeStr);
        const now = new Date();
        const diff = now - date;
        if (diff < 60000) return '刚刚';
        if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
        if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
        return date.toLocaleDateString('zh-CN');
    } catch { return ''; }
}

// ---- 编辑位置弹窗 ----
function showLocationEditor(charId, charName, currentLocation) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); z-index:300; display:flex; align-items:center; justify-content:center;';

    overlay.innerHTML = `
        <div style="background:white; border-radius:20px; padding:20px; width:280px;">
            <div style="font-weight:600; font-size:16px; margin-bottom:4px;">${charName} 的当前位置</div>
            <div style="font-size:12px; color:#888; margin-bottom:12px;">输入角色当前所在的地点</div>
            <input id="locationInput" type="text" placeholder="例如：暮色森林、古塔、村庄..."
                   value="${currentLocation || ''}"
                   style="width:100%; border:1px solid #ccc; border-radius:8px; padding:8px 10px; font-size:14px; margin-bottom:10px; box-sizing:border-box;" />
            <div style="display:flex; gap:8px;">
                ${currentLocation ? `
                    <button id="locationClearBtn"
                            style="flex:1; padding:8px; border-radius:12px; border:1px solid #e53935;
                                   background:white; color:#e53935; cursor:pointer; font-size:13px;">
                        🗑️ 清除
                    </button>
                ` : ''}
                <button id="locationCancelBtn"
                        style="flex:1; padding:8px; border-radius:12px; border:1px solid #ccc;
                               background:white; color:#666; cursor:pointer; font-size:13px;">取消</button>
                <button id="locationSaveBtn"
                        style="flex:1; padding:8px; border-radius:12px; border:none;
                               background:#4CAF50; color:white; cursor:pointer; font-size:13px;">保存</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('#locationCancelBtn')?.addEventListener('click', () => overlay.remove());

    overlay.querySelector('#locationSaveBtn')?.addEventListener('click', () => {
        const location = overlay.querySelector('#locationInput').value.trim();
        if (!location) { alert('请输入位置'); return; }
        overlay.remove();
        onLocationSave(charId, location);
    });

    overlay.querySelector('#locationClearBtn')?.addEventListener('click', () => {
        overlay.remove();
        onLocationSave(charId, null);
    });

    return overlay;
}

function onLocationSave(charId, location) {
    const data = getData();
    if (location) {
        data.locations[charId] = { location, updatedAt: new Date().toISOString() };
    } else {
        delete data.locations[charId];
    }
    saveData(data);
    refreshPage();
}

function refreshPage() {
    const appContainer = document.querySelector('.page-container');
    if (appContainer) {
        appContainer.innerHTML = render();
        bindEvents(appContainer);
    }
}

// ---- 事件绑定 ----
export function bindEvents(container) {
    // 开关
    container.querySelector('#toggleLocationBtn')?.addEventListener('click', () => {
        const data = getData();
        data.enabled = !data.enabled;
        saveData(data);
        const appContainer = container.closest('.page-container') || container;
        appContainer.innerHTML = render();
        bindEvents(appContainer);
    });

    // 点击角色编辑位置
    container.querySelectorAll('.location-char-item').forEach(item => {
        item.addEventListener('click', () => {
            const charId = item.dataset.charid;
            const data = getData();
            const loc = data.locations[charId];
            const name = item.querySelector('div div')?.textContent || charId;
            showLocationEditor(charId, name, loc?.location || '');
        });
    });

    // 清空所有位置
    container.querySelector('#clearAllLocationsBtn')?.addEventListener('click', () => {
        if (!confirm('确定要清空所有角色的位置吗？')) return;
        const data = getData();
        data.locations = {};
        saveData(data);
        const appContainer = container.closest('.page-container') || container;
        appContainer.innerHTML = render();
        bindEvents(appContainer);
    });
}

// ---- 返回处理 ----
export function handleBack() {
    return false;
}

if (!window.__moduleRegistry) window.__moduleRegistry = [];
window.__moduleRegistry.push({ id, label, icon, color, render, bindEvents, handleBack });

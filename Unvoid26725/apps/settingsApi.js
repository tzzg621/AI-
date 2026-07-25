// apps/settingsApi.js — API 设置子页面（不注册模块，动态加载）

import { getPresets, savePresets, getDefaultPreset, generatePresetId } from './aiService.js';

let editingPresetId = localStorage.getItem('settings_editing_preset') || 'default';

function getCachedModels() {
    try {
        const saved = localStorage.getItem('ai_models_cache');
        return saved ? JSON.parse(saved) : [];
    } catch { return []; }
}

function setCachedModels(models) {
    localStorage.setItem('ai_models_cache', JSON.stringify(models));
}

export function renderApiSettings() {
    // ★ 进入子页面时隐藏顶部状态栏和下拉条
    const statusBar = document.querySelector('.status-bar');
    const pullDownBar = document.getElementById('pullDownBar');
    if (statusBar) statusBar.style.display = 'none';
    if (pullDownBar) pullDownBar.style.display = 'none';
    const presets = getPresets();
    let current = presets.find(p => p.id === editingPresetId);
    if (!current) { current = presets[0] || getDefaultPreset(); editingPresetId = current.id; }
    const cachedModels = getCachedModels();

    return `
        <div class="screen-page">
            <div class="screen-header">
                <button class="status-back-btn" id="apiBackBtn" style="flex-shrink:0;">←</button>
                <div class="screen-title">🔑 API 设置</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card">
                    <!-- 预设切换标签 -->
                    <div style="display:flex; gap:6px; margin-bottom:12px; flex-wrap:wrap; align-items:center;">
                        ${presets.map(p => `
                            <button class="preset-tab" data-preset-id="${p.id}"
                                    style="padding:5px 12px; border-radius:14px; border:1px solid #ddd;
                                           background:${p.id === current.id ? '#0b93f6' : 'white'};
                                           color:${p.id === current.id ? 'white' : '#333'};
                                           cursor:pointer; font-size:12px;
                                           ${p.isDefault ? 'font-weight:bold;' : ''}">
                                ${p.isDefault ? '🌟 ' : ''}${p.name}
                            </button>
                        `).join('')}
                        <button id="addPresetBtn" style="padding:5px 12px; border-radius:14px; border:1px dashed #0b93f6; background:white; color:#0b93f6; cursor:pointer; font-size:12px;">＋</button>
                    </div>

                    <div style="border:1px solid #eee; border-radius:12px; padding:16px;">
                        <!-- 预设名称 -->
                        <div style="display:flex; gap:8px; align-items:center; margin-bottom:12px;">
                            <input type="text" id="presetName" placeholder="预设名称"
                                   value="${current.name}"
                                   style="flex:1; border:1px solid #ccc; border-radius:6px; padding:6px 8px; font-size:14px;" />
                        </div>

                        <!-- API 地址 -->
                        <div style="margin-bottom:10px;">
                            <label style="font-size:12px; color:#888; display:block; margin-bottom:3px;">API 地址</label>
                            <input type="text" id="aiEndpoint" placeholder="https://api.deepseek.com/v1"
                                   value="${current.endpoint || ''}"
                                   style="width:100%; border:1px solid #ccc; border-radius:6px; padding:6px 8px; font-size:13px;" />
                        </div>

                        <!-- 模型名 -->
                        <div style="margin-bottom:10px;">
                            <label style="font-size:12px; color:#888; display:block; margin-bottom:3px;">模型名</label>
                            <div style="display:flex; gap:6px;">
                                <select id="aiModel" style="flex:1; border:1px solid #ccc; border-radius:6px; padding:6px 8px; font-size:13px;">
                                    ${cachedModels.length > 0
            ? cachedModels.map(m => `<option value="${m}" ${current.model === m ? 'selected' : ''}>${m}</option>`).join('')
            : `<option value="${current.model || ''}" selected>${current.model || '请刷新'}</option>`
        }
                                </select>
                                <button id="refreshModelsBtn" style="padding:6px 12px; border-radius:12px; border:1px solid #0b93f6; background:white; color:#0b93f6; cursor:pointer; font-size:12px;">🔄</button>
                            </div>
                            <div id="modelStatus" style="font-size:11px; color:#888; margin-top:3px;">
                                ${cachedModels.length > 0 ? `已缓存 ${cachedModels.length} 个模型` : '点击刷新拉取模型列表'}
                            </div>
                        </div>

                        <!-- API 密钥 -->
                        <div style="margin-bottom:8px;">
                            <label style="font-size:12px; color:#888; display:block; margin-bottom:3px;">API 密钥</label>
                            <input type="password" id="aiKey" placeholder="sk-xxx..."
                                   value="${current.apiKey ? '••••••••' : ''}"
                                   style="width:100%; border:1px solid #ccc; border-radius:6px; padding:6px 8px; font-size:13px;" />
                        </div>
                        <div style="font-size:11px; color:#888; margin-bottom:12px;">🔒 密钥经加密后存储在本地浏览器</div>
<div style="margin-bottom:10px;">
    <label style="font-size:12px; color:#888; display:block; margin-bottom:3px;">上下文字符上限</label>
    <input type="number" id="aiMaxContextChars" placeholder="40000"
           value="${current.maxContextChars || 40000}"
           style="width:100%; border:1px solid #ccc; border-radius:6px; padding:6px 8px; font-size:13px;" />
    <div style="font-size:11px; color:#999; margin-top:3px;">超过此长度时按优先级自动裁减内容。DeepSeek 建议 40000，GPT-4o 建议 150000</div>
</div>
                        <!-- 操作按钮 -->
                        <div style="display:flex; gap:8px; flex-wrap:wrap;">
                            <button id="savePresetBtn" style="flex:1; min-width:100px; padding:8px 16px; border-radius:20px; border:none; background:#0b93f6; color:white; cursor:pointer; font-size:13px;">💾 保存</button>
                            ${!current.isDefault && presets.length > 1 ? `
                                <button id="setDefaultPresetBtn" style="padding:8px 14px; border-radius:20px; border:1px solid #ff9800; background:white; color:#ff9800; cursor:pointer; font-size:12px;">🌟 设为默认</button>
                                <button id="deletePresetBtn" style="padding:8px 14px; border-radius:20px; border:1px solid #e53935; background:white; color:#e53935; cursor:pointer; font-size:12px;">🗑️ 删除</button>
                            ` : `<span style="padding:8px 14px; border-radius:20px; background:#e8f5e9; color:#2e7d32; font-size:12px;">🌟 当前默认</span>`}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

export function bindApiEvents(container, onBack) {
    // ★ 返回按钮
    container.querySelector('#apiBackBtn')?.addEventListener('click', () => {
        resetApiState();

        // ★ 返回时恢复顶部状态栏和下拉条
        const statusBar = document.querySelector('.status-bar');
        const pullDownBar = document.getElementById('pullDownBar');
        if (statusBar) statusBar.style.display = '';
        if (pullDownBar) pullDownBar.style.display = '';

        onBack();
    });

    // 预设切换
    container.querySelectorAll('.preset-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            editingPresetId = btn.dataset.presetId;
            localStorage.setItem('settings_editing_preset', editingPresetId);
            rerender(container, onBack);
        });
    });

    // 新建预设
    container.querySelector('#addPresetBtn')?.addEventListener('click', () => {
        const presets = getPresets();
        presets.push({
            id: generatePresetId(),
            name: `预设 ${presets.length + 1}`,
            endpoint: 'https://api.deepseek.com/v1',
            model: 'deepseek-chat',
            apiKey: '',
            isDefault: false
        });
        savePresets(presets);
        editingPresetId = presets[presets.length - 1].id;
        localStorage.setItem('settings_editing_preset', editingPresetId);
        rerender(container, onBack);
    });

    // 保存
    container.querySelector('#savePresetBtn')?.addEventListener('click', () => {
        const presets = getPresets();
        const idx = presets.findIndex(p => p.id === editingPresetId);
        if (idx < 0) { alert('预设不存在'); return; }
        const keyInput = document.getElementById('aiKey');
        let apiKey = keyInput?.value || '';
        if (apiKey === '••••••••') apiKey = presets[idx].apiKey;
        presets[idx] = {
            ...presets[idx],
            name: document.getElementById('presetName')?.value.trim() || presets[idx].name,
            endpoint: document.getElementById('aiEndpoint')?.value.trim() || presets[idx].endpoint,
            model: document.getElementById('aiModel')?.value || presets[idx].model,
            apiKey: apiKey,
            maxContextChars: parseInt(document.getElementById('aiMaxContextChars')?.value) || 40000
        };
        savePresets(presets);
        alert(`✅ 预设「${presets[idx].name}」已保存`);
    });

    // 设为默认
    container.querySelector('#setDefaultPresetBtn')?.addEventListener('click', () => {
        const presets = getPresets();
        presets.forEach(p => p.isDefault = (p.id === editingPresetId));
        savePresets(presets);
        alert('✅ 已设为默认预设');
        rerender(container, onBack);
    });

    // 删除
    container.querySelector('#deletePresetBtn')?.addEventListener('click', () => {
        if (!confirm('确定要删除这个预设吗？')) return;
        let presets = getPresets();
        presets = presets.filter(p => p.id !== editingPresetId);
        if (presets.length === 0) { alert('至少需要保留一个预设'); return; }
        if (!presets.some(p => p.isDefault)) presets[0].isDefault = true;
        savePresets(presets);
        editingPresetId = presets[0].id;
        localStorage.setItem('settings_editing_preset', editingPresetId);
        rerender(container, onBack);
    });

    // 刷新模型
    container.querySelector('#refreshModelsBtn')?.addEventListener('click', async () => {
        const endpoint = document.getElementById('aiEndpoint')?.value.trim();
        const keyInput = document.getElementById('aiKey');
        let apiKey = keyInput?.value || '';
        if (apiKey === '••••••••') {
            const presets = getPresets();
            apiKey = presets.find(p => p.id === editingPresetId)?.apiKey || '';
        }
        if (!endpoint) { alert('请先填写 API 地址'); return; }
        if (!apiKey) { alert('请先填写 API 密钥'); return; }
        const statusEl = document.getElementById('modelStatus');
        const refreshBtn = container.querySelector('#refreshModelsBtn');
        refreshBtn.disabled = true; refreshBtn.textContent = '⏳';
        if (statusEl) statusEl.textContent = '正在拉取……';
        try {
            const baseUrl = endpoint.replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, '');
            const response = await fetch(`${baseUrl}/models`, {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            const models = data.data.map(m => m.id).sort();
            if (models.length === 0) throw new Error('未找到模型');
            setCachedModels(models);
            const selectEl = document.getElementById('aiModel');
            const currentVal = selectEl?.value || '';
            selectEl.innerHTML = models.map(m => `<option value="${m}" ${m === currentVal ? 'selected' : ''}>${m}</option>`).join('');
            if (statusEl) statusEl.textContent = `✅ ${models.length} 个模型`;
        } catch (e) {
            if (statusEl) statusEl.textContent = `❌ ${e.message}`;
        } finally {
            refreshBtn.disabled = false; refreshBtn.textContent = '🔄';
        }
    });
}

function resetApiState() {
    editingPresetId = localStorage.getItem('settings_editing_preset') || 'default';
}

function rerender(container, onBack) {
    container.innerHTML = renderApiSettings();
    bindApiEvents(container, onBack);
}

// apps/settingsImageGen.js — 生图设置子页面（不注册模块，动态加载）

import { getPresets } from './aiService.js';

const IMAGE_GEN_KEY = 'ai_image_gen_config';

function loadImageGenConfig() {
    try {
        const saved = localStorage.getItem(IMAGE_GEN_KEY);
        return saved ? JSON.parse(saved) : {
            presetId: '',
            endpoint: '',
            model: '',
            apiKey: '',
            apiFormat: 'sd',        
            width: 512,
            height: 512,
            steps: 20,
            negativePrompt: '',
            presetPrompt: ''
        };
    } catch {
        return {
            presetId: '',
            endpoint: '',
            model: '',
            apiKey: '',
            apiFormat: 'sd',        
            width: 512,
            height: 512,
            steps: 20,
            negativePrompt: '',
            presetPrompt: ''
        };
    }
}

function saveImageGenConfig(config) {
    localStorage.setItem(IMAGE_GEN_KEY, JSON.stringify(config));
}

function getCachedModels() {
    try {
        const saved = localStorage.getItem('img_gen_models_cache');
        return saved ? JSON.parse(saved) : [];
    } catch { return []; }
}

function setCachedModels(models) {
    localStorage.setItem('img_gen_models_cache', JSON.stringify(models));
}

export function renderImageGenSettings() {
    const config = loadImageGenConfig();
    const presets = getPresets();
    const cachedModels = getCachedModels();

    return `
        <div class="screen-page">
            <div class="screen-header">
                <button class="status-back-btn" id="imgGenBackBtn" style="flex-shrink:0;">←</button>
                <div class="screen-title">🎨 生图设置</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card">
                    <div style="margin-bottom:14px;">
                        <label style="font-size:12px; color:#888; margin-bottom:4px; display:block;">API 预设</label>
                        <select id="imgGenPresetSelect" style="width:100%; border:1px solid #ccc; border-radius:6px; padding:8px; font-size:13px;">
                            <option value="">-- 使用默认预设 --</option>
                            ${presets.map(p => `
                                <option value="${p.id}" ${config.presetId === p.id ? 'selected' : ''}>${p.name} (${p.model})</option>
                            `).join('')}
                        </select>
                        <div style="font-size:11px; color:#999; margin-top:3px;">选择后自动使用该预设的 API 地址和密钥</div>
                    </div>

                    <div style="border-top:1px solid #eee; padding-top:14px; margin-bottom:14px;">
                        <div style="font-size:13px; color:#888; margin-bottom:8px;">或手动配置（不选择预设时生效）</div>
                        <div style="margin-bottom:10px;">
                            <label style="font-size:12px; color:#888; display:block; margin-bottom:3px;">API 地址</label>
                            <input type="text" id="imgGenEndpoint" placeholder="https://api.example.com/v1/generate"
                                   value="${config.endpoint || ''}"
                                   style="width:100%; border:1px solid #ccc; border-radius:6px; padding:6px 8px; font-size:13px;" />
                        </div>
                        <div style="margin-bottom:10px;">
                            <label style="font-size:12px; color:#888; display:block; margin-bottom:3px;">模型名</label>
                            <div style="display:flex; gap:6px;">
                                <select id="imgGenModel" style="flex:1; border:1px solid #ccc; border-radius:6px; padding:6px 8px; font-size:13px;">
                                    ${cachedModels.length > 0 
                                        ? cachedModels.map(m => `<option value="${m}" ${config.model === m ? 'selected' : ''}>${m}</option>`).join('')
                                        : `<option value="${config.model || ''}" selected>${config.model || '请刷新'}</option>`
                                    }
                                </select>
                                <button id="imgGenRefreshModelsBtn" style="padding:6px 12px; border-radius:12px; border:1px solid #ff7043; background:white; color:#ff7043; cursor:pointer; font-size:12px;">🔄</button>
                            </div>
                            <div id="imgGenModelStatus" style="font-size:11px; color:#888; margin-top:3px;">
                                ${cachedModels.length > 0 ? `已缓存 ${cachedModels.length} 个模型` : '点击刷新拉取模型列表'}
                            </div>
                        </div>
                        <div style="margin-bottom:10px;">
                            <label style="font-size:12px; color:#888; display:block; margin-bottom:3px;">API 密钥</label>
                            <input type="password" id="imgGenKey" placeholder="sk-xxx..."
                                   value="${config.apiKey ? '••••••••' : ''}"
                                   style="width:100%; border:1px solid #ccc; border-radius:6px; padding:6px 8px; font-size:13px;" />
                            <div style="font-size:11px; color:#999; margin-top:3px;">🔒 密钥经加密后存储在本地浏览器</div>
                        </div>
                    </div>

                                        <div style="margin-bottom:10px;">
                        <label style="font-size:12px; color:#888; display:block; margin-bottom:3px;">API 格式</label>
                        <select id="imgGenFormat" style="width:100%; border:1px solid #ccc; border-radius:6px; padding:6px; font-size:13px;">
                            <option value="sd" ${config.apiFormat === 'sd' ? 'selected' : ''}>Stable Diffusion 格式</option>
                            <option value="openai" ${config.apiFormat === 'openai' ? 'selected' : ''}>OpenAI 兼容格式（中转站）</option>
                        </select>
                        <div style="font-size:11px; color:#999; margin-top:3px;">根据你的 API 支持的格式选择</div>
                    </div>


                    <div style="border-top:1px solid #eee; padding-top:14px; margin-bottom:14px;">
                        <div style="font-size:13px; color:#888; margin-bottom:8px;">默认参数</div>
                        <div style="display:flex; gap:8px; margin-bottom:10px;">
                            <div style="flex:1;">
                                <label style="font-size:12px; color:#888; display:block; margin-bottom:3px;">默认宽度</label>
                                <select id="imgGenWidth" style="width:100%; border:1px solid #ccc; border-radius:6px; padding:6px; font-size:13px;">
                                    ${[384, 512, 768, 1024].map(v => `<option value="${v}" ${config.width === v ? 'selected' : ''}>${v}</option>`).join('')}
                                </select>
                            </div>
                            <div style="flex:1;">
                                <label style="font-size:12px; color:#888; display:block; margin-bottom:3px;">默认高度</label>
                                <select id="imgGenHeight" style="width:100%; border:1px solid #ccc; border-radius:6px; padding:6px; font-size:13px;">
                                    ${[384, 512, 768, 1024].map(v => `<option value="${v}" ${config.height === v ? 'selected' : ''}>${v}</option>`).join('')}
                                </select>
                            </div>
                            <div style="flex:1;">
                                <label style="font-size:12px; color:#888; display:block; margin-bottom:3px;">步数</label>
                                <select id="imgGenSteps" style="width:100%; border:1px solid #ccc; border-radius:6px; padding:6px; font-size:13px;">
                                    ${[10, 20, 30, 50].map(v => `<option value="${v}" ${config.steps === v ? 'selected' : ''}>${v}</option>`).join('')}
                                </select>
                            </div>
                        </div>
                        <div style="margin-bottom:10px;">
                            <label style="font-size:12px; color:#888; display:block; margin-bottom:3px;">默认反向提示词</label>
                            <input type="text" id="imgGenNegative" value="${config.negativePrompt || ''}"
                                   placeholder="如：nsfw, low quality"
                                   style="width:100%; border:1px solid #ccc; border-radius:6px; padding:6px 8px; font-size:13px;" />
                        </div>
                        <div style="margin-bottom:10px;">
                            <label style="font-size:12px; color:#888; display:block; margin-bottom:3px;">预设提示词前缀</label>
                            <textarea id="imgGenPresetPrompt" rows="2" placeholder="如：masterpiece, best quality"
                                      style="width:100%; border:1px solid #ccc; border-radius:6px; padding:6px 8px; font-size:13px; resize:vertical; font-family:inherit;">${config.presetPrompt || ''}</textarea>
                        </div>
                    </div>

                    <button id="imgGenSaveBtn" style="
                        width:100%; padding:10px; border-radius:14px; border:none;
                        background:#ff7043; color:white; cursor:pointer; font-size:14px; font-weight:600;
                    ">💾 保存生图设置</button>
                </div>
            </div>
        </div>
    `;
}

export function bindImageGenEvents(container, onBack) {
    // 返回
    container.querySelector('#imgGenBackBtn')?.addEventListener('click', () => {
        const statusBar = document.querySelector('.status-bar');
        const pullDownBar = document.getElementById('pullDownBar');
        if (statusBar) statusBar.style.display = '';
        if (pullDownBar) pullDownBar.style.display = '';
        onBack();
    });

    // 刷新模型列表
    container.querySelector('#imgGenRefreshModelsBtn')?.addEventListener('click', async () => {
        const endpoint = document.getElementById('imgGenEndpoint')?.value.trim();
        const keyInput = document.getElementById('imgGenKey');
        let apiKey = keyInput?.value || '';
        if (apiKey === '••••••••') {
            const config = loadImageGenConfig();
            apiKey = config.apiKey || '';
        }
        if (!endpoint) { alert('请先填写 API 地址'); return; }
        if (!apiKey) { alert('请先填写 API 密钥'); return; }

        const statusEl = document.getElementById('imgGenModelStatus');
        const refreshBtn = container.querySelector('#imgGenRefreshModelsBtn');
        refreshBtn.disabled = true;
        refreshBtn.textContent = '⏳';
        if (statusEl) statusEl.textContent = '正在拉取……';

        try {
            // 尝试从 API 地址推导模型列表地址
            // 常见格式：
            //   https://api.example.com/v1/generate → https://api.example.com/v1/models
            //   https://api.example.com/v1/images/generations → https://api.example.com/v1/models
            let baseUrl = endpoint.replace(/\/generate\/?$/, '').replace(/\/completions\/?$/, '');
            // 去掉最后一段路径，尝试找到 /v1 级别
            const parts = baseUrl.split('/');
            if (parts.length >= 3) {
                // 保留到 /v1 或 /v2
                const vIndex = parts.findIndex(p => /^v\d+$/.test(p));
                if (vIndex >= 0) {
                    baseUrl = parts.slice(0, vIndex + 1).join('/');
                } else {
                    // 没有版本号，去掉最后一段作为 base
                    baseUrl = parts.slice(0, -1).join('/');
                }
            }
            const modelUrl = baseUrl + '/models';

            const response = await fetch(modelUrl, {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();

            let models = [];
            if (data.data && Array.isArray(data.data)) {
                // OpenAI 格式：{ data: [{ id: 'model-name', ... }] }
                models = data.data.map(m => m.id).sort();
            } else if (Array.isArray(data)) {
                // 简单数组格式
                models = data.map(m => m.id || m.name || m).sort();
            } else {
                throw new Error('无法解析模型列表');
            }

            if (models.length === 0) throw new Error('未找到模型');
            setCachedModels(models);

            const selectEl = document.getElementById('imgGenModel');
            const currentVal = selectEl?.value || '';
            selectEl.innerHTML = models.map(m => 
                `<option value="${m}" ${m === currentVal ? 'selected' : ''}>${m}</option>`
            ).join('');

            if (statusEl) statusEl.textContent = `✅ ${models.length} 个模型`;
        } catch (e) {
            if (statusEl) statusEl.textContent = `❌ ${e.message}`;
        } finally {
            refreshBtn.disabled = false;
            refreshBtn.textContent = '🔄';
        }
    });

    // 保存
    container.querySelector('#imgGenSaveBtn')?.addEventListener('click', () => {
        const config = loadImageGenConfig();
        const keyInput = document.getElementById('imgGenKey');
        let apiKey = keyInput?.value || '';
        if (apiKey === '••••••••') apiKey = config.apiKey;

        saveImageGenConfig({
            presetId: document.getElementById('imgGenPresetSelect')?.value || '',
            endpoint: document.getElementById('imgGenEndpoint')?.value.trim() || config.endpoint,
            model: document.getElementById('imgGenModel')?.value || config.model,
            apiKey: apiKey,
            apiFormat: document.getElementById('imgGenFormat')?.value || 'sd', 
            width: parseInt(document.getElementById('imgGenWidth')?.value) || 512,
            height: parseInt(document.getElementById('imgGenHeight')?.value) || 512,
            steps: parseInt(document.getElementById('imgGenSteps')?.value) || 20,
            negativePrompt: document.getElementById('imgGenNegative')?.value || '',
            presetPrompt: document.getElementById('imgGenPresetPrompt')?.value || ''
        });

        const toast = document.createElement('div');
        toast.textContent = '✅ 生图设置已保存';
        toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:10px 20px;border-radius:10px;z-index:9999;font-size:14px;';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2000);
    });
}

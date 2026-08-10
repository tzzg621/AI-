// apps/market/aiImageGen.js — AI 图片生成器

import { setGlobalImage, getImageDataUrl, removeImage, getGlobalImageHtml, getAllImageKeys } from '../../store/ImageCache.js';
import { showConfirm } from '../../store/dialog.js';

// ---- 默认配置 ----
const CONFIG_KEY = 'ai_image_gen_local_config';
const GLOBAL_CONFIG_KEY = 'ai_image_gen_config';
const HISTORY_KEY = 'ai_image_gen_history';

function getConfig() {
    let localConfig = {};
    try {
        const saved = localStorage.getItem(CONFIG_KEY);
        if (saved) localConfig = JSON.parse(saved);
    } catch { }

    let globalConfig = {};
    try {
        const saved = localStorage.getItem(GLOBAL_CONFIG_KEY);
        if (saved) globalConfig = JSON.parse(saved);
    } catch { }

    return {
        endpoint: localConfig.endpoint || globalConfig.endpoint || '',
        model: localConfig.model || globalConfig.model || '',
        apiKey: localConfig.apiKey || globalConfig.apiKey || '',
        apiFormat: localConfig.apiFormat || globalConfig.apiFormat || 'sd',
        width: localConfig.width || globalConfig.width || 512,
        height: localConfig.height || globalConfig.height || 512,
        steps: localConfig.steps || globalConfig.steps || 20,
        negativePrompt: localConfig.negativePrompt || globalConfig.negativePrompt || '',
        presetPrompt: localConfig.presetPrompt || globalConfig.presetPrompt || ''
    };
}

function saveConfig(config) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

function getHistory() {
    try {
        const saved = localStorage.getItem(HISTORY_KEY);
        return saved ? JSON.parse(saved) : [];
    } catch { return []; }
}

function saveHistory(history) {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 50)));
}

function genId() {
    return 'img_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
}

// ---- 状态 ----
let currentTab = 'generate';
let isGenerating = false;
let lastResultDataUrl = null;     // 最近一次生成的结果（用于渲染）
let lastResultKey = null;         // ★ 最近一次生成的图片 key（用于引用存储）

// ---- toast ----
function showToast(msg, color = '#333') {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:${color};color:#fff;padding:10px 20px;border-radius:10px;z-index:9999;font-size:14px;`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2000);
}

// ---- 加入 AI 图片相册 ----
function addToAiAlbum(key) {
    const ALBUMS_KEY = 'gallery_albums';
    try {
        const albums = JSON.parse(localStorage.getItem(ALBUMS_KEY) || '[]');
        let aiAlbum = albums.find(a => a.id === 'album_ai_images');
        if (!aiAlbum) {
            aiAlbum = { id: 'album_ai_images', name: 'AI 图片', type: 'custom', images: [] };
            albums.push(aiAlbum);
        }
        if (!aiAlbum.images.includes(key)) {
            aiAlbum.images.push(key);
        }
        localStorage.setItem(ALBUMS_KEY, JSON.stringify(albums));
    } catch { }
}

// ---- 渲染 ----
function renderGenerateTab() {
    const config = getConfig();
    return `
        <div style="padding:16px;">
            <div style="margin-bottom:14px;">
                <label style="font-size:12px; color:#888; margin-bottom:4px; display:block;">提示词（必填）</label>
                <textarea id="imgPromptInput" rows="3" placeholder="描述你想要生成的图片……"
                          style="width:100%; border:1px solid #ccc; border-radius:8px; padding:10px; font-size:14px; line-height:1.5; resize:vertical; box-sizing:border-box; font-family:inherit;">${config.presetPrompt || ''}</textarea>
            </div>
            <div style="margin-bottom:14px;">
                <label style="font-size:12px; color:#888; margin-bottom:4px; display:block;">反向提示词（可选）</label>
                <input id="imgNegativeInput" type="text" placeholder="不想出现的内容……"
                       style="width:100%; border:1px solid #ccc; border-radius:8px; padding:10px; font-size:13px; box-sizing:border-box;" />
            </div>
            <div style="display:flex; gap:8px; margin-bottom:14px;">
                <div style="flex:1;">
                    <label style="font-size:12px; color:#888; margin-bottom:4px; display:block;">宽</label>
                    <select id="imgWidthSelect" style="width:100%; border:1px solid #ccc; border-radius:6px; padding:8px; font-size:13px;">
                        <option value="384" ${config.width === 384 ? 'selected' : ''}>384</option>
                        <option value="512" ${config.width === 512 ? 'selected' : ''}>512</option>
                        <option value="768" ${config.width === 768 ? 'selected' : ''}>768</option>
                        <option value="1024" ${config.width === 1024 ? 'selected' : ''}>1024</option>
                    </select>
                </div>
                <div style="flex:1;">
                    <label style="font-size:12px; color:#888; margin-bottom:4px; display:block;">高</label>
                    <select id="imgHeightSelect" style="width:100%; border:1px solid #ccc; border-radius:6px; padding:8px; font-size:13px;">
                        <option value="384" ${config.height === 384 ? 'selected' : ''}>384</option>
                        <option value="512" ${config.height === 512 ? 'selected' : ''}>512</option>
                        <option value="768" ${config.height === 768 ? 'selected' : ''}>768</option>
                        <option value="1024" ${config.height === 1024 ? 'selected' : ''}>1024</option>
                    </select>
                </div>
                <div style="flex:1;">
                    <label style="font-size:12px; color:#888; margin-bottom:4px; display:block;">步数</label>
                    <select id="imgStepsSelect" style="width:100%; border:1px solid #ccc; border-radius:6px; padding:8px; font-size:13px;">
                        <option value="10" ${config.steps === 10 ? 'selected' : ''}>10</option>
                        <option value="20" ${config.steps === 20 ? 'selected' : ''}>20</option>
                        <option value="30" ${config.steps === 30 ? 'selected' : ''}>30</option>
                        <option value="50" ${config.steps === 50 ? 'selected' : ''}>50</option>
                    </select>
                </div>
            </div>
            <button id="imgGenerateBtn" style="
                width:100%; padding:12px; border-radius:14px; border:none;
                background:${isGenerating ? '#ccc' : '#ff7043'}; color:white;
                cursor:${isGenerating ? 'not-allowed' : 'pointer'};
                font-size:15px; font-weight:600;
            " ${isGenerating ? 'disabled' : ''}>
                ${isGenerating ? '⏳ 生成中……' : '✨ 生成图片'}
            </button>

            <div id="imgResultArea" style="margin-top:16px; ${lastResultDataUrl ? 'display:block;' : 'display:none;'}">
                <div style="border-radius:12px; overflow:hidden; background:#f0f0f0; aspect-ratio:1; max-width:100%; margin:0 auto;">
                    <img id="imgResultImg" style="width:100%; height:100%; object-fit:contain; display:block;" 
                         src="${lastResultDataUrl || ''}" />
                </div>
                <div style="display:flex; gap:8px; margin-top:10px;">
                    <button id="imgSaveToAlbumBtn" style="
                        flex:1; padding:10px; border-radius:12px; border:none;
                        background:#4caf50; color:white; cursor:pointer; font-size:13px; font-weight:600;
                    ">💾 保存到相册</button>
                    <button id="imgDownloadBtn" style="
                        flex:1; padding:10px; border-radius:12px; border:1px solid #ccc;
                        background:white; color:#666; cursor:pointer; font-size:13px;
                    ">⬇ 下载</button>
                </div>
            </div>
        </div>
    `;
}

function renderHistoryTab() {
    const history = getHistory();
    const enriched = history.map(item => ({
        ...item,
        html: item.key ? getGlobalImageHtml(item.key) : ''
    }));
    return `
        <div style="padding:16px;">
            ${enriched.length === 0 ? `
                <p style="text-align:center; color:#888; padding:30px 0; font-size:14px;">暂无生成记录</p>
            ` : `
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
                    ${enriched.map(item => `
                <div class="history-grid-item" data-key="${item.key}" style="border-radius:10px; overflow:hidden; background:#f0f0f0; aspect-ratio:1; position:relative; cursor:pointer;">
                            ${item.html || '<div style="width:100%;height:100%;background:#e0e0e0;"></div>'}
                            <div style="position:absolute; bottom:0; left:0; right:0; background:rgba(0,0,0,0.5); color:white; padding:4px 8px; font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                                ${item.prompt || ''}
                            </div>
                            <div style="position:absolute; top:4px; right:4px; display:flex; gap:4px;">
                                <button class="history-save-btn" data-key="${item.key}" style="
                                    width:22px; height:22px; border-radius:50%; border:none;
                                    background:rgba(0,0,0,0.5); color:white; cursor:pointer; font-size:10px; line-height:1;
                                ">💾</button>
                                <button class="history-dl-btn" data-key="${item.key}" style="
                                    width:22px; height:22px; border-radius:50%; border:none;
                                    background:rgba(0,0,0,0.5); color:white; cursor:pointer; font-size:10px; line-height:1;
                                ">⬇</button>
                            </div>
                        </div>
                    `).join('')}
                </div>
                <button id="imgClearHistoryBtn" style="
                    width:100%; margin-top:12px; padding:8px; border-radius:12px;
                    border:1px solid #e53935; background:white; color:#e53935; cursor:pointer; font-size:12px;
                ">🗑️ 清空历史</button>
                                <button id="imgRecoverBtn" style="
                    width:100%; margin-top:8px; padding:8px; border-radius:12px;
                    border:1px solid #0b93f6; background:white; color:#0b93f6; cursor:pointer; font-size:12px;
                ">🔍 从存储恢复</button>

            `}
        </div>
    `;
}

function renderSettingsTab() {
    const config = getConfig();
    return `
        <div style="padding:16px;">
            <div style="margin-bottom:14px;">
                <label style="font-size:12px; color:#888; margin-bottom:4px; display:block;">API 地址</label>
                <input id="imgApiEndpoint" type="text" value="${config.endpoint || ''}" placeholder="https://api.example.com/v1/generate"
                       style="width:100%; border:1px solid #ccc; border-radius:8px; padding:10px; font-size:13px; box-sizing:border-box;" />
                <div style="font-size:11px; color:#999; margin-top:3px;">留空则使用全局生图设置中的配置</div>
            </div>
            <div style="margin-bottom:14px;">
                <label style="font-size:12px; color:#888; margin-bottom:4px; display:block;">模型名</label>
                <input id="imgApiModel" type="text" value="${config.model || ''}" placeholder="如：stable-diffusion-xl"
                       style="width:100%; border:1px solid #ccc; border-radius:8px; padding:10px; font-size:13px; box-sizing:border-box;" />
                <div style="font-size:11px; color:#999; margin-top:3px;">留空则使用全局生图设置中的配置</div>
            </div>
            <div style="margin-bottom:14px;">
                <label style="font-size:12px; color:#888; margin-bottom:4px; display:block;">API 密钥</label>
                <input id="imgApiKey" type="password" value="${config.apiKey ? '••••••••' : ''}" placeholder="sk-xxx..."
                       style="width:100%; border:1px solid #ccc; border-radius:8px; padding:10px; font-size:13px; box-sizing:border-box;" />
                <div style="font-size:11px; color:#999; margin-top:3px;">留空则使用全局生图设置中的配置</div>
            </div>
            <div style="margin-bottom:14px;">
                <label style="font-size:12px; color:#888; margin-bottom:4px; display:block;">API 格式</label>
                <select id="imgApiFormat" style="width:100%; border:1px solid #ccc; border-radius:6px; padding:8px; font-size:13px;">
                    <option value="sd" ${config.apiFormat === 'sd' ? 'selected' : ''}>Stable Diffusion 格式</option>
                    <option value="openai" ${config.apiFormat === 'openai' ? 'selected' : ''}>OpenAI 兼容格式（中转站）</option>
                </select>
                <div style="font-size:11px; color:#999; margin-top:3px;">根据你的 API 支持的格式选择</div>
            </div>
            <div style="margin-bottom:14px;">
                <label style="font-size:12px; color:#888; margin-bottom:4px; display:block;">预设提示词（每次生成自动填入）</label>
                <textarea id="imgPresetPrompt" rows="2" placeholder="例如：masterpiece, best quality, detailed"
                          style="width:100%; border:1px solid #ccc; border-radius:8px; padding:10px; font-size:13px; resize:vertical; box-sizing:border-box; font-family:inherit;">${config.presetPrompt || ''}</textarea>
            </div>
            <button id="imgSaveSettingsBtn" style="
                width:100%; padding:10px; border-radius:12px; border:none;
                background:#0b93f6; color:white; cursor:pointer; font-size:14px; font-weight:600;
            ">💾 保存设置</button>
        </div>
    `;
}

export function render() {
    const tabs = [
        { id: 'generate', label: '✨ 生成', icon: '🎨' },
        { id: 'history', label: '📋 历史', icon: '🕐' },
        { id: 'settings', label: '⚙️ 设置', icon: '🔧' },
    ];

    return `
        <div class="screen-page" style="background:#f8f8fa;">
            <div class="screen-header">
                <div class="screen-title">🎨 AI 图片生成</div>
                <div class="header-spacer"></div>
            </div>
            <div style="display:flex; border-bottom:1px solid #eee; background:white;">
                ${tabs.map(tab => `
                    <button class="img-tab-btn" data-tab="${tab.id}" style="
                        flex:1; padding:10px; border:none; background:white;
                        color:${currentTab === tab.id ? '#ff7043' : '#888'};
                        font-size:13px; font-weight:${currentTab === tab.id ? '600' : '400'};
                        cursor:pointer; border-bottom:2px solid ${currentTab === tab.id ? '#ff7043' : 'transparent'};
                        transition:all 0.2s;
                    ">${tab.icon} ${tab.label}</button>
                `).join('')}
            </div>
            <div class="screen-content" style="flex:1; overflow-y:auto;">
                ${currentTab === 'generate' ? renderGenerateTab() : ''}
                ${currentTab === 'history' ? renderHistoryTab() : ''}
                ${currentTab === 'settings' ? renderSettingsTab() : ''}
            </div>
        </div>
    `;
}

// ---- 调用生图 API ----
async function callImageAPI(prompt, negativePrompt, width, height, steps) {
    const config = getConfig();
    if (!config.endpoint) throw new Error('请先在设置中配置 API 地址');
    if (!config.apiKey) throw new Error('请先在设置中配置 API 密钥');

    const url = config.endpoint;
    const finalUrl = (function () {
        let u = url.replace(/\/+$/, '');
        if (config.apiFormat === 'openai' && !u.endsWith('/images/generations')) {
            u += '/images/generations';
        }
        return u;
    })();

    let body;
    if (config.apiFormat === 'openai') {
        body = {
            model: config.model || 'dall-e-3',
            prompt: prompt,
            n: 1,
            size: `${width}x${height}`,
            response_format: 'b64_json'
        };
    } else {
        body = {
            model: config.model || 'default',
            prompt: prompt,
            negative_prompt: negativePrompt || '',
            width: parseInt(width),
            height: parseInt(height),
            steps: parseInt(steps),
            n: 1,
            response_format: 'b64_json'
        };
    }

    console.log('📤 生图请求地址:', finalUrl);

    const response = await fetch(finalUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        let errMsg = `HTTP ${response.status}`;
        try { const err = await response.json(); errMsg = err.error?.message || err.message || errMsg; } catch { }
        throw new Error(`生图失败: ${errMsg}`);
    }

    const data = await response.json();
    let imageData = null;
    if (data.data && data.data[0]) {
        imageData = data.data[0].b64_json || data.data[0].image || data.data[0].url;
    } else if (data.images && data.images[0]) {
        imageData = data.images[0].b64_json || data.images[0].image;
    } else if (data.output && data.output[0]) {
        imageData = data.output[0];
    } else if (data.image) {
        imageData = data.image;
    }
    if (!imageData) throw new Error('无法解析 API 返回的图片数据');

    if (imageData.startsWith('http')) {
        const imgResp = await fetch(imageData);
        const blob = await imgResp.blob();
        return await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(blob);
        });
    }
    return `data:image/png;base64,${imageData}`;
}

// ---- 事件绑定 ----
export function bindEvents(container) {
    container.querySelectorAll('.img-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            currentTab = btn.dataset.tab;
            const appContainer = container.closest('.screen-page') || container;
            appContainer.innerHTML = render();
            bindEvents(appContainer);
        });
    });

    // ---- 生成 Tab ----
    if (currentTab === 'generate') {
        const generateBtn = container.querySelector('#imgGenerateBtn');
        const resultArea = container.querySelector('#imgResultArea');
        const resultImg = container.querySelector('#imgResultImg');

        generateBtn?.addEventListener('click', async () => {
            if (isGenerating) return;
            const prompt = container.querySelector('#imgPromptInput')?.value.trim();
            if (!prompt) { showToast('请输入提示词', '#c62828'); return; }
            const negativePrompt = container.querySelector('#imgNegativeInput')?.value.trim() || '';
            const width = container.querySelector('#imgWidthSelect')?.value || 512;
            const height = container.querySelector('#imgHeightSelect')?.value || 512;
            const steps = container.querySelector('#imgStepsSelect')?.value || 20;

            isGenerating = true;
            generateBtn.textContent = '⏳ 生成中……';
            generateBtn.disabled = true;
            generateBtn.style.background = '#ccc';

            try {
                const tm = await _getTaskManager();
                const callFn = () => callImageAPI(prompt, negativePrompt, width, height, steps);
                let dataUrl;
                if (tm) {
                    dataUrl = await tm.watch('imagegen', `生成图片: ${prompt.slice(0, 30)}...`, callFn);
                } else {
                    dataUrl = await callFn();
                }
                lastResultDataUrl = dataUrl;
                lastResultKey = genId();
                setGlobalImage(lastResultKey, dataUrl);

                const history = getHistory();
                history.unshift({ key: lastResultKey, prompt, createdAt: new Date().toISOString() });
                saveHistory(history);

                resultImg.src = dataUrl;
                resultArea.style.display = 'block';
                generateBtn.textContent = '✨ 再生成一张';
            } catch (e) {
                showToast('❌ ' + e.message, '#c62828');
                generateBtn.textContent = '✨ 生成图片';
            } finally {
                isGenerating = false;
                generateBtn.disabled = false;
                generateBtn.style.background = '#ff7043';
            }
        });

        container.querySelector('#imgSaveToAlbumBtn')?.addEventListener('click', () => {
            if (!lastResultKey) { showToast('请先生成图片', '#c62828'); return; }
            addToAiAlbum(lastResultKey);
            showToast('✅ 已保存到「AI 图片」相册');
        });

        container.querySelector('#imgDownloadBtn')?.addEventListener('click', () => {
            if (!lastResultDataUrl) { showToast('请先生成图片', '#c62828'); return; }
            const a = document.createElement('a');
            a.href = lastResultDataUrl;
            a.download = 'ai_generated_' + Date.now() + '.png';
            a.click();
        });
    }

    // ---- 历史 Tab ----
    if (currentTab === 'history') {
        container.querySelectorAll('.history-save-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const key = btn.dataset.key;
                if (key) {
                    addToAiAlbum(key);
                    showToast('✅ 已保存到「AI 图片」相册');
                }
            });
        });

        container.querySelectorAll('.history-dl-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const key = btn.dataset.key;
                const dataUrl = key ? getImageDataUrl(key) : null;
                if (!dataUrl) { showToast('图片数据已丢失', '#c62828'); return; }
                const a = document.createElement('a');
                a.href = dataUrl;
                a.download = 'ai_generated_' + Date.now() + '.png';
                a.click();
            });
        });

                // ★ 点击历史图片大图预览
        container.querySelectorAll('.history-grid-item').forEach(item => {
            item.addEventListener('click', () => {
                const key = item.dataset.key;
                if (!key) return;
                getImageDataUrl(key).then(dataUrl => {
                    if (!dataUrl) { showToast('图片数据已丢失', '#c62828'); return; }
                    const overlay = document.createElement('div');
                    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:300;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;cursor:pointer;';
                    const img = document.createElement('img');
                    img.src = dataUrl;
                    img.style.cssText = 'max-width:90%;max-height:85%;border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,0.5);object-fit:contain;cursor:default;';
                    overlay.appendChild(img);
                    document.body.appendChild(overlay);
                    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
                    img.addEventListener('click', () => overlay.remove());
                });
            });
        });


        container.querySelector('#imgClearHistoryBtn')?.addEventListener('click', async () => {
            const ok = await showConfirm('确定要清空所有生成记录吗？图片数据将被永久删除。');
            if (!ok) return; const history = getHistory();
            history.forEach(item => {
                if (item.key) removeImage(item.key);
            });
            saveHistory([]);
            const appContainer = container.closest('.screen-page') || container;
            appContainer.innerHTML = render();
            bindEvents(appContainer);
        });

                // ★ 从存储恢复
        container.querySelector('#imgRecoverBtn')?.addEventListener('click', async () => {
            try {
                const allKeys = await getAllImageKeys();
                const existing = getHistory();
                const existingKeys = new Set(existing.map(h => h.key));
                const newKeys = allKeys.filter(k => !existingKeys.has(k));
                if (newKeys.length === 0) {
                    showToast('没有需要恢复的记录', '#888');
                    return;
                }
                const history = getHistory();
                newKeys.forEach(key => {
                    history.unshift({ key, prompt: '（已恢复）', createdAt: new Date().toISOString() });
                });
                saveHistory(history);
                showToast(`✅ 已恢复 ${newKeys.length} 条`, '#4CAF50');
                const appContainer = container.closest('.screen-page') || container;
                appContainer.innerHTML = render();
                bindEvents(appContainer);
            } catch (e) {
                showToast('❌ 恢复失败: ' + e.message, '#c62828');
            }
        });

    }

    // ---- 设置 Tab ----
    if (currentTab === 'settings') {
        container.querySelector('#imgSaveSettingsBtn')?.addEventListener('click', () => {
            const config = getConfig();
            const keyInput = document.getElementById('imgApiKey');
            let apiKey = keyInput?.value || '';
            if (apiKey === '••••••••') apiKey = config.apiKey;

            saveConfig({
                endpoint: document.getElementById('imgApiEndpoint')?.value.trim() || '',
                model: document.getElementById('imgApiModel')?.value.trim() || '',
                apiKey: apiKey,
                apiFormat: document.getElementById('imgApiFormat')?.value || 'sd',
                width: parseInt(document.getElementById('imgWidthSelect')?.value) || config.width,
                height: parseInt(document.getElementById('imgHeightSelect')?.value) || config.height,
                steps: parseInt(document.getElementById('imgStepsSelect')?.value) || config.steps,
                presetPrompt: document.getElementById('imgPresetPrompt')?.value || ''
            });
            showToast('✅ 设置已保存', '#0b93f6');
        });
    }
}

// ---- 注册到市场 ----
export const id = 'ai-image-gen';
export const label = 'AI 图片';
export const icon = '🎨';
export const color = '#ff7043';


// ★ 动态加载任务中心
let _taskManagerCache = null;
async function _getTaskManager() {
    if (_taskManagerCache !== null) return _taskManagerCache;
    try {
        const mod = await import('../../store/AITaskManager.js');
        _taskManagerCache = mod.taskManager;
    } catch {
        _taskManagerCache = false;
    }
    return _taskManagerCache;
}

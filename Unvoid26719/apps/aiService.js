// apps/aiService.js — AI 服务层

const PRESETS_KEY = 'ai_presets';

// ---- 加密工具 ----
function encrypt(text, salt) {
    const mixed = text.split('').map((c, i) => {
        const code = c.charCodeAt(0) ^ salt.charCodeAt(i % salt.length);
        return String.fromCharCode(code);
    }).join('');
    return btoa(encodeURIComponent(mixed));
}

function decrypt(encoded, salt) {
    try {
        const mixed = decodeURIComponent(atob(encoded));
        return mixed.split('').map((c, i) => {
            const code = c.charCodeAt(0) ^ salt.charCodeAt(i % salt.length);
            return String.fromCharCode(code);
        }).join('');
    } catch {
        return '';
    }
}

function getSalt() {
    return (navigator.userAgent + '|' + navigator.language).slice(0, 16);
}

// ---- 自动迁移旧数据 ----
function migrateOldConfigIfNeeded() {
    const oldConfig = localStorage.getItem('ai_config');
    const oldApiKey = localStorage.getItem('ai_api_key');
    if (!oldConfig && !oldApiKey) return;

    let endpoint = '', model = '', apiKey = '';

    if (oldConfig) {
        try {
            const parsed = JSON.parse(oldConfig);
            endpoint = parsed.endpoint || '';
            model = parsed.model || '';
            if (parsed.apiKey) {
                const salt = getSalt();
                apiKey = decrypt(parsed.apiKey, salt);
            }
        } catch { }
    }
    if (!apiKey && oldApiKey) {
        apiKey = oldApiKey;
    }

    const presets = [{
        id: 'default',
        name: '默认',
        endpoint: endpoint || 'https://api.deepseek.com/v1',
        model: model || 'deepseek-chat',
        apiKey: apiKey,
        isDefault: true,
        maxContextChars: 40000
    }];

    savePresets(presets);
    localStorage.removeItem('ai_config');
    localStorage.removeItem('ai_api_key');
    localStorage.removeItem('ai_models_cache');
}

// ---- 预设管理 ----
export function getPresets() {
    migrateOldConfigIfNeeded();

    try {
        const saved = localStorage.getItem(PRESETS_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            if (!Array.isArray(parsed) || parsed.length === 0) throw 'empty';
            const salt = getSalt();
            return parsed.map(p => ({
                ...p,
                apiKey: p.apiKey ? decrypt(p.apiKey, salt) : ''
            }));
        }
    } catch { /* 忽略 */ }

    return [{
        id: 'default',
        name: '默认',
        endpoint: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        apiKey: '',
        isDefault: true,
        maxContextChars: 40000
        
    }];
}

export function savePresets(presets) {
    if (!Array.isArray(presets) || presets.length === 0) return;
    const salt = getSalt();
    const toSave = presets.map(p => ({
        ...p,
        apiKey: p.apiKey ? encrypt(p.apiKey, salt) : ''
    }));
    localStorage.setItem(PRESETS_KEY, JSON.stringify(toSave));
}

export function getPreset(id) {
    if (!id) return null;
    const presets = getPresets();
    return presets.find(p => p.id === id) || null;
}

export function getDefaultPreset() {
    const presets = getPresets();
    return presets.find(p => p.isDefault) || presets[0] || null;
}

export function generatePresetId() {
    return 'preset_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
}

export function getConfig() {
    const preset = getDefaultPreset();
    return preset || { endpoint: '', model: '', apiKey: '' };
}

export function saveConfig({ endpoint, model, apiKey }) {
    const presets = getPresets();
    const idx = presets.findIndex(p => p.isDefault || p.id === 'default');
    const preset = {
        id: 'default',
        name: '默认',
        endpoint: endpoint || 'https://api.deepseek.com/v1',
        model: model || 'deepseek-chat',
        apiKey: apiKey || '',
        isDefault: true,
        maxContextChars: 40000
    };
    if (idx >= 0) {
        presets[idx] = preset;
    } else {
        presets.unshift(preset);
    }
    savePresets(presets);
}

export function hasApiKey(presetId) {
    const preset = presetId ? getPreset(presetId) : getDefaultPreset();
    return preset ? !!preset.apiKey : false;
}


export async function callAI({ systemPrompt, assistantContext, presetId } = {}) {
    const preset = presetId ? getPreset(presetId) : getDefaultPreset();
    if (!preset) throw new Error('未找到可用的 API 预设，请先在设置中添加');

    const messages = [
        { role: 'system', content: systemPrompt },
        ...(assistantContext ? [{ role: 'assistant', content: assistantContext }] : []),
        { role: 'user', content: '请继续对话' }
    ];

    return _callAI(preset, messages, { maxTokens: 1000, temperature: 0.8 });

}
// ============================================================
//  核心调用（不导出，内部使用）
// ============================================================

async function _callAI(preset, messages, { maxTokens = 1000, temperature = 0.8 } = {}) {
    if (!preset) throw new Error('未找到可用的 API 预设');
    if (!preset.apiKey) throw new Error('请先在设置中填写 API 密钥');

    const url = preset.endpoint.replace(/\/+$/, '') + '/chat/completions';

    // ★ 打印完整的请求消息（所有模块共用，避免重复）
    console.log('📤 API 请求:', JSON.stringify({
        model: preset.model,
        messages,
        max_tokens: maxTokens,
        temperature
    }, null, 2));

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${preset.apiKey}`
        },
        body: JSON.stringify({
            model: preset.model,
            messages,
            max_tokens: maxTokens,
            temperature
        })
    });

    if (!response.ok) {
        let errMsg = `HTTP ${response.status}`;
        try {
            const err = await response.json();
            errMsg = err.error?.message || err.message || errMsg;
        } catch { }
        throw new Error(`AI 调用失败: ${errMsg}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

/**
 * AI 记忆提取专用（不走 callAI，不加 user message）
 * @param {object} options
 * @param {string} options.systemPrompt
 * @param {string} options.assistantContext
 * @param {string} [options.presetId]
 * @returns {Promise<string>}
 */
export async function callAIForMemoryExtract({ systemPrompt, assistantContext, presetId } = {}) {
    const preset = presetId ? getPreset(presetId) : getDefaultPreset();
    if (!preset) throw new Error('未找到可用的 API 预设');
    if (!preset.apiKey) throw new Error('请先在设置中填写 API 密钥');

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'assistant', content: assistantContext }
    ];

    return _callAI(preset, messages, { maxTokens: 1000, temperature: 0.6 });
}


// ============================================================
//  像素头像生成包装器（独立配置）
// ============================================================

const PIXEL_AI_CONFIG_KEY = 'pixel_avatar_ai_config';

function loadPixelAiConfig() {
    try {
        const saved = localStorage.getItem(PIXEL_AI_CONFIG_KEY);
        return saved ? JSON.parse(saved) : { presetId: null, systemPrompt: null };
    } catch {
        return { presetId: null, systemPrompt: null };
    }
}

export function savePixelAiConfig(config) {
    localStorage.setItem(PIXEL_AI_CONFIG_KEY, JSON.stringify(config));
}

/**
 * AI 生成像素头像
 * @param {object} options
 * @param {string} options.description - 用户描述
 * @param {string} [options.presetId] - API 预设 ID
 * @returns {Promise<string>} AI 返回的原始文本
 */
export async function callAIForPixel({ description, presetId, systemPrompt, taskInfo } = {}) {
    const config = loadPixelAiConfig();
    const targetPresetId = presetId || config.presetId;
    const preset = targetPresetId ? getPreset(targetPresetId) : getDefaultPreset();
    if (!preset) throw new Error('未找到可用的 API 预设，请先在设置中添加');

    const finalPrompt = systemPrompt || config.systemPrompt;
    if (!finalPrompt) throw new Error('缺少提示词，请传入 systemPrompt 或先在像素设置中保存提示词');

const messages = [
    { role: 'system', content: finalPrompt },
    // ★ 伪造一条历史对话，让模型进入"预热"状态
    { role: 'assistant', content: '[["#FFDAB9","#FFDAB9","#FFDAB9","#FFDAB9","#FFDAB9","#FFDAB9","#FFDAB9","#FFDAB9","#FFDAB9","#FFDAB9","#FFDAB9","#FFDAB9","#FFDAB9","#FFDAB9","#FFDAB9","#FFDAB9"]]' },
    { role: 'user', content: `用户的描述：${description}` }
];

    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('请求超时（120秒）')), 120000)
    );

    const doCall = () => Promise.race([
        _callAI(preset, messages, { maxTokens: 3000, temperature: 0.2 }),
        timeoutPromise
    ]);

    if (taskInfo) {
        const tm = await _getTaskManager();
        if (tm) {
            return await tm.watch(taskInfo.type, taskInfo.label, doCall, {
                onComplete: () => { }
            });
        }
    }
    return doCall();
}

// ============================================================
//  小说章节生成包装器（书社专用）
// ============================================================

/**
 * AI 生成小说章节内容
 * @param {object} options
 * @param {string} options.systemPrompt - 系统提示词
 * @param {string} options.description - 用户对情节的描述
 * @param {string} [options.presetId] - API 预设 ID
 * @returns {Promise<string>} AI 返回的正文
 */
export async function callAIForStory({ systemPrompt, description, presetId } = {}) {
    const preset = presetId ? getPreset(presetId) : getDefaultPreset();
    if (!preset) throw new Error('未找到可用的 API 预设，请先在设置中添加');
    if (!systemPrompt) throw new Error('缺少提示词');
    if (!description) throw new Error('请描述你想写的内容');

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `请根据以下描述写一段小说内容：\n${description}` }
    ];

    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('请求超时（120秒）')), 120000)
    );

    const result = await Promise.race([
        _callAI(preset, messages, { maxTokens: 3000, temperature: 0.7 }),
        timeoutPromise
    ]);

    return result;
}

// ★ 动态加载任务中心
let _taskManagerCache = null;
async function _getTaskManager() {
    if (_taskManagerCache !== null) return _taskManagerCache;
    try {
        const mod = await import('../store/AITaskManager.js');
        _taskManagerCache = mod.taskManager;
    } catch {
        _taskManagerCache = false;
    }
    return _taskManagerCache;
}

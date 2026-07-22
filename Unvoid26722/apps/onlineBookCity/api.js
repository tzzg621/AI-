// apps/onlineBookCity/api.js — 书城专用 API 预设管理

const STORAGE_KEY = 'obookcity_api_config';

// ---- 加密工具（与 aiService.js 一致）----
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

function defaultConfig() {
  return { presets: [], currentPresetId: null };
}

function loadRaw() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : defaultConfig();
  } catch {
    return defaultConfig();
  }
}

function saveRaw(config) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

/**
 * 获取所有预设（apiKey 已解密）
 */
export function getPresets() {
  const config = loadRaw();
  const salt = getSalt();
  return (config.presets || []).map(p => ({
    ...p,
    // ★ 只有 type: 'local' 才需要解密 apiKey
    apiKey: p.type !== 'global_ref' && p.apiKey ? decrypt(p.apiKey, salt) : undefined
  }));
}

/**
 * 解析预设：将 global_ref 转为可用的完整预设对象
 * @param {object} p - 书城预设项
 * @returns {Promise<object|null>}
 */
export async function resolvePreset(p) {
  if (!p) return null;

  // ★ 独立保存：直接返回
  if (p.type === 'local') {
    return { ...p, apiKey: p.apiKey || '' };
  }

  // ★ 引用全局预设：从 aiService 取
  if (p.type === 'global_ref') {
    const { getPreset, getDefaultPreset } = await import('../aiService.js');
    const globalPreset = getPreset(p.globalPresetId) || getDefaultPreset();
    if (!globalPreset) return null;
    return {
      ...globalPreset,
      // 允许书城覆盖部分参数
      temperature: p.temperature ?? globalPreset.temperature,
      maxTokens: p.maxTokens ?? globalPreset.maxTokens
    };
  }

  return null;
}

/**
 * 获取当前预设（已解析，可直接用于调用 AI）
 */
export async function getCurrentPreset() {
  const presets = getPresets();
  const config = loadRaw();
  const raw = presets.find(p => p.id === config.currentPresetId) || presets[0] || null;
  return resolvePreset(raw);
}

/**
 * 设置当前预设
 */
export function setCurrentPreset(id) {
  const config = loadRaw();
  config.currentPresetId = id;
  saveRaw(config);
}

/**
 * 保存预设列表（apiKey 自动加密）
 */
export function savePresets(presets) {
  const salt = getSalt();
  const encrypted = presets.map(p => ({
    ...p,
    apiKey: p.type !== 'global_ref' && p.apiKey ? encrypt(p.apiKey, salt) : undefined
  }));
  const config = loadRaw();
  config.presets = encrypted;
  if (config.currentPresetId && !presets.find(p => p.id === config.currentPresetId)) {
    config.currentPresetId = null;
  }
  saveRaw(config);
}

/**
 * 新增手动填写预设
 */
export function addPreset(preset) {
  const presets = getPresets();
  const newPreset = {
    ...preset,
    type: 'local',  // ★ 默认独立保存
    id: 'obc_api_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
    createdAt: new Date().toISOString()
  };
  presets.push(newPreset);
  savePresets(presets);
  return newPreset;
}

/**
 * 新增引用全局预设
 * @param {string} globalPresetId - 全局预设的 ID
 * @param {object} [overrides] - 可覆盖的参数 { temperature, maxTokens }
 */
export function addGlobalRefPreset(globalPresetId, overrides = {}) {
  const presets = getPresets();

  // 从 aiService 获取全局预设的名字

  const newPreset = {
    id: 'obc_api_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
    name: '',  // settings.js 里再补名字
    type: 'global_ref',
    globalPresetId,
    temperature: overrides.temperature ?? null,
    maxTokens: overrides.maxTokens ?? null,
    createdAt: new Date().toISOString()
  };
  presets.push(newPreset);
  savePresets(presets);
  return newPreset;
}

/**
 * 删除预设
 */
export function removePreset(id) {
  const presets = getPresets().filter(p => p.id !== id);
  savePresets(presets);
}

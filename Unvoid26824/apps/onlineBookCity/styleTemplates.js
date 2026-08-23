// apps/onlineBookCity/styleTemplates.js
// 文风包：单份覆盖式存储；支持多维度 × 多选项自由组合
// 文件格式（.txt）：
//   [NAME] 文风包名
//   [CORE] 公共段落（可选，总是生效）
//   [维度:文风] 甜向 = 内容
//   [维度:文风] 虐向 = 内容
//   [维度:尺度] 隐晦 = 内容
//   [维度:视角] 第一人称 = 内容
// 旧格式 [CORE]/[IMPLICIT]/[EXPLICIT] 在首次加载时自动迁移。

const BUNDLE_KEY = 'obookcity_style_bundle';
const SELECTIONS_KEY = 'obookcity_style_selections';

// 旧存储 key（一次性迁移用）
const LEGACY_FILE_PREFIX = 'obookcity_style_file_';
const LEGACY_THEME_KEY = 'obookcity_style_theme';
const LEGACY_SCALE_KEY = 'obookcity_style_scale';

// ===================== 解析 =====================

export function parseBundle(text) {
  if (!text || !text.trim()) return null;
  const result = { name: '', core: '', dimensions: [] };
  const dimMap = new Map();

  // 包名（单行）
  const nameMatch = text.match(/\[NAME\]\s*([^\r\n]+)/);
  if (nameMatch) result.name = nameMatch[1].trim();

  // 公共段：从 [CORE] 到下一个声明或结尾
  const coreMatch = text.match(/\[CORE\]\s*([\s\S]*?)(?=\n\[维度:|\n\[CORE\]|\n\[NAME\]|$)/);
  if (coreMatch) result.core = coreMatch[1].trim();

  // 维度选项：同名维度自动归组
  const dimRe = /\[维度:([^\]]+)\]\s*([^\r\n=]+?)\s*=\s*([\s\S]*?)(?=\n\[维度:|$)/g;
  let m;
  while ((m = dimRe.exec(text)) !== null) {
    const dimName = m[1].trim();
    const optName = m[2].trim();
    const content = m[3].trim();
    if (!dimName || !optName) continue;
    let dim = dimMap.get(dimName);
    if (!dim) { dim = { name: dimName, options: [] }; dimMap.set(dimName, dim); }
    if (!dim.options.some(o => o.name === optName)) {
      dim.options.push({ name: optName, content });
    }
  }

  result.dimensions = [...dimMap.values()];
  if (!result.name && !result.core && result.dimensions.length === 0) return null;
  return result;
}

// ===================== 旧格式迁移 =====================

function extractLegacySections(text) {
  const core = (text.match(/\[CORE\]\s*([\s\S]*?)(?=\[IMPLICIT\]|\[EXPLICIT\]|$)/) || [])[1];
  const implicit = (text.match(/\[IMPLICIT\]\s*([\s\S]*?)(?=\[EXPLICIT\]|$)/) || [])[1];
  const explicit = (text.match(/\[EXPLICIT\]\s*([\s\S]*)/) || [])[1];
  return {
    core: core ? core.trim() : '',
    implicit: implicit ? implicit.trim() : '',
    explicit: explicit ? explicit.trim() : ''
  };
}

function migrateLegacy() {
  try {
    if (localStorage.getItem(BUNDLE_KEY)) return;          // 已有新数据，跳过
    const oldSweet = localStorage.getItem(LEGACY_FILE_PREFIX + 'sweet');
    const oldDark = localStorage.getItem(LEGACY_FILE_PREFIX + 'dark');
    if (!oldSweet && !oldDark) return;

    const lines = [];
    if (oldSweet) {
      const s = extractLegacySections(oldSweet);
      if (s.core) lines.push('[维度:文风] 甜向 = ' + s.core);
      if (s.implicit) lines.push('[维度:尺度] 隐晦 = ' + s.implicit);
      if (s.explicit) lines.push('[维度:尺度] 直白 = ' + s.explicit);
    }
    if (oldDark) {
      const d = extractLegacySections(oldDark);
      if (d.core) lines.push('[维度:文风] 虐向 = ' + d.core);
      // dark 的尺度选项与 sweet 重名，按"先到先得"忽略
    }
    if (lines.length > 0) localStorage.setItem(BUNDLE_KEY, lines.join('\n\n'));

    // 迁移旧选择
    const sel = {};
    const oldTheme = localStorage.getItem(LEGACY_THEME_KEY);
    if (oldTheme === 'sweet') sel['文风'] = '甜向';
    else if (oldTheme === 'dark') sel['文风'] = '虐向';
    const oldScale = localStorage.getItem(LEGACY_SCALE_KEY);
    if (oldScale === 'implicit') sel['尺度'] = '隐晦';
    else if (oldScale === 'explicit') sel['尺度'] = '直白';
    if (Object.keys(sel).length > 0) localStorage.setItem(SELECTIONS_KEY, JSON.stringify(sel));

    // 清理旧 key
    localStorage.removeItem(LEGACY_FILE_PREFIX + 'sweet');
    localStorage.removeItem(LEGACY_FILE_PREFIX + 'dark');
    localStorage.removeItem(LEGACY_THEME_KEY);
    localStorage.removeItem(LEGACY_SCALE_KEY);
  } catch { /* 迁移失败不阻塞功能 */ }
}

migrateLegacy();

// ===================== 存储（单份覆盖式） =====================

export function importBundle(text) {
  const bundle = parseBundle(text);
  if (!bundle) return null;
  localStorage.setItem(BUNDLE_KEY, text);   // 只存原始文本，避免冗余
  return bundle;
}

export function removeBundle() {
  localStorage.removeItem(BUNDLE_KEY);
  localStorage.removeItem(SELECTIONS_KEY);
}

export function loadBundle() {
  return parseBundle(localStorage.getItem(BUNDLE_KEY));
}

// ===================== 选择 =====================

function loadSelections() {
  try { return JSON.parse(localStorage.getItem(SELECTIONS_KEY) || '{}'); }
  catch { return {}; }
}

export function saveSelection(dimName, optionName) {
  const sel = loadSelections();
  sel[dimName] = optionName;
  localStorage.setItem(SELECTIONS_KEY, JSON.stringify(sel));
}

// 过滤掉包中不存在的维度/选项，缺失时回退到该维度第一个选项
export function getValidSelections(bundle) {
  const raw = loadSelections();
  const valid = {};
  for (const dim of bundle.dimensions) {
    const chosen = raw[dim.name];
    const opt = dim.options.find(o => o.name === chosen);
    valid[dim.name] = opt ? opt.name : (dim.options[0]?.name || '');
  }
  return valid;
}

// ===================== 构建指令（接口不变） =====================

export function buildStylePromptFromSettings() {
  const bundle = loadBundle();
  if (!bundle) return '';
  const selections = getValidSelections(bundle);
  const parts = [];
  if (bundle.core) parts.push(bundle.core);
  for (const dim of bundle.dimensions) {
    const opt = dim.options.find(o => o.name === selections[dim.name]);
    if (opt && opt.content) parts.push(opt.content);
  }
  if (parts.length === 0) return '';
  return parts.join('\n\n') + '\n\n**注意**：本指令仅影响描写方式和尺度，不改变角色性格、剧情走向或对话逻辑。';
}

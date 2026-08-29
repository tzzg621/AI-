// apps/onlineBookCity/styleTemplates.js
// 文风包 / 同人补充包：多包列表式存储；支持多维度 × 多选项自由组合
// 文件格式（.txt）：
//   [NAME] 文风包名
//   [CORE] 公共段落（可选，总是生效）
//   [维度:文风] 甜向 = 内容
//   [维度:文风] 虐向 = 内容
//   [维度:尺度] 隐晦 = 内容
//   [维度:视角] 第一人称 = 内容
// 旧格式 [CORE]/[IMPLICIT]/[EXPLICIT] 在首次加载时自动迁移。

const BUNDLES_KEY = 'obookcity_style_bundles';     // 多包列表：[{ id, name, text }]
const SELECTIONS_KEY = 'obookcity_style_selections';

// 旧存储 key（一次性迁移用）
const LEGACY_BUNDLE_KEY = 'obookcity_style_bundle';  // 旧单包
const LEGACY_FILE_PREFIX = 'obookcity_style_file_';
const LEGACY_THEME_KEY = 'obookcity_style_theme';
const LEGACY_SCALE_KEY = 'obookcity_style_scale';

// ===================== 解析 =====================

export function parseBundle(text) {
  if (!text || !text.trim()) return null;
  // ★ 容错：全角冒号归一化 + 换行符归一化（\r\n / \r → \n）
  text = text.replace(/\[维度：/g, '[维度:').replace(/\r\n?/g, '\n');
  const result = { name: '', core: '', dimensions: [] };
  const dimMap = new Map();

  const nameMatch = text.match(/\[NAME\]\s*([^\r\n]+)/);
  if (nameMatch) result.name = nameMatch[1].trim();

  const coreMatch = text.match(/\[CORE\]\s*([\s\S]*?)(?=\n\[维度:|\n\[CORE\]|\n\[NAME\]|$)/);
  if (coreMatch) result.core = coreMatch[1].trim();

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
    if (localStorage.getItem(BUNDLES_KEY)) return;          // 已有新数据，跳过
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
    }
    if (lines.length > 0) {
      localStorage.setItem(BUNDLES_KEY, JSON.stringify([{
        id: genBundleId(),
        name: '文风包',
        text: lines.join('\n\n')
      }]));
    }

    const sel = {};
    const oldTheme = localStorage.getItem(LEGACY_THEME_KEY);
    if (oldTheme === 'sweet') sel['文风'] = '甜向';
    else if (oldTheme === 'dark') sel['文风'] = '虐向';
    const oldScale = localStorage.getItem(LEGACY_SCALE_KEY);
    if (oldScale === 'implicit') sel['尺度'] = '隐晦';
    else if (oldScale === 'explicit') sel['尺度'] = '直白';
    if (Object.keys(sel).length > 0) localStorage.setItem(SELECTIONS_KEY, JSON.stringify(sel));

    localStorage.removeItem(LEGACY_FILE_PREFIX + 'sweet');
    localStorage.removeItem(LEGACY_FILE_PREFIX + 'dark');
    localStorage.removeItem(LEGACY_THEME_KEY);
    localStorage.removeItem(LEGACY_SCALE_KEY);
  } catch { /* 迁移失败不阻塞功能 */ }
}

migrateLegacy();

// ===================== 存储（多包列表） =====================

function genBundleId() {
  return 'bundle_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 获取全部包（含旧单包自动升级） */
export function loadBundles() {
  try {
    const raw = JSON.parse(localStorage.getItem(BUNDLES_KEY) || 'null');
    if (Array.isArray(raw)) return raw;
  } catch { /* ignore */ }
  // 兼容旧单包：自动升级为列表
  const legacy = localStorage.getItem(LEGACY_BUNDLE_KEY);
  if (legacy) {
    const bundle = parseBundle(legacy);
    if (bundle) {
      const list = [{ id: genBundleId(), name: bundle.name || '文风包', text: legacy }];
      localStorage.setItem(BUNDLES_KEY, JSON.stringify(list));
      localStorage.removeItem(LEGACY_BUNDLE_KEY);
      return list;
    }
  }
  return [];
}

function saveBundles(list) {
  localStorage.setItem(BUNDLES_KEY, JSON.stringify(list));
}

// ★ 解析缓存（内存级）：避免每次点击/渲染重复正则解析；不落盘，不重复储存
const bundleParseCache = new Map();
function parseBundleCached(item) {
  if (!item || !item.id) return parseBundle(item ? item.text : '');
  if (bundleParseCache.has(item.id)) return bundleParseCache.get(item.id);
  const bundle = parseBundle(item.text);
  bundleParseCache.set(item.id, bundle);
  return bundle;
}

// ===================== 合并所有包（同名维度合并，同名标签各自保留） =====================

/**
 * 合并规则：
 * - 同名维度 → 合并为一个维度组（全局单选）
 * - 同名标签（不同包）→ 各自保留为独立选项，key = "包id::标签名"
 * - [CORE] → 全部合并
 */
export function mergeDimensions(bundles) {
  if (!Array.isArray(bundles) || bundles.length === 0) return null;
  const cores = [];
  const dimMap = new Map();
  for (const item of bundles) {
    const bundle = parseBundleCached(item);
    if (!bundle) continue;
    if (bundle.core) cores.push(bundle.core);
    for (const dim of bundle.dimensions) {
      let merged = dimMap.get(dim.name);
      if (!merged) { merged = { name: dim.name, options: [] }; dimMap.set(dim.name, merged); }
      for (const opt of dim.options) {
        merged.options.push({
          name: opt.name,
          key: item.id + '::' + opt.name,   // ★ 跨包唯一
          content: opt.content
        });
      }
    }
  }
  if (cores.length === 0 && dimMap.size === 0) return null;
  return { core: cores.join('\n\n'), dimensions: [...dimMap.values()] };
}

/** 追加导入一个包；相同文件名的包自动替换旧的那份（保留原 id，选择/高亮不失效） */
export function importBundle(text, fileName = '') {
  const bundle = parseBundle(text);
  if (!bundle) return null;
  const list = loadBundles();

  // ★ 按文件名去重：找到同名包就替换内容
  const existing = fileName ? list.find(b => b.file === fileName) : null;
  if (existing) {
    existing.name = bundle.name || existing.name;
    existing.text = text;
    bundleParseCache.delete(existing.id);   // ★ 新增
    saveBundles(list);
    return { bundle: existing, replaced: true };
  }

  const item = {
    id: genBundleId(),
    name: bundle.name || `补充包 ${list.length + 1}`,
    file: fileName,          // ★ 记录文件名，供下次去重匹配
    text
  };
  list.push(item);
  saveBundles(list);
  return { bundle: item, replaced: false };
}

/** 删除指定包；删空时清空选择 */
export function removeBundle(id) {
  const list = loadBundles().filter(b => b.id !== id);
  saveBundles(list);
  bundleParseCache.delete(id);            // ★ 新增
  if (list.length === 0) localStorage.removeItem(SELECTIONS_KEY);
}

/** 清空全部包 */
export function removeAllBundles() {
  localStorage.removeItem(BUNDLES_KEY);
  localStorage.removeItem(SELECTIONS_KEY);
  bundleParseCache.clear();               // ★ 新增
}

// 兼容旧接口：返回第一个包（新代码请用 loadBundles）
export function loadBundle() {
  const list = loadBundles();
  return list.length ? parseBundle(list[0].text) : null;
}

// ===================== 选择（全局单选：一个维度只存一个 key） =====================

function loadSelections() {
  try { return JSON.parse(localStorage.getItem(SELECTIONS_KEY) || '{}'); }
  catch { return {}; }
}

// 旧数据迁移：{维度: 选项名} → {维度: "包id::标签名"}
function migrateSelections() {
  try {
    const raw = loadSelections();
    if (!raw || Object.keys(raw).length === 0) return;
    const isLegacy = Object.values(raw).some(v => v && !String(v).includes('::'));
    if (!isLegacy) return;
    const dimToKey = new Map();
    for (const item of loadBundles()) {
      const bundle = parseBundleCached(item);
      if (!bundle) continue;
      for (const dim of bundle.dimensions) {
        for (const opt of dim.options) {
          const k = dim.name + '::' + opt.name;
          if (!dimToKey.has(k)) dimToKey.set(k, item.id + '::' + opt.name);
        }
      }
    }
    const migrated = {};
    for (const [dim, optName] of Object.entries(raw)) {
      migrated[dim] = optName == null ? null : (dimToKey.get(dim + '::' + optName) || null);
    }
    localStorage.setItem(SELECTIONS_KEY, JSON.stringify(migrated));
  } catch { /* ignore */ }
}
migrateSelections();

// 存储：{ 维度名: optKey|null }，optKey = "包id::标签名"（null = 明确不选）
export function saveSelection(dimName, optKey) {
  const sel = loadSelections();
  sel[dimName] = optKey == null ? null : optKey;
  localStorage.setItem(SELECTIONS_KEY, JSON.stringify(sel));
}

// 读合并后的有效选择：按 key 精确匹配；null/失效 → 不选
export function getValidSelections(merged) {
  const raw = loadSelections();
  const valid = {};
  for (const dim of merged.dimensions) {
    const chosen = raw[dim.name];
    const opt = chosen ? dim.options.find(o => o.key === chosen) : null;
    valid[dim.name] = opt ? opt.key : null;
  }
  return valid;
}

// ===================== 构建指令（多包合并，接口不变） =====================

export function buildStylePromptFromSettings() {
  const bundles = loadBundles();
  const merged = mergeDimensions(bundles);
  if (!merged) return '';
  const parts = [];
  if (merged.core) parts.push(merged.core);
  const selections = getValidSelections(merged);
  for (const dim of merged.dimensions) {
    const key = selections[dim.name];
    if (!key) continue;
    const opt = dim.options.find(o => o.key === key);
    if (opt && opt.content) parts.push(opt.content);
  }
  if (parts.length === 0) return '';
  return parts.join('\n\n') + '\n\n**注意**：本指令仅影响描写方式和尺度，不改变角色性格、剧情走向或对话逻辑。';
}

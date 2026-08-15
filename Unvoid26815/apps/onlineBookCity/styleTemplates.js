// apps/onlineBookCity/styleTemplates.js
// 仅提供上传/读取/解析接口，不包含任何预设模板内容

const STORAGE_THEME_KEY = 'obookcity_style_theme';
const STORAGE_SCALE_KEY = 'obookcity_style_scale';
const STORAGE_FILE_PREFIX = 'obookcity_style_file_';

// ===================== 解析 .txt 文件 =====================

function parseFileContent(text) {
  const result = { core: '', implicit: '', explicit: '' };

  const coreMatch = text.match(/\[CORE\]\s*([\s\S]*?)(?=\[IMPLICIT\]|$)/);
  if (coreMatch) result.core = coreMatch[1].trim();

  const implicitMatch = text.match(/\[IMPLICIT\]\s*([\s\S]*?)(?=\[EXPLICIT\]|$)/);
  if (implicitMatch) result.implicit = implicitMatch[1].trim();

  const explicitMatch = text.match(/\[EXPLICIT\]\s*([\s\S]*)/);
  if (explicitMatch) result.explicit = explicitMatch[1].trim();

  return result;
}

// ===================== 读取用户上传的模板 =====================

function getImportedTheme(theme) {
  try {
    const saved = localStorage.getItem(STORAGE_FILE_PREFIX + theme);
    if (saved) {
      const parsed = parseFileContent(saved);
      if (parsed.core || parsed.implicit || parsed.explicit) return parsed;
    }
  } catch { /* 忽略 */ }
  return null;
}

// ===================== 构建风格指令 =====================

/**
 * 根据主题和尺度返回风格指令字符串
 * 如果用户未上传对应模板，返回空字符串
 */
export function buildStylePrompt(theme, scale) {
  const imported = getImportedTheme(theme);
  if (!imported) return '';

  const core = imported.core || '';
  const scaleContent = imported[scale] || '';
  if (!core && !scaleContent) return '';

  return `${core}\n\n${scaleContent}\n\n**注意**：本指令仅影响描写方式和尺度，不改变角色性格、剧情走向或对话逻辑。`;
}

/** 根据当前设置（主题+尺度）构建风格指令 */
export function buildStylePromptFromSettings() {
  return buildStylePrompt(getStyleTheme(), getStyleScale());
}

// ===================== 主题/尺度 读写 =====================

export function getStyleTheme() {
  return localStorage.getItem(STORAGE_THEME_KEY) || 'sweet';
}

export function setStyleTheme(theme) {
  localStorage.setItem(STORAGE_THEME_KEY, theme);
}

export function getStyleScale() {
  return localStorage.getItem(STORAGE_SCALE_KEY) || 'implicit';
}

export function setStyleScale(scale) {
  localStorage.setItem(STORAGE_SCALE_KEY, scale);
}

// ===================== 模板文件管理 =====================

/** 导入模板文件内容 */
export function importStyleFile(theme, fileContent) {
  localStorage.setItem(STORAGE_FILE_PREFIX + theme, fileContent);
}

/** 删除已导入的模板 */
export function removeStyleFile(theme) {
  localStorage.removeItem(STORAGE_FILE_PREFIX + theme);
}

/** 检查某个主题是否已导入模板 */
export function hasImportedFile(theme) {
  return !!localStorage.getItem(STORAGE_FILE_PREFIX + theme);
}

// apps/market/txtImporter.js — 📄 TXT 导入工具
// 从文本文件中提取角色卡、世界书条目、文风与规则

import { taskManager } from '../../store/AITaskManager.js';
import { generateId, createDefaultCharacterData } from '../../store/CharacterStore.js';
import { callAIWithMessages } from '../aiService.js';


// ============================================================
//  状态管理（模块级变量，切页面不丢失）
// ============================================================

const STORAGE_KEY = 'txt_importer_state';
const STORAGE_KEY_WORLDBOOK = 'worldbook_entries';
const STORAGE_KEY_ROLEBOOK = 'rolebook_characters';

function loadState() {
    try {
        const saved = sessionStorage.getItem(STORAGE_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            // ★ 确保 progress 字段存在（兼容旧数据）
            if (!parsed.progress) {
                parsed.progress = {
                    characters: { totalChunks: 0, doneChunks: [], failedChunks: [] },
                    world: { totalChunks: 0, doneChunks: [], failedChunks: [] },
                    style: { totalChunks: 0, doneChunks: [], failedChunks: [] }
                };
            }
            // ★ 确保 checkedItems 字段存在（兼容旧数据）
            if (!parsed.checkedItems) {
                parsed.checkedItems = { characters: [], world: [] };
            }
            // ★ 确保 editingItem 字段存在（兼容旧数据）
            if (parsed.editingItem === undefined) {
                parsed.editingItem = null;
            }
            return parsed;
        }
    } catch (e) { /* 忽略 */ }
    return {
        fileName: '',
        fileSize: 0,
        fileContent: '',
        characters: '[]',
        worldEntries: '[]',
        styleRules: '',
        extracted: {
            characters: false,
            world: false,
            style: false
        },
        activeTab: 'characters',
        checkedItems: {
            characters: [],
            world: []
        },
        editingItem: null,
        progress: {
            characters: { totalChunks: 0, doneChunks: [], failedChunks: [] },
            world: { totalChunks: 0, doneChunks: [], failedChunks: [] },
            style: { totalChunks: 0, doneChunks: [], failedChunks: [] }
        }
    };
}

function saveState() {
    try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) { /* 忽略 */ }
}

let state = loadState();
let _bindSignal = null;

// ============================================================
//  工具函数
// ============================================================

function genId() {
    return 'entry_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
}

function countTextWords(text) {
    const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
    const enWords = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 0)
        .length;
    return cjkChars + enWords;
}

function showToast(msg, bg = '#333') {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:${bg};color:#fff;padding:10px 20px;border-radius:12px;z-index:10000;font-size:13px;box-shadow:0 4px 20px rgba(0,0,0,0.2);max-width:80%;text-align:center;`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
}

// ---- 安全的 setter：保证 characters 永远是有效 JSON 数组 ----
function setCharData(data) {
    try {
        if (typeof data === 'string') {
            const parsed = JSON.parse(data);
            state.characters = Array.isArray(parsed) ? JSON.stringify(parsed, null, 2) : '[]';
        } else if (Array.isArray(data)) {
            state.characters = JSON.stringify(data, null, 2);
        } else {
            state.characters = '[]';
        }
    } catch {
        state.characters = '[]';
    }
    saveState();
}

// ---- 安全的 setter：保证 worldEntries 永远是有效 JSON 数组 ----
function setWorldData(data) {
    try {
        if (typeof data === 'string') {
            const parsed = JSON.parse(data);
            state.worldEntries = Array.isArray(parsed) ? JSON.stringify(parsed, null, 2) : '[]';
        } else if (Array.isArray(data)) {
            state.worldEntries = JSON.stringify(data, null, 2);
        } else {
            state.worldEntries = '[]';
        }
    } catch {
        state.worldEntries = '[]';
    }
    saveState();
}


// ---- 更新卡片计数（不重建 DOM，避免事件监听器堆积）----
function updateCardCounts(container) {
    // 角色面板
    const charPanel = container.querySelector('[data-panel="characters"]');
    if (charPanel) {
        const countEl = charPanel.querySelector('.txt-count');
        if (countEl) {
            let list = [];
            try { list = JSON.parse(state.characters); } catch { }
            countEl.textContent = `🎭 共 ${list.length} 个角色 · 已选 ${state.checkedItems.characters.length} 个`;
        }
        const saveBtn = charPanel.querySelector('.txt-save-btn[data-target="characters"]');
        if (saveBtn) {
            const count = state.checkedItems.characters.length;
            saveBtn.textContent = `💾 保存选中 (${count})`;
            saveBtn.style.opacity = count === 0 ? '0.5' : '1';
        }
        const selectAllBtn = charPanel.querySelector('.txt-select-all-btn[data-target="characters"]');
        if (selectAllBtn) {
            let list = [];
            try { list = JSON.parse(state.characters); } catch { }
            selectAllBtn.textContent = state.checkedItems.characters.length === list.length ? '🙌 取消全选' : '✅ 全选';
        }
    }

    // 世界观面板
    const worldPanel = container.querySelector('[data-panel="world"]');
    if (worldPanel) {
        const countEl = worldPanel.querySelector('.txt-count');
        if (countEl) {
            let list = [];
            try { list = JSON.parse(state.worldEntries); } catch { }
            countEl.textContent = `🌍 共 ${list.length} 个条目 · 已选 ${state.checkedItems.world.length} 个`;
        }
        const saveBtn = worldPanel.querySelector('.txt-save-btn[data-target="world"]');
        if (saveBtn) {
            const count = state.checkedItems.world.length;
            saveBtn.textContent = `💾 保存选中 (${count})`;
            saveBtn.style.opacity = count === 0 ? '0.5' : '1';
        }
        const selectAllBtn = worldPanel.querySelector('.txt-select-all-btn[data-target="world"]');
        if (selectAllBtn) {
            let list = [];
            try { list = JSON.parse(state.worldEntries); } catch { }
            selectAllBtn.textContent = state.checkedItems.world.length === list.length ? '🙌 取消全选' : '✅ 全选';
        }
    }
}

// ---- 去重合并：角色（按名称合并，保留信息最全的那条）----
function deduplicateCharacters(list) {
    const map = new Map();
    list.forEach(char => {
        if (!char?.name) return;
        const existing = map.get(char.name);
        if (!existing) { map.set(char.name, { ...char }); return; }
        if ((char.detail || '').length > (existing.detail || '').length) existing.detail = char.detail;
        if ((char.desc || '').length > (existing.desc || '').length) existing.desc = char.desc;
        if ((char.secret || '').length > (existing.secret || '').length) existing.secret = char.secret;
        if (char.gender && char.gender !== '未知') existing.gender = char.gender;
        if (char.age && char.age !== '未知') existing.age = char.age;
        if (char.orientation && char.orientation !== '未知') existing.orientation = char.orientation;
        if (char.style && char.style !== '未知') existing.style = char.style;
    });
    return JSON.stringify(Array.from(map.values()), null, 2);
}

// ---- 去重合并：世界观条目（按标题合并）----
function deduplicateWorldEntries(list) {
    const map = new Map();
    list.forEach(entry => {
        if (!entry?.title) return;
        const key = entry.title.replace(/\s/g, '');
        const existing = map.get(key);
        if (!existing) { map.set(key, { ...entry }); return; }
        if ((entry.text || '').length > (existing.text || '').length) existing.text = entry.text;
    });
    return JSON.stringify(Array.from(map.values()), null, 2);
}

// ---- AI 智能合并：角色（调用 AI 合并同名角色）----
async function aiMergeCharacters(list) {
    const systemPrompt = `你是一个专业的角色编辑助手。以下列表中有同名角色（来自同一部作品的不同章节），请将它们智能合并为一个完整的角色。
保留所有有用的信息，去重、补充遗漏、统一格式。
只返回 JSON 数组，不要包含任何其他文字，不要用 markdown 标记。`;

    const userContent = `请合并以下同名角色，每个名字只保留一个最完整的版本：

${JSON.stringify(list, null, 2)}

合并规则：
- 同名角色合并为一个，取各版本信息的并集
- detail 字段合并所有版本的内容，按逻辑顺序排列
- secret、style 取最详细的那条
- gender、age、orientation 取最具体的那个
- desc 取最概括的那条
- 保持 JSON 数组格式，只输出 JSON`;

    const result = await callAIWithMessages({
        systemPrompt, userContent, maxTokens: 8192
    });
    return result;
}

// ---- AI 智能合并：世界观条目（调用 AI 合并同标题条目）----
async function aiMergeWorldEntries(list) {
    const systemPrompt = `你是一个专业的设定编辑助手。以下列表中有同标题的世界观条目（来自同一部作品的不同章节），请将它们智能合并为一个完整的条目。
保留所有有用的信息，去重、补充遗漏、统一格式。
只返回 JSON 数组，不要包含任何其他文字，不要用 markdown 标记。`;

    const userContent = `请合并以下同标题的世界观条目，每个标题只保留一个最完整的版本：

${JSON.stringify(list, null, 2)}

合并规则：
- 同标题条目合并为一个，取所有版本内容的并集
- text 字段合并所有版本的内容，按逻辑顺序排列
- title 取最完整的那条
- 保持 JSON 数组格式，只输出 JSON`;

    const result = await callAIWithMessages({
        systemPrompt, userContent, maxTokens: 8192
    });
    return result;
}

// ---- 解析 AI 返回的 JSON ----
function parseJSON(text) {
    if (!text || !text.trim()) return [];

    let clean = text.trim();
    const jsonMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) clean = jsonMatch[1].trim();

    const firstBrace = clean.indexOf('{');
    const lastBrace = clean.lastIndexOf('}');
    const firstBracket = clean.indexOf('[');
    const lastBracket = clean.lastIndexOf(']');

    if (firstBracket !== -1 && lastBracket > firstBracket) {
        try {
            return JSON.parse(clean.substring(firstBracket, lastBracket + 1));
        } catch { }
    }
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        try {
            return JSON.parse(clean.substring(firstBrace, lastBrace + 1));
        } catch {
            try {
                const fixed = clean.substring(firstBrace, lastBrace + 1).replace(/,(\s*[}\]])/g, '$1');
                return JSON.parse(fixed);
            } catch { }
        }
    }

    const possibleJson = clean.match(/(\[[\s\S]*?\]|\{[\s\S]*?\})/);
    if (possibleJson) {
        try {
            return JSON.parse(possibleJson[1]);
        } catch { }
    }

    console.warn('⚠️ AI 返回内容无法解析为 JSON，已返回空数据:', clean.slice(0, 200));
    return [];
}

// ============================================================
//  AI 提取函数（分块处理 + 断点续传）
// ============================================================

function splitIntoChunks(text, chunkSize = 8000, overlap = 500) {
    if (text.length <= chunkSize) return [text];
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        let end = start + chunkSize;
        if (end < text.length) {
            const slice = text.slice(start, end);
            const lastPeriod = Math.max(
                slice.lastIndexOf('。'), slice.lastIndexOf('！'),
                slice.lastIndexOf('？'), slice.lastIndexOf('\n\n')
            );
            if (lastPeriod > chunkSize * 0.5) end = start + lastPeriod + 1;
        }
        chunks.push(text.slice(start, Math.min(end, text.length)));
        start = end - (end < text.length ? overlap : 0);
    }
    return chunks;
}

async function extractCharacters(content, onProgress, resumeFrom) {
    const chunks = splitIntoChunks(content);
    const total = chunks.length;
    const allResults = [];

    for (let i = 0; i < total; i++) {
        if (resumeFrom?.doneChunks?.includes(i)) continue;

        onProgress?.(`🎭 提取角色（第 ${i + 1}/${total} 块）...`);

        const systemPrompt = `你是一个专业的文学分析助手。从文本中提取角色信息。
返回 JSON 数组。只返回 JSON，不要包含其他文字。`;

        const userContent = `从以下文本提取角色信息：
${chunks[i]}

格式：
[{"name":"","gender":"","age":"","orientation":"","desc":"","detail":"","secret":"","style":""}]
最多提取 5 个角色。信息不足则标注"未知"。`;

        try {
            const result = await callAIWithMessages({
                systemPrompt, userContent, maxTokens: 8192
            });
            const parsed = parseJSON(result);
            const arr = Array.isArray(parsed) ? parsed : (parsed.characters || [parsed]);
            allResults.push(...arr);

            // ★ 每块处理完立即暂存
            setCharData(allResults);
            state.extracted.characters = allResults.length > 0;
            state.progress.characters.doneChunks.push(i);
            saveState();
        } catch (e) {
            console.warn(`第 ${i + 1} 块角色提取失败，已跳过:`, e);
            state.progress.characters.failedChunks.push(i);
            saveState();
        }
    }

    onProgress?.('🔗 合并角色数据...');
    return JSON.stringify(allResults, null, 2);
}

async function extractWorldEntries(content, onProgress, resumeFrom) {
    const chunks = splitIntoChunks(content);
    const total = chunks.length;
    const allResults = [];

    for (let i = 0; i < total; i++) {
        if (resumeFrom?.doneChunks?.includes(i)) continue;

        onProgress?.(`🌍 提取世界观（第 ${i + 1}/${total} 块）...`);

        const systemPrompt = `你是一个专业的文学分析助手。从文本中提取世界观设定。
返回 JSON 数组。只返回 JSON，不要包含其他文字。`;

        const userContent = `从以下文本提取世界观设定：
${chunks[i]}

格式：
[{"title":"条目标题","text":"详细描述"}]
至少 1 条，最多 6 条。`;

        try {
            const result = await callAIWithMessages({
                systemPrompt, userContent, maxTokens: 8192
            });
            const parsed = parseJSON(result);
            const arr = Array.isArray(parsed) ? parsed : (parsed.entries || [parsed]);
            allResults.push(...arr);

            // ★ 每块处理完立即暂存
            setWorldData(allResults);
            state.extracted.world = allResults.length > 0;
            state.progress.world.doneChunks.push(i);
            saveState();
        } catch (e) {
            console.warn(`第 ${i + 1} 块世界观提取失败，已跳过:`, e);
            state.progress.world.failedChunks.push(i);
            saveState();
        }
    }

    onProgress?.('🔗 合并世界观数据...');
    return JSON.stringify(allResults, null, 2);
}

async function extractStyleAndRules(content, onProgress, resumeFrom) {
    const chunks = splitIntoChunks(content);
    const total = chunks.length;
    const allResults = [];

    for (let i = 0; i < total; i++) {
        if (resumeFrom?.doneChunks?.includes(i)) continue;

        onProgress?.(`✍️ 分析文风（第 ${i + 1}/${total} 块）...`);

        const systemPrompt = `你是一个专业的文学分析助手。分析文本的文风特点和写作规则。`;

        const userContent = `分析以下文本的文风，用中文分三段输出：

【文风特点】
【叙事规则】
【可借鉴的写作手法】

文本：
${chunks[i]}`;

        try {
            const result = await callAIWithMessages({
                systemPrompt, userContent, maxTokens: 8192
            });
            allResults.push(result);

            // ★ 每块处理完立即暂存
            state.styleRules = allResults.join('\n\n---\n\n');
            state.extracted.style = allResults.length > 0;
            state.progress.style.doneChunks.push(i);
            saveState();
        } catch (e) {
            console.warn(`第 ${i + 1} 块文风分析失败，已跳过:`, e);
            state.progress.style.failedChunks.push(i);
            saveState();
        }
    }

    onProgress?.('🔗 合并文风分析...');
    if (allResults.length <= 1) return allResults[0] || '';

    const mergeResult = await callAIWithMessages({
        systemPrompt: `合并多份对同一作品的分析报告为一份完整报告。去重并补充遗漏。`,
        userContent: `合并以下报告：\n\n${allResults.map((r, i) => `---第${i + 1}份---\n${r}`).join('\n')}\n\n分三段输出：【文风特点】【叙事规则】【可借鉴的写作手法】`,
        maxTokens: 8192
    });
    return mergeResult;
}

// ============================================================
//  渲染
// ============================================================

export function render() {
    const hasFile = !!state.fileContent;

    return `
        <div class="screen-page" style="background: linear-gradient(180deg, #faf5ff 0%, #f5f0ff 30%, #f0f4ff 100%);">
            <div class="screen-header" style="background:transparent;backdrop-filter:none;">
                <div class="screen-title" style="color:#6b3fa0;">📄 TXT 导入工具</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content" style="padding:8px 12px 12px;overflow-y:auto;">

                ${!hasFile ? renderUploadArea() : renderFileInfo()}

                ${hasFile ? renderActionCards() : ''}

                ${hasFile ? renderTabs() : ''}

                ${hasFile ? renderResultPanels() : ''}

            </div>
        </div>
    `;
}

function renderUploadArea() {
    return `
        <div class="txt-upload-zone" id="txtUploadZone" style="
            margin:20px 8px; padding:40px 20px;
            border:2.5px dashed #c9b8e8;
            border-radius:20px;
            background:rgba(255,255,255,0.7);
            backdrop-filter:blur(8px);
            text-align:center;
            cursor:pointer;
            transition:all 0.3s ease;
        ">
            <div style="font-size:48px; margin-bottom:12px; opacity:0.8;">📄</div>
            <div style="font-size:17px; font-weight:600; color:#4a2d7a; margin-bottom:6px;">
                点击上传 TXT 文件
            </div>
            <div style="font-size:13px; color:#9a7fc0;">
                支持小说、设定集、剧本等文本文件
            </div>
            <div style="margin-top:16px; display:flex; justify-content:center; gap:8px; flex-wrap:wrap;">
                <span style="padding:4px 12px; background:#ede7f6; border-radius:12px; font-size:12px; color:#6b3fa0;">🎭 提取角色</span>
                <span style="padding:4px 12px; background:#ede7f6; border-radius:12px; font-size:12px; color:#6b3fa0;">🌍 提取世界观</span>
                <span style="padding:4px 12px; background:#ede7f6; border-radius:12px; font-size:12px; color:#6b3fa0;">✍️ 分析文风</span>
            </div>
            <input type="file" id="txtFileInput" accept=".txt" style="display:none;">
        </div>
    `;
}

function renderFileInfo() {
    const sizeStr = state.fileSize > 1024 * 1024
        ? (state.fileSize / 1024 / 1024).toFixed(1) + ' MB'
        : (state.fileSize / 1024).toFixed(1) + ' KB';
    const wordCount = countTextWords(state.fileContent);

    return `
        <div class="txt-file-info" style="
            margin:0 4px 16px; padding:14px 18px;
            background:rgba(255,255,255,0.85);
            backdrop-filter:blur(8px);
            border-radius:16px;
            box-shadow:0 2px 12px rgba(107,63,160,0.08);
            display:flex; align-items:center; gap:14px;
        ">
            <div style="font-size:32px;">📄</div>
            <div style="flex:1; min-width:0;">
                <div style="font-weight:600; font-size:14px; color:#333; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                    ${state.fileName}
                </div>
                <div style="font-size:12px; color:#9a7fc0; margin-top:2px;">
                    ${sizeStr} · 约 ${wordCount} 字
                </div>
            </div>
            <div style="display:flex; gap:6px;">
                <button id="txtChangeFileBtn" style="
                    padding:6px 14px; border:none; border-radius:10px;
                    background:#f0ebf8; color:#6b3fa0; font-size:12px; font-weight:600;
                    cursor:pointer; transition:all 0.2s;
                ">换文件</button>
                <button id="txtClearFileBtn" style="
                    padding:6px 14px; border:none; border-radius:10px;
                    background:#fce4ec; color:#c62828; font-size:12px; font-weight:600;
                    cursor:pointer; transition:all 0.2s;
                ">🗑️ 清除</button>
            </div>
        </div>
    `;
}

function renderActionCards() {
    return `
        <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; margin:0 4px 16px;">
            ${renderActionCard('🎭', '提取角色卡', 'characters', state.extracted.characters)}
            ${renderActionCard('🌍', '提取世界观', 'world', state.extracted.world)}
            ${renderActionCard('✍️', '文风与规则', 'style', state.extracted.style)}
        </div>
        <div style="margin:0 4px 16px;">
            <button id="txtExtractAllBtn" style="
                width:100%; padding:12px; border:none; border-radius:14px;
                background:linear-gradient(135deg, #7c4dff, #9c27b0);
                color:white; font-size:15px; font-weight:600; cursor:pointer;
                box-shadow:0 4px 16px rgba(124,77,255,0.3);
                transition:all 0.2s;
            ">✨ 一键全部提取</button>
        </div>
    `;
}

function renderActionCard(emoji, label, key, done) {
    return `
        <button class="txt-action-btn" data-action="${key}" style="
            padding:14px 8px; border:${done ? '2px solid #7c4dff' : '2px solid #e8e0f0'};
            border-radius:14px;
            background:${done ? 'rgba(124,77,255,0.08)' : 'rgba(255,255,255,0.7)'};
            cursor:pointer; text-align:center;
            transition:all 0.2s;
            ${done ? '' : 'backdrop-filter:blur(4px);'}
        ">
            <div style="font-size:24px; margin-bottom:6px;">${done ? '✅' : emoji}</div>
            <div style="font-size:12px; font-weight:600; color:${done ? '#7c4dff' : '#666'};">
                ${done ? '已提取' : label}
            </div>
        </button>
    `;
}

function renderTabs() {
    const tabs = [
        { id: 'characters', label: '🎭 角色卡', has: state.extracted.characters },
        { id: 'world', label: '🌍 世界书', has: state.extracted.world },
        { id: 'style', label: '✍️ 文风规则', has: state.extracted.style }
    ];

    return `
        <div style="display:flex; gap:4px; margin:0 4px 12px; padding:4px; background:rgba(255,255,255,0.5); border-radius:12px;">
            ${tabs.map(t => `
                <button class="txt-tab-btn" data-tab="${t.id}" style="
                    flex:1; padding:8px 4px; border:none; border-radius:10px;
                    font-size:12px; font-weight:600; cursor:pointer;
                    background:${state.activeTab === t.id ? '#7c4dff' : 'transparent'};
                    color:${state.activeTab === t.id ? 'white' : (t.has ? '#7c4dff' : '#999')};
                    transition:all 0.2s;
                ">${t.label}</button>
            `).join('')}
        </div>
    `;
}

// ============================================================
//  卡片视图渲染
// ============================================================

function renderResultPanels() {
    let panelContent = '';
    if (state.activeTab === 'characters') panelContent = renderCharactersPanel();
    else if (state.activeTab === 'world') panelContent = renderWorldPanel();
    else if (state.activeTab === 'style') panelContent = renderStylePanel();

    return `
        <div style="margin:0 4px 20px;">
            ${panelContent}
        </div>
        ${renderEditModal()}
    `;
}

function renderCharactersPanel() {
    if (!state.extracted.characters) {
        return `
            <div class="txt-panel" data-panel="characters" style="display:${state.activeTab === 'characters' ? 'block' : 'none'};">
                <div style="font-size:13px; color:#9a7fc0;">尚未提取角色信息</div>
            </div>
        `;
    }

    let list = [];
    try { list = JSON.parse(state.characters); } catch { list = []; }
    const checkedCount = state.checkedItems.characters.length;

    return `
        <div class="txt-panel" data-panel="characters" style="display:${state.activeTab === 'characters' ? 'block' : 'none'};">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:6px;">
                <div style="font-size:13px; color:#9a7fc0; font-weight:500;" class="txt-count">
    🎭 共 ${list.length} 个角色 · 已选 ${checkedCount} 个
</div>

<div style="display:flex; gap:8px; margin-top:8px; align-items:center;">
    <label style="font-size:12px; color:#666; display:flex; align-items:center; gap:4px; cursor:pointer;">
        <input type="radio" name="saveDestination" value="rolebook" checked> 📋 角色名册
    </label>
    <label style="font-size:12px; color:#666; display:flex; align-items:center; gap:4px; cursor:pointer;">
        <input type="radio" name="saveDestination" value="worldnet"> 🌐 世界角色网络
    </label>
</div>


                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                    <button class="txt-dedup-btn" data-target="characters" style="padding:6px 10px;border:none;border-radius:10px;background:#f0ebf8;color:#6b3fa0;font-size:11px;font-weight:600;cursor:pointer;">🔗 快速去重</button>
                    <button class="txt-ai-merge-btn" data-target="characters" style="padding:6px 10px;border:none;border-radius:10px;background:#e8f5e9;color:#2e7d32;font-size:11px;font-weight:600;cursor:pointer;">🤖 AI 智能合并</button>
                    <button class="txt-select-all-btn" data-target="characters" style="padding:6px 10px;border:none;border-radius:10px;background:#e3f2fd;color:#1565c0;font-size:11px;font-weight:600;cursor:pointer;">${checkedCount === list.length ? '🙌 取消全选' : '✅ 全选'}</button>
                    <button class="txt-save-btn" data-target="characters" style="padding:6px 14px;border:none;border-radius:10px;background:#7c4dff;color:white;font-size:12px;font-weight:600;cursor:pointer;${checkedCount === 0 ? 'opacity:0.5;' : ''}">💾 保存选中 (${checkedCount})</button>
                </div>
            </div>
            <div style="display:flex; flex-direction:column; gap:8px;">

                ${list.map((item, i) => renderCharacterCard(item, i)).join('')}
            </div>
        </div>
    `;
}

function renderCharacterCard(item, index) {
    const checked = state.checkedItems.characters.includes(index);
    const genderAge = [item.gender, item.age].filter(Boolean).join(' · ');
    const desc = item.desc || item.detail?.slice(0, 100) || '暂无描述';

    return `
        <div class="txt-item-card" data-type="characters" data-index="${index}" style="
            display:flex; align-items:flex-start; gap:12px;
            padding:12px 14px; border-radius:14px;
            background:${checked ? 'rgba(124,77,255,0.06)' : 'rgba(255,255,255,0.85)'};
            border:1.5px solid ${checked ? '#7c4dff' : '#e8e0f0'};
            cursor:pointer; transition:all 0.2s;
        ">
            <div style="flex-shrink:0; padding-top:2px;">
                <input type="checkbox" class="txt-item-checkbox" data-type="characters" data-index="${index}" ${checked ? 'checked' : ''} style="width:18px;height:18px;accent-color:#7c4dff;cursor:pointer;">
            </div>
            <div style="flex:1; min-width:0; pointer-events:none;">
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                    <span style="font-weight:600; font-size:15px; color:#333;">${item.name || '未命名角色'}</span>
                    ${genderAge ? `<span style="font-size:12px; color:#999;">${genderAge}</span>` : ''}
                </div>
                <div style="font-size:13px; color:#666; line-height:1.4; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">
                    ${desc}
                </div>
            </div>
            <button class="txt-edit-btn" data-type="characters" data-index="${index}" style="
                flex-shrink:0; padding:6px 10px; border:none; border-radius:8px;
                background:#f5f0ff; color:#6b3fa0; font-size:12px; cursor:pointer;
                transition:all 0.2s; white-space:nowrap;
            ">✏️ 编辑</button>
        </div>
    `;
}

function renderWorldPanel() {
    if (!state.extracted.world) {
        return `
            <div class="txt-panel" data-panel="world" style="display:${state.activeTab === 'world' ? 'block' : 'none'};">
                <div style="font-size:13px; color:#9a7fc0;">尚未提取世界观信息</div>
            </div>
        `;
    }

    let list = [];
    try { list = JSON.parse(state.worldEntries); } catch { list = []; }
    const checkedCount = state.checkedItems.world.length;

    return `
        <div class="txt-panel" data-panel="world" style="display:${state.activeTab === 'world' ? 'block' : 'none'};">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:6px;">
                <div style="font-size:13px; color:#9a7fc0; font-weight:500;" class="txt-count">
                    🌍 共 ${list.length} 个条目 · 已选 ${checkedCount} 个
                </div>
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                    <button class="txt-dedup-btn" data-target="world" style="padding:6px 10px;border:none;border-radius:10px;background:#f0ebf8;color:#6b3fa0;font-size:11px;font-weight:600;cursor:pointer;">🔗 快速去重</button>
                    <button class="txt-ai-merge-btn" data-target="world" style="padding:6px 10px;border:none;border-radius:10px;background:#e8f5e9;color:#2e7d32;font-size:11px;font-weight:600;cursor:pointer;">🤖 AI 智能合并</button>
                    <button class="txt-select-all-btn" data-target="world" style="padding:6px 10px;border:none;border-radius:10px;background:#e3f2fd;color:#1565c0;font-size:11px;font-weight:600;cursor:pointer;">${checkedCount === list.length ? '🙌 取消全选' : '✅ 全选'}</button>
                    <button class="txt-save-btn" data-target="world" style="padding:6px 14px;border:none;border-radius:10px;background:#7c4dff;color:white;font-size:12px;font-weight:600;cursor:pointer;${checkedCount === 0 ? 'opacity:0.5;' : ''}">💾 保存选中 (${checkedCount})</button>
                </div>
            </div>
            <div style="display:flex; flex-direction:column; gap:8px;">
                ${list.map((item, i) => renderWorldCard(item, i)).join('')}
            </div>
        </div>
    `;
}

function renderWorldCard(item, index) {
    const checked = state.checkedItems.world.includes(index);
    const text = item.text?.slice(0, 150) || '暂无内容';

    return `
        <div class="txt-item-card" data-type="world" data-index="${index}" style="
            display:flex; align-items:flex-start; gap:12px;
            padding:12px 14px; border-radius:14px;
            background:${checked ? 'rgba(124,77,255,0.06)' : 'rgba(255,255,255,0.85)'};
            border:1.5px solid ${checked ? '#7c4dff' : '#e8e0f0'};
            cursor:pointer; transition:all 0.2s;
        ">
            <div style="flex-shrink:0; padding-top:2px;">
                <input type="checkbox" class="txt-item-checkbox" data-type="world" data-index="${index}" ${checked ? 'checked' : ''} style="width:18px;height:18px;accent-color:#7c4dff;cursor:pointer;">
            </div>
            <div style="flex:1; min-width:0; pointer-events:none;">
                <div style="font-weight:600; font-size:15px; color:#333; margin-bottom:4px;">${item.title || '未命名条目'}</div>
                <div style="font-size:13px; color:#666; line-height:1.4; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">
                    ${text}
                </div>
            </div>
            <button class="txt-edit-btn" data-type="world" data-index="${index}" style="
                flex-shrink:0; padding:6px 10px; border:none; border-radius:8px;
                background:#f5f0ff; color:#6b3fa0; font-size:12px; cursor:pointer;
                transition:all 0.2s; white-space:nowrap;
            ">✏️ 编辑</button>
        </div>
    `;
}

function renderStylePanel() {
    return `
        <div class="txt-panel" data-panel="style" style="display:${state.activeTab === 'style' ? 'block' : 'none'};">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                <div style="font-size:13px; color:#9a7fc0;">
                    ${state.extracted.style ? '✅ 已提取' : '尚未提取文风与规则'}
                </div>
            </div>
            <textarea class="txt-textarea" data-field="style"
                placeholder="点击上方按钮分析文风与规则，结果会显示在这里。"
                style="width:100%; min-height:200px; padding:14px; border:1.5px solid #e8e0f0;
                border-radius:14px; font-size:13px; font-family:'SF Mono',Consolas,monospace;
                line-height:1.6; color:#444; background:rgba(255,255,255,0.8);
                resize:vertical; outline:none; box-sizing:border-box;
            ">${state.styleRules}</textarea>
        </div>
    `;
}

// ---- 编辑弹窗 ----
function renderEditModal() {
    if (!state.editingItem) return '';

    const { type, index } = state.editingItem;
    let list = [];
    try { list = JSON.parse(type === 'characters' ? state.characters : state.worldEntries); } catch { }
    const item = list[index];
    if (!item) return '';

    const isChar = type === 'characters';
    const fields = isChar
        ? ['name', 'gender', 'age', 'orientation', 'desc', 'detail', 'secret', 'style']
        : ['title', 'text'];

    const labels = {
        name: '角色名称', gender: '性别', age: '年龄', orientation: '性取向',
        desc: '一句话描述', detail: '详细设定', secret: '内心秘密', style: '说话风格',
        title: '条目标题', text: '详细内容'
    };

    return `
        <div class="txt-modal-overlay" style="
            position:fixed; inset:0; z-index:9999;
            background:rgba(0,0,0,0.4);
            display:flex; align-items:center; justify-content:center;
            padding:20px;
        ">
            <div style="
                background:white; border-radius:20px; padding:24px;
                max-width:500px; width:100%; max-height:80vh; overflow-y:auto;
                box-shadow:0 8px 40px rgba(0,0,0,0.15);
            ">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                    <div style="font-size:17px; font-weight:600; color:#333;">
                        ${isChar ? '🎭' : '🌍'} 编辑${isChar ? '角色' : '条目'}
                    </div>
                    <button class="txt-modal-close" style="
                        width:32px;height:32px;border:none;border-radius:50%;
                        background:#f5f5f5;color:#999;font-size:18px;cursor:pointer;
                        display:flex;align-items:center;justify-content:center;
                    ">✕</button>
                </div>
                ${fields.map(f => `
                    <div style="margin-bottom:12px;">
                        <label style="font-size:12px; font-weight:600; color:#666; display:block; margin-bottom:4px;">${labels[f]}</label>
                        ${f === 'detail' || f === 'text' || f === 'style'
            ? `<textarea class="txt-modal-field" data-field="${f}" style="width:100%;padding:10px;border:1.5px solid #e8e0f0;border-radius:10px;font-size:13px;font-family:inherit;line-height:1.5;resize:vertical;min-height:${f === 'detail' ? '120px' : '60px'};outline:none;box-sizing:border-box;">${(item[f] || '')}</textarea>`
            : `<input class="txt-modal-field" data-field="${f}" value="${(item[f] || '')}" style="width:100%;padding:10px;border:1.5px solid #e8e0f0;border-radius:10px;font-size:13px;font-family:inherit;outline:none;box-sizing:border-box;">`
        }
                    </div>
                `).join('')}
                <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:16px;">
                    <button class="txt-modal-close" style="padding:10px 20px;border:none;border-radius:12px;background:#f5f5f5;color:#666;font-size:13px;font-weight:600;cursor:pointer;">取消</button>
                    <button class="txt-modal-save" style="padding:10px 20px;border:none;border-radius:12px;background:#7c4dff;color:white;font-size:13px;font-weight:600;cursor:pointer;">✅ 保存修改</button>
                </div>
            </div>
        </div>
    `;
}


// ============================================================
//  事件绑定
// ============================================================

export function bindEvents(container) {
    // ★ 加这两行：
    if (_bindSignal) _bindSignal.abort();
    _bindSignal = new AbortController();
    const { signal } = _bindSignal;
    // ★ 以上三行是新加的
    // ---- 文件上传 ----
    const uploadZone = container.querySelector('#txtUploadZone');
    const fileInput = container.querySelector('#txtFileInput');

    if (uploadZone && fileInput) {
        uploadZone.addEventListener('click', () => fileInput.click(), { signal });

        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            await loadFile(file);
            rebindRender(container);
        }, { signal });

        uploadZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadZone.style.borderColor = '#7c4dff';
            uploadZone.style.background = 'rgba(124,77,255,0.06)';
        }, { signal });
        uploadZone.addEventListener('dragleave', () => {
            uploadZone.style.borderColor = '#c9b8e8';
            uploadZone.style.background = 'rgba(255,255,255,0.7)';
        }, { signal });
        uploadZone.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadZone.style.borderColor = '#c9b8e8';
            uploadZone.style.background = 'rgba(255,255,255,0.7)';
            const file = e.dataTransfer.files[0];
            if (file && file.name.endsWith('.txt')) {
                loadFile(file);
                rebindRender(container);
            } else {
                showToast('⚠️ 请上传 .txt 文件', '#e65100');
            }
        }, { signal });
    }

    // ---- 换文件 ----
    const changeBtn = container.querySelector('#txtChangeFileBtn');
    if (changeBtn) {
        changeBtn.addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.txt';
            input.style.display = 'none';
            document.body.appendChild(input);
            input.addEventListener('change', async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                state = {
                    fileName: '', fileSize: 0, fileContent: '',
                    characters: '[]', worldEntries: '[]', styleRules: '',
                    extracted: { characters: false, world: false, style: false },
                    activeTab: 'characters',
                    checkedItems: { characters: [], world: [] },
                    editingItem: null,
                    progress: {
                        characters: { totalChunks: 0, doneChunks: [], failedChunks: [] },
                        world: { totalChunks: 0, doneChunks: [], failedChunks: [] },
                        style: { totalChunks: 0, doneChunks: [], failedChunks: [] }
                    }
                };
                await loadFile(file);
                rebindRender(container);
                input.remove();
            }, { signal });
            input.click();
        }, { signal });
    }

    // ---- 清除文件 ----
    const clearBtn = container.querySelector('#txtClearFileBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            state = {
                fileName: '', fileSize: 0, fileContent: '',
                characters: '[]', worldEntries: '[]', styleRules: '',
                extracted: { characters: false, world: false, style: false },
                activeTab: 'characters',
                checkedItems: { characters: [], world: [] },
                editingItem: null,
                progress: {
                    characters: { totalChunks: 0, doneChunks: [], failedChunks: [] },
                    world: { totalChunks: 0, doneChunks: [], failedChunks: [] },
                    style: { totalChunks: 0, doneChunks: [], failedChunks: [] }
                }
            };
            saveState();
            showToast('🗑️ 已清除文件与提取结果', '#666');
            rebindRender(container);
        }, { signal });
    }

    // ---- 单个提取按钮 ----
    container.querySelectorAll('.txt-action-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const action = btn.dataset.action;
            await runExtraction(action, container);
        }, { signal });
    });

    // ---- 一键全部提取 ----
    const allBtn = container.querySelector('#txtExtractAllBtn');
    if (allBtn) {
        allBtn.addEventListener('click', async () => {
            allBtn.disabled = true;
            allBtn.textContent = '⏳ 提取中...';
            allBtn.style.opacity = '0.6';

            try {
                await runExtraction('characters', container);
                await runExtraction('world', container);
                await runExtraction('style', container);
                showToast('✨ 全部提取完成！', '#7c4dff');
            } catch (e) {
                showToast(`❌ ${e.message}`, '#c62828');
            }

            allBtn.disabled = false;
            allBtn.textContent = '✨ 一键全部提取';
            allBtn.style.opacity = '1';
        }, { signal });
    }

    // ---- Tab 切换 ----
    container.querySelectorAll('.txt-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            state.activeTab = btn.dataset.tab;
            saveState();
            rebindRender(container);
        }, { signal });
    });

    // ---- 卡片勾选 ----
    container.addEventListener('change', (e) => {
        const checkbox = e.target.closest('.txt-item-checkbox');
        if (!checkbox) return;
        const type = checkbox.dataset.type;
        const index = parseInt(checkbox.dataset.index);
        const arr = state.checkedItems[type];
        if (checkbox.checked) {
            if (!arr.includes(index)) arr.push(index);
        } else {
            state.checkedItems[type] = arr.filter(i => i !== index);
        }
        // 排序保持顺序
        state.checkedItems[type].sort((a, b) => a - b);
        saveState();

        // ★ 只更新当前卡片的样式，不重新渲染整个页面
        const card = checkbox.closest('.txt-item-card');
        if (card) {
            card.style.background = checkbox.checked ? 'rgba(124,77,255,0.06)' : 'rgba(255,255,255,0.85)';
            card.style.borderColor = checkbox.checked ? '#7c4dff' : '#e8e0f0';
        }
        // ★ 更新计数
        updateCardCounts(container);
    }, { signal });

    // ---- 卡片点击（勾选框以外的区域也触发勾选）----
    container.addEventListener('click', (e) => {
        const card = e.target.closest('.txt-item-card');
        if (!card) return;
        if (e.target.closest('button') || e.target.closest('input[type="checkbox"]')) return;
        const checkbox = card.querySelector('.txt-item-checkbox');
        if (checkbox) checkbox.click();
    }, { signal });

    // ---- 编辑按钮 ----
    container.addEventListener('click', (e) => {
        const editBtn = e.target.closest('.txt-edit-btn');
        if (!editBtn) return;
        state.editingItem = {
            type: editBtn.dataset.type,
            index: parseInt(editBtn.dataset.index)
        };
        saveState();
        rebindRender(container);
    }, { signal });

    // ---- 关闭编辑弹窗 ----
    container.addEventListener('click', (e) => {
        if (e.target.closest('.txt-modal-close')) {
            state.editingItem = null;
            saveState();
            rebindRender(container);
        }
    }, { signal });

    // 点击弹窗背景关闭
    container.addEventListener('click', (e) => {
        const overlay = e.target.closest('.txt-modal-overlay');
        if (overlay && e.target === overlay) {
            state.editingItem = null;
            saveState();
            rebindRender(container);
        }
    }, { signal });

    // ---- 保存编辑弹窗 ----
    container.addEventListener('click', (e) => {
        const saveBtn = e.target.closest('.txt-modal-save');
        if (!saveBtn) return;
        const overlay = saveBtn.closest('.txt-modal-overlay');
        if (!overlay) return;
        const { type, index } = state.editingItem;
        let list = [];
        try { list = JSON.parse(type === 'characters' ? state.characters : state.worldEntries); } catch { }
        if (!list[index]) return;

        overlay.querySelectorAll('.txt-modal-field').forEach(input => {
            const field = input.dataset.field;
            list[index][field] = input.value;
        });

        if (type === 'characters') {
            setCharData(list);
        } else {
            setWorldData(list);
        }
        state.editingItem = null;
        saveState();
        rebindRender(container);
        showToast('✅ 修改已保存', '#2e7d32');
    }, { signal });

    // ---- 全选/取消全选按钮 ----
    container.querySelectorAll('.txt-select-all-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.target;
            let list = [];
            try { list = JSON.parse(target === 'characters' ? state.characters : state.worldEntries); } catch { }
            const allIndices = list.map((_, i) => i);
            const allSelected = state.checkedItems[target].length === list.length;
            state.checkedItems[target] = allSelected ? [] : allIndices;
            saveState();

            // ★ 直接操作 DOM，不重建
            const cards = container.querySelectorAll(`.txt-item-card[data-type="${target}"]`);
            cards.forEach(card => {
                const index = parseInt(card.dataset.index);
                const checked = state.checkedItems[target].includes(index);
                const checkbox = card.querySelector('.txt-item-checkbox');
                if (checkbox) checkbox.checked = checked;
                card.style.background = checked ? 'rgba(124,77,255,0.06)' : 'rgba(255,255,255,0.85)';
                card.style.borderColor = checked ? '#7c4dff' : '#e8e0f0';
            });

            // 更新计数
            updateCardCounts(container);
        }, { signal });
    });

    // ---- 保存选中按钮 ----
    container.querySelectorAll('.txt-save-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.target;
            const checkedIndices = state.checkedItems[target];
            if (checkedIndices.length === 0) {
                showToast('⚠️ 请先勾选要保存的项目', '#e65100');
                return;
            }
            let list = [];
            try { list = JSON.parse(target === 'characters' ? state.characters : state.worldEntries); } catch { }
            const selected = list.filter((_, i) => checkedIndices.includes(i));

            if (target === 'characters') {
                const destination = container.querySelector('input[name="saveDestination"]:checked')?.value || 'rolebook';
                if (destination === 'worldnet') {
                    saveCharactersToWorldNet(JSON.stringify(selected, null, 2));
                } else {
                    saveCharactersToRolebook(JSON.stringify(selected, null, 2));
                }
                // ★ 移除已保存的角色
                const remaining = list.filter((_, i) => !checkedIndices.includes(i));
                setCharData(remaining);
                state.checkedItems.characters = [];
                rebindRender(container);
            }
            else {
                saveEntriesToWorldbook(JSON.stringify(selected, null, 2));
                // ★ 移除已保存的世界观条目
                const remaining = list.filter((_, i) => !checkedIndices.includes(i));
                setWorldData(remaining);
                state.checkedItems.world = [];
                rebindRender(container);
            }
        }, { signal });
    });

    // ---- 去重合并按钮 ----
    container.querySelectorAll('.txt-dedup-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const target = btn.dataset.target;
            btn.disabled = true;
            btn.textContent = '⏳ 去重中...';

            try {
                let result;
                if (target === 'characters') {
                    const list = JSON.parse(state.characters);
                    result = deduplicateCharacters(list);
                    setCharData(result);
                    state.extracted.characters = true;
                } else if (target === 'world') {
                    const list = JSON.parse(state.worldEntries);
                    result = deduplicateWorldEntries(list);
                    setWorldData(result);
                    state.extracted.world = true;
                }
                state.checkedItems[target] = [];
                saveState();
                showToast('✅ 去重完成！', '#7c4dff');
                rebindRender(container);
            } catch (e) {
                showToast(`❌ 去重失败: ${e.message}`, '#c62828');
            }

            btn.disabled = false;
            btn.textContent = '🔗 快速去重';
        }, { signal });
    });

    // ---- AI 智能合并按钮 ----
    container.querySelectorAll('.txt-ai-merge-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const target = btn.dataset.target;
            btn.disabled = true;
            btn.textContent = '⏳ AI 合并中...';

            try {
                const actionLabel = target === 'characters' ? '角色' : '世界观';
                await taskManager.submit(
                    'story',
                    `AI 智能合并${actionLabel}: ${state.fileName}`,
                    async () => {
                        let result;
                        if (target === 'characters') {
                            const list = JSON.parse(state.characters);
                            const checked = state.checkedItems.characters || [];
                            const toMerge = checked.length > 0
                                ? list.filter((_, i) => checked.includes(i))
                                : list;                    // 没勾选就全部处理
                            result = await aiMergeCharacters(toMerge);  // ← 只传勾选的
                        } else {
                            const list = JSON.parse(state.worldEntries);
                            const checked = state.checkedItems.world || [];
                            const toMerge = checked.length > 0
                                ? list.filter((_, i) => checked.includes(i))
                                : list;
                            result = await aiMergeWorldEntries(toMerge);
                        } return result;
                    },
                    {
                        onComplete: (res) => {
                            const parsed = parseJSON(res);
                            if (!Array.isArray(parsed) || parsed.length === 0) {
                                showToast('⚠️ AI 合并结果为空，数据未变动', '#e65100');
                                return;
                            }
                            if (target === 'characters') {
                                const fullList = JSON.parse(state.characters);    // ← 完整列表
                                const checked = state.checkedItems.characters || [];
                                if (checked.length > 0) {
                                    // 去掉被勾选的旧条目
                                    const remaining = fullList.filter((_, i) => !checked.includes(i));
                                    // 加上 AI 合并结果
                                    const newList = [...remaining, ...parsed];
                                    setCharData(newList);
                                }
                                else {
                                    setCharData(parsed);  // ← 没勾选才整体替换
                                }
                                state.extracted.characters = true;
                            } else {
                                const fullList = JSON.parse(state.worldEntries);
                                const checked = state.checkedItems.world || [];
                                if (checked.length > 0) {
                                    const remaining = fullList.filter((_, i) => !checked.includes(i));
                                    const newList = [...remaining, ...parsed];
                                    setWorldData(newList);
                                }
                                else {
                                    setWorldData(parsed);
                                }
                                state.extracted.world = true;
                            } state.checkedItems[target] = [];
                            showToast(`✅ AI 智能合并完成！`, '#2e7d32');
                            rebindRender(container);
                        },

                        onError: (err) => {
                            showToast(`❌ AI 合并失败: ${err}`, '#c62828');
                        }
                    }
                );
            } catch (e) {
                showToast(`❌ ${e.message}`, '#c62828');
            }

            btn.disabled = false;
            btn.textContent = '🤖 AI 智能合并';
        }, { signal });
    });
}

// ============================================================
//  核心逻辑
// ============================================================

async function loadFile(file) {
    state.fileName = file.name;
    state.fileSize = file.size;
    try {
        state.fileContent = await file.text();
        saveState();
        showToast(`✅ 已加载 ${file.name}`, '#2e7d32');
    } catch (e) {
        showToast(`❌ 文件读取失败: ${e.message}`, '#c62828');
    }
}

async function runExtraction(action, container) {
    if (!state.fileContent) {
        showToast('⚠️ 请先上传文件', '#e65100');
        return;
    }

    const progress = state.progress[action];
    const hasProgress = progress.totalChunks > 0 && progress.doneChunks.length > 0;

    if (hasProgress) {
        const choice = await new Promise(resolve => {
            const done = progress.doneChunks.length;
            const total = progress.totalChunks;
            const failed = progress.failedChunks.length;

            const overlay = document.createElement('div');
            overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:9999;display:flex;align-items:center;justify-content:center;`;
            overlay.innerHTML = `
                <div style="background:white;border-radius:20px;padding:24px;max-width:320px;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,0.2);">
                    <div style="font-size:16px;font-weight:600;margin-bottom:8px;">🔄 检测到已有进度</div>
                    <div style="font-size:13px;color:#666;margin-bottom:16px;">
                        已完成 ${done}/${total} 块${failed > 0 ? `，${failed} 块失败` : ''}
                    </div>
                    <div style="display:flex;gap:10px;justify-content:center;">
                        <button id="resumeYesBtn" style="padding:8px 20px;border:none;border-radius:10px;background:#7c4dff;color:white;font-weight:600;cursor:pointer;">🔄 续传</button>
                        <button id="resumeNoBtn" style="padding:8px 20px;border:none;border-radius:10px;background:#f0ebf8;color:#666;font-weight:600;cursor:pointer;">重新开始</button>
                        <button id="resumeCancelBtn" style="padding:8px 20px;border:none;border-radius:10px;background:#f5f5f5;color:#999;font-weight:600;cursor:pointer;">取消</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);

            overlay.querySelector('#resumeYesBtn').onclick = () => { overlay.remove(); resolve('resume'); };
            overlay.querySelector('#resumeNoBtn').onclick = () => { overlay.remove(); resolve('restart'); };
            overlay.querySelector('#resumeCancelBtn').onclick = () => { overlay.remove(); resolve('cancel'); };
        });

        if (choice === 'cancel') return;
        if (choice === 'restart') {
            state.progress[action] = { totalChunks: 0, doneChunks: [], failedChunks: [] };
            // 清理旧数据
            if (action === 'characters') {
                setCharData('[]');
                state.extracted.characters = false;
                state.checkedItems.characters = [];
            } else if (action === 'world') {
                setWorldData('[]');
                state.extracted.world = false;
                state.checkedItems.world = [];
            } else {
                state.styleRules = '';
                state.extracted.style = false;
            }
        }
    }

    const resumeFrom = hasProgress && state.progress[action].doneChunks.length > 0
        ? { doneChunks: state.progress[action].doneChunks }
        : null;

    // 如果续传时所有块都已成功，直接提示
    if (resumeFrom) {
        const total = state.progress[action].totalChunks;
        if (state.progress[action].doneChunks.length >= total) {
            showToast('ℹ️ 所有块已完成，无需重复提取', '#6b3fa0');
            return;
        }
    }

    const totalChunks = splitIntoChunks(state.fileContent).length;

    if (!resumeFrom) {
        state.progress[action] = { totalChunks, doneChunks: [], failedChunks: [] };
        saveState();
    }

    try {
        const actionLabel = action === 'characters' ? '角色卡'
            : action === 'world' ? '世界观' : '文风规则';

        const result = await taskManager.submit(
            'story',
            `提取${actionLabel}: ${state.fileName}`,
            () => {
                if (action === 'characters') {
                    return extractCharacters(state.fileContent, (msg) => {
                        updateProgress(container, msg);
                    }, resumeFrom);
                } else if (action === 'world') {
                    return extractWorldEntries(state.fileContent, (msg) => {
                        updateProgress(container, msg);
                    }, resumeFrom);
                } else {
                    return extractStyleAndRules(state.fileContent, (msg) => {
                        updateProgress(container, msg);
                    }, resumeFrom);
                }
            },
            {
                onComplete: (res) => {
                    if (action === 'characters') {
                        setCharData(res);;
                        state.extracted.characters = true;
                    } else if (action === 'world') {
                        setWorldData(res);
                        state.extracted.world = true;
                    } else {
                        state.styleRules = res;
                        state.extracted.style = true;
                    }
                    state.progress[action] = { totalChunks: 0, doneChunks: [], failedChunks: [] };
                    saveState();
                    const icon = action === 'characters' ? '🎭' : action === 'world' ? '🌍' : '✍️';
                    showToast(`${icon} ${actionLabel}提取完成！`, '#7c4dff');
                    rebindRender(container);
                },
                onError: (err) => {
                    showToast(`❌ ${actionLabel}提取失败: ${err}`, '#c62828');
                }
            }
        );
    } catch (e) {
        showToast(`❌ ${e.message}`, '#c62828');
    }
}

function updateProgress(container, msg) {
    const info = container?.querySelector('.txt-progress');
    if (info) info.textContent = msg;
}

function rebindRender(container) {
    const appContainer = container.closest('.page-container') || container;
    appContainer.innerHTML = render();
    bindEvents(appContainer);
}

// ============================================================
//  保存函数
// ============================================================

function saveCharactersToRolebook(jsonStr) {
    let chars;
    try {
        chars = JSON.parse(jsonStr);
    } catch (e) {
        showToast('❌ 角色数据格式错误，无法保存', '#c62828');
        return;
    }
    if (!Array.isArray(chars) || chars.length === 0) {
        showToast('❌ 没有角色数据可保存', '#c62828');
        return;
    }

    let existing = [];
    try {
        const saved = localStorage.getItem(STORAGE_KEY_ROLEBOOK);
        if (saved) existing = JSON.parse(saved);
    } catch { }

    let added = 0;
    chars.forEach(c => {
        if (!c.name) return;
        if (existing.some(e => e.base.name === c.name)) return;
        const charData = createDefaultCharacterData(generateId(), {
            name: c.name,
            gender: c.gender || '未知',
            age: c.age || '未知',
            orientation: c.orientation || '未知',
            desc: c.desc || '',
            detail: c.detail || '',
            secret: c.secret || '',
            style: c.style || '',
            memories: []
        }, 'character', { switchable: true });
        existing.push(charData);
        added++;
    });

    localStorage.setItem(STORAGE_KEY_ROLEBOOK, JSON.stringify(existing));
    showToast(`✅ 已保存 ${added} 个角色到角色名册`, '#2e7d32');
}

const STORAGE_KEY_WORLDNET_EXTRA = 'worldnet_extra_characters';

function saveCharactersToWorldNet(jsonStr) {
    let chars;
    try { chars = JSON.parse(jsonStr); } catch (e) {
        showToast('❌ 角色数据格式错误，无法保存', '#c62828');
        return;
    }
    if (!Array.isArray(chars) || chars.length === 0) {
        showToast('❌ 没有角色数据可保存', '#c62828');
        return;
    }

    let existing = [];
    try {
        const saved = localStorage.getItem(STORAGE_KEY_WORLDNET_EXTRA);
        if (saved) existing = JSON.parse(saved);
    } catch {}

    let added = 0;
    chars.forEach(c => {
        if (!c.name) return;
        if (existing.some(e => e.base.name === c.name)) return;
        // ★ 用 createDefaultCharacterData 创建 NPC 格式的数据
        const npcData = createDefaultCharacterData(generateId(), {
            name: c.name,
            gender: c.gender || '未知',
            age: c.age || '未知',
            orientation: c.orientation || '未知',
            desc: c.desc || '',
            detail: c.detail || '',
            secret: c.secret || '',
            style: c.style || '',
            memories: []
        }, 'npc', {
            convertible: true,
            customizable: true
        });
        existing.push(npcData);
        added++;
    });

    localStorage.setItem(STORAGE_KEY_WORLDNET_EXTRA, JSON.stringify(existing));
    showToast(`✅ 已保存 ${added} 个角色到世界角色网络`, '#ff9800');
}


function saveEntriesToWorldbook(jsonStr) {
    let entries;
    try {
        entries = JSON.parse(jsonStr);
    } catch (e) {
        showToast('❌ 世界书数据格式错误，无法保存', '#c62828');
        return;
    }
    if (!Array.isArray(entries) || entries.length === 0) {
        showToast('❌ 没有世界书条目可保存', '#c62828');
        return;
    }

    let existing = [];
    try {
        const saved = localStorage.getItem(STORAGE_KEY_WORLDBOOK);
        if (saved) existing = JSON.parse(saved);
    } catch { }

    let added = 0;
    entries.forEach(e => {
        if (!e.title) return;
        if (existing.some(x => x.title === e.title)) return;
        existing.push({
            id: genId(),
            title: e.title,
            text: e.text || '',
            priority: 6,
            enabled: true,
            activation: 'global',
            tags: []
        });
        added++;
    });

    localStorage.setItem(STORAGE_KEY_WORLDBOOK, JSON.stringify(existing));
    showToast(`✅ 已保存 ${added} 条到世界书`, '#2e7d32');
}

// ============================================================
//  返回处理（切页面回来数据不丢失，靠模块级变量 + sessionStorage）
// ============================================================

export function handleBack(container) {
    return false;
}

// apps/market/txtImporter.js — 📄 TXT 导入工具
// 从文本文件中提取角色卡、世界书条目、文风与规则

import { taskManager } from '../../store/AITaskManager.js';
import { generateId, createDefaultCharacterData } from '../../store/CharacterStore.js';

// ============================================================
//  状态管理（模块级变量，切页面不丢失）
// ============================================================

const STORAGE_KEY = 'txt_importer_state';
const STORAGE_KEY_WORLDBOOK = 'worldbook_entries';
const STORAGE_KEY_ROLEBOOK = 'rolebook_characters';

function loadState() {
    try {
        const saved = sessionStorage.getItem(STORAGE_KEY);
        if (saved) return JSON.parse(saved);
    } catch (e) { /* 忽略 */ }
    return {
        fileName: '',
        fileSize: 0,
        fileContent: '',
        characters: '[]',      // JSON 字符串，直接对应文本框内容
        worldEntries: '[]',
        styleRules: '',
        extracted: {
            characters: false,
            world: false,
            style: false
        },
        activeTab: 'characters'
    };
}

function saveState() {
    try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) { /* 忽略 */ }
}

let state = loadState();

// ============================================================
//  工具函数
// ============================================================

function genId() {
    return 'entry_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
}

function countTextWords(text) {
    // 统计中文字符（汉字）
    const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
    // 统计英文单词（按空格分）
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

// ---- 获取 AI 预设配置 ----
function getPreset() {
    try {
        const presets = JSON.parse(localStorage.getItem('ai_presets') || '[]');
        const activeId = localStorage.getItem('ai_active_preset');
        if (activeId) {
            const found = presets.find(p => p.id === activeId);
            if (found) return found;
        }
        if (presets.length > 0) return presets[0];
    } catch (e) { /* 忽略 */ }
    return null;
}

// ---- 通用 AI 调用 ----
async function callAI(systemPrompt, userContent, maxTokens = 4096) {
    const preset = getPreset();
    if (!preset) throw new Error('未找到 API 预设，请先在设置中配置');
    if (!preset.apiKey) throw new Error('请先在设置中配置 API 密钥');

    const url = preset.endpoint.replace(/\/+$/, '') + '/chat/completions';
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${preset.apiKey}`
        },
        body: JSON.stringify({
            model: preset.model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userContent }
            ],
            max_tokens: maxTokens,
            temperature: 0.7
        })
    });

    if (!response.ok) {
        let errMsg = `HTTP ${response.status}`;
        try { const err = await response.json(); errMsg = err.error?.message || err.message || errMsg; } catch { }
        throw new Error(`AI 调用失败: ${errMsg}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

// ---- 解析 AI 返回的 JSON ----
function parseJSON(text) {
    let clean = text.trim();
    const jsonMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) clean = jsonMatch[1].trim();
    const firstBrace = clean.indexOf('{');
    const lastBrace = clean.lastIndexOf('}');
    const firstBracket = clean.indexOf('[');
    const lastBracket = clean.lastIndexOf(']');

    // 优先尝试解析为数组
    if (firstBracket !== -1 && lastBracket > firstBracket) {
        try {
            return JSON.parse(clean.substring(firstBracket, lastBracket + 1));
        } catch { }
    }
    // 尝试解析为对象
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
    throw new Error('AI 返回的数据格式无法解析');
}

// ============================================================
//  AI 提取函数
// ============================================================

async function extractCharacters(content, onProgress) {
    onProgress?.('正在分析角色信息...');

    const systemPrompt = `你是一个专业的文学分析助手。从给定的文本中提取所有主要和次要角色信息。
返回一个 JSON 数组，每个角色包含以下字段。只返回 JSON，不要包含任何其他文字，不要用 markdown 标记。`;

    const userContent = `从以下文本中提取所有角色信息，返回 JSON 数组：

${content.slice(0, 8000)}

请按以下格式返回数组：
[
  {
    "name": "角色名称",
    "gender": "性别",
    "age": "年龄描述",
    "orientation": "性取向",
    "desc": "一句话角色概括",
    "detail": "详细的外貌、性格、背景设定",
    "secret": "角色的内心秘密或隐藏动机",
    "style": "说话风格描述"
  }
]

注意：
- 如果文本中信息不足，合理推断或标注"未知"
- 至少提取 1 个角色，最多提取 8 个主要角色
- 按重要性排序`;

    const result = await callAI(systemPrompt, userContent, 4096);
    const parsed = parseJSON(result);
    // 确保是数组
    const arr = Array.isArray(parsed) ? parsed : (parsed.characters || [parsed]);
    return JSON.stringify(arr, null, 2);
}

async function extractWorldEntries(content, onProgress) {
    onProgress?.('正在分析世界观设定...');

    const systemPrompt = `你是一个专业的文学分析助手。从给定的文本中提取世界观设定信息。
返回一个 JSON 数组，每个条目包含标题和内容。只返回 JSON，不要包含任何其他文字。`;

    const userContent = `从以下文本中提取世界观设定条目，返回 JSON 数组：

${content.slice(0, 8000)}

请按以下格式返回：
[
  {
    "title": "条目标题（如：地理环境、魔法体系、社会结构、历史事件等）",
    "text": "详细描述该设定的内容，尽量完整"
  }
]

注意：
- 提取世界的地理、历史、文化、魔法/科技体系、社会规则等设定
- 每个条目独立且完整
- 至少 2 条，最多 12 条`;

    const result = await callAI(systemPrompt, userContent, 4096);
    const parsed = parseJSON(result);
    const arr = Array.isArray(parsed) ? parsed : (parsed.entries || [parsed]);
    return JSON.stringify(arr, null, 2);
}

async function extractStyleAndRules(content, onProgress) {
    onProgress?.('正在分析文风与规则...');

    const systemPrompt = `你是一个专业的文学分析助手。从给定的文本中提取文风特点和隐含规则。
请用自然语言分段描述，不要使用 JSON 格式。`;

    const userContent = `分析以下文本，提取以下三个方面，用中文分段描述：

【文风特点】
- 叙述风格（如：简洁/华丽、幽默/严肃、第一/第三人称等）
- 语言特色（用词习惯、句式特点、修辞手法）
- 节奏与氛围

【叙事规则】
- 故事结构特点
- 视角切换方式
- 时间线处理

【可借鉴的写作手法】
- 场景描写技巧
- 对话处理方式
- 情节推进手段

文本内容：
${content.slice(0, 6000)}

请分三段输出，每段用标题标注。`;

    return await callAI(systemPrompt, userContent, 4096);
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

    // 读取现有的角色名册
    let existing = [];
    try {
        const saved = localStorage.getItem(STORAGE_KEY_ROLEBOOK);
        if (saved) existing = JSON.parse(saved);
    } catch { }

    let added = 0;
    chars.forEach(c => {
        if (!c.name) return;
        // 检查是否已存在同名角色
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

    // 读取现有的世界书条目
    let existing = [];
    try {
        const saved = localStorage.getItem(STORAGE_KEY_WORLDBOOK);
        if (saved) existing = JSON.parse(saved);
    } catch { }

    let added = 0;
    entries.forEach(e => {
        if (!e.title) return;
        // 检查是否已存在同标题条目
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
//  渲染
// ============================================================

export function render() {
    const hasFile = !!state.fileContent;
    const hasCharacters = state.extracted.characters;
    const hasWorld = state.extracted.world;
    const hasStyle = state.extracted.style;

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
        <div class="txt-file-info" style="...">
            <div style="font-size:32px;">📄</div>
            <div style="flex:1; min-width:0;">
                <div style="font-weight:600; font-size:14px; color:#333; ...">
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
    white-space:nowrap;
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

function renderResultPanels() {
    return `
        <div style="margin:0 4px 20px;">
            <!-- 角色卡面板 -->
            <div class="txt-panel" data-panel="characters" style="display:${state.activeTab === 'characters' ? 'block' : 'none'};">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <div style="font-size:13px; color:#9a7fc0;">
                        ${state.extracted.characters ? '✅ 已提取，可编辑后保存' : '尚未提取角色信息'}
                    </div>
                    <div style="display:flex; gap:6px;">
                        ${state.extracted.characters ? `
                            <button class="txt-save-btn" data-target="characters" style="
                                padding:6px 14px; border:none; border-radius:10px;
                                background:#7c4dff; color:white; font-size:12px; font-weight:600;
                                cursor:pointer; transition:all 0.2s;
                            ">💾 保存到角色名册</button>
                        ` : ''}
                    </div>
                </div>
                <textarea class="txt-textarea" data-field="characters"
                    placeholder="点击上方按钮提取角色信息，结果会显示在这里。你也可以手动输入或粘贴 JSON。"
                    style="width:100%; min-height:200px; padding:14px; border:1.5px solid #e8e0f0;
                    border-radius:14px; font-size:13px; font-family:'SF Mono',Consolas,monospace;
                    line-height:1.6; color:#444; background:rgba(255,255,255,0.8);
                    resize:vertical; outline:none; box-sizing:border-box;
                ">${state.characters}</textarea>
            </div>

            <!-- 世界观面板 -->
            <div class="txt-panel" data-panel="world" style="display:${state.activeTab === 'world' ? 'block' : 'none'};">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <div style="font-size:13px; color:#9a7fc0;">
                        ${state.extracted.world ? '✅ 已提取，可编辑后保存' : '尚未提取世界观信息'}
                    </div>
                    <div style="display:flex; gap:6px;">
                        ${state.extracted.world ? `
                            <button class="txt-save-btn" data-target="world" style="
                                padding:6px 14px; border:none; border-radius:10px;
                                background:#7c4dff; color:white; font-size:12px; font-weight:600;
                                cursor:pointer; transition:all 0.2s;
                            ">💾 保存到世界书</button>
                        ` : ''}
                    </div>
                </div>
                <textarea class="txt-textarea" data-field="world"
                    placeholder="点击上方按钮提取世界观信息，结果会显示在这里。你也可以手动输入或粘贴 JSON。"
                    style="width:100%; min-height:200px; padding:14px; border:1.5px solid #e8e0f0;
                    border-radius:14px; font-size:13px; font-family:'SF Mono',Consolas,monospace;
                    line-height:1.6; color:#444; background:rgba(255,255,255,0.8);
                    resize:vertical; outline:none; box-sizing:border-box;
                ">${state.worldEntries}</textarea>
            </div>

            <!-- 文风规则面板 -->
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
        </div>
    `;
}

// ============================================================
//  事件绑定
// ============================================================

export function bindEvents(container) {
    // ---- 文件上传 ----
    const uploadZone = container.querySelector('#txtUploadZone');
    const fileInput = container.querySelector('#txtFileInput');

    if (uploadZone && fileInput) {
        uploadZone.addEventListener('click', () => fileInput.click());

        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            await loadFile(file);
            rebindRender(container);
        });

        // 拖拽支持
        uploadZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadZone.style.borderColor = '#7c4dff';
            uploadZone.style.background = 'rgba(124,77,255,0.06)';
        });
        uploadZone.addEventListener('dragleave', () => {
            uploadZone.style.borderColor = '#c9b8e8';
            uploadZone.style.background = 'rgba(255,255,255,0.7)';
        });
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
        });
    }

    // ---- 换文件 ----
    const changeBtn = container.querySelector('#txtChangeFileBtn');
    if (changeBtn) {
        changeBtn.addEventListener('click', () => {
            // 重建文件输入
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.txt';
            input.style.display = 'none';
            document.body.appendChild(input);
            input.addEventListener('change', async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                // 重置状态
                state = {
                    fileName: '',
                    fileSize: 0,
                    fileContent: '',
                    characters: '[]',
                    worldEntries: '[]',
                    styleRules: '',
                    extracted: { characters: false, world: false, style: false },
                    activeTab: 'characters'
                };
                await loadFile(file);
                rebindRender(container);
                input.remove();
            });
            input.click();
        });
    }

    // ---- 清除文件 ----
    const clearBtn = container.querySelector('#txtClearFileBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            // 重置所有状态
            state = {
                fileName: '',
                fileSize: 0,
                fileContent: '',
                characters: '[]',
                worldEntries: '[]',
                styleRules: '',
                extracted: { characters: false, world: false, style: false },
                activeTab: 'characters'
            };
            saveState();  // 同时清空 sessionStorage 里的数据
            showToast('🗑️ 已清除文件与提取结果', '#666');
            rebindRender(container);
        });
    }


    // ---- 单个提取按钮 ----
    container.querySelectorAll('.txt-action-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const action = btn.dataset.action;
            await runExtraction(action, container);
        });
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
        });
    }

    // ---- Tab 切换 ----
    container.querySelectorAll('.txt-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            state.activeTab = btn.dataset.tab;
            saveState();
            rebindRender(container);
        });
    });

    // ---- 文本框输入自动保存 ----
    container.querySelectorAll('.txt-textarea').forEach(ta => {
        ta.addEventListener('input', () => {
            const field = ta.dataset.field;
            if (field === 'characters') state.characters = ta.value;
            else if (field === 'world') state.worldEntries = ta.value;
            else if (field === 'style') state.styleRules = ta.value;
            saveState();
        });
    });

    // ---- 保存按钮 ----
    container.querySelectorAll('.txt-save-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.target;
            if (target === 'characters') {
                saveCharactersToRolebook(state.characters);
            } else if (target === 'world') {
                saveEntriesToWorldbook(state.worldEntries);
            }
        });
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

    // 如果已提取过，跳过
    if (state.extracted[action]) {
        showToast('ℹ️ 已提取过，无需重复提取', '#6b3fa0');
        return;
    }

    try {
        let result;
        let field;

        switch (action) {
            case 'characters':
                result = await taskManager.submit(
                    'story',
                    `提取角色卡: ${state.fileName}`,
                    () => extractCharacters(state.fileContent, (msg) => {
                        updateProgress(container, msg);
                    }),
                    {
                        onComplete: (res) => {
                            state.characters = res;
                            state.extracted.characters = true;
                            saveState();
                            showToast('🎭 角色提取完成！', '#7c4dff');
                            rebindRender(container);
                        },
                        onError: (err) => {
                            showToast(`❌ 角色提取失败: ${err}`, '#c62828');
                        }
                    }
                );
                break;

            case 'world':
                result = await taskManager.submit(
                    'story',
                    `提取世界观: ${state.fileName}`,
                    () => extractWorldEntries(state.fileContent, (msg) => {
                        updateProgress(container, msg);
                    }),
                    {
                        onComplete: (res) => {
                            state.worldEntries = res;
                            state.extracted.world = true;
                            saveState();
                            showToast('🌍 世界观提取完成！', '#7c4dff');
                            rebindRender(container);
                        },
                        onError: (err) => {
                            showToast(`❌ 世界观提取失败: ${err}`, '#c62828');
                        }
                    }
                );
                break;

            case 'style':
                result = await taskManager.submit(
                    'story',
                    `分析文风: ${state.fileName}`,
                    () => extractStyleAndRules(state.fileContent, (msg) => {
                        updateProgress(container, msg);
                    }),
                    {
                        onComplete: (res) => {
                            state.styleRules = res;
                            state.extracted.style = true;
                            saveState();
                            showToast('✍️ 文风分析完成！', '#7c4dff');
                            rebindRender(container);
                        },
                        onError: (err) => {
                            showToast(`❌ 文风分析失败: ${err}`, '#c62828');
                        }
                    }
                );
                break;
        }
    } catch (e) {
        showToast(`❌ ${e.message}`, '#c62828');
    }
}

function updateProgress(container, msg) {
    // 通过自定义事件更新进度（悬浮窗由 taskManager 自动管理）
    // 也可以在这里加一个内联进度提示
    const info = container?.querySelector('.txt-progress');
    if (info) info.textContent = msg;
}

function rebindRender(container) {
    // 重新渲染当前视图
    const appContainer = container.closest('.page-container') || container;
    appContainer.innerHTML = render();
    bindEvents(appContainer);
}

// ============================================================
//  返回处理（切页面回来数据不丢失，靠模块级变量 + sessionStorage）
// ============================================================

export function handleBack(container) {
    // 不做特殊处理，直接返回 false 让 app.js 处理
    return false;
}

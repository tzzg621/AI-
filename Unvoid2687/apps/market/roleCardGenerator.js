// apps/market/roleCardGenerator.js — 角色卡生成器
// 入口：应用市场 → 角色卡生成器（被 market.js 动态加载）
// 职责：AI 生成 + 文件导入（txt/json/docx 系统提取、png/jpg 嵌入式解析）→ 写入 card_ + IndexedDB
// 特点：后台生成不阻塞；带图卡导入自动绑定原图为卡面（存公共图片池一份，进形象卡相册）

import { esc } from '../../store/utils.js';
import { importCards, createCardData, updateCard } from '../../store/CardStore.js';
import { setGlobalImage } from '../../store/ImageCache.js';
import { getDefaultPreset } from '../aiService.js';
import { parsePngEmbedded, parseJpgEmbedded, parseDocxText, stripPngData, stripJpgData } from '../../store/CardFileIO.js';

// ============================================================
//  状态
// ============================================================
let activeTab = 'ai';   // ai | import

// ============================================================
//  工具
// ============================================================
function showToast(msg, bg = '#333') {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:${bg};color:#fff;padding:10px 20px;border-radius:12px;z-index:10000;font-size:13px;box-shadow:0 4px 20px rgba(0,0,0,0.2);max-width:80%;text-align:center;`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
}

function rerender(container) {
    const appContainer = container.closest('.page-container') || container;
    appContainer.innerHTML = render();
    bindEvents(appContainer);
}

function getTaskManager() {
    return import('../../store/AITaskManager.js').then(m => m.taskManager);
}

// ============================================================
//  AI 生成（prompt 扩展：memories / first_message / relations）
// ============================================================
async function callCardAI(description) {
    const preset = getDefaultPreset();
    if (!preset) throw new Error('未找到可用的 API 预设，请先在设置中添加');
    if (!preset.apiKey) throw new Error('请先在设置中填写 API 密钥');

    const systemPrompt = '你是一个角色卡生成器。根据用户的描述，生成一张完整的角色卡数据。只返回 JSON，不要包含任何其他文字，不要加 markdown 标记。';

    const userContent = `根据以下描述生成角色卡：
${description}

请严格按以下 JSON 格式返回：
{
    "name": "角色名称",
    "gender": "性别（如：男/女/非二元/未知/隐藏，也可以自定义）",
    "age": "年龄（简短描述，不超过8个字，如：22岁/少年/古老的存在/未知）",
    "orientation": "性取向（如：异性恋/同性恋/双性恋/无性恋/泛性恋/未知）",
    "tag": "一个简短标签（如：都市/异界/校园/江湖）",
    "emoji": "一个最能代表这个角色的emoji",
    "desc": "一句话概括这个角色",
    "detail": "详细设定：外貌特征、性格特点、背景故事，尽量丰富",
    "secret": "一个内心秘密",
    "style": "说话风格描述",
    "memories": [{"time": "时间或时期", "content": "这段经历的具体内容"}],
    "relations": [{"name": "对象名称", "relation": "与ta的关系", "perspective": "这段关系的背景故事"}],
    "profile": {
        "L1": {"详细性格": "熟人才能了解的性格细节", "说话风格": "……"},
        "L2": {"弱点": "……", "秘密": "……"}
    },
    "firstMessage": "这个角色第一次见到主角时说的话"
}`;

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
            max_tokens: 12000,
            temperature: 0.8
        })
    });

    if (!response.ok) {
        let errMsg = `HTTP ${response.status}`;
        try {
            const err = await response.json();
            errMsg = err.error?.message || err.message || errMsg;
        } catch { }
        throw new Error(`AI 生成失败: ${errMsg}`);
    }

    const data = await response.json();
    const result = data.choices[0].message.content;

    // 解析 JSON（容错：markdown 围栏 / 首尾花括号 / 尾部逗号）
    let text = result.trim();
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) text = jsonMatch[1].trim();
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        text = text.substring(firstBrace, lastBrace + 1);
    }

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        try {
            text = text.replace(/,(\s*[}\]])/g, '$1');
            parsed = JSON.parse(text);
        } catch {
            console.error('AI 返回的原始内容:', result);
            throw new Error('AI 返回的数据格式无法解析');
        }
    }

    return createCardData({
        name: parsed.name || '未命名角色卡',
        gender: parsed.gender || '未知',
        age: parsed.age || '未知',
        orientation: parsed.orientation || '未知',
        tag: parsed.tag || '',
        emoji: parsed.emoji || '🎴',
        desc: parsed.desc || '',
        detail: parsed.detail || '',
        secret: parsed.secret || '',
        style: parsed.style || '',
        memories: Array.isArray(parsed.memories) ? parsed.memories : [],
        relations: Array.isArray(parsed.relations) ? parsed.relations : [],
        profile: parsed.profile || {},
        firstMessage: parsed.firstMessage || ''
    });
}

// ============================================================
//  结构化解析（json / 系统提取）
//  支持：自家卡 json、SillyTavern chara v2（含 extras 里的 memories/relations）
// ============================================================
function mapToCard(parsed) {
    // ① 自家卡 json（createCardData 结构）
    if (parsed && parsed.name && Array.isArray(parsed.memories)) {
        return createCardData(parsed);
    }
    // ② SillyTavern chara v2（{ spec, data: {...} }）
    const data = (parsed && parsed.data) || parsed;
    if (!data || typeof data !== 'object') throw new Error('文件格式不正确，提取失败');

    const detailParts = [data.description, data.personality, data.scenario].filter(Boolean);
    const extras = data.extras || {};
    return createCardData({
        name: data.name || '未命名角色卡',
        desc: '',
        detail: detailParts.join('\n\n'),
        tag: (Array.isArray(data.tags) && data.tags[0]) || '',
        memories: Array.isArray(extras.memories) ? extras.memories : [],
        relations: Array.isArray(extras.relations) ? extras.relations : [],
        firstMessage: data.first_mes || ''
    });
}

// ============================================================
//  相册：把卡面 key 手动归入"形象卡"分类（gallery_albums）
// ============================================================
function addCardImageToPortraitAlbum(key) {
    const ALBUMS_KEY = 'gallery_albums';
    try {
        const albums = JSON.parse(localStorage.getItem(ALBUMS_KEY) || '[]');
        const album = albums.find(a => a.id === 'album_portrait');   // 预设相册，一定存在
        if (album && !album.images.includes(key)) {
            album.images.push(key);
            localStorage.setItem(ALBUMS_KEY, JSON.stringify(albums));
        }
    } catch { }
}

// ============================================================
//  文件导入（txt / json / png / jpg / docx，支持多选）
// ============================================================
async function handleFiles(fileList) {
    const results = { ok: 0, fail: 0, fails: [] };

    for (const file of fileList) {
        try {
            const name = (file.name || '').toLowerCase();

            // ---- 纯文本类：直接建卡（无图） ----
            if (name.endsWith('.txt')) {
                const text = await file.text();
                await importCards([createCardData({
                    name: file.name.replace(/\.txt$/i, '') || '未命名角色卡',
                    detail: text
                })]);
                results.ok++;

                // ---- docx：解 zip 提取正文文本作为详细设定（无图） ----
            } else if (name.endsWith('.docx')) {
                const buffer = await file.arrayBuffer();
                const text = await parseDocxText(buffer);
                await importCards([createCardData({
                    name: file.name.replace(/\.docx$/i, '') || '未命名角色卡',
                    detail: text
                })]);
                results.ok++;

                // ---- json：系统提取 ----
            } else if (name.endsWith('.json')) {
                const text = await file.text();
                await importCards([mapToCard(JSON.parse(text))]);
                results.ok++;

                // ---- 带图卡：解析嵌入式数据 + 绑定原图为卡面 ----
            } else if (name.endsWith('.png')) {
                const buffer = await file.arrayBuffer();
                const parsed = await parsePngEmbedded(buffer);
                await createCardWithImage(mapToCard(parsed), file);
                results.ok++;

            } else if (name.endsWith('.jpg') || name.endsWith('.jpeg')) {
                const buffer = await file.arrayBuffer();
                const parsed = await parseJpgEmbedded(buffer);
                await createCardWithImage(mapToCard(parsed), file);
                results.ok++;

            } else {
                results.fail++;
                results.fails.push(`${file.name}（不支持的格式）`);
            }

        } catch (e) {
            results.fail++;
            results.fails.push(`${file.name}（${e.message || '解析失败'}）`);
        }
    }

    if (results.ok > 0) {
        showToast(`✅ 成功导入 ${results.ok} 张角色卡${results.fail > 0 ? `，${results.fail} 张失败` : ''}`, '#2e7d32');
    } else {
        showToast(`❌ 导入失败：${results.fails.join('；') || '未知错误'}`, '#c62828');
    }
}

/** 带图卡导入：建卡 → 原图进公共池（一份）→ 归入形象卡相册 → 卡绑定 key */
async function createCardWithImage(cardData, file) {
    // ★ 先准备干净图片——任何一步失败都会抛错，不会建卡
    const buffer = await file.arrayBuffer();
    const name = (file.name || '').toLowerCase();
    const cleanImage = name.endsWith('.png')
        ? await stripPngData(buffer)
        : await stripJpgData(buffer);

    const key = `gallery_card_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
    await setGlobalImage(key, cleanImage);
    addCardImageToPortraitAlbum(key);

    // ★ 图都准备好了，再建卡并绑定
    const created = await importCards([cardData]);
    const card = created[0];
    await updateCard(card.id, { cardImage: key });
}

// ============================================================
//  渲染
// ============================================================
export function render() {
    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">🎴 角色卡生成器</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content" style="padding:12px 16px 16px;">

                <!-- Tab 切换 -->
                <div style="display:flex; gap:6px; margin-bottom:14px;">
                    <button class="rcg-tab" data-tab="ai" style="
                        flex:1; padding:9px; border-radius:16px; border:none; cursor:pointer;
                        background:${activeTab === 'ai' ? '#7c4dff' : '#f0f0f4'};
                        color:${activeTab === 'ai' ? 'white' : '#666'};
                        font-size:14px; font-weight:600;
                    ">🤖 AI 生成</button>
                    <button class="rcg-tab" data-tab="import" style="
                        flex:1; padding:9px; border-radius:16px; border:none; cursor:pointer;
                        background:${activeTab === 'import' ? '#7c4dff' : '#f0f0f4'};
                        color:${activeTab === 'import' ? 'white' : '#666'};
                        font-size:14px; font-weight:600;
                    ">📂 文件导入</button>
                </div>

                <div id="rcg-body">
                    ${activeTab === 'ai' ? renderAiTab() : renderImportTab()}
                </div>
            </div>
        </div>`;
}

function renderAiTab() {
    return `
        <!-- 提示条 -->
        <div style="background:#ede7f6; border-radius:12px; padding:10px 12px; margin-bottom:12px; font-size:12px; color:#6a4fa3; line-height:1.6;">
            ⚙️ 生成在后台进行，完成后直接放入角色卡画廊。<br>
            生成期间可以切换到其他页面，不会中断。
        </div>

        <!-- 描述输入 -->
        <textarea id="rcg-desc" rows="7" placeholder="自由描述你想创建的角色，例如：&#10;一个在深夜开张的花店老板娘，温柔但藏着秘密，能看见别人身上的花期，她自己从没见过自己的花……"
            style="width:100%; border:1px solid #ddd; border-radius:12px; padding:10px 12px; font-size:14px; box-sizing:border-box; resize:vertical;"></textarea>

        <button id="rcg-ai-btn" style="
            width:100%; margin-top:12px; padding:13px;
            border-radius:24px; border:none; cursor:pointer;
            background:linear-gradient(135deg,#7c4dff,#9c27b0);
            color:white; font-size:15px; font-weight:700;
        ">✨ 生成角色卡</button>
    `;
}

function renderImportTab() {
    return `
        <!-- 选择文件 -->
        <input type="file" id="rcg-file" multiple accept=".txt,.json,.png,.jpg,.jpeg,.docx" style="display:none;" />
        <button id="rcg-pick" style="
            width:100%; padding:13px; border-radius:20px;
            border:2px dashed #7c4dff; background:white; color:#7c4dff;
            cursor:pointer; font-size:15px; font-weight:600;
        ">📂 选择文件（可多选）</button>

        <!-- 格式说明 -->
        <div style="background:#f5f5f5; border-radius:12px; padding:12px; margin-top:14px; font-size:12px; color:#777; line-height:1.9;">
            <div style="font-weight:700; color:#555; margin-bottom:4px;">支持格式</div>
            <div>📄 <b>txt</b> — 全文直接作为角色详细设定</div>
            <div>📝 <b>docx</b> — 提取 Word 正文作为详细设定</div>
            <div>📦 <b>json</b> — SillyTavern 角色卡 JSON / 本应用角色卡 JSON</div>
            <div>🖼️ <b>png</b> — 嵌入式角色卡（chara 格式），原图自动设为卡面并入形象卡相册</div>
            <div>🖼️ <b>jpg</b> — 尾部附加数据角色卡（本应用导出格式），原图自动设为卡面并入形象卡相册</div>
            <div style="color:#bbb; margin-top:4px;">带图卡（png/jpg）导入成功后，原图只存一份，卡片通过 key 引用</div>
        </div>
    `;
}

// ============================================================
//  事件绑定
// ============================================================
export function bindEvents(container) {
    const appContainer = container.closest('.page-container') || container;

    // Tab 切换
    container.querySelectorAll('.rcg-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            activeTab = btn.dataset.tab;
            rerender(appContainer);
        });
    });

    // ---- AI 生成 ----
    container.querySelector('#rcg-ai-btn')?.addEventListener('click', async () => {
        const desc = (container.querySelector('#rcg-desc')?.value || '').trim();
        if (!desc) { showToast('请先描述你想创建的角色', '#ff9800'); return; }

        const btn = container.querySelector('#rcg-ai-btn');
        btn.disabled = true;
        btn.textContent = '⏳ 生成中…（可切换页面，后台继续）';

        try {
            const tm = await getTaskManager();
            const count = await (tm ? tm.watch('cardgen', 'AI 生成角色卡', async () => {
                const card = await callCardAI(desc);
                await importCards([card]);
                return 1;
            }) : (async () => {
                const card = await callCardAI(desc);
                await importCards([card]);
                return 1;
            })());

            showToast(`✅ 已生成 ${count} 张角色卡，可在画廊查看`, '#2e7d32');
        } catch (e) {
            showToast(`❌ ${e.message || '生成失败'}`, '#c62828');
        } finally {
            btn.disabled = false;
            btn.textContent = '✨ 生成角色卡';
        }
    });

    // ---- 文件导入 ----
    container.querySelector('#rcg-pick')?.addEventListener('click', () => {
        container.querySelector('#rcg-file')?.click();
    });

    container.querySelector('#rcg-file')?.addEventListener('change', (e) => {
        const files = e.target.files;
        if (files && files.length > 0) {
            handleFiles(files);
        }
        e.target.value = '';   // 允许重复选同一文件
    });
}

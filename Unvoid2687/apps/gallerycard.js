// apps/gallerycard.js — 角色卡画廊（展示 + 管理）
// 生成在应用市场完成；本模块只负责：列表 / 详情 / 编辑 / 删除 / 转名册·网络 / 导出

import { esc } from '../store/utils.js';
import { CARDS_CHANGED_EVENT, getAllCards, updateCard, deleteCard } from '../store/CardStore.js';
import { generateId, createDefaultCharacterData, CharacterStore } from '../store/CharacterStore.js';
import { showConfirm, showAlert } from '../store/dialog.js';
import { getGlobalImageHtml, getImageDataUrl, setGlobalImage } from '../store/ImageCache.js';
import { buildPngWithText, buildJpgWithData } from '../store/CardFileIO.js';
import { parseIdText, parseIdLevel, formatIdText, formatManualText } from '../store/profileAccess.js';

export const id = 'gallerycard';
export const label = '角色卡';
export const icon = '🎴';
export const color = '#7c4dff';

// ---- 卡面渐变池（按 id 哈希取色，稳定） ----
const GRADS = [
    'linear-gradient(135deg,#f8bbd0,#ba68c8)',
    'linear-gradient(135deg,#b3e5fc,#5c6bc0)',
    'linear-gradient(135deg,#ce93d8,#7e57c2)',
    'linear-gradient(135deg,#ffcc80,#ef6c00)',
    'linear-gradient(135deg,#fff9c4,#ffb74d)',
    'linear-gradient(135deg,#ff8a80,#b71c1c)',
    'linear-gradient(135deg,#cfd8dc,#455a64)',
    'linear-gradient(135deg,#d1c4e9,#4527a0)',
    'linear-gradient(135deg,#a5d6a7,#2e7d32)',
    'linear-gradient(135deg,#80deea,#00838f)'
];
function gradOf(id) {
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return GRADS[h % GRADS.length];
}
function parseGradColors(css) {
    const m = css.match(/#[0-9a-fA-F]{6}/g);
    return m && m.length ? m : ['#7c4dff', '#9c27b0'];
}

// ---- 状态 ----
let cards = [];
let loaded = false;
let viewMode = 'gallery';     // gallery | detail | edit
let currentCardId = null;

async function ensureLoaded() {
    if (!loaded) {
        cards = await getAllCards();
        loaded = true;
    }
}

function getCurrentCard() {
    return cards.find(c => c.id === currentCardId) || null;
}

// ---- 工具 ----
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

// ---- 卡面渲染（有图用压缩缓存显示，无图用渐变+emoji） ----
function renderCardFace(c, emojiSize) {
    if (c.cardImage) {
        const html = getGlobalImageHtml(c.cardImage);
        if (html) return html;   // makeImgHtml 自带 object-fit:cover;width/height:100%
    }
    return `<span style="font-size:${emojiSize}px; text-shadow:0 2px 10px rgba(0,0,0,0.18);">${esc(c.emoji || '🎴')}</span>`;
}

// ---- 画廊 ----
function renderGallery() {
    if (cards.length === 0) {
        return `
        <div class="screen-page rc-root">
            <div class="screen-header">
                <div class="screen-title">🎴 角色卡画廊</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content" style="padding:12px 16px 16px; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center;">
                <div style="font-size:56px; margin-bottom:12px;">📭</div>
                <div style="font-size:15px; font-weight:600; color:#555;">还没有角色卡</div>
                <div style="font-size:12px; color:#999; margin-top:4px; line-height:1.6;">
                    请前往 🏪 应用市场 → 角色卡生成器<br>通过 AI 描述或导入文件创建
                </div>
            </div>
        </div>`;
    }

    return `
        <div class="screen-page rc-root">
            <div class="screen-header">
                <div class="screen-title">🎴 角色卡画廊</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content" style="padding:12px 14px 16px;">

                <div style="background:linear-gradient(135deg,#ede7f6,#f3e5f5); border-radius:14px; padding:10px 14px; display:flex; align-items:center; gap:10px;">
                    <span style="font-size:20px;">📇</span>
                    <div style="flex:1;">
                        <div style="font-size:13px; font-weight:700; color:#4a2d7a;">共 ${cards.length} 张角色卡</div>
                        <div style="font-size:11px; color:#9a7fc0; margin-top:1px;">在应用市场生成，点卡片查看详情</div>
                    </div>
                </div>

                <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-top:14px;">
                    ${cards.map(renderCard).join('')}
                </div>
            </div>
        </div>`;
}

function renderCard(c) {
    return `
        <div class="rc-card" data-id="${c.id}" style="
            border-radius:16px; background:#fff;
            box-shadow:0 2px 10px rgba(0,0,0,0.08);
            overflow:hidden; cursor:pointer;
            display:flex; flex-direction:column;
            border:2px solid transparent;
            transition:all 0.2s;
        ">
            <div style="width:100%; aspect-ratio:1/1.05; background:${c.cardImage ? '#fff' : gradOf(c.id)};
                display:flex; align-items:center; justify-content:center; position:relative; flex-shrink:0; overflow:hidden;">
                ${renderCardFace(c, 44)}
                ${c.tag ? `<span style="position:absolute; top:8px; left:8px; background:rgba(255,255,255,0.88); color:#666; font-size:10px; padding:2px 8px; border-radius:10px;">${esc(c.tag)}</span>` : ''}
            </div>
            <div style="padding:9px 10px 11px; text-align:center;">
                <div style="font-size:14px; font-weight:700; color:#333; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(c.name)}</div>
                <div style="font-size:11px; color:#999; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(c.gender)}${c.gender && c.age ? ' · ' : ''}${esc(c.age)}</div>
            </div>
        </div>`;
}

// ---- 详情 ----
function renderDetail(cardId) {
    const c = cards.find(x => x.id === cardId);
    if (!c) return renderGallery();

    return `
        <div class="screen-page rc-root">
            <div class="screen-header">
                <div class="screen-title">${esc(c.name)}</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content" style="padding:12px 16px 16px;">

                <div style="width:100%; aspect-ratio:16/9; border-radius:16px; background:${c.cardImage ? '#fff' : gradOf(c.id)};
                    display:flex; align-items:center; justify-content:center; position:relative; margin-bottom:14px; overflow:hidden;">
                    ${renderCardFace(c, 56)}
                    ${c.tag ? `<span style="position:absolute; top:10px; right:10px; background:rgba(255,255,255,0.9); color:#666; font-size:11px; padding:3px 10px; border-radius:12px;">${esc(c.tag)}</span>` : ''}
                </div>

                <h3 style="text-align:center; margin-bottom:4px;">${esc(c.name)}</h3>
                <p style="text-align:center; color:#999; font-size:12px; margin-bottom:10px;">
                    ${esc(c.gender)}${c.gender && c.age ? ' · ' : ''}${esc(c.age)}
                    ${c.orientation && c.orientation !== '未知' ? ` · ${esc(c.orientation)}` : ''}
                </p>
                ${c.desc ? `<p style="text-align:center; color:#666; font-size:13px; margin-bottom:16px;">${esc(c.desc)}</p>` : ''}

                ${renderField('📖 详细设定', c.detail, '#f3e5f5', '#6a1b9a')}
                ${renderField('🔒 内心秘密', c.secret, '#fff3e0', '#e65100')}
                ${renderField('🗣️ 说话风格', c.style, '#e8f5e9', '#2e7d32')}
                ${renderProfileSection(c)}  
                ${c.firstMessage ? renderField('💬 首条消息', c.firstMessage, '#e0f7fa', '#00695c') : ''}

                <div style="background:#e3f2fd; border-radius:12px; padding:12px; margin-bottom:12px;">
                    <div style="font-weight:600; margin-bottom:8px;">📜 过往记忆</div>
                    ${(c.memories || []).map(m => `
                        <div style="padding:6px 0; border-bottom:1px solid #bbdefb; font-size:13px;">
                            <span style="color:#1565c0; font-size:11px;">${esc(m.time)}</span>
                            <div style="margin-top:2px; color:#333;">${esc(m.content)}</div>
                        </div>`).join('') || '<div style="font-size:13px; color:#888;">暂无记忆</div>'}
                </div>

                <div style="background:#e8eaf6; border-radius:12px; padding:12px; margin-bottom:16px;">
                    <div style="font-weight:600; margin-bottom:8px;">🤝 关系羁绊</div>
                    ${(c.relations || []).map(r => `
                        <div style="padding:6px 0; border-bottom:1px solid #c5cae9; font-size:13px;">
                            <span style="font-weight:600; color:#283593;">${esc(r.name)}</span>
                            <span style="color:#7986cb; font-size:11px; margin-left:6px;">· ${esc(r.relation)}</span>
                            <div style="margin-top:2px; color:#555;">${esc(r.perspective)}</div>
                        </div>`).join('') || '<div style="font-size:13px; color:#888;">暂无关系</div>'}
                </div>

                <!-- 操作 -->
                <button class="rc-action" data-action="to-rolebook" style="width:100%; padding:12px; border-radius:24px; border:none;
                    background:linear-gradient(135deg,#7c4dff,#9c27b0); color:white; cursor:pointer; font-size:15px; font-weight:700;">
                    📖 转入角色名册
                </button>
                <button class="rc-action" data-action="to-network" style="width:100%; padding:11px; border-radius:24px; border:1px solid #7c4dff;
                    background:white; color:#7c4dff; cursor:pointer; font-size:14px; font-weight:600; margin-top:8px;">
                    🌐 转入世界网络
                </button>

                <div style="display:flex; gap:8px; margin-top:10px;">
                    <button class="rc-action" data-action="edit" style="flex:1; padding:11px; border-radius:20px; border:none; background:#ff9800; color:white; cursor:pointer; font-size:13px; font-weight:600;">✏️ 编辑</button>
                    <button class="rc-action" data-action="export-png" style="flex:1; padding:11px; border-radius:20px; border:1px solid #7c4dff; background:white; color:#7c4dff; cursor:pointer; font-size:13px; font-weight:600;">📤 PNG</button>
                    <button class="rc-action" data-action="export-jpg" style="flex:1; padding:11px; border-radius:20px; border:1px solid #ccc; background:white; color:#666; cursor:pointer; font-size:13px; font-weight:600;">🖼️ JPG</button>
                </div>
                <button class="rc-action" data-action="cardface" style="width:100%; padding:10px; border-radius:20px; border:1px solid #7c4dff; background:white; color:#7c4dff; cursor:pointer; font-size:13px; font-weight:600; margin-top:8px;">🎨 设置卡面</button>
                <button class="rc-action" data-action="delete" style="width:100%; padding:10px; border-radius:20px; border:1px solid #e53935; background:white; color:#e53935; cursor:pointer; font-size:13px; font-weight:600; margin-top:8px;">🗑️ 删除这张卡</button>
            </div>
        </div>`;
}

function renderField(title, text, bg, color) {
    return `
        <div style="background:${bg}; border-radius:12px; padding:12px; margin-bottom:12px;">
            <div style="font-weight:600; margin-bottom:4px;">${title}</div>
            <div style="font-size:13px; color:${color}; white-space:pre-wrap;">${esc(text || '无')}</div>
        </div>`;
}

function renderProfileSection(c) {
    const p = c.profile || {};
    const l1Text = p.L1 || '';
    const l2Text = p.L2 || '';
    const l3Text = Object.entries(p.L3 || {}).map(([vid, v]) => `【${vid}】${v}`).join('\n');
    const manualText = Object.entries(p.manual || {}).map(([vid, lv]) => `${vid} → L${lv}`).join('\n');

    if (!l1Text && !l2Text && !l3Text && !manualText) return '';

    return `
        <div style="background:#f3e5f5; border-radius:12px; padding:12px; margin-bottom:12px;">
            <div style="font-weight:600; margin-bottom:4px;">📖 公开信息（分层）</div>
            ${l1Text ? `<div style="font-size:12px; color:#7b1fa2; margin-bottom:2px;">【L1 熟人层】</div><div style="font-size:13px; color:#6a1b9a; white-space:pre-wrap; margin-bottom:8px;">${esc(l1Text)}</div>` : ''}
            ${l2Text ? `<div style="font-size:12px; color:#7b1fa2; margin-bottom:2px;">【L2 密友层】</div><div style="font-size:13px; color:#6a1b9a; white-space:pre-wrap; margin-bottom:8px;">${esc(l2Text)}</div>` : ''}
            ${l3Text ? `<div style="font-size:12px; color:#7b1fa2; margin-bottom:2px;">【L3 专属层】</div><div style="font-size:13px; color:#6a1b9a; white-space:pre-wrap; margin-bottom:8px;">${esc(l3Text)}</div>` : ''}
            ${manualText ? `<div style="font-size:12px; color:#7b1fa2; margin-bottom:2px;">【手动指定】</div><div style="font-size:13px; color:#6a1b9a; white-space:pre-wrap;">${esc(manualText)}</div>` : ''}
        </div>`;
}


// ---- 编辑 ----
function renderEdit(cardId) {
    const c = cards.find(x => x.id === cardId);
    if (!c) return renderGallery();

    const inputStyle = 'width:100%; border:1px solid #ddd; border-radius:8px; padding:7px 10px; font-size:13px; box-sizing:border-box;';

    return `
        <div class="screen-page rc-root">
            <div class="screen-header">
                <div class="screen-title">✏️ 编辑角色卡</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content" style="padding:12px 16px 20px;">

                <!-- 基础 -->
                <div style="display:flex; gap:8px; margin-bottom:10px;">
                    <input id="rc-name" value="${esc(c.name)}" placeholder="名字" style="flex:2; ${inputStyle}" />
                    <input id="rc-emoji" value="${esc(c.emoji || '')}" placeholder="图标" style="flex:0 0 60px; text-align:center; ${inputStyle}" />
                </div>
                <div style="display:flex; gap:8px; margin-bottom:10px;">
                    <input id="rc-gender" value="${esc(c.gender)}" placeholder="性别" style="flex:1; ${inputStyle}" />
                    <input id="rc-age" value="${esc(c.age)}" placeholder="年龄" style="flex:1; ${inputStyle}" />
                    <input id="rc-orientation" value="${esc(c.orientation)}" placeholder="取向" style="flex:1; ${inputStyle}" />
                </div>
                <div style="margin-bottom:10px;">
                    <input id="rc-tag" value="${esc(c.tag)}" placeholder="标签（如：都市 / 异界）" style="${inputStyle}" />
                </div>

                ${renderTextarea('rc-desc', '一句话概括', c.desc)}
                ${renderTextarea('rc-detail', '详细设定（外貌 / 性格 / 背景）', c.detail)}
                ${renderTextarea('rc-secret', '内心秘密', c.secret)}
                ${renderTextarea('rc-style', '说话风格', c.style)}
                ${renderTextarea('rc-first', '首条消息（可选）', c.firstMessage)}
                
                <!-- 公开信息（分层）· 分栏填空 -->
<div style="background:#f3e5f5; border-radius:12px; padding:12px; margin-bottom:12px;">
    <div style="font-weight:600; margin-bottom:8px;">📖 公开信息（分层）</div>

    <!-- L1 熟人层 -->
    <div style="font-size:12px; color:#7b1fa2; margin-bottom:2px;">【L1 熟人层】</div>
    <textarea id="rc-profile-l1" rows="2" placeholder="好友能看到的性格细节……"
        style="width:100%; border:1px solid #ddd; border-radius:8px; padding:8px 10px; font-size:12px; box-sizing:border-box; resize:vertical; margin-bottom:10px;">${esc((c.profile && typeof c.profile.L1 === 'string') ? c.profile.L1 : '')}</textarea>

    <!-- L2 密友层 -->
    <div style="font-size:12px; color:#7b1fa2; margin-bottom:2px;">【L2 密友层】</div>
    <textarea id="rc-profile-l2" rows="2" placeholder="挚友才知道的秘密、弱点……"
        style="width:100%; border:1px solid #ddd; border-radius:8px; padding:8px 10px; font-size:12px; box-sizing:border-box; resize:vertical; margin-bottom:10px;">${esc((c.profile && typeof c.profile.L2 === 'string') ? c.profile.L2 : '')}</textarea>

    <!-- L3 专属层 -->
    <div style="font-size:12px; color:#7b1fa2; margin-bottom:2px;">【L3 专属层】每行：角色ID：内容</div>
    <textarea id="rc-profile-l3" rows="2" placeholder="char_主角：只有TA知道的秘密"
        style="width:100%; border:1px solid #ddd; border-radius:8px; padding:8px 10px; font-size:12px; box-sizing:border-box; resize:vertical; margin-bottom:10px;">${esc(formatIdText((c.profile && c.profile.L3) || {}))}</textarea>

    <!-- 手动指定 -->
    <div style="font-size:12px; color:#7b1fa2; margin-bottom:2px;">【手动指定】每行：角色ID：0/1/2</div>
    <textarea id="rc-profile-manual" rows="2" placeholder="char_法师：2"
        style="width:100%; border:1px solid #ddd; border-radius:8px; padding:8px 10px; font-size:12px; box-sizing:border-box; resize:vertical;">${esc(formatManualText((c.profile && c.profile.manual) || {}))}</textarea>
</div>


                <!-- 记忆编辑 -->
                <div style="background:#e3f2fd; border-radius:12px; padding:12px; margin-bottom:12px;">
                    <div style="font-weight:600; margin-bottom:8px;">📜 过往记忆</div>
                    <div id="rc-mem-list">
                        ${(c.memories || []).map((m, i) => memRow(m, i)).join('')}
                    </div>
                    <button id="rc-add-mem" style="width:100%; padding:8px; border-radius:10px; border:1px dashed #64b5f6; background:white; color:#1565c0; cursor:pointer; font-size:12px; margin-top:6px;">＋ 添加记忆</button>
                </div>

                <!-- 关系编辑 -->
                <div style="background:#e8eaf6; border-radius:12px; padding:12px; margin-bottom:16px;">
                    <div style="font-weight:600; margin-bottom:8px;">🤝 关系羁绊</div>
                    <div id="rc-rel-list">
                        ${(c.relations || []).map((r, i) => relRow(r, i)).join('')}
                    </div>
                    <button id="rc-add-rel" style="width:100%; padding:8px; border-radius:10px; border:1px dashed #7986cb; background:white; color:#283593; cursor:pointer; font-size:12px; margin-top:6px;">＋ 添加关系</button>
                </div>

                <button id="rc-save" style="width:100%; padding:12px; border-radius:24px; border:none; background:linear-gradient(135deg,#7c4dff,#9c27b0); color:white; cursor:pointer; font-size:15px; font-weight:700;">💾 保存修改</button>
                <button id="rc-cancel" style="width:100%; padding:10px; border-radius:20px; border:1px solid #ccc; background:white; color:#666; cursor:pointer; font-size:13px; margin-top:8px;">取消</button>
            </div>
        </div>`;
}

function renderTextarea(id, placeholder, value) {
    return `
        <div style="margin-bottom:10px;">
            <textarea id="${id}" placeholder="${placeholder}" rows="3" style="width:100%; border:1px solid #ddd; border-radius:8px; padding:8px 10px; font-size:13px; box-sizing:border-box; resize:vertical;">${esc(value || '')}</textarea>
        </div>`;
}

function memRow(m, i) {
    return `
        <div class="rc-mem-row" style="display:flex; gap:6px; margin-bottom:6px;">
            <input class="rc-mem-time" value="${esc(m.time || '')}" placeholder="时间" style="flex:0 0 76px; border:1px solid #ddd; border-radius:8px; padding:6px 8px; font-size:12px;" />
            <input class="rc-mem-content" value="${esc(m.content || '')}" placeholder="记忆内容" style="flex:1; border:1px solid #ddd; border-radius:8px; padding:6px 8px; font-size:12px;" />
            <button type="button" class="rc-row-del" style="flex-shrink:0; width:28px; border:none; border-radius:8px; background:#ffebee; color:#c62828; cursor:pointer;">✕</button>
        </div>`;
}

function relRow(r, i) {
    return `
        <div class="rc-rel-row" style="display:flex; gap:6px; margin-bottom:6px;">
            <input class="rc-rel-name" value="${esc(r.name || '')}" placeholder="对象" style="flex:0 0 70px; border:1px solid #ddd; border-radius:8px; padding:6px 8px; font-size:12px;" />
            <input class="rc-rel-relation" value="${esc(r.relation || '')}" placeholder="关系" style="flex:0 0 64px; border:1px solid #ddd; border-radius:8px; padding:6px 8px; font-size:12px;" />
            <input class="rc-rel-perspective" value="${esc(r.perspective || '')}" placeholder="描述（背景故事）" style="flex:1; border:1px solid #ddd; border-radius:8px; padding:6px 8px; font-size:12px;" />
            <button type="button" class="rc-row-del" style="flex-shrink:0; width:28px; border:none; border-radius:8px; background:#ffebee; color:#c62828; cursor:pointer;">✕</button>
        </div>`;
}

// ---- 导出 ----
function cardToCharaV2(card) {
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: card.name,
            description: card.detail || card.desc,
            personality: '',
            scenario: '',
            first_mes: card.firstMessage || '',
            mes_example: '',
            creator: '',
            character_version: '',
            tags: card.tag ? [card.tag] : [],
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: [],
            extras: {
                roleCard: true,
                memories: card.memories || [],
                relations: card.relations || []
            }
        }
    };
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片加载失败'));
        img.src = src;
    });
}

function drawCardFace(card, size = 512) {
    const canvas = document.createElement('canvas');
    const h = Math.round(size * 1.05);
    canvas.width = size;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    // 渐变背景（与 CSS 显示一致）
    const colors = parseGradColors(gradOf(card.id));
    const g = ctx.createLinearGradient(0, 0, size, h);
    g.addColorStop(0, colors[0]);
    g.addColorStop(1, colors[1] || colors[0]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, h);

    // emoji 居中
    ctx.font = `${Math.round(size * 0.42)}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(card.emoji || '🎴', size / 2, h * 0.42);

    // 名字底部
    ctx.font = `bold ${Math.round(size * 0.07)}px sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fillText(card.name, size / 2, h * 0.86);

    return canvas;
}

async function getCardFaceCanvas(card) {
    // 有卡面图 → 用原图；无图 → canvas 画
    if (card.cardImage) {
        const dataUrl = await getImageDataUrl(card.cardImage);
        if (dataUrl) {
            const img = await loadImage(dataUrl);
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext('2d').drawImage(img, 0, 0);
            return canvas;
        }
    }
    return drawCardFace(card);
}

async function exportCardImage(card, format) {
    try {
        const charaObj = cardToCharaV2(card);
        const canvas = await getCardFaceCanvas(card);

        // ★ JPG 不支持透明：先铺白底再画
        let outCanvas = canvas;
        if (format === 'jpg') {
            outCanvas = document.createElement('canvas');
            outCanvas.width = canvas.width;
            outCanvas.height = canvas.height;
            const ctx = outCanvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, outCanvas.width, outCanvas.height);
            ctx.drawImage(canvas, 0, 0);
        }

        const blob = await new Promise(resolve => {
            outCanvas.toBlob(b => resolve(b), format === 'png' ? 'image/png' : 'image/jpeg', 0.92);
        });
        if (!blob) throw new Error('图片生成失败');

        const finalBlob = format === 'png'
            ? await buildPngWithText(blob, 'chara', charaObj)
            : await buildJpgWithData(blob, charaObj);

        const url = URL.createObjectURL(finalBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${card.name}.${format}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);

        showToast(`✅ 已导出 ${card.name}.${format}`, '#2e7d32');
    } catch (e) {
        showToast(`❌ 导出失败：${e.message}`, '#c62828');
    }
}

// ---- 收集相册里所有图片 key（去重） ----
function getGalleryImageKeys() {
    try {
        const albums = JSON.parse(localStorage.getItem('gallery_albums') || '[]');
        const keys = [];
        albums.forEach(a => (a.images || []).forEach(k => {
            if (!keys.includes(k)) keys.push(k);
        }));
        return keys;
    } catch { return []; }
}

// ---- 设置卡面弹窗 ----
function showCardImagePicker(card, container) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:999;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
        <div style="background:white;border-radius:20px;width:300px;max-height:80vh;display:flex;flex-direction:column;overflow:hidden;">
            <div style="padding:14px 16px;font-weight:600;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;">
                <span>🎨 设置卡面</span>
                <button id="rc-img-close" style="border:none;background:none;font-size:18px;cursor:pointer;color:#999;">✕</button>
            </div>
            <div style="padding:12px 16px;overflow-y:auto;flex:1;">
                <input type="file" id="rc-img-file" accept="image/*" style="display:none;" />
                <button id="rc-img-upload" style="width:100%;padding:10px;border-radius:12px;border:1px dashed #7c4dff;background:white;color:#7c4dff;cursor:pointer;font-size:13px;font-weight:600;margin-bottom:12px;">📤 上传新图片</button>
                <div style="font-size:12px;color:#888;margin-bottom:6px;">从相册选择（引用，不复制）</div>
                <div id="rc-img-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">
                    ${getGalleryImageKeys().map(key => `
                        <div class="rc-img-opt" data-key="${key}" style="aspect-ratio:1;border-radius:8px;overflow:hidden;cursor:pointer;border:2px solid transparent;background:#f0f0f4;">
                            ${getGlobalImageHtml(key) || '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#bbb;font-size:20px;">🖼️</div>'}
                        </div>`).join('') || '<div style="font-size:12px;color:#bbb;text-align:center;padding:20px;">相册暂无图片</div>'}
                </div>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('#rc-img-close').onclick = close;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    // 从相册选：引用已有 key，不复制
    overlay.querySelectorAll('.rc-img-opt').forEach(opt => {
        opt.addEventListener('click', async () => {
            await updateCard(card.id, { cardImage: opt.dataset.key });
            close();
            cards = await getAllCards();
            rerender(container);
        });
    });

    // 上传新图：存公共池 + 进形象卡相册 + 绑定
    overlay.querySelector('#rc-img-upload').onclick = () => overlay.querySelector('#rc-img-file').click();
    overlay.querySelector('#rc-img-file').addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const key = `gallery_card_${card.id}_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
        await setGlobalImage(key, file);
        addToPortraitAlbum(key);   // 与导入一致，进形象卡相册
        await updateCard(card.id, { cardImage: key });
        close();
        cards = await getAllCards();
        rerender(container);
    });
}

// ---- 归入形象卡相册（本地小函数） ----
function addToPortraitAlbum(key) {
    try {
        const albums = JSON.parse(localStorage.getItem('gallery_albums') || '[]');
        const album = albums.find(a => a.id === 'album_portrait');
        if (album && !album.images.includes(key)) {
            album.images.push(key);
            localStorage.setItem('gallery_albums', JSON.stringify(albums));
        }
    } catch { }
}

// ---- 渲染入口 ----
export function render() {
    if (viewMode === 'detail' && currentCardId) return renderDetail(currentCardId);
    if (viewMode === 'edit' && currentCardId) return renderEdit(currentCardId);
    return renderGallery();
}

// ---- 事件绑定 ----
export function bindEvents(container) {
    const appContainer = container.closest('.page-container') || container;
    if (!loaded) {
        ensureLoaded().then(() => {
            appContainer.innerHTML = render();
            bindEvents(appContainer);
        });
        return;
    }
    bindCurrentView(appContainer);
}

function bindCurrentView(container) {
    if (viewMode === 'detail') { bindDetailEvents(container); return; }
    if (viewMode === 'edit') { bindEditEvents(container); return; }
    bindGalleryEvents(container);
}

function bindGalleryEvents(container) {
    container.querySelectorAll('.rc-card').forEach(card => {
        card.addEventListener('click', () => {
            currentCardId = card.dataset.id;
            viewMode = 'detail';
            rerender(container);
        });
    });
}

function bindDetailEvents(container) {
    container.querySelectorAll('.rc-action').forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.dataset.action;
            const card = getCurrentCard();
            if (!card) return;

            if (action === 'edit') { viewMode = 'edit'; rerender(container); }
            else if (action === 'export-png') { exportCardImage(card, 'png'); }
            else if (action === 'export-jpg') { exportCardImage(card, 'jpg'); }
            else if (action === 'delete') { handleDelete(card, container); }
            else if (action === 'to-rolebook') { handleConvert(card, 'rolebook', container); }
            else if (action === 'to-network') { handleConvert(card, 'network', container); }
            else if (action === 'cardface') { showCardImagePicker(card, container); }
        });
    });
}

async function handleDelete(card, container) {
    const ok = await showConfirm(`确定删除角色卡「${card.name}」吗？删除后不可恢复。`);
    if (!ok) return;
    await deleteCard(card.id);
    cards = await getAllCards();
    viewMode = 'gallery';
    currentCardId = null;
    rerender(container);
}

async function handleConvert(card, target, container) {
    const targetName = target === 'rolebook' ? '角色名册' : '世界网络';
    const ok = await showConfirm(`将「${card.name}」转入${targetName}？\n将复制全部设定（含记忆与关系），角色卡本身保留。`);
    if (!ok) return;

    const id = generateId();
    const charData = createDefaultCharacterData(id, {
        name: card.name,
        desc: card.desc,
        detail: card.detail,
        gender: card.gender,
        age: card.age,
        orientation: card.orientation,
        secret: card.secret,
        style: card.style,
        memories: card.memories || []
    }, target === 'rolebook' ? 'character' : 'npc',
        target === 'rolebook'
            ? { switchable: true }
            : { convertible: true, customizable: true });

    // 写入目标存储
    if (target === 'rolebook') {
        const chars = JSON.parse(localStorage.getItem('rolebook_characters') || '[]');
        chars.push(charData);
        localStorage.setItem('rolebook_characters', JSON.stringify(chars));
    } else {
        const npcs = JSON.parse(localStorage.getItem('worldnet_extra_characters') || '[]');
        npcs.push(charData);
        localStorage.setItem('worldnet_extra_characters', JSON.stringify(npcs));
    }

    // CharacterStore：info + 描述性关系（不绑定联系人 id）
    const store = new CharacterStore(id);
    store.setInfo({
        name: card.name,
        emoji: card.emoji || '❓',
        desc: card.desc || '',
        type: target === 'rolebook' ? 'character' : 'npc',
        label: ''
    });
    if (card.relations && card.relations.length) {
        store.setRelations(card.relations.map(r => ({
            name: r.name, relation: r.relation, perspective: r.perspective, id: ''
        })));
    }
    // ★ 同步分层公开信息到 char_<id>（卡片带 profile 才生效，没有则跳过）
    try {
        store.setProfile(card.profile || {});
    } catch (e) { /* 忽略 */ }


    showAlert(`✅ 「${card.name}」已转入${targetName}`);
}

function bindEditEvents(container) {
    container.querySelector('#rc-add-mem')?.addEventListener('click', () => {
        const list = container.querySelector('#rc-mem-list');
        list.insertAdjacentHTML('beforeend', memRow({ time: '', content: '' }, 0));
    });
    container.querySelector('#rc-add-rel')?.addEventListener('click', () => {
        const list = container.querySelector('#rc-rel-list');
        list.insertAdjacentHTML('beforeend', relRow({ name: '', relation: '', perspective: '' }, 0));
    });

    container.querySelectorAll('.rc-row-del').forEach(btn => {
        btn.addEventListener('click', () => btn.closest('.rc-mem-row, .rc-rel-row').remove());
    });

    container.querySelector('#rc-save')?.addEventListener('click', async () => {
        const val = id => (container.querySelector('#' + id)?.value || '').trim();

        const memories = [];
        container.querySelectorAll('.rc-mem-row').forEach(row => {
            const content = row.querySelector('.rc-mem-content').value.trim();
            if (content) memories.push({ time: row.querySelector('.rc-mem-time').value.trim() || '未知时间', content });
        });

        const relations = [];
        container.querySelectorAll('.rc-rel-row').forEach(row => {
            const name = row.querySelector('.rc-rel-name').value.trim();
            if (name) relations.push({
                name,
                relation: row.querySelector('.rc-rel-relation').value.trim(),
                perspective: row.querySelector('.rc-rel-perspective').value.trim()
            });
        });

        await updateCard(currentCardId, {
            name: val('rc-name') || '未命名角色卡',
            emoji: val('rc-emoji') || '🎴',
            gender: val('rc-gender') || '未知',
            age: val('rc-age') || '未知',
            orientation: val('rc-orientation') || '未知',
            tag: val('rc-tag'),
            desc: val('rc-desc'),
            detail: val('rc-detail'),
            secret: val('rc-secret'),
            style: val('rc-style'),
            firstMessage: val('rc-first'),
            memories,
            relations,
            profile: {
                L1: val('rc-profile-l1'),
                L2: val('rc-profile-l2'),
                L3: parseIdText(val('rc-profile-l3')),
                manual: parseIdLevel(val('rc-profile-manual'))
            }

        });

        cards = await getAllCards();
        viewMode = 'detail';
        rerender(container);
        showToast('✅ 已保存', '#2e7d32');
    });

    container.querySelector('#rc-cancel')?.addEventListener('click', () => {
        viewMode = 'detail';
        rerender(container);
    });
}

// ---- 返回处理 ----
export function handleBack(container) {
    if (viewMode === 'edit') { viewMode = 'detail'; rerender(container); return true; }
    if (viewMode === 'detail') { viewMode = 'gallery'; currentCardId = null; rerender(container); return true; }
    return false;
}

// ---- 监听外部卡片变化（生成器后台生成完成时刷新） ----
if (!window.__cardsListenerBound) {
    window.__cardsListenerBound = true;
    window.addEventListener(CARDS_CHANGED_EVENT, async () => {
        cards = await getAllCards();
        const appContainer = document.querySelector('.page-container');
        if (appContainer && appContainer.querySelector('.rc-root')) {
            appContainer.innerHTML = render();
            bindEvents(appContainer);
        }
    });
}

// ---- 监听图片异步加载完成（卡面图首次显示需要重渲染） ----
if (!window.__cardsImgListenerBound) {
    window.__cardsImgListenerBound = true;
    window.addEventListener('image-loaded', () => {
        const appContainer = document.querySelector('.page-container');
        // 画廊前台且不在编辑态才刷新（编辑态刷新会丢输入）
        if (appContainer && appContainer.querySelector('.rc-root') && viewMode !== 'edit') {
            appContainer.innerHTML = render();
            bindEvents(appContainer);
        }
    });
}

// ---- 注册模块（入口暂留首页，功能完善后再议） ----
if (!window.__moduleRegistry) window.__moduleRegistry = [];
window.__moduleRegistry.push({ id, label, icon, color, render, bindEvents, handleBack });

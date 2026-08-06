// apps/chat/ifBranch.js — 平行剧情（if线）功能
// 模式一：narrative 叙述模式（用户提示词 + AI 生成剧情）
// 模式二：dialogue  对话模式（A/B 双角色剧情，用户轮流扮演当前主视角，AI 推进剧情）
// 创建时可选择注入：两人关系 / 好友圈 / 记忆 / 世界书
// 可单独选择 API 预设（优先于默认配置）
import { esc } from '../../store/utils.js';

const STORAGE_KEY = 'if_branches';
const PRESET_KEY = 'if_branches_api_preset';

// ============================================================
//  数据层
// ============================================================

function loadAll() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
    catch { return {}; }
}
function saveAll(data) { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
function genId() { return 'ifb_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4); }

export function getBranches(pairKey) {
    return loadAll()[pairKey]?.branches || [];
}
export function getBranch(pairKey, branchId) {
    return getBranches(pairKey).find(b => b.id === branchId) || null;
}

export function createBranch(pairKey, { name, description = '', mode = 'narrative', charA = '我', charB = '对方', charAId = '', charBId = '', inject = { relation: true, friends: true, memories: true, worldbook: [] } }) {
    const all = loadAll();
    if (!all[pairKey]) all[pairKey] = { branches: [] };
    const branch = {
        id: genId(),
        name: name.trim(),
        description: description.trim(),
        mode,
        charA, charB, charAId, charBId,
        inject,
        content: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    all[pairKey].branches.push(branch);
    saveAll(all);
    return branch;
}

export function updateBranch(pairKey, branchId, updates) {
    const all = loadAll();
    const branches = all[pairKey]?.branches;
    if (!branches) return null;
    const idx = branches.findIndex(b => b.id === branchId);
    if (idx < 0) return null;
    branches[idx] = { ...branches[idx], ...updates, updatedAt: Date.now() };
    saveAll(all);
    return branches[idx];
}

export function deleteBranch(pairKey, branchId) {
    const all = loadAll();
    const branches = all[pairKey]?.branches;
    if (!branches) return;
    all[pairKey].branches = branches.filter(b => b.id !== branchId);
    saveAll(all);
}

export function addContent(pairKey, branchId, block) {
    const branch = getBranch(pairKey, branchId);
    if (!branch) return null;
    return updateBranch(pairKey, branchId, {
        content: [...branch.content, { ...block, timestamp: Date.now() }]
    });
}

function getCurrentPresetId() {
    return localStorage.getItem(PRESET_KEY) || '';
}

// ============================================================
//  入口
// ============================================================

export function showIfBranchViewer(pairKey, context) {
    const overlay = document.createElement('div');
    overlay.className = 'ifb-overlay';
    overlay.style.cssText = `
        position:absolute; top:0; left:0; right:0; bottom:0; z-index:300;
        background:#faf8f5; display:flex; flex-direction:column; overflow:hidden;
    `;
    const phoneScreen = document.querySelector('.phone-screen') || document.body;
    phoneScreen.appendChild(overlay);
    renderList(overlay, pairKey, context);
}

// ============================================================
//  列表页
// ============================================================

function renderList(overlay, pairKey, context) {
    const branches = getBranches(pairKey);

    overlay.innerHTML = `
        <div style="display:flex; flex-direction:column; height:100%; overflow:hidden; background:#faf8f5;">
            <div style="
                padding:16px 20px 12px; border-bottom:1px solid #e8e4de;
                display:flex; align-items:center; justify-content:space-between; flex-shrink:0;
            ">
                <div style="font-size:17px; font-weight:600; color:#2c2c2c; letter-spacing:0.5px;">平行剧情</div>
                <div style="display:flex; gap:8px;">
                    <button class="ifb-preset-btn" style="
                        padding:6px 14px; border-radius:16px; border:1px solid #ddd;
                        background:white; color:#666; cursor:pointer; font-size:13px;
                    ">⚙ 预设</button>
                    <button class="ifb-create-btn" style="
                        padding:6px 14px; border-radius:16px; border:none;
                        background:#2c2c2c; color:white; cursor:pointer; font-size:13px;
                    ">＋ 新建</button>
                    <button class="ifb-close-btn" style="
                        padding:6px 10px; border-radius:16px; border:none;
                        background:transparent; color:#888; cursor:pointer; font-size:20px;
                    ">✕</button>
                </div>
            </div>
            <div style="flex:1; overflow-y:auto; padding:12px 16px;">
                ${branches.length === 0 ? `
                    <div style="text-align:center; padding:80px 30px; color:#999; font-size:15px; line-height:2;">
                        还没有平行剧情<br>
                        <span style="font-size:13px; color:#bbb;">点击上方「新建」开始你的第一条 if 线</span>
                    </div>
                ` : branches.map(b => `
                    <div class="ifb-branch-card" data-branch-id="${b.id}" style="
                        padding:16px; margin-bottom:10px; border-radius:12px;
                        background:white; cursor:pointer;
                        box-shadow:0 1px 4px rgba(0,0,0,0.06); border:1px solid #ede8e2;
                    ">
                        <div style="font-size:16px; font-weight:500; color:#2c2c2c; margin-bottom:4px;">
                            ${esc(b.name)}
                            <span style="font-size:11px; color:#999; margin-left:8px; border:1px solid #e0dcd6; border-radius:8px; padding:1px 6px;">
                                ${b.mode === 'dialogue' ? '对话' : '叙述'}
                            </span>
                        </div>
                        ${b.description ? `<div style="font-size:13px; color:#888; line-height:1.6; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">${esc(b.description)}</div>` : ''}
                        <div style="font-size:11px; color:#bbb; margin-top:8px;">${formatDate(b.updatedAt)} · ${b.content.length} 段</div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;

    overlay.querySelector('.ifb-close-btn').onclick = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('.ifb-create-btn').onclick = () => showCreateDialog(overlay, pairKey, context);
    overlay.querySelector('.ifb-preset-btn').onclick = () => showPresetDialog(overlay, pairKey, context);
    overlay.querySelectorAll('.ifb-branch-card').forEach(card => {
        card.onclick = () => renderDetail(overlay, pairKey, card.dataset.branchId, context);
    });
}

// ============================================================
//  API 预设选择
// ============================================================

function showPresetDialog(overlay, pairKey, context) {
    const panel = overlay.querySelector('div');
    const currentId = getCurrentPresetId();

    panel.innerHTML = `
        <div style="display:flex; flex-direction:column; height:100%; overflow:hidden; background:#faf8f5;">
            <div style="padding:16px 20px 12px; border-bottom:1px solid #e8e4de; display:flex; align-items:center; gap:10px; flex-shrink:0;">
                <button class="ifb-back-btn" style="background:none; border:none; cursor:pointer; font-size:18px; color:#888; padding:4px;">←</button>
                <div style="font-size:17px; font-weight:600; color:#2c2c2c;">API 预设</div>
            </div>
            <div style="flex:1; overflow-y:auto; padding:16px 20px;">
                <div style="font-size:12px; color:#888; line-height:1.6; margin-bottom:14px;">
                    选择生成剧情时使用的 API 预设。留空则使用默认配置。
                </div>
                <div class="ifb-preset-option" data-id="" style="
                    padding:12px 14px; border-radius:12px; margin-bottom:8px; cursor:pointer;
                    border:2px solid ${currentId === '' ? '#2c2c2c' : '#e0dcd6'};
                    background:${currentId === '' ? '#f3f1ed' : 'white'};
                ">
                    <div style="font-size:14px; font-weight:500; color:#2c2c2c;">默认配置</div>
                    <div style="font-size:12px; color:#888; margin-top:2px;">使用设置中的默认 API 预设</div>
                </div>
                <div id="ifbPresetList"></div>
            </div>
        </div>
    `;

    import('../aiService.js').then(({ getPresets }) => {
        const presets = getPresets();
        const listEl = panel.querySelector('#ifbPresetList');
        if (presets.length === 0) {
            listEl.innerHTML = '<div style="font-size:12px; color:#bbb; padding:8px 0;">暂无可用预设，请先在设置中添加</div>';
            return;
        }
        listEl.innerHTML = presets.map(p => `
            <div class="ifb-preset-option" data-id="${p.id}" style="
                padding:12px 14px; border-radius:12px; margin-bottom:8px; cursor:pointer;
                border:2px solid ${currentId === p.id ? '#2c2c2c' : '#e0dcd6'};
                background:${currentId === p.id ? '#f3f1ed' : 'white'};
            ">
                <div style="font-size:14px; font-weight:500; color:#2c2c2c;">
                    ${esc(p.name)}${p.isDefault ? '（默认）' : ''}
                </div>
                <div style="font-size:12px; color:#888; margin-top:2px;">${esc(p.model)}</div>
            </div>
        `).join('');

        panel.querySelectorAll('.ifb-preset-option').forEach(opt => {
            opt.onclick = () => {
                localStorage.setItem(PRESET_KEY, opt.dataset.id);
                renderList(overlay, pairKey, context);
            };
        });
    });

    panel.querySelector('.ifb-back-btn').onclick = () => renderList(overlay, pairKey, context);
}

// ============================================================
//  新建对话框（模式选择 + 注入选项 + 世界书）
// ============================================================

function showCreateDialog(overlay, pairKey, context) {
    const panel = overlay.querySelector('div');
    panel.innerHTML = `
        <div style="display:flex; flex-direction:column; height:100%; overflow:hidden; background:#faf8f5;">
            <div style="padding:16px 20px 12px; border-bottom:1px solid #e8e4de; display:flex; align-items:center; gap:10px; flex-shrink:0;">
                <button class="ifb-back-btn" style="background:none; border:none; cursor:pointer; font-size:18px; color:#888; padding:4px;">←</button>
                <div style="font-size:17px; font-weight:600; color:#2c2c2c;">新建平行剧情</div>
            </div>
            <div style="flex:1; overflow-y:auto; padding:20px;">
                <!-- 模式选择 -->
                <div style="margin-bottom:18px;">
                    <label style="font-size:13px; color:#666; display:block; margin-bottom:6px;">模式</label>
                    <div style="display:flex; gap:10px;">
                        <div class="ifb-mode-option" data-mode="narrative" style="
                            flex:1; border:2px solid #2c2c2c; border-radius:12px; padding:12px;
                            cursor:pointer; background:#2c2c2c; color:white;
                        ">
                            <div style="font-size:14px; font-weight:600; margin-bottom:4px;">叙述模式</div>
                            <div style="font-size:12px; opacity:0.7; line-height:1.5;">你写提示词（可不写），AI 生成下一段剧情</div>
                        </div>
                        <div class="ifb-mode-option" data-mode="dialogue" style="
                            flex:1; border:2px solid #e0dcd6; border-radius:12px; padding:12px;
                            cursor:pointer; background:white; color:#333;
                        ">
                            <div style="font-size:14px; font-weight:600; margin-bottom:4px;">对话模式</div>
                            <div style="font-size:12px; color:#888; line-height:1.5;">你和 AI 共同演绎 ${esc(getOtherName(context))} 与你的剧情</div>
                        </div>
                    </div>
                </div>

                <!-- 注入选项 -->
                <div style="margin-bottom:18px;">
                    <label style="font-size:13px; color:#666; display:block; margin-bottom:6px;">注入角色背景（可多选，不局限于两人之间）</label>
                    <div style="border:1px solid #e0dcd6; border-radius:12px; background:white; overflow:hidden;">
                        <div class="ifb-inj-item" data-inj="relation" style="display:flex; align-items:center; justify-content:space-between; padding:12px 14px; border-bottom:1px solid #f0ece6; cursor:pointer;">
                            <div>
                                <div style="font-size:14px; font-weight:500; color:#2c2c2c;">两人之间的关系</div>
                                <div style="font-size:12px; color:#888; margin-top:2px;">相互对彼此的认知、态度</div>
                            </div>
                            <span class="ifb-inj-check" style="font-size:18px; color:#2c2c2c;">✓</span>
                        </div>
                        <div class="ifb-inj-item" data-inj="friends" style="display:flex; align-items:center; justify-content:space-between; padding:12px 14px; border-bottom:1px solid #f0ece6; cursor:pointer;">
                            <div>
                                <div style="font-size:14px; font-weight:500; color:#2c2c2c;">好友圈与态度</div>
                                <div style="font-size:12px; color:#888; margin-top:2px;">各自与其他角色的关系网</div>
                            </div>
                            <span class="ifb-inj-check" style="font-size:18px; color:#2c2c2c;">✓</span>
                        </div>
                        <div class="ifb-inj-item" data-inj="memories" style="display:flex; align-items:center; justify-content:space-between; padding:12px 14px; border-bottom:1px solid #f0ece6; cursor:pointer;">
                            <div>
                                <div style="font-size:14px; font-weight:500; color:#2c2c2c;">重要记忆与时间线</div>
                                <div style="font-size:12px; color:#888; margin-top:2px;">长期记忆与经历</div>
                            </div>
                            <span class="ifb-inj-check" style="font-size:18px; color:#2c2c2c;">✓</span>
                        </div>
                        <div class="ifb-inj-item" data-inj="worldbook" style="padding:12px 14px; cursor:pointer;">
                            <div style="display:flex; align-items:center; justify-content:space-between;">
                                <div>
                                    <div style="font-size:14px; font-weight:500; color:#2c2c2c;">世界书</div>
                                    <div style="font-size:12px; color:#888; margin-top:2px;">选择世界观设定条目</div>
                                </div>
                                <span class="ifb-inj-check" style="font-size:18px; color:#2c2c2c;">✓</span>
                            </div>
                            <div class="ifb-worldbook-list" style="display:none; margin-top:10px; border-top:1px solid #f0ece6; padding-top:10px;"></div>
                        </div>
                    </div>
                </div>

                <!-- 标题 -->
                <div style="margin-bottom:18px;">
                    <label style="font-size:13px; color:#666; display:block; margin-bottom:6px;">标题</label>
                    <input type="text" id="ifbName" placeholder="给这条 if 线取个名字"
                        style="width:100%; border:1px solid #ddd; border-radius:10px; padding:12px 14px; font-size:15px; box-sizing:border-box; background:white;">
                </div>

                <!-- 简介 -->
                <div style="margin-bottom:16px;">
                    <label style="font-size:13px; color:#666; display:block; margin-bottom:6px;">简介（可选）</label>
                    <textarea id="ifbDesc" rows="3" placeholder="简单描述这条剧情线的走向……"
                        style="width:100%; border:1px solid #ddd; border-radius:10px; padding:12px 14px; font-size:14px; box-sizing:border-box; resize:vertical; font-family:inherit; background:white; line-height:1.6;"></textarea>
                </div>
            </div>
            <div style="padding:12px 20px 20px; border-top:1px solid #f0ece6; display:flex; gap:10px; flex-shrink:0;">
                <button class="ifb-cancel-btn" style="flex:1; padding:12px; border-radius:14px; border:1px solid #ddd; background:white; color:#666; cursor:pointer; font-size:14px;">取消</button>
                <button class="ifb-confirm-btn" style="flex:1; padding:12px; border-radius:14px; border:none; background:#2c2c2c; color:white; cursor:pointer; font-size:14px; font-weight:500;">创建</button>
            </div>
        </div>
    `;

    let selectedMode = 'narrative';
    const injectState = { relation: true, friends: true, memories: true, worldbook: [] };

    panel.querySelectorAll('.ifb-mode-option').forEach(opt => {
        opt.onclick = () => {
            selectedMode = opt.dataset.mode;
            panel.querySelectorAll('.ifb-mode-option').forEach(o => {
                const active = o === opt;
                o.style.borderColor = active ? '#2c2c2c' : '#e0dcd6';
                o.style.background = active ? '#2c2c2c' : 'white';
                o.style.color = active ? 'white' : '#333';
            });
        };
    });

    panel.querySelectorAll('.ifb-inj-item[data-inj]').forEach(item => {
        item.onclick = (e) => {
            if (item.dataset.inj === 'worldbook') {
                const list = item.querySelector('.ifb-worldbook-list');
                list.style.display = list.style.display === 'none' ? '' : 'none';
                if (list.style.display !== 'none') renderWorldbookList(list);
                return;
            }
            const key = item.dataset.inj;
            injectState[key] = !injectState[key];
            const check = item.querySelector('.ifb-inj-check');
            check.textContent = injectState[key] ? '✓' : '○';
            check.style.color = injectState[key] ? '#2c2c2c' : '#ccc';
        };
    });

    function renderWorldbookList(container) {
        let entries = [];
        try {
            const saved = localStorage.getItem('worldbook_entries');
            if (saved) entries = JSON.parse(saved).filter(e => e.enabled !== false);
        } catch { }
        if (entries.length === 0) {
            container.innerHTML = '<div style="font-size:12px; color:#bbb; padding:4px 0;">暂无可用世界书条目</div>';
            return;
        }
        container.innerHTML = entries.map(e => {
            const id = e.id || e.title;
            const checked = injectState.worldbook.includes(id);
            return `
                <div class="ifb-wb-item" data-wb-id="${esc(id)}" style="display:flex; align-items:center; gap:8px; padding:8px 4px; cursor:pointer;">
                    <span style="font-size:16px; color:${checked ? '#2c2c2c' : '#ccc'};">${checked ? '✓' : '○'}</span>
                    <span style="font-size:13px; color:#333;">${esc(e.title)}</span>
                </div>
            `;
        }).join('');

        container.querySelectorAll('.ifb-wb-item').forEach(wb => {
            wb.onclick = () => {
                const id = wb.dataset.wbId;
                const idx = injectState.worldbook.indexOf(id);
                if (idx >= 0) injectState.worldbook.splice(idx, 1);
                else injectState.worldbook.push(id);
                renderWorldbookList(container);
            };
        });
    }

    panel.querySelector('.ifb-back-btn').onclick = () => renderList(overlay, pairKey, context);
    panel.querySelector('.ifb-cancel-btn').onclick = () => renderList(overlay, pairKey, context);
    panel.querySelector('.ifb-confirm-btn').onclick = async () => {
        const name = document.getElementById('ifbName').value.trim();
        if (!name) {
            const { showAlert } = await import('../../store/dialog.js');
            showAlert('请输入标题');
            return;
        }
        const desc = document.getElementById('ifbDesc').value.trim();
        createBranch(pairKey, {
            name,
            description: desc,
            mode: selectedMode,
            charA: getActiveName(context),
            charB: getOtherName(context),
            charAId: context?.activeId || '',
            charBId: context?.otherId || '',
            inject: { ...injectState }
        });
        renderList(overlay, pairKey, context);
    };
}

// ============================================================
//  详情页（两种模式）
// ============================================================

function renderDetail(overlay, pairKey, branchId, context) {
    const branch = getBranch(pairKey, branchId);
    if (!branch) { renderList(overlay, pairKey, context); return; }
    const isDialogue = branch.mode === 'dialogue';
    const panel = overlay.querySelector('div');

    panel.innerHTML = `
        <div style="display:flex; flex-direction:column; height:100%; overflow:hidden; background:#faf8f5;">
            <div style="padding:14px 16px 10px; border-bottom:1px solid #e8e4de; display:flex; align-items:center; gap:10px; flex-shrink:0;">
                <button class="ifb-back-btn" style="background:none; border:none; cursor:pointer; font-size:18px; color:#888; padding:4px;">←</button>
                <div style="flex:1; min-width:0;">
                    <div style="font-size:16px; font-weight:600; color:#2c2c2c; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                        ${esc(branch.name)}
                        <span style="font-size:11px; color:#999; margin-left:8px; border:1px solid #e0dcd6; border-radius:8px; padding:1px 6px;">${isDialogue ? '对话' : '叙述'}</span>
                    </div>
                    ${branch.description ? `<div style="font-size:12px; color:#888; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(branch.description)}</div>` : ''}
                </div>
                <button class="ifb-delete-btn" style="background:none; border:none; cursor:pointer; font-size:13px; color:#c0392b; padding:4px; opacity:0.5;">删除</button>
            </div>
            <div class="ifb-story" style="flex:1; overflow-y:auto; padding:20px 24px 40px;">
                ${branch.content.length === 0 ? `
                    <div style="text-align:center; padding:80px 20px; color:#ccc; font-size:14px; line-height:1.8;">
                        ${isDialogue
                            ? `以 <b>${esc(branch.charA)}</b> 的身份开始这段剧情吧`
                            : '在下方写下提示词，或直接让 AI 开启剧情'}
                    </div>
                ` : branch.content.map(block => renderBlock(block)).join('')}
            </div>
            <div style="padding:12px 16px 16px; border-top:1px solid #e8e4de; flex-shrink:0; background:#faf8f5;">
                <textarea class="ifb-input" rows="3" placeholder="${isDialogue ? `以 ${esc(getActiveName(context))} 的身份发言…（可含动作/环境描写）` : '写下提示词（可不写，AI 会自动推进）…'}"
                    style="width:100%; border:1px solid #ddd; border-radius:10px; padding:10px 12px; font-size:14px; box-sizing:border-box; resize:none; font-family:inherit; background:white; line-height:1.6;"></textarea>
                <div style="display:flex; gap:8px; margin-top:8px;">
                    <button class="ifb-send-btn" style="
                        flex:1; padding:10px; border-radius:14px; border:none;
                        background:#2c2c2c; color:white; cursor:pointer; font-size:13px; font-weight:500;
                    ">${isDialogue ? '发送' : '生成下一段'}</button>
                </div>
            </div>
        </div>
    `;

    function renderBlock(block) {
        if (block.type === 'prompt') {
            return `<div style="margin-bottom:14px; padding-left:14px; border-left:2px solid #ddd; color:#999; font-size:13px; font-style:italic; line-height:1.6;">提示：${esc(block.text)}</div>`;
        }
        if (block.type === 'user') {
            return `
                <div style="margin-bottom:16px; text-align:right; padding-left:40px;">
                    <div style="font-size:13px; font-weight:500; color:#555; margin-bottom:3px;">${esc(block.sender)}</div>
                    <div style="display:inline-block; text-align:left; background:#eef2f7; border-radius:12px; padding:10px 14px; font-size:15px; line-height:1.7; color:#333; white-space:pre-wrap;">${esc(block.text)}</div>
                </div>
            `;
        }
        if (block.type === 'ai') {
            return `<div style="margin-bottom:20px; padding-left:20px; border-left:2px solid #ddd; font-size:15px; line-height:1.9; color:#333; white-space:pre-wrap;">${esc(block.text)}</div>`;
        }
        return `<div style="margin-bottom:20px; font-size:15px; line-height:1.9; color:#333; white-space:pre-wrap;">${esc(block.text)}</div>`;
    }

    panel.querySelector('.ifb-back-btn').onclick = () => renderList(overlay, pairKey, context);
    panel.querySelector('.ifb-delete-btn').onclick = async () => {
        const { showConfirm } = await import('../../store/dialog.js');
        const ok = await showConfirm(`确定删除「${branch.name}」吗？`);
        if (ok) {
            deleteBranch(pairKey, branchId);
            renderList(overlay, pairKey, context);
        }
    };

    const input = panel.querySelector('.ifb-input');
    const sendBtn = panel.querySelector('.ifb-send-btn');

    async function doSend() {
        const text = input.value.trim();
        if (!text) return;

        sendBtn.disabled = true;
        sendBtn.textContent = '⏳ 生成中...';

        if (isDialogue) {
            addContent(pairKey, branchId, { type: 'user', text, sender: getActiveName(context) });
            input.value = '';
            try {
                const aiText = await aiContinue(pairKey, branchId, context);
                addContent(pairKey, branchId, { type: 'ai', text: aiText });
            } catch (e) {
                addContent(pairKey, branchId, { type: 'ai', text: '（生成失败：' + e.message + '）' });
            }
        } else {
            if (text) addContent(pairKey, branchId, { type: 'prompt', text });
            input.value = '';
            try {
                const aiText = await aiContinue(pairKey, branchId, context);
                addContent(pairKey, branchId, { type: 'generated', text: aiText });
            } catch (e) {
                addContent(pairKey, branchId, { type: 'generated', text: '（生成失败：' + e.message + '）' });
            }
        }

        renderDetail(overlay, pairKey, branchId, context);
        setTimeout(() => {
            const s = panel.querySelector('.ifb-story');
            if (s) s.scrollTop = s.scrollHeight;
        }, 50);
    }

    sendBtn.onclick = doSend;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) doSend(); });
}

// ============================================================
//  AI 调用
// ============================================================

async function aiContinue(pairKey, branchId, context) {
    const branch = getBranch(pairKey, branchId);
    if (!branch) throw new Error('分支不存在');
    const isDialogue = branch.mode === 'dialogue';

    const storyText = branch.content.map(block => {
        if (block.type === 'prompt') return '（提示）' + block.text;
        if (block.type === 'user') return block.sender + '：' + block.text;
        return block.text;
    }).join('\n');

    let contextPrompt = '';
    if (branch.inject) {
        contextPrompt = await buildContextPrompt(branch);
    }

    const { callAIWithMessages } = await import('../aiService.js');

    // ★ 优先使用 if 线专属预设，空则默认
    const presetId = getCurrentPresetId();

    const systemPrompt = isDialogue ? `
你正在协助创作一条【对话模式】的平行剧情（if线）。

【角色A】${branch.charA}
【角色B】${branch.charB}
【剧情标题】${branch.name}
${branch.description ? `【剧情简介】${branch.description}` : ''}

${contextPrompt}
【已有剧情】
${storyText || '（剧情刚开始）'}

规则：
- 这是 ${branch.charA} 与 ${branch.charB} 两个人的剧情互动
- 用户当前扮演 ${getActiveName(context)}，他的输入代表该角色此刻的发言/行动/想法（第一人称或第三人称均可，可含动作和环境描写）
- 你作为剧情推进者，回复下一段剧情：推进情节、描写环境、描写 ${branch.charA} 或 ${branch.charB} 的动作/反应/对话
- 使用第三人称叙事，可以有上帝视角，两个角色都可以出现在你的回复中，不强制轮流
- 回复 500-800 字，剧情向、长文本、自然流畅
- 不要总结、不要评价剧情，直接输出剧情内容
- 不要输出标题或"回复："等前缀` : `
你正在协助创作一条【叙述模式】的平行剧情（if线）。

【剧情标题】${branch.name}
${branch.description ? `【剧情简介】${branch.description}` : ''}

${contextPrompt}
【已有剧情】
${storyText || '（剧情刚开始）'}

规则：
- 你负责生成接下来的剧情
- 用户可能提供一个提示词（方向/想法）；如果没有提示词，就根据已有剧情自然推进
- 用第三人称叙事，风格与已有内容保持一致
- 回复 500-800 字，可以埋下悬念或转折
- 不要总结、不要评价，直接输出剧情内容
- 不要输出标题或"续写："等前缀`;

    const result = await callAIWithMessages({
        systemPrompt,
        userContent: '请继续。',
        maxTokens: 8000,
        temperature: 0.9,
        presetId
    });
    return result.trim();
}

// ★ 构建角色背景注入
async function buildContextPrompt(branch) {
    const { CharacterStore } = await import('../../store/CharacterStore.js');
    const parts = [];
    const inj = branch.inject || {};

    let rolebook = [];
    try {
        const saved = localStorage.getItem('rolebook_characters');
        if (saved) rolebook = JSON.parse(saved);
    } catch { }

    for (const [id, name] of [[branch.charAId, branch.charA], [branch.charBId, branch.charB]]) {
        if (!id) continue;
        const store = new CharacterStore(id);
        const charData = rolebook.find(c => c.id === id);
        const otherId = id === branch.charAId ? branch.charBId : branch.charAId;
        const otherName = id === branch.charAId ? branch.charB : branch.charA;

        if (inj.relation !== false) {
            const target = store.getRelationById(otherId);
            if (target) {
                let line = `【${name} 与 ${otherName} 的关系】\n- 定位：${target.relation}`;
                if (target.perspective) line += `\n- 看法：${target.perspective}`;
                if (target.attitudes?.length) line += `\n- 倾向：${target.attitudes.join('、')}`;
                parts.push(line);
            }
            const note = store.getCognitiveNote(otherId);
            if (note) parts.push(`【${name} 对 ${otherName} 的认知】\n${note}`);
        }

        if (inj.friends !== false) {
            const relations = store.getRelations().filter(r => r.id !== otherId);
            if (relations.length > 0) {
                parts.push(`【${name} 的其他人际关系】\n` +
                    relations.map(r => {
                        let line = `- ${r.name}：${r.relation}`;
                        if (r.attitudes?.length) line += `（倾向：${r.attitudes.join('、')}）`;
                        return line;
                    }).join('\n'));
            }
        }

        if (inj.memories !== false) {
            const memories = store.getMemories().slice(-8);
            if (memories.length > 0) {
                parts.push(`【${name} 的重要记忆】\n` +
                    memories.map(m => `- ${m.time}：${m.content}`).join('\n'));
            }
        }
    }

    if (inj.worldbook && inj.worldbook.length > 0) {
        try {
            const saved = localStorage.getItem('worldbook_entries');
            if (saved) {
                const entries = JSON.parse(saved);
                const selected = entries.filter(e => inj.worldbook.includes(e.id || e.title));
                if (selected.length > 0) {
                    parts.push('【世界观设定】\n' +
                        selected.map(e => `- ${e.title}：${e.text}`).join('\n'));
                }
            }
        } catch { }
    }

    return parts.join('\n\n');
}

// ============================================================
//  工具函数
// ============================================================

function getActiveName(context) {
    return context?.globalState?.activeCharacter?.base?.name || '我';
}

function getOtherName(context) {
    return context?.contact?.name || context?.otherId || '对方';
}

function formatDate(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// apps/games/simCity.js — 模拟小城（角色联动模拟经营，IndexedDB 存储）
import { CharacterStore, getActiveCharacterId } from '../../store/CharacterStore.js';
import { getCharacterNameById } from '../characterManager.js';
import { getAvatarHtml } from '../../store/ImageCache.js';
import { isArchived } from '../roleData.js';
import { esc } from '../../store/utils.js';
import { getProfile, saveProfile, saveStory, getStories, deleteStory, buildPlaceIndex, getPresentAt, chatPairKey, getChatMessages, saveChatMessage, getAllChats, deleteChatMessage } from './simCityStore.js';
import { taskManager } from '../../store/AITaskManager.js';

export const id = 'simCity';
export const label = '模拟小城';
export const icon = '🏙️';
export const color = '#7c4dff';

let simCityCtx = null;   // 当前小城上下文：AI 完成后判断是否弹窗
let placeIndex = {};   // 当前小城地点×时段索引


// ---- 权限清单（系统接口声明：以后加授权项只改这里）----
const PERMISSIONS = [
    { key: 'identity', label: '基本信息', desc: '角色名、形象（头像，复用现有头像系统，不重复存储）' },
    { key: 'contacts', label: '联系人', desc: '好友列表（小城好友可见）' },
    { key: 'relations', label: '关系态度', desc: '好友间关系（社交互动参考）' },
];

// 统一读取接口：未授权返回 null（现在注册全同意 → 恒真；未来 per-角色调整只改这里）
async function readGameData(roleId, permKey, getter) {
    const profile = await getProfile(roleId);
    if (!profile || !profile.permissions.includes(permKey)) return null;
    return getter();
}

function toast(msg, bg = '#333') {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:${bg};color:#fff;padding:10px 20px;border-radius:12px;z-index:10000;font-size:13px;box-shadow:0 4px 20px rgba(0,0,0,0.2);max-width:80%;text-align:center;`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
}

// 联系人（游戏外好友）id 列表
function getContactIds(roleId) {
    try { return new CharacterStore(roleId).getFriendIds().filter(id => !isArchived(id)); }
    catch { return []; }
}

// ============================================================
//  入口
// ============================================================
export async function start(container, globalState, onBack) {
    const roleId = getActiveCharacterId(globalState);
    if (!roleId || roleId === 'unknown') {
        simCityCtx = null;
        container.innerHTML = '...请先设置主视角...';
        return;
    }
    simCityCtx = { container, globalState, roleId };
    placeIndex = await buildPlaceIndex();   // ★ 每次进入小城重建一次（查询仍 O(1)）
    await cleanupStaleTempChats();   // ★ 进小城：清理角色已离开地点的临时对话
    const back = () => { simCityCtx = null; onBack && onBack(); };
    const profile = await getProfile(roleId);
    if (profile) renderMain(container, globalState, back, roleId, profile);
    else renderRegister(container, globalState, back, roleId);
}

// ============================================================
//  注册页（游戏名 + 职业 + 授权勾选，必须全同意）
// ============================================================
function renderRegister(container, globalState, onBack, roleId) {
    const realName = getCharacterNameById(roleId) || roleId;
    container.innerHTML = `
        <div style="background:white;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
            <button id="scBack" style="border:none;background:none;font-size:18px;color:#666;cursor:pointer;">←</button>
            <span style="font-weight:700;font-size:16px;">🏙️ 入住小城</span>
            <span style="width:24px;"></span>
        </div>
        <div style="flex:1;overflow-y:auto;padding:16px;">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
                <div style="width:56px;height:56px;border-radius:50%;overflow:hidden;flex-shrink:0;">${getAvatarHtml(roleId)}</div>
                <div>
                    <div style="font-size:15px;font-weight:600;">${esc(realName)}</div>
                    <div style="font-size:12px;color:#999;">正在申请入住小城…</div>
                </div>
            </div>

            <div style="background:white;border-radius:14px;padding:14px;margin-bottom:12px;box-shadow:0 1px 6px rgba(0,0,0,0.05);">
                <div style="font-size:12px;color:#999;margin-bottom:6px;">游戏名（默认角色名，可修改）</div>
                <input id="scName" value="${esc(realName)}" style="width:100%;border:1px solid #ddd;border-radius:10px;padding:9px 10px;font-size:14px;box-sizing:border-box;font-family:inherit;">
            </div>

            <div style="background:white;border-radius:14px;padding:14px;margin-bottom:12px;box-shadow:0 1px 6px rgba(0,0,0,0.05);">
                <div style="font-size:12px;color:#999;margin-bottom:6px;">职业（自由填写）</div>
                <input id="scJob" placeholder="如：店主、工匠、学生…" style="width:100%;border:1px solid #ddd;border-radius:10px;padding:9px 10px;font-size:14px;box-sizing:border-box;font-family:inherit;">
                <div style="font-size:12px;color:#999;margin-top:8px;">初始金钱：💰 1000</div>
            </div>

            <div style="background:white;border-radius:14px;padding:14px;margin-bottom:12px;box-shadow:0 1px 6px rgba(0,0,0,0.05);">
                <div style="font-weight:600;font-size:14px;margin-bottom:2px;">🔐 数据授权</div>
                <div style="font-size:12px;color:#999;margin-bottom:10px;">入住小城需要你同意以下数据授权</div>
                ${PERMISSIONS.map(p => `
                    <label style="display:flex;align-items:flex-start;gap:8px;padding:8px 0;cursor:pointer;">
                        <input type="checkbox" class="sc-perm" data-key="${p.key}" checked style="margin-top:3px;accent-color:#7c4dff;">
                        <div style="flex:1;">
                            <div style="font-size:14px;">${p.label}</div>
                            <div style="font-size:12px;color:#999;">${p.desc}</div>
                        </div>
                    </label>`).join('')}
            </div>

            <button id="scRegister" style="width:100%;padding:13px;border:none;border-radius:24px;background:#7c4dff;color:#fff;font-size:15px;font-weight:600;cursor:pointer;">注册并进入小城</button>
            <div id="scPermTip" style="display:none;text-align:center;color:#e53935;font-size:12px;margin-top:8px;">需同意全部授权才能注册</div>
        </div>`;

    const nameInput = container.querySelector('#scName');
    const jobInput = container.querySelector('#scJob');
    const registerBtn = container.querySelector('#scRegister');
    const permTip = container.querySelector('#scPermTip');
    const perms = [...container.querySelectorAll('.sc-perm')];

    function checkAll() {
        const ok = perms.every(c => c.checked);
        registerBtn.disabled = !ok;
        registerBtn.style.background = ok ? '#7c4dff' : '#ccc';
        registerBtn.style.cursor = ok ? 'pointer' : 'not-allowed';
        permTip.style.display = ok ? 'none' : 'block';
    }
    perms.forEach(c => c.addEventListener('change', checkAll));
    checkAll();

    container.querySelector('#scBack').addEventListener('click', () => onBack && onBack());

    registerBtn.addEventListener('click', async () => {
        const name = (nameInput.value || '').trim() || realName;
        const job = (jobInput.value || '').trim() || '自由职业';
        const profile = {
            name, job,
            money: 1000, energy: 100, mood: 100, level: 1,
            permissions: perms.filter(c => c.checked).map(c => c.dataset.key),
            gameFriends: [],
            createdAt: Date.now()
        };
        await saveProfile(profile, roleId);
        toast(`🎉 ${name} 已入住小城！`, '#7c4dff');
        renderMain(container, globalState, onBack, roleId, profile);
        startAiEvaluation(roleId, profile);
    });

}

// ============================================================
//  AI 入住评估（后台静默，AITaskManager）
// ============================================================

// 后台提交评估任务：完成 → 写设定 + 纪念册只存评语 + 判断是否弹窗
function startAiEvaluation(roleId, profile, suggestion = '') {
    try {
        taskManager.submit('city_eval', `✨ AI评估：${profile.name} 的小城人设与日程`, () => aiEvaluateProfile(roleId, profile, suggestion), {
            onComplete: (ai) => {
                addMemento(roleId, profile, {                    // 纪念册：评语 + 标签
                    type: 'ai_report',
                    title: '✨ AI 入住评估',
                    comment: ai.comment || '',
                    traits: ai.traits || [],
                    createdAt: Date.now()
                });

                buildPlaceIndex().then(idx => { placeIndex = idx; });   // ★ 新增：评估后刷新索引

                if (simCityCtx && simCityCtx.roleId === roleId) {
                    showAiResult(simCityCtx.container, roleId, profile, ai);
                }
            },
            onError: () => { }
        });

    } catch (e) { /* 任务中心不可用时忽略 */ }
}

// 调 AI：读取角色设定 → 生成优化人设 + 日程表（JSON），并自动写入 profile.aiProfile
async function aiEvaluateProfile(roleId, profile, suggestion = '') {
    const base = (await readGameData(roleId, 'identity', () => {
        try {
            const f = JSON.parse(localStorage.getItem('rolebook_characters') || '[]').find(c => c.id === roleId);
            if (f?.base) return f.base;
            const f2 = JSON.parse(localStorage.getItem('worldnet_extra_characters') || '[]').find(c => c.id === roleId);
            if (f2?.base) return f2.base;
        } catch { }
        return null;
    })) || {};

    const roleInfo = [
        `游戏名：${profile.name}`,
        base.name ? `真实名：${base.name}` : '',
        base.gender ? `性别：${base.gender}` : '',
        base.age ? `年龄：${base.age}` : '',
        base.desc ? `人设：${base.desc}` : '',
        base.style ? `说话风格：${base.style}` : '',
        base.secret ? `内心秘密：${base.secret}` : '',
        base.detail ? `详细设定：${base.detail}` : '',
        `小城职业：${profile.job}`
    ].filter(Boolean).join('\n');

    const { callAIWithMessages } = await import('../aiService.js');
    const raw = await callAIWithMessages({
        systemPrompt: '你是"模拟小城"的入住评估官。根据给定角色的设定，输出三部分：' +
            '1) comment：对该角色初始设定的评估评语（120字内，语气可以温和吐槽或正经修正）' +
            '2) traits：3~5个性格/生活标签' +
            '3) schedule：该角色在小城的一天基础日程表（6~8个时段，含时间/地点/活动，体现职业）' +
            '地点只能从小城地点中选择：家、杂货店、市政厅、公园、中心广场、诊所、游乐场、银行、画廊、商业街。' +
            '时间用整点或半点（如08:00/14:30），按时间顺序排列。' +
            // ★ 夜生活
            '晚上（19:00~23:00）请安排1~2个夜生活时段（如夜市摆摊、酒吧驻唱、夜跑、加班、夜间散步、屋顶看星星等，' +
            '地点可用中心广场、游乐场、公园等），不要所有人都回家睡觉——让夜晚的小城也有生气。' +
            '只输出JSON：{"comment":"评语","traits":["标签"],"schedule":[{"time":"08:00","place":"杂货店","act":"整理货架"}]}，不要任何其他文字。',


        userContent: `角色信息：\n${roleInfo}\n\n`
            + (suggestion.trim() ? `角色本人想对评估官说的话：\n${suggestion.trim()}\n\n` : '')
            + `请给出评估评语、标签与日程表（JSON）。`,

        maxTokens: 12000,
        temperature: 0.8
    });
    const data = parseAiJson(raw || '');

    // ★ 存储分层：
    profile.schedule = data.schedule || [];        // 日程表单独存（影响默认行为逻辑）
    profile.aiProfile = {
        comment: data.comment || '（评估生成失败）',
        traits: data.traits || [],
        evaluatedAt: Date.now()
    };
    await saveProfile(profile, roleId);
    return profile.aiProfile;   // 返回 { comment, traits }（评语部分）
}

// 容错解析 AI 的 JSON 输出
function parseAiJson(raw) {
    try { const p = JSON.parse(raw); if (p && p.comment) return p; } catch { }
    try {
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) { const p = JSON.parse(m[0]); if (p && p.comment) return p; }
    } catch { }
    return { comment: '（评估生成失败，使用默认人设）', traits: [], schedule: [] };
}

// 纪念册条目（profile.mementos）
async function addMemento(roleId, profile, memento) {
    profile.mementos = profile.mementos || [];
    memento.id = 'mem_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
    profile.mementos.unshift(memento);
    await saveProfile(profile, roleId);
}

// 评估结果弹窗（简版：只展示，确认关闭）
function showAiResult(container, roleId, profile, ai) {
    const overlay = document.createElement('div');
    overlay.className = 'simcity-pop';
    overlay.innerHTML = `
        <div class="simcity-pop-card">
            <div style="font-weight:700;font-size:15px;margin-bottom:10px;">✨ AI 入住评估</div>
            <div class="simcity-pop-list">
                <div style="font-size:13px;line-height:1.7;color:#333;">${esc(ai.comment || '')}</div>
                ${(ai.traits || []).length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;">${ai.traits.map(t => `<span style="font-size:11px;background:#f0ebff;color:#7c4dff;border-radius:10px;padding:3px 10px;">${esc(t)}</span>`).join('')}</div>` : ''}
                <div style="font-size:11px;color:#999;margin-top:10px;">📅 基础日程表已生成，可在家里查看</div>
                <div style="font-size:11px;color:#999;">评语已存入家里的「纪念册」</div>
            </div>
            <button class="simcity-btn primary" id="aiResultOk" style="margin-top:10px;">知道了</button>
        </div>`;
    container.appendChild(overlay);
    overlay.querySelector('#aiResultOk').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}


// ============================================================
//  主城
// ============================================================
const PLOTS = [
    { key: 'home', name: '家', icon: '🏠', image: '', act: 'rest', desc: '休息恢复体力' },
    { key: 'shop', name: '杂货店', icon: '🏪', image: '', act: 'shop', desc: '购物提升心情' },
    { key: 'hall', name: '市政厅', icon: '🏛️', image: '', act: 'work', desc: '打工赚钱' },
    { key: 'park', name: '公园', icon: '🌳', image: '', act: 'rest', desc: '散步放松' },
    { key: 'square', name: '中心广场', icon: '⛲', image: '', act: 'social', desc: '与好友互动' },
    { key: 'clinic', name: '诊所', icon: '🏥', image: '', act: 'clinic', desc: '治疗恢复体力' },
    { key: 'fun', name: '游乐场', icon: '🎡', image: '', act: 'fun', desc: '娱乐提升心情' },
    { key: 'bank', name: '银行', icon: '🏦', image: '', act: 'bank', desc: '存取金币' },
    { key: 'gallery', name: '画廊', icon: '🖼️', image: '', act: 'gallery', desc: '欣赏画作' },
    { key: 'mall', name: '商业街', icon: '🏬', image: '', act: 'shop', desc: '逛街淘货' },
];

// 数组分页
function chunk(arr, size) {
    return Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));
}


function renderMain(container, globalState, onBack, roleId, profile) {
    const realName = (id) => getCharacterNameById(id) || id;

    container.innerHTML = `
        <div class="simcity-root">
            <div class="simcity-header">
                <button class="back-btn" id="scBack">←</button>
                <span class="title">🏙️ ${esc(profile.name)}</span>
                <span class="level">Lv.${profile.level}</span>
            </div>
            <div class="simcity-body">
                <div class="simcity-char">
                    <div class="avatar">${getAvatarHtml(roleId)}</div>
                    <div>
                        <div class="cname">${esc(profile.name)} <span style="font-size:12px;color:#999;">（${esc(realName(roleId))}）</span></div>
                        <div class="cjob">职业：${esc(profile.job)} · 已入住 ${Math.floor((Date.now() - profile.createdAt) / 86400000) + 1} 天</div>
                    </div>
                </div>

                <div class="simcity-stats">
                    <div class="simcity-stat"><div class="v">💰 ${profile.money}</div><div class="k">金钱</div></div>
                    <div class="simcity-stat"><div class="v">⚡ ${profile.energy}</div><div class="k">体力</div></div>
                    <div class="simcity-stat"><div class="v">😊 ${profile.mood}</div><div class="k">心情</div></div>
                </div>

                                <div class="simcity-map">
                    <div class="simcity-pages">
                        ${chunk(PLOTS, 9).map(page => `
                            <div class="simcity-page">
                                <div class="simcity-grid">
                                    ${page.map(p => `
                                        <div class="simcity-plot" data-key="${p.key}">
                                            ${p.image
            ? `<img src="${p.image}" alt="${esc(p.name)}" loading="lazy">`
            : `<div class="icon">${p.icon}</div>`}
                                            <div class="name">${p.name}</div>
                                            <div class="desc">${p.desc}</div>
                                        </div>`).join('')}
                                </div>
                            </div>`).join('')}
                    </div>
                </div>


                <div class="simcity-actions">
                    <button class="simcity-btn" id="scFriends">👥 好友</button>
                    <button class="simcity-btn primary" id="scPerm">🔐 授权</button>
                </div>
            </div>
        </div>`;

    container.querySelector('#scBack').addEventListener('click', () => onBack && onBack());
    container.querySelector('#scFriends').addEventListener('click', () => showFriends(container, globalState, onBack, roleId, profile));
    container.querySelector('#scPerm').addEventListener('click', () => showPermView(container));

    container.querySelectorAll('.simcity-plot').forEach(plot => {
        plot.addEventListener('click', () => renderPlace(container, globalState, onBack, roleId, profile, plot.dataset.key));
    });
}

// 模块级：执行地点行动
async function doAction(container, globalState, onBack, roleId, profile, act) {
    const save = async () => { await saveProfile(profile, roleId); };
    if (act === 'work') {
        if (profile.energy < 15) { toast('体力不足，先去公园或诊所休息吧', '#ff9800'); return; }
        const earn = 30 + Math.floor(Math.random() * 51);
        profile.money += earn; profile.energy -= 15; profile.mood -= 5;
        toast(`🏛️ 在市政厅打工赚了 ${earn} 金币`, '#2e7d32');
    } else if (act === 'rest') {
        profile.energy = Math.min(100, profile.energy + 40); profile.mood = Math.min(100, profile.mood + 10);
        toast('🌳 散步休息，神清气爽', '#0b93f6');
    } else if (act === 'clinic') {
        if (profile.money < 30) { toast('💰 金币不足，去市政厅打工吧', '#e53935'); return; }
        profile.money -= 30; profile.energy = Math.min(100, profile.energy + 60);
        toast('🏥 在诊所恢复了体力', '#00bcd4');
    } else if (act === 'shop') {
        const items = [
            { name: '热奶茶', price: 20, mood: 8 }, { name: '小蛋糕', price: 35, mood: 15 },
            { name: '鲜花', price: 25, mood: 10 }, { name: '游戏机', price: 200, mood: 40 }
        ];
        const it = items[Math.floor(Math.random() * items.length)];
        if (profile.money < it.price) { toast('💰 金币不足', '#e53935'); return; }
        profile.money -= it.price; profile.mood = Math.min(100, profile.mood + it.mood);
        toast(`🛒 买了${it.name}，心情+${it.mood}`, '#ff9800');
    } else if (act === 'fun') {
        if (profile.money < 50) { toast('💰 金币不足', '#e53935'); return; }
        profile.money -= 50; profile.mood = Math.min(100, profile.mood + 30); profile.energy -= 10;
        toast('🎡 在游乐场玩得很开心！', '#ff7043');
    } else if (act === 'gallery') {
        profile.mood = Math.min(100, profile.mood + 12);
        toast('🖼️ 在画廊欣赏画作，心情愉悦', '#7c4dff');
    } else if (act === 'bank') {
        showBank(container, globalState, onBack, roleId, profile);
        return;
    } else if (act === 'social') {
        showFriends(container, globalState, onBack, roleId, profile);
        return;
    }
    await save();
    renderMain(container, globalState, onBack, roleId, profile);
}

// 某地点此刻在场角色区块（真实时间小时）
function presentSectionHtml(placeName, roleId) {
    const hour = new Date().getHours();
    const ids = getPresentAt(placeIndex, placeName, hour);
    const others = ids.filter(id => id !== roleId);
    if (!others.length) {
        return '<div style="font-size:12px;color:#999;text-align:center;padding:10px;">🕐 此刻这里很安静，没有其他人</div>';
    }
    return `
        <div style="background:white;border-radius:14px;padding:12px;margin-bottom:12px;box-shadow:0 1px 6px rgba(0,0,0,0.06);">
            <div style="font-size:13px;font-weight:600;margin-bottom:8px;">🕐 此刻在场（${hour}:00）</div>
            ${others.map(id => `
                <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #f5f5f5;">
                    <div style="width:34px;height:34px;border-radius:50%;overflow:hidden;flex-shrink:0;">${getAvatarHtml(id)}</div>
                    <div style="flex:1;font-size:13px;font-weight:600;">${esc(getCharacterNameById(id) || id)}</div>
                    <button class="sc-encounter" data-friend="${esc(id)}" data-place="${esc(placeName)}"
                        style="border:none;background:#7c4dff;color:#fff;border-radius:12px;padding:5px 12px;font-size:12px;cursor:pointer;">偶遇</button>
                    <button class="sc-chat" data-friend="${esc(id)}" data-place="${esc(placeName)}"
                        style="border:none;background:#0b93f6;color:#fff;border-radius:12px;padding:5px 12px;font-size:12px;cursor:pointer;">对话</button>
                </div>`).join('')}
        </div>`;
}

// 地点内部视图分发
function renderPlace(container, globalState, onBack, roleId, profile, placeKey) {
    const place = PLOTS.find(p => p.key === placeKey) || PLOTS[0];
    if (placeKey === 'home') { renderHome(container, globalState, onBack, roleId, profile); return; }

    if (placeKey === 'park') { renderPark(container, globalState, onBack, roleId, profile); return; }
    if (placeKey === 'hall') { renderHall(container, globalState, onBack, roleId, profile); return; }   // ★ 新增

    container.innerHTML = `
        <div class="simcity-root">
            <div class="simcity-header">
                <button class="back-btn" id="placeBack">←</button>
                <span class="title">${place.icon} ${esc(place.name)}</span>
                <span class="level"></span>
            </div>
            <div class="simcity-body">
                <div class="simcity-room">
                    <div class="simcity-item" id="placeAct">
                        <div class="item-icon">${place.icon}</div>
                        <div class="item-name">${esc(place.name)}</div>
                        <div class="item-desc">${esc(place.desc)}</div>
                    </div>
                </div>
                ${presentSectionHtml(place.name, roleId)}
                <div style="font-size:12px;color:#999;text-align:center;margin-top:10px;">更多互动布置中…</div>
            </div>
        </div>`;
    container.querySelector('#placeBack').addEventListener('click', () => renderMain(container, globalState, onBack, roleId, profile));
    container.querySelector('#placeAct').addEventListener('click', () => doAction(container, globalState, onBack, roleId, profile, place.act));
    container.querySelectorAll('.sc-encounter').forEach(btn => {
        btn.addEventListener('click', () => {
            showEncounter(container, roleId, profile, btn.dataset.friend, btn.dataset.place);
        });
    });
    container.querySelectorAll('.sc-chat').forEach(btn => {
        btn.addEventListener('click', () => {
            showCityChat(container, roleId, profile, btn.dataset.friend, btn.dataset.place, false);   // ★ 临时
        });
    });


}

// 市政厅：打工 + AI 评估服务
function renderHall(container, globalState, onBack, roleId, profile) {
    container.innerHTML = `
        <div class="simcity-root">
            <div class="simcity-header">
                <button class="back-btn" id="hallBack">←</button>
                <span class="title">🏛️ 市政厅</span>
                <span class="level"></span>
            </div>
            <div class="simcity-body">
                <div class="simcity-room">
                    <div class="simcity-item" id="hallWork">
                        <div class="item-icon">💼</div>
                        <div class="item-name">打工赚钱</div>
                        <div class="item-desc">赚取金币（消耗体力）</div>
                    </div>
                    <div class="simcity-item" id="hallEval">
                        <div class="item-icon">🧑‍💼</div>
                        <div class="item-name">AI 评估服务</div>
                        <div class="item-desc">花费 100 金币，与评估官对话</div>
                    </div>
                </div>
                <div style="font-size:12px;color:#999;text-align:center;margin-top:10px;">💰 金币：${profile.money}</div>
            </div>
        </div>`;

    container.querySelector('#hallBack').addEventListener('click', () => renderMain(container, globalState, onBack, roleId, profile));
    container.querySelector('#hallWork').addEventListener('click', () => doAction(container, globalState, onBack, roleId, profile, 'work'));
    container.querySelector('#hallEval').addEventListener('click', () => showEvalService(container, globalState, onBack, roleId, profile));
}

// AI 评估服务弹窗：输入角色建议 → 花 100 金币 → 发起评估对话
function showEvalService(container, globalState, onBack, roleId, profile) {
    const affordable = profile.money >= 100;
    const overlay = document.createElement('div');
    overlay.className = 'simcity-pop';
    overlay.innerHTML = `
        <div class="simcity-pop-card">
            <div style="font-weight:700;font-size:15px;margin-bottom:4px;">🧑‍💼 AI 评估服务</div>
            <div style="font-size:12px;color:#999;margin-bottom:10px;">与评估官对话，重新生成评语、标签与日程表 · 费用 100 金币（当前 ${profile.money}）</div>
            <div style="font-size:12px;color:#666;margin-bottom:6px;">角色想对评估官说的话（可留空）：</div>
            <textarea id="evalSuggestion" rows="3" maxlength="200" placeholder="如：我想开一家自己的小店…" style="width:100%;box-sizing:border-box;border:1px solid #ddd;border-radius:10px;padding:8px 10px;font-size:13px;font-family:inherit;resize:none;margin-bottom:10px;"></textarea>
            <button id="evalConfirm" class="simcity-btn primary" ${affordable ? '' : 'disabled'} style="${affordable ? '' : 'opacity:0.5;'}">${affordable ? '💬 花费 100 金币开始对话' : '💰 金币不足'}</button>
            <button class="simcity-pop-close" id="evalClose">取消</button>
        </div>`;
    container.appendChild(overlay);

    overlay.querySelector('#evalClose').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    overlay.querySelector('#evalConfirm').addEventListener('click', async () => {
        if (profile.money < 100) { toast('💰 金币不足', '#e53935'); return; }
        profile.money -= 100;
        const suggestion = overlay.querySelector('#evalSuggestion').value.trim();
        overlay.remove();
        await saveProfile(profile, roleId);
        toast('🧑‍💼 已支付 100 金币，评估对话开始…', '#7c4dff');
        startAiEvaluation(roleId, profile, suggestion);
        renderMain(container, globalState, onBack, roleId, profile);
    });
}


// 家：小房间（桌 + 床）
function renderHome(container, globalState, onBack, roleId, profile) {
    const today = new Date().toDateString();
    if (profile.lastRestDay !== today) { profile.lastRestDay = today; profile.restCount = 0; }
    const restsLeft = Math.max(0, 2 - (profile.restCount || 0));
    const save = async () => { await saveProfile(profile, roleId); };

    container.innerHTML = `
        <div class="simcity-root">
            <div class="simcity-header">
                <button class="back-btn" id="homeBack">←</button>
                <span class="title">🏠 家</span>
                <span class="level">💤 今日可休息 ${restsLeft}/2 次</span>
            </div>
            <div class="simcity-body">
                <div class="simcity-room">
                    <div class="simcity-item" id="itemBed">
                        <div class="item-icon">🛏️</div>
                        <div class="item-name">床</div>
                        <div class="item-desc">睡一觉，体力恢复满</div>
                    </div>
                    <div class="simcity-item" id="itemTable">
                        <div class="item-icon">🪑</div>
                        <div class="item-name">桌子</div>
                        <div class="item-desc">在桌前整理思绪，心情+5</div>
                    </div>
                    <div class="simcity-item" id="itemMemories">
    <div class="item-icon">📔</div>
    <div class="item-name">回忆册</div>
    <div class="item-desc">查看小城里的故事</div>
</div>

<div class="simcity-item" id="itemSchedule">
    <div class="item-icon">📅</div>
    <div class="item-name">日程表</div>
    <div class="item-desc">查看每日基础日程</div>
</div>
<div class="simcity-item" id="itemMemento">
    <div class="item-icon">🎁</div>
    <div class="item-name">纪念册</div>
    <div class="item-desc">保存有意义的东西</div>
</div>

                </div>
                <div style="font-size:12px;color:#999;text-align:center;margin-top:10px;">⚡ 体力：${profile.energy} / 100</div>
            </div>
        </div>`;

    container.querySelector('#homeBack').addEventListener('click', () => renderMain(container, globalState, onBack, roleId, profile));

    container.querySelector('#itemBed').addEventListener('click', async () => {
        if ((profile.restCount || 0) >= 2) { toast('今天已经休息两次了，明天再来吧', '#ff9800'); return; }
        profile.energy = 100;
        profile.restCount = (profile.restCount || 0) + 1;
        profile.lastRestDay = today;
        await save();
        toast('💤 睡了一觉，体力恢复满了', '#0b93f6');
        renderHome(container, globalState, onBack, roleId, profile);
    });

    container.querySelector('#itemTable').addEventListener('click', async () => {
        profile.mood = Math.min(100, profile.mood + 5);
        await save();
        toast('🍵 在桌前整理了一下思绪，心情+5', '#7c4dff');
        renderHome(container, globalState, onBack, roleId, profile);
    });

    container.querySelector('#itemMemories').addEventListener('click', async () => {
        const stories = await getStories(roleId);
        const overlay = document.createElement('div');
        overlay.className = 'simcity-pop';
        overlay.innerHTML = `
        <div class="simcity-pop-card">
            <div style="font-weight:700;font-size:15px;margin-bottom:10px;">📔 回忆册</div>
            <div class="simcity-pop-list">
                ${stories.length === 0
                ? '<div class="story-empty">还没有故事，去公园走走吧</div>'
                : stories.map(s => `
                        <div class="story-card" data-story-id="${esc(s.id)}">
                            <div class="story-summary">${esc(s.summary || s.text.slice(0, 20))}</div>
                            <div class="story-meta">${new Date(s.timestamp).toLocaleDateString('zh-CN')} · ${s.type === 'park_encounter' ? '公园偶遇' : s.type === 'passerby' ? '路人偶遇' : '互动'}</div>
                            <button class="story-del" data-del-story="${esc(s.id)}">✕</button>
                        </div>`).join('')}
            </div>
            <button class="simcity-pop-close" id="memoriesClose">关闭</button>
        </div>`;
        container.appendChild(overlay);
        overlay.querySelector('#memoriesClose').addEventListener('click', () => overlay.remove());

        // 点卡片 → 详情页
        overlay.addEventListener('click', (e) => {
            const card = e.target.closest('.story-card');
            if (!card || e.target.closest('.story-del')) return;
            const story = stories.find(x => x.id === card.dataset.storyId);
            if (!story) return;
            showStoryDetail(overlay, story);
        });
        // 删除
        overlay.addEventListener('click', async (e) => {
            const del = e.target.closest('[data-del-story]');
            if (!del) return;
            e.stopPropagation();
            await deleteStory(del.dataset.delStory);
            toast('🗑️ 已删除这条回忆', '#999');
            del.closest('.story-card').remove();
        });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    });

    // 回忆详情弹窗（卡片点击）
    function showStoryDetail(overlay, story) {
        const detail = document.createElement('div');
        detail.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;z-index:10;';
        detail.innerHTML = `
        <div class="story-detail-card">
            <div class="story-detail-title">${esc(story.summary || '回忆')}</div>
            <div class="story-detail-text">${esc(story.text)}</div>
            <div class="story-detail-meta">${new Date(story.timestamp).toLocaleString('zh-CN')}</div>
            <button class="story-detail-close">关闭</button>
        </div>`;
        overlay.appendChild(detail);
        detail.querySelector('.story-detail-close').addEventListener('click', () => detail.remove());
        detail.addEventListener('click', (e) => { if (e.target === detail) detail.remove(); });
    }

    // 📅 日程表（读 profile.schedule，兼容旧档）
    container.querySelector('#itemSchedule').addEventListener('click', () => {
        const schedule = profile.schedule || profile.aiProfile?.schedule || [];
        const overlay = document.createElement('div');
        overlay.className = 'simcity-pop';
        overlay.innerHTML = `
        <div class="simcity-pop-card">
            <div style="font-weight:700;font-size:15px;margin-bottom:10px;">📅 每日基础日程</div>
            <div class="simcity-pop-list">
                ${!schedule.length
                ? '<div style="font-size:12px;color:#999;padding:8px 0;">尚未进行 AI 评估，暂无日程表</div>'
                : schedule.map(s => `
                        <div style="display:flex;gap:10px;padding:7px 0;border-bottom:1px solid #f5f5f5;font-size:13px;">
                            <span style="color:#7c4dff;font-weight:600;flex-shrink:0;">${esc(s.time)}</span>
                            <span style="color:#333;">${esc(s.act)}</span>
                        </div>`).join('')}
            </div>
            <div style="font-size:11px;color:#999;margin-top:8px;">基础日程 · 特殊情况下可能被更高优先级的事件覆盖</div>
            <button class="simcity-pop-close" id="scheduleClose">关闭</button>
        </div>`;
        container.appendChild(overlay);
        overlay.querySelector('#scheduleClose').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    });

    // 🎁 纪念册（展示 profile.mementos：AI 评语等，点击展开详情）
    // 🎁 纪念册（展示 profile.mementos：AI 评语等，点击展开详情）
    container.querySelector('#itemMemento').addEventListener('click', () => {
        const mementos = profile.mementos || [];
        const overlay = document.createElement('div');
        overlay.className = 'simcity-pop';
        overlay.innerHTML = `
        <div class="simcity-pop-card">
            <div style="font-weight:700;font-size:15px;margin-bottom:10px;">🎁 纪念册</div>
            <div class="simcity-pop-list">
                ${mementos.length === 0 ? '<div style="font-size:12px;color:#999;padding:8px 0;">还没有纪念，去做点有意义的事吧</div>'
                : mementos.map((m, i) => `
                        <div class="memento-item" data-i="${i}" style="padding:10px 0;border-bottom:1px solid #f5f5f5;cursor:pointer;position:relative;">
                            <div style="font-size:13px;font-weight:600;">${esc(m.title || '纪念')}</div>
                            <div style="font-size:11px;color:#999;margin-top:2px;">${new Date(m.createdAt).toLocaleString('zh-CN')} · 点击展开</div>
                            <button data-del-memento="${esc(m.id)}" data-i="${i}" style="position:absolute;top:10px;right:4px;border:none;background:none;color:#bbb;cursor:pointer;font-size:13px;">✕</button>
                            <div class="memento-detail" data-i="${i}" style="display:none;margin-top:8px;padding-top:8px;border-top:1px dashed #eee;">
                                <div style="font-size:12px;line-height:1.7;color:#333;">${esc(m.comment || '')}</div>
                                ${(m.traits || []).length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">${m.traits.map(t => `<span style="font-size:11px;background:#f0ebff;color:#7c4dff;border-radius:10px;padding:3px 10px;">${esc(t)}</span>`).join('')}</div>` : ''}
                            </div>
                        </div>`).join('')}
            </div>
            <button class="simcity-pop-close" id="mementoClose">关闭</button>
        </div>`;
        container.appendChild(overlay);
        overlay.querySelector('#mementoClose').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', async (e) => {
            const del = e.target.closest('[data-del-memento]');
            if (!del) return;
            e.stopPropagation();
            const idx = parseInt(del.dataset.i);
            profile.mementos.splice(idx, 1);
            await saveProfile(profile, roleId);
            toast('🗑️ 已删除这条纪念', '#999');
            del.closest('.memento-item').remove();
        });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        overlay.querySelectorAll('.memento-item').forEach(el => {
            el.addEventListener('click', (ev) => {
                if (ev.target.closest('[data-del-memento]')) return;   // ★ 点 ✕ 不触发展开
                const detail = overlay.querySelector(`.memento-detail[data-i="${el.dataset.i}"]`);
                if (detail) detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
            });
        });
    });


}

// 银行存取
function showBank(container, globalState, onBack, roleId, profile) {
    const save = async () => { await saveProfile(profile, roleId); };
    const overlay = document.createElement('div');
    overlay.className = 'simcity-pop';
    overlay.innerHTML = `
        <div class="simcity-pop-card">
            <div style="font-weight:700;font-size:15px;margin-bottom:4px;">🏦 银行</div>
            <div style="font-size:12px;color:#999;margin-bottom:12px;">当前金币：${profile.money} · 存款：${profile.savings || 0}</div>
            <button id="bankSave" class="simcity-btn" style="margin-bottom:8px;">存入 50</button>
            <button id="bankTake" class="simcity-btn" style="margin-bottom:8px;">取出 50</button>
            <button class="simcity-pop-close" id="bankClose">关闭</button>
        </div>`;
    container.appendChild(overlay);
    overlay.querySelector('#bankSave').addEventListener('click', async () => {
        if (profile.money < 50) { toast('金币不足', '#e53935'); return; }
        profile.money -= 50; profile.savings = (profile.savings || 0) + 50;
        toast('🏦 已存入 50 金币', '#2e7d32'); await save(); overlay.remove();
        renderMain(container, globalState, onBack, roleId, profile);
    });
    overlay.querySelector('#bankTake').addEventListener('click', async () => {
        if ((profile.savings || 0) < 50) { toast('存款不足', '#e53935'); return; }
        profile.savings -= 50; profile.money += 50;
        toast('🏦 已取出 50 金币', '#0b93f6'); await save(); overlay.remove();
        renderMain(container, globalState, onBack, roleId, profile);
    });
    overlay.querySelector('#bankClose').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// 公园：散步偶遇游戏内好友 → 随机剧情 → 保存
function renderPark(container, globalState, onBack, roleId, profile) {
    container.innerHTML = `
        <div class="simcity-root">
            <div class="simcity-header">
                <button class="back-btn" id="parkBack">←</button>
                <span class="title">🌳 公园</span>
                <span class="level"></span>
            </div>
            <div class="simcity-body">
                <div class="simcity-room" style="grid-template-columns:1fr 1fr;">
                    <div class="simcity-item"><div class="item-icon">🌳</div><div class="item-name">树林</div><div class="item-desc">枝叶沙沙</div></div>
                    <div class="simcity-item"><div class="item-icon">⛲</div><div class="item-name">喷泉</div><div class="item-desc">水光粼粼</div></div>
                    <div class="simcity-item"><div class="item-icon">🪑</div><div class="item-name">长椅</div><div class="item-desc">午后小憩</div></div>
                    <div class="simcity-item" id="walkBtn"><div class="item-icon">🚶</div><div class="item-name">散步</div><div class="item-desc">可能偶遇好友</div></div>
                </div>
                ${presentSectionHtml('公园', roleId)}
            </div>
        </div>`;

    container.querySelector('#parkBack').addEventListener('click', () => renderMain(container, globalState, onBack, roleId, profile));
    container.querySelector('#walkBtn').addEventListener('click', async () => {
        const hour = new Date().getHours();
        const present = getPresentAt(placeIndex, '公园', hour);
        // ★ 索引里的角色必是居民，直接当随机池（filter id 兜底防脏数据）
        const candidates = present.filter(id => id && id !== roleId);

        if (candidates.length) {
            const friend = candidates[Math.floor(Math.random() * candidates.length)];
            showEncounter(container, roleId, profile, friend, '公园');
            return;
        }

        // ★ 没人在场 → 50% 路人剧情 / 50% 无事发生
        if (Math.random() < 0.5) {
            showPasserbyStory(container, roleId, profile, '公园');
        } else {
            toast('此刻公园空荡荡的，晚点再来看看吧', '#ff9800');
        }
    });
    // ★ 在场角色偶遇按钮绑定
    container.querySelectorAll('.sc-encounter').forEach(btn => {
        btn.addEventListener('click', () => {
            showEncounter(container, roleId, profile, btn.dataset.friend, btn.dataset.place);
        });
    });
    container.querySelectorAll('.sc-chat').forEach(btn => {
        btn.addEventListener('click', () => {
            showCityChat(container, roleId, profile, btn.dataset.friend, btn.dataset.place, false);   // ★ 临时
        });
    });


}



// 好友列表（异步查档案）
async function showFriends(container, globalState, onBack, roleId, profile) {
    const realName = (id) => getCharacterNameById(id) || id;
    const contactIds = (await readGameData(roleId, 'contacts', () => getContactIds(roleId))) || [];
    const contactMap = {};
    contactIds.forEach(id => contactMap[id] = true);

    // 批量查好友档案（IndexedDB 异步）
    const regMap = {};
    await Promise.all(contactIds.map(async id => {
        const p = await getProfile(id);
        if (p) regMap[id] = p;
    }));

    const gameFriendIds = new Set();
    const gfList = [];
    contactIds.forEach(id => {
        if (regMap[id]) { gameFriendIds.add(id); gfList.push({ id, name: regMap[id].name, isContact: true }); }
    });
    (profile.gameFriends || []).forEach(f => {
        if (!gameFriendIds.has(f.id)) { gameFriendIds.add(f.id); gfList.push({ id: f.id, name: f.name, isContact: !!contactMap[f.id] }); }
    });
    const unregistered = contactIds.filter(id => !regMap[id]);

    const overlay = document.createElement('div');
    overlay.className = 'simcity-pop';
    overlay.innerHTML = `
        <div class="simcity-pop-card">
            <div style="font-weight:700;font-size:15px;margin-bottom:10px;">👥 好友</div>
            <div class="simcity-pop-list">
                <div style="font-size:12px;color:#7c4dff;margin:8px 0 4px;">🎮 游戏内好友</div>
                ${gfList.length === 0 ? '<div style="font-size:12px;color:#999;padding:8px 0;">暂无游戏内好友</div>'
            : gfList.map(f => `
                        <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f5f5f5;">
                            <div style="width:34px;height:34px;border-radius:50%;overflow:hidden;flex-shrink:0;">${getAvatarHtml(f.id)}</div>
                            <div style="flex:1;font-size:14px;">${esc(f.name)}${f.isContact ? ` <span style="font-size:12px;color:#999;">（${esc(realName(f.id))}）</span>` : ''}</div>
                            <button class="gf-chat" data-friend="${esc(f.id)}" style="border:none;background:#0b93f6;color:#fff;border-radius:12px;padding:5px 12px;font-size:12px;cursor:pointer;">对话</button>
                        </div>`).join('')}
                <div style="font-size:12px;color:#999;margin:12px 0 4px;">👥 未注册联系人</div>
                ${unregistered.length === 0 ? '<div style="font-size:12px;color:#999;padding:8px 0;">没有未入住的好友</div>'
            : unregistered.map(id => `
                        <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f5f5f5;">
                            <div style="width:34px;height:34px;border-radius:50%;overflow:hidden;flex-shrink:0;">${getAvatarHtml(id)}</div>
                            <div style="flex:1;font-size:14px;">${esc(realName(id))} <span style="font-size:12px;color:#999;">未入住</span></div>
                        </div>`).join('')}
            </div>
            <button class="simcity-pop-close" id="friendClose">关闭</button>
        </div>`;
    container.appendChild(overlay);
    overlay.querySelector('#friendClose').addEventListener('click', () => overlay.remove());
    overlay.querySelectorAll('.gf-chat').forEach(btn => {
        btn.addEventListener('click', () => {
            overlay.remove();
            showCityChat(container, roleId, profile, btn.dataset.friend, '好友聊天', true);   // ★ 持久
        });
    });

    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// 授权只读
function showPermView(container) {
    const overlay = document.createElement('div');
    overlay.className = 'simcity-pop';
    overlay.innerHTML = `
        <div class="simcity-pop-card">
            <div style="font-weight:700;font-size:15px;margin-bottom:10px;">🔐 数据授权</div>
            <div class="simcity-pop-list">
                ${PERMISSIONS.map(p => `
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f5f5f5;">
                        <div><div style="font-size:14px;">${p.label}</div><div style="font-size:11px;color:#999;">${p.desc}</div></div>
                        <span style="color:#2e7d32;font-size:12px;">✓ 已授权</span>
                    </div>`).join('')}
            </div>
            <div style="font-size:11px;color:#999;margin-top:10px;">系统接口，暂不可在游戏内修改</div>
            <button class="simcity-pop-close" id="permClose">关闭</button>
        </div>`;
    container.appendChild(overlay);
    overlay.querySelector('#permClose').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function hourOfNow(t, hour) { const h = /^(\d{1,2})/.exec(String(t || '')); return h && parseInt(h[1]) === hour; }

// 解析 AI 剧情输出：【概要】…【正文】…
function parseStory(raw) {
    if (!raw) return { summary: '', text: '' };
    const s = raw.indexOf('【概要】');
    const b = raw.indexOf('【正文】');
    if (s !== -1 && b > s) {
        return { summary: raw.slice(s + 4, b).trim(), text: raw.slice(b + 4).trim() };
    }
    return { summary: raw.slice(0, 20) + (raw.length > 20 ? '…' : ''), text: raw.trim() };
}

// 最近 N 条剧情概要（防重复用）
async function getRecentSummaries(roleId, n = 4) {
    const stories = await getStories(roleId);
    return stories.slice(0, n).map(s => `- ${s.summary || s.text.slice(0, 20)}`).join('\n');
}

// 偶遇：AI 生成一段双人小剧情
async function showEncounter(container, roleId, profile, friendId, placeName) {
    const friendName = getCharacterNameById(friendId) || friendId;
    // ★ 只读游戏内数据：好友的小城 profile（没入住 → 路人）
    let fp = null;
    try { fp = await getProfile(friendId); } catch { }

    const hour = new Date().getHours();
    const actText = (profile.schedule || []).find(s => hourOfNow(s.time, hour))?.act || '';
    const myTraits = (profile.aiProfile?.traits || []).join('、');

    // ★ 好友信息：只基于小城 profile（游戏内数据），不读真实角色卡
    let friendInfo;
    if (fp) {
        const friendAct = (fp.schedule || []).find(s => hourOfNow(s.time, hour))?.act || '';
        friendInfo = `【${friendName}（小城居民）】\n` +
            `小城职业：${fp.job || '无'}\n` +
            `性格标签：${(fp.aiProfile?.traits || []).join('、') || '暂无'}\n` +
            `此刻活动：${friendAct || `在${placeName}附近`}`;
    } else {
        friendInfo = `【${friendName}】\n（ta 尚未入住小城，只是个陌生面孔——你还不了解ta）`;
    }

    // ★ 关系（经授权读取自己的 relations）
    const rel = await readGameData(roleId, 'relations', () => new CharacterStore(roleId).getRelationById(friendId));
    if (rel?.relation) friendInfo += `\n你和ta的关系：${rel.relation}`;
    const overlay = document.createElement('div');
    overlay.className = 'simcity-pop';
    overlay.innerHTML = `<div class="simcity-pop-card">
        <div style="font-weight:700;font-size:15px;margin-bottom:4px;">🌳 偶遇 ${esc(friendName)}</div>
        <div style="font-size:12px;color:#999;margin-bottom:10px;">${esc(placeName)} · ${hour}:00</div>
        <div id="encBody" style="font-size:13px;line-height:1.8;color:#333;white-space:pre-wrap;min-height:60px;">⏳ 剧情生成中…</div>
        <button class="simcity-pop-close" id="encClose">关闭</button>
    </div>`;
    container.appendChild(overlay);
    overlay.querySelector('#encClose').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    try {
        const recent = await getRecentSummaries(roleId, 4);
        const raw = await taskManager.watch('citystory', '小城偶遇剧情', async () => {
            const { callAIWithMessages } = await import('../aiService.js');
            return await callAIWithMessages({
                systemPrompt: '你是"模拟小城"的剧情生成器。根据两人的小城人设与当前情境，生成一段简短的双人偶遇互动。要求：' +
                    '1. 剧情生动有生活感，像小说片段——避免总结腔、排比句、"不禁让人…""仿佛…"这类AI套话' +
                    '2. 输出格式：【概要】一行话概括这次偶遇（40字以内）\n【正文】3000~6000字的完整剧情' +
                    '3. 参考【最近偶遇概要】，尽量避免重复或雷同（主题、场景、展开方式都要避开）' +
                    '只输出这两部分，不要任何其他文字。',
                userContent: `【我（${esc(profile.name)}）】\n职业：${profile.job}\n性格标签：${myTraits || '暂无'}\n此刻活动：${actText || `在${placeName}逛逛`}\n\n` +
                    `${friendInfo}\n\n此刻你们在${placeName}偶遇（现在是${hour}点）。请生成这段偶遇剧情。\n\n` +
                    `【最近偶遇概要】\n${recent || '（暂无）'}`,
                maxTokens: 8200, temperature: 0.85
            });
        });
        const { summary, text } = parseStory(raw);
        overlay.querySelector('#encBody').textContent = text || '（对方似乎不想说话…）';
        if (text) {
            await saveStory({
                id: 'st_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
                type: 'park_encounter',
                participants: [roleId, friendId],
                pairKey: [roleId, friendId].sort().join('_'),
                summary, text, timestamp: Date.now()
            });
        }
    } catch (e) {
        overlay.querySelector('#encBody').textContent = '❌ ' + (e.message || '剧情生成失败');
    }
}

// 路人剧情：不创建路人数据，只写入当前角色的回忆
async function showPasserbyStory(container, roleId, profile, placeName) {
    const hour = new Date().getHours();
    const overlay = document.createElement('div');
    overlay.className = 'simcity-pop';
    overlay.innerHTML = `<div class="simcity-pop-card">
        <div style="font-weight:700;font-size:15px;margin-bottom:4px;">🌙 独自散步</div>
        <div style="font-size:12px;color:#999;margin-bottom:10px;">${esc(placeName)} · ${hour}:00</div>
        <div class="sc-pop-body" style="font-size:13px;line-height:1.8;color:#333;white-space:pre-wrap;min-height:60px;">⏳ 剧情生成中…</div>
        <button class="simcity-pop-close" id="psClose">关闭</button>
    </div>`;
    container.appendChild(overlay);
    overlay.querySelector('#psClose').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    try {
        const recent = await getRecentSummaries(roleId, 4);
        const raw = await taskManager.watch('citystory', '小城路人剧情', async () => {
            const { callAIWithMessages } = await import('../aiService.js');
            return await callAIWithMessages({
                systemPrompt: '你是"模拟小城"的剧情生成器。生成一段主角独自散步时遇到的随机路人小插曲。要求：' +
                    '1. 像小说片段一样有生活感，避免AI套话（"不禁…""仿佛…""令人…"这类词）' +
                    '2. 路人可以是流浪猫、卖气球的大叔、跑步的老人、弹吉他的年轻人、放风筝的小孩等，只是过客，不需要名字和设定' +
                    '3. 输出格式：【概要】一行话概括这次插曲（15字以内）\n【正文】100~250字的完整剧情' +
                    '4. 参考【最近偶遇概要】，尽量避免重复或雷同（主题、场景、展开方式都要避开）' +
                    '只输出这两部分，不要任何其他文字。',
                userContent: `【${esc(profile.name)}】\n职业：${profile.job}\n性格标签：${(profile.aiProfile?.traits || []).join('、')}\n\n` +
                    `现在是${hour}点，${esc(profile.name)}在${placeName}独自散步。请生成这段路人偶遇剧情。\n\n` +
                    `【最近偶遇概要】\n${recent || '（暂无）'}`,
                maxTokens: 3000, temperature: 0.85
            });
        });
        const { summary, text } = parseStory(raw);
        overlay.querySelector('.sc-pop-body').textContent = text || '…四周只有风声。';
        if (text) {
            await saveStory({
                id: 'st_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
                type: 'passerby',
                participants: [roleId],
                pairKey: roleId,
                summary, text, timestamp: Date.now()
            });
        }
    } catch (e) {
        overlay.querySelector('.sc-pop-body').textContent = '❌ ' + (e.message || '剧情生成失败');
    }
}

// 执行 AI 回复里的游戏内操作（约定 / 加好友），返回提示列表
async function applyCityActions(text, roleId, profile, friendId) {
    const friendName = getCharacterNameById(friendId) || friendId;
    const done = [];
    const today = new Date().toISOString().slice(0, 10);

    // ① 加游戏好友（双向）
    if (text.includes('【加好友】')) {
        const gf = profile.gameFriends || [];
        if (!gf.some(f => f.id === friendId)) {
            gf.push({ id: friendId, name: friendName });
            profile.gameFriends = gf;
            await saveProfile(profile, roleId);
            const fp = await getProfile(friendId);
            if (fp) {
                const fgf = fp.gameFriends || [];
                if (!fgf.some(f => f.id === roleId)) {
                    fgf.push({ id: roleId, name: profile.name });
                    fp.gameFriends = fgf;
                    await saveProfile(fp, friendId);
                }
            }
            done.push('🤝 已加为游戏好友（双向）');
        }
    }

    // ② 约定（临时 / 永久）
    const m = text.match(/【约定】(\d{1,2})[:：](\d{0,2})(?:[，, ]+(.{2,8}))?/);
    if (m) {
        const time = `${String(parseInt(m[1])).padStart(2, '0')}:00`;
        const place = (m[3] || '').trim();
        if (place) {
            if (text.includes('【永久】')) {
                const sched = [...(profile.schedule || [])];
                sched.push({ time, place, act: `与${friendName}的约定` });
                sched.sort((a, b) => String(a.time).localeCompare(String(b.time)));
                profile.schedule = sched;
                await saveProfile(profile, roleId);
                done.push(`📅 永久日程：${time} 在${place}`);
            } else {
                profile.appointments = [...(profile.appointments || []), { date: today, time, place, act: `与${friendName}的约定` }];
                await saveProfile(profile, roleId);
                done.push(`⏰ 临时约定：今天${time} 在${place}`);
            }
        }
    }
    return done;
}

// 反查角色当前地点（从索引）
function getCharCurrentPlace(placeIndex, charId, hour) {
    for (const [place, hours] of Object.entries(placeIndex || {})) {
        if (hours[hour] && hours[hour].includes(charId)) return place;
    }
    return '';
}

// 进小城时：任一参与方已不在对话地点 → 删除该临时对话
async function cleanupStaleTempChats() {
    try {
        const chats = await getAllChats();
        const hour = new Date().getHours();
        const stale = new Set();
        for (const m of chats) {
            if (!m.temp) continue;
            const aHere = getCharCurrentPlace(placeIndex, m.from, hour) === m.place;
            const bHere = getCharCurrentPlace(placeIndex, m.to, hour) === m.place;
            if (!aHere || !bHere) stale.add(m.id);
        }
        for (const id of stale) await deleteChatMessage(id);
    } catch (e) { console.warn('清理临时对话失败:', e); }
}

async function showCityChat(container, roleId, profile, friendId, placeName, persist = true) {
    const friendName = getCharacterNameById(friendId) || friendId;
    const pairKey = chatPairKey(roleId, friendId);
    const hour = new Date().getHours();
    // ★ 三层关系判断
    const isContact = new CharacterStore(roleId).isFriend(friendId);                 // 真实联系人
    const isGameFriend = (profile.gameFriends || []).some(f => f.id === friendId);   // 游戏好友

    const overlay = document.createElement('div');
    overlay.className = 'simcity-pop';
    overlay.style.alignItems = 'flex-end';
    overlay.innerHTML = `
        <div style="background:white;border-radius:18px 18px 0 0;width:100%;max-height:70%;display:flex;flex-direction:column;box-shadow:0 -10px 40px rgba(0,0,0,0.2);">
            <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #f0f0f0;">
                <div style="display:flex;align-items:center;gap:8px;">
                    <div style="width:30px;height:30px;border-radius:50%;overflow:hidden;">${getAvatarHtml(friendId)}</div>
                    <div>
                        <div style="font-size:14px;font-weight:700;">${esc(friendName)}</div>
                        <div style="font-size:11px;color:#999;">${esc(placeName)} · ${hour}:00${persist ? '' : ' · 临时对话'}</div>
                    </div>
                </div>
                <button id="ccClose" style="border:none;background:none;font-size:18px;color:#999;cursor:pointer;">✕</button>
            </div>
            <div id="ccMsgs" style="flex:1;overflow-y:auto;padding:12px;min-height:200px;"></div>
            <div style="display:flex;gap:8px;padding:10px 12px;border-top:1px solid #f0f0f0;">
                <input id="ccInput" placeholder="说点什么…" style="flex:1;border:1px solid #ddd;border-radius:20px;padding:8px 14px;font-size:13px;outline:none;">
                <button id="ccSend" style="border:none;background:#0b93f6;color:#fff;border-radius:20px;padding:8px 16px;font-size:13px;cursor:pointer;">发送</button>
            </div>
        </div>`;
    container.appendChild(overlay);
    overlay.querySelector('#ccClose').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const msgsEl = overlay.querySelector('#ccMsgs');
    const inputEl = overlay.querySelector('#ccInput');
    // ★ 称呼：联系人→真名可显示游戏名；游戏好友→游戏名；陌生人→"你"
    const myDisplay = isContact || isGameFriend ? profile.name : '你';

    function renderMsgs() {
        msgsEl.innerHTML = messages.map(m => {
            const mine = m.from === roleId;
            return `<div style="display:flex;flex-direction:column;${mine ? 'align-items:flex-end;' : 'align-items:flex-start;'}margin-bottom:8px;">
                <div style="font-size:10px;color:#bbb;margin:0 4px 2px;">${esc(mine ? myDisplay : friendName)}</div>
                <div style="max-width:70%;background:${mine ? '#0b93f6' : '#f0f0f0'};color:${mine ? '#fff' : '#333'};border-radius:14px;padding:8px 12px;font-size:13px;line-height:1.6;white-space:pre-wrap;">${esc(m.text)}</div>
            </div>`;
        }).join('');
        msgsEl.scrollTop = msgsEl.scrollHeight;
    }

    // ★ 读历史：持久读非 temp；临时读 temp + 生命周期检查
    let messages;
    if (persist) {
        messages = (await getChatMessages(pairKey)).filter(m => !m.temp);
    } else {
        const temp = (await getChatMessages(pairKey)).filter(m => m.temp);
        const currentPlace = getCharCurrentPlace(placeIndex, friendId, hour);
        const dialogPlace = temp[0]?.place;
        if (dialogPlace && currentPlace !== dialogPlace) {
            await deleteTempChats(pairKey, dialogPlace);
            messages = [];
        } else {
            messages = temp;
        }
    }
    renderMsgs();

    async function send(text) {
        if (!text.trim()) return;
        const myMsg = { id: 'scm_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4), from: roleId, to: friendId, text: text.trim(), time: Date.now() };
        messages.push(myMsg);
        if (persist) await saveChatMessage(pairKey, myMsg);
        else await saveChatMessage(pairKey, { ...myMsg, temp: true, place: placeName });
        renderMsgs();
        inputEl.value = '';

        const sendBtn = overlay.querySelector('#ccSend');
        sendBtn.disabled = true;
        try {
            // ★ prompt 专用称呼：主视角用游戏名（陌生人也能见），绝不用"你"
            const promptMyName = profile.name;
            let fp = null;
            try { fp = await getProfile(friendId); } catch { }
            // ★ 对方此刻正在做什么（从日程/约定取）
            let friendAct = '';
            if (fp) {
                const nowHour = new Date().getHours();
                const todayStr = new Date().toISOString().slice(0, 10);
                const todayApp = (fp.appointments || []).find(a => a.date === todayStr && parseInt(a.time) === nowHour);
                const cur = (fp.schedule || []).find(s => parseInt(s.time) === nowHour);
                if (todayApp) friendAct = todayApp.act;
                else if (cur) friendAct = cur.act;
            }

            const history = messages.slice(-8).map(m =>
                `${m.from === roleId ? promptMyName : friendName}：${m.text}`).join('\n');
            const rel = isContact ? await readGameData(roleId, 'relations', () => new CharacterStore(roleId).getRelationById(friendId)) : null;
            const realName = isContact ? getCharacterNameById(roleId) : null;

            let myInfo;
            if (isContact) {
                myInfo = `【我】小城名：${profile.name}（职业：${profile.job}）\n性格：${(profile.aiProfile?.traits || []).join('、')}` +
                    (realName ? `\n真实身份：${realName}` : '') +
                    (rel?.relation ? `\n你和ta的关系：${rel.relation}` : '');
            } else if (isGameFriend) {
                myInfo = `【我】小城名：${profile.name}（职业：${profile.job}）\n性格：${(profile.aiProfile?.traits || []).join('、')}`;
            } else {
                myInfo = `【我】小城名：${profile.name}（你不了解更多）`;
            }

            const reply = await taskManager.watch('citychat', `小城对话 · ${friendName}`, async () => {
                const { callAIWithMessages } = await import('../aiService.js');
                return await callAIWithMessages({
                    systemPrompt: '你是"模拟小城"的居民。现在有人在小城里和你聊天。要求：' +
                        '1. 完全以你的小城身份回应，自然口语化，像真人聊天，避免AI腔' +
                        '2. 【重要】你此刻正在「' + placeName + '」（' + hour + '点），正在做：「' + (friendAct || ('在' + placeName + '待着')) + '」。' +
                        '只围绕【此刻这个场景】回应——你现在在哪、正在做什么、遇到的人是谁，都必须基于当前环境；' +
                        '绝不要提及此刻不在场的日常（比如在家训练、白天的安排、网上的事）' +
                        '3. 回应简短（20~60字）' +
                        '4. 如果对方提出约定或加好友：' +
                        '   同意约定 → 回复末尾加【约定】HH:MM 地点（临时约定）；长期约定加【约定】HH:MM 地点【永久】' +
                        '   同意加好友 → 回复末尾加【加好友】' +
                        '   不想答应 → 自然委婉拒绝，不要输出任何标记' +
                        '5. 只输出对话内容（可含上述标记），不要任何解释',
                    userContent: `${myInfo}\n\n` +
                        (fp ? `【你】小城名：${fp.name}（职业：${fp.job}）\n性格：${(fp.aiProfile?.traits || []).join('、')}\n` : `【你】${friendName}\n（未入住小城，作为路人回应）\n`) +
                        `此刻：${placeName}（${hour}点），你正在「${friendAct || ('在' + placeName + '待着')}」\n\n` +
                        `【对话历史】\n${history || '（刚开始聊）'}\n\n` +
                        `请以你的身份回复${promptMyName}最近这句话：「${text}」`,
                    maxTokens: 800, temperature: 0.85
                });
            });
            if (!overlay.isConnected) return;

            const actions = await applyCityActions(reply, roleId, profile, friendId);

            const replyMsg = { id: 'scm_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4), from: friendId, to: roleId, text: reply.trim(), time: Date.now() };
            if (persist) {
                messages.push(replyMsg);
                await saveChatMessage(pairKey, replyMsg);
            } else {
                messages.push(replyMsg);
                await saveChatMessage(pairKey, { ...replyMsg, temp: true, place: placeName });
            }
            renderMsgs();
            if (actions.length) toast(actions.join('、'), '#2e7d32');
        } catch (e) {
            console.warn('小城对话失败:', e);
        } finally {
            if (overlay.isConnected) sendBtn.disabled = false;
        }
    }

    overlay.querySelector('#ccSend').addEventListener('click', () => send(inputEl.value));
    inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(inputEl.value); });
}

// apps/games/simCity.js — 模拟小城（角色联动模拟经营，IndexedDB 存储）
import { CharacterStore, getActiveCharacterId } from '../../store/CharacterStore.js';
import { getCharacterNameById } from '../characterManager.js';
import { getAvatarHtml } from '../../store/ImageCache.js';
import { isArchived } from '../roleData.js';
import { esc } from '../../store/utils.js';
import { getProfile, saveProfile, saveStory, getStories, deleteStory, buildPlaceIndex, getPresentAt, chatPairKey, getChatMessages, saveChatMessage, getAllChats, deleteChatMessage, getAllProfiles } from './simCityStore.js';
import { taskManager } from '../../store/AITaskManager.js';

export const id = 'simCity';
export const label = '模拟小城';
export const icon = '🏙️';
export const color = '#7c4dff';

let simCityCtx = null;   // 当前小城上下文：AI 完成后判断是否弹窗
let placeIndex = {};   // 当前小城地点×时段索引
let mapScrollLeft = 0;          // ★ 地图停留位置（从地点返回时恢复）
let propertyAreaIndex = {};    // ★ 区域→房产索引（"附近房产"可见性查询）
let charDisplayMap = {};       // ★ id→公开显示索引（只存游戏名+职业；私密数据不进入，完整档案走 getProfile）

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

// ★ 区域 → 房产列表索引（重建：进小城 / 买房后）
async function buildPropertyAreaIndex() {
    const profiles = await getAllProfiles();
    const idx = {};
    for (const p of profiles) {
        for (const prop of (p.properties || [])) {
            (idx[prop.area] = idx[prop.area] || []).push({ ownerId: p.id, ownerName: p.name, prop });
        }
    }
    return idx;
}

// ★ 每日工资结算：底薪保底天天发 + 工时×时薪；补算上次结算至今的所有日期
async function settleSalaries(mainRoleId) {
    const profiles = await getAllProfiles();
    const today = new Date();
    let mainGain = 0;
    for (const p of profiles) {
        const job = p.jobKey && JOB_DEFS[p.jobKey];
        if (!job) { if (!p.lastPayDay) p.lastPayDay = dayStr(new Date(today.getTime() - 86400000)); continue; }
        const last = p.lastPayDay ? new Date(p.lastPayDay) : new Date(today.getTime() - 86400000);
        const days = Math.max(0, daysBetween(last, today) - 1);   // 结算到昨天
        if (days <= 0) continue;
        const hours = workHoursFromIndex(placeIndex, jobWorkNames(job), p.id);
        const gain = days * (job.base + hours * job.hourly);
        if (gain > 0) p.money = (p.money || 0) + gain;
        p.lastPayDay = dayStr(new Date(today.getTime() - 86400000));
        if (p.id === mainRoleId) mainGain = gain;
        await saveProfile(p, p.id);
    }
    if (mainGain > 0) toast(`💼 工资到账 +${mainGain} 金币（含底薪与工时）`, '#2e7d32');
    return profiles;   // ★ 复用本次快照（start 用它建 cityProfileMap，零额外扫描）
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
    propertyAreaIndex = await buildPropertyAreaIndex();   // ★ 区域→房产索引
    const allProfiles = await settleSalaries(roleId);   // ★ 每日工资结算（补算离线天数）
    charDisplayMap = {};
    (allProfiles || []).forEach(p => { charDisplayMap[p.id] = { name: p.name || '', jobKey: p.jobKey || '', energy: p.energy || 100 }; });
    await cleanupStaleTempChats();
    const back = () => { simCityCtx = null; onBack && onBack(); };
    const profile = await getProfile(roleId);
    if (profile) {
        mapScrollLeft = 0;      // ★ 重新进小城回到第 1 页
        renderMain(container, globalState, back, roleId, profile);
    }

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
                <div style="font-size:12px;color:#999;margin-bottom:6px;">职业（自称，AI评估后正式定岗）</div>
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
            lastPayDay: dayStr(new Date(Date.now() - 86400000)),   // ★ 昨天=注册基准日，明天起开始结算
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
            '3) schedule：该角色在小城的一天基础日程表（6~8个时段，含时间/地点/活动，体现职业，一个时段只选取一个地点）' +
            '地点只能从小城地点中选择：家、杂货店、市政厅、公园、中心广场、诊所、游乐场、银行、画廊、商业街、娱乐街、学校，以及其中的具体地点（商场、奶茶店、餐厅、游戏厅、KTV、酒吧、教学楼、操场）。' +
            '职业只能从以下登记职位中选择（写入"job"字段，如"school-teach-teacher"）：' +
            `${Object.entries(JOB_DEFS).map(([k, j]) => `${k}(${j.name})`).join('、')}。` +
            '根据角色设定选最合适的（注册时的自称职业仅供参考，可修正为更合适的职位；学生可选"school-student"）。' +

            '营业时间（未列出的地点全天开放，商业街/娱乐街全天可安排夜市夜宵）：商场10:00~22:00、奶茶店9:00~23:00、餐厅10:00~22:00、游戏厅10:00~24:00、KTV19:00~凌晨02:00、酒吧19:00~凌晨02:00、教学楼8:00~21:00、操场6:00~22:00、学校6:00~22:00；不要安排角色在打烊时间去。' +
            '时间用整点或半点，小时统一两位数字（如02:00、08:00、14:30），按时间顺序排列。' +
            // ★ 作息：休息时间段 + 回家时间点
            '每天给出一个"休息时间段"（rest字段，如"23:00~07:00"：普通人晚上、夜班角色白天、夜猫子凌晨到中午），表示该角色睡觉、不可打扰的时段；日程里还要安排回到家的时间点（如22:00 家 休息）。' +
            // ★ 晚间收尾 + 夜生活分层（保留）
            '晚上（18:00~22:00）是普通晚间（晚饭、散步、在家休息）；夜生活（22:00~次日2:00甚至更晚）只属于部分夜猫子角色（酒吧驻唱、KTV通宵、深夜在公园徘徊、游戏厅开黑、加班、夜市摆摊等，地点可用酒吧、KTV、游戏厅、公园、商业街、中心广场等），夜猫子玩到凌晨也要回家。' +
            '只输出JSON：{"job":"school-teach-teacher","comment":"评语","traits":["标签"],"rest":"23:00~07:00","schedule":[{"time":"08:00","place":"杂货店","act":"整理货架"}]}，不要任何其他文字。',


        userContent: `角色信息：\n${roleInfo}\n\n`
            + `当前日程：${JSON.stringify(profile.schedule || [])}`
            + (suggestion.trim() ? `角色本人想对评估官说的话：\n${suggestion.trim()}\n\n` : '')
            + `请给出评估评语、标签与日程表（JSON）。`,

        maxTokens: 12000,
        temperature: 0.8
    });
    const data = parseAiJson(raw || '');

    // ★ 存储分层：
    profile.schedule = data.schedule || [];        // 日程表单独存（影响默认行为逻辑）

    // ★ 职业写入：目标职位存在且未满 → 覆盖 jobKey（旧职位实时释放）；否则保留现职业
    if (data.job && JOB_DEFS[data.job]) {
        const counts = await getJobCounts();
        if ((counts[data.job] || 0) < JOB_DEFS[data.job].quota) {
            profile.jobKey = data.job;
            charDisplayMap[roleId] = { name: profile.name || '', jobKey: profile.jobKey || '', energy: profile.energy || 100 };
        } else {
            toast('🔁 目标职位已满，保留当前职业', '#999');
        }
    }

    // ★ 解析休息时间段（AI输出如"23:00~07:00"）→ 只用于聊天拦截
    const rm = /^(\d{1,2}):\d{2}~(\d{1,2})/.exec(String(data.rest || ''));
    if (rm) profile.rest = { from: parseInt(rm[1]), to: parseInt(rm[3]) };

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
const PLACES = [
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
    { key: 'entertain', name: '娱乐街', icon: '🎪', image: '', act: 'fun', desc: '娱乐放松' },
    { key: 'school', name: '学校', icon: '🏫', image: '', act: 'study', desc: '学习充电' },
    // ★ 子地点：与普通地点同构，多一个 parent 字段；不进地图，从上级地点卡片进入
    { key: 'mallshop', name: '商场', icon: '🏬', act: 'shop', desc: '逛街淘货', parent: 'mall' },
    { key: 'milktea', name: '奶茶店', icon: '🧋', act: 'drink', desc: '喝杯奶茶提神', parent: 'mall' },
    { key: 'restaurant', name: '餐厅', icon: '🍽️', act: 'eat', desc: '吃顿好的恢复体力', parent: 'mall' },
    { key: 'agency', name: '房产中介', icon: '🏢', act: 'agency', desc: '选购房产', parent: 'mall' },
    { key: 'arcade', name: '游戏厅', icon: '🕹️', act: 'arcade', desc: '打游戏放松', parent: 'entertain' },
    { key: 'ktv', name: 'KTV', icon: '🎤', act: 'ktv', desc: '唱歌宣泄心情', parent: 'entertain' },
    { key: 'bar', name: '酒吧', icon: '🍸', act: 'bar', desc: '夜晚小酌一杯', parent: 'entertain' },
    { key: 'teach', name: '教学楼', icon: '📚', act: 'study', desc: '学习充电', parent: 'school' },
    { key: 'playground', name: '操场', icon: '🏟️', act: 'sport', desc: '运动锻炼', parent: 'school' },

];

// 地图格子：没有 parent 的地点（12 个）
const MAP_PLACES = PLACES.filter(p => !p.parent);
// 子地点列表（按数组顺序）：parent.key → 子地点数组
const childrenOf = key => PLACES.filter(p => p.parent === key);
// 任意地点查找（含子地点）
const findPlace = key => PLACES.find(p => p.key === key) || PLACES[0];

// 房子模板：全局静态配置，房产实例只存 template key（不复制模板）
const HOUSE_TEMPLATES = {
    default: { name: '基础小窝', icon: '🏠', price: 0, area: '家', desc: '每个角色都有的默认房子' },
    apartment: { name: '高层公寓', icon: '🏢', price: 800, area: '住房区', desc: '城里的高层公寓' },
    shopHouse: { name: '临街小楼', icon: '🏘️', price: 1500, area: '商业街', desc: '商业街旁的二层小楼' },
    farmHouse: { name: '田园小屋', icon: '🌾', price: 1000, area: '郊外', desc: '带小院子的田园小屋' },
    villa: { name: '独栋别墅', icon: '🏡', price: 3000, area: '别墅区', desc: '独栋带花园' },
};

// 职业表：单一数据源（地点-详细地点-职位 命名，便于同种类不同地点扩展）
// 消费方：AI评估 / 场景应聘 / 每日结算 / 市政厅登记表——只改这张表全系统联动
const JOB_DEFS = {
    'hall-hall-clerk': { name: '市政厅·文员', placeKey: 'hall', subKey: '', base: 40, hourly: 22, quota: 3, hallStaff: true },
    'mall-mallshop-owner': { name: '商业街·商场·店主', placeKey: 'mall', subKey: 'mallshop', base: 0, hourly: 45, quota: 2, hallStaff: false },
    'mall-restaurant-chef': { name: '商业街·餐厅·厨师', placeKey: 'mall', subKey: 'restaurant', base: 0, hourly: 38, quota: 2, hallStaff: false },
    'mall-milktea-barista': { name: '商业街·奶茶店·奶茶师', placeKey: 'mall', subKey: 'milktea', base: 0, hourly: 25, quota: 2, hallStaff: false },
    'entertain-ktv-singer': { name: '娱乐街·KTV·驻唱', placeKey: 'entertain', subKey: 'ktv', base: 0, hourly: 30, quota: 2, hallStaff: false },
    'school-teach-teacher': { name: '学校·教学楼·教师', placeKey: 'school', subKey: 'teach', base: 30, hourly: 32, quota: 5, hallStaff: false },
    'school-student': { name: '学校·学生', placeKey: 'school', subKey: '', base: 0, hourly: 0, quota: 999, hallStaff: false },
    'clinic-clinic-doctor': { name: '诊所·医生', placeKey: 'clinic', subKey: '', base: 50, hourly: 40, quota: 2, hallStaff: false },
    'clinic-clinic-nurse': { name: '诊所·护士', placeKey: 'clinic', subKey: '', base: 20, hourly: 28, quota: 3, hallStaff: false },
};

// 职位上班地点名列表（工时统计用）：绑了详细地点就用它，否则用地点名
function jobWorkNames(jobDef) {
    const names = [];
    const p = findPlace(jobDef.placeKey);
    if (p) names.push(p.name);
    if (jobDef.subKey) {
        const s = findPlace(jobDef.subKey);
        if (s) names.push(s.name);
    }
    return names;
}

// 在场状态池（key=地点名，default 兜底）：符合场景 + 人设 + 随机可变
const STATUS_POOLS = {
    '诊所': { main: ['看诊中', '问诊中'], busy: ['忙碌中'], fun: ['摸鱼中', '偷瞄手机中'] },
    '教学楼': { main: ['上课中', '批改作业中'], busy: ['赶教案中'], fun: ['摸鱼中', '发呆中'] },
    '市政厅': { main: ['办公中', '处理公文'], busy: ['开会中'], fun: ['摸鱼中', '喝茶看报中'] },
    '餐厅': { main: ['掌勺中', '出餐中'], busy: ['忙碌中'], fun: ['摸鱼中', '试菜中'] },
    '奶茶店': { main: ['调制饮品中', '备料中'], busy: ['排队爆单中'], fun: ['摸鱼中', '偷喝珍珠中'] },
    'KTV': { main: ['驻唱中', '点歌中'], busy: ['应酬中'], fun: ['摸鱼中', '跑调排练中'] },
    '酒吧': { main: ['调酒中', '接待中'], busy: ['全场最忙'], fun: ['摸鱼中', '偷尝新酒中'] },
    '操场': { main: ['训练中', '带跑中'], busy: ['组织活动'], fun: ['摸鱼中', '散步偷懒中'] },
    '商场': { main: ['理货中', '接待顾客中'], busy: ['忙碌中'], fun: ['摸鱼中', '溜号中'] },
    '游戏厅': { main: ['看机台中', '维护设备中'], busy: ['忙碌中'], fun: ['摸鱼中', '偷玩一把中'] },
    'default': { main: ['工作中', '忙碌中'], busy: ['连轴转中'], fun: ['摸鱼中', '发呆中'] },
};

// 角色当前状态：只有"此刻在该角色自己的上班地点"才返回状态文案，否则空串
function charStatus(id, placeName) {
    const p = charDisplayMap[id];
    if (!p || !p.jobKey) return '';
    const job = JOB_DEFS[p.jobKey];
    if (!job) return '';
    if (!jobWorkNames(job).includes(placeName)) return '';
    const pool = STATUS_POOLS[placeName] || STATUS_POOLS['default'];
    const roll = Math.random();
    const group = (p.energy < 30 && roll < 0.4) ? 'fun'
        : roll < 0.6 ? 'main'
            : roll < 0.85 ? 'busy'
                : 'fun';
    const list = pool[group];
    return list[Math.floor(Math.random() * list.length)] || '';
}

// 当前状态：内部查当前位置再取状态（好友列表等无地点上下文的场景用）
function statusNow(id, hour) {
    const place = getCharCurrentPlace(placeIndex, id, hour);
    if (!place) return '';
    return charStatus(id, place);   // ★ 复用现有 charStatus，不重复写判定逻辑
}

// 当前日程条目（覆盖语义：一条覆盖到下一条开始，与索引一致）
function curScheduleEntry(schedule, hour) {
    const sorted = [...(schedule || [])]
        .filter(s => s && s.time && /^\d{1,2}:\d{2}$/.test(String(s.time)))
        .sort((a, b) => String(a.time).localeCompare(String(b.time)));
    for (let i = 0; i < sorted.length; i++) {
        const h = parseInt(String(sorted[i].time));
        const end = sorted[i + 1] ? parseInt(String(sorted[i + 1].time)) : 24;
        if (hour >= h && hour < end) return sorted[i];
    }
    return null;
}

// 各职位当前在编人数（配额实时派生：覆盖职业即自动释放旧职位）
async function getJobCounts() {
    const profiles = await getAllProfiles();
    const counts = {};
    for (const p of profiles) if (p.jobKey) counts[p.jobKey] = (counts[p.jobKey] || 0) + 1;
    return counts;
}

// 日期工具（本地日期）
function dayStr(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function daysBetween(from, to) {
    // ★ 只取本地日历日期（年月日）算差值，避免 UTC 解析的时区偏移导致重复结算
    const f = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    const t = new Date(to.getFullYear(), to.getMonth(), to.getDate());
    return Math.round((t - f) / 86400000);
}

// 工时：复用在场索引（与日程覆盖语义一致，含跨天循环）
function workHoursFromIndex(placeIndex, workNames, roleId) {
    let h = 0;
    for (let hh = 0; hh < 24; hh++) {
        if (workNames.some(w => placeIndex[w] && placeIndex[w][hh] && placeIndex[w][hh].includes(roleId))) h++;
    }
    return h;
}

// 角色职业显示：正式职业才叫"职业"，自己填的一律叫"自称"
function jobDisplay(profile) {
    const formal = profile.jobKey && JOB_DEFS[profile.jobKey];
    const claim = (profile.job && profile.job !== '自由职业') ? profile.job : '';
    if (formal && claim) return `职业：${formal.name}（自称${claim}）`;
    if (formal) return `职业：${formal.name}`;
    if (claim) return `自称：${claim}`;
    return '自由职业';
}

// 该地点的职位（可折叠区块，默认收起）
function jobsCollapseHtml(jobsHere, profile) {
    if (!jobsHere.length) return '';
    return `
        <div style="margin-top:12px;">
            <div id="jobsToggle" style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:rgba(255,255,255,0.9);border-radius:14px;cursor:pointer;box-shadow:0 1px 6px rgba(0,0,0,0.06);">
                <span style="font-size:13px;font-weight:600;color:#8d6e63;">🧾 该地点的职位</span>
                <span class="jobs-arrow" style="font-size:12px;color:#bcaaa4;">▾</span>
            </div>
            <div class="jobs-list" style="display:none;margin-top:8px;">
                <div class="simcity-room">
                    ${jobsHere.map(([k, j]) => {
        const current = profile.jobKey === k;
        return `
                        <div class="simcity-item apply-job" data-job="${esc(k)}">
                            <div class="item-name">${esc(j.name)}</div>
                            <div class="item-desc">时薪${j.hourly} · 底薪${j.base}${current ? ' · 已就职' : ''}</div>
                        </div>`;
    }).join('')}
                </div>
            </div>
        </div>`;
}

// 绑定折叠开关（点标题展开/收起）
function bindJobsToggle(container) {
    const toggle = container.querySelector('#jobsToggle');
    if (!toggle) return;
    toggle.addEventListener('click', () => {
        const list = toggle.nextElementSibling;
        const arrow = toggle.querySelector('.jobs-arrow');
        const open = list.style.display !== 'none';
        list.style.display = open ? 'none' : 'block';
        arrow.textContent = open ? '▾' : '▴';
    });
}

// 营业时间表：place.key → [开门, 打烊)，跨午夜如酒吧[19,2]；未列出 = 全天开放
const OPEN_HOURS = {
    mallshop: [10, 22],       // 商场
    milktea: [9, 23],         // 奶茶店
    restaurant: [10, 22],     // 餐厅
    arcade: [10, 24],         // 游戏厅
    ktv: [19, 2],            // KTV
    bar: [19, 2],             // 酒吧（跨午夜）
    school: [6, 22],          // 学校
    teach: [8, 21],           // 教学楼
    playground: [6, 22],      // 操场
};
function venueOpen(placeKey, hour) {
    const h = OPEN_HOURS[placeKey];
    if (!h) return true;
    return h[0] <= h[1] ? (hour >= h[0] && hour < h[1]) : (hour >= h[0] || hour < h[1]);
}

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
                        <div class="cjob">${esc(jobDisplay(profile))} · 已入住 ${Math.floor((Date.now() - profile.createdAt) / 86400000) + 1} 天</div>
                    </div>
                </div>

                <div class="simcity-stats">
                    <div class="simcity-stat"><div class="v">💰 ${profile.money}</div><div class="k">金钱</div></div>
                    <div class="simcity-stat"><div class="v">⚡ ${profile.energy}</div><div class="k">体力</div></div>
                    <div class="simcity-stat"><div class="v">😊 ${profile.mood}</div><div class="k">心情</div></div>
                </div>

                                <div class="simcity-map">
                    <div class="simcity-pages">
                        ${chunk(MAP_PLACES, 9).map(page => `
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
        plot.addEventListener('click', () => {
            const m = container.querySelector('.simcity-map');
            mapScrollLeft = m ? m.scrollLeft : 0;   // ★ 记住离开时的横向位置
            renderPlace(container, globalState, onBack, roleId, profile, plot.dataset.key);
        });
    });
    // ★ 返回地图时恢复上次停留页
    const m = container.querySelector('.simcity-map');
    if (m && mapScrollLeft) m.scrollLeft = mapScrollLeft;

}

// 模块级：执行地点行动
async function doAction(container, globalState, onBack, roleId, profile, act, afterRender) {
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
    } else if (act === 'agency') {         // ★ 房产中介：弹窗选购（不改变子地点规则）
        showAgencyBuy(container, globalState, onBack, roleId, profile);
        return;
    } else if (act === 'drink') {          // ★ 奶茶店
        if (profile.money < 15) { toast('💰 金币不足', '#e53935'); return; }
        profile.money -= 15; profile.mood = Math.min(100, profile.mood + 12); profile.energy = Math.min(100, profile.energy + 5);
        toast('🧋 喝了一杯奶茶，心情+12', '#8d6e63');
    } else if (act === 'eat') {            // ★ 餐厅
        if (profile.money < 40) { toast('💰 金币不足', '#e53935'); return; }
        profile.money -= 40; profile.energy = Math.min(100, profile.energy + 35); profile.mood = Math.min(100, profile.mood + 8);
        toast('🍽️ 饱餐一顿，体力+35', '#ff7043');
    } else if (act === 'arcade') {         // ★ 游戏厅
        if (profile.money < 30) { toast('💰 金币不足', '#e53935'); return; }
        profile.money -= 30; profile.mood = Math.min(100, profile.mood + 20); profile.energy -= 10;
        toast('🕹️ 在游戏厅玩得很嗨！', '#7c4dff');
    } else if (act === 'ktv') {            // ★ KTV
        if (profile.money < 50) { toast('💰 金币不足', '#e53935'); return; }
        profile.money -= 50; profile.mood = Math.min(100, profile.mood + 25); profile.energy -= 15;
        toast('🎤 唱了一晚，心情+25', '#e91e63');
    } else if (act === 'bar') {            // ★ 酒吧
        if (profile.money < 45) { toast('💰 金币不足', '#e53935'); return; }
        profile.money -= 45; profile.mood = Math.min(100, profile.mood + 15); profile.energy = Math.max(0, profile.energy - 5);
        toast('🍸 小酌一杯，微醺放松', '#ff9800');
    } else if (act === 'study') {          // ★ 学校 / 教学楼
        profile.energy = Math.max(0, profile.energy - 15); profile.mood = Math.min(100, profile.mood + 10);
        toast('📚 认真学了一会儿，收获满满', '#0b93f6');
    } else if (act === 'sport') {          // ★ 操场
        if (profile.energy < 10) { toast('⚡ 体力不足，先去休息吧', '#ff9800'); return; }
        profile.energy = Math.max(0, profile.energy - 15); profile.mood = Math.min(100, profile.mood + 15);
        toast('🏟️ 跑了几圈，出了一身汗', '#2e7d32');
    }
    await save();
    (afterRender || renderMain)(container, globalState, onBack, roleId, profile);
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
                    <div style="flex:1;font-size:13px;font-weight:600;">${esc((charDisplayMap[id] && charDisplayMap[id].name) || getCharacterNameById(id) || id)}${(() => {
            const st = charStatus(id, placeName);
            return st ? `<span style="font-size:11px;color:#bbb;font-weight:400;">（${st}）</span>` : '';
        })()}</div>
                    <button class="sc-encounter" data-friend="${esc(id)}" data-place="${esc(placeName)}"
                        style="border:none;background:#7c4dff;color:#fff;border-radius:12px;padding:5px 12px;font-size:12px;cursor:pointer;">偶遇</button>
                    <button class="sc-chat" data-friend="${esc(id)}" data-place="${esc(placeName)}"
                        style="border:none;background:#0b93f6;color:#fff;border-radius:12px;padding:5px 12px;font-size:12px;cursor:pointer;">对话</button>
                </div>`).join('')}
        </div>`;
}

// 地点环境描述（随时段变化，仅装饰，不可点击）
function placeAmbience(place, hour) {
    if (hour >= 22 || hour < 5) return `夜色下的${place.name}，路灯昏黄，行人稀少`;
    if (hour < 8) return `清晨的${place.name}刚刚苏醒，空气清新`;
    if (hour < 12) return `上午的${place.name}渐渐热闹起来`;
    if (hour < 14) return `午后的${place.name}暖洋洋的，适合发呆`;
    if (hour < 18) return `${place.name}里人来人往`;
    return `傍晚的${place.name}灯火初上`;
}

// 地点内部视图分发
function renderPlace(container, globalState, onBack, roleId, profile, placeKey) {
    const place = findPlace(placeKey);
    if (placeKey === 'home') { renderHome(container, globalState, onBack, roleId, profile); return; }
    if (placeKey === 'park') { renderPark(container, globalState, onBack, roleId, profile); return; }
    if (placeKey === 'hall') { renderHall(container, globalState, onBack, roleId, profile); return; }

    const hour = new Date().getHours();
    const open = venueOpen(place.key, hour);
    const children = childrenOf(place.key);
    const jobsHere = Object.entries(JOB_DEFS).filter(([, j]) => j.placeKey === place.key && !j.subKey);

    container.innerHTML = `
        <div class="simcity-root">
            <div class="simcity-header">
                <button class="back-btn" id="placeBack">←</button>
                <span class="title">${place.icon} ${esc(place.name)}</span>
                <span class="level"></span>
            </div>
            <div class="simcity-body">
                <div class="simcity-room">
                    <div class="simcity-env">
                        <div class="env-icon">${place.icon}</div>
                        <div class="env-name">${esc(place.name)}</div>
                        <div class="env-desc">${placeAmbience(place, hour)}</div>
                    </div>                    
                    ${children.map(c => {
        const cOpen = venueOpen(c.key, hour);
        return `
                        <div class="simcity-item sub-place" data-sub="${esc(c.key)}" style="${cOpen ? '' : 'opacity:0.5;'}">
                            <div class="item-icon">${c.icon}</div>
                            <div class="item-name">${esc(c.name)}</div>
                            <div class="item-desc">${cOpen ? '进入 · ' + esc(c.desc) : '🌙 已打烊'}</div>
                        </div>`;
    }).join('')}
                </div>
                <div class="simcity-actions" style="margin-top:10px;">
                    <button class="simcity-btn primary" id="placeActBtn" style="${open ? '' : 'opacity:0.5;'}">${place.icon} ${esc(place.desc)}${open ? '' : '（已打烊）'}</button>
                    ${(['mall', 'entertain'].includes(place.key) && (hour >= 19 || hour < 5)) ? `<button class="simcity-btn" id="placeNightBtn" style="margin-top:10px;">🌙 夜生活事件</button>` : ''}

                </div>
                ${jobsCollapseHtml(jobsHere, profile)}
                ${open
            ? presentSectionHtml(place.name, roleId)
            : `<div style="font-size:12px;color:#999;text-align:center;padding:10px;">🌙 已打烊，${esc(place.name)}要等${OPEN_HOURS[place.key][0]}:00 开门</div>`}
                <div style="font-size:12px;color:#999;text-align:center;margin-top:10px;">更多互动布置中…</div>
            </div>
        </div>`;
    // ★ 返回：普通地点回地图；若本身是子地点则回上级（兼容深层嵌套）
    container.querySelector('#placeBack').addEventListener('click', () => place.parent
        ? renderPlace(container, globalState, onBack, roleId, profile, place.parent)
        : renderMain(container, globalState, onBack, roleId, profile));
    container.querySelector('#placeActBtn').addEventListener('click', () => {
        if (!open) { toast(`🌙 ${place.name}还没开门（${OPEN_HOURS[place.key][0]}:00 营业）`, '#ff9800'); return; }
        doAction(container, globalState, onBack, roleId, profile, place.act, () => renderPlace(container, globalState, onBack, roleId, profile, place.key));
    });
    const pnb = container.querySelector('#placeNightBtn');
    if (pnb) pnb.addEventListener('click', () => showNightEvent(container, roleId, profile, place.name, null));

    container.querySelectorAll('.apply-job').forEach(card => {
        card.addEventListener('click', async () => {
            const k = card.dataset.job;
            const j = JOB_DEFS[k];
            if (profile.jobKey === k) { toast('🧾 已经就职这个职位了', '#999'); return; }
            const counts = await getJobCounts();
            if ((counts[k] || 0) >= j.quota) { toast(`🔒 ${j.name} 职位已满（${counts[k] || 0}/${j.quota}）`, '#e53935'); return; }
            profile.jobKey = k;
            charDisplayMap[roleId] = { name: profile.name || '', jobKey: profile.jobKey || '', energy: profile.energy || 100 };
            await saveProfile(profile, roleId);
            toast(`🧾 正式入职：${j.name}！`, '#2e7d32');
            renderPlace(container, globalState, onBack, roleId, profile, place.key);
        });
    });
    bindJobsToggle(container);

    // ★ 子地点卡片：进入子地点页面
    container.querySelectorAll('.sub-place').forEach(card => {
        card.addEventListener('click', () => {
            const sub = findPlace(card.dataset.sub);
            if (!sub) return;
            if (!venueOpen(sub.key, hour)) { toast(`🌙 ${sub.name}已打烊，${OPEN_HOURS[sub.key][0]}:00 开门`, '#ff9800'); return; }
            renderSubPlace(container, globalState, onBack, roleId, profile, sub);
        });
    });
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

// 子地点页面：独立地点（有自己在场），返回按钮回上级地点
function renderSubPlace(container, globalState, onBack, roleId, profile, sub) {
    const parentPlace = findPlace(sub.parent);
    const jobsHere = Object.entries(JOB_DEFS).filter(([, j]) => j.placeKey === parentPlace.key && j.subKey === sub.key);

    const hour = new Date().getHours();
    const open = venueOpen(sub.key, hour);
    container.innerHTML = `
        <div class="simcity-root">
            <div class="simcity-header">
                <button class="back-btn" id="subBack">←</button>
                <span class="title">${sub.icon} ${esc(sub.name)}</span>
                <span class="level">${esc(parentPlace.name)}</span>
            </div>
            <div class="simcity-body">
                <div class="simcity-room">
                    <div class="simcity-env">
                        <div class="env-icon">${sub.icon}</div>
                        <div class="env-name">${esc(sub.name)}</div>
                        <div class="env-desc">${placeAmbience(sub, hour)}</div>
                    </div>
                </div>
${(NIGHT_SPOTS.includes(sub.key) && (hour >= 19 || hour < 5) && venueOpen(sub.key, hour)) ? `
                <div style="font-size:11px;color:#a1887f;margin:8px 2px;line-height:1.6;">${(NIGHT_SCENES[sub.key]?.vibes || ['深夜的' + sub.name + '很安静'])[Math.floor(Math.random() * (NIGHT_SCENES[sub.key]?.vibes || [1]).length)]}</div>` : ''}

                <div class="simcity-actions" style="margin-top:10px;">
                    <button class="simcity-btn primary" id="subActBtn" style="${open ? '' : 'opacity:0.5;'}">${sub.icon} ${esc(sub.desc)}${open ? '' : '（已打烊）'}</button>
                    ${(NIGHT_SPOTS.includes(sub.key) && (hour >= 19 || hour < 5) && venueOpen(sub.key, hour)) ? `<button class="simcity-btn" id="nightEventBtn" style="margin-top:10px;">🌙 夜生活事件</button>` : ''}

                </div>
                ${jobsCollapseHtml(jobsHere, profile)}
                ${open
            ? presentSectionHtml(sub.name, roleId)
            : `<div style="font-size:12px;color:#999;text-align:center;padding:10px;">🌙 已打烊，${esc(sub.name)}要等${OPEN_HOURS[sub.key][0]}:00 开门</div>`}
                <div style="font-size:12px;color:#999;text-align:center;margin-top:10px;">更多互动布置中…</div>
            </div>
        </div>`;
    container.querySelector('#subBack').addEventListener('click', () => renderPlace(container, globalState, onBack, roleId, profile, sub.parent));
    container.querySelector('#subActBtn').addEventListener('click', () => {
        if (!open) { toast(`🌙 ${sub.name}还没开门（${OPEN_HOURS[sub.key][0]}:00 营业）`, '#ff9800'); return; }
        doAction(container, globalState, onBack, roleId, profile, sub.act, () => renderSubPlace(container, globalState, onBack, roleId, profile, sub));
    });
    const neBtn = container.querySelector('#nightEventBtn');
    if (neBtn) neBtn.addEventListener('click', () => showNightEvent(container, roleId, profile, sub.name, sub.key));

    container.querySelectorAll('.apply-job').forEach(card => {
        card.addEventListener('click', async () => {
            const k = card.dataset.job;
            const j = JOB_DEFS[k];
            if (profile.jobKey === k) { toast('🧾 已经就职这个职位了', '#999'); return; }
            const counts = await getJobCounts();
            if ((counts[k] || 0) >= j.quota) { toast(`🔒 ${j.name} 职位已满（${counts[k] || 0}/${j.quota}）`, '#e53935'); return; }
            profile.jobKey = k;
            charDisplayMap[roleId] = { name: profile.name || '', jobKey: profile.jobKey || '', energy: profile.energy || 100 };
            await saveProfile(profile, roleId);
            toast(`🧾 正式入职：${j.name}！`, '#2e7d32');
            renderSubPlace(container, globalState, onBack, roleId, profile, sub);
        });
    });
    bindJobsToggle(container);

    container.querySelectorAll('.sc-encounter').forEach(btn => {
        btn.addEventListener('click', () => showEncounter(container, roleId, profile, btn.dataset.friend, btn.dataset.place));
    });
    container.querySelectorAll('.sc-chat').forEach(btn => {
        btn.addEventListener('click', () => showCityChat(container, roleId, profile, btn.dataset.friend, btn.dataset.place, false));   // ★ 临时
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
                    <button class="simcity-btn" id="hallJobList" style="margin-top:10px;">📋 职业登记表</button>
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
    container.querySelector('#hallJobList').addEventListener('click', async () => {
        const myJob = profile.jobKey && JOB_DEFS[profile.jobKey];
        if (!myJob || !myJob.hallStaff) { toast('🔒 仅限市政厅工作人员查看', '#999'); return; }
        const profiles = await getAllProfiles();
        const list = profiles.filter(p => p.jobKey && JOB_DEFS[p.jobKey]);
        const overlay = document.createElement('div');
        overlay.className = 'simcity-pop';
        overlay.innerHTML = `
            <div class="simcity-pop-card">
                <div style="font-weight:700;font-size:15px;text-align:center;margin-bottom:10px;">📋 职业登记表</div>
                <div class="simcity-pop-list">
                    ${list.map(p => {
            const j = JOB_DEFS[p.jobKey];
            return `<div style="display:flex;justify-content:space-between;padding:8px 4px;border-bottom:1px solid #f0f0f0;font-size:13px;">
                            <span>${esc(p.name)} · ${esc(j.name)}</span>
                            <span style="color:#999;">时薪${j.hourly} · 底薪${j.base}</span>
                        </div>`;
        }).join('') || '<div class="story-empty">登记表为空</div>'}
                </div>
                <button class="simcity-pop-close" id="jobListClose">关闭</button>
            </div>`;
        container.appendChild(overlay);
        overlay.querySelector('#jobListClose').addEventListener('click', () => overlay.remove());
    });

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

// 家的快捷入口：无房产 = 直接进默认房；有房产 = 房子选择页
function renderHome(container, globalState, onBack, roleId, profile) {
    const houses = [
        { key: 'default', icon: '🏠', name: '基础小窝', desc: '每个角色都有的默认房子', prop: null },
        ...(profile.properties || []).map(prop => {
            const t = HOUSE_TEMPLATES[prop.template] || HOUSE_TEMPLATES.default;
            return { key: prop.id, icon: t.icon, name: prop.name || t.name, desc: `${t.area} · ${t.desc}`, prop };
        }),
    ];
    if (houses.length === 1) { renderDefaultHouse(container, globalState, onBack, roleId, profile); return; }

    container.innerHTML = `
        <div class="simcity-root">
            <div class="simcity-header">
                <button class="back-btn" id="homeBack">←</button>
                <span class="title">🏠 家</span>
                <span class="level"></span>
            </div>
            <div class="simcity-body">
                <div class="simcity-room">
                    ${houses.map(h => `
                        <div class="simcity-item house-card" data-key="${esc(h.key)}">
                            <div class="item-icon">${h.icon}</div>
                            <div class="item-name">${esc(h.name)}</div>
                            <div class="item-desc">${esc(h.desc)}</div>
                        </div>`).join('')}
                </div>
                <div style="font-size:12px;color:#999;text-align:center;margin-top:10px;">选择要进入的房子</div>
            </div>
        </div>`;
    container.querySelector('#homeBack').addEventListener('click', () => renderMain(container, globalState, onBack, roleId, profile));
    container.querySelectorAll('.house-card').forEach(card => {
        card.addEventListener('click', () => {
            const h = houses.find(x => x.key === card.dataset.key);
            if (!h) return;
            if (h.prop) renderPropertyPage(container, globalState, onBack, roleId, profile, h.prop);
            else renderDefaultHouse(container, globalState, onBack, roleId, profile);
        });
    });
}

// 家：小房间（桌 + 床）
function renderDefaultHouse(container, globalState, onBack, roleId, profile) {
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

    container.querySelector('#homeBack').addEventListener('click', () =>
        (profile.properties || []).length
            ? renderHome(container, globalState, onBack, roleId, profile)
            : renderMain(container, globalState, onBack, roleId, profile));

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

// 房产中介：弹窗选购房产（点击样式与互动另做，不改变子地点规则）
function showAgencyBuy(container, globalState, onBack, roleId, profile) {
    const overlay = document.createElement('div');
    overlay.className = 'simcity-pop';
    overlay.innerHTML = `
        <div class="simcity-pop-card">
            <div style="font-weight:700;font-size:15px;text-align:center;margin-bottom:10px;">🏢 房产中介 · 在售房产</div>
            <div class="simcity-pop-list">
                ${Object.entries(HOUSE_TEMPLATES).filter(([k]) => k !== 'default').map(([k, t]) => {
        const owned = (profile.properties || []).some(p => p.template === k);
        return `
                    <div class="simcity-item buy-house" data-tpl="${esc(k)}" style="${owned ? 'opacity:0.5;' : ''}">
                        <div class="item-icon">${t.icon}</div>
                        <div class="item-name">${esc(t.name)}</div>
                        <div class="item-desc">${esc(t.area)} · 💰 ${t.price}${owned ? ' · 已拥有' : ''}</div>
                    </div>`;
    }).join('')}
                <div style="font-size:11px;color:#999;margin-top:8px;text-align:center;">💰 当前金币：${profile.money}</div>
            </div>
            <button class="simcity-pop-close" id="agencyClose">关闭</button>
        </div>`;
    container.appendChild(overlay);

    overlay.querySelector('#agencyClose').addEventListener('click', () => overlay.remove());
    overlay.querySelectorAll('.buy-house').forEach(card => {
        card.addEventListener('click', async () => {
            const tpl = HOUSE_TEMPLATES[card.dataset.tpl];
            if ((profile.properties || []).some(p => p.template === card.dataset.tpl)) { toast('🏠 已经拥有这套房产了', '#999'); return; }
            if (profile.money < tpl.price) { toast(`💰 金币不足，还差 ${tpl.price - profile.money}`, '#e53935'); return; }
            profile.money -= tpl.price;
            (profile.properties = profile.properties || []).push({
                id: 'prop_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
                template: card.dataset.tpl,
                name: tpl.name,
                area: tpl.area,
                furniture: [],
                boughtAt: Date.now()
            });
            await saveProfile(profile, roleId);
            propertyAreaIndex = await buildPropertyAreaIndex();   // ★ 重建索引（保留，为以后"邻居"功能备用）
            toast(`🏡 恭喜购入 ${tpl.name}！`, '#2e7d32');
            overlay.remove();
            renderSubPlace(container, globalState, onBack, roleId, profile, findPlace('agency'));   // 重渲染中介页
        });
    });
}

// 房产页面：展示模板外观 + 区域（私有数据，无在场）；返回回"家"选择页
function renderPropertyPage(container, globalState, onBack, roleId, profile, prop) {
    const t = HOUSE_TEMPLATES[prop.template] || HOUSE_TEMPLATES.default;
    container.innerHTML = `
        <div class="simcity-root">
            <div class="simcity-header">
                <button class="back-btn" id="propBack">←</button>
                <span class="title">${t.icon} ${esc(prop.name || t.name)}</span>
                <span class="level">${esc(t.area)}</span>
            </div>
            <div class="simcity-body">
                <div class="simcity-room">
                    <div class="simcity-item" id="propRest">
                        <div class="item-icon">${t.icon}</div>
                        <div class="item-name">${esc(prop.name || t.name)}</div>
                        <div class="item-desc">${esc(t.desc)}</div>
                    </div>
                </div>
                <div style="font-size:12px;color:#999;text-align:center;margin-top:10px;">🏠 家具与装修布置中…</div>
            </div>
        </div>`;
    container.querySelector('#propBack').addEventListener('click', () => renderHome(container, globalState, onBack, roleId, profile));
    container.querySelector('#propRest').addEventListener('click', () => doAction(container, globalState, onBack, roleId, profile, 'rest', () => renderPropertyPage(container, globalState, onBack, roleId, profile, prop)));
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
                            <div style="flex:1;font-size:14px;">${esc(f.name)}${f.isContact ? ` <span style="font-size:12px;color:#999;">（${esc(realName(f.id))}）</span>` : ''}${(() => {
                    const st = statusNow(f.id, new Date().getHours());
                    return st ? `<span style="font-size:11px;color:#bbb;font-weight:400;">（${st}）</span>` : '';
                })()}</div>
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
        btn.addEventListener('click', async () => {
            const fId = btn.dataset.friend;
            const fName = (profile.gameFriends || []).find(g => g.id === fId)?.name || realName(fId);
            let fp = null;
            try { fp = await getProfile(fId); } catch { }
            if (isResting(fp, new Date().getHours())) {
                toast(`💤 ${esc(fName)} 正在休息，等TA睡醒再聊吧`, '#7c4dff');
                return;
            }
            overlay.remove();
            showCityChat(container, roleId, profile, fId, '好友聊天', true, fp);   // ★ 持久，复用已读档案
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
    const actText = curScheduleEntry(profile.schedule, hour)?.act || '';
    const myStatus = statusNow(roleId, hour);
    const mySched = (profile.schedule || []).map(s => `${s.time} ${s.place}${s.act ? ' ' + s.act : ''}`).join('；') || '（暂无安排）';
    const myTraits = (profile.aiProfile?.traits || []).join('、');

    // ★ 好友信息：只基于小城 profile（游戏内数据），不读真实角色卡
    let friendInfo;
    if (fp) {
        const friendAct = curScheduleEntry(fp.schedule, hour)?.act || '';
        friendInfo = `【${friendName}（小城居民）】\n` +
            `小城职业：${fp.job || '无'}\n` +
            `性格标签：${(fp.aiProfile?.traits || []).join('、') || '暂无'}\n` +
            `当前状态：${statusNow(friendId, hour) || '空闲'}\n` +
            `此刻活动：${friendAct || `在${placeName}附近`}\n` +
            `今日日程：${(fp.schedule || []).map(s => `${s.time} ${s.place}${s.act ? ' ' + s.act : ''}`).join('；') || '（暂无安排）'}`;
    } else {
        friendInfo = `【${friendName}】\n（ta 尚未入住小城，只是个陌生面孔——你还不了解ta）`;
    }

    // ★ 关系（经授权读取自己的 relations）
    const rel = await readGameData(roleId, 'relations', () => new CharacterStore(roleId).getRelationById(friendId));
    if (rel?.relation) friendInfo += `\n你和ta的关系：${rel.relation}`;
    // ★ 陌生人关系状态：既非真实联系人、也非游戏好友 → 两人互不认识（授权细节后续再调）
    const isContact = new CharacterStore(roleId).isFriend(friendId);
    const isGameFriend = fp && (profile.gameFriends || []).some(f => f.id === friendId);
    if (!isContact && !isGameFriend) friendInfo += `\n你们的关系：陌生人，两人互不认识——本次是初次相遇，对方不了解你，你也不了解对方`;

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
                userContent: `【我（${esc(profile.name)}）】\n职业：${profile.job}\n性格标签：${myTraits || '暂无'}\n当前状态：${myStatus || '空闲'}\n此刻活动：${actText || `在${placeName}逛逛`}\n今日日程：${mySched}\n\n` +
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

// 夜生活事件：夜间在夜场触发的 AI 小剧情（复用路人剧情模式）
const NIGHT_SPOTS = ['bar', 'ktv', 'arcade', 'playground'];

// 夜场档案：每个场所有自己的身份（icon + 氛围池 + AI用的场所设定）
const NIGHT_SCENES = {
    bar: {
        icon: '🍸',
        vibes: ['吧台后的调酒师正练习花式抛瓶，偶尔失误接住', '有人向调酒师要了一杯"老样子"', '角落有人用沙哑嗓音哼着不成调的歌'],
        prompt: '深夜的酒吧：灯光昏黄，吧台后有调酒师，人们微醺低声交谈，偶尔有人上台唱两首——这是个社交与微醺的场子',
    },
    ktv: {
        icon: '🎤',
        vibes: ['隔壁包间传来跑调的合唱，笑成一团', '有人在点歌台前纠结了整整五分钟', '麦霸正在包厢里连唱五首不肯下来'],
        prompt: '深夜的KTV：隔音门漏出跑调的合唱，麦霸抢麦，点歌台前有人纠结——这是个宣泄与尽兴的场子',
    },
    arcade: {
        icon: '🕹️',
        vibes: ['有人对着机台低声念叨"就差一点…"', '最高分那栏的名字还是上周那个', '投币口偶尔传来清脆的落币声'],
        prompt: '深夜的游戏厅：屏幕荧光、机台叮当，有人反复挑战最高分——这是个竞技与执念的场子',
    },
    playground: {
        icon: '🏟️',
        vibes: ['跑道上有人在夜跑，脚步声均匀而有力', '看台上躺着个人，正望着星星发呆', '远处遛狗的人被狗拽着往草地上冲'],
        prompt: '深夜的操场：路灯下的跑道，看台上躺着看星星的人——这是个独处与放空的场子',
    },
};


async function showNightEvent(container, roleId, profile, placeName, subKey) {
    const hour = new Date().getHours();
    const ns = NIGHT_SCENES[subKey];
    const vibes = ns?.vibes || [];
    const vibe = vibes.length ? vibes[Math.floor(Math.random() * vibes.length)] : `深夜的${placeName}，安静得能听见自己的脚步声`;
    const scene = { icon: ns?.icon || '🌙', prompt: ns?.prompt || `深夜的${placeName}，安静得能听见自己的脚步声` };

    const overlay = document.createElement('div');
    overlay.className = 'simcity-pop';
    overlay.innerHTML = `<div class="simcity-pop-card">
        <div style="font-weight:700;font-size:15px;margin-bottom:4px;">${scene.icon} 夜生活事件</div>
        <div style="font-size:12px;color:#999;margin-bottom:10px;">${esc(placeName)} · ${hour}:00</div>
        <div class="sc-pop-body" style="font-size:13px;line-height:1.8;color:#333;white-space:pre-wrap;min-height:60px;">⏳ 事件生成中…</div>
        <button class="simcity-pop-close" id="neClose">关闭</button>
    </div>`;
    container.appendChild(overlay);
    overlay.querySelector('#neClose').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    try {
        const recent = await getRecentSummaries(roleId, 4);
        const raw = await taskManager.watch('citystory', '夜生活事件', async () => {
            const { callAIWithMessages } = await import('../aiService.js');
            return await callAIWithMessages({
                systemPrompt: '你是"模拟小城"的剧情生成器。生成一段主角深夜在夜生活场所遇到的小插曲。要求：' +
                    '1. 像小说片段一样有生活感，避免AI套话（"不禁…""仿佛…""令人…"）' +
                    '2. 围绕当前场所的氛围展开，可以是遇到一个有趣的陌生人、一段小对话或一场小闹剧，不需要完整人物设定' +
                    '3. 输出格式：【概要】一行话概括（20字以内）\n【正文】100~250字的完整剧情' +
                    '4. 参考【最近偶遇概要】，尽量避免重复或雷同' +
                    '只输出这两部分，不要任何其他文字。',
                userContent: `【${esc(profile.name)}】\n职业：${profile.job}\n性格标签：${(profile.aiProfile?.traits || []).join('、')}\n\n` +
                    `现在是深夜${hour}点，${esc(profile.name)}在${esc(placeName)}。\n${vibe}\n${scene.prompt}\n请生成这段夜生活小插曲。\n\n` +
                    `【最近偶遇概要】\n${recent || '（暂无）'}`,
                maxTokens: 3000, temperature: 0.9
            });
        });
        const { summary, text } = parseStory(raw);
        overlay.querySelector('.sc-pop-body').textContent = text || '…夜风里什么都没有发生。';
        if (text) {
            await saveStory({ id: 'st_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4), type: 'night_event', participants: [roleId], pairKey: roleId, summary, text, timestamp: Date.now() });
        }
    } catch (e) {
        overlay.querySelector('.sc-pop-body').textContent = '❌ ' + (e.message || '事件生成失败');
    }
}

// 执行 AI 回复里的游戏内操作（约定 / 加好友），返回提示列表
async function applyCityActions(text, roleId, profile, friendId) {
    const friendName = getCharacterNameById(friendId) || friendId;
    const done = [];
    const today = dayStr(new Date());

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

// ★ 是否在休息时段（读 AI 的 rest 字段：如"23:00~07:00"）
function isResting(fp, hour) {
    const r = fp && fp.rest;
    if (!r || isNaN(r.from) || isNaN(r.to)) return false;
    return r.from <= r.to ? (hour >= r.from && hour < r.to) : (hour >= r.from || hour < r.to);
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

async function showCityChat(container, roleId, profile, friendId, placeName, persist = true, fpPre) {
    const friendName = getCharacterNameById(friendId) || friendId;
    const hour = new Date().getHours();
    // ★ 提前读对方档案（休息判断 + 后续对话 prompt 复用，省一次读取）
    let fp = fpPre || null;
    if (!fp) { try { fp = await getProfile(friendId); } catch { } }

    // ★ 对方在休息：聊天不可用
    if (isResting(fp, hour)) {
        toast(`💤 ${esc(friendName)} 正在休息，等TA睡醒再聊吧`, '#7c4dff');
        return;
    }
    const pairKey = chatPairKey(roleId, friendId);
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
        // ★ 对方中途休息：拦截发送
        if (isResting(fp, new Date().getHours())) {
            toast(`💤 ${esc(friendName)} 正在休息，等TA睡醒再聊吧`, '#7c4dff');
            return;
        }

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
            // ★ 对方此刻正在做什么（从日程/约定取）
            let friendAct = '';
            if (fp) {
                const nowHour = new Date().getHours();
                const todayStr = dayStr(new Date());
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
                        (fp ? `【你】小城名：${fp.name}（职业：${fp.job}）\n性格：${(fp.aiProfile?.traits || []).join('、')}\n当前状态：${statusNow(friendId, hour) || '空闲'}\n今日日程：${(fp.schedule || []).map(s => `${s.time} ${s.place}${s.act ? ' ' + s.act : ''}`).join('；') || '（暂无安排）'}\n` : `【你】${friendName}\n（未入住小城，作为路人回应）\n`) +
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

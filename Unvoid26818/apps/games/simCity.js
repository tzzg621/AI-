// apps/games/simCity.js — 模拟小城（角色联动模拟经营，IndexedDB 存储）
import { CharacterStore, getActiveCharacterId } from '../../store/CharacterStore.js';
import { getCharacterNameById } from '../characterManager.js';
import { getAvatarHtml } from '../../store/ImageCache.js';
import { isArchived } from '../roleData.js';
import { esc } from '../../store/utils.js';
import {
    getProfile, saveProfile, saveStory, getStories, deleteStory, buildPlaceIndex, buildPlaceIndexFrom, upsertCharPlaceIndex, saveProfiles,
    getAllProfiles, getPresentAt, chatPairKey, getChatMessages, saveChatMessage, getAllChats, deleteChatMessages, deleteTempChats, getSimCityRelations, saveSimCityRelations,
    getSimCityWorld, saveSimCityWorld, getSimCityPlaceConfig, saveSimCityPlaceConfig, getPersonaTemplates, savePersonaTemplates, getSimCityEstates, saveSimCityEstates, getGroupChatMessages, getGroupRegistry, saveGroupRegistry,
    getAdventure, saveAdventure, getAllAdventures, getSimCityAdventures, saveSimCityAdventures, getSimCityShops, saveSimCityShops,
    getSimCityBulletins, saveSimCityBulletins, getSimCityResidentials, saveSimCityResidentials, cleanupStaleAdvSessions,
    getSimCitySettings, saveSimCitySettings
} from './simCityStore.js';
import { taskManager } from '../../store/AITaskManager.js';
import { runTextAdventure } from './textAdventure.js';

export const id = 'simCity';
export const label = '模拟小城';
export const icon = '🏙️';
export const color = '#7c4dff';

let simCityCtx = null;   // 当前小城上下文：AI 完成后判断是否弹窗
let placeIndex = {};   // 当前小城地点×时段索引
let mapScrollLeft = 0;          // ★ 地图停留位置（从地点返回时恢复）
let propertyAreaIndex = {};    // ★ 区域→房产索引（"附近房产"可见性查询）
let charDisplayMap = {};       // ★ id→公开显示索引（只存游戏名+职业；私密数据不进入，完整档案走 getProfile）
// ★ 地产目标评估任务表（内存）：防重复 + 锁定 + 占位显示目标
let pendingTargets = [];   // [{ estateId, goal, submittedAt }]
// ★ 当前活跃聊天窗口的"自动重开"能力（开新窗口覆盖；仅 AI 完成且重开过时使用）
let activeChatRefresh = null;
let drawerOpenAt = null;   // ★ 当前打开的抽屉所属地点（{ key }）——重渲染后恢复，支持"按钮不自动关"
let renderSeq = 0;   // ★ 渲染序号（防竞态：后发覆盖先发）
let simCityAdvRegistry = null;   // ★ 文游注册表缓存（轻量索引）
let simCityAdvCache = {};        // ★ 文游全文缓存（按 id，打开小城时加载）
let advEndedNotice = {};      // ★ 本会话内刚结束的文游（显示只读结尾，收起后清除）
let simCityPlaceCfg = null;   // { presets: [], placeConfigs: {} }
let personaTemplates = null;   // ★ 角色提示词模板（内置 + 自定义，全角色共享）
let simCityRelations = null;   // ★ 游戏内好感度（亲密度：pairKey 一份，双向共享）
let simCitySettings = null;   // ★ 全局设置（historyCount：AI对话记忆条数）
let simCityShops = {};   // ★ 商店表（shopId → { name, icon, items }；地点只存 shopId 引用）
let shopInjectedKeys = new Set();   // ★ 货架已注入的对话键（每会话一次，防重复）
let simCityBulletins = {};   // ★ 公告牌（placeKey → [{ type, text, at }]）
let simCityResidentials = {};   // ★ 住宅区详情（placeKey → { name, houses }；地点只带 residential 名字字段）
let pendingEvents = {};   // ★ 地点事件槽（待参与事件；sessionStorage 页面级缓存，刷新不丢）

// ★ 事件槽：sessionStorage 页面级缓存（刷新不丢，关页自动清）
const PENDING_EVENTS_KEY = 'simcity_pending_events';
function loadPendingEvents() { try { return JSON.parse(sessionStorage.getItem(PENDING_EVENTS_KEY) || '{}'); } catch (e) { return {}; } }
function savePendingEvents() { try { sessionStorage.setItem(PENDING_EVENTS_KEY, JSON.stringify(pendingEvents)); } catch (e) { } }
function advStateKeyOf(roleId, placeKey) { return `simcity_adv_${roleId}_${placeKey}`; }
function hasOngoingEventAdv(roleId, placeKey) { try { return !!sessionStorage.getItem(advStateKeyOf(roleId, placeKey)); } catch (e) { return false; } }

// ★ 对话购买语境词表（B' 触发：上一轮文本命中 + 当前地点有商店 → 本轮注入货架）
const SHOP_TRIGGER_WORDS = ['买', '购买', '想喝', '想尝', '来一杯', '来一份', '来点', '买点', '买些', '逛逛', '购物', '咖啡', '茶', '酒', '零食', '点心', '商品', '货架'];

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

// ★ 个性登记内置世界书模板（各角色可勾选复用）
const PERSONA_TEMPLATES = [
    { id: 'tpl_gentle', name: '性格·温柔体贴', text: '待人温柔体贴，说话轻声细语，心思细腻，习惯照顾身边的人。' },
    { id: 'tpl_tsundere', name: '性格·傲娇', text: '表面傲娇、口是心非，其实很在意身边的人，偶尔不经意流露关心。' },
    { id: 'tpl_cheerful', name: '性格·元气开朗', text: '性格开朗活泼，元气满满，爱笑爱闹，是人群里的气氛担当。' },
    { id: 'tpl_money', name: '世界观·金钱至上', text: '坚信金钱万能，做事先看利益与回报。' },
    { id: 'tpl_diligent', name: '世界观·努力至上', text: '相信努力就有回报，讨厌不劳而获、投机取巧。' },
    { id: 'tpl_note_name', name: '注意·别叫全名', text: '不喜欢被叫全名，被叫全名会明显不悦。' },
];

// ★ 角色模板（独立特殊键，首次进游戏初始化内置默认）
async function ensurePersonaTemplates() {
    let tpls = await getPersonaTemplates().catch(() => null);
    if (!tpls) {
        tpls = [...PERSONA_TEMPLATES];   // 首次：内置默认
        await savePersonaTemplates(tpls).catch(() => { });
    }
    personaTemplates = tpls;
    return tpls;
}
// ★ 拼接角色专属提示词：复用模板（personaTemplateIds）+ 专有世界书（worldbook）
function personaBlockFor(profile) {
    const pr = profile || {};
    const allTpl = personaTemplates || [];
    const tplTexts = (pr.personaTemplateIds || []).map(tid => {
        const t = allTpl.find(x => x.id === tid);
        return t ? t.text : '';
    }).filter(Boolean);
    const parts = [...tplTexts, (pr.worldbook || '').trim()].filter(Boolean);
    return parts.join('；');
}

// ★ 系统级预设（场景设定用，全局复用，可自定义；首次进游戏初始化进世界键）
const DEFAULT_PRESETS = [
    { id: 'preset_ai', name: 'AI拟人世界观', text: '这是一个AI拟人的世界，所有居民都是AI，彼此以人类方式生活。' },
    { id: 'preset_friend', name: '交友游戏', text: '这是一个需要不断与陌生人交友的游戏，社交是核心玩法。' },
];

// ★ 地点提示词配置（独立特殊键，与每天刷新的世界状态解耦）
async function ensurePlaceConfig() {
    let cfg = await getSimCityPlaceConfig().catch(() => null);
    if (!cfg) {
        cfg = { presets: [...DEFAULT_PRESETS], placeConfigs: {} };
        await saveSimCityPlaceConfig(cfg).catch(() => { });
    }
    simCityPlaceCfg = cfg;
    return cfg;
}

// ★ 地点专属世界书：自定义覆盖 > 内置默认（内置默认未来可由 AI 生成地点时输出）
function placeWorldbookOf(place) {
    if (!place) return '';
    const cfg = simCityPlaceCfg?.placeConfigs?.[place.key];
    return (cfg?.worldbook) || place.worldbook || '';
}

// ★ 系统级预设（加到 systemPrompt 最前方，描述/改变全局氛围与规则）
function placePresetBlock(place) {
    const cfg = simCityPlaceCfg?.placeConfigs?.[place?.key] || {};
    const presets = simCityPlaceCfg?.presets || [];
    return (cfg.presetIds || []).map(pid => presets.find(x => x.id === pid)?.text).filter(Boolean).join('；');
}

// ★ 地区专属世界书 + 父子地点世界书（加到 userContent 最前方）
function placeWbBlock(place) {
    const p = place || {};
    const cfg = simCityPlaceCfg?.placeConfigs?.[p.key] || {};
    const parts = [];
    const wb = placeWorldbookOf(p);
    if (wb) parts.push(wb);
    if (cfg.includeParent && p.parent) {
        const parent = findPlace(p.parent);
        const pw = placeWorldbookOf(parent);
        if (pw) parts.push(`【周边·${parent?.name || ''}】${pw}`);
    }
    if (cfg.includeChildren) {
        childrenOf(p.key).forEach(c => {
            const cw = placeWorldbookOf(c);
            if (cw) parts.push(`【周边·${c.name}】${cw}`);
        });
    }
    return parts.join('；');
}

// ★ 每日好感度结算（纯内存）：同一天同一时段同地点共处 → 概率增加亲密度（与工资一致：跨天补算，lastGainDay 防同日重复）
function settleRelationsFrom(profiles, placeIndex, relations, now = new Date()) {
    if (!relations) return false;
    const yesterday = dayStr(new Date(now.getTime() - 86400000));
    if (relations.lastGainDay === yesterday) return false;
    const co = {};   // pairKey -> 共处小时数
    for (const placeName in (placeIndex || {})) {
        for (const dayKey in placeIndex[placeName]) {
            for (const hour in placeIndex[placeName][dayKey]) {
                const ids = placeIndex[placeName][dayKey][hour];
                if (!ids || ids.length < 2) continue;
                for (let i = 0; i < ids.length; i++) {
                    for (let j = i + 1; j < ids.length; j++) {
                        const k = pairKeyOf(ids[i], ids[j]);
                        co[k] = (co[k] || 0) + 1;
                    }
                }
            }
        }
    }
    let changed = false;
    relations.map = relations.map || {};
    for (const k in co) {
        const r = relations.map[k] = relations.map[k] || { score: 0 };
        let gain = 0;
        if (co[k] >= 1 && Math.random() < 0.6) gain++;
        if (co[k] >= 2 && Math.random() < 0.6) gain++;
        if (gain) {
            r.score = Math.max(0, Math.min(100, (r.score || 0) + gain));
            changed = true;
        }
    }
    relations.lastGainDay = yesterday;
    return changed;
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

// 纯内存版：从快照构建（进小城 start 用，避免第二次 getAllProfiles）
function buildPropertyAreaIndexFrom(profiles) {
    const idx = {};
    for (const p of profiles) {
        for (const prop of (p.properties || [])) {
            (idx[prop.area] = idx[prop.area] || []).push({ ownerId: p.id, ownerName: p.name, prop });
        }
    }
    return idx;
}

// ★ 每日工资结算（纯内存）：底薪保底天天发 + 工时×时薪；补算上次结算至今的所有日期
//   只把"需要写库"的角色推进 writes，由 start 统一批量写（保持原写集合语义）
function settleFrom(profiles, mainRoleId, writes) {
    const today = new Date();
    let mainGain = 0;
    for (const p of profiles) {
        const job = p.jobKey && getJob(p.jobKey);
        if (!job) { if (!p.lastPayDay) p.lastPayDay = dayStr(new Date(today.getTime() - 86400000)); continue; }
        const last = p.lastPayDay ? new Date(p.lastPayDay) : new Date(today.getTime() - 86400000);
        const days = Math.max(0, daysBetween(last, today) - 1);   // 结算到昨天
        if (days <= 0) continue;
        const hours = workHoursFromIndex(placeIndex, jobWorkNames(job), p.id);
        const gain = days * (job.base + hours * job.hourly);
        if (gain > 0) p.money = (p.money || 0) + gain;
        p.lastPayDay = dayStr(new Date(today.getTime() - 86400000));
        if (p.id === mainRoleId) mainGain = gain;
        writes.push(p);
    }
    return mainGain;
}

// ★ 地产建设进度结算（纯内存）：建设中的地产，共建者在"所在地=地产名"的每个小时 +20 进度
//   所在地从 24h 索引（placeIndex）直查——该地产名下的索引项里该小时在列即在场（O(1)，不遍历全部地点）
//   索引由 schedule/builds/appointments 推导，离线任意小时可算；补算上限72h；进度满即停（焕新手动）
function settleEstateProgressFrom(estates, placeIndex, now = Date.now()) {
    let changed = false;
    for (const e of estates) {
        if (e.status !== 'building' || !e.maxProgress || !e.name) continue;
        const builders = e.contributors || [];
        if (!builders.length) continue;
        const hoursAt = placeIndex[e.name] || {};          // ★ 只查该地产的索引项
        const last = e.lastProgress || (e.createdAt || now);
        const hours = Math.min(72, Math.floor((now - last) / 3600000));
        if (hours <= 0) continue;
        changed = true;                      // ★ 只要结算了就推进基准并保存（无论进度是否变化）
        for (let i = 0; i < hours && e.progress < e.maxProgress; i++) {
            const present = hoursAt[new Date(last + i * 3600000).getHours()] || [];
            for (const pid of builders) {
                if (present.includes(pid)) {
                    e.progress = Math.min(e.maxProgress, (e.progress || 0) + 20);
                    changed = true;
                    if (e.progress >= e.maxProgress) break;
                }
            }
        }
        e.lastProgress = now;
    }
    return changed;
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

    // ★ 一次全量读取，内存派生所有索引（原 3 次 getAllProfiles → 1 次）
    const allProfiles = await getAllProfiles();
    const today = dayStr(new Date());
    const writes = [];
    placeIndex = buildPlaceIndexFrom(allProfiles, today, p => writes.push(p));   // 清理过期约定（收集写）
    propertyAreaIndex = buildPropertyAreaIndexFrom(allProfiles);                  // 区域→房产索引
    const mainGain = settleFrom(allProfiles, roleId, writes);                     // 工资结算（收集写）
    charDisplayMap = {};
    (allProfiles || []).forEach(p => { charDisplayMap[p.id] = { name: p.name || '', jobKey: p.jobKey || '', energy: p.energy || 100 }; });

    // ★ 批量写：同一角色可能被"清约定"和"发工资"都标记，按 id 去重后一次事务写入
    const seen = new Set();
    const finalWrites = [];
    for (const p of writes) { if (seen.has(p.id)) continue; seen.add(p.id); finalWrites.push(p); }
    if (finalWrites.length) await saveProfiles(finalWrites.map(p => ({ profile: p, roleId: p.id })));
    if (mainGain > 0) toast(`💼 工资到账 +${mainGain} 金币（含底薪与工时）`, '#2e7d32');
    await ensurePlaceConfig();
    await ensurePersonaTemplates();   // ★ 角色模板
    await ensureSimCityWorld();   // ★ 确保当天天气/见闻（跨天自动刷新）
    await loadEstates();
    simCityRelations = await getSimCityRelations().catch(() => null);
    simCityShops = await getSimCityShops().catch(() => { }) || {};
    // ★ 商店每日补货（跨天重置 qty；商店表集中遍历，不调 AI）
    let shopsChanged = false;
    for (const shopId in simCityShops) {
        const shop = simCityShops[shopId];
        if (!shop || shop.lastRestockDay === today) continue;
        for (const it of (shop.items || [])) it.qty = it.initQty || it.qty;
        shop.lastRestockDay = today;
        shopsChanged = true;
    }
    if (shopsChanged) await saveSimCityShops(simCityShops).catch(() => { });
    simCityBulletins = await getSimCityBulletins().catch(() => { }) || {};

    pendingEvents = loadPendingEvents();
    const evToday = dayStr(new Date());
    let evChanged = false;
    for (const k in pendingEvents) { const ev = pendingEvents[k]; if (!ev || dayStr(new Date(ev.at || 0)) !== evToday) { delete pendingEvents[k]; evChanged = true; } }
    if (evChanged) savePendingEvents();

    simCitySettings = await getSimCitySettings().catch(() => null);
    await loadAdventures();   // ★ 文游注册表 + 全文缓存
    // ★ 地产建设进度结算（纯内存）：所在地=地产名的共建者每小时 +20
    if (settleEstateProgressFrom(simCityEstates.estates || [], placeIndex)) await saveEstates();
    // ★ 住宅区初始化：静态地点 + 建成地产（有 residential 的）补默认房型
    simCityResidentials = await getSimCityResidentials().catch(() => null) || {};
    let resChanged = false;
    for (const p of PLACES) if (p.residential && !simCityResidentials[p.key]) { simCityResidentials[p.key] = { name: p.residential, houses: [{ ...DEFAULT_HOUSE }] }; resChanged = true; }
    for (const e of (simCityEstates?.estates || [])) if (e.status === 'built' && e.residential && !simCityResidentials[e.id]) { simCityResidentials[e.id] = { name: e.residential, houses: [{ ...DEFAULT_HOUSE }] }; resChanged = true; }
    for (const e of (simCityEstates?.estates || [])) if (e.status === 'built') for (const s of (e.subs || [])) if (s.residential && !simCityResidentials[s.key]) { simCityResidentials[s.key] = { name: s.residential, houses: [{ ...DEFAULT_HOUSE }] }; resChanged = true; }   // ★ 子地点住宅区
    if (resChanged) await saveSimCityResidentials(simCityResidentials).catch(() => { });
    if (simCityRelations && settleRelationsFrom(allProfiles, placeIndex, simCityRelations)) await saveSimCityRelations(simCityRelations).catch(() => { });
    await cleanupStaleTempChats();
    await cleanupStaleAdvSessions();   // ★ 清理孤儿事件文游会话（关页遗留）
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
                <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
                    <input type="checkbox" id="scFandom" style="width:18px;height:18px;accent-color:#7c4dff;">
                    <div style="flex:1;">
                        <div style="font-size:14px;font-weight:600;">✨ 同人增强</div>
                        <div style="font-size:12px;color:#999;">开启后，评估官会考虑已建成的同人场景与职位（如"冬木市"），适合原作/同人角色</div>
                    </div>
                </label>
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
            enhanceFandom: !!container.querySelector('#scFandom').checked,   // ★ 同人增强开关
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
function startAiEvaluation(roleId, profile, suggestion = '', fandomBoost = false) {
    try {
        taskManager.submit('city_eval', `✨ AI评估：${profile.name} 的小城人设与日程`, () => aiEvaluateProfile(roleId, profile, suggestion, fandomBoost), {
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
async function aiEvaluateProfile(roleId, profile, suggestion = '', fandomBoost = false) {
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
        `小城职业：${profile.job}`,
        personaBlockFor(profile) ? `个性登记：${personaBlockFor(profile)}` : ''   // ★ 手写世界书+模板，评估官参考
    ].filter(Boolean).join('\n');
    // ★ 动态地点注入：已有 ip → 按可见性过滤（只注入该角色能看见的）；首次评估（无 ip）→ 按开关全量
    const builtEstates = (simCityEstates?.estates || []).filter(e => e.status === 'built');
    const fandomOn = !!profile.enhanceFandom || !!fandomBoost;   // ★ 临时同人增强：仅本次评估生效，不写档案
    const hasIp = !!(profile.ip && profile.ip.length);
    const dynamicEstates = builtEstates.filter(e => hasIp ? canSeeEstate(roleId, profile, e) : fandomOn);    // 纯名清单（供 schedule 兜底过滤）
    // 纯名清单（供 schedule 兜底过滤）
    const visiblePlaceNames = [
        ...PLACES.filter(p => !p.parent).map(p => p.name),
        ...PLACES.filter(p => p.parent).map(p => p.name),
        ...(fandomOn ? dynamicEstates.map(e => e.name) : []),
        ...(fandomOn ? dynamicEstates.flatMap(e => (e.subs || []).map(s => s.name)) : [])   // ★ s.name 已是全名
    ];
    // 提示词里的地点（带场景信息，供 AI 匹配）
    const placePrompt = visiblePlaceNames.join('、')
        + (fandomOn && dynamicEstates.length
            ? '\n【建成场景】' + dynamicEstates.map(e => `${e.name}：${(e.ip || []).join('/') || '日常'} · ${(e.tags || []).join('·') || '通用'}${(e.subs || []).length ? '｜子地点：' + e.subs.map(s => `${s.name}（${s.desc || ''}）`).join('、') : ''}`).join('；')
            : '');
    const counts = await getJobCounts();   // ★ 提前算名额（L538 复用，不再二次读取）
    // ★ 可入职职位（纯组合名 + 剩余名额）
    const visibleJobs = [];
    const jobSlots = [];
    for (const [k, j] of Object.entries(JOB_DEFS)) {
        const pn = (PLACES.find(p => p.key === j.placeKey) || {}).name || j.placeKey;
        const sn = j.subKey ? ((PLACES.find(p => p.key === j.subKey) || {}).name || j.subKey) : '';
        const full = `${sn ? `${pn}-${sn}-` : `${pn}-`}${j.name}`;
        visibleJobs.push(full);
        const left = Math.max(0, (j.quota || 1) - (counts[k] || 0));
        jobSlots.push(`${full}：${left > 0 ? `剩${left}` : '满员'}`);
    }
    for (const e of dynamicEstates) {
        for (const j of (e.jobs || [])) {
            const full = `${j.subKey ? `${e.name}-${subDisplayName((e.subs || []).find(s => s.key === j.subKey)?.name || j.subKey)}-` : `${e.name}-`}${j.name}`;
            visibleJobs.push(full);
            const left = Math.max(0, (j.quota || 1) - (counts[j.key] || 0));
            jobSlots.push(`${full}：${left > 0 ? `剩${left}` : '满员'}`);
        }
    }

    const { callAIWithMessages } = await import('../aiService.js');
    const raw = await callAIWithMessages({
        systemPrompt: '你是"模拟小城"的入住评估官。根据给定角色的设定，输出三部分：' +
            '1) comment：对该角色初始设定的评估评语（120字内，语气可以温和吐槽或正经修正）' +
            '2) traits：3~5个性格/生活标签' +
            '3) schedule：该角色在小城的一天基础日程表（6~8个时段，含时间/地点/活动，体现职业，一个时段只选取一个地点）' +
            '4) custom：0~3个该角色的特殊属性/特长（JSON对象，键为属性名，值为布尔或简短描述，如{"擅长针灸":true,"剑术":"3级"}），用于互动提示，让AI生成内容时能引用。' +
            '5) 如果角色有多个可选职业经历，可不填（职业经验由游戏内工作累积）。' +
            '6) ip：角色所属作品/世界观标签（JSON字符串数组，如["fate"]；普通角色留空或["日常"]），用于同世界观角色聚拢与特别场景可见性。' +
            '★ 地点只能从【小城地点】中选择（未列出的地点在小城不存在）：【小城地点】' + placePrompt + '\n' +
            '★ 职位只能从【小城职位】中选择（可修正注册自称职业）：【小城职位】' + visibleJobs.join('；') + '\n' +
            '★ job 必须填【小城职位】里的完整组合名（必须含地点前缀，如"夜之城-学校-教师"、"冬木市-圣杯战争观察员"），禁止省略地点或只填职业名。' +
            '★ 各职位剩余名额（满员的职位不要选）：' + jobSlots.join('、') + '\n' +
            '根据角色设定选最合适的（注册时的自称职业仅供参考，可修正为更合适的职位；学生可选"学校-学生"）。' +
            '★ 职业要多样化：避免扎堆学生/教师/文员等基础职业，尽量结合角色设定选有特色的职位；若角色与某建成场景（见【建成场景】）世界观相关，优先选该场景的新职业。' +
            '营业时间（未列出的地点全天开放，商业街/娱乐街全天可安排夜市夜宵）：商场10:00~22:00、奶茶店9:00~23:00、餐厅10:00~22:00、游戏厅10:00~24:00、KTV19:00~凌晨02:00、酒吧19:00~凌晨02:00、教学楼8:00~21:00、操场6:00~22:00、学校6:00~22:00；不要安排角色在打烊时间去。' +
            '时间用整点或半点，小时统一两位数字（如02:00、08:00、14:30），按时间顺序排列。' +
            // ★ 作息：休息时间段 + 回家时间点
            '每天给出一个"休息时间段"（rest字段，如"23:00~07:00"：普通人晚上、夜班角色白天、夜猫子凌晨到中午），表示该角色睡觉、不可打扰的时段；日程里还要安排回到家的时间点（如22:00 家 休息）。' +
            // ★ 夜间放宽（同人场景夜间活跃合理）
            '作息由"rest"字段决定（休息时段外，夜间活动是正常的）：普通角色晚间（18:00~22:00）可晚饭/散步/在家，22:00后可去酒吧/KTV/游戏厅/公园/中心广场/商业街等；同人角色在其所属建成场景（如冬木市）夜间活跃是合理的（夜间活动应结合世界观，如圣杯战争多在深夜进行，建成场景未列营业时间即全天开放）；夜猫子角色可以深夜/凌晨活动，只要落在休息时段之外即可。' +
            '只输出JSON：{"job":"学校-教师","comment":"评语","traits":["标签"],"rest":"23:00~07:00","custom":{"擅长写作":true},"ip":["fate"],"schedule":[{"time":"08:00","place":"杂货店","act":"整理货架"}]}，job 仅为格式示例，必须替换为【小城职位】中实际合适的组合名。不要任何其他文字。',


        userContent: `角色信息：\n${roleInfo}\n\n`
            + `当前日程：${JSON.stringify(profile.schedule || [])}`
            + (suggestion.trim() ? `角色本人想对评估官说的话：\n${suggestion.trim()}\n\n` : '')
            + `请给出评估评语、标签与日程表（JSON）。`,

        maxTokens: 12000,
        temperature: 0.8
    });
    const data = parseAiJson(raw || '');

    // ★ 存储分层：
    profile.schedule = (data.schedule || []).filter(s => visiblePlaceNames.includes(s.place));        // 日程表单独存（影响默认行为逻辑）

    // ★ 职业写入：目标职位存在且未满 → 覆盖 jobKey（旧职位实时释放）；否则保留现职业
    if (data.job && getJob(data.job)) {
        const jd = getJob(data.job);                    // ★ 解析出标准定义（含标准 key）
        if ((counts[jd.key] || 0) < jd.quota) {         // ★ 用 jd.key 统计（不再用 AI 原始字符串）
            profile.jobKey = jd.key;                    // ★ 存标准 key（如 hall-hall-clerk）
            charDisplayMap[roleId] = { name: profile.name || '', jobKey: profile.jobKey || '', energy: profile.energy || 100 };
        } else {
            toast('🔁 目标职位已满，保留当前职业', '#999');
        }
    }

    // ★ 解析休息时间段（AI输出如"23:00~07:00"）→ 只用于聊天拦截
    const rm = /^(\d{1,2}):\d{2}~(\d{1,2})/.exec(String(data.rest || ''));
    if (rm) profile.rest = { from: parseInt(rm[1]), to: parseInt(rm[2]) };

    // ★ 特殊属性（custom）：保留旧值，AI 新给的覆盖同名——开放结构，后续 AI 生成新职位/经验也写这里
    profile.custom = { ...(profile.custom || {}), ...(data.custom || {}) };
    profile.ip = data.ip || [];

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

// ★ 私人地产目标评估（新建/合并/拒绝）：AI 判断目标是否与已有地产一致，防止重复地点
async function assessEstateGoal(roleId, profile, goal, estateList) {
    const { callAIWithMessages } = await import('../aiService.js');
    const systemPrompt =
        '你是"模拟小城"的评估官，负责评估角色为其私人地产设立的建设目标。' +
        '目标只做一件事：判断这个目标应该「新建」还是「合并」进已有地产，或者「拒绝」。' +
        '判断规则：' +
        '1) 若目标与已有地产的 goal 是同一地点/世界（如"冬木市"与"冬木"、"圣杯战争舞台"），则 action=merge，合并到最匹配的那个地产。' +
        '2) 若目标太小/无意义，则 action=reject 并给出理由。' +
        '3) 否则 action=new。' +
        '难度分级（新建时给出 maxProgress）：小场景（一座宅邸/一个店铺）100；城市/区域（一座城市/一片区域）1000+；世界级（完整世界观）10000+。' +
        '新建目标时，给出该角色的建设时段：buildTime（每天来此建设的起止时段，格式"19:00-21:00"，可跨夜如"22:00-01:00"，时长1-4小时）、buildAct（建设行为描述，如"参与冬木市建设"）。buildTime 必须与角色已有建设日程错开（不重叠）。' +
        '每次评估都要给出一条简短评语（comment，60字内，评估官口吻，通过时点评目标、拒绝时说明原因）。' +
        '只输出JSON：{"action":"new|merge|reject","targetId":"已有地产id(merge时)","maxProgress":1000,"ip":["目标所属作品标签"],"tags":["目标标签"],"name":"目标最终名(如冬木市)","reason":"reject时理由","buildTime":"19:00-21:00","buildAct":"参与冬木市建设","comment":"评估官评语"}，不要任何其他文字。';
    const userContent =
        `当前角色：${esc(profile.name)}（${esc((profile.ip || []).join('、')) || '无标签'}）。\n` +
        `已有地产：${JSON.stringify((estateList || []).filter(e => e.goal).map(e => ({ id: e.id, goal: e.goal, status: e.status })))}。\n` +
        `该角色已有建设日程时间点：${JSON.stringify((profile.builds || []).map(x => x.endTime ? `${x.time}-${x.endTime}` : x.time))}。\n` +
        `目标：${goal}`;
    const raw = await callAIWithMessages({ systemPrompt, userContent, maxTokens: 12000, temperature: 0.8 });
    const d = parseAiJson(raw || '');
    if (!d || !d.action || d.action === 'reject') {
        return { action: 'reject', reason: d?.reason || '评估官没有回应或未通过，请稍后再试', comment: d?.comment || '' };
    }
    return {
        action: d.action === 'merge' ? 'merge' : 'new',
        targetId: d.targetId || null,
        maxProgress: Math.max(50, parseInt(d.maxProgress) || 100),
        ip: Array.isArray(d.ip) ? d.ip : [],
        tags: Array.isArray(d.tags) ? d.tags : [goal],
        name: String(d.name || goal),
        reason: d.reason || '',
        comment: d.comment || '',       // ★ 评语（存纪念册用）
        buildTime: d.buildTime || '18:00',
        buildAct: d.buildAct || `参与${goal}建设`
    };
}

// ★ 解析 AI 建设时段："19:00-21:00" / "22:00-01:00"（跨夜）/ "18:00"（单点兜底1小时）/ 缺失 → 默认 18:00-20:00
function parseBuildTime(str, fallback = { start: '18:00', end: '20:00' }) {
    const m = /^(\d{1,2}):\d{2}\s*[-~]\s*(\d{1,2}):\d{2}$/.exec(String(str || '').trim());
    if (m) return { start: `${m[1].padStart(2, '0')}:00`, end: `${m[2].padStart(2, '0')}:00` };
    const h = /^(\d{1,2}):/.exec(String(str || '').trim());
    if (h) return { start: `${h[1].padStart(2, '0')}:00`, end: String((parseInt(h[1], 10) + 1) % 24).padStart(2, '0') + ':00' };
    return fallback;
}

// ★ 添加建设日程（长期临时约定：独立于永久 schedule，时段撞车整体顺延，今天约定仍覆盖它）
function addEstateSched(roleId, profile, estate) {
    const s = estate.buildSched || parseBuildTime('');
    profile.builds = profile.builds || [];
    if (profile.builds.some(x => x.estateId === estate.id)) return false;
    const range = (a, b) => { const r = []; for (let i = a; i !== b; i = (i + 1) % 24) r.push(i); return r; };
    let sh = parseInt(s.time, 10), eh = parseInt(s.endTime, 10);
    if (Number.isNaN(sh)) sh = 18;
    if (Number.isNaN(eh) || eh === sh) eh = (sh + 1) % 24;                 // 空段/单点 → 1小时
    const want = range(sh, eh);
    const busy = new Set();
    for (const x of (profile.schedule || [])) { const h = parseInt(x.time, 10); if (!Number.isNaN(h)) busy.add(h); }
    for (const x of (profile.builds || [])) {
        const hs = parseInt(x.time, 10); if (Number.isNaN(hs)) continue;
        const he = x.endTime ? parseInt(x.endTime, 10) : (hs + 1) % 24;
        for (const h of range(hs, Number.isNaN(he) || he === hs ? (hs + 1) % 24 : he)) busy.add(h);
    }
    let shift = 0;
    while (shift < 24 && want.some(h => busy.has((h + shift) % 24))) shift++;
    profile.builds.push({
        estateId: estate.id,
        time: String((sh + shift) % 24).padStart(2, '0') + ':00',
        endTime: String((eh + shift) % 24).padStart(2, '0') + ':00',
        place: estate.name,
        act: s.act
    });
    return true;
}

// ★ 分享快照名片（视觉后置，先取数据）
function buildShareCard(roleId, profile) {
    return {
        shareId: 'share_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6),
        name: profile.name || '神秘居民',
        job: jobDisplay(profile) || '自由职业',
        level: profile.level || 1,
        money: profile.money || 0,
        traits: (profile.aiProfile?.traits || []).join('、') || '未知',
        ip: (profile.ip || []).join('、'),
        props: (profile.properties || []).length
    };
}

// ★ 好友自动注册（与主视角注册同结构、全默认；AI 自动填后续优化）
function createDefaultProfile(name) {
    return {
        name, job: '自由职业', enhanceFandom: false,
        money: 1000, energy: 100, mood: 100, level: 1,
        permissions: PERMISSIONS.map(p => p.key), gameFriends: [],
        lastPayDay: dayStr(new Date(Date.now() - 86400000)), createdAt: Date.now()
    };
}

// ★ 分享到真实聊天：业务逻辑在 simCity；chat.js 只出通用接口 injectChatMessage
async function sendGameShareToChat(activeId, otherId, shareText) {
    const activeName = getCharacterNameById(activeId) || activeId;
    let res;
    try {
        const { injectChatMessage } = await import('../chat.js');   // ★ 路径：apps/chat.js
        res = await injectChatMessage(activeId, otherId, {
            senderId: activeId,
            senderDisplayName: activeName,
            text: shareText
        }, {
            reply: true,
            replyHint: '【系统】对方正在向你分享一款叫「虚拟小城」的角色扮演游戏。如果你对这个游戏感兴趣、愿意入住，请在回复末尾加上【同意注册】虚拟小城；如果不感兴趣就正常回复，不要加任何标记。请保持你的角色人设与说话风格。'
        });
    } catch (e) {
        res = await sendGameShareLocal(activeId, otherId, shareText, activeName);   // 降级（保险）
    }
    return { reply: res.reply || '', agreed: /【同意注册】\s*虚拟小城/.test(res.reply || '') };
}

// ★ 降级版：chat.js 加载失败时的本地简化回复（存储直写 + 简化AI）
async function sendGameShareLocal(activeId, otherId, shareText, activeName) {
    const pairKey = [activeId, otherId].sort().join('||');
    const map = JSON.parse(localStorage.getItem('chat_messages') || '{}');
    const messages = map[pairKey] || (map[pairKey] = []);
    const otherName = getCharacterNameById(otherId) || otherId;

    messages.push({ senderId: activeId, senderDisplayName: activeName, text: shareText });
    localStorage.setItem('chat_messages', JSON.stringify(map));

    let charBase = null;
    try {
        charBase = JSON.parse(localStorage.getItem('rolebook_characters') || '[]').find(c => c.id === otherId) || null;
        if (!charBase) charBase = JSON.parse(localStorage.getItem('worldnet_extra_characters') || '[]').find(c => c.id === otherId) || null;
        if (!charBase) { const info = new CharacterStore(otherId).getInfo(); if (info) charBase = { base: info }; }
    } catch (e) { }

    const { callAIWithMessages } = await import('../aiService.js');
    const history = messages.slice(-40).map(m => `${m.senderDisplayName || m.senderId}：${m.text}`).join('\n');
    const baseInfo = charBase ? JSON.stringify(charBase.base || charBase).slice(0, 800) : '';
    const systemPrompt =
        `你是${otherName}，请完全以这个角色的人设说话，用第一人称，不要跳出角色。` +
        (baseInfo ? `\n角色信息：${baseInfo}\n` : '') +
        '\n对方正在向你分享一款叫「虚拟小城」的角色扮演游戏。如果你对这个游戏感兴趣、愿意入住，请在回复末尾加上【同意注册】虚拟小城；如果不感兴趣就正常回复，不要加任何标记。保持你的说话风格与角色人设。';
    let raw = '';
    try {
        const r = await callAIWithMessages({ systemPrompt, userContent: `【聊天记录】\n${history}\n\n【请你现在回应对方】`, maxTokens: 1024, temperature: 0.9 });
        raw = String(r || '').trim();
    } catch (e) { raw = `⚠️ ${e.message}`; }
    const reply = raw.replace(/【(记忆|修改记忆|删除记忆)】.+?(?=\n|$)/g, '').trim();

    messages.push({ senderId: otherId, senderDisplayName: otherName, text: reply });
    localStorage.setItem('chat_messages', JSON.stringify(map));
    return { reply };
}

// ★ 执行目标设立：new→蜕变；merge→合并（无冗余）；reject→保持
async function applyEstateGoal(container, globalState, onBack, roleId, profile, estate, goal) {
    let refreshTarget = null;   // ★ merge 后原地应刷成目标页
    try {
        const verdict = await taskManager.submit('city_eval', `🎯 评估地产目标：${goal}`, () => assessEstateGoal(roleId, profile, goal, simCityEstates.estates))
            .catch(e => ({ action: 'reject', reason: '评估任务失败：' + (e.message || e) }));
        // ★ 无论通过与否，评语都存入纪念册
        if (verdict.comment) {
            await addMemento(roleId, profile, { type: 'estate_comment', title: '🏷️ 评估官评语', comment: verdict.comment, createdAt: Date.now() });
        }
        if (verdict.action === 'reject') {
            toast(`❌ ${verdict.reason || '目标未通过评估'}${verdict.comment ? '\n' + verdict.comment : ''}`, '#e53935');
            return;
        }
        if (verdict.action === 'merge' && verdict.targetId) {
            const target = simCityEstates.estates.find(e => e.id === verdict.targetId);
            if (target) {
                // ★ 合并者 B 也加入建设日程（读 target 的建设定义）
                const myP = await getProfile(roleId);
                if (myP && addEstateSched(roleId, myP, target)) {
                    await saveProfile(myP, roleId);
                    upsertCharPlaceIndex(placeIndex, myP, dayStr(new Date()), roleId);   // ★ 建设加入即时生效
                }
                target.progress = (target.progress || 0) + 30;                        // ★ 我的地块贡献 30 点
                if (!(target.contributors || []).includes(roleId)) target.contributors.push(roleId);
                // ★ 我的地产合并消失（无冗余）
                simCityEstates.estates = simCityEstates.estates.filter(e => e.id !== estate.id);
                await saveEstates();
                toast(`🔀 已合并进「${target.goal}」建设（+30，当前 ${target.progress}/${target.maxProgress}）`, '#7c4dff');
                refreshTarget = target;   // ★ 记录：原地应刷成目标页（不再直接渲染）
                return;
            }
        }
        // ★ new：AI 返回后重新取最新引用（等待期间 loadEstates 可能已替换对象，避免写旧对象丢数据）
        const cur = simCityEstates.estates.find(e => e.id === estate.id) || estate;
        cur.goal = verdict.name || goal;
        cur.name = `${cur.goal}·建设中`;
        cur.status = 'building';
        cur.progress = 30;
        cur.maxProgress = verdict.maxProgress || 100;
        cur.ip = verdict.ip || [];
        cur.tags = verdict.tags || [goal];
        cur.lastProgress = Date.now();   // ★ 进度结算基准：从目标确立起算
        // ★ 建设定义（AI 评估的时段） + owner 的建设日程
        const bt = parseBuildTime(verdict.buildTime);
        cur.buildSched = { time: bt.start, endTime: bt.end, act: verdict.buildAct || `参与${cur.goal}建设` };
        if (addEstateSched(roleId, profile, cur)) {
            await saveProfile(profile, roleId);
            upsertCharPlaceIndex(placeIndex, profile, dayStr(new Date()), roleId);   // ★ 建设加入即时生效
        }
        await saveEstates();
        toast(`🎯 目标「${cur.goal}」已确立，开始建设（30/${cur.maxProgress}）`, '#7c4dff');
    } catch (e) {
        console.warn('目标评估失败:', e);
        toast('❌ 目标评估失败，请重试', '#e53935');
    } finally {
        pendingTargets = pendingTargets.filter(t => t.estateId !== estate.id);   // ★ 解锁
        await saveEstates();
        // ★ 目标匹配：当前页面显示的评估目标 === 本任务目标 → 原地刷新；否则静默
        const uiGoal = (container.querySelector('#pendingGoal') || {}).textContent || '';
        if (uiGoal === goal) {
            const latest = refreshTarget || simCityEstates.estates.find(e => e.id === estate.id) || estate;
            renderEstate(container, globalState, onBack, roleId, profile, latest);
        }
    }
}

// ★ 建设完成：AI 焕新为建成形态（标签/环境语/子地点/职业壳子/评语），释放建设行程，评语存入所有共建者纪念册
async function transformEstate(container, globalState, onBack, roleId, profile, estate) {
    try {
        const verdict = await taskManager.submit('city_eval', `🏗️ ${estate.goal} 焕新评估`, async () => {
            const { callAIWithMessages } = await import('../aiService.js');
            // ★ 当前小城角色名单（供 events 的 roles/tags 引用，让事件与角色绑定）
            const profiles = await getAllProfiles();
            const rosterTxt = profiles.map(p => `${p.name}${(p.tags || []).length ? '(' + p.tags.join('/') + ')' : ''}`).join('、');

            const systemPrompt =
                '你是"模拟小城"的建设评估官，负责将一座建设完成的私人地产焕新为正式特别场景。' +
                '根据地产的目标与规模，生成建成形态：' +
                '1) name：最终场景名正常情况下为目标名。' +
                '2) tags：场景标签数组（世界观、特色，如["fate","圣杯战争"]）。' +
                '3) desc：一段独立的环境描述语（氛围、风貌，60字内）；同时给出 btn（该地点的简短互动文案，10字内，用于地点主按钮，如"推门而入"、"进店坐坐"、"探访古迹"）。' +
                '4) ambience：本体的分时段环境语，6个时段key：night（22-5点夜色）、dawn（5-8点清晨）、morning（8-12点上午）、noon（12-14点午后）、day（14-18点白天）、dusk（18-22点傍晚），每段一句40字内的画面感描写，贴合世界观。' +
                '5) events：本体专属随机事件池，3~5条，每条含 text（事件描述，建议2~3句、带起因与悬念，别只是一句氛围描写）' +
                '与可选 type（事件类型：悬疑/委托/奇遇/温情/危机，用于文游叙事引导）、可选数值效果 money/mood/energy（-5~10），至少一条带数值效果。' +
                '可带 roles（角色名数组，从userContent的角色名单中选）绑定归属：roles 事件的触发者就是该角色本人，' +
                '所以文本必须用第一人称"你"（触发者视角），不要出现 roles 里的角色名（避免"自己遇见自己"，特殊情况如"他人谈论自己"除外）；' +
                '可带 tags（角色标签数组，如["fate"]）：任何带该标签的角色行动都可能触发，文本可用氛围描写或点名"某类人"；' +
                '不带 roles/tags 为通用事件兜底，至少留 1 条。' +
                '6) residential（可选）：若该地产内设有住宅区（可购买住房），给出住宅区名字（如"教职工宿舍"、"学生公寓"）；没有住宅区则不输出该字段。' +
                '7) subs：相关子地点数组，2~4个，每个含 name（子地点名，避免使用"-"或"·"字符）、icon（emoji，可选）、act（可做什么，如"参拜/静思"，作为行为事件）、btn（简短互动文案，10字内，用于按钮显示，如"进寺参拜"，与 act 不同）、desc（简述），并可带 ambience（6段）与 events（2~4条），格式同本体。' +
                '每个子地点也可带 residential（该子地点若有住宅区，给住宅区名，可选）' +
                '8) jobs：相应职业数组，1~3个，每个含 name、desc、requireSkills、quota（岗位上限1~6）、sub（建议一半以上职业关联到子地点，填子地点名即可，如"柳洞寺"，不带父级前缀）...' +
                '9) comment：一段给共建者的评语（庆祝建成，60字内）。' +
                '10) shops：商店数组（AI 判断该地产/子地点是否有商业属性，有才生成；通常 0~2 个商店）：每个含 name（商店名，将显示为抽屉按钮文案）、icon（emoji）、sub（关联子地点名或"本体"）、items（3~5 个商品：name/icon/desc/price/qty，price 50~5000，qty 1~5，贴合世界观）。' +
                '只输出JSON：{"name":"冬木市","tags":["fate","圣杯战争"],"desc":"...","btn":"四处看看","residential":"亭台水榭","ambience":{"night":"...","dawn":"...","morning":"...","noon":"...","day":"...","dusk":"..."},"events":[{"type":"悬疑","text":"你在教堂地下密室发现一本写满禁忌咒文的旧书，书页间夹着一张泛黄的照片，背面写着：今晚钟楼见。","mood":-2,"roles":["言峰绮礼"]},{"type":"奇遇","text":"你感到空气中弥漫着淡淡的魔力，仿佛有人在暗中窥视。","mood":1,"tags":["fate"]},{"text":"募捐箱里的零钱被风吹了一地，你顺手捡起几枚。","money":5}],"subs":[{"name":"柳洞寺","icon":"⛩️","act":"参拜/静思","desc":"...","residential":"学生宿舍","ambience":{"night":"...","dawn":"...","morning":"...","noon":"...","day":"...","dusk":"..."},"events":[{"text":"...","mood":2}]},{"name":"教会","icon":"⛪","act":"祈祷/咨询","desc":"..."}],"shops":[{"name":"卫宫家的杂货铺","icon":"🛒","sub":"柳洞寺","items":[{"name":"魔力水晶","icon":"💎","desc":"蕴含魔力的小石头","price":500,"qty":3},{"name":"圣餐面包","icon":"🍞","desc":"教会食堂的松软面包","price":120,"qty":5}]}],"jobs":[{"name":"圣杯战争观察员","desc":"...","requireSkills":["魔术"],"quota":3,"sub":"柳洞寺"},{"name":"教会司祭","desc":"...","requireSkills":[],"quota":2,"sub":"教会"}],"comment":"..."}，不要任何其他文字。';
            const userContent =
                `地产目标：${estate.goal}\n` +
                `规模：${estate.maxProgress} 点（数值越大规模越大）\n` +
                `共建者：${(estate.contributors || []).length} 人\n` +
                `世界观：${(estate.ip || []).join('、') || '未知'}\n` +
                `角色名单：${rosterTxt}`;
            const raw = await callAIWithMessages({ systemPrompt, userContent, maxTokens: 12000, temperature: 0.8 });
            return parseAiJson(raw || '');
        }).catch(() => null);

        if (!verdict || !verdict.name) { toast('❌ 焕新评估失败，请稍后再试', '#e53935'); return; }
        // ★ AI 返回后重新取最新引用（等待期间可能被 loadEstates 替换，避免写旧对象丢数据）
        estate = simCityEstates.estates.find(e => e.id === estate.id) || estate;

        // ★ 应用建成形态（同一地产对象"焕新"）
        estate.status = 'built';
        estate.name = estate.goal;
        estate.tags = Array.isArray(verdict.tags) ? verdict.tags : [estate.goal];
        estate.desc = String(verdict.desc || '');
        estate.btn = String(verdict.btn || '').trim().slice(0, 10) || '开始互动';
        estate.residential = String(verdict.residential || '').trim().slice(0, 12);
        estate.ambience = sanitizeAmbience(verdict.ambience);
        estate.events = sanitizeEvents(verdict.events);
        // ★ 商店：生成 shopId → 存商店表 → 地点只存引用（estate.shopId / subs[i].shopId）
        const shops = sanitizeShops(verdict.shops) || [];
        estate.shopId = null;
        for (const sub of (estate.subs || [])) sub.shopId = null;
        for (let i = 0; i < shops.length; i++) {
            const s = shops[i];
            const shopId = 'est_shop_' + estate.id + '_' + i;
            simCityShops[shopId] = { name: s.name, icon: s.icon, items: s.items, lastRestockDay: dayStr(new Date()) };
            if (s.sub === '本体' || s.sub === estate.name || s.sub === subDisplayName(estate.name)) estate.shopId = shopId;
            else {
                const sub = (estate.subs || []).find(x => subDisplayName(x.name) === s.sub);
                if (sub) sub.shopId = shopId;
            }
        }
        if (shops.length) await saveSimCityShops(simCityShops).catch(() => { });

        estate.subs = (Array.isArray(verdict.subs) ? verdict.subs : []).map((s, i) => ({
            key: 'est_sub_' + estate.id + '_' + i,
            name: `${estate.goal}-${String(s.name || '子地点' + (i + 1))}`,   // ★ 全名："冬木市-柳洞寺"
            icon: String(s.icon || '🏛️'),
            act: String(s.act || ''),
            desc: String(s.desc || ''),
            btn: String(s.btn || '').trim().slice(0, 10) || '进入',
            residential: String(s.residential || '').trim().slice(0, 12),
            ambience: sanitizeAmbience(s.ambience),
            events: sanitizeEvents(s.events)
        }));
        estate.jobs = (Array.isArray(verdict.jobs) ? verdict.jobs : []).slice(0, 3).map((j, i) => {
            const subMatch = j.sub ? (estate.subs || []).find(s => subDisplayName(s.name) === String(j.sub)) : null;   // ★ 全名拆纯名匹配（"冬木市-柳洞寺" → "柳洞寺"）
            return {
                key: 'est_job_' + estate.id + '_' + i,
                name: String(j.name || '职业' + (i + 1)),
                desc: String(j.desc || ''),
                requireSkills: Array.isArray(j.requireSkills) ? j.requireSkills : [],
                placeKey: estate.id,
                subKey: subMatch ? subMatch.key : '',
                base: Math.round(20 + estate.maxProgress / 200),
                hourly: Math.round(5 + estate.maxProgress / 500),
                quota: Math.max(1, parseInt(j.quota, 10) || 2)
            };
        });
        await saveEstates();

        // ★ 释放建设行程（完成）
        await removeEstateSched(estate.id);
        await buildPlaceIndex().then(idx => { placeIndex = idx; });   // ★ 释放建设行程（多人）后全量重建

        // ★ 评语存入所有共建者纪念册
        if (verdict.comment) {
            for (const cid of (estate.contributors || [])) {
                const cp = await getProfile(cid);
                if (cp) await addMemento(cid, cp, { type: 'estate_built', title: `🏙️ ${estate.name} 建设完成`, comment: String(verdict.comment), createdAt: Date.now() });
            }
        }
        toast(`🏙️ ${estate.name} 建成！评语已存入共建者纪念册`, '#7c4dff');
    } catch (e) {
        console.warn('焕新失败:', e);
        toast('❌ 焕新失败，请重试', '#e53935');
    } finally {
        pendingTargets = pendingTargets.filter(t => t.estateId !== estate.id);   // ★ 解锁
        await saveEstates();
        const uiGoal = (container.querySelector('#pendingGoal') || {}).textContent || '';
        if (uiGoal === (estate.goal || '')) {   // ★ 原地匹配 → 刷新建成形态
            const latest = simCityEstates.estates.find(e => e.id === estate.id) || estate;
            renderEstate(container, globalState, onBack, roleId, profile, latest);
        }
    }
}

async function removeEstateSched(estateId) {
    const profiles = await getAllProfiles();
    const writes = [];
    for (const p of profiles) {
        if ((p.builds || []).some(x => x.estateId === estateId)) {
            p.builds = (p.builds || []).filter(x => x.estateId !== estateId);
            writes.push({ profile: p, roleId: p.id });
        }
    }
    if (writes.length) await saveProfiles(writes);
}

// ★ 约定/行程地点规范化：静态 PLACES → 说话人可见的动态地产 → 原样（保证索引/在场一致）
function normalizePlaceName(raw, roleId, profile) {
    const p = PLACES.find(x => x.name === raw || raw.startsWith(x.name));
    if (p) return p.name;
    const est = (simCityEstates.estates || []).find(e =>
        canSeeEstate(roleId, profile, e) &&
        (e.name === raw || raw.includes(e.name) || e.name.includes(raw) ||
            (e.goal || '') === raw || raw.includes(e.goal || '') || (e.goal || '').includes(raw)));
    if (est) return est.name;   // ★ 规范为地产标准名（建设中/建成都用 estate.name）
    return raw;
}

// ★ 该角色“认识路”的地点：家 + 职业地点 + 日常行程地点 + 可见地产（本体名+子地点全名）
function knownPlaceNames(profile, roleId) {
    const names = new Set(['家']);
    if (profile.jobKey) {                                   // 职业地点（上班的地方肯定认识路）
        const j = getJob(profile.jobKey);
        if (j) {
            const pn = (PLACES.find(p => p.key === j.placeKey) || {}).name;
            if (pn) names.add(pn);
            const sn = j.subKey ? (PLACES.find(p => p.key === j.subKey) || {}).name : '';
            if (sn) names.add(sn);
        }
    }
    (profile.schedule || []).forEach(s => s.place && names.add(s.place));   // 日常行程
    (simCityEstates?.estates || []).forEach(e => {                          // 同世界观地产
        if (canSeeEstate(roleId, profile, e)) {
            names.add(e.name);
            (e.subs || []).forEach(s => names.add(s.name));                 // 子地点全名
        }
    });
    return [...names];
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
    { key: 'mall', name: '商业街', icon: '🏬', image: '', act: 'shop', desc: '逛街淘货', residential: '商业街' },
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

// ★ 游乐场项目（点击 → 扣钱 → AI 生成游玩体验；鬼屋 multi = 可邀请好友）
const FUN_RIDES = [
    { key: 'carousel', icon: '🎠', name: '旋转木马', price: 20, mood: 10, energy: 0, desc: '转啊转，回到童年' },
    { key: 'roller', icon: '🎢', name: '过山车', price: 40, mood: 25, energy: -15, desc: '尖叫解压' },
    { key: 'bumper', icon: '🚗', name: '碰碰车', price: 25, mood: 15, energy: -8, desc: '横冲直撞' },
    { key: 'ferris', icon: '🎡', name: '摩天轮', price: 30, mood: 18, energy: 0, desc: '俯瞰小城' },
    { key: 'haunted', icon: '👻', name: '鬼屋', price: 20, mood: 12, energy: -5, multi: true, desc: '心跳加速' },
    { key: 'toss', icon: '🎯', name: '套圈', price: 15, mood: 8, energy: -3, desc: '试试手气' },
];

// 地图格子：没有 parent 的地点（12 个）
const MAP_PLACES = PLACES.filter(p => !p.parent);
// ① childrenOf（L627）支持动态地产的子地点：
const childrenOf = key => {
    const staticSubs = PLACES.filter(p => p.parent === key);
    if (staticSubs.length) return staticSubs;
    const e = (simCityEstates?.estates || []).find(x => x.status === 'built' && x.id === key);
    return e ? (e.subs || []).map(s => ({ ...s, parent: key, icon: s.icon || '🏛️', act: s.act || 'rest', desc: s.desc || '' })) : [];
};
// 任意地点查找（含子地点）
const findPlace = key => getPlace(key) || PLACES[0];

// ★ 默认房型（住宅区第一版统一；动态地产生成时后续优化）
const DEFAULT_HOUSE = { type: 'default', name: '标准住宅', icon: '🏠', price: 800, desc: '温馨的标准居所', template: 'apartment' };

// 房子模板：全局静态配置，房产实例只存 template key（不复制模板）
const HOUSE_TEMPLATES = {
    default: { name: '基础小窝', icon: '🏠', price: 0, area: '家', desc: '每个角色都有的默认房子', space: 0 },   // default 不参与空间系统
    apartment: { name: '高层公寓', icon: '🏢', price: 800, area: '住房区', desc: '城里的高层公寓', space: 20 },
    shopHouse: { name: '临街小楼', icon: '🏘️', price: 1500, area: '商业街', desc: '商业街旁的二层小楼', space: 25 },
    farmHouse: { name: '田园小屋', icon: '🌾', price: 1000, area: '郊外', desc: '带小院子的田园小屋', space: 30 },
    villa: { name: '独栋别墅', icon: '🏡', price: 3000, area: '别墅区', desc: '独栋带花园', space: 40 },
};
// ★ 房间施工费（金币/格，可调）
const ROOM_COST_PER_GRID = 60;

// ★ 测试兑换码（调试/验证用，正式发布前移除）
const REDEEM_CODES = {
    'GOLD3000': 3000,   // 够买高层公寓（800）/田园小屋（1000）/临街小楼（1500）
    'GOLD9999': 9999,   // 够买独栋别墅（3000）解锁私人地产，还有余钱
};

// 职业表：单一数据源（地点-详细地点-职位 命名，便于同种类不同地点扩展）
// 消费方：AI评估 / 场景应聘 / 每日结算 / 市政厅登记表——只改这张表全系统联动
const JOB_DEFS = {
    'hall-hall-clerk': { name: '文员', placeKey: 'hall', subKey: '', base: 40, hourly: 22, quota: 3, hallStaff: true },
    'mall-mallshop-owner': { name: '店主', placeKey: 'mall', subKey: 'mallshop', base: 0, hourly: 45, quota: 2, hallStaff: false },
    'mall-restaurant-chef': { name: '厨师', placeKey: 'mall', subKey: 'restaurant', base: 0, hourly: 38, quota: 2, hallStaff: false },
    'mall-milktea-barista': { name: '奶茶师', placeKey: 'mall', subKey: 'milktea', base: 0, hourly: 25, quota: 2, hallStaff: false },
    'entertain-ktv-singer': { name: '驻唱', placeKey: 'entertain', subKey: 'ktv', base: 0, hourly: 30, quota: 2, hallStaff: false },
    'school-teach-teacher': { name: '教师', placeKey: 'school', subKey: 'teach', base: 30, hourly: 32, quota: 5, hallStaff: false },
    'school-student': { name: '学生', placeKey: 'school', subKey: '', base: 0, hourly: 0, quota: 999, hallStaff: false },
    'clinic-clinic-doctor': { name: '医生', placeKey: 'clinic', subKey: '', base: 50, hourly: 40, quota: 2, hallStaff: false },
    'clinic-clinic-nurse': { name: '护士', placeKey: 'clinic', subKey: '', base: 20, hourly: 28, quota: 3, hallStaff: false },
};

// 职位上班地点名列表（工时统计用）：绑了详细地点就用它，否则用地点名
function jobWorkNames(jobDef) {
    const names = [];
    const p = findPlace(jobDef.placeKey);
    if (p) names.push(p.name);
    if (jobDef.subKey) {
        const s = findPlace(jobDef.subKey);
        if (s) names.push(s.name);   // ★ 静态=纯名"教学楼"，动态=全名"冬木市-柳洞寺"，直接 push，不拼不拆
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
    const job = getJob(p.jobKey);
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
    for (const p of profiles) {
        if (!p.jobKey) continue;
        const j = getJob(p.jobKey);
        const k = j ? j.key : p.jobKey;   // ★ 归一化到标准 key（历史脏 jobKey 也算到同一职位下）
        counts[k] = (counts[k] || 0) + 1;
    }
    return counts;
}

// ============ 游戏内好感度（亲密度 + 修正） ============
function pairKeyOf(a, b) { return [a, b].sort().join('_'); }
function getIntimacy(a, b) { return simCityRelations?.map?.[pairKeyOf(a, b)]?.score || 0; }
function getRelationMod(profile, targetId) { return (profile?.relationMods || {})[targetId] || 0; }
function getEffectiveRelation(profile, targetId) {
    return Math.max(0, Math.min(100, getIntimacy(profile.id, targetId) + getRelationMod(profile, targetId)));
}
function starOf(score) {
    if (score >= 81) return '★★★★★';
    if (score >= 61) return '★★★★';
    if (score >= 41) return '★★★';
    if (score >= 21) return '★★';
    if (score >= 5) return '★';
    return '';
}
function relationLayerOf(score) {
    if (score >= 81) return '挚友'; if (score >= 61) return '亲友'; if (score >= 41) return '密友';
    if (score >= 21) return '朋友'; if (score >= 5) return '熟人'; return '无感';
}
// ★ 注入块："你们的游戏亲密度是X（★密友），你对ta的好感度修正是+10"
function relationBlockFor(profile, targetId, targetName) {
    if (!profile || !targetId || targetId === profile.id) return '';
    const inti = getIntimacy(profile.id, targetId);
    const mod = getRelationMod(profile, targetId);
    if (!inti && !mod) return '';   // ★ 无任何好感数据：不注入（省 token）
    const star = starOf(inti);
    const parts = [`你们的游戏亲密度是${inti}${star ? `（${star}${relationLayerOf(inti)}）` : ''}`];
    if (mod) parts.push(`你对${targetName || 'ta'}的好感度修正是${mod > 0 ? '+' : ''}${mod}`);
    let out = parts.join('，');
    if (mod) out += `（你实际感觉 ${getEffectiveRelation(profile, targetId)}）`;
    return out;
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
    const formal = profile.jobKey && getJob(profile.jobKey);
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
                    ${jobsHere.map(j => {
        const current = profile.jobKey === j.key;
        return `
                        <div class="simcity-item apply-job" data-job="${esc(j.key)}">
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

// ★ 住宅区折叠区（该地点可居住时显示；职位下方）
function residentialCollapseHtml(place, profile) {
    if (!place.residential) return '';
    const res = simCityResidentials[place.key] || { name: place.residential, houses: [{ ...DEFAULT_HOUSE }] };
    const residents = res.residents || [];
    const mine = residents.filter(r => r.roleId === profile.id);
    const others = residents.filter(r => r.roleId !== profile.id && getIntimacy(profile.id, r.roleId) >= 41);
    const visible = [...mine, ...others];
    const buyable = res.houses && res.houses.length;
    return `
        <div style="margin-top:12px;">
            <div id="resToggle" style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:rgba(255,255,255,0.9);border-radius:14px;cursor:pointer;box-shadow:0 1px 6px rgba(0,0,0,0.06);">
                <span style="font-size:13px;font-weight:600;color:#8d6e63;">🏘️ ${esc(res.name)}${visible.length ? ` · 住户 ${visible.length} 户` : ''}</span>
                <span class="res-arrow" style="font-size:12px;color:#bcaaa4;">▾</span>
            </div>
            <div class="res-list" style="display:none;margin-top:8px;">
                ${buyable ? `<div class="simcity-room">
                    ${(res.houses || []).map(h => `
                        <div class="simcity-item res-house" data-house="${esc(h.name)}">
                            <div class="item-name">${h.icon || '🏠'} ${esc(h.name)}</div>
                            <div class="item-desc">💰${h.price} · ${esc(h.desc)} · 点击购买</div>
                        </div>`).join('')}
                </div>` : ''}
                ${visible.length ? `<div class="simcity-room" style="margin-top:8px;">
                    ${visible.map(r => `
                        <div class="simcity-item res-home" data-prop="${esc(r.propId)}">
                            <div class="item-name">🏠 ${esc(r.address || res.name)}</div>
                            <div class="item-desc">${r.roleId === profile.id ? '我的家 · 点击进入' : `${esc(r.name)}的家 · 点击进入`}</div>
                        </div>`).join('')}
                </div>` : ''}
                ${!buyable && !visible.length ? '<div style="text-align:center;color:#999;padding:10px 0;font-size:12px;">这里还没有住户</div>' : ''}
            </div>
        </div>`;
}

function bindResidentialToggle(container) {
    const toggle = container.querySelector('#resToggle');
    if (!toggle) return;
    toggle.addEventListener('click', () => {
        const list = toggle.nextElementSibling;
        const arrow = toggle.querySelector('.res-arrow');
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
    const myEstates = (simCityEstates.estates || []).filter(e => canSeeEstate(roleId, profile, e));   // ★ 可见地产（参与/同IP/行程）

    const pageCount = Math.ceil(MAP_PLACES.length / 9) + (myEstates.length ? 1 : 0);
    container.innerHTML = `
        <div class="simcity-root">
            <div class="simcity-header">
                <button class="back-btn" id="scBack">←</button>
                <span class="title">🏙️ ${esc(profile.name)}</span>
                <span class="level">Lv.${profile.level}</span>
            </div>
            <div class="simcity-body">
                <div class="simcity-char">
                    <div class="avatar" id="charAvatar" style="cursor:pointer;">${getAvatarHtml(roleId)}</div>
                    <div>
                        <div class="cname">${esc(profile.name)} <small>（${esc(realName(roleId))}）</small></div>
                        <div class="cjob">${esc(jobDisplay(profile))} · 已入住 ${Math.floor((Date.now() - profile.createdAt) / 86400000) + 1} 天</div>
                    </div>
                </div>

                ${simCityWorldBarHtml()}


                <div class="simcity-map-wrap">
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
                            ${myEstates.length ? `   <!-- ★ 特别地点页（动态：建设中=参与可见；建成=标签/行程可见） -->
                                <div class="simcity-page">
                                    <div class="simcity-grid">
                                        ${myEstates.map(e => `
                                            <div class="simcity-plot" data-estate="${esc(e.id)}">
                                                <div class="icon">${e.icon || '🏰'}</div>
                                                <div class="name">${esc(e.name)}</div>
                                                <div class="desc">${e.status !== 'built' ? `建设中 ${e.progress}/${e.maxProgress || '∞'}` : (e.tags || []).slice(0, 2).join('·')}</div>
                                            </div>`).join('')}
                                    </div>
                                </div>` : ''}
                        </div>
                    </div>
                    <div class="simcity-mapdots">${Array.from({ length: pageCount }, () => '<i></i>').join('')}</div>
                </div>
            </div>
            <div class="simcity-actions">
                <button class="simcity-btn" id="scFriends">👥 好友</button>
                <button class="simcity-btn primary" id="scPerm">🔐 授权</button>
            </div>
        </div>`;

    container.querySelector('#scBack').addEventListener('click', () => onBack && onBack());
    container.querySelector('#scFriends').addEventListener('click', () => showFriends(container, globalState, onBack, roleId, profile));
    container.querySelector('#scPerm').addEventListener('click', () => showPermView(container));

    // ★ 地图页指示器联动
    const scMap = container.querySelector('.simcity-map');
    const scDots = container.querySelectorAll('.simcity-mapdots i');
    const updDots = () => {
        if (!scMap || !scDots.length) return;
        const idx = Math.round(scMap.scrollLeft / (scMap.clientWidth || 1));
        scDots.forEach((d, i) => d.classList.toggle('on', i === Math.min(idx, scDots.length - 1)));
    };
    if (scMap && scDots.length) scMap.addEventListener('scroll', updDots, { passive: true });
    updDots();

    container.querySelectorAll('.simcity-plot').forEach(plot => {
        plot.addEventListener('click', () => {
            const m = container.querySelector('.simcity-map');
            mapScrollLeft = m ? m.scrollLeft : 0;
            if (plot.dataset.estate) {
                const est = (simCityEstates.estates || []).find(e => e.id === plot.dataset.estate);   // ★ 从世界注册表按 id 找（模板里 data-estate 存的是 e.id）
                if (est) {
                    if (est.status === 'built') {
                        renderPlace(container, globalState, onBack, roleId, profile, est.id);   // ★ 建成→主地点式（getPlace 动态支持）
                    } else {
                        renderEstate(container, globalState, onBack, roleId, profile, est);     // 建设中→地产页
                    }
                }
            } else if (plot.dataset.key) {
                renderPlace(container, globalState, onBack, roleId, profile, plot.dataset.key);
            }
        });
    });
    container.querySelector('#charAvatar').addEventListener('click', () => showCharSheet(container, globalState, onBack, roleId, profile));   // ★ 点击头像查看角色状态

    // ★ 返回地图时恢复上次停留页，并同步圆点（scrollLeft 赋值不触发 scroll 事件，需手动 updDots）
    if (scMap && mapScrollLeft) { scMap.scrollLeft = mapScrollLeft; updDots(); }
    startDayNightCycle(container);   // ★ 地图日夜更替（进入地点/离开小城时自动清理）

}

// 模块级：执行地点行动
async function doAction(container, globalState, onBack, roleId, profile, act, afterRender, placeKey) {
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
            { name: '鲜花', price: 25, mood: 10 }, { name: '游戏机', price: 200, mood: 40 },
            { name: '🏠 土地地契', price: 1200, mood: 0, estate: true }   // ★ 即买即用获得一块私人地产
        ];
        const it = items[Math.floor(Math.random() * items.length)];
        if (profile.money < it.price) { toast('💰 金币不足', '#e53935'); return; }
        profile.money -= it.price;
        if (it.estate) {
            // ★ 地契：即买即用，创建一块私人地产（与买别墅同结构，世界注册表）
            await loadEstates();
            simCityEstates.estates.push({
                id: 'est_' + Date.now().toString(36),
                key: 'estate_' + Date.now().toString(36), goal: '', name: '私人土地', icon: '🏠',
                status: 'building', progress: 30, maxProgress: 0,
                contributors: [roleId], owner: roleId, ip: [], tags: [],
                subs: [], jobs: [], desc: '', entryRule: null, createdAt: Date.now()
            });
            await saveEstates();
            toast('🏠 购得土地地契！私人地产已解锁，去主城地图看看吧', '#7c4dff');
        } else {
            profile.mood = Math.min(100, profile.mood + it.mood);
            toast(`🛒 买了${it.name}，心情+${it.mood}`, '#ff9800');
        }
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
    // ★ 行动后小概率随机事件：挂事件槽（环境卡感叹号可深入体验）；属性效果照常应用
    const simCityEvt = simCityRandomEvent(placeKey, profile);
    if (simCityEvt) {
        if (simCityEvt.money) profile.money = Math.max(0, profile.money + simCityEvt.money);
        if (simCityEvt.mood) profile.mood = Math.min(100, Math.max(0, profile.mood + simCityEvt.mood));
        if (simCityEvt.energy) profile.energy = Math.min(100, Math.max(0, profile.energy + simCityEvt.energy));
        if (placeKey) { pendingEvents[placeKey] = { ...simCityEvt, at: Date.now() }; savePendingEvents(); }

        await save();
        toast('🔔 这里似乎发生了什么，看看环境卡右上角', '#ff9800');
    }
    (afterRender || renderMain)(container, globalState, onBack, roleId, profile);
}

// 某地点此刻在场角色区块（真实时间小时）
function presentSectionHtml(placeName, roleId) {
    const hour = new Date().getHours();
    const ids = getPresentAt(placeIndex, placeName, hour);
    const others = ids.filter(id => id !== roleId);
    if (!others.length) {
        return '<div class="simcity-note">🕐 此刻这里很安静，没有其他人</div>';
    }
    return `
        <div class="sc-present">
            <div class="sc-present-hd">🕐 此刻在场（${hour}:00）</div>
            ${others.map(id => `
                <div class="sc-person">
                    <div class="avatar">${getAvatarHtml(id)}</div>
                    <div class="sc-name">${esc((charDisplayMap[id] && charDisplayMap[id].name) || getCharacterNameById(id) || id)}${(() => {
            const st = charStatus(id, placeName);
            return st ? `<small>（${st}）</small>` : '';
        })()}</div>
                    <button class="sc-btn enc sc-encounter" data-friend="${esc(id)}" data-place="${esc(placeName)}">偶遇</button>
                    <button class="sc-btn chat sc-chat" data-friend="${esc(id)}" data-place="${esc(placeName)}">对话</button>
                </div>`).join('')}
        </div>`;
}

// ★ 公告牌：地点记录事件（每地点保留最近 30 条；type: action|chat|adventure|shop|move|build；防抖写库）
function addBulletin(placeKey, type, text) {
    if (!placeKey || !text) return;
    simCityBulletins = simCityBulletins || {};
    const list = simCityBulletins[placeKey] = simCityBulletins[placeKey] || [];
    list.push({ type, text: String(text).slice(0, 60), at: Date.now() });
    if (list.length > 30) list.splice(0, list.length - 30);
    clearTimeout(addBulletin._t);
    addBulletin._t = setTimeout(() => { saveSimCityBulletins(simCityBulletins).catch(() => { }); }, 800);
}

// ★ 地点名 → placeKey（静态 PLACES / 动态地产本体 / 子地点全名）
function placeKeyFromName(name) {
    if (!name) return null;
    const sp = PLACES.find(p => p.name === name || (p.aliases || []).includes(name));
    if (sp) return sp.key;
    for (const e of (simCityEstates?.estates || [])) {
        if (e.name === name) return e.id;
        const s = (e.subs || []).find(x => x.name === name);
        if (s) return s.key;
    }
    return null;
}

// ★ 动态地产配置：由 placeKey 定位建成地产的本体/子地点（ambience 分时段环境语 + events 地点事件池）
function estateAmbienceAt(placeKey) {
    for (const e of (simCityEstates?.estates || [])) {
        if (e.status !== 'built') continue;
        if (e.id === placeKey) return { ambience: e.ambience, events: e.events };
        const s = (e.subs || []).find(x => x.key === placeKey);
        if (s) return { ambience: s.ambience, events: s.events };
    }
    return null;
}

// ★ 时段 key（6 段，与 placeAmbience 模板一致）
function ambiencePeriod(hour) {
    if (hour >= 22 || hour < 5) return 'night';
    if (hour < 8) return 'dawn';
    if (hour < 12) return 'morning';
    if (hour < 14) return 'noon';
    if (hour < 18) return 'day';
    return 'dusk';
}

// ★ 分时段环境语清洗（6 段只留非空；非法输入回退 undefined）
const AMBIENCE_PERIODS = ['night', 'dawn', 'morning', 'noon', 'day', 'dusk'];
function sanitizeAmbience(obj) {
    if (!obj || typeof obj !== 'object') return undefined;
    const out = {};
    for (const k of AMBIENCE_PERIODS) {
        const v = String(obj[k] || '').trim();
        if (v) out[k] = v;
    }
    return Object.keys(out).length ? out : undefined;
}

// ★ 事件池清洗（与全局池同构：text + money/mood/energy 数值；可带 roles 角色名 / tags 标签关联；非法条目丢弃）
function sanitizeEvents(arr) {
    if (!Array.isArray(arr)) return undefined;
    const out = [];
    for (const e of arr) {
        if (!e || typeof e !== 'object') continue;
        const text = String(e.text || '').trim();
        if (text.length < 4) continue;
        // ★ 角色关联：roles 按角色名（profile.name）匹配；tags 按角色标签（profile.tags）匹配；都不带 = 通用事件
        const roles = Array.isArray(e.roles) ? e.roles.map(String).map(s => s.trim()).filter(Boolean).slice(0, 5) : undefined;
        const tags = Array.isArray(e.tags) ? e.tags.map(String).map(s => s.trim()).filter(Boolean).slice(0, 5) : undefined;
        out.push({
            text,
            money: Number.isFinite(Number(e.money)) ? Math.round(Number(e.money)) : 0,
            mood: Number.isFinite(Number(e.mood)) ? Math.round(Number(e.mood)) : 0,
            energy: Number.isFinite(Number(e.energy)) ? Math.round(Number(e.energy)) : 0,
            ...(roles && roles.length ? { roles } : {}),
            ...(tags && tags.length ? { tags } : {})
        });
    }
    return out.length ? out.slice(0, 8) : undefined;
}

// ★ 商店清洗（AI生成：0~2店/地产，每店3~5商品；数值容错；非法条目丢弃）
function sanitizeShops(arr) {
    if (!Array.isArray(arr)) return undefined;
    const out = [];
    for (const s of arr) {
        if (!s || typeof s !== 'object') continue;
        const name = String(s.name || '').trim();
        if (!name) continue;
        const items = [];
        for (const it of (Array.isArray(s.items) ? s.items : [])) {
            if (!it || typeof it !== 'object') continue;
            const iname = String(it.name || '').trim();
            if (iname.length < 2) continue;
            items.push({
                name: iname,
                icon: String(it.icon || '📦').slice(0, 4),
                desc: String(it.desc || '').trim(),
                price: Math.max(10, Math.min(100000, parseInt(it.price, 10) || 100)),
                qty: Math.max(1, Math.min(5, parseInt(it.qty, 10) || 3)),
                initQty: Math.max(1, Math.min(5, parseInt(it.qty, 10) || 3))
            });
            if (items.length >= 5) break;
        }
        if (!items.length) continue;
        out.push({ name, icon: String(s.icon || '🏪').slice(0, 4), sub: String(s.sub || '本体').trim(), items });
        if (out.length >= 2) break;
    }
    return out.length ? out : undefined;
}

// 地点环境描述（时段 × 地点个性氛围，仅装饰，不可点击）
//   天气不上场景卡：全局天气由主城横幅展示，避免 AI 提示词收到重复天气
function placeAmbience(place, hour) {
    // ★ 动态地产：优先用焕新时生成的分时段环境语（无则回退通用模板）
    const dyn = estateAmbienceAt(place.key);
    const dynTxt = dyn && dyn.ambience ? dyn.ambience[ambiencePeriod(hour)] : '';
    if (dynTxt) return String(dynTxt).trim() + '。';
    if (dyn) return '';   // ★ 动态地产没有生成时段语：不显示通用模板（宁愿留空）
    const hourTxt = (() => {
        if (hour >= 22 || hour < 5) return `夜色下的${place.name}，路灯昏黄，行人稀少`;
        if (hour < 8) return `清晨的${place.name}刚刚苏醒，空气清新`;
        if (hour < 12) return `上午的${place.name}渐渐热闹起来`;
        if (hour < 14) return `午后的${place.name}暖洋洋的，适合发呆`;
        if (hour < 18) return `${place.name}里人来人往`;
        return `傍晚的${place.name}灯火初上`;
    })();
    const isNightSpotScene = NIGHT_SPOTS.includes(place.key) && (hour >= 19 || hour < 5);
    const vibes = (!isNightSpotScene && SIMCITY_AMBIENCES[place.key]) ? SIMCITY_AMBIENCES[place.key] : [];
    const vibe = vibes.length ? vibes[hour % vibes.length] : '';
    return [hourTxt, vibe].filter(Boolean).join('，') + '。';
}

// ★ 从当前 UI 环境卡提取环境描述（界面显示什么，AI 就用什么；无环境卡或地点不符返回 ''）
function uiEnvText(container, placeName) {
    const envCard = container.querySelector('.simcity-env');
    if (envCard && envCard.dataset.flipped) return '';   // ★ 公告牌翻转态：不当作环境（群聊 AI 走 placeAmbience 兜底）
    const envName = (container.querySelector('.simcity-env .env-name') || {}).textContent || '';
    const envTxt = (container.querySelector('.simcity-env .env-desc') || {}).textContent || '';
    if (placeName && envName !== placeName) return '';
    return envTxt.trim();
}

// ★ 通用抽屉：{ title, icon, text（文本区）, buttons（功能区）, custom（自定义HTML，优先）, open（是否展开） }
function drawerHtml({ title, icon, text, buttons, custom, open }) {
    return `
        <div class="simcity-drawer-mask${open ? ' show' : ''}" id="scDrawerMask"></div>
        <div class="simcity-drawer${open ? ' show' : ''}" id="scDrawer">
            <div class="simcity-drawer-grip"></div>
            <div class="simcity-drawer-title">${icon || ''} ${esc(title)}</div>
            ${text ? `<div class="simcity-drawer-text" style="font-size:12px;color:#5a5470;line-height:1.7;margin-bottom:10px;">${esc(text)}</div>` : ''}
            <div class="simcity-drawer-body">
                ${custom || (buttons || []).map(b =>
        `<button class="simcity-btn ${b.primary ? 'primary' : ''}" data-drawer-action="${esc(b.id)}">${b.label}</button>`).join('')}
                <button class="simcity-btn" id="scDrawerClose">收起</button>   <!-- ★ 从 body 外移进来 -->
            </div>
        </div>`;
}

// ============ 抽屉功能注册表（干净：只登记）============
const DRAWER_FUNCS = {
    act: { label: '主动作', kind: 'button', handle: drawerFuncAct },
    night: { label: '🌙 夜生活事件', kind: 'button', handle: drawerFuncNight },
    adventure: { label: '🎭 开启文游', kind: 'button', handle: drawerFuncAdventure },
    // bank: { label: '🏦 存取款', kind: 'custom', render: drawerFuncBankRender, handle: drawerFuncBank },
};

// ============ 抽屉功能实现（注册表外）============
function drawerFuncAct(ctx) {
    const { place, sub, hour, open } = ctx;
    const name = sub ? sub.name : place.name;
    const act = sub ? sub.act : place.act;
    if (!open) { toast(`🌙 ${name}还没开门（${OPEN_HOURS[sub ? sub.key : place.key][0]}:00 营业）`, '#ff9800'); return; }
    doAction(ctx.container, ctx.globalState, ctx.onBack, ctx.roleId, ctx.profile, act, ctx.rerender, ctx.sub ? ctx.sub.key : ctx.place.key);
}

function drawerFuncNight(ctx) {
    const name = ctx.sub ? ctx.sub.name : ctx.place.name;
    const key = ctx.sub ? ctx.sub.key : null;
    showNightEvent(ctx.container, ctx.roleId, ctx.profile, name, key);
}

// ★ 该角色该场景的进行中文游（注册表查）
function ongoingAdvFor(placeKey, roleId) {
    return (simCityAdvRegistry?.adventures || []).find(a => a.placeKey === placeKey && a.status === 'ongoing' && (a.participants || []).includes(roleId)) || null;
}

// ★ 该角色该场景参与过的已结束文游（历史回看）
function endedAdvsFor(placeKey, roleId) {
    return (simCityAdvRegistry?.adventures || []).filter(a =>
        a.placeKey === placeKey && a.status === 'ended' &&
        ((a.participants || []).includes(roleId) || (a.pastParticipants || []).includes(roleId))
    );
}

// ★ 当前轮次正文：系统标注"谁的行为" + action + 正文（原样，不转化）
function advTurnText(t, roleId, mode) {
    if (!t.actor) return (t.scene || '').trim();
    const isSecond = mode !== 'third';
    const who = (isSecond && t.actor === roleId) ? '你' : charName(t.actor);
    return `【${who}的行动】${t.action || ''}\n${t.scene || ''}`.trim();
}

// ★ 历史轮次概要：系统标注"谁的行为" + action + 第三人称概要（不含正文）
function advTurnBrief(t, roleId, mode) {
    if (!t.actor) return (t.scene || '').trim();
    const isSecond = mode !== 'third';
    const who = (isSecond && t.actor === roleId) ? '你' : charName(t.actor);
    return `【${who}的行动】${t.action || ''}${t.summary ? ` —— ${t.summary}` : ''}`.trim();
}

// ★ 历史轮次详情正文（原样返回 scene，点开才看）
function advTurnDetail(t) {
    return t.actor ? (t.scene || '').trim() : '';
}

// ★ 单轮展示：isOld → 灰色概要（占一页，点开弹窗看详情）；否则正文
function advTurnLine(t, roleId, mode, advId, idx, isOld) {
    if (!isOld) return `<div class="sc-adv-page">${esc(advTurnText(t, roleId, mode))}</div>`;
    const brief = advTurnBrief(t, roleId, mode);
    if (!t.actor) return `<div class="sc-adv-page" style="font-size:12px;color:#8a7fa8;">${esc(brief)}</div>`;
    return `<div class="sc-adv-page sc-adv-old-line" data-adv-id="${esc(advId)}" data-turn-idx="${idx}" style="font-size:12px;color:#8a7fa8;cursor:pointer;">${esc(brief)} <span style="color:#bcaaa4;">▸ 详情</span></div>`;
}

// ★ 历史轮次详情弹窗（正文原样展示）
function showAdvDetail(container, advId, turnIdx, roleId) {
    const adv = simCityAdvCache[advId];
    const t = adv?.turns?.[turnIdx];
    if (!t || !t.actor) return;
    const overlay = document.createElement('div');
    overlay.className = 'simcity-pop';
    overlay.innerHTML = `
        <div class="simcity-pop-card">
            <div style="font-weight:700;font-size:15px;margin-bottom:10px;">📜 剧情详情</div>
            <div style="font-size:13px;line-height:1.8;color:#333;white-space:pre-wrap;overflow-y:auto;max-height:60vh;padding:10px;background:#faf8f5;border-radius:12px;">${esc(advTurnText(t, roleId, adv.mode))}</div>
            <button class="simcity-pop-close" style="margin-top:10px;width:100%;border:none;background:#f2f0f8;color:#666;border-radius:12px;padding:9px;font-size:13px;cursor:pointer;">关闭</button>
        </div>`;
    container.appendChild(overlay);
    overlay.querySelector('.simcity-pop-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

function advSectionHtml(placeKey, roleId) {
    const ongoing = ongoingAdvFor(placeKey, roleId);
    const justEnded = ongoing ? null : (simCityAdvRegistry?.adventures || []).find(a =>
        a.placeKey === placeKey && a.status === 'ended' && advEndedNotice[a.id] &&
        ((a.participants || []).includes(roleId) || (a.pastParticipants || []).includes(roleId))
    );
    const rec = ongoing || justEnded;
    const adv = rec && simCityAdvCache[rec.id];
    if (!adv) return '';
    let turns = adv.turns || [];
    if (!turns.length && adv.history) {   // 老文游兼容
        turns = [{ actor: null, action: null, scene: adv.history, summary: '' }];
    }
    const oldN = Math.min(adv.sessionRounds || 0, turns.length);

    if (justEnded) {
        // ★ 已结束：之前的轮次灰色概要，最后一轮正文（看结局）
        const cast = [...new Set([...(rec.participants || []), ...(rec.pastParticipants || [])])];
        const lastIdx = turns.length - 1;
        return `
        <div class="sc-adv" id="scAdv" data-adv-id="${esc(rec.id)}" data-ended="1">
            <div style="display:flex;align-items:center;gap:8px;font-size:11px;color:#7c4dff;font-weight:600;margin-bottom:4px;">
                <span>🎬 文游已完结 · 共${rec.rounds || 0}轮</span>
                <span style="flex:1;color:#999;font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">参与：${cast.map(p => p === roleId ? '你' : charName(p)).join('、')}</span>
                <button id="scAdvClose" style="border:none;background:none;color:#999;font-size:12px;cursor:pointer;">✕ 收起</button>
            </div>
            <div class="sc-adv-pages" style="max-height:calc(100vh - 280px);">
                ${turns.map((t, i) => advTurnLine(t, roleId, adv.mode, rec.id, i, i !== lastIdx)).join('')}
            </div>
            <div style="font-size:11px;color:#999;margin-top:4px;">可到下方「🎬 历史剧情」折叠框随时回看</div>
        </div>`;
    }

    const isSecond = adv.mode !== 'third';
    return `
        <div class="sc-adv" id="scAdv" data-adv-id="${esc(rec.id)}">
            <div style="display:flex;align-items:center;gap:8px;font-size:11px;color:#7c4dff;font-weight:600;margin-bottom:4px;">
                <span>🎭 文游 · 第${rec.rounds || 0}轮</span>
                <span style="flex:1;color:#999;font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">参与：${(rec.participants || []).map(p => p === roleId ? '你' : charName(p)).join('、')}</span>
                <button id="scAdvMode" title="切换叙事视角" style="border:none;background:rgba(124,77,255,0.08);color:#7c4dff;font-size:11px;border-radius:10px;padding:2px 8px;cursor:pointer;">${isSecond ? '👤 第二人称' : '📖 第三人称'}⇄</button>
                <button id="scAdvFull" style="border:none;background:none;color:#7c4dff;font-size:12px;cursor:pointer;">⛶ 全屏</button>
            </div>
            <div class="sc-adv-pages" id="scAdvPages">
                ${turns.length ? turns.map((t, i) => advTurnLine(t, roleId, adv.mode, rec.id, i, i < oldN)).join('')
            : `<div class="sc-adv-page" style="color:#999;">（文游即将开始，下方输入行动）</div>`}
            </div>
            <div style="display:flex;gap:6px;margin-top:6px;">
                <input id="scAdvInput" placeholder="输入你想做的事…" style="flex:1;border:none;background:rgba(124,77,255,0.06);border-radius:14px;padding:8px 12px;font-size:12px;outline:none;">
                <button id="scAdvSend" style="border:none;background:#7c4dff;color:#fff;border-radius:14px;padding:8px 14px;font-size:12px;cursor:pointer;">行动</button>
            </div>
        </div>`;
}

// ★ 文游上下文构建：场景环境语 + 参与者详细设定 + 未参与在场者 + 两两关系 + 事件池
async function buildAdvContext(place, hour, participants, roleId, isSecond) {
    const ids = (participants || []).filter(Boolean);
    const present = getPresentAt(placeIndex, place.name, hour) || [];
    const bystanders = present.filter(id => id && !ids.includes(id));
    const allIds = [...ids, ...bystanders];
    const profMap = {};
    await Promise.all(allIds.map(async id => {
        try { profMap[id] = await getProfile(id); } catch { profMap[id] = null; }
    }));
    const detailOf = (id, full) => {
        const pr = profMap[id];
        if (!pr) return charName(id);
        const parts = [charName(id), jobDisplay(pr) || '居民'];
        const traits = (pr.aiProfile?.traits || []).join('、');
        if (traits) parts.push(`性格：${traits}`);
        if (full) {
            const comment = pr.aiProfile?.comment;
            if (comment && comment !== '（评估生成失败）') parts.push(`设定：${comment}`);
            const persona = personaBlockFor(pr);   // ★ 个性登记（世界书+模板）
            if (persona) parts.push(`个性：${persona}`);
            const sch = (pr.schedule || pr.aiProfile?.schedule || []);
            if (sch.length) parts.push(`日程：${sch.map(s => `${s.time} ${s.place}${s.act ? ' ' + s.act : ''}`).join('；')}`);
        }
        if (id === roleId) parts.push(isSecond ? '（你，主视角）' : '（本轮行动者）');
        return parts.join('，');
    };
    const castBlock = ids.map(id => detailOf(id, true)).join('\n');
    const bystanderBlock = bystanders.length ? bystanders.map(id => detailOf(id, false)).join('、') : '（无）';
    const rels = [];
    for (const a of ids) for (const b of ids) {
        if (a === b) continue;
        try { const rel = new CharacterStore(a).getRelationById(b); if (rel?.relation) rels.push(`${charName(a)}→${charName(b)}：${rel.relation}`); } catch { }
    }
    const relationBlock = rels.join('；') || '（暂未记录明确关系）';
    // buildAdvContext 里 sceneBlock 处
    const sceneBlock = `【场景】${place.name}（${hour}点）\n${placeAmbience(place, hour)}`;   // 不再拼地点世界书
    const worldBlock = simCityWorldText();
    return {
        presetBlock: placePresetBlock(place),   // 系统级预设 → systemPrompt
        placeWbBlock: placeWbBlock(place),       // 地区专属 + 父子世界书 → userContent 最前方
        sceneBlock, worldBlock, castBlock, bystanderBlock, relationBlock
    };
}

// ★ 在场同步：不在场的参与者自动退出（主视角/操作者保留），写入系统轮次
function syncAdvPresence(placeName, hour, rec, adv, roleId) {
    const present = new Set(getPresentAt(placeIndex, placeName, hour) || []);
    for (const id of [...(rec.participants || [])]) {
        if (id === roleId) continue;
        if (!present.has(id)) {
            rec.participants = rec.participants.filter(x => x !== id);
            (rec.pastParticipants = rec.pastParticipants || []).push(id);
            (adv.turns = adv.turns || []).push({ actor: null, action: null, scene: `【系统】${charName(id)}离开了，退出了文游`, summary: '', ts: Date.now() });
        }
    }
}

// ★ 推进一轮：AI 生成 → 结构化 turns → 在场同步 → 离场规则 → 保存 → 条件渲染
async function advanceAdventure(container, placeKey, advId, roleId, profile, action, rerender) {
    await ensureAdvLoaded([advId]);   // ★ 兜底：缓存未命中则按需读
    const rec = (simCityAdvRegistry?.adventures || []).find(a => a.id === advId);
    const adv = simCityAdvCache[advId];
    if (!rec || !adv || rec.status !== 'ongoing' || !(rec.participants || []).includes(roleId)) return;
    try {
        const place = findPlace(placeKey);
        if (!adv.turns && adv.history) {   // 老数据兼容迁移
            adv.turns = [{ actor: null, action: null, scene: adv.history, summary: '', ts: Date.now() }];
            adv.sessionRounds = adv.turns.length;
            delete adv.history;
        }
        (adv.turns = adv.turns || []);

        const isSecond = adv.mode !== 'third';
        const p = profile || {};
        const myName = charName(roleId);
        const hour = new Date().getHours();
        const { presetBlock, placeWbBlock, sceneBlock, worldBlock, castBlock, bystanderBlock, relationBlock } = await buildAdvContext(place, hour, rec.participants, roleId, isSecond);
        const envBlock = `${sceneBlock}${worldBlock ? `\n【今日小城】\n${worldBlock}` : ''}`;
        const summaries = adv.turns.map(t => t.summary).filter(Boolean).join('；');
        const lastScene = adv.turns[adv.turns.length - 1]?.scene || '';
        const historyBlock = `【剧情概要】${summaries || '（暂无）'}${lastScene ? `\n最近剧情：${lastScene}` : ''}`;

        let systemPrompt, userContent;
        if (isSecond) {
            systemPrompt = (presetBlock ? `【系统预设】${presetBlock}\n` : '')
                + '你是"模拟小城"的文游叙事引擎（第二人称沉浸模式）。每轮只输出 JSON：'
                + '{"scene":"正文·沉浸式文游体验（用"你"称呼主视角玩家，其他角色一律用名字，1000~2000字，有画面感）",'
                + '"summary":"概要·第三人称剧情总结（所有角色一律用名字，200~300字，客观概括本轮进展，不出现"你"）",'
                + '"ended":false,"ending":"ended时的收尾（2000字内）"}。'
                + '关键：正文 scene 必须用"你"指代主视角玩家、严禁用其名字；概要 summary 必须纯第三人称。'
                + '角色真实度：每个在场角色都有独立性格与相互间的关系，须按各角色自身逻辑行动、保持真实，不得为迎合主视角而扭曲角色；'
                + '语境：主动利用【今日小城】的事件/天气与【角色关系】推动剧情。'
                + '只输出 JSON 本身。';
            userContent = (placeWbBlock ? `【地点专属】${placeWbBlock}\n\n` : '')
                + `${envBlock}\n\n【主视角】你 = ${myName}（正文中所有第二人称"你"均指代此人）\n【在场角色】\n${castBlock}\n【在场未参与】${bystanderBlock}\n【角色关系】${relationBlock}\n\n${historyBlock}\n\n你的行动：${action}\n请推进正文。`;
        } else {
            systemPrompt = (presetBlock ? `【系统预设】${presetBlock}\n` : '')
                + '你是"模拟小城"的文游叙事引擎（第三人称模式）。本模式不存在"你"，所有角色一律用名字描述。每轮只输出 JSON：'
                + '{"scene":"正文·第三人称推进（所有角色用名字，1000~2000字，有画面感）",'
                + '"summary":"概要·第三人称剧情总结（所有角色用名字，200~300字）",'
                + '"ended":false,"ending":"ended时的收尾（2000字内）"}。'
                + '角色真实度：每个在场角色都有独立性格与相互间的关系，须按各角色自身逻辑行动、保持真实，不得为迎合主视角而扭曲角色；'
                + '语境：结合当前地点和在场人物，剧情陷入僵持时，主动利用【今日小城】的事件与【角色关系】制造话题。'
                + '只输出 JSON 本身。';
            userContent = (placeWbBlock ? `【地点专属】${placeWbBlock}\n\n` : '')
                + `${envBlock}\n\n【在场角色】\n${castBlock}\n【在场未参与】${bystanderBlock}\n【角色关系】${relationBlock}\n\n${historyBlock}\n\n行动：${action}\n请推进正文。`;
        }

        const raw = await taskManager.watch('cityadv', `文游 · ${rec.placeName}`, async () => {
            const { callAIWithMessages } = await import('../aiService.js');
            return await callAIWithMessages({ systemPrompt, userContent, maxTokens: 12000, temperature: 0.9 });
        });
        let res = { scene: '……', summary: '', ended: false, ending: '' };
        try { const m = raw.match(/\{[\s\S]*\}/); if (m) res = Object.assign(res, JSON.parse(m[0])); } catch { }

        adv.turns.push({ actor: roleId, action, scene: res.scene || '……', summary: res.summary || '', ts: Date.now() });
        rec.rounds = (rec.rounds || 0) + 1;
        // 离场规则：12% 概率随机一名非主视角参与者退出
        const others = (rec.participants || []).filter(p => p !== roleId);
        if (others.length && Math.random() < 0.12) {
            const leaver = others[Math.floor(Math.random() * others.length)];
            rec.participants = rec.participants.filter(p => p !== leaver);
            (rec.pastParticipants = rec.pastParticipants || []).push(leaver);
            adv.turns.push({ actor: null, action: null, scene: `【系统】${charName(leaver)}退出了文游`, summary: '', ts: Date.now() });
        }
        // ★ 在场同步（动态退出）
        syncAdvPresence(place.name, hour, rec, adv, roleId);
        // 结束：AI 收尾 / 轮数满 200 / 参与者归零
        let justEnded = false;
        if (res.ended || rec.rounds >= 200 || !(rec.participants || []).length) {
            rec.status = 'ended';
            justEnded = true;
            if (res.ending) adv.turns.push({ actor: null, action: null, scene: `—— ${res.ending}`, summary: '', ts: Date.now() });
        }
        rec.updatedAt = Date.now();
        await saveAdventure(adv);
        await saveAdvRegistry();
        if (justEnded) advEndedNotice[rec.id] = true;   // ★ 本会话内展示只读结尾

        // ★ 渲染：仅当当前页面仍展示同一文游时才重渲染（切走不拉回，数据已落库）
        const box = container.querySelector('#scAdv');
        if (box && box.dataset.advId === advId) rerender && rerender();
    } catch (e) { toast('❌ 文游中断：' + (e.message || '未知错误'), '#e53935'); }
}

async function drawerFuncAdventure(ctx) {
    const { container, roleId, place, sub, rerender } = ctx;
    const placeKey = sub ? sub.key : place.key;
    const placeName = sub ? subDisplayName(sub.name) : place.name;
    const rec = ongoingAdvFor(placeKey, roleId);
    if (rec) {
        // ★ 有进行中 → 退出文游
        rec.participants = (rec.participants || []).filter(p => p !== roleId);
        (rec.pastParticipants = rec.pastParticipants || []).push(roleId);
        const adv = simCityAdvCache[rec.id];
        if (adv) {
            if (!adv.turns && adv.history) {   // 老文游兼容迁移
                adv.turns = [{ actor: null, action: null, scene: adv.history, summary: '', ts: Date.now() }];
                adv.sessionRounds = 1;
                delete adv.history;
            }
            (adv.turns = adv.turns || []).push({ actor: null, action: null, scene: `【系统】${charName(roleId)}退出了文游`, summary: '', ts: Date.now() });
            await saveAdventure(adv);
        }
        if (!rec.participants.length) rec.status = 'ended';
        if (rec.status === 'ended') advEndedNotice[rec.id] = true;   // ★ 退出导致完结 → 本会话展示只读结尾
        rec.updatedAt = Date.now();
        await saveAdvRegistry();
        toast('🚪 已退出文游', '#999');
        rerender && rerender();
        return;
    }
    // ★ 无进行中 → 弹模式选择
    const overlay = document.createElement('div');
    overlay.className = 'simcity-pop';
    overlay.innerHTML = `
        <div class="simcity-pop-card">
            <div style="font-weight:700;font-size:15px;margin-bottom:4px;">🎭 开启文游</div>
            <div style="font-size:12px;color:#999;margin-bottom:10px;line-height:1.6;">${esc(placeName)} · 参与者 = 你 + 在场角色<br>选择叙事视角：</div>
            <div class="simcity-pop-list" style="display:flex;flex-direction:column;gap:8px;">
                <button class="simcity-btn primary" data-adv-mode="second">👤 第二人称 · 你是主角</button>
                <button class="simcity-btn" data-adv-mode="third">📖 第三人称 · 旁观叙事</button>
            </div>
            <button class="simcity-pop-close" id="advModeCancel" style="margin-top:10px;">取消</button>
        </div>`;
    container.appendChild(overlay);
    overlay.querySelectorAll('[data-adv-mode]').forEach(btn => {
        btn.addEventListener('click', () => { overlay.remove(); startAdventure(ctx, btn.dataset.advMode); });
    });
    // ★ 修复：误点可返回——取消按钮 + 点击遮罩关闭（与其他弹窗一致）
    overlay.querySelector('#advModeCancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

// ★ 开启新文游：参与者 = 主视角 + 在场角色；mode = second / third
async function startAdventure(ctx, mode) {
    const { roleId, place, sub, hour, rerender } = ctx;
    const placeKey = sub ? sub.key : place.key;
    const placeName = sub ? subDisplayName(sub.name) : place.name;
    const idxName = sub ? sub.name : place.name;   // 查询在场用全名
    const present = getPresentAt(placeIndex, idxName, hour).filter(id => id !== roleId);
    const participants = [roleId, ...present];
    const id = 'adv_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
    const now = Date.now();
    simCityAdvCache[id] = { id, placeKey, placeName, mode, participants, pastParticipants: [], turns: [], rounds: 0, status: 'ongoing', sessionRounds: 0, createdAt: now, updatedAt: now };
    (simCityAdvRegistry?.adventures || []).push({ id, placeKey, placeName, mode, participants, pastParticipants: [], status: 'ongoing', rounds: 0, createdAt: now, updatedAt: now });
    await saveAdventure(simCityAdvCache[id]);
    await saveAdvRegistry();
    toast(`🎭 文游开始（${mode === 'third' ? '第三人称' : '第二人称'}）！参与：${participants.map(charName).join('、') || '只有你'}`);
    drawerOpenAt = null;   // 开启后关抽屉，内容区直接展示
    rerender && rerender();
}

// ★ 文游交互统一绑定（发送行动 / 全屏 / 切换叙事模式）——renderPlace 与 renderSubPlace 共用
function bindAdvBox(container, placeKey, roleId, profile, rerender) {
    const advBox = container.querySelector('#scAdv');
    if (!advBox) return;
    const advId = advBox.dataset.advId;
    const adv = simCityAdvCache[advId];
    // ★ 进行中文游：自动滚动到最新一页
    const pages = advBox.querySelector('#scAdvPages');
    if (pages) pages.scrollLeft = pages.scrollWidth;
    // ★ 历史轮次概要 → 弹窗详情（进行中 / 已结束只读都覆盖）
    advBox.querySelectorAll('.sc-adv-old-line').forEach(el => {
        el.addEventListener('click', () => showAdvDetail(container, el.dataset.advId, parseInt(el.dataset.turnIdx, 10), roleId));
    });
    // ★ 已结束只读：仅绑定收起
    if (advBox.dataset.ended === '1') {
        advBox.querySelector('#scAdvClose').addEventListener('click', () => {
            delete advEndedNotice[advId];
            rerender && rerender();
        });
        return;
    }
    advBox.querySelector('#scAdvFull').addEventListener('click', () => advBox.classList.toggle('sc-adv-full'));
    advBox.querySelector('#scAdvSend').addEventListener('click', async () => {
        const input = advBox.querySelector('#scAdvInput');
        const v = (input.value || '').trim();
        if (!v) return;
        input.value = '';
        await advanceAdventure(container, placeKey, advId, roleId, profile, v, rerender);
    });
    advBox.querySelector('#scAdvInput').addEventListener('keydown', e => { if (e.key === 'Enter') advBox.querySelector('#scAdvSend').click(); });
    const modeBtn = advBox.querySelector('#scAdvMode');
    if (modeBtn && adv) modeBtn.addEventListener('click', async () => {
        adv.mode = adv.mode === 'third' ? 'second' : 'third';
        const rec = (simCityAdvRegistry?.adventures || []).find(a => a.id === advId);
        if (rec) rec.mode = adv.mode;
        await saveAdventure(adv);
        await saveAdvRegistry();
        toast(`🎭 已切换为${adv.mode === 'third' ? '第三人称' : '第二人称'}叙事`, '#7c4dff');
        rerender && rerender();
    });
}

// ★ 历史剧情折叠框（该角色参与过的已结束文游；放在职位折叠框之下）
function advHistoryCollapseHtml(placeKey, roleId) {
    const ended = endedAdvsFor(placeKey, roleId);
    if (!ended.length) return '';
    const day = ts => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`; };
    return `
        <div style="margin-top:12px;">
            <div id="advHistToggle" style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:rgba(255,255,255,0.9);border-radius:14px;cursor:pointer;box-shadow:0 1px 6px rgba(0,0,0,0.06);">
                <span style="font-size:13px;font-weight:600;color:#8d6e63;">🎬 历史剧情</span>
                <span class="adv-hist-arrow" style="font-size:12px;color:#bcaaa4;">▾</span>
            </div>
            <div class="adv-hist-list" style="display:none;margin-top:8px;">
                ${ended.map(rec => {
        const adv = simCityAdvCache[rec.id];
        const turns = adv?.turns || [];
        return `
                <details class="adv-hist-item" style="margin-bottom:8px;background:rgba(255,255,255,0.92);border-radius:12px;padding:10px 12px;">
                    <summary style="cursor:pointer;user-select:none;font-size:12px;color:#4a3f6b;display:flex;justify-content:space-between;align-items:center;">
                        <span>🎬 ${day(rec.createdAt)} ${esc(rec.placeName)} · ${rec.rounds || 0}轮</span>
                        <span style="color:#999;">▾</span>
                    </summary>
                    <div style="margin-top:6px;">
                        ${turns.map((t, i) => advTurnLine(t, roleId, adv?.mode, rec.id, i, true)).join('') || '<div style="color:#999;font-size:12px;">（暂无内容）</div>'}
                    </div>
                </details>`;
    }).join('')}
            </div>
        </div>`;
}

function bindAdvHistToggle(container, roleId) {
    const toggle = container.querySelector('#advHistToggle');
    if (!toggle) return;
    toggle.addEventListener('click', () => {
        const list = toggle.nextElementSibling;
        const arrow = toggle.querySelector('.adv-hist-arrow');
        const open = list.style.display !== 'none';
        list.style.display = open ? 'none' : 'block';
        arrow.textContent = open ? '▾' : '▴';
    });
    // ★ 历史剧情里的概要条目 → 弹窗详情
    container.querySelectorAll('.adv-hist-list .sc-adv-old-line').forEach(el => {
        el.addEventListener('click', () => showAdvDetail(container, el.dataset.advId, parseInt(el.dataset.turnIdx, 10), roleId));
    });
}

// 地点内部视图分发
async function renderPlace(container, globalState, onBack, roleId, profile, placeKey) {
    const mySeq = ++renderSeq;   // ★ 本次渲染取号    
    const place = findPlace(placeKey);
    // ★ 动态地点（建成地产）可见性拦截：非全公开
    // ③ renderPlace 拦截（L1063-1070）对动态子地点放行：
    if (!PLACES.some(p => p.key === placeKey)) {
        const est = (simCityEstates.estates || []).find(e => e.id === placeKey);
        const subOf = (simCityEstates.estates || []).find(e => e.status === 'built' && (e.subs || []).some(s => s.key === placeKey));
        const allow = (est && canSeeEstate(roleId, profile, est)) || (subOf && canSeeEstate(roleId, profile, subOf));
        if (!allow) {
            toast('🚫 你没有进入这里的资格', '#e53935');
            renderMain(container, globalState, onBack, roleId, profile);
            return;
        }
    }

    if (placeKey === 'home') { renderHome(container, globalState, onBack, roleId, profile); return; }
    if (placeKey === 'park') { renderPark(container, globalState, onBack, roleId, profile); return; }
    if (placeKey === 'hall') { renderHall(container, globalState, onBack, roleId, profile); return; }

    const keepDrawer = drawerOpenAt && drawerOpenAt.key === place.key;   // ★ 渲染前记住抽屉状态
    const hour = new Date().getHours();
    // ★ 按需加载本地点文游全文 + 防竞态（已被更新的渲染取代则放弃）
    await ensureAdvLoaded(
        (simCityAdvRegistry?.adventures || [])
            .filter(a => a.placeKey === place.key && (
                a.status === 'ongoing'
                || (a.status === 'ended' && ((a.participants || []).includes(roleId) || (a.pastParticipants || []).includes(roleId)))
            ))
            .map(r => r.id)
    );
    if (mySeq !== renderSeq) return;

    const open = venueOpen(place.key, hour);
    const children = childrenOf(place.key);
    const jobsHere = jobsAt(place.key);
    const careerJob = careerWorkHere(profile, place.key, '');   // ★ 当前地点是否是主视角职业的工作地点 + 此刻按行程在岗

    container.innerHTML = `
        <div class="simcity-root">
            <div class="simcity-header">
                <button class="back-btn" id="placeBack">←</button>
                <span class="title">${place.icon} ${esc(place.name)}</span>
                <span class="level" id="sceneSetting" style="cursor:pointer;">⚙️ 场景设定</span>

            </div>
            <div class="simcity-body">
                <div class="simcity-room${SIMCITY_OUTDOOR.includes(place.key) ? ' sc-outdoor' : ''}">
                    <div class="simcity-env" id="scEnvCard" style="cursor:pointer;position:relative;">
                        ${(pendingEvents[place.key] || hasOngoingEventAdv(roleId, place.key)) ? `<div id="scEventBell" style="position:absolute;top:8px;right:10px;font-size:18px;cursor:pointer;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.25));">${hasOngoingEventAdv(roleId, place.key) ? '🎭' : '🔔'}</div>` : ''}                    
                        <div class="env-icon">${place.icon}</div>
                        <div class="env-name">${esc(place.name)}</div>
                        <div class="env-desc">${esc(place.desc || placeAmbience(place, hour))}</div>
                        ${!PLACES.some(p => p.key === placeKey) && place.desc ? (() => { const t = placeAmbience(place, hour); return t ? `<div class="env-now" style="font-size:11px;color:#8a7fa8;margin-top:4px;">${esc(t)}</div>` : ''; })() : ''}
                    </div>
                ${place.key === 'square' ? (() => {
            const evs = (simCityWorld?.events || []).slice().sort((a, b) => (b.heat || 1) - (a.heat || 1) || b.ts - a.ts);
            const tname = { rumor: '流言', gossip: '传闻', news: '新闻' };
            return `<div style="background:var(--sc-card);border:1px solid rgba(255,255,255,0.7);border-radius:18px;padding:14px;margin-bottom:12px;box-shadow:var(--sc-shadow);">
                        <div style="font-weight:700;font-size:14px;margin-bottom:6px;">📢 广场传言</div>
                        ${evs.length ? evs.map(e => `
                            <div style="display:flex;gap:8px;padding:7px 0;border-bottom:1px solid #f5f5f5;font-size:12px;line-height:1.6;align-items:flex-start;">
                                <span style="font-size:16px;flex-shrink:0;">${EVENT_ICON[e.type] || '💬'}</span>
                                <div style="flex:1;min-width:0;">
                                    <div style="color:#5a5470;">${esc(e.text)}</div>
                                    <div style="font-size:11px;color:#bbb;margin-top:2px;">${tname[e.type] || ''}${e.place ? ' · ' + esc(e.place) : ''} · ${new Date(e.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>
                                </div>
                            </div>`).join('') : '<div style="text-align:center;color:#999;padding:10px 0;font-size:12px;">广场上还没有传言流传</div>'}
                    </div>`;
        })() : ''}
                ${advSectionHtml(place.key, roleId)}
                ${children.map(c => {
            const cOpen = venueOpen(c.key, hour);
            return `
                        <div class="simcity-item sub-place" data-sub="${esc(c.key)}" style="${cOpen ? '' : 'opacity:0.5;'}">
                            <div class="item-icon">${c.icon}</div>
                            <div class="item-name">${esc(subDisplayName(c.name))}</div>
                            <div class="item-desc">${cOpen ? '进入' : '🌙 已打烊'}</div>
                        </div>`;
        }).join('')}
                    ${place.key === 'fun' ? FUN_RIDES.map(r => `
                    <div class="simcity-item fun-ride" data-ride="${r.key}" style="${open ? '' : 'opacity:0.5;'}">
                        <div class="item-icon">${r.icon}</div>
                        <div class="item-name">${esc(r.name)}</div>
                        <div class="item-desc">💰${r.price} · ${esc(r.desc)}</div>
                    </div>`).join('') : ''}

                </div>
                ${careerJob ? `
                <div class="simcity-item" id="scCareerBtn" style="${open ? '' : 'opacity:0.5;'}">
                    <div class="item-icon">${jobIcon(careerJob.key)}</div>
                    <div class="item-name">${esc(careerJob.name)} · 上班</div>
                    <div class="item-desc">${open ? '点击开始今天的工作' : '🌙 已打烊'}</div>
                </div>` : ''}
                ${jobsCollapseHtml(jobsHere, profile)}
                ${residentialCollapseHtml(place, profile)}
                ${advHistoryCollapseHtml(place.key, roleId)}
                ${open
            ? presentSectionHtml(place.name, roleId)
            : `<div style="font-size:12px;color:#999;text-align:center;padding:10px;">🌙 已打烊，${esc(place.name)}要等${OPEN_HOURS[place.key][0]}:00 开门</div>`}
                <div style="font-size:12px;color:#999;text-align:center;margin-top:10px;">更多互动布置中…</div>
            </div>
            <div class="simcity-actions">
                <button class="simcity-btn primary" id="scDrawerToggle">${place.icon} ${esc(PLACES.some(p => p.key === placeKey) ? place.desc : (place.btn || '开始互动'))}${open ? '' : '（已打烊）'} <span style="font-size:11px;opacity:0.7;">▴</span></button>
            </div>
            ${drawerHtml({
                title: place.name,
                icon: place.icon,
                text: open ? placeAmbience(place, hour) : `🌙 ${place.name}已打烊，${OPEN_HOURS[place.key][0]}:00 开门`,
                open: keepDrawer,
                buttons: [
                    { id: 'act', label: `${place.icon} ${esc(PLACES.some(p => p.key === placeKey) ? place.desc : (place.btn || '开始互动'))}`, primary: true },
                    ...((['mall', 'entertain'].includes(place.key) && (hour >= 19 || hour < 5)) ? [{ id: 'night', label: DRAWER_FUNCS.night.label }] : []),
                    { id: 'adventure', label: ongoingAdvFor(place.key, roleId) ? '🚪 退出文游' : DRAWER_FUNCS.adventure.label },
                    ...((() => { const sc = place.shop ? { estate: place.estate, shop: place.shop } : null; return sc ? [{ id: 'shop', label: `${sc.shop.icon} 逛逛${sc.shop.name}` }] : []; })()),
                ]
            })}
        </div>`;

    // ★ 抽屉：通用模板 + 状态保持 + 按钮点击不自动关闭
    const drawer = container.querySelector('#scDrawer');
    const mask = container.querySelector('#scDrawerMask');
    const openDrawer = () => { drawer.classList.add('show'); mask.classList.add('show'); drawerOpenAt = { key: place.key }; };
    const closeDrawer = () => { drawer.classList.remove('show'); mask.classList.remove('show'); drawerOpenAt = null; };
    container.querySelector('#scDrawerToggle').addEventListener('click', openDrawer);
    mask.addEventListener('click', closeDrawer);
    container.querySelector('#scDrawerClose').addEventListener('click', closeDrawer);
    container.querySelectorAll('[data-drawer-action]').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.drawerAction === 'shop') {
                const sc = place.shop ? { estate: place.estate, shop: place.shop } : null;
                if (sc) showShop(container, globalState, onBack, roleId, profile, sc.estate, sc.shop);
                return;
            }

            const fn = DRAWER_FUNCS[btn.dataset.drawerAction];
            if (fn && fn.handle) fn.handle({ container, globalState, onBack, roleId, profile, place, sub: undefined, hour, open, careerJob, rerender: () => renderPlace(container, globalState, onBack, roleId, profile, place.key) });
        });
    });

    bindAdvBox(container, place.key, roleId, profile, () => renderPlace(container, globalState, onBack, roleId, profile, place.key));
    container.querySelector('#sceneSetting')?.addEventListener('click', () => openSceneSetting(container, place, () => renderPlace(container, globalState, onBack, roleId, profile, place.key)));

    // ★ 环境卡翻转：点击 ↔ 公告牌（临时状态，不保存；闭包捕获，随渲染重建无泄漏）
    const envCard = container.querySelector('#scEnvCard');
    if (envCard) {
        const envOriginal = envCard.innerHTML;
        let flipped = false;
        envCard.addEventListener('click', () => {
            flipped = !flipped;
            if (flipped) {
                envCard.dataset.flipped = '1';
                const list = (simCityBulletins || {})[place.key] || [];
                envCard.innerHTML = `
                    <div class="env-icon" style="font-size:18px;">📌</div>
                    <div class="env-name">公告牌 · ${esc(place.name)}</div>
                    <div class="env-desc" style="text-align:left;max-height:140px;overflow-y:auto;font-size:12px;line-height:1.8;color:#5a5470;">
                        ${list.length ? list.slice().reverse().slice(0, 8).map(b => `<div style="margin-bottom:6px;">${esc(new Date(b.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))} ${esc(b.text)}</div>`).join('') : '<div style="text-align:center;color:#999;">这里还没有发生值得记录的事</div>'}
                    </div>`;
            } else {
                delete envCard.dataset.flipped;
                envCard.innerHTML = envOriginal;
            }
        });
    }

    const eventBell = container.querySelector('#scEventBell');
    if (eventBell) eventBell.addEventListener('click', (e) => {
        e.stopPropagation();   // ★ 不触发环境卡翻转
        const pk = place.key;   // ★ renderSubPlace 处用 sub.key
        const rk = advStateKeyOf(roleId, pk);
        if (hasOngoingEventAdv(roleId, pk)) {
            // ★ 找回进行中的事件文游
            runTextAdventure(container, { title: '事件', icon: '🎭', placeName: place.name, roleId, profile, toast }, rk);
        } else {
            const ev = pendingEvents[pk];
            if (ev) showPendingEvent(container, globalState, onBack, roleId, profile, place, ev, () => renderPlace(container, globalState, onBack, roleId, profile, place.key));
        }
    });

    const careerBtn = container.querySelector('#scCareerBtn');
    if (careerBtn) careerBtn.addEventListener('click', () => {
        if (!open) { toast(`🌙 ${place.name}还没开门`, '#ff9800'); return; }
        doCareerWork(container, globalState, onBack, roleId, profile, careerJob, () => renderPlace(container, globalState, onBack, roleId, profile, place.key));
    });

    // ★ 游乐场项目：扣钱 → AI 游玩体验；鬼屋（multi）→ 邀请好友文游
    container.querySelectorAll('.fun-ride').forEach(card => {
        card.addEventListener('click', () => {
            if (!open) { toast('🌙 游乐场还没开门', '#ff9800'); return; }
            const ride = FUN_RIDES.find(r => r.key === card.dataset.ride);
            if (!ride) return;
            if (ride.multi) { showHauntedInvite(container, roleId, profile, ride, place.name); return; }
            if (profile.money < ride.price) { toast('💰 金币不足', '#e53935'); return; }
            profile.money -= ride.price;
            profile.mood = Math.min(100, profile.mood + ride.mood);
            profile.energy = Math.max(0, profile.energy + ride.energy);
            saveProfile(profile, roleId).then(() => showFunRide(container, roleId, profile, ride, place.name));
        });
    });

    // ★ 返回：普通地点回地图；若本身是子地点则回上级（兼容深层嵌套）
    container.querySelector('#placeBack').addEventListener('click', () => place.parent
        ? renderPlace(container, globalState, onBack, roleId, profile, place.parent)
        : renderMain(container, globalState, onBack, roleId, profile));

    container.querySelectorAll('.apply-job').forEach(card => {
        card.addEventListener('click', async () => {
            const k = card.dataset.job;
            const j = getJob(k);
            if (!j) { toast('❌ 职位不存在或已失效，请刷新页面', '#e53935'); return; }   // ★ 防御：不崩
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
    bindResidentialToggle(container);
    container.querySelectorAll('.res-house').forEach(card => {
        card.addEventListener('click', () => {
            if (!open) { toast(`🌙 ${place.name}还没开门`, '#ff9800'); return; }
            buyHouse(profile, roleId, place, card.dataset.house);
        });
    });
    container.querySelectorAll('.res-home').forEach(card => {
        card.addEventListener('click', async () => {
            const entry = (simCityResidentials[place.key]?.residents || []).find(r => r.propId === card.dataset.prop);   // ★ renderSubPlace 处用 sub.key
            if (!entry) return;
            const backTo = () => renderPlace(container, globalState, onBack, roleId, profile, place.key);   // ★ renderSubPlace：() => renderSubPlace(container, globalState, onBack, roleId, profile, sub)
            if (entry.roleId === profile.id) {
                // ★ 自己的房子：主视角档案引用 → 装修/休息保存直接生效
                const myProp = (profile.properties || []).find(p => p.id === entry.propId);
                if (myProp) renderPropertyPage(container, globalState, onBack, roleId, profile, myProp, backTo);
            } else {
                // ★ 别人的房子：只读参观
                const ownerPf = await getProfile(entry.roleId).catch(() => null);
                const prop = (ownerPf?.properties || []).find(p => p.id === entry.propId);
                if (prop) renderPropertyPage(container, globalState, onBack, roleId, profile, prop, backTo, true);
            }
        });
    });

    bindAdvHistToggle(container, roleId);

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
        btn.addEventListener('click', async () => {
            const gcId = await findOrRecoverGroupChat(roleId, profile, btn.dataset.friend, btn.dataset.place);
            showCityChat(container, roleId, profile, btn.dataset.friend, btn.dataset.place, false, null, gcId);
        });
    });
    startDayNightCycle(container);   // ★ 室外地点随日夜变化（室内自动自清理）

}

// 子地点页面：独立地点（有自己在场），返回按钮回上级地点
async function renderSubPlace(container, globalState, onBack, roleId, profile, sub) {
    const mySeq = ++renderSeq;   // ★ 本次渲染取号
    const parentPlace = findPlace(sub.parent);

    const jobsHere = jobsAt(parentPlace.key, sub.key);
    const careerJob = careerWorkHere(profile, parentPlace.key, sub.key);
    const keepDrawer = drawerOpenAt && drawerOpenAt.key === sub.key;   // ★ 渲染前记住抽屉状态
    const hour = new Date().getHours();
    // ★ 按需加载本地点文游全文（进行中 / 我已参与过的已结束）
    await ensureAdvLoaded(
        (simCityAdvRegistry?.adventures || [])
            .filter(a => a.placeKey === sub.key && (
                a.status === 'ongoing'
                || (a.status === 'ended' && ((a.participants || []).includes(roleId) || (a.pastParticipants || []).includes(roleId)))
            ))
            .map(r => r.id)
    );
    if (mySeq !== renderSeq) return;   // ★ 已被更新的渲染取代 → 放弃本次
    const open = venueOpen(sub.key, hour);
    container.innerHTML = `
        <div class="simcity-root">
            <div class="simcity-header">
                <button class="back-btn" id="subBack">←</button>
                <span class="title">${sub.icon} ${esc(subDisplayName(sub.name))}</span>
                <span class="level" id="sceneSetting" style="cursor:pointer;">⚙️ 场景设定</span>

            </div>
            <div class="simcity-body">
                <div class="simcity-room${SIMCITY_OUTDOOR.includes(sub.key) ? ' sc-outdoor' : ''}">
                    <div class="simcity-env" id="scEnvCard" style="cursor:pointer;position:relative;">
                        <div class="env-icon">${sub.icon}</div>
                        <div class="env-name">${esc(subDisplayName(sub.name))}</div>
                        <div class="env-desc">${esc(sub.desc || placeAmbience(sub, hour))}</div>
                        ${sub.desc ? (() => { const t = placeAmbience(sub, hour); return t ? `<div class="env-now" style="font-size:11px;color:#8a7fa8;margin-top:4px;">${esc(t)}</div>` : ''; })() : ''}
                        ${(pendingEvents[sub.key] || hasOngoingEventAdv(roleId, sub.key)) ? `<div id="scEventBell" style="position:absolute;top:8px;right:10px;font-size:18px;cursor:pointer;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.25));">${hasOngoingEventAdv(roleId, sub.key) ? '🎭' : '🔔'}</div>` : ''}
                    </div>
                    ${advSectionHtml(sub.key, roleId)}
                </div>
                ${careerJob ? `
                <div class="simcity-item" id="scCareerBtn" style="${open ? '' : 'opacity:0.5;'}">
                    <div class="item-icon">${jobIcon(careerJob.key)}</div>
                    <div class="item-name">${esc(careerJob.name)} · 上班</div>
                    <div class="item-desc">${open ? '点击开始今天的工作' : '🌙 已打烊'}</div>
                </div>` : ''}
                ${jobsCollapseHtml(jobsHere, profile)}
                ${residentialCollapseHtml(sub, profile)}
                ${advHistoryCollapseHtml(sub.key, roleId)}
                ${open
            ? presentSectionHtml(sub.name, roleId)
            : `<div style="font-size:12px;color:#999;text-align:center;padding:10px;">🌙 已打烊，${esc(sub.name)}要等${OPEN_HOURS[sub.key][0]}:00 开门</div>`}
                <div style="font-size:12px;color:#999;text-align:center;margin-top:10px;">更多互动布置中…</div>
            </div>
            <div class="simcity-actions">
                <button class="simcity-btn primary" id="scDrawerToggle">${sub.icon} ${esc(sub.btn || sub.act || '进入')}${open ? '' : '（已打烊）'} <span style="font-size:11px;opacity:0.7;">▴</span></button>
            </div>
            ${drawerHtml({
                title: subDisplayName(sub.name),
                icon: sub.icon,
                text: open ? esc(sub.desc) : `🌙 ${subDisplayName(sub.name)}已打烊，${OPEN_HOURS[sub.key][0]}:00 开门`,
                open: keepDrawer,
                buttons: [
                    { id: 'act', label: `${sub.icon} ${esc(sub.desc)}`, primary: true },
                    ...((NIGHT_SPOTS.includes(sub.key) && (hour >= 19 || hour < 5)) ? [{ id: 'night', label: DRAWER_FUNCS.night.label }] : []),
                    { id: 'adventure', label: ongoingAdvFor(sub.key, roleId) ? '🚪 退出文游' : DRAWER_FUNCS.adventure.label },
                    ...((() => { const sc = sub.shop ? { estate: sub.estate, shop: sub.shop } : null; return sc ? [{ id: 'shop', label: `${sc.shop.icon} 逛逛${sc.shop.name}` }] : []; })()),

                ]
            })}
        </div>`;

    // ★ 抽屉：通用模板 + 状态保持 + 按钮点击不自动关闭
    const drawer = container.querySelector('#scDrawer');
    const mask = container.querySelector('#scDrawerMask');
    const openDrawer = () => { drawer.classList.add('show'); mask.classList.add('show'); drawerOpenAt = { key: sub.key }; };
    const closeDrawer = () => { drawer.classList.remove('show'); mask.classList.remove('show'); drawerOpenAt = null; };
    container.querySelector('#scDrawerToggle').addEventListener('click', openDrawer);
    mask.addEventListener('click', closeDrawer);
    container.querySelector('#scDrawerClose').addEventListener('click', closeDrawer);
    container.querySelectorAll('[data-drawer-action]').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.drawerAction === 'shop') {
                const sc = sub.shop ? { estate: sub.estate, shop: sub.shop } : null;
                if (sc) showShop(container, globalState, onBack, roleId, profile, sc.estate, sc.shop);
                return;
            }

            const fn = DRAWER_FUNCS[btn.dataset.drawerAction];
            if (fn && fn.handle) fn.handle({ container, globalState, onBack, roleId, profile, place: parentPlace, sub, hour, open, careerJob, rerender: () => renderSubPlace(container, globalState, onBack, roleId, profile, sub) });
        });
    });

    bindAdvBox(container, sub.key, roleId, profile, () => renderSubPlace(container, globalState, onBack, roleId, profile, sub));
    container.querySelector('#sceneSetting')?.addEventListener('click', () => openSceneSetting(container, sub, () => renderSubPlace(container, globalState, onBack, roleId, profile, sub)));

    // ★ 环境卡翻转：点击 ↔ 公告牌（临时状态，不保存；闭包捕获，随渲染重建无泄漏）
    const envCard = container.querySelector('#scEnvCard');
    if (envCard) {
        const envOriginal = envCard.innerHTML;
        let flipped = false;
        envCard.addEventListener('click', () => {
            flipped = !flipped;
            if (flipped) {
                envCard.dataset.flipped = '1';
                const list = (simCityBulletins || {})[sub.key] || [];
                envCard.innerHTML = `
                    <div class="env-icon" style="font-size:18px;">📌</div>
                    <div class="env-name">公告牌 · ${esc(subDisplayName(sub.name))}</div>
                    <div class="env-desc" style="text-align:left;max-height:140px;overflow-y:auto;font-size:12px;line-height:1.8;color:#5a5470;">
                        ${list.length ? list.slice().reverse().slice(0, 8).map(b => `<div style="margin-bottom:6px;">${esc(new Date(b.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))} ${esc(b.text)}</div>`).join('') : '<div style="text-align:center;color:#999;">这里还没有发生值得记录的事</div>'}
                    </div>`;
            } else {
                delete envCard.dataset.flipped;
                envCard.innerHTML = envOriginal;
            }
        });
    }
    const eventBell = container.querySelector('#scEventBell');
    if (eventBell) eventBell.addEventListener('click', (e) => {
        e.stopPropagation();   // ★ 不触发环境卡翻转
        const pk = sub.key;
        const rk = advStateKeyOf(roleId, pk);
        if (hasOngoingEventAdv(roleId, pk)) {
            runTextAdventure(container, { title: '事件', icon: '🎭', placeName: sub.name, roleId, profile, toast }, rk);
        } else {
            const ev = pendingEvents[pk];
            if (ev) showPendingEvent(container, globalState, onBack, roleId, profile, sub, ev, () => renderSubPlace(container, globalState, onBack, roleId, profile, sub));
        }
    });

    const careerBtn = container.querySelector('#scCareerBtn');
    if (careerBtn) careerBtn.addEventListener('click', () => {
        if (!open) { toast(`🌙 ${subDisplayName(sub.name)}还没开门`, '#ff9800'); return; }
        doCareerWork(container, globalState, onBack, roleId, profile, careerJob, () => renderSubPlace(container, globalState, onBack, roleId, profile, sub));
    });

    container.querySelector('#subBack').addEventListener('click', () => renderPlace(container, globalState, onBack, roleId, profile, sub.parent));

    container.querySelectorAll('.apply-job').forEach(card => {
        card.addEventListener('click', async () => {
            const k = card.dataset.job;
            const j = getJob(k);
            if (!j) { toast('❌ 职位不存在或已失效，请刷新页面', '#e53935'); return; }   // ★ 防御：不崩
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
    bindResidentialToggle(container);
    container.querySelectorAll('.res-house').forEach(card => {
        card.addEventListener('click', () => {
            if (!open) { toast(`🌙 ${subDisplayName(sub.name)}还没开门`, '#ff9800'); return; }
            buyHouse(profile, roleId, sub, card.dataset.house);
        });
    });
    container.querySelectorAll('.res-home').forEach(card => {
        card.addEventListener('click', async () => {
            const entry = (simCityResidentials[sub.key]?.residents || []).find(r => r.propId === card.dataset.prop);   // ★ renderSubPlace 处用 sub.key
            if (!entry) return;
            const backTo = () => renderSubPlace(container, globalState, onBack, roleId, profile, sub);   // ★ renderSubPlace：() => renderSubPlace(container, globalState, onBack, roleId, profile, sub)
            if (entry.roleId === profile.id) {
                // ★ 自己的房子：主视角档案引用 → 装修/休息保存直接生效
                const myProp = (profile.properties || []).find(p => p.id === entry.propId);
                if (myProp) renderPropertyPage(container, globalState, onBack, roleId, profile, myProp, backTo);
            } else {
                // ★ 别人的房子：只读参观
                const ownerPf = await getProfile(entry.roleId).catch(() => null);
                const prop = (ownerPf?.properties || []).find(p => p.id === entry.propId);
                if (prop) renderPropertyPage(container, globalState, onBack, roleId, profile, prop, backTo, true);
            }
        });
    });

    bindAdvHistToggle(container, roleId);

    container.querySelectorAll('.sc-encounter').forEach(btn => {
        btn.addEventListener('click', () => showEncounter(container, roleId, profile, btn.dataset.friend, btn.dataset.place));
    });
    container.querySelectorAll('.sc-chat').forEach(btn => {
        btn.addEventListener('click', async () => {
            const gcId = await findOrRecoverGroupChat(roleId, profile, btn.dataset.friend, btn.dataset.place);
            showCityChat(container, roleId, profile, btn.dataset.friend, btn.dataset.place, false, null, gcId);
        });
    });
    startDayNightCycle(container);

}

// ★ 游乐项目体验：AI 生成第一人称游玩过程
async function showFunRide(container, roleId, profile, ride, placeName) {
    const hour = new Date().getHours();
    const overlay = document.createElement('div');
    overlay.className = 'simcity-pop';
    overlay.innerHTML = `<div class="simcity-pop-card">
        <div style="font-weight:700;font-size:15px;margin-bottom:4px;">${ride.icon} ${esc(ride.name)}</div>
        <div style="font-size:12px;color:#999;margin-bottom:10px;">${esc(placeName)} · ${hour}:00</div>
        <div class="sc-pop-body" style="font-size:13px;line-height:1.8;color:#333;white-space:pre-wrap;min-height:80px;">⏳ 排队体验中…</div>
        <button class="simcity-pop-close" id="rideClose">关闭</button>
    </div>`;
    container.appendChild(overlay);
    overlay.querySelector('#rideClose').addEventListener('click', () => overlay.remove());
    try {
        const envUi = uiEnvText(container, placeName);
        const raw = await taskManager.watch('citystory', `游乐场 · ${ride.name}`, async () => {
            const { callAIWithMessages } = await import('../aiService.js');
            return await callAIWithMessages({
                systemPrompt: '你是"模拟小城"的游乐场体验生成器。生成第一人称游玩体验：' +
                    '1.像日记/小说片段，有画面感，避免AI套话 2.围绕排队、乘坐/参与、身体感受、心情变化展开，300字内',
                userContent: `【我（${esc(profile.name)}）】\n职业：${profile.job}\n\n此刻我在游乐场体验「${ride.name}」（${hour}点）。\n当前环境：${envUi || '（一切照常）'}\n请生成这段游玩体验。`,
                maxTokens: 900, temperature: 0.9
            });
        });
        if (!overlay.isConnected) return;
        overlay.querySelector('.sc-pop-body').textContent = raw || '（项目检修中）';
    } catch (e) {
        overlay.querySelector('.sc-pop-body').textContent = '❌ ' + (e.message || '体验生成失败');
    }
}
// ★ 鬼屋：邀请好友一起（最多3人；在场好友优先标注）
function showHauntedInvite(container, roleId, profile, ride, placeName) {
    const hour = new Date().getHours();
    const present = getPresentAt(placeIndex, placeName, hour);   // 在场 id 集合
    let friends = [];
    try { friends = new CharacterStore(roleId).getFriendIds().filter(id => !isArchived(id)); } catch { }
    if (!friends.length) { toast('👻 没有好友可邀请', '#ff9800'); return; }
    // ★ 在场好友排前面
    friends.sort((a, b) => (present.includes(b) ? 1 : 0) - (present.includes(a) ? 1 : 0));

    const overlay = document.createElement('div');
    overlay.className = 'simcity-pop';
    overlay.innerHTML = `
        <div class="simcity-pop-card">
            <div style="font-weight:700;font-size:15px;margin-bottom:10px;">👻 鬼屋 · 邀请好友</div>
            <div style="font-size:12px;color:#999;margin-bottom:10px;">选最多 3 人一起进鬼屋：</div>
            <div class="simcity-pop-list">
                ${friends.map(fid => {
        const nm = (charDisplayMap[fid] && charDisplayMap[fid].name) || getCharacterNameById(fid) || fid;
        const here = present.includes(fid);
        return `<label style="display:flex;align-items:center;gap:8px;padding:8px 2px;font-size:14px;">
                        <input type="checkbox" class="hv-friend" value="${esc(fid)}"> <span>${esc(nm)}</span>
                        ${here ? '<small style="color:#0b93f6;">📍在场</small>' : '<small style="color:#bbb;">（约好一起）</small>'}</label>`;
    }).join('')}
            </div>
            <button class="simcity-btn primary" id="hvGo" style="margin-top:10px;">一起进鬼屋（${ride.price} 金币）</button>
            <button class="simcity-pop-close" id="hvCancel">取消</button>
        </div>`;
    container.appendChild(overlay);
    overlay.querySelector('#hvCancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#hvGo').addEventListener('click', () => {
        const picks = [...overlay.querySelectorAll('.hv-friend:checked')].map(c => c.value).slice(0, 3);
        if (profile.money < ride.price) { toast('💰 金币不足', '#e53935'); return; }
        profile.money -= ride.price;
        profile.mood = Math.min(100, profile.mood + ride.mood);
        profile.energy = Math.max(0, profile.energy + ride.energy);
        overlay.remove();
        saveProfile(profile, roleId).then(() => showHauntedRide(container, roleId, profile, ride, placeName, picks));
    });
}

// ★ 鬼屋文游：玩家 + 好友一起进鬼屋（文游引擎）
function showHauntedRide(container, roleId, profile, ride, placeName, friendIds) {
    const friendCtx = (friendIds || []).map(fid => {
        const nm = (charDisplayMap[fid] && charDisplayMap[fid].name) || getCharacterNameById(fid) || fid;
        let rel = '';
        try { const r = new CharacterStore(fid).getRelations().find(x => x.id === roleId); if (r && r.relation) rel = r.relation; } catch { }
        return `${nm}${rel ? '（' + rel + '）' : ''}`;
    }).join('、');
    runTextAdventure(container, {
        title: '鬼屋惊魂', icon: '👻', placeName: placeName + '·鬼屋', roleId,
        prompt: `游乐场的鬼屋前，你和${friendCtx || '独自一人'}走了进去。阴森的走廊、忽明忽暗的灯、远处若有若无的哭声…\n当前环境：${uiEnvText(container, placeName) || '夜色下的游乐场'}\n和好友们一起：谁被吓到、谁嘴硬、谁拽着谁？`,
        maxRounds: 4, saveStoryType: 'haunted'
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
                    <div class="simcity-item" id="hallPersona">
                        <div class="item-icon">📝</div>
                        <div class="item-name">个性登记</div>
                        <div class="item-desc">写下专属「世界书」· 绑定角色</div>
                    </div>
                    <div class="simcity-item" id="hallEval">
                        <div class="item-icon">🧑‍💼</div>
                        <div class="item-name">AI 评估服务</div>
                        <div class="item-desc">花费 100 金币，与评估官对话</div>
                    </div>
                    <div class="simcity-item" id="hallBag">
                        <div class="item-icon">🎒</div>
                        <div class="item-name">背包</div>
                        <div class="item-desc">查看物品 · 赠送礼物</div>
                    </div>
                    <button class="simcity-btn" id="hallJobList" style="flex:1;">📋 职业登记表</button>
                    <button class="simcity-btn" id="hallRank" style="flex:1;">🏆 现金排行榜</button>
                    <button class="simcity-btn" id="hallEstateList" style="flex:1;">🏘️ 地产登记表</button>
                </div>
                ${presentSectionHtml('市政厅', roleId)}

                <div style="font-size:12px;color:#999;text-align:center;margin-top:10px;">💰 金币：${profile.money}</div>
            </div>
        </div>`;

    container.querySelector('#hallBack').addEventListener('click', () => renderMain(container, globalState, onBack, roleId, profile));
    container.querySelector('#hallBag').addEventListener('click', () => showBag(container, roleId, profile));
    container.querySelector('#hallPersona').addEventListener('click', () => openPersonaRegistry(container, roleId, profile));
    container.querySelector('#hallEval').addEventListener('click', () => showEvalService(container, globalState, onBack, roleId, profile));
    container.querySelector('#hallJobList').addEventListener('click', async () => {
        const myJob = profile.jobKey && getJob(profile.jobKey);
        if (!myJob || !myJob.hallStaff) { toast('🔒 仅限市政厅工作人员查看', '#999'); return; }
        const profiles = await getAllProfiles();
        const list = profiles.filter(p => p.jobKey && getJob(p.jobKey));
        const overlay = document.createElement('div');
        overlay.className = 'simcity-pop';
        overlay.innerHTML = `
            <div class="simcity-pop-card">
                <div style="font-weight:700;font-size:15px;text-align:center;margin-bottom:10px;">📋 职业登记表</div>
                <div class="simcity-pop-list">
                    ${list.map(p => {
            const j = getJob(p.jobKey);
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

    container.querySelector('#hallEstateList').addEventListener('click', async () => {
        const myJob = profile.jobKey && getJob(profile.jobKey);
        if (!myJob || !myJob.hallStaff) { toast('🔒 仅限市政厅工作人员查看', '#999'); return; }
        await loadEstates();   // 保证拿最新地产注册表
        const list = [...(simCityEstates?.estates || [])]
            .sort((a, b) => (a.status === 'built' ? 1 : 0) - (b.status === 'built' ? 1 : 0));   // 建设中在前
        const overlay = document.createElement('div');
        overlay.className = 'simcity-pop';
        overlay.innerHTML = `
        <div class="simcity-pop-card" style="max-height:88%;overflow-y:auto;">
            <div style="font-weight:700;font-size:15px;text-align:center;margin-bottom:10px;">🏘️ 地产登记表</div>
            <div style="font-size:12px;color:#999;text-align:center;margin-bottom:8px;">全城动态地产 · 共 ${list.length} 处</div>
            <div class="simcity-pop-list">
                ${list.map(e => {
            const isBuilt = e.status === 'built';
            return `<div style="padding:8px 4px;border-bottom:1px solid #f0f0f0;">
                        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:13px;">
                            <span style="font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${e.icon || '🏠'} ${esc(e.name)}</span>
                            <span style="font-size:11px;color:${isBuilt ? '#2e7d32' : '#f5a623'};font-weight:600;flex-shrink:0;">${isBuilt ? '🟢 已建成' : `🟡 建设中 ${e.progress || 0}%`}</span>
                        </div>
                        <div style="font-size:12px;color:#999;margin-top:3px;">建造：${esc(charName(e.owner))} · 子地点 ${(e.subs || []).length} 个${(e.ip || []).length ? ` · 关联IP ${e.ip.length} 个` : ''}</div>
                        ${isBuilt && (e.subs || []).length ? `<div style="font-size:12px;color:#7c4dff;margin-top:3px;">${(e.subs || []).map(s => esc(subDisplayName(s.name))).join('、')}</div>` : ''}
                    </div>`;
        }).join('') || '<div class="story-empty">暂无地产登记</div>'}
            </div>
            <button class="simcity-pop-close" id="estateListClose">关闭</button>
        </div>`;
        container.appendChild(overlay);
        overlay.querySelector('#estateListClose').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    });

    container.querySelector('#hallRank').addEventListener('click', async () => {
        const profiles = await getAllProfiles();
        const top = profiles
            .map(p => ({ name: charName(p.id), money: p.money || 0 }))
            .sort((a, b) => b.money - a.money)
            .slice(0, 10);
        const medal = ['🥇', '🥈', '🥉'];
        const overlay = document.createElement('div');
        overlay.className = 'simcity-pop';
        overlay.innerHTML = `
        <div class="simcity-pop-card">
            <div style="font-weight:700;font-size:15px;text-align:center;margin-bottom:10px;">🏆 现金排行榜</div>
            <div style="font-size:12px;color:#999;text-align:center;margin-bottom:8px;">全城角色现金前十 · 实时统计</div>
            <div class="simcity-pop-list">
                ${top.map((p, i) => `
                    <div style="display:flex;align-items:center;gap:8px;padding:8px 4px;border-bottom:1px solid #f0f0f0;font-size:13px;">
                        <span style="min-width:28px;font-weight:700;color:${i < 3 ? '#f5a623' : '#999'};">${medal[i] || `${i + 1}.`}</span>
                        <span style="flex:1;${i === 0 ? 'font-weight:700;' : ''}">${esc(p.name)}</span>
                        <span style="color:#7c4dff;font-weight:600;">💰 ${p.money}</span>
                    </div>`).join('') || '<div class="story-empty">暂无数据</div>'}
            </div>
            <button class="simcity-pop-close" id="rankClose">关闭</button>
        </div>`;
        container.appendChild(overlay);
        overlay.querySelector('#rankClose').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    });

    container.querySelectorAll('.sc-encounter').forEach(btn => {
        btn.addEventListener('click', () => {
            showEncounter(container, roleId, profile, btn.dataset.friend, btn.dataset.place);
        });
    });
    container.querySelectorAll('.sc-chat').forEach(btn => {
        btn.addEventListener('click', async () => {
            const gcId = await findOrRecoverGroupChat(roleId, profile, btn.dataset.friend, btn.dataset.place);
            showCityChat(container, roleId, profile, btn.dataset.friend, btn.dataset.place, false, null, gcId);
        });
    });
    startDayNightCycle(container);

}

// ★ 场景设定弹窗：系统级预设 + 专属世界书 + 父/子世界书开关
function openSceneSetting(container, place, rerender) {
    const cfg = simCityPlaceCfg?.placeConfigs?.[place.key] || {};
    const presets = simCityPlaceCfg?.presets || [];
    const myIds = cfg.presetIds || [];
    const parentPlace = place.parent ? findPlace(place.parent) : null;
    const subCount = childrenOf(place.key).length;

    // ★ 预设详情弹窗：查看完整内容
    const showPresetDetail = (name, text) => {
        const d = document.createElement('div');
        d.className = 'simcity-pop';
        d.style.zIndex = '60';   // 盖在场景设定弹窗之上
        d.innerHTML = `
            <div class="simcity-pop-card">
                <div style="font-weight:700;font-size:15px;text-align:center;margin-bottom:10px;">${esc(name)}</div>
                <div style="font-size:13px;line-height:1.8;color:#333;white-space:pre-wrap;max-height:50vh;overflow-y:auto;padding:10px;background:#faf8f5;border-radius:12px;">${esc(text)}</div>
                <button class="simcity-pop-close" id="pdClose">关闭</button>
            </div>`;
        container.appendChild(d);
        d.querySelector('#pdClose').addEventListener('click', () => d.remove());
        d.addEventListener('click', e => { if (e.target === d) d.remove(); });
    };

    const overlay = document.createElement('div');
    overlay.className = 'simcity-pop';
    overlay.innerHTML = `
        <div class="simcity-pop-card" style="max-height:88%;overflow-y:auto;">          <!-- ★ 卡片可滚动 -->
            <div style="font-weight:700;font-size:15px;text-align:center;margin-bottom:4px;">⚙️ 场景设定 · ${esc(place.name)}</div>
            ${parentPlace ? `<div style="font-size:12px;color:#999;text-align:center;margin-bottom:10px;">上级：${esc(parentPlace.name)} · 子地点 ${subCount} 个</div>` : `<div style="font-size:12px;color:#999;text-align:center;margin-bottom:10px;">子地点 ${subCount} 个</div>`}

            <div style="font-size:12px;font-weight:600;color:#4a3f6b;margin-bottom:4px;">系统级预设（可多选复用）</div>
            <div id="scenePresetList" style="max-height:240px;overflow-y:auto;">       <!-- ★ 列表调高 140 → 240 -->
                ${presets.map(t => `
                <div style="display:flex;align-items:center;gap:6px;padding:6px 2px;font-size:12px;border-bottom:1px solid #f0f0f0;">
                    <input type="checkbox" data-preset-id="${esc(t.id)}" ${myIds.includes(t.id) ? 'checked' : ''} style="flex-shrink:0;">
                    <span style="font-weight:600;color:#4a3f6b;white-space:nowrap;">${esc(t.name)}</span>
                    <span class="preset-text" data-preset-id="${esc(t.id)}" style="flex:1;color:#999;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;" title="点击查看完整内容">${esc(t.text)}</span>   <!-- ★ 文本可点击 -->
                    <button class="preset-del" data-preset-id="${esc(t.id)}" style="border:none;background:none;color:#e53935;font-size:13px;cursor:pointer;flex-shrink:0;">✕</button>
                </div>`).join('') || '<div style="color:#999;font-size:12px;padding:6px 0;">（暂无预设）</div>'}
            </div>

            <div style="font-size:12px;font-weight:600;color:#4a3f6b;margin:10px 0 4px;">新增预设</div>
            <div style="display:flex;gap:6px;">
                <input id="presetName" placeholder="预设名（如：AI拟人世界观）" style="flex:1;border:none;background:#f5f3fa;border-radius:10px;padding:8px 10px;font-size:12px;outline:none;min-width:0;">
                <input id="presetText" placeholder="预设内容" style="flex:2;border:none;background:#f5f3fa;border-radius:10px;padding:8px 10px;font-size:12px;outline:none;min-width:0;">
            </div>
            <button class="simcity-btn" id="presetAdd" style="width:100%;margin-top:8px;">＋ 添加预设</button>

            <div style="font-size:12px;font-weight:600;color:#4a3f6b;margin:12px 0 4px;">专属世界书（每个地点一份）</div>
            <textarea id="sceneWorldbook" placeholder="自由书写该地点的专属世界书；留空则用默认" style="width:100%;box-sizing:border-box;min-height:80px;border:none;background:#f5f3fa;border-radius:12px;padding:10px 12px;font-size:12px;line-height:1.7;outline:none;resize:vertical;">${esc(cfg.worldbook || '')}</textarea>

            <div style="font-size:12px;font-weight:600;color:#4a3f6b;margin:12px 0 4px;">周边世界书</div>
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;padding:4px 0;">
                <input type="checkbox" id="incParent" ${cfg.includeParent ? 'checked' : ''} ${parentPlace ? '' : 'disabled'}>
                <span>启用直接父地点的专属世界书${parentPlace ? `（${esc(parentPlace.name)}）` : '（无父地点）'}</span>
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;padding:4px 0;">
                <input type="checkbox" id="incChildren" ${cfg.includeChildren ? 'checked' : ''} ${subCount ? '' : 'disabled'}>
                <span>启用直接子地点的专属世界书（${subCount} 个，用于丰富周边描述）</span>
            </label>

            <div style="display:flex;gap:8px;margin-top:12px;">
                <button class="simcity-btn primary" id="sceneSave" style="flex:1;">保存</button>
            </div>
            <button class="simcity-pop-close" id="sceneClose">关闭</button>
        </div>`;
    container.appendChild(overlay);

    // ★ 点击预设文本 → 查看完整内容详情
    overlay.querySelectorAll('.preset-text').forEach(el => {
        el.addEventListener('click', () => {
            const t = presets.find(x => x.id === el.dataset.presetId);
            if (t) showPresetDetail(t.name, t.text);
        });
    });

    // 删除预设
    overlay.querySelectorAll('.preset-del').forEach(btn => {
        btn.addEventListener('click', async () => {
            const pid = btn.dataset.presetId;
            simCityPlaceCfg.presets = (simCityPlaceCfg.presets || []).filter(t => t.id !== pid);
            for (const k in (simCityPlaceCfg.placeConfigs || {})) {
                const c = simCityPlaceCfg.placeConfigs[k];
                c.presetIds = (c.presetIds || []).filter(x => x !== pid);
            }
            await saveSimCityPlaceConfig(simCityPlaceCfg);
            toast('✅ 预设已删除', '#e53935');
            overlay.remove();
        });
    });

    // 添加预设
    overlay.querySelector('#presetAdd').addEventListener('click', async () => {
        const name = overlay.querySelector('#presetName').value.trim();
        const text = overlay.querySelector('#presetText').value.trim();
        if (!name || !text) { toast('请填写预设名和内容', '#e53935'); return; }
        (simCityPlaceCfg.presets = simCityPlaceCfg.presets || []).push({ id: 'preset_' + Date.now().toString(36), name, text });
        await saveSimCityPlaceConfig(simCityPlaceCfg);
        toast('✅ 预设已添加，重新打开即可勾选', '#7c4dff');
        overlay.remove();
    });

    // 保存场景设定
    overlay.querySelector('#sceneSave').addEventListener('click', async () => {
        const wb = overlay.querySelector('#sceneWorldbook').value.trim();
        const presetIds = [...overlay.querySelectorAll('#scenePresetList input:checked')].map(i => i.dataset.presetId);
        const includeParent = overlay.querySelector('#incParent').checked;
        const includeChildren = overlay.querySelector('#incChildren').checked;
        simCityPlaceCfg = simCityPlaceCfg || { presets: [], placeConfigs: {} };          // 防缓存未加载
        simCityPlaceCfg.placeConfigs = simCityPlaceCfg.placeConfigs || {};               // 不再读 simCityWorld
        simCityPlaceCfg.placeConfigs[place.key] = { presetIds, worldbook: wb, includeParent, includeChildren };
        await saveSimCityPlaceConfig(simCityPlaceCfg);
        toast('✅ 场景设定已保存', '#7c4dff');
        overlay.remove();
        rerender && rerender();
    });

    overlay.querySelector('#sceneClose').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

// ★ 个性登记弹窗：编辑角色专属世界书 + 勾选复用模板 + 新增自定义模板
function openPersonaRegistry(container, roleId, profile) {
    const myIds = profile.personaTemplateIds || [];
    const allTpl = personaTemplates || [];   // ★ 内置 + 自定义都在这里了，不再拼 PERSONA_TEMPLATES

    const overlay = document.createElement('div');
    overlay.className = 'simcity-pop';
    overlay.innerHTML = `
        <div class="simcity-pop-card">
            <div style="font-weight:700;font-size:15px;text-align:center;margin-bottom:4px;">📝 个性登记</div>
            <div style="font-size:12px;color:#999;text-align:center;margin-bottom:10px;">写下专属于 ${esc(charName(roleId))} 的「世界书」，绑定角色本身，AI 会按此设定演绎（主视角 / 非主视角均生效）</div>

            <div style="font-size:12px;font-weight:600;color:#4a3f6b;margin-bottom:4px;">专属世界书</div>
            <textarea id="personaText" placeholder="自由书写角色的专属设定、说话风格、背景故事……" style="width:100%;box-sizing:border-box;min-height:90px;border:none;background:#f5f3fa;border-radius:12px;padding:10px 12px;font-size:12px;line-height:1.7;outline:none;resize:vertical;">${esc(profile.worldbook || '')}</textarea>

            <div style="font-size:12px;font-weight:600;color:#4a3f6b;margin:10px 0 4px;">勾选模板（可多选复用）</div>
            <div id="personaTplList" style="max-height:180px;overflow-y:auto;">
                ${allTpl.map(t => `
                <div style="display:flex;align-items:center;gap:6px;padding:6px 2px;font-size:12px;border-bottom:1px solid #f0f0f0;">
                    <input type="checkbox" data-tpl-id="${esc(t.id)}" ${myIds.includes(t.id) ? 'checked' : ''} style="flex-shrink:0;">
                    <span style="font-weight:600;color:#4a3f6b;white-space:nowrap;">${esc(t.name)}</span>
                    <span style="flex:1;color:#999;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(t.text)}</span>
                    <button class="tpl-edit" data-tpl-id="${esc(t.id)}" style="border:none;background:none;color:#7c4dff;font-size:13px;cursor:pointer;padding:0 2px;">✎</button>
                    <button class="tpl-del" data-tpl-id="${esc(t.id)}" style="border:none;background:none;color:#e53935;font-size:13px;cursor:pointer;padding:0 2px;">✕</button>
                </div>`).join('') || '<div style="color:#999;font-size:12px;padding:6px 0;">（暂无模板）</div>'}
            </div>

            <div style="font-size:12px;font-weight:600;color:#4a3f6b;margin:10px 0 4px;">新增自定义模板</div>
            <div style="display:flex;gap:6px;">
                <input id="personaTplName" placeholder="模板名（如：话痨）" style="flex:1;border:none;background:#f5f3fa;border-radius:10px;padding:8px 10px;font-size:12px;outline:none;min-width:0;">
                <input id="personaTplText" placeholder="模板内容" style="flex:2;border:none;background:#f5f3fa;border-radius:10px;padding:8px 10px;font-size:12px;outline:none;min-width:0;">
            </div>

            <div style="display:flex;gap:8px;margin-top:12px;">
                <button class="simcity-btn" id="personaAddTpl" style="flex:1;">＋ 添加模板</button>
                <button class="simcity-btn primary" id="personaSave" style="flex:1;">保存</button>
            </div>
            <button class="simcity-pop-close" id="personaClose">关闭</button>
        </div>`;
    container.appendChild(overlay);

    // ★ 保存：世界书 + 勾选模板 → 绑定角色档案
    overlay.querySelector('#personaSave').addEventListener('click', async () => {
        const text = overlay.querySelector('#personaText').value.trim();
        const checked = [...overlay.querySelectorAll('#personaTplList input:checked')].map(i => i.dataset.tplId);
        profile.worldbook = text;
        profile.personaTemplateIds = checked;
        await saveProfile(profile, roleId);
        toast('✅ 个性登记已保存', '#7c4dff');
        overlay.remove();
    });

    // ★ 编辑：点 ✎ 把模板内容回填到输入框，切换为"保存修改"
    overlay.querySelectorAll('.tpl-edit').forEach(btn => {
        btn.addEventListener('click', () => {
            const tpl = (personaTemplates || []).find(t => t.id === btn.dataset.tplId);
            if (!tpl) return;
            overlay.querySelector('#personaTplName').value = tpl.name;
            overlay.querySelector('#personaTplText').value = tpl.text;
            overlay.querySelector('#personaAddTpl').textContent = '💾 保存修改';
            overlay.querySelector('#personaAddTpl').dataset.editId = tpl.id;
        });
    });

    // ★ 删除：从世界键移除 + 清理所有角色的勾选引用
    overlay.querySelectorAll('.tpl-del').forEach(btn => {
        btn.addEventListener('click', async () => {
            const tid = btn.dataset.tplId;
            const profiles = await getAllProfiles();
            const writes = [];
            for (const p of profiles) {
                if ((p.personaTemplateIds || []).includes(tid)) {
                    p.personaTemplateIds = p.personaTemplateIds.filter(x => x !== tid);
                    writes.push({ profile: p, roleId: p.id });
                }
            }
            if (writes.length) await saveProfiles(writes);
            personaTemplates = personaTemplates.filter(t => t.id !== tid);   // ★ 内存移除
            await savePersonaTemplates(personaTemplates);                     // ★ 落库
            toast('✅ 模板已删除', '#e53935');
            overlay.remove();
        });
    });

    // ★ 添加 / 修改：统一走这里，editId 存在则修改
    overlay.querySelector('#personaAddTpl').addEventListener('click', async () => {
        const name = overlay.querySelector('#personaTplName').value.trim();
        const text = overlay.querySelector('#personaTplText').value.trim();
        if (!name || !text) { toast('请填写模板名和内容', '#e53935'); return; }
        if (!personaTemplates) { toast('❌ 模板数据未加载', '#e53935'); return; }
        const editId = overlay.querySelector('#personaAddTpl').dataset.editId;
        const list = personaTemplates;
        if (editId) {
            const t = list.find(x => x.id === editId);
            if (t) { t.name = name; t.text = text; }
        } else {
            list.push({ id: 'tpl_' + Date.now().toString(36), name, text });
        }
        await savePersonaTemplates(personaTemplates);
        toast(editId ? '✅ 模板已修改' : '✅ 模板已添加', '#7c4dff');
        overlay.remove();
    });

    overlay.querySelector('#personaClose').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
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
    startDayNightCycle(container);
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
    startDayNightCycle(container);


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
                <div class="simcity-room sc-outdoor" style="grid-template-columns:1fr 1fr;">
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
        btn.addEventListener('click', async () => {
            const gcId = await findOrRecoverGroupChat(roleId, profile, btn.dataset.friend, btn.dataset.place);
            showCityChat(container, roleId, profile, btn.dataset.friend, btn.dataset.place, false, null, gcId);
        });
    });


    startDayNightCycle(container);
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
                boughtAt: Date.now(),
                home: {   // ★ 毛坯间（根空间）：买到即是一个能直接用的整体大房间
                    id: 'home_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
                    name: '毛坯间', size: tpl.space || 20, desc: '',
                    furniture: [], rect: null, rooms: []   // ★ rect 预留平面可视化；rooms 预留房间内再划分
                }
            });
            // ★ 公告牌：购房/搬家事件
            addBulletin(tpl.area, 'move', `${profile.name}在${tpl.area}购置了「${tpl.name}」`);
            // ★ 买独栋别墅 → 解锁私人地产（世界注册表，初始 30 点进度）
            if (card.dataset.tpl === 'villa') {
                await loadEstates();
                if (!simCityEstates.estates.some(e => e.key === 'estate_villa' && e.owner === roleId)) {
                    simCityEstates.estates.push({
                        id: 'est_' + Date.now().toString(36),
                        key: 'estate_villa', goal: '', name: `${tpl.name}·私人庄园`, icon: '🏰',
                        status: 'building', progress: 30, maxProgress: 0,
                        contributors: [roleId], owner: roleId, ip: [], tags: [],
                        subs: [], jobs: [], desc: '', entryRule: null, createdAt: Date.now()
                    });
                    await saveEstates();
                }
            }
            await saveProfile(profile, roleId); propertyAreaIndex = await buildPropertyAreaIndex();   // ★ 重建索引（保留，为以后"邻居"功能备用）
            toast(`🏡 恭喜购入 ${tpl.name}！`, '#2e7d32');
            overlay.remove();
            renderSubPlace(container, globalState, onBack, roleId, profile, findPlace('agency'));   // 重渲染中介页
        });
    });
}

// 房产页面：室内视角（房产页本身即毛坯间；环境描述 + 休息 + 房间网格）
function renderPropertyPage(container, globalState, onBack, roleId, profile, prop, returnTo, readonly) {
    const t = HOUSE_TEMPLATES[prop.template] || HOUSE_TEMPLATES.default;
    const isDefault = prop.template === 'default';
    // ★ 旧数据兼容：无 home → 兜底生成毛坯根空间（size=模板 space）
    if (!prop.home) prop.home = { id: 'home_' + Math.random().toString(36).substr(2, 6), name: '毛坯间', size: t.space || 20, desc: '', furniture: [], rect: null, rooms: [] };
    const home = prop.home;
    const used = (home.rooms || []).reduce((s, r) => s + (r.size || 0), 0);
    const left = Math.max(0, (home.size || 0) - used);

    // ★ 房间网格：只放打造的房间（一行两个，透明卡片只有门+名字）
    const roomGrid = isDefault ? '' : `
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;">
            ${(home.rooms || []).map(r => `
            <div class="room-card" data-room="${esc(r.id)}" style="display:flex;flex-direction:column;align-items:center;gap:6px;padding:20px 8px;border-radius:16px;background:rgba(255,255,255,0.35);border:1px solid rgba(255,255,255,0.45);cursor:pointer;backdrop-filter:blur(4px);">
                <div style="font-size:30px;line-height:1;">${r.status === 'building' ? '🚧' : '🚪'}</div>
                <div style="font-size:13px;font-weight:600;color:#5a5470;">${esc(r.name)}</div>
                ${r.status === 'building' ? '<div style="font-size:10px;color:#ff9800;">施工中</div>' : ''}
            </div>`).join('')}
            ${readonly ? '' : `
            <div class="room-card" id="propAddRoom" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:20px 8px;border-radius:16px;background:rgba(124,77,255,0.04);border:1.5px dashed rgba(124,77,255,0.35);cursor:pointer;">
                <div style="font-size:24px;line-height:1;">＋</div>
                <div style="font-size:12px;color:#9c6bff;">打造新房间</div>
                <div style="font-size:10px;color:#999;">剩余 ${left} 格</div>
            </div>`}
        </div>`;

    container.innerHTML = `
        <div class="simcity-root">
            <div class="simcity-header">
                <button class="back-btn" id="propBack">←</button>
                <span class="title">${t.icon} ${esc(prop.name || t.name)}</span>
                <span class="level">${esc(t.area)}</span>
            </div>
            <div class="simcity-body">
                ${isDefault ? (readonly ? '' : `
                <div class="simcity-room">
                    <div class="simcity-item" id="propRest">
                        <div class="item-icon">${t.icon}</div>
                        <div class="item-name">${esc(prop.name || t.name)}</div>
                        <div class="item-desc">${esc(t.desc)}</div>
                    </div>
                </div>`) : `
                
                <!-- ★ 环境描述区（房产页本身即毛坯间） -->
                <div class="simcity-env" style="background:linear-gradient(135deg,rgba(255,255,255,0.85),rgba(239,233,255,0.85));border-radius:18px;padding:16px;margin-bottom:12px;">
                    <div style="font-size:28px;">${t.icon}</div>
                    <div style="font-size:15px;font-weight:700;color:#2d2d3a;margin-top:6px;">${esc(prop.name || t.name)}</div>
                    <div style="font-size:12px;color:#5a5470;margin-top:4px;line-height:1.6;">${esc(t.desc)}${home.size ? ` · 室内空间 ${home.size} 格，已规划 ${used}，剩余 ${left}` : ''}</div>
                    ${prop.address ? `<div style="font-size:12px;color:#8a7fa8;margin-top:4px;">📍 ${esc(prop.address)}${profile.home === prop.id ? ' · 🏠我的主宅' : ''}</div>` : ''}
                    <div style="height:6px;border-radius:3px;background:rgba(124,77,255,0.12);overflow:hidden;margin-top:10px;">
                        <div style="height:100%;width:${home.size ? Math.min(100, Math.round(used / home.size * 100)) : 0}%;background:linear-gradient(90deg,#7c4dff,#9c6bff);border-radius:3px;"></div>
                    </div>
                </div>
                <!-- ★ 毛坯间里休息（房产页本身即毛坯间） -->
                ${readonly ? '' : `
                <div class="simcity-room">
                    <div class="simcity-item" id="propRest">
                        <div class="item-icon">🛏️</div>
                        <div class="item-name">休息</div>
                        <div class="item-desc">在${esc(prop.name || t.name)}里小憩，恢复能量</div>
                    </div>
                </div>`}
                <!-- ★ 房间网格（一行两个） -->
                ${roomGrid}
                <div style="font-size:12px;color:#999;text-align:center;margin-top:12px;">🛋️ 家具布置系统开发中…</div>
                `}
            </div>
        </div>`;
    container.querySelector('#propBack').addEventListener('click', () => returnTo ? returnTo() : renderHome(container, globalState, onBack, roleId, profile));
    // ★ 休息入口（default 和 毛坯间 都绑）
    container.querySelector('#propRest').addEventListener('click', () => doAction(container, globalState, onBack, roleId, profile, 'rest', () => renderPropertyPage(container, globalState, onBack, roleId, profile, prop, returnTo), 'home'));
    if (!isDefault) {
        container.querySelector('#propAddRoom').addEventListener('click', () => showBuildRoom(container, globalState, onBack, roleId, profile, prop, returnTo));
        // ★ 打造的房间可点击进入
        container.querySelectorAll('[data-room]').forEach(el => {
            el.addEventListener('click', () => {
                const room = (home.rooms || []).find(x => x.id === el.dataset.room);
                if (room) renderRoomPage(container, globalState, onBack, roleId, profile, prop, room, returnTo);
            });
        });
    }
    startDayNightCycle(container);
}

// ★ 打造新房间：从毛坯根空间划分子空间（树结构；rect 预留平面可视化；家具容量后续）
function showBuildRoom(container, globalState, onBack, roleId, profile, prop, returnTo) {
    const home = prop.home;
    if (!home) return;
    const used = (home.rooms || []).reduce((s, r) => s + (r.size || 0), 0);
    const left = Math.max(0, (home.size || 0) - used);
    if (left <= 0) { toast('🛠️ 空间已全部规划，没有剩余空间了', '#999'); return; }
    const overlay = document.createElement('div');
    overlay.className = 'simcity-pop';
    overlay.innerHTML = `<div class="simcity-pop-card">
        <div style="font-weight:700;font-size:15px;margin-bottom:4px;">🛠️ 打造新房间</div>
        <div style="font-size:12px;color:#999;margin-bottom:10px;">${esc(prop.name || '')} · 剩余 ${left} 格 · 施工费 ${ROOM_COST_PER_GRID}金币/格</div>
        <div style="font-size:13px;color:#333;margin-bottom:6px;">房间名（如：书房、游戏室）</div>
        <input id="roomName" maxlength="8" placeholder="给房间起个名字" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #ddd;border-radius:10px;font-size:13px;margin-bottom:10px;">
        <div style="font-size:13px;color:#333;margin-bottom:6px;">房间大小（1~${left} 格，决定家具容量）</div>
        <input id="roomSize" type="number" min="1" max="${left}" value="${Math.min(5, left)}" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #ddd;border-radius:10px;font-size:13px;margin-bottom:10px;">
        <button id="roomConfirm" style="width:100%;padding:10px;border:none;border-radius:12px;background:linear-gradient(135deg,#7c4dff,#9c6bff);color:#fff;font-size:14px;font-weight:600;cursor:pointer;margin-bottom:6px;">确认打造（${ROOM_COST_PER_GRID}金币/格）</button>
        <button class="simcity-pop-close" id="roomCancel">取消</button>
    </div>`;
    container.appendChild(overlay);
    let confirming = false;                    // ★ 只防同一次弹窗内重复确认
    const confirmBtn = overlay.querySelector('#roomConfirm');
    const cancelBtn = overlay.querySelector('#roomCancel');
    const closePopup = () => overlay.remove(); // ★ 随时可关（确认前=取消；确认后=关闭，施工继续）
    cancelBtn.addEventListener('click', closePopup);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closePopup(); });
    confirmBtn.addEventListener('click', async () => {
        if (confirming) return;
        const name = overlay.querySelector('#roomName').value.trim();
        const size = parseInt(overlay.querySelector('#roomSize').value, 10);
        if (!name) { toast('📝 给房间起个名字吧', '#999'); return; }
        if (!(size >= 1 && size <= left)) { toast(`🛠️ 大小需在 1~${left} 格之间`, '#999'); return; }
        const cost = size * ROOM_COST_PER_GRID;
        if (profile.money < cost) { toast(`💰 金币不足，还差 ${cost - profile.money}`, '#e53935'); return; }
        // ★ 确认即锁定：扣钱 + 立即 push 占位房间（占用空间）并保存——之后随便切走都安全
        confirming = true;
        profile.money -= cost;
        confirmBtn.disabled = true; confirmBtn.textContent = '⏳ 施工中…';
        cancelBtn.textContent = '⏳ 后台施工中（可关闭）';
        const room = { id: 'rm_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4), name, size, desc: '', status: 'building', furniture: [], rect: null, rooms: [] };
        (home.rooms = home.rooms || []).push(room);
        await saveProfile(profile, roleId);    // ★ 锁定持久化（切走/刷新都不会超）
        let desc = '';
        try {
            const { callAIWithMessages } = await import('../aiService.js');
            const raw = await taskManager.watch('cityroom', '房间风格设计', async () => callAIWithMessages({
                systemPrompt: '你是"模拟小城"的室内设计助手。用一句话（40字以内）描述一个房间的风格氛围，像小说描写一样有画面感，避免AI套话。只输出描述本身，不要任何前缀。',
                userContent: `房间名：${name}，大小：${size}格，属于${prop.name || '我的家'}。请描述这个房间的风格氛围。`,
                maxTokens: 200, temperature: 0.9
            }));
            desc = (raw || '').trim().slice(0, 60);
            room.desc = desc; room.status = '';   // ★ 完成：填充描述，解除施工状态
        } catch (e) {
            home.rooms = (home.rooms || []).filter(r => r.id !== room.id);   // ★ 失败：解锁空间 + 退款
            profile.money += cost;
        }
        await saveProfile(profile, roleId);
        // ★ 完成后：弹窗还开着 → 关窗并刷新房产页；已关（用户切走）→ 只 toast 提醒
        if (overlay.isConnected) {
            overlay.remove();
            renderPropertyPage(container, globalState, onBack, roleId, profile, prop, returnTo);
        }
        toast(`🛠️ ${name} 打造完成！${desc ? '「' + desc + '」' : ''}`, '#7c4dff');
    });
}

// 房间页面：查看打造的房间（家具布置系统后续）
function renderRoomPage(container, globalState, onBack, roleId, profile, prop, room, returnTo) {
    const t = HOUSE_TEMPLATES[prop.template] || HOUSE_TEMPLATES.default;
    const building = room.status === 'building';
    container.innerHTML = `
        <div class="simcity-root">
            <div class="simcity-header">
                <button class="back-btn" id="roomBack">←</button>
                <span class="title">${t.icon} ${esc(room.name)}</span>
                <span class="level">${esc(room.size)} 格${building ? ' · 施工中' : ''}</span>
            </div>
            <div class="simcity-body">
                <div class="simcity-env" style="background:linear-gradient(135deg,rgba(255,255,255,0.85),rgba(239,233,255,0.85));border-radius:18px;padding:16px;margin-bottom:12px;">
                    <div style="font-size:28px;">${building ? '🚧' : '🚪'}</div>
                    <div style="font-size:15px;font-weight:700;color:#2d2d3a;margin-top:6px;">${esc(room.name)}</div>
                    <div style="font-size:12px;color:#5a5470;margin-top:4px;line-height:1.6;">${esc(room.desc || (building ? '正在施工…' : '新打造的房间'))}</div>
                </div>
                <div style="font-size:12px;color:#999;text-align:center;margin-top:12px;">🛋️ 家具布置系统开发中…</div>
            </div>
        </div>`;
    container.querySelector('#roomBack').addEventListener('click', () => renderPropertyPage(container, globalState, onBack, roleId, profile, prop, returnTo));
    startDayNightCycle(container);
}

// ★ 私人地产页面（建设中=进度+共建者；建成=焕新特别场景；仅可见者可进）
function renderEstate(container, globalState, onBack, roleId, profile, estate) {
    const hour = new Date().getHours();
    const isOwner = estate.owner === roleId;   // ★ 发起者才能设立目标
    const isParticipant = estate.owner === roleId || (estate.contributors || []).includes(roleId);
    const building = estate.status !== 'built';
    const pct = building && estate.maxProgress ? Math.min(100, Math.round(estate.progress / estate.maxProgress * 100)) : 100;
    // ★ 评估中任务（占位显示目标）
    const pendingTask = pendingTargets.find(t => t.estateId === estate.id);
    const pendingGoal = pendingTask ? pendingTask.goal : '';

    const contribHtml = (estate.contributors || []).map(id => {
        const nm = (id === roleId) ? profile.name : ((charDisplayMap[id] && charDisplayMap[id].name) || getCharacterNameById(id) || id);
        return `<div class="sc-person">
            <div class="avatar">${getAvatarHtml(id)}</div>
            <div class="sc-name">${esc(nm)}${id === estate.owner ? ' <small>（发起者）</small>' : ''}</div>
        </div>`;
    }).join('') || '<div class="sc-empty">暂无共建者</div>';
    container.innerHTML = `
        <div class="simcity-root">
            <div class="simcity-header">
                <button class="back-btn" id="estateBack">←</button>
                <span class="title">${estate.icon} ${esc(estate.name)}</span>
                <span class="level">${building ? '建设中' : '特别场景'}</span>
            </div>
            <div class="simcity-body">
                <div class="simcity-room sc-outdoor">
                    <div class="simcity-env">
                        <div class="env-icon">${estate.icon || '🏰'}</div>
                        <div class="env-name">${esc(estate.name)}</div>
                        <div class="env-desc">${building ? (estate.goal ? `目标：${esc(estate.goal)}` : '一块等待开发的私人土地') : (estate.desc || placeAmbience({ key: estate.key, name: estate.name }, hour))}</div>
                    </div>
                </div>
                ${building ? `
                <div class="sc-present">
                    <div class="sc-present-hd">📈 建设进度</div>
                    ${pendingGoal ? `
                    <div style="font-size:13px;color:#ff9800;margin:4px 0;">🏗️ 正在评估目标：<span id="pendingGoal">${esc(pendingGoal)}</span></div>
                    <div style="font-size:11px;color:#999;margin-bottom:6px;">完成后点击下方刷新查看</div>
                    <button class="simcity-btn primary" id="estateRefresh" style="margin-top:4px;">🔄 刷新</button>
                    ` : `
                    ${estate.goal ? `
                    <div class="sc-bar-row"><span>${esc(estate.goal)}：${estate.progress} / ${estate.maxProgress || '∞'}</span><div class="sc-bar"><i style="width:${pct}%"></i></div></div>
                    ${isParticipant && estate.maxProgress && estate.progress >= estate.maxProgress
                    ? `<button class="simcity-btn primary" id="estateTransform" style="margin-top:8px;">🏗️ 申请焕新为正式场景</button>`
                    : `<div style="font-size:11px;color:#999;margin-top:4px;">进度满后可由共建者申请焕新为正式特别场景</div>`}` : `
                    <div style="font-size:12px;color:#999;margin:4px 0;">尚未设立目标，这块土地等待着你的想象</div>
                    ${isOwner ? `<button class="simcity-btn primary" id="estateGoal" style="margin-top:8px;">🎯 设立目标</button>` : ''}`}
                    `}
                </div>` : ''}
                ${!building ? `
                <div class="sc-present">
                    <div class="sc-present-hd">🏷️ 标签</div>
                    <div class="sc-tags">${(estate.tags || []).map(t => `<span class="sc-tag">${esc(t)}</span>`).join('') || '<div class="sc-empty">暂无</div>'}</div>
                </div>
                <div class="sc-present">
                    <div class="sc-present-hd">🏛️ 子地点</div>
                        ${(estate.subs || []).map(s => `<div class="sc-prop">${esc(subDisplayName(s.name))} <small>${esc(s.desc || '')}</small></div>`).join('') || '<div class="sc-empty">暂无</div>'}
                </div>
                <div class="sc-present">
                    <div class="sc-present-hd">💼 职业</div>
                    ${(estate.jobs || []).map(j => `<div class="sc-prop">${esc(j.name)} <small>${esc((j.requireSkills || []).join(' · '))}</small></div>`).join('') || '<div class="sc-empty">暂无</div>'}
                </div>` : ''}
                ${building ? (getPresentAt(placeIndex, estate.name, hour).filter(id => id !== roleId).length ? `
                <div class="sc-present">
                    <div class="sc-present-hd">🕐 此刻在这里（${hour}:00）</div>
                    ${getPresentAt(placeIndex, estate.name, hour).filter(id => id !== roleId).map(id => `
                        <div class="sc-person">
                            <div class="avatar">${getAvatarHtml(id)}</div>
                            <div class="sc-name">${esc((charDisplayMap[id] && charDisplayMap[id].name) || getCharacterNameById(id) || id)}</div>
                        </div>`).join('')}
                </div>` : '') : ''}

                <div class="sc-present">
                    <div class="sc-present-hd">👥 共建者</div>
                    ${contribHtml}
                </div>
                <div class="simcity-note">${building ? '建设中：仅共建者可进入' : '带标签的特别场景：仅相关者可进入'}</div>
            </div>
            <div class="simcity-actions">
                <button class="simcity-btn" id="estateFriends">👥 好友</button>
                <button class="simcity-btn primary" id="estateRest">😌 在自己的地盘歇会儿</button>
            </div>
        </div>`;
    container.querySelector('#estateBack').addEventListener('click', () => renderMain(container, globalState, onBack, roleId, profile));
    // ★ 设立目标按钮（owner + 未设目标时出现）
    const goalBtn = container.querySelector('#estateGoal');
    if (goalBtn) {
        goalBtn.addEventListener('click', () => {
            // ★ 目标输入弹窗（复用 simcity-pop 卡片）
            const pop = document.createElement('div');
            pop.className = 'simcity-pop';
            pop.innerHTML = `
                <div class="simcity-pop-card">
                    <div style="font-weight:700;font-size:15px;margin-bottom:10px;">🎯 设立建设目标</div>
                    <div style="font-size:12px;color:#666;margin-bottom:10px;">你想把这块土地建设成什么？（如：冬木市 / 卫宫士郎的家）评估官会判断是新建还是并入已有建设。</div>
                    <input id="goalInput" value="" placeholder="输入目标…" style="width:100%;box-sizing:border-box;border:none;background:#f2f0f7;border-radius:12px;padding:10px 12px;font-size:14px;outline:none;margin-bottom:10px;">
                    <button class="simcity-btn primary" id="goalConfirm">提交评估</button>
                    <button class="simcity-pop-close" id="goalCancel">取消</button>
                </div>`;
            pop.querySelector('#goalCancel').addEventListener('click', () => pop.remove());
            pop.addEventListener('click', (e) => { if (e.target === pop) pop.remove(); });
            pop.querySelector('#goalConfirm').addEventListener('click', async () => {
                const goal = pop.querySelector('#goalInput').value.trim();
                if (!goal) { toast('请输入目标', '#ff9800'); return; }
                // ★ 防与静态地点同名（避免与地图已有地点在场索引撞 key）
                const staticNames = [...new Set(PLACES.map(p => p.name))];
                if (staticNames.includes(goal)) {
                    toast(`⚠️ 「${goal}」是小城已有地点，请换个目标名`, '#e53935');
                    return;
                }
                pop.remove();
                // ★ 防重 + 登记 + 占位
                if (pendingTargets.some(t => t.estateId === estate.id)) { toast('⚠️ 该地产正在评估中'); return; }
                if (pendingTargets.some(t => t.goal === goal)) { toast(`⚠️ 「${goal}」已在评估中，稍后再提交（将自动合并）`); return; }
                pendingTargets.push({ estateId: estate.id, goal, submittedAt: Date.now() });
                renderEstate(container, globalState, onBack, roleId, profile, estate);
                await applyEstateGoal(container, globalState, onBack, roleId, profile, estate, goal);
            });
            container.appendChild(pop);
        });

    }
    // ★ 申请焕新按钮（独立绑定：有目标+进度满时出现，与设立目标互斥）
    const transformBtn = container.querySelector('#estateTransform');
    if (transformBtn) {
        transformBtn.addEventListener('click', () => {
            // ★ 防重 + 登记 + 占位
            if (pendingTargets.some(t => t.estateId === estate.id)) { toast('⚠️ 该地产正在评估中'); return; }
            pendingTargets.push({ estateId: estate.id, goal: estate.goal || estate.name, submittedAt: Date.now() });
            renderEstate(container, globalState, onBack, roleId, profile, estate);
            toast('🏗️ 正在申请焕新…', '#7c4dff');
            transformEstate(container, globalState, onBack, roleId, profile, estate);
        });
    }
    // ★ 刷新按钮（评估中占位时出现）
    const refreshBtn = container.querySelector('#estateRefresh');
    if (refreshBtn) refreshBtn.addEventListener('click', () => renderEstate(container, globalState, onBack, roleId, profile, estate));
    container.querySelector('#estateRest').addEventListener('click', () => {
        profile.energy = Math.min(100, profile.energy + 30);
        profile.mood = Math.min(100, profile.mood + 15);
        saveProfile(profile, roleId).then(() => {
            toast('😌 在自己的地盘歇了会儿，身心舒畅', '#2e7d32');
            renderEstate(container, globalState, onBack, roleId, profile, estate);
        });
    });
    container.querySelector('#estateFriends').addEventListener('click', () => showFriends(container, globalState, onBack, roleId, profile));
    startDayNightCycle(container);
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
                            <div style="flex:1;font-size:14px;">${esc(f.name)}
                            ${(() => { const s = starOf(getIntimacy(roleId, f.id)); return s ? ` <span style="font-size:11px;color:#ff9800;">${s}</span>` : ''; })()}
                            ${f.isContact ? ` <span style="font-size:12px;color:#999;">（${esc(realName(f.id))}）</span>` : ''}${(() => {
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
                            <button class="gf-share" data-friend="${esc(id)}" style="flex-shrink:0;border:none;background:#7c4dff;color:#fff;border-radius:12px;padding:5px 12px;font-size:12px;cursor:pointer;">分享</button>
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
    overlay.querySelectorAll('.gf-share').forEach(btn => {
        btn.addEventListener('click', async () => {
            const fId = btn.dataset.friend;
            const card = buildShareCard(roleId, profile);
            // 预览弹窗（简单卡片，视觉后置）
            const choice = await new Promise(res => {
                const m = document.createElement('div');
                m.style.cssText = 'position:fixed;inset:0;z-index:600;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;';
                m.innerHTML = `<div style="background:#fff;border-radius:18px;width:300px;padding:20px;text-align:center;">
                <div style="font-size:40px;">🏙️</div>
                <div style="font-weight:700;font-size:17px;margin:6px 0;">虚拟小城</div>
                <div style="font-size:13px;color:#666;line-height:1.8;">${esc(card.name)}（${esc(card.job)}·Lv.${card.level}）<br>金币 ${card.money} · 性格 ${esc(card.traits)}<br>${card.ip ? '世界观 ' + esc(card.ip) + '<br>' : ''}房产 ${card.props} 处</div>
                <div style="font-size:11px;color:#999;margin-top:8px;">将分享给 ${esc(realName(fId))}</div>
                <label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:12px;color:#555;text-align:left;cursor:pointer;">
                    <input type="checkbox" id="shareFandom" style="width:16px;height:16px;accent-color:#7c4dff;flex-shrink:0;">
                    <span>✨ 临时同人增强：对方人设生成时考虑已建成同人场景（仅本次邀请，不写入对方档案）</span>
                </label>
                <div style="display:flex;gap:10px;margin-top:14px;">
                    <button id="shareCancel" style="flex:1;border:none;background:#f0f0f0;color:#666;padding:10px;border-radius:12px;cursor:pointer;">取消</button>
                    <button id="shareOk" style="flex:1;border:none;background:#7c4dff;color:#fff;padding:10px;border-radius:12px;cursor:pointer;">确认分享</button>
                </div></div>`;
                document.body.appendChild(m);
                m.querySelector('#shareCancel').addEventListener('click', () => { m.remove(); res(null); });
                m.querySelector('#shareOk').addEventListener('click', () => { const boost = !!m.querySelector('#shareFandom').checked; m.remove(); res(boost); });
            });
            if (choice === null) return;

            const shareText = `【分享】我在玩一款叫「虚拟小城」的游戏！这是我的名片：\n游戏名：${card.name}（${card.job}·Lv.${card.level}）\n金币：${card.money} · 性格：${card.traits}${card.ip ? '\n世界观：' + card.ip : ''}\n要不要也来注册一个？`;
            try {
                toast('分享中…');
                const res = await sendGameShareToChat(roleId, fId, shareText);
                if (res.agreed) {
                    const fRealName = realName(fId);
                    const fp = createDefaultProfile(fRealName);
                    await saveProfile(fp, fId);
                    // ★ 立即进内存显示缓存：同一会话内聊天/群聊即可显示游戏名，不必重进小城
                    charDisplayMap[fId] = { name: fp.name || fRealName, jobKey: '', energy: fp.energy || 100 };
                    toast(`🎉 ${esc(fRealName)} 同意入住！正在生成小城人设…`, '#7c4dff');
                    startAiEvaluation(fId, fp, `刚收到「${profile.name}」分享的虚拟小城邀请，同意入住`, '', choice);
                    toast(`已注册，重新打开好友列表可见`, '#7c4dff');   // MVP：不强制重渲染
                } else {
                    toast(`${realName(fId)} 回复：${res.reply.slice(0, 30)}…`);
                }
            } catch (e) {
                toast('分享失败：' + e.message);
            }
        });
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// 授权 + 全局设定（只读授权 + AI对话记忆条数）
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
            <div style="margin-top:12px;padding-top:12px;border-top:1px solid #f5f5f5;">
                <div style="font-size:12px;color:#999;margin-bottom:6px;">🧠 AI对话记忆（全局：AI聊天时携带的最近消息条数）</div>
                <div style="display:flex;align-items:center;gap:10px;">
                    <input type="range" id="permHistoryCount" min="5" max="100" step="5" value="${simCitySettings?.historyCount || 20}" style="flex:1;accent-color:#7c4dff;">
                    <span id="permHistoryVal" style="font-size:13px;font-weight:600;color:#7c4dff;min-width:34px;text-align:center;">${simCitySettings?.historyCount || 20}</span>
                </div>
                <div style="font-size:11px;color:#bbb;margin-top:4px;">条数越多，AI 越了解你们的过往，token 消耗越大</div>
            </div>
            <div style="font-size:11px;color:#999;margin-top:10px;">授权为系统接口，暂不可在游戏内修改</div>
            <button class="simcity-pop-close" id="permClose">关闭</button>
        </div>`;
    container.appendChild(overlay);
    overlay.querySelector('#permClose').addEventListener('click', () => overlay.remove());
    // ★ AI对话记忆条数：拖动即存（change 松手时保存，避免频繁写库）
    const hSlider = overlay.querySelector('#permHistoryCount');
    const hVal = overlay.querySelector('#permHistoryVal');
    hSlider.addEventListener('input', () => { hVal.textContent = hSlider.value; });
    hSlider.addEventListener('change', async () => {
        const hc = parseInt(hSlider.value, 10) || 20;
        simCitySettings = { historyCount: hc };   // ★ 内存同步（本会话立即生效）
        await saveSimCitySettings({ historyCount: hc }).catch(() => { });
        toast(`🧠 AI对话记忆已设为 ${hc} 条`);
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// ★ 购买住宅区房产：地址 = 地点全名 + 门牌（拼接，全局唯一）
async function buyHouse(profile, roleId, place, houseName) {
    const res = simCityResidentials[place.key] || { houses: [{ ...DEFAULT_HOUSE }] };
    const house = (res.houses || []).find(h => h.name === houseName) || res.houses[0];
    if (!house) { toast('❌ 房型不存在', '#e53935'); return; }
    if (profile.money < house.price) { toast(`💰 金币不足，还差 ${house.price - profile.money}`, '#e53935'); return; }
    // ★ 门牌：按住宅区登记表全局住户数生成（唯一；含迁移旧房产）
    const resReg = simCityResidentials[place.key] = simCityResidentials[place.key] || { name: place.residential, houses: [{ ...DEFAULT_HOUSE }] };
    const n = (resReg.residents || []).length;
    profile.money -= house.price;
    const addr = `${place.name}-${2 + Math.floor(n / 3)}栋-${101 + (n % 3) * 100}室`;
    const propList = (profile.properties = profile.properties || []);
    propList.push({
        id: 'prop_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
        template: house.template || 'apartment',
        name: house.name,
        area: place.name,
        address: addr
    });
    const newProp = propList[propList.length - 1];   // ★ 拿到新房产引用（登记用，修复 lastProp 未定义）
    await saveProfile(profile, roleId);
    // ★ 登记到住宅区表（轻量索引：角色 ↔ 该地点住宅区）
    (resReg.residents = resReg.residents || []).push({ roleId, name: profile.name, propId: newProp.id, address: addr, at: Date.now() });
    await saveSimCityResidentials(simCityResidentials).catch(() => { });
    addBulletin(place.key, 'move', `${profile.name}在「${addr}」购置了「${house.name}」`);
    toast(`🏠 购入「${house.name}」！地址：${addr}`, '#7c4dff');
}

// ★ 公共购买：扣钱 + 背包 + 库存 -1 + 落库（玩家按钮与 AI 指令共用）
async function buyItem(profile, roleId, estate, shop, itemName) {
    const it = (shop.items || []).find(x => x.name === itemName || x.name.includes(itemName) || itemName.includes(x.name));
    if (!it || it.qty <= 0) return { ok: false, msg: `「${itemName}」不在货架上或已售罄` };
    const cost = it.price || 0;
    if ((profile.money || 0) < cost) return { ok: false, msg: `金币不足（需要 ${cost}）` };
    profile.money -= cost;
    it.qty -= 1;
    profile.inventory = profile.inventory || [];
    const inv = profile.inventory.find(x => x.itemId === `${estate.id}_${it.name}`);
    if (inv) inv.count += 1; else profile.inventory.push({ itemId: `${estate.id}_${it.name}`, name: it.name, icon: it.icon, desc: it.desc, price: cost, count: 1 });
    await saveProfile(profile, roleId);
    await saveSimCityShops(simCityShops).catch(() => { });
    addBulletin(estate.id, 'shop', `${profile.name}在「${shop.name}」买走了${it.name}`);   // ★ 公告牌：购买事件    
    return { ok: true, msg: `购入「${it.name}」×1（💰${cost}），已放入背包` };
}

// ★ 商店弹窗：商品列表 + 购买（扣金币 → 进背包；库存改商店表 → saveSimCityShops）
function showShop(container, globalState, onBack, roleId, profile, estate, shop) {
    const overlay = document.createElement('div');
    overlay.className = 'simcity-pop';
    overlay.innerHTML = `
        <div class="simcity-pop-card">
            <div style="font-weight:700;font-size:15px;margin-bottom:4px;">${shop.icon} ${esc(shop.name)}</div>
            <div style="font-size:12px;color:#999;margin-bottom:10px;">${esc(estate.name)} · 每日补货</div>
            <div class="simcity-pop-list" style="max-height:46vh;overflow-y:auto;">
                ${(shop.items || []).map((it, i) => `
                    <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #f5f5f5;">
                        <div style="font-size:22px;width:36px;text-align:center;">${it.icon}</div>
                        <div style="flex:1;min-width:0;">
                            <div style="font-size:14px;font-weight:600;">${esc(it.name)}</div>
                            <div style="font-size:11px;color:#999;margin-top:2px;">${esc(it.desc) || '—'} · 剩 ${it.qty}</div>
                        </div>
                        <div style="text-align:right;">
                            <div style="font-size:13px;color:#e67e22;font-weight:600;">💰${it.price}</div>
                            <button class="shop-buy" data-i="${i}" ${it.qty <= 0 ? 'disabled' : ''}
                                style="margin-top:4px;border:none;border-radius:10px;padding:5px 12px;font-size:12px;cursor:${it.qty > 0 ? 'pointer' : 'default'};background:${it.qty > 0 ? '#7c4dff' : '#e0e0e0'};color:#fff;">
                                ${it.qty > 0 ? '购买' : '售罄'}
                            </button>
                        </div>
                    </div>`).join('') || '<div style="text-align:center;color:#999;padding:14px 0;">货架空空如也</div>'}
            </div>
            <div style="font-size:11px;color:#999;margin-top:8px;">金币：💰${profile.money || 0}</div>
            <button class="simcity-pop-close" id="shopClose">关闭</button>
        </div>`;
    container.appendChild(overlay);
    overlay.querySelector('#shopClose').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelectorAll('.shop-buy').forEach(btn => {
        btn.addEventListener('click', async () => {
            const it = (shop.items || [])[parseInt(btn.dataset.i, 10)];
            if (!it || it.qty <= 0) return;
            const r = await buyItem(profile, roleId, estate, shop, it.name);
            toast(r.ok ? `✅ ${r.msg}` : `❌ ${r.msg}`, r.ok ? '#333' : '#e53935');
            if (r.ok) {
                btn.disabled = it.qty <= 0;
                btn.textContent = it.qty > 0 ? '购买' : '售罄';
                btn.style.background = it.qty > 0 ? '#7c4dff' : '#e0e0e0';
            }
        });
    });
}

// ★ 事件弹窗：开场 + 是否深入体验（文游模式）
function showPendingEvent(container, globalState, onBack, roleId, profile, place, ev, onReturn) {
    const overlay = document.createElement('div');
    overlay.className = 'simcity-pop';
    overlay.innerHTML = `
        <div class="simcity-pop-card">
            <div style="font-weight:700;font-size:15px;margin-bottom:4px;">🔔 事件 · ${esc(place.name)}</div>
            <div style="font-size:12px;color:#999;margin-bottom:10px;">${new Date(ev.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>
            <div style="font-size:13px;line-height:1.8;color:#333;white-space:pre-wrap;max-height:40vh;overflow-y:auto;padding:10px;background:#faf8f5;border-radius:12px;">${esc(ev.text)}</div>
            <div style="display:flex;gap:10px;margin-top:14px;">
                <button id="evSkip" class="simcity-pop-close" style="flex:1;margin:0;">跳过</button>
                <button id="evGo" style="flex:1;border:none;background:#7c4dff;color:#fff;border-radius:12px;padding:10px;font-size:13px;cursor:pointer;">🎭 深入体验</button>
            </div>
        </div>`;
    container.appendChild(overlay);
    overlay.querySelector('#evSkip').addEventListener('click', () => overlay.remove());   // ★ 跳过：事件槽保留（下次可再点）
    overlay.querySelector('#evGo').addEventListener('click', () => {
        overlay.remove();
        delete pendingEvents[place.key];
        savePendingEvents();   // ★ 事件已进入文游，感叹号由文游状态（🎭）接管
        const rk = advStateKeyOf(roleId, place.key);
        // ★ 地点预设 + 地点世界书（从 simCityPlaceCfg 取）
        const pc = simCityPlaceCfg?.placeConfigs?.[place.key] || {};
        const presetsTxt = (pc.presetIds || []).map(id => (simCityPlaceCfg?.presets || []).find(p => p.id === id)?.text).filter(Boolean).join('\n');
        // ★ 角色详细信息（同评估：真实卡 base）+ 个性登记（模板+专属世界书）
        let base = null;
        try {
            const f = JSON.parse(localStorage.getItem('rolebook_characters') || '[]').find(c => c.id === roleId);
            if (f?.base) base = f.base;
            else { const f2 = JSON.parse(localStorage.getItem('worldnet_extra_characters') || '[]').find(c => c.id === roleId); if (f2?.base) base = f2.base; }
        } catch { }
        base = base || {};
        const baseInfo = [
            base.name ? `真实名：${base.name}` : '',
            base.gender ? `性别：${base.gender}` : '',
            base.age ? `年龄：${base.age}` : '',
            base.desc ? `人设：${base.desc}` : '',
            base.style ? `说话风格：${base.style}` : '',
            base.secret ? `内心秘密：${base.secret}` : '',
            base.detail ? `详细设定：${base.detail}` : ''
        ].filter(Boolean).join('，');
        const persona = personaBlockFor(profile);

        runTextAdventure(container, {
            title: `${place.name}的事件`, icon: '🔔', placeName: place.name, roleId, profile,
            prompt: `【事件】${ev.text}\n【你的决定】你参与了这件事，无论是被动还是主动，总之，现在你可以自由选择接下来的行动：直接去现场、找人打听、暗中观察、翻阅线索……或是等待。`,

            place: { name: place.name, desc: place.desc || '', ambienceText: placeAmbience(place, new Date().getHours()) },
            charInfo: [
                `${profile.name}（${((profile.aiProfile?.traits) || []).join('、') || '普通居民'}）`,
                baseInfo,
                persona ? `个性登记：${persona}` : ''
            ].filter(Boolean).join('\n'),
            placePresets: presetsTxt,
            placeWorldbook: pc.worldbook || '',
            saveStoryType: 'event', toast,
            onExit: () => renderPlace(container, globalState, onBack, roleId, profile, place.key),   // ★ ✕退出 → 重渲染 → 🎭
            onDone: () => { sessionStorage.removeItem(rk); onReturn && onReturn(); }   // ★ 清文游状态（simCity 侧直接删）
        }, rk);
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// ★ 背包（v1：查看 + 赠送 → 好感修正）
function showBag(container, roleId, profile) {
    const inv = profile.inventory || [];
    const overlay = document.createElement('div');
    overlay.className = 'simcity-pop';
    overlay.innerHTML = `
        <div class="simcity-pop-card">
            <div style="font-weight:700;font-size:15px;margin-bottom:10px;">🎒 背包</div>
            <div class="simcity-pop-list" style="max-height:46vh;overflow-y:auto;">
                ${inv.length ? inv.map((it, i) => `
                    <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #f5f5f5;">
                        <div style="font-size:22px;width:36px;text-align:center;">${it.icon || '📦'}</div>
                        <div style="flex:1;min-width:0;">
                            <div style="font-size:14px;font-weight:600;">${esc(it.name)} ×${it.count}</div>
                            <div style="font-size:11px;color:#999;margin-top:2px;">${esc(it.desc) || '—'}</div>
                        </div>
                        <button class="bag-give" data-i="${i}" style="border:none;border-radius:10px;padding:5px 10px;font-size:12px;background:rgba(124,77,255,0.12);color:#7c4dff;cursor:pointer;">赠送</button>
                    </div>`).join('') : '<div style="text-align:center;color:#999;padding:14px 0;">背包空空如也</div>'}
            </div>
            <button class="simcity-pop-close" id="bagClose">关闭</button>
        </div>`;
    container.appendChild(overlay);
    overlay.querySelector('#bagClose').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelectorAll('.bag-give').forEach(btn => {
        btn.addEventListener('click', async () => {
            const it = inv[parseInt(btn.dataset.i, 10)];
            if (!it) return;
            const presentIds = getPresentAt(placeIndex, getCharCurrentPlace(placeIndex, roleId, new Date().getHours()), new Date().getHours()).filter(id => id !== roleId);
            const targets = await Promise.all(presentIds.map(async id => ({ id, name: charName(id), pf: await getProfile(id) })));
            const friends = targets.filter(t => t.pf && (t.pf.gameFriends || []).some(f => f.id === roleId));
            const opts = [...new Set([...friends.map(t => t.name), ...targets.map(t => t.name)])];
            if (!opts.length) { toast('当前地点没有可赠送的对象', '#e53935'); return; }
            const targetName = await new Promise(res => {
                const pick = document.createElement('div');
                pick.className = 'simcity-pop';
                pick.innerHTML = `<div class="simcity-pop-card">
                    <div style="font-weight:700;font-size:14px;margin-bottom:8px;">赠送「${esc(it.name)}」给谁？</div>
                    <div class="simcity-pop-list">${opts.map((n, i) => `<button class="pick-t" data-i="${i}" style="width:100%;border:none;background:#f5f3fa;border-radius:10px;padding:9px;margin-bottom:6px;font-size:13px;cursor:pointer;">${esc(n)}</button>`).join('')}</div>
                    <button class="simcity-pop-close" id="pickCancel">取消</button>
                </div>`;
                container.appendChild(pick);
                pick.querySelectorAll('.pick-t').forEach(b => b.addEventListener('click', () => { pick.remove(); res(opts[parseInt(b.dataset.i, 10)]); }));
                pick.querySelector('#pickCancel').addEventListener('click', () => { pick.remove(); res(null); });
                pick.addEventListener('click', (e) => { if (e.target === pick) { pick.remove(); res(null); } });
            });
            if (!targetName) return;
            const target = targets.find(t => t.name === targetName);
            if (!target || !target.pf) return;
            const giftMod = Math.min(30, Math.max(1, Math.round((it.price || 50) / 50)));
            const k = pairKeyOf(roleId, target.id);   // ★ 亲密度（共享一份）
            simCityRelations.map = simCityRelations.map || {};
            const r = simCityRelations.map[k] = simCityRelations.map[k] || { score: 0 };
            r.score = Math.max(0, Math.min(100, (r.score || 0) + giftMod));
            await saveSimCityRelations(simCityRelations).catch(() => { });
            it.count -= 1;
            if (it.count <= 0) profile.inventory = profile.inventory.filter(x => x !== it);
            await saveProfile(profile, roleId);
            toast(`🎁 送给 ${esc(targetName)}「${esc(it.name)}」，你们的游戏亲密度 +${giftMod}`, '#7c4dff');
            overlay.remove();
            showBag(container, roleId, profile);
        });
    });
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
            `${jobDisplay(fp)}\n` +
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
        const envUi = uiEnvText(container, placeName);
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
                    `${friendInfo}\n\n此刻你们在${placeName}偶遇（现在是${hour}点）。\n当前环境：${envUi || '（一切照常）'}\n请生成这段偶遇剧情。\n\n` +
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
        const envUi = uiEnvText(container, placeName);
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
                    `现在是${hour}点，${esc(profile.name)}在${placeName}独自散步。\n当前环境：${envUi || '（一切照常）'}\n请生成这段随机剧情。\n\n` +
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

// 结构上预留升级：以后想加天气/节日维度，把数组升级为 { day:[...], rain:[...], ... } 即可
const SIMCITY_AMBIENCES = {
    home: ['阳台上晾着昨晚洗的衣服', '厨房飘着饭菜香', '沙发上有只打盹的猫', '窗外传来邻居家的电视声'],
    shop: ['货架上码得整整齐齐的日用品', '门口的风铃叮当作响', '收银台前摆着糖果和口香糖'],
    hall: ['公告栏贴满了通知', '办事窗口排着队', '大厅的时钟走得很慢'],
    park: ['长椅上坐着晒太阳的老人', '有人在遛一只胖柯基', '喷泉边有小孩在追泡泡'],
    square: ['广场舞的音乐声隐约传来', '鸽子在喷泉边踱步', '有人在发传单'],
    clinic: ['消毒水的味道淡淡的', '候诊室放着健康宣传片', '护士台的小盆栽很精神'],
    fun: ['摩天轮慢慢转着', '旋转木马的旋律循环播放', '棉花糖的甜味飘在空气里'],
    bank: ['号码牌叫到一半就安静了', '点钞机哗啦哗啦响', '门口的石狮子很威严'],
    gallery: ['展墙上的画安静地挂着', '有人在小声讨论笔触', '角落的咖啡机飘着香气'],
    mall: ['橱窗换了新季的陈列', '烤肠的香味从街角飘来', '逛街的人手里都提着袋子'],
    entertain: ['霓虹灯牌一闪一闪', '远处传来游戏厅的音效', '有人在街边弹吉他'],
    school: ['铃声刚响过，走廊安静下来', '操场上有班级在集合', '黑板报刚换了新主题'],
    // ★ 子地点
    mallshop: ['中庭在做促销活动', '电梯口的绿植修剪得很齐'],
    milktea: ['吸管和杯套堆成小山', '排队的人低头刷手机'],
    restaurant: ['后厨传来锅铲的叮当声', '邻桌的菜闻着很香'],
    agency: ['墙上贴满了房源照片', '桌上的户型图翻得卷了边'],
    arcade: ['街机按钮被拍得啪啪响', '抓娃娃机前围了一圈人'],
    ktv: ['走廊里飘着跑调的歌声', '前台堆着果盘和爆米花'],
    bar: ['吧台后的酒瓶亮晶晶的', '音乐声刚好盖过谈话声'],
    teach: ['走廊尽头有背书声', '楼梯间的窗户透进阳光'],
    playground: ['跑道上有人在刷圈', '球场的欢呼声此起彼伏'],
};


// ============================================================
//  小城世界状态（天气 + 当日见闻 + 行动随机事件；世界级共享，跨天刷新）
// ============================================================
const SIMCITY_WEATHERS = [
    { key: 'sunny', icon: '☀️', name: '晴', desc: '阳光正好', prompt: '今天是个大晴天' },
    { key: 'cloudy', icon: '☁️', name: '多云', desc: '云层慢慢飘', prompt: '今天多云，云层压得很低' },
    { key: 'rain', icon: '🌧️', name: '雨', desc: '雨丝绵绵', prompt: '今天下着雨，空气湿漉漉的' },
    { key: 'snow', icon: '❄️', name: '雪', desc: '雪花纷飞', prompt: '今天下雪了，屋顶都白了' },
    { key: 'fog', icon: '🌫️', name: '雾', desc: '雾气朦胧', prompt: '今天起了大雾，远处看不真切' },
];
const SIMCITY_WEATHER_WEIGHTS = [30, 25, 20, 5, 10];   // 晴/多云/雨/雪/雾 权重

// 当日见闻池（生成时随机挑 1~2 条，当天固定）
const SIMCITY_NEWS_POOL = [
    { icon: '🎪', title: '中心广场办起了跳蚤市场', desc: '旧货、手作、小吃摊，人气很旺' },
    { icon: '🐱', title: '公园来了一只流浪猫', desc: '橘色的，特别亲人，总有人带小鱼干去喂' },
    { icon: '🧋', title: '奶茶店出了新品', desc: '桂花乌龙拿铁，据说要排队半小时' },
    { icon: '🏛️', title: '市政厅要办招聘会', desc: '下周在一楼大厅，想换工作的可以去看看' },
    { icon: '🎡', title: '游乐场新装了一台摩天轮', desc: '晚上灯光特别好看，成了新的打卡点' },
    { icon: '🖼️', title: '画廊在展一位本地画家的画', desc: '画的是小城的四季，很值得一看' },
    { icon: '🏪', title: '杂货店进了新货', desc: '听说有稀有的零食和贴纸盲盒' },
    { icon: '🎤', title: '娱乐街KTV在搞活动', desc: '包夜打折，麦霸们已经摩拳擦掌' },
    { icon: '📚', title: '学校在办露天读书会', desc: '操场边摆了长桌，欢迎来蹭书看' },
    { icon: '🌳', title: '公园的樱花开了', desc: '风一吹就是一场花瓣雨' },
];

// 行动后小概率随机事件（世界惊喜感）
const SIMCITY_RANDOM_EVENTS = [
    { text: '🍀 路上捡到一枚幸运硬币，+5 金币', money: 5 },
    { text: '🐦 一只小鸟落在肩头，心情好了不少', mood: 5 },
    { text: '📣 有人塞给你一张新店折扣券', mood: 3 },
    { text: '👋 路过的居民热情地跟你打了个招呼', mood: 4 },
    { text: '🥧 邻居分给你一块刚烤好的点心', mood: 6, energy: 5 },
    { text: '💤 忙里偷闲打了个小盹，精神了些', energy: 8 },
    { text: '💸 裤兜破了个洞，掉了 5 金币', money: -5, mood: -4 },
    { text: '🌧️ 突降一阵雨，你一路小跑躲进屋檐', mood: -3 },
];

// ============================================================
//  职业互动（事件池 + 成长 + 状态栏 + 自定义字段；全角色同规则）
// ============================================================
const JOB_ICONS = { 'hall-hall-clerk': '📋', 'mall-mallshop-owner': '🛍️', 'mall-restaurant-chef': '🍳', 'mall-milktea-barista': '🧋', 'entertain-ktv-singer': '🎤', 'school-teach-teacher': '📚', 'school-student': '🎒', 'clinic-clinic-doctor': '🩺', 'clinic-clinic-nurse': '💊' };
function jobIcon(jobKey) { return JOB_ICONS[jobKey] || '💼'; }

// 职业经验：profile.career = { jobKey: exp }，level 派生 = 1+floor(exp/100)；换职业旧经验保留
function careerLevel(exp) { return 1 + Math.floor((exp || 0) / 100); }
function careerTotalExp(profile) { return Object.values(profile.career || {}).reduce((s, v) => s + (v || 0), 0); }

// 特殊属性描述（prompt 注入用）
function customDesc(p) {
    const c = p.custom || {};
    const keys = Object.keys(c);
    if (!keys.length) return '';
    return keys.map(k => {
        const v = c[k];
        if (v === true) return k;
        if (v === false) return '不' + k;
        return `${k}：${v}`;
    }).join('、');
}

// 是否此刻在岗（全角色一致：职位定义决定"工作地点"，行程表决定"此刻在岗"）
// 主视角主动点击触发；AI 角色未来自发逻辑走同一函数——都用 ta 自己的 schedule 判断
function careerWorkHere(profile, placeKey, subKey) {
    const j = profile.jobKey && getJob(profile.jobKey);
    if (!j) return null;
    // ① 该地点是职业定义的上班地点（JOB_DEFS 是唯一职业源，不算额外维护）
    if (j.subKey ? (j.subKey !== subKey) : (j.placeKey !== placeKey || subKey)) return null;
    // ② 此刻行程也安排在这里（schedule 驱动"在岗"，与 AI 角色行为驱动一致）
    const entry = curScheduleEntry(profile.schedule, new Date().getHours());
    if (!entry || !entry.place) return null;
    const hereName = subKey ? (findPlace(subKey)?.name || '') : (findPlace(placeKey)?.name || '');
    return entry.place === hereName ? j : null;
}

// 职业互动事件池：混合"奖金型"和"平淡型"（只给exp）——点击必有反馈，金钱非固定产出，不破坏工资平衡
const SIMCITY_WORK_EVENTS = {
    'hall-hall-clerk': [
        { text: '处理完一摞棘手公文，被科长表扬 +10', money: 10, exp: 10 },
        { text: '开会开到一半溜去泡了杯茶', mood: 5, exp: 6 },
        { text: '打印了一下午文件，按部就班', exp: 8 }
    ],
    'mall-mallshop-owner': [
        { text: '大客户一口气买了三件，+20', money: 20, exp: 12 },
        { text: '补货搬箱子，出了一身汗', energy: -10, exp: 8 },
        { text: '理了理货架，平平淡淡的一天', exp: 8 }
    ],
    'mall-restaurant-chef': [
        { text: '招牌菜被客人点赞，收到小费 +15', money: 15, exp: 12 },
        { text: '试菜试到打饱嗝', mood: 6, exp: 8 },
        { text: '备料忙到手忙脚乱', exp: 8 }
    ],
    'mall-milktea-barista': [
        { text: '新品被夸好喝，客人多给了小费 +10', money: 10, exp: 10 },
        { text: '偷喝了一口珍珠，被店长抓个正着', mood: -3, exp: 6 },
        { text: '打了一杯完美奶泡', exp: 8 }
    ],
    'entertain-ktv-singer': [
        { text: '唱完被观众打赏 +20', money: 20, exp: 12 },
        { text: '和搭档合唱了一首，很合拍', mood: 8, exp: 10 },
        { text: '调设备练了一晚', exp: 8 }
    ],
    'school-teach-teacher': [
        { text: '学生考试进步，很有成就感', mood: 8, exp: 12 },
        { text: '讲了一节精彩的课', exp: 10 },
        { text: '批改作业到眼冒金星', energy: -10, exp: 8 }
    ],
    'school-student': [
        { text: '自习刷了一套题，思路清晰', exp: 12 },
        { text: '和同学讨论问题，豁然开朗', mood: 6, exp: 10 },
        { text: '上课打了会儿瞌睡', mood: -3, exp: 4 }
    ],
    'clinic-clinic-doctor': [
        { text: '来了个急诊，处理完收到加班费 +25', money: 25, exp: 15 },
        { text: '给小朋友打针，家长连声道谢', mood: 8, exp: 10 },
        { text: '普通门诊日，按部就班看完了号', exp: 8 }
    ],
    'clinic-clinic-nurse': [
        { text: '帮医生打下手，忙得脚不沾地 +15', money: 15, exp: 12 },
        { text: '给病人分药，被夸温柔', mood: 8, exp: 10 },
        { text: '整理病房，平平常常的一天', exp: 8 }
    ],
    default: [{ text: '认真工作了一天', exp: 8 }]
};
function rollWorkEvent(jobKey) {
    const pool = SIMCITY_WORK_EVENTS[jobKey] || SIMCITY_WORK_EVENTS.default;
    return pool[Math.floor(Math.random() * pool.length)];
}

// 执行一次职业工作（主视角主动点击触发；AI 角色未来走同一函数）
async function doCareerWork(container, globalState, onBack, roleId, profile, jobDef, afterRender) {
    if (profile.energy < 15) { toast('⚡ 体力不足，先去休息吧', '#ff9800'); return; }
    profile.energy -= 15;
    const evt = rollWorkEvent(jobDef.key);
    if (evt.money) profile.money = Math.max(0, (profile.money || 0) + evt.money);
    if (evt.mood) profile.mood = Math.min(100, Math.max(0, (profile.mood || 50) + evt.mood));
    if (evt.energy) profile.energy = Math.min(100, Math.max(0, profile.energy + evt.energy));
    const gain = evt.exp || 8;
    profile.career = profile.career || {};
    const before = Math.floor((profile.career[jobDef.key] || 0) / 100);
    profile.career[jobDef.key] = (profile.career[jobDef.key] || 0) + gain;
    const after = Math.floor(profile.career[jobDef.key] / 100);
    await saveProfile(profile, roleId);
    if (after > before) {
        const lvl = after + 1;
        profile.money = (profile.money || 0) + 30;
        await saveProfile(profile, roleId);
        await addMemento(roleId, profile, { type: 'career_up', title: `🎉 ${jobDef.name} 晋升 Lv${lvl}`, comment: `在${jobDef.name}晋升到 Lv${lvl}，获得奖励 +30 金币`, createdAt: Date.now() });
        toast(`🎉 ${jobIcon(jobDef.key)} ${jobDef.name} 升到 Lv${lvl}！奖励 +30`, '#7c4dff');
    } else {
        toast(`${jobIcon(jobDef.key)} ${evt.text}`, evt.money ? '#2e7d32' : '#555');
    }
    (afterRender || renderMain)(container, globalState, onBack, roleId, profile);
}

// 角色状态侧边抽屉（点击头像进入；任何角色切换后都能看自己的状态，规则一致）
function showCharSheet(container, globalState, onBack, roleId, profile) {
    const overlay = document.createElement('div');
    overlay.className = 'simcity-pop';
    overlay.style.justifyContent = 'flex-end';
    const careerEntries = Object.entries(profile.career || {})
        .map(([k, exp]) => ({ key: k, job: getJob(k), exp: exp || 0 }))
        .sort((a, b) => b.exp - a.exp);
    const totalExp = careerEntries.reduce((s, e) => s + e.exp, 0);
    const custom = profile.custom || {};
    const customHtml = Object.keys(custom).length
        ? Object.entries(custom).map(([k, v]) => {
            const label = v === true ? k : (v === false ? '不' + k : `${k}：${v}`);
            return `<span class="sc-tag">${esc(label)}</span>`;
        }).join('')
        : '<div class="sc-empty">暂无特殊属性</div>';
    const propsHtml = (profile.properties || []).length
        ? profile.properties.map(p => `<div class="sc-prop">${esc(p.name)} <small>${esc(p.area || '')}</small></div>`).join('')
        : '<div class="sc-empty">暂无房产</div>';
    // ★ 成就（预留）：数据字段 achievements 待后续版本填充；有数据就展示，没有则显示规划占位
    const achHtml = (profile.achievements || []).length
        ? profile.achievements.map(a => `<div class="sc-mem">${esc(a.name || a.text || a.title || '')}</div>`).join('')
        : '<div class="sc-mem" style="text-align:center;">🏗️ 成就系统规划中，敬请期待</div>';
    const careerHtml = careerEntries.length
        ? careerEntries.map(e => {
            const lvl = careerLevel(e.exp);
            return `<div class="sc-career">
                <div class="sc-career-hd">${jobIcon(e.key)} ${esc(e.job ? e.job.name : e.key)} <span class="sc-lv">Lv${lvl}</span></div>
                <div class="sc-career-bar"><i style="width:${e.exp % 100}%"></i></div>
                <div class="sc-career-exp">${e.exp} exp · 距下一级 ${100 - (e.exp % 100)}</div>
            </div>`;
        }).join('')
        : '<div class="sc-empty">尚未工作过（去上班地点入职后开始积累经验）</div>';
    overlay.innerHTML = `
        <div class="simcity-sheet">
            <div class="sc-sheet-hd">
                <div class="avatar">${getAvatarHtml(roleId)}</div>
                <div style="flex:1;">
                    <div class="sc-sheet-name">${esc(profile.name)}</div>
                    <div class="sc-sheet-job">${jobIcon(profile.jobKey)} ${esc(jobDisplay(profile))} · 已入住 ${Math.floor((Date.now() - profile.createdAt) / 86400000) + 1} 天</div>
                </div>
                <button class="cc-close" id="sheetClose">✕</button>
            </div>
            <div class="sc-sheet-body">
                <div class="sc-sec">
                    <div class="sc-sec-hd">📊 属性</div>
                    <div class="sc-stats">
                        <div class="sc-stat"><span>💰 金钱</span><b>${profile.money || 0}</b></div>
                        <div class="sc-stat"><span>🏦 存款</span><b>${profile.savings || 0}</b></div>
                    </div>
                    <div class="sc-bar-row"><span>⚡ 体力 ${profile.energy || 0}</span><div class="sc-bar"><i style="width:${Math.max(0, Math.min(100, profile.energy || 0))}%"></i></div></div>
                    <div class="sc-bar-row"><span>😊 心情 ${profile.mood || 0}</span><div class="sc-bar mood"><i style="width:${Math.max(0, Math.min(100, profile.mood || 0))}%"></i></div></div>
                </div>
                <div class="sc-sec">
                    <div class="sc-sec-hd">💼 职业履历 <small>总工龄 ${totalExp} exp</small></div>
                    ${careerHtml}
                </div>
                <div class="sc-sec">
                    <div class="sc-sec-hd">🏠 房产</div>
                    ${propsHtml}
                </div>
                <div class="sc-sec">
                    <div class="sc-sec-hd">🏷️ 世界观标签</div>
                    <div class="sc-tags">${(profile.ip || []).length ? (profile.ip || []).map(t => `<span class="sc-tag">${esc(t)}</span>`).join('') : '<div class="sc-empty">暂无标签</div>'}</div>
                </div>

                <div class="sc-sec">
                    <div class="sc-sec-hd">✨ 特殊属性</div>
                    <div class="sc-tags">${customHtml}</div>
                </div>
                <div class="sc-sec">
                    <div class="sc-sec-hd">🏆 成就 <small>规划中</small></div>
                    ${achHtml}
                </div>
                <div class="sc-sec">
                    <div class="sc-sec-hd">🎁 兑换 <small>测试</small></div>
                    <div style="font-size:12px;color:#999;margin-bottom:6px;">输入测试兑换码领取金币</div>
                    <input id="redeemInput" placeholder="如 GOLD9999" style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:10px;border:1px solid rgba(124,77,255,0.2);background:#f7f5fc;font-size:13px;outline:none;" />
                    <button id="redeemBtn" style="width:100%;margin-top:8px;padding:9px;border-radius:10px;border:none;background:rgba(124,77,255,0.12);color:#7c4dff;font-size:13px;cursor:pointer;">🎁 兑换</button>
                </div>
            </div>
        </div>`;
    // ★ 测试兑换码（正式发布前移除）
    overlay.querySelector('#redeemBtn').addEventListener('click', () => {
        const code = (overlay.querySelector('#redeemInput').value || '').trim().toUpperCase();
        if (REDEEM_CODES[code]) {
            profile.money = (profile.money || 0) + REDEEM_CODES[code];
            saveProfile(profile, roleId).then(() => {
                toast(`🎁 兑换成功，+${REDEEM_CODES[code]} 金币`, '#2e7d32');
                overlay.remove();
            });
        } else {
            toast('❌ 兑换码无效', '#e53935');
        }
    });

    overlay.querySelector('#sheetClose').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    container.appendChild(overlay);
}

// ============================================================
//  地图日夜更替（时段 class 切换，分钟级自清理定时器）
// ============================================================
// 室外地点（随日夜变化；室内地点保持恒定暖光）
const SIMCITY_OUTDOOR = ['park', 'square', 'fun', 'playground', 'mall', 'entertain', 'school'];

function simCityPeriodClass(hour) {
    if (hour >= 5 && hour < 7) return 'sc-dawn';    // 清晨 5-7
    if (hour >= 7 && hour < 17) return 'sc-day';    // 白天 7-17
    if (hour >= 17 && hour < 19) return 'sc-dusk';  // 黄昏 17-19
    return 'sc-night';                              // 夜晚 19-5
}

let simCityDayNightTimer = null;
function startDayNightCycle(container) {
    if (simCityDayNightTimer) { clearInterval(simCityDayNightTimer); simCityDayNightTimer = null; }
    const apply = () => {
        const root = container.querySelector('.simcity-root');
        if (!root) {   // 页面已销毁 → 自清理
            clearInterval(simCityDayNightTimer);
            simCityDayNightTimer = null;
            return;
        }
        const cls = simCityPeriodClass(new Date().getHours());
        root.classList.remove('sc-dawn', 'sc-day', 'sc-dusk', 'sc-night');
        root.classList.add(cls);
    };
    apply();
    simCityDayNightTimer = setInterval(apply, 60000);
}


let simCityWorld = null;   // 模块级缓存：{ date, weather, news }
let simCityEstates = { estates: [] };   // ★ 私人地产注册表缓存（世界级共享）


function pickSimCityWeather() {
    let total = 0;
    for (const w of SIMCITY_WEATHER_WEIGHTS) total += w;
    let r = Math.random() * total;
    for (let i = 0; i < SIMCITY_WEATHERS.length; i++) {
        r -= SIMCITY_WEATHER_WEIGHTS[i];
        if (r < 0) return SIMCITY_WEATHERS[i].key;
    }
    return 'sunny';
}

function pickSimCityNews() {
    const pool = [...SIMCITY_NEWS_POOL];
    const n = 1 + (Math.random() < 0.4 ? 1 : 0);   // 60% 一条 / 40% 两条
    const out = [];
    while (out.length < n && pool.length) {
        out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    return out;
}

// ★ 动态事件池：AI对话产出的流言/传闻/新闻（跨天保留，靠上限15条自然代谢；衰减后续优化）
const EVENT_ICON = { rumor: '🗣️', gossip: '💬', news: '📰' };
const EVENT_TYPE = { '流言': 'rumor', '传闻': 'gossip', '新闻': 'news' };

// 写入全局事件池（去重加热；超15条删最旧）；返回是否变更
function addWorldEvent(type, text, source, place) {
    const w = simCityWorld;
    if (!w) return false;
    if (!w.events) w.events = [];
    const key = EVENT_TYPE[type] || 'gossip';
    const t = String(text || '').trim();
    if (t.length < 4) return false;
    const hit = w.events.find(e => e.text === t || e.text.includes(t) || t.includes(e.text));
    if (hit) { hit.heat = (hit.heat || 1) + 1; hit.ts = Date.now(); return true; }
    w.events.push({ type: key, text: t, source: source || '', place: place || '', ts: Date.now(), heat: 1 });
    if (w.events.length > 15) w.events.shift();
    return true;
}

// 进小城时确保当天世界状态（跨天自动刷新并写库）
async function ensureSimCityWorld() {
    const today = dayStr(new Date());
    let w = await getSimCityWorld().catch(() => null);
    if (!w || w.date !== today) {
        const oldEvents = (w && w.events) || [];        // ★ 跨天保留事件池（衰减后续优化）
        w = { date: today, weather: pickSimCityWeather(), news: pickSimCityNews(), events: oldEvents };
        await saveSimCityWorld(w).catch(() => { });
    }
    simCityWorld = w;
    return w;
}

// 世界状态文本（聊天 prompt 注入用）
function simCityWorldText() {
    const w = simCityWorld;
    if (!w) return '';
    const wd = SIMCITY_WEATHERS.find(x => x.key === w.weather);
    const parts = [];
    if (wd) parts.push(`${wd.icon}天气：${wd.name}（${wd.prompt}）`);
    if (w.news && w.news.length) parts.push(`今日见闻：${w.news.map(n => `${n.icon}${n.title}`).join('、')}`);
    // ★ 动态事件池（流言/传闻/新闻）：按热度+时间取top3（跨天保留，靠上限自然代谢）
    if (w.events && w.events.length) {
        const top = [...w.events].sort((a, b) => (b.heat || 1) - (a.heat || 1) || b.ts - a.ts).slice(0, 3);
        parts.push('小城动静：' + top.map(e => `${EVENT_ICON[e.type] || '💬'}「${e.text}」`).join('；'));
    }
    return parts.join('\n');
}

//  文游注册表
async function loadAdventures() {
    advEndedNotice = {};
    simCityAdvRegistry = (await getSimCityAdventures().catch(() => null)) || { adventures: [] };
    simCityAdvCache = {};   // ★ 全文不进内存，按需读
    return simCityAdvRegistry;
}

// ★ 按需批量加载文游全文（渲染文游相关页面前调用；已缓存跳过）
async function ensureAdvLoaded(ids) {
    const need = [...new Set((ids || []).filter(id => id && !simCityAdvCache[id]))];
    for (const id of need) {
        const adv = await getAdventure(id).catch(() => null);
        if (adv) { adv.sessionRounds = (adv.turns || []).length; simCityAdvCache[id] = adv; }
    }
}
async function saveAdvRegistry() { return saveSimCityAdventures(simCityAdvRegistry); }

// ============================================================
//  私人地产（世界级注册表：目标/进度/共建；建设中/建成=同一地点焕新）
// ============================================================
async function loadEstates() {
    simCityEstates = (await getSimCityEstates().catch(() => null)) || { estates: [] };
    return simCityEstates;
}
async function saveEstates() { return saveSimCityEstates(simCityEstates); }

// 可见性：参与过 → 必见；建设中 → 仅参与者；建成 → 同IP标签 / 行程表包含（或其子地点）
function canSeeEstate(roleId, profile, estate) {
    if (estate.owner === roleId || (estate.contributors || []).includes(roleId)) return true;
    if (estate.status !== 'built') return false;
    const myIp = (profile.ip || []).map(x => String(x).toLowerCase());
    if ((estate.ip || []).some(t => myIp.includes(String(t).toLowerCase()))) return true;
    const sched = new Set((profile.schedule || []).map(s => s.place));
    if (sched.has(estate.name)) return true;
    if ((estate.subs || []).some(s => sched.has(s.name))) return true;
    return false;
}

// ★ 子地点显示名：全名（"冬木市-柳洞寺"）→ 纯名（"柳洞寺"）显示
function subDisplayName(name) {
    const s = String(name || '');
    return s.includes('-') ? s.split('-').pop() : s;
}

// ★ 动态地点：静态 PLACES 找不到时，查建成地产（转成 place 结构，与主地点同构）
function getPlace(placeKey) {
    const p = PLACES.find(x => x.key === placeKey);
    if (p) return p;
    // ① 建成地产本体
    const e = (simCityEstates?.estates || []).find(x => x.status === 'built' && x.id === placeKey);
    if (e) {
        return {
            key: e.id, name: e.name, icon: e.icon || '🏰',
            btn: e.btn || '开始互动',
            act: 'rest', desc: e.desc || '',
            residential: e.residential,   // ★ 加这行            
            vibes: e.ambient || [],
            shop: e.shopId ? simCityShops[e.shopId] : null,   // ★ 商店直接挂地点对象
            estate: e,
            subs: (e.subs || []).map(s => ({ ...s, key: s.key, parent: e.id, icon: s.icon || '🏛️', act: s.act || 'rest', desc: s.desc || '' }))
        };
    }
    // ② 动态子地点（建成地产的 subs）
    for (const est of (simCityEstates?.estates || [])) {
        if (est.status !== 'built') continue;
        const s = (est.subs || []).find(x => x.key === placeKey);
        if (s) return {
            key: s.key, name: s.name, icon: s.icon || '🏛️',
            btn: s.btn || '进入',
            act: s.act || 'rest',
            desc: s.desc || '',
            residential: s.residential,
            parent: est.id, subs: [],
            shop: s.shopId ? simCityShops[s.shopId] : null,
            estate: est
        };
    }
    return null;
}

// ★ 动态职业：JOB_DEFS 找不到时，查建成地产的职业；支持"地点-子地点-职位"组合名解析（歧义时返回 null）
function getJob(jobKey) {
    if (typeof jobKey === 'string') {
        jobKey = jobKey.replace(/（[^）]*）$/g, '').trim();   // ★ 剥离尾部"（时薪32）"等说明
    }
    if (JOB_DEFS[jobKey]) return { ...JOB_DEFS[jobKey], key: jobKey };
    const hits = [];   // ★ 组合/名字匹配收集（歧义保护：>1 返回 null）
    // 静态：纯名 / 中文组合（"教师"、"学校-教师"、"学校-教学楼-教师"）
    for (const [k, j] of Object.entries(JOB_DEFS)) {
        const pn = (PLACES.find(p => p.key === j.placeKey) || {}).name || j.placeKey;
        const sn = j.subKey ? ((PLACES.find(p => p.key === j.subKey) || {}).name || j.subKey) : '';
        if (j.name === jobKey || `${pn}-${j.name}` === jobKey || (sn && `${pn}-${sn}-${j.name}` === jobKey)) hits.push({ ...j, key: k });
    }
    const ests = (simCityEstates?.estates || []).filter(e => e.status === 'built');
    for (const e of ests) {
        const j = (e.jobs || []).find(x => x.key === jobKey);
        if (j) return j;   // key 精确命中（est_job_xxx_0）唯一，直接返回
    }
    for (const e of ests) {
        for (const j of (e.jobs || [])) {
            const subName = (e.subs || []).find(s => s.key === j.subKey)?.name || '';   // ★ 全名"冬木市-柳洞寺"
            if (jobKey === j.name || jobKey === `${subName}-${j.name}` || (e.name && jobKey === `${e.name}-${j.name}`)) hits.push(j);
        }
    }
    return hits.length === 1 ? hits[0] : null;   // ★ 歧义（>1）或找不到（0）→ null
}

// 某地点的所有职位（静态 JOB_DEFS + 动态建成地产职业）
function jobsAt(placeKey, subKey = '') {
    const list = [];
    for (const [k, j] of Object.entries(JOB_DEFS)) if (j.placeKey === placeKey && (j.subKey || '') === subKey) list.push({ ...j, key: k });
    for (const e of (simCityEstates?.estates || [])) {
        if (e.status !== 'built') continue;
        for (const j of (e.jobs || [])) if (j.placeKey === placeKey && (j.subKey || '') === subKey) list.push(j);
    }
    return list;
}

// 行动后小概率随机事件（14% 触发，返回 null 表示无事发生）
//   profile 传入时：优先"与该角色相关"的事件（roles 命中名字 / tags 命中角色标签）；
//   无相关事件时排除"指定给他人"的条目，只从通用条目取；再无通用条目才回退全局池
function simCityRandomEvent(placeKey, profile) {
    if (Math.random() >= 0.14) return null;
    const dyn = placeKey ? estateAmbienceAt(placeKey) : null;   // ★ 动态地产：用地点专属事件池
    let pool = (dyn && dyn.events && dyn.events.length) ? dyn.events : SIMCITY_RANDOM_EVENTS;
    if (profile) {
        const related = pool.filter(ev =>
            (ev.roles && ev.roles.includes(profile.name)) ||
            (ev.tags && ev.tags.length && (profile.tags || []).some(t => ev.tags.includes(t)))
        );
        if (related.length) {
            pool = related;
        } else {
            const generic = pool.filter(ev => !ev.roles && !ev.tags);
            if (generic.length) pool = generic;
        }
    }
    return pool[Math.floor(Math.random() * pool.length)];
}

// 主城顶部横幅：天气 + 今日见闻（无则返回空串）
function simCityWorldBarHtml() {
    const w = simCityWorld;
    if (!w) return '';
    const wd = SIMCITY_WEATHERS.find(x => x.key === w.weather);
    const weatherHtml = wd ? `<span>${wd.icon} ${wd.name} · ${wd.desc}</span>` : '';
    const newsHtml = (w.news || []).slice(0, 2).map(n => `<span class="sw-news">📰 ${n.icon} ${esc(n.title)}</span>`).join('');
    if (!weatherHtml && !newsHtml) return '';
    return `<div class="simcity-weather-bar">${weatherHtml}${newsHtml}</div>`;
}

// 夜生活事件：夜间在夜场触发的 AI 小剧情（复用路人剧情模式）
const NIGHT_SPOTS = ['bar', 'ktv', 'arcade', 'playground'];

// 夜场档案：icon + 随机事件池（仅AI提示词可见，UI不显示）+ 场所设定（环境卡用）
const NIGHT_SCENES = {
    bar: {
        icon: '🍸',
        events: [
            '吧台边一个西装革履的男人独自喝着威士忌，眼神疲惫，在你坐下时他抬了抬下巴算是打过招呼',
            '有人喝多了，把整桌人的酒都点成了同一款，然后神秘兮兮地说"这杯我请"',
            '驻唱唱到一半突然忘词，全场善意地起哄，他红着脸即兴编了一句',
        ],
        prompt: '深夜的酒吧：灯光昏黄，吧台后有调酒师，人们微醺低声交谈，偶尔有人上台唱两首——这是个社交与微醺的场子',
    },
    ktv: {
        icon: '🎤',
        events: [
            '隔壁包间有人推门探出半个身子，醉醺醺地问你是不是走错了门，然后大笑关上门',
            '点歌台前两个人为了谁先唱吵得面红耳赤，最后石头剪刀布解决',
            '角落里一个女孩抱着麦克风唱哭了自己，又哭着笑说没事',
        ],
        prompt: '深夜的KTV：隔音门漏出跑调的合唱，麦霸抢麦，点歌台前有人纠结——这是个宣泄与尽兴的场子',
    },
    arcade: {
        icon: '🕹️',
        events: [
            '一个小孩在格斗机前连输十局，扭头眼巴巴看着你，欲言又止',
            '有人在音游机上刷新了纪录，激动得原地蹦了起来，又假装若无其事',
            '投币口卡住了硬币，旁边的人正用指甲盖一点一点往外抠',
        ],
        prompt: '深夜的游戏厅：屏幕荧光、机台叮当，有人反复挑战最高分——这是个竞技与执念的场子',
    },
    playground: {
        icon: '🏟️',
        events: [
            '跑道上夜跑的人在你身边停下，喘着气问你"你也常来？"',
            '看台上躺着的人突然坐起来，指着星星说"那颗是木星"',
            '一只狗挣脱绳子冲到你面前，绕着你转了两圈又跑回主人身边',
        ],
        prompt: '深夜的操场：路灯下的跑道，看台上躺着看星星的人——这是个独处与放空的场子',
    },
};


async function showNightEvent(container, roleId, profile, placeName, subKey) {
    const hour = new Date().getHours();
    const ns = NIGHT_SCENES[subKey];
    const events = ns?.events || [];
    const event = events.length ? events[Math.floor(Math.random() * events.length)] : `深夜的${placeName}，安静得能听见自己的脚步声`;
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
                    `现在是深夜${hour}点，${esc(profile.name)}在${esc(placeName)}。\n${event}\n${scene.prompt}\n请生成这段夜生活小插曲。\n\n` +
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
// aiMsgs: [{ from: 角色id, text: 该角色说的话, noAction?: true（未锁定到在场者，跳过动作）}]
async function applyCityActions(aiMsgs, roleId, profile, participants, shopCfg) {
    const done = [];
    const today = dayStr(new Date());
    for (const ai of aiMsgs) {
        if (ai.noAction) continue;   // ★ 未锁定到在场者：不当无事发生
        const speakerId = ai.from;
        const speakerName = charName(speakerId);
        const t = ai.text || '';

        // ① 加好友：说话人 → 目标（默认主视角；可 @游戏名 指定任意在场者），双向写入
        const fm = t.match(/【加好友(?:[@：:]\s*([^】\s]{1,8}))?】/);
        if (fm) {
            const targetName = (fm[1] || '').trim();
            // ★ 目标锁定：只在当前对话参与者里按游戏名匹配（不依赖真实名模块）
            let targetId = roleId;
            if (targetName) {
                const found = participants.find(pid => pid !== speakerId && charName(pid) === targetName);
                if (!found) continue;                 // 锁定失败：无事发生，不报错
                targetId = found;
            }
            if (targetId === speakerId) continue;     // 不能和自己加好友
            const sp = await getProfile(speakerId);
            const tp = targetId === roleId ? profile : await getProfile(targetId);
            if (!sp || !tp) continue;
            const tName = charName(targetId);          // 游戏名显示
            const sg = sp.gameFriends || [];
            if (!sg.some(f => f.id === targetId)) {
                sg.push({ id: targetId, name: tName });
                sp.gameFriends = sg;
                await saveProfile(sp, speakerId);
            }
            const tg = tp.gameFriends || [];
            if (!tg.some(f => f.id === speakerId)) {
                tg.push({ id: speakerId, name: speakerName });
                tp.gameFriends = tg;
                await saveProfile(tp, targetId === roleId ? roleId : targetId);
            }
            done.push(`🤝 ${speakerName} 和 ${tName} 已互为游戏好友`);
        }

        // ③ 好感修正：说话人 → 目标（默认主视角；可 @游戏名 指定任意在场者），单向写各自档案（-200~200）
        const rm = t.match(/【好感\s*([+-]?\d{1,3})\s*(?:[@：:]\s*([^】\s]{1,8}))?】/);
        if (rm) {
            const delta = Math.max(-200, Math.min(200, parseInt(rm[1], 10) || 0));
            if (!delta) continue;
            const targetName = (rm[2] || '').trim();
            let targetId = roleId;
            if (targetName) {
                const found = participants.find(pid => pid !== speakerId && charName(pid) === targetName);
                if (!found) continue;
                targetId = found;
            }
            if (targetId === speakerId) continue;
            const sp = await getProfile(speakerId);
            if (!sp) continue;
            sp.relationMods = sp.relationMods || {};
            sp.relationMods[targetId] = Math.max(-200, Math.min(200, (sp.relationMods[targetId] || 0) + delta));
            await saveProfile(sp, speakerId);
            done.push(`💗 ${speakerName} 对 ${charName(targetId)} 好感修正 ${delta > 0 ? '+' : ''}${delta}`);
        }
        // ④ 购买：说话人 → 当前对话地点商店（AI 自主购买；【购买@商品名】）
        const buyM = t.match(/【购买@([^】\s]{1,12})】/);
        if (buyM && shopCfg) {
            const sp = await getProfile(speakerId);
            if (sp) {
                const r = await buyItem(sp, speakerId, shopCfg.estate, shopCfg.shop, buyM[1].trim());
                done.push(r.ok ? `🛒 ${speakerName}${r.msg}` : `🚫 ${speakerName}${r.msg}`);
            }
        }

        // ② 约定（临时 / 永久）→ 写说话人自己的档案
        const m = t.match(/【约定】(\d{1,2})[:：](\d{0,2})(?:[，, ]+(.{2,8}))?/);
        if (m) {
            const time = `${String(parseInt(m[1])).padStart(2, '0')}:00`;
            // ★ TDZ 修复：先取说话人档案（normalizePlaceName 需要 fp 判断地产可见性，用说话人视角）
            const fp = await getProfile(speakerId);
            const place = fp ? normalizePlaceName((m[3] || '').trim(), speakerId, fp) : '';
            if (fp && place) {
                // ★ 可达性过滤：说话人必须认识路（家/职业/日程/可见地产），否则婉拒不写入
                if (!knownPlaceNames(fp, speakerId).includes(place)) {
                    done.push(`🚫 ${speakerName}不认识路（${place}），婉拒了约定`);
                } else if (t.includes('【永久】')) {
                    const sched = [...(fp.schedule || [])];
                    sched.push({ time, place, act: `与${profile.name}的约定` });
                    sched.sort((a, b) => String(a.time).localeCompare(String(b.time)));
                    fp.schedule = sched;
                    await saveProfile(fp, speakerId);
                    done.push(`📅 ${speakerName}永久日程：${time} 在${place}`);
                } else {
                    fp.appointments = [...(fp.appointments || []), { date: today, time, place, act: `与${profile.name}的约定` }];
                    await saveProfile(fp, speakerId);
                    done.push(`⏰ ${speakerName}临时约定：今天${time} 在${place}`);
                }
                upsertCharPlaceIndex(placeIndex, fp, today, speakerId);   // ★ 说话人赴约即时生效
            }
        }
    }
    return done;
}

// 执行 AI 回复里的事件产出（流言/传闻/新闻 → 全局事件池）
async function applyEventActions(aiMsgs, placeName) {
    let changed = false;
    for (const ai of aiMsgs) {
        const em = (ai.text || '').match(/【事件：([流言传闻新闻]+)】(.{4,60}?)(?=【|$)/);
        if (em && addWorldEvent(em[1], em[2].trim(), charName(ai.from), placeName)) changed = true;
    }
    if (changed && simCityWorld) await saveSimCityWorld(simCityWorld).catch(() => { });
}

// ★ 剥离事件标记（AI输出的事件元信息不进入对话文本；事件本身已在 applyEventActions 入库）
function stripEventMarkers(text) {
    return (text || '').replace(/【事件：[流言传闻新闻]+】.{4,60}?(?=【|$)/g, '').trim();
}

// ★ 是否在休息时段（读 AI 的 rest 字段：如"23:00~07:00"）
function isResting(fp, hour) {
    const r = fp && fp.rest;
    if (!r || isNaN(r.from) || isNaN(r.to)) return false;
    return r.from <= r.to ? (hour >= r.from && hour < r.to) : (hour >= r.from || hour < r.to);
}

// 显示/prompt 用：只游戏名（注册居民必有）
function charName(id) {
    return (charDisplayMap[id] && charDisplayMap[id].name) || id;
}
// 是否认识（真实联系人 或 游戏好友）
function isKnownChar(roleId, profile, id) {
    try { if (getContactIds(roleId).includes(id)) return true; } catch { }
    return (profile.gameFriends || []).some(f => f.id === id);
}
// 此刻可加入的候选（在场 - 我 - 已在群 - 已归档）
function joinCandidates(placeName, roleId, participants) {
    const hour = new Date().getHours();
    return (getPresentAt(placeIndex, placeName, hour) || [])
        .filter(id => id && id !== roleId && !participants.includes(id) && !isArchived(id));
}
// 点名匹配：游戏名 + 真名都认（系统侧文本识别，认所有人）
function mentionedIn(text, id) {
    const names = new Set([charName(id)]);
    const real = getCharacterNameById(id);
    if (real) names.add(real);
    for (const n of names) if (n && text.includes(n)) return true;
    return false;
}

// 反查角色当前地点（从索引）
function getCharCurrentPlace(placeIndex, charId, hour) {
    for (const [place, hours] of Object.entries(placeIndex || {})) {
        if (hours[hour] && hours[hour].includes(charId)) return place;
    }
    return '';
}

// ---- 群聊集中注册表（写串行化，防 maybeJoin/maybeLeave 交错丢更新）----
let registryChain = Promise.resolve();
function withRegistry(fn) {
    registryChain = registryChain.then(fn).catch(e => console.warn('群聊注册表操作失败:', e));
    return registryChain;
}

// ★ 查找「我」和对方同在的进行中对话（同地点）
async function findSharedGroupChat(roleId, friendId, placeName) {
    const reg = await getGroupRegistry();
    for (const [gcId, g] of Object.entries(reg)) {
        if (g.place === placeName && g.participants.includes(roleId) && g.participants.includes(friendId)) return gcId;
    }
    return null;
}

// ★ 角色离开TA参与的其他对话（进入新对话时统一调用；skipGcId=当前对话跳过）
function leaveOtherGroupChats(pid, skipGcId) {
    return withRegistry(async () => {
        const reg = await getGroupRegistry();
        let changed = false;
        for (const [gcId, g] of Object.entries(reg)) {
            if (gcId === skipGcId || !g.participants.includes(pid)) continue;
            g.participants = g.participants.filter(x => x !== pid);
            if (!g.participants.length) delete reg[gcId];
            changed = true;
            await saveChatMessage(null, {
                id: 'scm_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
                from: 'system', to: pid, system: true,
                text: `「${charName(pid)}」离开了聊天`,
                time: Date.now(), temp: true, place: g.place, groupId: gcId
            });
        }
        if (changed) await saveGroupRegistry(reg);
    });
}

// ★ 入口恢复检索：① 注册表同在 → ② 对方参与的对话历史含我 → ③ null（双人历史由 showCityChat 读）
async function findOrRecoverGroupChat(roleId, myProfile, friendId, placeName) {
    const direct = await findSharedGroupChat(roleId, friendId, placeName);
    if (direct) return direct;
    const reg = await getGroupRegistry();
    for (const [gcId, g] of Object.entries(reg)) {
        if (g.place !== placeName || !g.participants.includes(friendId)) continue;
        const msgs = await getGroupChatMessages(gcId);
        const hasMe = msgs.some(m => m.from === roleId || (m.system && m.text.includes(myProfile.name)));
        if (hasMe) return gcId;
    }
    return null;
}


// 进小城时：任一参与方已不在对话地点 → 删除该临时对话
async function cleanupStaleTempChats() {
    try {
        const chats = await getAllChats();
        const hour = new Date().getHours();
        const stale = new Set();
        const groupMsgs = new Map();   // gcId@place → messages（群聊按 conv 整体处理）
        for (const m of chats) {
            if (!m.temp) continue;
            if (m.groupId) {
                const key = m.groupId + '@' + m.place;
                if (!groupMsgs.has(key)) groupMsgs.set(key, []);
                groupMsgs.get(key).push(m);
                continue;
            }
            const aHere = getCharCurrentPlace(placeIndex, m.from, hour) === m.place;
            const bHere = getCharCurrentPlace(placeIndex, m.to, hour) === m.place;
            if (!aHere || !bHere) stale.add(m.id);
        }
        // ★ 已升级对话：按注册表最新归属的在场数判定（<2 → 整 conv 删 + 注册条目删）
        const reg = await getGroupRegistry();
        for (const [key, msgs] of groupMsgs) {
            const gcId = msgs[0].groupId;
            const place = msgs[0].place;
            const g = reg[gcId];
            const presentCount = g ? g.participants.filter(pid => getCharCurrentPlace(placeIndex, pid, hour) === g.place).length : 0;
            if (presentCount >= 2) continue;
            await deleteTempChats(gcId, place);
            if (g) { delete reg[gcId]; await saveGroupRegistry(reg); }
        }
        if (stale.size) await deleteChatMessages([...stale]);
    } catch (e) { console.warn('清理临时对话失败:', e); }
}

async function showCityChat(container, roleId, profile, friendId, placeName, persist = true, fpPre, gcIdPre) {
    const friendName = getCharacterNameById(friendId) || friendId;
    const hour = new Date().getHours();
    // ★ 提前读对方档案（休息判断 + 后续对话 prompt 复用，省一次读取）
    let fp = fpPre || null;
    if (!fp) { try { fp = await getProfile(friendId); } catch { } }

    // ★ 对方在休息：聊天不可用
    if (isResting(fp, hour)) {
        toast(`💤 ${esc(charName(friendId))} 正在休息，等TA睡醒再聊吧`, '#7c4dff');
        return;
    }
    const pairKey = chatPairKey(roleId, friendId);
    let gcId = gcIdPre || null;          // ★ 共享群聊窗口 id
    // ★ 三层关系判断
    const isContact = new CharacterStore(roleId).isFriend(friendId);                 // 真实联系人
    const isGameFriend = (profile.gameFriends || []).some(f => f.id === friendId);   // 游戏好友
    // ★ 显示层：主视角看自己永远"你"；看对方（一对一）联系人→游戏名（真名），陌生人→游戏名
    const myDisplay = '你';
    const displayName = isContact ? `${charName(friendId)}（${friendName}）` : charName(friendId);

    const overlay = document.createElement('div');
    overlay.className = 'simcity-pop';
    overlay.style.alignItems = 'flex-end';
    overlay.innerHTML = `
        <div class="cc-sheet">
            <div class="cc-head">
                <div style="display:flex;align-items:center;gap:10px;">
                    <div class="avatar">${getAvatarHtml(friendId)}</div>
                    <div>
                        <div class="cc-title" id="ccTitle">${esc(displayName)}</div>
                        <div class="cc-sub">${esc(placeName)} · ${hour}:00${persist ? '' : ' · 临时对话'}</div>
                    </div>
                </div>
                <button class="cc-close" id="ccClose">✕</button>
            </div>
            <div id="ccMsgs"></div>
            <div class="cc-inputbar">
                <input id="ccInput" placeholder="说点什么…">
                <button id="ccSend">发送</button>
            </div>
        </div>`;
    container.appendChild(overlay);
    overlay.querySelector('#ccClose').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const msgsEl = overlay.querySelector('#ccMsgs');
    const inputEl = overlay.querySelector('#ccInput');

    let participants = [roleId, friendId];      // 群聊成员（含我）
    let turn = 0;                               // 轮次计数
    let lastJoinTurn = -9;                      // 上次加入的轮次（冷却）
    let sentAny = false;   // ★ 本窗口是否已发过消息（首条才触发移除旧群聊）

    const groupMode = !persist;                 // 临时对话标志（拉人/离开用）
    const isGroupChat = () => !!gcId || participants.length > 2;   // ★ 真群聊判断（有gcId或>2人）
    const partProfiles = new Map();
    partProfiles.set(friendId, fp);

    // ★ 群聊标题：显示当前所有参与者（不含我）
    function renderHeader() {
        const titleEl = overlay.querySelector('#ccTitle');
        if (!titleEl) return;
        if (!isGroupChat()) { titleEl.textContent = displayName; return; }   // ★ 联系人→游戏名（真名）；陌生人→游戏名
        const names = participants
            .filter(id => id !== roleId)
            .map(id => charName(id));   // ★ 群聊标题全游戏名（真名备注不进群聊）
        titleEl.textContent = names.join('、');
    }

    function renderMsgs(fadeFrom = messages.length) {
        if (!overlay.isConnected) return;   // ★ 窗口已关：不渲染
        renderHeader();   // ★ 标题随参与者实时更新
        msgsEl.innerHTML = messages.map((m, i) => {
            if (m.system || m.from === 'system') {
                return `<div class="cc-system">${esc(m.text)}</div>`;
            }
            const mine = m.from === roleId;
            const name = mine ? myDisplay : charName(m.from);
            const pop = i >= fadeFrom ? ' cc-pop' : '';                        // ★ 只给新增消息加动画
            const delay = i >= fadeFrom ? `animation-delay:${(i - fadeFrom) * 0.35}s;` : '';
            const bubbleText = stripEventMarkers(m.text || '');                // ★ 渲染兜底：隐藏事件标记（历史残留也干净）
            return `<div class="cc-row ${mine ? 'mine' : 'theirs'}${pop}" style="${delay}">
            <div class="cc-name">${esc(name)}</div>
            <div class="cc-bubble ${mine ? 'mine' : 'theirs'}">${esc(bubbleText)}</div>
        </div>`;
        }).join('');
        msgsEl.scrollTop = msgsEl.scrollHeight;
    }

    // ★ 读历史：持久读非 temp；临时读 temp + 生命周期检查
    let messages;
    let tempMsgs = [];       // ★ 偶遇记忆（持久对话的记忆来源：所有地点临时对话）
    let persistMsgs = [];    // ★ 好友框记忆（临时对话的记忆来源：持久聊天）
    if (persist) {
        const all = await getChatMessages(pairKey);
        messages = all.filter(m => !m.temp);
        tempMsgs = all.filter(m => m.temp);
    } else if (gcId) {
        // ★ 共享群聊窗口：读群聊自己的历史（历史由 cleanup 统一管，打开时不删）
        messages = await getGroupChatMessages(gcId);
        // ★ 自愈：群聊从未有消息 → 解散注册，降级为普通双人对话
        if (!messages.length) {
            await unregisterGroupChat(gcId);
            gcId = null;
        }
    } else {
        const all = await getChatMessages(pairKey);
        const temp = all.filter(m => m.temp);
        persistMsgs = all.filter(m => !m.temp);   // ★ 临时对话的记忆 = 好友框持久聊天（游戏内记忆互通）
        const currentPlace = getCharCurrentPlace(placeIndex, friendId, hour);
        const dialogPlace = temp[0]?.place;
        if (dialogPlace && currentPlace !== dialogPlace) {
            await deleteTempChats(pairKey, dialogPlace);
            messages = [];
        } else {
            messages = temp;
        }
    }
    if (groupMode) {
        const reg = await getGroupRegistry();
        const regG = gcId ? reg[gcId] : null;
        // ★ 打开群聊窗口时：同步归属（不在场的从归属移除，只更新注册表，不清理数据）
        if (gcId && regG) {
            const hour = new Date().getHours();
            const still = regG.participants.filter(pid =>
                getCharCurrentPlace(placeIndex, pid, hour) === regG.place
            );
            if (still.length !== regG.participants.length) {
                await withRegistry(async () => {
                    const reg2 = await getGroupRegistry();
                    if (reg2[gcId]) {
                        reg2[gcId].participants = still;
                        reg2[gcId].type = still.length >= 3 ? 'group' : 'pair';
                        reg2[gcId].lastActive = Date.now();
                        await saveGroupRegistry(reg2);
                    }
                });
                regG.participants = still;   // 内存同步，供下面 participants 赋值使用
            }
        }

        participants = gcId ? [...new Set([roleId, ...(regG?.participants || [])])] : [roleId, friendId];
        if (!gcId) {
            for (const m of messages) {
                if (m.from && m.from !== 'system' && !participants.includes(m.from)) participants.push(m.from);
            }
        }
        // ★ 恢复/激活：打开窗口即重新加入（我不在归属里 → 加回 + 系统消息）
        if (gcId && regG && !regG.participants.includes(roleId)) {
            await registerGroupChat(participants);
            const sys = { id: 'scm_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4), from: 'system', to: friendId, system: true, text: `「${charName(roleId)}」回到了聊天`, time: Date.now() };
            messages.push(sys);
            await saveChatMessage(pairKey, { ...sys, temp: true, place: placeName, groupId: gcId });
        }
    }
    renderMsgs();
    // ★ 注册"自动重开"能力（新窗口覆盖旧窗口；key 区分对话，临时对话带地点）
    const chatKey = gcId ? 'g:' + gcId : (persist ? 'p:' + pairKey : 'p:' + pairKey + '@' + placeName);
    activeChatRefresh = {
        key: chatKey,
        overlay,
        reload: async () => {
            if (!overlay.isConnected) return;      // 窗口又关了 → 跳过（数据已保存）
            if (persist) { const all = await getChatMessages(pairKey); messages = all.filter(m => !m.temp); tempMsgs = all.filter(m => m.temp); }
            else if (gcId) messages = await getGroupChatMessages(gcId);
            else messages = (await getChatMessages(pairKey)).filter(m => m.temp && m.place === placeName);
            renderMsgs(messages.length);
        }
    };

    // ★ 写群聊归属：注册表集中记录（participants 动态 + type），2 人时合并独立单聊历史（数据不重复：迁移+删原）
    async function registerGroupChat(ids) {
        if (!gcId) return;
        const members = [...new Set([roleId, ...ids])];
        await withRegistry(async () => {
            const reg = await getGroupRegistry();
            reg[gcId] = { place: placeName, participants: members, type: members.length >= 3 ? 'group' : 'pair', lastActive: Date.now() };
            await saveGroupRegistry(reg);
        });
        if (members.length === 2) {
            const subKey = chatPairKey(members[0], members[1]);
            const subMsgs = (await getChatMessages(subKey)).filter(m => m.temp && m.place === placeName && !m.groupId);
            for (const sm of subMsgs) await saveChatMessage(subKey, { ...sm, groupId: gcId });
            if (subMsgs.length) await deleteTempChats(subKey, placeName);
        }
    }

    // ★ 注册条目解散（自愈/清理用）
    function unregisterGroupChat(gcIdToDel) {
        return withRegistry(async () => {
            const reg = await getGroupRegistry();
            if (reg[gcIdToDel]) { delete reg[gcIdToDel]; await saveGroupRegistry(reg); }
        });
    }

    async function maybeJoin(msgText) {
        if (!groupMode) return;
        if (participants.length >= 4) return;
        if (turn - lastJoinTurn < 2) return;
        const cands = joinCandidates(placeName, roleId, participants);
        console.log('[maybeJoin] 地点:', placeName, '候选:', cands.map(id => charName(id)));
        if (!cands.length) return;
        const mentioned = cands.filter(id => mentionedIn(msgText, id));
        console.log('[maybeJoin] 点名:', mentioned.map(id => charName(id)), '消息:', msgText);
        let pick = null;
        if (mentioned.length) {
            const id = mentioned[Math.floor(Math.random() * mentioned.length)];
            if (Math.random() < (isKnownChar(roleId, profile, id) ? 0.7 : 0.3)) pick = id;
        } else if (Math.random() < 0.1) {
            const knowns = cands.filter(id => isKnownChar(roleId, profile, id));
            const pool = knowns.length && Math.random() < 0.8 ? knowns : cands;
            pick = pool[Math.floor(Math.random() * pool.length)];
        }
        if (!pick) return;
        const pfp = await getProfile(pick).catch(() => null);
        if (isResting(pfp, new Date().getHours())) return;
        participants.push(pick);
        partProfiles.set(pick, pfp);
        lastJoinTurn = turn;

        // ★ 首次升级群聊：创建稳定群聊 id + 迁移升级前的双人历史 + 注册参与者
        if (!gcId) {
            gcId = 'gc_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
            const oldMsgs = (await getChatMessages(pairKey)).filter(m => m.temp && m.place === placeName);
            for (const om of oldMsgs) await saveChatMessage(pairKey, { ...om, groupId: gcId });
            if (oldMsgs.length) await deleteTempChats(pairKey, placeName);
        }
        await registerGroupChat(participants);
        await leaveOtherGroupChats(pick, gcId);        // ★ 新版 2 参数

        const sys = { id: 'scm_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4), from: roleId, to: friendId, system: true, text: `「${charName(pick)}」也加入了聊天`, time: Date.now() };
        messages.push(sys);
        await saveChatMessage(pairKey, { ...sys, temp: true, place: placeName, groupId: gcId });
        renderMsgs();
    }

    async function maybeLeave() {
        if (!groupMode) return;
        const hour = new Date().getHours();
        const present = new Set(getPresentAt(placeIndex, placeName, hour) || []);
        for (const id of [...participants]) {
            if (id === roleId || id === friendId) continue;
            const gone = !present.has(id);
            const randomLeave = !gone && participants.length > 2 && Math.random() < 0.06;
            if (gone || randomLeave) {
                participants = participants.filter(x => x !== id);
                const sys = { id: 'scm_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4), from: roleId, to: friendId, system: true, text: `「${charName(id)}」起身离开了`, time: Date.now() };
                messages.push(sys);
                await saveChatMessage(pairKey, { ...sys, temp: true, place: placeName, ...(gcId ? { groupId: gcId } : {}) });
                if (gcId) {
                    await registerGroupChat(participants);   // ★ 内部已处理降级 type + 合并
                }
                renderMsgs();
            }
        }
    }


    async function send(text) {
        if (!text.trim()) return;
        // ★ 对方中途休息：拦截发送
        if (isResting(fp, new Date().getHours())) {
            toast(`💤 ${esc(charName(friendId))} 正在休息，等TA睡醒再聊吧`, '#7c4dff');
            return;
        }

        // ★ 首条消息（非群聊窗口）：从旧群聊移除（全角色统一：进入新对话即离开旧群聊）
        if (!sentAny) {
            await leaveOtherGroupChats(roleId, gcId);
        }
        sentAny = true;

        const myMsg = { id: 'scm_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4), from: roleId, to: friendId, text: text.trim(), time: Date.now() };
        messages.push(myMsg);
        if (persist) await saveChatMessage(pairKey, myMsg);
        else await saveChatMessage(pairKey, { ...myMsg, temp: true, place: placeName, ...(gcId ? { groupId: gcId } : {}) });
        renderMsgs();
        inputEl.value = '';

        turn++;                      // ★ 每条消息算一轮
        await maybeJoin(text);

        // 主视角说走就走：识别“去/回/到+地点” → 加约定（说“每天/以后/长期”→永久日程，否则临时约定），并 toast 提示
        const m = /(?:去|回|到|去趟|跑一趟|去一下|赶去|前往|上班|下班)\s*([^\s，。！？,.、]{1,8})/.exec(text || '');
        if (m) {
            let place = PLACES.find(p => p.name === m[1] || m[1].startsWith(p.name));
            // ★ 动态地产也可作为目的地（主视角可见：参与/同IP/行程）
            if (!place) {
                const est = (simCityEstates.estates || []).find(e =>
                    canSeeEstate(roleId, profile, e) &&
                    (e.name === m[1] || m[1].includes(e.name) || e.name.includes(m[1]) ||
                        (e.goal || '') === m[1] || m[1].includes(e.goal || '') || (e.goal || '').includes(m[1])));
                if (est) place = { name: est.name };   // ★ 规范为地产标准名（冬木市 → 冬木市·建设中）
            }
            if (place && place.name !== placeName) {
                const today = dayStr(new Date());
                const nowHour = new Date().getHours();
                let hour = nowHour;
                const tm = /(\d{1,2})[点时:](\d{2})?/.exec(text);
                if (tm) {
                    let h = parseInt(tm[1]);
                    if (/下午|晚上|傍晚|夜里|夜间|晚间/.test(text) && h < 12) h += 12;   // 下午2点→14
                    else if (/凌晨|半夜|午夜/.test(text) && h === 12) h = 0;             // 凌晨12点→0
                    hour = Math.min(23, h);
                }
                const timeStr = String(hour).padStart(2, '0') + ':' + (tm?.[2] || '00');
                const act = text.trim().slice(0, 30);

                if (/每天|以后|长期/.test(text)) {
                    // ★ 永久日程（每天该小时生效）
                    const sched = profile.schedule || [];
                    if (!sched.some(s => s.time === timeStr && s.place === place.name)) {   // ★ 防与 AI 同意的永久约定重复
                        profile.schedule = [...sched, { time: timeStr, place: place.name, act }]
                            .sort((a, b) => String(a.time).localeCompare(String(b.time)));
                        await saveProfile(profile, roleId);
                        toast(`📅 已加入永久日程：${timeStr} 去${place.name}`, '#2e7d32');
                    }
                } else {
                    // ★ 临时约定（说走就走）
                    profile.appointments = profile.appointments || [];
                    profile.appointments.push({ date: today, time: timeStr, place: place.name, act });
                    await saveProfile(profile, roleId);
                    toast(`📍 已改行程：${timeStr} 去${place.name}`, '#7c4dff');
                }
                upsertCharPlaceIndex(placeIndex, profile, dayStr(new Date()), roleId);   // ★ 局部更新在场索引（不再全量重建）
            }
        }

        const sendBtn = overlay.querySelector('#ccSend');
        sendBtn.disabled = true;
        try {
            // ★ prompt 专用称呼：主视角用游戏名（陌生人也能见），绝不用"你"
            const promptMyName = profile.name;
            // ★ B 视角（prompt/AI 知识层）：对方（B）对主视角的了解——只从 B 的档案读（每个角色依赖自己的数据）
            const bIsContact = fp ? new CharacterStore(friendId).isFriend(roleId) : false;                 // B 是否把 A 当联系人
            const bIsGameFriend = fp ? (fp.gameFriends || []).some(f => f.id === roleId) : false;         // B 的游戏好友是否含 A
            // ★ 对方此刻正在做什么（从日程/约定取）
            // ★ friendAct：从"事实行程"取（约定 > 建设时段 > 基础），与索引同源 → 不会和地点矛盾
            let friendAct = '';
            if (fp) {
                const today = dayStr(new Date());
                const app = (fp.appointments || []).find(a => (a.date || '') === today && parseInt(a.time) === hour);
                if (app) {
                    friendAct = app.act || '';
                } else {
                    for (const b of (fp.builds || [])) {
                        const hs = parseInt(b.time, 10); if (Number.isNaN(hs)) continue;
                        let he = b.endTime ? parseInt(b.endTime, 10) : hs + 1;
                        if (Number.isNaN(he) || he === hs) he = hs + 1;
                        let hit = false;
                        for (let hh = hs; hh !== he; hh = (hh + 1) % 24) { if (hh === hour) { hit = true; break; } }   // 含跨夜建设时段
                        if (hit) { friendAct = b.act || '参与建设'; break; }
                    }
                }
                if (!friendAct) friendAct = curScheduleEntry(fp.schedule, hour)?.act || '';
            }

            const placeObj = PLACES.find(p => p.name === placeName);
            const isRemote = !placeObj;   // 非真实地点 = 远程聊天（好友面板入口）
            // 改为（★ 优先读当前 UI 在场区该角色的状态，界面显示什么 AI 就用什么；不在场再现算兜底）：
            const stSmall = container.querySelector(`.sc-person [data-friend="${friendId}"]`)?.closest('.sc-person')?.querySelector('.sc-name small');
            const nowStatus = stSmall ? stSmall.textContent.replace(/[（）()]/g, '').trim() : (statusNow(friendId, hour) || '');
            const friendCustom = customDesc(fp || {});   // ★ 对方角色自己的特殊属性（AI 扮演对方，角色看自己最全）

            const history = messages.slice(-(simCitySettings?.historyCount || 20)).map(m => {
                if (m.system || m.from === 'system') return `【系统】${m.text}`;
                return `${m.from === roleId ? promptMyName : charName(m.from)}：${m.text}`;
            }).join('\n');
            const rel = bIsContact ? await readGameData(friendId, 'relations', () => new CharacterStore(friendId).getRelationById(roleId)) : null;
            const realName = bIsContact ? getCharacterNameById(roleId) : null;   // ★ B 知道 A 真名吗（B 视角）


            let myInfo;
            if (groupMode) {
                // ★ 群聊：主视角只给公开信息（真名/关系由各角色视角块按 TA 自己的档案提供）
                myInfo = `小城名：${esc(profile.name)}（${esc(jobDisplay(profile))}）\n性格：${esc((profile.aiProfile?.traits || []).join('、'))}`;
            } else if (bIsContact) {
                myInfo = `小城名：${esc(profile.name)}（${esc(jobDisplay(profile))}）\n性格：${esc((profile.aiProfile?.traits || []).join('、'))}` +
                    (realName ? `\n真实身份：${esc(realName)}` : '') +
                    (rel?.relation ? `\n你和ta的关系：${esc(rel.relation)}` : '');
            } else if (bIsGameFriend) {
                myInfo = `小城名：${esc(profile.name)}（${esc(jobDisplay(profile))}）\n性格：${esc((profile.aiProfile?.traits || []).join('、'))}`;
            } else {
                myInfo = `小城名：${esc(profile.name)}（你不了解更多）`;
            }


            // ★ 在场者视角（per-participant）：每个角色自己的认知块——TA看主视角、TA看其他在场者，全部从TA自己的档案读
            const rosterLines = [];
            for (const pid of participants) {
                if (pid === roleId) continue;
                if (!partProfiles.has(pid)) partProfiles.set(pid, await getProfile(pid).catch(() => null));
                const pf = partProfiles.get(pid) || {};
                const nm = charName(pid);
                const job = jobDisplay(pf);
                const traits = (pf.aiProfile?.traits || []).join('、') || '未知';
                const st = statusNow(pid, hour) || '空闲';
                const pfGf = pf.gameFriends || [];
                let line = `· ${nm}（${job || '居民'}）性格：${traits}，此刻：${st}`;
                // ★ 自我认知（角色看自己：全的信息）——真名 + 今日日程
                const selfReal = getCharacterNameById(pid);
                if (selfReal && selfReal !== nm) line += `\n  真实身份：${esc(selfReal)}`;
                const selfSched = (pf.schedule || []).map(s => `${esc(s.time)} ${esc(s.place)}${s.act ? ' ' + esc(s.act) : ''}`).join('；');
                if (selfSched) line += `\n  今日日程：${selfSched}`;
                const selfCustom = customDesc(pf);
                if (selfCustom) line += `\n  特殊属性：${esc(selfCustom)}`;
                const persona = personaBlockFor(pf);   // ★ 个性登记
                if (persona) line += `\n  个性：${persona}`;
                if (pf) {
                    // ★ 该角色视角：看主视角（从TA自己的档案）
                    const pidContactA = new CharacterStore(pid).isFriend(roleId);
                    const pidGfA = pfGf.some(f => f.id === roleId);
                    const relA = await readGameData(pid, 'relations', () => new CharacterStore(pid).getRelationById(roleId)).catch(() => null);
                    if (pidContactA) line += `\n  ${nm}看主视角${promptMyName}（真实身份：${getCharacterNameById(roleId) || ''}）：联系人` + (relA?.relation ? `（关系：${relA.relation}）` : '');
                    else if (pidGfA) line += `\n  ${nm}看主视角${promptMyName}：游戏好友` + (relA?.relation ? `（关系：${relA.relation}）` : '');
                    else line += `\n  ${nm}看主视角${promptMyName}：陌生人（只知道游戏名）`;
                    // ★ 该角色视角：看其他在场者（从TA自己的档案）
                    for (const other of participants) {
                        if (other === roleId || other === pid) continue;
                        const relO = await readGameData(pid, 'relations', () => new CharacterStore(pid).getRelationById(other)).catch(() => null);
                        const isOtherContact = new CharacterStore(pid).isFriend(other);   // ★ 联系人识别（该角色的真实联系人）
                        const isOtherGf = pfGf.some(f => f.id === other);
                        if (isOtherContact) line += `\n  ${nm}看${charName(other)}（真实身份：${getCharacterNameById(other) || ''}）：联系人` + (relO?.relation ? `（关系：${relO.relation}）` : '');
                        else if (isOtherGf) line += `\n  ${nm}看${charName(other)}：游戏好友` + (relO?.relation ? `（关系：${relO.relation}）` : '');
                        else if (relO?.relation) line += `\n  ${nm}和${charName(other)}的关系：${relO.relation}`;
                    }
                    // ★ 该角色自己的游戏好友（在场内）
                    const ownFriends = pfGf.filter(f => participants.includes(f.id) && f.id !== roleId && f.id !== pid).map(f => charName(f.id));
                    if (ownFriends.length) line += `\n  游戏好友：${ownFriends.join('、')}`;
                }
                // ★ 游戏内好感：该角色对在场其他人的亲密度/修正
                const rels = participants.filter(q => q !== pid).map(q => {
                    const inti = getIntimacy(pid, q);
                    const star = starOf(inti);
                    const mod = getRelationMod(pf, q);
                    return `${charName(q)}：${inti}${star}${mod ? `（修正${mod > 0 ? '+' : ''}${mod}）` : ''}`;
                }).join('；');
                if (rels) line += `\n  游戏好感：${rels}`;

                rosterLines.push(line);
            }
            const rosterText = rosterLines.join('\n');
            // ★ 商店上下文（当前对话地点；远程不能买）
            const curShopCfg = (!isRemote) ? (() => {
                for (const e of (simCityEstates?.estates || [])) {
                    if (e.status !== 'built') continue;
                    if (e.name === placeName && e.shopId && simCityShops[e.shopId]) return { estate: e, shop: simCityShops[e.shopId] };
                    const sub = (e.subs || []).find(x => x.name === placeName);
                    if (sub && sub.shopId && simCityShops[sub.shopId]) return { estate: e, shop: simCityShops[sub.shopId] };
                }
                return null;
            })() : null;
            // ★ B' 触发：上一轮/上上轮文本有购买语境 + 有商店 + 本会话未注入过 → 本轮注入货架
            const convShopKey = (gcId ? 'g:' + gcId : pairKey + (persist ? '' : '@' + placeName));
            const shopInjected = shopInjectedKeys.has(convShopKey);
            const lastTwoText = messages.slice(-2).map(m => m.text || '').join(' ');
            const hasShopCue = !!curShopCfg && !shopInjected && SHOP_TRIGGER_WORDS.some(w => lastTwoText.includes(w));
            if (hasShopCue) shopInjectedKeys.add(convShopKey);
            const shopLine = curShopCfg
                ? (hasShopCue
                    ? `【商店】「${curShopCfg.shop.name}」的货架（想买时在回复末尾输出【购买@商品名】即可）：\n${curShopCfg.shop.items.map(it => `- ${it.icon} ${it.name}：${it.desc || ''}（💰${it.price}，剩${it.qty}）`).join('\n')}\n\n`
                    : `【商店】此地有「${curShopCfg.shop.name}」（想买可询问货架）。\n\n`)
                : '';

            const reply = await taskManager.watch('citychat', `小城对话 · ${friendName}`, async () => {
                const { callAIWithMessages } = await import('../aiService.js');
                // 改为（★ 优先当前 UI 环境卡；无环境卡/远程对话才兜底）：
                const sceneEnv = (() => {
                    const pl = PLACES.find(p => p.name === placeName)
                        || (simCityEstates?.estates || []).find(e => e.status === 'built' && e.name === placeName);
                    if (!pl) return `${placeName}里，一切照常`;
                    return uiEnvText(container, placeName) || placeAmbience({ key: pl.id || pl.key, name: pl.name }, hour);
                })();

                return await callAIWithMessages({
                    systemPrompt: isGroupChat()
                        ? '"模拟小城"此刻正在' + placeName + '（' + hour + '点，24小时制）进行一场小城闲聊。\n' +
                        '在场的人：' + participants.filter(id => id !== roleId).map(charName).join('、') + '。你将扮演在场的人推进对话。\n' +
                        '规则：\n' +
                        '1. 每轮由最相关的人回应——被点名的、与话题有关的、或想插话的；可以多人依次发言。不要总是由同一个人回应，如果连续几轮都是某人在说，就让其他人开口或插话（除非被点名）。尽量一轮中输出多条信息。禁止替（' + promptMyName + '）说话。\n' +
                        '2. 输出格式：每行必须以「名字：内容」开头，一行一人，可连续多行；名字必须严格使用【在场者】中的游戏名或真实身份名，禁止加称谓、职业、括号注释或任何改写；禁止不带名字的发言。\n' +
                        '3. 每个角色的视角已在【在场者视角】分别给出（TA对其他在场者的认知、关系、真实身份等），扮演谁就用谁的视角——TA知道什么、怎么看其他人都以该角色视角块为准；可以互相搭话、调侃、聊自己的事。\n' +
                        '4. 角色有自己的信息视角，各个角色对其他角色的熟知度也会有区别，根据角色间的关系和给到的认知信息进行对话；没有给出的关系、对方真实身份、未参与时的对话，不得假设或编造。新加入的角色不知道加入前的对话，若相关就让TA自然询问或保持不知情。\n' +
                        '5. 回应简短（每人20~60字）。\n' +
                        '6. 若有人提出约定或加好友：同意 → 在该角色那行末尾加标记。约定：【约定】HH:MM地点（临时）或【约定】HH:MM地点【永久】（表示该角色自己会按时赴约，谁说的约定就属于谁）；加好友：【加好友@对方游戏名】（@后必须是在场者的确切游戏名，系统按游戏名登记；群聊内任意角色可互相加，也可加' + promptMyName + '）；拒绝 → 自然拒绝，不加标记。\n' +
                        '7. 若对话中出现了值得被记住的新信息（新鲜事/八卦/传闻/重大事件），可在该角色那行末尾加【事件：流言|传闻|新闻】内容（流言=不确定/八卦，传闻=半确定，新闻=确定事实）\n' +

                        '8. 只输出对话内容（可含上述标记），不要任何解释'
                        : '你是"模拟小城"的居民。现在有人和你聊天。要求：\n' +
                        '1. 完全以你的小城身份回应，自然口语化，像真人聊天，避免AI腔\n' +
                        (isRemote
                            ? '2. 【重要】你现在正拿着手机和' + promptMyName + '聊天（' + hour + '点，24小时制' + (nowStatus ? '，你此刻' + nowStatus : '') + '）。\n'
                            : '2. 【重要】你此刻正在「' + placeName + '」（' + hour + '点，24小时制），正在做：「' + (friendAct || ('在' + placeName + '待着')) + '」。\n') +
                        '只围绕【此刻这个场景】回应——你现在在哪、正在做什么、遇到的人是谁，都必须基于当前环境；\n' +
                        '绝不要提及此刻不在场的日常（除非特定情况，如喜欢耍人、骗人，需要隐瞒等等）\n' +
                        '3. 回应简短（20~60字）\n' +
                        '4. 如果对方提出约定或加好友：\n' +
                        '   同意约定 → 回复末尾加【约定】HH:MM 地点（临时约定）；长期约定加【约定】HH:MM 地点【永久】（约定属于你自己，你会按时赴约）\n' +
                        '   同意加好友 → 回复末尾加【加好友】（表示你同意和他/她互为游戏好友）\n' +
                        '   不想答应 → 自然委婉拒绝，不要输出任何标记\n' +
                        '   若对话中出现了值得被记住的新信息（新鲜事/八卦/传闻/重大事件），可在回复末尾加【事件：流言|传闻|新闻】内容（流言=不确定/八卦，传闻=半确定，新闻=确定事实）\n' +

                        '5. 只输出对话内容（可含上述标记），不要任何解释',


                    userContent: `${simCityWorldText() ? '【今日小城】\n' + simCityWorldText() + '\n\n' : ''}${myInfo}\n\n` +
                        (isGroupChat()
                            ? `【在场者】\n${rosterText || '（只有你们两人）'}\n\n`
                            : (fp ? `【你】小城名：${esc(fp.name)}（${esc(jobDisplay(fp))}）\n性格：${esc((fp.aiProfile?.traits || []).join('、'))}\n真实身份：${esc(getCharacterNameById(friendId) || '')}\n你的当前状态：${nowStatus || '空闲'}\n今日日程：${(fp.schedule || []).map(s => `${esc(s.time)} ${esc(s.place)}${s.act ? ' ' + esc(s.act) : ''}`).join('；') || '（暂无安排）'}${friendCustom ? `\n特殊属性：${esc(friendCustom)}` : ''}${personaBlockFor(fp) ? `\n个性：${personaBlockFor(fp)}` : ''}${(() => { const rb = relationBlockFor(fp, roleId, promptMyName); return rb ? `\n【好感】${rb}` : ''; })()}\n` : `【你】${esc(friendName)}\n（未入住小城，作为路人回应）\n`)) +
                        (isRemote
                            ? `【此刻】${hour}点（24小时制） · 远程消息：你正拿着手机回${promptMyName}的消息${nowStatus ? '（你此刻' + nowStatus + '）' : ''}\n\n`
                            : `此刻：${placeName}（${hour}点，24小时制），${sceneEnv}。` +
                            (isGroupChat ? `${charName(friendId)}正在「${friendAct || ('在' + placeName + '待着')}」` : `你正在「${friendAct || ('在' + placeName + '待着')}」`) + `\n\n`) +
                        `${shopLine}` +
                        `【对话历史】\n${history || '（刚开始聊）'}\n\n` +
                        `${(() => {
                            const mem = persist ? tempMsgs : (gcId ? [] : persistMsgs);   // ★ 持久对话带临时记忆；临时对话带好友框记忆；群聊不带
                            if (!mem.length) return '';
                            return `【近期记忆】（你记得的：你们在其他场合聊过的内容，可自然提及）\n${mem.filter(m => m.from && m.from !== 'system').slice(-6).map(m => `（${m.place || '聊天'}）${charName(m.from)}：${stripEventMarkers(m.text || '')}`).join('\n')}\n\n`;
                        })()}` +
                        `请以${groupMode ? '在场者的身份' : '你的身份'}回复${promptMyName}最近这句话：「${text}」`,
                    maxTokens: isGroupChat() ? 1400 : 800, temperature: 0.85
                });
            });


            // ★ 名字规范化：去空白 + 去尾部称呼后缀（号/先生/小姐/女士/同学/老师…），大小写不敏感
            //   AI 常省略"号"字（"GM4号"→"GM4"），规范化让简称也能锁定到人
            const normName = n => String(n || '').replace(/\s+/g, '').replace(/[号先生小姐女士同学老师]$/g, '').toLowerCase();

            let aiMsgs = [];
            if (isGroupChat) {
                const lines = (reply || '').split('\n').map(s => s.trim()).filter(Boolean);
                for (const ln of lines) {
                    const m = /^(.+?)[：:](.+)$/.exec(ln);
                    if (m) {
                        const nm = m[1].trim();
                        const others = participants.filter(pid => pid !== roleId);
                        // ① 精确匹配：游戏名或真名完全相等
                        let pool = others.filter(pid => charName(pid) === nm || getCharacterNameById(pid) === nm);
                        // ② 规范化匹配：精确无命中时启用（"GM4" ↔ "GM4号"）
                        if (!pool.length) {
                            const nn = normName(nm);
                            pool = others.filter(pid =>
                                normName(charName(pid)) === nn ||
                                (getCharacterNameById(pid) && normName(getCharacterNameById(pid)) === nn));
                        }
                        // ②' 变体容错：去括号注释 + 去常见称谓后缀 → 再匹配；仍无则双向子串匹配（防"克莱恩"省略"·莫雷蒂"、"言峰绮礼神父"）
                        if (!pool.length) {
                            const cleanNm = nm.replace(/[（(].*?[）)]/g, '').replace(/[号先生小姐女士同学老师神父牧师老板店主店员学徒]$/g, '').trim();
                            const nn2 = normName(cleanNm);
                            pool = others.filter(pid => {
                                const cn = charName(pid), rn = getCharacterNameById(pid);
                                if (nn2 && (normName(cn) === nn2 || (rn && normName(rn) === nn2))) return true;
                                if (cleanNm.length >= 2) {
                                    if (cn && (cn.includes(cleanNm) || cleanNm.includes(cn))) return true;
                                    if (rn && (rn.includes(cleanNm) || cleanNm.includes(rn))) return true;
                                }
                                return false;
                            });
                        }
                        // ③ 歧义保护：命中 >1 视为无法锁定 → 丢弃该行，绝不挂到 friendId 名下
                        const speaker = pool.length === 1 ? pool[0] : null;
                        if (speaker) aiMsgs.push({ from: speaker, text: m[2].trim() });
                    } else if (aiMsgs.length) {
                        aiMsgs[aiMsgs.length - 1].text += '\n' + ln;   // 续行：接上一条发言
                    }
                    // 无名字的首行：丢弃（AI 未按格式输出，宁可不显示也不挂错人）
                }
                // 整段都无可归属的行（如 AI 完全没按格式）→ 兜底给 friendId，保证回复不静默
                if (!aiMsgs.length) aiMsgs.push({ from: friendId, text: reply });
            } else {
                aiMsgs.push({ from: friendId, text: reply });
            }
            const startIdx = messages.length;   // ★ 记录 AI 回复加入前的索引（群聊逐条浮现用）
            // ★ 在 aiMsgs 归属完成后再执行游戏内操作（谁说的写谁）
            const actions = await applyCityActions(aiMsgs, roleId, profile, participants, curShopCfg);
            // ★ 公告牌：对话事件
            if (placeName && !isRemote) {
                const pk = placeKeyFromName(placeName);
                addBulletin(pk, 'chat', `${charName(roleId)}和${charName(friendId)}在${placeName}聊了很久`);
            }
            await applyEventActions(aiMsgs, placeName);   // ★ 事件产出 → 全局事件池（流言/传闻/新闻）
            for (const ai of aiMsgs) {
                const cleanText = stripEventMarkers(ai.text.trim());   // ★ 剥离事件标记（事件已入库）
                if (!cleanText) continue;                              // ★ 纯事件产出：不显示气泡
                const replyMsg = { id: 'scm_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4), from: ai.from, to: roleId, text: cleanText, time: Date.now() };
                messages.push(replyMsg);
                if (persist) await saveChatMessage(pairKey, replyMsg);
                else await saveChatMessage(pairKey, { ...replyMsg, temp: true, place: placeName, ...(gcId ? { groupId: gcId } : {}) });
                await leaveOtherGroupChats(ai.from, gcId);   // ★ 发言即"参与了另一场对话"→ 从其他群聊退出（skip 当前窗口）
            }
            // ★ 原窗口还开着 → 内存渲染（零读库，最快路径）
            if (overlay.isConnected) {
                renderMsgs(isGroupChat() ? startIdx : messages.length);   // 群聊逐条浮现；双人立即显示
            } else if (activeChatRefresh && activeChatRefresh.key === chatKey && activeChatRefresh.overlay !== overlay) {
                // ★ 原窗口关了且重开过 → 自动重开新窗口（重读存储 + 渲染）
                await activeChatRefresh.reload();
            }
            await maybeLeave();
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

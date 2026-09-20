// store/desktop/SceneActivity.js — 场景活动抽象（桌面场景活动：钓鱼等）
// 任何角色都能成为"场景参与者"：
//   1. 活动状态写进注册表（谁在哪、在干嘛、待到何时）
//   2. 角色自己的触发逻辑调用 setActorActivity + 游戏引擎（startGame）
//   3. 渲染/游戏引擎只读注册表，不关心是哪个角色
// Aoi 通过 aoi-runtime-changed 事件桥接进来（aoi.js 保持独立，零改动）
// 其他角色将来：实现自己的 actor（状态进注册表 + 记忆接口 + 触发入口）即可

const ACTIVITY_KEY = 'scene_activity_registry';   // { actorId: { scene, activity, until } }

function loadRegistry() {
    try { return JSON.parse(localStorage.getItem(ACTIVITY_KEY) || '{}'); } catch { return {}; }
}
function saveRegistry(reg) {
    try { localStorage.setItem(ACTIVITY_KEY, JSON.stringify(reg)); } catch { }
}

// ---- 通用：活动状态 ----
export function getActorActivity(actorId) {
    return loadRegistry()[actorId] || null;
}
export function setActorActivity(actorId, partial) {
    const reg = loadRegistry();
    reg[actorId] = { ...(reg[actorId] || {}), ...(partial || {}) };
    saveRegistry(reg);
    try { window.dispatchEvent(new CustomEvent('actor-activity-changed', { detail: { actorId, activity: reg[actorId] } })); } catch { }
    return reg[actorId];
}
export function clearActorActivity(actorId) {
    const reg = loadRegistry();
    delete reg[actorId];
    saveRegistry(reg);
    try { window.dispatchEvent(new CustomEvent('actor-activity-changed', { detail: { actorId, activity: null } })); } catch { }
}

// ---- 通用：角色是否在某场景（now < until，刷新也不丢）----
export function isActorAtScene(actorId, scene, now = Date.now()) {
    const a = getActorActivity(actorId);
    return a?.scene === scene && (!a.until || now < a.until);
}

// ---- 通用：角色显示信息（名字/emoji，渲染小人用）----
// ★ 预留：以后任意角色（rolebook/worldnet）都从这里解析
export function resolveActorInfo(actorId) {
    if (actorId === 'aoi') return { id: 'aoi', name: 'Aoi', emoji: '💠' };
    try {
        const all = [
            ...JSON.parse(localStorage.getItem('rolebook_characters') || '[]'),
            ...JSON.parse(localStorage.getItem('worldnet_extra_characters') || '[]')
        ];
        const c = all.find(x => x.id === actorId || x.name === actorId);
        if (c) return { id: actorId, name: c.base?.name || actorId, emoji: c.base?.emoji || '👤' };
    } catch { }
    return { id: actorId, name: actorId, emoji: '👤' };
}

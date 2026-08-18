// apps/games/shelter.js — 末日安全屋（避难所 like：收集物资 + 建设经营）
// 人员从主视角联系人抽取（只读快照，单向）；存档走 gameCenterDB（IndexedDB，key = shelter:roleId）

import { getActiveCharacterId, CharacterStore } from '../../store/CharacterStore.js';
import { getCharacterNameById } from '../characterManager.js';
import { getAvatarHtml } from '../../store/ImageCache.js';
import { isArchived } from '../roleData.js';
import { esc } from '../../store/utils.js';
import { getGameSave, saveGameSave } from './gameCenterDB.js';

export const id = 'shelter';
export const label = '末日安全屋';
export const icon = '🏚️';
export const color = '#5d6d3e';

const GAME_ID = 'shelter';
const PRODUCE_MS = 10 * 60 * 1000;            // 产出刻度：10 分钟
const OFFLINE_CAP_MS = 8 * 60 * 60 * 1000;   // 离线补偿封顶 8 小时

// ---- 设施配置 ----
const FACILITIES = {
    bed: { name: '床铺', icon: '🛏️', desc: '提高人口上限', baseCost: { material: 10, power: 0 }, rate: {} },
    garden: { name: '菜园', icon: '🌱', desc: '产出食物', baseCost: { material: 8, power: 2 }, rate: { food: 2 } },
    water: { name: '水塔', icon: '💧', desc: '产出水', baseCost: { material: 8, power: 2 }, rate: { water: 2 } },
    workshop: { name: '车间', icon: '🔧', desc: '产出材料', baseCost: { material: 5, power: 3 }, rate: { material: 1 } },
    generator: { name: '发电机', icon: '⚡', desc: '产出电力', baseCost: { material: 12, power: 0 }, rate: { power: 1 } }
};
const FACILITY_ORDER = ['bed', 'garden', 'water', 'workshop', 'generator'];
const RESOURCE_META = { food: { icon: '🍞', name: '食物' }, water: { icon: '💧', name: '水' }, material: { icon: '🔩', name: '材料' }, power: { icon: '⚡', name: '电力' } };
const RESOURCE_KEYS = ['food', 'water', 'material', 'power'];
const NAME_POOL = ['小陈', '阿杰', '林姐', '大壮', '小满', '老周', '苏珊', '阿凯', '明叔', '小鹿'];

// ---- 工具 ----
const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const rndPick = arr => arr[Math.floor(Math.random() * arr.length)];
const escName = n => esc(n);
function fmtTimeLeft(ms) {
    if (ms <= 0) return '';
    const m = Math.ceil(ms / 60000);
    if (m < 60) return `${m} 分钟`;
    const h = Math.floor(m / 60), mm = m % 60;
    return `${h} 小时${mm ? ` ${mm} 分` : ''}`;
}
function fmtTime(ts) {
    const d = new Date(ts);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function getContactPool(roleId) {
    try { return new CharacterStore(roleId).getFriendIds().filter(id => !isArchived(id)); }
    catch { return []; }
}
function drawPerson(roleId, contactPool, usedIds) {
    const pool = contactPool.filter(id => !usedIds.includes(id));
    if (pool.length) {
        const cid = rndPick(pool);
        // ★ 兜底 'unknown'：角色查不到名字时算无名者
        const nm = getCharacterNameById(cid) || '';
        return { id: cid, name: (nm && nm !== 'unknown') ? nm : '无名者' };
    }
    const unused = NAME_POOL.filter(n => !usedIds.includes(n));
    return { id: null, name: unused.length ? rndPick(unused) : '无名者' + rand(1, 999) };
}

// ---- 存档 ----
function defaultState(roleId, leaderName = '你') {
    const contactPool = getContactPool(roleId);
    const usedIds = [];
    const people = [{ id: roleId, name: leaderName, isLeader: true, hp: 100, status: 'idle', exploreStart: 0, exploreUntil: 0 }];
    usedIds.push(roleId);
    while (people.length < 3) {
        const p = drawPerson(roleId, contactPool, usedIds);
        usedIds.push(p.id || p.name);
        people.push({ ...p, isLeader: false, hp: 100, status: 'idle', exploreStart: 0, exploreUntil: 0 });
    }
    return {
        version: 1, roleId, people, usedIds,
        resources: { food: 100, water: 80, material: 20, power: 10 },
        facilities: { bed: { lv: 1 }, garden: { lv: 1 }, water: { lv: 1 }, workshop: { lv: 1 }, generator: { lv: 1 } },
        logs: [{ at: Date.now(), text: '🏚️ 安全屋建立，末日求生开始。' }],
        lastTick: Date.now()
    };
}
async function loadState(roleId, leaderName) {
    const saved = await getGameSave(GAME_ID, roleId).catch(() => null);
    const state = saved || defaultState(roleId, leaderName);
    if (!state.people) state.people = [];
    if (!state.resources) state.resources = { food: 100, water: 80, material: 20, power: 10 };
    if (!state.facilities) state.facilities = {};
    if (!state.logs) state.logs = [];
    if (!state.usedIds) state.usedIds = [];
    return state;
}
function saveState(state) {
    if (state.logs.length > 100) state.logs = state.logs.slice(-100);   // ★ 日志上限
    state.lastTick = Date.now();
    return saveGameSave(GAME_ID, state.roleId, state);
}

// ---- 数值 ----
const popCap = s => 2 + (s.facilities.bed?.lv || 1) * 2;
function rateOf(state, fid) {
    const lv = state.facilities[fid]?.lv || 1, base = FACILITIES[fid].rate, out = {};
    for (const k in base) out[k] = base[k] * lv;
    return out;
}
const upgradeCost = (fid, lv) => ({ material: FACILITIES[fid].baseCost.material * lv, power: FACILITIES[fid].baseCost.power * lv });

// 按 elapsed 结算：设施产出 + 人员消耗（tick / 离线共用）
function settleByElapsed(state, elapsedMs) {
    const ticks = Math.floor(elapsedMs / PRODUCE_MS);
    if (ticks > 0) {
        const produced = { food: 0, water: 0, material: 0, power: 0 };
        FACILITY_ORDER.forEach(fid => { const r = rateOf(state, fid); for (const k in r) produced[k] += r[k] * ticks; });
        RESOURCE_KEYS.forEach(k => state.resources[k] = (state.resources[k] || 0) + produced[k]);
        state.logs.push({ at: Date.now(), text: `⏳ 设施运转 ${ticks * 10} 分钟，产出 ${RESOURCE_KEYS.filter(k => produced[k]).map(k => `${RESOURCE_META[k].icon}${produced[k]}`).join(' ')}。` });
    }
    const hours = Math.floor(elapsedMs / 3600000);
    if (hours > 0 && state.people.length) {
        const needF = state.people.length * hours, needW = state.people.length * hours;
        if (state.resources.food >= needF) state.resources.food -= needF;
        else { state.resources.food = 0; state.people.forEach(p => p.hp = Math.max(0, (p.hp || 100) - 10)); state.logs.push({ at: Date.now(), text: '⚠️ 食物耗尽，幸存者饿着了！' }); }
        if (state.resources.water >= needW) state.resources.water -= needW;
        else { state.resources.water = 0; state.people.forEach(p => p.hp = Math.max(0, (p.hp || 100) - 10)); state.logs.push({ at: Date.now(), text: '⚠️ 水源耗尽，幸存者渴着了！' }); }
    }
}

// 探索结算
function settleExplorations(state, now) {
    let changed = false;
    state.people.forEach(p => {
        if (p.status === 'exploring' && now >= p.exploreUntil) {
            const durH = Math.max(0.25, Math.round((p.exploreUntil - p.exploreStart) / 3600000 * 10) / 10);
            p.status = 'idle'; p.exploreStart = 0; p.exploreUntil = 0;
            const gained = { food: rand(2, 7) * durH, material: rand(1, 5) * durH, water: rand(2, 6) * durH, power: rand(0, 2) * durH };
            let line = `${p.name} 探索归来，带回 ${RESOURCE_KEYS.filter(k => gained[k] >= 1).map(k => `${RESOURCE_META[k].icon}${Math.floor(gained[k])}`).join(' ')}。`;
            RESOURCE_KEYS.forEach(k => state.resources[k] = (state.resources[k] || 0) + Math.floor(gained[k]));
            if (Math.random() < 0.3) {
                const ev = rndPick([
                    { fn: () => { p.hp = Math.max(0, (p.hp || 100) - 15); line += ' 途中遭遇丧尸，受了伤。'; } },
                    { fn: () => { state.resources.material = (state.resources.material || 0) + 10; line += ' 发现废弃补给站，额外拿到 🔩10。'; } },
                    { fn: () => { if (state.people.length < popCap(state)) { const np = drawPerson(state.roleId, getContactPool(state.roleId), state.usedIds); state.usedIds.push(np.id || np.name); state.people.push({ ...np, isLeader: false, hp: 100, status: 'idle', exploreStart: 0, exploreUntil: 0 }); line += ` 救回一名幸存者 ${np.name}。`; } } }
                ]);
                ev.fn();
            }
            state.logs.push({ at: Date.now(), text: line });
            changed = true;
        }
    });
    return changed;
}

// ---- 主入口 ----
export async function start(overlay, globalState, onBack) {
    const activeChar = globalState?.activeCharacter;
    const roleId = activeChar?.id || getActiveCharacterId();   // ★ 用真实角色 id
    const leaderName = activeChar?.base?.name || activeChar?.name || '你';
    let state = await loadState(roleId, leaderName);

    // 进入：离线补偿（封顶）+ 结算到期探索
    const now = Date.now();
    const elapsed = Math.min(now - (state.lastTick || now), OFFLINE_CAP_MS);
    if (elapsed > 0) settleByElapsed(state, elapsed);
    settleExplorations(state, now);
    state.lastTick = now;
    await saveState(state);

    let toastTimer = null;
    const toast = (msg) => {
        const el = overlay.querySelector('#shelterToast');
        if (!el) return;
        el.textContent = msg;
        el.style.opacity = '1';
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.style.opacity = '0', 2600);
    };

    // 占位声明：
    let openExplore = () => { };
    let upgrade = async () => { };
    let showLogs = () => { };

    const render = () => {
        if (settleExplorations(state, Date.now())) saveState(state);
        const res = state.resources, cap = popCap(state);
        const peopleHtml = state.people.map((p, i) => {
            const exploring = p.status === 'exploring';
            const left = exploring ? fmtTimeLeft(p.exploreUntil - Date.now()) : '';
            return `
            <div style="display:flex;align-items:center;gap:10px;background:white;border-radius:14px;padding:10px;border:1px solid #eee;">
                <div style="width:38px;height:38px;border-radius:50%;overflow:hidden;flex-shrink:0;background:#eef2e8;border:1px solid #d8e0cc;">${p.id ? getAvatarHtml(p.id) : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:18px;">👤</div>'}</div>
                <div style="flex:1;min-width:0;">
                    <div style="font-size:14px;font-weight:600;">${escName(p.name)}${p.isLeader ? ' <small style="color:#c77;font-weight:400;">领袖</small>' : ''}</div>
                    <div style="font-size:11px;color:#999;margin-top:2px;">${exploring ? `🔍 探索中 · 还剩 ${left}` : `❤️ ${p.hp}`}</div>
                </div>
                <button data-explore="${i}" ${exploring ? 'disabled style="opacity:.4"' : ''} style="border:none;background:#5d6d3e;color:#fff;border-radius:999px;padding:6px 12px;font-size:12px;cursor:pointer;">探索</button>
            </div>`;
        }).join('');

        const facHtml = FACILITY_ORDER.map(fid => {
            const f = FACILITIES[fid], lv = state.facilities[fid]?.lv || 1, cost = upgradeCost(fid, lv);
            const rateTxt = Object.keys(f.rate).length ? `产出 ${Object.entries(f.rate).map(([k, v]) => `${RESOURCE_META[k].icon}${v * lv}/10分`).join(' ')}` : `人口上限 ${cap}`;
            const can = res.material >= cost.material && res.power >= cost.power;
            return `
            <div style="display:flex;align-items:center;gap:10px;background:white;border-radius:14px;padding:10px;border:1px solid #eee;">
                <div style="font-size:22px;">${f.icon}</div>
                <div style="flex:1;min-width:0;">
                    <div style="font-size:14px;font-weight:600;">${f.name} <small style="color:#999;">Lv.${lv}</small></div>
                    <div style="font-size:11px;color:#999;margin-top:2px;">${rateTxt}</div>
                </div>
                <button data-upgrade="${fid}" ${can ? '' : 'disabled style="opacity:.4"'} style="border:none;background:#3e5d6d;color:#fff;border-radius:999px;padding:6px 10px;font-size:12px;cursor:pointer;">升级 🔩${cost.material} ⚡${cost.power}</button>
            </div>`;
        }).join('');

        const logHtml = state.logs.slice(-6).reverse().map(l => `<div style="font-size:11px;color:#777;line-height:1.5;">${esc(l.text)} <span style="color:#bbb;">${fmtTime(l.at)}</span></div>`).join('');

        overlay.innerHTML = `
        <div style="display:flex;flex-direction:column;height:100%;background:#f5f2ec;">
            <div style="background:#3f4a2e;color:#fff;padding:10px 14px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">
                <button id="shBack" style="border:none;background:none;color:#fff;font-size:18px;cursor:pointer;">←</button>
                <span style="font-weight:700;font-size:15px;">🏚️ 末日安全屋</span>
                <span style="width:24px;"></span>
            </div>
            <div style="position:absolute;left:50%;top:52px;transform:translateX(-50%);background:rgba(0,0,0,0.75);color:#fff;padding:6px 14px;border-radius:999px;font-size:12px;opacity:0;transition:opacity .3s;z-index:5;pointer-events:none;" id="shelterToast"></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:10px 12px;background:#e9e4d8;flex-shrink:0;">
                ${RESOURCE_KEYS.map(k => `<div style="display:flex;align-items:center;gap:6px;background:rgba(255,255,255,0.7);border-radius:10px;padding:6px 10px;font-size:13px;font-weight:600;"><span>${RESOURCE_META[k].icon}</span><span>${Math.floor(res[k] || 0)}</span></div>`).join('')}
            </div>
            <div style="flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px;">
                <div style="font-size:12px;color:#888;font-weight:600;">👥 幸存者 ${state.people.length}/${cap}</div>
                ${peopleHtml}
                <div style="font-size:12px;color:#888;font-weight:600;margin-top:4px;">🏗️ 设施</div>
                ${facHtml}
                <div style="font-size:12px;color:#888;font-weight:600;margin-top:4px;">📜 日志</div>
                ${logHtml}
            </div>
            <div style="display:flex;gap:8px;padding:10px 12px;flex-shrink:0;">
                <button id="shLogBtn" style="flex:1;border:none;background:#e7e2d6;color:#5a5244;border-radius:12px;padding:10px;font-size:13px;font-weight:600;cursor:pointer;">📜 全部日志</button>
                <button id="shSaveBtn" style="flex:1;border:none;background:#3e5d6d;color:#fff;border-radius:12px;padding:10px;font-size:13px;font-weight:600;cursor:pointer;">💾 保存</button>
            </div>
        </div>`;

        overlay.querySelector('#shBack').addEventListener('click', () => { clearInterval(tick); saveState(state); onBack(); });
        overlay.querySelectorAll('[data-explore]').forEach(b => b.addEventListener('click', () => openExplore(Number(b.dataset.explore))));
        overlay.querySelectorAll('[data-upgrade]').forEach(b => b.addEventListener('click', () => upgrade(b.dataset.upgrade)));
        overlay.querySelector('#shSaveBtn').addEventListener('click', async () => { await saveState(state); toast('💾 已保存'); });
        overlay.querySelector('#shLogBtn').addEventListener('click', () => showLogs());
    };

    // 探索弹层
    openExplore = (idx) => {
        const p = state.people[idx];
        if (!p || p.status === 'exploring') return;
        const mask = document.createElement('div');
        mask.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:6;';
        mask.innerHTML = `
            <div style="background:white;border-radius:18px;padding:16px;width:80%;max-width:300px;">
                <div style="font-weight:700;font-size:15px;margin-bottom:4px;">${escName(p.name)} 要去探索</div>
                <div style="font-size:12px;color:#999;margin-bottom:12px;">探索越久物资越多，风险也越高</div>
                <div style="display:flex;flex-direction:column;gap:8px;">
                    <button data-h="1" style="border:none;background:#eef2e8;color:#3f4a2e;border-radius:12px;padding:10px;font-size:13px;cursor:pointer;">🕐 1 小时 · 稳妥</button>
                    <button data-h="4" style="border:none;background:#eef2e8;color:#3f4a2e;border-radius:12px;padding:10px;font-size:13px;cursor:pointer;">🕓 4 小时 · 平衡</button>
                    <button data-h="8" style="border:none;background:#eef2e8;color:#3f4a2e;border-radius:12px;padding:10px;font-size:13px;cursor:pointer;">🕗 8 小时 · 冒险</button>
                </div>
                <button id="shExpCancel" style="width:100%;border:none;background:#eee;color:#888;border-radius:12px;padding:10px;font-size:13px;margin-top:8px;cursor:pointer;">取消</button>
            </div>`;
        overlay.appendChild(mask);
        mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
        mask.querySelectorAll('[data-h]').forEach(b => b.addEventListener('click', async () => {
            const h = Number(b.dataset.h), t = Date.now();
            p.status = 'exploring'; p.exploreStart = t; p.exploreUntil = t + h * 3600000;
            state.logs.push({ at: t, text: `🔍 ${p.name} 出发探索（${h} 小时）。` });
            await saveState(state);
            mask.remove(); render(); toast(`🔍 ${p.name} 出发探索`);
        }));
        mask.querySelector('#shExpCancel').addEventListener('click', () => mask.remove());
    };

    // 升级
    upgrade = async (fid) => {
        const lv = state.facilities[fid]?.lv || 1, cost = upgradeCost(fid, lv);
        if (state.resources.material < cost.material || state.resources.power < cost.power) { toast('❌ 材料或电力不足'); return; }
        state.resources.material -= cost.material; state.resources.power -= cost.power;
        state.facilities[fid] = { lv: lv + 1 };
        state.logs.push({ at: Date.now(), text: `🔨 ${FACILITIES[fid].name} 升到 Lv.${lv + 1}。` });
        await saveState(state); render(); toast(`🔨 ${FACILITIES[fid].name} → Lv.${lv + 1}`);
    };

    // 日志弹层
    showLogs = () => {
        const mask = document.createElement('div');
        mask.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:6;';
        mask.innerHTML = `
            <div style="background:white;border-radius:18px;padding:16px;width:85%;max-width:320px;max-height:70%;display:flex;flex-direction:column;">
                <div style="font-weight:700;font-size:15px;margin-bottom:8px;">📜 安全屋日志</div>
                <div style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:6px;">
                    ${state.logs.slice().reverse().map(l => `<div style="font-size:12px;color:#666;line-height:1.5;">${esc(l.text)} <span style="color:#bbb;font-size:10px;">${fmtTime(l.at)}</span></div>`).join('')}
                </div>
                <button id="shLogClose" style="width:100%;border:none;background:#eee;color:#888;border-radius:12px;padding:10px;font-size:13px;margin-top:10px;cursor:pointer;">关闭</button>
            </div>`;
        overlay.appendChild(mask);
        mask.querySelector('#shLogClose').addEventListener('click', () => mask.remove());
        mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
    };

    render();

    // ★ 常驻 tick：5 秒一次，结算产出 + 检查探索到期 + 刷新探索倒计时
    const tick = setInterval(async () => {
        if (!overlay.isConnected) { clearInterval(tick); return; }   // ★ overlay 没了 → 自停
        const t = Date.now();
        settleByElapsed(state, t - (state.lastTick || t));
        state.lastTick = t;
        if (settleExplorations(state, t)) { await saveState(state); render(); return; }
        if (state.people.some(p => p.status === 'exploring')) {
            overlay.querySelectorAll('[data-explore]').forEach(b => {
                const p = state.people[Number(b.dataset.explore)];
                if (p?.status === 'exploring') b.textContent = `🔍 ${fmtTimeLeft(p.exploreUntil - t)}`;
            });
        }
    }, 5000);
}

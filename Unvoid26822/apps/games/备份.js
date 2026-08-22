// apps/games/shelter.js — 末日安全屋 v2.0（全新设计）
import { getActiveCharacterId, CharacterStore } from '../../store/CharacterStore.js';
import { getCharacterNameById } from '../characterManager.js';
import { getAvatarHtml } from '../../store/ImageCache.js';
import { isArchived } from '../roleData.js';
import { esc } from '../../store/utils.js';
import { getGameSave, saveGameSave } from './gameCenterDB.js';

export const id = 'shelter';
export const label = '末日安全屋';
export const icon = '🏚️';
export const color = '#8B6F47';

const GAME_ID = 'shelter';

// ==================== 配置常量 ====================
const CONFIG = {
    TICK_INTERVAL: 60000,              // 1分钟一个游戏刻
    OFFLINE_CAP_HOURS: 12,             // 离线补偿最多12小时
    MAX_SURVIVORS: 12,                 // 最大幸存者数量
    EXPLORE_COOLDOWN: 300000,          // 探索冷却5分钟
    EVENT_CHANCE: 0.15,                // 每刻事件触发概率15%
};

// 资源配置
const RESOURCES = {
    food: { name: '食物', icon: '🥫', desc: '维持生存的基本需求', color: '#C4612F' },
    water: { name: '水源', icon: '💧', desc: '生命之源', color: '#4A90E2' },
    material: { name: '材料', icon: '🔩', desc: '建设和维修必需品', color: '#7F8C8D' },
    fuel: { name: '燃料', icon: '⛽', desc: '探索和发电的动力', color: '#E67E22' },
};

// 设施配置（全新设计）
const FACILITIES = {
    shelter: {
        name: '避难所主体',
        icon: '🏚️',
        desc: '提供基本居住空间',
        maxLevel: 5,
        baseCost: { material: 20, fuel: 5 },
        benefit: (lv) => ({ capacity: 2 + lv * 2 }),
    },
    farm: {
        name: '农田',
        icon: '🌾',
        desc: '种植作物获取食物',
        maxLevel: 5,
        baseCost: { material: 15, water: 10 },
        benefit: (lv) => ({ foodRate: lv * 3 }),
    },
    well: {
        name: '水井',
        icon: '🚰',
        desc: '获取干净的水源',
        maxLevel: 5,
        baseCost: { material: 15, fuel: 8 },
        benefit: (lv) => ({ waterRate: lv * 3 }),
    },
    workshop: {
        name: '工坊',
        icon: '🔧',
        desc: '回收废料制造材料',
        maxLevel: 5,
        baseCost: { material: 10, fuel: 10 },
        benefit: (lv) => ({ materialRate: lv * 2 }),
    },
    generator: {
        name: '发电机',
        icon: '⚡',
        desc: '提供电力照明',
        maxLevel: 5,
        baseCost: { material: 25, fuel: 0 },
        benefit: (lv) => ({ fuelRate: lv * 1 }),
    },
    medic: {
        name: '医疗站',
        icon: '💊',
        desc: '治疗伤病恢复健康',
        maxLevel: 3,
        baseCost: { material: 30, food: 20 },
        benefit: (lv) => ({ healRate: lv * 5 }),
    },
    defense: {
        name: '防御工事',
        icon: '🛡️',
        desc: '抵御外来威胁',
        maxLevel: 5,
        baseCost: { material: 20, fuel: 15 },
        benefit: (lv) => ({ defense: lv * 10 }),
    },
};

// 幸存者技能系统
const SKILLS = {
    scavenger: { name: '拾荒者', icon: '🔍', bonus: '探索获得更多材料' },
    farmer: { name: '农夫', icon: '🌱', bonus: '提高农田产出' },
    engineer: { name: '工程师', icon: '🔧', bonus: '建造消耗减少' },
    medic: { name: '医生', icon: '💊', bonus: '加快伤病恢复' },
    soldier: { name: '战士', icon: '⚔️', bonus: '探索更安全' },
    cook: { name: '厨师', icon: '👨‍🍳', bonus: '食物消耗减少' },
};

// 探索地点
const LOCATIONS = [
    { id: 'market', name: '废弃超市', icon: '🏪', time: 2, risk: 20, rewards: { food: [10, 30], water: [10, 25] } },
    { id: 'factory', name: '工业区', icon: '🏭', time: 3, risk: 35, rewards: { material: [15, 40], fuel: [5, 15] } },
    { id: 'hospital', name: '医院废墟', icon: '🏥', time: 2, risk: 25, rewards: { material: [5, 15], food: [5, 10] } },
    { id: 'gasStation', name: '加油站', icon: '⛽', time: 2, risk: 30, rewards: { fuel: [20, 50], material: [5, 15] } },
    { id: 'residence', name: '居民区', icon: '🏘️', time: 1, risk: 15, rewards: { food: [5, 15], water: [5, 15], material: [3, 10] } },
    { id: 'warehouse', name: '仓库', icon: '📦', time: 4, risk: 40, rewards: { food: [20, 50], material: [20, 50], fuel: [10, 30] } },
];

// 随机事件库
const EVENTS = [
    {
        id: 'raider',
        type: 'threat',
        title: '劫掠者来袭',
        desc: '一群暴徒盯上了你的避难所',
        choices: [
            { text: '奋力抵抗', defense: 30, success: { desc: '成功击退了劫掠者', reward: { material: 10 } }, fail: { desc: '损失惨重', penalty: { food: -20, survivors: -1 } } },
            { text: '交出物资', cost: { food: 30, water: 20 }, desc: '用物资换取和平' },
        ],
    },
    {
        id: 'trader',
        type: 'opportunity',
        title: '流浪商人',
        desc: '一位商人路过，愿意交易物资',
        choices: [
            { text: '用材料换食物', cost: { material: 20 }, reward: { food: 40, water: 20 }, desc: '获得了补给' },
            { text: '用燃料换材料', cost: { fuel: 30 }, reward: { material: 50 }, desc: '获得了建材' },
            { text: '不交易', desc: '商人离开了' },
        ],
    },
    {
        id: 'survivor',
        type: 'opportunity',
        title: '幸存者求助',
        desc: '一位幸存者请求加入避难所',
        choices: [
            { text: '接纳', cost: { food: 10, water: 10 }, reward: { survivor: 1 }, desc: '新成员加入了' },
            { text: '拒绝', desc: '幸存者失望地离开了' },
        ],
    },
    {
        id: 'storm',
        type: 'disaster',
        title: '沙尘暴来袭',
        desc: '恶劣天气威胁避难所',
        choices: [
            { text: '加固设施', cost: { material: 15, fuel: 10 }, desc: '成功抵御了风暴' },
            { text: '听天由命', penalty: { material: -10, survivors: -1 }, desc: '遭受了损失' },
        ],
    },
    {
        id: 'plague',
        type: 'disaster',
        title: '疾病爆发',
        desc: '避难所内出现传染病',
        choices: [
            { text: '隔离治疗', cost: { food: 20, water: 20 }, desc: '控制了疫情' },
            { text: '放任不管', penalty: { survivors: -2 }, desc: '疫情扩散，损失惨重' },
        ],
    },
    {
        id: 'supply',
        type: 'opportunity',
        title: '空投物资',
        desc: '发现一个空投补给箱',
        choices: [
            { text: '取回物资', reward: { food: 30, water: 30, material: 20, fuel: 15 }, desc: '获得了大量补给' },
        ],
    },
];

// ==================== 工具函数 ====================
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

function formatTime(minutes) {
    if (minutes < 60) return `${minutes}分钟`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}小时${mins > 0 ? mins + '分钟' : ''}`;
}

function formatDate(timestamp) {
    const d = new Date(timestamp);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 获取联系人池
function getContactPool(roleId) {
    try {
        const store = new CharacterStore(roleId);
        return store.getFriendIds().filter(id => !isArchived(id));
    } catch {
        return [];
    }
}

// 随机技能
function randomSkill() {
    const keys = Object.keys(SKILLS);
    return keys[Math.floor(Math.random() * keys.length)];
}

// 生成新幸存者
function generateSurvivor(roleId, contactPool, usedIds, isLeader = false) {
    const availableContacts = contactPool.filter(id => !usedIds.includes(id));
    
    let id = null;
    let name = '无名者';
    
    if (isLeader) {
        id = roleId;
        name = getCharacterNameById(roleId) || '你';
    } else if (availableContacts.length > 0) {
        id = pick(availableContacts);
        name = getCharacterNameById(id) || '幸存者';
    } else {
        name = `幸存者${rand(100, 999)}`;
    }
    
    return {
        id,
        name,
        isLeader,
        health: 100,
        morale: isLeader ? 80 : rand(60, 80),
        skill: isLeader ? 'scavenger' : randomSkill(),
        status: 'idle',
        exploreStart: 0,
        exploreEnd: 0,
        exploreLocation: null,
    };
}

// ==================== 游戏状态管理 ====================
function createInitialState(roleId, leaderName) {
    const contactPool = getContactPool(roleId);
    const usedIds = [roleId];
    
    const survivors = [generateSurvivor(roleId, contactPool, usedIds, true)];
    
    // 初始添加2-3个随机幸存者
    const initialCount = rand(2, 3);
    for (let i = 0; i < initialCount; i++) {
        const survivor = generateSurvivor(roleId, contactPool, usedIds, false);
        if (survivor.id) usedIds.push(survivor.id);
        survivors.push(survivor);
    }
    
    return {
        version: 2,
        roleId,
        day: 1,
        survivors,
        usedIds,
        resources: {
            food: 80,
            water: 80,
            material: 40,
            fuel: 30,
        },
        facilities: {
            shelter: { level: 1 },
            farm: { level: 1 },
            well: { level: 1 },
            workshop: { level: 0 },
            generator: { level: 0 },
            medic: { level: 0 },
            defense: { level: 0 },
        },
        logs: [
            { time: Date.now(), text: '🏚️ 在废土中建立了避难所，生存之旅开始了...', type: 'system' }
        ],
        lastTick: Date.now(),
        lastEventCheck: Date.now(),
    };
}

async function loadState(roleId) {
    const saved = await getGameSave(GAME_ID, roleId).catch(() => null);
    if (saved && saved.version === 2) return saved;
    
    const leaderName = getCharacterNameById(roleId) || '你';
    return createInitialState(roleId, leaderName);
}

async function saveState(state) {
    if (state.logs.length > 200) state.logs = state.logs.slice(-200);
    state.lastTick = Date.now();
    return saveGameSave(GAME_ID, state.roleId, state);
}

// ==================== 游戏逻辑 ====================

// 计算设施效果
function getFacilityBenefit(state, facilityId) {
    const facility = state.facilities[facilityId];
    if (!facility || facility.level === 0) return {};
    return FACILITIES[facilityId].benefit(facility.level);
}

// 计算资源产出（每刻）
function calculateProduction(state) {
    const production = { food: 0, water: 0, material: 0, fuel: 0 };
    
    // 农田产出
    const farmBenefit = getFacilityBenefit(state, 'farm');
    if (farmBenefit.foodRate) {
        let rate = farmBenefit.foodRate;
        // 农夫加成
        const farmers = state.survivors.filter(s => s.skill === 'farmer' && s.status === 'idle').length;
        rate += farmers * 1;
        production.food += rate;
    }
    
    // 水井产出
    const wellBenefit = getFacilityBenefit(state, 'well');
    if (wellBenefit.waterRate) production.water += wellBenefit.waterRate;
    
    // 工坊产出
    const workshopBenefit = getFacilityBenefit(state, 'workshop');
    if (workshopBenefit.materialRate) production.material += workshopBenefit.materialRate;
    
    // 发电机产出
    const generatorBenefit = getFacilityBenefit(state, 'generator');
    if (generatorBenefit.fuelRate) production.fuel += generatorBenefit.fuelRate;
    
    return production;
}

// 计算资源消耗（每刻）
function calculateConsumption(state) {
    const consumption = { food: 0, water: 0, material: 0, fuel: 0 };
    
    // 每个幸存者消耗食物和水
    const survivorCount = state.survivors.length;
    consumption.food = survivorCount * 1;
    consumption.water = survivorCount * 1;
    
    // 厨师技能减少食物消耗
    const cooks = state.survivors.filter(s => s.skill === 'cook').length;
    consumption.food = Math.max(1, consumption.food - cooks * 0.5);
    
    // 设施维护消耗
    const workshopLevel = state.facilities.workshop?.level || 0;
    const generatorLevel = state.facilities.generator?.level || 0;
    consumption.fuel += Math.floor(generatorLevel * 0.5);
    
    return consumption;
}

// 游戏刻更新
function gameTick(state) {
    const production = calculateProduction(state);
    const consumption = calculateConsumption(state);
    
    // 更新资源
    for (const key in production) {
        state.resources[key] = Math.max(0, state.resources[key] + production[key] - consumption[key]);
    }
    
    // 资源不足的惩罚
    const penalties = [];
    if (state.resources.food <= 0) {
        state.survivors.forEach(s => {
            s.health = Math.max(0, s.health - 5);
            s.morale = Math.max(0, s.morale - 3);
        });
        penalties.push('缺少食物，幸存者饥饿');
    }
    if (state.resources.water <= 0) {
        state.survivors.forEach(s => {
            s.health = Math.max(0, s.health - 5);
            s.morale = Math.max(0, s.morale - 3);
        });
        penalties.push('缺少水源，幸存者口渴');
    }
    
    // 医疗站自动恢复健康
    const medicBenefit = getFacilityBenefit(state, 'medic');
    if (medicBenefit.healRate) {
        const medics = state.survivors.filter(s => s.skill === 'medic').length;
        const healAmount = medicBenefit.healRate + medics * 2;
        state.survivors.forEach(s => {
            if (s.health < 100) {
                s.health = Math.min(100, s.health + healAmount);
            }
        });
    }
    
    // 移除死亡的幸存者
    const deadCount = state.survivors.filter(s => s.health <= 0).length;
    state.survivors = state.survivors.filter(s => s.health > 0);
    
    // 记录日志
    if (production.food > 0 || production.water > 0 || production.material > 0 || production.fuel > 0) {
        const prodText = Object.entries(production)
            .filter(([k, v]) => v > 0)
            .map(([k, v]) => `${RESOURCES[k].icon}+${v}`)
            .join(' ');
        state.logs.push({ time: Date.now(), text: `⚙️ 设施产出: ${prodText}`, type: 'production' });
    }
    
    if (penalties.length > 0) {
        penalties.forEach(p => {
            state.logs.push({ time: Date.now(), text: `⚠️ ${p}`, type: 'warning' });
        });
    }
    
    if (deadCount > 0) {
        state.logs.push({ time: Date.now(), text: `💀 ${deadCount}名幸存者死亡`, type: 'danger' });
    }
    
    state.day++;
}

// 处理离线时间
function processOfflineTime(state) {
    const now = Date.now();
    const elapsed = now - state.lastTick;
    const maxOffline = CONFIG.OFFLINE_CAP_HOURS * 3600000;
    const actualElapsed = Math.min(elapsed, maxOffline);
    
    const ticks = Math.floor(actualElapsed / CONFIG.TICK_INTERVAL);
    
    if (ticks > 0) {
        for (let i = 0; i < Math.min(ticks, 10); i++) {
            gameTick(state);
        }
        
        const hours = Math.floor(actualElapsed / 3600000);
        state.logs.push({
            time: now,
            text: `⏰ 离线了${hours}小时，避难所继续运转`,
            type: 'system'
        });
    }
}

// 完成探索
function completeExploration(state, survivor) {
    const location = LOCATIONS.find(loc => loc.id === survivor.exploreLocation);
    if (!location) return;
    
    const gained = {};
    let hasInjury = false;
    
    // 计算收益
    for (const [resource, range] of Object.entries(location.rewards)) {
        let amount = rand(range[0], range[1]);
        
        // 拾荒者加成
        if (survivor.skill === 'scavenger') {
            amount = Math.floor(amount * 1.3);
        }
        
        gained[resource] = amount;
        state.resources[resource] = (state.resources[resource] || 0) + amount;
    }
    
    // 战士技能减少受伤概率
    const injuryChance = survivor.skill === 'soldier' ? location.risk * 0.6 : location.risk;
    
    if (Math.random() * 100 < injuryChance) {
        const damage = rand(10, 25);
        survivor.health = Math.max(0, survivor.health - damage);
        hasInjury = true;
    }
    
    // 士气变化
    if (hasInjury) {
        survivor.morale = Math.max(0, survivor.morale - 5);
    } else {
        survivor.morale = Math.min(100, survivor.morale + 5);
    }
    
    // 重置状态
    survivor.status = 'idle';
    survivor.exploreStart = 0;
    survivor.exploreEnd = 0;
    survivor.exploreLocation = null;
    
    // 记录日志
    const gainedText = Object.entries(gained)
        .filter(([, value]) => value > 0)
        .map(([key, value]) => `${RESOURCES[key].icon}+${value}`)
        .join(' ');

    state.logs.push({
        time: Date.now(),
        text: `${location.icon} ${survivor.name} 从「${location.name}」返回：${gainedText}${hasInjury ? '，途中受伤了。' : '，一切顺利。'}`,
        type: hasInjury ? 'warning' : 'explore'
    });
}

// 结算已完成的探索
function settleExplorations(state) {
    const now = Date.now();
    let changed = false;

    for (const survivor of state.survivors) {
        if (
            survivor.status === 'exploring' &&
            survivor.exploreEnd &&
            now >= survivor.exploreEnd
        ) {
            completeExploration(state, survivor);
            changed = true;
        }
    }

    return changed;
}

// 计算避难所容量
function getCapacity(state) {
    const level = state.facilities.shelter?.level || 1;
    return FACILITIES.shelter.benefit(level).capacity;
}

// 设施升级费用
function getUpgradeCost(state, facilityId) {
    const facility = FACILITIES[facilityId];
    const currentLevel = state.facilities[facilityId]?.level || 0;

    return Object.fromEntries(
        Object.entries(facility.baseCost).map(([key, value]) => [
            key,
            Math.ceil(value * (currentLevel + 1) * 0.8)
        ])
    );
}

function canAfford(state, cost) {
    return Object.entries(cost).every(
        ([key, value]) => (state.resources[key] || 0) >= value
    );
}

function payCost(state, cost) {
    for (const [key, value] of Object.entries(cost)) {
        state.resources[key] = Math.max(0, (state.resources[key] || 0) - value);
    }
}

function rewardResources(state, reward = {}) {
    for (const [key, value] of Object.entries(reward)) {
        if (key === 'survivor') continue;
        state.resources[key] = Math.max(0, (state.resources[key] || 0) + value);
    }
}

function resourceText(resources = {}) {
    return Object.entries(resources)
        .filter(([, value]) => value)
        .map(([key, value]) => {
            const meta = RESOURCES[key];
            return meta ? `${meta.icon}${value > 0 ? '+' : ''}${value}` : '';
        })
        .filter(Boolean)
        .join(' ');
}

function addLog(state, text, type = 'system') {
    state.logs.push({
        time: Date.now(),
        text,
        type
    });

    if (state.logs.length > 200) {
        state.logs = state.logs.slice(-200);
    }
}

function getStatusText(survivor) {
    if (survivor.status === 'exploring') {
        const left = Math.max(0, survivor.exploreEnd - Date.now());
        return `外出探索 · ${formatTime(Math.ceil(left / 60000))}`;
    }

    if (survivor.health < 40) return '重伤，需要治疗';
    if (survivor.health < 70) return '受伤';
    if (survivor.morale < 30) return '士气低落';

    return '待命';
}

function getStatusColor(survivor) {
    if (survivor.status === 'exploring') return '#b36b32';
    if (survivor.health < 40) return '#b94a48';
    if (survivor.morale < 30) return '#8767a8';
    return '#66806b';
}

function safeName(value) {
    return esc(String(value || '幸存者'));
}

function renderResourceCards(state) {
    return Object.entries(RESOURCES).map(([key, meta]) => {
        const amount = Math.floor(state.resources[key] || 0);

        return `
            <div class="sh-resource-card" style="--resource-color:${meta.color}">
                <div class="sh-resource-icon">${meta.icon}</div>
                <div class="sh-resource-info">
                    <div class="sh-resource-name">${meta.name}</div>
                    <div class="sh-resource-value">${amount}</div>
                </div>
            </div>
        `;
    }).join('');
}

function renderSurvivors(state) {
    return state.survivors.map((survivor, index) => {
        const skill = SKILLS[survivor.skill] || SKILLS.scavenger;
        const exploring = survivor.status === 'exploring';
        const statusColor = getStatusColor(survivor);

        return `
            <article class="sh-survivor-card">
                <div class="sh-survivor-avatar">
                    ${
                        survivor.id
                            ? getAvatarHtml(survivor.id)
                            : `<div class="sh-fallback-avatar">👤</div>`
                    }
                </div>

                <div class="sh-survivor-main">
                    <div class="sh-survivor-title">
                        <strong>${safeName(survivor.name)}</strong>
                        ${survivor.isLeader ? '<span class="sh-leader-tag">主视角</span>' : ''}
                    </div>

                    <div class="sh-survivor-skill">
                        ${skill.icon} ${skill.name}
                    </div>

                    <div class="sh-status-line" style="color:${statusColor}">
                        <span class="sh-status-dot"></span>
                        ${getStatusText(survivor)}
                    </div>

                    <div class="sh-stat-bars">
                        <div class="sh-stat-row">
                            <span>生命</span>
                            <div class="sh-bar">
                                <i style="width:${clamp(survivor.health, 0, 100)}%;background:#c87361"></i>
                            </div>
                            <b>${Math.floor(survivor.health)}</b>
                        </div>

                        <div class="sh-stat-row">
                            <span>士气</span>
                            <div class="sh-bar">
                                <i style="width:${clamp(survivor.morale, 0, 100)}%;background:#9b82b4"></i>
                            </div>
                            <b>${Math.floor(survivor.morale)}</b>
                        </div>
                    </div>
                </div>

                <button
                    class="sh-small-button"
                    data-explore-survivor="${index}"
                    ${exploring ? 'disabled' : ''}
                >
                    ${exploring ? '探索中' : '派出'}
                </button>
            </article>
        `;
    }).join('');
}

function renderFacilities(state) {
    return Object.entries(FACILITIES).map(([id, facility]) => {
        const level = state.facilities[id]?.level || 0;
        const maxed = level >= facility.maxLevel;
        const cost = getUpgradeCost(state, id);
        const affordable = !maxed && canAfford(state, cost);
        const benefit = level ? facility.benefit(level) : {};

        const benefitText = Object.entries(benefit)
            .map(([key, value]) => {
                const labels = {
                    capacity: `容量 +${value}`,
                    foodRate: `食物 +${value}/刻`,
                    waterRate: `水源 +${value}/刻`,
                    materialRate: `材料 +${value}/刻`,
                    fuelRate: `燃料 +${value}/刻`,
                    healRate: `治疗 +${value}/刻`,
                    defense: `防御 +${value}`
                };
                return labels[key] || '';
            })
            .filter(Boolean)
            .join(' · ');

        const costText = Object.entries(cost)
            .map(([key, value]) => `${RESOURCES[key]?.icon || ''}${value}`)
            .join(' ');

        return `
            <article class="sh-facility-card ${level === 0 ? 'is-locked' : ''}">
                <div class="sh-facility-icon">${facility.icon}</div>

                <div class="sh-facility-content">
                    <div class="sh-facility-header">
                        <strong>${facility.name}</strong>
                        <span>Lv.${level}/${facility.maxLevel}</span>
                    </div>

                    <p>${facility.desc}</p>
                    ${
                        benefitText
                            ? `<small>${benefitText}</small>`
                            : '<small>尚未启用</small>'
                    }
                </div>

                <button
                    class="sh-upgrade-button ${affordable ? 'can-upgrade' : ''}"
                    data-upgrade-facility="${id}"
                    ${maxed || !affordable ? 'disabled' : ''}
                >
                    ${maxed ? '已满级' : `升级<br><small>${costText}</small>`}
                </button>
            </article>
        `;
    }).join('');
}

function renderActivityLog(state) {
    const logs = state.logs.slice(-8).reverse();

    if (!logs.length) {
        return '<div class="sh-empty-log">还没有新的记录。</div>';
    }

    return logs.map(log => `
        <div class="sh-log-item sh-log-${log.type || 'system'}">
            <span class="sh-log-mark"></span>
            <div>
                <div>${esc(log.text)}</div>
                <time>${formatDate(log.time)}</time>
            </div>
        </div>
    `).join('');
}

function renderOverview(state) {
    const capacity = getCapacity(state);
    const exploringCount = state.survivors.filter(
        survivor => survivor.status === 'exploring'
    ).length;

    return `
        <section class="sh-overview">
            <div class="sh-overview-copy">
                <div class="sh-eyebrow">DAY ${state.day}</div>
                <h2>灰烬之上的<br><em>一点灯火</em></h2>
                <p>
                    这里还算安全。先让大家活下来，
                    再想办法把明天带回来。
                </p>
            </div>

            <div class="sh-shelter-illustration">
                <div class="sh-moon"></div>
                <div class="sh-mountain sh-mountain-back"></div>
                <div class="sh-mountain sh-mountain-front"></div>
                <div class="sh-house">
                    <span>🏚️</span>
                    <i></i>
                </div>
            </div>

            <div class="sh-overview-footer">
                <span>👥 ${state.survivors.length}/${capacity} 人</span>
                <span>🔍 ${exploringCount} 人在外</span>
                <span>🕯️ 今日平安</span>
            </div>
        </section>
    `;
}

function renderStyles() {
    if (document.getElementById('shelterV2Styles')) return;

    const style = document.createElement('style');
    style.id = 'shelterV2Styles';
    style.textContent = `
        #shelterV2Root {
            --ink: #302c28;
            --muted: #8d8177;
            --paper: #f5f0e8;
            --paper-deep: #e9dfd1;
            --card: rgba(255,255,255,.72);
            --accent: #a75d3d;
            --accent-dark: #70412f;
            height: 100%;
            overflow: hidden;
            color: var(--ink);
            background:
                radial-gradient(circle at 85% 8%, rgba(190,132,83,.18), transparent 28%),
                linear-gradient(145deg, #f7f1e8, #e9dfd4);
            font-family: ui-rounded, "SF Pro Rounded", "PingFang SC", sans-serif;
        }

        #shelterV2Root * {
            box-sizing: border-box;
        }

        .sh-app {
            height: 100%;
            display: flex;
            flex-direction: column;
        }

        .sh-topbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 13px 16px 10px;
            flex-shrink: 0;
        }

        .sh-topbar button {
            border: 0;
            color: var(--ink);
            background: rgba(255,255,255,.55);
            width: 34px;
            height: 34px;
            border-radius: 12px;
            font-size: 18px;
            cursor: pointer;
        }

        .sh-brand {
            text-align: center;
        }

        .sh-brand small {
            display: block;
            color: var(--muted);
            font-size: 9px;
            letter-spacing: 2px;
            text-transform: uppercase;
        }

        .sh-brand strong {
            font-size: 14px;
            letter-spacing: 1px;
        }

        .sh-scroll {
            flex: 1;
            overflow: auto;
            padding: 0 13px 22px;
            scrollbar-width: none;
        }

        .sh-scroll::-webkit-scrollbar {
            display: none;
        }

        .sh-overview {
            position: relative;
            min-height: 214px;
            overflow: hidden;
            margin: 2px 0 14px;
            padding: 22px 18px 14px;
            border-radius: 25px;
            background:
                linear-gradient(135deg, rgba(70,60,56,.96), rgba(117,72,55,.94));
            color: #fff8ee;
            box-shadow: 0 12px 24px rgba(77,49,35,.18);
        }

        .sh-overview-copy {
            position: relative;
            z-index: 2;
            max-width: 57%;
        }

        .sh-eyebrow {
            margin-bottom: 8px;
            color: #e9b993;
            font-size: 10px;
            letter-spacing: 3px;
            font-weight: 700;
        }

        .sh-overview h2 {
            margin: 0;
            font-size: 25px;
            line-height: 1.16;
            letter-spacing: -1px;
        }

        .sh-overview h2 em {
            color: #e7b17e;
            font-style: normal;
        }

        .sh-overview p {
            margin: 11px 0 0;
            color: rgba(255,248,238,.68);
            font-size: 11px;
            line-height: 1.7;
        }

        .sh-shelter-illustration {
            position: absolute;
            right: -4px;
            bottom: 30px;
            width: 50%;
            height: 150px;
        }

        .sh-moon {
            position: absolute;
            top: 8px;
            right: 22px;
            width: 48px;
            height: 48px;
            border-radius: 50%;
            background: #f5d7ad;
            box-shadow: 0 0 26px rgba(245,215,173,.36);
        }

        .sh-mountain {
            position: absolute;
            bottom: -18px;
            width: 150%;
            height: 100px;
            background: #4b3d3b;
            clip-path: polygon(0 100%, 28% 30%, 43% 58%, 63% 8%, 100% 100%);
        }

        .sh-mountain-front {
            right: -35px;
            bottom: -25px;
            opacity: .75;
            transform: scale(1.18);
        }

        .sh-house {
            position: absolute;
            right: 35px;
            bottom: 28px;
            z-index: 2;
            font-size: 57px;
            filter: drop-shadow(0 5px 4px rgba(0,0,0,.2));
        }

        .sh-house i {
            position: absolute;
            right: 18px;
            bottom: 8px;
            width: 9px;
            height: 17px;
            border-radius: 2px;
            background: #e5aa67;
            box-shadow: 0 0 12px #e5aa67;
        }

        .sh-overview-footer {
            position: absolute;
            right: 16px;
            bottom: 13px;
            left: 16px;
            z-index: 3;
            display: flex;
            justify-content: space-between;
            color: rgba(255,248,238,.72);
            font-size: 10px;
        }

        .sh-section-title {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin: 17px 3px 9px;
        }

        .sh-section-title strong {
            font-size: 14px;
        }

        .sh-section-title span {
            color: var(--muted);
            font-size: 10px;
        }

        .sh-resources {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 7px;
        }

        .sh-resource-card {
            min-width: 0;
            padding: 10px 7px;
            border: 1px solid rgba(255,255,255,.7);
            border-radius: 16px;
            background: var(--card);
            box-shadow: 0 5px 14px rgba(92,68,50,.06);
        }

        .sh-resource-icon {
            font-size: 19px;
        }

        .sh-resource-name {
            overflow: hidden;
            color: var(--muted);
            font-size: 9px;
            white-space: nowrap;
            text-overflow: ellipsis;
        }

        .sh-resource-value {
            margin-top: 2px;
            color: var(--resource-color);
            font-size: 16px;
            font-weight: 800;
        }

        .sh-survivor-card,
        .sh-facility-card {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 8px;
            padding: 10px;
            border: 1px solid rgba(255,255,255,.78);
            border-radius: 17px;
            background: var(--card);
            box-shadow: 0 5px 14px rgba(92,68,50,.05);
        }

        .sh-survivor-avatar {
            width: 42px;
            height: 42px;
            overflow: hidden;
            flex: 0 0 42px;
            border: 2px solid #eadaca;
            border-radius: 14px;
            background: #ded0c2;
        }

        .sh-survivor-avatar img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }

        .sh-fallback-avatar {
            display: grid;
            width: 100%;
            height: 100%;
            place-items: center;
            font-size: 21px;
        }

        .sh-survivor-main,
        .sh-facility-content {
            min-width: 0;
            flex: 1;
        }

        .sh-survivor-title,
        .sh-facility-header {
            display: flex;
            align-items: center;
            gap: 5px;
        }

        .sh-survivor-title strong,
        .sh-facility-header strong {
            overflow: hidden;
            font-size: 12px;
            white-space: nowrap;
            text-overflow: ellipsis;
        }

        .sh-leader-tag {
            padding: 2px 5px;
            border-radius: 5px;
            color: #96583c;
            background: #f1dfd0;
            font-size: 8px;
            white-space: nowrap;
        }

        .sh-survivor-skill {
            margin-top: 2px;
            color: #a47758;
            font-size: 10px;
        }

        .sh-status-line {
            margin-top: 3px;
            font-size: 9px;
        }

        .sh-status-dot {
            display: inline-block;
            width: 5px;
            height: 5px;
            margin-right: 3px;
            border-radius: 50%;
            background: currentColor;
        }

        .sh-stat-bars {
            display: flex;
            gap: 8px;
            margin-top: 5px;
        }

        .sh-stat-row {
            display: flex;
            align-items: center;
            gap: 3px;
            min-width: 0;
            color: var(--muted);
            font-size: 8px;
        }

        .sh-stat-row b {
            color: var(--ink);
            font-size: 8px;
        }

        .sh-bar {
            width: 34px;
            height: 4px;
            overflow: hidden;
            border-radius: 10px;
            background: #ded7d0;
        }

        .sh-bar i {
            display: block;
            height: 100%;
            border-radius: inherit;
        }

        .sh-small-button,
        .sh-upgrade-button {
            border: 0;
            border-radius: 11px;
            color: #fff;
            background: var(--accent);
            font-size: 10px;
            cursor: pointer;
        }

        .sh-small-button {
            padding: 8px 9px;
            white-space: nowrap;
        }

        .sh-small-button:disabled,
        .sh-upgrade-button:disabled {
            cursor: default;
            opacity: .42;
        }

        .sh-facility-card {
            align-items: center;
        }

        .sh-facility-icon {
            display: grid;
            width: 38px;
            height: 38px;
            flex: 0 0 38px;
            place-items: center;
            border-radius: 13px;
            background: #eadfd2;
            font-size: 20px;
        }

        .sh-facility-header span {
            margin-left: auto;
            color: var(--accent);
            font-size: 9px;
        }

        .sh-facility-content p {
            overflow: hidden;
            margin: 3px 0;
            color: var(--muted);
            font-size: 9px;
            white-space: nowrap;
            text-overflow: ellipsis;
        }

        .sh-facility-content small {
            color: #9d8069;
            font-size: 9px;
        }

        .sh-upgrade-button {
            min-width: 50px;
            padding: 6px 5px;
            line-height: 1.4;
            background: #80624d;
        }

        .sh-upgrade-button.can-upgrade {
            background: #a75d3d;
        }

        .sh-upgrade-button small {
            font-size: 8px;
        }

        .sh-empty-log {
            padding: 18px;
            text-align: center;
            color: var(--muted);
            font-size: 11px;
        }

        .sh-log-item {
            display: flex;
            gap: 9px;
            padding: 8px 4px;
            border-bottom: 1px dashed rgba(120,100,80,.16);
            color: #685d55;
            font-size: 10px;
            line-height: 1.5;
        }

        .sh-log-mark {
            width: 7px;
            height: 7px;
            margin-top: 4px;
            flex: 0 0 7px;
            border-radius: 50%;
            background: #a8917b;
        }

        .sh-log-warning .sh-log-mark {
            background: #c8874d;
        }

        .sh-log-danger .sh-log-mark {
            background: #b94a48;
        }

        .sh-log-item time {
            display: block;
            margin-top: 2px;
            color: #b1a49a;
            font-size: 8px;
        }

        .sh-bottom {
            display: flex;
            gap: 8px;
            padding: 10px 13px 14px;
            flex-shrink: 0;
            border-top: 1px solid rgba(120,100,80,.1);
            background: rgba(245,240,232,.9);
        }

        .sh-bottom button {
            flex: 1;
            padding: 11px 8px;
            border: 0;
            border-radius: 14px;
            color: #6d5749;
            background: #e8ddd1;
            font-size: 11px;
            font-weight: 700;
            cursor: pointer;
        }

        .sh-bottom button.primary {
            color: #fff;
            background: var(--accent);
        }

        .sh-modal-mask {
            position: absolute;
            inset: 0;
            z-index: 20;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
            background: rgba(42,33,29,.48);
            backdrop-filter: blur(4px);
        }

        .sh-modal {
            width: 100%;
            max-width: 330px;
            max-height: 82%;
            overflow: auto;
            padding: 18px;
            border: 1px solid rgba(255,255,255,.8);
            border-radius: 22px;
            background: #f9f4ed;
            box-shadow: 0 18px 50px rgba(35,23,16,.28);
        }

        .sh-modal h3 {
            margin: 0;
            font-size: 17px;
        }

        .sh-modal-desc {
            margin: 7px 0 14px;
            color: var(--muted);
            font-size: 11px;
            line-height: 1.6;
        }

        .sh-choice-button,
        .sh-location-button {
            width: 100%;
            margin-top: 8px;
            padding: 11px;
            border: 0;
            border-radius: 13px;
            color: #684c3c;
            background: #eadfd2;
            text-align: left;
            font-size: 11px;
            cursor: pointer;
        }

        .sh-choice-button:hover,
        .sh-location-button:hover {
            background: #e3cbb9;
        }

        .sh-location-button strong {
            display: block;
            font-size: 12px;
        }

        .sh-location-button small {
            display: block;
            margin-top: 3px;
            color: #9b8373;
        }

        .sh-modal-close {
            width: 100%;
            margin-top: 10px;
            padding: 10px;
            border: 0;
            border-radius: 12px;
            color: #8d8177;
            background: #e7ded5;
            font-size: 11px;
            cursor: pointer;
        }

        .sh-toast {
            position: absolute;
            top: 55px;
            left: 50%;
            z-index: 30;
            padding: 8px 13px;
            border-radius: 999px;
            color: #fff;
            background: rgba(46,37,32,.88);
            font-size: 11px;
            opacity: 0;
            pointer-events: none;
            transform: translate(-50%, -7px);
            transition: .25s ease;
        }

        .sh-toast.show {
            opacity: 1;
            transform: translate(-50%, 0);
        }
    `;

    document.head.appendChild(style);
}

function showModal(root, html) {
    const old = root.querySelector('.sh-modal-mask');
    if (old) old.remove();

    const mask = document.createElement('div');
    mask.className = 'sh-modal-mask';
    mask.innerHTML = `<div class="sh-modal">${html}</div>`;
    root.appendChild(mask);

    mask.addEventListener('click', event => {
        if (event.target === mask) mask.remove();
    });

    return mask;
}

function showToast(root, message) {
    const toast = root.querySelector('.sh-toast');
    if (!toast) return;

    toast.textContent = message;
    toast.classList.add('show');

    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
        toast.classList.remove('show');
    }, 2200);
}

function showExploreModal(root, state, survivorIndex, rerender) {
    const survivor = state.survivors[survivorIndex];
    if (!survivor || survivor.status === 'exploring') return;

    const locationsHtml = LOCATIONS.map(location => `
        <button class="sh-location-button" data-location="${location.id}">
            <strong>${location.icon} ${location.name}</strong>
            <small>
                ⏱ ${location.time} 小时
                · ⚠️ 风险 ${location.risk}%
                · ${resourceText(
                    Object.fromEntries(
                        Object.entries(location.rewards).map(([key, range]) => [
                            key,
                            `${range[0]}~${range[1]}`
                        ])
                    )
                )}
            </small>
        </button>
    `).join('');

    const modal = showModal(root, `
        <h3>派出 ${safeName(survivor.name)}</h3>
        <div class="sh-modal-desc">
            选择一个探索地点。探索时间越长，可能带回的物资越多，
            但风险也会随之提高。
        </div>
        ${locationsHtml}
        <button class="sh-modal-close">先不出发</button>
    `);

    modal.querySelectorAll('[data-location]').forEach(button => {
        button.addEventListener('click', async () => {
            const location = LOCATIONS.find(
                item => item.id === button.dataset.location
            );

            if (!location) return;

            survivor.status = 'exploring';
            survivor.exploreStart = Date.now();
            survivor.exploreEnd = Date.now() + location.time * 3600000;
            survivor.exploreLocation = location.id;

            addLog(
                state,
                `🔍 ${survivor.name} 前往「${location.name}」探索，预计 ${location.time} 小时后返回。`,
                'explore'
            );

            await saveState(state);
            modal.remove();
            rerender();
            showToast(root, `${location.icon} ${survivor.name} 已出发`);
        });
    });

    modal.querySelector('.sh-modal-close').addEventListener(
        'click',
        () => modal.remove()
    );
}

function showFacilityUpgrade(root, state, facilityId, rerender) {
    const facility = FACILITIES[facilityId];
    const level = state.facilities[facilityId]?.level || 0;

    if (!facility || level >= facility.maxLevel) return;

    const cost = getUpgradeCost(state, facilityId);

    if (!canAfford(state, cost)) {
        showToast(root, '物资不足，暂时无法升级');
        return;
    }

    const costText = Object.entries(cost)
        .map(([key, value]) => `${RESOURCES[key].icon}${value}`)
        .join('　');

    const modal = showModal(root, `
        <h3>${facility.icon} 升级${facility.name}</h3>
        <div class="sh-modal-desc">
            当前等级：Lv.${level}<br>
            升级后：Lv.${level + 1}<br><br>
            需要消耗：${costText}
        </div>
        <button class="sh-choice-button" id="confirmUpgrade">
            🔨 确认升级
        </button>
        <button class="sh-modal-close">取消</button>
    `);

    modal.querySelector('#confirmUpgrade').addEventListener(
        'click',
        async () => {
            if (!canAfford(state, cost)) {
                modal.remove();
                showToast(root, '物资不足');
                return;
            }

            payCost(state, cost);

            if (!state.facilities[facilityId]) {
                state.facilities[facilityId] = { level: 0 };
            }

            state.facilities[facilityId].level = level + 1;

            addLog(
                state,
                `🔨 ${facility.name} 已升级至 Lv.${level + 1}。`,
                'system'
            );

            await saveState(state);
            modal.remove();
            rerender();
            showToast(root, `${facility.icon} ${facility.name} 升级完成`);
        }
    );

    modal.querySelector('.sh-modal-close').addEventListener(
        'click',
        () => modal.remove()
    );
}

function showLogs(root, state) {
    const logs = state.logs.slice().reverse().map(log => `
        <div class="sh-log-item sh-log-${log.type || 'system'}">
            <span class="sh-log-mark"></span>
            <div>
                <div>${esc(log.text)}</div>
                <time>${formatDate(log.time)}</time>
            </div>
        </div>
    `).join('');

    const modal = showModal(root, `
        <h3>📜 避难所记录</h3>
        <div style="margin-top:12px">${logs || '<div class="sh-empty-log">暂无记录</div>'}</div>
        <button class="sh-modal-close">关闭</button>
    `);

    modal.querySelector('.sh-modal-close').addEventListener(
        'click',
        () => modal.remove()
    );
}

function handleRandomEvent(root, state, rerender) {
    if (Math.random() > CONFIG.EVENT_CHANCE) return;

    const event = pick(EVENTS);

    const choicesHtml = event.choices.map((choice, index) => {
        const costText = choice.cost
            ? ` · 消耗 ${resourceText(
                Object.fromEntries(
                    Object.entries(choice.cost).map(([key, value]) => [key, -value])
                )
            )}`
            : '';

        return `
            <button class="sh-choice-button" data-choice="${index}">
                ${choice.text}${costText}
            </button>
        `;
    }).join('');

    const modal = showModal(root, `
        <div style="font-size:30px;margin-bottom:5px;">
            ${event.type === 'threat' ? '⚠️' : event.type === 'disaster' ? '🌪️' : '🕯️'}
        </div>
        <h3>${event.title}</h3>
        <div class="sh-modal-desc">${event.desc}</div>
        ${choicesHtml}
    `);

    modal.querySelectorAll('[data-choice]').forEach(button => {
        button.addEventListener('click', async () => {
            const choice = event.choices[Number(button.dataset.choice)];

            if (choice.cost && !canAfford(state, choice.cost)) {
                showToast(root, '物资不足，无法选择这个方案');
                return;
            }

            if (choice.cost) payCost(state, choice.cost);

            if (choice.reward) {
                rewardResources(state, choice.reward);

                if (choice.reward.survivor) {
                    if (state.survivors.length < getCapacity(state)) {
                        const contacts = getContactPool(state.roleId);
                        const usedIds = state.usedIds || [];

                        const newSurvivor = generateSurvivor(
                            state.roleId,
                            contacts,
                            usedIds,
                            false
                        );

                        if (newSurvivor.id) usedIds.push(newSurvivor.id);
                        state.usedIds = usedIds;
                        state.survivors.push(newSurvivor);
                    }
                }
            }

            if (choice.penalty) {
                for (const [key, value] of Object.entries(choice.penalty)) {
                    if (key === 'survivors') {
                        const count = Math.abs(value);

                        for (let i = 0; i < count; i++) {
                            const target = state.survivors
                                .filter(survivor => !survivor.isLeader)
                                .sort((a, b) => a.health - b.health)[0];

                            if (target) {
                                state.survivors = state.survivors.filter(
                                    survivor => survivor !== target
                                );
                            }
                        }
                    } else {
                        state.resources[key] = Math.max(
                            0,
                            (state.resources[key] || 0) + value
                        );
                    }
                }
            }

            addLog(
                state,
                `🕯️ ${event.title}：${choice.desc || choice.text}。`,
                event.type === 'disaster' ? 'warning' : 'system'
            );

            await saveState(state);
            modal.remove();
            rerender();
        });
    });
}

function renderGame(root, state, onBack) {
    const rerender = () => renderGame(root, state, onBack);

    root.innerHTML = `
        <div class="sh-app">
            <header class="sh-topbar">
                <button id="shBack" aria-label="返回">‹</button>

                <div class="sh-brand">
                    <small>ASHES &amp; SHELTER</small>
                    <strong>末日安全屋</strong>
                </div>

                <button id="shRefresh" aria-label="刷新">↻</button>
            </header>

            <main class="sh-scroll">
                ${renderOverview(state)}

                <div class="sh-section-title">
                    <strong>避难所库存</strong>
                    <span>实时状态</span>
                </div>

                <section class="sh-resources">
                    ${renderResourceCards(state)}
                </section>

                <div class="sh-section-title">
                    <strong>在这里生活的人</strong>
                    <span>${state.survivors.length}/${getCapacity(state)}</span>
                </div>

                <section>
                    ${renderSurvivors(state)}
                </section>

                <div class="sh-section-title">
                    <strong>安全屋设施</strong>
                    <span>建设与升级</span>
                </div>

                <section>
                    ${renderFacilities(state)}
                </section>

                <div class="sh-section-title">
                    <strong>最近动态</strong>
                    <span>最后八条</span>
                </div>

                <section>
                    ${renderActivityLog(state)}
                </section>
            </main>

            <footer class="sh-bottom">
                <button id="shLogs">📜 记录</button>
                <button id="shEvent" class="primary">🕯️ 等待事件</button>
                <button id="shSave">保存</button>
            </footer>

            <div class="sh-toast"></div>
        </div>
    `;

    root.querySelector('#shBack').addEventListener('click', async () => {
        await saveState(state);
        onBack();
    });

    root.querySelector('#shRefresh').addEventListener('click', () => {
        settleExplorations(state);
        renderGame(root, state, onBack);
        showToast(root, '状态已更新');
    });

    root.querySelector('#shSave').addEventListener('click', async () => {
        await saveState(state);
        showToast(root, '💾 已保存当前进度');
    });

    root.querySelector('#shLogs').addEventListener(
        'click',
        () => showLogs(root, state)
    );

    root.querySelector('#shEvent').addEventListener(
        'click',
        () => handleRandomEvent(root, state, rerender)
    );

    root.querySelectorAll('[data-explore-survivor]').forEach(button => {
        button.addEventListener('click', () => {
            showExploreModal(
                root,
                state,
                Number(button.dataset.exploreSurvivor),
                rerender
            );
        });
    });

    root.querySelectorAll('[data-upgrade-facility]').forEach(button => {
        button.addEventListener('click', () => {
            showFacilityUpgrade(
                root,
                state,
                button.dataset.upgradeFacility,
                rerender
            );
        });
    });
}

export async function start(overlay, globalState, onBack) {
    renderStyles();

    const activeCharacter = globalState?.activeCharacter;
    const roleId =
        activeCharacter?.id ||
        getActiveCharacterId();

    const state = await loadState(roleId);

    // 兼容旧存档中缺失的字段
    state.resources ||= {
        food: 80,
        water: 80,
        material: 40,
        fuel: 30
    };

    state.survivors ||= [];
    state.facilities ||= {};
    state.logs ||= [];
    state.day ||= 1;
    state.usedIds ||= [];

    for (const facilityId of Object.keys(FACILITIES)) {
        if (!state.facilities[facilityId]) {
            state.facilities[facilityId] = { level: 0 };
        }
    }

    for (const survivor of state.survivors) {
        survivor.health ??= survivor.hp ?? 100;
        survivor.morale ??= 70;
        survivor.skill ??= 'scavenger';
        survivor.status ??= 'idle';
        survivor.exploreStart ??= 0;
        survivor.exploreEnd ??= survivor.exploreUntil ?? 0;
        survivor.exploreLocation ??= null;
    }

    processOfflineTime(state);
    settleExplorations(state);
    await saveState(state);

    const root = document.createElement('div');
    root.id = 'shelterV2Root';
    root.style.cssText = `
        position:absolute;
        inset:0;
        z-index:500;
    `;

    overlay.appendChild(root);
    renderGame(root, state, onBack);

    const tick = setInterval(async () => {
        if (!root.isConnected) {
            clearInterval(tick);
            return;
        }

        const now = Date.now();
        const elapsed = now - (state.lastTick || now);
        const ticks = Math.floor(elapsed / CONFIG.TICK_INTERVAL);

        if (ticks > 0) {
            for (let i = 0; i < Math.min(ticks, 30); i++) {
                gameTick(state);
            }

            state.lastTick = now;
            settleExplorations(state);
            await saveState(state);
            renderGame(root, state, onBack);
        } else if (settleExplorations(state)) {
            await saveState(state);
            renderGame(root, state, onBack);
        }
    }, 30000);

    root.addEventListener('click', event => {
        const target = event.target.closest('#shRefresh');
        if (target) {
            settleExplorations(state);
        }
    });
}

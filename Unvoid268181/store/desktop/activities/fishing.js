// store/desktop/activities/fishing.js — 桌面场景活动：钓鱼玩法

// ★ 鱼表：10 种，rarity 1~5；period: any / day(6-18) / night(18-6)；weight: [最小kg, 最大kg]
const FISH_TABLE = [
    { id: 'minnow', name: '小鲫鱼', emoji: '🐟', rarity: 1, value: 4, xp: 8, weight: [0.3, 0.8], period: 'any' },
    { id: 'golden_minnow', name: '金色小鱼', emoji: '🐠', rarity: 2, value: 7, xp: 12, weight: [0.4, 1.0], period: 'any' },
    { id: 'river_trout', name: '河鲑', emoji: '🐟', rarity: 3, value: 12, xp: 18, weight: [0.8, 2.2], period: 'any' },
    { id: 'red_koi', name: '红鳞鲤', emoji: '🐟', rarity: 3, value: 14, xp: 20, weight: [1.0, 2.8], period: 'day' },
    { id: 'moon_karp', name: '月光鲤', emoji: '🐡', rarity: 4, value: 18, xp: 26, weight: [1.5, 4.0], period: 'night' },
    { id: 'star_snapper', name: '星纹鲷', emoji: '🐠', rarity: 4, value: 20, xp: 28, weight: [1.8, 4.2], period: 'night' },
    { id: 'jade_tide', name: '翡翠潮鱼', emoji: '🐠', rarity: 4, value: 28, xp: 42, weight: [2.0, 5.5], period: 'any' },
    { id: 'silver_dragon', name: '银辉龙鱼', emoji: '🐲', rarity: 5, value: 50, xp: 80, weight: [3.5, 8.0], period: 'night' },
    { id: 'aurora_koi', name: '极光锦鲤', emoji: '🐡', rarity: 5, value: 60, xp: 90, weight: [3.0, 7.5], period: 'any' }  // ★ 隐藏鱼：极低权重
];

// ★ 杂物池（trash 时随机，漂流瓶可后续做叙事）
const TRASH_TABLE = [
    { id: 'trash_shoe', label: '破烂运动鞋', emoji: '👟' },
    { id: 'trash_can', label: '空罐头', emoji: '🥫' },
    { id: 'trash_key', label: '生锈的旧钥匙', emoji: '🗝️' },
    { id: 'trash_bottle', label: '漂流瓶（里面好像有纸条）', emoji: '🍾' }
];

const DEFAULT_STATE = {
    isActive: false, bait: '虫子', lastCatch: null, totalCaught: 0, cooldownUntil: 0,
    today: { fish: 0, trash: 0, xp: 0 }, todayKey: '',
    stockTotal: 100, stockRemaining: 100,   // ★ 每日水池库存：今天还能钓多少条
    history: []
};

// ★ 按当前时段 + 稀有度权重抽鱼，带重量
function rollFish() {
    const hour = new Date().getHours();
    const period = hour >= 6 && hour < 18 ? 'day' : 'night';
    const pool = FISH_TABLE.filter(f => f.period === 'any' || f.period === period);
    const weightedPool = pool.flatMap(f => Array.from({ length: Math.max(1, 6 - (f.rarity || 1)) }, () => f));
    const fish = weightedPool[Math.floor(Math.random() * weightedPool.length)] || FISH_TABLE[0];
    const [wMin, wMax] = fish.weight || [0.5, 1];
    const weight = Math.round((wMin + Math.random() * (wMax - wMin)) * 10) / 10;
    return { fish, weight };
}

// ---- 木牌（图鉴/成就展示）----
let profileBound = false;   // 双监听只绑一次

function bindProfileDismiss() {
    if (profileBound) return;
    profileBound = true;

    // ★ 点击非弹窗区域关闭
    document.addEventListener('click', (event) => {
        const modal = document.querySelector('.pond-profile-modal[data-floating="true"]:not([hidden])');
        const button = document.querySelector('.pond-sign-button[aria-expanded="true"]');
        if (!modal || !button) return;
        if (!button.contains(event.target) && !modal.contains(event.target)) {
            modal.hidden = true;
            button.setAttribute('aria-expanded', 'false');
        }
    }, { passive: true });

    // ★ 切页自动关闭（点 App 图标 → 图标点中 + 弹窗自动收）
    window.addEventListener('route-rendered', () => {
        const modal = document.querySelector('.pond-profile-modal[data-floating="true"]');
        const button = document.querySelector('.pond-sign-button');
        if (modal) modal.hidden = true;
        if (button) button.setAttribute('aria-expanded', 'false');
    });
}

function getProfile(manager, participantId = 'aoi') {
    const participant = manager.ensureParticipant(participantId);
    const allFish = FISH_TABLE.reduce((map, fish) => { map[fish.id] = fish; return map; }, {});
    const collection = Array.isArray(participant.collection) ? participant.collection : [];
    const collectionInfo = collection.map(id => allFish[id]).filter(Boolean).map(fish => ({ id: fish.id, name: fish.name, emoji: fish.emoji }));
    return {
        id: participant.id,
        name: participant.name,
        coins: participant.coins || 0,
        fishingLevel: participant.fishingLevel || 1,
        fishingXP: participant.fishingXP || 0,
        collection: collectionInfo,
        maxWeights: participant.maxWeights || {},      // ★ 最大重量
        totalFish: FISH_TABLE.length,                  // ★ 鱼种总数（9）
        achievements: participant.achievements && participant.achievements.length ? participant.achievements : ['初入池塘'],
        totalCaught: Math.max(0, participant.games?.fishing?.totalCaught || 0)
    };
}

function syncProfileModal(modal, manager, participantId) {
    const profile = getProfile(manager, participantId);
    const collectionCount = Array.isArray(profile.collection) ? profile.collection.length : 0;
    modal.innerHTML = `
        <div class="pond-modal-header">
            <span class="pond-modal-title">${profile.name || 'Aoi'}</span>
            <span class="pond-modal-badge">Lv.${profile.fishingLevel || 1}</span>
        </div>
        <div class="pond-modal-row"><span>金币</span><strong>${profile.coins || 0}</strong></div>
        <div class="pond-modal-row"><span>图鉴</span><strong>${collectionCount}/${profile.totalFish || 0}</strong></div>
        <div class="pond-modal-collection" style="margin:6px 0;display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;font-size:12px;">
            ${FISH_TABLE.map(f => {
        const caught = profile.collection.find(c => c.id === f.id);
        const maxW = caught ? (profile.maxWeights?.[f.id] || '') : '';
        return caught
            ? `<span style="color:#2d6b8a;">${f.emoji} ${f.name}${maxW ? ` <small style="color:#999;">最大 ${maxW}kg</small>` : ''}</span>`
            : `<span style="color:#bbb;">？ ${f.name}</span>`;
    }).join('')}
        </div>
        <div class="pond-modal-row"><span>成就</span><strong>${(profile.achievements || []).join('、') || '暂无'}</strong></div>
    `;
    const button = document.querySelector('.pond-sign-button');
    if (button) {
        button.textContent = '木牌';
        button.setAttribute('aria-label', `查看 ${profile.name || 'Aoi'} 钓鱼信息`);
    }
}

function ensureProfile(manager, node, participantId = 'aoi') {
    if (!node) return null;
    let sign = node.querySelector('[data-pond-sign="true"]');
    if (!sign) {
        sign = document.createElement('div');
        sign.className = 'pond-sign';
        sign.dataset.pondSign = 'true';
        sign.innerHTML = `<button class="pond-sign-button" type="button" aria-expanded="false" aria-label="查看 Aoi 钓鱼信息">木牌</button>`;
        node.appendChild(sign);
    }
    const button = sign.querySelector('.pond-sign-button');
    if (!button) return sign;

    const screen = document.querySelector('.phone-screen');
    let modal = document.querySelector('.pond-profile-modal[data-floating="true"]');
    if (!modal && screen) {
        modal = document.createElement('div');
        modal.className = 'pond-profile-modal';
        modal.dataset.floating = 'true';
        modal.hidden = true;
        screen.appendChild(modal);
    }
    if (!modal) return sign;

    button.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const isOpen = modal.hidden === false;
        modal.hidden = isOpen;
        button.setAttribute('aria-expanded', String(!isOpen));
        if (!isOpen) syncProfileModal(modal, manager, participantId);
    };

    bindProfileDismiss();   // ★ 双关闭监听（只绑一次）
    syncProfileModal(modal, manager, participantId);
    return sign;
}

export const fishingGame = {
    id: 'fishing',
    label: '钓鱼',
    description: '角色在水池边钓鱼，随机获得鱼、杂物与经验。',
    defaultParticipantId: 'aoi',
    defaultState: DEFAULT_STATE,
    fishTable: FISH_TABLE,
    trashTable: TRASH_TABLE,
    ensureProfile,
    getProfile,

    // ★ 玩法入口
    async trigger(manager, participantId, opts = {}) {
        const gameId = 'fishing';
        const state = manager.getGameState(participantId, gameId);
        const now = Date.now();

        const dayKey = new Date().toDateString();

        // ★ 兼容旧数据：库存字段缺失时补默认（防止老存档 undefined）
        if (typeof state.stockTotal !== 'number') state.stockTotal = 100;
        if (typeof state.stockRemaining !== 'number') state.stockRemaining = state.stockTotal;

        if (state.todayKey !== dayKey) {
            state.today = { fish: 0, trash: 0, xp: 0 };
            state.todayKey = dayKey;
            state.stockRemaining = state.stockTotal;   // ★ 每天重置库存
        }

        if (state.isActive) return state;
        if (state.cooldownUntil && now < state.cooldownUntil) {
            const remainingSeconds = Math.max(1, Math.ceil((state.cooldownUntil - now) / 1000));
            const node = opts.sourceNode || document.querySelector('.home-pond, [data-pond]');
            manager.renderToast(node, `⏳ ${remainingSeconds}s 后可再次钓鱼`, 'rgba(58,58,58,0.82)');
            return state;
        }
        if (state.stockRemaining <= 0) {
            const node = opts.sourceNode || document.querySelector('.home-pond, [data-pond]');
            manager.renderToast(node, '🐟 今天的鱼钓完了，明天再来吧');
            return state;
        }

        state.isActive = true;
        state.lastCatch = null;
        manager.setActiveGame(gameId);
        void manager.saveState();
        manager.refreshHud(opts.sourceNode, gameId, participantId);

        const sourceNode = opts.sourceNode || document.querySelector('.home-pond, [data-pond]');
        const floating = manager.renderToast(sourceNode, '🎣 开始钓鱼…');

        const duration = 1800 + Math.random() * 1400;

        // ★ 动画状态机（钓鱼专属）
        const actor = sourceNode?.querySelector('[data-actor-fishing]');
        const setActorPhase = (phase) => {
            if (!actor) return;
            actor.classList.remove('aoi-fishing-casting', 'aoi-fishing-hooked', 'aoi-fishing-reeling');
            if (phase) actor.classList.add('aoi-fishing-' + phase);
            const bubble = actor.querySelector('.aoi-fishing-bubble');
            if (bubble) bubble.textContent = phase === 'casting' ? '抛竿…' : phase === 'hooked' ? '咬钩了！' : phase === 'reeling' ? '收杆！' : '在钓鱼';
        };
        setActorPhase('casting');
        const hookedTimer = setTimeout(() => setActorPhase('hooked'), duration * 0.75);

        const result = setTimeout(() => {
            try {
                const isTreasure = Math.random() < 0.2;   // 20% 宝箱（稀有鱼）
                const isFish = Math.random() < 0.72;      // 72% 鱼
                let catchType = 'trash', label = '🗑️ 捡到杂物', xpGain = 6, coinGain = 0, weight = 0, fishId = null;

                if (isFish || isTreasure) {
                    const { fish, weight: w } = rollFish();
                    weight = w;
                    fishId = fish.id;
                    catchType = isTreasure ? 'rare' : 'fish';
                    label = `${fish.emoji} 抓到一条 ${fish.name}（${weight}kg）`;
                    xpGain = fish.xp || 8;
                    coinGain = fish.value || 4;
                    if (isTreasure) { xpGain += 10; coinGain += 6; }
                } else {
                    const trash = TRASH_TABLE[Math.floor(Math.random() * TRASH_TABLE.length)];
                    catchType = 'trash';
                    label = `${trash.emoji} ${trash.label}`;
                    xpGain = 4;
                    coinGain = 1;
                }

                const participant = manager.ensureParticipant(participantId);
                participant.coins = (participant.coins || 0) + coinGain;
                participant.fishingXP = (participant.fishingXP || 0) + xpGain;
                participant.fishingLevel = Math.max(1, Math.floor((participant.fishingXP || 0) / 80) + 1);

                if (catchType === 'fish' || catchType === 'rare') {
                    state.totalCaught += 1;
                    state.today.fish += 1;
                    if (state.stockRemaining > 0) state.stockRemaining -= 1;   // ★ 钓走一条，库存-1
                    if (!Array.isArray(participant.collection)) participant.collection = [];          // ★
                    if (!participant.collection.includes(fishId)) participant.collection.push(fishId);
                    // ★ 图鉴记录最大重量
                    participant.maxWeights = participant.maxWeights || {};
                    if (weight > (participant.maxWeights[fishId] || 0)) participant.maxWeights[fishId] = weight;
                    if (!Array.isArray(participant.achievements)) participant.achievements = ['初入池塘'];  // ★
                    if (participant.collection.length >= 1 && !participant.achievements.includes('初入池塘')) participant.achievements.push('初入池塘');
                } else {
                    state.today.trash += 1;
                }

                state.lastCatch = { type: catchType, fishId, label, weight, timestamp: Date.now(), xp: xpGain, coins: coinGain };
                state.today.xp += xpGain;
                state.history.push({ fishId, type: catchType, label, weight, xp: xpGain, coins: coinGain, at: Date.now() });
                if (state.history.length > 25) state.history = state.history.slice(-25);

                // ★ 收杆回写
                clearTimeout(hookedTimer);
                setActorPhase('reeling');
                manager.recordFishingResult(participantId, { label, coins: coinGain, xp: xpGain, fishId, weight, notes: catchType === 'trash' && fishId === null ? '捡到杂物' : '' }).catch(() => { });
                setTimeout(() => setActorPhase(null), 2600);

                state.isActive = false;
                state.cooldownUntil = Date.now() + 30 * 1000;
                manager.clearHook(gameId, participantId);
                void manager.saveState();
                manager.refreshHud(sourceNode, gameId, participantId);
                manager.renderToast(sourceNode, label, '#2e7d32');
                clearTimeout(floating);
            } catch (e) {
                // ★ 保险丝：结算失败也要复位，绝不卡死 isActive
                console.warn('🎣 钓鱼结算失败:', e);
                state.isActive = false;
                state.cooldownUntil = 0;
                manager.clearHook(gameId, participantId);
                void manager.saveState();
            }
        }, duration);

        manager.setHook(gameId, participantId, result);
        return state;
    }
};

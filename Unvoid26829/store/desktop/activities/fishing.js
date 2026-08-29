// store/desktop/activities/fishing.js — 桌面场景活动：钓鱼玩法
import { esc } from '../../utils.js';
import { getActiveCharacterId } from '../../CharacterStore.js';
import { getCharacterNameById } from '../../../apps/characterManager.js';
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
    { id: 'aurora_koi', name: '极光锦鲤', emoji: '🐡', rarity: 5, value: 60, xp: 90, weight: [3.0, 7.5], period: 'any' }
];

// ★ 杂物池
const TRASH_TABLE = [
    { id: 'trash_shoe', label: '破烂运动鞋', emoji: '👟' },
    { id: 'trash_can', label: '空罐头', emoji: '🥫' },
    { id: 'trash_key', label: '生锈的旧钥匙', emoji: '🗝️' }
];

const DEFAULT_STATE = {
    isActive: false,
    bait: '虫子',
    lastCatch: null,
    totalCaught: 0,
    cooldownUntil: 0,
    today: { fish: 0, trash: 0, xp: 0 },
    todayKey: '',
    stockTotal: 100,
    stockRemaining: 100,
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

// ---- 漂流瓶功能 ----

// ★ 投瓶接口（供外部调用）
export async function throwBottle({
    author = '匿名',
    authorId = null,
    content = '',
    emoji = '🍾',
    fromRole = 'character'
} = {}) {
    if (typeof content !== 'string') {
        return { success: false, reason: '瓶子内容格式无效' };
    }

    const safeContent = content.trim();
    const safeAuthor = typeof author === 'string'
        ? author.trim().slice(0, 50)
        : '匿名';
    const safeAuthorId = typeof authorId === 'string'
        ? authorId.slice(0, 100)
        : null;
    const safeEmoji = typeof emoji === 'string'
        ? emoji.trim().slice(0, 16)
        : '🍾';
    const safeRole = fromRole === 'creator'
        ? 'creator'
        : 'character';

    if (!safeContent) {
        return { success: false, reason: '瓶子里什么都没有' };
    }

    if (safeContent.length > 2000) {
        return { success: false, reason: '瓶子内容不能超过 2000 个字符' };
    }

    const manager = window.__desktopInteractionManager;
    if (!manager) {
        return { success: false, reason: '桌面互动未初始化' };
    }

    try {
        const bottle = {
            id: `bottle_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            author: safeAuthor || '匿名',
            authorId: safeAuthorId,
            content: safeContent,
            emoji: safeEmoji || '🍾',
            fromRole: safeRole,
            status: 'floating',
            thrownAt: Date.now(),
            caughtAt: null,
            caughtBy: null
        };

        const storedPool = await manager.loadBottlePool();
        const pool = Array.isArray(storedPool) ? storedPool : [];
        pool.push(bottle);

        // 优先保留漂浮中的瓶子，并最多保留最近捞起的 100 个。
        // 整体上限为 200，避免 IndexedDB 数据无限增长。
        const floatingBottles = pool
            .filter(item => item?.status === 'floating')
            .slice(-200);

        const caughtLimit = Math.max(0, 200 - floatingBottles.length);
        const caughtBottles = pool
            .filter(item => item?.status === 'caught')
            .slice(-Math.min(100, caughtLimit));

        await manager.saveBottlePool([
            ...floatingBottles,
            ...caughtBottles
        ]);

        return { success: true, bottle };
    } catch (error) {
        console.warn('投瓶失败:', error);
        return {
            success: false,
            reason: error?.message || '漂流瓶保存失败'
        };
    }
}

// ★ 随机捞瓶
async function pickRandomBottle(manager) {
    try {
        const pool = await manager.loadBottlePool();
        const floatingBottles = pool.filter(b => b.status === 'floating');
        if (floatingBottles.length === 0) return null;
        return floatingBottles[Math.floor(Math.random() * floatingBottles.length)];
    } catch {
        return null;
    }
}

// ★ 标记瓶子已捞起
async function markBottleCaught(manager, bottleId, catcherId) {
    try {
        const pool = await manager.loadBottlePool();
        const bottle = pool.find(b => b.id === bottleId);
        if (bottle) {
            bottle.status = 'caught';
            bottle.caughtAt = Date.now();
            bottle.caughtBy = catcherId;
            await manager.saveBottlePool(pool);
        }
    } catch (e) {
        console.warn('标记瓶子失败:', e);
    }
}

// ★ 瓶子弹窗（只展示，不写记忆）
function renderBottlePopup(node, bottle) {
    const target = node || document.querySelector('.home-pond, [data-pond]');
    if (!target || !bottle) return;

    const roleLabel = bottle.fromRole === 'creator'
        ? '缔造者'
        : (bottle.author || '匿名');

    const thrownAt = Number(bottle.thrownAt);
    const dateLabel = Number.isFinite(thrownAt)
        ? new Date(thrownAt).toLocaleDateString()
        : '未知日期';

    const popup = document.createElement('div');
    popup.className = 'bottle-popup';
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-modal', 'true');
    popup.setAttribute('aria-label', '漂流瓶内容');

    popup.innerHTML = `
        <div class="bottle-card">
            <div class="bottle-header">
                <span class="bottle-emoji">${esc(bottle.emoji || '🍾')}</span>
                <div class="bottle-meta">
                    <div class="bottle-author">来自 ${esc(roleLabel)}</div>
                    <div class="bottle-date">${esc(dateLabel)}</div>
                </div>
            </div>
            <div class="bottle-content">${esc(bottle.content || '')}</div>
            <button class="bottle-close" type="button">知道了</button>
        </div>
    `;

    popup.style.cssText = `
        position: absolute;
        inset: 0;
        z-index: 100;
        background: rgba(20, 30, 40, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        animation: bottleFadeIn 0.3s ease;
    `;

    const closePopup = () => popup.remove();

    popup.querySelector('.bottle-close')?.addEventListener('click', closePopup);

    popup.addEventListener('click', (event) => {
        if (event.target === popup) closePopup();
    });

    popup.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closePopup();
    });

    target.appendChild(popup);
    popup.querySelector('.bottle-close')?.focus();
}

// ★ 投瓶按钮
function ensureBottleButton(manager, node, context = {}) {
    if (!node) return null;
    let btn = node.querySelector('[data-pond-bottle="true"]');
    if (!btn) {
        btn = document.createElement('button');
        btn.className = 'pond-bottle-button';
        btn.dataset.pondBottle = 'true';
        btn.textContent = '🍾';
        btn.setAttribute('aria-label', '打开漂流瓶纸笺');
        btn.style.cssText = `
            position: absolute;
            right: 110px;
            top: 1px;
            width: 32px;
            height: 32px;
border: none;
border-radius: 8px;
background: transparent;
box-shadow: none;
color: #6f5135;
            font-size: 16px;
            cursor: pointer;
            -webkit-tap-highlight-color: transparent;
            user-select: none;
            z-index: 3;
        `;
        node.appendChild(btn);
    }

    btn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        showBottleEditor(manager, node, context);
    };

    return btn;
}

// ★ 投瓶编辑器
// ★ 替换 showBottleEditor 函数（不依赖 Aoi / app.js 全局状态）
async function showBottleEditor(manager, node, context = {}) {
    const screen = document.querySelector('.phone-screen');
    if (!screen) return;

    const activeId = getActiveCharacterId(context.globalState);
    let activeChar = null;

    if (activeId && activeId !== 'unknown') {
        const name = getCharacterNameById(activeId);
        if (name && name !== 'unknown' && name !== '未知角色') {
            activeChar = {
                id: activeId,
                name
            };
        }
    }

    const overlay = document.createElement('div');
    overlay.className = 'bottle-editor-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', '漂流瓶纸笺');

    overlay.innerHTML = `
        <div class="bottle-editor-paper">
            <div class="bottle-paper-fold" aria-hidden="true"></div>

            <div class="bottle-paper-topline">
                <span class="bottle-paper-mark" aria-hidden="true">瓶中笺</span>

                <label class="bottle-perspective-toggle ${activeChar ? '' : 'is-disabled'}">
                    <input
                        type="checkbox"
                        id="bottlePerspectiveToggle"
                        ${activeChar ? '' : 'disabled'}
                        aria-label="使用当前主视角署名"
                    >
                    <span class="bottle-toggle-track" aria-hidden="true">
                        <span class="bottle-toggle-thumb"></span>
                    </span>
                    <span class="bottle-toggle-label">
                        ${activeChar ? '主视角' : '无主视角'}
                    </span>
                </label>
            </div>

            <div class="bottle-paper-heading">写一封漂流笺</div>
            <div class="bottle-paper-hint">让它顺着水流，去到某个陌生的地方。</div>

            <textarea
                id="bottleContent"
                class="bottle-paper-textarea"
                rows="7"
                maxlength="2000"
                placeholder="写下想留下的话……"
            ></textarea>

            <div class="bottle-paper-footer">
                <span class="bottle-paper-note" id="bottleAuthorHint">
                    署名会随水流隐去
                </span>
                <span class="bottle-paper-count">最多 2000 字</span>
            </div>

            <div class="bottle-paper-actions">
                <button class="bottle-paper-cancel" id="bottleCancel" type="button">
                    收回
                </button>
                <button class="bottle-paper-send" id="bottleSend" type="button">
                    放入瓶中
                </button>
            </div>
        </div>
    `;

    screen.appendChild(overlay);

    const contentInput = overlay.querySelector('#bottleContent');
    const toggle = overlay.querySelector('#bottlePerspectiveToggle');
    const authorHint = overlay.querySelector('#bottleAuthorHint');
    const sendButton = overlay.querySelector('#bottleSend');

    const close = () => overlay.remove();

    const updateAuthorHint = () => {
        if (!authorHint) return;
        authorHint.textContent = toggle?.checked && activeChar
            ? `随 ${activeChar.name} 的名字漂流`
            : '署名会随水流隐去';
    };

    toggle?.addEventListener('change', updateAuthorHint);
    overlay.querySelector('#bottleCancel')?.addEventListener('click', close);

    overlay.addEventListener('click', event => {
        if (event.target === overlay) close();
    });

    overlay.addEventListener('keydown', event => {
        if (event.key === 'Escape') close();
    });

    sendButton?.addEventListener('click', async () => {
        const content = contentInput?.value.trim() || '';
        if (!content) {
            contentInput?.focus();
            return;
        }

        sendButton.disabled = true;
        sendButton.textContent = '放流中…';

        const usePerspective = Boolean(toggle?.checked && activeChar);
        const result = await throwBottle({
            author: usePerspective ? activeChar.name : '路过的旅人',
            authorId: usePerspective ? activeChar.id : null,
            content,
            emoji: '🍾',
            fromRole: usePerspective ? 'character' : 'creator'
        });

        if (!result.success) {
            sendButton.disabled = false;
            sendButton.textContent = '放入瓶中';
            manager.renderToast(node, `❌ ${result.reason}`, '#c62828');
            return;
        }

        close();
        manager.renderToast(node, '瓶子已经顺流而去了', '#4f795f');
    });

    updateAuthorHint();
    contentInput?.focus();
}

// ---- 木牌（图鉴/成就展示）----
let profileBound = false;

function bindProfileDismiss() {
    if (profileBound) return;
    profileBound = true;

    document.addEventListener('click', (event) => {
        const modal = document.querySelector('.pond-profile-modal[data-floating="true"]:not([hidden])');
        const button = document.querySelector('.pond-sign-button[aria-expanded="true"]');
        if (!modal || !button) return;
        if (!button.contains(event.target) && !modal.contains(event.target)) {
            modal.hidden = true;
            button.setAttribute('aria-expanded', 'false');
        }
    }, { passive: true });

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
        maxWeights: participant.maxWeights || {},
        totalFish: FISH_TABLE.length,
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

function ensureProfile(manager, node, participantId = 'aoi', context = {}) {
    if (!node) return null;

    // ★ 木牌
    let sign = node.querySelector('[data-pond-sign="true"]');
    if (!sign) {
        sign = document.createElement('div');
        sign.className = 'pond-sign';
        sign.dataset.pondSign = 'true';
        sign.innerHTML = `<button class="pond-sign-button" type="button" aria-expanded="false" aria-label="查看 Aoi 钓鱼信息">木牌</button>`;
        node.appendChild(sign);
    }
    const button = sign.querySelector('.pond-sign-button');
    if (button) {
        const screen = document.querySelector('.phone-screen');
        let modal = document.querySelector('.pond-profile-modal[data-floating="true"]');
        if (!modal && screen) {
            modal = document.createElement('div');
            modal.className = 'pond-profile-modal';
            modal.dataset.floating = 'true';
            modal.hidden = true;
            screen.appendChild(modal);
        }
        if (modal) {
            button.onclick = (event) => {
                event.preventDefault();
                event.stopPropagation();
                const isOpen = modal.hidden === false;
                modal.hidden = isOpen;
                button.setAttribute('aria-expanded', String(!isOpen));
                if (!isOpen) syncProfileModal(modal, manager, participantId);
            };
            bindProfileDismiss();
            syncProfileModal(modal, manager, participantId);
        }
    }

    // ★ 投瓶按钮
    ensureBottleButton(manager, node, context);

    return sign;
}

// ---- 钓鱼游戏主逻辑 ----

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

    async trigger(manager, participantId, opts = {}) {
        const gameId = 'fishing';
        const state = manager.getGameState(participantId, gameId);
        const now = Date.now();

        const dayKey = new Date().toDateString();

        if (typeof state.stockTotal !== 'number') state.stockTotal = 100;
        if (typeof state.stockRemaining !== 'number') state.stockRemaining = state.stockTotal;

        if (state.todayKey !== dayKey) {
            state.today = { fish: 0, trash: 0, xp: 0 };
            state.todayKey = dayKey;
            state.stockRemaining = state.stockTotal;
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

        const result = setTimeout(async () => {
            try {
                const isTreasure = Math.random() < 0.2;
                const isBottle = Math.random() < 0.12;
                const isFish = Math.random() < 0.72;

                let catchType = 'trash', label = '🗑️ 捡到杂物', xpGain = 6, coinGain = 0, weight = 0, fishId = null, bottleData = null;

                if (isBottle) {
                    const bottle = await pickRandomBottle(manager);
                    if (bottle) {
                        catchType = 'bottle';
                        bottleData = bottle;
                        label = `${bottle.emoji} 漂流瓶（${bottle.fromRole === 'creator' ? '缔造者' : bottle.author}）`;
                        xpGain = 15;
                        coinGain = 5;
                        await markBottleCaught(manager, bottle.id, participantId);
                    } else {
                        const trash = TRASH_TABLE[Math.floor(Math.random() * TRASH_TABLE.length)];
                        catchType = 'trash';
                        label = `${trash.emoji} ${trash.label}`;
                        xpGain = 4;
                        coinGain = 1;
                    }
                } else if (isFish || isTreasure) {
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
                    if (state.stockRemaining > 0) state.stockRemaining -= 1;
                    if (!Array.isArray(participant.collection)) participant.collection = [];
                    if (!participant.collection.includes(fishId)) participant.collection.push(fishId);
                    participant.maxWeights = participant.maxWeights || {};
                    if (weight > (participant.maxWeights[fishId] || 0)) participant.maxWeights[fishId] = weight;
                    if (!Array.isArray(participant.achievements)) participant.achievements = ['初入池塘'];
                    if (participant.collection.length >= 1 && !participant.achievements.includes('初入池塘')) participant.achievements.push('初入池塘');
                } else if (catchType === 'bottle') {
                    state.today.trash += 1;
                } else {
                    state.today.trash += 1;
                }

                state.lastCatch = {
                    type: catchType,
                    fishId,
                    label,
                    weight,
                    timestamp: Date.now(),
                    xp: xpGain,
                    coins: coinGain,
                    bottleId: bottleData?.id || null
                };
                state.today.xp += xpGain;
                state.history.push({
                    fishId,
                    type: catchType,
                    label,
                    weight,
                    xp: xpGain,
                    coins: coinGain,
                    bottleId: bottleData?.id || null,
                    at: Date.now()
                });
                if (state.history.length > 25) state.history = state.history.slice(-25);

                clearTimeout(hookedTimer);
                setActorPhase('reeling');
                // 漂流瓶只展示给 Aoi，不自动写入记忆。
                // 普通鱼和杂物仍按原逻辑记录钓鱼结果。
                if (catchType !== 'bottle') {
                    manager.recordFishingResult(participantId, {
                        label,
                        coins: coinGain,
                        xp: xpGain,
                        fishId,
                        weight,
                        notes: catchType === 'trash' ? '捡到杂物' : ''
                    }).catch(() => { });
                }
                setTimeout(() => setActorPhase(null), 2600);

                state.isActive = false;
                state.cooldownUntil = Date.now() + 30 * 1000;
                manager.clearHook(gameId, participantId);
                void manager.saveState();
                manager.refreshHud(sourceNode, gameId, participantId);

                if (catchType === 'bottle') {
                    renderBottlePopup(sourceNode, bottleData, participantId, manager);
                } else {
                    manager.renderToast(sourceNode, label, '#2e7d32');
                }
                clearTimeout(floating);
            } catch (e) {
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
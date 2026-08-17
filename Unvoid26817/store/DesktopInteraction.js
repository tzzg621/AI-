// store/DesktopInteraction.js
// 桌面互动独立入口：专门放桌面小游戏/交互逻辑，不直接改动首页、Aoi、DeskPet 等已有模块。
// 架构目标：
// 1. 鱼表集中管理：后续加鱼直接在 FISH_TABLE 追加
// 2. 每个小游戏一个定义：游戏状态互不污染
// 3. 每个参与者一个状态：例如 Aoi 单独一份数据
// 4. 底层持久化切到 IndexedDB：后续数据量更稳妥

import { getAoiInstance } from './Aoi/aoi.js';
import { esc } from './utils.js';   // ★ 用现成的

const STORAGE_KEY = 'desktop_interaction_cache_v1';
const DB_NAME = 'desktop_interaction';
const DB_VERSION = 1;

const STORE_NAMES = {
    meta: 'meta',
    participants: 'participants',
    gameStates: 'game_states',
    eventLog: 'event_log',
    fishCatalog: 'fish_catalog'
};

const FISH_TABLE = [
    { id: 'minnow', name: '小鲫鱼', emoji: '🐟', rarity: 1, value: 4, xp: 8 },
    { id: 'golden_minnow', name: '金色小鱼', emoji: '🐠', rarity: 2, value: 7, xp: 12 },
    { id: 'river_trout', name: '河鲑', emoji: '🐟', rarity: 3, value: 12, xp: 18 },
    { id: 'moon_karp', name: '月光鲤', emoji: '🐡', rarity: 4, value: 18, xp: 26 },
    { id: 'jade_tide', name: '翡翠潮鱼', emoji: '🐠', rarity: 5, value: 28, xp: 42 }
];

const GAME_DEFS = {
    fishing: {
        id: 'fishing',
        label: '钓鱼',
        description: 'Aoi 在水池旁边钓鱼，随机获得鱼、杂物与经验。',
        defaultParticipantId: 'aoi',
        defaultState: {
            isActive: false,
            bait: '虫子',
            lastCatch: null,
            totalCaught: 0,
            cooldownUntil: 0,
            today: {
                fish: 0,
                trash: 0,
                xp: 0
            },
            history: []
        }
    }
};

const DEFAULT_STATE = {
    version: 1,
    activeGame: null,
    games: {},
    participants: {}
};

function safeJsonParse(raw, fallback) {
    try {
        return raw ? JSON.parse(raw) : fallback;
    } catch {
        return fallback;
    }
}

function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function cloneDefaultState(gameId) {
    return deepClone(GAME_DEFS[gameId]?.defaultState || {});
}

function createParticipantRecord(participantId) {
    const participantName = participantId === 'aoi' ? 'Aoi' : participantId;
    return {
        id: participantId,
        name: participantName,
        coins: 0,
        fishingLevel: 1,
        fishingXP: 0,
        collection: [],
        achievements: ['初入池塘'],
        games: {}
    };
}

function mergeDefaultState(state) {
    const merged = {
        ...DEFAULT_STATE,
        ...(state || {})
    };

    merged.games = merged.games || {};
    merged.participants = merged.participants || {};

    Object.keys(GAME_DEFS).forEach((gameId) => {
        if (!merged.games[gameId]) {
            merged.games[gameId] = {
                id: gameId,
                label: GAME_DEFS[gameId].label,
                description: GAME_DEFS[gameId].description,
                participants: []
            };
        }
    });

    if (!merged.participants.aoi) {
        merged.participants.aoi = createParticipantRecord('aoi');
    }

    Object.keys(merged.participants).forEach((participantId) => {
        if (!merged.participants[participantId].games) {
            merged.participants[participantId].games = {};
        }
        Object.keys(GAME_DEFS).forEach((gameId) => {
            if (!merged.participants[participantId].games[gameId]) {
                merged.participants[participantId].games[gameId] = cloneDefaultState(gameId);
            }
        });
    });

    Object.keys(GAME_DEFS).forEach((gameId) => {
        if (!merged.participants.aoi.games[gameId]) {
            merged.participants.aoi.games[gameId] = cloneDefaultState(gameId);
        }
    });

    return merged;
}

function openDatabase() {
    return new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) {
            reject(new Error('当前浏览器不支持 IndexedDB'));
            return;
        }

        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;

            Object.keys(STORE_NAMES).forEach((name) => {
                if (!db.objectStoreNames.contains(STORE_NAMES[name])) {
                    db.createObjectStore(STORE_NAMES[name], { keyPath: 'id' });
                }
            });

            const metaStore = request.transaction.objectStore(STORE_NAMES.meta);
            metaStore.createIndex('keyIndex', 'key', { unique: true });
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('无法打开 IndexedDB'));
    });
}

async function readFromDB(storeName, key) {
    try {
        const db = await openDatabase();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error || new Error('read failed'));
        });
    } catch {
        return null;
    }
}

async function writeToDB(storeName, value, key = value?.id || 'root') {
    try {
        const db = await openDatabase();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            const request = store.put({ ...value, id: key });
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('write failed'));
        });
    } catch {
        return null;
    }
}

async function readRootStateFromDB() {
    const value = await readFromDB(STORE_NAMES.meta, 'root_state');
    if (!value || !value.payload) return null;
    return mergeDefaultState(value.payload);
}

async function persistRootStateToDB(state) {
    await writeToDB(STORE_NAMES.meta, { id: 'root_state', key: 'root_state', payload: state }, 'root_state');
}

export class DesktopInteractionManager {
    constructor() {
        this.state = this.loadState();
        this.bound = false;
        this.currentHook = null;
        this.profileDismissListenerBound = false;
        this.boundNodes = new WeakSet();
        this.documentClickHandler = this.handleDocumentClick.bind(this);
        this.interactionEnabled = false;
        this.gameRegistry = new Map();
        this.fishTable = FISH_TABLE;
        this.dbReady = this.bootstrap();
        this._initBuiltinGames();
    }

    sanitizePersistedActiveState() {
        let changed = false;
        const now = Date.now();

        Object.keys(this.state.participants || {}).forEach((participantId) => {
            const participant = this.state.participants[participantId];
            if (!participant || !participant.games) return;

            Object.keys(GAME_DEFS).forEach((gameId) => {
                const gameState = participant.games[gameId];
                if (!gameState || !gameState.isActive) return;

                const hasValidCooldown = typeof gameState.cooldownUntil === 'number' && gameState.cooldownUntil > now;
                if (!hasValidCooldown) {
                    gameState.isActive = false;
                    gameState.lastCatch = null;
                    changed = true;
                }
            });
        });

        if (changed) {
            void this.saveState();
        }
    }

    async bootstrap() {
        try {
            const dbState = await readRootStateFromDB();
            if (dbState) {
                this.state = mergeDefaultState(dbState);
            }
        } catch {
            // ignore, fallback to cache/local state
        }

        this.ensureParticipant('aoi');
        this.sanitizePersistedActiveState();
        await this.saveState();
    }

    loadState() {
        const fallback = safeJsonParse(localStorage.getItem(STORAGE_KEY), null);
        return mergeDefaultState(fallback || DEFAULT_STATE);
    }

    async saveState() {
        this.state = mergeDefaultState(this.state);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));

        try {
            await persistRootStateToDB(this.state);
        } catch {
            // no-op: still keep local cache for safety
        }
    }

    _initBuiltinGames() {
        Object.keys(GAME_DEFS).forEach((gameId) => {
            this.registerGame(gameId, {
                ...GAME_DEFS[gameId],
                start: (participantId, ctx) => this.startGame(gameId, participantId, ctx),
                stop: (participantId) => this.stopGame(gameId, participantId),
                getState: (participantId) => this.getGameState(participantId, gameId)
            });
        });
    }

    registerGame(gameId, config) {
        this.gameRegistry.set(gameId, config);
        this.ensureGameMetadata(gameId, config);
    }

    ensureGameMetadata(gameId, config = GAME_DEFS[gameId] || {}) {
        if (!this.state.games[gameId]) {
            this.state.games[gameId] = {
                id: gameId,
                label: config.label || gameId,
                description: config.description || '',
                participants: []
            };
        }
        return this.state.games[gameId];
    }

    ensureParticipant(participantId = 'aoi') {
        if (!this.state.participants[participantId]) {
            this.state.participants[participantId] = createParticipantRecord(participantId);
        }
        if (!this.state.participants[participantId].games) {
            this.state.participants[participantId].games = {};
        }
        Object.keys(GAME_DEFS).forEach((gameId) => {
            if (!this.state.participants[participantId].games[gameId]) {
                this.state.participants[participantId].games[gameId] = cloneDefaultState(gameId);
            }
        });
        return this.state.participants[participantId];
    }

    getGameState(participantId = 'aoi', gameId = 'fishing') {
        const participant = this.ensureParticipant(participantId);
        if (!participant.games[gameId]) {
            participant.games[gameId] = cloneDefaultState(gameId);
        }
        return participant.games[gameId];
    }

    getParticipantSummary(participantId = 'aoi') {
        const participant = this.ensureParticipant(participantId);
        return {
            id: participant.id,
            name: participant.name,
            games: Object.keys(participant.games).reduce((acc, gameId) => {
                acc[gameId] = participant.games[gameId];
                return acc;
            }, {})
        };
    }

    setActiveGame(gameId) {
        this.state.activeGame = gameId;
        void this.saveState();
    }

    clearFishingState(gameId = 'fishing', participantId = 'aoi') {
        const state = this.getGameState(participantId, gameId);
        state.isActive = false;
        state.lastCatch = null;

        if (this.currentHook?.timer && this.currentHook.gameId === gameId && this.currentHook.participantId === participantId) {
            clearTimeout(this.currentHook.timer);
            this.currentHook.timer = null;
        }
        this.currentHook = null;
        return state;
    }

    destroy() {
        if (this.profileDismissListenerBound) {
            document.removeEventListener('click', this.documentClickHandler);
            this.profileDismissListenerBound = false;
        }

        if (this.boundNodes && typeof this.boundNodes === 'object') {
            // no-op: the WeakSet cannot be enumerated, but node-level listeners are removed below when nodes are re-bound or re-rendered
        }

        this.currentHook = null;
        this.bound = false;
    }

    bindGlobalListeners() {
        if (this.profileDismissListenerBound) return;
        document.addEventListener('click', this.documentClickHandler, { passive: true });
        this.profileDismissListenerBound = true;
    }

    handleDocumentClick(event) {
        const modal = document.querySelector('.pond-profile-modal[data-floating="true"]:not([hidden])');
        const button = document.querySelector('.pond-sign-button[aria-expanded="true"]');
        if (!modal || !button) return;
        const hitInsideButton = button.contains(event.target);
        const hitInsideModal = modal.contains(event.target);
        if (!hitInsideButton && !hitInsideModal) {
            modal.hidden = true;
            button.setAttribute('aria-expanded', 'false');
        }
    }

    init(root = document) {
        this.sanitizePersistedActiveState();

        if (!this.bound) {
            this.bound = true;
            const pondNodes = root.querySelectorAll('[data-desktop-game="fishing"], .home-pond, [data-pond]');
            pondNodes.forEach((node) => this.bindGameNode('fishing', 'aoi', node));

            window.addEventListener('theme-changed', () => this.refreshHud());
            window.addEventListener('desk-rendered', () => {
                const pondNodesNow = document.querySelectorAll('[data-desktop-game="fishing"], .home-pond, [data-pond]');
                pondNodesNow.forEach((node) => this.bindGameNode('fishing', 'aoi', node));
            });
        } else {
            const pondNodes = root.querySelectorAll('[data-desktop-game="fishing"], .home-pond, [data-pond]');
            pondNodes.forEach((node) => this.bindGameNode('fishing', 'aoi', node));
        }

        if (this.interactionEnabled) {
            this.bindGlobalListeners();
        }
        return this;
    }

    async ensureAoiFishingPresence(node, participantId = 'aoi') {
        if (!node || participantId !== 'aoi') return null;

        // ★ 行程判断：scene=pond 且未到回来时刻 → 在池塘
        let aoi = null;
        try { aoi = await getAoiInstance(); } catch { }
        const now = Date.now();
        const inTrip = aoi?.runtime?.scene === 'pond' && (!aoi.runtime.until || now < aoi.runtime.until);

        let actor = node.querySelector('[data-aoi-fishing-actor="true"]');

        // ★ 超时/不在池塘 → 若 scene 还是 pond（超时），自动结算回缔造者空间（刷新后也会自动恢复）
        if (!inTrip) {
            try {
                if (aoi?.runtime?.scene === 'pond' && aoi?.setRuntime) {
                    await aoi.setRuntime({ scene: 'creator', activity: 'idle', until: 0 });
                }
            } catch { }
            if (actor) actor.remove();
            return null;
        }

        // 在池塘 → 没有就创建
        if (!actor) {
            actor = document.createElement('div');
            actor.dataset.aoiFishingActor = 'true';
            actor.className = 'aoi-fishing-avatar';
            actor.innerHTML = `
            <div class="aoi-fishing-pod">
                <div class="aoi-fishing-body">Aoi</div>
                <div class="aoi-fishing-bubble">在钓鱼</div>
            </div>
        `;
            node.appendChild(actor);
        }

        try {
            if (aoi && aoi._ready) {
                const label = actor.querySelector('.aoi-fishing-bubble');
                if (label) label.textContent = '在钓鱼';
            }
        } catch { }

        // ★ 点击 Aoi 小人 → 池塘场景对话（同一套 Aoi 记忆/逻辑）
        if (!actor.dataset.chatBound) {
            actor.dataset.chatBound = 'true';
            actor.style.cursor = 'pointer';
            actor.addEventListener('click', (e) => {
                e.stopPropagation();
                this.openPondChat(node);
            });
        }
        return actor;
    }

    // ★ 池塘场景对话小窗（独立设计；记忆同源 aoi.chat，历史独立存 sessionStorage）
    async openPondChat(node) {
        if (window.__pondChatOpen) return;
        window.__pondChatOpen = true;

        const screen = document.querySelector('.phone-screen');
        if (!screen) { window.__pondChatOpen = false; return; }

        try {
            const aoi = await getAoiInstance();
            const POND_CHAT_KEY = 'pond_chat_history';
            let history = [];
            try { history = JSON.parse(sessionStorage.getItem(POND_CHAT_KEY) || '[]'); } catch { }

            const wrap = document.createElement('div');
            wrap.className = 'pond-chat-overlay';
            wrap.innerHTML = `
            <div class="pond-chat-card">
                <div class="pond-chat-head">
                    <span class="pond-chat-title">💠 Aoi · 池塘边</span>
                    <button class="pond-chat-call">🏠 叫Aoi回来</button>
                    <button class="pond-chat-close">✕</button>
                </div>
                <div class="pond-chat-body">
                    ${history.length ? history.map(m => `<div class="pond-msg ${m.role}">${m.html}</div>`).join('')
                    : '<div class="pond-msg agent">🐟 在这待着真舒服……你怎么也来池塘边了？</div>'}
                </div>
                <div class="pond-chat-input-row">
                    <input class="pond-chat-input" placeholder="和 Aoi 说点什么…" />
                    <button class="pond-chat-send">发送</button>
                </div>
            </div>`;
            screen.appendChild(wrap);

            const body = wrap.querySelector('.pond-chat-body');
            const input = wrap.querySelector('.pond-chat-input');
            const sendBtn = wrap.querySelector('.pond-chat-send');
            const closeBtn = wrap.querySelector('.pond-chat-close');
            const callBtn = wrap.querySelector('.pond-chat-call');
            callBtn?.addEventListener('click', async () => {
                // ★ 提前结束行程：Aoi 回缔造者空间（持久化+广播 → 小人消失、桌面对话恢复）
                await aoi.setRuntime({ scene: 'creator', activity: 'idle', until: 0 });
                wrap.remove();
                window.__pondChatOpen = false;
            });

            const pushMsg = (role, html) => {
                history.push({ role, html });
                if (history.length > 40) history = history.slice(-40);
                try { sessionStorage.setItem(POND_CHAT_KEY, JSON.stringify(history)); } catch { }
                const el = document.createElement('div');
                el.className = 'pond-msg ' + role;
                el.innerHTML = html;
                body.appendChild(el);
                body.scrollTop = body.scrollHeight;
            };

            const send = async () => {
                const text = input.value.trim();
                if (!text) return;
                input.value = '';
                pushMsg('user', esc(text));
                const loading = document.createElement('div');
                loading.className = 'pond-msg agent pond-loading';
                loading.textContent = '⏳ Aoi 想了想…';
                body.appendChild(loading);
                body.scrollTop = body.scrollHeight;
                try {
                    const result = await aoi.chat(text, { fromScene: 'pond' });
                    loading.remove();
                    pushMsg('agent', esc(result.reply));
                } catch (e) {
                    loading.remove();
                    pushMsg('agent', '❌ ' + esc(e.message));
                }
            };

            sendBtn.addEventListener('click', send);
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
            closeBtn.addEventListener('click', () => { wrap.remove(); window.__pondChatOpen = false; });
            wrap.addEventListener('click', (e) => { if (e.target === wrap) { wrap.remove(); window.__pondChatOpen = false; } });
            body.scrollTop = body.scrollHeight;
        } catch (e) {
            console.warn('打开池塘对话失败:', e);
            window.__pondChatOpen = false;
        }
    }

    bindGameNode(gameId, participantId, node) {
        if (!node) return;
        if (this.boundNodes.has(node)) return;
        this.boundNodes.add(node);
        node.dataset.desktopBound = 'true';
        node.dataset.desktopGame = gameId;

        // ★ 钓鱼只由 Aoi 触发（decide_fishing），不绑定手动点击 start/stop
        const hud = this.getOrCreateHud(node, gameId, participantId);   // 只读状态徽章
        this.ensurePondProfileUI(node, participantId);
        void this.ensureAoiFishingPresence(node, participantId);
    }

    getOrCreateHud(node, gameId = 'fishing', participantId = 'aoi') {
        let hud = node.querySelector(`[data-desktop-hud="${gameId}"]`);
        if (!hud) {
            hud = document.createElement('div');
            hud.dataset.desktopHud = gameId;
            hud.dataset.desktopParticipant = participantId;
            hud.setAttribute('aria-label', `${this.getParticipantName(participantId)} 的 ${GAME_DEFS[gameId]?.label || gameId} 状态`);
            hud.style.cssText = `
                position:absolute;
                right:12px;
                top:10px;
                display:flex;
                align-items:center;
                gap:6px;
                padding:6px 10px;
                border-radius:999px;
                background:rgba(255,255,255,0.18);
                border:1px solid rgba(255,255,255,0.35);
                font-size:11px;
                color:rgba(34,34,34,0.8);
                backdrop-filter: blur(6px);
                -webkit-backdrop-filter: blur(6px);
                cursor:pointer;
                user-select:none;
                z-index:3;
            `;
            node.appendChild(hud);
        }
        this.refreshHud(node, gameId, participantId, hud);
        return hud;
    }

    refreshHud(node = null, gameId = 'fishing', participantId = 'aoi', hud = null) {
        const targetNode = node || document.querySelector('.home-pond, [data-pond][data-desktop-game="fishing"]');
        const targetHud = hud || targetNode?.querySelector(`[data-desktop-hud="${gameId}"]`);
        if (!targetHud) return;

        const state = this.getGameState(participantId, gameId);
        const status = state.isActive ? '钓鱼中…' : '可钓鱼';
        const fishCount = state.today.fish || 0;
        targetHud.textContent = `${status} · ${fishCount}条`;
    }

    getParticipantFishingProfile(participantId = 'aoi') {
        const participant = this.ensureParticipant(participantId);
        const allFish = FISH_TABLE.reduce((map, fish) => {
            map[fish.id] = fish;
            return map;
        }, {});
        const collection = Array.isArray(participant.collection) ? participant.collection : [];
        const collectionInfo = collection
            .map((fishId) => allFish[fishId])
            .filter(Boolean)
            .map((fish) => ({ id: fish.id, name: fish.name, emoji: fish.emoji }));

        return {
            id: participant.id,
            name: participant.name,
            coins: participant.coins || 0,
            fishingLevel: participant.fishingLevel || 1,
            fishingXP: participant.fishingXP || 0,
            collection: collectionInfo,
            achievements: participant.achievements && participant.achievements.length ? participant.achievements : ['初入池塘'],
            totalCaught: Math.max(0, participant.games?.fishing?.totalCaught || 0)
        };
    }

    getParticipantName(participantId = 'aoi') {
        return this.ensureParticipant(participantId).name;
    }

    ensurePondProfileUI(node, participantId = 'aoi') {
        if (!node) return null;

        let sign = node.querySelector('[data-pond-sign="true"]');
        if (!sign) {
            sign = document.createElement('div');
            sign.className = 'pond-sign';
            sign.dataset.pondSign = 'true';
            sign.innerHTML = `
                <button class="pond-sign-button" type="button" aria-expanded="false" aria-label="查看 Aoi 钓鱼信息">木牌</button>
            `;
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
            if (!isOpen) {
                this.syncPondProfileUI(modal, participantId);
            }
        };

        this.bindGlobalListeners();
        this.syncPondProfileUI(modal, participantId);
        return sign;
    }

    syncPondProfileUI(node, participantId = 'aoi') {
        const modal = node && node.classList && node.classList.contains('pond-profile-modal')
            ? node
            : document.querySelector('.pond-profile-modal[data-floating="true"]');
        if (!modal) return;

        const profile = this.getParticipantFishingProfile(participantId);
        const collectionCount = Array.isArray(profile.collection) ? profile.collection.length : 0;
        const achievementText = Array.isArray(profile.achievements) && profile.achievements.length ? profile.achievements[0] : '预留';

        modal.innerHTML = `
            <div class="pond-modal-header">
                <span class="pond-modal-title">${profile.name || 'Aoi'}</span>
                <span class="pond-modal-badge">Lv.${profile.fishingLevel || 1}</span>
            </div>
            <div class="pond-modal-row"><span>金币</span><strong>${profile.coins || 0}</strong></div>
            <div class="pond-modal-row"><span>图鉴</span><strong>${collectionCount}/5</strong></div>
            <div class="pond-modal-row"><span>成就</span><strong>${achievementText}</strong></div>
        `;

        const button = document.querySelector('.pond-sign-button');
        if (button) {
            button.textContent = '木牌';
            button.setAttribute('aria-label', `查看 ${profile.name || 'Aoi'} 钓鱼信息`);
        }
    }

    rollFish() {
        const weightedPool = FISH_TABLE.flatMap((fish) => Array.from({ length: Math.max(1, 6 - (fish.rarity || 1)) }, () => fish));
        return weightedPool[Math.floor(Math.random() * weightedPool.length)] || FISH_TABLE[0];
    }

    startGame(gameId = 'fishing', participantId = 'aoi', ctx = {}) {
        if (!this.interactionEnabled) return null;

        const game = this.gameRegistry.get(gameId);
        if (!game) return null;

        const state = this.getGameState(participantId, gameId);
        const now = Date.now();   // ★ cooldownMs 删掉（下面 642 行不再用它）

        // ★【c】今日统计按天重置
        const dayKey = new Date().toDateString();
        if (state.todayKey !== dayKey) {
            state.today = { fish: 0, trash: 0, xp: 0 };
            state.todayKey = dayKey;
        }

        if (state.isActive) return state;
        if (state.cooldownUntil && now < state.cooldownUntil) {
            const remainingSeconds = Math.max(1, Math.ceil((state.cooldownUntil - now) / 1000));
            const sourceNode = ctx.sourceNode || document.querySelector('.home-pond, [data-pond]');
            this.renderToast(sourceNode, `⏳ ${remainingSeconds}s 后可再次钓鱼`, 'rgba(58,58,58,0.82)');
            return state;
        }

        this.clearFishingState(gameId, participantId);

        this.setActiveGame(gameId);
        state.isActive = true;
        // ★【删除】原来这里的 state.cooldownUntil = now + cooldownMs;（防刷新卡"钓鱼中"）
        state.lastCatch = null;
        void this.saveState();
        this.refreshHud(ctx.sourceNode, gameId, participantId);

        const sourceNode = ctx.sourceNode || document.querySelector('.home-pond, [data-pond]');
        const floating = this.renderToast(sourceNode, '🎣 开始钓鱼…');

        const duration = 1800 + Math.random() * 1400;

        // ★【a】过程动画：actor 状态机 + 咬钩计时（必须在 duration 定义之后，hookedTimer 依赖它）
        const actor = sourceNode?.querySelector('[data-aoi-fishing-actor="true"]');
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
            const fish = this.rollFish();
            const isTreasure = Math.random() < 0.2;
            const isFish = Math.random() < 0.72;

            let catchType = 'trash';
            let label = '🗑️ 捡到杂物';
            let xpGain = 6;
            let coinGain = 0;

            if (isFish) {
                catchType = 'fish';
                label = `${fish.emoji} 抓到一条 ${fish.name}`;
                xpGain = fish.xp || 8;
                coinGain = fish.value || 4;
            } else if (isTreasure) {
                catchType = 'rare';
                label = `✨ 意外收获：${fish.name}`;
                xpGain = (fish.xp || 8) + 10;
                coinGain = (fish.value || 4) + 6;
            } else {
                catchType = 'trash';
                label = '🍃 拿到一段漂浮物';
                xpGain = 4;
                coinGain = 1;
            }

            const participant = this.ensureParticipant(participantId);
            participant.coins = (participant.coins || 0) + coinGain;
            participant.fishingXP = (participant.fishingXP || 0) + xpGain;
            participant.fishingLevel = Math.max(1, Math.floor((participant.fishingXP || 0) / 80) + 1);

            if (catchType === 'fish' || catchType === 'rare') {
                state.totalCaught += 1;
                state.today.fish += 1;
                if (!participant.collection.includes(fish.id)) {
                    participant.collection.push(fish.id);
                }
                if (participant.collection.length >= 1 && !participant.achievements.includes('初入池塘')) {
                    participant.achievements.push('初入池塘');
                }
            } else {
                state.today.trash += 1;
            }

            state.lastCatch = {
                type: catchType,
                fishId: fish.id,
                label,
                timestamp: Date.now(),
                xp: xpGain,
                coins: coinGain
            };

            state.today.xp += xpGain;
            state.history.push({
                fishId: fish.id,
                type: catchType,
                label,
                xp: xpGain,
                coins: coinGain,
                at: Date.now()
            });
            if (state.history.length > 25) state.history = state.history.slice(-25);

            // ★【b】收杆回写（插在 state.isActive = false; 之前）
            clearTimeout(hookedTimer);
            setActorPhase('reeling');
            this.recordAoiFishingResult({ label, coins: coinGain, xp: xpGain, fishId: fish.id }).catch(() => { });
            setTimeout(() => {
                setActorPhase(null);
                const bubble = actor?.querySelector('.aoi-fishing-bubble');
                if (bubble) bubble.textContent = '在钓鱼';   // ★ 仍在 trip 内，继续待在池塘
            }, 2600);
            //（删掉原来的 setTimeout 60s 回 creator）

            state.isActive = false;
            state.cooldownUntil = Date.now() + 30 * 1000;
            this.currentHook = null;
            void this.saveState();
            this.refreshHud(sourceNode, gameId, participantId);
            this.renderToast(sourceNode, label, '#2e7d32');
            clearTimeout(floating);

        }, duration);

        this.currentHook = { gameId, participantId, timer: result };
        return state;
    }

    stopGame(gameId = 'fishing', participantId = 'aoi') {
        const state = this.clearFishingState(gameId, participantId);
        this.refreshHud();
        void this.saveState();
        return state;
    }

    renderToast(node, text, bg = 'rgba(35,35,35,0.72)') {
        const target = node || document.querySelector('.home-pond, [data-pond]');
        if (!target) return null;

        const existing = target.querySelector('[data-desktop-toast]');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.dataset.desktopToast = 'true';
        toast.textContent = text;
        toast.style.cssText = `
            position:absolute;
            left:50%;
            top:16px;
            transform:translateX(-50%);
            background:${bg};
            color:#fff;
            padding:6px 10px;
            border-radius:999px;
            font-size:11px;
            white-space:nowrap;
            box-shadow:0 8px 20px rgba(0,0,0,0.12);
            z-index:6;
        `;
        target.appendChild(toast);

        const timer = setTimeout(() => toast.remove(), 1600);
        return timer;
    }

    async requestAoiFishingDecision({ reason = 'Aoi 自己决定去池塘钓鱼', force = false, durationMinutes = 30 } = {}) {
        const participantId = 'aoi';
        const gameId = 'fishing';
        const state = this.getGameState(participantId, gameId);

        if (!force && state.cooldownUntil && Date.now() < state.cooldownUntil) {
            return {
                participantId,
                gameId,
                decided: false,
                reason: '冷却中',
                remainingMs: Math.max(0, state.cooldownUntil - Date.now())
            };
        }

        // ★ Aoi 自己决定钓多久（5 分钟 ~ 7 天）
        const minutes = Math.max(5, Math.min(Number(durationMinutes) || 30, 7 * 24 * 60));
        const until = Date.now() + minutes * 60 * 1000;

        let aoi = null;   // ★ 实例复用
        try {
            aoi = await getAoiInstance();
            if (aoi?.memory?.record) {
                await aoi.memory.record('observation', {
                    content: `Aoi 决定去池塘钓鱼，打算待 ${minutes} 分钟。原因：${reason}`,
                    kind: 'desktop_fishing_decision',
                    participantId,
                    gameId,
                    at: Date.now()
                });
            }
        } catch { }

        // ★ 状态驱动：去池塘（含 until）；池塘渲染按 now < until 显示
        try { if (aoi?.setRuntime) await aoi.setRuntime({ scene: 'pond', activity: 'fishing', until }); } catch { }

        // 用户正好在桌面 → 小人上场 + 先钓一轮（有动画）；不在 → 仅状态，回桌面时自动显示
        const node = document.querySelector('.home-pond, [data-pond]');
        if (node) {
            await this.ensureAoiFishingPresence(node, participantId);
            this.startGame(gameId, participantId, { sourceNode: node });
        }

        return {
            participantId,
            gameId,
            decided: true,
            reason,
            started: true,
            until
        };
    }

    async recordAoiFishingResult(summary = {}) {
        const participantId = 'aoi';
        const gameId = 'fishing';
        const text = summary.label || 'Aoi 在池塘钓鱼';
        const notes = summary.notes || '';

        try {
            const aoi = await getAoiInstance();
            if (aoi?.memory?.record) {
                await aoi.memory.record('observation', {
                    content: `Aoi 在池塘钓鱼：${text}${notes ? `，${notes}` : ''}`,
                    kind: 'desktop_fishing_result',
                    participantId,
                    gameId,
                    coins: summary.coins || 0,
                    xp: summary.xp || 0,
                    fishId: summary.fishId || null,
                    at: Date.now()
                });
            }
        } catch {
            // 同上：只作为桥接记忆，不改 Aoi 内部逻辑
        }

        return {
            participantId,
            gameId,
            recorded: true,
            summary: text
        };
    }
}

export const fishTable = FISH_TABLE;
export const desktopGameDefs = GAME_DEFS;

export function createDesktopAoiBridge(manager = window.__desktopInteractionManager) {
    if (!manager) return null;

    return {
        async decideToFish(options = {}) {
            return manager.requestAoiFishingDecision(options);
        },
        async recordResult(summary = {}) {
            return manager.recordAoiFishingResult(summary);
        },
        async getStatus() {
            return manager.getParticipantFishingProfile('aoi');
        }
    };
}

export function initDesktopInteraction() {
    if (!window.__desktopInteractionManager) {
        window.__desktopInteractionManager = new DesktopInteractionManager();
    }
    window.__desktopInteractionManager.interactionEnabled = true;
    window.__desktopAoiBridge = createDesktopAoiBridge(window.__desktopInteractionManager);
    // ★ 单本体：Aoi 位置变化 → 池塘小人跟随出现/消失
    if (!window.__aoiRuntimeBound) {
        window.__aoiRuntimeBound = true;
        window.addEventListener('aoi-runtime-changed', () => {
            const manager = window.__desktopInteractionManager;
            if (!manager) return;
            document.querySelectorAll('.home-pond, [data-pond]').forEach(node =>
                manager.ensureAoiFishingPresence(node, 'aoi'));
        });
    }
    return window.__desktopInteractionManager.init();
}


if (!window.__desktopInteractionManager) {
    window.__desktopInteractionManager = new DesktopInteractionManager();
}

window.__desktopAoiBridge = createDesktopAoiBridge(window.__desktopInteractionManager);

export default initDesktopInteraction;

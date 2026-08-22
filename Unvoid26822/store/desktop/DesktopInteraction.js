// store/desktop/DesktopInteraction.js
// 桌面互动独立入口，不直接改动首页、Aoi、DeskPet 等已有模块。

import { getAoiInstance } from '../Aoi/aoi.js';
import { esc } from '../utils.js';
import { setActorActivity, clearActorActivity, isActorAtScene, resolveActorInfo } from './SceneActivity.js';
import { fishingGame } from './activities/fishing.js';

// ★ 游戏注册表：加新游戏 = 一个 import + 一个条目
const GAMES = { fishing: fishingGame };

const STORAGE_KEY = 'desktop_interaction_cache_v1';
const DB_NAME = 'desktop_interaction';
const DB_VERSION = 2;

const STORE_NAMES = {
    meta: 'meta',
    participants: 'participants',
    gameStates: 'game_states',
    eventLog: 'event_log',
    fishCatalog: 'fish_catalog',
    bottlePool: 'bottle_pool'   // ★ 新增
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
    return deepClone(GAMES[gameId]?.defaultState || {});
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
        maxWeights: {},          // ★ 图鉴记录最大重量 { fishId: kg }
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

    // ★ GAME_DEFS → GAMES（游戏注册表）
    Object.keys(GAMES).forEach((gameId) => {
        if (!merged.games[gameId]) {
            merged.games[gameId] = {
                id: gameId,
                label: GAMES[gameId].label,
                description: GAMES[gameId].description,
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
        Object.keys(GAMES).forEach((gameId) => {
            if (!merged.participants[participantId].games[gameId]) {
                merged.participants[participantId].games[gameId] = cloneDefaultState(gameId);
            }
        });
    });

    Object.keys(GAMES).forEach((gameId) => {
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
            const transaction = event.target.transaction;

            Object.values(STORE_NAMES).forEach((storeName) => {
                if (!db.objectStoreNames.contains(storeName)) {
                    db.createObjectStore(storeName, { keyPath: 'id' });
                }
            });

            const metaStore = transaction.objectStore(STORE_NAMES.meta);
            if (!metaStore.indexNames.contains('keyIndex')) {
                metaStore.createIndex('keyIndex', 'key', { unique: true });
            }
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
        this.boundNodes = new WeakSet();
        this.interactionEnabled = false;
        this.context = {};
        this.dbReady = this.bootstrap();
    }

    sanitizePersistedActiveState() {
        let changed = false;
        const now = Date.now();

        Object.keys(this.state.participants || {}).forEach((participantId) => {
            const participant = this.state.participants[participantId];
            if (!participant || !participant.games) return;

            Object.keys(GAMES).forEach((gameId) => {
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

    // ★ 读取瓶子池
    async loadBottlePool() {
        try {
            const value = await readFromDB(STORE_NAMES.bottlePool, 'pool');
            if (value?.data) return value.data;
        } catch { }

        // 首次初始化：系统预置瓶子
        return [
            {
                id: 'b_sys_1',
                author: '路过的旅人',
                authorId: null,
                content: '如果你看到这个，希望你今天快乐 🌸',
                emoji: '🍾',
                fromRole: 'creator',
                status: 'floating',
                thrownAt: Date.now() - 86400000 * 7,
                caughtAt: null,
                caughtBy: null
            },
            {
                id: 'b_sys_2',
                author: '匿名',
                authorId: null,
                content: '池塘真美，站在这里就能忘掉烦恼',
                emoji: '💌',
                fromRole: 'creator',
                status: 'floating',
                thrownAt: Date.now() - 86400000 * 14,
                caughtAt: null,
                caughtBy: null
            },
            {
                id: 'b_sys_3',
                author: '过客',
                authorId: null,
                content: '钓鱼的意义不在鱼，在于等待的时光',
                emoji: '🗝️',
                fromRole: 'creator',
                status: 'floating',
                thrownAt: Date.now() - 86400000 * 30,
                caughtAt: null,
                caughtBy: null
            }
        ];
    }

    // ★ 保存瓶子池
    async saveBottlePool(pool) {
        if (!Array.isArray(pool)) {
            throw new TypeError('漂流瓶池必须是数组');
        }

        const result = await writeToDB(
            STORE_NAMES.bottlePool,
            { id: 'pool', data: pool },
            'pool'
        );

        if (result === null) {
            throw new Error('无法写入漂流瓶数据库');
        }

        return result;
    }

    ensureGameMetadata(gameId, config = GAMES[gameId] || {}) {
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
        const p = this.state.participants[participantId];

        // ★ 兼容旧数据/损坏数据：缺失字段补默认（即使 participant 已存在）
        if (typeof p.coins !== 'number') p.coins = 0;
        if (typeof p.fishingLevel !== 'number') p.fishingLevel = 1;
        if (typeof p.fishingXP !== 'number') p.fishingXP = 0;
        if (!Array.isArray(p.collection)) p.collection = [];
        if (!p.maxWeights || typeof p.maxWeights !== 'object') p.maxWeights = {};
        if (!Array.isArray(p.achievements)) p.achievements = ['初入池塘'];
        if (!p.games || typeof p.games !== 'object') p.games = {};

        Object.keys(GAMES).forEach((gameId) => {
            if (!p.games[gameId]) {
                p.games[gameId] = cloneDefaultState(gameId);
            }
        });
        return p;
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

    setHook(gameId, participantId, timer) {
        this._hooks = this._hooks || new Map();
        const key = gameId + ':' + participantId;
        const prev = this._hooks.get(key);
        if (prev) clearTimeout(prev);
        this._hooks.set(key, timer);
    }
    clearHook(gameId, participantId) {
        const key = gameId + ':' + participantId;
        const timer = this._hooks?.get(key);
        if (timer) clearTimeout(timer);
        this._hooks?.delete(key);
    }

    clearFishingState(gameId = 'fishing', participantId = 'aoi') {
        const state = this.getGameState(participantId, gameId);

        state.isActive = false;
        state.lastCatch = null;

        this.clearHook(gameId, participantId);
        return state;
    }

    destroy() {
        this.currentHook = null;
        this.bound = false;
    }


    init(root = document, context = {}) {
        this.context = context || {};
        this.sanitizePersistedActiveState();

        if (!this.bound) {
            this.bound = true;
            const pondNodes = root.querySelectorAll('[data-desktop-game="fishing"], .home-pond, [data-pond]');
            pondNodes.forEach((node) => {
                this.bindGameNode('fishing', 'aoi', node, this.context);
            });

            window.addEventListener('theme-changed', () => this.refreshHud());
            window.addEventListener('desk-rendered', () => {
                const pondNodesNow = document.querySelectorAll('[data-desktop-game="fishing"], .home-pond, [data-pond]');
                pondNodesNow.forEach((node) => {
                    this.bindGameNode('fishing', 'aoi', node, this.context);
                });
            });
        } else {
            const pondNodes = root.querySelectorAll('[data-desktop-game="fishing"], .home-pond, [data-pond]');
            pondNodes.forEach((node) => {
                this.bindGameNode('fishing', 'aoi', node, this.context);
            });
        }

        return this;
    }

    // ★ 通用：场景活动小人（任意角色；渲染只认注册表 isActorAtScene）
    async ensureActorPresence(node, actorId = 'aoi') {
        if (!node) return null;

        // ★ 渲染只认通用注册表（now < until）
        if (!isActorAtScene(actorId, 'pond')) {
            // ★ 超时结算：Aoi 走 setRuntime（自动同步注册表）；其他角色预留 clearActorActivity
            try {
                if (actorId === 'aoi') {
                    const aoi = await getAoiInstance();
                    if (aoi?.runtime?.scene === 'pond' && aoi?.setRuntime) {
                        await aoi.setRuntime({ scene: 'creator', activity: 'idle', until: 0 });
                    }
                } else {
                    clearActorActivity(actorId);
                }
            } catch { }
            const existing = node.querySelector(`[data-actor-fishing="${CSS.escape(actorId)}"]`);
            if (existing) existing.remove();
            return null;
        }

        const info = resolveActorInfo(actorId);
        let actor = node.querySelector(`[data-actor-fishing="${CSS.escape(actorId)}"]`);
        if (!actor) {
            actor = document.createElement('div');
            actor.dataset.actorFishing = actorId;
            actor.className = 'aoi-fishing-avatar';
            actor.innerHTML = `
            <div class="aoi-fishing-pod">
                <div class="aoi-fishing-body">${info.name}</div>
                <div class="aoi-fishing-bubble">在钓鱼</div>
            </div>`;
            node.appendChild(actor);
        }

        // ★ 点击：Aoi → 池塘小窗；其他角色预留各自的对话入口
        if (!actor.dataset.chatBound) {
            actor.dataset.chatBound = 'true';
            actor.style.cursor = 'pointer';
            actor.addEventListener('click', (e) => {
                e.stopPropagation();
                if (actorId === 'aoi') this.openPondChat(node);
                // ★ 预留：else 接其他角色的场景对话
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

    bindGameNode(gameId, participantId, node, context = this.context) {
        if (!node) return;
        if (this.boundNodes.has(node)) return;
        this.boundNodes.add(node);
        node.dataset.desktopBound = 'true';
        node.dataset.desktopGame = gameId;

        // ★ 钓鱼只由 Aoi 触发（decide_fishing），不绑定手动点击 start/stop
        const hud = this.getOrCreateHud(node, gameId, participantId);   // 只读状态徽章
        GAMES[gameId]?.ensureProfile?.(
            this,
            node,
            participantId,
            context
        );
        void this.ensureActorPresence(node, participantId);
    }

    getOrCreateHud(node, gameId = 'fishing', participantId = 'aoi') {
        let hud = node.querySelector(`[data-desktop-hud="${gameId}"]`);
        if (!hud) {
            hud = document.createElement('div');
            hud.dataset.desktopHud = gameId;
            hud.dataset.desktopParticipant = participantId;
            hud.setAttribute('aria-label', `${this.getParticipantName(participantId)} 的 ${GAMES[gameId]?.label || gameId} 状态`);
            hud.style.cssText = `
                position:absolute;
                right:12px;
                top:5px;
                display:flex;
                flex-direction:column;      /* ★ 改：行 → 列 */
                align-items:flex-end;       /* ★ 改：center → flex-end */
                gap:1px;                    /* ★ 改：6px → 1px */
                padding:6px 10px;
                border-radius:12px;         /* ★ 改：999px → 12px */
                background:rgba(255,255,255,0.18);
                border:1px solid rgba(255,255,255,0.35);
                font-size:11px;
                color:rgba(34,34,34,0.8);
                backdrop-filter: blur(6px);
                -webkit-backdrop-filter: blur(6px);
                cursor:pointer;
                user-select:none;
                z-index:3;
                max-width:calc(100% - 24px);   /* ★ 新增：防长文本溢出 */
            `;
            // ★ 新增：两行结构（状态 + 上次收获）
            hud.innerHTML = `
                <span class="pond-hud-status" data-pond-hud-status></span>
                <span class="pond-hud-last" data-pond-hud-last hidden></span>
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

        // ★ 跨天检查：HUD 显示前保证库存是今天的
        const dayKey = new Date().toDateString();
        if (state.todayKey !== dayKey) {
            state.today = { fish: 0, trash: 0, xp: 0 };
            state.todayKey = dayKey;
            state.stockRemaining = Number.isFinite(state.stockTotal) ? state.stockTotal : 100;
        }

        const status = state.isActive ? '钓鱼中…' : '可钓鱼';
        const remain = Math.max(0, Number.isFinite(state.stockRemaining) ? state.stockRemaining : (state.stockTotal ?? 100));

        const statusEl = targetHud.querySelector('[data-pond-hud-status]');
        const lastEl = targetHud.querySelector('[data-pond-hud-last]');

        // ★ 防呆：旧结构 HUD（无子元素）走 textContent 兼容
        if (!statusEl) { targetHud.textContent = `${status} · 剩 ${remain} 条`; return; }

        statusEl.textContent = `${status} · 剩 ${remain} 条`;
        if (lastEl) {
            if (state.lastCatch?.label) {
                lastEl.textContent = `上次：${state.lastCatch.label}`;
                lastEl.hidden = false;
            } else {
                lastEl.hidden = true;
            }
        }
    }


    getParticipantName(participantId = 'aoi') {
        return this.ensureParticipant(participantId).name;
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
            await this.ensureActorPresence(node, participantId);
            GAMES[gameId]?.trigger?.(this, participantId, { sourceNode: node });
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

    // ★ 通用：钓鱼结果 → 角色记忆（Aoi 写 AoiMemory；其他角色预留）
    async recordFishingResult(actorId = 'aoi', summary = {}) {
        const gameId = 'fishing';
        const text = summary.label || `${actorId} 在池塘钓鱼`;
        const notes = summary.notes || '';

        if (actorId === 'aoi') {
            try {
                const aoi = await getAoiInstance();
                if (aoi?.memory?.record) {
                    await aoi.memory.record('observation', {
                        content: `Aoi 在池塘钓鱼：${text}${notes ? `，${notes}` : ''}`,
                        kind: 'desktop_fishing_result',
                        participantId: actorId,
                        gameId,
                        coins: summary.coins || 0,
                        xp: summary.xp || 0,
                        fishId: summary.fishId || null,
                        at: Date.now()
                    });
                }
            } catch { }
        }
        // ★ 预留：else 分支写通用活动日志 / 角色记忆接口

        return { participantId: actorId, gameId, recorded: true, summary: text };
    }
}


export function createDesktopAoiBridge(manager = window.__desktopInteractionManager) {
    if (!manager) return null;

    return {
        async decideToFish(options = {}) {
            return manager.requestAoiFishingDecision(options);
        },
        async recordResult(summary = {}) {
            return manager.recordFishingResult('aoi', summary);
        },
        async getStatus() {
            return GAMES.fishing?.getProfile?.(manager, 'aoi');
        },
    };
}

export function initDesktopInteraction(context = {}) {
    if (!window.__desktopInteractionManager) {
        window.__desktopInteractionManager = new DesktopInteractionManager();
    }
    window.__desktopInteractionManager.interactionEnabled = true;
    window.__desktopAoiBridge = createDesktopAoiBridge(window.__desktopInteractionManager);
    // ★ 单本体 + 注册表桥接：Aoi runtime → 通用注册表 → 池塘小人跟随
    if (!window.__aoiRuntimeBound) {
        window.__aoiRuntimeBound = true;
        window.addEventListener('aoi-runtime-changed', (e) => {
            const r = e.detail || {};
            const manager = window.__desktopInteractionManager;
            if (!manager) return;
            // ★ 桥接：Aoi runtime 变化 → 同步通用注册表（渲染只认注册表）
            if (r.scene === 'pond' && (!r.until || Date.now() < r.until)) {
                setActorActivity('aoi', { scene: 'pond', activity: r.activity || 'fishing', until: r.until || 0 });
            } else {
                setActorActivity('aoi', { scene: 'creator', activity: 'idle', until: 0 });
            }
            document.querySelectorAll('.home-pond, [data-pond]').forEach(node =>
                manager.ensureActorPresence(node, 'aoi'));
        });
    }
    return window.__desktopInteractionManager.init(document, context);
}


if (!window.__desktopInteractionManager) {
    window.__desktopInteractionManager = new DesktopInteractionManager();
}

window.__desktopAoiBridge = createDesktopAoiBridge(window.__desktopInteractionManager);

export default initDesktopInteraction;

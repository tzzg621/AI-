// apps/worldNetGraph.js
// 世界网络关系图组件

import { CharacterStore } from '../store/CharacterStore.js';
import { getCharacterNameById } from './characterManager.js';
import { getAvatarHtml } from '../store/ImageCache.js';
import { esc } from '../store/utils.js';

const GRAPH_ROOT_CLASS = 'worldnet-graph-module';

const RELATION_STYLES = {
    family: {
        color: '#4ECDC4',
        label: '亲属',
        dash: []
    },
    romance: {
        color: '#FF6B9D',
        label: '恋人',
        dash: []
    },
    crush: {
        color: '#FF6B9D',
        label: '暗恋 / 好感',
        dash: [5, 5]
    },
    friend: {
        color: '#95E1D3',
        label: '朋友',
        dash: []
    },
    rival: {
        color: '#F38181',
        label: '对手',
        dash: []
    },
    enemy: {
        color: '#B00020',
        label: '敌对',
        dash: [8, 4]
    },
    mentor: {
        color: '#AA96DA',
        label: '师徒 / 导师',
        dash: []
    },
    other: {
        color: '#9AA4B2',
        label: '其他',
        dash: [3, 3]
    }
};

let mountedGraphs = new WeakMap();

function getAllCharacters() {
    const result = [];
    const seen = new Set();

    const read = (key, source) => {
        try {
            const list = JSON.parse(localStorage.getItem(key) || '[]');

            if (!Array.isArray(list)) return;

            for (const item of list) {
                if (!item?.id || seen.has(item.id)) continue;

                seen.add(item.id);

                const base = item.base || {};
                const store = new CharacterStore(item.id);
                const info = store.getInfo();

                result.push({
                    id: item.id,
                    name: base.name || info.name || item.id,
                    emoji: base.emoji || info.emoji || '👤',
                    desc: base.desc || info.desc || '',
                    detail: base.detail || '',
                    role: base.role || info.label || item.type || source,
                    type: item.type || source,
                    tags: Array.isArray(base.tags) ? base.tags : [],
                    relations: store.getRelations(),
                    profile: store.getProfile(),
                    archived: Boolean(item.archived)
                });
            }
        } catch (error) {
            console.warn('[WorldNetGraph] 读取角色失败:', error);
        }
    };

    read('rolebook_characters', 'character');
    read('worldnet_extra_characters', 'npc');
    read('rolebook_archived', 'archived');

    return result;
}

function classifyRelation(value) {
    const text = String(value || '').toLowerCase();

    if (/家人|亲属|母亲|父亲|母女|父女|兄弟|姐妹|夫妻|亲戚/.test(text)) {
        return 'family';
    }

    if (/恋人|伴侣|爱人|情侣|结婚|夫妻关系/.test(text)) {
        return 'romance';
    }

    if (/暗恋|喜欢|好感|欣赏|心动|在意/.test(text)) {
        return 'crush';
    }

    if (/敌人|敌对|仇人|憎恨|厌恶|死敌/.test(text)) {
        return 'enemy';
    }

    if (/对手|竞争| rival| rival关系|看不顺眼/.test(text)) {
        return 'rival';
    }

    if (/老师|导师|学生|师徒|教导|学长|学姐|学弟|学妹/.test(text)) {
        return 'mentor';
    }

    if (/朋友|好友|同学|同事|熟人|闺蜜|兄弟情|老友|同伴/.test(text)) {
        return 'friend';
    }

    return 'other';
}

function makeEdges(characters) {
    const ids = new Set(characters.map(item => item.id));
    const edges = [];

    for (const character of characters) {
        for (const relation of character.relations || []) {
            const targetId = relation?.id;
            if (!targetId || !ids.has(targetId)) continue;
            if (targetId === character.id) continue;

            const relationText = relation.relation || relation.name || '其他';

            edges.push({
                source: character.id,
                target: targetId,
                type: classifyRelation(relationText),
                label: relationText,
                perspective: relation.perspective || '',
                attitudes: Array.isArray(relation.attitudes)
                    ? relation.attitudes
                    : []
            });
        }
    }

    return edges;
}

function getRelationNeighbors(centerId, edges) {
    const ids = new Set([centerId]);

    for (const edge of edges) {
        if (edge.source === centerId) ids.add(edge.target);
        if (edge.target === centerId) ids.add(edge.source);
    }

    return ids;
}

function createGraphData(centerId) {
    const characters = getAllCharacters();
    const characterMap = new Map(
        characters.map(character => [character.id, character])
    );

    const allEdges = makeEdges(characters);
    const visibleIds = getRelationNeighbors(centerId, allEdges);

    // 当前中心角色的联系人也加入可见节点。
    // 即使联系人没有关系网记录，也会以独立节点显示。
    try {
        const centerStore = new CharacterStore(centerId);

        for (const friendId of centerStore.getFriendIds()) {
            if (characterMap.has(friendId)) {
                visibleIds.add(friendId);
            }
        }
    } catch (error) {
        console.warn('[WorldNetGraph] 读取中心角色联系人失败:', error);
    }

    const nodes = characters
        .filter(character => visibleIds.has(character.id))
        .map(character => ({
            ...character,
            x: 0,
            y: 0,
            vx: 0,
            vy: 0,
            isContact: character.id !== centerId &&
                (() => {
                    try {
                        return new CharacterStore(centerId)
                            .isFriend(character.id);
                    } catch {
                        return false;
                    }
                })()
        }));

    // 只绘制与中心角色直接相关的关系边。
    // 没有关系记录、但属于联系人列表的角色仍然会显示为孤立节点。
    const visibleEdges = allEdges.filter(edge =>
        visibleIds.has(edge.source) &&
        visibleIds.has(edge.target) &&
        (
            edge.source === centerId ||
            edge.target === centerId
        )
    );

    return {
        characters,
        characterMap,
        nodes,
        edges: visibleEdges
    };
}

function createNodePositions(nodes, centerId, width, height) {
    const centerX = width / 2;
    const centerY = height / 2;
    const center = nodes.find(node => node.id === centerId);

    if (center) {
        center.x = centerX;
        center.y = centerY;
    }

    const others = nodes.filter(node => node.id !== centerId);
    if (!others.length) return;

    // 根据角色 ID 生成稳定的伪随机数。
    // 这样每次 load() 后布局基本保持一致，不会完全重新跳位。
    function hash(value) {
        let result = 2166136261;
        const text = String(value || '');

        for (let i = 0; i < text.length; i += 1) {
            result ^= text.charCodeAt(i);
            result = Math.imul(result, 16777619);
        }

        return (result >>> 0) / 4294967296;
    }

    function randomBetween(seed, min, max) {
        return min + (max - min) * hash(seed);
    }

    const minSize = Math.min(width, height);
    const baseRadius = Math.max(94, minSize * 0.29);
    const maxRadius = Math.max(142, minSize * 0.47);

    // 先按关系类型打散，而不是固定分成两条圆环。
    // 有关系记录的节点更靠近中心，但也允许落到外侧；
    // 联系人节点通常更外侧，但也允许向内靠近。
    const relationNodes = others.filter(node => !node.isContact);
    const contactNodes = others.filter(node => node.isContact);

    const orderedNodes = [
        ...relationNodes,
        ...contactNodes
    ];

    const total = orderedNodes.length;

    orderedNodes.forEach((node, index) => {
        const seed = `${node.id}:${centerId}`;

        // 基础角度不是严格等分，每个节点都有稳定偏移。
        const evenlySpaced =
            (index / Math.max(total, 1)) * Math.PI * 2;

        const angleOffset = randomBetween(
            `${seed}:angle`,
            -0.42,
            0.42
        );

        const angle = evenlySpaced + angleOffset;

        const isContact = node.isContact;
        const preferredRadius = isContact
            ? randomBetween(`${seed}:radius`, baseRadius * 1.05, maxRadius)
            : randomBetween(`${seed}:radius`, baseRadius * 0.72, baseRadius * 1.35);

        // 少量椭圆变形，避免整体看起来像标准圆环。
        const ellipseX = randomBetween(`${seed}:ellipse-x`, 0.88, 1.08);
        const ellipseY = randomBetween(`${seed}:ellipse-y`, 0.88, 1.12);

        node.x = centerX + Math.cos(angle) * preferredRadius * ellipseX;
        node.y = centerY + Math.sin(angle) * preferredRadius * ellipseY;
    });

    // 轻量碰撞调整，避免节点卡在一起。
    // 不使用持续运行的物理模拟，因此不会产生 Demo 版的长期 CPU 消耗。
    const nodeGap = 86;
    const maxIterations = 8;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
        for (let i = 0; i < orderedNodes.length; i += 1) {
            const a = orderedNodes[i];

            for (let j = i + 1; j < orderedNodes.length; j += 1) {
                const b = orderedNodes[j];
                let dx = b.x - a.x;
                let dy = b.y - a.y;
                let distance = Math.sqrt(dx * dx + dy * dy);

                if (distance < 0.01) {
                    dx = 1;
                    dy = 0;
                    distance = 1;
                }

                if (distance >= nodeGap) continue;

                const push = (nodeGap - distance) / distance * 0.5;
                const offsetX = dx * push;
                const offsetY = dy * push;

                // 中心节点固定在画布中央，其他节点承担更多位移。
                if (a.id !== centerId) {
                    a.x -= offsetX;
                    a.y -= offsetY;
                }

                if (b.id !== centerId) {
                    b.x += offsetX;
                    b.y += offsetY;
                }
            }
        }
    }

    // 给节点留出边距，避免碰撞调整后跑出 Canvas。
    const padding = 58;

    for (const node of orderedNodes) {
        node.x = Math.max(
            padding,
            Math.min(width - padding, node.x)
        );
        node.y = Math.max(
            padding,
            Math.min(height - padding, node.y)
        );
    }
}

// function distance(a, b) {
//     const dx = a.x - b.x;
//     const dy = a.y - b.y;
//     return Math.sqrt(dx * dx + dy * dy) || 0.01;
// }

function cloneGraphNodeMap(map) {
    if (!(map instanceof Map)) return new Map();

    return new Map(
        [...map.entries()].map(([id, node]) => [
            id,
            { ...node }
        ])
    );
}

function cloneGraphEdges(edges) {
    return (edges || []).map(edge => ({
        ...edge,
        attitudes: Array.isArray(edge.attitudes)
            ? [...edge.attitudes]
            : []
    }));
}

function lerp(start, end, progress) {
    return start + (end - start) * progress;
}

function easeInOutCubic(value) {
    const t = Math.max(0, Math.min(1, value));

    return t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function getExitPoint(node, width, height) {
    const centerX = width / 2;
    const centerY = height / 2;

    const dx = Number(node?.x || centerX) - centerX;
    const dy = Number(node?.y || centerY) - centerY;
    const length = Math.sqrt(dx * dx + dy * dy);
    const angle = length > 0.01 ? Math.atan2(dy, dx) : 0;
    const exitDistance = Math.max(width, height) * 0.9;

    return {
        x: centerX + Math.cos(angle) * exitDistance,
        y: centerY + Math.sin(angle) * exitDistance
    };
}

function getNodeRadius(node, centerId) {
    return node.id === centerId ? 38 : 30;
}

function roundRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);

    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
}

function drawEdge(ctx, edge, state) {
    const source = state.nodeMap.get(edge.source);
    const target = state.nodeMap.get(edge.target);
    if (!source || !target) return;

    const style = RELATION_STYLES[edge.type] || RELATION_STYLES.other;
    const isSelectedEdge =
        Boolean(state.selectedId) &&
        (
            edge.source === state.selectedId ||
            edge.target === state.selectedId
        );

    const isCenterEdge =
        edge.source === state.centerId ||
        edge.target === state.centerId;

    const highlighted =
        !state.selectedId ||
        isSelectedEdge ||
        isCenterEdge;

    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const length = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / length;
    const uy = dy / length;

    const sourceRadius = getNodeRadius(source, state.centerId);
    const targetRadius = getNodeRadius(target, state.centerId);

    const sx = source.x + ux * sourceRadius;
    const sy = source.y + uy * sourceRadius;
    const tx = target.x - ux * targetRadius;
    const ty = target.y - uy * targetRadius;

    const normalX = -uy;
    const normalY = ux;
    const curve = 20;
    const cx = (sx + tx) / 2 + normalX * curve;
    const cy = (sy + ty) / 2 + normalY * curve;

    ctx.save();
    const edgeOpacity = Number.isFinite(state.opacity)
        ? state.opacity
        : 1;

    const baseOpacity = isSelectedEdge
        ? 1
        : isCenterEdge
            ? 0.9
            : state.selectedId
                ? 0.12
                : 0.55;

    const baseLineWidth = isSelectedEdge
        ? 3.4
        : isCenterEdge
            ? 2.2
            : 1.1;

    ctx.globalAlpha = baseOpacity * edgeOpacity;
    ctx.strokeStyle = style.color;
    ctx.fillStyle = style.color;
    ctx.lineWidth = baseLineWidth;
    ctx.setLineDash(style.dash);

    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(cx, cy, tx, ty);

    if (isSelectedEdge) {
        ctx.shadowColor = style.color;
        ctx.shadowBlur = 10;
    }

    ctx.stroke();
    ctx.shadowBlur = 0;

    // 箭头
    const arrowSize = isSelectedEdge ? 9 : 7;
    const angle = Math.atan2(ty - cy, tx - cx);

    if (isSelectedEdge) {
        ctx.shadowColor = style.color;
        ctx.shadowBlur = 8;
    }

    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(
        tx - Math.cos(angle - Math.PI / 6) * arrowSize,
        ty - Math.sin(angle - Math.PI / 6) * arrowSize
    );
    ctx.lineTo(
        tx - Math.cos(angle + Math.PI / 6) * arrowSize,
        ty - Math.sin(angle + Math.PI / 6) * arrowSize
    );
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;

    if (state.selectedId && highlighted) {
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const labelX = (sx + tx) / 2 + normalX * curve * 0.55;
        const labelY = (sy + ty) / 2 + normalY * curve * 0.55;
        const textWidth = ctx.measureText(edge.label).width + 12;

        ctx.fillStyle = 'rgba(18, 24, 38, 0.95)';
        roundRect(ctx, labelX - textWidth / 2, labelY - 10, textWidth, 20, 7);
        ctx.fill();

        ctx.fillStyle = style.color;
        ctx.fillText(edge.label, labelX, labelY);
    }

    ctx.restore();
}

function drawNode(ctx, node, state) {
    const center = node.id === state.centerId;
    const selected = node.id === state.selectedId;
    const faded = state.selectedId && !selected && node.id !== state.centerId;
    const radius = getNodeRadius(node, state.centerId);
    const width = center ? 108 : 92;
    const height = center ? 72 : 62;
    const x = node.x - width / 2;
    const y = node.y - height / 2;

    ctx.save();
    const nodeOpacity =
        state.nodeOpacity?.get(node.id) ?? 1;

    ctx.globalAlpha =
        (faded ? 0.28 : 1) * nodeOpacity;

    ctx.fillStyle = 'rgba(14, 20, 33, 0.96)';
    roundRect(ctx, x, y, width, height, 16);
    ctx.fill();

    ctx.strokeStyle = selected
        ? '#FFD93D'
        : center
            ? '#4ECDC4'
            : node.isContact
                ? '#74B9FF'
                : 'rgba(255,255,255,0.2)';
    ctx.lineWidth =
        selected
            ? 3
            : center
                ? 2.5
                : node.isContact
                    ? 1.5
                    : 1;
    ctx.stroke();

    if (selected || center) {
        ctx.shadowColor = selected ? '#FFD93D' : '#4ECDC4';
        ctx.shadowBlur = selected ? 20 : 14;
        ctx.stroke();
        ctx.shadowBlur = 0;
    }

    ctx.font = center ? '25px sans-serif' : '21px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(node.emoji || '👤', node.x, node.y - 10);

    ctx.font = center ? 'bold 13px sans-serif' : 'bold 12px sans-serif';
    ctx.fillText(node.name, node.x, node.y + 15);

    if (center) {
        ctx.font = '10px sans-serif';
        ctx.fillStyle = '#4ECDC4';
        ctx.fillText('当前中心', node.x, node.y + 29);
    }

    ctx.restore();
}

function renderLegend() {
    return Object.entries(RELATION_STYLES)
        .map(([key, style]) => `
            <span class="worldnet-legend-item">
                <i style="background:${style.color}"></i>
                ${esc(style.label)}
            </span>
        `)
        .join('');
}

function renderDetailPanel(character, edges, close) {
    if (!character) return '';

    const outgoing = edges.filter(edge => edge.source === character.id);
    const relationHtml = outgoing.length
        ? outgoing.map(edge => {
            const targetName = getCharacterNameById(edge.target);
            const style = RELATION_STYLES[edge.type] || RELATION_STYLES.other;

            return `
                <div class="worldnet-detail-relation">
                    <span class="worldnet-detail-arrow" style="color:${style.color}">→</span>
                    <span>${esc(targetName)}</span>
                    <small style="color:${style.color}">${esc(edge.label)}</small>
                </div>
            `;
        }).join('')
        : '<div class="worldnet-empty">这个角色还没有记录对他人的关系。</div>';

    const tags = character.tags?.length
        ? character.tags.map(tag => `<span>${esc(tag)}</span>`).join('')
        : '<span>暂无标签</span>';

    return `
        <div class="worldnet-detail-mask" data-close-detail="true">
            <section class="worldnet-detail-panel" role="dialog" aria-modal="true">
                <button class="worldnet-detail-close" data-close-detail="true">×</button>

                <div class="worldnet-detail-head">
                    <div class="worldnet-detail-avatar">
                        ${getAvatarHtml(character.id, character.emoji || '👤')}
                    </div>
                    <div>
                        <h2>${esc(character.name)}</h2>
                        <p>${esc(character.role || character.type || '角色')}</p>
                    </div>
                </div>

                <div class="worldnet-detail-section">
                    <h3>简介</h3>
                    <p>${esc(character.desc || character.detail || '暂无简介')}</p>
                </div>

                <div class="worldnet-detail-section">
                    <h3>标签</h3>
                    <div class="worldnet-detail-tags">${tags}</div>
                </div>

                <div class="worldnet-detail-section">
                    <h3>TA 对他人的认知</h3>
                    <div class="worldnet-detail-relations">${relationHtml}</div>
                </div>

                <button class="worldnet-detail-center" data-set-center="${esc(character.id)}">
                    以 ${esc(character.name)} 为中心查看
                </button>
            </section>
        </div>
    `;
}

class WorldNetGraph {
    constructor(root, options = {}) {
        this.root = root;
        this.canvas = root.querySelector('.worldnet-graph-canvas');
        this.ctx = this.canvas.getContext('2d');
        this.options = options;
        this.characters = [];
        this.edges = [];
        this.centerId = options.initialCenterId || null;
        this.selectedId = null;
        this.draggingId = null;
        this.panning = false;
        this.lastPointer = null;
        this.pointerDown = null;
        this.longPressTimer = null;
        this.longPressFired = false;
        this.dragMoved = false;
        this.longPressMs = 600;
        this.longPressTargetId = null;
        this.view = { x: 0, y: 0, zoom: 1 };
        this.nodeMap = new Map();
        this.detail = root.querySelector('.worldnet-detail-host');
        this.longPressRing = root.querySelector('.worldnet-longpress-ring');

        // 生命周期状态
        this.destroyed = false;
        this.animationFrame = null;
        this.fullscreenFrame = null;
        this.ringFrame = null;
        this.isFullscreen = false;
        this.ignoreDblClickUntil = 0;
        this.ignoreClickUntil = 0;

        // 统一管理当前实例绑定的事件
        this.eventController = new AbortController();
        this.eventSignal = this.eventController.signal;

        // 切换中心角色时的过渡状态
        this.transition = null;

        const reduceMotion =
            window.matchMedia &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        this.transitionDuration = reduceMotion ? 0 : 720;

        this.resize = this.resize.bind(this);
        this.loop = this.loop.bind(this);

        this.load();
        this.bindEvents();
        this.resize();
        window.addEventListener('resize', this.resize);
        this.startLoop();
    }

    load({ animate = false, centerId = this.centerId } = {}) {
        // 如果上一次动画还没有结束，先结算到目标状态
        if (this.transition) {
            this.finishTransition();
        }

        const oldCenterId = this.centerId;
        const oldNodeMap = cloneGraphNodeMap(this.nodeMap);
        const oldEdges = cloneGraphEdges(this.edges);

        const activeId = this.options.activeId;
        const all = getAllCharacters();

        let nextCenterId = centerId;

        if (
            !nextCenterId ||
            !all.some(item => item.id === nextCenterId)
        ) {
            nextCenterId =
                activeId && all.some(item => item.id === activeId)
                    ? activeId
                    : all[0]?.id || null;
        }

        const data = createGraphData(nextCenterId);

        const width = Math.max(
            this.canvas.clientWidth || 320,
            1
        );

        const height = Math.max(
            this.canvas.clientHeight || 360,
            1
        );

        createNodePositions(
            data.nodes,
            nextCenterId,
            width,
            height
        );

        const nextNodeMap = new Map(
            data.nodes.map(node => [
                node.id,
                { ...node }
            ])
        );

        const nextEdges = cloneGraphEdges(data.edges);

        this.characters = data.characters;
        this.edges = nextEdges;
        this.centerId = nextCenterId;
        this.selectedId = null;

        this.root.querySelector(
            '.worldnet-center-name'
        ).textContent =
            this.getCharacter(this.centerId)?.name || '暂无角色';

        // 中心角色发生变化，并且已有旧图时，启动过渡动画
        if (
            animate &&
            oldNodeMap.size > 0 &&
            oldCenterId &&
            oldCenterId !== nextCenterId
        ) {
            this.beginCenterTransition({
                oldCenterId,
                newCenterId: nextCenterId,
                oldNodeMap,
                newNodeMap: nextNodeMap,
                oldEdges,
                newEdges: nextEdges,
                width,
                height
            });

            this.startLoop();
            return;
        }

        // 首次加载、重置视图时直接使用新布局
        this.nodeMap = nextNodeMap;
        this.view = {
            x: 0,
            y: 0,
            zoom: 1
        };
    }

    beginCenterTransition({
        oldCenterId,
        newCenterId,
        oldNodeMap,
        newNodeMap,
        oldEdges,
        newEdges,
        width,
        height
    }) {
        this.transition = {
            oldCenterId,
            newCenterId,
            oldNodeMap,
            newNodeMap,
            oldEdges,
            newEdges,
            width,
            height,
            startTime: performance.now(),
            duration: this.transitionDuration,

            fromView: {
                ...this.view
            },

            toView: {
                x: 0,
                y: 0,
                zoom: 1
            }
        };
    }

    finishTransition() {
        if (!this.transition) return;

        const transition = this.transition;

        this.nodeMap = transition.newNodeMap;
        this.edges = transition.newEdges;
        this.centerId = transition.newCenterId;

        this.view = {
            ...transition.toView
        };

        this.transition = null;
    }

    getTransitionMaps(progress) {
        const transition = this.transition;

        if (!transition) return null;

        const p = easeInOutCubic(progress);

        const visibleNodeMap = new Map();
        const nodeOpacity = new Map();

        const newCenterNode =
            transition.newNodeMap.get(transition.newCenterId);

        // 新节点从新中心附近开始，然后向最终位置散开
        const spawnPoint = newCenterNode
            ? {
                x: newCenterNode.x,
                y: newCenterNode.y
            }
            : {
                x: transition.width / 2,
                y: transition.height / 2
            };

        const allIds = new Set([
            ...transition.oldNodeMap.keys(),
            ...transition.newNodeMap.keys()
        ]);

        for (const id of allIds) {
            const oldNode = transition.oldNodeMap.get(id);
            const newNode = transition.newNodeMap.get(id);

            // 新旧图中都存在的节点：从旧位置移动到新位置
            if (oldNode && newNode) {
                visibleNodeMap.set(id, {
                    ...newNode,
                    x: lerp(oldNode.x, newNode.x, p),
                    y: lerp(oldNode.y, newNode.y, p),
                    vx: 0,
                    vy: 0
                });

                nodeOpacity.set(id, 1);
                continue;
            }

            // 旧图中有、新图中没有：向画布外滑出并淡出
            if (oldNode && !newNode) {
                const exitPoint = getExitPoint(
                    oldNode,
                    transition.width,
                    transition.height
                );

                visibleNodeMap.set(id, {
                    ...oldNode,
                    x: lerp(oldNode.x, exitPoint.x, p),
                    y: lerp(oldNode.y, exitPoint.y, p),
                    vx: 0,
                    vy: 0
                });

                nodeOpacity.set(id, 1 - p);
                continue;
            }

            // 新图中有、旧图中没有：从中心位置向外出现
            if (!oldNode && newNode) {
                visibleNodeMap.set(id, {
                    ...newNode,
                    x: lerp(spawnPoint.x, newNode.x, p),
                    y: lerp(spawnPoint.y, newNode.y, p),
                    vx: 0,
                    vy: 0
                });

                nodeOpacity.set(id, p);
            }
        }

        return {
            nodeMap: visibleNodeMap,
            nodeOpacity,
            progress: p,
            view: {
                x: lerp(
                    transition.fromView.x,
                    transition.toView.x,
                    p
                ),
                y: lerp(
                    transition.fromView.y,
                    transition.toView.y,
                    p
                ),
                zoom: lerp(
                    transition.fromView.zoom,
                    transition.toView.zoom,
                    p
                )
            }
        };
    }

    renderTransition(timestamp) {
        const transition = this.transition;

        if (!transition) return;

        const elapsed =
            timestamp - transition.startTime;

        const linearProgress =
            transition.duration <= 0
                ? 1
                : Math.min(
                    elapsed / transition.duration,
                    1
                );

        const maps = this.getTransitionMaps(linearProgress);

        if (!maps) return;

        const width = this.canvas.clientWidth;
        const height = this.canvas.clientHeight;

        this.ctx.clearRect(0, 0, width, height);

        this.ctx.save();

        this.ctx.translate(
            maps.view.x,
            maps.view.y
        );

        this.ctx.scale(
            maps.view.zoom,
            maps.view.zoom
        );

        // 旧关系边淡出
        for (const edge of transition.oldEdges) {
            drawEdge(this.ctx, edge, {
                centerId: transition.oldCenterId,
                selectedId: null,
                nodeMap: maps.nodeMap,
                opacity: 1 - maps.progress
            });
        }

        // 新关系边淡入
        for (const edge of transition.newEdges) {
            drawEdge(this.ctx, edge, {
                centerId: transition.newCenterId,
                selectedId: null,
                nodeMap: maps.nodeMap,
                opacity: maps.progress
            });
        }

        // 节点统一绘制，避免新旧节点重叠闪烁
        for (const node of maps.nodeMap.values()) {
            drawNode(this.ctx, node, {
                centerId: transition.newCenterId,
                selectedId: null,
                nodeMap: maps.nodeMap,
                nodeOpacity: maps.nodeOpacity
            });
        }

        this.ctx.restore();

        if (linearProgress >= 1) {
            this.finishTransition();
        }
    }

    getCharacter(id) {
        return this.characters.find(item => item.id === id) || null;
    }

    toggleFullscreen(force) {
        if (this.destroyed) return;

        const nextState = typeof force === 'boolean'
            ? force
            : !this.isFullscreen;

        this.isFullscreen = nextState;

        this.root.classList.toggle(
            'worldnet-fullscreen-mode',
            nextState
        );

        this.root.classList.toggle(
            'worldnet-preview-mode',
            !nextState
        );

        // 取消上一次尚未执行的全屏切换 RAF
        if (this.fullscreenFrame !== null) {
            cancelAnimationFrame(this.fullscreenFrame);
            this.fullscreenFrame = null;
        }

        // 退出全屏时，主动停止绘制循环
        if (!nextState && !this.transition) {
            if (this.animationFrame !== null) {
                cancelAnimationFrame(this.animationFrame);
                this.animationFrame = null;
            }
        }

        this.fullscreenFrame = requestAnimationFrame(() => {
            this.fullscreenFrame = null;

            if (this.destroyed) return;

            this.resize();

            if (this.isFullscreen && this.animationFrame === null) {
                this.startLoop();
            }
        });
    }

    resize() {
        const rect = this.canvas.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
        this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    showLongPressRing(clientX, clientY) {
        if (!this.longPressRing) return;

        const wrap = this.canvas.parentElement;
        if (!wrap) return;

        const rect = wrap.getBoundingClientRect();

        this.longPressRing.style.left = `${clientX - rect.left}px`;
        this.longPressRing.style.top = `${clientY - rect.top}px`;

        // 重新触发动画，避免连续长按时动画停留在上一状态
        this.longPressRing.classList.remove('is-visible');

        const progress = this.longPressRing.querySelector(
            '.worldnet-longpress-ring-progress'
        );

        if (progress) {
            progress.style.animation = 'none';
            // 强制浏览器重新计算样式，确保下一次动画从 0 开始
            void progress.offsetWidth;
            progress.style.animation =
                `worldnet-longpress-progress ${this.longPressMs}ms linear forwards`;
        }

        if (this.ringFrame !== null) {
            cancelAnimationFrame(this.ringFrame);
            this.ringFrame = null;
        }

        this.ringFrame = requestAnimationFrame(() => {
            this.ringFrame = null;

            if (this.destroyed || !this.longPressRing) return;

            this.longPressRing.classList.add('is-visible');
        });
    }

    hideLongPressRing() {
        if (this.ringFrame !== null) {
            cancelAnimationFrame(this.ringFrame);
            this.ringFrame = null;
        }

        if (!this.longPressRing) return;

        this.longPressRing.classList.remove('is-visible');

        const progress = this.longPressRing.querySelector(
            '.worldnet-longpress-ring-progress'
        );

        if (progress) {
            progress.style.animation = 'none';
        }

        this.longPressTargetId = null;
    }

    closePicker() {
        if (!this.detail) return;

        const picker = this.detail.querySelector(
            '.worldnet-picker-mask'
        );

        if (picker) {
            picker.remove();
        }
    }

    bindEvents() {
        const cancelLongPress = () => {
            if (this.longPressTimer) {
                clearTimeout(this.longPressTimer);
                this.longPressTimer = null;
            }

            this.hideLongPressRing();
        };

        this.canvas.addEventListener(
            'pointerdown',
            event => {
                if (this.transition) {
                    return;
                }
                this.canvas.setPointerCapture?.(event.pointerId);

                const hit = this.hitTest(event.clientX, event.clientY);

                this.pointerDown = {
                    x: event.clientX,
                    y: event.clientY,
                    id: hit?.id || null
                };

                this.lastPointer = {
                    x: event.clientX,
                    y: event.clientY
                };

                this.longPressFired = false;
                this.dragMoved = false;

                if (hit) {
                    this.draggingId = hit.id;
                    this.selectedId = hit.id;
                    this.longPressTargetId = hit.id;

                    // 显示 Demo 版长按进度圈
                    this.showLongPressRing(
                        event.clientX,
                        event.clientY
                    );

                    // 长按节点：切换为中心角色
                    this.longPressTimer = setTimeout(() => {
                        if (
                            this.draggingId === hit.id &&
                            !this.dragMoved
                        ) {
                            this.longPressFired = true;

                            // 长按完成，立即隐藏进度圈
                            this.hideLongPressRing();

                            // 屏蔽长按后浏览器可能补发的 click / dblclick
                            this.ignoreDblClickUntil = performance.now() + 850;
                            this.ignoreClickUntil = performance.now() + 850;

                            this.setCenter(hit.id);

                            // 防止手指仍按住时继续拖动旧节点
                            this.draggingId = null;
                            this.panning = false;
                            this.selectedId = null;

                            cancelLongPress();
                        }
                    }, this.longPressMs);
                } else {
                    this.panning = true;
                    this.selectedId = null;
                }
            },
            { signal: this.eventSignal }
        );

        this.canvas.addEventListener(
            'pointermove',
            event => {
                if (this.transition) return;
                if (!this.lastPointer) return;

                const totalDx = event.clientX - this.pointerDown.x;
                const totalDy = event.clientY - this.pointerDown.y;

                if (Math.abs(totalDx) + Math.abs(totalDy) > 7) {
                    this.dragMoved = true;
                    cancelLongPress();
                }

                const dx = event.clientX - this.lastPointer.x;
                const dy = event.clientY - this.lastPointer.y;

                if (this.draggingId) {
                    const node = this.nodeMap.get(this.draggingId);

                    if (node) {
                        const rect = this.canvas.getBoundingClientRect();

                        node.x =
                            (event.clientX - rect.left - this.view.x) /
                            this.view.zoom;

                        node.y =
                            (event.clientY - rect.top - this.view.y) /
                            this.view.zoom;
                    }
                } else if (this.panning) {
                    this.view.x += dx;
                    this.view.y += dy;
                }

                this.lastPointer = {
                    x: event.clientX,
                    y: event.clientY
                };
            },
            { signal: this.eventSignal }
        );

        const endPointer = event => {
            cancelLongPress();

            // 长按已经执行切中心，不再继续触发其他行为
            if (
                this.longPressFired ||
                this.dragMoved ||
                !this.pointerDown
            ) {
                this.draggingId = null;
                this.panning = false;
                this.lastPointer = null;
                this.pointerDown = null;
                return;
            }

            this.draggingId = null;
            this.panning = false;
            this.lastPointer = null;
            this.pointerDown = null;
        };

        this.canvas.addEventListener(
            'pointerup',
            endPointer,
            { signal: this.eventSignal }
        );

        this.canvas.addEventListener(
            'pointercancel',
            () => {
                cancelLongPress();
                this.draggingId = null;
                this.panning = false;
                this.lastPointer = null;
                this.pointerDown = null;
            },
            { signal: this.eventSignal }
        );

        // 双击节点：打开详情
        this.canvas.addEventListener(
            'dblclick',
            event => {
                event.preventDefault();

                // 长按切中心后，禁止随后产生的 dblclick 打开详情
                if (performance.now() < this.ignoreDblClickUntil) {
                    return;
                }

                // 切换中心动画期间不打开详情，避免命中旧节点
                if (this.transition) {
                    return;
                }

                const hit = this.hitTest(
                    event.clientX,
                    event.clientY
                );

                if (hit) {
                    this.openDetail(hit.id);
                }
            },
            { signal: this.eventSignal }
        );

        // 鼠标滚轮缩放
        this.canvas.addEventListener(
            'wheel',
            event => {
                event.preventDefault();

                const factor = event.deltaY > 0 ? 0.9 : 1.1;
                const rect = this.canvas.getBoundingClientRect();

                const px = event.clientX - rect.left;
                const py = event.clientY - rect.top;

                const nextZoom = Math.max(
                    0.55,
                    Math.min(2.4, this.view.zoom * factor)
                );

                this.view.x =
                    px - (px - this.view.x) *
                    nextZoom / this.view.zoom;

                this.view.y =
                    py - (py - this.view.y) *
                    nextZoom / this.view.zoom;

                this.view.zoom = nextZoom;
            },
            {
                passive: false,
                signal: this.eventSignal
            }
        );

        this.root.addEventListener(
            'click',
            event => {
                const target = event.target;

                // 点击横条预览卡片，进入全屏关系网
                const previewOpen = target.closest('.worldnet-preview-open');

                if (previewOpen && !this.isFullscreen) {
                    event.preventDefault();
                    this.toggleFullscreen(true);
                    return;
                }

                // 点击全屏关闭按钮，回到横条卡片
                const fullscreenClose = target.closest(
                    '.worldnet-fullscreen-close'
                );

                if (fullscreenClose) {
                    event.preventDefault();
                    this.closeDetail();
                    this.closePicker();
                    this.toggleFullscreen(false);
                    return;
                }

                // 选择角色后切换中心
                const centerButton = target.closest('[data-set-center]');

                if (centerButton) {
                    event.preventDefault();
                    this.setCenter(centerButton.dataset.setCenter);
                    this.closeDetail();
                    this.closePicker();
                    return;
                }

                // 关闭详情面板
                if (target.closest('[data-close-detail]')) {
                    this.closeDetail();
                    return;
                }

                // 关闭中心角色选择器
                if (target.closest('[data-close-picker]')) {
                    this.closePicker();
                }
            },
            { signal: this.eventSignal }
        );

        this.root.querySelector('.worldnet-reset-btn')
            ?.addEventListener(
                'click',
                () => {
                    this.view = {
                        x: 0,
                        y: 0,
                        zoom: 1
                    };

                    this.load();
                },
                { signal: this.eventSignal }
            );

        this.root.querySelector('.worldnet-search-btn')
            ?.addEventListener(
                'click',
                () => {
                    this.showPicker();
                },
                { signal: this.eventSignal }
            );
    }

    hitTest(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        const x = (clientX - rect.left - this.view.x) / this.view.zoom;
        const y = (clientY - rect.top - this.view.y) / this.view.zoom;

        let result = null;
        let min = Infinity;

        for (const node of this.nodeMap.values()) {
            const dx = node.x - x;
            const dy = node.y - y;
            const d = Math.sqrt(dx * dx + dy * dy);

            if (d < 52 && d < min) {
                result = node;
                min = d;
            }
        }

        return result;
    }

    openDetail(id) {
        const character = this.getCharacter(id);
        if (!character || !this.detail) return;

        this.detail.innerHTML = renderDetailPanel(
            character,
            makeEdges(this.characters),
            () => this.closeDetail()
        );
    }

    closeDetail() {
        if (this.detail) this.detail.innerHTML = '';
    }

    setCenter(id) {
        if (!id) return;

        const all = getAllCharacters();

        if (!all.some(item => item.id === id)) {
            return;
        }

        // 已经是当前中心时，不重复播放动画
        if (
            id === this.centerId &&
            !this.transition
        ) {
            this.selectedId = null;
            return;
        }

        this.selectedId = null;

        this.load({
            animate: true,
            centerId: id
        });
    }

    showPicker() {
        const characters = getAllCharacters();
        const html = `
            <div class="worldnet-picker-mask" data-close-picker="true">
                <section class="worldnet-picker-panel">
                    <button class="worldnet-picker-close" data-close-picker="true">×</button>
                    <h2>切换关系网中心</h2>
                    <p>选择一个角色，以 TA 的视角查看已记录的关系。</p>
                    <input class="worldnet-picker-input" placeholder="搜索角色名称或简介">
                    <div class="worldnet-picker-list">
                        ${characters.map(character => `
                            <button class="worldnet-picker-item" data-picker-id="${esc(character.id)}">
                                <span class="worldnet-picker-emoji">${esc(character.emoji)}</span>
                                <span>
                                    <strong>${esc(character.name)}</strong>
                                    <small>${esc(character.role || character.type || '')}</small>
                                </span>
                            </button>
                        `).join('')}
                    </div>
                </section>
            </div>
        `;

        this.detail.innerHTML = html;

        this.detail.querySelectorAll('[data-picker-id]').forEach(button => {
            button.addEventListener('click', () => {
                const id = button.dataset.pickerId;

                this.closePicker();
                this.setCenter(id);
            });
        });

        const input = this.detail.querySelector('.worldnet-picker-input');
        input?.addEventListener('input', () => {
            const query = input.value.trim().toLowerCase();

            this.detail.querySelectorAll('.worldnet-picker-item').forEach(item => {
                item.hidden = !item.textContent.toLowerCase().includes(query);
            });
        });
    }

    renderGraph() {
        const width = this.canvas.clientWidth;
        const height = this.canvas.clientHeight;

        this.ctx.clearRect(0, 0, width, height);

        this.ctx.save();
        this.ctx.translate(this.view.x, this.view.y);
        this.ctx.scale(this.view.zoom, this.view.zoom);

        const state = {
            centerId: this.centerId,
            selectedId: this.selectedId,
            nodeMap: this.nodeMap
        };

        for (const edge of this.edges) {
            drawEdge(this.ctx, edge, state);
        }

        for (const node of this.nodeMap.values()) {
            drawNode(this.ctx, node, state);
        }

        this.ctx.restore();
    }

    startLoop() {
        if (this.destroyed) return;

        if (this.animationFrame !== null) return;

        this.animationFrame = requestAnimationFrame(this.loop);
    }

    loop(timestamp = performance.now()) {
        // 当前 RAF 已经开始执行，先清空 ID
        this.animationFrame = null;

        if (
            this.destroyed ||
            (!this.isFullscreen && !this.transition)
        ) {
            return;
        }

        if (this.transition) {
            this.renderTransition(timestamp);
        } else {
            this.renderGraph();
        }

        this.startLoop();
    }

    destroy() {
        // 防止重复销毁
        if (this.destroyed) return;

        this.destroyed = true;

        // 清理长按计时器
        if (this.longPressTimer !== null) {
            clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }

        // 清理所有待执行 RAF
        if (this.animationFrame !== null) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = null;
        }

        if (this.fullscreenFrame !== null) {
            cancelAnimationFrame(this.fullscreenFrame);
            this.fullscreenFrame = null;
        }

        if (this.ringFrame !== null) {
            cancelAnimationFrame(this.ringFrame);
            this.ringFrame = null;
        }

        // 隐藏长按圆圈
        this.hideLongPressRing();

        // 解绑 window resize
        window.removeEventListener('resize', this.resize);

        // 一次性解绑 canvas/root 上使用 eventSignal 注册的所有事件
        this.eventController?.abort();

        // 清空可能仍然引用大量节点和边的对象
        this.transition = null;
        this.nodeMap.clear();
        this.characters = [];
        this.edges = [];
        this.detail?.replaceChildren();
    }
}

export function renderWorldNetGraph(options = {}) {
    return `
        <section class="${GRAPH_ROOT_CLASS} worldnet-preview-mode">
            <button
                type="button"
                class="worldnet-preview-open"
                aria-label="打开全屏关系网"
            >
                <span class="worldnet-preview-main">
                    <span class="worldnet-preview-icon">🌐</span>
                    <span class="worldnet-preview-copy">
                        <strong>世界关系网</strong>
                        <small>
                            中心：<b class="worldnet-center-name">加载中</b>
                        </small>
                    </span>
                </span>
                <span class="worldnet-preview-arrow">›</span>
            </button>

            <div class="worldnet-fullscreen-head">
                <div class="worldnet-graph-toolbar">
                    <div>
                        <strong>关系网</strong>
                        <span>
                            中心：<b class="worldnet-center-name">加载中</b>
                        </span>
                    </div>
                    <div class="worldnet-graph-actions">
                        <button
                            type="button"
                            class="worldnet-search-btn"
                            title="切换中心"
                        >⌕</button>
                        <button
                            type="button"
                            class="worldnet-reset-btn"
                            title="重置视图"
                        >⊙</button>
                        <button
                            type="button"
                            class="worldnet-fullscreen-close"
                            title="关闭全屏关系网"
                        >×</button>
                    </div>
                </div>
            </div>

<div class="worldnet-graph-canvas-wrap">
    <canvas class="worldnet-graph-canvas"></canvas>

    <!-- 长按进度提示圈 -->
    <div class="worldnet-longpress-ring" aria-hidden="true">
        <div class="worldnet-longpress-ring-progress"></div>
    </div>

    <div class="worldnet-graph-hint">
        单击选中 · 双击详情 · 长按切换中心
    </div>
</div>

            <div class="worldnet-legend">
                ${renderLegend()}
            </div>

            <div class="worldnet-detail-host"></div>
        </section>
    `;
}

export function mountWorldNetGraph(container, options = {}) {
    const root = container.querySelector(`.${GRAPH_ROOT_CLASS}`);
    if (!root) return null;

    const previous = mountedGraphs.get(container);

    if (previous) {
        previous.destroy();
    }

    const graph = new WorldNetGraph(root, options);
    mountedGraphs.set(container, graph);
    return graph;
}

export function unmountWorldNetGraph(container) {
    const graph = mountedGraphs.get(container);

    if (!graph) return;

    graph.destroy();
    mountedGraphs.delete(container);
}
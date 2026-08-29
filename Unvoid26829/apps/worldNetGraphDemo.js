// apps/worldNetGraphDemo.js
// 世界关系网 Demo 视觉版
//
// A -> B 与 B -> A 是角色各自独立的认知，不能合并。
// 本文件只负责关系网的读取、绘制和交互，不修改角色资料。

import { CharacterStore } from '../store/CharacterStore.js';
import { esc } from '../store/utils.js';
import { getAvatarHtml } from '../store/ImageCache.js';

const GRAPH_ROOT_CLASS = 'worldnet-graph-module';

const REL_STYLES = {
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

const PALETTE = [
    '#FF6B9D',
    '#4ECDC4',
    '#FFD93D',
    '#AA96DA',
    '#6C5CE7',
    '#F38181',
    '#74B9FF',
    '#A29BFE',
    '#FD79A8',
    '#00B894',
    '#FAB1A0',
    '#DFE6E9',
    '#55EFC4',
    '#FF7675',
    '#FDCB6E',
    '#636E72'
];

const mountedGraphs = new WeakMap();

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function hashIdToColor(id) {
    const text = String(id || '');
    let hash = 0;

    for (let i = 0; i < text.length; i += 1) {
        hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    }

    return PALETTE[hash % PALETTE.length];
}

function getCharacterColor(character) {
    const color = character?.profile?.color;

    if (
        typeof color === 'string'
        && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)
    ) {
        return color;
    }

    return hashIdToColor(character?.id);
}

function classifyRelation(value) {
    const text = String(value || '').toLowerCase();

    if (/恋人|伴侣|爱人|情侣|结婚|夫妻|婚姻/.test(text)) {
        return 'romance';
    }

    if (/家人|亲属|母亲|父亲|母女|父女|兄弟|姐妹|亲戚/.test(text)) {
        return 'family';
    }

    if (/暗恋|喜欢|好感|欣赏|心动|在意/.test(text)) {
        return 'crush';
    }

    if (/敌人|敌对|仇人|憎恨|厌恶|死敌/.test(text)) {
        return 'enemy';
    }

    if (/对手|竞争|rival|看不顺眼/.test(text)) {
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

function readStoredList(key) {
    try {
        const value = JSON.parse(
            localStorage.getItem(key) || '[]'
        );

        return Array.isArray(value) ? value : [];
    } catch (error) {
        console.warn(
            '[WorldNetGraphDemo] 读取角色列表失败:',
            key,
            error
        );
        return [];
    }
}

function getAllCharacters() {
    const result = [];
    const seen = new Set();

    const sources = [
        ['rolebook_characters', 'character'],
        ['worldnet_extra_characters', 'npc'],
        ['rolebook_archived', 'archived']
    ];

    for (const [key, source] of sources) {
        for (const item of readStoredList(key)) {
            if (!item?.id || seen.has(item.id)) continue;

            seen.add(item.id);

            try {
                const base = item.base || {};
                const store = new CharacterStore(item.id);

                const info = store.getInfo() || {};
                const profile = store.getProfile() || {};
                const relations = store.getRelations() || [];
                const friendIds = store.getFriendIds?.() || [];

                const contactIds = new Set(
                    Array.isArray(friendIds)
                        ? friendIds.filter(Boolean)
                        : []
                );

                const avatar =
                    base.emoji
                    || info.emoji
                    || '👤';

                const name =
                    base.name
                    || info.name
                    || item.id;

                const bio =
                    base.desc
                    || info.desc
                    || '';

                const role =
                    base.role
                    || info.label
                    || item.type
                    || source;

                const faction =
                    base.faction
                    || info.faction
                    || '';

                result.push({
                    id: item.id,
                    name,
                    avatar,
                    emoji: avatar,
                    bio,
                    desc: bio,
                    detail: base.detail || '',
                    role,
                    faction,
                    type: item.type || source,
                    color: getCharacterColor({
                        id: item.id,
                        profile
                    }),
                    tags: Array.isArray(base.tags)
                        ? base.tags
                        : [],
                    relations: Array.isArray(relations)
                        ? relations
                        : [],
                    contactIds,
                    profile,
                    archived: Boolean(item.archived)
                });
            } catch (error) {
                console.warn(
                    '[WorldNetGraphDemo] 读取角色失败:',
                    item.id,
                    error
                );
            }
        }
    }

    return result;
}

function makeEdges(characters) {
    const ids = new Set(
        characters.map(character => character.id)
    );

    const edges = [];

    for (const character of characters) {
        for (const relation of character.relations || []) {
            const targetId = relation?.id;

            if (!targetId) continue;
            if (targetId === character.id) continue;
            if (!ids.has(targetId)) continue;

            const label =
                relation.relation
                || relation.name
                || '其他';

            // 不去重。每个角色的关系认知独立存在。
            edges.push({
                source: character.id,
                target: targetId,
                type: classifyRelation(label),
                label,
                intensity: Number.isFinite(relation.intensity)
                    ? clamp(relation.intensity, 0, 1)
                    : 0.5,
                perspective: relation.perspective || '',
                attitudes: Array.isArray(relation.attitudes)
                    ? [...relation.attitudes]
                    : []
            });
        }
    }

    return edges;
}

function cloneNode(node) {
    return {
        ...node,
        vx: Number(node.vx) || 0,
        vy: Number(node.vy) || 0,
        fx: node.fx ?? null,
        fy: node.fy ?? null,
        _ds: Number.isFinite(node._ds)
            ? node._ds
            : 1
    };
}

function cloneNodePool(pool) {
    return new Map(
        [...pool.entries()].map(([id, node]) => [
            id,
            cloneNode(node)
        ])
    );
}

function cloneEdges(edges) {
    return (edges || []).map(edge => ({
        ...edge,
        attitudes: Array.isArray(edge.attitudes)
            ? [...edge.attitudes]
            : []
    }));
}

function roundRect(ctx, x, y, width, height, radius) {
    const r = Math.min(
        radius,
        width / 2,
        height / 2
    );

    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(
        x + width,
        y,
        x + width,
        y + height,
        r
    );
    ctx.arcTo(
        x + width,
        y + height,
        x,
        y + height,
        r
    );
    ctx.arcTo(
        x,
        y + height,
        x,
        y,
        r
    );
    ctx.arcTo(
        x,
        y,
        x + width,
        y,
        r
    );
    ctx.closePath();
}

class ForceLayout {
    constructor(nodePool, options = {}) {
        this.nodePool = nodePool;
        this.activeIds = new Set();
        this.activeEdges = [];

        this.alpha = 0;
        this.alphaMin = 0.005;
        this.alphaDecay = 0.04;
        this.velocityDecay = 0.4;

        this.chargeStrength =
            options.chargeStrength ?? -360;

        this.linkStrength =
            options.linkStrength ?? 0.4;

        this.linkDistance =
            options.linkDistance ?? 95;

        this.centerStrength =
            options.centerStrength ?? 0.04;

        this.collideRadius =
            options.collideRadius ?? 46;

        this.isolatedRadius =
            options.isolatedRadius ?? 155;

        this.isolatedStrength =
            options.isolatedStrength ?? 0.055;


        this.center = {
            x: 0,
            y: 0
        };
    }

    setCenter(x, y) {
        this.center.x = x;
        this.center.y = y;
    }

    reheat(alpha = 0.3) {
        if (alpha > this.alpha) {
            this.alpha = alpha;
        }
    }

    isStable() {
        return this.alpha < this.alphaMin;
    }

    setActive(ids, edges) {
        this.activeIds = new Set(ids);
        this.activeEdges = edges || [];

        for (const edge of this.activeEdges) {
            edge._s = this.nodePool.get(edge.source);
            edge._t = this.nodePool.get(edge.target);
        }

        const newIds = [];

        for (const id of this.activeIds) {
            const node = this.nodePool.get(id);

            if (node && !Number.isFinite(node.x)) {
                newIds.push(id);
            }
        }

        if (newIds.length > 0) {
            this.seedPositions(newIds);
        }
    }

    seedPositions(ids) {
        let centerX = this.center.x;
        let centerY = this.center.y;

        for (const id of ids) {
            const node = this.nodePool.get(id);

            if (node?.fx != null) {
                centerX = node.fx;
                centerY = node.fy;
                break;
            }
        }

        const regularIds = ids.filter(id => {
            const node = this.nodePool.get(id);
            return node && !node.isIsolatedContact;
        });

        const isolatedIds = ids.filter(id => {
            const node = this.nodePool.get(id);
            return node?.isIsolatedContact;
        });

        const seedGroup = (group, radius) => {
            group.forEach((id, index) => {
                const node = this.nodePool.get(id);

                if (!node || Number.isFinite(node.x)) {
                    return;
                }

                const angle =
                    index / Math.max(group.length, 1)
                    * Math.PI
                    * 2
                    - Math.PI / 2;

                node.x =
                    centerX
                    + Math.cos(angle) * radius;

                node.y =
                    centerY
                    + Math.sin(angle) * radius;

                node.vx = 0;
                node.vy = 0;
            });
        };

        seedGroup(
            regularIds,
            118
        );

        seedGroup(
            isolatedIds,
            Math.max(
                this.isolatedRadius,
                Math.min(this.center.x, this.center.y) * 0.72
            )
        );
    }

    tick() {
        if (this.alpha < this.alphaMin) {
            return false;
        }

        const nodes = [];

        for (const id of this.activeIds) {
            const node = this.nodePool.get(id);

            if (node) {
                nodes.push(node);
            }
        }

        const alpha = this.alpha;
        const cx = this.center.x;
        const cy = this.center.y;
        const charge =
            Math.abs(this.chargeStrength) * alpha;

        const centerForce =
            this.centerStrength * alpha;

        const linkForce =
            this.linkStrength * alpha;

        // 1. 中心吸引 / 外围联系人约束
        for (const node of nodes) {
            if (node.fx != null) continue;

            if (node.isIsolatedContact) {
                const dx = node.x - cx;
                const dy = node.y - cy;
                const distance =
                    Math.sqrt(dx * dx + dy * dy) || 0.01;

                // 无关系联系人保持在外围环带。
                // 距离太近时向外推，距离太远时轻微拉回。
                const difference =
                    this.isolatedRadius - distance;

                const radialForce =
                    difference
                    * this.isolatedStrength
                    * alpha;

                node.vx += dx / distance * radialForce;
                node.vy += dy / distance * radialForce;

                continue;
            }

            node.vx += (cx - node.x) * centerForce;
            node.vy += (cy - node.y) * centerForce;
        }

        // 2. 节点斥力
        for (let i = 0; i < nodes.length; i += 1) {
            const first = nodes[i];

            if (first.fx != null) continue;

            for (
                let j = i + 1;
                j < nodes.length;
                j += 1
            ) {
                const second = nodes[j];

                let dx = first.x - second.x;
                let dy = first.y - second.y;
                let distance2 = dx * dx + dy * dy;

                if (distance2 < 1) {
                    dx = Math.random() - 0.5;
                    dy = Math.random() - 0.5;
                    distance2 =
                        dx * dx
                        + dy * dy
                        + 0.01;
                }

                const distance = Math.sqrt(distance2);
                const force = charge / distance2;
                const fx = dx / distance * force;
                const fy = dy / distance * force;

                first.vx += fx;
                first.vy += fy;

                if (second.fx == null) {
                    second.vx -= fx;
                    second.vy -= fy;
                }
            }
        }

        // 3. 关系边弹簧
        for (const edge of this.activeEdges) {
            const source = edge._s;
            const target = edge._t;

            if (!source || !target) continue;

            const dx = target.x - source.x;
            const dy = target.y - source.y;
            const distance =
                Math.sqrt(dx * dx + dy * dy)
                || 0.01;

            const desired =
                this.linkDistance
                * (1.5 - edge.intensity * 0.5);

            const difference =
                (distance - desired) / distance;

            const fx =
                dx
                * difference
                * linkForce;

            const fy =
                dy
                * difference
                * linkForce;

            if (source.fx == null) {
                source.vx += fx;
                source.vy += fy;
            }

            if (target.fx == null) {
                target.vx -= fx;
                target.vy -= fy;
            }
        }

        // 4. 碰撞
        for (let i = 0; i < nodes.length; i += 1) {
            const first = nodes[i];

            if (first.fx != null) continue;

            for (
                let j = i + 1;
                j < nodes.length;
                j += 1
            ) {
                const second = nodes[j];
                const dx = second.x - first.x;
                const dy = second.y - first.y;
                const distance =
                    Math.sqrt(dx * dx + dy * dy)
                    || 0.01;

                const firstRadius =
                    first.isIsolatedContact
                        ? this.collideRadius * 0.72
                        : this.collideRadius;

                const secondRadius =
                    second.isIsolatedContact
                        ? this.collideRadius * 0.72
                        : this.collideRadius;

                const minimum =
                    firstRadius + secondRadius;

                if (distance >= minimum) continue;

                const push =
                    (minimum - distance)
                    / distance
                    * 0.5;

                const fx = dx * push;
                const fy = dy * push;

                first.vx -= fx;
                first.vy -= fy;

                if (second.fx == null) {
                    second.vx += fx;
                    second.vy += fy;
                }
            }
        }

        // 5. 更新速度和位置
        const velocityMultiplier =
            1 - this.velocityDecay;

        for (const node of nodes) {
            if (node.fx != null) {
                node.x = node.fx;
                node.y = node.fy;
                node.vx = 0;
                node.vy = 0;
                continue;
            }

            node.vx *= velocityMultiplier;
            node.vy *= velocityMultiplier;

            const speed2 =
                node.vx * node.vx
                + node.vy * node.vy;

            if (speed2 > 900) {
                const speed = Math.sqrt(speed2);

                node.vx =
                    node.vx / speed * 30;

                node.vy =
                    node.vy / speed * 30;
            }

            node.x += node.vx;
            node.y += node.vy;
        }

        this.alpha += (0 - this.alpha) * this.alphaDecay;

        return true;
    }
}

class GraphRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.dpr = Math.min(
            window.devicePixelRatio || 1,
            1.5
        );
        this.width = 0;
        this.height = 0;
        this.resize();
    }

    resize() {
        const rect =
            this.canvas.getBoundingClientRect();

        this.width = rect.width;
        this.height = rect.height;

        if (this.width <= 0 || this.height <= 0) {
            return;
        }

        this.canvas.width =
            Math.floor(this.width * this.dpr);

        this.canvas.height =
            Math.floor(this.height * this.dpr);

        this.ctx.setTransform(
            this.dpr,
            0,
            0,
            this.dpr,
            0,
            0
        );
    }

    render(state) {
        const { ctx, width, height } = this;

        ctx.clearRect(0, 0, width, height);

        ctx.save();
        ctx.translate(
            state.view.x,
            state.view.y
        );
        ctx.scale(
            state.view.zoom,
            state.view.zoom
        );

        for (const edge of state.visibleEdges) {
            this.drawEdge(edge, state);
        }

        for (const node of state.visibleNodes) {
            this.drawNode(
                node,
                state,
                width / 2,
                height / 2
            );
        }

        ctx.restore();
    }

    drawNode(node, state, centerX, centerY) {
        const ctx = this.ctx;
        const isCenter =
            node.id === state.centerId;

        const isSelected =
            node.id === state.selectedId;

        const isHovered =
            node.id === state.hoveredId;

        // 与 drawEdge() 使用完全相同的高亮判定。
        // 不使用额外的黄色或特殊高亮颜色。
        const isHighlighted =
            isSelected || isHovered;

        const dx = node.x - centerX;
        const dy = node.y - centerY;
        const distance =
            Math.sqrt(dx * dx + dy * dy);

        const maxDistance =
            Math.min(widthOrFallback(this.width), heightOrFallback(this.height))
            * 0.55;

        const depth = clamp(
            distance / Math.max(maxDistance, 1),
            0,
            1
        );

        const targetScale =
            isCenter
                ? 1.18
                : node.isIsolatedContact
                    ? 0.72
                    : 1;

        node._ds += (
            targetScale - node._ds
        ) * 0.18;

        const scale =
            node._ds * (1 - depth * 0.1);

        const normalAlpha =
            isCenter
                ? 1
                : 1 - depth * 0.5;

        // 被选中或悬停的节点提高到完整不透明度。
        // 其他节点仍保留 Demo 原本的景深透明度。
        const alpha =
            isHighlighted
                ? 1
                : normalAlpha;

        const baseWidth =
            isCenter
                ? 92
                : node.isIsolatedContact
                    ? 62
                    : 78;

        const baseHeight =
            isCenter
                ? 52
                : node.isIsolatedContact
                    ? 36
                    : 44;

        const nodeWidth = baseWidth * scale;
        const nodeHeight = baseHeight * scale;

        const radius = 14 * scale;
        const x = node.x - nodeWidth / 2;
        const y = node.y - nodeHeight / 2;

        ctx.save();
        ctx.globalAlpha = alpha;

        ctx.fillStyle =
            'rgba(15, 20, 32, 0.92)';

        roundRect(
            ctx,
            x,
            y,
            nodeWidth,
            nodeHeight,
            radius
        );
        ctx.fill();

        // 高亮仍使用角色自己的颜色，不额外切换黄色。
        let borderColor =
            node.color || '#9AA4B2';

        let borderWidth =
            isHighlighted || isCenter
                ? 2
                : 1;

        ctx.strokeStyle = borderColor;
        ctx.lineWidth = borderWidth;
        ctx.shadowBlur = 0;

        roundRect(
            ctx,
            x,
            y,
            nodeWidth,
            nodeHeight,
            radius
        );
        ctx.stroke();

        ctx.shadowBlur = 0;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const avatarSize =
            isCenter
                ? 22
                : node.isIsolatedContact
                    ? 15
                    : 18;

        ctx.font =
            `${avatarSize * scale}px `
            + '-apple-system, "Apple Color Emoji", '
            + '"Segoe UI Emoji", sans-serif';

        ctx.fillStyle = '#fff';
        ctx.fillText(
            node.avatar || '👤',
            node.x,
            node.y - 4 * scale
        );

        const nameSize =
            isCenter
                ? 12
                : node.isIsolatedContact
                    ? 9
                    : 11;

        ctx.font =
            `600 ${nameSize * scale}px `
            + '-apple-system, "PingFang SC", sans-serif';

        ctx.fillText(
            node.name || '未知角色',
            node.x,
            node.y + 14 * scale
        );

        if (isCenter) {
            ctx.font = '500 9px sans-serif';
            ctx.fillStyle =
                node.color || '#4ECDC4';

            ctx.fillText(
                '中心',
                node.x,
                y + nodeHeight - 5
            );
        }

        ctx.restore();
    }

    drawEdge(edge, state) {
        const ctx = this.ctx;
        const source = edge._s;
        const target = edge._t;

        if (!source || !target) return;

        const style =
            REL_STYLES[edge.type]
            || REL_STYLES.other;

        const isSelectedEdge =
            Boolean(state.selectedId)
            && (
                source.id === state.selectedId
                || target.id === state.selectedId
            );

        const isHoveredEdge =
            Boolean(state.hoveredId)
            && (
                source.id === state.hoveredId
                || target.id === state.hoveredId
            );

        const isHighlighted =
            isSelectedEdge || isHoveredEdge;

        const isCenterEdge =
            source.id === state.centerId
            || target.id === state.centerId;

        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const distance =
            Math.sqrt(dx * dx + dy * dy);

        if (distance < 1) return;

        const unitX = dx / distance;
        const unitY = dy / distance;

        const sourceX = source.x + unitX * 48;
        const sourceY = source.y + unitY * 32;
        const targetX = target.x - unitX * 48;
        const targetY = target.y - unitY * 32;

        const middleX =
            (sourceX + targetX) / 2;

        const middleY =
            (sourceY + targetY) / 2;

        const normalX = -dy / distance;
        const normalY = dx / distance;
        const curve = 25;

        const controlX =
            middleX + normalX * curve;

        const controlY =
            middleY + normalY * curve;

        ctx.save();

        ctx.globalAlpha =
            isHighlighted
                ? 1
                : isCenterEdge
                    ? 0.7
                    : 0.45;

        ctx.strokeStyle = style.color;
        ctx.lineWidth =
            isHighlighted
                ? 1.5 + edge.intensity * 1.5
                : 0.8 + edge.intensity * 1.2;

        ctx.lineCap = 'round';
        ctx.setLineDash(style.dash || []);

        ctx.shadowBlur = 0;

        ctx.beginPath();
        ctx.moveTo(sourceX, sourceY);
        ctx.quadraticCurveTo(
            controlX,
            controlY,
            targetX,
            targetY
        );
        ctx.stroke();

        ctx.shadowBlur = 0;
        ctx.setLineDash([]);

        this.drawArrow(
            targetX,
            targetY,
            controlX,
            controlY,
            style.color,
            isHighlighted ? 7 : 6
        );

        if (isHighlighted && edge.label) {
            ctx.font = '500 10px sans-serif';

            const textWidth =
                ctx.measureText(edge.label).width + 10;

            const labelX =
                middleX + normalX * curve * 0.35;

            const labelY =
                middleY + normalY * curve * 0.35;

            ctx.fillStyle =
                'rgba(10, 14, 26, 0.92)';

            roundRect(
                ctx,
                labelX - textWidth / 2,
                labelY - 9,
                textWidth,
                18,
                6
            );
            ctx.fill();

            ctx.fillStyle = style.color;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(
                edge.label,
                labelX,
                labelY
            );
        }

        ctx.restore();
    }

    drawArrow(x, y, controlX, controlY, color, size) {
        const dx = x - controlX;
        const dy = y - controlY;
        const length =
            Math.sqrt(dx * dx + dy * dy)
            || 0.01;

        const unitX = dx / length;
        const unitY = dy / length;

        const ctx = this.ctx;

        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(
            x - unitX * size - unitY * size * 0.5,
            y - unitY * size + unitX * size * 0.5
        );
        ctx.lineTo(
            x - unitX * size + unitY * size * 0.5,
            y - unitY * size - unitX * size * 0.5
        );
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
    }
}

function widthOrFallback(value) {
    return value > 0 ? value : 320;
}

function heightOrFallback(value) {
    return value > 0 ? value : 390;
}

class InteractionController {
    constructor(canvas, root, callbacks, signal) {
        this.canvas = canvas;
        this.root = root;
        this.callbacks = callbacks;
        this.signal = signal;

        this.dragging = null;
        this.dragMoved = false;
        this.longPressMs = 500;
        this.longPressTimer = null;
        this.longPressFired = false;
        this.longPressStart = null;
        this.lastPointer = null;
        this.isPanning = false;

        this.pressRing =
            root.querySelector('#longpressRing');

        this.bindEvents();
    }

    bindEvents() {
        const signal = this.signal;
        const canvas = this.canvas;

        canvas.addEventListener(
            'mousedown',
            event => {
                this.onDown(
                    event.clientX,
                    event.clientY
                );
            },
            { signal }
        );

        canvas.addEventListener(
            'mousemove',
            event => {
                this.onMove(
                    event.clientX,
                    event.clientY
                );
            },
            { signal }
        );

        canvas.addEventListener(
            'mouseup',
            event => {
                this.onUp(
                    event.clientX,
                    event.clientY
                );
            },
            { signal }
        );

        canvas.addEventListener(
            'mouseleave',
            () => this.onUp(null, null),
            { signal }
        );

        canvas.addEventListener(
            'wheel',
            event => this.onWheel(event),
            {
                passive: false,
                signal
            }
        );

        canvas.addEventListener(
            'touchstart',
            event => {
                const touch = event.touches[0];

                if (touch) {
                    this.onDown(
                        touch.clientX,
                        touch.clientY
                    );
                }
            },
            {
                passive: true,
                signal
            }
        );

        canvas.addEventListener(
            'touchmove',
            event => {
                const touch = event.touches[0];

                if (touch) {
                    this.onMove(
                        touch.clientX,
                        touch.clientY
                    );
                }
            },
            {
                passive: true,
                signal
            }
        );

        canvas.addEventListener(
            'touchend',
            () => this.onUp(null, null),
            { signal }
        );
    }

    showRing(x, y) {
        if (!this.pressRing) return;

        this.pressRing.style.left = `${x}px`;
        this.pressRing.style.top = `${y}px`;
        this.pressRing.classList.add('show');
    }

    hideRing() {
        this.pressRing?.classList.remove('show');
    }

    clearLongPress() {
        if (this.longPressTimer !== null) {
            clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }

        this.hideRing();
    }

    onDown(x, y) {
        if (x == null || y == null) return;

        this.dragMoved = false;
        this.longPressFired = false;

        const hitId =
            this.callbacks.hitTest(x, y);

        if (hitId) {
            this.dragging = hitId;
            this.longPressStart = { x, y };

            this.callbacks.onNodeDown?.(hitId);
            this.showRing(x, y);

            this.longPressTimer = setTimeout(() => {
                this.longPressTimer = null;

                if (
                    this.dragging === hitId
                    && !this.dragMoved
                ) {
                    this.longPressFired = true;
                    this.callbacks.onNodeLongPress?.(hitId);
                    this.hideRing();
                }
            }, this.longPressMs);
        } else {
            this.isPanning = true;
        }

        this.lastPointer = { x, y };
    }

    onMove(x, y) {
        if (x == null || y == null) return;

        if (this.dragging) {
            const dx =
                x - this.longPressStart.x;

            const dy =
                y - this.longPressStart.y;

            if (Math.abs(dx) + Math.abs(dy) > 5) {
                this.dragMoved = true;
                this.clearLongPress();
            }

            this.callbacks.onNodeDrag?.(
                this.dragging,
                x,
                y
            );
        } else if (this.isPanning && this.lastPointer) {
            this.callbacks.onPan?.(
                x - this.lastPointer.x,
                y - this.lastPointer.y
            );
        } else {
            const hitId =
                this.callbacks.hitTest(x, y);

            this.callbacks.onHover?.(
                hitId,
                x,
                y
            );
        }

        this.lastPointer = { x, y };
    }

    onUp(x, y) {
        this.clearLongPress();

        if (this.dragging) {
            if (
                !this.longPressFired
                && !this.dragMoved
            ) {
                this.callbacks.onNodeClick?.(
                    this.dragging
                );
            }

            this.callbacks.onNodeUp?.(this.dragging);
        } else if (x != null && y != null) {
            this.callbacks.onBackgroundClick?.();
        }

        this.dragging = null;
        this.isPanning = false;
        this.lastPointer = null;
    }

    onWheel(event) {
        event.preventDefault();
        this.callbacks.onZoom?.(
            event.deltaY > 0 ? 0.9 : 1.1,
            event.clientX,
            event.clientY
        );
    }

    destroy() {
        this.clearLongPress();
        this.dragging = null;
        this.isPanning = false;
        this.lastPointer = null;
    }
}

class RelationshipApp {
    constructor(root, options = {}) {
        this.root = root;
        this.options = options;
        this.destroyed = false;

        this.canvas = root.querySelector('#graph');
        this.wrap = root.querySelector('#graphWrap');
        this.tooltip = root.querySelector('#tooltip');
        this.detailPanel =
            root.querySelector('#detailPanel');
        this.picker = root.querySelector('#picker');
        this.povTag = root.querySelector('#povTag');
        this.centerText =
            root.querySelector('#centerText');
        this.hint = root.querySelector('#hint');

        this.isFullscreen =
            !root.classList.contains(
                'worldnet-preview-mode'
            );

        this.eventController =
            new AbortController();

        this.signal =
            this.eventController.signal;

        this.characters = [];
        this.relationships = [];
        this.nodePool = new Map();

        this.povId = null;

        this.state = {
            centerId: null,
            selectedId: null,
            hoveredId: null,
            detailId: null,
            view: {
                x: 0,
                y: 0,
                zoom: 1
            }
        };

        this.layout = null;
        this.renderer = null;
        this.interaction = null;

        this.rafId = null;
        this.started = false;
        this.lastTick = 0;
        this.longPressAt = 0;
        // 固定 loop 的 this，避免每一帧重复创建绑定函数。
        this.loop = this.loop.bind(this);

        this.refreshData();
        this.povId =
            this.resolveCenterId(options.activeId);

        this.state.centerId = this.povId;

        this.bindModeSwitch();

        if (this.isFullscreen) {
            this.startGraph();
        } else {
            this.updatePreviewCenterName();
        }
    }

    refreshData() {
        // getAllCharacters() 已经一次性读取角色的：
        // info、profile、relations 和 contactIds。
        this.characters = getAllCharacters();
        this.relationships = makeEdges(this.characters);

        const currentIds = new Set(
            this.characters.map(character => character.id)
        );

        for (const character of this.characters) {
            const existingNode =
                this.nodePool.get(character.id);

            if (existingNode) {
                // character 不包含 x、y、vx、vy、fx、fy，
                // 因此更新资料不会重置已有布局。
                Object.assign(existingNode, character);
            } else {
                this.nodePool.set(character.id, {
                    ...character,

                    // 新节点进入可见范围时，
                    // 由 ForceLayout.seedPositions() 初始化位置。
                    x: undefined,
                    y: undefined,
                    vx: 0,
                    vy: 0,
                    fx: null,
                    fy: null,
                    _ds: 1,

                    // 当前视图状态由 computeVisible() 更新。
                    isCenter: false,
                    isContact: false,
                    isIsolatedContact: false
                });
            }
        }

        // 清理已经被删除的角色。
        for (const id of this.nodePool.keys()) {
            if (!currentIds.has(id)) {
                this.nodePool.delete(id);
            }
        }

        if (!this.layout) {
            this.layout = new ForceLayout(this.nodePool);
        } else {
            this.layout.nodePool = this.nodePool;
        }
    }

    resolveCenterId(passedId) {
        if (
            passedId
            && this.nodePool.has(passedId)
        ) {
            return passedId;
        }

        try {
            const stored =
                localStorage.getItem('povId');

            if (
                stored
                && this.nodePool.has(stored)
            ) {
                return stored;
            }
        } catch {
            // 使用第一个角色作为兜底。
        }

        return this.characters[0]?.id || null;
    }

    bindModeSwitch() {
        this.root.querySelector(
            '.worldnet-preview-open'
        )?.addEventListener(
            'click',
            () => this.enterFullscreen(),
            { signal: this.signal }
        );

        this.root.querySelector(
            '.worldnet-fullscreen-close'
        )?.addEventListener(
            'click',
            () => this.exitFullscreen(),
            { signal: this.signal }
        );
    }

    enterFullscreen() {
        if (this.destroyed || this.isFullscreen) {
            return;
        }

        this.isFullscreen = true;

        this.root.classList.remove(
            'worldnet-preview-mode'
        );

        this.root.classList.add(
            'worldnet-fullscreen-mode'
        );

        requestAnimationFrame(() => {
            if (this.destroyed) return;

            if (!this.started) {
                this.startGraph();
                return;
            }

            this.renderer?.resize();
            this.startLoop();
        });
    }

    exitFullscreen() {
        if (this.destroyed || !this.isFullscreen) {
            return;
        }

        this.isFullscreen = false;

        this.root.classList.add(
            'worldnet-preview-mode'
        );

        this.root.classList.remove(
            'worldnet-fullscreen-mode'
        );

        this.detailPanel?.classList.remove('open');
        this.picker?.classList.add('hidden');
        this.tooltip?.classList.remove('show');

        this.stopLoop();
    }

    startGraph() {
        if (
            this.destroyed
            || this.started
            || !this.canvas
        ) {
            return;
        }

        this.started = true;

        this.renderer =
            new GraphRenderer(this.canvas);

        this.layout.setCenter(
            this.renderer.width / 2,
            this.renderer.height / 2
        );

        this.interaction =
            new InteractionController(
                this.canvas,
                this.root,
                {
                    hitTest: (x, y) => this.hitTest(x, y),

                    onNodeDrag: (id, x, y) => {
                        const node =
                            this.nodePool.get(id);

                        if (!node) return;

                        const rect =
                            this.canvas.getBoundingClientRect();

                        const worldX =
                            (
                                x
                                - rect.left
                                - this.state.view.x
                            ) / this.state.view.zoom;

                        const worldY =
                            (
                                y
                                - rect.top
                                - this.state.view.y
                            ) / this.state.view.zoom;

                        node.x = worldX;
                        node.y = worldY;
                        node.fx = worldX;
                        node.fy = worldY;
                    },

                    onNodeUp: id => {
                        // Demo 行为：拖动后节点继续固定。
                        this.layout.reheat(0.15);
                    },

                    onNodeClick: id => {
                        if (
                            performance.now()
                            - this.longPressAt
                            < 500
                        ) {
                            return;
                        }

                        this.onNodeClick(id);
                    },

                    onNodeLongPress: id => {
                        this.longPressAt =
                            performance.now();

                        this.onNodeLongPress(id);
                    },

                    onBackgroundClick: () => {
                        if (
                            performance.now()
                            - this.longPressAt
                            < 500
                        ) {
                            return;
                        }

                        this.state.selectedId = null;
                    },

                    onPan: (dx, dy) => {
                        this.state.view.x += dx;
                        this.state.view.y += dy;
                    },

                    onZoom: (factor, x, y) => {
                        const rect =
                            this.canvas.getBoundingClientRect();

                        const px = x - rect.left;
                        const py = y - rect.top;

                        const nextZoom = clamp(
                            this.state.view.zoom * factor,
                            0.4,
                            2.5
                        );

                        this.state.view.x =
                            px
                            - (px - this.state.view.x)
                            * nextZoom
                            / this.state.view.zoom;

                        this.state.view.y =
                            py
                            - (py - this.state.view.y)
                            * nextZoom
                            / this.state.view.zoom;

                        this.state.view.zoom = nextZoom;
                    },

                    onHover: (id, x, y) => {
                        this.state.hoveredId = id;

                        if (!id || !this.tooltip) {
                            this.tooltip?.classList.remove('show');
                            return;
                        }

                        const node =
                            this.nodePool.get(id);

                        if (!node) return;

                        this.tooltip.textContent =
                            node.name
                            + (
                                node.role
                                    ? ` · ${node.role}`
                                    : ''
                            );

                        this.tooltip.style.left =
                            `${x}px`;

                        this.tooltip.style.top =
                            `${y}px`;

                        this.tooltip.classList.add('show');
                    }
                },
                this.signal
            );

        this.bindGraphUI();
        this.activateCenter(
            this.state.centerId,
            false
        );

        this.updateHeader();
        this.hint?.classList.remove('hidden');

        this.hintTimer = setTimeout(() => {
            if (!this.destroyed) {
                this.hint?.classList.add('hidden');
            }
        }, 5000);

        this.startLoop();
    }

    bindGraphUI() {
        const signal = this.signal;

        this.canvas.addEventListener(
            'dblclick',
            event => {
                if (this.destroyed) return;

                const id = this.hitTest(
                    event.clientX,
                    event.clientY
                );

                if (id) {
                    this.openDetail(id);
                }
            },
            { signal }
        );

        this.root.querySelector(
            '#detailClose'
        )?.addEventListener(
            'click',
            () => this.detailPanel?.classList.remove('open'),
            { signal }
        );

        this.root.querySelector(
            '#resetBtn'
        )?.addEventListener(
            'click',
            () => this.resetView(),
            { signal }
        );

        this.root.querySelector(
            '#searchBtn'
        )?.addEventListener(
            'click',
            () => this.showPicker(),
            { signal }
        );

        this.root.querySelector(
            '#detailSetCenter'
        )?.addEventListener(
            'click',
            () => {
                const id = this.state.detailId;

                if (id) {
                    this.activateCenter(id, true);
                    this.detailPanel?.classList.remove('open');
                }
            },
            { signal }
        );

        this.root.querySelector(
            '#legendToggle'
        )?.addEventListener(
            'click',
            () => {
                const legend =
                    this.root.querySelector('#legend');

                if (!legend) return;

                legend.classList.toggle('hidden');

                const button =
                    this.root.querySelector('#legendToggle');

                if (button) {
                    button.textContent =
                        legend.classList.contains('hidden')
                            ? '▴'
                            : '▾';
                }
            },
            { signal }
        );

        this.root.querySelector(
            '#searchInput'
        )?.addEventListener(
            'input',
            event => {
                this.renderPickerList(
                    event.target.value.trim().toLowerCase()
                );
            },
            { signal }
        );

        window.addEventListener(
            'resize',
            () => {
                if (this.destroyed) return;
                this.renderer?.resize();
                this.layout?.setCenter(
                    this.renderer?.width / 2 || 0,
                    this.renderer?.height / 2 || 0
                );
            },
            { signal }
        );
    }

    startLoop() {
        if (
            this.destroyed
            || !this.isFullscreen
            || this.rafId !== null
        ) {
            return;
        }

        this.lastTick = performance.now();
        this.rafId = requestAnimationFrame(this.loop);
    }

    stopLoop() {
        if (this.rafId === null) return;

        cancelAnimationFrame(this.rafId);
        this.rafId = null;
    }

    loop(timestamp) {
        this.rafId = null;

        if (
            this.destroyed
            || !this.isFullscreen
        ) {
            return;
        }

        const delta =
            Math.min(
                0.1,
                (timestamp - this.lastTick) / 1000
            );

        this.lastTick = timestamp;

        const center =
            this.nodePool.get(this.state.centerId);

        if (
            center
            && center._arriving
            && !center._arrived
        ) {
            const targetX = this.renderer.width / 2;
            const targetY = this.renderer.height / 2;

            const dx = targetX - center.x;
            const dy = targetY - center.y;

            if (
                Math.abs(dx) < 0.6
                && Math.abs(dy) < 0.6
            ) {
                center.x = targetX;
                center.y = targetY;
                center.fx = targetX;
                center.fy = targetY;
                center._arrived = true;
                center._arriving = false;
            } else {
                const step =
                    1 - Math.pow(0.001, delta * 6);

                center.x += dx * step;
                center.y += dy * step;
                center.fx = center.x;
                center.fy = center.y;
            }
        }

        if (!this.layout.isStable()) {
            this.layout.tick();
        }

        this.render();
        this.startLoop();
    }

    render() {
        if (
            this.destroyed
            || !this.renderer
            || !this._visCache
        ) {
            return;
        }

        this.renderer.render({
            view: this.state.view,
            centerId: this.state.centerId,
            selectedId: this.state.selectedId,
            hoveredId: this.state.hoveredId,
            visibleNodes: this._visCache.nodes,
            visibleEdges: this._visCache.edges
        });
    }

    hitTest(clientX, clientY) {
        if (
            !this._visCache
            || !this.canvas
            || clientX == null
            || clientY == null
        ) {
            return null;
        }

        const rect = this.canvas.getBoundingClientRect();

        const worldX = (
            clientX
            - rect.left
            - this.state.view.x
        ) / this.state.view.zoom;

        const worldY = (
            clientY
            - rect.top
            - this.state.view.y
        ) / this.state.view.zoom;

        let nearestId = null;
        let minimumDistance = Infinity;

        for (const graphNode of this._visCache.nodes) {
            if (
                !graphNode
                || !Number.isFinite(graphNode.x)
                || !Number.isFinite(graphNode.y)
            ) {
                continue;
            }

            const dx = graphNode.x - worldX;
            const dy = graphNode.y - worldY;
            const distance = Math.sqrt(
                dx * dx + dy * dy
            );

            const hitRadius =
                graphNode.isIsolatedContact
                    ? 35
                    : graphNode.id === this.state.centerId
                        ? 58
                        : 48;

            if (
                distance < hitRadius
                && distance < minimumDistance
            ) {
                nearestId = graphNode.id;
                minimumDistance = distance;
            }
        }

        return nearestId;
    }

    computeVisible(centerId) {
        const ids = new Set([centerId]);
        const center = this.nodePool.get(centerId);

        // 清理上一中心留下的视图状态。
        for (const node of this.nodePool.values()) {
            node.isCenter = false;
            node.isContact = false;
            node.isIsolatedContact = false;
        }
        // 中心角色的联系人，即使没有关系记录也加入视图。
        const contactIds = new Set(
            center?.contactIds || []
        );

        for (const contactId of contactIds) {
            if (this.nodePool.has(contactId)) {
                ids.add(contactId);
            }
        }

        for (const edge of this.relationships) {
            if (edge.source === centerId) {
                ids.add(edge.target);
            }

            if (edge.target === centerId) {
                ids.add(edge.source);
            }
        }

        const edges = this.relationships.filter(edge =>
            ids.has(edge.source)
            && ids.has(edge.target)
            && (
                edge.source === centerId
                || edge.target === centerId
            )
        );

        const connectedIds = new Set();

        for (const edge of edges) {
            connectedIds.add(edge.source);
            connectedIds.add(edge.target);
        }

        // 给当前视图中的节点标记状态。
        // 无关系联系人单独作为外围节点处理。
        for (const id of ids) {
            const node = this.nodePool.get(id);

            if (!node) continue;

            node.isCenter = id === centerId;
            node.isContact = contactIds.has(id);
            node.isIsolatedContact =
                id !== centerId
                && contactIds.has(id)
                && !connectedIds.has(id);
        }

        return {
            ids: [...ids],
            edges
        };
    }

    activateCenter(id, animate = false) {
        if (
            this.destroyed
            || !id
            || !this.nodePool.has(id)
        ) {
            return;
        }

        const oldId = this.state.centerId;

        if (
            oldId === id
            && this._visCache
        ) {
            return;
        }

        this.state.centerId = id;
        this.state.selectedId = null;
        this.state.hoveredId = null;

        const width =
            this.renderer?.width
            || this.canvas?.clientWidth
            || 320;

        const height =
            this.renderer?.height
            || this.canvas?.clientHeight
            || 390;

        const centerX = width / 2;
        const centerY = height / 2;

        const oldCenter =
            oldId
                ? this.nodePool.get(oldId)
                : null;

        if (oldCenter && oldId !== id) {
            oldCenter.fx = null;
            oldCenter.fy = null;

            const dx = oldCenter.x - centerX;
            const dy = oldCenter.y - centerY;
            const distance =
                Math.sqrt(dx * dx + dy * dy)
                || 1;

            oldCenter.vx =
                dx / distance * 4;

            oldCenter.vy =
                dy / distance * 4;
        }

        const newCenter =
            this.nodePool.get(id);

        if (!Number.isFinite(newCenter.x)) {
            newCenter.x = centerX;
            newCenter.y = centerY;
        }

        if (
            animate
            && oldId
            && oldId !== id
            && (
                Math.abs(newCenter.x - centerX) > 5
                || Math.abs(newCenter.y - centerY) > 5
            )
        ) {
            newCenter._arriving = true;
            newCenter._arrived = false;
            newCenter.fx = null;
            newCenter.fy = null;
        } else {
            newCenter._arriving = false;
            newCenter._arrived = true;
            newCenter.x = centerX;
            newCenter.y = centerY;
            newCenter.fx = centerX;
            newCenter.fy = centerY;
        }

        this.layout.setCenter(centerX, centerY);

        const visible =
            this.computeVisible(id);

        // 根据外围联系人数量调整环带半径。
        // 同时受画布尺寸限制，避免小屏幕上的节点跑到画布外。
        const isolatedCount = visible.ids.filter(
            visibleId =>
                this.nodePool.get(visibleId)?.isIsolatedContact
        ).length;

        const availableRadius = Math.max(
            120,
            Math.min(centerX, centerY) - 28
        );

        const desiredRadius =
            145 + Math.max(0, isolatedCount - 4) * 8;

        this.layout.isolatedRadius = Math.min(
            220,
            availableRadius,
            desiredRadius
        );

        this.layout.setActive(
            visible.ids,
            visible.edges
        );

        this.layout.reheat(
            animate ? 0.6 : 0
        );

        this.rebuildVisibleCache(
            visible.ids,
            visible.edges
        );

        this.updateHeader();
        this.startLoop();
    }

    rebuildVisibleCache(ids, edges) {
        const nodes = [];

        for (const id of ids) {
            const node = this.nodePool.get(id);

            if (node) {
                nodes.push(node);
            }
        }

        this._visCache = {
            nodes,
            edges
        };
    }

    onNodeClick(id) {
        this.state.selectedId =
            this.state.selectedId === id
                ? null
                : id;
    }

    onNodeLongPress(id) {
        if (id !== this.state.centerId) {
            this.activateCenter(id, true);
        }
    }

    resetView() {
        this.state.view.x = 0;
        this.state.view.y = 0;
        this.state.view.zoom = 1;
        this.state.selectedId = null;
        this.layout.reheat(0.3);
    }

    updatePreviewCenterName() {
        const character =
            this.characters.find(
                item => item.id === this.povId
            );

        const element =
            this.root.querySelector(
                '.worldnet-center-name'
            );

        if (element) {
            element.textContent =
                character?.name || '--';
        }
    }

    updateHeader() {
        const center =
            this.nodePool.get(this.state.centerId);

        const pov =
            this.nodePool.get(this.povId);

        if (this.povTag) {
            this.povTag.textContent =
                `POV ${pov?.name || '--'}`;
        }

        if (this.centerText) {
            this.centerText.textContent =
                this.state.centerId === this.povId
                    ? `${center?.name || '--'} 的关系`
                    : `${center?.name || '--'} (非 POV)`;
        }

        this.updatePreviewCenterName();
    }

    showPicker() {
        if (!this.picker) return;

        this.picker.classList.remove('hidden');
        this.renderPickerList('');

        requestAnimationFrame(() => {
            if (!this.destroyed) {
                this.root.querySelector(
                    '#searchInput'
                )?.focus();
            }
        });
    }

    hidePicker() {
        this.picker?.classList.add('hidden');
    }

    renderPickerList(query) {
        const list =
            this.root.querySelector('#pickerList');

        if (!list) return;

        const q = String(query || '').toLowerCase();

        const counts = new Map();

        for (const relation of this.relationships) {
            counts.set(
                relation.source,
                (counts.get(relation.source) || 0) + 1
            );
        }

        const characters = [...this.characters]
            .filter(character => {
                if (!q) return true;

                const searchable = [
                    character.name,
                    character.faction,
                    character.role,
                    ...character.tags
                ]
                    .filter(Boolean)
                    .join(' ')
                    .toLowerCase();

                return searchable.includes(q);
            })
            .sort((a, b) => {
                return (
                    (counts.get(b.id) || 0)
                    - (counts.get(a.id) || 0)
                );
            });

        list.innerHTML = characters.map(character => {
            const isCurrent =
                character.id === this.state.centerId;

            const count =
                counts.get(character.id) || 0;

            return `
                <button
                    type="button"
                    class="picker-item"
                    data-picker-id="${esc(character.id)}"
                >
                    <span
                        class="picker-avatar"
                        style="--node-color:${esc(character.color)}"
                    >${esc(character.avatar)}</span>

                    <span class="picker-info">
                        <strong>
                            ${esc(character.name)}
                            ${isCurrent ? ' · 当前' : ''}
                        </strong>

                        <small>
                            ${esc(
                [
                    character.faction,
                    character.role
                ]
                    .filter(Boolean)
                    .join(' · ')
            )}
                        </small>
                    </span>

                    <span class="picker-count">
                        ${count ? `${count} 段` : '无关系'}
                    </span>
                </button>
            `;
        }).join('');

        list.querySelectorAll('[data-picker-id]')
            .forEach(button => {
                button.addEventListener(
                    'click',
                    () => {
                        this.activateCenter(
                            button.dataset.pickerId,
                            true
                        );
                        this.hidePicker();
                    },
                    { signal: this.signal }
                );
            });
    }

    openDetail(id) {
        const character =
            this.nodePool.get(id);

        if (!character || !this.detailPanel) {
            return;
        }

        this.state.detailId = id;

        const avatar =
            this.root.querySelector('#detailAvatar');

        const name =
            this.root.querySelector('#detailName');

        const role =
            this.root.querySelector('#detailRole');

        const bio =
            this.root.querySelector('#detailBio');

        const tags =
            this.root.querySelector('#detailTags');

        const relationList =
            this.root.querySelector('#detailRels');

        if (avatar) {
            avatar.innerHTML = getAvatarHtml(
                character.id,
                character.avatar || '👤'
            );

            avatar.style.setProperty(
                '--avatar-from',
                character.color || '#4ECDC4'
            );
        }

        if (name) {
            name.textContent =
                character.name || '未知角色';
        }

        if (role) {
            role.textContent =
                [
                    character.faction,
                    character.role
                ]
                    .filter(Boolean)
                    .join(' · ');
        }

        if (bio) {
            bio.textContent =
                character.bio
                || character.detail
                || '暂无简介';
        }

        if (tags) {
            tags.innerHTML =
                character.tags.length
                    ? character.tags.map(tag => `
                        <span class="detail-tag">
                            ${esc(tag)}
                        </span>
                    `).join('')
                    : '<span class="detail-tag">暂无标签</span>';
        }

        const outgoing =
            this.relationships.filter(
                edge => edge.source === id
            );

        if (relationList) {
            relationList.innerHTML =
                outgoing.length
                    ? outgoing.map(edge => {
                        const other =
                            this.nodePool.get(edge.target);

                        if (!other) return '';

                        const style =
                            REL_STYLES[edge.type]
                            || REL_STYLES.other;

                        return `
                            <div
                                class="rel-item"
                                style="--rel-color:${esc(style.color)}"
                            >
                                <span class="rel-arrow">→</span>
<span class="rel-name">
    <span class="rel-avatar">
        ${getAvatarHtml(
                            other.id,
                            other.avatar || '👤'
                        )}
    </span>
    <span class="rel-name-text">
        ${esc(other.name)}
    </span>
</span>
                                <span class="rel-type">
                                    ${esc(style.label)}
                                    ${edge.label
                                && edge.label
                                !== style.label
                                ? ` · ${esc(edge.label)}`
                                : ''
                            }
                                </span>
                            </div>
                        `;
                    }).join('')
                    : `
                        <div class="rel-empty">
                            此角色尚未认知任何人
                        </div>
                    `;
        }

        const centerButton =
            this.root.querySelector(
                '#detailSetCenter'
            );

        if (centerButton) {
            const current =
                id === this.state.centerId;

            centerButton.disabled = current;
            centerButton.textContent =
                current
                    ? '✓ 当前中心'
                    : '以 TA 为中心查看';
        }

        this.detailPanel.classList.add('open');
    }

    destroy() {
        if (this.destroyed) return;

        this.destroyed = true;

        this.stopLoop();
        this.interaction?.destroy();

        if (this.hintTimer) {
            clearTimeout(this.hintTimer);
            this.hintTimer = null;
        }

        this.eventController.abort();

        this.detailPanel?.classList.remove('open');
        this.picker?.classList.add('hidden');
        this.tooltip?.classList.remove('show');

        this.nodePool.clear();
        this.characters = [];
        this.relationships = [];
        this._visCache = null;
    }
}

function renderHTML() {
    return `
        <section
            class="${GRAPH_ROOT_CLASS} worldnet-preview-mode"
        >
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
                            中心：
                            <b class="worldnet-center-name">--</b>
                        </small>
                    </span>
                </span>

                <span
                    class="worldnet-preview-arrow"
                    aria-hidden="true"
                >›</span>
            </button>

            <div class="app-header">
                <div class="app-title">
                    <div class="main">关系网</div>

                    <div class="sub">
                        <span
                            class="pov-tag"
                            id="povTag"
                        >POV --</span>

                        <span id="centerText">--</span>
                    </div>
                </div>

                <div class="header-btns">
                    <button
                        type="button"
                        class="header-btn"
                        id="resetBtn"
                        title="视图重置"
                    >⊙</button>

                    <button
                        type="button"
                        class="header-btn"
                        id="searchBtn"
                        title="切换中心"
                    >⌕</button>

                    <button
                        type="button"
                        class="header-btn worldnet-fullscreen-close"
                        title="关闭关系网"
                        aria-label="关闭关系网"
                    >×</button>
                </div>
            </div>

            <div
                class="graph-wrap"
                id="graphWrap"
            >
                <canvas id="graph"></canvas>

                <div
                    class="tooltip"
                    id="tooltip"
                ></div>

                <div
                    class="longpress-ring"
                    id="longpressRing"
                ></div>

                <div
                    class="hint"
                    id="hint"
                >
                    <span class="kbd">单击</span>
                    选中 ·
                    <span class="kbd">双击</span>
                    详情 ·
                    <span class="kbd">长按</span>
                    切换中心
                </div>
            </div>

            <div
                class="legend"
                id="legend"
            >
                <button
                    type="button"
                    class="legend-toggle"
                    id="legendToggle"
                    title="展开或收起图例"
                >▾</button>

                <div
                    class="legend-item"
                    style="color:#FF6B9D"
                >
                    <div
                        class="legend-line"
                        style="background:#FF6B9D"
                    ></div>
                    恋人
                </div>

                <div
                    class="legend-item"
                    style="color:#FF6B9D"
                >
                    <div
                        class="legend-line dashed"
                        style="color:#FF6B9D"
                    ></div>
                    暗恋 / 好感
                </div>

                <div
                    class="legend-item"
                    style="color:#4ECDC4"
                >
                    <div
                        class="legend-line"
                        style="background:#4ECDC4"
                    ></div>
                    亲属
                </div>

                <div
                    class="legend-item"
                    style="color:#95E1D3"
                >
                    <div
                        class="legend-line"
                        style="background:#95E1D3"
                    ></div>
                    朋友
                </div>

                <div
                    class="legend-item"
                    style="color:#AA96DA"
                >
                    <div
                        class="legend-line"
                        style="background:#AA96DA"
                    ></div>
                    师徒
                </div>

                <div
                    class="legend-item"
                    style="color:#F38181"
                >
                    <div
                        class="legend-line"
                        style="background:#F38181"
                    ></div>
                    对手
                </div>

                <div
                    class="legend-item"
                    style="color:#AA0000"
                >
                    <div
                        class="legend-line dashed"
                        style="color:#AA0000"
                    ></div>
                    敌对
                </div>

                <div
                    class="legend-item"
                    style="color:#9AA4B2"
                >
                    <div
                        class="legend-line dashed"
                        style="color:#9AA4B2"
                    ></div>
                    其他
                </div>
            </div>

            <div
                class="picker hidden"
                id="picker"
            >
                <div class="picker-header">
                    <h2>切换中心角色</h2>
                    <p>
                        选定后，关系网以 TA 为中心展示
                        · 不影响你的主视角
                    </p>
                </div>

                <div class="picker-search">
                    <input
                        type="search"
                        id="searchInput"
                        placeholder="搜索角色名、阵营、标签..."
                        autocomplete="off"
                    >
                </div>

                <div
                    class="picker-list"
                    id="pickerList"
                ></div>
            </div>

            <div
                class="detail-panel"
                id="detailPanel"
            >
                <button
                    type="button"
                    class="detail-close"
                    id="detailClose"
                    aria-label="关闭详情"
                >×</button>

                <div class="detail-header">
                    <div
                        class="detail-avatar"
                        id="detailAvatar"
                    >👤</div>

                    <div>
                        <div
                            class="detail-name"
                            id="detailName"
                        >--</div>

                        <div
                            class="detail-role"
                            id="detailRole"
                        >--</div>
                    </div>
                </div>

                <div class="detail-section section-bio">
                    <h3>简介</h3>
                    <div
                        class="detail-bio"
                        id="detailBio"
                    >--</div>
                </div>

                <div class="detail-section section-tags">
                    <h3>标签</h3>
                    <div
                        class="detail-tags"
                        id="detailTags"
                    ></div>
                </div>

                <div class="detail-section section-rels">
                    <h3>TA 对他人的认知</h3>
                    <div
                        class="rel-list"
                        id="detailRels"
                    ></div>
                </div>

                <div class="detail-action">
                    <button
                        type="button"
                        class="detail-action-btn"
                        id="detailSetCenter"
                    >
                        以 TA 为中心查看
                    </button>
                </div>
            </div>
        </section>
    `;
}

export function renderWorldNetGraph() {
    return renderHTML();
}

export function mountWorldNetGraph(
    container,
    options = {}
) {
    const root = container.querySelector(
        `.${GRAPH_ROOT_CLASS}`
    );

    if (!root) return null;

    const previous =
        mountedGraphs.get(container);

    if (previous) {
        previous.destroy();
    }

    const graph =
        new RelationshipApp(root, options);

    mountedGraphs.set(container, graph);

    return graph;
}

export function unmountWorldNetGraph(container) {
    const graph =
        mountedGraphs.get(container);

    if (!graph) return;

    graph.destroy();
    mountedGraphs.delete(container);
}

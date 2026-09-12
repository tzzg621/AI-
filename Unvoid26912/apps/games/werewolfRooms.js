// apps/games/werewolfRooms.js — 狼人杀：板子、房间、角色与文案常量
// 纯常量 + 纯函数，无 DOM / 无存储 / 无 AI，供 werewolf.js 与 E2E 直接引用。

/* ---------------- 角色 ---------------- */

/* desc 是角色卡上的一句话；night 是规则页「一夜之间」那一段的一行（按板上实际有谁生成）。 */
export const ROLE_META = {
    werewolf: {
        id: 'werewolf', label: '狼人', icon: '🐺', faction: 'wolf',
        desc: '夜晚与同伴共同刀人，白天伪装成好人。',
        night: '狼人：和同伴各自提一个要刀的人；说的不一样就随机取一个'
    },
    seer: {
        id: 'seer', label: '预言家', icon: '🔮', faction: 'good',
        desc: '每晚查验一人，得知对方是好人还是狼人。',
        night: '预言家：查验一人，得知其是好人还是狼人'
    },
    guard: {
        id: 'guard', label: '守卫', icon: '🛡️', faction: 'good',
        desc: '每晚守护一人，被守护的人当夜不会被刀；不能连续两夜守同一人。',
        night: '守卫：每晚守护一人，他当夜不会被刀；不能连续两夜守同一个人，可以守自己'
    },
    hunter: {
        id: 'hunter', label: '猎人', icon: '🔫', faction: 'good',
        desc: '出局时可以开枪带走场上一人（被刀或被票都能开枪）。',
        night: '猎人：夜里没有行动，但出局时能开枪带走一人'
    },
    villager: {
        id: 'villager', label: '村民', icon: '🌾', faction: 'good',
        desc: '没有夜间能力，靠推理与投票找出狼人。',
        night: '村民：夜里没有行动，靠白天的发言与投票找狼'
    }
};

export function roleLabel(roleId) {
    return ROLE_META[roleId]?.label || roleId || '未知';
}

export function factionOf(roleId) {
    return ROLE_META[roleId]?.faction || 'good';
}

/* ---------------- 板子 ---------------- */

export const BOARDS = {
    board6_standard: {
        id: 'board6_standard',
        label: '6 人标准板',
        seats: 6,
        // 座位网格：6 人局只出左列 6 席（右列为以后 12 人房预留）
        columns: 1,
        roles: { werewolf: 2, seer: 1, guard: 1, villager: 2 }
    }
};

export function getBoard(boardId) {
    return BOARDS[boardId] || BOARDS.board6_standard;
}

/** 板上有谁：`狼人×2 · 预言家×1 …`（规则页用）。换板子只改 BOARDS.roles，别处不用动。 */
export function boardCounts(boardId) {
    return Object.entries(getBoard(boardId).roles)
        .map(([id, n]) => `${roleLabel(id)}×${n}`)
        .join(' · ');
}

/** 板上有谁的白话版：`2 名狼人、1 名预言家 …`（AI 提示词的规则头用）。 */
export function boardProse(boardId) {
    return Object.entries(getBoard(boardId).roles)
        .map(([id, n]) => `${n} 名${roleLabel(id)}`)
        .join('、');
}

/* ---------------- 房间分类（规则 + 人数；一类下可以同时开多张桌） ---------------- */

export const ROOM_TYPES = [
    {
        typeId: 'rookie',
        name: '新手局',
        icon: '🌱',
        boardId: 'board6_standard',
        desc: '节奏舒缓，发言可以慢慢说，适合先熟悉规则',
        speechLimit: 120,
        pace: 1200,
        tone: '第一次上桌，语气放松些，别太咄咄逼人',
        // 明牌局：出局即公开身份（见 revealModeOf）
        reveal: 'open'
    },
    {
        typeId: 'blitz',
        name: '速战局',
        icon: '⚡',
        boardId: 'board6_standard',
        desc: '短发言快节奏，回合推进干脆',
        speechLimit: 60,
        pace: 400,
        tone: '说话简短直接，一针见血，不绕弯子',
        reveal: 'hidden'
    },
    {
        typeId: 'story',
        name: '扮演局',
        icon: '🎭',
        boardId: 'board6_standard',
        desc: '可以长篇发言，鼓励演好自己这个角色',
        speechLimit: 200,
        pace: 900,
        tone: '放开了演，按你自己的身份与性格说话，可以带情绪与故事',
        reveal: 'hidden'
    }
];

export function getRoomType(typeId) {
    return ROOM_TYPES.find(t => t.typeId === typeId) || null;
}

/**
 * 这一局的出局信息公开方式：'open' = 明牌（出局即报身份）｜'hidden' = 暗牌。
 * 按房型固定（新手局明牌，速战/扮演暗牌）；session 上存了就以它为准——
 * 对局记录因此自带当时的规则，老 session 没这个字段时按房型回退。
 */
export function revealModeOf(session) {
    return session?.revealMode || getRoomType(session?.typeId)?.reveal || 'hidden';
}

export function revealLabel(mode) {
    return mode === 'open' ? '明牌' : '暗牌';
}

/* ---------------- 主视角预设标签 ---------------- */

export const MARK_TAGS = ['好人', '狼人', '预言家', '守卫', '村民', '存疑'];

/* ---------------- 规则页文案 ---------------- */

export function buildRulesPage(type) {
    const board = getBoard(type?.boardId);
    const counts = boardCounts(type?.boardId);
    // 「一夜之间」按板上实际有谁生成：换板子只改 BOARDS.roles + ROLE_META.night，这里不用动。
    const nightLines = Object.keys(board.roles)
        .map(id => ROLE_META[id]?.night)
        .filter(Boolean);

    return [
        {
            title: '这一桌怎么打',
            lines: [
                `${board.label}：${counts}`,
                `座位 ${board.seats} 席，你的角色由发牌随机决定`,
                '狼人全灭 → 好人赢；狼人数量追平好人 → 狼人赢'
            ]
        },
        {
            title: '一夜之间',
            lines: [
                ...nightLines,
                '天亮公布死讯；若当夜无人出局则为平安夜'
            ]
        },
        {
            title: '一个白天',
            lines: [
                '依次发言：每个人说一段自己的判断',
                '全员投票：投完统一开票，票数最高者出局（平票则本轮无人出局）',
                board.roles.hunter ? '猎人出局可以开枪；之后进入下一夜' : '之后进入下一夜'
            ]
        },
        {
            title: '桌上的规矩',
            lines: [
                revealModeOf({ typeId: type?.typeId }) === 'open'
                    ? '明牌局：有人出局会当场公开他的身份，技能由谁发动也一并写明'
                    : '暗牌局：出局不公开身份；技能没发动就什么都不写，发动了也只写谁发动技能、谁出局',
                '投票是投完统一开票：投票过程中谁也看不到别人的票，开票时一起亮出来',
                '身份只有自己知道：每个角色只掌握自己的身份与夜里看到的信息',
                board.roles.guard
                    ? '守卫守中当晚的刀口就是平安夜；平安夜也可能只是狼没下刀，两者看起来一样'
                    : '',
                '你可以给场上的人贴标签做记录，那是你自己的判断，别人看不到',
                '轮到你的身份行动时由你自己点（狼人还能先跟队友说一句）；每一步也都能交给 AI——夜里点「让 AI 决定」，发言点「代笔」',
                type ? `这类房间：${type.desc}` : '',
                type ? `单次发言上限约 ${type.speechLimit} 字` : ''
            ].filter(Boolean)
        }
    ];
}

/* ---------------- 临时路人（不进名册，沉淀进路人池） ---------------- */

const SURNAMES = ['林', '周', '沈', '陆', '顾', '苏', '程', '江', '许', '白', '温', '秦', '孟', '钟', '卫', '冯'];
const GIVEN = ['一鸣', '知远', '小满', '嘉树', '青禾', '望舒', '听澜', '亦然', '书言', '未迟', '云舟', '安然', '之遥', '南枝'];

const PERSONAS = [
    '话不多，习惯把别人说的先听完再开口',
    '性子急，想到什么就说什么',
    '喜欢开玩笑，紧张的时候话会变多',
    '第一次玩，规则还在边玩边学',
    '看人很准，但不太会说服别人',
    '爱较真，谁说错一句话都要追问到底',
    '安静，被点到才说话',
    '自来熟，一坐下就想跟所有人搭话'
];

export function randomNpcIdentity() {
    const name = SURNAMES[Math.floor(Math.random() * SURNAMES.length)]
        + GIVEN[Math.floor(Math.random() * GIVEN.length)];
    const persona = PERSONAS[Math.floor(Math.random() * PERSONAS.length)];
    return { name, persona };
}

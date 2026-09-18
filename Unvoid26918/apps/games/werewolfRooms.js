// apps/games/werewolfRooms.js — 狼人杀：板子、房间、角色与文案常量
// 纯常量 + 纯函数，无 DOM / 无存储 / 无 AI，供 werewolf.js 与 E2E 直接引用。

/* ---------------- 角色 ---------------- */

/*
 * desc 是角色卡上的一句话；night 是规则页「一夜之间」那一段的一行（按板上实际有谁生成）。
 *
 * side 是「屠边」用的那一类：god 神职 / folk 平民（狼看 faction，不写 side）。
 * 它与 faction 是两个轴：faction 管胜负归属（好人 / 狼人），side 只管屠边数哪一边。
 * **不写 side 的角色在屠边里不算任何一边**（sideOf 返回 null）——宁可少数，不可默认成某一类。
 */
export const ROLE_META = {
    werewolf: {
        id: 'werewolf', label: '狼人', icon: '🐺', faction: 'wolf',
        desc: '夜晚与同伴共同刀人，白天伪装成好人。',
        night: '狼人：和同伴各自提一个要刀的人；说的不一样就随机取一个'
    },
    seer: {
        id: 'seer', label: '预言家', icon: '🔮', faction: 'good', side: 'god',
        desc: '每晚查验一人，得知对方是好人还是狼人。',
        night: '预言家：查验一人，得知其是好人还是狼人'
    },
    witch: {
        id: 'witch', label: '女巫', icon: '🧪', faction: 'good', side: 'god',
        desc: '解药与毒药各一瓶，各只能用一次；解药还在时每夜会知道谁被刀，同一夜只能开一瓶，不能毒自己。',
        night: '女巫：一瓶解药一瓶毒药，各只能用一次；解药还在时每夜会被告知谁被刀（解药一用掉就不再告知），同一夜只能开一瓶，首夜能救自己、之后不能自救，不能毒自己'
    },
    guard: {
        id: 'guard', label: '守卫', icon: '🛡️', faction: 'good', side: 'god',
        desc: '每晚守护一人，被守护的人当夜不会被刀；不能连续两夜守同一人。',
        night: '守卫：每晚守护一人，他当夜不会被刀；不能连续两夜守同一个人，可以守自己'
    },
    hunter: {
        id: 'hunter', label: '猎人', icon: '🔫', faction: 'good', side: 'god',
        desc: '出局时可以开枪带走场上一人（被刀或被票都能开枪；被毒死不能开枪）。',
        night: '猎人：夜里被狼刀到时会被单独叫醒，知道自己被刀了并当场决定开不开枪（被毒死不能开枪）'
    },
    idiot: {
        id: 'idiot', label: '白痴', icon: '🃏', faction: 'good', side: 'god',
        desc: '被投票出局时翻牌免死，此后失去投票权、不再被放逐，但夜里仍会被狼杀死。',
        night: '白痴：夜里没有行动；白天被投票出局时翻牌免死，之后没有投票权、也不能再被投票放逐'
    },
    villager: {
        id: 'villager', label: '村民', icon: '🌾', faction: 'good', side: 'folk',
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

/** 屠边数哪一边：'god' | 'folk'；狼与认不出的角色都返回 null（不硬凑成某一类） */
export function sideOf(roleId) {
    return ROLE_META[roleId]?.side || null;
}

export const SIDE_LABEL = { god: '神职', folk: '平民' };

/* ---------------- 板子 ---------------- */

/*
 * 板子 = 阵容 + 这一桌的规矩。规矩字段全部**可省**，省了就是 6 人板如今的行为——
 * 老 session 与老板子因此一个字都不用改（读侧一律走下面那几个兜底函数）。
 *   winMode      'city' 屠城（狼数追平好人）｜'side' 屠边（神职或平民清空）
 *   lastWords    出局留遗言（第一夜死者 + 白天被投出者）
 *   pk           平票进 PK 再投一轮
 *   sheriff      有警长（警徽流、警上警下那一套）。**不写 = 规则上不设警长**——
 *                今天只有 board12_sheriff 写了它，另外两张都没有。
 *                ⚠️ **绝不要往老板子上补这一行**：老 session 的 `session.sheriff` 是既成事实的
 *                undefined，补上去会让所有**正在进行中**的局在第二天天亮突然插入一场竞选。
 *   tableColumns 局内座位网格列数（准备页用 columns）
 *   callBudget   一局内的 AI 调用上限（不写走 werewolfAI 的 CALL_BUDGET）
 *   nightOrder   夜里依次走哪几步（不写走引擎的默认序，那正好就是 6 人板今天的流程）
 */
export const BOARDS = {
    board6_standard: {
        id: 'board6_standard',
        label: '6 人标准板',
        seats: 6,
        // 座位网格：6 人局只出左列 6 席（右列为 12 人房用）
        columns: 1,
        tableColumns: 3,
        winMode: 'city',
        roles: { werewolf: 2, seer: 1, guard: 1, villager: 2 }
    },
    board12_standard: {
        id: 'board12_standard',
        label: '12 人标准板',
        seats: 12,
        columns: 2,          // 准备页：2 列 × 6 行（座位卡带名字与按钮，两列更好点）
        tableColumns: 4,     // 局内：4 列 × 3 行（紧凑卡，正好一屏）
        winMode: 'side',     // 屠边：神职全灭或平民全灭，狼人赢
        lastWords: true,
        pk: true,
        // 预算这件事先放一放（2026-09-13）：板子暂不下发 callBudget，整局不封顶。
        // 想收回来就在这儿加一行 `callBudget: 150`（12 人局夜里 4 步 + 白天 2×存活人数，一局约 110 次）。
        // 夜里：守卫（排在狼前面：先守后刀，他手里不可能有今晚的刀口）→ 狼刀 →
        // 女巫（要先看到刀口才决定救不救）→ 预言家 → 猎人（每夜都叫到他；
        // 被刀会死的那个才被告知并决定开不开枪）。
        // **白痴换守卫**（用户 2026-09-14：无警长的 12 人局里白痴太不平衡）——
        // 白痴那张牌与「翻牌免死」的引擎逻辑原样留着，只是没有板子发它（见 ROLE_META.idiot）。
        nightOrder: ['night_guard', 'night_wolf', 'night_witch', 'night_seer', 'night_hunter'],
        roles: { werewolf: 4, seer: 1, witch: 1, guard: 1, hunter: 1, villager: 4 }
    },
    board12_sheriff: {
        id: 'board12_sheriff',
        label: '12 人警长板',
        seats: 12,
        columns: 2,
        tableColumns: 4,
        winMode: 'side',     // 屠边，与标准 12 人板同源
        lastWords: true,
        pk: true,
        // **有警长**（用户 2026-09-15）。只有这一张板子写它，见上面 BOARDS 头注释的警告。
        sheriff: true,
        // 白痴换回来当第 4 神（守卫下场）：这张板子的 4 神 = 预/女/猎/白。
        // 白痴那张牌与「翻牌免死」的引擎逻辑一直都在（见 ROLE_META.idiot），只是 9-14 之后
        // 没有板子发它；警长板把它发回来——警长的 1.5 票与白痴的「翻牌后没有投票权」
        // 是同一套投票权规则的两个方向，所以「白痴翻过牌就不再算有票的人」照旧成立。
        nightOrder: ['night_wolf', 'night_witch', 'night_seer', 'night_hunter'],   // 无守卫
        roles: { werewolf: 4, seer: 1, witch: 1, hunter: 1, idiot: 1, villager: 4 }
    }
};

export function getBoard(boardId) {
    return BOARDS[boardId] || BOARDS.board6_standard;
}

/* 规矩字段的读侧兜底：默认值 = 6 人板现状，所以没写的板子行为不变。 */
export function winModeOf(board) { return board?.winMode || 'city'; }
export function wordsEnabled(board) { return board?.lastWords === true; }
export function pkEnabled(board) { return board?.pk === true; }
export function tableColumnsOf(board) { return board?.tableColumns || 3; }

/**
 * 这一桌有没有警长。**只有显式写 `sheriff: true` 才算**，今天只有 board12_sheriff 是 true。
 * 写成板子属性而不是全局事实：规则页要按它出文案，AI 提示词要按它压住模型的先验——
 * 「12 人局」这四个字本身会让模型自动聊起警徽流（用户 2026-09-13 实测就是这么冒出来的）。
 */
export function sheriffOf(board) { return board?.sheriff === true; }

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
    },
    {
        typeId: 'standard12',
        name: '12 人标准局',
        icon: '🌕',
        boardId: 'board12_standard',
        desc: '标准预女猎守：4 狼对 4 神 4 民，屠边胜负，出局有遗言，平票进 PK',
        speechLimit: 160,
        pace: 900,
        tone: '这是正经的一局：人多、信息杂，盘逻辑、算票型、盯发言，别急着下结论',
        // 暗牌：12 人局里明牌屠边会让狼直接按身份刀神，屠神几乎送分
        reveal: 'hidden'
    },
    {
        typeId: 'sheriff12',
        name: '12 人警长局',
        icon: '👮',
        boardId: 'board12_sheriff',
        desc: '预女猎白 + 警长：第一天先选警长，他的票算 1.5 票、从谁开口由他定',
        speechLimit: 160,
        tone: '这一桌有警长：票型和警徽的走向都值得盯，说话前先想清楚自己站哪边',
        // 暗牌，与 standard12 同理
        reveal: 'hidden'
        // 这里**故意不写 `pace`**：全仓只有 ROOM_TYPES 定义它、没有一处读它，是死字段。
        // 照抄一条等于给下一个人一个假钩子。
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

/* ---------------- 自动推进（模块级的一档设置，不是某一桌的） ----------------
 *
 * 用户 2026-09-16 定：这是**整个模块**的状态——所以它不进 `session`、不进档案，
 * 存的是 localStorage 里一个 `global_*` 键（开关类键的成法，见 AI/04 与 CLAUDE.md 第 5 条）。
 *
 * 三档（**声明顺序照旧是这张表的顺序**——面板那轮过后界面已经改成顶栏一颗圆钮，
 * 今天只循环 关闭 ↔ 半自动，见 werewolf.js 的 cycleAutoMode）：
 *   full 全自动 —— 整局都由 AI 推进。**今天没做**（`ready: false`：圆钮那个循环进不到它）。
 *   half 半自动 —— 一进「全桌挨个拿主意」的那几拍（四个投票阶段 + 上警表态）就自己按顺序问
 *                   AI；主视角那一座留着，自己来或点一下交给 AI。发言不吃这一档（那是要念出来的）。
 *   off  关闭   —— 保持现状：一位一位点，AI 不会自己动。
 *
 * `desc` 今天没有界面在读（原先那块面板删掉了，圆钮只用 `name` 当 aria-label）——留着当
 * 这三档的白纸黑字，`full` 做出来时也有现成的一行说明。
 *
 * `autoModeOf` 只负责**认值**（认不出的一律落回「关闭」）；「哪一档会自己动」由调用点
 * 明写 `=== 'half'`——别把 `full` 顺手当成「更自动的半自动」，它一行都还没写。
 */
export const AUTO_MODE_KEY = 'global_werewolf_auto';
export const AUTO_DEFAULT = 'off';

export const AUTO_MODES = [
    { key: 'full', name: '全自动', ready: false, desc: '整局交给 AI 推进，你只看——这一档还没做。' },
    { key: 'half', name: '半自动', ready: true, desc: '进入投票或上警表态就自动问 AI，你只管你自己那一份。' },
    { key: 'off', name: '关闭', ready: true, desc: '保持现状：一位一位点，AI 不会自己动。' }
];

/** 认一个存下来的档位；认不出（老值、脏值、没存过）一律当「关闭」＝今天的行为 */
export function autoModeOf(raw) {
    return AUTO_MODES.some(m => m.key === raw) ? raw : AUTO_DEFAULT;
}

/** 某一档的元数据（认不出就给「关闭」那一条，界面不必自己兜底） */
export function autoModeMeta(key) {
    return AUTO_MODES.find(m => m.key === autoModeOf(key));
}

/* ---------------- 这一桌的做法约定（作者自定义：模板正文 + 本桌补充） ---------------- */

/*
 * 模板里写的是**打牌的习惯**（「发言短一点」「多聊票型」），是人话、是这一桌的约定，不是硬规则，
 * 所以注入时只给它一个壳：说清这是这一桌事先说好的，作者写的正文一字不改地摆进去。
 * 措辞纪律照 [[prompt-write-facts-not-bans]]：写成陈述，不写成禁令（点名禁止反而招模型去聊）。
 * 末行那句 precedence 是给冲突兜底的：模型读到的规则不止这一块（阵容、屠边、遗言全是代码常量），
 * 作者的模板万一跟板子的硬规则顶上了，得以板子为准——它得知道自己不是最高法。
 */
export const RULES_HEAD = '【这一桌的做法约定】';

/** 勾了哪几条模板：非数组 → []（老 session 没这个字段，或存了脏值） */
export function ruleTemplateIdsOf(session) {
    return Array.isArray(session?.ruleTemplateIds) ? session.ruleTemplateIds : [];
}

/** 本桌自己写的那段补充：非字符串 → '' */
export function ruleNoteOf(session) {
    return typeof session?.ruleNote === 'string' ? session.ruleNote : '';
}

/**
 * 勾的模板正文（按勾选次序取，找不到的 id **跳过**——模板删了不清各桌的引用）+ 自己写的那段。
 * **模板在前、补充在后**：与面板里的排布、与「勾几条再追加一段」的心智一致。
 */
export function tableRulesText(session, allTemplates = []) {
    const picked = ruleTemplateIdsOf(session)
        .map(id => (allTemplates || []).find(t => t.id === id)?.text || '')
        .filter(Boolean);
    // 只有空白的整段等于没写：别让它拼出一个「有壳、没内容」的块（正文一字不改，只是不留空条）
    return [...picked, ruleNoteOf(session)].filter(t => t.trim());
}

/** 注入提示词的那一块。一条都没勾、也没写 → ''（不留一个空标题在那里） */
export function tableRulesBlock(session, allTemplates = []) {
    const parts = tableRulesText(session, allTemplates);
    if (!parts.length) return '';
    return [
        RULES_HEAD,
        '这一桌的人事先说好了下面这些，这一桌按这个来打：',
        ...parts.flatMap(t => t.split('\n').map(l => l.trim()).filter(Boolean)).map(l => `· ${l}`),
        '（这一桌的板子与规则以法官公布的为准。）'
    ].join('\n');
}

/**
 * 角色扮演的通用头（每个对局内调用都用它做 systemPrompt 开头）。板子构成按实际板子生成。
 *
 * 「规则上不设警长」是**夹在阵容里的一个事实**，不是一条禁令：模型见到「12 人局」自带
 * 警长、警徽流那一套先验（用户 2026-09-13 实测它煞有介事地聊警徽流），只改规则页拦不住，
 * 每次调用都得让它知道这桌的实情。但别写成「不许提警长」——越强调越招它去聊，
 * 人也真会记错规则，偶尔说漏一句就随它去。措辞取「不设」而非「没有」：是规则设定，
 * 不是缺了什么（用户当天定）。
 *
 * 作者的自定义块摆在风格护栏**之前**：那句「不要复述规则」管的是他该怎么说话，
 * 紧跟在自己这块后面会被读成「别念下面这些」。什么都没勾没写时整块不出现。
 *
 * 注意这里是**纯函数**：模板数组由调用方传进来（`allTemplates`），本文件因此
 * 零 import、能被 E2E 逐字复制成 .mjs 直接断言（`tests/e2e-werewolf.js` 的 A 段）。
 */
export function roleHeadText(session, allTemplates = []) {
    const board = getBoard(session?.boardId);
    return [
        '你在扮演一个角色，正在玩一桌狼人杀（'
            + `${boardProse(board.id)}，靠发言和投票找出狼人`
            + (sheriffOf(board)
                ? '；这一桌有警长——第一天先选他：想当的人举手（举手的人这一轮没有票），'
                    + '台上各说一轮、说完还能退水，再由没举手的人投票；他的票算 1.5 票，'
                    + '从谁开口也由他定（只能定从警左还是警右开始），他出局时当众移交警徽或撕掉）。'
                : '；这一桌规则上不设警长）。'),
        tableRulesBlock(session, allTemplates),
        '完全以这个角色的人设说话，用第一人称，不要跳出角色；'
            + '不要提到「AI」「模型」「提示词」「系统」，不要替别人说话，不要复述规则。'
    ].filter(Boolean).join('\n');
}

/* ---------------- 主视角预设标签 ---------------- */

/*
 * 预设标签**跟着房间类型走**：只有这一桌真会出现的身份（板子阵容决定）+ 两个通用标签。
 * 6 人局因此不会冒出女巫/白痴这些这一桌根本没有的身份；换了板子，标签自己跟着换。
 * 顺序 = 好人、[板上角色按 ROLE_META 的先后]、存疑。
 */
export function markTagsOf(session) {
    const board = getBoard(session?.boardId);
    const roles = Object.keys(ROLE_META).filter(id => board.roles[id]);
    return ['好人', ...roles.map(roleLabel), '存疑'];
}

/*
 * 标签压成角标上那一个字：默认取首字，**例外集中在这一张表里**（改口径只动这里）。
 *   村民 → 民：「村」只是个地点，桌面上说的是「民」；
 *   存疑 → ？：它不是某个身份，而是一句「我拿不准」，所以给一个问号。
 */
const MARK_SHORT = { 村民: '民', 存疑: '？' };

export function markShortOf(tag) {
    if (!tag) return '';
    return MARK_SHORT[tag] || tag[0];
}

/* ---------------- 规则页文案 ---------------- */

export function buildRulesPage(type) {
    const board = getBoard(type?.boardId);
    const counts = boardCounts(type?.boardId);
    // 「一夜之间」按板上实际有谁生成：换板子只改 BOARDS.roles + ROLE_META.night，这里不用动。
    const nightLines = Object.keys(board.roles)
        .map(id => ROLE_META[id]?.night)
        .filter(Boolean);
    // 屠边那一行要把这一桌上的神职点名说出来，别让玩家自己猜谁算「神」
    const gods = Object.keys(board.roles).filter(id => sideOf(id) === 'god').map(id => roleLabel(id));

    return [
        {
            title: '这一桌怎么打',
            lines: [
                `${board.label}：${counts}`,
                `座位 ${board.seats} 席，你的角色由发牌随机决定`,
                winModeOf(board) === 'side'
                    ? '狼人全灭 → 好人赢；神职全灭（屠神）或平民全灭（屠民）→ 狼人赢'
                    : '狼人全灭 → 好人赢；狼人数量追平好人 → 狼人赢',
                winModeOf(board) === 'side' && gods.length ? `这一桌的神职：${gods.join('、')}` : '',
                // 警长这件事要明写：模型自己会聊警徽流（用户实测），玩家听见了也会以为规则里有，
                // 与其让他去猜「这局有没有警长」，不如在规则页上先讲清楚。
                // 不设的那一支措辞用「不设」而不是「没有」：这是规则设定，不是缺了什么（用户 2026-09-13 定）。
                sheriffOf(board)
                    ? '这一桌有警长：第一天先选出他——想当的人举手（举手的人这一轮没有票，'
                        + '也只有台上的人能当选），名单一起公布后台上各说一轮、说完还能退水，'
                        + '再由没举手的人投票；平票就台上再各说一轮、由没上台的人补投一次，'
                        + '再平票这一局就没有警徽。他的票算 1.5 票，从谁开口也由他定；'
                        + '他出局时警徽当众移交给一个活人（翻过牌的白痴接不了），'
                        + '或当场撕掉——他自己翻牌时也一样得把徽交出去'
                    : '这一桌规则上不设警长，也没有警徽流'
            ].filter(Boolean)
        },
        {
            title: '一夜之间',
            lines: [
                ...nightLines,
                '天亮了当场公布死讯；当夜无人出局就是平安夜'
            ]
        },
        {
            title: '一个白天',
            lines: [
                '依次发言：每个人说一段自己的判断',
                // 发言的起点与方向：没有警长的桌子由系统掷（用户 2026-09-14：死左或死右、起点随机，
                // 2026-09-15 又定：方向**跟着死左/死右定死**，不再单独掷顺逆——两枚硬币收成一枚）；
                // 有警长的桌子交给警长定（用户 2026-09-15：他**只能定从警左还是警右开始**，不点名）。
                // 两支都别写成「不许自己挑」那种禁令。
                sheriffOf(board)
                    ? '从谁开口不是固定的：这一桌由警长在每个天亮当场定——他只能定从警左还是警右开始，'
                        + '不点名；这一局没有警长（没人上警、全退了水、两次平票都是）'
                        + '或者警徽已经被撕了的时候，由法官当场掷'
                    : '从谁开口不是固定的：这一桌不设警长，由法官在每个天亮当场掷——从死者的左边或右边起，'
                        + '接着朝那一侧数下去（左边＝从下家起顺着数，右边＝从上家起倒着数）；'
                        + '开头的人也随机，掷完当场公布',
                pkEnabled(board)
                    ? '全员投票：投完统一开票，票数最高者出局；平票的几人上台 PK 再投一轮——'
                        + '台上的人这一轮不投票，台下的人只能投台上的人或弃票，再平票则本轮无人出局'
                    : '全员投票：投完统一开票，票数最高者出局（平票则本轮无人出局）',
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
                // 「遗言也接在同一个人后面」只在这张板子真有遗言时才写：6 人板提了就是误导；
                // 「交徽排最后」只在有警长的板子上写。次序是技能 → 遗言 → 警徽（用户 2026-09-15）
                (wordsEnabled(board)
                    ? '有人出局之后，出局的人会按座号挨个走一遍自己的流程（阶段条上的「等待发动技能」，遗言也接在同一个人后面'
                        + (sheriffOf(board) ? '，警长出局还要当众交徽、排在遗言之后' : '') + '）；'
                    : '有人出局之后，出局的人会按座号挨个走一遍自己的流程（阶段条上的「等待发动技能」'
                        + (sheriffOf(board) ? '，警长出局还要当众交徽' : '') + '）；')
                    + '谁出局是公开的，每个人在流程里到底做了什么才看不出来',
                // 天亮 → 死讯 → 死者的流程 → 白天发言：次序写在规则里，别让玩家自己猜（2026-09-13 定）。
                // **警长板的第一天是例外**（用户 2026-09-15）：先竞选、选完才公布昨夜死讯——
                // 线上口径的「盲选」：投票的时候谁也还不知道昨晚谁走了。
                sheriffOf(board)
                    ? '第一天与众不同：天亮了先选警长——想当的人举手（一次机会，同时举手、收齐了才公布），'
                        + '台上各说一轮（说完各自决定退不退水），再由没举手的人投票；'
                        + '一次平票进 PK（台上再各说一轮 + 没上台的人补投），二次平票这一局就没有警徽。'
                        + '选完才公布昨夜谁出局（没人出局就是平安夜）；出局的人走完自己的流程，'
                        + '才轮到白天发言。第二天起与平常一样'
                    : '天亮了先公布昨夜谁出局（没人出局就是平安夜），出局的人走完自己的流程，才轮到白天发言',
                '身份只有自己知道：每个角色只掌握自己的身份与夜里看到的信息',
                board.roles.guard
                    ? '守卫守中当晚的刀口就是平安夜；平安夜也可能只是狼没下刀，两者看起来一样'
                    : '',
                // 守与救同时落在一个人身上 = 反而救死。与猎人那条一样只在**两个身份都在**时才写：
                // 6 人板没女巫，提了就是误导（守卫板与女巫板合流的 12 人板才需要讲这一条）
                board.roles.guard && board.roles.witch
                    ? '守卫与女巫的解药落在同一个人身上，反而救不回来——恰好一个人保他，他才活'
                    : '',
                board.roles.witch && board.roles.hunter
                    ? '猎人被女巫毒死不能开枪；被刀、被投出局照常开枪'
                    : '',
                wordsEnabled(board)
                    ? '第一夜的死者、以及白天被投票出局的人都留遗言；第二夜起夜里出局的人不再开口'
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

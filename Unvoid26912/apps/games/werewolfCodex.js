// apps/games/werewolfCodex.js — 狼人杀知识手册（条目库）+ 角色「狼人杀点数」的档位表
//
// 纯数据 + 纯函数：不碰 DOM、不读存储、无 I/O（只 import 同样是纯常量的 werewolfRooms
// 取身份/房型的中文名），所以 Node 里也 import 得到 ⇒ E2E 的 A 段直接测这一整套。
//
// 本文件是**条目正文的唯一本体**（照 apps/divinationContent.js 的定位）。三条规矩：
// ① id 永不改义、只增不改、删不复用——手册的「已点亮」按 id 存，改义等于篡改历史。
// ② 两条轴别混（用户 2026-09-12 定的）：
//    · 流程纪律（发言秩序、统一开票…）cond 一律 'always'——不设门槛，谁坐下谁拿到；
//    · 策略知识（跳身份、读票型…）cond 是点亮条件——**这才是角色之间的差异**。
//    秩序里「此刻轮到谁」的那一半由 werewolfAI 的 speakOrderBlock 现算（每天都不一样），
//    这里放的是不变的规则文本，两边说的话必须一致。
// ③ 只认得出才算数：条件认不出 ⇒ 不点亮；档位认不出 ⇒ null（**绝不落默认档**）。
//
// 档案本身（战绩 / 档位 / 点亮）不在这里——它长在 werewolfStore 的两个既有 store 上
// （真实角色 stats：名册里的、网络里的都算 / 临时路人 npcs）。本文件只负责两件事：
// 一份经历记录算点亮了哪几条（earnedIds / litIds），以及这些条目怎么讲给模型听（codexBlock）。
// **依赖方向**：只读经历记录里已有的字段（played / byRole / byType …），不 import 存储层，
// 也不负责往记录上累加——累加是 store 自己的事（applyGameResult / recordNpcGame）。

import { roleLabel, getRoomType } from './werewolfRooms.js';

/* ---------------- 档位 ---------------- */

/**
 * 水平五档：`cap` = 一次最多注入几条**策略**条目（流程纪律不占额度）；
 * `line` 是讲给模型听的**认知口吻**描述——只说他「怎么想」，不是命令句：
 * 水平该体现在他自己的判断里，而不是被指挥着走。
 */
export const TIERS = [
    { key: 'beginner', label: '新手', cap: 4, line: '你刚接触狼人杀，规则听过一遍，真上桌还容易发懵。', aliases: ['新手', '菜鸟', '初学者', 'beginner', 'newbie'] },
    { key: 'rookie', label: '入门', cap: 6, line: '你玩过几局，流程已经熟了，判断基本靠直觉和谁说话顺耳。', aliases: ['入门', '初学', 'rookie'] },
    { key: 'normal', label: '普通玩家', cap: 8, line: '你懂常见套路，能跟着局势走，偶尔会多想一想。', aliases: ['普通玩家', '普通', 'normal', 'average'] },
    { key: 'veteran', label: '老手', cap: 10, line: '你打得多了，会算票、会盯发言里的破绽。', aliases: ['老手', '熟练', 'veteran'] },
    { key: 'expert', label: '高手', cap: 12, line: '你对这游戏理解很深，习惯从全局、票型和人心上推演。', aliases: ['高手', '大师', 'expert', 'master'] }
];

/**
 * 悟性四档。今天管四件事：这一局记得住多少（`FLAIR_WATCH`）、手册能往里看几层（`FLAIR_DEPTH`）、
 * 判经历条件时折算几局（`FLAIR_CREDIT`）、以及同一条目同一层里换个说法（`byFlair`）。
 */
export const FLAIR_TIERS = [
    { key: 'dull', label: '迟钝', line: '别人绕个弯你就容易跟丢。', aliases: ['迟钝', '慢热', 'dull'] },
    { key: 'steady', label: '一般', line: '多讲两遍你也能明白。', aliases: ['一般', '中等', 'steady'] },
    { key: 'quick', label: '机敏', line: '一点就透，学得快。', aliases: ['机敏', '灵敏', 'quick'] },
    { key: 'sharp', label: '通透', line: '看一遍就懂，还能自己举一反三。', aliases: ['通透', '敏锐', 'sharp'] }
];

/**
 * 路人的档位恒为「普通玩家」——不落库，读侧按座位 kind 兜（见 litIds 的 isGuest）。
 * 路人一样攒战绩、一样点亮，只是没有测评那一步。
 */
export const GUEST_TIER = 'normal';

/** 没有档位（还没测评）但有档案时，策略条目按中庸给，别让没估过的人白拿满配 */
export const NO_TIER_CAP = 6;

/**
 * 悟性 → 这一局里的**记忆带宽**（用户 2026-09-13 定）：能同时盯住几个人（`watch`）、
 * 别人的普通发言还记得住几条（`tail`）。
 *
 * 悟性本来是「预留」的一栏（见上面 FLAIR_TIERS 的注释「正职是以后的成长速度」），这就是它的正职：
 * 水平管他懂多少（条目额度），悟性管他记得住多少。**数字是可调的初值**，用户玩两局再改。
 */
export const FLAIR_WATCH = {
    dull: { watch: 1, tail: 6 },
    steady: { watch: 2, tail: 10 },
    quick: { watch: 3, tail: 16 },
    sharp: { watch: 4, tail: 24 }
};

/** 没测评 / 悟性认不出的按「一般」兜底（照 NO_TIER_CAP 的写法：别让没估过的人白拿满配） */
export const DEFAULT_WATCH_FLAIR = 'steady';

/**
 * 悟性 → 手册能**往里看几层**（用户 2026-09-14：「悟性代表着能解锁深度的上限」）。
 * 条目的 `deep` 由浅到深排，第 N 层要 `深度上限 > N`——悟性越高，一上手就够得着越深，
 * 而悟性低的人再多打几局也看不进他的上限以外。**数字是初值**（跟 FLAIR_WATCH 一样玩两局再调）。
 *
 * 今天每条只挂一层，所以「机敏 2」与「通透 3」的差别还看不出来——那两格留给以后往里加的层。
 */
export const FLAIR_DEPTH = { dull: 0, steady: 1, quick: 2, sharp: 3 };

/**
 * 悟性 → **折算局数**（用户 2026-09-14：「悟性机敏的人可以直接解锁 3 局以内的条件么？
 * 不然得玩三局才能解锁，有点不符合设定」）。
 *
 * 判「打出来的」那几类条件（played / win / lose / survive / role / type）时，把这几个数加在战绩上：
 * 一点就透的人不必真打完三局——机敏 3 局、通透 6 局，迟钝照旧一局算一局。
 * **只在读数时折算**：不改他自己的战绩，也不进 `level:`（那是能力那条轴，悟性不许替它说话）。
 * 兜底与 `FLAIR_WATCH` / `FLAIR_DEPTH` 同一处：悟性认不出按「一般」= 1 局（没测评的主视角、路人）。
 * **数字是初值**（跟那两张表一样玩两局再调）。
 */
export const FLAIR_CREDIT = { dull: 0, steady: 1, quick: 3, sharp: 6 };

/**
 * 这个座位的记忆带宽。`record` 可以是 null（没档案的路人 / 没测评的人）——一样有兜底，
 * 因为「记性」不能缺席：缺席就等于不截断，反而成了最强的那一档。
 */
export function watchPlan(record) {
    const key = flairByKey(record?.flair)?.key;
    return FLAIR_WATCH[key] || FLAIR_WATCH[DEFAULT_WATCH_FLAIR];
}

/** 这个座位能往里看几层。兜底与 watchPlan 同一处：悟性认不出按「一般」 */
export function flairDepthOf(record) {
    const key = flairByKey(record?.flair)?.key;
    return FLAIR_DEPTH[key] ?? FLAIR_DEPTH[DEFAULT_WATCH_FLAIR];
}

/** 这份记录折算几局。兜底同上：悟性认不出按「一般」 */
export function flairCreditOf(record) {
    const key = flairByKey(record?.flair)?.key;
    return FLAIR_CREDIT[key] ?? FLAIR_CREDIT[DEFAULT_WATCH_FLAIR];
}

const byWord = list => new Map(list.flatMap(t => [t.key, ...t.aliases].map(w => [w, t])));
const TIER_BY_WORD = byWord(TIERS);
const FLAIR_BY_WORD = byWord(FLAIR_TIERS);

export function tierByKey(key) { return TIERS.find(t => t.key === key) || null; }
export function flairByKey(key) { return FLAIR_TIERS.find(t => t.key === key) || null; }

/**
 * 档位的高低比较：**显式写成一张 rank 表**（照 TIER_ORDER 的先例），不依赖数组顺序——
 * 以后往里插一档、或把上面那张表重排，这里的数不跟着漂。认不出的键是 -1（比任何真档位都低）。
 */
const RANK_OF = list => Object.fromEntries(list.map((t, i) => [t.key, i]));
const FLAIR_RANK = RANK_OF(FLAIR_TIERS);
const LEVEL_RANK = RANK_OF(TIERS);

export function flairRank(key) { return FLAIR_RANK[key] ?? -1; }
export function levelRank(key) { return LEVEL_RANK[key] ?? -1; }

/**
 * 比较用的**记录那一侧**取值：认不出就走兜底档——悟性按「一般」（照 DEFAULT_WATCH_FLAIR）、
 * 水平按「普通玩家」（照 GUEST_TIER）。兜底**只管记录，不管条件**：条件里写错档名一律不算数。
 * 没测评的主视角、路人、没档案的人都落在兜底档上，所以深层不是只发得出去给测评过的人。
 */
export function flairRankOf(record) {
    const r = flairRank(record?.flair);
    return r >= 0 ? r : flairRank(DEFAULT_WATCH_FLAIR);
}
export function levelRankOf(record) {
    const r = levelRank(record?.level);
    return r >= 0 ? r : levelRank(GUEST_TIER);
}

/**
 * 认一个档位词：`【水平】老手`、`水平：老手`、`老手`、`老手（偶尔算错票）` 都认。
 * **认不出返回 null**——丢给调用方决定怎么办，绝不在这里挑一个默认档：
 * 第一个没按格式回答的模型会把角色永久钉死在错误的档位上。
 */
function readWord(text, table) {
    const s = String(text ?? '').replace(/[【】\s]/g, '').trim();
    if (!s) return null;
    const bare = s.replace(/^(水平|等级|档位|级别|悟性|level|tier|flair)/i, '');
    const direct = table.get(s) || table.get(bare);
    if (direct) return direct;
    // 带了尾注的写法：取首尾两段各认一次（「老手（偶尔算错票）」认首段）
    const parts = bare.split(/[：:，,。.、/|（）()]/).filter(Boolean);
    for (const cand of [parts[0], parts[parts.length - 1]]) {
        const hit = cand && table.get(cand);
        if (hit) return hit;
    }
    return null;
}

export function parseTier(text) { return readWord(text, TIER_BY_WORD)?.key || null; }
export function parseFlair(text) { return readWord(text, FLAIR_BY_WORD)?.key || null; }

/* ---------------- 条目库 ----------------
 * scope：'common'（通用）｜房型 id（'rookie' / 'blitz' / 'story'，取 werewolfRooms 的 typeId）
 * tier ：'basic'（具体）→ 'principle'（原则）→ 'meta'（元判断），难度即抽象层
 * cond ：点亮条件，词表见 litBy / condText
 */

export const ENTRY_TIERS = ['basic', 'principle', 'meta'];
export const ENTRY_TIER_LABEL = { basic: '基础', principle: '进阶', meta: '眼界' };
const TIER_ORDER = { basic: 0, principle: 1, meta: 2 };

export const ENTRIES = [
    /* —— 通用 · 流程纪律（always：不设门槛，谁坐下谁拿到） —— */
    {
        id: 'common_flow', scope: ['rookie', 'blitz', 'story'], tier: 'basic', cond: 'always',
        title: '发言与投票的秩序',
        text: '天亮了先公布昨夜谁出局（没人出局就是平安夜），出局的人按座号挨个走一遍自己的流程，走完才轮到活人发言。天亮后依次发言，谁先开由法官当场掷定；每人这一轮只说一次，已经说过的人不会再开口；投票是投完统一开票——投的时候谁也看不到别人的票，票数最高的人出局，平票则这一轮没人出局。'
    },
    {
        id: 'common_private', scope: 'common', tier: 'basic', cond: 'always',
        title: '身份只有自己知道',
        text: '你只知道自己的身份、自己夜里看到的东西、和场上公开发生过的事。别人说的话都不算证据，只有出局结果和票型骗不了人。',
        // 用户 2026-09-14：遗言报了身份 ≠ 身份坐实。**不写 need**——只由悟性深度管：
        // 一点就透的人自己就该想到，迟钝的人看不进来。
        deep: [{ text: '有人临死前报出的身份也一样——遗言还是一句他说的话，狼的遗言里同样会报一个身份。' }]
    },
    {
        id: 'common_win', scope: ['rookie', 'blitz', 'story'], tier: 'basic', cond: 'always',
        title: '这局怎么算赢',
        text: '狼人全部出局就是好人赢；狼人数量追平好人（比如 2 狼对 2 好人）就是狼人赢。好人每投错一个，就离输近一步。'
    },
    /* —— 通用 · 策略知识（点亮项） —— */
    {
        id: 'common_speak', scope: 'common', tier: 'basic', cond: 'played:1',
        title: '说话得让人信',
        // 用户 2026-09-14 要「两面都要」：对自己那半（前后对得上）是纪律，进底子谁都有；
        // 拿这把尺子读别人那半是功夫，往下挂一层。
        text: '发言要给出能核对的东西：你怀疑谁、为什么、下一步想投谁。只说「我是好人」，等于什么都没说。自己说过的话也得前后对得上——这一轮的怀疑要和上一轮的立场串成一条线。',
        deep: [{
            need: 'level:normal',
            text: '这把尺子对谁都一样：别人的理由和他自己的立场对不上，那里就有一个线头。'
        }]
    },
    {
        id: 'common_day', scope: 'common', tier: 'basic', cond: 'played:1',
        title: '白天要干什么',
        text: '白天只有一件事：把这些座位里的狼找出来。谁在带节奏、谁在跟风、谁急着让你别多想，比他说了什么更值得看。'
    },
    {
        id: 'common_seer', scope: 'common', tier: 'principle', cond: 'role:seer:1',
        title: '拿到预言家要报',
        text: '预言家的信息，说出来才有用：报清楚你验了谁、结果是什么，让好人有个能信的坐标。藏着不报，等于白拿一张牌。'
    },
    {
        id: 'common_guard', scope: 'common', tier: 'principle', cond: 'role:guard:1',
        title: '守卫的价值不在守中',
        text: '守卫不必守中刀口：你守住一个关键的好人，狼队就得改刀，这一夜的主动权就换了手。'
    },
    {
        id: 'common_wolf', scope: 'common', tier: 'principle', cond: 'role:werewolf:1',
        title: '当狼的时候白天要什么',
        text: '当狼时的目标不是说服所有人，而是让人觉得「先投别人更划算」——你只要能活过这一轮就行。'
    },
    {
        id: 'common_vote', scope: 'common', tier: 'principle', cond: 'played:3',
        title: '读票比读话有用',
        text: '狼人会避免把票投到同伴身上。两个从头到尾没互投过的人，中间往往有一条线——票型是这桌最诚实的东西。',
        // 用户 2026-09-14：票型重要，弃票可能不做好。这一层挂「能力那条路」的样板（门槛是初值）。
        deep: [{
            need: 'level:veteran',
            text: '弃票也是一种表态：票捏在手里不出手的人，等于把自己从票型里摘了出去，看上去最像在躲。'
        }]
    },
    {
        id: 'common_claim', scope: 'common', tier: 'principle', cond: 'played:5',
        title: '跳身份的时机',
        text: '跳得早，狼有整轮时间想对策；跳得晚，好人已经投完了。被逼到墙角才跳，效果最差。'
    },
    {
        id: 'common_silent', scope: 'common', tier: 'meta', cond: 'played:8',
        title: '沉默的好人最危险',
        text: '越不出声越容易被顺手投掉。位置不好的时候，主动给信息比忙着辩解有用。'
    },
    {
        id: 'common_tally', scope: 'common', tier: 'meta', cond: 'win:3',
        title: '最后几轮先算票',
        text: '场上人越少，每一票越值钱。最后几轮开口之前，先把票数算清楚再说话。'
    },

    /* —— 新手局 —— */
    {
        id: 'rookie_open', scope: 'rookie', tier: 'basic', cond: 'always',
        title: '明牌局的谎话不好圆',
        text: '这一桌是明牌局：有人出局会当场公开身份，技能由谁发动也一并写明。所以在这里说过的每一句，都得对得上。'
    },
    {
        id: 'rookie_pace', scope: 'rookie', tier: 'basic', cond: 'always',
        title: '新手局慢慢说',
        text: '新手局不赶时间，把话说全比说狠有用；说得急，反而容易被人抓住话头。'
    },
    {
        id: 'rookie_first', scope: 'rookie', tier: 'principle', cond: 'type:rookie:2',
        title: '先看谁一直不说话',
        text: '新手局里，急着表态的人未必是狼，但一直不开口的人一定要点一下——让他说，比让他躲着强。'
    },

    /* —— 速战局 —— */
    {
        id: 'blitz_short', scope: 'blitz', tier: 'basic', cond: 'always',
        title: '速战局一句话一件事',
        text: '速战局的发言很短，一次只说一件事：要么报信息，要么给判断，别都塞在一句里。'
    },
    {
        id: 'blitz_tempo', scope: 'blitz', tier: 'principle', cond: 'type:blitz:2',
        title: '速战局盯谁跟谁',
        text: '速战局信息少，谁跟着谁投票，比谁说了什么更值得盯——节奏就是这一桌的全部线索。'
    },

    /* —— 扮演局 —— */
    {
        id: 'story_role', scope: 'story', tier: 'basic', cond: 'always',
        title: '扮演局里你演的是自己',
        text: '扮演局可以长篇发言，但你演的是自己这个角色，不是解说员：情绪可以带满，身份不能演漏。'
    },
    {
        id: 'story_tell', scope: 'story', tier: 'principle', cond: 'type:story:2',
        title: '扮演局里的语气变化',
        text: '一个人突然换了称呼、变了口气，说明他心里的事变了。未必和这一局有关，但值得记一笔。'
    },

    /* —— 12 人标准局 ——
     * 这一桌的规矩与 6 人局不同（屠边、PK、遗言、女巫、守卫），所以 common_flow / common_win
     * 两条通用的收成 ['rookie','blitz','story']，这一份单独给它。cond 一律 'always'：
     * **不知道规则不该由档位决定**（何况流程纪律不占策略额度）。 */
    {
        id: 'std12_win', scope: 'standard12', tier: 'basic', cond: 'always',
        title: '这一桌是屠边',
        text: '这一桌不数人头：狼人全灭是好人赢，但神职全灭或者平民全灭，狼人就赢了。所以好人输，常常不是被刀光，而是某一类人先没了。'
    },
    {
        id: 'std12_flow', scope: 'standard12', tier: 'basic', cond: 'always',
        title: '平票要上台 PK',
        text: '天亮后依次发言，投完统一开票，票数最高的人出局。最高票并列时，并列的几位上台各说一段，台下的人再投一轮——这一轮只能投台上的人或者弃票，再平票就没人出局。'
    },
    {
        id: 'std12_words', scope: 'standard12', tier: 'basic', cond: 'always',
        title: '遗言',
        text: '第一夜的死者（被刀、被毒、被猎人开枪带走的都算）与白天被投票出局的人，都能留一段遗言，所有人都听得到；第二夜之后夜里出局的人不再开口。天亮了先公布昨夜谁出局，死者挨个走完自己的流程（等待发动技能、然后才是遗言）才轮到活人发言。'
    },
    {
        id: 'std12_witch', scope: 'standard12', tier: 'basic', cond: 'always',
        title: '女巫的两瓶药',
        text: '女巫有一瓶解药一瓶毒药，各只能用一次，同一夜只能开一瓶；解药还在时，她每夜都会被告知谁被刀（解药一用掉就不再告诉她了）。第一夜她能救自己，之后不能自救，也不能毒自己。'
    },
    {
        // 2026-09-14：白痴换守卫，这一条跟着换成守卫。**id 换了新的**（手册规矩①：删不复用）——
        // 老板子上点亮的 `std12_idiot` 留在档案的 unlocked 里没人再读它（litIds 只认还在表里的 id）。
        id: 'std12_guard', scope: 'standard12', tier: 'basic', cond: 'always',
        title: '守卫守得住谁',
        text: '守卫每晚守一个人，被守的人当夜不会被刀；不能连续两夜守同一个人，可以守自己。他守中刀口就是平安夜——但平安夜也可能只是狼没下刀，两种看起来一模一样。守卫与女巫的解药落在同一个人身上，反而救不回来：恰好一个人保他，他才活。'
    },
    {
        id: 'std12_hunter', scope: 'standard12', tier: 'basic', cond: 'always',
        title: '猎人不是什么时候都能开枪',
        text: '猎人被刀、或被投票出局，都能开枪带走一个人；被女巫毒死则不能开枪。他开枪在自己遗言之前，所以枪响之后才知道他最后想说什么。'
    }
];

const ENTRY_BY_ID = new Map(ENTRIES.map(e => [e.id, e]));

export function entryById(id) { return ENTRY_BY_ID.get(id) || null; }

/**
 * 一条条目属不属于这一层。scope 可以是**字符串，也可以是数组**——
 * 同一条规矩给几个房型共用时写数组（比如「平票无人出局」三张 6 人房型都有，
 * 12 人局是 PK，不能共用一个 scope）。
 */
function inScope(entry, scope) {
    return Array.isArray(entry.scope) ? entry.scope.includes(scope) : entry.scope === scope;
}

/** 某一层（通用 / 某个房型）的全部条目，顺序就是声明顺序 */
export function entriesIn(scope) { return ENTRIES.filter(e => inScope(e, scope)); }

/* ---------------- 点亮条件 ---------------- */

const need = v => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : NaN;
};
const playedIn = (map, key) => Number(map?.[key]?.played) || 0;

/**
 * 这条条件在这份经历记录上算不算数。
 * 认不出的条件一律 false——宁可少点亮一条，也别凭空发出去。
 * **「打出来的」那几类吃悟性折算**（见 `FLAIR_CREDIT`）：一点就透的人不必真打完那几局；
 * 能力那条路（`level:`）不折算。没有档案就没人可折算，按 0 局算。
 */
export function litBy(cond, record) {
    const parts = String(cond || '').split(':');
    const credit = record ? flairCreditOf(record) : 0;
    switch (parts[0]) {
        case 'always': return true;
        case 'played': return (Number(record?.played) || 0) + credit >= need(parts[1]);
        case 'win': return (Number(record?.win) || 0) + credit >= need(parts[1]);
        case 'lose': return (Number(record?.lose) || 0) + credit >= need(parts[1]);
        case 'survive': return (Number(record?.survival) || 0) + credit >= need(parts[1]);
        case 'role': return playedIn(record?.byRole, parts[1]) + credit >= need(parts[2]);
        case 'type': return playedIn(record?.byType, parts[1]) + credit >= need(parts[2]);
        // 能力那一条路：档位够高就算数（`level:老手` 在老手与高手身上都算数）。
        // **先认出要求、再比大小**——要求的档名认不出就 false，免得写错一个字白送给所有人。
        case 'level': {
            const req = levelRank(parts[1]);
            return req >= 0 && levelRankOf(record) >= req;
        }
        default: return false;
    }
}

/**
 * 没点亮时显示的那句人话（认不出的条件返回空串，界面上就不显示这一行）。
 * 写的是**门槛本身**，不写折算后的数：悟性高的人少打几局就够，那句门槛对他根本不出现。
 */
export function condText(cond) {
    const parts = String(cond || '').split(':');
    switch (parts[0]) {
        case 'always': return '坐下就点亮';
        case 'played': return `打过 ${parts[1]} 局`;
        case 'win': return `赢过 ${parts[1]} 局`;
        case 'lose': return `输过 ${parts[1]} 局`;
        case 'survive': return `活到最后 ${parts[1]} 次`;
        case 'role': return `当过 ${parts[2]} 局${roleLabel(parts[1])}`;
        case 'type': return `打过 ${parts[2]} 局${getRoomType(parts[1])?.name || parts[1]}`;
        case 'level': return tierByKey(parts[1])?.label || '';
        default: return '';
    }
}

/* ---------------- 点亮 ---------------- */

/**
 * 手册里的某一条，对这份档案亮没亮。
 * 单条判定只写在这里：手册页（逐条显示）与 litIds（注入用）共用同一套规矩，不会漂。
 */
export function isLit(entry, record, { isGuest = false } = {}) {
    if (!entry) return false;
    // 流程纪律不设门槛：这一桌的规矩，谁坐下谁知道（不需要档案，也不需要打过）
    if (entry.cond === 'always') return true;
    if ((record?.unlocked || []).includes(entry.id)) return true;      // 曾经授予过的，一直算数
    if (isGuest) return inScope(entry, 'common') && entry.tier === 'basic';
    return !!record && litBy(entry.cond, record);
}

/**
 * 这份记录现在算得出点亮了哪些（结算时写进 unlocked 的就是它）。
 * 与读侧的区别：这里不含「曾经授予」，只有条件本身。
 * 悟性折算照算：够就是够，结算时写进 unlocked 之后一直算数（照「曾经授予过的一直算数」）。
 */
export function earnedIds(record) {
    return ENTRIES.filter(e => litBy(e.cond, record)).map(e => e.id);
}

/**
 * 注入提示词时真正算数的那一份。
 * 过滤只对「无条件」的条目生效——明牌局的规矩不该出现在速战局的桌上；
 * 而靠条件挣来的知识（比如在速战局练出来的读票）换个房型也还是他自己的。
 */
export function litIds(record, { isGuest = false, roomScope = null } = {}) {
    const out = new Set();
    for (const e of ENTRIES) {
        const inRoom = inScope(e, 'common') || (roomScope != null && inScope(e, roomScope));
        if (inRoom && isLit(e, record, { isGuest })) out.add(e.id);
    }
    for (const id of (record?.unlocked || [])) if (ENTRY_BY_ID.has(id)) out.add(id);
    return [...out];
}

/* ---------------- 分级可见：同一条目，谁看得多深、谁看得见哪种说法 ----------------
 * 用户 2026-09-14 定的三条：
 *   ① 同一条目往下挂多层（`deep`，由浅到深），层是「往里看」；
 *   ② **悟性给深度上限**（FLAIR_DEPTH），**能力/经历给这一层自己的门槛**（`need`，可省；
 *      经历类的门槛一样吃 FLAIR_CREDIT 那份折算，只有 `level:` 不吃）；
 *   ③ 同一层的内容还能按悟性**改写或追加**（`byFlair`）。
 * 层与变体都**现算**：不走 isLit、不进 unlocked——能力是此刻的状态，不是挣来的经历。
 * 门槛数值与分级粗细都是初值，以后调数据（这一段一行不用动）。
 */

/** 门槛认不认得出来。`need` 省了算合法（只看悟性深度）；文案器认得出＝词表认得出（两处一一对应） */
function needOk(cond) {
    return cond == null || String(cond) === '' || condText(cond) !== '';
}

/**
 * 条目上那一串层（由浅到深）。只做「认得出」这一关：缺正文、门槛认不出的层丢掉，**不牵连整条**——
 * 手册里少一句，不该让这一条整条没了。（`byFlair` 写错的键在 nodeText 里跳过，不改数据本身。）
 */
export function entryDeep(entry) {
    const raw = entry?.deep;
    if (!Array.isArray(raw)) return [];
    return raw.filter(l => l && typeof l.text === 'string' && l.text && needOk(l.need));
}

/** 这一层开没开：**深度上限**（悟性）与**它自己的门槛**（能力/经历）都得过 */
function layerOpen(layer, i, record) {
    if (i >= flairDepthOf(record)) return false;
    return layer.need == null || litBy(layer.need, record);
}

/** 要看第 i 层，悟性最低得到哪一档（深度表够不着这一层就按最高档说——那说明数据写过头了） */
function flairNeedLabel(i) {
    const t = FLAIR_TIERS.find(x => (FLAIR_DEPTH[x.key] ?? 0) > i);
    return (t || FLAIR_TIERS[FLAIR_TIERS.length - 1]).label;
}

/**
 * 这一块正文此刻长什么样：默认正文 + 按悟性**依次**生效的 `byFlair`。
 * 变体是**累积**的：`steady` 换了说法、`quick` 又补一截，通透的人两句都见着；
 * 只应用不超过本人悟性的那些，写错的键只丢它自己。条目底子与每一层共用这一个出口。
 */
export function nodeText(node, record) {
    let text = String(node?.text || '');
    const vary = node?.byFlair;
    if (!vary || typeof vary !== 'object') return text;
    const mine = flairRankOf(record);
    Object.keys(vary)
        .map(k => [flairRank(k), k])
        .filter(([r]) => r >= 0 && r <= mine)
        .sort((a, b) => a[0] - b[0])
        .forEach(([, k]) => {
            const v = vary[k];
            if (typeof v === 'string') text = v;                         // 换掉这一层的说法
            else if (v && typeof v.more === 'string') text += v.more;    // 在这一层后面再接一截
        });
    return text;
}

/**
 * 这一条此刻的完整正文：底子 + 够得着的那些层，顺序接起来。
 * **注入与手册页共用这一个出口**——手册上看到的，就是模型拿到的。
 */
export function entryTextOf(entry, record) {
    if (!entry) return '';
    let text = nodeText(entry, record);
    entryDeep(entry).forEach((layer, i) => {
        if (layerOpen(layer, i, record)) text += nodeText(layer, record);
    });
    return text;
}

/**
 * 还锁着的层，给界面一句「差什么」。没锁的层返回空串（界面据此决定要不要多这一行）。
 * 两条轴各说各的：悟性不够说悟性，能力不够说门槛原文（走 condText）。
 */
export function deepLockText(entry, record) {
    const parts = [];
    entryDeep(entry).forEach((layer, i) => {
        if (layerOpen(layer, i, record)) return;
        const bits = [];
        if (i >= flairDepthOf(record)) bits.push(`悟性·${flairNeedLabel(i)}以上`);
        if (layer.need != null && !litBy(layer.need, record)) bits.push(condText(layer.need) || layer.need);
        parts.push(bits.join('，且'));
    });
    return parts.join('；');
}

/* ---------------- 讲给模型听 ---------------- */

export const CODEX_MAX_CHARS = 1200;   // 整块字符上限（第二道封顶，照 DictionaryMatcher 的双封顶写法）
export const CODEX_HEAD = '【你对狼人杀的理解】';

/**
 * 这个座位此刻能拿出手的狼人杀知识。没得说就返回空串（**不产生空标题**）。
 * @param {object} record 这个座位自己的档案（名册读 stats，路人读 npcs；可以是 null）
 * @param {{isGuest?:boolean, roomScope?:string, maxChars?:number}} opts
 */
export function codexBlock(record, { isGuest = false, roomScope = null, maxChars = CODEX_MAX_CHARS } = {}) {
    const tierKey = isGuest ? GUEST_TIER : (tierByKey(record?.level)?.key || null);
    const tier = tierByKey(tierKey);
    const ids = new Set(litIds(record, { isGuest, roomScope }));

    const lines = [];
    if (tier) lines.push(`你的水平：${tier.label}——${tier.line}`);

    const picked = ENTRIES.filter(e => ids.has(e.id))
        .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);   // 稳定排序：同级保持声明顺序
    const cap = tier?.cap ?? NO_TIER_CAP;
    let used = 0, drawn = 0;
    for (const e of picked) {
        const strategic = e.cond !== 'always';      // 额度只算策略知识，流程纪律不占
        if (strategic && drawn >= cap) continue;
        const text = entryTextOf(e, record);        // 分级可见：底子 + 他够得着的层（手册页同源）
        if (used + text.length > maxChars) continue;   // 超长**整条跳过**，不截断半句
        lines.push(`· ${text}`);
        used += text.length;
        if (strategic) drawn += 1;
    }
    // 一行都没有就别开这个标题（「不产生空标题」）：有档位说档位，有知识说知识
    return lines.length ? [CODEX_HEAD, ...lines].join('\n') : '';
}

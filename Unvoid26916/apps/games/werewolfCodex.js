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
 *
 * **cap 的口径（用户 2026-09-16 定）**：**区分主要交给「解锁度」**（`cond`——一个人
 * 懂多少由他经历过什么决定），cap 退成一道**保险丝**，不是主要手段；「能力之类的
 * 依旧能提升上限」⇒ 梯度保留，只是每档都放宽。**数字是初值**，玩两局再调。
 *
 * 2026-09-16 由 `4/6/8/10/12` 抬到 `6/9/12/16/20`：加完四条策略条目后，12 人警长局
 * 可点亮的策略条目涨到 ~14，而老手旧 cap 恰好卡满 10 ⇒ 排后面的会被**静默截掉**
 * （截的是「tier + 数组声明顺序」的尾巴，**不是按难度截**，见 codexBlock）。
 */
export const TIERS = [
    { key: 'beginner', label: '新手', cap: 6, line: '你刚接触狼人杀，规则听过一遍，真上桌还容易发懵。', aliases: ['新手', '菜鸟', '初学者', 'beginner', 'newbie'] },
    { key: 'rookie', label: '入门', cap: 9, line: '你玩过几局，流程已经熟了，判断基本靠直觉和谁说话顺耳。', aliases: ['入门', '初学', 'rookie'] },
    { key: 'normal', label: '普通玩家', cap: 12, line: '你懂常见套路，能跟着局势走，偶尔会多想一想。', aliases: ['普通玩家', '普通', 'normal', 'average'] },
    { key: 'veteran', label: '老手', cap: 16, line: '你打得多了，会算票、会盯发言里的破绽。', aliases: ['老手', '熟练', 'veteran'] },
    { key: 'expert', label: '高手', cap: 20, line: '你对这游戏理解很深，习惯从全局、票型和人心上推演。', aliases: ['高手', '大师', 'expert', 'master'] }
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
        id: 'common_flow', group: 'rule', scope: ['rookie', 'blitz', 'story'], tier: 'basic', cond: 'always',
        title: '发言与投票的秩序',
        text: '天亮了先公布昨夜谁出局（没人出局就是平安夜），出局的人按座号挨个走一遍自己的流程，走完才轮到活人发言。天亮后依次发言，谁先开由法官当场掷定；每人这一轮只说一次，已经说过的人不会再开口；投票是投完统一开票——投的时候谁也看不到别人的票，票数最高的人出局，平票则这一轮没人出局。'
    },
    {
        id: 'common_private', group: 'rule', scope: 'common', tier: 'basic', cond: 'always',
        title: '身份只有自己知道',
        text: '你只知道自己的身份、自己夜里看到的东西、和场上公开发生过的事。别人说的话都不算证据，只有出局结果和票型骗不了人。',
        // 用户 2026-09-14：遗言报了身份 ≠ 身份坐实。**不写 need**——只由悟性深度管：
        // 一点就透的人自己就该想到，迟钝的人看不进来。
        deep: [{ text: '有人临死前报出的身份也一样——遗言还是一句他说的话，狼的遗言里同样会报一个身份。' }]
    },
    {
        id: 'common_win', group: 'rule', scope: ['rookie', 'blitz', 'story'], tier: 'basic', cond: 'always',
        title: '这局怎么算赢',
        text: '狼人全部出局就是好人赢；狼人数量追平好人（比如 2 狼对 2 好人）就是狼人赢。好人每投错一个，就离输近一步。'
    },
    /* —— 通用 · 策略知识（点亮项） —— */
    {
        id: 'common_speak', group: 'skill', scope: 'common', tier: 'basic', cond: 'played:1',
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
        id: 'common_day', group: 'skill', scope: 'common', tier: 'basic', cond: 'played:1',
        title: '白天要干什么',
        text: '白天只有一件事：把这些座位里的狼找出来。谁在带节奏、谁在跟风、谁急着让你别多想，比他说了什么更值得看。'
    },
    {
        id: 'common_seer', group: 'seer', scope: 'common', tier: 'principle', cond: 'role:seer:1',
        title: '拿到预言家要报',
        text: '预言家的信息，说出来才有用：报清楚你验了谁、结果是什么，让好人有个能信的坐标。藏着不报，等于白拿一张牌。'
    },
    {
        id: 'common_guard', group: 'guard', scope: 'common', tier: 'principle', cond: 'role:guard:1',
        title: '守卫的价值不在守中',
        text: '守卫不必守中刀口：你守住一个关键的好人，狼队就得改刀，这一夜的主动权就换了手。'
    },
    {
        id: 'common_wolf', group: 'wolfplay', scope: 'common', tier: 'principle', cond: 'role:werewolf:1',
        title: '当狼的时候白天要什么',
        text: '当狼时的目标不是说服所有人，而是让人觉得「先投别人更划算」——你只要能活过这一轮就行。'
    },
    {
        id: 'common_vote', group: 'skill', scope: 'common', tier: 'principle', cond: 'played:3',
        title: '读票比读话有用',
        text: '狼人会避免把票投到同伴身上。两个从头到尾没互投过的人，中间往往有一条线——票型是这桌最诚实的东西。',
        // 用户 2026-09-14：票型重要，弃票可能不做好。这一层挂「能力那条路」的样板（门槛是初值）。
        deep: [{
            need: 'level:veteran',
            text: '弃票也是一种表态：票捏在手里不出手的人，等于把自己从票型里摘了出去，看上去最像在躲。'
        }]
    },
    {
        id: 'common_claim', group: 'skill', scope: 'common', tier: 'principle', cond: 'played:5',
        title: '跳身份的时机',
        text: '跳得早，狼有整轮时间想对策；跳得晚，好人已经投完了。被逼到墙角才跳，效果最差。'
    },
    {
        id: 'common_silent', group: 'skill', scope: 'common', tier: 'meta', cond: 'played:8',
        title: '沉默的好人最危险',
        text: '越不出声越容易被顺手投掉。位置不好的时候，主动给信息比忙着辩解有用。'
    },
    {
        id: 'common_tally', group: 'skill', scope: 'common', tier: 'meta', cond: 'win:3',
        title: '最后几轮先算票',
        text: '场上人越少，每一票越值钱。最后几轮开口之前，先把票数算清楚再说话。'
    },

    /* —— 新手局 —— */
    {
        id: 'rookie_open', group: 'rule', scope: 'rookie', tier: 'basic', cond: 'always',
        title: '明牌局的谎话不好圆',
        text: '这一桌是明牌局：有人出局会当场公开身份，技能由谁发动也一并写明。所以在这里说过的每一句，都得对得上。'
    },
    {
        id: 'rookie_pace', group: 'rule', scope: 'rookie', tier: 'basic', cond: 'always',
        title: '新手局慢慢说',
        text: '新手局不赶时间，把话说全比说狠有用；说得急，反而容易被人抓住话头。'
    },
    {
        id: 'rookie_first', group: 'skill', scope: 'rookie', tier: 'principle', cond: 'type:rookie:2',
        title: '先看谁一直不说话',
        text: '新手局里，急着表态的人未必是狼，但一直不开口的人一定要点一下——让他说，比让他躲着强。'
    },

    /* —— 速战局 —— */
    {
        id: 'blitz_short', group: 'rule', scope: 'blitz', tier: 'basic', cond: 'always',
        title: '速战局一句话一件事',
        text: '速战局的发言很短，一次只说一件事：要么报信息，要么给判断，别都塞在一句里。'
    },
    {
        id: 'blitz_tempo', group: 'skill', scope: 'blitz', tier: 'principle', cond: 'type:blitz:2',
        title: '速战局盯谁跟谁',
        text: '速战局信息少，谁跟着谁投票，比谁说了什么更值得盯——节奏就是这一桌的全部线索。'
    },

    /* —— 扮演局 —— */
    {
        id: 'story_role', group: 'rule', scope: 'story', tier: 'basic', cond: 'always',
        title: '扮演局里你演的是自己',
        text: '扮演局可以长篇发言，但你演的是自己这个角色，不是解说员：情绪可以带满，身份不能演漏。'
    },
    {
        id: 'story_tell', group: 'skill', scope: 'story', tier: 'principle', cond: 'type:story:2',
        title: '扮演局里的语气变化',
        text: '一个人突然换了称呼、变了口气，说明他心里的事变了。未必和这一局有关，但值得记一笔。'
    },

    /* —— 12 人标准局 / 12 人警长局（共用）——
     * 这一桌的规矩与 6 人局不同（屠边、PK、遗言、女巫），所以 common_flow / common_win
     * 两条通用的收成 ['rookie','blitz','story']，这一份单独给它。cond 一律 'always'：
     * **不知道规则不该由档位决定**（何况流程纪律不占策略额度）。
     * 这几条逐条读过，没有一句提到警长或次序，所以两张 12 人板共用（数组 scope）。
     * **守卫那条不给警长板**：那张板子不发守卫牌，放进去既误导又白占字数。
     *
     * ⚠️ **但这几条的 `group` 不在这里**（用户 2026-09-16 定）：女巫/守卫/猎人/白痴讲的是
     * **身份自身的规则**，归各自的身份组，不跟 `common_flow` 这类真正的流程纪律一起挂在
     * 「桌上的规矩」下。`cond:'always'` 是**纪律轴**（不占策略额度），跟**内容属于谁**是两回事——
     * 先前按 cond 划组，等于把「守卫守得住谁」判成了规矩，跟「身份基础放身份里」正好拧着。 */
    {
        id: 'std12_win', group: 'rule', scope: ['standard12', 'sheriff12'], tier: 'basic', cond: 'always',
        title: '这一桌是屠边',
        text: '这一桌不数人头：狼人全灭是好人赢，但神职全灭或者平民全灭，狼人就赢了。所以好人输，常常不是被刀光，而是某一类人先没了。'
    },
    {
        id: 'std12_flow', group: 'rule', scope: ['standard12', 'sheriff12'], tier: 'basic', cond: 'always',
        title: '平票要上台 PK',
        text: '天亮后依次发言，投完统一开票，票数最高的人出局。最高票并列时，并列的几位上台各说一段，台下的人再投一轮——这一轮只能投台上的人或者弃票，再平票就没人出局。'
    },
    {
        id: 'std12_words', group: 'rule', scope: ['standard12', 'sheriff12'], tier: 'basic', cond: 'always',
        title: '遗言',
        text: '第一夜的死者（被刀、被毒、被猎人开枪带走的都算）与白天被投票出局的人，都能留一段遗言，所有人都听得到；第二夜之后夜里出局的人不再开口。天亮了先公布昨夜谁出局，死者挨个走完自己的流程（等待发动技能、然后才是遗言）才轮到活人发言。'
    },
    {
        id: 'std12_witch', group: 'witch', scope: ['standard12', 'sheriff12'], tier: 'basic', cond: 'always',
        title: '女巫的两瓶药',
        text: '女巫有一瓶解药一瓶毒药，各只能用一次，同一夜只能开一瓶；解药还在时，她每夜都会被告知谁被刀（解药一用掉就不再告诉她了）。第一夜她能救自己，之后不能自救，也不能毒自己。'
    },
    {
        // 2026-09-14：白痴换守卫，这一条跟着换成守卫。**id 换了新的**（手册规矩①：删不复用）——
        // 老板子上点亮的 `std12_idiot` 留在档案的 unlocked 里没人再读它（litIds 只认还在表里的 id）。
        id: 'std12_guard', group: 'guard', scope: 'standard12', tier: 'basic', cond: 'always',
        title: '守卫守得住谁',
        text: '守卫每晚守一个人，被守的人当夜不会被刀；不能连续两夜守同一个人，可以守自己。他守中刀口就是平安夜——但平安夜也可能只是狼没下刀，两种看起来一模一样。守卫与女巫的解药落在同一个人身上，反而救不回来：恰好一个人保他，他才活。'
    },
    {
        id: 'std12_hunter', group: 'hunter', scope: ['standard12', 'sheriff12'], tier: 'basic', cond: 'always',
        title: '猎人不是什么时候都能开枪',
        text: '猎人被刀、或被投票出局，都能开枪带走一个人；被女巫毒死则不能开枪。他开枪在自己遗言之前，所以枪响之后才知道他最后想说什么。'
    },

    /* —— 12 人警长局独有 ——
     * 只写这张板子跟标准 12 人板**不一样**的地方：警长怎么来、他那一票多重、
     * 次序谁定、警徽怎么走，以及白痴回归。cond 一律 'always'（同上的理由）。 */
    {
        id: 'sheriff12_pick', group: 'rule', scope: 'sheriff12', tier: 'basic', cond: 'always',
        title: '第一天先选警长，选完才公布死讯',
        text: '这一桌有警长。天亮了先把他选出来，选完才公布昨夜谁出局——也就是说，投这一票的时候，你还不知道昨晚走了谁。选他分四拍：想当的人先举手，然后台上各说一轮，再由没举手的人投票，最后开票。'
    },
    {
        id: 'sheriff12_signup', group: 'rule', scope: 'sheriff12', tier: 'basic', cond: 'always',
        title: '想当警长就先举手',
        text: '选举头一拍是举手：想当警长的举手，不想当的不举，所有人**同时举手、一次定下**，收齐了才一起公布谁在台上。上了警的人这一轮没有投票权；也只有台上的人能当选。'
    },
    {
        id: 'sheriff12_withdraw', group: 'rule', scope: 'sheriff12', tier: 'basic', cond: 'always',
        title: '警上发言可以退水',
        text: '名单公布后，台上的人挨个说一轮，这一轮是说给台下听的。说完他自己决定退不退水：退了水只少第一轮的票，平票之后的补投他还能投。台上最后只剩一个没退水的人，他直接当选，连投票都省了。'
    },
    {
        id: 'sheriff12_tie', group: 'rule', scope: 'sheriff12', tier: 'basic', cond: 'always',
        title: '警长平票：台上再说一轮，台下补投',
        text: '警下投票平了，台上那几位再各说一轮，由没上台的人在他们当中补投一次；补投再平，这一局就没有警徽。没人举手、台上的人全退了水、或者所有人都上了警（没人能投票），同样是没有警徽。'
    },
    {
        id: 'sheriff12_weight', group: 'rule', scope: 'sheriff12', tier: 'basic', cond: 'always',
        title: '警长的票算 1.5 票',
        text: '警长的票算 1.5 票：算票时他那一票按一票半计，其余人各算一票。所以票数咬得紧的那一轮，他站哪边往往就是那半票的差别。'
    },
    {
        id: 'sheriff12_order', group: 'rule', scope: 'sheriff12', tier: 'basic', cond: 'always',
        title: '从谁开口由警长定',
        text: '每天天亮后由警长当场定从谁开口：他只能定从警左还是警右开始（他自己座位的下家那一侧、或上家那一侧），不点名。这一局没有警长、或者警徽已经被撕了，就由法官当场掷（从死者的左边或右边起）。'
    },
    {
        id: 'sheriff12_badge', group: 'rule', scope: 'sheriff12', tier: 'basic', cond: 'always',
        title: '警徽怎么传下去',
        text: '警长出局时当众把警徽交给一个活着的人，也可以当场撕掉——撕了这一局就再没有警长。'
            + '翻过牌的白痴接不了警徽（他没有票，接了也是空的）；反过来，**他自己是警长又翻了牌**，'
            + '也得当场把徽交出去或撕掉，不能留着。他这一拍排在最后：有遗言先留遗言，然后才交徽。'
    },
    {
        id: 'sheriff12_idiot', group: 'idiot', scope: 'sheriff12', tier: 'basic', cond: 'always',
        title: '白痴翻牌不算出局',
        text: '白痴被投票出局时翻开底牌，当场免死——他不算出局，人还在、还能说话，只是此后没有投票权、也不会再被投票放逐、警徽也接不到他手里；但他夜里照样会被狼刀死。'
    },
    {
        id: 'common_idiot', group: 'idiot', scope: 'common', tier: 'principle', cond: 'role:idiot:1',
        title: '拿到白痴别怕被投',
        text: '白痴这张牌不怕被投出去：被投只是翻牌，人还活着。所以白天被逼到墙角时可以放开手脚说，不必为了活命把话讲软——把票引到自己身上，好人就少一次投错。'
    },

    /* —— 2026-09-16 加的四条：具体局面怎么打（用户要「提升质量」的那一层）——
     * ⚠️ 其中「狼队分工」那条**当天晚些时候已拆成五条**——用户纠正了「概念成组」的意思，
     * 见本数组末尾那段注释。
     * 起因：用户问手册里有没有对跳/警徽流/倒勾/冲锋/垫飞——**一条都没有**。
     * 粒度是用户定的「概念成组」（不按单个战术切碎），措辞是「白话为主、行话按需出现」
     * （概念绕不开时直接用词，跟一句白话解释）。
     *
     * ⚠️ **三条通用条目的正文里不许出现「警长 / 警徽 / 举手 / 1.5 票」**——
     * 它们会进 6 人局的提示词，而 6 人局不设警长（测试有金丝雀钉着）。
     * 提到警徽的只能是 scope:'sheriff12' 的条目，这正是「对跳」与「警徽流」**必须拆成两条**
     * 的原因：合一条就得整体锁死在警长局，而 6 人局同样有对跳。
     * 静态扫描见 tests/e2e-werewolf.js 那条「条目库静态扫」。
     * 四条一律 tier:'principle'，声明在末尾 ⇒ 既有条目的相对注入顺序一字不动。 */
    {
        id: 'common_seerfight', group: 'seer', scope: 'common', tier: 'principle', cond: 'played:4',
        title: '两个人报同一个身份',
        text: '两个人同时报自己是预言家（对跳）的时候，好人手里没有实据，只能比两条验人线：一条从第一夜就定死了，另一条顺着场上的局势长出来——后者的每一步都刚好合上这一轮的需要。报出来的金水（验出来是好人）和查杀（验出来是狼）也一样：真的那份名单是提前定好的，假的那个往往跟着风向改。这时候急着站边最容易站错。'
    },
    {
        id: 'common_seerplan', group: 'seer', scope: 'common', tier: 'principle', cond: 'role:seer:2',
        title: '验人要有顺序',
        text: '预言家交出来的不只是一个结果，是一条线：先验谁、为什么先验他、下一个准备验谁。好人顺着这条线能把一片关系定下来，所以这条线顺不顺，他们看得出来。反过来，东一个西一个地报，就算全是真的，场上也用不上——验人的价值一半在结果，一半在顺序。'
    },
    {
        id: 'sheriff12_badgeflow', group: 'seer', scope: 'sheriff12', tier: 'principle', cond: 'type:sheriff12:2',
        title: '警徽流：徽交到谁手里',
        text: '预言家拿到警徽之后，多一种不用开口的说法方式：他可以在发言里把接下来的验人计划讲清楚，再约定好徽的去向——他要是出了事，徽交到谁手里，就代表那一步的结果。这一手叫警徽流，场上的人靠它，能在预言家说不了话之后接着读他的意思。徽被当场撕掉，常常是他手上没有一个能交的人。'
    },
    /* —— 2026-09-16 拆分：`common_wolfsplit` 一条讲四个战术 → 拆成五条 ——
     * 起因：用户纠正了「概念成组」的意思——**组是分组，不是合并**：
     * 「比如**拿狼要怎么玩**，里面再**细分条目**，按照经验以及悟性不同，看到的条目内容与数量也不同。
     *   条目数不减，只是分组，甚至可能条目会更加精细和复杂。」
     * 所以上一轮把 悍跳/倒钩/垫飞/冲锋 揉进一条是做反了——这里拆回来。
     *
     * `common_wolfsplit` **退休、id 不复用**（上面规矩①：删不复用）。玩家 `unlocked` 里若留悬空 id，
     * 读侧全是遍历 `ENTRIES`（codexBlock / litIds / earnedIds），天然被忽略，**不需要迁移**。
     *
     * 共同理由（「谁跟谁是一伙的…全挤在一起就是排队送」）留在 `common_wolfstand` 当这一组的头，
     * **不写进组的 desc**——desc 只在手册页渲染、**不进注入**（codexBlock 只读 ENTRIES），
     * 而这句话是模型必须拿到的知识。
     *
     * cond 一律 `role:werewolf:N` 递增：只有真拿过狼的人才懂狼怎么打。用 `role:` 而不是 `played:`
     * 正是用户那条原则的落点——「熟知某身份玩法的人，即使这局不拿它，也该知道这个身份怎么玩」，
     * 战绩是**生涯**口径、跨局累计。
     *
     * ⚠️ 五条都是 `scope:'common'`，正文+标题里不许出现「警长 / 警徽 / 举手 / 1.5 票」——
     * 悍跳因此写「占**预言家**的位置」而不是「抢警徽」（静态扫在 tests/e2e-werewolf.js）。
     * 声明在末尾 ⇒ 既有条目的相对注入顺序一字不动；代价见变更日志（新手/入门档够不着这五条）。 */
    {
        id: 'common_wolfstand', group: 'wolfplay', scope: 'common', tier: 'principle', cond: 'role:werewolf:2',
        title: '狼队要分开站',
        text: '狼队最怕让人一眼看出谁跟谁是一伙的：几张牌挤在一起说话，场上把线一连就串上了。所以白天要分开站——各走各的走法，让场上连不成一条线。全挤在一起，就是排队送。'
    },
    {
        id: 'common_wolfjump', group: 'wolfplay', scope: 'common', tier: 'principle', cond: 'role:werewolf:3',
        title: '悍跳：占住预言家的位置',
        text: '悍跳是狼自己跳出来占预言家的位置：报一条假的验人线，把水搅浑。场上只要有人信，真的那张牌就得花一整轮去自证，狼队这一轮就缓过来了。跳之前先想好这条线怎么编——编不圆，等于把自己钉上去。'
    },
    {
        id: 'common_wolfhook', group: 'wolfplay', scope: 'common', tier: 'principle', cond: 'role:werewolf:4',
        title: '倒钩：站到好人那一边',
        text: '倒钩是狼站到好人那一边：跟着好人投票、跟着好人踩自己的队友，用一票一票把自己洗成好人。倒钩最忌讳中途反水——立场一变，前面攒的信任全废。一般留到后面几轮，狼队要冲票的时候再用。'
    },
    {
        id: 'common_wolfcharge', group: 'wolfplay', scope: 'common', tier: 'principle', cond: 'role:werewolf:5',
        title: '冲锋：硬保队友、硬踩好人',
        text: '冲锋是硬保队友、硬踩好人：队友被架上票台，你正面顶上去替他说话，把票往别人身上引。前提是自己站得够稳——你自己都在风口上，冲上去只是多搭一条命。'
    },
    {
        id: 'common_wolfcushion', group: 'wolfplay', scope: 'common', tier: 'principle', cond: 'role:werewolf:5',
        title: '垫飞：替队友挡在前面',
        text: '垫飞是替被架住的队友挡在前面：把话头、把票都往自己身上引，让他从这一轮里脱身。垫的人多半要挨一轮票，所以动手之前先算清楚——用谁去换谁，值不值。'
    }
];

/* ---------------- 阵营与组（条目库的分组轴） ----------------
 * 用户 2026-09-16 定的形状：**两层，阵营 → 组**（「比如拿狼要怎么玩，里面再细分条目」）。
 *
 * **组是纯组织轴**：手册页按「阵营 → 组 → 条目」渲染；注入侧一个字不动——
 * codexBlock 只读 cond/tier/id/正文，**不读 group**。筛选继续走现成的 cond + scope + 额度，
 * 不分身份、不按组排序（用户明确选的「全桌都注入，不排序」）。
 *
 * **组按内容划，不按 cond 划**（用户 2026-09-16 纠正）：讲某个身份自身规则的那几条，
 * 归那个身份的组，**哪怕它是 `cond:'always'`**。`always` 只说明「不占策略额度、谁坐下谁有」，
 * 不说明它属于哪一类知识——按 cond 划会把「守卫守得住谁」这类身份说明判成规矩。
 *
 * **组标题写身份本身，不写「怎么玩」**（用户 2026-09-16 晚些）：身份组就叫「预言家」「女巫」，
 * 不叫「拿预言家要怎么玩」——身份是这一节的**题目**，怎么玩是里面条目的事。
 * 组内以后再细分（策略 / 基础知识之类），这轮只改名、不加层。
 *
 * 好人阵营的组顺序照 werewolfRooms.js 的 ROLE_META 身份次序（预 → 女 → 守 → 猎 → 白）。
 * 照 werewolfRooms.js 的 ROOM_TYPES 写：一张表 + 查找器，**声明顺序即显示顺序**（不依赖 key 顺序）。
 * 组自带 `desc`（渲染进手册页组头的 .ww-section-title 的 <span> 位）。
 * ⚠️ 组名与组说明也会印在手册页每一节上 ⇒ **同样不许出现「警长 / 警徽 / 举手 / 1.5 票」**
 * （测试里那条静态扫必须覆盖这两张表——它原先只扫条目正文，是个洞）。
 *
 * 阵营**不写在条目上**，由条目的 `group` 反查——单一数据源，别重复存。
 */

export const CODEX_CAMPS = [
    { key: 'wolf', name: '狼' },
    { key: 'good', name: '好人' },
    { key: 'both', name: '两边通用' }
];

export const CODEX_GROUPS = [
    { key: 'wolfplay', camp: 'wolf', name: '狼人', desc: '白天分头走，别让人一眼看出谁跟谁是一伙的。' },
    { key: 'seer', camp: 'good', name: '预言家', desc: '手上有一条别人没有的线：验出来的结果。' },
    { key: 'witch', camp: 'good', name: '女巫', desc: '两瓶药，一瓶救人、一瓶杀人，一整局各只有一次。' },
    { key: 'guard', camp: 'good', name: '守卫', desc: '守的是主动权：让狼队改刀，这一夜就换手。' },
    { key: 'hunter', camp: 'good', name: '猎人', desc: '出局的时候还能带走一个人。' },
    { key: 'idiot', camp: 'good', name: '白痴', desc: '这张牌不怕被投。' },
    { key: 'rule', camp: 'both', name: '桌上的规矩', desc: '坐下就得知道：怎么算赢、天亮干什么、各自身份的边界。' },
    { key: 'skill', camp: 'both', name: '怎么看人看局', desc: '怎么听人、怎么投票。' }
];

const GROUP_BY_KEY = new Map(CODEX_GROUPS.map(g => [g.key, g]));
const CAMP_BY_KEY = new Map(CODEX_CAMPS.map(c => [c.key, c]));

export function groupByKey(key) { return GROUP_BY_KEY.get(key) || null; }
export function campByKey(key) { return CAMP_BY_KEY.get(key) || null; }

/** 这个阵营的组，顺序就是 CODEX_GROUPS 的声明顺序 */
export function groupsOfCamp(campKey) { return CODEX_GROUPS.filter(g => g.camp === campKey); }

/**
 * 一个组里的全部条目，顺序就是 ENTRIES 的声明顺序。
 * ⚠️ **别改用 entriesIn 写**——它只做 scope 精确相等、**不含 common 条目**（见下面那条注释），
 * 而绝大多数组都横跨 common 与房型。这里就是一次 group 字段的相等过滤。
 */
export function groupEntries(groupKey) { return ENTRIES.filter(e => e.group === groupKey); }

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

/**
 * 条目角标上的房型（手册页用）：`守卫守得住谁 · 12 人标准局`。
 * `scope:'common'` 返回 `''`——全桌通用，不标；其它把 scope 里每个房型 id 换成中文名，
 * 顺序就是 scope 数组自己的顺序（那是手写下来的序，不再绕一趟重排）。
 *
 * **纯显示**：注入侧一个字不读它。筛选仍旧只走 scope + cond + 额度（`litIds` 的 inRoom），
 * 这里只是把那一份筛选的**结果**画出来——同一个 scope，所以两者不可能对不上。
 */
export function roomLabelOf(entry) {
    return [].concat(entry?.scope ?? [])
        .map(id => getRoomType(id)?.name)
        .filter(Boolean)
        .join(' · ');
}

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
 *
 * **两道过滤，两拨条目都过**：通用条目（`common`）哪一桌都能讲；房型条目只在自己的房型里讲。
 * 挣来的知识跟着人走（速战局练出来的读票换个房型还是他自己的）——但**房型条目走不出那个房型**：
 * 它们逐字讲的是「这一桌怎么打」（`sheriff12_*` 那八条就是），搬进没警长的 6 人局就是假话。
 *
 * ⚠️ **2026-09-16 修的漏**：`unlocked` 那一支原先直接塞、不过 scope，于是「在警长局点亮过的」
 * 会跟着人进**任何**房型的提示词——用户在 6 人局的复盘里看见了「这一桌有警长，天亮了先把他
 * 选出来」，报的就是这个。结算与读侧共用这一个函数，改这里一处即可。
 */
export function litIds(record, { isGuest = false, roomScope = null } = {}) {
    const out = new Set();
    const inRoom = e => inScope(e, 'common') || (roomScope != null && inScope(e, roomScope));
    for (const e of ENTRIES) {
        if (inRoom(e) && isLit(e, record, { isGuest })) out.add(e.id);
    }
    for (const id of (record?.unlocked || [])) {
        const e = ENTRY_BY_ID.get(id);
        if (e && inRoom(e)) out.add(id);
    }
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

// 整块字符上限（第二道封顶，照 DictionaryMatcher 的双封顶写法）。
// 2026-09-15 用户定：1200 → 5000，为的是 12 人警长局那几条规矩进得来。
// 注意这不是空操作：**条数 cap 只管策略条目**（`cond !== 'always'`），`always` 的流程纪律
// 只受这一道字数封顶——所以抬上去之后，原先「整条超长被跳过」的那些**策略条目**会重新进来
// （上限是各档位的 cap，不是字数）。超长仍然整条跳过、不截半句（设计如此）。
export const CODEX_MAX_CHARS = 5000;
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

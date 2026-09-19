// apps/textgameCore.js — 文游的纯逻辑层
//
// **零 import**：不碰 DOM、不碰存储、不发请求。提示词组装 / 选项识别 / 树导航都在这里，
// 这样它们可以在页面上下文里单独 import 出来跑断言（同 werewolfRooms.js 的做法）。
//
// 红线（改这个文件前先读 AI/07）：全链路只出现「主角」「本局」「这一遍游玩」，
// 不出现「用户 / 玩家 / 使用者」。主角的行动由记录给出，AI 不替他往前写。
// 例外口径：剧本原文与 AI 输出里写的是「玩家」还是「主角」，**跟着剧本走**——剧本是权威，
// 不替它改名、也不在导入时改写；这条红线约束的是模块自己的文案与提示词。

// ============================================================
// 提示词组装
// ============================================================

/**
 * 不随剧本变化的两段固定文本。**导出**：剧本页要照着它显示「这一块没动过时到底发的是什么」。
 * 用语一律是**事实陈述**而不是禁令——点名禁止反而招模型去聊那件事（项目已有教训）。
 *
 * 两段各占 system 的一头（见 buildTurnPrompt）：前一段管「你是谁」，最后一段吃掉余量。
 * 剧本级可覆盖、可关（prompts）：默认就是这两段。
 */
export const DEFAULT_FRAME_PROMPT = [
    '你是这部文游剧本的叙事引擎：世界、配角、旁白由你演绎。',
    '主角的行动与台词由这一遍游玩的记录给出，你不替他往前写。',
    '剧本原文随后，它是本次游玩的最高权威——世界观、规则、文风、字段约定一律以剧本为准。',
    '这个故事里的每个人都按自己的立场和所知行事。主角的每个决定都会带来后果，包括他不想要的那种。'
].join('\n');

export const DEFAULT_OUTPUT_CONTRACT = [
    '输出要求：',
    '- 只写这一段叙事正文本身（剧本若规定了状态栏、选项列法，照剧本写在正文之后）；',
    '- 可用轻量 Markdown：分段、**加粗**、- 列表、> 引用；',
    '- 剧本没规定篇幅时 600~1500 字；承接上文，不复述已有情节；',
    '- 剧本要求给选项时，每行一个、行首带编号或符号，放在整段输出的最末。'
].join('\n');

/** 两块的身份。key 就是剧本记录上 prompts 的字段名（存与取只有这一张表） */
export const PROMPT_BLOCKS = [
    { key: 'frame', label: '叙事引擎', where: 'system 开头', fallback: DEFAULT_FRAME_PROMPT },
    { key: 'contract', label: '输出约定', where: 'system 末尾', fallback: DEFAULT_OUTPUT_CONTRACT }
];

/**
 * 把剧本记录上的 prompts 补齐成两块的完整形态——**缺什么补什么，不丢已有的**。
 * `text` 空白 ⇒ 这一块从没动过：发的时候用模块当前默认（模块以后改进默认文案，
 * 没动过的剧本自动跟上）。这跟 freeMode 是同一种写法（没这个字段就按默认算）。
 */
export function normalizePrompts(prompts) {
    const out = {};
    for (const b of PROMPT_BLOCKS) {
        const spec = prompts?.[b.key];
        out[b.key] = {
            on: spec?.on !== false,
            text: typeof spec?.text === 'string' ? spec.text : ''
        };
    }
    return out;
}

/**
 * 一块到底发不发、发什么。null = 这一块不注入。
 * 开关关掉时**不看 text**——文字留着，下次打开还是你那段。
 */
export function resolvePromptBlock(spec, fallback) {
    if (spec?.on === false) return null;
    const text = typeof spec?.text === 'string' ? spec.text.trim() : '';
    return text || fallback;
}

export const DEFAULT_MAX_CONTEXT_CHARS = 100000;

/** 一轮在提示词里长这样（intro = 开场节点，它没有主角输入） */
function turnBlock(node, index, withNarration) {
    if (!node.playerInput) {
        return withNarration
            ? `[${index}] 旁白：${node.aiText || ''}`
            : `[${index}] （开场）`;
    }
    const head = `[${index}] 主角行动：${node.playerInput}`;
    return withNarration ? `${head}\n    旁白：${node.aiText || ''}` : head;
}

/**
 * 把「根 → 当前节点」这条路径摊平成一段文本。
 *
 * **只摊平这一条路径**：分叉出去的另一条支线，AI 看不到——这是特性不是 bug，
 * 重走一遍就该是重走一遍。
 *
 * 超预算时的降级是确定性的、绝不虚构：先丢最旧那几轮的旁白（只留「主角行动」），
 * 还超就把最早那批合并成一行「更早的 N 步（略）」。
 * **两级都只动中间那段：开场（index 0）与当前（index last）的旁白永不丢**。
 *
 * @returns {{text:string, degradedTurns:number}}
 */
export function flattenPath(pathNodes, { maxContextChars = DEFAULT_MAX_CONTEXT_CHARS } = {}) {
    const list = (Array.isArray(pathNodes) ? pathNodes : []).filter(Boolean);
    if (!list.length) return { text: '', degradedTurns: 0 };

    const withNarration = list.map(() => true);
    let total = list.reduce((sum, n, i) => sum + turnBlock(n, i + 1, true).length + 1, 0);

    const last = list.length - 1;
    let degradedTurns = 0;

    // 第一级：从最旧一头丢旁白。index 0（开场）与 index last（当前）不动。
    for (let i = 1; i < last && total > maxContextChars; i++) {
        if (!withNarration[i]) continue;
        withNarration[i] = false;
        total -= (list[i].aiText || '').length + 8;
        degradedTurns += 1;
    }

    // 第二级：还超就把最早那批合并成一行。
    // 从 index 1 起并、index 0 不并——与第一级的 i = 1 对齐（两级都护着开场），
    // 当前节点（index last）也永不并入。预算紧到连「开场 + 当前」都放不下时，
    // 就停在那一档（宁可超出，也不把开场整条吞掉）。
    let collapseTo = 1;
    while (total > maxContextChars && collapseTo < last) {
        total -= turnBlock(list[collapseTo], collapseTo + 1, withNarration[collapseTo]).length + 1;
        collapseTo += 1;
    }

    const lines = [turnBlock(list[0], 1, withNarration[0])];
    if (collapseTo > 1) lines.push(`[2]~[${collapseTo}] 更早的 ${collapseTo - 1} 步（略）`);
    for (let i = Math.max(1, collapseTo); i < list.length; i++) {
        lines.push(turnBlock(list[i], i + 1, withNarration[i]));
    }

    return {
        text: lines.join('\n'),
        degradedTurns: degradedTurns + Math.max(0, collapseTo - 1)
    };
}

/**
 * 组装这一轮的两次消息。
 *
 * ⚠️ **systemPrompt 里绝不放主角名、轮数、时间等每局变量**——字节恒定才能命中
 * DeepSeek 的 prefix 缓存（同一剧本的每一局、每一轮 system 完全相同），省 token 也降延迟。
 * 每局变量全进 userContent。
 *
 * @param {object} input
 * @param {string} input.scriptText 剧本原文（原样，不加工）
 * @param {{name:string, note:string}} input.protagonist 这一局抄下来的抬头（模块自己的数据）
 * @param {{detail?:string, secret?:string}} [input.protagonistRef] 引用来的那两截——**调用方每轮现读**，读不到传空
 * @param {Array} [input.pathNodes] 根 → 当前节点（含当前节点）——**不含**「此刻」那一步
 * @param {string} [input.playerInput] 这一步的行动；开场模式传空
 * @param {'open'|'advance'} input.mode
 * @param {object} [input.prompts] 剧本级的两块（开关 + 文字），见 normalizePrompts
 * @returns {{systemPrompt:string, userContent:string, meta:{estChars:number, degradedTurns:number}}}
 */
export function buildTurnPrompt({
    scriptText = '',
    protagonist = {},
    protagonistRef = {},
    pathNodes = [],
    playerInput = '',
    mode = 'advance',
    maxContextChars = DEFAULT_MAX_CONTEXT_CHARS,
    prompts = null
} = {}) {
    // 拼装顺序就是优先级：谁在前面谁先被读到，谁在最后谁吃掉剩余注意力。
    // 两块各自独立——关掉一块只是少一段，另一段的位置和内容都不动。
    const p = normalizePrompts(prompts);
    const systemPrompt = [
        resolvePromptBlock(p.frame, DEFAULT_FRAME_PROMPT),
        `【剧本原文】\n${scriptText}`,
        resolvePromptBlock(p.contract, DEFAULT_OUTPUT_CONTRACT)
    ].filter(Boolean).join('\n\n');

    const name = String(protagonist?.name || '').trim();
    const note = String(protagonist?.note || '').trim();

    // 主角不是必填：整个留空 = **直接开场**（有些剧本开场才问身份），这一块就一个字不写——
    // 不写「主角：（空）」这种占位，那一刻的权威是剧本原文。
    // 只填了设定没填名字 = 一个不具名的主角：只写设定那一行。
    //
    // 【本局】这一块由两半拼成，归属不同（别混）：
    //   抬头 = 开局那一刻**抄下来**的名字与设定，是这一局自己的数据，角色以后删了也还在；
    //   下面两截 = 从角色卡**引用**来的（调用方每轮现读），读不到就整截不写——
    //   不留「（角色已删除）」这种话：那一刻这一局照旧跑得下去，缺口不是事实。
    const head = [];
    if (name) {
        head.push(`【本局】主角：${name}`);
        head.push(`主角设定：${note || '（剧本未指定，按剧本开场自然带入）'}`);
    } else if (note) {
        head.push(`【本局】主角设定：${note}`);
    }

    const detail = String(protagonistRef?.detail || '').trim();
    const secret = String(protagonistRef?.secret || '').trim();
    const ref = [];
    if (detail) ref.push(`主角详细设定：\n${detail}`);
    // 秘密单独起一行、带上标签：这个模块的 AI 是上帝视角（旁白与 NPC 都归它写），
    // 秘密在这里是「事实」，标签顺带说明它「是真的、但 NPC 不知道」。
    if (secret) ref.push(`主角的秘密：${secret}`);
    // 只引用、不抄也能成立（两个框都留空、只挂着一个角色卡）⇒ 那几截自己起一块，补上头一样的那三个字
    if (ref.length && !head.length) ref[0] = `【本局】${ref[0]}`;

    const blocks = [];
    const protagonistBlock = [...head, ...ref].join('\n');
    if (protagonistBlock) blocks.push(protagonistBlock);

    let degradedTurns = 0;
    if (mode === 'open') {
        blocks.push('【此刻】故事还没开始。请按剧本设定输出开场。');
    } else {
        const flat = flattenPath(pathNodes, { maxContextChars });
        degradedTurns = flat.degradedTurns;
        if (flat.text) {
            blocks.push(`【剧情记录】（按时序；「主角行动」来自这一遍游玩，「旁白」是你的输出）\n${flat.text}`);
        }
        blocks.push(`【此刻】主角行动：${playerInput}\n请接着写下去。`);
    }

    const userContent = blocks.join('\n\n');
    return {
        systemPrompt,
        userContent,
        meta: { estChars: systemPrompt.length + userContent.length, degradedTurns }
    };
}

// ============================================================
// 输出结构：围栏切分
// ============================================================
//
// 剧本常要求把状态面板一类的东西用 markdown 代码块包起来。
// 切分只做一件事：把输出分成「正文段」和「围栏段」。**定界行本身被吃掉、不在任何一段里**——
// 渲染要的是「把围栏画成块」，不需要那三个反引号；所以别在别处声称这个函数无损。
// 未闭合的围栏一律当围栏段处理到结尾（模型少写一个收尾很常见）。
const FENCE_RE = /^\s*```/;

export function splitFences(raw) {
    const out = [];
    let buf = [];
    let kind = 'text';
    let info = '';

    const flush = () => {
        const text = buf.join('\n');
        if (text.trim()) out.push(kind === 'fence' ? { kind, text, info } : { kind, text });
        buf = [];
        info = '';
    };

    for (const line of String(raw ?? '').split('\n')) {
        if (FENCE_RE.test(line)) {
            flush();
            if (kind === 'text') {
                kind = 'fence';
                info = line.trim().slice(3).trim();   // ```html / ```xml……只有开栏行有
            } else {
                kind = 'text';
            }
            continue;
        }
        buf.push(line);
    }
    flush();
    return out;
}

// ============================================================
// 自由模式：正文当 HTML 画
// ============================================================
//
// 剧本自己声明「输出 HTML」的（美化格式那类），模块不再转义、直接画进沙箱 iframe
// （沙箱不带 allow-scripts，里面的 JS 一个字都跑不了；渲染在 apps/textgame.js）。
// 模块**不改提示词**：AI 吐不吐 HTML 是剧本说了算，这个开关只管「怎么画」。
//
// 只能认形态：出现 HTML 标签就当 HTML。认错了的代价只在显示上（这段字被当 HTML 画，可能丢换行），
// 切回普通模式就是剥成文字——和选项识别同一个立场（认形态、不解释协议，误判代价小）。

const HTML_TAG_RE = /<\/?(?:div|p|span|section|article|header|footer|main|aside|nav|h[1-6]|table|thead|tbody|tr|td|th|caption|ul|ol|li|dl|dt|dd|blockquote|pre|hr|br|img|figure|figcaption|details|summary|strong|em|b|i|u|s|small|big|sup|sub|mark|center|font|style|link|meta|title|body|html)\b[^>]*>/gi;

/** 这段字看着像 HTML 吗？（够一个块级/结构标签就算） */
export function looksLikeHtml(text) {
    const hits = String(text ?? '').match(HTML_TAG_RE);
    return !!hits && hits.length >= 1;
}

/**
 * 自由模式下把一节正文拆成「HTML 段 / 纯文本段」。
 * - 围栏的 info string 写着 html/xml ⇒ 栏里就是 HTML（模型很爱把整篇 HTML 裹一层 ```）
 * - 其余段看形态：像 HTML 就是 HTML，否则是纯文本（渲染层会转义它、按原样排）
 * @returns {Array<{kind:'html'|'text', text:string}>}
 */
export function htmlParts(raw) {
    return splitFences(raw).map(seg => {
        const declared = seg.kind === 'fence' && /^(?:html|xml)$/i.test(seg.info || '');
        return { kind: declared || looksLikeHtml(seg.text) ? 'html' : 'text', text: seg.text };
    });
}

// ============================================================
// 普通模式：先把 HTML 标签剥掉（**剥，不是解释它**）
// ============================================================
//
// 两种显示方式的分工：自由模式把美化格式画出来；**普通模式 = 正常的文字格式 md 解析**
// （用户 2026-09-18 口径）——md 认得的记号照画，HTML 标签不在这套记号里，所以先在这里剥掉。
// 剥完剩下的字照样走 md 与转义（转义防的是注入），读者看不到标签。
// 立场和选项识别一致：只认形态、不解释协议——这里做的是「扔掉格式记号」，不是解析 DOM。

// 标签体的共同写法：引号里的值整段吃掉，属性里带 > 也不误伤
const TAG_BODY = `(?:[^>"']|"[^"]*"|'[^']*')*`;
const STRIP_HIDDEN_RE = /<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const STRIP_LINE_RE = new RegExp(`</?(?:p|div|section|article|header|footer|main|aside|nav|h[1-6]|ul|ol|li|dl|dt|dd|blockquote|pre|tr|table|thead|tbody|figure|figcaption|details|summary|hr)\\b${TAG_BODY}>`, 'gi');
const STRIP_BR_RE = new RegExp(`<br\\b${TAG_BODY}>`, 'gi');
const STRIP_TAG_RE = new RegExp(`<${TAG_BODY}>`, 'g');
const ENTITY_RE = /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi;

const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…',
    mdash: '—', ndash: '–', middot: '·', times: '×'
};

function decodeEntity(whole, name) {
    if (name[0] === '#') {
        const hex = name[1] === 'x' || name[1] === 'X';
        const n = parseInt(hex ? name.slice(2) : name.slice(1), hex ? 16 : 10);
        if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return whole;
        try { return String.fromCodePoint(n); } catch { return whole; }
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
}

/**
 * 把一段 HTML 降级成可读文字：脚本/样式整段丢掉、块级标签当断行、其余标签剥掉、实体解回来
 * （只解一次，`&amp;lt;` 该显示成 `&lt;`）。标签之间相邻的文字会并到一起（`</span><span>` 处的
 * 换行没了），这是「只认文字格式」的已知代价。
 * 返回空串 = 这段里本来就没字（只剩 <img> 之类）⇒ **交给调用方兜底**（渲染层退回原样，免得一屏空白）。
 */
export function htmlToText(raw) {
    return String(raw ?? '')
        .replace(STRIP_HIDDEN_RE, '')
        .replace(STRIP_BR_RE, '\n')
        .replace(STRIP_LINE_RE, '\n')
        .replace(STRIP_TAG_RE, '')          // 先剥标签再解实体：否则 &lt;div&gt; 会被这一步连带剥掉
        .replace(ENTITY_RE, decodeEntity)
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ============================================================
// 选项识别（**只给渲染加样式，不做按钮**——用户 2026-09-18 定的口径）
// ============================================================
//
// 为什么不做按钮：点了会把那行字当行动发出去（功能），而正文里那几行照旧在 ⇒ 同一段
// 上下各出现一次；回看旧节时还要额外处理「那些按钮算谁的」；又和底部输入栏抢位置。
// 所以：认出来 = 把这一块圈出来换个画法，原文一字不改，选哪条自己往输入框里打。
// 识别错了最坏结果是几行普通文字被套了个样式框，没有别的代价。
//
// 原则：只做**尾部窗口**的形态识别，认不出就整段照原样渲染。
// 剧本通常这样规定一轮输出：正文 → 分隔线 → 选择小标题 → 带编号的 4 条选项 → 状态面板（围栏块）。
// 于是有两条要紧的：
//   ① **选项块后面还压着脚手架行**（小标题、分隔线）。尾部窗口往回走时遇到它们要**跳过**，
//      不是停下，否则永远走不到选项块——这是之前四种变体全认不出的主因。
//   ② 面板在围栏里，切段时就被 splitFences 拿走了 ⇒ 面板里的字段行不会混进来（白给的）。

const OPTION_HEADER_WORDS = ['可选', '选项', '选择', '你的选择', '请选择', '抉择', '下一步', '行动选项'];

// 装饰符 = 小标题/结构行两端的「外衣」。反引号也在里面——围栏定界行洗完就是空串，正该算结构行。
const DECOR_RE = /[\s◈◆◇●○■□▪▫▲△▼▽▸▶►★☆✦✧*_#~`·•∙|丨:：;；,，.。、!！?？\-—–－→>《》「」『』【】\[\]〔〕（）()]/g;
const BOXED_RE = /^(?:【[^】]{0,40}】|\[[^\]]{0,40}\])$/;   // 【第N部分：…】 这类小标题
const DIAMOND_RE = /^[◈◆◇][^◈◆◇]{0,20}[◈◆◇]$/;           // ◈ … ◈ 这类小标题

/** 剥掉装饰符，剩下的才算内容 */
function stripScaffold(s) {
    return String(s || '').replace(DECOR_RE, '');
}

/**
 * 「选项：」这一类小标题：只剥装饰外衣、再比词，所以比原来那条正则宽——
 * `（选择）`、`**选择**`、`# 选择` 从此都算。
 */
function isOptionHeader(line) {
    const core = stripScaffold(line);
    return !!core && core.length <= 8 && OPTION_HEADER_WORDS.includes(core);
}

/**
 * 脚手架行：分隔线、裸围栏、`【…】` / `◈ … ◈` 小标题、选项小标题。
 * 它们不是内容、也不该变成按钮，对识别来说只是「块边界」。
 */
function isScaffold(line) {
    const raw = String(line || '').trim();
    if (!raw) return false;
    if (isOptionHeader(raw)) return true;
    if (!stripScaffold(raw)) return true;          // 洗完什么都不剩 ⇒ 纯符号行
    return BOXED_RE.test(raw) || DIAMOND_RE.test(raw);
}

// 纯符号的分隔线。`-`/`*`/`_` 不在里面：那三样是 markdown 的 <hr>，md 渲染器自己认领
// （在 plainLayout 里先被判成结构行，轮不到这里）
const DIVIDER_RE = /^[━─═—–－=~·▁▔]{3,}$/;

/**
 * 装饰性标题栏：整行就是一个「框」的短行——`【状态面板】`、`◈ 选择 ◈`、`━━━━━━`。
 * 普通模式把它们居中（2026-09-19 用户口径）。判据卡得紧：
 * ① 只认成对包裹的框（或通体符号的分隔线）；② 框里那一截不能长——
 * 否则正文里一句「【她说的原话是……】」也会被当成标题栏去居中。
 */
const BANNER_MAX = 20;                             // 框里那一截最多几个字（【第四部分：玩家状态面板（代码块）】= 17）
export function isBannerLine(line) {
    const raw = String(line || '').trim();
    if (!raw || raw.length > 60) return false;
    // ⚠️ 分隔线与「框」要分开认：`━ ─ ═` 这几个制表符**不在** DECOR_RE 里
    // （DECOR_RE 是给选项识别洗装饰用的，动它等于动识别），所以不能靠 stripScaffold 判空
    if (DIVIDER_RE.test(raw)) return true;
    if (!stripScaffold(raw)) return false;          // 洗完什么都不剩、又不成线 ⇒ `◈◈`、`（）` 这类残片
    if (!BOXED_RE.test(raw) && !DIAMOND_RE.test(raw)) return false;
    return raw.slice(1, -1).trim().length <= BANNER_MAX;
}

// 结构行：md 渲染器靠**相邻的标记行**成组（`<li>` 挨着 `<li>` 才包成 <ul>、引用要自己一行），
// 往它们中间插空行会把组拆散，还会留下一串没配对的 </p>。所以这些行一律整块原样交给 mdToHtml。
// 注意 `---` 也走这条：它是 <hr>，不能当标题栏去居中。
const BLOCK_LINE_RE = /^(?:#{1,6}\s|[-*+]\s|\d+[.、]\s?|>\s?|\||`| {2,}|\t|(?:-{3,}|\*{3,}|_{3,})$)/;

function layoutKind(raw, body) {
    if (BLOCK_LINE_RE.test(raw)) return 'block';
    return isBannerLine(body) ? 'banner' : 'para';
}

/**
 * 普通模式栏外正文的排版计划：把那段字切成一个个「画法单元」，渲染层照着画。
 * - 空行分段照旧；**块内每一行都是散文**时，块里的单换行也算分段——一行一段，
 *   于是每一段都能落首行缩进（书排那样）。混着结构行的块整块不动（见 BLOCK_LINE_RE）。
 * - `【状态面板】` 这类标题栏单独成格，渲染层把它们居中。
 * 自足的纯函数（零 import，A 段要在 Node 里直跑）：返回顺序就是原文顺序，
 * 逐格交给 mdToHtml 画——它自己 esc 一次，别再套一层。
 * @param {string} text
 * @returns {Array<{kind:'para'|'block'|'banner', text:string}>}
 */
export function plainLayout(text) {
    const out = [];
    for (const blk of String(text ?? '').split(/\n{2,}/)) {
        const lines = blk.split('\n').map(l => ({ raw: l, body: l.trim() })).filter(l => l.body);
        for (let i = 0; i < lines.length;) {
            const kind = layoutKind(lines[i].raw, lines[i].body);
            let j = i;
            // 只有结构行连着算一格；散文与标题栏一行一格（每行都要各自缩进 / 各自居中）
            if (kind === 'block') while (j + 1 < lines.length && layoutKind(lines[j + 1].raw, lines[j + 1].body) === 'block') j++;
            out.push({ kind, text: lines.slice(i, j + 1).map(l => l.body).join('\n') });
            i = j + 1;
        }
    }
    return out;
}

// 强标记：行首有编号 / 符号 / 括号编号 / 方括号编号 / 【一】
// 分隔符两类：`A.` `1、` 这类标点，以及 `A — 描述` 这类破折号
// （`{1,2}` 顺手吃掉双写 `——`；吃掉后仍有残留时由 stripDecor 兜底）。
const STRONG_RE = /^\s*(?:[-*•·▸→]|(?:\d{1,2}|[A-Ha-h])\s*(?:[.、)）:：]|[—–－→]{1,2}|-)|[(（]\s*(?:\d{1,2}|[A-Ha-h])\s*[)）]|\[\s*\d{1,2}\s*\]|【\s*(?:\d{1,2}|[一二三四五六七八九十])\s*】|选项\s*(?:\d{1,2}|[一二三四五六七八九十])\s*(?:[.、:：)）]|[—–－→]{1,2})?)\s*(\S.*)$/;

const SENTENCE_END_RE = /[。！？…，、；：.!?;:,]$/;
const QUOTE_PAIRS = [['「', '」'], ['『', '』'], ['“', '”'], ['‘', '’'], ['"', '"'], ['《', '》']];

const WINDOW_MAX_LINES = 12;   // 尾部窗口最多看多少个非空行
const STRONG_MAX_LEN = 40;     // 强标记行的正文长度上限
const WEAK_MAX_LEN = 24;       // 裸行的长度上限（这类最容易误报，所以卡更紧）
const SCAFFOLD_RUN_MAX = 3;    // 尾部最多连跨几行脚手架（实测尾部一般只连跨 2 行）

/** 去掉加粗记号、成对包裹的引号、行首残留的破折号、尾随句号 */
function stripDecor(s) {
    let t = String(s || '').trim();
    t = t.replace(/^\*+|\*+$/g, '').trim();
    for (const [open, close] of QUOTE_PAIRS) {
        if (t.length > open.length + close.length && t.startsWith(open) && t.endsWith(close)) {
            t = t.slice(open.length, t.length - close.length).trim();
            break;
        }
    }
    // `A —— x` 这类：分隔符只吃 1~2 个，多吃出来的横杠会留在正文里，
    // 而这段文本会**原样当主角行动发出去**，所以必须洗掉（正确性问题，不是排版问题）。
    t = t.replace(/^[—–－→-]+\s*/, '');
    return t.replace(/[。.]+$/, '').trim();
}

/** 一眼就不是选项的行 */
function isRejected(rawLine, text) {
    if (text.length > 60) return true;
    if (text.length > 40 && text.includes('**')) return true;
    if (/^#{1,6}\s/.test(rawLine.trim())) return true;
    if (/^>/.test(rawLine.trim())) return true;
    if (/^(旁白|叙事|注|提示|说明)\s*[:：]?/.test(text)) return true;
    // 像「地点：旧宅」这类正文陈述——短句里带冒号的多半是字段，不是选项
    if (text.length > 20 && /[：:]/.test(text)) return true;
    return false;
}

function matchStrong(line) {
    const m = STRONG_RE.exec(line);
    if (!m) return '';
    const text = stripDecor(m[1]);
    if (text.length < 2 || text.length > STRONG_MAX_LEN) return '';
    if (isRejected(line, text)) return '';
    return text;
}

/**
 * 从尾部往前收集强标记行；返回时已是正序（first / last 是它们在 lines 里的行号）。
 * 强标记自带编号、能自证身份，所以遇到脚手架行**跨过去继续找**（且不占窗口预算）——
 * 选项块后面常压着小标题和分隔线，不跨过去就走不到选项块。撞上第一个真正的正文行才停。
 */
function collectStrong(lines) {
    const found = [];
    let anchor = null;
    let budget = WINDOW_MAX_LINES;
    let skips = 0;                 // 连跨了几行脚手架
    let first = -1, last = -1;

    for (let i = lines.length - 1; i >= 0 && budget > 0; i--) {
        const line = lines[i];
        if (!line.trim()) continue;

        if (skips < SCAFFOLD_RUN_MAX && isScaffold(line)) {
            // 小标题顺手记下来当锚点（离选项最近的优先），它自己不是选项
            if (!anchor && isOptionHeader(line)) anchor = line.trim();
            skips += 1;
            continue;
        }

        budget -= 1;

        const text = matchStrong(line);
        if (text) {
            found.unshift({ text, tier: 'strong', line: i });
            first = i;                       // 往回走，越往后的命中越靠前
            if (last < 0) last = i;
            skips = 0;
            continue;
        }
        // 撞上第一个不是选项的行就停；若它是「选项：」小标题，记下来（它提升置信度，但自己不是选项）
        if (isOptionHeader(line)) anchor = line.trim();
        break;
    }

    return { found, anchor, first, last };
}

/**
 * 裸行选项：一屏短句、行尾不带句末标点。
 * 这是最容易误报的一类，所以条件卡得很死——同段 ≥3 行、每行 ≤24 字、
 * 段的上一行必须是空行或「选项：」小标题（即它确实独立成块，不是正文里的短句）。
 * 与强路径相反：裸行不能自证身份，所以撞上脚手架行是**硬边界**，不是跨过去。
 */
function collectWeak(lines) {
    const found = [];
    let firstIdx = -1;
    let budget = WINDOW_MAX_LINES;

    for (let i = lines.length - 1; i >= 0 && budget > 0; i--) {
        const line = lines[i];
        if (!line.trim()) continue;
        // 脚手架行（分隔线 / 小标题）是块边界，它自己也不该被圈进选项块
        if (isScaffold(line)) break;
        budget -= 1;

        // 行尾判据看的是**还没洗过的那一行**：stripDecor 会把收尾的「。」抹掉，
        // 拿洗过的文本去判句末标点等于这条判据从不生效——正文里一句「夜色沉沉，巷子里只有一盏灯。」
        // 会被当成一条裸行选项（14 字、正是这条判据要拦的那类）。
        const bare = line.trim().replace(/^[-*•·▸→]\s*/, '');
        if (SENTENCE_END_RE.test(bare)) break;

        const text = stripDecor(bare);
        if (text.length < 2 || text.length > WEAK_MAX_LEN) break;
        if (isRejected(line, text)) break;

        found.unshift({ text, tier: 'weak', line: i });
        firstIdx = i;
    }

    if (found.length < 3) return { found: [], first: -1, last: -1 };

    const before = firstIdx > 0 ? lines[firstIdx - 1] : '';
    if (before && before.trim() && !isOptionHeader(before)) return { found: [], first: -1, last: -1 };

    return { found, first: firstIdx, last: found[found.length - 1].line };
}

/**
 * 找出一段正文里的选项块——**只为了给它加个样式**（不做按钮）：
 * 圈出那一块、换个画法，原文一字不改；认不出就整段照原样渲染。
 *
 * 只扫**传进来的这一段**：面板在围栏里，早就被 splitFences 切走、根本到不了这里，
 * 所以「围栏里的编号不算数」是白给的，不需要额外判断。
 *
 * @returns {null | {options:Array<{text:string,tier:'strong'|'weak',line:number}>,
 *   anchor:string, start:number, end:number, tier:'strong'|'weak'}}
 *   start / end 是**行号区间**（含两端）：从紧挨着选项的那个「选择」小标题（没有就从第一条选项）
 *   到最后一条选项。区间里的空行、分隔线都由渲染层照原样处理。
 */
export function findOptionBlock(aiText, { maxOptions = 6 } = {}) {
    const lines = String(aiText ?? '').split('\n');
    if (!lines.some(l => l.trim())) return null;
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();

    let { found, anchor, first, last } = collectStrong(lines);

    // 强标记不足 2 条就不认（一条「选项」多半是误读）→ 退到裸行
    if (found.length < 2) {
        const weak = collectWeak(lines);
        if (weak.found.length >= 3) {
            found = weak.found;
            first = weak.first;
            last = weak.last;
        } else if (found.length < 2) {
            return null;
        }
    }

    // 去重（同一句话只留一条）
    const seen = new Set();
    const options = [];
    for (const opt of found) {
        if (seen.has(opt.text)) continue;
        seen.add(opt.text);
        options.push(opt);
    }

    // 一下冒出八九条，多半是正文列表而不是选项——整体放弃，别硬圈
    if (options.length > 8) return null;

    // 上边界往上吃连续的空行与「选择」小标题（它就是这块的一部分）；
    // 下边界钉在最后一条选项上——选项后面的面板小标题不许圈进来。
    let start = first;
    while (start - 1 >= 0 && (!lines[start - 1].trim() || isOptionHeader(lines[start - 1]))) start -= 1;

    return { options: options.slice(0, maxOptions), anchor, start, end: last, tier: options[0].tier };
}

// ============================================================
// 树导航（全在内存里算，库里只存平铺的节点）
// ============================================================

export function buildIndex(nodes) {
    const byId = new Map();
    const childrenOf = new Map();

    for (const node of nodes || []) {
        if (!node) continue;
        byId.set(node.id, node);
        const key = node.parentId || '';
        if (!childrenOf.has(key)) childrenOf.set(key, []);
        childrenOf.get(key).push(node);
    }

    // 兄弟按 seq 升序——不靠 createdAt，同毫秒会并列
    for (const list of childrenOf.values()) {
        list.sort((a, b) => (a.seq || 0) - (b.seq || 0));
    }

    return { byId, childrenOf, total: byId.size };
}

export function childrenOfNode(index, nodeId) {
    return index.childrenOf.get(nodeId || '') || [];
}

/** 根 → nodeId 的整条路径（含两端）。parentId 走丢时用 rootNodeId 兜底。 */
export function computePath(index, nodeId, rootNodeId) {
    const out = [];
    const guard = new Set();
    let cur = nodeId ? index.byId.get(nodeId) : null;

    while (cur && !guard.has(cur.id)) {
        guard.add(cur.id);
        out.unshift(cur);
        cur = cur.parentId ? index.byId.get(cur.parentId) : null;
    }

    if (!out.length && rootNodeId) {
        const root = index.byId.get(rootNodeId);
        if (root) out.push(root);
    }
    return out;
}

/** 从 nodeId 往下走「最新的一条枝」到末端（每个节点都取 seq 最大的孩子） */
export function findBranchTip(index, nodeId) {
    const guard = new Set();
    let cur = nodeId ? index.byId.get(nodeId) : null;

    while (cur) {
        if (guard.has(cur.id)) return cur;
        guard.add(cur.id);
        const kids = childrenOfNode(index, cur.id);
        if (!kids.length) return cur;
        cur = kids[kids.length - 1];
    }
    return null;
}

/**
 * nodeId 这一座下分出去的所有支线。
 * 每条支线给的是**它的末端**——你要的是「回那条线继续玩」，不是站在岔路口。
 */
export function branchesAt(index, nodeId, { len = 30 } = {}) {
    return childrenOfNode(index, nodeId).map((child, i) => {
        const tip = findBranchTip(index, child.id) || child;
        return {
            index: i + 1,
            first: child,
            tip,
            steps: Math.max(1, (tip.seq || 0) - (child.seq || 0) + 1),
            tail: summarize(tip.aiText, len),
            action: summarize(tip.playerInput, len)
        };
    });
}

/** 压成一行短摘要，给卡片角标/支线列表用 */
export function summarize(text, len = 40) {
    const flat = String(text || '')
        .replace(/[#*`>_~\-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return flat.length > len ? flat.slice(0, len) + '…' : flat;
}

/**
 * 这个节点在它自己那条路径上是第几步（根 = 1）。
 * 这是「第 N 步」的唯一口径——**不是** play.nodeCount（那是全树落库过的节点数，
 * 含所有分叉枝，跳回旧节点也不会减，两者根本不是一回事）。
 * 约定：`stepOf(index, node) === computePath(index, node, root).length`。
 * 链条走丢（parentId 找不到）或成环时，按已经走过的那一段算，不虚构。
 */
export function stepOf(index, nodeId) {
    const guard = new Set();
    let cur = nodeId ? index.byId.get(nodeId) : null;
    let n = 0;

    while (cur && !guard.has(cur.id)) {
        guard.add(cur.id);
        n += 1;
        cur = cur.parentId ? index.byId.get(cur.parentId) : null;
    }
    return n;
}

/** 所有「有孩子」的节点 id —— 目录页只有这些行挂折角 */
export function foldableIds(index) {
    const out = [];
    for (const [key, list] of index.childrenOf) {
        if (key && list.length) out.push(key);
    }
    return out;
}

/**
 * 目录页的默认收起集合：有孩子、但**不在当前这条路径上**。
 * 也就是「你所在的这条线一路铺到底，别的枝只露出第一行」。
 * @param {Set<string>} pathIds 当前路径上的节点 id（computePath 出来的那些）
 */
export function collapsedExceptPath(index, pathIds) {
    const set = new Set();
    for (const id of foldableIds(index)) {
        if (!pathIds.has(id)) set.add(id);
    }
    return set;
}

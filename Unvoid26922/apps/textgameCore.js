// apps/textgameCore.js — 文游的纯逻辑层
//
// **零 import**：不碰 DOM、不碰存储、不发请求。提示词组装 / 选项识别 / 树导航都在这里。
//
// 红线（改这个文件前先读 AI/07）：全链路只出现「主角」「本局」「这一遍游玩」，
// 不出现「用户 / 玩家 / 使用者」。主角的行动由这一遍游玩给出，AI 不替他往前写。
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
    '主角的行动与台词由这一遍游玩给出，你不替他往前写。',
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
    // ⚠️ 这一行的 where **是要显示给用户看的**（剧本页折角卡上那句「装在 …」，见 textgame.js）。
    // 2026-09-20 加了局级风格预设、把它们接在 system 最末尾之后，这块就不是末尾了——
    // 文案必须跟着改，否则界面在说假话。
    { key: 'contract', label: '输出约定', where: 'system 末尾（风格预设排它后面）', fallback: DEFAULT_OUTPUT_CONTRACT }
];

// ============================================================
// 局级风格预设（模块级一个库 = 一份份预设，每份里一串条目）
// ============================================================
//
//  库 presets → 预设 pack `{ id, name, entries }` → 条目 entry `{ id, name, text, where }`
//
// **一局选一份预设**（play.presetPackId，null = 不选），局内的 ⋯ 菜单只决定这份预设里的
// 条目这一局**开不开**（play.presetIds）。所以「发什么」两个条件都得满足：这一局选了这份预设，
// 且这条在 presetIds 里。
//
// 一条条目 = `{ id, name, text, where }`。**名字只给人看，绝不进提示词**——发出去的只有 text。
// where 两个取值：'system' 接在 system 最末尾；'current' 附在末尾那条 user 里、主角行动之前。
// 位置是**条目自己的属性**（在风格预设页里定），不是勾选时现选的。
//
// **顺序 = 条目在这份预设里的先后**（不是勾选列表的顺序）。用户口径：A 在上 B 在下 ⇒ 先 A 后 B。
// 于是「取消再勾会不会丢位置」这个问题不存在——位置从来不在勾选那边。

/** 两条位置。label 直接拿来当预设页与 ⋯ 菜单的分区标题（同 PROMPT_BLOCKS 的 where 那个用法） */
export const PRESET_WHERE = [
    { key: 'system', label: 'system 末尾' },
    { key: 'current', label: '当前消息附带' }
];

/** 缺省位置。认不出的值（老记录、手改坏了的）一律当 system 算，不让它两边都不沾地消失 */
export const DEFAULT_PRESET_WHERE = 'system';

/** 一条条目到底装在哪儿。**枚举的唯一权威就是上面的 PRESET_WHERE**（store 只保证 where 是个字符串） */
export function presetWhereOf(entry) {
    const key = String(entry?.where || '');
    return PRESET_WHERE.some(w => w.key === key) ? key : DEFAULT_PRESET_WHERE;
}

/**
 * 内置那一份预设。**不进数据库**（同 miniGamesLib 的 SAMPLE_COMPONENTS）：它是代码里的常量，
 * 用户改了就存一份**覆盖记录**（id 也是 'builtin'），解析时按 id 合并——所以**没改过的条目
 * 永远跟着模块当前的文案走**，自动种子进库会立刻产生一份副本、从此和这里脱钩。
 *
 * 库里真的存下了 'builtin' 那份记录时，它的条目字段**空 = 没改过**（见 resolvePackEntries）。
 *
 * ⚠️ 这几段是**模块自己写的文案**，所以：
 *   ① 不出现「用户 / 玩家 / 使用者」（模块的用语一律是「主角 / 本局 / 这一局」）；
 *   ② 不加【】小标题——用事实陈述，不点名禁止（同 DEFAULT_FRAME_PROMPT 上面那段注释的道理）。
 * 这两条对内置清单**逐条**适用，没有例外。
 */
export const BUILTIN_PACK = {
    id: 'builtin',
    name: '样板预设',
    entries: [
        {
            id: 'builtin_cold',
            name: '冷叙事',
            where: 'system',
            text: '文风换成冷硬的短句：一句一件事，不堆形容词，不写心理独白。人物用动作、对白和看得见的细节表态，情绪留给读的人自己判断。'
        },
        {
            id: 'builtin_rich',
            name: '氛围铺陈',
            where: 'system',
            text: '这一局的描写密度拉满：环境、气味、声音、光线、身体感受都写到。节奏可以慢，允许为一处场景停一段，但每一笔都要落在具体的东西上，不空转。'
        },
        {
            id: 'builtin_classic',
            name: '章回体',
            where: 'system',
            text: '行文用半文半白的旧小说腔：短句多、对句多，少用现代口语词。每节开头先给一行对偶的小标题，再起正文。'
        },
        {
            id: 'builtin_fast',
            name: '快节奏',
            where: 'system',
            text: '这一局节奏要快：正文控制在四百字以内，每一段推进一件事，不复述已知信息，不做长篇铺陈。镜头始终跟着正在发生的事。'
        },
        {
            id: 'builtin_lens',
            name: '换个镜头',
            where: 'current',
            text: '这一轮的切入点换一换：先从一处此前没写过的环境细节起笔，再回到主角眼前正在发生的事。'
        },
        {
            id: 'builtin_twist',
            name: '加点意外',
            where: 'current',
            text: '这一轮让一件事出乎主角的预料。意外要从已经写出来的线索里长出来，不能凭空塞一个新设定。'
        }
    ]
};

/** 内置那几条按 id 查（合并覆盖层用） */
const BUILTIN_ENTRY_BY_ID = new Map(BUILTIN_PACK.entries.map(e => [e.id, e]));

/** 这一条是不是内置自带的那 6 条之一。**内置条目不给删**（想删就整份复制一份到自己的预设里删） */
export function isBuiltinEntryId(entryId) {
    return BUILTIN_ENTRY_BY_ID.has(String(entryId || ''));
}

/**
 * 一份预设「当前该用哪些条目」——存下来的是覆盖层，这里把它合回完整的一份。
 *
 * 两条规则：
 *   ① 内置条目**空字段 = 没改过** ⇒ 补回内置那份的值（name / text / where 各算各的）。
 *      于是模块以后改进内置文案，没动过的字段还跟得上（同两块提示词的「存空 = 从没动过」）。
 *   ② 内置那 6 条**永远在**——记录里漏了（手改坏的、老版本存的）也按内置的顺序补回来。
 *      「删不掉」是结构上的，不靠界面自觉。
 *
 * 条目重名 / 没 id 的一律丢掉（store 已经消毒过一遍，这里再兜一道：这份表直接进提示词）。
 */
export function resolvePackEntries(pack) {
    const builtin = String(pack?.id || '') === BUILTIN_PACK.id;
    const stored = Array.isArray(pack?.entries) ? pack.entries : [];
    const out = [];
    const seen = new Set();
    for (const raw of stored) {
        const id = String(raw?.id || '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const base = builtin ? BUILTIN_ENTRY_BY_ID.get(id) : null;
        out.push(base
            ? {
                id,
                name: String(raw.name || '') || base.name,
                text: String(raw.text || '') || base.text,
                where: String(raw.where || '') || base.where
            }
            : {
                id,
                name: String(raw?.name || ''),
                text: String(raw?.text || ''),
                where: String(raw?.where || '')
            });
    }
    if (builtin) {
        for (const e of BUILTIN_PACK.entries) if (!seen.has(e.id)) out.push({ ...e });
    }
    return out;
}

/**
 * 一个条目**折回覆盖层**：跟内置那份逐字相同的字段存成空（= 没改过）。
 * 自己加的条目（id 不认内置）整条存。
 * 写入内置那份预设时走这一道，读的时候由 resolvePackEntries 补回来——**来回无损**。
 */
export function packEntryPatch(entry) {
    const base = BUILTIN_ENTRY_BY_ID.get(String(entry?.id || ''));
    if (!base) {
        return {
            id: String(entry?.id || ''),
            name: String(entry?.name || ''),
            text: String(entry?.text || ''),
            where: String(entry?.where || '')
        };
    }
    return {
        id: base.id,
        name: entry.name === base.name ? '' : String(entry.name || ''),
        text: entry.text === base.text ? '' : String(entry.text || ''),
        where: presetWhereOf(entry) === presetWhereOf(base) ? '' : presetWhereOf(entry)
    };
}

/**
 * 这一局选的是哪一份预设。没选 / 老记录 → null（**零迁移**，读侧兜底）。
 */
export function presetPackIdOf(play) {
    const raw = play?.presetPackId;
    return typeof raw === 'string' && raw ? raw : null;
}

/**
 * 这一局开着这份预设里的哪几条。非数组（老记录没有这个字段）给 []——**零迁移**，读侧兜底。
 * 元素只当字符串看，空的一律丢掉。
 */
export function presetIdsOf(play) {
    const raw = play?.presetIds;
    if (!Array.isArray(raw)) return [];
    return raw.filter(id => typeof id === 'string' && id);
}

/**
 * 「每份预设各自被手调成什么样」的记忆：`{预设 id → 该份里开着的条目 id}`。
 * 只在 ⋯ 菜单里手动勾/取消条目时才写（`togglePreset`），读它的只有下面那个
 * `presetIdsForPack`——**不参与拼提示词**。脏值（非对象 / 值不是数组 / 空 id）一律丢掉。
 */
export function presetPicksOf(play) {
    const raw = play?.presetPicks;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [packId, ids] of Object.entries(raw)) {
        if (!packId || !Array.isArray(ids)) continue;
        out[packId] = ids.filter(id => typeof id === 'string' && id);
    }
    return out;
}

/**
 * 重新选某份预设时，这一局该开着哪几条。三条规矩：
 *   ① 这份**从没被手调过**（记忆里没有它）⇒ 全开——「换到这套方案」的本意；
 *   ② 手调过 ⇒ 恢复成记忆里那样（**包括「一条都没勾」，那是你要离开时的样子**）；
 *   ③ 记忆里的条目已被删光/改 id ⇒ 当没记忆，回到全开（缺口不是事实）。
 * 返回的 id 就是库里此刻真实存在的那些，顺序按库顺序（拼提示词那边本来就按库顺序）。
 */
export function presetIdsForPack(pack, play) {
    const all = (pack?.entries || []).map(e => e.id);
    const mem = presetPicksOf(play)[String(pack?.id || '')];
    if (!Array.isArray(mem)) return all;
    const live = new Set(all);
    const kept = mem.filter(id => live.has(id));
    return (kept.length || !mem.length) ? kept : all;
}

/** 导入时没名没姓的那一份叫什么（正文里没 `#` 标题、输入框也空着） */
const IMPORTED_PACK_NAME = '导入的预设';

/**
 * 一行去掉标记后是不是「位置标签」那一行。返回位置 key，不是就返回 null。
 *
 * **要求精确**（去掉空白、忽略大小写后 === 标签或 === key）。刻意不认「包含」：那样
 * 「当前消息附带说明」这种条目名会被吞成位置行，后果是这行下面的正文**悄悄并进上一条**——
 * 相比「给一条起个怪名字」（用户一眼看得见、改一下就好），那个坏得多。
 * 给 AI 的那段说明里因此写死了：位置行照抄标签本身。
 */
function whereKeyOfLine(label) {
    const key = String(label || '').replace(/[\s　]/g, '').toLowerCase();
    if (!key) return null;
    for (const w of PRESET_WHERE) {
        if (key === w.label.replace(/[\s　]/g, '').toLowerCase() || key === w.key) return w.key;
    }
    return null;
}

/**
 * 外部 AI 的整段文本 → 一份预设。用户口径：「解析大概就是一个预设标题、预设条目名字、
 * 预设条目内容；**如果有分好位置那就解析，没有的话就默认顺序排**」。
 *
 * 标记只有两级（`#` 标题 / `##` 条目名），**正文就是正文**——不用转义、不用缩进，
 * 段间空行原样留着。这是它跟 JSON 的分工：正文是大段中文提示词，JSON 里每个换行都得写成
 * `\n`、引号要转义，外部 AI 写长正文时几乎必坏，人也没法手改。
 * 配套的那段说明（PRESET_AI_PROMPT）就住在本文件里——**格式改了它跑不掉**。
 *
 * 位置（可选）：某一行去掉标记后正好是位置标签（也认 system / current）⇒ 从这儿往后换位置。
 * 没有这种行 ⇒ 全在 DEFAULT_PRESET_WHERE、按文本先后排。
 *
 * **不带 id**：id 由调用方现生成（同 copyPack）。返回的 entries 就是库里那个形状。
 * `skipped` = 被丢掉的非空行数（条目之前的客套话、光秃秃的一行 `##`）——
 * 报给用户看的，不静默。`truncated` = 超长条数（store 的消毒层会截断，这里先量出来）。
 */
export function parsePresetText(text, fallbackName = '', { maxTextLength = 0 } = {}) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const entries = [];
    const pre = [];              // 第一个条目标记之前的非标记行：要么是客套话，要么是唯一的正文
    let title = '';
    let hasTitle = false;
    let where = DEFAULT_PRESET_WHERE;
    let current = null;          // 正在收正文的那一条
    let body = [];
    let skipped = 0;

    const flush = () => {
        if (!current) return;
        const content = body.join('\n').trim();
        body = [];
        const entry = current;
        current = null;
        if (!entry.name && !content) { skipped += 1; return; }   // 光秃秃的一行 `##`
        entries.push({ name: entry.name, text: content, where: entry.where });
    };

    for (const rawLine of lines) {
        // 全角井号当半角（只在行首：正文里出现的 ＃ 是字）
        const line = rawLine.replace(/^[＃#]+/, m => '#'.repeat(m.length));
        const marker = /^(#+)[ \t　]*(.*)$/.exec(line);
        if (!marker) {
            (current ? body : pre).push(rawLine);
            continue;
        }
        const label = marker[2].trim();
        // **第一个**标记行、且只有一个井号 ⇒ 预设标题（后面再出现的一级标题一律当条目）
        if (!hasTitle && !current && !entries.length && marker[1].length === 1) {
            hasTitle = true;
            title = label;
            continue;
        }
        const key = whereKeyOfLine(label);
        if (key) { flush(); where = key; continue; }             // 位置行：不落条目，也不算跳过
        flush();
        current = { name: label, where };
    }
    flush();

    if (entries.length) {
        // 有正经条目 ⇒ 那些提前出现的行是客套话（AI 的开场白），不进任何一条的正文
        skipped += pre.filter(l => l.trim()).length;
    } else {
        // 一个条目标记都没有 ⇒ 整段当一条（用户自己进预设页去分），名字取正文首行
        const content = pre.join('\n').trim();
        if (content) {
            const firstLine = content.split('\n').find(l => l.trim()) || content;
            entries.push({ name: summarize(firstLine, 24), text: content, where });
        } else {
            skipped += pre.filter(l => l.trim()).length;
        }
    }

    return {
        name: String(fallbackName || '').trim() || title || IMPORTED_PACK_NAME,
        entries,
        skipped,
        truncated: maxTextLength > 0 ? entries.filter(e => e.text.length > maxTextLength).length : 0
    };
}

/**
 * 给外部 AI 的那段说明（预设页底部折角里，可以改完再复制走）。
 * ⚠️ 它描述的就是上面那个解析器认的格式，两样东西**必须一起改**。
 * 措辞沿用模块既有口径：用事实陈述写要求，不写「你是一位……」那类角色扮演口径。
 */
export const PRESET_AI_PROMPT = `请帮我给一个文字冒险游戏写一套「风格预设」。

【这是什么】
一份预设 = 一组条目。每条是一段会原样拼进 AI 提示词的话，用来管文风、篇幅节奏、
排版格式，或者要求每一轮输出一个状态栏。条目默认常驻：装在系统提示词的末尾。

【只按下面这个形状输出，不要别的解释、不要开场白】
# 预设名

## 条目名
这一条的正文。多少段都行，换行照常敲，不用转义、不用缩进。
第一段写完了可以接着写第二段。

## 另一条
正文……

【想让某几条只影响当前这一轮】
在它们前面单独加一行 ## 当前消息附带；想切回常驻，用 ## system 末尾。

【三条硬要求】
1. 正文里不要出现以 # 开头的行（那会被当成新的一条）。
2. 一条只写一件事，条数别太多。
3. 用事实陈述写要求，不要写「你是一位……」这类角色扮演的口径。

【我要的这套预设】
（在这里写需求：题材、文风、篇幅、要不要状态栏、状态栏长什么样……）`;

/**
 * 「这一局开的条目 + 这一局的预设」→ 这一次真发出去的那几段字。
 *
 * **顺序取条目在预设里的先后，不是 ids 的顺序**（用户口径：A 在上 B 在下 ⇒ 先 A 后 B）。
 * 预设为 null（这一局没选）⇒ 空数组 ⇒ 一个字都不加，提示词逐字节与加这个功能之前相同。
 *
 * 两件静静跳过的事：预设里没有的 id（那条被删了）、全空白的 text。
 * 不报错、不补占位——同 werewolfRooms 的 tableRulesText「find 不到就跳过」，
 * 也同主角引用那条「读不到就整截不写，缺口不是事实」。
 */
export function resolvePresetTexts(ids, pack = null, where = DEFAULT_PRESET_WHERE) {
    if (!pack) return [];
    const picked = new Set(Array.isArray(ids) ? ids : []);
    return resolvePackEntries(pack)
        .filter(e => picked.has(e.id) && presetWhereOf(e) === where)
        .map(e => String(e.text || '').trim())
        .filter(Boolean);
}

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

/**
 * 历史窗的默认预算。**实际值由调用方从默认预设的 `maxContextChars` 现读**
 * （`textgameAI.contextBudget`），这里只是读不到预设时的回落值——与设置页那个框的默认值对齐。
 * 注意口径：这个数是**总上下文**（system 含剧本原文 + 历史一起算），不像常规模块那样只量注入内容。
 */
export const DEFAULT_MAX_CONTEXT_CHARS = 40000;

/** 一轮在 messages 里长这样（开场那一轮没有主角行动） */
function turnMessages(node) {
    const out = [];
    // 主角行动**裸发**：role 已经说明这是谁说的，不用再加「主角行动：」这类前缀。
    // 开场那一轮没有行动，user 侧给个「（开场）」占位——两条 user 连着虽然合法，
    // 但读起来莫名其妙，而开场本来就占着路径的第一个位置。
    out.push({ role: 'user', content: String(node.playerInput || '').trim() || '（开场）' });
    // 旁白为空就不发那一条 assistant：宁可两条 user 连着，也不编一句假旁白（同「绝不虚构」）
    const narration = String(node.aiText || '');
    if (narration) out.push({ role: 'assistant', content: narration });
    return out;
}

/**
 * 把「根 → 当前节点」这条路径摊成 messages 的历史段（**不含**末尾那条当前轮，见 buildTurnPrompt）。
 *
 * **只摊这一条路径**：分叉出去的另一条支线，AI 看不到——这是特性不是 bug，
 * 重走一遍就该是重走一遍。
 *
 * 超预算时的降级只有一档、确定性的、绝不虚构：**从最旧一头丢整轮**。
 * **开场（index 0）与当前轮的父节点（index last）永不丢**——预算紧到连这两个都放不下时
 * 就停在那一档（宁可超出，也不把开场吞掉）。保底是这两个守卫本身给的，不需要额外的常量。
 *
 * @returns {{messages:Array<{role:string,content:string}>, droppedTurns:number}}
 */
export function pathToMessages(pathNodes, { maxContextChars = DEFAULT_MAX_CONTEXT_CHARS } = {}) {
    const list = (Array.isArray(pathNodes) ? pathNodes : []).filter(Boolean);
    if (!list.length) return { messages: [], droppedTurns: 0 };

    const turns = list.map(turnMessages);
    const costs = turns.map(ms => ms.reduce((sum, m) => sum + m.content.length + 1, 0));
    let total = costs.reduce((sum, c) => sum + c, 0);

    const last = list.length - 1;
    let from = 1;                       // 开场（index 0）永不丢 ⇒ 从 1 起丢
    while (total > maxContextChars && from < last) {
        total -= costs[from];
        from += 1;
    }
    const droppedTurns = from - 1;

    const kept = [turns[0], ...turns.slice(from)];
    if (droppedTurns > 0) {
        // 开场护着 ⇒ 上下文里会出现「开场 → 第 12 步」这种断口，得让模型知道中间有缺口。
        // 挂在**第一条保留的行动**上（不是开场那条）：那句是真话，不是虚构的内容。
        kept[1][0].content = `（此处略去 ${droppedTurns} 步）\n\n${kept[1][0].content}`;
    }

    return { messages: kept.flat(), droppedTurns };
}

/**
 * 组装这一轮的完整 messages。
 *
 * 形状（与市面常规一致）：**system 恒定一块，其后一轮一对 user/assistant**。
 * 末尾那条 user 装的就是「这一轮要生成什么」：本局块（若有）+ 这一步的行动——
 * 行动**裸发**，模块不给自己加标题（唯一的例外是开场那一句，见下）。
 * 本局块只挂在末尾那一条上，历史轮一律裸行动（见 pathToMessages）。
 *
 * ⚠️ **system 里绝不放主角名、轮数、时间等每局变量**——字节恒定才能命中
 * DeepSeek 的 prefix 缓存（同一剧本的每一局、每一轮 system 完全相同），省 token 也降延迟。
 * 每局变量全进末尾那条 user。
 *
 * @param {object} input
 * @param {string} input.scriptText 剧本原文（原样，不加工）
 * @param {{name:string, note:string}} input.protagonist 这一局抄下来的抬头（模块自己的数据）
 * @param {{detail?:string, secret?:string}} [input.protagonistRef] 引用来的那两截——**调用方每轮现读**，读不到传空
 * @param {Array} [input.pathNodes] 根 → 当前节点（含当前节点）——**不含**还没生成的那一步
 * @param {string} [input.playerInput] 这一步的行动；开场模式传空
 * @param {'open'|'advance'} input.mode
 * @param {number} [input.maxContextChars] **总上下文**预算（含 system），见 pathToMessages
 * @param {object} [input.prompts] **剧本级**的两块（开关 + 文字），见 normalizePrompts
 * @param {string[]} [input.presetIds] **这一局**这份预设里开着的那几条（只存 id，见 presetIdsOf）
 * @param {object} [input.presetPack] **这一局**选的那份风格预设（null = 这一局没选 ⇒ 一个字都不加）。
 *        顺序取**条目在这份预设里的先后**，不是 presetIds 的顺序——用户在预设页里排的就是注入顺序。
 */
export function buildTurnPrompt({
    scriptText = '',
    protagonist = {},
    protagonistRef = {},
    pathNodes = [],
    playerInput = '',
    mode = 'advance',
    maxContextChars = DEFAULT_MAX_CONTEXT_CHARS,
    prompts = null,
    presetIds = [],
    presetPack = null
} = {}) {
    // 拼装顺序就是优先级：谁在前面谁先被读到，谁在最后谁吃掉剩余注意力。
    // 两块各自独立——关掉一块只是少一段，另一段的位置和内容都不动。
    //
    // 剧本原文**裸发、不加标题**（曾经前面挂着一行「【剧本原文】」，2026-09-20 去掉）：
    // 它本来就在 system 槽里，位置本身就说明「这是背景设定，不是要你接着写的正文」；
    // 「叙事引擎」那一块的下一句「剧本原文随后，它是本次游玩的最高权威」也在指路——
    // 再加一行小标题是同一件事说两遍。而**两块都关**时尤其碍事：那一档要的就是
    // 「system 里除了剧本一个字不多」，挂个标题就不是了。
    //
    // 这一局选的风格预设里、**开着**的那几条（where='system'）接在**最末尾**：最后读到的说了算，
    // 而它们要的正是「换一种写法」——压过输出约定里那套篇幅与格式，是有意的。
    // 没选预设（presetPack = null）⇒ 一条都不发 ⇒ 逐字节等于没有这个功能。
    // ⚠️ frame + 剧本原文这段前缀因此**逐字节不变**，DeepSeek 的 prefix 缓存照样命中。
    const p = normalizePrompts(prompts);
    const systemPrompt = [
        resolvePromptBlock(p.frame, DEFAULT_FRAME_PROMPT),
        scriptText,
        resolvePromptBlock(p.contract, DEFAULT_OUTPUT_CONTRACT),
        resolvePresetTexts(presetIds, presetPack, 'system').join('\n\n')
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

    const protagonistBlock = [...head, ...ref].join('\n');

    // 当前这一轮（末尾那条 user）：本局块**只挂在这里**——历史轮一律裸行动，
    // 每轮现读的那两截只在离生成点最近的位置出现一份（省 token，也省缓存）。
    //
    // 模块自己**一句话都不加**（2026-09-20 简化，删掉了原来那行「【此刻】主角行动：…」）：
    // 历史轮已经长成「裸行动 → 旁白」，这一轮照同一个形状发出去，role 与顺序
    // （最后一条 user 后面没有 assistant）就把「轮到你了」说清楚了——
    // 贴进任何 chatbox 也不会有人在行动前面先写一行「此刻」。
    // **唯一例外是开场**：那一轮 user 里没有行动可发，得有一句话说明要它写什么。
    // 本局块与行动之间用一个空行隔开（本局块每行自带「主角…」标签，读不混）。
    //
    // where='current' 那几条预设接在**行动之前**：行动仍是这条 user 的最后一句，
    // 模型要接着写的就是它；预设跟本局块做邻居，两块都是「本轮的背景与要求」。
    // （想改成压住行动，就是把下面那两行的先后换一下，一行的事。）
    const current = [];
    if (protagonistBlock) current.push(protagonistBlock);
    current.push(...resolvePresetTexts(presetIds, presetPack, 'current'));
    current.push(mode === 'open'
        ? '故事还没开始。请按剧本设定输出开场。'
        // 续写模式本来轮不到这一支（调用方拦着空输入）；真空了也别发一条空 content 出去
        : (String(playerInput || '').trim() || '（没有写行动）'));

    // 预算**整体吃到**：system（剧本原文是大头）先扣掉，剩下的才是历史窗。
    // 扣成负数也不怕——pathToMessages 的守卫保证开场与末轮留在那儿。
    const history = pathToMessages(mode === 'open' ? [] : pathNodes, {
        maxContextChars: maxContextChars - systemPrompt.length
    });

    const messages = [
        { role: 'system', content: systemPrompt },
        ...history.messages,
        { role: 'user', content: current.join('\n\n') }
    ];

    return {
        messages,
        meta: {
            estChars: messages.reduce((sum, m) => sum + m.content.length, 0),
            droppedTurns: history.droppedTurns
        }
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
// ⚠️ 「丢换行」不是认错形态才有的代价：**认对了也丢**——标签里的文字靠裸换行分段时，
// HTML 会把换行折成空格。这条路由 wrapRawRuns 兜（在下文「普通模式」那节，跟 htmlToText 挨着）。

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

// 自由模式的沙箱要靠它认出「标签之外」的那截文字（见 wrapRawRuns）。
// 原文区里是**字面文本**（`<pre>` 里的缩进、`<style>` 里的 CSS、`<textarea>` 里的字），
// 往里插标签会把它们自己弄坏 ⇒ 整块照原样过。
const RAW_TEXT = `(script|style|head|pre|textarea)\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`;
// ⚠️ 分支顺序不能换：注释与原文区都得排在普通标签前面——`<script>` 先被当普通标签吃掉的话，
// 它里面那截字就露在「标签外」了，正是要避免的事。
const RAW_SCAN_RE = new RegExp(`<!--[\\s\\S]*?-->|<${RAW_TEXT}|<${TAG_BODY}>`, 'gi');

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

/**
 * 自由模式的沙箱里，把**标签外那些靠裸换行分段的文字**圈回来（渲染层拼 srcdoc 之前调用，
 * 见 apps/textgame.js 的 freeHtml；沙箱样式里 `pre-wrap` 只发给 `.tg-raw`）。
 *
 * 为什么需要：HTML 的规矩是「连续空白折成一个空格」，而剧本的 AI 极爱把正文写成这样——
 *     <div class="panel">📍 场景：…</div>
 *     <div>她把手收回袖中。
 *     “你不必急着回答。”
 *     雨声低下去。</div>
 * 也就是**标签里的文字靠裸换行分段**。整节进沙箱之后那些换行被折掉、正文挤成一坨；
 * 而普通模式走的是 htmlToText（块级标签当断行、文字原样留），同一份字看着是对的——
 * 于是同一个节点「普通模式分段正常、自由模式一坨」（用户 2026-09-21 报的那个）。
 *
 * 做法：只给「含换行的文字段」包一层 `<span class="tg-raw">`，顺手清掉每行的首尾空格
 * （那是模型的 HTML 缩进，不是正文），别的**一个字都不动**：
 *   - 不含换行的文字段：原样（它本来就照原样显示，连空格也照旧）
 *   - 纯空白的排版换行：折成一个空格（行内元素之间那道缝还靠它）
 *   - 注释 / 原文区（`<pre>` / `<style>` / `<textarea>` / `<script>`）：整块不碰
 * 只认形态、不解释 DOM——和这个模块其它判断同一个立场：认错了的代价只是排版难看一点。
 */
export function wrapRawRuns(html) {
    const src = String(html ?? '');
    if (!src.includes('\n')) return src;        // 一个换行都没有 ⇒ 没什么可救的，原样返回
    const out = [];
    const pushRun = t => {
        if (!t.includes('\n')) { out.push(t); return; }
        const run = t.trim().replace(/[ \t]*\n[ \t]*/g, '\n');
        out.push(run ? `<span class="tg-raw">${run}</span>` : ' ');
    };
    let last = 0;
    let m;
    RAW_SCAN_RE.lastIndex = 0;
    while ((m = RAW_SCAN_RE.exec(src))) {
        pushRun(src.slice(last, m.index));
        out.push(m[0]);                          // 标签与原文区整块照旧
        last = m.index + m[0].length;
    }
    pushRun(src.slice(last));
    return out.join('');
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
 * 自足的纯函数（零 import）：返回顺序就是原文顺序，
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

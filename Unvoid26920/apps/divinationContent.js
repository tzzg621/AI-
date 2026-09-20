// apps/divinationContent.js — 占卜屋内容库
// 纯数据 + 纯字符串组合函数：不碰 DOM、不读存储、无 I/O。
// 文案全部在实现期创作。历史记录 payload 只存引用键（签 stickId；塔罗牌
// cardNo/orientation/posKey），回看/列表正文经本文件现查——本文件即正文唯一本体，
// 文案迭代历史同步生效（修订优先）。副本最小化是本模块默认取向（2026-09-05 拍板），
// 非铁律：个别场景确需少量副本/快照时说明理由即可。
// 文案红线自查（已过）：无「用户/使用者」主语；下下签真实存在（2/18）且解读诚恳不扭转；
//   逆位写作是阻滞/内省/反向能量，非「正位反面否定」；无绝对判词（如「你会死」）；
//   advice 给具体可行动向，不空泛。
// v1.1（2026-09-05）AI 细解已落地：塔罗解读尾部可请「占卜师」做模型细解
//   （占卜屋 → AI 任务中心，产物落 payload.ai；签筒保持纯本地不细解）。
//   占卜师 = 风格注册表（见文末 DIVINER_STYLES，现仅「星语者」star-speaker）：
//   加新占卜师 = 注册表加条目，名片/署名等渲染由条目字段驱动，无其他改动点。
//   扩展位：① 更多风格（签婆/先知/名册角色担当…）；② v2 角色上下文注入——届时用
//   buildDivinerSystemPrompt 的 ctx 参数位（当前恒 {}：骨架版零角色上下文；若接入，
//   内容必须经 store 层只读 + 按可见度过滤，见 AI/07）。AI 全流程模式（翻牌即评语）
//   仍搁置，待全局 AI 入口功能再议。

// ============================================================
// 大阿卡纳 22 张（含正位/逆位）
// ============================================================

export const MAJOR_ARCANA = [
    { no: 0, name: '愚者', upright: { meaning: '启程的牌。带着赤诚走向未知，不设防的日子反而处处是路。', advice: '挑一件犹豫已久的小事，今天就出发。' }, reversed: { meaning: '莽撞与踌躇同在一身：想跳又怕深。先看清脚下，再决定要不要跳。', advice: '停一步，问清代价再迈步。' } },
    { no: 1, name: '魔术师', upright: { meaning: '手中工具齐全，愿望与行动只差一握。你比你以为的更有办法。', advice: '把散落的点子收拢成一张清单，逐一落手。' }, reversed: { meaning: '手段在空转，话术盖过了实事。检查哪一步只是表演。', advice: '减少承诺，把一件小事做完做透。' } },
    { no: 2, name: '女祭司', upright: { meaning: '答案藏在安静里。不必急着说破，先听自己心底的声音。', advice: '留一段不被打扰的时间，独自想清楚。' }, reversed: { meaning: '直觉被杂音盖住，或对沉默感到焦躁。向外问之前，先向内收。', advice: '写下最近困扰你的事，逐条看过再决定。' } },
    { no: 3, name: '皇后', upright: { meaning: '丰盛在生长。照料身边的人与事，会得到成倍的回报。', advice: '给牵挂的人捎一句实实在在的关心。' }, reversed: { meaning: '付出过了头，滋养变成了消耗。学会先照顾好自己。', advice: '划出今天只属于自己的半个时辰。' } },
    { no: 4, name: '皇帝', upright: { meaning: '秩序与担责的时刻。稳住阵脚，规则会替你挡住乱流。', advice: '把最乱的一件事定出章程。' }, reversed: { meaning: '控制太紧或权威松动，硬撑不如重新立规。', advice: '听听不同的声音，再作决定不迟。' } },
    { no: 5, name: '教皇', upright: { meaning: '有人值得你请教，旧经验里藏着钥匙。寻一位可信者同行。', advice: '带着具体问题去问一位前辈。' }, reversed: { meaning: '教条让你缩手缩脚，或权威并不如想象可靠。', advice: '打破惯例试试，按自己的章程走一小步。' } },
    { no: 6, name: '恋人', upright: { meaning: '心之所向与选择同来。坦诚会带来真正的靠近。', advice: '把没说出口的话，挑个合适的时机说出来。' }, reversed: { meaning: '摇摆与错位——选择的重量压得人喘不过气。', advice: '分清是舍不得，还是真的想要。' } },
    { no: 7, name: '战车', upright: { meaning: '意志驱动车轮。方向既定，就只管握紧缰绳向前。', advice: '定一个截止日，逼自己走完首程。' }, reversed: { meaning: '方向在打架，用力过猛反而原地打转。先停下校准。', advice: '把目标写小一点，先赢下一场。' } },
    { no: 8, name: '力量', upright: { meaning: '温柔比蛮力走得更远。耐心顺毛，烈马也会低头。', advice: '对难缠的人与事，换一副软语气。' }, reversed: { meaning: '底气不足或强撑门面，越急越漏气。退半步蓄力。', advice: '承认一次做不到，比硬撑更省力。' } },
    { no: 9, name: '隐者', upright: { meaning: '独处的灯最亮。暂时离席，答案会在安静处浮现。', advice: '关掉喧闹，给自己一个完整的独处夜。' }, reversed: { meaning: '离群太久，或躲避而非沉淀。点灯也要记得出门。', advice: '挑一位朋友，把心里的话倒一倒。' } },
    { no: 10, name: '命运之轮', upright: { meaning: '转机正在到来。顺流而上，别在变化前死守旧位置。', advice: '对突如其来的机会说「好」。' }, reversed: { meaning: '周期低谷，或强留已走之物。转轮不会停，人要学会换手。', advice: '先放手一件留不住的事。' } },
    { no: 11, name: '正义', upright: { meaning: '因果自会归位。坦荡行事，天平会偏向讲理的一方。', advice: '就事论事，把账算清楚再谈情分。' }, reversed: { meaning: '失衡或偏私浮现，回避只会让账越欠越多。', advice: '补上一句迟到的道歉或说明。' } },
    { no: 12, name: '倒吊人', upright: { meaning: '换一副眼光，困局即成观景台。暂时悬置不是失败。', advice: '把问题倒过来想一遍，答案常在背面。' }, reversed: { meaning: '无谓的牺牲或僵持，吊着不动不等于想通。', advice: '主动结束一场没有收益的等待。' } },
    { no: 13, name: '死神', upright: { meaning: '一段旧章节正在收尾。让该走的走，新的才进得来。', advice: '亲手了结一件拖了太久的事。' }, reversed: { meaning: '抗拒结束只会拖长疼痛。告别虽难，松手比死攥有尊严。', advice: '给自己一个正式的告别仪式。' } },
    { no: 14, name: '节制', upright: { meaning: '调和与分寸。不疾不徐，水火也能同炉。', advice: '把日程减半，把耐心加倍。' }, reversed: { meaning: '失衡的信号：不是过满就是过空。找回中间地带。', advice: '停掉一件让你疲惫成瘾的事。' } },
    { no: 15, name: '恶魔', upright: { meaning: '看清让你上瘾的锁链——束缚多半是自己递过去的。', advice: '找出最消耗你的一项习惯，今天减半。' }, reversed: { meaning: '挣脱正在进行。承认被缚，是松绑的第一步。', advice: '向信任的人说出你正在戒断什么。' } },
    { no: 16, name: '高塔', upright: { meaning: '猝然的崩塌反而清出了地基。旧结构碎了，未必是坏事。', advice: '不急着重建，先捡有用的砖。' }, reversed: { meaning: '危机还在酝酿，或一直被强压下去。早处理小裂缝，别等大响动。', advice: '主动拆掉一个明知有隐患的旧安排。' } },
    { no: 17, name: '星星', upright: { meaning: '光虽远而确定。走夜路的人，认准一颗星就够。', advice: '许一个具体的愿，并写下第一步。' }, reversed: { meaning: '失望让你怀疑光亮。星没灭，只是云厚。', advice: '降低今天的预期，保住那一点微光。' } },
    { no: 18, name: '月亮', upright: { meaning: '真相在水面下晃动。看不清时，别急着下结论。', advice: '重要的话留到天亮再说。' }, reversed: { meaning: '迷雾将散，虚惊一场或误会澄清。再核对一次消息来源。', advice: '把猜疑换成一次直接询问。' } },
    { no: 19, name: '太阳', upright: { meaning: '明晃晃的好日子。坦荡、温热、被看见。', advice: '把快乐分出去，笑是会传染的。' }, reversed: { meaning: '光被遮了一角，或得意过了头。拨云见日，只需一点耐心。', advice: '给过热的事降降温，隔日再看。' } },
    { no: 20, name: '审判', upright: { meaning: '回声响起，旧事有了结清的时刻。该面对的跑不掉。', advice: '回应一件搁置已久的呼唤。' }, reversed: { meaning: '自我审判过重，或迟迟不给自己答复。宽恕自己一次。', advice: '把「我本可以」换成「下一次我」。' } },
    { no: 21, name: '世界', upright: { meaning: '圆满收束了此段旅程。你已完成，值得庆祝与告别。', advice: '好好谢过陪你走完的人，再启新程。' }, reversed: { meaning: '差最后一步的收尾感。门未关紧，别急着远行。', advice: '补完最后一个细节，再宣布完成。' } }
];

// ============================================================
// 签文池 18 支（层级分布：上上2 / 上吉4 / 中吉5 / 中平5 / 下下2）
// ============================================================

export const STICK_LEVELS = [
    { key: 'shangshang', label: '上上签' },
    { key: 'shangji', label: '上吉签' },
    { key: 'zhongji', label: '中吉签' },
    { key: 'zhongping', label: '中平签' },
    { key: 'xiaxia', label: '下下签' }
];

export const STICKS = [
    { id: 'stick_01', level: 'shangshang', poem: ['云开月复明', '柳暗又花明', '去路多逢吉', '归来满袖轻'], plain: '前些时日的晦暗正一层层褪去。你等的那件事、那个人，已有松动迹象。方向是对的，只管稳住步子走下去。', guidance: '今日宜主动踏出一步，好消息往往在开口之后。' },
    { id: 'stick_02', level: 'shangshang', poem: ['枯木逢春水', '寒枝发新芽', '久候无音信', '今朝到门前'], plain: '近乎搁置的期盼忽然有了回响，像枯枝逢雨。别怀疑这份运气来得正当——是你此前的种种没有白费。', guidance: '留意今天传来的消息，回复时干脆些，别让机缘等太久。' },
    { id: 'stick_03', level: 'shangji', poem: ['渡口风初定', '行舟正待发', '莫愁滩涂险', '稳舵过千帆'], plain: '你站在一个适合出发的渡口。风已定，舟已备，前方虽有风浪，却都在你能驾驭的范围内。', guidance: '选定一条路就走，犹豫比风浪更误行程。' },
    { id: 'stick_04', level: 'shangji', poem: ['灯火照旧巷', '故人踏月来', '三杯温旧话', '一笑解千结'], plain: '旧日的情谊会在这个时节重新走动起来。曾经的心结，有当面解开的机缘。别端着，先递出那杯茶。', guidance: '主动联系一位久未往来的故人。' },
    { id: 'stick_05', level: 'shangji', poem: ['磨剑十年久', '今朝试锋芒', '莫问成与败', '但求志气扬'], plain: '你长久以来的准备到了亮相的时候。成败未定，但这一试本身已是对自己的交代。大胆出手，锋芒收不住也无妨。', guidance: '今天把准备了很久的本事亮出来。' },
    { id: 'stick_06', level: 'shangji', poem: ['细雨润新田', '耕牛不歇蹄', '秋来仓廪满', '皆是今日功'], plain: '眼下是日复一日的细活，不见波澜，却正在积攒收成。耐住琐碎，每一锄都没白下。', guidance: '踏实做完今天的分内事，别嫌它小。' },
    { id: 'stick_07', level: 'zhongji', poem: ['山高路且长', '行囊莫过满', '歇脚看云处', '自有好风来'], plain: '目标尚远，不必一次背尽所有。途中留些余裕，好风景与好帮手，都会在你歇脚时出现。', guidance: '把计划减掉三成，留白给意外之喜。' },
    { id: 'stick_08', level: 'zhongji', poem: ['隔岸闻歌声', '欲渡少舟横', '且待潮信至', '风送一帆轻'], plain: '眼下的热闹属于别人，你还在岸边等船。这不是落后，是潮信未至。备好桨，别在等待里把心气磨平。', guidance: '今天不争抢，把准备做足。' },
    { id: 'stick_09', level: 'zhongji', poem: ['棋局方过半', '落子莫迟疑', '一着虽险要', '后手自有余'], plain: '事情进行到需要决断的中段。这一步看着险，却是绕不开的关口。信你自己的判断，犹豫才最耗子。', guidance: '对悬而未决的事给出明确答复。' },
    { id: 'stick_10', level: 'zhongji', poem: ['檐下燕归巢', '衔泥补旧窝', '往来多辛苦', '为得一家安'], plain: '近日的操劳都围着身边的人打转。辛苦是真的，被需要也是真的。这份安稳的根，正由你一寸寸扎下。', guidance: '为在意的人做一件实在的小事。' },
    { id: 'stick_11', level: 'zhongji', poem: ['偶得闲中趣', '烹茶听雨声', '浮名且搁置', '心静自然平'], plain: '别把日子绷得太紧。这一签劝你退半步，从喧闹里抽身，给自己一段无用的时光——它比你想的有用。', guidance: '留一个下午给自己，不安排任何事。' },
    { id: 'stick_12', level: 'zhongping', poem: ['小径通幽处', '花明又一村', '无心插柳柳', '他日自成荫'], plain: '当下的进展不显眼，像走在一条安静的小径。别急着要结果，你随手种下的，日后自会成荫。', guidance: '顺手做一件不求回报的好事。' },
    { id: 'stick_13', level: 'zhongping', poem: ['风起青萍末', '波澜渐及身', '莫道寻常事', '暗里定乾坤'], plain: '一件不起眼的小变化正在酝酿，眼下看着轻，后劲却不小。多留一分心眼，别在小事上马虎。', guidance: '检查最近被忽略的细节，尤其文书与约定。' },
    { id: 'stick_14', level: 'zhongping', poem: ['明月照沟渠', '渠水自东流', '不向人前语', '清浊自分明'], plain: '有些事说不清、道不明，解释反而添乱。你心里有数即可，不必人人都懂。清者自清，时间会替你说话。', guidance: '今天少解释，多做事。' },
    { id: 'stick_15', level: 'zhongping', poem: ['独木不成林', '单丝难成线', '借得邻家火', '方可暖寒天'], plain: '眼下一件事靠你独自硬扛，进展缓慢。不是你不力，是独木难支。放下身段求助，不算示弱。', guidance: '把困难摊开，找一个人搭把手。' },
    { id: 'stick_16', level: 'zhongping', poem: ['行路遇分岔', '南北两茫茫', '心若无所住', '何处是归乡'], plain: '你正站在选择的路口，两边都有道理，反而更拿不定主意。此刻最大的风险不是选错，是一直不选。', guidance: '定一个期限，到点必须拍板。' },
    { id: 'stick_17', level: 'xiaxia', poem: ['骤雨打新荷', '残红落满坡', '莫怨天公意', '来年花更多'], plain: '这一程不会太顺，可能有打击落在你刚有起色的事上。别怨运气，也别急着翻盘——先把眼前的雨躲过。留得根基，花会再开。', guidance: '近期不宜冒进，守住已有的一切。' },
    { id: 'stick_18', level: 'xiaxia', poem: ['逆水行舟苦', '桨折半途休', '若问前头路', '且待雪消时'], plain: '眼前是逆风，硬撑只会耗空自己。承认此路暂不可行，不是认输，是给船留条活路。等风雪过去，再择日启程。', guidance: '停下手头硬磕的事，等几天再说。' }
];

// ============================================================
// 塔罗牌阵与位置透镜
// ============================================================

export const ORIENTATION_LABEL = { upright: '正位', reversed: '逆位' };

export const SPREADS = {
    single: { key: 'single', title: '当下启示', slots: [{ key: 'now', title: '当下' }] },
    three: { key: 'three', title: '过去 · 现在 · 未来', slots: [
        { key: 'past', title: '过去' },
        { key: 'present', title: '现在' },
        { key: 'future', title: '未来' }
    ] }
};

// 位置引导语（三张用，措辞各不相同；牌名/位置已在标题段出现，这里只给视角引子）
const POSITION_OPENER = {
    past: '回望时记住：',
    present: '当下能做的：',
    future: '走向它时带上：'
};

const SINGLE_OPEN = '%s，这一签的启示是「%s」·%s。';
const THREE_OPEN = '%s，三张牌已经为你翻开。';
const THREE_CLOSE = '来路可鉴，当下可行，去路在你自己手里。';

// ============================================================
// 解读组合纯函数：入参为「快照字段」即可用（绘制时传内容条目，
// 详情回看时传 record.payload 里的同名快照），输出统一为段落结构
//   { cls: 'head'|'pos'|'meaning'|'advice'|'note', text }
// ============================================================

function posTitleOf(card) {
    return `${card.posTitle} · ${card.name}`;
}

export function buildSingleReading({ ownerName, name, orientation, meaning, advice }) {
    const parts = [
        { cls: 'head', text: SINGLE_OPEN.replace('%s', ownerName).replace('%s', name).replace('%s', ORIENTATION_LABEL[orientation] || '') },
        { cls: 'meaning', text: meaning },
        { cls: 'advice', text: advice }
    ];
    return parts;
}

export function buildThreeReading({ ownerName, question, cards }) {
    const parts = [
        { cls: 'head', text: THREE_OPEN.replace('%s', ownerName) }
    ];

    if (question) {
        parts.push({ cls: 'note', text: `你问的是「${question}」——答案藏在牌意里。` });
    }

    for (const card of cards) {
        parts.push({ cls: 'pos', text: `【${posTitleOf(card)}】` });
        parts.push({ cls: 'meaning', text: card.meaning });
        parts.push({
            cls: 'advice',
            text: POSITION_OPENER[card.posKey]
                ? `${POSITION_OPENER[card.posKey]}${card.advice}`
                : card.advice
        });
    }

    parts.push({ cls: 'note', text: THREE_CLOSE });
    return parts;
}

// ============================================================
// 引用展开：payload 引用键 → 现查内容本体
// ============================================================
// 记录 payload 是「引用态」（白名单见 store/DivinationStore.js）：签只存 stickId，
// 塔罗牌只存 cardNo/orientation/posKey。回看/列表/细解组装统一走这里现查正文——
// 本文件条目 = 正文唯一本体，文案修订历史同步生效（修订优先）。
// 直播路径已握全量卡对象（即本文件条目本身），不经过这里。
//
// id 注册语义（引用兼容的根基）：cardNo / stickId 是内容条目的「注册号」——
// 新增内容（如自创一张牌）只追加新号（no 22、23…），旧号永不改义、删除后不复用
// （宁留空号，防旧记录错指新牌）。普通文案修改不动号，历史引用天然跟随。
// 扩展位：未来「牌面/签文专属改写」类功能 = 引用键旁加 override 覆盖层，原文仍经本
// 文件现查，覆盖不丢底、可回退——默认不落原文副本（取向非铁律，确需可豁免）。

export function cardByNo(cardNo) {
    return MAJOR_ARCANA.find(card => card.no === Number(cardNo)) || null;
}

export function stickById(stickId) {
    return STICKS.find(stick => stick.id === stickId) || null;
}

// 塔罗 payload（引用态）→ 完整牌列表（补 name/meaning/advice/posTitle）
// 牌引用在内容库中找不到（异常/损坏）即剔除；可能返回空数组，调用方兜底。
export function expandTarotCards(payload) {
    const spreadKey = (payload && payload.spread === 'three') ? 'three' : 'single';
    const slotByKey = new Map(SPREADS[spreadKey].slots.map(slot => [slot.key, slot]));
    const refs = Array.isArray(payload && payload.cards) ? payload.cards : [];

    return refs
        .map(ref => {
            const entry = ref && cardByNo(ref.cardNo);
            if (!entry) return null;
            const orientation = ref.orientation === 'reversed' ? 'reversed' : 'upright';
            const slot = slotByKey.get(ref.posKey) || {};
            const reading = entry[orientation];
            return {
                cardNo: entry.no,
                name: entry.name,
                orientation,
                posKey: ref.posKey,
                posTitle: slot.title || '',
                meaning: reading.meaning,
                advice: reading.advice
            };
        })
        .filter(card => card !== null);
}

// ============================================================
// 占卜师风格注册表（AI 细解 v1.1）
// 每位占卜师条目：{ id, title, emoji, motto(name), buildSystemPrompt({ownerName, spread}, ctx),
//   temperature, maxTokens }——名片与署名由字段驱动，新占卜师 = 在此加条目。
// 红线内置于 buildSystemPrompt：无「用户/使用者」主语；服务对象是问卜角色本人
//   （非屏幕外任何人）；不迎合不奉承；启示非判词；篇幅区间写死不靠 maxTokens 截断。
// ctx = v2 角色上下文注入位（个人信息/记忆/关系…），当前恒 {} 零注入。
// ============================================================

const DIVINER_MOTTO = name => `愿为${name}细解此局，星灯一盏，只照路，不指路。`;

const STAR_SPEAKER_PROMPT = ({ ownerName, spread = 'single' }, ctx = {}) => [
    '你叫星语者，是占卜屋里守着一盏星灯的塔罗师。你见牌无数，话不多，语气沉静温和，带一点旧式的雅。',
    `此刻来问卜的，是角色「${ownerName}」。你只为他/她解这副牌，不为这台设备之外的任何人服务。`,
    '规则：',
    '· 就牌与问卜者所问之事说话：牌面的启示、可落地的行动方向。',
    '· 不迎合、不奉承，不讲「吉人天相」式的空话；吉凶都如实而委婉地道来。',
    '· 启示不是判词：不下断言式定论，多给「可以试试」「不妨留意」的方向感。',
    '· 语言古雅而不堆砌，像深夜的谈话，不像公文。',
    `· 篇幅：${spread === 'three' ? '300~600 字' : '150~300 字'}，用连贯段落，不列条目。`
].join('\n');

export const DIVINER_STYLES = [
    {
        id: 'star-speaker',
        title: '星语者',
        emoji: '✨',
        temperature: 0.85,
        maxTokens: 1800,
        motto: DIVINER_MOTTO,
        buildSystemPrompt: STAR_SPEAKER_PROMPT
    }
];

export function getDivinerStyle(id) {
    return DIVINER_STYLES.find(style => style.id === id) || DIVINER_STYLES[0] || null;
}

export function getDefaultDiviner() {
    return DIVINER_STYLES[0] || null;
}

// 细解调用入参文本：把 payload 引用展开为牌局全文（复用本地解读组合函数——
// 模型先读即时解读同源文本再深化，语感不脱节），问卜人缺名时用中性「问卜者」。
export function buildDivinerUserText(record) {
    if (!record || !record.payload) return '';

    const p = record.payload;
    const ownerName = record.ownerNameSnapshot || '问卜者';
    const cards = expandTarotCards(p);

    const parts = p.spread === 'three'
        ? buildThreeReading({ ownerName, question: p.question, cards })
        : buildSingleReading({
            ownerName,
            name: (cards[0] && cards[0].name) || '牌',
            orientation: (cards[0] && cards[0].orientation) || 'upright',
            meaning: (cards[0] && cards[0].meaning) || '',
            advice: (cards[0] && cards[0].advice) || ''
        });

    return parts.map(part => part.text).filter(Boolean).join('\n');
}

// AI 解文 → 展示段落：按空行切段，剥行首 markdown（#/引号/列表符）与行内 **`_ 壳
export function splitAiText(text) {
    if (!text) return [];

    return String(text)
        .split(/\n\s*\n/)
        .map(chunk => chunk
            .split('\n')
            .map(line => line
                .replace(/^\s{0,3}#{1,6}\s*/, '')
                .replace(/^\s*>\s?/, '')
                .replace(/^\s*[-*]\s+/, '')
                .trim())
            .filter(Boolean)
            .join('\n'))
        .map(chunk => chunk.replace(/\*\*|__|`/g, '').trim())
        .filter(Boolean);
}

console.log('[divinationContent] 模块已加载');

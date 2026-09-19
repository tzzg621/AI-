// apps/diary.js — 日记模块
// 角色可以生成和管理个人日记，支持按角色筛选

import { listDiaryEntries, getDiaryEntry, saveDiaryEntry, deleteDiaryEntry, getRecentDiaries, listStarredDiaries, setDiaryStarred } from '../store/DiaryStore.js';
import { getActiveCharacterId } from '../store/CharacterStore.js';
import { getCharacterNameById, getAllCharacterIds, getCharacterRecordById } from './characterManager.js';
import { callAIWithMessages, hasApiKey } from './aiService.js';
import { taskManager } from '../store/AITaskManager.js';
import { showConfirm } from '../store/dialog.js';
import { esc } from '../store/utils.js';

export const id = 'diary';
export const label = '日记';
export const icon = '📔';
export const color = '#D4A574';

// ========== 提示词 ==========
const DIARY_GENERATION_PROMPT = `你是一位细腻的日记书写者。请根据角色的当前状态、关系和记忆，为该角色撰写一篇真实自然的日记。

## 书写要求

1. **第一人称视角**：以角色自己的口吻书写，使用"我"而非角色名
2. **真实感**：记录日常琐事、内心感受、所思所想，避免宏大叙事
3. **情感细腻**：体现角色当下的情绪状态和心理变化
4. **个性化**：符合角色的性格特点、说话习惯和思维方式
5. **避免雷同**：不要重复之前日记中已经写过的话题和事件
6. **避免冲突**：新日记的内容应与之前的日记保持连贯，不出现矛盾
7. **篇幅适中**：300-800字，有开头有结尾，结构完整

## 输出格式

严格按照以下格式输出，不要添加其他内容：

---CONTENT---
（这里是日记正文）

---MOOD---
（从以下选项中选择一个最贴合的心情：happy, sad, calm, excited, anxious, angry, peaceful, confused, nostalgic, hopeful, tired, grateful）

---WEATHER---
（从以下选项中选择一个天气：sunny, cloudy, rainy, snowy, windy, foggy, stormy, clear）

---TOPICS---
（用逗号分隔的3-5个话题关键词，如：工作, 朋友, 家人, 梦想）

---KEY_EVENTS---
（用逗号分隔的1-3个关键事件摘要，每个不超过30字）

---EMOTIONAL_TONE---
（情感基调，从以下选择一个：positive, negative, neutral, mixed）

## 注意事项

- 日记内容应该是角色此时此刻的真实记录，而非虚构故事
- 可以提及角色的人际关系、日常活动、思考感悟
- 避免过度戏剧化，保持生活化的真实感
- 心情和天气要与日记内容相符
- 话题关键词要准确提炼日记的核心内容`;

// ========== 常量 ==========
// 生成超时兜底（同 divination.js / aiService 的 120s 口径）：
// API 挂住不返回时占位卡会一直杵在列表里，generating 也恒为 true，按钮从此失效
const AI_TIMEOUT_MS = 120000;

// 注入多少条「最近记忆」。取 20 是为了和 chat 的 promptBuilder.buildMemoryPrompt 默认值同口径
// （同一个角色的同一批记忆，换个模块看条数不该变）；更早的只给一条计数提示、不铺开。
const MEMORY_CONTEXT_COUNT = 20;

// 「最近 5 篇」窗口之外的重要日记，最多再铺开多少篇（每篇整篇正文）。标记是刻意行为、
// 量应该很少，这里只是兜住长尾：真标到几十篇时，宁可丢掉最老的那些，也不让提示词无界膨胀。
// 窗口内的那几条不占这个名额——它们本来就在「最近日记」里列着。
const STARRED_CONTEXT_COUNT = 10;

const MOOD_EMOJI = {
    happy: '😊',
    sad: '😢',
    calm: '😌',
    excited: '🤩',
    anxious: '😰',
    angry: '😠',
    peaceful: '😇',
    confused: '😕',
    nostalgic: '🥺',
    hopeful: '🌟',
    tired: '😴',
    grateful: '🙏'
};

const MOOD_LABEL = {
    happy: '开心',
    sad: '难过',
    calm: '平静',
    excited: '兴奋',
    anxious: '焦虑',
    angry: '生气',
    peaceful: '安宁',
    confused: '困惑',
    nostalgic: '怀念',
    hopeful: '期待',
    tired: '疲惫',
    grateful: '感恩'
};

const WEATHER_EMOJI = {
    sunny: '☀️',
    cloudy: '☁️',
    rainy: '🌧️',
    snowy: '❄️',
    windy: '💨',
    foggy: '🌫️',
    stormy: '⛈️',
    clear: '🌤️'
};

const WEATHER_LABEL = {
    sunny: '晴',
    cloudy: '多云',
    rainy: '雨',
    snowy: '雪',
    windy: '风',
    foggy: '雾',
    stormy: '暴风雨',
    clear: '晴朗'
};

// ========== 模块状态 ==========
const view = {
    page: 'list',           // list | detail（生成不再单独占一页：它只是列表里的一张占位卡）
    selectedCharacterId: null,  // null = 全部
    currentDiaryId: null
};

let currentContainer = null;
let currentGlobalState = null;
let pageGen = 0;
let generating = false;             // 有没有一篇正在生成
let generatingCharacterId = null;   // 正在生成谁的那篇（决定占位卡出现在哪份列表里）

// ========== 工具函数 ==========

function formatDate(timestamp) {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatDateTime(timestamp) {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hour}:${minute}`;
}

function toast(message) {
    const el = document.createElement('div');
    el.className = 'diary-toast';
    el.textContent = message;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('diary-toast-show'));

    setTimeout(() => {
        el.classList.remove('diary-toast-show');
        setTimeout(() => el.remove(), 220);
    }, 2100);
}

function getCurrentActorId() {
    const directId = currentGlobalState?.activeCharacter?.id;
    if (directId && directId !== 'unknown') return directId;

    const resolvedId = getActiveCharacterId(currentGlobalState);
    return resolvedId && resolvedId !== 'unknown' ? resolvedId : null;
}

// 「全部角色」时随机抽一位来写这篇。抽签池 = 筛选下拉里那份名单
// （getAllCharacterIds：名册 ∪ 网络，排除归档），和筛选项口径完全一致——
// 「全部角色」在两个地方必须是同一个意思；池子里也含从没写过日记的角色。
// 后续细化规则（谁更爱发日记、按性格归类决定倾向等）换的就是这一处实现。
function pickRandomCharacterId() {
    const ids = getAllCharacterIds();
    if (ids.length === 0) return null;
    return ids[Math.floor(Math.random() * ids.length)];
}

// ========== AI 生成相关 ==========

/**
 * 构建时间锚点
 * 原先喂给模型的提示词里没有任何日期：date 是模块自己存 formatDate(Date.now())，
 * 模型只看到「写一篇日记」，不知道自己身处哪天，时间线就随它编（同一天生成多篇时
 * 尤其明显）。这里只给事实——今天几号星期几、最近写过哪几天——不额外加规则。
 */
function buildDateContext(recentDiaries) {
    const now = new Date();
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];

    let context = '\n\n## 时间\n\n';
    context += `今天是 ${formatDate(now.getTime())}（星期${weekdays[now.getDay()]}）。\n`;

    // 同一日期可能有多篇，去重后列出。方向刻意统一成「早→晚」（用户 2026-09-12 定）：
    // 提示词里三块时间线都标出方向，且最近的那条落在最后——紧贴正文生成处，最醒目。
    // 先 reverse 再去重，保证同一天只留最早出现的那次。
    const dates = [...new Set([...recentDiaries].reverse().map(d => d.date).filter(Boolean))];
    if (dates.length > 0) {
        context += `最近写过日记的日期（早→晚）：${dates.join('、')}\n`;
    }

    return context.trimEnd();
}

/**
 * 条目按日期早→晚（同日按写入顺序）
 */
function compareByDate(a, b) {
    const da = String(a.date || '');
    const db = String(b.date || '');
    if (da !== db) return da < db ? -1 : 1;
    return (a.createdAt || 0) - (b.createdAt || 0);
}

/**
 * 构建「最近日记已记录事件（含重要日记）」上下文
 *
 * 用户 2026-09-12 定：重要日记不单独成块，而是并进这一块、按时间顺序排——
 *   · 落在「最近 5 篇」窗口之前的重要日记，排在最近五条之前，备注重要并给原文；
 *   · 就在窗口里的那条，只是它自己多一条原文，仍占五条里的一位，不影响其他条目。
 *
 * 「最近日记已涉及话题」一栏不受重要标记影响，仍只统计最近 5 篇；
 * 「最近日记已记录事件」一栏要把列出来的重要日记的关键事件并进去——标过的日记要一直记得，
 * 它的关键事件就不该随窗口滑走。事件是就地读日记的 metadata，不另存副本：
 * 日记删了 / 事件被清掉，自然也就没了。
 *
 * 只吃该角色自己的：store 层已按 characterId 过滤，A 的提示词里不会出现 B 的重要日记（AI/07）。
 */
function buildDeduplicationContext(recentDiaries, starredDiaries = []) {
    // 窗口内的重要日记不算「更早」：它已经在最近五条里列着了，不该再占封顶名额
    const windowIds = new Set(recentDiaries.map(d => d.id));
    const olderStarred = starredDiaries.filter(d => !windowIds.has(d.id));

    // 传进来是新→旧（createdAt 降序）：留最新的 10 篇，更早的丢掉，只给一条计数提示。
    // 无上限会随使用膨胀（预设默认 maxContextChars 是 40000，几十篇整篇正文就把别的素材挤掉了）
    const shownOlderStarred = olderStarred.slice(0, STARRED_CONTEXT_COUNT);

    // 条目 = 更早的重要日记 + 最近 5 篇，统一早→晚
    const entries = [...shownOlderStarred, ...recentDiaries].sort(compareByDate);
    if (entries.length === 0) {
        return '';
    }

    const usedTopics = new Set();
    const usedEvents = new Set();

    // 话题按「早→晚」列：同一天里也按写入顺序，跟这一块的时间方向一致。
    // 不排序的话出来的顺序是取窗口时的 createdAt 降序（新→旧），读起来跟下面的条目反着
    [...recentDiaries].sort(compareByDate).forEach(diary => {
        if (diary.metadata?.topics) {
            diary.metadata.topics.forEach(topic => usedTopics.add(topic));
        }
    });

    entries.forEach(diary => {
        if (diary.metadata?.keyEvents) {
            diary.metadata.keyEvents.forEach(event => usedEvents.add(event));
        }
    });

    let context = '\n\n## 最近日记已记录事件（含重要日记，早→晚）\n\n';

    if (usedTopics.size > 0) {
        context += `最近日记已涉及话题：${[...usedTopics].join(', ')}\n`;
    }

    if (usedEvents.size > 0) {
        context += `最近日记已记录事件：${[...usedEvents].join('; ')}\n`;
    }

    context += '\n';

    entries.forEach(diary => {
        const topics = diary.metadata?.topics || [];
        const events = diary.metadata?.keyEvents || [];
        const parts = [];
        if (topics.length > 0) parts.push(`话题：${topics.join(', ')}`);
        if (events.length > 0) parts.push(`事件：${events.join('; ')}`);

        context += `- ${diary.date}${diary.starred ? '（重要）' : ''}`
            + (parts.length > 0 ? `（${parts.join(' ｜ ')}）` : '') + '\n';

        if (diary.starred) {
            // 标为重要的给全文：标记是「一直记得」的信号，摘要撑不起这个作用。
            // 正文可能多行，续行缩进两格，免得跟条目符号平齐看不出归属
            context += `  原文：${String(diary.content || '').replace(/\n/g, '\n  ')}\n`;
        }
    });

    if (olderStarred.length > STARRED_CONTEXT_COUNT) {
        context += `（另有 ${olderStarred.length - STARRED_CONTEXT_COUNT} 篇重要日记较早，未列出）\n`;
    }

    context += '\n请选择新的角度和话题，避免与上述内容重复。\n';

    return context.trimEnd();
}

/**
 * 构建角色上下文（该角色自己的资料——日记是第一人称写自己，这里给的正是「我」知道的）
 *
 * 字段口径照抄 promptBuilder 的三段（【角色信息】【你与其他角色的关系】【角色的长期记忆】），
 * 同一个东西在两个模块里用同一种叫法；那边是「AI 扮演的角色」，这里是「写日记的角色」，
 * 视角同一层，所以读的是同一批数据。
 *
 * 修掉的两个坑（原先读的字段项目里根本不存在，等于一直在注入空）：
 * 见 store/CharacterStore.js 的 createDefaultCharacterData —— base 里没有 personality / background，
 * 真实字段是 desc（性格描述）/ detail（详细设定）/ style（说话风格）/ secret（内心秘密）+ 性别年龄。
 */
function buildCharacterContext(characterRecord) {
    if (!characterRecord) return '';

    const base = characterRecord.base || {};
    const lines = [`名称：${base.name || characterRecord.id}`];

    // 只列有内容的：默认值「未知」不占位置
    const optional = [
        ['性别', base.gender],
        ['年龄', base.age],
        ['性取向', base.orientation],
        ['性格描述', base.desc],
        ['说话风格', base.style],
        ['内心秘密', base.secret],
        ['详细设定', base.detail]
    ];
    optional.forEach(([label, value]) => {
        if (value && value !== '未知') lines.push(`${label}：${value}`);
    });

    let context = '\n\n## 角色信息\n\n' + lines.join('\n') + '\n';

    // 关系：原先只给「名字（关系）」，把看法和倾向丢了——而这两样恰恰是日记内心戏的来源
    const relations = (characterRecord.relations || []).filter(r => r.relation && (r.name || r.id));
    if (relations.length > 0) {
        context += '\n### 人际关系\n';
        relations.forEach(r => {
            context += `- ${r.name || getCharacterNameById(r.id)}：${r.relation}\n`;
            if (r.perspective) context += `  看法：${r.perspective}\n`;
            if (r.attitudes?.length > 0) context += `  倾向：${r.attitudes.join('、')}\n`;
        });
    }

    // 记忆：原先只给最近 3 条且丢掉 m.time——没有时间的记忆派不上用场（AI 不知道那是何时的事）
    const memories = characterRecord.memories || [];
    if (memories.length > 0) {
        const recent = memories.slice(-MEMORY_CONTEXT_COUNT);
        const memoryLines = recent
            .map(m => (m && typeof m === 'object') ? { time: m.time, text: m.content || '' } : { time: '', text: String(m || '') })
            .filter(m => m.text)
            .map(m => `- ${m.time ? `${m.time}：` : ''}${m.text}`);
        if (memoryLines.length > 0) {
            // 记忆本身就是 push 序（早→晚），与另外两块时间线同一个方向，标出来即可
            context += '\n### 最近记忆（早→晚）\n' + memoryLines.join('\n') + '\n';
            if (memories.length > MEMORY_CONTEXT_COUNT) {
                context += `...（另有 ${memories.length - MEMORY_CONTEXT_COUNT} 条更早的记忆未列出）\n`;
            }
        }
    }

    // 认知笔记：这个角色对别人的认识（key 是对方 id，见 chat.js 的写入点）
    const notes = characterRecord.cognitiveNotes || {};
    const noteLines = Object.entries(notes)
        .filter(([, text]) => text)
        .map(([id, text]) => `- 对 ${getCharacterNameById(id)} 的认知：${text}`);
    if (noteLines.length > 0) {
        context += '\n### 认知笔记\n' + noteLines.join('\n') + '\n';
    }

    return context.trimEnd();
}

/**
 * 解析 AI 返回的日记内容
 */
function parseDiaryResponse(raw) {
    const result = {
        content: '',
        mood: 'calm',
        weather: 'clear',
        topics: [],
        keyEvents: [],
        emotionalTone: 'neutral'
    };

    // ★ 兼容 callAIWithMessages 返回字符串或 { content } 对象
    const text = String(
        typeof raw === 'string' ? raw : (raw?.content ?? '')
    ).trim();

    if (!text) return result;

    // 按 ---标记--- 分段，取下一个标记之前的全部内容
    const extract = (name) => {
        const re = new RegExp(
            `---\\s*${name}\\s*---\\s*([\\s\\S]*?)(?=\\s*---\\s*[A-Z_]+\\s*---|$)`,
            'i'
        );
        const m = text.match(re);
        return m ? m[1].trim() : '';
    };

    const content = extract('CONTENT');

    if (content) {
        result.content = content;

        const mood = extract('MOOD').toLowerCase();
        if (MOOD_LABEL[mood]) result.mood = mood;

        const weather = extract('WEATHER').toLowerCase();
        if (WEATHER_LABEL[weather]) result.weather = weather;

        const topicsText = extract('TOPICS');
        if (topicsText) {
            result.topics = topicsText
                .split(/[,，]/)
                .map(t => t.trim())
                .filter(Boolean);
        }

        const eventsText = extract('KEY_EVENTS');
        if (eventsText) {
            result.keyEvents = eventsText
                .split(/[,，]/)
                .map(e => e.trim())
                .filter(Boolean);
        }

        const tone = extract('EMOTIONAL_TONE').toLowerCase();
        if (tone) result.emotionalTone = tone;

        return result;
    }

    // ★ 兜底：AI 没按格式返回（比如吐了 markdown），整段当正文
    result.content = text;
    return result;
}

/**
 * 生成日记
 */
async function generateDiary(characterId) {
    if (generating) {
        toast('正在生成中，请稍候');
        return;
    }

    if (!hasApiKey()) {
        toast('请先在设置中配置 API 密钥');
        return;
    }

    generating = true;
    generatingCharacterId = characterId;
    // 不切页：生成是后台活，人该继续待在列表里翻别的日记。
    // 只在列表顶上放一张占位卡，位置就是这篇将来出现的位置
    showPlaceholder();

    try {
        // 角色资料（设定/关系/记忆/认知）：一次读全
        const characterRecord = getCharacterRecordById(characterId);
        const characterContext = buildCharacterContext(characterRecord);

        // 最近 5 篇：一处取数，时间锚点与去重两块共用
        const recentDiaries = await getRecentDiaries(characterId, 5);

        // 标为重要的日记（该角色自己的），不受上面那个 5 篇窗口限制
        const starredDiaries = await listStarredDiaries(characterId);

        // 拼装顺序：书写要求 → 今天几号 → 我是谁 → 已经写过什么（重要日记并在这一块里）
        // （下面每块自己不留尾换行，块间那一行空行由这次拼接的 '\n\n' 给，免得叠出双空行）
        const fullPrompt = DIARY_GENERATION_PROMPT
            + buildDateContext(recentDiaries)
            + characterContext
            + buildDeduplicationContext(recentDiaries, starredDiaries);

        // 提交到 AI 任务中心（悬浮球可见进度；本模块离开后任务照跑）
        // label 模糊化：不含角色名，与占卜屋细解同一口径
        const response = await taskManager.submit('diary', '日记生成', async () =>
            Promise.race([
                callAIWithMessages({
                    systemPrompt: '你是一位专业的日记书写助手。',
                    userContent: fullPrompt
                }),
                new Promise((_, reject) => setTimeout(
                    () => reject(new Error('AI 服务响应超时（已自动放弃，可再试一次）')),
                    AI_TIMEOUT_MS
                ))
            ])
        );

        // 解析响应
        const parsed = parseDiaryResponse(response);

        if (!parsed.content) {
            const rawText = typeof response === 'string'
                ? response
                : (response?.content ?? '');
            const preview = String(rawText).slice(0, 120);
            console.error('[diary] AI 原始返回：', response);
            throw new Error(
                `AI 返回内容为空（原始长度 ${String(rawText).length}）：${preview}`
            );
        }
        
        // 保存日记
        const diary = await saveDiaryEntry({
            characterId,
            date: formatDate(Date.now()),
            content: parsed.content,
            mood: parsed.mood,
            weather: parsed.weather,
            metadata: {
                topics: parsed.topics,
                keyEvents: parsed.keyEvents,
                emotionalTone: parsed.emotionalTone
            }
        });

        // 完成后的落点：就地换卡，不跳页、不抢焦点——人在读哪篇就让他读哪篇。
        // 真卡片替换掉占位卡，位置、滚动都还在原处；离开模块或切去详情的，
        // 列表下次加载自然会带上这一篇
        generating = false;
        generatingCharacterId = null;
        toast('日记生成成功');
        replacePlaceholderWith(diary);

    } catch (error) {
        console.error('[diary] 生成失败:', error);
        const errorMsg = error?.message || String(error) || '未知错误';
        generating = false;
        generatingCharacterId = null;
        toast('生成失败：' + errorMsg);
        removePlaceholder();   // 收掉占位卡，列表回到什么都没发生的样子
    }
}

// ========== 渲染相关 ==========

// 本模块是否还挂在页面上。app.js 每次路由渲染都整体重写 pageContainer，
// 离开日记去别的模块后本模块的 DOM 已不存在——此时异步回调（AI 生成返回、
// 列表/详情加载返回）绝不能再往 DOM 写：那会把当前页（首页或别的模块）顶掉，
// 顺带把顶栏按日记的状态藏起来。
function isMounted() {
    return !!currentContainer && !!currentContainer.querySelector('.diary-page');
}

function rerender() {
    pageGen += 1;
    if (!isMounted()) return;   // 已离开模块：只更新内部状态，不碰 DOM
    currentContainer.innerHTML = renderPage();
    updateTopBarVisibility();
    bindPageEvents();
}

function updateTopBarVisibility() {
    const topBar = document.getElementById('topBar');
    const statusBackBtn = document.getElementById('statusBackBtn');

    if (view.page === 'detail') {
        if (topBar) topBar.style.display = 'none';
        if (statusBackBtn) statusBackBtn.style.display = 'none';
    } else {
        if (topBar) topBar.style.display = '';
        if (statusBackBtn) statusBackBtn.style.display = '';
    }
}

function renderPage() {
    if (view.page === 'detail') {
        return renderDetailPage();
    }
    return renderListPage();
}

function renderListPage() {
    const allCharacters = getAllCharacterIds();
    const activeCharacterId = getCurrentActorId();

    return `
        <div class="diary-page">
            <div class="diary-header">
                <select class="diary-filter" id="diaryCharacterFilter">
                    <option value="">全部角色</option>
                    ${allCharacters.map(charId => {
                        const name = getCharacterNameById(charId);
                        const selected = view.selectedCharacterId === charId ? 'selected' : '';
                        return `<option value="${esc(charId)}" ${selected}>${esc(name)}</option>`;
                    }).join('')}
                </select>
                <button class="diary-new-btn" id="diaryNewBtn">
                    <span class="diary-new-icon">✏️</span>
                    生成日记
                </button>
            </div>
            <div class="diary-list" id="diaryList">
                <div class="diary-loading">加载中...</div>
            </div>
        </div>
    `;
}

function renderDetailPage() {
    return `
        <div class="diary-page">
            <div class="diary-detail-header">
                <button class="diary-back-btn" id="diaryBackBtn">← 返回</button>
            </div>
            <div class="diary-detail-content" id="diaryDetailContent">
                <div class="diary-loading">加载中...</div>
            </div>
        </div>
    `;
}

// ========== 列表卡片与「生成中」占位卡 ==========

// 单张日记卡：列表整体渲染与「生成完成后就地补一张」共用，模板只此一处
function renderDiaryCard(diary, characterName) {
    const moodEmoji = MOOD_EMOJI[diary.mood] || '📝';
    const weatherEmoji = WEATHER_EMOJI[diary.weather] || '🌤️';
    const preview = diary.content.slice(0, 80) + (diary.content.length > 80 ? '...' : '');

    return `
        <div class="diary-item" data-id="${esc(diary.id)}">
            <div class="diary-item-header">
                <span class="diary-item-date">${esc(diary.date)}</span>
                <span class="diary-item-meta">
                    ${diary.starred ? '<span class="diary-item-star" title="重要">⭐</span>' : ''}
                    ${moodEmoji} ${weatherEmoji}
                </span>
            </div>
            <div class="diary-item-character">${esc(characterName)}</div>
            <div class="diary-item-preview">${esc(preview)}</div>
        </div>
    `;
}

// 生成中的占位卡：长在这篇将来要出现的位置上，正在读的别篇不受影响
function renderPlaceholderCard(characterName) {
    return `
        <div class="diary-item diary-item-placeholder">
            <div class="diary-item-header">
                <span class="diary-item-date">正在生成…</span>
                <span class="diary-item-meta"><span class="diary-placeholder-pen">✍️</span></span>
            </div>
            <div class="diary-item-character">${esc(characterName)}</div>
            <div class="diary-placeholder-lines">
                <div class="diary-placeholder-line"></div>
                <div class="diary-placeholder-line"></div>
                <div class="diary-placeholder-line"></div>
            </div>
        </div>
    `;
}

// 占位卡该不该露面：正在生成，且当前筛选看得到这个角色的日记
function placeholderVisible() {
    if (!generating) return false;
    return !view.selectedCharacterId || view.selectedCharacterId === generatingCharacterId;
}

// 往列表顶上插一张卡，同时把「正在看的那张卡」钉在视口原位。
// 不能拿 scrollHeight 差值当补偿量：两列网格插一张卡，行数可能根本不变
// （9 张是 5 行，10 张还是 5 行），总高一点没变、可下面整片都换了一格，
// 按高度算会补 0，人就看着内容往下跳一行。所以直接量锚点卡自己的位移。
function insertCardAtTop(cardHtml) {
    const listEl = document.getElementById('diaryList');
    if (!listEl) return;

    listEl.querySelector('.diary-empty')?.remove();

    // 锚点 = 视口顶端那张还看得见的卡（列表没滚过时就是第一张）
    const listTop = listEl.getBoundingClientRect().top;
    const anchor = [...listEl.children].find(
        el => el.dataset.id && el.getBoundingClientRect().bottom > listTop
    );
    const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
    const scrollBefore = listEl.scrollTop;

    listEl.insertAdjacentHTML('afterbegin', cardHtml);

    if (anchor) {
        listEl.scrollTop = scrollBefore + (anchor.getBoundingClientRect().top - anchorTop);
    }
}

// 生成开始：把占位卡插到列表顶上。局部插入而非整页 rerender ——
// 整页重绘会把列表滚动位置冲回顶部，正在翻别篇的人会被打断
function showPlaceholder() {
    if (view.page !== 'list' || !placeholderVisible()) return;
    insertCardAtTop(renderPlaceholderCard(getCharacterNameById(generatingCharacterId)));
}

function removePlaceholder() {
    document.querySelectorAll('.diary-item-placeholder').forEach(el => el.remove());
}

// 生成完成：占位卡原地换成真卡片。原地换 = 零位移，正在读的别篇一像素都不动
function replacePlaceholderWith(diary) {
    const visible = view.page === 'list'
        && (!view.selectedCharacterId || view.selectedCharacterId === diary.characterId);
    if (!visible) {           // 人在读详情 / 已离开模块 / 当前筛选看不到它：下次加载自然带上
        removePlaceholder();
        return;
    }

    const cardHtml = renderDiaryCard(diary, getCharacterNameById(diary.characterId));
    const placeholder = document.querySelector('.diary-item-placeholder');

    if (placeholder) {
        placeholder.outerHTML = cardHtml;
        return;
    }
    // 占位卡不在了（生成中途换过筛选）：当新卡补到顶上
    insertCardAtTop(cardHtml);
}

async function loadDiaryList() {
    const listEl = document.getElementById('diaryList');
    if (!listEl) return;

    try {
        const diaries = await listDiaryEntries({
            characterId: view.selectedCharacterId || null
        });

        if (!listEl.isConnected) return;   // 等待期间已切页或离开模块，旧节点作废

        // 角色名按 id 缓存（只活这一次渲染，不落库）：逐条现查会把整份名册反复
        // JSON.parse——DataSync shim 给的是内存字符串，开销全在解析，实测 1200 条 8ms
        const nameCache = new Map();
        const characterNameOf = (id) => {
            if (!nameCache.has(id)) nameCache.set(id, getCharacterNameById(id));
            return nameCache.get(id);
        };

        const cards = diaries.map(d => renderDiaryCard(d, characterNameOf(d.characterId))).join('');
        // 生成中的占位卡也要跟着筛选走：切到别的角色，它就不该在这儿杵着
        const placeholder = placeholderVisible()
            ? renderPlaceholderCard(characterNameOf(generatingCharacterId))
            : '';

        if (!cards && !placeholder) {
            listEl.innerHTML = '<div class="diary-empty">暂无日记</div>';
            return;
        }

        listEl.innerHTML = placeholder + cards;

    } catch (error) {
        console.error('[diary] 加载列表失败:', error);
        listEl.innerHTML = '<div class="diary-error">加载失败</div>';
    }
}

async function loadDiaryDetail() {
    const contentEl = document.getElementById('diaryDetailContent');
    if (!contentEl || !view.currentDiaryId) return;

    try {
        const diary = await getDiaryEntry(view.currentDiaryId);

        if (!contentEl.isConnected) return;   // 等待期间已返回列表或离开模块

        if (!diary) {
            contentEl.innerHTML = '<div class="diary-error">日记不存在</div>';
            return;
        }

        const characterName = getCharacterNameById(diary.characterId);
        const moodLabel = MOOD_LABEL[diary.mood] || diary.mood;
        const moodEmoji = MOOD_EMOJI[diary.mood] || '📝';
        const weatherLabel = WEATHER_LABEL[diary.weather] || diary.weather;
        const weatherEmoji = WEATHER_EMOJI[diary.weather] || '🌤️';

        contentEl.innerHTML = `
            <div class="diary-detail">
                <div class="diary-detail-date">${esc(diary.date)}</div>
                <div class="diary-detail-character">${esc(characterName)}</div>
                <div class="diary-detail-meta">
                    <span class="diary-meta-item">${moodEmoji} ${esc(moodLabel)}</span>
                    <span class="diary-meta-item">${weatherEmoji} ${esc(weatherLabel)}</span>
                </div>
                <div class="diary-detail-text">${esc(diary.content).replace(/\n/g, '<br>')}</div>
                ${diary.metadata?.topics?.length > 0 ? `
                    <div class="diary-detail-topics">
                        ${diary.metadata.topics.map(topic =>
                            `<span class="diary-topic-tag">${esc(topic)}</span>`
                        ).join('')}
                    </div>
                ` : ''}
                <div class="diary-detail-actions">
                    <button class="diary-star-btn ${diary.starred ? 'is-starred' : ''}" id="diaryStarBtn">
                        ${diary.starred ? '⭐ 已标为重要' : '☆ 标为重要'}
                    </button>
                    <button class="diary-delete-btn" id="diaryDeleteBtn">删除这篇日记</button>
                </div>
            </div>
        `;

    } catch (error) {
        console.error('[diary] 加载详情失败:', error);
        contentEl.innerHTML = '<div class="diary-error">加载失败</div>';
    }
}

// ========== 事件绑定 ==========

function bindPageEvents() {
    // 角色筛选
    const filterEl = document.getElementById('diaryCharacterFilter');
    if (filterEl) {
        filterEl.addEventListener('change', e => {
            view.selectedCharacterId = e.target.value || null;
            loadDiaryList();
        });
        // 初始加载
        loadDiaryList();
    }

    // 新建按钮
    const newBtn = document.getElementById('diaryNewBtn');
    if (newBtn) {
        newBtn.addEventListener('click', async () => {
            // 选了具体角色 → 写那位；「全部角色」→ 随机抽一位（不再是主视角兜底）
            const characterId = view.selectedCharacterId || pickRandomCharacterId();

            if (!characterId) {
                toast('请先选择一个角色');
                return;
            }

            await generateDiary(characterId);
        });
    }

    // 日记项点击
    const listEl = document.getElementById('diaryList');
    if (listEl) {
        listEl.addEventListener('click', e => {
            const item = e.target.closest('.diary-item');
            if (item && item.dataset.id) {   // 没有 data-id 的是生成中占位卡，点了不该有反应
                view.currentDiaryId = item.dataset.id;
                view.page = 'detail';
                rerender();
            }
        });
    }

    // 返回按钮
    const backBtn = document.getElementById('diaryBackBtn');
    if (backBtn) {
        backBtn.addEventListener('click', () => {
            view.page = 'list';
            view.currentDiaryId = null;
            rerender();
        });
    }

    // 删除按钮 —— 走事件委托：按钮是详情内容异步加载完才进 DOM 的，
    // 直接查此刻还查不到（原先就是这么写死的：拿到 null，整颗按钮没有监听器）
    const detailContentEl = document.getElementById('diaryDetailContent');
    if (detailContentEl) {
        detailContentEl.addEventListener('click', async e => {
            // 「重要」开关：标过的重要日记会一直进提示词（该角色生成时），
            // 由 DiaryStore.setDiaryStarred 只改这一个字段，正文日期都不动
            if (e.target.closest('#diaryStarBtn')) {
                const id = view.currentDiaryId;
                if (!id) return;

                try {
                    const current = await getDiaryEntry(id);
                    const next = !current?.starred;
                    await setDiaryStarred(id, next);
                    toast(next ? '已标为重要' : '已取消重要标记');
                    await loadDiaryDetail();   // 就地刷新详情：按钮文案与状态跟着变
                } catch (error) {
                    console.error('[diary] 重要标记失败:', error);
                    toast('操作失败：' + (error?.message || error));
                }
                return;
            }

            if (!e.target.closest('#diaryDeleteBtn')) return;

            const confirmed = await showConfirm('确定要删除这篇日记吗？');
            if (!confirmed) return;

            try {
                await deleteDiaryEntry(view.currentDiaryId);
                toast('删除成功');
                view.page = 'list';
                view.currentDiaryId = null;
                rerender();
            } catch (error) {
                console.error('[diary] 删除失败:', error);
                toast('删除失败');
            }
        });
    }

    // 详情页加载
    if (view.page === 'detail') {
        loadDiaryDetail();
    }
}

// ========== 模块导出 ==========

export function render(context = {}) {
    currentGlobalState = context.globalState || currentGlobalState;

    // 每次从外面进入模块都落到列表页：不记忆上次停在哪一页，
    // 后台生成完了也不把人直接甩进详情页
    view.page = 'list';
    view.currentDiaryId = null;

    // 初始化选中角色为当前主视角
    if (!view.selectedCharacterId) {
        view.selectedCharacterId = getCurrentActorId();
    }

    return renderPage();
}

export function bindEvents(container, context = {}) {
    currentContainer = container;
    currentGlobalState = context.globalState || currentGlobalState;
    updateTopBarVisibility();
    bindPageEvents();
}

// 模块注册
if (!window.__moduleRegistry) window.__moduleRegistry = [];
window.__moduleRegistry.push({ id, label, icon, color, render, bindEvents });

console.log('[diary] 模块已加载');

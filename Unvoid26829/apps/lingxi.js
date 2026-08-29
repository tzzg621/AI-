import {
    getAllCharacterIds,
    getCharacterRecordById,
    getCharacterNameById
} from './characterManager.js';
import {
    CharacterStore,
    getActiveCharacterId
} from '../store/CharacterStore.js';
import { esc } from '../store/utils.js';
import { callAI } from './aiService.js';
import {
    listTopics,
    createTopic,
    addResponse,
    createResponseId,
    savePairTopicSnapshot
} from '../store/LingxiStore.js';
import {
    LINGXI_ANONYMOUS_REPLY_PROMPT,
    LINGXI_TOPIC_NAME_PROMPT
} from './prompts.js';
import { taskManager } from '../store/AITaskManager.js';

export const id = 'lingxi';
export const label = '灵犀';
export const icon = '🔗';
export const color = '#7c6ac7';
export const title = '🔗 灵犀';

const MAX_RESPONDER_COUNT = 3;
const RESPONSE_DELAY_MIN = 350;
const RESPONSE_DELAY_MAX = 1200;
const MAX_MENTION_REFS = 3;
const MAX_UNRESOLVED_MENTIONS = 3;

const invitingTopicIds = new Set();

let topics = [];
let currentContainer = null;
let currentGlobalState = null;
let loading = false;
// 每个灵犀页面根节点只绑定一次事件委托。
// .lx-page 被路由销毁后，监听器也会自然释放。
const boundPageRoots = new WeakSet();

const anonymousNames = [
    '雾中来信',
    '旧唱片',
    '雨天观测员',
    '纸灯',
    '夜行者',
    '未寄出的信',
    '远岸',
    '窗边的人'
];

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getCurrentActorId(globalState) {
    const directId = globalState?.activeCharacter?.id;
    if (directId) return directId;

    const resolvedId = getActiveCharacterId(globalState);
    return resolvedId && resolvedId !== 'unknown'
        ? resolvedId
        : null;
}

function showLingxiToast(message) {
    document.querySelector('.lx-toast')?.remove();

    const toast = document.createElement('div');
    toast.className = 'lx-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('lx-toast-show'));

    setTimeout(() => {
        toast.classList.remove('lx-toast-show');
        setTimeout(() => toast.remove(), 220);
    }, 2000);
}

function getActorName(id) {
    return getCharacterNameById(id) || id || '未知角色';
}

function getActorIds() {
    return getAllCharacterIds({ includeArchived: false })
        .filter(id => id && id !== 'unknown');
}

function getAnonymousLabel(topicId, actorId) {
    let hash = 0;
    const value = `${topicId}:${actorId}`;

    for (let i = 0; i < value.length; i += 1) {
        hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
    }

    return anonymousNames[hash % anonymousNames.length];
}

function normalizeCharacterName(value) {
    return String(value || '')
        .normalize('NFKC')
        .trim()
        .toLocaleLowerCase('zh-CN');
}

function getRelationContext(actorId, record) {
    const relations = Array.isArray(record?.relations)
        ? record.relations
        : [];

    return relations.slice(0, 20).map(relation => {
        const name = relation.name || relation.id || '某人';
        const parts = [
            `对象姓名：${name}`,
            `关系：${relation.relation || '关系未明'}`
        ];

        if (relation.perspective) {
            parts.push(`看法：${relation.perspective}`);
        }

        if (Array.isArray(relation.attitudes) && relation.attitudes.length) {
            parts.push(`倾向：${relation.attitudes.join('、')}`);
        }

        return parts.join('，');
    }).join('\n');
}

function buildCharacterContext(actorId) {
    const record = getCharacterRecordById(actorId);
    if (!record) return null;

    const memories = Array.isArray(record.memories)
        ? record.memories.slice(-12)
        : [];

    const memoryText = memories
        .map(memory => memory?.content)
        .filter(Boolean)
        .join('\n');

    return {
        record,
        text: [
            `角色名称：${record.base?.name || getActorName(actorId)}`,
            `角色描述：${record.base?.desc || ''}`,
            `详细设定：${record.base?.detail || ''}`,
            `说话风格：${record.base?.style || ''}`,
            `角色记忆：\n${memoryText || '无'}`,
            `角色自己的关系认知：\n${getRelationContext(actorId, record) || '无'}`
        ].join('\n')
    };
}

function chooseResponders(topic) {
    const usedIds = new Set(
        (topic.responses || []).map(response => response.authorId)
    );

    const actorIds = getActorIds()
        .filter(id => id !== topic.authorId && !usedIds.has(id));

    for (let i = actorIds.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [actorIds[i], actorIds[j]] = [actorIds[j], actorIds[i]];
    }

    return actorIds.slice(0, MAX_RESPONDER_COUNT);
}

function buildMentionCandidates(authorId) {
    const candidates = new Map();

    const add = (characterId, priority, source) => {
        if (!characterId || characterId === authorId) return;

        const name = getActorName(characterId);
        const normalizedName = normalizeCharacterName(name);

        if (!normalizedName || normalizedName === normalizeCharacterName(characterId)) {
            return;
        }

        const list = candidates.get(normalizedName) || [];
        const existing = list.find(item => item.characterId === characterId);

        if (existing) {
            if (priority > existing.priority) {
                existing.priority = priority;
                existing.source = source;
            }
        } else {
            list.push({
                characterId,
                name,
                priority,
                source
            });
        }

        candidates.set(normalizedName, list);
    };

    const authorRecord = getCharacterRecordById(authorId);

    // 最高优先级：回答者自己的关系认知。
    for (const relation of authorRecord?.relations || []) {
        if (relation?.id) add(relation.id, 300, 'relation');
    }

    // 第二优先级：回答者自己的联系人。
    try {
        const store = new CharacterStore(authorId);
        for (const friendId of store.getFriendIds()) {
            add(friendId, 200, 'contact');
        }
    } catch { }

    // 最低优先级：全局有效角色目录。
    for (const characterId of getActorIds()) {
        add(characterId, 100, 'directory');
    }

    return candidates;
}

function resolveMentionName(name, candidates) {
    const normalizedName = normalizeCharacterName(name);
    const matches = candidates.get(normalizedName) || [];
    if (!matches.length) return null;

    const highestPriority = Math.max(
        ...matches.map(item => item.priority)
    );
    const strongest = matches.filter(
        item => item.priority === highestPriority
    );

    // 同一优先级有多个同名角色时不猜测。
    if (strongest.length !== 1) return null;

    const match = strongest[0];

    return {
        characterId: match.characterId,
        mentionedName: String(name).trim(),
        matchSource: match.source,
        confidence: match.source === 'relation'
            ? 1
            : match.source === 'contact'
                ? 0.9
                : 0.75
    };
}

function parseReplyTopicName(rawText) {
    const source = String(rawText || '');
    const topicNamePattern = /【话题名\s*[:：]\s*([^】\r\n]+)】/g;
    const match = topicNamePattern.exec(source);

    const topicName = match
        ? match[1]
            .trim()
            .replace(/[\r\n]+/g, ' ')
            .replace(/\s+/g, ' ')
            .slice(0, 20)
        : '';

    const text = source
        .replace(topicNamePattern, '')
        .trim();

    return {
        topicName,
        text
    };
}
function parseCharacterMentions(rawText, authorId) {
    const candidates = buildMentionCandidates(authorId);
    const refs = new Map();
    const unresolvedNames = new Set();
    const mentionMarkers = [];
    const tagPattern = /【涉及角色\s*[:：]\s*([^】]+)】/g;
    let match;

    // 第一优先级：解析 AI 明确输出的【涉及角色:姓名】。
    while ((match = tagPattern.exec(rawText))) {
        const names = match[1]
            .split(/[、,，/]/)
            .map(name => name.trim())
            .filter(Boolean);

        for (const name of names) {
            const resolved = resolveMentionName(name, candidates);

            if (resolved) {
                refs.set(resolved.characterId, resolved);
                mentionMarkers.push({
                    mentionedName: name,
                    characterId: resolved.characterId,
                    matchSource: resolved.matchSource,
                    confidence: resolved.confidence,
                    resolved: true
                });
            } else {
                unresolvedNames.add(name);
                mentionMarkers.push({
                    mentionedName: name,
                    characterId: null,
                    matchSource: null,
                    confidence: 0,
                    resolved: false
                });
            }
        }
    }

    const visibleText = rawText.replace(tagPattern, '').trim();
    const normalizedVisibleText = normalizeCharacterName(visibleText);

    // 第二优先级：AI 忘记输出标记时，对正文中明确出现的名字兜底匹配。
    // 只使用至少两个字符的姓名，减少“安”“林”等短名误匹配。
    for (const [normalizedName, matches] of candidates) {
        if (normalizedName.length < 2) continue;
        if (!normalizedVisibleText.includes(normalizedName)) continue;

        const highestPriority = Math.max(
            ...matches.map(item => item.priority)
        );
        const strongest = matches.filter(
            item => item.priority === highestPriority
        );

        if (strongest.length !== 1) continue;

        const candidate = strongest[0];

        if (!refs.has(candidate.characterId)) {
            refs.set(candidate.characterId, {
                characterId: candidate.characterId,
                mentionedName: candidate.name,
                matchSource: candidate.source,
                confidence: candidate.source === 'relation'
                    ? 0.95
                    : candidate.source === 'contact'
                        ? 0.85
                        : 0.75
            });
        }
    }

    return {
        text: visibleText,
        characterRefs: [...refs.values()].slice(0, MAX_MENTION_REFS),
        unresolvedMentions: [...unresolvedNames]
            .slice(0, MAX_UNRESOLVED_MENTIONS),
        mentionMarkers: mentionMarkers.slice(0, MAX_MENTION_REFS)
    };
}

function renderMentionMarkers(response) {
    const hasResolved = Array.isArray(response.characterRefs)
        && response.characterRefs.some(ref => ref?.characterId);
    const hasUnresolved = Array.isArray(response.unresolvedMentions)
        && response.unresolvedMentions.length > 0;

    if (!hasResolved && !hasUnresolved) return '';

    const firstMentionedId = hasResolved
        ? response.characterRefs.find(ref => ref?.characterId)?.characterId || ''
        : '';

    return `
        <button
            type="button"
            class="lx-mention-dot"
            data-response-id="${esc(response.id)}"
            data-mentioned-id="${esc(firstMentionedId)}"
            aria-label="查看这条回复的关联信息"
            title="查看关联信息"
        ></button>
    `;
}

function makePairKey(firstId, secondId) {
    return [firstId, secondId].sort().join('::');
}

function makePairTopicId(pairKey, topicId) {
    return `pair:${pairKey}:${topicId}`;
}

function findPairTopicSnapshots(topic) {
    const responses = Array.isArray(topic?.responses)
        ? topic.responses
        : [];

    const responseByAuthor = new Map(
        responses.map(response => [response.authorId, response])
    );

    const result = new Map();

    for (const response of responses) {
        for (const ref of response.characterRefs || []) {
            const authorId = response.authorId;
            const targetId = ref.characterId;

            if (!authorId || !targetId || authorId === targetId) continue;

            // 被提及角色必须确实在同一话题中发表过回复。
            const targetResponse = responseByAuthor.get(targetId);
            if (!targetResponse) continue;

            const pairKey = makePairKey(authorId, targetId);
            const pairTopicId = makePairTopicId(pairKey, topic.id);
            const [firstId, secondId] = [authorId, targetId].sort();

            const firstResponse = authorId === firstId
                ? response
                : targetResponse;
            const secondResponse = authorId === secondId
                ? response
                : targetResponse;

            const firstMentionsSecond = (firstResponse.characterRefs || [])
                .some(item => item.characterId === secondId);
            const secondMentionsFirst = (secondResponse.characterRefs || [])
                .some(item => item.characterId === firstId);

            result.set(pairTopicId, {
                id: pairTopicId,
                pairKey,
                topicId: topic.id,
                characterIds: [firstId, secondId],
                responseIds: [firstResponse.id, secondResponse.id],
                topicSnapshot: {
                    text: topic.text,
                    createdAt: topic.createdAt,
                    authorId: topic.authorId
                },
                responseSnapshots: [firstResponse, secondResponse].map(item => ({
                    responseId: item.id,
                    authorId: item.authorId,
                    text: item.text,
                    topicName: item.topicName || '',
                    anonymousLabel: item.anonymousLabel,
                    characterRefs: (item.characterRefs || [])
                        .map(itemRef => itemRef.characterId)
                        .filter(Boolean)
                })),
                mentionDirection: firstMentionsSecond && secondMentionsFirst
                    ? 'two_way'
                    : 'one_way',
                firstMentionsSecond,
                secondMentionsFirst,
                createdAt: topic.createdAt,
                updatedAt: Date.now(),
                source: 'lingxi'
            });
        }
    }

    return [...result.values()];
}

async function updatePairTopicSnapshots(topic) {
    const snapshots = findPairTopicSnapshots(topic);

    for (const snapshot of snapshots) {
        try {
            await savePairTopicSnapshot(snapshot);
        } catch (error) {
            console.warn('[Lingxi] 保存角色对共同话题失败', error);
        }
    }
}

async function generateCharacterReply(topic, actorId) {
    const context = buildCharacterContext(actorId);
    if (!context) return null;

    const prompt = `${LINGXI_ANONYMOUS_REPLY_PROMPT}

${LINGXI_TOPIC_NAME_PROMPT}

【当前角色资料】
名称：${context.record.base?.name || getActorName(actorId)}
描述：${context.record.base?.desc || '无'}
详细设定：${context.record.base?.detail || '无'}
说话风格：${context.record.base?.style || '无'}

【该角色自己的近期记忆】
${Array.isArray(context.record.memories) && context.record.memories.length
            ? context.record.memories
                .slice(-12)
                .map(memory => `- ${memory?.content || ''}`)
                .filter(Boolean)
                .join('\n')
            : '无'}

【该角色自己的关系认知】
${getRelationContext(actorId, context.record) || '无'}

【该角色自己的认知笔记】
${Object.entries(context.record.cognitiveNotes || {})
            .slice(0, 12)
            .map(([targetId, note]) => `- 关于${getActorName(targetId)}：${note}`)
            .join('\n') || '无'}

【匿名话题】
${topic.text}`;

    try {
        const result = await taskManager.watch(
            'lingxi',
            '灵犀 · 生成匿名回应',
            () => callAI({
                systemPrompt: prompt,
                assistantContext: '',
                maxTokens: 1200
            })
        );

        const rawText = String(result?.content || result || '')
            .replace(
                /【(?:记忆|关系|态度|认知|修改记忆|删除记忆)】[^\n]*/g,
                ''
            )
            .replace(
                /^\s*(?:匿名(?:回应|回复)?[：:]?|回答[：:]?)\s*/i,
                ''
            )
            .trim();

        // 先移除话题名，再解析正文中的角色提及。
        // 防止话题名里的角色姓名被误判为正文提及。
        const namedReply = parseReplyTopicName(rawText);
        const parsed = parseCharacterMentions(namedReply.text, actorId);
        const text = parsed.text.slice(0, 500);

        if (!text) return null;

        return {
            id: createResponseId(),
            authorId: actorId,
            text,
            topicName: namedReply.topicName,
            anonymousLabel: getAnonymousLabel(topic.id, actorId),
            source: 'generated',
            characterRefs: parsed.characterRefs,
            unresolvedMentions: parsed.unresolvedMentions,
            mentionMarkers: parsed.mentionMarkers,
            memoryCandidate: {
                characterId: actorId,
                kind: 'anonymous_expression',
                content: text,
                confidence: 0.5
            }
        };
    } catch (error) {
        console.warn('[Lingxi] 角色回复生成失败', error);
        return null;
    }
}

function findResponseById(responseId) {
    for (const topic of topics) {
        const response = (topic.responses || [])
            .find(item => item.id === responseId);
        if (response) return response;
    }
    return null;
}

function promptAnswerText() {
    return new Promise(resolve => {
        // 防止快速连点叠加多个弹层
        document.querySelector('.lx-answer-overlay')?.remove();

        const overlay = document.createElement('div');
        overlay.className = 'lx-detail-overlay lx-answer-overlay';
        overlay.innerHTML = `
            <div class="lx-mention-detail-card">
                <div class="lx-mention-detail-title">匿名回答</div>
                <div class="lx-mention-detail-caption">
                    以当前角色的匿名身份，写下你的回应
                </div>
                <textarea
                    class="lx-answer-input"
                    maxlength="500"
                    rows="5"
                    placeholder="说点什么……"
                ></textarea>
                <div class="lx-answer-actions">
                    <button class="lx-answer-cancel">取消</button>
                    <button class="lx-answer-submit">发送</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        const textarea = overlay.querySelector('.lx-answer-input');
        const controller = new AbortController();
        const { signal } = controller;

        // 只结算一次，避免取消后又被提交覆盖
        let settled = false;
        function finish(value) {
            if (settled) return;
            settled = true;
            controller.abort();
            overlay.remove();
            resolve(value);
        }

        overlay.querySelector('.lx-answer-submit')
            .addEventListener('click', () => {
                finish(textarea.value);
            }, { signal });

        overlay.querySelector('.lx-answer-cancel')
            .addEventListener('click', () => {
                finish(null);
            }, { signal });

        overlay.addEventListener('click', event => {
            if (event.target === overlay) finish(null);
        }, { signal });

        // 聚焦输入框，方便直接打字
        setTimeout(() => textarea.focus(), 0);
    });
}

function showMentionDetail(response, mentionedId = null) {
    if (!response) return;

    const ref = (response.characterRefs || [])
        .find(item => item.characterId === mentionedId);

    const targetName = ref?.mentionedName ||
        (mentionedId ? getActorName(mentionedId) : '未确认对象');

    let relationInfo = '';

    if (mentionedId && response.authorId) {
        const authorRecord = getCharacterRecordById(response.authorId);
        const targetRecord = getCharacterRecordById(mentionedId);
        const outbound = authorRecord?.relations?.find(
            item => item.id === mentionedId
        );
        const inbound = targetRecord?.relations?.find(
            item => item.id === response.authorId
        );

        const relationRecordStatus = outbound && inbound
            ? '双方都有关系网记录'
            : outbound
                ? '回答者有关系网记录'
                : inbound
                    ? '对方有关系网记录'
                    : '暂无关系网记录';

        relationInfo = `
            <div class="lx-mention-detail-row">
                <span>关系网记录</span>
                <strong>${esc(relationRecordStatus)}</strong>
            </div>
            ${outbound?.relation ? `
                <div class="lx-mention-detail-row">
                    <span>回答者的认知</span>
                    <strong>${esc(outbound.relation)}</strong>
                </div>
            ` : ''}
            ${inbound?.relation ? `
                <div class="lx-mention-detail-row">
                    <span>对方的认知</span>
                    <strong>${esc(inbound.relation)}</strong>
                </div>
            ` : ''}
        `;
    }

    const overlay = document.createElement('div');
    overlay.className = 'lx-detail-overlay';
    overlay.innerHTML = `
        <div class="lx-mention-detail-card">
            <div class="lx-mention-detail-title">🔗 提及详情</div>
            <div class="lx-mention-detail-name">${esc(targetName)}</div>
            <div class="lx-mention-detail-caption">回答者的匿名原文</div>
            <div class="lx-mention-detail-text">${esc(response.text)}</div>
            ${relationInfo}
            <button class="lx-detail-close">关闭</button>
        </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('.lx-detail-close')?.addEventListener(
        'click',
        () => overlay.remove()
    );

    overlay.addEventListener('click', event => {
        if (event.target === overlay) overlay.remove();
    });
}

function topicHtml(topic, activeActorId) {
    const isAuthor = topic.authorId === activeActorId;
    const responses = Array.isArray(topic.responses)
        ? topic.responses
        : [];

    return `
        <article class="lx-topic" data-topic-id="${esc(topic.id)}">
            <div class="lx-topic-head">
                <span class="lx-topic-mark">匿名话题</span>
                <time>${new Date(topic.createdAt).toLocaleString('zh-CN')}</time>
            </div>
            <div class="lx-topic-text">${esc(topic.text)}</div>
            ${isAuthor ? '<div class="lx-topic-note">这是当前角色发布的话题</div>' : ''}
            <div class="lx-response-list">
                ${responses.length
            ? responses.map(response => `
                        <div class="lx-response">
                            ${renderMentionMarkers(response)}
                            <div class="lx-response-label">${esc(response.anonymousLabel || '匿名回应')}</div>
                            <div class="lx-response-text">${esc(response.text)}</div>
                        </div>
                    `).join('')
            : '<div class="lx-empty-response">还没有回应，等一等，也许有人会说些什么。</div>'}
            </div>
            <div class="lx-topic-actions">
                <button class="lx-answer-btn" data-topic-id="${esc(topic.id)}">匿名回答</button>
                <button
                    class="lx-invite-btn"
                    data-topic-id="${esc(topic.id)}"
                    ${invitingTopicIds.has(topic.id) ? 'disabled' : ''}
                >
                    ${invitingTopicIds.has(topic.id) ? '回应生成中…' : '唤起回应'}
                </button>
            </div>
        </article>
    `;
}

function renderPage() {
    const activeActorId = getCurrentActorId(currentGlobalState);
    const activeActorName = activeActorId ? getActorName(activeActorId) : '';

    return `
        <div class="screen-page lx-page">
            <div class="screen-header">
                <div class="screen-title">${title}</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="lx-intro">
                    <div class="lx-intro-icon">🔗</div>
                    <div>
                        <h2>灵犀</h2>
                        <p>一些心事正在匿名地交换。</p>
                    </div>
                </div>

                ${activeActorId ? `
                    <div class="lx-current-actor">
                        当前可操作角色：<strong>${esc(activeActorName)}</strong>
                        <span>只影响谁在操作，不改变角色在灵犀中的身份。</span>
                    </div>
                    <div class="lx-compose">
                        <textarea id="lxTopicInput" maxlength="500" placeholder="投递一句话，向所有可能听见的人发问……"></textarea>
                        <div class="lx-compose-footer">
                            <span>匿名发布</span>
                            <button id="lxPublishBtn">发布话题</button>
                        </div>
                    </div>
                ` : `
                    <div class="lx-no-actor">请先选择一个主视角角色。当前角色只是操作入口，灵犀世界本身不会切换。</div>
                `}

                <div class="lx-section-title">
                    <strong>最近的话题</strong>
                    <button id="lxReloadBtn" title="刷新">↻</button>
                </div>

                <div id="lxTopics" class="lx-topics">
                    ${topics.length
            ? topics.map(topic => topicHtml(topic, activeActorId)).join('')
            : '<div class="lx-empty">还没有话题。第一句可以由你投递。</div>'}
                </div>
            </div>
        </div>
    `;
}

function getLingxiRoot() {
    if (!currentContainer) return null;

    if (currentContainer.matches?.('.lx-page')) {
        return currentContainer;
    }

    return currentContainer.querySelector('.lx-page');
}

function createTopicNode(topic) {
    const template = document.createElement('template');
    const activeActorId = getCurrentActorId(currentGlobalState);

    template.innerHTML = topicHtml(topic, activeActorId).trim();

    return template.content.firstElementChild;
}

function replaceTopicList() {
    const root = getLingxiRoot();
    const list = root?.querySelector('#lxTopics');

    if (!root || !list) return;

    const scrollHost = root.querySelector('.screen-content');
    const scrollTop = scrollHost?.scrollTop || 0;
    const fragment = document.createDocumentFragment();

    if (topics.length) {
        for (const topic of topics) {
            const node = createTopicNode(topic);
            if (node) fragment.appendChild(node);
        }
    } else {
        const empty = document.createElement('div');
        empty.className = 'lx-empty';
        empty.textContent = '还没有话题。第一句可以由你投递。';
        fragment.appendChild(empty);
    }

    list.replaceChildren(fragment);

    if (scrollHost) {
        scrollHost.scrollTop = scrollTop;
    }
}

function insertTopicNode(topic) {
    const root = getLingxiRoot();
    const list = root?.querySelector('#lxTopics');

    if (!list) return;

    list.querySelector('.lx-empty')?.remove();

    const node = createTopicNode(topic);
    if (node) {
        list.prepend(node);
    }
}

function patchTopic(topicId) {
    const root = getLingxiRoot();
    if (!root) return;

    const topic = topics.find(item => item.id === topicId);
    if (!topic) return;

    const oldNode = [...root.querySelectorAll('.lx-topic')]
        .find(node => node.dataset.topicId === topicId);

    // 节点不存在时，通常是话题刚刚加入或页面刚刚刷新。
    // 只重建话题列表，不重建整个灵犀页面。
    if (!oldNode) {
        replaceTopicList();
        return;
    }

    const newNode = createTopicNode(topic);
    if (newNode) {
        oldNode.replaceWith(newNode);
    }
}

function setPublishButtonBusy(isBusy) {
    const root = getLingxiRoot();
    const button = root?.querySelector('#lxPublishBtn');

    if (!button) return;

    button.disabled = isBusy;
    button.textContent = isBusy ? '发布中…' : '发布话题';
}

function isLingxiVisible() {
    const root = getLingxiRoot();
    return Boolean(root?.isConnected);
}

// 保留完整重渲染函数，供真正需要重建页面的场景使用。
// AI 回复循环不再调用它。
function rerender() {
    if (!isLingxiVisible()) return;

    const root = getLingxiRoot();
    const scrollHost = root?.querySelector('.screen-content');
    const scrollTop = scrollHost?.scrollTop || 0;

    currentContainer.innerHTML = renderPage();

    bindEvents(currentContainer, {
        globalState: currentGlobalState
    });

    const nextRoot = getLingxiRoot();
    const nextScrollHost = nextRoot?.querySelector('.screen-content');

    if (nextScrollHost) {
        nextScrollHost.scrollTop = scrollTop;
    }
}

async function reloadTopics() {
    const loaded = await listTopics();

    if (Array.isArray(loaded)) {
        topics = loaded;
        replaceTopicList();
    }

    return topics;
}

async function publishTopic() {
    if (loading) return;

    const actorId = getCurrentActorId(currentGlobalState);
    const input = currentContainer?.querySelector('#lxTopicInput');
    const text = input?.value?.trim();

    if (!actorId) {
        showLingxiToast('请先选择一个主视角角色');
        return;
    }

    if (!text) return;

    loading = true;
    setPublishButtonBusy(true);

    try {
        const topic = await createTopic({
            authorId: actorId,
            text,
            mode: 'character_post'
        });

        if (!topic) return;

        topics = [topic, ...topics].slice(0, 100);

        // 只把新话题插入列表顶部。
        insertTopicNode(topic);

        // 不阻塞当前页面；AI 回复由任务中心继续处理。
        void inviteResponses(topic.id);
    } finally {
        loading = false;
        setPublishButtonBusy(false);
    }
}

async function answerTopic(topicId) {
    const actorId = getCurrentActorId(currentGlobalState);
    const topic = topics.find(item => item.id === topicId);

    if (!actorId || !topic) return;

    if ((topic.responses || []).some(response => response.authorId === actorId)) {
        showLingxiToast('这个角色已经回答过该话题');
        return;
    }

    const input = await promptAnswerText();
    if (!input?.trim()) return;

    const parsed = parseCharacterMentions(input.trim(), actorId);
    const text = parsed.text.slice(0, 500);
    if (!text) return;

    const updated = await addResponse(topicId, {
        id: createResponseId(),
        authorId: actorId,
        text,
        anonymousLabel: getAnonymousLabel(topicId, actorId),
        source: 'manual',
        characterRefs: parsed.characterRefs,
        unresolvedMentions: parsed.unresolvedMentions,
        mentionMarkers: parsed.mentionMarkers,
        memoryCandidate: {
            characterId: actorId,
            kind: 'anonymous_expression',
            content: text,
            confidence: 0.65
        }
    });

    if (updated) {
        topics = topics.map(item =>
            item.id === updated.id ? updated : item
        );

        // 只更新当前话题节点。
        patchTopic(topicId);

        await updatePairTopicSnapshots(updated);
    }
}

async function inviteResponses(topicId) {
    if (invitingTopicIds.has(topicId)) return;

    const topic = topics.find(item => item.id === topicId);
    if (!topic) return;

    const responderIds = chooseResponders(topic);
    if (!responderIds.length) return;

    invitingTopicIds.add(topicId);
    patchTopic(topicId);

    try {
        for (const actorId of responderIds) {
            await delay(randomBetween(
                RESPONSE_DELAY_MIN,
                RESPONSE_DELAY_MAX
            ));

            const response = await generateCharacterReply(topic, actorId);
            if (!response) continue;

            const updated = await addResponse(topicId, response);
            if (!updated) continue;

            topics = topics.map(item =>
                item.id === updated.id ? updated : item
            );

            // AI 每完成一个角色，只替换这一条话题。
            patchTopic(topicId);

            await updatePairTopicSnapshots(updated);
        }
    } finally {
        invitingTopicIds.delete(topicId);
        patchTopic(topicId);
    }
}

export function render(context = {}) {
    currentGlobalState = context.globalState || null;
    return renderPage();
}

function handleLingxiClick(event, pageRoot) {
    const element = event.target instanceof Element
        ? event.target
        : event.target?.parentElement;

    const button = element?.closest('button');

    if (!button || !pageRoot.contains(button)) return;

    if (button.id === 'lxPublishBtn') {
        event.preventDefault();
        void publishTopic();
        return;
    }

    if (button.id === 'lxReloadBtn') {
        event.preventDefault();
        void reloadTopics();
        return;
    }

    const mentionButton = button.closest(
        '.lx-mention-dot, .lx-mention-chip'
    );

    if (mentionButton) {
        event.preventDefault();

        const response = findResponseById(
            mentionButton.dataset.responseId
        );

        if (response) {
            showMentionDetail(
                response,
                mentionButton.dataset.mentionedId || null
            );
        }

        return;
    }

    const answerButton = button.closest('.lx-answer-btn');

    if (answerButton) {
        event.preventDefault();
        void answerTopic(answerButton.dataset.topicId);
        return;
    }

    const inviteButton = button.closest('.lx-invite-btn');

    if (inviteButton && !inviteButton.disabled) {
        event.preventDefault();
        void inviteResponses(inviteButton.dataset.topicId);
    }
}

export function bindEvents(container, context = {}) {
    currentContainer = container;
    currentGlobalState = context.globalState || currentGlobalState;

    const pageRoot = getLingxiRoot();

    if (!pageRoot || boundPageRoots.has(pageRoot)) {
        return;
    }

    boundPageRoots.add(pageRoot);

    pageRoot.addEventListener('click', event => {
        handleLingxiClick(event, pageRoot);
    });
}

// 灵犀不设置后台轮询；这里保留空初始化接口，兼容现有模块注册机制。
export async function init() {
    await reloadTopics();
}

export function handleBack() {
    return false;
}

if (!window.__moduleRegistry) window.__moduleRegistry = [];
window.__moduleRegistry.push({
    id,
    label,
    icon,
    color,
    render,
    bindEvents,
    handleBack,
    init,
    bootInit: true
});

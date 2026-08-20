import {
    getAllCharacterIds,
    getCharacterRecordById,
    getCharacterNameById
} from './characterManager.js';
import { getActiveCharacterId } from '../store/CharacterStore.js';
import { esc } from '../store/utils.js';
import { callAI } from './aiService.js';
import {
    listTopics,
    createTopic,
    addResponse,
    createResponseId
} from '../store/LingxiStore.js';
import { LINGXI_ANONYMOUS_REPLY_PROMPT } from './prompts.js';
import { taskManager } from '../store/AITaskManager.js';

export const id = 'lingxi';
export const label = '灵犀';
export const icon = '🔗';
export const color = '#7c6ac7';
export const title = '🔗 灵犀';

const MAX_RESPONDER_COUNT = 3;
const RESPONSE_DELAY_MIN = 350;
const RESPONSE_DELAY_MAX = 1200;
const invitingTopicIds = new Set();

let topics = [];
let currentContainer = null;
let currentGlobalState = null;
let loading = false;

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

function getRelationContext(actorId, record) {
    const relations = Array.isArray(record?.relations)
        ? record.relations
        : [];

    return relations.slice(0, 20).map(relation => {
        const name = relation.name || relation.id || '某人';
        const parts = [
            `${name}：${relation.relation || '关系未明'}`
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

    const relationText = getRelationContext(actorId, record);

    return {
        record,
        text: [
            `角色名称：${record.base?.name || getActorName(actorId)}`,
            `角色描述：${record.base?.desc || ''}`,
            `详细设定：${record.base?.detail || ''}`,
            `说话风格：${record.base?.style || ''}`,
            `角色记忆：\n${memoryText}`,
            `角色自己的关系认知：\n${relationText}`
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

    return actorIds.slice(0, Math.min(MAX_RESPONDER_COUNT, actorIds.length));
}

async function generateCharacterReply(topic, actorId) {
    const context = buildCharacterContext(actorId);
    if (!context) return null;

    const prompt = `${LINGXI_ANONYMOUS_REPLY_PROMPT}

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
                maxTokens: 220
            })
        );

        const text = String(result?.content || result || '')
            .replace(/【(?:记忆|关系|态度|认知|修改记忆|删除记忆)】[^\n]*/g, '')
            .replace(/^\s*(?:匿名(?:回应|回复)?[：:：]?|回答[：:：]?)\s*/i, '')
            .trim()
            .slice(0, 500);

        if (!text) return null;

        return {
            id: createResponseId(),
            authorId: actorId,
            text,
            anonymousLabel: getAnonymousLabel(topic.id, actorId),
            source: 'generated',
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

function isLingxiVisible() {
    return Boolean(
        currentContainer?.isConnected &&
        currentContainer.querySelector('.lx-page')
    );
}

function rerender() {
    if (!isLingxiVisible()) return;

    currentContainer.innerHTML = renderPage();
    bindEvents(currentContainer, {
        globalState: currentGlobalState
    });
}

async function reloadTopics() {
    topics = await listTopics();
    rerender();
}

async function publishTopic() {
    if (loading) return;

    const actorId = getCurrentActorId(currentGlobalState);
    const input = currentContainer?.querySelector('#lxTopicInput');
    const text = input?.value?.trim();

    if (!actorId) {
        alert('请先选择一个主视角角色');
        return;
    }

    if (!text) return;

    loading = true;
    const button = currentContainer.querySelector('#lxPublishBtn');
    if (button) {
        button.disabled = true;
        button.textContent = '发布中…';
    }

    try {
        const topic = await createTopic({
            authorId: actorId,
            text,
            mode: 'character_post'
        });

        if (!topic) return;

        topics = [topic, ...topics].slice(0, 100);
        rerender();
        await inviteResponses(topic.id);
    } finally {
        loading = false;
    }
}

async function answerTopic(topicId) {
    const actorId = getCurrentActorId(currentGlobalState);
    const topic = topics.find(item => item.id === topicId);
    if (!actorId || !topic) return;

    if ((topic.responses || []).some(response => response.authorId === actorId)) {
        alert('这个角色已经回答过该话题');
        return;
    }

    const text = prompt('以匿名身份回答这个话题：');
    if (!text?.trim()) return;

    const updated = await addResponse(topicId, {
        id: createResponseId(),
        authorId: actorId,
        text: text.trim(),
        anonymousLabel: getAnonymousLabel(topicId, actorId),
        source: 'manual',
        memoryCandidate: {
            characterId: actorId,
            kind: 'anonymous_expression',
            content: text.trim().slice(0, 500),
            confidence: 0.65
        }
    });

    if (updated) {
        topics = topics.map(item => item.id === updated.id ? updated : item);
        rerender();
    }
}

async function inviteResponses(topicId) {
    if (invitingTopicIds.has(topicId)) return;

    const topic = topics.find(item => item.id === topicId);
    if (!topic) return;

    const responderIds = chooseResponders(topic);
    if (!responderIds.length) return;

    invitingTopicIds.add(topicId);
    rerender();

    try {
        for (const actorId of responderIds) {
            await delay(
                randomBetween(
                    RESPONSE_DELAY_MIN,
                    RESPONSE_DELAY_MAX
                )
            );

            const response = await generateCharacterReply(
                topic,
                actorId
            );

            if (!response) continue;

            const updated = await addResponse(
                topicId,
                response
            );

            if (!updated) continue;

            // 即使已经离开灵犀，也要更新模块内存；
            // rerender() 会自行判断灵犀是否仍可见。
            topics = topics.map(item =>
                item.id === updated.id ? updated : item
            );

            rerender();
        }
    } finally {
        invitingTopicIds.delete(topicId);
        rerender();
    }
}

export function render(context = {}) {
    currentGlobalState = context.globalState || null;
    return renderPage();
}

export function bindEvents(container, context = {}) {
    currentContainer = container;
    currentGlobalState = context.globalState || currentGlobalState;

    container.querySelector('#lxPublishBtn')?.addEventListener('click', publishTopic);
    container.querySelector('#lxReloadBtn')?.addEventListener('click', reloadTopics);

    container.querySelectorAll('.lx-answer-btn').forEach(button => {
        button.addEventListener('click', () => answerTopic(button.dataset.topicId));
    });

    container.querySelectorAll('.lx-invite-btn').forEach(button => {
        button.addEventListener('click', () => inviteResponses(button.dataset.topicId));
    });
}

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

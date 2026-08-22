// store/LingxiStore.js
// 灵犀独立存储：公共话题 + 回复 + 角色对共同话题录
// 不写 localStorage，不复制角色资料、头像、关系网或记忆。

const DB_NAME = 'lingxiDB';
const DB_VERSION = 2;

const STORE_TOPICS = 'topics';
const STORE_PAIR_TOPICS = 'pairTopics';

const MAX_TOPICS = 100;
const MAX_RESPONSES = 12;
const MAX_MENTION_REFS = 3;
const MAX_UNRESOLVED_MENTIONS = 3;
const MAX_PAIR_RESPONSE_SNAPSHOTS = 2;

let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = event => {
            const db = event.target.result;

            let topicStore;
            if (db.objectStoreNames.contains(STORE_TOPICS)) {
                topicStore = event.target.transaction.objectStore(STORE_TOPICS);
            } else {
                topicStore = db.createObjectStore(STORE_TOPICS, { keyPath: 'id' });
            }

            if (!topicStore.indexNames.contains('createdAt')) {
                topicStore.createIndex('createdAt', 'createdAt', { unique: false });
            }

            if (!topicStore.indexNames.contains('authorId')) {
                topicStore.createIndex('authorId', 'authorId', { unique: false });
            }

            let pairStore;
            if (db.objectStoreNames.contains(STORE_PAIR_TOPICS)) {
                pairStore = event.target.transaction.objectStore(STORE_PAIR_TOPICS);
            } else {
                pairStore = db.createObjectStore(STORE_PAIR_TOPICS, { keyPath: 'id' });
            }

            if (!pairStore.indexNames.contains('pairKey')) {
                pairStore.createIndex('pairKey', 'pairKey', { unique: false });
            }

            if (!pairStore.indexNames.contains('topicId')) {
                pairStore.createIndex('topicId', 'topicId', { unique: false });
            }

            if (!pairStore.indexNames.contains('updatedAt')) {
                pairStore.createIndex('updatedAt', 'updatedAt', { unique: false });
            }
        };

        request.onsuccess = () => {
            const db = request.result;

            db.onversionchange = () => {
                db.close();
                dbPromise = null;
            };

            resolve(db);
        };

        request.onerror = () => reject(request.error);
    }).catch(error => {
        dbPromise = null;
        throw error;
    });

    return dbPromise;
}

function makeId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve(true);
        transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
        transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
    });
}

function normalizeCharacterRefs(refs) {
    if (!Array.isArray(refs)) return [];

    return refs
        .filter(ref => ref && ref.characterId)
        .slice(0, MAX_MENTION_REFS)
        .map(ref => ({
            characterId: String(ref.characterId),
            mentionedName: String(ref.mentionedName || '').slice(0, 80),
            matchSource: ['relation', 'contact', 'directory'].includes(ref.matchSource)
                ? ref.matchSource
                : 'directory',
            confidence: Math.max(
                0,
                Math.min(1, Number(ref.confidence) || 0)
            )
        }));
}

function normalizeUnresolvedMentions(names) {
    if (!Array.isArray(names)) return [];

    return names
        .map(name => String(name || '').trim().slice(0, 80))
        .filter(Boolean)
        .slice(0, MAX_UNRESOLVED_MENTIONS);
}

function normalizeMentionMarkers(markers) {
    if (!Array.isArray(markers)) return [];

    return markers
        .slice(0, MAX_MENTION_REFS)
        .map(marker => ({
            mentionedName: String(marker.mentionedName || '').slice(0, 80),
            characterId: marker.characterId
                ? String(marker.characterId)
                : null,
            matchSource: marker.matchSource || null,
            confidence: Math.max(
                0,
                Math.min(1, Number(marker.confidence) || 0)
            ),
            resolved: Boolean(marker.resolved)
        }));
}

function normalizeResponse(response, topicId) {
    const text = String(response?.text || '').trim().slice(0, 500);

    return {
        id: String(response?.id || makeId('lx_reply')),
        topicId,
        authorId: String(response?.authorId || ''),
        text,
        anonymousLabel: String(response?.anonymousLabel || '匿名回应').slice(0, 80),
        createdAt: Number(response?.createdAt) || Date.now(),
        source: response?.source === 'manual' ? 'manual' : 'generated',
        characterRefs: normalizeCharacterRefs(response?.characterRefs),
        unresolvedMentions: normalizeUnresolvedMentions(response?.unresolvedMentions),
        mentionMarkers: normalizeMentionMarkers(response?.mentionMarkers),
        memoryCandidate: response?.memoryCandidate || null,
        relationSignals: Array.isArray(response?.relationSignals)
            ? response.relationSignals.slice(0, 5)
            : []
    };
}

function normalizeTopic(topic) {
    return {
        ...topic,
        id: String(topic?.id || makeId('lx_topic')),
        version: Number(topic?.version) || 1,
        mode: String(topic?.mode || 'character_post'),
        authorId: String(topic?.authorId || ''),
        text: String(topic?.text || '').trim().slice(0, 500),
        createdAt: Number(topic?.createdAt) || Date.now(),
        status: topic?.status === 'answered' ? 'answered' : 'open',
        propagation: topic?.propagation || 'anonymous_public',
        responses: Array.isArray(topic?.responses)
            ? topic.responses
                .map(response => normalizeResponse(response, topic.id))
                .filter(response => response.authorId && response.text)
                .slice(-MAX_RESPONSES)
            : []
    };
}

function normalizePairResponseSnapshot(response) {
    return {
        responseId: String(response?.responseId || response?.id || ''),
        authorId: String(response?.authorId || ''),
        text: String(response?.text || '').slice(0, 500),
        anonymousLabel: String(response?.anonymousLabel || '匿名回应').slice(0, 80),
        characterRefs: Array.isArray(response?.characterRefs)
            ? response.characterRefs
                .map(id => String(id || ''))
                .filter(Boolean)
                .slice(0, MAX_MENTION_REFS)
            : []
    };
}

function normalizePairSnapshot(record) {
    const characterIds = Array.isArray(record?.characterIds)
        ? [...new Set(record.characterIds.map(String))].slice(0, 2)
        : [];

    const responseSnapshots = Array.isArray(record?.responseSnapshots)
        ? record.responseSnapshots
            .map(normalizePairResponseSnapshot)
            .filter(item => item.responseId && item.authorId && item.text)
            .slice(0, MAX_PAIR_RESPONSE_SNAPSHOTS)
        : [];

    return {
        id: String(record?.id || ''),
        pairKey: String(record?.pairKey || ''),
        characterIds,
        topicId: String(record?.topicId || ''),
        responseIds: Array.isArray(record?.responseIds)
            ? [...new Set(record.responseIds.map(String))].slice(0, 2)
            : [],
        topicSnapshot: {
            text: String(record?.topicSnapshot?.text || '').slice(0, 500),
            createdAt: Number(record?.topicSnapshot?.createdAt) || Date.now()
        },
        responseSnapshots,
        mentionDirection: record?.mentionDirection === 'two_way'
            ? 'two_way'
            : 'one_way',
        firstMentionsSecond: Boolean(record?.firstMentionsSecond),
        secondMentionsFirst: Boolean(record?.secondMentionsFirst),
        createdAt: Number(record?.createdAt) || Date.now(),
        updatedAt: Number(record?.updatedAt) || Date.now(),
        source: 'lingxi'
    };
}

export function createResponseId() {
    return makeId('lx_reply');
}

export async function listTopics(limit = MAX_TOPICS) {
    try {
        const db = await openDB();

        return await new Promise(resolve => {
            const transaction = db.transaction(STORE_TOPICS, 'readonly');
            const request = transaction.objectStore(STORE_TOPICS)
                .index('createdAt')
                .openCursor(null, 'prev');
            const result = [];

            request.onsuccess = event => {
                const cursor = event.target.result;

                if (!cursor || result.length >= limit) {
                    resolve(result.map(normalizeTopic));
                    return;
                }

                result.push(cursor.value);
                cursor.continue();
            };

            request.onerror = () => resolve([]);
            transaction.onabort = () => resolve([]);
        });
    } catch (error) {
        console.warn('[LingxiStore] 读取话题失败', error);
        return [];
    }
}

export async function getTopic(topicId) {
    if (!topicId) return null;

    try {
        const db = await openDB();

        return await new Promise(resolve => {
            const transaction = db.transaction(STORE_TOPICS, 'readonly');
            const request = transaction.objectStore(STORE_TOPICS).get(topicId);

            request.onsuccess = () => {
                resolve(request.result ? normalizeTopic(request.result) : null);
            };

            request.onerror = () => resolve(null);
            transaction.onabort = () => resolve(null);
        });
    } catch (error) {
        console.warn('[LingxiStore] 读取话题失败', error);
        return null;
    }
}

export async function createTopic({ authorId, text, mode = 'character_post' }) {
    const cleanAuthorId = String(authorId || '').trim();
    const cleanText = String(text || '').trim().slice(0, 500);

    if (!cleanAuthorId || !cleanText) return null;

    const topic = normalizeTopic({
        id: makeId('lx_topic'),
        version: 1,
        mode,
        authorId: cleanAuthorId,
        text: cleanText,
        createdAt: Date.now(),
        status: 'open',
        responses: [],
        propagation: 'anonymous_public'
    });

    try {
        const db = await openDB();
        const transaction = db.transaction(STORE_TOPICS, 'readwrite');
        transaction.objectStore(STORE_TOPICS).put(topic);
        await transactionDone(transaction);
        await pruneTopics();
        return topic;
    } catch (error) {
        console.warn('[LingxiStore] 创建话题失败', error);
        return null;
    }
}

export async function addResponse(topicId, response) {
    const topic = await getTopic(topicId);
    if (!topic) return null;

    const responses = Array.isArray(topic.responses)
        ? topic.responses
        : [];

    if (responses.length >= MAX_RESPONSES) return topic;

    const authorId = String(response?.authorId || '').trim();
    if (!authorId) return topic;

    if (responses.some(item => item.authorId === authorId)) {
        return topic;
    }

    const normalized = normalizeResponse({
        ...response,
        authorId
    }, topicId);

    if (!normalized.text) return topic;

    responses.push(normalized);
    topic.responses = responses.slice(-MAX_RESPONSES);
    topic.status = topic.responses.length >= MAX_RESPONSES
        ? 'answered'
        : 'open';

    try {
        const db = await openDB();
        const transaction = db.transaction(STORE_TOPICS, 'readwrite');
        transaction.objectStore(STORE_TOPICS).put(normalizeTopic(topic));
        await transactionDone(transaction);
        return normalizeTopic(topic);
    } catch (error) {
        console.warn('[LingxiStore] 保存回复失败', error);
        return null;
    }
}

export async function pruneTopics() {
    try {
        const topics = await listTopics(MAX_TOPICS + 20);
        if (topics.length <= MAX_TOPICS) return;

        const db = await openDB();
        const transaction = db.transaction(STORE_TOPICS, 'readwrite');
        const store = transaction.objectStore(STORE_TOPICS);

        for (const topic of topics.slice(MAX_TOPICS)) {
            store.delete(topic.id);
        }

        await transactionDone(transaction);
    } catch (error) {
        console.warn('[LingxiStore] 清理旧话题失败', error);
    }
}

// ============================================================
// 角色对共同话题录
// ============================================================

export async function savePairTopicSnapshot(record) {
    const normalized = normalizePairSnapshot(record);

    if (!normalized.id || !normalized.pairKey || !normalized.topicId) {
        return false;
    }

    try {
        const db = await openDB();
        const transaction = db.transaction(STORE_PAIR_TOPICS, 'readwrite');
        transaction.objectStore(STORE_PAIR_TOPICS).put(normalized);
        await transactionDone(transaction);
        return true;
    } catch (error) {
        console.warn('[LingxiStore] 保存角色对共同话题失败', error);
        return false;
    }
}

export async function getPairTopics(pairKey, limit = 50) {
    if (!pairKey) return [];

    try {
        const db = await openDB();

        return await new Promise(resolve => {
            const transaction = db.transaction(STORE_PAIR_TOPICS, 'readonly');
            const request = transaction.objectStore(STORE_PAIR_TOPICS)
                .index('pairKey')
                .getAll(pairKey);

            request.onsuccess = () => {
                resolve((request.result || [])
                    .map(normalizePairSnapshot)
                    .sort((a, b) => b.updatedAt - a.updatedAt)
                    .slice(0, limit));
            };

            request.onerror = () => resolve([]);
            transaction.onabort = () => resolve([]);
        });
    } catch (error) {
        console.warn('[LingxiStore] 读取角色对共同话题失败', error);
        return [];
    }
}

export async function getPairTopic(pairKey, topicId) {
    if (!pairKey || !topicId) return null;

    const id = `pair:${pairKey}:${topicId}`;

    try {
        const db = await openDB();

        return await new Promise(resolve => {
            const transaction = db.transaction(STORE_PAIR_TOPICS, 'readonly');
            const request = transaction.objectStore(STORE_PAIR_TOPICS).get(id);

            request.onsuccess = () => {
                resolve(request.result
                    ? normalizePairSnapshot(request.result)
                    : null);
            };

            request.onerror = () => resolve(null);
            transaction.onabort = () => resolve(null);
        });
    } catch (error) {
        console.warn('[LingxiStore] 读取单条角色对共同话题失败', error);
        return null;
    }
}

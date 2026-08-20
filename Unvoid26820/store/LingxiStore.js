const DB_NAME = 'lingxiDB';
const DB_VERSION = 1;
const STORE_NAME = 'topics';
const MAX_TOPICS = 100;
const MAX_RESPONSES = 12;

let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = event => {
            const db = event.target.result;
            const store = db.objectStoreNames.contains(STORE_NAME)
                ? event.target.transaction.objectStore(STORE_NAME)
                : db.createObjectStore(STORE_NAME, { keyPath: 'id' });

            if (!store.indexNames.contains('createdAt')) {
                store.createIndex('createdAt', 'createdAt');
            }

            if (!store.indexNames.contains('authorId')) {
                store.createIndex('authorId', 'authorId');
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

function trimTopic(topic) {
    return {
        ...topic,
        text: String(topic.text || '').slice(0, 500),
        responses: Array.isArray(topic.responses)
            ? topic.responses.slice(-MAX_RESPONSES)
            : []
    };
}

function requestToPromise(request, fallback = null) {
    return new Promise(resolve => {
        request.onsuccess = () => resolve(request.result ?? fallback);
        request.onerror = () => resolve(fallback);
    });
}

export async function listTopics(limit = MAX_TOPICS) {
    try {
        const db = await openDB();

        return await new Promise(resolve => {
            const transaction = db.transaction(STORE_NAME, 'readonly');
            const request = transaction.objectStore(STORE_NAME)
                .index('createdAt')
                .openCursor(null, 'prev');
            const result = [];

            request.onsuccess = event => {
                const cursor = event.target.result;
                if (!cursor || result.length >= limit) {
                    resolve(result);
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
    try {
        const db = await openDB();
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const request = transaction.objectStore(STORE_NAME).get(topicId);
        return requestToPromise(request, null);
    } catch (error) {
        console.warn('[LingxiStore] 读取话题失败', error);
        return null;
    }
}

export async function createTopic({ authorId, text, mode = 'character_post' }) {
    const topic = {
        id: makeId('lx_topic'),
        version: 1,
        mode,
        authorId,
        text: String(text || '').trim().slice(0, 500),
        createdAt: Date.now(),
        status: 'open',
        responses: [],
        propagation: 'anonymous_public'
    };

    if (!topic.authorId || !topic.text) return null;

    const db = await openDB();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(topic);

    await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });

    await pruneTopics();
    return topic;
}

export async function addResponse(topicId, response) {
    const topic = await getTopic(topicId);
    if (!topic) return null;

    const responses = Array.isArray(topic.responses)
        ? topic.responses
        : [];

    if (responses.length >= MAX_RESPONSES) return topic;
    if (responses.some(item => item.authorId === response.authorId)) return topic;

    responses.push({
        id: response.id || makeId('lx_reply'),
        topicId,
        authorId: response.authorId,
        text: String(response.text || '').trim().slice(0, 500),
        anonymousLabel: String(response.anonymousLabel || '匿名回应'),
        createdAt: response.createdAt || Date.now(),
        source: response.source || 'generated',
        memoryCandidate: response.memoryCandidate || null,
        relationSignals: Array.isArray(response.relationSignals)
            ? response.relationSignals.slice(0, 5)
            : []
    });

    topic.responses = responses.slice(-MAX_RESPONSES);
    topic.status = topic.responses.length >= MAX_RESPONSES ? 'answered' : 'open';

    const db = await openDB();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(trimTopic(topic));

    await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });

    return topic;
}

export async function pruneTopics() {
    const topics = await listTopics(MAX_TOPICS + 20);
    if (topics.length <= MAX_TOPICS) return;

    const toDelete = topics.slice(MAX_TOPICS);
    const db = await openDB();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    for (const topic of toDelete) {
        store.delete(topic.id);
    }
}

export function createResponseId() {
    return makeId('lx_reply');
}

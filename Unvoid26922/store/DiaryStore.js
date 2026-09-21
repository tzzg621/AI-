// store/DiaryStore.js
// 日记存储层 - 管理角色日记数据

// ========== 常量定义 ==========
const DB_NAME = 'diaryDB';
const DB_VERSION = 1;
const STORE_ENTRIES = 'entries';

// 字段长度限制
const LIMITS = {
    CONTENT: 50000,
    MOOD: 30,
    WEATHER: 30,
    TOPIC: 60,
    MAX_TOPICS: 20,
    KEY_EVENT: 200,
    MAX_KEY_EVENTS: 10
};

// 有效的心情类型
const VALID_MOODS = [
    'happy', 'sad', 'calm', 'excited',
    'anxious', 'angry', 'peaceful', 'confused',
    'nostalgic', 'hopeful', 'tired', 'grateful'
];

// 有效的天气类型
const VALID_WEATHERS = [
    'sunny', 'cloudy', 'rainy', 'snowy',
    'windy', 'foggy', 'stormy', 'clear'
];

// ========== 数据库管理 ==========
let dbPromise = null;
let dbInstance = null;

/**
 * 打开数据库连接
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = event => {
            const db = event.target.result;

            if (!db.objectStoreNames.contains(STORE_ENTRIES)) {
                const entryStore = db.createObjectStore(STORE_ENTRIES, {
                    keyPath: 'id'
                });

                // 创建索引
                entryStore.createIndex('characterId', 'characterId', { unique: false });
                entryStore.createIndex('date', 'date', { unique: false });
                entryStore.createIndex('createdAt', 'createdAt', { unique: false });
            }

            console.log(`[DiaryStore] 数据库升级: v${DB_VERSION}`);
        };

        request.onsuccess = () => {
            dbInstance = request.result;

            dbInstance.onversionchange = () => {
                console.warn('[DiaryStore] 数据库版本变更，关闭连接');
                dbInstance.close();
                dbInstance = null;
                dbPromise = null;
            };

            dbInstance.onclose = () => {
                console.warn('[DiaryStore] 数据库连接已关闭');
                dbInstance = null;
                dbPromise = null;
            };

            resolve(dbInstance);
        };

        request.onerror = () => {
            dbPromise = null;
            const error = request.error || new Error('日记数据库打开失败');
            console.error('[DiaryStore]', error);
            reject(error);
        };

        request.onblocked = () => {
            console.warn('[DiaryStore] 数据库打开被阻止，可能有其他标签页占用');
        };
    });

    return dbPromise;
}

/**
 * 关闭数据库连接
 */
export function closeDB() {
    if (dbInstance) {
        dbInstance.close();
        dbInstance = null;
        dbPromise = null;
        console.log('[DiaryStore] 数据库连接已关闭');
    }
}

// ========== ID 生成 ==========
function generateId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 11);
    const counter = (generateId.counter = (generateId.counter || 0) + 1).toString(36);
    return `diary_${timestamp}_${random}_${counter}`;
}

// ========== 数据验证和标准化 ==========

function limitText(value, maxLength) {
    return String(value ?? '').trim().slice(0, maxLength);
}

function normalizeStringList(value, maxItems, maxLength) {
    const source = Array.isArray(value)
        ? value
        : String(value ?? '').split(/[,，、\n]/);

    const result = [];
    const seen = new Set();

    for (const item of source) {
        const text = String(item ?? '')
            .trim()
            .slice(0, maxLength);

        if (!text || seen.has(text)) continue;

        seen.add(text);
        result.push(text);

        if (result.length >= maxItems) break;
    }

    return result;
}

/**
 * 标准化日记条目
 * @param {Object} input - 输入数据
 * @param {Object|null} existing - 现有数据（用于更新）
 * @returns {Object} 标准化后的日记
 */
function normalizeEntry(input = {}, existing = null) {
    const now = Date.now();

    // 基础字段
    const characterId = limitText(
        input.characterId ?? existing?.characterId,
        180
    );

    const content = limitText(
        input.content ?? existing?.content,
        LIMITS.CONTENT
    );

    const date = limitText(
        input.date ?? existing?.date,
        30
    );

    // 枚举字段
    const mood = VALID_MOODS.includes(input.mood ?? existing?.mood)
        ? (input.mood ?? existing?.mood)
        : 'calm';

    const weather = VALID_WEATHERS.includes(input.weather ?? existing?.weather)
        ? (input.weather ?? existing?.weather)
        : 'clear';

    // 元数据
    const topics = normalizeStringList(
        input.metadata?.topics ?? existing?.metadata?.topics,
        LIMITS.MAX_TOPICS,
        LIMITS.TOPIC
    );

    const keyEvents = normalizeStringList(
        input.metadata?.keyEvents ?? existing?.metadata?.keyEvents,
        LIMITS.MAX_KEY_EVENTS,
        LIMITS.KEY_EVENT
    );

    const emotionalTone = limitText(
        input.metadata?.emotionalTone ?? existing?.metadata?.emotionalTone,
        30
    ) || 'neutral';

    // 时间戳
    const createdAt = Number(input.createdAt ?? existing?.createdAt) || now;

    // 重要标记：不进数据库索引（见 listStarredDiaries 的说明）
    const starred = Boolean(input.starred ?? existing?.starred ?? false);

    // 构建最终对象
    return {
        id: limitText(input.id ?? existing?.id, 180) || generateId(),
        characterId,
        date,
        content,
        mood,
        weather,
        starred,
        createdAt,
        metadata: {
            topics,
            keyEvents,
            emotionalTone
        }
    };
}

/**
 * 标准化从数据库读取的日记
 * @param {Object} entry - 数据库中的日记
 * @returns {Object|null}
 */
function normalizeStoredEntry(entry) {
    if (!entry) return null;

    return {
        ...entry,
        content: String(entry.content || '').trim(),
        metadata: {
            topics: normalizeStringList(
                entry.metadata?.topics,
                LIMITS.MAX_TOPICS,
                LIMITS.TOPIC
            ),
            keyEvents: normalizeStringList(
                entry.metadata?.keyEvents,
                LIMITS.MAX_KEY_EVENTS,
                LIMITS.KEY_EVENT
            ),
            emotionalTone: String(entry.metadata?.emotionalTone || 'neutral').trim()
        }
    };
}

// ========== Promise 包装器 ==========

function requestToPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('请求失败'));
    });
}

function transactionToPromise(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(
            transaction.error || new Error('事务失败')
        );
        transaction.onabort = () => reject(
            transaction.error || new Error('事务已中止')
        );
    });
}

// ========== CRUD 操作 ==========

/**
 * 获取所有日记
 * @param {Object} options - 查询选项
 * @param {string} options.characterId - 按角色筛选
 * @returns {Promise<Array>}
 */
export async function listDiaryEntries({ characterId = null } = {}) {
    const db = await openDB();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_ENTRIES, 'readonly');
        const store = transaction.objectStore(STORE_ENTRIES);

        let request;
        if (characterId) {
            const index = store.index('characterId');
            request = index.getAll(characterId);
        } else {
            request = store.getAll();
        }

        request.onsuccess = () => {
            let entries = Array.isArray(request.result)
                ? request.result.map(normalizeStoredEntry).filter(Boolean)
                : [];

            // 排序：创建时间降序
            entries.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

            resolve(entries);
        };

        request.onerror = () => reject(
            request.error || new Error('获取日记列表失败')
        );
    });
}

/**
 * 获取单个日记
 * @param {string} id - 日记 ID
 * @returns {Promise<Object|null>}
 */
export async function getDiaryEntry(id) {
    if (!id) return null;

    const db = await openDB();
    const transaction = db.transaction(STORE_ENTRIES, 'readonly');
    const request = transaction.objectStore(STORE_ENTRIES).get(id);

    const result = await requestToPromise(request);
    return normalizeStoredEntry(result);
}

/**
 * 保存日记（创建或更新）
 * @param {Object} input - 日记数据
 * @returns {Promise<Object>}
 */
export async function saveDiaryEntry(input) {
    // 获取现有日记（如果是更新）
    const existing = input?.id ? await getDiaryEntry(input.id) : null;

    // 标准化数据
    const entry = normalizeEntry(input, existing);

    // 验证必填字段
    if (!entry.characterId) {
        throw new Error('日记必须关联到角色');
    }

    if (!entry.content) {
        throw new Error('日记内容不能为空');
    }

    if (!entry.date) {
        throw new Error('日记日期不能为空');
    }

    // 保存到数据库
    const db = await openDB();
    const transaction = db.transaction(STORE_ENTRIES, 'readwrite');
    transaction.objectStore(STORE_ENTRIES).put(entry);

    await transactionToPromise(transaction);

    // 触发变更事件
    dispatchChangeEvent({
        type: existing ? 'update' : 'create',
        entry
    });

    console.log(`[DiaryStore] ${existing ? '更新' : '创建'}日记:`, entry.date);

    return entry;
}

/**
 * 删除日记
 * @param {string} id - 日记 ID
 * @returns {Promise<boolean>}
 */
export async function deleteDiaryEntry(id) {
    if (!id) return false;

    const db = await openDB();
    const transaction = db.transaction(STORE_ENTRIES, 'readwrite');
    transaction.objectStore(STORE_ENTRIES).delete(id);

    await transactionToPromise(transaction);

    // 触发变更事件
    dispatchChangeEvent({
        type: 'delete',
        id
    });

    console.log('[DiaryStore] 删除日记:', id);

    return true;
}

/**
 * 获取最近的日记（用于去重）
 * @param {string} characterId - 角色ID
 * @param {number} limit - 获取数量
 * @returns {Promise<Array>}
 */
export async function getRecentDiaries(characterId, limit = 5) {
    const entries = await listDiaryEntries({ characterId });
    return entries.slice(0, limit);
}

/**
 * 某个角色标为「重要」的日记（新→旧）
 *
 * 按 characterId 过滤，不是全局清单：日记是第一人称的私密记录，A 生成日记时
 * 只能看到 A 自己标过的那些——把 B 的重要日记塞进 A 的提示词就是上帝视角
 * （AI/07）。调用方要的也总是「这一位角色的重要日记」。
 *
 * 刻意不加索引：diaryDB 是 v1，加索引得升版本＋写升级逻辑，而日记量级很小，
 * 在 listDiaryEntries 的结果上过滤足够（跟 getRecentDiaries 同一个路数）。
 *
 * @param {string} characterId - 角色ID
 * @returns {Promise<Array>} 该角色标为重要的日记，按 createdAt 降序
 */
export async function listStarredDiaries(characterId) {
    const entries = await listDiaryEntries({ characterId });
    return entries.filter(entry => entry.starred);
}

/**
 * 只改「重要」标记
 *
 * saveDiaryEntry 会用 existing 兜住没传的字段，所以传 { id, starred } 就是一次
 * 轻更新——正文/日期/心情都不会被覆盖掉，也不用调用方先把整篇读出来。
 *
 * @param {string} id - 日记ID
 * @param {boolean} starred - 是否标为重要
 * @returns {Promise<Object>} 更新后的日记
 */
export async function setDiaryStarred(id, starred) {
    return saveDiaryEntry({ id, starred: Boolean(starred) });
}

// ========== 事件系统 ==========

/**
 * 触发数据变更事件
 * @param {Object} detail - 事件详情
 */
function dispatchChangeEvent(detail) {
    if (typeof window !== 'undefined') {
        window.dispatchEvent(
            new CustomEvent('diary-changed', { detail })
        );
    }
}

/**
 * 监听数据变更
 * @param {Function} callback - 回调函数
 * @returns {Function} 取消监听的函数
 */
export function onDiaryChange(callback) {
    const handler = event => callback(event.detail);
    window.addEventListener('diary-changed', handler);
    return () => window.removeEventListener('diary-changed', handler);
}

// ========== 工具函数 ==========

/**
 * 获取数据库状态
 * @returns {Promise<Object>}
 */
export async function getDatabaseStatus() {
    try {
        const db = await openDB();
        const entries = await listDiaryEntries();

        return {
            connected: true,
            dbName: DB_NAME,
            version: DB_VERSION,
            totalEntries: entries.length
        };
    } catch (error) {
        return {
            connected: false,
            error: error.message
        };
    }
}

console.log('[DiaryStore] 模块已加载');

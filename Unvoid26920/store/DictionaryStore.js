// store/DictionaryStore.js - 优化版
// 世界词典底层存储
// 只负责 IndexedDB，不依赖页面、不操作 DOM、不写 localStorage

// ========== 常量定义 ==========
const DB_NAME = 'worldDictionaryDB';
const DB_VERSION = 2; // 升级版本号
const STORE_ENTRIES = 'entries';
const STORE_METADATA = 'metadata'; // 新增：元数据存储

// 字段长度限制
const LIMITS = {
    TITLE: 120,
    CONTENT: 12000,
    KEYWORDS: 30,
    KEYWORD_LENGTH: 60,
    CATEGORIES: 12,
    CATEGORY_LENGTH: 30,
    SCOPE_ID: 180,
    SCOPE_REF: 360,
    SOURCE: 40,
    SOURCE_REF: 300
};

// 有效的枚举值
const VALID_KINDS = [
    'world_fact',
    'character_belief',
    'event',
    'character_profile',
    'world_rule'
];

const VALID_POLICIES = ['manual', 'suggest', 'auto'];
const VALID_SCOPE_TYPES = ['global', 'character', 'chat'];

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
            const oldVersion = event.oldVersion;

            // 创建词条存储
            if (!db.objectStoreNames.contains(STORE_ENTRIES)) {
                const entryStore = db.createObjectStore(STORE_ENTRIES, {
                    keyPath: 'id'
                });

                // 创建索引
                entryStore.createIndex('updatedAt', 'updatedAt', { unique: false });
                entryStore.createIndex('enabled', 'enabled', { unique: false });
                entryStore.createIndex('kind', 'kind', { unique: false });
                entryStore.createIndex('priority', 'priority', { unique: false });
                entryStore.createIndex('scopeType', 'scope.type', { unique: false });
            }

            // 版本 2：添加元数据存储
            if (oldVersion < 2 && !db.objectStoreNames.contains(STORE_METADATA)) {
                db.createObjectStore(STORE_METADATA, {
                    keyPath: 'key'
                });
            }

            console.log(`[DictionaryStore] 数据库升级: v${oldVersion} -> v${DB_VERSION}`);
        };

        request.onsuccess = () => {
            dbInstance = request.result;

            // 处理版本变更
            dbInstance.onversionchange = () => {
                console.warn('[DictionaryStore] 数据库版本变更，关闭连接');
                dbInstance.close();
                dbInstance = null;
                dbPromise = null;
            };

            // 处理意外关闭
            dbInstance.onclose = () => {
                console.warn('[DictionaryStore] 数据库连接已关闭');
                dbInstance = null;
                dbPromise = null;
            };

            resolve(dbInstance);
        };

        request.onerror = () => {
            dbPromise = null;
            const error = request.error || new Error('世界词典数据库打开失败');
            console.error('[DictionaryStore]', error);
            reject(error);
        };

        request.onblocked = () => {
            console.warn('[DictionaryStore] 数据库打开被阻止，可能有其他标签页占用');
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
        console.log('[DictionaryStore] 数据库连接已关闭');
    }
}

// ========== ID 生成 ==========
/**
 * 生成唯一 ID
 * @returns {string}
 */
function generateId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 11);
    const counter = (generateId.counter = (generateId.counter || 0) + 1).toString(36);
    return `dict_${timestamp}_${random}_${counter}`;
}

// ========== 数据验证和标准化 ==========

/**
 * 限制文本长度
 * @param {any} value - 输入值
 * @param {number} maxLength - 最大长度
 * @returns {string}
 */
function limitText(value, maxLength) {
    return String(value ?? '').trim().slice(0, maxLength);
}

/**
 * 标准化字符串列表
 * @param {any} value - 输入值（数组或字符串）
 * @param {number} maxItems - 最大项数
 * @param {number} maxLength - 每项最大长度
 * @returns {string[]}
 */
function normalizeStringList(value, maxItems, maxLength) {
    // 支持数组或分隔符分隔的字符串
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
 * 标准化类别列表
 * @param {any} value - 输入值
 * @returns {string[]}
 */
function normalizeCategories(value) {
    return normalizeStringList(
        value,
        LIMITS.CATEGORIES,
        LIMITS.CATEGORY_LENGTH
    );
}

/**
 * 标准化作用域
 * @param {Object} scope - 作用域对象
 * @returns {Object}
 */
function normalizeScope(scope) {
    const input = scope && typeof scope === 'object' ? scope : {};

    const type = VALID_SCOPE_TYPES.includes(input.type)
        ? input.type
        : 'global';

    const normalized = { type };

    if (type === 'character') {
        normalized.characterId = limitText(input.characterId, LIMITS.SCOPE_ID) || '';
        normalized.characterNameSnapshot = limitText(
            input.characterNameSnapshot,
            LIMITS.TITLE
        );
    } else if (type === 'chat') {
        normalized.pairKey = limitText(input.pairKey, LIMITS.SCOPE_REF) || '';
    }

    return normalized;
}

/**
 * 验证和标准化词条数据
 * @param {Object} input - 输入数据
 * @param {Object|null} existing - 现有数据（用于更新）
 * @returns {Object} 标准化后的词条
 */
function normalizeEntry(input = {}, existing = null) {
    const now = Date.now();

    // 基础字段
    const title = limitText(
        input.title ?? existing?.title,
        LIMITS.TITLE
    );

    const content = limitText(
        input.content ?? existing?.content,
        LIMITS.CONTENT
    );

    // 列表字段
    const keywords = normalizeStringList(
        input.keywords ?? existing?.keywords,
        LIMITS.KEYWORDS,
        LIMITS.KEYWORD_LENGTH
    );

    const aliases = normalizeStringList(
        input.aliases ?? existing?.aliases,
        LIMITS.KEYWORDS,
        LIMITS.KEYWORD_LENGTH
    );

    const categories = normalizeCategories(
        input.categories ?? existing?.categories
    );

    // 枚举字段
    const kind = VALID_KINDS.includes(input.kind ?? existing?.kind)
        ? (input.kind ?? existing?.kind)
        : 'world_fact';

    const updatePolicy = VALID_POLICIES.includes(
        input.updatePolicy ?? existing?.updatePolicy
    )
        ? (input.updatePolicy ?? existing?.updatePolicy)
        : 'manual';

    // 数字字段
    const priorityValue = Number(
        input.priority ?? existing?.priority ?? 50
    );
    const priority = Number.isFinite(priorityValue)
        ? Math.max(0, Math.min(100, Math.round(priorityValue)))
        : 50;

    const confidenceValue = Number(
        input.confidence ?? existing?.confidence ?? 1
    );
    const confidence = Number.isFinite(confidenceValue)
        ? Math.max(0, Math.min(1, confidenceValue))
        : 1;

    // 作用域
    const scope = normalizeScope(input.scope ?? existing?.scope);

    // 元数据
    const source = limitText(
        input.source ?? existing?.source,
        LIMITS.SOURCE
    ) || 'manual';

    const sourceRef = limitText(
        input.sourceRef ?? existing?.sourceRef,
        LIMITS.SOURCE_REF
    );

    // 时间戳
    const createdAt = Number(input.createdAt ?? existing?.createdAt) || now;

    // 构建最终对象
    return {
        id: limitText(input.id ?? existing?.id, LIMITS.SCOPE_ID) || generateId(),
        title,
        content,
        keywords,
        aliases,
        categories,
        kind,
        scope,
        priority,
        enabled: input.enabled ?? existing?.enabled ?? true,
        source,
        sourceRef,
        updatePolicy,
        confidence,
        createdAt,
        updatedAt: now,
        // 保留自定义元数据
        metadata: input.metadata ?? existing?.metadata ?? {}
    };
}

/**
 * 标准化从数据库读取的词条
 * @param {Object} entry - 数据库中的词条
 * @returns {Object|null}
 */
function normalizeStoredEntry(entry) {
    if (!entry) return null;

    return {
        ...entry,
        title: String(entry.title || '').trim(),
        content: String(entry.content || '').trim(),
        keywords: normalizeStringList(
            entry.keywords,
            LIMITS.KEYWORDS,
            LIMITS.KEYWORD_LENGTH
        ),
        aliases: normalizeStringList(
            entry.aliases,
            LIMITS.KEYWORDS,
            LIMITS.KEYWORD_LENGTH
        ),
        categories: normalizeCategories(entry.categories),
        enabled: entry.enabled !== false,
        priority: Number.isFinite(Number(entry.priority))
            ? Number(entry.priority)
            : 50,
        confidence: Number.isFinite(Number(entry.confidence))
            ? Number(entry.confidence)
            : 1,
        scope: normalizeScope(entry.scope),
        metadata: entry.metadata || {}
    };
}

// ========== Promise 包装器 ==========

/**
 * 将 IDBRequest 转换为 Promise
 * @param {IDBRequest} request
 * @returns {Promise}
 */
function requestToPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('请求失败'));
    });
}

/**
 * 将 IDBTransaction 转换为 Promise
 * @param {IDBTransaction} transaction
 * @returns {Promise}
 */
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
 * 获取所有词条
 * @param {Object} options - 查询选项
 * @param {boolean} options.includeDisabled - 是否包含已停用词条
 * @param {string} options.kind - 按类型筛选
 * @param {string} options.scopeType - 按作用域类型筛选
 * @returns {Promise<Array>}
 */
export async function listDictionaryEntries({
    includeDisabled = true,
    kind = null,
    scopeType = null
} = {}) {
    const db = await openDB();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_ENTRIES, 'readonly');
        const store = transaction.objectStore(STORE_ENTRIES);
        const request = store.getAll();

        request.onsuccess = () => {
            let entries = Array.isArray(request.result)
                ? request.result.map(normalizeStoredEntry).filter(Boolean)
                : [];

            // 应用过滤器
            if (!includeDisabled) {
                entries = entries.filter(entry => entry.enabled !== false);
            }

            if (kind) {
                entries = entries.filter(entry => entry.kind === kind);
            }

            if (scopeType) {
                entries = entries.filter(
                    entry => entry.scope?.type === scopeType
                );
            }

            // 排序：优先级降序 -> 更新时间降序
            entries.sort((a, b) => {
                if (b.priority !== a.priority) {
                    return b.priority - a.priority;
                }
                return (b.updatedAt || 0) - (a.updatedAt || 0);
            });

            resolve(entries);
        };

        request.onerror = () => reject(
            request.error || new Error('获取词条列表失败')
        );
    });
}

/**
 * 获取单个词条
 * @param {string} id - 词条 ID
 * @returns {Promise<Object|null>}
 */
export async function getDictionaryEntry(id) {
    if (!id) return null;

    const db = await openDB();
    const transaction = db.transaction(STORE_ENTRIES, 'readonly');
    const request = transaction.objectStore(STORE_ENTRIES).get(id);

    const result = await requestToPromise(request);
    return normalizeStoredEntry(result);
}

/**
 * 保存词条（创建或更新）
 * @param {Object} input - 词条数据
 * @returns {Promise<Object>}
 */
export async function saveDictionaryEntry(input) {
    // 获取现有词条（如果是更新）
    const existing = input?.id ? await getDictionaryEntry(input.id) : null;

    // 标准化数据
    const entry = normalizeEntry(input, existing);

    // 验证必填字段
    if (!entry.title) {
        throw new Error('词条名称不能为空');
    }

    if (!entry.content) {
        throw new Error('词条内容不能为空');
    }

    // 验证作用域
    if (entry.scope.type === 'character' && !entry.scope.characterId) {
        throw new Error('角色作用域需要指定角色 ID');
    }

    if (entry.scope.type === 'chat' && !entry.scope.pairKey) {
        throw new Error('聊天作用域需要指定聊天标识');
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

    console.log(`[DictionaryStore] ${existing ? '更新' : '创建'}词条:`, entry.title);

    return entry;
}

/**
 * 删除词条
 * @param {string} id - 词条 ID
 * @returns {Promise<boolean>}
 */
export async function deleteDictionaryEntry(id) {
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

    console.log('[DictionaryStore] 删除词条:', id);

    return true;
}

/**
 * 批量删除词条
 * @param {string[]} ids - 词条 ID 数组
 * @returns {Promise<number>} 删除的数量
 */
export async function bulkDeleteEntries(ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
        return 0;
    }

    const db = await openDB();
    const transaction = db.transaction(STORE_ENTRIES, 'readwrite');
    const store = transaction.objectStore(STORE_ENTRIES);

    let deleted = 0;
    for (const id of ids) {
        if (id) {
            store.delete(id);
            deleted++;
        }
    }

    await transactionToPromise(transaction);

    // 触发变更事件
    dispatchChangeEvent({
        type: 'bulk_delete',
        ids,
        count: deleted
    });

    console.log(`[DictionaryStore] 批量删除 ${deleted} 个词条`);

    return deleted;
}

/**
 * 设置词条启用状态
 * @param {string} id - 词条 ID
 * @param {boolean} enabled - 是否启用
 * @returns {Promise<Object>}
 */
export async function setDictionaryEntryEnabled(id, enabled) {
    const entry = await getDictionaryEntry(id);

    if (!entry) {
        throw new Error('词条不存在');
    }

    return saveDictionaryEntry({
        ...entry,
        enabled: Boolean(enabled)
    });
}

/**
 * 批量更新词条
 * @param {Object[]} entries - 词条数组
 * @returns {Promise<number>} 更新的数量
 */
export async function bulkUpdateEntries(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
        return 0;
    }

    const db = await openDB();
    const transaction = db.transaction(STORE_ENTRIES, 'readwrite');
    const store = transaction.objectStore(STORE_ENTRIES);

    let updated = 0;
    for (const input of entries) {
        try {
            const existing = await getDictionaryEntry(input.id);
            const entry = normalizeEntry(input, existing);
            store.put(entry);
            updated++;
        } catch (error) {
            console.error('[DictionaryStore] 批量更新失败:', input.id, error);
        }
    }

    await transactionToPromise(transaction);

    // 触发变更事件
    dispatchChangeEvent({
        type: 'bulk_update',
        count: updated
    });

    console.log(`[DictionaryStore] 批量更新 ${updated} 个词条`);

    return updated;
}

// ========== 元数据操作 ==========

/**
 * 保存元数据
 * @param {string} key - 键
 * @param {any} value - 值
 * @returns {Promise<void>}
 */
export async function setMetadata(key, value) {
    const db = await openDB();
    const transaction = db.transaction(STORE_METADATA, 'readwrite');
    transaction.objectStore(STORE_METADATA).put({
        key,
        value,
        updatedAt: Date.now()
    });

    await transactionToPromise(transaction);
}

/**
 * 获取元数据
 * @param {string} key - 键
 * @returns {Promise<any>}
 */
export async function getMetadata(key) {
    const db = await openDB();
    const transaction = db.transaction(STORE_METADATA, 'readonly');
    const request = transaction.objectStore(STORE_METADATA).get(key);

    const result = await requestToPromise(request);
    return result?.value;
}

// ========== 导入导出 ==========

/**
 * 导出所有词条为 JSON
 * @returns {Promise<string>}
 */
export async function exportDictionary() {
    const entries = await listDictionaryEntries({
        includeDisabled: true
    });

    const exportData = {
        version: DB_VERSION,
        exportedAt: new Date().toISOString(),
        count: entries.length,
        entries
    };

    return JSON.stringify(exportData, null, 2);
}

/**
 * 从 JSON 导入词条
 * @param {string} jsonData - JSON 字符串
 * @param {Object} options - 导入选项
 * @param {boolean} options.replace - 是否替换现有词条
 * @returns {Promise<Object>} 导入结果
 */
export async function importDictionary(jsonData, { replace = false } = {}) {
    const data = JSON.parse(jsonData);

    if (!data.entries || !Array.isArray(data.entries)) {
        throw new Error('无效的导入数据格式');
    }

    const result = {
        total: data.entries.length,
        imported: 0,
        skipped: 0,
        errors: []
    };

    for (const entry of data.entries) {
        try {
            const existing = await getDictionaryEntry(entry.id);

            if (existing && !replace) {
                result.skipped++;
                continue;
            }

            await saveDictionaryEntry(entry);
            result.imported++;
        } catch (error) {
            result.errors.push({
                entry: entry.title || entry.id,
                error: error.message
            });
        }
    }

    console.log('[DictionaryStore] 导入完成:', result);

    return result;
}

// ========== 事件系统 ==========

/**
 * 触发数据变更事件
 * @param {Object} detail - 事件详情
 */
function dispatchChangeEvent(detail) {
    if (typeof window !== 'undefined') {
        window.dispatchEvent(
            new CustomEvent('world-dictionary-changed', { detail })
        );
    }
}

/**
 * 监听数据变更
 * @param {Function} callback - 回调函数
 * @returns {Function} 取消监听的函数
 */
export function onDictionaryChange(callback) {
    const handler = event => callback(event.detail);
    window.addEventListener('world-dictionary-changed', handler);
    return () => window.removeEventListener('world-dictionary-changed', handler);
}

// ========== 工具函数导出 ==========

/**
 * 标准化词条（供外部使用）
 * @param {Object} input - 输入数据
 * @returns {Object}
 */
export function normalizeDictionaryEntry(input) {
    return normalizeEntry(input, null);
}

/**
 * 获取数据库状态
 * @returns {Promise<Object>}
 */
export async function getDatabaseStatus() {
    try {
        const db = await openDB();
        const entries = await listDictionaryEntries({ includeDisabled: true });

        return {
            connected: true,
            dbName: DB_NAME,
            version: DB_VERSION,
            totalEntries: entries.length,
            enabledEntries: entries.filter(e => e.enabled !== false).length
        };
    } catch (error) {
        return {
            connected: false,
            error: error.message
        };
    }
}

/**
 * 清空所有词条（危险操作）
 * @returns {Promise<number>} 删除的数量
 */
export async function clearAllEntries() {
    const entries = await listDictionaryEntries({ includeDisabled: true });
    const ids = entries.map(e => e.id);
    return bulkDeleteEntries(ids);
}

// ========== 初始化日志 ==========
console.log('[DictionaryStore] 模块已加载');
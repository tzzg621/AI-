// store/TeaHouseStore.js
// 茶舍独立故事库：直接使用 IndexedDB。
// 角色只以 ID 形式被故事引用；不写入 CharacterStore，也不复制角色资料。

const DB_NAME = 'teaHouseDB';
const DB_VERSION = 1;

const STORIES_STORE = 'stories';
const META_STORE = 'meta';

const LEGACY_STORAGE_KEY = 'bookclub_novels';
const LEGACY_MIGRATION_META_KEY = 'legacy-bookclub-novels-migrated';

const STORY_VERSION = 2;

let dbPromise = null;

/* -------------------------------------------------------------------------- */
/* 基础工具                                                                    */
/* -------------------------------------------------------------------------- */

function createId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
}

function nowISO() {
    return new Date().toISOString();
}

function asText(value, fallback = '') {
    if (value === null || value === undefined) return fallback;
    return String(value);
}

function uniqueStringIds(values) {
    if (!Array.isArray(values)) return [];

    return [
        ...new Set(
            values
                .map(value => String(value || '').trim())
                .filter(Boolean)
        )
    ];
}

function normalizeChapter(rawChapter, index = 0) {
    const chapter = rawChapter && typeof rawChapter === 'object'
        ? rawChapter
        : {};

    const normalized = {
        id: asText(chapter.id, createId('fold')),
        title: asText(chapter.title, `第${index + 1}折`),
        content: asText(chapter.content),
        summary: asText(chapter.summary),
        createdAt: chapter.createdAt || nowISO(),
        updatedAt: chapter.updatedAt || chapter.createdAt || nowISO()
    };

    // AI 续写中的临时占位状态需要被保留，
    // 浏览器刷新、模块切换后仍能正确显示。
    if (chapter._generating) {
        normalized._generating = true;
    }

    return normalized;
}

/**
 * 兼容旧书社作品，以及确保新茶舍剧目字段完整。
 *
 * 旧作品中的 author 会转存为 legacyAuthor，仅用于兼容展示；
 * 新剧目不再使用 author，实际创作者默认是缔造者。
 */
export function normalizeStory(rawStory) {
    const story = rawStory && typeof rawStory === 'object'
        ? rawStory
        : {};

    return {
        id: asText(story.id, createId('story')),
        version: STORY_VERSION,

        title: asText(story.title, '未命名剧目'),
        emoji: asText(story.emoji, '📜'),
        synopsis: asText(story.synopsis),
        writingStyle: asText(story.writingStyle),
        notes: asText(story.notes),

        // 只兼容旧书社作品；新建故事一般为空。
        legacyAuthor: asText(
            story.legacyAuthor ?? story.author,
            ''
        ),

        // 角色关联只保存角色 ID，故事本身不属于角色。
        narratorCharacterId: asText(story.narratorCharacterId, ''),
        relatedCharacterIds: uniqueStringIds(story.relatedCharacterIds),

        source: asText(story.source, 'creator'),
        status: asText(story.status, 'published'),

        chapters: Array.isArray(story.chapters)
            ? story.chapters.map(normalizeChapter)
            : [],

        createdAt: story.createdAt || nowISO(),
        updatedAt: story.updatedAt || story.createdAt || nowISO()
    };
}

function requestAsPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(
            transaction.error || new Error('IndexedDB transaction aborted')
        );
    });
}

/* -------------------------------------------------------------------------- */
/* 数据库初始化                                                                  */
/* -------------------------------------------------------------------------- */

export function openTeaHouseDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = event => {
            const db = event.target.result;

            let stories;

            if (!db.objectStoreNames.contains(STORIES_STORE)) {
                stories = db.createObjectStore(STORIES_STORE, {
                    keyPath: 'id'
                });
            } else {
                stories = event.target.transaction.objectStore(STORIES_STORE);
            }

            // 这些索引当前不是所有读取路径都必须使用，
            // 但能为后续故事筛选、时间线、事件剧场提供基础。
            if (!stories.indexNames.contains('updatedAt')) {
                stories.createIndex('updatedAt', 'updatedAt', {
                    unique: false
                });
            }

            if (!stories.indexNames.contains('narratorCharacterId')) {
                stories.createIndex(
                    'narratorCharacterId',
                    'narratorCharacterId',
                    { unique: false }
                );
            }

            if (!stories.indexNames.contains('relatedCharacterIds')) {
                stories.createIndex(
                    'relatedCharacterIds',
                    'relatedCharacterIds',
                    {
                        unique: false,
                        multiEntry: true
                    }
                );
            }

            if (!db.objectStoreNames.contains(META_STORE)) {
                db.createObjectStore(META_STORE, {
                    keyPath: 'key'
                });
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

        request.onerror = () => {
            dbPromise = null;
            reject(request.error);
        };

        request.onblocked = () => {
            console.warn(
                '[茶舍] IndexedDB 升级被其他页面阻塞，请关闭同站点的旧页面后重试。'
            );
        };
    });

    return dbPromise;
}

/* -------------------------------------------------------------------------- */
/* meta                                                                         */
/* -------------------------------------------------------------------------- */

async function getMeta(key) {
    const db = await openTeaHouseDB();
    const transaction = db.transaction(META_STORE, 'readonly');
    const request = transaction.objectStore(META_STORE).get(key);
    const record = await requestAsPromise(request);

    return record?.value ?? null;
}

async function putMeta(key, value) {
    const db = await openTeaHouseDB();
    const transaction = db.transaction(META_STORE, 'readwrite');

    transaction.objectStore(META_STORE).put({
        key,
        value,
        updatedAt: nowISO()
    });

    await transactionDone(transaction);
}

/* -------------------------------------------------------------------------- */
/* 一次性旧数据迁移                                                             */
/* -------------------------------------------------------------------------- */

/**
 * 将旧 bookclub_novels 从 localStorage 安全迁移到 teaHouseDB。
 *
 * 原则：
 * 1. 已迁移则不再重复导入；
 * 2. 若 IndexedDB 已有 stories，也不把旧数据重复灌入；
 * 3. 只有事务完整成功后，才删除旧 localStorage；
 * 4. localStorage 读取或迁移失败时，旧数据保留。
 */
export async function migrateLegacyBookClubData() {
    const migrated = await getMeta(LEGACY_MIGRATION_META_KEY);

    if (migrated) {
        return {
            migrated: false,
            reason: 'already-migrated'
        };
    }

    let legacyStories = [];

    try {
        const raw = localStorage.getItem(LEGACY_STORAGE_KEY);

        if (raw) {
            const parsed = JSON.parse(raw);
            legacyStories = Array.isArray(parsed)
                ? parsed.map(normalizeStory)
                : [];
        }
    } catch (error) {
        console.warn('[茶舍] 旧书社数据读取失败，已跳过迁移：', error);

        // 标记已检查，避免每次打开都重复解析损坏数据；
        // 损坏的 localStorage 原始内容不主动删除。
        await putMeta(LEGACY_MIGRATION_META_KEY, {
            checkedAt: nowISO(),
            migratedCount: 0,
            reason: 'legacy-data-invalid'
        });

        return {
            migrated: false,
            reason: 'legacy-data-invalid'
        };
    }

    const db = await openTeaHouseDB();
    const countTransaction = db.transaction(STORIES_STORE, 'readonly');
    const storyCount = await requestAsPromise(
        countTransaction.objectStore(STORIES_STORE).count()
    );

    // IndexedDB 已经有剧目时，默认不合并旧 localStorage，
    // 避免在用户恢复备份、重复打开旧版本时产生重复内容。
    if (storyCount > 0) {
        await putMeta(LEGACY_MIGRATION_META_KEY, {
            checkedAt: nowISO(),
            migratedCount: 0,
            reason: 'indexeddb-not-empty'
        });

        return {
            migrated: false,
            reason: 'indexeddb-not-empty'
        };
    }

    // 没有旧数据也记录检查状态，避免每次初始化都读 localStorage。
    if (legacyStories.length === 0) {
        await putMeta(LEGACY_MIGRATION_META_KEY, {
            checkedAt: nowISO(),
            migratedCount: 0,
            reason: 'no-legacy-data'
        });

        return {
            migrated: false,
            reason: 'no-legacy-data'
        };
    }

    const transaction = db.transaction(
        [STORIES_STORE, META_STORE],
        'readwrite'
    );

    const storiesStore = transaction.objectStore(STORIES_STORE);
    const metaStore = transaction.objectStore(META_STORE);

    for (const story of legacyStories) {
        storiesStore.put(story);
    }

    metaStore.put({
        key: LEGACY_MIGRATION_META_KEY,
        value: {
            checkedAt: nowISO(),
            migratedCount: legacyStories.length,
            reason: 'migrated'
        },
        updatedAt: nowISO()
    });

    await transactionDone(transaction);

    // 只有 IDB 完整提交成功才删除旧数据。
    try {
        localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch (error) {
        // 即使无法删除也不影响迁移结果；
        // 因 meta 标记存在，下次不会重复导入。
        console.warn('[茶舍] 新数据已迁移，但旧 localStorage 未能清除：', error);
    }

    return {
        migrated: true,
        count: legacyStories.length
    };
}

/**
 * 茶舍模块启动入口。
 * 可重复调用；迁移标记会确保旧数据只处理一次。
 */
export async function initTeaHouseStore() {
    await openTeaHouseDB();
    return migrateLegacyBookClubData();
}

/* -------------------------------------------------------------------------- */
/* stories：增删改查                                                            */
/* -------------------------------------------------------------------------- */

export async function getAllStories() {
    const db = await openTeaHouseDB();
    const transaction = db.transaction(STORIES_STORE, 'readonly');

    const stories = await requestAsPromise(
        transaction.objectStore(STORIES_STORE).getAll()
    );

    return (stories || [])
        .map(normalizeStory)
        .sort((first, second) => {
            const firstTime = new Date(
                first.updatedAt || first.createdAt || 0
            ).getTime();

            const secondTime = new Date(
                second.updatedAt || second.createdAt || 0
            ).getTime();

            return secondTime - firstTime;
        });
}

export async function getStory(storyId) {
    if (!storyId) return null;

    const db = await openTeaHouseDB();
    const transaction = db.transaction(STORIES_STORE, 'readonly');

    const story = await requestAsPromise(
        transaction.objectStore(STORIES_STORE).get(String(storyId))
    );

    return story ? normalizeStory(story) : null;
}

/**
 * 保存完整剧目。
 *
 * 当前故事与折子一体保存：一次编辑只会写这一条 story record，
 * 不会影响其他故事。
 */
export async function saveStory(story) {
    const normalized = normalizeStory({
        ...story,
        updatedAt: nowISO()
    });

    const db = await openTeaHouseDB();
    const transaction = db.transaction(STORIES_STORE, 'readwrite');

    transaction.objectStore(STORIES_STORE).put(normalized);

    await transactionDone(transaction);
    return normalized;
}

export async function createStory(initialData = {}) {
    const createdAt = nowISO();

    const story = normalizeStory({
        id: createId('story'),
        version: STORY_VERSION,
        emoji: '📜',
        source: 'creator',
        status: 'published',
        chapters: [],
        ...initialData,
        createdAt,
        updatedAt: createdAt
    });

    return saveStory(story);
}

export async function deleteStory(storyId) {
    if (!storyId) return false;

    const db = await openTeaHouseDB();
    const transaction = db.transaction(STORIES_STORE, 'readwrite');

    transaction.objectStore(STORIES_STORE).delete(String(storyId));

    await transactionDone(transaction);
    return true;
}

/**
 * 针对单个故事的读取—修改—写回辅助函数。
 *
 * 当前模块中的章节新增、编辑、AI 结果写入都可以使用它，
 * 从而避免直接操作一整份故事列表。
 */
export async function updateStory(storyId, updater) {
    if (!storyId || typeof updater !== 'function') return null;

    const db = await openTeaHouseDB();
    const transaction = db.transaction(STORIES_STORE, 'readwrite');
    const store = transaction.objectStore(STORIES_STORE);

    const current = await requestAsPromise(store.get(String(storyId)));

    if (!current) {
        transaction.abort();
        return null;
    }

    const draft = normalizeStory(current);
    const next = await updater(draft);

    // updater 可原地改 draft，也可返回新对象。
    const normalized = normalizeStory({
        ...(next && typeof next === 'object' ? next : draft),
        id: draft.id,
        createdAt: draft.createdAt,
        updatedAt: nowISO()
    });

    store.put(normalized);

    await transactionDone(transaction);
    return normalized;
}

/* -------------------------------------------------------------------------- */
/* 仅用于开发调试；正常页面不调用。                                               */
/* -------------------------------------------------------------------------- */

export async function getTeaHouseStoreInfo() {
    const db = await openTeaHouseDB();
    const transaction = db.transaction(
        [STORIES_STORE, META_STORE],
        'readonly'
    );

    const storyCount = await requestAsPromise(
        transaction.objectStore(STORIES_STORE).count()
    );

    const migration = await requestAsPromise(
        transaction.objectStore(META_STORE).get(LEGACY_MIGRATION_META_KEY)
    );

    return {
        dbName: DB_NAME,
        dbVersion: DB_VERSION,
        storyCount,
        legacyMigration: migration?.value || null
    };
}

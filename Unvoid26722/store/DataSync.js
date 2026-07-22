// store/DataSync.js — 📦 数据同步层（占位/待实现）
//
// 未来目标：将角色数据从 localStorage 迁移到 IndexedDB，
// 各模块通过此模块统一读写，无需各自关心存储位置。
//
// ─── 架构 ───
//
//  启动时                   运行时                   关闭时
//  IndexedDB ──→ sessionStorage ──→ 各模块读写       IndexedDB ←── sessionStorage
//  (一次性加载)   (同步操作)         (不改现有代码)    (自动同步)
//
// ─── 迁移步骤 ───
//
//  第 1 步：实现 loadAllFromDB()  - 从 IndexedDB 读取所有角色数据到 sessionStorage
//  第 2 步：实现 saveToDB()       - 将 sessionStorage 的数据写回 IndexedDB
//  第 3 步：实现 migrateFromLS()  - 首次使用时将 localStorage 旧数据搬到 IndexedDB
//  第 4 步：各模块入口调用 init() - 启动时加载数据
//
// ─── 涉及的模块（都不需要改读写逻辑） ───
//
//  - roleBook.js        → 角色名册（rolebook_characters）
//  - worldNet.js        → 世界角色网络（worldnet_extra_characters）
//  - worldBook.js       → 世界书（worldbook_entries）
//  - txtImporter.js     → 提取工具（保存时写入 localStorage）
//  - CharacterStore.js  → 单个角色数据（好友/聊天/记忆，已在 IndexedDB）
//  - chat.js            → 聊天窗口（待搬）
//  - ImageCache.js      → 图片缓存（已在 IndexedDB 的 imageStore）
//
// ─── 迁移后 localStorage 只作为"运行时缓存"，IndexedDB 作为"持久存储" ───

const DB_NAME = 'CreatorDataSync';
const DB_VERSION = 1;
const STORE_NAME = 'dataStore';

// ★ 所有需要同步的 localStorage key 列表
const SYNC_KEYS = [
    'rolebook_characters',           // 角色名册
    'rolebook_activeIndex',          // 当前主视角索引
    'worldbook_entries',             // 世界书条目
    'worldnet_extra_characters',      // 世界角色网络（额外 NPC）
    // 'worldbook_entries_backup',    // 未来可能的备份键
];

/**
 * ★ 初始化数据库（创建对象仓库）
 * 第 1 步实现时启用
 */
export function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'key' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * ★ 从 IndexedDB 加载全部数据到 sessionStorage
 * 启动时调用一次
 * 
 * @param {boolean} [targetSession=true] - true 写入 sessionStorage，false 写入 localStorage
 */
export async function loadAllFromDB(targetSession = true) {
    // TODO: 实现从 IndexedDB 读取数据
    // const db = await openDB();
    // const tx = db.transaction(STORE_NAME, 'readonly');
    // const store = tx.objectStore(STORE_NAME);
    // for (const key of SYNC_KEYS) {
    //     const result = await store.get(key);
    //     if (result?.data) {
    //         const storage = targetSession ? sessionStorage : localStorage;
    //         storage.setItem(key, result.data);
    //     }
    // }
    console.log('📦 [DataSync] loadAllFromDB — 待实现');
}

/**
 * ★ 将当前 localStorage/sessionStorage 的数据保存到 IndexedDB
 * 可在数据变更时调用，或在页面关闭前调用
 * 
 * @param {string} [specificKey] - 可选，只同步指定 key
 */
export async function saveToDB(specificKey) {
    // TODO: 实现写入 IndexedDB
    // const keys = specificKey ? [specificKey] : SYNC_KEYS;
    // const db = await openDB();
    // const tx = db.transaction(STORE_NAME, 'readwrite');
    // const store = tx.objectStore(STORE_NAME);
    // for (const key of keys) {
    //     const data = localStorage.getItem(key) || sessionStorage.getItem(key);
    //     if (data !== null) {
    //         store.put({ key, data });
    //     }
    // }
    // await tx.done;
    console.log('📦 [DataSync] saveToDB — 待实现');
}

/**
 * ★ 首次迁移：将 localStorage 的旧数据搬到 IndexedDB
 * 检测到 IndexedDB 为空时自动调用
 */
export async function migrateFromLS() {
    // TODO: 实现数据迁移
    // const db = await openDB();
    // const tx = db.transaction(STORE_NAME, 'readwrite');
    // const store = tx.objectStore(STORE_NAME);
    // for (const key of SYNC_KEYS) {
    //     const data = localStorage.getItem(key);
    //     if (data !== null) {
    //         store.put({ key, data });
    //     }
    // }
    // await tx.done;
    console.log('📦 [DataSync] migrateFromLS — 待实现');
}

/**
 * ★ 页面启动时调用：加载数据 + 首次迁移
 */
export async function init() {
    // TODO: 实现初始化逻辑
    // // 1. 检查 IndexedDB 是否有数据
    // const db = await openDB();
    // const tx = db.transaction(STORE_NAME, 'readonly');
    // const store = tx.objectStore(STORE_NAME);
    // const count = await store.count();
    // 
    // // 2. 如果为空，从 localStorage 迁移
    // if (count === 0) {
    //     await migrateFromLS();
    // }
    // 
    // // 3. 加载数据到 sessionStorage
    // await loadAllFromDB(true);
    console.log('📦 [DataSync] init — 待实现');
}

/**
 * ★ 注册 beforeunload 事件，页面关闭前自动保存
 */
export function autoSyncOnClose() {
    // TODO: 实现页面关闭自动同步
    // window.addEventListener('beforeunload', () => {
    //     saveToDB();
    // });
    console.log('📦 [DataSync] autoSyncOnClose — 待实现');
}

// ★ 导出同步键列表，给测试/调试用
export { SYNC_KEYS };

// apps/settingsDataBackup.js — 数据备份（v2 统一备份层）
// ★ 数据源 = 全部业务 IndexedDB 库 + localStorage 小配置，不再逐库手写收集：
//   导出走 indexedDB.databases() 枚举 → 每库逐 store 游标全量 dump；
//   导入按 dump 内 schema 清库重写（库缺失时按 schema 重建），完成后自动刷新页面。
//   v1（旧版平铺格式）备份文件仍可导入（走 legacyImport，兼容旧语义）。
//
// 格式 v2：
//   { version: 2, kind: 'text'|'images'|'all', createdAt,
//     ls: { key: value },            // 真实 localStorage 配置（排除托管/托管前缀与 img_）
//     imgLs: { img_xxx: 'dataurl' }, // 历史 localStorage 图片（kind 含图片时；导入并入 imageStore 字符串记录）
//     dbs: { '<库名>': { dbVersion: N,
//                        stores: { '<store名>': {
//                          schema: { keyPath, autoIncrement, indexes: [{name,keyPath,unique,multiEntry}] },
//                          records: [[key, value], ...] } } } } }
//
// 二进制序列化标记（__t 前缀为保留空间）：
//   ArrayBuffer/TypedArray/DataView/Blob/File/Date/BigInt/特殊数字 → { __t: 'ab'|'ta'|'dv'|'blob'|'file'|'date'|'big'|'num', ... }

const BACKUP_VERSION = 2;
const LEGACY_VERSION = 1;

const IMAGE_DB = 'imageStore';

// indexedDB.databases() 不可用时的兜底库名单（仅探测存在性）
const FALLBACK_DB_NAMES = [
    'DataSyncDB', 'imageStore', 'AoiMemory', 'CreatorChatHistory',
    'worldDictionaryDB', 'cardStore', 'lingxiDB', 'teaHouseDB', 'SketchDB',
    'simCityDB', 'gameCenterDB', 'shakeDB', 'OnlineBookCity', 'desktop_interaction',
    'werewolfDB', 'textgameDB', 'miniGamesDB', 'diaryDB', 'divinationDB'
];

/* ================================================================ */
/*  工具                                                              */
/* ================================================================ */

// ---- base64（分块，避免参数长度上限）----
function bytesToBase64(u8) {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
        bin += String.fromCharCode(...u8.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

function base64ToBytes(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
}

// ---- Toast / 全屏遮罩 ----
function showToast(msg, bg = '#333') {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:${bg};color:#fff;padding:10px 20px;border-radius:12px;z-index:10000;font-size:13px;box-shadow:0 4px 20px rgba(0,0,0,0.2);max-width:80%;text-align:center;`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
}

let _busyEl = null;
function showBusy(text) {
    hideBusy();
    _busyEl = document.createElement('div');
    _busyEl.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.45);z-index:300;display:flex;align-items:center;justify-content:center;';
    _busyEl.innerHTML = `<div style="background:white;border-radius:20px;padding:26px 22px;text-align:center;font-size:14px;color:#555;line-height:1.8;max-width:70%;">${text}<br><span style="font-size:12px;color:#999;">请勿关闭或切换页面</span></div>`;
    document.body.appendChild(_busyEl);
}
function hideBusy() {
    if (_busyEl) { _busyEl.remove(); _busyEl = null; }
}

/* ================================================================ */
/*  值序列化：IDB 可存类型 → JSON 安全（二进制打标 base64）               */
/* ================================================================ */

// 类型标记解码表（白名单，防御未知构造函数注入）
const TA_CTORS = {
    Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array,
    Int8Array, Int16Array, Int32Array, Float32Array, Float64Array,
    BigInt64Array, BigUint64Array
};

async function encodeValue(v, seen) {
    if (v === null || v === undefined) return v;
    const t = typeof v;
    if (t === 'string' || t === 'boolean') return v;
    if (t === 'number') {
        if (Number.isNaN(v)) return { __t: 'num', v: 'NaN' };
        if (v === Infinity) return { __t: 'num', v: 'Infinity' };
        if (v === -Infinity) return { __t: 'num', v: '-Infinity' };
        return v;
    }
    if (t === 'bigint') return { __t: 'big', v: v.toString() }; // JSON 不支持 BigInt，打标兜底
    if (v instanceof Date) return { __t: 'date', d: v.toISOString() };
    if (v instanceof ArrayBuffer) {
        return { __t: 'ab', d: bytesToBase64(new Uint8Array(v)) };
    }
    if (ArrayBuffer.isView(v)) {
        if (v instanceof DataView) {
            const u8 = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
            return { __t: 'dv', d: bytesToBase64(u8) };
        }
        if (TA_CTORS[v.constructor.name]) {
            return { __t: 'ta', c: v.constructor.name, d: bytesToBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
        }
        return bytesToBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)); // 兜底当字节存
    }
    if (v instanceof File) {
        const u8 = new Uint8Array(await v.arrayBuffer());
        return { __t: 'file', n: v.name, lm: v.lastModified, m: v.type || '', d: bytesToBase64(u8) };
    }
    if (v instanceof Blob) {
        const u8 = new Uint8Array(await v.arrayBuffer());
        return { __t: 'blob', m: v.type || '', d: bytesToBase64(u8) };
    }
    if (Array.isArray(v)) {
        const out = new Array(v.length);
        for (let i = 0; i < v.length; i++) out[i] = await encodeValue(v[i], seen);
        return out;
    }
    if (t === 'object') {
        if (seen.has(v)) throw new Error('检测到循环引用（IndexedDB 本不允许，跳过）');
        seen.add(v);
        const out = {};
        for (const k of Object.keys(v)) out[k] = await encodeValue(v[k], seen);
        seen.delete(v);
        return out;
    }
    return v; // 其余（函数/symbol 等 IDB 存不进来，原样过）
}

// ★ 深走解码：标记可能嵌套在对象任意层（如 imageStore 的 { data: ArrayBuffer, mimeType }）
function decodeValue(v) {
    if (v === null || typeof v !== 'object') return v;
    if (typeof v.__t === 'string') {
        switch (v.__t) {
            case 'num': return v.v === 'NaN' ? NaN : (v.v === 'Infinity' ? Infinity : -Infinity);
            case 'big': return BigInt(v.v);
            case 'date': return new Date(v.d);
            case 'ab': return base64ToBytes(v.d).buffer;
            case 'ta': {
                const Ctor = TA_CTORS[v.c];
                if (!Ctor) return v.d; // 未知类型：降级为 base64 字符串
                return new Ctor(base64ToBytes(v.d).buffer);
            }
            case 'dv': return new DataView(base64ToBytes(v.d).buffer);
            case 'blob': return new Blob([base64ToBytes(v.d)], { type: v.m || '' });
            case 'file': return new File([base64ToBytes(v.d)], v.n || 'file', { type: v.m || '', lastModified: v.lm || Date.now() });
        }
        return v;
    }
    if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) v[i] = decodeValue(v[i]);
        return v;
    }
    for (const k of Object.keys(v)) v[k] = decodeValue(v[k]);
    return v;
}

/* ================================================================ */
/*  IndexedDB 枚举 / 打开                                              */
/* ================================================================ */

function openDBByName(name, version) {
    return new Promise((resolve, reject) => {
        const req = version ? indexedDB.open(name, version) : indexedDB.open(name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => { /* 其他标签页持有旧版本连接时可能出现；等待即可 */ };
    });
}

// 枚举全部业务库名（含兜底探测）
async function collectAllDBNames() {
    if (indexedDB.databases) {
        try {
            const list = await indexedDB.databases();
            return list.map(d => d.name).filter(Boolean);
        } catch (e) { console.warn('indexedDB.databases() 不可用，走兜底名单:', e); }
    }
    const found = [];
    for (const name of FALLBACK_DB_NAMES) {
        try {
            const db = await openDBByName(name);
            db.close();
            found.push(name);
        } catch { /* 库不存在 */ }
    }
    return found;
}

// ---- 单库 dump：返回 { dbVersion, stores: { 名: { schema, records } } } ----
async function dumpDB(name) {
    const db = await openDBByName(name);
    try {
        const out = { dbVersion: db.version, stores: {} };
        for (const sname of [...db.objectStoreNames]) {
            const tx = db.transaction(sname, 'readonly');
            const store = tx.objectStore(sname);

            // 结构信息：仅用于「目标设备无此库」时按原样重建
            const schema = {
                keyPath: store.keyPath || undefined,
                autoIncrement: store.autoIncrement,
                indexes: [...store.indexNames].map(iname => {
                    const ix = store.index(iname);
                    return { name: ix.name, keyPath: ix.keyPath, unique: ix.unique, multiEntry: ix.multiEntry };
                })
            };

            // ★ 游标取「键 + 值」：保留 out-of-line key（无 keyPath 的 store 必须显式 key 才能写回）
            const raw = await new Promise((resolve, reject) => {
                const rows = [];
                const req = store.openCursor();
                req.onsuccess = () => {
                    const cur = req.result;
                    if (!cur) { resolve(rows); return; }
                    rows.push([cur.key, cur.value]);
                    cur.continue();
                };
                req.onerror = () => reject(req.error);
            });

            const records = [];
            const seen = new WeakSet();
            for (const [k, val] of raw) {
                records.push([k, await encodeValue(val, seen)]);
            }
            out.stores[sname] = { schema, records };
        }
        return out;
    } finally {
        db.close();
    }
}

/* ================================================================ */
/*  导出收集                                                           */
/* ================================================================ */

// kind: text → 配置 + 除 imageStore 外的全部库；images → imgLs + imageStore；all → 全部
async function collectBackup(kind) {
    // 导出读的是 IDB 落库数据，而 DataSync 托管键有 500ms 去抖才落库；
    // 先 flushPending() 把页面内最后写入的键立即落盘，避免导出文件漏掉最新值
    // （无待写键时为空操作，不触碰任何运行时逻辑）
    try {
        const { flushPending } = await import('../store/DataSync.js');
        flushPending();
    } catch { }

    // managed（DataSync 托管键）真实源在 DataSyncDB，不重复进 ls
    let managedFn = null;
    try { managedFn = (await import('../store/DataSync.js')).isManagedKey; } catch { }
    const isM = k => (managedFn ? managedFn(k) : false);

    // ① localStorage 分区（img_ = 历史图片键，仅图片类导出带走；托管键跳过）
    const ls = {};
    const imgLs = {};
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        if (key.startsWith('img_')) { if (kind !== 'text') imgLs[key] = localStorage.getItem(key); }
        else if (kind !== 'images' && !isM(key)) ls[key] = localStorage.getItem(key);
    }

    // ② 数据库 dump
    const names = await collectAllDBNames();
    const dbs = {};
    for (const name of names) {
        if (kind === 'text' && name === IMAGE_DB) continue;
        if (kind === 'images' && name !== IMAGE_DB) continue;
        try {
            dbs[name] = await dumpDB(name);
        } catch (e) {
            console.warn('库导出失败，跳过:', name, e);
        }
    }

    return { ls, imgLs, dbs };
}

// ---- 下载 JSON 文件 ----
function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function statsOf(backup) {
    const dbs = backup.dbs || {};
    let records = 0;
    let imgRecords = 0;
    for (const d of Object.values(dbs)) {
        for (const s of Object.values(d.stores || {})) {
            const n = (s.records || []).length;
            records += n;
            if (d === dbs[IMAGE_DB]) imgRecords += n;
        }
    }
    return {
        dbCount: Object.keys(dbs).length,
        records,
        lsCount: Object.keys(backup.ls || {}).length,
        imgCount: imgRecords + Object.keys(backup.imgLs || {}).length
    };
}

/* ================================================================ */
/*  数据占用统计（本页顶部那块）                                          */
/* ================================================================ */

// 三种口径：
//   总量    navigator.storage.estimate() —— 浏览器给的准确值（整个站点：IDB + 缓存 + 离线文件）
//   分项    逐库游标读记录、累加长度 —— 只能是估算（不含 IDB 内部开销与压缩），故一律标「约」
//   条数    IDBObjectStore.count() —— 不读记录内容，跟库多大无关

// 行 → 库。没列到的库自动进「其它库」。行序 = 算完之前的展示序，算完按体积降序重排。
const STAT_ROWS = [
    { label: '狼人杀', dbs: ['werewolfDB'], unit: '条' },
    { label: '文游', dbs: ['textgameDB'], unit: '条' },
    { label: '组件', dbs: ['miniGamesDB'], unit: '条' },
    { label: '角色与对话', dbs: ['DataSyncDB', 'shakeDB'], unit: '条' },
    { label: '图片', dbs: [IMAGE_DB], unit: '张' },
    { label: '文字配置', ls: true, unit: '项' },
    { label: '其它库', other: true, unit: '条' }
];

const idbReq = req => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
});

// 一份值占多少字节。二进制按 byteLength/size，字符串按 UTF-16（×2）；
// 不能 JSON.stringify —— ArrayBuffer/Blob 会被序列化成空对象，量出 0。
function measureValue(v) {
    if (v === null || v === undefined) return 0;
    const t = typeof v;
    if (t === 'string') return v.length * 2;
    if (t === 'number' || t === 'boolean') return 8;
    if (t === 'bigint') return 16;
    if (v instanceof ArrayBuffer) return v.byteLength;
    if (ArrayBuffer.isView(v)) return v.byteLength;   // TypedArray / DataView
    if (v instanceof Blob) return v.size;             // File 走这支
    if (v instanceof Date) return 8;
    if (Array.isArray(v)) {
        let n = 0;
        for (const x of v) n += measureValue(x);
        return n;
    }
    if (t === 'object') {
        let n = 0;
        for (const k of Object.keys(v)) n += k.length * 2 + measureValue(v[k]);
        return n;
    }
    return 0;
}

// 单库：条数 + 估算字节数（IDB 存不进循环引用，故不设环检测）
async function measureDB(name) {
    const db = await openDBByName(name);   // 不传版本：只读现有库，不会触发建库/升级
    db.onversionchange = () => db.close(); // 别的标签页要升级时立刻让路
    try {
        let count = 0;
        let bytes = 0;
        for (const sname of [...db.objectStoreNames]) {
            const store = db.transaction(sname, 'readonly').objectStore(sname);
            count += await idbReq(store.count());
            bytes += await new Promise((resolve, reject) => {
                let n = 0;
                const req = store.openCursor();   // 取一条量一条，不攒数组
                req.onsuccess = () => {
                    const cur = req.result;
                    if (!cur) { resolve(n); return; }
                    n += measureValue(cur.key) + measureValue(cur.value);
                    cur.continue();
                };
                req.onerror = () => reject(req.error);
            });
        }
        return { count, bytes };
    } finally {
        db.close();
    }
}

// localStorage：非 img_ 键进「文字配置」，历史 img_ 键（dataURL）并入「图片」行
function localStorageStats() {
    let lsCount = 0, lsBytes = 0, imgCount = 0, imgBytes = 0;
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        const val = localStorage.getItem(key) || '';
        const n = (key.length + val.length) * 2;
        if (key.startsWith('img_')) { imgCount++; imgBytes += n; }
        else { lsCount++; lsBytes += n; }
    }
    return { lsCount, lsBytes, imgCount, imgBytes };
}

async function estimateUsage() {
    try {
        if (!navigator.storage || !navigator.storage.estimate) return null;
        const { usage, quota } = await navigator.storage.estimate();
        return { usage: usage || 0, quota: quota || 0 };
    } catch { return null; }
}

function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function occupancyHTML(rows, est, final) {
    const list = final ? [...rows].sort((a, b) => b.bytes - a.bytes) : rows;

    const head = est
        ? `<div style="display:flex; justify-content:space-between; font-size:13px;">
               <span style="color:#333; font-weight:600;">本机已用</span>
               <span style="color:#666; font-weight:600;">${fmtBytes(est.usage)}${est.quota ? ' · 可用约 ' + fmtBytes(est.quota) : ''}</span>
           </div>
           <div style="display:flex; justify-content:space-between; font-size:12px; color:#999; padding-bottom:8px;">
               <span>分项合计</span><span>约 ${fmtBytes(rows.reduce((n, r) => n + r.bytes, 0))}</span>
           </div>`
        : '';

    const lines = list.map(r => {
        let right;
        if (r.total > 0 && r.done === 0) right = '统计中…';
        else if (r.failed && r.failed === r.total) right = '读不到';
        else {
            right = `${r.count} ${r.unit} · ${r.bytes ? '约 ' + fmtBytes(r.bytes) : '0 B'}`;
            if (r.done < r.total) right += ' …';
            if (r.failed) right += ` · ${r.failed} 库读不到`;
        }
        return `<div style="display:flex; justify-content:space-between; align-items:baseline; gap:12px; padding:9px 0; border-bottom:1px solid #f0f0f0; font-size:13px;">
                    <span style="color:#333;">${r.label}</span>
                    <span style="color:#999; text-align:right;">${right}</span>
                </div>`;
    }).join('');

    const note = est
        ? `<div style="font-size:11px; color:#bbb; margin-top:8px;">「本机已用」是浏览器口径（含缓存与离线文件，刚写入的数据可能还没算进去）；各行为数据量估算，不含数据库自身开销。两者不会正好相等。</div>`
        : '';
    return head + lines + note;
}

// 填 #storageStatsBody：总量先出，再逐库算、边算边刷
async function fillOccupancy(body) {
    const rows = STAT_ROWS.map(r => ({ ...r, count: 0, bytes: 0, total: 0, done: 0, failed: 0 }));
    const other = rows.find(r => r.other);

    let est = await estimateUsage();
    const ls = localStorageStats();
    const lsRow = rows.find(r => r.ls);
    lsRow.count = ls.lsCount;
    lsRow.bytes = ls.lsBytes;
    lsRow.total = lsRow.done = 1;
    const imgRow = rows.find(r => (r.dbs || []).includes(IMAGE_DB));
    if (imgRow) { imgRow.count += ls.imgCount; imgRow.bytes += ls.imgBytes; }

    const paint = final => { body.innerHTML = occupancyHTML(rows, est, final); };
    paint(false);

    let names = [];
    try { names = await collectAllDBNames(); } catch (e) { console.warn('[数据占用] 枚举库失败:', e); }

    const targets = names.map(name => ({ name, row: rows.find(r => (r.dbs || []).includes(name)) || other }));
    for (const t of targets) t.row.total++;
    paint(false);

    for (const { name, row } of targets) {
        try {
            const { count, bytes } = await measureDB(name);
            row.count += count;
            row.bytes += bytes;
        } catch (e) {
            console.warn('[数据占用] 读不到，跳过:', name, e);
            row.failed++;
        }
        row.done++;
        paint(false);
    }

    // 刚写入的数据浏览器不一定已经记进 usage，收尾再读一次
    const again = await estimateUsage();
    if (again) est = again;
    paint(true);
}

/* ================================================================ */
/*  导入（v2：清库重写 + 缺库重建）                                        */
/* ================================================================ */

// 打开目标库（导入用）：
//   库不存在 → indexedDB.open(name, needVersion) 从 0 升到 needVersion，upgradeneeded
//               触发并按 dump schema 全量建 store/索引——不要先 open(name) 探测，
//               那会对不存在的库静默建出 v1 空壳，再同版本打开就不会触发升级了。
//   版本 < 备份 → 升级并补建 dump 里缺失的 store/索引。
//   版本 > 备份（旧备份导进新版）→ VersionError，回退按当前版本打开，缺 store 由写回阶段跳过。
async function ensureDB(name, meta) {
    const storesMeta = (meta && meta.stores) || {};
    const needVersion = (meta && meta.dbVersion) || 1;

    const replaySchema = (db) => {
        for (const [sname, sMeta] of Object.entries(storesMeta)) {
            if (db.objectStoreNames.contains(sname)) continue;
            const opts = {};
            if (sMeta.schema && sMeta.schema.keyPath) opts.keyPath = sMeta.schema.keyPath;
            if (sMeta.schema && sMeta.schema.autoIncrement) opts.autoIncrement = true;
            const store = db.createObjectStore(sname, opts);
            for (const ix of (sMeta.schema && sMeta.schema.indexes) || []) {
                if (!store.indexNames.contains(ix.name)) {
                    store.createIndex(ix.name, ix.keyPath, { unique: !!ix.unique, multiEntry: !!ix.multiEntry });
                }
            }
        }
    };

    try {
        return await new Promise((resolve, reject) => {
            const req = indexedDB.open(name, needVersion);
            req.onupgradeneeded = (e) => replaySchema(e.target.result);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } catch (err) {
        // 本机库版本已高于备份（无法降级）→ 按当前版本打开
        console.warn('库版本高于备份版本，按当前版本打开:', name, err && err.name);
        return openDBByName(name);
    }
}

function clearStore(db, sname) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(sname, 'readwrite');
        tx.objectStore(sname).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

function writeStore(db, sname, records) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(sname, 'readwrite');
        const store = tx.objectStore(sname);
        const inlineKey = typeof store.keyPath === 'string';   // 单字段行内键 → put(value)；否则显式 put(value, key)
        for (const [k, encVal] of records) {
            const val = decodeValue(encVal);
            if (inlineKey) store.put(val);
            else store.put(val, k);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// 执行 v2 导入。返回 { lsCount, imgCount, dbCount } 供展示
async function execImport(backup) {
    // ★ 先让 DataSync 把待写键立即落盘并清掉去抖定时器，
    //   避免恢复 dataStore 后 500ms 窗口内旧缓存把新数据盖回去（随后页面刷新兜底）
    try {
        const { flushPending } = await import('../store/DataSync.js');
        flushPending();
    } catch { }

    const kind = backup.kind === 'images' ? 'images' : (backup.kind === 'all' ? 'all' : 'text');

    // managed 键判定（托管键不碰：hook 管辖，真实源在 DataSyncDB，由下方数据库层整体替换）
    let managedFn = null;
    try { managedFn = (await import('../store/DataSync.js')).isManagedKey; } catch { }
    const isM = k => (managedFn ? managedFn(k) : false);

    // ① localStorage：配置键整体替换（删掉本机有而备份里没有的）
    //   ★ img_ 旧键不走 LS：那是 ImageCache 的回退缓存，启动时会被应用自行清理/迁移，
    //     历史 img_ 数据在 ② 中并入 imageStore 作字符串记录（见下）
    let lsCount = 0;
    if (kind !== 'images') {
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const key = localStorage.key(i);
            if (!key || key.startsWith('img_') || isM(key)) continue;
            if (!Object.prototype.hasOwnProperty.call(backup.ls || {}, key)) {
                try { localStorage.removeItem(key); } catch { }
            }
        }
        for (const [key, value] of Object.entries(backup.ls || {})) {
            try { localStorage.setItem(key, value); lsCount++; } catch (e) { console.warn('写入失败:', key); }
        }
    }

    // ② 数据库：逐库清空全部现有 store → 按 dump 记录写回（备份文件里没有的库保持原样）
    let dbCount = 0;
    for (const [dbName, meta] of Object.entries(backup.dbs || {})) {
        try {
            const db = await ensureDB(dbName, meta);
            const storesMeta = (meta && meta.stores) || {};
            // 清空库内全部现有 store（含备份里没有的新增 store，保证「整体覆盖」语义）
            for (const sname of [...db.objectStoreNames]) {
                try { await clearStore(db, sname); } catch (e) { console.warn('清空失败:', dbName, sname, e); }
            }
            for (const [sname, sMeta] of Object.entries(storesMeta)) {
                if (!db.objectStoreNames.contains(sname)) continue;  // 本机应用版本过旧，缺该 store → 跳过
                let records = sMeta.records || [];
                // 历史 LS 图片（img_ 前缀）并入 imageStore：去前缀作字符串记录。
                // ImageCache 读路径本就接受字符串值；若备份里已有同键真字节记录则跳过（字节优先）。
                if (dbName === IMAGE_DB) {
                    const have = new Set(records.map(r => String(r[0])));
                    const legacy = [];
                    for (const [lk, lv] of Object.entries(backup.imgLs || {})) {
                        const bare = lk.startsWith('img_') ? lk.slice(4) : lk;
                        if (!have.has(bare)) legacy.push([bare, lv]);
                    }
                    if (legacy.length) records = legacy.concat(records);
                }
                try { await writeStore(db, sname, records); } catch (e) { console.warn('写入失败:', dbName, sname, e); }
            }
            db.close();
            dbCount++;
        } catch (e) {
            console.warn('库导入失败，跳过:', dbName, e);
        }
    }

    return { lsCount, imgCount: statsOf(backup).imgCount, dbCount };
}

// ---- v1 旧格式导入（保留原语义：只写不删）----
async function execLegacyImport(backup) {
    let lsCount = 0;
    for (const [key, value] of Object.entries(backup.localStorage || {})) {
        try { localStorage.setItem(key, value); lsCount++; } catch (e) { console.warn('写入失败:', key); }
    }

    let imgCount = 0;
    const images = backup.images || {};
    if (Object.keys(images).length > 0) {
        try {
            const { dbPut } = await import('../store/ImageCache.js');
            for (const [key, value] of Object.entries(images)) {
                try { await dbPut(key, value); imgCount++; } catch (e) { console.warn('写入失败:', key, e); }
            }
        } catch { }
    }

    let aoiMemoryCount = 0;
    let aoiChatCount = 0;
    if (backup.aoi) {
        try {
            if (backup.aoi.memory && backup.aoi.memory.length > 0) {
                const db = await new Promise((resolve, reject) => {
                    const req = indexedDB.open('AoiMemory', 1);
                    req.onupgradeneeded = (e) => {
                        const d = e.target.result;
                        if (!d.objectStoreNames.contains('entries')) {
                            const store = d.createObjectStore('entries', { keyPath: 'id', autoIncrement: true });
                            store.createIndex('timestamp', '_timestamp', { unique: false });
                            store.createIndex('type', '_type', { unique: false });
                        }
                    };
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                });
                const tx = db.transaction('entries', 'readwrite');
                const store = tx.objectStore('entries');
                store.clear();
                for (const entry of backup.aoi.memory) store.add(entry);
                await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; });
                aoiMemoryCount = backup.aoi.memory.length;
            }
            if (backup.aoi.chatHistory && backup.aoi.chatHistory.length > 0) {
                const db2 = await new Promise((resolve, reject) => {
                    const req = indexedDB.open('CreatorChatHistory', 1);
                    req.onupgradeneeded = (e) => {
                        const d = e.target.result;
                        if (!d.objectStoreNames.contains('messages')) {
                            const store = d.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
                            store.createIndex('timestamp', 'timestamp', { unique: false });
                        }
                    };
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                });
                const tx2 = db2.transaction('messages', 'readwrite');
                const store2 = tx2.objectStore('messages');
                store2.clear();
                for (const msg of backup.aoi.chatHistory) store2.add(msg);
                await new Promise((resolve, reject) => { tx2.oncomplete = resolve; tx2.onerror = reject; });
                aoiChatCount = backup.aoi.chatHistory.length;
            }
        } catch (e) { console.warn('Aoi 数据导入失败:', e); }
    }
    return { lsCount, imgCount, aoiMemoryCount, aoiChatCount, dbCount: 0 };
}

// ---- 确认弹窗 + 执行 ----
function confirmAndImport(backup, container) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:200;display:flex;align-items:center;justify-content:center;';
    const isV2 = backup.version === BACKUP_VERSION;
    const st = isV2 ? statsOf(backup) : { lsCount: Object.keys(backup.localStorage || {}).length, imgCount: Object.keys(backup.images || {}).length, dbCount: 0 };
    overlay.innerHTML = `
        <div style="background:white;border-radius:20px;padding:24px 20px;width:290px;text-align:center;">
            <div style="font-size:15px;color:#333;margin-bottom:10px;line-height:1.5;">
                确定要导入备份吗？<br>
                <span style="font-size:12px;color:#e53935;">当前对应数据将被整体覆盖。</span>
            </div>
            <div style="font-size:12px;color:#888;margin-bottom:14px;line-height:1.8;">
                配置 ${st.lsCount} 项
                ${st.imgCount ? `· 图片 ${st.imgCount} 张` : ''}
                ${isV2 ? `· 数据 ${st.records} 条 / ${st.dbCount} 库` : ''}
                <br>${isV2 ? '<span style="color:#999;">备份里没有的库保持原样；完成后自动刷新页面。</span>' : '<span style="color:#999;">完成后自动刷新页面。</span>'}
            </div>
            <div style="display:flex;gap:10px;">
                <button class="import-confirm" style="flex:1;padding:10px;border-radius:12px;border:none;background:#e53935;color:white;cursor:pointer;font-size:14px;font-weight:600;">确定导入</button>
                <button class="import-cancel" style="flex:1;padding:10px;border-radius:12px;border:1px solid #ccc;background:white;color:#666;cursor:pointer;font-size:14px;">取消</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('.import-cancel').onclick = () => overlay.remove();

    overlay.querySelector('.import-confirm').onclick = async () => {
        overlay.remove();
        const importBtn = container.querySelector('#importBtn');
        importBtn.textContent = '⏳ 正在导入...';
        importBtn.disabled = true;
        showBusy('⏳ 正在导入，数据量大时可能需要一会儿…');
        try {
            const r = isV2 ? await execImport(backup) : await execLegacyImport(backup);
            const parts = [`${r.lsCount} 项配置`, r.imgCount ? `${r.imgCount} 张图片` : null, r.dbCount ? `${r.dbCount} 个库` : null, r.aoiMemoryCount ? `${r.aoiMemoryCount} 条 Aoi 记忆` : null, r.aoiChatCount ? `${r.aoiChatCount} 条聊天` : null].filter(Boolean);
            hideBusy();
            showToast(`✅ 导入完成！${parts.join(' + ')}，即将自动刷新…`, '#2e7d32');
            importBtn.textContent = '📂 选择备份文件导入';
            importBtn.disabled = false;
            // ★ 立即刷新重建各模块内存缓存，防止旧缓存/去抖写覆盖刚恢复的数据
            setTimeout(() => location.reload(), 900);
        } catch (e) {
            hideBusy();
            showToast('❌ 导入失败: ' + e.message, '#c62828');
            importBtn.textContent = '📂 选择备份文件导入';
            importBtn.disabled = false;
        }
    };
}

/* ================================================================ */
/*  渲染 / 事件绑定                                                     */
/* ================================================================ */

export function renderDataBackup() {
    return `
        <div class="screen-page">
            <div class="screen-header">
                <button class="status-back-btn" id="backupBackBtn" style="flex-shrink:0;">←</button>
                <div class="screen-title">💾 数据备份</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card" style="margin-bottom:16px;">
                    <div style="font-weight:600; font-size:15px; margin-bottom:6px;">📊 数据占用</div>
                    <div id="storageStatsBody" style="font-size:13px; color:#999;">统计中…</div>
                </div>

                <div class="page-card">
                    <div style="font-size:14px; color:#666; margin-bottom:16px;">
                        导出为 JSON 文件（覆盖全部功能独立数据），或导入备份文件恢复。
                        <br><span style="font-size:12px; color:#999;">⚠️ 导入会把对应数据整体替换为文件内容，完成后自动刷新页面。旧版备份文件（v1）仍可导入。</span>
                    </div>

                    <div style="font-weight:600; font-size:15px; margin-bottom:10px;">📤 导出</div>
                    <button id="exportTextBtn" style="
                        width:100%; padding:12px; border-radius:12px; border:none;
                        background:#0b93f6; color:white; cursor:pointer; font-size:14px; font-weight:600;
                        margin-bottom:8px;
                    ">📝 仅导出文字数据</button>
                    <button id="exportImagesBtn" style="
                        width:100%; padding:12px; border-radius:12px; border:none;
                        background:#e91e63; color:white; cursor:pointer; font-size:14px; font-weight:600;
                        margin-bottom:8px;
                    ">🖼️ 仅导出图片数据</button>
                    <button id="exportAllBtn" style="
                        width:100%; padding:12px; border-radius:12px; border:none;
                        background:#9c27b0; color:white; cursor:pointer; font-size:14px; font-weight:600;
                        margin-bottom:16px;
                    ">📦 导出全部数据</button>

                    <div style="border-top:1px solid #eee; padding-top:14px;">
                        <div style="font-weight:600; font-size:15px; margin-bottom:10px;">📥 导入</div>
                        <button id="importBtn" style="
                            width:100%; padding:12px; border-radius:12px; border:2px dashed #ff7043;
                            background:white; color:#ff7043; cursor:pointer; font-size:14px; font-weight:600;
                        ">📂 选择备份文件导入</button>
                        <input type="file" id="importFileInput" accept=".json" style="display:none;">
                    </div>
                </div>
            </div>
        </div>
    `;
}

export function bindDataBackupEvents(container, onBack) {
    // 返回
    container.querySelector('#backupBackBtn')?.addEventListener('click', () => {
        const statusBar = document.querySelector('.status-bar');
        const pullDownBar = document.getElementById('pullDownBar');
        if (statusBar) statusBar.style.display = '';
        if (pullDownBar) pullDownBar.style.display = '';
        onBack();
    });

    // ★ 通用：导出指定 kind
    const runExport = async (kind, btnSel, idleLabel, busyLabel, bg) => {
        const btn = container.querySelector(btnSel);
        btn.textContent = busyLabel;
        btn.disabled = true;
        showBusy('⏳ 正在收集数据，量大可能需要一会儿…');
        try {
            const { ls, imgLs, dbs } = await collectBackup(kind);
            const backup = {
                version: BACKUP_VERSION,
                createdAt: new Date().toISOString(),
                kind,
                ls,
                imgLs,
                dbs
            };
            downloadJSON(backup, `backup_${kind}_${Date.now()}.json`);
            hideBusy();
            const st = statsOf(backup);
            showToast(`✅ 已导出：${Object.keys(ls).length} 项配置 + ${st.imgCount} 张图片 + ${st.records} 条数据（${Object.keys(dbs).length} 库）`, bg);
        } catch (e) {
            hideBusy();
            showToast('❌ 导出失败: ' + e.message, '#c62828');
        } finally {
            btn.textContent = idleLabel;
            btn.disabled = false;
        }
    };

    container.querySelector('#exportTextBtn')?.addEventListener('click', () =>
        runExport('text', '#exportTextBtn', '📝 仅导出文字数据', '⏳ 正在收集文字数据...', '#0b93f6'));

    container.querySelector('#exportImagesBtn')?.addEventListener('click', () =>
        runExport('images', '#exportImagesBtn', '🖼️ 仅导出图片数据', '⏳ 正在收集图片...', '#e91e63'));

    container.querySelector('#exportAllBtn')?.addEventListener('click', () =>
        runExport('all', '#exportAllBtn', '📦 导出全部数据', '⏳ 正在收集数据...', '#9c27b0'));

    // 导入
    const fileInput = container.querySelector('#importFileInput');
    container.querySelector('#importBtn')?.addEventListener('click', () => {
        fileInput?.click();
    });

    fileInput?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
            const backup = JSON.parse(await file.text());

            if (backup.version === BACKUP_VERSION && backup.dbs && typeof backup.dbs === 'object') {
                confirmAndImport(backup, container);
            } else if (backup.version === LEGACY_VERSION && backup.localStorage) {
                confirmAndImport(backup, container);
            } else {
                showToast('❌ 无法识别的备份文件（版本或格式不对）', '#c62828');
            }
        } catch (err) {
            showToast('❌ 文件解析失败: ' + err.message, '#c62828');
        }

        fileInput.value = '';  // 允许重复选择同一文件
    });

    // ★ 异步统计「数据占用」：不阻塞导出/导入，失败也只影响这一块
    (async function () {
        const body = container.querySelector('#storageStatsBody');
        if (!body) return;
        try {
            await fillOccupancy(body);
        } catch (e) {
            console.warn('[数据占用] 统计失败:', e);
            body.textContent = '统计失败，重进本页可再试。';
        }
    })();
}

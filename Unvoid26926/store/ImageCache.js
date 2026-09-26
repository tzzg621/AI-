// store/ImageCache.js — 统一图片缓存（IndexedDB 存储 + localStorage 索引）

import { CharacterStore } from './CharacterStore.js';

// ---- IndexedDB 封装 ----
const DB_NAME = 'imageStore';
const DB_VERSION = 1;
const STORE_NAME = 'images';

let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => {
            console.warn('IndexedDB 打开失败，回退到 localStorage:', e.target.error);
            resolve(null);
        };
    });
    return dbPromise;
}

async function dbPut(key, value) {
    const db = await openDB();
    if (!db) {
        try { localStorage.setItem(`img_${key}`, value); } catch (e) { console.warn('存储失败:', e); }
        return;
    }
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
    });
}

async function dbGet(key) {
    const db = await openDB();
    if (!db) {
        return localStorage.getItem(`img_${key}`);
    }
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
    });
}

async function dbDelete(key) {
    const db = await openDB();
    if (!db) {
        localStorage.removeItem(`img_${key}`);
        return;
    }
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
    });
}

async function dbClear() {
    const db = await openDB();
    if (!db) return;
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
    });
}

async function dbKeys() {
    const db = await openDB();
    if (!db) return [];
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).getAllKeys();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
    });
}

const INDEX_KEY = 'img_index';

// ---- 迁移旧数据 ----
// ★ 必须跳过 INDEX_KEY：它也是 `img_` 开头，但它是「索引」不是「图片」。
//   老代码不跳，于是每次加载都把这个索引搬进 IndexedDB 的 'index' 键再从
//   localStorage 删掉；等老图搬完，它就成了唯一还在的 img_ 键，纯破坏。
//   索引一没，getIndex() 返回 {} → 所有图都查不到 → 刷新后头像/形象卡全变灰圈。
async function migrateOldData() {
    try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('img_') && key !== INDEX_KEY) {
                keys.push(key.replace('img_', ''));
            }
        }
        if (keys.length === 0) return;

        const db = await openDB();
        if (!db) return;

        console.log(`📦 正在迁移 ${keys.length} 张图片到 IndexedDB...`);
        let count = 0;
        for (const k of keys) {
            const data = localStorage.getItem(`img_${k}`);
            if (data) {
                await dbPut(k, data);
                localStorage.removeItem(`img_${k}`);
                count++;
            }
        }
        console.log(`✅ 迁移完成：${count} 张图片`);
    } catch (e) {
        console.warn('迁移旧数据失败:', e);
    }
}

setTimeout(migrateOldData, 1000);

// ---- 内存缓存 ----
const cache = {};

// ★ CharacterStore 实例缓存
const storeCache = new Map();
function getCachedStore(charId) {
    if (storeCache.has(charId)) return storeCache.get(charId);
    const store = new CharacterStore(charId);
    storeCache.set(charId, store);
    return store;
}

// ★ blob URL 缓存（仅兼容旧 data URL 格式时使用）
const blobUrlCache = new Map();
function dataUrlToBlobUrl(dataUrl) {
    if (!dataUrl || dataUrl.startsWith('blob:') || dataUrl.startsWith('http')) return dataUrl;
    if (blobUrlCache.has(dataUrl)) return blobUrlCache.get(dataUrl);
    try {
        const parts = dataUrl.split(',');
        const mimeMatch = parts[0].match(/:(.*?);/);
        const mime = mimeMatch ? mimeMatch[1] : 'image/png';
        const byteStr = atob(parts[1]);
        const ab = new ArrayBuffer(byteStr.length);
        const ia = new Uint8Array(ab);
        for (let i = 0; i < byteStr.length; i++) ia[i] = byteStr.charCodeAt(i);
        const blob = new Blob([ab], { type: mime });
        const url = URL.createObjectURL(blob);
        blobUrlCache.set(dataUrl, url);
        return url;
    } catch { return dataUrl; }
}
// ★ 裁切 = 让「同一张已经压缩好的图」自己缩放 + 自裁，外面不套壳。
//   不复制、不重新编码、不碰源图：src 还是那张压缩图，只是缩放它、挪一下、剪掉多余部分。
//   公式（x/y/w/h 都是「相对原图自身」的 0~1 比例）：
//     ① scale(1/w, 1/h)：整图放大到 1/w 宽，用户要的那块正好变成一整框
//     ② translate(-(x/w), -(y/h))：把那一块挪到框口
//     ③ clip-path:inset(y, 1-x-w, 1-y-h, x)：剪掉框外部分。剪裁在缩放前生效、
//        并随 transform 一起被变换，所以剪完正好铺满自己的框——既不往外溢出，
//        也不依赖容器的 overflow:hidden。
//   之所以不需要知道原图像素尺寸，是因为四个值全是相对图片自身的百分比。
//   ★ 一定不套 <div> 外壳：外壳得靠 width/height:100% 撑开，碰上「不拉伸子项」的容器
//     （如关系网详情头像的 display:grid;place-items:center）内容宽会塌成 0，
//     再被容器 overflow:hidden 一剪，头像整个消失。img 自己撑就没这问题——
//     它的尺寸行为和「没裁切」那条路一模一样，而那条路到处都验过。
//   ★ 裁切版也不加 border-radius：圆角是缩放前画在外框上的，被 scale(1/w,1/h) 拉一下
//     就成了椭圆；离中心远一点的裁切下，这个椭圆能整块移出可视区，图直接变白。
//     → **裁切版头像的圆角一律由容器提供**（avatar 落点容器本来就都带 border-radius:50%）。
//   （旧做法是 object-fit:cover 之后再套一层 clip-path:inset，两层裁切坐标系不同，
//     非方图必然错位，已废弃——见 AI/06 变更日志。）
function makeImgHtml(src, round = false, charId, type) {
    const realSrc = dataUrlToBlobUrl(src);
    const roundStyle = round ? 'border-radius:50%;' : '';
    const crop = (charId && type) ? getCropParams(charId, type) : null;
    if (crop && crop.w > 0 && crop.h > 0) {
        const p = v => Math.round(v * 1000) / 1000;
        const top = p(crop.y * 100);
        const right = p((1 - crop.x - crop.w) * 100);
        const bottom = p((1 - crop.y - crop.h) * 100);
        const left = p(crop.x * 100);
        return `<img src="${realSrc}" style="width:100%; height:100%; object-fit:fill;`
            + `clip-path:inset(${top}% ${right}% ${bottom}% ${left}%);`
            + `transform:translate(${p(-crop.x / crop.w * 100)}%, ${p(-crop.y / crop.h * 100)}%)`
            + ` scale(${p(1 / crop.w)}, ${p(1 / crop.h)});transform-origin:0 0;" />`;
    }
    return `<img src="${realSrc}" style="width:100%; height:100%; object-fit:cover;${roundStyle}" />`;
}

// ★ 压缩图片到指定大小以内（静态图 ≤50KB，动图 ≤300KB）
const MAX_DISPLAY_PX = 200;
async function compressToBlobUrl(arrayBuffer, mimeType, maxSizeKB) {
    // 动图：直接创建 blob URL，保持动画
    if (mimeType === 'image/gif') {
        const blob = new Blob([arrayBuffer], { type: mimeType });
        return URL.createObjectURL(blob);
    }

    // 静态图：加载到 canvas 上，调整尺寸和质量
    const blob = new Blob([arrayBuffer], { type: mimeType || 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    const img = await new Promise(r => {
        const i = new Image();
        i.onload = () => { r(i); URL.revokeObjectURL(url); };
        i.onerror = () => { r(null); URL.revokeObjectURL(url); };
        i.src = url;
    });
    if (!img) {
        // 降级：直接返回 blob URL
        const fallbackBlob = new Blob([arrayBuffer], { type: mimeType || 'image/jpeg' });
        return URL.createObjectURL(fallbackBlob);
    }

    let w = img.naturalWidth, h = img.naturalHeight;
    if (w > MAX_DISPLAY_PX || h > MAX_DISPLAY_PX) {
        const ratio = Math.min(MAX_DISPLAY_PX / w, MAX_DISPLAY_PX / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
    }

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);

    // 从高到低试质量，直到符合大小要求
    for (const q of [0.85, 0.7, 0.5, 0.3, 0.15, 0.1]) {
        const b = await new Promise(r => canvas.toBlob(r, 'image/jpeg', q));
        if (b && b.size / 1024 <= maxSizeKB) return URL.createObjectURL(b);
    }

    // 保底
    const b = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.1));
    return b ? URL.createObjectURL(b) : URL.createObjectURL(blob);
}

let cachedIndex = null;

function removeFromCache(key) {
    delete cache[key];
}

export function clearAll() {
    Object.keys(cache).forEach(key => delete cache[key]);
    for (const url of blobUrlCache.values()) {
        try { URL.revokeObjectURL(url); } catch { }
    }
    blobUrlCache.clear();
}

// ---- 索引管理 ----
function getIndex() {
    if (cachedIndex) return cachedIndex;
    try {
        const saved = localStorage.getItem(INDEX_KEY);
        cachedIndex = saved ? JSON.parse(saved) : {};
        return cachedIndex;
    } catch { return {}; }
}

function addToIndex(key) {
    const index = getIndex();
    index[key] = Date.now();
    cachedIndex = index;
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
}

function removeFromIndex(key) {
    const index = getIndex();
    delete index[key];
    cachedIndex = index;
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
}

function cacheKey(charId, type, round) {
    return `${type}_${charId}${round ? '_round' : ''}`;
}

export function clearImageCache(charId, type) {
    if (type) {
        removeFromCache(`${type}_${charId}`);
        removeFromCache(`${type}_${charId}_round`);
        // ★ 形象卡缓存一没，头像那份也得跟着作废：头像没图时是降级去用形象卡（同一份缓存、
        //   不另存影子），所以头像键下留着的只可能是「当时还没有形象卡」那块灰。不清的话
        //   getImageHtml 开头那句 `if (cache[cKey]) return cache[cKey]` 会一直还它旧灰。
        if (type === 'portrait') {
            removeFromCache(`avatar_${charId}`);
            removeFromCache(`avatar_${charId}_round`);
        }
    } else {
        Object.keys(cache).forEach(key => {
            if (key.includes(`_${charId}`)) delete cache[key];
        });
    }
}

// ---- 通用取图 ----
export function getImageHtml(charId, type, { round = false, defaultAvatar } = {}) {
    const cKey = cacheKey(charId, type, round);
    if (cache[cKey]) return cache[cKey];

    const key = `${type}_${charId}`;
    const index = getIndex();

    if (index[key]) {
        // 有索引 → 走存储读取
    } else if (type === 'avatar') {
        // ★ 没设头像 → 降级用形象图（同一张压缩图，只是换个用途、按形象图自己的裁切参数裁）
        const portraitKey = `portrait_${charId}`;
        if (index[portraitKey]) {
            // ★ 降级就用形象图那份缓存本身，不在头像键下再存一份影子。
            //   两者是同一张图、同一个字符串，存两份只会多出一个「过得去但会过期」的副本：
            //   换形象图、换形象图裁切都只清 portrait_*，头像那份会留在旧图上，
            //   而本函数开头的 `if (cache[cKey]) return cache[cKey]` 永远先命中它。
            //   ★ 也不能判 `includes('src=')`——占位（灰块）和真图都要原样交给调用方：
            //   占位带 data-char-id，异步落地后会自己替换掉，缓存住反而钉死在灰圈上。
            return getImageHtml(charId, 'portrait', { round });
        }
    } else {
        const roundStyle = round ? 'border-radius:50%;' : '';
        const content = defaultAvatar
            ? `<span style="font-size:16px; color:#999;">${defaultAvatar}</span>`
            : '';
        const html = `<div style="width:100%; height:100%; background:#e0e0e0; display:flex; align-items:center; justify-content:center; ${roundStyle}">${content}</div>`;
        cache[cKey] = html;
        return html;
    }

    // 有索引 → 从存储读取
    try {
        const store = getCachedStore(charId);
        const info = store.getInfo();
        const images = info.images || {};
        let dataUrl = images[type];

        let resolvedFromRef = false;

        if (dataUrl && dataUrl.startsWith('__gallery_ref__')) {
            resolvedFromRef = true;
            const refKey = dataUrl.replace('__gallery_ref__', '');

            // ★ 源图位就是裸的 galleryKey，不再另存 `${refKey}_as_${type}` 那种副本：
            //   同一个 blobUrl 编出来的 HTML 是同一个字符串，多存一份只会让读写两头
            //   分家（异步落地那一支只写裸键，快路径却去查副本 → 永远查不到 →
            //   每次改裁切都重新读盘 + 重压一遍）。裸键也是 getGlobalImageHtml /
            //   preloadAllImages 认的那个键。
            const cachedHtml = cache[refKey];
            if (cachedHtml) {
                // ★ 源图缓存里存的是「没裁过的压缩图」，这里必须重新过一遍 makeImgHtml
                //   才能带上这个角色这个用途的裁切参数——直接改字符串补圆角是不行的。
                const match = cachedHtml.match(/src="([^"]+)"/);
                if (match) {
                    const html = makeImgHtml(match[1], round, charId, type);
                    cache[cKey] = html;
                    return html;
                }
            }

            // ★ 异步加载 → 用 compressToBlobUrl 压缩后显示
            loadImageFromStore(refKey).then(async (raw) => {
                if (!raw) return;
                let blobUrl;
                if (typeof raw === 'string') {
                    // 旧格式：data URL → 用旧方式压缩
                    const small = await resizeImageCompat(raw);
                    blobUrl = dataUrlToBlobUrl(small);
                } else {
                    // 新格式：{ data: ArrayBuffer, mimeType }
                    const maxSize = raw.mimeType === 'image/gif' ? 300 : 50;
                    blobUrl = await compressToBlobUrl(raw.data, raw.mimeType, maxSize);
                }
                const htmlStraight = makeImgHtml(blobUrl, false, charId, type);
                const htmlRound = makeImgHtml(blobUrl, true, charId, type);
                // ★ refKey 是「源图位」：只放压缩产物、不放裁切，和 setImage / setGlobalImage 一致。
                //   它可能被别的消费方（相册、桌宠、生图列表）按原 key 取走，塞裁切版会串味。
                cache[refKey] = makeImgHtml(blobUrl);
                cache[`${type}_${charId}`] = htmlStraight;
                cache[`${type}_${charId}_round`] = htmlRound;

                // ★ 直接找到页面上的占位容器，替换为图片
                const selector = `[data-char-id="${charId}"][data-img-type="${type}"]`;
                document.querySelectorAll(selector).forEach(el => {
                    const isRound = el.style.borderRadius === '50%';
                    el.outerHTML = isRound ? htmlRound : htmlStraight;
                });

                window.dispatchEvent(new CustomEvent('image-loaded', {
                    detail: { key: refKey, charId, type }
                }));
            });

            // ★ 返回带 data 属性的灰色占位（供后续自动替换）
            const roundStyle = round ? 'border-radius:50%;' : '';
            const placeholderHtml = `<div data-char-id="${charId}" data-img-type="${type}" style="width:100%;height:100%;background:#e0e0e0;${roundStyle}"></div>`;
            cache[cKey] = placeholderHtml;
            return placeholderHtml;
        }

        // 兼容旧数据（images 外的旧字段）
        if (!dataUrl) {
            if (type === 'avatar' && info.avatar) {
                dataUrl = info.avatar;
                const newImages = { ...images, avatar: dataUrl };
                store.setInfo({ images: newImages, avatar: undefined });
            } else if (type === 'portrait' && info.portrait) {
                dataUrl = info.portrait;
                const newImages = { ...images, portrait: dataUrl };
                store.setInfo({ images: newImages, portrait: undefined });
            }
        }

        if (dataUrl) {
            const html = makeImgHtml(dataUrl, round, charId, type);
            if (!resolvedFromRef) {
                cache[cKey] = html;
            }
            return html;
        }
    } catch { }

    // 无图片占位
    const roundStyle = round ? 'border-radius:50%;' : '';
    const content = defaultAvatar
        ? `<span style="font-size:16px; color:#999;">${defaultAvatar}</span>`
        : '';
    const html = `<div style="width:100%; height:100%; background:#e0e0e0; display:flex; align-items:center; justify-content:center; ${roundStyle}">${content}</div>`;
    cache[cKey] = html;
    return html;
}

// ★ 兼容旧 data URL 格式的 resize（新图不走这个）
function resizeImageCompat(dataUrl) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const w = img.naturalWidth;
            const h = img.naturalHeight;
            if (w <= MAX_DISPLAY_PX && h <= MAX_DISPLAY_PX) {
                resolve(dataUrl);
                return;
            }
            const ratio = Math.min(MAX_DISPLAY_PX / w, MAX_DISPLAY_PX / h);
            const nw = Math.round(w * ratio);
            const nh = Math.round(h * ratio);
            const canvas = document.createElement('canvas');
            canvas.width = nw;
            canvas.height = nh;
            canvas.getContext('2d').drawImage(img, 0, 0, nw, nh);
            resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
    });
}

// ---- 异步加载图片 ----
let imageLoadCallbacks = {};

async function loadImageFromStore(key) {
    const data = await dbGet(key);
    return data;
}

// ---- 快捷方式 ----
export function getPortraitHtml(charId) {
    return getImageHtml(charId, 'portrait', { round: false });
}

// ★ 页面加载时调用，从 IndexedDB 预加载所有角色图片
let _preloadPromise = null;

export async function preloadAllImages(characters = []) {
    if (!characters.length) return;
    if (_preloadPromise) return _preloadPromise;

    _preloadPromise = (async () => {
        for (const char of characters) {
            const charId = char.id;
            if (!charId) continue;

            const store = getCachedStore(charId);
            const info = store.getInfo();
            const images = info.images || {};

            for (const type of ['portrait', 'avatar']) {
                const ref = images[type];
                if (!ref || !ref.startsWith('__gallery_ref__')) continue;

                const galleryKey = ref.replace('__gallery_ref__', '');
                // ★ 源图位已有就直接复用它那个 blobUrl，只补这一轮要写的缓存 + DOM 替换。
                //   以前是 `continue` —— 一旦源图位已存在，连 `${type}_${charId}` 的写入
                //   和下面的占位替换也一起跳过了，页面上就留着灰圈不换。
                const cachedSrc = (cache[galleryKey] || '').match(/src="([^"]+)"/);
                let blobUrl;
                if (cachedSrc) {
                    blobUrl = cachedSrc[1];
                } else {
                    const raw = await dbGet(galleryKey);
                    if (!raw) continue;

                    if (typeof raw === 'string') {
                        const small = await resizeImageCompat(raw);
                        blobUrl = dataUrlToBlobUrl(small);
                    } else {
                        const maxSize = raw.mimeType === 'image/gif' ? 300 : 50;
                        blobUrl = await compressToBlobUrl(raw.data, raw.mimeType, maxSize);
                    }
                }

                cache[galleryKey] = makeImgHtml(blobUrl);   // 源图位：不裁
                cache[`${type}_${charId}`] = makeImgHtml(blobUrl, type === 'avatar', charId, type);
                cache[`${type}_${charId}_round`] = makeImgHtml(blobUrl, true, charId, type);

                const selector = `[data-char-id="${charId}"][data-img-type="${type}"]`;
                document.querySelectorAll(selector).forEach(el => {
                    const isRound = el.style.borderRadius === '50%';
                    el.outerHTML = isRound
                        ? makeImgHtml(blobUrl, true, charId, type)
                        : makeImgHtml(blobUrl, false, charId, type);
                });
            }
        }
    })();

    return _preloadPromise;
}

export function getAvatarHtml(charId, defaultAvatar) {
    // ★ 没设头像时，getImageHtml 内部会自动降级去用形象图——
    //   而且降级那一份是带圆角的（round 透传下去，裁切版的圆角在外层框上）。
    //   以前这里靠 replace('object-fit:cover;', '…border-radius:50%;') 事后补圆角，
    //   一旦 HTML 形状变了就静默失效，已删。
    return getImageHtml(charId, 'avatar', { round: true, defaultAvatar });
}

// ---- 设置角色图片 ----
export async function setImage(charId, type, input) {
    let arrayBuffer, mimeType;

    if (input instanceof File || input instanceof Blob) {
        arrayBuffer = await input.arrayBuffer();
        mimeType = input.type || 'image/jpeg';
    } else if (typeof input === 'string') {
        const parts = input.split(',');
        const mimeMatch = parts[0].match(/:(.*?);/);
        mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
        const byteStr = atob(parts[1]);
        arrayBuffer = new ArrayBuffer(byteStr.length);
        const ia = new Uint8Array(arrayBuffer);
        for (let i = 0; i < byteStr.length; i++) ia[i] = byteStr.charCodeAt(i);
    } else {
        console.warn('setImage: 不支持的输入类型');
        return;
    }

    const galleryKey = `gallery_${type}_${charId}_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;

    // ① 存原始二进制到 IndexedDB
    await dbPut(galleryKey, { data: arrayBuffer, mimeType }).catch(e => console.warn('存储失败:', e));

    // ② 压缩
    const maxSize = mimeType === 'image/gif' ? 300 : 50;
    const blobUrl = await compressToBlobUrl(arrayBuffer, mimeType, maxSize);

    // ★ 只预热「源图位」：压缩产物按原图 key 存一份，不裁、不带角色。
    //   带裁切的那份不在这儿写——此刻 crops 里还是上一张图的参数，写进去就是错的。
    //   留给下一次 getImageHtml 按当时的参数现算（它命中源图位，不会重新压一遍）。
    clearImageCache(charId, type);
    cache[galleryKey] = makeImgHtml(blobUrl);

    const store = getCachedStore(charId);
    const info = store.getInfo();
    const images = info.images || {};
    images[type] = `__gallery_ref__${galleryKey}`;
    store.setInfo({ images });

    addToIndex(`${type}_${charId}`);
    fireImageAdded(galleryKey, type);
}

// ---- 全局图片（AI 生图、相册上传等）----
export async function setGlobalImage(key, input) {
    let arrayBuffer, mimeType;

    if (input instanceof File || input instanceof Blob) {
        arrayBuffer = await input.arrayBuffer();
        mimeType = input.type || 'image/jpeg';
    } else if (typeof input === 'string') {
        const parts = input.split(',');
        const mimeMatch = parts[0].match(/:(.*?);/);
        mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
        const byteStr = atob(parts[1]);
        arrayBuffer = new ArrayBuffer(byteStr.length);
        const ia = new Uint8Array(arrayBuffer);
        for (let i = 0; i < byteStr.length; i++) ia[i] = byteStr.charCodeAt(i);
    } else { return; }

    // ① 存原始二进制
    dbPut(key, { data: arrayBuffer, mimeType }).catch(e => console.warn('存储失败:', e));

    // ② 压缩并预热缓存
    const maxSize = mimeType === 'image/gif' ? 300 : 50;
    const blobUrl = await compressToBlobUrl(arrayBuffer, mimeType, maxSize);
    cache[key] = makeImgHtml(blobUrl);
    addToIndex(key);

    fireImageAdded(key, 'gallery');
}

export function getGlobalImageHtml(key) {
    if (cache[key]) return cache[key];
    loadImageFromStore(key).then(async (raw) => {
        if (!raw) return;
        let blobUrl;
        if (typeof raw === 'string') {
            const small = await resizeImageCompat(raw);
            blobUrl = dataUrlToBlobUrl(small);
        } else {
            const maxSize = raw.mimeType === 'image/gif' ? 300 : 50;
            blobUrl = await compressToBlobUrl(raw.data, raw.mimeType, maxSize);
        }
        cache[key] = makeImgHtml(blobUrl);
        window.dispatchEvent(new CustomEvent('image-loaded', { detail: { key } }));
    });
    return '';
}

export function removeImage(key) {
    Object.keys(cache).forEach(cacheKey => {
        if (cacheKey.startsWith(key) || cacheKey.startsWith(key + '_round')) {
            delete cache[cacheKey];
        }
    });

    removeFromIndex(key);

    dbDelete(key);

    try {
        if (key.startsWith('portrait_') || key.startsWith('avatar_')) {
            const type = key.startsWith('portrait_') ? 'portrait' : 'avatar';
            const charId = key.substring(type.length + 1);
            const store = new CharacterStore(charId);
            const info = store.getInfo();
            const images = info.images || {};
            if (images[type]) {
                delete images[type];
                store.setInfo({ images });
            }
        } else {
            localStorage.removeItem(`img_${key}`);
        }
    } catch (e) {
        console.warn('删除图片数据失败:', e);
    }
}

export async function getImageDataUrl(key) {
    try {
        if (key.startsWith('portrait_') || key.startsWith('avatar_')) {
            const type = key.startsWith('portrait_') ? 'portrait' : 'avatar';
            const charId = key.substring(type.length + 1);
            const store = new CharacterStore(charId);
            const info = store.getInfo();
            let dataUrl = (info.images || {})[type] || null;
            if (dataUrl && dataUrl.startsWith('__gallery_ref__')) {
                const refKey = dataUrl.replace('__gallery_ref__', '');
                const raw = await dbGet(refKey);
                if (!raw) return null;
                if (typeof raw === 'string') return raw;  // 旧格式
                // 新格式：ArrayBuffer → data URL
                const blob = new Blob([raw.data], { type: raw.mimeType });
                return new Promise(r => {
                    const reader = new FileReader();
                    reader.onload = () => r(reader.result);
                    reader.readAsDataURL(blob);
                });
            }
            return dataUrl;
        } else {
            const raw = await dbGet(key);
            if (!raw) return null;
            if (typeof raw === 'string') return raw;  // 旧格式
            const blob = new Blob([raw.data], { type: raw.mimeType });
            return new Promise(r => {
                const reader = new FileReader();
                reader.onload = () => r(reader.result);
                reader.readAsDataURL(blob);
            });
        }
    } catch {
        return null;
    }
}

// ---- 从相册引用设置角色图片 ----
export async function setImageFromGallery(charId, type, galleryKey) {
    const store = getCachedStore(charId);
    const info = store.getInfo();
    const images = info.images || {};
    images[type] = `__gallery_ref__${galleryKey}`;
    store.setInfo({ images });
    clearImageCache(charId, type);
    addToIndex(`${type}_${charId}`);

    // ★ 只保证「压缩产物」在（源图位 = 裸的 galleryKey，见 getImageHtml 里的说明），
    //   带裁切的那份留给下一次 getImageHtml 按当时的参数现算。以前这里会自己拼一份
    //   object-fit:cover 的 HTML 塞进 `${type}_${charId}`，绕过了裁切，已删。
    if (cache[galleryKey]) return;   // 压缩产物已在，不用再压一遍

    const raw = await dbGet(galleryKey);
    if (!raw) return;

    let blobUrl;
    if (typeof raw === 'string') {
        const small = await resizeImageCompat(raw);
        blobUrl = dataUrlToBlobUrl(small);
    } else {
        const maxSize = raw.mimeType === 'image/gif' ? 300 : 50;
        blobUrl = await compressToBlobUrl(raw.data, raw.mimeType, maxSize);
    }

    cache[galleryKey] = makeImgHtml(blobUrl);
}

// // 空闲时预加载
// function preloadOnIdle() {
//     const preload = () => { preloadAllImages(); };
//     if (window.requestIdleCallback) {
//         requestIdleCallback(preload, { timeout: 3000 });
//     } else {
//         setTimeout(preload, 1500);
//     }
// }
// setTimeout(preloadOnIdle, 500);

// ---- 事件触发 ----
function fireImageAdded(key, type) {
    const event = new CustomEvent('image-added', { detail: { key, type } });
    window.dispatchEvent(event);
}


// ============================================================
//  裁剪参数管理
// ============================================================

export function setCropParams(charId, type, params) {
    try {
        // ★ 用 getCachedStore 而不是 new：只有这个函数写 crops，读侧（makeImgHtml →
        //   getCropParams）也得是同一个实例才看得见刚写进去的值，new 出来是各拿一份快照。
        const store = getCachedStore(charId);
        const info = store.getInfo();
        const crops = info.crops || {};
        if (params) {
            crops[type] = { ...params, v: 2 };   // v2 = 原图自身归一化坐标系
        } else {
            delete crops[type];
        }
        store.setInfo({ ...info, crops });

        // ★ 只失效这个角色的这个用途。以前是 includes(`_${charId}`) 一把梭，会把
        //   `gallery_..._${charId}_...` 的源图位也清掉——源图又没变，重压一遍
        //   （建 img → 解码 → canvas → 最多 6 次 toBlob）纯属白烧。
        removeFromCache(`${type}_${charId}`);
        removeFromCache(`${type}_${charId}_round`);
    } catch (e) {
        console.warn('保存裁剪参数失败:', e);
    }
}

export function getCropParams(charId, type) {
    try {
        const c = getCachedStore(charId).getInfo()?.crops?.[type];
        // ★ v2 之前存的是「含黑边的容器坐标系」（弹窗里 object-fit:contain 算出来的），
        //   跟现在的「原图自身归一化坐标系」不是一个东西，拿来用必然错位。
        //   没有 v:2 的一律当没裁过，让用户重新框一次。
        return (c && c.v === 2) ? c : null;
    } catch {
        return null;
    }
}

export { dbGet, dbPut, dbKeys };

/**
 * 获取所有图片 key
 * @returns {Promise<string[]>}
 */
export async function getAllImageKeys() {
    const allKeys = await dbKeys();
    return allKeys.filter(k => typeof k === 'string' && k.startsWith('img_'));
}

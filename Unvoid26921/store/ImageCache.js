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

// ---- 迁移旧数据 ----
async function migrateOldData() {
    try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('img_')) {
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
function makeImgHtml(src, round = false) {
    const realSrc = dataUrlToBlobUrl(src);
    const roundStyle = round ? ' border-radius:50%;' : '';
    return `<img src="${realSrc}" style="width:100%; height:100%; object-fit:cover;${roundStyle}" />`;
}

function _applyCrop(html, charId, type) {
    if (!charId || !type) return html;
    const crop = getCropParams(charId, type);
    if (!crop) return html;
    const top = (crop.y * 100).toFixed(1);
    const left = (crop.x * 100).toFixed(1);
    const w = (crop.w * 100).toFixed(1);
    const h = (crop.h * 100).toFixed(1);
    return `<div style="width:100%;height:100%;overflow:hidden;clip-path:inset(${top}% ${(100 - left - w).toFixed(1)}% ${(100 - top - h).toFixed(1)}% ${left}%)">${html}</div>`;
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

const INDEX_KEY = 'img_index';
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
        const portraitKey = `portrait_${charId}`;
        if (index[portraitKey]) {
            const portraitHtml = getPortraitHtml(charId);
            if (portraitHtml && !portraitHtml.includes('background:#e0e0e0') && !portraitHtml.includes('background: #e0e0e0')) {
                const roundHtml = portraitHtml.replace(
                    'object-fit:cover;',
                    'object-fit:cover; border-radius:50%;'
                );
                cache[cKey] = roundHtml;
                return roundHtml;
            }
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

            const sourceKey = `${refKey}_as_${type}`;
            const cachedHtml = cache[sourceKey];
            if (cachedHtml) {
                const match = cachedHtml.match(/src="([^"]+)"/);
                if (match) {
                    const roundStyle = round ? 'border-radius:50%;' : '';
                    const html = `<img src="${match[1]}" style="width:100%; height:100%; object-fit:cover; ${roundStyle}" />`;
                    cache[cKey] = html;
                    return _applyCrop(html, charId, type);
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
                const htmlStraight = makeImgHtml(blobUrl, false);
                const htmlRound = makeImgHtml(blobUrl, true);
                cache[refKey] = htmlStraight;
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
            const html = makeImgHtml(dataUrl, round);
            if (!resolvedFromRef) {
                cache[cKey] = html;
            }
            return _applyCrop(html, charId, type);
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
                if (cache[galleryKey]) continue; // 已加载过

                const raw = await dbGet(galleryKey);
                if (!raw) continue;

                let blobUrl;
                if (typeof raw === 'string') {
                    const small = await resizeImageCompat(raw);
                    blobUrl = dataUrlToBlobUrl(small);
                } else {
                    const maxSize = raw.mimeType === 'image/gif' ? 300 : 50;
                    blobUrl = await compressToBlobUrl(raw.data, raw.mimeType, maxSize);
                }

                cache[galleryKey] = makeImgHtml(blobUrl);
                cache[`${type}_${charId}`] = makeImgHtml(blobUrl, type === 'avatar');
                cache[`${type}_${charId}_round`] = makeImgHtml(blobUrl, true);

                const selector = `[data-char-id="${charId}"][data-img-type="${type}"]`;
                document.querySelectorAll(selector).forEach(el => {
                    const isRound = el.style.borderRadius === '50%';
                    el.outerHTML = isRound ? makeImgHtml(blobUrl, true) : makeImgHtml(blobUrl, false);
                });
            }
        }
    })();

    return _preloadPromise;
}

export function getAvatarHtml(charId, defaultAvatar) {
    const result = getImageHtml(charId, 'avatar', { round: true, defaultAvatar });

    // ★ 只在角色确实没设置过头像时才降级为肖像
    const store = new CharacterStore(charId);
    const info = store.getInfo();
    const hasAvatarRef = !!(info.images?.avatar);

    if (!hasAvatarRef && result.includes('background:#e0e0e0') && !result.includes('src=')) {
        const portraitHtml = getPortraitHtml(charId);
        if (portraitHtml && !portraitHtml.includes('background:#e0e0e0') && !portraitHtml.includes('background: #e0e0e0')) {
            const roundHtml = portraitHtml.replace(
                'object-fit:cover;',
                'object-fit:cover; border-radius:50%;'
            );
            return roundHtml;
        }
    }
    return result;
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

    // ★ 先清旧缓存再设新缓存
    clearImageCache(charId, type);

    const store = getCachedStore(charId);
    const info = store.getInfo();
    const images = info.images || {};
    images[type] = `__gallery_ref__${galleryKey}`;
    store.setInfo({ images });

    // ★ 设缓存（和 setImageFromGallery 一致的写法）
    const sourceKey = `${galleryKey}_as_${type}`;
    cache[sourceKey] = makeImgHtml(blobUrl);
    cache[galleryKey] = makeImgHtml(blobUrl);
    cache[`${type}_${charId}`] = makeImgHtml(blobUrl, type === 'avatar');
    cache[`${type}_${charId}_round`] = makeImgHtml(blobUrl, true);

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

    // ★ 用用途区分的缓存 key
    const sourceKey = `${galleryKey}_as_${type}`;

    const cachedHtml = cache[sourceKey];
    if (cachedHtml) {
        const match = cachedHtml.match(/src="([^"]+)"/);
        if (match) {
            const roundStyle = type === 'avatar' ? 'border-radius:50%;' : '';
            const html = `<img src="${match[1]}" style="width:100%; height:100%; object-fit:cover; ${roundStyle}" />`;
            cache[`${type}_${charId}`] = html;
            return;
        }
    }

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

    cache[sourceKey] = makeImgHtml(blobUrl);
    cache[`${type}_${charId}`] = makeImgHtml(blobUrl, type === 'avatar');
    cache[`${type}_${charId}_round`] = makeImgHtml(blobUrl, true);
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
        const store = new CharacterStore(charId);
        const info = store.getInfo();
        const crops = info.crops || {};
        if (params) {
            crops[type] = params;
        } else {
            delete crops[type];
        }
        store.setInfo({ ...info, crops });
        Object.keys(cache).forEach(key => {
            if (key.includes(`_${charId}`)) delete cache[key];
        });
    } catch (e) {
        console.warn('保存裁剪参数失败:', e);
    }
}

export function getCropParams(charId, type) {
    try {
        const store = new CharacterStore(charId);
        const info = store.getInfo();
        return info?.crops?.[type] || null;
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

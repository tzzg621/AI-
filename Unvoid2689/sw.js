// sw.js — 简单的 Service Worker，只做缓存

const CACHE_NAME = 'creator-phone-v1';
const FILES_TO_CACHE = [
    '缔造者手机.html',
    'styles.css',
    'app.js',
    'data.js',
    'manifest.json'
];

// 安装时缓存核心文件
self.addEventListener('install', (event) => {
    // ★ 只支持 http/https 协议下缓存
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(FILES_TO_CACHE);
        })
    );
});

// 网络优先，离线时用缓存
self.addEventListener('fetch', (event) => {
    // ★ file:// 协议下直接请求，不走缓存
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

    try {
        const url = new URL(event.request.url);
        // ★ 只处理【同源 + GET】请求；跨域 API（生图等）和 POST 一律放行
        if (event.request.method !== 'GET' || url.origin !== location.origin) return;
    } catch { return; }

    event.respondWith(
        fetch(event.request).catch(() =>
            caches.match(event.request).then(r => r || new Response('', { status: 503 }))
        )
    );
});

// apps/music.js — 音乐播放器（阶段1：真播放器 MVP）
// 模块体系：render / bindEvents / memoryService 记忆联动 / localStorage 持久化

export const id = 'musicPage';
export const label = '音乐';
// 首页卡片图标：默认 emoji，可换成 icons.js 里的 SVG（先确认 icons.js 路径）
// import { getSvgIcon } from '../icons.js';  →  icon = getSvgIcon('musicPage')
export const icon = '🎵';
export const color = '#4caf50';
export const title = '🎵 音乐';
export const memoryOptions = {
    mode: 'none',
    description: '记录最近播放的歌曲。',
    enabled: true
};

// ---------- 内置默认曲库（SoundHelix 免费示例，可替换为你的曲目） ----------
const DEFAULT_TRACKS = [
    { title: 'SoundHelix Song 1', artist: 'SoundHelix', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3' },
    { title: 'SoundHelix Song 2', artist: 'SoundHelix', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3' },
    { title: 'SoundHelix Song 3', artist: 'SoundHelix', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3' },
    { title: 'SoundHelix Song 4', artist: 'SoundHelix', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3' },
    { title: 'SoundHelix Song 5', artist: 'SoundHelix', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3' }
];

// ---------- 存储 ----------
const KEY_TRACKS = 'music_tracks';
const KEY_STATE = 'music_state';

function loadJSON(key, fallback) {
    try {
        const saved = localStorage.getItem(key);
        if (saved) return JSON.parse(saved);
    } catch (e) { /* 数据损坏则忽略 */ }
    return fallback;
}

// ---------- 模块级常驻状态（render 重渲染不丢） ----------
const state = {
    playlist: (loadJSON(KEY_TRACKS, null) || DEFAULT_TRACKS),
    currentIndex: 0,
    isPlaying: false,
    volume: 0.8,
    mode: 'loop',               // loop | shuffle | once
    favorites: new Set(loadJSON(KEY_STATE, {}).favorites || [])
};

// 恢复持久化状态
(function restoreState() {
    const saved = loadJSON(KEY_STATE, {});
    if (typeof saved.currentIndex === 'number' && saved.currentIndex >= 0 && saved.currentIndex < state.playlist.length) {
        state.currentIndex = saved.currentIndex;
    }
    if (typeof saved.volume === 'number') state.volume = saved.volume;
    if (['loop', 'shuffle', 'once'].includes(saved.mode)) state.mode = saved.mode;
})();

function saveState() {
    try {
        localStorage.setItem(KEY_TRACKS, JSON.stringify(state.playlist));
        localStorage.setItem(KEY_STATE, JSON.stringify({
            currentIndex: state.currentIndex,
            volume: state.volume,
            mode: state.mode,
            favorites: [...state.favorites]
        }));
    } catch (e) { /* 存储满等异常忽略 */ }
}

// ---------- 常驻 <audio> 单例（关键：不能放进 render，否则切页即断播） ----------
const audio = new Audio();
audio.volume = state.volume;
audio.preload = 'metadata';

let root = null;                 // 当前页面容器，bindEvents 时更新，供 audio 事件局部刷新
let memoryServiceRef = null;     // bindEvents 时注入

audio.addEventListener('timeupdate', updateProgressDom);
audio.addEventListener('loadedmetadata', () => { updateProgressDom(); updateNowPlayingDom(); });
audio.addEventListener('ended', handleEnded);
audio.addEventListener('error', () => {
    toast('播放失败（可能断网），已自动切下一首');
    nextTrack();
});

// ---------- 工具 ----------
function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

function formatNow() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function remember(text) {
    try {
        memoryServiceRef?.addMemory({ time: formatNow(), text });
    } catch (e) { /* 忽略 */ }
}

function toast(msg) {
    if (!root) return;
    let el = root.querySelector('.music-toast');
    if (!el) {
        el = document.createElement('div');
        el.className = 'music-toast';
        root.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------- 播放控制 ----------
function playTrack(index) {
    if (index < 0 || index >= state.playlist.length) return;
    if (index === state.currentIndex && audio.src) { togglePlay(); return; } // 点当前曲 = 暂停/继续
    state.currentIndex = index;
    const track = state.playlist[index];
    audio.src = track.url;
    audio.play().catch(() => { state.isPlaying = false; syncPlayBtn(); });
    state.isPlaying = true;
    saveState();
    remember(`🎵 正在播放《${track.title}》— ${track.artist}`);   // 记忆联动
    updateNowPlayingDom();
    updateListHighlight();
    syncPlayBtn();
}

function nextTrack() {
    playTrack((state.currentIndex + 1) % state.playlist.length);
}

function togglePlay() {
    if (!state.playlist.length) return;
    if (state.isPlaying) {
        audio.pause();
        state.isPlaying = false;
    } else {
        if (!audio.src) { playTrack(state.currentIndex); return; }  // 首次播放
        audio.play().catch(() => toast('无法播放，请检查网络'));
        state.isPlaying = true;
    }
    syncPlayBtn();
}

function handleEnded() {
    if (state.mode === 'once') {
        state.isPlaying = false;
        audio.currentTime = 0;
        syncPlayBtn();
        return;
    }
    let next;
    if (state.mode === 'shuffle') {
        next = Math.floor(Math.random() * state.playlist.length);
        if (state.playlist.length > 1 && next === state.currentIndex) next = (next + 1) % state.playlist.length;
    } else {
        next = (state.currentIndex + 1) % state.playlist.length;
    }
    playTrack(next);
}

function cycleMode() {
    const order = ['loop', 'shuffle', 'once'];
    state.mode = order[(order.indexOf(state.mode) + 1) % order.length];
    saveState();
    if (root) {
        const btn = root.querySelector('[data-music-action="mode"]');
        if (btn) btn.textContent = { loop: '🔁', shuffle: '🔀', once: '🔂' }[state.mode];
    }
}

function toggleFav() {
    const track = state.playlist[state.currentIndex];
    if (!track) return;
    if (state.favorites.has(track.url)) state.favorites.delete(track.url);
    else state.favorites.add(track.url);
    saveState();
    updateNowPlayingDom();
}

// ---------- 局部 DOM 更新（不整体重渲染） ----------
function syncPlayBtn() {
    if (!root) return;
    const btn = root.querySelector('[data-music-action="toggle"]');
    if (btn) btn.textContent = state.isPlaying ? '⏸' : '▶';
    const disc = root.querySelector('.music-disc');
    if (disc) disc.classList.toggle('playing', state.isPlaying);
}

function updateProgressDom() {
    if (!root) return;
    const fill = root.querySelector('.music-progress-fill');
    const cur = root.querySelector('.music-time-cur');
    const dur = root.querySelector('.music-time-dur');
    if (fill && audio.duration && isFinite(audio.duration)) {
        fill.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
    }
    if (cur) cur.textContent = fmtTime(audio.currentTime);
    if (dur) dur.textContent = fmtTime(audio.duration);
}

function updateNowPlayingDom() {
    if (!root) return;
    const track = state.playlist[state.currentIndex];
    if (!track) return;
    const titleEl = root.querySelector('.music-now-title');
    const artistEl = root.querySelector('.music-now-artist');
    if (titleEl) titleEl.textContent = track.title;
    if (artistEl) artistEl.textContent = track.artist;
    const favBtn = root.querySelector('[data-music-action="fav"]');
    if (favBtn) favBtn.textContent = state.favorites.has(track.url) ? '❤️' : '🤍';
}

function updateListHighlight() {
    if (!root) return;
    root.querySelectorAll('[data-music-play]').forEach((row, i) => {
        const active = i === state.currentIndex;
        row.classList.toggle('active', active);
        const badge = row.querySelector('.music-row-badge');
        if (badge) badge.textContent = active ? (state.isPlaying ? '🔊' : '▶') : '♪';
    });
}

function seekFromEvent(e) {
    const bar = e.currentTarget;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    if (audio.duration && isFinite(audio.duration)) {
        audio.currentTime = ratio * audio.duration;
        updateProgressDom();
    }
}

// ---------- 渲染 ----------
export function render() {
    const track = state.playlist[state.currentIndex] || { title: '未选择', artist: '' };
    const modeIcon = { loop: '🔁', shuffle: '🔀', once: '🔂' }[state.mode] || '🔁';
    return `
    <div class="screen-page">
        <div class="screen-header">
            <div class="screen-title">${title}</div>
            <div class="header-spacer"></div>
        </div>
        <div class="screen-content">
            <div class="page-card music-now-card">
                <div class="music-disc ${state.isPlaying ? 'playing' : ''}">
                    <div class="music-disc-inner">🎵</div>
                </div>
                <div class="music-now-title">${track.title}</div>
                <div class="music-now-artist">${track.artist}</div>
                <div class="music-progress" data-music-seek>
                    <div class="music-progress-fill"></div>
                </div>
                <div class="music-time-row">
                    <span class="music-time-cur">0:00</span>
                    <span class="music-time-dur">0:00</span>
                </div>
                <div class="music-controls">
                    <button class="music-btn" data-music-action="mode" title="播放模式">${modeIcon}</button>
                    <button class="music-btn" data-music-action="prev" title="上一首">⏮</button>
                    <button class="music-btn music-btn-main" data-music-action="toggle" title="播放/暂停">${state.isPlaying ? '⏸' : '▶'}</button>
                    <button class="music-btn" data-music-action="next" title="下一首">⏭</button>
                    <button class="music-btn" data-music-action="fav" title="收藏">${state.favorites.has(track.url) ? '❤️' : '🤍'}</button>
                </div>
                <div class="music-volume-row">
                    <span>🔈</span>
                    <input type="range" class="music-volume" min="0" max="1" step="0.01" value="${state.volume}">
                    <span>🔊</span>
                </div>
            </div>

            <div class="page-card">
                <div class="music-list-title">曲库（${state.playlist.length}）</div>
                ${state.playlist.map((item, i) => `
                    <div class="card-item music-row ${i === state.currentIndex ? 'active' : ''}" data-music-play="${i}">
                        <span class="music-row-badge">${i === state.currentIndex ? (state.isPlaying ? '🔊' : '▶') : '♪'}</span>
                        <span class="music-row-text">${item.title} — ${item.artist}</span>
                    </div>
                `).join('')}
            </div>
        </div>
    </div>
    `;
}

// ---------- 事件绑定 ----------
export function bindEvents(container, api) {
    root = container;
    memoryServiceRef = api?.memoryService || null;

    container.querySelectorAll('[data-music-action]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const action = btn.dataset.musicAction;
            if (action === 'toggle') togglePlay();
            else if (action === 'prev') playTrack((state.currentIndex - 1 + state.playlist.length) % state.playlist.length);
            else if (action === 'next') nextTrack();
            else if (action === 'mode') cycleMode();
            else if (action === 'fav') toggleFav();
        });
    });

    container.querySelectorAll('[data-music-play]').forEach((row) => {
        row.addEventListener('click', () => playTrack(Number(row.dataset.musicPlay)));
    });

    const seekBar = container.querySelector('[data-music-seek]');
    if (seekBar) seekBar.addEventListener('click', seekFromEvent);

    const vol = container.querySelector('.music-volume');
    if (vol) {
        vol.addEventListener('input', (e) => {
            state.volume = parseFloat(e.target.value) || 0;
            audio.volume = state.volume;
            saveState();
        });
    }

    // 重渲染后恢复 UI 状态（进度/标题/列表高亮/播放按钮）
    updateProgressDom();
    updateNowPlayingDom();
    updateListHighlight();
    syncPlayBtn();
}

// ---------- 注册 ----------
if (!window.__moduleRegistry) window.__moduleRegistry = [];
window.__moduleRegistry.push({ id, label, icon, color, render, bindEvents });

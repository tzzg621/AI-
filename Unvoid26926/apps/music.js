// apps/music.js
// 音乐播放器：纯内存曲库预览版
// 不使用 localStorage，不连接外部搜索或其他模块。

export const id = 'musicPage';
export const label = '音乐';
export const icon = '🎵';
export const color = '#4caf50';
export const title = '🎵 音乐';

export const memoryOptions = {
    mode: 'none',
    description: '音乐模块不保存播放记录。',
    enabled: false
};

const DEMO_LYRICS = [
    { time: 0, text: '轻轻摇曳的旋律' },
    { time: 10, text: '穿过安静夜色' },
    { time: 22, text: '把未说完的话' },
    { time: 36, text: '藏进遥远星河' },
    { time: 52, text: '让每一个微小片段' },
    { time: 70, text: '都拥有自己的回声' }
];

const DEFAULT_TRACK = {
    id: 'demo-track',
    title: 'SoundHelix Song 1',
    artist: 'SoundHelix',
    url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
    lyrics: DEMO_LYRICS
};

const state = {
    playlist: [DEFAULT_TRACK],
    currentIndex: 0,
    isPlaying: false,
    volume: 0.8,
    mode: 'loop',
    favorites: new Set(),
    query: '',
    importedKeys: new Set()
};

const audio = new Audio();
audio.preload = 'metadata';
audio.volume = state.volume;

let root = null;
let activeLyricIndex = -1;

audio.addEventListener('timeupdate', () => {
    updateProgressDom();
    updateLyricsDom();
});

audio.addEventListener('loadedmetadata', () => {
    updateProgressDom();
    updateNowPlayingDom();
});

audio.addEventListener('ended', handleEnded);

audio.addEventListener('error', () => {
    state.isPlaying = false;
    toast('播放失败，请检查音频地址或文件格式');
    syncPlayBtn();
});

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function fmtTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';

    const minutes = Math.floor(seconds / 60);
    const rest = Math.floor(seconds % 60);

    return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function getCurrentTrack() {
    return state.playlist[state.currentIndex] || null;
}

function getFilteredTracks() {
    const query = state.query.trim().toLowerCase();

    return state.playlist
        .map((track, index) => ({ track, index }))
        .filter(({ track }) => {
            if (!query) return true;

            return `${track.title} ${track.artist}`
                .toLowerCase()
                .includes(query);
        });
}

function toast(message) {
    if (!root) return;

    let toastEl = root.querySelector('.music-toast');

    if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.className = 'music-toast';
        root.appendChild(toastEl);
    }

    toastEl.textContent = message;
    toastEl.classList.add('show');

    clearTimeout(toastEl._timer);
    toastEl._timer = setTimeout(() => {
        toastEl.classList.remove('show');
    }, 2200);
}

function playTrack(index) {
    if (index < 0 || index >= state.playlist.length) return;

    if (index === state.currentIndex && audio.src) {
        togglePlay();
        return;
    }

    const track = state.playlist[index];

    state.currentIndex = index;
    state.isPlaying = true;
    activeLyricIndex = -1;

    audio.src = track.url;
    audio.currentTime = 0;

    audio.play()
        .then(() => {
            state.isPlaying = true;
            syncPlayBtn();
        })
        .catch(() => {
            state.isPlaying = false;
            toast('无法播放，请检查音频地址或浏览器权限');
            syncPlayBtn();
        });

    updateNowPlayingDom();
    updateListHighlight();
    updateLyricsDom();
    syncPlayBtn();
}

function togglePlay() {
    if (!state.playlist.length) return;

    if (state.isPlaying) {
        audio.pause();
        state.isPlaying = false;
        syncPlayBtn();
        return;
    }

    if (!audio.src) {
        playTrack(state.currentIndex);
        return;
    }

    audio.play()
        .then(() => {
            state.isPlaying = true;
            syncPlayBtn();
        })
        .catch(() => {
            state.isPlaying = false;
            toast('无法播放当前歌曲');
            syncPlayBtn();
        });
}

function previousTrack() {
    if (!state.playlist.length) return;

    if (audio.currentTime > 4) {
        audio.currentTime = 0;
        updateProgressDom();
        return;
    }

    const nextIndex =
        (state.currentIndex - 1 + state.playlist.length) %
        state.playlist.length;

    playTrack(nextIndex);
}

function nextTrack() {
    if (!state.playlist.length) return;

    if (state.mode === 'shuffle' && state.playlist.length > 1) {
        let nextIndex = Math.floor(Math.random() * state.playlist.length);

        if (nextIndex === state.currentIndex) {
            nextIndex = (nextIndex + 1) % state.playlist.length;
        }

        playTrack(nextIndex);
        return;
    }

    playTrack((state.currentIndex + 1) % state.playlist.length);
}

function handleEnded() {
    if (state.mode === 'once') {
        state.isPlaying = false;
        audio.currentTime = 0;
        syncPlayBtn();
        updateProgressDom();
        return;
    }

    nextTrack();
}

function getModeIcon() {
    return {
        loop: '↻',
        shuffle: '⇄',
        once: '↺'
    }[state.mode];
}

function getModeLabel() {
    return {
        loop: '列表循环',
        shuffle: '随机播放',
        once: '单曲播放'
    }[state.mode];
}

function cycleMode() {
    const modes = ['loop', 'shuffle', 'once'];
    const current = modes.indexOf(state.mode);

    state.mode = modes[(current + 1) % modes.length];

    const button = root?.querySelector('[data-music-action="mode"]');

    if (button) {
        button.textContent = getModeIcon();
        button.title = getModeLabel();
        button.setAttribute('aria-label', getModeLabel());
    }
}

function toggleFavorite() {
    const track = getCurrentTrack();
    if (!track) return;

    if (state.favorites.has(track.id)) {
        state.favorites.delete(track.id);
    } else {
        state.favorites.add(track.id);
    }

    updateNowPlayingDom();
    updateListHighlight();
}

function syncPlayBtn() {
    if (!root) return;

    const button = root.querySelector('[data-music-action="toggle"]');
    const disc = root.querySelector('.music-disc');

    if (button) {
        button.textContent = state.isPlaying ? 'Ⅱ' : '▶';
        button.setAttribute(
            'aria-label',
            state.isPlaying ? '暂停' : '播放'
        );
    }

    if (disc) {
        disc.classList.toggle('playing', state.isPlaying);
    }

    updateListHighlight();
}

function updateProgressDom() {
    if (!root) return;

    const fill = root.querySelector('.music-progress-fill');
    const current = root.querySelector('.music-time-cur');
    const duration = root.querySelector('.music-time-dur');

    if (fill && Number.isFinite(audio.duration) && audio.duration > 0) {
        fill.style.width =
            `${(audio.currentTime / audio.duration) * 100}%`;
    }

    if (current) current.textContent = fmtTime(audio.currentTime);
    if (duration) duration.textContent = fmtTime(audio.duration);
}

function updateNowPlayingDom() {
    if (!root) return;

    const track = getCurrentTrack();
    if (!track) return;

    const title = root.querySelector('.music-now-title');
    const artist = root.querySelector('.music-now-artist');
    const favoriteState = root.querySelector('.music-fav-state');
    const favoriteButton = root.querySelector('[data-music-action="fav"]');

    if (title) title.textContent = track.title;
    if (artist) artist.textContent = track.artist;

    const isFavorite = state.favorites.has(track.id);

    if (favoriteState) {
        favoriteState.textContent = isFavorite ? '已收藏' : '未收藏';
    }

    if (favoriteButton) {
        favoriteButton.textContent = isFavorite ? '♥' : '♡';
        favoriteButton.setAttribute(
            'aria-label',
            isFavorite ? '取消收藏' : '收藏'
        );
    }
}

function getLyrics(track) {
    return Array.isArray(track?.lyrics) && track.lyrics.length
        ? track.lyrics
        : DEMO_LYRICS;
}

function getLyricIndex() {
    const lyrics = getLyrics(getCurrentTrack());
    let index = 0;

    for (let i = 0; i < lyrics.length; i += 1) {
        if (audio.currentTime >= lyrics[i].time) {
            index = i;
        }
    }

    return index;
}

function updateLyricsDom() {
    if (!root) return;

    const lines = root.querySelectorAll('.music-lyric-line');
    if (!lines.length) return;

    const nextIndex = getLyricIndex();
    const changed = nextIndex !== activeLyricIndex;

    activeLyricIndex = nextIndex;

    lines.forEach((line, index) => {
        line.classList.toggle('active', index === nextIndex);
    });

    if (changed) {
        lines[nextIndex]?.scrollIntoView({
            behavior: 'smooth',
            block: 'center'
        });
    }

    const status = root.querySelector('.music-lyrics-status');

    if (status) {
        status.textContent = audio.src ? '同步播放' : '演示歌词';
    }
}

function updateListHighlight() {
    if (!root) return;

    root.querySelectorAll('[data-music-play]').forEach(row => {
        const index = Number(row.dataset.musicPlay);
        const track = state.playlist[index];
        const active = index === state.currentIndex;
        const badge = row.querySelector('.music-row-badge');
        const favorite = row.querySelector('.music-row-fav');

        row.classList.toggle('active', active);

        if (badge) {
            badge.textContent =
                active && state.isPlaying ? '▶' : active ? 'Ⅱ' : '♪';
        }

        if (favorite && track) {
            favorite.textContent =
                state.favorites.has(track.id) ? '♥' : '';
        }
    });
}

function seekFromEvent(event) {
    const bar = event.currentTarget;
    const rect = bar.getBoundingClientRect();

    const ratio = Math.min(
        Math.max((event.clientX - rect.left) / rect.width, 0),
        1
    );

    if (Number.isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = ratio * audio.duration;
        updateProgressDom();
        updateLyricsDom();
    }
}

function getImportedTrackKey(file) {
    return `${file.name}:${file.size}:${file.lastModified}`;
}

function getTitleFromFileName(name) {
    return name.replace(/\.[^/.]+$/, '') || '未命名歌曲';
}

function importFiles(files) {
    const audioFiles = [...files].filter(file =>
        file.type.startsWith('audio/')
    );

    if (!audioFiles.length) {
        toast('请选择音频文件');
        return;
    }

    let importedCount = 0;

    audioFiles.forEach(file => {
        const key = getImportedTrackKey(file);

        if (state.importedKeys.has(key)) return;

        state.importedKeys.add(key);

        state.playlist.push({
            id: `local-${key}`,
            title: getTitleFromFileName(file.name),
            artist: '本地音频',
            url: URL.createObjectURL(file),
            lyrics: DEMO_LYRICS
        });

        importedCount += 1;
    });

    if (!importedCount) {
        toast('这些歌曲已经导入过了');
        return;
    }

    refreshLibrary();
    toast(`已导入 ${importedCount} 首歌曲`);
}

function refreshLibrary() {
    if (!root) return;

    const list = root.querySelector('.music-list');
    const count = root.querySelector('.music-search-count');
    const subtitle = root.querySelector('.music-list-subtitle');

    if (list) {
        list.innerHTML = renderLibrary();
        bindLibraryEvents(root);
    }

    if (count) {
        count.textContent = `${getFilteredTracks().length} 首`;
    }

    if (subtitle) {
        subtitle.textContent = `${state.playlist.length} 首歌曲`;
    }
}

function renderLibrary() {
    const tracks = getFilteredTracks();

    if (!tracks.length) {
        return '<div class="music-empty">没有找到匹配的歌曲</div>';
    }

    return tracks.map(({ track, index }) => {
        const active = index === state.currentIndex;
        const favorite = state.favorites.has(track.id);

        return `
            <div class="music-row ${active ? 'active' : ''}" data-music-play="${index}">
                <span class="music-row-badge">
                    ${active && state.isPlaying ? '▶' : active ? 'Ⅱ' : '♪'}
                </span>
                <div class="music-row-main">
                    <div class="music-row-title">${escapeHtml(track.title)}</div>
                    <div class="music-row-artist">${escapeHtml(track.artist)}</div>
                </div>
                <span class="music-row-fav" aria-hidden="true">
                    ${favorite ? '♥' : ''}
                </span>
            </div>
        `;
    }).join('');
}

export function render() {
    const track = getCurrentTrack() || {
        title: '未选择歌曲',
        artist: '暂无艺术家',
        lyrics: DEMO_LYRICS
    };

    const lyrics = getLyrics(track);

    return `
        <div class="screen-page music-page">
            <div class="screen-content">
                <div class="music-toolbar">
                    <div class="music-search">
                        <span class="music-search-icon" aria-hidden="true">⌕</span>
                        <input
                            class="music-search-input"
                            type="search"
                            placeholder="联网搜索将在后续版本接入"
                            aria-label="联网搜索"
                            disabled
                        >
                    </div>

                    <button
                        class="music-import-btn"
                        type="button"
                        data-music-action="import"
                    >导入歌曲</button>

                    <input
                        class="music-file-input"
                        type="file"
                        accept="audio/*"
                        multiple
                        hidden
                    >
                </div>

                <div class="music-now-card">
                    <div class="music-cover-wrap">
                        <div class="music-disc ${state.isPlaying ? 'playing' : ''}">
                            <div class="music-disc-inner"></div>
                        </div>
                    </div>

                    <div class="music-now-info">
                        <div class="music-kicker">NOW PLAYING</div>
                        <div class="music-now-title">${escapeHtml(track.title)}</div>
                        <div class="music-now-artist">${escapeHtml(track.artist)}</div>
                        <div class="music-fav-state">
                            ${state.favorites.has(track.id) ? '已收藏' : '未收藏'}
                        </div>
                    </div>

                    <div class="music-progress-block">
                        <div class="music-progress" data-music-seek>
                            <div class="music-progress-fill"></div>
                        </div>
                        <div class="music-time-row">
                            <span class="music-time-cur">0:00</span>
                            <span class="music-time-dur">0:00</span>
                        </div>
                    </div>

                    <div class="music-controls">
                        <button class="music-btn" data-music-action="mode"
                            title="${getModeLabel()}"
                            aria-label="${getModeLabel()}">${getModeIcon()}</button>
                        <button class="music-btn" data-music-action="prev"
                            title="上一首" aria-label="上一首">‹‹</button>
                        <button class="music-btn music-btn-main"
                            data-music-action="toggle"
                            title="播放/暂停"
                            aria-label="${state.isPlaying ? '暂停' : '播放'}">
                            ${state.isPlaying ? 'Ⅱ' : '▶'}
                        </button>
                        <button class="music-btn" data-music-action="next"
                            title="下一首" aria-label="下一首">››</button>
                        <button class="music-btn" data-music-action="fav"
                            title="收藏"
                            aria-label="${state.favorites.has(track.id) ? '取消收藏' : '收藏'}">
                            ${state.favorites.has(track.id) ? '♥' : '♡'}
                        </button>
                    </div>

                    <div class="music-volume-row">
                        <span aria-hidden="true">−</span>
                        <input class="music-volume" type="range"
                            min="0" max="1" step="0.01"
                            value="${state.volume}" aria-label="音量">
                        <span aria-hidden="true">＋</span>
                    </div>
                </div>

                <section class="music-lyrics-card" aria-label="歌词">
                    <div class="music-lyrics-head">
                        <span class="music-section-label">歌词</span>
                        <span class="music-lyrics-status">演示歌词</span>
                    </div>

                    <div class="music-lyrics">
                        ${lyrics.map(line => `
                            <div class="music-lyric-line"
                                data-lyric-time="${line.time}">
                                ${escapeHtml(line.text)}
                            </div>
                        `).join('')}
                    </div>
                </section>

                <section class="music-library" aria-label="曲库">
                    <div class="music-library-head">
                        <span class="music-list-title">曲库</span>
                        <span class="music-list-subtitle">
                            ${state.playlist.length} 首歌曲
                        </span>
                    </div>

                    <div class="music-list">
                        ${renderLibrary()}
                    </div>
                </section>
            </div>
        </div>
    `;
}

export function bindEvents(container) {
    root = container;

    container.querySelectorAll('[data-music-action]').forEach(button => {
        button.addEventListener('click', () => {
            const action = button.dataset.musicAction;

            if (action === 'toggle') togglePlay();
            else if (action === 'prev') previousTrack();
            else if (action === 'next') nextTrack();
            else if (action === 'mode') cycleMode();
            else if (action === 'fav') toggleFavorite();
            else if (action === 'import') {
                container.querySelector('.music-file-input')?.click();
            }
        });
    });

    container.querySelector('[data-music-seek]')?.addEventListener(
        'click',
        seekFromEvent
    );

    container.querySelector('.music-volume')?.addEventListener(
        'input',
        event => {
            state.volume = Number(event.target.value);
            audio.volume = state.volume;
        }
    );

    container.querySelector('.music-file-input')?.addEventListener(
        'change',
        event => {
            importFiles(event.target.files);
            event.target.value = '';
        }
    );

    bindLibraryEvents(container);
    updateProgressDom();
    updateNowPlayingDom();
    updateLyricsDom();
    syncPlayBtn();
}

function bindLibraryEvents(container) {
    container.querySelectorAll('[data-music-play]').forEach(row => {
        if (row.dataset.bound === 'true') return;

        row.dataset.bound = 'true';
        row.addEventListener('click', () => {
            playTrack(Number(row.dataset.musicPlay));
        });
    });
}

if (!window.__moduleRegistry) window.__moduleRegistry = [];

window.__moduleRegistry.push({
    id,
    label,
    icon,
    color,
    render,
    bindEvents
});

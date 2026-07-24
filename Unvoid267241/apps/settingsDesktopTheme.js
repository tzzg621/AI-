// apps/settingsDesktopTheme.js — 桌面主题设置子页面

const THEME_KEY = 'desk_theme';

const THEMES = [
    {
        id: 'warm',
        name: '暖色',
        desc: '米白暖调，柔和舒适',
        bg: 'linear-gradient(145deg, #f5f0eb, #ede4d8)',
        colors: ['#f5f0eb', '#ede4d8', '#d4c5b3']
    },
    {
        id: 'cool',
        name: '冷色',
        desc: '清冷灰蓝，干净利落',
        bg: 'linear-gradient(145deg, #e8ecf1, #dde3ea)',
        colors: ['#e8ecf1', '#dde3ea', '#c5cdd8']
    },
    {
        id: 'dark',
        name: '深色',
        desc: '深蓝夜幕，护眼沉浸',
        bg: 'linear-gradient(145deg, #1a1a2e, #16213e)',
        colors: ['#1a1a2e', '#16213e', '#0f3460']
    },
    {
        id: 'clean',
        name: '极简',
        desc: '纯白背景，简洁专注',
        bg: '#f8f8fa',
        colors: ['#f8f8fa', '#f0f0f2', '#e8e8ec']
    }
];

function getCurrentTheme() {
    return localStorage.getItem(THEME_KEY) || 'warm';
}

function setTheme(themeId) {
    localStorage.setItem(THEME_KEY, themeId);
    // 通知 app.js 刷新桌面
    // 如果当前在桌面，自动刷新
    const pageContainer = document.getElementById('pageContainer');
    if (pageContainer) {
        // 触发一个自定义事件，让 app.js 知道主题变了
        window.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme: themeId } }));
    }
}

export function renderDesktopThemeSettings() {
    const current = getCurrentTheme();

    return `
        <div class="screen-page">
            <div class="screen-header">
                <button class="status-back-btn" id="themeBackBtn" style="flex-shrink:0;">←</button>
                <div class="screen-title">🎨 桌面主题</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card">
                    <div style="font-size:14px; color:#666; margin-bottom:14px;">选择一个主题，改变桌面的整体色调</div>
                    <div style="display:flex; flex-direction:column; gap:10px;">
                        ${THEMES.map(t => {
                            const isActive = t.id === current;
                            return `
                                <div class="theme-card" data-theme="${t.id}" style="
                                    display:flex; align-items:center; gap:14px;
                                    padding:14px 16px; border-radius:16px;
                                    cursor:pointer;
                                    border:2px solid ${isActive ? '#0b93f6' : '#f0f0f0'};
                                    background:white;
                                    transition:all 0.2s;
                                ">
                                    <div style="
                                        width:48px; height:48px; border-radius:10px;
                                        background:${t.bg};
                                        box-shadow:inset 0 0 0 1px rgba(0,0,0,0.08);
                                        display:flex; align-items:center; justify-content:center;
                                        flex-shrink:0;
                                    ">
                                        <span style="font-size:20px; filter:drop-shadow(0 1px 2px rgba(0,0,0,0.1));">${t.id === 'dark' ? '🌙' : '☀️'}</span>
                                    </div>
                                    <div style="flex:1; min-width:0;">
                                        <div style="font-weight:600; font-size:15px;">
                                            ${t.name}
                                            ${isActive ? '<span style="color:#0b93f6; font-size:12px; margin-left:6px;">✓ 当前</span>' : ''}
                                        </div>
                                        <div style="font-size:12px; color:#999; margin-top:2px;">${t.desc}</div>
                                        <div style="display:flex; gap:4px; margin-top:6px;">
                                            ${t.colors.map(c => `
                                                <div style="width:14px; height:14px; border-radius:50%; background:${c}; border:1px solid rgba(0,0,0,0.06);"></div>
                                            `).join('')}
                                        </div>
                                    </div>
                                    <span style="color:#ccc; font-size:16px;">${isActive ? '●' : '○'}</span>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            </div>
        </div>
    `;
}

export function bindDesktopThemeEvents(container, onBack) {
    // 返回
    container.querySelector('#themeBackBtn')?.addEventListener('click', () => {
        const statusBar = document.querySelector('.status-bar');
        const pullDownBar = document.getElementById('pullDownBar');
        if (statusBar) statusBar.style.display = '';
        if (pullDownBar) pullDownBar.style.display = '';
        onBack();
    });

    // 主题选择
    container.querySelectorAll('.theme-card').forEach(card => {
        card.addEventListener('click', () => {
            const themeId = card.dataset.theme;
            setTheme(themeId);
            // 重渲染当前页面
            const appContainer = container.closest('.screen-page') || container;
            appContainer.innerHTML = renderDesktopThemeSettings();
            bindDesktopThemeEvents(appContainer, onBack);
        });
    });
}

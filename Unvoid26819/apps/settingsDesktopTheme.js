// apps/settingsDesktopTheme.js — 桌面主题设置子页面

const THEME_KEY = 'desk_theme';
const ICON_STYLE_KEY = 'desk_icon_style';

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
    },
    {
        id: 'pink',
        name: '粉色',
        desc: '樱花粉调，温柔甜美',
        bg: 'linear-gradient(145deg, #fdeef4 0%, #f8dce8 100%)',
        colors: ['#fdeef4', '#f8dce8', '#e8aec4']
    },
    {
        id: 'geo',
        name: '几何',
        desc: '线条网格，冷静秩序',
        bg: 'linear-gradient(145deg, #f2f2f5, #e8e8ee)',
        colors: ['#f2f2f5', '#e8e8ee', '#9a9ab0']
    }

];

// 压缩工具：最长边 1080px，JPEG 0.8，返回 dataURL
function compressImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                const max = 1080;
                const scale = Math.min(1, max / Math.max(img.width, img.height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.round(img.width * scale);
                canvas.height = Math.round(img.height * scale);
                canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/jpeg', 0.8));
            };
            img.onerror = reject;
            img.src = reader.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

const BG_KEY = 'desk_bg';   // 存压缩后的 dataURL

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
    const iconStyle = localStorage.getItem(ICON_STYLE_KEY) || 'new';

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
                    <div style="margin-top:16px;">
    <div style="font-size:13px;color:#888;margin-bottom:10px;">🔲 图标样式</div>
    <div style="display:flex;gap:8px;">
        <button id="iconStyleNew" style="flex:1;border:2px solid ${iconStyle === 'new' ? '#0b93f6' : '#f0f0f0'};background:white;border-radius:14px;padding:12px;font-size:13px;cursor:pointer;">🔷 新图标（图形）</button>
        <button id="iconStyleEmoji" style="flex:1;border:2px solid ${iconStyle === 'emoji' ? '#0b93f6' : '#f0f0f0'};background:white;border-radius:14px;padding:12px;font-size:13px;cursor:pointer;">😀 旧图标（Emoji）</button>
    </div>
</div>

                    <div style="margin-top:16px;">
                        <div style="font-size:13px; color:#888; margin-bottom:10px;">🖼️ 自定义壁纸（可叠加在任意主题上）</div>
                        <div class="theme-card" id="customBgCard" style="
                            display:flex; align-items:center; gap:14px;
                            padding:14px 16px; border-radius:16px;
                            border:2px solid #f0f0f0; background:white; cursor:pointer;
                        ">
                            <div id="customBgPreview" style="
                                width:48px; height:48px; border-radius:10px; flex-shrink:0;
                                background:#f0f0f0; background-size:cover; background-position:center;
                                box-shadow:inset 0 0 0 1px rgba(0,0,0,0.08);
                            "></div>
                            <div style="flex:1; min-width:0;">
                                <div style="font-weight:600; font-size:15px;" id="customBgLabel">选择图片</div>
                                <div style="font-size:12px; color:#999; margin-top:2px;">支持 jpg/png，自动压缩</div>
                            </div>
                            <input type="file" id="customBgInput" accept="image/*" hidden>
                            <button id="customBgClear" style="border:none;background:transparent;color:#e53935;font-size:12px;display:none;">移除</button>
                        </div>
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

    // ★ 自定义壁纸：选择/预览/移除
    const bgInput = container.querySelector('#customBgInput');
    const bgCard = container.querySelector('#customBgCard');
    const bgPreview = container.querySelector('#customBgPreview');
    const bgLabel = container.querySelector('#customBgLabel');
    const bgClear = container.querySelector('#customBgClear');
    const savedBg = localStorage.getItem('desk_bg');
    if (savedBg) {
        if (bgPreview) bgPreview.style.backgroundImage = `url('${savedBg}')`;
        if (bgLabel) bgLabel.textContent = '更换壁纸';
        if (bgClear) bgClear.style.display = '';
    }
    if (bgCard && bgInput) {
        bgCard.addEventListener('click', (e) => {
            if (e.target === bgClear) return;
            bgInput.click();
        });
        bgInput.addEventListener('change', async () => {
            const file = bgInput.files?.[0];
            if (!file) return;
            try {
                const dataUrl = await compressImage(file);
                localStorage.setItem('desk_bg', dataUrl);
                if (bgPreview) bgPreview.style.backgroundImage = `url('${dataUrl}')`;
                if (bgLabel) bgLabel.textContent = '更换壁纸';
                if (bgClear) bgClear.style.display = '';
            } catch (err) {
                alert('图片处理失败，请换一张试试');
            }
        });
        bgClear?.addEventListener('click', (e) => {
            e.stopPropagation();
            localStorage.removeItem('desk_bg');
            if (bgPreview) bgPreview.style.backgroundImage = '';
            if (bgLabel) bgLabel.textContent = '选择图片';
            bgClear.style.display = 'none';
        });
    }
    const setIconStyle = (style) => {
        localStorage.setItem(ICON_STYLE_KEY, style);
        window.dispatchEvent(new CustomEvent('theme-changed', { detail: { iconStyle: style } }));   // ★ 触发 app.js 刷新首页
        const appContainer = container.closest('.screen-page') || container;
        appContainer.innerHTML = renderDesktopThemeSettings();
        bindDesktopThemeEvents(appContainer, onBack);
    };
    container.querySelector('#iconStyleNew')?.addEventListener('click', () => setIconStyle('new'));
    container.querySelector('#iconStyleEmoji')?.addEventListener('click', () => setIconStyle('emoji'));

    // 主题选择（★ 只绑定带 data-theme 的卡片，排除自定义壁纸卡片）
    container.querySelectorAll('.theme-card[data-theme]').forEach(card => {
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

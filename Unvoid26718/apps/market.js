// apps/market.js — 应用市场

export const id = 'market';
export const label = '应用市场';
export const icon = '🏪';
export const color = '#ff9800';

let viewingApp = null;

// ---- 列表页渲染 ----
function renderMarketList() {
    const apps = [
        { id: 'pixel-avatar', text: '🎨 像素头像生成器', desc: '自由绘制或随机生成' },
        { id: 'ai-image-gen', text: '🎨 AI 图片生成', desc: 'AI 根据描述生成图片' },
        { text: '📝 便签', desc: '快速记录想法（即将上线）' },
        { text: '🔮 占卜', desc: '命运占卜小工具（即将上线）' },
    ];

    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">🏪 应用市场</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card" style="padding:0;">
                    ${apps.map(app => `
                        <div class="market-app-item ${app.id ? 'clickable' : ''}"
                             ${app.id ? `data-app="${app.id}"` : ''}
                             style="display:flex; align-items:center; gap:14px; padding:16px 18px;
                                    cursor:${app.id ? 'pointer' : 'default'};
                                    border-bottom:1px solid #f0f0f0;
                                    opacity:${app.id ? '1' : '0.5'};">
                            <span style="font-size:28px;">${app.text.split(' ')[0]}</span>
                            <div style="flex:1;">
                                <div style="font-weight:600; font-size:15px;">${app.text}</div>
                                <div style="font-size:12px; color:#999; margin-top:2px;">${app.desc}</div>
                            </div>
                            ${app.id ? '<span style="color:#ccc; font-size:18px;">›</span>' : '<span style="font-size:11px; color:#ccc;">即将上线</span>'}
                        </div>
                    `).join('')}
                </div>
            </div>
        </div>
    `;
}

// ---- 主渲染 ----
export function render() {
    if (viewingApp === 'pixel-avatar') {
        // ★ 直接返回一个占位容器，不要包 .screen-page
        return '<div id="pixelAppContainer" style="height:100%;"></div>';
    }
    return renderMarketList();
}

// ---- 事件绑定 ----
export function bindEvents(container) {
    if (viewingApp === 'pixel-avatar') {
        // 动态加载像素头像模块并初始化
        import('./market/pixelAvatar.js').then(mod => {
            // ★ 直接用 pageContainer 替换整个页面
            const appContainer = container.closest('.page-container') || container;
            appContainer.innerHTML = mod.render();
            mod.bindEvents(appContainer);
        }).catch(e => {
            console.error('像素头像模块加载失败:', e);
            const appContainer = container.closest('.page-container') || container;
            appContainer.innerHTML = `<div class="screen-page"><div class="screen-content"><div class="page-card"><p style="text-align:center;color:#e53935;padding:40px;">❌ 模块加载失败（${e.message}）</p></div></div></div>`;
        });
        return;
    }

    if (viewingApp === 'ai-image-gen') {
    import('./market/aiImageGen.js').then(mod => {
        const appContainer = container.closest('.page-container') || container;
        appContainer.innerHTML = mod.render();
        mod.bindEvents(appContainer);
    }).catch(e => {
        console.error('AI 图片模块加载失败:', e);
        const appContainer = container.closest('.page-container') || container;
        appContainer.innerHTML = `<div class="screen-page"><div class="screen-content"><div class="page-card"><p style="text-align:center;color:#e53935;padding:40px;">❌ 模块加载失败（${e.message}）</p></div></div></div>`;
    });
    return;
}


    // 列表页：点击进入子应用
    container.querySelectorAll('.market-app-item[data-app]').forEach(item => {
        item.addEventListener('click', () => {
            viewingApp = item.dataset.app;
            // ★ 用 page-container 而不是 .screen-page
            const appContainer = container.closest('.page-container') || container;
            appContainer.innerHTML = render();
            bindEvents(appContainer);
        });
    });
}

// ---- 返回处理 ----
export function handleBack(container) {
    if (viewingApp !== null) {
        viewingApp = null;
        const appContainer = container.closest('.page-container') || container;
        appContainer.innerHTML = render();
        bindEvents(appContainer);
        return true;
    }
    return false;
}

if (!window.__moduleRegistry) window.__moduleRegistry = [];
window.__moduleRegistry.push({ id, label, icon, color, render, bindEvents, handleBack });

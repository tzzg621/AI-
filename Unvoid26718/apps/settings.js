// apps/settings.js — 设置页面（唯一注册模块）

import { getPresets } from './aiService.js';

export const id = 'settings';
export const label = '设置';
export const icon = '⚙️';
export const color = '#666';

let inSubPage = false;

// ---- 设置列表页渲染 ----
function renderSettingsList() {
    const presets = getPresets();
    const defaultPreset = presets.find(p => p.isDefault) || presets[0];
    const apiSummary = defaultPreset
        ? `${defaultPreset.name} · ${defaultPreset.model}`
        : '未配置';

    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">⚙️ 设置</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card" style="padding:0;">
                    <div class="settings-section-item" data-section="api" style="
                        display:flex; align-items:center; gap:14px;
                        padding:16px 18px; cursor:pointer;
                        border-bottom:1px solid #f0f0f0;
                    ">
                        <span style="font-size:28px;">🔑</span>
                        <div style="flex:1;">
                            <div style="font-weight:600; font-size:15px;">API 设置</div>
                            <div style="font-size:12px; color:#999; margin-top:2px;">${apiSummary}</div>
                        </div>
                        <span style="color:#ccc; font-size:18px;">›</span>
                    </div>

<div class="settings-section-item" data-section="image-gen" style="
    display:flex; align-items:center; gap:14px;
    padding:16px 18px; cursor:pointer;
    border-bottom:1px solid #f0f0f0;
">
    <span style="font-size:28px;">🎨</span>
    <div style="flex:1;">
        <div style="font-weight:600; font-size:15px;">生图设置</div>
        <div style="font-size:12px; color:#999; margin-top:2px;">AI 生图 API 与默认参数</div>
    </div>
    <span style="color:#ccc; font-size:18px;">›</span>
</div>

                    <div class="settings-section-item" data-section="desktop-theme" style="
                        display:flex; align-items:center; gap:14px;
                        padding:16px 18px; cursor:pointer;
                        border-bottom:1px solid #f0f0f0;
                    ">
                        <span style="font-size:28px;">🎨</span>
                        <div style="flex:1;">
                            <div style="font-weight:600; font-size:15px;">桌面主题</div>
                            <div style="font-size:12px; color:#999; margin-top:2px;">切换桌面背景与配色方案</div>
                        </div>
                        <span style="color:#ccc; font-size:18px;">›</span>
                    </div>


                    <div class="settings-section-item" data-section="data-storage" style="
                        display:flex; align-items:center; gap:14px;
                        padding:16px 18px; cursor:pointer;
                        border-bottom:1px solid #f0f0f0;
                    ">
                        <span style="font-size:28px;">💾</span>
                        <div style="flex:1;">
                            <div style="font-weight:600; font-size:15px;">数据存储</div>
                            <div style="font-size:12px; color:#999; margin-top:2px;" id="storageSummary">计算中...</div>
                        </div>
                        <span style="color:#ccc; font-size:18px;">›</span>
                    </div>

                    <div class="settings-section-item" data-section="global" style="
    display:flex; align-items:center; gap:14px;
    padding:16px 18px; cursor:pointer;
    border-bottom:1px solid #f0f0f0;
">
    <span style="font-size:28px;">⚙️</span>
    <div style="flex:1;">
        <div style="font-weight:600; font-size:15px;">全局设置</div>
        <div style="font-size:12px; color:#999; margin-top:2px;">状态栏显示、界面偏好</div>
    </div>
    <span style="color:#ccc; font-size:18px;">›</span>
</div>

                    <div class="settings-section-item" style="
                        display:flex; align-items:center; gap:14px;
                        padding:16px 18px; cursor:pointer;
                    ">
                        <span style="font-size:28px;">🔍</span>
                        <div style="flex:1;">
                            <div style="font-weight:600; font-size:15px;">网络诊断</div>
                            <div style="font-size:12px; color:#999; margin-top:2px;">运行诊断</div>
                        </div>
                        <span style="color:#ccc; font-size:18px;">›</span>
                    </div>
                </div>
            </div>
        </div>
    `;

}

// ---- 渲染函数 ----
export function render() {
    return renderSettingsList();
}



// ---- 事件绑定 ----
export function bindEvents(container) {
    container.querySelectorAll('.settings-section-item[data-section="api"]').forEach(item => {
        item.addEventListener('click', async () => {
            let apiModule;
            try {
                apiModule = await import('./settingsApi.js');
            } catch (e) {
                alert('API 设置模块加载失败，请刷新重试');
                console.error('settingsApi.js 加载失败:', e);
                return;
            }

            inSubPage = true;

            // ★ 隐藏全局返回键
            const backBtn = document.getElementById('statusBackBtn');
            if (backBtn) backBtn.style.display = 'none';

            const appContainer = container.closest('.screen-page') || container;
            appContainer.innerHTML = apiModule.renderApiSettings();
            apiModule.bindApiEvents(appContainer, () => {
                // ★ 返回列表：恢复全局返回键
                inSubPage = false;
                if (backBtn) backBtn.style.display = '';

                appContainer.innerHTML = renderSettingsList();
                bindEvents(appContainer);
            });
        });
    });

    container.querySelectorAll('.settings-section-item[data-section="image-gen"]').forEach(item => {
        item.addEventListener('click', async () => {
            let imgGenModule;
            try {
                imgGenModule = await import('./settingsImageGen.js');
            } catch (e) {
                alert('生图设置模块加载失败');
                console.error('settingsImageGen.js 加载失败:', e);
                return;
            }

            inSubPage = true;

            const backBtn = document.getElementById('statusBackBtn');
            if (backBtn) backBtn.style.display = 'none';

            const appContainer = container.closest('.screen-page') || container;
            appContainer.innerHTML = imgGenModule.renderImageGenSettings();
            imgGenModule.bindImageGenEvents(appContainer, () => {
                inSubPage = false;
                if (backBtn) backBtn.style.display = '';
                appContainer.innerHTML = renderSettingsList();
                bindEvents(appContainer);
            });
        });
    });
    
    container.querySelectorAll('.settings-section-item[data-section="desktop-theme"]').forEach(item => {
        item.addEventListener('click', async () => {
            let themeModule;
            try {
                themeModule = await import('./settingsDesktopTheme.js');
            } catch (e) {
                alert('桌面主题模块加载失败');
                console.error('settingsDesktopTheme.js 加载失败:', e);
                return;
            }

            inSubPage = true;

            const backBtn = document.getElementById('statusBackBtn');
            if (backBtn) backBtn.style.display = 'none';

            const appContainer = container.closest('.screen-page') || container;
            appContainer.innerHTML = themeModule.renderDesktopThemeSettings();
            themeModule.bindDesktopThemeEvents(appContainer, () => {
                inSubPage = false;
                if (backBtn) backBtn.style.display = '';
                appContainer.innerHTML = renderSettingsList();
                bindEvents(appContainer);
            });
        });
    });

        container.querySelectorAll('.settings-section-item[data-section="data-storage"]').forEach(item => {
        item.addEventListener('click', async () => {
            let backupModule;
            try {
                backupModule = await import('./settingsDataBackup.js');
            } catch (e) {
                alert('数据备份模块加载失败');
                console.error('settingsDataBackup.js 加载失败:', e);
                return;
            }

            inSubPage = true;

            const backBtn = document.getElementById('statusBackBtn');
            if (backBtn) backBtn.style.display = 'none';

            const appContainer = container.closest('.screen-page') || container;
            appContainer.innerHTML = backupModule.renderDataBackup();
            backupModule.bindDataBackupEvents(appContainer, () => {
                inSubPage = false;
                if (backBtn) backBtn.style.display = '';
                appContainer.innerHTML = renderSettingsList();
                bindEvents(appContainer);
            });
        });
    });

        container.querySelectorAll('.settings-section-item[data-section="global"]').forEach(item => {
        item.addEventListener('click', async () => {
            let globalModule;
            try {
                globalModule = await import('./settingsGlobal.js');
            } catch (e) {
                alert('全局设置模块加载失败');
                console.error('settingsGlobal.js 加载失败:', e);
                return;
            }

            inSubPage = true;

            const backBtn = document.getElementById('statusBackBtn');
            if (backBtn) backBtn.style.display = 'none';

            const appContainer = container.closest('.screen-page') || container;
            appContainer.innerHTML = globalModule.renderGlobalSettings();
            globalModule.bindGlobalEvents(appContainer, () => {
                inSubPage = false;
                if (backBtn) backBtn.style.display = '';
                appContainer.innerHTML = renderSettingsList();
                bindEvents(appContainer);
            });
        });
    });


    // ★ 异步计算并显示存储量
    (async function updateStorageSummary() {
        const summaryEl = document.getElementById('storageSummary');
        if (!summaryEl) return;

        let lsSize = 0;
        let lsCount = 0;
        let imgCount = 0;

        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && !key.startsWith('img_')) {
                const val = localStorage.getItem(key);
                lsSize += val ? val.length : 0;
                lsCount++;
            }
        }

        try {
            const { dbKeys } = await import('../store/ImageCache.js');
            const keys = await dbKeys();
            imgCount = keys.length;
        } catch {}

        const sizeStr = lsSize > 1024 * 1024
            ? (lsSize / 1024 / 1024).toFixed(1) + 'MB'
            : (lsSize / 1024).toFixed(0) + 'KB';

        summaryEl.textContent = `${lsCount} 项文字 · ${imgCount} 张图片 · ${sizeStr}`;
    })();


}

// ---- 拦截返回键 ----
export function handleBack() {
    if (inSubPage) {
        return true;  // 吃掉返回事件
    }
    return false;
}

if (!window.__moduleRegistry) window.__moduleRegistry = [];
window.__moduleRegistry.push({ id, label, icon, color, render, bindEvents, handleBack });

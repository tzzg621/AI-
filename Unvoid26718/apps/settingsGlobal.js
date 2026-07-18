export function renderGlobalSettings() {
    const showStatusBar = localStorage.getItem('global_show_status_bar') !== 'false';
    const showTaskCenter = localStorage.getItem('global_show_task_center') !== 'false';
    const showPetAlbum = localStorage.getItem('global_show_pet_album') === 'true';

    return `
        <div class="screen-page">
            <div class="screen-header">
                <button class="status-back-btn" id="globalBackBtn" style="flex-shrink:0;">←</button>
                <div class="screen-title">⚙️ 全局设置</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card">
                    <!-- 状态栏开关 -->
                    <div style="display:flex; align-items:center; justify-content:space-between; padding:14px 4px; border-bottom:1px solid #f0f0f0;">
                        <div>
                            <div style="font-weight:600; font-size:15px;">📱 状态栏</div>
                            <div style="font-size:12px; color:#999; margin-top:2px;">在所有页面顶部显示时间/日期</div>
                        </div>
                        <button id="toggleStatusBarBtn"
                                style="padding:6px 16px; border-radius:14px; border:none;
                                       background:${showStatusBar ? '#0b93f6' : '#ccc'};
                                       color:white; cursor:pointer; font-size:13px; font-weight:600;">
                            ${showStatusBar ? '🟢 显示' : '⚪ 隐藏'}
                        </button>
                    </div>

                    <!-- 任务中心开关 -->
                    <div style="display:flex; align-items:center; justify-content:space-between; padding:14px 4px;">
                        <div>
                            <div style="font-weight:600; font-size:15px;">📋 AI 任务中心</div>
                            <div style="font-size:12px; color:#999; margin-top:2px;">显示 AI 任务悬浮窗</div>
                        </div>
                        <button id="toggleTaskCenterBtn"
                                style="padding:6px 16px; border-radius:14px; border:none;
                                       background:${showTaskCenter ? '#0b93f6' : '#ccc'};
                                       color:white; cursor:pointer; font-size:13px; font-weight:600;">
                            ${showTaskCenter ? '🟢 显示' : '⚪ 隐藏'}
                        </button>
                    </div>

                    <div style="display:flex; align-items:center; justify-content:space-between; padding:14px 4px; border-bottom:1px solid #f0f0f0;">
    <div>
        <div style="font-weight:600; font-size:15px;">🐱 桌宠相册</div>
        <div style="font-size:12px; color:#999; margin-top:2px;">在相册中显示桌宠精灵图上传入口</div>
    </div>
    <button id="togglePetAlbumBtn"
            style="padding:6px 16px; border-radius:14px; border:none;
                   background:${showPetAlbum ? '#0b93f6' : '#ccc'};
                   color:white; cursor:pointer; font-size:13px; font-weight:600;">
        ${showPetAlbum ? '🟢 显示' : '⚪ 隐藏'}
    </button>
</div>
                </div>
            </div>
        </div>
    `;
}

export function bindGlobalEvents(container, onBack) {
    container.querySelector('#globalBackBtn')?.addEventListener('click', onBack);

    // 状态栏开关
    container.querySelector('#toggleStatusBarBtn')?.addEventListener('click', () => {
        const current = localStorage.getItem('global_show_status_bar') !== 'false';
        localStorage.setItem('global_show_status_bar', current ? 'false' : 'true');
        const mockBar = document.getElementById('mockStatusBar');
        if (mockBar) mockBar.classList.toggle('hidden', current);
        const appContainer = container.closest('.screen-page') || container;
        appContainer.innerHTML = renderGlobalSettings();
        bindGlobalEvents(appContainer, onBack);
    });

    // 任务中心开关
    container.querySelector('#toggleTaskCenterBtn')?.addEventListener('click', () => {
        const current = localStorage.getItem('global_show_task_center') !== 'false';
        localStorage.setItem('global_show_task_center', current ? 'false' : 'true');
        
        // ★ 通知 AITaskManager 更新显示状态
        window.dispatchEvent(new CustomEvent('task-center-visibility', {
            detail: { visible: !current }
        }));

        const appContainer = container.closest('.screen-page') || container;
        appContainer.innerHTML = renderGlobalSettings();
        bindGlobalEvents(appContainer, onBack);
    });

    container.querySelector('#togglePetAlbumBtn')?.addEventListener('click', () => {
    const current = localStorage.getItem('global_show_pet_album') === 'true';
    localStorage.setItem('global_show_pet_album', current ? 'false' : 'true');
    // 重渲染
    const appContainer = container.closest('.screen-page') || container;
    appContainer.innerHTML = renderGlobalSettings();
    bindGlobalEvents(appContainer, onBack);
});

}

// apps/settingsDataBackup.js — 数据备份

const BACKUP_VERSION = 1;

// ---- 导出 localStorage 文字数据（排除旧图片数据）----
function collectTextData() {
    const data = {};
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        // 排除 img_ 开头的旧图片 base64 数据（这些属于图片类）
        if (key && !key.startsWith('img_')) {
            try { data[key] = localStorage.getItem(key); } catch {}
        }
    }
    return data;
}

// ---- 导出图片数据（IndexedDB + localStorage 旧数据）----
async function collectImageData() {
    const images = {};

    // 从 IndexedDB 读取所有图片
    try {
        const { dbKeys, dbGet } = await import('../store/ImageCache.js');
        const keys = await dbKeys();
        for (const key of keys) {
            const data = await dbGet(key);
            if (data) images[key] = data;
        }
    } catch (e) { console.warn('IndexedDB 读取失败:', e); }

    // 从 localStorage 读取旧图片数据
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('img_')) {
            try { images[key] = localStorage.getItem(key); } catch {}
        }
    }

    return images;
}

// ---- 下载 JSON 文件 ----
function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
}

// ---- 写入 IndexedDB ----
async function writeImagesToDB(images) {
    const { dbPut } = await import('../store/ImageCache.js');
    const keys = Object.keys(images);
    let count = 0;
    for (const key of keys) {
        try {
            await dbPut(key, images[key]);
            count++;
        } catch (e) { console.warn('写入失败:', key, e); }
    }
    return count;
}

// ---- Toast ----
function showToast(msg, bg = '#333') {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:${bg};color:#fff;padding:10px 20px;border-radius:12px;z-index:10000;font-size:13px;box-shadow:0 4px 20px rgba(0,0,0,0.2);max-width:80%;text-align:center;`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
}

// ---- 渲染 ----
export function renderDataBackup() {
    return `
        <div class="screen-page">
            <div class="screen-header">
                <button class="status-back-btn" id="backupBackBtn" style="flex-shrink:0;">←</button>
                <div class="screen-title">💾 数据备份</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card">
                    <div style="font-size:14px; color:#666; margin-bottom:16px;">
                        导出数据为 JSON 文件，或导入之前备份的文件恢复数据。
                        <br><span style="font-size:12px; color:#999;">⚠️ 导入会覆盖当前所有数据，操作后请刷新页面。</span>
                    </div>

                    <div style="font-weight:600; font-size:15px; margin-bottom:10px;">📤 导出</div>
                    <button id="exportTextBtn" style="
                        width:100%; padding:12px; border-radius:12px; border:none;
                        background:#0b93f6; color:white; cursor:pointer; font-size:14px; font-weight:600;
                        margin-bottom:8px;
                    ">📝 仅导出文字数据</button>
                    <button id="exportImagesBtn" style="
                        width:100%; padding:12px; border-radius:12px; border:none;
                        background:#e91e63; color:white; cursor:pointer; font-size:14px; font-weight:600;
                        margin-bottom:8px;
                    ">🖼️ 仅导出图片数据</button>
                    <button id="exportAllBtn" style="
                        width:100%; padding:12px; border-radius:12px; border:none;
                        background:#9c27b0; color:white; cursor:pointer; font-size:14px; font-weight:600;
                        margin-bottom:16px;
                    ">📦 导出全部数据</button>

                    <div style="border-top:1px solid #eee; padding-top:14px;">
                        <div style="font-weight:600; font-size:15px; margin-bottom:10px;">📥 导入</div>
                        <button id="importBtn" style="
                            width:100%; padding:12px; border-radius:12px; border:2px dashed #ff7043;
                            background:white; color:#ff7043; cursor:pointer; font-size:14px; font-weight:600;
                        ">📂 选择备份文件导入</button>
                        <input type="file" id="importFileInput" accept=".json" style="display:none;">
                    </div>
                </div>
            </div>
        </div>
    `;
}

// ---- 事件绑定 ----
export function bindDataBackupEvents(container, onBack) {
    // 返回
    container.querySelector('#backupBackBtn')?.addEventListener('click', () => {
        const statusBar = document.querySelector('.status-bar');
        const pullDownBar = document.getElementById('pullDownBar');
        if (statusBar) statusBar.style.display = '';
        if (pullDownBar) pullDownBar.style.display = '';
        onBack();
    });

    // 导出文字
    container.querySelector('#exportTextBtn')?.addEventListener('click', () => {
        const textData = collectTextData();
        const backup = {
            version: BACKUP_VERSION,
            createdAt: new Date().toISOString(),
            type: 'text',
            localStorage: textData,
            images: {}
        };
        downloadJSON(backup, `backup_text_${Date.now()}.json`);
        showToast('✅ 文字数据已导出', '#0b93f6');
    });

    // 导出图片
    container.querySelector('#exportImagesBtn')?.addEventListener('click', async () => {
        const btn = container.querySelector('#exportImagesBtn');
        btn.textContent = '⏳ 正在收集图片...';
        btn.disabled = true;
        try {
            const images = await collectImageData();
            const backup = {
                version: BACKUP_VERSION,
                createdAt: new Date().toISOString(),
                type: 'images',
                localStorage: {},
                images
            };
            downloadJSON(backup, `backup_images_${Date.now()}.json`);
            showToast(`✅ 已导出 ${Object.keys(images).length} 张图片`, '#e91e63');
        } catch (e) {
            showToast('❌ 导出失败: ' + e.message, '#c62828');
        } finally {
            btn.textContent = '🖼️ 仅导出图片数据';
            btn.disabled = false;
        }
    });

    // 导出全部
    container.querySelector('#exportAllBtn')?.addEventListener('click', async () => {
        const btn = container.querySelector('#exportAllBtn');
        btn.textContent = '⏳ 正在收集数据...';
        btn.disabled = true;
        try {
            const textData = collectTextData();
            const images = await collectImageData();
            const backup = {
                version: BACKUP_VERSION,
                createdAt: new Date().toISOString(),
                type: 'all',
                localStorage: textData,
                images
            };
            downloadJSON(backup, `backup_full_${Date.now()}.json`);
            showToast(`✅ 已导出 ${Object.keys(textData).length} 项文字 + ${Object.keys(images).length} 张图片`, '#9c27b0');
        } catch (e) {
            showToast('❌ 导出失败: ' + e.message, '#c62828');
        } finally {
            btn.textContent = '📦 导出全部数据';
            btn.disabled = false;
        }
    });

    // 导入
    const fileInput = container.querySelector('#importFileInput');
    container.querySelector('#importBtn')?.addEventListener('click', () => {
        fileInput?.click();
    });

    fileInput?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
            const text = await file.text();
            const backup = JSON.parse(text);

            if (!backup.version || !backup.localStorage) {
                showToast('❌ 无效的备份文件', '#c62828');
                return;
            }

            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:200;display:flex;align-items:center;justify-content:center;';
            overlay.innerHTML = `
                <div style="background:white;border-radius:20px;padding:24px 20px;width:280px;text-align:center;">
                    <div style="font-size:15px;color:#333;margin-bottom:14px;line-height:1.5;">
                        确定要导入备份吗？<br>
                        <span style="font-size:12px;color:#e53935;">当前所有数据将被覆盖。</span>
                    </div>
                    <div style="font-size:12px;color:#888;margin-bottom:16px;">
                        文字 ${Object.keys(backup.localStorage).length} 项
                        ${backup.images ? `· 图片 ${Object.keys(backup.images).length} 张` : ''}
                    </div>
                    <div style="display:flex;gap:10px;">
                        <button class="import-confirm" style="flex:1;padding:10px;border-radius:12px;border:none;background:#e53935;color:white;cursor:pointer;font-size:14px;font-weight:600;">确定导入</button>
                        <button class="import-cancel" style="flex:1;padding:10px;border-radius:12px;border:1px solid #ccc;background:white;color:#666;cursor:pointer;font-size:14px;">取消</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);

            overlay.querySelector('.import-cancel').onclick = () => overlay.remove();

            overlay.querySelector('.import-confirm').onclick = async () => {
                overlay.remove();
                const importBtn = container.querySelector('#importBtn');
                importBtn.textContent = '⏳ 正在导入...';
                importBtn.disabled = true;

                try {
                    // 写入 localStorage
                    let lsCount = 0;
                    for (const [key, value] of Object.entries(backup.localStorage)) {
                        try {
                            localStorage.setItem(key, value);
                            lsCount++;
                        } catch (e) { console.warn('写入失败:', key); }
                    }

                    // 写入图片
                    let imgCount = 0;
                    if (backup.images && Object.keys(backup.images).length > 0) {
                        imgCount = await writeImagesToDB(backup.images);
                    }

                    showToast(`✅ 导入完成！${lsCount} 项文字 + ${imgCount} 张图片，请刷新页面`, '#2e7d32');
                    importBtn.textContent = '📂 选择备份文件导入';
                    importBtn.disabled = false;
                } catch (e) {
                    showToast('❌ 导入失败: ' + e.message, '#c62828');
                    importBtn.textContent = '📂 选择备份文件导入';
                    importBtn.disabled = false;
                }
            };
        } catch (e) {
            showToast('❌ 文件解析失败: ' + e.message, '#c62828');
        }

        // 重置 input，允许重复选择同一文件
        fileInput.value = '';
    });
}

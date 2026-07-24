// store/dialog.js — 统一弹窗（替代 alert / confirm / prompt）

/**
 * 信息提示弹窗（替代 alert）
 * @param {string} message
 * @returns {Promise<void>}
 */
export function showAlert(message) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:200;display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = `
            <div style="background:white;border-radius:20px;padding:24px 20px;width:280px;text-align:center;">
                <div style="font-size:15px;color:#333;margin-bottom:20px;line-height:1.5;">${message}</div>
                <button class="dlg-ok" style="width:100%;padding:10px;border-radius:12px;border:none;background:#0b93f6;color:white;cursor:pointer;font-size:14px;font-weight:600;">知道了</button>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.querySelector('.dlg-ok').onclick = () => { overlay.remove(); resolve(); };
    });
}

/**
 * 确认弹窗（替代 confirm）
 * @param {string} message
 * @returns {Promise<boolean>} true=确定, false=取消
 */
export function showConfirm(message) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:200;display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = `
            <div style="background:white;border-radius:20px;padding:24px 20px;width:280px;text-align:center;">
                <div style="font-size:15px;color:#333;margin-bottom:20px;line-height:1.5;">${message}</div>
                <div style="display:flex;gap:10px;">
                    <button class="dlg-yes" style="flex:1;padding:10px;border-radius:12px;border:none;background:#e53935;color:white;cursor:pointer;font-size:14px;font-weight:600;">确定</button>
                    <button class="dlg-no" style="flex:1;padding:10px;border-radius:12px;border:1px solid #ccc;background:white;color:#666;cursor:pointer;font-size:14px;">取消</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.querySelector('.dlg-yes').onclick = () => { overlay.remove(); resolve(true); };
        overlay.querySelector('.dlg-no').onclick = () => { overlay.remove(); resolve(false); };
    });
}

/**
 * 输入弹窗（替代 prompt）
 * @param {string} message
 * @param {string} [defaultValue='']
 * @returns {Promise<string|null>} 用户输入的值，取消返回 null
 */
export function showPrompt(message, defaultValue = '') {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:200;display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = `
            <div style="background:white;border-radius:20px;padding:24px 20px;width:280px;text-align:center;">
                <div style="font-size:15px;color:#333;margin-bottom:14px;line-height:1.5;">${message}</div>
                <input class="dlg-input" type="text" value="${defaultValue}" style="width:100%;border:1px solid #ccc;border-radius:10px;padding:10px;font-size:14px;box-sizing:border-box;margin-bottom:14px;" />
                <div style="display:flex;gap:10px;">
                    <button class="dlg-ok" style="flex:1;padding:10px;border-radius:12px;border:none;background:#0b93f6;color:white;cursor:pointer;font-size:14px;font-weight:600;">确定</button>
                    <button class="dlg-cancel" style="flex:1;padding:10px;border-radius:12px;border:1px solid #ccc;background:white;color:#666;cursor:pointer;font-size:14px;">取消</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const input = overlay.querySelector('.dlg-input');
        input.focus();
        input.select();

        overlay.querySelector('.dlg-ok').onclick = () => { overlay.remove(); resolve(input.value); };
        overlay.querySelector('.dlg-cancel').onclick = () => { overlay.remove(); resolve(null); };
        // 回车确认
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { overlay.remove(); resolve(input.value); }
        });
    });
}


// ============================================================
//  裁剪编辑器
// ============================================================

/**
 * 显示裁剪编辑器
 * @param {string} imageSrc - 图片 data URL 或 blob URL
 * @param {object} [options]
 * @param {number} [options.ratio] - 裁剪比例，如 1 表示正方形，不传则自由
 * @returns {Promise<{x:number, y:number, w:number, h:number}|null>}
 */
export function showCropEditor(imageSrc, options = {}) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:300;display:flex;flex-direction:column;align-items:center;justify-content:center;';

        overlay.innerHTML = `
            <div style="background:white;border-radius:20px;overflow:hidden;width:300px;">
                <div style="padding:14px 16px;font-weight:600;font-size:15px;border-bottom:1px solid #eee;">
                    ✂️ 裁剪图片
                </div>
                <div style="position:relative;width:100%;aspect-ratio:1;background:#f0f0f0;" id="cropContainer">
                    <img id="cropImage" src="${imageSrc}" style="width:100%;height:100%;object-fit:contain;display:block;user-select:none;" draggable="false">
                    <!-- 裁剪框 -->
                    <div id="cropBox" style="
                        position:absolute;top:10%;left:10%;width:80%;height:80%;
                        border:2px solid #0b93f6;box-shadow:0 0 0 9999px rgba(0,0,0,0.5);
                        cursor:move;box-sizing:border-box;
                    ">
                        <!-- 四个角把手 -->
                        <div class="crop-handle" data-dir="nw" style="position:absolute;top:-6px;left:-6px;width:12px;height:12px;border-radius:50%;background:#0b93f6;cursor:nw-resize;"></div>
                        <div class="crop-handle" data-dir="ne" style="position:absolute;top:-6px;right:-6px;width:12px;height:12px;border-radius:50%;background:#0b93f6;cursor:ne-resize;"></div>
                        <div class="crop-handle" data-dir="sw" style="position:absolute;bottom:-6px;left:-6px;width:12px;height:12px;border-radius:50%;background:#0b93f6;cursor:sw-resize;"></div>
                        <div class="crop-handle" data-dir="se" style="position:absolute;bottom:-6px;right:-6px;width:12px;height:12px;border-radius:50%;background:#0b93f6;cursor:se-resize;"></div>
                    </div>
                </div>
                <div style="display:flex;gap:10px;padding:12px 16px;">
                    <button id="cropCancelBtn" style="flex:1;padding:10px;border-radius:12px;border:1px solid #ccc;background:white;color:#666;cursor:pointer;font-size:14px;">取消</button>
                    <button id="cropConfirmBtn" style="flex:1;padding:10px;border-radius:12px;border:none;background:#0b93f6;color:white;cursor:pointer;font-size:14px;font-weight:600;">确认裁剪</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        const container = overlay.querySelector('#cropContainer');
        const cropBox = overlay.querySelector('#cropBox');
        const img = overlay.querySelector('#cropImage');

        let isDragging = false, isResizing = false, resizeDir = '';
        let startX, startY, startRect;

        // 拖动裁剪框
        cropBox.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('crop-handle')) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            startRect = cropBox.getBoundingClientRect();
            e.preventDefault();
        });

        // 拉拽把手
        cropBox.querySelectorAll('.crop-handle').forEach(handle => {
            handle.addEventListener('mousedown', (e) => {
                isResizing = true;
                resizeDir = handle.dataset.dir;
                startX = e.clientX;
                startY = e.clientY;
                startRect = cropBox.getBoundingClientRect();
                e.preventDefault();
                e.stopPropagation();
            });
        });

        document.addEventListener('mousemove', (e) => {
            const cRect = container.getBoundingClientRect();
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const ratio = options.ratio || null;

            if (isDragging) {
                let t = startRect.top - cRect.top + dy;
                let l = startRect.left - cRect.left + dx;
                t = Math.max(0, Math.min(cRect.height - (startRect.bottom - startRect.top), t));
                l = Math.max(0, Math.min(cRect.width - (startRect.right - startRect.left), l));
                cropBox.style.top = (t / cRect.height * 100) + '%';
                cropBox.style.left = (l / cRect.width * 100) + '%';
            }

            if (isResizing) {
                let t = (startRect.top - cRect.top) * 100 / cRect.height;
                let l = (startRect.left - cRect.left) * 100 / cRect.width;
                let b = (cRect.bottom - startRect.bottom) * 100 / cRect.height;
                let r = (cRect.right - startRect.right) * 100 / cRect.width;
                const dpx = dx / cRect.width * 100;
                const dpy = dy / cRect.height * 100;

                if (resizeDir.includes('n')) { t += dpy; if (t < 0) t = 0; }
                if (resizeDir.includes('s')) { b -= dpy; if (b < 0) b = 0; }
                if (resizeDir.includes('w')) { l += dpx; if (l < 0) l = 0; }
                if (resizeDir.includes('e')) { r -= dpx; if (r < 0) r = 0; }

                // 保持比例
                if (ratio) {
                    const w = 100 - l - r;
                    const h = 100 - t - b;
                    const newH = w / ratio;
                    if (resizeDir.includes('s')) {
                        b = 100 - t - newH;
                        if (b < 0) { b = 0; t = 100 - newH; }
                    }
                    if (resizeDir.includes('n')) {
                        t = 100 - b - newH;
                        if (t < 0) { t = 0; b = 100 - newH; }
                    }
                }

                cropBox.style.top = t + '%';
                cropBox.style.left = l + '%';
                cropBox.style.width = (100 - l - r) + '%';
                cropBox.style.height = (100 - t - b) + '%';
            }
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
            isResizing = false;
        });

        overlay.querySelector('#cropCancelBtn').onclick = () => {
            overlay.remove();
            resolve(null);
        };

        overlay.querySelector('#cropConfirmBtn').onclick = () => {
            const cRect = container.getBoundingClientRect();
            const bRect = cropBox.getBoundingClientRect();
            const params = {
                x: (bRect.left - cRect.left) / cRect.width,
                y: (bRect.top - cRect.top) / cRect.height,
                w: bRect.width / cRect.width,
                h: bRect.height / cRect.height
            };
            overlay.remove();
            resolve(params);
        };
    });
}

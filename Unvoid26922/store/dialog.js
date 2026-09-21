// store/dialog.js — 统一弹窗（替代 alert / confirm / prompt）
import { esc } from './utils.js';

/**
 * 信息提示弹窗（替代 alert）
 * @param {string} message
 * @returns {Promise<void>}
 */
export function showAlert(message) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:900;display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = `
            <div style="background:white;border-radius:20px;padding:24px 20px;width:280px;text-align:center;">
                <div style="font-size:15px;color:#333;margin-bottom:20px;line-height:1.5;">${esc(message)}</div>
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
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:900;display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = `
            <div style="background:white;border-radius:20px;padding:24px 20px;width:280px;text-align:center;">
                <div style="font-size:15px;color:#333;margin-bottom:20px;line-height:1.5;">${esc(message)}</div>
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
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:900;display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = `
            <div style="background:white;border-radius:20px;padding:24px 20px;width:280px;text-align:center;">
                <div style="font-size:15px;color:#333;margin-bottom:14px;line-height:1.5;">${esc(message)}</div>
                <input class="dlg-input" type="text" value="${esc(defaultValue)}" style="width:100%;border:1px solid #ccc;border-radius:10px;padding:10px;font-size:14px;box-sizing:border-box;margin-bottom:14px;" />
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
 *
 * ★ 返回的是「相对原图自身」的 0~1 比例，不是相对弹窗容器的比例。
 *   显示端（store/ImageCache.js 的 makeImgHtml）就是按这个坐标系平移 + 放大的：
 *   弹窗里图片是 object-fit:contain（有黑边），显示端是铺满，两套坐标系不一样。
 *   旧版直接返回容器坐标，非方图必然错位（见 AI/06 变更日志）。
 *
 * @param {string} imageSrc - 图片 data URL 或 blob URL
 * @param {object} [options]
 * @param {number} [options.ratio] - 裁剪比例（宽/高），如 1 表示正方形；不传则自由裁剪。
 *   ★ 非 1 的比例要求显示端容器也是同样宽高比，否则会拉伸（1:1 容器配 ratio:1 恒安全）。
 * @returns {Promise<{x:number, y:number, w:number, h:number}|null>} 取消返回 null
 */
export function showCropEditor(imageSrc, options = {}) {
    const RATIO = options.ratio > 0 ? options.ratio : null;
    const MIN_SIDE = 0.08;   // 裁剪框最小边（原图比例），防止拖成一个点

    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:300;display:flex;flex-direction:column;align-items:center;justify-content:center;';

        overlay.innerHTML = `
            <div style="background:white;border-radius:20px;overflow:hidden;width:300px;">
                <div style="padding:14px 16px;font-weight:600;font-size:15px;border-bottom:1px solid #eee;">
                    ✂️ 裁剪图片
                </div>
                <div id="cropContainer" style="position:relative;width:100%;aspect-ratio:1;background:#f0f0f0;touch-action:none;">
                    <img id="cropImage" src="${esc(imageSrc)}" alt="" draggable="false"
                         style="width:100%;height:100%;object-fit:contain;display:block;user-select:none;-webkit-user-drag:none;">
                    <!-- ★ cropFrame 由 JS 摆成「contain 真正画出来的那块图」，cropBox 用百分比挂进去，
                         所以框的百分比 = 原图比例，窗口缩放也自动跟着走 -->
                    <div id="cropFrame" style="position:absolute;left:0;top:0;width:0;height:0;">
                        <div id="cropBox" style="
                            position:absolute;left:0;top:0;width:0;height:0;box-sizing:border-box;
                            border:2px solid #0b93f6;box-shadow:0 0 0 9999px rgba(0,0,0,0.5);
                            cursor:move;touch-action:none;visibility:hidden;
                        ">
                            <!-- 四个角把手 -->
                            <div class="crop-handle" data-dir="nw" style="position:absolute;top:-7px;left:-7px;width:14px;height:14px;border-radius:50%;background:#0b93f6;cursor:nw-resize;"></div>
                            <div class="crop-handle" data-dir="ne" style="position:absolute;top:-7px;right:-7px;width:14px;height:14px;border-radius:50%;background:#0b93f6;cursor:ne-resize;"></div>
                            <div class="crop-handle" data-dir="sw" style="position:absolute;bottom:-7px;left:-7px;width:14px;height:14px;border-radius:50%;background:#0b93f6;cursor:sw-resize;"></div>
                            <div class="crop-handle" data-dir="se" style="position:absolute;bottom:-7px;right:-7px;width:14px;height:14px;border-radius:50%;background:#0b93f6;cursor:se-resize;"></div>
                        </div>
                    </div>
                </div>
                <div id="cropHint" style="font-size:12px;color:#888;text-align:center;padding:10px 16px 0;min-height:16px;line-height:1.35;"></div>
                <div style="display:flex;gap:10px;padding:12px 16px;">
                    <button id="cropCancelBtn" style="flex:1;padding:10px;border-radius:12px;border:1px solid #ccc;background:white;color:#666;cursor:pointer;font-size:14px;">取消</button>
                    <button id="cropConfirmBtn" style="flex:1;padding:10px;border-radius:12px;border:none;background:#0b93f6;color:white;cursor:pointer;font-size:14px;font-weight:600;">确认裁剪</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        const container = overlay.querySelector('#cropContainer');
        const frame = overlay.querySelector('#cropFrame');
        const cropBox = overlay.querySelector('#cropBox');
        const img = overlay.querySelector('#cropImage');
        const hint = overlay.querySelector('#cropHint');
        const confirmBtn = overlay.querySelector('#cropConfirmBtn');

        // box 用「原图自身」的 0~1 比例存（就是最终交给显示端的那个坐标系）
        let box = null;
        let ratioN = RATIO;        // 换算到原图比例坐标系后的宽高比，见 layoutFrame
        let drag = null;

        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

        // 把 cropFrame 摆到 contain 真正画出图的那块区域上
        function layoutFrame() {
            const cRect = container.getBoundingClientRect();
            const nw = img.naturalWidth, nh = img.naturalHeight;
            if (!nw || !nh || !cRect.width || !cRect.height) return false;
            const s = Math.min(cRect.width / nw, cRect.height / nh);
            const dw = nw * s, dh = nh * s;
            frame.style.left = ((cRect.width - dw) / 2) + 'px';
            frame.style.top = ((cRect.height - dh) / 2) + 'px';
            frame.style.width = dw + 'px';
            frame.style.height = dh + 'px';
            // ★ 原图坐标系里，宽高比要按原图自身宽高比换算：w_norm/h_norm = ratio * nh/nw
            ratioN = RATIO ? RATIO * (nh / nw) : null;
            return true;
        }

        function applyBox() {
            if (!box) return;
            cropBox.style.left = (box.x * 100) + '%';
            cropBox.style.top = (box.y * 100) + '%';
            cropBox.style.width = (box.w * 100) + '%';
            cropBox.style.height = (box.h * 100) + '%';
            cropBox.style.visibility = 'visible';
        }

        function initBox() {
            // 默认给「能放下的最大一块」：方图就是整张，长图就是居中的最大正方形——
            // 正好等于显示端 object-fit:cover 的取景，一进来就知道会看到什么。
            let w = 1, h = 1;
            if (ratioN) {
                if (w / h > ratioN) w = h * ratioN; else h = w / ratioN;
            } else {
                w = h = 0.8;
            }
            box = { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
            applyBox();
        }

        // ---- 拖动 / 缩放：全程用 pointer 事件 + 指针捕获，收在 cropBox 自己身上 ----
        // 旧版往 document 上挂 mousemove/mouseup 且从不解绑，开两次就漏两对；
        // 而且只有鼠标事件，触屏根本拖不动。
        cropBox.addEventListener('pointerdown', (e) => {
            if (!box) return;
            const fRect = frame.getBoundingClientRect();
            if (!fRect.width || !fRect.height) return;
            drag = {
                dir: e.target.classList.contains('crop-handle') ? e.target.dataset.dir : 'move',
                fRect,
                px: (e.clientX - fRect.left) / fRect.width,   // 起点记成原图比例，拖动中不怕布局变
                py: (e.clientY - fRect.top) / fRect.height,
                from: { ...box }
            };
            try { cropBox.setPointerCapture(e.pointerId); } catch { }
            e.preventDefault();
            e.stopPropagation();
        });

        cropBox.addEventListener('pointermove', (e) => {
            if (!drag || !box) return;
            const nx = (e.clientX - drag.fRect.left) / drag.fRect.width;
            const ny = (e.clientY - drag.fRect.top) / drag.fRect.height;
            const g = drag.from;

            if (drag.dir === 'move') {
                box.x = clamp(g.x + (nx - drag.px), 0, 1 - g.w);
                box.y = clamp(g.y + (ny - drag.py), 0, 1 - g.h);
                applyBox();
                return;
            }

            // 角把手：对角固定当锚点，拖的角跟着手指走
            const west = drag.dir.includes('w');
            const north = drag.dir.includes('n');
            const ax = west ? g.x + g.w : g.x;
            const ay = north ? g.y + g.h : g.y;
            const maxW = west ? ax : 1 - ax;        // 往锚点方向最多能拉多长
            const maxH = north ? ay : 1 - ay;

            let w = Math.abs(nx - ax), h = Math.abs(ny - ay);
            if (ratioN) {
                // 锁比例：以「拖出去更多的那个方向」为准，再按边界收
                let W = Math.max(w, h * ratioN);
                W = Math.min(W, maxW, maxH * ratioN);
                // 不小于最小边，但也不能因此越过边界
                W = Math.max(W, Math.min(MIN_SIDE, maxW, maxH * ratioN));
                w = W; h = W / ratioN;
            } else {
                w = clamp(w, Math.min(MIN_SIDE, maxW), maxW);
                h = clamp(h, Math.min(MIN_SIDE, maxH), maxH);
            }

            box.w = w; box.h = h;
            box.x = west ? ax - w : ax;
            box.y = north ? ay - h : ay;
            applyBox();
        });

        const endDrag = (e) => {
            if (!drag) return;
            drag = null;
            try { cropBox.releasePointerCapture(e.pointerId); } catch { }
        };
        cropBox.addEventListener('pointerup', endDrag);
        cropBox.addEventListener('pointercancel', endDrag);

        // 窗口尺寸变了只要重摆一次 frame，cropBox 是百分比，自己会跟着走
        const onResize = () => { if (box) layoutFrame(); };
        window.addEventListener('resize', onResize);

        const cleanup = () => {
            window.removeEventListener('resize', onResize);
            overlay.remove();
        };

        const onReady = () => {
            if (!layoutFrame()) return;
            initBox();
            hint.textContent = RATIO
                ? '拖动方框选位置，拖四个角改大小（锁定比例）'
                : '拖动方框选位置，拖四个角改大小';
            confirmBtn.disabled = false;
            confirmBtn.style.opacity = '1';
        };

        const onFail = () => {
            hint.textContent = '图片加载失败，请重新选择';
            hint.style.color = '#c62828';
        };

        // 图没加载出来之前不让确认（调用方可能传来一个取不到数据的 key）
        confirmBtn.disabled = true;
        confirmBtn.style.opacity = '0.5';
        hint.textContent = '图片加载中…';
        if (img.complete && img.naturalWidth) {
            onReady();
        } else {
            img.addEventListener('load', onReady, { once: true });
            img.addEventListener('error', onFail, { once: true });
        }

        overlay.querySelector('#cropCancelBtn').onclick = () => {
            cleanup();
            resolve(null);
        };

        confirmBtn.onclick = () => {
            if (!box) { cleanup(); resolve(null); return; }
            const x = clamp(box.x, 0, 1), y = clamp(box.y, 0, 1);
            const params = {
                x, y,
                w: clamp(box.w, 0, 1 - x),
                h: clamp(box.h, 0, 1 - y)
            };
            cleanup();
            resolve(params);
        };
    });
}

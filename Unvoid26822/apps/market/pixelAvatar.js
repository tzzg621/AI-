// apps/market/pixelAvatar.js — 像素头像生成器
import { setGlobalImage } from '../../store/ImageCache.js';
import { showConfirm } from '../../store/dialog.js';

// ---- 参数 ----
const GRID_SIZE = 16;
const CELL_SIZE = 20;

const PRESET_COLORS = [
    '#FFFFFF', '#E0E0E0', '#9E9E9E', '#616161', '#212121',
    '#FFCDD2', '#E57373', '#F44336', '#D32F2F', '#B71C1C',
    '#F8BBD0', '#F06292', '#E91E63', '#C2185B', '#880E4F',
    '#E1BEE7', '#BA68C8', '#9C27B0', '#7B1FA2', '#4A148C',
    '#C5CAE9', '#7986CB', '#3F51B5', '#303F9F', '#1A237E',
    '#BBDEFB', '#64B5F6', '#2196F3', '#1976D2', '#0D47A1',
    '#B3E5FC', '#4FC3F7', '#03A9F4', '#0288D1', '#01579B',
    '#B2EBF2', '#4DD0E1', '#00BCD4', '#0097A7', '#006064',
    '#B2DFDB', '#4DB6AC', '#009688', '#00796B', '#004D40',
    '#C8E6C9', '#81C784', '#4CAF50', '#388E3C', '#1B5E20',
    '#DCEDC8', '#AED581', '#8BC34A', '#689F38', '#33691E',
    '#F0F4C3', '#DCE775', '#CDDC39', '#AFB42B', '#827717',
    '#FFF9C4', '#FFD54F', '#FFC107', '#FFA000', '#FF6F00',
    '#FFE0B2', '#FFB74D', '#FF9800', '#F57C00', '#E65100',
    '#FFCCBC', '#FF8A65', '#FF5722', '#E64A19', '#BF360C',
];

// ---- 状态 ----
let pixelGrid = [];
let selectedColor = '#E91E63';
let isDrawing = false;
let pendingAiResult = null;

// ---- 生成随机网格 ----
function generateRandomGrid() {
    const grid = [];
    for (let y = 0; y < GRID_SIZE; y++) {
        const row = [];
        for (let x = 0; x < GRID_SIZE; x++) {
            const colorIndex = Math.floor(Math.random() * (PRESET_COLORS.length - 5)) + 5;
            row.push(PRESET_COLORS[colorIndex]);
        }
        grid.push(row);
    }
    const emptyCount = Math.floor(Math.random() * 20) + 10;
    for (let i = 0; i < emptyCount; i++) {
        const rx = Math.floor(Math.random() * GRID_SIZE);
        const ry = Math.floor(Math.random() * GRID_SIZE);
        grid[ry][rx] = null;
    }
    return grid;
}

function resetGrid() {
    pixelGrid = generateRandomGrid();
    selectedColor = PRESET_COLORS[Math.floor(Math.random() * PRESET_COLORS.length)];
}

resetGrid();

// ---- Canvas 绘制 ----
function drawPixelGrid(ctx) {
    const w = GRID_SIZE * CELL_SIZE;
    const h = GRID_SIZE * CELL_SIZE;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(0, 0, w, h);

    for (let y = 0; y < GRID_SIZE; y++) {
        for (let x = 0; x < GRID_SIZE; x++) {
            const color = pixelGrid[y][x];
            if (color) {
                ctx.fillStyle = color;
                ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
            }
        }
    }

    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= GRID_SIZE; i++) {
        ctx.beginPath();
        ctx.moveTo(i * CELL_SIZE, 0);
        ctx.lineTo(i * CELL_SIZE, h);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, i * CELL_SIZE);
        ctx.lineTo(w, i * CELL_SIZE);
        ctx.stroke();
    }
}

function getGridPos(canvas, clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.floor((clientX - rect.left) * scaleX / CELL_SIZE);
    const y = Math.floor((clientY - rect.top) * scaleY / CELL_SIZE);
    if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return null;
    return { x, y };
}

function initPixelCanvas(canvas) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    drawPixelGrid(ctx);

    canvas.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (e.button === 2) return;
        const pos = getGridPos(canvas, e.clientX, e.clientY);
        if (!pos) return;
        pixelGrid[pos.y][pos.x] = selectedColor || null;
        drawPixelGrid(ctx);
        isDrawing = true;
    });

    canvas.addEventListener('mousemove', (e) => {
        if (!isDrawing) return;
        const pos = getGridPos(canvas, e.clientX, e.clientY);
        if (!pos) return;
        pixelGrid[pos.y][pos.x] = selectedColor || null;
        drawPixelGrid(ctx);
    });

    canvas.addEventListener('mouseup', () => { isDrawing = false; });
    canvas.addEventListener('mouseleave', () => { isDrawing = false; });

    canvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const pos = getGridPos(canvas, e.clientX, e.clientY);
        if (!pos) return;
        pixelGrid[pos.y][pos.x] = null;
        drawPixelGrid(ctx);
    });
}

// 替换 pixelAvatar.js 中的 downloadPixelAvatar 函数
function downloadPixelAvatar() {
    const exportSize = 64;
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = exportSize;
    exportCanvas.height = exportSize;
    const exportCtx = exportCanvas.getContext('2d');

    const cellSize = exportSize / GRID_SIZE;
    for (let y = 0; y < GRID_SIZE; y++) {
        for (let x = 0; x < GRID_SIZE; x++) {
            const color = pixelGrid[y][x];
            if (color) {
                exportCtx.fillStyle = color;
                exportCtx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
            }
        }
    }

    // ★ 改用 toBlob，移动端兼容性更好
    exportCanvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = `pixel_avatar_${Date.now()}.png`;
        link.href = url;
        // 有些浏览器需要把 link 加到 DOM 里才触发下载
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }, 'image/png');
}

// ---- 渲染 ----
export function render() {
    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">🎨 像素头像生成器</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card" style="text-align:center; display:flex; flex-direction:column; gap:10px;">

                    <!-- 操作按钮区 -->
                    <div style="display:flex; gap:6px; justify-content:center; flex-wrap:wrap;">
                        <button id="randomPixelBtn"
                                style="padding:6px 14px; border-radius:14px; border:none;
                                       background:#ff9800; color:white; cursor:pointer; font-size:12px;">
                            🎲 随机
                        </button>
                        <button id="smartPixelBtn"
                                style="padding:6px 14px; border-radius:14px; border:none;
                                       background:#9C27B0; color:white; cursor:pointer; font-size:12px;">
                            🎯 智能
                        </button>
                        <!-- ★ 新增 AI 生成按钮 -->
                        <button id="aiPixelBtn"
                                style="padding:6px 14px; border-radius:14px; border:none;
                                       background:#E91E63; color:white; cursor:pointer; font-size:12px;">
                            🤖 AI
                        </button>
                        <button id="downloadPixelBtn"
                                style="padding:6px 14px; border-radius:14px; border:none;
                                       background:#0b93f6; color:white; cursor:pointer; font-size:12px;">
                            ⬇ 下载
                        </button>
                        <button id="saveToAlbumBtn"
        style="padding:6px 14px; border-radius:14px; border:none;
               background:#4caf50; color:white; cursor:pointer; font-size:12px;">
    💾 相册
</button>

                        <button id="clearPixelBtn"
                                style="padding:6px 14px; border-radius:14px; border:1px solid #ccc;
                                       background:white; color:#666; cursor:pointer; font-size:12px;">
                            🗑️ 清空
                        </button>
                    </div>
                    ${pendingAiResult ? `
                        <div style="
                            padding:8px 14px; background:#e8f5e9; color:#2e7d32;
                            border-radius:12px; font-size:13px; font-weight:600;
                            display:flex; align-items:center; justify-content:space-between;
                        ">
                            <span>✨ AI 头像已就绪</span>
                            <div style="display:flex; gap:6px;">
                                <button id="applyPendingBtn" style="
                                    padding:4px 12px; border-radius:10px; border:none;
                                    background:#4CAF50; color:white; cursor:pointer; font-size:12px;
                                ">应用</button>
                                <button id="discardPendingBtn" style="
                                    padding:4px 8px; border-radius:10px; border:none;
                                    background:transparent; color:#888; cursor:pointer; font-size:12px;
                                ">✕</button>
                            </div>
                        </div>
                    ` : ''}

                    <!-- 画布 -->
                    <canvas id="pixelCanvas"
                            width="${GRID_SIZE * CELL_SIZE}"
                            height="${GRID_SIZE * CELL_SIZE}"
                            style="border:1px solid #ddd; border-radius:8px; cursor:crosshair;
                                   image-rendering:pixelated; width:320px; height:320px;
                                   margin:0 auto; display:block;"></canvas>

                    <!-- 调色板 -->
                    <div style="display:flex; flex-wrap:wrap; gap:3px;
                                justify-content:center; max-width:340px; margin:0 auto;">
                        <button class="pixel-color-btn" data-color=""
                                style="width:24px; height:24px; border-radius:4px; border:2px solid #e53935;
                                       background:repeating-linear-gradient(45deg, #fff, #fff 2px, #e0e0e0 2px, #e0e0e0 4px);
                                       cursor:pointer;" title="橡皮擦"></button>
                        ${PRESET_COLORS.map(c => `
                            <button class="pixel-color-btn" data-color="${c}"
                                    style="width:24px; height:24px; border-radius:4px; border:2px solid #ddd;
                                           background:${c}; cursor:pointer;"></button>
                        `).join('')}
                    </div>

                    <p style="font-size:12px; color:#888; margin:0;">
                        点击/拖动绘制 · 右键擦除 · 选色
                    </p>
                </div>
            </div>
        </div>
    `;
}

// ★ 新增：AI 生成函数（带超时和调试日志）
async function generateByAI(description) {
    console.log('🤖 AI 生成开始，描述:', description);

    const [{ callAIForPixel }, { PIXEL_AVATAR_PROMPT }] = await Promise.all([
        import('../aiService.js'),
        import('../prompts.js')
    ]);
    console.log('✅ 模块加载成功');

    try {
        // ★ 在调用前打印完整的请求消息
        console.log('📤 像素 AI 请求:', JSON.stringify({
            systemPrompt: PIXEL_AVATAR_PROMPT,
            description: description
        }, null, 2));

        const result = await callAIForPixel({
            description: description,
            systemPrompt: PIXEL_AVATAR_PROMPT,
            taskInfo: {
                type: 'pixel',
                label: '生成像素头像' + (description ? '：' + description.slice(0, 10) + '…' : '')
            }
        });
        console.log('✅ AI 返回原始内容:', result.substring(0, 100) + '...');

        // 尝试提取 JSON（如果 AI 加了 markdown 标记）
        let jsonStr = result;
        const match = result.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (match) {
            jsonStr = match[1];
            console.log('✅ 从 markdown 中提取到 JSON');
        }

        const grid = JSON.parse(jsonStr);
        console.log('✅ JSON 解析成功，行数:', grid.length);

        // 校验格式
        if (!Array.isArray(grid) || grid.length !== 16) {
            throw new Error('网格格式不正确');
        }
        for (let y = 0; y < 16; y++) {
            if (!Array.isArray(grid[y]) || grid[y].length !== 16) {
                throw new Error(`第 ${y + 1} 行格式不正确`);
            }
        }

        console.log('✅ 网格校验通过');
        return grid;
    } catch (e) {
        console.error('❌ AI 生成失败:', e);
        throw e;
    }
}

// ---- 事件绑定 ----
export function bindEvents(container) {
    const canvas = container.querySelector('#pixelCanvas');
    initPixelCanvas(canvas);

    // 橡皮擦/颜色选中高亮
    container.querySelectorAll('.pixel-color-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            selectedColor = btn.dataset.color || null;
            container.querySelectorAll('.pixel-color-btn').forEach(b => {
                b.style.border = '2px solid #ddd';
            });
            btn.style.border = selectedColor ? '3px solid #333' : '3px solid #e53935';
        });
    });

    container.querySelector('#randomPixelBtn')?.addEventListener('click', () => {
        pixelGrid = generateRandomGrid();
        const c = container.querySelector('#pixelCanvas');
        if (c) drawPixelGrid(c.getContext('2d'));
    });

    container.querySelector('#clearPixelBtn')?.addEventListener('click', async () => {
        const ok = await showConfirm('确定要清空所有像素吗？');
        if (!ok) return;
        pixelGrid = Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(null));
        const c = container.querySelector('#pixelCanvas');
        if (c) drawPixelGrid(c.getContext('2d'));
    });

    container.querySelector('#downloadPixelBtn')?.addEventListener('click', downloadPixelAvatar);

    container.querySelector('#smartPixelBtn')?.addEventListener('click', () => {
        pixelGrid = generateSmartGrid();
        const c = container.querySelector('#pixelCanvas');
        if (c) drawPixelGrid(c.getContext('2d'));
    });

    // ★ AI 生成
    container.querySelector('#aiPixelBtn')?.addEventListener('click', async () => {
        // ★ 改用自定义弹窗代替 prompt()
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); z-index:300; display:flex; align-items:center; justify-content:center;';
        overlay.innerHTML = `
            <div style="background:white; border-radius:20px; padding:20px; width:280px;">
                <div style="font-weight:600; font-size:16px; margin-bottom:4px;">🤖 AI 生成</div>
                <div style="font-size:12px; color:#888; margin-bottom:10px;">描述你想要的像素头像：</div>
                <textarea id="aiDescriptionInput" placeholder="例如：蓝色头发、红色眼睛的猫娘" rows="3"
                          style="width:100%; border:1px solid #ccc; border-radius:8px; padding:8px 10px; font-size:14px; margin-bottom:10px; box-sizing:border-box; font-family:inherit; resize:vertical;"></textarea>
                <div style="display:flex; gap:8px;">
                    <button id="aiInputCancelBtn"
                            style="flex:1; padding:8px; border-radius:12px; border:1px solid #ccc; background:white; color:#666; cursor:pointer; font-size:13px;">取消</button>
                    <button id="aiInputConfirmBtn"
                            style="flex:1; padding:8px; border-radius:12px; border:none; background:#E91E63; color:white; cursor:pointer; font-size:13px;">生成</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        overlay.querySelector('#aiInputCancelBtn')?.addEventListener('click', () => overlay.remove());
        overlay.querySelector('#aiInputConfirmBtn')?.addEventListener('click', async () => {
            const description = overlay.querySelector('#aiDescriptionInput').value.trim();
            overlay.remove();
            if (!description) return;

            const btn = container.querySelector('#aiPixelBtn');
            const originalText = btn.textContent;
            btn.textContent = '⏳ 生成中...';
            btn.disabled = true;

            try {
                const grid = await generateByAI(description);
                const c = container.querySelector('#pixelCanvas');
                if (c) {
                    // 还在页面里，直接应用
                    pixelGrid = grid;
                    drawPixelGrid(c.getContext('2d'));
                } else {
                    // 切出去了，暂存结果，下次回来再应用
                    pendingAiResult = grid;
                }
            } catch (e) {
                (function showError(msg) {
                    const t = document.createElement('div');
                    t.textContent = '❌ ' + msg;
                    t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#c62828;color:#fff;padding:10px 20px;border-radius:10px;z-index:9999;font-size:14px;';
                    document.body.appendChild(t);
                    setTimeout(() => t.remove(), 3000);
                })(e.message);
            } finally {
                btn.textContent = originalText;
                btn.disabled = false;
            }
        });
    });



    // ★ 在 bindEvents 末尾加上
    container.querySelector('#saveToAlbumBtn')?.addEventListener('click', () => {
        // 生成 64x64 的图片
        const exportSize = 64;
        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = exportSize;
        exportCanvas.height = exportSize;
        const exportCtx = exportCanvas.getContext('2d');

        const cellSize = exportSize / GRID_SIZE;
        for (let y = 0; y < GRID_SIZE; y++) {
            for (let x = 0; x < GRID_SIZE; x++) {
                const color = pixelGrid[y][x];
                if (color) {
                    exportCtx.fillStyle = color;
                    exportCtx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
                }
            }
        }

        const dataUrl = exportCanvas.toDataURL('image/png');
        const key = `pixel_avatar_${Date.now()}`;
        setGlobalImage(key, dataUrl);

        // 同时添加到相册的「像素头像」专辑
        try {
            const albumsData = localStorage.getItem('gallery_albums');
            let albums = albumsData ? JSON.parse(albumsData) : [];
            let pixelAlbum = albums.find(a => a.id === 'album_pixel');
            if (!pixelAlbum) {
                pixelAlbum = { id: 'album_pixel', name: '像素头像', type: 'preset', images: [] };
                albums.push(pixelAlbum);
            }
            if (!pixelAlbum.images.includes(key)) {
                pixelAlbum.images.push(key);
            }
            localStorage.setItem('gallery_albums', JSON.stringify(albums));
            (function showToast(msg) {
                var t = document.createElement('div');
                t.textContent = msg;
                t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:10px 20px;border-radius:10px;z-index:9999;font-size:14px;';
                document.body.appendChild(t);
                setTimeout(function () { t.remove(); }, 2000);
            })('✅ 已保存到「像素头像」相册');
        } catch (e) {
            console.warn('保存到相册失败:', e);
            (function showToast(msg) {
                var t = document.createElement('div');
                t.textContent = '⚠️ ' + msg;
                t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#e65100;color:#fff;padding:10px 20px;border-radius:10px;z-index:9999;font-size:14px;';
                document.body.appendChild(t);
                setTimeout(function () { t.remove(); }, 3000);
            })('保存到相册失败，但图片已缓存');
        }
    });

    // ★ 暂存结果：应用 / 丢弃
    container.querySelector('#applyPendingBtn')?.addEventListener('click', () => {
        if (pendingAiResult) {
            pixelGrid = pendingAiResult;
            pendingAiResult = null;
            const c = container.querySelector('#pixelCanvas');
            if (c) drawPixelGrid(c.getContext('2d'));
            // 刷新界面去掉提示条
            const appContainer = container.closest('.page-container') || container;
            appContainer.innerHTML = render();
            bindEvents(appContainer);
        }
    });

    container.querySelector('#discardPendingBtn')?.addEventListener('click', () => {
        pendingAiResult = null;
        const appContainer = container.closest('.page-container') || container;
        appContainer.innerHTML = render();
        bindEvents(appContainer);
    });


}




// apps/market/pixelAvatar.js — 像素头像生成器

// ... 保留 GRID_SIZE, CELL_SIZE, PRESET_COLORS, 状态变量, resetGrid, Canvas 绘制, 交互, 下载等现有代码 ...

// ============================================================
//  ★ 新增：部件模板系统
// ============================================================

// 肤色
const SKIN_COLORS = ['#FFD5B8', '#D4A574', '#8D5524', '#FFE4D6', '#C9B89B'];

// 发色
const HAIR_COLORS = ['#212121', '#4A3728', '#8B4513', '#FFD700', '#C0C0C0', '#E91E63'];

// 瞳色
const EYE_COLORS = ['#212121', '#4A148C', '#1565C0', '#2E7D32'];

// ---- 发型数据 ----
// 每个发型是一个数组 [x, y]，相对于头像网格的绝对坐标
const HAIR_STYLES = [
    // 发型 0：短发
    [
        [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [8, 0], [9, 0], [10, 0], [11, 0], [12, 0], [13, 0],
        [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1], [10, 1], [11, 1], [12, 1], [13, 1], [14, 1],
        [1, 2], [2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2], [9, 2], [10, 2], [11, 2], [12, 2], [13, 2], [14, 2],
        [2, 3], [3, 3], [4, 3], [5, 3], [6, 3], [7, 3], [8, 3], [9, 3], [10, 3], [11, 3], [12, 3], [13, 3],
    ],
    // 发型 1：长发（两侧垂下）
    [
        [4, 0], [5, 0], [6, 0], [7, 0], [8, 0], [9, 0], [10, 0], [11, 0],
        [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1], [10, 1], [11, 1], [12, 1],
        [2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2], [9, 2], [10, 2], [11, 2], [12, 2], [13, 2],
        [2, 3], [3, 3], [4, 3], [5, 3], [6, 3], [7, 3], [8, 3], [9, 3], [10, 3], [11, 3], [12, 3], [13, 3],
        [1, 4], [2, 4], [13, 4], [14, 4],
        [1, 5], [2, 5], [13, 5], [14, 5],
        [1, 6], [2, 6], [13, 6], [14, 6],
        [2, 7], [13, 7],
    ],
    // 发型 2：莫西干头
    [
        [6, 0], [7, 0], [8, 0], [9, 0],
        [5, 1], [6, 1], [7, 1], [8, 1], [9, 1], [10, 1],
        [5, 2], [6, 2], [7, 2], [8, 2], [9, 2], [10, 2],
        [6, 3], [7, 3], [8, 3], [9, 3],
        [7, 4], [8, 4],
    ],
    // 发型 3：大背头
    [
        [3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [8, 0], [9, 0], [10, 0], [11, 0], [12, 0],
        [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1], [10, 1], [11, 1], [12, 1], [13, 1],
        [1, 2], [2, 2], [3, 2], [4, 2], [8, 2], [9, 2], [10, 2], [11, 2], [12, 2], [13, 2], [14, 2],
        [1, 3], [2, 3], [10, 3], [11, 3], [12, 3], [13, 3], [14, 3],
        [1, 4], [12, 4], [13, 4], [14, 4],
    ],
    // 发型 4：帽子（特殊——不露出头发，直接画个帽子形状）
    [
        // 帽身
        [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [8, 0], [9, 0], [10, 0], [11, 0], [12, 0], [13, 0],
        [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1], [10, 1], [11, 1], [12, 1], [13, 1], [14, 1],
        [1, 2], [2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2], [9, 2], [10, 2], [11, 2], [12, 2], [13, 2], [14, 2],
        [2, 3], [3, 3], [4, 3], [5, 3], [6, 3], [7, 3], [8, 3], [9, 3], [10, 3], [11, 3], [12, 3], [13, 3],
        // 帽檐
        [0, 4], [1, 4], [2, 4], [3, 4], [4, 4], [5, 4], [6, 4], [7, 4], [8, 4], [9, 4], [10, 4], [11, 4], [12, 4], [13, 4], [14, 4], [15, 4],
    ],
];

// ---- 眼睛数据 ----
const EYE_STYLES = [
    // 眼睛 0：圆眼（4像素方块）
    [
        [5, 6], [6, 6], [9, 6], [10, 6],
        [5, 7], [6, 7], [9, 7], [10, 7],
    ],
    // 眼睛 1：眯眼（横线）
    [
        [4, 6], [5, 6], [6, 6], [7, 6],
        [9, 6], [10, 6], [11, 6], [12, 6],
    ],
    // 眼睛 2：单点
    [
        [6, 6], [10, 6],
    ],
    // 眼睛 3：墨镜
    [
        [3, 5], [4, 5], [5, 5], [6, 5], [7, 5], [9, 5], [10, 5], [11, 5], [12, 5], [13, 5],
        [3, 6], [4, 6], [5, 6], [6, 6], [7, 6], [9, 6], [10, 6], [11, 6], [12, 6], [13, 6],
        [3, 7], [4, 7], [5, 7], [6, 7], [7, 7], [9, 7], [10, 7], [11, 7], [12, 7], [13, 7],
        // 鼻梁连接
        [8, 5], [8, 6],
    ],
];

// ---- 嘴巴数据 ----
const MOUTH_STYLES = [
    // 嘴巴 0：微笑
    [
        [5, 11], [6, 11], [7, 11], [8, 11], [9, 11], [10, 11], [11, 11],
        [6, 12], [7, 12], [8, 12], [9, 12], [10, 12],
        [7, 13], [8, 13],
    ],
    // 嘴巴 1：张嘴
    [
        [5, 11], [6, 11], [7, 11], [8, 11], [9, 11], [10, 11], [11, 11],
        [5, 12], [6, 12], [9, 12], [10, 12], [11, 12],
        [6, 13], [7, 13], [8, 13], [9, 13], [10, 13],
    ],
    // 嘴巴 2：直线
    [
        [5, 11], [6, 11], [7, 11], [8, 11], [9, 11], [10, 11], [11, 11],
    ],
    // 嘴巴 3：不高兴（倒弧）
    [
        [5, 13], [6, 13], [7, 13], [8, 13], [9, 13], [10, 13], [11, 13],
        [6, 12], [7, 12], [8, 12], [9, 12], [10, 12],
        [7, 11], [8, 11],
    ],
];

// ---- 腮红（可选）----
const BLUSH_POSITIONS = [
    [3, 9], [4, 9], [12, 9], [13, 9],
];

// ---- 智能生成 ----
function generateSmartGrid() {
    const grid = Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(null));

    // 1. 选肤色，填充面部区域
    const skinColor = SKIN_COLORS[Math.floor(Math.random() * SKIN_COLORS.length)];
    for (let y = 3; y < 14; y++) {
        for (let x = 2; x < 14; x++) {
            grid[y][x] = skinColor;
        }
    }

    // 2. 随机选发色和发型
    const hairColor = HAIR_COLORS[Math.floor(Math.random() * HAIR_COLORS.length)];
    const hairStyle = HAIR_STYLES[Math.floor(Math.random() * HAIR_STYLES.length)];
    hairStyle.forEach(([x, y]) => {
        if (y >= 0 && y < GRID_SIZE && x >= 0 && x < GRID_SIZE) {
            grid[y][x] = hairColor;
        }
    });

    // 3. 随机选瞳色和眼睛样式
    const eyeColor = EYE_COLORS[Math.floor(Math.random() * EYE_COLORS.length)];
    const eyeStyle = EYE_STYLES[Math.floor(Math.random() * EYE_STYLES.length)];
    eyeStyle.forEach(([x, y]) => {
        if (y >= 0 && y < GRID_SIZE && x >= 0 && x < GRID_SIZE) {
            grid[y][x] = eyeColor;
        }
    });

    // 4. 随机选嘴巴
    const mouthStyle = MOUTH_STYLES[Math.floor(Math.random() * MOUTH_STYLES.length)];
    // 嘴巴用深红色
    const mouthColor = '#C62828';
    mouthStyle.forEach(([x, y]) => {
        if (y >= 0 && y < GRID_SIZE && x >= 0 && x < GRID_SIZE) {
            grid[y][x] = mouthColor;
        }
    });

    // 5. 随机加腮红（30%概率）
    if (Math.random() < 0.3) {
        const blushColor = '#FFAAAA';
        BLUSH_POSITIONS.forEach(([x, y]) => {
            if (y >= 0 && y < GRID_SIZE && x >= 0 && x < GRID_SIZE) {
                grid[y][x] = blushColor;
            }
        });
    }

    return grid;
}

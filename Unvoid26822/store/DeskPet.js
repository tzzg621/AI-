// store/DeskPet.js — SVG Q 版桌宠（支持精灵图替换）

let petInstance = null;

class DeskPet {
    constructor() {
        if (petInstance) return petInstance;
        this._currentMood = 'idle';
        this._blinkTimer = null;
        this._animFrameId = null;
        this._lastFrameTime = null;
        this._frameCount = 0;
        this._idle = true;
        this._init();
        petInstance = this;
    }

    async _init() {
        const area = document.getElementById('petArea');
        if (!area) { setTimeout(() => this._init(), 300); return; }

        // 先尝试加载精灵图
        const spriteLoaded = await this._loadPetSprite(area);
        if (spriteLoaded) return;     // 有精灵图，canvas 模式启动完毕

        // 没有精灵图 → 走原来的 SVG 模式
        this._initSvgMode(area);
    }

    // 从桌宠相册加载精灵图
    async _loadPetSprite(area) {
        try {
            const albums = JSON.parse(localStorage.getItem('gallery_albums') || '[]');
            const petAlbum = albums.find(a => a.id === 'album_pet');
            if (!petAlbum || petAlbum.images.length === 0) return false;

            const activeKey = localStorage.getItem('pet_active_sprite');
            const latestKey = activeKey || petAlbum.images[petAlbum.images.length - 1];
            const { getImageDataUrl } = await import('../store/ImageCache.js');
            const dataUrl = await getImageDataUrl(latestKey);
            if (!dataUrl) return false;

            // 加载图片
            const img = new Image();
            img.src = dataUrl;
            await new Promise(resolve => { img.onload = resolve; });

            // 启动 canvas 模式
            this._initCanvasMode(area, img);
            return true;
        } catch {
            return false;
        }
    }

    // Canvas 帧动画模式（计数器驱动，与原始版一致的流畅感）
    _initCanvasMode(area, img) {
        this._idle = true;
        this._img = img;
        this._frameIndex = 0;
        this._row = 0;
        // 保留计数器状态（reinit 续播场景不清它）
        this._frameCount = this._frameCount ?? 0;
        this._lastFrameTime = this._lastFrameTime ?? null;

        // 移除旧的 SVG 和 Canvas
        const oldSvg = area.querySelector('#petSvg');
        if (oldSvg) oldSvg.remove();
        const oldCanvas = area.querySelector('#petCanvas');
        if (oldCanvas) oldCanvas.remove();

        const frameW = img.width / 4;
        const frameH = img.height / 2;

        // 定位容器（独立控制桌宠位置）
        const petContainer = document.createElement('div');
        petContainer.id = 'petContainer';
        petContainer.style.cssText = `
            position: absolute;
            left: 50%;
            top: -35%;
            transform: translateX(-50%);
            width: 80px;
            height: 90px;
            z-index: 2;
        `;
        area.appendChild(petContainer);

        // Canvas
        const canvas = document.createElement('canvas');
        canvas.width = 80;
        canvas.height = 90;
        canvas.id = 'petCanvas';
        canvas.style.cssText = 'display:block;width:100%;height:100%;cursor:pointer;';
        petContainer.appendChild(canvas);
        const ctx = canvas.getContext('2d');

        // 绘制函数：只画当前帧，不做时间计算（与原始版一致）
        const draw = () => {
            ctx.clearRect(0, 0, 80, 90);
            ctx.drawImage(img,
                this._frameIndex * frameW, this._row * frameH, frameW, frameH,
                0, 0, canvas.width, canvas.height
            );
        };
        draw();

        // 动画循环：只在跳帧时调用 draw()（与原始版一致）
        const animate = (timestamp) => {
            if (!this._idle && this._lastFrameTime !== null && timestamp - this._lastFrameTime > 400) {
                this._frameIndex++;
                this._frameCount++;

                if (this._frameIndex >= 4) {
                    this._frameIndex = 0;
                    this._row = this._row === 0 ? 1 : 0;
                }

                draw();
                this._lastFrameTime = timestamp;

                // 8 帧播完，回到 idle
                if (this._frameCount >= 8) {
                    this._frameIndex = 0;
                    this._row = 0;
                    draw();
                    this._idle = true;
                    this._frameCount = 0;
                    this._lastFrameTime = null;
                    canvas.style.transform = 'translateY(0)';
                    // ★ 重启呼吸
                    this._startBreathingCanvas(canvas);
                }
            }
            this._animFrameId = requestAnimationFrame(animate);
        };
        this._animFrameId = requestAnimationFrame(animate);

        // 点击：立刻画第 1 帧（不等 rAF），消除卡顿感
        canvas.addEventListener('click', () => {
            if (!this._idle) return;          // 动画进行中，忽略

            // ★ 停呼吸，避免动画期间抖动
            if (this._breathTimer) {
                clearInterval(this._breathTimer);
                this._breathTimer = null;
            }

            this._idle = false;
            this._frameCount = 0;

            // 立刻画第 1 帧，用户马上看到变化
            this._frameIndex = 1;
            this._row = 0;
            draw();

            // 设 lastFrameTime 为现在，400ms 后跳第 2 帧
            this._lastFrameTime = performance.now();
        });

        // 监听 AI 完成
        window.addEventListener('ai-task-completed', () => this._onAIComplete());

        // 呼吸动画
        this._startBreathingCanvas(canvas);
        this._canvas = canvas;
    }

    // Canvas 版呼吸
    _startBreathingCanvas(canvas) {
        let up = true;
        this._breathTimer = setInterval(() => {
            if (this._idle) return;
            canvas.style.transform = up ? 'translateY(-3px)' : 'translateY(0)';
            up = !up;
        }, 900);
    }

    // 原来 _init() 的内容改名 _initSvgMode()
    _initSvgMode(area) {
        // 移除旧的 SVG
        const oldSvg = area.querySelector('#petSvg');
        if (oldSvg) oldSvg.remove();

        // 创建 SVG
        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('viewBox', '0 0 80 90');
        svg.setAttribute('width', '72');
        svg.setAttribute('height', '80');
        svg.style.display = 'block';
        svg.style.margin = '0 auto';
        svg.id = 'petSvg';

        // 脸
        this._face = document.createElementNS(svgNS, 'ellipse');
        this._face.setAttribute('cx', '40');
        this._face.setAttribute('cy', '40');
        this._face.setAttribute('rx', '28');
        this._face.setAttribute('ry', '30');
        this._face.setAttribute('fill', '#FFE0BD');
        this._face.setAttribute('stroke', '#DBA978');
        this._face.setAttribute('stroke-width', '1.5');

        // 腮红
        this._blushL = this._makeBlush(svgNS, 20, 45);
        this._blushR = this._makeBlush(svgNS, 60, 45);

        // 眼睛
        this._eyeL = document.createElementNS(svgNS, 'ellipse');
        this._eyeL.setAttribute('cx', '30');
        this._eyeL.setAttribute('cy', '35');
        this._eyeL.setAttribute('rx', '3.5');
        this._eyeL.setAttribute('ry', '4');
        this._eyeL.setAttribute('fill', '#4a3728');

        this._eyeR = document.createElementNS(svgNS, 'ellipse');
        this._eyeR.setAttribute('cx', '50');
        this._eyeR.setAttribute('cy', '35');
        this._eyeR.setAttribute('rx', '3.5');
        this._eyeR.setAttribute('ry', '4');
        this._eyeR.setAttribute('fill', '#4a3728');

        // 眼睛高光
        this._highlightL = this._makeHighlight(svgNS, 28, 33);
        this._highlightR = this._makeHighlight(svgNS, 48, 33);

        // 嘴巴
        this._mouth = document.createElementNS(svgNS, 'path');
        this._mouth.setAttribute('fill', 'none');
        this._mouth.setAttribute('stroke', '#D9786A');
        this._mouth.setAttribute('stroke-width', '2');
        this._mouth.setAttribute('stroke-linecap', 'round');
        this._setMouth('smile');

        // 身体
        this._body = document.createElementNS(svgNS, 'ellipse');
        this._body.setAttribute('cx', '40');
        this._body.setAttribute('cy', '75');
        this._body.setAttribute('rx', '20');
        this._body.setAttribute('ry', '12');
        this._body.setAttribute('fill', '#F0E0D0');
        this._body.setAttribute('stroke', '#DBA978');
        this._body.setAttribute('stroke-width', '1');

        // 组装
        svg.append(this._body, this._face, this._blushL, this._blushR,
            this._eyeL, this._eyeR, this._highlightL, this._highlightR, this._mouth);
        area.appendChild(svg);

        this._svg = svg;

        // 呼吸动画
        svg.style.transition = 'transform 0.8s ease-in-out';
        this._startBreathing();

        // 眨眼
        this._startBlinking();

        // 点击互动
        svg.addEventListener('click', () => this._onClick());

        // 监听 AI 完成
        window.addEventListener('ai-task-completed', () => this._onAIComplete());
    }

    _makeBlush(ns, cx, cy) {
        const el = document.createElementNS(ns, 'ellipse');
        el.setAttribute('cx', cx);
        el.setAttribute('cy', cy);
        el.setAttribute('rx', '6');
        el.setAttribute('ry', '3.5');
        el.setAttribute('fill', '#FFB5A0');
        el.setAttribute('opacity', '0.5');
        return el;
    }

    _makeHighlight(ns, cx, cy) {
        const el = document.createElementNS(ns, 'circle');
        el.setAttribute('cx', cx);
        el.setAttribute('cy', cy);
        el.setAttribute('r', '1.5');
        el.setAttribute('fill', 'white');
        el.setAttribute('opacity', '0.8');
        return el;
    }

    _setMouth(type) {
        const d = {
            smile: 'M 32 44 Q 40 50 48 44',
            happy: 'M 30 45 Q 40 54 50 45',
            open: 'M 33 44 Q 40 50 47 44',
            sad: 'M 32 48 Q 40 42 48 48',
        }[type] || 'M 32 44 Q 40 50 48 44';
        this._mouth.setAttribute('d', d);
    }

    _setEyes(type) {
        if (type === 'happy') {
            this._eyeL.setAttribute('rx', '4');
            this._eyeL.setAttribute('ry', '1.5');
            this._eyeR.setAttribute('rx', '4');
            this._eyeR.setAttribute('ry', '1.5');
            this._highlightL.setAttribute('opacity', '0');
            this._highlightR.setAttribute('opacity', '0');
        } else if (type === 'surprised') {
            this._eyeL.setAttribute('rx', '5');
            this._eyeL.setAttribute('ry', '5');
            this._eyeR.setAttribute('rx', '5');
            this._eyeR.setAttribute('ry', '5');
            this._highlightL.setAttribute('opacity', '0.8');
            this._highlightR.setAttribute('opacity', '0.8');
        } else {
            this._eyeL.setAttribute('rx', '3.5');
            this._eyeL.setAttribute('ry', '4');
            this._eyeR.setAttribute('rx', '3.5');
            this._eyeR.setAttribute('ry', '4');
            this._highlightL.setAttribute('opacity', '0.8');
            this._highlightR.setAttribute('opacity', '0.8');
        }
    }

    // ---- 动画（SVG 模式）----

    _startBreathing() {
        let up = true;
        this._breathTimer = setInterval(() => {
            if (this._idle) return;     // 静止时不呼吸
            this._svg.style.transform = up ? 'translateY(-3px)' : 'translateY(0)';
            up = !up;
        }, 900);
    }

    _startBlinking() {
        this._blinkTimer = setInterval(() => {
            if (this._idle) return;     // 静止时不眨眼
            this._eyeL.setAttribute('ry', '1');
            this._eyeR.setAttribute('ry', '1');
            setTimeout(() => {
                this._eyeL.setAttribute('ry', '4');
                this._eyeR.setAttribute('ry', '4');
            }, 120);
        }, 4000);
    }

    _onClick() {
        // 点击唤醒
        this._idle = false;

        this._svg.style.transition = 'transform 0.15s ease';
        this._svg.style.transform = 'translateY(-12px)';
        this._setMouth('happy');
        this._setEyes('happy');

        setTimeout(() => {
            this._svg.style.transform = 'translateY(-3px)';
            setTimeout(() => {
                this._setMouth('smile');
                this._setEyes('idle');
                this._svg.style.transition = 'transform 0.8s ease-in-out';
                this._idle = true;       // 恢复静止
            }, 300);
        }, 400);

        clearInterval(this._blinkTimer);
        this._blinkTimer = setInterval(() => {
            this._eyeL.setAttribute('ry', '1');
            this._eyeR.setAttribute('ry', '1');
            setTimeout(() => {
                this._eyeL.setAttribute('ry', '4');
                this._eyeR.setAttribute('ry', '4');
            }, 120);
        }, 4000);
    }

    _onAIComplete() {
        if (this._canvas) {
            if (!this._idle) return;

            // ★ 停呼吸
            if (this._breathTimer) {
                clearInterval(this._breathTimer);
                this._breathTimer = null;
            }

            this._idle = false;
            this._frameCount = 0;
            this._frameIndex = 1;
            this._row = 0;
            const canvas = this._canvas;
            const ctx = canvas.getContext('2d');
            const frameW = this._img.width / 4;
            const frameH = this._img.height / 2;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(this._img,
                this._frameIndex * frameW, this._row * frameH, frameW, frameH,
                0, 0, canvas.width, canvas.height
            );
            this._lastFrameTime = performance.now();
        } else {
            this._onClick();
        }
    }

    // 从其他页面返回时重新初始化
    reinit() {
        if (this._blinkTimer) { clearInterval(this._blinkTimer); this._blinkTimer = null; }
        if (this._breathTimer) { clearInterval(this._breathTimer); this._breathTimer = null; }
        if (this._animFrameId) { cancelAnimationFrame(this._animFrameId); this._animFrameId = null; }

        if (!this._idle) {
            this._lastFrameTime = performance.now();
        }

        this._init();
    }
}

// ---- 初始化（自启动）----
let initialized = false;
function initDeskPet() {
    if (!initialized) {
        initialized = true;
        if (document.getElementById('petArea')) {
            new DeskPet();
        } else {
            const observer = new MutationObserver(() => {
                if (document.getElementById('petArea') &&
                    !document.getElementById('petSvg') &&
                    !document.getElementById('petCanvas')) {
                    new DeskPet();
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
        }
        return;
    }
    if (petInstance) {
        petInstance.reinit();
    }
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
    initDeskPet();
} else {
    document.addEventListener('DOMContentLoaded', initDeskPet);
}

window.addEventListener('desk-rendered', initDeskPet);

export { initDeskPet };
export const bootInit = true;

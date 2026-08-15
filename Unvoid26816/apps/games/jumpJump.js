// apps/games/jumpJump.js — 跳一跳（Canvas）
export const id = 'jumpJump';
export const label = '跳一跳';
export const icon = '🦘';
export const color = '#ff7043';

export function start(container, globalState, onBack) {
    container.innerHTML = `
        <style>
            .jj-shell {
                height: 100%;
                display: flex;
                flex-direction: column;
                background: linear-gradient(135deg, #f7fbff 0%, #eef6ff 100%);
                color: #274060;
            }
            .jj-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 12px 16px;
                background: rgba(255,255,255,0.88);
                backdrop-filter: blur(10px);
                box-shadow: 0 2px 12px rgba(39, 64, 96, 0.08);
                flex-shrink: 0;
            }
            .jj-header button {
                border: none;
                background: transparent;
                color: #61748a;
                font-size: 18px;
                cursor: pointer;
                padding: 4px 8px;
                border-radius: 999px;
            }
            .jj-header button:hover {
                background: rgba(0,0,0,0.06);
            }
            .jj-title {
                font-weight: 800;
                font-size: 16px;
                letter-spacing: 0.02em;
            }
            .jj-score-pill {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 6px 10px;
                border-radius: 999px;
                background: linear-gradient(135deg, #ff8a65, #ff7043);
                color: #fff;
                font-weight: 700;
                box-shadow: 0 6px 18px rgba(255, 112, 67, 0.24);
            }
            .jj-stage {
                position: relative;
                flex: 1;
                overflow: hidden;
                isolation: isolate;
            }
            #jjCanvas {
                position: absolute;
                inset: 0;
                width: 100%;
                height: 100%;
                display: block;
            }
            .jj-hud {
                position: absolute;
                top: 16px;
                left: 16px;
                right: 16px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                pointer-events: none;
                z-index: 2;
            }
            .jj-badge {
                padding: 7px 12px;
                border-radius: 999px;
                font-size: 12px;
                font-weight: 700;
                color: #4b6480;
                background: rgba(255,255,255,0.86);
                box-shadow: 0 4px 12px rgba(39, 64, 96, 0.08);
            }
            .jj-tip {
                font-size: 12px;
                color: rgba(39, 64, 96, 0.75);
                background: rgba(255,255,255,0.8);
                padding: 7px 10px;
                border-radius: 999px;
                box-shadow: 0 4px 12px rgba(39, 64, 96, 0.08);
            }
            .jj-overlay {
                position: absolute;
                inset: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(11, 24, 39, 0.55);
                z-index: 5;
                padding: 20px;
            }
            .jj-card {
                width: min(320px, 100%);
                border-radius: 24px;
                padding: 24px 22px;
                background: rgba(255,255,255,0.96);
                box-shadow: 0 16px 46px rgba(0,0,0,0.18);
                text-align: center;
            }
            .jj-card h3 {
                margin: 0 0 8px;
                font-size: 22px;
                color: #274060;
            }
            .jj-card p {
                margin: 0;
                color: #5e6d81;
                font-size: 14px;
            }
            .jj-actions {
                display: flex;
                gap: 10px;
                justify-content: center;
                margin-top: 20px;
            }
            .jj-actions button {
                border: none;
                padding: 10px 18px;
                border-radius: 999px;
                font-size: 14px;
                font-weight: 700;
                cursor: pointer;
            }
            .jj-primary {
                background: linear-gradient(135deg, #ff8a65, #ff7043);
                color: white;
            }
            .jj-secondary {
                background: #eef3f8;
                color: #44576b;
            }
        </style>
        <div class="jj-shell">
            <div class="jj-header">
                <button id="jjBack" title="返回">←</button>
                <span class="jj-title">🦘 跳一跳</span>
                <span class="jj-score-pill"><span>🏁</span><span id="jjScore">0</span></span>
            </div>
            <div class="jj-stage">
                <canvas id="jjCanvas"></canvas>
                <div class="jj-hud">
                    <div class="jj-badge" id="jjStateBadge">准备就绪</div>
                    <div class="jj-tip" id="jjTip">按住蓄力，松开跳跃，尽量落在平台中心</div>
                </div>
            </div>
        </div>`;

    const canvas = container.querySelector('#jjCanvas');
    const ctx = canvas.getContext('2d');
    const scoreEl = container.querySelector('#jjScore');
    const stateBadge = container.querySelector('#jjStateBadge');
    const tipEl = container.querySelector('#jjTip');
    const stage = container.querySelector('.jj-stage');
    const backButton = container.querySelector('#jjBack');

    const W = () => stage.clientWidth;
    const H = () => stage.clientHeight;

    const MAX_DIST = 120;
    const CHARGE_SPEED = 1.35;
    const JUMP_TIME = 410;
    const BLOCK_H = 24;
    const PLAYER_R = 14;
    const VIEWPORT_MARGIN = 220;
    const ACTIVE_LEAF_BUFFER = 8;
    const LEAF_HIT_EXTRA = 1;
    const LEAF_BASE_GAP = 84;
    const LEAF_GAP_VARIANCE = 28;
    const LEAF_HORIZONTAL_DRIFT = 90;

    let platforms = [];
    let currentIndex = 0;
    let player = { x: 0, y: 0, r: PLAYER_R };
    let cameraX = 0;
    let cameraY = 0;
    let score = 0;
    let charging = 0;
    let state = 'idle';
    let jump = null;
    let jumpArc = 0;
    let rafId = 0;
    let lastTimestamp = 0;
    let destroyed = false;
    let overlay = null;
    let currentPointerId = null;
    let gameOverShown = false;

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function rectsOverlap(a, b) {
        return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
    }

    function chooseLeafSpawnPoint(prev) {
        const maxAttempts = 220;
        const width = 58 + Math.random() * 12;
        const height = 48 + Math.random() * 10;
        const gap = LEAF_BASE_GAP + Math.random() * LEAF_GAP_VARIANCE;
        const referenceLeaves = platforms.slice(Math.max(0, platforms.length - 8));
        const prevCenter = prev.x + prev.w / 2;
        const preferredOffset = (Math.random() < 0.55 ? 1 : -1) * (LEAF_HORIZONTAL_DRIFT * 0.55 + Math.random() * 18);
        const targetCenter = clamp(prevCenter + preferredOffset, 40, W() - 40);

        for (let i = 0; i < maxAttempts; i += 1) {
            const drift = (Math.random() < 0.6 ? 1 : -1) * (10 + Math.random() * 24);
            const x = clamp(targetCenter + drift - width / 2, 18, W() - width - 18);
            const y = prev.y - gap - Math.random() * 8;
            const candidate = { x, y, w: width, h: height };
            const overlaps = referenceLeaves.some(leaf => {
                const cx = candidate.x + candidate.w / 2;
                const cy = candidate.y + candidate.h / 2;
                const lx = leaf.x + leaf.w / 2;
                const ly = leaf.y + leaf.h / 2;
                const dx = cx - lx;
                const dy = cy - ly;
                return Math.hypot(dx, dy) < Math.max(44, width * 0.75);
            });
            if (!overlaps) {
                return candidate;
            }
        }

        return {
            x: clamp(targetCenter - width / 2, 18, W() - width - 18),
            y: prev.y - gap,
            w: width,
            h: height
        };
    }

    function resetCanvas() {
        const rect = stage.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function updateHud() {
        stateBadge.textContent = state === 'charging'
            ? `蓄力中 ${Math.round(charging * 100)}%`
            : state === 'jumping'
                ? '起跳中'
                : state === 'dead' || state === 'gameover'
                    ? '游戏结束'
                    : '准备就绪';
        tipEl.textContent = state === 'idle'
            ? '按住蓄力，松开跳跃，落在空白荷叶上'
            : '尽量落稳，不要掉进空白区';
        tipEl.style.opacity = state === 'idle' ? '1' : '0.7';
    }

    function spawnPlatform() {
        const prev = platforms[platforms.length - 1];
        const nextLeaf = chooseLeafSpawnPoint(prev);
        return {
            x: nextLeaf.x,
            y: nextLeaf.y,
            w: nextLeaf.w,
            h: nextLeaf.h,
            direction: 'leaf'
        };
    }

    function ensureSpawnAhead() {
        while (platforms.length - currentIndex < ACTIVE_LEAF_BUFFER) {
            platforms.push(spawnPlatform());
        }

        const pruneStart = Math.max(0, currentIndex - 3);
        if (pruneStart > 0) {
            platforms.splice(0, pruneStart);
            currentIndex -= pruneStart;
        }
    }

    function initGame() {
        resetCanvas();
        platforms = [];
        currentIndex = 0;
        score = 0;
        charging = 0;
        state = 'idle';
        jump = null;
        jumpArc = 0;
        cameraX = 0;
        cameraY = 0;
        player = { x: 0, y: 0, r: PLAYER_R };
        overlay?.remove();
        overlay = null;
        gameOverShown = false;
        scoreEl.textContent = '0';
        updateHud();
        const basePlatform = {
            x: W() / 2 - 70,
            y: H() - 82,
            w: 140,
            h: BLOCK_H,
            direction: 'horizontal'
        };
        platforms.push(basePlatform);
        ensureSpawnAhead();
        player.x = basePlatform.x + basePlatform.w / 2;
        player.y = basePlatform.y - 2;
    }

    function getJumpTarget(targetPlatform) {
        const fromX = player.x;
        const fromY = player.y;
        const targetX = targetPlatform.x + targetPlatform.w / 2;
        const targetY = targetPlatform.y - 2;
        const deltaX = targetX - fromX;
        const deltaY = targetY - fromY;
        const jumpDistance = 48 + charging * MAX_DIST;
        const directDistance = Math.max(1, Math.hypot(deltaX, deltaY));
        const reachRatio = Math.min(1, jumpDistance / directDistance);
        return {
            x: clamp(fromX + deltaX * reachRatio, 20, W() - 20),
            y: fromY + deltaY * reachRatio
        };
    }

    function updateCamera() {
        const targetCameraX = player.x - W() * 0.5;
        const targetCameraY = player.y - H() * 0.5;
        cameraX += (targetCameraX - cameraX) * 0.12;
        cameraY += (targetCameraY - cameraY) * 0.12;
    }

    function isLandingSuccess(platform) {
        const landingX = player.x;
        const landingY = player.y + 2;
        const centerX = platform.x + platform.w / 2;
        const centerY = platform.y + platform.h / 2;
        const rx = Math.max(12, platform.w / 2);
        const ry = Math.max(10, Math.min(platform.h / 2, rx * 0.95));
        const dx = landingX - centerX;
        const dy = landingY - centerY;
        const insideEllipse = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
        const withinVerticalRange = landingY >= platform.y - 4 && landingY <= platform.y + platform.h + 4;
        return insideEllipse && withinVerticalRange;
    }

    function handleLand() {
        const target = platforms[currentIndex + 1];
        if (!target) {
            showGameOver();
            jump = null;
            return;
        }

        const success = isLandingSuccess(target);
        if (!success) {
            showGameOver();
            jump = null;
            return;
        }

        const center = target.x + target.w / 2;
        const offset = Math.abs(player.x - center);
        const baseGain = offset < target.w * 0.08 ? 2 : 1;
        score += baseGain;
        scoreEl.textContent = String(score);

        player.y = target.y - 2;
        currentIndex += 1;
        state = 'idle';
        charging = 0;
        jump = null;
        jumpArc = 0;
        ensureSpawnAhead();
        updateCamera();
        updateHud();
    }

    function update(dt) {
        if (state === 'charging') {
            charging = clamp(charging + CHARGE_SPEED * dt, 0, 1);
        }

        if (state === 'jumping' && jump) {
            jump.t += dt;
            const p = clamp(jump.t / jump.dur, 0, 1);
            const eased = 1 - Math.pow(1 - p, 3);
            player.x = jump.fromX + (jump.toX - jump.fromX) * eased;
            player.y = jump.fromY + (jump.toY - jump.fromY) * eased;
            jumpArc = Math.sin(eased * Math.PI) * 34;
            const arrived = p >= 1 || (Math.abs(player.x - jump.toX) < 0.5 && Math.abs(player.y - jump.toY) < 0.5);
            if (arrived) {
                jumpArc = 0;
                player.x = jump.toX;
                player.y = jump.toY;
                handleLand();
            }
        }

        if (state === 'dead') {
            player.y += 360 * dt;
            if (player.y - cameraY > H() + 140) {
                showGameOver();
            }
        }

        if (state === 'gameover') {
            updateHud();
            return;
        }

        updateCamera();
        updateHud();
    }

    function drawBackground() {
        const gradient = ctx.createLinearGradient(0, 0, 0, H());
        gradient.addColorStop(0, '#f8fbff');
        gradient.addColorStop(1, '#eaf4ff');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, W(), H());

        ctx.save();
        ctx.globalAlpha = 0.6;
        for (let i = 0; i < 6; i += 1) {
            const x = (i * 120 + (Date.now() / 1000) * 20) % (W() + 120) - 60;
            const y = 80 + i * 54;
            ctx.beginPath();
            ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.7)' : 'rgba(79,124,255,0.08)';
            ctx.arc(x, y, 18 + (i % 3) * 6, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    function drawPlatform(platform, index) {
        const drawX = platform.x - cameraX;
        const drawY = platform.y - cameraY;
        const isCurrent = index === currentIndex;
        const centerX = drawX + platform.w / 2;
        const centerY = drawY + platform.h / 2;
        const rx = platform.w / 2;
        const ry = Math.min(platform.h / 2, rx * 0.95);

        ctx.save();
        ctx.translate(centerX, centerY);
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
        ctx.fillStyle = isCurrent ? '#7de1b5' : '#84e4b0';
        ctx.fill();
        ctx.lineWidth = 2.2;
        ctx.strokeStyle = isCurrent ? '#2e9a6b' : '#2c8d63';
        ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.strokeStyle = 'rgba(78, 116, 71, 0.22)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(centerX - rx * 0.28, drawY + platform.h * 0.78);
        ctx.quadraticCurveTo(centerX, drawY + platform.h + 10, centerX + rx * 0.28, drawY + platform.h * 0.78);
        ctx.stroke();
        ctx.restore();
    }

    function render() {
        ctx.clearRect(0, 0, W(), H());
        drawBackground();

        const visiblePlatforms = platforms.filter(platform => platform.y >= cameraY - VIEWPORT_MARGIN && platform.y <= cameraY + H() + VIEWPORT_MARGIN);
        visiblePlatforms.forEach(platform => drawPlatform(platform, platforms.indexOf(platform)));

        const px = player.x - cameraX;
        const py = player.y - cameraY - jumpArc;
        ctx.save();
        ctx.translate(px, py);
        ctx.scale(state === 'charging' ? 1 - charging * 0.08 : 1, state === 'charging' ? 1 - charging * 0.12 : 1);
        ctx.fillStyle = '#ff7043';
        ctx.beginPath();
        ctx.arc(0, -PLAYER_R + 2, PLAYER_R, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#f3a68c';
        ctx.beginPath();
        ctx.arc(-5, -PLAYER_R + 3, 4.5, 0, Math.PI * 2);
        ctx.arc(5, -PLAYER_R + 3, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#be4b1c';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(-8, -PLAYER_R + 16);
        ctx.quadraticCurveTo(0, -PLAYER_R + 28, 8, -PLAYER_R + 16);
        ctx.stroke();
        ctx.restore();

        if (state === 'charging') {
            const barW = 108;
            ctx.fillStyle = 'rgba(0,0,0,0.12)';
            ctx.fillRect(W() / 2 - barW / 2, 28, barW, 8);
            ctx.fillStyle = '#ff7043';
            ctx.fillRect(W() / 2 - barW / 2, 28, barW * charging, 8);
        }
    }

    function showGameOver() {
        if (overlay || gameOverShown) {
            return;
        }
        gameOverShown = true;
        state = 'gameover';
        overlay = document.createElement('div');
        overlay.className = 'jj-overlay';
        overlay.innerHTML = `
            <div class="jj-card">
                <div style="font-size:42px;margin-bottom:10px;">💥</div>
                <h3>游戏结束</h3>
                <p>本局得分 <strong>${score}</strong></p>
                <div class="jj-actions">
                    <button id="jjRestart" class="jj-primary">重新开始</button>
                    <button id="jjToCenter" class="jj-secondary">返回</button>
                </div>
            </div>`;
        stage.appendChild(overlay);

        overlay.querySelector('#jjRestart').addEventListener('click', () => {
            overlay?.remove();
            overlay = null;
            gameOverShown = false;
            initGame();
        });
        overlay.querySelector('#jjToCenter').addEventListener('click', () => {
            cleanup();
            onBack && onBack();
        });
        updateHud();
    }

    function startJump() {
        if (state !== 'idle') {
            return;
        }
        state = 'charging';
        charging = 0;
        updateHud();
    }

    function releaseJump() {
        if (state !== 'charging') {
            return;
        }

        const targetPlatform = platforms[currentIndex + 1];
        if (!targetPlatform) {
            showGameOver();
            return;
        }

        const fromX = player.x;
        const fromY = player.y;
        const jumpTarget = getJumpTarget(targetPlatform);
        const toX = jumpTarget.x;
        const toY = jumpTarget.y;

        state = 'jumping';
        jump = {
            fromX,
            fromY,
            toX: clamp(toX, 20, W() - 20),
            toY,
            t: 0,
            dur: JUMP_TIME / 1000
        };
        updateHud();
    }

    function handlePointerDown(event) {
        event.preventDefault();
        if (state !== 'idle') {
            return;
        }
        currentPointerId = event.pointerId;
        canvas.setPointerCapture(event.pointerId);
        startJump();
    }

    function handlePointerUp(event) {
        if (currentPointerId !== null && event.pointerId !== currentPointerId) {
            return;
        }
        if (canvas.hasPointerCapture(event.pointerId)) {
            canvas.releasePointerCapture(event.pointerId);
        }
        releaseJump();
        currentPointerId = null;
    }

    function handleResize() {
        resetCanvas();
        initGame();
    }

    function loop(now) {
        if (destroyed) {
            return;
        }
        const dt = Math.min(0.04, (now - (lastTimestamp || now)) / 1000);
        lastTimestamp = now;
        update(dt);
        render();
        rafId = requestAnimationFrame(loop);
    }

    function cleanup() {
        destroyed = true;
        if (rafId) {
            cancelAnimationFrame(rafId);
        }
        if (canvas.hasPointerCapture(currentPointerId)) {
            canvas.releasePointerCapture(currentPointerId);
        }
        canvas.removeEventListener('pointerdown', handlePointerDown);
        canvas.removeEventListener('pointerup', handlePointerUp);
        canvas.removeEventListener('pointercancel', handlePointerUp);
        window.removeEventListener('resize', handleResize);
        backButton.removeEventListener('click', handleBack);
        if (overlay) {
            overlay.remove();
        }
    }

    function handleBack() {
        cleanup();
        onBack && onBack();
    }

    canvas.addEventListener('pointerdown', handlePointerDown);
    canvas.addEventListener('pointerup', handlePointerUp);
    canvas.addEventListener('pointercancel', handlePointerUp);
    window.addEventListener('resize', handleResize);
    backButton.addEventListener('click', handleBack);

    initGame();
    lastTimestamp = performance.now();
    rafId = requestAnimationFrame(loop);
}

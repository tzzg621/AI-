// store/AITaskManager.js — 全局 AI 任务管理：排队、持久化、悬浮窗、通知
import { showPrompt } from './dialog.js';

const STORAGE_KEY = 'ai_task_manager';
const MAX_COMPLETED = 10;
const MAX_FAILED = 10;
const DEFAULT_MAX_CONCURRENT = 10;

let instance = null;

class AITaskManager {
    constructor() {
        if (instance) return instance;
        this.tasks = this._load();
        this.maxConcurrent = parseInt(localStorage.getItem('ai_task_max_concurrent')) || DEFAULT_MAX_CONCURRENT;
        this._running = 0;
        this._queue = [];
        this._panelVisible = false;
        this._dragging = false;
        this._initFloatingBtn();
        this._recoverRunning();
        instance = this;
    }

    // ============================================================
    //  公开 API
    // ============================================================

    /**
     * 提交一个 AI 任务
     * @param {'story'|'pixel'|'imagegen'} type - 任务类型
     * @param {string} label - 人类可读的描述
     * @param {Function} asyncFn - async 函数，返回结果
     * @param {object} [callbacks]
     * @param {Function} [callbacks.onComplete] - 完成时回调(result, task)
     * @param {Function} [callbacks.onError] - 失败时回调(error, task)
     * @returns {Promise<any>} 任务结果
     */
    submit(type, label, asyncFn, callbacks = {}) {
        const task = {
            id: 'task_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
            type, label,
            status: 'pending',
            result: null, error: null,
            createdAt: Date.now(),
            completedAt: null
        };
        this.tasks.unshift(task);
        this._save();
        this._updateBadge();
        this._renderPanel();

        return new Promise((resolve, reject) => {
            const run = async () => {
                task.status = 'running';
                this._save();
                this._updateBadge();
                this._renderPanel();
                try {
                    const result = await asyncFn();
                    task.status = 'completed';
                    task.result = result;
                    task.completedAt = Date.now();
                    this._save();
                    this._notify(`✅ ${label}`, '#2e7d32');
                    this._updateBadge();
                    if (callbacks.onComplete) callbacks.onComplete(result, task);
                    resolve(result);
                } catch (e) {
                    task.status = 'failed';
                    const msg = e.message || String(e);
                    task.error = msg;
                    task.completedAt = Date.now();
                    this._save();
                    this._notify(`❌ ${label}`, '#c62828');
                    // 悬浮窗面板显示完整错误
                    this._updateBadge();
                    if (callbacks.onError) callbacks.onError(msg, task);
                    reject(e);
                } finally {
                    this._running--;
                    this._drainQueue();
                    this._trimHistory();
                    this._renderPanel();
                }
            };

            if (this._running < this.maxConcurrent) {
                this._running++;
                run();
            } else {
                this._queue.push(run);
            }
        });
    }

    /**
 * 监听一个 AI 调用，自动记录开始/完成/失败，不干预调用本身
 * @param {string} type - 任务类型
 * @param {string} label - 描述
 * @param {Function} asyncFn - async 函数
 * @param {object} [callbacks]
 * @param {Function} [callbacks.onComplete] - 完成时回调(result, task)
 * @param {Function} [callbacks.onError] - 失败时回调(error, task)
 * @returns {Promise<any>} 原封不动返回 asyncFn 的结果
 */
    async watch(type, label, asyncFn, callbacks = {}) {
        const task = {
            id: 'task_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
            type, label,
            status: 'running',
            result: null, error: null,
            createdAt: Date.now(), completedAt: null
        };
        this.tasks.unshift(task);
        this._save();
        this._updateBadge();
        this._renderPanel();

        try {
            const result = await asyncFn();
            task.status = 'completed';
            task.completedAt = Date.now();
            this._save();
            this._notify(`✅ ${label}`, '#2e7d32');
            this._updateBadge();
            this._renderPanel();
            this._trimHistory();
            if (callbacks.onComplete) callbacks.onComplete(result, task);
            return result;
        } catch (e) {
            task.status = 'failed';
            const msg = e.message || String(e);
            task.error = msg;
            task.completedAt = Date.now();
            this._save();
            this._notify(`❌ ${label}`, '#c62828');
            this._updateBadge();
            this._renderPanel();
            this._trimHistory();
            if (callbacks.onError) callbacks.onError(msg, task);
            throw e;
        }
    }


    /** 获取单个任务 */
    getTask(id) {
        return this.tasks.find(t => t.id === id) || null;
    }

    /** 列出所有任务 */
    listTasks() {
        return [...this.tasks];
    }

    /** 清除历史（进行中的保留） */
    clearHistory() {
        this.tasks = this.tasks.filter(t => t.status === 'running' || t.status === 'pending');
        this._save();
        this._renderPanel();
    }

    /** 设置最大并行数 */
    setMaxConcurrent(n) {
        this.maxConcurrent = Math.max(1, Math.min(20, n));
        localStorage.setItem('ai_task_max_concurrent', this.maxConcurrent);
        this._drainQueue();
    }

    // ============================================================
    //  内部
    // ============================================================

    _load() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            return saved ? JSON.parse(saved) : [];
        } catch { return []; }
    }

    _save() {
        const toSave = this.tasks.map(t => ({
            id: t.id, type: t.type, label: t.label,
            status: t.status, result: t.result, error: t.error,
            createdAt: t.createdAt, completedAt: t.completedAt
        }));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    }

    _recoverRunning() {
        let changed = false;
        this.tasks.forEach(t => {
            if (t.status === 'running' || t.status === 'pending') {
                t.status = 'failed';
                t.error = '页面刷新，任务中断';
                t.completedAt = Date.now();
                changed = true;
            }
        });
        if (changed) this._save();
    }

    _drainQueue() {
        while (this._queue.length > 0 && this._running < this.maxConcurrent) {
            const next = this._queue.shift();
            this._running++;
            next();
        }
    }

    _trimHistory() {
        const running = this.tasks.filter(t => t.status === 'running' || t.status === 'pending');
        const completed = this.tasks.filter(t => t.status === 'completed');
        const failed = this.tasks.filter(t => t.status === 'failed');
        const trimmed = [
            ...running,
            ...completed.slice(0, MAX_COMPLETED),
            ...failed.slice(0, MAX_FAILED)
        ];
        if (trimmed.length !== this.tasks.length) {
            this.tasks = trimmed;
            this._save();
        }
    }

    // ============================================================
    //  悬浮窗
    // ============================================================

    _initFloatingBtn() {
        if (document.getElementById('aiTaskFloatingBtn')) return;

        const btn = document.createElement('div');
        btn.id = 'aiTaskFloatingBtn';
        btn.innerHTML = `📋<span class="badge" style="position:absolute;top:-4px;right:-4px;min-width:16px;height:16px;border-radius:8px;background:#e53935;color:white;font-size:10px;display:none;align-items:center;justify-content:center;font-weight:700;padding:0 4px;pointer-events:none;">0</span>`;
        btn.style.cssText = `
    position:fixed; z-index:9999;
    width:44px; height:44px; border-radius:50%;
    background:var(--task-btn-bg); color:white; cursor:pointer;
    display:flex; align-items:center; justify-content:center;
    font-size:20px;
    box-shadow:0 2px 8px rgba(0,0,0,0.2);
    transition:transform 0.15s, box-shadow 0.15s;
    user-select:none;
`;

        // ★ 初始位置：放在手机屏幕右上角
        const phoneScreen = document.querySelector('.phone-screen');
        if (phoneScreen) {
            const rect = phoneScreen.getBoundingClientRect();
            btn.style.top = (rect.top + 60) + 'px';
            btn.style.right = (window.innerWidth - rect.right + 20) + 'px';
        } else {
            btn.style.top = '60px';
            btn.style.right = '20px';
        }

        // ★ 可拖动
        let offX, offY, sX, sY;
        const onStart = (cx, cy) => {
            this._dragging = true;
            const rect = btn.getBoundingClientRect();
            offX = cx - rect.left;
            offY = cy - rect.top;
            sX = cx; sY = cy;
            btn.style.transition = 'none';
        };
        const onMove = (cx, cy) => {
            // ★ 改成限制在手机屏幕范围内
            const phoneScreen = document.querySelector('.phone-screen');
            const phoneRect = phoneScreen?.getBoundingClientRect() || { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
            const maxX = (phoneRect.right || window.innerWidth) - 60;
            const maxY = (phoneRect.bottom || window.innerHeight) - 60;
            const minX = phoneRect.left || 0;
            const minY = phoneRect.top || 0;
            const x = Math.max(minX, Math.min(maxX, cx - offX));
            const y = Math.max(minY, Math.min(maxY, cy - offY));
            btn.style.left = x + 'px';
            btn.style.top = y + 'px';
            btn.style.right = 'auto';
        };
        const onEnd = (cx, cy) => {
            this._dragging = false;
            btn.style.transition = 'transform 0.12s';
            if (Math.abs(cx - sX) < 5 && Math.abs(cy - sY) < 5) {
                this._togglePanel();
            }
        };

        btn.addEventListener('mousedown', (e) => {
            onStart(e.clientX, e.clientY);
            const mMove = (ev) => onMove(ev.clientX, ev.clientY);
            const mUp = (ev) => { onEnd(ev.clientX, ev.clientY); document.removeEventListener('mousemove', mMove); document.removeEventListener('mouseup', mUp); };
            document.addEventListener('mousemove', mMove);
            document.addEventListener('mouseup', mUp);
            e.preventDefault();
        });

        btn.addEventListener('touchstart', (e) => {
            const t = e.touches[0];
            onStart(t.clientX, t.clientY);
            const tMove = (ev) => { ev.preventDefault(); onMove(ev.touches[0].clientX, ev.touches[0].clientY); };
            const tEnd = (ev) => { onEnd(ev.changedTouches[0].clientX, ev.changedTouches[0].clientY); document.removeEventListener('touchmove', tMove); document.removeEventListener('touchend', tEnd); };
            document.addEventListener('touchmove', tMove, { passive: false });
            document.addEventListener('touchend', tEnd);
        }, { passive: false });

        btn.addEventListener('mouseenter', () => {
            btn.style.transform = 'scale(1.08)';
            btn.style.boxShadow = '0 4px 14px rgba(0,0,0,0.3)';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.transform = 'scale(1)';
            btn.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
        });


        document.body.appendChild(btn);
        this._btn = btn;
        this._badge = btn.querySelector('.badge');
        this._createPanel();
        this._updateBadge();

        window.addEventListener('task-center-visibility', (e) => {
            const visible = e.detail.visible;
            btn.style.display = visible ? 'flex' : 'none';
            if (this._panel) this._panel.style.display = 'none';
            this._panelVisible = false;
        });

        // ★ 初始化时读取设置
        const showTaskCenter = localStorage.getItem('global_show_task_center') !== 'false';
        btn.style.display = showTaskCenter ? 'flex' : 'none';
    }

    _createPanel() {
        if (document.getElementById('aiTaskPanel')) return;

        const panel = document.createElement('div');
        panel.id = 'aiTaskPanel';
        document.body.appendChild(panel);
        this._panel = panel;
        this._renderPanel();

        // ★ 点击外部关闭
        document.addEventListener('click', (e) => {
            if (this._panelVisible &&
                !this._btn.contains(e.target) &&
                !this._panel.contains(e.target)) {
                this._togglePanel();
            }
        });
    }

    _togglePanel() {
        this._panelVisible = !this._panelVisible;
        this._panel.style.display = this._panelVisible ? 'block' : 'none';
        if (this._panelVisible) this._renderPanel();
    }

    _renderPanel() {
        if (!this._panel) return;
        const running = this.tasks.filter(t => t.status === 'running' || t.status === 'pending');
        const completed = this.tasks.filter(t => t.status === 'completed');
        const failed = this.tasks.filter(t => t.status === 'failed');

        const timeStr = (ts) => {
            if (!ts) return '';
            const d = new Date(ts);
            const h = d.getHours().toString().padStart(2, '0');
            const m = d.getMinutes().toString().padStart(2, '0');
            return `${h}:${m}`;
        };

        let html = `
            <div style="font-weight:700; font-size:15px; margin-bottom:10px;">📋 AI 任务中心</div>
        `;

        // ★ 进行中
        if (running.length > 0) {
            html += running.map(t => `
                <div style="display:flex; align-items:center; gap:8px; padding:8px 0; border-bottom:1px solid #f5f5f5;">
                    <span>⏳</span>
                    <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${t.label}</span>
                    <span style="font-size:11px; color:#999; flex-shrink:0;">${timeStr(t.createdAt)}</span>
                </div>
            `).join('');
        }

        const hasHistory = completed.length > 0 || failed.length > 0;

        // ★ 已完成
        if (completed.length > 0) {
            if (running.length > 0 || hasHistory) html += `<div style="border-top:1px dashed #ddd; margin:8px 0;"></div>`;
            completed.slice(0, MAX_COMPLETED).forEach(t => {
                html += `
                    <div style="display:flex; align-items:center; gap:8px; padding:6px 0;">
                        <span style="font-size:14px; flex-shrink:0;">✅</span>
                        <span style="flex:1; color:#888; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${t.label}</span>
                        <span style="font-size:11px; color:#ccc; flex-shrink:0;">${timeStr(t.completedAt)}</span>
                    </div>
                `;
            });
        }

        // ★ 失败的
        if (failed.length > 0) {
            html += `<div style="border-top:1px dashed #ddd; margin:8px 0;"></div>`;
            failed.slice(0, MAX_FAILED).forEach(t => {
                html += `
                    <div style="display:flex; align-items:center; gap:8px; padding:6px 0;">
                        <span style="font-size:14px; flex-shrink:0;">❌</span>
                        <span style="flex:1; color:#bbb; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                            ${t.label}
                            <span style="font-size:11px; color:#ddd; margin-left:4px;">${t.error || ''}</span>
                        </span>
                        <span style="font-size:11px; color:#ddd; flex-shrink:0;">${timeStr(t.completedAt)}</span>
                    </div>
                `;
            });
        }

        // ★ 空状态
        if (this.tasks.length === 0) {
            html += `<div style="text-align:center; color:#ccc; padding:20px 0; font-size:13px;">暂无任务</div>`;
        }

        // ★ 底部操作
        html += `
            <div style="border-top:1px solid #f0f0f0; margin-top:10px; padding-top:10px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                <button class="ai-task-clear-btn" style="padding:4px 10px; border-radius:8px; border:1px solid #ccc; background:white; color:#888; cursor:pointer; font-size:11px;">🗑️ 清除历史</button>
                <span style="font-size:11px; color:#ccc; margin-left:auto;">${this._running}/${this.maxConcurrent}</span>
                <button class="ai-task-set-btn" style="padding:4px 10px; border-radius:8px; border:1px solid #ccc; background:white; color:#888; cursor:pointer; font-size:11px;">⚙️ 并行</button>
            </div>
        `;

        this._panel.innerHTML = html;
        this._panel.style.cssText = `
            position:fixed; top:60px; right:20px; z-index:9998;
            width:300px; max-height:65vh; overflow-y:auto;
            background:white; border-radius:16px;
            box-shadow:0 8px 40px rgba(0,0,0,0.18);
            display:${this._panelVisible ? 'block' : 'none'}; padding:14px 16px;
            font-family:-apple-system,BlinkMacSystemFont,sans-serif;
            font-size:13px; color:#333; line-height:1.5;
        `;

        // ★ 绑定按钮事件
        const clearBtn = this._panel.querySelector('.ai-task-clear-btn');
        if (clearBtn) clearBtn.onclick = () => { this.clearHistory(); };
        const setBtn = this._panel.querySelector('.ai-task-set-btn');
        if (setBtn) setBtn.onclick = async () => {
            const v = await showPrompt('最大并行任务数（1~20）：', this.maxConcurrent);
            if (v !== null) { const n = parseInt(v); if (n >= 1 && n <= 20) this.setMaxConcurrent(n); this._renderPanel(); }
        };
    }

    _updateBadge() {
        if (!this._badge) return;
        const count = this.tasks.filter(t => t.status === 'running' || t.status === 'pending').length;
        this._badge.style.display = count > 0 ? 'flex' : 'none';
        if (count > 0) this._badge.textContent = count;
    }

    // ============================================================
    //  通知
    // ============================================================

    _notify(text, bg) {
        const el = document.createElement('div');
        el.textContent = text;
        el.style.cssText = `
            position:fixed; top:80px; right:20px; z-index:10000;
            background:${bg}; color:white; padding:10px 18px;
            border-radius:12px; font-size:13px;
            font-family:-apple-system,BlinkMacSystemFont,sans-serif;
            box-shadow:0 4px 20px rgba(0,0,0,0.2);
            transform:translateX(120%); opacity:0;
            transition:transform 0.3s ease, opacity 0.3s ease;
            max-width:280px; pointer-events:none;
        `;
        document.body.appendChild(el);
        requestAnimationFrame(() => {
            el.style.transform = 'translateX(0)';
            el.style.opacity = '1';
        });
        setTimeout(() => {
            el.style.transform = 'translateX(120%)';
            el.style.opacity = '0';
            setTimeout(() => el.remove(), 400);
        }, 3000);
    }
}

const taskManager = new AITaskManager();
export { taskManager };

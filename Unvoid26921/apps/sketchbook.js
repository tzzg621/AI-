// apps/sketchbook.js — 🎇 灵光：AI 顺带产出的小剧场片段（纸片形式）
import { esc } from '../store/utils.js';
import { getSketches, deleteSketch, migrateLegacy } from './chat/momentsAI.js';
import { showConfirm } from '../store/dialog.js';

export const id = 'sketchbook';
export const label = '灵光';
export const icon = '🎇';
export const color = '#ffab40';

function formatTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

let _sketches = null;   // null = 未加载

async function loadSketches() {
    try { _sketches = await getSketches(); }
    catch { _sketches = []; }
    return _sketches;
}

export function render() {
    const loading = _sketches === null;
    const sketches = _sketches || [];
    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">🎇 灵光</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content" style="padding:12px 16px 16px;">
                ${loading
                    ? '<div style="text-align:center;color:#999;padding:60px 0;">加载中…</div>'
                    : sketches.length === 0
                        ? '<div style="text-align:center;color:#999;padding:60px 0;"><div style="font-size:48px;margin-bottom:10px;">🎇</div>还没有灵光<br>去朋友圈点刷新，AI 会顺带产出</div>'
                        : `<div style="display:flex;flex-direction:column;gap:12px;">${sketches.map(renderCard).join('')}</div>`}
            </div>
        </div>`;
}

function renderCard(s) {
    return `
        <div data-sk-id="${s.id}" style="
            position:relative;background:linear-gradient(135deg,#fff8e1,#fff3e0);
            border-radius:12px;padding:14px 14px 20px;
            box-shadow:0 2px 8px rgba(0,0,0,0.06);
        ">
            <div style="font-size:14px;line-height:1.7;color:#5d4037;white-space:pre-wrap;">${esc(s.content)}</div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;">
                <span style="font-size:11px;color:#999;">${formatTime(s.createdAt)}</span>
                <span style="font-size:11px;color:#8d6e63;">— 来自 ${esc(s.sourceName || '未知角色')}</span>
            </div>
            <button class="sk-del" data-sk-id="${s.id}" title="删除"
                    style="position:absolute;top:8px;right:10px;border:none;background:none;color:#bbb;cursor:pointer;font-size:14px;">✕</button>
        </div>`;
}

export function bindEvents(container) {
    const appContainer = container.closest('.page-container') || container;

    // 首次进入：搬旧数据（幂等）+ 加载列表 → 重渲染
    loadSketches().then(async () => {
        await migrateLegacy();
        if (!_sketches.length) _sketches = await getSketches();
        if (appContainer.isConnected) appContainer.innerHTML = render();
    });

    // 委托删除：绑一次即可
    if (!appContainer.dataset.skBound) {
        appContainer.dataset.skBound = '1';
        appContainer.addEventListener('click', async (e) => {
            const btn = e.target.closest('.sk-del');
            if (!btn) return;
            e.stopPropagation();
            const ok = await showConfirm('删除这条灵光？');
            if (!ok) return;
            await deleteSketch(btn.dataset.skId);
            _sketches = _sketches.filter(s => s.id !== btn.dataset.skId);
            appContainer.innerHTML = render();
        });
    }
}

export function handleBack(container) {
    return false;
}

if (!window.__moduleRegistry) window.__moduleRegistry = [];
window.__moduleRegistry.push({ id, label, icon, color, render, bindEvents, handleBack });

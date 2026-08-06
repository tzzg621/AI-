// apps/chat/moments.js — 朋友圈（文字 + 点赞 + 评论）
// 数据归属：动态存作者角色数据（char_<id>.moments）
import { CharacterStore, getActiveCharacterId } from '../../store/CharacterStore.js';
import { getCharacterNameById } from '../characterManager.js';
import { esc } from '../../store/utils.js';
import { showPrompt } from '../../store/dialog.js';

// ---- 可见范围：主视角 + 好友 + 好友的好友（默认开）----
function getVisibleIds(activeId) {
    const me = new CharacterStore(activeId);
    const friends = me.getFriendIds();
    const second = [];
    friends.forEach(fid => {
        new CharacterStore(fid).getFriendIds().forEach(ff => {
            if (ff !== activeId && !friends.includes(ff) && !second.includes(ff)) second.push(ff);
        });
    });
    return [activeId, ...friends, ...second];
}

// ---- 聚合：合并可见角色的动态，时间倒序 ----
function collectMoments(activeId) {
    const ids = getVisibleIds(activeId);
    const all = [];
    ids.forEach(id => {
        try {
            all.push(...new CharacterStore(id).getMoments());
        } catch { /* 跳过损坏数据 */ }
    });
    return all.sort((a, b) => b.timestamp - a.timestamp);   // 最新在上
}

function formatTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// ---- 入口：从发现页调用 ----
export function showMomentsViewer(globalState) {
    const overlay = document.createElement('div');
    overlay.className = 'moments-overlay';
    overlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:310;background:#f0f0f0;display:flex;flex-direction:column;overflow:hidden;';
    const phoneScreen = document.querySelector('.phone-screen') || document.body;
    phoneScreen.appendChild(overlay);
    renderList(overlay, globalState);
    return overlay;
}

function renderList(overlay, globalState) {
    const activeId = getActiveCharacterId(globalState);
    const moments = collectMoments(activeId);

    overlay.innerHTML = `
        <div style="background:white;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
            <button id="momentsBackBtn" style="border:none;background:none;font-size:18px;color:#666;cursor:pointer;">←</button>
            <span style="font-weight:700;font-size:16px;">朋友圈</span>
            <button id="momentsPostBtn" style="border:none;background:#0b93f6;color:#fff;border-radius:16px;padding:5px 14px;font-size:13px;cursor:pointer;">发布</button>
        </div>
        <div class="moments-list" style="flex:1;overflow-y:auto;padding:12px;">
            ${moments.length === 0 ? '<div style="text-align:center;color:#999;padding:40px 0;">还没有动态，发一条吧</div>' : ''}
            ${moments.map(m => renderMoment(m, activeId)).join('')}
        </div>
    `;

    overlay.querySelector('#momentsBackBtn').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#momentsPostBtn').addEventListener('click', async () => {
        const text = await showPrompt('这一刻的想法...');
        if (!text) return;
        new CharacterStore(activeId).addMoment(text.trim());
        renderList(overlay, globalState);
    });

    // 点赞 / 评论事件（事件委托）
    overlay.querySelector('.moments-list')?.addEventListener('click', async (e) => {
        const likeBtn = e.target.closest('[data-like]');
        if (likeBtn) {
            const { authorId, momentId } = likeBtn.dataset;
            new CharacterStore(authorId).likeMoment(momentId, activeId);
            renderList(overlay, globalState);
            return;
        }
        const commentBtn = e.target.closest('[data-comment]');
        if (commentBtn) {
            const { authorId, momentId } = commentBtn.dataset;
            const text = await showPrompt('评论：');
            if (!text) return;
            const me = new CharacterStore(activeId);
            new CharacterStore(authorId).commentMoment(momentId, {
                authorId: activeId,
                authorName: me.getInfo().name || getCharacterNameById(activeId),
                text: text
            });
            renderList(overlay, globalState);
            return;
        }
        const replyBtn = e.target.closest('[data-reply]');
        if (replyBtn) {
            const { authorId, momentId, targetId, targetName } = replyBtn.dataset;
            const text = await showPrompt(`回复 ${targetName}：`);
            if (!text) return;
            const me = new CharacterStore(activeId);
            new CharacterStore(authorId).replyComment(momentId, targetId, {
                authorId: activeId,
                authorName: me.getInfo().name || getCharacterNameById(activeId),
                replyToId: targetId,
                replyToName: targetName,
                text: text
            });
            renderList(overlay, globalState);
            return;
        }

    });
}

function renderMoment(m, activeId) {
    const isMe = m.authorId === activeId;
    const authorName = isMe ? '我' : getCharacterNameById(m.authorId);
    const likes = (m.likes || []).map(id => getCharacterNameById(id)).join('、');
    const comments = (m.comments || []).map(c => {
        const cName = c.authorId === activeId ? '我' : c.authorName;
        const replies = (c.replies || []).map(r =>
            `<div style="margin-left:12px;margin-top:2px;font-size:13px;line-height:1.5;">
        <span style="font-weight:600;">${esc(r.authorId === activeId ? '我' : r.authorName)}</span>
        <span style="color:#999;">回复</span>
        <span style="font-weight:600;">${esc(r.replyToId === activeId ? '我' : r.replyToName)}：</span>
        ${esc(r.text)}
        <button data-reply data-author-id="${esc(m.authorId)}" data-moment-id="${esc(m.id)}"
                data-target-id="${esc(r.id)}" data-target-name="${esc(r.authorName)}"
                style="border:none;background:none;color:#999;cursor:pointer;font-size:11px;margin-left:6px;">回复</button>
    </div>`).join('');

        return `
        <div style="margin-top:4px;font-size:13px;line-height:1.5;">
            <span style="font-weight:600;">${esc(cName)}：</span>${esc(c.text)}
            <button data-reply data-author-id="${esc(m.authorId)}" data-moment-id="${esc(m.id)}"
        data-target-id="${esc(c.id)}" data-target-name="${esc(c.authorName)}"
        style="border:none;background:none;color:#999;cursor:pointer;font-size:11px;margin-left:6px;">回复</button>

            ${replies}
        </div>`;
    }).join('');

    return `
    <div class="moments-item" style="background:white;border-radius:14px;padding:12px;margin-bottom:10px;">
        <div style="display:flex;${isMe ? 'flex-direction:row-reverse;' : ''}align-items:flex-start;gap:10px;">
            <div style="width:38px;height:38px;border-radius:50%;background:#e0e0e0;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">
                ${esc((authorName || '?').charAt(0))}
            </div>
            <div style="flex:1;min-width:0;${isMe ? 'text-align:right;' : ''}">
                <div style="font-size:14px;font-weight:600;">${esc(authorName)}</div>
                <div style="font-size:14px;line-height:1.6;margin-top:4px;white-space:pre-wrap;">${esc(m.text)}</div>
                <div style="font-size:11px;color:#999;margin-top:6px;">${formatTime(m.timestamp)}</div>
            </div>
        </div>
        <div style="margin-top:10px;padding-top:8px;border-top:1px solid #f0f0f0;">
            ${likes ? `<div style="font-size:12px;color:#ff9800;margin-bottom:4px;">❤️ ${esc(likes)}</div>` : ''}
            ${comments}
            <div style="display:flex;gap:16px;margin-top:6px;font-size:13px;color:#666;">
                <button data-like data-author-id="${esc(m.authorId)}" data-moment-id="${esc(m.id)}" style="border:none;background:none;cursor:pointer;color:${m.likes?.includes(activeId) ? '#e91e63' : '#666'};font-size:13px;">
                    ${m.likes?.includes(activeId) ? '❤️ 已赞' : '🤍 赞'}
                </button>
                <button data-comment data-author-id="${esc(m.authorId)}" data-moment-id="${esc(m.id)}" style="border:none;background:none;cursor:pointer;color:#666;font-size:13px;">💬 评论</button>
            </div>
        </div>
    </div>`;
}

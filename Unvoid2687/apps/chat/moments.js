// apps/chat/moments.js — 朋友圈（文字 + 点赞 + 评论）
// 数据归属：动态存作者角色数据（char_<id>.moments）
import { CharacterStore, getActiveCharacterId } from '../../store/CharacterStore.js';
import { getCharacterNameById } from '../characterManager.js';
import { esc } from '../../store/utils.js';
import { showPrompt, showConfirm } from '../../store/dialog.js';
import { generateMomentForCharacter, fixMomentText } from './momentsAI.js';
import { isArchived } from '../roleData.js';



// ---- 可见范围：主视角 + 好友（好友的好友不可见）----
function getVisibleIds(activeId) {
    const me = new CharacterStore(activeId);
    const friends = me.getFriendIds();
    return [activeId, ...friends];
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

function toast(msg, bg = '#333') {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:${bg};color:#fff;padding:10px 20px;border-radius:12px;z-index:10000;font-size:13px;box-shadow:0 4px 20px rgba(0,0,0,0.2);max-width:80%;text-align:center;`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
}

// ---- 自动修正开关（localStorage 持久化，默认开） ----
const FIX_KEY = 'moments_auto_fix';
function getFixEnabled() { return localStorage.getItem(FIX_KEY) !== 'false'; }
function setFixEnabled(v) { localStorage.setItem(FIX_KEY, v ? 'true' : 'false'); }


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
<!-- ① header（在按钮组之后闭合） -->
<div style="background:white;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
    <button id="momentsBackBtn" style="border:none;background:none;font-size:18px;color:#666;cursor:pointer;">←</button>
    <span style="font-weight:700;font-size:16px;">朋友圈</span>
    <div style="display:flex;gap:8px;">
    <button id="momentsFixToggle" title="自动修正开关"
        style="border:none;background:${getFixEnabled() ? '#7c4dff' : '#f0f0f0'};color:${getFixEnabled() ? '#fff' : '#666'};border-radius:14px;padding:4px 10px;font-size:11px;cursor:pointer;">${getFixEnabled() ? '✨自动' : '✨手动'}</button>

        <button id="momentsRefreshBtn" title="随机好友发一条朋友圈"
                style="border:none;background:#f0f0f0;color:#666;border-radius:50%;width:30px;height:30px;font-size:14px;cursor:pointer;">🔄</button>
        <button id="momentsPostBtn" style="border:none;background:#0b93f6;color:#fff;border-radius:16px;padding:5px 14px;font-size:13px;cursor:pointer;">发布</button>
    </div>
</div>  <!-- ← header 在这里闭合 -->

<!-- ② 列表（在 header 外面、overlay 的直接子元素） -->
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
    overlay.querySelector('#momentsRefreshBtn').addEventListener('click', async () => {
        const friends = new CharacterStore(activeId).getFriendIds();
        // ★ 过滤已归档角色（不参与活跃朋友圈）
        const activeFriends = friends.filter(id => !isArchived(id));
        if (activeFriends.length === 0) {
            toast('暂无活跃好友，先添加好友吧', '#ff9800');
            return;
        }
        const pick = activeFriends[Math.floor(Math.random() * activeFriends.length)];
        const pickName = getCharacterNameById(pick);
        const btn = overlay.querySelector('#momentsRefreshBtn');
        btn.disabled = true;
        btn.textContent = '⏳';
        toast(`${pickName} 正在发朋友圈...`, '#7c4dff');
        try {
            const text = await generateMomentForCharacter(pick, { autoFix: getFixEnabled() });
            new CharacterStore(pick).addMoment(text);
            toast(`✅ ${pickName} 发了一条朋友圈`, '#2e7d32');
        } catch (e) {
            toast(`❌ ${e.message || '生成失败'}`, '#c62828');
        } finally {
            btn.disabled = false;
            btn.textContent = '🔄';
            renderList(overlay, globalState);   // 重新渲染，新动态在顶部
        }
    });

    overlay.querySelector('#momentsFixToggle').addEventListener('click', () => {
        setFixEnabled(!getFixEnabled());
        renderList(overlay, globalState);   // 重渲染刷新开关显示
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
        const fixBtn = e.target.closest('[data-fix]');
        if (fixBtn) {
            const { authorId, momentId } = fixBtn.dataset;
            const store = new CharacterStore(authorId);
            const moment = (store.getMoments() || []).find(x => x.id === momentId);
            if (!moment) return;
            const btn = fixBtn;
            btn.disabled = true;
            btn.textContent = '⏳';
            try {
                const newText = await fixMomentText(authorId, moment.text);
                if (newText && newText !== moment.text) {
                    store.updateMomentText(momentId, newText);   // 只替换文字，清空互动
                    toast('✅ 已修正', '#2e7d32');
                } else {
                    toast('ℹ️ 无需修正', '#999');
                }
            } catch (e) {
                toast(`❌ ${e.message || '修正失败'}`, '#c62828');
            } finally {
                renderList(overlay, globalState);
            }
            return;
        }
        const delBtn = e.target.closest('[data-del]');
        if (delBtn) {
            const { authorId, momentId } = delBtn.dataset;
            const ok = await showConfirm('确定删除这条朋友圈？');
            if (!ok) return;
            new CharacterStore(authorId).deleteMoment(momentId);
            toast('🗑️ 已删除', '#999');
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
                <button data-fix data-author-id="${esc(m.authorId)}" data-moment-id="${esc(m.id)}" style="border:none;background:none;cursor:pointer;color:#7c4dff;font-size:13px;">✨修正</button>
                <button data-del data-author-id="${esc(m.authorId)}" data-moment-id="${esc(m.id)}" style="border:none;background:none;cursor:pointer;color:#999;font-size:13px;">🗑️</button>
            </div>
        </div>
    </div>`;
}

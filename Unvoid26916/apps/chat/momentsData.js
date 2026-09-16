// apps/chat/momentsData.js — 朋友圈数据层（可见范围 / 聚合 / 时间格式化）
// ★ 只依赖 CharacterStore，不碰 UI 与 AI
// 朋友圈查看器（moments.js）与发现页（chat.js）共用同一套取数口径，改规则只改这里
//
// ★ 锚点是主视角：这里的「可见范围」= 主视角 + 主视角的好友。
//   朋友圈另有一条同形状、但锚在动态归属者（发布者 / 动态作者）的取好友写法（见 momentsAI.js），
//   两者只是形状一样，规则不是同一条 —— 别拿本函数去套那几处。

import { CharacterStore } from '../../store/CharacterStore.js';

// ---- 可见范围：主视角 + 好友（好友的好友不可见）----
export function getVisibleIds(activeId) {
    const me = new CharacterStore(activeId);
    const friends = me.getFriendIds();
    return [activeId, ...friends];
}

// ---- 聚合：合并可见角色的动态，时间倒序 ----
export function collectMoments(activeId) {
    const ids = getVisibleIds(activeId);
    const all = [];
    ids.forEach(id => {
        try {
            all.push(...new CharacterStore(id).getMoments());
        } catch { /* 跳过损坏数据 */ }
    });
    return all.sort((a, b) => b.timestamp - a.timestamp);   // 最新在上
}

// ---- 时间格式化：今天显示 HH:MM，其余显示 M月D日 ----
export function formatTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    return `${d.getMonth() + 1}月${d.getDate()}日`;
}

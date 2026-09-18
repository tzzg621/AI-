// apps/signature.js — 角色个性签名（领域逻辑）
//
// 定位：签名是角色的「动态个性补充」——由角色自己在对话中写，主视角只在通讯录/我页看到结果。
// 数据单一来源：char_<id>.signature / signatureLog（经 CharacterStore，DataSync 托管，不另开库）。
//
// 设计要点（用户 2026-09-11 确认）：
// - 频控：每自然日最多 DAILY_LIMIT 次生效，0 点重置
// - 计数从 signatureLog 派生，不存独立计数器（计数器与记录分离是典型的失同步源）
// - 失败的更新（含被频控拦截）与当时的内容/原因绑定记录，一同记录、一同清理
// - 触发来源可扩展：任何模块都可调 applySignatureUpdate()，不限于聊天标签
// - 只对「角色卡角色」生效（名册/世界网络）——元联系人/AI 助手不在角色体系内，天然排除

import { CharacterStore } from '../store/CharacterStore.js';
import { getAllCharacterIds } from './characterManager.js';

export const DAILY_LIMIT = 3;   // 每自然日最多生效次数
export const MAX_LEN = 20;      // 签名长度上限（字符）

/** 今日 0 点的时间戳（自然日口径） */
function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

/** 读取角色当前签名（无则空字符串） */
export function getSignature(charId) {
    if (!charId) return '';
    try { return new CharacterStore(charId).getSignature(); } catch { return ''; }
}

/** 今日已生效的更新次数（从日志派生） */
export function getTodayUpdateCount(charId) {
    if (!charId) return 0;
    const since = startOfToday();
    try {
        return new CharacterStore(charId).getSignatureLog()
            .filter(e => e.ok && e.at >= since).length;
    } catch { return 0; }
}

/**
 * 应用一次签名更新。
 * 被拒的「实质尝试」（超长 / 达上限）会连同内容与原因写入日志；
 * 「空内容 / 与当前相同」属于无更新，静默忽略不记（否则 AI 每轮复述当前签名会刷爆日志）。
 * @param {string} charId
 * @param {string} text - AI（或其他触发方）想写的新签名，内部做清洗与校验
 * @param {object} [opts]
 * @param {string} [opts.source='chat'] - 触发来源，便于将来多渠道排查
 * @returns {{ok: boolean, reason?: string, count?: number}}
 */
export function applySignatureUpdate(charId, text, { source = 'chat' } = {}) {
    if (!charId) return { ok: false, reason: '缺少角色 ID' };

    // 只对角色卡角色生效（元联系人无角色卡，天然排除）
    if (!getAllCharacterIds({ includeArchived: true }).includes(charId)) {
        return { ok: false, reason: '非角色' };
    }

    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return { ok: false, reason: '内容为空' };

    const store = new CharacterStore(charId);
    if (clean === store.getSignature()) return { ok: false, reason: '内容未变化' };

    // 超长：拒绝并记录——宁可不动，也不截出半句话挂名片上
    if (clean.length > MAX_LEN) {
        const reason = `超过 ${MAX_LEN} 字上限`;
        store.commitSignature(clean, { ok: false, reason, source });
        return { ok: false, reason };
    }

    // 频控（自然日）
    const used = getTodayUpdateCount(charId);
    if (used >= DAILY_LIMIT) {
        const reason = `今日更新次数已达上限（${DAILY_LIMIT} 次）`;
        store.commitSignature(clean, { ok: false, reason, source });
        return { ok: false, reason };
    }

    store.commitSignature(clean, { ok: true, source });
    return { ok: true, count: used + 1 };
}

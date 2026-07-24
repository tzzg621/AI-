// apps/promptBuilder.js — 提示词构建器

import { CharacterStore } from '../store/CharacterStore.js';
import { getCharacterNameById } from './characterManager.js';

// ★ 不同场合的 system prompt 模板
const SYSTEM_TEMPLATES = {
    dual: (aiRoleName) => [
        '这是一个角色扮演场景。两个角色通过手机类线上聊天软件在对话。',
        aiRoleName ? `你现在扮演的角色是：${aiRoleName}` : null,
        '请完全以该角色的身份、性格和风格回应，不要跳出角色。',
        '【绝对规则】回复中不得包含任何括号（）内的内容，包括动作、表情、心理描写。只输出对话本身。',
        '回复不超过100字，保持自然流畅。',
        '',
        '【重要说明】',
        '下方 "assistant" 消息中包含了所有角色信息（角色卡、世界观设定、对话历史等）。',
        '这些内容只是提供背景信息，不代表你曾经说过所有角色的话。',
        aiRoleName ? `你只需要以 "${aiRoleName}" 的身份，回应最新的消息即可。` : null,
    ].filter(Boolean).join('\n'),

    group_single: (aiRoleName) => [
        '这是一个群聊角色扮演场景。多人在一起聊天。',
        aiRoleName ? `你现在扮演的角色是：${aiRoleName}` : null,
        '请完全以该角色的身份、性格和风格回应，不要跳出角色。',
        '注意：群聊中其他人也会发言，你只需在轮到你时以自己角色的身份回应。',
        '回复不超过100字，保持自然流畅。',
        '',
        '【重要说明】',
        '以下对话历史中，不同角色用名字区分。',
        aiRoleName ? `你只需要以 "${aiRoleName}" 的身份回应对话。` : null,
        '不要替其他人说话，也不要替他们决定行动。',
    ].filter(Boolean).join('\n'),

    group_multi: (aiRoleNames) => {
        const roleList = Array.isArray(aiRoleNames) ? aiRoleNames.join('、') : aiRoleNames;
        return [
            '这是一个群聊角色扮演场景。',
            `你需要扮演以下角色：${roleList}`,
            '请根据对话内容，轮流以这些角色的身份回应。',
            '每次回复前请标注角色名，例如「精灵🧚：……」或「法师🧙：……」',
            '每个角色保持各自的性格和风格，不要混淆。',
            '不要替其他角色（主角👑等）说话或决定行动。',
            '回复不超过100字，保持自然流畅。',
        ].filter(Boolean).join('\n');
    },

    narrative: (aiRoleName) => [
        '这是一个故事叙述场景。',
        aiRoleName ? `你现在扮演的角色是：${aiRoleName}` : null,
        '请以第三人称叙述的方式推进剧情。',
        '描述角色的动作、表情和环境，而不仅仅是对话。',
        '每次回复不超过200字。',
    ].filter(Boolean).join('\n'),
};

// ★ 指令部分 → system
function buildSystemPrompt(mode, aiRoleName) {
    const template = SYSTEM_TEMPLATES[mode] || SYSTEM_TEMPLATES.dual;
    return template(aiRoleName);
}

// ★ 信息部分 → assistant（各部分标注优先级 0~10）

function buildCharacterPrompt(character) {
    if (!character) return null;
    return {
        priority: 9,
        text: [
            '【角色信息】',
            `名称：${character.base.name}`,
            ...(character.base.gender ? [`性别：${character.base.gender}`] : []),
            ...(character.base.age ? [`年龄：${character.base.age}`] : []),
            ...(character.base.orientation ? [`性取向：${character.base.orientation}`] : []),
            `性格描述：${character.base.desc}`,
            `说话风格：${character.base.style}`,
            `内心秘密：${character.base.secret}`,
            ...(character.base.detail ? [`详细设定：${character.base.detail}`] : []),
            '',
            '（以上是该角色的设定信息，为理解角色提供参考。日常对话中正常交流即可，不需要主动引出这些背景信息。）'
        ].join('\n')
    };
}

function buildWorldPrompt() {
    try {
        const saved = localStorage.getItem('worldbook_entries');
        if (!saved) return null;
        const entries = JSON.parse(saved);
        if (entries.length === 0) return null;
        
        // ★ 只保留已启用的条目
        const enabledEntries = entries.filter(e => e.enabled !== false);
        if (enabledEntries.length === 0) return null;
        
        // ★ 按优先级排序（高在前）
        const sorted = [...enabledEntries]
            .map(e => ({ ...e, priority: e.priority ?? 6 }))
            .sort((a, b) => b.priority - a.priority);
        return sorted;
    } catch {
        return null;
    }
}

function buildMemoryPrompt(characterId, maxCount = 20) {
    if (!characterId) return null;
    try {
        const store = new CharacterStore(characterId);
        const memories = store.getMemories();
        if (memories.length === 0) return null;

        // ★ 只取最近 maxCount 条
        const recent = memories.slice(-maxCount);
        let text = [
            '【角色的长期记忆】',
            ...recent.map(m => `- ${m.time}：${m.content}`)
        ].join('\n');

        if (memories.length > maxCount) {
            text += `\n...（另有 ${memories.length - maxCount} 条更早的记忆未加载）`;
        }

        return { priority: 8, text };
    } catch {
        return null;
    }
}

function buildConversationPrompt(messages, mode, aiRoleName) {
    if (!messages || messages.length === 0) return null;

    const useFirstPerson = mode !== 'group_multi';

    const lines = messages.map(m => {
        const name = getCharacterNameById(m.senderId) || m.senderName || m.senderId;
        let displayName = name;
        if (useFirstPerson && aiRoleName && name === aiRoleName) {
            displayName = '我';
        }
        return `${displayName}：${m.text}`;
    });

    return lines.join('\n');
}

// ---- 主构建函数 ----
export function buildPrompt({
    character,
    characterId,
    messages,
    aiRoleName,
    mode = 'dual',
    maxConvHistory = 50,
    maxMemories = 20,
    maxTotalChars,
    autoMemory = false

} = {}) {
    // ★ 如果调用处没传 maxTotalChars，就从预设里读
    if (maxTotalChars === undefined) {
        try {
            const saved = localStorage.getItem('ai_presets');
            if (saved) {
                const presets = JSON.parse(saved);
                const defaultPreset = presets.find(p => p.isDefault) || presets[0];
                if (defaultPreset && defaultPreset.maxContextChars) {
                    maxTotalChars = defaultPreset.maxContextChars;
                }
            }
        } catch { /* 忽略 */ }
        if (maxTotalChars === undefined) {
            maxTotalChars = 300000;
        }
    }
    let systemPrompt = buildSystemPrompt(mode, aiRoleName);

    // ★ 自动记忆指令
    if (autoMemory) {
        systemPrompt += `

【请留意记忆管理】
在回复前，请参考"【角色的长期记忆】"中已有的记忆列表：

- 如果刚才的【最新对话】中出现了全新且值得记住的信息
  → 在回复末尾加 【记忆】以第一人称"我"的视角概括

- 如果新信息与已有记忆高度相似（只是表述不同），则不需要重复记录

- 如果已有记忆中的某条信息发生了变化或需要补充
  → 在回复末尾加 【修改记忆】已有记忆的完整内容 → 修改后的新内容

注意：
- 请以第一人称（"我"）的视角来描述记忆内容
- 涉及对方角色时，需要使用或以备注形式提到对方的名字，不要只用"你"，以免面对不同角色时记忆混淆
- 如果没有任何操作，不需要加任何内容
- 修改时，请尽量完整匹配已有记忆的原文`;
    }


    // ============================================================
    //  第一步：构建各个部分，各自标注优先级
    // ============================================================

    // P9 — 角色信息（绝不砍）
    const charPart = buildCharacterPrompt(character);

    // P6 — 世界书条目（按优先级排序的数组）
    const worldEntries = buildWorldPrompt();

    // P8 — 角色记忆（已限制条数）
    const memoryPart = buildMemoryPrompt(characterId, maxMemories);

    // ============================================================
    //  第二步：处理对话历史（分为最新10条和历史部分）
    // ============================================================

    const allMessages = messages || [];
    const newestMessages = allMessages.slice(-10);        // P8 — 最新10条
    const olderMessages = allMessages.slice(0, -10);      // P5 — 旧历史

    // 按用户设置的 maxConvHistory 裁减旧历史
    // 总保留条数 = 10（最新）+ 用户想保留的旧历史条数
    const maxOlder = Math.max(0, maxConvHistory - 10);
    const trimmedOlder = olderMessages.slice(-maxOlder);

    // 组装成带标题的文本
    let convNewestText = null;
    let convOlderText = null;

    if (newestMessages.length > 0) {
        const body = buildConversationPrompt(newestMessages, mode, aiRoleName);
        if (body) convNewestText = '【最新对话】\n' + body;
    }
    if (trimmedOlder.length > 0) {
        const body = buildConversationPrompt(trimmedOlder, mode, aiRoleName);
        if (body) {
            convOlderText = '【历史对话】\n' + body;
            if (olderMessages.length > maxOlder) {
                convOlderText += `\n...（另有 ${olderMessages.length - maxOlder} 条更早的对话未加载）`;
            }
        }
    }

    // ============================================================
    //  第三步：组装成带优先级的 parts 列表
    // ============================================================

    const parts = [];

    if (charPart) parts.push(charPart);           // priority 9

    // 世界书：拆成逐条加入，每条各有自己的 priority
    if (worldEntries) {
        const worldText = worldEntries.map(e =>
            `- ${e.title}：${e.text}`
        ).join('\n');
        parts.push({ priority: 7, text: '【世界观设定】\n' + worldText, _entries: worldEntries });
    }

    if (memoryPart) parts.push(memoryPart);       // priority 8

    // ★ 合并对话部分：旧在上新在下，保持时间顺序
    let convText = '';
    if (convOlderText) convText += convOlderText + '\n';
    if (convNewestText) convText += convNewestText;
    if (convText.trim()) {
        parts.push({ priority: 6, text: convText.trim() });  // 整体优先级
    }

    // ============================================================
    //  第四步：按优先级排序 + 拼接，超长则裁减
    // ============================================================

    // 按优先级从高到低排序
    parts.sort((a, b) => b.priority - a.priority);

    // 尝试完整拼接
    let combinedText = parts.map(p => p.text).join('\n---\n');

    // 如果超长，从低优先级开始裁减
    if (combinedText.length > maxTotalChars) {
        // 先把 parts 按优先级从低到高排（准备裁减）
        const removable = [...parts].sort((a, b) => a.priority - b.priority);

        for (const part of removable) {
            if (combinedText.length <= maxTotalChars) break;
            if (part.priority >= 9) continue;  // P9 绝不砍

            // 对于世界书（有 _entries），尝试逐条删除低优先级条目
            if (part._entries && part._entries.length > 1) {
                // 逐条移除最低优先级的条目
                while (part._entries.length > 0 && combinedText.length > maxTotalChars) {
                    // 已经按高→低排序了，所以最后一条是最低优先级
                    part._entries.pop();
                    if (part._entries.length === 0) {
                        // 删光了，移除整个 part
                        combinedText = parts.filter(p => p !== part).map(p => p.text).join('\n---\n');
                    } else {
                        part.text = '【世界观设定】\n' + part._entries.map(e =>
                            `- ${e.title}：${e.text}`
                        ).join('\n');
                        combinedText = parts.map(p => p.text).join('\n---\n');
                    }
                }
                continue;
            }

            // 普通 part：整个移除
            combinedText = parts.filter(p => p !== part).map(p => p.text).join('\n---\n');
        }

        // 如果还是超长，对剩余的最低优先级 part 做文本截断
        if (combinedText.length > maxTotalChars) {
            const remaining = [...parts].filter(p => p.text && combinedText.includes(p.text))
                .sort((a, b) => a.priority - b.priority);

            for (const part of remaining) {
                if (combinedText.length <= maxTotalChars) break;
                if (part.priority >= 9) continue;

                const excess = combinedText.length - maxTotalChars;
                const maxLen = Math.max(200, part.text.length - excess - 50);
                part.text = '...(部分内容因篇幅限制略过)\n' + part.text.slice(-maxLen);
                combinedText = parts.map(p => p.text).join('\n---\n');
            }
        }
    }

    return { systemPrompt, assistantContext: combinedText || null };
}


// ============================================================
//  记忆提取提示词
// ============================================================

/**
 * 构建记忆提取的系统提示词
 */
export function buildMemoryExtractPrompt(otherName, convText, activeCharName) {
    // ★ 在对话文本中，把主视角角色名替换为"我"
    const processedConv = activeCharName 
        ? convText.replace(new RegExp(activeCharName + '：', 'g'), '我：')
        : convText;

    return {
        systemPrompt: `你是一个角色记忆提取助手。从以下对话中提取出值得"我"长期记住的信息。

要求：
- 以第一人称"我"的视角描述
- 涉及对方角色时，用对方的名字"${otherName}"，不要用"你"
- 如果没有值得记住的信息，只返回空数组 []
- 有则返回 JSON 数组，如：[{"content": "我得知了${otherName}原来是一个失落的精灵公主"}]
- 绝对不要虚构信息！！！不要凭空出现未存在于对话中的信息！！！从已有消息中按照自身人设推测出的信息除外
- 不要包含其他文字`,
        assistantContext: processedConv
    };
}

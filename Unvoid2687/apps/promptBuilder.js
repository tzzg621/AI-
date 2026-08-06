// apps/promptBuilder.js — 提示词构建器

import { CharacterStore } from '../store/CharacterStore.js';
import { getCharacterNameById } from './characterManager.js';
import { formatProfilePrompt } from '../store/profileAccess.js';

// ★ 不同场合的 system prompt 模板
const SYSTEM_TEMPLATES = {
    dual: (aiRoleName) => [
        '这是一个角色扮演场景。两个角色通过手机类线上聊天软件在对话。',
        aiRoleName ? `你现在扮演的角色是：${aiRoleName}` : null,
        '请完全以该角色的身份、性格和风格回应，不要跳出角色。',
        '【绝对规则】对话内容不得包含任何括号（）内的内容，包括动作、表情、心理描写。只输出对话本身，以及额外可能存在的字段要求（如【记忆】【关系】【态度】等标记）。',
        '回复的对话内容不超过100字，保持自然流畅。',
        '尽量不要重复你已经说过的话或问过的问题，自然地推进对话。',
        '',
        '【重要说明】',
        '下方消息中包含了角色信息与对话情景（角色卡、世界观设定、对话历史等）。',
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

// 在 buildPrompt 中，读 AI 角色对主视角的认知笔记
function buildCognitiveNotePrompt(aiCharacterId, targetId, targetName) {
    if (!aiCharacterId || !targetId) return null;
    try {
        const store = new CharacterStore(aiCharacterId);  // ← AI扮演的角色
        const note = store.getCognitiveNote(targetId);     // ← 对对方的认知
        if (!note) return null;
        return {
            priority: 8,
            text: '【我对' + targetName + '的认知笔记】\n' + note
        };
    } catch { return null; }
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
        return `${displayName}：${(m.text || '').replace(/\|/g, '')}`;
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
    autoMemory = false,
    targetId,       // ★ 加
    targetName      // ★ 加

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


    //  核心人设
    if (character) {
        const parts = [];
        if (character.base.desc) parts.push(`性格：${character.base.desc}`);
        if (character.base.style) parts.push(`说话风格：${character.base.style}`);
        if (character.base.secret) parts.push(`内心秘密：${character.base.secret}`);
        if (parts.length > 0) {
            systemPrompt += '\n\n【你的核心人设】\n' + parts.join('\n');
        }
    }

    //  关系网
    if (character?.extended?.relations && character.extended.relations.length > 0) {
        const relationText = character.extended.relations
            .map(r => {
                let text = `- 你对 ${r.name} 的定位：${r.relation}`;
                if (r.perspective) text += `\n  你的看法：${r.perspective}`;
                if (r.attitudes?.length > 0) {
                    text += `\n  你的倾向：${r.attitudes.join('、')}`;
                }
                return text;
            })
            .join('\n');
        systemPrompt += `\n\n【你与其他角色的关系】\n${relationText}`;
    }

    // 在 systemPrompt 追加
    systemPrompt += `

【关系管理】
如果【最新对话】让你对某段关系有了新的认识、或关系发生了变化：
  → 在回复末尾加 【关系】对方名字 → 新的关系描述
如果没有变化，不需要加任何内容

注意：
- 如果之前已经有一段关系描述，现在有了更深的了解，可以更新为更精准的描述
- 如果对方做了某件事让你彻底改变了看法，请如实反映`;

    systemPrompt += `

【态度管理】
如果【最新对话】让你对某段关系的态度倾向发生了变化（比如从"不太信任"变成"开始信任了"）：
  → 在回复末尾加 【态度】对方名字 → 新的态度描述
如果没有变化或只是小波动，不需要加任何内容`;

    systemPrompt += `

【认知管理】
认知笔记是你扮演的角色对对方的个人了解和基本认知。

如果【最新对话】让你对对方有了新的认识、或者发现之前的认知有误：
  → 在回复末尾加 【认知】更新后的认知内容

注意：
- 以第一人称"我"的视角写
- 包含外貌、身份、性格、关系等基本认知
- 用完整的新内容覆盖旧内容
- 如果没有变化，不需要加任何内容`;

    systemPrompt += `

【对话回复格式】
请将对话回复内容用 | 分隔成短句，每句表达一个完整的意思。

例如：
你好，今天过得怎么样？| 我听说你最近去了森林。| 那里危险吗？

注意：
- 每句控制在 10-30 字左右
- 用 | 来分隔句子，这是格式要求
- 不要改变你的角色语气和说话风格`;


    // ★ 自动记忆指令
    if (autoMemory) {
        systemPrompt += `

【请留意记忆管理】
在回复前，请参考"【角色的长期记忆】"中已有的记忆列表：

- 如果【最新对话】中出现了全新且值得记住的信息
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

    // ★ 认知笔记（AI角色对主视角的认知）
    const cognitiveNotePart = buildCognitiveNotePrompt(characterId, targetId, targetName);
    if (cognitiveNotePart) parts.push(cognitiveNotePart);

    if (charPart) parts.push(charPart);           // priority 9

    const visibleProfilePart = (() => {
        if (!characterId || !targetId) return null;
        try {
            const text = formatProfilePrompt(targetId, characterId, targetName);
            return text ? { priority: 8, text } : null;
        } catch { return null; }
    })();
    if (visibleProfilePart) parts.push(visibleProfilePart);

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

【已有记忆列表】
对话文本中"【我已有的记忆】"部分包含了当前已有的记忆记录。

要求：
- 以第一人称"我"的视角描述
- 涉及对方角色时，用对方的名字"${otherName}"，不要用"你"
- 如果【对话文本】中出现了全新且值得记住的信息（一条或多条均可）
  → 在返回的 JSON 数组中添加新条目，如 [{"content": "我得知了${otherName}原来是一个失落的精灵公主"}, {"content": "${otherName}似乎是个很内向的人"}]
- 如果新信息与已有记忆高度相似（只是表述不同），则不需要重复记录
- 如果已有记忆中的某条信息发生了变化或需要补充
  → 在返回的 JSON 数组中添加一条修改标记，如 [{"modify": "已有记忆的完整内容", "content": "修改后的新内容"}]
- 如果没有值得记住的信息，只返回空数组 []
- 绝对不要虚构信息！！！不要凭空出现未存在于对话中的信息！！！从已有消息中按照自身人设推测出的信息除外
- 不要包含其他文字

【关系/态度/认知管理】
除了记忆之外，也请评估是否需要更新你对"${otherName}"的以下信息：

1. 【认知笔记】你对对方的整体认知（外貌、性格、身份等）
   → 如需更新，添加 {"cognitiveNote": "全新的认知内容"}

2. 【关系看法】你对这段关系的详细描述
   → 如需更新，添加 {"updateRelation": {"perspective": "新的看法描述"}}

3. 【态度倾向】你对对方的态度标签（一个词语概括，如"信任/怀疑/依赖"）
   → 如需更新，添加 {"updateRelation": {"attitudes": ["信任", "依赖"]}}

4. 【关系定位】你对对方的定位（如"挚友/宿敌/陌生人"）
   → 如需更新，添加 {"updateRelation": {"relation": "挚友"}}

注意：
- 所有内容都以"我"的第一人称视角
- 如果没有变化，不要加对应的字段
- cognitiveNote 会完全覆盖旧内容
- updateRelation 会部分更新（只更新你提供的字段）

返回格式示例：
- 新增： [{"content": "法师原来是一个失落的精灵公主"}, {"content": "${otherName}似乎是个很内向的人"}]
- 修改： [{"modify": "法师喜欢蓝色", "content": "法师其实更喜欢红色"}]
- 带认知更新： [{"content": "${otherName}说他怕火"}, {"cognitiveNote": "${otherName}，看似坚强但内心敏感，怕火。是我的挚友。"}, {"updateRelation": {"relation": "生死之交", "perspective": "他曾救过我的命", "attitudes": ["完全信任"]}}]
- 无变化： []`,

        assistantContext: processedConv
    };
}

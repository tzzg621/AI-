// apps/characterCreator.js — 角色构建器
// 提供多种"新建角色"的方式，各模块可以按需调用

import { generateId, createDefaultCharacterData, CharacterStore } from '../store/CharacterStore.js';
import { getPreset, getDefaultPreset } from './aiService.js';


// ============================================================
//  方式一：手动新建（用户填名字）
// ============================================================

/**
 * 根据名称创建角色
 * @param {string} name - 角色名称
 * @param {object} options - 可选参数
 * @param {string}  [options.emoji='❓']   - 角色图标
 * @param {string}  [options.desc='']      - 角色描述
 * @param {object}  [options.stats]        - 属性，默认 {力量:50,智力:50,魅力:50}
 * @param {string}  [options.secret='']    - 内心秘密
 * @param {string}  [options.style='']     - 说话风格
 * @param {array}   [options.memories=[]]  - 初始记忆
 * @param {string}  [options.type='character'] - 角色类型
 * @param {object}  [options.flags]        - 标记，默认 {switchable: true}
 * @returns {object} 角色数据对象
 */
export function createCharacterByName(name, {
    emoji = '❓',
    desc = '',
    gender = '未知',        // ★ 新增
    age = '未知',            // ★ 新增
    orientation = '未知',    // ★ 新增
    stats = {},
    secret = '',
    style = '',
    detail = '',            // ★ 新增
    memories = [],
    type = 'character',
    flags = { switchable: true }
} = {}) {
    const id = generateId();
    const charData = createDefaultCharacterData(id, {
        name: name.trim(),
        emoji,        // 保留但不再从 UI 传来
        desc,
        gender,       // ★ 新增
        age,          // ★ 新增
        orientation,  // ★ 新增
        detail,       // ★ 新增
        stats,
        secret,
        style,
        memories
    }, type, flags);

    // 同步初始化 CharacterStore
    const store = new CharacterStore(id);
    store.setInfo({
        name: charData.base.name,
        emoji: charData.base.emoji,
        desc: charData.base.desc,
        type,
        label: ''
    });

    return charData;
}


// ============================================================
//  方式二：从 NPC 数据转化
// ============================================================

/**
 * 从 NPC 数据转化为可选角色
 * @param {object} npcData - NPC 角色数据（含 base、id 等字段）
 * @param {object} options - 可选参数
 * @param {string} [options.additionalDesc=''] - 转化时补充的描述
 * @param {object} [options.newFlags]          - 覆盖标记
 * @returns {object} 角色数据对象
 */
export function createCharacterFromNpc(npcData, {
    additionalDesc = '',
    newFlags
} = {}) {
    const id = npcData.id;  // 保留原 ID，保持好友关系
    const charData = createDefaultCharacterData(id, {
        name: npcData.base.name,
        emoji: npcData.base.emoji,
        desc: npcData.base.desc + (additionalDesc ? `\n${additionalDesc}` : ''),
        stats: npcData.base.stats,
        secret: npcData.base.secret,
        style: npcData.base.style,
        memories: npcData.base.memories || []
    }, 'character', newFlags || { switchable: true, convertible: false });

    // 更新 CharacterStore（保留已有的聊天记录和好友）
    const store = new CharacterStore(id);
    store.setInfo({
        name: charData.base.name,
        emoji: charData.base.emoji,
        desc: charData.base.desc,
        type: 'character',
        label: ''
    });

    return charData;
}


// ============================================================
//  方式三：AI 自动生成（预留接口）
// ============================================================

/**
 * 通过 AI 描述生成角色（尚未实现）
 * @param {string} description - 角色描述文本
 * @param {object} options - 可选参数
 * @param {string} [options.presetId] - 使用的 API 预设 ID
 * @param {function} [options.callAI]  - AI 调用函数
 * @returns {Promise<object>} 角色数据对象
 */

/**
 * 
 * 
 * 通过 AI 描述生成角色
 * @param {string} description - 角色描述文本
 * @param {object} options
 * @param {function} options.callAIFn - AI 调用函数
 * @param {string} [options.presetId] - API 预设 ID
 * @returns {Promise<object>} 角色数据对象（可直接用于 createCharacterByName 的 options）
 */
export async function createCharacterByAI(description, { presetId } = {}) {
    // ★ 自己获取 API 配置，不依赖 callAI
    const preset = presetId ? getPreset(presetId) : getDefaultPreset();
    if (!preset) throw new Error('未找到可用的 API 预设');
    if (!preset.apiKey) throw new Error('请先在设置中配置 API 密钥');

    const systemPrompt = '你是一个角色生成器。根据用户的描述，生成一个角色数据，只返回 JSON，不要包含任何其他文字。';

    const userContent = `根据以下描述生成角色：
${description}

请按以下 JSON 格式返回，不要加 markdown 标记：
{
    "name": "角色名称",
    "gender": "性别（如：男/女/非二元/未知/隐藏，也可以自定义）",
    "age": "年龄（如：22岁/少年/古老的存在/未知，不要纯数字，要带描述感）",
    "orientation": "性取向（如：异性恋/同性恋/双性恋/无性恋/泛性恋/未知）",
    "desc": "简短的角色描述，一句话概括",
    "detail": "详细的角色设定，包括外貌特征、性格特点、背景故事等，尽量丰富",
    "secret": "一个内心秘密",
    "style": "说话风格描述"
}`;

    const url = preset.endpoint.replace(/\/+$/, '') + '/chat/completions';

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${preset.apiKey}`
        },
        body: JSON.stringify({
            model: preset.model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userContent }
            ],
            max_tokens: 4096,  // ★ 足够大，让 AI 输出完整 JSON
            temperature: 0.8
        })
    });

    if (!response.ok) {
        let errMsg = `HTTP ${response.status}`;
        try {
            const err = await response.json();
            errMsg = err.error?.message || err.message || errMsg;
        } catch {}
        throw new Error(`AI 角色生成失败: ${errMsg}`);
    }

    const data = await response.json();
    const result = data.choices[0].message.content;

    // ★ 解析 JSON（与原逻辑保持一致）
    let text = result.trim();
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) text = jsonMatch[1].trim();

    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        text = text.substring(firstBrace, lastBrace + 1);
    }

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        try {
            text = text.replace(/,(\s*[}\]])/g, '$1');
            parsed = JSON.parse(text);
        } catch {
            console.error('AI 返回的原始内容:', result);
            throw new Error('AI 返回的数据格式无法解析');
        }
    }

    return {
        name: parsed.name || '未知角色',
        gender: parsed.gender || '未知',
        age: parsed.age || '未知',
        orientation: parsed.orientation || '未知',
        desc: parsed.desc || '',
        detail: parsed.detail || '',
        secret: parsed.secret || '',
        style: parsed.style || ''
    };
}



// ============================================================
//  辅助：自动加好友
// ============================================================

/**
 * 将新角色自动添加为当前主视角的好友
 * @param {object} charData - 新创建的角色数据
 * @param {object|null} activeCharacter - 当前主视角角色数据
 */
export async function autoAddFriend(charData, activeCharacter) {
    if (!activeCharacter || !charData) return;

    const activeId = activeCharacter.id || activeCharacter.base?.name;
    const charId = charData.id || charData.base?.name;
    if (!activeId || !charId || activeId === charId) return;

    try {
        const { addBidirectionalFriend } = await import('../store/CharacterStore.js');
        addBidirectionalFriend(activeId, charId);
    } catch (e) {
        console.warn('自动加好友失败:', e);
    }
}

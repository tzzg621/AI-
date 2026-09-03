// store/DictionaryMatcher.js - 优化版
// 世界词典匹配器
// 不依赖页面 DOM，可供聊天、灵犀、其他 AI 模块直接调用

import { listDictionaryEntries } from './DictionaryStore.js';

// ========== 常量定义 ==========
const DEFAULT_LIMIT = 8;
const DEFAULT_MAX_CHARS = 6000;
const MIN_KEYWORD_LENGTH = 2;
const PRIORITY_WEIGHT = 10;
const KEYWORD_LENGTH_CAP = 8;

// 词条类型权重（某些类型优先级更高）
const KIND_WEIGHTS = {
    world_rule: 3,
    world_fact: 2,
    character_belief: 2,
    event: 1,
    character_profile: 1
};

// ========== 工具函数 ==========

/**
 * 标准化文本用于匹配
 * @param {string} value - 原始文本
 * @returns {string} 标准化后的文本
 */
function normalizeText(value) {
    return String(value ?? '')
        .trim()
        .toLocaleLowerCase();
}

/**
 * 检查词条是否匹配指定作用域
 * @param {Object} entry - 词条对象
 * @param {Object} scope - 作用域配置
 * @returns {boolean} 是否匹配
 */
function entryMatchesScope(entry, scope = {}) {
    const entryScope = entry.scope || { type: 'global' };

    // 全局词条对所有范围都生效
    if (entryScope.type === 'global') {
        return true;
    }

    // 角色专属词条
    if (entryScope.type === 'character') {
        return Boolean(
            scope.characterId &&
            entryScope.characterId === scope.characterId
        );
    }

    // 聊天专属词条
    if (entryScope.type === 'chat') {
        return Boolean(
            scope.pairKey &&
            entryScope.pairKey === scope.pairKey
        );
    }

    return false;
}

/**
 * 获取词条的所有搜索词（标题、关键词、别名）
 * @param {Object} entry - 词条对象
 * @returns {string[]} 标准化的搜索词数组
 */
function getSearchTerms(entry) {
    const terms = [
        entry.title,
        ...(entry.keywords || []),
        ...(entry.aliases || [])
    ]
        .map(normalizeText)
        .filter(term => term.length >= MIN_KEYWORD_LENGTH);

    // 去重
    return [...new Set(terms)];
}

/**
 * 计算词条与文本的匹配信息
 * @param {Object} entry - 词条对象
 * @param {string} text - 待匹配的文本
 * @returns {Object} 匹配信息 { matched, matchedTerms }
 */
function getMatchInfo(entry, text) {
    const source = normalizeText(text);
    const terms = getSearchTerms(entry);
    
    const matchedTerms = terms.filter(term => source.includes(term));

    return {
        matched: matchedTerms.length > 0,
        matchedTerms: [...new Set(matchedTerms)]
    };
}

/**
 * 计算词条权重（用于排序）
 * @param {Object} entry - 词条对象
 * @param {string[]} matchedTerms - 匹配到的关键词
 * @returns {number} 权重分数
 */
function calculateEntryWeight(entry, matchedTerms) {
    // 基础优先级权重
    let weight = Number(entry.priority || 50) * PRIORITY_WEIGHT;

    // 关键词匹配权重（越长的关键词权重越高，但设置上限）
    const keywordWeight = matchedTerms.reduce(
        (total, term) => total + Math.min(term.length, KEYWORD_LENGTH_CAP),
        0
    );
    weight += keywordWeight;

    // 词条类型权重
    const kindWeight = KIND_WEIGHTS[entry.kind] || 0;
    weight += kindWeight;

    // 匹配关键词数量权重
    weight += matchedTerms.length * 2;

    // 标题完全匹配加成
    if (matchedTerms.includes(normalizeText(entry.title))) {
        weight += 10;
    }

    return weight;
}

/**
 * 计算内容长度（用于限制总字符数）
 * @param {Object} entry - 词条对象
 * @returns {number} 内容长度
 */
function getEntryLength(entry) {
    return (
        String(entry.title || '').length +
        String(entry.content || '').length
    );
}

// ========== 主要匹配函数 ==========

/**
 * 匹配词典词条
 * @param {Object} options - 匹配选项
 * @param {string} options.text - 待匹配的文本
 * @param {Object} options.scope - 作用域配置
 * @param {number} options.limit - 最大返回数量
 * @param {number} options.maxChars - 最大字符数
 * @param {boolean} options.includeDisabled - 是否包含已停用词条
 * @returns {Promise<Array>} 匹配的词条数组
 */
export async function matchDictionaryEntries({
    text = '',
    scope = {},
    limit = DEFAULT_LIMIT,
    maxChars = DEFAULT_MAX_CHARS,
    includeDisabled = false
} = {}) {
    // 验证输入
    const source = String(text ?? '').trim();
    if (!source) {
        return [];
    }

    // 获取所有词条
    const entries = await listDictionaryEntries({
        includeDisabled
    });

    if (!Array.isArray(entries) || entries.length === 0) {
        return [];
    }

    // 第一轮：筛选匹配的词条
    const matched = [];

    for (const entry of entries) {
        // 检查作用域
        if (!entryMatchesScope(entry, scope)) {
            continue;
        }

        // 检查是否启用
        if (!includeDisabled && entry.enabled === false) {
            continue;
        }

        // 检查是否匹配
        const matchInfo = getMatchInfo(entry, source);
        if (!matchInfo.matched) {
            continue;
        }

        // 添加匹配信息
        matched.push({
            ...entry,
            matchedTerms: matchInfo.matchedTerms,
            matchScore: calculateEntryWeight(entry, matchInfo.matchedTerms),
            contentLength: getEntryLength(entry)
        });
    }

    // 第二轮：排序
    matched.sort((a, b) => {
        // 首先按权重排序
        if (b.matchScore !== a.matchScore) {
            return b.matchScore - a.matchScore;
        }
        // 权重相同时按更新时间排序
        return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

    // 第三轮：限制数量和字符数
    const result = [];
    let totalChars = 0;
    const effectiveLimit = Math.max(1, Number(limit) || DEFAULT_LIMIT);
    const effectiveMaxChars = Math.max(100, Number(maxChars) || DEFAULT_MAX_CHARS);

    for (const entry of matched) {
        // 检查数量限制
        if (result.length >= effectiveLimit) {
            break;
        }

        // 检查字符数限制（第一条总是添加）
        if (result.length > 0 && totalChars + entry.contentLength > effectiveMaxChars) {
            break;
        }

        result.push(entry);
        totalChars += entry.contentLength;
    }

    return result;
}

// ========== Prompt 构建函数 ==========

/**
 * 将词条数组构建为 Prompt 文本
 * @param {Array} entries - 词条数组
 * @param {Object} options - 构建选项
 * @param {boolean} options.showMatchedTerms - 是否显示匹配的关键词
 * @param {boolean} options.showMetadata - 是否显示元数据
 * @returns {string} 构建的 Prompt
 */
export function buildDictionaryPrompt(entries = [], options = {}) {
    const {
        showMatchedTerms = true,
        showMetadata = false
    } = options;

    if (!Array.isArray(entries) || entries.length === 0) {
        return '';
    }

    // 过滤有效词条
    const validEntries = entries.filter(
        entry => entry?.title && entry?.content
    );

    if (validEntries.length === 0) {
        return '';
    }

    // 构建词条块
    const blocks = validEntries.map((entry, index) => {
        const parts = [`### ${entry.title}`];

        // 内容
        parts.push(entry.content);

        // 匹配的关键词
        if (showMatchedTerms && entry.matchedTerms?.length) {
            parts.push(`触发词：${entry.matchedTerms.join('、')}`);
        }

        // 元数据（可选）
        if (showMetadata) {
            const metadata = [];
            if (entry.priority !== 50) {
                metadata.push(`优先级: ${entry.priority}`);
            }
            if (entry.kind) {
                metadata.push(`类型: ${entry.kind}`);
            }
            if (metadata.length > 0) {
                parts.push(`(${metadata.join(' | ')})`);
            }
        }

        return parts.join('\n');
    });

    // 构建完整 Prompt
    return [
        '## 世界词典',
        '以下内容用于保持世界观、事件和角色认知一致性。',
        '请自然融入对话，不要向用户说明这些内容来自世界词典。',
        '',
        blocks.join('\n\n')
    ].join('\n');
}

/**
 * 一步完成：匹配词条并构建 Prompt
 * @param {Object} options - 匹配和构建选项
 * @returns {Promise<Object>} { entries, prompt, metadata }
 */
export async function buildDictionaryPromptForText(options = {}) {
    const {
        showMatchedTerms = true,
        showMetadata = false,
        ...matchOptions
    } = options;

    const entries = await matchDictionaryEntries(matchOptions);
    const prompt = buildDictionaryPrompt(entries, {
        showMatchedTerms,
        showMetadata
    });

    return {
        entries,
        prompt,
        metadata: {
            totalMatched: entries.length,
            totalChars: entries.reduce(
                (sum, entry) => sum + getEntryLength(entry),
                0
            ),
            averageScore: entries.length > 0
                ? entries.reduce((sum, e) => sum + (e.matchScore || 0), 0) / entries.length
                : 0
        }
    };
}

// ========== 辅助工具函数 ==========

/**
 * 检查词条是否在指定作用域内
 * @param {Object} entry - 词条对象
 * @param {Object} scope - 作用域配置
 * @returns {boolean} 是否在作用域内
 */
export function isDictionaryEntryInScope(entry, scope = {}) {
    return entryMatchesScope(entry, scope);
}

/**
 * 分析文本中可能触发的词条（用于预览/调试）
 * @param {string} text - 待分析的文本
 * @param {Object} scope - 作用域配置
 * @returns {Promise<Object>} 分析结果
 */
export async function analyzePotentialMatches(text, scope = {}) {
    const source = normalizeText(text);
    const entries = await listDictionaryEntries({
        includeDisabled: false
    });

    const analysis = {
        totalEntries: entries.length,
        scopeMatchedEntries: 0,
        keywordMatchedEntries: 0,
        potentialMatches: [],
        unmatchedTerms: []
    };

    for (const entry of entries) {
        const inScope = entryMatchesScope(entry, scope);
        if (inScope) {
            analysis.scopeMatchedEntries++;
        }

        const terms = getSearchTerms(entry);
        const matched = terms.filter(term => source.includes(term));

        if (matched.length > 0 && inScope) {
            analysis.keywordMatchedEntries++;
            analysis.potentialMatches.push({
                id: entry.id,
                title: entry.title,
                matchedTerms: matched,
                score: calculateEntryWeight(entry, matched)
            });
        }
    }

    // 排序潜在匹配
    analysis.potentialMatches.sort((a, b) => b.score - a.score);

    return analysis;
}

/**
 * 获取词条统计信息
 * @param {Object} scope - 可选的作用域筛选
 * @returns {Promise<Object>} 统计信息
 */
export async function getDictionaryStats(scope = null) {
    const entries = await listDictionaryEntries({
        includeDisabled: true
    });

    const stats = {
        total: entries.length,
        enabled: 0,
        disabled: 0,
        byKind: {},
        byScope: {
            global: 0,
            character: 0,
            chat: 0
        },
        totalKeywords: 0,
        averagePriority: 0
    };

    for (const entry of entries) {
        // 过滤作用域（如果指定）
        if (scope && !entryMatchesScope(entry, scope)) {
            continue;
        }

        // 启用状态
        if (entry.enabled !== false) {
            stats.enabled++;
        } else {
            stats.disabled++;
        }

        // 按类型
        const kind = entry.kind || 'unknown';
        stats.byKind[kind] = (stats.byKind[kind] || 0) + 1;

        // 按作用域
        const scopeType = entry.scope?.type || 'global';
        stats.byScope[scopeType] = (stats.byScope[scopeType] || 0) + 1;

        // 关键词数量
        stats.totalKeywords += (entry.keywords || []).length;
        stats.totalKeywords += (entry.aliases || []).length;

        // 优先级总和
        stats.averagePriority += Number(entry.priority || 50);
    }

    // 计算平均优先级
    if (stats.total > 0) {
        stats.averagePriority = Math.round(stats.averagePriority / stats.total);
    }

    return stats;
}

/**
 * 批量测试多个文本的匹配情况
 * @param {string[]} texts - 文本数组
 * @param {Object} scope - 作用域配置
 * @param {Object} options - 匹配选项
 * @returns {Promise<Array>} 每个文本的匹配结果
 */
export async function batchMatchTexts(texts, scope = {}, options = {}) {
    if (!Array.isArray(texts)) {
        throw new Error('texts 必须是数组');
    }

    const results = [];

    for (const text of texts) {
        const result = await buildDictionaryPromptForText({
            text,
            scope,
            ...options
        });

        results.push({
            text: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
            matchCount: result.entries.length,
            prompt: result.prompt,
            metadata: result.metadata
        });
    }

    return results;
}

/**
 * 查找包含特定关键词的词条
 * @param {string} keyword - 关键词
 * @param {Object} scope - 可选的作用域筛选
 * @returns {Promise<Array>} 包含该关键词的词条
 */
export async function findEntriesByKeyword(keyword, scope = null) {
    const normalizedKeyword = normalizeText(keyword);
    if (!normalizedKeyword) {
        return [];
    }

    const entries = await listDictionaryEntries({
        includeDisabled: false
    });

    return entries.filter(entry => {
        // 作用域筛选
        if (scope && !entryMatchesScope(entry, scope)) {
            return false;
        }

        // 关键词匹配
        const terms = getSearchTerms(entry);
        return terms.some(term => term.includes(normalizedKeyword));
    });
}

/**
 * 验证词条配置的有效性
 * @param {Object} entry - 词条对象
 * @returns {Object} 验证结果 { valid, errors, warnings }
 */
export function validateEntry(entry) {
    const result = {
        valid: true,
        errors: [],
        warnings: []
    };

    if (!entry) {
        result.valid = false;
        result.errors.push('词条对象不能为空');
        return result;
    }

    // 必填字段
    if (!entry.title?.trim()) {
        result.valid = false;
        result.errors.push('词条名称不能为空');
    }

    if (!entry.content?.trim()) {
        result.valid = false;
        result.errors.push('词条内容不能为空');
    }

    // 关键词检查
    const terms = getSearchTerms(entry);
    if (terms.length === 0) {
        result.warnings.push('未设置任何触发关键词，可能不会被自动触发');
    }

    // 优先级检查
    const priority = Number(entry.priority);
    if (priority < 0 || priority > 100) {
        result.warnings.push('优先级应在 0-100 之间');
    }

    // 作用域检查
    if (entry.scope?.type === 'character' && !entry.scope.characterId) {
        result.valid = false;
        result.errors.push('角色作用域需要指定 characterId');
    }

    if (entry.scope?.type === 'chat' && !entry.scope.pairKey) {
        result.valid = false;
        result.errors.push('聊天作用域需要指定 pairKey');
    }

    return result;
}

// ========== 导出工具函数 ==========
export {
    normalizeText,
    entryMatchesScope,
    getSearchTerms,
    calculateEntryWeight
};
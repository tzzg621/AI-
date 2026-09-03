// store/DictionaryMatcher.js
// 世界词典匹配器
// 不依赖页面 DOM，可供聊天、灵犀、书城等 AI 模块调用。

import {
    listDictionaryEntries
} from './DictionaryStore.js';

// ============================================================
// 常量
// ============================================================

const DEFAULT_LIMIT = 8;
const DEFAULT_MAX_CHARS = 6000;

const MIN_KEYWORD_LENGTH = 2;
const PRIORITY_WEIGHT = 10;
const KEYWORD_LENGTH_CAP = 8;

const KIND_WEIGHTS = {
    world_rule: 3,
    world_fact: 2,
    character_belief: 2,
    event: 1,
    character_profile: 1
};

// ============================================================
// 基础工具
// ============================================================

/**
 * 标准化用于文本匹配的字符串。
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeText(value) {
    return String(value ?? '')
        .trim()
        .toLocaleLowerCase();
}

/**
 * 将字符串或数组统一转换为去重后的字符串数组。
 *
 * 支持：
 *
 *     ['写作技巧', '世界规则']
 *     '写作技巧'
 *     '写作技巧、世界规则'
 *     '写作技巧,世界规则'
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeFilterList(value) {
    const source = Array.isArray(value)
        ? value
        : String(value ?? '').split(/[,，、\n]/);

    const result = [];
    const seen = new Set();

    for (const item of source) {
        const value = String(item ?? '').trim();

        if (!value || seen.has(value)) {
            continue;
        }

        seen.add(value);
        result.push(value);
    }

    return result;
}

/**
 * 返回词条的类别数组。
 *
 * @param {Object} entry
 * @returns {string[]}
 */
function getEntryCategories(entry) {
    return Array.isArray(entry?.categories)
        ? entry.categories
            .map(category => String(category ?? '').trim())
            .filter(Boolean)
        : [];
}

/**
 * 检查词条是否属于指定类别。
 *
 * categories 数组内部采用 OR 逻辑：
 *
 *     categories: ['写作技巧', '世界规则']
 *
 * 表示词条属于任意一个类别即可。
 *
 * 没有指定类别时，不进行类别限制。
 *
 * @param {Object} entry
 * @param {unknown} targetCategories
 * @returns {boolean}
 */
function entryMatchesCategories(entry, targetCategories) {
    const categories = normalizeFilterList(targetCategories);

    if (categories.length === 0) {
        return true;
    }

    const entryCategories = getEntryCategories(entry);

    return entryCategories.some(category =>
        categories.includes(category)
    );
}

/**
 * 检查词条是否包含被排除的类别。
 *
 * 无类别的词条不会因为排除类别而被排除。
 *
 * @param {Object} entry
 * @param {unknown} excludedCategories
 * @returns {boolean}
 */
function entryIsExcludedByCategories(
    entry,
    excludedCategories
) {
    const categories = normalizeFilterList(excludedCategories);

    if (categories.length === 0) {
        return false;
    }

    const entryCategories = getEntryCategories(entry);

    return entryCategories.some(category =>
        categories.includes(category)
    );
}

/**
 * 检查词条是否属于指定作用域。
 *
 * 全局词条对所有调用范围可见。
 * 角色词条要求 characterId 一致。
 * 聊天词条要求 pairKey 一致。
 *
 * @param {Object} entry
 * @param {Object} scope
 * @returns {boolean}
 */
function entryMatchesScope(entry, scope = {}) {
    const entryScope = entry?.scope || {
        type: 'global'
    };

    if (entryScope.type === 'global') {
        return true;
    }

    if (entryScope.type === 'character') {
        return Boolean(
            scope.characterId &&
            entryScope.characterId === scope.characterId
        );
    }

    if (entryScope.type === 'chat') {
        return Boolean(
            scope.pairKey &&
            entryScope.pairKey === scope.pairKey
        );
    }

    return false;
}

/**
 * 获取词条用于匹配的搜索词。
 *
 * 词条名称、关键词和别名都会参与匹配。
 * 类别不会参与关键词匹配。
 *
 * 长度小于 MIN_KEYWORD_LENGTH 的词会被忽略。
 *
 * @param {Object} entry
 * @returns {string[]}
 */
function getSearchTerms(entry) {
    const terms = [
        entry?.title,
        ...(Array.isArray(entry?.keywords)
            ? entry.keywords
            : []),
        ...(Array.isArray(entry?.aliases)
            ? entry.aliases
            : [])
    ]
        .map(normalizeText)
        .filter(term => term.length >= MIN_KEYWORD_LENGTH);

    return [...new Set(terms)];
}

/**
 * 获取一条词条命中的关键词。
 *
 * 当前使用包含匹配：
 *
 *     用户文本.includes(触发词)
 *
 * @param {Object} entry
 * @param {string} text
 * @returns {{
 *     matched: boolean,
 *     matchedTerms: string[]
 * }}
 */
function getMatchInfo(entry, text) {
    const source = normalizeText(text);
    const terms = getSearchTerms(entry);

    const matchedTerms = terms.filter(term =>
        source.includes(term)
    );

    return {
        matched: matchedTerms.length > 0,
        matchedTerms: [...new Set(matchedTerms)]
    };
}

/**
 * 计算词条的匹配分数。
 *
 * 分数由以下因素组成：
 *
 * - 词条优先级；
 * - 命中词长度；
 * - 词条类型；
 * - 命中词数量；
 * - 标题完整命中加成。
 *
 * @param {Object} entry
 * @param {string[]} matchedTerms
 * @returns {number}
 */
function calculateEntryWeight(entry, matchedTerms = []) {
    let weight =
        Number(entry?.priority || 50) *
        PRIORITY_WEIGHT;

    const keywordWeight = matchedTerms.reduce(
        (total, term) =>
            total + Math.min(
                String(term || '').length,
                KEYWORD_LENGTH_CAP
            ),
        0
    );

    weight += keywordWeight;
    weight += matchedTerms.length * 2;
    weight += KIND_WEIGHTS[entry?.kind] || 0;

    const normalizedTitle = normalizeText(entry?.title);

    if (
        normalizedTitle &&
        matchedTerms.includes(normalizedTitle)
    ) {
        weight += 10;
    }

    return weight;
}

/**
 * 计算词条占用的提示词字符数。
 *
 * 目前计算标题和正文，不计算控制说明文字。
 * 这样可以给实际 Prompt 预留少量额外空间。
 *
 * @param {Object} entry
 * @returns {number}
 */
function getEntryLength(entry) {
    return (
        String(entry?.title || '').length +
        String(entry?.content || '').length
    );
}

/**
 * 返回词条的作用域名称。
 *
 * @param {Object} entry
 * @returns {string}
 */
function getScopeType(entry) {
    return entry?.scope?.type || 'global';
}

// ============================================================
// 主要匹配接口
// ============================================================

/**
 * 匹配世界词典词条。
 *
 * 筛选顺序：
 *
 *     启用状态
 *     → 排除 ID
 *     → 作用域
 *     → 包含类别
 *     → 排除类别
 *     → 类型
 *     → 关键词
 *     → 权重排序
 *     → 数量 / 字符数限制
 *
 * 参数之间的逻辑：
 *
 *     categories 内部：OR
 *     kinds 内部：OR
 *     excludeCategories 内部：OR
 *     categories 与 kinds 之间：AND
 *
 * @param {Object} options
 * @param {string} options.text
 * @param {Object} options.scope
 * @param {string|string[]} options.categories
 * @param {string|string[]} options.excludeCategories
 * @param {string|string[]} options.kinds
 * @param {string|string[]} options.excludeIds
 * @param {number} options.limit
 * @param {number} options.maxChars
 * @param {boolean} options.includeDisabled
 * @returns {Promise<Array>}
 */
export async function matchDictionaryEntries({
    text = '',
    scope = {},
    categories = [],
    excludeCategories = [],
    kinds = [],
    excludeIds = [],
    limit = DEFAULT_LIMIT,
    maxChars = DEFAULT_MAX_CHARS,
    includeDisabled = false
} = {}) {
    const source = String(text ?? '').trim();

    if (!source) {
        return [];
    }

    const categoryList = normalizeFilterList(categories);
    const excludedCategoryList =
        normalizeFilterList(excludeCategories);
    const kindList = normalizeFilterList(kinds);
    const excludedIdSet = new Set(
        normalizeFilterList(excludeIds)
    );

    const entries = await listDictionaryEntries({
        includeDisabled
    });

    if (!Array.isArray(entries) || entries.length === 0) {
        return [];
    }

    const matched = [];

    for (const entry of entries) {
        if (!entry || !entry.id) {
            continue;
        }

        if (excludedIdSet.has(entry.id)) {
            continue;
        }

        if (!entryMatchesScope(entry, scope)) {
            continue;
        }

        // Store 通常已经完成了停用词条过滤，
        // 这里保留一次防御性检查。
        if (!includeDisabled && entry.enabled === false) {
            continue;
        }

        if (
            !entryMatchesCategories(
                entry,
                categoryList
            )
        ) {
            continue;
        }

        if (
            entryIsExcludedByCategories(
                entry,
                excludedCategoryList
            )
        ) {
            continue;
        }

        if (
            kindList.length > 0 &&
            !kindList.includes(entry.kind)
        ) {
            continue;
        }

        const matchInfo = getMatchInfo(entry, source);

        if (!matchInfo.matched) {
            continue;
        }

        matched.push({
            ...entry,
            matchedTerms: matchInfo.matchedTerms,
            matchScore: calculateEntryWeight(
                entry,
                matchInfo.matchedTerms
            ),
            contentLength: getEntryLength(entry)
        });
    }

    matched.sort((a, b) => {
        if (b.matchScore !== a.matchScore) {
            return b.matchScore - a.matchScore;
        }

        return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

    const effectiveLimit = Math.max(
        1,
        Number(limit) || DEFAULT_LIMIT
    );

    const effectiveMaxChars = Math.max(
        100,
        Number(maxChars) || DEFAULT_MAX_CHARS
    );

    const result = [];
    let totalChars = 0;

    for (const entry of matched) {
        if (result.length >= effectiveLimit) {
            break;
        }

        /*
         * 如果当前词条会超过字符上限，跳过它，
         * 继续尝试后面更短的词条。
         */
        if (
            totalChars + entry.contentLength >
            effectiveMaxChars
        ) {
            continue;
        }

        result.push(entry);
        totalChars += entry.contentLength;
    }

    return result;
}

// ============================================================
// Prompt 构建
// ============================================================

/**
 * 将词条数组构建为 Prompt。
 *
 * @param {Array} entries
 * @param {Object} options
 * @param {boolean} options.showMatchedTerms
 * @param {boolean} options.showMetadata
 * @returns {string}
 */
export function buildDictionaryPrompt(
    entries = [],
    {
        showMatchedTerms = true,
        showMetadata = false
    } = {}
) {
    if (!Array.isArray(entries) || entries.length === 0) {
        return '';
    }

    const validEntries = entries.filter(entry =>
        entry?.title && entry?.content
    );

    if (validEntries.length === 0) {
        return '';
    }

    const blocks = validEntries.map(entry => {
        const parts = [
            `### ${entry.title}`,
            String(entry.content)
        ];

        if (
            showMatchedTerms &&
            Array.isArray(entry.matchedTerms) &&
            entry.matchedTerms.length > 0
        ) {
            parts.push(
                `触发词：${entry.matchedTerms.join('、')}`
            );
        }

        if (showMetadata) {
            const metadata = [];

            if (entry.priority !== undefined) {
                metadata.push(`优先级: ${entry.priority}`);
            }

            if (entry.kind) {
                metadata.push(`类型: ${entry.kind}`);
            }

            const scopeType = getScopeType(entry);

            if (scopeType) {
                metadata.push(`作用域: ${scopeType}`);
            }

            if (metadata.length > 0) {
                parts.push(`(${metadata.join(' | ')})`);
            }
        }

        return parts.join('\n');
    });

    return [
        '## 世界词典',
        '以下内容用于保持世界观、事件和角色认知一致性。',
        '请自然融入对话，不要向用户说明这些内容来自世界词典。',
        '',
        blocks.join('\n\n')
    ].join('\n');
}

/**
 * 根据文本匹配词条并构建 Prompt。
 *
 * 除了 showMatchedTerms 和 showMetadata 外，
 * 其余参数都会传递给 matchDictionaryEntries。
 *
 * @param {Object} options
 * @returns {Promise<{
 *     entries: Array,
 *     prompt: string,
 *     metadata: Object
 * }>}
 */
export async function buildDictionaryPromptForText(
    options = {}
) {
    const {
        showMatchedTerms = true,
        showMetadata = false,
        ...matchOptions
    } = options;

    const entries = await matchDictionaryEntries(
        matchOptions
    );

    const prompt = buildDictionaryPrompt(entries, {
        showMatchedTerms,
        showMetadata
    });

    const totalChars = entries.reduce(
        (sum, entry) => sum + getEntryLength(entry),
        0
    );

    const averageScore = entries.length > 0
        ? entries.reduce(
            (sum, entry) =>
                sum + Number(entry.matchScore || 0),
            0
        ) / entries.length
        : 0;

    return {
        entries,
        prompt,
        metadata: {
            totalMatched: entries.length,
            totalChars,
            averageScore,
            categories: normalizeFilterList(
                options.categories
            ),
            excludeCategories: normalizeFilterList(
                options.excludeCategories
            ),
            kinds: normalizeFilterList(options.kinds),
            excludeIds: normalizeFilterList(
                options.excludeIds
            )
        }
    };
}

// ============================================================
// 作用域与匹配分析
// ============================================================

/**
 * 检查词条是否在指定作用域内。
 *
 * @param {Object} entry
 * @param {Object} scope
 * @returns {boolean}
 */
export function isDictionaryEntryInScope(
    entry,
    scope = {}
) {
    return entryMatchesScope(entry, scope);
}

/**
 * 分析文本可能触发的词条。
 *
 * 支持旧调用方式：
 *
 *     analyzePotentialMatches(text, scope, ['写作技巧'])
 *
 * 也支持新调用方式：
 *
 *     analyzePotentialMatches(text, scope, {
 *         categories: ['写作技巧'],
 *         kinds: ['world_rule']
 *     })
 *
 * @param {string} text
 * @param {Object} scope
 * @param {Object|string[]} options
 * @returns {Promise<Object>}
 */
export async function analyzePotentialMatches(
    text,
    scope = {},
    options = {}
) {
    const normalizedOptions = Array.isArray(options)
        ? { categories: options }
        : options || {};

    const {
        categories = [],
        excludeCategories = [],
        kinds = [],
        excludeIds = []
    } = normalizedOptions;

    const categoryList = normalizeFilterList(categories);
    const excludedCategoryList =
        normalizeFilterList(excludeCategories);
    const kindList = normalizeFilterList(kinds);
    const excludedIdSet = new Set(
        normalizeFilterList(excludeIds)
    );

    const source = normalizeText(text);

    const entries = await listDictionaryEntries({
        includeDisabled: false
    });

    const analysis = {
        totalEntries: entries.length,
        scopeMatchedEntries: 0,
        categoryMatchedEntries: 0,
        keywordMatchedEntries: 0,
        potentialMatches: [],
        unmatchedTerms: [],
        filters: {
            categories: categoryList,
            excludeCategories: excludedCategoryList,
            kinds: kindList,
            excludeIds: [...excludedIdSet]
        }
    };

    for (const entry of entries) {
        if (!entry || excludedIdSet.has(entry.id)) {
            continue;
        }

        const inScope = entryMatchesScope(
            entry,
            scope
        );

        if (inScope) {
            analysis.scopeMatchedEntries++;
        }

        const inCategory =
            entryMatchesCategories(entry, categoryList) &&
            !entryIsExcludedByCategories(
                entry,
                excludedCategoryList
            );

        if (inCategory) {
            analysis.categoryMatchedEntries++;
        }

        const inKind =
            kindList.length === 0 ||
            kindList.includes(entry.kind);

        if (
            !inScope ||
            !inCategory ||
            !inKind
        ) {
            continue;
        }

        const matchInfo = getMatchInfo(entry, source);

        if (!matchInfo.matched) {
            continue;
        }

        analysis.keywordMatchedEntries++;

        analysis.potentialMatches.push({
            id: entry.id,
            title: entry.title,
            categories: getEntryCategories(entry),
            kind: entry.kind,
            matchedTerms: matchInfo.matchedTerms,
            score: calculateEntryWeight(
                entry,
                matchInfo.matchedTerms
            )
        });
    }

    analysis.potentialMatches.sort(
        (a, b) => b.score - a.score
    );

    return analysis;
}

// ============================================================
// 统计与批量测试
// ============================================================

/**
 * 获取词典统计信息。
 *
 * @param {Object|null} scope
 * @returns {Promise<Object>}
 */
export async function getDictionaryStats(scope = null) {
    const entries = await listDictionaryEntries({
        includeDisabled: true
    });

    const stats = {
        total: 0,
        enabled: 0,
        disabled: 0,
        byKind: {},
        byScope: {
            global: 0,
            character: 0,
            chat: 0
        },
        byCategory: {},
        totalKeywords: 0,
        totalCategories: 0,
        averagePriority: 0
    };

    let priorityTotal = 0;

    for (const entry of entries) {
        if (
            scope &&
            !entryMatchesScope(entry, scope)
        ) {
            continue;
        }

        stats.total++;

        if (entry.enabled === false) {
            stats.disabled++;
        } else {
            stats.enabled++;
        }

        const kind = entry.kind || 'unknown';
        stats.byKind[kind] =
            (stats.byKind[kind] || 0) + 1;

        const scopeType = getScopeType(entry);
        stats.byScope[scopeType] =
            (stats.byScope[scopeType] || 0) + 1;

        const categories = getEntryCategories(entry);

        stats.totalCategories += categories.length;

        for (const category of categories) {
            stats.byCategory[category] =
                (stats.byCategory[category] || 0) + 1;
        }

        stats.totalKeywords += Array.isArray(entry.keywords)
            ? entry.keywords.length
            : 0;

        stats.totalKeywords += Array.isArray(entry.aliases)
            ? entry.aliases.length
            : 0;

        priorityTotal += Number(entry.priority || 50);
    }

    stats.averagePriority = stats.total > 0
        ? Math.round(priorityTotal / stats.total)
        : 0;

    return stats;
}

/**
 * 批量测试多个文本。
 *
 * @param {string[]} texts
 * @param {Object} scope
 * @param {Object} options
 * @returns {Promise<Array>}
 */
export async function batchMatchTexts(
    texts,
    scope = {},
    options = {}
) {
    if (!Array.isArray(texts)) {
        throw new Error('texts 必须是数组');
    }

    const results = [];

    for (const text of texts) {
        const result =
            await buildDictionaryPromptForText({
                ...options,
                text,
                scope
            });

        const previewText = String(text ?? '');

        results.push({
            text: previewText.slice(0, 100) +
                (previewText.length > 100 ? '...' : ''),
            matchCount: result.entries.length,
            prompt: result.prompt,
            metadata: result.metadata
        });
    }

    return results;
}

// ============================================================
// 关键词查询
// ============================================================

/**
 * 查找关键词或搜索词相关的词条。
 *
 * 这个接口是不依赖上下文文本的直接查询，
 * 与 matchDictionaryEntries 的“文本触发”不同。
 *
 * @param {string} keyword
 * @param {Object|null} scope
 * @returns {Promise<Array>}
 */
export async function findEntriesByKeyword(
    keyword,
    scope = null
) {
    const normalizedKeyword = normalizeText(keyword);

    if (
        normalizedKeyword.length <
        MIN_KEYWORD_LENGTH
    ) {
        return [];
    }

    const entries = await listDictionaryEntries({
        includeDisabled: false
    });

    return entries.filter(entry => {
        if (
            scope &&
            !entryMatchesScope(entry, scope)
        ) {
            return false;
        }

        const terms = getSearchTerms(entry);

        return terms.some(term =>
            term.includes(normalizedKeyword)
        );
    });
}

// ============================================================
// 词条校验
// ============================================================

/**
 * 验证词条配置。
 *
 * @param {Object} entry
 * @returns {{
 *     valid: boolean,
 *     errors: string[],
 *     warnings: string[]
 * }}
 */
export function validateEntry(entry) {
    const result = {
        valid: true,
        errors: [],
        warnings: []
    };

    if (!entry || typeof entry !== 'object') {
        return {
            valid: false,
            errors: ['词条对象不能为空'],
            warnings: []
        };
    }

    if (!String(entry.title || '').trim()) {
        result.valid = false;
        result.errors.push('词条名称不能为空');
    }

    if (!String(entry.content || '').trim()) {
        result.valid = false;
        result.errors.push('词条内容不能为空');
    }

    const terms = getSearchTerms(entry);

    if (terms.length === 0) {
        result.warnings.push(
            '未设置任何有效触发关键词，可能不会被自动触发'
        );
    }

    const priority = Number(entry.priority);

    if (
        !Number.isFinite(priority) ||
        priority < 0 ||
        priority > 100
    ) {
        result.warnings.push(
            '优先级应在 0-100 之间'
        );
    }

    if (
        entry.scope?.type === 'character' &&
        !entry.scope.characterId
    ) {
        result.valid = false;
        result.errors.push(
            '角色作用域需要指定 characterId'
        );
    }

    if (
        entry.scope?.type === 'chat' &&
        !entry.scope.pairKey
    ) {
        result.valid = false;
        result.errors.push(
            '聊天作用域需要指定 pairKey'
        );
    }

    return result;
}

// ============================================================
// 对外导出
// ============================================================

export {
    normalizeText,
    normalizeFilterList,
    entryMatchesScope,
    entryMatchesCategories,
    entryIsExcludedByCategories,
    getSearchTerms,
    getMatchInfo,
    calculateEntryWeight,
    getEntryLength
};

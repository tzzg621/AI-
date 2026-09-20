// apps/textgame.js — 文游模块
//
// 导入外部的文游指令（剧本），以「剧本 + 剧本分支」的形式游玩。
//
// 三层实体（读代码前先看这三句）：
//   剧本 Script    = 导入的指令原文 + 元信息。自足，不引用模块外任何东西。
//   游玩 Playthrough = 引用一份剧本 + 一个**临时主角**（属于这一遍游玩，不出模块、不转正）+ 当前节点指针。
//   节点 Node      = 一轮（主角这次的输入 + AI 输出的原文）。**没有结构化状态对象**——状态就在那段文字里。
//
// 树：从任意节点都能再走一条（在同一父节点下挂新子节点）；前缀靠 parentId 共享、不复制；
// 旧枝一律不删，随时能切回去。「重生成」和「分叉」是同一个动作。
//
// 游玩页 = **一节一页**（2026-09-18 改；原来是把「根 → 当前」整条路径铺成一条长流）：
//   一页只放当前这一节，底部「接着走」列出它的**全部后续**（1 条也列，所以它本身就是顺序通读），
//   点一下进下一节。**往回走交给节点目录页**（🌳）。「翻页」与「跳转」是同一个动作——都是挪那个指针。
//   为什么改：长流里回看要滑很久；分支列表在卡底、展开还要往下滑；整张卡都是跳转热区，误触就新开一枝。
//
// 显示方式两种（**剧本级开关**，游玩页 ⋯ 菜单里就地切，默认自由）。两条路径各自独立，
// 唯一共用的是那份数据源（nodes.aiText 一份，画法每次渲染现算）：
//   普通 = **正常的文字格式 md 解析**：认得出是 HTML 的段先把标签剥掉（core 的 htmlToText），
//          剩下的字转义 + md 画——标签不会被亮出来；一个沙箱框都不建。
//          它自己的一层排版：每段首行缩进、标题与【…】/◈…◈ 这类标题栏居中（见 plainBodyHtml）。
//   自由 = **还原美化**：正文里的 HTML（美化格式的剧本会这么写）不转义、画进沙箱 iframe
//          （sandbox 不给 allow-scripts ⇒ 里面的 JS 不跑，且父页量得到内容高度所以不用内嵌滚动条）；
//          纯文本的节走 md + 认选项块。
//   **提示词一个字不改**——AI 吐不吐 HTML 是剧本说了算，这个开关只管「怎么画」；正文原文永远照旧落库。
//   两条路径都做的（与美化无关，是修 md-renderer 把 ``` 吞成 <code> 的 bug）：
//   正文里的 ``` 代码块（剧本普遍规定「状态面板写成代码块」）另画成面板块（见 bodyHtml）。
//
// 红线（AI/07）：全链路只出现「主角」「本局」「这一遍游玩」，不出现「用户 / 玩家 / 使用者」。
//   例外口径：剧本原文与 AI 输出里写的是「玩家」还是「主角」，**跟着剧本走**——
//   模块是平台、剧本是权威，不替剧本改名，也不算违规。

import { mdToHtml } from '../creator-space/md-renderer.js';
import { esc } from '../store/utils.js';
import { showAlert, showConfirm, showPrompt } from '../store/dialog.js';
import * as db from '../store/TextgameStore.js';
import {
    buildTurnPrompt, findOptionBlock, splitFences, htmlParts, looksLikeHtml, htmlToText, plainLayout,
    buildIndex, computePath, childrenOfNode, branchesAt, summarize,
    stepOf, foldableIds, collapsedExceptPath,
    PROMPT_BLOCKS, normalizePrompts,
    PRESET_WHERE, DEFAULT_PRESET_WHERE, BUILTIN_PACK, presetPackIdOf, presetIdsOf, presetWhereOf,
    presetPicksOf, presetIdsForPack, resolvePackEntries, packEntryPatch, isBuiltinEntryId,
    parsePresetText, PRESET_AI_PROMPT
} from './textgameCore.js';
import { callStoryAI, contextBudget, readTextFile } from './textgameAI.js';
// 开局可以「从名册挑一个主角」：名字与性别年龄**抄**下来（这一局自己的数据），
// 详细设定与秘密**引用**（存在名册里那一份，每轮现读）。读名册走 roleData 那一层，
// 别自己 JSON.parse localStorage——DataSync 之后那个键物理上在 IndexedDB 里。
import { loadCharacters, isArchived } from './roleData.js';

const id = 'textgame';
const label = '文游';
const icon = '📜';
const color = '#4E8A6B';

// ============================================================
// 模块内状态（不进路由栈，切换靠 rerender）
// ============================================================

const view = {
    page: 'list',        // list | script | play | dir（dir = 节点目录页）| presets（风格预设页）
    scriptId: null,
    playId: null,
    playFrom: 'script',  // 这一局是从哪一页点开的（list = 首页「继续游玩」那一行）——返回按它走
    importOpen: false,
    rosterOpen: false,   // 开局卡片里「从名册挑」那一栏
    textOpen: false,     // 剧本正文那一栏
    promptOpen: {},      // 两块提示词各自的展开状态：{ frame: bool, contract: bool }
    openPackId: null,    // 风格预设页：哪一份预设是展开的（折角展开，一次只开一份）；null = 都收着
    presetEditId: null,  // 展开的那一份里，哪一条在编辑（'new' = 新建那张卡）；null = 没有
    presetImportOpen: false,  // 预设页那张「整段粘贴/选文件」的卡（同首页的 view.importOpen）
    presetAiOpen: false,      // 预设页底部「给 AI 的格式说明」那个折角
    menuOpen: false,
    menuScroll: 0,       // 那个弹窗自己那条滚动面的位置：重画会换掉整个 DOM，不记就弹回顶
    menuAnim: false,     // 这次画的弹窗要不要播滑入动画（**只有刚打开那一次要**：勾一条就重画一次，
                         // 每次都播会一直抖。置位在开菜单那一处，画完就由 afterRender 清掉）
    collapsed: null      // 目录页收起来的节点 id（Set）；null = 这一局还没给过默认
};

const cache = {
    scripts: [],         // 剧本元信息（不含原文）
    plays: [],           // 全部游玩
    script: null,        // 当前剧本（含原文）
    play: null,          // 当前游玩
    nodes: [],           // 当前游玩的全部节点
    index: null,         // 节点索引（树在内存里拼）
    inflight: new Map(), // playId → { requestId, task }：生成中的那一次
    error: '',           // 游玩页的生成失败提示
    degraded: 0,         // 这一局上一次生成丢了几轮整轮（超预算降级）；切走时归零
    // ↓ 表单/输入框的内容：rerender 会重建 DOM，所以这些得留在内存里
    draft: '',           // 自由行动输入框
    importTitle: '',     // 导入表单：剧本名
    importText: '',      // 导入表单：原文
    heroName: '',        // 开局表单：主角名
    heroNote: '',        // 开局表单：主角设定
    heroRef: null,       // 开局表单：从名册挑来的那个角色 id（没有 = null）
    scriptDraft: null,   // 剧本正文：没保存的改动（null = 没动过，照记录里的显示）
    promptDraft: {},     // 两块提示词：没保存的改动，key 同 PROMPT_BLOCKS
    presets: [],         // 风格预设库：一份份预设 `{id, name, entries}`（内置那份改过才会在里面）
    // 风格预设：**正在编辑的那一条**（null = 没在编辑）。单槽，不是 {[id]: …} 的 map
    // ——同一时刻只有一张卡展开（同狼人杀那套规则面板）。新建与导入都只填这里，
    // **点保存才进库**，所以没保存就离开这一页 = 放弃框里的字（本模块既有口径）。
    presetDraft: null,
    // 整段导入那张卡：名字与原文。**原文只活在这里**——导入完成就清掉，
    // 库里那份预设上没有任何存它的地方（用户口径：「不留原件，后续修改全部都是项目中预设的方式」）。
    presetImportName: '',
    presetImportText: ''
    // （给 AI 的那段说明**不在这里**：它是 core 里那份常量，只读展示、整段复制走。
    //   想改就在复制出去的那边改——用户口径：「复制出去的话，可以在那边修改」。）
};

let pageGen = 0;
let currentContainer = null;
let scrollTo = 'bottom';   // 'bottom' | 'keep' | <nodeId>
const boundRoots = new WeakSet();
let toastEl = null;
let toastTimer = null;

// ============================================================
// 小工具
// ============================================================

function toast(message) {
    if (toastEl) toastEl.remove();
    if (toastTimer) clearTimeout(toastTimer);

    const el = document.createElement('div');
    el.className = 'tg-toast';
    el.textContent = message;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-show'));

    toastEl = el;
    toastTimer = setTimeout(() => {
        el.classList.remove('is-show');
        setTimeout(() => el.remove(), 220);
        toastEl = null;
        toastTimer = null;
    }, 2100);
}

function fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return `${d.getMonth() + 1}-${d.getDate()}`;
}

function fmtCount(n) {
    const v = Number(n) || 0;
    return v >= 10000 ? `${(v / 10000).toFixed(1)} 万字` : `${v} 字`;
}

function isAlive(gen) {
    return pageGen === gen && currentContainer && currentContainer.isConnected;
}

// ============================================================
// 数据
// ============================================================

async function reload() {
    cache.scripts = await db.listScripts();
    cache.plays = await db.listAllPlaythroughs();
    // 风格预设库：一处读、到处都有（预设页要画它，生成时要把这一局那份预设的条目拼进提示词）。
    // ⚠️ 读不到就 []：**生成绝不能因为预设读不到而失败**——那一局照旧跑得下去，只是少几条预设。
    cache.presets = await db.listPresets().catch(() => []);

    if (view.playId) {
        cache.play = await db.getPlaythrough(view.playId);
        if (cache.play) view.scriptId = cache.play.scriptId;
    }
    if (view.scriptId) {
        cache.script = await db.getScript(view.scriptId);
    }
    if (view.page === 'play' && view.playId) {
        cache.nodes = await db.listNodes(view.playId);
        cache.index = buildIndex(cache.nodes);
    }
}

async function goList() {
    view.page = 'list';
    view.scriptId = null;
    view.playId = null;
    view.collapsed = null;
    view.menuOpen = false;
    view.openPackId = null;
    view.presetEditId = null;
    cache.error = '';
    cache.draft = '';
    cache.degraded = 0;
    cache.presetDraft = null;
    // 导入卡里那两格也一并清掉：它们属于**这一页上正在做的事**，离开这一页就该结束（同 presetDraft）。
    // 留着上一次没导完的整段原文，下次进来一个不留神就导错了。
    cache.presetImportName = '';
    cache.presetImportText = '';
    await reload();
    scrollTo = 'top';
    rerender();
}

async function goScript(scriptId) {
    view.page = 'script';
    view.scriptId = scriptId;
    view.playId = null;
    view.collapsed = null;
    view.menuOpen = false;
    view.textOpen = false;
    view.promptOpen = {};
    view.openPackId = null;
    view.presetEditId = null;
    cache.error = '';
    cache.draft = '';
    cache.degraded = 0;
    cache.scriptDraft = null;
    cache.promptDraft = {};
    cache.presetDraft = null;
    // 导入卡里那两格也一并清掉：它们属于**这一页上正在做的事**，离开这一页就该结束（同 presetDraft）。
    // 留着上一次没导完的整段原文，下次进来一个不留神就导错了。
    cache.presetImportName = '';
    cache.presetImportText = '';
    await reload();
    scrollTo = 'top';
    rerender();
}

async function goPlay(playId) {
    view.playFrom = view.page;   // 记下进来的那一页：首页「继续游玩」和剧本详情里点开，都是这一条路进来的
    view.page = 'play';
    view.playId = playId;
    view.collapsed = null;   // 换一局就重新给目录页一次默认（只铺当前这条线）
    view.menuOpen = false;
    view.openPackId = null;
    view.presetEditId = null;
    cache.error = '';
    cache.draft = '';
    cache.degraded = 0;      // 那条提示说的必须是**这一局**的状态，不是上一局留下的
    cache.presetDraft = null;
    // 导入卡里那两格也一并清掉：它们属于**这一页上正在做的事**，离开这一页就该结束（同 presetDraft）。
    // 留着上一次没导完的整段原文，下次进来一个不留神就导错了。
    cache.presetImportName = '';
    cache.presetImportText = '';
    await reload();
    scrollTo = 'top';        // 一节一页：进这一局落在当前一节的开头
    rerender();
}

// 风格预设页：**只从首页进**（这一版）。返回靠 handleBack 的 else 分支 → goList()，零改动。
async function goPresets() {
    view.page = 'presets';
    view.scriptId = null;
    view.playId = null;
    view.collapsed = null;
    view.menuOpen = false;
    view.openPackId = null;
    view.presetEditId = null;
    cache.error = '';
    cache.draft = '';
    cache.degraded = 0;
    cache.presetDraft = null;
    // 导入卡里那两格也一并清掉：它们属于**这一页上正在做的事**，离开这一页就该结束（同 presetDraft）。
    // 留着上一次没导完的整段原文，下次进来一个不留神就导错了。
    cache.presetImportName = '';
    cache.presetImportText = '';
    await reload();
    scrollTo = 'top';
    rerender();
}

async function refreshPlay() {
    if (!view.playId) return;
    cache.play = await db.getPlaythrough(view.playId);
    cache.nodes = await db.listNodes(view.playId);
    cache.index = buildIndex(cache.nodes);
}

// ============================================================
// 生成流程
// ============================================================

/**
 * 一个原始动作，三种入口（继续 / 重生成 / 分叉）都走这里。
 * @param {object} input
 * @param {string|null} input.parentId 新节点挂在哪一座下面
 * @param {string} input.playerInput 这一步的行动（开场传空）
 * @param {'open'|'advance'} input.kind
 */
async function runTurn({ parentId, playerInput, kind = 'advance' }) {
    const play = cache.play;
    if (!play || !cache.script) return;
    if (cache.inflight.has(play.id)) return;   // 已经有一次在飞，别叠

    const mode = kind === 'open' ? 'open' : 'advance';
    const pathNodes = mode === 'open' ? [] : computePath(cache.index, parentId, play.rootNodeId);

    const prompt = buildTurnPrompt({
        scriptText: cache.script.text,
        protagonist: play.protagonist,
        // 引用来的那两截（详细设定 / 秘密）：**每轮现读角色卡**，读不到就整块不写
        protagonistRef: refOf(play),
        pathNodes,
        playerInput,
        mode,
        // 总上下文预算（含 system）：从默认预设现读，换模型/改上限下一轮就生效
        maxContextChars: contextBudget(),
        // 剧本级的两块提示词：**现读**，所以剧本页改完下一轮就生效（已经写出来的节不动）
        prompts: cache.script.prompts,
        // 风格预设：**记录里只存 id，文字每轮现读库**——所以预设页改完下一轮就生效。
        // 两个条件都满足才发：这一局选了这份预设（presetPackId）、这条在这一局是开着的（presetIds）。
        // 那份预设被删了 / 这一局没选 ⇒ packById 给 null ⇒ 一条都不发（逐字节等于没有这功能）。
        presetIds: presetIdsOf(play),
        presetPack: packById(presetPackIdOf(play))
    });

    cache.error = '';
    cache.draft = '';
    cache.degraded = prompt.meta.droppedTurns;

    const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

    // 先写票据再发请求：中途刷新/关页，回来才知道「上次那一步没写完」。
    const ticketed = await db.setPending(play.id, {
        requestId,
        parentNodeId: parentId || null,
        playerInput,
        kind,
        startedAt: Date.now()
    });
    if (ticketed) cache.play = ticketed;

    const task = (async () => {
        try {
            const text = await callStoryAI({
                messages: prompt.messages,
                label: `文游 · ${cache.script?.title || ''}`
            });
            return await db.commitTurn({
                playId: play.id,
                parentId: parentId || null,
                playerInput,
                aiText: text,
                kind,
                requestId
            });
        } finally {
            cache.inflight.delete(play.id);
        }
    })();

    cache.inflight.set(play.id, { requestId, task });
    rerender();   // 画出「正在续写」占位

    try {
        const result = await task;
        if (!result?.ok) {
            throw new Error(result?.reason === 'stale-pending'
                ? '这一步的结果已经过期了（可能另开了一个窗口在玩同一局）'
                : '这一步没能写进库里');
        }
        cache.play = result.play;
        cache.nodes = await db.listNodes(play.id);
        cache.index = buildIndex(cache.nodes);
    } catch (error) {
        // 失败不建节点，保留输入，给「重试」。
        // 让失败静默变成一轮空剧情是最糟的处理方式。
        cache.error = error?.message || String(error);
        cache.draft = playerInput || '';
        await refreshPlay().catch(() => {});
    }

    if (currentContainer?.isConnected) {
        if (view.page === 'play') {
            scrollTo = 'top';   // 一节一页：新的一节是一整页，从头读
            rerender();
        } else if (view.page === 'dir') {
            scrollTo = 'keep';  // 在目录里等着的时候写完了：把它重画出来（新的一节已经挂进树里），别把人拽走
            rerender();
        }
    }
}

// ============================================================
// 骨架
// ============================================================

function renderPage() {
    switch (view.page) {
        case 'script': return pageShellHtml('script', pageScriptHtml());
        case 'play': return pageShellHtml('play', pagePlayHtml());
        case 'dir': return pageShellHtml('dir', pageDirHtml());
        case 'presets': return pageShellHtml('presets', pagePresetsHtml());
        default: return pageShellHtml('list', pageListHtml());
    }
}

// data-tg-page 标记页面形态，供 textgame.css 用 :has() 在子页把整条全局返回栏 #topBar
// 让位（同 divination.css:1062 / bookClub.css 先例）——子页返回由页内自画的 ← 承担。
function pageShellHtml(page, inner) {
    return `<section class="screen-page tg-page" data-tg-page="${page}">${inner}</section>`;
}

function subnavHtml(title, note, actions = '') {
    return `
        <div class="tg-subnav">
            <button class="tg-icon-btn" data-action="back" title="返回">←</button>
            <div class="tg-subnav-main">
                <div class="tg-subnav-title">${esc(title)}</div>
                ${note ? `<div class="tg-subnav-note">${esc(note)}</div>` : ''}
            </div>
            ${actions}
        </div>
    `;
}

// ============================================================
// 页面 1：剧本库
// ============================================================

function pageListHtml() {
    const counts = new Map();
    for (const p of cache.plays) counts.set(p.scriptId, (counts.get(p.scriptId) || 0) + 1);

    const recent = cache.plays.slice(0, 5);

    return `
        <div class="screen-header">
            <div class="screen-title">文游</div>
            <!-- 两个按钮包在一个 .tg-row 里：.screen-header 是 space-between，直接并排塞两个
                 会变成「标题—预设—导入」三头分开，看着像三个不相干的角落。 -->
            <div class="tg-row">
                <button class="tg-head-btn" data-tg-act="open-presets">🎨 风格预设</button>
                <button class="tg-head-btn" data-tg-act="toggle-import">${view.importOpen ? '收起' : '＋ 导入'}</button>
            </div>
        </div>
        <div class="tg-scroll">
            ${view.importOpen ? importCardHtml() : ''}
            ${recent.length ? `
                <div class="tg-sec-title">继续游玩</div>
                <div class="tg-card tg-recent">
                    ${recent.map(p => resumeRowHtml(p)).join('')}
                </div>
            ` : ''}

            <div class="tg-sec-title">剧本库${cache.scripts.length ? `（${cache.scripts.length}）` : ''}</div>
            ${cache.scripts.length
                ? cache.scripts.map(s => scriptCardHtml(s, counts.get(s.id) || 0)).join('')
                : `<div class="tg-empty">还没有剧本。<br>把一份文游指令整段粘进来就能开始。</div>`}
        </div>
    `;
}

function importCardHtml() {
    return `
        <div class="tg-card tg-import">
            <input class="tg-in" data-tg-field="import-title" value="${esc(cache.importTitle || '')}"
                   placeholder="剧本名（留空就用文件名）" />
            <textarea class="tg-ta" data-tg-field="import-text"
                      placeholder="把文游指令整段粘到这里…">${esc(cache.importText || '')}</textarea>
            <div class="tg-row">
                <button class="tg-btn ghost" data-tg-act="pick-file">📄 选文件</button>
                <button class="tg-btn" data-tg-act="save-script">保存剧本</button>
            </div>
            <input type="file" accept=".txt,.md,.json,.docx,.doc,.rtf,text/plain" hidden data-tg-file />
            <div class="tg-hint">支持 .txt / .md / .docx（Word）——Word 里直接全选复制粘贴也行。旧版 .doc / .rtf 读不了，请先另存为 .docx。</div>
            <div class="tg-hint">导入后原文一字不改地留着——它就是这份剧本的最高权威。</div>
        </div>
    `;
}

/**
 * 「主角名 · 」这一截（**未转义的原文**，由调用方决定怎么落进 HTML：
 * resumeRowHtml 自己 esc，subnavHtml 内部会 esc）。
 * 主角可以留空（直接开场，身份由剧本开场自己定），空的时候整截不写——
 * 不然会剩一个孤零零的「·」挂在最前面。
 */
function whoPrefix(play) {
    const name = String(play?.protagonist?.name || '').trim();
    return name ? `${name} · ` : '';
}

function resumeRowHtml(play) {
    const script = cache.scripts.find(s => s.id === play.scriptId);
    return `
        <div class="tg-run" data-tg-act="open-play" data-play-id="${play.id}">
            <div class="tg-run-main">
                <div class="tg-run-name">${esc(script?.title || '（剧本已删）')}</div>
                <div class="tg-run-note">${esc(whoPrefix(play))}共 ${play.nodeCount || 0} 节${play.lastPreview ? ` · ${esc(summarize(play.lastPreview, 26))}` : ''}</div>
            </div>
            <div class="tg-run-go">继续 ›</div>
        </div>
    `;
}

function scriptCardHtml(script, playCount) {
    return `
        <div class="tg-card tg-script" data-tg-act="open-script" data-script-id="${script.id}">
            <div class="tg-script-title">${esc(script.title)}</div>
            <div class="tg-script-note">${fmtCount(script.charCount)}${playCount ? ` · 玩过 ${playCount} 局` : ''} · ${fmtDate(script.updatedAt)}</div>
        </div>
    `;
}

// ============================================================
// 页面 2：剧本详情 / 开局
// ============================================================

function pageScriptHtml() {
    const script = cache.script;
    if (!script) {
        return subnavHtml('剧本', '') + `<div class="tg-scroll"><div class="tg-empty">这份剧本不在了。</div></div>`;
    }

    const runs = cache.plays.filter(p => p.scriptId === script.id);

    return `
        ${subnavHtml(script.title, `${fmtCount(script.charCount)}${runs.length ? ` · 玩过 ${runs.length} 局` : ''}`, `
            <button class="tg-icon-btn" data-tg-act="rename-script" title="改名">✏️</button>
            <button class="tg-icon-btn" data-tg-act="delete-script" title="删除">🗑️</button>
        `)}
        <div class="tg-scroll">
            <div class="tg-card tg-start">
                <div class="tg-card-title">开始这一局</div>
                <input class="tg-in" data-tg-field="hero-name" value="${esc(cache.heroName || '')}"
                       placeholder="主角名字（留空 = 直接开场，主角由剧本定）" />
                <textarea class="tg-ta tg-ta-sm" data-tg-field="hero-note"
                          placeholder="主角设定：身份 / 处境 / 性格。剧本没规定就留空。">${esc(cache.heroNote || '')}</textarea>
                ${heroPickerHtml()}
                <button class="tg-btn" data-tg-act="start-play">${esc(startPlayLabel(cache.heroName))}</button>
                <div class="tg-hint">填了名字，这一局的主角就是它；留空就是直接开场——主角由剧本开场自己定（有些剧本会先问你的身份）。主角只属于这一遍游玩，跟手机里的主视角没有绑定。要真正生成开场，请到下一页点一下——不会自动烧调用。</div>
            </div>

            ${runs.length ? `
                <div class="tg-sec-title">这一本玩过的（${runs.length}）</div>
                ${runs.map(p => `
                    <div class="tg-card tg-run-card" data-tg-act="open-play" data-play-id="${p.id}">
                        <div class="tg-run-main">
                            <div class="tg-run-name">${esc(p.title)}</div>
                            <div class="tg-run-note">共 ${p.nodeCount || 0} 节 · ${fmtDate(p.updatedAt)}</div>
                        </div>
                        <button class="tg-icon-btn sm" data-tg-act="delete-play" data-play-id="${p.id}" title="删除这一局">🗑️</button>
                    </div>
                `).join('')}
            ` : ''}

            <div class="tg-sec-title">这一份发出去什么</div>
            ${scriptTextBlockHtml(script)}
            ${PROMPT_BLOCKS.map(b => promptBlockHtml(script, b)).join('')}
        </div>
    `;
}

/**
 * 系统提示词的「剧本正文」那一块。导入只是把文件内容倒进来（跟粘贴等效），
 * **之后改的就是这一份**——模块不存源文件、也不留「原稿 + 编辑稿」两份。
 * 没保存的改动搁在 cache.scriptDraft 上（重画不会丢字），保存走 saveScript，
 * charCount / preview 一并重算。改完对**下一轮**生成生效，已经写出来的节不动。
 */
function scriptTextBlockHtml(script) {
    const open = !!view.textOpen;
    const draft = cache.scriptDraft ?? script.text ?? '';
    return `
        <div class="tg-collapse">
            <button class="tg-collapse-head" data-tg-act="toggle-text">
                📄 剧本正文 · <span data-tg-len="script">${fmtCount(draft.length)}</span> ${open ? '▲' : '▼'}
            </button>
            ${open ? `
                <textarea class="tg-ta tg-ta-long" data-tg-field="script-text"
                          spellcheck="false">${esc(draft)}</textarea>
                <div class="tg-row">
                    <button class="tg-btn" data-tg-act="save-script-text">保存正文</button>
                </div>
                <div class="tg-hint">改完点保存才对下一轮生成生效（已经写出来的节不动）。没保存就离开这一页 = 放弃框里的字，正文还是库里那一份。</div>
            ` : ''}
        </div>
    `;
}

/**
 * 两块提示词各自的框。**一块只影响自己那一块**：开关和文字都只写自己那个 key，
 * 另一块的文字、它在 system 里的位置、开关状态，一概不动——system 是每次调用现拼的，
 * 没有任何一个「整体」被存下来或被编辑。
 *
 * 文字**与默认逐字相同（或全空白）就存成 ''**，也就是「从没动过」：模块以后改进默认文案，
 * 这一块还跟得上。这是「不存副本」的落点——记录里只存你真正改出来的那段字。
 */
function promptBlockHtml(script, block) {
    const spec = normalizePrompts(script.prompts)[block.key];
    const open = !!view.promptOpen[block.key];
    const draft = cache.promptDraft[block.key] ?? (spec.text || block.fallback);
    return `
        <div class="tg-collapse">
            <button class="tg-collapse-head" data-tg-act="toggle-prompt" data-prompt-key="${block.key}">
                🧩 ${esc(block.label)} · ${spec.on ? '注入' : '不注入'} ${open ? '▲' : '▼'}
            </button>
            ${open ? `
                <div class="tg-prompt">
                    <button class="tg-btn ghost sm" data-tg-act="toggle-inject" data-prompt-key="${block.key}">
                        ${spec.on ? '✅ 这一块注入' : '⬜ 这一块不注入'}
                    </button>
                    <textarea class="tg-ta tg-ta-long" data-tg-field="prompt-${block.key}"
                              spellcheck="false">${esc(draft)}</textarea>
                    <div class="tg-row">
                        <button class="tg-btn" data-tg-act="save-prompt" data-prompt-key="${block.key}">保存</button>
                        ${spec.text ? `<button class="tg-btn ghost" data-tg-act="reset-prompt" data-prompt-key="${block.key}">恢复默认</button>` : ''}
                    </div>
                    <div class="tg-hint">
                        装在 ${esc(block.where)}。${spec.text
                            ? '这一段是你改过的，模块以后怎么改默认都不会动它。'
                            : '这一段没改过——发的是模块当前的默认文案，模块以后改进它，这一块跟着走。'}
                        关掉开关只是不发它，框里的字留着。
                    </div>
                </div>
            ` : ''}
        </div>
    `;
}

/** 保存时到底往记录里写什么：空白的、或跟默认逐字相同 ⇒ 写 ''（= 从没动过） */
function promptsSaveValue(text, fallback) {
    const t = String(text ?? '');
    if (!t.trim()) return '';
    return t.trim() === fallback.trim() ? '' : t;
}

// ============================================================
// 风格预设页（从首页进）
// ============================================================
// 三层：**一份份预设**（一套方案）→ 每份里一串**条目**（`{ id, name, text, where }`）。
// 这一页管的是**预设本身**：建/删/改名，以及这份里条目的增删改、位置、顺序。
// 「这一局用哪一份、这份里哪几条开着」不在这儿——它在游玩页的 ⋯ 菜单里（一局一份、勾选跟着那一局走）。
//
// **顺序 = 条目在这份预设里的先后**（同一位置内部），页面上 ↑↓ 换的就是它，改完下一轮生成生效。
//
// 内置那一份（BUILTIN_PACK，id = 'builtin'）**不进数据库**：用户改了才存一份覆盖记录，
// 字段空 = 没改过 ⇒ 读的时候补回代码里的值（见 core 的 resolvePackEntries）。所以：
//   · 内置条目**删不掉**（想删就整份复制一份到自己这边删）——这条在 core 里是结构性的；
//   · 内置条目改坏了有「恢复默认」；整份都能改，没改过的部分一直跟着模块当前文案走。

/** 我的预设（库里除内置那份以外的），顺序就是页面上的先后 */
function myPacks() {
    return cache.presets.filter(p => p.id !== BUILTIN_PACK.id);
}

/** 库里那份内置的**覆盖记录**（没改过 = null）。要用它当前的样子一律走 builtinPackView() */
function storedBuiltinPack() {
    return cache.presets.find(p => p.id === BUILTIN_PACK.id) || null;
}

/** 内置那份当前该长什么样：覆盖层合回代码里的常量（没改过时就是常量本身） */
function builtinPackView() {
    const stored = storedBuiltinPack();
    if (!stored) return BUILTIN_PACK;
    return {
        id: BUILTIN_PACK.id,
        name: String(stored.name || '') || BUILTIN_PACK.name,
        entries: resolvePackEntries(stored)
    };
}

/**
 * 按 id 取一份**可直接用的**预设（条目补齐、内置那份合过覆盖层）——生成时用它。
 * 取不到（没选 / 那份被删了）给 null：调用方据此一条都不发。
 */
function packById(packId) {
    const key = String(packId || '');
    if (!key) return null;
    if (key === BUILTIN_PACK.id) return builtinPackView();
    const pack = myPacks().find(p => p.id === key);
    return pack ? { id: pack.id, name: pack.name, entries: resolvePackEntries(pack) } : null;
}

/** 写「我的」这一半（内置那份的覆盖记录原样留着，它不在这一半里） */
async function writeMyPacks(mine) {
    cache.presets = await db.savePresets([...mine, ...cache.presets.filter(p => p.id === BUILTIN_PACK.id)]);
}

/**
 * 写内置那一半的**覆盖层**：跟代码里的常量逐字相同的字段折成空（见 packEntryPatch）。
 * 整份都跟常量一模一样 ⇒ 连记录都不留（回到「没改过」），这样以后模块改进内置文案仍然跟得上。
 */
async function writeBuiltinPack(entries, name) {
    const patch = entries.map(packEntryPatch);
    const packName = String(name ?? BUILTIN_PACK.name).trim().slice(0, 40) || BUILTIN_PACK.name;
    const rest = cache.presets.filter(p => p.id !== BUILTIN_PACK.id);
    cache.presets = await db.savePresets(
        packName === BUILTIN_PACK.name && patch.every(p => !p.name && !p.text && !p.where)
            ? rest
            : [...rest, { id: BUILTIN_PACK.id, name: packName, entries: patch }]);
}

function pagePresetsHtml() {
    const mine = myPacks();
    const builtin = builtinPackView();
    // ⚠️ 顶栏挤进了第二个按钮（导入）：`.tg-subnav-main` 是 flex:1 + min-width:0、
    // 标题和 note 都带省略号，所以真挤不下时**先截的是那句 note**。`一局用一份` 挪到底部提示里了。
    return `
        ${subnavHtml(
            '风格预设',
            `我的 ${mine.length} 份`,
            `<button class="tg-head-btn" data-tg-act="toggle-import-pack">${view.presetImportOpen ? '收起' : '📥 导入'}</button>
             <button class="tg-head-btn" data-tg-act="new-pack">＋ 新建预设</button>`
        )}
        <div class="tg-scroll">
            ${view.presetImportOpen ? presetImportCardHtml() : ''}
            <div class="tg-sec-title">我的预设（${mine.length}）</div>
            ${mine.length
                ? mine.map(packHtml).join('')
                : '<div class="tg-empty">还没有自己的预设。点右上角「＋ 新建预设」；想照着内置那份改，就点开它、用「复制一份」。</div>'}
            <div class="tg-sec-title">内置</div>
            ${packHtml(builtin)}
            ${presetAiFoldHtml()}
            ${presetHintsHtml()}
        </div>
    `;
}

/**
 * 整段导入那张卡（照首页剧本导入那张 `.tg-card.tg-import`）。
 * 底下那行报账**随着打字实时更新**（`data-tg-import-report`，见 onRootInput）——
 * 识别成什么样在按下按钮之前就看得见，所以不用再单开一步「预览再确认」。
 */
function presetImportCardHtml() {
    const text = cache.presetImportText || '';
    const parsed = parsePresetText(text, cache.presetImportName, { maxTextLength: db.LIMITS.PRESET_TEXT });
    return `
        <div class="tg-card tg-import">
            <input class="tg-in" data-tg-field="preset-import-name" value="${esc(cache.presetImportName || '')}"
                   placeholder="预设名（留空就用文本第一行的 # 标题）" />
            <textarea class="tg-ta" data-tg-field="preset-import-text"
                      placeholder="把 AI 那一整段粘到这里…">${esc(text)}</textarea>
            <div class="tg-row">
                <button class="tg-btn ghost" data-tg-act="pick-file">📄 选文件</button>
                <button class="tg-btn" data-tg-act="import-pack">识别并导入</button>
            </div>
            <input type="file" accept=".txt,.md,.markdown,.json,.docx,.doc,.rtf,text/plain" hidden data-tg-file="preset-pack" />
            <div class="tg-hint" data-tg-import-report>${esc(presetImportReport(parsed, text))}</div>
            <div class="tg-hint">格式就三样：「# 预设名」一行、「## 条目名」一行、后面到下一个 ## 之前是这一条的正文（原样，不用转义、不用缩进）。想让某几条只在当前这一轮生效，在它们前面单独加一行「## 当前消息附带」；不写就全装在 system 末尾、按文本里的先后排。</div>
            <div class="tg-hint">导入之后跟这段原文再无关系：库里只留这一份预设（名字 + 条目），要改哪条都在预设页里改——原文不留，也没有「恢复成原文」这一说。自己手写的、AI 生成的都走这一条路。</div>
        </div>
    `;
}

/** 那行报账：识别到几条、两栏各几条、跳过了几行、有没有超长的（超了 store 那层会截断，先说清） */
function presetImportReport(parsed, text) {
    if (!String(text || '').trim()) return '还没内容：粘一整段进来，或者选一个文件。';
    if (!parsed.entries.length) return '还没认到条目——至少要有一行以 ## 开头的条目名。';
    const sys = parsed.entries.filter(e => presetWhereOf(e) === 'system').length;
    const bits = [
        `识别到「${parsed.name}」：${parsed.entries.length} 条`,
        `system 末尾 ${sys}`,
        `当前消息附带 ${parsed.entries.length - sys}`
    ];
    if (parsed.skipped) bits.push(`跳过 ${parsed.skipped} 行`);
    if (parsed.truncated) bits.push(`⚠️ ${parsed.truncated} 条超过 ${db.LIMITS.PRESET_TEXT} 字，落库时会被截断`);
    return bits.join(' · ');
}

/**
 * 底部那个折角：给外部 AI 的格式说明（core 里那份常量，见 PRESET_AI_PROMPT）。
 * 框**只读**：要改就复制出去在那边改（用户口径：「复制出去的话，可以在那边修改」）——
 * 于是这里没有草稿、没有「恢复默认」，这份说明永远是常量本身、也永远改不坏。
 * 用 readonly 的 textarea 而不是一块纯文字：`select()` 复制得上，还能滚、能挑一段选。
 */
function presetAiFoldHtml() {
    const open = !!view.presetAiOpen;
    return `
        <div class="tg-collapse">
            <button class="tg-collapse-head" data-tg-act="toggle-ai-prompt">
                🤖 让 AI 按这个格式写一套 ${open ? '▲' : '▼'}
            </button>
            ${open ? `
                <div class="tg-prompt">
                    <textarea class="tg-ta tg-ta-long" data-tg-field="preset-ai" readonly spellcheck="false">${esc(PRESET_AI_PROMPT)}</textarea>
                    <div class="tg-row">
                        <button class="tg-btn ghost sm" data-tg-act="copy-ai-prompt">📋 复制这段</button>
                    </div>
                    <div class="tg-hint">整段复制走，贴给外部 AI（它上面写了格式和三条硬要求），最后一段留给你写这一套要什么。框里改了没用——要改就在贴过去的那边改。</div>
                </div>
            ` : ''}
        </div>
    `;
}

/**
 * 一份预设。**一份 = 一张卡**：合着就是名字那一行，展开就在同一张卡里长出条目那一块
 * ——原来「一份一张卡 + 展开那一块再一张卡」是两张白框上下叠着，看着像两样东西。
 * 卡里那一行仍用 `.tg-run-card`（跟列表页的剧本行同一套写法），但它自己不是卡了，只是行。
 */
function packHtml(pack) {
    const open = view.openPackId === pack.id;
    const builtin = pack.id === BUILTIN_PACK.id;
    // 条数报**两个**：这份里有几条、其中几条装在 system 末尾——菜单里两栏就是这么分的
    const sysCount = pack.entries.filter(e => presetWhereOf(e) === 'system').length;
    return `
        <div class="tg-card">
            <div class="tg-run-card" data-tg-act="open-pack" data-pack-id="${esc(pack.id)}">
                <div class="tg-run-main">
                    <div class="tg-run-name">${builtin ? '🧩 ' : ''}${esc(pack.name || '（没名字）')} ${open ? '▲' : '▼'}</div>
                    <div class="tg-run-note">${pack.entries.length} 条 · ${sysCount} 条在 system 末尾${builtin ? ' · 可改，删不掉' : ''}</div>
                </div>
            </div>
            ${open ? packBodyHtml(pack) : ''}
        </div>
    `;
}

/**
 * 展开的那一份：操作行 + 按位置分两栏的条目（栏内顺序 = 注入顺序）。
 * ⚠️ 这一块**不是卡**（`.tg-pack-body` 没边框没底）：一份预设只有最上面那一行是卡，
 * 展开之后的条目是一条条挨着的行。原来这里再套一张卡、条目各套一张卡、编辑面板又套一张卡，
 * 四层边框叠在一起，字还没看边框先占满了。
 */
function packBodyHtml(pack) {
    const builtin = pack.id === BUILTIN_PACK.id;
    return `
        <div class="tg-pack-body">
            <div class="tg-row">
                <button class="tg-btn ghost sm" data-tg-act="new-entry" data-pack-id="${esc(pack.id)}">＋ 加一条</button>
                <button class="tg-btn ghost sm" data-tg-act="rename-pack" data-pack-id="${esc(pack.id)}">改名</button>
                ${builtin
                    ? '<button class="tg-btn ghost sm" data-tg-act="copy-pack" data-pack-id="builtin">复制一份</button>'
                    : `<button class="tg-btn ghost sm" data-tg-act="delete-pack" data-pack-id="${esc(pack.id)}">删掉这份预设</button>`}
            </div>
            ${view.presetEditId === 'new'
                ? entryEditorHtml(pack, true, null)
                : ''}
            ${PRESET_WHERE.map(w => entryGroupHtml(pack, w)).join('')}
        </div>
    `;
}

/** 一个位置一栏。栏内顺序 = 这份预设里的先后 = 拼进提示词的先后；跨栏不管顺序（两路不在同一个地方拼） */
function entryGroupHtml(pack, where) {
    const rows = pack.entries.filter(e => presetWhereOf(e) === where.key);
    return `
        <div class="tg-sec-title">${esc(where.label)}（${rows.length}）</div>
        ${rows.length
            ? rows.map((e, i) => `
                <div class="tg-entry">
                    ${entryRowHtml(pack, e, i, rows.length)}
                    ${view.presetEditId === e.id ? entryEditorHtml(pack, false, e) : ''}
                </div>
            `).join('')
            : `<div class="tg-empty">这一栏还是空的。上面「＋ 加一条」加一条，位置选「${esc(where.label)}」。</div>`}
    `;
}

/**
 * 一条：点这一行开/合编辑面板；↑↓ 在**同一栏内**换位。
 * 栏内第一条的 ↑、最后一条的 ↓ 置灰——按了没反应比按不动更让人犯嘀咕。
 * 内置条目没有 🗑（删不掉）：它那一格换成编辑面板里的「恢复默认」。
 * 点事件挂在**整行**上（不是只有中间那块字），两头的空白也算这一行；
 * ↑↓ 自带 data-tg-act，closest 从按钮往上找先撞到按钮自己，不会连点带开面板。
 */
function entryRowHtml(pack, entry, i, count) {
    const open = view.presetEditId === entry.id;
    const preview = summarize(entry.text, 22);   // summarize 自己会压平空白、剥掉记号
    return `
        <div class="tg-entry-row${open ? ' is-open' : ''}" data-tg-act="edit-entry" data-entry-id="${esc(entry.id)}">
            <div class="tg-run-main">
                <div class="tg-run-name">${esc(entry.name || '（没名字）')} ${open ? '▲' : '▼'}</div>
                <div class="tg-run-note">${esc(fmtCount(String(entry.text || '').length))} · ${esc(preview || '（空的）')}</div>
            </div>
            <button class="tg-icon-btn sm" data-tg-act="move-entry" data-entry-id="${esc(entry.id)}"
                    data-pack-id="${esc(pack.id)}" data-dir="-1" title="往前挪" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="tg-icon-btn sm" data-tg-act="move-entry" data-entry-id="${esc(entry.id)}"
                    data-pack-id="${esc(pack.id)}" data-dir="1" title="往后挪" ${i === count - 1 ? 'disabled' : ''}>↓</button>
        </div>
    `;
}

/**
 * 条目编辑面板。**同一个时刻只有一张卡在编辑态**（view.presetEditId），内容一律读 cache.presetDraft
 * ——点开的时候已经照条目抄进去了，所以这里不用再去看那一条（单槽草稿，不是 map）。
 * 新建与导入都只填草稿，**点保存才进库**；没保存就离开这一页 = 放弃框里的字（本模块既有口径）。
 */
function entryEditorHtml(pack, isNew, entry) {
    const d = cache.presetDraft || {};
    const where = d.where === 'current' ? 'current' : DEFAULT_PRESET_WHERE;
    const builtinEntry = !isNew && isBuiltinEntryId(entry?.id);
    const base = builtinEntry ? BUILTIN_PACK.entries.find(e => e.id === entry.id) : null;
    // 「恢复默认」只在真改过的时候给：没改过按了也是白按，多一个按钮反而要多想一秒
    const changed = base && (entry.name !== base.name || entry.text !== base.text || presetWhereOf(entry) !== presetWhereOf(base));
    return `
        <div class="tg-editor">
            <input class="tg-in" data-tg-field="preset-name" value="${esc(d.name || '')}"
                   placeholder="给这条起个名字（菜单里认的就是它）" />
            <textarea class="tg-ta tg-ta-long" data-tg-field="preset-text" spellcheck="false"
                      placeholder="这一段会原样拼进提示词。用事实陈述写要求，别写「你是一位……」那类角色扮演口径。">${esc(d.text || '')}</textarea>
            <div class="tg-row">
                ${PRESET_WHERE.map(w => `
                    <button class="tg-btn sm${where === w.key ? '' : ' ghost'}"
                            data-tg-act="set-preset-where" data-preset-where="${w.key}">${where === w.key ? '✅' : '⬜'} ${esc(w.label)}</button>
                `).join('')}
            </div>
            <div class="tg-row">
                ${isNew
                    ? `<button class="tg-btn ghost" data-tg-act="pick-file">📄 从文件导入</button>
                       <button class="tg-btn" data-tg-act="save-preset" data-pack-id="${esc(pack.id)}">存进这份预设</button>
                       <input type="file" accept=".txt,.md,.json,.docx,.doc,.rtf,text/plain" hidden data-tg-file="preset-entry" />`
                    : `<button class="tg-btn" data-tg-act="save-preset" data-pack-id="${esc(pack.id)}" data-entry-id="${esc(entry.id)}">保存</button>
                       ${builtinEntry
                            ? (changed ? `<button class="tg-btn ghost" data-tg-act="reset-entry" data-pack-id="${esc(pack.id)}" data-entry-id="${esc(entry.id)}">恢复默认</button>` : '')
                            : `<button class="tg-btn ghost" data-tg-act="delete-entry" data-pack-id="${esc(pack.id)}" data-entry-id="${esc(entry.id)}">删除</button>`}`}
            </div>
            <div class="tg-hint">${esc(presetWhereHint(where))}</div>
            <div class="tg-hint">${builtinEntry
                ? '这一条是模块自带的：改过的字段存下来（「恢复默认」就是把它退回去），没改过的仍然跟着模块以后改进的文案走。删不掉——想删就整份「复制一份」到自己的预设里改。'
                : '字数是这一条自己的，算在总上下文预算里。改完点保存才对下一轮生成生效，已经写出来的节不动。'}</div>
        </div>
    `;
}

/** 两个位置各自意味着什么——用户要判断的就是这一句，说得直白些 */
function presetWhereHint(where) {
    return where === 'current'
        ? '当前消息附带：接在主角这一轮的行动前面发出去，只影响这一轮。'
        : 'system 末尾：整段常驻，排在「输出约定」后面——系统提示词里最后被读到的就是它，跟剧本自己规定的篇幅 / 字段冲突时以它为准。';
}

function presetHintsHtml() {
    return `
        <div class="tg-hint">一份预设就是一套方案：这份里有哪些条目、各条写什么、装在哪、什么先后，都在展开的那一块里改。同一栏里谁在上面谁先被拼进去，↑↓ 调——顺序就是注入顺序。跨栏不管顺序：两个位置本来就不在同一个地方拼。</div>
        <div class="tg-hint">一局用一份：进一局之后点右上角 ⋯，先选这份预设，再勾这份里哪几条这一局开着。同一份剧本可以开好几局，各用各的预设、各勾各的条目。</div>
        <div class="tg-hint">从文件导入的只是那一段字，原件不存——之后改的就是预设里这一条（同剧本正文）。支持 .txt / .md / .docx。</div>
    `;
}

// ============================================================
// 页面 3：游玩
// ============================================================

function pagePlayHtml() {
    const play = cache.play;
    if (!play || !cache.index) {
        return subnavHtml('文游', '') + `<div class="tg-scroll"><div class="tg-empty">这一局不在了。</div></div>`;
    }

    const script = cache.script;
    // 当前这一节：路径末位就是它（computePath 自带「指针走丢时退回根」的兜底）
    const path = computePath(cache.index, play.currentNodeId, play.rootNodeId);
    const node = path.length ? path[path.length - 1] : null;
    const pending = play.pending;
    const flying = cache.inflight.has(play.id);
    // 这一节的后续正在写 / 没写完：占位卡只画在它该在的那一节上，别在别的节下面凭空冒出来
    const here = !!pending && (pending.parentNodeId || null) === (play.currentNodeId || null);

    return `
        ${subnavHtml(
            script?.title || '文游',
            // 只报「你在这」与「这一局有多少节」——不报全树几条岔路：
            // 那个数把已经走开的枝也算进去，跟你眼前看到的东西对不上（用户口径）
            `${whoPrefix(play)}第 ${path.length} 步 / 共 ${play.nodeCount || 0} 节`
                + `${pending && !here ? ' · ⏸ 有一步没写完' : ''}`,
            `${cache.index.total ? `<button class="tg-icon-btn" data-tg-act="open-dir" title="节点目录">🌳</button>` : ''}<button class="tg-icon-btn" data-tg-act="toggle-menu" title="这一局">⋯</button>`
        )}
        ${view.menuOpen ? playMenuHtml(play) : ''}
        <div class="tg-stream" data-tg-stream>
            ${cache.degraded > 0 ? `<div class="tg-note">剧情很长，发给 AI 的上下文里较早的 ${cache.degraded} 步已略去（不影响你看到的记录）。</div>` : ''}
            ${node ? currentTurnHtml(node, play) : emptyStreamHtml(flying)}
            ${node ? nextHtml(play, node) : ''}
            ${here ? (flying ? busyCardHtml(pending) : stuckCardHtml()) : ''}
        </div>
        <div class="tg-composer">
            ${cache.error ? `
                <div class="tg-error">
                    <div class="tg-error-text">${esc(cache.error)}</div>
                    <button class="tg-btn sm" data-tg-act="retry">🔄 重试这一步</button>
                </div>
            ` : ''}
            ${node ? composerHtml(play, flying) : openButtonHtml(flying)}
        </div>
    `;
}

/**
 * ⋯ 菜单 = **从右边滑进来的抽屉**（照模拟小城点头像那个：遮罩 + 右对齐整高面板 +
 * 头一行标题与 ✕ + 内容区自己滚）。原来是在正文之上顶出一条内联面板：加了风格预设
 * 那一区之后内容接近两屏，内联那条再怎么限高都得滚，还把正文挤成一条缝。
 * DOM 还是画在 .tg-page 里（事件委托照旧），靠绝对定位浮到整屏之上。
 * 关掉的三条路：点遮罩、点 ✕、按 ←（handleBack 先关它）。
 */
function playMenuHtml(play) {
    // 原来那项「回到剧本与原文」撤了：顶栏 ← 本来就回剧本页，原文在那一页上有开关
    const free = isFree();
    // 这一局引用的那个角色：还在 = 报一下每轮会带上哪两截；被彻底删了 = 说清那不发了
    const ref = refOf(play);
    const refLine = !play.protagonist?.ref ? ''
        : ref.name
            ? `📌 主角引用：${esc(ref.name)} 的详细设定与秘密（每轮现读角色卡——你改角色卡，这一局之后每一轮跟着变；已经写出来的节不动）。`
            : `📌 主角引用：那个角色已经不在了，引用那两截不再发出去（开局抄下的名字与设定还在）。`;
    return `
        <div class="tg-modal${view.menuAnim ? ' is-anim' : ''}" data-tg-act="close-menu">
            <div class="tg-menu">
                <div class="tg-menu-head">
                    <div class="tg-menu-title">这一局</div>
                    <button class="tg-icon-btn" data-tg-act="toggle-menu" title="关上">✕</button>
                </div>
                <div class="tg-menu-body" data-tg-menu-body>
                    <button class="tg-menu-item" data-tg-act="rename-play">✏️ 改这一局的名字</button>
                    <button class="tg-menu-item" data-tg-act="toggle-free">${free ? '✅' : '⬜'} 自由模式：正文当 HTML 画</button>
                    <div class="tg-menu-note">普通模式按纯文字排版；自由模式把正文里的 HTML 画进沙箱（脚本不执行）。</div>
                    ${refLine ? `<div class="tg-menu-note">${refLine}</div>` : ''}
                    ${presetMenuHtml(play)}
                    <button class="tg-menu-item danger" data-tg-act="delete-play" data-play-id="${play.id}">🗑️ 删掉这一局</button>
                </div>
            </div>
        </div>
    `;
}

/**
 * ⋯ 菜单里的风格预设那一区。**一局用一份**，所以这里是两步：
 *   ① 选这份预设（含「不用预设」）——**选一份就把它的条目全开**（要的就是「换到这套方案」）；
 *   ② 在这一份里勾哪几条这一局开着——栏内按这份预设里的先后列，勾中的带 ✅。
 * 两步都不关菜单（连勾几条是常态，见 pickPack / togglePreset）。
 * 条目本身（内容、位置、先后）在这儿改不了——那些在首页的「🎨 风格预设」里。
 *
 * ①那一步是**一行 chips**（原来是每份一卡、两行字：三五份就把菜单顶掉半屏，还挨着正文容易点错）。
 * 「这份里有几条」那种计数一律不写：条目就在下面列着，数一遍没有信息量。
 */
function presetMenuHtml(play) {
    const packs = [...myPacks(), builtinPackView()];
    const chosenId = presetPackIdOf(play);
    const chosen = packById(chosenId);
    const picked = new Set(presetIdsOf(play));
    // 选的那份已经不在了（被删了）：勾选记录留着（不回头改游玩记录），但要说清它不再发出去
    const gonePack = !!chosenId && !chosen;

    const chooser = `
        <div class="tg-picks">
            <button class="tg-chip${chosen ? '' : ' is-on'}" data-tg-act="pick-pack">不用预设</button>
            ${packs.map(p => `
                <button class="tg-chip${chosenId === p.id ? ' is-on' : ''}"
                        data-tg-act="pick-pack" data-pack-id="${esc(p.id)}"
                        title="${esc(p.name || '（没名字）')}"
                >${p.id === BUILTIN_PACK.id ? '🧩 ' : ''}${esc(p.name || '（没名字）')}</button>
            `).join('')}
        </div>
    `;

    // 选中的那份里，按位置分两栏（跨栏不管顺序：两路本来就不在同一个地方拼）
    const sections = !chosen ? '' : PRESET_WHERE.map(w => {
        const rows = chosen.entries.filter(e => presetWhereOf(e) === w.key);
        if (!rows.length) return '';
        return `
            <div class="tg-menu-note">${esc(w.label)}</div>
            <div class="tg-pick">
                ${rows.map(e => `
                    <button class="tg-pick-item${picked.has(e.id) ? ' is-on' : ''}"
                            data-tg-act="toggle-preset" data-entry-id="${esc(e.id)}">
                        <span class="tg-pick-name">${picked.has(e.id) ? '✅' : '⬜'} ${esc(e.name || '（没名字）')}</span>
                        <span class="tg-pick-desc">${esc(summarize(e.text, 20))}</span>
                    </button>
                `).join('')}
            </div>
        `;
    }).join('');

    const tail = !chosen
        ? `<div class="tg-menu-note">${gonePack
            ? '这一局原来选的那份预设已经不在了，不再发出去（选与勾的记录都留着）。'
            : '还没选预设：这条一局什么都不发。'}</div>`
        : `<div class="tg-menu-note">顺序 = 拼进提示词的先后；system 末尾那几条最后被读到、压过输出约定。${
            picked.size ? '' : '（这份里一条都没勾，等于没选。）'}</div>`;

    return `
        <div class="tg-menu-note">🎨 风格预设 · 一局用一份（改条目在首页）</div>
        ${chooser}
        ${sections}
        ${tail}
    `;
}

function emptyStreamHtml(flying) {
    if (flying) return '';
    return `<div class="tg-empty">这一局还没开场。<br>点下面的按钮生成开场——会消耗一次 AI 调用。</div>`;
}

/**
 * 这个剧本是不是自由模式。**默认是**：老剧本记录里没有这个字段，也按开算——
 * 美化格式的剧本一进来就该是画好的样子。普通模式 = 正常的文字格式 md 解析（HTML 标签剥掉），
 * 不是「看原文」那一档。
 */
function isFree() {
    return cache.script?.freeMode !== false;
}

/**
 * 正文渲染（两种显示方式都走这里）。按 ``` 围栏切段——栏外各画各的（自由：md + 认选项块；
 * 普通：认得出是 HTML 的先剥掉标签、再按 plainLayout 分段画），栏内画成面板块。
 * 不能整段直接 mdToHtml：剧本普遍要求状态面板写成 markdown 代码块，而 md-renderer
 * 没有围栏概念，会把整段面板吞成 <code>，还在前后留一串裸 ```。
 * 口径：正文一律保留在原处、不剥离——面板照旧是正文的一部分，只是换了画法
 * （普通模式剥的是标签这种格式记号，不是正文本身）。
 * 别写成 <pre><code>：`.tg-turn-body code` 会给它套上灰底和小内边距，面板对齐会散。
 * 切分逻辑留在零 import 的 textgameCore.js（A 段要在 Node 里直跑），这里只管画。
 */
function bodyHtml(aiText) {
    const free = isFree();
    // 两条路径各走各的、互不调用。自由模式多的一件事：这一节里真有 HTML 就交给沙箱还原美化。
    if (free) {
        const html = freeHtml(aiText);
        if (html) return html;
    }
    return splitFences(aiText).map(seg => (
        seg.kind === 'fence'
            ? `<div class="tg-panel"><pre>${esc(seg.text)}</pre></div>`
            : (free ? textHtml(seg.text) : plainBodyHtml(seg.text))
    )).join('');
}

/**
 * 普通模式的栏外正文（自由模式那条走 textHtml，两条互不调用）。
 * 排版的判断——哪几行合成一段、哪一行是标题栏——在 core 里算好（plainLayout），这里只管画：
 * 标题栏单独成格（缩进与居中写在 CSS 里，只落普通这一档），其余逐格交给 mdToHtml。
 * mdToHtml 自己 esc 一次，别双转义。
 */
function plainBodyHtml(text) {
    return plainLayout(plainText(text)).map(part => (
        part.kind === 'banner'
            ? `<div class="tg-banner">${esc(part.text)}</div>`
            : mdToHtml(part.text)
    )).join('');
}

/**
 * 普通模式交给渲染层的那段字：认得出是 HTML 就先把标签剥掉（md 认得的记号照旧解析，不丢）；
 * 剥光了（只剩图片之类）退回原样——宁可难看，也别给一屏空白。
 * 「像不像 HTML」跟自由模式用的是同一个判断（同一个问题不问两遍）；剥，是普通模式自己的步骤。
 */
function plainText(text) {
    if (!looksLikeHtml(text)) return text;
    return htmlToText(text) || text;
}

// 沙箱文档的底子：iframe 里没有外面的样式，字体/行距得自带一份，跟 .tg-turn-body 对齐
const FREE_STYLE = `<style>
html,body{margin:0;padding:0;background:transparent}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
     font-size:15px;line-height:1.85;color:#2f2f33;letter-spacing:.01em;word-break:break-word}
.tg-raw{white-space:pre-wrap}
img{max-width:100%;height:auto}
table{max-width:100%}
</style>`;

/**
 * 自由模式：一节里有 HTML（或围栏声明了 html），就整节交给沙箱 iframe。
 * 沙箱 `allow-same-origin` 但**不给 allow-scripts**：里面的 JS 一个字都跑不了（实测过），
 * 而父页读得到 contentDocument ⇒ 能量出内容多高、把框撑到刚好——一节一页的滚动流里
 * 不许再套第二个滚动条。量不到就退回 CSS 里的兜底高度。
 * **提示词一个字没改**：AI 吐不吐 HTML 是剧本说了算，这个开关只管「怎么画」。
 */
function freeHtml(aiText) {
    const parts = htmlParts(aiText);
    if (!parts.some(p => p.kind === 'html')) return '';
    const doc = parts
        .map(p => (p.kind === 'html' ? p.text : `<div class="tg-raw">${esc(p.text)}</div>`))
        .join('\n');
    return `<iframe class="tg-free" data-tg-free sandbox="allow-same-origin"
        srcdoc="${esc(FREE_STYLE + doc)}"></iframe>`;
}

/** 沙箱框上一次量到的高度（键 = 那一节的 node id）：整页重画时先按它画，见 fitFreeFrames */
let frameHeight = { nodeId: null, height: 0 };

/** 重画**之前**把当前那个框的高度记下来（只有当前这一节有框，见 bodyHtml 的调用点） */
function rememberFrameHeight() {
    const box = currentContainer?.querySelector('[data-tg-free]');
    const turn = box?.closest('.tg-turn');
    if (box && turn) frameHeight = { nodeId: turn.dataset.nodeId, height: box.offsetHeight };
}

/**
 * 把每个沙箱框撑到它内容的高度。
 * srcdoc 是**异步**加载的：刚画完那一刻 contentDocument 还是空白页（量出来 0），所以
 * 除了当场量一次，还要挂一次 load；空白页那一下直接跳过，别把框压成 0 高。
 * 撑高之后如果原本就贴着底，跟着挪到底——不然新生成的那一节会有一部分藏在折叠线下面。
 */
function fitFreeFrames(root) {
    for (const box of root.querySelectorAll('[data-tg-free]')) {
        // 先把**上一次量到的高度**按上去（同一节才认）：框是重建的、srcdoc 是异步加载的，
        // 不先按旧高度画的话，它会先塌成 CSS 兜底那 120px、再弹回真高度——那个「塌一下」
        // 就是整页重画时正文闪的来源。按上去之后下面还是会再量一次校正。
        const turn = box.closest('.tg-turn');
        if (turn && turn.dataset.nodeId === frameHeight.nodeId && frameHeight.height > 20) {
            box.style.height = `${frameHeight.height}px`;
        }
        const fit = () => {
            let h = 0;
            try {
                const d = box.contentDocument;
                if (!d || !d.body) return;
                h = Math.max(d.body.scrollHeight, d.documentElement.scrollHeight);
            } catch { return; }        // 读不到就吃 CSS 里的兜底高度，不弹错
            if (h < 20) return;

            const area = scroller();
            const atBottom = !!area && area.scrollHeight - area.scrollTop - area.clientHeight < 8;
            box.style.height = `${h}px`;
            if (atBottom) area.scrollTop = area.scrollHeight;
        };
        box.addEventListener('load', fit);
        fit();
    }
}

/**
 * 栏外正文：认出的选项块加一层样式，其余照旧走 mdToHtml。
 * **只换画法、不加任何能点的东西**——选哪条还是自己往底部输入框里打（用户口径）：
 * 做成按钮会与正文里那几行前后重复，回看旧节时还要额外算「那些按钮算谁的」。
 * 原文一字不删：区间里的行原样吐出来，只是包了一层容器。
 */
function textHtml(text) {
    const blk = findOptionBlock(text);
    if (!blk) return mdToHtml(text);   // mdToHtml 自己 esc 一次，别再套一层

    const lines = text.split('\n');
    const optAt = new Map(blk.options.map(o => [o.line, o]));
    const inner = lines.slice(blk.start, blk.end + 1).map((ln, i) => {
        const no = blk.start + i;
        if (optAt.has(no)) return `<div class="tg-choice-row">${esc(ln.trim())}</div>`;
        // 块里除选项外只剩它自己那句「选择」小标题（块首可能是空行，所以不能钉在第一行）
        if (ln.trim()) return `<div class="tg-choice-head">${esc(ln.trim())}</div>`;
        return '';                     // 空行交给容器自己的间距，不再逐行留白
    }).join('');

    return mdToHtml(lines.slice(0, blk.start).join('\n'))
        + `<div class="tg-choice">${inner}</div>`
        + mdToHtml(lines.slice(blk.end + 1).join('\n'));
}

/**
 * 当前这一节（一节一页 = 整页只有它）。不带跳转——它就是你所在的那一节，点它没有意义。
 * 版式跟着显示方式走（用户 2026-09-19 口径）：**普通模式留卡片的形，自由模式脱壳**。
 * 分法不是审美——**卡片的价值是「给没有边界的内容一个边界」**：自由模式那份美化内容是
 * **剧本自己画的**（自带圆角 / 边框 / 底色 / 投影），模块再套一层就是叠着的第二个框，
 * 还白丢约 30px 宽；普通模式是模块自己画的纯文字，一个框都没有，卡片是它唯一的边界。
 * 所以这里只差一个 is-plain。
 */
function currentTurnHtml(node, play) {
    const name = play.protagonist?.name || '主角';

    return `
        <div class="tg-turn is-current${isFree() ? '' : ' is-plain'}" data-node-id="${node.id}">
            <div class="tg-turn-head">
                <span class="tg-turn-no">${stepOf(cache.index, node.id)}</span>
                ${node.playerInput
                    ? `<span class="tg-turn-input">〔${esc(name)}〕${esc(node.playerInput)}</span>`
                    : `<span class="tg-turn-input is-open">开场</span>`}
            </div>
            <div class="tg-turn-body">${bodyHtml(node.aiText)}</div>
        </div>
    `;
}

/**
 * 「接着走」：当前这一节的**全部后续**，1 条也列出来。
 * 只 1 条时它就是「下一节」——所以这一页本身就是顺序通读，不需要另做一个通读页。
 * 点进去的是**那一条的第一个节点**（要的是「读下一节」）；想直接落到某条旧枝的末端（回去接着玩），
 * 走目录页点那一行。
 */
function nextHtml(play, node) {
    const list = branchesAt(cache.index, node.id);
    if (!list.length) return '';

    const name = play.protagonist?.name || '主角';
    const many = list.length > 1;
    const step = id => stepOf(cache.index, id);

    return `
        <div class="tg-branches">
            <div class="tg-branches-head">${many ? `从这里分出去的 ${list.length} 条路：` : '接着走：'}</div>
            ${list.map(b => {
                const child = b.first;
                const done = child.playerInput ? `〔${esc(name)}〕${esc(child.playerInput)}` : '开场';
                return `
                    <button class="tg-branch" data-tg-act="jump" data-node-id="${child.id}">
                        <span class="tg-branch-name">${many ? `支线 ${b.index} · 第 ${step(child.id)} 步` : `第 ${step(child.id)} 步`}</span>
                        <span class="tg-branch-tail">${done} · ${esc(summarize(child.aiText, 24))}</span>
                    </button>
                `;
            }).join('')}
        </div>
    `;
}

function busyCardHtml(pending) {
    const action = pending?.playerInput ? summarize(pending.playerInput, 20) : '开场';
    return `
        <div class="tg-turn is-busy">
            <div class="tg-turn-head"><span class="tg-turn-no">✍️</span><span class="tg-turn-input">${esc(action)}</span></div>
            <div class="tg-busy"><span class="tg-dots"></span> 正在续写…</div>
            <div class="tg-hint">可以离开这一页，写完会自动收进这一局。</div>
        </div>
    `;
}

function stuckCardHtml() {
    return `
        <div class="tg-turn is-stuck">
            <div class="tg-busy">⏸ 上次那一步没写完</div>
            <div class="tg-row">
                <button class="tg-btn sm" data-tg-act="retry">🔄 重试那一步</button>
                <button class="tg-btn sm ghost" data-tg-act="drop-pending">丢掉</button>
            </div>
        </div>
    `;
}

function openButtonHtml(flying) {
    return flying ? '' : `<button class="tg-btn" data-tg-act="open-scene">▶️ 生成开场</button>`;
}

function composerHtml(play, flying) {
    // 底部只有自由输入：认出的选项在正文里加样式，不做按钮（用户口径）
    return `
        <div class="tg-input-row">
            <input class="tg-in tg-action" data-tg-field="draft" value="${esc(cache.draft || '')}"
                   placeholder="主角要做什么…" ${flying ? 'disabled' : ''} />
            <button class="tg-send" data-tg-act="send" ${flying ? 'disabled' : ''}>→</button>
        </div>
    `;
}

// ============================================================
// 页面 4：节点目录（整棵树的折角大纲，点一行跳过去）
//
// 这是一节一页之后「往回走」的唯一通道：观看时只看得到当前这一节，
// 想回旧枝、想去别的分叉，都从这里走。
// 缩进靠**嵌套**出来的（.tg-node-kids 的 margin-left），不是 depth 内联样式：
// 嵌套天然带树线，也没有层级上限。
// ============================================================

const MAX_INDENT = 6;   // 再往里就不再套缩进：手机屏上缩到第 7 层就只剩一条缝

/** 当前这条路径上的节点 id（目录页的「默认铺开哪条线」和「你在这」都靠它） */
function pathIdsOf() {
    if (!cache.index || !cache.play) return new Set();
    return new Set(computePath(cache.index, cache.play.currentNodeId, cache.play.rootNodeId).map(n => n.id));
}

function openDir() {
    if (!cache.play || !cache.index) return;
    const onPath = pathIdsOf();

    if (!view.collapsed) {
        // 这一局头一次开目录：只铺当前这条线，别的枝收起来
        view.collapsed = collapsedExceptPath(cache.index, onPath);
    } else {
        // 之后每次打开：把你现在所在的这条线铺开，其余保持你手动调的样子
        for (const id of onPath) view.collapsed.delete(id);
    }

    view.page = 'dir';
    view.menuOpen = false;
    scrollTo = cache.play.currentNodeId || 'top';   // 打开就把「你在这」那一行滚进视野
    rerender();
}

function pageDirHtml() {
    const play = cache.play;
    if (!play || !cache.index) {
        return subnavHtml('文游', '') + `<div class="tg-scroll"><div class="tg-empty">这一局不在了。</div></div>`;
    }

    const collapsed = view.collapsed || new Set();
    const onPath = pathIdsOf();
    const folds = foldableIds(cache.index);
    const allFolded = folds.length > 0 && folds.every(id => collapsed.has(id));

    return `
        ${subnavHtml(
            '节点目录',
            `第 ${onPath.size} 步 / 共 ${cache.index.total} 节`,
            `<button class="tg-head-btn" data-tg-act="fold-all">${allFolded ? '全部展开' : '全部收起'}</button>`
        )}
        <div class="tg-scroll">
            <div class="tg-note">点一行就跳到那一节（跳完回游玩页）。缩进 = 分叉出去的枝。</div>
            <div class="tg-dir">${dirRowsHtml('', 0, play, collapsed, onPath)}</div>
        </div>
    `;
}

function dirRowsHtml(parentId, depth, play, collapsed, onPath) {
    return childrenOfNode(cache.index, parentId).map(node => {
        const kids = childrenOfNode(cache.index, node.id);
        const folded = collapsed.has(node.id);
        const row = nodeRowHtml(node, kids.length, folded, onPath, play);
        if (!kids.length || folded) return `<div class="tg-node">${row}</div>`;

        const inner = dirRowsHtml(node.id, depth + 1, play, collapsed, onPath);
        return `<div class="tg-node">${row}${depth + 1 <= MAX_INDENT ? `<div class="tg-node-kids">${inner}</div>` : inner}</div>`;
    }).join('');
}

function nodeRowHtml(node, kidCount, folded, onPath, play) {
    const name = play.protagonist?.name || '主角';
    const isCurrent = node.id === play.currentNodeId;

    return `
        <div class="tg-node-row${isCurrent ? ' is-current' : ''}${onPath.has(node.id) ? ' is-path' : ''}"
             data-tg-act="jump" data-node-id="${node.id}">
            ${kidCount
                // 折角用 data-fold-id 而不是 data-node-id：行本身已经占了 data-node-id，
                // 定位（scrollIntoView）拿的是第一个匹配，两个同名会打架
                ? `<button class="tg-node-fold" data-tg-act="fold-node" data-fold-id="${node.id}"
                        aria-expanded="${folded ? 'false' : 'true'}"
                        aria-label="${folded ? '展开这节下面的' : '收起这节下面的'}">${folded ? '▸' : '▾'}</button>`
                : `<span class="tg-node-fold is-leaf"></span>`}
            <span class="tg-node-main">
                <span class="tg-node-head">
                    <span class="tg-node-no">第 ${stepOf(cache.index, node.id)} 步</span>
                    ${kidCount > 1 ? `<span class="tg-node-fork">⑂ ${kidCount}</span>` : ''}
                    ${isCurrent ? `<span class="tg-node-here">你在这</span>` : ''}
                </span>
                <span class="tg-node-input">${node.playerInput ? `〔${esc(name)}〕${esc(node.playerInput)}` : '开场'}</span>
                <span class="tg-node-tail">${esc(summarize(node.aiText, 40))}</span>
            </span>
        </div>
    `;
}

// ============================================================
// 渲染 / 绑定 / 返回
// ============================================================

/** 当前页的滚动容器（游玩页是 .tg-stream，其余页是 .tg-scroll） */
function scroller() {
    if (!currentContainer) return null;
    return currentContainer.querySelector('[data-tg-stream]') || currentContainer.querySelector('.tg-scroll');
}

function rerender() {
    if (!currentContainer || !currentContainer.isConnected) return;
    const box = scroller();
    const keepTop = box ? box.scrollTop : 0;
    // 弹窗自己有另一条滚动面（不在 scroller() 上），同样量一下（见 afterRender）
    view.menuScroll = currentContainer.querySelector('[data-tg-menu-body]')?.scrollTop || 0;
    // 正文那个沙箱框量到的高度也得先记下来：重画会把框整个重建（见 fitFreeFrames 开头）
    rememberFrameHeight();

    pageGen += 1;
    currentContainer.innerHTML = renderPage();
    bindEvents(currentContainer, {});
    afterRender(keepTop);
}

/**
 * 只重画 ⋯ 菜单那一块，**正文一个节点都不碰**。
 * 为什么单开这一条：自由模式的正文是一串 srcdoc 沙箱框，整页重画 = 全部拆了重建，
 * 框会先按 CSS 兜底高度画出来、等 srcdoc 加载完再撑开——看上去就是「正文闪一下、跳一下」。
 * 而菜单里的选/勾是这个功能里最高频的动作，所以那一路只换菜单这个节点。
 * 事件委托挂在 .tg-page 上（根节点没换），所以不用重新 bindEvents。
 */
function rerenderMenu() {
    const host = currentContainer?.querySelector('.tg-modal');
    if (!host || !view.menuOpen) { rerender(); return; }

    const body = host.querySelector('[data-tg-menu-body]');
    const keep = body ? body.scrollTop : (view.menuScroll || 0);

    host.outerHTML = playMenuHtml(cache.play);   // ⚠️ 这一行之后 host 已经是游离节点，别再碰它

    const next = currentContainer.querySelector('[data-tg-menu-body]');
    if (next) next.scrollTop = keep;
    view.menuScroll = keep;
}

/**
 * 重画之后把滚动位置摆回去。
 * `keepTop` 是重画**之前**量到的 scrollTop —— `'keep'` 就靠它：重画会把滚动容器整个换掉
 * （新元素的 scrollTop 从 0 开始），不还回去的话，每次开关菜单/折角/折叠原文都会弹回页首。
 * `null` = 首次进模块（render 那条路），不用管。
 */
function afterRender(keepTop = null) {
    if (!currentContainer) return;
    fitFreeFrames(currentContainer);
    const box = scroller();

    if (box) {
        if (scrollTo === 'keep') {
            if (keepTop !== null) box.scrollTop = keepTop;
        } else if (scrollTo === 'top') {
            box.scrollTop = 0;
        } else if (scrollTo === 'bottom') {
            box.scrollTop = box.scrollHeight;
        } else if (typeof scrollTo === 'string') {
            const card = box.querySelector(`[data-node-id="${scrollTo}"]`);
            if (card) card.scrollIntoView({ block: 'start' });
        }
    }

    // ⋯ 菜单那个弹窗：它自己一条滚动面，位置记在 view.menuScroll 上。
    // 勾条目 / 换预设都会重画，不还回去的话每勾一条就弹回顶部（那是这个菜单里最高频的动作）。
    if (view.menuOpen) {
        const menu = currentContainer.querySelector('[data-tg-menu-body]');
        if (menu) menu.scrollTop = view.menuScroll || 0;
    }
    view.menuAnim = false;   // 上面那一笔画完，动画的标记就作废（下一次重画不该再播一遍）

    scrollTo = 'keep';
}

export function render(context = {}) {
    currentContainer = document.getElementById('pageContainer');
    const gen = pageGen + 1;
    pageGen = gen;

    // 先用手里的数据画（首次进模块就是骨架），取完数再画一遍
    void (async () => {
        try {
            await reload();
        } catch (error) {
            console.error('[textgame] 取数失败', error);
        }
        if (!isAlive(gen)) return;
        currentContainer.innerHTML = renderPage();
        bindEvents(currentContainer, context || {});
        afterRender();
    })();

    return renderPage();
}

export function handleBack(container, context = {}) {
    currentContainer = container || currentContainer;

    // 弹窗开着就先关弹窗：它浮在最上面，一层一层退才对（同别的模块里弹窗挡住返回的直觉）
    if (view.menuOpen) {
        view.menuOpen = false;
        rerender();
        return true;
    }

    if (view.page === 'list') return false;   // 交还给路由，回桌面
    if (view.page === 'play') {
        // 原路来、原路回：从首页「继续游玩」那一行点进来的，别把人丢到剧本详情页去
        if (view.playFrom === 'list') void goList();
        else void goScript(view.scriptId);
    } else if (view.page === 'dir') {
        // 目录页是从游玩页推开的，返回要回游玩页（漏了这一条会一路跳过它直达剧本页）
        view.page = 'play';
        scrollTo = cache.play?.currentNodeId || 'top';
        rerender();
    } else {
        void goList();
    }
    return true;
}

// ============================================================
// 事件（节点级委托，.tg-page 每轮重建后只绑一次）
// ============================================================

export function bindEvents(container, context = {}) {
    currentContainer = container || currentContainer;
    const root = currentContainer?.querySelector('.tg-page');
    if (!root || boundRoots.has(root)) return;
    boundRoots.add(root);

    root.addEventListener('click', onRootClick);
    root.addEventListener('input', onRootInput);
    root.addEventListener('change', onRootChange);
    root.addEventListener('keydown', onRootKeydown);
}

function onRootKeydown(event) {
    if (event.key !== 'Enter') return;
    const field = event.target.closest('[data-tg-field="draft"]');
    if (!field) return;
    event.preventDefault();
    sendDraft();
}

function onRootInput(event) {
    const field = event.target.closest('[data-tg-field]');
    if (!field) return;
    const key = field.dataset.tgField;
    const value = field.value;

    if (key === 'draft') cache.draft = value;
    else if (key === 'import-title') cache.importTitle = value;
    else if (key === 'import-text') cache.importText = value;
    else if (key === 'hero-name') {
        cache.heroName = value;
        // 开局按钮上的字跟着走（重画会丢光标，所以这里只改按钮那一个节点）
        const btn = currentContainer?.querySelector('[data-tg-act="start-play"]');
        if (btn) btn.textContent = startPlayLabel(value);
    }
    else if (key === 'hero-note') cache.heroNote = value;
    else if (key === 'script-text') {
        cache.scriptDraft = value;
        // 字数当场跟手（重画会丢光标，所以这里只改那一小格）
        const len = currentContainer?.querySelector('[data-tg-len="script"]');
        if (len) len.textContent = fmtCount(value.length);
    }
    else if (key.startsWith('prompt-')) cache.promptDraft[key.slice(7)] = value;
    // 风格预设的编辑面板：只写草稿，**绝不 rerender**（重画会重建 DOM、把光标弄丢）
    else if (key === 'preset-name' || key === 'preset-text') {
        if (cache.presetDraft) cache.presetDraft[key === 'preset-name' ? 'name' : 'text'] = value;
    }
    // 整段导入：字照收，同时**只改报账那一行**（同 script-text 只改字数那一格）
    else if (key === 'preset-import-text') {
        cache.presetImportText = value;
        const line = currentContainer?.querySelector('[data-tg-import-report]');
        if (line) {
            line.textContent = presetImportReport(
                parsePresetText(value, cache.presetImportName, { maxTextLength: db.LIMITS.PRESET_TEXT }), value);
        }
    }
    else if (key === 'preset-import-name') cache.presetImportName = value;
    // （没有 preset-ai 这一支：那个框是只读的，不会有输入。改了也不该有用——
    //   它显示的必须是 core 里那份常量本身。）
}

async function onRootChange(event) {
    const fileInput = event.target.closest('[data-tg-file]');
    if (!fileInput || !fileInput.files?.length) return;

    const file = fileInput.files[0];
    // 按输入框上那个值分派。三个值三种意思，别混：
    //   'preset-pack'  = 一整份预设（预设页那张导入卡）
    //   'preset-entry' = 一条条目的正文（条目编辑面板里那个）
    //   ''（裸属性）    = 剧本导入——**老行为逐字节不变**
    const kind = fileInput.dataset.tgFile;
    try {
        const text = await readTextFile(file);
        if (kind === 'preset-pack') {
            // 跟粘贴走**同一条路**：只填进那张卡，点「识别并导入」才进库
            cache.presetImportText = text;
            if (!cache.presetImportName) cache.presetImportName = file.name.replace(/\.[^.]+$/, '').slice(0, 40);
            view.presetImportOpen = true;
            rerender();
            toast(`已读入 ${file.name}，看一眼下面那行再点「识别并导入」`);
        } else if (kind === 'preset-entry') {
            // **只填草稿，点保存才进库**（同新建）；名字默认取文件名，位置给 system，两样都能改
            cache.presetDraft = {
                name: file.name.replace(/\.[^.]+$/, '').slice(0, 40),
                text,
                where: DEFAULT_PRESET_WHERE
            };
            rerender();
            toast(`已读入 ${file.name}，改完点保存才进库`);
        } else {
            cache.importText = text;
            if (!cache.importTitle) cache.importTitle = file.name.replace(/\.[^.]+$/, '');
            rerender();
            toast(`已读入 ${file.name}`);
        }
    } catch (error) {
        void showAlert(`读不了这个文件：${error?.message || error}`);
    } finally {
        fileInput.value = '';   // 读失败之后多半会重选同一个文件，不清掉就不会再触发 change
    }
}

function onRootClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    // 正文里渲染出来的链接归链接，别顺手把它当成「跳回这一节」
    if (target.closest('a[href]')) return;

    const el = target.closest('[data-tg-act]');
    if (!el) return;

    switch (el.dataset.tgAct) {
        case 'toggle-import':
            view.importOpen = !view.importOpen;
            rerender();
            break;
        case 'pick-file':
            // **就近取**：按钮所在的那一块里若有文件框就用它，否则退回整页第一个。
            // （今天每页最多一个文件框，所以两种都指得对；但同页两个时，
            //   原来那句「整页第一个」就要靠 DOM 顺序撞运气了。）
            // 两个容器名：剧本那块是 .tg-card，预设的编辑面板是 .tg-editor（不是卡了）。
            (el.closest('.tg-card, .tg-editor') || currentContainer).querySelector('[data-tg-file]')?.click();
            break;
        case 'open-presets':
            void goPresets();
            break;
        case 'new-pack':
            void createPack();
            break;
        case 'toggle-import-pack':
            view.presetImportOpen = !view.presetImportOpen;
            rerender();
            break;
        case 'import-pack':
            void importPresetPack();
            break;
        case 'toggle-ai-prompt':
            view.presetAiOpen = !view.presetAiOpen;
            rerender();
            break;
        case 'copy-ai-prompt':
            copyAiPrompt();
            break;
        case 'open-pack':
            openPack(el.dataset.packId);
            break;
        case 'rename-pack':
            void renamePack(el.dataset.packId);
            break;
        case 'delete-pack':
            void deletePack(el.dataset.packId);
            break;
        case 'copy-pack':
            void copyPack(el.dataset.packId);
            break;
        case 'new-entry':
            openEntryEditor('new', el.dataset.packId);
            break;
        case 'edit-entry':
            openEntryEditor(el.dataset.entryId, el.dataset.packId || view.openPackId);
            break;
        case 'move-entry':
            void moveEntry(el.dataset.packId, el.dataset.entryId, Number(el.dataset.dir) || 0);
            break;
        case 'set-preset-where':
            if (cache.presetDraft) cache.presetDraft.where = el.dataset.presetWhere;
            scrollTo = 'keep';
            rerender();
            break;
        case 'save-preset':
            void saveEntryFromDraft(el.dataset.packId, el.dataset.entryId || null);
            break;
        case 'delete-entry':
            void deleteEntry(el.dataset.packId, el.dataset.entryId);
            break;
        case 'reset-entry':
            void resetEntry(el.dataset.packId, el.dataset.entryId);
            break;
        case 'pick-pack':
            void pickPack(el.dataset.packId || null);
            break;
        case 'toggle-preset':
            void togglePreset(el.dataset.entryId);
            break;
        case 'save-script':
            void saveImportedScript();
            break;
        case 'open-script':
            void goScript(el.dataset.scriptId);
            break;
        case 'rename-script':
            void renameCurrentScript();
            break;
        case 'delete-script':
            void deleteCurrentScript();
            break;
        case 'toggle-text':
            view.textOpen = !view.textOpen;
            rerender();
            break;
        case 'save-script-text':
            void saveScriptText();
            break;
        case 'toggle-prompt':
            view.promptOpen[el.dataset.promptKey] = !view.promptOpen[el.dataset.promptKey];
            rerender();
            break;
        case 'toggle-inject':
            void togglePromptInject(el.dataset.promptKey);
            break;
        case 'save-prompt':
            void savePromptBlock(el.dataset.promptKey);
            break;
        case 'reset-prompt':
            void resetPromptBlock(el.dataset.promptKey);
            break;
        case 'toggle-roster':
            view.rosterOpen = !view.rosterOpen;
            rerender();
            break;
        case 'pick-hero': {
            const picked = loadCharacters().find(c => c?.id === el.dataset.charId);
            if (!picked) { toast('这个角色不在了'); break; }
            cache.heroRef = picked.id;
            // 抄下来的那两样：名字照抄，设定只抄性别年龄（其余的留在角色卡上引用）
            cache.heroName = String(picked.base?.name || '').trim();
            cache.heroNote = heroNoteFrom(picked.base);
            view.rosterOpen = false;
            rerender();
            break;
        }
        case 'drop-ref':
            // 只摘引用。抄下来的名字与设定留在框里——它们已经是这一局自己的数据了
            cache.heroRef = null;
            rerender();
            break;
        case 'start-play':
            void startPlay();
            break;
        case 'open-play':
            void goPlay(el.dataset.playId);
            break;
        case 'delete-play':
            event.stopPropagation();
            void deletePlay(el.dataset.playId);
            break;
        case 'toggle-menu':
            view.menuOpen = !view.menuOpen;
            view.menuScroll = 0;                // 新开的弹窗从头看
            view.menuAnim = view.menuOpen;      // 滑入动画只在开的那一次播（见 view.menuAnim）
            rerender();
            break;
        case 'close-menu':
            // 点遮罩关。**面板里面的空白不算「外面」**——那是内容：按钮有自己的 data-tg-act，
            // 落在空白处时最近的那个就是遮罩这一层，所以这里要把它拦回去。
            if (target.closest('.tg-menu')) break;
            view.menuOpen = false;
            rerender();
            break;
        case 'rename-play':
            void renameCurrentPlay();
            break;
        case 'toggle-free':
            void toggleFreeMode();
            break;
        case 'open-scene':
            void runTurn({ parentId: null, playerInput: '', kind: 'open' });
            break;
        case 'send':
            void sendDraft();
            break;
        case 'retry':
            void retryPending();
            break;
        case 'drop-pending':
            void dropPending();
            break;
        case 'jump': {
            // 目录页点一行、游玩页点「接着走」那一行——都是同一个动作：挪指针。
            // 从目录页点出来的先切回游玩页（jumpTo 里的 scrollTo 会让那一节滚进视野）。
            if (view.page === 'dir') view.page = 'play';
            void jumpTo(el.dataset.nodeId);
            break;
        }
        case 'open-dir':
            openDir();
            break;
        case 'fold-node': {
            // 折角按钮在行的里面，closest 取到的是它自己，不会顺带触发整行的 jump
            const id = el.dataset.foldId;
            if (!view.collapsed) view.collapsed = new Set();
            if (view.collapsed.has(id)) view.collapsed.delete(id);
            else view.collapsed.add(id);
            rerender();
            break;
        }
        case 'fold-all': {
            if (!cache.index) break;
            const folds = foldableIds(cache.index);
            const collapsed = view.collapsed || new Set();
            const allFolded = folds.length > 0 && folds.every(id => collapsed.has(id));
            view.collapsed = allFolded ? new Set() : new Set(folds);
            rerender();
            break;
        }
        default:
            break;
    }
}

// ============================================================
// 动作
// ============================================================

function sendDraft() {
    const text = (cache.draft || '').trim();
    if (!text) {
        toast('先写下主角要做什么');
        return;
    }
    if (!cache.play?.currentNodeId) return;
    void runTurn({ parentId: cache.play.currentNodeId, playerInput: text, kind: 'advance' });
}

/**
 * 切到某一节。**这就是「翻页」**——一节一页之后，翻页与跳转是同一个动作：挪那个指针。
 * 入口有两处：游玩页底部的「接着走」、目录页的任一行。
 * 只改 currentNodeId 一个字段，不建节点、不动节点表（树没变，所以不刷新 index）。
 */
async function jumpTo(nodeId) {
    if (!nodeId || !cache.play) return;
    await db.setCurrentNode(cache.play.id, nodeId);
    cache.play = await db.getPlaythrough(cache.play.id);
    scrollTo = nodeId;
    rerender();
}

async function retryPending() {
    const pending = cache.play?.pending;
    if (!pending) return;
    await runTurn({
        parentId: pending.parentNodeId || null,
        playerInput: pending.playerInput || '',
        kind: pending.kind || 'advance'
    });
}

async function dropPending() {
    if (!cache.play) return;
    await db.setPending(cache.play.id, null);
    cache.error = '';
    await refreshPlay();
    scrollTo = 'keep';
    rerender();
}

async function saveImportedScript() {
    const text = (cache.importText || '').trim();
    if (!text) {
        void showAlert('还没有内容。粘一份文游指令进来，或者选一个文件。');
        return;
    }
    const title = (cache.importTitle || '').trim() || '未命名剧本';

    if (text.length > 120000) {
        const ok = await showConfirm(`这份有 ${text.length} 字，很长。太长的剧本可能超出模型的上下文，游玩时较早的旁白会被折叠。仍然保存吗？`);
        if (!ok) return;
    }

    const record = await db.saveScript({ title, text });
    cache.importText = '';
    cache.importTitle = '';
    view.importOpen = false;
    await goScript(record.id);
    toast('剧本已存下');
}

async function renameCurrentScript() {
    if (!cache.script) return;
    const next = await showPrompt('剧本名：', cache.script.title);
    if (next === null) return;
    await db.renameScript(cache.script.id, next.trim() || cache.script.title);
    cache.script = await db.getScript(cache.script.id);
    rerender();
}

async function deleteCurrentScript() {
    if (!cache.script) return;
    const runs = cache.plays.filter(p => p.scriptId === cache.script.id).length;
    const ok = await showConfirm(`删掉《${cache.script.title}》？${runs ? `它下面 ${runs} 局游玩记录也会一起删掉。` : ''}这个动作收不回来。`);
    if (!ok) return;
    await db.deleteScript(cache.script.id);
    await goList();
    toast('剧本已删');
}

/**
 * 名册里能挑来当主角的角色。**只名册**（世界网络那批是另一条线，不列）、归档的不列。
 * 只取列表要显示的三样，别把整份角色记录拖进来。
 */
function rosterChoices() {
    try {
        return loadCharacters()
            .filter(c => c?.id && !isArchived(c.id))
            .map(c => ({
                id: c.id,
                name: String(c.base?.name || '').trim(),
                desc: String(c.base?.desc || '').trim()
            }));
    } catch { return []; }
}

/**
 * 挑中一个角色时**抄**进「主角设定」那个框的那点基本信息：性别 + 年龄，有哪样写哪样，
 * 「未知」不算（别把「未知 · 未知」抄进提示词）。抄下来之后就跟名册脱钩了——
 * 那两个框是模块自己的数据，随便改，角色以后改名也不回头改这一局。
 */
function heroNoteFrom(base) {
    const parts = [];
    const gender = String(base?.gender || '').trim();
    const age = String(base?.age || '').trim();
    if (gender && gender !== '未知') parts.push(gender);
    if (age && age !== '未知') parts.push(/^\d+$/.test(age) ? `${age} 岁` : age);
    return parts.join(' · ');
}

/**
 * 这一局引用的那个角色，**每轮现读**（跟剧本级两块提示词同一个口径：角色改完下一轮就生效，
 * 已经写出来的节不动）。读不到——角色被彻底删掉、或者这一局压根没引用——就返回空对象，
 * 提示词里那两截整块不写；而抄下来的名字与设定照旧。**这一局仍然跑得下去**，
 * 这就是「抄的那半是模块自己的数据、引用的那半只是借来看」的意思。
 * 归档不算删：归档的角色照样在名册数组里，引用照旧。
 */
function refOfId(refId) {
    if (!refId) return {};
    try {
        const base = loadCharacters().find(c => c?.id === refId)?.base || {};
        return {
            name: String(base.name || '').trim(),
            detail: String(base.detail || '').trim(),
            secret: String(base.secret || '').trim()
        };
    } catch { return {}; }
}

function refOf(play) { return refOfId(play?.protagonist?.ref); }

/**
 * 开局卡片里「从名册挑」那一栏。挑一个 = 名字与性别年龄**抄**进上面那两个框（抄完还能改），
 * 详细设定与秘密留在角色卡上**引用**着（每轮现读，不抄进来）。
 * 挑不挑都不影响「直接开场」——两个框照旧可以一直留空。
 */
function heroPickerHtml() {
    const list = rosterChoices();
    const ref = refOfId(cache.heroRef);
    const refLen = (ref.detail || '').length + (ref.secret || '').length;
    return `
        <div class="tg-collapse">
            <button class="tg-collapse-head" data-tg-act="toggle-roster">
                📇 从名册挑一个主角 ${view.rosterOpen ? '▲' : '▼'}
            </button>
            ${view.rosterOpen ? (list.length ? `
                <div class="tg-pick">
                    ${list.map(c => `
                        <button class="tg-pick-item${cache.heroRef === c.id ? ' is-on' : ''}"
                                data-tg-act="pick-hero" data-char-id="${esc(c.id)}">
                            <span class="tg-pick-name">${esc(c.name || '（无名）')}</span>
                            ${c.desc ? `<span class="tg-pick-desc">${esc(summarize(c.desc, 34))}</span>` : ''}
                        </button>
                    `).join('')}
                </div>
                <div class="tg-hint">挑一个 = 把名字与性别年龄抄进上面两个框，详细设定与秘密留在角色卡上引用着。以后改角色卡，这一局之后每一轮跟着变（已经写出来的节不动）；把那个角色删掉，引用那两截就没了，名字与设定还在。</div>
            ` : `<div class="tg-hint">名册里还没有角色。</div>`) : ''}
        </div>
        ${cache.heroRef ? `
            <div class="tg-ref">
                📌 引用中：<b>${esc(ref.name || '（无名）')}</b> 的详细设定与秘密
                ${refLen ? `· ${refLen} 字` : '（这两样还是空的）'}
                <button class="tg-icon-btn sm" data-tg-act="drop-ref" title="不引用了">✕</button>
            </div>
        ` : ''}
    `;
}

/**
 * 开局按钮上那行字，跟着名字那一栏当场变：
 * 填了名字 = 这一局的主角就是它；**留空 = 直接开场**（身份由剧本开场自己定）。
 * 同一个函数给渲染层用，也给输入时的局部更新用（重画会丢光标，所以打字时只改按钮那一行）。
 */
function startPlayLabel(name) {
    const n = String(name || '').trim();
    return n ? `▶️ 以「${n}」开场` : '▶️ 直接开场';
}

async function startPlay() {
    if (!cache.script) return;
    const name = (cache.heroName || '').trim();     // 允许留空：直接开场，主角由剧本定
    const play = await db.createPlaythrough({
        scriptId: cache.script.id,
        // 抄下来的那两样（名字 / 设定）+ 引用来的那个角色 id。引用只存 id，正文不抄。
        protagonist: { name, note: (cache.heroNote || '').trim(), ref: cache.heroRef || null }
    });
    cache.heroName = '';
    cache.heroNote = '';
    cache.heroRef = null;
    await goPlay(play.id);
    toast('这一局开好了，点「生成开场」开始');
}

/**
 * 切「普通 / 自由」显示方式。随时可切：只改剧本记录上的一个布尔值，
 * 正文一个字都不动（画法是每次渲染现算的），所以来回切不会留下副本、也不会半自由半普通。
 */
async function toggleFreeMode() {
    if (!cache.script) return;
    const next = !isFree();

    const record = await db.setScriptFreeMode(cache.script.id, next);
    if (record) cache.script = { ...cache.script, freeMode: record.freeMode };

    view.menuOpen = false;
    scrollTo = 'keep';
    rerender();
    toast(next ? '自由模式：正文里的美化格式直接画' : '普通模式：正文按文字格式 md 解析');
}

/* ---------- 剧本正文 / 两块提示词（都是剧本级，见 textgameCore 的 PROMPT_BLOCKS） ---------- */

/**
 * 剧本正文改了就写这份记录（charCount / preview 一并重算）。
 * **没有源文件这一说**：导入时倒进来的那份文本就是唯一一份，改的就是它。
 */
async function saveScriptText() {
    if (!cache.script) return;
    const text = cache.scriptDraft ?? cache.script.text ?? '';
    if (text === (cache.script.text ?? '')) {      // 没改动就别白写一次库
        cache.scriptDraft = null;
        scrollTo = 'keep';
        rerender();
        return;
    }

    const record = await db.saveScript({ id: cache.script.id, text });
    cache.script = await db.getScript(cache.script.id);
    cache.scriptDraft = null;
    scrollTo = 'keep';
    rerender();
    toast(`正文已保存 · ${fmtCount(record?.charCount ?? text.length)}，下一轮生成生效`);
}

/**
 * 写剧本级的两块提示词。**每次只有一块变**：另一块是从记录里原样读出来再放回去的，
 * 「一块只影响自己那块」在结构上就成立，不靠调用方自觉。
 */
async function writePrompts(next) {
    if (!cache.script) return;
    const record = await db.setScriptPrompts(cache.script.id, next);
    if (record) cache.script = { ...cache.script, prompts: record.prompts };
    scrollTo = 'keep';
    rerender();
}

async function togglePromptInject(key) {
    if (!cache.script) return;
    const now = normalizePrompts(cache.script.prompts);
    if (!now[key]) return;
    now[key].on = !now[key].on;
    await writePrompts(now);
    toast(now[key].on ? '这一块会随 system 一起发出去' : '这一块不再发出去（框里的字留着）');
}

async function savePromptBlock(key) {
    if (!cache.script) return;
    const block = PROMPT_BLOCKS.find(b => b.key === key);
    if (!block) return;
    const now = normalizePrompts(cache.script.prompts);
    // 框里那份 = 改过就取草稿，**没动过就取记录里那一份**（取不到才是默认）。
    // ⚠️ 这个 ?? 的回退不能省：保存成功会清掉草稿，再点一次「保存」时草稿是空的，
    // 少了这一句就会拿 undefined 去比对，于是判成「与默认一致」而把记录写成 ''——
    // 表现就是「改完保存，再点一次保存又回到默认内容」。
    const draft = cache.promptDraft[key] ?? (now[key].text || block.fallback);
    // 跟默认逐字相同（或全空白）就记成「没动过」——记录里只留你真正改出来的那段字
    now[key].text = promptsSaveValue(draft, block.fallback);
    delete cache.promptDraft[key];
    await writePrompts(now);
    toast(now[key].text ? '已保存这一段（往后模块改默认也不动它）' : '与默认一致，记作没改过');
}

async function resetPromptBlock(key) {
    if (!cache.script) return;
    const now = normalizePrompts(cache.script.prompts);
    if (!now[key]) return;
    now[key].text = '';                            // 丢掉你那段字，回到「没动过」
    delete cache.promptDraft[key];
    await writePrompts(now);
    toast('已退回模块当前的默认文案（开关状态没动）');
}

/* ---------- 风格预设：预设与条目那一侧（见「风格预设页」那一节） ---------- */

/** 展开/收起一份预设（一次只开一份）。收起/换一份时编辑面板一并关掉——编辑态属于那一份 */
function openPack(packId) {
    view.openPackId = view.openPackId === packId ? null : packId;
    view.presetEditId = null;
    cache.presetDraft = null;
    scrollTo = 'keep';
    rerender();
}

/** 新建一份空预设（名字当场问，条目之后加）。不加条目的话它发出去也是空的，没有副作用 */
async function createPack() {
    const name = await showPrompt('这份预设叫什么：', '新预设');
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) { toast('先给它起个名字'); return; }
    const pack = { id: db.newPackId(), name: trimmed.slice(0, 40), entries: [] };
    await writeMyPacks([...myPacks(), pack]);
    view.openPackId = pack.id;      // 建完直接展开，接着就能加条目
    view.presetEditId = null;
    scrollTo = 'keep';
    rerender();
    toast('已建好，接着加条目');
}

async function renamePack(packId) {
    const pack = packById(packId);
    if (!pack) return;
    const name = await showPrompt('这份预设叫什么：', pack.name);
    if (name === null) return;
    const trimmed = name.trim().slice(0, 40);
    if (!trimmed) { toast('名字不能是空的'); return; }
    if (packId === BUILTIN_PACK.id) {
        // 名字也一并存进那份覆盖记录里（写口只有这一个，条目走 packEntryPatch 折成空）
        await writeBuiltinPack(pack.entries, trimmed);
    } else {
        await writeMyPacks(myPacks().map(p => (p.id === packId ? { ...p, name: trimmed } : p)));
    }
    scrollTo = 'keep';
    rerender();
    toast('已改名');
}

/**
 * 删掉一整份预设。**不回头改任何一局的记录**——那些局只是变成「选的那份不在了」，
 * 一条都不再发（⋯ 菜单里照实说）。所以这里只动库，一个 playthrough 都不碰。
 */
async function deletePack(packId) {
    if (packId === BUILTIN_PACK.id) return;
    const pack = packById(packId);
    if (!pack) return;
    const ok = await showConfirm(`删掉预设「${pack.name || '（没名字）'}」？这一份和里面 ${pack.entries.length} 条都会没掉。用过它的局会变成一条都不发（那些局的记录留着）。`);
    if (!ok) return;

    await writeMyPacks(myPacks().filter(p => p.id !== packId));
    view.openPackId = null;
    view.presetEditId = null;
    cache.presetDraft = null;
    scrollTo = 'keep';
    rerender();
    toast('已删掉');
}

/**
 * 复制一份（内置那份的逃生口，也是「照着改」的起手式）。
 * **条目 id 全部换新**：复制出来的是一份独立的东西，从此跟内置常量脱钩——
 * 不换的话它就成了「带 builtin_ id 的普通条目」，读的时候不吃合并、行为反而更难解释。
 */
async function copyPack(packId) {
    const pack = packById(packId);
    if (!pack) return;
    const name = await showPrompt('复制成哪一份：', `${pack.name} 副本`);
    if (name === null) return;
    const trimmed = name.trim().slice(0, 40);
    if (!trimmed) { toast('先给它起个名字'); return; }

    const copy = {
        id: db.newPackId(),
        name: trimmed,
        entries: pack.entries.map(e => ({ id: db.newEntryId(), name: e.name, text: e.text, where: presetWhereOf(e) }))
    };
    await writeMyPacks([...myPacks(), copy]);
    view.openPackId = copy.id;
    view.presetEditId = null;
    scrollTo = 'keep';
    rerender();
    toast(`已复制成「${copy.name}」，之后随便改`);
}

/**
 * 把那张卡里的整段文本识别成一份预设、**追加**进库（用户口径：「一口气将对应的整体文本
 * 导入并识别成预设」）。
 *
 * 三件事跟别的入口口径一致：
 *   ① **id 现生成**（同 copyPack）——外部文本里没有 id 这一说，也不该有；
 *   ② **不自动选进任何一局**（导入不产生副作用，同「复制一份」）；
 *   ③ 原文**当场清掉**：库里那份预设只有名字 + 条目，没有任何存原文的地方
 *      （用户口径「不留原件，后续修改全部都是项目中预设的方式」）。
 */
async function importPresetPack() {
    const text = cache.presetImportText || '';
    if (!text.trim()) {
        void showAlert('还没有内容。把 AI 那一整段粘进来，或者选一个文件。');
        return;
    }
    const parsed = parsePresetText(text, cache.presetImportName, { maxTextLength: db.LIMITS.PRESET_TEXT });
    if (!parsed.entries.length) {
        void showAlert('没认到条目。至少要有一行以 ## 开头的条目名（比如「## 冷叙事」），它下面就是这一条的正文。');
        return;
    }
    if (parsed.truncated) {
        const ok = await showConfirm(`有 ${parsed.truncated} 条超过 ${db.LIMITS.PRESET_TEXT} 字，落库时会被截断（超出的部分没有了）。仍然导入吗？`);
        if (!ok) return;
    }

    const pack = {
        id: db.newPackId(),
        name: parsed.name,
        entries: parsed.entries.map(e => ({ id: db.newEntryId(), name: e.name, text: e.text, where: e.where }))
    };
    await writeMyPacks([...myPacks(), pack]);
    cache.presetImportText = '';        // 原文到此为止：库里的那份跟它再无关系
    cache.presetImportName = '';
    view.presetImportOpen = false;
    view.openPackId = pack.id;          // 导完就展开，一眼看到条目分得对不对
    view.presetEditId = null;
    scrollTo = 'keep';
    rerender();
    toast(`已导入「${pack.name}」：${pack.entries.length} 条${parsed.skipped ? `（另有 ${parsed.skipped} 行没认出来、跳过了）` : ''}`);
}

/**
 * 复制那段给 AI 的说明。**不用 `navigator.clipboard`**：file:// 下可能没有、localhost 上还要权限，
 * 而 `execCommand('copy')` 全平台可用（虽然旧）。复制不成也**先把字全选上**——
 * 至少手指一按就能复制，不至于什么反馈都没有。
 * 框是只读的，所以这里只管「全选 + 复制」，没有「改过的草稿要不要撤」这一层。
 */
function copyAiPrompt() {
    const ta = currentContainer?.querySelector('[data-tg-field="preset-ai"]');
    if (!ta) return;
    ta.focus();
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    toast(ok ? '已复制，去贴给外部 AI' : '已全选——按一下复制（这个环境不让脚本自己复制）');
}

/**
 * 开/合条目编辑面板。**打开时把这一条抄进单槽草稿**，之后面板只认草稿——
 * 于是「改到一半又点了一下别处」不会把记录里的原样弄丢，也不会半途写库。
 * 再点同一条 = 收起来（没保存的字就丢了，见 hint）。
 */
function openEntryEditor(entryId, packId) {
    if (view.presetEditId === entryId) {
        view.presetEditId = null;
        cache.presetDraft = null;
    } else if (entryId === 'new') {
        view.openPackId = packId || view.openPackId;
        view.presetEditId = 'new';
        cache.presetDraft = { name: '', text: '', where: DEFAULT_PRESET_WHERE };
    } else {
        const pack = packById(packId);
        const entry = pack?.entries.find(e => e.id === entryId);
        if (!entry) { toast('这一条不在了'); return; }
        view.openPackId = pack.id;
        view.presetEditId = entryId;
        cache.presetDraft = { name: entry.name, text: entry.text, where: presetWhereOf(entry) };
    }
    scrollTo = 'keep';
    rerender();
}

/**
 * 保存一条（新建的追加到这份预设末尾，改的就地覆盖）。
 * 写回走的是「这一份的完整条目表」：core 的 packEntryPatch 会在写内置那份时把
 * 没改过的字段折成空（见 writeBuiltinPack），所以这里不用管是哪一份。
 */
async function saveEntryFromDraft(packId, entryId) {
    const d = cache.presetDraft;
    if (!d) return;
    const pack = packById(packId);
    if (!pack) { toast('这份预设不在了'); return; }
    const name = String(d.name || '').trim();
    const text = String(d.text || '').trim();
    if (!name) { toast('先给它起个名字'); return; }
    if (!text) { toast('这条还是空的，写点内容再存'); return; }
    const where = presetWhereOf({ where: d.where });

    const entries = pack.entries.slice();
    if (entryId) {
        const i = entries.findIndex(e => e.id === entryId);
        if (i < 0) { toast('这一条不在了'); return; }
        entries[i] = { ...entries[i], name, text, where };
    } else {
        // 显式给 id：store 的消毒**会把没 id 的条目丢掉**
        entries.push({ id: db.newEntryId(), name, text, where });
    }
    await writePack(pack.id, entries);
    view.presetEditId = null;
    cache.presetDraft = null;
    scrollTo = 'keep';
    rerender();
    toast(entryId ? '已保存，下一轮生成生效' : '已加进这份预设');
}

/** 删一条（只可能是自己加的：内置那 6 条没有删除按钮，get 到也没有） */
async function deleteEntry(packId, entryId) {
    const pack = packById(packId);
    if (!pack) return;
    if (isBuiltinEntryId(entryId)) { toast('内置那条删不掉，想删就整份复制一份'); return; }
    const entry = pack.entries.find(e => e.id === entryId);
    if (!entry) return;
    const ok = await showConfirm(`删掉「${entry.name || '（没名字）'}」？用过这份预设的局都会少这一条。`);
    if (!ok) return;

    await writePack(pack.id, pack.entries.filter(e => e.id !== entryId));
    view.presetEditId = null;
    cache.presetDraft = null;
    scrollTo = 'keep';
    rerender();
    toast('已删掉');
}

/** 内置那一条退回模块当前的文案（存空 = 从没动过，之后模块改进它也跟着走） */
async function resetEntry(packId, entryId) {
    const pack = packById(packId);
    const base = BUILTIN_PACK.entries.find(e => e.id === entryId);
    if (!pack || !base) return;
    const ok = await showConfirm(`把「${base.name}」退回模块当前的文案？你改过的名字、正文、位置都会丢掉。`);
    if (!ok) return;

    await writePack(pack.id, pack.entries.map(e => (e.id === entryId ? { ...base } : e)));
    view.presetEditId = null;
    cache.presetDraft = null;
    scrollTo = 'keep';
    rerender();
    toast('已退回默认');
}

/** 一份预设的条目整个写回（内置那份走覆盖层那条路） */
async function writePack(packId, entries) {
    if (packId === BUILTIN_PACK.id) {
        await writeBuiltinPack(entries);
    } else {
        await writeMyPacks(myPacks().map(p => (p.id === packId ? { ...p, entries } : p)));
    }
}

/**
 * 在**同一栏内**往前 / 往后挪一位 = 换这份预设里那两项的位次。
 * **只在同一个位置内部找邻居**：跨位置换位没有意义（两路根本不在一起拼），
 * 而且在页面上会变成「按了 ↓ 却没动」（分组是按位置画的）。
 */
async function moveEntry(packId, entryId, dir) {
    if (!dir) return;
    const pack = packById(packId);
    if (!pack) return;
    const list = pack.entries.slice();
    const i = list.findIndex(e => e.id === entryId);
    if (i < 0) return;
    const where = presetWhereOf(list[i]);
    let j = i + dir;
    while (j >= 0 && j < list.length && presetWhereOf(list[j]) !== where) j += dir;
    if (j < 0 || j >= list.length) return;

    [list[i], list[j]] = [list[j], list[i]];
    await writePack(pack.id, list);
    scrollTo = 'keep';
    rerender();
}

/**
 * 选这一局用哪一份预设（⋯ 菜单里）。**选一份就把它的条目全开**——要的就是「切到这套方案」；
 * 再在这一份里勾掉不需要的那几条。「不用预设」= 两个字段都清空，一条都不发。
 * **菜单不关**（选完立刻要勾条目），同 togglePreset；⚠️ 都会碰 updatedAt、把这一局顶到首页第一行。
 */
async function pickPack(packId) {
    const play = cache.play;
    if (!play) return;
    const pack = packById(packId);
    cache.play = await db.updatePlaythrough(play.id, {
        presetPackId: pack ? pack.id : null,
        // 挑一份时**只读记忆、不写**（写记忆是 togglePreset 独占的）：这份你手动调过就恢复成
        // 你离开时的样子，没调过就是整套全开。挑一眼就走的不留痕——这是「手滑点一下零开销」那条。
        presetIds: pack ? presetIdsForPack(pack, play) : []
    });
    // 变的只有菜单里显示的东西（正文一个字不受影响）⇒ 只重画菜单，别把正文那个沙箱框拆了重建
    rerenderMenu();
}

/**
 * 勾/取消这一份里的一条（游玩页 ⋯ 菜单里）。**菜单不关**——连勾几条是常态，
 * 这跟 toggleFreeMode 那种「选完就走」有意不一样；即时反馈就是那一行翻成 ✅/⬜。
 * 只重画菜单那一块（勾选不影响正文），免得每勾一条就把正文的沙箱框拆了重建。
 * ⚠️ updatePlaythrough 顺手碰 updatedAt，于是勾一次就把这一局顶到首页「继续游玩」第一行。
 *
 * 这里**也是唯一写「每份预设各自的记忆」的地方**（presetPicks）：手动动过哪份，那份就记一笔，
 * 下次换回来按它恢复。只挑一份、没碰条目列表的不写 ⇒ 手滑点一下不留痕。
 * ⚠️ updatePlaythrough 是浅合并 ⇒ presetPicks 得带上别份的（展开旧对象再盖自己这一份）。
 */
async function togglePreset(entryId) {
    const play = cache.play;
    if (!play || !entryId) return;
    const picked = presetIdsOf(play);
    const next = picked.includes(entryId)
        ? picked.filter(x => x !== entryId)
        : picked.concat([entryId]);

    const packId = presetPackIdOf(play);
    cache.play = await db.updatePlaythrough(play.id, packId
        ? { presetIds: next, presetPicks: { ...presetPicksOf(play), [packId]: next } }
        : { presetIds: next });
    rerenderMenu();
}

async function renameCurrentPlay() {
    if (!cache.play) return;
    const next = await showPrompt('这一局叫什么：', cache.play.title);
    if (next === null) return;
    cache.play = await db.updatePlaythrough(cache.play.id, { title: next.trim() || cache.play.title });
    view.menuOpen = false;
    rerender();
}

async function deletePlay(playId) {
    const play = cache.plays.find(p => p.id === playId) || cache.play;
    if (!play) return;
    const ok = await showConfirm(`删掉「${play.title}」？这一局的所有节点都会没掉，收不回来。`);
    if (!ok) return;

    await db.deletePlaythrough(playId);
    if (view.playId === playId) {
        await goScript(view.scriptId);
    } else {
        await reload();
        rerender();
    }
    toast('已删除');
}

// ============================================================
// 注册
// ============================================================

if (!window.__moduleRegistry) window.__moduleRegistry = [];
window.__moduleRegistry.push({ id, label, icon, color, render, bindEvents, handleBack });

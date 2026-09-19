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
    PROMPT_BLOCKS, normalizePrompts
} from './textgameCore.js';
import { callStoryAI, readTextFile } from './textgameAI.js';
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
    page: 'list',        // list | script | play | dir（dir = 节点目录页）
    scriptId: null,
    playId: null,
    playFrom: 'script',  // 这一局是从哪一页点开的（list = 首页「继续游玩」那一行）——返回按它走
    importOpen: false,
    rosterOpen: false,   // 开局卡片里「从名册挑」那一栏
    textOpen: false,     // 剧本正文那一栏
    promptOpen: {},      // 两块提示词各自的展开状态：{ frame: bool, contract: bool }
    menuOpen: false,
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
    degraded: 0,         // 提示词降级了几轮（超预算折叠）
    // ↓ 表单/输入框的内容：rerender 会重建 DOM，所以这些得留在内存里
    draft: '',           // 自由行动输入框
    importTitle: '',     // 导入表单：剧本名
    importText: '',      // 导入表单：原文
    heroName: '',        // 开局表单：主角名
    heroNote: '',        // 开局表单：主角设定
    heroRef: null,       // 开局表单：从名册挑来的那个角色 id（没有 = null）
    scriptDraft: null,   // 剧本正文：没保存的改动（null = 没动过，照记录里的显示）
    promptDraft: {}      // 两块提示词：没保存的改动，key 同 PROMPT_BLOCKS
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
    cache.error = '';
    cache.draft = '';
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
    cache.error = '';
    cache.draft = '';
    cache.scriptDraft = null;
    cache.promptDraft = {};
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
    cache.error = '';
    cache.draft = '';
    await reload();
    scrollTo = 'top';        // 一节一页：进这一局落在当前这一节的开头
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
        // 剧本级的两块提示词：**现读**，所以剧本页改完下一轮就生效（已经写出来的节不动）
        prompts: cache.script.prompts
    });

    cache.error = '';
    cache.draft = '';
    cache.degraded = prompt.meta.degradedTurns;

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
                systemPrompt: prompt.systemPrompt,
                userContent: prompt.userContent,
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
            <button class="tg-head-btn" data-tg-act="toggle-import">${view.importOpen ? '收起' : '＋ 导入'}</button>
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
            ${cache.degraded > 0 ? `<div class="tg-note">剧情很长，较早的旁白在提示词里已折叠（不影响你看到的记录）。</div>` : ''}
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
        <div class="tg-menu">
            <button class="tg-menu-item" data-tg-act="rename-play">✏️ 改这一局的名字</button>
            <button class="tg-menu-item" data-tg-act="toggle-free">${free ? '✅' : '⬜'} 自由模式：正文当 HTML 画</button>
            <div class="tg-menu-note">普通模式 = 正文按文字格式 md 解析（认得出的 HTML 标签先剥掉）。自由模式 = 正文里的 HTML 直接画进沙箱还原美化（脚本不执行）。同一段正文两种画法，跟着这个剧本走，切了立刻重画。</div>
            ${refLine ? `<div class="tg-menu-note">${refLine}</div>` : ''}
            <button class="tg-menu-item danger" data-tg-act="delete-play" data-play-id="${play.id}">🗑️ 删掉这一局</button>
        </div>
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

/**
 * 把每个沙箱框撑到它内容的高度。
 * srcdoc 是**异步**加载的：刚画完那一刻 contentDocument 还是空白页（量出来 0），所以
 * 除了当场量一次，还要挂一次 load；空白页那一下直接跳过，别把框压成 0 高。
 * 撑高之后如果原本就贴着底，跟着挪到底——不然新生成的那一节会有一部分藏在折叠线下面。
 */
function fitFreeFrames(root) {
    for (const box of root.querySelectorAll('[data-tg-free]')) {
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

    pageGen += 1;
    currentContainer.innerHTML = renderPage();
    bindEvents(currentContainer, {});
    afterRender(keepTop);
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
    if (view.page === 'list') return false;   // 交还给路由，回桌面

    currentContainer = container || currentContainer;
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
}

async function onRootChange(event) {
    const fileInput = event.target.closest('[data-tg-file]');
    if (!fileInput || !fileInput.files?.length) return;

    const file = fileInput.files[0];
    try {
        const text = await readTextFile(file);
        cache.importText = text;
        if (!cache.importTitle) cache.importTitle = file.name.replace(/\.[^.]+$/, '');
        rerender();
        toast(`已读入 ${file.name}`);
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
            currentContainer.querySelector('[data-tg-file]')?.click();
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
    // 跟默认逐字相同（或全空白）就记成「没动过」——记录里只留你真正改出来的那段字
    now[key].text = promptsSaveValue(cache.promptDraft[key], block.fallback);
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

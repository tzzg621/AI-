// apps/games/textAdventure.js — 通用文游引擎（整页模式：选项式 + 自由输入 + 页数跳转 + 手动结尾 + 内置设置）
// 状态存 sessionStorage（会话级：切页/关窗重进不丢，关页自动清）；手动结尾才存回忆录（数据只存一份）
import { esc } from '../../store/utils.js';
import { saveProfile, saveStory, getAdvSession, saveAdvSession, deleteAdvSession } from './simCityStore.js';
import { taskManager } from '../../store/AITaskManager.js';

// ★ 双写：正文（pages等）→ IndexedDB ；标记 → sessionStorage（同 key 存 '1'，供同步检测🎭）
async function saveAdvState(key, state) {
    try { await saveAdvSession({ id: key, ...state }); } catch (e) { }
    try { sessionStorage.setItem(key, '1'); } catch (e) { }
}
async function loadAdvState(key) {
    try {
        const adv = await getAdvSession(key);
        if (adv) return adv;
        const s = sessionStorage.getItem(key);
        if (s && s.startsWith('{')) {
            const st = JSON.parse(s);
            await saveAdvState(key, st);
            return st;
        }
    } catch (e) { }
    return null;
}
async function clearAdvState(key) {
    try { await deleteAdvSession(key); } catch (e) { }
    try { sessionStorage.removeItem(key); } catch (e) { }
}

// ★ 引擎内置设定（提示词顺序的第 2 层）
const BUILTIN_PROMPT = '这是"模拟小城"世界：一座由角色们共同生活的虚拟小城。你是这里的居民，拥有自己的身份、性格与日常，言行自然，像真人一样生活。';

// ★ 进程内进行中的文游请求（key → {roundId, promise}）：恢复时若请求仍在飞则不重发
const inflightAdv = new Map();

// ★ 通用文游引擎
// opts: { title, icon, placeName, roleId, profile（可选：选项数值修正）, prompt, saveStoryType,
//         place（{name,desc,ambienceText}）, charInfo（角色详情）, placePresets（地点预设）, placeWorldbook（地点世界书）, onDone, onExit, toast }
// 恢复：resumeKey = `${roleId}_${placeKey}`（切页/关窗重进找回进行中的文游；退出不结束=状态保留）
export async function runTextAdventure(container, opts, resumeKey) {
    const { roleId, profile } = opts;
    const key = resumeKey || `${opts.roleId}_${opts.placeKey || 'adv'}`;
    const saved = resumeKey ? await loadAdvState(resumeKey) : null;

    const state = saved || {
        title: opts.title || '文游', icon: opts.icon || '🎭', placeName: opts.placeName || '',
        roleId: opts.roleId, prompt: opts.prompt || '', saveStoryType: opts.saveStoryType || '',
        pages: [], rounds: 0, pending: null, ended: false,
        // ★ 提示词上下文（设置时生成，随状态保留，恢复时也在）
        worldbookText: '', worldbookIds: [], usePresets: true,
        placePresets: opts.placePresets || '',
        placeWorldbook: opts.placeWorldbook || '',
        envInfo: opts.place ? `${opts.place.name}${opts.place.ambienceText ? '，' + opts.place.ambienceText : ''}${opts.place.desc ? '，' + opts.place.desc : ''}` : (opts.placeName || ''),
        charInfo: opts.charInfo || (profile ? `你是${profile.name}，性格：${((profile.aiProfile?.traits) || []).join('、')}${(profile.worldbook || '').trim() ? '，个人世界书：' + profile.worldbook.trim() : ''}` : '')
    };
    let curPage = Math.max(0, state.pages.length - 1);   // 最新页

    // 整页覆盖（铺满；选项在正文最下方，跟随正文一起滚动）
    const overlay = document.createElement('div');
    overlay.className = 'simcity-pop';
    overlay.style.alignItems = 'stretch';   // ★ 覆盖居中 → 铺满
    overlay.innerHTML = `
        <div class="cc-sheet" style="width:100%;height:100%;max-height:none;border-radius:0;display:flex;flex-direction:column;background:#fff;">
            <div class="cc-head" style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #f0eef6;">
                <div style="font-weight:700;font-size:15px;">${state.icon} ${esc(state.title)}</div>
                <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#999;">
                    <button id="advSettings" style="border:none;background:none;font-size:16px;color:#999;cursor:pointer;">⚙️</button>
                    <button id="advPrev" style="border:none;background:none;font-size:16px;color:#7c4dff;cursor:pointer;">‹</button>
                    <span id="advPageInfo">第 1/1 页</span>
                    <button id="advNext" style="border:none;background:none;font-size:16px;color:#7c4dff;cursor:pointer;">›</button>
                    <button id="advClose" style="border:none;background:none;font-size:18px;color:#999;cursor:pointer;">✕</button>
                </div>
            </div>
            <div id="advBody" style="flex:1;overflow-y:auto;padding:14px;-webkit-overflow-scrolling:touch;">
                <div style="font-size:11px;color:#bbb;margin-bottom:6px;">${esc(state.placeName || '')}${state.rounds ? ` · 已进行 ${state.rounds} 轮` : ''}</div>
                <div id="advScene" style="font-size:13px;line-height:1.9;color:#333;white-space:pre-wrap;"></div>
                <!-- ★ 选项/自由行动/结束：正文最下方，跟随正文滚动 -->
                <div id="advOpts" style="display:flex;flex-direction:column;gap:8px;margin-top:14px;"></div>
                <div id="advCustom" style="margin-top:10px;">
                    <button id="advCustomToggle" style="width:100%;border:none;background:#f2f0f8;color:#666;border-radius:12px;padding:8px;font-size:12px;cursor:pointer;">✍️ 自由行动（展开）</button>
                    <div id="advCustomBox" style="display:none;margin-top:6px;">
                        <div style="display:flex;gap:8px;">
                            <input id="advInput" placeholder="输入你想做的事…" style="flex:1;border:none;background:#f5f3fa;border-radius:16px;padding:9px 12px;font-size:13px;outline:none;">
                            <button id="advSend" style="border:none;background:#7c4dff;color:#fff;border-radius:16px;padding:9px 14px;font-size:13px;cursor:pointer;">行动</button>
                        </div>
                    </div>
                </div>
                <button id="advEnd" style="width:100%;border:none;background:#e8e4f2;color:#7c4dff;border-radius:12px;padding:10px;font-size:13px;font-weight:600;cursor:pointer;margin-top:14px;">🔚 结束文游（存回忆录）</button>
            </div>
        </div>`;
    container.appendChild(overlay);
    const sceneEl = overlay.querySelector('#advScene');
    const optsEl = overlay.querySelector('#advOpts');
    const pageInfo = overlay.querySelector('#advPageInfo');
    const notify = opts.toast || ((m) => console.log('[文游]', m));

    // ★ 渲染指定页（正文 + 是否显示选项）
    const renderPage = (idx) => {
        curPage = Math.max(0, Math.min(state.pages.length - 1, idx));
        // ★ 未开始：不生成，显示"开始"按钮（玩家可先调 ⚙️ 设置）
        if (!state.pages.length && !state.pending) {
            sceneEl.textContent = '（文游还未开始——可以先点右上角 ⚙️ 调整世界书与设置，再开始生成开场场景）';
            pageInfo.textContent = '开始';
            overlay.querySelector('#advPrev').style.visibility = 'hidden';
            overlay.querySelector('#advNext').style.visibility = 'hidden';
            optsEl.innerHTML = `<button class="adv-opt" id="advStartBtn" style="border:none;border-radius:12px;padding:12px;font-size:14px;cursor:pointer;background:#7c4dff;color:#fff;text-align:center;font-weight:600;">▶️ 开始生成开场场景</button>`;
            const sb = overlay.querySelector('#advStartBtn');
            if (sb) sb.addEventListener('click', () => doRound(null));
            return;
        }
        const page = state.pages[curPage];
        sceneEl.textContent = page ? page.text : (state.pending ? '⏳ 生成中…' : '');
        const isLatest = curPage === state.pages.length - 1;
        pageInfo.textContent = state.pages.length ? `第 ${curPage + 1}/${state.pages.length} 页` : '开始';
        overlay.querySelector('#advPrev').style.visibility = curPage > 0 ? 'visible' : 'hidden';
        overlay.querySelector('#advNext').style.visibility = isLatest ? 'hidden' : 'visible';
        renderOpts(isLatest && !state.ended ? (state.pending ? null : (state.options || [])) : [], !isLatest || state.ended || !!state.pending, isLatest);
    };
    // ★ 选项渲染（对象/字符串兼容；仅最新页可点）
    const renderOpts = (options, disabled, latest) => {
        optsEl.innerHTML = (options || []).map((o, i) => {
            const txt = typeof o === 'string' ? o : (o && o.text) || '';
            const hint = (typeof o === 'object' && o && o.hint) || '';
            return `<button class="adv-opt" data-i="${i}" ${disabled ? 'disabled' : ''} style="border:none;border-radius:12px;padding:9px 12px;font-size:13px;cursor:${disabled ? 'default' : 'pointer'};background:${disabled ? '#f0f0f4' : 'rgba(124,77,255,0.1)'};color:#4a3f6b;text-align:left;">
                ${esc(txt)}${hint ? ` <span style="font-size:11px;opacity:0.7;">· ${esc(hint)}</span>` : ''}</button>`;
        }).join('') + (latest && !state.ended && !state.pending ? '<div style="font-size:11px;color:#bbb;text-align:center;margin-top:6px;">✍️ 也可以自由行动，或随时结束</div>' : '');
        overlay.querySelectorAll('.adv-opt').forEach(btn => {
            btn.addEventListener('click', () => {
                const o = (options || [])[parseInt(btn.dataset.i, 10)];
                if (o && !state.ended && !state.pending) doRound(o);
            });
        });
    };

    // ★ 应用选项修正（mood/energy/money）
    const applyMod = async (opt) => {
        if (!profile || !opt) return;
        const { mood = 0, energy = 0, money = 0 } = opt;
        if (mood) profile.mood = Math.max(0, Math.min(100, (profile.mood || 0) + mood));
        if (energy) profile.energy = Math.max(0, Math.min(100, (profile.energy || 0) + energy));
        if (money) profile.money = Math.max(0, (profile.money || 0) + money);
        await saveProfile(profile, roleId).catch(() => { });
    };

    // ★ 每轮 AI（走任务中心，可看进度）
    const callAI = async (action) => {
        const { callAIWithMessages } = await import('../aiService.js');
        const systemPrompt = '你是"模拟小城"的文游叙事引擎。基于【场景设定】与【玩家行动】推进剧情，追求故事性：\n' +
            '1) 开场必须有"钩子"：悬念、异常、冲突或画面感，让玩家立刻想往下走；\n' +
            '2) 每轮 scene 至少包含：环境细节 + 人物反应 + 悬念推进，避免平铺直叙；\n' +
            '3) 剧情要有起伏：玩家调查 2~3 轮后安排一次"发现/意外"（新线索、新角色出现、事件反转），别让剧情原地打转；\n' +
            '4) 这是你一个人的经历，重在个人抉择与代价：每个选择都该有分量，可能影响后续事件与关系；\n' +
            '5) 选项要指向不同线索与方向（现场调查/找人或物/暗中观察/冒险直闯/谨慎撤退等），而不只是性格倾向；\n' +
            '6) 不要替玩家做决定，不要自行收尾（由玩家手动结束）。\n' +
            '每轮只输出 JSON：{"scene":"当前场景/剧情推进（1000~2000字，有画面感）","options":[{"text":"下一步行动","hint":"倾向标签，如冒险/回避/谨慎/智取/大胆/细心/观察/讨好","mood":-10~10,"energy":-10~10,"money":-50~50},...],"ended":false/true,"ending":"ended为true时的收尾语（50字内）"}。' +
            'options 给 3~4 个，覆盖不同倾向且指向不同线索；数值修正代表该选择立即造成的属性变化（无变化写0）；只输出 JSON 对象本身。';

        // ★ 提示词顺序：外部世界书 → 引擎内置 → 地点预设（勾选） → 角色详情 → 地点世界书 → 环境描述 → 文游历史
        const parts = [];
        if (state.worldbookText) parts.push(`【世界书】\n${state.worldbookText}`);
        parts.push(`【内置设定】\n${BUILTIN_PROMPT}`);
        if (state.usePresets !== false && state.placePresets) parts.push(`【地点预设】\n${state.placePresets}`);
        if (state.charInfo) parts.push(`【角色】\n${state.charInfo}`);
        if (state.placeWorldbook) parts.push(`【地点世界书】\n${state.placeWorldbook}`);
        if (state.envInfo) parts.push(`【当前环境】\n${state.envInfo}`);
        if (state.prompt) parts.push(`【事件背景】\n${state.prompt}`);   // ★ 补上：事件文本+你的决定 真正进文游
        if (state.pages.length) parts.push(`【剧情历史】\n${state.pages.map((p, i) => `${i + 1}. ${p.action ? '行动：' + p.action + (p.hint ? `（${p.hint}）` : '') + '\n' : ''}${p.text}`).join('\n\n')}`);
        parts.push(action ? `【玩家行动】\n${action}` : '【开始】生成开场场景。');
        parts.push('请推进剧情。');
        const userContent = parts.join('\n\n');
        return await taskManager.watch('cityadv_event', `事件文游 · ${state.title}`, async () => {
            const raw = await callAIWithMessages({ systemPrompt, userContent, maxTokens: 12000, temperature: 0.9 });
            try { const m = raw.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); } catch { }
            return { scene: (raw || '').trim() || '……', options: [], ended: false, ending: '' };
        });
    };

    // ★ 一轮推进（option 对象/字符串/null=开场）
    const doRound = async (action) => {
        if (!overlay.isConnected) return;
        const roundId = Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
        state.pending = { action: typeof action === 'string' ? action : (action && action.text) || '', hint: (typeof action === 'object' && action && action.hint) || '', mod: (typeof action === 'object' && action) ? action : null, roundId };
        await saveAdvState(key, state);
        renderPage(state.pages.length);   // 显示"⏳生成中…"        
        try {
            const optMod = (typeof action === 'object' && action) ? action : null;
            if (optMod) await applyMod(optMod);
            const actionText = typeof action === 'string' ? action : (action && action.text) || '';
            const p = callAI(actionText);
            inflightAdv.set(key, { roundId, promise: p });   // ★ 登记：此 roundId 正在飞
            let res;
            try {
                res = await p;
            } finally {
                if (inflightAdv.get(key)?.roundId === roundId) inflightAdv.delete(key);   // ★ 完成/失败即注销
            }
            // ★ 落库前校验：自己仍是"当前挂起轮"才提交；被新实例接管则放弃
            const latest = await loadAdvState(key);
            if (!latest || !latest.pending || latest.pending.roundId !== roundId) return;
            state.pending = null;
            state.pages.push({ action: actionText, hint: (optMod && optMod.hint) || '', text: (res.scene || '……') + (res.ending ? '\n\n—— ' + res.ending : '') });
            state.rounds++;
            state.options = res.options || [];
            await saveAdvState(key, state);
            if (!overlay.isConnected) return;
            renderPage(state.pages.length - 1);
        } catch (e) {
            const latest = await loadAdvState(key);
            if (!latest || !latest.pending || latest.pending.roundId !== roundId) return;
            state.pending = null;
            state.pages.push({ action: (action && (action.text || action)) || '', text: '❌ ' + (e.message || '生成中断，可重试') });
            await saveAdvState(key, state);
            if (!overlay.isConnected) return;
            renderPage(state.pages.length - 1);
        }
    };


    // ★ 内置设置：加载外部世界书 + 注入选项
    const showAdvSettings = async () => {   // ★ 改 async
        if (state.ended) return;   // ★ 只拦"已结束"，生成中也能开设置
        const setOverlay = document.createElement('div');
        setOverlay.className = 'simcity-pop';
        let wb = [];
        try { const raw = localStorage.getItem('worldbook_entries'); wb = raw ? JSON.parse(raw).filter(e => e.enabled !== false) : []; } catch (e) { }
        wb.sort((a, b) => (b.priority || 1) - (a.priority || 1));
        const checked = (id) => !state.worldbookIds.length || state.worldbookIds.includes(id);
        setOverlay.innerHTML = `
            <div class="simcity-pop-card">
                <div style="font-weight:700;font-size:15px;margin-bottom:10px;">⚙️ 文游设置</div>
                <div style="font-size:12px;color:#666;margin-bottom:6px;">📖 外部世界书（${wb.length} 条，按优先级）：</div>
                <div class="simcity-pop-list" style="max-height:26vh;overflow-y:auto;">
                    ${wb.length ? wb.map(e => `
                        <label style="display:flex;gap:8px;align-items:flex-start;padding:6px 0;border-bottom:1px solid #f5f5f5;font-size:12px;cursor:pointer;">
                            <input type="checkbox" data-wb="${esc(e.id)}" ${checked(e.id) ? 'checked' : ''} style="margin-top:2px;accent-color:#7c4dff;">
                            <span style="flex:1;color:#5a5470;"><b>P${e.priority || 6}</b> ${esc(e.title)} · ${esc(e.text.slice(0, 26))}…</span>
                        </label>`).join('') : '<div style="text-align:center;color:#999;padding:8px 0;">（暂无启用的世界书条目，或数据未加载）</div>'}
                </div>
                <div style="font-size:12px;color:#666;margin:10px 0 6px;">注入选项：</div>
                <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#5a5470;cursor:pointer;">
                    <input type="checkbox" id="wbUsePresets" ${state.usePresets !== false ? 'checked' : ''} style="accent-color:#7c4dff;">
                    <span>注入当前地点预设${state.placePresets ? '' : '（该地点无预设）'}</span>
                </label>
                <div style="display:flex;gap:8px;margin-top:12px;">
                    <button id="wbApply" style="flex:1;border:none;background:#7c4dff;color:#fff;border-radius:12px;padding:10px;font-size:13px;cursor:pointer;">应用</button>
                    <button class="simcity-pop-close" id="wbClose" style="flex:1;margin:0;">关闭</button>
                </div>
            </div>`;
        container.appendChild(setOverlay);
        setOverlay.querySelector('#wbApply').addEventListener('click', async () => {
            const ids = [...setOverlay.querySelectorAll('[data-wb]:checked')].map(c => c.dataset.wb);
            state.worldbookIds = ids;
            state.worldbookText = wb.filter(e => ids.includes(e.id)).map(e => `- 【${e.title}】${e.text}`).join('\n');
            state.usePresets = setOverlay.querySelector('#wbUsePresets').checked;
            await saveAdvState(key, state);
            notify('⚙️ 世界书已应用');
            setOverlay.remove();
        });
        setOverlay.querySelector('#wbClose').addEventListener('click', () => setOverlay.remove());
        setOverlay.addEventListener('click', (e) => { if (e.target === setOverlay) setOverlay.remove(); });
    };

    // ★ 手动结尾：收尾语（AI）+ 存回忆录 + 清理状态
    const endAdv = async () => {
        if (state.ended || state.pending) return;
        state.ended = true;
        await saveAdvState(key, state);
        overlay.querySelector('#advEnd').textContent = '⏳ 收尾中…';
        try {
            const { callAIWithMessages } = await import('../aiService.js');
            const ending = await taskManager.watch('cityadv_event', `收尾 · ${state.title}`, async () => callAIWithMessages({
                systemPrompt: '你是"模拟小城"的文游收尾人。用一段50字内的文字，为这段经历画上句号（可以是回味、感悟或约定）。只输出文字本身。',
                userContent: `经历：\n${state.pages.map(p => p.text).join('\n')}`,
                maxTokens: 200, temperature: 0.8
            }));
            const endTxt = (ending || '').trim().slice(0, 80);
            if (endTxt) { state.pages.push({ action: '', text: '—— ' + endTxt }); sceneEl.textContent = state.pages[state.pages.length - 1].text; }
            if (state.saveStoryType) {
                await saveStory({
                    id: 'st_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
                    type: state.saveStoryType, participants: [roleId],
                    summary: endTxt || (state.pages[state.pages.length - 1] || {}).text.slice(0, 40),
                    text: state.pages.map((p, i) => `${i + 1}. ${p.action ? '行动：' + p.action + (p.hint ? `（${p.hint}）` : '') + '\n' : ''}${p.text}`).join('\n\n'),
                    timestamp: Date.now()
                });
            }
            await clearAdvState(key);
            notify(`📖 「${state.title}」已存入回忆录`);
        } catch (e) { notify('❌ 收尾失败，已保存当前进度'); }
        overlay.remove();
        if (opts.onDone) opts.onDone();
    };

    // 绑定
    overlay.querySelector('#advSettings').addEventListener('click', showAdvSettings);
    overlay.querySelector('#advClose').addEventListener('click', () => {
        overlay.remove();
        if (opts.onExit) opts.onExit();   // ★ 退出不结束：重渲染场景 → 感叹号显示🎭
    });
    overlay.querySelector('#advPrev').addEventListener('click', () => renderPage(curPage - 1));
    overlay.querySelector('#advNext').addEventListener('click', () => renderPage(curPage + 1));
    overlay.querySelector('#advEnd').addEventListener('click', endAdv);
    overlay.querySelector('#advCustomToggle').addEventListener('click', () => {
        const box = overlay.querySelector('#advCustomBox');
        const show = box.style.display === 'none';
        box.style.display = show ? 'flex' : 'none';
        overlay.querySelector('#advCustomToggle').textContent = show ? '✍️ 自由行动（收起）' : '✍️ 自由行动（展开）';
    });
    overlay.querySelector('#advSend').addEventListener('click', () => {
        const v = (overlay.querySelector('#advInput').value || '').trim();
        if (!v || state.ended || state.pending) return;
        overlay.querySelector('#advInput').value = '';
        doRound(v);
    });
    overlay.querySelector('#advInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') overlay.querySelector('#advSend').click(); });

    // 开场/恢复
    if (!state.pages.length && !state.pending) renderPage(0);   // ★ 等待玩家点"开始"，不自动生成
    else {
        renderPage(state.pages.length - 1);
        if (state.pending) {
            const inflight = inflightAdv.get(key);
            if (inflight && inflight.roundId === state.pending.roundId) {
                // ★ 上一次请求仍在飞：不重发，等它完成落库后刷新
                sceneEl.textContent = '⏳ 生成中…（上一次请求仍在进行，等待完成…）';
                optsEl.innerHTML = '';
                const refresh = async () => {   // ★ 改 async
                    if (!overlay.isConnected) return;
                    const latest = await loadAdvState(key);
                    if (latest) { Object.assign(state, latest); renderPage(state.pages.length - 1); }
                };
                inflight.promise.then(refresh, refresh);
            } else {
                // ★ 旧请求已死（刷新/中断）：不自动重发，玩家点"重试"才重发
                const act = state.pending.action;
                sceneEl.textContent = '⏸ 上一次生成中断了。可以重试刚才的行动，或直接进行其他操作。';
                optsEl.innerHTML = `<button class="adv-opt" id="advRetryBtn" style="border:none;border-radius:12px;padding:10px 12px;font-size:13px;cursor:pointer;background:rgba(124,77,255,0.1);color:#4a3f6b;text-align:left;">🔄 重试刚才的行动${act ? '：' + esc(act.slice(0, 24)) + (act.length > 24 ? '…' : '') : ''}</button>`;
                const rb = overlay.querySelector('#advRetryBtn');
                if (rb) rb.addEventListener('click', () => {
                    doRound(act ? (state.pending.hint ? { text: act, hint: state.pending.hint } : act) : null);
                });
            }
        }
    }
}

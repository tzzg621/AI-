// apps/games/textAdventure.js — 通用文游引擎（选项式 + 可展开自由输入）
// 任何"文游类"模式调用；AI 生成玩法数据（mode/prompt），引擎按 mode 执行
import { esc } from '../../store/utils.js';
import { saveStory } from './simCityStore.js';

// ★ 通用文游引擎
// opts: { title, icon, placeName, roleId, prompt（AI场景素材）, maxRounds=5, saveStoryType, onDone }
export async function runTextAdventure(container, opts) {
    const { title, icon, placeName, roleId, prompt, maxRounds = 5, saveStoryType, onDone } = opts;
    const hour = new Date().getHours();
    const history = [];   // 文游历史（场景+行动，收尾存回忆册）
    let rounds = 0;

    const overlay = document.createElement('div');
    overlay.className = 'simcity-pop';
    overlay.innerHTML = `
        <div class="simcity-pop-card">
            <div style="font-weight:700;font-size:15px;margin-bottom:4px;">${icon || '🎭'} ${esc(title || '文游')}</div>
            <div style="font-size:12px;color:#999;margin-bottom:10px;">${esc(placeName || '')} · ${hour}:00</div>
            <div id="advScene" style="font-size:13px;line-height:1.8;color:#333;white-space:pre-wrap;min-height:120px;max-height:46vh;overflow-y:auto;padding:10px;background:#faf8f5;border-radius:12px;">⏳ 生成中…</div>
            <div id="advOpts" style="display:flex;flex-direction:column;gap:8px;margin-top:10px;"></div>
            <div id="advCustom" style="margin-top:8px;">
                <button id="advCustomToggle" style="width:100%;border:none;background:#f2f0f8;color:#666;border-radius:12px;padding:8px;font-size:12px;cursor:pointer;">✍️ 自由行动（展开）</button>
                <div id="advCustomBox" style="display:none;margin-top:6px;">
                    <div style="display:flex;gap:8px;">
                        <input id="advInput" placeholder="输入你想做的事…" style="flex:1;border:none;background:#f5f3fa;border-radius:16px;padding:9px 12px;font-size:13px;outline:none;">
                        <button id="advSend" style="border:none;background:#7c4dff;color:#fff;border-radius:16px;padding:9px 14px;font-size:13px;cursor:pointer;">行动</button>
                    </div>
                </div>
            </div>
            <button class="simcity-pop-close" id="advClose">退出</button>
        </div>`;
    container.appendChild(overlay);
    overlay.querySelector('#advClose').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#advCustomToggle').addEventListener('click', () => {
        const box = overlay.querySelector('#advCustomBox');
        const show = box.style.display === 'none';
        box.style.display = show ? 'flex' : 'none';
        overlay.querySelector('#advCustomToggle').textContent = show ? '✍️ 自由行动（收起）' : '✍️ 自由行动（展开）';
    });

    const sceneEl = overlay.querySelector('#advScene');
    const optsEl = overlay.querySelector('#advOpts');
    const appendScene = (txt) => {
        sceneEl.textContent = (sceneEl.textContent === '⏳ 生成中…' ? '' : sceneEl.textContent) + (sceneEl.textContent ? '\n\n' : '') + txt;
        sceneEl.scrollTop = sceneEl.scrollHeight;
    };
    const renderOpts = (options, disabled) => {
        optsEl.innerHTML = (options || []).map((o, i) => `
            <button class="adv-opt" data-i="${i}" ${disabled ? 'disabled' : ''} style="border:none;border-radius:12px;padding:9px 12px;font-size:13px;cursor:${disabled ? 'default' : 'pointer'};background:${disabled ? '#f0f0f4' : 'rgba(124,77,255,0.1)'};color:#4a3f6b;text-align:left;">${esc(o)}</button>`).join('')
            || '<div style="text-align:center;color:#999;font-size:12px;padding:6px 0;">（剧情即将收尾）</div>';
        overlay.querySelectorAll('.adv-opt').forEach(btn => {
            btn.addEventListener('click', () => {
                const o = options[parseInt(btn.dataset.i, 10)];
                if (o) doRound(o);
            });
        });
    };

    // ★ 每轮：AI 基于历史 + 玩家行动推进，输出 JSON（场景 + 选项 + 是否结束）
    const callAI = async (action) => {
        const { callAIWithMessages } = await import('../aiService.js');
        const systemPrompt = '你是"模拟小城"的文游叙事引擎。基于【场景设定】与【玩家行动】推进剧情。' +
            '每轮只输出 JSON：{"scene":"当前场景/剧情推进（含对玩家上一轮行动的反馈，80~150字，有画面感）","options":["2~3个下一步行动选项，方向要有区分度"],"ended":false/true,"ending":"ended为true时的收尾语（50字内）"}。' +
            '剧情生动自然，像小说片段；玩家自由输入的行动要合理回应；不要替玩家做决定；' +
            '根据剧情自然收尾（2~4轮），收尾时 ended=true 并给出 ending。只输出 JSON 对象本身。';
        const userContent = `【场景设定】\n${prompt || '（一个普通的场景）'}\n\n` +
            (history.length ? `【剧情历史】\n${history.join('\n')}\n\n` : '') +
            (action ? `【玩家行动】\n${action}\n\n` : '【开始】生成开场场景。') +
            '请推进剧情。';
        const raw = await callAIWithMessages({ systemPrompt, userContent, maxTokens: 2000, temperature: 0.9 });
        try { const m = raw.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); } catch { }
        return { scene: (raw || '').trim() || '……', options: [], ended: false, ending: '' };
    };

    const doRound = async (action) => {
        if (!overlay.isConnected) return;
        renderOpts(null, true);
        try {
            const res = await callAI(action);
            if (!overlay.isConnected) return;
            appendScene(res.scene || '……');
            history.push((action ? `行动：${action}` : '开始') + `\n${res.scene}`);
            rounds++;
            if (res.ended || rounds >= maxRounds) {
                if (res.ending) appendScene(`\n—— ${res.ending}`);
                if (saveStoryType) {
                    await saveStory({
                        id: 'st_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
                        type: saveStoryType, participants: [roleId],
                        summary: res.ending || (res.scene || '').slice(0, 40),
                        text: history.join('\n\n'), timestamp: Date.now()
                    });
                }
                renderOpts([], true);
                if (onDone) onDone();
                return;
            }
            renderOpts(res.options || [], false);
        } catch (e) {
            appendScene('❌ ' + (e.message || '文游中断'));
            renderOpts([], true);
        }
    };

    overlay.querySelector('#advSend').addEventListener('click', () => {
        const v = (overlay.querySelector('#advInput').value || '').trim();
        if (!v) return;
        overlay.querySelector('#advInput').value = '';
        doRound(v);
    });
    overlay.querySelector('#advInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') overlay.querySelector('#advSend').click(); });

    doRound(null);   // 开场
    return overlay;
}

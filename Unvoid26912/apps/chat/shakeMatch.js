// apps/chat/shakeMatch.js — 摇一摇：匿名匹配聊天
// 三种池子：纯陌生人（AI生成临时人设，无id，人设存对话key）/ 好友 / 非好友
// 数据：shakeDB / store: conversations；收藏（starredBy）防清理；
// 清理：当前主视角主动匹配时，刷掉TA参与（发起或接收）且未被任何收藏的对话
// 任务：initiatorTask（给发起者）/ receiverTask（给接收者），按"当前发送者的另一方"动态归属与判定
import { CharacterStore } from '../../store/CharacterStore.js';
import { getCharacterNameById } from '../characterManager.js';
import { esc } from '../../store/utils.js';
import { isArchived } from '../roleData.js';
import { taskManager } from '../../store/AITaskManager.js';

// ============================================================
//  IndexedDB：shakeDB / conversations
// ============================================================
const DB_NAME = 'shakeDB';
const DB_VERSION = 1;
const STORE = 'conversations';
let dbPromise = null;

function openShakeDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
    });
    return dbPromise;
}

async function getAllConvs() {
    const db = await openShakeDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
    });
}

function saveConv(cv) {
    return openShakeDB().then((db) => new Promise((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(cv);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
    }));
}

function deleteConv(id) {
    return openShakeDB().then((db) => new Promise((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
    }));
}

// ============================================================
//  工具：角色池 / 陌生人生成
// ============================================================

function getAllRoles() {
    const out = [];
    try {
        JSON.parse(localStorage.getItem('rolebook_characters') || '[]')
            .forEach(c => { if (!isArchived(c.id)) out.push(c); });
    } catch { }
    try {
        JSON.parse(localStorage.getItem('worldnet_extra_characters') || '[]')
            .forEach(c => { if (!isArchived(c.id)) out.push(c); });
    } catch { }
    return out;
}

function poolFor(activeId, type) {
    const me = new CharacterStore(activeId);
    const friends = me.getFriendIds();
    const all = getAllRoles();
    if (type === 'friend') return all.filter(c => friends.includes(c.id));
    return all.filter(c => !friends.includes(c.id) && c.id !== activeId);
}

// ★ 纯陌生人：AI 按配置生成临时人设（无id，存对话 receiverProfile）
async function generateStrangerProfile(config) {
    const { callAIWithMessages } = await import('../aiService.js');
    const systemPrompt = '你是一个模拟手机应用中线上陌生人匹配聊天玩法的角色生成器。根据要求生成一个完整的神秘陌生人设定（TA有真实的自我认知，只是在线上摇一摇功能中与陌生人聊天时匿名）。' +
        '只输出 JSON 对象本身，不要任何其他文字、不要 markdown。';
    const userContent = `话题/氛围/目标：${config.topic || '随意'} / ${config.mood || '随意'} / ${config.goal || '随意'}` +
        (config.custom ? `\n补充说明：${config.custom}` : '') +
        `\n\n请生成以下结构的 JSON：
{
  "name": "内部身份名（绝不对外显示，如'阿夜'）",
  "gender": "性别",
  "age": "年龄（简短，如22岁/少年/古老的存在）",
  "desc": "一句话概括这个人的气质（1~2句）",
  "detail": "详细设定：自我认知、过去经历、性格、人格类型（1000字内，丰富自然）",
  "style": "说话风格（口语化描述）",
  "secret": "一个不愿说的内心秘密（除非被信任，否则绝口不提）",
  "tag": "一个简短标签（如：都市夜归人）",
  "memories": [{"time":"时间或时期","content":"一段塑造TA的经历"}]
}`;
    const raw = await callAIWithMessages({ systemPrompt, userContent, maxTokens: 8000, temperature: 0.9 });
    try {
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) return JSON.parse(m[0]);
    } catch { }
    return { name: '神秘人', gender: '未知', age: '', desc: '一个神秘的存在', detail: '', style: '神秘而简短', secret: '', tag: '', memories: [] };
}

// ★ 匹配：纯陌生人 → 生成人设；好友/非好友 → 随机挑真实角色
async function doMatch(activeId, pools, config) {
    const types = pools.filter(p => p.on);
    if (!types.length) return { error: '请至少选择一个匹配池' };
    const type = types[Math.floor(Math.random() * types.length)].type;
    if (type === 'stranger') {
        const profile = await generateStrangerProfile(config);
        return { type, receiverId: null, receiverProfile: profile, title: '🎭 神秘陌生人' };
    }
    const pool = poolFor(activeId, type);
    if (!pool.length) return { error: type === 'friend' ? '暂无好友可匹配' : '暂无非好友角色可匹配' };
    const pick = pool[Math.floor(Math.random() * pool.length)];
    return { type, receiverId: pick.id, receiverProfile: null, title: getCharacterNameById(pick.id) };
}

// ★ 破冰任务生成（匹配成功时）：initiatorTask（给发起者）+ receiverTask（给接收者），各自保密
async function generateIcebreakerTasks(cfg, who) {
    const { callAIWithMessages } = await import('../aiService.js');
    const systemPrompt = '你是"摇一摇"匿名匹配的破冰任务生成器。为刚匹配成功的一对陌生人生成【两个】任务：initiatorTask（给发起者）+ receiverTask（给接收者）。' +
        '任务形态：' +
        '① 词语任务（推荐，可玩性最高）：目标 = 引导对方说出某个词/短语（如"让对方说出「流星」"），任务必须带"target"（目标词）；' +
        '   引导方自己【绝不能】说出 target（否则任务失败），怎么诱导对方说出来是引导方自己的事。' +
        '② 其他任务：问句数（rule count+kind:question）、消息数（rule count+kind:message）、双方聊开（rule both）。' +
        '【禁止】生成"描述物体让对方猜"这类需要双方共享答案的猜词游戏。' +
        'initiatorTask 由发起者引导、完成看接收者发言；receiverTask 由接收者引导、完成看发起者发言。' +
        '每个任务带 rule（完成判定）+ 可选的 target（词语任务的目标词，其余任务无）：' +
        '- {"rule":"mention","words":["目标词"]}：指定方发言出现目标词即完成（词语任务用，words=[target]）\n' +
        '- {"rule":"count","kind":"question","min":3} / {"rule":"count","kind":"message","min":4} / {"rule":"both","minEach":2}\n' +
        '- {"rule":"emoji","min":3}：指定方最近连续 min 条消息只含 emoji（如 desc"接下来只能用表情包聊3轮" → min:3）\n' +
        '- {"rule":"affinity","min":10}：好感度玩法——AI每轮给对方（当前发送者）的表现打好感分（-1~3，累计进对话好感度，不关是谁打的分），累计达到 min 即完成（如 desc"聊到好感度10分" → min:10）\n' +
        '两个任务可以相互配合（如一方任务让对方说"雨"，另一方任务正好让对方说"伞"），也可以完全独立。' +
        '只输出 JSON 对象本身。';
    const userContent = `话题/氛围/目标：${cfg.topic || '随意'} / ${cfg.mood || '随意'} / ${cfg.goal || '随意'}` +
        (cfg.custom ? `\n补充说明：${cfg.custom}` : '') +
        (who && who.desc ? `\n对方气质：${who.desc}` : '') +
        `\n\n请生成：{"initiatorTask":{"type":"word|other","icon":"emoji","title":"任务名","desc":"任务描述（词语任务要写明'引导对方说出「target」，你不能自己说出，否则任务失败'）","target":"目标词（词语任务必填）","rule":{...},"done":false,"failed":false},"receiverTask":{同结构}}`;
    const raw = await callAIWithMessages({ systemPrompt, userContent, maxTokens: 3000, temperature: 1.0 });
    try { const m = raw.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); } catch { }
    return {
        initiatorTask: { type: 'word', icon: '🔑', title: '让对方说出「流星」', desc: '引导对方说出「流星」，你不能自己说出这个词，否则任务失败', target: '流星', rule: { rule: 'mention', words: ['流星'] }, done: false, failed: false },
        receiverTask: { type: 'word', icon: '🔑', title: '让对方说出「晚安」', desc: '引导对方说出「晚安」，你不能自己说出这个词，否则任务失败', target: '晚安', rule: { rule: 'mention', words: ['晚安'] }, done: false, failed: false }
    };
}

// ★ 任务完成判定：按结构化 rule 解析【指定方】的发言（watchFrom：'mystery'=AI方 或 玩家id）
function checkRuleDone(rule, msgs, watchFrom) {
    if (!rule) return false;
    if (rule.rule === 'both') {
        const mine = (msgs || []).filter(m => m.from !== 'mystery' && m.from !== 'system').length;
        const theirs = (msgs || []).filter(m => m.from === 'mystery').length;
        return mine >= (rule.minEach || 1) && theirs >= (rule.minEach || 1);
    }
    // ★ emoji-only：指定方最近连续 min 条消息只含 emoji
    if (rule.rule === 'emoji') {
        const n = rule.min || 3;
        const pool = (msgs || []).filter(m => m.from === watchFrom).slice(-n);
        return pool.length >= n && pool.every(m => /^[\p{Emoji_Presentation}\p{Emoji}\s]+$/u.test((m.text || '').trim()));
    }
    const pool = (msgs || []).filter(m => m.from === watchFrom);
    const texts = pool.map(m => m.text || '').join('\n');
    if (rule.rule === 'mention') {
        const words = Array.isArray(rule.words) ? rule.words : (rule.word ? [rule.word] : []);
        return words.some(w => w && texts.includes(w));
    }
    if (rule.rule === 'count') {
        const cpool = rule.kind === 'question'
            ? pool.filter(m => /[?？]$/.test((m.text || '').trim()) || /吗|呢|怎么样/.test(m.text || ''))
            : pool;
        return cpool.length >= (rule.min || 1);
    }
    return false;
}

// ★ 我的任务 / 对方的任务（按当前主视角动态归属，支持视角对换）
function myTaskOf(cv, activeId) {
    if (!cv.task) return null;
    if (cv.receiverId && activeId === cv.receiverId) return cv.task.receiverTask || null;
    return cv.task.initiatorTask || cv.task.mine || cv.task || null;
}
function otherTaskOf(cv, activeId) {
    if (!cv.task) return null;
    if (activeId === cv.initiatorId) return cv.task.receiverTask || cv.task.theirs || null;
    return cv.task.initiatorTask || cv.task.mine || null;
}

// ★ 检查双方任务：initiatorTask 看接收者发言、receiverTask 看发起者发言（动态判断）；提示按当前视角
async function checkTasks(cv, activeId) {
    if (!cv.task) return false;
    const iAmInitiator = activeId === cv.initiatorId;
    let changed = false;
    for (const key of ['initiatorTask', 'receiverTask']) {
        const t = cv.task[key];
        if (!t || t.done || t.failed) continue;
        // ★ 好感度玩法：累计总分达标即完成（不关是谁打的分，任务归属固定）
        if (t.rule && t.rule.rule === 'affinity') {
            if ((cv.affinity || 0) >= (t.rule.min || 5)) {
                t.done = true;
                cv.messages.push({ from: 'system', text: `✅ 好感度达到 ${t.rule.min}，「${t.title}」完成！`, time: Date.now() });
                changed = true;
            }
            continue;
        }
        const watchFrom = (key === 'initiatorTask')
            ? (iAmInitiator ? 'mystery' : activeId)
            : (iAmInitiator ? activeId : 'mystery');
        const isMine = (key === 'initiatorTask' && iAmInitiator) || (key === 'receiverTask' && !iAmInitiator);
        // ★ 失败：引导方（持有者）自己先说出了 target（且对方还没说出）
        if (t.target) {
            const holderSide = (key === 'initiatorTask') ? cv.initiatorId : (cv.receiverId || 'mystery');   // 任务持有者
            const selfSaid = (cv.messages || []).some(m => m.from === holderSide && (m.text || '').includes(t.target));
            if (selfSaid) {
                t.failed = true;
                cv.messages.push({ from: 'system', text: `❌ ${isMine ? '你的' : '对方的'}任务失败：「${t.title}」`, time: Date.now() });
                changed = true;
                continue;
            }
        }
        // ★ 完成：指定方说出目标词 / 满足规则
        if (checkRuleDone(t.rule, cv.messages, watchFrom)) {
            t.done = true;
            cv.messages.push({ from: 'system', text: `✅ ${isMine ? '你' : '对方'}完成了任务：「${t.title}」`, time: Date.now() });
            changed = true;
        }
    }
    if (changed) { cv.lastActive = Date.now(); await saveConv(cv); }
    return changed;
}

// ============================================================
//  清理：当前主视角参与的、未收藏的对话（每次主动匹配时）
// ============================================================
async function cleanupUnstarred(activeId) {
    const all = await getAllConvs();
    let changed = false;
    for (const cv of all) {
        const mine = cv.initiatorId === activeId || cv.receiverId === activeId;
        const starred = (cv.starredBy || []).length > 0;
        if (mine && !starred) { await deleteConv(cv.id); changed = true; }
    }
    return changed;
}

// ============================================================
//  入口
// ============================================================
export function start(overlay, globalState, onBack) {
    overlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:320;background:#f7f5ff;display:flex;flex-direction:column;overflow:hidden;';
    renderMain(overlay, globalState, onBack);
    return overlay;
}

// ============================================================
//  主页面：池子选择 + 配置 + 对话列表
// ============================================================
let poolsState = [
    { type: 'stranger', label: '🎭 纯陌生人', on: true },
    { type: 'friend', label: '👥 好友池', on: true },
    { type: 'nonfriend', label: '🌐 非好友池', on: true },
];
let configState = { topic: '', mood: '', goal: '', custom: '' };
let taskCollapsed = false;   // ★ 任务卡折叠状态（不随对话滚动，可折叠）

async function renderMain(overlay, globalState, onBack) {
    const { getActiveCharacterId } = await import('../../store/CharacterStore.js');
    const activeId = getActiveCharacterId(globalState);
    const convs = (await getAllConvs())
        .filter(c => c.initiatorId === activeId || c.receiverId === activeId)
        .sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));

    overlay.innerHTML = `
        <div style="background:white;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
            <button id="shakeBack" style="border:none;background:none;font-size:18px;color:#666;cursor:pointer;">←</button>
            <span style="font-weight:700;font-size:16px;">🎲 摇一摇</span>
            <span style="width:30px;"></span>
        </div>
        <div style="flex:1;overflow-y:auto;padding:14px;">
            <div style="background:white;border-radius:16px;padding:14px;margin-bottom:12px;">
                <div style="font-size:13px;font-weight:700;color:#555;margin-bottom:8px;">匹配池（可多选）</div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                    ${poolsState.map(p => `
                        <button class="shake-pool" data-type="${p.type}" style="border:none;border-radius:14px;padding:8px 14px;font-size:13px;cursor:pointer;background:${p.on ? '#7c4dff' : '#f0f0f4'};color:${p.on ? '#fff' : '#666'};">${p.label}</button>`).join('')}
                </div>
            </div>
            <div style="background:white;border-radius:16px;padding:14px;margin-bottom:12px;">
                <div style="font-size:13px;font-weight:700;color:#555;margin-bottom:8px;">聊天配置</div>
                <input id="shakeTopic" placeholder="话题（如：深夜食堂）" value="${esc(configState.topic)}" style="width:100%;box-sizing:border-box;border:1px solid #eee;border-radius:12px;padding:9px 12px;font-size:13px;margin-bottom:8px;">
                <input id="shakeMood" placeholder="氛围（如：雨夜便利店 / 深夜电台 / 末班车）" value="${esc(configState.mood)}" style="width:100%;box-sizing:border-box;border:1px solid #eee;border-radius:12px;padding:9px 12px;font-size:13px;margin-bottom:8px;">
                <input id="shakeGoal" placeholder="目标（如：交个朋友）" value="${esc(configState.goal)}" style="width:100%;box-sizing:border-box;border:1px solid #eee;border-radius:12px;padding:9px 12px;font-size:13px;margin-bottom:8px;">                
                <input id="shakeCustom" placeholder="补充说明（可选）" value="${esc(configState.custom)}" style="width:100%;box-sizing:border-box;border:1px solid #eee;border-radius:12px;padding:9px 12px;font-size:13px;">
                <button id="shakeMatchBtn" style="width:100%;margin-top:12px;padding:12px;border-radius:20px;border:none;cursor:pointer;background:linear-gradient(135deg,#7c4dff,#9c27b0);color:white;font-size:15px;font-weight:700;">🎲 摇一摇匹配</button>
            </div>
            <div style="font-size:13px;font-weight:700;color:#555;margin:4px 2px 8px;">历史对话（未收藏会在下次匹配时清理）</div>
            ${convs.length === 0 ? '<div style="text-align:center;color:#999;padding:24px 0;">暂无对话，摇一摇开始吧</div>' : ''}
            ${convs.map(cv => `
                <div class="shake-conv" data-id="${esc(cv.id)}" style="background:white;border-radius:14px;padding:12px;margin-bottom:8px;display:flex;align-items:center;gap:10px;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,0.05);">
                    <span style="font-size:22px;">🎭</span>
                    <div style="flex:1;min-width:0;">
                        <div style="font-size:14px;font-weight:600;">🎭 神秘人</div>
                        <div style="font-size:11px;color:#999;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc((cv.messages[cv.messages.length - 1] || {}).text || '')}</div>
                    </div>
                    <span style="font-size:11px;color:${(cv.starredBy || []).length ? '#ff9800' : '#bbb'};">${(cv.starredBy || []).length ? '★' : '☆'}</span>
                </div>`).join('')}
        </div>`;

    overlay.querySelector('#shakeBack').addEventListener('click', () => { if (onBack) onBack(); overlay.remove(); });

    overlay.querySelectorAll('.shake-pool').forEach(btn => {
        btn.addEventListener('click', () => {
            const p = poolsState.find(x => x.type === btn.dataset.type);
            p.on = !p.on;
            btn.style.background = p.on ? '#7c4dff' : '#f0f0f4';
            btn.style.color = p.on ? '#fff' : '#666';
        });
    });

    overlay.querySelector('#shakeMatchBtn').addEventListener('click', async () => {
        configState = {
            topic: overlay.querySelector('#shakeTopic').value.trim(),
            mood: overlay.querySelector('#shakeMood').value.trim(),
            goal: overlay.querySelector('#shakeGoal').value.trim(),
            custom: overlay.querySelector('#shakeCustom').value.trim()
        };
        const btn = overlay.querySelector('#shakeMatchBtn');
        btn.disabled = true; btn.textContent = '⏳ 匹配中…';
        try {
            await cleanupUnstarred(activeId);
            const match = await doMatch(activeId, poolsState, configState);
            if (match.error) { toast(match.error, '#ff9800'); return; }
            const task = await generateIcebreakerTasks(configState, match.receiverProfile || null);
            const cv = {
                id: 'shake_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
                initiatorId: activeId,
                receiverType: match.type,
                receiverId: match.receiverId,
                receiverProfile: match.receiverProfile,
                config: { ...configState },
                task,
                messages: [],
                starredBy: [],
                createdAt: Date.now(),
                lastActive: Date.now()
            };
            await saveConv(cv);
            renderChat(overlay, globalState, onBack, cv);
        } catch (e) {
            toast(`❌ ${e.message || '匹配失败'}`, '#c62828');
        } finally {
            btn.disabled = false; btn.textContent = '🎲 摇一摇匹配';
        }
    });

    overlay.querySelectorAll('.shake-conv').forEach(el => {
        el.addEventListener('click', async () => {
            const cv = (await getAllConvs()).find(x => x.id === el.dataset.id);
            if (cv) renderChat(overlay, globalState, onBack, cv);
        });
    });
}

// ============================================================
//  聊天窗口（匿名 + AI 回复 + 收藏 + 任务）
// ============================================================
function toast(msg, bg = '#333') {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:${bg};color:#fff;padding:10px 20px;border-radius:12px;z-index:10000;font-size:13px;box-shadow:0 4px 20px rgba(0,0,0,0.2);max-width:80%;text-align:center;`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
}

function chatTitle(cv) {
    return '🎭 神秘人';
}

async function renderChat(overlay, globalState, onBack, cv) {
    const { getActiveCharacterId } = await import('../../store/CharacterStore.js');
    const activeId = getActiveCharacterId(globalState);
    const starred = (cv.starredBy || []).length > 0;
    const myTask = myTaskOf(cv, activeId);
    const affTask = (cv.task && [cv.task.initiatorTask, cv.task.receiverTask].find(t => t && t.rule && t.rule.rule === 'affinity'));

    const msgsHtml = (cv.messages || []).map(m =>
        m.from === 'system'
            ? `<div style="text-align:center;font-size:11px;color:#a8815f;margin:8px 0;">${esc(m.text)}</div>`
            : (m.from === activeId
                ? `<div style="display:flex;flex-direction:column;align-items:flex-end;margin-bottom:10px;"><div style="max-width:72%;padding:9px 13px;font-size:13px;line-height:1.6;border-radius:14px 14px 4px 14px;background:linear-gradient(135deg,#0a7fe0,#0b93f6);color:#fff;">${esc(m.text)}</div></div>`
                : `<div style="display:flex;flex-direction:column;align-items:flex-start;margin-bottom:10px;"><div style="max-width:72%;padding:9px 13px;font-size:13px;line-height:1.6;border-radius:14px 14px 14px 4px;background:#fff;color:#333;box-shadow:0 1px 4px rgba(0,0,0,0.06);">${esc(m.text)}</div></div>`)
    ).join('');

    overlay.innerHTML = `
        <div style="background:white;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
            <button id="shakeChatBack" style="border:none;background:none;font-size:18px;color:#666;cursor:pointer;">←</button>
            <span style="font-weight:700;font-size:15px;">${esc(chatTitle(cv))}</span>
            <button id="shakeStar" style="border:none;background:none;font-size:20px;color:${starred ? '#ff9800' : '#bbb'};cursor:pointer;">${starred ? '★' : '☆'}</button>
        </div>
        <!-- ★ 任务卡：固定区（不随消息滚动），可折叠 -->
        ${myTask ? `
        <div style="flex-shrink:0;padding:10px 12px 0;">
            <div style="background:linear-gradient(135deg,#fdf6ec,#fef9ef);border:1px solid rgba(255,180,80,0.25);border-radius:12px;font-size:13px;">
                <div id="shakeTaskToggle" style="display:flex;align-items:center;gap:6px;padding:10px 12px;cursor:pointer;color:${myTask.failed ? '#bbb' : '#8d6e63'};font-weight:700;">
                    <span>${esc(myTask.icon || '🎯')} 你的任务${myTask.done ? '（✅ 已完成）' : (myTask.failed ? '（❌ 已失败）' : '')} · ${esc(myTask.title || '破冰')}</span>
                    <span style="margin-left:auto;color:#bbb;">${taskCollapsed ? '▸' : '▾'}</span>
                </div>
                <div id="shakeTaskDetail" style="padding:0 12px 10px;color:#6d5a4a;line-height:1.6;${taskCollapsed ? 'display:none;' : ''}">
                    <div>${esc(myTask.desc || '')}</div>
                    ${myTask.target ? `<div style="color:#a8815f;margin-top:3px;">🎯 目标词：${esc(myTask.target)}（你不能自己说出它）</div>` : ''}
                    ${affTask ? `<div style="color:#e91e63;margin-top:4px;">❤️ 好感度：${(cv.affinity || 0)} / ${affTask.rule.min}${affTask.done ? '（已达成）' : ''}</div>` : ''}
                </div>
            </div>
        </div>` : ''}
        <div id="shakeMsgs" style="flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;">
            ${msgsHtml || '<div style="text-align:center;color:#999;padding:24px 0;">开始聊天吧…</div>'}
        </div>
        <div style="display:flex;gap:8px;padding:10px 12px;padding-bottom:calc(10px + env(safe-area-inset-bottom,0px));background:white;border-top:1px solid #f0f0f0;">
            <input id="shakeInput" placeholder="说点什么…" style="flex:1;border:none;background:#f5f3fa;border-radius:20px;padding:10px 14px;font-size:14px;outline:none;">
            <button id="shakeSend" style="border:none;background:linear-gradient(135deg,#7c4dff,#9c27b0);color:#fff;border-radius:20px;padding:10px 18px;font-size:14px;cursor:pointer;">发送</button>
        </div>`;

    overlay.querySelector('#shakeChatBack').addEventListener('click', () => renderMain(overlay, globalState, onBack));
    overlay.querySelector('#shakeStar').addEventListener('click', async () => {
        const cv2 = (await getAllConvs()).find(x => x.id === cv.id);
        if (!cv2) return;
        cv2.starredBy = (cv2.starredBy || []).includes(activeId)
            ? cv2.starredBy.filter(x => x !== activeId)
            : [...(cv2.starredBy || []), activeId];
        await saveConv(cv2);
        renderChat(overlay, globalState, onBack, cv2);
    });
    const taskToggle = overlay.querySelector('#shakeTaskToggle');
    if (taskToggle) taskToggle.addEventListener('click', () => {
        taskCollapsed = !taskCollapsed;
        const detail = overlay.querySelector('#shakeTaskDetail');
        if (detail) detail.style.display = taskCollapsed ? 'none' : 'block';
        const arrow = taskToggle.querySelector('span:last-child');
        if (arrow) arrow.textContent = taskCollapsed ? '▸' : '▾';
    });

    const send = async () => {
        const text = (overlay.querySelector('#shakeInput')?.value || '').trim();
        if (!text) return;
        overlay.querySelector('#shakeInput').value = '';
        const cv2 = (await getAllConvs()).find(x => x.id === cv.id) || cv;
        cv2.messages.push({ from: activeId, text, time: Date.now() });
        cv2.lastActive = Date.now();
        await saveConv(cv2);
        await checkTasks(cv2, activeId);
        renderChat(overlay, globalState, onBack, cv2);
        const sendBtn = overlay.querySelector('#shakeSend');
        sendBtn.disabled = true; sendBtn.textContent = '⏳';
        try {
            await taskManager.watch('shake', `摇一摇回复 · ${chatTitle(cv2)}`, async () => {
                const { callAIWithMessages } = await import('../aiService.js');
                // ★ AI 扮演 = 当前发送者的另一方（支持视角对换）
                const iAmInitiator = activeId === cv2.initiatorId;
                const aiRoleId = iAmInitiator
                    ? cv2.receiverId
                    : cv2.initiatorId;
                const who = aiRoleId
                    ? await buildRealProfile(aiRoleId)
                    : (iAmInitiator ? cv2.receiverProfile || {} : {});
                const cfg = cv2.config || {};
                const hasAffinity = !!((cv2.task && cv2.task.initiatorTask && cv2.task.initiatorTask.rule && cv2.task.initiatorTask.rule.rule === 'affinity') ||
                    (cv2.task && cv2.task.receiverTask && cv2.task.receiverTask.rule && cv2.task.receiverTask.rule.rule === 'affinity'));
                const systemPrompt = '你现在是一个真实的人，深夜的陌生社交里，和一个陌生人聊上了。' +
                    '你叫「' + (who.name || '不愿说名字的人') + '」' +
                    (who.gender ? `，${who.gender}` : '') +
                    (who.age ? `，${who.age}` : '') +
                    (who.desc ? `。${who.desc}` : '。你只是个普通人。') +
                    (who.detail ? `\n你是这样的人：${who.detail}` : '') +
                    (who.style ? `\n你说话的样子：${who.style}` : '') +
                    (who.secret ? `\n你心里藏着的事（不会轻易对人说）：${who.secret}` : '') +
                    (who.memories && who.memories.length ? `\n你的过往：${who.memories.slice(-3).map(x => `- ${x.time || ''}：${x.content}`).join('\n')}` : '') +
                    '\n对方不知道你是谁，你也没打算自我介绍——就像现实里和陌生人在深夜聊起天：' +
                    '聊得投机就多聊几句，感觉不对就敷衍过去；对方问你是谁，你就岔开话头或反问一句。' +
                    '不要加入括号，不要环境描写、不要动作描写，纯线上对话。不要刻意表现自己的身份特征，可以使用emoji表情。' +
                    (otherTaskOf(cv2, activeId) ? `\n你有一件破冰任务要做（根据自身人设决定是否需要努力主动去完成任务。已经完成的话，就自然过去，不必再提）：${otherTaskOf(cv2, activeId).desc}${otherTaskOf(cv2, activeId).target ? `（目标词「${otherTaskOf(cv2, activeId).target}」，你自己绝不能说出它）` : ''}` : '') +
                    (hasAffinity
                        ? '\n【好感度玩法】这是一个好感度任务：每轮回复结束时，给对方（当前发送者）这一轮的表现打一个好感分，' +
                          '在回复末尾单独输出【好感:+n】（如【好感:+2】或【好感:-1】），不要解释。' +
                          '打分范围：-1（反感/敷衍）~ 3（心动/默契），0=无感、1=还行、2=不错、3=心动；' +
                          '好感分请根据对方发言的真诚/有趣/默契程度合理给出，不要每轮都给满分。'
                        : '') +
                    (cfg.topic ? `\n你们聊到的话题：${cfg.topic}` : '') +
                    (cfg.mood ? `\n氛围：${cfg.mood}` : '') +
                    (cfg.goal ? `\n你这次的想法：${cfg.goal}` : '') +
                    (cfg.custom ? `\n其他：${cfg.custom}` : '') +
                    '说话像真人，长短随意，别把每句话都说完整，也别每句都照顾对方感受。';
                const history = (cv2.messages || []).filter(m => m.from !== 'system').slice(-8).map(m => `${m.from === activeId ? '我' : '神秘人'}：${m.text}`).join('\n');
                const raw = await callAIWithMessages({
                    systemPrompt,
                    userContent: `对话历史：\n${history}\n\n请以神秘人的身份回复。`,
                    maxTokens: 800, temperature: 0.85
                });
                const cv3 = (await getAllConvs()).find(x => x.id === cv.id);
                if (!cv3) return;
                const rawText = (raw || '').trim();
                const am = /【好感:([+-]?\d+)】/.exec(rawText);          // ★ 支持负数扣分
                if (am) cv3.affinity = (cv3.affinity || 0) + (parseInt(am[1], 10) || 0);
                const cleanText = rawText.replace(/【好感:([+-]?\d+)】/g, '').trim();
                cv3.messages.push({ from: 'mystery', text: cleanText || '……', time: Date.now() });
                cv3.lastActive = Date.now();
                await saveConv(cv3);
                await checkTasks(cv3, activeId);
            });
        } catch (e) {
            console.warn('摇一摇回复失败:', e);
        } finally {
            const cv4 = (await getAllConvs()).find(x => x.id === cv.id);
            if (cv4) renderChat(overlay, globalState, onBack, cv4);
        }
    };
    overlay.querySelector('#shakeSend').addEventListener('click', send);
    overlay.querySelector('#shakeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    // ★ 自动滚到最新（打开/发消息/AI回复后都滚到底）
    const msgsEl = overlay.querySelector('#shakeMsgs');
    if (msgsEl) { msgsEl.scrollTop = msgsEl.scrollHeight; }

}

// ★ 真实角色 → 聊天用的人设摘要
async function buildRealProfile(roleId) {
    const base = getRoleBase(roleId);
    return {
        name: base.name || '神秘人',
        gender: base.gender || '',
        age: base.age || '',
        desc: base.desc || '',
        detail: base.detail || '',
        style: base.style || '',
        secret: base.secret || ''
    };
}

function getRoleBase(id) {
    if (!id) return {};
    try {
        const f = JSON.parse(localStorage.getItem('rolebook_characters') || '[]').find(c => c.id === id);
        if (f?.base) return f.base;
    } catch { }
    try {
        const f = JSON.parse(localStorage.getItem('worldnet_extra_characters') || '[]').find(c => c.id === id);
        if (f?.base) return f.base;
    } catch { }
    return {};
}

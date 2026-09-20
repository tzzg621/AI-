// apps/textgameAI.js — 文游的 AI 出口与文件读取（txt / md / Word .docx）
//
// 只做「调用 / 超时 / 任务中心登记 / 文本文件解码」，不做提示词组装（那是 textgameCore.js 的事）。
// 提示词红线（改前先读 AI/07）：全链路不出现「用户 / 玩家 / 使用者」。

import { callAIConversation, getDefaultPreset, hasApiKey } from './aiService.js';
import { taskManager } from '../store/AITaskManager.js';
import { DEFAULT_MAX_CONTEXT_CHARS } from './textgameCore.js';

export const DEFAULT_TIMEOUT = 120000;   // 单次调用超时（照占卜/日记/狼人杀口径）

/**
 * 单次调用的输出上限。
 * **按次数计费**时截断 = 这一整次调用白烧：被切掉的往往正是末尾那几行
 * （剧本要的状态栏、选项列法），于是还得再打一次。上限只是上限，用不完不额外计费。
 * 叙事类模块的统一口径（狼人杀 2026-09-13 从 2000 提到 12000）。
 */
export const DEFAULT_MAX_TOKENS = 12000;

export function hasKey() {
    try { return hasApiKey(); } catch { return false; }
}

function withTimeout(promise, ms) {
    let timer = null;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('AI 响应超时')), ms);
        })
    ]).finally(() => clearTimeout(timer));
}

/**
 * 这一轮的总上下文预算（字符）。
 *
 * 读**默认预设**的 `maxContextChars`（设置 → API 预设那个框）——它是「这条 API 吞得下多少」，
 * 换模型时该跟着换。**只在这里读、只给文游用**，不碰预设本身，也不影响别的模块。
 *
 * ⚠️ 口径与常规模块不同：聊天那边这个数只量注入内容（不含 system），
 * 而文游的 system 里装着**整本剧本原文**、可以很长，所以这边是**总上下文**口径
 * （system + 历史一起算，见 textgameCore.pathToMessages）。
 */
export function contextBudget() {
    try {
        const preset = getDefaultPreset();
        const n = Number(preset?.maxContextChars);
        if (Number.isFinite(n) && n > 0) return n;
    } catch { /* 读不到预设（还没配过）就回落到默认值 */ }
    return DEFAULT_MAX_CONTEXT_CHARS;
}

/**
 * 统一的调用出口：超时保护 + 任务中心登记。
 * @param {Array<{role:string,content:string}>} messages 已经拼好的完整消息数组（见 textgameCore.buildTurnPrompt）
 * @param {string} label **必须模糊化**——只带剧本标题，不带主角名/输入内容（照狼人杀口径）
 * @returns {Promise<string>} 模型原文（trim 过）
 */
export async function callStoryAI({ messages, label, maxTokens = DEFAULT_MAX_TOKENS }) {
    if (!hasKey()) throw new Error('还没有配置 AI，先去设置里填一条 API');
    return taskManager.watch('textgame', label, async () => {
        const raw = await withTimeout(
            callAIConversation({ messages, maxTokens, temperature: 0.9 }),
            DEFAULT_TIMEOUT
        );
        return String(raw || '').trim();
    });
}

// ============================================================
//  Word（.docx）读取
//
//  跟角色卡那条线（store/CardFileIO.js）刻意各留一份、不共用：文游要的是**剧本原文**，
//  空段落得留着（分节全靠它）、软换行得断行；角色卡只要设定文字，口径不同。
//
//  .docx 就是个 zip，正文在 word/document.xml：手搓 zip 目录遍历 + 浏览器自带
//  DecompressionStream 解 deflate，零依赖（无 node_modules 的项目红线）。
// ============================================================

const ZIP_LOCAL_SIG = [0x50, 0x4B, 0x03, 0x04];   // "PK\x03\x04"
const OLE2_SIG = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];   // 旧版 .doc / .xls 的复合文档头
const RTF_SIG = [0x7B, 0x5C, 0x72, 0x74, 0x66];   // "{\rtf"

function startsWithBytes(bytes, sig) {
    if (bytes.length < sig.length) return false;
    return sig.every((b, i) => bytes[i] === b);
}

// XML 实体一次过解掉（`&amp;lt;` 不能被解成 `<`，所以不能像链式 replace 那样来回套）
const XML_ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(text) {
    return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X'
                ? parseInt(body.slice(2), 16)
                : parseInt(body.slice(1), 10);
            return (Number.isFinite(code) && code >= 0 && code <= 0x10FFFF) ? String.fromCodePoint(code) : match;
        }
        return XML_ENTITY[body] ?? match;
    });
}

/**
 * 从 .docx 里取正文纯文本。读不出就抛一句能照做的中文。
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>}
 */
async function readDocx(buffer) {
    const bytes = new Uint8Array(buffer);
    const decoder = new TextDecoder('utf-8');

    // ① 顺着头走 local file header，攒出条目表（末尾的中央目录签名对不上，循环自然停）
    const entries = [];
    let offset = 0;
    while (offset + 30 <= bytes.length && startsWithBytes(bytes.subarray(offset, offset + 4), ZIP_LOCAL_SIG)) {
        const compMethod = bytes[offset + 8] | (bytes[offset + 9] << 8);
        const compSize = (bytes[offset + 18] | (bytes[offset + 19] << 8)
            | (bytes[offset + 20] << 16) | (bytes[offset + 21] << 24)) >>> 0;
        const nameLen = bytes[offset + 26] | (bytes[offset + 27] << 8);
        const extraLen = bytes[offset + 28] | (bytes[offset + 29] << 8);
        const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLen));
        const dataStart = offset + 30 + nameLen + extraLen;

        entries.push({ name, compMethod, compSize, dataStart });
        offset = dataStart + compSize;
    }

    const doc = entries.find(e => e.name === 'word/document.xml');
    if (!doc) throw new Error('这个 Word 文档里没有正文——可能是空的、损坏了，或不是 Word 存的 .docx');

    // ② 解压（0 = 原样存，8 = deflate）
    const raw = bytes.subarray(doc.dataStart, doc.dataStart + doc.compSize);
    let xml;
    if (doc.compMethod === 0) {
        xml = decoder.decode(raw);
    } else if (doc.compMethod === 8) {
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        xml = decoder.decode(await new Response(stream).arrayBuffer());
    } else {
        throw new Error(`这个 .docx 用了不认识的压缩方式（${doc.compMethod}），读不了`);
    }

    // ③ 段落：一个 <w:p> 一行；段内 <w:t> 取字，<w:br/> 断行（Word 里的 Shift+Enter），<w:tab/> 补制表符
    const lines = [];
    const pRegex = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>|<w:p\s*\/>/g;
    const tokenRegex = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\s*\/?>|<w:tab\s*\/?>/g;
    let pm;
    while ((pm = pRegex.exec(xml)) !== null) {
        if (pm[1] === undefined) { lines.push(''); continue; }   // <w:p/> = 空段落

        let tm, line = '';
        tokenRegex.lastIndex = 0;
        while ((tm = tokenRegex.exec(pm[1])) !== null) {
            if (tm[1] !== undefined) line += tm[1];
            else line += tm[0].startsWith('<w:br') ? '\n' : '\t';
        }
        lines.push(decodeXml(line));
    }

    // ④ 收尾：空行留着（文游剧本的分节就是它），但连续空行压成一格、首尾不挂空行
    const out = [];
    for (const line of lines) {
        if (!line.trim()) {
            if (!out.length || !out[out.length - 1].trim()) continue;
            out.push('');
        } else {
            out.push(line);
        }
    }
    while (out.length && !out[out.length - 1].trim()) out.pop();

    const text = out.join('\n');
    if (!text.trim()) throw new Error('这个 Word 文档里一个字也没提取到——正文可能整篇是图片或表格，试试在 Word 里全选复制、粘贴到下面的框里');
    return text;
}

/**
 * 读一个文件，返回文本。
 * - .docx：走上面的 zip 提取（原文口径：空行保留）
 * - 旧版 .doc（OLE2 二进制）与 .rtf：纯前端解不出干净正文，给一句能照做的提示，别让人对着乱码发呆
 * - 其余按纯文本读（中文 txt 在 Windows 上很常见 GBK，`file.text()` 会直接给一屏乱码——
 *   所以先按 UTF-8 解，替换字符（U+FFFD）占比超过 0.5% 就改用 GBK 重解，取乱码少的那份）
 */
export async function readTextFile(file) {
    if (!file) return '';
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const name = String(file.name || '').toLowerCase();

    if (startsWithBytes(bytes, ZIP_LOCAL_SIG)) {
        if (!name.endsWith('.docx')) throw new Error('这是个压缩包，不是 Word 文档——请导入 .docx，或 .txt / .md 文本');
        return readDocx(buffer);
    }
    if (startsWithBytes(bytes, OLE2_SIG)) {
        throw new Error('这是旧版 .doc（二进制格式），读不出正文——用 Word 打开另存为 .docx，或全选复制、粘贴到下面的框里');
    }
    if (startsWithBytes(bytes, RTF_SIG)) {
        throw new Error('这是 .rtf 富文本，正文和排版代码混在一起读不干净——用 Word 另存为 .docx 或 .txt 再导入');
    }

    const utf8 = new TextDecoder('utf-8').decode(buffer);
    const utf8Bad = (utf8.match(/�/g) || []).length;
    if (utf8Bad === 0 || utf8Bad / Math.max(1, utf8.length) < 0.005) return utf8;

    try {
        const gbk = new TextDecoder('gbk').decode(buffer);
        const gbkBad = (gbk.match(/�/g) || []).length;
        if (gbkBad < utf8Bad) return gbk;
    } catch { /* 浏览器不支持 gbk 解码器就保持 UTF-8 的结果 */ }

    return utf8;
}

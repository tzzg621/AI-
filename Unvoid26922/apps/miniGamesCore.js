// apps/miniGamesCore.js — 互动组件的纯逻辑层
//
// 零 import：沙箱文档组装 / 上报值防脏 / 文本格式化。不碰 DOM、存储、网络，
// 所以能在 Node 里直接跑（见 tests/e2e-minigames.js 的 A 段）。
//
// 沙箱的立场（实测过，不是推理）：
//   · iframe 只给 `sandbox="allow-scripts"`，**不给 allow-same-origin** ⇒ 不透明源，
//     组件拿不到 parent.document / indexedDB / localStorage（全抛 SecurityError），
//     也不能提交表单、弹窗、跳顶层、下载（那几项都要额外的 allow-*）。
//   · 但**光靠沙箱挡不住「把东西发出去」**：对照组实测 fetch / XHR / <img> 全都发到了
//     服务器。所以 srcdoc 里再自带一条比父页更严的 CSP，断掉 network。
//     两层都在才有完整的墙：沙箱管「拿不到」，CSP 管「发不出」。
//   · 沙箱与父页**同一个主线程**：组件里写同步死循环会把整个小手机一起卡住
//     （实测组件死转 4000ms ⇒ 父页 rAF 停 4003ms，那几秒连返回键都点不动）。
//     **有限**的循环转完自己恢复、退出后照清净；**`while(true)` 这类没有上限**——
//     页面不会自己回来，父页的定时器也不会触发（同一个线程，看门狗根本没机会跑），
//     实测经浏览器侧发的刷新 155 秒没落地，只有关标签/关窗口管用（浏览器进程在做，528ms）。
//     这不是清理能解决的问题。

// 沙箱文档自带的 CSP。父页那份与它取交集 ⇒ 多的策略只能更严，组件放宽不了。
export const SANDBOX_CSP = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "form-action 'none'",
    "base-uri 'none'"
].join('; ');

// iframe 里看不见外面的样式，字体/行距得自带一份
const SANDBOX_STYLE = `html,body{margin:0;padding:0;background:transparent}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
     font-size:15px;line-height:1.7;color:#2f2f33;letter-spacing:.01em;word-break:break-word}
*{box-sizing:border-box}
img{max-width:100%;height:auto}
table{max-width:100%}`;

// 父页认消息用的标记 + 三条消息名
export const BRIDGE_MARK = '__mg';
export const MSG_RESIZE = 'resize';
export const MSG_REPORT = 'report';
export const MSG_ERROR = 'error';

export const FRAME_MIN_HEIGHT = 80;
export const FRAME_MAX_HEIGHT = 2400;
export const RESULT_MAX_CHARS = 4000;
export const PREVIEW_CHARS = 160;

/**
 * 把用户粘进来的东西理成「一段能塞进 body 的内容」。
 * 粘一份完整 HTML 文档是最常见的用法，所以剥掉文档级外壳（doctype/html/head/body 标签），
 * **保留它们内部的内容**——组件自己的 <style> 在 <head> 里，剥掉标签不能剥掉内容。
 */
export function normalizeComponentHtml(html) {
    return String(html ?? '')
        .replace(/<!doctype[^>]*>/gi, '')
        // 标签名后面只许跟空白/属性（`(?:\s[^>]*)?`）——写成 `[^>]*` 会把 <header>、<bodyguard> 一并吃掉
        .replace(/<\/?(?:html|head|body)(?:\s[^>]*)?>/gi, '')
        .trim();
}

/**
 * 组装沙箱文档。
 * 桥装在 <head> 里 —— 必须早于组件自己的脚本执行，否则组件初始化时抛的错没人接。
 */
export function buildSandboxDoc(componentHtml) {
    const body = normalizeComponentHtml(componentHtml);
    const csp = SANDBOX_CSP.replace(/"/g, '&quot;');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${SANDBOX_STYLE}</style>
<script>
(function () {
    var MARK = '${BRIDGE_MARK}';

    function post(type, payload) {
        try {
            parent.postMessage({ ${BRIDGE_MARK}: 1, type: type, payload: payload }, '*');
        } catch (e) { /* 父页没了就算了 */ }
    }

    // 组件想上报结果就调它——可选，不是必填契约
    window.mgReport = function (data) { post('${MSG_REPORT}', data === undefined ? null : data); };

    function describe(reason) {
        if (reason && reason.message) return String(reason.message);
        return String(reason);
    }

    window.addEventListener('error', function (e) {
        post('${MSG_ERROR}', {
            message: describe(e.error || e.message),
            line: e.lineno || 0,
            col: e.colno || 0
        });
    });

    window.addEventListener('unhandledrejection', function (e) {
        post('${MSG_ERROR}', { message: '未处理的 Promise 拒绝：' + describe(e.reason), line: 0, col: 0 });
    });

    // 父页读不到 contentDocument（不给 allow-same-origin），高度只能靠这里量完回报
    function fit() {
        try {
            var d = document;
            var h = Math.max(
                (d.body && d.body.scrollHeight) || 0,
                d.documentElement ? d.documentElement.scrollHeight : 0,
                (d.body && d.body.offsetHeight) || 0
            );
            if (h > 0) post('${MSG_RESIZE}', h);
        } catch (e) { /* 量不到就让父页吃 CSS 兜底高度 */ }
    }

    function watch() {
        fit();
        try { new ResizeObserver(fit).observe(document.body); } catch (e) { }
    }

    if (document.body) watch();
    else document.addEventListener('DOMContentLoaded', watch);
    window.addEventListener('load', fit);
})();
</script>
</head>
<body>
${body}
</body>
</html>`;
}

/** 高度回报防脏：非数/超界一律返回 0（= 忽略这一条） */
export function clampHeight(raw) {
    const h = Math.round(Number(raw));
    if (!Number.isFinite(h) || h <= 0) return 0;
    return Math.min(Math.max(h, FRAME_MIN_HEIGHT), FRAME_MAX_HEIGHT);
}

/**
 * 上报值防脏：组件能往 mgReport 里塞任何东西（包括循环引用——结构化克隆传得过来，
 * JSON.stringify 会抛）。这里统一压成 { json, truncated } 一个形状，落库和展示都只认它。
 */
export function boundResult(data, max = RESULT_MAX_CHARS) {
    let json;
    try {
        json = JSON.stringify(data);
    } catch (e) {
        try { json = JSON.stringify(String(data)); } catch (e2) { json = 'null'; }
    }
    if (json === undefined) json = 'null';
    if (json.length <= max) return { json, truncated: false };
    return { json: json.slice(0, max), truncated: true };
}

/** 读回一条运行记录里的 result（{ json, truncated }）→ { value, text, truncated } */
export function readResult(result) {
    if (!result || typeof result !== 'object') return { value: null, text: '', truncated: false };
    const json = String(result.json || '');
    let value = null;
    try { value = JSON.parse(json); } catch (e) { /* 截断过的多半 parse 不了，认了 */ }
    return { value, text: json, truncated: !!result.truncated };
}

/** 运行记录的一行摘要。认得出 score/success/message 就照它说，认不出就摊原始文本。 */
export function summarizeResult(result) {
    const { value, text, truncated } = readResult(result);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const bits = [];
        if (value.success === true) bits.push('成功');
        else if (value.success === false) bits.push('未成');
        if (typeof value.score === 'number') bits.push(`${value.score} 分`);
        if (value.message) bits.push(String(value.message));
        if (bits.length) return bits.join(' · ');
    }
    const flat = text.replace(/\s+/g, ' ').trim();
    if (!flat) return '（没有内容）';
    return (flat.length > 60 ? flat.slice(0, 60) + '…' : flat) + (truncated ? '（已截断）' : '');
}

/** 源码预览：去空白、取前 N 字 */
export function previewOf(html, len = PREVIEW_CHARS) {
    const flat = String(html || '').replace(/\s+/g, ' ').trim();
    return flat.length > len ? flat.slice(0, len) + '…' : flat;
}

/** 「解谜 推理」→ ['解谜','推理'] */
export function parseTags(text) {
    return String(text || '').split(/[\s,，、]+/).map(s => s.trim()).filter(Boolean);
}

export function formatDuration(ms) {
    const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    if (s < 60) return `${s} 秒`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} 分 ${s % 60} 秒`;
    return `${Math.floor(m / 60)} 时 ${m % 60} 分`;
}

export function formatDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function charCountText(n) {
    const v = Number(n) || 0;
    return v >= 10000 ? `${(v / 10000).toFixed(1)} 万字符` : `${v} 字符`;
}

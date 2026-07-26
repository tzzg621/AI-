// creator-space/md-renderer.js — 轻量 Markdown 转 HTML
// 零依赖，纯正则，专为 AI 聊天回复设计

export function esc(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

export function mdToHtml(text) {
    if (!text) return '';

    // 1. 先做 HTML 转义（防 XSS）
    let html = esc(text);

    // 2. 水平分割线（必须在标题之前）
    html = html.replace(/^---$/gm, '<hr>');

    // 3. 标题
    html = html.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
    html = html.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // 4. 行内代码（必须在粗体斜体之前，避免 ** 被误解析）
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // 5. 粗体、斜体
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // 6. 链接
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // 7. 引用
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

    // 8. 无序列表（每一行 → <li>，连续 <li> 包裹 <ul>）
    html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => {
        if (match.includes('<ul') || match.includes('<ol')) return match;
        return '<ul>' + match + '</ul>';
    });

    // 9. 有序列表
    html = html.replace(/^\d+\.\s(.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => {
        if (match.includes('<ul') || match.includes('<ol')) return match;
        return '<ol>' + match + '</ol>';
    });

    // 10. 段落和换行
    // 双换行 → 段落结束/开始
    html = html.replace(/\n\n/g, '</p><p>');
    // 单换行 → <br>
    html = html.replace(/\n/g, '<br>');

    // 11. 如果没有被任何块级标签包裹，整体加 <p>
    const blockTags = /^<(h[1-6]|p|ul|ol|blockquote|hr|li)/;
    if (!blockTags.test(html)) {
        html = '<p>' + html + '</p>';
    }

    return html;
}

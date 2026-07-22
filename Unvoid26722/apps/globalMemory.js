export const id = 'memory';
export const label = '记忆储存';
export const icon = '🧠';
export const color = '#607d8b';

const STORAGE_KEY_MEMORIES = 'global_memories';

function getMemories() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY_MEMORIES);
        if (saved) return JSON.parse(saved);
    } catch (e) { }
    const defaults = [
        { time: '2026-07-02 15:30', text: '用户修改了世界观设定。' },
        { time: '2026-07-02 14:20', text: '创建角色"王小二"。' },
        { time: '2026-07-02 12:00', text: '与AI讨论剧情发展。' }
    ];
    localStorage.setItem(STORAGE_KEY_MEMORIES, JSON.stringify(defaults));
    return defaults;
}

export function render() {
    const memories = getMemories();
    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">🧠 记忆储存</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card">
                    ${memories.map((item) => `
                        <div class="memory-item">
                            <div class="mem-time">${item.time}</div>
                            <div class="mem-text">${item.text}</div>
                        </div>
                    `).join('')}
                </div>
            </div>
        </div>
    `;
}

if (!window.__moduleRegistry) window.__moduleRegistry = [];
window.__moduleRegistry.push({ id, label, icon, color, render });

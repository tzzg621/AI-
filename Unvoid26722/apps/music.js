export const id = 'musicPage';
export const label = '音乐';
export const icon = '🎵';
export const color = '#4caf50';
export const title = '🎵 音乐';
export const memoryOptions = {
    mode: 'none',
    description: '音乐页面暂无记忆联动。',
    enabled: false
};

const tracks = [
    { text: '🎶 歌曲1 - 艺术家A' },
    { text: '🎶 歌曲2 - 艺术家B' }
];

export function render() {
    return `
        <div class="screen-page">
            <div class="screen-header">
                <div class="screen-title">${title}</div>
                <div class="header-spacer"></div>
            </div>
            <div class="screen-content">
                <div class="page-card">
                    <p>你的私人音乐库（目前为模拟占位）</p>
                    ${tracks.map((item) => `<div class="card-item">${item.text}</div>`).join('')}
                    <div class="memory-card disabled">
                        <div>${memoryOptions.description}</div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

if (!window.__moduleRegistry) window.__moduleRegistry = [];
window.__moduleRegistry.push({ id, label, icon, color, render });

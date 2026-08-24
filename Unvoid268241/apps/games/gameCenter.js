// apps/games/gameCenter.js — 游戏中心（列表 + 调度）
export const id = 'gameCenter';
export const label = '游戏中心';
export const icon = '🎮';

const GAMES = [
    { id: 'jumpJump', label: '跳一跳', icon: '🦘', desc: '按住蓄力，松开跳跃，落点越中心分越高' },
    { id: 'simCity', label: '模拟小城', icon: '🏙️', desc: '角色联动模拟经营：注册身份，入住小城' },
    { id: 'shelter', label: '末日安全屋', icon: '🏚️', desc: '收集物资，建设安全屋，末日生存经营' }
];

function renderList(overlay, globalState) {
    overlay.innerHTML = `
        <div style="background:white;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
            <button id="gameCenterBack" style="border:none;background:none;font-size:18px;color:#666;cursor:pointer;">←</button>
            <span style="font-weight:700;font-size:16px;">🎮 游戏中心</span>
            <span style="width:24px;"></span>
        </div>
        <div style="flex:1;overflow-y:auto;padding:16px;">
            ${GAMES.map(g => `
                <button class="game-card" data-game="${g.id}" style="width:100%;display:flex;align-items:center;gap:12px;background:white;border:none;border-radius:14px;padding:14px;margin-bottom:10px;cursor:pointer;box-shadow:0 1px 6px rgba(0,0,0,0.06);text-align:left;">
                    <div style="width:44px;height:44px;border-radius:12px;background:#e8f0fe;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;">${g.icon}</div>
                    <div style="flex:1;">
                        <div style="font-size:15px;font-weight:600;color:#333;">${g.label}</div>
                        <div style="font-size:12px;color:#999;margin-top:2px;">${g.desc}</div>
                    </div>
                    <span style="color:#0b93f6;font-size:13px;">进入 ›</span>
                </button>`).join('')}
        </div>`;

    overlay.querySelector('#gameCenterBack').addEventListener('click', () => overlay.remove());
    overlay.querySelectorAll('.game-card').forEach(btn => {
        btn.addEventListener('click', () => {
            const gameId = btn.dataset.game;
            import(`./${gameId}.js`).then(m => {
                if (m.start) m.start(overlay, globalState, () => renderList(overlay, globalState));
            });
        });
    });
}

export function openGameCenter(globalState) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:400;background:#f5f5f7;display:flex;flex-direction:column;';
    (document.querySelector('.phone-screen') || document.body).appendChild(overlay);
    renderList(overlay, globalState);
    return overlay;
}

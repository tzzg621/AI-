// apps/onlineBookCity/pages/settings.js — 书城设置

import { getPresets, savePresets, setCurrentPreset, addPreset, addGlobalRefPreset } from '../api.js';
import { showPrompt, showConfirm } from '../../../store/dialog.js';

export function render() {
  return `
    <div class="obc-settings">
      <div class="obc-section-title">⚙️ 书城设置</div>

      <div class="obc-settings-section">
        <div class="obc-settings-section-title">AI 写作预设</div>
        <div id="obcPresetList" class="obc-preset-list"></div>

        <div style="display:flex;gap:8px;margin-top:12px;">
          <button class="obc-btn obc-btn-secondary" id="obcAddPresetBtn" style="flex:1;">
            ✏️ 手动填写
          </button>
          <button class="obc-btn obc-btn-secondary" id="obcPickGlobalBtn" style="flex:1;">
            📎 从全局选取
          </button>
        </div>
      </div>

            <div class="obc-settings-section" style="margin-top:24px;">
        <div class="obc-settings-section-title">🗑️ 数据清理</div>
        <div id="obcWasteInfo" style="font-size:13px;color:#888;line-height:1.6;margin-bottom:10px;">
          正在计算...
        </div>
        <button class="obc-btn obc-btn-secondary" id="obcCleanupBtn" style="width:100%;color:#e53935;border-color:#e53935;">
          🗑️ 清理发现页废弃数据
        </button>
      </div>


      <div class="obc-settings-section" style="margin-top:24px;">
        <div class="obc-settings-section-title">关于</div>
        <div style="color:#999;font-size:13px;line-height:1.6;">
          数据存储在 IndexedDB（OnlineBookCity）<br>
          每个作品独立保存，随用随取
        </div>
      </div>
    </div>
  `;
}

export function bindEvents(container) {
  renderPresetList(container);

  // ★ 显示废弃数据信息
  (async () => {
    const wasteInfoEl = container.querySelector('#obcWasteInfo');
    const { getDiscoverWasteStats } = await import('../store.js');
    const stats = await getDiscoverWasteStats();
    if (stats.count === 0) {
      wasteInfoEl.innerHTML = '✅ 无废弃数据';
    } else {
      const sizeKB = (stats.sizeBytes / 1024).toFixed(1);
      wasteInfoEl.innerHTML = `
        📄 发现页废弃数据：<strong>${stats.count}</strong> 本<br>
        💾 估算占用：<strong>${sizeKB} KB</strong>
      `;
    }
  })();

  // ★ 清理按钮
  container.querySelector('#obcCleanupBtn').addEventListener('click', async () => {
    const { getDiscoverWasteStats, cleanupDiscoverBooks } = await import('../store.js');
    const stats = await getDiscoverWasteStats();
    if (stats.count === 0) {
      alert('✅ 没有废弃数据需要清理');
      return;
    }
    const confirmed = await showConfirm(`确定清理 ${stats.count} 本发现页废弃数据吗？\n收藏和推金的书不受影响。`);
    if (!confirmed) return;

    const deleted = await cleanupDiscoverBooks();
    alert(`✅ 已清理 ${deleted} 本废弃数据`);

    // 刷新信息
    const newStats = await getDiscoverWasteStats();
    const wasteInfoEl = container.querySelector('#obcWasteInfo');
    if (newStats.count === 0) {
      wasteInfoEl.innerHTML = '✅ 无废弃数据';
    } else {
      const sizeKB = (newStats.sizeBytes / 1024).toFixed(1);
      wasteInfoEl.innerHTML = `
        📄 发现页废弃数据：<strong>${newStats.count}</strong> 本<br>
        💾 估算占用：<strong>${sizeKB} KB</strong>
      `;
    }
  });


  // 手动填写
  container.querySelector('#obcAddPresetBtn').addEventListener('click', async () => {
    const name = await showPrompt('请输入预设名称（如：✍️ 写作）');
    if (!name) return;

    const endpoint = await showPrompt('API 端点', 'https://api.deepseek.com/v1');
    if (!endpoint) return;

    const model = await showPrompt('模型名称', 'deepseek-chat');
    if (!model) return;

    const apiKey = await showPrompt('API 密钥');
    if (!apiKey) return;

    addPreset({
      name,
      endpoint: endpoint.replace(/\/+$/, ''),
      model,
      apiKey,
      temperature: 0.7,
      maxTokens: 8000
    });
    renderPresetList(container);
  });

  // 从全局选取
  container.querySelector('#obcPickGlobalBtn').addEventListener('click', async () => {
    const { getPresets: getGlobalPresets } = await import('../../aiService.js');
    const globalPresets = getGlobalPresets();

    if (!globalPresets || globalPresets.length === 0) {
      alert('⚠️ 全局暂无预设，请先在「设置」中添加');
      return;
    }

    // 弹一个选择界面（用简易 radio 列表）
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:200;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="background:white;border-radius:20px;padding:20px;width:300px;max-height:80vh;overflow-y:auto;">
        <div style="font-weight:600;font-size:15px;margin-bottom:14px;">选择全局预设</div>
        ${globalPresets.map((p, i) => `
          <label style="display:flex;align-items:center;gap:10px;padding:10px;border-radius:10px;cursor:pointer;margin-bottom:4px;
                        ${i === 0 ? 'background:#f3e5f5;' : ''}"
                 data-preset-id="${p.id}">
            <input type="radio" name="globalPick" value="${p.id}" ${i === 0 ? 'checked' : ''}>
            <div>
              <div style="font-size:14px;font-weight:500;">${p.name}</div>
              <div style="font-size:11px;color:#999;">${p.model} @ ${p.endpoint}</div>
            </div>
          </label>
        `).join('')}
        <div style="margin-top:14px;">
          <label style="font-size:12px;color:#888;">
            温度覆盖（可选）：
            <input id="obcGlobalTemp" type="number" step="0.1" min="0" max="2" placeholder="默认" style="width:80px;border:1px solid #ddd;border-radius:6px;padding:4px 8px;font-size:13px;">
          </label>
          <label style="font-size:12px;color:#888;display:block;margin-top:6px;">
            Max Tokens 覆盖（可选）：
            <input id="obcGlobalTokens" type="number" step="100" min="500" placeholder="默认" style="width:100px;border:1px solid #ddd;border-radius:6px;padding:4px 8px;font-size:13px;">
          </label>
        </div>
        <div style="display:flex;gap:10px;margin-top:16px;">
          <button id="obcGlobalCancel" style="flex:1;padding:10px;border-radius:12px;border:1px solid #ccc;background:white;color:#666;cursor:pointer;font-size:14px;">取消</button>
          <button id="obcGlobalConfirm" style="flex:1;padding:10px;border-radius:12px;border:none;background:#8e24aa;color:white;cursor:pointer;font-size:14px;font-weight:600;">确认</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#obcGlobalCancel').onclick = () => overlay.remove();

    overlay.querySelector('#obcGlobalConfirm').onclick = () => {
      const selected = overlay.querySelector('input[name="globalPick"]:checked');
      if (!selected) { overlay.remove(); return; }

      const globalPreset = globalPresets.find(p => p.id === selected.value);
      if (!globalPreset) { overlay.remove(); return; }

      const tempVal = overlay.querySelector('#obcGlobalTemp').value;
      const tokensVal = overlay.querySelector('#obcGlobalTokens').value;

      addGlobalRefPreset(globalPreset.id, {
        temperature: tempVal ? parseFloat(tempVal) : null,
        maxTokens: tokensVal ? parseInt(tokensVal) : null
      });

      // ★ 补上名字（方便列表展示）
      const presets = getPresets();
      const added = presets.find(p => p.globalPresetId === globalPreset.id && p.type === 'global_ref');
      if (added) {
        added.name = `📎 ${globalPreset.name}`;
        savePresets(presets);
      }

      overlay.remove();
      renderPresetList(container);
    };
  });
}

function renderPresetList(container) {
  const listEl = container.querySelector('#obcPresetList');
  const presets = getPresets();
  const config = JSON.parse(localStorage.getItem('obookcity_api_config') || '{}');
  const currentId = config.currentPresetId;

  if (presets.length === 0) {
    listEl.innerHTML = `<div style="color:#bbb;font-size:13px;padding:12px 0;">还没有预设，点击下方添加</div>`;
    return;
  }

  listEl.innerHTML = presets.map(p => `
    <div class="obc-preset-item ${p.id === currentId ? 'obc-preset-active' : ''}"
         data-preset-id="${p.id}">
      <div class="obc-preset-info">
        <div class="obc-preset-name">
          ${p.name}
          ${p.type === 'global_ref' ? '<span style="font-size:11px;color:#8e24aa;background:#f3e5f5;padding:1px 6px;border-radius:4px;margin-left:4px;">引用</span>' : ''}
        </div>
        <div class="obc-preset-model">
          ${p.type === 'global_ref'
      ? `引用全局预设 · ID: ${p.globalPresetId}`
      : `${p.model} @ ${p.endpoint}`
    }
        </div>
      </div>
      <div class="obc-preset-actions">
        <button class="obc-preset-use-btn" data-preset-id="${p.id}">
          ${p.id === currentId ? '✓ 使用中' : '使用'}
        </button>
        <button class="obc-preset-del-btn" data-preset-id="${p.id}" style="color:#e53935;">删除</button>
      </div>
    </div>
  `).join('');

  listEl.querySelectorAll('.obc-preset-use-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setCurrentPreset(btn.dataset.presetId);
      renderPresetList(container);
    });
  });

  listEl.querySelectorAll('.obc-preset-del-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const confirmed = await showConfirm('确定删除此预设吗？');
      if (!confirmed) return;
      const { removePreset } = await import('../api.js');
      removePreset(btn.dataset.presetId);
      renderPresetList(container);
    });
  });
}

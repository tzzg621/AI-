// apps/onlineBookCity/pages/settings.js — 书城设置

import { getPresets, savePresets, setCurrentPreset, addPreset, addGlobalRefPreset } from '../api.js';
import { showAlert, showPrompt, showConfirm } from '../../../store/dialog.js';
import {
  getStyleTheme, setStyleTheme,
  getStyleScale, setStyleScale,
  importStyleFile, removeStyleFile, hasImportedFile
} from '../styleTemplates.js';


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
  <div class="obc-settings-section-title">🎨 写作风格</div>
  <div style="font-size:13px;color:#888;line-height:1.6;margin-bottom:12px;">
    上传 .txt 风格模板文件，AI 生成时将自动应用。<br>
    文件格式：使用 <code>[CORE]</code> <code>[IMPLICIT]</code> <code>[EXPLICIT]</code> 标记分隔三个段落。
  </div>

  <div style="margin-bottom:10px;">
    <div style="font-size:13px;font-weight:500;margin-bottom:6px;">主题</div>
    <div style="display:flex;gap:8px;">
      <label class="obc-style-option" data-theme="sweet" style="flex:1;padding:12px;border-radius:12px;border:2px solid #f0f0f0;cursor:pointer;text-align:center;background:white;">
        <div style="font-size:20px;margin-bottom:4px;">💕</div>
        <div style="font-size:13px;font-weight:500;">甜向</div>
      </label>
      <label class="obc-style-option" data-theme="dark" style="flex:1;padding:12px;border-radius:12px;border:2px solid #f0f0f0;cursor:pointer;text-align:center;background:white;">
        <div style="font-size:20px;margin-bottom:4px;">🗡️</div>
        <div style="font-size:13px;font-weight:500;">虐向</div>
      </label>
    </div>
  </div>

  <div>
    <div style="font-size:13px;font-weight:500;margin-bottom:6px;">描写尺度</div>
    <div style="display:flex;gap:8px;">
      <label class="obc-scale-option" data-scale="implicit" style="flex:1;padding:12px;border-radius:12px;border:2px solid #f0f0f0;cursor:pointer;text-align:center;background:white;">
        <div style="font-size:20px;margin-bottom:4px;">🌙</div>
        <div style="font-size:13px;font-weight:500;">隐晦</div>
      </label>
      <label class="obc-scale-option" data-scale="explicit" style="flex:1;padding:12px;border-radius:12px;border:2px solid #f0f0f0;cursor:pointer;text-align:center;background:white;">
        <div style="font-size:20px;margin-bottom:4px;">🔥</div>
        <div style="font-size:13px;font-weight:500;">直白</div>
      </label>
    </div>
  </div>

  <div style="margin-top:16px;padding-top:16px;border-top:1px solid #f0f0f0;">
    <div style="font-size:13px;font-weight:500;margin-bottom:8px;">📤 模板文件</div>
    <div id="obcStyleFileStatus" style="font-size:12px;color:#888;margin-bottom:10px;"></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button class="obc-btn obc-btn-secondary" id="obcUploadSweet" style="font-size:12px;padding:8px 14px;">
        📤 上传甜向模板
      </button>
      <button class="obc-btn obc-btn-secondary" id="obcUploadDark" style="font-size:12px;padding:8px 14px;">
        📤 上传虐向模板
      </button>
      <button class="obc-btn obc-btn-secondary" id="obcClearSweet" style="font-size:12px;padding:8px 14px;color:#e53935;border-color:#e53935;">
        🗑️ 清除甜向
      </button>
      <button class="obc-btn obc-btn-secondary" id="obcClearDark" style="font-size:12px;padding:8px 14px;color:#e53935;border-color:#e53935;">
        🗑️ 清除虐向
      </button>
    </div>
  </div>
</div>


      <div class="obc-settings-section" style="margin-top:24px;">
  <div class="obc-settings-section-title">📖 提示词仓库联动</div>
  <div id="obcWorldBookList" style="margin-bottom:10px;">
    正在加载...
  </div>
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
      await showAlert('✅ 没有废弃数据需要清理');
      return;
    }
    const confirmed = await showConfirm(`确定清理 ${stats.count} 本发现页废弃数据吗？\n收藏和推金的书不受影响。`);
    if (!confirmed) return;

    const deleted = await cleanupDiscoverBooks();
    await showAlert(`✅ 已清理 ${deleted} 本废弃数据`);

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

  // ★ 渲染提示词仓库条目
  renderWorldBookList(container);

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
      await showAlert('⚠️ 全局暂无预设，请先在「设置」中添加');
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

    // ============================================================
  //  ★ 写作风格 —— 事件绑定（追加在 bindEvents 末尾）
  // ============================================================


  // 更新文件状态显示
  function updateStyleFileStatus() {
    const el = container.querySelector('#obcStyleFileStatus');
    if (!el) return;
    const sweet = hasImportedFile('sweet');
    const dark = hasImportedFile('dark');
    const parts = [];
    if (sweet) parts.push('✅ 甜向模板已上传');
    if (dark) parts.push('✅ 虐向模板已上传');
    el.textContent = parts.length > 0 ? parts.join(' ｜ ') : '📄 未上传任何模板，将使用基础写作指令';
  }

  // 初始化选中状态
  const currentTheme = getStyleTheme();
  const currentScale = getStyleScale();

  container.querySelectorAll('.obc-style-option').forEach(el => {
    if (el.dataset.theme === currentTheme) {
      el.style.borderColor = '#8e24aa';
      el.style.background = '#f3e5f5';
    }
  });

  container.querySelectorAll('.obc-scale-option').forEach(el => {
    if (el.dataset.scale === currentScale) {
      el.style.borderColor = '#8e24aa';
      el.style.background = '#f3e5f5';
    }
  });

  updateStyleFileStatus();

  // 主题选择
  container.querySelectorAll('.obc-style-option').forEach(el => {
    el.addEventListener('click', () => {
      const theme = el.dataset.theme;
      setStyleTheme(theme);
      container.querySelectorAll('.obc-style-option').forEach(e => {
        e.style.borderColor = '#f0f0f0';
        e.style.background = 'white';
      });
      el.style.borderColor = '#8e24aa';
      el.style.background = '#f3e5f5';
    });
  });

  // 尺度选择
  container.querySelectorAll('.obc-scale-option').forEach(el => {
    el.addEventListener('click', () => {
      const scale = el.dataset.scale;
      setStyleScale(scale);
      container.querySelectorAll('.obc-scale-option').forEach(e => {
        e.style.borderColor = '#f0f0f0';
        e.style.background = 'white';
      });
      el.style.borderColor = '#8e24aa';
      el.style.background = '#f3e5f5';
    });
  });

  // 通用上传函数
  function setupFileUpload(theme, btnId) {
    const btn = container.querySelector(btnId);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.txt';
      input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        const text = await file.text();
        importStyleFile(theme, text);
        updateStyleFileStatus();
        const label = theme === 'sweet' ? '甜向' : '虐向';
        // 使用你项目中已有的 showAlert
        const { showAlert } = await import('../../../store/dialog.js');
        showAlert(`✅ ${label}风格模板已导入（${text.length} 字符）`);
      });
      input.click();
    });
  }

  setupFileUpload('sweet', '#obcUploadSweet');
  setupFileUpload('dark', '#obcUploadDark');

  // 清除上传文件
  function setupFileClear(theme, btnId) {
    const btn = container.querySelector(btnId);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const label = theme === 'sweet' ? '甜向' : '虐向';
      const { showConfirm } = await import('../../../store/dialog.js');
      const confirmed = await showConfirm(`确定清除已上传的${label}模板吗？`);
      if (!confirmed) return;
      removeStyleFile(theme);
      updateStyleFileStatus();
      const { showAlert } = await import('../../../store/dialog.js');
      showAlert(`🗑️ 已清除${label}模板`);
    });
  }

  setupFileClear('sweet', '#obcClearSweet');
  setupFileClear('dark', '#obcClearDark');


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





// ============================================================
//  世界书（提示词仓库）联动
// ============================================================

function getWorldBookEntries() {
  try {
    return JSON.parse(localStorage.getItem('worldbook_entries') || '[]');
  } catch { return []; }
}

function getSelectedWorldBookIds() {
  try {
    return JSON.parse(localStorage.getItem('obookcity_worldbook_ids') || '[]');
  } catch { return []; }
}

function saveSelectedWorldBookIds(ids) {
  localStorage.setItem('obookcity_worldbook_ids', JSON.stringify(ids));
}

function renderWorldBookList(container) {
  const listEl = container.querySelector('#obcWorldBookList');
  if (!listEl) return;

  const entries = getWorldBookEntries();
  const enabledEntries = entries.filter(e => e.enabled !== false);
  const selectedIds = getSelectedWorldBookIds();

  if (enabledEntries.length === 0) {
    listEl.innerHTML = '<div style="color:#bbb;font-size:13px;padding:12px 0;">暂无提示词条目，请先在「世界书」模块中添加</div>';
    return;
  }

  listEl.innerHTML = `
    <div style="font-size:13px;color:#888;line-height:1.6;margin-bottom:10px;">
      AI 生成时会自动将选中的提示词注入到该类目的生成请求中
    </div>
    <div style="margin-bottom:8px;">
      <button id="obcWbSelectAll" class="obc-btn obc-btn-secondary" style="font-size:12px;padding:4px 12px;">
        全选 / 取消全选
      </button>
      <span style="font-size:12px;color:#999;margin-left:8px;">
        已选 ${selectedIds.length} / ${enabledEntries.length} 条
      </span>
    </div>
    ${enabledEntries.map(entry => `
      <label class="obc-wb-entry" data-entry-id="${entry.id}"
             style="display:flex;align-items:center;gap:10px;padding:10px 12px;
                    background:${selectedIds.includes(entry.id) ? '#f3e5f5' : 'white'};
                    border-radius:10px;margin-bottom:4px;cursor:pointer;
                    border:1px solid ${selectedIds.includes(entry.id) ? '#e1bee7' : '#f0f0f0'};
                    transition:all 0.15s;">
        <input type="checkbox" class="obc-wb-checkbox" data-entry-id="${entry.id}"
               ${selectedIds.includes(entry.id) ? 'checked' : ''}
               style="width:16px;height:16px;accent-color:#8e24aa;flex-shrink:0;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:14px;font-weight:500;color:#333;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            ${entry.title}
          </div>
          <div style="font-size:12px;color:#999;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px;">
            ${entry.text?.slice(0, 60)}${entry.text?.length > 60 ? '…' : ''}
          </div>
        </div>
      </label>
    `).join('')}
  `;

  // 绑定 checkbox 变更
  listEl.querySelectorAll('.obc-wb-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      saveSelectedWorldBookIds(
        Array.from(listEl.querySelectorAll('.obc-wb-checkbox:checked'))
          .map(c => c.dataset.entryId)
      );
      renderWorldBookList(container);
    });
  });

  // 绑定全选按钮
  const selectAllBtn = listEl.querySelector('#obcWbSelectAll');
  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', () => {
      const allIds = enabledEntries.map(e => e.id);
      const currentIds = getSelectedWorldBookIds();
      const allSelected = allIds.every(id => currentIds.includes(id));
      saveSelectedWorldBookIds(allSelected ? [] : allIds);
      renderWorldBookList(container);
    });
  }
}

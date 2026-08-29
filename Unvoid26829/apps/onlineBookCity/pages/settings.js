// apps/onlineBookCity/pages/settings.js — 书城设置

import { getPresets, savePresets, setCurrentPreset, addPreset, addGlobalRefPreset } from '../api.js';
import { showAlert, showPrompt, showConfirm } from '../../../store/dialog.js';
import { esc } from '../../../store/utils.js';
import {
  loadBundles, parseBundle, importBundle, removeBundle, mergeDimensions,
  getValidSelections, saveSelection, buildStylePromptFromSettings
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
  导入 .txt 文风包 / 同人补充包，可叠加多个包，AI 生成时自动合并生效。<br>
  格式：<code>[NAME] 包名</code>、<code>[CORE] 公共段</code>、<code>[维度:名称] 选项 = 内容</code><br>
  同名维度自动合并，点击包名可只看该包 · 选择全局生效。
</div>

  <div id="obcStyleBundleHeader" style="margin-bottom:10px;"></div>
  <div id="obcStyleDimList"></div>
  <div id="obcStylePreview" style="margin-top:12px;"></div>

  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;">
<button class="obc-btn obc-btn-secondary" id="obcStyleImport" style="font-size:12px;padding:8px 14px;">
  📤 导入文风包 / 补充包
</button>
<button class="obc-btn obc-btn-secondary" id="obcStyleClear" style="font-size:12px;padding:8px 14px;color:#e53935;border-color:#e53935;">
  🗑️ 删除当前包
</button>    
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
              <div style="font-size:14px;font-weight:500;">${esc(p.name)}</div>
              <div style="font-size:11px;color:#999;">${esc(p.model)} @ ${esc(p.endpoint)}</div>
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
  //  ★ 写作风格 —— 多维度选择器（事件委托 + 局部更新）
  // ============================================================

  const dimListEl = container.querySelector('#obcStyleDimList');

  // 预览更新（去重：组合没变就不重写 DOM）
  let lastPreviewText = '';
  function updateStylePreview(container) {
    const previewEl = container.querySelector('#obcStylePreview');
    if (!previewEl) return;
    const prompt = buildStylePromptFromSettings();
    if (prompt === lastPreviewText) return;
    lastPreviewText = prompt;
    previewEl.innerHTML = prompt ? `
    <div style="font-size:12px;font-weight:500;color:#888;margin-bottom:4px;">组合预览</div>
    <div style="font-size:12px;color:#555;background:#faf7ff;border:1px solid #efe9fb;border-radius:10px;
                padding:10px;white-space:pre-wrap;word-break:break-all;max-height:160px;overflow-y:auto;">
      ${esc(prompt)}
    </div>
  ` : '';
  }

  // 选项选中态切换（只改样式，不重建 DOM）
  function setOptionActive(el, active) {
    el.style.border = `2px solid ${active ? '#8e24aa' : '#e8e8e8'}`;
    el.style.background = active ? '#f3e5f5' : 'white';
    el.style.color = active ? '#8e24aa' : '#666';
    el.style.fontWeight = active ? '600' : '400';
  }

  function renderStyleSection(container) {
    const headerEl = container.querySelector('#obcStyleBundleHeader');
    if (!headerEl || !dimListEl) return;

    const bundles = loadBundles();
    if (bundles.length === 0) {
      headerEl.innerHTML = '<div style="font-size:13px;color:#999;">📄 未导入文风包 / 同人补充包，AI 生成将使用基础写作指令</div>';
      dimListEl.innerHTML = '';
      lastPreviewText = '';
      updateStylePreview(container);
      return;
    }

    // 当前查看模式：'' = 全部包合并视图 | bundleId = 只看该包
    let viewFilter = headerEl.dataset.viewFilter || '';
    if (viewFilter && !bundles.find(b => b.id === viewFilter)) viewFilter = '';   // 兜底：包已删除
    headerEl.dataset.viewFilter = viewFilter;

    // 头部：所有包的标签（点击切换"只看该包 / 回到全部"）
    headerEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
        <span class="obc-style-bundle-chip" data-bundle-id=""
              style="display:inline-flex;align-items:center;gap:4px;padding:5px 12px;border-radius:16px;font-size:12px;cursor:pointer;
                     border:1px solid ${viewFilter === '' ? '#8e24aa' : '#e0e0e0'};
                     background:${viewFilter === '' ? '#f3e5f5' : 'white'};
                     color:${viewFilter === '' ? '#8e24aa' : '#666'};font-weight:${viewFilter === '' ? '600' : '400'};">
          全部
        </span>
        ${bundles.map(item => {
      const isActive = item.id === viewFilter;
      return `
            <span class="obc-style-bundle-chip" data-bundle-id="${esc(item.id)}"
                  style="display:inline-flex;align-items:center;gap:4px;padding:5px 12px;border-radius:16px;font-size:12px;cursor:pointer;
                         border:1px solid ${isActive ? '#8e24aa' : '#e0e0e0'};
                         background:${isActive ? '#f3e5f5' : 'white'};
                         color:${isActive ? '#8e24aa' : '#666'};font-weight:${isActive ? '600' : '400'};">
              ${esc(item.name || '未命名')}
            </span>
          `;
    }).join('')}
      </div>
      <div style="font-size:12px;color:#999;margin-top:6px;">
        点击包名可只看该包 · 再点一次回到全部 · 选择全局生效
      </div>
    `;

    // ★ 按当前查看模式合并（全部 or 单个包）
    const viewBundles = viewFilter
      ? bundles.filter(b => b.id === viewFilter)
      : bundles;
    const merged = mergeDimensions(viewBundles);
    if (!merged) {
      dimListEl.innerHTML = '';
      lastPreviewText = '';
      updateStylePreview(container);
      return;
    }

    const selections = getValidSelections(merged);

    dimListEl.innerHTML = merged.dimensions.map(dim => {
      const selectedKey = selections[dim.name];
      const optionsHtml = dim.options.map(opt => {
        const activeOpt = selectedKey === opt.key;
        return `
          <label class="obc-style-option"
                 data-dim="${esc(dim.name)}" data-opt-key="${esc(opt.key)}"
                 style="flex:0 0 auto;padding:8px 14px;border-radius:20px;border:2px solid ${activeOpt ? '#8e24aa' : '#e8e8e8'};
                        background:${activeOpt ? '#f3e5f5' : 'white'};cursor:pointer;font-size:13px;
                        color:${activeOpt ? '#8e24aa' : '#666'};font-weight:${activeOpt ? '600' : '400'};">
            ${esc(opt.name)}
          </label>
        `;
      }).join('');

      // ★ 补上维度块的 return（提示行已去掉）
      return `
        <div style="margin-bottom:10px;" data-dim-group="${esc(dim.name)}">
          <div style="font-size:13px;font-weight:500;margin-bottom:6px;color:#333;">${esc(dim.name)}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">${optionsHtml}</div>
        </div>
      `;
    }).join('') || '<div style="font-size:12px;color:#bbb;">所有包都没有可配置维度</div>';

    // 包标签点击：切换"只看该包 / 回到全部"
    headerEl.querySelectorAll('.obc-style-bundle-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const target = chip.dataset.bundleId;
        const current = headerEl.dataset.viewFilter;
        headerEl.dataset.viewFilter = current === target ? '' : target;   // 再点当前包 = 回到全部
        renderStyleSection(container);
      });
    });

    lastPreviewText = '';
    updateStylePreview(container);
  }

  // ★ 事件委托：整个维度列表只绑一个监听器（按 optKey 判断）
  dimListEl.addEventListener('click', (e) => {
    const el = e.target.closest('.obc-style-option');
    if (!el) return;
    const dimName = el.dataset.dim;
    const optKey = el.dataset.optKey;

    const groupEl = el.closest('[data-dim-group]');
    if (!groupEl) return;

    const merged = mergeDimensions(loadBundles());
    if (!merged) return;
    const selected = getValidSelections(merged)[dimName];

    if (selected === optKey) {
      // ★ 再点一次 → 取消（存 null），只取消高亮
      saveSelection(dimName, null);
      groupEl.querySelectorAll('.obc-style-option').forEach(o => setOptionActive(o, false));
      updateStylePreview(container);
    } else {
      groupEl.querySelectorAll('.obc-style-option').forEach(o => {
        if (o.dataset.dim !== dimName) return;
        setOptionActive(o, o.dataset.optKey === optKey);
      });
      saveSelection(dimName, optKey);
      updateStylePreview(container);
    }
  });

  renderStyleSection(container);

  // 导入文风包 / 同人补充包（追加，不覆盖）
  container.querySelector('#obcStyleImport').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt';
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      const text = await file.text();
      const res = importBundle(text, file.name);      // ★ 传文件名
      if (!res) {
        await showAlert('⚠️ 文风包解析失败，请检查文件格式');
        return;
      }
      const { bundle, replaced } = res;
      // ★ 切到刚导入/替换的包
      const headerEl = container.querySelector('#obcStyleBundleHeader');
      if (headerEl && bundle.id) headerEl.dataset.viewFilter = bundle.id;       // ★ 改成 viewFilter
      renderStyleSection(container);
      await showAlert(replaced
        ? `♻️ 同名文件「${file.name}」已存在，内容已替换更新`
        : `✅ 已追加导入「${bundle.name || '未命名'}」，当前共 ${loadBundles().length} 个包`);
    });
    input.click();
  });

  // 删除当前包（不影响其他包）
  container.querySelector('#obcStyleClear').addEventListener('click', async () => {
    const bundles = loadBundles();
    if (bundles.length === 0) {
      await showAlert('📄 当前没有文风包');
      return;
    }
    const headerEl = container.querySelector('#obcStyleBundleHeader');
    const activeId = headerEl?.dataset.viewFilter || bundles[0].id;    // ★ 改为 viewFilter
    const active = bundles.find(b => b.id === activeId);
    const confirmed = await showConfirm(`确定删除文风包「${active?.name || ''}」吗？\n其他包不受影响。`);
    if (!confirmed) return;
    removeBundle(activeId);
    renderStyleSection(container);
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
          ${esc(p.name)}
          ${p.type === 'global_ref' ? '<span style="font-size:11px;color:#8e24aa;background:#f3e5f5;padding:1px 6px;border-radius:4px;margin-left:4px;">引用</span>' : ''}
        </div>
        <div class="obc-preset-model">
          ${p.type === 'global_ref'
      ? `引用全局预设 · ID: ${esc(p.globalPresetId)}`
      : `${esc(p.model)} @ ${esc(p.endpoint)}`}
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
            ${esc(entry.title)}
          </div>
          <div style="font-size:12px;color:#999;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px;">
            ${esc((entry.text || '').slice(0, 60))}${entry.text?.length > 60 ? '…' : ''}
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

// store/Aoi/aoi-api.js — Aoi 的独立 API 接入口

const PRESETS_KEY = 'aoi_api_presets';
const SALT_KEY = 'aoi_salt';

// ---- 简单的 XOR 加密 ----
function getSalt() {
    let salt = localStorage.getItem(SALT_KEY);
    if (!salt) {
        salt = 'aoi_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
        localStorage.setItem(SALT_KEY, salt);
    }
    return salt;
}

function encrypt(text) {
    if (!text) return '';
    const salt = getSalt();
    const mixed = text.split('').map((c, i) => {
        return String.fromCharCode(c.charCodeAt(0) ^ salt.charCodeAt(i % salt.length));
    }).join('');
    return btoa(encodeURIComponent(mixed));
}

function decrypt(encoded) {
    if (!encoded) return '';
    try {
        const salt = getSalt();
        const mixed = decodeURIComponent(atob(encoded));
        return mixed.split('').map((c, i) => {
            return String.fromCharCode(c.charCodeAt(0) ^ salt.charCodeAt(i % salt.length));
        }).join('');
    } catch {
        return '';
    }
}

// ---- 预设管理 ----
export function getAoiPresets() {
    try {
        const saved = localStorage.getItem(PRESETS_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            if (!Array.isArray(parsed) || parsed.length === 0) throw 'empty';
            return parsed.map(p => ({
                ...p,
                apiKey: decrypt(p.apiKey)
            }));
        }
    } catch { }

    return [{
        id: 'aoi_default',
        name: 'Aoi 默认',
        endpoint: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        apiKey: '',
        isDefault: true
    }];
}

export function saveAoiPresets(presets) {
    if (!Array.isArray(presets) || presets.length === 0) return;
    const toSave = presets.map(p => ({
        ...p,
        apiKey: encrypt(p.apiKey)
    }));
    localStorage.setItem(PRESETS_KEY, JSON.stringify(toSave));
}

export function getAoiDefaultPreset() {
    const presets = getAoiPresets();
    return presets.find(p => p.isDefault) || presets[0] || null;
}

export function hasAoiApiKey() {
    const preset = getAoiDefaultPreset();
    return preset ? !!preset.apiKey : false;
}

export function getApiConfig() {
    const preset = getAoiDefaultPreset();
    return {
        endpoint: preset?.endpoint || '',
        model: preset?.model || '',
        hasKey: !!preset?.apiKey
    };
}

// ★★★ 改动的部分：支持 tools，返回整个 choice ★★★
export async function callAoiAPI({ messages, tools, presetId, maxTokens = 4096, temperature = 0.8 } = {}) {
    const presets = getAoiPresets();
    const preset = presetId
        ? presets.find(p => p.id === presetId)
        : presets.find(p => p.isDefault) || presets[0];

    if (!preset) throw new Error('Aoi 未找到可用的 API 预设');
    if (!preset.apiKey) throw new Error('请先为 Aoi 配置 API 密钥');

    const url = preset.endpoint.replace(/\/+$/, '') + '/chat/completions';

    const body = {
        model: preset.model,
        messages,
        max_tokens: maxTokens,
        temperature
    };
    if (tools) body.tools = tools;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${preset.apiKey}`
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        let errMsg = `HTTP ${response.status}`;
        try {
            const err = await response.json();
            errMsg = err.error?.message || err.message || errMsg;
        } catch { }
        throw new Error(`Aoi API 调用失败: ${errMsg}`);
    }

    const data = await response.json();
    return {
        choice: data.choices[0],
        usage: data.usage || null  // ★ 把 usage 也带回来
    };
}

// ---- 插槽渲染（不变）----
export function renderSlot() {
    const config = getApiConfig();

    const html = `
        <div style="border-top:1px solid #f0f0f0; margin:0 16px;">
            <div id="aoiApiToggle" style="
                display:flex; justify-content:space-between; align-items:center;
                cursor:pointer; font-size:13px; font-weight:600; color:#5b6abf;
                padding:10px 0 8px; user-select:none;
            ">
                <span>🔑 Aoi API 设置</span>
                <span class="toggle-icon" style="font-size:12px;color:#999;transition:transform 0.2s;">▶</span>
            </div>
            <div id="aoiApiBody" style="display:none; padding:0 0 12px;">
                <label style="font-size:12px;color:#888;display:block;margin-bottom:3px;">API 地址</label>
                <input type="text" id="aoiEndpoint" value="${config.endpoint}" placeholder="https://api.deepseek.com/v1"
                    style="width:100%;border:1px solid #e0e0e0;border-radius:6px;padding:7px 10px;font-size:13px;outline:none;box-sizing:border-box;font-family:inherit;margin-bottom:8px;" />

                <label style="font-size:12px;color:#888;display:block;margin-bottom:3px;">模型名</label>
                <div style="display:flex;gap:4px;margin-bottom:8px;">
                    <select id="aoiModel" style="
                        flex:1; border:1px solid #e0e0e0; border-radius:6px;
                        padding:7px 10px; font-size:13px; outline:none;
                        box-sizing:border-box; font-family:inherit;
                    ">
                        <option value="${config.model}" selected>${config.model || '请拉取或输入'}</option>
                    </select>
                    <button id="aoiFetchModelsBtn" style="
                        padding:7px 12px; border-radius:6px; border:1px solid #5b6abf;
                        background:white; color:#5b6abf; cursor:pointer; font-size:12px; font-weight:600;
                        white-space:nowrap; transition:background 0.2s;
                    ">🔄 拉取</button>
                </div>
                <div id="aoiModelStatus" style="font-size:11px;color:#999;margin-bottom:4px;">点击拉取获取可用模型列表</div>

                <label style="font-size:12px;color:#888;display:block;margin-bottom:3px;">API 密钥</label>
                <input type="password" id="aoiApiKey" value="${config.hasKey ? '••••••••' : ''}" placeholder="sk-xxx..."
                    style="width:100%;border:1px solid #e0e0e0;border-radius:6px;padding:7px 10px;font-size:13px;outline:none;box-sizing:border-box;font-family:inherit;margin-bottom:4px;" />
                <div style="font-size:11px;color:#999;margin-bottom:8px;">🔒 独立存储，不影响主项目的 API 设置</div>

                <button id="aoiApiSaveBtn" style="
                    width:100%;padding:9px;border-radius:8px;border:none;
                    background:#5b6abf;color:white;cursor:pointer;font-size:13px;font-weight:600;
                ">💾 保存 Aoi 的 API 设置</button>
                <div id="aoiApiStatus" style="font-size:12px;text-align:center;margin-top:6px;min-height:18px;"></div>
            </div>
        </div>
    `;

    function bind(container) {
        const toggle = container.querySelector('#aoiApiToggle');
        const body = container.querySelector('#aoiApiBody');
        const icon = container.querySelector('.toggle-icon');
        toggle?.addEventListener('click', () => {
            const isOpen = body.style.display !== 'none';
            body.style.display = isOpen ? 'none' : 'block';
            icon.style.transform = isOpen ? '' : 'rotate(90deg)';
        });

        container.querySelector('#aoiFetchModelsBtn')?.addEventListener('click', async () => {
            const endpoint = container.querySelector('#aoiEndpoint').value.trim();
            const keyInput = container.querySelector('#aoiApiKey');
            let apiKey = keyInput.value;
            if (apiKey === '••••••••') {
                const presets = getAoiPresets();
                apiKey = presets.find(p => p.isDefault)?.apiKey || '';
            }
            if (!endpoint || !apiKey) {
                const el = container.querySelector('#aoiModelStatus');
                if (el) { el.textContent = '请先填写 API 地址和密钥'; el.style.color = '#e53935'; }
                return;
            }

            const btn = container.querySelector('#aoiFetchModelsBtn');
            const statusEl = container.querySelector('#aoiModelStatus');
            btn.textContent = '⏳';
            btn.disabled = true;
            if (statusEl) { statusEl.textContent = '正在拉取...'; statusEl.style.color = '#999'; }

            try {
                const baseUrl = endpoint.replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, '');
                const response = await fetch(baseUrl + '/models', {
                    headers: { 'Authorization': `Bearer ${apiKey}` }
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json();
                const models = data.data.map(m => m.id).sort();
                if (models.length === 0) throw new Error('未找到模型');

                const select = container.querySelector('#aoiModel');
                const currentVal = select.value;
                select.innerHTML = models.map(m =>
                    `<option value="${m}" ${m === currentVal ? 'selected' : ''}>${m}</option>`
                ).join('');

                if (statusEl) { statusEl.textContent = `✅ ${models.length} 个模型`; statusEl.style.color = '#2e7d32'; }
            } catch (e) {
                if (statusEl) { statusEl.textContent = `❌ ${e.message}`; statusEl.style.color = '#e53935'; }
            } finally {
                btn.textContent = '🔄 拉取';
                btn.disabled = false;
            }
        });

        container.querySelector('#aoiApiSaveBtn')?.addEventListener('click', () => {
            const endpoint = container.querySelector('#aoiEndpoint').value.trim();
            const model = container.querySelector('#aoiModel').value.trim();
            const keyInput = container.querySelector('#aoiApiKey');
            let apiKey = keyInput.value;

            if (apiKey === '••••••••') {
                const presets = getAoiPresets();
                apiKey = presets.find(p => p.isDefault)?.apiKey || '';
            }

            if (!endpoint || !model || !apiKey) {
                const el = container.querySelector('#aoiApiStatus');
                if (el) { el.textContent = '请填写完整信息'; el.style.color = '#e53935'; setTimeout(() => el.textContent = '', 3000); }
                return;
            }

            saveAoiPresets([{
                id: 'aoi_default',
                name: 'Aoi 默认',
                endpoint,
                model,
                apiKey,
                isDefault: true
            }]);

            const el = container.querySelector('#aoiApiStatus');
            if (el) { el.textContent = '✅ Aoi API 设置已保存'; el.style.color = '#2e7d32'; setTimeout(() => el.textContent = '', 3000); }
        });
    }

    return { html, bind };
}

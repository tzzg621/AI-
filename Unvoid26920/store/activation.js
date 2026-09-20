// ============================================================
// ★★★ 激活码配置区（发布前请替换掉下面的示例码！）★★★
// 想增加 / 删除 / 修改激活码？只改 ACTIVATION_CODES 这一个数组即可。
// 说明：
//  - 码不区分大小写与空格，输入时自动整理（大写 + 去空白）。
//  - 码以明文存在源码里。纯前端校验注定可被绕过，
//    若想提高门槛可改为存 SHA-256 哈希（crypto.subtle.digest），
//    代价是每次改码都要重新算哈希，这里从简用明文。
//  - 设备激活后会把码存进 localStorage，之后每次启动重新校验一遍：
//    你改掉 ACTIVATION_CODES 后，旧码设备会自动重新上锁。
// ============================================================
export const ACTIVATION_CODES = [
    'CREATOR-2026-8888',
    'CREATOR-2468-1357',
    'CREATOR-9527-0413',
    'CREATOR-8888-0000',
    '2694',
];

// ★ 开发者调试键位（DevTools 里删除即可重新上锁 / 解除锁定倒计时）：
//   localStorage.removeItem('app_activation_code')           → 重新上锁
//   localStorage.removeItem('app_activation_fails')          → 清空失败次数
//   localStorage.removeItem('app_activation_lock_until')     → 解除暴力破解锁定
const STORAGE_KEY = 'app_activation_code';
const FAILS_KEY = 'app_activation_fails';
const LOCK_UNTIL_KEY = 'app_activation_lock_until';
const MAX_FAILS = 5;            // 连续输错 N 次后…
const LOCKOUT_MS = 30 * 1000;   // …锁定 30 秒（刷新后依然有效）

/** 整理输入：去首尾空白、大写、去所有空白（方便复制粘贴） */
export function normalizeCode(input) {
    return String(input ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

function safeGet(key) {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function safeSet(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {
        /* 隐私模式下忽略写入失败 */
    }
}

function safeRemove(key) {
    try {
        localStorage.removeItem(key);
    } catch {
        /* 忽略 */
    }
}

/** 当前是否处于已激活状态（每次调用都重校验存储的码是否仍有效） */
export function isActivated() {
    const stored = safeGet(STORAGE_KEY);
    if (!stored) return false;
    return ACTIVATION_CODES.includes(normalizeCode(stored));
}

/** 距离暴力破解锁定解除还剩多少毫秒（0 = 未锁定） */
export function getLockRemaining() {
    const until = Number(safeGet(LOCK_UNTIL_KEY) || 0);
    return Math.max(0, until - Date.now());
}

/**
 * 尝试用输入激活。
 * @returns {{ ok: true } | { ok: false, reason: 'invalid'|'locked', remainMs: number }}
 */
export function tryActivate(input) {
    const remainMs = getLockRemaining();
    if (remainMs > 0) {
        return { ok: false, reason: 'locked', remainMs };
    }

    const code = normalizeCode(input);
    if (code && ACTIVATION_CODES.includes(code)) {
        safeSet(STORAGE_KEY, code);
        safeRemove(FAILS_KEY);
        safeRemove(LOCK_UNTIL_KEY);
        return { ok: true };
    }

    const fails = Number(safeGet(FAILS_KEY) || 0) + 1;
    safeSet(FAILS_KEY, String(fails));
    if (fails >= MAX_FAILS) {
        safeSet(LOCK_UNTIL_KEY, String(Date.now() + LOCKOUT_MS));
        safeSet(FAILS_KEY, '0');
        return { ok: false, reason: 'locked', remainMs: LOCKOUT_MS };
    }
    return { ok: false, reason: 'invalid', remainMs: 0 };
}

/**
 * 把激活锁屏挂载进 container（#pageContainer）。
 * 大时钟 + 输入框 + 激活按钮；Enter 提交、错误摇动、连错锁定倒计时。
 * @param {HTMLElement} container
 * @param {{ onSuccess?: Function }} options 激活成功后的回调
 */
export function mountLockScreen(container, { onSuccess } = {}) {
    const now = new Date();
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const dateStr = `${now.getMonth() + 1}月${now.getDate()}日 周${weekdays[now.getDay()]}`;

    container.innerHTML = `
        <div class="lock-screen">
            <div class="lock-clock">--:--</div>
            <div class="lock-date">${dateStr}</div>
            <div class="lock-title">缔造者空间</div>
            <div class="lock-subtitle">请输入激活码解锁</div>
            <div class="lock-input-row">
                <input class="lock-input" maxlength="40" autocapitalize="characters"
                       autocomplete="off" spellcheck="false"
                       placeholder="CREATOR-XXXX-XXXX" aria-label="激活码">
                <button class="lock-btn" type="button">激活</button>
            </div>
            <div class="lock-msg" role="alert" aria-live="polite"></div>
        </div>
    `;

    const clockEl = container.querySelector('.lock-clock');
    const msgEl = container.querySelector('.lock-msg');
    const inputEl = container.querySelector('.lock-input');
    const btnEl = container.querySelector('.lock-btn');
    const inputRowEl = container.querySelector('.lock-input-row');

    const pad = (n) => String(n).padStart(2, '0');

    // ---- 大时钟 ----
    const tickClock = () => {
        const d = new Date();
        clockEl.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    tickClock();
    const clockTimer = setInterval(tickClock, 1000);

    // ---- 防暴力破解倒计时 ----
    let lockTimer = null;

    function setLockedUI(locked, remainMs = 0) {
        inputEl.disabled = locked;
        btnEl.disabled = locked;
        if (locked) {
            const seconds = Math.ceil(remainMs / 1000);
            msgEl.classList.remove('ok');
            msgEl.textContent = `尝试次数过多，请 ${seconds} 秒后再试`;
        }
    }

    function startLockCountdown(remainMs) {
        setLockedUI(true, remainMs);
        clearInterval(lockTimer);
        lockTimer = setInterval(() => {
            const left = getLockRemaining();
            if (left <= 0) {
                clearInterval(lockTimer);
                lockTimer = null;
                setLockedUI(false);
                msgEl.textContent = '';
                inputEl.focus();
            } else {
                setLockedUI(true, left);
            }
        }, 500);
    }

    // ---- 提交激活 ----
    const submit = () => {
        if (inputEl.disabled) return;

        const result = tryActivate(inputEl.value);
        if (result.ok) {
            // 成功反馈，稍作停顿再进主页
            msgEl.textContent = '激活成功，欢迎使用 ✨';
            msgEl.classList.add('ok');
            btnEl.textContent = '已激活';
            inputEl.disabled = true;
            btnEl.disabled = true;
            clearInterval(clockTimer);
            if (lockTimer) clearInterval(lockTimer);
            setTimeout(() => {
                if (typeof onSuccess === 'function') onSuccess();
            }, 600);
        } else if (result.reason === 'locked') {
            startLockCountdown(result.remainMs);
        } else {
            msgEl.classList.remove('ok');
            msgEl.textContent = '激活码不正确，请重新输入';
            inputRowEl.classList.remove('shake');
            void inputRowEl.offsetWidth;   // 重启动画
            inputRowEl.classList.add('shake');
            inputEl.select();
        }
    };

    btnEl.addEventListener('click', submit);
    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            submit();
        }
    });
    inputRowEl.addEventListener('animationend', () => {
        inputRowEl.classList.remove('shake');
    });

    // 挂载时若正处于锁定倒计时，直接进入禁用态
    const remainMs = getLockRemaining();
    if (remainMs > 0) startLockCountdown(remainMs);

    inputEl.focus();
}

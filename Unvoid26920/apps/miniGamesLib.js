// apps/miniGamesLib.js — 示例组件
//
// 这些**不进数据库**：列表页单独一个「示例」区，点开即玩，想留就按「存为我的组件」。
// （上一版草稿走的是「首次进入自动导入内置组件」，那条路把一个没填的占位符写进了库——
//   示例是代码里的常量，不该悄悄变成用户数据。）
//
// 示例里刻意用了两种形态：
//   · 猜数字 —— 会调 window.mgReport() 上报结果，于是产生运行记录
//   · 呼吸节拍 —— 纯互动，一句都不上报（上报是可选的，不是必填契约）

export const SAMPLE_COMPONENTS = [
    {
        id: 'sample_guess_number',
        title: '猜数字',
        tags: ['益智', '简单'],
        html: `<div class="demo-guess">
  <style>
    .demo-guess { padding:22px 18px; max-width:360px; margin:0 auto; text-align:center;
                  background:#f6f4ff; border-radius:16px; font-size:15px; }
    .demo-guess h2 { font-size:18px; margin:0 0 4px; color:#3b2f63; }
    .demo-guess .sub { font-size:12px; color:#8a83a8; margin-bottom:16px; }
    .demo-guess input { width:110px; padding:10px; font-size:18px; text-align:center;
                        border:2px solid #c9c0f0; border-radius:10px; outline:none; }
    .demo-guess input:focus { border-color:#7c4dff; }
    .demo-guess button { padding:10px 22px; margin-left:8px; border:none; border-radius:10px;
                         background:#7c4dff; color:#fff; font-size:14px; font-weight:600; cursor:pointer; }
    .demo-guess button:disabled { background:#c9c0f0; cursor:default; }
    .demo-guess .hint { margin-top:14px; font-size:14px; color:#5a5378; min-height:22px; }
  </style>
  <h2>🎲 猜数字</h2>
  <div class="sub">1 到 100，你有 7 次机会</div>
  <input id="guessInput" type="number" min="1" max="100" placeholder="?">
  <button id="guessBtn">猜一下</button>
  <div class="hint" id="guessHint"></div>
</div>
<script>
(function () {
    var answer = Math.floor(Math.random() * 100) + 1;
    var used = 0, max = 7, start = Date.now(), over = false;
    var input = document.getElementById('guessInput');
    var btn = document.getElementById('guessBtn');
    var hint = document.getElementById('guessHint');

    function finish(ok, msg) {
        over = true;
        input.disabled = true;
        btn.disabled = true;
        hint.textContent = msg;
        if (window.mgReport) {
            window.mgReport({
                success: ok,
                score: ok ? Math.max(0, 100 - used * 10) : 0,
                attempts: used,
                seconds: Math.round((Date.now() - start) / 1000),
                message: msg
            });
        }
    }

    function guess() {
        if (over) return;
        var n = parseInt(input.value, 10);
        if (!n || n < 1 || n > 100) { hint.textContent = '请输入 1 到 100 之间的整数'; return; }
        used++;
        if (n === answer) { finish(true, '✅ ' + used + ' 次猜中，答案是 ' + answer); return; }
        if (used >= max) { finish(false, '❌ 次数用完了，答案是 ' + answer); return; }
        hint.textContent = (n < answer ? '小了' : '大了') + '，还剩 ' + (max - used) + ' 次';
        input.value = '';
        input.focus();
    }

    btn.addEventListener('click', guess);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') guess(); });
    input.focus();
})();
<\/script>`
    },
    {
        id: 'sample_breathing',
        title: '呼吸节拍',
        tags: ['放松', '纯互动'],
        html: `<div class="demo-breath">
  <style>
    .demo-breath { padding:24px 18px; max-width:360px; margin:0 auto; text-align:center;
                   background:#eef6f4; border-radius:16px; }
    .demo-breath .stage { width:170px; height:170px; margin:0 auto 18px; border-radius:50%;
                          background:radial-gradient(circle at 35% 30%, #9fd8cb, #4E8A6B);
                          display:flex; align-items:center; justify-content:center;
                          color:#fff; font-size:17px; font-weight:600; letter-spacing:.08em;
                          transition:transform 4s ease-in-out; transform:scale(.62); }
    .demo-breath .meta { font-size:13px; color:#4a6b62; margin-bottom:14px; }
    .demo-breath button { padding:10px 24px; border:none; border-radius:10px; cursor:pointer;
                          background:#4E8A6B; color:#fff; font-size:14px; font-weight:600; }
    .demo-breath button.stop { background:#8aa8a0; }
  </style>
  <div class="stage" id="breathStage">准备</div>
  <div class="meta" id="breathMeta">4 秒吸气 · 7 秒屏息 · 8 秒呼气</div>
  <button id="breathBtn">开始</button>
</div>
<script>
(function () {
    // 4-7-8：这一支只用 CSS 过渡 + 定时器，一句都不上报
    var stage = document.getElementById('breathStage');
    var meta = document.getElementById('breathMeta');
    var btn = document.getElementById('breathBtn');
    var running = false, round = 0, timer = null, left = 0;

    function scale(v, sec) {
        stage.style.transition = 'transform ' + sec + 's ease-in-out';
        stage.style.transform = 'scale(' + v + ')';
    }

    function tick() {
        left--;
        if (left > 0) { meta.textContent = stage.textContent + ' · 第 ' + round + ' 轮 · 还剩 ' + left + ' 秒'; return; }

        if (stage.textContent === '吸气') { stage.textContent = '屏息'; scale(1, 0.4); left = 7; }
        else if (stage.textContent === '屏息') { stage.textContent = '呼气'; scale(0.62, 8); left = 8; }
        else { round++; stage.textContent = '吸气'; scale(1, 4); left = 4; }
        meta.textContent = stage.textContent + ' · 第 ' + round + ' 轮 · 还剩 ' + left + ' 秒';
    }

    btn.addEventListener('click', function () {
        if (running) {
            running = false;
            clearInterval(timer);
            btn.textContent = '开始';
            btn.classList.remove('stop');
            stage.textContent = '准备';
            stage.style.transition = 'transform .6s';
            scale(0.62, 0.6);
            meta.textContent = '停在第 ' + round + ' 轮';
            return;
        }
        running = true;
        btn.textContent = '停下';
        btn.classList.add('stop');
        stage.textContent = '吸气';
        round = 1;
        left = 4;
        scale(1, 4);
        meta.textContent = '吸气 · 第 1 轮 · 还剩 4 秒';
        timer = setInterval(tick, 1000);
    });
})();
<\/script>`
    }
];

export function findSample(id) {
    return SAMPLE_COMPONENTS.find(s => s.id === id) || null;
}

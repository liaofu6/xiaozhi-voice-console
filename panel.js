// Music MCP 控制台 —— 本地启停 music-mcp 服务 + 实时日志
// Designed & Coded by liaofu
// 用法：双击「启动音乐控制台.bat」

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn, execFile } = require('child_process');

const DIR = __dirname;
const PANEL_PORT = Number(process.env.PANEL_PORT || 3210);
const SERVICE_PORT = Number(process.env.SERVICE_PORT || 3000);
const METING_PORT = Number(process.env.METING_PORT || 3300);
const PHP_EXE = findPhp();
const METING_DIR = path.join(DIR, 'meting');
const SERVER_JS = path.join(DIR, 'server.js');
const COOKIE_FILE = path.join(DIR, 'cookie.txt');
const ENDPOINT_FILE = path.join(DIR, 'endpoint.txt');
const LOG_FILE = path.join(DIR, 'server.log');
const MAX_LINES = 800;

// ---------- AI 转接（小智自建服务端）----------
// 目录通过环境变量 XIAOZHI_SERVER_DIR 指定，默认按常见位置探测
const AI_DIR = process.env.XIAOZHI_SERVER_DIR || findAiDir();
const AI_APP = AI_DIR ? path.join(AI_DIR, 'main', 'xiaozhi-server', 'app.py') : '';
const AI_PYTHON = findAiPython(AI_DIR);
const AI_WS_PORT = Number(process.env.XIAOZHI_WS_PORT || 8000);
const AI_OTA_PORT = Number(process.env.XIAOZHI_OTA_PORT || 8003);

// ---------- 状态 ----------
let child = null;             // 由本控制台启动的音乐服务进程
let startedAt = 0;
let phpChild = null;          // 由本控制台启动的多平台(Meting)服务进程
let phpStartedAt = 0;
let aiChild = null;           // 由本控制台启动的 AI 转接（小智服务端）进程
let aiStartedAt = 0;
let logs = [];                // 内存日志环形
let sseClients = new Set();

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch (_) { return ''; }
}
function maskEndpoint(ep) {
  if (!ep) return '';
  try {
    const u = new URL(ep);
    const tok = u.searchParams.get('token') || '';
    return u.host + u.pathname + '（token ' + tok.length + ' 字符）';
  } catch (_) {
    return ep.length > 48 ? ep.slice(0, 48) + '…' : ep;
  }
}

function findPhp() {
  const env = (process.env.PHP_EXE || '').trim();
  if (env) return env;
  for (const p of ['E:\\php\\php.exe', 'C:\\php\\php.exe']) {
    if (fs.existsSync(p)) return p;
  }
  return 'php';
}

function findFfmpeg() {
  const env = (process.env.FFMPEG || '').trim();
  if (env && fs.existsSync(env)) return env;
  for (const p of ['E:\\ffmpeg\\ffmpeg.exe', 'C:\\ffmpeg\\ffmpeg.exe']) {
    if (fs.existsSync(p)) return p;
  }
  return 'ffmpeg';
}

// 探测小智服务端目录：环境变量 > 常见盘符位置
function findAiDir() {
  for (const p of ['E:\\xiaozhi-esp32-server', 'D:\\xiaozhi-esp32-server', 'C:\\xiaozhi-esp32-server']) {
    if (fs.existsSync(path.join(p, 'main', 'xiaozhi-server', 'app.py'))) return p;
  }
  return '';
}

// 优先用服务端自带 venv 的 python，回退到系统 python
function findAiPython(dir) {
  const env = (process.env.XIAOZHI_PYTHON || '').trim();
  if (env && fs.existsSync(env)) return env;
  if (dir) {
    const p = path.join(dir, '.venv', 'Scripts', 'python.exe');
    if (fs.existsSync(p)) return p;
    const p2 = path.join(dir, '.venv', 'bin', 'python');
    if (fs.existsSync(p2)) return p2;
  }
  return 'python';
}
function lanIp() {
  const ifaces = os.networkInterfaces();
  const cands = [];
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      cands.push(a.address);
    }
  }
  return cands.find((ip) => ip.startsWith('192.168.') || ip.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) || cands[0] || '127.0.0.1';
}

// ---------- 日志 ----------
function pushLog(line) {
  const text = line.replace(/\r?\n$/, '');
  if (!text) return;
  const stamped = '[' + new Date().toTimeString().slice(0, 8) + '] ' + text;
  logs.push(stamped);
  if (logs.length > MAX_LINES) logs = logs.slice(-MAX_LINES);
  for (const c of sseClients) {
    try { c.write('data: ' + JSON.stringify(stamped) + '\n\n'); } catch (_) {}
  }
}
function logToFile(line) {
  try { fs.appendFileSync(LOG_FILE, line.replace(/\r?\n$/, '') + '\r\n'); } catch (_) {}
}

// ---------- 进程管理 ----------
function envForService() {
  const cookie = readFileSafe(COOKIE_FILE);
  const endpoint = readFileSafe(ENDPOINT_FILE);
  const env = Object.assign({}, process.env, {
    PORT: String(SERVICE_PORT),
    METING_NETEASE_COOKIE: cookie,
    MCP_ENDPOINT: endpoint,
    FFMPEG: findFfmpeg(),
  });
  return env;
}

function startService() {
  if (child) { return { ok: false, msg: '服务已在运行（PID ' + child.pid + '）' }; }
  if (!fs.existsSync(SERVER_JS)) { return { ok: false, msg: '找不到 server.js' }; }
  const cookie = readFileSafe(COOKIE_FILE);
  const endpoint = readFileSafe(ENDPOINT_FILE);
  if (!cookie) pushLog('[panel] 警告：cookie.txt 为空，网易云可能取不到播放地址');
  if (!endpoint) pushLog('[panel] 警告：endpoint.txt 为空，服务不会连小智接入点');

  // 顺带把多平台服务拉起来（QQ音乐/酷狗要用；失败不影响主服务）
  const mr = startMeting();
  if (!mr.ok && mr.msg.indexOf('已在运行') < 0) pushLog('[panel] 多平台服务未启动：' + mr.msg);

  child = spawn(process.execPath, [SERVER_JS], { cwd: DIR, env: envForService(), windowsHide: true });
  startedAt = Date.now();
  pushLog('[panel] 启动服务 node server.js (PID ' + child.pid + ')');

  const onData = (buf) => {
    const s = buf.toString();
    logToFile(s);
    s.split(/\r?\n/).forEach((l) => pushLog(l));
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code, sig) => {
    pushLog('[panel] 服务已退出 code=' + code + ' sig=' + (sig || '-'));
    child = null; startedAt = 0;
  });
  return { ok: true, msg: '已启动' };
}

function killTree(pid, cb) {
  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => cb && cb());
}

function stopService(cb) {
  if (child) {
    const pid = child.pid;
    pushLog('[panel] 停止服务 (PID ' + pid + ')');
    const done = () => { if (cb) cb(); };
    try { child.kill(); } catch (_) {}
    killTree(pid, () => { child = null; startedAt = 0; done(); });
    return;
  }
  // 没有本控制台启动的实例，但端口可能被别处占用
  findPortPid(SERVICE_PORT, (pid) => {
    if (!pid) { if (cb) cb(); return; }
    pushLog('[panel] 端口 ' + SERVICE_PORT + ' 被 PID ' + pid + ' 占用，强制结束');
    killTree(pid, () => { if (cb) cb(); });
  });
}

// ---------- 多平台(Meting/PHP) 服务 ----------
function startMeting() {
  if (phpChild) return { ok: false, msg: '多平台服务已在运行（PID ' + phpChild.pid + '）' };
  if (!fs.existsSync(PHP_EXE)) return { ok: false, msg: '找不到 php.exe：' + PHP_EXE };
  if (!fs.existsSync(path.join(METING_DIR, 'router.php')) &&
      !fs.existsSync(path.join(METING_DIR, 'api.php'))) {
    return { ok: false, msg: '找不到 meting 目录里的入口文件' };
  }
  phpChild = spawn(
    PHP_EXE,
    ['-S', '127.0.0.1:' + METING_PORT, '-t', METING_DIR, path.join(METING_DIR, 'router.php')],
    { cwd: METING_DIR, windowsHide: true }
  );
  phpStartedAt = Date.now();
  pushLog('[panel] 启动多平台服务 php -S 127.0.0.1:' + METING_PORT + ' (PID ' + phpChild.pid + ')');
  const onData = (buf) => {
    buf.toString().split(/\r?\n/).forEach((l) => {
      const t = l.trim();
      if (!t) return;
      // 丢掉 PHP 内置服务器的连接探测噪声（面板每 2 秒探活会刷屏）
      if (/\bAccepted\s*$|\bClosing\s*$|Closed without sending a request/.test(t)) return;
      pushLog('[meting] ' + t);
    });
  };
  phpChild.stdout.on('data', onData);
  phpChild.stderr.on('data', onData);
  phpChild.on('error', (e) => pushLog('[panel] 多平台服务启动失败：' + ((e && e.message) || e)));
  phpChild.on('exit', (code) => {
    pushLog('[panel] 多平台服务已退出 code=' + code);
    phpChild = null; phpStartedAt = 0;
  });
  return { ok: true, msg: '已启动多平台服务' };
}

function stopMeting(cb) {
  if (phpChild) {
    const pid = phpChild.pid;
    pushLog('[panel] 停止多平台服务 (PID ' + pid + ')');
    try { phpChild.kill(); } catch (_) {}
    killTree(pid, () => { phpChild = null; phpStartedAt = 0; cb && cb(); });
    return;
  }
  findPortPid(METING_PORT, (pid) => {
    if (!pid) { cb && cb(); return; }
    pushLog('[panel] 端口 ' + METING_PORT + ' 被 PID ' + pid + ' 占用，强制结束');
    killTree(pid, () => cb && cb());
  });
}

// ---------- AI 转接（小智自建服务端 / Python） ----------
function aiEnv() {
  const env = Object.assign({}, process.env);
  if (AI_DIR) {
    const scripts = path.join(AI_DIR, '.venv', 'Scripts');
    env.PATH = scripts + path.delimiter + (env.PATH || '');
  }
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUTF8 = '1';
  return env;
}

function startAi() {
  if (aiChild) return { ok: false, msg: 'AI 转接已在运行（PID ' + aiChild.pid + '）' };
  if (!AI_DIR) return { ok: false, msg: '找不到小智服务端，请设置环境变量 XIAOZHI_SERVER_DIR' };
  if (!fs.existsSync(AI_APP)) return { ok: false, msg: '找不到服务入口：' + AI_APP };
  const cwd = path.dirname(AI_APP);
  aiChild = spawn(AI_PYTHON, ['app.py'], { cwd, env: aiEnv(), windowsHide: true });
  aiStartedAt = Date.now();
  pushLog('[panel] 启动 AI 转接 ' + AI_PYTHON + ' app.py (PID ' + aiChild.pid + ')');
  const onData = (buf) => {
    buf.toString().split(/\r?\n/).forEach((l) => {
      const t = l.trim();
      if (!t) return;
      pushLog('[ai] ' + t);
    });
  };
  aiChild.stdout.on('data', onData);
  aiChild.stderr.on('data', onData);
  aiChild.on('error', (e) => pushLog('[panel] AI 转接启动失败：' + ((e && e.message) || e)));
  aiChild.on('exit', (code, sig) => {
    pushLog('[panel] AI 转接已退出 code=' + code + ' sig=' + (sig || '-'));
    aiChild = null; aiStartedAt = 0;
  });
  return { ok: true, msg: 'AI 转接启动中，首次加载语音模型需要几十秒' };
}

function stopAi(cb) {
  if (aiChild) {
    const pid = aiChild.pid;
    pushLog('[panel] 停止 AI 转接 (PID ' + pid + ')');
    try { aiChild.kill(); } catch (_) {}
    killTree(pid, () => { aiChild = null; aiStartedAt = 0; cb && cb(); });
    return;
  }
  findPortPid(AI_WS_PORT, (pid) => {
    if (!pid) { cb && cb(); return; }
    pushLog('[panel] AI 端口 ' + AI_WS_PORT + ' 被 PID ' + pid + ' 占用，强制结束');
    killTree(pid, () => cb && cb());
  });
}

function findPortPid(port, cb) {
  execFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true }, (err, stdout) => {
    if (err) { cb(null); return; }
    const lines = String(stdout).split(/\r?\n/);
    for (const l of lines) {
      const m = l.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
      if (m && Number(m[1]) === port) { cb(Number(m[2])); return; }
    }
    cb(null);
  });
}

function probePort(port, cb) {
  const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); cb(true); });
  sock.on('error', () => cb(false));
  sock.setTimeout(800, () => { sock.destroy(); cb(false); });
}

// ---------- 页面 ----------
const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Music MCP 控制台</title>
<style>
  :root{--bg:#f2f5fa;--card:#ffffff;--line:#d3dbea;--ink:#2c3440;--muted:#7b8698;
        --green:#59b96b;--green-d:#3f9a52;--red:#e8756c;--red-d:#cf5b52;
        --blue:#6aa9e0;--blue-d:#4f8ec9;--amber:#e8b45c;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
       font-family:"Microsoft YaHei UI","Segoe UI",system-ui,sans-serif;}
  .wrap{max-width:900px;margin:0 auto;padding:22px 18px 40px}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:var(--muted);font-size:13px;margin-bottom:18px}
  .card{background:var(--card);border:2px solid var(--line);border-radius:16px;
        padding:16px 18px;margin-bottom:14px}
  .row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .dot{width:12px;height:12px;border-radius:50%;background:var(--muted)}
  .dot.on{background:var(--green)} .dot.off{background:var(--red)}
  .badge{font-size:12px;padding:3px 10px;border-radius:999px;border:2px solid var(--line);
         color:var(--muted)}
  .badge.on{border-color:var(--green);color:var(--green-d);background:#eef8f0}
  .badge.off{border-color:var(--red);color:var(--red-d);background:#fdeeec}
  button{font:inherit;font-size:14px;padding:9px 18px;border-radius:12px;cursor:pointer;
         border:2px solid transparent;color:#fff;background:var(--blue);border-color:var(--blue-d)}
  button:hover{filter:brightness(1.05)}
  button:disabled{opacity:.45;cursor:not-allowed}
  button.g{background:var(--green);border-color:var(--green-d)}
  button.r{background:var(--red);border-color:var(--red-d)}
  button.w{background:#fff;color:var(--ink);border-color:var(--line)}
  .kvs{display:grid;grid-template-columns:120px 1fr;gap:8px 12px;font-size:13px;margin-top:14px}
  .k{color:var(--muted)} .v{word-break:break-all}
  code{background:#eef2f8;border-radius:6px;padding:2px 6px;font-size:12px}
  #log{background:#2b2f36;color:#d7e2f0;border-radius:12px;padding:12px;height:300px;
       overflow:auto;font-family:Consolas,monospace;font-size:12px;line-height:1.6;
       white-space:pre-wrap;word-break:break-all}
  .tabs{display:flex;gap:6px;background:#eef2f8;border-radius:12px;padding:4px}
  .tab{font-size:13px;padding:5px 16px;border-radius:9px;cursor:pointer;color:var(--muted)}
  .tab.on{background:#fff;color:var(--ink);border:2px solid var(--line)}
  #flt{font:inherit;font-size:13px;padding:7px 12px;border:2px solid var(--line);
       border-radius:10px;width:180px;background:#fff;color:var(--ink)}
  .chk{font-size:12px;color:var(--muted);display:flex;align-items:center;gap:5px;cursor:pointer}
  .evlist{max-height:340px;overflow:auto;margin-top:10px}
  .ev{display:flex;gap:10px;align-items:baseline;padding:6px 8px;border-radius:8px;font-size:13px}
  .ev:nth-child(odd){background:#f7f9fc}
  .ev .t{color:var(--muted);font-size:12px;min-width:60px}
  .ev .chip{font-size:11px;padding:1px 8px;border-radius:999px;border:2px solid var(--line);
            color:var(--muted);white-space:nowrap}
  .chip.call{border-color:var(--blue);color:var(--blue-d);background:#eef4fb}
  .chip.ok{border-color:var(--green);color:var(--green-d);background:#eef8f0}
  .chip.err{border-color:var(--red);color:var(--red-d);background:#fdeeec}
  .chip.play{border-color:#b48ce0;color:#8a63bd;background:#f4effb}
  .chip.net{border-color:#e8b45c;color:#b8862c;background:#fdf6e8}
  .ev .x{flex:1;word-break:break-all}
  .ev .d{color:var(--muted);font-size:12px}
  .empty{color:var(--muted);font-size:13px;padding:14px}
  #epInput{width:100%;margin-top:12px;min-height:76px;resize:vertical;font-family:Consolas,monospace;
           font-size:12px;line-height:1.5;padding:10px 12px;border:2px solid var(--line);
           border-radius:10px;background:#fff;color:var(--ink)}
  .hint{color:var(--muted);font-size:12px;margin-top:8px}
  .foot{text-align:center;color:var(--muted);font-size:12px;margin-top:22px}
</style></head>
<body><div class="wrap">
  <h1>Music MCP 控制台</h1>
  <div class="sub">本地网易云音乐服务 · 随开随关，不开机自启</div>

  <div class="card">
    <div class="row">
      <span class="dot" id="dot"></span>
      <b id="stText">检查中…</b>
      <span class="badge" id="stBadge">--</span>
      <span style="flex:1"></span>
      <button class="g" id="btnStart">启动</button>
      <button class="r" id="btnStop">停止</button>
      <button class="w" id="btnRestart">重启</button>
    </div>
    <div class="kvs">
      <div class="k">服务地址</div><div class="v" id="kUrl">--</div>
      <div class="k">设备播放地址</div><div class="v" id="kOgg">--</div>
      <div class="k">运行时长</div><div class="v" id="kUp">--</div>
      <div class="k">网易云 Cookie</div><div class="v" id="kCookie">--</div>
      <div class="k">ffmpeg</div><div class="v" id="kFfmpeg">--</div>
    </div>
  </div>

  <div class="card">
    <div class="row">
      <span class="dot" id="mDot"></span>
      <b>多平台服务</b>
      <span class="badge" id="mBadge">--</span>
      <span style="flex:1"></span>
      <button class="g" id="btnMStart">启动</button>
      <button class="r" id="btnMStop">停止</button>
    </div>
    <div class="kvs">
      <div class="k">本地接口</div><div class="v" id="mApi">--</div>
      <div class="k">支持平台</div><div class="v">网易云（主服务直连）、QQ音乐、酷狗音乐</div>
      <div class="k">说明</div><div class="v">QQ音乐/酷狗的<b>付费会员曲</b>取不到播放地址，免费曲正常；未启动时只会影响这两个平台</div>
    </div>
  </div>

  <div class="card">
    <div class="row">
      <span class="dot" id="aiDot"></span>
      <b>AI 转接（小智服务端）</b>
      <span class="badge" id="aiBadge">--</span>
      <span style="flex:1"></span>
      <button class="g" id="btnAiStart">启动</button>
      <button class="r" id="btnAiStop">停止</button>
    </div>
    <div class="kvs">
      <div class="k">服务目录</div><div class="v" id="aiDir">--</div>
      <div class="k">Python</div><div class="v" id="aiPy">--</div>
      <div class="k">设备 WebSocket</div><div class="v" id="aiWs">--</div>
      <div class="k">设备 OTA</div><div class="v" id="aiOta">--</div>
      <div class="k">说明</div><div class="v">首次启动要加载语音识别模型，<b>约需 1 分钟</b>；目录可用环境变量 <code>XIAOZHI_SERVER_DIR</code> 指定</div>
    </div>
  </div>

  <div class="card">
    <div class="row">
      <b>小智接入点</b>
      <span class="badge" id="epBadge">--</span>
      <span style="flex:1"></span>
      <button class="g" id="btnEpSave">保存并重启</button>
    </div>
    <div class="kvs">
      <div class="k">当前接入点</div><div class="v" id="kEp">--</div>
    </div>
    <textarea id="epInput" placeholder="wss://api.xiaozhi.me/mcp/?token=..." spellcheck="false"></textarea>
    <div class="hint">修改后点「保存并重启」，会写入 endpoint.txt 并重启音乐服务生效。留空保存表示不连接入点（仅本地服务模式）。</div>
  </div>

  <div class="card">
    <div class="row">
      <div class="tabs">
        <span class="tab on" id="tabEv">事件视图</span>
        <span class="tab" id="tabRaw">原始日志</span>
      </div>
      <input id="flt" placeholder="筛选关键词…">
      <label class="chk"><input type="checkbox" id="onlyKey" checked> 只看关键</label>
      <span style="flex:1"></span>
      <span class="badge" id="logCount">0</span>
      <button class="w" id="btnClear">清空</button>
      <button class="w" id="btnFolder">打开目录</button>
      <button class="r" id="btnQuit">退出控制台</button>
    </div>
    <div id="evList" class="evlist"><div class="empty">等待事件…</div></div>
    <pre id="log" style="display:none"></pre>
  </div>

  <div class="foot">Music MCP Console &middot; Designed &amp; Coded by <b>liaofu</b></div>
</div>
<script>
const $ = (id) => document.getElementById(id);
let upTimer = null;

function api(path, method) {
  return fetch(path, { method: method || 'GET' }).then(r => r.json()).catch(() => ({}));
}

function fmtUptime(sec) {
  if (!sec || sec < 0) return '--';
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return h + ':' + m + ':' + s;
}

async function refresh() {
  const s = await api('/api/status');
  const on = !!s.running;
  $('dot').className = 'dot ' + (on ? 'on' : 'off');
  $('stText').textContent = on ? ('服务运行中（PID ' + s.pid + '）') : '服务未运行';
  const b = $('stBadge');
  b.textContent = s.external ? '外部实例占用端口' : (on ? '由本控制台启动' : '已停止');
  b.className = 'badge ' + (on ? 'on' : 'off');
  $('kUrl').innerHTML = 'http://' + s.lanIp + ':' + s.servicePort + ' <code>/stream/&lt;id&gt;.ogg</code>';
  $('kOgg').textContent = 'http://' + s.lanIp + ':' + s.servicePort + '/stream/<歌曲id>.ogg';
  $('kUp').textContent = on ? fmtUptime(s.uptime) : '--';
  $('kCookie').textContent = s.cookieLen > 0 ? ('已加载（' + s.cookieLen + ' 字符）') : '未加载（cookie.txt 为空）';
  $('kEp').textContent = s.endpoint || '未配置（仅本地服务模式）';
  $('epBadge').textContent = s.endpoint ? '已配置' : '未配置';
  $('epBadge').className = 'badge ' + (s.endpoint ? 'on' : 'off');
  $('kFfmpeg').textContent = s.ffmpeg;
  $('btnStart').disabled = on;
  $('btnStop').disabled = !on && !s.external;
  const m = s.meting || {};
  const mOn = !!m.listening;
  $('mDot').className = 'dot ' + (mOn ? 'on' : 'off');
  $('mBadge').textContent = mOn ? ('运行中（PID ' + (m.pid || '-') + '）') : '已停止';
  $('mBadge').className = 'badge ' + (mOn ? 'on' : 'off');
  $('mApi').innerHTML = s.phpExists
    ? 'http://127.0.0.1:' + m.port + ' <code>/api.php?server=tencent</code>'
    : '找不到 php.exe（E:/php/php.exe），多平台不可用';
  $('btnMStart').disabled = mOn;
  $('btnMStop').disabled = !mOn;
  $('logCount').textContent = s.logLines;

  const ai = await api('/api/ai/status');
  const aiOn = !!ai.listening;
  $('aiDot').className = 'dot ' + (aiOn ? 'on' : 'off');
  $('aiBadge').textContent = ai.running ? ('运行中（PID ' + ai.pid + '）')
    : (ai.listening ? '外部实例占用端口' : (ai.appExists ? '已停止' : '未找到服务端'));
  $('aiBadge').className = 'badge ' + (aiOn ? 'on' : 'off');
  $('aiDir').textContent = ai.dir || '未找到（请设置 XIAOZHI_SERVER_DIR）';
  $('aiPy').textContent = ai.python || '--';
  $('aiWs').innerHTML = ai.dir ? 'ws://' + ai.lanIp + ':' + ai.wsPort + ' <code>/xiaozhi/v1/</code>' : '--';
  $('aiOta').innerHTML = ai.dir ? 'http://' + ai.lanIp + ':' + ai.otaPort + ' <code>/xiaozhi/ota/</code>' : '--';
  $('btnAiStart').disabled = aiOn || !ai.appExists;
  $('btnAiStop').disabled = !aiOn;
}

document.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', async () => {
    const id = btn.id;
    if (id === 'btnStart') { btn.textContent = '启动中…'; await api('/api/start','POST'); btn.textContent = '启动'; }
    if (id === 'btnStop') { btn.textContent = '停止中…'; await api('/api/stop','POST'); btn.textContent = '停止'; }
    if (id === 'btnRestart') { btn.textContent = '重启中…'; await api('/api/restart','POST'); btn.textContent = '重启'; }
    if (id === 'btnMStart') { btn.textContent = '启动中…'; await api('/api/meting/start','POST'); btn.textContent = '启动'; }
    if (id === 'btnMStop') { btn.textContent = '停止中…'; await api('/api/meting/stop','POST'); btn.textContent = '停止'; }
    if (id === 'btnAiStart') { btn.textContent = '启动中…'; const r = await api('/api/ai/start','POST'); btn.textContent = '启动'; if (r && r.ok === false) alert('启动失败：' + r.msg); }
    if (id === 'btnAiStop') { btn.textContent = '停止中…'; await api('/api/ai/stop','POST'); btn.textContent = '停止'; }
    if (id === 'btnClear') { rawAll = []; await api('/api/logs/clear','POST'); scheduleRender(); }
    if (id === 'btnFolder') { await api('/api/open-folder','POST'); return; }
    if (id === 'btnEpSave') {
      const val = $('epInput').value.trim();
      if (val && !val.startsWith('ws://') && !val.startsWith('wss://')) { alert('接入点必须以 ws:// 或 wss:// 开头'); return; }
      btn.textContent = '保存中…';
      const r = await fetch('/api/endpoint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: val }),
      }).then(x => x.json()).catch(() => ({}));
      btn.textContent = '保存并重启';
      if (r && r.ok) { alert('已保存，音乐服务已重启'); setTimeout(refresh, 800); }
      else alert('保存失败：' + ((r && r.msg) || '未知错误'));
      return;
    }
    if (id === 'btnQuit') {
      if (!confirm('退出控制台会同时停止音乐服务，确定吗？')) return;
      await api('/api/quit','POST');
      document.body.innerHTML = '<div class="wrap"><div class="card">控制台已退出，可以关闭此窗口。</div></div>';
      return;
    }
    setTimeout(refresh, 600);
  });
});

// ---------- 日志：原始 + 事件解析 ----------
let rawAll = [];
let activeTab = 'ev';
let renderPending = false;

const PLAT = { netease: '网易云', tencent: 'QQ音乐', kugou: '酷狗' };
const platName = (p) => PLAT[p] || p;

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// 把一行原始日志解析成一条人话事件
function parseLine(line) {
  const m = line.match(/^\\[(\\d\\d:\\d\\d:\\d\\d)\\]\\s?([\\s\\S]*)$/);
  const t = m ? m[1] : '';
  const s = m ? m[2] : line;
  const tag = s.match(/^\\[(\\w[\\w-]*)\\]\\s?([\\s\\S]*)$/);
  const tg = tag ? tag[1] : '';
  const body = tag ? tag[2] : s;
  const ev = { t, chip: '日志', cls: '', text: s, d: '', key: false };

  if (tg === 'xiaozhi' || tg === 'local') {
    let mm;
    if ((mm = body.match(/^调用\\s+(\\S+)\\s*([\\s\\S]*)$/))) {
      ev.chip = '调用工具'; ev.cls = 'call'; ev.key = true;
      ev.text = mm[1]; ev.d = mm[2] || '';
    } else if ((mm = body.match(/^返回\\s+(\\S+)\\s+([\\s\\S]*)$/))) {
      ev.cls = /^❌/.test(mm[2] || '') ? 'err' : 'ok';
      ev.chip = ev.cls === 'err' ? '操作失败' : '执行完成';
      ev.text = mm[1] + ' → ' + (mm[2] || '');
      ev.key = true;
    } else if ((mm = body.match(/^出错\\s+(\\S+)\\s*([\\s\\S]*)$/))) {
      ev.chip = '出错'; ev.cls = 'err'; ev.key = true;
      ev.text = mm[1] + ' ' + mm[2];
    } else if (/已连接|connected/.test(body)) {
      ev.chip = '已连接'; ev.cls = 'ok'; ev.key = true;
      ev.text = '已连上小智接入点，工具已注册';
    } else if (/closed|disconnected/.test(body)) {
      ev.chip = '连接断开'; ev.cls = 'err'; ev.key = true; ev.text = body;
    } else if (/connecting/.test(body)) {
      ev.chip = '连接中'; ev.cls = 'net'; ev.text = '正在连接小智接入点…';
    } else {
      ev.chip = '协议'; ev.text = body;
    }
    return ev;
  }
  if (tg === 'music-mcp') {
    ev.chip = '服务就绪'; ev.cls = 'ok'; ev.key = true;
    ev.text = /cookie=yes/.test(body) ? '服务已就绪（网易云 Cookie 已加载）' : '服务已就绪（Cookie 未加载）';
    return ev;
  }
  if (tg === 'stream') {
    const mm = body.match(/platform=(\\S+)\\s+id=(\\S+)/);
    ev.chip = '开始播放'; ev.cls = 'play'; ev.key = true;
    ev.text = '转码播放 ' + (mm ? platName(mm[1]) + ' · ' + mm[2] : body);
    return ev;
  }
  if (tg === 'url') {
    const mm = body.match(/platform=(\\S+)\\s+id=(\\S+)/);
    ev.chip = '取得地址'; ev.cls = 'play'; ev.key = true;
    ev.text = '已取到播放地址 ' + (mm ? platName(mm[1]) + ' · ' + mm[2] : body);
    return ev;
  }
  if (tg === 'outer') {
    const okOuter = /status=302/.test(body) && !body.includes('/404') && !/ERROR/.test(body);
    const idOuter = body.match(/id=(\S+)/);
    ev.chip = okOuter ? '源站取址' : '源站异常';
    ev.cls = okOuter ? '' : 'err';
    ev.key = !okOuter;
    ev.text = okOuter ? ('源站重定向正常' + (idOuter ? ' · id=' + idOuter[1] : '')) : body;
    return ev;
  }
  if (tg === 'ffmpeg') {
    const bad = /error|failed|Invalid|No such|spawn/i.test(body);
    ev.chip = '转码'; ev.cls = bad ? 'err' : ''; ev.key = bad; ev.text = body;
    return ev;
  }
  if (tg === 'panel') {
    ev.chip = '控制台'; ev.cls = /失败|警告/.test(body) ? 'err' : '';
    ev.key = /启动|停止|退出|警告|失败/.test(body);
    ev.text = body;
    return ev;
  }
  if (tg === 'meting') { ev.chip = '多平台'; ev.text = body; return ev; }
  ev.text = body;
  return ev;
}

function render() {
  renderPending = false;
  const evs = rawAll.map(parseLine);
  const kw = ($('flt').value || '').trim().toLowerCase();
  const onlyKey = $('onlyKey').checked;

  if (activeTab === 'raw') {
    $('evList').style.display = 'none';
    const box = $('log');
    box.style.display = '';
    let lines = rawAll;
    if (kw) lines = lines.filter((l) => l.toLowerCase().indexOf(kw) >= 0);
    box.textContent = lines.join('\\n');
    box.scrollTop = box.scrollHeight;
  } else {
    $('log').style.display = 'none';
    const list = $('evList');
    list.style.display = '';
    let shown = evs;
    if (onlyKey) shown = shown.filter((e) => e.key);
    if (kw) shown = shown.filter((e) =>
      (e.text + ' ' + (e.d || '') + ' ' + e.chip).toLowerCase().indexOf(kw) >= 0);
    shown = shown.slice(-400);
    if (!shown.length) {
      list.innerHTML = '<div class="empty">' + (rawAll.length ? '当前筛选下没有事件' : '等待事件…') + '</div>';
    } else {
      const nearBottom = list.scrollTop + list.clientHeight > list.scrollHeight - 80;
      list.innerHTML = shown.map((e) =>
        '<div class="ev"><span class="t">' + e.t + '</span>' +
        '<span class="chip ' + e.cls + '">' + escHtml(e.chip) + '</span>' +
        '<span class="x">' + escHtml(e.text) +
        (e.d ? ' <span class="d">' + escHtml(e.d) + '</span>' : '') + '</span></div>'
      ).join('');
      if (nearBottom) list.scrollTop = list.scrollHeight;
    }
  }
  $('logCount').textContent = evs.filter((e) => e.key).length + ' 关键 / ' + rawAll.length + ' 行';
}

function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  setTimeout(render, 120);
}
function pushRaw(line) {
  rawAll.push(line);
  if (rawAll.length > 1500) rawAll = rawAll.slice(-1500);
  scheduleRender();
}

$('tabEv').addEventListener('click', () => {
  activeTab = 'ev';
  $('tabEv').className = 'tab on'; $('tabRaw').className = 'tab';
  render();
});
$('tabRaw').addEventListener('click', () => {
  activeTab = 'raw';
  $('tabRaw').className = 'tab on'; $('tabEv').className = 'tab';
  render();
});
$('flt').addEventListener('input', scheduleRender);
$('onlyKey').addEventListener('change', scheduleRender);

// 实时日志（SSE）
function connectLog() {
  const es = new EventSource('/api/logs/stream');
  es.onmessage = (e) => pushRaw(JSON.parse(e.data));
  es.onerror = () => { es.close(); setTimeout(connectLog, 2000); };
}

api('/api/logs').then((lines) => {
  rawAll = (lines || []).slice(-1500);
  render();
});
connectLog();
// 接入点只加载一次，避免刷新时覆盖用户正在编辑的内容
fetch('/api/endpoint').then(r => r.json()).then(d => {
  if (d && typeof d.endpoint === 'string') $('epInput').value = d.endpoint;
}).catch(() => {});
refresh();
setInterval(refresh, 2000);
</script></body></html>`;

// ---------- HTTP ----------
function json(res, obj, code) {
  const body = JSON.stringify(obj);
  res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, cb) {
  let buf = '';
  req.on('data', (c) => { buf += c; if (buf.length > 64 * 1024) req.destroy(); });
  req.on('end', () => {
    try { cb(JSON.parse(buf || '{}')); } catch (_) { cb({}); }
  });
  req.on('error', () => cb({}));
}

const panel = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  if (p === '/' || p === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(PAGE);
    return;
  }
  if (p === '/api/status') {
    probePort(SERVICE_PORT, (busy) => {
      // 面板自己启动的 Meting 直接视为运行中，不再每次 TCP 探活（会刷爆 PHP 连接日志）
      const finish = (mBusy) => json(res, {
          running: !!child, pid: child ? child.pid : 0,
          external: !child && busy,
          uptime: child && startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0,
          servicePort: SERVICE_PORT,
          meting: {
            running: !!phpChild && mBusy,
            pid: phpChild ? phpChild.pid : 0,
            port: METING_PORT,
            listening: mBusy,
            uptime: phpChild && phpStartedAt ? Math.floor((Date.now() - phpStartedAt) / 1000) : 0,
          },
          lanIp: lanIp(),
          cookieLen: readFileSafe(COOKIE_FILE).length,
          endpointLen: readFileSafe(ENDPOINT_FILE).length,
          endpoint: maskEndpoint(readFileSafe(ENDPOINT_FILE)),
          ffmpeg: findFfmpeg(),
          phpExists: fs.existsSync(PHP_EXE),
          logLines: logs.length,
        });
      if (phpChild) finish(true);
      else probePort(METING_PORT, finish);
    });
    return;
  }
  if (p === '/api/ai/status') {
    probePort(AI_WS_PORT, (busy) => {
      json(res, {
        dir: AI_DIR,
        appExists: !!AI_APP && fs.existsSync(AI_APP),
        python: AI_PYTHON,
        running: !!aiChild,
        pid: aiChild ? aiChild.pid : 0,
        external: !aiChild && busy,
        listening: !!aiChild || busy,
        uptime: aiChild && aiStartedAt ? Math.floor((Date.now() - aiStartedAt) / 1000) : 0,
        wsPort: AI_WS_PORT,
        otaPort: AI_OTA_PORT,
        lanIp: lanIp(),
      });
    });
    return;
  }
  if (p === '/api/logs') { json(res, logs); return; }
  if (p === '/api/endpoint' && req.method === 'GET') {
    json(res, { endpoint: readFileSafe(ENDPOINT_FILE) });
    return;
  }
  if (p === '/api/endpoint' && req.method === 'POST') {
    readBody(req, (body) => {
      const ep = String(body.endpoint || '').trim();
      if (ep && !/^wss?:\/\//i.test(ep)) { json(res, { ok: false, msg: '必须以 ws:// 或 wss:// 开头' }); return; }
      try {
        fs.writeFileSync(ENDPOINT_FILE, ep, 'utf8');
      } catch (e) {
        json(res, { ok: false, msg: '写入 endpoint.txt 失败：' + ((e && e.message) || e) });
        return;
      }
      pushLog('[panel] 接入点已更新' + (ep ? '（' + maskEndpoint(ep) + '）' : '（已清空，仅本地模式）') + '，正在重启音乐服务');
      // 重启主服务让新的接入点生效（不重启动多平台服务）
      if (child) {
        stopService(() => setTimeout(() => {
          const r = startService();
          json(res, r);
        }, 700));
      } else {
        json(res, startService());
      }
    });
    return;
  }
  if (p === '/api/logs/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (p === '/api/logs/clear') {
    logs = [];
    try { fs.writeFileSync(LOG_FILE, ''); } catch (_) {}
    pushLog('[panel] 日志已清空');
    json(res, { ok: true });
    return;
  }
  if (p === '/api/meting/start' && req.method === 'POST') { json(res, startMeting()); return; }
  if (p === '/api/meting/stop' && req.method === 'POST') { stopMeting(() => json(res, { ok: true })); return; }
  if (p === '/api/ai/start' && req.method === 'POST') { json(res, startAi()); return; }
  if (p === '/api/ai/stop' && req.method === 'POST') { stopAi(() => json(res, { ok: true })); return; }
  if (p === '/api/start' && req.method === 'POST') { json(res, startService()); return; }
  if (p === '/api/stop' && req.method === 'POST') {
    stopService(() => stopMeting(() => json(res, { ok: true })));
    return;
  }
  if (p === '/api/restart' && req.method === 'POST') {
    stopService(() => stopMeting(() => setTimeout(() => json(res, startService()), 900)));
    return;
  }
  if (p === '/api/open-folder' && req.method === 'POST') {
    execFile('explorer.exe', [DIR], () => {});
    json(res, { ok: true });
    return;
  }
  if (p === '/api/quit' && req.method === 'POST') {
    json(res, { ok: true });
    setTimeout(() => {
      stopMeting(() => stopAi(() => {
        if (child) {
          const pid = child.pid;
          try { child.kill(); } catch (_) {}
          killTree(pid, () => process.exit(0));
        } else process.exit(0);
      }));
    }, 300);
    return;
  }
  res.writeHead(404); res.end('not found');
});

panel.listen(PANEL_PORT, '127.0.0.1', () => {
  pushLog('[panel] 控制台已启动 → http://127.0.0.1:' + PANEL_PORT);
  // 若已有外部实例占着服务端口，提示一下
  probePort(SERVICE_PORT, (busy) => {
    if (busy) pushLog('[panel] 注意：端口 ' + SERVICE_PORT + ' 已被占用（可能是别处启动的服务），仍可直接停止');
  });
});

process.on('exit', () => {
  if (aiChild) { try { aiChild.kill(); } catch (_) {} }
  if (child) { try { child.kill(); } catch (_) {} }
  if (phpChild) { try { phpChild.kill(); } catch (_) {} }
});

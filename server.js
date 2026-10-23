'use strict';

/*
 * 小智 AI 音乐 MCP 服务
 * ---------------------------------------------------------------
 * 协议：MCP over WebSocket（JSON-RPC 2.0）
 *
 * 暴露的工具：
 *   platforms  列出支持的平台
 *   search     按关键词搜歌，返回 {id, 歌名, 歌手}
 *   url        按歌曲 id 取可直接播放的音频地址
 *   song       按歌曲 id 取详情（含封面）
 *   lyric      按歌曲 id 取歌词
 *
 * 环境变量：
 *   PORT                     监听端口，Render 会自动注入，默认 3000
 *   METING_NETEASE_COOKIE    网易云登录 cookie，填了才能取无损/VIP 曲
 *
 * 接口说明（为什么这么实现）：
 *   1. 搜索走 music.163.com 的 web 搜索接口，不需要登录。
 *   2. 取播放地址优先走外链 /song/media/outer/url（302 到 CDN 真实文件地址，
 *      播放器端可裸连下载）；官方 /url/v1 只作兜底 —— 它给的地址有防盗链，实测直连 403。
 */

const http = require('http');
const https = require('https');
const os = require('os');
const { spawn } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const COOKIE =
  process.env.METING_NETEASE_COOKIE || process.env.NETEASE_COOKIE || '';
// 小智 MCP 接入点（wss://api.xiaozhi.me/mcp/?token=...）
// 也可以用命令行第一个参数传：node server.js "wss://..."
const ENDPOINT = process.env.MCP_ENDPOINT || process.argv[2] || '';
const VERSION = '1.0.0';

// ffmpeg 可执行文件路径（本机静态版），默认从 PATH 找
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
// 设备侧要拿到的服务基地址。默认自动探测本机局域网 IP
const PUBLIC_BASE = process.env.PUBLIC_BASE || '';

// 探测本机局域网 IPv4（优先 192.168 / 10. / 172. 网段，跳过虚拟网卡）
function lanIp() {
  const ifaces = os.networkInterfaces();
  const cands = [];
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      cands.push(a.address);
    }
  }
  const pref = cands.find(
    (ip) =>
      ip.startsWith('192.168.') ||
      ip.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
  return pref || cands[0] || '127.0.0.1';
}

function baseUrl() {
  return PUBLIC_BASE || `http://${lanIp()}:${PORT}`;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ------------------------------------------------------------------ HTTP

// 统一发请求。不自动跟随 302 —— 取播放地址时要读 Location 头。
function request(url, opt = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const headers = {
      'User-Agent': UA,
      Referer: 'https://music.163.com/',
      ...(COOKIE ? { Cookie: COOKIE } : {}),
      ...(opt.headers || {}),
    };
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method: opt.method || 'GET',
        headers,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: data })
        );
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('请求超时')));
    if (opt.body) req.write(opt.body);
    req.end();
  });
}

// ------------------------------------------------------------------ 多平台（本地 Meting 服务）

// 本地 Meting（PHP）地址，支持 netease / tencent / kugou
const METING_API = process.env.METING_API || 'http://127.0.0.1:3300/api.php';

const PLATFORM_NAMES = {
  netease: '网易云音乐',
  tencent: 'QQ音乐',
  kugou: '酷狗音乐',
};

function platformName(p) {
  return PLATFORM_NAMES[p] || p;
}

async function meting(server, type, id, br) {
  const url =
    `${METING_API}?server=${encodeURIComponent(server)}&type=${type}` +
    `&id=${encodeURIComponent(id)}&br=${br || 320}`;
  try {
    const r = await request(url);
    if (r.status !== 200) return { error: 'Meting HTTP ' + r.status };
    return JSON.parse(r.body);
  } catch (e) {
    return {
      error: '多平台服务未启动或不可达（127.0.0.1:3300）：' + String((e && e.message) || e),
    };
  }
}

// 统一取址：netease 走直连（外链优先），其它平台走本地 Meting
async function resolveUrl(platform, id) {
  const p = platform || 'netease';
  if (p === 'netease') {
    const r = await neUrl(id);
    return {
      url: r.url || '',
      br: r.br,
      reason: r.reason || (r.url ? '' : 'not_available'),
      platform: p,
    };
  }
  const j = await meting(p, 'url', id, 320);
  if (j && j.error) return { url: '', reason: 'service_down', detail: j.error, platform: p };
  if (j && j.url) return { url: j.url, br: j.br, platform: p };
  return { url: '', reason: 'vip_or_unavailable', platform: p };
}

// ------------------------------------------------------------------ 网易云

async function neSearch(keyword, limit) {
  const body = `s=${encodeURIComponent(keyword)}&type=1&offset=0&limit=${limit}`;
  const r = await request('https://music.163.com/api/search/get/web', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
    body,
  });
  const j = JSON.parse(r.body);
  const songs = (j.result && j.result.songs) || [];
  return songs.map((s) => ({
    id: String(s.id),
    name: s.name,
    artist: (s.artists || s.ar || []).map((a) => a.name).join('/'),
    album: (s.album && s.album.name) || (s.al && s.al.name) || '',
    duration: Math.round((s.duration || s.dt || 0) / 1000),
  }));
}

// 取播放地址。
//   1) 优先走外链 /song/media/outer/url：302 跳到 CDN 真实文件地址，
//      实测该地址在播放器端可裸连下载（200 / 完整文件）。依赖 COOKIE，未登录会跳 /404。
//   2) 兜底：官方 v1 接口 —— 它给的地址有防盗链，实测直连 403，只能算最后手段。
async function neUrl(id) {
  let reason = 'unknown';
  // 1) 优先走外链：302 跳到 CDN 真实文件地址，实测播放器端可裸连下载（200 / 完整文件）
  try {
    const r = await request(
      `https://music.163.com/song/media/outer/url?id=${id}.mp3`
    );
    const loc = r.headers && r.headers.location;
    console.log(
      `[outer] id=${id} status=${r.status} cookieLen=${
        COOKIE ? COOKIE.length : 0
      } loc=${String(loc).slice(0, 90)}`
    );
    if (loc && !/\/404/.test(loc)) return { url: loc, br: 128000 };
    if (loc && /\/404/.test(loc)) reason = 'not_available';
  } catch (e) {
    reason = 'network';
    console.log(`[outer] id=${id} ERROR: ${(e && e.message) || e}`);
  }

  // 2) 兜底：官方 v1 接口（返回的地址有防盗链，设备端多半 403）
  const tries = COOKIE
    ? [
        { level: 'lossless', enc: 'flac' },
        { level: 'exhigh', enc: 'mp3' },
        { level: 'higher', enc: 'mp3' },
        { level: 'standard', enc: 'mp3' },
      ]
    : [{ level: 'standard', enc: 'mp3' }];

  for (const t of tries) {
    try {
      const r = await request(
        `https://music.163.com/api/song/enhance/player/url/v1` +
          `?ids=%5B${id}%5D&level=${t.level}&encodeType=${t.enc}`
      );
      const j = JSON.parse(r.body);
      const d = j.data && j.data[0];
      if (d && d.url) return { url: d.url, br: d.br || 0 };
    } catch (e) {
      /* 换下一档音质重试 */
    }
  }
  return { url: '', br: 0, reason };
}

async function neDetail(id) {
  const r = await request(`https://music.163.com/api/song/detail?ids=%5B${id}%5D`);
  const j = JSON.parse(r.body);
  const s = j.songs && j.songs[0];
  if (!s) return null;
  return {
    id: String(s.id),
    name: s.name,
    artist: (s.artists || []).map((a) => a.name).join('/'),
    album: (s.album && s.album.name) || '',
    pic: (s.album && s.album.picUrl) || '',
    duration: Math.round((s.duration || 0) / 1000),
  };
}

async function neLyric(id) {
  const r = await request(
    `https://music.163.com/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`
  );
  const j = JSON.parse(r.body);
  return (j.lrc && j.lrc.lyric) || '';
}

// 解析 LRC 文本：提取 [mm:ss.xx] 那句，返回按时间排序的 {t(秒), text}
function parseLrc(lrc) {
  const out = [];
  if (!lrc) return out;
  for (const raw of String(lrc).split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
    if (!tags.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    if (!text) continue;
    // 剔除「作词 : xxx」「和声编写 : xxx」这类制作信息行：
    // 以「短标签 + 冒号」开头的行基本都不是歌词正文
    if (/^[\u4e00-\u9fa5A-Za-z0-9&/'\s]{1,14}\s*[:：]\s*\S/.test(text)) {
      continue;
    }
    for (const m of tags) {
      const min = parseInt(m[1], 10);
      const sec = parseFloat(String(m[2]).replace(':', '.'));
      if (!isFinite(sec)) continue;
      out.push({ t: Math.round((min * 60 + sec) * 100) / 100, text });
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// 当前登录账号 uid（进程内缓存一次）
let _uid = null;
async function myUid() {
  if (_uid) return _uid;
  const r = await request('https://music.163.com/api/nuser/account/get');
  const j = JSON.parse(r.body);
  const p = j && j.profile;
  if (!p || !p.userId) return null;
  _uid = String(p.userId);
  return _uid;
}

// 我的歌单列表：{id,name,count,own}
async function myPlaylists() {
  const uid = await myUid();
  if (!uid) return null;
  const r = await request(
    `https://music.163.com/api/user/playlist?uid=${uid}&limit=100&offset=0`
  );
  const j = JSON.parse(r.body);
  return (j.playlist || []).map((p) => ({
    id: String(p.id),
    name: p.name,
    count: p.trackCount || 0,
    own: !!(p.creator && String(p.creator.userId) === uid),
  }));
}

// 按名字找我的歌单（精确优先，其次包含匹配）
async function findPlaylistByName(name) {
  const list = await myPlaylists();
  if (!list) return null;
  const kw = String(name || '').trim();
  if (!kw) return null;
  return (
    list.find((p) => p.name === kw) ||
    list.find((p) => p.name.indexOf(kw) >= 0) ||
    list.find((p) => kw.indexOf(p.name) >= 0) ||
    null
  );
}

// 歌单详情：取前 limit 首的 {id,title,artist}
async function playlistTracks(id, limit) {
  const r = await request(
    `https://music.163.com/api/v6/playlist/detail?id=${id}&n=1000&s=0`
  );
  const j = JSON.parse(r.body);
  const p = j && j.playlist;
  if (!p) return null;
  const all = p.tracks || [];
  return {
    name: p.name,
    total: all.length,
    tracks: all.slice(0, Math.max(limit, 0)).map((t) => ({
      id: String(t.id),
      title: t.name,
      artist: (t.ar || t.artists || []).map((a) => a.name).join('/'),
    })),
  };
}

// 组装歌单可播放清单：逐首取址（并发），跳过取不到的
async function buildPlaylistJson(id, limit) {
  const info = await playlistTracks(id, limit);
  if (!info) return null;
  const resolved = await Promise.all(
    info.tracks.map(async (t) => {
      let u = '';
      try {
        u = (await resolveUrl('netease', t.id)).url;
      } catch (e) {
        u = '';
      }
      return u
        ? { id: t.id, title: t.title, artist: t.artist, url: `${baseUrl()}/stream/${t.id}.ogg` }
        : null;
    })
  );
  const tracks = resolved.filter(Boolean);
  // 随机播放：把这一轮取到的曲目顺序打乱（每取一次歌单重新随机一轮）
  for (let i = tracks.length - 1; i > 0; --i) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = tracks[i];
    tracks[i] = tracks[j];
    tracks[j] = tmp;
  }
  return {
    name: info.name,
    total: info.total,
    count: tracks.length,
    skipped: info.tracks.length - tracks.length,
    tracks,
  };
}

// ------------------------------------------------------------------ 工具

const TOOLS = [
  {
    name: 'platforms',
    description: '列出当前支持的音乐平台',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'search',
    description:
      '按关键词搜索歌曲，返回歌曲列表（含每首歌的 id）。用户想听歌时先调用这个。' +
      '拿到结果后必须调用设备工具 self.music.show_results 把候选显示到设备屏幕上，' +
      '然后让用户在屏幕上挑一首（说出序号），再用 url 工具取播放地址。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '歌名、歌手或关键词' },
        limit: {
          type: 'integer',
          description: '返回条数，默认 8，最多 20',
        },
        platform: {
          type: 'string',
          description: '平台：netease(网易云，默认) / tencent(QQ音乐) / kugou(酷狗音乐)',
        },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'url',
    description:
      '按歌曲 id 取这首歌的可播放音频地址。返回的地址是设备可播的 Ogg/Opus 流；' +
      '拿到地址后，必须再调用工具 self.music.play_url（参数 url=该地址）让设备真正播放这首歌。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'search 结果里的歌曲 id' },
        platform: {
          type: 'string',
          description: '平台：netease(网易云，默认) / tencent(QQ音乐) / kugou(酷狗音乐)',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'song',
    description: '按歌曲 id 取歌曲详情（歌手、专辑、封面）',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '歌曲 id' },
        platform: {
          type: 'string',
          description: '平台：netease(网易云，默认) / tencent(QQ音乐) / kugou(酷狗音乐)',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'lyric',
    description: '按歌曲 id 取歌词',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '歌曲 id' },
        platform: {
          type: 'string',
          description: '平台：netease(网易云，默认) / tencent(QQ音乐) / kugou(酷狗音乐)',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'my_playlists',
    description:
      '列出当前登录账号（我自己的）网易云歌单，返回每个歌单的 id、名称、歌曲数。' +
      '用户说「播放我的歌单」「放我喜欢的音乐」「放XX歌单」时，先调用本工具找到对应歌单，' +
      '再调用 playlist 工具拿到歌单清单地址。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'playlist',
    description:
      '按歌单名称或 id 取「前 20 首」的可连播清单地址（顺序随机打乱）。拿到地址后必须调用设备工具 ' +
      'self.music.play_playlist（参数 url=该地址）让设备随机连播；' +
      '播放中用户说「下一首/上一首/暂停/停止」时，调用设备工具 self.music.next / ' +
      'self.music.prev / self.music.stop。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '歌单名称，如「我喜欢的音乐」' },
        id: { type: 'string', description: '歌单 id（已知时优先用 id）' },
        limit: {
          type: 'integer',
          description: '取前几首，默认 20，最多 20',
        },
      },
      required: [],
    },
  },
];

function ok(text) {
  return { content: [{ type: 'text', text }] };
}
function fail(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

// 小智可能把 id 传成数字，统一转字符串
function asId(v) {
  return String(v == null ? '' : v).trim();
}

async function callTool(name, args) {
  args = args || {};
  switch (name) {
    case 'platforms':
      return ok(
        '当前支持平台：\n' +
          '- netease —— 网易云音乐（曲库全，免费源多）\n' +
          '- tencent —— QQ音乐（付费/VIP 歌曲取不到播放地址）\n' +
          '- kugou —— 酷狗音乐（付费/VIP 歌曲取不到播放地址）\n' +
          '网易云找不到原版时，可以换 QQ音乐/酷狗再搜一次试试。'
      );

    case 'search': {
      const kw = String(args.keyword || '').trim();
      if (!kw) return fail('缺少 keyword 参数');
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 8, 1), 20);
      const platform = String(args.platform || 'netease').trim() || 'netease';
      let list;
      if (platform === 'netease') {
        list = await neSearch(kw, limit);
      } else {
        const j = await meting(platform, 'search', kw, 0);
        if (j && j.error) {
          return ok(
            `【无法搜索】${platformName(platform)}：${j.error}\n` +
              `请告诉用户这个平台暂时连不上，可以改用网易云搜索。`
          );
        }
        list = (Array.isArray(j) ? j : [])
          .map((s) => ({
            id: asId(s.id || s.url_id),
            name: String(s.name || ''),
            artist: Array.isArray(s.artist)
              ? s.artist.join('/')
              : String(s.artist || ''),
            platform,
          }))
          .filter((s) => s.id && s.name);
      }
      if (!list.length) return ok(`没有搜到「${kw}」（${platformName(platform)}），换个关键词再试。`);
      const lines = list.map(
        (s, i) =>
          `${i + 1}. ${s.name} - ${s.artist} (id=${s.id}` +
          (platform !== 'netease' ? `, platform=${platform}` : '') +
          ')'
      );
      // 给屏幕用的精简列表（最多 5 行，标题+歌手）
      const screen = list
        .slice(0, 5)
        .map((s, i) => `${i + 1} ${s.name} - ${s.artist}`)
        .join('\n');
      const vipHint =
        platform === 'netease'
          ? `核对原唱：结果里有没有用户要的**原唱歌手**？\n` +
            `- 没有（全是翻唱/伴奏）→ 说明网易云很可能没有该曲版权，请如实告诉用户，不要拿翻唱冒充原唱。`
          : `注意：${platformName(platform)} 的付费(VIP)歌曲虽然能搜到，但**取不到播放地址**；` +
            `如果 url 工具回报取不到，就如实告诉用户「${platformName(platform)}这首是付费歌曲」，` +
            `并建议换一首免费的、或改用网易云。`;
      return ok(
        `搜到 ${list.length} 首（${platformName(platform)}）：\n${lines.join('\n')}\n\n` +
          `【下一步必做】调用设备工具 self.music.show_results，参数 list 传入下面这 5 行（原样）：\n` +
          `----\n${screen}\n----\n` +
          `然后对用户说一句「请在屏幕上挑一首，说出序号」，等用户报序号后，` +
          `再用 url 工具传对应 id 取播放地址。\n\n` +
          vipHint
      );
    }

    case 'url': {
      const id = asId(args.id);
      if (!id) return fail('缺少 id 参数');
      const platform = String(args.platform || 'netease').trim() || 'netease';
      const pn = platformName(platform);
      const r = await resolveUrl(platform, id);
      if (!r.url) {
        if (r.reason === 'service_down') {
          return ok(
            `【无法播放】多平台服务未启动：${r.detail}\n` +
              `请告诉用户到「音乐控制台」里启动 Meting 服务后再试。`
          );
        }
        const why =
          r.reason === 'not_available'
            ? `${pn}没有这首歌的版权或已下架`
            : r.reason === 'network'
              ? '网络请求失败（稍后可重试）'
              : r.reason === 'vip_or_unavailable'
                ? `${pn}的这首是付费(VIP)歌曲或已下架，未登录会员取不到播放地址`
                : '取不到播放地址';
        return ok(
          `【无法播放】id=${id}（${pn}）：${why}。\n` +
            `请原样告诉用户，并建议换一首免费的、或换平台搜索。`
        );
      }
      // 不直接把源站 mp3 原链给设备（设备只认 Ogg/Opus），
      // 改给本服务的转码流地址
      const ogg =
        platform === 'netease'
          ? `${baseUrl()}/stream/${id}.ogg`
          : `${baseUrl()}/stream/${platform}/${id}.ogg`;
      console.log(`[url] platform=${platform} id=${id} src=${r.url.slice(0, 60)} -> ${ogg}`);
      return ok(`播放地址：${ogg}`);
    }

    case 'song': {
      const id = asId(args.id);
      if (!id) return fail('缺少 id 参数');
      const platform = String(args.platform || 'netease').trim() || 'netease';
      if (platform !== 'netease') {
        const j = await meting(platform, 'song', id, 0);
        const s = Array.isArray(j) ? j[0] : j;
        if (!s || s.error || !s.name) return ok(`找不到 id=${id} 的歌曲（${platformName(platform)}）。`);
        return ok(
          `${s.name} - ${Array.isArray(s.artist) ? s.artist.join('/') : s.artist || ''}\n` +
            `专辑：${s.album || '-'}\n封面：${s.pic || '-'}`
        );
      }
      const s = await neDetail(id);
      if (!s) return ok(`找不到 id=${id} 的歌曲。`);
      return ok(
        `${s.name} - ${s.artist}\n专辑：${s.album}\n时长：${s.duration}s\n封面：${s.pic}`
      );
    }

    case 'lyric': {
      const id = asId(args.id);
      if (!id) return fail('缺少 id 参数');
      const platform = String(args.platform || 'netease').trim() || 'netease';
      if (platform !== 'netease') {
        const r = await request(
          `${METING_API}?server=${encodeURIComponent(platform)}&type=lyric&id=${encodeURIComponent(id)}`
        );
        const t = r.body || '';
        return ok(t.trim() ? t.slice(0, 1500) : `id=${id} 没有歌词。`);
      }
      const t = await neLyric(id);
      return ok(t ? t.slice(0, 1500) : `id=${id} 没有歌词。`);
    }

    case 'my_playlists': {
      let list;
      try {
        list = await myPlaylists();
      } catch (e) {
        return ok(`【无法获取歌单】请求失败：${String((e && e.message) || e)}`);
      }
      if (!list) {
        return ok(
          '【无法获取歌单】未登录或 cookie 失效，请在「音乐控制台」里重新填入网易云 cookie。'
        );
      }
      if (!list.length) return ok('你的账号下没有歌单。');
      const lines = list.map(
        (p) => `- ${p.name}（id=${p.id}，${p.count} 首${p.own ? '，我创建的' : ''}）`
      );
      return ok(
        `我的歌单（${list.length} 个）：\n${lines.join('\n')}\n\n` +
          `【下一步】用户要放哪个歌单，就调用 playlist 工具（传 name 或 id）拿到连播清单地址。`
      );
    }

    case 'playlist': {
      let id = asId(args.id);
      let name = String(args.name || '').trim();
      if (!id) {
        if (!name) return fail('请提供歌单 name 或 id');
        let found;
        try {
          found = await findPlaylistByName(name);
        } catch (e) {
          return ok(`【无法获取歌单】请求失败：${String((e && e.message) || e)}`);
        }
        if (!found) {
          return ok(
            `【找不到歌单】我的歌单里没有叫「${name}」的。请先调用 my_playlists 看看有哪些。`
          );
        }
        id = found.id;
        name = found.name;
      }
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 20);
      const addr = `${baseUrl()}/playlist/${id}.json?limit=${limit}`;
      // 顺带探一次，把歌单名/可播数量告诉 AI（也验证端点可用）
      let info = null;
      try {
        info = await playlistTracks(id, 0);
      } catch (e) {
        /* 忽略，仅用于回话 */
      }
      const title = (info && info.name) || name || ('id=' + id);
      const total = info ? info.total : '?';
      return ok(
        `歌单「${title}」（共 ${total} 首，本次取前 ${limit} 首并随机打乱顺序）的连播清单地址：\n${addr}\n\n` +
          `【下一步必做】调用设备工具 self.music.play_playlist，参数 url 传入上面这个地址，` +
          `设备会按随机顺序连播这 ${limit} 首。\n` +
          `播放中用户说「下一首/上一首/暂停/停一下/别放了」时，分别调用设备工具 ` +
          `self.music.next / self.music.prev / self.music.stop。`
      );
    }

    default:
      return fail(`未知工具：${name}`);
  }
}

// ------------------------------------------------------------------ MCP

async function handle(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'xiaozhi-music-mcp', version: '1.0.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const n = params && params.name;
      const a = params && params.arguments;
      return await callTool(n, a);
    }
    default:
      throw new Error(`未知方法：${method}`);
  }
}

// ------------------------------------------------------------------ 服务

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');

  // 诊断：把转码结果整体跑一遍，报告字节数和 Ogg/OpusHead 头部信息，方便本地验证
  if (u.pathname === '/oggtest') {
    const id = u.searchParams.get('id') || '186016';
    let src = null;
    try { src = await neUrl(id); } catch (e) {}
    if (!src || !src.url) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('no source for id=' + id);
      return;
    }
    const args = [
      '-hide_banner', '-loglevel', 'error', '-i', src.url,
      '-vn', '-ac', '1', '-ar', '24000',
      '-c:a', 'libopus', '-b:a', '96k', '-f', 'ogg', 'pipe:1',
    ];
    const ff = spawn(FFMPEG, args);
    const chunks = [];
    let err = '';
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (c) => (err += c.toString()));
    ff.on('error', (e) => { err += ' spawn:' + ((e && e.message) || e); });
    ff.on('close', (code) => {
      const buf = Buffer.concat(chunks);
      const head = buf.slice(0, 4).toString('latin1');
      const oh = buf.indexOf(Buffer.from('OpusHead'));
      let chan = null, rate = null;
      if (oh >= 0) { chan = buf[oh + 9]; rate = buf.readUInt32LE(oh + 12); }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id, ffmpegExit: code, bytes: buf.length, first4: head,
        opusHeadAt: oh, channels: chan, opusHeadSampleRate: rate,
        ffmpegMsg: err.trim() ? err.trim().slice(0, 300) : 'ok',
      }, null, 2));
    });
    return;
  }

  // 诊断用：/probe?id=186016[&platform=tencent] —— 直接看这首歌能不能取到地址、什么码率
  if (u.pathname === '/probe') {
    const id = u.searchParams.get('id') || '186016';
    const platform = u.searchParams.get('platform') || 'netease';
    try {
      const r = await resolveUrl(platform, id);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify(
          {
            id,
            platform,
            cookie: COOKIE ? 'yes' : 'no',
            ok: !!r.url,
            reason: r.reason,
            br: r.br,
            url: r.url || null,
          },
          null,
          2
        )
      );
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('probe failed: ' + String((e && e.message) || e));
    }
    return;
  }

  // 诊断用：/metingtest?platform=tencent&kw=晴天 —— 看多平台搜索是否通
  if (u.pathname === '/metingtest') {
    const platform = u.searchParams.get('platform') || 'tencent';
    const kw = u.searchParams.get('kw') || '晴天';
    const j = await meting(platform, 'search', kw, 0);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify(
        {
          platform,
          kw,
          error: (j && j.error) || null,
          count: Array.isArray(j) ? j.length : 0,
          first: Array.isArray(j) ? j.slice(0, 3) : j,
        },
        null,
        2
      )
    );
    return;
  }

  // 设备屏幕歌词用：GET /lyric/<歌id>.json 或 /lyric/<平台>/<歌id>.json
  //   返回 {id, platform, count, lines:[{t(秒), text}]}，供设备按播放进度同步滚动
  const lym = u.pathname.match(/^\/lyric\/(?:(netease|tencent|kugou)\/)?([A-Za-z0-9_-]+)\.json$/);
  if (lym) {
    const platform = lym[1] || 'netease';
    const id = lym[2];
    try {
      let raw = '';
      if (platform === 'netease') {
        try {
          raw = await neLyric(id);
        } catch (e) {
          raw = '';
        }
      } else {
        const r = await request(
          `${METING_API}?server=${encodeURIComponent(platform)}&type=lyric&id=${encodeURIComponent(id)}`
        );
        raw = r.body || '';
        try {
          const j = JSON.parse(raw);
          raw = (j && (j.lyric || j.lrc)) || raw;
        } catch (_) {
          /* 直接就是 LRC 文本 */
        }
      }
      const lines = parseLrc(raw);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ id, platform, count: lines.length, lines }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String((e && e.message) || e) }));
    }
    return;
  }

  // 设备整张连播用：GET /playlist/<歌单id>.json[?limit=N]
  //   返回 {name,total,count,skipped,tracks:[{id,title,artist,url}]}
  //   url 已是设备可播的 Ogg/Opus 流地址；取不到地址的曲目自动跳过。
  const pm = u.pathname.match(/^\/playlist\/([A-Za-z0-9_-]+)\.json$/);
  if (pm) {
    const id = pm[1];
    const limit = Math.min(
      Math.max(parseInt(u.searchParams.get('limit'), 10) || 20, 1),
      20
    );
    try {
      const data = await buildPlaylistJson(id, limit);
      if (!data) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'playlist not found: ' + id }));
        return;
      }
      console.log(
        `[playlist] id=${id} name=${data.name} total=${data.total} -> ` +
          `count=${data.count} skipped=${data.skipped}`
      );
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String((e && e.message) || e) }));
    }
    return;
  }

  // 设备播放用：把源站 mp3 实时转成设备能放的 Ogg/Opus（单声道 24kHz）
  //   网易云：http://<本机IP>:3000/stream/<歌id>.ogg
  //   其它平台：http://<本机IP>:3000/stream/<平台>/<歌id>.ogg
  const sm = u.pathname.match(
    /^\/stream\/(?:(netease|tencent|kugou)\/)?([A-Za-z0-9_-]+)\.ogg$/
  );
  if (sm) {
    const platform = sm[1] || 'netease';
    const id = sm[2];
    let src;
    try {
      src = await resolveUrl(platform, id);
    } catch (e) {
      src = null;
    }
    if (!src || !src.url) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('no playable source for ' + platform + ' id=' + id +
        (src && src.reason ? ' (' + src.reason + ')' : ''));
      return;
    }
    // 设备只认：单声道 Opus + Ogg 封装 + OpusHead 采样率 24000
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', src.url,
      '-vn', '-ac', '1', '-ar', '24000',
      '-c:a', 'libopus', '-b:a', '96k',
      '-f', 'ogg', 'pipe:1',
    ];
    console.log(`[stream] platform=${platform} id=${id} -> ffmpeg`);
    res.writeHead(200, {
      'Content-Type': 'audio/ogg',
      'Cache-Control': 'no-store',
    });
    const ff = spawn(FFMPEG, args);
    ff.stdout.pipe(res);
    ff.stderr.on('data', (d) =>
      console.log('[ffmpeg]', d.toString().trim().slice(0, 200))
    );
    ff.on('error', (e) => {
      console.log('[ffmpeg] spawn error:', (e && e.message) || e);
      try { res.end(); } catch (_) {}
    });
    req.on('close', () => { try { ff.kill(); } catch (_) {} });
    return;
  }

  // 给 Render 的健康检查 + 保活探针用
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('xiaozhi music mcp is running');
});

const wss = new WebSocketServer({ server });

// 把工具参数压成一行人话，便于看日志
function summarizeArgs(a) {
  if (!a || typeof a !== 'object') return '';
  const parts = [];
  for (const k of ['keyword', 'id', 'platform', 'limit']) {
    if (a[k] === undefined || a[k] === null || a[k] === '') continue;
    parts.push(k + '=' + String(a[k]).slice(0, 40));
  }
  if (a.list !== undefined) {
    const first = String(a.list).split('\n')[0].slice(0, 30);
    parts.push('list=' + first + '…');
  }
  return parts.length ? parts.join(' ') : JSON.stringify(a).slice(0, 80);
}

// 把工具返回值压成一行结论
function summarizeResult(result) {
  try {
    const texts = (result && result.content) || [];
    const t = texts
      .map((x) => x.text || '')
      .join(' ')
      .replace(/\s+/g, ' ');
    if (!t) return result && result.isError ? '出错' : 'ok';
    const head = t.split('\n')[0].slice(0, 90);
    if (/无法播放|无法搜索|取不到|没有这首歌的版权|付费\(VIP\)|是付费/.test(t)) {
      return '❌ ' + head;
    }
    const m1 = t.match(/播放地址：(\S+)/);
    if (m1) return '✅ 播放地址 ' + m1[1];
    const m2 = t.match(/搜到\s*(\d+)\s*首（?([^）\n ]*)/);
    if (m2) return `🔍 搜到 ${m2[1]} 首（${m2[2] || ''}）`;
    if (/没有搜到/.test(t)) return '🔍 ' + head;
    return (result && result.isError ? '❌ ' : '') + head;
  } catch (e) {
    return 'ok';
  }
}

// 一条 WebSocket 连接上的 JSON-RPC 处理（本地服务模式 / 连小智接入点，共用同一套）
function attach(ws, tag) {
  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return; // 非 JSON，忽略
    }
    const id = msg.id;
    const isNotify = id === undefined || id === null;
    const toolName =
      msg.params && typeof msg.params.name === 'string' ? msg.params.name : '';
    const toolArgs = (msg.params && msg.params.arguments) || {};

    if (msg.method === 'tools/call') {
      console.log(`[${tag}] 调用 ${toolName || '?'}  ${summarizeArgs(toolArgs)}`);
    } else {
      // 协议类消息折叠打印，避免刷屏
      const extra = toolName ? ' ' + toolName : '';
      console.log(`[${tag}] ${msg.method || '?'}${extra}${isNotify ? ' (notify)' : ''}`);
    }
    // 没有 id 的是通知（notifications/initialized 等），按协议不回包
    if (isNotify) return;

    try {
      const result = await handle(msg.method, msg.params);
      if (msg.method === 'tools/call') {
        console.log(`[${tag}] 返回 ${toolName || '?'}  ${summarizeResult(result)}`);
      }
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
    } catch (e) {
      console.log(`[${tag}] 出错 ${toolName || '?'}  ${String((e && e.message) || e)}`);
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: String((e && e.message) || e) },
        })
      );
    }
  });

  ws.on('error', (e) =>
    console.error(`[${tag}] ws error:`, (e && e.message) || e)
  );
  ws.on('close', () => console.log(`[${tag}] disconnected`));
}

wss.on('connection', (ws) => attach(ws, 'local'));

// 主动连小智接入点，断线后自动重连
function connectEndpoint(url) {
  console.log(`[xiaozhi] connecting ...`);
  const c = new WebSocket(url, {
    headers: { 'User-Agent': `xiaozhi-music-mcp/${VERSION}` },
  });
  attach(c, 'xiaozhi');
  c.on('open', () => console.log('[xiaozhi] connected — tools registered'));
  c.on('close', () => {
    console.log('[xiaozhi] closed, retry in 5s');
    setTimeout(() => connectEndpoint(url), 5000);
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[music-mcp] listening on :${PORT}, cookie=${COOKIE ? 'yes' : 'no'}`);
  if (ENDPOINT) {
    connectEndpoint(ENDPOINT);
  } else {
    console.log('[music-mcp] MCP_ENDPOINT 未设置 — 仅作本地服务运行');
  }
});

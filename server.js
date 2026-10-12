'use strict';
/**
 * Mood Capsule 后端（Node.js，单用户，零第三方依赖）
 * 本地：node server.js（或双击 start_server.bat）；浏览器打开 http://127.0.0.1:8000
 * 云端：Render 等平台会自动注入 PORT，此时监听 0.0.0.0 并进入「云平台模式」（详见 DEPLOY.md）
 * 1) 静态文件服务  2) 数据存 SQLite（mood.db，内置 node:sqlite）
 * 3) AI 代理（API key 只从环境变量 / .env 读取，源码内不保存任何密钥，前端也不持有）：
 *    POST /api/dify/chat-messages -> Dify 流式对话（SSE 透传）
 *    GET  /api/dify/parameters    -> Dify 开场白
 *    GET  /api/dify/conversations/:id/variables -> Dify 会话变量
 *    POST /api/deepseek/chat/completions -> DeepSeek 胶囊设计
 *    GET  /healthz                    -> 健康检查（别名 /health、/api/health；托管平台探活 / 自建服务器自测用）
 * 配置：复制 .env.example 为 .env 并填入 DIFY_API_KEY / DEEPSEEK_API_KEY（.env 已被 .gitignore 忽略）
 * 可选：PORT / HOST / DATA_DIR / CORS_ORIGIN（分开部署时用 CORS_ORIGIN 收紧跨域白名单，见 DEPLOY.md）
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
// node:sqlite 能否加载，只取决于「实际运行本文件的那个 node」，与 shell 里 `node -v` 看到什么无关：
//   < 22.5      ：完全没有该内置模块 → ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite
//   22.5–22.12  ：需要显式 --experimental-sqlite
//   ≥ 22.13 / ≥ 23.4：默认可用（可用 --no-experimental-sqlite 关掉）
// 高频踩坑：shell 里是 nvm 的 22.x，但 PM2 fork 应用时按 PATH 找 node，可能命中 apt 安装的旧 node（如
// /usr/bin/node 18.x），于是「明明装了新 node 却报模块不存在」，且 PM2 里进程反复重启、端口毫无监听。
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  if (e && (e.code === 'ERR_UNKNOWN_BUILTIN_MODULE' || e.code === 'MODULE_NOT_FOUND')) {
    console.error('[启动失败] 当前 Node.js（%s）无法加载内置模块 node:sqlite：%s', process.version, e.message);
    console.error('  node:sqlite 需要 Node >= 22.5（22.5–22.12 还要加 --experimental-sqlite；>= 22.13 / 24.x 默认可用）。');
    console.error('  最常见原因：PM2 用的不是你以为的那个 node —— 按 PATH 命中了系统旧版（如 /usr/bin/node 18.x）。');
    console.error('  先确认在用的是哪个 node（关键排查）：');
    console.error('    pm2 describe mood-capsule-api | grep -Ei "interpreter|node.js version|script path"');
    console.error('    ls -l /proc/$(pgrep -f ProcessContainerFork | head -1)/exe');
    console.error('  修法（任选其一）：');
    console.error('    1) 用仓库配置启动：会把 PM2 使用的 node 锁为解释器，并按版本自动补参数');
    console.error('       cd /root/mood-capsule && nvm use 22 && pm2 delete mood-capsule-api && pm2 start ecosystem.config.js && pm2 save');
    console.error('    2) 显式指定解释器：pm2 delete mood-capsule-api && pm2 start server.js --name mood-capsule-api --interpreter "$(nvm which 22)"');
    console.error('    3) 连 PM2 守护进程一起换 node：nvm alias default 22 && pm2 kill && pm2 start ecosystem.config.js');
    console.error('    4) 或把系统 node 升到 22.13+（NodeSource 源），两种启动方式都能跑');
    console.error('  注意：把 NODE_OPTIONS 写进 .env 无效 —— Node 在加载本文件之前就已读取 NODE_OPTIONS。');
    process.exit(1);
  }
  throw e;
}

const BASE_DIR = __dirname;
const ENV_PATH = path.join(BASE_DIR, '.env');

// ---- 加载 .env（零第三方依赖：Node >= 20.12 自带 process.loadEnvFile） ----
// 优先级：已存在的系统环境变量 > .env 文件（loadEnvFile 不会覆盖已有变量）。
// 反过来说：若 shell / PM2 / systemd 里残留了 PORT、HOST 等变量，.env 会被「静默忽略」，
// 所以这里先快照一份启动前的系统环境变量，启动日志会标出每一项配置的真实来源（排错用）。
const SYS_ENV = Object.assign({}, process.env);
let ENV_FILE_USED = ''; // 实际加载到的 .env 绝对路径；空串表示没有加载到任何 .env
(function loadDotEnv() {
  if (typeof process.loadEnvFile !== 'function') {
    console.warn('[提示] 当前 Node.js（%s）不支持 process.loadEnvFile()，已跳过 .env 加载；'
      + '请改用系统环境变量，或升级到 Node >= 20.12。', process.version);
    return;
  }
  // 依次尝试 server.js 所在目录、当前工作目录（PM2 / systemd 的启动目录不一定等于脚本目录）
  const candidates = [ENV_PATH];
  const cwdEnv = path.join(process.cwd(), '.env');
  if (cwdEnv !== ENV_PATH) candidates.push(cwdEnv);
  const found = candidates.filter((p) => fs.existsSync(p));
  if (found.length === 0) {
    console.warn('[提示] 未找到 .env 文件（已尝试：%s），将只读取系统环境变量。', candidates.join(' / '));
    return;
  }
  try {
    process.loadEnvFile(found[0]);
    ENV_FILE_USED = found[0];
    // 顺带拦住一个高频踩坑：NODE_OPTIONS 写在 .env 里永远不会生效
    // （Node 在启动进程时就读取了 NODE_OPTIONS，而 .env 是启动之后才由本文件加载的）。
    try {
      if (/^[ \t]*NODE_OPTIONS[ \t]*=/m.test(fs.readFileSync(found[0], 'utf8'))) {
        console.warn('[提示] %s 里的 NODE_OPTIONS 不会生效：Node 在加载本文件之前就已读取 NODE_OPTIONS。', found[0]);
        console.warn('       需要给 node 传参数（如 Node 22.x 的 --experimental-sqlite）请用 PM2 的 node_args / 命令行参数，见 DEPLOY.md §12.2。');
      }
    } catch (err) { /* 读不到 .env 内容不影响启动，忽略 */ }
  } catch (e) {
    console.warn('[提示] .env 解析失败（%s）：%s', found[0], e && e.message ? e.message : e);
  }
})();

// 某个配置项的值来自哪里：系统环境变量 / .env 文件 / 代码默认值（启动日志与排错用）
function envSource(name) {
  if (SYS_ENV[name] !== undefined && SYS_ENV[name] !== '') return '系统环境变量，覆盖 .env';
  if (process.env[name] !== undefined && process.env[name] !== '') return '.env 文件';
  return '默认值';
}

// ---- 运行时配置：本地开箱即用，云端 / 自建服务器由环境变量或 .env 覆盖 ----
const IS_CLOUD = !!process.env.PORT;  // 托管平台（Render / Railway 等）会自动注入 PORT；自建服务器在 .env 里写 PORT 同样走这条
const HOST = (process.env.HOST || '').trim() || (IS_CLOUD ? '0.0.0.0' : '127.0.0.1'); // 本地默认只绑回环，不对外网暴露
const RAW_PORT = (process.env.PORT || '').trim();
const PORT = Number(RAW_PORT) || 8000;
// 是否对外网可访问：HOST 不是回环地址即为「对外监听」（决定要不要打印安全 / 数据提示）
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];
const IS_PUBLIC = LOOPBACK_HOSTS.indexOf(HOST) === -1;
// 托管平台探测：平台会注入自己的标识变量（Render / Railway / Heroku / Fly.io）。
// 注意 IS_CLOUD 只代表「有 PORT」，自建服务器在 .env 里写 PORT 同样为 true，
// 因此「磁盘临时、数据会丢」的口径必须按 IS_MANAGED 判断，否则会在自建服务器上误报。
const PLATFORM = process.env.RENDER ? 'Render'
  : (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID ? 'Railway'
    : (process.env.DYNO ? 'Heroku' : (process.env.FLY_APP_NAME ? 'Fly.io' : '')));
const IS_MANAGED = !!PLATFORM;
// 数据目录：默认与 server.js 同级；挂载了持久化磁盘时指向挂载点（如 DATA_DIR=/var/data）
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : BASE_DIR;
const DB_PATH = path.join(DATA_DIR, 'mood.db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- CORS ----
// 本机开发默认放开（*）；前后端分开部署（Netlify + Render）时用 CORS_ORIGIN 收紧为前端域名白名单，
// 例如 CORS_ORIGIN=https://mood-capsule.netlify.app,https://your-domain.com（逗号分隔，可多个）
const RAW_CORS_ORIGIN = (process.env.CORS_ORIGIN || '*').trim();
const ALLOWED_ORIGINS = RAW_CORS_ORIGIN === '*'
  ? null
  : RAW_CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);

// 每个请求按 Origin 计算一次，供统一注入（见文件末尾的 res.writeHead 包装）
// 值为 null 表示「删除该响应头」——Origin 不在白名单时用它阻止浏览器读取响应
function corsHeadersFor(req) {
  if (!ALLOWED_ORIGINS) return { 'Access-Control-Allow-Origin': '*' };
  const origin = (req.headers && req.headers.origin) || '';
  if (origin && ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    return { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' };
  }
  return { 'Access-Control-Allow-Origin': null, 'Vary': 'Origin' }; // 不在白名单：不下发 CORS 头
}

// ---- AI 配置：全部来自环境变量，源码内**不保存任何密钥** ----
const DIFY_API_KEY = process.env.DIFY_API_KEY || '';
const DIFY_BASE_URL = process.env.DIFY_BASE_URL || 'https://api.dify.ai/v1';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

// 缺少密钥时不阻止启动（静态页面与本地历史/胶囊仍可用），只在启动日志与接口层给出明确提示
function missingApiKeys() {
  const missing = [];
  if (!DIFY_API_KEY) missing.push('DIFY_API_KEY');
  if (!DEEPSEEK_API_KEY) missing.push('DEEPSEEK_API_KEY');
  return missing;
}

const MISSING_KEYS = missingApiKeys();
// 提示语随运行模式切换：本地指向 .env，对外部署指向环境变量 / 托管平台面板
const KEY_HINT = IS_PUBLIC
  ? '请在运行环境的环境变量里补齐（自建服务器写 .env，或 PM2 / systemd 的 env；托管平台在 Environment 面板配置）后重启服务'
  : '请在项目根目录新建 .env（可复制 .env.example）并填入对应变量值后重启服务';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
};

// ---- 数据库初始化 ----
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    title TEXT,
    messages TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS capsules (
    id TEXT PRIMARY KEY,
    emotion_type TEXT,
    raw_intensity TEXT,
    intensity INTEGER,
    level TEXT,
    level_text TEXT,
    color TEXT,
    svg TEXT,
    farewell TEXT,
    created_at INTEGER
  );
`);

// ---- 工具函数 ----
function sendJson(res, status, obj) {
  const data = Buffer.from(JSON.stringify(obj), 'utf-8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function rowToSession(r) {
  let messages = [];
  try { messages = JSON.parse(r.messages || '[]'); } catch (e) { messages = []; }
  return {
    id: r.id,
    conversationId: r.conversation_id,
    title: r.title,
    messages,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToCapsule(r) {
  return {
    id: r.id,
    emotionType: r.emotion_type,
    rawIntensity: r.raw_intensity,
    intensity: r.intensity,
    level: r.level,
    levelText: r.level_text,
    color: r.color,
    svg: r.svg,
    farewell: r.farewell,
    createdAt: r.created_at,
  };
}

// ---- 数据接口 ----
function listSessions(res) {
  const rows = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all();
  sendJson(res, 200, rows.map(rowToSession));
}

function replaceSessions(body, res) {
  if (!Array.isArray(body)) return sendJson(res, 400, { error: '请求体应为会话数组' });
  const stmt = db.prepare(
    'INSERT INTO sessions (id, conversation_id, title, messages, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM sessions');
    for (const s of body) {
      if (!s || typeof s !== 'object') continue;
      stmt.run(s.id, s.conversationId, s.title,
        JSON.stringify(Array.isArray(s.messages) ? s.messages : []),
        s.createdAt, s.updatedAt);
    }
    db.exec('COMMIT');
    sendJson(res, 200, { ok: true });
  } catch (e) {
    db.exec('ROLLBACK');
    sendJson(res, 500, { error: String(e.message || e) });
  }
}

function listCapsules(res) {
  const rows = db.prepare('SELECT * FROM capsules ORDER BY created_at DESC').all();
  sendJson(res, 200, rows.map(rowToCapsule));
}

function replaceCapsules(body, res) {
  if (!Array.isArray(body)) return sendJson(res, 400, { error: '请求体应为胶囊数组' });
  const stmt = db.prepare(
    'INSERT INTO capsules (id, emotion_type, raw_intensity, intensity, level, level_text, color, svg, farewell, created_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM capsules');
    for (const c of body) {
      if (!c || typeof c !== 'object') continue;
      stmt.run(c.id, c.emotionType, c.rawIntensity, c.intensity, c.level, c.levelText,
        c.color, c.svg, c.farewell, c.createdAt);
    }
    db.exec('COMMIT');
    sendJson(res, 200, { ok: true });
  } catch (e) {
    db.exec('ROLLBACK');
    sendJson(res, 500, { error: String(e.message || e) });
  }
}

// ---- AI 代理 ----
function proxyDifyChat(req, res) {
  return readBody(req).then((body) => new Promise((resolve) => {
    const upstream = https.request(DIFY_BASE_URL + '/chat-messages', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + DIFY_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'Content-Length': body.length,
      },
    }, (upRes) => {
      res.writeHead(upRes.statusCode || 200, {
        'Content-Type': upRes.headers['content-type'] || 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      upRes.pipe(res);
      upRes.on('end', resolve);
    });
    upstream.on('error', (err) => {
      if (!res.headersSent) sendJson(res, 502, { error: 'Dify 请求失败：' + err.message });
      else res.end();
      resolve();
    });
    upstream.end(body);
  }));
}

function proxyDifyGet(res, upstreamPath) {
  https.get(DIFY_BASE_URL + upstreamPath, {
    headers: { Authorization: 'Bearer ' + DIFY_API_KEY },
  }, (upRes) => {
    const chunks = [];
    upRes.on('data', (c) => chunks.push(c));
    upRes.on('end', () => {
      const data = Buffer.concat(chunks);
      res.writeHead(upRes.statusCode || 200, {
        'Content-Type': upRes.headers['content-type'] || 'application/json',
      });
      res.end(data);
    });
  }).on('error', (err) => sendJson(res, 502, { error: 'Dify 请求失败：' + err.message }));
}

function proxyDeepSeek(req, res) {
  return readBody(req).then((raw) => {
    let payload;
    try { payload = JSON.parse(raw.toString('utf-8')); }
    catch (e) { return sendJson(res, 400, { error: '请求体不是合法 JSON' }); }
    payload.model = DEEPSEEK_MODEL;
    const body = Buffer.from(JSON.stringify(payload), 'utf-8');
    return new Promise((resolve) => {
      const upstream = https.request(DEEPSEEK_BASE_URL + '/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + DEEPSEEK_API_KEY,
          'Content-Type': 'application/json',
          'Content-Length': body.length,
        },
      }, (upRes) => {
        const chunks = [];
        upRes.on('data', (c) => chunks.push(c));
        upRes.on('end', () => {
          const data = Buffer.concat(chunks);
          res.writeHead(upRes.statusCode || 200, {
            'Content-Type': upRes.headers['content-type'] || 'application/json',
          });
          res.end(data);
          resolve();
        });
      });
      upstream.on('error', (err) => {
        if (!res.headersSent) sendJson(res, 502, { error: 'DeepSeek 请求失败：' + err.message });
        else res.end();
        resolve();
      });
      upstream.end(body);
    });
  });
}

// ---- 静态文件 ----
function serveStatic(pathname, res) {
  let rel = pathname;
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(BASE_DIR, rel.replace(/^\//, '')));
  if (!filePath.startsWith(BASE_DIR + path.sep)) {
    return sendJson(res, 403, { error: '禁止访问' });
  }
  // 敏感文件（.env 里的密钥、mood.db 里的全部对话）不通过 HTTP 暴露；
  // 云端部署时数据库默认就在本目录，必须挡住。
  const baseName = path.basename(filePath).toLowerCase();
  if (baseName.startsWith('.') || baseName.startsWith('mood.db')) {
    return sendJson(res, 403, { error: '禁止访问' });
  }
  fs.readFile(filePath, (err, data) => {
    if (err) return sendJson(res, 404, { error: '文件不存在' });
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---- 路由 ----
function handleRequest(req, res) {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = u.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Length': '0',
    });
    return res.end();
  }

  if (pathname === '/api/sessions') {
    if (req.method === 'GET') return listSessions(res);
    if (req.method === 'PUT') {
      return readBody(req).then((b) => {
        let body;
        try { body = JSON.parse(b.toString('utf-8')); }
        catch (e) { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
        return replaceSessions(body, res);
      });
    }
  }
  if (pathname === '/api/capsules') {
    if (req.method === 'GET') return listCapsules(res);
    if (req.method === 'PUT') {
      return readBody(req).then((b) => {
        let body;
        try { body = JSON.parse(b.toString('utf-8')); }
        catch (e) { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
        return replaceCapsules(body, res);
      });
    }
  }

  // AI 代理（缺少 Key 时直接给出 503 与可操作提示，而不是向上游发一次必然失败的请求）
  if (pathname.startsWith('/api/dify/') && !DIFY_API_KEY) {
    return sendJson(res, 503, { error: '未配置 DIFY_API_KEY。' + KEY_HINT });
  }
  if (pathname === '/api/deepseek/chat/completions' && !DEEPSEEK_API_KEY) {
    return sendJson(res, 503, { error: '未配置 DEEPSEEK_API_KEY。' + KEY_HINT });
  }

  if (req.method === 'POST' && pathname === '/api/dify/chat-messages') return proxyDifyChat(req, res);
  if (req.method === 'GET' && pathname === '/api/dify/parameters') return proxyDifyGet(res, '/parameters' + u.search);
  if (req.method === 'GET' && pathname.startsWith('/api/dify/conversations/')) {
    return proxyDifyGet(res, pathname.replace('/api/dify', '') + u.search);
  }
  if (req.method === 'POST' && pathname === '/api/deepseek/chat/completions') return proxyDeepSeek(req, res);

  // 健康检查（托管平台 health check / 部署后就地自测用；/health 是等价别名，方便 curl）
  if (req.method === 'GET'
    && (pathname === '/healthz' || pathname === '/health' || pathname === '/api/health')) {
    return sendJson(res, 200, {
      ok: true,
      service: 'mood-capsule',
      database: { path: DB_PATH, ready: fs.existsSync(DB_PATH) },
      aiKeys: { dify: !!DIFY_API_KEY, deepseek: !!DEEPSEEK_API_KEY },
      corsOrigin: RAW_CORS_ORIGIN,
      listen: { host: HOST, port: PORT, public: IS_PUBLIC },
      envFile: ENV_FILE_USED || null,
      uptime: Math.round(process.uptime()),
      node: process.version,
      time: new Date().toISOString(),
    });
  }

  // 静态文件
  if (req.method === 'GET') return serveStatic(pathname, res);

  sendJson(res, 404, { error: 'Not Found' });
}

const server = http.createServer((req, res) => {
  // CORS 统一注入：按请求 Origin 算一次，再覆盖 / 移除各处 writeHead 里的 CORS 头，
  // 使 JSON 接口、SSE 透传、OPTIONS 预检全部遵循同一份 CORS_ORIGIN 白名单（唯一数据源）。
  const cors = corsHeadersFor(req);
  const rawWriteHead = res.writeHead.bind(res);
  res.writeHead = function (status, a, b) {
    const hasMessage = (typeof a === 'string');
    const merged = Object.assign({}, hasMessage ? b : a);
    Object.keys(cors).forEach((k) => {
      if (cors[k] === null || cors[k] === undefined) delete merged[k];
      else merged[k] = cors[k];
    });
    return hasMessage ? rawWriteHead(status, a, merged) : rawWriteHead(status, merged);
  };

  Promise.resolve(handleRequest(req, res)).catch((err) => {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: String(err.message || err) });
  });
});

// 监听失败时给出人话原因（否则 PM2 只会看到一串堆栈，甚至表现为「online 但连不上」）
server.on('error', (err) => {
  const code = (err && err.code) || '';
  console.error('  [启动失败] 无法监听 %s:%d —— %s', HOST, PORT, (err && err.message) || err);
  if (code === 'EADDRINUSE') {
    console.error('  [原因] 端口 %d 已被占用：多为上一个进程没退出，或 PM2 用 cluster 模式（-i max）起了多份实例。', PORT);
    console.error('  [处理] 查占用：ss -tlnp | grep :%d ；PM2 改为单实例：pm2 delete mood-capsule-api && pm2 start ecosystem.config.js', PORT);
  } else if (code === 'EACCES') {
    console.error('  [原因] 没有绑定该端口的权限（Linux 上 < 1024 的端口需要 root 或 CAP_NET_BIND_SERVICE）。');
    console.error('  [处理] 换成 1024 以上的端口（例如 8123），或用 nginx 反向代理到高位端口。');
  } else if (code === 'EADDRNOTAVAIL') {
    console.error('  [原因] HOST=%s 不是本机网卡上的地址。', HOST);
    console.error('  [处理] 对外提供服务填 HOST=0.0.0.0；只给本机用填 HOST=127.0.0.1（不要填公网 IP / 域名）。');
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('='.repeat(52));
  console.log('  Mood Capsule 后端已启动（Node.js %s，PID %d）', process.version, process.pid);
  console.log('  监听：http://%s:%d%s', HOST, PORT, IS_PUBLIC ? '（对外监听）' : '（仅本机可访问）');
  console.log('  运行环境：%s', IS_MANAGED ? '托管平台 ' + PLATFORM : (IS_PUBLIC ? '自建服务器 / 容器' : '本机'));
  console.log('  数据库文件：%s', DB_PATH);
  console.log('  CORS：%s', ALLOWED_ORIGINS ? ALLOWED_ORIGINS.join(' / ') : '*（默认放开）');
  // ↓ 这两行专治「.env 改了不生效」：能直接看出 .env 有没有读到、有没有被系统环境变量盖掉
  console.log('  .env：%s', ENV_FILE_USED || '未加载（使用系统环境变量 / 默认值）');
  console.log('  配置来源：PORT=%d [%s]、HOST=%s [%s]、DATA_DIR=%s [%s]、CORS_ORIGIN=%s [%s]',
    PORT, envSource('PORT'), HOST, envSource('HOST'),
    DATA_DIR, envSource('DATA_DIR'), RAW_CORS_ORIGIN, envSource('CORS_ORIGIN'));
  if (RAW_PORT && String(PORT) !== RAW_PORT) {
    console.warn('  [警告] PORT=%s 不是合法端口号，已回退为 %d', RAW_PORT, PORT);
  }
  if (MISSING_KEYS.length > 0) {
    console.warn('  [警告] 缺少环境变量：%s', MISSING_KEYS.join(' / '));
    console.warn('         %s', KEY_HINT);
  }
  if (IS_PUBLIC) {
    if (!ALLOWED_ORIGINS) {
      console.warn('  [安全提示] 已公网暴露且未设置 CORS_ORIGIN：任何网站都可调用本接口消耗你的 AI 额度，');
      console.warn('             建议把 CORS_ORIGIN 设为前端域名，例如 https://xxx.netlify.app');
    }
    if (!IS_MANAGED) {
      console.log('  [提示] 自建 / 容器环境：数据文件请自行备份（cp mood.db*），并只在安全组放行必要端口（详见 DEPLOY.md §12）');
    }
  }
  if (IS_MANAGED && DATA_DIR === BASE_DIR) {
    console.warn('  [数据提示] 未设置 DATA_DIR：云平台（如 Render 免费实例）的本地磁盘是临时的，重新部署/重启/休眠后 mood.db 会丢失；');
    console.warn('             需要长期保存请挂载持久化磁盘并把 DATA_DIR 指向挂载点（详见 DEPLOY.md）');
  }
  if (!IS_PUBLIC) {
    console.log('  按 Ctrl+C 停止服务');
  }
  console.log('='.repeat(52));
});
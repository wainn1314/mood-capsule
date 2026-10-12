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
 *    GET  /healthz                    -> 健康检查（托管平台的 health check 用）
 * 配置：复制 .env.example 为 .env 并填入 DIFY_API_KEY / DEEPSEEK_API_KEY（.env 已被 .gitignore 忽略）
 * 可选：PORT / HOST / DATA_DIR / CORS_ORIGIN（分开部署时用 CORS_ORIGIN 收紧跨域白名单，见 DEPLOY.md）
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const BASE_DIR = __dirname;
const ENV_PATH = path.join(BASE_DIR, '.env');

// ---- 加载 .env（零第三方依赖：Node >= 20.12 自带 process.loadEnvFile） ----
// 优先级：已存在的系统环境变量 > .env 文件（loadEnvFile 不会覆盖已有变量）
(function loadDotEnv() {
  if (typeof process.loadEnvFile !== 'function') {
    console.warn('[提示] 当前 Node.js 不支持 process.loadEnvFile()，已跳过 .env 加载；'
      + '请先在系统环境变量中配置 API Key 再启动。');
    return;
  }
  if (!fs.existsSync(ENV_PATH)) {
    console.warn('[提示] 未找到 .env 文件（%s），将只读取系统环境变量。', ENV_PATH);
    return;
  }
  try {
    process.loadEnvFile(ENV_PATH);
  } catch (e) {
    console.warn('[提示] .env 解析失败：%s', e && e.message ? e.message : e);
  }
})();

// ---- 运行时配置：本地开箱即用，云端由环境变量覆盖 ----
const IS_CLOUD = !!process.env.PORT;  // 托管平台（Render / Railway 等）会自动注入 PORT
const HOST = process.env.HOST || (IS_CLOUD ? '0.0.0.0' : '127.0.0.1'); // 本地仍只绑回环，不对外网暴露
const PORT = Number(process.env.PORT) || 8000;
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
// 提示语随运行模式切换：本地改 .env，云端只能改托管平台的环境变量面板
const KEY_HINT = IS_CLOUD
  ? '请在托管平台（Render 等）的 Environment 面板中补齐该变量后重新部署'
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

  // 健康检查（托管平台 health check / 部署后自测用）
  if (req.method === 'GET' && (pathname === '/healthz' || pathname === '/api/health')) {
    return sendJson(res, 200, {
      ok: true,
      service: 'mood-capsule',
      database: { path: DB_PATH, ready: fs.existsSync(DB_PATH) },
      aiKeys: { dify: !!DIFY_API_KEY, deepseek: !!DEEPSEEK_API_KEY },
      corsOrigin: RAW_CORS_ORIGIN,
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

server.listen(PORT, HOST, () => {
  console.log('='.repeat(52));
  console.log('  Mood Capsule 后端已启动（Node.js %s）', process.version);
  console.log('  监听：http://%s:%d%s', HOST, PORT, IS_CLOUD ? '（云平台模式）' : '');
  console.log('  数据库文件：%s', DB_PATH);
  console.log('  CORS：%s', ALLOWED_ORIGINS ? ALLOWED_ORIGINS.join(' / ') : '*（默认放开）');
  if (MISSING_KEYS.length > 0) {
    console.warn('  [警告] 缺少环境变量：%s', MISSING_KEYS.join(' / '));
    console.warn('         %s', IS_CLOUD ? '请在托管平台的环境变量面板中配置后重新部署' : KEY_HINT);
  }
  if (IS_CLOUD) {
    if (!ALLOWED_ORIGINS) {
      console.warn('  [安全提示] 已公网暴露且未设置 CORS_ORIGIN：任何网站都可调用本接口消耗你的 AI 额度，');
      console.warn('             建议把 CORS_ORIGIN 设为前端域名，例如 https://xxx.netlify.app');
    }
    if (DATA_DIR === BASE_DIR) {
      console.warn('  [数据提示] 未设置 DATA_DIR：云平台的本地磁盘是临时的，重新部署/重启/休眠后 mood.db 会丢失；');
      console.warn('             需要长期保存请挂载持久化磁盘并把 DATA_DIR 指向挂载点（详见 DEPLOY.md）');
    }
  } else {
    console.log('  按 Ctrl+C 停止服务');
  }
  console.log('='.repeat(52));
});
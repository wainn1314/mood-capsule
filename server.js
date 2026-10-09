'use strict';
/**
 * Mood Capsule 本地后端（Node.js，单用户，零第三方依赖）
 * 启动：node server.js（或双击 start_server.bat）；浏览器打开 http://127.0.0.1:8000
 * 1) 静态文件服务  2) 数据存 SQLite（mood.db，内置 node:sqlite）
 * 3) AI 代理（API key 只从环境变量 / .env 读取，源码内不保存任何密钥，前端也不持有）：
 *    POST /api/dify/chat-messages -> Dify 流式对话（SSE 透传）
 *    GET  /api/dify/parameters    -> Dify 开场白
 *    GET  /api/dify/conversations/:id/variables -> Dify 会话变量
 *    POST /api/deepseek/chat/completions -> DeepSeek 胶囊设计
 * 配置：复制 .env.example 为 .env 并填入 DIFY_API_KEY / DEEPSEEK_API_KEY（.env 已被 .gitignore 忽略）
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const BASE_DIR = __dirname;
const DB_PATH = path.join(BASE_DIR, 'mood.db');
const ENV_PATH = path.join(BASE_DIR, '.env');
const HOST = '127.0.0.1';
const PORT = 8000;

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
const KEY_HINT = '请在项目根目录新建 .env（可复制 .env.example）并填入对应变量值后重启服务';

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
    'Access-Control-Allow-Origin': '*',
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
        'Access-Control-Allow-Origin': '*',
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
        'Access-Control-Allow-Origin': '*',
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
            'Access-Control-Allow-Origin': '*',
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
      'Access-Control-Allow-Origin': '*',
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

  // 静态文件
  if (req.method === 'GET') return serveStatic(pathname, res);

  sendJson(res, 404, { error: 'Not Found' });
}

const server = http.createServer((req, res) => {
  Promise.resolve(handleRequest(req, res)).catch((err) => {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: String(err.message || err) });
  });
});

server.listen(PORT, HOST, () => {
  console.log('='.repeat(46));
  console.log('  Mood Capsule 本地服务已启动（Node.js）');
  console.log('  请在浏览器打开：http://127.0.0.1:%d', PORT);
  console.log('  数据库文件：%s', DB_PATH);
  if (MISSING_KEYS.length > 0) {
    console.warn('  [警告] 缺少环境变量：%s', MISSING_KEYS.join(' / '));
    console.warn('         %s', KEY_HINT);
  }
  console.log('  按 Ctrl+C 停止服务');
  console.log('='.repeat(46));
});
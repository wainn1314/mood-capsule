/* ============================================================
 * Mood Capsule 前端逻辑（与 server.js / index.html / capsule.js 配套）
 * 数据读写与 AI 调用全部经由本地后端，前端不持有任何 API Key：
 *   对话      POST /api/dify/chat-messages              （Dify 流式 SSE 透传）
 *   开场白    GET  /api/dify/parameters
 *   情绪总结  GET  /api/dify/conversations/:id/variables
 *   胶囊设计  POST /api/deepseek/chat/completions        （icon / decorations / levelText）
 *   历史对话  GET  / PUT  /api/sessions
 *   情绪胶囊  GET  / PUT  /api/capsules
 * 视图结构见 index.html，样式见 styles.css，胶囊绘制见 capsule.js（window.MoodCapsule）
 * ============================================================ */
'use strict';

/* ---------- 配置 ---------- */
const API_BASE = '';                     // 与本地后端同源，使用相对路径
const USER_KEY = 'mood-capsule-user-id'; // 保持 Dify 会话连续
const DEFAULT_OPENING = '你好呀，我是你的情绪树洞 Mood Capsule～想和我聊聊什么？';
const END_QUERY = '我聊完啦，想结束这次对话，和你说声再见～';
const MAX_TITLE_LEN = 18;                // 历史对话标题最大字数
const MAX_CONTEXT_CHARS = 1200;          // 交给胶囊设计模型的对话片段上限
const DESIGN_TIMEOUT_MS = 12000;         // 超时则回退到 capsule.js 的规则设计
const PRESET_COLORS = ['#FF6B6B', '#FFA94D', '#FFD43B', '#69DB7C', '#4DABF7', '#9775FA', '#F06595', '#845EF7'];

// 推荐配色：按情绪关键词匹配，第一项为默认选中色
const COLOR_RULES = [
  { test: /焦虑|紧张|不安|担心|着急|慌乱|恐慌|害怕|恐惧/, colors: ['#4DABF7', '#9775FA', '#69DB7C'] },
  { test: /开心|兴奋|高兴|快乐|喜悦|激动|幸福|满足/, colors: ['#FFD43B', '#FFA94D', '#F06595'] },
  { test: /悲伤|伤心|难过|失落|沮丧|低落|哭泣|委屈|忧伤|心碎|孤独|想念/, colors: ['#9775FA', '#4DABF7', '#845EF7'] },
  { test: /愤怒|生气|烦躁|暴怒|恼火|发火|气恼/, colors: ['#FF6B6B', '#FFA94D', '#845EF7'] },
  { test: /疲惫|劳累|困倦|乏力|倦怠/, colors: ['#69DB7C', '#4DABF7', '#9775FA'] },
  { test: /平静|放松|安静|平和|宁静|舒缓/, colors: ['#69DB7C', '#4DABF7', '#FFD43B'] },
];
const DEFAULT_RECOMMEND = ['#FF6B6B', '#FFA94D', '#4DABF7'];

// capsule.js 未加载时使用的兜底候选词
const FALLBACK_ICONS = ['waves', 'stars', 'rain', 'lightning', 'eye', 'water', 'moon', 'sparkles'];
const FALLBACK_DECORATIONS = ['rays', 'shards', 'dots', 'curves'];

/* ---------- 用户身份 ---------- */
function getUserId() {
  try {
    let u = localStorage.getItem(USER_KEY);
    if (!u) {
      u = 'user-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      localStorage.setItem(USER_KEY, u);
    }
    return u;
  } catch (e) {
    return 'user-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }
}
const USER = getUserId();

/* ---------- 全局状态 ---------- */
const state = {
  sessions: [],          // 历史对话列表（结构同 /api/sessions）
  capsules: [],          // 情绪胶囊列表（结构同 /api/capsules）
  session: null,         // 当前对话
  streaming: false,      // 是否正在等待 / 接收 AI 回复
  endedThisTurn: false,  // 本轮是否走完了 end_chat 分支
  lastSummary: null,     // 本轮情绪总结 { farewell, emotion_type, intensity }
  pendingCapsule: null,  // 待配色的胶囊草稿
  selectedColor: '#FF6B6B',
  detailId: null,        // 详情页当前展示的胶囊 id
};

/* ---------- DOM 引用 ---------- */
const $ = (id) => document.getElementById(id);
const els = {
  historyView: $('historyView'),
  chatView: $('chatView'),
  capsuleView: $('capsuleView'),
  previewView: $('previewView'),
  detailView: $('capsuleDetailView'),
  historyList: $('historyList'),
  historyEmpty: $('historyEmpty'),
  startNewChatBtn: $('startNewChatBtn'),
  capsulePageBtn: $('capsulePageBtn'),
  capsuleBackBtn: $('capsuleBackBtn'),
  messages: $('messages'),
  input: $('input'),
  sendBtn: $('sendBtn'),
  endChatBtn: $('endChatBtn'),
  chatTitle: $('chatTitle'),
  chatSubtitle: $('chatSubtitle'),
  chatCapsuleBtn: $('chatCapsuleBtn'),
  backBtn: $('backBtn'),
  capsuleList: $('capsuleList'),
  capsuleCount: $('capsuleCount'),
  capsuleEmpty: $('capsuleEmpty'),
  swatches: $('swatches'),
  colorInput: $('colorInput'),
  previewEmotion: $('previewEmotion'),
  previewFarewell: $('previewFarewell'),
  previewCancelBtn: $('previewCancelBtn'),
  previewSaveBtn: $('previewSaveBtn'),
  detailSvg: $('capsuleDetailSvg'),
  detailEmotion: $('capsuleDetailEmotion'),
  detailLevel: $('capsuleDetailLevel'),
  detailColorSwatch: $('capsuleDetailColorSwatch'),
  detailColor: $('capsuleDetailColor'),
  detailIntensity: $('capsuleDetailIntensity'),
  detailTime: $('capsuleDetailTime'),
  detailFarewell: $('capsuleDetailFarewell'),
  detailDelete: $('capsuleDetailDelete'),
  detailCapsulesBtn: $('capsuleDetailCapsulesBtn'),
  detailBackBtn: $('capsuleDetailBackBtn'),
  modalOverlay: $('modalOverlay'),
  modalContent: $('modalContent'),
  modalClose: $('modalClose'),
  toast: $('toast'),
};
const VIEW_IDS = ['historyView', 'chatView', 'capsuleView', 'previewView', 'detailView'];

/* ---------- 通用工具 ---------- */
function uid(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function normalizeTs(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

function fmtDate(ts) {
  const d = new Date(normalizeTs(ts));
  return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
}

function fmtDateTime(ts) {
  const d = new Date(normalizeTs(ts));
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' '
    + p(d.getHours()) + ':' + p(d.getMinutes());
}

function clampText(s, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

let toastTimer = null;
function showToast(msg) {
  const t = els.toast;
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------- 视图切换 ---------- */
function showView(id) {
  VIEW_IDS.forEach((v) => {
    if (els[v]) els[v].hidden = (v !== id);
  });
}

/* ---------- 本地数据接口（server.js） ---------- */
async function apiGet(path) {
  const res = await fetch(API_BASE + path, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function apiPut(path, data) {
  const res = await fetch(API_BASE + path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function loadSessions() {
  try {
    const list = await apiGet('/api/sessions');
    state.sessions = Array.isArray(list) ? list : [];
  } catch (e) {
    state.sessions = [];
    showToast('历史对话读取失败，请确认本地服务已启动');
  }
}

function saveSessions() {
  return apiPut('/api/sessions', state.sessions).catch(() => { showToast('历史对话保存失败'); });
}

async function loadCapsules() {
  try {
    const list = await apiGet('/api/capsules');
    state.capsules = Array.isArray(list) ? list : [];
  } catch (e) {
    state.capsules = [];
    showToast('情绪胶囊读取失败，请确认本地服务已启动');
  }
}

function saveCapsules() {
  return apiPut('/api/capsules', state.capsules).catch(() => { showToast('情绪胶囊保存失败'); });
}

function sortedSessions() {
  return state.sessions.slice().sort((a, b) => normalizeTs(b.updatedAt) - normalizeTs(a.updatedAt));
}

function sortedCapsules() {
  return state.capsules.slice().sort((a, b) => normalizeTs(b.createdAt) - normalizeTs(a.createdAt));
}


/* ---------- 历史对话 ---------- */
function renderHistory() {
  const list = sortedSessions();
  els.historyList.innerHTML = '';
  els.historyEmpty.hidden = list.length > 0;

  list.forEach((s) => {
    const item = document.createElement('div');
    item.className = 'history-item';

    const title = document.createElement('div');
    title.className = 'history-title';
    title.textContent = s.title || '新的对话';

    const preview = document.createElement('div');
    preview.className = 'history-preview';
    preview.textContent = sessionPreview(s);

    const meta = document.createElement('div');
    meta.className = 'history-meta';
    const time = document.createElement('span');
    time.textContent = fmtDateTime(s.updatedAt || s.createdAt);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'history-delete';
    del.textContent = '删除';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      askDeleteSession(s);
    });
    meta.appendChild(time);
    meta.appendChild(del);

    item.appendChild(title);
    item.appendChild(preview);
    item.appendChild(meta);
    item.addEventListener('click', () => openSession(s));
    els.historyList.appendChild(item);
  });
}

function sessionPreview(s) {
  const list = Array.isArray(s.messages) ? s.messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const t = String((list[i] && list[i].text) || '').replace(/\s+/g, ' ').trim();
    if (t) return t.length > 60 ? t.slice(0, 60) + '…' : t;
  }
  return '还没有内容～';
}

function askDeleteSession(s) {
  openConfirm({
    title: '删除这段对话？',
    message: '「' + (s.title || '新的对话') + '」删除后无法恢复，已生成的胶囊会保留。',
    confirmText: '删除对话',
    onConfirm: async () => {
      state.sessions = state.sessions.filter((x) => x.id !== s.id);
      if (state.session && state.session.id === s.id) state.session = null;
      await saveSessions();
      renderHistory();
      showToast('已删除这段对话');
    },
  });
}

function openSession(s) {
  state.session = {
    id: s.id,
    conversationId: s.conversationId || null,
    title: s.title || '新的对话',
    messages: (Array.isArray(s.messages) ? s.messages : [])
      .map((m) => ({ role: m && m.role, text: String((m && m.text) || '') })),
    createdAt: normalizeTs(s.createdAt),
    updatedAt: normalizeTs(s.updatedAt),
  };
  state.pendingCapsule = null;
  state.endedThisTurn = false;
  state.lastSummary = null;
  els.chatTitle.textContent = state.session.title;
  els.chatSubtitle.textContent = '正在倾诉中…';
  els.messages.innerHTML = '';
  state.session.messages.forEach((m) => addMessage(m.role, m.text));
  showView('chatView');
  els.input.focus();
}

function backToHistory() {
  if (state.streaming) {
    showToast('正在回复中，稍等一下再返回哦～');
    return;
  }
  saveSessions();
  renderHistory();
  showView('historyView');
}


/* ---------- 消息渲染 ---------- */
function addMessage(role, text) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = String(text == null ? '' : text);
  wrap.appendChild(bubble);
  els.messages.appendChild(wrap);
  scrollMessagesToBottom();
  return bubble;
}

function scrollMessagesToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function setComposerDisabled(disabled) {
  state.streaming = disabled;
  els.sendBtn.disabled = disabled;
  els.endChatBtn.disabled = disabled;
  els.input.disabled = disabled;
  els.sendBtn.textContent = disabled ? '思考中…' : '发送';
}

/* ---------- 开场白（/api/dify/parameters） ---------- */
async function fetchOpeningStatement() {
  try {
    const res = await fetch(API_BASE + '/api/dify/parameters?user=' + encodeURIComponent(USER), { cache: 'no-store' });
    if (!res.ok) return DEFAULT_OPENING;
    const json = await res.json();
    return String(json.opening_statement || '').trim() || DEFAULT_OPENING;
  } catch (e) {
    return DEFAULT_OPENING;
  }
}

/* ---------- 情绪总结（会话变量接口） ---------- */
async function fetchConversationVariables(conversationId) {
  const out = { emotion_type: '', intensity: '' };
  if (!conversationId) return out;
  try {
    const url = API_BASE + '/api/dify/conversations/' + encodeURIComponent(conversationId)
      + '/variables?user=' + encodeURIComponent(USER);
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return out;
    const json = await res.json();
    const data = Array.isArray(json.data) ? json.data : [];
    data.forEach((item) => {
      if (item && item.name === 'last_emotion_type') out.emotion_type = String(item.value == null ? '' : item.value);
      if (item && item.name === 'last_emotion_intensity') out.intensity = String(item.value == null ? '' : item.value);
    });
  } catch (e) { /* 忽略：由调用方给出兜底提示 */ }
  return out;
}

/* 情绪强度换算：Dify 变量为 0-10，展示用 0-100 */
function toPercent(raw) {
  const n = parseFloat(raw);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n * 10)));
}

/* ---------- SSE 解析 ---------- */
function parseSSEBlock(block) {
  let name = null;
  let data = '';
  const lines = String(block).split('\n');
  lines.forEach((line) => {
    if (line.indexOf('event:') === 0) name = line.slice(6).trim();
    else if (line.indexOf('data:') === 0) data += line.slice(5).trim() + '\n';
  });
  data = data.trim();
  if (!data) return null;
  let payload;
  try { payload = JSON.parse(data); } catch (e) { return null; }
  if (!name) name = payload.event || 'message';
  return { name: name, data: payload };
}

/* 去掉推理模型输出的 <think>…</think> 思考过程 */
function stripThinking(text) {
  let t = String(text == null ? '' : text);
  t = t.replace(/<think\b[\s\S]*?<\/think>/gi, '');
  t = t.replace(/<think\b[\s\S]*$/gi, '');
  return t.trim();
}

function handleNodeFinished(payload) {
  const d = (payload && payload.data) ? payload.data : {};
  if (d.status && d.status !== 'succeeded') return;
  const nodeId = d.node_id || '';
  if (nodeId === 'summary_code' && d.outputs) {
    state.lastSummary = {
      farewell: d.outputs.farewell || '',
      emotion_type: d.outputs.emotion_type || '',
      intensity: d.outputs.intensity || '',
    };
  }
  if (nodeId === 'summary_assigner' || nodeId === 'answer_summary') {
    state.endedThisTurn = true;
  }
}


/* ---------- 开始新对话 ---------- */
async function startNewChat() {
  const now = Date.now();
  const session = {
    id: uid('sess'),
    conversationId: null,
    title: '新的对话',
    messages: [{ role: 'assistant', text: DEFAULT_OPENING }],
    createdAt: now,
    updatedAt: now,
  };
  state.sessions.push(session);
  state.session = session;
  state.pendingCapsule = null;
  state.endedThisTurn = false;
  state.lastSummary = null;
  els.chatTitle.textContent = session.title;
  els.chatSubtitle.textContent = '正在倾诉中…';
  els.messages.innerHTML = '';
  const bubble = addMessage('assistant', DEFAULT_OPENING);
  showView('chatView');
  els.input.focus();
  await saveSessions();

  // 用 Dify 的开场白覆盖默认文案（接口不可用时保持默认）
  const opening = await fetchOpeningStatement();
  if (opening && opening !== DEFAULT_OPENING && state.session && state.session.id === session.id) {
    session.messages[0].text = opening;
    bubble.textContent = opening;
    await saveSessions();
  }
}

/* ---------- 发送消息（流式） ---------- */
async function sendMessage(query, options) {
  const opts = options || {};
  if (state.streaming) return;
  if (!state.session) await startNewChat();
  if (state.streaming || !state.session) return;

  const q = String(query == null ? '' : query).trim();
  if (!q) return;

  const session = state.session;
  state.endedThisTurn = false;
  state.lastSummary = null;
  setComposerDisabled(true);

  session.messages.push({ role: 'user', text: q });
  addMessage('user', q);
  if (!session.title || session.title === '新的对话') {
    session.title = clampText(q, MAX_TITLE_LEN);
    els.chatTitle.textContent = session.title;
  }

  const bubble = addMessage('assistant', '');
  let answerText = '';
  let failed = false;

  const body = {
    inputs: {},
    query: q,
    response_mode: 'streaming',
    user: USER,
  };
  if (session.conversationId) body.conversation_id = session.conversationId;

  const consume = (block) => {
    const ev = parseSSEBlock(block);
    if (!ev) return;
    if (ev.name === 'message') {
      if (ev.data.conversation_id) session.conversationId = ev.data.conversation_id;
      const a = ev.data.answer || '';
      if (a) {
        answerText += a;
        bubble.textContent = stripThinking(answerText);
        scrollMessagesToBottom();
      }
    } else if (ev.name === 'message_end') {
      if (ev.data.conversation_id) session.conversationId = ev.data.conversation_id;
    } else if (ev.name === 'node_finished') {
      handleNodeFinished(ev.data);
    }
  };

  try {
    const res = await fetch(API_BASE + '/api/dify/chat-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try {
        const j = await res.json();
        msg = j.message || j.error || j.code || msg;
      } catch (e) { /* 保留状态码 */ }
      throw new Error(msg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      buffer += decoder.decode(step.value, { stream: true });
      let idx = buffer.indexOf('\n\n');
      while (idx !== -1) {
        consume(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
        idx = buffer.indexOf('\n\n');
      }
    }
    if (buffer.trim()) consume(buffer);
  } catch (err) {
    failed = true;
    bubble.textContent = '⚠️ ' + ((err && err.message) ? err.message : '网络错误，请稍后重试');
    bubble.classList.add('error');
  } finally {
    setComposerDisabled(false);
  }

  const answer = stripThinking(answerText);
  if (!failed) session.messages.push({ role: 'assistant', text: answer });
  session.updatedAt = Date.now();
  await saveSessions();

  if (!failed && (opts.generateCapsule || state.endedThisTurn)) {
    await prepareCapsule(answer);
  }
}


/* ---------- 结束对话 → 准备胶囊（拿情绪总结 + 选色） ---------- */
async function prepareCapsule(farewell) {
  const summary = state.lastSummary || {};
  let emotionType = String(summary.emotion_type || '').trim();
  let rawIntensity = String(summary.intensity || '').trim();

  // 节点变量没拿到时，再用会话变量接口兜底
  if (!emotionType || !rawIntensity) {
    const v = await fetchConversationVariables(state.session && state.session.conversationId);
    if (!emotionType) emotionType = String(v.emotion_type || '').trim();
    if (!rawIntensity) rawIntensity = String(v.intensity || '').trim();
  }

  if (!emotionType) {
    showToast('还没拿到这次的情绪总结，多聊几句再结束对话试试～');
    return;
  }

  state.pendingCapsule = {
    emotionType: emotionType,
    rawIntensity: rawIntensity,
    intensity: toPercent(rawIntensity),
    // 优先用总结节点的 farewell，其次退回本轮 AI 回复正文
    farewell: String(summary.farewell || farewell || '').trim(),
    context: conversationContext(),
  };
  openPreview();
}

function conversationContext() {
  const list = (state.session && Array.isArray(state.session.messages)) ? state.session.messages : [];
  const text = list.slice(-8)
    .map((m) => (m.role === 'user' ? '我：' : '树洞：') + String((m && m.text) || ''))
    .join('\n');
  return text.length > MAX_CONTEXT_CHARS ? text.slice(text.length - MAX_CONTEXT_CHARS) : text;
}

function recommendColors(emotionType) {
  const t = String(emotionType || '');
  for (let i = 0; i < COLOR_RULES.length; i += 1) {
    if (COLOR_RULES[i].test.test(t)) return COLOR_RULES[i].colors.slice();
  }
  return DEFAULT_RECOMMEND.slice();
}

/* ---------- 配色界面 ---------- */
function openPreview() {
  const p = state.pendingCapsule;
  if (!p) {
    showView('chatView');
    return;
  }
  els.previewEmotion.textContent = p.emotionType;
  if (p.farewell) {
    els.previewFarewell.textContent = '“' + p.farewell + '”';
    els.previewFarewell.hidden = false;
  } else {
    els.previewFarewell.textContent = '';
    els.previewFarewell.hidden = true;
  }
  state.selectedColor = recommendColors(p.emotionType)[0] || PRESET_COLORS[0];
  els.colorInput.value = state.selectedColor;
  renderSwatches();
  showView('previewView');
}

function renderSwatches() {
  const recommend = state.pendingCapsule ? recommendColors(state.pendingCapsule.emotionType) : DEFAULT_RECOMMEND;
  els.swatches.innerHTML = '';
  els.swatches.appendChild(buildSwatchGroup('✨ 推荐配色', recommend));
  els.swatches.appendChild(buildSwatchGroup('🎨 更多配色', PRESET_COLORS));
}

function buildSwatchGroup(label, colors) {
  const group = document.createElement('div');
  group.className = 'swatch-group';

  const cap = document.createElement('span');
  cap.className = 'swatch-group-label';
  cap.textContent = label;

  const row = document.createElement('div');
  row.className = 'swatches';
  const seen = [];
  colors.forEach((c) => {
    if (seen.indexOf(c.toUpperCase()) !== -1) return;
    seen.push(c.toUpperCase());
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch';
    btn.style.background = c;
    btn.title = c;
    btn.dataset.color = c;
    if (c.toUpperCase() === state.selectedColor.toUpperCase()) btn.classList.add('active');
    btn.addEventListener('click', () => {
      state.selectedColor = c;
      els.colorInput.value = c;
      renderSwatches();
    });
    row.appendChild(btn);
  });

  group.appendChild(cap);
  group.appendChild(row);
  return group;
}


/* ---------- 胶囊视觉设计（DeepSeek，失败自动回退规则设计） ---------- */
function designPrompt() {
  const mc = window.MoodCapsule;
  const icons = (mc && mc.ICON_KEYS ? mc.ICON_KEYS : FALLBACK_ICONS).join('、');
  const decos = (mc && mc.DECORATION_KEYS ? mc.DECORATION_KEYS : FALLBACK_DECORATIONS).join('、');
  return [
    '你是情绪胶囊的视觉设计师。根据用户本次倾诉的情绪，为胶囊挑选最贴切的视觉元素。',
    '所有取值只能从下列候选词中选择，不要创造新词：',
    'icon（必须 1 个）：' + icons,
    'decorations（1~3 个，可多选）：' + decos,
    'levelText：4~8 个汉字，贴合情绪的短语，例如「压力感很大」「社交能量满格」「心情翻涌」。',
    '只输出一个 JSON 对象，不要解释、不要代码块，格式如下：',
    '{"icon":"...","decorations":["..."],"levelText":"..."}',
  ].join('\n');
}

function parseDesign(text) {
  let s = stripThinking(String(text || ''))
    .replace(/```[a-zA-Z]*/g, '')
    .replace(/```/g, '')
    .trim();
  const start = s.indexOf('{');
  if (start === -1) return null;
  let obj = null;
  try {
    obj = JSON.parse(s.slice(start, s.lastIndexOf('}') + 1));
  } catch (e) {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  const mc = window.MoodCapsule;
  const icons = (mc && mc.ICON_KEYS ? mc.ICON_KEYS : FALLBACK_ICONS);
  const decos = (mc && mc.DECORATION_KEYS ? mc.DECORATION_KEYS : FALLBACK_DECORATIONS);
  if (icons.indexOf(obj.icon) === -1) return null;

  return {
    icon: obj.icon,
    decorations: (Array.isArray(obj.decorations) ? obj.decorations : [])
      .filter((k) => decos.indexOf(k) !== -1)
      .slice(0, 3),
    levelText: (typeof obj.levelText === 'string') ? obj.levelText.trim().slice(0, 12) : '',
  };
}

async function requestDesign(emotionType, intensity, context) {
  const mc = window.MoodCapsule;
  const fallback = (mc && mc.suggestDesign)
    ? mc.suggestDesign(emotionType, intensity, context)
    : { icon: FALLBACK_ICONS[0], decorations: [FALLBACK_DECORATIONS[2]], levelText: '情绪' };

  const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  let timer = null;
  try {
    if (controller) timer = setTimeout(() => controller.abort(), DESIGN_TIMEOUT_MS);
    const res = await fetch(API_BASE + '/api/deepseek/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller ? controller.signal : undefined,
      body: JSON.stringify({
        messages: [
          { role: 'system', content: designPrompt() },
          {
            role: 'user',
            content: '情绪类型：' + emotionType
              + '\n情绪强度：' + intensity + '%'
              + '\n对话片段：\n' + (context || '（无）'),
          },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.4,
        max_tokens: 300,
      }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const choice = (data.choices && data.choices[0]) ? data.choices[0] : null;
    const content = (choice && choice.message) ? choice.message.content : '';
    return parseDesign(content) || fallback;
  } catch (e) {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ---------- 生成并保存胶囊 ---------- */
async function savePendingCapsule() {
  const p = state.pendingCapsule;
  if (!p) {
    showView('capsuleView');
    return;
  }
  const mc = window.MoodCapsule;
  if (!mc || typeof mc.generateCapsuleSvg !== 'function') {
    showToast('胶囊绘制组件未加载，请刷新页面重试');
    return;
  }

  const btn = els.previewSaveBtn;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '正在封装…';
  try {
    const design = await requestDesign(p.emotionType, p.intensity, p.context);
    const level = mc.intensityLevel(p.intensity);
    const levelText = (design && design.levelText) ? design.levelText : level;
    const capsule = {
      id: uid('cap'),
      emotionType: p.emotionType,
      rawIntensity: String(p.rawIntensity),
      intensity: p.intensity,
      level: level,
      levelText: levelText,
      color: state.selectedColor,
      // 显式补全 levelText，保证 SVG 里显示的文字与落库文字一致
      svg: mc.generateCapsuleSvg(p.emotionType, p.intensity, state.selectedColor, {
        icon: design && design.icon,
        decorations: design && design.decorations,
        levelText: levelText,
      }),
      farewell: p.farewell || '',
      createdAt: Date.now(),
    };
    state.capsules.push(capsule);
    await saveCapsules();
    state.pendingCapsule = null;
    renderCapsules();
    openDetail(capsule.id);
    showToast('已收好一枚「' + capsule.emotionType + '」情绪胶囊 🧡');
  } catch (e) {
    showToast('胶囊生成失败：' + ((e && e.message) ? e.message : '未知错误'));
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}


/* ---------- 胶囊列表 ---------- */
function renderCapsules() {
  const list = sortedCapsules();
  els.capsuleCount.textContent = String(list.length);
  els.capsuleEmpty.hidden = list.length > 0;
  els.capsuleList.innerHTML = '';

  list.forEach((c) => {
    const card = document.createElement('div');
    card.className = 'capsule-card';

    const thumb = document.createElement('div');
    thumb.className = 'capsule-thumb';
    thumb.innerHTML = c.svg || '';

    const meta = document.createElement('div');
    meta.className = 'capsule-meta';
    const emotion = document.createElement('span');
    emotion.className = 'capsule-emotion';
    emotion.textContent = c.emotionType || '情绪';
    const level = document.createElement('span');
    level.className = 'capsule-level';
    level.style.color = c.color || '';
    level.textContent = c.level || '';
    meta.appendChild(emotion);
    meta.appendChild(level);

    const footer = document.createElement('div');
    footer.className = 'capsule-footer';
    const date = document.createElement('span');
    date.className = 'capsule-date';
    date.textContent = fmtDate(c.createdAt);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'capsule-delete';
    del.textContent = '删除';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      askDeleteCapsule(c);
    });
    footer.appendChild(date);
    footer.appendChild(del);

    card.appendChild(thumb);
    card.appendChild(meta);
    card.appendChild(footer);
    card.addEventListener('click', () => openDetail(c.id));
    els.capsuleList.appendChild(card);
  });
}

function askDeleteCapsule(c) {
  openConfirm({
    title: '删除这枚胶囊？',
    message: '「' + (c.emotionType || '情绪') + '」删除后无法恢复。',
    confirmText: '删除胶囊',
    onConfirm: async () => {
      state.capsules = state.capsules.filter((x) => x.id !== c.id);
      await saveCapsules();
      renderCapsules();
      showView('capsuleView');
      showToast('已删除这枚胶囊');
    },
  });
}

/* ---------- 胶囊详情 ---------- */
function levelLine(c) {
  const level = String(c.level || '').trim();
  const text = String(c.levelText || '').trim();
  if (text && text !== level) return level ? level + ' · ' + text : text;
  return level || text || '情绪';
}

function intensityLine(c) {
  const raw = String(c.rawIntensity == null ? '' : c.rawIntensity).trim();
  const pct = Number(c.intensity);
  const pctText = Number.isFinite(pct) ? String(pct) + '%' : '';
  if (raw && pctText) return raw + '/10（' + pctText + '）';
  return raw || pctText || '未知';
}

function openDetail(id) {
  const c = state.capsules.filter((x) => x.id === id)[0];
  if (!c) {
    showView('capsuleView');
    return;
  }
  state.detailId = id;
  els.detailSvg.innerHTML = c.svg || '';
  els.detailEmotion.textContent = c.emotionType || '情绪';
  els.detailLevel.textContent = levelLine(c);
  els.detailLevel.style.color = c.color || '';
  els.detailColorSwatch.style.background = c.color || '';
  els.detailColor.textContent = c.color || '';
  els.detailIntensity.textContent = intensityLine(c);
  els.detailTime.textContent = fmtDateTime(c.createdAt);
  if (c.farewell) {
    els.detailFarewell.textContent = '“' + c.farewell + '”';
    els.detailFarewell.hidden = false;
  } else {
    els.detailFarewell.textContent = '';
    els.detailFarewell.hidden = true;
  }
  showView('detailView');
}


/* ---------- 弹窗（删除确认） ---------- */
function openConfirm(opts) {
  const o = opts || {};
  els.modalContent.innerHTML = '';

  const info = document.createElement('div');
  info.className = 'detail-info';

  const title = document.createElement('h3');
  title.textContent = o.title || '确认操作';
  const msg = document.createElement('p');
  msg.className = 'history-preview';
  msg.style.whiteSpace = 'normal';
  msg.textContent = o.message || '';

  const actions = document.createElement('div');
  actions.className = 'detail-actions';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn-ghost';
  cancel.textContent = '取消';
  cancel.addEventListener('click', closeModal);

  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'btn-danger';
  ok.textContent = o.confirmText || '确定';
  ok.addEventListener('click', () => {
    closeModal();
    if (typeof o.onConfirm === 'function') o.onConfirm();
  });

  actions.appendChild(cancel);
  actions.appendChild(ok);
  info.appendChild(title);
  info.appendChild(msg);
  info.appendChild(actions);
  els.modalContent.appendChild(info);
  els.modalOverlay.hidden = false;
}

function closeModal() {
  els.modalOverlay.hidden = true;
  els.modalContent.innerHTML = '';
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  els.startNewChatBtn.addEventListener('click', () => { startNewChat(); });
  els.capsulePageBtn.addEventListener('click', () => { renderCapsules(); showView('capsuleView'); });
  els.capsuleBackBtn.addEventListener('click', () => { renderHistory(); showView('historyView'); });
  els.chatCapsuleBtn.addEventListener('click', () => { renderCapsules(); showView('capsuleView'); });
  els.backBtn.addEventListener('click', backToHistory);
  els.detailCapsulesBtn.addEventListener('click', () => { renderCapsules(); showView('capsuleView'); });
  els.detailBackBtn.addEventListener('click', () => { renderHistory(); showView('historyView'); });

  els.sendBtn.addEventListener('click', () => {
    const q = els.input.value;
    els.input.value = '';
    sendMessage(q);
  });
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const q = els.input.value;
      els.input.value = '';
      sendMessage(q);
    }
  });
  els.endChatBtn.addEventListener('click', () => {
    if (state.streaming) return;
    sendMessage(END_QUERY, { generateCapsule: true });
  });

  els.colorInput.addEventListener('input', () => {
    if (els.colorInput.value) state.selectedColor = els.colorInput.value;
    renderSwatches();
  });
  els.previewCancelBtn.addEventListener('click', () => { showView('chatView'); });
  els.previewSaveBtn.addEventListener('click', savePendingCapsule);
  els.detailDelete.addEventListener('click', () => {
    const c = state.capsules.filter((x) => x.id === state.detailId)[0];
    if (c) askDeleteCapsule(c);
  });

  els.modalClose.addEventListener('click', closeModal);
  els.modalOverlay.addEventListener('click', (e) => {
    if (e.target === els.modalOverlay) closeModal();
  });
}

/* ---------- 初始化 ---------- */
async function init() {
  bindEvents();
  els.colorInput.value = state.selectedColor;
  await Promise.all([loadSessions(), loadCapsules()]);
  renderHistory();
  renderCapsules();
  showView('historyView');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { init(); });
} else {
  init();
}


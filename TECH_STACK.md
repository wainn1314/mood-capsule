# Mood Capsule · 技术栈说明

> **文档依据**：对项目目录内全部源码（`app.js`、`capsule.js`、`index.html`、`styles.css`、`server.js`、`mood-capsule-chatflow.yaml`、`start_server.bat`、`mood.db`）逐文件通读，并对本机运行环境做了实测验证。
> **实测环境**：Windows / Node.js **v24.21.0** / npm 11.19.0。已验证 `require('node:sqlite')` 可直接使用，**无需任何启动参数**。
> **更新日期**：2026-10-09（新增：密钥外置到 `.env` + `.gitignore`，详见第 8.1 节）

---

## 0. 一页速览

| 维度 | 选型 | 关键事实 |
|---|---|---|
| 应用形态 | 本地单用户 Web 应用（情绪共情对话 + 情绪胶囊收藏） | 双击 `start_server.bat` → 浏览器打开 `http://127.0.0.1:8000` |
| 前端框架 | **无框架、无构建、无 CDN** | 原生 HTML + CSS + ES2020 JS，3 个 `<script>/<link>` 引用 |
| 前端模块化 | 经典脚本 + 全局命名空间 `window.MoodCapsule` | 非 ESM、无打包器 |
| 视图/路由 | 手写「切换 `hidden` 属性」的多视图 SPA | 5 个视图容器 |
| 流式输出 | `fetch` + `ReadableStream.getReader()` **手写 SSE 解析** | 按 `\n\n` 切块、跨 chunk 缓冲、剥离 `<think>` |
| 图形渲染 | **纯 SVG 字符串拼接**（`capsule.js`） | 无 Canvas、无图表库 |
| 后端 | **单文件 Node.js，零第三方依赖** | `server.js` 仅用 `node:*` 内置模块 |
| 数据库 | **SQLite（`node:sqlite` 内置 `DatabaseSync`）** | 文件 `mood.db`，WAL 模式，**不需要 npm install** |
| 鉴权/密钥 | Key 只经后端注入，前端零 Key | 后端从**环境变量 / `.env`** 读取，源码内无密钥；前端 `API_BASE = ''`，全部相对路径 |
| AI 编排 | **Dify 工作流（advanced-chat DSL）** | `mood-capsule-chatflow.yaml`，可导入 Dify 平台 |
| 大模型 | DeepSeek（provider `deepseek`） | 工作流节点用 `deepseek-v4-flash`；外观设计直连 `deepseek-chat` |
| 依赖管理 | **无** `package.json` / `node_modules` / lock 文件 | 真正的零安装 |
| 运行时依赖 | Node.js **≥ 22**（`node:sqlite` 引入版本） | 本机 24.21.0 |

---

## 1. 总体架构

```
浏览器（原生前端，无框架/无构建/无 CDN）
├─ index.html    8.9 KB   5 个视图容器（history / chat / capsule / preview / capsuleDetail）
├─ styles.css   14.3 KB   原生 CSS（自定义属性、Grid、Flex、@keyframes、@media）
├─ capsule.js   22.2 KB   纯 SVG 胶囊绘制引擎（window.MoodCapsule，零外部依赖）
└─ app.js       34.8 KB   状态管理 + 视图渲染 + 手写 SSE 流式解析
        │
        │  fetch 相对路径（API_BASE = ''）——前端不持有任何 API Key
        ▼
本地后端 server.js  13.4 KB   ← 零第三方依赖，仅 Node 内置模块
├─ .env 加载        process.loadEnvFile()（Node ≥ 20.12，无第三方 dotenv）
├─ node:http      静态文件服务 + 路由 + CORS
├─ node:sqlite    持久化 mood.db（WAL 模式，内置驱动）
└─ node:https     反向代理（仅在此处注入 API Key）
        │
        ├─► https://api.dify.ai/v1        Dify 工作流：意图识别 / 共情对话 / 情绪总结
        └─► https://api.deepseek.com/v1   deepseek-chat：胶囊外观设计
```

**核心设计**：把「密钥」「跨域」「持久化」三件事全部收进本地后端，前端退化为纯 UI + 流式渲染，因此前端代码可以直接用浏览器打开调试，也不会泄露凭据。

---

## 2. 前端技术栈

### 2.1 语言与加载方式

| 项 | 说明 |
|---|---|
| 语言 | 原生 JavaScript（ES2020+：`async/await`、可选链 `?.`、模板字符串、解构） |
| 类型系统 | **无 TypeScript**（无 `.ts` / `tsconfig.json` / 构建产物） |
| 模块化 | **经典脚本顺序加载**，靠全局对象通信：`window.MoodCapsule`（不是 ESM） |
| 加载顺序 | `index.html` 底部：`capsule.js` → `app.js`（先注册图形引擎，再跑业务逻辑） |
| 构建 | **无**（无 webpack/vite/rollup/esbuild），改完源码刷新浏览器即生效 |
| 外部库 | **无**（无 jQuery / React / Vue / Tailwind / Bootstrap，无任何 CDN 链接） |

### 2.2 视图与状态管理

- **路由**：手写 SPA。`app.js` 维护 `VIEW_IDS = ['historyView','chatView','capsuleView','previewView','capsuleDetailView']`，`showView(id)` 统一通过 `hidden` 属性显示一个、隐藏其余，**无 hash 路由、无 history API**。
- **状态**：模块级单一 `state` 对象，字段语义如下：

```js
state = {
  sessions,        // 历史对话列表（来自 GET /api/sessions）
  capsules,        // 情绪胶囊列表（来自 GET /api/capsules）
  currentSession,  // 当前打开的会话（含 conversationId、messages）
  pendingCapsule,  // 待保存的胶囊草稿（情绪/强度/配色/设计）
  selectedColor,   // 用户选中的主色（默认 #FF6B6B）
  detailId,        // 详情页当前胶囊 id
  streaming,       // 是否正在流式接收（用于禁用发送/结束按钮）
}
```

- **渲染方式**：命令式全量重渲染 —— `renderHistory()` / `renderCapsules()` / `renderSwatches()` / `openDetail()` 等函数，在状态变化后重新构建 DOM 片段并挂载。**无虚拟 DOM、无响应式追踪**。
- **DOM 引用**：启动时一次性收集到 `els` 对象（`els.input`、`els.sendBtn`…），避免重复查询。
- **安全**：文本一律用 `textContent` 写入（不用 `innerHTML` 拼用户数据），从根上规避 XSS。

### 2.3 网络层：手写 SSE 流式解析

Dify 的对话接口返回 `text/event-stream`，前端**没有使用任何 EventSource 库**，而是：

1. `fetch('/api/dify/chat-messages', { method:'POST', body, headers:{Accept:'text/event-stream'} })`；
2. `res.body.getReader()` 拿到 `ReadableStream` 读句柄；
3. 循环 `reader.read()`，用 `TextDecoder` 解码并**累积到 buffer**；
4. 按 `\n\n` 切分事件块（`parseSSEBlock`），**保留不完整尾块以处理跨 chunk 断包**；
5. 按事件类型分发：`message`（逐字追加到气泡）、`node_finished`（捕获总结节点输出）、`message_end`（取 `conversation_id`/元数据）；
6. `stripThinking()` 剥离模型输出的 `<think>…</think>` 思考过程，只显示给用户看的内容；
7. 每个片段到达后滚动到底部，形成打字机效果。

**为什么这么做**：`EventSource` 只支持 GET、无法自定义请求头，而 Dify 的对话必须 POST + JSON body。

### 2.4 样式与图形

- **CSS**：单文件 `styles.css`（478 行）原生 CSS —— 自定义属性（`var(--…)`）做主题色、Grid/Flex 布局、`@keyframes` 做胶囊浮动/弹入动画、`@media` 做窄屏适配。**无预处理器（Sass/Less）、无 CSS-in-JS**。
- **图形引擎**：`capsule.js` 在运行时**拼接 SVG 字符串**（胶囊主体、渐变、高光、图标、装饰、强度标尺、文字），全文件零外部依赖，注释中说明"与 `emotion_capsule_svg.py` 保持一致"。对外 API：

| API | 作用 |
|---|---|
| `generateCapsuleSvg(emotionType, intensity, color, design)` | 生成完整胶囊 SVG 字符串（落库 + 展示用同一份） |
| `suggestDesign(emotionType, intensity, context)` | **本地规则兜底设计**（AI 设计失败/超时时使用） |
| `intensityLevel(intensity)` / `clampIntensity(v)` | 强度分级（如「情绪平静/情绪涌动」）与 0–100 归一 |
| `normalizeColor(c)` / `hexToRgb(c)` | 颜色校正与解析 |
| `ICON_KEYS` / `DECORATION_KEYS` | 图标与装饰白名单（供 AI 设计结果校验） |
| （内部）`escapeXml` / `suggestDecorations` | XML 转义、装饰推荐 |

### 2.5 本地存储边界

- `localStorage` **只存一个 user id**（`USER_KEY`），用于 Dify 会话隔离与多轮连续性；
- **业务数据（对话、胶囊）不再存浏览器**，全部落后端 SQLite —— 换浏览器/清缓存不丢数据；
- 会话续聊依赖后端返回的 `conversationId`，随会话记录一起持久化。

---

## 3. 后端技术栈（`server.js`）

### 3.1 运行时与内置模块

| 项 | 说明 |
|---|---|
| 运行时 | Node.js（本机 v24.21.0）；要求 **≥ 22**，因为使用了 `node:sqlite` |
| HTTP 服务 | `node:http`（`http.createServer` 手写路由，**无 Express/Koa/Fastify**） |
| 出网请求 | `node:https`（转发 Dify / DeepSeek，支持流式 pipe） |
| 数据库 | `node:sqlite` 的 `DatabaseSync`（**内置，无需 `better-sqlite3`**） |
| 文件/路径 | `node:fs`、`node:path`（静态文件、路径穿越防护） |
| 第三方依赖 | **0 个**（无 `package.json`、无 `node_modules`） |
| 监听 | `HOST = 127.0.0.1`、`PORT = 8000`（仅回环地址，外网不可达） |

### 3.2 三类职责

1. **静态文件服务**（`serveStatic`）：把请求路径映射到磁盘文件，带 MIME 类型表（html/js/css/svg/json/yaml…），默认 `/` → `index.html`；用 `path.normalize` + `startsWith(BASE_DIR + path.sep)` 阻断目录穿越。
2. **数据 API**（`listSessions` / `replaceSessions` / `listCapsules` / `replaceCapsules`）：采用**覆盖式保存** —— 读 = 整表 `SELECT` 并按字段映射为前端对象；写 = `BEGIN` → `DELETE FROM xxx` → 批量 `INSERT` → `COMMIT`，异常 `ROLLBACK`。
3. **AI 反向代理**（`proxyDifyChat` / `proxyDifyGet` / `proxyDeepSeek`）：在服务端注入 `Authorization: Bearer <KEY>`；对话走 `upRes.pipe(res)` 直通，并下发 `Cache-Control: no-cache`、`Connection: keep-alive`、`X-Accel-Buffering: no` 以确保**逐块不缓冲**；DeepSeek 代理会强制覆写 `model` 字段，防止前端指定任意模型。

### 3.3 路由表（路由分发在 `handleRequest`）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/sessions` | 读取全部历史会话 |
| PUT | `/api/sessions` | 覆盖写入全部历史会话（事务） |
| GET | `/api/capsules` | 读取全部情绪胶囊 |
| PUT | `/api/capsules` | 覆盖写入全部情绪胶囊（事务） |
| POST | `/api/dify/chat-messages` | Dify 流式对话（SSE 透传） |
| GET | `/api/dify/parameters` | Dify 应用参数（取开场白） |
| GET | `/api/dify/conversations/:id/variables` | Dify 会话变量（取情绪类型/强度） |
| POST | `/api/deepseek/chat/completions` | DeepSeek 胶囊外观设计 |
| OPTIONS | `*` | CORS 预检（返回 204） |
| GET | `其他路径` | 静态文件；找不到返回 404 JSON |

### 3.4 密钥管理现状

`server.js` 顶部硬编码两个凭据（`DIFY_API_KEY`、`DEEPSEEK_API_KEY`），代理时使用；**前端源码中不含任何 key**（已自动断言校验）。这是"前端零 Key"的实现方式，但也是当前最主要的技术债，详见第 8 节。

---

## 4. 数据层：SQLite（WAL 模式）

**文件**：`mood.db`（实测头部为 `SQLite format 3`，另有 `mood.db-wal` / `mood.db-shm` 两个附属文件 → **WAL 日志模式已生效**，读写并发更友好）。数据库连接在 `server.js` 启动时创建：`new DatabaseSync(DB_PATH)` + `PRAGMA journal_mode = WAL`。

**建表语句（`server.js` 启动时 `CREATE TABLE IF NOT EXISTS`）**

```sql
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT,     -- Dify 会话 id，用于多轮续聊
  title           TEXT,     -- 会话标题（首条用户消息截断）
  messages        TEXT,     -- 消息数组的 JSON 字符串
  created_at      INTEGER,  -- 毫秒时间戳
  updated_at      INTEGER   -- 毫秒时间戳，用于历史列表排序
);

CREATE TABLE capsules (
  id            TEXT PRIMARY KEY,
  emotion_type  TEXT,       -- 情绪类型：开心/焦虑/悲伤…
  raw_intensity TEXT,       -- Dify 原始强度（0-10 字符串，保留原样）
  intensity     INTEGER,    -- 归一化强度（0-100 整数）
  level         TEXT,       -- 强度等级 key（如 calm / strong）
  level_text    TEXT,       -- 等级中文展示文案（与 SVG 内文字一致）
  color         TEXT,       -- 用户/推荐选中的主题色 #RRGGBB
  svg           TEXT,       -- 完整 SVG 字符串（直接存储，直接插入 DOM）
  farewell      TEXT,       -- 结束时 Dify 生成的道别语
  created_at    INTEGER
);
```

**设计取向**

- **单用户、无联表**：`messages` 存 JSON 串、`svg` 存整段 SVG 字符串，一次 `SELECT *` 就能渲染整个列表，读性能与实现复杂度都最优；
- **字段一一映射**：后端 `rowToSession` / `rowToCapsule` 负责 `snake_case` → `camelCase`，前端拿到的就是它直接使用的形状；
- **写入语义**：覆盖式（`BEGIN` → `DELETE` → 批量 `INSERT` → `COMMIT`），配合 WAL + 事务保证原子性；
- **ID 生成**：前端用 `uid(prefix)` 生成（时间戳 + 随机段），而非数据库自增，便于离线构造与前端本地去重。

---

## 5. AI 层：Dify 工作流 + DeepSeek

### 5.1 Dify DSL 概览（`mood-capsule-chatflow.yaml`）

| 项 | 值 |
|---|---|
| 应用类型 | `kind: app`、`mode: advanced-chat`（多轮对话工作流，非简单 Chatbot） |
| DSL 版本 | `version: 0.7.0` |
| 应用名 | Mood Capsule（图标 🧡，`dependencies: []`） |
| 用途 | 导入 Dify 平台后即得到完整的多轮情绪对话编排 |

**会话变量**（跨轮记忆，存于 Dify 会话侧）：

| 变量 | 含义 |
|---|---|
| `emotion_capsule` | 最近一次对话的情绪胶囊（一句话凝练核心情绪） |
| `last_emotion_type` | 最近一次对话的情绪类型（如「焦虑」） |
| `last_emotion_intensity` | 最近一次对话的情绪强度（0-10） |

**功能开关**：开场白 `你好呀，我是你的情绪树洞 Mood Capsule～想和我聊聊什么？`；文件上传、检索增强、敏感词规避、语音转写、TTS、追问建议**全部关闭**（轻量纯文本对话）。

### 5.2 节点与模型配置

| 节点（title / type） | 模型与温度 | 作用 |
|---|---|---|
| 开始 `start` | — | 接收用户输入，进入意图识别 |
| 意图识别 `llm` | deepseek-v4-flash，**temperature 0.1** | 只输出 `danger` / `end_chat` / `chat` 三选一 |
| 意图分支 `if-else` | — | 按上一步结果分流（危险 / 结束 / 正常聊天） |
| 危险干预 `llm` | deepseek-v4-flash，**0.7** | 危机场景的安全干预话术 |
| 危险回复清洗 `code` | `code_language: python3` | 清洗/规整危险回复文本 |
| 直接回复 `answer` ×3 | — | 三路分支的最终输出节点 |
| 情绪总结 `llm` | deepseek-v4-flash，**0.2** | 结束时输出严格 JSON：`{"emotion_type","intensity","farewell"}` |
| 情绪总结解析 `code`（`summary_code`） | python3 | 解析 JSON + **默认值兜底**（解析失败时回落「平静 / 0 / 感谢你的陪伴…」） |
| 写入总结变量 `assigner`（`summary_assigner`） | — | 把结果写入会话变量 `last_emotion_type` / `last_emotion_intensity` |
| 共情对话 `llm` | deepseek-v4-flash，**0.7** | 正常情绪倾诉的主对话回复 |
| 情绪胶囊存储 `code` | python3 | 生成/整理胶囊摘要文本 |
| 写入情绪胶囊 `assigner` | — | 写入会话变量 `emotion_capsule` |

**温度策略**：判定类节点低温（意图 0.1、总结 0.2）保证稳定可解析；生成类节点高温（干预/共情 0.7）保证共情表达自然。
**新增业务节点的成本很低**：改 yaml → 导入 Dify，前端不用动（前端只依赖少数事件与变量名）。

### 5.3 与前端的对接点

- **开场白**：`GET /api/dify/parameters` → `opening_statement`；
- **流式回复**：`POST /api/dify/chat-messages`（`response_mode: streaming`），前端逐块渲染；
- **结束对话**：前端发送约定指令（`END_QUERY`）触发 `end_chat` 分支；总结节点 `answer_summary` 输出 `{{#summary_code.farewell#}}` 作为道别语；
- **情绪数据**：优先从流中 `node_finished`（`summary_code` 节点）的 outputs 取；取不到则回退 `GET /api/dify/conversations/:id/variables` 读会话变量；
- **强度换算**：Dify 给 0–10，前端 `toPercent()` 换算为 0–100 展示，并同时保留原始值落库（`raw_intensity` / `intensity`）。

### 5.4 直连 DeepSeek 的场景与兜底

**唯一直接调用 DeepSeek 官方 API 的地方是「胶囊外观设计」**（不经过 Dify）：

1. `app.js` 的 `designPrompt()` 构造提示词，要求模型只返回 JSON（图标、装饰、配色倾向等）；
2. `POST /api/deepseek/chat/completions` → `server.js` 代理并**强制 `model: deepseek-chat`**；
3. `parseDesign()` 解析并按 `ICON_KEYS` / `DECORATION_KEYS` **白名单校验**，非法值丢弃；
4. `capsule.js` 的 `generateCapsuleSvg(emotionType, intensity, color, design)` 拼出最终 SVG。

**降级链路（三重兜底）**：请求失败 / **12 秒超时** / 返回无法解析 → 退回 `capsule.js` 的 `suggestDesign()` **本地规则设计**，保证断网或额度用尽时胶囊仍能生成，功能不中断。

---

## 6. 端到端数据流

### 6.1 应用启动

```
浏览器 GET /  → server.js serveStatic → index.html
             → styles.css / capsule.js / app.js（静态资源，同源）
app.js init() → bindEvents() → Promise.all([GET /api/sessions, GET /api/capsules])
             → renderHistory() + renderCapsules() → showView('historyView')
```

### 6.2 新建对话与流式回复

1. 点「开始新对话」→ `startNewChat()`：本地创建会话对象（`uid('s_')`）→ 切到 `chatView`；
2. `GET /api/dify/parameters` → 取 `opening_statement` 作为第一条助手消息（后端已缓存 Dify 开场白）；
3. 发送消息 → `sendMessage(q)`：本地先渲染用户气泡 → `POST /api/dify/chat-messages`，请求体：

```js
{ inputs: {}, query: q, response_mode: 'streaming', user: USER, conversation_id? }
```

4. `server.js` 注入 `Authorization: Bearer <DIFY_API_KEY>` 转发，`upRes.pipe(res)` 把 SSE 原样回吐；
5. 前端读流解析（`consume`）三类事件：

| SSE 事件 | 前端处理 |
|---|---|
| `message` | 累积 `answer` 文本 → `stripThinking()` 后写入气泡 → 记录 `conversation_id`（多轮续聊关键） |
| `node_finished` | 命中总结节点时抓取 `outputs`（情绪类型/强度/道别语） |
| `message_end` | 收尾，再次同步 `conversation_id` |

6. 本轮结束后 `PUT /api/sessions` 覆盖保存（消息数组 + `conversationId` + `updatedAt`）。

### 6.3 结束对话 → 情绪总结 → 胶囊草稿

```
点「结束对话」→ sendMessage(END_QUERY, { generateCapsule: true })
   ▼  Dify：意图识别（end_chat）→ 情绪总结 LLM → summary_code 解析 → summary_assigner 写入变量
   ▼         answer_summary 输出 {{#summary_code.farewell#}} 作为道别语
前端 prepareCapsule(farewell)
   ├─ 首选：流中 node_finished 抓到的 { emotion_type, intensity, farewell }
   └─ 回退：GET /api/dify/conversations/:id/variables → last_emotion_type / last_emotion_intensity
   ▼
toPercent(0-10 → 0-100) + recommendColors(emotionType) → openPreview()
```

### 6.4 配色 → AI 外观设计 → 保存胶囊

1. `openPreview()` 展示情绪、强度、道别语、推荐色板（「推荐」组 + 「更多」组），点色块或原生取色器改色 → `renderSwatches()`；
2. 请求外观设计：`POST /api/deepseek/chat/completions`（要求返回 JSON）→ 失败 / 12s 超时 → `MoodCapsule.suggestDesign()` 本地规则；
3. 点「保存这枚胶囊」→ `savePendingCapsule()`：`generateCapsuleSvg(emotionType, intensity, color, {...design, levelText})` 生成 SVG → push 进 `state.capsules` → `PUT /api/capsules` → Toast 提示 + 跳转胶囊墙 + `openDetail()`。

### 6.5 胶囊墙 / 详情 / 删除

- `renderCapsules()`：按创建时间排序渲染卡片网格（卡片内嵌落库的 SVG 字符串）+ 数量统计 + 空态；
- `openDetail(id)`：把 `capsuleDetail*` 全部字段（标题/副标题/SVG/情绪/等级/配色/强度/时间/道别语）一次填充；
- 删除：`askDeleteCapsule` → `openConfirm`（二级确认弹窗）→ 从数组移除 → `PUT /api/capsules`。

### 6.6 历史会话

- `renderHistory()`：按 `updatedAt` 倒序渲染标题、时间、末条消息预览；
- `openSession()`：回填全部消息，后续发送继续携带同一 `conversationId`（Dify 侧上下文连续）；
- 删除：`askDeleteSession` → `openConfirm` → 移除 → `PUT /api/sessions`。

---

## 7. 工程化与工具链现状

| 项 | 现状 |
|---|---|
| 依赖管理 | **无** `package.json` / lockfile / `node_modules` —— 真·零安装 |
| 启动方式 | `start_server.bat`：`where node` 检测 → 直接 `node server.js`，找不到则回退 `C:\Program Files\nodejs\node.exe`；`cd /d "%~dp0"` 锁定工作目录；结尾 `pause` 保留窗口 |
| 构建 | **无**，源码即产物（改完刷新浏览器） |
| 版本控制 | 已初始化 Git 仓库（分支 `main`）；`.gitignore` 排除 `.env` / `mood.db*` / `*.log` / `node_modules`（第 8.1 节的历史风险已修复） |
| 数据库文件 | `mood.db` + `mood.db-wal` + `mood.db-shm`（WAL 附带文件，需一并纳入忽略清单） |
| 测试 | 3 个手写 Node 脚本（本次新增，**非运行时依赖**） |
| 文档 | 本文件 `TECH_STACK.md`；AI 编排的唯一真源是 `mood-capsule-chatflow.yaml` |
| 历史原型 | `emotion_capsule_svg.py`（Python 版 SVG 生成器，含 `main()`）+ `emotion_capsule.svg` 样例输出；`capsule.js` 头部注释注明「与 `emotion_capsule_svg.py` 保持一致」→ 属参考实现，**不在运行时链路**（已确认无任何文件引用它） |

**验证脚本（开发用）**

| 脚本 | 作用 |
|---|---|
| `_mc_check.js` | 静态一致性：`app.js` 引用的 DOM id / class / `els.*` 是否都在 `index.html`、`styles.css` 中存在 |
| `_mc_smoke.js` | DOM + fetch 打桩，端到端跑真实 `app.js` + `capsule.js`（不触碰真实数据库），78 项断言 |
| `_mc_api_check.js` | 对运行中的 `server.js` 做**只读**接口契约检查（静态资源 200、字段形状、前端无 key） |

---

## 8. 技术债与改进建议（按优先级）

### 8.1 【已修复 · 2026-10-09】API Key 硬编码在源码 + 无 `.gitignore`

- 原现状：`server.js` 顶部直接写死 `DIFY_API_KEY`（`app-…`）与 `DEEPSEEK_API_KEY`（`sk-…`），项目目录内**没有 `.gitignore`**；
- 原风险：一旦把目录提交到公开仓库即等于凭据泄露（可被他人消耗额度/读写你的 Dify 应用）；
- **当前处理（三条建议全部落地）**：
  1. `server.js` 改为 `const KEY = process.env.XXX || ''`，并由新增的 `loadDotEnv()` 用内置 `process.loadEnvFile()` 读取根目录 `.env`（零第三方依赖，优先级：系统环境变量 > `.env`）；
  2. 新增 `.env.example`（模板）与 `.env`（本机真实值，**已被忽略**），`.gitignore` 覆盖 `.env`、`mood.db`、`mood.db-wal`、`mood.db-shm`、`*.log`、`node_modules/` 等；
  3. 缺失 Key 时**不阻塞启动**（静态页面与本地历史/胶囊仍可用）：启动日志打印缺失项，`/api/*` AI 路由返回 `503` + 可操作提示（前端已有兜底：开场白回退 `DEFAULT_OPENING`，胶囊外观回退本地规则）。
- **仍待人工完成**：到 Dify / DeepSeek 控制台**轮换这两个 key**（曾以明文形式存在于源码，应视为已失效）。

### 8.2 【中】数据写入是「整表覆盖」

- 现状：PUT 时为 `DELETE FROM xxx` + 批量 `INSERT`，前端每次保存都把全量数组发上去；
- 影响：同时开两个标签页操作会**互相覆盖**（后保存者胜）；数据量大后每次读写都是全量；
- 建议：保持 PUT 语义但对客户端更友好 —— 增加 `POST /api/sessions`（单条 upsert）与 `DELETE /api/sessions/:id`，前端改为增量调用；或引入 `updatedAt` 乐观锁检测冲突。

### 8.3 【中】数据库驱动依赖 Node 22.5+

- 现状：使用 `node:sqlite`（Node 22.5 起引入，本机 24.21.0 实测可用且**无需任何 flag**）；
- 影响：Node 20 及以下直接启动失败；
- 建议：`start_server.bat` 里加版本判断与提示文案，或在 README 首行写明「需要 Node 22.5+」。

### 8.4 【中】工作流模型名依赖 Dify 环境

- 现状：yaml 中所有 LLM 节点使用 `provider: deepseek` + `name: deepseek-v4-flash`；
- 影响：若你的 Dify 环境未接入该模型，导入后所有 LLM 节点会直接报错（而前端只会表现为「回复失败」）；
- 建议：换环境时先用 Dify 编排预览跑一次「意图识别」节点确认模型可用。

### 8.5 【低】无鉴权 + 仅回环监听

- 现状：`127.0.0.1:8000`，无 token；CORS 放开为 `*`；
- 影响：本机任意进程（含恶意网页通过本机请求）可调用 `/api/*`；风险可控但不严谨；
- 建议：若将来要手机/局域网访问，需加简单 token 校验并显式提示暴露风险（当前刻意只绑回环，是有意的最小暴露设计）。

### 8.6 【低】缺少工程入口

- 现状：无 `package.json`，3 个校验脚本散落在**上一级目录** `d:\ai-project\`；
- 建议：加一个仅含 `scripts` 的 `package.json`（`"test": "node tests/check.js && node tests/smoke.js"`），把脚本移入 `tests/`，开发体验更顺（不影响零依赖运行时）。

### 8.7 【低】单用户数据模型

- 现状：`sessions` / `capsules` 均无 `user_id` 字段；`localStorage` 里的 user id 只用于 Dify 会话隔离；
- 建议：若要支持多用户/多设备，需要加 `user_id` 维度（表结构 + 接口 + 前端过滤），属于架构级改动。

---

## 9. 附录

### 9.1 文件清单

| 文件 | 大小 | 角色 | 运行时必需 |
|---|---|---|---|
| `app.js` | 34.8 KB | 前端业务逻辑：状态、渲染、SSE 流式、情绪总结、胶囊流程 | ✅ |
| `capsule.js` | 22.2 KB | 前端纯 SVG 胶囊绘制引擎（`window.MoodCapsule`） | ✅ |
| `index.html` | 8.9 KB | 页面骨架，5 个视图容器 | ✅ |
| `styles.css` | 14.3 KB | 原生 CSS 主题与动画 | ✅ |
| `server.js` | 13.4 KB | 后端：静态文件 + 数据 API + AI 代理（含 `.env` 加载） | ✅ |
| `.env.example` | 1.1 KB | 环境变量模板（复制为 `.env` 后填 Key） | ➖ 首次配置 |
| `.env` | 0.2 KB | 本机真实密钥，**已被 `.gitignore` 忽略** | ➖ 本机私有 |
| `.gitignore` | 0.5 KB | 排除 `.env` / `mood.db*` / `*.log` / `node_modules/` | ➖ 版本控制 |
| `README.md` | 4.8 KB | 仓库首页说明：功能、快速开始、接口、安全 | ➖ 文档 |
| `start_server.bat` | 158 B | Windows 启动脚本（含 node 路径回退） | ➖ 便捷 |
| `mood.db` / `-wal` / `-shm` | ~293 KB | SQLite 数据库（WAL 模式，自动生成，**已被忽略**） | ✅ 自动创建 |
| `mood-capsule-chatflow.yaml` | 21.8 KB | Dify 工作流 DSL（云端编排的真源） | ➖ 云端必需 |
| `emotion_capsule_svg.py` | 6.1 KB | Python 版 SVG 生成器（原型/参考实现） | ❌ |
| `emotion_capsule.svg` | 2.0 KB | 早期样例产物 | ❌ |
| `AIPM面试讲解手册.md` | 49.7 KB | 产品视角讲解 / 面试准备手册 | ❌ |
| `TECH_STACK.md` | 27.9 KB | 本文档，技术栈说明 | ❌ |

### 9.2 复现验证命令

```powershell
# 1) 环境要求：Node.js >= 22.5（node:sqlite）
node --version

# 2) 语法检查（三个主文件）
cd "d:\ai-project\Mood Capsule"
node --check server.js ; node --check app.js ; node --check capsule.js

# 3) 首次运行：复制 .env.example 为 .env 并填入 DIFY_API_KEY / DEEPSEEK_API_KEY
Copy-Item .env.example .env    # .env 已被 .gitignore 忽略

# 4) 启动后端（或双击 start_server.bat），浏览器打开 http://127.0.0.1:8000
node server.js

# 5) 开发用校验脚本（位于上级目录）
cd d:\ai-project
node _mc_check.js       # 静态一致性：DOM id / class / els 声明
node _mc_smoke.js       # 端到端冒烟：78 项断言（内存后端，不写库）
node _mc_api_check.js   # 接口契约（需 server.js 正在运行；只读，不修改数据）
```

### 9.3 关键概念对照表

| 概念 | 前端 | 后端/存储 | AI 侧 |
|---|---|---|---|
| 会话 | `state.sessions` / `state.currentSession` | `sessions` 表（`messages` 为 JSON 串） | Dify `conversation_id` |
| 情绪胶囊 | `state.capsules` / `state.pendingCapsule` | `capsules` 表（含整段 `svg`） | 由 `emotion_type` + `intensity` 派生 |
| 情绪强度 | 展示 0–100（`toPercent`） | `raw_intensity`（原始 0-10）+ `intensity`（0-100） | 总结节点输出 0-10 整数 |
| 强度等级 | `level` / `levelText`（同时写入 SVG 与数据库） | `level` / `level_text` | — |
| 结束对话 | `END_QUERY` 常量（前端约定文案） | — | 意图识别判定 `end_chat` |
| 胶囊外观设计 | `design` 对象（图标/装饰/渐变） | 仅体现为最终 `svg` | DeepSeek `deepseek-chat` 返回 JSON；失败回退本地规则 |

### 9.4 一句话总结

Mood Capsule 是一套**刻意保持"零依赖、零构建"**的本地单用户应用：前端用原生 HTML/CSS/JS 手写状态渲染与 SSE 流式解析，图形用纯 SVG 字符串生成；后端由单个 `server.js` 用 Node 内置模块同时扮演静态服务器、SQLite 数据层与 AI 反向代理；业务大脑放在 Dify 工作流（DeepSeek 模型）中，外观设计则由 DeepSeek 官方 API 直接负责并带本地规则兜底。整个技术栈的取舍目标是：**双击即跑、凭据不出后端、离线也能降级出结果**。






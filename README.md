# Mood Capsule · 情绪树洞 & 情绪胶囊

一个**本地运行、单用户、零依赖、零构建**的情绪陪伴小应用：和一个会共情的 AI 对话，聊完之后它会把你此刻的情绪「封存」成一颗可视化的情绪胶囊，方便日后回看。

> 前端原生 HTML/CSS/JS，后端单文件 Node.js（仅用内置模块），数据落在本地 SQLite 文件里，模型能力通过 Dify 工作流 + DeepSeek 提供。
> 详细的逐文件技术说明见 [`TECH_STACK.md`](./TECH_STACK.md)；AI 编排真源是 [`mood-capsule-chatflow.yaml`](./mood-capsule-chatflow.yaml)（可直接导入 Dify）。

---

## 功能一览

| 功能 | 说明 |
|---|---|
| 情绪共情对话 | 通过 Dify 工作流做意图识别 + 共情回复，前端手写 SSE 解析实现打字机流式输出 |
| 情绪总结 | 对话结束时自动归纳情绪类型（如 焦虑/平静/喜悦）与强度（0–10 → 展示 0–100） |
| 情绪胶囊 | 由 DeepSeek 设计配色、图标与渐变，纯 SVG 字符串生成胶囊图形，并保存一句告别语 |
| 历史记录 | 会话与胶囊持久化在本地 `mood.db`（SQLite，WAL 模式） |
| 危机干预分支 | 工作流对高风险表达有独立引导路径（详见 `AIPM面试讲解手册.md` §11） |
| 降级兜底 | 模型不可用时胶囊外观回退本地规则；未配置 Key 时静态页面与本地历史仍可正常使用 |

---

## 环境要求

- **Node.js ≥ 22.5**（使用内置 `node:sqlite`，本机在 v24.21.0 实测通过）
  > `.env` 的自动加载依赖 `process.loadEnvFile()`（Node ≥ 20.12）；低版本请改用系统环境变量。
- 无需 `npm install`，**没有任何第三方依赖**，也没有构建步骤。

---

## 快速开始

1. **配置密钥**：把 `.env.example` 复制为 `.env`，填入你自己的 Key：

   ```bash
   # Windows PowerShell
   Copy-Item .env.example .env
   ```

   ```ini
   DIFY_API_KEY=app-xxxxxxxxxxxxxxxx
   DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx
   ```

   > `.env` 已被 `.gitignore` 忽略，**不会被提交**；真实密钥只存在于本机。
   > 优先级：系统环境变量 > `.env` 文件。

2. **启动服务**：

   ```bash
   node server.js
   # 或在 Windows 上直接双击 start_server.bat
   ```

3. **打开浏览器**：<http://127.0.0.1:8000>

> 只监听回环地址 `127.0.0.1`，服务不对外网暴露；数据库 `mood.db` 会在首次启动时自动创建。

---

## 接口一览

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/sessions` | 读取全部会话 |
| PUT | `/api/sessions` | 覆盖写入会话数组 |
| GET | `/api/capsules` | 读取全部情绪胶囊 |
| PUT | `/api/capsules` | 覆盖写入胶囊数组 |
| POST | `/api/dify/chat-messages` | 代理 Dify 流式对话（SSE 透传） |
| GET | `/api/dify/parameters` | 代理 Dify 开场白 |
| GET | `/api/dify/conversations/:id/variables` | 代理 Dify 会话变量 |
| POST | `/api/deepseek/chat/completions` | 代理 DeepSeek 胶囊外观设计 |

密钥只在后端注入，**前端不持有任何 Key**；未配置的 Key 对应接口会返回 `503` 与配置提示。

---

## 目录结构

```
.
├─ index.html                 页面骨架（5 个视图容器）
├─ styles.css                 原生 CSS 主题与动画
├─ capsule.js                 纯 SVG 情绪胶囊绘制引擎（window.MoodCapsule）
├─ app.js                     前端业务逻辑：状态 / 渲染 / SSE 流式解析
├─ server.js                  后端：静态服务 + SQLite 数据层 + AI 反向代理
├─ start_server.bat           Windows 一键启动
├─ mood-capsule-chatflow.yaml Dify 工作流 DSL（意图识别 / 共情对话 / 情绪总结）
├─ .env.example               环境变量模板（复制为 .env 使用）
├─ TECH_STACK.md              技术栈与架构说明
├─ AIPM面试讲解手册.md         项目讲解 / 面试准备手册
├─ emotion_capsule_svg.py     Python 版 SVG 生成器（早期原型，不在运行时链路）
└─ emotion_capsule.svg        早期原型样例输出
```

---

## 安全说明

- 源码中**不含任何密钥**，全部通过环境变量注入；`.env`、`mood.db*`、日志与依赖目录均已在 `.gitignore` 中排除。
- 服务仅绑定 `127.0.0.1`，无鉴权设计，适合个人本机使用；如需局域网/公网访问，请自行增加鉴权与传输加密。
- 对话与胶囊数据均保存在本地 `mood.db`，删除该文件即清空全部数据。

---

## 文档

- [`TECH_STACK.md`](./TECH_STACK.md)：技术栈、架构、接口契约与技术债分析（逐文件通读撰写）。
- [`AIPM面试讲解手册.md`](./AIPM面试讲解手册.md)：产品视角的项目讲解、指标体系与高频问答。

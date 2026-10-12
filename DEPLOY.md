# Mood Capsule 上线手册 · Netlify（前端）+ Render（后端）

把原本「本机运行」的项目部署成两个平台上的公网服务：

```
浏览器
  │ ① 加载静态页面（index.html / styles.css / app.js / capsule.js / config.js）
  ▼
Netlify   https://<your-site>.netlify.app        ← 前端：纯静态、零构建
  │ ② 跨域 fetch（地址来自 config.js 的 apiBase；前端不持有任何密钥）
  ▼
Render    https://<your-service>.onrender.com    ← 后端 server.js：数据 + AI 代理
  ├─► api.dify.ai        共情对话 / 开场白 / 会话变量
  └─► api.deepseek.com   胶囊外观设计
```

> **为什么不用 Netlify 的 `/api/*` 反向代理来避开跨域？**
> 因为 Netlify 的代理重写会在 **26 秒**后超时（官方文档写明此限制），而本项目的对话是 SSE 长连接，
> 一旦超时打字机流式输出就会被掐断。所以采用「前端直连 Render + CORS 白名单」的方案。

---

## 0. 上线前必须知道的三件事

| 事项 | 结论 | 本仓库的应对 |
|---|---|---|
| Node 版本 | `node:sqlite` 免 `--experimental-sqlite` 需 **≥ 22.13**；Render 当前默认 **24.21.0** | `package.json` 的 `engines` 声明 `>=22.13 <25.0.0`，`render.yaml` 再显式写 `NODE_VERSION` |
| 免费实例会休眠 | 15 分钟无请求即休眠，下次访问冷启动约 **1 分钟** | 首次打开慢属正常；需要常驻就升级付费实例 |
| 免费实例磁盘是临时的 | 重启 / 重新部署 / 休眠后 `mood.db` **会清空** | 演示可接受；要长期保存见 §9 |

---

## 1. 本地自测（先确认代码本身没问题）

```powershell
cd "d:\ai-project\Mood Capsule"

# 1) 语法检查（改了代码就先跑这个）
node --check server.js ; node --check app.js ; node --check capsule.js ; node --check config.js

# 2) 启动后端（保持这个窗口开着）
node server.js
```

另开一个窗口验证：

```powershell
# 健康检查：应返回 ok=True，且 aiKeys 两项都为 True
Invoke-RestMethod http://127.0.0.1:8000/healthz | ConvertTo-Json -Depth 4
```

启动日志应显示 `监听：http://127.0.0.1:8000`（本地不会出现「云平台模式」字样）。
浏览器打开 <http://127.0.0.1:8000>，确认能对话、能生成胶囊。**这一步通过再往下走。**

---

## 2. 推到 GitHub

```powershell
cd "d:\ai-project\Mood Capsule"
git status --short          # 确认列表里没有 .env / mood.db*
git add .
git commit -m "chore: 支持 Netlify + Render 分离部署（CORS / PORT / 健康检查 / 运行时配置）"
git push origin main
```

> 若 `git status` 里出现 `.env` 或 `mood.db*`，说明它们被误加入暂存区：先 `git rm --cached .env mood.db`，确认 `.gitignore` 生效后再提交。

---

## 3. Render：部署后端

### 方式 A：Blueprint（读 `render.yaml`，最省事）

1. 登录 <https://dashboard.render.com> → 右上角 **New +** → **Blueprint**
2. 选择仓库 `mood-capsule` → Render 自动识别根目录的 `render.yaml`
3. 弹出环境变量填写框，按 §3.1 填写（`CORS_ORIGIN` 可先留空，第 6 步再收紧）
4. 点 **Apply** → 等待构建完成（约 1–3 分钟）

### 方式 B：手动创建 Web Service

1. **New +** → **Web Service** → 选择仓库 `mood-capsule`
2. 按下表填写：

| 字段 | 值 |
|---|---|
| Name | `mood-capsule-api`（决定域名，如 `https://mood-capsule-api.onrender.com`） |
| Language / Runtime | `Node` |
| Branch | `main` |
| Root Directory | 留空 |
| Build Command | `npm install` |
| Start Command | `node server.js` |
| Instance Type | `Free` |
| Health Check Path | `/healthz` |

3. 展开 **Advanced → Environment Variables**，按 §3.1 添加变量，然后 **Create Web Service**。

### 3.1 环境变量清单（后端）

| Key | 必填 | 值 |
|---|---|---|
| `DIFY_API_KEY` | ✅ | `app-xxxxxxxx`（Dify 应用 API Key） |
| `DEEPSEEK_API_KEY` | ✅ | `sk-xxxxxxxx`（DeepSeek API Key） |
| `CORS_ORIGIN` | 强烈建议 | 前端域名，如 `https://mood-capsule.netlify.app`；多个用英文逗号分隔。留空 = 允许所有来源（`*`），启动日志会给出安全提示 |
| `NODE_VERSION` | 建议 | `24.21.0`（不写也通常是 24.x，显式声明避免平台升级带来意外） |

> ⚠️ 密钥只放在 Render 的环境变量里，**不要**写进 `config.js`、不要提交到仓库、也不要放进 Netlify。
> ⚠️ **不要**在 Render 上手动设置 `PORT`：平台会自动注入端口，`server.js` 只有在检测到 `PORT` 时才监听 `0.0.0.0`。

## 4. 验证后端（拿到地址后立刻验一遍）

构建完成后 Render 会给出服务地址，例如 `https://mood-capsule-api.onrender.com`。

```powershell
# 换成你自己的 Render 地址（不要带末尾斜杠）
$api = 'https://mood-capsule-api.onrender.com'

# 1) 健康检查
Invoke-RestMethod "$api/healthz" | ConvertTo-Json -Depth 4
# 期望：ok=True；aiKeys.dify=True；aiKeys.deepseek=True；database.ready=True
# （冷启动时第一次请求可能要等 1 分钟左右）

# 2) 数据接口（新库应为空数组）
Invoke-RestMethod "$api/api/sessions" | ConvertTo-Json

# 3) 看 CORS 头（此时未配置白名单，应回显 *）
(Invoke-WebRequest "$api/healthz" -Headers @{ Origin = 'https://example.com' }).Headers['Access-Control-Allow-Origin']
```

`/healthz` 永远返回 `200`（它只报告状态，方便平台探测）；当它显示 `aiKeys` 为 `False` 时，说明环境变量没生效 → 检查变量名拼写 → **Manual Deploy → Deploy latest commit** 重启服务。
此时 `/api/dify/*`、`/api/deepseek/*` 会返回 `503`，错误信息里会写明缺的是哪个变量。

---

## 5. Netlify：部署前端

1. 登录 <https://app.netlify.com> → **Add new site** → **Import an existing project**
2. 选 **GitHub** → 授权 → 选中 `mood-capsule` 仓库
3. 构建设置（仓库里已有 `netlify.toml`，保持默认即可）：

| 字段 | 值 |
|---|---|
| Branch to deploy | `main`（默认） |
| Base directory | 留空 |
| Build command | 留空（`package.json` 没有 `build` 脚本，无需构建） |
| Publish directory | `.`（已写在 `netlify.toml`，Dashboard 里留空也行） |

4. 点 **Deploy** → 得到 `https://<随机名>.netlify.app`
   （可在 **Site configuration → Change site name** 改成好记的名字，比如 `mood-capsule-xxx`）
5. 此时打开站点只会看到「历史对话读取失败」的提示 —— 因为还没指向后端，继续第 6 步。

> ⚠️ **不要用「拖拽文件夹」的方式部署**：那会把 `mood.db` 等本地文件一起传到公网。
> 用 Git 导入的方式，`.gitignore` 里的 `.env` / `mood.db*` 不会被发布。

---

## 6. 把 Netlify 与 Render 接起来（关键一步）

### 6.1 前端 → 后端：填 `config.js`

```js
// config.js
window.MOOD_CAPSULE_CONFIG = {
  apiBase: 'https://mood-capsule-api.onrender.com',   // ← 换成你的 Render 地址，末尾不要加 /
};
```

推送后 Netlify 会自动重新部署（约 10 秒）：

```powershell
git add config.js
git commit -m "chore: 前端指向 Render 后端"
git push origin main
```

刷新 Netlify 站点即可正常对话。

### 6.2 后端 → 前端：收紧 `CORS_ORIGIN`（安全必做）

回到 Render → 你的服务 → **Environment** → 把 `CORS_ORIGIN` 改为 Netlify 域名：

```text
CORS_ORIGIN=https://mood-capsule.netlify.app
```

保存后触发一次重新部署（改环境变量会自动重启）。自测：

```powershell
$api = 'https://mood-capsule-api.onrender.com'

# 白名单内的前端域名 → 应回显这个 Origin
(Invoke-WebRequest "$api/healthz" -Headers @{ Origin = 'https://mood-capsule.netlify.app' }).Headers['Access-Control-Allow-Origin']

# 其它域名 → 不应出现该响应头（浏览器会拦下，避免别人白嫖你的模型额度）
(Invoke-WebRequest "$api/healthz" -Headers @{ Origin = 'https://evil.example.com' }).Headers['Access-Control-Allow-Origin']
```

> 配了自定义域名后记得补上，例如：
> `CORS_ORIGIN=https://mood-capsule.netlify.app,https://mood.yourdomain.com`
> 另外可以再给 Netlify 加自定义域名（Domain management → Add domain），Netlify 会自动签发 HTTPS 证书。

---

## 7. 验收清单（全部勾上即上线成功）

- [ ] `GET /healthz` 返回 `ok: true`，`aiKeys` 两项均为 `true`
- [ ] `GET /.env`、`GET /mood.db` 返回 `403`（敏感文件不通过 HTTP 暴露）
- [ ] Netlify 站点打开后控制台没有 CORS 报错
- [ ] 发一条消息能**逐字**出现（打字机效果正常 → 说明 SSE 没被中间层缓冲）
- [ ] 点「结束对话 · 生成胶囊」能出现情绪总结与配色界面
- [ ] 保存后能在「我的胶囊」里打开详情并删除
- [ ] 刷新页面后历史对话与胶囊仍在（同一实例存活期内）
- [ ] DevTools → Network 里请求地址都是 `https://xxx.onrender.com/api/...`

## 8. 常见问题排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 控制台报 `blocked by CORS policy` | `CORS_ORIGIN` 没包含当前前端域名（必须是带 `https://` 的完整域名、不能带路径） | 补全后重启 Render 服务 |
| 页面提示「未配置后端地址」 | `config.js` 的 `apiBase` 仍为空，且当前不在 localhost | 按 §6.1 填好并推送 |
| 接口返回 `503`「未配置 DIFY_API_KEY / DEEPSEEK_API_KEY。请在托管平台的 Environment 面板中补齐该变量后重新部署」 | Render 环境变量缺失或拼错 | 补齐后重新部署 |
| 访问 `https://xxx.onrender.com/mood.db` 或 `/.env` 返回 `403` | 内置拦截：数据库、点文件不通过 HTTP 暴露 | 属正常保护，无需处理 |
| 历史对话/胶囊读取失败（`HTTP 404`） | `apiBase` 写错域名，或末尾多写 `/`，或误写成 `.../api` | 只填站点根地址，如 `https://mood-capsule-api.onrender.com` |
| 首次打开白屏转圈约 1 分钟 | 免费实例休眠后的冷启动 | 正常现象；介意可升级实例，或用定时任务定期请求 `/healthz` |
| 回复不是逐字出现，而是整段蹦出 | 中间多了一层做缓冲的代理（如自建 CDN / 又套了 Netlify 代理） | 保持「前端直连 Render」，不要加 Netlify 代理层 |
| 重新部署后历史对话、胶囊清空 | 免费实例磁盘是临时的 | 见 §9 |
| 启动即报错找不到 `node:sqlite` | 运行时 Node < 22.13 | 设 `NODE_VERSION=24.21.0` 后重新部署 |
| Netlify 站点里能下载到 `server.js`、`DEPLOY.md` | `publish = "."` 会发布仓库根目录里所有已提交文件 | 无密钥泄露风险；介意可把前端挪到 `public/` 目录并把 `publish` 改成 `public`（同时要改 `server.js` 的静态目录） |
| Netlify 构建日志提示 `npm install` 失败 | 一般不会发生（零依赖）；若发生请检查是否断网/私有 registry 配置 | 本项目无依赖，可忽略该步骤 |

---

## 9. 数据持久化（免费实例的取舍）

| 方案 | 成本 | 数据能否保留 | 说明 |
|---|---|---|---|
| 保持现状（免费实例） | 免费 | ❌ 重启/重新部署/休眠即清空 | 适合演示；Dify 侧的历史会话不受影响，只丢本地两张表 |
| Render 持久化磁盘 | 付费实例，约 \$7/月起 | ✅ | 加 **Disk**（mount path 例 `/var/data`），再加环境变量 `DATA_DIR=/var/data`；注意挂盘后该服务不再支持零停机部署 |
| 迁移到 Render Postgres | 免费库 **30 天后过期** | ✅（付费库长期） | 需把 `server.js` 的数据层从 `node:sqlite` 换成 Postgres 驱动，属架构级改动 |
| 改存浏览器（localStorage / IndexedDB） | 免费 | ⚠️ 只在本机浏览器 | 需改前端存储层，多设备不同步 |

> 提示：`server.js` 已经支持 `DATA_DIR`，换成磁盘只需「加 Disk + 加一个环境变量」，代码不用动。

---

## 10. 后续更新流程

```powershell
# 改完代码
git add . ; git commit -m "feat: xxx" ; git push origin main
```

- Render 与 Netlify 都开启了自动部署：推送后两边各自重新构建（前端约 10 秒，后端约 1–3 分钟）
- 只改后端环境变量：Render → **Environment** → 保存 → 自动重启
- 只改前端后端地址：改 `config.js` → 推送（Netlify 生效，Render 无需动）
- 出问题回滚：Render → **Rollback**（可选最近两次部署）；Netlify → **Deploys** → 选中旧版本 → **Publish deploy**

---

## 11. 速查表

| 项目 | 值 |
|---|---|
| 前端平台 | Netlify（`publish = "."`，无构建，配置文件 `netlify.toml`） |
| 后端平台 | Render Web Service（`runtime: node`，`node server.js`，配置见 `render.yaml`） |
| 后端健康检查 | `GET /healthz`（返回 Key 是否配置、数据目录、CORS 模式） |
| 前端指向后端 | `config.js` → `window.MOOD_CAPSULE_CONFIG.apiBase` |
| 跨域白名单 | Render 环境变量 `CORS_ORIGIN`（逗号分隔多个域名；不设置等于 `*`） |
| 数据目录 | Render 环境变量 `DATA_DIR`（默认与 `server.js` 同目录） |
| 端口/监听 | 平台注入 `PORT` 时自动监听 `0.0.0.0`；本地固定 `127.0.0.1:8000` |
| 密钥 | 仅存于 Render 环境变量：`DIFY_API_KEY` / `DEEPSEEK_API_KEY` |



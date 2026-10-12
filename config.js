/* ============================================================
 * Mood Capsule 运行时配置（浏览器端，**请勿在此写入任何密钥**）
 * ------------------------------------------------------------
 * apiBase：后端服务地址
 *   · 本地开发（node server.js 后访问 http://127.0.0.1:8000）→ 留空 ''，走同源相对路径
 *   · 前端部署在 Netlify、后端部署在 Render → 填 Render 服务地址（末尾不要加 /）
 *       例：window.MOOD_CAPSULE_CONFIG = { apiBase: 'https://mood-capsule-api.onrender.com' };
 *   · 本文件改动后提交推送，Netlify 会自动重新部署
 * 注意：这里只能写「服务地址」，不是密钥；DIFY_API_KEY / DEEPSEEK_API_KEY 只放在后端环境变量里。
 * ============================================================ */
window.MOOD_CAPSULE_CONFIG = {
  apiBase: '',
};
'use strict';
/**
 * PM2 配置（自建服务器用，例如阿里云 Ubuntu；托管平台 Netlify / Render 不需要本文件）
 * ---------------------------------------------------------------------------
 * 用法（在项目根目录执行）：
 *   pm2 delete mood-capsule-api        # 先删掉可能存在的旧定义（旧的 cwd / env 会残留在 ~/.pm2/dump.pm2 里）
 *   pm2 start ecosystem.config.js      # 启动，进程名固定为 mood-capsule-api
 *   pm2 save                           # 保存进程列表
 *   pm2 startup                        # 生成开机自启脚本（按提示复制执行那行 sudo 命令）
 *   pm2 logs mood-capsule-api --lines 50   # 看启动日志（会打印「监听 / .env / 配置来源」三行）
 *
 * 为什么锁定 interpreter：
 *   项目使用内置 node:sqlite，它要求「实际运行 server.js 的那个 node」>= 22.5（>= 22.13 默认可用，
 *   22.5–22.12 需 --experimental-sqlite；18.x / 20.x 根本没有这个模块）。
 *   而 PM2 按 PATH 解析 node：shell 里 nvm 明明是 22.x，fork 出来的进程却可能是 apt 装的旧版
 *   （/usr/bin/node 18.x）→ 启动即崩（ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite）
 *   + 无限重启 + 端口毫无监听，看起来像「端口/防火墙」问题，其实与端口无关。
 *   这里用 interpreter 把解释器锁成「执行 pm2 start 的那个 node」（process.execPath），
 *   所以启动前请先 `nvm use 22`（或确保 PATH 里的 node 就是你要的那个）；下方还会校验版本，不达标直接报错。
 *
 * 为什么要设 node_args：
 *   Node 22.5–22.12 与 23.0–23.3 需要 --experimental-sqlite；>= 22.13 与 >= 23.4 默认可用。
 *   下面按版本自动决定是否追加，省得「新老 Node 共用一份配置」时还要手改。
 *
 * 为什么不在这里写 PORT / HOST：
 *   系统的环境变量优先级高于项目根目录的 .env（loadEnvFile 不覆盖已有变量），
 *   一旦写进 PM2 的 env 段，之后改 .env 就会「改了不生效」。所以端口与监听地址统一交给 .env 管理。
 *   确实需要用环境变量覆盖时，再放开下面注释掉的 env 段，并执行：
 *     pm2 restart mood-capsule-api --update-env
 */
// node:sqlite 的可用性（只看实际运行 server.js 的 node）：
//   < 22.5            → 没有该模块（如 apt 的 18.x / 20.x），必须换 node
//   22.5–22.12、23.0–23.3 → 需要 --experimental-sqlite
//   >= 22.13、>= 23.4    → 默认可用
const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split('.').map(Number);
const HAS_SQLITE = NODE_MAJOR >= 23 || (NODE_MAJOR === 22 && NODE_MINOR >= 5);
const NEED_SQLITE_FLAG = (NODE_MAJOR === 22 && NODE_MINOR >= 5 && NODE_MINOR < 13)
  || (NODE_MAJOR === 23 && NODE_MINOR < 4);

// 版本不达标就别让 PM2 反复重启了：直接报错说清怎么修（这条信息会显示在 pm2 start 的输出里）
if (!HAS_SQLITE) {
  throw new Error('[ecosystem] 当前 node（' + process.version + '）没有内置模块 node:sqlite，应用无法启动。\n'
    + '  请先切到 Node >= 22.13（如 `nvm use 22`，或把系统 node 升级到 22.13+），再执行：\n'
    + '    pm2 delete mood-capsule-api && pm2 start ecosystem.config.js\n'
    + '  自检：`node -e "require(\'node:sqlite\')"` 不报错才说明这个 node 可用。');
}

const app = {
  name: 'mood-capsule-api',
  script: 'server.js',
  // 关键：把解释器锁定为「执行 pm2 start 的那个 node」，不再让 PM2 按 PATH 去猜
  // （PATH 里可能是 /usr/bin/node 18.x —— 那正是 node:sqlite 报「模块不存在」的元凶）
  interpreter: process.execPath,
  cwd: __dirname,            // 必须是项目根目录：静态文件（index.html/app.js…）按脚本目录读取
  instances: 1,              // 单实例：SQLite 单文件 + 固定端口
  exec_mode: 'fork',         // 不要用 cluster（多实例会抢同一个端口，报 EADDRINUSE）
  autorestart: true,
  max_restarts: 10,
  restart_delay: 2000,
  env: {
    NODE_ENV: 'production',
    // PORT: '8123',                      // 想用环境变量覆盖 .env 时放开（不推荐，容易和 .env 打架）
    // HOST: '0.0.0.0',
    // DATA_DIR: '/root/mood-capsule/data',
    // CORS_ORIGIN: 'https://xxx.netlify.app',
  },
};

// Node 22.5–22.12 / 23.0–23.3 不加这个参数会「启动即崩、端口无监听」，日志里是 No such built-in module: node:sqlite
if (NEED_SQLITE_FLAG) app.node_args = '--experimental-sqlite';

console.log('[ecosystem] 解释器 = %s（%s）%s', process.execPath, process.version,
  NEED_SQLITE_FLAG ? '，已追加 --experimental-sqlite' : '，node:sqlite 默认可用');

module.exports = { apps: [app] };

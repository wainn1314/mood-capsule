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
 * 为什么不在这里写 PORT / HOST：
 *   系统的环境变量优先级高于项目根目录的 .env（loadEnvFile 不覆盖已有变量），
 *   一旦写进 PM2 的 env 段，之后改 .env 就会「改了不生效」。所以端口与监听地址统一交给 .env 管理。
 *   确实需要用环境变量覆盖时，再放开下面注释掉的 env 段，并执行：
 *     pm2 restart mood-capsule-api --update-env
 */
module.exports = {
  apps: [
    {
      name: 'mood-capsule-api',
      script: 'server.js',
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
    },
  ],
};

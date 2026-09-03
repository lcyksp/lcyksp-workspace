// lcyksp-backend/ecosystem.config.cjs — PM2 生产守护配置
// 使用方式: npx pm2 start ecosystem.config.cjs

/* eslint-env node */
module.exports = {
  apps: [
    {
      name: 'lcyksp-backend',
      script: 'src/app.js',

      // ---------- 环境变量 ----------
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        // 安全必填：生产环境必须设置强随机 JWT_SECRET（至少 16 字符），否则后端拒绝启动。
        // 生成方式: openssl rand -hex 32
        // JWT_SECRET: 'REPLACE_WITH_RANDOM_64_HEX',
      },

      // ---------- 进程管理 ----------
      instances: 1,                // SQLite3 不适合多进程，单实例
      exec_mode: 'fork',
      max_memory_restart: '500M',  // 超过 500MB 自动重启
      autorestart: true,           // 崩溃自动重启
      exp_backoff_restart_delay: 1000, // 指数退避重启避开风暴
      min_uptime: '10s',           // 最少运行 10s 才算成功启动

      // ---------- 日志 ----------
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,

      // ---------- 关闭守护 ----------
      kill_timeout: 5000,          // 强制关闭等待 5s
      shutdown_with_message: true,
    },
  ],
};

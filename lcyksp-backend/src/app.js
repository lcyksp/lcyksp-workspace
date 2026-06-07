import express from 'express';
import { initDb } from './config/db.js';
import transmitRouter from './routes/transmit.js';
import compressRouter from './routes/compress.js';
import convertRouter from './routes/convert.js';
import authRouter from './routes/auth.js';
import galleryRouter from './routes/gallery.js';
import adminRouter from './routes/admin.js';
import recipeRouter from './routes/recipe.js';
import videoRouter from './routes/video.js';
import { startCron } from './utils/cron.js';

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- 基础中间件 ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS — 允许前端 lcyksp.xyz 及其所有子域名，并在云端放行公网 IP
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && /^https?:\/\/([a-z0-9-]+\.)*lcyksp\.xyz(:[0-9]+)?$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- 路由挂载 ----------
app.use('/api/transmit', transmitRouter);
app.use('/api/compress', compressRouter);
app.use('/api/convert', convertRouter);
app.use('/api/auth', authRouter);
app.use('/api/gallery', galleryRouter);
app.use('/api/admin', adminRouter);
app.use('/api/recipe', recipeRouter);
app.use('/api/video', videoRouter);

// 健康检查
app.get('/api/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ---------- 全局 404 ----------
app.use((_req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// ---------- 全局异常捕获 ----------
app.use((err, _req, res, _next) => {
  console.error('[全局异常]', err);
  res.status(err.status || 500).json({
    error: err.message || '服务器内部错误',
  });
});

// ---------- 启动 ----------
async function bootstrap() {
  console.log('🔄 正在初始化数据库...');
  await initDb();
  console.log('✅ 数据库初始化成功！');
  startCron();
  
  // 监听所有网卡接口，确保 Nginx 代理能打进来
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 lcyksp-backend 已成功常驻 → http://0.0.0.0:${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error('❌ 启动失败（请检查 sqlite 依赖是否在本地编译好）:', err);
  process.exit(1);
});

export default app;
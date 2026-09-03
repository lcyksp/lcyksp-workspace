import express from 'express';
import helmet from 'helmet';
import { initDb } from './config/db.js';
import { imageJobGate } from './utils/imageGuard.js';
import { globalLimiter, authLimiter, heavyLimiter } from './middleware/rateLimit.js';
import transmitRouter from './routes/transmit.js';
import compressRouter from './routes/compress.js';
import convertRouter from './routes/convert.js';
import authRouter from './routes/auth.js';
import galleryRouter from './routes/gallery.js';
import adminRouter from './routes/admin.js';
import recipeRouter from './routes/recipe.js';
import videoRouter from './routes/video.js';
import feedbackRouter from './routes/feedback.js';
import membershipRouter from './routes/membership.js';
import tvRouter from './routes/tv.js';
import stitchRouter from './routes/stitch.js';
import lyricsRouter from './routes/lyrics.js';
import trendsRouter from './routes/trends.js';
import apexRouter from './routes/apex.js';
import githubSubscriptionsRouter from './routes/githubSubscriptions.js';
import algsRouter from './routes/algs.js';
import { startCron } from './utils/cron.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Nginx 是唯一的前置代理，它用 proxy_add_x_forwarded_for 把真实 remote_addr 追加在 XFF 末尾。
// 不设这个，req.ip 永远是 127.0.0.1，所有人共用一个限流桶，限流等于没有。
app.set('trust proxy', 1);

// helmet：CSP 交给 Nginx（Express 只回 JSON 和文件流，加 CSP 没意义还容易踩坑）；
// HSTS 也交给 Nginx —— 在这里开一旦 HTTPS 出问题会把用户锁死在无法访问的状态。
app.use(helmet({
  contentSecurityPolicy: false,
  hsts: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Transmit-Password');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- 限流 ----------
// OPTIONS 已在上面短路返回，不会计入配额。
app.use('/api', globalLimiter);

// ---------- 路由挂载 ----------
// 说明：/api/video 和 /api/tv 不在前缀上挂 heavyLimiter —— 它们下面有 3 秒一次的
// 下载进度轮询和逐张图片预览，按 20 次/分钟会直接把正常功能掐死。
// 这两个路由的重接口在各自文件里单独挂。
app.use('/api/transmit', transmitRouter);
app.use('/api/compress', heavyLimiter, imageJobGate, compressRouter);
app.use('/api/convert', heavyLimiter, convertRouter);
app.use('/api/auth', authLimiter, authRouter);
app.use('/api/gallery', galleryRouter);
app.use('/api/admin', adminRouter);
app.use('/api/recipe', recipeRouter);
app.use('/api/video', videoRouter);
app.use('/api/feedback', feedbackRouter);
app.use('/api/membership', membershipRouter);
app.use('/api/tv', tvRouter);
app.use('/api/stitch', heavyLimiter, imageJobGate, stitchRouter);
app.use('/api/lyrics', lyricsRouter);
app.use('/api/trends', trendsRouter);
app.use('/api/apex', apexRouter);
app.use('/api/github-subscriptions', githubSubscriptionsRouter);
app.use('/api/algs', algsRouter);

// IP归属地查询接口
app.get('/api/ip-lookup', async (req, res) => {
  try {
    let queryIp = req.query.ip || '';
    if (!queryIp) {
      const xForwardedFor = req.headers['x-forwarded-for'];
      if (xForwardedFor) {
        queryIp = xForwardedFor.split(',')[0].trim();
      } else {
        queryIp = req.headers['x-real-ip'] || req.socket.remoteAddress || '';
      }
    }
    
    if (queryIp.startsWith('::ffff:')) {
      queryIp = queryIp.substring(7);
    }
    
    if (queryIp === '::1' || queryIp === '127.0.0.1' || queryIp === 'localhost') {
      return res.json({
        ipAddress: queryIp,
        ipVersion: 4,
        countryName: '本地局域网',
        regionName: '环回地址',
        cityName: '-',
        zipCode: '-',
        asnOrg: '-',
        latitude: 0,
        longitude: 0,
        isProxy: false
      });
    }

    const response = await fetch(`http://ip-api.com/json/${queryIp}?lang=zh-CN`);
    const data = await response.json();

    if (data.status === 'fail') {
      return res.json({
        ipAddress: queryIp,
        ipVersion: queryIp.includes(':') ? 6 : 4,
        countryName: '未知物理位置',
        regionName: '-',
        cityName: '-',
        zipCode: '-',
        asnOrg: '-',
        latitude: 0,
        longitude: 0,
        isProxy: false
      });
    }

    res.json({
      ipAddress: data.query,
      ipVersion: data.query.includes(':') ? 6 : 4,
      countryName: data.country || '-',
      regionName: data.regionName || '-',
      cityName: data.city || '-',
      zipCode: data.zip || '-',
      asnOrg: data.isp || data.org || '-',
      latitude: data.lat || 0,
      longitude: data.lon || 0,
      isProxy: false
    });
  } catch (err) {
    console.error('IP lookup error:', err);
    res.status(500).json({ error: 'IP归属地查询失败' });
  }
});

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

// ---------- 进程安全监控 ----------
let httpServer = null;
let shuttingDown = false;

/**
 * uncaughtException 之后进程状态已经不可信（可能有请求停在一半、句柄没关、锁没释放）。
 * 之前这里只 console.error 不退出，结果 transmit.js 那个 ReferenceError 被静默吞了半年，
 * 「阅后即焚」一直是坏的却没人知道。现在改成记录后退出，交给 PM2 重启
 * （ecosystem.config.cjs 已配 exp_backoff_restart_delay 和 min_uptime，不会重启风暴）。
 */
function fatalExit(label, err) {
  console.error(`[${label}]`, err?.stack || err);
  if (shuttingDown) return;
  shuttingDown = true;
  if (httpServer) {
    httpServer.close(() => process.exit(1));
  }
  // 兜底：3 秒内没关干净就硬退，别把进程卡在半死状态
  setTimeout(() => process.exit(1), 3000).unref();
}

// unhandledRejection 只记录不退出：Express 4 不接管 async 处理器抛出的异常，
// 一个请求里漏了 try/catch 就会走到这里，为此杀进程等于把 bug 变成自伤式 DoS。
process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason?.stack || reason);
});

process.on('uncaughtException', (err) => fatalExit('Uncaught Exception', err));

// PM2 reload / kill 时优雅关闭，别让正在传的大文件直接断
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${sig}] 正在关闭 HTTP 服务...`);
    if (httpServer) httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 4500).unref();
  });
}

// ---------- 启动 ----------
async function bootstrap() {
  console.log('🔄 正在初始化数据库...');
  await initDb();
  console.log('✅ 数据库初始化成功！');
  startCron();

  // 监听所有网卡接口，确保 Nginx 代理能打进来
  httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 lcyksp-backend 已成功常驻 → http://0.0.0.0:${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error('❌ 启动失败:', err);
  process.exit(1);
});

export default app;

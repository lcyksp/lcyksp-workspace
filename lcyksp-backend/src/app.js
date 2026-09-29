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
import siteMonitorRouter from './routes/siteMonitor.js';
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
import scheduleRouter from './routes/schedule.js';
import stepsRouter from './routes/steps.js';
import wtMarketRouter from './routes/wtMarket.js';
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

// CORS — 白名单化：只对 lcyksp.xyz 及其所有子域（本地开发另放行 localhost 端口）
// 回 ACAO 头；其余来源一律**不发**该头，浏览器同源策略自然拦截。
// 旧行为把任意 Origin 原样反射（else 分支），等于允许任何网站跨域读接口，已收紧。
// 注：curl / 服务端调用不受 CORS 约束，公开接口照常可达；站点前后端同域经 Nginx 反代，正常用户零感知。
const CORS_ORIGIN_RE = /^https?:\/\/([a-z0-9-]+\.)*lcyksp\.xyz(:[0-9]+)?$/
const CORS_LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1):[0-9]+$/

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (CORS_ORIGIN_RE.test(origin) || CORS_LOCAL_ORIGIN_RE.test(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
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
// 更具体的前缀必须先挂，否则请求会先走一遍 adminRouter 的鉴权再落到这里，白做一次校验。
app.use('/api/admin/site-monitor', siteMonitorRouter);
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
app.use('/api/schedule', scheduleRouter);
// 微信步数修改：绑定/提交都要打上游 Zepp，按重接口限流（20 次/分钟）
app.use('/api/steps', heavyLimiter, stepsRouter);
// 战争雷霆交易所价格监控：查询走本地库；配置/刷新打上游 Gaijin，按重接口限流
app.use('/api/wt-market', heavyLimiter, wtMarketRouter);

// ---------- IP 归属地查询：进程内缓存 + 上游超时 ----------
// 前端每次进页面都会自动查一次本机 IP，且该接口无鉴权，容易被扫描器当"慢速资源放大器"反复打。
// 加带 TTL 和条数上限的内存缓存：命中就不出网，省 2 核小机的 CPU/句柄，也躲开 ip-api 免费版 45 次/分钟限速。
// 上限用于防随机 IP 刷爆内存：超限就按插入顺序淘汰最老的一条（Map 保序，近似 LRU，够用）。
const IP_CACHE_TTL_MS = 6 * 60 * 60 * 1000;   // 归属地很稳定，缓存 6 小时
const IP_CACHE_MAX = 5000;                     // 最多 5000 条，满载约 1-2 MB
const IP_LOOKUP_TIMEOUT_MS = 3500;             // 上游 3.5s 不回就放弃，别让请求和 socket 句柄无限期挂住
const ipLookupCache = new Map();

function getCachedIpInfo(ip) {
  const hit = ipLookupCache.get(ip);
  if (!hit) return null;
  if (Date.now() > hit.expireAt) { ipLookupCache.delete(ip); return null; }
  return hit.data;
}

function setCachedIpInfo(ip, data) {
  if (ipLookupCache.size >= IP_CACHE_MAX) {
    const oldest = ipLookupCache.keys().next().value;
    if (oldest !== undefined) ipLookupCache.delete(oldest);
  }
  ipLookupCache.set(ip, { data, expireAt: Date.now() + IP_CACHE_TTL_MS });
}

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
        isProxy: null
      });
    }

    // 命中缓存直接返回：绝大多数请求（尤其反复查本机 IP）不再出网
    const cached = getCachedIpInfo(queryIp);
    if (cached) return res.json(cached);

    let data;
    try {
      const response = await fetch(`http://ip-api.com/json/${queryIp}?lang=zh-CN`, {
        signal: AbortSignal.timeout(IP_LOOKUP_TIMEOUT_MS),
      });
      data = await response.json();
    } catch (e) {
      // 上游超时/网络错误：回"未知"占位，别抛 500 打崩前端；不缓存，下次再试
      return res.json({
        ipAddress: queryIp,
        ipVersion: queryIp.includes(':') ? 6 : 4,
        countryName: e.name === 'TimeoutError' ? '查询超时，请稍后重试' : '未知物理位置',
        regionName: '-',
        cityName: '-',
        zipCode: '-',
        asnOrg: '-',
        latitude: 0,
        longitude: 0,
        isProxy: null
      });
    }

    if (data.status === 'fail') {
      const failResult = {
        ipAddress: queryIp,
        ipVersion: queryIp.includes(':') ? 6 : 4,
        countryName: '未知物理位置',
        regionName: '-',
        cityName: '-',
        zipCode: '-',
        asnOrg: '-',
        latitude: 0,
        longitude: 0,
        isProxy: null
      };
      // 无效/保留地址是稳定结果，缓存掉，免得扫描器拿它反复打上游
      setCachedIpInfo(queryIp, failResult);
      return res.json(failResult);
    }

    const result = {
      ipAddress: data.query,
      ipVersion: data.query.includes(':') ? 6 : 4,
      countryName: data.country || '-',
      regionName: data.regionName || '-',
      cityName: data.city || '-',
      zipCode: data.zip || '-',
      asnOrg: data.isp || data.org || '-',
      latitude: data.lat || 0,
      longitude: data.lon || 0,
      isProxy: null   // ip-api 免费版无代理字段，之前写死 false 是假数据，改 null=未检测
    };
    setCachedIpInfo(queryIp, result);
    res.json(result);
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

import rateLimit from 'express-rate-limit'

// 生产机 2 核，bcrypt 一次约 100ms CPU，几十个并发请求就能把两核吃满。
// 单实例 PM2 + 内存 store 够用，不需要 Redis（重启即重置，可以接受）。

const jsonLimitHandler = (message) => (req, res) => {
  res.set('Retry-After', '60')
  res.status(429).json({ error: message })
}

const shared = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
}

/** 全站兜底：单 IP 每分钟 300 次 /api 请求。正常用户远够不到。 */
export const globalLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 1000,
  limit: 300,
  handler: jsonLimitHandler('请求过于频繁，请稍后再试'),
})

/**
 * 登录/注册：15 分钟内最多 10 次「失败」。
 * skipSuccessfulRequests 让正常用户完全不受影响，只掐撞库和 bcrypt CPU 耗尽。
 */
export const authLimiter = rateLimit({
  ...shared,
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  handler: jsonLimitHandler('尝试次数过多，请 15 分钟后再试'),
})

/** 重计算接口（图片处理、视频解析、网页截图、剧集下载）：单 IP 每分钟 20 次。 */
export const heavyLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 1000,
  limit: 20,
  handler: jsonLimitHandler('操作过于频繁，请稍后再试'),
})

/**
 * 图片代理预览：一个抖音图集可能有 30 张，20 次/分钟会误伤，但也不能不管——
 * 每次都要从外站拉图再过一遍 sharp，是个放大器。60 次/分钟够用又有上限。
 */
export const previewLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 1000,
  limit: 60,
  handler: jsonLimitHandler('预览请求过于频繁，请稍后再试'),
})

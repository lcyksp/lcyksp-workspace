import sharp from 'sharp'

// 生产机只有 2 核 2G，PM2 超 500M 就重启。libvips 默认按 CPU 核数开线程、
// 并缓存已解码的图，这两项在小内存机器上都是内存放大器，全部压到最低。
sharp.concurrency(1)
sharp.cache(false)

// 一张图解码后约占 宽×高×4 字节。60MP ≈ 240MB，是这台机器单张图的天花板；
// 再往上就是解压炸弹（典型 PNG bomb 在 225MP 以上）。sharp 默认放到 268MP，太松。
export const MAX_INPUT_PIXELS = 60_000_000

// 合成画布不走 limitInputPixels（create 出来的画布不算「输入」），必须单独卡。
export const MAX_OUTPUT_PIXELS = 60_000_000
export const MAX_CANVAS_SIDE = 20_000

// 代理外部图片时先看 Content-Length，再边读边数，避免把一个大文件整块读进内存。
export const MAX_REMOTE_IMAGE_BYTES = 32 * 1024 * 1024

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype

/**
 * sharp 的替身：所有输入自动带上像素上限。
 * 兼容两种调用形态——sharp(buffer[, opts]) 和 sharp({ create: ... })。
 */
export default function sharpSafe(input, options) {
  if (isPlainObject(input) && options === undefined) {
    return sharp({ limitInputPixels: MAX_INPUT_PIXELS, ...input })
  }
  return sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, ...options })
}

/** 画布尺寸校验：越界返回中文原因，调用方直接回 413。 */
export function checkCanvasSize(width, height) {
  const w = Number(width)
  const h = Number(height)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) {
    return '图片尺寸无效'
  }
  if (w > MAX_CANVAS_SIDE || h > MAX_CANVAS_SIDE) {
    return `单边不能超过 ${MAX_CANVAS_SIDE}px（当前 ${Math.round(w)}×${Math.round(h)}）`
  }
  if (w * h > MAX_OUTPUT_PIXELS) {
    return `合成结果 ${Math.round(w)}×${Math.round(h)} 约 ${(w * h / 1e6).toFixed(1)}MP，超过 ${MAX_OUTPUT_PIXELS / 1e6}MP 上限，请减少图片数量或先压缩后再拼接`
  }
  return null
}

// ---------- 并发闸门 ----------
// 单张图就可能吃掉上百 MB，靠 limitInputPixels 只能防单个请求；
// 同时来十个请求照样 OOM，所以入口再排一道队。
const MAX_CONCURRENT_IMAGE_JOBS = Number(process.env.MAX_CONCURRENT_IMAGE_JOBS || 3)
let activeImageJobs = 0

export function imageJobGate(_req, res, next) {
  if (activeImageJobs >= MAX_CONCURRENT_IMAGE_JOBS) {
    res.set('Retry-After', '3')
    return res.status(503).json({ error: '图片处理服务繁忙，请稍后重试' })
  }
  activeImageJobs += 1
  let released = false
  const release = () => {
    if (released) return
    released = true
    activeImageJobs = Math.max(0, activeImageJobs - 1)
  }
  res.on('close', release)
  next()
}

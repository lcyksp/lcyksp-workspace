import { Router } from 'express'
import multer from 'multer'
import sharp, { checkCanvasSize, MAX_CANVAS_SIDE } from '../utils/imageGuard.js'

const router = Router()

function httpError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

// 前端 custom 模式除了 images 还会带一个 bgImage 字段。原来这里用的是 upload.array('images')，
// multer 遇到 bgImage 直接抛 MulterError: Unexpected field → 自定义拼接 + 背景图必然 500。
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) return cb(null, true)
    cb(new Error('仅支持图片格式'))
  },
}).fields([
  { name: 'images', maxCount: 30 },
  { name: 'bgImage', maxCount: 1 },
])

router.post('/', upload, async (req, res, next) => {
  try {
    const images = req.files?.images || []
    if (images.length === 0) {
      return res.status(400).json({ error: '请至少上传一张图片' })
    }

    const mode = req.body.mode || 'vertical'
    let bgConfig = { r: 255, g: 255, b: 255, alpha: 1 }
    try {
      const raw = req.body.bgConfig ? JSON.parse(req.body.bgConfig) : null
      if (raw) bgConfig = raw
    } catch { /* use default */ }

    // gap 不夹紧的话，29 个间隔 × 一个巨大的 gap 就能造出天文数字的画布
    const gap = Math.min(Math.max(parseInt(req.body.gap, 10) || 0, 0), 500)

    if (mode === 'vertical') {
      const result = await stitchVertical(images, { bg: bgConfig, gap })
      res.set('Content-Type', 'image/png')
      res.set('Content-Disposition', 'attachment; filename="stitched-vertical.png"')
      return res.send(result)
    }

    if (mode === 'horizontal') {
      const result = await stitchHorizontal(images, { bg: bgConfig, gap })
      res.set('Content-Type', 'image/png')
      res.set('Content-Disposition', 'attachment; filename="stitched-horizontal.png"')
      return res.send(result)
    }

    if (mode === 'custom') {
      let layout = []
      try {
        layout = JSON.parse(req.body.layout || '[]')
      } catch {
        return res.status(400).json({ error: '布局数据格式错误' })
      }

      const bgImageBuffer = req.files?.bgImage?.[0]?.buffer || null

      const canvasWidth = Math.min(Math.max(parseInt(req.body.canvasWidth, 10) || 1080, 1), MAX_CANVAS_SIDE)
      const canvasHeight = Math.min(Math.max(parseInt(req.body.canvasHeight, 10) || 1920, 1), MAX_CANVAS_SIDE)
      const sizeError = checkCanvasSize(canvasWidth, canvasHeight)
      if (sizeError) return res.status(413).json({ error: sizeError })

      const result = await stitchCustom(images, {
        layout,
        bg: bgConfig,
        bgImageBuffer,
        canvasWidth,
        canvasHeight,
      })
      res.set('Content-Type', 'image/png')
      res.set('Content-Disposition', 'attachment; filename="stitched-custom.png"')
      return res.send(result)
    }

    res.status(400).json({ error: '不支持的拼接模式' })
  } catch (err) {
    next(err)
  }
})

async function stitchVertical(files, { bg, gap }) {
  // 原来先把每张图 sharp().toBuffer() 走一遍再读 metadata，等于白解码+白编码 30 次，
  // 而且 30 张解码结果同时留在内存里。composite 能直接吃原始 buffer，这一趟完全可以省掉。
  const metas = await Promise.all(files.map(f => sharp(f.buffer).metadata()))

  const maxWidth = Math.max(...metas.map(m => m.width || 0))
  const totalHeight = metas.reduce((sum, m) => sum + (m.height || 0), 0) + gap * (files.length - 1)

  const sizeError = checkCanvasSize(maxWidth, totalHeight)
  if (sizeError) throw httpError(413, sizeError)

  const composite = []
  let yOffset = 0

  for (let i = 0; i < files.length; i++) {
    const w = metas[i].width || 0
    const h = metas[i].height || 0

    composite.push({
      input: files[i].buffer,
      left: Math.round((maxWidth - w) / 2),
      top: yOffset,
    })
    yOffset += h + gap
  }

  return sharp({
    create: {
      width: maxWidth,
      height: totalHeight,
      channels: 4,
      background: bg,
    },
  })
    .composite(composite)
    .png()
    .toBuffer()
}

async function stitchHorizontal(files, { bg, gap }) {
  const metas = await Promise.all(files.map(f => sharp(f.buffer).metadata()))

  const maxHeight = Math.max(...metas.map(m => m.height || 0))
  const totalWidth = metas.reduce((sum, m) => sum + (m.width || 0), 0) + gap * (files.length - 1)

  const sizeError = checkCanvasSize(totalWidth, maxHeight)
  if (sizeError) throw httpError(413, sizeError)

  const composite = []
  let xOffset = 0

  for (let i = 0; i < files.length; i++) {
    const w = metas[i].width || 0
    const h = metas[i].height || 0

    composite.push({
      input: files[i].buffer,
      left: xOffset,
      top: Math.round((maxHeight - h) / 2),
    })
    xOffset += w + gap
  }

  return sharp({
    create: {
      width: totalWidth,
      height: maxHeight,
      channels: 4,
      background: bg,
    },
  })
    .composite(composite)
    .png()
    .toBuffer()
}

async function stitchCustom(files, { layout, bg, bgImageBuffer, canvasWidth, canvasHeight }) {
  // 前端把所有图片都塞在同一个 images 字段里，layout[].index 就是它们的上传顺序。
  // 原来这里按 fieldname.replace('images','') 取下标，对 'images' 得到 parseInt('') = NaN，
  // 于是 fileMap 只有一个 NaN 键、layout 里的 index 永远查不到 —— 自定义拼接从来没贴上过任何一张图。
  const composite = []

  if (bgImageBuffer) {
    const resizedBg = await sharp(bgImageBuffer)
      .resize(canvasWidth, canvasHeight, { fit: 'cover' })
      .toBuffer()
    composite.push({ input: resizedBg, left: 0, top: 0 })
  }

  for (const item of layout) {
    const buf = files[item.index]?.buffer
    if (!buf) continue

    let input = sharp(buf)

    // layout 来自前端 JSON，宽高必须夹紧：resize 到几万像素同样会把内存吃光
    const itemWidth = item.width ? Math.min(Math.max(Math.round(item.width), 1), canvasWidth) : 0
    const itemHeight = item.height ? Math.min(Math.max(Math.round(item.height), 1), canvasHeight) : 0

    if (itemWidth && itemHeight) {
      input = input.resize(itemWidth, itemHeight, { fit: 'fill' })
    }

    if (item.rotation) {
      input = input.rotate(item.rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    }

    const processed = await input.toBuffer()
    const meta = await sharp(processed).metadata()

    const left = Math.round((Number(item.x) || 0) + ((itemWidth || meta.width) - meta.width) / 2)
    const top = Math.round((Number(item.y) || 0) + ((itemHeight || meta.height) - meta.height) / 2)

    composite.push({ input: processed, left, top })
  }

  return sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 4,
      background: bg,
    },
  })
    .composite(composite)
    .png()
    .toBuffer()
}

export default router

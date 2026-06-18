import { Router } from 'express'
import multer from 'multer'
import sharp from 'sharp'

const router = Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) return cb(null, true)
    cb(new Error('仅支持图片格式'))
  },
})

router.post('/', upload.array('images', 30), async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: '请至少上传一张图片' })
    }

    const mode = req.body.mode || 'vertical'
    let bgConfig = { r: 255, g: 255, b: 255, alpha: 1 }
    try {
      const raw = req.body.bgConfig ? JSON.parse(req.body.bgConfig) : null
      if (raw) bgConfig = raw
    } catch { /* use default */ }

    const gap = parseInt(req.body.gap, 10) || 0

    if (mode === 'vertical') {
      const result = await stitchVertical(req.files, { bg: bgConfig, gap })
      res.set('Content-Type', 'image/png')
      res.set('Content-Disposition', 'attachment; filename="stitched-vertical.png"')
      return res.send(result)
    }

    if (mode === 'horizontal') {
      const result = await stitchHorizontal(req.files, { bg: bgConfig, gap })
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

      let bgImageBuffer = null
      const bgImageFile = req.files.find(f => f.fieldname === 'bgImage')
      if (bgImageFile) {
        bgImageBuffer = bgImageFile.buffer
      }

      const result = await stitchCustom(req.files.filter(f => f.fieldname === 'images'), {
        layout,
        bg: bgConfig,
        bgImageBuffer,
        canvasWidth: parseInt(req.body.canvasWidth, 10) || 1080,
        canvasHeight: parseInt(req.body.canvasHeight, 10) || 1920,
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
  const buffers = await Promise.all(files.map(f => sharp(f.buffer).toBuffer()))
  const metas = await Promise.all(buffers.map(b => sharp(b).metadata()))

  const maxWidth = Math.max(...metas.map(m => m.width || 0))
  const totalHeight = metas.reduce((sum, m) => sum + (m.height || 0), 0) + gap * (files.length - 1)

  const composite = []
  let yOffset = 0

  for (let i = 0; i < buffers.length; i++) {
    const meta = metas[i]
    const w = meta.width || 0
    const h = meta.height || 0
    const x = Math.round((maxWidth - w) / 2)

    composite.push({
      input: buffers[i],
      left: x,
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
  const buffers = await Promise.all(files.map(f => sharp(f.buffer).toBuffer()))
  const metas = await Promise.all(buffers.map(b => sharp(b).metadata()))

  const maxHeight = Math.max(...metas.map(m => m.height || 0))
  const totalWidth = metas.reduce((sum, m) => sum + (m.width || 0), 0) + gap * (files.length - 1)

  const composite = []
  let xOffset = 0

  for (let i = 0; i < buffers.length; i++) {
    const meta = metas[i]
    const w = meta.width || 0
    const h = meta.height || 0
    const y = Math.round((maxHeight - h) / 2)

    composite.push({
      input: buffers[i],
      left: xOffset,
      top: y,
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
  const fileMap = {}
  for (const f of files) {
    const idx = parseInt(f.fieldname.replace('images', ''), 10)
    fileMap[idx] = f.buffer
  }

  const composite = []

  if (bgImageBuffer) {
    const resizedBg = await sharp(bgImageBuffer)
      .resize(canvasWidth, canvasHeight, { fit: 'cover' })
      .toBuffer()
    composite.push({ input: resizedBg, left: 0, top: 0 })
  }

  for (const item of layout) {
    const buf = fileMap[item.index]
    if (!buf) continue

    let input = sharp(buf)

    if (item.width && item.height) {
      input = input.resize(Math.round(item.width), Math.round(item.height), { fit: 'fill' })
    }

    if (item.rotation) {
      input = input.rotate(item.rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    }

    const processed = await input.toBuffer()
    const meta = await sharp(processed).metadata()

    const left = Math.round(item.x + ((item.width || meta.width) - meta.width) / 2)
    const top = Math.round(item.y + ((item.height || meta.height) - meta.height) / 2)

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

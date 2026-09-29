// PDF 整册渲染的弱端护栏：画布尺寸封顶 + 逐页让步 + 用完释放。
// 多个 PDF 工具（转图片/加水印/页面编辑）整册逐页 page.render 到 canvas 都在主线程，
// 大页高倍率会爆内存/超浏览器画布上限、并长时间假死。这里集中处理这几件事。
// 注意：本模块经 renderTier 触碰 window/document，只限主线程用；
// 压缩 worker 里的 makeCanvas 是 pdfCompress.js 自己的副本，别合并到这里。
import { isWeakDevice } from './renderTier.js'

// 单页画布最长边上限（px）：弱端更保守
export function maxCanvasEdge() {
  return isWeakDevice() ? 2560 : 4096
}

// 单页画布总面积上限（px²）：老 iOS 的画布面积硬上限约 16.77M（4096²），最长边不超
// 不代表面积不超，压线就会整页渲染成黑/白板；这里留余量，弱端再收紧一档。
export function maxCanvasArea() {
  return isWeakDevice() ? 12_000_000 : 16_000_000
}

// 把期望 scale 夹到"最长边和总面积都不超上限"，返回 { scale, clamped }
export function clampRenderScale(page, desiredScale) {
  const base = page.getViewport({ scale: 1 })
  const longest = Math.max(base.width, base.height) || 1
  const area = (base.width * base.height) || 1
  const maxScale = Math.min(maxCanvasEdge() / longest, Math.sqrt(maxCanvasArea() / area))
  const scale = Math.min(desiredScale, maxScale)
  return { scale, clamped: scale < desiredScale - 1e-6 }
}

// 让出一次宏任务，给主线程喘口气：整册循环里逐页调用，弱端不假死
export function yieldToUI() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// 画布用完立刻释放：置 0 尺寸促使浏览器尽快回收显存/内存
export function releaseCanvas(canvas) {
  if (!canvas) return
  canvas.width = 0
  canvas.height = 0
}

// 画布工厂：有 OffscreenCanvas 用 OffscreenCanvas（不占 DOM），
// 没有就退 DOM canvas——老 Chromium/旧 Safari 上 new OffscreenCanvas 会直接抛异常
export function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

// 统一的"画布转 Blob"：OffscreenCanvas 用 convertToBlob，DOM canvas 用 toBlob
export function canvasToBlob(canvas, type = 'image/png', quality) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality })
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas 导出失败'))), type, quality)
  })
}

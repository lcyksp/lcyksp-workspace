// PDF 压缩引擎 —— 纯前端，运行在 Web Worker 里。
//
// 思路（对应方案 B + A）：
//   B：把 PDF 里内嵌的图片 XObject 重新编码成 JPEG（可选降采样），
//      文本、矢量、字体、页面结构原封不动。
//   A：最后用 useObjectStreams 重新保存一遍，做无损的结构优化。
//
// 只处理能安全处理的图片，其余一律原样保留——宁可压不动，也不能把文件压坏。
//   处理：DCTDecode（JPEG）、FlateDecode + 8bpc + DeviceRGB/DeviceGray
//   跳过：ImageMask、带 Decode / DecodeParms、Indexed / ICCBased 等色彩空间、
//         JPXDecode、JBIG2Decode、CCITTFaxDecode、以及重编码后反而变大的图

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
} from 'pdf-lib'

const N_FILTER = PDFName.of('Filter')
const N_SUBTYPE = PDFName.of('Subtype')
const N_WIDTH = PDFName.of('Width')
const N_HEIGHT = PDFName.of('Height')
const N_BPC = PDFName.of('BitsPerComponent')
const N_COLORSPACE = PDFName.of('ColorSpace')
const N_DECODEPARMS = PDFName.of('DecodeParms')
const N_DECODE = PDFName.of('Decode')
const N_SMASK = PDFName.of('SMask')
const N_IMAGEMASK = PDFName.of('ImageMask')

/** 三档预设。maxLongSide 是图片长边的像素上限，用来替代"目标 DPI"。 */
export const PDF_PRESETS = {
  light: {
    key: 'light',
    label: '轻度',
    quality: 0.85,
    maxLongSide: 2400,
    desc: '几乎看不出差别，适合文档存档',
  },
  medium: {
    key: 'medium',
    label: '推荐',
    quality: 0.72,
    maxLongSide: 1700,
    desc: '清晰度与体积的平衡点',
  },
  strong: {
    key: 'strong',
    label: '极限',
    quality: 0.55,
    maxLongSide: 1200,
    desc: '体积最小，图片会明显变糊',
  },
}

/** 自定义档位：和预设同构，直接喂给 compressPdf。 */
export function makeCustomPreset(quality, maxLongSide) {
  return {
    key: 'custom',
    label: '自定义',
    quality,
    maxLongSide,
    desc: '手动指定画质与分辨率上限',
  }
}

function toNumber(obj) {
  return obj instanceof PDFNumber ? obj.asNumber() : undefined
}

// 注意：pdf-lib 的 PDFName.asString() 会带前导斜杠（返回 '/Image' 而不是 'Image'），
// 一律归一化后再比对，不然什么都匹配不上。
function nameOf(obj) {
  if (!(obj instanceof PDFName)) return undefined
  return obj.asString().replace(/^\//, '')
}

function filterNames(dict) {
  const raw = dict.get(N_FILTER)
  const single = nameOf(raw)
  if (single) return [single]
  if (raw instanceof PDFArray) return raw.asArray().map(nameOf).filter(Boolean)
  return []
}

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function canvasToBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality })
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas 导出失败'))), type, quality)
  })
}

function fitSize(width, height, maxLongSide) {
  const long = Math.max(width, height)
  if (!maxLongSide || long <= maxLongSide) return [width, height]
  const k = maxLongSide / long
  return [Math.max(1, Math.round(width * k)), Math.max(1, Math.round(height * k))]
}

function pixelsToImageData(raw, width, height, gray) {
  const out = new Uint8ClampedArray(width * height * 4)
  if (gray) {
    for (let i = 0, j = 0; i < width * height; i++, j += 4) {
      const v = raw[i]
      out[j] = v
      out[j + 1] = v
      out[j + 2] = v
      out[j + 3] = 255
    }
  } else {
    for (let i = 0, j = 0; i < width * height; i++, j += 4) {
      const k = i * 3
      out[j] = raw[k]
      out[j + 1] = raw[k + 1]
      out[j + 2] = raw[k + 2]
      out[j + 3] = 255
    }
  }
  return new ImageData(out, width, height)
}

async function encodeToJpeg(bitmap, srcW, srcH, preset, allowDownscale) {
  const [width, height] = allowDownscale ? fitSize(srcW, srcH, preset.maxLongSide) : [srcW, srcH]
  const canvas = makeCanvas(width, height)
  const ctx = canvas.getContext('2d')
  // JPEG 没有透明通道，先铺白底，避免透明区域变黑
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(bitmap, 0, 0, width, height)

  if (preset.grayscale) {
    // 手写灰度而不是 ctx.filter：后者在 OffscreenCanvas / 跨浏览器上行为不一致。
    // 注意 canvas 只能输出 3 通道 JPEG，所以这里的收益来自"像素变相似、熵下降"，
    // 大约 15-35%，不是理论上的 2/3。
    const frame = ctx.getImageData(0, 0, width, height)
    const px = frame.data
    for (let i = 0; i < px.length; i += 4) {
      const y = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000
      px[i] = y
      px[i + 1] = y
      px[i + 2] = y
    }
    ctx.putImageData(frame, 0, 0)
  }

  const blob = await canvasToBlob(canvas, 'image/jpeg', preset.quality)
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height }
}

function hashBytes(bytes) {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16) + ':' + bytes.length
}

function sameBytes(a, b) {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * 把内容完全相同的图片对象合并成一个：改写所有引用，再删掉多余的副本。
 * 只认"字节级完全相同"的图 —— 宁可少省一点，也不能把两张不同的图弄混。
 */
export function dedupeImages(doc) {
  const context = doc.context
  const images = context.enumerateIndirectObjects().filter(([, obj]) => isImageStream(obj))

  const byKey = new Map()
  const remap = new Map()
  let savedBytes = 0
  for (const [ref, stream] of images) {
    const dict = stream.dict
    const key =
      `${toNumber(dict.get(N_WIDTH))}x${toNumber(dict.get(N_HEIGHT))}/` + hashBytes(stream.contents)
    const canonical = byKey.get(key)
    if (canonical && sameBytes(canonical.stream.contents, stream.contents)) {
      remap.set(ref.tag, canonical.ref)
      savedBytes += stream.contents.length
    } else if (!canonical) {
      byKey.set(key, { ref, stream })
    }
  }
  if (!remap.size) return { merged: 0, savedBytes: 0 }

  const seen = new Set()
  const walk = (value) => {
    if (!value || typeof value !== 'object') return
    if (value instanceof PDFRef) return
    if (seen.has(value)) return
    seen.add(value)
    if (value instanceof PDFStream) {
      walk(value.dict)
      return
    }
    if (value instanceof PDFDict) {
      for (const [key, entry] of value.entries()) {
        if (entry instanceof PDFRef && remap.has(entry.tag)) value.set(key, remap.get(entry.tag))
        else walk(entry)
      }
      return
    }
    if (value instanceof PDFArray) {
      for (let i = 0; i < value.size(); i++) {
        const entry = value.get(i)
        if (entry instanceof PDFRef && remap.has(entry.tag)) value.set(i, remap.get(entry.tag))
        else walk(entry)
      }
    }
  }

  for (const [, obj] of context.enumerateIndirectObjects()) walk(obj)

  // 清理已经无人引用的重复图片对象
  for (const [ref] of images) {
    if (remap.has(ref.tag)) context.delete(ref)
  }

  return { merged: remap.size, savedBytes }
}

/**
 * 尝试重编码一张图片。返回 null 表示"不动它"。
 */
async function reencodeImage(stream, preset, context) {
  const dict = stream.dict

  const imageMask = dict.get(N_IMAGEMASK)
  if (imageMask && typeof imageMask.asBoolean === 'function' && imageMask.asBoolean()) return null
  // Decode / DecodeParms 会改变像素语义（反转、预测器），无法安全重编码
  if (dict.get(N_DECODE)) return null
  if (dict.get(N_DECODEPARMS)) return null

  const filters = filterNames(dict)
  const width = toNumber(dict.get(N_WIDTH))
  const height = toNumber(dict.get(N_HEIGHT))
  if (!width || !height || filters.length !== 1) return null

  const hasSMask = Boolean(dict.get(N_SMASK))
  const original = stream.contents
  let encoded = null

  if (filters[0] === 'DCTDecode') {
    // 原始字节本身就是一张 JPEG，浏览器能直接解
    const bitmap = await createImageBitmap(new Blob([original], { type: 'image/jpeg' }))
    try {
      encoded = await encodeToJpeg(bitmap, width, height, preset, !hasSMask)
    } finally {
      if (bitmap.close) bitmap.close()
    }
    // 二次 JPEG 压缩：同样尺寸且压不小就放弃，别白白掉画质
    if (!encoded || encoded.bytes.length >= original.length) return null
  } else if (filters[0] === 'FlateDecode') {
    if (toNumber(dict.get(N_BPC)) !== 8) return null
    const csName = nameOf(dict.get(N_COLORSPACE))
    const gray = csName === 'DeviceGray'
    if (!gray && csName !== 'DeviceRGB') return null

    const raw = decodePDFRawStream(stream).decode()
    const need = width * height * (gray ? 1 : 3)
    if (raw.length < need) return null

    const bitmap = await createImageBitmap(pixelsToImageData(raw, width, height, gray))
    try {
      encoded = await encodeToJpeg(bitmap, width, height, preset, !hasSMask)
    } finally {
      if (bitmap.close) bitmap.close()
    }
    if (!encoded || encoded.bytes.length >= original.length) return null
  } else {
    return null
  }

  const newDict = PDFDict.withContext(context)
  newDict.set(PDFName.of('Type'), PDFName.of('XObject'))
  newDict.set(N_SUBTYPE, PDFName.of('Image'))
  newDict.set(N_WIDTH, PDFNumber.of(encoded.width))
  newDict.set(N_HEIGHT, PDFNumber.of(encoded.height))
  newDict.set(N_COLORSPACE, PDFName.of('DeviceRGB'))
  newDict.set(N_BPC, PDFNumber.of(8))
  newDict.set(N_FILTER, PDFName.of('DCTDecode'))
  // 带透明通道的图不降采样，所以 SMask 尺寸仍然对得上，可以原样保留
  const smask = dict.get(N_SMASK)
  if (smask) newDict.set(N_SMASK, smask)

  return {
    stream: PDFRawStream.of(newDict, encoded.bytes),
    saved: original.length - encoded.bytes.length,
  }
}

function isImageStream(obj) {
  if (!(obj instanceof PDFRawStream)) return false
  return nameOf(obj.dict.get(N_SUBTYPE)) === 'Image'
}

/**
 * 压缩入口。
 * @param {Uint8Array} input 原始 PDF 字节
 * @param {string|object} presetOption 预设名（light/medium/strong）或自定义档位对象
 * @param {(p: {phase: string, done?: number, total?: number}) => void} onProgress
 */
export async function compressPdf(input, presetOption, onProgress) {
  const preset =
    typeof presetOption === 'string'
      ? PDF_PRESETS[presetOption] || PDF_PRESETS.medium
      : { ...PDF_PRESETS.medium, ...(presetOption || {}) }
  const doc = await PDFDocument.load(input, { updateMetadata: false, ignoreEncryption: true })
  const context = doc.context

  const images = context
    .enumerateIndirectObjects()
    .filter(([, obj]) => isImageStream(obj))

  let done = 0
  let replaced = 0
  let skipped = 0
  let savedBytes = 0

  onProgress?.({ phase: 'images', done: 0, total: images.length })

  for (const [ref, stream] of images) {
    try {
      const result = await reencodeImage(stream, preset, context)
      if (result) {
        context.assign(ref, result.stream)
        replaced += 1
        savedBytes += result.saved
      } else {
        skipped += 1
      }
    } catch {
      skipped += 1
    }
    done += 1
    onProgress?.({ phase: 'images', done, total: images.length })
    // 每几张让出一次，Worker 里也能及时上报进度
    if (done % 3 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
  }

  let merged = 0
  if (preset.dedupe) {
    onProgress?.({ phase: 'dedupe' })
    const dedupe = dedupeImages(doc)
    merged = dedupe.merged
    savedBytes += dedupe.savedBytes
  }

  onProgress?.({ phase: 'saving' })
  const bytes = await doc.save({
    useObjectStreams: true,
    addDefaultPage: false,
    updateFieldAppearances: false,
  })

  return {
    bytes,
    stats: { images: images.length, replaced, skipped, savedBytes, merged },
  }
}

// ---------------------------------------------------------------------------
// 扫描件极限模式：整页栅格化
//
// 用 pdf.js 把每一页渲染成位图，再重建成一个纯图片 PDF。
// 体积能暴降（对扫描件尤其明显），代价是**文本变成图片** —— 不可选中、不可搜索、
// 书签与链接失效。所以这个模式必须在界面上明确警告，且默认不选。
// ---------------------------------------------------------------------------

let pdfjsPromise = null

async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import('pdfjs-dist')
      if (!pdfjs.GlobalWorkerOptions.workerSrc) {
        const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default
      }
      return pdfjs
    })()
  }
  return pdfjsPromise
}

/**
 * @param {Uint8Array} input 原始 PDF 字节
 * @param {{dpi?: number, quality?: number}} options
 * @param {(p: {phase: string}) => void} onProgress
 */
export async function rasterizePdf(input, options, onProgress) {
  const dpi = Math.min(300, Math.max(72, Math.round(options?.dpi || 150)))
  const quality = Math.min(0.95, Math.max(0.35, options?.quality ?? 0.75))

  const pdfjs = await loadPdfjs()
  const src = await pdfjs.getDocument({ data: input.slice(), isEvalSupported: false }).promise
  const pageCount = src.numPages
  const out = await PDFDocument.create()
  const scale = dpi / 72

  try {
    for (let pageNo = 1; pageNo <= pageCount; pageNo++) {
      onProgress?.({ phase: 'raster', done: pageNo - 1, total: pageCount })

      const page = await src.getPage(pageNo)
      const viewport = page.getViewport({ scale })
      const width = Math.max(1, Math.round(viewport.width))
      const height = Math.max(1, Math.round(viewport.height))

      const canvas = makeCanvas(width, height)
      const context = canvas.getContext('2d')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, width, height)
      await page.render({ canvasContext: context, viewport }).promise

      const blob = await canvasToBlob(canvas, 'image/jpeg', quality)
      const image = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()))
      const target = out.addPage([viewport.width / scale, viewport.height / scale])
      target.drawImage(image, { x: 0, y: 0, width: target.getWidth(), height: target.getHeight() })

      page.cleanup()
      // 页间让出一次，进度回调才发得出去
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  } finally {
    await Promise.resolve(src.destroy()).catch(() => {})
  }

  onProgress?.({ phase: 'saving' })
  const bytes = await out.save({ useObjectStreams: true, addDefaultPage: false })
  return { bytes, stats: { pages: pageCount, mode: 'raster' } }
}

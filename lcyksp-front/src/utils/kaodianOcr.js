// =====================================================================
//  浏览器端 OCR（tesseract.js）
//
//  目的：扫描版 PDF（整页是图、没有文字层）也能导入，而且**算力全部在用户机器上**，
//  服务器只负责发几个静态文件 —— 2C2G 小机完全不参与 OCR。
//
//  资产放在 /ocr（由 tools/prep-ocr-assets.mjs 从 node_modules 注入 public/）：
//    /ocr/worker.min.js          tesseract worker
//    /ocr/core/*                 wasm core（浏览器按 SIMD 能力只下其中一个，约 2.7MB）
//    /ocr/lang/chi_sim.traineddata.gz   中文模型 1.6MB（写进 IndexedDB，只下一次）
//
//  注意：tesseract.js 走动态 import()，只有真正用 OCR 时才加载，不拖慢普通导入。
// =====================================================================
import pdfjsLib from './pdfjs.js'

const OCR_BASE = '/ocr'
const MAX_OCR_PAGES = 150

/** 文字层太薄 => 判定为扫描版。返回每页平均字数，用于给用户一个判断依据。 */
export function charsPerPage(text, pageCount) {
  if (!pageCount) return Infinity
  return String(text || '').length / pageCount
}

export function looksScanned(text, pageCount) {
  if (!pageCount) return false
  return charsPerPage(text, pageCount) < 30
}

export function maxOcrPages() { return MAX_OCR_PAGES }

/** 读取 PDF 的页数（不解析文字）。 */
export async function pdfPageCount(buf) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  const n = doc.numPages
  await doc.destroy()
  return n
}

function createCanvas(w, h) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

/** 每页渲染成 canvas。逐页回调，避免一次性占满内存。 */
async function eachPageCanvas(buf, { pages, dpi, onPage, signal }) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  const scale = dpi / 72
  try {
    for (const i of pages) {
      if (signal?.aborted) throw new Error('已取消')
      const page = await doc.getPage(i)
      const viewport = page.getViewport({ scale })
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      const ctx = canvas.getContext('2d')
      // 白底：扫描图上偶有透明区域，不铺白底 OCR 会识别出一堆噪声
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: ctx, viewport }).promise
      await onPage(canvas, i)
      page.cleanup()
    }
  } finally {
    await doc.destroy().catch(() => {})
  }
}

/** 取出 tesseract 的所有行（含 bbox）。 */
function blocksToLines(data) {
  const out = []
  for (const b of data?.blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) {
        const t = String(l?.text || '').replace(/\s+/g, ' ').trim()
        if (t && l.bbox) out.push({ text: t, y0: l.bbox.y0, y1: l.bbox.y1 })
      }
    }
  }
  return out
}

/**
 * 按行间距重建段落。
 * tesseract 的 paragraph 分组在中文竖排/密集版式上很不靠谱（整页经常归成一段），
 * 所以这里自己按"行间空隙明显变大"来断段 —— 和 pdfjs 那条路用同一套判据。
 */
function linesToParagraphs(lines) {
  const items = lines.slice().sort((a, b) => a.y0 - b.y0)
  if (!items.length) return ''
  const gaps = []
  for (let i = 1; i < items.length; i++) gaps.push(items[i].y0 - items[i - 1].y1)
  const pos = gaps.filter((g) => g > 0).sort((a, b) => a - b)
  const median = pos.length ? pos[Math.floor(pos.length / 2)] : 0
  // 阈值保守一点：宁可少断（用户能在草稿框里手动加空行），也别把一句话切成两个考点
  const thresh = Math.max(median * 1.5, 3)
  const out = []
  let cur = ''
  for (let i = 0; i < items.length; i++) {
    if (i > 0 && gaps[i - 1] > thresh) { if (cur) out.push(cur); cur = '' }
    cur += items[i].text
  }
  if (cur) out.push(cur)
  return out.join('\n\n')
}

/** 清理 OCR 常见噪声。 */
function cleanOcrText(s) {
  let t = String(s || '')
    .replace(/[ \t]+/g, ' ')
    // 连续 5 个以上拉丁大写字母基本是把装饰符号（★▼ 等）认岔了
    .replace(/[A-Z]{5,}/g, '')
    .replace(/[|｜]{2,}/g, '')
    .replace(/[•·]{2,}/g, '')
  // tesseract 把中文当空格分词，汉字之间会多出空格 —— 只删"两侧都是中文/中文标点"的空格，
  // 中英之间的空格（如 "PDF 文件"）保留
  const CJK = '\\u4e00-\\u9fa5\\u3000-\\u303f\\uff00-\\uffef'
  for (let i = 0; i < 3; i++) {
    t = t.replace(new RegExp(`([${CJK}])[ \\t]+(?=[${CJK}])`, 'g'), '$1')
  }
  return t
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.replace(/\s+$/, '')).join('\n')
    .trim()
}

/**
 * 对扫描版 PDF 做 OCR。
 * 页码两种给法（二选一）：
 *   opts.pages  页码数组（如「自动」路线检测出的、没有文字层的页）—— 优先
 *   opts.from/opts.to 连续区间（1 基，含）
 * @param {File|ArrayBuffer} src
 * @param {object} opts
 * @param {number[]} [opts.pages]
 * @param {number} [opts.from]
 * @param {number} [opts.to]
 * @param {number} [opts.dpi] 渲染精度，默认 200
 * @param {(info:{stage:string,done:number,total:number,progress:number,line:string})=>void} [opts.onProgress]
 * @param {{aborted:boolean}} [opts.signal]
 * @returns {Promise<{text:string, pages:number, seconds:number}>}
 */
export async function ocrPdf(src, opts = {}) {
  const buf = src instanceof ArrayBuffer ? src : await src.arrayBuffer()
  let pages
  if (Array.isArray(opts.pages) && opts.pages.length) {
    pages = [...new Set(opts.pages.map(Number).filter((n) => Number.isInteger(n) && n >= 1))].sort((a, b) => a - b)
  } else {
    const from = Math.max(1, Number(opts.from) || 1)
    const to = Math.max(from, Number(opts.to) || from)
    pages = []
    for (let i = from; i <= to; i++) pages.push(i)
  }
  pages = pages.slice(0, MAX_OCR_PAGES)
  const total = pages.length
  const dpi = Number(opts.dpi) || 200
  const report = opts.onProgress || (() => {})

  const t0 = Date.now()
  // 用自托管的 ESM 构建（同源、不走 CDN、不进 bundle）—— 只有真正要 OCR 时才加载。
  // @vite-ignore：路径是运行时才决定的，别让打包器去解析它。
  const tesseract = (await import(/* @vite-ignore */ `${OCR_BASE}/tesseract.esm.min.js`)).default
  const { createWorker, OEM } = tesseract
  report({ stage: 'loading', done: 0, total, progress: 0, line: '正在加载 OCR 引擎（首次约 4.5MB，之后走缓存）…' })

  let pageIdx = 0          // 已完成的页数
  let subProgress = 0      // 当前页的识别进度 0~1
  let currentNo = from

  const worker = await createWorker('chi_sim', OEM.LSTM_ONLY, {
    workerPath: `${OCR_BASE}/worker.min.js`,
    corePath: `${OCR_BASE}/core`,
    langPath: `${OCR_BASE}/lang`,
    gzip: true,
    logger: (m) => {
      if (!m || m.status !== 'recognizing text') return
      subProgress = m.progress || 0
      report({
        stage: 'recognize', done: pageIdx, total,
        progress: (pageIdx + subProgress) / total,
        line: `正在识别第 ${currentNo} 页 / 共 ${total} 页…`,
      })
    },
  })

  const parts = []
  const pageTexts = []
  try {
    // 中文别按空格分词（否则每个汉字之间被塞空格）
    await worker.setParameters({ preserve_interword_spaces: '1' }).catch(() => {})
    await eachPageCanvas(buf, {
      pages, dpi, signal: opts.signal,
      onPage: async (canvas, pageNo) => {
        if (opts.signal?.aborted) throw new Error('已取消')
        currentNo = pageNo
        subProgress = 0
        report({ stage: 'recognize', done: pageIdx, total, progress: pageIdx / total, line: `正在识别第 ${pageNo} 页 / 共 ${total} 页…` })
        // 显式要 blocks：v7 默认只回 text，拿不到行/bbox
        const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true })
        const lines = blocksToLines(data)
        const txt = cleanOcrText(lines.length ? linesToParagraphs(lines) : String(data?.text || ''))
        parts.push(txt)
        pageTexts.push(txt)
        pageIdx += 1
        subProgress = 0
        canvas.width = 0        // 让浏览器尽快回收
        canvas.height = 0
        report({ stage: 'recognize', done: pageIdx, total, progress: pageIdx / total, line: `第 ${pageNo} 页完成` })
      },
    })
  } finally {
    await worker.terminate().catch(() => {})
  }

  return { text: parts.filter(Boolean).join('\n\n'), pageTexts, pageNos: pages.slice(0, pageTexts.length), pages: pageIdx, seconds: (Date.now() - t0) / 1000 }
}

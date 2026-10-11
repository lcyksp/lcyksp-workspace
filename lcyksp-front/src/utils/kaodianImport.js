// =====================================================================
//  我的教材：浏览器端文本提取
//
//  把用户上传的 PDF / Word / Excel / MD / TXT 统一抽成一份"轻量 Markdown"，
//  再交给后端 utils/kaodianImport.js 结构化成考点。
//  放在浏览器做的好处：服务端不需要装 PDF/OOXML 解析依赖，2C2G 小机零负担。
//
//  产出的中间格式约定：
//    # / ## / ###   标题（章 / 节 / 考点标题）
//    Q: ... A: ...  问答式考点
//    |a|b|          表格行（第一列题干，第二列答案）
//    其余            正文段落（空行分段）
// =====================================================================
import JSZip from 'jszip'
import pdfjsLib from './pdfjs.js'

export const SUPPORTED_EXT = ['pdf', 'docx', 'xlsx', 'xls', 'md', 'markdown', 'txt']
export const MAX_PARSE_BYTES = 30 * 1024 * 1024

export function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''))
  return m ? m[1].toLowerCase() : ''
}

export function isSupported(name) {
  return SUPPORTED_EXT.includes(extOf(name))
}

// ---------- 通用小工具 ----------
const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
function unescapeXml(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, n) => XML_ENT[n])
}

function decodeTextBuffer(buf) {
  const utf8 = new TextDecoder('utf-8').decode(buf)
  const bad = (utf8.match(/\uFFFD/g) || []).length
  if (bad <= 2) return utf8
  // 中文 Windows 下的 TXT 多为 GBK，UTF-8 解出来会满屏替换符
  try {
    const gbk = new TextDecoder('gbk').decode(buf)
    return (gbk.match(/\uFFFD/g) || []).length < bad ? gbk : utf8
  } catch {
    return utf8
  }
}

function normalizeText(s) {
  return String(s || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u3000]/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---------- PDF ----------
// 解析路线：
//   'text' 只用文字层（快，扫描页会没内容）
//   'auto' 逐页判断：文字层太薄的页交给浏览器 OCR（混合路线）
//   'ocr'  全部页走 OCR（适合文字层错乱的伪文字版 PDF）
const THIN_PAGE_CHARS = 30

async function extractPdf(file, buf, pdfMode = 'auto') {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  const pageTexts = []
  const ocrPages = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const tc = await page.getTextContent()
    const items = tc.items
      .filter((it) => typeof it.str === 'string' && it.str.trim())
      .map((it) => ({ str: it.str, x: it.transform[4], y: Math.round(it.transform[5]) }))
    const pageChars = items.reduce((a, it) => a + it.str.length, 0)
    // 薄页：整页文字层几乎为空（或用户强制全 OCR）—— 标记为"需要 OCR"，不当场渲染
    if (pdfMode === 'ocr' || (pdfMode === 'auto' && pageChars < THIN_PAGE_CHARS)) {
      ocrPages.push(i)
      pageTexts.push(null)
      page.cleanup()
      continue
    }
    // 按 y 聚成行
    const lines = []
    for (const it of items) {
      const last = lines[lines.length - 1]
      if (last && Math.abs(last.y - it.y) <= 3) {
        last.parts.push(it)
        last.y = (last.y + it.y) / 2
      } else {
        lines.push({ y: it.y, parts: [it] })
      }
    }
    // 行距明显变大 -> 视为段落分隔（PDF 里没有真正的空行）
    const gaps = []
    for (let k = 1; k < lines.length; k++) gaps.push(lines[k - 1].y - lines[k].y)
    const sorted = gaps.filter((g) => g > 0).sort((a, b) => a - b)
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
    const paras = []
    let cur = ''
    for (let k = 0; k < lines.length; k++) {
      const text = lines[k].parts.sort((a, b) => a.x - b.x).map((p) => p.str).join('')
      if (k > 0 && median > 0 && gaps[k - 1] > median * 1.6) { paras.push(cur); cur = '' }
      cur += text
    }
    if (cur) paras.push(cur)
    pageTexts.push(paras.join('\n\n'))
    page.cleanup()
  }
  const info = await doc.getMetadata().catch(() => null)
  const pageCount = doc.numPages
  await doc.destroy()
  const text = normalizeText(pageTexts.map((t) => t || '').filter(Boolean).join('\n\n'))
  return {
    text, title: String(info?.info?.Title || '').trim(), pageCount, ocrPages,
    // 每页文字层文本（null = 该页需要 OCR），供"自动"路线按页序合成
    pdfPages: pageTexts.map((t, idx) => ({ no: idx + 1, text: t })),
  }
}

// ---------- DOCX ----------
const DOCX_HEADING_STYLE = /^(?:heading|标题)\s*([1-6])$/i
function docxParagraphs(xml) {
  const body = /<w:body[^>]*>([\s\S]*)<\/w:body>/.exec(xml)
  const src = body ? body[1] : xml
  const out = []
  // 按 w:p / w:tbl 依次切块，保持文档顺序
  const re = /<w:(p|tbl)\b[^>]*>([\s\S]*?)<\/w:\1>|<w:(p|tbl)\b[^>]*\/>/g
  let m
  while ((m = re.exec(src))) {
    const tag = m[1] || m[3]
    const inner = m[2] || ''
    if (tag === 'tbl') {
      const rows = []
      const trRe = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g
      let tr
      while ((tr = trRe.exec(inner))) {
        const cells = []
        const tcRe = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g
        let tc
        while ((tc = tcRe.exec(tr[1]))) cells.push(docxInlineText(tc[1]))
        if (cells.some((c) => c)) rows.push(cells)
      }
      if (rows.length) out.push({ type: 'table', rows })
      continue
    }
    const text = docxInlineText(inner)
    const style = /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(inner)
    const outline = /<w:outlineLvl\b[^>]*w:val="(\d+)"/.exec(inner)
    let level = 0
    if (style) {
      const hm = DOCX_HEADING_STYLE.exec(style[1].trim())
      if (hm) level = Number(hm[1])
      else if (/^[1-6]$/.test(style[1].trim())) level = Number(style[1].trim())   // 中文 Word：样式名就是 1/2/3
    }
    if (!level && outline) level = Number(outline[1]) + 1
    out.push({ type: 'para', text, level: level > 0 && level <= 6 ? level : 0 })
  }
  return out
}

function docxInlineText(xml) {
  let s = ''
  const re = /<w:(t|tab|br|cr|noBreakHyphen)\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:\1>)/g
  let m
  while ((m = re.exec(xml))) {
    const tag = m[1]
    if (tag === 't') s += unescapeXml(m[2] || '')
    else if (tag === 'tab') s += '\t'
    else if (tag === 'noBreakHyphen') s += '-'
    else s += '\n'
  }
  return s.trim()
}

async function extractDocx(buf) {
  const zip = await JSZip.loadAsync(buf)
  const f = zip.file('word/document.xml')
  if (!f) throw new Error('这不是有效的 .docx 文件（找不到 word/document.xml）')
  const xml = await f.async('string')
  const blocks = docxParagraphs(xml)
  const lines = []
  for (const b of blocks) {
    if (b.type === 'table') {
      lines.push('')
      for (const row of b.rows) lines.push('| ' + row.map((c) => c.replace(/[|\n]/g, ' ')).join(' | ') + ' |')
      lines.push('')
    } else if (b.level) {
      lines.push('')
      lines.push('#'.repeat(Math.min(b.level, 3)) + ' ' + b.text)
      lines.push('')
    } else if (b.text) {
      lines.push(b.text)
    } else {
      lines.push('')
    }
  }
  let title = ''
  try {
    const core = zip.file('docProps/core.xml')
    if (core) {
      const cx = await core.async('string')
      title = unescapeXml((/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/.exec(cx) || [])[1] || '').trim()
    }
  } catch { /* 忽略 */ }
  return { text: normalizeText(lines.join('\n')), title }
}

// ---------- XLSX / XLS ----------
function colToIdx(ref) {
  const m = /^([A-Z]+)/.exec(ref || '')
  if (!m) return 0
  let n = 0
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

async function extractXlsx(buf) {
  const zip = await JSZip.loadAsync(buf)
  // 共享字符串
  const shared = []
  const ssFile = zip.file('xl/sharedStrings.xml')
  if (ssFile) {
    const ss = await ssFile.async('string')
    const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g
    let si
    while ((si = siRe.exec(ss))) {
      let t = ''
      const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g
      let tm
      while ((tm = tRe.exec(si[1]))) t += unescapeXml(tm[1])
      shared.push(t)
    }
  }
  // sheet 顺序 + 名字
  const names = []
  const wb = zip.file('xl/workbook.xml')
  if (wb) {
    const wx = await wb.async('string')
    const re = /<sheet\b[^>]*name="([^"]*)"[^>]*\/>/g
    let m
    while ((m = re.exec(wx))) names.push(unescapeXml(m[1]))
  }
  const sheetFiles = Object.keys(zip.files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]))

  const out = []
  for (let i = 0; i < sheetFiles.length; i++) {
    const xml = await zip.file(sheetFiles[i]).async('string')
    const rows = []
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g
    let rm
    while ((rm = rowRe.exec(xml))) {
      const cells = []
      const cRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g
      let cm
      while ((cm = cRe.exec(rm[1]))) {
        const attrs = cm[1] || cm[3] || ''
        const inner = cm[2] || ''
        const ref = (/r="([A-Z]+\d+)"/.exec(attrs) || [])[1] || ''
        const type = (/t="([^"]+)"/.exec(attrs) || [])[1] || ''
        let val = ''
        if (type === 'inlineStr') {
          const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g
          let tm
          while ((tm = tRe.exec(inner))) val += unescapeXml(tm[1])
        } else {
          const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1] || ''
          val = type === 's' ? (shared[Number(v)] || '') : unescapeXml(v)
        }
        cells[colToIdx(ref)] = String(val).replace(/[\n\t]/g, ' ').trim()
      }
      if (cells.some((c) => c)) rows.push(cells)
      if (rows.length >= 3000) break
    }
    if (!rows.length) continue
    const width = Math.max(...rows.map((r) => r.length))
    out.push('## ' + (names[i] || `工作表${i + 1}`))
    for (const r of rows) {
      const cells = []
      for (let c = 0; c < width; c++) cells.push(r[c] || '')
      if (cells.some((c) => c)) out.push('| ' + cells.join(' | ') + ' |')
    }
    out.push('')
  }
  return { text: normalizeText(out.join('\n')), title: '' }
}

// ---------- 入口 ----------
/**
 * @param {File} file
 * @param {{pdfMode?:'auto'|'text'|'ocr'}} [opts]
 * @returns {Promise<{title:string,fileType:string,fileSize:number,text:string,ext:string,pageCount:number,ocrPages:number[],pdfPages:{no:number,text:string|null}[]}>}
 */
export async function extractTextFromFile(file, opts = {}) {
  const ext = extOf(file.name)
  if (!isSupported(file.name)) {
    throw new Error(`不支持的文件类型 .${ext}，请上传 PDF / Word(.docx) / Excel(.xlsx) / Markdown / 纯文本`)
  }
  if (file.size > MAX_PARSE_BYTES) {
    throw new Error(`文件太大（${(file.size / 1024 / 1024).toFixed(1)}MB），上限 ${MAX_PARSE_BYTES / 1024 / 1024}MB`)
  }
  let res
  if (ext === 'pdf') {
    res = await extractPdf(file, await file.arrayBuffer(), opts.pdfMode || 'auto')
  } else if (ext === 'docx') {
    res = await extractDocx(await file.arrayBuffer())
  } else if (ext === 'xlsx') {
    res = await extractXlsx(await file.arrayBuffer())
  } else if (ext === 'xls') {
    throw new Error('不支持旧版 .xls（二进制格式），请在 Excel/WPS 里另存为 .xlsx 再上传')
  } else {
    res = { text: normalizeText(decodeTextBuffer(await file.arrayBuffer())), title: '' }
  }
  const baseName = file.name.replace(/\.[^.]+$/, '')
  return {
    title: (res.title || baseName).slice(0, 60),
    fileName: file.name,
    fileType: ext,
    fileSize: file.size,
    pageCount: res.pageCount || 0,
    ocrPages: res.ocrPages || [],
    pdfPages: res.pdfPages || [],
    ext,
    text: res.text || '',
  }
}

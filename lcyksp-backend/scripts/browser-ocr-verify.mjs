// 真浏览器验证浏览器端 OCR 全链路：静态服务 /ocr + 语言包 + wasm core，跑一页真实扫描件。
// 放在 lcyksp-backend 下运行（用它的 playwright-core）。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'

const PUB = 'E:/lcyksp-workspace/lcyksp-front/public'
const IMG = 'E:/lcyksp-workspace/tools/kaodian/_fmt/page019.png'
const TEST_IMG = path.join(PUB, '__ocr_test.png')
fs.copyFileSync(IMG, TEST_IMG)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.png': 'image/png',
}

const TEST_HTML = `<!doctype html><meta charset="utf-8"><title>ocr test</title>
<body><div id="out">running</div>
<script type="module">
const log = []
const t0 = Date.now()
// —— 与 src/utils/kaodianOcr.js 保持一致的逻辑（逐字拷贝）——
function blocksToLines(data) {
  const out = []
  for (const b of data?.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    const t = String(l?.text || '').replace(/\\s+/g, ' ').trim()
    if (t && l.bbox) out.push({ text: t, y0: l.bbox.y0, y1: l.bbox.y1 })
  }
  return out
}
function linesToParagraphs(lines) {
  const items = lines.slice().sort((a, b) => a.y0 - b.y0)
  if (!items.length) return ''
  const gaps = []
  for (let i = 1; i < items.length; i++) gaps.push(items[i].y0 - items[i - 1].y1)
  const pos = gaps.filter((g) => g > 0).sort((a, b) => a - b)
  const median = pos.length ? pos[Math.floor(pos.length / 2)] : 0
  const thresh = Math.max(median * 1.5, 3)
  const out = []
  let cur = ''
  for (let i = 0; i < items.length; i++) {
    if (i > 0 && gaps[i - 1] > thresh) { if (cur) out.push(cur); cur = '' }
    cur += items[i].text
  }
  if (cur) out.push(cur)
  return out.join('\\n\\n')
}
function cleanOcrText(s) {
  let t = String(s || '')
    .replace(/[ \\t]+/g, ' ')
    .replace(/[A-Z]{5,}/g, '')
    .replace(/[|｜]{2,}/g, '')
    .replace(/[•·]{2,}/g, '')
  const CJK = '\\\\u4e00-\\\\u9fa5\\\\u3000-\\\\u303f\\\\uff00-\\\\uffef'
  for (let i = 0; i < 3; i++) t = t.replace(new RegExp('([' + CJK + '])[ \\\\t]+(?=[' + CJK + '])', 'g'), '$1')
  return t.replace(/\\n{3,}/g, '\\n\\n').split('\\n').map((l) => l.replace(/\\s+$/, '')).join('\\n').trim()
}
try {
  const T = (await import('/ocr/tesseract.esm.min.js')).default
  log.push('module ok, createWorker=' + typeof T.createWorker)
  const worker = await T.createWorker('chi_sim', T.OEM.LSTM_ONLY, {
    workerPath: '/ocr/worker.min.js',
    corePath: '/ocr/core',
    langPath: '/ocr/lang',
    gzip: true,
    logger: () => {},
  })
  log.push('worker ready ' + ((Date.now()-t0)/1000).toFixed(1) + 's')
  await worker.setParameters({ preserve_interword_spaces: '1' }).catch(() => {})
  const t1 = Date.now()
  const { data } = await worker.recognize('/__ocr_test.png', {}, { blocks: true, text: true })
  log.push('recognize ' + ((Date.now()-t1)/1000).toFixed(1) + 's  conf=' + Math.round(data.confidence))
  log.push('blocks=' + (Array.isArray(data.blocks) ? data.blocks.length : 'none'))
  const lines = blocksToLines(data)
  log.push('lines=' + lines.length)
  const clean = cleanOcrText(linesToParagraphs(lines))
  log.push('clean 后段落数=' + clean.split(/\\n{2,}/).length + ' 空格残留=' + (clean.match(/[\\u4e00-\\u9fa5] [\\u4e00-\\u9fa5]/g) || []).length)
  await worker.terminate()
  window.__ocr = { ok: true, log, text: clean }
} catch (e) {
  window.__ocr = { ok: false, log, error: e.message + ' | ' + (e.stack||'').split('\\n')[1] }
}
<\/script>`

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0])
  if (url === '/' || url === '/test.html') {
    res.writeHead(200, { 'Content-Type': MIME['.html'] })
    return res.end(TEST_HTML)
  }
  const fp = path.join(PUB, url.replace(/^\/+/, ''))
  const fpNorm = fp.replace(/\\/g, '/')
  const pubNorm = PUB.replace(/\\/g, '/')
  if (!fpNorm.startsWith(pubNorm) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404); return res.end('nope')
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' })
  fs.createReadStream(fp).pipe(res)
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
console.log('serving on', port)

const browser = await chromium.launch({
  executablePath: 'C:/Users/12967/AppData/Local/ms-playwright/chromium-1161/chrome-win/chrome.exe',
  args: ['--no-sandbox'],
})
const page = await browser.newPage()
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 200)) })
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)))
await page.goto(`http://127.0.0.1:${port}/test.html`)

const result = await page.waitForFunction('window.__ocr', null, { timeout: 180000 }).then((h) => h.jsonValue())
console.log('\n== 浏览器 OCR 结果 ==')
console.log('ok:', result.ok)
for (const l of result.log) console.log('  ' + l)
if (result.error) console.log('  ERROR:', result.error.slice(0, 400))
if (result.text) {
  console.log('\n--- 识别文本（前 700 字） ---')
  console.log(result.text.trim().slice(0, 700))
}

await browser.close()
server.close()
fs.unlinkSync(TEST_IMG)

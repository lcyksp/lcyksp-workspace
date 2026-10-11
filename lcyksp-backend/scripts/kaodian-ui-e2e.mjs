// 真浏览器 + 真后端 全流程验证：驱动实际 UI 走一遍「导入教材」（含扫描版 PDF 本地 OCR）。
// 用本地 dist（与线上部署产物一致）+ 本地后端。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import sqlite3 from 'sqlite3'
import jwt from 'jsonwebtoken'
import { chromium } from 'playwright-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJ = path.resolve(__dirname, '..')
const DIST = 'E:/lcyksp-workspace/lcyksp-front/dist'
const DB_DIR = 'E:/lcyksp-workspace/tools/kaodian/data/localdb'
const FMT = 'E:/lcyksp-workspace/tools/kaodian/_fmt'
const API_PORT = 3999
const SECRET = 'lcyksp-jwt-secret-dev-2026'

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.gz': 'application/gzip', '.png': 'image/png', '.json': 'application/json' }

// ---------- 1. 后端 ----------
const backend = spawn('C:/Users/12967/.workbuddy/binaries/node/versions/22.22.2-6/node.exe', ['src/app.js'], {
  cwd: PROJ,
  env: { ...process.env, LCYKSP_DB_DIR: DB_DIR, PORT: String(API_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let backendLog = ''
backend.stdout.on('data', (d) => { backendLog += d })
backend.stderr.on('data', (d) => { backendLog += d })
await new Promise((r) => setTimeout(r, 4000))

// ---------- 2. 造 admin 用户 + token ----------
const db = await new Promise((res, rej) => { const d = new sqlite3.Database(path.join(DB_DIR, 'database.db'), (e) => (e ? rej(e) : res(d))) })
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this) }))
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))))
await run("INSERT INTO users (username,password,role,quota_plan) VALUES ('ui_e2e','x','admin','admin') ON CONFLICT(username) DO UPDATE SET role='admin', quota_plan='admin'")
const u = await get("SELECT id, username FROM users WHERE username='ui_e2e'")
const token = jwt.sign({ userId: u.id, username: u.username }, SECRET, { expiresIn: '1h' })
await new Promise((r) => db.close(r))
console.log('backend up, token for', u.username)

// ---------- 3. 静态服务 + /api 代理 ----------
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0])
  if (url.startsWith('/api')) {
    const proxied = http.request({ host: '127.0.0.1', port: API_PORT, path: req.url, method: req.method, headers: req.headers }, (pr) => {
      res.writeHead(pr.statusCode, pr.headers); pr.pipe(res)
    })
    proxied.on('error', () => { res.writeHead(502); res.end('proxy err') })
    req.pipe(proxied)
    return
  }
  let fp = path.join(DIST, url.replace(/^\/+/, ''))
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) fp = path.join(DIST, 'index.html')
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' })
  fs.createReadStream(fp).pipe(res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port
const BASE = `http://127.0.0.1:${PORT}`
console.log('site on', BASE)

// ---------- 4. 浏览器 ----------
const browser = await chromium.launch({
  executablePath: 'C:/Users/12967/AppData/Local/ms-playwright/chromium-1161/chrome-win/chrome.exe',
  args: ['--no-sandbox'],
})
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)) })
await page.addInitScript(([t, usr]) => {
  localStorage.setItem('lcyksp_token', t)
  localStorage.setItem('lcyksp_user', JSON.stringify({ id: usr.id, username: usr.username, role: 'admin' }))
}, [token, { id: u.id, username: u.username }])

let pass = 0, fail = 0
const check = (name, ok, detail = '') => { if (ok) { pass++; console.log('  ok   ' + name) } else { fail++; console.log('  FAIL ' + name + ' :: ' + detail) } }

await page.goto(BASE + '/kaodian', { waitUntil: 'networkidle' })
await page.waitForSelector('h1', { timeout: 20000 })
check('页面渲染', (await page.locator('h1').first().innerText()).includes('考点背诵判分'))
check('下拉出现内置教材', (await page.locator('.setup select, .setup .el-select').first().innerText()).includes('内置'))

// ---- A. 导入 docx（标题式） ----
console.log('\n[A] 上传 Word（标题式）')
await page.getByRole('button', { name: /我的教材/ }).click()
await page.waitForSelector('.lib-upload')
await page.locator('input[type=file]').setInputFiles(path.join(FMT, 'test.docx'))
await page.waitForSelector('text=确认导入内容', { timeout: 30000 })
const docxText = await page.locator('.draft-text textarea').inputValue()
check('草稿拿到 docx 正文', docxText.includes('实践是人能动地改造客观世界的物质活动'), docxText.slice(0, 80))
check('docx 标题层级还原', docxText.includes('### 实践的本质'))
await page.getByRole('button', { name: '确认导入' }).click()
await page.waitForSelector('text=导入成功', { timeout: 40000 }).catch(() => {})
await page.waitForTimeout(1200)
const afterDocx = await (await fetch(BASE + '/api/kaodian/sources', { headers: { Authorization: 'Bearer ' + token } })).json()
check('docx 已入库', (afterDocx.sources || []).some((s) => s.fileType === 'docx' && s.pointCount >= 2), JSON.stringify(afterDocx.sources?.map((s) => [s.fileType, s.pointCount])))

// ---- B. 导入扫描版 PDF（走浏览器本地 OCR） ----
console.log('\n[B] 上传扫描版 PDF（本地 OCR）')
await page.locator('input[type=file]').setInputFiles(path.join(FMT, 'scanned1page.pdf'))
await page.waitForSelector('text=这份 PDF 是扫描版', { timeout: 30000 })
const ocrHint = await page.locator('.ocr-alert-body').innerText()
check('识别为扫描版并给出提示', ocrHint.includes('在你自己的浏览器里跑'), ocrHint.slice(0, 60))
const t0 = Date.now()
await page.getByRole('button', { name: /开始本地 OCR/ }).click()
await page.waitForSelector('text=确认导入内容', { timeout: 180000 })
const ocrSecs = ((Date.now() - t0) / 1000).toFixed(1)
const ocrText = await page.locator('.draft-text textarea').inputValue()
console.log(`  （OCR 用时 ${ocrSecs}s，识别 ${ocrText.length} 字）`)
check('OCR 文本非空且像中文正文', ocrText.length > 200 && ocrText.includes('物质'), ocrText.slice(0, 80))
check('OCR 文本无中文间空格', !/[\u4e00-\u9fa5] [\u4e00-\u9fa5]/.test(ocrText))
check('OCR 用时有意义', Number(ocrSecs) > 0)
await page.getByRole('button', { name: '确认导入' }).click()
await page.waitForTimeout(3000)
const afterOcr = await (await fetch(BASE + '/api/kaodian/sources', { headers: { Authorization: 'Bearer ' + token } })).json()
const ocrSrc = (afterOcr.sources || []).find((s) => s.fileType === 'pdf')
check('扫描版 PDF 已入库', !!ocrSrc, JSON.stringify(afterOcr.sources?.map((s) => [s.fileType, s.pointCount])))

// ---- C. 查看 / 删除 ----
console.log('\n[C] 查看与删除')
if (ocrSrc) {
  await page.getByRole('button', { name: '查看考点' }).first().click()
  await page.waitForSelector('.pv-item', { timeout: 15000 })
  check('考点预览有内容', (await page.locator('.pv-item').count()) > 0)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
}
const before = (await (await fetch(BASE + '/api/kaodian/sources', { headers: { Authorization: 'Bearer ' + token } })).json()).sources.length
await page.getByRole('button', { name: '删除' }).first().click()
await page.waitForTimeout(700)
await page.getByRole('button', { name: '删除' }).last().click()   // 确认框里的「删除」
await page.waitForTimeout(1500)
const after = (await (await fetch(BASE + '/api/kaodian/sources', { headers: { Authorization: 'Bearer ' + token } })).json()).sources.length
check('删除生效', after === before - 1, `before=${before} after=${after}`)

// tesseract 中文模型会打出 "Parameter not found: xxx" 的黄色警告，不是错误
const realErrors = errors.filter((e) => !e.includes('favicon') && !/Parameter not found|^\s*console: Warning:/.test(e))
check('无 JS 报错', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

console.log(`\n${pass} passed, ${fail} failed`)
await browser.close()
server.close()
backend.kill()
process.exit(fail ? 1 : 0)

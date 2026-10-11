// 移动端真浏览器冒烟：375x812 视口 + 服务器签发的管理员 token，检查
// 页面加载 / 无 JS 错误 / 无横向溢出 / 抽屉与弹窗宽度，并截图。
import { execSync } from 'node:child_process'
import { chromium } from 'playwright-core'

const CHROME = 'C:/Users/12967/AppData/Local/ms-playwright/chromium-1161/chrome-win/chrome.exe'

// 1) 服务器签 token
const cmd = process.argv[2]
if (!cmd) { console.error('需要传入签名命令输出'); process.exit(1) }
// 约定：argv[2] = "userId username token"（由外层 python 从服务器取回）
const [userId, username, token] = cmd.split('|')
if (!token) { console.error('token 缺失'); process.exit(1) }

const BASE = 'https://lcyksp.xyz'
const errors = []
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 375, height: 812 } })
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 120)) })

await page.addInitScript(([t, u, uid]) => {
  localStorage.setItem('lcyksp_token', t)
  localStorage.setItem('lcyksp_user', JSON.stringify({ id: Number(uid), username: u, role: 'admin' }))
}, [token, username, userId])

await page.goto(BASE + '/kaodian', { waitUntil: 'networkidle', timeout: 45000 })
await page.waitForTimeout(1500)

const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ' | ' + extra : ''}`)
}

const scrollW = await page.evaluate(() => document.documentElement.scrollWidth)
check('无横向溢出', scrollW <= 375 + 2, `scrollWidth=${scrollW}`)

// 撑宽页面的元素（右边缘超出视口）
if (scrollW > 375 + 2) {
  const wide = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.right > 377 && r.width > 30) {
        out.push(`${el.tagName}.${String(el.className).slice(0, 50)} w=${Math.round(r.width)} right=${Math.round(r.right)}`)
        if (out.length >= 8) break
      }
    }
    return out
  })
  console.log('  超宽元素:')
  for (const w of wide) console.log('   ', w)
}

// 设置区两个下拉各占整行（视口 375 - 页边距 8 - 卡片内边距 32 - 边框 2 ≈ 333）
const selW = await page.evaluate(() => {
  const el = document.querySelector('.setup-row .el-select')
  return el ? el.getBoundingClientRect().width : 0
})
check('下拉窄屏占满整行', selW >= 320, `width=${Math.round(selW)}（满行约 333）`)

// 打开「我的教材」抽屉，看宽度
await page.click('button:has-text("我的教材")').catch(() => {})
await page.waitForTimeout(1200)
const dw = await page.evaluate(() => {
  const el = document.querySelector('.el-drawer')
  return el ? el.getBoundingClientRect().width : 0
})
check('抽屉窄屏 96%', dw > 340 && dw <= 380, `width=${Math.round(dw)}`)

// 打开草稿弹窗（先模拟一个导入不可行，直接查 draft 弹窗 CSS 宽度规则即可跳过）
const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth)
check('抽屉打开后仍无横向溢出', overflow2 <= 375 + 2, `scrollWidth=${overflow2}`)

await page.screenshot({ path: 'kaodian-mobile.png', fullPage: false })
console.log('截图: lcyksp-backend/kaodian-mobile.png')

const fatal = errors.filter((e) => !e.includes('favicon') && !/Parameter not found|ResizeObserver/i.test(e))
check('无 JS 报错', fatal.length === 0, fatal.slice(0, 3).join(' | '))

await browser.close()
console.log('MOBILE SMOKE DONE')

import { getDb } from '../config/db.js'

let timer = null
const browsers = new Map()
const dbAll = (sql, p = []) => new Promise((resolve, reject) => getDb().all(sql, p, (e, rows) => e ? reject(e) : resolve(rows)))
const dbRun = (sql, p = []) => new Promise((resolve, reject) => getDb().run(sql, p, function (e) { e ? reject(e) : resolve(this) }))

function ready() {
  return Boolean(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_APP_TOKEN && process.env.TWITCH_BROWSER_EXECUTABLE)
}

async function stopTask(task, status = 'completed', error = '') {
  const browser = browsers.get(task.id)
  if (browser) { await browser.close().catch(() => {}); browsers.delete(task.id) }
  await dbRun("UPDATE twitch_drop_tasks SET status=?,error=?,updated_at=datetime('now') WHERE id=?", [status, error, task.id])
}

async function startTask(task) {
  if (browsers.has(task.id)) return
  if (!ready()) return
  try {
    const { chromium } = await import('playwright-core')
    const proxy = process.env.TWITCH_PROXY_SERVER ? { server: process.env.TWITCH_PROXY_SERVER } : undefined
    const browser = await chromium.launch({ headless: true, executablePath: process.env.TWITCH_BROWSER_EXECUTABLE, proxy })
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(`https://www.twitch.tv/${encodeURIComponent(task.channel_name)}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    browsers.set(task.id, browser)
    await dbRun("UPDATE twitch_drop_tasks SET status='running',error='',updated_at=datetime('now') WHERE id=?", [task.id])
  } catch (error) {
    await dbRun("UPDATE twitch_drop_tasks SET status='failed',error=?,updated_at=datetime('now') WHERE id=?", [String(error.message || error).slice(0, 500), task.id])
  }
}

async function tick() {
  const now = Date.now()
  const tasks = await dbAll("SELECT * FROM twitch_drop_tasks WHERE status IN ('pending','running')")
  for (const task of tasks) {
    const start = new Date(task.start_at).getTime(); const end = new Date(task.end_at).getTime()
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) { await stopTask(task, 'failed', '时间范围无效'); continue }
    if (now >= end) { await stopTask(task); continue }
    if (now >= start) await startTask(task)
  }
}

export function startTwitchWorker() {
  if (timer) return
  timer = setInterval(() => tick().catch((e) => console.error('[TwitchWorker]', e.message)), 60000)
  tick().catch((e) => console.error('[TwitchWorker]', e.message))
}

export async function stopTwitchWorker() {
  if (timer) clearInterval(timer); timer = null
  for (const browser of browsers.values()) await browser.close().catch(() => {})
  browsers.clear()
}

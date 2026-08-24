import { getDb } from '../config/db.js'
import { calculateGithubGrowth } from './githubRadar.js'
import { sendGithubDigestEmail } from './githubMail.js'

function dbGet(sql, params = []) { return new Promise((resolve, reject) => getDb().get(sql, params, (e, row) => e ? reject(e) : resolve(row))) }
function dbAll(sql, params = []) { return new Promise((resolve, reject) => getDb().all(sql, params, (e, rows) => e ? reject(e) : resolve(rows || []))) }
function dbRun(sql, params = []) { return new Promise((resolve, reject) => getDb().run(sql, params, function onRun(e) { e ? reject(e) : resolve({ lastID: this.lastID, changes: this.changes }) })) }
function esc(value) { return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])) }
function cleanSummary(value) { return String(value || '').replace(/```[\s\S]*?```/g, '').replace(/[*_#`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180) }

function beijingParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false, weekday: 'short' }).formatToParts(now)
  return Object.fromEntries(parts.map((part) => [part.type, part.value]))
}

function dueTypes(now = new Date()) {
  const parts = beijingParts(now)
  if (parts.hour !== '08') return []
  const types = ['daily']
  if (parts.weekday === 'Mon') types.push('weekly')
  if (parts.day === '01') types.push('monthly')
  return types
}

async function buildDigest(subscription, type) {
  const rows = await dbAll('SELECT r.*, a.category, a.summary, a.worth_push FROM github_subscription_repositories sr JOIN github_repositories r ON r.id = sr.repository_id LEFT JOIN github_ai_reviews a ON a.id = r.last_ai_review_id WHERE sr.subscription_id = ? ORDER BY r.stars DESC LIMIT 50', [subscription.id])
  const items = []
  for (const row of rows) {
    const growth = await calculateGithubGrowth(row.id)
    const gain = type === 'monthly' ? growth.monthly : type === 'weekly' ? growth.weekly : growth.daily
    if (gain === null || gain <= 0 || (row.worth_push === 0 && row.worth_push !== null)) continue
    items.push({ row, gain, growth })
  }
  items.sort((a, b) => b.gain - a.gain)
  return items.slice(0, 10)
}

export function renderGithubDigestHtml(items, type = 'daily', dateKey = '') {
  const title = type === 'daily' ? '日报' : type === 'weekly' ? '周报' : '月报'
  const htmlItems = items.length ? items.map(({ row, gain }) => `<li style="margin:0 0 18px"><div style="font-size:17px;color:#172033">${esc(row.full_name)}</div><div style="color:#667085;font-size:13px">${esc(row.language || '多语言')} · Star 增长 +${gain}</div><div style="margin-top:5px">${esc(cleanSummary(row.summary || row.description || '暂无摘要'))}</div><div style="margin-top:5px"><a href="${esc(row.url)}" style="color:#1677ff">查看项目</a></div></li>`).join('') : '<li>本期暂未发现符合订阅方向且增长明显的项目。</li>'
  return `<div style="font-family:Arial,'Microsoft YaHei',sans-serif;line-height:1.65;color:#24243a;max-width:680px"><h2 style="margin:0 0 8px;font-size:22px;font-weight:600">GitHub 技术趋势${title}</h2><p style="margin:0 0 18px;color:#667085">近期 Star 增长较快的项目简报</p><ol style="padding-left:24px;margin:0">${htmlItems}</ol><p style="color:#98a2b3;font-size:12px;margin-top:20px">数据按北京时间统计。新发现项目可能暂时缺少完整周期增长数据。</p></div>`
}

async function sendFor(subscription, type, dateKey) {
  const jobKey = 'github-digest:' + type + ':' + dateKey + ':' + subscription.id
  const existing = await dbGet('SELECT id FROM github_job_runs WHERE job_key = ?', [jobKey])
  if (existing) return false
  const startedAt = new Date().toISOString()
  await dbRun('INSERT INTO github_job_runs (job_key, job_type, status, started_at) VALUES (?, ?, \'running\', ?)', [jobKey, type, startedAt])
  try {
    const items = await buildDigest(subscription, type)
    const html = renderGithubDigestHtml(items, type, dateKey)
    const title = type === 'daily' ? '日报' : type === 'weekly' ? '周报' : '月报'
    await sendGithubDigestEmail(subscription.email, '【GitHub' + title + '】' + dateKey, html)
    await dbRun("UPDATE github_job_runs SET status = 'success', details = ?, finished_at = ? WHERE job_key = ?", [JSON.stringify({ itemCount: items.length, subscriptionId: subscription.id }), new Date().toISOString(), jobKey])
    await dbRun("INSERT INTO github_email_delivery_logs (subscription_id, user_id, email, kind, status) VALUES (?, ?, ?, ?, 'success')", [subscription.id, subscription.user_id, subscription.email, type])
    return true
  } catch (error) {
    await dbRun("UPDATE github_job_runs SET status = 'failed', details = ?, finished_at = ? WHERE job_key = ?", [error.message || '发送失败', new Date().toISOString(), jobKey])
    await dbRun("INSERT INTO github_email_delivery_logs (subscription_id, user_id, email, kind, status, error_message) VALUES (?, ?, ?, ?, 'failed', ?)", [subscription.id, subscription.user_id, subscription.email, type, error.message || '发送失败'])
    console.error('[GitHub Radar] digest failed:', subscription.email, type, error.message)
    return false
  }
}

export async function sendGithubSimulationDigest(to, type = 'daily', dateKey = '') {
  const row = await dbGet('SELECT r.*, a.category, a.summary, a.worth_push FROM github_repositories r LEFT JOIN github_ai_reviews a ON a.id = r.last_ai_review_id ORDER BY r.updated_at DESC LIMIT 1')
  const item = row ? [{ row, gain: 1 }] : []
  const html = renderGithubDigestHtml(item, type, dateKey)
  await sendGithubDigestEmail(to, '【GitHub' + (type === 'daily' ? '日报' : type === 'weekly' ? '周报' : '月报') + '模拟】' + dateKey, html)
  return { itemCount: item.length, repository: row?.full_name || '' }
}

export async function runGithubDigests(now = new Date()) {
  const types = dueTypes(now)
  if (!types.length) return { sent: 0, skipped: true }
  const parts = beijingParts(now)
  const dateKey = parts.year + '-' + parts.month + '-' + parts.day
  const subscriptions = await dbAll("SELECT * FROM github_subscriptions WHERE status = 'active'")
  let sent = 0
  for (const subscription of subscriptions) {
    const frequencies = (() => { try { return JSON.parse(subscription.frequencies) } catch { return ['daily'] } })()
    for (const type of types) if (frequencies.includes(type) && await sendFor(subscription, type, dateKey)) sent += 1
  }
  return { sent, skipped: false }
}

export async function runPendingGithubSimulations(now = new Date()) {
  const rows = await dbAll("SELECT * FROM github_simulation_tasks WHERE status = 'pending' AND run_at <= ? ORDER BY id ASC LIMIT 5", [now.toISOString()])
  for (const task of rows) {
    await dbRun("UPDATE github_simulation_tasks SET status='running' WHERE id=? AND status='pending'", [task.id])
    try {
      const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now)
      const result = await sendGithubSimulationDigest(task.to_email, task.job_type, dateKey)
      await dbRun("UPDATE github_simulation_tasks SET status='success', details=?, finished_at=? WHERE id=?", [JSON.stringify(result), new Date().toISOString(), task.id])
      await dbRun("INSERT OR REPLACE INTO github_job_runs (job_key,job_type,status,details,started_at,finished_at) VALUES (?,?,?,?,?,?)", [task.job_key, 'simulation', 'success', JSON.stringify({ to: task.to_email, ...result }), task.created_at, new Date().toISOString()])
    } catch (error) {
      await dbRun("UPDATE github_simulation_tasks SET status='failed', details=?, finished_at=? WHERE id=?", [String(error.message || '发送失败').slice(0, 500), new Date().toISOString(), task.id])
      console.error('[GitHub Radar] simulation digest failed:', error.message)
    }
  }
  return rows.length
}

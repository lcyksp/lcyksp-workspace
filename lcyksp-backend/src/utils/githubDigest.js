import { getDb } from '../config/db.js'
import { calculateGithubGrowth } from './githubRadar.js'
import { sendGithubDigestEmail } from './githubMail.js'

function dbGet(sql, params = []) { return new Promise((resolve, reject) => getDb().get(sql, params, (e, row) => e ? reject(e) : resolve(row))) }
function dbAll(sql, params = []) { return new Promise((resolve, reject) => getDb().all(sql, params, (e, rows) => e ? reject(e) : resolve(rows || []))) }
function dbRun(sql, params = []) { return new Promise((resolve, reject) => getDb().run(sql, params, function onRun(e) { e ? reject(e) : resolve({ lastID: this.lastID, changes: this.changes }) })) }
function esc(value) { return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])) }

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

async function sendFor(subscription, type, dateKey) {
  const jobKey = 'github-digest:' + type + ':' + dateKey + ':' + subscription.id
  const existing = await dbGet('SELECT id FROM github_job_runs WHERE job_key = ?', [jobKey])
  if (existing) return false
  const startedAt = new Date().toISOString()
  await dbRun('INSERT INTO github_job_runs (job_key, job_type, status, started_at) VALUES (?, ?, \'running\', ?)', [jobKey, type, startedAt])
  try {
    const items = await buildDigest(subscription, type)
    const title = type === 'daily' ? '日报' : type === 'weekly' ? '周报' : '月报'
    const htmlItems = items.length ? items.map(({ row, gain }) => `<li><strong>${esc(row.full_name)}</strong> <span>${esc(row.language || '多语言')} · +${gain} ⭐</span><br>${esc(row.summary || row.description || '暂无摘要')}<br><a href="${esc(row.url)}">查看 GitHub 项目</a></li>`).join('') : '<li>本期暂未发现符合订阅方向且增长明显的项目。</li>'
    const html = `<div style="font-family:Arial,sans-serif;line-height:1.7;color:#24243a"><h2>GitHub 技术趋势${title}</h2><p>这是你的订阅简报，重点展示近期 Star 增长较快的项目。</p><ol>${htmlItems}</ol><p style="color:#777;font-size:12px">数据按北京时间统计。新发现项目可能暂时缺少完整周期增长数据。</p></div>`
    await sendGithubDigestEmail(subscription.email, '【GitHub技术趋势' + title + '】' + dateKey, html)
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

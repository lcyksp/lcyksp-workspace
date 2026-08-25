import { getDb } from '../config/db.js'
import { calculateGithubGrowth, fetchTrendingGithubRepositories, saveGithubSnapshot, MIN_GITHUB_STARS } from './githubRadar.js'
import { fetchGithubRepositoryContext } from './githubRadar.js'
import { reviewGithubRepository } from './githubAi.js'
import { sendGithubDigestEmail } from './githubMail.js'

function dbGet(sql, params = []) { return new Promise((resolve, reject) => getDb().get(sql, params, (e, row) => e ? reject(e) : resolve(row))) }
function dbAll(sql, params = []) { return new Promise((resolve, reject) => getDb().all(sql, params, (e, rows) => e ? reject(e) : resolve(rows || []))) }
function dbRun(sql, params = []) { return new Promise((resolve, reject) => getDb().run(sql, params, function onRun(e) { e ? reject(e) : resolve({ lastID: this.lastID, changes: this.changes }) })) }
function esc(value) { return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])) }
function cleanSummary(value) { return String(value || '').replace(/```[\s\S]*?```/g, '').replace(/[*_#`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 320) }

function beijingParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' }).formatToParts(now)
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
  let rows = await dbAll('SELECT r.*, a.category, a.summary, a.worth_push FROM github_subscription_repositories sr JOIN github_repositories r ON r.id = sr.repository_id LEFT JOIN github_ai_reviews a ON a.id = r.last_ai_review_id WHERE sr.subscription_id = ? AND r.stars >= ? ORDER BY r.stars DESC LIMIT 50', [subscription.id, MIN_GITHUB_STARS])
  const items = []
  for (const row of rows) {
    const growth = await calculateGithubGrowth(row.id)
    const gain = type === 'monthly' ? growth.monthly : type === 'weekly' ? growth.weekly : growth.daily
    if (gain !== null && gain > 0 && !(row.worth_push === 0 && row.worth_push !== null)) items.push({ row, gain, growth, source: 'growth' })
  }
  items.sort((a, b) => b.gain - a.gain)
  if (items.length < 10) {
    let fallback = rows.filter((row) => row.worth_push === 1 && /[\u4e00-\u9fff]/.test(String(row.summary || '')) && !items.some((item) => item.row.id === row.id)).slice(0, 10 - items.length)
    if (fallback.length < 10 - items.length) {
      try {
        const categories = await dbAll('SELECT keywords FROM github_categories WHERE id IN (' + (JSON.parse(subscription.category_ids || '[]').map(() => '?').join(',') || 'NULL') + ')', JSON.parse(subscription.category_ids || '[]'))
        const terms = [...JSON.parse(subscription.keywords || '[]'), ...categories.flatMap((row) => { try { return JSON.parse(row.keywords || '[]') } catch { return [] } })].map((v) => String(v).toLowerCase()).filter(Boolean)
        const trending = await fetchTrendingGithubRepositories({ since: 'daily', limit: 25 })
        for (const candidate of trending) {
          const haystack = (candidate.fullName + ' ' + candidate.description + ' ' + candidate.language).toLowerCase()
          if (terms.length && !terms.some((term) => haystack.includes(term))) continue
          if (Number(candidate.stars || 0) < MIN_GITHUB_STARS) continue
          const saved = await saveGithubSnapshot(candidate)
          if (!saved.id) continue
          if (rows.some((row) => row.id === saved.id) || items.some((item) => item.row.id === saved.id) || fallback.some((row) => row.id === saved.id)) continue
          await dbRun('INSERT INTO github_subscription_repositories (subscription_id, repository_id, first_matched_at, last_matched_at) VALUES (?, ?, ?, ?) ON CONFLICT(subscription_id, repository_id) DO UPDATE SET last_matched_at=excluded.last_matched_at', [subscription.id, saved.id, new Date().toISOString(), new Date().toISOString()])
          try {
            const context = await fetchGithubRepositoryContext(candidate.fullName, { includeCode: false })
            await reviewGithubRepository({ ...context, ...candidate, full_name: candidate.fullName, id: saved.id }, { codeContext: false })
          } catch (error) { console.error('[GitHub Radar] trending AI review failed:', candidate.fullName, error.message); continue }
          const reviewed = await dbGet('SELECT r.*, a.summary, a.worth_push FROM github_repositories r LEFT JOIN github_ai_reviews a ON a.id=r.last_ai_review_id WHERE r.id=?', [saved.id])
          if (!reviewed || reviewed.worth_push !== 1 || !/[\u4e00-\u9fff]/.test(String(reviewed.summary || ''))) continue
          fallback.push(reviewed)
          if (fallback.length >= 10 - items.length) break
        }
        rows = rows.concat(fallback)
      } catch (error) { console.error('[GitHub Radar] trending fallback failed:', error.message) }
    }
    items.push(...fallback.map((row) => ({ row, gain: null, growth: {}, source: 'recent' })))
  }
  return items.slice(0, 10)
}

export function renderGithubDigestHtml(items, type = 'daily', dateKey = '') {
  const title = type === 'daily' ? '日报' : type === 'weekly' ? '周报' : '月报'
  const htmlItems = items.length ? items.map(({ row, gain, growth }) => { const stars = growth?.currentStars ?? row.stars ?? 0; const metric = gain === null ? '近期热门 / 新发现' : '24 小时 Star +' + gain; const summary = row.summary && /[\u4e00-\u9fff]/.test(row.summary) ? row.summary : '项目已进入关注列表，中文技术摘要将在下一轮 AI 审核后补充。'; return `<li style="margin:0 0 18px"><div style="font-size:17px;color:#172033">${esc(row.full_name)}</div><div style="color:#667085;font-size:13px">${esc(row.language || '多语言')} · 当前 Star ${stars.toLocaleString()} · ${metric}</div><div style="margin-top:5px">${esc(cleanSummary(summary))}</div><div style="margin-top:5px"><a href="${esc(row.url)}" style="color:#1677ff">查看项目</a></div></li>` }).join('') : '<li>本期暂未发现符合订阅方向且增长明显的项目。</li>'
  return `<div style="font-family:Arial,'Microsoft YaHei',sans-serif;line-height:1.65;color:#24243a;max-width:680px"><h2 style="margin:0 0 8px;font-size:22px;font-weight:600">GitHub ${title}</h2><p style="margin:0 0 18px;color:#667085">近期 Star 增长较快的项目简报</p><ol style="padding-left:24px;margin:0">${htmlItems}</ol><p style="color:#98a2b3;font-size:12px;margin-top:20px">数据按北京时间统计。新发现项目可能暂时缺少完整周期增长数据。</p><p style="color:#98a2b3;font-size:12px;margin-top:8px">本邮件由系统自动发送，无需回复。</p></div>`
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

async function prepareGithubDigestDrafts(now = new Date()) {
  const parts = beijingParts(now)
  if (parts.hour !== '07' || Number(parts.minute) > 30) return 0
  const dateKey = parts.year + '-' + parts.month + '-' + parts.day
  const subscriptions = await dbAll("SELECT * FROM github_subscriptions WHERE status = 'active'")
  let index = 0
  for (const subscription of subscriptions) {
    const frequencies = (() => { try { return JSON.parse(subscription.frequencies) } catch { return ['daily'] } })()
    for (const type of ['daily', 'weekly', 'monthly']) {
      if (!frequencies.includes(type)) continue
      const draftKey = 'github-draft:' + type + ':' + dateKey + ':' + subscription.id
      if (await dbGet('SELECT id FROM github_digest_drafts WHERE draft_key = ?', [draftKey])) continue
      const items = await buildDigest(subscription, type)
      const html = renderGithubDigestHtml(items, type, dateKey)
      const sendAt = new Date(new Date(`${dateKey}T07:50:00+08:00`).getTime() + Math.min(index * 5000, 9 * 60 * 1000 + 5000)).toISOString()
      await dbRun('INSERT INTO github_digest_drafts (draft_key,subscription_id,job_type,date_key,html,item_count,status,send_at,created_at) VALUES (?,?,?,?,?,?,\'locked\',?,?)', [draftKey, subscription.id, type, dateKey, html, items.length, sendAt, now.toISOString()])
      index += 1
    }
  }
  return index
}

async function sendLockedGithubDigestDrafts(now = new Date()) {
  const rows = await dbAll("SELECT d.*, s.email, s.user_id FROM github_digest_drafts d JOIN github_subscriptions s ON s.id=d.subscription_id WHERE d.status='locked' AND d.send_at <= ? ORDER BY d.send_at ASC LIMIT 10", [now.toISOString()])
  let sent = 0
  for (const draft of rows) {
    try {
      const title = draft.job_type === 'daily' ? '日报' : draft.job_type === 'weekly' ? '周报' : '月报'
      await sendGithubDigestEmail(draft.email, '【GitHub' + title + '】' + draft.date_key, draft.html)
      await dbRun("UPDATE github_digest_drafts SET status='sent', sent_at=? WHERE id=?", [new Date().toISOString(), draft.id])
      await dbRun("INSERT OR REPLACE INTO github_job_runs (job_key,job_type,status,details,started_at,finished_at) VALUES (?,?,'success',?,?,?)", ['github-digest:' + draft.job_type + ':' + draft.date_key + ':' + draft.subscription_id, draft.job_type, JSON.stringify({ itemCount: draft.item_count, subscriptionId: draft.subscription_id, prepared: true }), draft.created_at, new Date().toISOString()])
      await dbRun("INSERT INTO github_email_delivery_logs (subscription_id,user_id,email,kind,status) VALUES (?,?,?,?,'success')", [draft.subscription_id, draft.user_id, draft.email, draft.job_type])
      sent += 1
    } catch (error) { console.error('[GitHub Radar] locked digest failed:', draft.email, error.message) }
  }
  return sent
}

export async function sendGithubSimulationDigest(to, type = 'daily', dateKey = '') {
  const subscription = await dbGet("SELECT * FROM github_subscriptions WHERE status = 'active' ORDER BY id LIMIT 1")
  const item = subscription ? await buildDigest(subscription, type) : []
  const html = renderGithubDigestHtml(item, type, dateKey)
  await sendGithubDigestEmail(to, '【GitHub' + (type === 'daily' ? '日报' : type === 'weekly' ? '周报' : '月报') + '模拟】' + dateKey, html)
  return { itemCount: item.length, repository: item[0]?.row?.full_name || '' }
}

export async function runGithubDigests(now = new Date()) {
  const prepared = await prepareGithubDigestDrafts(now)
  const sent = await sendLockedGithubDigestDrafts(now)
  return { sent, prepared, skipped: !prepared && !sent }
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

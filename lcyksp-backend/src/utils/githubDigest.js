import { getDb } from '../config/db.js'
import { calculateGithubGrowth, fetchTrendingGithubRepositories, getGithubSubscriptionFocus, saveGithubSnapshot, MIN_GITHUB_STARS } from './githubRadar.js'
import { fetchGithubRepositoryContext } from './githubRadar.js'
import { reviewGithubRepository, reviewGithubSubscriptionRelevance } from './githubAi.js'
import { sendGithubDigestEmail } from './githubMail.js'

function dbGet(sql, params = []) { return new Promise((resolve, reject) => getDb().get(sql, params, (e, row) => e ? reject(e) : resolve(row))) }
function dbAll(sql, params = []) { return new Promise((resolve, reject) => getDb().all(sql, params, (e, rows) => e ? reject(e) : resolve(rows || []))) }
function dbRun(sql, params = []) { return new Promise((resolve, reject) => getDb().run(sql, params, function onRun(e) { e ? reject(e) : resolve({ lastID: this.lastID, changes: this.changes }) })) }
function esc(value) { return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])) }
function cleanSummary(value) { return String(value || '').replace(/```[\s\S]*?```/g, '').replace(/[*_#`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 320) }

// 推送冷却期：上次入选后 N 天内的项目不参与常规补位，先由趋势榜/近期热门补位，仍不满才让冷却期内的快速增长项目垫底，避免同一项目连续霸榜
const DIGEST_COOLDOWN_DAYS = { daily: 3, weekly: 21, monthly: 60 }
const digestRelevanceWarmups = new Map()

function isPushCooled(pushHistory, repositoryId, cooldownDays) {
  const history = pushHistory.get(repositoryId)
  return history !== undefined && history.ageDays < cooldownDays
}

async function loadPushHistory(subscriptionId, type, now = new Date()) {
  const rows = await dbAll('SELECT repository_id, pushed_at, push_count FROM github_digest_pushes WHERE subscription_id = ? AND job_type = ?', [subscriptionId, type])
  const history = new Map()
  for (const row of rows) history.set(row.repository_id, { ageDays: (now.getTime() - new Date(row.pushed_at).getTime()) / 86400000, pushCount: Number(row.push_count || 1) })
  return history
}

async function recordDigestPushes(subscriptionId, type, repositoryIds, now = new Date()) {
  for (const repositoryId of repositoryIds) {
    await dbRun('INSERT INTO github_digest_pushes (subscription_id, repository_id, job_type, pushed_at, push_count) VALUES (?, ?, ?, ?, 1) ON CONFLICT(subscription_id, repository_id, job_type) DO UPDATE SET pushed_at = excluded.pushed_at, push_count = push_count + 1', [subscriptionId, type, repositoryId, now.toISOString()])
  }
}

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

function isDigestTypeDue(parts, type) {
  if (type === 'daily') return true
  if (type === 'weekly') return parts.weekday === 'Mon'
  if (type === 'monthly') return parts.day === '01'
  return false
}

async function warmSubscriptionRelevance(subscription, targetCount = 10) {
  const warmupKey = String(subscription.id)
  const previousWarmup = digestRelevanceWarmups.get(warmupKey) || 0
  if (Date.now() - previousWarmup < 10 * 60 * 1000) return 0
  digestRelevanceWarmups.set(warmupKey, Date.now())
  const approved = await dbGet("SELECT COUNT(*) AS count FROM github_subscription_repositories WHERE subscription_id=? AND relevance_status='approved'", [subscription.id])
  const missing = Math.max(0, targetCount - Number(approved?.count || 0))
  if (!missing) return 0
  const candidates = await dbAll(
    `SELECT r.*, a.summary, a.worth_push
     FROM github_subscription_repositories sr
     JOIN github_repositories r ON r.id=sr.repository_id
     JOIN github_ai_reviews a ON a.id=r.last_ai_review_id
     WHERE sr.subscription_id=? AND sr.relevance_status='pending' AND a.worth_push=1 AND r.stars>=? AND a.summary<>''
     ORDER BY COALESCE((SELECT MAX(gs.stars)-MIN(gs.stars) FROM github_star_snapshots gs WHERE gs.repository_id=r.id AND datetime(replace(gs.captured_at,'T',' '))>=datetime('now','-2 days')),0) DESC,
              COALESCE((SELECT MAX(gs.stars)-MIN(gs.stars) FROM github_star_snapshots gs WHERE gs.repository_id=r.id),0) DESC,
              r.last_seen_at DESC, r.stars DESC LIMIT ?`,
    [subscription.id, MIN_GITHUB_STARS, Math.min(20, Math.max(10, missing * 2))],
  )
  if (!candidates.length) return 0
  const focus = await getGithubSubscriptionFocus(subscription)
  let approvedNow = 0
  for (const repository of candidates) {
    try {
      const relevance = await reviewGithubSubscriptionRelevance(repository, focus)
      if (!relevance) continue
      await dbRun('UPDATE github_subscription_repositories SET relevance_status=?, relevance_score=?, relevance_reason=?, relevance_reviewed_at=? WHERE subscription_id=? AND repository_id=?', [relevance.relevant ? 'approved' : 'rejected', relevance.confidence, relevance.reason, new Date().toISOString(), subscription.id, repository.id])
      if (relevance.relevant) approvedNow += 1
    } catch (error) { console.error('[GitHub Radar] digest relevance warmup failed:', repository.full_name, error.message) }
  }
  return approvedNow
}

export async function buildDigest(subscription, type) {
  await warmSubscriptionRelevance(subscription, 10)
  const cooldownDays = DIGEST_COOLDOWN_DAYS[type] || DIGEST_COOLDOWN_DAYS.daily
  const pushHistory = await loadPushHistory(subscription.id, type, new Date())
  let rows = await dbAll("SELECT r.*, a.category, a.summary, a.worth_push FROM github_subscription_repositories sr JOIN github_repositories r ON r.id = sr.repository_id LEFT JOIN github_ai_reviews a ON a.id = r.last_ai_review_id WHERE sr.subscription_id = ? AND sr.relevance_status = 'approved' AND r.stars >= ? ORDER BY r.last_seen_at DESC, r.stars DESC LIMIT 500", [subscription.id, MIN_GITHUB_STARS])
  const fresh = []
  const historical = []
  const cooled = []
  const evergreen = []
  for (const row of rows) {
    const growth = await calculateGithubGrowth(row.id)
    const gain = type === 'monthly' ? growth.monthly : type === 'weekly' ? growth.weekly : growth.daily
    if (row.worth_push !== 1 || !/[\u4e00-\u9fff]/.test(String(row.summary || ''))) continue
    const item = { row, gain: gain !== null && gain > 0 ? gain : null, growth, source: gain !== null && gain > 0 ? 'growth' : 'recent' }
    if (isPushCooled(pushHistory, row.id, cooldownDays)) cooled.push(item)
    else if (item.gain !== null) fresh.push(item)
    else if (!pushHistory.has(row.id) && Number(growth.observed || 0) > 0) historical.push({ ...item, source: 'historical', observedGain: growth.observed })
    else evergreen.push(item)
  }
  fresh.sort((a, b) => b.gain - a.gain)
  historical.sort((a, b) => b.observedGain - a.observedGain)
  evergreen.sort((a, b) => new Date(b.row.last_seen_at).getTime() - new Date(a.row.last_seen_at).getTime() || b.row.stars - a.row.stars)
  cooled.sort((a, b) => {
    const aHistory = pushHistory.get(a.row.id) || { ageDays: cooldownDays, pushCount: 0 }
    const bHistory = pushHistory.get(b.row.id) || { ageDays: cooldownDays, pushCount: 0 }
    const score = (item, history) => (item.gain || 0) * 1000 + history.ageDays * 20 + Math.log10(Math.max(10, item.row.stars)) * 10 - history.pushCount * 100
    return score(b, bHistory) - score(a, aHistory)
  })
  const items = []
  const selectedIds = new Set()
  const appendItems = (candidates) => {
    for (const item of candidates) {
      if (items.length >= 10) break
      if (selectedIds.has(item.row.id)) continue
      selectedIds.add(item.row.id)
      items.push(item)
    }
  }
  appendItems([...fresh, ...historical].sort((a, b) => ((b.gain ?? b.observedGain * 0.8) - (a.gain ?? a.observedGain * 0.8))))
  if (items.length < 10) {
    try {
      const categories = await dbAll('SELECT keywords FROM github_categories WHERE id IN (' + (JSON.parse(subscription.category_ids || '[]').map(() => '?').join(',') || 'NULL') + ')', JSON.parse(subscription.category_ids || '[]'))
      const terms = [...JSON.parse(subscription.keywords || '[]'), ...categories.flatMap((row) => { try { return JSON.parse(row.keywords || '[]') } catch { return [] } })].map((v) => String(v).toLowerCase()).filter(Boolean)
      const trendingSets = await Promise.all(['daily', 'weekly'].map((since) => fetchTrendingGithubRepositories({ since, limit: 25 }).catch(() => [])))
      const trending = [...new Map(trendingSets.flat().map((candidate) => [candidate.fullName, candidate])).values()]
      const focus = await getGithubSubscriptionFocus(subscription)
        for (const candidate of trending) {
          if (items.length >= 10) break
          const haystack = (candidate.fullName + ' ' + candidate.description + ' ' + candidate.language).toLowerCase()
          if (terms.length && !terms.some((term) => haystack.includes(term))) continue
          if (Number(candidate.stars || 0) < MIN_GITHUB_STARS) continue
          const saved = await saveGithubSnapshot(candidate)
          if (!saved.id) continue
          if (selectedIds.has(saved.id) || isPushCooled(pushHistory, saved.id, cooldownDays)) continue
          await dbRun('INSERT INTO github_subscription_repositories (subscription_id, repository_id, first_matched_at, last_matched_at) VALUES (?, ?, ?, ?) ON CONFLICT(subscription_id, repository_id) DO UPDATE SET last_matched_at=excluded.last_matched_at', [subscription.id, saved.id, new Date().toISOString(), new Date().toISOString()])
          const association = await dbGet('SELECT relevance_status FROM github_subscription_repositories WHERE subscription_id=? AND repository_id=?', [subscription.id, saved.id])
          if (association?.relevance_status === 'rejected') continue
          let reviewed = await dbGet('SELECT r.*, a.summary, a.worth_push FROM github_repositories r LEFT JOIN github_ai_reviews a ON a.id=r.last_ai_review_id WHERE r.id=?', [saved.id])
          if (!reviewed?.summary) {
          try {
            const context = await fetchGithubRepositoryContext(candidate.fullName, { includeCode: false })
            await reviewGithubRepository({ ...context, ...candidate, full_name: candidate.fullName, id: saved.id }, { codeContext: false })
          } catch (error) { console.error('[GitHub Radar] trending AI review failed:', candidate.fullName, error.message); continue }
            reviewed = await dbGet('SELECT r.*, a.summary, a.worth_push FROM github_repositories r LEFT JOIN github_ai_reviews a ON a.id=r.last_ai_review_id WHERE r.id=?', [saved.id])
          }
          if (!reviewed || reviewed.worth_push !== 1 || !/[\u4e00-\u9fff]/.test(String(reviewed.summary || ''))) continue
          if (association?.relevance_status !== 'approved') {
            try {
              const relevance = await reviewGithubSubscriptionRelevance(reviewed, focus)
              if (!relevance) continue
              await dbRun('UPDATE github_subscription_repositories SET relevance_status=?, relevance_score=?, relevance_reason=?, relevance_reviewed_at=? WHERE subscription_id=? AND repository_id=?', [relevance.relevant ? 'approved' : 'rejected', relevance.confidence, relevance.reason, new Date().toISOString(), subscription.id, saved.id])
              if (!relevance.relevant) continue
            } catch (error) { console.error('[GitHub Radar] trending relevance review failed:', candidate.fullName, error.message); continue }
          }
          selectedIds.add(reviewed.id)
          items.push({ row: reviewed, gain: null, growth: {}, source: 'trending' })
        }
    } catch (error) { console.error('[GitHub Radar] trending fallback failed:', error.message) }
  }
  appendItems(evergreen)
  // 最后一层才复用冷却期项目；增长、距离上次推送时间与累计推送次数共同决定顺序。
  appendItems(cooled)
  return items.slice(0, 10)
}

export function renderGithubDigestHtml(items, type = 'daily', dateKey = '') {
  const title = type === 'daily' ? '日报' : type === 'weekly' ? '周报' : '月报'
  const growthLabel = type === 'daily' ? '24 小时' : type === 'weekly' ? '7 天' : '30 天'
  const reviewedItems = items.filter(({ row }) => row.worth_push === 1 && /[\u4e00-\u9fff]/.test(String(row.summary || '')))
  const htmlItems = reviewedItems.length ? reviewedItems.map(({ row, gain, growth, source, observedGain }) => { const stars = growth?.currentStars ?? row.stars ?? 0; const metric = source === 'historical' ? `曾快速增长 Star +${observedGain} / 新发现` : gain === null ? '近期热门 / 新发现' : `${growthLabel} Star +${gain}`; return `<li style="margin:0 0 18px"><div style="font-size:17px;color:#172033">${esc(row.full_name)}</div><div style="color:#667085;font-size:13px">${esc(row.language || '多语言')} · 当前 Star ${stars.toLocaleString()} · ${metric}</div><div style="margin-top:5px">${esc(cleanSummary(row.summary))}</div><div style="margin-top:5px"><a href="${esc(row.url)}" style="color:#1677ff">查看项目</a></div></li>` }).join('') : '<li>本期暂未发现符合订阅方向且已完成中文 AI 审核的项目。</li>'
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
    await recordDigestPushes(subscription.id, type, items.map((item) => item.row.id))
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
      if (!isDigestTypeDue(parts, type)) continue
      const draftKey = 'github-draft:' + type + ':' + dateKey + ':' + subscription.id
      if (await dbGet('SELECT id FROM github_digest_drafts WHERE draft_key = ?', [draftKey])) continue
      const items = await buildDigest(subscription, type)
      // 07:25 前不足 10 个时暂不锁稿，留给后续轮询继续审核和补位。
      if (items.length < 10 && Number(parts.minute) < 25) {
        console.log(`[GitHub Radar] digest draft waiting subscription=${subscription.id} type=${type} items=${items.length}`)
        continue
      }
      const html = renderGithubDigestHtml(items, type, dateKey)
      const sendAt = new Date(new Date(`${dateKey}T07:50:00+08:00`).getTime() + Math.min(index * 5000, 9 * 60 * 1000 + 5000)).toISOString()
      const itemIds = JSON.stringify(items.map((item) => item.row.id))
      await dbRun('INSERT INTO github_digest_drafts (draft_key,subscription_id,job_type,date_key,html,item_count,item_ids,status,send_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [draftKey, subscription.id, type, dateKey, html, items.length, itemIds, 'locked', sendAt, now.toISOString()])
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
      try {
        await recordDigestPushes(draft.subscription_id, draft.job_type, JSON.parse(draft.item_ids || '[]'))
      } catch (error) { console.error('[GitHub Radar] record digest pushes failed:', draft.email, error.message) }
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

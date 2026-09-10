import { createHash } from 'node:crypto'
import { getSiteMonitorDb } from '../config/db.js'
import { sendSiteMonitorEmail } from './githubMail.js'
import { enqueueSiteMonitorDbWork } from './siteMonitorQueue.js'

const MAX_ATTEMPTS = 5
const FIRST_RETRY_SECONDS = 300
const MAX_RETRY_SECONDS = 3600
const STALE_SENDING_MINUTES = 10
const MAX_BATCH = 5
const MAX_LISTED_EVENTS = 100
const MAX_SUBJECT_LENGTH = 200

const EVENT_SECTIONS = [
  { eventType: 'model_added', label: '新增模型', summary: (count) => `新增 ${count} 个模型` },
  { eventType: 'model_removed', label: '下架模型', summary: (count) => `下架 ${count} 个模型` },
  { eventType: 'announcement_added', label: '新公告', summary: (count) => `${count} 条新公告` },
]

let deliveryLoopInFlight = null

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => getSiteMonitorDb().all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows || []))))
}
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => getSiteMonitorDb().run(sql, params, function onRun(error) {
    if (error) reject(error)
    else resolve({ lastID: this.lastID, changes: this.changes })
  }))
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}

function headerText(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim()
}

function publicError(error) {
  return String(error?.message || '邮件投递失败')
    .replace(/(authorization|cookie|bearer|token|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 500)
}

function retryExpression(attemptCount) {
  const seconds = Math.min(MAX_RETRY_SECONDS, FIRST_RETRY_SECONDS * (2 ** Math.max(0, attemptCount - 1)))
  return `+${seconds} seconds`
}

/**
 * Deterministic identity of one notification batch. The same detected events always produce the
 * same key, so a repeated or retried monitor run can never queue a second copy of the same email.
 */
export function createDeliveryKey(source, eventKeys) {
  const keys = [...new Set(eventKeys.map((key) => String(key || '').trim()).filter(Boolean))].sort()
  if (!keys.length) throw new TypeError('Delivery key requires at least one event key')
  return createHash('sha256').update(JSON.stringify([String(source || ''), keys]), 'utf8').digest('hex')
}

function safeLink(url) {
  const text = String(url || '').trim()
  return /^https:\/\/[^\s"'<>]+$/i.test(text) ? text : ''
}

function renderEventRow(event) {
  const link = safeLink(event.url)
  const title = escapeHtml(event.title)
  const meta = event.publishedAt ? `<div style="color:#98a2b3;font-size:12px;margin-top:2px">${escapeHtml(event.publishedAt)}</div>` : ''
  const heading = link
    ? `<a href="${escapeHtml(link)}" style="color:#1677ff;text-decoration:none">${title}</a>`
    : title
  return `<li style="margin:0 0 10px"><div style="font-size:15px;color:#172033">${heading}</div>${meta}</li>`
}

/** Build the frozen subject and body for one batch of events. */
export function renderSiteMonitorEmail(displayName, events) {
  const list = Array.isArray(events) ? events.filter((event) => event && event.eventType) : []
  if (!list.length) throw new TypeError('Site monitor email requires at least one event')

  const summaries = []
  const sections = []
  let listed = 0
  for (const section of EVENT_SECTIONS) {
    const matched = list.filter((event) => event.eventType === section.eventType)
    if (!matched.length) continue
    summaries.push(section.summary(matched.length))
    const visible = matched.slice(0, Math.max(0, MAX_LISTED_EVENTS - listed))
    listed += visible.length
    const hidden = matched.length - visible.length
    const more = hidden > 0 ? `<li style="color:#98a2b3;font-size:13px">另有 ${hidden} 项未在邮件中列出</li>` : ''
    sections.push(`<h3 style="margin:18px 0 8px;font-size:16px;font-weight:600;color:#24243a">${escapeHtml(section.label)}（${matched.length}）</h3><ul style="padding-left:20px;margin:0">${visible.map(renderEventRow).join('')}${more}</ul>`)
  }

  const name = headerText(displayName) || '网站监测'
  const subject = headerText(`【网站监测】${name}：${summaries.join('、')}`).slice(0, MAX_SUBJECT_LENGTH)
  const html = `<div style="font-family:Arial,'Microsoft YaHei',sans-serif;line-height:1.65;color:#24243a;max-width:680px"><h2 style="margin:0 0 6px;font-size:21px;font-weight:600">${escapeHtml(name)}</h2><p style="margin:0;color:#667085;font-size:13px">${escapeHtml(summaries.join(' · '))}</p>${sections.join('')}<p style="color:#98a2b3;font-size:12px;margin-top:22px">本邮件由 lcyksp.xyz 网站监测自动发送，无需回复。</p></div>`
  return { subject, html }
}

/**
 * Persist one notification batch as a pending delivery. Runs with plain statements so the caller can
 * commit it inside the same transaction that inserted the events, which also means the caller must
 * already hold the site monitor statement queue — wrapping this call again would deadlock.
 */
export async function queueSiteMonitorDelivery(monitor, events) {
  const list = Array.isArray(events) ? events.filter((event) => event && event.eventKey) : []
  if (!list.length) return null

  const deliveryKey = createDeliveryKey(monitor.source, list.map((event) => event.eventKey))
  const { subject, html } = renderSiteMonitorEmail(monitor.display_name, list)
  const recipient = headerText(monitor.recipient_email)
  const eventIds = JSON.stringify(list.map((event) => event.id).filter((id) => Number.isInteger(id)))
  const result = await dbRun(
    `INSERT INTO site_monitor_deliveries (monitor_id, dedupe_key, event_ids_json, recipient_email, subject, body_html)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedupe_key) DO NOTHING`,
    [monitor.id, deliveryKey, eventIds, recipient, subject, html],
  )
  return { deliveryKey, subject, recipient, eventCount: list.length, queued: result.changes > 0 }
}

/**
 * Health alerts are deliberately not "change notifications": they tell the administrator that a
 * monitor stopped being able to read its source and needs a human action, most often pasting a fresh
 * JustWoker login session. They share the delivery table so retries, locking and dedupe come free.
 */
const ALERT_TYPES = new Set(['monitor_failed', 'monitor_recovered'])

const CREDENTIAL_ACTION = "登录会话已经失效。请在 lcyksp.xyz 管理后台的「网站监测」页，重新粘贴 JustWoker 的登录会话 Cookie，点「诊断」确认能读到模型，再点「立即检查」。"

function renderMetaRow(label, value) {
  if (!value) return ''
  return `<div style="margin:2px 0"><span style="color:#98a2b3">${escapeHtml(label)}：</span>${escapeHtml(value)}</div>`
}

/**
 * Stored timestamps are SQLite UTC strings without a zone marker. Rendering one verbatim would read
 * eight hours early for the recipient, so the alert email always converts to Beijing time.
 */
export function beijingTime(storedUtc) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(storedUtc || '').trim())
  if (!match) return ''
  const shifted = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +(match[6] || 0)) + 8 * 3600 * 1000)
  const pad = (value) => String(value).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
}

/** Build the frozen subject and body for one monitor health alert. */
export function renderSiteMonitorAlertEmail(displayName, alert) {
  const eventType = String(alert?.eventType || '')
  if (!ALERT_TYPES.has(eventType)) throw new TypeError('Site monitor alert requires a monitor_failed or monitor_recovered event')

  const name = headerText(displayName) || '网站监测'
  const recovered = eventType === 'monitor_recovered'
  const headline = headerText(alert?.headline) || (recovered ? '检查已恢复正常' : '检查失败，需要处理')
  const outageStarted = beijingTime(alert?.outageStartedAt)
  // The recovery mail reports how long the monitor was down; the failure mail reports what broke it.
  const detail = headerText(recovered
    ? (outageStarted ? `故障开始于北京时间 ${outageStarted}。` : '')
    : publicError({ message: alert?.detail }))
  const summary = recovered ? '监测已恢复' : '监测中断'

  const accent = recovered ? '#52c41a' : '#fa8c16'
  const background = recovered ? '#f6ffed' : '#fff7e6'
  const detailLine = detail ? `<div style="color:#667085;font-size:13px;margin-top:6px">${escapeHtml(detail)}</div>` : ''
  const box = `<div style="margin:14px 0;padding:12px 14px;background:${background};border-left:3px solid ${accent};border-radius:4px"><div style="font-size:15px;color:#172033">${escapeHtml(headline)}</div>${detailLine}</div>`

  const failureCount = Number(alert?.consecutiveFailures)
  const meta = [
    renderMetaRow('连续失败', Number.isFinite(failureCount) && failureCount > 0 ? `${failureCount} 次` : ''),
    renderMetaRow('最近成功', beijingTime(alert?.lastSuccessAt) ? `${beijingTime(alert.lastSuccessAt)}（北京时间）` : ''),
    renderMetaRow('目标地址', alert?.targetUrl ? String(alert.targetUrl) : ''),
  ].join('')

  // Only a rejected credential is actionable by the administrator; other failures just report state.
  const action = !recovered && alert?.credentialRejected
    ? `<p style="margin:16px 0 0;font-size:14px;color:#172033">${escapeHtml(CREDENTIAL_ACTION)}</p>`
    : ''

  const subject = headerText(`【网站监测】${name}：${headline}`).slice(0, MAX_SUBJECT_LENGTH)
  const html = `<div style="font-family:Arial,'Microsoft YaHei',sans-serif;line-height:1.65;color:#24243a;max-width:680px"><h2 style="margin:0 0 6px;font-size:21px;font-weight:600">${escapeHtml(name)}</h2><p style="margin:0;color:#667085;font-size:13px">${escapeHtml(summary)}</p>${box}<div style="font-size:13px;color:#475467">${meta}</div>${action}<p style="color:#98a2b3;font-size:12px;margin-top:22px">本邮件由 lcyksp.xyz 网站监测自动发送，无需回复。</p></div>`
  return { subject, html }
}

/**
 * Persist one health alert as a pending delivery. Same contract as queueSiteMonitorDelivery: plain
 * statements, so the caller must already hold the statement queue and commits it in its transaction.
 */
export async function queueSiteMonitorAlertDelivery(monitor, alert) {
  const eventKey = String(alert?.eventKey || '').trim()
  if (!eventKey) return null

  const deliveryKey = createDeliveryKey(monitor.source, [eventKey])
  const { subject, html } = renderSiteMonitorAlertEmail(monitor.display_name, alert)
  const eventIds = JSON.stringify(Number.isInteger(alert?.id) ? [alert.id] : [])
  const result = await dbRun(
    `INSERT INTO site_monitor_deliveries (monitor_id, dedupe_key, event_ids_json, recipient_email, subject, body_html)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedupe_key) DO NOTHING`,
    [monitor.id, deliveryKey, eventIds, headerText(monitor.recipient_email), subject, html],
  )
  return { deliveryKey, subject, eventType: alert.eventType, queued: result.changes > 0 }
}

/** Interrupted sends must not stay locked forever, and must not retry past the attempt ceiling. */
async function recoverStaleDeliveries() {
  const staleWindow = `-${STALE_SENDING_MINUTES} minutes`
  await dbRun(
    `UPDATE site_monitor_deliveries SET status = 'failed', error_message = '投递过程中断且已达到重试上限', updated_at = datetime('now')
     WHERE status = 'sending' AND attempt_count >= ?
       AND (last_attempt_at IS NULL OR last_attempt_at <= datetime('now', ?))`,
    [MAX_ATTEMPTS, staleWindow],
  )
  await dbRun(
    `UPDATE site_monitor_deliveries SET status = 'pending', next_attempt_at = datetime('now'),
       error_message = '上一次投递中断，已重新排队', updated_at = datetime('now')
     WHERE status = 'sending' AND (last_attempt_at IS NULL OR last_attempt_at <= datetime('now', ?))`,
    [staleWindow],
  )
}

async function deliverOne(delivery, sendImpl) {
  // Locking by dedupe key before the SMTP call keeps overlapping heartbeats from sending twice.
  const claimed = await enqueueSiteMonitorDbWork(() => dbRun(
    `UPDATE site_monitor_deliveries SET status = 'sending', attempt_count = attempt_count + 1,
       last_attempt_at = datetime('now'), updated_at = datetime('now')
     WHERE dedupe_key = ? AND status = 'pending'`,
    [delivery.dedupe_key],
  ))
  if (claimed.changes !== 1) return 'skipped'

  const attemptCount = delivery.attempt_count + 1
  try {
    // The SMTP session stays outside the statement queue so it cannot stall monitor runs.
    await sendImpl(delivery.recipient_email, delivery.subject, delivery.body_html)
    await enqueueSiteMonitorDbWork(() => dbRun(
      `UPDATE site_monitor_deliveries SET status = 'sent', sent_at = datetime('now'), error_message = '',
         updated_at = datetime('now') WHERE dedupe_key = ?`,
      [delivery.dedupe_key],
    ))
    console.log(`[Site Monitor Mail] sent monitor=${delivery.monitor_id} attempt=${attemptCount}`)
    return 'sent'
  } catch (error) {
    const message = publicError(error)
    const giveUp = attemptCount >= MAX_ATTEMPTS
    await enqueueSiteMonitorDbWork(() => dbRun(
      `UPDATE site_monitor_deliveries SET status = ?, error_message = ?, next_attempt_at = datetime('now', ?),
         updated_at = datetime('now') WHERE dedupe_key = ?`,
      [giveUp ? 'failed' : 'pending', message, retryExpression(attemptCount), delivery.dedupe_key],
    ))
    console.error(`[Site Monitor Mail] failed monitor=${delivery.monitor_id} attempt=${attemptCount}/${MAX_ATTEMPTS}${giveUp ? ' 放弃' : ''}: ${message}`)
    return giveUp ? 'failed' : 'retry'
  }
}

async function processDeliveryQueue(sendImpl, limit) {
  const rows = await enqueueSiteMonitorDbWork(async () => {
    await recoverStaleDeliveries()
    return dbAll(
      `SELECT id, monitor_id, dedupe_key, recipient_email, subject, body_html, attempt_count
       FROM site_monitor_deliveries
       WHERE status = 'pending' AND next_attempt_at <= datetime('now')
       ORDER BY next_attempt_at ASC, id ASC LIMIT ?`,
      [Math.max(1, Math.min(MAX_BATCH, Number(limit) || MAX_BATCH))],
    )
  })

  const summary = { sent: 0, retry: 0, failed: 0, skipped: 0 }
  for (const row of rows) {
    const outcome = await deliverOne(row, sendImpl)
    summary[outcome] += 1
  }
  return summary
}

/**
 * Drain due deliveries one at a time. Overlapping callers share a single in-flight pass so a slow
 * SMTP session cannot be entered twice by the scheduler.
 */
export async function processSiteMonitorDeliveries({ sendImpl = sendSiteMonitorEmail, limit = MAX_BATCH } = {}) {
  if (deliveryLoopInFlight) return deliveryLoopInFlight
  const pass = processDeliveryQueue(sendImpl, limit).finally(() => { deliveryLoopInFlight = null })
  deliveryLoopInFlight = pass
  return pass
}

/** Administrator-triggered probe. Never called by the scheduler, and never queued. */
export async function sendSiteMonitorTestEmail(recipient, { sendImpl = sendSiteMonitorEmail } = {}) {
  const to = headerText(recipient)
  if (!to) throw new Error('收件邮箱不能为空')
  const { subject, html } = renderSiteMonitorEmail('网站监测测试邮件', [
    { eventType: 'announcement_added', eventKey: 'test', title: '这是一封测试邮件，用于确认网站监测的通知通道可用。', url: '', publishedAt: null },
  ])
  await sendImpl(to, subject, html)
  return { recipient: to, subject }
}

export const siteMonitorMailPolicy = Object.freeze({
  maxAttempts: MAX_ATTEMPTS,
  firstRetrySeconds: FIRST_RETRY_SECONDS,
  maxRetrySeconds: MAX_RETRY_SECONDS,
  staleSendingMinutes: STALE_SENDING_MINUTES,
  maxBatch: MAX_BATCH,
  maxListedEvents: MAX_LISTED_EVENTS,
})

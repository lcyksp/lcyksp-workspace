import { getSiteMonitorDb } from '../config/db.js'
import { decrypt, encrypt } from './crypto.js'
import { fetchMonitorResponse } from './siteMonitorFetch.js'
import { queueSiteMonitorAlertDelivery, queueSiteMonitorDelivery } from './siteMonitorMailer.js'
import { createEventKey, extractAnnouncementAttachment, extractAnnouncementBody, parseHzuAnnouncements, parseJustWokerModels } from './siteMonitorParsers.js'
import { enqueueSiteMonitorDbWork } from './siteMonitorQueue.js'

const inFlightMonitors = new Map()
const VALID_TRIGGERS = new Set(['schedule', 'manual', 'diagnose', 'baseline'])
const STALE_RUN_MINUTES = 15
// A rejected credential is actionable at once; any other failure must persist for a few cycles before
// it is worth an email, so a single network blip or one 502 stays silent.
const FAILURE_ALERT_THRESHOLD = 3
const CREDENTIAL_FAILURE_CODES = new Set(['AUTH_REJECTED', 'AUTH_MISSING', 'AUTH_INVALID'])
// One request per new announcement, capped so an unexpected flood cannot turn into a crawl of the
// upstream site. Bodies past the cap still notify, just without the excerpt.
const MAX_ANNOUNCEMENT_CONTENT_FETCHES = 10

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => getSiteMonitorDb().get(sql, params, (error, row) => (error ? reject(error) : resolve(row))))
}
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => getSiteMonitorDb().all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows || []))))
}
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => getSiteMonitorDb().run(sql, params, function onRun(error) {
    if (error) reject(error)
    else resolve({ lastID: this.lastID, changes: this.changes })
  }))
}

async function transaction(callback) {
  await dbRun('BEGIN IMMEDIATE')
  try {
    const result = await callback()
    await dbRun('COMMIT')
    return result
  } catch (error) {
    await dbRun('ROLLBACK').catch(() => {})
    throw error
  }
}

function parseStoredPayload(value) {
  try { return JSON.parse(value || '{}') } catch { return {} }
}

function publicError(error) {
  const message = String(error?.message || 'Unknown monitor failure')
    .replace(/(authorization|cookie|bearer|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
  return message.slice(0, 1000)
}

function serializeItemPayload(item) {
  return JSON.stringify(item.metadata || {})
}

function rowToItem(row) {
  return {
    itemKey: row.item_key,
    title: row.title,
    url: row.url,
    publishedAt: row.published_at,
    metadata: parseStoredPayload(row.payload_json),
  }
}

function parseResponse(source, body) {
  if (source === 'justwoker_models') return parseJustWokerModels(body)
  if (source === 'hzu_postgraduate') return parseHzuAnnouncements(body)
  throw new Error('Unsupported monitor source')
}

function scheduleExpression(intervalSeconds, failureCount = 0) {
  const backoffSeconds = failureCount > 0
    ? Math.min(intervalSeconds, 300 * (2 ** Math.min(failureCount - 1, 4)))
    : intervalSeconds
  return `+${backoffSeconds} seconds`
}

async function loadMonitor(source) {
  const monitor = await dbGet('SELECT * FROM site_monitors WHERE source = ?', [source])
  if (!monitor) throw new Error('Monitor configuration was not found')
  let authSecret = ''
  if (monitor.auth_type !== 'none') {
    authSecret = monitor.auth_secret ? decrypt(monitor.auth_secret) : ''
    if (!authSecret) throw new Error('Monitor credential is missing or cannot be decrypted')
  }
  return { ...monitor, authSecret }
}

async function insertEvent(monitorId, runId, source, eventType, item, extras = {}) {
  const eventKey = createEventKey(source, eventType, item.itemKey)
  const payload = { ...item, ...extras }
  const result = await dbRun(
    `INSERT INTO site_monitor_events (monitor_id, run_id, event_key, event_type, title, payload_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_key) DO NOTHING`,
    [monitorId, runId, eventKey, eventType, item.title, JSON.stringify(payload)],
  )
  // A conflicting key means the event was already notified, so it must not enter a new mail batch.
  if (result.changes === 0) return null
  // Everything the mail template renders travels with the event, announcement body included.
  return {
    id: result.lastID,
    eventKey,
    eventType,
    title: item.title,
    url: item.url || '',
    publishedAt: item.publishedAt || null,
    metadata: item.metadata || {},
    ...extras,
  }
}

async function persistBaseline(monitor, items) {
  for (const item of items) {
    await dbRun(
      `INSERT INTO site_monitor_items
        (monitor_id, item_key, item_type, title, url, published_at, payload_json, is_active, missing_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)
       ON CONFLICT(monitor_id, item_key) DO UPDATE SET
         title = excluded.title, url = excluded.url, published_at = excluded.published_at,
         payload_json = excluded.payload_json, is_active = 1, missing_count = 0,
         last_seen_at = datetime('now'), removed_at = NULL`,
      [monitor.id, item.itemKey, monitor.source === 'justwoker_models' ? 'model' : 'announcement', item.title, item.url || '', item.publishedAt || null, serializeItemPayload(item)],
    )
  }
  await dbRun("UPDATE site_monitors SET baseline_ready = 1, updated_at = datetime('now') WHERE id = ?", [monitor.id])
}

async function persistChanges(monitor, runId, items, announcementBodies = new Map()) {
  const activeRows = await dbAll('SELECT * FROM site_monitor_items WHERE monitor_id = ? AND is_active = 1', [monitor.id])
  const currentByKey = new Map(items.map((item) => [item.itemKey, item]))
  const activeByKey = new Map(activeRows.map((row) => [row.item_key, row]))
  const added = items.filter((item) => !activeByKey.has(item.itemKey))
  const missing = activeRows.filter((row) => !currentByKey.has(row.item_key))
  const removed = []

  for (const item of items) {
    await dbRun(
      `INSERT INTO site_monitor_items
        (monitor_id, item_key, item_type, title, url, published_at, payload_json, is_active, missing_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)
       ON CONFLICT(monitor_id, item_key) DO UPDATE SET
         title = excluded.title, url = excluded.url, published_at = excluded.published_at,
         payload_json = excluded.payload_json, is_active = 1, missing_count = 0,
         last_seen_at = datetime('now'), removed_at = NULL`,
      [monitor.id, item.itemKey, monitor.source === 'justwoker_models' ? 'model' : 'announcement', item.title, item.url || '', item.publishedAt || null, serializeItemPayload(item)],
    )
  }

  for (const row of missing) {
    if (monitor.source === 'justwoker_models') {
      const nextMissingCount = row.missing_count + 1
      if (nextMissingCount >= 2) {
        await dbRun(`UPDATE site_monitor_items SET missing_count = ?, is_active = 0, removed_at = datetime('now') WHERE id = ?`, [nextMissingCount, row.id])
        removed.push(rowToItem(row))
      } else {
        await dbRun('UPDATE site_monitor_items SET missing_count = ? WHERE id = ?', [nextMissingCount, row.id])
      }
    }
  }

  const notifications = []
  for (const item of added) {
    const eventType = monitor.source === 'justwoker_models' ? 'model_added' : 'announcement_added'
    // Only new announcements are enriched, so the mail says what was actually announced.
    const enrichment = announcementBodies.get(item.itemKey) || {}
    const extras = {}
    if (enrichment.content) extras.content = enrichment.content
    if (enrichment.attachment) extras.attachment = enrichment.attachment
    const event = await insertEvent(monitor.id, runId, monitor.source, eventType, item, extras)
    if (event) notifications.push(event)
  }
  for (const item of removed) {
    const event = await insertEvent(monitor.id, runId, monitor.source, 'model_removed', item)
    if (event) notifications.push(event)
  }

  return { added, removed, notifications }
}

/**
 * One outage episode stays open while the newest health event is a failure. Alerting on that state
 * instead of on the failure count means an expired cookie produces exactly one email no matter how
 * many polling cycles keep failing, and a later outage can alert again after a recovery closes it.
 * The stored payload records whether the open episode was already reported as a credential failure,
 * because that is the one condition which may escalate on top of an unrelated open alert.
 */
async function openFailureAlert(monitorId) {
  const row = await dbGet(
    `SELECT event_type, created_at, payload_json FROM site_monitor_events
     WHERE monitor_id = ? AND event_type IN ('monitor_failed', 'monitor_recovered')
     ORDER BY id DESC LIMIT 1`,
    [monitorId],
  )
  if (row?.event_type !== 'monitor_failed') return null
  return { ...row, credentialRejected: parseStoredPayload(row.payload_json).credentialRejected === true }
}

function isCredentialFailure(error) {
  const status = Number(error?.status)
  if (status === 401 || status === 403) return true
  return CREDENTIAL_FAILURE_CODES.has(String(error?.code || ''))
}

/** Record the alert event and queue its mail inside the caller's transaction. */
async function recordFailureAlert(monitor, runId, error, failureCount) {
  const open = await openFailureAlert(monitor.id)
  const credentialRejected = isCredentialFailure(error)
  // A rejected credential needs a human, so it escalates even while an unrelated alert is still open.
  // Every other failure keeps the rule of one mail per outage episode.
  if (open && (open.credentialRejected || !credentialRejected)) return null

  const event = await insertEvent(monitor.id, runId, monitor.source, 'monitor_failed', {
    itemKey: `alert:${runId}`,
    title: credentialRejected ? `登录凭据已失效（连续 ${failureCount} 次）` : `连续 ${failureCount} 次检查失败`,
    url: '',
    publishedAt: null,
    credentialRejected,
  })
  if (!event) return null
  return queueSiteMonitorAlertDelivery(monitor, {
    ...event,
    headline: credentialRejected ? '登录凭据已失效，请更新凭据' : `连续 ${failureCount} 次检查失败`,
    detail: publicError(error),
    consecutiveFailures: failureCount,
    lastSuccessAt: monitor.last_success_at,
    targetUrl: monitor.target_url,
    credentialRejected,
  })
}

/** A recovery is only worth a mail when the administrator was actually told about the outage. */
async function recordRecoveryAlert(monitor, runId) {
  const open = await openFailureAlert(monitor.id)
  if (!open) return null
  const event = await insertEvent(monitor.id, runId, monitor.source, 'monitor_recovered', {
    itemKey: `recovery:${runId}`,
    title: '检查已恢复正常',
    url: '',
    publishedAt: null,
  })
  if (!event) return null
  return queueSiteMonitorAlertDelivery(monitor, {
    ...event,
    headline: '检查已恢复正常',
    outageStartedAt: open.created_at,
    consecutiveFailures: 0,
    lastSuccessAt: null,
    targetUrl: monitor.target_url,
    credentialRejected: false,
  })
}

async function markRunFailure(monitor, runId, startedAt, error) {
  const durationMs = Date.now() - startedAt
  const nextFailureCount = monitor.consecutive_failures + 1
  const message = publicError(error)
  await transaction(async () => {
    await dbRun(
      `UPDATE site_monitor_runs SET status = 'failed', finished_at = datetime('now'),
         http_status = ?, duration_ms = ?, error_message = ? WHERE id = ?`,
      [error?.status || null, durationMs, message, runId],
    )
    await dbRun(
      `UPDATE site_monitors SET last_status = 'failed', last_checked_at = datetime('now'),
         consecutive_failures = ?, last_error = ?, next_run_at = datetime('now', ?),
         updated_at = datetime('now') WHERE id = ?`,
      [nextFailureCount, message, scheduleExpression(monitor.interval_seconds, nextFailureCount), monitor.id],
    )
    // The alert shares this commit: a queued mail can never exist for a failure the database lost.
    if (isCredentialFailure(error) || nextFailureCount >= FAILURE_ALERT_THRESHOLD) {
      await recordFailureAlert(monitor, runId, error, nextFailureCount)
    }
  })
}

/**
 * Fetch the body of each genuinely new announcement. Runs before the surrounding transaction opens,
 * because network work must never happen inside it, and only new articles need a request at all —
 * a steady state costs nothing. A failed or unrecognised body degrades that one mail to title + link;
 * it can never fail the run or alter the snapshot.
 */
async function collectAnnouncementBodies(monitor, items, { fetchImpl, hostnameValidator, rebuildBaseline } = {}) {
  if (monitor.source !== 'hzu_postgraduate') return new Map()
  // A fresh or rebuilt baseline emits no events, so there is nothing to enrich.
  if (!monitor.baseline_ready || rebuildBaseline) return new Map()

  const activeRows = await dbAll('SELECT item_key FROM site_monitor_items WHERE monitor_id = ? AND is_active = 1', [monitor.id])
  const known = new Set(activeRows.map((row) => row.item_key))
  const fresh = items
    .filter((item) => item.url && !known.has(item.itemKey))
    .slice(0, MAX_ANNOUNCEMENT_CONTENT_FETCHES)

  const bodies = new Map()
  for (const item of fresh) {
    try {
      // Same security envelope as the list request: host allowlist, redirect checks, size and timeout caps.
      const response = await fetchMonitorResponse(
        { source: monitor.source, target_url: item.url, auth_type: 'none' },
        { fetchImpl, hostnameValidator },
      )
      const content = extractAnnouncementBody(response.body)
      // Some announcements are an attached file with no prose; report the attachment instead of nothing.
      const attachment = content ? null : extractAnnouncementAttachment(response.body, item.url)
      if (content || attachment) bodies.set(item.itemKey, { content, attachment })
    } catch {
      // Title and link still make a usable notification.
    }
  }
  return bodies
}

async function executeMonitor(source, { triggerType = 'manual', diagnose = false, rebuildBaseline = false, fetchImpl, hostnameValidator } = {}) {
  if (!VALID_TRIGGERS.has(triggerType)) throw new Error('Invalid monitor trigger type')
  const monitor = await loadMonitor(source)
  if (!diagnose && triggerType === 'schedule' && !monitor.enabled) return { skipped: true, reason: 'disabled' }

  const startedAt = Date.now()
  const run = await dbRun(
    "INSERT INTO site_monitor_runs (monitor_id, trigger_type, status) VALUES (?, ?, 'running')",
    [monitor.id, diagnose ? 'diagnose' : triggerType],
  )

  try {
    // Diagnostics must fetch a full body instead of reusing validators and receiving an unparseable 304.
    const requestMonitor = (diagnose || rebuildBaseline) ? { ...monitor, etag: null, last_modified: null } : monitor
    const response = await fetchMonitorResponse(requestMonitor, {
      fetchImpl,
      hostnameValidator,
      onCredentialRefresh: async (newSecret) => {
        // JustWoker may rotate its refresh-session cookie. Persist only the encrypted replacement,
        // after the authenticated pricing request succeeds; access tokens remain memory-only.
        const encrypted = encrypt(newSecret)
        if (!encrypted) throw new Error('Refreshed monitor credential could not be encrypted')
        await dbRun("UPDATE site_monitors SET auth_secret = ?, updated_at = datetime('now') WHERE id = ?", [encrypted, monitor.id])
      },
    })
    if (response.notModified) {
      if (diagnose) throw new Error('Diagnostic request returned 304 without a response body')
      if (!monitor.baseline_ready) throw new Error('Received 304 before a baseline was established')
      await transaction(async () => {
        await dbRun(`UPDATE site_monitor_runs SET status = 'not_modified', finished_at = datetime('now'), duration_ms = ? WHERE id = ?`, [Date.now() - startedAt, run.lastID])
        await dbRun(`UPDATE site_monitors SET last_status = 'success', last_checked_at = datetime('now'), last_success_at = datetime('now'), consecutive_failures = 0, last_error = '', next_run_at = datetime('now', ?), updated_at = datetime('now') WHERE id = ?`, [scheduleExpression(monitor.interval_seconds), monitor.id])
        await recordRecoveryAlert(monitor, run.lastID)
      })
      return { status: 'not_modified', itemCount: null, added: [], removed: [] }
    }

    const items = parseResponse(source, response.body)
    if (diagnose) {
      await dbRun(`UPDATE site_monitor_runs SET status = 'success', finished_at = datetime('now'), http_status = ?, item_count = ?, duration_ms = ? WHERE id = ?`, [response.status, items.length, Date.now() - startedAt, run.lastID])
      return { status: 'diagnose', itemCount: items.length, sample: items.slice(0, 3) }
    }

    // Bodies are fetched here, outside the transaction below, so no network wait can hold the writer.
    const announcementBodies = await collectAnnouncementBodies(monitor, items, { fetchImpl, hostnameValidator, rebuildBaseline })

    // Snapshot mutations, events, the queued mail batch, run completion and scheduling form one atomic commit.
    const changes = await transaction(async () => {
      let clearedItems = 0
      let detectedChanges
      if (rebuildBaseline) {
        // Fetching and parsing already succeeded. Replace the snapshot only now, inside this commit,
        // so an upstream outage or parser failure can never erase the last known-good baseline.
        const cleared = await dbRun('DELETE FROM site_monitor_items WHERE monitor_id = ?', [monitor.id])
        clearedItems = cleared.changes
        await persistBaseline(monitor, items)
        detectedChanges = { added: [], removed: [], notifications: [] }
      } else {
        detectedChanges = monitor.baseline_ready
          ? await persistChanges(monitor, run.lastID, items, announcementBodies)
          : (await persistBaseline(monitor, items), { added: [], removed: [], notifications: [] })
      }
      await dbRun(
        `UPDATE site_monitor_runs SET status = 'success', finished_at = datetime('now'), http_status = ?,
           item_count = ?, added_count = ?, removed_count = ?, duration_ms = ? WHERE id = ?`,
        [response.status, items.length, detectedChanges.added.length, detectedChanges.removed.length, Date.now() - startedAt, run.lastID],
      )
      await dbRun(
        `UPDATE site_monitors SET last_status = 'success', last_checked_at = datetime('now'), last_success_at = datetime('now'),
           etag = ?, last_modified = ?, consecutive_failures = 0, last_error = '', next_run_at = datetime('now', ?),
           updated_at = datetime('now') WHERE id = ?`,
        [response.etag, response.lastModified, scheduleExpression(monitor.interval_seconds), monitor.id],
      )
      const delivery = await queueSiteMonitorDelivery(monitor, detectedChanges.notifications)
      const alert = await recordRecoveryAlert(monitor, run.lastID)
      return { added: detectedChanges.added, removed: detectedChanges.removed, delivery, alert, clearedItems }
    })
    return { status: (!monitor.baseline_ready || rebuildBaseline) ? 'baseline' : 'success', itemCount: items.length, ...changes }
  } catch (error) {
    if (diagnose) {
      await dbRun(
        `UPDATE site_monitor_runs SET status = 'failed', finished_at = datetime('now'),
           http_status = ?, duration_ms = ?, error_message = ? WHERE id = ?`,
        [error?.status || null, Date.now() - startedAt, publicError(error), run.lastID],
      )
    } else {
      await markRunFailure(monitor, run.lastID, startedAt, error)
    }
    throw error
  }
}

function enqueueMonitorExecution(callback) {
  return enqueueSiteMonitorDbWork(callback)
}

export async function runSiteMonitor(source, options = {}) {
  if (inFlightMonitors.has(source)) return inFlightMonitors.get(source)
  // One sqlite3 connection is shared by the process. Serializing complete monitor runs prevents
  // statements from another source from being interleaved inside an open transaction.
  const promise = enqueueMonitorExecution(() => executeMonitor(source, options))
    .finally(() => inFlightMonitors.delete(source))
  inFlightMonitors.set(source, promise)
  return promise
}

export async function runDueSiteMonitors({ fetchImpl, hostnameValidator } = {}) {
  const due = await dbAll(
    `SELECT source FROM site_monitors
     WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= datetime('now'))`,
  )
  return Promise.allSettled(due.map(({ source }) => runSiteMonitor(source, { triggerType: 'schedule', fetchImpl, hostnameValidator })))
}

export function isSiteMonitorRunning(source) {
  return inFlightMonitors.has(source)
}

/**
 * A killed process leaves `running` rows behind. Mark the stale ones as interrupted so run history
 * stays truthful; the window is far longer than a real run, so an in-flight run is never touched.
 */
export async function recoverInterruptedSiteMonitorRuns({ staleMinutes = STALE_RUN_MINUTES } = {}) {
  return enqueueSiteMonitorDbWork(async () => {
    const result = await dbRun(
      `UPDATE site_monitor_runs SET status = 'failed', finished_at = datetime('now'),
         error_message = CASE WHEN error_message = '' THEN '进程中断，本次运行未完成' ELSE error_message END
       WHERE status = 'running' AND started_at <= datetime('now', ?)`,
      [`-${staleMinutes} minutes`],
    )
    return result.changes
  })
}

/**
 * Fetch and parse first, then atomically replace the snapshot without emitting historical events.
 * A failed fetch leaves the previous baseline and validators untouched.
 */
export async function rebuildSiteMonitorBaseline(source, options = {}) {
  return runSiteMonitor(source, { ...options, triggerType: 'baseline', rebuildBaseline: true })
}

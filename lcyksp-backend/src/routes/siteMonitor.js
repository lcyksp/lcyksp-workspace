import { Router } from 'express'
import { getDb } from '../config/db.js'
import { authMiddleware } from '../middleware/auth.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { decrypt, encrypt } from '../utils/crypto.js'
import { smtpConfigured } from '../utils/githubMail.js'
import { processSiteMonitorDeliveries, sendSiteMonitorTestEmail } from '../utils/siteMonitorMailer.js'
import { isSiteMonitorRunning, rebuildSiteMonitorBaseline, runSiteMonitor } from '../utils/siteMonitorService.js'

const router = Router()
router.use(authMiddleware)
router.use(requireAdmin)

const SOURCES = new Set(['justwoker_models', 'hzu_postgraduate'])
const AUTH_TYPES = new Set(['none', 'cookie', 'bearer'])
const MAX_SECRET_LENGTH = 8192
const TEST_EMAIL_COOLDOWN_MS = 15000
const HEARTBEAT_SECONDS = 300

let lastTestEmailAt = 0

function dbGetAsync(sql, params = []) { return new Promise((resolve, reject) => getDb().get(sql, params, (e, row) => e ? reject(e) : resolve(row))) }
function dbAllAsync(sql, params = []) { return new Promise((resolve, reject) => getDb().all(sql, params, (e, rows) => e ? reject(e) : resolve(rows || []))) }
function dbRunAsync(sql, params = []) { return new Promise((resolve, reject) => getDb().run(sql, params, function onRun(e) { e ? reject(e) : resolve({ lastID: this.lastID, changes: this.changes }) })) }

function parseJson(value, fallback) { try { return JSON.parse(value) } catch { return fallback } }

/** Credentials are never returned in clear text, only whether one exists and a short tail. */
function maskSecret(stored) {
  const secret = stored ? decrypt(stored) : ''
  if (!secret) return { authConfigured: false, authMask: '', authLength: 0 }
  return { authConfigured: true, authMask: `••••${secret.slice(-4)}`, authLength: secret.length }
}

function normalizeEmail(value) {
  const text = String(value || '').replace(/[\r\n]/g, '').trim()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : ''
}

function intervalLabel(seconds) {
  return `${Math.round(Number(seconds || 0) / 60)} 分钟`
}

function requireSource(req, res) {
  const source = String(req.params.source || '')
  if (!SOURCES.has(source)) {
    res.status(400).json({ error: '未知的监测来源' })
    return ''
  }
  return source
}

/**
 * Upstream failures are always reported as 502: a 401 here would read as "the administrator is not
 * signed in". A rejected credential is flagged separately so the admin page can point at that field.
 */
function upstreamFailure(res, prefix, error) {
  const status = Number(error?.status)
  return res.status(502).json({
    error: `${prefix}：${String(error?.message || '未知错误').slice(0, 300)}`,
    credentialRejected: status === 401 || status === 403,
  })
}

async function serializeMonitor(row) {
  const [items, events, runs, deliveries] = await Promise.all([
    dbGetAsync('SELECT COUNT(*) count FROM site_monitor_items WHERE monitor_id = ? AND is_active = 1', [row.id]),
    dbGetAsync('SELECT COUNT(*) count, MAX(created_at) latest FROM site_monitor_events WHERE monitor_id = ?', [row.id]),
    dbAllAsync(
      `SELECT id, trigger_type, status, started_at, finished_at, http_status, item_count, added_count,
         removed_count, duration_ms, error_message
       FROM site_monitor_runs WHERE monitor_id = ? ORDER BY id DESC LIMIT 5`,
      [row.id],
    ),
    dbGetAsync(
      `SELECT
         SUM(CASE WHEN status IN ('pending', 'sending') THEN 1 ELSE 0 END) waiting,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) failed,
         MAX(sent_at) last_sent_at
       FROM site_monitor_deliveries WHERE monitor_id = ?`,
      [row.id],
    ),
  ])

  return {
    source: row.source,
    displayName: row.display_name,
    targetUrl: row.target_url,
    enabled: Boolean(row.enabled),
    // The polling period is fixed by a database constraint and is display-only for the administrator.
    intervalSeconds: row.interval_seconds,
    intervalLabel: intervalLabel(row.interval_seconds),
    recipientEmail: row.recipient_email,
    authType: row.auth_type,
    ...maskSecret(row.auth_secret),
    baselineReady: Boolean(row.baseline_ready),
    baselineCount: items?.count || 0,
    lastCheckedAt: row.last_checked_at,
    lastSuccessAt: row.last_success_at,
    nextRunAt: row.next_run_at,
    lastStatus: row.last_status,
    consecutiveFailures: row.consecutive_failures,
    lastError: row.last_error,
    running: isSiteMonitorRunning(row.source),
    eventCount: events?.count || 0,
    lastEventAt: events?.latest || null,
    recentRuns: runs.map((run) => ({
      id: run.id,
      triggerType: run.trigger_type,
      status: run.status,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      httpStatus: run.http_status,
      itemCount: run.item_count,
      addedCount: run.added_count,
      removedCount: run.removed_count,
      durationMs: run.duration_ms,
      errorMessage: run.error_message,
    })),
    deliveries: {
      waiting: deliveries?.waiting || 0,
      failed: deliveries?.failed || 0,
      lastSentAt: deliveries?.last_sent_at || null,
    },
  }
}

async function loadMonitorRow(source) {
  const row = await dbGetAsync('SELECT * FROM site_monitors WHERE source = ?', [source])
  if (!row) throw new Error('监测配置不存在，请检查数据库初始化')
  return row
}

router.get('/', async function (req, res, next) {
  try {
    const rows = await dbAllAsync('SELECT * FROM site_monitors ORDER BY id ASC')
    res.json({
      smtpConfigured: await smtpConfigured(),
      heartbeatSeconds: HEARTBEAT_SECONDS,
      monitors: await Promise.all(rows.map(serializeMonitor)),
    })
  } catch (err) { next(err) }
})

router.post('/:source/config', async function (req, res, next) {
  try {
    const source = requireSource(req, res)
    if (!source) return
    const row = await loadMonitorRow(source)

    const authType = req.body?.authType === undefined ? row.auth_type : String(req.body.authType)
    if (!AUTH_TYPES.has(authType)) return res.status(400).json({ error: '认证方式只能是 none、cookie 或 bearer' })

    const rawSecret = req.body?.authSecret === undefined || req.body?.authSecret === null ? '' : String(req.body.authSecret)
    if (rawSecret.length > MAX_SECRET_LENGTH) return res.status(400).json({ error: '凭据长度超出限制' })
    if (/[\r\n]/.test(rawSecret)) return res.status(400).json({ error: '凭据不能包含换行符' })
    // A Cookie header is a list of name=value pairs. Copying a single Cookie *value* out of the
    // browser's cookie table is an easy mistake that can never authenticate, and it would otherwise
    // only show up much later as an unexplained 401, so it is refused here with an explicit message.
    if (authType === 'cookie' && rawSecret.trim() && !/[^=;\s]+=[^;]*/.test(rawSecret.trim())) {
      return res.status(400).json({ error: 'Cookie 凭据必须包含 name=value，例如 session=xxxx。请复制完整的 Cookie 请求头，而不是单个 Cookie 的值' })
    }

    let authSecret = row.auth_secret
    if (authType === 'none') authSecret = null
    else if (rawSecret.trim()) {
      authSecret = encrypt(rawSecret.trim())
      if (!authSecret) return res.status(500).json({ error: '凭据加密失败' })
    }

    let recipientEmail = row.recipient_email
    if (req.body?.recipientEmail !== undefined) {
      recipientEmail = normalizeEmail(req.body.recipientEmail)
      if (!recipientEmail) return res.status(400).json({ error: '收件邮箱格式不正确' })
    }

    const enabled = req.body?.enabled === undefined ? Boolean(row.enabled) : Boolean(req.body.enabled)
    if (enabled && authType !== 'none' && !authSecret) {
      return res.status(400).json({ error: '请先保存凭据再启用该监测' })
    }

    // interval_seconds is intentionally absent: the period is fixed by the schema and not client controlled.
    await dbRunAsync(
      `UPDATE site_monitors SET enabled = ?, auth_type = ?, auth_secret = ?, recipient_email = ?,
         updated_at = datetime('now') WHERE id = ?`,
      [enabled ? 1 : 0, authType, authSecret, recipientEmail, row.id],
    )
    // Enabling a monitor should be picked up by the next heartbeat instead of waiting a full period.
    if (enabled && !row.enabled) {
      await dbRunAsync("UPDATE site_monitors SET next_run_at = datetime('now') WHERE id = ? AND next_run_at IS NULL", [row.id])
    }

    res.json({ message: '监测配置已保存', monitor: await serializeMonitor(await loadMonitorRow(source)) })
  } catch (err) { next(err) }
})

router.post('/:source/diagnose', async function (req, res, next) {
  try {
    const source = requireSource(req, res)
    if (!source) return
    const result = await runSiteMonitor(source, { triggerType: 'diagnose', diagnose: true })
    res.json({
      message: '连接与解析诊断成功',
      itemCount: result.itemCount,
      sample: (result.sample || []).map((item) => ({ title: String(item.title || '').slice(0, 120), url: item.url || '' })),
    })
  } catch (err) {
    if (err?.message === 'Monitor configuration was not found') return next(err)
    upstreamFailure(res, '诊断失败', err)
  }
})

router.post('/:source/check', async function (req, res, next) {
  try {
    const source = requireSource(req, res)
    if (!source) return
    const result = await runSiteMonitor(source, { triggerType: 'manual' })
    // The administrator asked for this check, so a queued batch or health alert is flushed now
    // instead of waiting for the next heartbeat.
    const queued = Boolean(result.delivery?.queued || result.alert?.queued)
    const delivery = queued ? await processSiteMonitorDeliveries() : null
    res.json({
      message: result.status === 'baseline' ? '已建立首轮基线，本次不发送通知' : '检查完成',
      status: result.status,
      itemCount: result.itemCount,
      added: (result.added || []).map((item) => item.title),
      removed: (result.removed || []).map((item) => item.title),
      queuedEmail: queued,
      delivery,
    })
  } catch (err) {
    if (err?.message === 'Monitor configuration was not found') return next(err)
    upstreamFailure(res, '检查失败', err)
  }
})

router.post('/:source/rebuild-baseline', async function (req, res, next) {
  try {
    const source = requireSource(req, res)
    if (!source) return
    const result = await rebuildSiteMonitorBaseline(source)
    res.json({
      message: '基线已重建，本次不发送通知',
      clearedItems: result.clearedItems,
      itemCount: result.itemCount,
    })
  } catch (err) {
    if (err?.message === 'Monitor configuration was not found') return next(err)
    upstreamFailure(res, '重建基线失败', err)
  }
})

router.get('/:source/events', async function (req, res, next) {
  try {
    const source = requireSource(req, res)
    if (!source) return
    const row = await loadMonitorRow(source)
    const page = Math.max(1, Math.min(1000, Number(req.query.page) || 1))
    const pageSize = Math.max(1, Math.min(50, Number(req.query.pageSize) || 20))
    const total = await dbGetAsync('SELECT COUNT(*) count FROM site_monitor_events WHERE monitor_id = ?', [row.id])
    const events = await dbAllAsync(
      `SELECT id, event_type, title, payload_json, created_at FROM site_monitor_events
       WHERE monitor_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
      [row.id, pageSize, (page - 1) * pageSize],
    )
    res.json({
      total: total?.count || 0,
      page,
      pageSize,
      events: events.map((event) => {
        const payload = parseJson(event.payload_json, {})
        return {
          id: event.id,
          eventType: event.event_type,
          title: event.title,
          url: payload.url || '',
          publishedAt: payload.publishedAt || null,
          createdAt: event.created_at,
        }
      }),
    })
  } catch (err) { next(err) }
})

router.post('/test-email', async function (req, res, next) {
  try {
    // An explicitly supplied address must never silently fall back to the stored recipient.
    const supplied = req.body?.recipient !== undefined && String(req.body.recipient).trim() !== ''
    let recipient = ''
    if (supplied) {
      recipient = normalizeEmail(req.body.recipient)
    } else {
      const row = await dbGetAsync('SELECT recipient_email FROM site_monitors ORDER BY id ASC LIMIT 1')
      recipient = normalizeEmail(row?.recipient_email)
    }
    if (!recipient) return res.status(400).json({ error: '收件邮箱格式不正确' })

    // A real message goes out only on an explicit administrator request, and not twice per click.
    if (Date.now() - lastTestEmailAt < TEST_EMAIL_COOLDOWN_MS) {
      return res.status(429).json({ error: '测试邮件发送过于频繁，请稍后再试' })
    }
    lastTestEmailAt = Date.now()

    try {
      const result = await sendSiteMonitorTestEmail(recipient)
      res.json({ message: '测试邮件已发送', recipient: result.recipient })
    } catch (error) {
      res.status(502).json({ error: `测试邮件发送失败：${String(error?.message || '未知错误').slice(0, 300)}` })
    }
  } catch (err) { next(err) }
})

export default router

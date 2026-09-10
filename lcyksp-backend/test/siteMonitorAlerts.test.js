import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { encrypt } from '../src/utils/crypto.js'

const tempDir = await mkdtemp(path.join(tmpdir(), 'lcyksp-site-alert-'))
process.env.LCYKSP_DB_DIR = tempDir
const { closeDb, getDb, initDb } = await import('../src/config/db.js')
const { runSiteMonitor } = await import('../src/utils/siteMonitorService.js')
const { beijingTime, processSiteMonitorDeliveries, renderSiteMonitorAlertEmail } = await import('../src/utils/siteMonitorMailer.js')
await initDb()

function dbGet(sql, params = []) { return new Promise((resolve, reject) => getDb().get(sql, params, (e, row) => e ? reject(e) : resolve(row))) }
function dbAll(sql, params = []) { return new Promise((resolve, reject) => getDb().all(sql, params, (e, rows) => e ? reject(e) : resolve(rows || []))) }
function dbRun(sql, params = []) { return new Promise((resolve, reject) => getDb().run(sql, params, function onRun(e) { e ? reject(e) : resolve({ changes: this.changes }) })) }
function jsonResponse(models) { return new Response(JSON.stringify({ models }), { status: 200, headers: { 'content-type': 'application/json' } }) }
function htmlResponse(html) { return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }) }
function unauthorized() { return new Response('', { status: 401 }) }
function unavailable() { return new Response('', { status: 503 }) }

const noDnsBlock = async () => false

async function reset(source) {
  const monitor = await dbGet('SELECT id FROM site_monitors WHERE source = ?', [source])
  await dbRun('DELETE FROM site_monitor_deliveries')
  await dbRun('DELETE FROM site_monitor_events')
  await dbRun('DELETE FROM site_monitor_runs')
  await dbRun('DELETE FROM site_monitor_items')
  await dbRun(`UPDATE site_monitors SET auth_type = 'none', auth_secret = NULL, baseline_ready = 0,
    etag = NULL, last_modified = NULL, consecutive_failures = 0, last_error = '', last_status = 'idle',
    next_run_at = NULL WHERE id = ?`, [monitor.id])
  return monitor.id
}

function eventTypes(monitorId) {
  return dbAll('SELECT event_type FROM site_monitor_events WHERE monitor_id = ? ORDER BY id', [monitorId])
    .then((rows) => rows.map((row) => row.event_type))
}
function deliveries(monitorId) {
  return dbAll('SELECT subject, body_html, status FROM site_monitor_deliveries WHERE monitor_id = ? ORDER BY id', [monitorId])
}

test('a rejected credential alerts once per outage episode and the mail never carries the secret', async () => {
  const monitorId = await reset('justwoker_models')
  const secret = 'super-secret-token-9999'
  await dbRun("UPDATE site_monitors SET auth_type = 'bearer', auth_secret = ? WHERE id = ?", [encrypt(secret), monitorId])

  const failing = async () => unauthorized()
  await assert.rejects(runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: failing }), { code: 'AUTH_REJECTED' })
  // The same outage keeps failing on every polling cycle; it must not mail once per cycle.
  await assert.rejects(runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: failing }), { code: 'AUTH_REJECTED' })
  await assert.rejects(runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: failing }), { code: 'AUTH_REJECTED' })

  assert.deepEqual(await eventTypes(monitorId), ['monitor_failed'])
  const queued = await deliveries(monitorId)
  assert.equal(queued.length, 1)
  assert.match(queued[0].subject, /登录凭据已失效/)
  assert.equal(queued[0].body_html.includes(secret), false)

  const sent = []
  const summary = await processSiteMonitorDeliveries({ sendImpl: async (to, subject, html) => { sent.push({ to, subject, html }) } })
  assert.equal(summary.sent, 1)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].to, '1296757861@qq.com')
  assert.match(sent[0].html, /重新粘贴 JustWoker 的登录会话 Cookie/)
})

test('a rejected JustWoker refresh session is classified as a credential failure without touching pricing', async () => {
  const monitorId = await reset('justwoker_models')
  const cookie = 'sid=expired-session; device=stable'
  await dbRun("UPDATE site_monitors SET auth_type = 'cookie', auth_secret = ? WHERE id = ?", [encrypt(cookie), monitorId])

  const calls = []
  await assert.rejects(runSiteMonitor('justwoker_models', {
    hostnameValidator: noDnsBlock,
    fetchImpl: async (url) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ code: 'AUTH_UNAUTHORIZED', message: 'Unauthorized', success: false }), { status: 401, headers: { 'content-type': 'application/json' } })
    },
  }), { code: 'AUTH_REJECTED' })

  assert.equal(calls.length, 1)
  assert.match(calls[0], /\/api\/user\/auth\/refresh$/)
  assert.deepEqual(await eventTypes(monitorId), ['monitor_failed'])
  const queued = await deliveries(monitorId)
  assert.equal(queued.length, 1)
  assert.equal(queued[0].body_html.includes(cookie), false)
})

test('recovery closes the episode, notifies once, and lets a later outage alert again', async () => {
  const monitorId = await reset('justwoker_models')
  await dbRun("UPDATE site_monitors SET auth_type = 'bearer', auth_secret = ? WHERE id = ?", [encrypt('token-aaaa'), monitorId])

  await assert.rejects(runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: async () => unauthorized() }), { code: 'AUTH_REJECTED' })
  const healthy = async () => jsonResponse(['A'])
  await runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: healthy })
  // Staying healthy must not repeat the recovery mail.
  await runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: healthy })
  await assert.rejects(runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: async () => unauthorized() }), { code: 'AUTH_REJECTED' })

  assert.deepEqual(await eventTypes(monitorId), ['monitor_failed', 'monitor_recovered', 'monitor_failed'])
  const queued = await deliveries(monitorId)
  assert.equal(queued.length, 3)
  assert.match(queued[1].subject, /检查已恢复正常/)
  assert.match(queued[2].subject, /登录凭据已失效/)
})

test('a non-credential failure stays silent until it persists, and a healthy monitor never mails recovery', async () => {
  const monitorId = await reset('hzu_postgraduate')
  const failing = async () => unavailable()
  await assert.rejects(runSiteMonitor('hzu_postgraduate', { hostnameValidator: noDnsBlock, fetchImpl: failing }))
  await assert.rejects(runSiteMonitor('hzu_postgraduate', { hostnameValidator: noDnsBlock, fetchImpl: failing }))
  assert.deepEqual(await eventTypes(monitorId), [])
  assert.equal((await deliveries(monitorId)).length, 0)

  await assert.rejects(runSiteMonitor('hzu_postgraduate', { hostnameValidator: noDnsBlock, fetchImpl: failing }))
  assert.deepEqual(await eventTypes(monitorId), ['monitor_failed'])
  assert.equal((await deliveries(monitorId)).length, 1)

  const healthy = async () => htmlResponse('<a href="/2026/0901/c11241a101/page.htm">公告一</a>')
  await runSiteMonitor('hzu_postgraduate', { hostnameValidator: noDnsBlock, fetchImpl: healthy })
  assert.deepEqual(await eventTypes(monitorId), ['monitor_failed', 'monitor_recovered'])
  assert.equal((await deliveries(monitorId)).length, 2)

  // A source that never raised an alert produces no recovery mail at all.
  await reset('justwoker_models')
  await runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: async () => jsonResponse(['A']) })
  await runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: async () => jsonResponse(['A']) })
  assert.deepEqual(await eventTypes((await dbGet("SELECT id FROM site_monitors WHERE source = 'justwoker_models'")).id), [])
})

test('a credential failure escalates even while an unrelated outage alert is still open', async () => {
  const monitorId = await reset('hzu_postgraduate')
  const failing = async () => unavailable()
  await assert.rejects(runSiteMonitor('hzu_postgraduate', { hostnameValidator: noDnsBlock, fetchImpl: failing }))
  await assert.rejects(runSiteMonitor('hzu_postgraduate', { hostnameValidator: noDnsBlock, fetchImpl: failing }))
  await assert.rejects(runSiteMonitor('hzu_postgraduate', { hostnameValidator: noDnsBlock, fetchImpl: failing }))
  assert.deepEqual(await eventTypes(monitorId), ['monitor_failed'])
  assert.equal((await deliveries(monitorId))[0].subject.includes('凭据'), false)

  // The same outage turns into a rejected credential, which the administrator must act on.
  await assert.rejects(
    runSiteMonitor('hzu_postgraduate', { hostnameValidator: noDnsBlock, fetchImpl: async () => unauthorized() }),
    { code: 'AUTH_REJECTED' },
  )
  assert.deepEqual(await eventTypes(monitorId), ['monitor_failed', 'monitor_failed'])
  const queued = await deliveries(monitorId)
  assert.equal(queued.length, 2)
  assert.match(queued[1].subject, /登录凭据已失效/)
  assert.match(queued[1].body_html, /重新粘贴/)

  // A third credential failure in the same episode must not mail again.
  await assert.rejects(
    runSiteMonitor('hzu_postgraduate', { hostnameValidator: noDnsBlock, fetchImpl: async () => unauthorized() }),
    { code: 'AUTH_REJECTED' },
  )
  assert.deepEqual(await eventTypes(monitorId), ['monitor_failed', 'monitor_failed'])
  assert.equal((await deliveries(monitorId)).length, 2)
})

test('a diagnostic failure never raises a health alert', async () => {
  const monitorId = await reset('justwoker_models')
  await dbRun("UPDATE site_monitors SET auth_type = 'bearer', auth_secret = ? WHERE id = ?", [encrypt('token-bbbb'), monitorId])
  await assert.rejects(
    runSiteMonitor('justwoker_models', { diagnose: true, hostnameValidator: noDnsBlock, fetchImpl: async () => unauthorized() }),
    { code: 'AUTH_REJECTED' },
  )
  assert.deepEqual(await eventTypes(monitorId), [])
  assert.equal((await deliveries(monitorId)).length, 0)
})

test('alert email renders escaped content, the credential action and a Beijing timestamp', async () => {
  const failed = renderSiteMonitorAlertEmail('JustWoker 模型广场', {
    eventType: 'monitor_failed',
    headline: '登录凭据已失效｜换行注入\r\nBcc: attacker@example.com',
    detail: 'Monitor authentication was rejected',
    consecutiveFailures: 4,
    lastSuccessAt: '2026-09-10 04:30:02',
    targetUrl: 'https://api.justwoker.icu/api/pricing',
    credentialRejected: true,
  })
  // The subject travels as a mail header, so CR/LF is what must never survive into it.
  assert.equal(/[\r\n]/.test(failed.subject), false)
  assert.match(failed.subject, /登录凭据已失效/)
  assert.equal(failed.html.includes('<script>'), false)
  assert.match(failed.html, /连续失败：<\/span>4 次/)
  assert.match(failed.html, /2026-09-10 12:30:02（北京时间）/)
  assert.match(failed.html, /重新粘贴 JustWoker 的登录会话 Cookie/)

  const escaped = renderSiteMonitorAlertEmail('JustWoker 模型广场', { eventType: 'monitor_failed', headline: '<script>alert(1)</script>', detail: '<img src=x onerror=1>' })
  assert.equal(escaped.html.includes('<script>'), false)
  assert.equal(escaped.html.includes('<img src=x'), false)
  assert.match(escaped.html, /&lt;script&gt;/)
  assert.match(escaped.html, /&lt;img src=x onerror=1&gt;/)

  const recovered = renderSiteMonitorAlertEmail('JustWoker 模型广场', {
    eventType: 'monitor_recovered',
    outageStartedAt: '2026-09-10 04:30:02',
    credentialRejected: true,
  })
  assert.match(recovered.subject, /检查已恢复正常/)
  assert.match(recovered.html, /故障开始于北京时间 2026-09-10 12:30:02/)
  // A recovery is not an action request, so it never carries the "paste a new cookie" instruction.
  assert.equal(recovered.html.includes('重新粘贴'), false)

  assert.throws(() => renderSiteMonitorAlertEmail('x', { eventType: 'model_added' }), TypeError)
})

test('beijingTime converts stored UTC strings and rejects everything else', () => {
  assert.equal(beijingTime('2026-09-10 04:30:02'), '2026-09-10 12:30:02')
  assert.equal(beijingTime('2026-09-10T20:00:00'), '2026-09-11 04:00:00')
  assert.equal(beijingTime('2026-09-10 04:30'), '2026-09-10 12:30:00')
  assert.equal(beijingTime(''), '')
  assert.equal(beijingTime(null), '')
  assert.equal(beijingTime('not-a-date'), '')
})

test.after(async () => {
  await closeDb()
  await rm(tempDir, { recursive: true, force: true })
})

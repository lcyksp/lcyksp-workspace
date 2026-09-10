import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tempDir = await mkdtemp(path.join(tmpdir(), 'lcyksp-site-mail-'))
process.env.LCYKSP_DB_DIR = tempDir
const { closeDb, getDb, initDb } = await import('../src/config/db.js')
const { runSiteMonitor } = await import('../src/utils/siteMonitorService.js')
const {
  createDeliveryKey,
  processSiteMonitorDeliveries,
  queueSiteMonitorDelivery,
  renderSiteMonitorEmail,
  sendSiteMonitorTestEmail,
  siteMonitorMailPolicy,
} = await import('../src/utils/siteMonitorMailer.js')
await initDb()

function dbGet(sql, params = []) { return new Promise((resolve, reject) => getDb().get(sql, params, (e, row) => e ? reject(e) : resolve(row))) }
function dbAll(sql, params = []) { return new Promise((resolve, reject) => getDb().all(sql, params, (e, rows) => e ? reject(e) : resolve(rows || []))) }
function dbRun(sql, params = []) { return new Promise((resolve, reject) => getDb().run(sql, params, function onRun(e) { e ? reject(e) : resolve({ changes: this.changes }) })) }
function jsonResponse(models) { return new Response(JSON.stringify({ models }), { status: 200, headers: { 'content-type': 'application/json' } }) }
function htmlResponse(html) { return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }) }

const noDnsBlock = async () => false

function recordingSender(behaviour = () => {}) {
  const calls = []
  const send = async (to, subject, html) => {
    calls.push({ to, subject, html })
    await behaviour(calls.length)
  }
  send.calls = calls
  return send
}

async function resetAll(source) {
  const monitor = await dbGet('SELECT id FROM site_monitors WHERE source = ?', [source])
  await dbRun('DELETE FROM site_monitor_deliveries')
  await dbRun('DELETE FROM site_monitor_events')
  await dbRun('DELETE FROM site_monitor_runs')
  await dbRun('DELETE FROM site_monitor_items')
  await dbRun(`UPDATE site_monitors SET auth_type = 'none', auth_secret = NULL, baseline_ready = 0,
    etag = NULL, last_modified = NULL, consecutive_failures = 0, last_error = '', last_status = 'idle', next_run_at = NULL WHERE id = ?`, [monitor.id])
  return monitor.id
}

async function seedDelivery(monitorId, overrides = {}) {
  const row = {
    dedupe_key: 'seed-key',
    recipient_email: '1296757861@qq.com',
    subject: '【网站监测】测试',
    body_html: '<p>测试</p>',
    status: 'pending',
    attempt_count: 0,
    next_attempt_at: "datetime('now')",
    last_attempt_at: 'NULL',
    ...overrides,
  }
  await dbRun(
    `INSERT INTO site_monitor_deliveries (monitor_id, dedupe_key, event_ids_json, recipient_email, subject, body_html, status, attempt_count, next_attempt_at, last_attempt_at)
     VALUES (?, ?, '[]', ?, ?, ?, ?, ?, ${row.next_attempt_at}, ${row.last_attempt_at})`,
    [monitorId, row.dedupe_key, row.recipient_email, row.subject, row.body_html, row.status, row.attempt_count],
  )
  return row.dedupe_key
}

test('rendered mail summarizes each change type and escapes untrusted titles', () => {
  const { subject, html } = renderSiteMonitorEmail('JustWoker 模型广场', [
    { eventType: 'model_added', eventKey: 'a', title: 'Claude <script>x</script>', url: '', publishedAt: null },
    { eventType: 'model_added', eventKey: 'b', title: 'GPT-5', url: '', publishedAt: null },
    { eventType: 'model_removed', eventKey: 'c', title: '旧模型', url: '', publishedAt: null },
  ])
  assert.equal(subject, '【网站监测】JustWoker 模型广场：新增 2 个模型、下架 1 个模型')
  assert.equal(html.includes('<script>'), false)
  assert.equal(html.includes('&lt;script&gt;'), true)
  assert.equal(html.includes('新增模型（2）'), true)
  assert.equal(html.includes('下架模型（1）'), true)
})

test('only https article links become anchors', () => {
  const { html } = renderSiteMonitorEmail('惠州学院研究生招生', [
    { eventType: 'announcement_added', eventKey: 'a', title: '公告一', url: 'https://www.hzu.edu.cn/2026/0901/c11241a101/page.htm', publishedAt: '2026-09-01' },
    { eventType: 'announcement_added', eventKey: 'b', title: '公告二', url: 'javascript:alert(1)', publishedAt: null },
  ])
  assert.equal(html.includes('href="https://www.hzu.edu.cn/2026/0901/c11241a101/page.htm"'), true)
  assert.equal(html.includes('javascript:'), false)
  assert.equal(html.includes('2026-09-01'), true)
})

test('delivery key ignores event order and duplicates', () => {
  const first = createDeliveryKey('justwoker_models', ['b', 'a', 'b'])
  const second = createDeliveryKey('justwoker_models', ['a', 'b'])
  assert.equal(first, second)
  assert.notEqual(first, createDeliveryKey('hzu_postgraduate', ['a', 'b']))
  assert.throws(() => createDeliveryKey('justwoker_models', []), TypeError)
})

test('a baseline run queues nothing and a later change queues exactly one delivery', async () => {
  const monitorId = await resetAll('justwoker_models')
  const baseline = await runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: async () => jsonResponse(['A', 'B']) })
  assert.equal(baseline.delivery, null)
  assert.equal((await dbGet('SELECT COUNT(*) count FROM site_monitor_deliveries')).count, 0)

  const changed = await runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: async () => jsonResponse(['A', 'B', 'C']) })
  assert.equal(changed.delivery.queued, true)
  const rows = await dbAll('SELECT * FROM site_monitor_deliveries WHERE monitor_id = ?', [monitorId])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'pending')
  assert.equal(rows[0].recipient_email, '1296757861@qq.com')
  assert.equal(rows[0].subject, '【网站监测】JustWoker 模型广场：新增 1 个模型')
  assert.equal(rows[0].body_html.includes('C'), true)
  assert.equal(JSON.parse(rows[0].event_ids_json).length, 1)
})

test('a detected website change flows through event, durable queue, and simulated successful email', async () => {
  const monitorId = await resetAll('hzu_postgraduate')
  const first = '<a href="/2026/0901/c11241a101/page.htm">公告一</a>'
  const second = '<a href="/2026/0902/c11241a102/page.htm">公告二</a>' + first
  await runSiteMonitor('hzu_postgraduate', { hostnameValidator: noDnsBlock, fetchImpl: async () => htmlResponse(first) })
  const change = await runSiteMonitor('hzu_postgraduate', { hostnameValidator: noDnsBlock, fetchImpl: async () => htmlResponse(second) })
  assert.equal(change.added.length, 1)
  assert.equal(change.delivery.queued, true)
  assert.equal((await dbGet('SELECT COUNT(*) count FROM site_monitor_events WHERE monitor_id = ?', [monitorId])).count, 1)
  assert.equal((await dbGet("SELECT COUNT(*) count FROM site_monitor_deliveries WHERE monitor_id = ? AND status = 'pending'", [monitorId])).count, 1)
  const sender = recordingSender()
  assert.deepEqual(await processSiteMonitorDeliveries({ sendImpl: sender }), { sent: 1, retry: 0, failed: 0, skipped: 0 })
  assert.equal(sender.calls.length, 1)
  assert.equal(sender.calls[0].to, '1296757861@qq.com')
  assert.equal(sender.calls[0].html.includes('公告二'), true)
  assert.equal((await dbGet("SELECT COUNT(*) count FROM site_monitor_deliveries WHERE monitor_id = ? AND status = 'sent' AND sent_at IS NOT NULL", [monitorId])).count, 1)
})
test('unchanged repeat runs create no second delivery and re-queueing the same batch is a no-op', async () => {
  const monitorId = await resetAll('justwoker_models')
  await runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: async () => jsonResponse(['A']) })
  await runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: async () => jsonResponse(['A', 'B']) })
  await runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: async () => jsonResponse(['A', 'B']) })
  assert.equal((await dbGet('SELECT COUNT(*) count FROM site_monitor_deliveries')).count, 1)

  const monitor = await dbGet('SELECT * FROM site_monitors WHERE id = ?', [monitorId])
  const events = await dbAll('SELECT id, event_key, event_type, title FROM site_monitor_events WHERE monitor_id = ?', [monitorId])
  const batch = events.map((row) => ({ id: row.id, eventKey: row.event_key, eventType: row.event_type, title: row.title, url: '', publishedAt: null }))
  const again = await queueSiteMonitorDelivery(monitor, batch)
  assert.equal(again.queued, false)
  assert.equal((await dbGet('SELECT COUNT(*) count FROM site_monitor_deliveries')).count, 1)
})

test('a successful pass sends once, stores sent_at and is not resent', async () => {
  const monitorId = await resetAll('hzu_postgraduate')
  await dbRun("UPDATE site_monitors SET recipient_email = '1296757861@qq.com' WHERE id = ?", [monitorId])
  await runSiteMonitor('hzu_postgraduate', { hostnameValidator: noDnsBlock, fetchImpl: async () => htmlResponse('<a href="/2026/0901/c11241a101/page.htm">公告一</a>') })
  await runSiteMonitor('hzu_postgraduate', { hostnameValidator: noDnsBlock, fetchImpl: async () => htmlResponse('<a href="/2026/0901/c11241a101/page.htm">公告一</a><a href="/2026/0902/c11241a102/page.htm">公告二</a>') })

  const sender = recordingSender()
  const summary = await processSiteMonitorDeliveries({ sendImpl: sender })
  assert.deepEqual(summary, { sent: 1, retry: 0, failed: 0, skipped: 0 })
  assert.equal(sender.calls.length, 1)
  assert.equal(sender.calls[0].to, '1296757861@qq.com')
  assert.equal(sender.calls[0].subject, '【网站监测】惠州学院研究生招生：1 条新公告')
  assert.equal(sender.calls[0].html.includes('公告二'), true)

  const row = await dbGet('SELECT status, attempt_count, sent_at, error_message FROM site_monitor_deliveries WHERE monitor_id = ?', [monitorId])
  assert.equal(row.status, 'sent')
  assert.equal(row.attempt_count, 1)
  assert.equal(row.error_message, '')
  assert.equal(typeof row.sent_at, 'string')

  const second = await processSiteMonitorDeliveries({ sendImpl: sender })
  assert.deepEqual(second, { sent: 0, retry: 0, failed: 0, skipped: 0 })
  assert.equal(sender.calls.length, 1)
})

test('a failed send keeps the batch, counts the attempt and backs off', async () => {
  const monitorId = await resetAll('justwoker_models')
  const key = await seedDelivery(monitorId)
  const sender = recordingSender(() => { throw new Error('SMTP 535: bearer=abcdef rejected') })

  const summary = await processSiteMonitorDeliveries({ sendImpl: sender })
  assert.deepEqual(summary, { sent: 0, retry: 1, failed: 0, skipped: 0 })
  const row = await dbGet('SELECT status, attempt_count, error_message, sent_at FROM site_monitor_deliveries WHERE dedupe_key = ?', [key])
  assert.equal(row.status, 'pending')
  assert.equal(row.attempt_count, 1)
  assert.equal(row.sent_at, null)
  assert.equal(row.error_message.includes('bearer=[redacted]'), true)
  assert.equal(row.error_message.includes('abcdef'), false)

  const due = await dbGet("SELECT next_attempt_at > datetime('now') AS pending FROM site_monitor_deliveries WHERE dedupe_key = ?", [key])
  assert.equal(due.pending, 1)
  // The backed-off batch is not retried inside the same heartbeat.
  assert.deepEqual(await processSiteMonitorDeliveries({ sendImpl: sender }), { sent: 0, retry: 0, failed: 0, skipped: 0 })
  assert.equal(sender.calls.length, 1)
})

test('the attempt ceiling marks a batch failed instead of retrying forever', async () => {
  const monitorId = await resetAll('justwoker_models')
  const key = await seedDelivery(monitorId, { attempt_count: siteMonitorMailPolicy.maxAttempts - 1 })
  const sender = recordingSender(() => { throw new Error('SMTP 550 mailbox unavailable') })

  const summary = await processSiteMonitorDeliveries({ sendImpl: sender })
  assert.deepEqual(summary, { sent: 0, retry: 0, failed: 1, skipped: 0 })
  const row = await dbGet('SELECT status, attempt_count FROM site_monitor_deliveries WHERE dedupe_key = ?', [key])
  assert.equal(row.status, 'failed')
  assert.equal(row.attempt_count, siteMonitorMailPolicy.maxAttempts)
  assert.deepEqual(await processSiteMonitorDeliveries({ sendImpl: sender }), { sent: 0, retry: 0, failed: 0, skipped: 0 })
})

test('a batch locked by another sender is left alone', async () => {
  const monitorId = await resetAll('justwoker_models')
  await seedDelivery(monitorId, { status: 'sending', attempt_count: 1, last_attempt_at: "datetime('now')" })
  const sender = recordingSender()
  assert.deepEqual(await processSiteMonitorDeliveries({ sendImpl: sender }), { sent: 0, retry: 0, failed: 0, skipped: 0 })
  assert.equal(sender.calls.length, 0)
  assert.equal((await dbGet('SELECT status FROM site_monitor_deliveries')).status, 'sending')
})

test('an interrupted send is requeued, and one that already spent its attempts is failed', async () => {
  const monitorId = await resetAll('justwoker_models')
  await seedDelivery(monitorId, { dedupe_key: 'stale-retryable', status: 'sending', attempt_count: 1, last_attempt_at: "datetime('now', '-30 minutes')" })
  await seedDelivery(monitorId, { dedupe_key: 'stale-exhausted', status: 'sending', attempt_count: siteMonitorMailPolicy.maxAttempts, last_attempt_at: "datetime('now', '-30 minutes')" })

  const sender = recordingSender()
  const summary = await processSiteMonitorDeliveries({ sendImpl: sender })
  assert.deepEqual(summary, { sent: 1, retry: 0, failed: 0, skipped: 0 })
  assert.equal((await dbGet("SELECT status, attempt_count FROM site_monitor_deliveries WHERE dedupe_key = 'stale-retryable'")).status, 'sent')
  assert.equal((await dbGet("SELECT attempt_count FROM site_monitor_deliveries WHERE dedupe_key = 'stale-retryable'")).attempt_count, 2)
  assert.equal((await dbGet("SELECT status FROM site_monitor_deliveries WHERE dedupe_key = 'stale-exhausted'")).status, 'failed')
})

test('overlapping heartbeats share one pass and never double send', async () => {
  const monitorId = await resetAll('justwoker_models')
  await seedDelivery(monitorId, { dedupe_key: 'overlap-key' })
  const sender = recordingSender(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

  const [first, second] = await Promise.all([
    processSiteMonitorDeliveries({ sendImpl: sender }),
    processSiteMonitorDeliveries({ sendImpl: sender }),
  ])
  assert.equal(sender.calls.length, 1)
  assert.deepEqual(first, { sent: 1, retry: 0, failed: 0, skipped: 0 })
  assert.deepEqual(second, first)
})

test('a delivery pass overlapping a monitor run does not interleave with its transaction', async () => {
  const monitorId = await resetAll('justwoker_models')
  await seedDelivery(monitorId, { dedupe_key: 'overlap-with-run' })
  await runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: async () => jsonResponse(['A']) })

  const sender = recordingSender()
  const slowRun = runSiteMonitor('justwoker_models', {
    hostnameValidator: noDnsBlock,
    fetchImpl: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return jsonResponse(['A', 'B'])
    },
  })
  const [runResult, summary] = await Promise.all([slowRun, processSiteMonitorDeliveries({ sendImpl: sender })])

  assert.equal(runResult.status, 'success')
  assert.equal(runResult.delivery.queued, true)
  // The pass may claim the run's batch or only the seeded one depending on which reaches the queue
  // first, but both batches must survive and each must be sent exactly once.
  assert.equal((await dbGet('SELECT COUNT(*) count FROM site_monitor_deliveries')).count, 2)
  const secondPass = await processSiteMonitorDeliveries({ sendImpl: sender })
  assert.equal(summary.sent + secondPass.sent, 2)
  assert.equal(sender.calls.length, 2)
  assert.equal(new Set(sender.calls.map((call) => call.subject)).size, 2)
  assert.deepEqual(await dbAll("SELECT status FROM site_monitor_deliveries WHERE status != 'sent'"), [])
})

test('the queue keeps batches when SMTP is unconfigured rather than dropping the notification', async () => {
  const monitorId = await resetAll('justwoker_models')
  await dbRun("DELETE FROM system_config WHERE key IN ('github_smtp_user','github_smtp_password')")
  const key = await seedDelivery(monitorId, { dedupe_key: 'no-smtp-key' })

  // Uses the real production sender, which rejects before opening any socket.
  const summary = await processSiteMonitorDeliveries()
  assert.deepEqual(summary, { sent: 0, retry: 1, failed: 0, skipped: 0 })
  const row = await dbGet('SELECT status, error_message FROM site_monitor_deliveries WHERE dedupe_key = ?', [key])
  assert.equal(row.status, 'pending')
  assert.equal(row.error_message.includes('SMTP'), true)
})

test('the administrator test mail is sent directly and never enters the queue', async () => {
  await resetAll('justwoker_models')
  const sender = recordingSender()
  const result = await sendSiteMonitorTestEmail(' 1296757861@qq.com ', { sendImpl: sender })
  assert.equal(result.recipient, '1296757861@qq.com')
  assert.equal(sender.calls.length, 1)
  assert.equal(sender.calls[0].subject.includes('网站监测测试邮件'), true)
  assert.equal((await dbGet('SELECT COUNT(*) count FROM site_monitor_deliveries')).count, 0)
  await assert.rejects(sendSiteMonitorTestEmail('', { sendImpl: sender }), /收件邮箱/)
})

test.after(async () => {
  await closeDb()
  await rm(tempDir, { recursive: true, force: true })
})


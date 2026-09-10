import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tempDir = await mkdtemp(path.join(tmpdir(), 'lcyksp-site-schedule-'))
process.env.LCYKSP_DB_DIR = tempDir
const { closeDb, getDb, initDb } = await import('../src/config/db.js')
const {
  recoverInterruptedSiteMonitorRuns,
  rebuildSiteMonitorBaseline,
  runDueSiteMonitors,
  runSiteMonitor,
} = await import('../src/utils/siteMonitorService.js')
await initDb()

function dbGet(sql, params = []) { return new Promise((resolve, reject) => getDb().get(sql, params, (e, row) => e ? reject(e) : resolve(row))) }
function dbAll(sql, params = []) { return new Promise((resolve, reject) => getDb().all(sql, params, (e, rows) => e ? reject(e) : resolve(rows || []))) }
function dbRun(sql, params = []) { return new Promise((resolve, reject) => getDb().run(sql, params, function onRun(e) { e ? reject(e) : resolve({ changes: this.changes }) })) }
function jsonResponse(models) { return new Response(JSON.stringify({ models }), { status: 200, headers: { 'content-type': 'application/json' } }) }
function htmlResponse(html) { return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }) }
function loginPageResponse() { return new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }) }

const noDnsBlock = async () => false
const ANNOUNCEMENT = '<a href="/2026/0901/c11241a101/page.htm">公告一</a>'

function countingFetch(handler) {
  const fetchImpl = async (url, options) => { fetchImpl.calls += 1; return handler(url, options) }
  fetchImpl.calls = 0
  return fetchImpl
}

async function resetMonitor(source) {
  const monitor = await dbGet('SELECT id FROM site_monitors WHERE source = ?', [source])
  await dbRun('DELETE FROM site_monitor_deliveries WHERE monitor_id = ?', [monitor.id])
  await dbRun('DELETE FROM site_monitor_events WHERE monitor_id = ?', [monitor.id])
  await dbRun('DELETE FROM site_monitor_runs WHERE monitor_id = ?', [monitor.id])
  await dbRun('DELETE FROM site_monitor_items WHERE monitor_id = ?', [monitor.id])
  await dbRun(`UPDATE site_monitors SET enabled = 0, auth_type = 'none', auth_secret = NULL, baseline_ready = 0,
    etag = NULL, last_modified = NULL, consecutive_failures = 0, last_error = '', last_status = 'idle', next_run_at = NULL WHERE id = ?`, [monitor.id])
  return monitor.id
}

/** Seconds between now and the stored next_run_at, read from sqlite so no wall clock math is involved. */
async function secondsUntilNextRun(source) {
  const row = await dbGet(
    "SELECT CAST(strftime('%s', next_run_at) - strftime('%s', 'now') AS INTEGER) delta FROM site_monitors WHERE source = ?",
    [source],
  )
  return row.delta
}

test('a successful run schedules the next check one fixed period later', async () => {
  await resetMonitor('justwoker_models')
  await resetMonitor('hzu_postgraduate')
  await runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: async () => jsonResponse(['A']) })
  await runSiteMonitor('hzu_postgraduate', { hostnameValidator: noDnsBlock, fetchImpl: async () => htmlResponse(ANNOUNCEMENT) })

  const justwoker = await secondsUntilNextRun('justwoker_models')
  const hzu = await secondsUntilNextRun('hzu_postgraduate')
  assert.equal(justwoker > 1790 && justwoker <= 1800, true, `justwoker delta=${justwoker}`)
  assert.equal(hzu > 3590 && hzu <= 3600, true, `hzu delta=${hzu}`)
})

test('a monitor that is not due yet is swept without issuing any request', async () => {
  await resetMonitor('justwoker_models')
  await resetMonitor('hzu_postgraduate')
  await dbRun("UPDATE site_monitors SET enabled = 1, next_run_at = datetime('now', '+10 minutes')")
  const fetchImpl = countingFetch(() => { throw new Error('a monitor that is not due must never be fetched') })

  const results = await runDueSiteMonitors({ fetchImpl, hostnameValidator: noDnsBlock })
  assert.equal(results.length, 0)
  assert.equal(fetchImpl.calls, 0)
  assert.equal((await dbGet('SELECT COUNT(*) count FROM site_monitor_runs')).count, 0)
})

test('advancing time past next_run_at runs the source exactly once per period', async () => {
  await resetMonitor('justwoker_models')
  await resetMonitor('hzu_postgraduate')
  await dbRun("UPDATE site_monitors SET enabled = 1 WHERE source = 'justwoker_models'")
  const fetchImpl = countingFetch(async () => jsonResponse(['A']))

  // A null next_run_at counts as due, so the first heartbeat picks the monitor up immediately.
  await runDueSiteMonitors({ fetchImpl, hostnameValidator: noDnsBlock })
  assert.equal(fetchImpl.calls, 1)

  // Within the same period nothing happens, however often the heartbeat fires.
  await runDueSiteMonitors({ fetchImpl, hostnameValidator: noDnsBlock })
  await runDueSiteMonitors({ fetchImpl, hostnameValidator: noDnsBlock })
  assert.equal(fetchImpl.calls, 1)

  // Simulate the 30 minutes elapsing instead of waiting for them.
  await dbRun("UPDATE site_monitors SET next_run_at = datetime('now', '-1 second') WHERE source = 'justwoker_models'")
  await runDueSiteMonitors({ fetchImpl, hostnameValidator: noDnsBlock })
  assert.equal(fetchImpl.calls, 2)
  const delta = await secondsUntilNextRun('justwoker_models')
  assert.equal(delta > 1790 && delta <= 1800, true, `delta=${delta}`)
})

test('a disabled monitor is never swept even when it is overdue', async () => {
  await resetMonitor('justwoker_models')
  await resetMonitor('hzu_postgraduate')
  await dbRun("UPDATE site_monitors SET enabled = 0, next_run_at = datetime('now', '-2 hours')")
  const fetchImpl = countingFetch(() => { throw new Error('a disabled monitor must never be fetched') })

  const results = await runDueSiteMonitors({ fetchImpl, hostnameValidator: noDnsBlock })
  assert.equal(results.length, 0)
  assert.equal(fetchImpl.calls, 0)
})

test('failure backoff starts at five minutes and never exceeds the fixed period', async () => {
  const monitorId = await resetMonitor('justwoker_models')
  await assert.rejects(runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: async () => loginPageResponse() }))
  let delta = await secondsUntilNextRun('justwoker_models')
  assert.equal(delta > 290 && delta <= 300, true, `first backoff delta=${delta}`)
  assert.equal((await dbGet('SELECT consecutive_failures FROM site_monitors WHERE id = ?', [monitorId])).consecutive_failures, 1)

  await dbRun('UPDATE site_monitors SET consecutive_failures = 4 WHERE id = ?', [monitorId])
  await assert.rejects(runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: async () => loginPageResponse() }))
  delta = await secondsUntilNextRun('justwoker_models')
  assert.equal((await dbGet('SELECT consecutive_failures FROM site_monitors WHERE id = ?', [monitorId])).consecutive_failures, 5)
  assert.equal(delta > 1790 && delta <= 1800, true, `capped backoff delta=${delta}`)

  // A later success clears the failure counter and returns to the plain period.
  await runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: async () => jsonResponse(['A']) })
  assert.equal((await dbGet('SELECT consecutive_failures FROM site_monitors WHERE id = ?', [monitorId])).consecutive_failures, 0)
})

test('interrupted running rows are marked failed while an in-flight run is left alone', async () => {
  const monitorId = await resetMonitor('justwoker_models')
  await dbRun("INSERT INTO site_monitor_runs (monitor_id, trigger_type, status, started_at) VALUES (?, 'schedule', 'running', datetime('now', '-3 hours'))", [monitorId])
  await dbRun("INSERT INTO site_monitor_runs (monitor_id, trigger_type, status, started_at) VALUES (?, 'schedule', 'running', datetime('now'))", [monitorId])

  const recovered = await recoverInterruptedSiteMonitorRuns()
  assert.equal(recovered, 1)
  const rows = await dbAll('SELECT status, error_message FROM site_monitor_runs WHERE monitor_id = ? ORDER BY id', [monitorId])
  assert.equal(rows[0].status, 'failed')
  assert.equal(rows[0].error_message, '进程中断，本次运行未完成')
  assert.equal(rows[1].status, 'running')
  assert.equal(await recoverInterruptedSiteMonitorRuns(), 0)
})

test('rebuilding the baseline clears the snapshot and validators without emitting events', async () => {
  const monitorId = await resetMonitor('justwoker_models')
  await runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: async () => jsonResponse(['A', 'B']) })
  await runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: async () => jsonResponse(['A', 'B', 'C']) })
  await dbRun("UPDATE site_monitors SET etag = 'stored-etag', last_modified = 'Wed, 09 Sep 2026 00:00:00 GMT' WHERE id = ?", [monitorId])
  const eventsBefore = (await dbGet('SELECT COUNT(*) count FROM site_monitor_events WHERE monitor_id = ?', [monitorId])).count
  assert.equal(eventsBefore, 1)

  const rebuilt = await rebuildSiteMonitorBaseline('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: async () => jsonResponse(['A', 'D']) })
  assert.equal(rebuilt.clearedItems, 3)
  const afterReset = await dbGet('SELECT baseline_ready, etag, last_modified FROM site_monitors WHERE id = ?', [monitorId])
  assert.deepEqual(afterReset, { baseline_ready: 1, etag: null, last_modified: null })

  assert.equal(rebuilt.status, 'baseline')
  assert.equal(rebuilt.delivery, null)
  assert.equal((await dbGet('SELECT COUNT(*) count FROM site_monitor_items WHERE monitor_id = ? AND is_active = 1', [monitorId])).count, 2)
  assert.equal((await dbGet('SELECT COUNT(*) count FROM site_monitor_events WHERE monitor_id = ?', [monitorId])).count, eventsBefore)
  assert.equal((await dbGet("SELECT status FROM site_monitor_runs WHERE monitor_id = ? ORDER BY id DESC LIMIT 1", [monitorId])).status, 'success')
})

test.after(async () => {
  await closeDb()
  await rm(tempDir, { recursive: true, force: true })
})

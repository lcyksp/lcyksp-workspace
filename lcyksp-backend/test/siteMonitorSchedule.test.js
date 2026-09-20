import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tempDir = await mkdtemp(path.join(tmpdir(), 'lcyksp-site-schedule-'))
process.env.LCYKSP_DB_DIR = tempDir
const { closeDb, getDb, initDb } = await import('../src/config/db.js')
const {
  isInQuietWindow,
  nextRunAtUtc,
  recoverInterruptedSiteMonitorRuns,
  rebuildSiteMonitorBaseline,
  runDueSiteMonitors,
  runSiteMonitor,
} = await import('../src/utils/siteMonitorService.js')
await initDb()

// 测试用的注入时钟：UTC 2026-09-13 05:00 = 北京时间 13:00，处于静默窗口之外。
const NOON_BEIJING_MS = Date.UTC(2026, 8, 13, 5, 0, 0)

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

async function nextRunAt(source) {
  const row = await dbGet('SELECT next_run_at FROM site_monitors WHERE source = ?', [source])
  return row.next_run_at
}

test('a successful run schedules the next check one fixed period later', async () => {
  await resetMonitor('justwoker_models')
  await resetMonitor('hzu_postgraduate')
  const options = { hostnameValidator: noDnsBlock, nowMs: NOON_BEIJING_MS }
  await runSiteMonitor('justwoker_models', { ...options, fetchImpl: async () => jsonResponse(['A']) })
  await runSiteMonitor('hzu_postgraduate', { ...options, fetchImpl: async () => htmlResponse(ANNOUNCEMENT) })

  assert.equal(await nextRunAt('justwoker_models'), '2026-09-13 05:30:00')
  assert.equal(await nextRunAt('hzu_postgraduate'), '2026-09-13 06:00:00')
})

test('a monitor that is not due yet is swept without issuing any request', async () => {
  await resetMonitor('justwoker_models')
  await resetMonitor('hzu_postgraduate')
  await dbRun("UPDATE site_monitors SET enabled = 1, next_run_at = '2026-09-13 05:10:00'")
  const fetchImpl = countingFetch(() => { throw new Error('a monitor that is not due must never be fetched') })

  const results = await runDueSiteMonitors({ fetchImpl, hostnameValidator: noDnsBlock, nowMs: NOON_BEIJING_MS })
  assert.equal(results.length, 0)
  assert.equal(fetchImpl.calls, 0)
  assert.equal((await dbGet('SELECT COUNT(*) count FROM site_monitor_runs')).count, 0)
})

test('advancing time past next_run_at runs the source exactly once per period', async () => {
  await resetMonitor('justwoker_models')
  await resetMonitor('hzu_postgraduate')
  await dbRun("UPDATE site_monitors SET enabled = 1 WHERE source = 'justwoker_models'")
  const fetchImpl = countingFetch(async () => jsonResponse(['A']))
  const options = { fetchImpl, hostnameValidator: noDnsBlock, nowMs: NOON_BEIJING_MS }

  // A null next_run_at counts as due, so the first heartbeat picks the monitor up immediately.
  await runDueSiteMonitors(options)
  assert.equal(fetchImpl.calls, 1)
  assert.equal(await nextRunAt('justwoker_models'), '2026-09-13 05:30:00')

  // Within the same period nothing happens, however often the heartbeat fires.
  await runDueSiteMonitors(options)
  await runDueSiteMonitors(options)
  assert.equal(fetchImpl.calls, 1)

  // Simulate the period elapsing instead of waiting for it.
  await dbRun("UPDATE site_monitors SET next_run_at = '2026-09-13 04:59:59' WHERE source = 'justwoker_models'")
  await runDueSiteMonitors(options)
  assert.equal(fetchImpl.calls, 2)
  assert.equal(await nextRunAt('justwoker_models'), '2026-09-13 05:30:00')
})

test('a disabled monitor is never swept even when it is overdue', async () => {
  await resetMonitor('justwoker_models')
  await resetMonitor('hzu_postgraduate')
  await dbRun("UPDATE site_monitors SET enabled = 0, next_run_at = '2026-09-13 03:00:00'")
  const fetchImpl = countingFetch(() => { throw new Error('a disabled monitor must never be fetched') })

  const results = await runDueSiteMonitors({ fetchImpl, hostnameValidator: noDnsBlock, nowMs: NOON_BEIJING_MS })
  assert.equal(results.length, 0)
  assert.equal(fetchImpl.calls, 0)
})

test('failure backoff starts at five minutes and never exceeds the fixed period', async () => {
  const monitorId = await resetMonitor('justwoker_models')
  const options = { hostnameValidator: noDnsBlock, nowMs: NOON_BEIJING_MS }
  await assert.rejects(runSiteMonitor('justwoker_models', { ...options, fetchImpl: async () => loginPageResponse() }))
  assert.equal(await nextRunAt('justwoker_models'), '2026-09-13 05:05:00')
  assert.equal((await dbGet('SELECT consecutive_failures FROM site_monitors WHERE id = ?', [monitorId])).consecutive_failures, 1)

  await dbRun('UPDATE site_monitors SET consecutive_failures = 4 WHERE id = ?', [monitorId])
  await assert.rejects(runSiteMonitor('justwoker_models', { ...options, fetchImpl: async () => loginPageResponse() }))
  assert.equal((await dbGet('SELECT consecutive_failures FROM site_monitors WHERE id = ?', [monitorId])).consecutive_failures, 5)
  assert.equal(await nextRunAt('justwoker_models'), '2026-09-13 05:30:00')

  // A later success clears the failure counter and returns to the plain period.
  await runSiteMonitor('justwoker_models', { ...options, fetchImpl: async () => jsonResponse(['A']) })
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

test('quiet window boundaries follow Beijing time regardless of the machine timezone', () => {
  // 北京时间 2026-09-14 00:00 与 05:50 都在静默窗口内
  assert.equal(isInQuietWindow(Date.UTC(2026, 8, 13, 16, 0, 0) / 1000), true)
  assert.equal(isInQuietWindow(Date.UTC(2026, 8, 13, 21, 50, 0) / 1000), true)
  // 北京时间 06:29:59 仍在窗口内，06:30:00 起不再静默
  assert.equal(isInQuietWindow(Date.UTC(2026, 8, 13, 22, 29, 59) / 1000), true)
  assert.equal(isInQuietWindow(Date.UTC(2026, 8, 13, 22, 30, 0) / 1000), false)
  // 北京时间 23:59 在窗口外
  assert.equal(isInQuietWindow(Date.UTC(2026, 8, 13, 15, 59, 0) / 1000), false)
})

test('next run times landing inside the quiet window are pushed to that day 06:30 Beijing', () => {
  // 北京 23:50 + 60min = 北京 00:50，落入窗口 → 顺延到当天 06:30（UTC 22:30）
  assert.equal(nextRunAtUtc(Date.UTC(2026, 8, 13, 15, 50, 0) / 1000, 3600), '2026-09-13 22:30:00')
  // 北京 06:28 + 60s = 北京 06:29，仍在窗口 → 当天 06:30
  assert.equal(nextRunAtUtc(Date.UTC(2026, 8, 13, 22, 28, 0) / 1000, 60), '2026-09-13 22:30:00')
  // 北京 06:30:30 已出窗 → 原样保留
  assert.equal(nextRunAtUtc(Date.UTC(2026, 8, 13, 22, 29, 30) / 1000, 60), '2026-09-13 22:30:30')
  // 白天照常按间隔推进，不受影响
  assert.equal(nextRunAtUtc(Date.UTC(2026, 8, 13, 5, 50, 0) / 1000, 3600), '2026-09-13 06:50:00')
})

test('the heartbeat stays silent during the quiet window and fetches nothing', async () => {
  await resetMonitor('justwoker_models')
  await resetMonitor('hzu_postgraduate')
  await dbRun('UPDATE site_monitors SET enabled = 1, next_run_at = NULL')
  const fetchImpl = countingFetch(() => { throw new Error('quiet hours must never fetch') })

  // 北京时间 2026-09-14 03:00 = UTC 前一天 19:00
  const results = await runDueSiteMonitors({ fetchImpl, hostnameValidator: noDnsBlock, nowMs: Date.UTC(2026, 8, 13, 19, 0, 0) })
  assert.equal(results.length, 0)
  assert.equal(fetchImpl.calls, 0)
  assert.equal((await dbGet('SELECT COUNT(*) count FROM site_monitor_runs')).count, 0)
})

test('a run finishing inside the quiet window schedules its next check at 06:30 Beijing', async () => {
  await resetMonitor('hzu_postgraduate')
  await runSiteMonitor('hzu_postgraduate', {
    hostnameValidator: noDnsBlock,
    fetchImpl: async () => htmlResponse(ANNOUNCEMENT),
    // 北京时间 2026-09-14 00:10 = UTC 前一天 16:10
    nowMs: Date.UTC(2026, 8, 13, 16, 10, 0),
  })
  assert.equal(await nextRunAt('hzu_postgraduate'), '2026-09-13 22:30:00')
})

test.after(async () => {
  await closeDb()
  await rm(tempDir, { recursive: true, force: true })
})

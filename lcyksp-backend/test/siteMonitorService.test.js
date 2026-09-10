import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { decrypt, encrypt } from '../src/utils/crypto.js'

const tempDir = await mkdtemp(path.join(tmpdir(), 'lcyksp-site-monitor-'))
process.env.LCYKSP_DB_DIR = tempDir
const { closeDb, getDb, initDb } = await import('../src/config/db.js')
const { rebuildSiteMonitorBaseline, runDueSiteMonitors, runSiteMonitor } = await import('../src/utils/siteMonitorService.js')
await initDb()

function dbGet(sql, params = []) { return new Promise((resolve, reject) => getDb().get(sql, params, (e, row) => e ? reject(e) : resolve(row))) }
function dbAll(sql, params = []) { return new Promise((resolve, reject) => getDb().all(sql, params, (e, rows) => e ? reject(e) : resolve(rows || []))) }
function dbRun(sql, params = []) { return new Promise((resolve, reject) => getDb().run(sql, params, function onRun(e) { e ? reject(e) : resolve({ changes: this.changes }) })) }
function jsonResponse(models, status = 200) { return new Response(JSON.stringify({ models }), { status, headers: { 'content-type': 'application/json' } }) }
function htmlResponse(html, status = 200) { return new Response(html, { status, headers: { 'content-type': 'text/html' } }) }

async function resetMonitor(source) {
  const monitor = await dbGet('SELECT id FROM site_monitors WHERE source = ?', [source])
  await dbRun('DELETE FROM site_monitor_events WHERE monitor_id = ?', [monitor.id])
  await dbRun('DELETE FROM site_monitor_runs WHERE monitor_id = ?', [monitor.id])
  await dbRun('DELETE FROM site_monitor_items WHERE monitor_id = ?', [monitor.id])
  await dbRun(`UPDATE site_monitors SET auth_type = 'none', auth_secret = NULL, baseline_ready = 0,
    etag = NULL, last_modified = NULL, consecutive_failures = 0, last_error = '', last_status = 'idle', next_run_at = NULL WHERE id = ?`, [monitor.id])
  return monitor.id
}

const noDnsBlock = async () => false

test('first success establishes a baseline without historical events', async () => {
  const monitorId = await resetMonitor('justwoker_models')
  const result = await runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: async () => jsonResponse(['A', 'B']), hostnameValidator: noDnsBlock })
  assert.equal(result.status, 'baseline')
  assert.equal((await dbGet('SELECT COUNT(*) count FROM site_monitor_items WHERE monitor_id = ?', [monitorId])).count, 2)
  assert.equal((await dbGet('SELECT COUNT(*) count FROM site_monitor_events WHERE monitor_id = ?', [monitorId])).count, 0)
})

test('model additions notify once and removals require two successful missing snapshots', async () => {
  const monitorId = await resetMonitor('justwoker_models')
  await runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: async () => jsonResponse(['A', 'B']) })
  await runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: async () => jsonResponse(['A', 'B', 'C']) })
  let events = await dbAll('SELECT event_type, title FROM site_monitor_events WHERE monitor_id = ? ORDER BY id', [monitorId])
  assert.deepEqual(events, [{ event_type: 'model_added', title: 'C' }])

  await runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: async () => jsonResponse(['A', 'C']) })
  assert.equal((await dbGet("SELECT is_active FROM site_monitor_items WHERE monitor_id = ? AND item_key = 'b'", [monitorId])).is_active, 1)
  await runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: async () => jsonResponse(['A', 'C']) })
  assert.equal((await dbGet("SELECT is_active FROM site_monitor_items WHERE monitor_id = ? AND item_key = 'b'", [monitorId])).is_active, 0)
  events = await dbAll('SELECT event_type, title FROM site_monitor_events WHERE monitor_id = ? ORDER BY id', [monitorId])
  assert.deepEqual(events, [{ event_type: 'model_added', title: 'C' }, { event_type: 'model_removed', title: 'B' }])
})

test('failure never overwrites baseline and records a redacted failed run', async () => {
  const monitorId = await resetMonitor('justwoker_models')
  await runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: async () => jsonResponse(['A', 'B']) })
  await assert.rejects(runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: async () => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }) }))
  assert.equal((await dbGet('SELECT COUNT(*) count FROM site_monitor_items WHERE monitor_id = ? AND is_active = 1', [monitorId])).count, 2)
  const monitor = await dbGet('SELECT last_status, consecutive_failures, last_error FROM site_monitors WHERE id = ?', [monitorId])
  assert.equal(monitor.last_status, 'failed')
  assert.equal(monitor.consecutive_failures, 1)
  assert.equal(monitor.last_error.includes('<html>'), false)
})


test('baseline rebuild fetches first and preserves the old snapshot when upstream fails', async () => {
  const monitorId = await resetMonitor('hzu_postgraduate')
  const original = '<a href="/2026/0901/c11241a101/page.htm">公告一</a>'
  await runSiteMonitor('hzu_postgraduate', { hostnameValidator: noDnsBlock, fetchImpl: async () => htmlResponse(original) })
  await dbRun("UPDATE site_monitors SET etag = 'old-etag' WHERE id = ?", [monitorId])

  await assert.rejects(rebuildSiteMonitorBaseline('hzu_postgraduate', {
    hostnameValidator: noDnsBlock,
    fetchImpl: async () => new Response('', { status: 503 }),
  }))

  assert.equal((await dbGet('SELECT COUNT(*) count FROM site_monitor_items WHERE monitor_id = ?', [monitorId])).count, 1)
  const monitor = await dbGet('SELECT baseline_ready, etag FROM site_monitors WHERE id = ?', [monitorId])
  assert.deepEqual(monitor, { baseline_ready: 1, etag: 'old-etag' })
})

test('baseline rebuild atomically replaces items and emits no historical notification', async () => {
  const monitorId = await resetMonitor('hzu_postgraduate')
  await runSiteMonitor('hzu_postgraduate', { hostnameValidator: noDnsBlock, fetchImpl: async () => htmlResponse('<a href="/2026/0901/c11241a101/page.htm">旧公告</a>') })
  const result = await rebuildSiteMonitorBaseline('hzu_postgraduate', {
    hostnameValidator: noDnsBlock,
    fetchImpl: async () => htmlResponse('<a href="/2026/0902/c11241a102/page.htm">新基线公告</a>'),
  })

  assert.equal(result.status, 'baseline')
  assert.equal(result.clearedItems, 1)
  assert.equal((await dbGet('SELECT COUNT(*) count FROM site_monitor_items WHERE monitor_id = ?', [monitorId])).count, 1)
  assert.equal((await dbGet('SELECT COUNT(*) count FROM site_monitor_events WHERE monitor_id = ?', [monitorId])).count, 0)
  assert.equal((await dbGet('SELECT COUNT(*) count FROM site_monitor_deliveries WHERE monitor_id = ?', [monitorId])).count, 0)
})

test('announcement reordering does not notify but a new article does', async () => {
  const monitorId = await resetMonitor('hzu_postgraduate')
  const a = '<a href="/2026/0901/c11241a101/page.htm">公告一</a>'
  const b = '<a href="/2026/0902/c11241a102/page.htm">公告二</a>'
  const c = '<a href="/2026/0903/c11241a103/page.htm">公告三</a>'
  await runSiteMonitor('hzu_postgraduate', { hostnameValidator: noDnsBlock, fetchImpl: async () => htmlResponse(a + b) })
  await runSiteMonitor('hzu_postgraduate', { hostnameValidator: noDnsBlock, fetchImpl: async () => htmlResponse(b + a) })
  assert.equal((await dbGet('SELECT COUNT(*) count FROM site_monitor_events WHERE monitor_id = ?', [monitorId])).count, 0)
  await runSiteMonitor('hzu_postgraduate', { hostnameValidator: noDnsBlock, fetchImpl: async () => htmlResponse(c + b + a) })
  const events = await dbAll('SELECT event_type, title FROM site_monitor_events WHERE monitor_id = ?', [monitorId])
  assert.deepEqual(events, [{ event_type: 'announcement_added', title: '公告三' }])
})

test('diagnose parses data without mutating baseline or monitor schedule', async () => {
  const monitorId = await resetMonitor('hzu_postgraduate')
  const result = await runSiteMonitor('hzu_postgraduate', { diagnose: true, fetchImpl: async () => htmlResponse('<a href="/2026/0901/c11241a101/page.htm">公告一</a>') })
  assert.equal(result.status, 'diagnose')
  assert.equal((await dbGet('SELECT COUNT(*) count FROM site_monitor_items WHERE monitor_id = ?', [monitorId])).count, 0)
  const monitor = await dbGet('SELECT baseline_ready, next_run_at FROM site_monitors WHERE id = ?', [monitorId])
  assert.equal(monitor.baseline_ready, 0)
  assert.equal(monitor.next_run_at, null)
})


test('failed diagnose records its run but does not change monitor health or schedule', async () => {
  const monitorId = await resetMonitor('hzu_postgraduate')
  await assert.rejects(runSiteMonitor('hzu_postgraduate', { diagnose: true, hostnameValidator: noDnsBlock, fetchImpl: async () => new Response('', { status: 500 }) }))
  const monitor = await dbGet('SELECT last_status, consecutive_failures, next_run_at FROM site_monitors WHERE id = ?', [monitorId])
  assert.deepEqual(monitor, { last_status: 'idle', consecutive_failures: 0, next_run_at: null })
  const run = await dbGet('SELECT status FROM site_monitor_runs WHERE monitor_id = ? ORDER BY id DESC LIMIT 1', [monitorId])
  assert.equal(run.status, 'failed')
})

test('diagnose ignores stored validators and requests a parseable full response', async () => {
  const monitorId = await resetMonitor('hzu_postgraduate')
  await dbRun("UPDATE site_monitors SET etag = 'old-etag', last_modified = 'Wed, 09 Sep 2026 00:00:00 GMT' WHERE id = ?", [monitorId])
  let receivedHeaders
  const result = await runSiteMonitor('hzu_postgraduate', {
    diagnose: true,
    hostnameValidator: noDnsBlock,
    fetchImpl: async (_url, options) => {
      receivedHeaders = options.headers
      return htmlResponse('<a href="/2026/0901/c11241a101/page.htm">公告一</a>')
    },
  })
  assert.equal(result.status, 'diagnose')
  assert.equal(receivedHeaders['If-None-Match'], undefined)
  assert.equal(receivedHeaders['If-Modified-Since'], undefined)
  const monitor = await dbGet('SELECT etag, last_modified, next_run_at FROM site_monitors WHERE id = ?', [monitorId])
  assert.deepEqual(monitor, { etag: 'old-etag', last_modified: 'Wed, 09 Sep 2026 00:00:00 GMT', next_run_at: null })
})

test('unsolicited 304 during diagnose fails without changing monitor state', async () => {
  const monitorId = await resetMonitor('hzu_postgraduate')
  await assert.rejects(
    runSiteMonitor('hzu_postgraduate', {
      diagnose: true,
      hostnameValidator: noDnsBlock,
      fetchImpl: async () => new Response(null, { status: 304 }),
    }),
    /Diagnostic request returned 304/,
  )
  const monitor = await dbGet('SELECT last_status, consecutive_failures, next_run_at FROM site_monitors WHERE id = ?', [monitorId])
  assert.deepEqual(monitor, { last_status: 'idle', consecutive_failures: 0, next_run_at: null })
  const run = await dbGet('SELECT status FROM site_monitor_runs WHERE monitor_id = ? ORDER BY id DESC LIMIT 1', [monitorId])
  assert.equal(run.status, 'failed')
})

test('concurrent due sources are serialized without nested sqlite transactions', async () => {
  await resetMonitor('justwoker_models')
  await resetMonitor('hzu_postgraduate')
  await dbRun("UPDATE site_monitors SET enabled = 1, next_run_at = datetime('now', '-1 second')")
  let activeFetches = 0
  let maximumActiveFetches = 0
  const fetchImpl = async (url) => {
    activeFetches += 1
    maximumActiveFetches = Math.max(maximumActiveFetches, activeFetches)
    await new Promise((resolve) => setTimeout(resolve, 10))
    activeFetches -= 1
    return url.hostname === 'api.justwoker.icu'
      ? jsonResponse(['A'])
      : htmlResponse('<a href="/2026/0901/c11241a101/page.htm">公告一</a>')
  }
  const results = await runDueSiteMonitors({ fetchImpl, hostnameValidator: noDnsBlock })
  assert.equal(results.length, 2)
  assert.equal(results.every((result) => result.status === 'fulfilled'), true)
  assert.equal(maximumActiveFetches, 1)
  const runs = await dbAll("SELECT status FROM site_monitor_runs ORDER BY id DESC LIMIT 2")
  assert.equal(runs.every((run) => run.status === 'success'), true)
})


test.after(async () => {
  await closeDb()
  await rm(tempDir, { recursive: true, force: true })
})



test('rotated JustWoker session cookie is encrypted and access token is never persisted', async () => {
  await resetMonitor('justwoker_models')
  const oldCookie = 'sid=old-session; device=stable'
  await dbRun("UPDATE site_monitors SET auth_type = 'cookie', auth_secret = ? WHERE source = 'justwoker_models'", [encrypt(oldCookie)])
  let call = 0
  await runSiteMonitor('justwoker_models', {
    diagnose: true,
    triggerType: 'diagnose',
    hostnameValidator: noDnsBlock,
    fetchImpl: async () => {
      call += 1
      if (call === 1) return new Response(JSON.stringify({ success: true, data: { access_token: 'memory-only-token', token_type: 'Bearer' } }), { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'sid=new-session; Path=/; HttpOnly' } })
      return jsonResponse(['A'])
    },
  })
  const row = await dbGet("SELECT auth_secret, last_error FROM site_monitors WHERE source = 'justwoker_models'")
  assert.equal(decrypt(row.auth_secret), 'sid=new-session; device=stable')
  assert.equal(row.auth_secret.includes('new-session'), false)
  const runs = await dbAll("SELECT error_message FROM site_monitor_runs WHERE monitor_id = (SELECT id FROM site_monitors WHERE source = 'justwoker_models')")
  assert.equal(JSON.stringify({ row, runs }).includes('memory-only-token'), false)
})

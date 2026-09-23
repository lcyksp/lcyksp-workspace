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

test('an empty model list is an observation, not a failure', async () => {
  const monitorId = await resetMonitor('justwoker_models')
  await runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: async () => jsonResponse(['A', 'B']) })
  await dbRun('DELETE FROM site_monitor_deliveries')

  const emptyList = async () => jsonResponse([])
  // First empty observation: nothing is deactivated yet, nothing is mailed (two-missing-snapshots rule).
  await runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: emptyList })
  assert.equal((await dbGet("SELECT is_active FROM site_monitor_items WHERE item_key = 'a'")).is_active, 1)
  assert.equal((await dbGet('SELECT COUNT(*) count FROM site_monitor_deliveries WHERE monitor_id = ?', [monitorId])).count, 0)

  // Second consecutive empty observation: every model is removed and reported in one change email.
  await runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: emptyList })
  assert.equal((await dbGet("SELECT is_active FROM site_monitor_items WHERE item_key = 'a'")).is_active, 0)
  const removals = await dbAll("SELECT event_type, title FROM site_monitor_events WHERE monitor_id = ? ORDER BY id", [monitorId])
  assert.deepEqual(removals, [
    { event_type: 'model_removed', title: 'A' },
    { event_type: 'model_removed', title: 'B' },
  ])
  const delivery = await dbGet('SELECT body_html FROM site_monitor_deliveries WHERE monitor_id = ?', [monitorId])
  assert.equal(delivery.body_html.includes('下架模型'), true)

  // Recovery: the models come back and are reported as additions.
  await dbRun('DELETE FROM site_monitor_deliveries')
  await runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: async () => jsonResponse(['A', 'B']) })
  const events = await dbAll("SELECT event_type, title FROM site_monitor_events WHERE monitor_id = ? ORDER BY id", [monitorId])
  assert.deepEqual(events, [
    { event_type: 'model_removed', title: 'A' },
    { event_type: 'model_removed', title: 'B' },
    { event_type: 'model_added', title: 'A' },
    { event_type: 'model_added', title: 'B' },
  ])
  assert.equal((await dbGet("SELECT is_active FROM site_monitor_items WHERE item_key = 'a'")).is_active, 1)
})

test('an empty model list never becomes a baseline', async () => {
  const monitorId = await resetMonitor('justwoker_models')
  const emptyList = async () => jsonResponse([])
  await assert.rejects(runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: emptyList }))
  const monitor = await dbGet('SELECT baseline_ready, last_status FROM site_monitors WHERE id = ?', [monitorId])
  assert.deepEqual(monitor, { baseline_ready: 0, last_status: 'failed' })
  assert.equal((await dbGet('SELECT COUNT(*) count FROM site_monitor_items WHERE monitor_id = ?', [monitorId])).count, 0)

  // A rebuild against an empty list is rejected too, preserving the previous baseline.
  await runSiteMonitor('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: async () => jsonResponse(['A']) })
  await assert.rejects(rebuildSiteMonitorBaseline('justwoker_models', { hostnameValidator: noDnsBlock, fetchImpl: emptyList }))
  assert.equal((await dbGet('SELECT COUNT(*) count FROM site_monitor_items WHERE monitor_id = ?', [monitorId])).count, 1)
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

test('a network failure stores the machine code and the underlying socket errno', async () => {
  const monitorId = await resetMonitor('hzu_postgraduate')
  const socketError = new Error('connect ECONNRESET 202.192.230.232:443')
  socketError.code = 'ECONNRESET'
  const fetchFailure = new TypeError('fetch failed')
  fetchFailure.cause = socketError
  await assert.rejects(runSiteMonitor('hzu_postgraduate', {
    hostnameValidator: noDnsBlock,
    fetchImpl: async () => { throw fetchFailure },
  }))
  const run = await dbGet('SELECT error_message FROM site_monitor_runs WHERE monitor_id = ? ORDER BY id DESC LIMIT 1', [monitorId])
  assert.equal(run.error_message.includes('code=NETWORK_ERROR'), true)
  assert.equal(run.error_message.includes('cause=ECONNRESET'), true)
  const monitor = await dbGet('SELECT last_error FROM site_monitors WHERE id = ?', [monitorId])
  assert.equal(monitor.last_error.includes('cause=ECONNRESET'), true)
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
  await dbRun("UPDATE site_monitors SET enabled = 1, next_run_at = '2026-09-13 04:59:59'")
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
  const results = await runDueSiteMonitors({ fetchImpl, hostnameValidator: noDnsBlock, nowMs: Date.UTC(2026, 8, 13, 5, 0, 0) })
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

test('a new announcement carries its body into the event and into the email', async () => {
  const monitorId = await resetMonitor('hzu_postgraduate')
  const listA = '<a href="/2026/0901/c11241a101/page.htm">公告一</a>'
  const listB = '<a href="/2026/0902/c11241a102/page.htm">公告二</a>'
  await runSiteMonitor('hzu_postgraduate', { hostnameValidator: noDnsBlock, fetchImpl: async () => htmlResponse(listA) })
  await dbRun('DELETE FROM site_monitor_deliveries')

  const article = '<html><body><div class="entry">'
    + "<div class='wp_articlecontent'><p>这是公告二的正文，用来验证邮件里会带上公告内容。</p></div>"
    + '</div></body></html>'
  const requested = []
  await runSiteMonitor('hzu_postgraduate', {
    hostnameValidator: noDnsBlock,
    fetchImpl: async (url) => {
      requested.push(String(url))
      if (String(url).includes('list.htm')) return htmlResponse(listA + listB)
      return htmlResponse(article)
    },
  })

  // Exactly one extra request, and only for the article that is actually new.
  assert.equal(requested.length, 2)
  assert.equal(requested[1], 'https://www.hzu.edu.cn/2026/0902/c11241a102/page.htm')

  const event = await dbGet("SELECT payload_json FROM site_monitor_events WHERE monitor_id = ? AND event_type = 'announcement_added'", [monitorId])
  assert.equal(JSON.parse(event.payload_json).content.includes('这是公告二的正文'), true)

  const delivery = await dbGet('SELECT body_html FROM site_monitor_deliveries WHERE monitor_id = ?', [monitorId])
  assert.equal(delivery.body_html.includes('这是公告二的正文'), true)
  assert.equal(delivery.body_html.includes('公告二'), true)
})

test('a failed or unusable announcement body still notifies with title and link', async () => {
  const monitorId = await resetMonitor('hzu_postgraduate')
  const listA = '<a href="/2026/0901/c11241a101/page.htm">公告一</a>'
  const listB = '<a href="/2026/0902/c11241a102/page.htm">公告二</a>'
  await runSiteMonitor('hzu_postgraduate', { hostnameValidator: noDnsBlock, fetchImpl: async () => htmlResponse(listA) })
  await dbRun('DELETE FROM site_monitor_deliveries')

  const result = await runSiteMonitor('hzu_postgraduate', {
    hostnameValidator: noDnsBlock,
    fetchImpl: async (url) => (String(url).includes('list.htm')
      ? htmlResponse(listA + listB)
      : new Response('', { status: 500 })),
  })

  // The run itself must succeed: a body fetch is an enrichment, never a precondition.
  assert.equal(result.status, 'success')
  assert.equal(result.added.length, 1)
  const monitor = await dbGet('SELECT last_status, consecutive_failures FROM site_monitors WHERE id = ?', [monitorId])
  assert.deepEqual(monitor, { last_status: 'success', consecutive_failures: 0 })
  const event = await dbGet("SELECT payload_json FROM site_monitor_events WHERE monitor_id = ? AND event_type = 'announcement_added'", [monitorId])
  assert.equal(JSON.parse(event.payload_json).content, undefined)
  const delivery = await dbGet('SELECT body_html FROM site_monitor_deliveries WHERE monitor_id = ?', [monitorId])
  assert.equal(delivery.body_html.includes('公告二'), true)
})

test('an attachment-only announcement reports the file instead of an empty body', async () => {
  await resetMonitor('hzu_postgraduate')
  const listA = '<a href="/2026/0901/c11241a101/page.htm">公告一</a>'
  const listB = '<a href="/2026/0902/c11241a102/page.htm">公告二</a>'
  await runSiteMonitor('hzu_postgraduate', { hostnameValidator: noDnsBlock, fetchImpl: async () => htmlResponse(listA) })
  await dbRun('DELETE FROM site_monitor_deliveries')

  const pdfPage = '<html><body><div class="entry"><div class=\'wp_articlecontent\'>'
    + '<p><div pdfsrc="/_upload/article/files/aa/bb/cc.pdf" sudyfile-attr="{\'title\':\'招生目录.pdf\'}" class="wp_pdf_player"></div></p>'
    + '</div></div></body></html>'
  await runSiteMonitor('hzu_postgraduate', {
    hostnameValidator: noDnsBlock,
    fetchImpl: async (url) => (String(url).includes('list.htm') ? htmlResponse(listA + listB) : htmlResponse(pdfPage)),
  })

  const event = await dbGet("SELECT payload_json FROM site_monitor_events WHERE event_type = 'announcement_added'")
  const payload = JSON.parse(event.payload_json)
  assert.equal(payload.content, undefined)
  assert.equal(payload.attachment.url, 'https://www.hzu.edu.cn/_upload/article/files/aa/bb/cc.pdf')
  assert.equal(payload.attachment.title, '招生目录.pdf')

  const delivery = await dbGet('SELECT body_html FROM site_monitor_deliveries')
  assert.equal(delivery.body_html.includes('附件：'), true)
  assert.equal(delivery.body_html.includes('招生目录.pdf'), true)
})

test('announcement bodies are never fetched for a fresh or rebuilt baseline', async () => {
  await resetMonitor('hzu_postgraduate')
  const list = '<a href="/2026/0901/c11241a101/page.htm">公告一</a>'
  const requested = []
  await runSiteMonitor('hzu_postgraduate', {
    hostnameValidator: noDnsBlock,
    fetchImpl: async (url) => { requested.push(String(url)); return htmlResponse(list) },
  })
  // A baseline emits no events, so it must not crawl the articles either.
  assert.equal(requested.length, 1)

  requested.length = 0
  await rebuildSiteMonitorBaseline('hzu_postgraduate', {
    hostnameValidator: noDnsBlock,
    fetchImpl: async (url) => { requested.push(String(url)); return htmlResponse(list) },
  })
  assert.equal(requested.length, 1)
})

test('a paginated list captures deeper pages so a rotated older article does not re-alert', async () => {
  const monitorId = await resetMonitor('hzu_postgraduate')
  const nextLink = '<a href="/yjszs/list2.htm">下一页</a>'
  const a101 = '<a href="/2026/0901/c11241a101/page.htm">公告一</a>'
  const a102 = '<a href="/2026/0902/c11241a102/page.htm">公告二</a>'
  const requested = []
  const paged = async (url) => {
    const u = String(url)
    requested.push(u)
    if (u.endsWith('/yjszs/list.htm')) return htmlResponse(a101 + nextLink) // page 1: only 101 + link to page 2
    if (u.endsWith('/yjszs/list2.htm')) return htmlResponse(a102)           // page 2 carries the older 102
    return htmlResponse('') // article bodies are not expected here
  }

  // Baseline must ingest BOTH pages, not just page 1.
  const baseline = await runSiteMonitor('hzu_postgraduate', { hostnameValidator: noDnsBlock, fetchImpl: paged })
  assert.equal(baseline.status, 'baseline')
  assert.ok(requested.some((u) => u.endsWith('/yjszs/list2.htm')), 'deeper list page must be fetched')
  const items = await dbAll('SELECT item_key FROM site_monitor_items WHERE monitor_id = ? ORDER BY item_key', [monitorId])
  assert.deepEqual(items.map((r) => r.item_key), ['article:101', 'article:102'])

  await dbRun('DELETE FROM site_monitor_deliveries')
  // The site re-sorts 102 onto page 1. The record set is unchanged, so nothing is new.
  const rotated = await runSiteMonitor('hzu_postgraduate', {
    hostnameValidator: noDnsBlock,
    fetchImpl: async (url) => {
      const u = String(url)
      if (u.endsWith('/yjszs/list.htm')) return htmlResponse(a102 + a101 + nextLink) // 102 rotated to the top of page 1
      if (u.endsWith('/yjszs/list2.htm')) return htmlResponse(a101)                  // 101 now on page 2
      return htmlResponse('')
    },
  })
  assert.equal(rotated.status, 'success')
  assert.equal(rotated.added.length, 0, 'a rotated older article must not be reported as new')
  const deliveries = await dbGet('SELECT COUNT(*) count FROM site_monitor_deliveries WHERE monitor_id = ?', [monitorId])
  assert.equal(deliveries.count, 0)
})

test('a page-1 304 short-circuits before any deeper list page is fetched', async () => {
  await resetMonitor('hzu_postgraduate')
  const a101 = '<a href="/2026/0901/c11241a101/page.htm">公告一</a>'
  const nextLink = '<a href="/yjszs/list2.htm">下一页</a>'
  await runSiteMonitor('hzu_postgraduate', {
    hostnameValidator: noDnsBlock,
    fetchImpl: async (url) => (String(url).endsWith('/yjszs/list.htm') ? htmlResponse(a101 + nextLink) : htmlResponse('')),
  })

  const requested = []
  const result = await runSiteMonitor('hzu_postgraduate', {
    hostnameValidator: noDnsBlock,
    fetchImpl: async (url) => { requested.push(String(url)); return new Response(null, { status: 304 }) },
  })
  assert.equal(result.status, 'not_modified')
  assert.equal(requested.length, 1, 'a 304 on page 1 means nothing is new; deeper pages must not be fetched')
})

test('a failing deeper list page never fails the run; page 1 alone still parses', async () => {
  const monitorId = await resetMonitor('hzu_postgraduate')
  const a101 = '<a href="/2026/0901/c11241a101/page.htm">公告一</a>'
  const nextLink = '<a href="/yjszs/list2.htm">下一页</a>'
  const result = await runSiteMonitor('hzu_postgraduate', {
    hostnameValidator: noDnsBlock,
    fetchImpl: async (url) => {
      const u = String(url)
      if (u.endsWith('/yjszs/list.htm')) return htmlResponse(a101 + nextLink)
      if (u.endsWith('/yjszs/list2.htm')) throw new Error('deeper page down')
      return htmlResponse('')
    },
  })
  assert.equal(result.status, 'baseline')
  const monitor = await dbGet('SELECT last_status, consecutive_failures FROM site_monitors WHERE id = ?', [monitorId])
  assert.deepEqual(monitor, { last_status: 'success', consecutive_failures: 0 })
  const items = await dbAll('SELECT item_key FROM site_monitor_items WHERE monitor_id = ?', [monitorId])
  assert.deepEqual(items.map((r) => r.item_key), ['article:101'])
})

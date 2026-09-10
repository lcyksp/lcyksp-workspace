import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tempDir = await mkdtemp(path.join(tmpdir(), 'lcyksp-site-api-'))
process.env.LCYKSP_DB_DIR = tempDir
process.env.JWT_SECRET = 'site-monitor-admin-api-test-secret'
delete process.env.NODE_ENV

const { closeDb, getDb, initDb } = await import('../src/config/db.js')
await initDb()
const express = (await import('express')).default
const { signToken } = await import('../src/middleware/auth.js')
const { decrypt } = await import('../src/utils/crypto.js')
const siteMonitorRouter = (await import('../src/routes/siteMonitor.js')).default

function dbGet(sql, params = []) { return new Promise((resolve, reject) => getDb().get(sql, params, (e, row) => e ? reject(e) : resolve(row))) }
function dbRun(sql, params = []) { return new Promise((resolve, reject) => getDb().run(sql, params, function onRun(e) { e ? reject(e) : resolve({ lastID: this.lastID, changes: this.changes }) })) }

const app = express()
app.use(express.json())
app.use('/api/admin/site-monitor', siteMonitorRouter)
const server = app.listen(0)
await new Promise((resolve) => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}/api/admin/site-monitor`

const admin = await dbRun("INSERT INTO users (username, password, role) VALUES ('site-monitor-admin', 'x', 'admin')")
const member = await dbRun("INSERT INTO users (username, password, role) VALUES ('site-monitor-member', 'x', 'user')")
const adminToken = signToken({ userId: admin.lastID })
const memberToken = signToken({ userId: member.lastID })

async function call(method, urlPath, { token, body } = {}) {
  const response = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: response.status, json, text }
}

async function resetConfig() {
  await dbRun(`UPDATE site_monitors SET enabled = 0, auth_type = 'none', auth_secret = NULL,
    recipient_email = '1296757861@qq.com', next_run_at = NULL`)
}

test('every endpoint requires a signed-in administrator', async () => {
  const endpoints = [
    ['GET', '/'],
    ['POST', '/justwoker_models/config'],
    ['POST', '/justwoker_models/diagnose'],
    ['POST', '/justwoker_models/check'],
    ['POST', '/justwoker_models/rebuild-baseline'],
    ['GET', '/justwoker_models/events'],
    ['POST', '/test-email'],
  ]
  for (const [method, urlPath] of endpoints) {
    const anonymous = await call(method, urlPath)
    assert.equal(anonymous.status, 401, `${method} ${urlPath} anonymous`)
    const asMember = await call(method, urlPath, { token: memberToken })
    assert.equal(asMember.status, 403, `${method} ${urlPath} as member`)
    assert.equal(asMember.json.error.includes('仅管理员'), true)
  }
})

test('the overview exposes fixed periods, health and no credential material', async () => {
  await resetConfig()
  await dbRun("UPDATE site_monitors SET auth_type = 'cookie', auth_secret = ? WHERE source = 'justwoker_models'", [(await import('../src/utils/crypto.js')).encrypt('secret-cookie-value-1234')])
  const response = await call('GET', '/', { token: adminToken })
  assert.equal(response.status, 200)
  assert.equal(response.json.heartbeatSeconds, 300)
  assert.equal(response.json.smtpConfigured, false)

  const [justwoker, hzu] = response.json.monitors
  assert.equal(justwoker.source, 'justwoker_models')
  assert.equal(justwoker.intervalSeconds, 1800)
  assert.equal(justwoker.targetUrl, 'https://api.justwoker.icu/api/pricing')
  assert.equal(justwoker.intervalLabel, '30 分钟')
  assert.equal(justwoker.authConfigured, true)
  assert.equal(justwoker.authMask, '••••1234')
  assert.equal(justwoker.authLength, 24)
  assert.equal(hzu.intervalSeconds, 3600)
  assert.equal(hzu.intervalLabel, '60 分钟')
  assert.equal(hzu.authConfigured, false)
  assert.equal(Array.isArray(justwoker.recentRuns), true)
  assert.equal(typeof justwoker.deliveries.waiting, 'number')
  assert.equal(response.text.includes('secret-cookie-value-1234'), false)
  assert.equal(Object.keys(justwoker).includes('authSecret'), false)
})

test('saving a credential stores it encrypted and answers with a mask only', async () => {
  await resetConfig()
  const secret = 'sessionid=abcdefghijklmnop9876'
  const response = await call('POST', '/justwoker_models/config', {
    token: adminToken,
    body: { enabled: true, authType: 'cookie', authSecret: secret, recipientEmail: '1296757861@qq.com' },
  })
  assert.equal(response.status, 200)
  assert.equal(response.json.monitor.enabled, true)
  assert.equal(response.json.monitor.authConfigured, true)
  assert.equal(response.json.monitor.authMask, '••••9876')
  assert.equal(response.text.includes(secret), false)

  const row = await dbGet("SELECT auth_secret, recipient_email, enabled, next_run_at FROM site_monitors WHERE source = 'justwoker_models'")
  assert.notEqual(row.auth_secret, secret)
  assert.equal(decrypt(row.auth_secret), secret)
  assert.equal(row.enabled, 1)
  // Enabling should make the monitor due for the next heartbeat rather than one full period later.
  assert.equal(typeof row.next_run_at, 'string')
})

test('the fixed period cannot be changed through the configuration endpoint', async () => {
  await resetConfig()
  const response = await call('POST', '/hzu_postgraduate/config', {
    token: adminToken,
    body: { enabled: true, intervalSeconds: 60, interval_seconds: 60 },
  })
  assert.equal(response.status, 200)
  assert.equal(response.json.monitor.intervalSeconds, 3600)
  const row = await dbGet("SELECT interval_seconds FROM site_monitors WHERE source = 'hzu_postgraduate'")
  assert.equal(row.interval_seconds, 3600)
})

test('invalid configuration input is rejected before any write', async () => {
  await resetConfig()
  const cases = [
    [{ authType: 'basic' }, '认证方式'],
    [{ authType: 'cookie', authSecret: 'bad\r\nvalue' }, '换行符'],
    // A bare Cookie value copied out of DevTools is not a Cookie header and can never authenticate.
    // The sample is synthetic: never paste a real credential into the repository.
    [{ authType: 'cookie', authSecret: '00000000-1111-2222-3333-444444444444.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }, 'name=value'],
    [{ recipientEmail: 'not-an-email' }, '收件邮箱'],
    [{ enabled: true, authType: 'cookie' }, '请先保存凭据'],
  ]
  for (const [body, expected] of cases) {
    const response = await call('POST', '/justwoker_models/config', { token: adminToken, body })
    assert.equal(response.status, 400, `${JSON.stringify(body)} → ${response.status}`)
    assert.equal(response.json.error.includes(expected), true, `${JSON.stringify(body)} → ${response.json.error}`)
  }
  const row = await dbGet("SELECT enabled, auth_type, auth_secret FROM site_monitors WHERE source = 'justwoker_models'")
  assert.deepEqual(row, { enabled: 0, auth_type: 'none', auth_secret: null })
})

test('an unknown source never reaches the fetcher', async () => {
  for (const [method, urlPath] of [['POST', '/unknown/config'], ['POST', '/unknown/diagnose'], ['POST', '/unknown/check'], ['POST', '/unknown/rebuild-baseline'], ['GET', '/unknown/events']]) {
    const response = await call(method, urlPath, { token: adminToken, body: method === 'POST' ? {} : undefined })
    assert.equal(response.status, 400, `${method} ${urlPath}`)
    assert.equal(response.json.error, '未知的监测来源')
  }
})

test('event history is paginated newest first', async () => {
  const monitor = await dbGet("SELECT id FROM site_monitors WHERE source = 'hzu_postgraduate'")
  await dbRun('DELETE FROM site_monitor_events WHERE monitor_id = ?', [monitor.id])
  for (const index of [1, 2, 3]) {
    await dbRun(
      `INSERT INTO site_monitor_events (monitor_id, event_key, event_type, title, payload_json)
       VALUES (?, ?, 'announcement_added', ?, ?)`,
      [monitor.id, `api-test-key-${index}`, `公告 ${index}`, JSON.stringify({ url: `https://www.hzu.edu.cn/a${index}`, publishedAt: '2026-09-01' })],
    )
  }

  const first = await call('GET', '/hzu_postgraduate/events?page=1&pageSize=2', { token: adminToken })
  assert.equal(first.status, 200)
  assert.equal(first.json.total, 3)
  assert.equal(first.json.events.length, 2)
  assert.equal(first.json.events[0].title, '公告 3')
  assert.equal(first.json.events[0].url, 'https://www.hzu.edu.cn/a3')
  assert.equal(first.json.events[0].publishedAt, '2026-09-01')

  const second = await call('GET', '/hzu_postgraduate/events?page=2&pageSize=2', { token: adminToken })
  assert.equal(second.json.events.length, 1)
  assert.equal(second.json.events[0].title, '公告 1')

  const clamped = await call('GET', '/hzu_postgraduate/events?page=0&pageSize=999', { token: adminToken })
  assert.equal(clamped.json.page, 1)
  assert.equal(clamped.json.pageSize, 50)
})

test('the test mail reports SMTP problems and is protected by a cooldown', async () => {
  await dbRun("DELETE FROM system_config WHERE key IN ('github_smtp_user','github_smtp_password')")
  const first = await call('POST', '/test-email', { token: adminToken, body: { recipient: '1296757861@qq.com' } })
  assert.equal(first.status, 502)
  assert.equal(first.json.error.includes('测试邮件发送失败'), true)

  const second = await call('POST', '/test-email', { token: adminToken, body: { recipient: '1296757861@qq.com' } })
  assert.equal(second.status, 429)

  const invalid = await call('POST', '/test-email', { token: adminToken, body: { recipient: 'nope' } })
  // Address validation happens before the cooldown, so a malformed address is reported as such.
  assert.equal(invalid.status, 400)
})

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  await closeDb()
  await rm(tempDir, { recursive: true, force: true })
})

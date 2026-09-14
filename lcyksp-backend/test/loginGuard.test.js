import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tempDir = await mkdtemp(path.join(tmpdir(), 'lcyksp-login-guard-'))
process.env.LCYKSP_DB_DIR = tempDir

const { closeDb, initDb } = await import('../src/config/db.js')
const {
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_MINUTES,
  getLoginWindowStart,
  isLoginLocked,
  getLoginFailureCount,
  recordLoginFailure,
  clearLoginFailures,
} = await import('../src/utils/loginGuard.js')
await initDb()

test.after(async () => {
  await closeDb()
})

// 固定时钟：UTC 2026-09-14 10:07（北京时间 18:07），落在 10:00 桶
const NOW = Date.UTC(2026, 8, 14, 10, 7, 0)

test('窗口分桶：按 15 分钟对齐，跨桶/跨天正确', () => {
  assert.equal(getLoginWindowStart(new Date(Date.UTC(2026, 8, 14, 10, 0, 0))), '2026-09-14 10:00:00')
  assert.equal(getLoginWindowStart(new Date(Date.UTC(2026, 8, 14, 10, 14, 59))), '2026-09-14 10:00:00')
  assert.equal(getLoginWindowStart(new Date(Date.UTC(2026, 8, 14, 10, 15, 0))), '2026-09-14 10:15:00')
  assert.equal(getLoginWindowStart(new Date(Date.UTC(2026, 8, 14, 23, 59, 0))), '2026-09-14 23:45:00')
  assert.equal(getLoginWindowStart(new Date(Date.UTC(2026, 8, 15, 0, 0, 0))), '2026-09-15 00:00:00')
})

test('阈值与窗口常量：10 次 / 15 分钟', () => {
  assert.equal(LOGIN_MAX_FAILURES, 10)
  assert.equal(LOGIN_WINDOW_MINUTES, 15)
  assert.equal(isLoginLocked(LOGIN_MAX_FAILURES - 1), false)
  assert.equal(isLoginLocked(LOGIN_MAX_FAILURES), true)
})

test('未记录过的用户名失败计数为 0', async () => {
  assert.equal(await getLoginFailureCount('nobody', new Date(NOW)), 0)
})

test('同窗口内累计失败；进入新窗口自动归零（= 自动解锁）', async () => {
  await recordLoginFailure('alice', new Date(NOW))
  await recordLoginFailure('alice', new Date(NOW + 60_000))
  await recordLoginFailure('alice', new Date(NOW + 120_000))
  assert.equal(await getLoginFailureCount('alice', new Date(NOW + 180_000)), 3)
  assert.equal(await getLoginFailureCount('alice', new Date(NOW + 15 * 60_000)), 0)
})

test('累计达到阈值即锁定', async () => {
  for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
    await recordLoginFailure('bob', new Date(NOW))
  }
  assert.equal(await getLoginFailureCount('bob', new Date(NOW)), LOGIN_MAX_FAILURES)
  assert.equal(isLoginLocked(await getLoginFailureCount('bob', new Date(NOW))), true)
})

test('成功登录清零失败计数', async () => {
  await recordLoginFailure('carol', new Date(NOW))
  await recordLoginFailure('carol', new Date(NOW + 1000))
  await clearLoginFailures('carol')
  assert.equal(await getLoginFailureCount('carol', new Date(NOW)), 0)
})

test('不同用户名计数互不影响', async () => {
  await recordLoginFailure('dave', new Date(NOW))
  await recordLoginFailure('dave', new Date(NOW + 1000))
  assert.equal(await getLoginFailureCount('erin', new Date(NOW)), 0)
  assert.equal(await getLoginFailureCount('dave', new Date(NOW)), 2)
})

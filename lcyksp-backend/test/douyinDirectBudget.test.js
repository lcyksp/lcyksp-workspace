import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tempDir = await mkdtemp(path.join(tmpdir(), 'lcyksp-douyin-budget-'))
process.env.LCYKSP_DB_DIR = tempDir

const { closeDb, getDb, initDb } = await import('../src/config/db.js')
const {
  DIRECT_WINDOW_MS,
  isDirectWindowOpen,
  decideTaskExit,
  claimDirectBudget,
  directBudgetState,
  resetDirectBudget,
} = await import('../src/utils/douyinDirectBudget.js')
await initDb()

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => getDb().get(sql, params, (e, row) => (e ? reject(e) : resolve(row))))
}

// 固定时钟：北京时间 2026-09-13 15:00
const NOW = Date.UTC(2026, 8, 13, 7, 0, 0)

test('无记录 = 直连额度可用', () => {
  assert.equal(isDirectWindowOpen('', NOW), true)
  assert.equal(isDirectWindowOpen(undefined, NOW), true)
  assert.equal(isDirectWindowOpen('垃圾值', NOW), true)
})

test('窗口边界：4 小时整可用，差 1 毫秒不可用', () => {
  assert.equal(isDirectWindowOpen(new Date(NOW - DIRECT_WINDOW_MS).toISOString(), NOW), true)
  assert.equal(isDirectWindowOpen(new Date(NOW - DIRECT_WINDOW_MS + 1).toISOString(), NOW), false)
  assert.equal(isDirectWindowOpen(new Date(NOW - 1000).toISOString(), NOW), false)
  assert.equal(DIRECT_WINDOW_MS, 4 * 60 * 60 * 1000)
})

test('占用一次后窗口内不可再用，4 小时后自动恢复', async () => {
  await resetDirectBudget()

  let state = await directBudgetState(NOW)
  assert.equal(state.available, true)
  assert.equal(state.lastUsedAt, '')
  assert.equal(state.nextAvailableAt, '')

  assert.equal(await claimDirectBudget(NOW), true)
  state = await directBudgetState(NOW)
  assert.equal(state.available, false)
  assert.equal(state.lastUsedAt, new Date(NOW).toISOString())
  assert.equal(state.nextAvailableAt, new Date(NOW + DIRECT_WINDOW_MS).toISOString())

  // 同一窗口内再占：失败
  assert.equal(await claimDirectBudget(NOW + 60 * 1000), false)
  // 刚好满 4 小时：可用
  assert.equal(await claimDirectBudget(NOW + DIRECT_WINDOW_MS), true)
})

test('占用记录落库，重启（清缓存）后依然生效', async () => {
  await resetDirectBudget()
  await claimDirectBudget(NOW)
  const row = await dbGet("SELECT value FROM system_config WHERE key = 'douyin_direct_last_used_at'")
  assert.equal(row.value, new Date(NOW).toISOString())
})

test('并发占用只有一次能成功（进程内互斥）', async () => {
  await resetDirectBudget()
  const results = await Promise.all([
    claimDirectBudget(NOW),
    claimDirectBudget(NOW),
    claimDirectBudget(NOW),
    claimDirectBudget(NOW),
  ])
  assert.equal(results.filter(Boolean).length, 1)
})

test('管理员重置后立即可用', async () => {
  await resetDirectBudget()
  await claimDirectBudget(NOW)
  assert.equal(await claimDirectBudget(NOW + 1000), false)
  await resetDirectBudget()
  assert.equal((await directBudgetState(NOW + 1000)).available, true)
})

test('出口决策：unknown 绝不走直连（重启后不能白烧额度）', () => {
  // 没配池：只能直连
  assert.equal(decideTaskExit({ gate: 'unknown', hasPool: false, budgetOk: false }), 'direct')
  assert.equal(decideTaskExit({ gate: 'blocked', hasPool: false, budgetOk: false }), 'direct')
  // 有池但探测没说 ok：一律走池
  assert.equal(decideTaskExit({ gate: 'unknown', hasPool: true, budgetOk: false }), 'pool')
  assert.equal(decideTaskExit({ gate: 'blocked', hasPool: true, budgetOk: true }), 'pool')
  // 探测 ok：占到额度走直连，占不到走池
  assert.equal(decideTaskExit({ gate: 'ok', hasPool: true, budgetOk: true }), 'direct')
  assert.equal(decideTaskExit({ gate: 'ok', hasPool: true, budgetOk: false }), 'pool')
})

test('清理数据库连接', async () => {
  await resetDirectBudget()
  await closeDb()
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tempDir = await mkdtemp(path.join(tmpdir(), 'lcyksp-wtmarket-'))
process.env.LCYKSP_DB_DIR = tempDir

const { closeDb, getDb, initDb } = await import('../src/config/db.js')
const {
  extractJwtFromGsea,
  parseSearchRow,
  computePriceChange,
  beijingDate,
  saveCredentials,
  getStoredCredentials,
  getSnapshotStatus,
  runDailySnapshot,
  maskEmail,
  withRetry,
  computeMovers,
  logOp,
  getRecentLogs,
  WtMarketError,
} = await import('../src/utils/wtMarket.js')
await initDb()

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => getDb().get(sql, params, (e, row) => (e ? reject(e) : resolve(row))))
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => getDb().run(sql, params, function onRun(e) { e ? reject(e) : resolve({ changes: this.changes }) }))
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => getDb().all(sql, params, (e, rows) => (e ? reject(e) : resolve(rows || []))))
}

test('extractJwtFromGsea 从 postMessage 响应取 jwt', () => {
  const ok = 'window.postMessage({"gsea":true,"payload":{"status":"ok","uid":123,"jwt":"eyJabc.def.ghi"}},"*");'
  assert.equal(extractJwtFromGsea(ok), 'eyJabc.def.ghi')
  // 无 session：payload 里没有 jwt
  const noSession = 'window.postMessage({"gsea":true,"payload":{"status":"unknown","errors":[{"error":"no_session"}]}},"*");'
  assert.equal(extractJwtFromGsea(noSession), '')
  // 垃圾输入不抛错
  assert.equal(extractJwtFromGsea('not json at all'), '')
})

test('parseSearchRow 映射真实字段结构', () => {
  const asset = {
    appid: 1067,
    hash_name: 'id50347_mig_25pd_ussr',
    name: 'MiG-25PD (USSR)',
    icon: 'https://static-ggc.gaijin.net/units/mig_25pd.png',
    price: 3993000000,
    buy_price: 3302000000,
    depth: 820,
    buy_depth: 191,
    tags: ['type:aircraft', 'quality:ultraRare'],
    color: 'C816C1',
  }
  const row = parseSearchRow(asset)
  assert.equal(row.marketName, 'id50347_mig_25pd_ussr')
  assert.equal(row.displayName, 'MiG-25PD (USSR)')
  assert.equal(row.sellPrice, 3993000000)
  assert.equal(row.buyPrice, 3302000000)
  assert.equal(row.sellCount, 820)
  assert.equal(row.buyCount, 191)
  assert.deepEqual(row.tags, ['type:aircraft', 'quality:ultraRare'])
})

test('parseSearchRow 缺 hash_name 返回 null', () => {
  assert.equal(parseSearchRow(null), null)
  assert.equal(parseSearchRow({ name: 'no hash' }), null)
})

test('computePriceChange 算日/周涨跌幅', () => {
  const empty = computePriceChange([])
  assert.equal(empty.latest, null)

  const series = [
    { snapshot_date: '2026-09-10', sell_price: 100, buy_price: 90 },
    { snapshot_date: '2026-09-11', sell_price: 110, buy_price: 95 },
  ]
  const c = computePriceChange(series)
  assert.equal(c.latest.sell_price, 110)
  assert.equal(c.dayChange, 10) // 100 → 110 = +10%
})

test('beijingDate 是北京自然日 YYYY-MM-DD', () => {
  // 2026-09-18 23:00 UTC = 北京 09-19 07:00
  const d = beijingDate(new Date(Date.UTC(2026, 8, 18, 23, 0, 0)))
  assert.equal(d, '2026-09-19')
})

test('maskEmail 脱敏保留前2位与域名', () => {
  assert.match(maskEmail('demo-user@example.com'), /^de\*+@example\.com$/)
})

test('未配置凭据时 runDailySnapshot 优雅跳过、不抛错、写 last_error', async () => {
  const result = await runDailySnapshot()
  assert.equal(result.skipped, true)
  const status = await getSnapshotStatus()
  assert.equal(status.credentialsConfigured, false)
  assert.match(status.lastError, /未配置/)
})

test('saveCredentials 密码加密落库（不存明文），status 反映已配置', async () => {
  await saveCredentials('demo-user@example.com', 'secret-pass-123')
  const raw = await dbGet("SELECT value FROM system_config WHERE key = 'wt_market_password'")
  assert.notEqual(raw.value, 'secret-pass-123') // 密文，不是明文
  const creds = await getStoredCredentials()
  assert.equal(creds.login, 'demo-user@example.com')
  assert.equal(creds.password, 'secret-pass-123') // 解密后一致
  const status = await getSnapshotStatus()
  assert.equal(status.credentialsConfigured, true)
})

test('withRetry 对可重试错误退避后成功，不可重试错误立即抛', async () => {
  let calls = 0
  const val = await withRetry(
    async () => { calls += 1; if (calls < 2) throw new WtMarketError('限流', 'RATE_LIMITED'); return 'ok' },
    { retries: 2, baseDelayMs: 1, isRetryable: (e) => e.code === 'RATE_LIMITED' },
  )
  assert.equal(val, 'ok')
  assert.equal(calls, 2) // 第一次失败退避，第二次成功

  let calls2 = 0
  await assert.rejects(
    () => withRetry(
      async () => { calls2 += 1; throw new WtMarketError('凭据错', 'AUTH_FAILED') },
      { retries: 3, baseDelayMs: 1, isRetryable: (e) => e.code === 'RATE_LIMITED' },
    ),
    /凭据错/,
  )
  assert.equal(calls2, 1) // 不可重试，只调一次
})

test('computeMovers 取 3 天卖价涨最多 / 买价跌最快，历史不足跳过', () => {
  const items = [
    { id: 1, displayName: 'A', series: [
      { snapshot_date: '2026-09-15', sell_price: 100, buy_price: 90 },
      { snapshot_date: '2026-09-18', sell_price: 130, buy_price: 81 },
    ] }, // 卖 +30%，买 -10%
    { id: 2, displayName: 'B', series: [
      { snapshot_date: '2026-09-15', sell_price: 200, buy_price: 100 },
      { snapshot_date: '2026-09-18', sell_price: 210, buy_price: 70 },
    ] }, // 卖 +5%，买 -30%
    { id: 3, displayName: 'C', series: [
      { snapshot_date: '2026-09-18', sell_price: 500, buy_price: 400 },
    ] }, // 只有一天，无基准，跳过
  ]
  const m = computeMovers(items, { windowDays: 3, topN: 5 })
  assert.equal(m.topSellGainers[0].id, 1)
  assert.equal(m.topSellGainers[0].changePct, 30)
  assert.equal(m.topSellGainers[1].id, 2)
  assert.equal(m.topBuyDropers[0].id, 2)
  assert.equal(m.topBuyDropers[0].changePct, -30)
  assert.ok(!m.topSellGainers.some((x) => x.id === 3))
})

test('computePriceChange 附挂单数日环比变化（绝对量，近似换手）', () => {
  const series = [
    { snapshot_date: '2026-09-10', sell_price: 100, buy_price: 90, sell_count: 800, buy_count: 200 },
    { snapshot_date: '2026-09-11', sell_price: 110, buy_price: 95, sell_count: 830, buy_count: 180 },
  ]
  const c = computePriceChange(series)
  assert.equal(c.sellCountChange, 30) // 800 → 830
  assert.equal(c.buyCountChange, -20) // 200 → 180
  // 历史不足 2 天：无日环比，字段为 null
  const one = computePriceChange([{ snapshot_date: '2026-09-11', sell_price: 110, buy_price: 95, sell_count: 830, buy_count: 180 }])
  assert.equal(one.sellCountChange, null)
  assert.equal(one.buyCountChange, null)
  // 缺 count 列（旧快照）：countDelta 收到非有限值 → null，不抛错
  const missing = computePriceChange([
    { snapshot_date: '2026-09-10', sell_price: 100, buy_price: 90 },
    { snapshot_date: '2026-09-11', sell_price: 110, buy_price: 95 },
  ])
  assert.equal(missing.sellCountChange, null)
})

test('logOp 写入操作日志、getRecentLogs 倒序读回并截断详情', async () => {
  await logOp('login', { trigger: 'manual', status: 'ok', detail: 'JWT 换取成功（len 848）', exitIp: '112.5.x.x', durationMs: 1234 })
  await logOp('snapshot', { trigger: 'auto', status: 'fail', code: 'RECAPTCHA', detail: '出口被人机验证拦', exitIp: 'direct', durationMs: 567 })
  const logs = await getRecentLogs(10)
  assert.ok(logs.length >= 2)
  // 倒序：最近写入的 snapshot 在最前
  assert.equal(logs[0].op, 'snapshot')
  assert.equal(logs[0].status, 'fail')
  assert.equal(logs[0].code, 'RECAPTCHA')
  assert.equal(logs[0].exit_ip, 'direct')
  assert.equal(logs[0].duration_ms, 567)
  assert.equal(logs[1].op, 'login')
  assert.equal(logs[1].trigger, 'manual')
  assert.equal(logs[1].exit_ip, '112.5.x.x')

  // detail 超 500 字被截断
  await logOp('search', { trigger: 'user', status: 'fail', detail: 'x'.repeat(800) })
  const after = await getRecentLogs(1)
  assert.equal(after[0].op, 'search')
  assert.equal(after[0].detail.length, 500)
})

test('getRecentLogs limit 被夹在 1..200', async () => {
  const many = await getRecentLogs(9999)
  assert.ok(many.length <= 200)
  const few = await getRecentLogs(0) // 0 → 回落默认 50，再夹取
  assert.ok(few.length >= 1)
})

test('收藏：INSERT OR IGNORE 幂等 + 按用户隔离 + 取消 + 物品删除级联清理', async () => {
  // 造两个用户、两件物品
  await dbRun("INSERT INTO users (username, password) VALUES ('favuser1', 'x')")
  await dbRun("INSERT INTO users (username, password) VALUES ('favuser2', 'x')")
  const u1 = (await dbGet("SELECT id FROM users WHERE username = 'favuser1'")).id
  const u2 = (await dbGet("SELECT id FROM users WHERE username = 'favuser2'")).id
  await dbRun("INSERT INTO wt_market_items (market_name, display_name) VALUES ('fav_item_a', 'A')")
  await dbRun("INSERT INTO wt_market_items (market_name, display_name) VALUES ('fav_item_b', 'B')")
  const iA = (await dbGet("SELECT id FROM wt_market_items WHERE market_name = 'fav_item_a'")).id
  const iB = (await dbGet("SELECT id FROM wt_market_items WHERE market_name = 'fav_item_b'")).id

  // u1 收藏 A 两次（幂等）+ B；u2 收藏 A
  await dbRun('INSERT OR IGNORE INTO wt_market_favorites (user_id, item_id) VALUES (?, ?)', [u1, iA])
  await dbRun('INSERT OR IGNORE INTO wt_market_favorites (user_id, item_id) VALUES (?, ?)', [u1, iA]) // 重复不新增
  await dbRun('INSERT OR IGNORE INTO wt_market_favorites (user_id, item_id) VALUES (?, ?)', [u1, iB])
  await dbRun('INSERT OR IGNORE INTO wt_market_favorites (user_id, item_id) VALUES (?, ?)', [u2, iA])

  // u1 看到 A、B（2 件）；u2 只看到 A（隔离）
  const u1favs = (await dbAll('SELECT item_id FROM wt_market_favorites WHERE user_id = ? ORDER BY item_id', [u1])).map((r) => r.item_id)
  assert.deepEqual(u1favs, [iA, iB].sort((a, b) => a - b))
  const u2favs = (await dbAll('SELECT item_id FROM wt_market_favorites WHERE user_id = ?', [u2])).map((r) => r.item_id)
  assert.deepEqual(u2favs, [iA])

  // u1 取消收藏 A（幂等：再删一次 changes=0）
  const del1 = await dbRun('DELETE FROM wt_market_favorites WHERE user_id = ? AND item_id = ?', [u1, iA])
  assert.equal(del1.changes, 1)
  const del2 = await dbRun('DELETE FROM wt_market_favorites WHERE user_id = ? AND item_id = ?', [u1, iA])
  assert.equal(del2.changes, 0)
  // u2 的收藏不受影响
  assert.equal((await dbGet('SELECT COUNT(*) c FROM wt_market_favorites WHERE user_id = ?', [u2])).c, 1)

  // 删除物品 B → u1 对 B 的收藏被级联清理（foreign_keys=ON）
  await dbRun('DELETE FROM wt_market_items WHERE id = ?', [iB])
  assert.equal((await dbGet('SELECT COUNT(*) c FROM wt_market_favorites WHERE item_id = ?', [iB])).c, 0)
})

test('清理数据库连接', async () => {
  await closeDb()
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tempDir = await mkdtemp(path.join(tmpdir(), 'lcyksp-douyin-pool-'))
process.env.LCYKSP_DB_DIR = tempDir
delete process.env.DOUYIN_POOL_EXTRACT_URL // 避免环境变量干扰「旧配置迁移」用例

const { closeDb, getDb, initDb } = await import('../src/config/db.js')
const {
  BALANCE_ENDPOINT,
  buildBalanceSign,
  buildBalanceUrl,
  maskPoolUrl,
  orderPoolsForUse,
  normalizeStoredPools,
  parseTradeNoFromExtractUrl,
  poolEnabled,
  getPoolProxy,
  getPoolSnapshot,
  getPoolBalance,
  addPool,
  updatePool,
  deletePool,
  setActivePool,
  upsertPrimaryPool,
  resetPoolConfigCache,
  invalidatePoolProxy,
} = await import('../src/utils/douyinPool.js')
await initDb()

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => getDb().run(sql, params, (e) => (e ? reject(e) : resolve())))
}

async function clearConfig() {
  await dbRun("DELETE FROM system_config WHERE key LIKE 'douyin_pool%'")
  resetPoolConfigCache()
  invalidatePoolProxy()
}

const EXTRACT_A = 'http://v2.api.juliangip.com/dynamic/getips?num=1&trade_no=1111111111111111&sign=aaa'
const EXTRACT_B = 'http://v2.api.juliangip.com/dynamic/getips?num=1&trade_no=2222222222222222&sign=bbb'

/** 假的上游：按 trade_no 区分两个池，A 池总是「已到账期」，B 池可用。 */
function makeFetch({ balanceErrorForA = false } = {}) {
  const calls = []
  const fetchImpl = async (url) => {
    const u = String(url)
    calls.push(u)
    if (u.includes('/dynamic/balance')) {
      if (u.includes('trade_no=1111111111111111')) {
        if (balanceErrorForA) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ code: 401, msg: '签名校验失败', data: [] }) }
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, msg: '请求成功', data: { balance: 0 } }) }
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, msg: '请求成功', data: { balance: 9986 } }) }
    }
    if (u.includes('trade_no=1111111111111111')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 405, msg: '业务已到账期，请先续费订单或者重新下单', data: null }) }
    }
    if (u.includes('trade_no=2222222222222222')) {
      return { ok: true, status: 200, text: async () => '61.161.28.187:40919\n' }
    }
    return { ok: false, status: 404, text: async () => '' }
  }
  fetchImpl.calls = calls
  return fetchImpl
}

test('余量签名与官方示例向量一致', () => {
  // 官方文档：trade_no=1483587531995538 + key=b433718d3e374fea8cd5a368ff8a3f4f → 6f2bf01fa16e1c6bb1b70237dc3c7955
  assert.equal(
    buildBalanceSign('1483587531995538', 'b433718d3e374fea8cd5a368ff8a3f4f'),
    '6f2bf01fa16e1c6bb1b70237dc3c7955'
  )
  assert.equal(buildBalanceSign('1483587531995538', 'b433718d3e374fea8cd5a368ff8a3f4f').length, 32)
})

test('从提取链接里解析订单号，缺 key 时不给余量地址', () => {
  assert.equal(parseTradeNoFromExtractUrl(EXTRACT_A), '1111111111111111')
  assert.equal(parseTradeNoFromExtractUrl('not-a-url'), '')
  // 余额查询必须走 http：巨量 HTTPS 从本机握手失败（ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE）
  assert.ok(BALANCE_ENDPOINT.startsWith('http://'))
  const url = buildBalanceUrl({ url: EXTRACT_A, key: 'k'.repeat(32) })
  assert.ok(url.startsWith(`${BALANCE_ENDPOINT}?trade_no=1111111111111111&sign=`))
  assert.equal(buildBalanceUrl({ url: EXTRACT_A, key: '' }), '')
  assert.equal(buildBalanceUrl({ url: 'http://v2.api.juliangip.com/dynamic/getips', key: 'k' }), '')
})

test('提取链接脱敏后不留参数值', () => {
  const masked = maskPoolUrl(EXTRACT_A)
  assert.ok(!masked.includes('sign=aaa'))
  assert.ok(!masked.includes('1111111111111111'))
  assert.equal(maskPoolUrl(''), '')
})

test('池使用顺序：从当前池轮转，余量为 0 的池排到最后但仍保留兜底', () => {
  const pools = [
    { id: 'a', name: 'A', enabled: true },
    { id: 'b', name: 'B', enabled: true },
    { id: 'c', name: 'C', enabled: false },
  ]
  const order = orderPoolsForUse(pools, { activeId: 'b', balanceById: { a: { balance: 0 } } })
  assert.deepEqual(order.map((p) => p.id), ['b', 'a'])
  const order2 = orderPoolsForUse(pools, { activeId: '', balanceById: {} })
  assert.deepEqual(order2.map((p) => p.id), ['a', 'b'])
  assert.deepEqual(orderPoolsForUse([], {}), [])
})

test('池列表解析：坏数据丢弃、时效越界回默认', () => {
  assert.deepEqual(normalizeStoredPools('not json'), [])
  assert.deepEqual(normalizeStoredPools('{"a":1}'), [])
  const parsed = normalizeStoredPools(JSON.stringify([
    { name: '没有链接' },
    { id: 'p1', name: '有病', urlEnc: 'abc', ttlMs: 5 },
    { id: 'p2', urlEnc: 'def', ttlMs: 180000, enabled: false },
  ]))
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].id, 'p1')
  assert.equal(parsed[0].ttlMs, 60000) // 5ms 越界 → 回环境/默认
  assert.equal(parsed[1].enabled, false)
})

test('旧单链接配置会被识别成一个默认池（迁移兼容）', async () => {
  await clearConfig()
  await dbRun('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', ['douyin_pool_extract_url', EXTRACT_A])
  await dbRun('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', ['douyin_pool_ttl_ms', '60000'])
  resetPoolConfigCache()

  const snap = await getPoolSnapshot({ forceConfig: true, fetchImpl: makeFetch() })
  assert.equal(snap.pools.length, 1)
  assert.equal(snap.pools[0].id, 'default')
  assert.equal(snap.source, 'database')
  assert.equal(await poolEnabled(), true)
})

test('增删改池：写入后立即生效，删除当前池会自动落到下一个', async () => {
  await clearConfig()
  const idA = await addPool({ name: '主池', extractUrl: EXTRACT_A, key: 'k1', ttlMs: 60000 })
  const idB = await addPool({ name: '备池', extractUrl: EXTRACT_B, key: 'k2', ttlMs: 180000 })

  let snap = await getPoolSnapshot({ forceConfig: true, fetchImpl: makeFetch() })
  assert.equal(snap.pools.length, 2)
  assert.equal(snap.pools.find((p) => p.id === idA).hasKey, true)
  assert.equal(snap.pools.find((p) => p.id === idB).ttlMs, 180000)
  assert.equal(snap.activePoolId, idA)

  await setActivePool(idB)
  snap = await getPoolSnapshot({ forceConfig: true, fetchImpl: makeFetch() })
  assert.equal(snap.activePoolId, idB)
  assert.equal(snap.pools.find((p) => p.id === idB).active, true)

  await updatePool({ id: idB, key: '' })
  snap = await getPoolSnapshot({ forceConfig: true, fetchImpl: makeFetch() })
  assert.equal(snap.pools.find((p) => p.id === idB).hasKey, false)

  await deletePool(idB)
  snap = await getPoolSnapshot({ forceConfig: true, fetchImpl: makeFetch() })
  assert.equal(snap.pools.length, 1)
  assert.equal(snap.activePoolId, idA)
})

test('添加池时校验提取链接（没有 trade_no 一律拒绝）', async () => {
  await clearConfig()
  await assert.rejects(() => addPool({ name: 'x', extractUrl: 'http://v2.api.juliangip.com/dynamic/getips?num=1', ttlMs: 60000 }), /trade_no/)
  await assert.rejects(() => addPool({ name: 'x', extractUrl: 'ftp://x', ttlMs: 60000 }), /http/)
  await assert.rejects(() => addPool({ name: 'x', extractUrl: EXTRACT_A, ttlMs: 1000 }), /时效/)
})

test('余量查询：成功拿到数字，业务错误如实报错', async () => {
  await clearConfig()
  const ok = await getPoolBalance({ id: 'p', url: EXTRACT_B, key: 'k' }, { fetchImpl: makeFetch(), force: true })
  assert.equal(ok.balance, 9986)
  assert.equal(ok.error, '')

  const bad = await getPoolBalance({ id: 'q', url: EXTRACT_A, key: 'k' }, { fetchImpl: makeFetch({ balanceErrorForA: true }), force: true })
  assert.equal(bad.balance, null)
  assert.match(bad.error, /签名/)

  const noKey = await getPoolBalance({ id: 'r', url: EXTRACT_A, key: '' }, { fetchImpl: makeFetch() })
  assert.equal(noKey.error, '未配置业务 key')
})

test('当前池提取报「已到账期」→ 自动换下一个池并完成提取', async () => {
  await clearConfig()
  // 余量接口对 A 返回错误（拿不到余量数字），于是 A 排第一 → 提取必然撞上 405 → 必须自动换到 B
  const fetchImpl = makeFetch({ balanceErrorForA: true })
  const idA = await addPool({ name: '到账期池', extractUrl: EXTRACT_A, key: 'k1', ttlMs: 60000 })
  const idB = await addPool({ name: '可用池', extractUrl: EXTRACT_B, key: 'k2', ttlMs: 60000 })
  await setActivePool(idA)

  const proxy = await getPoolProxy({ fetchImpl })
  assert.equal(proxy, 'http://61.161.28.187:40919')
  const snap = await getPoolSnapshot({ forceConfig: true, fetchImpl })
  assert.equal(snap.activePoolId, idB)
})

test('当前池余量耗尽 → 自动切到下一个可用的池', async () => {
  await clearConfig()
  const fetchImpl = makeFetch()
  const idA = await addPool({ name: '已耗尽', extractUrl: EXTRACT_A, key: 'k1', ttlMs: 60000 })
  const idB = await addPool({ name: '可用', extractUrl: EXTRACT_B, key: 'k2', ttlMs: 60000 })
  await setActivePool(idA)

  const proxy = await getPoolProxy({ fetchImpl })
  assert.equal(proxy, 'http://61.161.28.187:40919')

  const snap = await getPoolSnapshot({ forceConfig: true, fetchImpl })
  assert.equal(snap.activePoolId, idB, '应当已经切到可用的池 B')
})

test('所有池都不可用 → 抛 poolExhausted（由调用方回落直连）', async () => {
  await clearConfig()
  await addPool({ name: '只有一个且已耗尽', extractUrl: EXTRACT_A, key: 'k1', ttlMs: 60000 })
  resetPoolConfigCache()

  await assert.rejects(() => getPoolProxy({ fetchImpl: makeFetch() }), (err) => {
    assert.equal(err.poolExhausted, true)
    return true
  })
})

test('未配置任何池时，取代理返回 null（调用方走直连）', async () => {
  await clearConfig()
  assert.equal(await poolEnabled(), false)
  assert.equal(await getPoolProxy(), null)
})

test('提取计数：真提取才 +1，缓存复用与余量查询都不计数', async () => {
  await clearConfig()
  const fetchImpl = makeFetch()
  await addPool({ name: '计数池', extractUrl: EXTRACT_B, key: 'k2', ttlMs: 60000 })
  resetPoolConfigCache()

  const before = (await getPoolSnapshot({ forceConfig: true, fetchImpl })).extractStats.today

  const proxy1 = await getPoolProxy({ fetchImpl })
  const proxy2 = await getPoolProxy({ fetchImpl }) // 命中缓存（60s TTL − 20s 安全边界）
  assert.equal(proxy1, proxy2, '第二次应复用同一个 IP')

  const snapshot = await getPoolSnapshot({ forceConfig: true, fetchImpl })
  assert.equal(snapshot.extractStats.today, before + 1, '只应计一次提取')
  assert.ok(snapshot.extractStats.total >= 1)
  assert.equal(typeof snapshot.extractStats.day, 'string')
})

test('低余量阈值：默认 200，可保存并在快照里回显', async () => {
  await clearConfig()
  let snap = await getPoolSnapshot({ forceConfig: true, fetchImpl: makeFetch() })
  assert.equal(snap.lowBalanceThreshold, 200)
  const { writeLowBalanceThreshold } = await import('../src/utils/douyinPool.js')
  assert.equal(await writeLowBalanceThreshold(50), 50)
  snap = await getPoolSnapshot({ forceConfig: true, fetchImpl: makeFetch() })
  assert.equal(snap.lowBalanceThreshold, 50)
  await assert.rejects(() => writeLowBalanceThreshold(-1), /阈值/)
})

test('upsertPrimaryPool：把旧单链接表单写进第一个池', async () => {
  await clearConfig()
  await dbRun('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', ['douyin_pool_extract_url', EXTRACT_A])
  const idB = await addPool({ name: '备池', extractUrl: EXTRACT_B, key: 'k2', ttlMs: 60000 })
  // 有池列表后，旧表单更新的是第一个池，而不是再写一份旧配置
  await upsertPrimaryPool({ extractUrl: EXTRACT_B, ttlMs: 120000 })
  const snap = await getPoolSnapshot({ forceConfig: true, fetchImpl: makeFetch() })
  assert.equal(snap.pools[0].id, 'default')
  assert.equal(snap.pools[0].ttlMs, 120000)
  assert.equal(snap.pools.find((p) => p.id === idB).ttlMs, 60000)
})

test('清理数据库连接', async () => {
  await clearConfig()
  await closeDb()
})

// 巨量HTTP 动态池管理器（多池版）：为抖音解析提供分钟级短效代理 IP。
//
// 设计目标：
//  1) 让 1 分钟时效的 IP 稳定覆盖一次完整解析（提取→请求→最多 3 次重试，全程 < 20 秒）；
//  2) 支持配置多个池订单，某个池余量耗尽/到账期时自动切到下一个，全部不可用才回落直连；
//  3) 能在管理后台看到每个池的剩余可提取 IP 数量（巨量官方 balance 接口）。
//
// 规则：
//  - 即用即取：解析开始时才提取，绝不预取（短时效 IP 攒不住）。
//  - 复用条件：缓存 IP 剩余寿命 > SAFETY_MARGIN_MS（一次解析全程 < 20s，20s 后一律换新，杜绝请求中途过期）；
//    缓存按池隔离，切换池后不会误用旧池的 IP。
//  - 提取失败：业务类错误（到账期/余额不足/参数错）→ 立刻换下一个池；限频/网络错误 → 退避重试后换下一个池。
//  - 全部池不可用 → 抛 poolExhausted 错误，由调用方决定回落直连。
//
// 配置来源（优先级）：system_config 的池列表 > 旧单链接配置（douyin_pool_extract_url）> 环境变量。
// 配置读取带 30 秒缓存；管理后台保存后调用 resetPoolConfigCache() 立即生效。
//
// 注意：巨量 API 的 HTTPS 从本机/服务器证书握手会失败（ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE），
// 余量查询必须走 http（提取链接本身也是 http，同一套签名凭证，不额外扩大暴露面）。
import { createHash } from 'crypto'
import { getDb } from '../config/db.js'
import { decrypt, encrypt } from './crypto.js'
import { sendSiteMonitorEmail, getGithubMailConfig, smtpConfigured } from './githubMail.js'

const ENV_EXTRACT_URL = process.env.DOUYIN_POOL_EXTRACT_URL || ''
const ENV_TTL_MS = Number(process.env.DOUYIN_POOL_TTL_MS) || 60 * 1000
const SAFETY_MARGIN_MS = 20 * 1000
const EXTRACT_RETRY_DELAYS = [0, 1100, 2300] // 提取限频 1 秒 1 次：撞限频时退避重试
const CONFIG_CACHE_MS = 30 * 1000
const BALANCE_CACHE_MS = 10 * 60 * 1000
const BALANCE_ERROR_CACHE_MS = 2 * 60 * 1000
const LOW_WARN_COOLDOWN_MS = 12 * 60 * 60 * 1000

const LIST_KEY = 'douyin_pool_list'
const LEGACY_URL_KEY = 'douyin_pool_extract_url'
const LEGACY_TTL_KEY = 'douyin_pool_ttl_ms'
const ACTIVE_KEY = 'douyin_pool_active_id'
const THRESHOLD_KEY = 'douyin_pool_low_balance'
const LOW_WARN_KEY = 'douyin_pool_low_warn_at'

export const LOW_BALANCE_DEFAULT = 200
export const BALANCE_ENDPOINT = 'http://v2.api.juliangip.com/dynamic/balance'

let configCache = { at: 0, value: null }
let balanceCache = new Map() // poolId -> { balance, at, error }
let cached = null // { proxyUrl, poolId, expireAt }
let activePoolId = null

// 提取计数：站长要求「尽可能少烧 IP」，那就得先看得见烧了多少。
// 今日计数放内存（进程内按自然日，重启清零），累计值落 system_config。
const extractStats = { day: '' }
const EXTRACT_TOTAL_KEY = 'douyin_pool_extract_total'

function todayKey() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10) // 北京时间自然日
}

/** 每成功提取一个池 IP 记一次。 */
function recordExtract() {
  const day = todayKey()
  if (extractStats.day !== day) {
    extractStats.day = day
    extractStats.today = 0
  }
  extractStats.today += 1
  // 累计值异步累加，不拖慢请求
  dbRun(
    'INSERT INTO system_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)',
    [EXTRACT_TOTAL_KEY, '1']
  ).catch(() => {})
}

export function getPoolExtractStats() {
  const day = todayKey()
  const today = extractStats.day === day ? extractStats.today : 0
  return { day, today, total: extractStats.total }
}

function dbAll(sql, params = []) {
  const db = getDb()
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))))
}

function dbRun(sql, params = []) {
  const db = getDb()
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())))
}

// ---------- 纯函数（可单测） ----------

/** 提取链接里的订单号（巨量 trade_no）。 */
export function parseTradeNoFromExtractUrl(url) {
  try {
    return new URL(String(url || '')).searchParams.get('trade_no') || ''
  } catch {
    return ''
  }
}

/** 余量接口签名：md5("trade_no=<订单号>&key=<业务key>")，32 位小写（已用官方示例验签）。 */
export function buildBalanceSign(tradeNo, key) {
  return createHash('md5').update(`trade_no=${tradeNo}&key=${key}`).digest('hex')
}

/** 组装余量查询地址；缺订单号或业务 key 时返回空串（表示查不了）。 */
export function buildBalanceUrl(pool) {
  const tradeNo = parseTradeNoFromExtractUrl(pool?.url)
  if (!tradeNo || !pool?.key) return ''
  return `${BALANCE_ENDPOINT}?trade_no=${encodeURIComponent(tradeNo)}&sign=${buildBalanceSign(tradeNo, pool.key)}`
}

/** 提取链接脱敏（后台展示用）。 */
export function maskPoolUrl(value) {
  const s = String(value || '')
  if (!s) return ''
  const q = s.indexOf('?')
  return q === -1 ? `${s.slice(0, 24)}…<已保存>` : `${s.slice(0, q + 1)}…<参数已脱敏，共 ${s.length} 字符>`
}

/**
 * 池使用顺序（纯函数）：从当前池开始顺时针轮转，
 * 已知余量为 0 的池排到最后（仍保留兜底尝试，避免余量数据陈旧导致完全不可用）。
 */
export function orderPoolsForUse(pools, { activeId = '', balanceById = {} } = {}) {
  const enabled = (pools || []).filter((p) => p.enabled !== false)
  if (!enabled.length) return []
  const idx = enabled.findIndex((p) => p.id === activeId)
  const start = idx >= 0 ? idx : 0
  const rotated = [...enabled.slice(start), ...enabled.slice(0, start)]
  const isEmpty = (p) => {
    const b = balanceById[p.id]
    return Boolean(b) && Number.isFinite(b.balance) && b.balance <= 0
  }
  return [...rotated.filter((p) => !isEmpty(p)), ...rotated.filter(isEmpty)]
}

/** 把数据库里的池列表 JSON 解析成存储结构（纯函数，坏数据一律丢弃而不是抛错）。 */
export function normalizeStoredPools(rawJson) {
  let parsed = null
  try {
    parsed = JSON.parse(String(rawJson || ''))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out = []
  parsed.forEach((item, index) => {
    if (!item || typeof item !== 'object') return
    const urlEnc = String(item.urlEnc || item.url || '').trim()
    if (!urlEnc) return
    const ttl = Number(item.ttlMs)
    out.push({
      id: String(item.id || `pool-${index + 1}`),
      name: String(item.name || `池 ${index + 1}`).slice(0, 40),
      urlEnc,
      keyEnc: String(item.keyEnc || item.key || '').trim(),
      ttlMs: Number.isFinite(ttl) && ttl >= 30 * 1000 && ttl <= 3600 * 1000 ? ttl : ENV_TTL_MS,
      enabled: item.enabled !== false,
    })
  })
  return out
}

// ---------- 配置读写 ----------

function decodeSecret(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const dec = decrypt(raw)
  return dec || raw // 兼容直接存明文的历史配置
}

function toRuntimePool(stored) {
  return {
    id: stored.id,
    name: stored.name,
    url: decodeSecret(stored.urlEnc),
    key: decodeSecret(stored.keyEnc),
    ttlMs: stored.ttlMs,
    enabled: stored.enabled,
  }
}

async function readConfigRows() {
  const rows = await dbAll(
    'SELECT key, value FROM system_config WHERE key IN (?, ?, ?, ?, ?, ?, ?)',
    [LIST_KEY, LEGACY_URL_KEY, LEGACY_TTL_KEY, ACTIVE_KEY, THRESHOLD_KEY, LOW_WARN_KEY, EXTRACT_TOTAL_KEY]
  )
  const map = {}
  for (const row of rows) map[row.key] = row.value
  return map
}

export async function loadPoolConfig({ force = false } = {}) {
  if (!force && configCache.value && Date.now() - configCache.at < CONFIG_CACHE_MS) return configCache.value

  let map = {}
  try {
    map = await readConfigRows()
  } catch (err) {
    console.error('[DouyinPool] 读取池配置失败，沿用当前配置:', err.message)
    if (configCache.value) return configCache.value
    map = {}
  }

  const totalRaw = Number(map[EXTRACT_TOTAL_KEY])
  extractStats.total = Number.isFinite(totalRaw) && totalRaw >= 0 ? totalRaw : 0

  let source = 'none'
  let stored = normalizeStoredPools(map[LIST_KEY])
  if (stored.length) {
    source = 'database'
  } else {
    const legacyUrl = map[LEGACY_URL_KEY] || ENV_EXTRACT_URL
    const legacyTtl = Number(map[LEGACY_TTL_KEY]) || ENV_TTL_MS
    if (legacyUrl) {
      stored = [{ id: 'default', name: '默认池（旧单链接配置）', urlEnc: legacyUrl, keyEnc: '', ttlMs: legacyTtl, enabled: true }]
      source = map[LEGACY_URL_KEY] ? 'database' : 'env'
    }
  }

  const thresholdRaw = Number(map[THRESHOLD_KEY])
  const value = {
    pools: stored.map(toRuntimePool).filter((p) => p.url),
    stored,
    lowBalanceThreshold: Number.isFinite(thresholdRaw) && thresholdRaw >= 0 ? thresholdRaw : LOW_BALANCE_DEFAULT,
    source,
    activeIdFromDb: String(map[ACTIVE_KEY] || ''),
  }
  configCache = { at: Date.now(), value }
  if (!activePoolId && value.activeIdFromDb) activePoolId = value.activeIdFromDb
  return value
}

async function writeStoredPools(storedPools) {
  // 注意：这里接收的是「存储结构」（urlEnc/keyEnc 已加密），别再当成运行时结构二次加密
  const payload = JSON.stringify(
    (storedPools || [])
      .filter((p) => p && p.urlEnc)
      .map((p) => ({
        id: String(p.id),
        name: String(p.name || '').slice(0, 40),
        urlEnc: String(p.urlEnc),
        keyEnc: String(p.keyEnc || ''),
        ttlMs: Number(p.ttlMs) || 60000,
        enabled: p.enabled !== false,
      }))
  )
  await dbRun('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', [LIST_KEY, payload])
  configCache.at = 0
  invalidatePoolProxy()
}

/** 写操作前的「当前有效池列表」（列表为空时把旧单链接配置实体化，避免丢配置）。 */
async function effectiveStoredPools() {
  const cfg = await loadPoolConfig({ force: true })
  return cfg.stored.length ? cfg.stored : []
}

export async function poolEnabled() {
  const cfg = await loadPoolConfig()
  return cfg.pools.some((p) => p.enabled !== false)
}

export async function poolSource() {
  const cfg = await loadPoolConfig()
  return cfg.source
}

export async function readLowBalanceThreshold() {
  const cfg = await loadPoolConfig()
  return cfg.lowBalanceThreshold
}

export async function writeLowBalanceThreshold(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || n > 1000000) throw new Error('余量预警阈值需为 0 - 1000000 之间的数字')
  await dbRun('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', [THRESHOLD_KEY, String(Math.floor(n))])
  configCache.at = 0
  return Math.floor(n)
}

export async function setActivePool(id) {
  const cfg = await loadPoolConfig()
  const pool = cfg.pools.find((p) => p.id === id)
  if (!pool) throw new Error('指定的池不存在')
  activePoolId = id
  await dbRun('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', [ACTIVE_KEY, id])
  invalidatePoolProxy()
  return pool
}

export function getActivePoolIdSync() {
  return activePoolId
}

// ---------- 池 CRUD（管理后台） ----------

export async function addPool({ name, extractUrl, key, ttlMs }) {
  const url = String(extractUrl || '').trim()
  if (!/^https?:\/\/.+/i.test(url) || url.length > 2000) throw new Error('提取链接必须是合法的 http(s) 地址（长度 ≤ 2000）')
  const ttl = Number(ttlMs) || 60000
  if (ttl < 30 * 1000 || ttl > 3600 * 1000) throw new Error('IP 时效超出允许范围（30 秒 - 60 分钟）')
  if (!parseTradeNoFromExtractUrl(url)) throw new Error('提取链接里没有 trade_no，无法识别订单（请使用巨量后台生成的完整提取链接）')
  const stored = await effectiveStoredPools()
  const id = `pool-${Date.now().toString(36)}`
  stored.push({
    id,
    name: String(name || `池 ${stored.length + 1}`).slice(0, 40),
    urlEnc: encrypt(url) || url,
    keyEnc: key ? encrypt(String(key).trim()) || String(key).trim() : '',
    ttlMs: ttl,
    enabled: true,
  })
  await writeStoredPools(stored)
  if (!activePoolId) {
    activePoolId = id
    await dbRun('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', [ACTIVE_KEY, id])
  }
  return id
}

export async function updatePool({ id, name, extractUrl, key, ttlMs, enabled }) {
  const stored = await effectiveStoredPools()
  const target = stored.find((p) => p.id === id)
  if (!target) throw new Error('指定的池不存在')
  if (name !== undefined) target.name = String(name || target.name).slice(0, 40)
  if (extractUrl !== undefined && String(extractUrl).trim()) {
    const url = String(extractUrl).trim()
    if (!/^https?:\/\/.+/i.test(url) || url.length > 2000) throw new Error('提取链接必须是合法的 http(s) 地址（长度 ≤ 2000）')
    if (!parseTradeNoFromExtractUrl(url)) throw new Error('提取链接里没有 trade_no，无法识别订单')
    target.urlEnc = encrypt(url) || url
  }
  if (key !== undefined) target.keyEnc = String(key).trim() ? encrypt(String(key).trim()) || String(key).trim() : ''
  if (ttlMs !== undefined) {
    const ttl = Number(ttlMs)
    if (!Number.isFinite(ttl) || ttl < 30 * 1000 || ttl > 3600 * 1000) throw new Error('IP 时效超出允许范围（30 秒 - 60 分钟）')
    target.ttlMs = ttl
  }
  if (enabled !== undefined) target.enabled = Boolean(enabled)
  await writeStoredPools(stored)
  balanceCache.delete(id)
  return true
}

/** 兼容旧「单提取链接」表单：有池列表就更新第一个池，没有就写旧单链接配置键。 */
export async function upsertPrimaryPool({ extractUrl, ttlMs }) {
  const stored = await effectiveStoredPools()
  if (!stored.length) {
    await dbRun('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', [LEGACY_URL_KEY, encrypt(extractUrl) || extractUrl])
    await dbRun('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', [LEGACY_TTL_KEY, String(Number(ttlMs) || 60000)])
    resetPoolConfigCache()
    return 'legacy'
  }
  await updatePool({ id: stored[0].id, extractUrl, ttlMs })
  return stored[0].id
}

/** 删除一个池；删掉当前池时自动把第一个可用池设为当前。 */
export async function deletePool(id) {
  const stored = await effectiveStoredPools()
  if (!stored.some((p) => p.id === id)) throw new Error('指定的池不存在')
  await writeStoredPools(stored.filter((p) => p.id !== id))
  balanceCache.delete(id)
  if (activePoolId === id) {
    activePoolId = null
    const next = (await loadPoolConfig({ force: true })).pools[0]
    if (next) {
      activePoolId = next.id
      await dbRun('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', [ACTIVE_KEY, next.id])
    } else {
      await dbRun('DELETE FROM system_config WHERE key = ?', [ACTIVE_KEY])
    }
  }
  return true
}

// ---------- 余量查询 ----------

export async function getPoolBalance(pool, { fetchImpl = fetch, force = false } = {}) {
  if (!pool) return { balance: null, at: '', error: '池不存在' }
  const url = buildBalanceUrl(pool)
  if (!url) return { balance: null, at: '', error: pool.key ? '提取链接缺少 trade_no' : '未配置业务 key' }
  const cachedRow = balanceCache.get(pool.id)
  const ttl = cachedRow?.error ? BALANCE_ERROR_CACHE_MS : BALANCE_CACHE_MS
  if (!force && cachedRow && Date.now() - cachedRow.at < ttl) return cachedRow
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10000) })
    const text = (await res.text()).trim()
    let json = null
    try {
      json = JSON.parse(text)
    } catch { /* 非 JSON，按错误处理 */ }
    if (!json) {
      const row = { balance: null, at: Date.now(), error: `余量接口返回异常：${text.slice(0, 60)}` }
      balanceCache.set(pool.id, row)
      return row
    }
    if (json.code !== 200 || !json.data || json.data.balance === undefined) {
      const row = { balance: null, at: Date.now(), error: String(json.msg || `code=${json.code}`).slice(0, 60) }
      balanceCache.set(pool.id, row)
      return row
    }
    const row = { balance: Number(json.data.balance), at: Date.now(), error: '' }
    balanceCache.set(pool.id, row)
    return row
  } catch (err) {
    const row = { balance: null, at: Date.now(), error: `余量接口请求失败：${String(err.message || err).slice(0, 60)}` }
    balanceCache.set(pool.id, row)
    return row
  }
}

async function balanceMap(pools, options) {
  const map = {}
  for (const pool of pools) {
    const row = await getPoolBalance(pool, options)
    map[pool.id] = row
  }
  return map
}

/** 后台展示用快照。 */
export async function getPoolSnapshot(options = {}) {
  const cfg = await loadPoolConfig({ force: options.forceConfig })
  const pools = cfg.pools
  if (!activePoolId && pools.length) activePoolId = cfg.activeIdFromDb || pools[0].id
  const out = []
  for (const pool of pools) {
    const bal = await getPoolBalance(pool, options)
    const tradeNo = parseTradeNoFromExtractUrl(pool.url)
    out.push({
      id: pool.id,
      name: pool.name,
      enabled: pool.enabled !== false,
      active: pool.id === activePoolId,
      ttlMs: pool.ttlMs,
      urlMasked: maskPoolUrl(pool.url),
      hasKey: Boolean(pool.key),
      tradeNoTail: tradeNo ? `…${tradeNo.slice(-4)}` : '',
      balance: bal.balance,
      balanceAt: bal.at,
      balanceError: bal.error,
    })
  }
  const totalBalance = out.reduce((sum, p) => (Number.isFinite(p.balance) ? sum + p.balance : sum), 0)
  const stats = getPoolExtractStats()
  return {
    pools: out,
    activePoolId: activePoolId || '',
    lowBalanceThreshold: cfg.lowBalanceThreshold,
    source: cfg.source,
    extractStats: {
      day: stats.day,
      today: stats.today,
      total: stats.total,
      // 按今日速度估算剩余可用天数（今日没消耗就不估算）
      estimatedDaysLeft: stats.today > 0 && totalBalance > 0 ? Math.floor(totalBalance / stats.today) : null,
    },
  }
}

// ---------- 提取 ----------

async function extractOnce(pool, fetchImpl) {
  const res = await fetchImpl(pool.url, { signal: AbortSignal.timeout(8000) })
  const text = (await res.text()).trim()
  if (!res.ok) {
    const err = new Error(`douyin pool extract failed: HTTP ${res.status}`)
    err.businessError = true
    throw err
  }
  // 巨量提取默认返回纯文本（每行一个 ip:port）；出错时返回 JSON（含 code/msg）
  if (text.startsWith('{')) {
    const json = JSON.parse(text)
    if ((json.code && json.code !== 0) || json.error_msg) {
      const err = new Error(`douyin pool extract error: ${json.msg || json.error_msg || json.code}`)
      err.businessError = true
      throw err
    }
  }
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(l))
  if (!line) throw new Error(`douyin pool extract returned no usable ip: ${text.slice(0, 80)}`)

  const [ip, port] = line.split(':')
  return { proxyUrl: `http://${ip}:${port}`, expireAt: Date.now() + pool.ttlMs }
}

async function extractWithRetry(pool, fetchImpl) {
  let lastErr = null
  for (const delay of EXTRACT_RETRY_DELAYS) {
    if (delay) await new Promise((r) => setTimeout(r, delay))
    try {
      return await extractOnce(pool, fetchImpl)
    } catch (err) {
      lastErr = err
      // 业务类错误（到账期/余额不足/参数错）重试也不会好，立刻换下一个池
      if (err.businessError) break
    }
  }
  throw lastErr || new Error('douyin pool extract failed')
}

/**
 * 取一个可用的池代理地址。
 *  - 不传 poolId：从当前池开始轮转，余量耗尽的池自动跳过、失败自动换下一个；
 *  - 传 poolId：只测/只用指定池（后台「测试这个池」用）。
 * 抛错 = 所有池都不可用（err.poolExhausted = true），调用方应回落直连。
 */
export async function getPoolProxy(options = {}) {
  const { poolId = '', fetchImpl = fetch } = options
  const cfg = await loadPoolConfig()
  if (!cfg.pools.length) return null

  let ordered
  if (poolId) {
    const target = cfg.pools.find((p) => p.id === poolId)
    if (!target) {
      const err = new Error('指定的池不存在')
      err.poolMissing = true
      throw err
    }
    ordered = [target]
  } else {
    const map = await balanceMap(cfg.pools, { fetchImpl })
    ordered = orderPoolsForUse(cfg.pools, { activeId: activePoolId || cfg.activeIdFromDb, balanceById: map })
  }

  // 缓存命中：仍是同一个池且 IP 剩余寿命够用 → 直接复用（绝不跨池复用短效 IP）
  const now = Date.now()
  if (cached && ordered[0] && cached.poolId === ordered[0].id && cached.expireAt - now > SAFETY_MARGIN_MS) {
    return cached.proxyUrl
  }

  const failures = []
  for (const pool of ordered) {
    try {
      const proxy = await extractWithRetry(pool, fetchImpl)
      const switched = !poolId && activePoolId && pool.id !== activePoolId
      cached = { proxyUrl: proxy.proxyUrl, poolId: pool.id, expireAt: proxy.expireAt }
      if (!poolId && activePoolId !== pool.id) {
        activePoolId = pool.id
        dbRun('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', [ACTIVE_KEY, pool.id]).catch(() => {})
      }
      decrementBalance(pool.id)
      recordExtract()
      if (switched) console.error(`[DouyinPool] 已自动切换到池「${pool.name}」`)
      return proxy.proxyUrl
    } catch (err) {
      failures.push(`${pool.name}: ${err.message}`)
      console.error(`[DouyinPool] 池「${pool.name}」提取失败：${err.message}`)
      if (err.businessError) balanceCache.set(pool.id, { balance: 0, at: Date.now(), error: String(err.message).slice(0, 60) })
    }
  }

  const err = new Error(`所有动态池均不可用（${failures.join(' | ')}）`)
  err.poolExhausted = true
  throw err
}

/** 提取成功一次，本地乐观减一（后台显示更接近真实，官方数字以余量接口为准）。 */
function decrementBalance(poolId) {
  const row = balanceCache.get(poolId)
  if (row && Number.isFinite(row.balance) && row.balance > 0) {
    balanceCache.set(poolId, { ...row, balance: row.balance - 1 })
  }
}

/** 强制作废缓存 IP（请求被 403/静默拒绝后调用），下次提取拿新 IP。 */
export function invalidatePoolProxy() {
  cached = null
}

/** 管理后台保存新配置后调用：清配置缓存 + 余量缓存 + 作废当前池 IP；当前池改为重新从库里读。 */
export function resetPoolConfigCache() {
  configCache.at = 0
  balanceCache = new Map()
  activePoolId = null
  invalidatePoolProxy()
}

// ---------- 余量预警 ----------

function looksEmail(v) {
  return /.+@.+\..+/.test(String(v || ''))
}

async function notifyAddress() {
  const cfg = await getGithubMailConfig()
  // 收件人：优先发件地址，但它可能存的是显示名（如「GitHub日报」）→ 回退 SMTP 登录账号
  return looksEmail(cfg.from) ? cfg.from : looksEmail(cfg.user) ? cfg.user : ''
}

async function readLowWarnAt() {
  try {
    const rows = await dbAll('SELECT value FROM system_config WHERE key = ?', [LOW_WARN_KEY])
    return String(rows[0]?.value || '')
  } catch {
    return ''
  }
}

/**
 * 检查所有池的余量，低于阈值（默认 200）时发一封预警邮件（12 小时内不重复发）。
 * 余量回升后清除记录，下次再跌破会重新预警。
 * 返回值给管理后台/日志用，不抛错。
 */
export async function checkPoolBalanceAndWarn(options = {}) {
  let cfg
  try {
    cfg = await loadPoolConfig({ force: options.forceConfig })
  } catch (err) {
    return { checked: 0, low: [], warned: false, error: err.message }
  }
  const pools = cfg.pools.filter((p) => p.enabled !== false)
  if (!pools.length) return { checked: 0, low: [], warned: false, error: '未配置动态池' }

  const threshold = cfg.lowBalanceThreshold
  const low = []
  for (const pool of pools) {
    const row = await getPoolBalance(pool, { ...options, force: true })
    if (row.error) {
      low.push({ name: pool.name, balance: null, note: row.error })
    } else if (Number.isFinite(row.balance) && row.balance <= threshold) {
      low.push({ name: pool.name, balance: row.balance, note: '' })
    }
  }

  if (!low.length) {
    const warnedAt = await readLowWarnAt()
    if (warnedAt) await dbRun('DELETE FROM system_config WHERE key = ?', [LOW_WARN_KEY]).catch(() => {})
    return { checked: pools.length, low, warned: false }
  }

  const warnedAt = Date.parse(await readLowWarnAt())
  if (Number.isFinite(warnedAt) && Date.now() - warnedAt < LOW_WARN_COOLDOWN_MS) {
    return { checked: pools.length, low, warned: false, skipped: '冷却期内' }
  }

  let warned = false
  try {
    if (await smtpConfigured()) {
      const to = await notifyAddress()
      if (!to) {
        console.error('[DouyinPool] 未找到可用的通知邮箱（smtp from/user 均非邮箱格式），跳过余量预警')
      } else {
        const lines = low
          .map((item) => (item.balance === null ? `· ${item.name}：查询失败（${item.note}）` : `· ${item.name}：剩余 ${item.balance} 个 IP`))
          .join('\n')
        const stats = getPoolExtractStats()
        const burn = stats.today > 0 ? `\n\n今日已提取 ${stats.today} 个 IP（累计 ${stats.total} 个）。` : ''
        const subject = `⚠️ 抖音解析池余量不足（阈值 ${threshold}）`
        const body = `动态住宅池余量已低于阈值 ${threshold}：\n\n${lines}${burn}\n\n建议：到管理后台「抖音解析出口」页新增一个池订单（粘贴提取链接 + 业务 key），系统会在当前池耗尽时自动切换。\n\n—— lcyksp.xyz 自动检查`
        await sendSiteMonitorEmail(to, subject, body)
        warned = true
      }
    }
  } catch (err) {
    console.error('[DouyinPool] 余量预警邮件发送失败:', err.message)
  }

  if (warned) {
    await dbRun('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', [LOW_WARN_KEY, new Date().toISOString()]).catch(() => {})
  }
  return { checked: pools.length, low, warned }
}

export default {
  getPoolProxy,
  invalidatePoolProxy,
  resetPoolConfigCache,
  poolEnabled,
  poolSource,
}

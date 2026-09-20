// 战争雷霆（Gaijin 交易所）物品价格监控核心模块。
//
// 三步链路（已用真实账号实测跑通，2026-09-18）：
//   ① POST login.gaijin.net/en/sso/login/procedure/   邮箱+密码 → set identity_sid session cookie（302）
//   ② POST login.gaijin.net/api/gsea/fetch            带 cookie → 响应 window.postMessage 里含 jwt（RS256，约 55 分钟有效）
//   ③ POST market-proxy.gaijin.net/web                action=cln_market_search + token=jwt + appid_filter=1067
//                                                     → response.assets[]，含 price(卖价)/buy_price(买价)/depth/buy_depth
//
// 凭据：邮箱+密码 AES 加密存 system_config（仿 utils/zeppLife.js + step_accounts 先例），
//   服务端每天快照前登录换新 JWT，一劳永逸，无需人工贴 token。JWT 只在内存缓存不落库。
//
// 价格单位：Gaijin 返回的是放大整数（raw 均为 ×1e6，如 MiG-25PD price=3989000000）。
//   2026-09-19 真机核对：÷10^8 = GJN（MiG-25PD → 39.89 币，站长确认）。存原始整数，换算放前端。
//
// appid 1067 = War Thunder（另有 1129 = Enlisted，本功能只做 WT）。
//
// 出口策略（2026-09-19 站长拍板「住宅代理路由登录」）：Gaijin 对服务器机房 IP 的**登录接口**
//   强制 reCAPTCHA（302 → /en/?error=recap），脚本解不了；实测换 JWT 的 gsea/fetch 那步不卡机房 IP。
//   所以登录 + gsea/fetch 两步走同一个池 IP（会话绑 IP，复用抖音池 getPoolProxy，仿 zeppLife.js），
//   拉目录用 JWT（签名令牌、不绑 IP）仍直连省带宽。无池时回落直连（本地住宅环境可用）。
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import { getDb } from '../config/db.js'
import { encrypt, decrypt } from './crypto.js'
import { getPoolProxy } from './douyinPool.js'

const APPID_WT = 1067
const LOGIN_PROCEDURE_URL = 'https://login.gaijin.net/en/sso/login/procedure/'
const GSEA_FETCH_URL = 'https://login.gaijin.net/api/gsea/fetch'
const TRADE_SERVER_URL = 'https://market-proxy.gaijin.net/web'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

const REQUEST_TIMEOUT_MS = 20000
const PAGE_SIZE = 100 // Gaijin 侧硬上限，count 超过 100 直接报 COUNT_TOO_LARGE
const MAX_PAGES = 80 // 兜底防死循环（实测 sell 侧约 28 页）
const JWT_TTL_MS = 45 * 60 * 1000 // JWT 实测约 55 分钟有效，留 10 分钟安全边际

// system_config 键
const KEY_LOGIN = 'wt_market_login'
const KEY_PASSWORD = 'wt_market_password'
const KEY_LAST_SNAPSHOT = 'wt_market_last_snapshot_at'
const KEY_LAST_ERROR = 'wt_market_last_error'
const KEY_ITEM_COUNT = 'wt_market_item_count'

/** 带错误码的业务异常，交给路由层映射 HTTP 状态。 */
export class WtMarketError extends Error {
  constructor(message, code = 'UPSTREAM') {
    super(message)
    this.name = 'WtMarketError'
    this.code = code
  }
}

// ---------- 节流 & 退避（降低被 Gaijin 风控/限流的概率） ----------

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 通用指数退避重试。仅对 isRetryable 判定可重试的错误退避，其余立即抛。
 * @param {() => Promise<any>} fn
 * @param {{ retries?: number, baseDelayMs?: number, isRetryable?: (err: Error) => boolean }} opts
 */
export async function withRetry(fn, { retries = 2, baseDelayMs = 800, isRetryable = () => true } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt === retries || !isRetryable(err)) throw err
      // 指数退避 + 抖动，避免匀速重试同样像机器
      await sleep(baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 300))
    }
  }
  throw lastErr
}

// 分页抓取时可重试的软错误（令牌失效/凭据错走各自逻辑，不在此列）
const RETRYABLE_CODES = new Set(['RATE_LIMITED', 'NETWORK', 'UPSTREAM'])

// ---------- 出口代理（登录链路走住宅池 IP，绕过机房 IP 的 reCAPTCHA） ----------

const poolAgents = new Map()

function poolAgent(proxyUrl) {
  let agent = poolAgents.get(proxyUrl)
  if (!agent) {
    agent = new ProxyAgent(proxyUrl)
    poolAgents.set(proxyUrl, agent)
    if (poolAgents.size > 8) poolAgents.delete(poolAgents.keys().next().value)
  }
  return agent
}

/**
 * 取一个池代理 URL 用于本次登录链路；无池（未配置/耗尽）返回 ''，由上层决定回落直连。
 * 登录 + gsea/fetch 必须复用同一个 IP，所以只在登录起点取一次、透传给两步。
 */
async function acquireLoginProxy() {
  try {
    const url = await getPoolProxy()
    return url || ''
  } catch (err) {
    console.warn(`[WT Market] 无可用池 IP（${err.message}），登录回落直连（机房 IP 大概率被 reCAPTCHA 拦）`)
    return ''
  }
}

/** fetch 包装：proxyUrl 非空则经 ProxyAgent 出站，否则直连。 */
function doFetch(url, options, proxyUrl) {
  if (proxyUrl) return undiciFetch(url, { ...options, dispatcher: poolAgent(proxyUrl) })
  return fetch(url, options)
}

/** 出口代理 IP 脱敏（只留前两段，用于日志区分是不是某个坏 IP）。 */
function maskProxy(url) {
  const m = String(url || '').match(/(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}/)
  return m ? `${m[1]}.${m[2]}.x.x` : 'pool'
}

// ---------- 操作日志（登录/快照/搜索/刷新，自动或手动，均记结果，用于事后定位） ----------

/**
 * 写一条操作日志。绝不含密码/完整 JWT（detail 只写脱敏摘要），失败也不影响主流程。
 * @param {string} op login|snapshot|search|refresh|credentials
 * @param {{ trigger?: string, status?: string, code?: string, detail?: string, exitIp?: string, durationMs?: number }} meta
 */
export async function logOp(op, { trigger = 'auto', status = 'ok', code = '', detail = '', exitIp = '', durationMs = 0 } = {}) {
  try {
    await dbRun(
      'INSERT INTO wt_market_logs (op, trigger, status, code, detail, exit_ip, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [String(op), String(trigger), String(status), String(code || ''), String(detail || '').slice(0, 500), String(exitIp || ''), Math.max(0, Math.round(durationMs) || 0)],
    )
  } catch {
    /* 日志写入失败绝不影响主流程（例如测试环境 DB 未初始化） */
  }
}

/** 读最近 N 条操作日志（管理员诊断用）。 */
export async function getRecentLogs(limit = 50) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200)
  try {
    return await dbAll(
      'SELECT id, op, trigger, status, code, detail, exit_ip, duration_ms, created_at FROM wt_market_logs ORDER BY id DESC LIMIT ?',
      [n],
    )
  } catch {
    return []
  }
}

// ---------- system_config 读写（AES 加密凭据） ----------

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => getDb().get(sql, params, (err, row) => (err ? reject(err) : resolve(row))))
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => getDb().run(sql, params, (err) => (err ? reject(err) : resolve())))
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => getDb().all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))))
}

async function getConfig(key) {
  const row = await dbGet('SELECT value FROM system_config WHERE key = ?', [key])
  return row ? row.value : ''
}

async function setConfig(key, value) {
  await dbRun('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', [key, value])
}

/** 读已存凭据（解密）。未配置返回 null。 */
export async function getStoredCredentials() {
  const login = await getConfig(KEY_LOGIN)
  const passwordEnc = await getConfig(KEY_PASSWORD)
  if (!login || !passwordEnc) return null
  const password = decrypt(passwordEnc)
  if (!password) return null
  return { login, password }
}

/** 保存凭据：邮箱明文、密码 AES 加密。 */
export async function saveCredentials(login, password) {
  await setConfig(KEY_LOGIN, String(login).trim())
  await setConfig(KEY_PASSWORD, encrypt(String(password)))
}

/** 抓取状态（供后台/前端展示）。 */
export async function getSnapshotStatus() {
  const creds = await getStoredCredentials()
  return {
    credentialsConfigured: Boolean(creds),
    loginMasked: creds ? maskEmail(creds.login) : '',
    lastSnapshotAt: await getConfig(KEY_LAST_SNAPSHOT),
    lastError: await getConfig(KEY_LAST_ERROR),
    itemCount: Number(await getConfig(KEY_ITEM_COUNT)) || 0,
  }
}

/** 邮箱脱敏：保留前 2 位与域名。 */
export function maskEmail(email) {
  const s = String(email || '')
  if (!s.includes('@')) return s ? `${s.slice(0, 2)}***` : ''
  const [name, domain] = s.split('@')
  return `${name.slice(0, 2)}${'*'.repeat(Math.max(1, Math.min(6, name.length - 2)))}@${domain}`
}

// ---------- 登录换 JWT（内存缓存 + 到期重登） ----------

let cachedJwt = ''
let cachedJwtExpireAt = 0

/** 从 Set-Cookie 头收集 cookie 键值，拼成 Cookie 请求头。 */
function collectCookies(setCookieHeaders) {
  const jar = {}
  for (const line of setCookieHeaders) {
    const first = String(line).split(';')[0]
    const eq = first.indexOf('=')
    if (eq > 0) jar[first.slice(0, eq).trim()] = first.slice(eq + 1).trim()
  }
  return jar
}

function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ')
}

/**
 * 完整登录换 JWT。缓存未过期直接复用；过期或强制刷新才重新登录。
 * @param {boolean} force 忽略缓存强制重登
 */
export async function loginAndGetJwt(force = false, trigger = 'auto') {
  if (!force && cachedJwt && Date.now() < cachedJwtExpireAt) return cachedJwt

  const startedAt = Date.now()
  let exitIp = ''
  try {
    const creds = await getStoredCredentials()
    if (!creds) throw new WtMarketError('尚未配置 Gaijin 账号凭据', 'NO_CREDENTIALS')

    // 登录 + gsea/fetch 必须走同一个出口 IP（会话绑 IP），只在起点取一次池代理透传两步。
    // 无池 → '' → 回落直连（本地住宅 IP 可用；生产机房 IP 大概率被 reCAPTCHA 拦）。
    const proxyUrl = await acquireLoginProxy()
    exitIp = proxyUrl ? maskProxy(proxyUrl) : 'direct'

    // ① 登录拿 session cookie
    const loginBody = new URLSearchParams({
      login: creds.login,
      password: creds.password,
      action: '',
      referer: '',
      fingerprint: '',
      app_id: '',
    }).toString()

    let loginRes
    try {
      loginRes = await doFetch(LOGIN_PROCEDURE_URL, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: 'https://login.gaijin.net/en/sso/login/',
          Origin: 'https://login.gaijin.net',
        },
        body: loginBody,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, proxyUrl)
    } catch (err) {
      throw new WtMarketError(`登录 Gaijin 失败：${err.message}`, 'NETWORK')
    }

    // Gaijin 对被 reCAPTCHA 拦的出口 IP 会 302 → /en/?error=recap，只发匿名 identity_sid，
    // 后面 gsea/fetch 必然拿不到 JWT（no_session）。此处提前识别，给出可操作的清晰报错。
    const location = loginRes.headers.get('location') || ''
    if (/[?&]error=recap/i.test(location)) {
      throw new WtMarketError(
        '当前出口 IP 被 Gaijin 强制人机验证（reCAPTCHA）。请确认住宅代理池可用后重试；机房 IP 直连必被拦。',
        'RECAPTCHA',
      )
    }

    // getSetCookie() 是 undici/Node18+ 的标准 API；老环境退回 raw 头
    const setCookies = typeof loginRes.headers.getSetCookie === 'function'
      ? loginRes.headers.getSetCookie()
      : [loginRes.headers.get('set-cookie')].filter(Boolean)
    const jar = collectCookies(setCookies)

    // 成功是 302 跳转；仍是 200 说明落在登录页（凭据错/需验证）
    if (loginRes.status === 200) {
      const html = await loginRes.text().catch(() => '')
      if (/invalid-credentials|Invalid username or password/i.test(html)) {
        throw new WtMarketError('Gaijin 账号或密码错误', 'AUTH_FAILED')
      }
      throw new WtMarketError('Gaijin 登录被拒（可能需要人机验证或邮箱确认）', 'AUTH_FAILED')
    }
    if (!jar.identity_sid) {
      throw new WtMarketError(`登录未返回会话（HTTP ${loginRes.status}）`, 'AUTH_FAILED')
    }

    // ② 用 session 换 JWT（同一出口 IP）
    let jwtRes
    try {
      jwtRes = await doFetch(GSEA_FETCH_URL, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/json',
          Cookie: cookieHeader(jar),
        },
        body: JSON.stringify({ j: null }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, proxyUrl)
    } catch (err) {
      throw new WtMarketError(`获取 Gaijin 令牌失败：${err.message}`, 'NETWORK')
    }

    const jwtText = await jwtRes.text()
    const jwt = extractJwtFromGsea(jwtText)
    if (!jwt) throw new WtMarketError('未能从会话换取访问令牌', 'AUTH_FAILED')

    cachedJwt = jwt
    cachedJwtExpireAt = Date.now() + JWT_TTL_MS
    // 只记 JWT 长度，绝不记内容
    await logOp('login', { trigger, status: 'ok', detail: `JWT 换取成功（len ${jwt.length}）`, exitIp, durationMs: Date.now() - startedAt })
    return jwt
  } catch (err) {
    const code = err instanceof WtMarketError ? err.code : 'NETWORK'
    await logOp('login', { trigger, status: 'fail', code, detail: err.message, exitIp, durationMs: Date.now() - startedAt })
    throw err
  }
}

/** gsea/fetch 响应形如 window.postMessage({...},"*")，从中取 payload.jwt。 */
export function extractJwtFromGsea(text) {
  const m = String(text).match(/postMessage\((\{[\s\S]*\}),\s*["']\*["']\)/)
  if (!m) return ''
  try {
    const payload = JSON.parse(m[1]).payload || {}
    return payload.jwt || payload.token || ''
  } catch {
    return ''
  }
}

// ---------- 搜索抓取 ----------

/**
 * 拉一页搜索结果。side='sell' 取有卖单的物品，'buy' 取有买单的物品。
 * @returns {{ assets: object[] }}
 */
export async function marketSearch({ jwt, skip = 0, count = PAGE_SIZE, side = 'sell' }) {
  const options = side === 'buy' ? 'any_buy_orders;include_marketpairs' : 'any_sell_orders;include_marketpairs'
  const body = new URLSearchParams({
    action: 'cln_market_search',
    token: jwt,
    appid_filter: String(APPID_WT),
    text: '',
    language: 'en',
    skip: String(skip),
    count: String(Math.min(count, PAGE_SIZE)),
    options,
  }).toString()

  let res
  try {
    res = await fetch(TRADE_SERVER_URL, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    throw new WtMarketError(`搜索请求失败：${err.message}`, 'NETWORK')
  }

  if (res.status === 429) throw new WtMarketError('搜索被限流（HTTP 429）', 'RATE_LIMITED')

  let json
  try {
    json = JSON.parse(await res.text())
  } catch {
    throw new WtMarketError(`搜索响应非 JSON（HTTP ${res.status}）`, 'UPSTREAM')
  }

  const resp = json.response || json.result || {}
  if (!resp.success) {
    const err = resp.error || 'UNKNOWN'
    // 令牌过期/无效 → 让上层强制重登重试
    if (err === 'TOKEN_REQUIRED' || err === 'TOKEN_EXPIRED' || err === 'BAD_TOKEN') {
      throw new WtMarketError(`令牌失效（${err}）`, 'TOKEN_INVALID')
    }
    throw new WtMarketError(`搜索被拒：${err}`, 'UPSTREAM')
  }
  return { assets: Array.isArray(resp.assets) ? resp.assets : [] }
}

/**
 * 解析单条 asset 为入库结构。字段结构已实测确认（2026-09-18）：
 *   hash_name(唯一标识) / name(显示名) / icon / price(卖价) / buy_price(买价) /
 *   depth(卖单量) / buy_depth(买单量) / tags[] / color(品质色)
 */
export function parseSearchRow(asset) {
  if (!asset || !asset.hash_name) return null
  return {
    marketName: String(asset.hash_name),
    displayName: String(asset.name || asset.hash_name),
    iconUrl: String(asset.icon || ''),
    sellPrice: Number(asset.price) || 0,
    buyPrice: Number(asset.buy_price) || 0,
    sellCount: Number(asset.depth) || 0,
    buyCount: Number(asset.buy_depth) || 0,
    tags: Array.isArray(asset.tags) ? asset.tags : [],
    color: String(asset.color || ''),
  }
}

// ---------- 每日快照 ----------

/** 北京自然日（服务器时区不一定是 CST，显式偏移最稳）。 */
export function beijingDate(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/**
 * 拉全目录（分页翻到空为止），合并 sell + buy 两侧（有的物品只有买单没卖单）。
 * @returns {Map<string, object>} key = marketName
 */
async function fetchFullCatalog(jwt) {
  const merged = new Map()
  for (const side of ['sell', 'buy']) {
    let skip = 0
    for (let page = 0; page < MAX_PAGES; page += 1) {
      // 软错误（限流/网络/上游）退避重试；令牌失效交上层强制重登，不在此重试
      const { assets } = await withRetry(
        () => marketSearch({ jwt, skip, count: PAGE_SIZE, side }),
        { retries: 2, isRetryable: (e) => e instanceof WtMarketError && RETRYABLE_CODES.has(e.code) },
      )
      for (const asset of assets) {
        const row = parseSearchRow(asset)
        if (!row) continue
        // 两侧都命中同一物品时，取各自有值的价格（sell 侧 buy_price 也带，但以先到为准，后到补 0 值）
        const prev = merged.get(row.marketName)
        if (!prev) {
          merged.set(row.marketName, row)
        } else {
          if (!prev.sellPrice && row.sellPrice) { prev.sellPrice = row.sellPrice; prev.sellCount = row.sellCount }
          if (!prev.buyPrice && row.buyPrice) { prev.buyPrice = row.buyPrice; prev.buyCount = row.buyCount }
        }
      }
      if (assets.length < PAGE_SIZE) break
      skip += PAGE_SIZE
      // 翻页抖动：不匀速连打，最像人手翻页；一天一次、后台 cron 跑，多花 1~2 分钟无所谓
      await sleep(400 + Math.floor(Math.random() * 800))
    }
  }
  return merged
}

/**
 * 每日快照主流程。未配置凭据 → 静默跳过并记 last_error（不抛错，cron 友好）。
 * 有凭据 → 登录 → 拉全目录 → upsert 物品 → INSERT OR IGNORE 当天快照（幂等，重复跑无脏数据）。
 * @returns {{ skipped?: boolean, itemCount?: number, date?: string }}
 */
export async function runDailySnapshot(trigger = 'auto') {
  const startedAt = Date.now()
  const creds = await getStoredCredentials()
  if (!creds) {
    await setConfig(KEY_LAST_ERROR, '未配置 Gaijin 账号凭据，快照跳过')
    await logOp('snapshot', { trigger, status: 'skip', detail: '未配置凭据，跳过' })
    return { skipped: true }
  }

  try {
    let jwt = await loginAndGetJwt(false, trigger)
    let catalog
    try {
      catalog = await fetchFullCatalog(jwt)
    } catch (err) {
      // 令牌中途失效：强制重登一次再拉
      if (err instanceof WtMarketError && err.code === 'TOKEN_INVALID') {
        jwt = await loginAndGetJwt(true, trigger)
        catalog = await fetchFullCatalog(jwt)
      } else {
        throw err
      }
    }

    const date = beijingDate()
    const now = new Date().toISOString()
    let count = 0
    for (const row of catalog.values()) {
      // upsert 物品主表
      await dbRun(
        `INSERT INTO wt_market_items (appid, market_name, display_name, icon_url, tags, color, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(appid, market_name) DO UPDATE SET
           display_name = excluded.display_name,
           icon_url = excluded.icon_url,
           tags = excluded.tags,
           color = excluded.color,
           last_seen_at = excluded.last_seen_at`,
        [APPID_WT, row.marketName, row.displayName, row.iconUrl, JSON.stringify(row.tags), row.color, now, now],
      )
      const item = await dbGet('SELECT id FROM wt_market_items WHERE appid = ? AND market_name = ?', [APPID_WT, row.marketName])
      if (!item) continue
      // 当天快照幂等插入
      await dbRun(
        `INSERT OR IGNORE INTO wt_price_snapshots
           (item_id, snapshot_date, buy_price, sell_price, buy_count, sell_count, currency, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, 'gjn', ?)`,
        [item.id, date, row.buyPrice, row.sellPrice, row.buyCount, row.sellCount, now],
      )
      count += 1
    }

    await setConfig(KEY_LAST_SNAPSHOT, now)
    await setConfig(KEY_ITEM_COUNT, String(count))
    await setConfig(KEY_LAST_ERROR, '')
    console.log(`[WT Market] 每日快照完成：${count} 个物品（${date}）`)
    await logOp('snapshot', { trigger, status: 'ok', detail: `入库 ${count} 件（${date}）`, durationMs: Date.now() - startedAt })
    return { itemCount: count, date }
  } catch (err) {
    const msg = err instanceof WtMarketError ? `${err.code}: ${err.message}` : err.message
    await setConfig(KEY_LAST_ERROR, String(msg).slice(0, 300))
    console.error('[WT Market] 每日快照失败:', msg)
    await logOp('snapshot', { trigger, status: 'fail', code: err instanceof WtMarketError ? err.code : '', detail: err.message, durationMs: Date.now() - startedAt })
    throw err
  }
}

/** 从快照序列算日/周涨跌幅（仿 githubRadar 的增量计算）。series 按日期升序。 */
export function computePriceChange(series) {
  if (!series || series.length === 0) return { latest: null, dayChange: null, weekChange: null }
  const latest = series[series.length - 1]
  const pct = (from, to) => (from > 0 ? Math.round(((to - from) / from) * 10000) / 100 : null)
  const dayAgo = series.length >= 2 ? series[series.length - 2] : null
  const weekAgo = series.length >= 8 ? series[series.length - 8] : series[0]
  // 挂单数的日环比变化（绝对量）：真实成交量拿不到，这是「昨→今 挂单增减」的近似，
  // 混杂了成交与撤单/新挂，只作粗略换手参考，展示层如实标注「约」。
  const countDelta = (from, to) => (Number.isFinite(from) && Number.isFinite(to) ? to - from : null)
  return {
    latest,
    dayChange: dayAgo ? pct(dayAgo.sell_price, latest.sell_price) : null,
    weekChange: weekAgo && weekAgo !== latest ? pct(weekAgo.sell_price, latest.sell_price) : null,
    sellCountChange: dayAgo ? countDelta(dayAgo.sell_count, latest.sell_count) : null,
    buyCountChange: dayAgo ? countDelta(dayAgo.buy_count, latest.buy_count) : null,
  }
}

/**
 * 「涨跌榜」：从多物品的多日快照里，挑过去 windowDays 天卖价涨幅最高 / 买价降幅最高的各 topN 件。
 * @param {Array<{ id, displayName, iconUrl, color, marketName, series: Array<{ snapshot_date, buy_price, sell_price }> }>} items
 *        每个 item 的 series 需按 snapshot_date 升序。
 * @param {{ windowDays?: number, topN?: number }} opts
 * @returns {{ windowDays: number, topSellGainers: object[], topBuyDropers: object[] }}
 */
export function computeMovers(items, { windowDays = 3, topN = 5 } = {}) {
  const gainers = []
  const dropers = []
  const pct = (from, to) => Math.round(((to - from) / from) * 10000) / 100
  for (const it of items || []) {
    const series = it.series || []
    if (series.length < 2) continue
    const latest = series[series.length - 1]
    // 取「不晚于 latest 日期减 windowDays 天」的最近一条作为基准
    const cutoff = new Date(new Date(`${latest.snapshot_date}T00:00:00Z`).getTime() - windowDays * 86400000)
      .toISOString().slice(0, 10)
    let base = null
    for (const s of series) {
      if (s.snapshot_date <= cutoff) base = s
      else break
    }
    if (!base || base === latest) continue // 历史不足 windowDays 天，跳过
    const meta = { id: it.id, displayName: it.displayName, iconUrl: it.iconUrl, color: it.color, marketName: it.marketName }
    if (base.sell_price > 0 && latest.sell_price > 0) {
      const g = pct(base.sell_price, latest.sell_price)
      if (g > 0) gainers.push({ ...meta, sellPrice: latest.sell_price, basePrice: base.sell_price, changePct: g })
    }
    if (base.buy_price > 0 && latest.buy_price > 0) {
      const d = pct(base.buy_price, latest.buy_price)
      if (d < 0) dropers.push({ ...meta, buyPrice: latest.buy_price, basePrice: base.buy_price, changePct: d })
    }
  }
  gainers.sort((a, b) => b.changePct - a.changePct) // 涨幅大在前
  dropers.sort((a, b) => a.changePct - b.changePct) // 跌幅深（最负）在前
  return { windowDays, topSellGainers: gainers.slice(0, topN), topBuyDropers: dropers.slice(0, topN) }
}

export default {
  APPID_WT,
  WtMarketError,
  sleep,
  withRetry,
  getStoredCredentials,
  saveCredentials,
  getSnapshotStatus,
  maskEmail,
  loginAndGetJwt,
  logOp,
  getRecentLogs,
  extractJwtFromGsea,
  marketSearch,
  parseSearchRow,
  beijingDate,
  runDailySnapshot,
  computePriceChange,
  computeMovers,
}

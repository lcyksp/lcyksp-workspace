// Zepp Life（华米 / 原小米运动）步数修改核心模块。
//
// 四步链路（与官方 App 登录、同步走的是同一套接口）：
//   ① POST api-user.zepp.com/v2/registrations/tokens   参数 AES-128-CBC 加密后直发二进制
//      → 303 重定向，从 Location 里取 access（失败时 Location 带 error=401）
//   ② POST account.huami.com/v2/client/login           access → login_token + user_id
//   ③ GET  account-cn.huami.com/v1/client/app_tokens   login_token → app_token
//   ④ POST api-mifit-cn.huami.com/v1/data/band_data.json  带 apptoken 提交当日运动数据
//
// 出口策略（2026-09-15 站长拍板：直连优先，被拒再换池）：
//   Zepp 的接口在国内有自建节点——服务器实测 42.194.154.35（腾讯云）、40ms，
//   所以日常一律直连，零代理消耗。只有直连被 403/429 拒绝（风控）或连接级
//   错误时，才从巨量池取一个 IP 经 ProxyAgent 重试一次，用完即弃。
//   参考项目之所以要挂代理，是因为它跑在 Cloudflare Workers 上（域名在国内被墙），
//   与 Zepp 接口本身无关。
import crypto from 'crypto'
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import { getPoolProxy } from './douyinPool.js'
import {
  DATA_HR_B64,
  MINUTE_VALUE_B64,
  MINUTES_PER_DAY,
  BAND_SOURCE,
  BAND_TYPE,
  DEVICE_ID,
  LAST_SYNC_DATA_TIME,
  SUMMARY_TEMPLATE,
  RATIOS,
  STEP_MAX,
} from './zeppBandTemplate.js'

export { STEP_MAX }

const AES_KEY = 'xeNtBVqzDc6tuNTh'
const AES_IV = 'MAAAYAAAAAAAAABg'

const LOGIN_URL = 'https://api-user.zepp.com/v2/registrations/tokens'
const CLIENT_LOGIN_URL = 'https://account.huami.com/v2/client/login'
const APP_TOKEN_URL = 'https://account-cn.huami.com/v1/client/app_tokens'
const BAND_DATA_URL = 'https://api-mifit-cn.huami.com/v1/data/band_data.json'

const APP_NAME = 'com.xiaomi.hm.health'
const APP_VERSION = '6.14.0'
const UA_LOGIN = 'MiFit6.14.0 (M2007J1SC; Android 12; Density/2.75)'
const UA_APP_TOKEN = 'MiFit/5.3.0 (iPhone; iOS 14.7.1; Scale/3.00)'
const REDIRECT_URI = 'https://s3-us-west-2.amazonaws.com/hm-registration/successsignin.html'

// 视为「被风控」的状态码：直连拿到这些码就换池 IP 重试一次。
// 其余 4xx 都是请求本身的问题（参数/凭据），换 IP 无意义，直接抛给上层。
const RISK_STATUS = new Set([403, 429])

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
])

const REQUEST_TIMEOUT_MS = 20000

/** 带错误码的业务异常，交给路由层映射 HTTP 状态。 */
export class ZeppError extends Error {
  constructor(message, code = 'UPSTREAM', detail = '') {
    super(message)
    this.name = 'ZeppError'
    this.code = code
    this.detail = detail
  }
}

function isConnectionError(err) {
  const code = err?.cause?.code || err?.code || ''
  return CONNECTION_ERROR_CODES.has(code)
}

// ---------- 出口：直连优先，被拒再换池 ----------

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
 * 一次 Zepp 请求，返回 { res, via }。via 为 'direct' 或 'pool'，便于日志归因。
 * 只在「被风控」或「连不上」时才动用池额度；HTTP 4xx（非风控）原样返回给调用方。
 */
async function zeppFetch(url, options = {}, { tag = 'zepp', allowProxy = true } = {}) {
  let directRes = null
  let directErr = null

  try {
    directRes = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!RISK_STATUS.has(directRes.status)) return { res: directRes, via: 'direct' }
    console.warn(`[Zepp][${tag}] 直连被拒 HTTP ${directRes.status}，尝试换池 IP 重试`)
  } catch (err) {
    if (!isConnectionError(err)) throw err
    directErr = err
    console.warn(`[Zepp][${tag}] 直连连接失败：${err.message}`)
  }

  if (!allowProxy) {
    if (directRes) return { res: directRes, via: 'direct' }
    throw directErr
  }

  let proxyUrl = null
  try {
    proxyUrl = await getPoolProxy()
  } catch (err) {
    console.warn(`[Zepp][${tag}] 无可用池 IP（${err.message}），沿用直连结果`)
  }

  if (proxyUrl) {
    try {
      const res = await undiciFetch(url, {
        ...options,
        dispatcher: poolAgent(proxyUrl),
        signal: options.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      console.log(`[Zepp][${tag}] 已切换池 IP 出口，HTTP ${res.status}`)
      return { res, via: 'pool' }
    } catch (err) {
      if (!isConnectionError(err)) throw err
      console.warn(`[Zepp][${tag}] 池出口不可达：${err.message}`)
    }
  }

  if (directRes) return { res: directRes, via: 'direct' }
  throw directErr || new ZeppError('无法连接 Zepp 服务', 'NETWORK')
}

// ---------- ① 加密登录，取 access ----------

/** 登录参数拼成 query string 后做 AES-128-CBC 加密，POST 的是加密后的二进制。 */
export function encryptLoginPayload(account, password) {
  const plain = new URLSearchParams({
    emailOrPhone: account,
    password,
    state: 'REDIRECTION',
    client_id: 'HuaMi',
    country_code: 'CN',
    token: 'access',
    redirect_uri: REDIRECT_URI,
  }).toString()

  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(AES_KEY, 'utf8'), Buffer.from(AES_IV, 'utf8'))
  return Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()])
}

const LOGIN_HEADERS = {
  'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'user-agent': UA_LOGIN,
  app_name: APP_NAME,
  appname: APP_NAME,
  appplatform: 'android_phone',
  'x-hm-ekv': '1',
  'hm-privacy-ceip': 'false',
}

async function fetchAccessToken(account, password, log) {
  const { res } = await zeppFetch(
    LOGIN_URL,
    { method: 'POST', headers: LOGIN_HEADERS, body: encryptLoginPayload(account, password), redirect: 'manual' },
    { tag: 'login' },
  )

  const location = res.headers.get('location') || ''
  if (!location) {
    throw new ZeppError(
      res.status === 429 ? '账号登录过于频繁，请稍后再试' : `登录接口返回异常（HTTP ${res.status}）`,
      res.status === 429 ? 'RISK' : 'UPSTREAM',
    )
  }

  let access = ''
  let errorCode = ''
  try {
    const u = new URL(location)
    access = u.searchParams.get('access') || ''
    errorCode = u.searchParams.get('error') || ''
  } catch {
    throw new ZeppError('登录接口返回了无法解析的重定向地址', 'UPSTREAM', location.slice(0, 200))
  }

  if (!access) {
    if (errorCode === '401') throw new ZeppError('Zepp Life 账号或密码错误', 'AUTH_FAILED')
    throw new ZeppError(`登录被拒绝（error=${errorCode || 'unknown'}）`, 'AUTH_FAILED')
  }

  log.push('登录成功，已获取 access token')
  return access
}

// ---------- ② access → login_token + user_id ----------

function buildClientLoginParams(accessToken, account, deviceId) {
  const isEmail = account.includes('@')
  if (isEmail) {
    // 邮箱账号分支：服务端要求带 dn 白名单字段
    return {
      allow_registration: 'false',
      app_name: APP_NAME,
      app_version: APP_VERSION,
      code: accessToken,
      country_code: 'CN',
      device_id: deviceId,
      device_model: 'android_phone',
      dn: 'account.zepp.com,api-user.zepp.com,api-mifit.zepp.com,api-watch.zepp.com,app-analytics.zepp.com,api-analytics.huami.com,auth.zepp.com',
      grant_type: 'access_token',
      lang: 'zh_CN',
      os_version: '1.5.0',
      source: `${APP_NAME}:${APP_VERSION}:50818`,
      third_name: 'email',
    }
  }
  // 手机号账号分支
  return {
    app_name: APP_NAME,
    app_version: APP_VERSION,
    code: accessToken,
    country_code: 'CN',
    device_id: deviceId,
    device_model: 'phone',
    grant_type: 'access_token',
    third_name: 'huami_phone',
  }
}

async function fetchLoginToken(accessToken, account, deviceId, log) {
  const params = buildClientLoginParams(accessToken, account, deviceId)
  const { res } = await zeppFetch(
    CLIENT_LOGIN_URL,
    {
      method: 'POST',
      headers: {
        app_name: APP_NAME,
        'x-request-id': crypto.randomUUID(),
        'accept-language': 'zh-CN',
        appname: APP_NAME,
        cv: '50818_6.14.0',
        v: '2.0',
        appplatform: 'android_phone',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: new URLSearchParams(params).toString(),
    },
    { tag: 'client-login' },
  )

  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON，按失败处理 */
  }

  const loginToken = json?.token_info?.login_token
  const userId = json?.token_info?.user_id
  if (!loginToken || !userId) {
    const msg = json?.message || json?.error_description || text.slice(0, 120)
    throw new ZeppError(`换取登录凭据失败：${msg || `HTTP ${res.status}`}`, 'UPSTREAM')
  }

  log.push(`已获取 login_token（user_id=${userId}）`)
  return { loginToken, userId: String(userId) }
}

// ---------- ③ login_token → app_token ----------

async function fetchAppToken(loginToken, log) {
  const query = new URLSearchParams({
    app_name: APP_NAME,
    dn: 'api-user.huami.com,api-mifit.huami.com,app-analytics.huami.com',
    login_token: loginToken,
  })
  const { res } = await zeppFetch(`${APP_TOKEN_URL}?${query.toString()}`, {
    method: 'GET',
    headers: { 'User-Agent': UA_APP_TOKEN },
  }, { tag: 'app-token' })

  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON */
  }

  const appToken = json?.token_info?.app_token
  if (!appToken) {
    throw new ZeppError(`获取 app_token 失败：${json?.message || text.slice(0, 120) || `HTTP ${res.status}`}`, 'UPSTREAM')
  }

  log.push('已获取 app_token')
  return appToken
}

// ---------- ④ 提交当日运动数据 ----------

/** 北京时间自然日（服务器时区不一定是 CST，显式偏移最稳）。 */
export function beijingDate(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/**
 * 组装 band_data.json 的提交体。
 *
 * 关于分钟级分布（data[0].value）：它是一份 1440 组 × 3 字节的基准分布，
 * 与目标步数并不严格对应——参考项目同样只替换日期和总步数，实测可被服务端接受，
 * 说明服务端对这份明细与 summary 的一致性校验很宽松。这里沿用同一策略，
 * 但把 summary 里的距离/卡路里/活动时长按目标步数等比换算，保证汇总字段内部自洽。
 */
export function buildBandData(steps, date) {
  const summary = JSON.parse(JSON.stringify(SUMMARY_TEMPLATE))
  summary.stp.ttl = steps
  summary.stp.dis = Math.round(steps * RATIOS.disPerStep)
  summary.stp.cal = Math.round(steps * RATIOS.calPerStep)
  summary.stp.wk = Math.round(steps * RATIOS.wkPerStep)
  summary.stp.runDist = Math.round(steps * RATIOS.runDistPerStep)
  summary.stp.runCal = Math.round(steps * RATIOS.runCalPerStep)

  return JSON.stringify([
    {
      data_hr: DATA_HR_B64,
      date,
      data: [{ start: 0, stop: MINUTES_PER_DAY - 1, value: MINUTE_VALUE_B64 }],
      summary: JSON.stringify(summary),
      source: BAND_SOURCE,
      type: BAND_TYPE,
    },
  ])
}

async function submitBandData({ appToken, userId, steps, date, log }) {
  const dataJson = encodeURIComponent(buildBandData(steps, date))
  const body = [
    `userid=${encodeURIComponent(userId)}`,
    `last_sync_data_time=${LAST_SYNC_DATA_TIME}`,
    'device_type=0',
    `last_deviceid=${DEVICE_ID}`,
    `data_json=${dataJson}`,
  ].join('&')

  const { res, via } = await zeppFetch(
    `${BAND_DATA_URL}?&t=${Date.now()}`,
    {
      method: 'POST',
      headers: { apptoken: appToken, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
    { tag: 'band-data' },
  )

  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 上游有时返回空体，以状态码为准 */
  }

  if (!res.ok) {
    throw new ZeppError(`提交被拒绝（HTTP ${res.status}）：${json?.message || text.slice(0, 120)}`, 'UPSTREAM')
  }

  // Zepp 用 message/code 表达业务结果；code 明确为错误码时才算失败，其余按成功处理。
  const code = json?.code
  const numericCode = typeof code === 'string' ? Number(code) : code
  if (Number.isFinite(numericCode) && numericCode >= 400) {
    throw new ZeppError(`提交失败：${json?.message || `code=${code}`}`, 'UPSTREAM')
  }

  log.push(`步数已提交（${steps}）${json?.message ? `［${json.message}］` : ''}${via === 'pool' ? '［走池出口］' : ''}`)
  return { message: json?.message || '', via }
}

// ---------- 对外主流程 ----------

/**
 * 完整走一遍四步链路，返回可用凭据。用于「绑定账号」时验证凭据是否真实可用。
 * @returns {{ userId: string, loginToken: string, appToken: string, log: string[] }}
 */
export async function authorize(account, password) {
  const log = []
  const deviceId = crypto.randomUUID()
  const access = await fetchAccessToken(account, password, log)
  const { loginToken, userId } = await fetchLoginToken(access, account, deviceId, log)
  const appToken = await fetchAppToken(loginToken, log)
  return { userId, loginToken, appToken, log, deviceId }
}

/**
 * 改步数：重新登录取凭据（app_token 有时效，避免用户绑一次就失效），再提交。
 * @param {{ account: string, password: string, steps: number, date?: string }} params
 */
export async function changeSteps({ account, password, steps, date }) {
  const target = Number(steps)
  if (!Number.isFinite(target) || target < 1 || target > STEP_MAX) {
    throw new ZeppError(`步数需在 1 ~ ${STEP_MAX} 之间`, 'BAD_INPUT')
  }

  const day = date || beijingDate()
  const log = []
  const deviceId = crypto.randomUUID()

  const access = await fetchAccessToken(account, password, log)
  const { loginToken, userId } = await fetchLoginToken(access, account, deviceId, log)
  const appToken = await fetchAppToken(loginToken, log)
  const result = await submitBandData({ appToken, userId, steps: Math.round(target), date: day, log })

  return { steps: Math.round(target), date: day, userId, via: result.via, upstreamMessage: result.message, log }
}

export default { authorize, changeSteps, encryptLoginPayload, buildBandData, beijingDate, ZeppError, STEP_MAX }

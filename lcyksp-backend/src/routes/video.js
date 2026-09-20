import express from 'express'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import { fileURLToPath } from 'url'
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import sharp, { MAX_REMOTE_IMAGE_BYTES } from '../utils/imageGuard.js'
import { generateABogus } from '../utils/douyin-a-bogus.js'
import { authMiddleware } from '../middleware/auth.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { heavyLimiter, previewLimiter } from '../middleware/rateLimit.js'
import { ACTION_ANALYZE, ACTION_DOWNLOAD, PLAN_FREE, buildQuotaExceededMessage, consumeQuota } from '../utils/quota.js'
import { getClientIp } from '../utils/turnstile.js'
import { logDownload } from '../utils/logger.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { recordGateProbe, getDouyinGateState, markDirectSuspect } from '../utils/douyinGateProbe.js'
import {
  poolEnabled,
  getPoolProxy,
  invalidatePoolProxy,
  getPoolSnapshot,
  addPool,
  updatePool,
  deletePool,
  setActivePool,
  upsertPrimaryPool,
  writeLowBalanceThreshold,
  checkPoolBalanceAndWarn,
} from '../utils/douyinPool.js'
import { claimDirectBudget, decideTaskExit, directBudgetState, resetDirectBudget, DIRECT_WINDOW_MS } from '../utils/douyinDirectBudget.js'
import { buildZipStore } from '../utils/zipStore.js'
import { getDb } from '../config/db.js'
import { assertPublicUrl } from '../utils/ssrf.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const router = express.Router()
router.use(authMiddleware)

// 单次解析任务内的「出口粘性」：一个任务的多个上游请求必须走同一个出口
// （ttwid 与出口 IP 是配对身份，混用容易被判异常），所以出口在每个请求上下文里只决定一次。
const douyinTaskCtx = new AsyncLocalStorage()
router.use((req, res, next) => { douyinTaskCtx.run({ exit: null }, next) })

const DATA_DIR = path.resolve(__dirname, '../../data')
const DEFAULT_COOKIES_PATH = path.join(DATA_DIR, 'cookies.txt')
const PLATFORM_COOKIE_FILES = {
  bilibili: path.join(DATA_DIR, 'cookies.bilibili.txt'),
  douyin: path.join(DATA_DIR, 'cookies.douyin.txt'),
  youtube: path.join(DATA_DIR, 'cookies.youtube.txt'),
}
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const VIDEO_CONTENT_TYPES = {
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
}
const AUDIO_CONTENT_TYPES = {
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.webm': 'audio/webm',
}
const IMAGE_CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}
const DOUYIN_DEBUG_DIR = path.join(DATA_DIR, 'debug')
const DOUYIN_ANALYZE_CACHE_TTL_MS = 10 * 60 * 1000
// 容量上限：防止只增不减的缓存导致内存缓慢增长
const DOUYIN_ANALYZE_CACHE_MAX_SIZE = 300
// 同 IP 退避重试的等待已内联在 fetchDouyinSignedDetailBody 的默认参数里（首轮 600/1500ms）：
// 旧版固定 [700,1600,3200]，每轮都要白睡 5.5 秒，而真正的解法是换出口 IP（见外层重试循环）。
// 图集打包下载的上限：抖音单篇图文最多约 35 张，60 张留足余量；总量上限防内存被打穿
const MAX_ALBUM_IMAGES = 60
const MAX_ALBUM_TOTAL_BYTES = 160 * 1024 * 1024
// detail 请求超时：正常约 1s，12s 足够；超时是为了不把时间浪费在黑洞池 IP 上
const DOUYIN_DETAIL_TIMEOUT_MS = 12000
// 图片请求超时：单张几百 KB，30s 足够；同样是防黑洞出口把整包拖死
const IMAGE_FETCH_TIMEOUT_MS = 30000
const DOUYIN_IMAGE_HOST_ALLOWLIST = ['byteimg.com', 'douyinpic.com', 'tos-cn', 'p3-pc-sign', 'p6-sign', 'p9-pc-sign']
const DOUYIN_IMAGE_URL_BLOCKLIST = [
  'douyinstatic.com',
  '/media/logo',
  'emblem.png',
  'verifycenter',
  'captcha',
  'nav_dark',
  'nav_light',
  'sprite',
  'icon',
  'aweme-avatar',
  '/aweme/100x100/',
  'sc=thumb',
  'sticker_comment',
  'aweme_comment',
  'comment_emoji',
  'blackbg',
  'loading',
  'a795fb49bcbcf8cb1c762a69d57aee48',
]
const douyinAnalyzeCache = new Map()
let douyinAnalyzeInFlight = null

async function enforceVideoQuota(req, action) {
  const plan = req.user?.role === 'admin' ? 'admin' : req.user?.role === 'pro' ? 'pro' : req.user?.role === 'premium' || req.user?.quotaPlan === 'premium' ? 'premium' : 'free'
  const subjectKey = req.user?.userId ? `user:${req.user.userId}` : `ip:${getClientIp(req)}`
  const result = await consumeQuota({
    subjectType: req.user?.userId ? plan : 'guest',
    subjectKey,
    action,
    amount: 1,
  })

  if (!result.allowed) {
    return {
      allowed: false,
      message: buildQuotaExceededMessage(),
      quota: result,
    }
  }

  return {
    allowed: true,
    quota: result,
  }
}

function pickUrlFromText(input) {
  if (!input || typeof input !== 'string') return ''
  const match = input.match(/https?:\/\/[^\s]+/i)
  return match ? match[0].replace(/[).,;!?]+$/g, '') : ''
}

function detectPlatform(url) {
  const value = String(url || '').toLowerCase()
  if (value.includes('bilibili.com') || value.includes('b23.tv')) return 'bilibili'
  if (value.includes('douyin.com') || value.includes('iesdouyin.com') || value.includes('v.douyin.com')) return 'douyin'
  if (value.includes('youtube.com') || value.includes('youtu.be')) return 'youtube'
  return 'generic'
}

// 平台白名单：仅允许抖音 / B站 域名，拒绝 generic 任意 URL（防 SSRF）
const ALLOWED_PLATFORM_DOMAINS = ['douyin.com', 'bilibili.com', 'b23.tv']

function isAllowedPlatformUrl(url) {
  const lower = String(url || '').toLowerCase()
  return ALLOWED_PLATFORM_DOMAINS.some((domain) => lower.includes(domain))
}

function parseCookieLine(line) {
  const rawLine = String(line || '')
  const isHttpOnly = rawLine.startsWith('#HttpOnly_')
  const normalizedLine = isHttpOnly ? rawLine.slice(10) : rawLine
  const parts = normalizedLine.split('\t')
  if (parts.length < 7) {
    return { valid: false, reason: 'Invalid cookie column count', raw: line }
  }

  const [domain, includeSubdomains, cookiePath, secure, expires, name, ...rest] = parts
  const value = rest.join('\t')
  const initialDot = domain.startsWith('.')
  const subdomainFlag = String(includeSubdomains).toUpperCase()
  const secureFlag = String(secure).toUpperCase()

  if (!domain) return { valid: false, reason: 'Empty cookie domain', raw: line }
  if (!cookiePath) return { valid: false, reason: 'Empty cookie path', raw: line }
  if (!name) return { valid: false, reason: 'Empty cookie name', raw: line }
  if (!['TRUE', 'FALSE'].includes(subdomainFlag)) {
    return { valid: false, reason: 'Invalid subdomain flag', raw: line }
  }
  if (!['TRUE', 'FALSE'].includes(secureFlag)) {
    return { valid: false, reason: 'Invalid secure flag', raw: line }
  }
  if (!/^\d+$/.test(String(expires))) {
    return { valid: false, reason: 'Invalid expires value', raw: line }
  }
  if (initialDot && subdomainFlag !== 'TRUE') {
    return { valid: false, reason: 'Leading-dot domain must use TRUE', raw: line }
  }
  if (!initialDot && subdomainFlag !== 'FALSE') {
    return { valid: false, reason: 'Non-leading-dot domain must use FALSE', raw: line }
  }

  return {
    valid: true,
    normalized: [domain, subdomainFlag, cookiePath, secureFlag, String(expires), name, value].join('\t'),
    httpOnly: isHttpOnly,
  }
}

function sanitizeCookieFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      path: filePath,
      exists: false,
      usable: false,
      size: 0,
      validCount: 0,
      invalidCount: 0,
      invalidReasons: [],
      content: '',
    }
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  const lines = content.split(/\r?\n/)
  const invalidReasons = []
  const validLines = []
  const comments = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('#') && !trimmed.startsWith('#HttpOnly_')) {
      comments.push(line)
      continue
    }

    const parsed = parseCookieLine(line)
    if (parsed.valid) {
      validLines.push(parsed.httpOnly ? `#HttpOnly_${parsed.normalized}` : parsed.normalized)
    } else {
      invalidReasons.push(parsed.reason)
    }
  }

  const normalizedContent = [...comments, '', ...validLines].join('\n')
  const originalNormalized = content.replace(/\r\n/g, '\n').trim()
  const nextNormalized = normalizedContent.trim()

  if (nextNormalized !== originalNormalized) {
    fs.writeFileSync(filePath, normalizedContent ? `${normalizedContent}\n` : '', 'utf-8')
  }

  const finalContent = fs.readFileSync(filePath, 'utf-8')

  return {
    path: filePath,
    exists: true,
    usable: validLines.length > 0,
    size: Buffer.byteLength(finalContent),
    validCount: validLines.length,
    invalidCount: invalidReasons.length,
    invalidReasons: [...new Set(invalidReasons)],
    content: finalContent,
  }
}

function getCookiesMeta(platform) {
  const specificPath = PLATFORM_COOKIE_FILES[platform]
  const candidates = []

  if (specificPath) {
    candidates.push({
      label: `${platform}.specific`,
      ...sanitizeCookieFile(specificPath),
    })
  }

  candidates.push({
    label: 'default',
    ...sanitizeCookieFile(DEFAULT_COOKIES_PATH),
  })

  const active = candidates.find((item) => item.usable) || candidates[0]
  return { platform, active, candidates }
}

// 直链（URL 路径里已含作品 ID）不做网络解析：机房出口访问 douyin.com 页面会被弹回首页，
// 跟随重定向会把 /note/<id> 路径弄丢（实测 finalUrl 退化为裸域名，作品 ID 丢失）。
// 只有 v.douyin.com 等短链才需要跟随重定向解析出真实地址。
const DIRECT_AWEME_URL_RE = /^https?:\/\/(www\.)?douyin\.com\/(video|note|slideshow)\/\d+/i

// 短链（v.douyin.com / b23.tv）解析出的作品页地址缓存：同一个分享链接短期重复解析直接复用，
// 既省一次网络往返，也避免「第一次解析成功、重试时解析失败」这种自相矛盾的结果。
const SHORT_URL_CACHE_TTL_MS = 30 * 60 * 1000
const shortUrlCache = new Map()

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function resolveShareUrl(url) {
  if (DIRECT_AWEME_URL_RE.test(String(url || ''))) return url

  const cachedEntry = shortUrlCache.get(url)
  if (cachedEntry && Date.now() - cachedEntry.at < SHORT_URL_CACHE_TTL_MS) return cachedEntry.finalUrl

  // 短链跳转本身不是风控面（只是一个 302），走直连比走池快得多、也不吃池额度；
  // 2026-09-15 教训：曾经改走池，脏 IP 下重定向失败→返回原始短链→拿不到作品 ID→整单解析失败。
  let lastErr = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': DESKTOP_UA },
        signal: AbortSignal.timeout(8000),
      })
      const finalUrl = response.url || url
      if (finalUrl && finalUrl !== url) {
        shortUrlCache.set(url, { finalUrl, at: Date.now() })
        if (shortUrlCache.size > 200) {
          const oldest = shortUrlCache.keys().next().value
          shortUrlCache.delete(oldest)
        }
        return finalUrl
      }
      lastErr = new Error(`redirect did not resolve (HTTP ${response.status})`)
    } catch (err) {
      lastErr = err
    }
    if (attempt < 3) await sleep(250 * attempt)
  }
  console.error('[Video] 短链解析失败，返回原始链接:', url, lastErr?.message || '')
  return url
}

function buildCookieHeader(cookieMeta) {
  const content = cookieMeta?.active?.content || ''
  if (!content) return ''

  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_')))
    .map((line) => (line.startsWith('#HttpOnly_') ? line.slice(10) : line).split('\t'))
    .filter((parts) => parts.length >= 7)
    .map((parts) => {
      const name = parts[5]
      const value = parts.slice(6).join('\t')
      return name && value ? `${name}=${value}` : ''
    })
    .filter(Boolean)
    .join('; ')
}

function extractHtmlTitle(html) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!match) return ''
  return match[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim()
}

function extractRenderDataFromHtml(html) {
  const source = String(html || '')
  const patterns = [
    /<script[^>]+id=["']RENDER_DATA["'][^>]*>([\s\S]*?)<\/script>/i,
    /<div[^>]+id=["']RENDER_DATA["'][^>]*>([\s\S]*?)<\/div>/i,
  ]

  for (const pattern of patterns) {
    const match = source.match(pattern)
    if (match?.[1]) return match[1].trim()
  }

  return ''
}

function extractInlineScriptTexts(html) {
  return Array.from(String(html || '').matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)).map((match) => match[1] || '')
}

let cachedTtwidCookie = ''
let ttwidFetchTime = 0
const TTWID_CACHE_TTL_MS = 60 * 60 * 1000

// 抖音出站代理（可选）：DOUYIN_PROXY_URL 指向 HTTP(S) 代理网关（隧道代理/住宅出口/自建隧道）。
// 只影响抖音上游请求；代理网关连不上时自动回落直连（连接级错误才回落，HTTP 4xx/5xx 原样抛出）。
const DOUYIN_PROXY_URL = process.env.DOUYIN_PROXY_URL || ''
let douyinProxyAgent = null
const poolAgents = new Map() // 动态池短效 IP：一号一代理（容量上限防泄漏）

function poolAgent(proxyUrl) {
  let agent = poolAgents.get(proxyUrl)
  if (!agent) {
    agent = new ProxyAgent(proxyUrl)
    poolAgents.set(proxyUrl, agent)
    if (poolAgents.size > 12) {
      poolAgents.delete(poolAgents.keys().next().value)
    }
  }
  return agent
}

function isConnectionError(err) {
  const code = err?.cause?.code || err?.code || ''
  return ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'EHOSTUNREACH'].includes(code)
}

// 抖音上游请求的出口选择器（按优先级，成本最优）：
// ① 直连出口可用且「直连额度」没被用掉 → 直连（免费；额度见 douyinDirectBudget：每 4 小时一次）
// ② 否则走动态池（按量付费，多个池自动轮换，某池耗尽自动切下一个）
// ③ DOUYIN_PROXY_URL 静态代理（显式配置时兜底）
// 一次解析任务内出口只决定一次（AsyncLocalStorage），连接级错误逐级回落；
// 直连请求被抖音 403/超时拒绝时由上层自愈逻辑标记嫌疑并触发探测。
async function resolveTaskExit() {
  const store = douyinTaskCtx.getStore()
  if (store?.exit) return store.exit

  const hasPool = await poolEnabled()
  const gate = getDouyinGateState().direct
  // 只有探测确认 ok 才去争额度：unknown（刚重启还没探测）和 blocked 一律先走池，
  // 否则重启后的第一笔解析会白白烧掉 4 小时额度、还要挨一次风控拒绝。
  const budgetOk = hasPool && gate === 'ok' ? await claimDirectBudget() : false
  const exit = decideTaskExit({ gate, hasPool, budgetOk })
  if (store) store.exit = exit
  return exit
}

/** 本轮任务实际上走的是不是直连出口（用于把 403 正确归因给服务器 IP，而不是池 IP）。 */
function lastExitWasDirect() {
  return douyinTaskCtx.getStore()?.lastExit === 'direct'
}

function markTaskExit(used) {
  const store = douyinTaskCtx.getStore()
  if (store) store.lastExit = used
}

async function douyinFetch(url, options = {}, exitOpt = {}) {
  const mode = exitOpt.forcePool ? 'pool' : await resolveTaskExit()

  if (mode === 'pool') {
    let proxyUrl = null
    try {
      proxyUrl = await getPoolProxy(exitOpt.poolId ? { poolId: exitOpt.poolId } : {})
    } catch (err) {
      // 所有池都不可用/指定池不存在：回落直连，至少让用户这次解析有机会成功
      if (!err.poolExhausted && !err.poolMissing) throw err
      console.error(`[Douyin] ${err.message}，本次回落直连`)
    }
    if (proxyUrl) {
      try {
        const response = await undiciFetch(url, { ...options, dispatcher: poolAgent(proxyUrl) })
        markTaskExit('pool')
        return response
      } catch (err) {
        if (!isConnectionError(err)) throw err
        console.error('[Douyin] pool proxy unreachable, falling back to direct')
      }
    }
  }

  if (DOUYIN_PROXY_URL) {
    try {
      if (!douyinProxyAgent) douyinProxyAgent = new ProxyAgent(DOUYIN_PROXY_URL)
    } catch (err) {
      console.error('[Douyin] invalid DOUYIN_PROXY_URL, falling back to direct:', err.message)
      markTaskExit('direct')
      return fetch(url, options)
    }
    try {
      const response = await undiciFetch(url, { ...options, dispatcher: douyinProxyAgent })
      markTaskExit('static-proxy')
      return response
    } catch (err) {
      if (!isConnectionError(err)) throw err
      console.error('[Douyin] proxy unreachable, falling back to direct')
    }
  }
  markTaskExit('direct')
  return fetch(url, options)
}

const TTWID_REGISTER_URL = 'https://ttwid.bytedance.com/ttwid/union/register/'
const TTWID_REGISTER_BODY = JSON.stringify({
  region: 'cn',
  aid: 1768,
  needFp: 'true',
  fp: 'verify_l0123456_1234_1234_1234_123456789012',
  service: 'www.douyin.com',
  migrate_info: { ticket: '', source: 'node' },
  cb: 'user_unique_id',
})

async function registerTtwid(viaPool) {
  const init = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': DESKTOP_UA,
    },
    body: TTWID_REGISTER_BODY,
    signal: AbortSignal.timeout(8000),
  }
  const res = viaPool ? await douyinFetch(TTWID_REGISTER_URL, init) : await fetch(TTWID_REGISTER_URL, init)
  const getSetCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || '']
  for (const c of getSetCookie) {
    if (c && c.includes('ttwid=')) return c.split(';')[0].trim()
  }
  return ''
}

async function getOrFetchTtwidCookie() {
  if (cachedTtwidCookie && Date.now() - ttwidFetchTime < TTWID_CACHE_TTL_MS) {
    return cachedTtwidCookie
  }
  // ttwid 是浏览器指纹 cookie、不绑定出口 IP，而 ttwid.bytedance.com 也不是抖音风控接口：
  // 直连注册最快最稳（少一次池往返），失败再退回池出口。历史教训：注册也走池时，
  // 一个脏 IP 会让「换新 IP 重试」的 ttwid 注册失败，整单解析被判死。
  const plan = [false, false, true]
  for (let i = 0; i < plan.length; i += 1) {
    try {
      const ttwid = await registerTtwid(plan[i])
      if (ttwid) {
        cachedTtwidCookie = ttwid
        ttwidFetchTime = Date.now()
        return cachedTtwidCookie
      }
    } catch (err) {
      console.error(`[Douyin] ttwid 注册失败(${plan[i] ? '池' : '直连'}):`, err.message)
    }
    if (i < plan.length - 1) await sleep(300 * (i + 1))
  }
  return cachedTtwidCookie || ''
}

/** 403/429 自愈用：丢弃缓存的 ttwid，重新注册一个全新的。 */
async function forceRefreshTtwidCookie() {
  cachedTtwidCookie = null
  ttwidFetchTime = 0
  return getOrFetchTtwidCookie()
}

/** 保留 cookie 串里其它字段（如登录态），仅把 ttwid 换成新注册的。 */
function rebuildCookieHeaderWithFreshTtwid(header, freshTtwid) {
  const parts = String(header || '')
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item && !/^ttwid=/i.test(item))
  parts.push(freshTtwid)
  return parts.join('; ')
}

// —— 出口网关探测：跟踪机房 IP 的解封状态，状态翻转时由 douyinGateProbe 发邮件 ——
// 探测依据是 HTTP 状态码而非作品内容（作品被删时 API 仍返回 200 + filter JSON，网关状态照常可判）。
// 若探测目标将来失效，可用 DOUYIN_GATE_PROBE_ID 换成任意公开作品 ID，无需改代码。
const DOUYIN_GATE_PROBE_AWEME_ID = process.env.DOUYIN_GATE_PROBE_ID || '7684182405306355818'
async function probeDouyinGateState() {
  const cookiesMeta = getCookiesMeta('douyin')
  let cookieHeader = buildCookieHeader(cookiesMeta)
  if (!cookieHeader || !cookieHeader.includes('ttwid=')) {
    const ttwid = await getOrFetchTtwidCookie()
    if (ttwid) cookieHeader = cookieHeader ? `${cookieHeader}; ${ttwid}` : ttwid
  }
  const query = buildDouyinDetailParams(DOUYIN_GATE_PROBE_AWEME_ID).toString()
  const aBogus = generateABogus(query, DESKTOP_UA)
  const detailUrl = `https://www.douyin.com/aweme/v1/web/aweme/detail/?${query}&a_bogus=${encodeURIComponent(aBogus)}`
  const probeHeaders = {
    'User-Agent': DESKTOP_UA,
    Referer: 'https://www.douyin.com/',
    Accept: 'application/json, text/plain, */*',
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  }

  // 只探测直连出口（本机公网 IP 是否被抖音解封）——裸 fetch，不消耗任何池额度。
  // 池出口的健康度不需要专门探测：真实解析失败时的自动换 IP 重试就是现场检验，
  // 池子整体死亡会以解析失败的形式暴露给站长（错误文案已如实化）。
  let directOk = false
  try {
    const r = await fetch(detailUrl, { headers: probeHeaders, signal: AbortSignal.timeout(10000) })
    directOk = r.ok
    try { await r.body?.cancel?.() } catch { /* noop */ }
  } catch (err) {
    console.error('[DouyinGate] 直连探测请求失败:', err.message)
  }

  recordGateProbe(directOk)
}

// 探测周期（2026-09-13 站长拍板：每 4 小时一次；状态翻转不再发邮件）。
// 一轮 = 探测直连出口 + 顺带查一次各池余量（低于阈值发预警邮件）。
const DOUYIN_GATE_PROBE_INTERVAL_MS = 4 * 60 * 60 * 1000
async function runDouyinGateCycle() {
  try {
    await probeDouyinGateState()
  } catch (err) {
    console.error('[DouyinGate] 探测失败:', err.message)
  }
  try {
    await checkPoolBalanceAndWarn()
  } catch (err) {
    console.error('[DouyinPool] 余量检查失败:', err.message)
  }
}

if (process.env.NODE_ENV === 'production') {
  const gateFirstProbe = setTimeout(() => { runDouyinGateCycle().catch(() => {}) }, 30 * 1000)
  gateFirstProbe.unref?.()
  const gateProbeTimer = setInterval(() => { runDouyinGateCycle().catch(() => {}) }, DOUYIN_GATE_PROBE_INTERVAL_MS)
  gateProbeTimer.unref?.()
}

// 请求级 403/超时后的去抖探测：让出口状态尽快翻转（限 10 分钟一次，防风暴）
let lastAutoProbe = 0
function triggerAutoProbe() {
  const now = Date.now()
  if (now - lastAutoProbe < 10 * 60 * 1000) return
  lastAutoProbe = now
  probeDouyinGateState().catch(() => {})
}

async function fetchDouyinPageHtml(url, options = {}) {
  const cookiesMeta = getCookiesMeta('douyin')
  let cookieHeader = options.customCookieHeader || buildCookieHeader(cookiesMeta)
  if (!cookieHeader || !cookieHeader.includes('ttwid=')) {
    const ttwid = await getOrFetchTtwidCookie()
    if (ttwid) {
      cookieHeader = cookieHeader ? `${cookieHeader}; ${ttwid}` : ttwid
    }
  }
  const response = await douyinFetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent': DESKTOP_UA,
      Referer: 'https://www.douyin.com/',
      Origin: 'https://www.douyin.com',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
  })

  if (!response.ok) {
    throw new Error(`douyin page request failed: HTTP ${response.status}`)
  }

  return {
    finalUrl: response.url || url,
    html: await response.text(),
  }
}

function extractDouyinAwemeId(url) {
  const value = String(url || '')
  const patterns = [/\/video\/(\d+)/i, /\/note\/(\d+)/i, /[?&]modal_id=(\d+)/i, /[?&]aweme_id=(\d+)/i]

  for (const pattern of patterns) {
    const match = value.match(pattern)
    if (match?.[1]) return match[1]
  }

  return ''
}

function buildDouyinDetailParams(awemeId) {
  return new URLSearchParams({
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    pc_client_type: '1',
    version_code: '290100',
    version_name: '29.1.0',
    cookie_enabled: 'true',
    screen_width: '1920',
    screen_height: '1080',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Chrome',
    browser_version: '130.0.0.0',
    browser_online: 'true',
    engine_name: 'Blink',
    engine_version: '130.0.0.0',
    os_name: 'Windows',
    os_version: '10',
    cpu_core_num: '12',
    device_memory: '8',
    platform: 'PC',
    downlink: '10',
    effective_type: '4g',
    from_user_page: '1',
    locate_query: 'false',
    need_time_list: '1',
    pc_libra_divert: 'Windows',
    publish_video_strategy_type: '2',
    round_trip_time: '0',
    show_live_replay_strategy: '1',
    time_list_query: '0',
    whale_cut_token: '',
    update_version_code: '170400',
    msToken: '',
    aweme_id: String(awemeId || ''),
  })
}

function pickFirstUrl(input) {
  if (!input) return ''
  if (typeof input === 'string') return input
  if (Array.isArray(input)) return input.map((item) => pickFirstUrl(item)).find(Boolean) || ''
  if (typeof input === 'object') {
    return pickFirstUrl(input.url_list) || pickFirstUrl(input.urlList) || pickFirstUrl(input.src) || pickFirstUrl(input.uri) || ''
  }
  return ''
}

function collectUrlCandidates(input) {
  if (!input) return []
  if (typeof input === 'string') return input.trim() ? [input.trim()] : []
  if (Array.isArray(input)) {
    return input.flatMap((item) => collectUrlCandidates(item)).filter(Boolean)
  }
  if (typeof input === 'object') {
    return [
      ...collectUrlCandidates(input.url_list),
      ...collectUrlCandidates(input.urlList),
      ...collectUrlCandidates(input.src),
      ...collectUrlCandidates(input.uri),
    ].filter(Boolean)
  }
  return []
}

function writeDouyinDebugFile(fileName, content) {
  if (!process.env.DOUYIN_DEBUG) return
  fs.mkdirSync(DOUYIN_DEBUG_DIR, { recursive: true })
  fs.writeFileSync(path.join(DOUYIN_DEBUG_DIR, fileName), String(content || ''), 'utf-8')
}

function isAllowedDouyinImageUrl(url) {
  const value = String(url || '').trim()
  if (!/^https?:\/\//i.test(value)) return false
  const lower = value.toLowerCase()
  if (DOUYIN_IMAGE_URL_BLOCKLIST.some((item) => lower.includes(item))) return false
  return DOUYIN_IMAGE_HOST_ALLOWLIST.some((item) => lower.includes(item))
}

function dedupeMediaItems(items) {
  const result = []
  const seen = new Set()
  for (const item of items || []) {
    const url = String(item?.url || '').trim()
    if (!url || seen.has(url)) continue
    seen.add(url)
    result.push(item)
  }
  return result
}

function dedupeStrings(values) {
  const result = []
  const seen = new Set()
  for (const value of values || []) {
    const next = String(value || '').trim()
    if (!next || seen.has(next)) continue
    seen.add(next)
    result.push(next)
  }
  return result
}

function inferExtensionFromUrl(url, fallback = 'jpg') {
  const lower = String(url || '').toLowerCase()
  const fromQueryless = lower.split('?')[0]
  const ext = path.extname(fromQueryless).replace('.', '')
  if (ext) return ext
  return fallback
}

function inferImageContentType(url) {
  const ext = inferExtensionFromUrl(url)
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  return 'image/jpeg'
}

function normalizeDouyinVideoUrl(url) {
  const value = String(url || '').replace(/\\u002F/g, '/').trim()
  if (!value) return ''

  let next = value
    .replace(/playwm/gi, 'play')
    .replace(/\/playwm\//gi, '/play/')
    .replace(/watermark=1/gi, 'watermark=0')
    .replace(/wm=1/gi, 'wm=0')

  try {
    const parsed = new URL(next)
    const deleteKeys = ['watermark', 'wm', 'is_play_url']
    deleteKeys.forEach((key) => {
      const current = parsed.searchParams.get(key)
      if (current === '1') parsed.searchParams.set(key, '0')
    })
    next = parsed.toString()
  } catch {
    // keep normalized string as-is
  }

  return next
}

function normalizeDouyinImageUrl(url) {
  const value = String(url || '').replace(/\\u002F/g, '/').trim()
  if (!value) return ''
  return value
}

function buildDouyinImageVariants(url) {
  const normalized = normalizeDouyinImageUrl(url)
  if (!normalized) return []
  return [normalized]
}

function scoreDouyinImageUrl(url) {
  const value = String(url || '').toLowerCase()
  if (!value) return -Infinity

  let score = 0
  if (/\.webp($|\?)/.test(value)) score += 20
  if (/tplv-dy-aweme-images/.test(value)) score += 80
  if (/tplv-dy-water-v2/.test(value)) score -= 120
  if (/tos-cn-i-dy/.test(value)) score += 20
  if (/p3-pc-sign|p9-pc-sign/.test(value)) score += 8
  if (/original|source|1080|2160|raw/.test(value)) score += 5
  return score
}

function sortDouyinImageCandidates(candidates) {
  return dedupeStrings((candidates || []).flatMap((item) => buildDouyinImageVariants(item)).filter(Boolean))
    .sort((a, b) => scoreDouyinImageUrl(b) - scoreDouyinImageUrl(a))
}

function pickBestDouyinImageUrl(candidates) {
  return sortDouyinImageCandidates(candidates)[0] || ''
}

function scoreDouyinVideoUrl(url) {
  const value = String(url || '').toLowerCase()
  if (!value) return -Infinity

  let score = 0
  if (/play(?!wm)|play_addr|playapi|bytevc|aweme|tos-cn/.test(value)) score += 30
  if (/playwm|watermark=1|wm=1|logo_type|\/logo\//.test(value)) score -= 120
  if (/download_addr|download/.test(value)) score -= 35
  if (/ratio=1080|ratio=720|1080p|720p|source=pack/.test(value)) score += 5
  if (/is_play_url=1/.test(value)) score += 18
  if (/mime_type=video_mp4/.test(value)) score += 8
  return score
}

function pickBestDouyinVideoUrl(candidates) {
  return (candidates || [])
    .map((item) => normalizeDouyinVideoUrl(item))
    .filter(Boolean)
    .sort((a, b) => scoreDouyinVideoUrl(b) - scoreDouyinVideoUrl(a))[0] || ''
}

function buildDouyinAnalyzeResult({ title, url, video = null, audio = null, images = [], source, imagePost = false }) {
  const formats = []

  // 图文/图集（images 非空）：detail.video.play_addr 实测返回的是 BGM 文件
  // （content-type: audio/mp4，magic ftypM4A），并不是可下载的视频，
  // 所以只暴露「背景音乐 + 图片」两类格式，不再给出视频选项（2026-09-16 站长反馈）。
  const isImagePost = imagePost || images.length > 0

  if (video?.url) {
    formats.push({
      formatId: source === 'browser-automation' ? 'browser-video' : 'direct-video',
      quality: '原始视频',
      ext: inferExtensionFromUrl(video.url, 'mp4'),
      filesize: '大小未知',
      hasAudio: !audio,
      mediaType: 'video',
      directUrl: video.url,
      audioUrl: audio?.url || '',
      contentType: video.contentType || 'video/mp4',
      sourceCandidates: video.sourceCandidates || [],
    })
  }

  // 视频作品的「仅音频」与图文的「背景音乐」共用同一条音频下载链路（服务端统一转 MP3），
  // 扩展名因此固定为 mp3，避免前端把 MP3 字节存成 .m4a。
  const audioUrl = audio?.url || video?.url || ''
  if (audioUrl) {
    formats.push({
      formatId: source === 'browser-automation' ? 'browser-audio' : 'direct-audio',
      quality: isImagePost ? '背景音乐' : '仅音频',
      ext: 'mp3',
      filesize: '大小未知',
      hasAudio: true,
      mediaType: 'audio',
      directUrl: audioUrl,
      audioUrl,
      contentType: audio?.contentType || 'audio/mpeg',
      sourceCandidates: audio?.sourceCandidates || video?.sourceCandidates || [],
    })
  }

  images.forEach((item, index) => {
    formats.push({
      formatId: `image-${index + 1}`,
      quality: `第${index + 1}张`,
      ext: inferExtensionFromUrl(item.url, item.contentType?.includes('png') ? 'png' : 'jpg'),
      filesize: '大小未知',
      hasAudio: false,
      mediaType: 'image',
      directUrl: item.url,
      audioUrl: '',
      contentType: item.contentType || inferImageContentType(item.url),
      sourceCandidates: item.sourceCandidates || [],
    })
  })

  const primary = formats[0] || null
  const preferredPreview = formats.find((item) => item.mediaType === 'video' || item.mediaType === 'image') || primary
  return {
    title: title || '未知标题',
    thumbnail: images[0]?.url || '',
    directPreviewUrl: preferredPreview?.directUrl || '',
    directPreviewType: preferredPreview?.mediaType || '',
    webpageUrl: url,
    platform: 'douyin',
    source,
    formats,
  }
}

function normalizeDouyinSignedApiImages(detail) {
  const rawImages = []
  if (Array.isArray(detail?.images)) rawImages.push(...detail.images)
  if (Array.isArray(detail?.image_post_info?.images)) rawImages.push(...detail.image_post_info.images)

  return dedupeMediaItems(
    rawImages
      .map((item) => {
        const preferredCandidates = sortDouyinImageCandidates([
          ...collectUrlCandidates(item?.url_list),
          ...collectUrlCandidates(item?.urlList),
          ...collectUrlCandidates(item?.display_image?.url_list),
        ])
        const fallbackCandidates = sortDouyinImageCandidates([
          ...collectUrlCandidates(item?.download_url_list),
          ...collectUrlCandidates(item?.downloadUrlList),
          ...collectUrlCandidates(item?.owner_watermark_image?.url_list),
        ])
        const sourceCandidates = dedupeStrings([
          ...preferredCandidates,
          ...fallbackCandidates,
        ])
        const url = pickBestDouyinImageUrl(sourceCandidates)

        if (!url || !isAllowedDouyinImageUrl(url)) return null
        return {
          url,
          contentType: inferImageContentType(url),
          sourceCandidates,
        }
      })
      .filter(Boolean),
  )
}

function normalizeDouyinSignedApiVideo(detail) {
  const video = detail?.video || {}
  const candidates = [
    pickFirstUrl(video?.play_addr?.url_list),
    pickFirstUrl(video?.play_addr_h264?.url_list),
    pickFirstUrl(video?.play_addr_265?.url_list),
  ].filter(Boolean)

  const normalizedBitrateCandidates = (video?.bit_rate || [])
    .flatMap((item) => [
      pickFirstUrl(item?.play_addr?.url_list),
      pickFirstUrl(item?.play_addr_h264?.url_list),
      pickFirstUrl(item?.play_addr_265?.url_list),
    ])
    .filter(Boolean)

  const sourceCandidates = dedupeStrings([...normalizedBitrateCandidates, ...candidates])
    .map((item) => normalizeDouyinVideoUrl(item))
    .filter(Boolean)
    .sort((a, b) => scoreDouyinVideoUrl(b) - scoreDouyinVideoUrl(a))

  const directUrl = sourceCandidates[0] || ''
  const normalizedUrl = normalizeDouyinVideoUrl(directUrl)
  const lower = normalizedUrl.toLowerCase()
  if (!normalizedUrl) return null
  if (lower.includes('ies-music') || lower.endsWith('.mp3') || /audio|music/.test(lower)) {
    return null
  }
  return directUrl
    ? {
        url: normalizedUrl,
        contentType: 'video/mp4',
        sourceCandidates,
      }
    : null
}

function extractDouyinTitleFromDetail(detail) {
  return detail?.desc || detail?.preview_title || detail?.share_info?.share_title || detail?.mix_info?.mix_name || ''
}

/**
 * 图文的 BGM 来源：detail.music.play_url 是真正的原声；
 * 实测图文里 video.play_addr 也指向同一个 BGM 文件（content-type: audio/mp4），作为回退。
 */
function normalizeDouyinBgmAudio(detail) {
  const candidates = dedupeStrings([
    pickFirstUrl(detail?.music?.play_url?.url_list),
    pickFirstUrl(detail?.music?.play_url),
    pickFirstUrl(detail?.video?.play_addr?.url_list),
    pickFirstUrl(detail?.video?.play_addr_h264?.url_list),
  ])
    .map((item) => normalizeDouyinVideoUrl(item))
    .filter(Boolean)

  if (!candidates.length) return null
  return { url: candidates[0], contentType: 'audio/mp4', sourceCandidates: candidates }
}

function getDouyinAnalyzeCache(url) {
  const cached = douyinAnalyzeCache.get(url)
  if (!cached) return null
  if (Date.now() - cached.createdAt > DOUYIN_ANALYZE_CACHE_TTL_MS) {
    douyinAnalyzeCache.delete(url)
    return null
  }
  return cached.data
}

function setDouyinAnalyzeCache(url, data) {
  // 超出容量时淘汰最旧的一条（Map 保持插入顺序）
  if (douyinAnalyzeCache.size >= DOUYIN_ANALYZE_CACHE_MAX_SIZE) {
    const oldestKey = douyinAnalyzeCache.keys().next().value
    if (oldestKey !== undefined) douyinAnalyzeCache.delete(oldestKey)
  }
  douyinAnalyzeCache.set(url, { createdAt: Date.now(), data })
}

// 抖音对同 IP 短时间内的 detail 请求会随机下发 403（实测约 1/3 概率），退避重试即可恢复。
// 首轮（当前 IP）给 3 次尝试，但退避砍短（旧版 700+1600+3200 最坏白睡 5.5 秒，是「解析很久」的主因）；
// 后续轮次已经换了新 IP，只留 1 次快速重试——换 IP 才是真正解法，同 IP 反复睡没意义。
async function fetchDouyinSignedDetailBody(awemeId, cookieHeader, { maxAttempts = 3, delays = [600, 1500] } = {}) {
  let lastStatus = 0
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) {
      await sleep(delays[attempt - 1] ?? delays[delays.length - 1] ?? 500)
    }

    const query = buildDouyinDetailParams(awemeId).toString()
    const aBogus = generateABogus(query, DESKTOP_UA)
    const response = await douyinFetch(
      `https://www.douyin.com/aweme/v1/web/aweme/detail/?${query}&a_bogus=${encodeURIComponent(aBogus)}`,
      {
        method: 'GET',
        headers: {
          'User-Agent': DESKTOP_UA,
          Referer: 'https://www.douyin.com/',
          Origin: 'https://www.douyin.com',
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          Cookie: cookieHeader,
          'x-requested-with': 'XMLHttpRequest',
        },
        // 池里难免抽到「TCP 通、永不回包」的黑洞 IP。不给超时就会一直挂着——
        // 2026-09-16 实测一次解析因此在单个死 IP 上白等 120 秒才失败换 IP。
        // 正常请求实测约 1 秒，给 12 秒足够；超时即抛错，外层立刻换新 IP 重试。
        signal: AbortSignal.timeout(DOUYIN_DETAIL_TIMEOUT_MS),
      },
    )

    const text = await response.text()
    if (response.ok && text) return text
    // 200 但响应体为空 = 风控静默拒绝（过期 ttwid 的典型表现），重试同一个 ttwid
    // 没有意义，直接抛出可识别错误，交给上层做「换新 ttwid」的自愈重试。
    if (response.ok && !text) {
      throw new Error('douyin signed api returned empty body (silent risk-control rejection)')
    }

    lastStatus = response.status
    if (response.status !== 403 && response.status !== 429 && response.status < 500) break
  }

  throw new Error(`douyin signed api failed: HTTP ${lastStatus}`)
}

/**
 * 出口预热（fire-and-forget）：短链解析走直连，于是「提取池 IP」和「注册 ttwid」这两件
 * 串行在关键路径上的事可以并行做掉，解析能省 0.5~2 秒。失败无所谓，正式请求会自己兜。
 *
 * 省额度两条闸门：① 出口决策不是 pool 就不提取（直连模式零消耗）；
 * ② 该作品已有新鲜解析缓存时不提取——重复点击「解析」会命中缓存直接返回，预热等于白烧一个 IP。
 */
function hasFreshAnalyzeCacheFor(url) {
  const id = extractDouyinAwemeId(url)
  if (!id) return false
  for (const [key, entry] of douyinAnalyzeCache) {
    if (Date.now() - entry.createdAt > DOUYIN_ANALYZE_CACHE_TTL_MS) continue
    if (String(key).includes(id)) return true
  }
  return false
}

async function warmDouyinExit(inputUrl) {
  try {
    const exit = await resolveTaskExit()
    const skipPool = exit !== 'pool' || hasFreshAnalyzeCacheFor(inputUrl)
    await Promise.allSettled([
      skipPool ? Promise.resolve(null) : getPoolProxy(),
      getOrFetchTtwidCookie(),
    ])
  } catch { /* 预热失败不影响正式流程 */ }
}

async function analyzeDouyinViaSignedApi(url, options = {}) {
  const finalUrl = await resolveShareUrl(url)
  const cached = getDouyinAnalyzeCache(finalUrl)
  if (cached) return cached

  const awemeId = extractDouyinAwemeId(finalUrl)
  if (!awemeId) {
    // 多数情况是短链没跳成作品页（网络抖动/被弹回），不是作品不存在；如实报出去让人重试
    throw new Error(`unable to extract douyin aweme id (resolved: ${String(finalUrl).slice(0, 90)})`)
  }

  const cookiesMeta = getCookiesMeta('douyin')
  let cookieHeader = options.customCookieHeader || buildCookieHeader(cookiesMeta)
  let usedFreshTtwid = false
  if (!cookieHeader || !cookieHeader.includes('ttwid=')) {
    const ttwid = await getOrFetchTtwidCookie()
    if (ttwid) {
      cookieHeader = cookieHeader ? `${cookieHeader}; ${ttwid}` : ttwid
      usedFreshTtwid = true
    }
  }

  // 出口被拒（403/429/空响应）时的恢复序列：
  //  池模式：最多 3 次，每次 = 作废当前池 IP + 重新提取 + 新注册 ttwid（全新 IP+身份组合）
  //  直连模式：最多 2 次，第 2 次仅换 ttwid（出口不变）；首次已用刚注册的 ttwid 时不重复换
  // 带 sessionid 的登录 cookie 不参与任何轮换（避免破坏会话、避免登录态跳 IP）。
  let text = null
  let lastError = null
  const poolReady = await poolEnabled()
  // 池模式下每次重试只花 1~4 秒（换 IP + 直连注册 ttwid），所以给到 4 次换取成功率；
  // 直连模式没得换，2 次足够（第 2 次仅换 ttwid）。
  // 省额度：路由层的第二轮回退只在首轮全败后触发，那时只给 2 次机会（options.signedApiMaxAttempts），
  // 避免一次失败最多烧掉 8 个 IP。
  const maxAttempts = options.signedApiMaxAttempts || (poolReady ? 4 : 2)
  // 下一轮是否换出口 IP（由上一轮失败原因决定；静默拒绝 = ttwid 过期，复用同一 IP 省额度）
  let rotateIpNext = true
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let header = cookieHeader
    try {
      if (attempt > 1) {
        // 省 IP 的关键：按失败原因决定要不要换出口。
        //  - 「200 空响应」是过期 ttwid 的典型表现 → 同一个 IP 换个 ttwid 就够了，不烧新 IP；
        //  - 403/429/超时 才是 IP 被判可疑 → 必须换 IP。
        // 换 IP 与重新注册 ttwid 互不依赖，并行做以省一次串行等待。
        const wantPool = poolReady && douyinTaskCtx.getStore()?.exit === 'pool'
        const rotateIp = wantPool && rotateIpNext
        if (rotateIp) invalidatePoolProxy()
        const [freshTtwid] = await Promise.all([
          forceRefreshTtwidCookie(),
          rotateIp ? getPoolProxy().catch(() => null) : Promise.resolve(null),
        ])
        if (freshTtwid) {
          header = rebuildCookieHeaderWithFreshTtwid(cookieHeader, freshTtwid)
          console.error(`[Video] signed-api rejected, retrying (${attempt}/${maxAttempts}) with fresh ttwid${rotateIp ? ' + fresh pool ip' : '（复用同一出口 IP，省额度）'}`)
        } else {
          // ttwid 注册失败也要继续：换新出口 IP 本身就是主要解法，不能因此放弃重试
          console.error(`[Video] ttwid 注册失败，仍换新出口 IP 重试 (${attempt}/${maxAttempts})`)
        }
      }
      text = await fetchDouyinSignedDetailBody(
        awemeId,
        header,
        attempt === 1 ? undefined : { maxAttempts: 2, delays: [400] },
      )
      break
    } catch (error) {
      lastError = error
      const reason = String(error?.message || '')
      const silentRejection = /empty body/i.test(reason)
      const status = /HTTP (\d{3})/.exec(reason)?.[1]
      const stale = ['403', '429'].includes(status) || silentRejection || /timeout|abort/i.test(reason)
      // 静默拒绝更像 ttwid 过期而非 IP 脏：下一轮先不换 IP，只换 ttwid（零 IP 消耗）
      rotateIpNext = !silentRejection
      // 只有「这一轮真的走了直连」才把嫌疑记到直连出口头上——池 IP 被拒跟服务器 IP 无关
      if (stale && lastExitWasDirect()) {
        // 请求级实时信号：直连嫌疑标记（出口选择器立即切换池）+ 去抖探测（权威判定走定时探测）
        markDirectSuspect()
        triggerAutoProbe()
      }
      const rotationBlocked = /sessionid=/i.test(cookieHeader) || (usedFreshTtwid && !poolReady && attempt === 1)
      if (stale && rotationBlocked) {
        console.error('[Video] 携带登录 cookie（sessionid），按既定策略不做出口/ttwid 轮换，直接上抛由兜底路径处理')
      }
      if (!stale || rotationBlocked || attempt === maxAttempts) throw error
    }
  }
  if (!text) throw (lastError || new Error('douyin signed api attempts exhausted'))

  writeDouyinDebugFile('douyin-signed-api-response.json', text)

  let payload = {}
  try {
    payload = JSON.parse(text)
  } catch (error) {
    throw new Error(`douyin signed api json parse failed: ${error.message}`)
  }

  const detail = payload?.aweme_detail
  if (!detail || typeof detail !== 'object') {
    // 抖音对「已删除/设为私密/权限受限」的作品返回 200 + aweme_detail:null + filter_detail（见 F12），
    // 这是接口的权威判定——作为终态错误向上抛，跳过其余解析路径与兜底。
    const fd = payload?.filter_detail
    if (fd && (fd.filter_reason || fd.detail_msg)) {
      const err = new Error(`DOUYIN_WORK_UNAVAILABLE: ${fd.detail_msg || fd.filter_reason}`)
      err.workUnavailable = true
      err.filterReason = fd.filter_reason || ''
      throw err
    }
    throw new Error(`douyin signed api missing aweme_detail: ${payload?.status_msg || payload?.message || 'unknown error'}`)
  }

  const images = normalizeDouyinSignedApiImages(detail)
  const isImagePost = images.length > 0
  const result = buildDouyinAnalyzeResult({
    title: extractDouyinTitleFromDetail(detail),
    url: finalUrl,
    // 图文/图集里 video.play_addr 是 BGM，不当作视频下载项；改由 normalizeDouyinBgmAudio 提供音频
    video: isImagePost ? null : normalizeDouyinSignedApiVideo(detail),
    audio: isImagePost ? normalizeDouyinBgmAudio(detail) : null,
    images,
    source: 'signed-api',
    imagePost: isImagePost,
  })

  if (!result.formats.length) throw new Error('douyin signed api did not return usable media')
  setDouyinAnalyzeCache(finalUrl, result)
  return result
}

/**
 * 图集打包时图片直链失效（CDN 签名过期 / 403）的兜底：重新走一次解析拿新直链。
 * 走的是解析缓存优先的链路——缓存命中时零池 IP 消耗，只有真的过期了才会重新解析。
 */
async function refreshDouyinAlbumImageUrls(finalUrl) {
  try {
    const data = await analyzeDouyinViaSignedApi(finalUrl)
    const urls = (data?.formats || []).filter((item) => item.mediaType === 'image').map((item) => item.directUrl).filter(Boolean)
    return urls.length ? urls : null
  } catch (error) {
    console.error('[Video] 图集直链刷新失败:', error?.message || String(error))
    return null
  }
}

// 下载时按 formatId 的语义（图/音/视频）回到签名链路取直链，不依赖前端回传，也兼容 yt-dlp 兜底出的格式 id
async function resolveDouyinDownloadTarget(finalUrl, formatId, options) {
  let data = null
  try {
    data = await analyzeDouyinViaSignedApi(finalUrl, options)
  } catch (error) {
    console.error('[Video] douyin download resolve failed:', error?.message || String(error))
    return null
  }

  const formats = data?.formats || []
  const id = String(formatId || '')
  const imageIndex = /^image-(\d+)$/.exec(id)

  if (imageIndex) {
    const picked = formats.filter((item) => item.mediaType === 'image')[Number(imageIndex[1]) - 1]
    return picked?.directUrl ? { formatId: id, directUrl: picked.directUrl, audioUrl: '' } : null
  }

  const wantAudio = /audio/i.test(id)
  const picked = formats.find((item) => item.mediaType === (wantAudio ? 'audio' : 'video'))
  if (!picked?.directUrl) return null
  return {
    formatId: wantAudio ? 'direct-audio' : 'direct-video',
    directUrl: picked.directUrl,
    audioUrl: picked.audioUrl || '',
  }
}

function extractJsonObjectsFromScripts(scripts) {
  const jsonCandidates = []
  const patterns = [
    /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;/g,
    /window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*;/g,
    /\{\s*"aweme"[\s\S]*?\}/g,
  ]

  for (const script of scripts) {
    for (const pattern of patterns) {
      for (const match of script.matchAll(pattern)) {
        if (match?.[1]) jsonCandidates.push(match[1])
        else if (match?.[0]) jsonCandidates.push(match[0])
      }
    }
  }

  return jsonCandidates
}

function safeJsonParse(input) {
  try {
    return JSON.parse(input)
  } catch {
    return null
  }
}

function collectNestedMediaUrls(value, acc = { images: [], videos: [] }) {
  if (!value) return acc

  if (typeof value === 'string') {
    const normalized = value.replace(/\\u002F/g, '/')
    const lower = normalized.toLowerCase()
    if (/^https?:\/\//i.test(normalized)) {
      if (isAllowedDouyinImageUrl(normalized)) {
        acc.images.push({ url: normalized, contentType: inferImageContentType(normalized) })
      } else if (/play|video|aweme|tos-cn|bytevc/i.test(lower)) {
        acc.videos.push({ url: normalized, contentType: 'video/mp4' })
      }
    }
    return acc
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectNestedMediaUrls(item, acc))
    return acc
  }

  if (typeof value === 'object') {
    Object.values(value).forEach((item) => collectNestedMediaUrls(item, acc))
  }

  return acc
}

/** 抖音作品页判定：短链解析必须落在 /video/<id> 或 /note/<id>（或 iesdouyin 分享页），
 * 否则说明被风控弹到了首页/聚合页——那种页面上的图片全是杂图，绝不能当图集结果返回。 */
function isAwemePageUrl(url) {
  return /douyin\.com\/(video|note)\/\d+/i.test(String(url || '')) || /iesdouyin\.com\/share/i.test(String(url || ''))
}

// 抖音图集单作品上限约 35 张：抓回来超过这个数的基本都是把整个页面当图集刮了，宁可报错也不给垃圾结果。
const DOUYIN_GALLERY_MAX_IMAGES = 40

async function analyzeDouyinViaRequest(url, options = {}) {
  const finalUrl = await resolveShareUrl(url)
  if (!isAwemePageUrl(finalUrl)) {
    console.error('[Video] request-extract abort: 分享链接没有落在作品页:', finalUrl.slice(0, 120))
    // 复用既有文案通道（normalizeVideoError 会把它归因为风控拦截）
    throw new Error(`douyin page request failed: share url did not land on an aweme page (${finalUrl.slice(0, 100)})`)
  }
  const cached = getDouyinAnalyzeCache(finalUrl)
  if (cached) return cached

  const { html } = await fetchDouyinPageHtml(finalUrl, options)
  writeDouyinDebugFile('douyin-page.html', html)

  const renderDataRaw = extractRenderDataFromHtml(html)
  const scripts = extractInlineScriptTexts(html)
  const jsonObjects = extractJsonObjectsFromScripts(scripts)
  const candidates = []

  if (renderDataRaw) {
    candidates.push(renderDataRaw)
    try {
      candidates.push(decodeURIComponent(renderDataRaw))
    } catch {
      // ignore
    }
  }

  candidates.push(...jsonObjects)

  let title = extractHtmlTitle(html)
  let images = []
  let video = null

  for (const item of candidates) {
    const parsed = safeJsonParse(item)
    if (!parsed) continue
    const collected = collectNestedMediaUrls(parsed)
    if (!images.length) {
      images = dedupeMediaItems(collected.images).filter((entry) => isAllowedDouyinImageUrl(entry.url))
    }
    if (!video && collected.videos.length) {
      video = collected.videos.find((entry) => /play|video|aweme|tos-cn/i.test(entry.url)) || collected.videos[0]
    }
    if (!title) {
      title = parsed?.title || parsed?.desc || parsed?.seoInfo?.title || ''
    }
    if (video || images.length) break
  }

  if (!images.length && !video) {
    const allUrls = Array.from(new Set(String(html).match(/https?:\/\/[^"'\\\s<>]+/g) || []))
    images = dedupeMediaItems(
      allUrls
        .map((item) => item.replace(/\\u002F/g, '/'))
        .filter((item) => isAllowedDouyinImageUrl(item))
        .map((item) => ({ url: item, contentType: inferImageContentType(item) })),
    )
    const videoUrl = allUrls
      .map((item) => normalizeDouyinVideoUrl(item))
      .sort((a, b) => scoreDouyinVideoUrl(b) - scoreDouyinVideoUrl(a))
      .find((item) => /play|video|aweme|bytevc|tos-cn/i.test(item.toLowerCase()))
    if (videoUrl) {
      video = { url: videoUrl, contentType: 'video/mp4' }
    }
  }

  if (images.length > DOUYIN_GALLERY_MAX_IMAGES) {
    console.error(`[Video] request-extract abort: 刮到 ${images.length} 张图，远超图集上限，判定为垃圾结果`)
    throw new Error('douyin page request failed: extracted media looks like a feed page, not an aweme')
  }

  if (!images.length && !video) {
    throw new Error('request extraction did not find usable douyin media')
  }

  const result = buildDouyinAnalyzeResult({
    title,
    url: finalUrl,
    video,
    audio: null,
    images,
    source: 'request-extract',
  })
  setDouyinAnalyzeCache(finalUrl, result)
  return result
}

async function analyzeViaBrowserAutomation(_url) {
  throw new Error('browser automation fallback is currently disabled on this server')
}

function buildCommonArgs(url, options = {}) {
  const platform = detectPlatform(url)
  const cookiesMeta = getCookiesMeta(platform)
  const {
    socketTimeout = 30,
    concurrentFragments = 1,
    includeRetrySleep = true,
  } = options

  const args = [
    '--user-agent',
    DESKTOP_UA,
    '--extractor-retries',
    '5',
    '--retries',
    '5',
    '--file-access-retries',
    '5',
    '--fragment-retries',
    '5',
    '--socket-timeout',
    String(socketTimeout),
    '--concurrent-fragments',
    String(concurrentFragments),
    '--no-playlist',
    '--encoding',
    'utf-8',
  ]

  if (includeRetrySleep) {
    args.push('--retry-sleep', 'http:2')
    args.push('--retry-sleep', 'fragment:2')
  }

  if (options.customCookiePath) {
    args.push('--cookies', options.customCookiePath)
  } else if (cookiesMeta.active?.usable) {
    args.push('--cookies', cookiesMeta.active.path)
  }

  if (platform === 'bilibili') {
    args.push('--add-header', 'Referer:https://www.bilibili.com')
    args.push('--add-header', 'Origin:https://www.bilibili.com')
  } else if (platform === 'douyin') {
    args.push('--add-header', 'Referer:https://www.douyin.com')
    args.push('--add-header', 'Origin:https://www.douyin.com')
  } else if (platform === 'youtube') {
    args.push('--add-header', 'Referer:https://www.youtube.com')
    args.push('--add-header', 'Origin:https://www.youtube.com')
  }

  return {
    args,
    platform,
    cookiesMeta,
  }
}

function buildCookieHint(platform, cookiesMeta) {
  const active = cookiesMeta?.active
  const fallback = PLATFORM_COOKIE_FILES[platform] || DEFAULT_COOKIES_PATH

  if (active?.usable && active.invalidCount > 0) {
    return `已自动忽略 ${active.invalidCount} 行无效 cookies；如果仍失败，请重新导出 ${platform} 的最新 cookies 到 ${active.path}。`
  }

  if (active?.usable) {
    return `当前正在使用 ${active.path}；如果仍失败，请重新导出 ${platform} 的最新 cookies。`
  }

  if (active?.invalidCount > 0) {
    return `当前 cookies 文件格式不完整，已过滤无效行，但仍没有可用 cookies。请重新导出 ${platform} 的 Netscape 格式 cookies 到 ${fallback}。`
  }

  return `当前未检测到可用的 cookies 文件，请将 ${platform} 的 Netscape 格式 cookies 导出到 ${fallback}。`
}

function normalizeVideoError(errorMessage, url, cookiesMeta) {
  const message = String(errorMessage || '')
  const platform = detectPlatform(url)
  const cookieHint = buildCookieHint(platform, cookiesMeta)

  if (message.includes('服务器未安装 yt-dlp')) {
    return '服务器未安装 yt-dlp。'
  }

  if (/timeout/i.test(message)) {
    return '解析超时，目标站点响应过慢或当前服务器负载较高。'
  }

  if (/invalid netscape format cookies file/i.test(message) || /http\.cookiejar bug/i.test(message)) {
    return `cookies 文件格式不符合 Netscape 规范。${cookieHint}`
  }

  if (platform === 'bilibili' && (message.includes('HTTP Error 412') || message.includes('Precondition Failed'))) {
    return `B站拒绝了当前抓取请求（HTTP 412）。通常需要新的 B站 cookies。${cookieHint}`
  }

  if (platform === 'douyin' && /unable to extract douyin aweme id/i.test(message)) {
    return '这条分享链接没能定位到具体作品（短链跳转失败或链接里不含作品 ID）。请重试一次；若仍失败，请在抖音里打开作品后复制「分享 → 复制链接」再试。'
  }

  if (platform === 'douyin' && /short link resolve failed|did not land on an aweme page/i.test(message)) {
    return '抖音这次没能返回作品数据（多半是这次抽到的出口 IP 被限流，不是作品下架）。请隔几秒重试；连续多次失败就等几分钟再试。'
  }

  if (platform === 'douyin' && /403|forbidden|fresh cookies/i.test(message)) {
    return '抖音拒绝了这次请求（出口 IP 被判可疑，不是作品下架）。请隔几秒重试一次，通常第二次就会成功。'
  }

  if (platform === 'douyin' && /cookies/i.test(message)) {
    return `抖音解析被拒绝。${cookieHint}`
  }

  if (platform === 'douyin' && /did not find usable douyin media|douyin page request failed/i.test(message)) {
    return '抖音这次没能返回作品数据（出口 IP 被限流或页面被弹回，不是作品下架）。请隔几秒重试；连续多次失败就等几分钟再试。'
  }

  if (message.startsWith('DOUYIN_WORK_UNAVAILABLE:')) {
    const reason = message.slice('DOUYIN_WORK_UNAVAILABLE:'.length).trim()
    if (/status_self_see/i.test(reason) || /删除/.test(reason)) {
      return '该作品已被作者删除或设为私密，无法解析。'
    }
    return `该作品当前不可见（${reason}），无法解析。`
  }

  if (
    platform === 'youtube' &&
    (/sign in|confirm your age|bot|cookies|429|too many requests/i.test(message))
  ) {
    return `YouTube 当前请求受限，可能需要 cookies、代理或降低频率。${cookieHint}`
  }

  if (/unsupported url/i.test(message)) {
    return '暂不支持这个分享链接，请先确认链接可直接在浏览器打开。'
  }

  return message || '未知错误'
}

function runYtDlp(args, options = {}) {
  const { timeoutMs = 30000, ...spawnOptions } = options

  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', args, spawnOptions)
    let stdout = ''
    let stderr = ''
    let finished = false

    const finish = (fn, value) => {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      fn(value)
    }

    const timer = timeoutMs
      ? setTimeout(() => {
          try {
            proc.kill('SIGKILL')
          } catch {
            // ignore
          }
          finish(reject, new Error(`yt-dlp timeout after ${timeoutMs}ms`))
        }, timeoutMs)
      : null

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('error', (error) => {
      if (error.code === 'ENOENT') {
        finish(reject, new Error('服务器未安装 yt-dlp'))
        return
      }
      finish(reject, error)
    })

    proc.on('close', (code) => {
      if (code === 0) {
        finish(resolve, { stdout, stderr })
      } else {
        finish(reject, new Error(stderr.trim().slice(0, 2000) || `yt-dlp 退出码 ${code}`))
      }
    })
  })
}

function normalizeAnalyzeFormats(rawFormats) {
  const videoFormats = (rawFormats || [])
    .filter((item) => item.vcodec !== 'none')
    .map((item) => ({
      formatId: item.format_id,
      quality: item.format_note || item.resolution || (item.height ? `${item.height}p` : '未知清晰度'),
      ext: item.ext || 'mp4',
      filesize: item.filesize ? `${(item.filesize / 1024 / 1024).toFixed(1)} MB` : '大小未知',
      hasAudio: Boolean(item.acodec && item.acodec !== 'none'),
      mediaType: 'video',
      directUrl: '',
      audioUrl: '',
    }))

  const audioFormats = (rawFormats || [])
    .filter((item) => item.vcodec === 'none' && item.acodec && item.acodec !== 'none')
    .map((item) => ({
      formatId: `audio-${item.format_id}`,
      quality: item.format_note || item.format || item.ext || '仅音频',
      ext: item.ext || 'm4a',
      filesize: item.filesize ? `${(item.filesize / 1024 / 1024).toFixed(1)} MB` : '大小未知',
      hasAudio: true,
      mediaType: 'audio',
      directUrl: '',
      audioUrl: '',
      sourceFormatId: item.format_id,
    }))

  return [...videoFormats, ...audioFormats]
}

function createTempDownloadDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lcyksp-video-'))
}

function cleanupTempDir(dirPath) {
  if (!dirPath) return
  try {
    fs.rmSync(dirPath, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

function sanitizeFilename(name) {
  return String(name || 'download')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'download'
}

function getContentTypeByExtension(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase()
  return VIDEO_CONTENT_TYPES[ext] || AUDIO_CONTENT_TYPES[ext] || IMAGE_CONTENT_TYPES[ext] || 'application/octet-stream'
}

function buildDownloadDisposition(fileName, ext = '') {
  const safeBase = sanitizeFilename(fileName)
  const normalizedExt = ext.startsWith('.') || !ext ? ext : `.${ext}`
  const finalName = `${safeBase}${normalizedExt}`
  const asciiName = finalName.replace(/[^\x20-\x7E]/g, '_')
  const encoded = encodeURIComponent(finalName)
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encoded}`
}

async function streamDirectMediaDownload({ mediaUrl, title, res, contentType, customCookieHeader }) {
  const platform = detectPlatform(mediaUrl)
  const cookiesMeta = getCookiesMeta(platform)
  const cookieHeader = customCookieHeader || buildCookieHeader(cookiesMeta)
  const response = await fetch(mediaUrl, {
    headers: {
      'User-Agent': DESKTOP_UA,
      Referer: platform === 'bilibili' ? 'https://www.bilibili.com/' : 'https://www.douyin.com/',
      Origin: platform === 'bilibili' ? 'https://www.bilibili.com' : 'https://www.douyin.com',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    redirect: 'follow',
  })

  if (!response.ok || !response.body) {
    throw new Error(`直链下载失败: HTTP ${response.status}`)
  }

  const finalUrl = response.url || mediaUrl
  const ext = inferExtensionFromUrl(finalUrl, contentType?.startsWith('image/') ? 'jpg' : 'mp4')
  res.setHeader('Content-Type', contentType || response.headers.get('content-type') || getContentTypeByExtension(`file.${ext}`))
  res.setHeader('Content-Disposition', buildDownloadDisposition(title || 'download', ext))
  const contentLength = response.headers.get('content-length')
  if (contentLength) {
    res.setHeader('Content-Length', contentLength)
  }

  await new Promise((resolve, reject) => {
    const stream = Readable.fromWeb(response.body)
    stream.on('error', reject)
    res.on('close', resolve)
    res.on('finish', resolve)
    stream.pipe(res)
  })
}

/**
 * 把远端响应体读进内存，但带硬上限。
 * 原来直接 response.arrayBuffer()，对方给多大就吃多大——一个链接就能把 2G 机器打穿。
 */
async function readBodyWithLimit(response, limit = MAX_REMOTE_IMAGE_BYTES) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error(`图片体积 ${(declared / 1024 / 1024).toFixed(1)}MB 超过 ${limit / 1024 / 1024}MB 上限`)
  }

  const chunks = []
  let received = 0
  for await (const chunk of response.body) {
    received += chunk.length
    if (received > limit) {
      // 主动断开，别把剩下的也拉完
      try { await response.body.cancel?.() } catch { /* ignore */ }
      throw new Error(`图片体积超过 ${limit / 1024 / 1024}MB 上限`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** 取一张抖音图片并统一转成 JPEG（图集打包与单张下载共用）。注意：媒体链路不走代理，零池 IP 消耗。 */
async function fetchDouyinImageAsJpeg(mediaUrl) {
  const cookiesMeta = getCookiesMeta('douyin')
  const cookieHeader = buildCookieHeader(cookiesMeta)
  const response = await fetch(mediaUrl, {
    headers: {
      'User-Agent': DESKTOP_UA,
      Referer: 'https://www.douyin.com/',
      Origin: 'https://www.douyin.com',
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
  })

  if (!response.ok || !response.body) {
    throw new Error(`图片下载失败: HTTP ${response.status}`)
  }

  return sharp(await readBodyWithLimit(response)).jpeg({ quality: 92, mozjpeg: true }).toBuffer()
}

async function streamDirectImageAsJpeg({ mediaUrl, title, res }) {
  const jpegBuffer = await fetchDouyinImageAsJpeg(mediaUrl)

  res.setHeader('Content-Type', 'image/jpeg')
  res.setHeader('Content-Disposition', buildDownloadDisposition(title || 'download', '.jpg'))
  res.setHeader('Content-Length', jpegBuffer.length)
  res.end(jpegBuffer)
}

async function proxyImagePreview({ mediaUrl, res, customCookieHeader }) {
  const cookiesMeta = getCookiesMeta('douyin')
  const cookieHeader = customCookieHeader || buildCookieHeader(cookiesMeta)
  const response = await fetch(mediaUrl, {
    headers: {
      'User-Agent': DESKTOP_UA,
      Referer: 'https://www.douyin.com/',
      Origin: 'https://www.douyin.com',
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    redirect: 'follow',
  })

  if (!response.ok || !response.body) {
    throw new Error(`图片预览失败: HTTP ${response.status}`)
  }

  const jpegBuffer = await sharp(await readBodyWithLimit(response)).jpeg({ quality: 92, mozjpeg: true }).toBuffer()
  res.setHeader('Content-Type', 'image/jpeg')
  res.setHeader('Cache-Control', 'public, max-age=300')
  res.setHeader('Content-Length', jpegBuffer.length)
  res.end(jpegBuffer)
}

/** ffmpeg 失败时 stderr 开头是十几行版本/编译横幅，真正的报错在结尾——只把有意义的尾部当错误抛出去。 */
function ffmpegErrorText(stderr, fallback = '') {
  const banner = /^(ffmpeg version|built with|configuration|libav\S*|libsw\S*|compiler|gcc|clang)/i
  const lines = String(stderr || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !banner.test(line))
  const meaningful = lines.slice(-3).join(' | ')
  return (meaningful || String(stderr || '').trim()).slice(0, 300) || fallback
}

async function extractDirectAudioToResponse({ mediaUrl, title, tempDir, res, customCookieHeader }) {
  const inputPath = path.join(tempDir, 'input-video.mp4')
  const outputPath = path.join(tempDir, 'output-audio.mp3')

  await downloadToFile(mediaUrl, inputPath, 'video/mp4', customCookieHeader)

  await new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', '-i', inputPath, '-vn', '-acodec', 'libmp3lame', outputPath])
    let stderr = ''

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('error', (error) => {
      if (error.code === 'ENOENT') {
        reject(new Error('服务器未安装 ffmpeg，暂时无法提取音频。'))
        return
      }
      reject(error)
    })

    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(ffmpegErrorText(stderr, `ffmpeg 退出码 ${code}`)))
    })
  })

  res.setHeader('Content-Type', 'audio/mpeg')
  res.setHeader('Content-Disposition', buildDownloadDisposition(title || 'download', '.mp3'))
  res.setHeader('Content-Length', fs.statSync(outputPath).size)
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(outputPath)
    stream.on('error', reject)
    res.on('close', resolve)
    res.on('finish', resolve)
    stream.pipe(res)
  })
}

async function downloadToFile(url, filePath, contentTypeHint, customCookieHeader) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': DESKTOP_UA,
      Referer: 'https://www.douyin.com/',
      Origin: 'https://www.douyin.com',
      ...(customCookieHeader ? { Cookie: customCookieHeader } : {})
    },
    redirect: 'follow',
  })

  if (!response.ok || !response.body) {
    throw new Error(`资源下载失败: HTTP ${response.status}`)
  }

  await new Promise((resolve, reject) => {
    const stream = Readable.fromWeb(response.body)
    const writer = fs.createWriteStream(filePath)
    stream.on('error', reject)
    writer.on('error', reject)
    writer.on('finish', resolve)
    stream.pipe(writer)
  })

  return {
    contentType: contentTypeHint || response.headers.get('content-type') || 'application/octet-stream',
    finalUrl: response.url || url,
  }
}

async function mergeBrowserVideoAudioToResponse({ videoUrl, audioUrl, title, tempDir, res, customCookieHeader }) {
  if (!audioUrl || audioUrl === videoUrl) {
    await streamDirectMediaDownload({ mediaUrl: videoUrl, title, res, contentType: 'video/mp4', customCookieHeader })
    return
  }

  const videoPath = path.join(tempDir, 'video.mp4')
  const audioPath = path.join(tempDir, 'audio.m4a')
  const outputPath = path.join(tempDir, 'merged.mp4')

  await downloadToFile(videoUrl, videoPath, 'video/mp4', customCookieHeader)
  await downloadToFile(audioUrl, audioPath, 'audio/mp4', customCookieHeader)

  await new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', '-i', videoPath, '-i', audioPath, '-c', 'copy', outputPath])
    let stderr = ''

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('error', (error) => {
      if (error.code === 'ENOENT') {
        reject(new Error('服务器未安装 ffmpeg，暂时无法合并分离的视频和音频。'))
        return
      }
      reject(error)
    })

    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(ffmpegErrorText(stderr, `ffmpeg 退出码 ${code}`)))
    })
  })

  res.setHeader('Content-Type', 'video/mp4')
  res.setHeader('Content-Disposition', buildDownloadDisposition(title || 'download', '.mp4'))
  res.setHeader('Content-Length', fs.statSync(outputPath).size)
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(outputPath)
    stream.on('error', reject)
    res.on('close', resolve)
    res.on('finish', resolve)
    stream.pipe(res)
  })
}

// 对外只暴露「配没配好」，绝不暴露 content（cookie 原文）与 path（服务器绝对路径）
function publicCookieStatus(meta) {
  return {
    exists: Boolean(meta?.exists),
    usable: Boolean(meta?.usable),
    validCount: Number(meta?.validCount || 0),
    invalidCount: Number(meta?.invalidCount || 0),
    invalidReasons: Array.isArray(meta?.invalidReasons) ? meta.invalidReasons : [],
  }
}

router.get('/status', (_req, res) => {
  const bilibiliMeta = getCookiesMeta('bilibili')
  const douyinMeta = getCookiesMeta('douyin')
  const youtubeMeta = getCookiesMeta('youtube')

  res.json({
    success: true,
    data: {
      ytDlpCommand: 'yt-dlp',
      cookies: {
        default: publicCookieStatus(sanitizeCookieFile(DEFAULT_COOKIES_PATH)),
        bilibili: publicCookieStatus(bilibiliMeta.active),
        douyin: publicCookieStatus(douyinMeta.active),
        youtube: publicCookieStatus(youtubeMeta.active),
      },
    },
  })
})

// 管理员查看抖音出口网关探测状态
router.get('/gate-state', requireAdmin, (req, res) => {
  res.json({ success: true, ...getDouyinGateState() })
})

// 管理员读取抖音解析出口配置（池列表 + 余量 + 直连额度；提取链接一律脱敏返回）
router.get('/pool-config', requireAdmin, async (req, res, next) => {
  try {
    const snapshot = await getPoolSnapshot({ force: req.query.refresh === '1', forceConfig: req.query.refresh === '1' })
    const budget = await directBudgetState()
    const first = snapshot.pools[0]
    res.json({
      success: true,
      configured: snapshot.pools.length > 0,
      source: snapshot.source,
      extractUrlMasked: first ? first.urlMasked : '',
      ttlMs: first ? first.ttlMs : 0,
      pools: snapshot.pools,
      activePoolId: snapshot.activePoolId,
      lowBalanceThreshold: snapshot.lowBalanceThreshold,
      probeIntervalMs: DOUYIN_GATE_PROBE_INTERVAL_MS,
      directBudgetWindowMs: DIRECT_WINDOW_MS,
      directBudget: budget,
      gate: getDouyinGateState(),
    })
  } catch (err) {
    next(err)
  }
})

// 管理员保存抖音解析出口配置（旧单链接表单：更新第一个池；没有任何池时写旧配置键）
router.post('/pool-config', requireAdmin, async (req, res, next) => {
  try {
    const { extractUrl, ttlMs } = req.body || {}
    const url = String(extractUrl || '').trim()
    if (!/^https?:\/\/.+/i.test(url) || url.length > 2000) {
      return res.status(400).json({ error: '提取链接必须是合法的 http(s) 地址（长度 ≤ 2000）' })
    }
    const ttl = Number(ttlMs) || 60000
    if (ttl < 30 * 1000 || ttl > 3600 * 1000) {
      return res.status(400).json({ error: 'IP 时效超出允许范围（30 秒 - 60 分钟）' })
    }
    await upsertPrimaryPool({ extractUrl: url, ttlMs: ttl })
    res.json({ success: true, message: '已保存，新提取链接立即生效' })
  } catch (err) {
    if (err?.message && /不存在|必须|超出允许范围|trade_no/.test(err.message)) {
      return res.status(400).json({ error: err.message })
    }
    next(err)
  }
})

// 多池管理：add / update / delete / activate / refresh / reset-budget / set-threshold
router.post('/pools', requireAdmin, async (req, res, next) => {
  const action = String(req.body?.action || '')
  try {
    switch (action) {
      case 'add': {
        const id = await addPool(req.body || {})
        return res.json({ success: true, id, message: '池已添加，提取链接与业务 key 已加密保存' })
      }
      case 'update': {
        await updatePool(req.body || {})
        return res.json({ success: true, message: '池已更新' })
      }
      case 'delete': {
        await deletePool(String(req.body?.id || ''))
        return res.json({ success: true, message: '池已删除' })
      }
      case 'activate': {
        const pool = await setActivePool(String(req.body?.id || ''))
        return res.json({ success: true, message: `已把「${pool.name}」设为当前池` })
      }
      case 'refresh': {
        const snapshot = await getPoolSnapshot({ force: true, forceConfig: true })
        return res.json({ success: true, ...snapshot })
      }
      case 'reset-budget': {
        await resetDirectBudget()
        return res.json({ success: true, directBudget: await directBudgetState(), message: '直连额度已重置，下一次解析会重新使用服务器 IP' })
      }
      case 'set-threshold': {
        const value = await writeLowBalanceThreshold(req.body?.threshold)
        return res.json({ success: true, lowBalanceThreshold: value, message: '余量预警阈值已保存' })
      }
      default:
        return res.status(400).json({ error: '未知操作' })
    }
  } catch (err) {
    if (err?.message && /不存在|必须|超出允许范围|trade_no/.test(err.message)) {
      return res.status(400).json({ error: err.message })
    }
    next(err)
  }
})

// 管理员手动测试池出口：强制走池（不占用直连额度），可指定某个池
router.post('/pool-test', requireAdmin, async (req, res) => {
  try {
    const t0 = Date.now()
    const poolId = String(req.body?.poolId || '')
    if (!(await poolEnabled())) {
      return res.status(400).json({ success: false, error: '动态池未配置提取链接，无法测试' })
    }
    let proxyUrl = ''
    try {
      proxyUrl = await getPoolProxy(poolId ? { poolId } : {})
    } catch (err) {
      return res.status(502).json({ success: false, error: `池提取失败：${String(err?.message || err).slice(0, 120)}` })
    }
    const response = await douyinFetch(
      'https://myip.ipip.net',
      { headers: { 'User-Agent': DESKTOP_UA }, signal: AbortSignal.timeout(20000) },
      { forcePool: true, poolId }
    )
    const text = (await response.text()).replace(/\s+/g, ' ').trim()
    res.json({
      success: response.ok,
      exit: text.slice(0, 140),
      elapsedMs: Date.now() - t0,
      proxyUrl: String(proxyUrl || '').replace(/\//g, ''),
      poolId,
    })
  } catch (err) {
    res.status(502).json({ success: false, error: `池出口测试失败：${String(err?.message || err).slice(0, 120)}` })
  }
})

// 管理员立即触发一轮出口探测（顺带查池余量，低于阈值会发预警邮件）
router.post('/gate-probe', requireAdmin, async (req, res) => {
  try {
    await runDouyinGateCycle()
  } catch { /* 内部已记录 */ }
  let balanceCheck = null
  try {
    balanceCheck = await getPoolSnapshot()
  } catch { /* 忽略 */ }
  res.json({ success: true, ...getDouyinGateState(), pools: balanceCheck?.pools || [], directBudget: await directBudgetState() })
})

// 说明：用户自定义 Cookie 功能已于 2026-09-15 整体下线（抖音解析靠自算签名 + 自动 ttwid + 住宅池，
// 不再需要用户自带 cookie；同时那是一个「填了 cookie 就不吃配额」的旁路）。
// 媒体/图片处理函数里仍保留可选的 customCookieHeader 形参（现在恒为未传），一律回退到服务器侧
// 平台 cookies（data/cookies.<platform>.txt）；user_cookies 表与历史数据未动、不写不读。

router.post('/analyze', heavyLimiter, async (req, res) => {
  const startedAt = Date.now()
  let { url } = req.body
  url = pickUrlFromText(url || '')

  if (!url) {
    return res.json({ success: false, message: '链接不能为空' })
  }
  if (!url.startsWith('http')) {
    return res.json({ success: false, message: '未检测到有效链接' })
  }

  const requestedPlatform = detectPlatform(url)
  if (requestedPlatform === 'youtube') {
    return res.json({ success: false, message: '当前暂仅支持抖音和 B站，YouTube 解析入口已暂时关闭。' })
  }

  // 防 SSRF：resolveShareUrl 会由服务端发起请求，先校验原始 URL
  try {
    await assertPublicUrl(url)
  } catch (err) {
    return res.json({ success: false, message: err.message || '链接不合法' })
  }

  try {
    // 平台 cookie（服务器侧 data/cookies.*.txt）由各取数函数自己按平台读取，这里不再有用户自定义 cookie
    const options = {}

    // 抖音：先并行把出口 IP / ttwid 预热起来，与后面的短链解析重叠，缩短整体耗时
    const quotaCheck = await enforceVideoQuota(req, ACTION_ANALYZE)
    if (!quotaCheck.allowed) {
      return res.status(429).json({
        success: false,
        message: quotaCheck.message,
        quota: quotaCheck.quota,
      })
    }

    // 抖音：配额通过后再预热出口 IP / ttwid——放在配额检查之前会在「配额不足直接返回」时白烧一个池 IP。
    // 预热与后面的短链解析重叠，缩短整体耗时。
    if (requestedPlatform === 'douyin') warmDouyinExit(url)

    console.error('[Video] analyze start:', { url, requestedPlatform })

    async function runDouyinPrimaryFlow(finalUrl, flowOptions = {}) {
      if (douyinAnalyzeInFlight && douyinAnalyzeInFlight.url === finalUrl) {
        const sharedResult = await douyinAnalyzeInFlight.promise
        return sharedResult
      }

      const promise = (async () => {
        try {
          console.error('[Video] trying douyin signed-api primary:', { finalUrl, elapsedMs: Date.now() - startedAt })
          const signedApiData = await analyzeDouyinViaSignedApi(finalUrl, { ...options, ...flowOptions })
          console.error('[Video] douyin signed-api primary ok:', {
            finalUrl,
            source: signedApiData?.source,
            formats: signedApiData?.formats?.length || 0,
            elapsedMs: Date.now() - startedAt,
          })
          return { data: signedApiData, message: '已通过抖音站内接口完成解析。' }
        } catch (signedApiError) {
          console.error('[Video] douyin signed-api primary failed:', signedApiError?.stack || signedApiError?.message || String(signedApiError))
          // 接口已权威判定作品不可用（被删/设私/权限受限）——无需再走页面提取与 yt-dlp，直接以准确文案终态返回
          if (signedApiError?.workUnavailable) throw signedApiError
        }

        try {
          console.error('[Video] trying douyin request-extract primary:', { finalUrl, elapsedMs: Date.now() - startedAt })
          const requestData = await analyzeDouyinViaRequest(finalUrl, options)
          console.error('[Video] douyin request-extract primary ok:', {
            finalUrl,
            source: requestData?.source,
            formats: requestData?.formats?.length || 0,
            elapsedMs: Date.now() - startedAt,
          })
          return { data: requestData, message: '已通过页面提取完成解析。' }
        } catch (requestError) {
          console.error('[Video] douyin request-extract primary failed:', requestError?.stack || requestError?.message || String(requestError))
        }

        const { args: douyinArgs } = buildCommonArgs(finalUrl, options)
        const args = [...douyinArgs, '--no-warnings', '--dump-single-json', finalUrl]
        console.error('[Video] trying douyin yt-dlp fallback:', {
          finalUrl,
          elapsedMs: Date.now() - startedAt,
        })

        const { stdout } = await runYtDlp(args, { timeoutMs: 8000 })
        const rawData = JSON.parse(stdout)
        const formats = normalizeAnalyzeFormats(rawData.formats)
        return {
          data: {
            title: rawData.title || '未知标题',
            thumbnail: rawData.thumbnail || '',
            directPreviewUrl: rawData.url || '',
            directPreviewType: rawData.url ? 'video' : '',
            webpageUrl: rawData.webpage_url || finalUrl,
            platform: detectPlatform(finalUrl),
            source: 'yt-dlp',
            formats: formats.reverse(),
          },
          message: '已通过兼容下载器完成解析。',
        }
      })()

      douyinAnalyzeInFlight = { url: finalUrl, promise }
      try {
        return await promise
      } finally {
        if (douyinAnalyzeInFlight?.url === finalUrl) {
          douyinAnalyzeInFlight = null
        }
      }
    }

    try {
      const finalUrl = await resolveShareUrl(url)
      console.error('[Video] analyze resolved url:', {
        url,
        finalUrl,
        elapsedMs: Date.now() - startedAt,
      })

      // 防 SSRF + 平台白名单：跳转后的目标也必须为公网抖音/B站链接
      try {
        await assertPublicUrl(finalUrl)
      } catch (err) {
        return res.json({ success: false, message: err.message || '链接不合法' })
      }
      if (!isAllowedPlatformUrl(finalUrl)) {
        return res.json({ success: false, message: '当前仅支持解析抖音和 B站链接' })
      }

      if (detectPlatform(finalUrl) === 'douyin') {
        const douyinResult = await runDouyinPrimaryFlow(finalUrl)
        return res.json({ success: true, data: douyinResult.data, message: douyinResult.message })
      }

      const { args: commonArgs } = buildCommonArgs(finalUrl, options)
      const args = [...commonArgs, '--no-warnings', '--dump-single-json', finalUrl]
      const analyzeTimeoutMs = detectPlatform(finalUrl) === 'bilibili' ? 20000 : 8000
      console.error('[Video] analyze yt-dlp start:', {
        finalUrl,
        timeoutMs: analyzeTimeoutMs,
        elapsedMs: Date.now() - startedAt,
      })

      const { stdout } = await runYtDlp(args, { timeoutMs: analyzeTimeoutMs })
      console.error('[Video] analyze yt-dlp ok:', {
        finalUrl,
        stdoutLength: stdout?.length || 0,
        elapsedMs: Date.now() - startedAt,
      })

      const rawData = JSON.parse(stdout)
      const formats = normalizeAnalyzeFormats(rawData.formats)

      return res.json({
        success: true,
        data: {
          title: rawData.title || '未知标题',
          thumbnail: rawData.thumbnail || '',
          directPreviewUrl: rawData.url || '',
          directPreviewType: rawData.url ? 'video' : '',
          webpageUrl: rawData.webpage_url || finalUrl,
          platform: detectPlatform(finalUrl),
          source: 'yt-dlp',
          formats: formats.reverse(),
        },
      })
    } catch (error) {
      const finalUrl = await resolveShareUrl(url)
      const { cookiesMeta } = buildCommonArgs(finalUrl, options)
      console.error('[Video] analyze catch:', {
        inputUrl: url,
        finalUrl,
        requestedPlatform,
        finalPlatform: detectPlatform(finalUrl),
        elapsedMs: Date.now() - startedAt,
        originalError: error?.message || String(error),
      })

      if (detectPlatform(finalUrl) === 'douyin') {
        try {
          // 第二轮回退：首轮已经拼过 4 个 IP 了，这里只再给 2 次，控制失败场景的 IP 消耗
          const douyinResult = await runDouyinPrimaryFlow(finalUrl, { signedApiMaxAttempts: 2 })
          return res.json({ success: true, data: douyinResult.data, message: douyinResult.message })
        } catch (douyinError) {
          const finalMessage = normalizeVideoError(douyinError?.message, finalUrl, cookiesMeta)
          console.error('[Video] douyin primary flow failed:', {
            finalUrl,
            finalMessage,
            elapsedMs: Date.now() - startedAt,
          })
          return res.json({
            success: false,
            message: `解析失败：${finalMessage}`,
          })
        }
      }

      const finalMessage = normalizeVideoError(error?.message, finalUrl, cookiesMeta)
      console.error('[Video] analyze failed:', {
        finalUrl,
        finalMessage,
        elapsedMs: Date.now() - startedAt,
      })
      return res.json({
        success: false,
        message: `解析失败：${finalMessage}`,
      })
    }
  } catch (err) {
    console.error('[Video] analyze outer error:', err)
    return res.json({ success: false, message: `解析异常：${err.message}` })
  }
})

/**
 * 图集多选打包下载：勾中的图片合成一个 ZIP，**整个压缩包只计 1 次下载额度**。
 * 旧的逐张循环实现会让 15 张图吃掉 15 次额度（免费用户 5 次/小时直接卡死），
 * 而且每次都要重走一遍请求。这里改成一次请求、一次计费，顺带更快。
 */
router.post('/download-album', heavyLimiter, async (req, res) => {
  let { url, title, items, source } = req.body || {}
  url = pickUrlFromText(url || '')

  if (!url || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: '参数不完整' })
  }

  const requestedPlatform = detectPlatform(url)
  if (requestedPlatform === 'youtube') {
    return res.status(400).json({ error: '当前暂仅支持抖音和 B站，YouTube 下载入口已暂时关闭。' })
  }

  try {
    await assertPublicUrl(url)
  } catch (err) {
    return res.status(400).json({ error: err.message || '链接不合法' })
  }

  const picked = items
    .map((item) => ({ formatId: String(item?.formatId || ''), mediaUrl: String(item?.directUrl || '').trim() }))
    .filter((item) => item.mediaUrl)

  if (!picked.length) return res.status(400).json({ error: '没有可下载的图片' })
  if (picked.length > MAX_ALBUM_IMAGES) {
    return res.status(400).json({ error: `一次最多打包 ${MAX_ALBUM_IMAGES} 张图片，请分批下载` })
  }
  // 防 SSRF：直链由前端回传，必须是抖音图片 CDN 白名单内的地址
  if (!picked.every((item) => isAllowedDouyinImageUrl(item.mediaUrl))) {
    return res.status(400).json({ error: '图片地址不合法' })
  }

  try {
    const quotaCheck = await enforceVideoQuota(req, ACTION_DOWNLOAD)
    if (!quotaCheck.allowed) {
      return res.status(429).json({ error: quotaCheck.message, quota: quotaCheck.quota })
    }

    const failedUrls = []
    const jpegBuffers = []
    let totalBytes = 0
    let refreshedUrls = null
    let refreshTried = false

    for (let index = 0; index < picked.length; index += 1) {
      const item = picked[index]
      let buffer = null
      try {
        buffer = await fetchDouyinImageAsJpeg(item.mediaUrl)
      } catch (error) {
        // 直链过期/被拒时只重解析一次（解析缓存命中＝零池 IP 消耗），之后仍失败就如实计入失败清单
        if (!refreshTried) {
          refreshTried = true
          refreshedUrls = await refreshDouyinAlbumImageUrls(url)
          console.error('[Video] 图集首张直链失败，尝试刷新直链后重试:', error?.message || String(error))
        }
        const fallbackUrl = refreshedUrls?.[index]
        if (!fallbackUrl) {
          failedUrls.push(item.formatId || String(index + 1))
          continue
        }
        try {
          buffer = await fetchDouyinImageAsJpeg(fallbackUrl)
        } catch (retryError) {
          console.error('[Video] 图集图片刷新后仍失败:', retryError?.message || String(retryError))
          failedUrls.push(item.formatId || String(index + 1))
          continue
        }
      }
      totalBytes += buffer.length
      if (totalBytes > MAX_ALBUM_TOTAL_BYTES) {
        return res.status(400).json({ error: '图集体积过大，请分批下载' })
      }
      jpegBuffers.push(buffer)
    }

    if (!jpegBuffers.length) {
      return res.status(502).json({ error: '图片全部下载失败，请稍后重试' })
    }

    const zipBuffer = buildZipStore(
      jpegBuffers.map((data, index) => ({ name: `第${String(index + 1).padStart(2, '0')}张.jpg`, data })),
    )

    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', buildDownloadDisposition(`${title || 'douyin-album'}_图集${jpegBuffers.length}张`, '.zip'))
    res.setHeader('Content-Length', zipBuffer.length)
    if (failedUrls.length) {
      // 前端读得到（同源），用于提示「有几张没打包进去」
      res.setHeader('X-Lcyksp-Failed-Images', String(failedUrls.length))
      res.setHeader('Access-Control-Expose-Headers', 'X-Lcyksp-Failed-Images')
    }
    console.log(`[Video] 图集打包完成: ${jpegBuffers.length}/${picked.length} 张, ${(zipBuffer.length / 1024 / 1024).toFixed(2)}MB`)
    res.end(zipBuffer)
  } catch (err) {
    console.error('[Video] download-album error:', err)
    if (!res.headersSent) {
      return res.status(500).json({ error: `图集下载失败：${err.message}` })
    }
    res.end()
  }
})

router.post('/download', heavyLimiter, async (req, res) => {
  let { url, formatId, title, browserDirectUrl, browserAudioUrl, source } = req.body
  url = pickUrlFromText(url || '')

  if (!url || !formatId) {
    return res.status(400).json({ error: '参数不完整' })
  }

  const requestedPlatform = detectPlatform(url)
  if (requestedPlatform === 'youtube') {
    return res.status(400).json({ error: '当前暂仅支持抖音和 B站，YouTube 下载入口已暂时关闭。' })
  }

  // 防 SSRF：resolveShareUrl 会由服务端发起请求，先校验原始 URL
  try {
    await assertPublicUrl(url)
  } catch (err) {
    return res.status(400).json({ error: err.message || '链接不合法' })
  }

  let tempDir = ''
  try {
    const quotaCheck = await enforceVideoQuota(req, ACTION_DOWNLOAD)
    if (!quotaCheck.allowed) {
      return res.status(429).json({
        error: quotaCheck.message,
        quota: quotaCheck.quota,
      })
    }

    const finalUrl = await resolveShareUrl(url)

    // 防 SSRF + 平台白名单：跳转后的目标也必须为公网抖音/B站链接
    try {
      await assertPublicUrl(finalUrl)
    } catch (err) {
      return res.status(400).json({ error: err.message || '链接不合法' })
    }
    if (!isAllowedPlatformUrl(finalUrl)) {
      return res.status(400).json({ error: '当前仅支持解析抖音和 B站链接' })
    }

    // 抖音走不通 yt-dlp，前端没回传直链、或直链来自 yt-dlp 兜底时，由服务端自己签名解析
    if (detectPlatform(finalUrl) === 'douyin' && (!browserDirectUrl || !source || source === 'yt-dlp')) {
      const resolved = await resolveDouyinDownloadTarget(finalUrl, formatId)
      if (resolved) {
        formatId = resolved.formatId
        browserDirectUrl = resolved.directUrl
        browserAudioUrl = resolved.audioUrl
        source = 'signed-api'
      }
    }

    if (source && source !== 'yt-dlp' && browserDirectUrl) {
      tempDir = createTempDownloadDir()
      if ((source === 'browser-automation' || source === 'request-extract') && formatId === 'browser-video' && browserAudioUrl) {
        await mergeBrowserVideoAudioToResponse({
          videoUrl: browserDirectUrl,
          audioUrl: browserAudioUrl,
          title: title || 'douyin-download',
          tempDir,
          res,
        })
      } else if (formatId === 'browser-audio' || formatId === 'direct-audio') {
        await extractDirectAudioToResponse({
          mediaUrl: browserAudioUrl || browserDirectUrl,
          title: title || 'douyin-audio',
          tempDir,
          res,
        })
      } else if (formatId.startsWith('image-')) {
        await streamDirectImageAsJpeg({
          mediaUrl: browserDirectUrl,
          title: title || 'douyin-image',
          res,
        })
      } else {
        const contentType = formatId.startsWith('image-')
          ? inferImageContentType(browserDirectUrl)
          : formatId.startsWith('audio-')
            ? 'audio/mpeg'
            : 'video/mp4'
        await streamDirectMediaDownload({
          mediaUrl: browserDirectUrl,
          title: title || 'douyin-download',
          res,
          contentType,
        })
      }
      return
    }

    const platform = detectPlatform(finalUrl)
    const { args: commonArgs } = buildCommonArgs(finalUrl, {
      socketTimeout: platform === 'bilibili' ? 45 : 30,
      concurrentFragments: platform === 'bilibili' ? 2 : 1,
    })
    tempDir = createTempDownloadDir()
    const isAudioOnly = String(formatId).startsWith('audio-')
    const normalizedFormatId = isAudioOnly ? String(formatId).replace(/^audio-/, '') : formatId
    const outputTemplate = path.join(tempDir, isAudioOnly ? 'audio.%(ext)s' : 'video.%(ext)s')
    const args = [...commonArgs, '--no-warnings', '--force-overwrites']

    if (isAudioOnly) {
      args.push('-f', normalizedFormatId, '-o', outputTemplate, finalUrl)
    } else {
      args.push('--continue')
      if (platform !== 'bilibili') {
        args.push('--no-part', '--downloader', 'native')
      }
      args.push(
        '-f',
        `${normalizedFormatId}+bestaudio/best`,
        '--merge-output-format',
        'mp4',
        '-o',
        outputTemplate,
        finalUrl,
      )
    }

    await runYtDlp(args, { timeoutMs: platform === 'bilibili' ? 1800000 : 1200000 })

    const files = fs.readdirSync(tempDir)
    const targetFile =
      files.find((file) => file.endsWith('.mp4')) ||
      files.find((file) => file.endsWith('.mkv')) ||
      files.find((file) => file.endsWith('.webm')) ||
      files.find((file) => file.endsWith('.m4a')) ||
      files.find((file) => file.endsWith('.mp3')) ||
      files.find((file) => file.endsWith('.aac')) ||
      files.find((file) => file.endsWith('.ogg')) ||
      files.find((file) => file.endsWith('.jpg')) ||
      files.find((file) => file.endsWith('.png')) ||
      files.find((file) => file.endsWith('.webp'))

    if (!targetFile) {
      throw new Error('下载完成但未找到输出文件')
    }

    const absFile = path.join(tempDir, targetFile)
    const safeTitle = sanitizeFilename(title || path.parse(targetFile).name)
    const ext = path.extname(targetFile) || '.mp4'
    res.setHeader('Content-Type', getContentTypeByExtension(targetFile))
    res.setHeader('Content-Disposition', buildDownloadDisposition(safeTitle, ext))
    const fileSize = fs.statSync(absFile).size
    res.setHeader('Content-Length', fileSize)

    const stream = fs.createReadStream(absFile)
    let hasError = false
    stream.on('error', () => {
      hasError = true
      if (!res.headersSent) {
        res.status(500).json({ error: '读取下载文件失败' })
      } else if (!res.writableEnded) {
        res.end()
      }
    })
    stream.on('close', () => {
      cleanupTempDir(tempDir)
      tempDir = ''
    })
    stream.pipe(res)
  } catch (error) {
    cleanupTempDir(tempDir)
    const finalUrl = await resolveShareUrl(url)
    const { cookiesMeta } = buildCommonArgs(finalUrl)
    console.error('[Video] download raw error:', error?.stack || error?.message || String(error))
    const finalMessage = normalizeVideoError(error.message, finalUrl, cookiesMeta)
    console.error('[Video] download failed:', finalMessage)
    if (!res.headersSent) {
      res.status(500).json({ error: `下载失败：${finalMessage}` })
    } else if (!res.writableEnded) {
      res.end()
    }
  }
})

router.get('/preview-image', previewLimiter, async (req, res) => {
  try {
    const mediaUrl = String(req.query.url || '').trim()
    if (!/^https?:\/\//i.test(mediaUrl)) {
      return res.status(400).json({ error: '无效的图片地址' })
    }

    // 防 SSRF：图片代理不得访问内网地址
    try {
      await assertPublicUrl(mediaUrl)
    } catch (err) {
      return res.status(400).json({ error: err.message || '无效的图片地址' })
    }

    await proxyImagePreview({ mediaUrl, res })
  } catch (error) {
    console.error('[Video] preview-image failed:', error?.stack || error?.message || String(error))
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || '图片预览失败' })
    }
  }
})

export default router

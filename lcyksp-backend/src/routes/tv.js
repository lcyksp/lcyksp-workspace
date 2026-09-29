import { Router } from 'express'
import { createHash, randomBytes } from 'crypto'
import { spawn, execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import dns from 'dns/promises'
import net from 'net'
import { authMiddleware, requireAuth } from '../middleware/auth.js'
import { heavyLimiter } from '../middleware/rateLimit.js'
import { ACTION_ANALYZE, ACTION_DOWNLOAD, buildQuotaExceededMessage, consumeQuota } from '../utils/quota.js'
import { getClientIp } from '../utils/turnstile.js'
import { logDownload } from '../utils/logger.js'

var router = Router()
router.use(authMiddleware)

async function enforceTvQuota(req, action) {
  const plan = req.user?.role === 'admin' ? 'admin' : req.user?.role === 'pro' ? 'pro' : req.user?.role === 'premium' || req.user?.quotaPlan === 'premium' ? 'premium' : 'free'
  const subjectKey = req.user?.userId ? `user:${req.user.userId}` : `ip:${getClientIp(req)}`
  const subjectType = req.user?.userId ? plan : 'guest'
  const result = await consumeQuota({
    subjectType,
    subjectKey,
    action,
    amount: 1,
  })

  if (!result.allowed) {
    return {
      allowed: false,
      message: buildQuotaExceededMessage(subjectType),
      quota: result,
    }
  }

  return {
    allowed: true,
    quota: result,
  }
}

const BASE_URL = 'https://h5.jianpianips1.com'
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 旧链路曾把整集 m3u8 抓下来合成 mp4 落盘到这里，再 res.download 转发；
// 新链路改为 ffmpeg 流式转发、全程不落盘。启动时一次性清掉历史遗留的落盘残片，
// 之后这个目录不再写入。
const LEGACY_TMP_ROOT = path.resolve(__dirname, '../../data/tv-downloads')
try {
  if (fs.existsSync(LEGACY_TMP_ROOT)) {
    fs.rmSync(LEGACY_TMP_ROOT, { recursive: true, force: true })
    console.log('[TV] 已清理旧版落盘下载的历史缓存目录')
  }
} catch (e) {
  console.error('[TV] 清理旧缓存目录失败:', e.message)
}

var _hasFfmpeg = null
function hasFfmpeg() {
  if (_hasFfmpeg !== null) return _hasFfmpeg
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' })
    _hasFfmpeg = true
  } catch {
    _hasFfmpeg = false
    console.log('[TV] ffmpeg 未安装')
  }
  return _hasFfmpeg
}

function extractIdFromUrl(url) {
  var match = url.match(/[?&]id=(\d+)/)
  if (match) return match[1]
  var hashMatch = url.match(/#.*[?&]id=(\d+)/)
  if (hashMatch) return hashMatch[1]
  var pureId = url.match(/\/(\d+)(?:\?|$)/)
  if (pureId) return pureId[1]
  return null
}

function buildSignedHeaders() {
  var timestamp = Math.floor(Date.now() / 1000)
  var signature = createHash('md5').update('600' + timestamp + BASE_URL).digest('hex')
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': BASE_URL + '/',
    'Origin': BASE_URL,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'version': '600',
    'timestamp': String(timestamp),
    'signature': signature
  }
}

function resolveUrl(base, relative) {
  if (!relative) return ''
  if (relative.startsWith('http://') || relative.startsWith('https://')) return relative
  try {
    return new URL(relative, base).href
  } catch {
    return relative
  }
}

function padNumber(n) {
  return n < 10 ? '0' + n : String(n)
}

function sanitizeFileName(name) {
  // 只做文件名安全：Windows 非法字符 + 控制字符 + 限长。
  // shell 注入已在调用侧根除（spawn 不经 shell），所以这里不过滤括号等字符，
  // 否则中文剧集名里的括号会被打成一串下划线。
  return (name || 'episode')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .trim() || 'episode'
}

// ---- 多源聚合搜索（maccms provide/vod）----
// 非凡之外再并联几个同类公开采集源：扩大命中面，也在某源挂/被墙时有备选线路。
// SSRF 护栏只拦内网 IP，这些公网源的 m3u8 CDN 天然放行。
const SEARCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const MACCMS_SOURCES = [
  { name: '非凡', api: 'http://cj.ffzyapi.com/api.php/provide/vod/' },
  { name: '量子', api: 'https://cj.lziapi.com/api.php/provide/vod/' },
  { name: '暴风', api: 'https://bfzyapi.com/api.php/provide/vod/' },
  { name: '极速', api: 'https://jszyapi.com/api.php/provide/vod/' },
  { name: '红牛', api: 'https://www.hongniuzy2.com/api.php/provide/vod/' },
]
const SEARCH_TIMEOUT_MS = 6000
const MAX_LINES_PER_SOURCE = 2
const MAX_TOTAL_LINES = 12

// 从一个 maccms 源搜关键词，返回 { title, cover, lines:[{name:'源名·线路',episodes:[{name,m3u8Url}],count}] }
async function searchOneSource(src, keyword) {
  const ctrl = new AbortController()
  const timer = setTimeout(function () { ctrl.abort() }, SEARCH_TIMEOUT_MS)
  try {
    const url = src.api + '?ac=detail&wd=' + encodeURIComponent(keyword)
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': SEARCH_UA } })
    if (!res.ok) return { title: '', cover: '', lines: [] }
    // 有的源返回 JSON 却把 Content-Type 标成 text/html，不能按 header 判；直接 parse，失败即视作挂了
    const text = await res.text()
    let json
    try { json = JSON.parse(text) } catch { return { title: '', cover: '', lines: [] } }
    const list = (json && json.list) || []
    if (!list.length) return { title: '', cover: '', lines: [] }
    const item =
      list.find(function (v) { return v.vod_name === keyword }) ||
      list.find(function (v) { return (v.vod_name || '').includes(keyword) }) ||
      list[0]
    const froms = (item.vod_play_from || '').split('$$$')
    const urls = (item.vod_play_url || '').split('$$$')
    const lines = []
    for (let i = 0; i < froms.length && lines.length < MAX_LINES_PER_SOURCE; i++) {
      const episodes = (urls[i] || '').split('#').map(function (epStr) {
        const parts = epStr.split('$')
        return { name: parts[0] || '第一集', m3u8Url: parts[1] || '' }
      }).filter(function (ep) { return /\.m3u8/i.test(ep.m3u8Url) })
      if (episodes.length) {
        lines.push({ name: src.name + '·' + (froms[i] || '线路'), episodes: episodes, count: episodes.length })
      }
    }
    return { title: item.vod_name || '', cover: item.vod_pic || '', lines: lines }
  } catch {
    return { title: '', cover: '', lines: [] }
  } finally {
    clearTimeout(timer)
  }
}

router.post('/analyze', heavyLimiter, async function (req, res, next) {
  try {
    var { url, sourceIndex } = req.body
    if (!url) return res.status(400).json({ error: '请提供视频网址、M3U8直链或剧集名称关键词' })

    const quotaCheck = await enforceTvQuota(req, ACTION_ANALYZE)
    if (!quotaCheck.allowed) {
      return res.status(429).json({
        success: false,
        error: quotaCheck.message,
        message: quotaCheck.message,
        quota: quotaCheck.quota,
      })
    }

    var isSearch = !url.startsWith('http://') && !url.startsWith('https://')
    var isDirectM3u8 = (url.startsWith('http://') || url.startsWith('https://')) && url.includes('.m3u8')

    if (isSearch) {
      // 1. 关键词搜索：并联多个 maccms 采集源，合并所有可用 m3u8 线路
      console.log('[TV] 多源搜索剧集关键词:', url)
      const settled = await Promise.allSettled(
        MACCMS_SOURCES.map(function (src) { return searchOneSource(src, url) }),
      )
      var title = ''
      var cover = ''
      var sources = []
      for (const r of settled) {
        if (r.status !== 'fulfilled') continue
        if (!title && r.value.title) { title = r.value.title; cover = r.value.cover }
        for (const line of r.value.lines) {
          if (sources.length >= MAX_TOTAL_LINES) break
          sources.push(line)
        }
      }
      if (sources.length === 0) {
        return res.status(404).json({ error: `未搜索到与 "${url}" 相关的可下载资源` })
      }
      console.log('[TV] 多源搜索成功:', title, '- 线路数', sources.length)
      return res.json({
        title: title || url,
        cover: cover,
        sourceName: sources[0].name,
        sourceCount: sources.length,
        sources: sources,
        episodes: sources[0].episodes,
      })
    }

    if (isDirectM3u8) {
      // 2. M3U8 直链解析模式
      console.log('[TV] 解析 M3U8 直链:', url)
      return res.json({
        title: 'M3U8 直链视频',
        cover: '',
        sourceName: '直链',
        sourceCount: 1,
        sources: [{ name: '直链', count: 1 }],
        episodes: [{ name: '第一集', m3u8Url: url }]
      })
    }

    // 3. 原原有 Jianpian H5 播放地址解析模式（保持向后兼容）
    var tvId = extractIdFromUrl(url)
    if (!tvId) return res.status(400).json({ error: '无法解析此网址，请粘贴正确的剧集网址、直链或剧名' })

    console.log('[TV] 解析 URL:', url, '=> ID:', tvId)

    var apiUrl = BASE_URL + '/api/video/detailv2?id=' + tvId
    var response = await fetch(apiUrl, { headers: buildSignedHeaders() })
    var json = await response.json()
    console.log('[TV] 上游 code:', json.code, 'msg:', json.msg)

    if (!json.data) {
      return res.status(502).json({ error: '上游数据为空: ' + (json.msg || '') })
    }

    var data = json.data
    var title = data.title || data.video_title || data.name || '未知剧名'
    var cover = data.thumbnail || data.cover_url || data.cover || ''
    if (cover && !cover.startsWith('http')) cover = BASE_URL + cover

    var sourceList = data.source_list_source || []
    if (sourceList.length === 0) return res.status(502).json({ error: '未找到可用的播放线路' })

    var freeSources = sourceList.filter(function (s) {
      return s.name && !s.name.includes('VIP') && !s.name.includes('蓝光')
    })
    var availableSources = freeSources.length > 0 ? freeSources : sourceList.filter(function (s) {
      return s.name && !s.name.includes('VIP')
    })
    if (availableSources.length === 0) availableSources = sourceList

    var idx = (typeof sourceIndex === 'number' && sourceIndex >= 0 && sourceIndex < availableSources.length)
      ? sourceIndex : 0
    var selectedSource = availableSources[idx]

    var episodes = (selectedSource.source_list || []).map(function (ep, index) {
      var resolvedUrl = resolveUrl(BASE_URL, ep.url || '')
      return {
        name: ep.source_name || ('第' + padNumber(index + 1) + '集'),
        m3u8Url: resolvedUrl
      }
    })

    console.log('[TV] 解析成功:', title, '-', episodes.length, '集', '- 线路:', selectedSource.name)

    res.json({
      title: title,
      cover: cover,
      sourceName: selectedSource.name,
      sourceCount: availableSources.length,
      sources: availableSources.map(function (s) { return { name: s.name, count: (s.source_list || []).length } }),
      episodes: episodes
    })
  } catch (err) {
    next(err)
  }
})

// ============================================================================
// 服务器流式代理（不落盘）
// ----------------------------------------------------------------------------
// 旧链路：服务器把整集 m3u8 抓完、合成 mp4 落盘、再 res.download 转发，在 2C2G 上
// 既吃 CPU（AAC 重编码）又吃磁盘。新链路：ffmpeg 直接读远程 m3u8，stdout 以分片 mp4
// 流式 pipe 给 HTTP 响应，全程不落盘、-c copy 不重编码。pipe 不可 seek → 只能用
// frag_keyframe+empty_moov 的分片 mp4，代价是无法断点续传（无 Range）。
// ============================================================================

const STREAM_CONCURRENCY_LIMIT = 2 // 2C2G 保守上限；-c copy 后 CPU 不再是瓶颈，压的是带宽
var activeStreams = 0

// 浏览器原生下载（<a download>）发不了 Authorization 头，auth.js 也禁止 ?token= 走鉴权。
// 这里用一次性短期票据：登录态 POST 换票，GET 用 ticket 开流。
// 票据泄露的后果收敛为「这一集的一次下载」。
const STREAM_TICKET_TTL_MS = 5 * 60 * 1000
const streamTickets = new Map() // ticket -> { m3u8Url, safeName, title, userId, username, ip, expiresAt }

function issueStreamTicket(payload) {
  const now = Date.now()
  for (const [key, value] of streamTickets) {
    if (value.expiresAt <= now) streamTickets.delete(key)
  }
  const ticket = randomBytes(32).toString('hex')
  streamTickets.set(ticket, { ...payload, expiresAt: now + STREAM_TICKET_TTL_MS })
  return ticket
}

// 只查看不删除：并发满时要保留票据让用户重试，避免重复扣配额；
// 真正开流时再由 GET /stream 显式 delete（单次有效、防重放）。
function peekStreamTicket(ticket) {
  if (!ticket) return null
  const record = streamTickets.get(ticket)
  if (!record) return null
  if (record.expiresAt <= Date.now()) {
    streamTickets.delete(ticket)
    return null
  }
  return record
}

function normalizeM3u8Url(m3u8Url) {
  if (!m3u8Url) return ''
  if (m3u8Url.startsWith('http://') || m3u8Url.startsWith('https://')) return m3u8Url
  return BASE_URL + (m3u8Url.startsWith('/') ? '' : '/') + m3u8Url
}

// SSRF 防护：服务器只去公网视频源取流，拒绝任何指向内网 / 环回 / 云元数据
// （169.254.169.254）等内部地址的请求。视频源换公网域名不受影响、无需维护名单。
function isBlockedIp(ip) {
  var mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) ip = mapped[1]
  if (net.isIPv4(ip)) {
    var p = ip.split('.').map(Number)
    var a = p[0], b = p[1]
    if (a === 0 || a === 10 || a === 127) return true          // 0/8、10/8 私网、环回
    if (a === 169 && b === 254) return true                    // 链路本地（含云元数据）
    if (a === 172 && b >= 16 && b <= 31) return true           // 172.16/12 私网
    if (a === 192 && b === 168) return true                    // 192.168/16 私网
    if (a === 100 && b >= 64 && b <= 127) return true          // 100.64/10 CGNAT
    if (a === 192 && b === 0 && p[2] === 0) return true        // 192.0.0/24
    if (a === 198 && (b === 18 || b === 19)) return true       // 198.18/15 基准测试
    if (a >= 224) return true                                  // 组播 / 保留
    return false
  }
  if (net.isIPv6(ip)) {
    var low = ip.toLowerCase()
    if (low === '::1' || low === '::') return true             // 环回 / 未指定
    if (/^fe[89ab]/.test(low)) return true                     // fe80::/10 链路本地
    if (low.startsWith('fc') || low.startsWith('fd')) return true // fc00::/7 唯一本地
    if (low.startsWith('ff')) return true                      // ff00::/8 组播
    return false
  }
  return true // 无法识别的地址一律拦截
}

async function assertPublicUrl(rawUrl) {
  var parsed
  try { parsed = new URL(rawUrl) } catch { throw new Error('视频地址格式不合法') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('只支持 http/https 视频地址')
  }
  var addrs
  try { addrs = await dns.lookup(parsed.hostname, { all: true }) } catch { throw new Error('无法解析该视频地址') }
  if (!addrs.length) throw new Error('无法解析该视频地址')
  for (var i = 0; i < addrs.length; i++) {
    if (isBlockedIp(addrs[i].address)) throw new Error('该地址指向内部网络，已拒绝')
  }
}

function buildFfmpegStreamArgs(m3u8Url) {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-protocol_whitelist', 'http,https,tcp,tls,crypto', // 去掉 file：流式代理只喂远程 URL，不需本地文件协议；crypto = 透明解 AES-128
    '-allowed_extensions', 'ALL',
    // 远程源防盗链头（与旧落盘链路保持一致）
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    '-headers', 'Referer: ' + BASE_URL + '\r\nOrigin: ' + BASE_URL + '\r\n',
    '-http_persistent', '1',
    '-multiple_requests', '1',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-rw_timeout', '15000000', // 15 秒读写超时（微秒）
    '-i', m3u8Url,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-c', 'copy', // 关键：不重编码，省 CPU（旧链路 -c:a aac 是 2C2G 主要负担）
    // HLS 的 AAC 是 ADTS 封装，-c copy 进 mp4 必须转 ASC，否则 muxer 报 Malformed AAC、
    // 只吐约 66KB 头部就退出（2026-09-28 实测踩到）。这是比特流过滤，仍不重编码、不吃 CPU。
    '-bsf:a', 'aac_adtstoasc',
    // pipe 不可 seek，必须用分片 mp4；+faststart 用不了
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-max_muxing_queue_size', '4096',
    '-f', 'mp4',
    'pipe:1'
  ]
}

// 换票：登录态下先并发预检（不扣配额）→ 再扣下载配额 → 签发一次性票据
router.post('/stream-ticket', heavyLimiter, requireAuth, async function (req, res, next) {
  try {
    var { m3u8Url, title } = req.body
    if (!m3u8Url) return res.status(400).json({ error: '缺少 m3u8Url' })

    if (!hasFfmpeg()) {
      return res.status(503).json({ error: '服务器未安装 ffmpeg，暂时无法提供下载' })
    }

    // 并发预检放在扣配额之前：服务器忙时直接挡回，不白扣用户配额
    if (activeStreams >= STREAM_CONCURRENCY_LIMIT) {
      return res.status(429).json({ error: '当前下载通道繁忙，请稍后再试' })
    }

    // SSRF 防护，且放在扣配额之前：拒绝内网/云元数据地址，坏地址不扣配额
    var normalized = normalizeM3u8Url(m3u8Url)
    try {
      await assertPublicUrl(normalized)
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }

    const quotaCheck = await enforceTvQuota(req, ACTION_DOWNLOAD)
    if (!quotaCheck.allowed) {
      return res.status(429).json({
        error: quotaCheck.message,
        quota: quotaCheck.quota,
      })
    }

    var safeName = sanitizeFileName(title)
    var ticket = issueStreamTicket({
      m3u8Url: normalized,
      safeName: safeName,
      title: title || safeName,
      userId: req.user?.userId || null,
      username: req.user?.username || 'guest',
      ip: getClientIp(req),
    })

    res.json({ ticket: ticket, expiresInSeconds: STREAM_TICKET_TTL_MS / 1000 })
  } catch (err) {
    next(err)
  }
})

// 开流：ticket 换出任务 → ffmpeg 流式 pipe 给响应，全程不落盘
router.get('/stream', function (req, res) {
  var ticket = String(req.query.ticket || '')
  var record = peekStreamTicket(ticket)
  if (!record) {
    return res.status(401).json({ error: '下载凭据无效或已过期，请重新发起下载' })
  }

  if (!hasFfmpeg()) {
    return res.status(503).json({ error: '服务器未安装 ffmpeg，暂时无法提供下载' })
  }

  // 二次并发检查：换票到开流之间可能又被别的流占满名额（防竞态）。
  // 并发满时不消费票据，用户可拿同一张票稍后重试，不会被重复扣下载配额。
  if (activeStreams >= STREAM_CONCURRENCY_LIMIT) {
    return res.status(503).json({ error: '当前下载通道繁忙，请稍后再试' })
  }

  streamTickets.delete(ticket) // 真正开流才作废票据（单次有效、防重放）

  activeStreams++
  var released = false
  function releaseSlot() {
    if (released) return
    released = true
    activeStreams--
  }

  var child = spawn('ffmpeg', buildFfmpegStreamArgs(record.m3u8Url), { stdio: ['ignore', 'pipe', 'pipe'] })
  function killChild() {
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL')
  }

  // 客户端断开后向已关闭 socket 写会在响应流上抛 EPIPE/ECONNRESET；单进程若无
  // 'error' 监听会冒泡成 uncaughtException 打挂整站，这里必须兜住。
  res.on('error', function () { killChild(); releaseSlot() })
  child.stdout.on('error', function () { /* pipe 目标已断开，交给 close/res.close 收尾 */ })

  // stderr 留尾 4KB，出错时打日志用
  var stderrTail = ''
  child.stderr.on('data', function (chunk) {
    stderrTail = (stderrTail + chunk.toString()).slice(-4096)
  })

  var bytesSent = 0
  child.stdout.on('data', function (chunk) { bytesSent += chunk.length })

  child.on('error', function (err) {
    console.error('[TV stream] ffmpeg 启动失败:', err.message)
    releaseSlot()
    if (!res.headersSent) res.status(500).json({ error: '转码进程启动失败' })
    else if (!res.destroyed) res.destroy()
  })

  // 中文文件名：手动 pipe 得自设 Content-Disposition，RFC5987 filename* + ASCII 回退
  var asciiName = record.safeName.replace(/[^\x20-\x7e]/g, '_') || 'video'
  res.setHeader('Content-Type', 'video/mp4')
  res.setHeader('Content-Disposition',
    'attachment; filename="' + asciiName + '.mp4"; ' +
    "filename*=UTF-8''" + encodeURIComponent(record.safeName + '.mp4'))
  res.setHeader('Cache-Control', 'no-store')

  // pipe 用 {end:false}：正常结束时由 close 分支手动 res.end()，避免二次 end
  child.stdout.pipe(res, { end: false })

  child.on('close', function (code) {
    releaseSlot()
    if (code === 0) {
      logDownload({
        userId: record.userId,
        username: record.username,
        ipAddress: record.ip,
        downloadType: 'tv',
        resourceTitle: record.title || record.safeName || '未知电视剧',
        resourceUrl: '',
        fileSize: bytesSent
      })
      if (!res.writableEnded && !res.destroyed) res.end()
    } else {
      console.error('[TV stream] ffmpeg 退出码', code, stderrTail.trim())
      // 已在往响应里 pipe 数据，无法回退成 JSON，只能断开让客户端感知失败
      if (!res.headersSent) res.status(500).json({ error: '视频流转发失败' })
      else if (!res.destroyed) res.destroy()
    }
  })

  // 客户端断开（关页面/取消下载）→ 杀掉 ffmpeg，别留僵尸进程空耗 CPU/带宽
  res.on('close', function () {
    killChild()
    releaseSlot()
  })
})

export default router

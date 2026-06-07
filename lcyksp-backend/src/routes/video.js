import express from 'express'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const router = express.Router()

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
const IMAGE_CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}
const DOUYIN_DEBUG_DIR = path.join(DATA_DIR, 'debug')
const DOUYIN_BROWSER_PROFILE_DIR = path.join(DATA_DIR, 'browser-profiles', 'douyin')
const DOUYIN_ANALYZE_CACHE_TTL_MS = 10 * 60 * 1000
const DOUYIN_IMAGE_HOST_ALLOWLIST = ['byteimg.com', 'douyinpic.com', 'tos-cn', 'p3-pc-sign', 'p6-sign']
const DOUYIN_IMAGE_URL_BLOCKLIST = [
  'douyinstatic.com',
  '/media/logo',
  'nav_dark',
  'nav_light',
  'sprite',
  'icon',
  'aweme-avatar',
  '/aweme/100x100/',
  'sc=thumb',
  'sticker_comment',
  'aweme_comment',
  'blackbg',
  'a795fb49bcbcf8cb1c762a69d57aee48',
]
const douyinAnalyzeCache = new Map()
let douyinAnalyzeInFlight = null

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

async function resolveShareUrl(url) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': DESKTOP_UA },
    })
    return response.url || url
  } catch {
    return url
  }
}

function buildCommonArgs(url) {
  const platform = detectPlatform(url)
  const cookiesMeta = getCookiesMeta(platform)
  const args = [
    '--user-agent',
    DESKTOP_UA,
    '--extractor-retries',
    '5',
    '--retries',
    '5',
    '--fragment-retries',
    '5',
    '--socket-timeout',
    '15',
    '--no-playlist',
    '--encoding',
    'utf-8',
  ]

  if (cookiesMeta.active?.usable) {
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

  return { args, platform, cookiesMeta }
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

  if (/invalid netscape format cookies file/i.test(message) || /http\.cookiejar bug/i.test(message)) {
    return `cookies 文件格式不符合 Netscape 规范。${cookieHint}`
  }

  if (platform === 'bilibili' && (message.includes('HTTP Error 412') || message.includes('Precondition Failed'))) {
    return `B站拒绝了当前抓取请求（HTTP 412）。通常需要新的 B站 cookies。${cookieHint}`
  }

  if (
    platform === 'douyin' &&
    (/fresh cookies/i.test(message) || /cookies/i.test(message) || /403|forbidden/i.test(message))
  ) {
    return `抖音当前要求使用新鲜 cookies 才能解析。${cookieHint}`
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

  if (/超时|timeout/i.test(message)) {
    return '下载或解析超时，已自动中止。长视频请稍后重试，或更换清晰度后再试。'
  }

  return message || '未知错误'
}

function runYtDlp(args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs = 0, ...spawnOptions } = options
    const proc = spawn('yt-dlp', args, spawnOptions)
    let stdout = ''
    let stderr = ''
    let timer = null

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        proc.kill('SIGKILL')
      }, timeoutMs)
    }

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('error', (error) => {
      if (timer) clearTimeout(timer)
      if (error.code === 'ENOENT') {
        reject(new Error('服务器未安装 yt-dlp'))
        return
      }
      reject(error)
    })

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (code === 0) {
        resolve({ stdout, stderr })
      } else if (code === null && timeoutMs > 0) {
        reject(new Error(`yt-dlp 执行超时（>${Math.round(timeoutMs / 1000)}s）`))
      } else {
        reject(new Error(stderr.trim().slice(0, 1600) || `yt-dlp 退出码 ${code}`))
      }
    })
  })
}

function normalizeAnalyzeFormats(rawFormats) {
  return (rawFormats || [])
    .filter((item) => item.vcodec !== 'none')
    .map((item) => ({
      formatId: item.format_id,
      quality: item.format_note || item.resolution || (item.height ? `${item.height}p` : '未知清晰度'),
      ext: item.ext || 'mp4',
      filesize: item.filesize ? `${(item.filesize / 1024 / 1024).toFixed(1)} MB` : '大小未知',
      hasAudio: Boolean(item.acodec && item.acodec !== 'none'),
    }))
}

function sanitizeFilename(name) {
  return String(name || 'download')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .slice(0, 120)
}

function buildDownloadDisposition(name, ext = '.mp4') {
  const safeBase = sanitizeFilename(name || 'download') || 'download'
  const normalizedExt = ext.startsWith('.') ? ext : `.${ext}`
  const fullName = `${safeBase}${normalizedExt}`
  const asciiName = fullName
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || `download${normalizedExt}`

  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fullName)}`
}

function getContentTypeByExtension(fileName) {
  const ext = path.extname(fileName || '').toLowerCase()
  return VIDEO_CONTENT_TYPES[ext] || IMAGE_CONTENT_TYPES[ext] || 'application/octet-stream'
}

function getExtensionFromContentType(contentType) {
  const type = String(contentType || '').toLowerCase()
  if (type.includes('video/mp4')) return '.mp4'
  if (type.includes('video/webm')) return '.webm'
  if (type.includes('video/quicktime')) return '.mov'
  if (type.includes('video/x-matroska')) return '.mkv'
  if (type.includes('image/jpeg')) return '.jpg'
  if (type.includes('image/png')) return '.png'
  if (type.includes('image/webp')) return '.webp'
  return '.bin'
}

function isAllowedDouyinImageUrl(url) {
  const value = String(url || '').toLowerCase()
  if (!value) return false
  if (DOUYIN_IMAGE_URL_BLOCKLIST.some((item) => value.includes(item))) return false
  return DOUYIN_IMAGE_HOST_ALLOWLIST.some((item) => value.includes(item))
}

function dedupeMediaItems(items) {
  const seen = new Set()
  return (items || []).filter((item) => {
    if (!item?.url || seen.has(item.url)) return false
    seen.add(item.url)
    return true
  })
}

function getDouyinCache(url) {
  const cached = douyinAnalyzeCache.get(url)
  if (!cached) return null
  if (Date.now() - cached.createdAt > DOUYIN_ANALYZE_CACHE_TTL_MS) {
    douyinAnalyzeCache.delete(url)
    return null
  }
  return cached.data
}

function setDouyinCache(url, data) {
  douyinAnalyzeCache.set(url, {
    createdAt: Date.now(),
    data,
  })
}

function createLightweightChromiumArgs() {
  return [
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-extensions',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter',
  ]
}

function isDouyinRiskPage(pageData = {}) {
  const joined = [
    pageData.pageUrl,
    pageData.title,
    pageData.htmlSnippet,
    ...(pageData.requestCandidates || []).map((item) => item.url),
    ...(pageData.responseImageCandidates || []).map((item) => item.url),
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()

  return /captcha|verify|verification|sec_did|验证|校验|风控|bytecaptcha|p3-catpcha|emblem\.png/.test(joined)
}

function isLikelyDouyinVideoStream(url) {
  const value = String(url || '').toLowerCase()
  return value.includes('douyinvod.com') && (value.includes('media-video') || value.includes('/tos-cn-vd-'))
}

function isLikelyDouyinAudioStream(url) {
  const value = String(url || '').toLowerCase()
  return value.includes('douyinvod.com') && (value.includes('media-audio') || value.includes('/tos-cn-ve-15/'))
}

function pickDouyinBrowserStreams(mediaItems) {
  const candidates = dedupeMediaItems(mediaItems || [])
  return {
    video: candidates.find((item) => isLikelyDouyinVideoStream(item.url)) || null,
    audio: candidates.find((item) => isLikelyDouyinAudioStream(item.url)) || null,
  }
}

function ensureDebugDir() {
  if (!fs.existsSync(DOUYIN_DEBUG_DIR)) {
    fs.mkdirSync(DOUYIN_DEBUG_DIR, { recursive: true })
  }
}

function writeDouyinDebugFile(name, content) {
  if (process.env.DOUYIN_DEBUG !== '1') return
  try {
    ensureDebugDir()
    fs.writeFileSync(path.join(DOUYIN_DEBUG_DIR, name), String(content || ''), 'utf-8')
  } catch {
    // ignore debug persistence failures
  }
}

function decodeEscapedUrl(input) {
  return String(input || '')
    .replace(/\\u002F/g, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
}

function extractEncodedUrls(text) {
  const source = String(text || '')
  const matches = source.match(/https?:\\\\u002F\\\\u002F[^"'\\<\s]+|https?:\\\/\\\/[^"'\\<\s]+|https?:\/\/[^"'\\<\s]+/g) || []
  return matches.map((item) => decodeEscapedUrl(item))
}

function getMarkedSlices(text, markers, radius = 5000) {
  const source = String(text || '')
  const slices = []
  for (const marker of markers) {
    let cursor = 0
    while (cursor < source.length) {
      const index = source.indexOf(marker, cursor)
      if (index === -1) break
      slices.push(source.slice(Math.max(0, index - radius), Math.min(source.length, index + radius)))
      cursor = index + marker.length
    }
  }
  return slices
}

function extractBalancedJsonObject(source, anchor) {
  const text = String(source || '')
  const anchorIndex = text.indexOf(anchor)
  if (anchorIndex === -1) return ''

  const objectStart = text.indexOf('{', anchorIndex + anchor.length)
  if (objectStart === -1) return ''

  let depth = 0
  let inString = false
  let escaped = false

  for (let index = objectStart; index < text.length; index += 1) {
    const char = text[index]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === '{') {
      depth += 1
      continue
    }

    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return text.slice(objectStart, index + 1)
      }
    }
  }

  return ''
}

function pickPreferredDouyinImageUrl(image) {
  if (!image || typeof image !== 'object') return ''

  const candidates = [
    ...(Array.isArray(image.urlList) ? image.urlList : []),
    ...(Array.isArray(image.downloadUrlList) ? image.downloadUrlList : []),
  ]

  const allowed = candidates
    .map((item) => String(item || ''))
    .filter((item) => item && isAllowedDouyinImageUrl(item))
    .filter((item) => !/sticker_comment|aweme_comment|avatar|aweme_music|pcweb_cover|sodaicon/i.test(item))

  if (!allowed.length) return ''

  return (
    allowed.find((item) => /biz_tag=aweme_images/i.test(item) && /\.jpe?g(\?|$)/i.test(item) && !/water-v2/i.test(item)) ||
    allowed.find((item) => /biz_tag=aweme_images/i.test(item) && !/water-v2/i.test(item)) ||
    allowed.find((item) => /\.jpe?g(\?|$)/i.test(item)) ||
    allowed[0]
  )
}

function extractDouyinMediaFromDetail(detail) {
  if (!detail || typeof detail !== 'object') return { videos: [], images: [] }

  const images = dedupeMediaItems(
    (Array.isArray(detail.images) ? detail.images : [])
      .map((image) => {
        const url = pickPreferredDouyinImageUrl(image)
        if (!url) return null
        const lower = url.toLowerCase()
        return {
          url,
          contentType: lower.includes('.png') ? 'image/png' : lower.includes('.webp') ? 'image/webp' : 'image/jpeg',
        }
      })
      .filter(Boolean),
  )

  const videos = []
  if (!images.length) {
    const playAddrList = Array.isArray(detail.video?.playAddr) ? detail.video.playAddr : []
    const bitRateList = Array.isArray(detail.video?.bitRateList) ? detail.video.bitRateList : []
    const candidates = []

    for (const item of playAddrList) {
      if (item?.src) candidates.push(item.src)
      if (Array.isArray(item?.urlList)) candidates.push(...item.urlList)
    }

    for (const item of bitRateList) {
      if (item?.playAddr?.src) candidates.push(item.playAddr.src)
      if (Array.isArray(item?.playAddr?.urlList)) candidates.push(...item.playAddr.urlList)
    }

    for (const item of candidates) {
      const url = String(item || '')
      const lower = url.toLowerCase()
      if (!url) continue
      if (/aweme_music|pcweb_cover|cover|big_thumbs|sticker_comment|aweme_comment|avatar|sodaicon/.test(lower)) continue
      if (!/tos-cn-v|mime_type=video|playaddr|playwm|video_mp4|\/obj\/tos-cn-ve-/i.test(lower)) continue
      videos.push({ url, contentType: 'video/mp4' })
    }
  }

  return {
    videos: dedupeMediaItems(videos),
    images,
  }
}

function parseDouyinDetailFromSerializedState(serializedText) {
  const source = String(serializedText || '')
  if (!source) return { videos: [], images: [] }

  const detailObjectText =
    extractBalancedJsonObject(source, '"detail":') ||
    extractBalancedJsonObject(source, '"detail":{')

  if (!detailObjectText) return { videos: [], images: [] }

  writeDouyinDebugFile('douyin-detail-object.json', detailObjectText)

  try {
    const detail = JSON.parse(detailObjectText)
    return extractDouyinMediaFromDetail(detail)
  } catch (error) {
    writeDouyinDebugFile('douyin-detail-parse-error.txt', error.message || String(error))
    return { videos: [], images: [] }
  }
}

function parseDouyinEmbeddedMedia(htmlText) {
  const source = String(htmlText || '')
  if (!source) return { videos: [], images: [] }

  const videoSlices = getMarkedSlices(source, ['playAddr', 'bitRateList', 'videoModel', 'PackSourceEnum_AWEME_DETAIL'])
  const imageSlices = getMarkedSlices(source, ['aweme_images', 'originCoverUrlList', 'bigThumbs', 'images'])

  const videos = []
  for (const slice of videoSlices) {
    for (const url of extractEncodedUrls(slice)) {
      if (/playwm|playaddr|play\?|bitratelist|mime_type=video|video_mp4|tos-cn-v/.test(url.toLowerCase())) {
        videos.push({ url, contentType: 'video/mp4' })
      }
    }
  }

  const images = []
  for (const slice of imageSlices) {
    for (const url of extractEncodedUrls(slice)) {
      const lower = url.toLowerCase()
      if (!isAllowedDouyinImageUrl(lower)) continue
      if (!/aweme_images|aweme_detail|packsourceenum_aweme_detail|pcweb_cover|tos-cn-i-|tos-cn-o-0812/.test(lower)) continue
      images.push({
        url,
        contentType: lower.includes('.png') ? 'image/png' : lower.includes('.webp') ? 'image/webp' : 'image/jpeg',
      })
    }
  }

  return {
    videos: dedupeMediaItems(videos),
    images: dedupeMediaItems(images),
  }
}

function pickDouyinPaceScriptText(scripts) {
  const scriptTexts = (scripts || []).map((script) => script.textContent || '')
  return (
    scriptTexts.find((text) => text.includes('__pace_f') && text.includes('playAddr') && text.includes('"detail":')) ||
    scriptTexts.find((text) => text.includes('__pace_f') && text.includes('bitRateList') && text.includes('"video":')) ||
    scriptTexts.find((text) => text.includes('__pace_f') && text.includes('playAddr')) ||
    ''
  )
}

function parseDouyinPaceMediaFromScript(scriptText) {
  const source = String(scriptText || '')
  if (!source) return { videos: [], images: [] }

  const payloads = []
  const pushRegex = /__pace_f\.push\(\[\d+,\s*"((?:\\.|[^"\\])*)"\]\)/g
  for (const match of source.matchAll(pushRegex)) {
    const rawPayload = match[1]
    try {
      let decoded = JSON.parse(`"${rawPayload}"`)
      if (/%[0-9A-Fa-f]{2}/.test(decoded)) {
        try {
          decoded = decodeURIComponent(decoded)
        } catch {
          // keep partially decoded payload
        }
      }
      payloads.push(decoded)
    } catch {
      // ignore malformed chunks
    }
  }

  const combinedPayload = payloads.join('\n')
  const parseTarget = combinedPayload || source
  const commentMarkerIndex = parseTarget.indexOf('"comment":{"statusCode"')
  const mainContentTarget = commentMarkerIndex >= 0 ? parseTarget.slice(0, commentMarkerIndex) : parseTarget
  writeDouyinDebugFile('douyin-pace-script.txt', source)
  writeDouyinDebugFile('douyin-pace-payload.txt', parseTarget)
  writeDouyinDebugFile('douyin-main-content-payload.txt', mainContentTarget)
  writeDouyinDebugFile(
    'douyin-pace-meta.json',
    JSON.stringify(
      {
        payloadCount: payloads.length,
        sourceLength: source.length,
        payloadLength: parseTarget.length,
        commentMarkerIndex,
        mainContentLength: mainContentTarget.length,
      },
      null,
      2,
    ),
  )
  const structuredMedia = parseDouyinDetailFromSerializedState(mainContentTarget)
  if (structuredMedia.videos.length || structuredMedia.images.length) {
    writeDouyinDebugFile(
      'douyin-detail-media.json',
      JSON.stringify(
        {
          videos: structuredMedia.videos,
          images: structuredMedia.images,
        },
        null,
        2,
      ),
    )
    return structuredMedia
  }

  const fallbackSlices = getMarkedSlices(mainContentTarget, ['"video":{', 'playAddr', 'aweme_images', 'bigThumbs'], 9000)
  writeDouyinDebugFile('douyin-fallback-slices.txt', fallbackSlices.join('\n\n-----\n\n'))
  const fallbackMedia = parseDouyinEmbeddedMedia(fallbackSlices.join('\n'))
  return {
    videos: dedupeMediaItems(fallbackMedia.videos).filter((item) => !/aweme_music|pcweb_cover|cover/i.test(item.url)),
    images: dedupeMediaItems(fallbackMedia.images).filter((item) => !/aweme_music|pcweb_cover|cover/i.test(item.url)),
  }
}

function collectDeepMediaCandidates(input, state = { videos: [], images: [] }) {
  if (!input || typeof input !== 'object') return state

  if (Array.isArray(input)) {
    for (const item of input) collectDeepMediaCandidates(item, state)
    return state
  }

  for (const value of Object.values(input)) {
    if (value && typeof value === 'object') {
      collectDeepMediaCandidates(value, state)
    }
  }

  const candidateKeys = ['url_list', 'origin_url_list', 'download_url_list']
  for (const key of candidateKeys) {
    const list = input[key]
    if (!Array.isArray(list)) continue
    for (const url of list) {
      if (typeof url !== 'string') continue
      if (/playwm|play\?|video_mp4|mime_type=video|aweme\/v1\/play/i.test(url)) {
        state.videos.push({ url, contentType: 'video/mp4' })
      } else if (isAllowedDouyinImageUrl(url)) {
        state.images.push({ url, contentType: 'image/jpeg' })
      }
    }
  }

  return state
}

function parseRenderDataMedia(documentData) {
  const renderNode = documentData?.renderData
  if (!renderNode) return { videos: [], images: [] }

  try {
    const decoded = decodeURIComponent(renderNode)
    const parsed = JSON.parse(decoded)
    const state = collectDeepMediaCandidates(parsed)
    return {
      videos: dedupeMediaItems(state.videos),
      images: dedupeMediaItems(state.images),
    }
  } catch {
    return { videos: [], images: [] }
  }
}

function toPlaywrightCookies(cookieMeta) {
  const content = cookieMeta?.active?.content || ''
  if (!content) return []

  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_')))
    .map((line) => ({
      parts: (line.startsWith('#HttpOnly_') ? line.slice(10) : line).split('\t'),
      httpOnly: line.startsWith('#HttpOnly_'),
    }))
    .filter(({ parts }) => parts.length >= 7)
    .map(({ parts, httpOnly }) => {
      const [domain, , cookiePath, secure, expires, name, ...rest] = parts
      return {
        name,
        value: rest.join('\t'),
        domain,
        path: cookiePath || '/',
        secure: String(secure).toUpperCase() === 'TRUE',
        expires: Number(expires) > 0 ? Number(expires) : -1,
        httpOnly,
        sameSite: 'Lax',
      }
    })
    .filter((cookie) => cookie.name && cookie.value)
    .map((cookie) => ({
      ...cookie,
      domain: cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain,
    }))
}

async function getPlaywrightModule() {
  try {
    return await import('playwright')
  } catch {
    try {
      return await import('playwright-core')
    } catch {
      return null
    }
  }
}

function getChromiumExecutablePath() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_PATH,
    '/snap/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ].filter(Boolean)

  return candidates.find((candidate) => fs.existsSync(candidate)) || undefined
}

async function extractDouyinMediaWithBrowser(url) {
  const playwright = await getPlaywrightModule()
  if (!playwright?.chromium) {
    throw new Error('浏览器自动化原型未启用：服务器未安装 playwright')
  }

  const cookiesMeta = getCookiesMeta('douyin')
  fs.mkdirSync(DOUYIN_BROWSER_PROFILE_DIR, { recursive: true })
  const context = await playwright.chromium.launchPersistentContext(DOUYIN_BROWSER_PROFILE_DIR, {
    headless: true,
    executablePath: getChromiumExecutablePath(),
    args: createLightweightChromiumArgs(),
    userAgent: DESKTOP_UA,
    viewport: { width: 1440, height: 960 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    deviceScaleFactor: 1,
    isMobile: false,
    colorScheme: 'dark',
    extraHTTPHeaders: {
      Referer: 'https://www.douyin.com/',
      Origin: 'https://www.douyin.com',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'Sec-CH-UA': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': '"Windows"',
      'Upgrade-Insecure-Requests': '1',
    },
  })

  const mediaCandidates = new Map()
  const imageCandidates = new Map()
  const requestCandidates = []

  try {
    const cookies = toPlaywrightCookies(cookiesMeta)
    if (cookies.length) {
      await context.addCookies(cookies)
    }

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32' })
      Object.defineProperty(navigator, 'language', { get: () => 'zh-CN' })
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] })
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 })
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 })
      Object.defineProperty(screen, 'colorDepth', { get: () => 24 })
      Object.defineProperty(window, 'chrome', {
        get: () => ({ runtime: {}, app: {}, csi: () => {}, loadTimes: () => ({}) }),
      })
    })

    const pages = context.pages()
    for (const extraPage of pages.slice(1)) {
      await extraPage.close().catch(() => {})
    }
    const page = pages[0] || (await context.newPage())
    await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null)
    await page.waitForTimeout(1200)
    page.on('response', async (response) => {
      const responseUrl = response.url()
      const headers = response.headers()
      const type = String(headers['content-type'] || '').toLowerCase()

      if (type.includes('video/') || /playwm|play\?|video_mp4|mime_type=video/i.test(responseUrl)) {
        mediaCandidates.set(responseUrl, {
          url: responseUrl,
          contentType: headers['content-type'] || 'video/mp4',
        })
      }

      if (type.includes('image/') && isAllowedDouyinImageUrl(responseUrl)) {
        imageCandidates.set(responseUrl, {
          url: responseUrl,
          contentType: headers['content-type'] || 'image/jpeg',
        })
      }
    })

    page.on('request', (request) => {
      const requestUrl = request.url()
      if (/playwm|play\?|video_mp4|mime_type=video|\/aweme\/v1\/play\/|\/obj\/tos-cn-ve-/i.test(requestUrl)) {
        requestCandidates.push({
          url: requestUrl,
          method: request.method(),
          resourceType: request.resourceType(),
        })
        mediaCandidates.set(requestUrl, {
          url: requestUrl,
          contentType: 'video/mp4',
        })
      }
    })

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    if (!response) {
      throw new Error('浏览器自动化未拿到抖音页面响应')
    }

    try {
      await Promise.race([
        page.waitForFunction(
          () => {
            return Boolean(
              document.querySelector('#RENDER_DATA') ||
                document.querySelector('video') ||
                document.querySelector('img'),
            )
          },
          { timeout: 5000 },
        ),
        page.waitForTimeout(1800),
      ])
    } catch {
      await page.waitForTimeout(1800)
    }

    try {
      await page.waitForSelector('video', { timeout: 4000 })
      await page.evaluate(async () => {
        const video = document.querySelector('video')
        if (!video) return
        try {
          video.muted = true
          await video.play().catch(() => {})
        } catch {
          // ignore autoplay failures
        }
      })
      await page.waitForTimeout(2200)
    } catch {
      // video element may not exist on note pages
    }

    const htmlContent = await page.content()

    const pageData = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script'))
      const video = document.querySelector('video')
      const renderData = document.querySelector('#RENDER_DATA')?.textContent || ''
      const paceMediaScript = (() => {
        const scriptTexts = scripts.map((script) => script.textContent || '')
        return (
          scriptTexts.find((text) => text.includes('__pace_f') && text.includes('playAddr') && text.includes('"detail":')) ||
          scriptTexts.find((text) => text.includes('__pace_f') && text.includes('bitRateList') && text.includes('"video":')) ||
          scriptTexts.find((text) => text.includes('__pace_f') && text.includes('playAddr')) ||
          ''
        )
      })()
      const title =
        document.querySelector('title')?.textContent?.trim() ||
        document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
        ''

      const rawJson = scripts
        .map((script) => script.textContent || '')
        .find((text) => text.includes('REHYDRATION') || text.includes('playAddr') || text.includes('bitRateList'))

      return {
        title,
        pageUrl: location.href,
        hasVideoElement: Boolean(video),
        videoSrc: video?.currentSrc || video?.src || '',
        rawJson: rawJson || '',
        renderData,
        paceMediaScript,
        htmlSnippet: document.documentElement?.outerHTML?.slice(0, 5000) || '',
      }
    })

    writeDouyinDebugFile(
      'douyin-browser-page.json',
      JSON.stringify(
        {
          inputUrl: url,
          pageUrl: pageData.pageUrl,
          title: pageData.title,
          hasVideoElement: pageData.hasVideoElement,
          videoSrc: pageData.videoSrc,
          paceMediaScriptLength: pageData.paceMediaScript?.length || 0,
          rawJsonLength: pageData.rawJson?.length || 0,
          renderDataLength: pageData.renderData?.length || 0,
          htmlSnippet: pageData.htmlSnippet,
          requestCandidates,
          responseVideoCandidates: Array.from(mediaCandidates.values()),
          responseImageCandidates: Array.from(imageCandidates.values()).slice(0, 20),
        },
        null,
        2,
      ),
    )

    const parsedRenderMedia = parseRenderDataMedia(pageData)
    const parsedEmbeddedMedia = parseDouyinEmbeddedMedia(htmlContent)
    const parsedPaceMedia = parseDouyinPaceMediaFromScript(pageData.paceMediaScript)

    const browserStreams = pickDouyinBrowserStreams(Array.from(mediaCandidates.values()))

    if (
      isDouyinRiskPage({
        ...pageData,
        requestCandidates,
        responseImageCandidates: Array.from(imageCandidates.values()).slice(0, 20),
      }) &&
      !browserStreams.video &&
      !pageData.hasVideoElement
    ) {
      throw new Error('抖音视频页触发了风控校验，当前浏览器会话未拿到正文内容')
    }

    const preferredMedia =
      parsedPaceMedia.videos.length || parsedPaceMedia.images.length
        ? parsedPaceMedia
        : parsedRenderMedia.videos.length || parsedRenderMedia.images.length
          ? parsedRenderMedia
          : parsedEmbeddedMedia

    if (preferredMedia.images.length || preferredMedia.videos.length) {
      return {
        title: pageData.title || '抖音视频',
        video: preferredMedia.videos[0] || null,
        audio: null,
        images: preferredMedia.images,
      }
    }

    if (pageData.videoSrc) {
      mediaCandidates.set(pageData.videoSrc, {
        url: pageData.videoSrc,
        contentType: 'video/mp4',
      })
    }

    if (!mediaCandidates.size && pageData.rawJson) {
      const matchedUrls = pageData.rawJson.match(/https?:\\\/\\\/[^"'\\]+/g) || []
      for (const item of matchedUrls) {
        const decoded = item.replace(/\\u002F/g, '/').replace(/\\\//g, '/')
        if (/video|playwm|play\?/i.test(decoded)) {
          mediaCandidates.set(decoded, {
            url: decoded,
            contentType: 'video/mp4',
          })
        } else if (isAllowedDouyinImageUrl(decoded)) {
          imageCandidates.set(decoded, {
            url: decoded,
            contentType: 'image/jpeg',
          })
        }
      }
    }

    return {
      title: pageData.title || '抖音视频',
      video: browserStreams.video,
      audio: browserStreams.audio,
      images: browserStreams.video ? [] : Array.from(imageCandidates.values()),
    }
  } finally {
    await context.close()
  }
}

async function analyzeViaBrowserAutomation(url) {
  const platform = detectPlatform(url)
  if (platform !== 'douyin') return null

  const cached = getDouyinCache(url)
  if (cached) {
    return cached
  }

  if (douyinAnalyzeInFlight) {
    return douyinAnalyzeInFlight
  }

  douyinAnalyzeInFlight = (async () => {
    const extracted = await extractDouyinMediaWithBrowser(url)
    if (!extracted.video?.url && !extracted.images.length) {
      throw new Error('浏览器自动化已启动，但暂未抓到可下载的媒体地址')
    }

    const imageFormats = dedupeMediaItems(extracted.images).map((item, index) => ({
      formatId: `browser-image-${index + 1}`,
      quality: `图片 ${index + 1}`,
      ext: getExtensionFromContentType(item.contentType).replace(/^\./, '') || 'jpg',
      filesize: '大小未知',
      hasAudio: false,
      directUrl: item.url,
      mediaType: 'image',
    }))

    const result = {
      title: extracted.title || '抖音媒体',
      thumbnail: extracted.images[0]?.url || '',
      directPreviewUrl: extracted.video?.url || extracted.images[0]?.url || '',
      directPreviewType: extracted.video?.url ? 'video' : extracted.images.length ? 'image' : '',
      webpageUrl: url,
      platform,
      source: 'browser-automation',
      formats: extracted.video?.url
          ? [
              {
                formatId: 'browser-video',
                quality: '浏览器自动化抓取',
                ext: 'mp4',
                filesize: '大小未知',
                hasAudio: true,
                directUrl: extracted.video.url,
                audioUrl: extracted.audio?.url || '',
                mediaType: 'video',
              },
            ]
          : imageFormats,
    }

    setDouyinCache(url, result)
    return result
  })()

  try {
    return await douyinAnalyzeInFlight
  } finally {
    douyinAnalyzeInFlight = null
  }
}

async function streamDirectMediaDownload({ mediaUrl, title, res }) {
  const response = await fetch(mediaUrl, {
    headers: {
      'User-Agent': DESKTOP_UA,
      Referer: 'https://www.douyin.com/',
      Origin: 'https://www.douyin.com',
    },
  })

  if (!response.ok || !response.body) {
    throw new Error(`媒体直链下载失败（HTTP ${response.status}）`)
  }

  const type = response.headers.get('content-type') || 'application/octet-stream'
  const ext = getExtensionFromContentType(type)
  res.setHeader('Content-Type', type)
  res.setHeader('Content-Disposition', buildDownloadDisposition(title || 'douyin-download', ext))
  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  res.setHeader('Content-Length', buffer.length)
  res.end(buffer)
}

async function downloadUrlToFile(mediaUrl, filePath) {
  const response = await fetch(mediaUrl, {
    headers: {
      'User-Agent': DESKTOP_UA,
      Referer: 'https://www.douyin.com/',
      Origin: 'https://www.douyin.com',
    },
  })

  if (!response.ok || !response.body) {
    throw new Error(`媒体直链下载失败（HTTP ${response.status}）`)
  }

  const arrayBuffer = await response.arrayBuffer()
  fs.writeFileSync(filePath, Buffer.from(arrayBuffer))
  return response.headers.get('content-type') || 'application/octet-stream'
}

function runFfmpeg(args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs = 0, ...spawnOptions } = options
    const proc = spawn('ffmpeg', args, spawnOptions)
    let stderr = ''
    let timer = null

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        proc.kill('SIGKILL')
      }, timeoutMs)
    }

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('error', (error) => {
      if (timer) clearTimeout(timer)
      if (error.code === 'ENOENT') {
        reject(new Error('服务器未安装 ffmpeg'))
        return
      }
      reject(error)
    })

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (code === 0) {
        resolve()
      } else if (code === null && timeoutMs > 0) {
        reject(new Error(`ffmpeg 执行超时（>${Math.round(timeoutMs / 1000)}s）`))
      } else {
        reject(new Error(stderr.trim().slice(0, 1600) || `ffmpeg 退出码 ${code}`))
      }
    })
  })
}

async function mergeBrowserVideoAudioToResponse({ videoUrl, audioUrl, title, tempDir, res }) {
  const videoFile = path.join(tempDir, 'video-track.mp4')
  const audioFile = path.join(tempDir, 'audio-track.m4a')
  const outputFile = path.join(tempDir, 'merged-output.mp4')

  await downloadUrlToFile(videoUrl, videoFile)

  if (audioUrl) {
    await downloadUrlToFile(audioUrl, audioFile)
    await runFfmpeg(
      ['-y', '-i', videoFile, '-i', audioFile, '-c:v', 'copy', '-c:a', 'aac', '-shortest', outputFile],
      { timeoutMs: 120000, cwd: tempDir },
    )
  } else {
    fs.copyFileSync(videoFile, outputFile)
  }

  const safeTitle = sanitizeFilename(title || 'douyin-download')
  res.setHeader('Content-Type', 'video/mp4')
  res.setHeader('Content-Disposition', buildDownloadDisposition(safeTitle, '.mp4'))
  res.setHeader('Content-Length', fs.statSync(outputFile).size)

  const stream = fs.createReadStream(outputFile)
  stream.on('error', () => {
    if (!res.headersSent) {
      res.status(500).json({ error: '读取下载文件失败' })
    } else if (!res.writableEnded) {
      res.end()
    }
  })
  stream.pipe(res)
}

function createTempDownloadDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lcyksp-video-'))
}

function cleanupTempDir(dirPath) {
  if (!dirPath) return
  try {
    fs.rmSync(dirPath, { recursive: true, force: true })
  } catch {
    // ignore cleanup failure
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
      browserAutomation: {
        douyinPrototype: true,
      },
      cookies: {
        default: sanitizeCookieFile(DEFAULT_COOKIES_PATH),
        bilibili: bilibiliMeta.active,
        douyin: douyinMeta.active,
        youtube: youtubeMeta.active,
      },
    },
  })
})

router.post('/analyze', async (req, res) => {
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

  try {
    const finalUrl = await resolveShareUrl(url)
    const { args: commonArgs } = buildCommonArgs(finalUrl)
    const args = [...commonArgs, '--no-warnings', '--dump-single-json', finalUrl]
    const { stdout } = await runYtDlp(args, { timeoutMs: 30000 })
    const rawData = JSON.parse(stdout)
    const formats = normalizeAnalyzeFormats(rawData.formats)

    res.json({
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
    const { cookiesMeta } = buildCommonArgs(finalUrl)

    if (detectPlatform(finalUrl) === 'douyin') {
      try {
        const fallbackData = await analyzeViaBrowserAutomation(finalUrl)
        return res.json({
          success: true,
          data: fallbackData,
          message: 'yt-dlp 解析失败，已自动切换到浏览器自动化原型。',
        })
      } catch (browserError) {
        console.error('[Video] browser fallback failed:', browserError.message)
      }
    }

    const finalMessage = normalizeVideoError(error.message, finalUrl, cookiesMeta)
    console.error('[Video] analyze failed:', finalMessage)
    res.json({
      success: false,
      message: `解析失败：${finalMessage}`,
    })
  }
})

router.post('/download', async (req, res) => {
  let { url, formatId, title, browserDirectUrl, browserAudioUrl, source } = req.body
  url = pickUrlFromText(url || '')

  if (!url || !formatId) {
    return res.status(400).json({ error: '参数不完整' })
  }

  const requestedPlatform = detectPlatform(url)
  if (requestedPlatform === 'youtube') {
    return res.status(400).json({ error: '当前暂仅支持抖音和 B站，YouTube 下载入口已暂时关闭。' })
  }

  let tempDir = ''
  try {
    const finalUrl = await resolveShareUrl(url)

    if (detectPlatform(finalUrl) === 'douyin' && source === 'browser-automation' && browserDirectUrl) {
      tempDir = createTempDownloadDir()
      if (formatId === 'browser-video') {
        await mergeBrowserVideoAudioToResponse({
          videoUrl: browserDirectUrl,
          audioUrl: browserAudioUrl,
          title: title || 'douyin-download',
          tempDir,
          res,
        })
      } else {
        await streamDirectMediaDownload({
          mediaUrl: browserDirectUrl,
          title: title || 'douyin-download',
          res,
        })
      }
      return
    }

    const { args: commonArgs } = buildCommonArgs(finalUrl)
    tempDir = createTempDownloadDir()
    const outputTemplate = path.join(tempDir, 'video.%(ext)s')
    const args = [
      ...commonArgs,
      '-f',
      `${formatId}+bestaudio/best`,
      '--merge-output-format',
      'mp4',
      '-o',
      outputTemplate,
      finalUrl,
    ]

    await runYtDlp(args, { timeoutMs: 1200000 })

    const files = fs.readdirSync(tempDir)
    const targetFile =
      files.find((file) => file.endsWith('.mp4')) ||
      files.find((file) => file.endsWith('.mkv')) ||
      files.find((file) => file.endsWith('.webm'))

    if (!targetFile) {
      throw new Error('下载完成但未找到合并后的视频文件')
    }

    const absFile = path.join(tempDir, targetFile)
    const safeTitle = sanitizeFilename(title || path.parse(targetFile).name)
    const ext = path.extname(targetFile) || '.mp4'
    res.setHeader('Content-Type', getContentTypeByExtension(targetFile))
    res.setHeader('Content-Disposition', buildDownloadDisposition(safeTitle, ext))
    res.setHeader('Content-Length', fs.statSync(absFile).size)

    const stream = fs.createReadStream(absFile)
    stream.on('error', () => {
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
    const finalMessage = normalizeVideoError(error.message, finalUrl, cookiesMeta)
    console.error('[Video] download failed:', finalMessage)
    if (!res.headersSent) {
      res.status(500).json({ error: `下载失败：${finalMessage}` })
    } else if (!res.writableEnded) {
      res.end()
    }
  }
})

export default router

import express from 'express'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import { fileURLToPath } from 'url'
import sharp from 'sharp'
import { generateABogus } from '../utils/douyin-a-bogus.js'

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

async function fetchDouyinPageHtml(url) {
  const cookiesMeta = getCookiesMeta('douyin')
  const cookieHeader = buildCookieHeader(cookiesMeta)
  const response = await fetch(url, {
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

function buildDouyinAnalyzeResult({ title, url, video = null, audio = null, images = [], source }) {
  const formats = []

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

   if (video?.url) {
    formats.push({
      formatId: source === 'browser-automation' ? 'browser-audio' : 'direct-audio',
      quality: '仅音频',
      ext: audio?.url ? inferExtensionFromUrl(audio.url, 'm4a') : 'mp3',
      filesize: '大小未知',
      hasAudio: true,
      mediaType: 'audio',
      directUrl: audio?.url || video.url,
      audioUrl: audio?.url || video.url,
      contentType: audio?.contentType || 'audio/mpeg',
      sourceCandidates: audio?.sourceCandidates || video.sourceCandidates || [],
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
  douyinAnalyzeCache.set(url, { createdAt: Date.now(), data })
}

async function analyzeDouyinViaSignedApi(url) {
  const finalUrl = await resolveShareUrl(url)
  const cached = getDouyinAnalyzeCache(finalUrl)
  if (cached) return cached

  const awemeId = extractDouyinAwemeId(finalUrl)
  if (!awemeId) throw new Error('unable to extract douyin aweme id')

  const cookiesMeta = getCookiesMeta('douyin')
  const cookieHeader = buildCookieHeader(cookiesMeta)
  if (!cookieHeader) throw new Error('douyin signed api requires cookies')

  const params = buildDouyinDetailParams(awemeId)
  const query = params.toString()
  const aBogus = generateABogus(query, DESKTOP_UA)
  const endpoint = `https://www.douyin.com/aweme/v1/web/aweme/detail/?${query}&a_bogus=${encodeURIComponent(aBogus)}`
  const response = await fetch(endpoint, {
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
  })

  const text = await response.text()
  if (!response.ok) throw new Error(`douyin signed api failed: HTTP ${response.status}`)
  if (!text) throw new Error('douyin signed api returned empty body')

  writeDouyinDebugFile('douyin-signed-api-response.json', text)

  let payload = {}
  try {
    payload = JSON.parse(text)
  } catch (error) {
    throw new Error(`douyin signed api json parse failed: ${error.message}`)
  }

  const detail = payload?.aweme_detail
  if (!detail || typeof detail !== 'object') {
    throw new Error(`douyin signed api missing aweme_detail: ${payload?.status_msg || payload?.message || 'unknown error'}`)
  }

  const result = buildDouyinAnalyzeResult({
    title: extractDouyinTitleFromDetail(detail),
    url: finalUrl,
    video: normalizeDouyinSignedApiVideo(detail),
    audio: null,
    images: normalizeDouyinSignedApiImages(detail),
    source: 'signed-api',
  })

  if (!result.formats.length) throw new Error('douyin signed api did not return usable media')
  setDouyinAnalyzeCache(finalUrl, result)
  return result
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

async function analyzeDouyinViaRequest(url) {
  const finalUrl = await resolveShareUrl(url)
  const cached = getDouyinAnalyzeCache(finalUrl)
  if (cached) return cached

  const { html } = await fetchDouyinPageHtml(finalUrl)
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

async function streamDirectMediaDownload({ mediaUrl, title, res, contentType }) {
  const platform = detectPlatform(mediaUrl)
  const cookiesMeta = getCookiesMeta(platform)
  const cookieHeader = buildCookieHeader(cookiesMeta)
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

async function streamDirectImageAsJpeg({ mediaUrl, title, res }) {
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
  })

  if (!response.ok || !response.body) {
    throw new Error(`图片下载失败: HTTP ${response.status}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  const jpegBuffer = await sharp(Buffer.from(arrayBuffer)).jpeg({ quality: 92, mozjpeg: true }).toBuffer()

  res.setHeader('Content-Type', 'image/jpeg')
  res.setHeader('Content-Disposition', buildDownloadDisposition(title || 'download', '.jpg'))
  res.setHeader('Content-Length', jpegBuffer.length)
  res.end(jpegBuffer)
}

async function proxyImagePreview({ mediaUrl, res }) {
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
  })

  if (!response.ok || !response.body) {
    throw new Error(`图片预览失败: HTTP ${response.status}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  const jpegBuffer = await sharp(Buffer.from(arrayBuffer)).jpeg({ quality: 92, mozjpeg: true }).toBuffer()
  res.setHeader('Content-Type', 'image/jpeg')
  res.setHeader('Cache-Control', 'public, max-age=300')
  res.setHeader('Content-Length', jpegBuffer.length)
  res.end(jpegBuffer)
}

async function extractDirectAudioToResponse({ mediaUrl, title, tempDir, res }) {
  const inputPath = path.join(tempDir, 'input-video.mp4')
  const outputPath = path.join(tempDir, 'output-audio.mp3')

  await downloadToFile(mediaUrl, inputPath, 'video/mp4')

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
      else reject(new Error(stderr.trim().slice(0, 1200) || `ffmpeg 退出码 ${code}`))
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

async function downloadToFile(url, filePath, contentTypeHint) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': DESKTOP_UA,
      Referer: 'https://www.douyin.com/',
      Origin: 'https://www.douyin.com',
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

async function mergeBrowserVideoAudioToResponse({ videoUrl, audioUrl, title, tempDir, res }) {
  if (!audioUrl || audioUrl === videoUrl) {
    await streamDirectMediaDownload({ mediaUrl: videoUrl, title, res, contentType: 'video/mp4' })
    return
  }

  const videoPath = path.join(tempDir, 'video.mp4')
  const audioPath = path.join(tempDir, 'audio.m4a')
  const outputPath = path.join(tempDir, 'merged.mp4')

  await downloadToFile(videoUrl, videoPath, 'video/mp4')
  await downloadToFile(audioUrl, audioPath, 'audio/mp4')

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
      else reject(new Error(stderr.trim().slice(0, 1200) || `ffmpeg 退出码 ${code}`))
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

router.get('/status', (_req, res) => {
  const bilibiliMeta = getCookiesMeta('bilibili')
  const douyinMeta = getCookiesMeta('douyin')
  const youtubeMeta = getCookiesMeta('youtube')

  res.json({
    success: true,
    data: {
      ytDlpCommand: 'yt-dlp',
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

  console.error('[Video] analyze start:', { url, requestedPlatform })

  async function runDouyinPrimaryFlow(finalUrl) {
    if (douyinAnalyzeInFlight && douyinAnalyzeInFlight.url === finalUrl) {
      const sharedResult = await douyinAnalyzeInFlight.promise
      return sharedResult
    }

    const promise = (async () => {
      try {
        console.error('[Video] trying douyin signed-api primary:', { finalUrl, elapsedMs: Date.now() - startedAt })
        const signedApiData = await analyzeDouyinViaSignedApi(finalUrl)
        console.error('[Video] douyin signed-api primary ok:', {
          finalUrl,
          source: signedApiData?.source,
          formats: signedApiData?.formats?.length || 0,
          elapsedMs: Date.now() - startedAt,
        })
        return { data: signedApiData, message: '已通过抖音站内接口完成解析。' }
      } catch (signedApiError) {
        console.error('[Video] douyin signed-api primary failed:', signedApiError?.stack || signedApiError?.message || String(signedApiError))
      }

      try {
        console.error('[Video] trying douyin request-extract primary:', { finalUrl, elapsedMs: Date.now() - startedAt })
        const requestData = await analyzeDouyinViaRequest(finalUrl)
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

      const { args: douyinArgs } = buildCommonArgs(finalUrl)
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

    if (detectPlatform(finalUrl) === 'douyin') {
      const douyinResult = await runDouyinPrimaryFlow(finalUrl)
      return res.json({ success: true, data: douyinResult.data, message: douyinResult.message })
    }

    const { args: commonArgs } = buildCommonArgs(finalUrl)
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
    const { cookiesMeta } = buildCommonArgs(finalUrl)
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
        const douyinResult = await runDouyinPrimaryFlow(finalUrl)
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
      cleanupTempDir(tempDir)
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

router.get('/preview-image', async (req, res) => {
  try {
    const mediaUrl = String(req.query.url || '').trim()
    if (!/^https?:\/\//i.test(mediaUrl)) {
      return res.status(400).json({ error: '无效的图片地址' })
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

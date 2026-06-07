import express from 'express'
import { spawn } from 'child_process'
import fs from 'fs'
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
  const parts = line.split('\t')
  if (parts.length < 7) {
    return { valid: false, reason: '字段数不足', raw: line }
  }

  const [domain, includeSubdomains, cookiePath, secure, expires, name, ...rest] = parts
  const value = rest.join('\t')
  const initialDot = domain.startsWith('.')
  const subdomainFlag = String(includeSubdomains).toUpperCase()
  const secureFlag = String(secure).toUpperCase()

  if (!domain) return { valid: false, reason: '域名为空', raw: line }
  if (!cookiePath) return { valid: false, reason: 'Path 为空', raw: line }
  if (!name) return { valid: false, reason: 'Cookie 名为空', raw: line }
  if (!['TRUE', 'FALSE'].includes(subdomainFlag)) {
    return { valid: false, reason: '第2列必须为 TRUE/FALSE', raw: line }
  }
  if (!['TRUE', 'FALSE'].includes(secureFlag)) {
    return { valid: false, reason: '第4列必须为 TRUE/FALSE', raw: line }
  }
  if (!/^\d+$/.test(String(expires))) {
    return { valid: false, reason: '过期时间不是整数', raw: line }
  }
  if (initialDot && subdomainFlag !== 'TRUE') {
    return { valid: false, reason: '域名以 . 开头时第2列必须为 TRUE', raw: line }
  }
  if (!initialDot && subdomainFlag !== 'FALSE') {
    return { valid: false, reason: '域名不以 . 开头时第2列必须为 FALSE', raw: line }
  }

  return {
    valid: true,
    normalized: [domain, subdomainFlag, cookiePath, secureFlag, String(expires), name, value].join('\t'),
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
    if (trimmed.startsWith('#')) {
      comments.push(line)
      continue
    }

    const parsed = parseCookieLine(line)
    if (parsed.valid) {
      validLines.push(parsed.normalized)
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

  return {
    platform,
    active,
    candidates,
  }
}

async function resolveShareUrl(url) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': DESKTOP_UA,
      },
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
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', args, options)
    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('error', (error) => {
      if (error.code === 'ENOENT') {
        reject(new Error('服务器未安装 yt-dlp'))
        return
      }
      reject(error)
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
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

    const { stdout } = await runYtDlp(args, { timeout: 30000 })
    const rawData = JSON.parse(stdout)
    const formats = normalizeAnalyzeFormats(rawData.formats)

    res.json({
      success: true,
      data: {
        title: rawData.title || '未知标题',
        thumbnail: rawData.thumbnail || '',
        directPreviewUrl: rawData.url || '',
        webpageUrl: rawData.webpage_url || finalUrl,
        platform: detectPlatform(finalUrl),
        formats: formats.reverse(),
      },
    })
  } catch (error) {
    const finalUrl = await resolveShareUrl(url)
    const { cookiesMeta } = buildCommonArgs(finalUrl)
    const finalMessage = normalizeVideoError(error.message, finalUrl, cookiesMeta)
    console.error('[Video] analyze failed:', finalMessage)
    res.json({
      success: false,
      message: `解析失败：${finalMessage}`,
    })
  }
})

router.post('/download', async (req, res) => {
  let { url, formatId } = req.body
  url = pickUrlFromText(url || '')

  if (!url || !formatId) {
    return res.status(400).json({ error: '参数不完整' })
  }

  const requestedPlatform = detectPlatform(url)
  if (requestedPlatform === 'youtube') {
    return res.status(400).json({ error: '当前暂仅支持抖音和 B站，YouTube 下载入口已暂时关闭。' })
  }

  try {
    const finalUrl = await resolveShareUrl(url)
    const { args: commonArgs } = buildCommonArgs(finalUrl)
    const args = [...commonArgs, '-f', `${formatId}+bestaudio/best`, '--merge-output-format', 'mp4', '-o', '-', finalUrl]

    res.setHeader('Content-Type', 'video/mp4')
    res.setHeader('Content-Disposition', 'attachment')

    const proc = spawn('yt-dlp', args)
    let stderr = ''

    proc.on('error', (error) => {
      const message = error.code === 'ENOENT' ? '服务器未安装 yt-dlp' : '下载进程启动失败'
      console.error('[Video] download spawn failed:', message)
      if (!res.headersSent) {
        res.status(500).json({ error: message })
      } else if (!res.writableEnded) {
        res.end()
      }
    })

    proc.stderr.on('data', (data) => {
      const message = data.toString()
      stderr += message
      if (message.trim()) {
        console.error('[Video] download stderr:', message.trim())
      }
    })

    proc.stdout.pipe(res)

    proc.on('close', (code) => {
      if (code !== 0 && !res.writableEnded) {
        const { cookiesMeta } = buildCommonArgs(finalUrl)
        const finalMessage = normalizeVideoError(stderr, finalUrl, cookiesMeta)
        res.status(500).json({ error: `下载失败：${finalMessage}` })
      }
    })
  } catch (error) {
    const finalUrl = await resolveShareUrl(url)
    const { cookiesMeta } = buildCommonArgs(finalUrl)
    const finalMessage = normalizeVideoError(error.message, finalUrl, cookiesMeta)
    console.error('[Video] download failed:', finalMessage)
    if (!res.writableEnded) {
      res.status(500).json({ error: `下载失败：${finalMessage}` })
    }
  }
})

export default router

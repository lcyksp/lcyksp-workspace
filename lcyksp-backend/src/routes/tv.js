import { Router } from 'express'
import { createHash } from 'crypto'
import { spawn, execSync, execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { authMiddleware } from '../middleware/auth.js'
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
const TMP_ROOT = path.resolve(__dirname, '../../data/tv-downloads')

// 每次服务启动/更新重启时，自动彻底清理上一次运行残留的临时分片和未下载完的缓存文件
try {
  if (fs.existsSync(TMP_ROOT)) {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true })
    console.log('[TV] 成功清空历史遗留的临时下载分片与缓存目录')
  }
} catch (e) {
  console.error('[TV] 初始化清空缓存失败:', e.message)
}

var downloadTasks = new Map()

// 每 10 分钟自动清理一次超过 1 小时的历史临时任务目录及缓存，防止磁盘/内存泄漏
setInterval(function () {
  var now = Date.now()
  for (var [taskId, task] of downloadTasks.entries()) {
    if (now - task.createdAt > 3600000) { // 1 小时
      cleanupDir(task.workDir)
      downloadTasks.delete(taskId)
    }
  }
}, 600000)

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

var _hasFfprobe = null
function hasFfprobe() {
  if (_hasFfprobe !== null) return _hasFfprobe
  try {
    execSync('ffprobe -version', { stdio: 'ignore' })
    _hasFfprobe = true
  } catch {
    _hasFfprobe = false
    console.log('[TV] ffprobe 未安装')
  }
  return _hasFfprobe
}

var _hasYtDlp = null
var _ytDlpPath = null
function hasYtDlp() {
  if (_hasYtDlp !== null) return _hasYtDlp
  try {
    execSync('which yt-dlp', { stdio: 'ignore' })
    _ytDlpPath = 'yt-dlp'
    _hasYtDlp = true
  } catch {
    try {
      execSync('/usr/local/bin/yt-dlp --version', { stdio: 'ignore' })
      _ytDlpPath = '/usr/local/bin/yt-dlp'
      _hasYtDlp = true
    } catch {
      _hasYtDlp = false
      _ytDlpPath = ''
    }
  }
  return _hasYtDlp
}

async function downloadEpisodeWithYtDlp(inputPath, outputPath, concurrentFragments, speedLimit, onProgress) {
  var ytDlpBin = _ytDlpPath || 'yt-dlp'
  var args = [
    '--concurrent-fragments', String(concurrentFragments || 5),
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    '--add-header', 'Referer: ' + BASE_URL,
    '--add-header', 'Origin: ' + BASE_URL,
    '--no-mtime',
    '--remux-video', 'mp4',
    '-f', 'best',
    '-o', outputPath
  ]
  if (speedLimit) {
    args.push('--limit-rate', speedLimit)
  }
  args.push(inputPath)

  console.log('[TV] yt-dlp download:', ytDlpBin, args.join(' '))
  await runProcess(ytDlpBin, args, { stdio: ['ignore', 'pipe', 'pipe'] }, onProgress)
}

function ensureTmpRoot() {
  fs.mkdirSync(TMP_ROOT, { recursive: true })
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
  // shell 注入已在调用侧根除（execFileSync / spawn 都不经 shell），所以这里不过滤括号等字符，
  // 否则中文剧集名里的括号会被打成一串下划线。
  return (name || 'episode')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .trim() || 'episode'
}

function createWorkPaths(title) {
  ensureTmpRoot()
  var uniq = Date.now() + '-' + Math.random().toString(16).slice(2, 8)
  var dir = path.join(TMP_ROOT, uniq)
  fs.mkdirSync(dir, { recursive: true })

  var safeName = sanitizeFileName(title)
  return {
    dir: dir,
    outputPath: path.join(dir, safeName + '.mp4'),
    safeName: safeName
  }
}

function cleanupDir(dir) {
  if (!dir) return
  fs.rm(dir, { recursive: true, force: true }, function () {})
}

async function fetchText(url) {
  var response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer': BASE_URL + '/',
      'Origin': BASE_URL
    }
  })
  if (!response.ok) {
    throw new Error('拉取播放清单失败: HTTP ' + response.status)
  }
  return await response.text()
}

function absolutizeM3u8Line(baseUrl, line) {
  if (!line) return line
  if (line.startsWith('#')) {
    if (line.includes('URI=')) {
      return line.replace(/URI="([^"]+)"/g, function (_all, uri) {
        return 'URI="' + resolveUrl(baseUrl, uri) + '"'
      })
    }
    return line
  }
  return resolveUrl(baseUrl, line)
}

async function materializePlaylist(m3u8Url, workDir) {
  var playlistText = await fetchText(m3u8Url)
  var normalized = playlistText
    .split(/\r?\n/)
    .map(function (line) { return absolutizeM3u8Line(m3u8Url, line.trim()) })
    .join('\n')

  var playlistPath = path.join(workDir, 'playlist.m3u8')
  fs.writeFileSync(playlistPath, normalized, 'utf8')
  return playlistPath
}

function runProcess(command, args, options, onProgress) {
  return new Promise(function (resolve, reject) {
    var child = spawn(command, args, options)
    var stderr = ''

    if (child.stdout) {
      child.stdout.on('data', function (chunk) {
        var str = chunk.toString()
        if (onProgress) {
          onProgress(str)
        }
      })
    }

    if (child.stderr) {
      child.stderr.on('data', function (chunk) {
        var str = chunk.toString()
        stderr += str
        if (onProgress) {
          onProgress(str)
        }
      })
    }

    child.on('error', reject)
    child.on('close', function (code) {
      if (code === 0) resolve(stderr)
      else reject(new Error(stderr || command + ' exited with code ' + code))
    })
  })
}

async function probeMedia(outputPath) {
  if (!hasFfprobe()) return { ok: true, hasAudio: true, fallback: true }

  var args = [
    '-v', 'error',
    '-show_streams',
    '-show_format',
    '-of', 'json',
    outputPath
  ]
  var stdout = execFileSync('ffprobe', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 })
  var parsed = JSON.parse(stdout)
  var streams = parsed.streams || []
  return {
    ok: true,
    hasVideo: streams.some(function (s) { return s.codec_type === 'video' }),
    hasAudio: streams.some(function (s) { return s.codec_type === 'audio' }),
    streams: streams
  }
}

async function downloadEpisodeToFile(inputPath, outputPath, onProgress) {
  var isRemoteInput = /^https?:\/\//i.test(inputPath)
  var ffmpegArgs = [
    '-y',
    '-hide_banner',
    '-stats',
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
    '-allowed_extensions', 'ALL'
  ]

  if (isRemoteInput) {
    ffmpegArgs.push(
      '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      '-headers', 'Referer: ' + BASE_URL + '\r\nOrigin: ' + BASE_URL + '\r\n',
      '-http_persistent', '1',
      '-multiple_requests', '1',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-timeout', '15000000',      // 15 秒连接超时限制（微秒）
      '-rw_timeout', '15000000'    // 15 秒读写超时限制（微秒）
    )
  }

  ffmpegArgs.push(
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ac', '2',
    '-ar', '48000',
    '-movflags', '+faststart',
    '-max_muxing_queue_size', '4096',
    '-f', 'mp4',
    outputPath
  )

  console.log('[TV] ffmpeg download:', ffmpegArgs.join(' '))
  await runProcess('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'ignore', 'pipe'] }, onProgress)
}

async function fallbackToFfmpeg(m3u8Url, task) {
  if (!hasFfmpeg()) {
    throw new Error('服务器未安装 ffmpeg')
  }

  await downloadEpisodeToFile(m3u8Url, task.outputPath, function (progressText) {
    var now = Date.now()
    if (now - (task.lastLogTime || 0) > 15000) {
      console.log('[TV ffmpeg]', progressText.trim())
      task.lastLogTime = now
    }
    
    var sizeMatch = progressText.match(/size=\s*(\d+\s*[a-zA-Z]+|N\/A)/i)
    var timeMatch = progressText.match(/time=\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/i)
    var speedMatch = progressText.match(/speed=\s*(\d+(?:\.\d+)?x)/i)
    if (sizeMatch || timeMatch || speedMatch) {
      var sizeRaw = sizeMatch ? sizeMatch[1] : (task.progress?.size || '0kB')
      if (sizeRaw.endsWith('kB') || sizeRaw.endsWith('KB')) {
        var kb = parseInt(sizeRaw)
        if (!isNaN(kb)) {
          sizeRaw = (kb / 1024).toFixed(1) + 'MB'
        }
      }
      
      task.progress = {
        size: sizeRaw,
        time: timeMatch ? timeMatch[1] : (task.progress?.time || '00:00:00'),
        speed: speedMatch ? speedMatch[1] : (task.progress?.speed || '0x')
      }
    }
  })
}

var activeDownloadsCount = 0
const CONCURRENCY_LIMIT = 2

function processQueue() {
  if (activeDownloadsCount >= CONCURRENCY_LIMIT) {
    return
  }

  var queuedTasks = []
  for (var [taskId, task] of downloadTasks.entries()) {
    if (task.status === 'queued') {
      queuedTasks.push(task)
    }
  }

  if (queuedTasks.length === 0) {
    return
  }

  queuedTasks.sort(function (a, b) {
    if (b.priority !== a.priority) {
      return b.priority - a.priority
    }
    return a.createdAt - b.createdAt
  })

  var taskToStart = queuedTasks[0]
  taskToStart.status = 'downloading'
  activeDownloadsCount++
  
  updateQueuePositions()
  runDownloadTask(taskToStart)
}

function updateQueuePositions() {
  var queuedTasks = []
  for (var [taskId, task] of downloadTasks.entries()) {
    if (task.status === 'queued') {
      queuedTasks.push(task)
    }
  }

  queuedTasks.sort(function (a, b) {
    if (b.priority !== a.priority) {
      return b.priority - a.priority
    }
    return a.createdAt - b.createdAt
  })

  queuedTasks.forEach(function (task, index) {
    task.progress = {
      size: '排队中...',
      speed: '等待中',
      time: '排在第 ' + (index + 1) + ' 位'
    }
  })
}

async function runDownloadTask(task) {
  var m3u8Url = task.m3u8Url
  var taskId = task.id

  try {
    if (hasYtDlp()) {
      try {
        console.log('[TV Task] 使用 yt-dlp 并发下载:', task.safeName, 'priority:', task.priority, 'fragments:', task.concurrentFragments)
        await downloadEpisodeWithYtDlp(
          m3u8Url,
          task.outputPath,
          task.concurrentFragments,
          task.speedLimit,
          function (progressText) {
            var now = Date.now()
            if (now - (task.lastLogTime || 0) > 15000) {
              console.log('[TV yt-dlp]', progressText.trim())
              task.lastLogTime = now
            }
            
            var percentMatch = progressText.match(/\[download\]\s+(\d+(\.\d+)?)%/)
            var sizeMatch = progressText.match(/of\s+(?:~\s*)?(\d+(?:\.\d+)?[KMG]?i?B)/i)
            var speedMatch = progressText.match(/at\s+(\d+(?:\.\d+)?[KMG]?i?B\/s)/i)
            var etaMatch = progressText.match(/ETA\s+(\d{2}:\d{2}(?::\d{2})?)/i)
            
            if (percentMatch || sizeMatch || speedMatch || etaMatch) {
              var pct = percentMatch ? percentMatch[1] + '%' : ''
              var sz = sizeMatch ? sizeMatch[1] : ''
              var sp = speedMatch ? speedMatch[1] : ''
              var eta = etaMatch ? etaMatch[1] : ''
              
              task.progress = {
                size: pct && sz ? `${pct} (${sz})` : (sz || '0MB'),
                speed: sp || '0x',
                time: eta ? `ETA ${eta}` : '00:00:00'
              }
            }
          }
        )
      } catch (ytDlpErr) {
        console.warn('[TV Task] yt-dlp 下载失败，尝试回退到 ffmpeg:', ytDlpErr.message)
        if (fs.existsSync(task.outputPath)) {
          fs.rmSync(task.outputPath, { force: true })
        }
        await fallbackToFfmpeg(m3u8Url, task)
      }
    } else {
      await fallbackToFfmpeg(m3u8Url, task)
    }

    var stat = fs.statSync(task.outputPath)
    if (!stat.size) {
      throw new Error('输出文件为空，下载未成功完成')
    }

    var mediaInfo = await probeMedia(task.outputPath)
    if (!mediaInfo.hasVideo) {
      throw new Error('输出文件缺少视频流')
    }

    console.log('[TV Task] 下载完成:', task.safeName, 'size=', stat.size, 'audio=', mediaInfo.hasAudio)
    task.status = 'completed'
  } catch (err) {
    console.error('[TV Task] 下载失败:', err.message)
    task.status = 'failed'
    task.error = err.message
    cleanupDir(task.workDir)
  } finally {
    activeDownloadsCount--
    processQueue()
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
      // 1. 关键词搜索模式 (对接苹果CMS量子资源/非凡资源公共API)
      console.log('[TV] 搜索剧集关键词:', url)
      var searchUrl = `http://cj.ffzyapi.com/api.php/provide/vod/?ac=detail&wd=${encodeURIComponent(url)}`
      var searchRes = await fetch(searchUrl)
      var searchJson = await searchRes.json()
      var list = searchJson.list || []
      
      if (list.length === 0) {
        return res.status(404).json({ error: `未搜索到与 "${url}" 相关的剧集资源` })
      }

      var item = list.find(function (v) { return v.vod_name === url }) || list[0]
      var title = item.vod_name
      var cover = item.vod_pic || ''

      var playUrls = item.vod_play_url || ''
      var playFroms = item.vod_play_from || ''
      
      var playFromList = playFroms.split('$$$')
      var playUrlList = playUrls.split('$$$')
      
      var sourceIdx = playFromList.findIndex(function (f) { return f.toLowerCase().includes('m3u8') })
      if (sourceIdx === -1) sourceIdx = 0
      
      var episodesRaw = playUrlList[sourceIdx] || ''
      var episodes = episodesRaw.split('#').map(function (epStr) {
        var parts = epStr.split('$')
        return {
          name: parts[0] || '第一集',
          m3u8Url: parts[1] || ''
        }
      }).filter(function (ep) { return ep.m3u8Url })

      console.log('[TV] 搜索解析成功:', title, '-', episodes.length, '集')

      return res.json({
        title: title,
        cover: cover,
        sourceName: playFromList[sourceIdx] || '量子/非凡源',
        sourceCount: playFromList.length,
        sources: playFromList.map(function (name, i) {
          return { name: name, count: (playUrlList[i] || '').split('#').length }
        }),
        episodes: episodes
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

router.post('/download-episode', heavyLimiter, async function (req, res, next) {
  try {
    var { m3u8Url, title } = req.body
    if (!m3u8Url) return res.status(400).json({ error: '缺少 m3u8Url' })

    const quotaCheck = await enforceTvQuota(req, ACTION_DOWNLOAD)
    if (!quotaCheck.allowed) {
      return res.status(429).json({
        error: quotaCheck.message,
        quota: quotaCheck.quota,
      })
    }

    if (!m3u8Url.startsWith('http')) {
      m3u8Url = BASE_URL + (m3u8Url.startsWith('/') ? '' : '/') + m3u8Url
    }

    var taskId = Date.now() + '-' + Math.random().toString(16).slice(2, 8)
    var work = createWorkPaths(title)

    var role = req.user?.role || 'guest'
    var isPremium = req.user?.quotaPlan === 'premium'
    
    var priority = 1 // guest
    var concurrentFragments = 2
    var speedLimit = '1.5M'

    if (role === 'admin' || role === 'pro') {
      priority = 4
      concurrentFragments = 16
      speedLimit = null // unlimited
    } else if (role === 'premium' || isPremium) {
      priority = 3
      concurrentFragments = 8
      speedLimit = '12M'
    } else if (req.user?.userId) {
      priority = 2
      concurrentFragments = 4
      speedLimit = '4M'
    }

    downloadTasks.set(taskId, {
      id: taskId,
      status: 'queued',
      title: title,
      m3u8Url: m3u8Url,
      outputPath: work.outputPath,
      workDir: work.dir,
      safeName: work.safeName,
      createdAt: Date.now(),
      lastLogTime: 0,
      priority: priority,
      concurrentFragments: concurrentFragments,
      speedLimit: speedLimit,
      progress: {
        size: '排队中...',
        speed: '等待中',
        time: '正在加入队列'
      }
    })

    updateQueuePositions()
    processQueue()

    res.json({ taskId: taskId, status: 'queued' })
  } catch (err) {
    next(err)
  }
})

router.get('/download-status/:taskId', function (req, res) {
  var taskId = req.params.taskId
  var task = downloadTasks.get(taskId)
  if (!task) return res.status(404).json({ error: '任务不存在' })

  res.json({
    status: task.status,
    error: task.error,
    progress: task.progress
  })
})

router.get('/download-file/:taskId', function (req, res, next) {
  var taskId = req.params.taskId
  var task = downloadTasks.get(taskId)
  if (!task) return res.status(404).json({ error: '任务不存在' })

  if (task.status !== 'completed') {
    return res.status(400).json({ error: '任务尚未完成' })
  }

  var fileSize = 0
  try {
    fileSize = fs.statSync(task.outputPath).size
  } catch {}

  res.download(task.outputPath, task.safeName + '.mp4', function (err) {
    if (!err) {
      logDownload({
        userId: req.user?.userId || null,
        username: req.user?.username || 'guest',
        ipAddress: getClientIp(req),
        downloadType: 'tv',
        resourceTitle: task.title || task.safeName || '未知电视剧',
        resourceUrl: '',
        fileSize: fileSize
      })
    }
    cleanupDir(task.workDir)
    downloadTasks.delete(taskId)
    if (err && !res.headersSent) next(err)
    else if (err) console.error('[TV Task] 发送文件失败:', err.message)
  })
})

export default router

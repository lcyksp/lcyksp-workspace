import { Router } from 'express'
import { getDb } from '../config/db.js'
import { authMiddleware } from '../middleware/auth.js'
import { fetchBilibiliHot, fetchBilibiliSearchCount } from '../utils/trends/bilibili.js'
import { fetchDouyinHot, fetchDouyinSearchCount } from '../utils/trends/douyin.js'
import { fetchXiaohongshuHot, fetchXiaohongshuSearchCount } from '../utils/trends/xiaohongshu.js'

const router = Router()

// 热点趋势服务已下架调整，短路拦截所有接口请求
router.use((req, res, next) => {
  return res.status(503).json({ error: '热点趋势服务暂时停止' })
})

router.use(authMiddleware)
router.use((req, res, next) => {
  console.log('[Trends] user:', req.user?.username, 'role:', req.user?.role)
  if (!req.user || req.user.username !== 'lcyksp') {
    return res.status(403).json({ error: '无权限访问', user: req.user?.username || 'null' })
  }
  next()
})

const hotCache = new Map()
const CACHE_TTL = 10 * 60 * 1000

function getCached(key) {
  const item = hotCache.get(key)
  if (!item) return null
  if (Date.now() - item.ts > CACHE_TTL) { hotCache.delete(key); return null }
  return item.data
}

function setCache(key, data) {
  hotCache.set(key, { data, ts: Date.now() })
}

router.get('/hot', async (req, res, next) => {
  try {
    const platform = req.query.platform || 'all'
    const results = {}

    const fetches = []
    if (platform === 'all' || platform === 'bilibili') {
      fetches.push(
        (async () => {
          const cached = getCached('bilibili_hot')
          if (cached) { results.bilibili = cached; return }
          const data = await fetchBilibiliHot()
          setCache('bilibili_hot', data)
          results.bilibili = data
        })()
      )
    }
    if (platform === 'all' || platform === 'douyin') {
      fetches.push(
        (async () => {
          const cached = getCached('douyin_hot')
          if (cached) { results.douyin = cached; return }
          const data = await fetchDouyinHot()
          setCache('douyin_hot', data)
          results.douyin = data
        })()
      )
    }
    if (platform === 'all' || platform === 'xiaohongshu') {
      fetches.push(
        (async () => {
          const cached = getCached('xhs_hot')
          if (cached) { results.xiaohongshu = cached; return }
          const data = await fetchXiaohongshuHot()
          setCache('xhs_hot', data)
          results.xiaohongshu = data
        })()
      )
    }

    await Promise.allSettled(fetches)
    res.json({ success: true, data: results })
  } catch (err) {
    next(err)
  }
})

router.get('/search', async (req, res, next) => {
  try {
    const keyword = String(req.query.q || '').trim()
    const platform = req.query.platform || 'bilibili'
    if (!keyword) return res.json({ results: [] })

    console.log('[Trends] search:', keyword, 'platform:', platform)

    const cacheKey = `search_${platform}_${keyword}`
    const cached = getCached(cacheKey)
    if (cached && cached[0]?.count > 0) {
      console.log('[Trends] cached result:', cached)
      return res.json({ results: cached })
    }
    hotCache.delete(cacheKey)

    let result = null
    if (platform === 'bilibili') result = await fetchBilibiliSearchCount(keyword)
    else if (platform === 'douyin') result = await fetchDouyinSearchCount(keyword)
    else if (platform === 'xiaohongshu') result = await fetchXiaohongshuSearchCount(keyword)

    console.log('[Trends] search result:', result)

    if (result && result.count > 0) {
      setCache(cacheKey, [result])
      const db = getDb()
      await new Promise((resolve, reject) => {
        db.run(
          'INSERT INTO trend_snapshots (platform, keyword, rank, score, extra) VALUES (?, ?, 0, ?, ?)',
          [platform, keyword, result.count || 0, JSON.stringify(result)],
          (err) => err ? reject(err) : resolve()
        )
      })
    } else {
      hotCache.delete(cacheKey)
    }

    res.json({ results: result ? [result] : [] })
  } catch (err) {
    console.error('[Trends] search error:', err)
    next(err)
  }
})

router.get('/history', async (req, res, next) => {
  try {
    const keyword = String(req.query.q || '').trim()
    const platform = req.query.platform || 'bilibili'
    const days = Math.min(parseInt(req.query.days, 10) || 7, 30)
    if (!keyword) return res.json({ history: [] })

    const db = getDb()
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT keyword, rank, score, extra, created_at
         FROM trend_snapshots
         WHERE keyword = ? AND platform = ?
           AND created_at >= datetime('now', '-${days} days')
         ORDER BY created_at ASC`,
        [keyword, platform],
        (err, rows) => err ? reject(err) : resolve(rows || [])
      )
    })

    res.json({ history: rows })
  } catch (err) {
    next(err)
  }
})

router.get('/snapshot', async (req, res, next) => {
  try {
    const db = getDb()
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT platform, keyword, rank, score, created_at
         FROM trend_snapshots
         WHERE id IN (
           SELECT MAX(id) FROM trend_snapshots GROUP BY platform, keyword
         )
         ORDER BY platform, rank
         LIMIT 200`,
        [],
        (err, rows) => err ? reject(err) : resolve(rows || [])
      )
    })

    const grouped = { bilibili: [], douyin: [], xiaohongshu: [] }
    for (const row of rows) {
      const key = row.platform === 'xiaohongshu' ? 'xiaohongshu' : row.platform
      if (grouped[key]) {
        grouped[key].push({
          keyword: row.keyword,
          rank: row.rank,
          score: row.score,
          updatedAt: row.created_at,
        })
      }
    }

    res.json({ data: grouped })
  } catch (err) {
    next(err)
  }
})

export default router

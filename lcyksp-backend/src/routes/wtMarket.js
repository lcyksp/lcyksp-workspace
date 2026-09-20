// 战争雷霆（Gaijin 交易所）物品价格监控路由。
//
// 权限：查询类（items/trend/status）对高级用户开放（requirePremiumOrAdmin，与 GitHub 日报同级）；
//   配置凭据 / 手动刷新对管理员开放（requireAdmin）——数据源是站长个人 Gaijin 账号。
//
// 搜索走本地库（每天全目录快照，任意物品都有历史），不实时打 Gaijin，省资源也快。
import { Router } from 'express'
import { getDb } from '../config/db.js'
import { authMiddleware, requireAuth } from '../middleware/auth.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { requirePremiumOrAdmin } from '../middleware/access.js'
import {
  saveCredentials,
  getStoredCredentials,
  getSnapshotStatus,
  loginAndGetJwt,
  runDailySnapshot,
  computePriceChange,
  computeMovers,
  beijingDate,
  logOp,
  getRecentLogs,
  WtMarketError,
} from '../utils/wtMarket.js'

const router = Router()
router.use(authMiddleware)
router.use(requireAuth)
router.use(requirePremiumOrAdmin)

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => getDb().get(sql, params, (err, row) => (err ? reject(err) : resolve(row))))
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => getDb().all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))))
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => getDb().run(sql, params, function onRun(err) {
    if (err) return reject(err)
    resolve({ changes: this.changes, lastID: this.lastID })
  }))
}

function parseJson(value, fallback) {
  try { return JSON.parse(value) } catch { return fallback }
}

// 手动刷新限流：仿 algs，10 分钟一次（全站共享，管理员操作）
let lastRefreshAt = 0
const REFRESH_COOLDOWN_MS = 10 * 60 * 1000

// 涨跌榜按北京自然日缓存：同一天所有高级用户共用一次计算，避免每次访问都聚合全库
let moversCache = { date: '', data: null }

/** WtMarketError → HTTP 状态码。 */
function sendWtError(res, err) {
  if (!(err instanceof WtMarketError)) return false
  if (err.code === 'AUTH_FAILED' || err.code === 'NO_CREDENTIALS') { res.status(400).json({ error: err.message }); return true }
  if (err.code === 'NETWORK') { res.status(504).json({ error: err.message }); return true }
  // 出口 IP 被人机验证拦 / 被限流：都是「换个出口或稍后再试」的暂态，用 503 与上游硬错误区分
  if (err.code === 'RECAPTCHA' || err.code === 'RATE_LIMITED') { res.status(503).json({ error: err.message }); return true }
  res.status(502).json({ error: err.message })
  return true
}

// ---------- 状态 ----------

router.get('/status', async (_req, res, next) => {
  try {
    res.json(await getSnapshotStatus())
  } catch (err) {
    next(err)
  }
})

// ---------- 物品搜索（走本地库，附最新买/卖价 + 涨跌） ----------

router.get('/items', async (req, res, next) => {
  try {
    const query = String(req.query.query || '').trim()
    // all=1：一次性全量精简目录，供前端本地即时过滤（关键词/类型/价格区间），零后端往返
    const all = String(req.query.all || '') === '1'
    const limit = all ? 100000 : Math.min(Math.max(Number(req.query.limit) || 40, 1), 100)
    const skip = all ? 0 : Math.max(Number(req.query.skip) || 0, 0)

    // 取每个物品的最新一条快照 join 出来；有搜索词时按显示名/market_name 模糊匹配
    const where = query ? 'WHERE (i.display_name LIKE ? OR i.market_name LIKE ?)' : ''
    const params = query ? [`%${query}%`, `%${query}%`, limit, skip] : [limit, skip]
    const rows = await dbAll(
      `SELECT i.id, i.market_name, i.display_name, i.icon_url, i.tags, i.color,
              s.buy_price, s.sell_price, s.buy_count, s.sell_count, s.snapshot_date
       FROM wt_market_items i
       LEFT JOIN wt_price_snapshots s ON s.id = (
         SELECT id FROM wt_price_snapshots WHERE item_id = i.id ORDER BY snapshot_date DESC LIMIT 1
       )
       ${where}
       ORDER BY s.sell_price DESC NULLS LAST, i.display_name COLLATE NOCASE
       LIMIT ? OFFSET ?`,
      params,
    )

    const items = rows.map((row) => ({
      id: row.id,
      marketName: row.market_name,
      displayName: row.display_name,
      iconUrl: row.icon_url,
      tags: parseJson(row.tags, []),
      color: row.color,
      buyPrice: row.buy_price,
      sellPrice: row.sell_price,
      buyCount: row.buy_count,
      sellCount: row.sell_count,
      snapshotDate: row.snapshot_date,
    }))
    res.json({ items })
  } catch (err) {
    // 搜索/取目录出错单独记一条，便于事后区分「是搜索坏了还是登录/爬取坏了」
    void logOp('search', { trigger: 'user', status: 'fail', detail: `query=${String(req.query.query || '').slice(0, 60)} ${err.message}` })
    next(err)
  }
})

// ---------- 管理员：操作日志（诊断） ----------

router.get('/logs', requireAdmin, async (req, res, next) => {
  try {
    const logs = await getRecentLogs(Number(req.query.limit) || 50)
    res.json({ logs })
  } catch (err) {
    next(err)
  }
})

// ---------- 收藏（每用户；前端拉 id 列表做置顶 + 筛选） ----------

// 当前用户的收藏物品 id 列表
router.get('/favorites', async (req, res, next) => {
  try {
    const rows = await dbAll('SELECT item_id FROM wt_market_favorites WHERE user_id = ? ORDER BY created_at DESC', [req.user.userId])
    res.json({ itemIds: rows.map((r) => r.item_id) })
  } catch (err) {
    next(err)
  }
})

// 收藏一件（幂等：已收藏再点不报错）
router.post('/favorites/:itemId', async (req, res, next) => {
  try {
    const itemId = Number(req.params.itemId)
    if (!Number.isInteger(itemId) || itemId <= 0) return res.status(400).json({ error: '物品 ID 无效' })
    const item = await dbGet('SELECT id FROM wt_market_items WHERE id = ?', [itemId])
    if (!item) return res.status(404).json({ error: '物品不存在' })
    await dbRun('INSERT OR IGNORE INTO wt_market_favorites (user_id, item_id) VALUES (?, ?)', [req.user.userId, itemId])
    res.json({ ok: true, favorited: true })
  } catch (err) {
    next(err)
  }
})

// 取消收藏（幂等）
router.delete('/favorites/:itemId', async (req, res, next) => {
  try {
    const itemId = Number(req.params.itemId)
    if (!Number.isInteger(itemId) || itemId <= 0) return res.status(400).json({ error: '物品 ID 无效' })
    await dbRun('DELETE FROM wt_market_favorites WHERE user_id = ? AND item_id = ?', [req.user.userId, itemId])
    res.json({ ok: true, favorited: false })
  } catch (err) {
    next(err)
  }
})

// ---------- 单物品价格走势 ----------

router.get('/trend/:itemId', async (req, res, next) => {
  try {
    const itemId = Number(req.params.itemId)
    if (!Number.isInteger(itemId) || itemId <= 0) return res.status(400).json({ error: '物品 ID 无效' })

    const item = await dbGet('SELECT id, market_name, display_name, icon_url, tags, color FROM wt_market_items WHERE id = ?', [itemId])
    if (!item) return res.status(404).json({ error: '物品不存在' })

    const series = await dbAll(
      `SELECT snapshot_date, buy_price, sell_price, buy_count, sell_count
       FROM wt_price_snapshots WHERE item_id = ? ORDER BY snapshot_date ASC`,
      [itemId],
    )
    res.json({
      item: {
        id: item.id,
        marketName: item.market_name,
        displayName: item.display_name,
        iconUrl: item.icon_url,
        tags: parseJson(item.tags, []),
        color: item.color,
      },
      series,
      change: computePriceChange(series),
    })
  } catch (err) {
    next(err)
  }
})

// ---------- 涨跌榜（过去 3 天卖价涨最多 / 买价跌最快，各 5 件，每日滚动） ----------

router.get('/movers', async (_req, res, next) => {
  try {
    const today = beijingDate()
    if (moversCache.date === today && moversCache.data) return res.json(moversCache.data)

    // 拉最近约 8 天窗口（宽于 3 天，兜住缺日），按物品聚合成升序 series
    const rows = await dbAll(
      `SELECT s.item_id, s.snapshot_date, s.buy_price, s.sell_price,
              i.display_name, i.icon_url, i.color, i.market_name
       FROM wt_price_snapshots s
       JOIN wt_market_items i ON i.id = s.item_id
       WHERE s.snapshot_date >= date('now', '-8 days')
       ORDER BY s.item_id ASC, s.snapshot_date ASC`,
    )
    const byItem = new Map()
    for (const r of rows) {
      let it = byItem.get(r.item_id)
      if (!it) {
        it = { id: r.item_id, displayName: r.display_name, iconUrl: r.icon_url, color: r.color, marketName: r.market_name, series: [] }
        byItem.set(r.item_id, it)
      }
      it.series.push({ snapshot_date: r.snapshot_date, buy_price: r.buy_price, sell_price: r.sell_price })
    }
    const data = computeMovers([...byItem.values()], { windowDays: 3, topN: 5 })
    moversCache = { date: today, data }
    res.json(data)
  } catch (err) {
    next(err)
  }
})

// ---------- 管理员：配置凭据 ----------

router.post('/credentials', requireAdmin, async (req, res, next) => {
  try {
    const login = String(req.body?.login || '').trim()
    const password = String(req.body?.password || '')
    if (!login || !password) return res.status(400).json({ error: '请填写 Gaijin 邮箱和密码' })
    if (login.length > 160 || password.length > 160) return res.status(400).json({ error: '邮箱或密码过长' })

    // 先存再验证登录：验证失败也保留凭据（便于改正），但如实回报
    await saveCredentials(login, password)
    try {
      await loginAndGetJwt(true, 'manual-cred')
    } catch (err) {
      if (err instanceof WtMarketError) return res.status(200).json({ ok: false, verified: false, error: err.message })
      throw err
    }
    res.json({ ok: true, verified: true })
  } catch (err) {
    next(err)
  }
})

// ---------- 管理员：手动触发一次快照 ----------

router.post('/refresh', requireAdmin, async (req, res, next) => {
  try {
    const creds = await getStoredCredentials()
    if (!creds) return res.status(400).json({ error: '请先配置 Gaijin 账号凭据' })

    const waitMs = REFRESH_COOLDOWN_MS - (Date.now() - lastRefreshAt)
    if (waitMs > 0) return res.status(429).json({ error: `请 ${Math.ceil(waitMs / 60000)} 分钟后再试`, retryAfterSeconds: Math.ceil(waitMs / 1000) })
    lastRefreshAt = Date.now()

    try {
      const result = await runDailySnapshot('manual')
      moversCache = { date: '', data: null } // 新快照落库，涨跌榜缓存失效，下次访问重算
      res.json({ ok: true, ...result })
    } catch (err) {
      if (sendWtError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

export default router

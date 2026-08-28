import { Router } from 'express'
import { getDb } from '../config/db.js'
import { authMiddleware, requireAuth } from '../middleware/auth.js'
import { requirePremiumOrAdmin } from '../middleware/access.js'
import { sendGithubTestEmail } from '../utils/githubMail.js'

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
    resolve({ lastID: this.lastID, changes: this.changes })
  }))
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value)
    return parsed
  } catch {
    return fallback
  }
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''
}

function normalizeList(value, max = 30) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[,，\n]/)
  return [...new Set(source.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, max)
}

function serializeSubscription(row) {
  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    categoryIds: parseJson(row.category_ids, []),
    keywords: parseJson(row.keywords, []),
    frequencies: parseJson(row.frequencies, ['daily']),
    status: row.status,
    lastTestSentAt: row.last_test_sent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

router.get('/categories', async (_req, res, next) => {
  try {
    const rows = await dbAll('SELECT id, name, description, keywords, languages FROM github_categories WHERE enabled = 1 ORDER BY name COLLATE NOCASE')
    res.json({ categories: rows.map((row) => ({ ...row, keywords: parseJson(row.keywords, []), languages: parseJson(row.languages, []) })) })
  } catch (error) {
    next(error)
  }
})

router.get('/', async (req, res, next) => {
  try {
    const rows = await dbAll('SELECT * FROM github_subscriptions WHERE user_id = ? ORDER BY id DESC', [req.user.userId])
    res.json({ subscriptions: rows.map(serializeSubscription) })
  } catch (error) {
    next(error)
  }
})

router.post('/', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email)
    if (!email) return res.status(400).json({ error: '请输入有效的接收邮箱' })
    const categoryIds = normalizeList(req.body?.categoryIds, 20).map((value) => Number(value)).filter(Number.isInteger)
    const keywords = normalizeList(req.body?.keywords, 30)
    const frequencies = normalizeList(req.body?.frequencies, 3).filter((value) => ['daily', 'weekly', 'monthly'].includes(value))
    if (!categoryIds.length && !keywords.length) return res.status(400).json({ error: '请至少选择一个方向或填写一个关键词' })
    if (!frequencies.length) return res.status(400).json({ error: '请至少选择一种推送频率' })

    const existing = await dbGet('SELECT id, status FROM github_subscriptions WHERE user_id = ? AND email = ?', [req.user.userId, email])
    const now = new Date().toISOString()
    if (existing) {
      await dbRun(
        'UPDATE github_subscriptions SET category_ids = ?, keywords = ?, frequencies = ?, updated_at = ? WHERE id = ?',
        [JSON.stringify(categoryIds), JSON.stringify(keywords), JSON.stringify(frequencies), now, existing.id],
      )
      const row = await dbGet('SELECT * FROM github_subscriptions WHERE id = ?', [existing.id])
      return res.json({ subscription: serializeSubscription(row) })
    }
    const result = await dbRun(
      'INSERT INTO github_subscriptions (user_id, email, category_ids, keywords, frequencies, status, updated_at) VALUES (?, ?, ?, ?, ?, \'pending\', ?)',
      [req.user.userId, email, JSON.stringify(categoryIds), JSON.stringify(keywords), JSON.stringify(frequencies), now],
    )
    const row = await dbGet('SELECT * FROM github_subscriptions WHERE id = ?', [result.lastID])
    res.status(201).json({ subscription: serializeSubscription(row) })
  } catch (error) {
    next(error)
  }
})

router.post('/:id/test-email', async (req, res, next) => {
  try {
    const subscription = await dbGet('SELECT * FROM github_subscriptions WHERE id = ? AND user_id = ?', [req.params.id, req.user.userId])
    if (!subscription) return res.status(404).json({ error: '订阅不存在' })
    const last = subscription.last_test_sent_at ? new Date(subscription.last_test_sent_at).getTime() : 0
    const waitMs = 3 * 60 * 1000 - (Date.now() - last)
    if (waitMs > 0) return res.status(429).json({ error: `请 ${Math.ceil(waitMs / 1000)} 秒后再试`, retryAfterSeconds: Math.ceil(waitMs / 1000) })

    const recentUser = await dbGet("SELECT COUNT(*) AS count FROM github_email_delivery_logs WHERE user_id = ? AND kind = 'test' AND created_at >= datetime('now', '-1 hour')", [req.user.userId])
    if (Number(recentUser?.count || 0) >= 3) return res.status(429).json({ error: '测试邮件发送过于频繁，请稍后再试' })
    const recentEmail = await dbGet("SELECT COUNT(*) AS count FROM github_email_delivery_logs WHERE email = ? AND kind = 'test' AND created_at >= datetime('now', '-1 hour')", [subscription.email])
    if (Number(recentEmail?.count || 0) >= 3) return res.status(429).json({ error: '该邮箱近期测试次数过多，请稍后再试' })

    const now = new Date().toISOString()
    try {
      await sendGithubTestEmail(subscription.email)
      await dbRun('UPDATE github_subscriptions SET last_test_sent_at = ?, updated_at = ? WHERE id = ?', [now, now, subscription.id])
      await dbRun('INSERT INTO github_email_delivery_logs (subscription_id, user_id, email, kind, status) VALUES (?, ?, ?, \'test\', \'success\')', [subscription.id, req.user.userId, subscription.email])
      return res.json({ success: true, message: '测试邮件已发送，请检查收件箱和垃圾邮件目录' })
    } catch (error) {
      console.error('[GitHub Radar] test email route failed:', String(error?.message || 'unknown').slice(0, 300))
      await dbRun('INSERT INTO github_email_delivery_logs (subscription_id, user_id, email, kind, status, error_message) VALUES (?, ?, ?, \'test\', \'failed\', ?)', [subscription.id, req.user.userId, subscription.email, error.message || 'SMTP 发送失败'])
      return res.status(502).json({ error: '测试邮件发送失败，请稍后重试或联系客服' })
    }
  } catch (error) {
    next(error)
  }
})

router.post('/:id/activate', async (req, res, next) => {
  try {
    const row = await dbGet('SELECT * FROM github_subscriptions WHERE id = ? AND user_id = ?', [req.params.id, req.user.userId])
    if (!row) return res.status(404).json({ error: '订阅不存在' })
    if (!row.last_test_sent_at) return res.status(400).json({ error: '请先发送测试邮件并确认邮箱可正常接收' })
    await dbRun("UPDATE github_subscriptions SET status = 'active', updated_at = ? WHERE id = ?", [new Date().toISOString(), row.id])
    res.json({ subscription: serializeSubscription(await dbGet('SELECT * FROM github_subscriptions WHERE id = ?', [row.id])) })
  } catch (error) {
    next(error)
  }
})

router.post('/:id/status', async (req, res, next) => {
  try {
    const status = String(req.body?.status || '')
    if (!['active', 'paused', 'closed'].includes(status)) return res.status(400).json({ error: '不支持的订阅状态' })
    const result = await dbRun('UPDATE github_subscriptions SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?', [status, new Date().toISOString(), req.params.id, req.user.userId])
    if (!result.changes) return res.status(404).json({ error: '订阅不存在' })
    res.json({ subscription: serializeSubscription(await dbGet('SELECT * FROM github_subscriptions WHERE id = ?', [req.params.id])) })
  } catch (error) {
    next(error)
  }
})

router.delete('/:id', async (req, res, next) => {
  try {
    const result = await dbRun('DELETE FROM github_subscriptions WHERE id = ? AND user_id = ?', [req.params.id, req.user.userId])
    if (!result.changes) return res.status(404).json({ error: '订阅不存在' })
    res.json({ success: true })
  } catch (error) {
    next(error)
  }
})

export default router

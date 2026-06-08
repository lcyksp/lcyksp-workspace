import { Router } from 'express'
import { getDb } from '../config/db.js'
import { authMiddleware } from '../middleware/auth.js'

const router = Router()

router.use(authMiddleware)

function normalizeText(value, max = 2000) {
  return String(value || '').trim().slice(0, max)
}

router.post('/', async (req, res, next) => {
  try {
    const pageName = normalizeText(req.body?.pageName, 120)
    const featureName = normalizeText(req.body?.featureName, 120)
    const problemSummary = normalizeText(req.body?.problemSummary, 240)
    const details = normalizeText(req.body?.details, 4000)

    if (!pageName || !featureName || !problemSummary || !details) {
      return res.status(400).json({ error: '请把页面、功能、问题和具体情况都填写完整' })
    }

    const db = getDb()
    const reporterId = req.user?.userId || null
    const reporterName = req.user?.username || 'guest'

    await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO feedback_reports (page_name, feature_name, problem_summary, details, reporter_id, reporter_name) VALUES (?, ?, ?, ?, ?, ?)',
        [pageName, featureName, problemSummary, details, reporterId, reporterName],
        function (err) {
          if (err) return reject(err)
          resolve(this.lastID)
        },
      )
    })

    return res.json({
      success: true,
      message: '问题反馈已提交，我们会根据描述继续排查',
    })
  } catch (error) {
    next(error)
  }
})

export default router

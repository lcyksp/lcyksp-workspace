import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { COURSES, PERIODS, SEMESTER_START } from '../data/scheduleData.js'

const router = Router()

// 课程表仅管理员可见：数据不下发到前端 bundle，从这里按需取。
router.use(authMiddleware)
router.use(requireAdmin)

router.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store')
  res.json({
    semesterStart: SEMESTER_START,
    periods: PERIODS,
    courses: COURSES,
    serverTime: new Date().toISOString(),
  })
})

export default router

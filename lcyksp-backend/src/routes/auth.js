import { Router } from 'express'
import bcrypt from 'bcrypt'
import { getDb } from '../config/db.js'
import { authMiddleware, buildFreshUserPayload, requireAuth, signToken } from '../middleware/auth.js'
import { getRegistrationAttemptCount, recordRegistrationAttempt, roleToPlan } from '../utils/quota.js'
import { getClientIp, verifyTurnstileToken } from '../utils/turnstile.js'

const router = Router()
const SALT_ROUNDS = 10

router.use(authMiddleware)

function dbGet(sql, params = []) {
  const db = getDb()
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))
  })
}

function dbRun(sql, params = []) {
  const db = getDb()
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err)
      resolve({ id: this.lastID, changes: this.changes })
    })
  })
}

function buildUserPayload(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    quotaPlan: user.quota_plan || roleToPlan(user.role),
    groupId: user.group_id || null,
    premiumExpiresAt: user.premium_expires_at || null,
    isBanned: Boolean(user.is_banned),
    bannedReason: user.banned_reason || '',
  }
}

router.post('/register', async (req, res, next) => {
  try {
    const { username, password, turnstileToken } = req.body

    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' })
    }
    if (typeof username !== 'string' || username.length < 2 || username.length > 32) {
      return res.status(400).json({ error: '用户名长度需为 2-32 个字符' })
    }
    if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
      return res.status(400).json({ error: '密码长度需为 6-128 个字符' })
    }

    const clientIp = getClientIp(req)
    const attemptCount = await getRegistrationAttemptCount(clientIp)
    if (attemptCount >= 2) {
      return res.status(429).json({ error: '当前 IP 在这一小时内注册次数已达上限，请稍后再试' })
    }

    const turnstileResult = await verifyTurnstileToken(turnstileToken, clientIp)
    if (!turnstileResult.success) {
      return res.status(400).json({ error: turnstileResult.message || '人机验证未通过' })
    }

    const existing = await dbGet('SELECT id FROM users WHERE username = ?', [username])
    if (existing) {
      return res.status(409).json({ error: '用户名已被注册' })
    }

    const hashed = await bcrypt.hash(password, SALT_ROUNDS)
    await recordRegistrationAttempt(clientIp)

    const result = await dbRun(
      'INSERT INTO users (username, password, role, quota_plan) VALUES (?, ?, ?, ?)',
      [username.trim(), hashed, 'user', 'free'],
    )

    if (result.id === 1) {
      await dbRun("UPDATE users SET role = 'admin', quota_plan = 'admin' WHERE id = 1")
    }

    const user = await buildFreshUserPayload(result.id)
    const userPayload = {
      id: user.id,
      username: user.username,
      role: user.role,
      quotaPlan: user.quotaPlan,
      groupId: user.groupId,
      premiumExpiresAt: user.premiumExpiresAt,
      isBanned: user.isBanned,
      bannedReason: user.bannedReason,
    }
    const token = signToken({
      userId: userPayload.id,
      username: userPayload.username,
      role: userPayload.role,
      quotaPlan: userPayload.quotaPlan,
      groupId: userPayload.groupId,
    })

    res.status(201).json({ token, user: userPayload })
  } catch (err) {
    next(err)
  }
})

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await buildFreshUserPayload(req.user.userId)
    if (!user) {
      return res.status(404).json({ error: '用户不存在' })
    }

    res.json({
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        quotaPlan: user.quotaPlan,
        groupId: user.groupId,
        premiumExpiresAt: user.premiumExpiresAt,
        isBanned: user.isBanned,
        bannedReason: user.bannedReason,
      },
    })
  } catch (err) {
    next(err)
  }
})

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body

    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' })
    }

    const user = await dbGet(
      'SELECT id, username, password, role, quota_plan, group_id, premium_expires_at, is_banned, banned_reason FROM users WHERE username = ?',
      [username],
    )

    if (!user) {
      return res.status(401).json({ error: '用户名或密码错误' })
    }

    const valid = await bcrypt.compare(password, user.password)
    if (!valid) {
      return res.status(401).json({ error: '用户名或密码错误' })
    }

    if (user.is_banned) {
      return res.status(403).json({ error: user.banned_reason || '当前账号已被封禁' })
    }

    const freshUser = await buildFreshUserPayload(user.id)
    const userPayload = {
      id: freshUser.id,
      username: freshUser.username,
      role: freshUser.role,
      quotaPlan: freshUser.quotaPlan,
      groupId: freshUser.groupId,
      premiumExpiresAt: freshUser.premiumExpiresAt,
      isBanned: freshUser.isBanned,
      bannedReason: freshUser.bannedReason,
    }
    const token = signToken({
      userId: userPayload.id,
      username: userPayload.username,
      role: userPayload.role,
      quotaPlan: userPayload.quotaPlan,
      groupId: userPayload.groupId,
    })

    res.json({ token, user: userPayload })
  } catch (err) {
    next(err)
  }
})

export default router


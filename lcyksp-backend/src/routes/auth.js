import { Router } from 'express'
import bcrypt from 'bcrypt'
import { getDb } from '../config/db.js'
import { authMiddleware, buildFreshUserPayload, requireAuth, signToken } from '../middleware/auth.js'
import { getRegistrationAttemptCount, recordRegistrationAttempt, roleToPlan } from '../utils/quota.js'
import { clearLoginFailures, getLoginFailureCount, isLoginLocked, recordLoginFailure } from '../utils/loginGuard.js'
import { getClientIp, verifyTurnstileToken } from '../utils/turnstile.js'

const router = Router()
const SALT_ROUNDS = 10

// 预生成的哑 bcrypt 哈希（cost 10 与真实密码一致，单次比对耗时相同）。
// 用户不存在时也跑一次同代价比对再返回，否则响应时间差会被用来枚举「哪些用户名存在」。
const DUMMY_BCRYPT_HASH = '$2b$10$gaskz4Jv1nS7bmCBXnTOnOkmCGHrB80xED45CChyVcVTmg1y.Um6.'

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

    // 记录注册来源 IP，供后台「用户 IP」查看
    await dbRun("UPDATE users SET last_ip = ?, last_login_at = datetime('now') WHERE id = ?", [
      clientIp,
      result.id,
    ])

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

    // 账号维度锁定（SQLite 持久化，重启不清零）：达到阈值直接拒绝，不再执行 bcrypt。
    // 登录不做 Turnstile（移动端交互式挑战体验差）：暴力破解由此处「单账号 10 次/15 分钟」锁定拦；
    // Turnstile 只保留在注册（防批量注册机器人）。
    const failureCount = await getLoginFailureCount(username)
    if (isLoginLocked(failureCount)) {
      return res.status(429).json({ error: '尝试次数过多，请 15 分钟后再试' })
    }

    const clientIp = getClientIp(req)

    const user = await dbGet(
      'SELECT id, username, password, role, quota_plan, group_id, premium_expires_at, is_banned, banned_reason FROM users WHERE username = ?',
      [username],
    )

    let valid = false
    if (user) {
      valid = await bcrypt.compare(password, user.password)
    } else {
      await bcrypt.compare(password, DUMMY_BCRYPT_HASH)
    }

    if (!valid) {
      await recordLoginFailure(username)
      return res.status(401).json({ error: '用户名或密码错误' })
    }

    // 密码正确即清零失败计数（banned 账号也清：密码本身已被证明是对的）
    await clearLoginFailures(username)

    if (user.is_banned) {
      return res.status(403).json({ error: user.banned_reason || '当前账号已被封禁' })
    }

    // 记录本次登录 IP，供后台「用户 IP」查看
    await dbRun("UPDATE users SET last_ip = ?, last_login_at = datetime('now') WHERE id = ?", [
      clientIp,
      user.id,
    ])

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


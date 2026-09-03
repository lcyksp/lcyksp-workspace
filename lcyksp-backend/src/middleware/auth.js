import jwt from 'jsonwebtoken'
import { getDb } from '../config/db.js'
import { normalizeRole, roleToPlan } from '../utils/quota.js'

// 安全加固：生产环境必须显式注入 JWT_SECRET，缺失时拒绝启动，
// 避免回退到可预测的默认密钥导致任意用户 token 可被伪造。
function resolveJwtSecret() {
  const envSecret = process.env.JWT_SECRET
  if (envSecret && envSecret.trim().length >= 16) return envSecret.trim()
  if (process.env.NODE_ENV === 'production') {
    console.error('[安全] 生产环境必须设置 JWT_SECRET 环境变量（至少 16 字符），拒绝启动。')
    throw new Error('JWT_SECRET is required in production environment')
  }
  console.warn('[安全] 警告：未设置 JWT_SECRET，开发环境使用默认密钥，请勿用于生产。')
  return 'lcyksp-jwt-secret-dev-2026'
}

const JWT_SECRET = resolveJwtSecret()

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
      resolve({ changes: this.changes })
    })
  })
}

async function normalizeUserAccess(userId) {
  const user = await dbGet(
    'SELECT id, username, role, quota_plan, group_id, premium_expires_at, is_banned, banned_reason FROM users WHERE id = ?',
    [userId],
  )
  if (!user) return null

  if (user.is_banned) {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      quotaPlan: user.quota_plan,
      groupId: user.group_id || null,
      premiumExpiresAt: user.premium_expires_at || null,
      isBanned: true,
      bannedReason: user.banned_reason || '',
    }
  }

  if (user.role === 'premium' && user.premium_expires_at) {
    const expiresAt = new Date(user.premium_expires_at)
    if (!Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= Date.now()) {
      await dbRun(
        "UPDATE users SET role = 'user', quota_plan = 'free', premium_expires_at = NULL WHERE id = ?",
        [user.id],
      )
      user.role = 'user'
      user.quota_plan = 'free'
      user.premium_expires_at = null
    }
  }

  const role = normalizeRole(user.role)
  return {
    id: user.id,
    username: user.username,
    role,
    quotaPlan: user.quota_plan || roleToPlan(role),
    groupId: user.group_id || null,
    premiumExpiresAt: user.premium_expires_at || null,
    isBanned: Boolean(user.is_banned),
    bannedReason: user.banned_reason || '',
  }
}

export function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' })
}

export async function authMiddleware(req, res, next) {
  let token = null
  const authHeader = req.headers.authorization
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7)
  } else if (req.query.token) {
    token = req.query.token
  }

  console.log('[Auth] token present:', !!token, 'path:', req.path)

  if (!token) {
    req.user = null
    return next()
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    const user = await normalizeUserAccess(decoded.userId)
    if (!user) {
      req.user = null
      return next()
    }

    req.user = {
      userId: user.id,
      username: user.username,
      role: user.role,
      quotaPlan: user.quotaPlan,
      groupId: user.groupId,
      premiumExpiresAt: user.premiumExpiresAt,
      isBanned: user.isBanned,
      bannedReason: user.bannedReason,
    }
    console.log('[Auth] user:', user.username, 'role:', user.role)
  } catch (err) {
    console.log('[Auth] token verify failed:', err.message)
    req.user = null
  }
  next()
}

export function requireAuth(req, res, next) {
  if (!req.user || !req.user.userId) {
    return res.status(401).json({ error: '请先登录' })
  }
  if (req.user.isBanned) {
    return res.status(403).json({ error: req.user.bannedReason || '当前账号已被封禁' })
  }
  next()
}

export async function buildFreshUserPayload(userId) {
  return normalizeUserAccess(userId)
}

export default { signToken, authMiddleware, requireAuth, buildFreshUserPayload }

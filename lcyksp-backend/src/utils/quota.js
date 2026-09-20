import { getDb } from '../config/db.js'

export const ROLE_USER = 'user'
export const ROLE_PREMIUM = 'premium'
export const ROLE_PRO = 'pro'
export const ROLE_ADMIN = 'admin'

export const PLAN_FREE = 'free'
export const PLAN_PREMIUM = 'premium'
export const PLAN_PRO = 'pro'
export const PLAN_ADMIN = 'admin'

export const ACTION_ANALYZE = 'video_analyze'
export const ACTION_DOWNLOAD = 'video_download'

export const QUOTA_RULES = {
  guest: {
    [ACTION_ANALYZE]: { window: 'hour', limit: 2 },
    [ACTION_DOWNLOAD]: { window: 'hour', limit: 5 },
  },
  [PLAN_FREE]: {
    [ACTION_ANALYZE]: { window: 'hour', limit: 5 },
    [ACTION_DOWNLOAD]: { window: 'hour', limit: 5 },
  },
  [PLAN_PREMIUM]: {
    [ACTION_ANALYZE]: { window: 'hour', limit: 20 },
    [ACTION_DOWNLOAD]: { window: 'hour', limit: 40 },
  },
  [PLAN_PRO]: {
    [ACTION_ANALYZE]: { window: 'hour', limit: Number.POSITIVE_INFINITY },
    [ACTION_DOWNLOAD]: { window: 'hour', limit: Number.POSITIVE_INFINITY },
  },
  [PLAN_ADMIN]: {
    [ACTION_ANALYZE]: { window: 'hour', limit: Number.POSITIVE_INFINITY },
    [ACTION_DOWNLOAD]: { window: 'hour', limit: Number.POSITIVE_INFINITY },
  },
}

function pad(value) {
  return String(value).padStart(2, '0')
}

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
      resolve({ lastID: this.lastID, changes: this.changes })
    })
  })
}

export function normalizeRole(role) {
  if (role === ROLE_ADMIN) return ROLE_ADMIN
  if (role === ROLE_PRO) return ROLE_PRO
  if (role === ROLE_PREMIUM) return ROLE_PREMIUM
  return ROLE_USER
}

export function roleToPlan(role) {
  const normalized = normalizeRole(role)
  if (normalized === ROLE_ADMIN) return PLAN_ADMIN
  if (normalized === ROLE_PRO) return PLAN_PRO
  if (normalized === ROLE_PREMIUM) return PLAN_PREMIUM
  return PLAN_FREE
}

export function getWindowStart(now = new Date(), window = 'hour') {
  const date = new Date(now)
  if (window === 'day') {
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  }
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:00:00`
}

// 额度扣减的进程内互斥链：并发请求（双击/多人同时解析）在「查计数→判断→写计数」的
// await 间隙交错时，会同时查到空行并同时 INSERT，撞 usage_counters 唯一键
// （压测实测 12 并发挂 11）。把整段「检查+扣减」挂到同一条 Promise 链上串行化即可消除。
// 本站 PM2 为单 fork 实例，进程内互斥即全局互斥；若未来改 cluster 模式需升级为跨进程方案。
let quotaMutex = Promise.resolve()

export async function consumeQuota({ subjectType, subjectKey, action, amount = 1 }) {
  const run = quotaMutex.then(() => doConsumeQuota({ subjectType, subjectKey, action, amount }))
  // 链条吞掉单次失败（错误已随 run 抛给调用方），保证后续请求不被一次 DB 故障卡死
  quotaMutex = run.then(() => undefined, () => undefined)
  return run
}

async function doConsumeQuota({ subjectType, subjectKey, action, amount = 1 }) {
  const rules = QUOTA_RULES[subjectType] || QUOTA_RULES[PLAN_FREE]
  const rule = rules[action]

  if (!rule || !Number.isFinite(rule.limit)) {
    return {
      allowed: true,
      remaining: Number.POSITIVE_INFINITY,
      limit: Number.POSITIVE_INFINITY,
      used: 0,
      window: 'hour',
    }
  }

  const windowStart = getWindowStart(new Date(), rule.window)
  const existing = await dbGet(
    'SELECT id, count FROM usage_counters WHERE subject_type = ? AND subject_key = ? AND action = ? AND window_start = ?',
    [subjectType, subjectKey, action, windowStart],
  )

  const currentCount = existing?.count || 0
  if (currentCount + amount > rule.limit) {
    return {
      allowed: false,
      remaining: Math.max(0, rule.limit - currentCount),
      limit: rule.limit,
      used: currentCount,
      window: rule.window,
    }
  }

  if (existing) {
    await dbRun(
      "UPDATE usage_counters SET count = count + ?, updated_at = datetime('now') WHERE id = ?",
      [amount, existing.id],
    )
  } else {
    await dbRun(
      'INSERT INTO usage_counters (subject_type, subject_key, action, window_start, count) VALUES (?, ?, ?, ?, ?)',
      [subjectType, subjectKey, action, windowStart, amount],
    )
  }

  return {
    allowed: true,
    remaining: Math.max(0, rule.limit - currentCount - amount),
    limit: rule.limit,
    used: currentCount + amount,
    window: rule.window,
  }
}

export function buildQuotaExceededMessage(subjectType) {
  if (subjectType === 'guest') {
    return '当前时段体验次数已用完，请注册登录获得更多次数或稍后再试'
  }
  if (subjectType === 'free') {
    return '当前时段免费次数已用完，请购买高级账户获得更多次数或稍后再试'
  }
  return '当前时段次数已用完，如需更多次数请联系管理员'
}

export async function recordRegistrationAttempt(ipAddress) {
  const windowStart = getWindowStart(new Date(), 'hour')
  const existing = await dbGet(
    'SELECT id, count FROM registration_attempts WHERE ip_address = ? AND window_start = ?',
    [ipAddress, windowStart],
  )

  if (existing) {
    await dbRun(
      "UPDATE registration_attempts SET count = count + 1, updated_at = datetime('now') WHERE id = ?",
      [existing.id],
    )
    return existing.count + 1
  }

  await dbRun(
    'INSERT INTO registration_attempts (ip_address, window_start, count) VALUES (?, ?, 1)',
    [ipAddress, windowStart],
  )
  return 1
}

export async function getRegistrationAttemptCount(ipAddress) {
  const windowStart = getWindowStart(new Date(), 'hour')
  const existing = await dbGet(
    'SELECT count FROM registration_attempts WHERE ip_address = ? AND window_start = ?',
    [ipAddress, windowStart],
  )
  return existing?.count || 0
}

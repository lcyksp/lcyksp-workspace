// 微信步数修改（Zepp Life / 原小米运动）路由。
//
// 权限：整条链路只对高级用户开放（requirePremiumOrAdmin）——既能控量降低上游风控概率，
// 也把站点的责任范围收窄。站长 2026-09-15 拍板。
//
// 归属：Zepp 凭据严格绑定到当前登录的站点用户（step_accounts.user_id），
// 所有读写都带 user_id 过滤——换个账号登录看不到、也操作不了别人的 Zepp 账号。
//
// 凭据：是否保存密码由用户自己选（绑定表单的「保存账号密码」）。
//   - 勾选：密码 AES-256-CBC 加密落库（utils/crypto.js），可一键同步；
//   - 不勾选：只留账号名与状态，密码不落库，每次同步时现场输入、用完即弃。
// 任何情况下接口都不回传密码，列表只给脱敏账号和 has_password 标记。
import { Router } from 'express'
import { createHash } from 'crypto'
import { getDb } from '../config/db.js'
import { authMiddleware, requireAuth } from '../middleware/auth.js'
import { requirePremiumOrAdmin } from '../middleware/access.js'
import { encrypt, decrypt } from '../utils/crypto.js'
import { authorize, changeSteps, ZeppError, STEP_MAX, beijingDate } from '../utils/zeppLife.js'

const router = Router()

// 先解析 token（可选），再由各端点决定放行条件
router.use(authMiddleware)

/** 同一账号每天最多「成功」提交几次：防滥用，也顺带降低被 Zepp 风控的概率。 */
const DAILY_SUBMIT_LIMIT = 5

const STEP_PRESETS = [3000, 8000, 25000, 50000, 88800]

function dbAll(sql, params = []) {
  const db = getDb()
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))))
}

function dbGet(sql, params = []) {
  const db = getDb()
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))))
}

function dbRun(sql, params = []) {
  const db = getDb()
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())))
}

/** 脱敏展示：手机号保留头 3 尾 4，邮箱保留前 2 位与域名。 */
export function maskAccount(account) {
  const s = String(account || '')
  if (!s) return ''
  if (s.includes('@')) {
    const [name, domain] = s.split('@')
    const head = name.slice(0, 2)
    return `${head}${'*'.repeat(Math.max(1, Math.min(6, name.length - 2)))}@${domain}`
  }
  if (s.length >= 7) return `${s.slice(0, 3)}****${s.slice(-4)}`
  return `${s.slice(0, 1)}***`
}

/** 去重键：只存哈希，不存明文，也避免拿脱敏串当唯一键。 */
export function accountHash(account) {
  return createHash('sha256').update(String(account).trim().toLowerCase()).digest('hex').slice(0, 32)
}

/** Zepp 侧异常 → HTTP 状态码；不认识的错误返回 null，交给全局错误处理。 */
function sendZeppError(res, err) {
  if (!(err instanceof ZeppError)) return false
  if (err.code === 'AUTH_FAILED' || err.code === 'BAD_INPUT') {
    res.status(400).json({ error: err.message })
    return true
  }
  if (err.code === 'RISK') {
    res.status(429).json({ error: err.message })
    return true
  }
  if (err.code === 'NETWORK') {
    res.status(504).json({ error: err.message })
    return true
  }
  res.status(502).json({ error: err.message })
  return true
}

// 列表/详情统一用这组列：绝不带出 account_enc / password_enc，
// has_password 告诉前端这个账号是否需要现场补输密码。
const ACCOUNT_COLUMNS = `id, label, account_masked, zepp_user_id, status, last_error, last_success_at, created_at,
  CASE WHEN password_enc IS NULL OR password_enc = '' THEN 0 ELSE 1 END AS has_password`

// ---------- 元信息 ----------

router.get('/meta', requireAuth, async (req, res, next) => {
  try {
    const row = await dbGet(`SELECT COUNT(*) AS n FROM step_accounts WHERE user_id = ?`, [req.user.userId])
    res.json({
      stepMax: STEP_MAX,
      presets: STEP_PRESETS,
      dailySubmitLimit: DAILY_SUBMIT_LIMIT,
      accountCount: row?.n || 0,
      premium: ['admin', 'premium', 'pro'].includes(req.user.role),
      today: beijingDate(),
    })
  } catch (err) {
    next(err)
  }
})

// ---------- 账号管理 ----------

router.get('/accounts', requireAuth, requirePremiumOrAdmin, async (req, res, next) => {
  try {
    const rows = await dbAll(
      `SELECT ${ACCOUNT_COLUMNS} FROM step_accounts WHERE user_id = ? ORDER BY created_at DESC, id DESC`,
      [req.user.userId],
    )
    res.json({ accounts: rows })
  } catch (err) {
    next(err)
  }
})

/** 绑定账号：先真实验证凭据，通过才落库。是否保存密码由 savePassword 决定。 */
router.post('/accounts', requireAuth, requirePremiumOrAdmin, async (req, res, next) => {
  try {
    const userId = req.user.userId
    const account = String(req.body?.account || '').trim()
    const password = String(req.body?.password || '')
    const label = String(req.body?.label || '').trim().slice(0, 20)
    // 默认保存（老客户端不传该字段时行为不变）；显式传 false 才不落库
    const savePassword = req.body?.savePassword !== false

    if (!account || !password) return res.status(400).json({ error: '请填写 Zepp Life 账号和密码' })
    if (account.length > 120) return res.status(400).json({ error: '账号过长' })
    if (password.length > 120) return res.status(400).json({ error: '密码过长' })

    const hash = accountHash(account)
    const exists = await dbGet('SELECT id FROM step_accounts WHERE user_id = ? AND account_hash = ?', [userId, hash])
    if (exists) return res.status(409).json({ error: '这个账号已经绑定过了' })

    // 真实验证：不通过就不入库，避免攒一堆没用的死账号
    let auth
    try {
      auth = await authorize(account, password)
    } catch (err) {
      if (sendZeppError(res, err)) return
      throw err
    }

    await dbRun(
      `INSERT INTO step_accounts (user_id, label, account_enc, account_hash, account_masked, password_enc, zepp_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        label || maskAccount(account),
        encrypt(account) || account,
        hash,
        maskAccount(account),
        savePassword ? encrypt(password) || password : '',
        auth.userId,
      ],
    )

    const created = await dbGet(
      `SELECT ${ACCOUNT_COLUMNS} FROM step_accounts WHERE user_id = ? AND account_hash = ?`,
      [userId, hash],
    )
    res.json({ ok: true, account: created })
  } catch (err) {
    next(err)
  }
})

router.delete('/accounts/:id', requireAuth, requirePremiumOrAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '账号 ID 无效' })
    const row = await dbGet('SELECT id FROM step_accounts WHERE id = ? AND user_id = ?', [id, req.user.userId])
    if (!row) return res.status(404).json({ error: '账号不存在或不属于你' })
    await dbRun('DELETE FROM step_accounts WHERE id = ? AND user_id = ?', [id, req.user.userId])
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

/**
 * 保存或清除已存的 Zepp 密码——给「绑定时没勾保存、后来想勾」的用户留条路。
 * body 传密码 = 保存（先验证再存）；传空字符串 = 清除（账号保留）。
 */
router.put('/accounts/:id/password', requireAuth, requirePremiumOrAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '账号 ID 无效' })

    const row = await dbGet('SELECT * FROM step_accounts WHERE id = ? AND user_id = ?', [id, req.user.userId])
    if (!row) return res.status(404).json({ error: '账号不存在或不属于你' })

    const password = String(req.body?.password || '')

    if (!password) {
      await dbRun(`UPDATE step_accounts SET password_enc = '', updated_at = datetime('now') WHERE id = ?`, [id])
      return res.json({ ok: true, hasPassword: false })
    }
    if (password.length > 120) return res.status(400).json({ error: '密码过长' })

    // 存之前先验一次，免得把错密码存进去、之后同步一直失败还找不出原因
    const account = decrypt(row.account_enc)
    if (!account) return res.status(500).json({ error: '本地凭据解密失败，请删除后重新绑定' })
    try {
      await authorize(account, password)
    } catch (err) {
      if (sendZeppError(res, err)) return
      throw err
    }

    await dbRun(
      `UPDATE step_accounts SET password_enc = ?, status = 'active', last_error = '', updated_at = datetime('now') WHERE id = ?`,
      [encrypt(password) || password, id],
    )
    res.json({ ok: true, hasPassword: true })
  } catch (err) {
    next(err)
  }
})

// ---------- 提交步数 ----------

router.post('/submit', requireAuth, requirePremiumOrAdmin, async (req, res, next) => {
  let pending = null
  try {
    const userId = req.user.userId
    const accountId = Number(req.body?.accountId)
    const rawSteps = Number(req.body?.steps)

    if (!Number.isInteger(accountId) || accountId <= 0) {
      return res.status(400).json({ error: '请选择要同步的账号' })
    }
    if (!Number.isFinite(rawSteps) || rawSteps < 1 || rawSteps > STEP_MAX) {
      return res.status(400).json({ error: `步数需在 1 ~ ${STEP_MAX} 之间` })
    }

    const row = await dbGet('SELECT * FROM step_accounts WHERE id = ? AND user_id = ?', [accountId, userId])
    if (!row) return res.status(404).json({ error: '账号不存在或不属于你' })

    const account = decrypt(row.account_enc)
    if (!account) {
      return res.status(500).json({ error: '本地凭据解密失败，请删除后重新绑定' })
    }

    // 绑定时没勾「保存账号密码」的账号，用这次请求带上来的密码，用完即弃、绝不落库。
    // 428 是给前端的信号：需要补输密码（前端据此弹输入框）。
    const savedPassword = row.password_enc ? decrypt(row.password_enc) : ''
    const password = savedPassword || String(req.body?.password || '')
    if (!password) {
      return res.status(428).json({ error: '这个账号没有保存密码，请输入 Zepp 密码后重试', needPassword: true })
    }

    const day = beijingDate()
    const used = await dbGet(
      `SELECT COUNT(*) AS n FROM step_submissions WHERE account_id = ? AND target_date = ? AND status = 'success'`,
      [accountId, day],
    )
    if ((used?.n || 0) >= DAILY_SUBMIT_LIMIT) {
      return res.status(429).json({ error: `每个账号每天最多成功提交 ${DAILY_SUBMIT_LIMIT} 次，明天再来吧` })
    }

    const target = Math.round(rawSteps)
    pending = { userId, accountId, steps: target, day, status: 'failed', via: '', message: '' }

    try {
      const result = await changeSteps({ account, password, steps: target, date: day })
      pending.status = 'success'
      pending.via = result.via || ''
      pending.message = result.upstreamMessage || ''
      await dbRun(
        `UPDATE step_accounts SET status = 'active', last_error = '', last_success_at = datetime('now'),
           updated_at = datetime('now') WHERE id = ?`,
        [accountId],
      )
      res.json({ ok: true, steps: result.steps, date: result.date, via: result.via, log: result.log })
    } catch (err) {
      pending.message = err.message
      // 账号密码不对 → 标为 invalid，前端能直接提示重新绑定
      const authFailed = err instanceof ZeppError && err.code === 'AUTH_FAILED'
      await dbRun(
        `UPDATE step_accounts SET status = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?`,
        [authFailed ? 'invalid' : row.status, String(err.message).slice(0, 200), accountId],
      ).catch(() => {})
      if (!sendZeppError(res, err)) throw err
    }
  } catch (err) {
    next(err)
  } finally {
    // 成败都留一条流水，便于排查与限次统计
    if (pending) {
      await dbRun(
        `INSERT INTO step_submissions (user_id, account_id, steps, target_date, status, exit_via, message)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          pending.userId,
          pending.accountId,
          pending.steps,
          pending.day,
          pending.status,
          pending.via,
          String(pending.message || '').slice(0, 300),
        ],
      ).catch(() => {})
    }
  }
})

// ---------- 提交记录 ----------

router.get('/records', requireAuth, requirePremiumOrAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100)
    const rows = await dbAll(
      `SELECT s.id, s.account_id, s.steps, s.target_date, s.status, s.exit_via, s.message, s.created_at,
              a.account_masked, a.label
       FROM step_submissions s
       LEFT JOIN step_accounts a ON a.id = s.account_id
       WHERE s.user_id = ?
       ORDER BY s.created_at DESC, s.id DESC
       LIMIT ?`,
      [req.user.userId, limit],
    )
    res.json({ records: rows })
  } catch (err) {
    next(err)
  }
})

export default router

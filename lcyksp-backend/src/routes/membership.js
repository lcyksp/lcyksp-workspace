import { Router } from 'express'
import crypto from 'crypto'
import { getDb } from '../config/db.js'
import { authMiddleware, buildFreshUserPayload, requireAuth } from '../middleware/auth.js'

const router = Router()
const DEFAULT_AFDIAN_URL = 'https://ifdian.net/a/lcyksp'
const AFDIAN_QUERY_ORDER_URL = 'https://afdian.net/api/open/query-order'

router.use(authMiddleware)

const MEMBERSHIP_PLANS = [
  {
    key: 'monthly',
    name: '高级用户 30 天',
    amount: 500,
    durationDays: 30,
    description: '5 元 / 30 天',
  },
  {
    key: 'quarterly',
    name: '高级用户 90 天',
    amount: 1000,
    durationDays: 90,
    description: '10 元 / 90 天',
  },
  {
    key: 'yearly',
    name: '高级用户 365 天',
    amount: 2000,
    durationDays: 365,
    description: '20 元 / 365 天',
  },
]

const MEMBERSHIP_CONFIG_KEYS = [
  'membership_afdian_url',
  'membership_notice',
  'membership_afdian_user_id',
  'membership_afdian_token',
  'membership_afdian_webhook_token',
  'membership_plan_id_monthly',
  'membership_plan_id_quarterly',
  'membership_plan_id_yearly',
]

function dbGet(sql, params = []) {
  const db = getDb()
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))
  })
}

function dbAll(sql, params = []) {
  const db = getDb()
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
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

function getPlanByKey(planKey) {
  return MEMBERSHIP_PLANS.find((item) => item.key === planKey) || null
}

function maskCode(code) {
  if (!code || code.length < 8) return code || ''
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-****`
}

function extractRedeemToken(value) {
  const input = typeof value === 'string' ? value.trim() : ''
  if (!input) return ''
  const match = input.match(/\/redeem\/([A-Za-z0-9_-]+)/i)
  if (match && match[1]) return match[1]
  return input
}

function formatCardRow(row, includeCode = false) {
  const plan = getPlanByKey(row.plan_key)
  return {
    id: row.id,
    code: includeCode ? row.code : maskCode(row.code),
    planKey: row.plan_key,
    planName: plan?.name || row.plan_key,
    durationDays: row.duration_days,
    status: row.status,
    source: row.source,
    sourceOrderId: row.source_order_id || '',
    note: row.note || '',
    createdBy: row.created_by || null,
    usedBy: row.used_by || null,
    usedByName: row.used_by_name || '',
    usedAt: row.used_at || null,
    grantedExpiresAt: row.granted_expires_at || null,
    createdAt: row.created_at,
  }
}

function buildPremiumExpiry(baseDate, durationDays) {
  const next = new Date(baseDate)
  next.setDate(next.getDate() + durationDays)
  return next.toISOString()
}

function amountToCents(amountValue) {
  const amount = Number.parseFloat(String(amountValue || '0'))
  if (!Number.isFinite(amount)) return 0
  return Math.round(amount * 100)
}

function normalizeUsernameText(value) {
  return String(value || '').trim()
}

function pickUsernameFromRemark(remark) {
  var text = String(remark || '').trim()
  if (!text) return ''

  // Try to find username after common prefixes (anywhere in the remark, not just exact match)
  var patterns = [
    /本站用户名[:：]\s*([^\s,，、]+)/i,
    /用户名[:：]\s*([^\s,，、]+)/i,
    /账号[:：]\s*([^\s,，、]+)/i,
    /site\s*user[:：]\s*([^\s,，、]+)/i,
  ]

  for (var i = 0; i < patterns.length; i++) {
    var match = text.match(patterns[i])
    if (match && match[1]) {
      return match[1].trim()
    }
  }

  // Fallback: if the remark is a single word and looks like a username, use it directly
  var trimmed = text.trim()
  if (trimmed && !trimmed.includes(' ') && !trimmed.includes('\n') && trimmed.length < 50) {
    return trimmed
  }

  return ''
}

function buildAfdianSignature({ token, userId, params, ts }) {
  return crypto
    .createHash('md5')
    .update(`${token}params${params}ts${ts}user_id${userId}`)
    .digest('hex')
}

async function loadMembershipRuntimeConfig() {
  const placeholders = MEMBERSHIP_CONFIG_KEYS.map(() => '?').join(', ')
  const rows = await dbAll(
    `SELECT key, value FROM system_config WHERE key IN (${placeholders})`,
    MEMBERSHIP_CONFIG_KEYS,
  )
  const map = Object.fromEntries(rows.map((item) => [item.key, item.value]))

  return {
    afdianUrl: map.membership_afdian_url || DEFAULT_AFDIAN_URL,
    notice:
      map.membership_notice
      || '登录本站账号后，前往爱发电下单，并在订单备注里填写本站用户名。支付成功后，系统会自动为对应账号开通高级用户。',
    afdianUserId: map.membership_afdian_user_id || '',
    afdianToken: map.membership_afdian_token || '',
    webhookToken: map.membership_afdian_webhook_token || '',
    planIdMap: {
      monthly: map.membership_plan_id_monthly || '',
      quarterly: map.membership_plan_id_quarterly || '',
      yearly: map.membership_plan_id_yearly || '',
    },
  }
}

function detectPlanKeyByOrder(order, config) {
  const planId = String(order?.plan_id || '')
  if (planId) {
    for (const [key, value] of Object.entries(config.planIdMap)) {
      if (value && value === planId) return key
    }
  }

  const amount = amountToCents(order?.total_amount || order?.show_amount)
  if (amount === 500) return 'monthly'
  if (amount === 1000) return 'quarterly'
  if (amount === 2000) return 'yearly'

  const month = Number.parseInt(order?.month, 10)
  if (month === 1 && amount === 500) return 'monthly'
  if (month === 3) return 'quarterly'
  if (month === 12) return 'yearly'

  return ''
}

async function resolveUserByRemark(remark) {
  const username = pickUsernameFromRemark(remark)
  if (!username) {
    return { username: '', user: null, reason: '订单备注里没有填写本站用户名' }
  }

  const user = await dbGet(
    'SELECT id, username, role, premium_expires_at, is_banned FROM users WHERE username = ?',
    [username],
  )

  if (!user) {
    return { username, user: null, reason: `找不到本站用户：${username}` }
  }

  if (user.is_banned) {
    return { username, user: null, reason: `该用户已被封禁：${username}` }
  }

  return { username, user, reason: '' }
}

async function upsertMembershipOrder(order, planKey, status, payload, extra = {}) {
  const orderId = String(order?.out_trade_no || '').trim()
  if (!orderId) return null

  const existing = await dbGet(
    'SELECT id FROM membership_orders WHERE provider = ? AND order_id = ?',
    ['afdian', orderId],
  )

  const payloadText = JSON.stringify(payload || {})
  const amount = amountToCents(order?.total_amount || order?.show_amount)
  const cardCode = extra.cardCode || null

  if (existing) {
    await dbRun(
      "UPDATE membership_orders SET plan_key = ?, amount = ?, status = ?, payload = ?, card_code = ?, updated_at = datetime('now') WHERE id = ?",
      [planKey || '', amount, status, payloadText, cardCode, existing.id],
    )
    return existing.id
  }

  const result = await dbRun(
    "INSERT INTO membership_orders (provider, order_id, plan_key, amount, status, payload, card_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
    ['afdian', orderId, planKey || '', amount, status, payloadText, cardCode],
  )
  return result.id
}

async function createAfdianMembershipRecord({ userId, orderId, plan, username, remark, nextExpire }) {
  const code = `AFD-${orderId}`
  const exists = await dbGet('SELECT id FROM membership_cards WHERE code = ?', [code])
  if (exists) return code

  await dbRun(
    "INSERT INTO membership_cards (code, plan_key, duration_days, status, source, source_order_id, note, used_by, used_at, granted_expires_at) VALUES (?, ?, ?, 'used', 'afdian_webhook', ?, ?, ?, ?, ?)",
    [
      code,
      plan.key,
      plan.durationDays,
      orderId,
      `爱发电自动开通 | 用户名: ${username}${remark ? ` | 备注: ${remark}` : ''}`,
      userId,
      new Date().toISOString(),
      nextExpire,
    ],
  )

  return code
}

async function applyMembershipForAfdianOrder(order, config) {
  const orderId = String(order?.out_trade_no || '').trim()
  if (!orderId) {
    return { ok: false, reason: '缺少订单号', status: 'ignored' }
  }

  const existingOrder = await dbGet(
    'SELECT id, status, card_code FROM membership_orders WHERE provider = ? AND order_id = ?',
    ['afdian', orderId],
  )

  if (existingOrder?.status === 'applied') {
    return { ok: true, reason: '该订单已经处理过', status: 'applied', alreadyApplied: true }
  }

  const planKey = detectPlanKeyByOrder(order, config)
  const plan = getPlanByKey(planKey)
  if (!plan) {
    await upsertMembershipOrder(order, planKey, 'failed', order)
    return { ok: false, reason: '未能识别爱发电订单对应的会员档位', status: 'failed' }
  }

  const { username, user, reason } = await resolveUserByRemark(order?.remark)
  if (!user) {
    await upsertMembershipOrder(order, planKey, 'failed', order)
    return { ok: false, reason, status: 'failed', username }
  }

  const now = new Date()
  let baseDate = now
  if (user.premium_expires_at) {
    const currentExpire = new Date(user.premium_expires_at)
    if (!Number.isNaN(currentExpire.getTime()) && currentExpire.getTime() > now.getTime()) {
      baseDate = currentExpire
    }
  }

  const nextExpire = buildPremiumExpiry(baseDate, plan.durationDays)

  await dbRun('BEGIN TRANSACTION')
  try {
    await dbRun(
      "UPDATE users SET role = 'premium', quota_plan = 'premium', premium_expires_at = ? WHERE id = ?",
      [nextExpire, user.id],
    )

    const cardCode = await createAfdianMembershipRecord({
      userId: user.id,
      orderId,
      plan,
      username: user.username,
      remark: String(order?.remark || '').trim(),
      nextExpire,
    })

    await upsertMembershipOrder(order, plan.key, 'applied', order, { cardCode })
    await dbRun('COMMIT')

    return {
      ok: true,
      status: 'applied',
      username: user.username,
      planKey: plan.key,
      nextExpire,
    }
  } catch (error) {
    await dbRun('ROLLBACK').catch(() => {})
    throw error
  }
}

async function queryAfdianOrderByTradeNo(config, outTradeNo) {
  if (!config.afdianUserId || !config.afdianToken) {
    throw new Error('爱发电 user_id 或 token 未配置')
  }

  const params = JSON.stringify({ out_trade_no: outTradeNo })
  const ts = Math.floor(Date.now() / 1000)
  const sign = buildAfdianSignature({
    token: config.afdianToken,
    userId: config.afdianUserId,
    params,
    ts,
  })

  const response = await fetch(AFDIAN_QUERY_ORDER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: config.afdianUserId,
      params,
      ts,
      sign,
    }),
  })

  const data = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(`爱发电查询失败：HTTP ${response.status}`)
  }
  if (!data || data.ec !== 200) {
    throw new Error(data?.em || '爱发电查询失败')
  }

  const list = Array.isArray(data.data?.list) ? data.data.list : []
  return list.find((item) => String(item?.out_trade_no || '') === String(outTradeNo)) || null
}

router.get('/config', async (_req, res, next) => {
  try {
    const config = await loadMembershipRuntimeConfig()
    res.json({
      plans: MEMBERSHIP_PLANS,
      afdianUrl: config.afdianUrl,
      notice: config.notice,
      apiReady: Boolean(config.afdianUserId && config.afdianToken),
      apiStatusText:
        config.afdianUserId && config.afdianToken
          ? '爱发电自动开通已配置。请让用户在下单备注里填写本站用户名。'
          : '爱发电自动开通尚未完整配置，请先在管理后台填写 user_id、token 和回调令牌。',
    })
  } catch (err) {
    next(err)
  }
})

router.get('/my', requireAuth, async (req, res, next) => {
  try {
    const user = await buildFreshUserPayload(req.user.userId)
    const rows = await dbAll(
      'SELECT id, code, plan_key, duration_days, status, source, source_order_id, note, used_at, granted_expires_at, created_at FROM membership_cards WHERE used_by = ? ORDER BY used_at DESC, id DESC LIMIT 20',
      [req.user.userId],
    )

    res.json({
      user,
      records: rows.map((row) => formatCardRow(row, false)),
    })
  } catch (err) {
    next(err)
  }
})

router.post('/redeem', requireAuth, async (req, res, next) => {
  try {
    const rawInput = typeof req.body.code === 'string' ? req.body.code.trim() : ''
    const extractedCode = extractRedeemToken(rawInput)
    const rawCode = rawInput.toUpperCase()
    const extractedUpperCode = extractedCode.toUpperCase()
    if (!rawInput) {
      return res.status(400).json({ error: '请输入卡密或兑换链接' })
    }
    if (req.user.role === 'admin') {
      return res.status(400).json({ error: '管理员账号无需兑换高级用户' })
    }

    const card = await dbGet(
      'SELECT id, code, plan_key, duration_days, status FROM membership_cards WHERE code IN (?, ?, ?, ?, ?, ?)',
      [
        rawInput,
        rawCode,
        extractedCode,
        extractedUpperCode,
        extractedCode ? `https://ifdian.net/redeem/${extractedCode}` : '',
        extractedCode ? `https://ifdian.net/redeem/${extractedUpperCode}` : '',
      ],
    )

    if (!card) {
      return res.status(404).json({ error: '卡密不存在，请检查后重试' })
    }
    if (card.status !== 'unused') {
      return res.status(409).json({ error: '这张卡密已经被使用或作废了' })
    }

    const plan = getPlanByKey(card.plan_key)
    if (!plan) {
      return res.status(400).json({ error: '这张卡密的套餐信息无效，请联系管理员' })
    }

    const currentUser = await dbGet(
      'SELECT id, premium_expires_at FROM users WHERE id = ?',
      [req.user.userId],
    )

    const now = new Date()
    let baseDate = now
    if (currentUser?.premium_expires_at) {
      const currentExpire = new Date(currentUser.premium_expires_at)
      if (!Number.isNaN(currentExpire.getTime()) && currentExpire.getTime() > now.getTime()) {
        baseDate = currentExpire
      }
    }

    const nextExpire = buildPremiumExpiry(baseDate, plan.durationDays)

    await dbRun('BEGIN TRANSACTION')
    try {
      await dbRun(
        "UPDATE users SET role = 'premium', quota_plan = 'premium', premium_expires_at = ? WHERE id = ?",
        [nextExpire, req.user.userId],
      )
      await dbRun(
        "UPDATE membership_cards SET status = 'used', used_by = ?, used_at = ?, granted_expires_at = ? WHERE id = ? AND status = 'unused'",
        [req.user.userId, new Date().toISOString(), nextExpire, card.id],
      )
      await dbRun('COMMIT')
    } catch (error) {
      await dbRun('ROLLBACK').catch(() => {})
      throw error
    }

    const freshUser = await buildFreshUserPayload(req.user.userId)
    res.json({
      message: `兑换成功，已开通 ${plan.durationDays} 天高级用户`,
      user: freshUser,
      grantedExpiresAt: nextExpire,
      plan: {
        key: plan.key,
        name: plan.name,
      },
    })
  } catch (err) {
    next(err)
  }
})

router.post('/simulate', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: '仅管理员可使用模拟开通' })
    }

    const username = typeof req.body.username === 'string' ? req.body.username.trim() : ''
    const planKey = typeof req.body.planKey === 'string' ? req.body.planKey.trim() : ''
    const outTradeNo = typeof req.body.outTradeNo === 'string' ? req.body.outTradeNo.trim() : `SIM-${Date.now()}`
    const remark = typeof req.body.remark === 'string' ? req.body.remark.trim() : `用户名: ${username}`

    if (!username) {
      return res.status(400).json({ error: '请输入要开通的本站用户名' })
    }

    const plan = getPlanByKey(planKey)
    if (!plan) {
      return res.status(400).json({ error: '无效的会员档位' })
    }

    const config = await loadMembershipRuntimeConfig()
    const mockOrder = {
      out_trade_no: outTradeNo,
      total_amount: (plan.amount / 100).toFixed(2),
      show_amount: (plan.amount / 100).toFixed(2),
      plan_id: config.planIdMap[plan.key] || '',
      month: plan.key === 'monthly' ? 1 : plan.key === 'quarterly' ? 3 : 12,
      status: 2,
      remark: remark || `用户名: ${username}`,
    }

    const result = await applyMembershipForAfdianOrder(mockOrder, config)
    const freshUser = result.username
      ? await dbGet('SELECT id FROM users WHERE username = ?', [result.username])
      : null

    res.json({
      success: result.ok,
      message: result.reason || '模拟开通成功',
      order: mockOrder,
      user: freshUser ? await buildFreshUserPayload(freshUser.id) : null,
    })
  } catch (err) {
    next(err)
  }
})

router.post('/afdian/webhook', async (req, res, next) => {
  try {
    const config = await loadMembershipRuntimeConfig()
    const requestToken = String(req.query.token || req.body?.token || '')
    if (config.webhookToken && requestToken !== config.webhookToken) {
      return res.status(403).json({ ec: 403, em: 'forbidden' })
    }

    const order = req.body?.data?.order
    if (!order || req.body?.data?.type !== 'order') {
      return res.status(200).json({ ec: 200, em: 'ok', message: 'ignored' })
    }

    // Debug log for remark parsing
    console.log('[webhook] remark raw:', JSON.stringify(order.remark))
    const extractedUser = pickUsernameFromRemark(order.remark || '')
    console.log('[webhook] extracted username:', JSON.stringify(extractedUser))

    if (Number(order.status) !== 2) {
      await upsertMembershipOrder(order, detectPlanKeyByOrder(order, config), 'pending', order)
      return res.status(200).json({ ec: 200, em: 'ok', message: 'pending' })
    }

    const result = await applyMembershipForAfdianOrder(order, config)
    return res.status(200).json({
      ec: 200,
      em: 'ok',
      message: result.reason || 'processed',
    })
  } catch (err) {
    next(err)
  }
})

router.post('/afdian/pull', async (req, res, next) => {
  try {
    const config = await loadMembershipRuntimeConfig()
    const outTradeNo = typeof req.body.outTradeNo === 'string' ? req.body.outTradeNo.trim() : ''
    if (!outTradeNo) {
      return res.status(400).json({ success: false, error: '请提供 outTradeNo' })
    }

    const order = await queryAfdianOrderByTradeNo(config, outTradeNo)
    if (!order) {
      return res.status(404).json({ success: false, error: '未查询到这笔爱发电订单' })
    }

    if (Number(order.status) !== 2) {
      await upsertMembershipOrder(order, detectPlanKeyByOrder(order, config), 'pending', order)
      return res.json({ success: false, error: '该订单尚未支付成功', order })
    }

    const result = await applyMembershipForAfdianOrder(order, config)
    const user = result.username
      ? await dbGet('SELECT id, username, role, quota_plan, premium_expires_at, is_banned, banned_reason, group_id FROM users WHERE username = ?', [result.username])
      : null

    res.json({
      success: result.ok,
      message: result.reason || '同步成功',
      orderId: outTradeNo,
      username: result.username || '',
      planKey: result.planKey || '',
      order,
      user: user
        ? await buildFreshUserPayload(user.id)
        : null,
    })
  } catch (err) {
    next(err)
  }
})

export default router

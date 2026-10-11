// =====================================================================
//  考点判分专用的大模型出口
//
//  ⚠️ 与 GitHub 日报**完全分开**：配置走独立的 system_config 命名空间
//     （kaodian_llm_*），key 单独加密存放，互不影响、互不覆盖。
//
//  计费策略（2026-10 官方价，元/百万 tokens）：
//    DeepSeek-V4-Flash  高峰 命中0.1 / 未命中3   / 输出9    空闲 命中0.05 / 1.5 / 4.5
//    MiMo-V2.6-Flash    无峰谷 命中0.02 / 未命中1 / 输出2
//  DeepSeek 高峰时段 = 北京时间【工作日】9:00–12:00 与 14:00–18:00，周六日全天算低谷。
//
//  路由：mode=auto 时空闲档用 DeepSeek（质量更好），高峰档用 MiMo（省钱）；
//        也可用 mode 强制固定到某一档，或 off 直接关掉语义复核。
//
//  代理：DeepSeek / MiMo 都在国内，服务器**直连即可**，默认不走代理；
//        需要时用 kaodian_llm_proxy_url 单独指定（与 GITHUB_PROXY_URL 无关）。
// =====================================================================
import { ProxyAgent } from 'undici'
import { getDb } from '../config/db.js'
import { decrypt, encrypt } from './crypto.js'
import { normalizeEndpoint } from './llmEndpoint.js'
import { buildAdjudicateMessages, sanitizeAdjudication, looksLikeInjection, cleanAnswer } from './kaodianPrompt.js'

const NS = 'kaodian_llm_'
const CFG_KEYS = [
  'offpeak_url', 'offpeak_model', 'offpeak_key',
  'peak_url', 'peak_model', 'peak_key',
  'mode', 'daily_limit', 'user_daily_limit', 'max_tokens', 'timeout_ms', 'proxy_url', 'force_slot',
].map((k) => NS + k)

const DEFAULTS = {
  mode: 'auto',                 // auto | offpeak | peak | off
  // 空闲档：DeepSeek（高峰时段贵一倍，见文件头注释）
  offpeak_url: 'https://api.deepseek.com',
  offpeak_model: 'deepseek-v4-flash',
  // 高峰档：小米 MiMo（不区分峰谷，比 DeepSeek 空闲档还便宜）
  peak_url: 'https://api.xiaomimimo.com/v1',
  peak_model: 'mimo-v2.6-flash',
  daily_limit: 1500,            // 全站每天最多几次语义复核
  user_daily_limit: 150,        // 单用户每天上限
  max_tokens: 700,              // 输出上限（输出比输入贵）
  timeout_ms: 40000,
  proxy_url: '',                // 留空 = 直连（两家都在国内，服务器实测直连可达）
}

// 定价（元/百万 tokens），仅用于估算展示
const PRICES = {
  'deepseek-v4-flash': { peak: { hit: 0.1, miss: 3, out: 9 }, off: { hit: 0.05, miss: 1.5, out: 4.5 } },
  'deepseek-v4-pro': { peak: { hit: 0.3, miss: 9, out: 27 }, off: { hit: 0.15, miss: 4.5, out: 13.5 } },
  'mimo-v2.6-flash': { flat: { hit: 0.02, miss: 1.0, out: 2.0 } },
  'mimo-v2.6-pro': { flat: { hit: 0.025, miss: 3.0, out: 6.0 } },
}

/** 北京时间（UTC+8）的星期与小时。 */
function beijingNow(now = new Date()) {
  const t = new Date(now.getTime() + 8 * 3600 * 1000)
  return { day: t.getUTCDay(), hour: t.getUTCHours(), minute: t.getUTCMinutes() }
}

/** DeepSeek 的高峰时段：工作日 9:00–12:00、14:00–18:00；周六日全天低谷。 */
export function isPeak(now = new Date()) {
  const { day, hour } = beijingNow(now)
  if (day === 0 || day === 6) return false
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

export function slotOf(now = new Date()) {
  return isPeak(now) ? 'peak' : 'offpeak'
}

// ---------- 配置 ----------
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => getDb().all(sql, params, (e, r) => (e ? reject(e) : resolve(r || []))))
}
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => getDb().get(sql, params, (e, r) => (e ? reject(e) : resolve(r))))
}
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => getDb().run(sql, params, function onRun(e) {
    (e ? reject(e) : resolve({ lastID: this.lastID, changes: this.changes }))
  }))
}

export async function loadConfig() {
  const cfg = { ...DEFAULTS }
  try {
    const rows = await dbAll(
      `SELECT key, value FROM system_config WHERE key IN (${CFG_KEYS.map(() => '?').join(',')})`,
      CFG_KEYS,
    )
    const raw = {}
    for (const r of rows) raw[r.key.slice(NS.length)] = r.value
    for (const [k, v] of Object.entries(raw)) {
      if (v === undefined || v === null || v === '') continue
      cfg[k] = k.endsWith('_key') ? (decrypt(v) || '') : v
    }
    // 数字项归一
    cfg.max_tokens = Math.min(Math.max(Number(cfg.max_tokens) || DEFAULTS.max_tokens, 100), 4000)
    cfg.timeout_ms = Math.min(Math.max(Number(cfg.timeout_ms) || DEFAULTS.timeout_ms, 5000), 120000)
    cfg.daily_limit = Math.max(Number(cfg.daily_limit) || 0, 0)
    cfg.user_daily_limit = Math.max(Number(cfg.user_daily_limit) || 0, 0)
    // 环境变量兜底（运维侧注入 key，不必写库）
    if (!cfg.offpeak_key) cfg.offpeak_key = String(process.env.KAODIAN_LLM_OFFPEAK_KEY || '')
    if (!cfg.peak_key) cfg.peak_key = String(process.env.KAODIAN_LLM_PEAK_KEY || '')
  } catch { /* 用默认值 */ }
  return cfg
}

/** 挑这次用哪一档。返回 { slot, url, model, key } 或 null（未配置/已关闭）。 */
export function pickProvider(cfg, now = new Date()) {
  if (cfg.mode === 'off') return null
  const slots = []
  if (cfg.mode === 'offpeak') slots.push('offpeak')
  else if (cfg.mode === 'peak') slots.push('peak')
  else slots.push(slotOf(now), slotOf(now) === 'peak' ? 'offpeak' : 'peak')   // 另一档兜底

  for (const s of slots) {
    const url = cfg[`${s}_url`]
    const model = cfg[`${s}_model`]
    const key = cfg[`${s}_key`]
    if (url && model && key) return { slot: s, url, model, key }
  }
  return null
}

// ---------- 配额 ----------
function todayKey(now = new Date()) {
  const t = new Date(now.getTime() + 8 * 3600 * 1000)
  return t.toISOString().slice(0, 10)
}

export async function quotaState(userId, cfg, now = new Date()) {
  const day = todayKey(now)
  try {
    const g = await dbGet('SELECT COUNT(*) AS n FROM kaodian_llm_calls WHERE day = ?', [day])
    const u = await dbGet('SELECT COUNT(*) AS n FROM kaodian_llm_calls WHERE day = ? AND user_id = ?', [day, userId])
    const usedGlobal = g?.n || 0
    const usedUser = u?.n || 0
    const overGlobal = cfg.daily_limit > 0 && usedGlobal >= cfg.daily_limit
    const overUser = cfg.user_daily_limit > 0 && usedUser >= cfg.user_daily_limit
    return { day, usedGlobal, usedUser, over: overGlobal || overUser, overGlobal, overUser }
  } catch {
    return { day, usedGlobal: 0, usedUser: 0, over: false, overGlobal: false, overUser: false }
  }
}

async function recordUsage(row) {
  try {
    await dbRun(
      `INSERT INTO kaodian_llm_calls
       (day, user_id, source_id, slot, provider, model, prompt_tokens, cached_tokens, miss_tokens,
        completion_tokens, ok, reason, cost_cny, latency_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [row.day, row.userId, row.sourceId || 0, row.slot, row.provider || '', row.model || '',
        row.prompt || 0, row.hit || 0, row.miss || 0, row.completion || 0,
        row.ok ? 1 : 0, String(row.reason || '').slice(0, 200), row.cost || 0, row.latencyMs || 0],
    )
  } catch { /* 记账失败不影响判分 */ }
}

export function estimateCost(model, slot, { hit = 0, miss = 0, out = 0 }) {
  const p = PRICES[model]
  if (!p) return 0
  const t = p.flat || (slot === 'peak' ? p.peak : p.off)
  if (!t) return 0
  return (hit / 1e6) * t.hit + (miss / 1e6) * t.miss + (out / 1e6) * t.out
}

// ---------- 调用 ----------
function extractUsage(u) {
  if (!u) return { prompt: 0, completion: 0, hit: 0, miss: 0 }
  const prompt = Number(u.prompt_tokens) || 0
  const completion = Number(u.completion_tokens) || 0
  const hit = Number(
    u.prompt_cache_hit_tokens
    ?? u.cache_hit_tokens
    ?? u.prompt_tokens_details?.cached_tokens
    ?? 0,
  ) || 0
  const miss = Number(u.prompt_cache_miss_tokens ?? Math.max(0, prompt - hit)) || 0
  return { prompt, completion, hit, miss }
}

/** new-api / one-api 这类中转会把真实模型名放在 data.model，优先用它估成本。 */
function priceModelOf(respModel, cfgModel) {
  const m = String(respModel || cfgModel || '').toLowerCase()
  const hit = Object.keys(PRICES).find((k) => m.includes(k))
  return hit || cfgModel
}

/**
 * 跑一次语义裁决。
 * @returns {Promise<{ok:boolean, reason?:string, results?:Array, overall?:string, missing?:string[], meta:object}>}
 * 任何失败都返回 ok:false，调用方按算法结果兜底 —— 判分功能不会因为模型挂了而不可用。
 */
export async function adjudicate({ question, suspects, answer, userId, sourceId, cfg: cfgIn }) {
  const cfg = cfgIn || await loadConfig()
  const now = new Date()
  const slot = slotOf(now)
  const provider = pickProvider(cfg, now)
  const meta = { slot, provider: provider?.slot || '', model: provider?.model || '', day: todayKey(now) }

  if (!provider) return { ok: false, reason: 'unconfigured', meta }

  // 明显越权/注入的输入：直接不调模型（攻击者拿不到任何模型输出，也省一次钱）
  const inj = looksLikeInjection(answer)
  if (inj.hit) {
    await recordUsage({ ...meta, userId, sourceId, ok: false, reason: 'injection:' + inj.pattern })
    return { ok: false, reason: 'injection', meta }
  }

  const q = await quotaState(userId, cfg, now)
  if (q.over) {
    await recordUsage({ ...meta, userId, sourceId, ok: false, reason: q.overGlobal ? 'daily_limit' : 'user_daily_limit' })
    return { ok: false, reason: q.overGlobal ? 'daily_limit' : 'user_daily_limit', meta }
  }

  const messages = buildAdjudicateMessages({ question, suspects, answer })
  const dispatcher = cfg.proxy_url ? new ProxyAgent(String(cfg.proxy_url).trim()) : undefined
  const t0 = Date.now()
  let usage = { prompt: 0, completion: 0, hit: 0, miss: 0 }
  let cost = 0
  let respModel = ''

  /** 统一记账入口 —— 字段在这里一次摊平，避免上层漏传导致统计全是 0。 */
  const logCall = (ok, reason) => recordUsage({
    day: meta.day, userId, sourceId,
    slot: meta.slot, provider: meta.provider, model: meta.model,
    prompt: usage.prompt, hit: usage.hit, miss: usage.miss, completion: usage.completion,
    cost, latencyMs: Date.now() - t0, ok, reason,
  })

  try {
    const res = await fetch(normalizeEndpoint(provider.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + provider.key },
      body: JSON.stringify({
        model: provider.model,
        messages,
        temperature: 0.1,
        max_tokens: cfg.max_tokens,
        stream: false,
        response_format: { type: 'json_object' },
      }),
      ...(dispatcher ? { dispatcher } : {}),
      signal: AbortSignal.timeout(cfg.timeout_ms),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      // 上游报错可能带 key 片段：只留状态码，日志里也把 sk-*** 打码
      console.warn('[考点判分][LLM] HTTP', res.status, body.slice(0, 100).replace(/sk-[A-Za-z0-9]+/g, 'sk-***'))
      await logCall(false, `http_${res.status}`)
      return { ok: false, reason: `http_${res.status}`, meta }
    }
    const data = await res.json()
    respModel = String(data?.model || '')
    usage = extractUsage(data?.usage)
    meta.model = respModel || provider.model
    cost = estimateCost(priceModelOf(respModel, provider.model), provider.slot, usage)
    meta.usage = usage
    meta.costCny = cost
    meta.latencyMs = Date.now() - t0

    const content = data?.choices?.[0]?.message?.content || ''
    let parsed = null
    try { parsed = JSON.parse(String(content).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()) } catch { parsed = null }
    if (!parsed) {
      const i = String(content).indexOf('{'); const j = String(content).lastIndexOf('}')
      if (i >= 0 && j > i) { try { parsed = JSON.parse(String(content).slice(i, j + 1)) } catch { parsed = null } }
    }
    const clean = sanitizeAdjudication(parsed)
    if (!clean) {
      await logCall(false, 'bad_output')
      return { ok: false, reason: 'bad_output', meta }
    }
    await logCall(true, '')
    return { ok: true, results: clean.results, overall: clean.overall, missing: clean.missing, meta }
  } catch (e) {
    const reason = e?.name === 'TimeoutError' ? 'timeout' : 'network'
    await logCall(false, reason)
    return { ok: false, reason, meta }
  }
}

/** 给前端/后台看的用量汇总 */
export async function usageSummary(days = 7) {
  try {
    const rows = await dbAll(
      `SELECT day, COUNT(*) AS calls, SUM(ok) AS ok_calls,
              SUM(prompt_tokens) AS prompt, SUM(cached_tokens) AS cached,
              SUM(completion_tokens) AS out, ROUND(SUM(cost_cny), 4) AS cost
       FROM kaodian_llm_calls GROUP BY day ORDER BY day DESC LIMIT ?`, [days])
    return rows
  } catch { return [] }
}

// 后台可写字段 -> 校验/归一规则。key 结尾的单独加密存，留空表示"保持原值"。
const SAVABLE = {
  mode: (v) => (['auto', 'offpeak', 'peak', 'off'].includes(v) ? v : null),
  offpeak_url: (v) => String(v || '').trim().slice(0, 300),
  offpeak_model: (v) => String(v || '').trim().slice(0, 120),
  peak_url: (v) => String(v || '').trim().slice(0, 300),
  peak_model: (v) => String(v || '').trim().slice(0, 120),
  proxy_url: (v) => String(v || '').trim().slice(0, 300),
  daily_limit: (v) => clampInt(v, 0, 100000),
  user_daily_limit: (v) => clampInt(v, 0, 100000),
  max_tokens: (v) => clampInt(v, 100, 4000),
  timeout_ms: (v) => clampInt(v, 5000, 120000),
}
const SAVABLE_KEYS = ['offpeak_key', 'peak_key']  // 单独加密；空字符串 = 不改

function clampInt(v, min, max) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return null
  return Math.min(Math.max(n, min), max)
}

/**
 * 保存后台提交的配置。只认白名单字段；url/model/limit 直接存，
 * *_key 非空才加密覆盖（空字符串保持现有 key，便于前端回显时不回传明文）。
 */
export async function saveConfig(input = {}) {
  const writes = []
  for (const [field, norm] of Object.entries(SAVABLE)) {
    if (!(field in input)) continue
    const v = norm(input[field])
    if (v === null) continue
    writes.push([NS + field, String(v)])
  }
  for (const field of SAVABLE_KEYS) {
    if (!(field in input)) continue
    const raw = String(input[field] ?? '').trim()
    if (!raw) continue   // 留空 = 保持现有 key
    writes.push([NS + field, encrypt(raw)])
  }
  for (const [key, value] of writes) {
    await dbRun('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', [key, value])
  }
  return writes.length
}

export const KAODIAN_LLM_KEYS = CFG_KEYS
export const KAODIAN_LLM_DEFAULTS = DEFAULTS

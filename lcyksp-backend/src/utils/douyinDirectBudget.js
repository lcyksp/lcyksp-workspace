// 直连出口额度：服务器 IP 每 4 小时只允许被直连使用一次，用完这个窗口内其余解析一律走池。
// 动机：服务器 IP 一旦解封，如果所有解析都恢复直连，很容易再次被抖音风控标记；
// 让它「每 4 小时露一次脸」既保留解封红利（每 4 小时有一次免费出口），又不会频繁访问。
// 记录持久化在 system_config（重启不清零），写路径经进程内互斥队列串行化，避免并发双 claim。
import { getDb } from '../config/db.js'

export const DIRECT_WINDOW_MS = 4 * 60 * 60 * 1000
const CONFIG_KEY = 'douyin_direct_last_used_at'
const READ_CACHE_MS = 15 * 1000

/** 纯函数：给定上次直连时间与窗口长度，判断现在能不能用直连。无记录 = 可用。 */
export function isDirectWindowOpen(lastUsedAtIso, nowMs = Date.now(), windowMs = DIRECT_WINDOW_MS) {
  const last = Date.parse(String(lastUsedAtIso || ''))
  if (!Number.isFinite(last)) return true
  return nowMs - last >= windowMs
}

/**
 * 纯函数：决定这次解析任务用哪个出口。
 *  - 没配池 → 只能直连；
 *  - 探测没确认「ok」（含刚重启的 unknown）→ 先走池，绝不动用服务器 IP；
 *  - 探测 ok → 占到额度才直连，否则走池。
 */
export function decideTaskExit({ gate, hasPool, budgetOk = false }) {
  if (!hasPool) return 'direct'
  if (gate !== 'ok') return 'pool'
  return budgetOk ? 'direct' : 'pool'
}

let cache = { at: 0, value: '' }
let claimQueue = Promise.resolve()

function dbGet(sql, params) {
  const db = getDb()
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null))))
}

function dbRun(sql, params) {
  const db = getDb()
  return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())))
}

async function readLastUsed() {
  const now = Date.now()
  if (now - cache.at < READ_CACHE_MS) return cache.value
  try {
    const row = await dbGet('SELECT value FROM system_config WHERE key = ?', [CONFIG_KEY])
    cache = { at: now, value: String(row?.value || '') }
  } catch (err) {
    console.error('[DirectBudget] 读取直连额度记录失败，沿用缓存值:', err.message)
    cache = { at: now, value: cache.value }
  }
  return cache.value
}

async function writeLastUsed(iso) {
  await dbRun('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)', [CONFIG_KEY, iso])
  cache = { at: Date.now(), value: iso }
}

/** 当前额度状态（给后台展示）。 */
export async function directBudgetState(nowMs = Date.now()) {
  const lastUsedAt = await readLastUsed()
  const last = Date.parse(lastUsedAt)
  return {
    windowMs: DIRECT_WINDOW_MS,
    lastUsedAt: Number.isFinite(last) ? lastUsedAt : '',
    nextAvailableAt: Number.isFinite(last) ? new Date(last + DIRECT_WINDOW_MS).toISOString() : '',
    available: isDirectWindowOpen(lastUsedAt, nowMs),
  }
}

/**
 * 尝试用掉这一次直连额度：窗口开着 → 记录当前时间并返回 true；窗口内 → 返回 false。
 * 单实例 PM2 下进程内互斥即全局互斥（与 quota.js 同一套约定）。
 */
export async function claimDirectBudget(nowMs = Date.now()) {
  const task = claimQueue.then(async () => {
    const lastUsedAt = await readLastUsed()
    if (!isDirectWindowOpen(lastUsedAt, nowMs)) return false
    await writeLastUsed(new Date(nowMs).toISOString())
    console.error(`[DirectBudget] 直连额度已使用（${new Date(nowMs + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)} 北京时间），4 小时内解析改走池出口`)
    return true
  })
  claimQueue = task.catch(() => {})
  return task
}

/** 管理员重置（排查/测试用）：清掉记录，下次直连立即可用。 */
export async function resetDirectBudget() {
  cache = { at: 0, value: '' }
  try {
    await dbRun('DELETE FROM system_config WHERE key = ?', [CONFIG_KEY])
  } catch (err) {
    console.error('[DirectBudget] 重置直连额度失败:', err.message)
  }
}

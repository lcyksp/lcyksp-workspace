import { getDb } from '../config/db.js'

// 登录失败锁定按「用户名」计数而不是 IP：攻击者换 IP/代理池无效；
// 正常用户偶尔输错密码一两次远够不到阈值。阈值与 authLimiter（单 IP 15 分钟 10 次失败）对齐，
// 双层防护：express-rate-limit 挡单 IP 撞库，这里挡分布式/换 IP 针对单账号的爆破。
// 计数落在 SQLite，PM2 重启不清零（内存型限流一重启就归零，防不住持久攻击者）。
export const LOGIN_WINDOW_MINUTES = 15
export const LOGIN_MAX_FAILURES = 10

function pad(value) {
  return String(value).padStart(2, '0')
}

// 窗口起点按 LOGIN_WINDOW_MINUTES 对齐分桶，与 usage_counters 的 hour/day 分桶同思路：
// 固定桶靠唯一键原子写入无竞争，过桶即自动「解锁」。锁定期最长一个窗口（15 分钟）。
export function getLoginWindowStart(now = new Date()) {
  const date = new Date(now)
  const minuteBucket = Math.floor(date.getUTCMinutes() / LOGIN_WINDOW_MINUTES) * LOGIN_WINDOW_MINUTES
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(minuteBucket)}:00`
}

export function isLoginLocked(failureCount) {
  return failureCount >= LOGIN_MAX_FAILURES
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

export async function getLoginFailureCount(username, now = new Date()) {
  const windowStart = getLoginWindowStart(now)
  const row = await dbGet('SELECT count FROM login_attempts WHERE username = ? AND window_start = ?', [
    username,
    windowStart,
  ])
  return row?.count || 0
}

// 计数自增放在 SQL 里原子完成（upsert），并发失败请求不会互相覆盖；
// 之后的 SELECT 可能读到并发请求加出来的偏大值 —— 宁可早锁不晚锁。
export async function recordLoginFailure(username, now = new Date()) {
  const windowStart = getLoginWindowStart(now)
  await dbRun(
    `INSERT INTO login_attempts (username, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(username, window_start) DO UPDATE SET count = count + 1, updated_at = datetime('now')`,
    [username, windowStart],
  )
  const row = await dbGet('SELECT count FROM login_attempts WHERE username = ? AND window_start = ?', [
    username,
    windowStart,
  ])
  return row?.count || 0
}

// 密码比对成功就清掉该用户名全部失败计数（旧窗口残留行交给清道夫按天扫）。
export async function clearLoginFailures(username) {
  await dbRun('DELETE FROM login_attempts WHERE username = ?', [username])
}

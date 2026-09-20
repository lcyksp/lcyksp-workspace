import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import sqlite3 from 'sqlite3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ---------- 参数 ----------
const args = process.argv.slice(2)
function readArg(name) {
  const i = args.indexOf(name)
  return i !== -1 ? args[i + 1] : null
}
const hasFlag = (name) => args.includes(name)

const fromUsername = readArg('--from') || 'admin'
const toUsername = readArg('--to')
const execute = hasFlag('--yes')
const dbPath = readArg('--db')
  ? path.resolve(readArg('--db'))
  : process.env.LCYKSP_DB_DIR
    ? path.join(path.resolve(process.env.LCYKSP_DB_DIR), 'database.db')
    : path.resolve(__dirname, '../data/db/database.db')

if (!toUsername) {
  console.error('用法: node scripts/mergeAdminAccount.mjs --from <被合并账号> --to <保留账号> [--yes] [--db <路径>]')
  console.error('默认 dry-run 只打印将要做的事，确认无误后加 --yes 才真正执行。')
  process.exit(1)
}
if (fromUsername === toUsername) {
  console.error('[错误] --from 和 --to 不能是同一个账号')
  process.exit(1)
}
if (!fs.existsSync(dbPath)) {
  console.error(`[错误] 数据库不存在: ${dbPath}`)
  process.exit(1)
}

// ---------- 用户数据归属表 ----------
// 「冲突表」有 UNIQUE(user_id, ...) 约束：目标账号已有同键记录时不能直接改 user_id，
// 只能删掉来源账号的那条（改过去会撞唯一约束）。
const REASSIGN_TABLES = [
  'gallery_photos.uploader_id',
  'transfers.owner_id',
  'recipes.creator_id',
  'feedback_reports.reporter_id',
  'membership_cards.created_by',
  'membership_cards.used_by',
  'download_logs.user_id',
  'twitch_drop_tasks.user_id',
  'github_email_delivery_logs.user_id',
]
const CONFLICT_TABLES = [
  { table: 'user_cookies', key: 'user_id' }, // UNIQUE(user_id)
  { table: 'twitch_accounts', key: 'twitch_user_id' }, // UNIQUE(user_id, twitch_user_id)
  { table: 'github_subscriptions', key: 'email' }, // UNIQUE(user_id, email)
  { table: 'trend_keywords', key: 'keyword, platform' }, // UNIQUE(keyword, platform, user_id)
]

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err)
      resolve({ changes: this.changes, lastID: this.lastID })
    })
  })
}
function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))
  })
}
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  })
}

const db = new sqlite3.Database(dbPath)
await run(db, 'PRAGMA busy_timeout=10000;')
await run(db, 'PRAGMA foreign_keys=ON;')

try {
  console.log(`数据库: ${dbPath}`)
  console.log(`模式: ${execute ? '⚠️  执行模式（--yes）' : 'dry-run（不改动，只预览）'}`)
  console.log(`合并: "${fromUsername}" → "${toUsername}"\n`)

  const fromUser = await get(db, 'SELECT id, username, role, quota_plan FROM users WHERE username = ?', [fromUsername])
  const toUser = await get(db, 'SELECT id, username, role, quota_plan FROM users WHERE username = ?', [toUsername])

  if (!fromUser) {
    console.error(`[错误] 找不到被合并账号 "${fromUsername}"，无需合并。`)
    process.exit(1)
  }
  if (!toUser) {
    console.error(`[错误] 找不到保留账号 "${toUsername}"。请先用它登录一次（注册）再执行合并。`)
    process.exit(1)
  }
  if (fromUser.id === toUser.id) {
    console.error('[错误] 两个用户名指向同一个用户。')
    process.exit(1)
  }

  console.log(`来源: id=${fromUser.id} ${fromUser.username} (role=${fromUser.role})`)
  console.log(`目标: id=${toUser.id} ${toUser.username} (role=${toUser.role})`)
  if (toUser.role === 'admin') {
    console.log('（目标已是管理员，合并后维持不变）')
  }

  await run(db, 'BEGIN IMMEDIATE')

  let totalMoved = 0
  let totalDropped = 0

  // 1) 冲突表：目标已有同键记录的，删除来源那条（其余在下一步改归属）
  for (const { table, key } of CONFLICT_TABLES) {
    const keyCols = key.split(',').map((s) => s.trim())
    // user_cookies 的唯一键就是 user_id 本身，没有额外的业务键可 join：
    // 只要目标账号有记录，来源那条就直接删。
    const keyCond = keyCols.length === 1 && keyCols[0] === 'user_id' ? '1=1' : keyCols.map((c) => `s.${c} = t.${c}`).join(' AND ')
    const dropped = await run(
      db,
      `DELETE FROM ${table} WHERE id IN (
         SELECT s.id FROM ${table} s
         JOIN ${table} t ON t.user_id = ? AND ${keyCond}
         WHERE s.user_id = ?
       )`,
      [toUser.id, fromUser.id],
    )
    if (dropped.changes) console.log(`  ${table}: 删除 ${dropped.changes} 条与目标账号冲突的记录`)
    totalDropped += dropped.changes
  }

  // 2) 归属转移
  for (const ref of REASSIGN_TABLES) {
    const [table, col] = ref.split('.')
    const moved = await run(db, `UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`, [toUser.id, fromUser.id])
    if (moved.changes) console.log(`  ${table}.${col}: ${moved.changes} 条归属转移`)
    totalMoved += moved.changes
  }
  for (const { table, key } of CONFLICT_TABLES) {
    const moved = await run(db, `UPDATE ${table} SET user_id = ? WHERE user_id = ?`, [toUser.id, fromUser.id])
    if (moved.changes) console.log(`  ${table}: ${moved.changes} 条归属转移`)
    totalMoved += moved.changes
  }

  // 3) 目标账号提为管理员
  const promoted = await run(db, "UPDATE users SET role = 'admin', quota_plan = 'admin', is_banned = 0 WHERE id = ?", [
    toUser.id,
  ])

  // 4) 删除来源账号（归属已清空，FK 不会挡）
  const removed = await run(db, 'DELETE FROM users WHERE id = ?', [fromUser.id])
  console.log(`\n数据归属转移: ${totalMoved} 条`)
  console.log(`冲突记录删除: ${totalDropped} 条`)
  console.log(`目标账号提升为管理员: ${promoted.changes ? '是' : '否（已是管理员）'}`)
  console.log(`删除账号 "${fromUsername}" (id=${fromUser.id}): ${removed.changes ? '已删除' : '未删除'}`)

  const after = await all(db, "SELECT id, username, role FROM users WHERE role = 'admin' ORDER BY id")
  console.log('\n当前管理员账号:')
  for (const row of after) console.log(`  id=${row.id} ${row.username}`)

  if (execute) {
    await run(db, 'COMMIT')
    console.log('\n✅ 合并完成。被合并账号的登录 token 已自动失效。')
  } else {
    await run(db, 'ROLLBACK')
    console.log('\n（dry-run 结束，以上是预览，数据库未做任何改动。确认后加 --yes 执行。）')
  }
} catch (err) {
  try {
    await run(db, 'ROLLBACK')
  } catch {}
  console.error('[失败] 已回滚，数据库保持原状:', err.message)
  process.exitCode = 1
} finally {
  db.close()
}

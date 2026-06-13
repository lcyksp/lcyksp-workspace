import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import sqlite3 from 'sqlite3'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DB_DIR = path.resolve(__dirname, '../../data/db')
const DB_PATH = path.join(DB_DIR, 'database.db')

let db = null

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err)
      resolve({ lastID: this.lastID, changes: this.changes })
    })
  })
}

export function getDb() {
  if (!db) throw new Error('数据库尚未初始化，请先调用 initDb()')
  return db
}

export async function initDb() {
  fs.mkdirSync(DB_DIR, { recursive: true })

  await new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) return reject(err)
      console.log('[DB] SQLite connected:', DB_PATH)
      resolve()
    })
  })

  await run('PRAGMA journal_mode=WAL;')
  await run('PRAGMA foreign_keys=ON;')

  await run(
    'CREATE TABLE IF NOT EXISTS family_groups (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'group_name VARCHAR(64) NOT NULL UNIQUE,' +
      "created_at TEXT NOT NULL DEFAULT (datetime('now'))" +
    ')',
  )

  await run(
    'CREATE TABLE IF NOT EXISTS users (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'username VARCHAR(64) NOT NULL UNIQUE,' +
      'password TEXT NOT NULL,' +
      "role TEXT NOT NULL DEFAULT 'user'," +
      "quota_plan TEXT NOT NULL DEFAULT 'free'," +
      'premium_expires_at TEXT DEFAULT NULL,' +
      'is_banned INTEGER NOT NULL DEFAULT 0,' +
      "banned_reason TEXT DEFAULT ''," +
      'group_id INTEGER DEFAULT NULL REFERENCES family_groups(id),' +
      "created_at TEXT NOT NULL DEFAULT (datetime('now'))" +
    ')',
  )

  await run(
    'CREATE TABLE IF NOT EXISTS gallery_photos (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'file_name TEXT NOT NULL,' +
      'file_path TEXT NOT NULL,' +
      'file_size INTEGER NOT NULL DEFAULT 0,' +
      'family_group_id INTEGER DEFAULT NULL REFERENCES family_groups(id),' +
      'uploader_id INTEGER NOT NULL REFERENCES users(id),' +
      "created_at TEXT NOT NULL DEFAULT (datetime('now'))" +
    ')',
  )

  await run(
    'CREATE TABLE IF NOT EXISTS recipes (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'name VARCHAR(128) NOT NULL,' +
      "ingredients TEXT DEFAULT ''," +
      "tags TEXT DEFAULT ''," +
      "steps TEXT DEFAULT ''," +
      'creator_id INTEGER DEFAULT NULL,' +
      "created_at TEXT NOT NULL DEFAULT (datetime('now'))" +
    ')',
  )

  await run(
    'CREATE TABLE IF NOT EXISTS system_config (' +
      'key TEXT PRIMARY KEY,' +
      'value TEXT NOT NULL' +
    ')',
  )

  await run(
    'CREATE TABLE IF NOT EXISTS llm_config_history (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'type TEXT NOT NULL,' +
      'value TEXT NOT NULL,' +
      "created_at TEXT NOT NULL DEFAULT (datetime('now'))," +
      'UNIQUE(type, value)' +
    ')',
  )

  await run(
    'CREATE TABLE IF NOT EXISTS feedback_reports (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'page_name TEXT NOT NULL,' +
      'feature_name TEXT NOT NULL,' +
      'problem_summary TEXT NOT NULL,' +
      'details TEXT NOT NULL,' +
      'reporter_id INTEGER DEFAULT NULL REFERENCES users(id),' +
      "reporter_name TEXT DEFAULT ''," +
      "created_at TEXT NOT NULL DEFAULT (datetime('now'))" +
    ')',
  )

  await run(
    'CREATE TABLE IF NOT EXISTS membership_cards (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'code TEXT NOT NULL UNIQUE,' +
      'plan_key TEXT NOT NULL,' +
      'duration_days INTEGER DEFAULT NULL,' +
      "status TEXT NOT NULL DEFAULT 'unused'," +
      "source TEXT NOT NULL DEFAULT 'manual'," +
      'source_order_id TEXT DEFAULT NULL,' +
      "note TEXT DEFAULT ''," +
      'created_by INTEGER DEFAULT NULL REFERENCES users(id),' +
      'used_by INTEGER DEFAULT NULL REFERENCES users(id),' +
      'used_at TEXT DEFAULT NULL,' +
      'granted_expires_at TEXT DEFAULT NULL,' +
      "created_at TEXT NOT NULL DEFAULT (datetime('now'))" +
    ')',
  )

  await run(
    'CREATE TABLE IF NOT EXISTS membership_orders (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'provider TEXT NOT NULL,' +
      'order_id TEXT NOT NULL UNIQUE,' +
      'plan_key TEXT NOT NULL,' +
      'amount INTEGER NOT NULL DEFAULT 0,' +
      "status TEXT NOT NULL DEFAULT 'pending'," +
      'payload TEXT DEFAULT NULL,' +
      'card_code TEXT DEFAULT NULL,' +
      "created_at TEXT NOT NULL DEFAULT (datetime('now'))," +
      "updated_at TEXT NOT NULL DEFAULT (datetime('now'))" +
    ')',
  )

  await run(
    'CREATE TABLE IF NOT EXISTS usage_counters (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'subject_type TEXT NOT NULL,' +
      'subject_key TEXT NOT NULL,' +
      'action TEXT NOT NULL,' +
      'window_start TEXT NOT NULL,' +
      'count INTEGER NOT NULL DEFAULT 0,' +
      "updated_at TEXT NOT NULL DEFAULT (datetime('now'))," +
      'UNIQUE(subject_type, subject_key, action, window_start)' +
    ')',
  )

  await run(
    'CREATE TABLE IF NOT EXISTS registration_attempts (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'ip_address TEXT NOT NULL,' +
      'window_start TEXT NOT NULL,' +
      'count INTEGER NOT NULL DEFAULT 0,' +
      "updated_at TEXT NOT NULL DEFAULT (datetime('now'))," +
      'UNIQUE(ip_address, window_start)' +
    ')',
  )

  await run(
    'CREATE TABLE IF NOT EXISTS transfers (' +
      'id VARCHAR(32) PRIMARY KEY,' +
      'file_name TEXT NOT NULL,' +
      'file_path TEXT NOT NULL,' +
      'file_size INTEGER NOT NULL DEFAULT 0,' +
      'password TEXT DEFAULT NULL,' +
      'max_downloads INTEGER NOT NULL DEFAULT 1,' +
      'current_downloads INTEGER NOT NULL DEFAULT 0,' +
      'expire_time TEXT NOT NULL,' +
      'owner_id INTEGER DEFAULT NULL REFERENCES users(id),' +
      'is_private INTEGER NOT NULL DEFAULT 0,' +
      "created_at TEXT NOT NULL DEFAULT (datetime('now'))" +
    ')',
  )

  await run("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'").catch(() => {})
  await run("ALTER TABLE users ADD COLUMN quota_plan TEXT NOT NULL DEFAULT 'free'").catch(() => {})
  await run('ALTER TABLE users ADD COLUMN premium_expires_at TEXT DEFAULT NULL').catch(() => {})
  await run('ALTER TABLE users ADD COLUMN is_banned INTEGER NOT NULL DEFAULT 0').catch(() => {})
  await run("ALTER TABLE users ADD COLUMN banned_reason TEXT DEFAULT ''").catch(() => {})
  await run('ALTER TABLE users ADD COLUMN group_id INTEGER DEFAULT NULL REFERENCES family_groups(id)').catch(() => {})
  await run('ALTER TABLE transfers ADD COLUMN owner_id INTEGER DEFAULT NULL REFERENCES users(id)').catch(() => {})
  await run('ALTER TABLE transfers ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0').catch(() => {})

  await run('CREATE INDEX IF NOT EXISTS idx_recipes_name ON recipes(name)').catch(() => {})
  await run('CREATE INDEX IF NOT EXISTS idx_recipes_tags ON recipes(tags)').catch(() => {})
  await run('CREATE INDEX IF NOT EXISTS idx_transfers_expire ON transfers(expire_time)').catch(() => {})
  await run('CREATE INDEX IF NOT EXISTS idx_gallery_photos_group ON gallery_photos(family_group_id)').catch(() => {})
  await run('CREATE INDEX IF NOT EXISTS idx_llm_history_type ON llm_config_history(type)').catch(() => {})
  await run('CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback_reports(created_at)').catch(() => {})
  await run('CREATE INDEX IF NOT EXISTS idx_membership_cards_status ON membership_cards(status, created_at)').catch(() => {})
  await run('CREATE INDEX IF NOT EXISTS idx_membership_cards_used_by ON membership_cards(used_by, used_at)').catch(() => {})
  await run('CREATE INDEX IF NOT EXISTS idx_membership_orders_provider_order ON membership_orders(provider, order_id)').catch(() => {})
  await run('CREATE INDEX IF NOT EXISTS idx_usage_counters_lookup ON usage_counters(subject_type, subject_key, action, window_start)').catch(() => {})
  await run('CREATE INDEX IF NOT EXISTS idx_registration_attempts_lookup ON registration_attempts(ip_address, window_start)').catch(() => {})

  await run(
    `UPDATE users
     SET quota_plan = CASE
       WHEN role = 'admin' THEN 'admin'
       WHEN role = 'pro' THEN 'pro'
       WHEN role = 'premium' THEN 'premium'
       ELSE 'free'
     END
     WHERE quota_plan IS NULL OR quota_plan = '' OR quota_plan = 'user'`,
  ).catch(() => {})

  await run("UPDATE users SET role = 'admin', quota_plan = 'admin' WHERE id = 1").catch(() => {})

  console.log('[DB] Schema ready')
}

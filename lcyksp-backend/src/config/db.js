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
  await run('PRAGMA busy_timeout=5000;')
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

  await run(
    'CREATE TABLE IF NOT EXISTS download_logs (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'user_id INTEGER DEFAULT NULL REFERENCES users(id),' +
      'username VARCHAR(64) DEFAULT NULL,' +
      'ip_address TEXT NOT NULL,' +
      'download_type TEXT NOT NULL,' +
      'resource_title TEXT NOT NULL,' +
      'resource_url TEXT DEFAULT \'\',' +
      'file_size INTEGER DEFAULT 0,' +
      'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))' +
      ')',
  )
  await run('CREATE INDEX IF NOT EXISTS idx_download_logs_created_at ON download_logs(created_at)').catch(() => {})

  await run(
    'CREATE TABLE IF NOT EXISTS user_cookies (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),' +
      'cookie_json TEXT NOT NULL,' +
      "updated_at TEXT NOT NULL DEFAULT (datetime('now'))" +
      ')',
  ).catch(() => {})

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
    'CREATE TABLE IF NOT EXISTS trend_snapshots (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'platform TEXT NOT NULL,' +
      'keyword TEXT NOT NULL,' +
      'rank INTEGER DEFAULT 0,' +
      'score INTEGER DEFAULT 0,' +
      "extra TEXT DEFAULT '{}'," +
      "created_at TEXT NOT NULL DEFAULT (datetime('now'))" +
    ')',
  ).catch(() => {})

  await run('CREATE INDEX IF NOT EXISTS idx_trend_snapshots_platform ON trend_snapshots(platform, created_at)').catch(() => {})
  await run('CREATE INDEX IF NOT EXISTS idx_trend_snapshots_keyword ON trend_snapshots(keyword, platform)').catch(() => {})

  await run(
    'CREATE TABLE IF NOT EXISTS trend_keywords (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'keyword TEXT NOT NULL,' +
      'platform TEXT NOT NULL,' +
      'user_id INTEGER DEFAULT NULL,' +
      "created_at TEXT NOT NULL DEFAULT (datetime('now'))," +
      'UNIQUE(keyword, platform, user_id)' +
    ')',
  ).catch(() => {})

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

  await run(
    'CREATE TABLE IF NOT EXISTS github_categories (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'name TEXT NOT NULL UNIQUE,' +
      'description TEXT DEFAULT \'\',' +
      'keywords TEXT NOT NULL DEFAULT \'[]\',' +
      'languages TEXT NOT NULL DEFAULT \'[]\',' +
      'enabled INTEGER NOT NULL DEFAULT 1,' +
      "created_at TEXT NOT NULL DEFAULT (datetime('now'))" +
    ')',
  ).catch(() => {})

  await run(
    'CREATE TABLE IF NOT EXISTS github_subscriptions (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
      'email TEXT NOT NULL,' +
      'category_ids TEXT NOT NULL DEFAULT \'[]\',' +
      'keywords TEXT NOT NULL DEFAULT \'[]\',' +
      'frequencies TEXT NOT NULL DEFAULT \'["daily"]\',' +
      'status TEXT NOT NULL DEFAULT \'pending\',' +
      'last_test_sent_at TEXT DEFAULT NULL,' +
      'created_at TEXT NOT NULL DEFAULT (datetime(\'now\')),' +
      'updated_at TEXT NOT NULL DEFAULT (datetime(\'now\')),' +
      'UNIQUE(user_id, email)' +
    ')',
  ).catch(() => {})

  await run(
    'CREATE TABLE IF NOT EXISTS github_email_delivery_logs (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'subscription_id INTEGER REFERENCES github_subscriptions(id) ON DELETE SET NULL,' +
      'user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,' +
      'email TEXT NOT NULL,' +
      'kind TEXT NOT NULL,' +
      'status TEXT NOT NULL,' +
      'error_message TEXT DEFAULT \'\',' +
      "created_at TEXT NOT NULL DEFAULT (datetime('now'))" +
    ')',
  ).catch(() => {})

  await run('CREATE INDEX IF NOT EXISTS idx_github_subscriptions_user ON github_subscriptions(user_id, status)').catch(() => {})
  await run('CREATE INDEX IF NOT EXISTS idx_github_email_logs_lookup ON github_email_delivery_logs(user_id, kind, created_at)').catch(() => {})
  await run(
    'CREATE TABLE IF NOT EXISTS github_repositories (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'full_name TEXT NOT NULL UNIQUE,' +
      'url TEXT NOT NULL,' +
      'description TEXT DEFAULT \'\',' +
      'language TEXT DEFAULT \'\',' +
      'topics TEXT NOT NULL DEFAULT \'[]\',' +
      'stars INTEGER NOT NULL DEFAULT 0,' +
      'forks INTEGER NOT NULL DEFAULT 0,' +
      'first_seen_at TEXT NOT NULL,' +
      'last_seen_at TEXT NOT NULL,' +
      'last_ai_review_id INTEGER DEFAULT NULL,' +
      'updated_at TEXT NOT NULL' +
    ')',
  ).catch(() => {})
  await run(
    'CREATE TABLE IF NOT EXISTS github_star_snapshots (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'repository_id INTEGER NOT NULL REFERENCES github_repositories(id) ON DELETE CASCADE,' +
      'stars INTEGER NOT NULL,' +
      'captured_at TEXT NOT NULL,' +
      'UNIQUE(repository_id, captured_at)' +
    ')',
  ).catch(() => {})
  await run(
    'CREATE TABLE IF NOT EXISTS github_ai_reviews (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'repository_id INTEGER NOT NULL REFERENCES github_repositories(id) ON DELETE CASCADE,' +
      'provider TEXT NOT NULL,' +
      'model TEXT NOT NULL,' +
      'category TEXT DEFAULT \'\',' +
      'summary TEXT DEFAULT \'\',' +
      'confidence REAL DEFAULT 0,' +
      'worth_push INTEGER NOT NULL DEFAULT 0,' +
      'raw_output TEXT DEFAULT \'\',' +
      "created_at TEXT NOT NULL DEFAULT (datetime('now'))" +
    ')',
  ).catch(() => {})
  await run('CREATE INDEX IF NOT EXISTS idx_github_snapshots_repo_time ON github_star_snapshots(repository_id, captured_at)').catch(() => {})
  await run(
    'CREATE TABLE IF NOT EXISTS github_subscription_repositories (' +
      'subscription_id INTEGER NOT NULL REFERENCES github_subscriptions(id) ON DELETE CASCADE,' +
      'repository_id INTEGER NOT NULL REFERENCES github_repositories(id) ON DELETE CASCADE,' +
      'first_matched_at TEXT NOT NULL,' +
      'last_matched_at TEXT NOT NULL,' +
      'PRIMARY KEY(subscription_id, repository_id)' +
    ')',
  ).catch(() => {})
  await run(
    'CREATE TABLE IF NOT EXISTS github_job_runs (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'job_key TEXT NOT NULL UNIQUE,' +
      'job_type TEXT NOT NULL,' +
      'status TEXT NOT NULL,' +
      'details TEXT DEFAULT \'\',' +
      'started_at TEXT NOT NULL,' +
      'finished_at TEXT DEFAULT NULL' +
    ')',
  ).catch(() => {})
  await run(
    'CREATE TABLE IF NOT EXISTS github_ai_review_attempts (' +
      'repository_id INTEGER PRIMARY KEY REFERENCES github_repositories(id) ON DELETE CASCADE,' +
      'status TEXT NOT NULL DEFAULT \'pending\',' +
      'attempts INTEGER NOT NULL DEFAULT 0,' +
      'last_error TEXT DEFAULT \'\',' +
      'next_attempt_at TEXT DEFAULT NULL,' +
      'updated_at TEXT NOT NULL' +
    ')',
  ).catch(() => {})
  await run(
    'CREATE TABLE IF NOT EXISTS github_simulation_tasks (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'job_key TEXT NOT NULL UNIQUE,' +
      'to_email TEXT NOT NULL,' +
      'job_type TEXT NOT NULL DEFAULT \'daily\',' +
      'run_at TEXT NOT NULL,' +
      'status TEXT NOT NULL DEFAULT \'pending\',' +
      'details TEXT DEFAULT \'\',' +
      'created_at TEXT NOT NULL,' +
      'finished_at TEXT DEFAULT NULL' +
    ')',
  ).catch(() => {})
  await run(
    'CREATE TABLE IF NOT EXISTS github_digest_drafts (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'draft_key TEXT NOT NULL UNIQUE,' +
      'subscription_id INTEGER NOT NULL REFERENCES github_subscriptions(id) ON DELETE CASCADE,' +
      'job_type TEXT NOT NULL,' +
      'date_key TEXT NOT NULL,' +
      'html TEXT NOT NULL,' +
      'item_count INTEGER NOT NULL DEFAULT 0,' +
      'status TEXT NOT NULL DEFAULT \'locked\',' +
      'send_at TEXT NOT NULL,' +
      'created_at TEXT NOT NULL,' +
      'sent_at TEXT DEFAULT NULL,' +
      'UNIQUE(subscription_id, job_type, date_key)' +
    ')',
  ).catch(() => {})
  await run(
    `INSERT OR IGNORE INTO github_categories (name, description, keywords, languages) VALUES
      ('AI应用/大模型应用/AI开发编程', '关注 AI 应用、LLM 应用、Agent、编程助手和开发工具，不以算法研究为主', '["AI application","LLM application","AI agent","developer tools","coding assistant","RAG","MCP","skill","AI应用","大模型应用","AI开发编程"]', '["Python","TypeScript","JavaScript","Go","Rust"]'),
      ('机械、材料', '关注机械工程、机器人、CAD/CAE、材料科学和制造技术', '["mechanical engineering","robotics","CAD","CAE","materials science","manufacturing","机械","材料","机器人"]', '["Python","C++","Rust","C","MATLAB"]')`,
  ).catch(() => {})
  await run("UPDATE github_categories SET enabled = 0 WHERE name IN ('AI / 大模型', '开发者工具', '基础设施 / 云原生', '嵌入式 / 硬件')").catch(() => {})

  await run("UPDATE users SET role = 'admin', quota_plan = 'admin' WHERE id = 1").catch(() => {})

  await run(`CREATE TABLE IF NOT EXISTS twitch_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    twitch_user_id TEXT NOT NULL,
    login TEXT NOT NULL,
    display_name TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT DEFAULT '',
    expires_at TEXT DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, twitch_user_id)
  )`).catch(() => {})
  await run(`CREATE TABLE IF NOT EXISTS twitch_drop_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES twitch_accounts(id) ON DELETE CASCADE,
    game_id TEXT NOT NULL, game_name TEXT NOT NULL,
    channel_id TEXT NOT NULL, channel_name TEXT NOT NULL,
    start_at TEXT NOT NULL, end_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).catch(() => {})

  console.log('[DB] Schema ready')
}

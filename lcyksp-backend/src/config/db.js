import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import sqlite3 from 'sqlite3'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DB_DIR = process.env.LCYKSP_DB_DIR
  ? path.resolve(process.env.LCYKSP_DB_DIR)
  : path.resolve(__dirname, '../../data/db')
const DB_PATH = path.join(DB_DIR, 'database.db')

let db = null
let siteMonitorDb = null

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

export function getDbPath() {
  return DB_PATH
}

/**
 * Website-monitor transactions use a second connection. SQLite then enforces isolation with its
 * write lock instead of allowing unrelated statements on the process-wide connection to become
 * part of an open monitor transaction.
 */
export function getSiteMonitorDb() {
  if (!siteMonitorDb) throw new Error('网站监测数据库连接尚未初始化，请先调用 initDb()')
  return siteMonitorDb
}

function closeConnection(connection) {
  if (!connection) return Promise.resolve()
  return new Promise((resolve, reject) => connection.close((error) => (error ? reject(error) : resolve())))
}

export async function closeDb() {
  const connections = [siteMonitorDb, db].filter(Boolean)
  siteMonitorDb = null
  db = null
  for (const connection of connections) await closeConnection(connection)
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
      'last_ip TEXT DEFAULT NULL,' +
      'last_login_at TEXT DEFAULT NULL,' +
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
    'CREATE TABLE IF NOT EXISTS login_attempts (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'username TEXT NOT NULL,' +
      'window_start TEXT NOT NULL,' +
      'count INTEGER NOT NULL DEFAULT 0,' +
      "updated_at TEXT NOT NULL DEFAULT (datetime('now'))," +
      'UNIQUE(username, window_start)' +
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
  await run('ALTER TABLE users ADD COLUMN last_ip TEXT DEFAULT NULL').catch(() => {})
  await run('ALTER TABLE users ADD COLUMN last_login_at TEXT DEFAULT NULL').catch(() => {})
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
  await run('CREATE INDEX IF NOT EXISTS idx_login_attempts_lookup ON login_attempts(username, window_start)').catch(() => {})

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
      'trending_rank INTEGER DEFAULT NULL,' +
      "trending_since TEXT DEFAULT ''," +
      'trending_seen_at TEXT DEFAULT NULL,' +
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
      "relevance_status TEXT NOT NULL DEFAULT 'pending'," +
      'relevance_score REAL DEFAULT 0,' +
      "relevance_reason TEXT DEFAULT ''," +
      'relevance_reviewed_at TEXT DEFAULT NULL,' +
      'PRIMARY KEY(subscription_id, repository_id)' +
    ')',
  ).catch(() => {})
  await run('ALTER TABLE github_repositories ADD COLUMN trending_rank INTEGER DEFAULT NULL').catch(() => {})
  await run("ALTER TABLE github_repositories ADD COLUMN trending_since TEXT DEFAULT ''").catch(() => {})
  await run('ALTER TABLE github_repositories ADD COLUMN trending_seen_at TEXT DEFAULT NULL').catch(() => {})
  await run('CREATE INDEX IF NOT EXISTS idx_github_repositories_trending ON github_repositories(trending_seen_at, trending_rank)').catch(() => {})
  await run("ALTER TABLE github_subscription_repositories ADD COLUMN relevance_status TEXT NOT NULL DEFAULT 'pending'").catch(() => {})
  await run('ALTER TABLE github_subscription_repositories ADD COLUMN relevance_score REAL DEFAULT 0').catch(() => {})
  await run("ALTER TABLE github_subscription_repositories ADD COLUMN relevance_reason TEXT DEFAULT ''").catch(() => {})
  await run('ALTER TABLE github_subscription_repositories ADD COLUMN relevance_reviewed_at TEXT DEFAULT NULL').catch(() => {})
  await run('CREATE INDEX IF NOT EXISTS idx_github_subscription_relevance ON github_subscription_repositories(subscription_id, relevance_status, repository_id)').catch(() => {})
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
    'CREATE TABLE IF NOT EXISTS github_digest_pushes (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'subscription_id INTEGER NOT NULL REFERENCES github_subscriptions(id) ON DELETE CASCADE,' +
      'repository_id INTEGER NOT NULL REFERENCES github_repositories(id) ON DELETE CASCADE,' +
      'job_type TEXT NOT NULL DEFAULT \'daily\',' +
      'pushed_at TEXT NOT NULL,' +
      'push_count INTEGER NOT NULL DEFAULT 1,' +
      'UNIQUE(subscription_id, repository_id, job_type)' +
    ')',
  ).catch(() => {})
  await run('CREATE INDEX IF NOT EXISTS idx_github_digest_pushes_lookup ON github_digest_pushes(subscription_id, job_type, pushed_at)').catch(() => {})
  await run("ALTER TABLE github_digest_drafts ADD COLUMN item_ids TEXT NOT NULL DEFAULT '[]'").catch(() => {})
  await run('ALTER TABLE github_digest_drafts ADD COLUMN send_attempts INTEGER NOT NULL DEFAULT 0').catch(() => {})
  await run(
    `INSERT OR IGNORE INTO github_categories (name, description, keywords, languages) VALUES
      ('AI应用/大模型应用/AI开发编程', '关注可落地的大模型应用、Agent、RAG、MCP、提示词工程、AI生成创作、图像/视频与多模态应用、AI编程工具、Coding Agent/Harness 和 Skill 技能生态；排除纯算法论文及无直接关系的通用工具', '["LLM application","AI agent framework","RAG application","MCP server","prompt engineering","prompt library","generative AI content creation","AI creative tools","AI image generation","AI video generation","multimodal AI application","AI coding tool","coding agent","coding agent harness","agent harness","LLM harness","Claude Code tool","Codex tool","AI agent skill","Claude skill","Codex skill","agent skills","大模型应用","智能体应用","提示词工程","提示词库","AI生成创作","AI内容创作","AI编程工具","编码智能体","智能体框架","AI技能","Skill生态"]', '["Python","TypeScript","JavaScript","Go","Rust"]'),
      ('机械、材料', '关注机械工程、机械设计制造、增材制造、材料及机械自动化、材料科学、材料成型技术、SolidWorks、机器人、CAD/CAE 和制造技术', '["mechanical engineering","robotics","CAD","CAE","SolidWorks","SolidWorks API","SolidWorks macro","SolidWorks add-in","materials science","manufacturing","机械","材料","机器人","机械设计制造","增材制造","additive manufacturing","材料及机械自动化","mechanical automation","材料科学","材料成型技术","materials processing"]', '["Python","C++","Rust","C","MATLAB"]')`,
  ).catch(() => {})
  await run(`UPDATE github_categories SET description = '关注可落地的 AI/大模型应用、Agent 与工作流、RAG、MCP、编程助手和 AI 开发工具；排除纯算法论文、通用开发工具及仅顺带提及 AI 的项目', keywords = '["LLM application","AI agent framework","RAG application","MCP server","AI coding assistant","generative AI application","AI workflow automation","大模型应用","智能体应用","AI开发编程"]' WHERE name = 'AI应用/大模型应用/AI开发编程' AND keywords = '["AI application","LLM application","AI agent","developer tools","coding assistant","RAG","MCP","skill","AI应用","大模型应用","AI开发编程"]'`).catch(() => {})
  await run(`UPDATE github_categories SET description = '关注机械工程、机械设计制造、增材制造、材料及机械自动化、材料科学、材料成型技术、机器人、CAD/CAE 和制造技术', keywords = '["mechanical engineering","robotics","CAD","CAE","materials science","manufacturing","机械","材料","机器人","机械设计制造","增材制造","additive manufacturing","材料及机械自动化","mechanical automation","材料科学","材料成型技术","materials processing"]' WHERE name = '机械、材料' AND keywords = '["mechanical engineering","robotics","CAD","CAE","materials science","manufacturing","机械","材料","机器人"]'`).catch(() => {})
  await run(`UPDATE github_categories SET description = '关注可落地的 AI/大模型应用、Agent 与工作流、RAG、MCP、编程助手、图像/视频生成、多模态应用和 AI 开发工具；排除纯算法论文、通用开发工具及仅顺带提及 AI 的项目', keywords = '["LLM application","AI agent framework","RAG application","MCP server","AI coding assistant","generative AI application","AI workflow automation","AI image generation","text to image","AI video generation","multimodal AI application","大模型应用","智能体应用","AI开发编程","AI图像生成","AI视频生成","多模态应用"]' WHERE name = 'AI应用/大模型应用/AI开发编程' AND keywords = '["LLM application","AI agent framework","RAG application","MCP server","AI coding assistant","generative AI application","AI workflow automation","大模型应用","智能体应用","AI开发编程"]'`).catch(() => {})
  await run(`UPDATE github_categories SET description = '关注机械工程、机械设计制造、增材制造、材料及机械自动化、材料科学、材料成型技术、SolidWorks、机器人、CAD/CAE 和制造技术', keywords = '["mechanical engineering","robotics","CAD","CAE","SolidWorks","SolidWorks API","SolidWorks macro","SolidWorks add-in","materials science","manufacturing","机械","材料","机器人","机械设计制造","增材制造","additive manufacturing","材料及机械自动化","mechanical automation","材料科学","材料成型技术","materials processing"]', languages = '["Python","C++","Rust","C","MATLAB","C#","VBA"]' WHERE name = '机械、材料' AND keywords = '["mechanical engineering","robotics","CAD","CAE","materials science","manufacturing","机械","材料","机器人","机械设计制造","增材制造","additive manufacturing","材料及机械自动化","mechanical automation","材料科学","材料成型技术","materials processing"]'`).catch(() => {})
  const aiScopeMigration = await run(`UPDATE github_categories SET description = '关注可落地的大模型应用、Agent、RAG、MCP、提示词工程、AI生成创作、图像/视频与多模态应用、AI编程工具、Coding Agent/Harness 和 Skill 技能生态；排除纯算法论文及无直接关系的通用工具', keywords = '["LLM application","AI agent framework","RAG application","MCP server","prompt engineering","prompt library","generative AI content creation","AI creative tools","AI image generation","AI video generation","multimodal AI application","AI coding tool","coding agent","coding agent harness","agent harness","LLM harness","Claude Code tool","Codex tool","AI agent skill","Claude skill","Codex skill","agent skills","大模型应用","智能体应用","提示词工程","提示词库","AI生成创作","AI内容创作","AI编程工具","编码智能体","智能体框架","AI技能","Skill生态"]' WHERE name = 'AI应用/大模型应用/AI开发编程' AND keywords = '["LLM application","AI agent framework","RAG application","MCP server","AI coding assistant","generative AI application","AI workflow automation","AI image generation","text to image","AI video generation","multimodal AI application","大模型应用","智能体应用","AI开发编程","AI图像生成","AI视频生成","多模态应用"]'`).catch(() => ({ changes: 0 }))
  if (aiScopeMigration.changes) {
    await run(`UPDATE github_subscription_repositories SET relevance_status='pending', relevance_score=0, relevance_reason='', relevance_reviewed_at=NULL WHERE relevance_status='rejected' AND subscription_id IN (SELECT s.id FROM github_subscriptions s, json_each(s.category_ids) c WHERE CAST(c.value AS INTEGER)=1)`).catch(() => {})
  }
  const mechanicalLanguageMigration = await run(`UPDATE github_categories SET languages = '["Python","C++","Rust","C","MATLAB"]' WHERE name = '机械、材料' AND languages = '["Python","C++","Rust","C","MATLAB","C#","VBA"]'`).catch(() => ({ changes: 0 }))
  if (mechanicalLanguageMigration.changes) {
    await run(`UPDATE github_subscription_repositories SET relevance_status='pending', relevance_score=0, relevance_reason='', relevance_reviewed_at=NULL WHERE relevance_status='rejected' AND subscription_id IN (SELECT s.id FROM github_subscriptions s, json_each(s.category_ids) c WHERE CAST(c.value AS INTEGER)=2) AND repository_id IN (SELECT id FROM github_repositories WHERE lower(full_name || ' ' || description) LIKE '%solidworks%')`).catch(() => {})
  }
  await run("UPDATE github_categories SET enabled = 0 WHERE name IN ('AI / 大模型', '开发者工具', '基础设施 / 云原生', '嵌入式 / 硬件')").catch(() => {})

  // 不再无条件把 id=1 提升为 admin —— 否则数据库一旦重建，第一个注册的人就是管理员。
  // 需要引导管理员时，设置环境变量 LCYKSP_ADMIN_USERNAME=<用户名> 后启动一次即可。
  const bootstrapAdmin = (process.env.LCYKSP_ADMIN_USERNAME || '').trim()
  if (bootstrapAdmin) {
    await run("UPDATE users SET role = 'admin', quota_plan = 'admin' WHERE username = ?", [bootstrapAdmin]).catch(
      () => {},
    )
  }

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

  await run(`CREATE TABLE IF NOT EXISTS algs_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season TEXT NOT NULL,
    league TEXT NOT NULL,
    region TEXT NOT NULL,
    payload TEXT NOT NULL,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).catch(() => {})
  await run('CREATE INDEX IF NOT EXISTS idx_algs_snapshots_event ON algs_snapshots(season, league, region, id)').catch(() => {})

  // 微信步数修改（Zepp Life）账号凭据。站长 2026-09-15 拍板：加密保存密码而非只存 token，
  // 换取「绑定一次、长期可用」；密码用 utils/crypto.js 的 AES-256-CBC 加密后落库。
  // account_hash 只作同用户去重键（sha256 前 32 位），避免拿脱敏串当唯一键带来的歧义。
  await run(`CREATE TABLE IF NOT EXISTS step_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL DEFAULT '',
    account_enc TEXT NOT NULL,
    account_hash TEXT NOT NULL,
    account_masked TEXT NOT NULL,
    password_enc TEXT NOT NULL,
    zepp_user_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'invalid')),
    last_error TEXT NOT NULL DEFAULT '',
    last_success_at TEXT DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, account_hash)
  )`).catch(() => {})
  await run('CREATE INDEX IF NOT EXISTS idx_step_accounts_user ON step_accounts(user_id, created_at)').catch(() => {})

  await run(`CREATE TABLE IF NOT EXISTS step_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES step_accounts(id) ON DELETE CASCADE,
    steps INTEGER NOT NULL,
    target_date TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('success', 'failed')),
    exit_via TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).catch(() => {})
  await run('CREATE INDEX IF NOT EXISTS idx_step_submissions_account ON step_submissions(account_id, created_at DESC)').catch(() => {})
  await run('CREATE INDEX IF NOT EXISTS idx_step_submissions_user ON step_submissions(user_id, created_at DESC)').catch(() => {})

  // 战争雷霆（Gaijin 交易所）物品价格监控。物品主表 + 每日价格快照两张表。
  // market_name 是 Gaijin 侧唯一标识（如 id50347_mig_25pd_ussr）；价格存原始整数（Gaijin 放大值），
  // 展示层再换算成 GJN。cron 每天拉一次全目录，快照按北京自然日去重。
  await run(`CREATE TABLE IF NOT EXISTS wt_market_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    appid INTEGER NOT NULL DEFAULT 1067,
    market_name TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    icon_url TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    color TEXT NOT NULL DEFAULT '',
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(appid, market_name)
  )`).catch(() => {})
  await run('CREATE INDEX IF NOT EXISTS idx_wt_items_name ON wt_market_items(display_name)').catch(() => {})

  await run(`CREATE TABLE IF NOT EXISTS wt_price_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES wt_market_items(id) ON DELETE CASCADE,
    snapshot_date TEXT NOT NULL,
    buy_price INTEGER NOT NULL DEFAULT 0,
    sell_price INTEGER NOT NULL DEFAULT 0,
    buy_count INTEGER NOT NULL DEFAULT 0,
    sell_count INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'gjn',
    captured_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(item_id, snapshot_date)
  )`).catch(() => {})
  await run('CREATE INDEX IF NOT EXISTS idx_wt_snapshots_item_date ON wt_price_snapshots(item_id, snapshot_date)').catch(() => {})

  // 战争雷霆操作日志：记录每次登录/快照/搜索/刷新（自动或手动）及其结果，用于事后定位
  // 是账号被风控、池子出问题、还是搜索/爬取本身出错。detail 已脱敏（绝不含密码/完整 JWT）。
  await run(`CREATE TABLE IF NOT EXISTS wt_market_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    op TEXT NOT NULL,
    trigger TEXT NOT NULL DEFAULT 'auto',
    status TEXT NOT NULL DEFAULT 'ok',
    code TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    exit_ip TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).catch(() => {})
  await run('CREATE INDEX IF NOT EXISTS idx_wt_logs_created ON wt_market_logs(created_at DESC)').catch(() => {})

  // 战争雷霆物品收藏（每用户维度）：用户点星标即入库，进页面拉自己的收藏 id 列表，
  // 前端把收藏置顶 + 「我的收藏」筛选。物品被删则收藏级联清理。
  await run(`CREATE TABLE IF NOT EXISTS wt_market_favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES wt_market_items(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, item_id)
  )`).catch(() => {})
  await run('CREATE INDEX IF NOT EXISTS idx_wt_fav_user ON wt_market_favorites(user_id)').catch(() => {})

  // Website monitor configuration and durable state. The scheduler interval is fixed per source;
  // credentials (when configured) are encrypted before they are written to auth_secret.
  await run(`CREATE TABLE IF NOT EXISTS site_monitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL UNIQUE CHECK(source IN ('justwoker_models', 'hzu_postgraduate')),
    display_name TEXT NOT NULL,
    target_url TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
    interval_seconds INTEGER NOT NULL,
    recipient_email TEXT NOT NULL DEFAULT '1296757861@qq.com',
    auth_type TEXT NOT NULL DEFAULT 'none' CHECK(auth_type IN ('none', 'cookie', 'bearer')),
    auth_secret TEXT DEFAULT NULL,
    etag TEXT DEFAULT NULL,
    last_modified TEXT DEFAULT NULL,
    baseline_ready INTEGER NOT NULL DEFAULT 0 CHECK(baseline_ready IN (0, 1)),
    last_checked_at TEXT DEFAULT NULL,
    last_success_at TEXT DEFAULT NULL,
    next_run_at TEXT DEFAULT NULL,
    last_status TEXT NOT NULL DEFAULT 'idle' CHECK(last_status IN ('idle', 'running', 'success', 'failed', 'disabled')),
    consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),
    last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK((source = 'justwoker_models' AND interval_seconds = 1800)
       OR (source = 'hzu_postgraduate' AND interval_seconds = 3600))
  )`)

  await run(`CREATE TABLE IF NOT EXISTS site_monitor_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id INTEGER NOT NULL REFERENCES site_monitors(id) ON DELETE CASCADE,
    item_key TEXT NOT NULL,
    item_type TEXT NOT NULL CHECK(item_type IN ('model', 'announcement')),
    title TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    published_at TEXT DEFAULT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
    missing_count INTEGER NOT NULL DEFAULT 0 CHECK(missing_count >= 0),
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    removed_at TEXT DEFAULT NULL,
    UNIQUE(monitor_id, item_key)
  )`)

  await run(`CREATE TABLE IF NOT EXISTS site_monitor_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id INTEGER NOT NULL REFERENCES site_monitors(id) ON DELETE CASCADE,
    trigger_type TEXT NOT NULL DEFAULT 'schedule' CHECK(trigger_type IN ('schedule', 'manual', 'diagnose', 'baseline')),
    status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'success', 'not_modified', 'failed')),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT DEFAULT NULL,
    http_status INTEGER DEFAULT NULL,
    item_count INTEGER NOT NULL DEFAULT 0 CHECK(item_count >= 0),
    added_count INTEGER NOT NULL DEFAULT 0 CHECK(added_count >= 0),
    removed_count INTEGER NOT NULL DEFAULT 0 CHECK(removed_count >= 0),
    duration_ms INTEGER DEFAULT NULL CHECK(duration_ms IS NULL OR duration_ms >= 0),
    error_message TEXT NOT NULL DEFAULT ''
  )`)

  await run(`CREATE TABLE IF NOT EXISTS site_monitor_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id INTEGER NOT NULL REFERENCES site_monitors(id) ON DELETE CASCADE,
    run_id INTEGER DEFAULT NULL REFERENCES site_monitor_runs(id) ON DELETE SET NULL,
    event_key TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL CHECK(event_type IN ('model_added', 'model_removed', 'announcement_added', 'monitor_failed', 'monitor_recovered')),
    title TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)

  await run(`CREATE TABLE IF NOT EXISTS site_monitor_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id INTEGER NOT NULL REFERENCES site_monitors(id) ON DELETE CASCADE,
    dedupe_key TEXT NOT NULL UNIQUE,
    event_ids_json TEXT NOT NULL DEFAULT '[]',
    recipient_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    body_html TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sending', 'sent', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_attempt_at TEXT DEFAULT NULL,
    sent_at TEXT DEFAULT NULL,
    error_message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)

  await run('CREATE INDEX IF NOT EXISTS idx_site_monitors_due ON site_monitors(enabled, next_run_at)')
  await run('CREATE INDEX IF NOT EXISTS idx_site_monitor_items_active ON site_monitor_items(monitor_id, is_active, item_type)')
  await run('CREATE INDEX IF NOT EXISTS idx_site_monitor_runs_recent ON site_monitor_runs(monitor_id, started_at DESC)')
  await run('CREATE INDEX IF NOT EXISTS idx_site_monitor_events_recent ON site_monitor_events(monitor_id, created_at DESC)')
  await run('CREATE INDEX IF NOT EXISTS idx_site_monitor_deliveries_due ON site_monitor_deliveries(status, next_attempt_at)')

  // Preserve administrator changes on restart: defaults are inserted only when a source is absent.
  await run(
    `INSERT INTO site_monitors
      (source, display_name, target_url, enabled, interval_seconds, recipient_email, auth_type, last_status)
     VALUES (?, ?, ?, 0, ?, ?, 'none', 'idle')
     ON CONFLICT(source) DO NOTHING`,
    ['justwoker_models', 'JustWoker 模型广场', 'https://api.justwoker.icu/v1/models', 1800, '1296757861@qq.com'],
  )
  // `/pricing` is the SPA document, and `/api/pricing` requires a *login session*, whose refresh
  // token is revoked/rotated by upstream and cannot be kept alive unattended. `/v1/models` is the
  // OpenAI-compatible relay endpoint: it accepts a long-lived `sk-` API token, so the monitor no
  // longer depends on a browser session at all. Only the two obsolete built-in URLs are migrated, so
  // any administrator-owned target is preserved.
  await run(
    `UPDATE site_monitors SET target_url = ?, etag = NULL, last_modified = NULL,
       last_status = 'idle', consecutive_failures = 0, last_error = '', next_run_at = NULL,
       updated_at = datetime('now')
     WHERE source = 'justwoker_models' AND target_url IN (?, ?)`,
    [
      'https://api.justwoker.icu/v1/models',
      'https://api.justwoker.icu/pricing',
      'https://api.justwoker.icu/api/pricing',
    ],
  )
  await run(
    `INSERT INTO site_monitors
      (source, display_name, target_url, enabled, interval_seconds, recipient_email, auth_type, last_status)
     VALUES (?, ?, ?, 0, ?, ?, 'none', 'idle')
     ON CONFLICT(source) DO NOTHING`,
    ['hzu_postgraduate', '惠州学院研究生招生', 'https://www.hzu.edu.cn/yjszs/list.htm', 3600, '1296757861@qq.com'],
  )

  await new Promise((resolve, reject) => {
    siteMonitorDb = new sqlite3.Database(DB_PATH, (err) => (err ? reject(err) : resolve()))
  })
  await new Promise((resolve, reject) => siteMonitorDb.run('PRAGMA busy_timeout=10000;', (err) => (err ? reject(err) : resolve())))
  await new Promise((resolve, reject) => siteMonitorDb.run('PRAGMA foreign_keys=ON;', (err) => (err ? reject(err) : resolve())))

  console.log('[DB] Schema ready')
}

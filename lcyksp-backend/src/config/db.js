import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import sqlite3 from 'sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_DIR = path.resolve(__dirname, '../../data/db');
const DB_PATH = path.join(DB_DIR, 'database.db');

let db = null;

/** 获取数据库实例（确保已初始化） */
export function getDb() {
  if (!db) throw new Error('数据库尚未初始化，请先调用 initDb()');
  return db;
}

/** 初始化数据库连接与表结构 */
export async function initDb() {
  // 确保 data/db/ 目录存在
  fs.mkdirSync(DB_DIR, { recursive: true });

  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) return reject(err);
      console.log('[DB] SQLite3 连接成功:', DB_PATH);
    });

    db.serialize(() => {
      db.run('PRAGMA journal_mode=WAL;');
      db.run('PRAGMA foreign_keys=ON;');

      // ---------- family_groups 表 — 家庭组 ----------
      db.run(
        `CREATE TABLE IF NOT EXISTS family_groups (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          group_name VARCHAR(64) NOT NULL UNIQUE,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );`,
      );

      // ---------- users 表（含扩展字段） ----------
      db.run(
        `CREATE TABLE IF NOT EXISTS users (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          username   VARCHAR(64) NOT NULL UNIQUE,
          password   TEXT        NOT NULL,
          role       TEXT        NOT NULL DEFAULT 'user',
          group_id   INTEGER DEFAULT NULL REFERENCES family_groups(id),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );`,
      );

      // ---------- gallery_photos 表 — 相册照片 ----------
      db.run(
        `CREATE TABLE IF NOT EXISTS gallery_photos (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          file_name       TEXT    NOT NULL,
          file_path       TEXT    NOT NULL,
          file_size       INTEGER NOT NULL DEFAULT 0,
          family_group_id INTEGER DEFAULT NULL REFERENCES family_groups(id),
          uploader_id     INTEGER NOT NULL REFERENCES users(id),
          created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );`,
      );

      // ---------- recipes 表 — 赛博菜谱 ----------
      db.run(
        `CREATE TABLE IF NOT EXISTS recipes (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       VARCHAR(128) NOT NULL,
          ingredients TEXT    DEFAULT '',
          tags       TEXT    DEFAULT '',
          steps      TEXT    DEFAULT '',
          creator_id INTEGER DEFAULT NULL REFERENCES users(id),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );`,
      );

      // ---------- transfers 表（同V3） ----------
      db.run(
        `CREATE TABLE IF NOT EXISTS transfers (
          id            VARCHAR(32) PRIMARY KEY,
          file_name     TEXT    NOT NULL,
          file_path     TEXT    NOT NULL,
          file_size     INTEGER NOT NULL DEFAULT 0,
          password      TEXT    DEFAULT NULL,
          max_downloads INTEGER NOT NULL DEFAULT 1,
          current_downloads INTEGER NOT NULL DEFAULT 0,
          expire_time   TEXT    NOT NULL,
          owner_id      INTEGER DEFAULT NULL REFERENCES users(id),
          is_private    INTEGER NOT NULL DEFAULT 0,
          created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
        );`,
      );

      // ---------- 幂等迁移：旧表补充可能缺失的列 ----------
      db.run("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'", () => {});
      db.run('ALTER TABLE users ADD COLUMN group_id INTEGER DEFAULT NULL REFERENCES family_groups(id)', () => {});
      db.run('ALTER TABLE transfers ADD COLUMN owner_id INTEGER DEFAULT NULL REFERENCES users(id)', () => {});
      db.run('ALTER TABLE transfers ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0', () => {});

      // ---------- 索引优化：高频查询字段 ----------
      db.run('CREATE INDEX IF NOT EXISTS idx_recipes_name ON recipes(name)', () => {});
      db.run('CREATE INDEX IF NOT EXISTS idx_recipes_tags ON recipes(tags)', () => {});
      db.run('CREATE INDEX IF NOT EXISTS idx_transfers_expire ON transfers(expire_time)', () => {});
      db.run('CREATE INDEX IF NOT EXISTS idx_gallery_photos_group ON gallery_photos(family_group_id)', () => {});

      // 系统初始化：确保 ID=1 的用户为 admin
      db.run(
        `UPDATE users SET role = 'admin' WHERE id = 1 AND role != 'admin'`,
        function () {
          if (this.changes > 0) console.log('[DB] ID=1 已升级为管理员');
        },
      );

      console.log('[DB] V4.2 表结构就绪');
      resolve();
    });
  });
}

export default { initDb, getDb };

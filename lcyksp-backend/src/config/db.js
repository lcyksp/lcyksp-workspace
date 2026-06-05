import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import sqlite3 from 'sqlite3';

var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);

var DB_DIR = path.resolve(__dirname, '../../data/db');
var DB_PATH = path.join(DB_DIR, 'database.db');

var db = null;

export function getDb() {
  if (!db) throw new Error('数据库尚未初始化，请先调用 initDb()');
  return db;
}

export async function initDb() {
  fs.mkdirSync(DB_DIR, { recursive: true });

  return new Promise(function (resolve, reject) {
    db = new sqlite3.Database(DB_PATH, function (err) {
      if (err) return reject(err);
      console.log('[DB] SQLite3 连接成功:', DB_PATH);
    });

    db.serialize(function () {
      db.run('PRAGMA journal_mode=WAL;');
      db.run('PRAGMA foreign_keys=ON;');

      db.run(
        'CREATE TABLE IF NOT EXISTS family_groups (' +
        '  id         INTEGER PRIMARY KEY AUTOINCREMENT,' +
        '  group_name VARCHAR(64) NOT NULL UNIQUE,' +
        '  created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))' +
        ');',
      );

      db.run(
        'CREATE TABLE IF NOT EXISTS users (' +
        '  id         INTEGER PRIMARY KEY AUTOINCREMENT,' +
        '  username   VARCHAR(64) NOT NULL UNIQUE,' +
        '  password   TEXT        NOT NULL,' +
        '  role       TEXT        NOT NULL DEFAULT \'user\',' +
        '  group_id   INTEGER DEFAULT NULL REFERENCES family_groups(id),' +
        '  created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))' +
        ');',
      );

      db.run(
        'CREATE TABLE IF NOT EXISTS gallery_photos (' +
        '  id              INTEGER PRIMARY KEY AUTOINCREMENT,' +
        '  file_name       TEXT    NOT NULL,' +
        '  file_path       TEXT    NOT NULL,' +
        '  file_size       INTEGER NOT NULL DEFAULT 0,' +
        '  family_group_id INTEGER DEFAULT NULL REFERENCES family_groups(id),' +
        '  uploader_id     INTEGER NOT NULL REFERENCES users(id),' +
        '  created_at      TEXT NOT NULL DEFAULT (datetime(\'now\'))' +
        ');',
      );

      db.run(
        'CREATE TABLE IF NOT EXISTS recipes (' +
        '  id          INTEGER PRIMARY KEY AUTOINCREMENT,' +
        '  name        VARCHAR(128) NOT NULL,' +
        '  ingredients TEXT DEFAULT \'\',' +
        '  tags        TEXT DEFAULT \'\',' +
        '  steps       TEXT DEFAULT \'\',' +
        '  creator_id  INTEGER DEFAULT NULL,' +
        '  created_at  TEXT NOT NULL DEFAULT (datetime(\'now\'))' +
        ');',
      );

      db.run(
        'CREATE TABLE IF NOT EXISTS system_config (' +
        '  key   TEXT PRIMARY KEY,' +
        '  value TEXT NOT NULL' +
        ');',
      );

      db.run(
        'CREATE TABLE IF NOT EXISTS transfers (' +
        '  id            VARCHAR(32) PRIMARY KEY,' +
        '  file_name     TEXT    NOT NULL,' +
        '  file_path     TEXT    NOT NULL,' +
        '  file_size     INTEGER NOT NULL DEFAULT 0,' +
        '  password      TEXT    DEFAULT NULL,' +
        '  max_downloads INTEGER NOT NULL DEFAULT 1,' +
        '  current_downloads INTEGER NOT NULL DEFAULT 0,' +
        '  expire_time   TEXT    NOT NULL,' +
        '  owner_id      INTEGER DEFAULT NULL REFERENCES users(id),' +
        '  is_private    INTEGER NOT NULL DEFAULT 0,' +
        '  created_at    TEXT    NOT NULL DEFAULT (datetime(\'now\'))' +
        ');',
      );

      db.run("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'", function () {});
      db.run('ALTER TABLE users ADD COLUMN group_id INTEGER DEFAULT NULL REFERENCES family_groups(id)', function () {});
      db.run('ALTER TABLE transfers ADD COLUMN owner_id INTEGER DEFAULT NULL REFERENCES users(id)', function () {});
      db.run('ALTER TABLE transfers ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0', function () {});

      db.run('CREATE INDEX IF NOT EXISTS idx_recipes_name ON recipes(name)', function () {});
      db.run('CREATE INDEX IF NOT EXISTS idx_recipes_tags ON recipes(tags)', function () {});
      db.run('CREATE INDEX IF NOT EXISTS idx_transfers_expire ON transfers(expire_time)', function () {});
      db.run('CREATE INDEX IF NOT EXISTS idx_gallery_photos_group ON gallery_photos(family_group_id)', function () {});

      db.run(
        "UPDATE users SET role = 'admin' WHERE id = 1 AND role != 'admin'",
        function () {
          if (this.changes > 0) console.log('[DB] ID=1 已升级为管理员');
        },
      );

      console.log('[DB] 表结构就绪');
      resolve();
    });
  });
}

import { Router } from 'express';
import bcrypt from 'bcrypt';
import { getDb } from '../config/db.js';
import { signToken } from '../middleware/auth.js';

const router = Router();

const SALT_ROUNDS = 10;

// ========== POST /api/auth/register ==========
router.post('/register', async (req, res, next) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }
    if (typeof username !== 'string' || username.length < 2 || username.length > 32) {
      return res.status(400).json({ error: '用户名长度为 2-32 个字符' });
    }
    if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
      return res.status(400).json({ error: '密码长度为 6-128 个字符' });
    }

    const db = getDb();

    const existing = await new Promise((res, rej) =>
      db.get('SELECT id FROM users WHERE username = ?', [username], (e, r) => e ? rej(e) : res(r)),
    );
    if (existing) {
      return res.status(409).json({ error: '用户名已被注册' });
    }

    const hashed = await bcrypt.hash(password, SALT_ROUNDS);

    const result = await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO users (username, password) VALUES (?, ?)',
        [username, hashed],
        function (err) {
          if (err) return reject(err);
          resolve({ id: this.lastID });
        },
      );
    });

    // 第一个注册的用户自动设为 admin
    if (result.id === 1) {
      await new Promise((resolve, reject) => {
        db.run("UPDATE users SET role = 'admin' WHERE id = 1", (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    }

    // 查 role + group_id
    const user = await new Promise((res, rej) =>
      db.get('SELECT id, username, role, group_id FROM users WHERE id = ?', [result.id], (e, r) => e ? rej(e) : res(r)),
    );

    const token = signToken({ userId: user.id, username: user.username, role: user.role, groupId: user.group_id });

    res.status(201).json({
      token,
      user: { id: user.id, username: user.username, role: user.role, groupId: user.group_id },
    });
  } catch (err) {
    next(err);
  }
});

// ========== POST /api/auth/login ==========
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }

    const db = getDb();

    const user = await new Promise((res, rej) =>
      db.get('SELECT id, username, password, role, group_id FROM users WHERE username = ?', [username], (e, r) => e ? rej(e) : res(r)),
    );

    if (!user) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    const token = signToken({ userId: user.id, username: user.username, role: user.role, groupId: user.group_id });

    res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role, groupId: user.group_id },
    });
  } catch (err) {
    next(err);
  }
});

export default router;

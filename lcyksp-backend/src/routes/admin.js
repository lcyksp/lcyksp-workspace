/**
 * admin.js — 管理员后台 API
 *
 * 所有接口均需：① JWT 登录 ② role === 'admin'
 * 提供文件治理 + 用户治理两大功能。
 */
import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import bcrypt from 'bcrypt';
import { fileURLToPath } from 'url';
import { getDb } from '../config/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { encrypt } from '../utils/crypto.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();

// 所有 admin 接口都需要登录 + admin 角色
router.use(authMiddleware);
router.use(requireAdmin);

const SALT_ROUNDS = 10;

// ===================================================================
//  一、文件资产管理
// ===================================================================

// ---------- GET /api/admin/files — 文件列表 ----------
router.get('/files', async (req, res, next) => {
  try {
    const db = getDb();
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT t.id, t.file_name, t.file_path, t.file_size,
                t.password, t.max_downloads, t.current_downloads,
                t.expire_time, t.owner_id, t.is_private, t.created_at,
                u.username AS owner_name
         FROM transfers t
         LEFT JOIN users u ON t.owner_id = u.id
         ORDER BY t.created_at DESC`,
        (err, rows) => (err ? reject(err) : resolve(rows)),
      );
    });

    res.json({
      files: rows.map((r) => ({
        id: r.id,
        fileName: r.file_name,
        fileSize: r.file_size,
        hasPassword: !!r.password,
        maxDownloads: r.max_downloads,
        currentDownloads: r.current_downloads,
        expireTime: r.expire_time,
        ownerId: r.owner_id,
        ownerName: r.owner_name || '(游客)',
        isPrivate: !!r.is_private,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ---------- PUT /api/admin/files/:code — 编辑文件属性（过期时间/下载次数）----------
router.put('/files/:code', async (req, res, next) => {
  try {
    const { code } = req.params;
    const db = getDb();

    const record = await new Promise((resolve, reject) => {
      db.get('SELECT id, file_name, file_path, file_size, password, max_downloads, current_downloads, expire_time, owner_id, is_private, created_at FROM transfers WHERE id = ?', [code], (err, row) =>
        err ? reject(err) : resolve(row),
      );
    });

    if (!record) {
      return res.status(404).json({ error: '记录不存在' });
    }

    const { expireTime, maxDownloads } = req.body;
    const setClauses = [];
    const params = [];

    if (expireTime !== undefined) {
      if (typeof expireTime !== 'string' || !expireTime) {
        return res.status(400).json({ error: '过期时间格式无效' });
      }
      // 支持永久标记
      if (expireTime === 'permanent') {
        setClauses.push('expire_time = ?');
        params.push('2099-12-31T23:59:59.000Z');
      } else {
        // 验证是否为合法 ISO 日期
        const d = new Date(expireTime);
        if (isNaN(d.getTime())) {
          return res.status(400).json({ error: '过期时间不是有效的日期格式' });
        }
        setClauses.push('expire_time = ?');
        params.push(d.toISOString());
      }
    }

    if (maxDownloads !== undefined) {
      const num = parseInt(maxDownloads, 10);
      if (isNaN(num) || num < -1) {
        return res.status(400).json({ error: 'maxDownloads 必须为 ≥ -1 的整数（-1 = 无限次）' });
      }
      const finalVal = num === 0 ? -1 : num; // 0 也视为无限
      setClauses.push('max_downloads = ?');
      params.push(finalVal);
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: '未提供任何需要修改的字段' });
    }

    params.push(code);
    await new Promise((resolve, reject) => {
      db.run(`UPDATE transfers SET ${setClauses.join(', ')} WHERE id = ?`, params, (err) =>
        err ? reject(err) : resolve(),
      );
    });

    // 返回更新后的记录
    const updated = await new Promise((resolve, reject) => {
      db.get(
        `SELECT t.id, t.file_name, t.file_size, t.password,
                t.max_downloads, t.current_downloads,
                t.expire_time, t.owner_id, t.is_private, t.created_at,
                u.username AS owner_name
         FROM transfers t
         LEFT JOIN users u ON t.owner_id = u.id
         WHERE t.id = ?`,
        [code],
        (err, row) => (err ? reject(err) : resolve(row)),
      );
    });

    res.json({
      message: '文件属性已更新',
      file: updated ? {
        id: updated.id,
        fileName: updated.file_name,
        fileSize: updated.file_size,
        hasPassword: !!updated.password,
        maxDownloads: updated.max_downloads,
        currentDownloads: updated.current_downloads,
        expireTime: updated.expire_time,
        ownerId: updated.owner_id,
        ownerName: updated.owner_name || '(游客)',
        isPrivate: !!updated.is_private,
        createdAt: updated.created_at,
      } : null,
    });
  } catch (err) {
    next(err);
  }
});

// ---------- DELETE /api/admin/files/:code — 删除文件（DB + 磁盘）----------
router.delete('/files/:code', async (req, res, next) => {
  try {
    const { code } = req.params;
    const db = getDb();

    const record = await new Promise((resolve, reject) => {
      db.get('SELECT id, file_path FROM transfers WHERE id = ?', [code], (err, row) =>
        err ? reject(err) : resolve(row),
      );
    });

    if (!record) {
      return res.status(404).json({ error: '记录不存在' });
    }

    // 物理删除文件
    fs.unlink(record.file_path, (unlinkErr) => {
      if (unlinkErr && unlinkErr.code !== 'ENOENT') {
        console.error(`[管理员] 删除文件失败: ${record.file_path}`, unlinkErr.message);
      }
    });

    // 删除数据库记录
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM transfers WHERE id = ?', [code], (err) =>
        err ? reject(err) : resolve(),
      );
    });

    res.json({ message: '文件已删除', code });
  } catch (err) {
    next(err);
  }
});

// ===================================================================
//  二、用户管理
// ===================================================================

// ---------- GET /api/admin/users — 用户列表 ----------
router.get('/users', async (req, res, next) => {
  try {
    const db = getDb();
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT u.id, u.username, u.role, u.group_id, u.created_at,
                COALESCE(fg.group_name, '') AS group_name
         FROM users u
         LEFT JOIN family_groups fg ON u.group_id = fg.id
         ORDER BY u.id ASC`,
        (err, rows) => (err ? reject(err) : resolve(rows)),
      );
    });

    const userList = rows.map((r) => ({
      id: r.id,
      username: r.username,
      role: r.role,
      groupId: r.group_id,
      groupName: r.group_name || null,
      createdAt: r.created_at,
    }));

    res.json({ users: userList });
  } catch (err) {
    next(err);
  }
});

// ---------- POST /api/admin/users — 新增用户 ----------
router.post('/users', async (req, res, next) => {
  try {
    const { username, password, role } = req.body;

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

    // 查重
    const existing = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM users WHERE username = ?', [username], (err, row) =>
        err ? reject(err) : resolve(row),
      );
    });
    if (existing) {
      return res.status(409).json({ error: '用户名已被使用' });
    }

    const hashed = await bcrypt.hash(password, SALT_ROUNDS);
    const userRole = role === 'admin' ? 'admin' : 'user';

    const result = await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
        [username, hashed, userRole],
        function (err) {
          if (err) return reject(err);
          resolve({ id: this.lastID });
        },
      );
    });

    res.status(201).json({
      message: '用户创建成功',
      user: { id: result.id, username, role: userRole },
    });
  } catch (err) {
    next(err);
  }
});

// ---------- PUT /api/admin/users/:id — 修改用户（用户名/密码/角色）----------
router.put('/users/:id', async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (isNaN(userId)) {
      return res.status(400).json({ error: '无效的用户 ID' });
    }

    const db = getDb();

    // 确认用户存在
    const user = await new Promise((resolve, reject) => {
      db.get('SELECT id, username, role FROM users WHERE id = ?', [userId], (err, row) =>
        err ? reject(err) : resolve(row),
      );
    });
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }

    const { username, password, role } = req.body;

    // 构造 UPDATE SET 子句
    const setClauses = [];
    const params = [];

    if (username !== undefined) {
      if (typeof username !== 'string' || username.length < 2 || username.length > 32) {
        return res.status(400).json({ error: '用户名长度为 2-32 个字符' });
      }
      // 查重（排除自身）
      const dup = await new Promise((resolve, reject) => {
        db.get('SELECT id FROM users WHERE username = ? AND id != ?', [username, userId], (err, row) =>
          err ? reject(err) : resolve(row),
        );
      });
      if (dup) {
        return res.status(409).json({ error: '用户名已被其他用户使用' });
      }
      setClauses.push('username = ?');
      params.push(username);
    }

    if (password !== undefined) {
      if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
        return res.status(400).json({ error: '密码长度为 6-128 个字符' });
      }
      const hashed = await bcrypt.hash(password, SALT_ROUNDS);
      setClauses.push('password = ?');
      params.push(hashed);
    }

    if (role !== undefined) {
      if (!['user', 'admin'].includes(role)) {
        return res.status(400).json({ error: '角色仅支持 user 或 admin' });
      }
      setClauses.push('role = ?');
      params.push(role);
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: '未提供任何需要修改的字段' });
    }

    params.push(userId);
    await new Promise((resolve, reject) => {
      db.run(`UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`, params, (err) =>
        err ? reject(err) : resolve(),
      );
    });

    // 返回更新后的用户信息
    const updated = await new Promise((resolve, reject) => {
      db.get('SELECT id, username, role, group_id, created_at FROM users WHERE id = ?', [userId], (err, row) =>
        err ? reject(err) : resolve(row),
      );
    });

    res.json({
      message: '用户信息已更新',
      user: updated
        ? { id: updated.id, username: updated.username, role: updated.role, groupId: updated.group_id, createdAt: updated.created_at }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

// ---------- DELETE /api/admin/users/:id — 删除用户 ----------
router.delete('/users/:id', async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (isNaN(userId)) {
      return res.status(400).json({ error: '无效的用户 ID' });
    }

    // 禁止删除自己
    if (userId === req.user.userId) {
      return res.status(400).json({ error: '不能删除自己的账号' });
    }

    const db = getDb();

    const user = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM users WHERE id = ?', [userId], (err, row) =>
        err ? reject(err) : resolve(row),
      );
    });
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }

    // 删除该用户相关的所有记录（transfers、gallery_photos 的 owner 置空或删除）
    // 将用户的 transfer owner_id 置空，不删除文件
    await new Promise((resolve, reject) => {
      db.run('UPDATE transfers SET owner_id = NULL WHERE owner_id = ?', [userId], (err) =>
        err ? reject(err) : resolve(),
      );
    });

    // 将用户的 gallery_photos 的 uploader_id 置空
    await new Promise((resolve, reject) => {
      db.run('UPDATE gallery_photos SET uploader_id = NULL WHERE uploader_id = ?', [userId], (err) =>
        err ? reject(err) : resolve(),
      );
    });

    // 删除用户
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM users WHERE id = ?', [userId], (err) =>
        err ? reject(err) : resolve(),
      );
    });

    res.json({ message: '用户已删除', userId });
  } catch (err) {
    next(err);
  }
});

// ===================================================================
//  三、大模型配置管理（加密存储）
// ===================================================================

// ---------- POST /api/admin/config/llm — 更新大模型配置 ----------
router.post('/config/llm', async (req, res, next) => {
  try {
    var apiKey = req.body.apiKey;
    var apiUrl = req.body.apiUrl;
    var model = req.body.model;

    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 1) {
      return res.status(400).json({ error: 'API Key 不能为空' });
    }

    var encrypted = encrypt(apiKey.trim());

    var safeApiUrl = (typeof apiUrl === 'string' && apiUrl.trim().length > 0)
      ? apiUrl.trim()
      : 'https://api.deepseek.com/chat/completions';

    var safeModel = (typeof model === 'string' && model.trim().length > 0)
      ? model.trim()
      : 'deepseek-chat';

    var db = getDb();

    var existing = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM llm_config WHERE id = 1', (err, row) =>
        err ? reject(err) : resolve(row),
      );
    });

    if (existing) {
      await new Promise((resolve, reject) => {
        db.run(
          "UPDATE llm_config SET encrypted_key = ?, iv = ?, auth_tag = ?, api_url = ?, model = ?, updated_at = datetime('now') WHERE id = 1",
          [encrypted.encrypted, encrypted.iv, encrypted.authTag, safeApiUrl, safeModel],
          (err) => (err ? reject(err) : resolve()),
        );
      });
    } else {
      await new Promise((resolve, reject) => {
        db.run(
          'INSERT INTO llm_config (encrypted_key, iv, auth_tag, api_url, model) VALUES (?, ?, ?, ?, ?)',
          [encrypted.encrypted, encrypted.iv, encrypted.authTag, safeApiUrl, safeModel],
          (err) => (err ? reject(err) : resolve()),
        );
      });
    }

    res.json({ message: '大模型配置已加密存储', apiUrl: safeApiUrl, model: safeModel });
  } catch (err) {
    next(err);
  }
});

// ---------- GET /api/admin/config/llm — 读取大模型配置（不返回 Key 明文）----------
router.get('/config/llm', async (req, res, next) => {
  try {
    var db = getDb();
    var row = await new Promise((resolve, reject) => {
      db.get(
        'SELECT api_url, model, updated_at FROM llm_config WHERE id = 1',
        (err, row) => (err ? reject(err) : resolve(row)),
      );
    });

    if (!row) {
      return res.json({
        configured: false,
        apiUrl: 'https://api.deepseek.com/chat/completions',
        model: 'deepseek-chat',
      });
    }

    res.json({
      configured: true,
      apiUrl: row.api_url,
      model: row.model,
      updatedAt: row.updated_at,
      keyHint: '已配置（加密存储，不返回明文）',
    });
  } catch (err) {
    next(err);
  }
});

export default router;

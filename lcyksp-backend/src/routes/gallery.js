import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { getDb } from '../config/db.js';
import { authMiddleware, requireAuth } from '../middleware/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GALLERY_DIR = path.resolve(__dirname, '../../data/uploads/gallery');
fs.mkdirSync(GALLERY_DIR, { recursive: true });

const router = Router();

// 先解析 Token（可选），供后续路由使用
router.use(authMiddleware);

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.heic', '.heif']);

// ---------- multer 配置 ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, GALLERY_DIR),
    filename: (_req, file, cb) => {
      const timestamp = Date.now();
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${timestamp}-${safeName}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (IMAGE_EXTS.has(ext)) return cb(null, true);
    cb(new Error('仅支持图片格式: jpg/png/gif/webp/bmp/tiff/heic'));
  },
});

// ========== GET /api/gallery/photos — 家庭组数据隔离列表 ==========
router.get('/photos', requireAuth, async (req, res, next) => {
  try {
    const db = getDb();
    const { userId, role, groupId } = req.user;
    let rows;

    if (role === 'admin') {
      // 管理员查看全部
      rows = await new Promise((res, rej) =>
        db.all(
          `SELECT gp.id, gp.file_name, gp.file_size, gp.family_group_id, gp.uploader_id, gp.created_at,
                  u.username AS uploader_name
           FROM gallery_photos gp
           LEFT JOIN users u ON gp.uploader_id = u.id
           ORDER BY gp.created_at DESC`,
          (e, r) => (e ? rej(e) : res(r)),
        ),
      );
    } else if (groupId) {
      // 普通用户 — 只看到自己家庭组的照片
      rows = await new Promise((res, rej) =>
        db.all(
          `SELECT gp.id, gp.file_name, gp.file_size, gp.family_group_id, gp.uploader_id, gp.created_at,
                  u.username AS uploader_name
           FROM gallery_photos gp
           LEFT JOIN users u ON gp.uploader_id = u.id
           WHERE gp.family_group_id = ?
           ORDER BY gp.created_at DESC`,
          [groupId],
          (e, r) => (e ? rej(e) : res(r)),
        ),
      );
    } else {
      // 普通用户且不属于任何家庭组 → 只看自己上传的照片
      rows = await new Promise((res, rej) =>
        db.all(
          `SELECT gp.id, gp.file_name, gp.file_size, gp.family_group_id, gp.uploader_id, gp.created_at,
                  u.username AS uploader_name
           FROM gallery_photos gp
           LEFT JOIN users u ON gp.uploader_id = u.id
           WHERE gp.uploader_id = ?
           ORDER BY gp.created_at DESC`,
          [userId],
          (e, r) => (e ? rej(e) : res(r)),
        ),
      );
    }

    const photos = rows.map((r) => ({
      id: r.id,
      name: r.file_name,
      url: `/api/gallery/file/${encodeURIComponent(r.file_name)}`,
      size: r.file_size,
      uploaderId: r.uploader_id,
      uploaderName: r.uploader_name,
      familyGroupId: r.family_group_id,
      createdAt: r.created_at,
    }));

    res.json({ photos });
  } catch (err) {
    next(err);
  }
});

// ========== GET /api/gallery/file/:name — 文件下载/展示（无需登录，img 标签无法带 Authorization）==========
router.get('/file/:name', authMiddleware, (req, res, next) => {
  try {
    const name = decodeURIComponent(req.params.name);
    if (name.includes('..') || name.includes('/') || name.includes('\\') || name.includes('\0')) {
      return res.status(403).json({ error: '非法文件名' });
    }
    const filePath = path.join(GALLERY_DIR, name);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: '文件不存在' });
    }
    res.sendFile(filePath);
  } catch (err) {
    next(err);
  }
});

// ========== POST /api/gallery/upload — 上传照片（自动归组） ==========
router.post('/upload', requireAuth, upload.single('photo'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请选择一张照片' });
    }

    const db = getDb();
    const { userId, groupId } = req.user;

    // 写入 DB
    const result = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO gallery_photos (file_name, file_path, file_size, family_group_id, uploader_id)
         VALUES (?, ?, ?, ?, ?)`,
        [req.file.filename, req.file.path, req.file.size, groupId, userId],
        function (err) {
          if (err) return reject(err);
          resolve({ id: this.lastID });
        },
      );
    });

    res.status(201).json({
      id: result.id,
      name: req.file.filename,
      url: `/api/gallery/file/${encodeURIComponent(req.file.filename)}`,
      size: req.file.size,
      uploaderId: userId,
      familyGroupId: groupId,
    });
  } catch (err) {
    if (err.message === '仅支持图片格式: jpg/png/gif/webp/bmp/tiff/heic') {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

// ===================================================================
//  三、家庭组管理
// ===================================================================

// ---------- GET /api/gallery/family/members — 查看当前家庭组的所有成员 ----------
router.get('/family/members', requireAuth, async (req, res, next) => {
  try {
    const db = getDb();
    const { userId, groupId } = req.user;

    if (!groupId) {
      // 没有家庭组 → 自己一个人
      const myself = await new Promise((resolve, reject) => {
        db.get('SELECT id, username, role, group_id, created_at FROM users WHERE id = ?', [userId], (err, row) =>
          err ? reject(err) : resolve(row),
        );
      });
      return res.json({
        groupId: null,
        groupName: null,
        members: myself ? [{
          id: myself.id,
          username: myself.username,
          role: myself.role,
          createdAt: myself.created_at,
        }] : [],
      });
    }

    // 查询组信息和成员
    const group = await new Promise((resolve, reject) => {
      db.get('SELECT id, group_name, created_at FROM family_groups WHERE id = ?', [groupId], (err, row) =>
        err ? reject(err) : resolve(row),
      );
    });

    const members = await new Promise((resolve, reject) => {
      db.all(
        'SELECT id, username, role, created_at FROM users WHERE group_id = ? ORDER BY id ASC',
        [groupId],
        (err, rows) => (err ? reject(err) : resolve(rows)),
      );
    });

    res.json({
      groupId: group?.id || null,
      groupName: group?.group_name || null,
      members: members.map((m) => ({
        id: m.id,
        username: m.username,
        role: m.role,
        createdAt: m.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ---------- POST /api/gallery/family/members — 添加成员到当前家庭组 ----------
router.post('/family/members', requireAuth, async (req, res, next) => {
  try {
    const { username } = req.body;
    if (!username || typeof username !== 'string') {
      return res.status(400).json({ error: '请提供要添加的用户名' });
    }

    const db = getDb();
    const { userId, groupId } = req.user;

    // 不能添加自己
    if (username === req.user.username) {
      return res.status(400).json({ error: '不能将自己添加为成员' });
    }

    // 查找目标用户
    const target = await new Promise((resolve, reject) => {
      db.get('SELECT id, username, group_id FROM users WHERE username = ?', [username], (err, row) =>
        err ? reject(err) : resolve(row),
      );
    });

    if (!target) {
      return res.status(404).json({ error: `用户「${username}」不存在` });
    }

    // 检查是否已在同一个组
    if (target.group_id && target.group_id === groupId) {
      return res.status(409).json({ error: `用户「${username}」已在当前家庭组中` });
    }

    let targetGroupId = groupId;

    if (!targetGroupId) {
      // 当前用户没有家庭组 → 新建一个
      const groupName = `family-${userId}-${Date.now()}`;
      const result = await new Promise((resolve, reject) => {
        db.run(
          'INSERT INTO family_groups (group_name) VALUES (?)',
          [groupName],
          function (err) {
            if (err) return reject(err);
            resolve({ id: this.lastID });
          },
        );
      });
      targetGroupId = result.id;

      // 将当前用户加入新组
      await new Promise((resolve, reject) => {
        db.run('UPDATE users SET group_id = ? WHERE id = ?', [targetGroupId, userId], (err) =>
          err ? reject(err) : resolve(),
        );
      });
    }

    // 将目标用户加入组
    await new Promise((resolve, reject) => {
      db.run('UPDATE users SET group_id = ? WHERE id = ?', [targetGroupId, target.id], (err) =>
        err ? reject(err) : resolve(),
      );
    });

    // 查询组名
    const group = await new Promise((resolve, reject) => {
      db.get('SELECT group_name FROM family_groups WHERE id = ?', [targetGroupId], (err, row) =>
        err ? reject(err) : resolve(row),
      );
    });

    res.status(200).json({
      message: `用户「${username}」已加入家庭组`,
      groupId: targetGroupId,
      groupName: group?.group_name || null,
      member: { id: target.id, username: target.username },
    });
  } catch (err) {
    next(err);
  }
});

// ---------- DELETE /api/gallery/family/members/:userId — 从当前家庭组移除成员 ----------
router.delete('/family/members/:memberId', requireAuth, async (req, res, next) => {
  try {
    const memberId = parseInt(req.params.memberId, 10);
    if (isNaN(memberId)) {
      return res.status(400).json({ error: '无效的用户 ID' });
    }

    const db = getDb();
    const { userId, groupId } = req.user;

    if (!groupId) {
      return res.status(400).json({ error: '你还没有加入任何家庭组' });
    }

    // 不能移除自己
    if (memberId === userId) {
      return res.status(400).json({ error: '不能将自己移出家庭组' });
    }

    // 确认目标用户在当前组内
    const target = await new Promise((resolve, reject) => {
      db.get('SELECT id, username, group_id FROM users WHERE id = ?', [memberId], (err, row) =>
        err ? reject(err) : resolve(row),
      );
    });

    if (!target) {
      return res.status(404).json({ error: '用户不存在' });
    }

    if (target.group_id !== groupId) {
      return res.status(400).json({ error: '该用户不在你的家庭组中' });
    }

    // 移出组
    await new Promise((resolve, reject) => {
      db.run('UPDATE users SET group_id = NULL WHERE id = ?', [memberId], (err) =>
        err ? reject(err) : resolve(),
      );
    });

    res.json({ message: `用户「${target.username}」已从家庭组移除`, userId: memberId });
  } catch (err) {
    next(err);
  }
});

// ========== DELETE /api/gallery/file/:id — 垂直越权删除拦截 ==========
router.delete('/file/:id', requireAuth, async (req, res, next) => {
  try {
    const db = getDb();
    const photoId = parseInt(req.params.id, 10);
    if (isNaN(photoId)) {
      return res.status(400).json({ error: '无效的照片 ID' });
    }

    const photo = await new Promise((res, rej) =>
      db.get('SELECT id, file_name, file_path, uploader_id FROM gallery_photos WHERE id = ?', [photoId], (e, r) => (e ? rej(e) : res(r))),
    );

    if (!photo) {
      return res.status(404).json({ error: '照片不存在' });
    }

    const { userId, role } = req.user;

    // 三权分立：admin 或 本人上传 → 允许删除
    const isAdmin = role === 'admin';
    const isOwner = userId === photo.uploader_id;

    if (!isAdmin && !isOwner) {
      return res.status(403).json({ error: '权限不足，你只能删除自己上传的照片' });
    }

    // 物理删除文件
    fs.unlink(photo.file_path, (unlinkErr) => {
      if (unlinkErr && unlinkErr.code !== 'ENOENT') {
        console.error(`[相册] 删除文件失败: ${photo.file_path}`, unlinkErr.message);
      }
    });

    // 删除数据库记录
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM gallery_photos WHERE id = ?', [photoId], (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    res.json({ message: '删除成功' });
  } catch (err) {
    next(err);
  }
});

export default router;

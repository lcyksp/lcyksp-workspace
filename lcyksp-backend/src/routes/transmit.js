import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { getDb } from '../config/db.js';
import { authMiddleware, requireAuth } from '../middleware/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPLOAD_DIR = path.resolve(__dirname, '../../data/uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const router = Router();

// 挂载鉴权中间件（所有 /api/transmit/* 都将获得 req.user）
router.use(authMiddleware);

// ---------- multer 配置：单文件上传，最大 500MB ----------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const ext = path.extname(file.originalname) || '';
    cb(null, `${uniqueSuffix}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB
});

// ---------- 辅助函数 ----------

/** 生成 4-6 位随机取件码（数字+大写字母，去重查询直到唯一） */
function generatePickupCode(length = 5) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去除易混淆字符 I/O/0/1
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars[crypto.randomInt(chars.length)];
  }
  return code;
}

async function uniquePickupCode(db, length = 5) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generatePickupCode(length);
    const exists = await new Promise((res, rej) =>
      db.get('SELECT 1 FROM transfers WHERE id = ?', [code], (e, r) => e ? rej(e) : res(!!r)),
    );
    if (!exists) return code;
    if (attempt === 9) length++;
  }
  throw new Error('无法生成唯一取件码');
}

/** 将人类可读过期时间转为绝对 ISO 字符串 */
function parseExpireTime(text) {
  const now = Date.now();
  const match = text.match(/^(\d+)\s*(h|hour|hours|d|day|days)$/i);
  if (!match) throw new Error('不支持的过期时间格式，请使用如 1h, 12h, 24h, 7d');
  const num = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const ms = unit.startsWith('d') ? num * 86400000 : num * 3600000;
  return new Date(now + ms).toISOString();
}

/** 简单 SHA-256 哈希密码 */
function hashPassword(pwd) {
  return crypto.createHash('sha256').update(pwd).digest('hex');
}

/** 物理删除文件并清库（用于过期/超次数/错误清理） */
function cleanUpRecord(db, record) {
  // 兼容多文件 JSON 存储和单文件字符串
  var paths = [];
  try {
    var parsed = JSON.parse(record.file_path);
    if (Array.isArray(parsed)) paths = parsed;
  } catch (e) { /* 单文件路径 */ }
  if (paths.length === 0) paths = [record.file_path];

  paths.forEach(function (fp) {
    try { fs.unlinkSync(fp); } catch (e) { if (e.code !== 'ENOENT') console.error('[清理] 删除文件失败:', fp, e.message); }
  });

  db.run('DELETE FROM transfers WHERE id = ?', [record.id], function (delErr) {
    if (delErr) console.error('[清理] 删除记录失败:', record.id, delErr.message);
  });
}

// ========== 接口 1: POST /upload ==========
router.post('/upload', requireAuth, upload.array('files', 5), async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: '请上传至少一个文件' });
    }

    const db = getDb();
    const { password, maxDownloads, expireTime = '24h', isPrivate = '0' } = req.body;

    // 校验次数
    let maxDownloadsNum;
    if (maxDownloads === undefined || maxDownloads === '' || maxDownloads === null) {
      maxDownloadsNum = -1;
    } else {
      maxDownloadsNum = parseInt(maxDownloads, 10);
      if (isNaN(maxDownloadsNum) || maxDownloadsNum < 0) {
        req.files.forEach(f => fs.unlink(f.path, () => {}));
        return res.status(400).json({ error: 'maxDownloads 必须为 ≥0 的整数' });
      }
      if (maxDownloadsNum === 0) maxDownloadsNum = -1;
    }

    // 过期时间
    let expireTimeIso;
    if (expireTime === 'permanent') {
      expireTimeIso = '2099-12-31T23:59:59.000Z';
    } else {
      try {
        expireTimeIso = parseExpireTime(expireTime);
      } catch {
        req.files.forEach(f => fs.unlink(f.path, () => {}));
        return res.status(400).json({ error: 'expireTime 格式无效' });
      }
    }

    // 修复 multer 中文文件名乱码
    function fixFilename(originalname) {
      try {
        return Buffer.from(originalname, 'latin1').toString('utf8');
      } catch {
        return originalname;
      }
    }

    const id = await uniquePickupCode(db);
    const hashedPwd = password ? hashPassword(password) : null;
    const ownerId = req.user?.userId || null;
    const privateFlag = isPrivate === '1' || isPrivate === true ? 1 : 0;

    // 多文件信息存储为 JSON
    const fileNames = req.files.map(f => fixFilename(f.originalname));
    const filePaths = req.files.map(f => f.path);
    const fileSizes = req.files.map(f => f.size);
    const totalSize = req.files.reduce((sum, f) => sum + f.size, 0);

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO transfers (id, file_name, file_path, file_size, password, max_downloads, expire_time, owner_id, is_private)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, JSON.stringify(fileNames), JSON.stringify(filePaths), totalSize, hashedPwd, maxDownloadsNum, expireTimeIso, ownerId, privateFlag],
        (err) => {
          if (err) {
            req.files.forEach(f => fs.unlink(f.path, () => {}));
            return reject(err);
          }
          resolve();
        },
      );
    });

    res.status(201).json({
      code: id,
      fileNames,
      fileCount: fileNames.length,
      totalSize,
      hasPassword: !!password,
      maxDownloads: maxDownloadsNum === -1 ? -1 : maxDownloadsNum,
      maxDownloadsUnlimited: maxDownloadsNum === -1,
      expireTime: expireTimeIso,
      expirePermanent: expireTime === 'permanent',
      ownerId,
      isPrivate: !!privateFlag,
    });
  } catch (err) {
    next(err);
  }
});

// ========== 接口 2: POST /verify ==========
router.post('/verify', async (req, res, next) => {
  try {
    const { code, password } = req.body;
    if (!code) return res.status(400).json({ error: '请提供取件码' });

    const db = getDb();
    const record = await new Promise((res, rej) =>
      db.get('SELECT id, file_name, file_size, file_path, password, max_downloads, current_downloads, expire_time, owner_id, is_private FROM transfers WHERE id = ?', [code], (e, r) => e ? rej(e) : res(r)),
    );

    if (!record) return res.status(404).json({ error: '取件码不存在或已过期' });

    // 前置安全校验：过期或超次数
    const now = new Date();
    const unlimited = record.max_downloads === -1;
    const expired = now > new Date(record.expire_time);
    const exhausted = !unlimited && record.current_downloads >= record.max_downloads;

    if (expired || exhausted) {
      cleanUpRecord(db, record);
      return res.status(410).json({ error: '文件已过期或下载次数已用尽' });
    }

    // 归属权校验：私有文件非所有者不能下载
    if (record.is_private && record.owner_id) {
      if (!req.user || req.user.userId !== record.owner_id) {
        return res.status(403).json({ error: '非文件所有者，无权下载' });
      }
    }

    // 校验密码
    if (record.password) {
      if (!password) return res.status(401).json({ error: '该文件需要密码才能下载' });
      if (hashPassword(password) !== record.password) {
        return res.status(403).json({ error: '密码错误' });
      }
    }

    // 解析多文件 JSON
    let fileNames = [];
    let filePaths = [];
    let fileSizes = [];
    try {
      fileNames = JSON.parse(record.file_name);
      filePaths = JSON.parse(record.file_path);
      fileSizes = JSON.parse(record.file_size || '[]');
    } catch {
      fileNames = [record.file_name];
      filePaths = [record.file_path];
      fileSizes = [record.file_size];
    }
    const totalSize = fileSizes.reduce((s, n) => s + (n || 0), 0);

    res.json({
      valid: true,
      fileName: fileNames[0],
      fileNames,
      fileCount: fileNames.length,
      totalSize,
    });
  } catch (err) {
    next(err);
  }
});

// ========== 接口 3: GET /download/:id ==========
router.get('/download/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const db = getDb();

    const record = await new Promise((res, rej) =>
      db.get('SELECT id, file_name, file_size, file_path, password, max_downloads, current_downloads, expire_time, owner_id, is_private FROM transfers WHERE id = ?', [id], (e, r) => e ? rej(e) : res(r)),
    );

    if (!record) return res.status(404).json({ error: '取件码不存在或已过期' });

    // 严格安全前置校验
    const now = new Date();
    const unlimited = record.max_downloads === -1;
    const expired = now > new Date(record.expire_time);
    const exhausted = !unlimited && record.current_downloads >= record.max_downloads;

    if (expired || exhausted) {
      cleanUpRecord(db, record);
      return res.status(410).json({ error: '文件已过期或下载次数已用尽' });
    }

    // 归属权校验：私有文件非所有者不能下载
    if (record.is_private && record.owner_id) {
      if (!req.user || req.user.userId !== record.owner_id) {
        return res.status(403).json({ error: '非文件所有者，无权下载' });
      }
    }

    // 解析多文件路径
    let filePaths = [], fileNames = [];
    try {
      filePaths = JSON.parse(record.file_path);
      fileNames = JSON.parse(record.file_name);
    } catch {
      filePaths = [record.file_path];
      fileNames = [record.file_name];
    }

    const fileIndex = parseInt(req.query.fileIndex, 10) || 0;
    const targetFile = filePaths[fileIndex];
    const targetName = fileNames[fileIndex] || fileNames[0] || record.file_name;

    // 检查物理文件是否存在
    if (!targetFile || !fs.existsSync(targetFile)) {
      return res.status(404).json({ error: '物理文件已丢失' });
    }

    // 修复文件名编码
    function fixFilename(name) {
      try { return Buffer.from(name, 'latin1').toString('utf8'); } catch { return name; }
    }

    // 流式下载
    res.download(targetFile, fixFilename(targetName), (downloadErr) => {
      if (downloadErr && !res.headersSent) {
        return res.status(500).json({ error: '文件下载失败' });
      }
    });

    // 下载完成或断开时的处理
    res.on('finish', () => {
      if (unlimited) return;
      if (fileIndex !== fileCount - 1) return;

      db.run(
        'UPDATE transfers SET current_downloads = current_downloads + 1 WHERE id = ?',
        [id],
        function (updateErr) {
          if (updateErr) {
            console.error('[下载] 更新下载次数失败:', id, updateErr.message);
            return;
          }
          var newCount = record.current_downloads + 1;
          if (newCount >= record.max_downloads) {
            // 删除所有物理文件（兼容 JSON 数组和单文件字符串）
            var delPaths = [];
            try { var p = JSON.parse(record.file_path); if (Array.isArray(p)) delPaths = p; } catch {}
            if (delPaths.length === 0) delPaths = [record.file_path];
            delPaths.forEach(function (fp) {
              try { fs.unlinkSync(fp); } catch (e) { if (e.code !== 'ENOENT') console.error('[阅后即焚] 删除文件失败:', fp, e.message); }
            });
            db.run('DELETE FROM transfers WHERE id = ?', [id], function (delErr) {
              if (delErr) console.error('[阅后即焚] 删除记录失败:', id, delErr.message);
              else console.log('[阅后即焚] 取件码', id, '已销毁');
            });
          }
        },
      );
    });
  } catch (err) {
    next(err);
  }
});

// ========== 接口 4: GET /history ==========
router.get('/history', requireAuth, async (req, res, next) => {
  try {
    const db = getDb();
    const rows = await new Promise((resolve, reject) => {
      db.all(
        'SELECT id, file_name, file_size, max_downloads, current_downloads, expire_time, created_at FROM transfers WHERE owner_id = ? ORDER BY created_at DESC',
        [req.user.userId],
        (err, rows) => err ? reject(err) : resolve(rows)
      );
    });
    
    const history = rows.map(row => {
      let fileNames = [];
      try {
        fileNames = JSON.parse(row.file_name);
      } catch {
        fileNames = [row.file_name];
      }
      return {
        code: row.id,
        fileNames,
        totalSize: row.file_size,
        maxDownloads: row.max_downloads,
        currentDownloads: row.current_downloads,
        expireTime: row.expire_time,
        createdAt: row.created_at,
        isExpired: new Date() > new Date(row.expire_time) || (row.max_downloads !== -1 && row.current_downloads >= row.max_downloads)
      };
    });
    
    res.json({ success: true, history });
  } catch (err) {
    next(err);
  }
});

// ========== 接口 5: POST /update-code ==========
router.post('/update-code', requireAuth, async (req, res, next) => {
  try {
    const { oldCode, newCode } = req.body;
    if (!oldCode || !newCode) return res.status(400).json({ error: '原提取码和新提取码不能为空' });
    
    const cleanNewCode = String(newCode).trim().toUpperCase();
    if (!/^[A-Z2-9]{4,16}$/.test(cleanNewCode)) {
      return res.status(400).json({ error: '新提取码只能包含 4-16 位大写字母或数字（排除易混淆字符 I/O/0/1）' });
    }
    
    const db = getDb();
    const record = await new Promise((res, rej) =>
      db.get('SELECT id, owner_id, expire_time FROM transfers WHERE id = ?', [oldCode], (e, r) => e ? rej(e) : res(r)),
    );
    
    if (!record) return res.status(404).json({ error: '原文件记录不存在或已失效' });
    
    const expired = new Date() > new Date(record.expire_time);
    if (expired) return res.status(400).json({ error: '该分享已过期，无法修改提取码' });
    
    const isAdmin = req.user.role === 'admin';
    if (record.owner_id !== req.user.userId && !isAdmin) {
      return res.status(403).json({ error: '您无权修改此提取码' });
    }
    
    const exists = await new Promise((res, rej) =>
      db.get('SELECT 1 FROM transfers WHERE id = ?', [cleanNewCode], (e, r) => e ? rej(e) : res(!!r)),
    );
    if (exists) return res.status(409).json({ error: '该新提取码已被占用，请使用其他提取码' });
    
    await new Promise((res, rej) => {
      db.run('UPDATE transfers SET id = ? WHERE id = ?', [cleanNewCode, oldCode], (err) => err ? rej(err) : res());
    });
    
    res.json({ success: true, message: '提取码修改成功', code: cleanNewCode });
  } catch (err) {
    next(err);
  }
});

// ========== 接口 6: DELETE /delete/:code ==========
router.delete('/delete/:code', requireAuth, async (req, res, next) => {
  try {
    const { code } = req.params;
    const db = getDb();
    
    const record = await new Promise((res, rej) =>
      db.get('SELECT id, file_path, owner_id FROM transfers WHERE id = ?', [code], (e, r) => e ? rej(e) : res(r)),
    );
    
    if (!record) return res.status(404).json({ error: '分享记录不存在' });
    
    const isAdmin = req.user.role === 'admin';
    if (record.owner_id !== req.user.userId && !isAdmin) {
      return res.status(403).json({ error: '您无权删除此分享记录' });
    }
    
    cleanUpRecord(db, record);
    
    res.json({ success: true, message: '已成功删除分享记录并物理清除文件' });
  } catch (err) {
    next(err);
  }
});

export default router;

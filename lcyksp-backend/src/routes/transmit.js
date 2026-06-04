import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { getDb } from '../config/db.js';
import { authMiddleware } from '../middleware/auth.js';

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
  fs.unlink(record.file_path, (unlinkErr) => {
    if (unlinkErr && unlinkErr.code !== 'ENOENT') {
      console.error(`[清理] 删除文件失败: ${record.file_path}`, unlinkErr.message);
    }
  });
  db.run('DELETE FROM transfers WHERE id = ?', [record.id], (delErr) => {
    if (delErr) console.error(`[清理] 删除记录失败: ${record.id}`, delErr.message);
  });
}

// ========== 接口 1: POST /upload ==========
router.post('/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请上传一个文件' });
    }

    const db = getDb();
    const { password, maxDownloads, expireTime = '24h', isPrivate = '0' } = req.body;

    // 校验次数：留空或 0 → -1 表示不限次数
    let maxDownloadsNum;
    if (maxDownloads === undefined || maxDownloads === '' || maxDownloads === null) {
      maxDownloadsNum = -1;
    } else {
      maxDownloadsNum = parseInt(maxDownloads, 10);
      if (isNaN(maxDownloadsNum) || maxDownloadsNum < 0) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'maxDownloads 必须为 ≥0 的整数' });
      }
      if (maxDownloadsNum === 0) maxDownloadsNum = -1; // 0 也视为不限
    }

    // 解析过期时间：'permanent' → 遥远的未来
    let expireTimeIso;
    if (expireTime === 'permanent') {
      expireTimeIso = '2099-12-31T23:59:59.000Z';
    } else {
      try {
        expireTimeIso = parseExpireTime(expireTime);
      } catch {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'expireTime 格式无效，请使用如 1h, 12h, 24h, 7d 或 permanent' });
      }
    }

    // 生成唯一取件码
    const id = await uniquePickupCode(db);

    // 处理密码
    const hashedPwd = password ? hashPassword(password) : null;

    // 如果已登录，记录 owner_id
    const ownerId = req.user?.userId || null;
    const privateFlag = isPrivate === '1' || isPrivate === true ? 1 : 0;

    // 入库
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO transfers (id, file_name, file_path, file_size, password, max_downloads, expire_time, owner_id, is_private)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, req.file.originalname, req.file.path, req.file.size, hashedPwd, maxDownloadsNum, expireTimeIso, ownerId, privateFlag],
        (err) => {
          if (err) {
            fs.unlink(req.file.path, () => {});
            return reject(err);
          }
          resolve();
        },
      );
    });

    res.status(201).json({
      code: id,
      fileName: req.file.originalname,
      fileSize: req.file.size,
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

    res.json({
      valid: true,
      fileName: record.file_name,
      fileSize: record.file_size,
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

    // 检查物理文件是否存在
    if (!fs.existsSync(record.file_path)) {
      db.run('DELETE FROM transfers WHERE id = ?', [id]);
      return res.status(404).json({ error: '物理文件已丢失' });
    }

    // 流式下载
    res.download(record.file_path, record.file_name, (downloadErr) => {
      if (downloadErr) {
        if (!res.headersSent) {
          return res.status(500).json({ error: '文件下载失败' });
        }
      }
    });

    // 下载完成或断开时的处理
    res.on('finish', () => {
      // 不限次数模式：不扣减、不焚毁
      if (unlimited) return;

      db.run(
        'UPDATE transfers SET current_downloads = current_downloads + 1 WHERE id = ?',
        [id],
        function (updateErr) {
          if (updateErr) {
            console.error(`[下载] 更新下载次数失败: ${id}`, updateErr.message);
            return;
          }
          const newCount = record.current_downloads + 1;
          if (newCount >= record.max_downloads) {
            fs.unlink(record.file_path, (unlinkErr) => {
              if (unlinkErr && unlinkErr.code !== 'ENOENT') {
                console.error(`[阅后即焚] 删除文件失败: ${record.file_path}`, unlinkErr.message);
              }
            });
            db.run('DELETE FROM transfers WHERE id = ?', [id], (delErr) => {
              if (delErr) console.error(`[阅后即焚] 删除记录失败: ${id}`, delErr.message);
              else console.log(`[阅后即焚] 取件码 ${id} 已销毁`);
            });
          }
        },
      );
    });
  } catch (err) {
    next(err);
  }
});

export default router;

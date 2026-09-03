import { Router } from 'express';
import multer from 'multer';
import sharp from '../utils/imageGuard.js'; // 基于 C++ libvips 底层的高性能图像库，已套上像素上限

const router = Router();

// 内存存储 — 不写磁盘，最大 100MB
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

/** 预处理：限制输入图片最大边长 2048px，从根本上降低高空像素计算量 */
const MAX_DIMENSION = 2048; // 像素
async function preprocessImage(buffer) {
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) return buffer;

  // 仅在任意边长超过 MAX_DIMENSION 时缩放
  if (meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION) {
    return sharp(buffer)
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .toBuffer();
  }
  return buffer;
}

/** 将目标大小字符串转为字节数 */
function parseTargetSize(text) {
  const m = text.match(/^(\d+(?:\.\d+)?)\s*(kb|mb|b)$/i);
  if (!m) return null;
  const num = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'kb') return Math.round(num * 1024);
  if (unit === 'mb') return Math.round(num * 1024 * 1024);
  return Math.round(num);
}

// ========== POST /target-size ==========
router.post('/target-size', upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请上传一张图片' });
    }

    const targetSizeRaw = req.body.targetSize || '1mb';
    const targetBytes = parseTargetSize(targetSizeRaw);
    if (!targetBytes || targetBytes < 1024) {
      return res.status(400).json({ error: '目标大小格式无效，请使用如 500kb, 1mb, 2mb' });
    }

    const originalMime = req.file.mimetype;

    // 检查是否为支持的图片格式
    if (!originalMime.startsWith('image/') || originalMime === 'image/gif' || originalMime === 'image/svg+xml') {
      return res.status(400).json({ error: '不支持的图片格式，请上传 JPEG/PNG/WebP 等位图格式' });
    }

    // --- 预处理：限制分辨率，大幅提升后续压缩速度 ---
    let inputBuffer = await preprocessImage(req.file.buffer);

    // 获取图片元信息
    const metadata = await sharp(inputBuffer).metadata();
    const format = metadata.format || 'jpeg';

    // 限制可接受的输出格式
    const outputFormat = (['jpeg', 'png', 'webp', 'tiff'].includes(format)) ? format : 'jpeg';

    // 检查预处理后的文件是否已经小于目标大小
    if (inputBuffer.length <= targetBytes) {
      res.set('Content-Type', `image/${outputFormat}`);
      res.set('Content-Disposition', `attachment; filename="compressed-${req.file.originalname}"`);
      return res.send(inputBuffer);
    }

    // --- 二分查找最佳 quality ---
    let low = 1;
    let high = 100;
    let bestBuffer = null;
    // 二分查找：12次迭代覆盖 1-100 范围
    for (let i = 0; i < 12; i++) {
      if (low > high) break;
      const mid = Math.floor((low + high) / 2);

      let compressed;
      try {
        if (outputFormat === 'png') {
          compressed = await sharp(inputBuffer)
            .png({ quality: mid, palette: true, colors: Math.max(2, Math.round(mid * 2.56)) })
            .toBuffer();
        } else if (outputFormat === 'webp') {
          compressed = await sharp(inputBuffer).webp({ quality: mid }).toBuffer();
        } else {
          compressed = await sharp(inputBuffer).jpeg({ quality: mid, mozjpeg: true }).toBuffer();
        }
      } catch {
        high = mid - 1;
        continue;
      }

      if (compressed.length <= targetBytes) {
        bestBuffer = compressed;
        low = mid + 1;
      } else {
        high = mid - 1;
        // 丢弃不需要的 buffer
        compressed = null;
      }
      // 显式释放迭代 buffer（非 best 的在上次已释放）
      if (compressed !== bestBuffer) {
        compressed = null;
      }
    }

    // 兜底：quality=1 的最小压缩
    if (!bestBuffer) {
      try {
        if (outputFormat === 'png') {
          bestBuffer = await sharp(inputBuffer).png({ quality: 1, palette: true, colors: 2 }).toBuffer();
        } else if (outputFormat === 'webp') {
          bestBuffer = await sharp(inputBuffer).webp({ quality: 1 }).toBuffer();
        } else {
          bestBuffer = await sharp(inputBuffer).jpeg({ quality: 1, mozjpeg: true }).toBuffer();
        }
      } catch (sharpErr) {
        return res.status(500).json({ error: '图片压缩失败', detail: sharpErr.message });
      }
    }

    // 释放输入 buffer（sharp 处理已完成）
    inputBuffer = null;

    // --- 返回压缩结果 ---
    const outputExt = outputFormat === 'jpeg' ? 'jpg' : outputFormat;
    const baseName = req.file.originalname.replace(/\.[^.]+$/, '') || 'image';
    res.set('Content-Type', `image/${outputFormat}`);
    res.set('Content-Disposition', `attachment; filename="${baseName}-compressed.${outputExt}"`);
    res.send(bestBuffer);

    // 发送后释放最后的大对象（setImmediate 避免打断 res.send 的 pipe）
    setImmediate(() => {
      bestBuffer = null;
    });
  } catch (err) {
    next(err);
  }
});

export default router;

import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import PDFDocument from 'pdfkit';

const router = Router();

// 纯内存存储
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

/** 支持的转换类型映射 */
const CONVERSION_MAP = {
  'png2jpg':   { from: 'png',  to: 'jpeg', mime: 'image/jpeg', ext: 'jpg' },
  'webp2jpg':  { from: 'webp', to: 'jpeg', mime: 'image/jpeg', ext: 'jpg' },
  'heic2jpg':  { from: 'heic', to: 'jpeg', mime: 'image/jpeg', ext: 'jpg' },
  'img2pdf':   { from: null,   to: 'pdf',  mime: 'application/pdf', ext: 'pdf' },
};

// ========== POST /image ==========
router.post('/image', upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请上传一张图片' });
    }

    const type = req.body.type;
    if (!type || !CONVERSION_MAP[type]) {
      return res.status(400).json({
        error: '不支持的转换类型，请使用: png2jpg, webp2jpg, heic2jpg, img2pdf',
      });
    }

    const config = CONVERSION_MAP[type];
    const inputBuffer = req.file.buffer;
    const baseName = req.file.originalname.replace(/\.[^.]+$/, '') || 'image';

    if (type === 'img2pdf') {
      // ---------- 图片 → PDF ----------
      const metadata = await sharp(inputBuffer).metadata();
      const pageWidth = metadata.width || 595;   // 默认 A4
      const pageHeight = metadata.height || 842;

      const doc = new PDFDocument({
        size: [pageWidth, pageHeight],
        margin: 0,
        autoFirstPage: false,
      });

      // 收集 PDF buffer
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => {
        const pdfBuffer = Buffer.concat(chunks);
        // 清空 chunks 释放内存
        chunks.length = 0;
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', `attachment; filename="${baseName}.pdf"`);
        res.send(pdfBuffer);
        // 发送后释放 pdfBuffer
        setImmediate(() => {
          pdfBuffer = null;
          imageBuffer = null;
        });
      });

      // 将图片转成 JPEG buffer 嵌入 PDF（PDFKit 原生支持 JPEG/PNG）
      let imageBuffer;
      let isPng = false;
      if (metadata.format === 'png') {
        imageBuffer = inputBuffer;
        isPng = true;
      } else {
        // 非 PNG 统一转 JPEG 嵌入
        imageBuffer = await sharp(inputBuffer).jpeg({ quality: 92 }).toBuffer();
      }

      doc.addPage({ size: [pageWidth, pageHeight], margin: 0 });
      if (isPng) {
        doc.image(imageBuffer, 0, 0, { width: pageWidth, height: pageHeight });
      } else {
        doc.image(imageBuffer, 0, 0, { width: pageWidth, height: pageHeight });
      }
      doc.end();
    } else {
      // ---------- 图像格式互转 (sharp) ----------
      // 检测源图格式
      const metadata = await sharp(inputBuffer).metadata();
      const sourceFormat = metadata.format;

      // 宽松校验：提示但允许转换
      if (sourceFormat !== config.from && !['heic', 'heif'].includes(sourceFormat)) {
        // heic 有时被识别为 heif，容错
        if (!(config.from === 'heic' && ['heic', 'heif'].includes(sourceFormat))) {
          // 继续执行，不阻断 — sharp 会尝试自动处理
          console.warn(`[转换] 预期输入格式 ${config.from}，实际为 ${sourceFormat}，仍尝试转换`);
        }
      }

      let outputBuffer;
      try {
        if (config.to === 'jpeg') {
          outputBuffer = await sharp(inputBuffer).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
        } else {
          outputBuffer = await sharp(inputBuffer).toFormat(config.to).toBuffer();
        }
      } catch (sharpErr) {
        return res.status(500).json({
          error: `格式转换失败: ${sharpErr.message}`,
          hint: '请确认上传的图片格式与选择的转换类型匹配',
        });
      }

      res.set('Content-Type', config.mime);
      res.set('Content-Disposition', `attachment; filename="${baseName}.${config.ext}"`);
      res.send(outputBuffer);
    }
  } catch (err) {
    next(err);
  }
});

export default router;

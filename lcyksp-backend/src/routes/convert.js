import { Router } from 'express';
import multer from 'multer';
import sharp, { imageJobGate } from '../utils/imageGuard.js';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { assertPublicUrl } from '../utils/ssrf.js';
import { getClientIp } from '../utils/turnstile.js';

const router = Router();

// 纯内存存储
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// ---------- web-capture 反滥用防护（内存态） ----------
// 并发上限：同时最多 2 个无头浏览器实例，防止资源耗尽
const WEB_CAPTURE_MAX_CONCURRENT = 2;
let webCaptureActive = 0;
// 频率上限：每个客户端 IP 每小时最多 20 次截图请求
const WEB_CAPTURE_RATE_LIMIT = 20;
const WEB_CAPTURE_RATE_WINDOW_MS = 60 * 60 * 1000;
const webCaptureRateMap = new Map();

// 定期清理过期的限流记录，防止内存缓慢增长（每小时一次）
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of webCaptureRateMap) {
    if (now - record.windowStart > WEB_CAPTURE_RATE_WINDOW_MS) {
      webCaptureRateMap.delete(ip);
    }
  }
  // 极端情况下仍超限则整体重置，保证内存有界
  if (webCaptureRateMap.size > 20000) webCaptureRateMap.clear();
}, 60 * 60 * 1000).unref();

/** 支持的转换类型映射 */
const CONVERSION_MAP = {
  'png2jpg':   { from: 'png',  to: 'jpeg', mime: 'image/jpeg', ext: 'jpg' },
  'webp2jpg':  { from: 'webp', to: 'jpeg', mime: 'image/jpeg', ext: 'jpg' },
  'heic2jpg':  { from: 'heic', to: 'jpeg', mime: 'image/jpeg', ext: 'jpg' },
  'img2pdf':   { from: null,   to: 'pdf',  mime: 'application/pdf', ext: 'pdf' },
};

// ========== POST /image ==========
router.post('/image', imageJobGate, upload.single('image'), async (req, res, next) => {
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
        // 这里原来有一段 setImmediate(() => { pdfBuffer = null; imageBuffer = null }) —— 给 const
        // 赋值，每个 img2pdf 请求都会在下一个 tick 抛 TypeError。响应已经发出去了所以前端看不出来，
        // 全靠 uncaughtException 只打日志才没炸。回调结束后闭包自然释放，本来就不需要手动置空。
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

// ========== POST /pdf-to-docx ==========
router.post('/pdf-to-docx', imageJobGate, upload.single('pdf'), async (req, res, next) => {
  let tempDir = '';
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请上传 PDF 文件' });
    }

    // 创建临时工作目录
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf2docx-'));
    const inputPath = path.join(tempDir, 'input.pdf');
    const outputPath = path.join(tempDir, 'output.docx');

    // 将上传的 buffer 写入临时文件
    fs.writeFileSync(inputPath, req.file.buffer);

    // 解析分页选项
    // start and end are 1-based page indices from client, but pdf2docx expects 0-based index
    const startPage = req.body.start ? Math.max(0, parseInt(req.body.start, 10) - 1) : 0;
    const endPage = req.body.end ? parseInt(req.body.end, 10) : null;

    const args = ['convert', inputPath, '--docx_file=' + outputPath];
    if (startPage > 0) {
      args.push('--start=' + startPage);
    }
    if (endPage !== null) {
      args.push('--end=' + endPage);
    }

    // 运行 /usr/local/bin/pdf2docx 或者全局 pdf2docx 命令
    // 在 Windows 上是 pdf2docx.exe，在 Linux 上是 /usr/local/bin/pdf2docx
    const cmd = os.platform() === 'win32' ? 'pdf2docx' : '/usr/local/bin/pdf2docx';

    await new Promise((resolve, reject) => {
      // stdio 的 stdout 必须 ignore：pdf2docx 会往 stdout 打进度，而这里从不读它，
      // 一旦写满 64KB 管道缓冲，子进程就永久阻塞 → 请求挂死、僵尸进程堆积。
      // timeout 同理，之前没有上限，一个坏 PDF 能把这条路占死。
      const proc = spawn(cmd, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: 120000,
        killSignal: 'SIGKILL',
      });
      let stderr = '';

      proc.stderr.on('data', (data) => {
        // stderr 也要有上限，否则疯狂输出的子进程能把内存写满
        if (stderr.length < 64 * 1024) stderr += data.toString();
      });

      proc.on('error', (err) => {
        if (err.code === 'ENOENT') {
          reject(new Error('系统未安装 pdf2docx 工具，请联系管理员。'));
        } else {
          reject(err);
        }
      });

      proc.on('close', (code, signal) => {
        if (signal) {
          return reject(new Error('转换超时已终止，请换更小的 PDF 或缩小页码范围'));
        }
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(stderr.trim() || `转换失败 (错误码 ${code})`));
        }
      });
    });

    if (!fs.existsSync(outputPath)) {
      throw new Error('未生成输出的 Word 文档');
    }

    const docxBuffer = fs.readFileSync(outputPath);
    const originalName = req.file.originalname.replace(/\.[^.]+$/, '') || 'document';

    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(originalName)}.docx"`);
    res.send(docxBuffer);

  } catch (err) {
    console.error('[PDF2DOCX]', err);
    res.status(500).json({ error: err.message || 'PDF 转换失败，请重试' });
  } finally {
    // 递归清理临时目录
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (cleanErr) {
        console.error('[PDF2DOCX Cleanup Error]', cleanErr);
      }
    }
  }
});

function getChromePath() {
  if (process.env.CHROME_PATH) {
    return process.env.CHROME_PATH;
  }
  if (process.platform === 'win32') {
    const paths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }
  } else {
    const paths = [
      '/home/admin/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
      '/home/admin/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium'
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

// ========== POST /web-capture ==========
router.post('/web-capture', async (req, res, next) => {
  let browser = null;

  // ---- 反滥用：按客户端 IP 限流（内存态，进程重启即重置） ----
  const clientIp = getClientIp(req);
  const now = Date.now();
  const rateRecord = webCaptureRateMap.get(clientIp) || { count: 0, windowStart: now };
  if (now - rateRecord.windowStart > WEB_CAPTURE_RATE_WINDOW_MS) {
    rateRecord.count = 0;
    rateRecord.windowStart = now;
  }
  if (rateRecord.count >= WEB_CAPTURE_RATE_LIMIT) {
    return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  }
  rateRecord.count += 1;
  webCaptureRateMap.set(clientIp, rateRecord);

  // ---- 反滥用：并发上限（防止浏览器实例耗尽 CPU/内存） ----
  if (webCaptureActive >= WEB_CAPTURE_MAX_CONCURRENT) {
    return res.status(429).json({ error: '截图服务繁忙，请稍后再试' });
  }
  webCaptureActive += 1;

  try {
    const { url, format, width, delay } = req.body;
    if (!url) {
      return res.status(400).json({ error: '网页链接不能为空' });
    }

    let targetUrl = url.trim();

    // 智能解析并提取浏览器阅读模式下的原始网页链接
    if (/^read:\/\//i.test(targetUrl)) {
      try {
        const parsed = new URL(targetUrl.replace(/^read:\/\//i, 'http://'));
        const actualUrl = parsed.searchParams.get('url');
        if (actualUrl && /^https?:\/\//i.test(actualUrl)) {
          targetUrl = actualUrl;
        } else {
          let clean = targetUrl.replace(/^read:\/\//i, '');
          if (/^(https?)_/i.test(clean)) {
            targetUrl = clean.replace(/^(https?)_/i, '$1://');
          } else {
            targetUrl = 'https://' + clean;
          }
        }
      } catch (err) {
        targetUrl = targetUrl.replace(/^read:\/\//i, 'https://');
      }
    } else if (/^about:reader/i.test(targetUrl)) {
      try {
        const parsed = new URL(targetUrl.replace(/^about:reader/i, 'http://dummy'));
        const actualUrl = parsed.searchParams.get('url');
        if (actualUrl && /^https?:\/\//i.test(actualUrl)) {
          targetUrl = actualUrl;
        }
      } catch (err) {
        // ignore
      }
    }

    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = 'https://' + targetUrl;
    }

    // ---- SSRF 防护：拒绝内网 / 回环 / 链路本地 / 云元数据等地址 ----
    try {
      targetUrl = await assertPublicUrl(targetUrl);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const { chromium } = await import('playwright-core');
    const execPath = getChromePath();

    browser = await chromium.launch({
      headless: true,
      executablePath: execPath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const parsedWidth = parseInt(width, 10) || 1280;
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: parsedWidth, height: 800 },
      deviceScaleFactor: 2, // High quality
    });

    const page = await context.newPage();

    // ---- SSRF 防护：拦截页面内所有指向内网/本机的子请求（含跳转后目标） ----
    await page.route('**/*', async (route) => {
      let requestUrl = '';
      try {
        requestUrl = route.request().url();
      } catch (e) {
        /* ignore */
      }
      try {
        const parsed = new URL(requestUrl);
        // 浏览器内部资源协议直接放行
        if (parsed.protocol === 'data:' || parsed.protocol === 'blob:' || parsed.protocol === 'about:') {
          return route.continue();
        }
        // ws/wss/file 等一律拦截：ws 的底层 TCP 仍可能打到内网
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return route.abort('blockedbyclient');
        }
        await assertPublicUrl(requestUrl);
        return route.continue();
      } catch (e) {
        try {
          return route.abort('blockedbyclient');
        } catch (abortErr) {
          /* ignore */
        }
      }
    });

    try {
      await page.goto(targetUrl, {
        waitUntil: 'networkidle',
        timeout: 15000,
      });
    } catch (gotoErr) {
      const isTimeout = gotoErr.message.includes('timeout') || gotoErr.message.includes('Timeout');
      if (!isTimeout) {
        throw new Error(`无法访问该网页，请确认网址是否正确且支持公网访问 (${gotoErr.message})`);
      }
      console.warn(`[WebCapture] page.goto timeout warning: ${gotoErr.message}`);
    }

    // Wait for custom delay (clamped between 0 and 10 seconds)
    const parsedDelay = Math.min(Math.max(parseInt(delay, 10) || 2000, 0), 10000);
    await page.waitForTimeout(parsedDelay);

    let buffer;
    let contentType;
    let ext;

    if (format === 'pdf') {
      buffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '0px', right: '0px', bottom: '0px', left: '0px' },
      });
      contentType = 'application/pdf';
      ext = 'pdf';
    } else {
      buffer = await page.screenshot({
        fullPage: true,
        type: 'png',
      });
      contentType = 'image/png';
      ext = 'png';
    }

    await context.close();
    await browser.close();
    browser = null;

    const domain = targetUrl.replace(/^https?:\/\/(www\.)?/, '').split('/')[0] || 'page';
    const safeDomain = domain.replace(/[^a-z0-9-]/gi, '_');

    res.set('Content-Type', contentType);
    res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(safeDomain)}.${ext}"`);
    res.send(buffer);

  } catch (err) {
    console.error('[WebCapture Error]', err);
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        // silent
      }
    }
    res.status(500).json({ error: `网页捕获失败: ${err.message}` });
  } finally {
    webCaptureActive = Math.max(0, webCaptureActive - 1);
  }
});

export default router;

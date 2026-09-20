// PDF 压缩 Worker —— 把重活从主线程挪走，避免压缩大文件时页面卡死。
import { compressPdf, rasterizePdf } from '../utils/pdfCompress.js'

self.onmessage = async (event) => {
  const { id, bytes, preset, mode } = event.data || {}
  const onProgress = (progress) => self.postMessage({ id, type: 'progress', progress })

  try {
    const { bytes: output, stats } =
      mode === 'raster'
        ? await rasterizePdf(bytes, preset, onProgress)
        : await compressPdf(bytes, preset, onProgress)
    self.postMessage({ id, type: 'done', bytes: output, stats }, [output.buffer])
  } catch (error) {
    self.postMessage({ id, type: 'error', message: (error && error.message) || String(error) })
  }
}

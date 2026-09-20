<script setup>
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { PDFDocument } from 'pdf-lib'
import { Document, Download, UploadFilled } from '@element-plus/icons-vue'
import { PDF_PRESETS, makeCustomPreset } from '../utils/pdfCompress.js'

const MAX_BYTES = 300 * 1024 * 1024

const rawFile = ref(null)
const fileName = ref('')
const originalBytes = ref(0)
const totalPages = ref(0)
const mode = ref('images')
const presetKey = ref('medium')
const customQuality = ref(0.7)
const customLongSide = ref(1500)
const rasterDpi = ref(150)
const rasterQuality = ref(0.75)
const compressing = ref(false)
const progress = ref({ phase: 'images', done: 0, total: 0 })
const result = ref(null)

const presets = [PDF_PRESETS.light, PDF_PRESETS.medium, PDF_PRESETS.strong]

const rasterPreset = computed(() => ({ dpi: rasterDpi.value, quality: rasterQuality.value }))
const isRaster = computed(() => mode.value === 'raster')
const wantGrayscale = ref(false)
const wantDedupe = ref(false)

function activePreset() {
  const base = isRaster.value
    ? rasterPreset.value
    : presetKey.value === 'custom'
      ? makeCustomPreset(customQuality.value, customLongSide.value)
      : PDF_PRESETS[presetKey.value] || PDF_PRESETS.medium
  // 去重只对"原地改写图片对象"的常规模式有意义；栅格化是重建文档，去重等于空转
  return { ...base, grayscale: wantGrayscale.value, dedupe: wantDedupe.value && !isRaster.value }
}

const originalSize = computed(() => formatSize(originalBytes.value))

const progressPercent = computed(() => {
  const p = progress.value
  if (p.phase === 'saving') return 99
  if (!p.total) return 0
  return Math.min(99, Math.round((p.done / p.total) * 100))
})

const progressText = computed(() => {
  const p = progress.value
  if (p.phase === 'saving') return '正在重建 PDF 结构…'
  if (p.phase === 'dedupe') return '正在合并重复图片…'
  if (p.phase === 'raster') {
    if (!p.total) return '正在准备渲染…'
    return `正在栅格化第 ${Math.min(p.done + 1, p.total)} / ${p.total} 页…`
  }
  if (!p.total) return '正在解析 PDF…'
  return `正在处理图片 ${p.done} / ${p.total}`
})

function formatSize(bytes) {
  if (!bytes) return '0 KB'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(2) + ' MB'
}

async function handleFileChange(uploadFile) {
  const file = uploadFile.raw
  if (!file) return
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    ElMessage.warning('只能上传 PDF 文件')
    return
  }
  if (file.size > MAX_BYTES) {
    ElMessage.warning('文件超过 300 MB，浏览器内存吃不消，请先拆分')
    return
  }
  rawFile.value = file
  fileName.value = file.name
  originalBytes.value = file.size
  result.value = null
  totalPages.value = 0
  try {
    const pdf = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true })
    totalPages.value = pdf.getPageCount()
  } catch {
    ElMessage.warning('PDF 结构异常，仍可尝试压缩')
  }
}

function runInWorker(bytes, preset, runMode) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/pdfCompress.worker.js', import.meta.url), { type: 'module' })
    const id = Date.now() + Math.random()
    worker.onmessage = (event) => {
      const msg = event.data || {}
      if (msg.id !== id) return
      if (msg.type === 'progress') {
        progress.value = msg.progress
        return
      }
      worker.terminate()
      if (msg.type === 'done') resolve({ bytes: msg.bytes, stats: msg.stats })
      else reject(new Error(msg.message || '压缩失败'))
    }
    worker.onerror = (event) => {
      worker.terminate()
      reject(new Error(event.message || 'Worker 执行失败'))
    }
    worker.postMessage({ id, bytes, preset, mode: runMode }, [bytes.buffer])
  })
}

async function runOnMainThread(bytes, preset, runMode) {
  const mod = await import('../utils/pdfCompress.js')
  const run = runMode === 'raster' ? mod.rasterizePdf : mod.compressPdf
  return run(bytes, preset, (p) => {
    progress.value = p
  })
}

async function handleCompress() {
  if (!rawFile.value) {
    ElMessage.warning('请先上传 PDF 文件')
    return
  }
  compressing.value = true
  result.value = null
  progress.value = { phase: 'images', done: 0, total: 0 }
  try {
    const input = new Uint8Array(await rawFile.value.arrayBuffer())
    const preset = activePreset()
    const runMode = mode.value
    const output =
      typeof Worker !== 'undefined'
        ? await runInWorker(input, preset, runMode)
        : await runOnMainThread(input, preset, runMode)

    const before = originalBytes.value
    const produced = output.bytes
    // 压完反而更大就直接保留原文件。栅格化模式尤其需要这道闸：对纯文本/矢量 PDF，
    // 把每页拍成位图会显著变大（业界同类工具踩过 3.9 MB → 24.7 MB 的坑）。
    const noGain = produced.length >= before
    const bytes = noGain ? new Uint8Array(await rawFile.value.arrayBuffer()) : produced

    result.value = {
      bytes,
      before,
      after: bytes.length,
      saved: before - bytes.length,
      ratio: before > 0 ? (before - bytes.length) / before : 0,
      stats: output.stats,
      raster: runMode === 'raster',
      noGain,
    }
    if (noGain) {
      ElMessage.warning('这份 PDF 压完反而更大，已自动保留原文件')
    } else {
      ElMessage.success(`压缩完成，省了 ${formatSize(before - bytes.length)}`)
    }
  } catch (error) {
    ElMessage.error(error.message || '压缩失败')
  } finally {
    compressing.value = false
  }
}

function handleDownload() {
  if (!result.value) return
  const blob = new Blob([result.value.bytes], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName.value.replace(/\.pdf$/i, '') + '_compressed.pdf'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
</script>

<template>
  <div class="pdf-compress-view">
    <div class="page-header">
      <div>
        <h2 class="page-title"><span class="title-icon">🗜️</span> PDF 压缩</h2>
        <p class="page-desc">纯前端压缩 · 文本与矢量原样保留 · 文件不离开你的设备</p>
      </div>
    </div>

    <el-row :gutter="20">
      <el-col :xs="24" :md="12">
        <div class="col-wrap">
          <el-upload
            drag
            :auto-upload="false"
            :show-file-list="false"
            :on-change="handleFileChange"
            accept="application/pdf"
            class="upload-area"
          >
            <div class="upload-placeholder">
              <el-icon :size="36"><UploadFilled /></el-icon>
              <span>拖拽 PDF 文件到此处</span>
              <span class="upload-hint">单个文件，最大 300 MB</span>
            </div>
          </el-upload>

          <div v-if="!rawFile" class="empty-card">
            <el-icon :size="28"><Document /></el-icon>
            <span>请上传一个 PDF 文件</span>
          </div>

          <div v-if="rawFile" class="info-card">
            <div class="info-row"><span class="info-label">文件名称</span><span class="info-value">{{ fileName }}</span></div>
            <div class="info-row"><span class="info-label">原始大小</span><span class="info-value highlight">{{ originalSize }}</span></div>
            <div class="info-row"><span class="info-label">总页数</span><span class="info-value">{{ totalPages || '—' }} 页</span></div>
          </div>
        </div>
      </el-col>

      <el-col :xs="24" :md="12">
        <div class="col-wrap">
          <div class="config-card">
            <label class="config-label">压缩模式</label>
            <el-radio-group v-model="mode" class="mode-group" :disabled="compressing">
              <el-radio-button value="images">常规压缩</el-radio-button>
              <el-radio-button value="raster">扫描件极限</el-radio-button>
            </el-radio-group>

            <template v-if="!isRaster">
              <label class="config-label">压缩档位</label>
              <el-radio-group v-model="presetKey" class="preset-group" :disabled="compressing">
                <el-radio v-for="item in presets" :key="item.key" :value="item.key" border class="preset-radio">
                  <span class="preset-label">{{ item.label }}</span>
                  <span class="preset-desc">{{ item.desc }}</span>
                </el-radio>
                <el-radio value="custom" border class="preset-radio">
                  <span class="preset-label">自定义</span>
                  <span class="preset-desc">手动指定画质与分辨率上限</span>
                </el-radio>
              </el-radio-group>

              <div v-if="presetKey === 'custom'" class="slider-block">
                <div class="slider-row">
                  <span class="slider-label">JPEG 画质</span>
                  <el-slider
                    v-model="customQuality"
                    :min="0.3"
                    :max="0.95"
                    :step="0.05"
                    :format-tooltip="(v) => Math.round(v * 100) + '%'"
                    :disabled="compressing"
                  />
                </div>
                <div class="slider-row">
                  <span class="slider-label">图片长边上限</span>
                  <el-slider
                    v-model="customLongSide"
                    :min="600"
                    :max="4000"
                    :step="100"
                    :format-tooltip="(v) => v + ' px'"
                    :disabled="compressing"
                  />
                </div>
              </div>
            </template>

            <template v-else>
              <div class="warn-box">
                这个模式会把<b>每一页拍成图片</b>重建 PDF：体积能暴降，但
                <b>文字从此不可选中、不可搜索</b>，书签与链接也会失效。只在确实不需要复制文字时才用。
              </div>
              <div class="slider-block">
                <div class="slider-row">
                  <span class="slider-label">渲染精度</span>
                  <el-slider
                    v-model="rasterDpi"
                    :min="72"
                    :max="300"
                    :step="6"
                    :format-tooltip="(v) => v + ' DPI'"
                    :disabled="compressing"
                  />
                </div>
                <div class="slider-row">
                  <span class="slider-label">JPEG 画质</span>
                  <el-slider
                    v-model="rasterQuality"
                    :min="0.35"
                    :max="0.95"
                    :step="0.05"
                    :format-tooltip="(v) => Math.round(v * 100) + '%'"
                    :disabled="compressing"
                  />
                </div>
              </div>
            </template>

            <div class="extra-options">
              <label class="config-label">进阶选项</label>
              <el-checkbox v-model="wantGrayscale" :disabled="compressing" class="opt-check">
                灰度化 —— 彩色图转黑白再压，黑白文档能再省一截（会丢颜色）
              </el-checkbox>
              <el-checkbox v-if="!isRaster" v-model="wantDedupe" :disabled="compressing" class="opt-check">
                图片去重 —— 内容完全相同的图片只保留一份
              </el-checkbox>
            </div>

            <el-button
              type="primary"
              class="action-btn"
              :loading="compressing"
              :disabled="!rawFile"
              @click="handleCompress"
            >
              {{ compressing ? '压缩中…' : '开始压缩' }}
            </el-button>
          </div>

          <div v-if="compressing" class="progress-card">
            <el-progress :percentage="progressPercent" :stroke-width="10" />
            <p class="progress-text">{{ progressText }}</p>
          </div>

          <div v-if="result" class="result-card">
            <div class="result-row">
              <div class="result-item">
                <span class="result-label">压缩前</span>
                <span class="result-value">{{ formatSize(result.before) }}</span>
              </div>
              <span class="result-arrow">→</span>
              <div class="result-item">
                <span class="result-label">压缩后</span>
                <span class="result-value highlight">{{ formatSize(result.after) }}</span>
              </div>
            </div>
            <p class="result-summary">
              体积减少 <b>{{ Math.round(result.ratio * 100) }}%</b>
              （省下 {{ formatSize(result.saved) }}）·
              <template v-if="result.raster">栅格化了 {{ result.stats.pages }} 页</template>
              <template v-else>
                处理了 {{ result.stats.replaced }} / {{ result.stats.images }} 张图片<template v-if="result.stats.merged">，合并了 {{ result.stats.merged }} 张重复图</template>
              </template>
            </p>
            <p v-if="result.noGain" class="result-hint">
              压完比原文件还大，<b>已原样保留原文件</b> —— 这份 PDF 在当前模式下没有压缩空间。
              <template v-if="result.raster">多半因为它本身以文本/矢量为主，栅格化反而把文字变成了大位图。</template>
              换「常规压缩」或调低参数再试。
            </p>
            <p v-else-if="result.raster" class="result-hint">
              扫描件极限模式：每页已变成图片，<b>文字不可再选中或搜索</b>。需要保留文字请改用常规压缩。
            </p>
            <p v-else-if="result.stats.replaced === 0" class="result-hint">
              这份 PDF 里没有可安全重编码的图片（可能是纯文本、矢量图，或用了浏览器解不开的编码 —— JPXDecode /
              CCITTFaxDecode / JBIG2Decode），已只做结构优化，体积变化有限。这是正常且安全的；确实要极限压缩就切到「扫描件极限」。
            </p>
            <el-button type="success" class="action-btn" @click="handleDownload">
              <el-icon><Download /></el-icon>
              &nbsp;下载压缩后的 PDF
            </el-button>
          </div>

          <p class="footnote">
            <b>常规压缩</b>：重新编码内嵌图片（可降采样）+ 无损结构优化，文字与矢量完全不动。<br />
            <b>扫描件极限</b>：整页渲染成图片后重建，体积最小，代价是文字变成图片。
          </p>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.pdf-compress-view {
  padding: 24px 28px 56px;
  max-width: 1200px;
}

.page-header {
  margin-bottom: 20px;
}

.page-title {
  margin: 0 0 6px;
  font-size: 20px;
  font-weight: 500;
  color: var(--text-heading);
}

.title-icon {
  margin-right: 6px;
}

.page-desc {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.col-wrap {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.upload-area :deep(.el-upload-dragger) {
  background: var(--bg-ctrl);
  border: 1px dashed var(--border-color);
  border-radius: 12px;
  padding: 26px 16px;
}

.upload-area :deep(.el-upload-dragger:hover) {
  border-color: var(--accent-blue);
}

.upload-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 13px;
}

.upload-hint {
  font-size: 12px;
  color: var(--text-muted);
}

.empty-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 40px 16px;
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  background: var(--bg-card);
  color: var(--text-muted);
  font-size: 13px;
}

.info-card,
.config-card,
.progress-card,
.result-card {
  padding: 16px 18px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  background: var(--bg-card);
}

.info-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
  font-size: 13px;
}

.info-label {
  color: var(--text-secondary);
  flex: none;
}

.info-value {
  color: var(--text-primary);
  word-break: break-all;
  text-align: right;
}

.info-value.highlight {
  color: var(--accent-blue);
}

.config-label {
  display: block;
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 12px;
}

.preset-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: stretch;
  margin-bottom: 16px;
}

.preset-radio {
  margin: 0 !important;
  height: auto;
  padding: 10px 14px;
  background: var(--bg-ctrl);
  border-color: var(--border-color);
}

.preset-radio :deep(.el-radio__label) {
  display: flex;
  flex-direction: column;
  gap: 2px;
  white-space: normal;
}

.preset-label {
  font-size: 13px;
  color: var(--text-primary);
}

.preset-desc {
  font-size: 12px;
  color: var(--text-muted);
}

.mode-group {
  margin-bottom: 16px;
}

.slider-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 16px;
  padding: 12px 14px;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: var(--bg-ctrl);
}

.slider-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.slider-label {
  flex: none;
  width: 88px;
  font-size: 12px;
  color: var(--text-secondary);
}

.slider-row :deep(.el-slider) {
  flex: 1;
  min-width: 0;
}

.extra-options {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
  padding: 12px 14px;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: var(--bg-ctrl);
}

.extra-options .config-label {
  margin-bottom: 0;
}

.opt-check {
  height: auto;
  align-items: flex-start;
  white-space: normal;
}

.opt-check :deep(.el-checkbox__label) {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.warn-box {
  margin-bottom: 16px;
  padding: 10px 14px;
  border: 1px solid var(--accent-red);
  border-radius: 10px;
  background: rgba(231, 76, 60, 0.08);
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-primary);
}

.action-btn {
  width: 100%;
}

.progress-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.progress-text {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.result-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.result-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.result-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.result-label {
  font-size: 12px;
  color: var(--text-secondary);
}

.result-value {
  font-size: 18px;
  font-weight: 500;
  color: var(--text-heading);
}

.result-value.highlight {
  color: var(--accent-green);
}

.result-arrow {
  font-size: 16px;
  color: var(--text-muted);
}

.result-summary {
  margin: 0;
  font-size: 13px;
  color: var(--text-primary);
}

.result-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-muted);
}

.footnote {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-muted);
}

@media (max-width: 760px) {
  .pdf-compress-view {
    padding: 16px 12px 40px;
  }
}
</style>

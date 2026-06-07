<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  UploadFilled,
  Document,
  Picture,
} from '@element-plus/icons-vue'

function gilbertCurve(width, height) {
  const points = []
  if (width >= height) {
    walk(0, 0, width, 0, 0, height, points)
  } else {
    walk(0, 0, 0, height, width, 0, points)
  }
  return points
}

function walk(x, y, ax, ay, bx, by, out) {
  const w = Math.abs(ax + ay)
  const h = Math.abs(bx + by)
  const dax = Math.sign(ax)
  const day = Math.sign(ay)
  const dbx = Math.sign(bx)
  const dby = Math.sign(by)

  if (h === 1) {
    for (let i = 0; i < w; i += 1) {
      out.push([x, y])
      x += dax
      y += day
    }
    return
  }

  if (w === 1) {
    for (let i = 0; i < h; i += 1) {
      out.push([x, y])
      x += dbx
      y += dby
    }
    return
  }

  let ax2 = Math.floor(ax / 2)
  let ay2 = Math.floor(ay / 2)
  let bx2 = Math.floor(bx / 2)
  let by2 = Math.floor(by / 2)

  const w2 = Math.abs(ax2 + ay2)
  const h2 = Math.abs(bx2 + by2)

  if (2 * w > 3 * h) {
    if (w2 % 2 && w > 2) {
      ax2 += dax
      ay2 += day
    }
    walk(x, y, ax2, ay2, bx, by, out)
    walk(x + ax2, y + ay2, ax - ax2, ay - ay2, bx, by, out)
  } else {
    if (h2 % 2 && h > 2) {
      bx2 += dbx
      by2 += dby
    }
    walk(x, y, bx2, by2, ax2, ay2, out)
    walk(x + bx2, y + by2, ax, ay, bx - bx2, by - by2, out)
    walk(
      x + (ax - dax) + (bx2 - dbx),
      y + (ay - day) + (by2 - dby),
      -bx2,
      -by2,
      -(ax - ax2),
      -(ay - ay2),
      out,
    )
  }
}

const mode = ref('deobfuscate')
const scratchEnabled = ref(false)
const processing = ref(false)
const sourceImageUrl = ref('')
const sourceBlob = ref(null)
const sourceMeta = ref({ width: 0, height: 0 })
const resultReady = ref(false)
const resultIsObfuscated = ref(false)

const sourceCanvasRef = ref(null)
const resultCanvasRef = ref(null)

const sourceStoreCanvas = document.createElement('canvas')
const resultStoreCanvas = document.createElement('canvas')

let scratchState = null
let isScratching = false
const scratchRadius = 28

const hasImage = computed(() => Boolean(sourceImageUrl.value))

function getDisplaySize(width, height, maxWidth = 720, maxHeight = 720) {
  if (!width || !height) return { width: 0, height: 0 }
  const scale = Math.min(maxWidth / width, maxHeight / height, 1)
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  }
}

function drawCanvasScaled(storeCanvas, displayCanvas) {
  if (!storeCanvas || !displayCanvas || !storeCanvas.width || !storeCanvas.height) return

  const display = getDisplaySize(storeCanvas.width, storeCanvas.height, 720, 720)
  displayCanvas.width = storeCanvas.width
  displayCanvas.height = storeCanvas.height
  displayCanvas.style.width = `${display.width}px`
  displayCanvas.style.height = `${display.height}px`

  const ctx = displayCanvas.getContext('2d')
  ctx.clearRect(0, 0, displayCanvas.width, displayCanvas.height)
  ctx.drawImage(storeCanvas, 0, 0)
}

function syncPreviewCanvases() {
  if (sourceCanvasRef.value && sourceStoreCanvas.width) {
    drawCanvasScaled(sourceStoreCanvas, sourceCanvasRef.value)
  }
  if (resultCanvasRef.value && resultStoreCanvas.width) {
    drawCanvasScaled(resultStoreCanvas, resultCanvasRef.value)
  }
}

function resetScratchState() {
  scratchState = null
  isScratching = false
}

function loadImageFromObjectUrl(url, blobLike) {
  const img = new Image()
  img.onload = () => {
    sourceMeta.value = { width: img.width, height: img.height }

    sourceStoreCanvas.width = img.width
    sourceStoreCanvas.height = img.height
    const srcCtx = sourceStoreCanvas.getContext('2d')
    srcCtx.clearRect(0, 0, img.width, img.height)
    srcCtx.drawImage(img, 0, 0)

    resultStoreCanvas.width = img.width
    resultStoreCanvas.height = img.height
    const resultCtx = resultStoreCanvas.getContext('2d')
    resultCtx.clearRect(0, 0, img.width, img.height)

    sourceImageUrl.value = url
    sourceBlob.value = blobLike
    resultReady.value = false
    resultIsObfuscated.value = false
    resetScratchState()
    syncPreviewCanvases()
    ElMessage.success(`图片已加载 (${img.width} x ${img.height})`)
  }

  img.onerror = () => {
    ElMessage.error('图片加载失败')
  }

  img.src = url
}

function handleFileUpload(file) {
  if (!file || !file.type?.startsWith('image/')) {
    ElMessage.warning('请选择图片文件')
    return false
  }

  const url = URL.createObjectURL(file)
  loadImageFromObjectUrl(url, file)
  return false
}

async function handlePaste() {
  try {
    const items = await navigator.clipboard.read()
    for (const item of items) {
      const imageType = item.types.find((type) => type.startsWith('image/'))
      if (!imageType) continue
      const blob = await item.getType(imageType)
      const url = URL.createObjectURL(blob)
      loadImageFromObjectUrl(url, blob)
      ElMessage.success('已从剪贴板读取图片')
      return
    }
    ElMessage.warning('剪贴板中没有图片')
  } catch {
    ElMessage.warning('无法读取剪贴板')
  }
}

function transformCanvas(sourceCanvas, type) {
  const width = sourceCanvas.width
  const height = sourceCanvas.height
  const srcCtx = sourceCanvas.getContext('2d')
  const sourcePixels = srcCtx.getImageData(0, 0, width, height)
  const targetPixels = new ImageData(width, height)

  const curve = gilbertCurve(width, height)
  const total = width * height
  const step = Math.round(((Math.sqrt(5) - 1) / 2) * total)

  for (let index = 0; index < total; index += 1) {
    const srcPoint = curve[index]
    const dstPoint = curve[(index + step) % total]
    const srcOffset = 4 * (srcPoint[0] + srcPoint[1] * width)
    const dstOffset = 4 * (dstPoint[0] + dstPoint[1] * width)

    if (type === 'enc') {
      targetPixels.data.set(sourcePixels.data.slice(srcOffset, srcOffset + 4), dstOffset)
    } else {
      targetPixels.data.set(sourcePixels.data.slice(dstOffset, dstOffset + 4), srcOffset)
    }
  }

  resultStoreCanvas.width = width
  resultStoreCanvas.height = height
  const resultCtx = resultStoreCanvas.getContext('2d')
  resultCtx.putImageData(targetPixels, 0, 0)
  syncPreviewCanvases()
}

function handleObfuscate() {
  if (!hasImage.value) {
    ElMessage.warning('请先选择图片')
    return
  }

  processing.value = true
  requestAnimationFrame(() => {
    transformCanvas(sourceStoreCanvas, 'enc')
    resultReady.value = true
    resultIsObfuscated.value = true
    resetScratchState()
    processing.value = false
    ElMessage.success('混淆完成')
  })
}

function handleDeobfuscate() {
  if (!hasImage.value) {
    ElMessage.warning('请先选择图片')
    return
  }

  if (!resultReady.value) {
    processing.value = true
    requestAnimationFrame(() => {
      transformCanvas(sourceStoreCanvas, 'dec')
      resultReady.value = true
      resultIsObfuscated.value = false
      processing.value = false
      ElMessage.success('解混淆完成')
    })
    return
  }

  if (scratchEnabled.value && resultIsObfuscated.value) {
    const ctx = resultStoreCanvas.getContext('2d')
    scratchState = {
      imageData: ctx.getImageData(0, 0, resultStoreCanvas.width, resultStoreCanvas.height),
      curve: gilbertCurve(resultStoreCanvas.width, resultStoreCanvas.height),
      total: resultStoreCanvas.width * resultStoreCanvas.height,
      step: Math.round(((Math.sqrt(5) - 1) / 2) * resultStoreCanvas.width * resultStoreCanvas.height),
      width: resultStoreCanvas.width,
      height: resultStoreCanvas.height,
    }
    ElMessage.success('刮刮乐模式已启用，按住结果图涂抹即可局部还原')
    return
  }

  processing.value = true
  requestAnimationFrame(() => {
    transformCanvas(resultStoreCanvas, 'dec')
    resultReady.value = true
    resultIsObfuscated.value = false
    resetScratchState()
    processing.value = false
    ElMessage.success('解混淆完成')
  })
}

function scratchAt(event) {
  if (!scratchState || !resultCanvasRef.value) return

  const rect = resultCanvasRef.value.getBoundingClientRect()
  const scaleX = scratchState.width / rect.width
  const scaleY = scratchState.height / rect.height
  const mx = (event.clientX - rect.left) * scaleX
  const my = (event.clientY - rect.top) * scaleY

  const sx = Math.max(0, Math.floor(mx - scratchRadius))
  const ex = Math.min(scratchState.width - 1, Math.ceil(mx + scratchRadius))
  const sy = Math.max(0, Math.floor(my - scratchRadius))
  const ey = Math.min(scratchState.height - 1, Math.ceil(my + scratchRadius))

  const srcPixels = scratchState.imageData.data
  const targetPixels = new ImageData(new Uint8ClampedArray(srcPixels), scratchState.width, scratchState.height)
  const out = targetPixels.data
  const { curve, total, step, width } = scratchState

  for (let index = 0; index < total; index += 1) {
    const srcPoint = curve[index]
    const dstPoint = curve[(index + step) % total]
    const dx = dstPoint[0]
    const dy = dstPoint[1]

    if (dx < sx || dx > ex || dy < sy || dy > ey) continue

    const srcOffset = 4 * (srcPoint[0] + srcPoint[1] * width)
    const dstOffset = 4 * (dx + dy * width)
    out.set(srcPixels.slice(dstOffset, dstOffset + 4), srcOffset)
  }

  const ctx = resultStoreCanvas.getContext('2d')
  ctx.putImageData(targetPixels, 0, 0)
  syncPreviewCanvases()
}

function onScratchStart(event) {
  if (!scratchEnabled.value || !resultIsObfuscated.value || !scratchState) return
  isScratching = true
  scratchAt(event)
}

function onScratchMove(event) {
  if (!isScratching) return
  scratchAt(event)
}

function onScratchEnd() {
  isScratching = false
}

function downloadResult() {
  if (!resultReady.value || !resultStoreCanvas.width) {
    ElMessage.warning('请先生成结果')
    return
  }

  resultStoreCanvas.toBlob((blob) => {
    if (!blob) {
      ElMessage.warning('导出失败')
      return
    }
    const link = document.createElement('a')
    link.download = resultIsObfuscated.value ? 'obfuscated-gilbert.jpg' : 'deobfuscated-gilbert.jpg'
    link.href = URL.createObjectURL(blob)
    link.click()
    setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  }, 'image/jpeg', 0.95)
}

function onGlobalPaste(event) {
  const items = event.clipboardData?.items
  if (!items) return
  for (const item of items) {
    if (!item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) {
      handleFileUpload(file)
      break
    }
  }
}

onMounted(() => {
  document.addEventListener('paste', onGlobalPaste)
})

onUnmounted(() => {
  document.removeEventListener('paste', onGlobalPaste)
})
</script>

<template>
  <div class="obfuscate-view">
    <div class="page-header">
      <div>
        <h2 class="page-title"><span class="title-icon">图片</span> 图片混淆与还原</h2>
        <p class="page-desc">Gilbert 空间填充曲线与黄金分割置换，预览只做视觉缩放，不改变实际处理像素。</p>
      </div>
    </div>

    <el-row :gutter="20">
      <el-col :xs="24" :md="12">
        <div class="col-wrap">
          <div class="ctrl-card">
            <div class="mode-row">
              <span class="row-label">操作模式</span>
              <el-radio-group v-model="mode" class="mode-group">
                <el-radio value="obfuscate">自动混淆</el-radio>
                <el-radio value="deobfuscate">自动解混淆</el-radio>
                <el-radio value="none">不处理</el-radio>
              </el-radio-group>
            </div>

            <div class="ctrl-section">
              <div class="switch-row">
                <label class="ctrl-label">刮刮乐效果</label>
                <el-switch v-model="scratchEnabled" />
              </div>
              <p class="ctrl-hint">开启后会在解混淆时启用局部刮开模式，仅影响显示，不改变原始输入数据。</p>
            </div>

            <el-upload
              drag
              :auto-upload="false"
              :show-file-list="false"
              :on-change="(uploadFile) => handleFileUpload(uploadFile.raw)"
              accept="image/*"
              class="upload-area"
            >
              <div v-if="!hasImage" class="upload-placeholder">
                <el-icon :size="36"><UploadFilled /></el-icon>
                <span>点击或拖拽选择图片</span>
                <span class="upload-hint">JPG / PNG / WebP</span>
              </div>
              <div v-else class="upload-preview">
                <el-icon :size="20"><UploadFilled /></el-icon>
                <span class="upload-change">点击更换图片</span>
              </div>
            </el-upload>

            <el-button class="paste-btn" @click="handlePaste">
              <el-icon><Document /></el-icon>
              从剪贴板粘贴
            </el-button>

            <el-divider />

            <div class="action-row">
              <el-button type="primary" :loading="processing" :disabled="!hasImage || mode === 'none'" @click="handleObfuscate">
                {{ processing ? '处理中...' : '执行混淆' }}
              </el-button>
              <el-button type="success" :disabled="!hasImage || mode === 'none'" @click="handleDeobfuscate">
                执行解混淆
              </el-button>
            </div>

            <el-divider />

            <el-button size="large" class="download-btn" @click="downloadResult">
              一键保存 JPEG 0.95
            </el-button>
          </div>

          <div class="preview-card">
            <h3 class="section-title">原图预览</h3>
            <div class="img-box">
              <canvas v-if="hasImage" ref="sourceCanvasRef" class="fit-canvas" />
              <div v-else class="empty-state">
                <el-icon :size="28"><Picture /></el-icon>
                <span>请选择或粘贴图片</span>
              </div>
            </div>
          </div>
        </div>
      </el-col>

      <el-col :xs="24" :md="12">
        <div class="col-wrap">
          <div class="preview-card result-card">
            <h3 class="section-title">
              结果画布
              <span v-if="resultReady && resultIsObfuscated" class="badge obfuscated">已混淆</span>
              <span v-if="resultReady && !resultIsObfuscated" class="badge clear">清晰</span>
            </h3>
            <div class="img-box">
              <canvas
                ref="resultCanvasRef"
                class="fit-canvas result-canvas"
                @mousedown="onScratchStart"
                @mousemove="onScratchMove"
                @mouseup="onScratchEnd"
                @mouseleave="onScratchEnd"
              />
            </div>
          </div>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.obfuscate-view {
  max-width: 1200px;
  margin: 0 auto;
  padding: 20px 16px 40px;
}

.page-header {
  margin-bottom: 20px;
}

.page-title {
  font-size: 1.4rem;
  font-weight: 500;
  color: var(--text-heading);
  margin: 0 0 4px;
  letter-spacing: 0.8px;
}

.title-icon {
  margin-right: 8px;
}

.page-desc {
  color: var(--text-secondary);
  font-size: 0.88rem;
  margin: 0;
  line-height: 1.5;
}

.col-wrap {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.ctrl-card,
.preview-card {
  background: var(--bg-card);
  border-radius: 12px;
  border: 1px solid var(--border-color);
  padding: 18px;
}

.mode-row {
  display: flex;
  gap: 16px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 18px;
}

.row-label,
.ctrl-label {
  color: var(--text-primary);
  font-size: 0.86rem;
  font-weight: 500;
}

.mode-group {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
}

.ctrl-section {
  background: var(--bg-ctrl);
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 12px;
}

.switch-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.ctrl-hint {
  color: var(--text-secondary);
  font-size: 0.76rem;
  margin: 8px 0 0;
  line-height: 1.4;
}

.upload-area {
  width: 100%;
}

:deep(.el-upload-dragger) {
  background: var(--bg-ctrl) !important;
  border: 2px dashed var(--border-color) !important;
  border-radius: 10px !important;
  padding: 14px;
}

.upload-placeholder,
.upload-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.upload-placeholder {
  color: var(--text-secondary);
  font-size: 0.82rem;
}

.upload-preview {
  color: var(--accent-blue);
  font-size: 0.84rem;
}

.upload-hint {
  color: var(--text-muted);
  font-size: 0.72rem;
}

.paste-btn,
.download-btn {
  width: 100%;
}

.action-row {
  display: flex;
  gap: 12px;
}

.action-row .el-button {
  flex: 1;
  height: 40px;
  font-weight: 600;
}

.section-title {
  color: var(--text-primary);
  font-size: 0.92rem;
  font-weight: 600;
  margin: 0 0 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.badge {
  font-size: 0.68rem;
  padding: 2px 8px;
  border-radius: 999px;
  font-weight: 500;
}

.badge.obfuscated {
  background: rgba(231, 76, 60, 0.12);
  color: #d94b4b;
  border: 1px solid rgba(231, 76, 60, 0.25);
}

.badge.clear {
  background: rgba(67, 160, 71, 0.12);
  color: #43a047;
  border: 1px solid rgba(67, 160, 71, 0.25);
}

.img-box {
  max-height: 720px;
  width: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  background: var(--bg-deep);
  border-radius: 12px;
  overflow: auto;
  min-height: 160px;
  padding: 10px;
}

.fit-canvas {
  display: block;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 8px;
  background: var(--bg-canvas);
}

.result-canvas {
  cursor: crosshair;
}

.result-card {
  flex: 1;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 50px 20px;
  color: var(--text-muted);
  font-size: 0.84rem;
}

@media (max-width: 768px) {
  .obfuscate-view {
    padding: 12px 8px 30px;
  }

  .action-row {
    flex-direction: column;
  }

  .img-box {
    max-height: 420px;
  }
}
</style>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { UploadFilled, Document, Picture } from '@element-plus/icons-vue'

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
    return
  }

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

const sourceImageUrl = ref('')
const resultReady = ref(false)
const resultIsObfuscated = ref(false)
const processing = ref(false)
const imageMeta = ref(null)

const sourceStoreCanvas = document.createElement('canvas')
const resultStoreCanvas = document.createElement('canvas')
const sourceCanvasRef = ref(null)
const resultCanvasRef = ref(null)

const hasImage = computed(() => Boolean(sourceImageUrl.value))
const resultLabel = computed(() => {
  if (!resultReady.value) return '执行混淆或解混淆后显示结果'
  return resultIsObfuscated.value ? '当前结果为混淆图' : '当前结果为解混淆图'
})

function getDisplaySize(width, height, maxW = 720, maxH = 720) {
  const scale = Math.min(maxW / width, maxH / height, 1)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

function drawDisplayCanvas(storeCanvas, displayCanvas) {
  if (!storeCanvas.width || !storeCanvas.height || !displayCanvas) return

  const size = getDisplaySize(storeCanvas.width, storeCanvas.height)
  displayCanvas.width = storeCanvas.width
  displayCanvas.height = storeCanvas.height
  displayCanvas.style.width = `${size.width}px`
  displayCanvas.style.height = `${size.height}px`

  const ctx = displayCanvas.getContext('2d')
  ctx.clearRect(0, 0, displayCanvas.width, displayCanvas.height)
  ctx.drawImage(storeCanvas, 0, 0)
}

function syncPreviewCanvases() {
  if (sourceCanvasRef.value && sourceStoreCanvas.width) {
    drawDisplayCanvas(sourceStoreCanvas, sourceCanvasRef.value)
  }
  if (resultCanvasRef.value && resultStoreCanvas.width) {
    drawDisplayCanvas(resultStoreCanvas, resultCanvasRef.value)
  }
}

function resetResultState() {
  resultReady.value = false
  resultIsObfuscated.value = false
  resultStoreCanvas.width = 0
  resultStoreCanvas.height = 0
}

function loadImageFromBlob(blob) {
  const objectUrl = URL.createObjectURL(blob)
  const img = new Image()

  img.onload = async () => {
    imageMeta.value = { width: img.width, height: img.height }
    sourceStoreCanvas.width = img.width
    sourceStoreCanvas.height = img.height

    const ctx = sourceStoreCanvas.getContext('2d')
    ctx.clearRect(0, 0, img.width, img.height)
    ctx.drawImage(img, 0, 0)

    sourceImageUrl.value = objectUrl
    resetResultState()
    await nextTick()
    syncPreviewCanvases()
    ElMessage.success(`图片已加载（${img.width} x ${img.height}）`)
  }

  img.onerror = () => {
    URL.revokeObjectURL(objectUrl)
    ElMessage.error('图片加载失败，请重新选择')
  }

  img.src = objectUrl
}

function handleFileUpload(file) {
  if (!file || !file.type?.startsWith('image/')) {
    ElMessage.warning('请选择图片文件')
    return false
  }

  loadImageFromBlob(file)
  return false
}

async function handlePaste() {
  try {
    const clipboardItems = await navigator.clipboard.read()
    for (const item of clipboardItems) {
      const imageType = item.types.find((type) => type.startsWith('image/'))
      if (!imageType) continue

      const blob = await item.getType(imageType)
      loadImageFromBlob(blob)
      ElMessage.success('已从剪贴板读取图片')
      return
    }

    ElMessage.warning('剪贴板中没有可用图片')
  } catch {
    ElMessage.warning('无法读取剪贴板，请改用上传方式')
  }
}

function transformCanvas(sourceCanvas, type) {
  const width = sourceCanvas.width
  const height = sourceCanvas.height
  const srcCtx = sourceCanvas.getContext('2d')
  const srcPixels = srcCtx.getImageData(0, 0, width, height)
  const dstPixels = new ImageData(width, height)
  const curve = gilbertCurve(width, height)
  const total = width * height
  const step = Math.round(((Math.sqrt(5) - 1) / 2) * total)

  for (let i = 0; i < total; i += 1) {
    const srcPoint = curve[i]
    const dstPoint = curve[(i + step) % total]
    const srcIndex = 4 * (srcPoint[0] + srcPoint[1] * width)
    const dstIndex = 4 * (dstPoint[0] + dstPoint[1] * width)

    if (type === 'enc') {
      dstPixels.data.set(srcPixels.data.slice(srcIndex, srcIndex + 4), dstIndex)
    } else {
      dstPixels.data.set(srcPixels.data.slice(dstIndex, dstIndex + 4), srcIndex)
    }
  }

  resultStoreCanvas.width = width
  resultStoreCanvas.height = height
  resultStoreCanvas.getContext('2d').putImageData(dstPixels, 0, 0)
}

function handleObfuscate() {
  if (!hasImage.value) {
    ElMessage.warning('请先上传图片')
    return
  }

  processing.value = true
  setTimeout(async () => {
    transformCanvas(sourceStoreCanvas, 'enc')
    resultReady.value = true
    resultIsObfuscated.value = true
    await nextTick()
    syncPreviewCanvases()
    processing.value = false
    ElMessage.success('混淆完成')
  }, 40)
}

function handleDeobfuscate() {
  if (!hasImage.value) {
    ElMessage.warning('请先上传图片')
    return
  }

  processing.value = true
  setTimeout(async () => {
    transformCanvas(sourceStoreCanvas, 'dec')
    resultReady.value = true
    resultIsObfuscated.value = false
    await nextTick()
    syncPreviewCanvases()
    processing.value = false
    ElMessage.success('解混淆完成')
  }, 40)
}

function downloadResult() {
  if (!resultReady.value || !resultStoreCanvas.width) {
    ElMessage.warning('请先生成结果图片')
    return
  }

  const link = document.createElement('a')
  link.download = resultIsObfuscated.value ? 'obfuscated.png' : 'deobfuscated.png'
  link.href = resultStoreCanvas.toDataURL('image/png')
  link.click()
}

function onGlobalPaste(event) {
  const items = event.clipboardData?.items
  if (!items) return

  for (const item of items) {
    if (!item.type.startsWith('image/')) continue
    const blob = item.getAsFile()
    if (blob) {
      handleFileUpload(blob)
      break
    }
  }
}

onMounted(() => {
  document.addEventListener('paste', onGlobalPaste)
})

onUnmounted(() => {
  document.removeEventListener('paste', onGlobalPaste)
  if (sourceImageUrl.value) {
    URL.revokeObjectURL(sourceImageUrl.value)
  }
})
</script>

<template>
  <div class="obfuscate-view">
    <div class="page-header">
      <div>
        <h2 class="page-title"><span class="title-icon">🕵️</span> 图片混淆与还原</h2>
        <p class="page-desc">Gilbert 空间填充曲线与黄金分割置换</p>
      </div>
    </div>

    <el-row :gutter="20">
      <el-col :xs="24" :md="12">
        <div class="col-wrap">
          <div class="ctrl-card">
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
                <span class="upload-hint">支持 JPG / PNG / WebP</span>
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
              <el-button class="action-btn" type="primary" size="large" :loading="processing" :disabled="!hasImage" @click="handleObfuscate">
                {{ processing ? '处理中...' : '混淆' }}
              </el-button>
              <el-button class="action-btn" type="success" size="large" :loading="processing" :disabled="!hasImage" @click="handleDeobfuscate">
                {{ processing ? '处理中...' : '解混淆' }}
              </el-button>
            </div>

            <el-divider />

            <el-button size="large" class="download-btn" :disabled="!resultReady" @click="downloadResult">
              保存图片
            </el-button>
          </div>

          <div class="preview-card">
            <h3 class="section-title">
              原图预览
              <span v-if="imageMeta" class="meta-text">{{ imageMeta.width }} x {{ imageMeta.height }}</span>
            </h3>
            <div class="img-box">
              <canvas v-if="hasImage" ref="sourceCanvasRef" class="fit-canvas" />
              <div v-else class="empty-state">
                <el-icon :size="28"><Picture /></el-icon>
                <span>上传图片后在这里预览原图</span>
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
              <span v-if="resultReady && !resultIsObfuscated" class="badge clear">已解混淆</span>
            </h3>
            <div class="img-box">
              <canvas v-if="resultReady" ref="resultCanvasRef" class="fit-canvas" />
              <div v-else class="empty-state">
                <el-icon :size="28"><Picture /></el-icon>
                <span>{{ resultLabel }}</span>
              </div>
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
  margin: 0 0 4px;
  color: var(--text-heading);
  font-size: 1.4rem;
  font-weight: 500;
  letter-spacing: 0.5px;
}

.title-icon {
  margin-right: 8px;
}

.page-desc {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.85rem;
}

.col-wrap {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.ctrl-card,
.preview-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 16px;
}

.ctrl-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 20px 18px;
}

.preview-card {
  padding: 16px;
}

.upload-area {
  width: 100%;
}

:deep(.el-upload-dragger) {
  background: var(--bg-ctrl);
  border: 2px dashed var(--border-color);
  border-radius: 12px;
  padding: 14px;
}

:deep(.el-upload-dragger:hover) {
  border-color: var(--accent-blue);
}

.upload-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  color: var(--text-secondary);
}

.upload-hint {
  color: var(--text-dim);
  font-size: 0.75rem;
}

.upload-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--accent-blue);
}

.upload-change {
  font-size: 0.92rem;
}

.paste-btn,
.download-btn {
  width: 100%;
}

:deep(.el-divider) {
  margin: 2px 0;
  border-color: var(--bg-hover);
}

.action-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  width: 100%;
}

.action-btn {
  width: 100%;
  min-width: 0;
  margin: 0;
}

.action-row :deep(.el-button) {
  height: 44px;
  font-weight: 600;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 10px;
  color: var(--text-heading);
  font-size: 0.92rem;
  font-weight: 500;
  flex-wrap: wrap;
}

.meta-text {
  color: var(--text-muted);
  font-size: 0.78rem;
  font-weight: 400;
}

.img-box {
  width: 100%;
  min-height: 180px;
  max-height: 760px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-canvas);
  border-radius: 14px;
  overflow: auto;
  padding: 16px;
}

.fit-canvas {
  display: block;
  max-width: 100%;
  max-height: none;
  background: var(--bg-canvas);
  border-radius: 10px;
}

.badge {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 0.72rem;
  line-height: 1.4;
}

.badge.obfuscated {
  color: #e74c3c;
  background: color-mix(in srgb, #e74c3c 12%, transparent);
  border: 1px solid color-mix(in srgb, #e74c3c 30%, transparent);
}

.badge.clear {
  color: #67c23a;
  background: color-mix(in srgb, #67c23a 14%, transparent);
  border: 1px solid color-mix(in srgb, #67c23a 30%, transparent);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 50px 20px;
  color: var(--text-dim);
  text-align: center;
}

@media (max-width: 768px) {
  .obfuscate-view {
    padding: 12px 8px 30px;
  }

  .ctrl-card,
  .preview-card {
    border-radius: 14px;
  }

  .img-box {
    min-height: 140px;
    padding: 12px;
  }
}

@media (max-width: 640px) {
  .action-row {
    grid-template-columns: 1fr;
  }

  .page-title {
    font-size: 1.22rem;
  }
}
</style>

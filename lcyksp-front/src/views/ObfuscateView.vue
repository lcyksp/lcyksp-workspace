<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { UploadFilled, Document, Picture } from '@element-plus/icons-vue'

function gilbertCurve(width, height) {
  const points = []
  if (width >= height) { walk(0, 0, width, 0, 0, height, points) }
  else { walk(0, 0, 0, height, width, 0, points) }
  return points
}

function walk(x, y, ax, ay, bx, by, out) {
  const w = Math.abs(ax + ay); const h = Math.abs(bx + by)
  const dax = Math.sign(ax); const day = Math.sign(ay)
  const dbx = Math.sign(bx); const dby = Math.sign(by)
  if (h === 1) { for (let i = 0; i < w; i++) { out.push([x, y]); x += dax; y += day } return }
  if (w === 1) { for (let i = 0; i < h; i++) { out.push([x, y]); x += dbx; y += dby } return }
  let ax2 = Math.floor(ax / 2), ay2 = Math.floor(ay / 2)
  let bx2 = Math.floor(bx / 2), by2 = Math.floor(by / 2)
  const w2 = Math.abs(ax2 + ay2); const h2 = Math.abs(bx2 + by2)
  if (2 * w > 3 * h) {
    if (w2 % 2 && w > 2) { ax2 += dax; ay2 += day }
    walk(x, y, ax2, ay2, bx, by, out)
    walk(x + ax2, y + ay2, ax - ax2, ay - ay2, bx, by, out)
  } else {
    if (h2 % 2 && h > 2) { bx2 += dbx; by2 += dby }
    walk(x, y, bx2, by2, ax2, ay2, out)
    walk(x + bx2, y + by2, ax, ay, bx - bx2, by - by2, out)
    walk(x + (ax - dax) + (bx2 - dbx), y + (ay - day) + (by2 - dby), -bx2, -by2, -(ax - ax2), -(ay - ay2), out)
  }
}

const mode = ref('none')
const sourceImageUrl = ref('')
const sourceBlob = ref(null)
const sourceMeta = ref(null)
const resultReady = ref(false)
const resultIsObfuscated = ref(false)
const processing = ref(false)

const sourceStoreCanvas = document.createElement('canvas')
const resultStoreCanvas = document.createElement('canvas')
const sourceCanvasRef = ref(null)
const resultCanvasRef = ref(null)

const hasImage = computed(() => !!sourceImageUrl.value)

function getDisplaySize(width, height, maxW, maxH) {
  const scale = Math.min(maxW / width, maxH / height, 1)
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
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
  if (sourceCanvasRef.value && sourceStoreCanvas.width) { drawCanvasScaled(sourceStoreCanvas, sourceCanvasRef.value) }
  if (resultCanvasRef.value && resultStoreCanvas.width) { drawCanvasScaled(resultStoreCanvas, resultCanvasRef.value) }
}

function loadImageFromObjectUrl(url, blobLike) {
  const img = new Image()
  img.onload = () => {
    sourceMeta.value = { width: img.width, height: img.height }
    sourceStoreCanvas.width = img.width; sourceStoreCanvas.height = img.height
    const srcCtx = sourceStoreCanvas.getContext('2d')
    srcCtx.clearRect(0, 0, img.width, img.height); srcCtx.drawImage(img, 0, 0)
    resultStoreCanvas.width = img.width; resultStoreCanvas.height = img.height
    resultStoreCanvas.getContext('2d').clearRect(0, 0, img.width, img.height)
    sourceImageUrl.value = url; sourceBlob.value = blobLike
    resultReady.value = false; resultIsObfuscated.value = false
    syncPreviewCanvases()
    ElMessage.success(`图片已加载 (${img.width} x ${img.height})`)
  }
  img.onerror = () => { ElMessage.error('图片加载失败') }
  img.src = url
}

function handleFileUpload(file) {
  if (!file || !file.type?.startsWith('image/')) { ElMessage.warning('请选择图片文件'); return false }
  loadImageFromObjectUrl(URL.createObjectURL(file), file)
  return false
}

async function handlePaste() {
  try {
    const items = await navigator.clipboard.read()
    for (const item of items) {
      const imageType = item.types.find(t => t.startsWith('image/'))
      if (!imageType) continue
      const blob = await item.getType(imageType)
      loadImageFromObjectUrl(URL.createObjectURL(blob), blob)
      ElMessage.success('已从剪贴板读取图片'); return
    }
    ElMessage.warning('剪贴板中没有图片')
  } catch { ElMessage.warning('无法读取剪贴板') }
}

function transformCanvas(sourceCanvas, type) {
  const w = sourceCanvas.width; const h = sourceCanvas.height
  const srcCtx = sourceCanvas.getContext('2d')
  const srcPixels = srcCtx.getImageData(0, 0, w, h)
  const dstPixels = new ImageData(w, h)
  const curve = gilbertCurve(w, h); const total = w * h
  const step = Math.round(((Math.sqrt(5) - 1) / 2) * total)
  for (let i = 0; i < total; i++) {
    const sp = curve[i]; const dp = curve[(i + step) % total]
    const si = 4 * (sp[0] + sp[1] * w); const di = 4 * (dp[0] + dp[1] * w)
    if (type === 'enc') { dstPixels.data.set(srcPixels.data.slice(si, si + 4), di) }
    else { dstPixels.data.set(srcPixels.data.slice(di, di + 4), si) }
  }
  resultStoreCanvas.width = w; resultStoreCanvas.height = h
  resultStoreCanvas.getContext('2d').putImageData(dstPixels, 0, 0)
  syncPreviewCanvases()
}

function handleObfuscate() {
  if (!hasImage.value) { ElMessage.warning('请先上传图片'); return }
  processing.value = true
  setTimeout(() => { transformCanvas(sourceStoreCanvas, 'enc'); resultReady.value = true; resultIsObfuscated.value = true; processing.value = false; ElMessage.success('混淆完成') }, 50)
}

function handleDeobfuscate() {
  if (!hasImage.value) { ElMessage.warning('请先上传图片'); return }
  if (!resultReady.value || !resultIsObfuscated.value) { ElMessage.warning('请先执行混淆'); return }
  processing.value = true
  setTimeout(() => { transformCanvas(resultStoreCanvas, 'dec'); resultReady.value = true; resultIsObfuscated.value = false; processing.value = false; ElMessage.success('解混淆完成') }, 50)
}

function downloadResult() {
  if (!resultStoreCanvas.width) { ElMessage.warning('请先生成结果'); return }
  const link = document.createElement('a')
  link.download = resultIsObfuscated.value ? 'obfuscated.png' : 'deobfuscated.png'
  link.href = resultStoreCanvas.toDataURL('image/png')
  link.click()
}

function onGlobalPaste(e) {
  const items = e.clipboardData?.items
  if (!items) return
  for (const item of items) {
    if (item.type.startsWith('image/')) { const blob = item.getAsFile(); if (blob) { handleFileUpload(blob); break } }
  }
}

onMounted(() => { document.addEventListener('paste', onGlobalPaste) })
onUnmounted(() => { document.removeEventListener('paste', onGlobalPaste) })
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
            <div class="mode-row">
              <span class="row-label">操作模式</span>
              <el-radio-group v-model="mode" class="mode-group">
                <el-radio value="obfuscate">自动混淆</el-radio>
                <el-radio value="deobfuscate">自动解混淆</el-radio>
                <el-radio value="none">不处理</el-radio>
              </el-radio-group>
            </div>

            <el-upload drag :auto-upload="false" :show-file-list="false"
              :on-change="(u) => handleFileUpload(u.raw)"
              accept="image/*" class="upload-area">
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
              <el-icon><Document /></el-icon> 从剪贴板粘贴
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
              保存图片
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
              <canvas v-if="resultReady" ref="resultCanvasRef" class="fit-canvas" />
              <div v-else class="empty-state">
                <el-icon :size="28"><Picture /></el-icon>
                <span>执行混淆或解混淆后显示结果</span>
              </div>
            </div>
          </div>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.obfuscate-view { max-width: 1200px; margin: 0 auto; padding: 20px 16px 40px; }
.page-header { margin-bottom: 20px; }
.page-title { font-size: 1.4rem; font-weight: 400; color: var(--text-heading); margin: 0 0 4px; letter-spacing: 1px; }
.title-icon { margin-right: 8px; }
.page-desc { color: var(--text-muted); font-size: 0.85rem; margin: 0; }
.col-wrap { display: flex; flex-direction: column; gap: 14px; }
.ctrl-card { background: var(--bg-card); border-radius: 12px; border: 1px solid var(--border-color); padding: 20px 18px; display: flex; flex-direction: column; gap: 10px; }
.mode-row { display: flex; gap: 16px; align-items: center; justify-content: flex-start; }
.row-label { font-size: 14px; color: var(--text-secondary); flex-shrink: 0; }
.mode-group { display: flex; gap: 20px; align-items: center; }
.upload-area { width: 100%; }
:deep(.el-upload-dragger) { background: var(--bg-ctrl); border: 2px dashed var(--border-color); border-radius: 8px; padding: 14px; }
.upload-placeholder { display: flex; flex-direction: column; align-items: center; gap: 4px; color: var(--text-secondary); }
.upload-hint { color: var(--text-dim); font-size: 0.7rem; }
.upload-preview { display: flex; align-items: center; justify-content: center; gap: 6px; color: var(--accent-blue); }
.paste-btn { width: 100%; }
:deep(.el-divider) { border-color: var(--bg-hover); margin: 2px 0; }
.action-row { display: flex; gap: 12px; width: 100%; }
.action-row .el-button { flex: 1; height: 40px; font-weight: bold; }
.download-btn { width: 100%; }
.preview-card { background: var(--bg-card); border-radius: 12px; border: 1px solid var(--border-color); padding: 16px; }
.section-title { color: var(--text-heading); font-size: 0.85rem; font-weight: 500; margin: 0 0 10px; display: flex; align-items: center; gap: 8px; }
.img-box { max-height: 460px; width: 100%; display: flex; justify-content: center; align-items: center; background: var(--bg-canvas); border-radius: 12px; overflow: hidden; min-height: 120px; }
.fit-canvas { max-height: 100%; max-width: 100%; object-fit: contain; border-radius: 8px; background: var(--bg-canvas); }
.badge { font-size: 0.68rem; padding: 1px 7px; border-radius: 4px; }
.badge.obfuscated { background: #3a1a1a; color: #e74c3c; border: 1px solid #5a2a2a; }
.badge.clear { background: #1a2a1a; color: #67c23a; border: 1px solid #2a4a2a; }
.empty-state { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 50px 20px; color: var(--text-dim); }
@media (max-width: 768px) { .obfuscate-view { padding: 12px 8px 30px; } }
</style>

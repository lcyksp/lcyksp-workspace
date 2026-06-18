<script setup>
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { 
  Picture, 
  UploadFilled, 
  Download, 
  Loading, 
  RefreshLeft,
  VideoPlay,
  Cpu,
  Monitor
} from '@element-plus/icons-vue'
import Upscaler from 'upscaler'
import esrganSlim2x from '@upscalerjs/esrgan-slim/2x'
import esrganSlim4x from '@upscalerjs/esrgan-slim/4x'

// UI state
const activeMode = ref('ai') // 'ai' or 'classic'
const scaleFactor = ref(2)   // 2 or 4
const rawFile = ref(null)
const originalUrl = ref('')
const upscaledUrl = ref('')
const processing = ref(false)
const progress = ref(0)
const progressMsg = ref('')

// Slider position for Before/After split view
const sliderPos = ref(50)
const imageWidth = ref(0)
const imageHeight = ref(0)

// Handle file upload
function handleFileChange(uploadFile) {
  const file = uploadFile.raw
  if (!file) return

  if (!file.type.startsWith('image/')) {
    ElMessage.error('请上传有效的图片文件！')
    return
  }

  // Revoke old object URL if any
  if (originalUrl.value) {
    URL.revokeObjectURL(originalUrl.value)
  }
  if (upscaledUrl.value) {
    URL.revokeObjectURL(upscaledUrl.value)
    upscaledUrl.value = ''
  }

  rawFile.value = file
  originalUrl.value = URL.createObjectURL(file)
  
  // Get image dimensions
  const img = new Image()
  img.onload = () => {
    imageWidth.value = img.width
    imageHeight.value = img.height
  }
  img.src = originalUrl.value
  
  progress.value = 0
  progressMsg.value = ''
}

// Reset state
function handleReset() {
  rawFile.value = null
  if (originalUrl.value) {
    URL.revokeObjectURL(originalUrl.value)
    originalUrl.value = ''
  }
  if (upscaledUrl.value) {
    URL.revokeObjectURL(upscaledUrl.value)
    upscaledUrl.value = ''
  }
  processing.value = false
  progress.value = 0
  progressMsg.value = ''
  imageWidth.value = 0
  imageHeight.value = 0
}

// Perform client-side upscaling
async function handleUpscale() {
  if (!rawFile.value) {
    ElMessage.warning('请先上传一张图片')
    return
  }

  processing.value = true
  progress.value = 0
  
  try {
    if (activeMode.value === 'ai') {
      await runAIUpscaling()
    } else {
      await runClassicUpscaling()
    }
  } catch (err) {
    console.error(err)
    ElMessage.error(`放大处理失败: ${err.message || err}`)
    progressMsg.value = '处理失败，请尝试切换为经典放大模式。'
  } finally {
    processing.value = false
  }
}

// AI Mode: UpscalerJS (WebGL / WebGPU) with Tiling
async function runAIUpscaling() {
  progressMsg.value = '正在加载 AI 模型 (首次加载可能需要较长时间)...'
  
  // Select model based on scale factor
  const selectedModel = scaleFactor.value === 4 ? esrganSlim4x : esrganSlim2x
  
  const upscaler = new Upscaler({
    model: selectedModel
  })

  progressMsg.value = '模型加载完毕，正在利用 GPU 进行无损放大计算...'
  
  // Create an image element to feed into upscaler
  const img = new Image()
  img.src = originalUrl.value
  await new Promise((resolve, reject) => {
    img.onload = resolve
    img.onerror = () => reject(new Error('加载原始图片失败'))
  })

  // Run upscale with patchSize (tiling) to prevent memory crashes
  const resultBase64 = await upscaler.upscale(img, {
    patchSize: 128,
    padding: 8,
    progress: (percent) => {
      progress.value = Math.round(percent * 100)
      progressMsg.value = `正在进行 AI 图像超分重建... 已完成 ${progress.value}%`
    }
  })

  upscaledUrl.value = resultBase64
  progress.value = 100
  progressMsg.value = 'AI 无损放大处理完成！'
  ElMessage.success('AI 无损放大完成！')
}

// Classic Mode: Canvas Bilinear + Sharpening filter
async function runClassicUpscaling() {
  progressMsg.value = '正在进行经典高清放大计算...'
  progress.value = 10
  
  const img = new Image()
  img.src = originalUrl.value
  await new Promise((resolve, reject) => {
    img.onload = resolve
    img.onerror = () => reject(new Error('加载原始图片失败'))
  })

  const targetWidth = img.width * scaleFactor.value
  const targetHeight = img.height * scaleFactor.value

  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = targetHeight
  const ctx = canvas.getContext('2d')

  // Use browser's highest quality smoothing
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  
  progress.value = 40
  ctx.drawImage(img, 0, 0, targetWidth, targetHeight)
  
  progress.value = 70
  // Apply a 3x3 sharpening convolution filter to boost details
  try {
    sharpenCanvas(ctx, targetWidth, targetHeight)
  } catch (e) {
    console.warn('Sharpening convolution failed, using raw scaling:', e)
  }

  progress.value = 90
  upscaledUrl.value = canvas.toDataURL('image/png')
  progress.value = 100
  progressMsg.value = '经典高清插值放大完成！'
  ElMessage.success('经典高清插值放大完成！')
}

// 3x3 Sharpening filter
function sharpenCanvas(ctx, width, height) {
  const imgData = ctx.getImageData(0, 0, width, height)
  const data = imgData.data
  const originalData = new Uint8ClampedArray(data)
  
  // 3x3 Sharpen Kernel
  const weights = [
     0,  -0.3,   0,
    -0.3,  2.2, -0.3,
     0,  -0.3,   0
  ]
  const side = Math.round(Math.sqrt(weights.length))
  const halfSide = Math.floor(side / 2)
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dstOff = (y * width + x) * 4
      
      let r = 0, g = 0, b = 0
      
      for (let cy = 0; cy < side; cy++) {
        for (let cx = 0; cx < side; cx++) {
          const scy = Math.min(height - 1, Math.max(0, y + cy - halfSide))
          const scx = Math.min(width - 1, Math.max(0, x + cx - halfSide))
          const srcOff = (scy * width + scx) * 4
          const wt = weights[cy * side + cx]
          
          r += originalData[srcOff] * wt
          g += originalData[srcOff + 1] * wt
          b += originalData[srcOff + 2] * wt
        }
      }
      
      data[dstOff] = Math.min(255, Math.max(0, r))
      data[dstOff + 1] = Math.min(255, Math.max(0, g))
      data[dstOff + 2] = Math.min(255, Math.max(0, b))
    }
  }
  
  ctx.putImageData(imgData, 0, 0)
}

// Download final image
function handleDownload() {
  if (!upscaledUrl.value) return
  
  const link = document.createElement('a')
  link.href = upscaledUrl.value
  
  const origName = rawFile.value.name.substring(0, rawFile.value.name.lastIndexOf('.')) || 'image'
  const modeStr = activeMode.value === 'ai' ? 'AI_Upscale' : 'Classic_Upscale'
  link.download = `${origName}_${modeStr}_${scaleFactor.value}x.png`
  
  document.body.appendChild(link)
  link.click()
  link.remove()
  ElMessage.success('已开始下载高分辨率图片！')
}
</script>

<template>
  <div class="upscale-container">
    <div class="header-section">
      <h1 class="title">图片无损放大</h1>
      <p class="subtitle">采用 AI 超分辨率算法 (Real-ESRGAN) 与经典高性能算法双备份，纯前端计算，绝不占用服务器算力及隐私安全</p>
    </div>

    <div class="main-layout">
      <!-- Left side: Upload and Control Panel -->
      <div class="control-panel">
        <el-card class="glass-card">
          <template #header>
            <div class="card-header">
              <span>配置参数</span>
            </div>
          </template>

          <!-- Upload area -->
          <div v-if="!rawFile" class="upload-section">
            <el-upload
              drag
              action="#"
              :auto-upload="false"
              :show-file-list="false"
              accept="image/*"
              @change="handleFileChange"
              class="upload-area"
            >
              <el-icon class="upload-icon" :size="48"><UploadFilled /></el-icon>
              <div class="upload-placeholder">
                <span>将图片拖到此处，或 <em>点击上传</em></span>
                <span class="upload-hint">支持 JPG / PNG / WEBP 格式图片，建议分辨率在 1500px 以下以获得更佳的 AI 推理速度</span>
              </div>
            </el-upload>
          </div>

          <!-- File details -->
          <div v-else class="file-details">
            <div class="details-row">
              <el-icon class="file-icon" :size="24"><Picture /></el-icon>
              <div class="file-info">
                <div class="file-name">{{ rawFile.name }}</div>
                <div class="file-meta">
                  原始尺寸: {{ imageWidth }} x {{ imageHeight }} | 大小: {{ (rawFile.size / 1024 / 1024).toFixed(2) }} MB
                </div>
              </div>
              <el-button type="danger" :icon="RefreshLeft" circle @click="handleReset" :disabled="processing"></el-button>
            </div>
          </div>

          <!-- Controls config -->
          <div class="config-form" :class="{ 'disabled-form': processing }">
            <div class="form-item">
              <div class="form-label">放大倍数</div>
              <el-radio-group v-model="scaleFactor" size="large" :disabled="processing">
                <el-radio-button :value="2">2 倍放大</el-radio-button>
                <el-radio-button :value="4">4 倍放大</el-radio-button>
              </el-radio-group>
            </div>

            <div class="form-item">
              <div class="form-label">放大技术模式</div>
              <el-radio-group v-model="activeMode" size="large" :disabled="processing">
                <el-radio-button value="ai">
                  <div class="radio-label-wrap">
                    <el-icon><Cpu /></el-icon>
                    <span>AI 智能无损</span>
                  </div>
                </el-radio-button>
                <el-radio-button value="classic">
                  <div class="radio-label-wrap">
                    <el-icon><Monitor /></el-icon>
                    <span>经典插值加速</span>
                  </div>
                </el-radio-button>
              </el-radio-group>
              <div class="mode-desc">
                {{ activeMode === 'ai' 
                  ? 'AI 无损放大模式：加载智能网络模型重建丢失像素，能较好地脑补出细节与线条，适合动漫、人像、图标等，对设备性能要求较高。' 
                  : '经典插值加速模式：硬件加速的双三次插值配合锐化算法，在毫秒级内完成处理，适合大图、老旧设备或希望瞬间导出的用户。' 
                }}
              </div>
            </div>

            <!-- Processing progress -->
            <div v-if="processing" class="progress-section">
              <el-progress 
                :percentage="progress" 
                :status="progress === 100 ? 'success' : ''"
                :indeterminate="progress === 0"
                class="progress-bar"
              />
              <div class="progress-message">
                <el-icon class="is-loading"><Loading /></el-icon>
                <span>{{ progressMsg }}</span>
              </div>
            </div>

            <!-- Action buttons -->
            <div class="action-buttons">
              <el-button 
                type="primary" 
                size="large" 
                class="run-btn" 
                :loading="processing"
                :disabled="!rawFile"
                :icon="VideoPlay"
                @click="handleUpscale"
              >
                开始放大处理
              </el-button>

              <el-button 
                type="success" 
                size="large" 
                class="download-btn" 
                :disabled="!upscaledUrl || processing"
                :icon="Download"
                @click="handleDownload"
              >
                下载高分辨率图片
              </el-button>
            </div>
          </div>
        </el-card>
      </div>

      <!-- Right side: Preview Slider Section -->
      <div class="preview-panel">
        <el-card class="glass-card full-height-card">
          <template #header>
            <div class="card-header">
              <span>实时效果预览</span>
              <span v-if="upscaledUrl" class="preview-hint">左右拖拽拉条对比原图 (左) 与放大图 (右)</span>
            </div>
          </template>

          <div class="preview-area">
            <!-- No file state -->
            <div v-if="!rawFile" class="empty-preview">
              <el-icon :size="64" class="empty-icon"><Picture /></el-icon>
              <span>请在左侧上传图片进行放大处理</span>
            </div>

            <!-- Processing state but no image yet -->
            <div v-else-if="processing && !upscaledUrl" class="loading-preview">
              <el-icon :size="48" class="is-loading loading-icon"><Loading /></el-icon>
              <span>正在计算高分辨率图像，请稍候...</span>
            </div>

            <!-- Show only original if not processed yet -->
            <div v-else-if="rawFile && !upscaledUrl" class="single-preview">
              <img :src="originalUrl" class="preview-img" alt="Original" />
              <div class="preview-tag">原始图片</div>
            </div>

            <!-- Comparison slider when processed -->
            <div v-else-if="upscaledUrl" class="comparison-container">
              <img :src="upscaledUrl" class="comparison-img after-img" alt="Upscaled" />
              <div class="before-wrapper" :style="{ width: sliderPos + '%' }">
                <img :src="originalUrl" class="comparison-img before-img" alt="Original" />
              </div>
              <div class="slider-handle" :style="{ left: sliderPos + '%' }">
                <div class="handle-button">↔</div>
              </div>
              <input 
                type="range" 
                min="0" 
                max="100" 
                v-model="sliderPos" 
                class="slider-input" 
              />
              <div class="slider-label label-left">原图</div>
              <div class="slider-label label-right">{{ activeMode === 'ai' ? 'AI 放大' : '经典放大' }} ({{ scaleFactor }}x)</div>
            </div>
          </div>
        </el-card>
      </div>
    </div>
  </div>
</template>

<style scoped>
.upscale-container {
  padding: 24px;
  min-height: calc(100vh - 120px);
  color: #ffffff;
}

.header-section {
  margin-bottom: 24px;
}

.title {
  font-size: 28px;
  font-weight: 700;
  margin: 0 0 8px 0;
  background: linear-gradient(135deg, #a5b4fc 0%, #818cf8 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.subtitle {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.6);
  margin: 0;
}

.main-layout {
  display: grid;
  grid-template-columns: 420px 1fr;
  gap: 24px;
  align-items: start;
}

@media (max-width: 1024px) {
  .main-layout {
    grid-template-columns: 1fr;
  }
}

.glass-card {
  background: rgba(22, 22, 42, 0.6) !important;
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.08) !important;
  border-radius: 16px !important;
}

.glass-card :deep(.el-card__header) {
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  padding: 16px 20px;
}

.glass-card :deep(.el-card__body) {
  padding: 20px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 16px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.9);
}

/* Upload Area */
.upload-section {
  margin-bottom: 20px;
}

.upload-area :deep(.el-upload) {
  width: 100%;
}

.upload-area :deep(.el-upload-dragger) {
  background: rgba(255, 255, 255, 0.02) !important;
  border: 1px dashed rgba(255, 255, 255, 0.15) !important;
  border-radius: 12px;
  transition: all 0.3s;
  padding: 30px 20px;
}

.upload-area :deep(.el-upload-dragger:hover) {
  border-color: #818cf8 !important;
  background: rgba(129, 140, 248, 0.05) !important;
}

.upload-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  color: rgba(255, 255, 255, 0.8);
  font-size: 14px;
}

.upload-icon {
  color: rgba(255, 255, 255, 0.35);
}

.upload-area :deep(.el-upload-dragger:hover) .upload-icon {
  color: #818cf8;
}

.upload-hint {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
  line-height: 1.5;
  text-align: center;
  max-width: 300px;
}

/* File Details */
.file-details {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 12px;
  padding: 14px;
  margin-bottom: 20px;
}

.details-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.file-icon {
  color: #818cf8;
}

.file-info {
  flex: 1;
  min-width: 0;
}

.file-name {
  font-size: 14px;
  font-weight: 500;
  color: #ffffff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-meta {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
  margin-top: 3px;
}

/* Config Form */
.config-form {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.disabled-form {
  pointer-events: none;
  opacity: 0.6;
}

.form-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.form-label {
  font-size: 13px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.7);
}

.radio-label-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
}

.mode-desc {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.45);
  line-height: 1.5;
  margin-top: 4px;
  background: rgba(255, 255, 255, 0.01);
  padding: 10px;
  border-radius: 8px;
}

/* Progress Wrap */
.progress-section {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 12px;
  padding: 14px;
}

.progress-bar :deep(.el-progress-bar__runway) {
  background-color: rgba(255, 255, 255, 0.08) !important;
}

.progress-message {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 12px;
  color: #a5b4fc;
  margin-top: 10px;
}

/* Buttons */
.action-buttons {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 8px;
}

.run-btn, .download-btn {
  width: 100% !important;
  margin: 0 !important;
  height: 44px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  position: relative;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
}

.run-btn :deep(.el-icon), .download-btn :deep(.el-icon) {
  position: absolute !important;
  left: 20px !important;
  margin: 0 !important;
  font-size: 16px !important;
}

.run-btn {
  background: linear-gradient(135deg, #818cf8 0%, #6366f1 100%) !important;
  border: none !important;
}

.run-btn:hover {
  background: linear-gradient(135deg, #93c5fd 0%, #818cf8 100%) !important;
}

/* Preview Panel */
.full-height-card {
  height: 100%;
  min-height: 520px;
  display: flex;
  flex-direction: column;
}

.full-height-card :deep(.el-card__body) {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.preview-area {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.2);
  border: 1px dashed rgba(255, 255, 255, 0.06);
  border-radius: 12px;
  min-height: 400px;
  position: relative;
  overflow: hidden;
}

.empty-preview, .loading-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: rgba(255, 255, 255, 0.4);
  font-size: 14px;
}

.empty-icon, .loading-icon {
  color: rgba(255, 255, 255, 0.2);
}

.single-preview {
  position: relative;
  max-width: 90%;
  max-height: 90%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.preview-img {
  max-width: 100%;
  max-height: 380px;
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
}

.preview-tag {
  position: absolute;
  bottom: 12px;
  left: 12px;
  background: rgba(0, 0, 0, 0.7);
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 11px;
  color: #ffffff;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

/* Image comparison slider */
.comparison-container {
  width: 100%;
  height: 100%;
  min-height: 400px;
  position: relative;
  user-select: none;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

.comparison-img {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: auto;
  height: auto;
  max-width: 90%;
  max-height: 90%;
  border-radius: 8px;
  pointer-events: none;
  display: block;
  object-fit: contain;
}

.before-wrapper {
  position: absolute;
  top: 5%;
  bottom: 5%;
  left: 5%;
  width: 50%;
  overflow: hidden;
  border-top-left-radius: 8px;
  border-bottom-left-radius: 8px;
  /* Matches original aspect ratio placement */
  display: flex;
  align-items: center;
  justify-content: flex-start;
}

/* Force before img to maintain the exact same dimensions and center offset as the base after img */
.before-img {
  position: absolute;
  left: 50vw; /* Trick to align it over the after-img */
  transform: translate(-50vw, -50%); /* Use Javascript to calculate center or style dynamically */
}

/* Better responsive setup for comparative slider: absolute elements inside container */
.comparison-container {
  width: 100%;
  height: 100%;
  max-width: 600px;
  max-height: 400px;
  aspect-ratio: 4 / 3;
  margin: auto;
}

.comparison-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  border-radius: 8px;
  position: absolute;
  top: 0;
  left: 0;
  transform: none;
  max-width: 100%;
  max-height: 100%;
}

.before-wrapper {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  overflow: hidden;
  border-radius: 8px 0 0 8px;
  z-index: 10;
}

.before-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  max-width: none;
  /* Width of before image must equal parent comparison-container width so it stays aligned */
  width: 600px; /* Overwritten dynamically if needed, or matched using CSS container queries */
  height: 100%;
}

/* Slider input overlays everything */
.slider-input {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: ew-resize;
  z-index: 30;
  margin: 0;
}

.slider-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: #ffffff;
  z-index: 20;
  pointer-events: none;
  box-shadow: 0 0 10px rgba(0, 0, 0, 0.5);
}

.handle-button {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 32px;
  height: 32px;
  background: #ffffff;
  color: #16162a;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: bold;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  font-size: 14px;
}

.slider-label {
  position: absolute;
  bottom: 12px;
  background: rgba(0, 0, 0, 0.7);
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 11px;
  color: #ffffff;
  border: 1px solid rgba(255, 255, 255, 0.1);
  z-index: 25;
}

.label-left {
  left: 12px;
}

.label-right {
  right: 12px;
}

.preview-hint {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
  font-weight: normal;
}
</style>

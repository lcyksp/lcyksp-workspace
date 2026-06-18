<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { UploadFilled, Download, Refresh, Connection, Crop, Picture, Aim } from '@element-plus/icons-vue'

// Basic States
const imageSrc = ref('')
const originalImage = ref(null)
const loading = ref(false)
const mode = ref('chroma') // 'chroma' (color replacement) or 'ai' (mediapipe segmentation)

// Canvas Refs
const sourceCanvas = document.createElement('canvas')
const tempCanvas = document.createElement('canvas')
const previewCanvas = ref(null)

const isEyedropperActive = ref(false)

// Chroma Key settings
const targetBgColor = ref({ r: 255, g: 255, b: 255 }) // Sampled color to replace
const newBgColor = ref('#4186f5') // Replacement color (default: Blue)
const tolerance = ref(45)
const feather = ref(15)

// Standard ID Photo Dimensions (DPI 300)
const sizes = [
  { label: '一寸 (25*35mm)', width: 295, height: 413 },
  { label: '大一寸 (33*48mm)', width: 390, height: 567 },
  { label: '二寸 (35*49mm)', width: 413, height: 579 },
  { label: '大二寸 (35*53mm)', width: 413, height: 626 },
  { label: '教师资格证 (295*413)', width: 295, height: 413 },
  { label: '国考/公务员 (354*472)', width: 354, height: 472 },
]
const selectedSizeIndex = ref(0)
const selectedSize = computed(() => sizes[selectedSizeIndex.value])

// Interactive Drag & Zoom settings
const scale = ref(1)
const offset = ref({ x: 0, y: 0 })
const isDragging = ref(false)
const dragStart = ref({ x: 0, y: 0 })

// UI Guide Overlay
const showGuide = ref(true)

// AI Model Loaded state
const aiLoaded = ref(false)
const aiLoading = ref(false)
let selfieSegmentation = null

onMounted(() => {
  // Setup window size resize listener to redraw if needed
  window.addEventListener('resize', drawPreview)
})

watch([newBgColor, tolerance, feather, mode, selectedSizeIndex, scale, offset], () => {
  if (originalImage.value) {
    drawPreview()
  }
}, { deep: true })

// 1. Handle File Upload
function handleFileChange(file) {
  const rawFile = file.raw || file
  if (!rawFile.type.startsWith('image/')) {
    ElMessage.error('请上传格式正确的图片文件！')
    return
  }
  
  loading.value = true
  const reader = new FileReader()
  reader.onload = (e) => {
    const img = new Image()
    img.onload = () => {
      originalImage.value = img
      imageSrc.value = e.target.result
      
      // Auto-scale to fit initial size
      resetTransform()
      
      // Auto-sample top-left corner color for chroma key
      sampleTopLeftColor()
      
      drawPreview()
      loading.value = false
    }
    img.onerror = () => {
      loading.value = false
      ElMessage.error('图片加载失败！')
    }
    img.src = e.target.result
  }
  reader.readAsDataURL(rawFile)
}

function resetTransform() {
  scale.value = 1
  offset.value = { x: 0, y: 0 }
}

// 2. Sample target background color (auto or click)
function sampleTopLeftColor() {
  if (!originalImage.value) return
  
  const canvas = sourceCanvas
  canvas.width = originalImage.value.naturalWidth
  canvas.height = originalImage.value.naturalHeight
  const ctx = canvas.getContext('2d')
  ctx.drawImage(originalImage.value, 0, 0)
  
  // Sample top-left corner (x=5, y=5)
  const pixel = ctx.getImageData(5, 5, 1, 1).data
  targetBgColor.value = {
    r: pixel[0],
    g: pixel[1],
    b: pixel[2]
  }
}

// Click on canvas to sample color
function handleCanvasClick(e) {
  if (mode.value !== 'chroma' || !originalImage.value || !previewCanvas.value) return
  if (!isEyedropperActive.value) return
  
  const canvas = previewCanvas.value
  const rect = canvas.getBoundingClientRect()
  
  // Convert click coordinates to canvas pixel space
  const clickX = e.clientX - rect.left
  const clickY = e.clientY - rect.top
  
  const renderWidth = canvas.width
  const renderHeight = canvas.height
  
  // Draw current processed image to sample color
  const ctx = canvas.getContext('2d')
  try {
    const pixel = ctx.getImageData(clickX, clickY, 1, 1).data
    // Only sample if the pixel is not transparent
    if (pixel[3] > 10) {
      targetBgColor.value = { r: pixel[0], g: pixel[1], b: pixel[2] }
      isEyedropperActive.value = false // Auto deactivate
      ElMessage.success(`成功采样背景色: RGB(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`)
      drawPreview()
    }
  } catch (err) {
    console.error('Failed to sample color:', err)
  }
}

// 3. Load MediaPipe Selfie Segmentation
async function initAISegmentation() {
  if (aiLoaded.value) return true
  aiLoading.value = true
  
  try {
    await new Promise((resolve, reject) => {
      if (window.SelfieSegmentation) return resolve()
      const script = document.createElement('script')
      script.src = 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_segmentation.js'
      script.onload = resolve
      script.onerror = reject
      document.head.appendChild(script)
    })
    
    selfieSegmentation = new window.SelfieSegmentation({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`
    })
    
    selfieSegmentation.setOptions({
      modelSelection: 1, // 1 for landscape (faster/lighter)
    })
    
    aiLoaded.value = true
    aiLoading.value = false
    return true
  } catch (err) {
    console.error('Failed to load MediaPipe:', err)
    aiLoading.value = false
    ElMessage.error('AI 抠图模型加载失败，请检查网络（正在使用 JSdelivr CDN）。你可以切回传统色彩替换模式。')
    mode.value = 'chroma'
    return false
  }
}

// Watch mode changes to load AI if selected
watch(mode, async (newMode) => {
  if (newMode === 'ai') {
    const ok = await initAISegmentation()
    if (ok && originalImage.value) {
      drawPreview()
    }
  }
})

// Hex to RGB Helper
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 65, g: 134, b: 245 }
}

// 4. Drawing Logic
async function drawPreview() {
  if (!originalImage.value || !previewCanvas.value) return
  
  const canvas = previewCanvas.value
  const ctx = canvas.getContext('2d')
  
  // Set dimensions based on standard size
  const targetW = selectedSize.value.width
  const targetH = selectedSize.value.height
  canvas.width = targetW
  canvas.height = targetH
  
  // Fill replacement background color
  ctx.fillStyle = newBgColor.value
  ctx.fillRect(0, 0, targetW, targetH)
  
  // Draw segmented person image to temporary canvas
  const imgW = originalImage.value.naturalWidth
  const imgH = originalImage.value.naturalHeight
  
  tempCanvas.width = imgW
  tempCanvas.height = imgH
  const tempCtx = tempCanvas.getContext('2d')
  tempCtx.drawImage(originalImage.value, 0, 0)
  
  if (mode.value === 'chroma') {
    // ---------------- Chroma Key Mode ----------------
    const imgData = tempCtx.getImageData(0, 0, imgW, imgH)
    const data = imgData.data
    const target = targetBgColor.value
    const tol = tolerance.value
    const fth = feather.value
    
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]
      const g = data[i+1]
      const b = data[i+2]
      
      // Calculate color distance (L1 distance is fast and sufficient)
      const dist = Math.abs(r - target.r) + Math.abs(g - target.g) + Math.abs(b - target.b)
      
      if (dist < tol) {
        // Transparent (replaced by Nbg color)
        data[i+3] = 0
      } else if (dist < tol + fth) {
        // Alpha blend edge feathering
        const ratio = (dist - tol) / fth
        data[i+3] = Math.round(ratio * 255)
      }
    }
    tempCtx.putImageData(imgData, 0, 0)
    
    // Now draw processed image on top of replacement background
    drawTransformedImage(ctx, tempCanvas, targetW, targetH)
  } else if (mode.value === 'ai' && aiLoaded.value) {
    // ---------------- AI Segmentation Mode ----------------
    // Using MediaPipe SelfieSegmentation
    try {
      selfieSegmentation.onResults((results) => {
        // Draw mask on temp canvas
        tempCtx.clearRect(0, 0, imgW, imgH)
        tempCtx.drawImage(results.image, 0, 0)
        
        // Use destination-in to apply segmentation mask
        tempCtx.globalCompositeOperation = 'destination-in'
        tempCtx.drawImage(results.segmentationMask, 0, 0)
        tempCtx.globalCompositeOperation = 'source-over'
        
        // Draw the result to main preview canvas
        ctx.fillStyle = newBgColor.value
        ctx.fillRect(0, 0, targetW, targetH)
        drawTransformedImage(ctx, tempCanvas, targetW, targetH)
      })
      
      await selfieSegmentation.send({ image: originalImage.value })
    } catch (err) {
      console.error('AI segmentation process error:', err)
    }
  }
}

// Draw the person canvas applying zoom and offsets
function drawTransformedImage(ctx, imgCanvas, targetW, targetH) {
  const imgW = imgCanvas.width
  const imgH = imgCanvas.height
  
  // Calculate size to fit crop area
  const scaleFit = Math.min(targetW / imgW, targetH / imgH)
  const drawW = imgW * scaleFit * scale.value
  const drawH = imgH * scaleFit * scale.value
  
  // Center by default + user drag offset
  const x = (targetW - drawW) / 2 + offset.value.x
  const y = (targetH - drawH) / 2 + offset.value.y
  
  ctx.drawImage(imgCanvas, x, y, drawW, drawH)
}

// 5. Drag & Zoom Event Handlers
function startDrag(e) {
  if (!originalImage.value) return
  isDragging.value = true
  dragStart.value = {
    x: e.clientX - offset.value.x,
    y: e.clientY - offset.value.y
  }
}

function onDrag(e) {
  if (!isDragging.value) return
  offset.value = {
    x: e.clientX - dragStart.value.x,
    y: e.clientY - dragStart.value.y
  }
}

function stopDrag() {
  isDragging.value = false
}

// 6. Export and Download File
function downloadResult() {
  if (!originalImage.value || !previewCanvas.value) return
  
  const canvas = previewCanvas.value
  const mimeType = 'image/jpeg'
  const quality = 0.95
  
  // Convert to Blob for download
  canvas.toBlob((blob) => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    
    // Custom name with specs
    const name = `证件照_${selectedSize.value.width}x${selectedSize.value.height}_${Date.now()}.jpg`
    a.download = name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    ElMessage.success('证件照已成功下载！')
  }, mimeType, quality)
}
</script>

<template>
  <div class="id-photo-view">
    <div class="page-header">
      <h2 class="page-title"><span class="title-icon">📷</span> 智能证件照换底与裁剪</h2>
      <p class="page-desc">直接在浏览器中制作符合规范的证件照，支持传统背景替换与 AI 一键抠图，智能适配一寸、二寸等标准冲印规格。</p>
    </div>

    <!-- 上传区域 -->
    <div v-if="!imageSrc" class="upload-card theme-surface">
      <el-upload
        class="upload-area"
        drag
        action="#"
        :auto-upload="false"
        :show-file-list="false"
        :on-change="handleFileChange"
      >
        <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
        <div class="el-upload__text">
          拖拽普通照片或证件照到此处，或 <em>点击上传</em>
        </div>
        <template #tip>
          <div class="el-upload__tip text-center">
            支持 JPG, PNG 格式，建议上传正面、五官清晰、肩膀平齐的肖像照片。
          </div>
        </template>
      </el-upload>
    </div>

    <el-row v-else :gutter="20" class="layout-row" v-loading="loading || aiLoading">
      <!-- 控制台卡片 -->
      <el-col :xs="24" :md="10" class="ctrl-col">
        <div class="col-wrap">
          <div class="ctrl-card theme-surface">
            <h3 class="section-title">参数调整面板</h3>
            
            <!-- 模式选择 -->
            <div class="ctrl-item">
              <span class="ctrl-label">抠图模式</span>
              <el-radio-group v-model="mode" size="default" class="w-100">
                <el-radio-button value="chroma">传统色彩替换</el-radio-button>
                <el-radio-button value="ai">AI 智能人像抠图</el-radio-button>
              </el-radio-group>
            </div>

            <!-- 目标背景色 -->
            <div class="ctrl-item">
              <span class="ctrl-label">换底颜色</span>
              <div class="color-presets">
                <button 
                  type="button" 
                  class="color-dot bg-blue" 
                  :class="{ active: newBgColor === '#4186f5' }"
                  @click="newBgColor = '#4186f5'"
                  title="标准蓝底"
                ></button>
                <button 
                  type="button" 
                  class="color-dot bg-white" 
                  :class="{ active: newBgColor === '#ffffff' }"
                  @click="newBgColor = '#ffffff'"
                  title="标准白底"
                ></button>
                <button 
                  type="button" 
                  class="color-dot bg-red" 
                  :class="{ active: newBgColor === '#ff0000' }"
                  @click="newBgColor = '#ff0000'"
                  title="标准红底"
                ></button>
                <div class="color-picker-wrap">
                  <el-color-picker v-model="newBgColor" size="small" />
                  <span class="picker-txt">自定义</span>
                </div>
              </div>
            </div>

            <!-- 标准尺寸 -->
            <div class="ctrl-item">
              <span class="ctrl-label">输出尺寸规格</span>
              <el-select v-model="selectedSizeIndex" placeholder="请选择规格" class="w-100">
                <el-option
                  v-for="(size, index) in sizes"
                  :key="index"
                  :label="size.label"
                  :value="index"
                />
              </el-select>
            </div>

            <!-- 色彩替换特有参数 -->
            <template v-if="mode === 'chroma'">
              <div class="divider"></div>
              
              <div class="ctrl-item">
                <span class="ctrl-label">背景色容差 (Tolerance)</span>
                <el-slider v-model="tolerance" :min="10" :max="150" />
                <span class="sub-tip">控制颜色匹配范围。值越大，替换的颜色越多。</span>
              </div>

              <div class="ctrl-item">
                <span class="ctrl-label">边缘羽化 (Feathering)</span>
                <el-slider v-model="feather" :min="0" :max="50" />
                <span class="sub-tip">柔化人像边缘。值越大，过渡越平滑。</span>
              </div>
              
              <div class="ctrl-item">
                <span class="ctrl-label">手动背景取色</span>
                <el-button 
                  :type="isEyedropperActive ? 'primary' : 'default'" 
                  :icon="Aim"
                  class="w-100"
                  @click="isEyedropperActive = !isEyedropperActive"
                >
                  {{ isEyedropperActive ? '请在右侧图中点击背景取色...' : '开启吸管取色' }}
                </el-button>
                <span class="sub-tip">点击开启后，可在右侧预览图上点击需要被替换的背景颜色。再次点击可关闭。</span>
              </div>
            </template>

            <!-- 缩放与位置微调 -->
            <div class="divider"></div>

            <div class="ctrl-item">
              <span class="ctrl-label">人像缩放比例</span>
              <el-slider v-model="scale" :min="0.5" :max="2.5" :step="0.05" />
            </div>

            <div class="ctrl-item check-group">
              <el-checkbox v-model="showGuide">显示人脸对齐辅助线</el-checkbox>
            </div>

            <!-- 底部主要操作 -->
            <div class="action-buttons">
              <el-button 
                type="success" 
                :icon="Download"
                size="large"
                class="action-btn"
                @click="downloadResult"
              >
                生成并下载证件照
              </el-button>
              
              <el-button 
                type="info" 
                :icon="Refresh"
                size="large"
                class="action-btn"
                @click="resetTransform"
              >
                重置位置与缩放
              </el-button>

              <el-upload
                action="#"
                :auto-upload="false"
                :show-file-list="false"
                :on-change="handleFileChange"
                class="w-100"
              >
                <el-button type="default" size="default" :icon="Picture" class="w-100 mt-10">
                  重新上传图片
                </el-button>
              </el-upload>
            </div>
          </div>
        </div>
      </el-col>

      <!-- 预览与对齐调整卡片 -->
      <el-col :xs="24" :md="14" class="preview-col">
        <div class="col-wrap">
          <div class="preview-card theme-surface">
            <h3 class="section-title">对齐与裁剪区</h3>
            <div class="canvas-outer-container">
              <p class="drag-hint">💡 鼠标按住可以拖动，使用滑块可以缩放</p>
              <div 
                class="canvas-view-container"
                @mousedown="startDrag"
                @mousemove="onDrag"
                @mouseup="stopDrag"
                @mouseleave="stopDrag"
              >
                <!-- Canvas -->
                <canvas 
                  ref="previewCanvas" 
                  class="preview-canvas"
                  :class="{ 'eyedropper-active': isEyedropperActive }"
                  @click="handleCanvasClick"
                ></canvas>

                <!-- SVG Guide Overlay -->
                <svg v-if="showGuide" class="guide-overlay" viewBox="0 0 100 140" preserveAspectRatio="none">
                  <!-- Head Top Line -->
                  <line x1="10" y1="20" x2="90" y2="20" stroke="rgba(231, 76, 60, 0.7)" stroke-width="0.8" stroke-dasharray="2" />
                  <!-- Eye Line -->
                  <line x1="10" y1="52" x2="90" y2="52" stroke="rgba(52, 152, 219, 0.7)" stroke-width="0.8" stroke-dasharray="2" />
                  <!-- Chin Line -->
                  <line x1="10" y1="95" x2="90" y2="95" stroke="rgba(46, 204, 113, 0.7)" stroke-width="0.8" stroke-dasharray="2" />
                  
                  <!-- Face Oval -->
                  <ellipse cx="50" cy="56" rx="22" ry="32" fill="none" stroke="rgba(241, 196, 15, 0.6)" stroke-width="0.8" />
                  <!-- Center axis line -->
                  <line x1="50" y1="5" x2="50" y2="135" stroke="rgba(241, 196, 15, 0.4)" stroke-width="0.5" stroke-dasharray="4" />
                  
                  <!-- Guide Texts -->
                  <text x="5" y="18" fill="rgba(231, 76, 60, 0.9)" font-size="3.5">头顶线</text>
                  <text x="5" y="50" fill="rgba(52, 152, 219, 0.9)" font-size="3.5">眼睛对齐线</text>
                  <text x="5" y="93" fill="rgba(46, 204, 113, 0.9)" font-size="3.5">下巴对齐线</text>
                </svg>
              </div>
            </div>
          </div>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.id-photo-view {
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
  line-height: 1.5;
}

.upload-card {
  border: 1px solid var(--border-color);
  border-radius: 16px;
  padding: 40px;
  display: flex;
  justify-content: center;
}

.upload-area {
  width: 100%;
  max-width: 600px;
}

:deep(.el-upload-dragger) {
  background: var(--bg-ctrl);
  border: 2px dashed var(--border-color);
  border-radius: 12px;
  padding: 40px 20px;
  transition: border-color 0.25s ease;
}

:deep(.el-upload-dragger:hover) {
  border-color: var(--accent-blue);
}

.layout-row {
  margin-bottom: 20px;
}

.col-wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.ctrl-card,
.preview-card {
  border: 1px solid var(--border-color);
  border-radius: 16px;
  padding: 24px;
  display: flex;
  flex-direction: column;
}

.ctrl-card {
  gap: 16px;
}

.section-title {
  margin: 0 0 10px;
  font-size: 1.1rem;
  font-weight: 500;
  color: var(--text-heading);
  border-left: 4px solid var(--accent-blue);
  padding-left: 10px;
  line-height: 1.2;
}

.divider {
  height: 1px;
  background: var(--border-color);
  margin: 4px 0;
}

.w-100 { width: 100%; }
.mt-10 { margin-top: 10px; }

.ctrl-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ctrl-label {
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--text-secondary);
}

.sub-tip {
  font-size: 0.72rem;
  color: var(--text-muted);
  line-height: 1.3;
}

.check-group {
  flex-direction: row;
  align-items: center;
}

/* Color Presets */
.color-presets {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
}

.color-dot {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  transition: all 0.2s ease;
  box-shadow: inset 0 0 2px rgba(0,0,0,0.2);
}

.color-dot:hover {
  transform: scale(1.1);
}

.color-dot.active {
  border-color: var(--accent-blue);
  transform: scale(1.08);
}

.bg-blue { background-color: #4186f5; }
.bg-white { background-color: #ffffff; border: 1px solid #ddd; }
.bg-red { background-color: #ff0000; }

.color-picker-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 8px;
}

.picker-txt {
  font-size: 0.78rem;
  color: var(--text-secondary);
}

.sample-notice {
  display: flex;
  gap: 8px;
  background: color-mix(in srgb, var(--accent-blue) 8%, var(--bg-ctrl));
  border: 1px solid color-mix(in srgb, var(--accent-blue) 18%, var(--border-subtle));
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 0.76rem;
  color: var(--text-secondary);
  line-height: 1.4;
}

.sample-notice .el-icon {
  font-size: 1rem;
  color: var(--accent-blue);
  flex-shrink: 0;
}

/* Actions */
.action-buttons {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 10px;
}

.action-btn {
  width: 100%;
  margin-left: 0 !important;
}

/* Canvas View Area */
.canvas-outer-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--bg-canvas);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 24px;
  min-height: 440px;
  position: relative;
}

.drag-hint {
  font-size: 0.78rem;
  color: var(--text-muted);
  margin: 0 0 12px;
}

.canvas-view-container {
  position: relative;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.15);
  border-radius: 4px;
  overflow: hidden;
  cursor: grab;
  /* Fixed display aspect ratio based on active dimension */
  display: flex;
  align-items: center;
  justify-content: center;
}

.canvas-view-container:active {
  cursor: grabbing;
}

.preview-canvas {
  max-width: 100%;
  max-height: 380px;
  display: block;
}

.preview-canvas.eyedropper-active {
  cursor: crosshair !important;
}

.action-buttons :deep(.el-upload) {
  width: 100%;
}

.action-buttons :deep(.el-button) {
  margin-left: 0 !important;
}

.guide-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  font-family: inherit;
}

@media (max-width: 768px) {
  .layout-row {
    display: flex;
    flex-direction: column;
  }
  
  .preview-col {
    order: -1;
    margin-bottom: 16px;
  }
  
  .id-photo-view {
    padding: 12px 10px 24px;
  }
  
  .ctrl-card,
  .preview-card {
    padding: 16px;
  }
  
  .canvas-outer-container {
    min-height: 300px;
    padding: 16px;
  }
  
  .preview-canvas {
    max-height: 280px;
  }
  
  .upload-card {
    padding: 20px 10px;
  }
  
  :deep(.el-upload-dragger) {
    padding: 24px 12px;
  }
}
</style>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { UploadFilled, Download, Refresh, Picture } from '@element-plus/icons-vue'

// Basic States
const imageSrc = ref('')
const originalImage = ref(null)
const previewCanvas = ref(null)
const loading = ref(false)

// Watermark Settings
const watermarkType = ref('text') // 'text' or 'image'
const arrangement = ref('tiled') // 'tiled' (平铺) or 'single' (单点)

// Text Watermark Settings
const watermarkText = ref('仅用于身份验证')
const fontSize = ref(36)
const textColor = ref('#ffffff')
const isBold = ref(false)
const isItalic = ref(false)
const fontFamily = ref('sans-serif')

const fontFamilies = [
  { label: '系统默认', value: 'sans-serif' },
  { label: '微软雅黑', value: '"Microsoft YaHei", sans-serif' },
  { label: '宋体', value: 'SimSun, serif' },
  { label: '黑体', value: 'SimHei, sans-serif' },
  { label: 'Arial', value: 'Arial, sans-serif' },
  { label: 'Times New Roman', value: '"Times New Roman", serif' },
  { label: 'Courier New (等宽)', value: '"Courier New", monospace' }
]

// Image Watermark Settings
const watermarkImageSrc = ref('')
const watermarkImageElement = ref(null)
const watermarkImgScale = ref(0.2) // scale relative to original image width/height

// Layout Settings - Tiled
const rowGap = ref(120)
const columnGap = ref(120)

// Layout Settings - Single
const alignH = ref('center') // 'left', 'center', 'right'
const alignV = ref('center') // 'top', 'center', 'bottom'
const offsetX = ref(20)
const offsetY = ref(20)

// Transform Settings
const angle = ref(-30) // -180 to 180
const opacity = ref(0.3) // 0.05 to 1.0

// Trigger redraw when settings change
watch(
  [
    watermarkType, arrangement, watermarkText, fontSize, textColor,
    isBold, isItalic, fontFamily, watermarkImageSrc, watermarkImgScale,
    rowGap, columnGap, alignH, alignV, offsetX, offsetY, angle, opacity
  ],
  () => {
    if (originalImage.value) {
      drawPreview()
    }
  },
  { deep: true }
)

// Handle main image upload
function handleFileChange(file) {
  const rawFile = file.raw || file
  if (!rawFile.type.startsWith('image/')) {
    ElMessage.error('请上传图片文件！')
    return
  }
  
  loading.value = true
  const reader = new FileReader()
  reader.onload = (e) => {
    const img = new Image()
    img.onload = () => {
      originalImage.value = img
      imageSrc.value = e.target.result
      
      // Dynamic adjustments based on image size
      const maxDim = Math.max(img.naturalWidth, img.naturalHeight)
      fontSize.value = Math.round(maxDim / 30) // auto font size
      rowGap.value = Math.round(maxDim / 10)
      columnGap.value = Math.round(maxDim / 10)
      
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

// Handle watermark image upload
function handleWatermarkImageChange(file) {
  const rawFile = file.raw || file
  if (!rawFile.type.startsWith('image/')) {
    ElMessage.error('请上传图片文件作为水印！')
    return
  }
  
  const reader = new FileReader()
  reader.onload = (e) => {
    const img = new Image()
    img.onload = () => {
      watermarkImageElement.value = img
      watermarkImageSrc.value = e.target.result
      drawPreview()
    }
    img.onerror = () => {
      ElMessage.error('水印图片加载失败！')
    }
    img.src = e.target.result
  }
  reader.readAsDataURL(rawFile)
}

// Render Watermark Helper
function renderCanvasContent(ctx, canvasW, canvasH, scaleFactor) {
  // Draw base image
  ctx.drawImage(originalImage.value, 0, 0, canvasW, canvasH)
  
  // Set opacity
  ctx.globalAlpha = opacity.value
  
  // Prepare style for text
  if (watermarkType.value === 'text') {
    const size = Math.round(fontSize.value * scaleFactor)
    const fontStr = `${isItalic.value ? 'italic ' : ''}${isBold.value ? 'bold ' : ''}${size}px ${fontFamily.value}`
    ctx.font = fontStr
    ctx.fillStyle = textColor.value
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
  }
  
  // Arrangement logic
  if (arrangement.value === 'tiled') {
    drawTiled(ctx, canvasW, canvasH, scaleFactor)
  } else {
    drawSingle(ctx, canvasW, canvasH, scaleFactor)
  }
  
  // Restore opacity
  ctx.globalAlpha = 1.0
}

// Draw Tiled Watermark
function drawTiled(ctx, canvasW, canvasH, scaleFactor) {
  const angleRad = (angle.value * Math.PI) / 180
  
  ctx.save()
  // Translate to center to rotate
  ctx.translate(canvasW / 2, canvasH / 2)
  ctx.rotate(angleRad)
  
  // Bounding box of rotated canvas
  const absCos = Math.abs(Math.cos(angleRad))
  const absSin = Math.abs(Math.sin(angleRad))
  const boundW = canvasW * absCos + canvasH * absSin
  const boundH = canvasW * absSin + canvasH * absCos
  
  const hGap = Math.round(columnGap.value * scaleFactor)
  const vGap = Math.round(rowGap.value * scaleFactor)
  
  let itemW = 0
  let itemH = 0
  
  if (watermarkType.value === 'text') {
    const textMetrics = ctx.measureText(watermarkText.value)
    itemW = textMetrics.width
    itemH = Math.round(fontSize.value * scaleFactor)
  } else if (watermarkType.value === 'image' && watermarkImageElement.value) {
    const imgW = watermarkImageElement.value.naturalWidth
    const imgH = watermarkImageElement.value.naturalHeight
    const scale = watermarkImgScale.value
    itemW = imgW * scale * scaleFactor
    itemH = imgH * scale * scaleFactor
  } else {
    ctx.restore()
    return
  }
  
  const stepX = itemW + hGap
  const stepY = itemH + vGap
  
  const startX = -boundW / 2 - stepX
  const endX = boundW / 2 + stepX
  const startY = -boundH / 2 - stepY
  const endY = boundH / 2 + stepY
  
  for (let x = startX; x < endX; x += stepX) {
    for (let y = startY; y < endY; y += stepY) {
      if (watermarkType.value === 'text') {
        ctx.fillText(watermarkText.value, x, y)
      } else {
        ctx.drawImage(watermarkImageElement.value, x - itemW / 2, y - itemH / 2, itemW, itemH)
      }
    }
  }
  
  ctx.restore()
}

// Draw Single Watermark
function drawSingle(ctx, canvasW, canvasH, scaleFactor) {
  const angleRad = (angle.value * Math.PI) / 180
  
  let itemW = 0
  let itemH = 0
  
  if (watermarkType.value === 'text') {
    const textMetrics = ctx.measureText(watermarkText.value)
    itemW = textMetrics.width
    itemH = Math.round(fontSize.value * scaleFactor)
  } else if (watermarkType.value === 'image' && watermarkImageElement.value) {
    const imgW = watermarkImageElement.value.naturalWidth
    const imgH = watermarkImageElement.value.naturalHeight
    const scale = watermarkImgScale.value
    itemW = imgW * scale * scaleFactor
    itemH = imgH * scale * scaleFactor
  } else {
    return
  }
  
  let x = 0
  let y = 0
  
  // Horizontal alignment calculation
  if (alignH.value === 'left') {
    x = itemW / 2 + Math.round(offsetX.value * scaleFactor)
  } else if (alignH.value === 'center') {
    x = canvasW / 2 + Math.round(offsetX.value * scaleFactor)
  } else if (alignH.value === 'right') {
    x = canvasW - itemW / 2 - Math.round(offsetX.value * scaleFactor)
  }
  
  // Vertical alignment calculation
  if (alignV.value === 'top') {
    y = itemH / 2 + Math.round(offsetY.value * scaleFactor)
  } else if (alignV.value === 'center') {
    y = canvasH / 2 + Math.round(offsetY.value * scaleFactor)
  } else if (alignV.value === 'bottom') {
    y = canvasH - itemH / 2 - Math.round(offsetY.value * scaleFactor)
  }
  
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angleRad)
  
  if (watermarkType.value === 'text') {
    ctx.fillText(watermarkText.value, 0, 0)
  } else {
    ctx.drawImage(watermarkImageElement.value, -itemW / 2, -itemH / 2, itemW, itemH)
  }
  
  ctx.restore()
}

// Draw preview on screen canvas
function drawPreview() {
  if (!originalImage.value || !previewCanvas.value) return
  
  const canvas = previewCanvas.value
  const ctx = canvas.getContext('2d')
  
  // Max dimension for preview canvas is 1200px to ensure good real-time performance
  const originalW = originalImage.value.naturalWidth
  const originalH = originalImage.value.naturalHeight
  const previewScale = Math.min(1, 1200 / Math.max(originalW, originalH))
  
  const canvasW = Math.round(originalW * previewScale)
  const canvasH = Math.round(originalH * previewScale)
  
  canvas.width = canvasW
  canvas.height = canvasH
  
  renderCanvasContent(ctx, canvasW, canvasH, previewScale)
}

// Download high-res watermarked image
function downloadResult() {
  if (!originalImage.value) return
  
  loading.value = true
  ElMessage.info('正在生成高清无损图片，请稍候...')
  
  setTimeout(() => {
    try {
      const exportCanvas = document.createElement('canvas')
      const originalW = originalImage.value.naturalWidth
      const originalH = originalImage.value.naturalHeight
      
      exportCanvas.width = originalW
      exportCanvas.height = originalH
      
      const ctx = exportCanvas.getContext('2d')
      
      // Draw at 1.0 full scale factor
      renderCanvasContent(ctx, originalW, originalH, 1.0)
      
      const mimeType = 'image/jpeg'
      const quality = 0.95
      
      exportCanvas.toBlob((blob) => {
        if (!blob) {
          ElMessage.error('生成图片失败！')
          loading.value = false
          return
        }
        
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `watermarked_${Date.now()}.jpg`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
        
        loading.value = false
        ElMessage.success('高清图片已成功生成并下载！')
      }, mimeType, quality)
      
    } catch (err) {
      console.error(err)
      loading.value = false
      ElMessage.error('导出图片出错！')
    }
  }, 100)
}

function resetImage() {
  imageSrc.value = ''
  originalImage.value = null
  watermarkImageSrc.value = ''
  watermarkImageElement.value = null
}

onMounted(() => {
  window.addEventListener('resize', drawPreview)
})
</script>

<template>
  <div class="watermark-view">
    <div class="page-header">
      <h2 class="page-title"><span class="title-icon">🖼️</span> 在线水印生成器</h2>
      <p class="page-desc">为您上传的证件、画作等图片添加防伪防盗水印。支持文字和平铺水印，在本地浏览器完成，绝不上传您的任何隐私图片。</p>
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
          拖拽原始图片到此处，或 <em>点击上传</em>
        </div>
        <template #tip>
          <div class="el-upload__tip text-center">
            支持 JPG, PNG, WEBP 等常见格式。
          </div>
        </template>
      </el-upload>
    </div>

    <el-row v-else :gutter="20" class="layout-row" v-loading="loading">
      <!-- 控制台卡片 -->
      <el-col :xs="24" :md="9" class="ctrl-col">
        <div class="col-wrap">
          <div class="ctrl-card theme-surface">
            <h3 class="section-title">水印参数调节</h3>
            
            <!-- 1. 水印类型 -->
            <div class="ctrl-item">
              <span class="ctrl-label">水印类型</span>
              <el-radio-group v-model="watermarkType" size="default" class="w-100">
                <el-radio-button value="text">文字水印</el-radio-button>
                <el-radio-button value="image">图片水印</el-radio-button>
              </el-radio-group>
            </div>

            <!-- 2. 排布布局 -->
            <div class="ctrl-item">
              <span class="ctrl-label">水印布局排布</span>
              <el-radio-group v-model="arrangement" size="default" class="w-100">
                <el-radio-button value="tiled">满屏平铺</el-radio-button>
                <el-radio-button value="single">单点定位</el-radio-button>
              </el-radio-group>
            </div>

            <!-- 3. 文字水印内容 -->
            <template v-if="watermarkType === 'text'">
              <div class="ctrl-item">
                <span class="ctrl-label">水印文字内容</span>
                <el-input v-model="watermarkText" placeholder="请输入水印文字" />
              </div>

              <div class="ctrl-item">
                <span class="ctrl-label">字体选择</span>
                <el-select v-model="fontFamily" class="w-100">
                  <el-option
                    v-for="font in fontFamilies"
                    :key="font.value"
                    :label="font.label"
                    :value="font.value"
                  />
                </el-select>
              </div>

              <div class="ctrl-item">
                <span class="ctrl-label">文字样式</span>
                <div class="style-checkboxes">
                  <el-checkbox v-model="isBold">加粗</el-checkbox>
                  <el-checkbox v-model="isItalic">倾斜</el-checkbox>
                </div>
              </div>

              <div class="ctrl-row-items">
                <div class="ctrl-item flex-1">
                  <span class="ctrl-label">水印大小 (px)</span>
                  <el-input-number v-model="fontSize" :min="10" :max="200" :step="2" class="w-100" />
                </div>
                <div class="ctrl-item">
                  <span class="ctrl-label">文字颜色</span>
                  <el-color-picker v-model="textColor" />
                </div>
              </div>
            </template>

            <!-- 4. 图片水印上传 -->
            <template v-else>
              <div class="ctrl-item">
                <span class="ctrl-label">水印图片上传</span>
                <div class="wm-img-upload-box">
                  <el-upload
                    action="#"
                    :auto-upload="false"
                    :show-file-list="false"
                    :on-change="handleWatermarkImageChange"
                    class="w-100"
                  >
                    <el-button type="default" :icon="Picture" class="w-100">
                      {{ watermarkImageSrc ? '更换水印图片' : '上传水印图片 (建议透明PNG)' }}
                    </el-button>
                  </el-upload>
                  <div v-if="watermarkImageSrc" class="wm-img-preview">
                    <img :src="watermarkImageSrc" alt="watermark logo" />
                  </div>
                </div>
              </div>

              <div class="ctrl-item">
                <span class="ctrl-label">图片水印缩放比例</span>
                <el-slider v-model="watermarkImgScale" :min="0.05" :max="0.8" :step="0.01" />
                <span class="sub-tip">以原图宽度为基准的缩放百分比。</span>
              </div>
            </template>

            <div class="divider"></div>

            <!-- 5. 布局特有参数 -->
            <!-- Tiled 平铺特有 -->
            <template v-if="arrangement === 'tiled'">
              <div class="ctrl-item">
                <span class="ctrl-label">水平间距 (px)</span>
                <el-slider v-model="columnGap" :min="20" :max="500" />
              </div>
              <div class="ctrl-item">
                <span class="ctrl-label">垂直间距 (px)</span>
                <el-slider v-model="rowGap" :min="20" :max="500" />
              </div>
            </template>

            <!-- Single 单点特有 -->
            <template v-else>
              <div class="ctrl-item">
                <span class="ctrl-label">九宫格定位</span>
                <div class="grid-selector">
                  <div class="grid-row">
                    <button type="button" :class="{ active: alignH === 'left' && alignV === 'top' }" @click="alignH='left'; alignV='top'">左上</button>
                    <button type="button" :class="{ active: alignH === 'center' && alignV === 'top' }" @click="alignH='center'; alignV='top'">中上</button>
                    <button type="button" :class="{ active: alignH === 'right' && alignV === 'top' }" @click="alignH='right'; alignV='top'">右上</button>
                  </div>
                  <div class="grid-row">
                    <button type="button" :class="{ active: alignH === 'left' && alignV === 'center' }" @click="alignH='left'; alignV='center'">左中</button>
                    <button type="button" :class="{ active: alignH === 'center' && alignV === 'center' }" @click="alignH='center'; alignV='center'">居中</button>
                    <button type="button" :class="{ active: alignH === 'right' && alignV === 'center' }" @click="alignH='right'; alignV='center'">右中</button>
                  </div>
                  <div class="grid-row">
                    <button type="button" :class="{ active: alignH === 'left' && alignV === 'bottom' }" @click="alignH='left'; alignV='bottom'">左下</button>
                    <button type="button" :class="{ active: alignH === 'center' && alignV === 'bottom' }" @click="alignH='center'; alignV='bottom'">中下</button>
                    <button type="button" :class="{ active: alignH === 'right' && alignV === 'bottom' }" @click="alignH='right'; alignV='bottom'">右下</button>
                  </div>
                </div>
              </div>

              <div class="ctrl-item">
                <span class="ctrl-label">X 轴偏移量 (px)</span>
                <el-slider v-model="offsetX" :min="-100" :max="400" />
              </div>

              <div class="ctrl-item">
                <span class="ctrl-label">Y 轴偏移量 (px)</span>
                <el-slider v-model="offsetY" :min="-100" :max="400" />
              </div>
            </template>

            <div class="divider"></div>

            <!-- 6. 变形与外观 -->
            <div class="ctrl-item">
              <span class="ctrl-label">倾斜角度 (角度)</span>
              <el-slider v-model="angle" :min="-180" :max="180" />
            </div>

            <div class="ctrl-item">
              <span class="ctrl-label">不透明度</span>
              <el-slider v-model="opacity" :min="0.05" :max="1.0" :step="0.01" />
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
                生成高清图片并下载
              </el-button>
              
              <el-button 
                type="info" 
                :icon="Refresh"
                size="large"
                class="action-btn"
                @click="resetImage"
              >
                更换原始图片
              </el-button>
            </div>
          </div>
        </div>
      </el-col>

      <!-- 预览区 -->
      <el-col :xs="24" :md="15" class="preview-col">
        <div class="col-wrap">
          <div class="preview-card theme-surface">
            <h3 class="section-title">实时水印预览</h3>
            <div class="canvas-outer-container">
              <canvas ref="previewCanvas" class="preview-canvas"></canvas>
            </div>
          </div>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.watermark-view {
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
.flex-1 { flex: 1; }
.mt-10 { margin-top: 10px; }

.ctrl-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ctrl-row-items {
  display: flex;
  gap: 14px;
  align-items: flex-end;
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

.style-checkboxes {
  display: flex;
  gap: 16px;
  padding: 4px 0;
}

.wm-img-upload-box {
  display: flex;
  align-items: center;
  gap: 12px;
}

.wm-img-preview {
  width: 45px;
  height: 45px;
  border: 1px dashed var(--border-color);
  border-radius: 6px;
  padding: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-deep);
  flex-shrink: 0;
}

.wm-img-preview img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

/* Nine Grid Selector */
.grid-selector {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 180px;
  margin: 4px auto;
}

.grid-row {
  display: flex;
  gap: 6px;
}

.grid-selector button {
  flex: 1;
  height: 32px;
  border: 1px solid var(--border-color);
  background: var(--bg-ctrl);
  color: var(--text-secondary);
  font-size: 0.78rem;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.grid-selector button:hover {
  border-color: var(--accent-blue);
  color: var(--text-primary);
}

.grid-selector button.active {
  background: var(--accent-blue);
  border-color: var(--accent-blue);
  color: #ffffff;
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
  align-items: center;
  justify-content: center;
  background: var(--bg-canvas);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 24px;
  min-height: 440px;
}

.preview-canvas {
  max-width: 100%;
  max-height: 500px;
  display: block;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25);
  border-radius: 4px;
}

@media (max-width: 768px) {
  .watermark-view {
    padding: 12px 10px 24px;
  }
  
  .layout-row {
    display: flex;
    flex-direction: column;
  }
  
  .preview-col {
    order: -1;
    margin-bottom: 16px;
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
    max-height: 320px;
  }
  
  .upload-card {
    padding: 20px 10px;
  }
  
  :deep(.el-upload-dragger) {
    padding: 24px 12px;
  }
  
  .grid-selector {
    width: 100%;
  }
}
</style>

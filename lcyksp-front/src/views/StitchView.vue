<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import axios from 'axios'

const mode = ref('vertical')
const images = ref([])
const imageUrls = ref([])
const loading = ref(false)
const gap = ref(0)
const bgColor = ref('#ffffff')
const bgType = ref('color')
const bgImageUrl = ref('')
const bgImageFile = ref(null)
const canvasWidth = ref(1080)
const canvasHeight = ref(1920)
const fileInputRef = ref(null)
const bgFileInputRef = ref(null)

const PRESET_COLORS = [
  '#ffffff', '#000000', '#f5f5f5', '#333333',
  '#ff6b6b', '#ffa502', '#2ed573', '#1e90ff',
  '#a855f7', '#ec4899', '#06b6d4', '#84cc16',
]

const customItems = ref([])
const dragTarget = ref(null)
const dragOffset = ref({ x: 0, y: 0 })
const resizeTarget = ref(null)
const resizeCorner = ref('')
const resizeStart = ref({ x: 0, y: 0, itemX: 0, itemY: 0, itemW: 0, itemH: 0 })
const rotateTarget = ref(null)
const rotateStart = ref({ angle: 0, startAngle: 0 })
const canvasRef = ref(null)
const canvasOuterRef = ref(null)
const canvasScale = ref(1)

const hasImages = computed(() => images.value.length > 0)
const canStitch = computed(() => images.value.length >= 2)

function handleFiles(fileList) {
  const newFiles = Array.from(fileList).filter(f => f.type.startsWith('image/'))
  if (newFiles.length === 0) {
    ElMessage.warning('请选择图片文件')
    return
  }
  for (const f of newFiles) {
    images.value.push(f)
    imageUrls.value.push(URL.createObjectURL(f))
  }
  if (mode.value === 'custom') {
    initCustomItems()
  }
}

function onUploadChange(e) {
  handleFiles(e.target.files)
  e.target.value = ''
}

function onBgFileChange(e) {
  const f = e.target.files[0]
  if (!f) return
  bgImageFile.value = f
  bgImageUrl.value = URL.createObjectURL(f)
  bgType.value = 'image'
  e.target.value = ''
}

function removeImage(index) {
  URL.revokeObjectURL(imageUrls.value[index])
  images.value.splice(index, 1)
  imageUrls.value.splice(index, 1)
  if (mode.value === 'custom') {
    customItems.value = customItems.value.filter(item => item.index !== index)
    recalcCanvas()
  }
}

function clearAll() {
  imageUrls.value.forEach(u => URL.revokeObjectURL(u))
  if (bgImageUrl.value) URL.revokeObjectURL(bgImageUrl.value)
  images.value = []
  imageUrls.value = []
  customItems.value = []
  bgImageFile.value = null
  bgImageUrl.value = ''
}

function initCustomItems() {
  const existing = new Set(customItems.value.map(i => i.index))
  const cols = Math.ceil(Math.sqrt(images.value.length))
  const cellW = canvasWidth.value / cols
  const cellH = canvasHeight.value / Math.ceil(images.value.length / cols)

  for (let i = 0; i < images.value.length; i++) {
    if (existing.has(i)) continue
    const col = i % cols
    const row = Math.floor(i / cols)
    customItems.value.push({
      index: i,
      x: col * cellW + 20,
      y: row * cellH + 20,
      width: Math.min(cellW - 40, 400),
      height: 0,
      rotation: 0,
      originalWidth: 0,
      originalHeight: 0,
    })
  }
  loadCustomItemSizes()
}

async function loadCustomItemSizes() {
  for (const item of customItems.value) {
    if (item.originalWidth > 0) continue
    const url = imageUrls.value[item.index]
    if (!url) continue
    try {
      const img = await loadImage(url)
      item.originalWidth = img.naturalWidth
      item.originalHeight = img.naturalHeight
      const ratio = img.naturalHeight / img.naturalWidth
      item.width = item.width || 300
      item.height = Math.round(item.width * ratio)
    } catch { /* ignore */ }
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

function recalcCanvas() {
  if (customItems.value.length === 0) return
  let maxX = 0, maxY = 0
  for (const item of customItems.value) {
    const right = item.x + (item.width || 100)
    const bottom = item.y + (item.height || 100)
    if (right > maxX) maxX = right
    if (bottom > maxY) maxY = bottom
  }
  canvasWidth.value = Math.max(1080, Math.round(maxX + 40))
  canvasHeight.value = Math.max(1920, Math.round(maxY + 40))
}

function updateCanvasScale() {
  if (!canvasOuterRef.value) return
  const wrapper = canvasOuterRef.value.parentElement
  if (!wrapper) return
  const maxW = wrapper.clientWidth - 40
  canvasScale.value = Math.min(1, maxW / canvasWidth.value)
}

onMounted(() => { updateCanvasScale() })
watch([canvasWidth, canvasHeight], () => { nextTick(updateCanvasScale) })

function canvasMousePos(e) {
  const el = canvasOuterRef.value || canvasRef.value
  if (!el) return { x: 0, y: 0 }
  const rect = el.getBoundingClientRect()
  const scale = canvasScale.value
  return {
    x: (e.clientX - rect.left) / scale,
    y: (e.clientY - rect.top) / scale,
  }
}

function onCanvasPointerDown(e, item, type) {
  e.preventDefault()
  e.stopPropagation()
  e.target.setPointerCapture?.(e.pointerId)

  if (type === 'move') {
    const pos = canvasMousePos(e)
    dragTarget.value = item
    dragOffset.value = {
      x: pos.x - item.x,
      y: pos.y - item.y,
    }
  } else if (type === 'resize') {
    resizeTarget.value = item
    const handle = e.target.closest('[data-corner]')
    resizeCorner.value = handle ? handle.dataset.corner : 'se'
    const pos = canvasMousePos(e)
    resizeStart.value = {
      x: pos.x,
      y: pos.y,
      itemX: item.x,
      itemY: item.y,
      itemW: item.width,
      itemH: item.height,
    }
  } else if (type === 'rotate') {
    rotateTarget.value = item
    const pos = canvasMousePos(e)
    const cx = item.x + (item.width || 0) / 2
    const cy = item.y + (item.height || 0) / 2
    rotateStart.value = {
      angle: item.rotation,
      startAngle: Math.atan2(pos.y - cy, pos.x - cx) * (180 / Math.PI),
    }
  }
}

function onDocPointerMove(e) {
  if (!dragTarget.value && !resizeTarget.value && !rotateTarget.value) return
  const pos = canvasMousePos(e)

  if (dragTarget.value) {
    dragTarget.value.x = Math.max(0, Math.round(pos.x - dragOffset.value.x))
    dragTarget.value.y = Math.max(0, Math.round(pos.y - dragOffset.value.y))
  }

  if (resizeTarget.value) {
    const item = resizeTarget.value
    const corner = resizeCorner.value
    const start = resizeStart.value
    const dx = pos.x - start.x
    const dy = pos.y - start.y
    const ratio = item.originalWidth > 0 ? item.originalHeight / item.originalWidth : 0

    let newW = start.itemW
    let newH = start.itemH
    let newX = start.itemX
    let newY = start.itemY

    if (corner === 'se') {
      newW = Math.max(40, Math.round(start.itemW + dx))
      newH = ratio > 0 ? Math.round(newW * ratio) : Math.max(40, Math.round(start.itemH + dy))
    } else if (corner === 'sw') {
      newW = Math.max(40, Math.round(start.itemW - dx))
      newH = ratio > 0 ? Math.round(newW * ratio) : Math.max(40, Math.round(start.itemH + dy))
      newX = Math.round(start.itemX + start.itemW - newW)
    } else if (corner === 'ne') {
      newW = Math.max(40, Math.round(start.itemW + dx))
      newH = ratio > 0 ? Math.round(newW * ratio) : Math.max(40, Math.round(start.itemH - dy))
      newY = Math.round(start.itemY + start.itemH - newH)
    } else if (corner === 'nw') {
      newW = Math.max(40, Math.round(start.itemW - dx))
      newH = ratio > 0 ? Math.round(newW * ratio) : Math.max(40, Math.round(start.itemH - dy))
      newX = Math.round(start.itemX + start.itemW - newW)
      newY = Math.round(start.itemY + start.itemH - newH)
    }

    item.x = newX
    item.y = newY
    item.width = newW
    item.height = newH
  }

  if (rotateTarget.value) {
    const item = rotateTarget.value
    const cx = item.x + (item.width || 0) / 2
    const cy = item.y + (item.height || 0) / 2
    const angle = Math.atan2(pos.y - cy, pos.x - cx) * (180 / Math.PI)
    item.rotation = Math.round(rotateStart.value.angle + (angle - rotateStart.value.startAngle))
  }
}

function onDocPointerUp() {
  if (resizeTarget.value) recalcCanvas()
  dragTarget.value = null
  resizeTarget.value = null
  rotateTarget.value = null
}

onMounted(() => {
  document.addEventListener('pointermove', onDocPointerMove, { passive: false })
  document.addEventListener('pointerup', onDocPointerUp)
})
onUnmounted(() => {
  document.removeEventListener('pointermove', onDocPointerMove)
  document.removeEventListener('pointerup', onDocPointerUp)
  imageUrls.value.forEach(u => URL.revokeObjectURL(u))
  if (bgImageUrl.value) URL.revokeObjectURL(bgImageUrl.value)
})

function moveItemZIndex(item, dir) {
  const idx = customItems.value.indexOf(item)
  if (idx < 0) return
  if (dir === 'up' && idx < customItems.value.length - 1) {
    [customItems.value[idx], customItems.value[idx + 1]] = [customItems.value[idx + 1], customItems.value[idx]]
  } else if (dir === 'down' && idx > 0) {
    [customItems.value[idx], customItems.value[idx - 1]] = [customItems.value[idx - 1], customItems.value[idx]]
  }
}

async function doStitch() {
  if (!canStitch.value) {
    ElMessage.warning('请至少上传两张图片')
    return
  }

  loading.value = true
  try {
    const fd = new FormData()
    fd.append('mode', mode.value)
    fd.append('gap', String(gap.value))
    fd.append('bgConfig', JSON.stringify(parseColor(bgColor.value)))

    if (mode.value === 'custom') {
      fd.append('layout', JSON.stringify(customItems.value.map(item => ({
        index: item.index,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        rotation: item.rotation,
      }))))
      fd.append('canvasWidth', String(canvasWidth.value))
      fd.append('canvasHeight', String(canvasHeight.value))

      for (const item of images.value) {
        fd.append('images', item)
      }

      if (bgImageFile.value) {
        fd.append('bgImage', bgImageFile.value)
      }
    } else {
      for (const item of images.value) {
        fd.append('images', item)
      }
    }

    const res = await axios.post('/api/stitch', fd, {
      responseType: 'blob',
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 120000,
    })

    if (res.data.type && res.data.type.includes('json')) {
      const text = await res.data.text()
      const json = JSON.parse(text)
      ElMessage.error(json.error || '拼接失败')
      return
    }

    const url = URL.createObjectURL(res.data)
    const a = document.createElement('a')
    a.href = url
    a.download = `stitched-${mode.value}-${Date.now()}.png`
    a.click()
    URL.revokeObjectURL(url)
    ElMessage.success('拼接完成，已开始下载')
  } catch (err) {
    const msg = err.response?.data?.error || err.message || '拼接失败'
    ElMessage.error(msg)
  } finally {
    loading.value = false
  }
}

function parseColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return { r, g, b, alpha: bgType.value === 'transparent' ? 0 : 1 }
}
</script>

<template>
  <div class="page-view">
    <h2 class="page-title"><span class="title-icon">🧩</span> 长图拼接</h2>
    <p class="page-desc">多张图片一键拼接，支持上下、左右、自由画布模式</p>

    <div class="page-content">
      <!-- 上传区域 -->
      <div class="upload-zone" @click="$refs.fileInputRef.click()" @dragover.prevent @drop.prevent="handleFiles($event.dataTransfer.files)">
        <input ref="fileInputRef" type="file" accept="image/*" multiple style="display:none" @change="onUploadChange">
        <div class="upload-icon">📁</div>
        <div class="upload-text">点击或拖拽上传图片</div>
        <div class="upload-hint">支持多选，最多30张</div>
      </div>

      <!-- 已上传图片列表 -->
      <div v-if="hasImages" class="image-list">
        <div v-for="(url, idx) in imageUrls" :key="idx" class="image-thumb">
          <img :src="url" :alt="`图片${idx+1}`">
          <button class="thumb-remove" @click.stop="removeImage(idx)">✕</button>
          <span class="thumb-index">{{ idx + 1 }}</span>
        </div>
        <button class="clear-btn" @click="clearAll">清空全部</button>
      </div>

      <!-- 模式选择 -->
      <div v-if="hasImages" class="mode-section">
        <label class="section-label">拼接模式</label>
        <div class="mode-tabs">
          <button :class="['mode-tab', { active: mode === 'vertical' }]" @click="mode = 'vertical'">⬇️ 上下拼接</button>
          <button :class="['mode-tab', { active: mode === 'horizontal' }]" @click="mode = 'horizontal'">➡️ 左右拼接</button>
          <button :class="['mode-tab', { active: mode === 'custom' }]" @click="mode = 'custom'; initCustomItems()">🎨 自由画布</button>
        </div>
      </div>

      <!-- 间距设置 -->
      <div v-if="hasImages" class="setting-row">
        <label class="section-label">图片间距</label>
        <div class="gap-control">
          <input type="range" v-model.number="gap" min="0" max="50" step="1" class="gap-slider">
          <span class="gap-value">{{ gap }}px</span>
        </div>
      </div>

      <!-- 背景设置 -->
      <div v-if="hasImages" class="bg-section">
        <label class="section-label">画布背景</label>
        <div class="bg-type-tabs">
          <button :class="['bg-tab', { active: bgType === 'color' }]" @click="bgType = 'color'">🎨 纯色</button>
          <button :class="['bg-tab', { active: bgType === 'image' }]" @click="bgType = 'image'">🖼️ 图片</button>
          <button :class="['bg-tab', { active: bgType === 'transparent' }]" @click="bgType = 'transparent'">🔲 透明</button>
        </div>

        <div v-if="bgType === 'color'" class="color-picker-row">
          <div class="preset-colors">
            <button v-for="c in PRESET_COLORS" :key="c" class="color-dot" :style="{ background: c }" :class="{ selected: bgColor === c }" @click="bgColor = c"></button>
          </div>
          <div class="custom-color">
            <input type="color" v-model="bgColor" class="color-input">
            <input type="text" v-model="bgColor" class="color-hex" maxlength="7" placeholder="#ffffff">
          </div>
        </div>

        <div v-if="bgType === 'image'" class="bg-image-row">
          <button class="bg-upload-btn" @click="$refs.bgFileInputRef.click()">
            <input ref="bgFileInputRef" type="file" accept="image/*" style="display:none" @change="onBgFileChange">
            {{ bgImageUrl ? '重新选择背景图' : '选择背景图片' }}
          </button>
          <img v-if="bgImageUrl" :src="bgImageUrl" class="bg-preview-thumb">
        </div>
      </div>

      <!-- 自由画布设置 -->
      <div v-if="mode === 'custom' && hasImages" class="custom-settings">
        <label class="section-label">画布尺寸</label>
        <div class="canvas-size-row">
          <div class="size-input-group">
            <label>宽</label>
            <input type="number" v-model.number="canvasWidth" min="100" max="10000" class="size-input">
          </div>
          <span class="size-x">×</span>
          <div class="size-input-group">
            <label>高</label>
            <input type="number" v-model.number="canvasHeight" min="100" max="10000" class="size-input">
          </div>
          <span class="size-unit">px</span>
        </div>

        <!-- 画布预览 -->
        <div class="canvas-wrapper">
          <div ref="canvasOuterRef" class="canvas-outer" :style="{ width: canvasWidth * canvasScale + 'px', height: canvasHeight * canvasScale + 'px' }">
            <div ref="canvasRef" class="stitch-canvas" :style="{
              width: canvasWidth + 'px',
              height: canvasHeight + 'px',
              transform: `scale(${canvasScale})`,
              transformOrigin: 'top left',
              background: bgType === 'transparent'
                ? 'repeating-conic-gradient(#e0e0e0 0% 25%, #fff 0% 50%) 50% / 20px 20px'
                : bgType === 'image' && bgImageUrl ? `url(${bgImageUrl}) center/cover` : bgColor,
            }">
              <div v-for="item in customItems" :key="item.index" class="canvas-item" :style="{
                left: item.x + 'px',
                top: item.y + 'px',
                width: item.width + 'px',
                height: item.height + 'px',
                transform: `rotate(${item.rotation}deg)`,
                zIndex: customItems.indexOf(item) + 1,
              }">
                <img :src="imageUrls[item.index]" class="canvas-item-img" draggable="false" @pointerdown.stop="onCanvasPointerDown($event, item, 'move')">
                <div class="resize-handle se" data-corner="se" @pointerdown.stop="onCanvasPointerDown($event, item, 'resize')"></div>
                <div class="resize-handle sw" data-corner="sw" @pointerdown.stop="onCanvasPointerDown($event, item, 'resize')"></div>
                <div class="resize-handle ne" data-corner="ne" @pointerdown.stop="onCanvasPointerDown($event, item, 'resize')"></div>
                <div class="resize-handle nw" data-corner="nw" @pointerdown.stop="onCanvasPointerDown($event, item, 'resize')"></div>
                <div class="rotate-handle" @pointerdown.stop="onCanvasPointerDown($event, item, 'rotate')">↻</div>
                <div class="item-toolbar">
                  <button @pointerdown.stop @click.stop="moveItemZIndex(item, 'up')" title="上移一层">↑</button>
                  <button @pointerdown.stop @click.stop="moveItemZIndex(item, 'down')" title="下移一层">↓</button>
                  <button @pointerdown.stop @click.stop="removeImage(item.index)" title="删除" class="item-del">✕</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 操作按钮 -->
      <div v-if="canStitch" class="action-row">
        <button class="stitch-btn" :disabled="loading" @click="doStitch">
          <span v-if="loading" class="btn-loading">⏳ 拼接中...</span>
          <span v-else>🧩 开始拼接并下载</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-view {
  max-width: 800px;
  margin: 0 auto;
  padding: 20px 16px 40px;
}
.page-title {
  font-size: 1.4rem;
  font-weight: 400;
  color: var(--text-heading);
  margin: 0 0 6px;
  letter-spacing: 1px;
}
.title-icon { margin-right: 8px; }
.page-desc {
  color: var(--text-secondary);
  font-size: 0.85rem;
  margin: 0 0 24px;
}
.page-content {
  background: var(--bg-card);
  border-radius: 12px;
  padding: 24px;
  border: 1px solid var(--border-color);
  box-shadow: 0 18px 40px color-mix(in srgb, var(--accent-blue) 8%, transparent);
}

.upload-zone {
  border: 2px dashed var(--border-color);
  border-radius: 12px;
  padding: 40px 20px;
  text-align: center;
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s;
}
.upload-zone:hover {
  border-color: var(--accent-blue);
  background: color-mix(in srgb, var(--accent-blue) 5%, transparent);
}
.upload-icon { font-size: 2.5rem; margin-bottom: 8px; }
.upload-text { color: var(--text-primary); font-size: 0.95rem; margin-bottom: 4px; }
.upload-hint { color: var(--text-secondary); font-size: 0.8rem; }

.image-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 16px;
  align-items: center;
}
.image-thumb {
  position: relative;
  width: 72px;
  height: 72px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border-color);
  flex-shrink: 0;
}
.image-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.thumb-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: none;
  background: rgba(0,0,0,0.6);
  color: #fff;
  font-size: 10px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
.thumb-index {
  position: absolute;
  bottom: 2px;
  left: 2px;
  background: rgba(0,0,0,0.5);
  color: #fff;
  font-size: 10px;
  padding: 0 4px;
  border-radius: 4px;
}
.clear-btn {
  background: none;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.8rem;
}
.clear-btn:hover { color: #e74c3c; border-color: #e74c3c; }

.section-label {
  display: block;
  font-size: 0.85rem;
  color: var(--text-secondary);
  margin-bottom: 8px;
  font-weight: 500;
}

.mode-section { margin-top: 20px; }
.mode-tabs {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.mode-tab {
  flex: 1;
  min-width: 100px;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  font-size: 0.9rem;
  transition: all 0.2s;
}
.mode-tab:hover { border-color: var(--accent-blue); }
.mode-tab.active {
  background: var(--accent-blue);
  color: #fff;
  border-color: var(--accent-blue);
}

.setting-row {
  margin-top: 16px;
}
.gap-control {
  display: flex;
  align-items: center;
  gap: 12px;
}
.gap-slider {
  flex: 1;
  accent-color: var(--accent-blue);
}
.gap-value {
  min-width: 40px;
  text-align: right;
  color: var(--text-primary);
  font-size: 0.85rem;
}

.bg-section { margin-top: 16px; }
.bg-type-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.bg-tab {
  padding: 6px 14px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  font-size: 0.85rem;
  transition: all 0.2s;
}
.bg-tab:hover { border-color: var(--accent-blue); }
.bg-tab.active {
  background: var(--accent-blue);
  color: #fff;
  border-color: var(--accent-blue);
}

.color-picker-row {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.preset-colors {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.color-dot {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  transition: border-color 0.2s, transform 0.15s;
}
.color-dot:hover { transform: scale(1.15); }
.color-dot.selected { border-color: var(--accent-blue); }
.custom-color {
  display: flex;
  align-items: center;
  gap: 8px;
}
.color-input {
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  padding: 0;
}
.color-hex {
  width: 80px;
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-card);
  color: var(--text-primary);
  font-size: 0.85rem;
  font-family: monospace;
}

.bg-image-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.bg-upload-btn {
  padding: 8px 16px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  font-size: 0.85rem;
  transition: all 0.2s;
}
.bg-upload-btn:hover { border-color: var(--accent-blue); }
.bg-preview-thumb {
  width: 48px;
  height: 48px;
  border-radius: 6px;
  object-fit: cover;
  border: 1px solid var(--border-color);
}

.custom-settings { margin-top: 20px; }
.canvas-size-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}
.size-input-group {
  display: flex;
  align-items: center;
  gap: 4px;
}
.size-input-group label {
  font-size: 0.8rem;
  color: var(--text-secondary);
}
.size-input {
  width: 80px;
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-card);
  color: var(--text-primary);
  font-size: 0.85rem;
}
.size-x { color: var(--text-secondary); }
.size-unit { color: var(--text-secondary); font-size: 0.8rem; }

.canvas-wrapper {
  overflow: auto;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-secondary, #f0f0f0);
  padding: 20px;
}
.canvas-outer {
  margin: 0 auto;
  position: relative;
  overflow: hidden;
}
.stitch-canvas {
  position: absolute;
  top: 0;
  left: 0;
  overflow: hidden;
  box-shadow: 0 4px 20px rgba(0,0,0,0.15);
}
.canvas-item {
  position: absolute;
  cursor: move;
  border: 2px solid transparent;
  transition: border-color 0.15s;
  touch-action: none;
  user-select: none;
  -webkit-user-drag: none;
}
.canvas-item:hover { border-color: var(--accent-blue); }
.canvas-item-img {
  width: 100%;
  height: 100%;
  object-fit: fill;
  display: block;
  pointer-events: auto;
}
.resize-handle {
  position: absolute;
  width: 12px;
  height: 12px;
  background: var(--accent-blue);
  border: 2px solid #fff;
  border-radius: 2px;
}
.resize-handle.se { bottom: -6px; right: -6px; cursor: se-resize; }
.resize-handle.sw { bottom: -6px; left: -6px; cursor: sw-resize; }
.resize-handle.ne { top: -6px; right: -6px; cursor: ne-resize; }
.resize-handle.nw { top: -6px; left: -6px; cursor: nw-resize; }
.rotate-handle {
  position: absolute;
  top: -30px;
  left: 50%;
  transform: translateX(-50%);
  width: 24px;
  height: 24px;
  background: var(--accent-blue);
  color: #fff;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  cursor: grab;
  user-select: none;
}
.item-toolbar {
  position: absolute;
  top: -30px;
  right: -4px;
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
  z-index: 9999;
  pointer-events: auto;
}
.canvas-item:hover .item-toolbar { opacity: 1; }
.item-toolbar button {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 4px;
  background: rgba(0,0,0,0.6);
  color: #fff;
  font-size: 11px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
}
.item-toolbar button:hover { background: rgba(0,0,0,0.8); }
.item-del:hover { background: #e74c3c !important; }

.action-row {
  margin-top: 24px;
  text-align: center;
}
.stitch-btn {
  padding: 14px 40px;
  background: var(--accent-blue);
  color: #fff;
  border: none;
  border-radius: 10px;
  font-size: 1rem;
  cursor: pointer;
  transition: all 0.2s;
  letter-spacing: 1px;
}
.stitch-btn:hover { opacity: 0.9; transform: translateY(-1px); }
.stitch-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
.btn-loading { animation: pulse 1.2s infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }

@media (max-width: 480px) {
  .page-view { padding: 12px 10px 30px; }
  .page-content { padding: 16px; }
  .mode-tabs { flex-direction: column; }
  .mode-tab { min-width: auto; }
  .canvas-size-row { flex-wrap: wrap; }
}
</style>

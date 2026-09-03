<script setup>
/**
 * PixelArtConverter.vue — 纯前端图片转拼豆图纸
 *
 * 流程：本地读图 → Canvas降采样 → 色卡邻近匹配 → 网格渲染 → 统计面板
 * 鼠标悬浮实时显示格子色卡信息
 */
import { ref, computed, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import { Picture, UploadFilled } from '@element-plus/icons-vue'

// ===================================================================
//  预设拼豆官方色卡
// ===================================================================
const PALETTE = [
  { name: '白色',       hex: '#FFFFFF', r: 255, g: 255, b: 255 },
  { name: '黑色',       hex: '#1C1C1C', r: 28,  g: 28,  b: 28  },
  { name: '红色',       hex: '#E60012', r: 230, g: 0,   b: 18  },
  { name: '深红',       hex: '#C1000F', r: 193, g: 0,   b: 15  },
  { name: '橙色',       hex: '#F58220', r: 245, g: 130, b: 32  },
  { name: '黄色',       hex: '#FFD700', r: 255, g: 215, b: 0   },
  { name: '柠檬黄',     hex: '#FFF200', r: 255, g: 242, b: 0   },
  { name: '浅绿',       hex: '#7CCD3A', r: 124, g: 205, b: 58  },
  { name: '绿色',       hex: '#009944', r: 0,   g: 153, b: 68  },
  { name: '深绿',       hex: '#005A2E', r: 0,   g: 90,  b: 46  },
  { name: '天蓝',       hex: '#00A0E9', r: 0,   g: 160, b: 233 },
  { name: '蓝色',       hex: '#0055A4', r: 0,   g: 85,  b: 164 },
  { name: '深蓝',       hex: '#003366', r: 0,   g: 51,  b: 102 },
  { name: '紫色',       hex: '#7B3F9E', r: 123, g: 63,  b: 158 },
  { name: '粉色',       hex: '#F7A8B8', r: 247, g: 168, b: 184 },
  { name: '棕色',       hex: '#8B5E3C', r: 139, g: 94,  b: 60  },
  { name: '灰色',       hex: '#999999', r: 153, g: 153, b: 153 },
  { name: '浅灰',       hex: '#CCCCCC', r: 204, g: 204, b: 204 },
  { name: '米色',       hex: '#F5E6C8', r: 245, g: 230, b: 200 },
  { name: '肤色',       hex: '#FDDCB5', r: 253, g: 220, b: 181 },
  { name: '肉色',       hex: '#EAB983', r: 234, g: 185, b: 131 },
  { name: '咖啡',       hex: '#6B4423', r: 107, g: 68,  b: 35  },
  { name: '藏青',       hex: '#1A237E', r: 26,  g: 35,  b: 126 },
  { name: '青绿',       hex: '#008B8B', r: 0,   g: 139, b: 139 },
  { name: '玫红',       hex: '#E91E63', r: 233, g: 30,  b: 99  },
]

// ===================================================================
//  状态
// ===================================================================
const sourceImage = ref(null)
const pixelMatrix = ref([])
const colorStats = ref([])
const pixelSize = ref(29)
const showGrid = ref(true)
const processing = ref(false)

const canvasRef = ref(null)

const PRESET_SIZES = [29, 58, 87]

// 悬浮提示
const hoverInfo = ref(null)

// ===================================================================
//  计算
// ===================================================================
const CELL_SIZE = computed(() => Math.floor(580 / pixelSize.value))
const CANVAS_DISPLAY = computed(() => CELL_SIZE.value * pixelSize.value)

// ===================================================================
//  图片加载
// ===================================================================
function handleFileUpload(file) {
  if (!file) return
  if (!file.type || !file.type.startsWith('image/')) {
    ElMessage.warning('请选择图片文件')
    return false
  }
  const reader = new FileReader()
  reader.onload = (e) => { sourceImage.value = e.target.result }
  reader.readAsDataURL(file)
  return false
}

// ===================================================================
//  核心处理
// ===================================================================
function generatePixelArt() {
  if (!sourceImage.value) { ElMessage.warning('请先上传图片'); return }
  processing.value = true
  nextTick(() => {
    const img = new Image()
    img.onload = () => { processImage(img); processing.value = false }
    img.onerror = () => { ElMessage.error('图片加载失败'); processing.value = false }
    img.src = sourceImage.value
  })
}

function processImage(img) {
  const size = pixelSize.value
  const cell = CELL_SIZE.value

  const offscreen = document.createElement('canvas')
  offscreen.width = size
  offscreen.height = size
  const offCtx = offscreen.getContext('2d')

  const sRatio = img.width / img.height
  let sx, sy, sw, sh
  if (sRatio > 1) {
    sh = img.height; sw = img.height
    sx = (img.width - sw) / 2; sy = 0
  } else {
    sw = img.width; sh = img.width
    sx = 0; sy = (img.height - sh) / 2
  }

  offCtx.drawImage(img, sx, sy, sw, sh, 0, 0, size, size)
  const imageData = offCtx.getImageData(0, 0, size, size)
  const d = imageData.data

  const matrix = []
  const statsMap = {}

  for (let y = 0; y < size; y++) {
    const row = []
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4
      const r = d[idx], g = d[idx + 1], b = d[idx + 2]

      let minDist = Infinity
      let best = PALETTE[0]
      for (const color of PALETTE) {
        const dr = r - color.r, dg = g - color.g, db = b - color.b
        const dist = dr * dr + dg * dg + db * db
        if (dist < minDist) { minDist = dist; best = color }
      }
      row.push(best)
      statsMap[best.name] = (statsMap[best.name] || 0) + 1
    }
    matrix.push(row)
  }

  pixelMatrix.value = matrix

  colorStats.value = Object.entries(statsMap)
    .map(([name, count]) => {
      const color = PALETTE.find(c => c.name === name)
      return { name, hex: color ? color.hex : '#000', count }
    })
    .sort((a, b) => b.count - a.count)

  nextTick(() => renderCanvas(matrix, cell, size))
}

// ===================================================================
//  渲染主画布
// ===================================================================
function renderCanvas(matrix, cell, size) {
  const canvas = canvasRef.value
  if (!canvas) return

  const dpr = window.devicePixelRatio || 1
  const displaySize = cell * size

  canvas.width = displaySize * dpr
  canvas.height = displaySize * dpr
  canvas.style.width = displaySize + 'px'
  canvas.style.height = displaySize + 'px'

  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      ctx.fillStyle = matrix[y][x].hex
      ctx.fillRect(x * cell, y * cell, cell, cell)
    }
  }

  if (showGrid.value) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)'
    ctx.lineWidth = 0.5
    for (let i = 0; i <= size; i++) {
      ctx.beginPath(); ctx.moveTo(i * cell, 0); ctx.lineTo(i * cell, displaySize); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(0, i * cell); ctx.lineTo(displaySize, i * cell); ctx.stroke()
    }
  }
}

// ===================================================================
//  鼠标悬浮 — 使用 offsetX/offsetY
// ===================================================================
function onCanvasMouseMove(e) {
  const canvas = canvasRef.value
  const matrix = pixelMatrix.value
  if (!canvas || !matrix.length) { hoverInfo.value = null; return }

  const cell = CELL_SIZE.value
  const size = pixelSize.value

  // offsetX/offsetY 相对 canvas 元素 CSS 坐标
  const col = Math.floor(e.offsetX / cell)
  const row = Math.floor(e.offsetY / cell)

  if (row >= 0 && row < size && col >= 0 && col < size) {
    const color = matrix[row][col]
    hoverInfo.value = {
      row: row + 1,
      col: col + 1,
      name: color.name,
      hex: color.hex,
    }
  } else {
    hoverInfo.value = null
  }
}

function onCanvasMouseLeave() { hoverInfo.value = null }

// ===================================================================
//  下载
// ===================================================================
function downloadArt() {
  const canvas = canvasRef.value
  if (!canvas) { ElMessage.warning('请先生成图纸'); return }
  const link = document.createElement('a')
  link.download = `pixel-art-${pixelSize.value}x${pixelSize.value}.png`
  link.href = canvas.toDataURL('image/png')
  link.click()
}

function setPresetSize(size) {
  pixelSize.value = size
  if (sourceImage.value) generatePixelArt()
}
</script>

<template>
  <div class="pixel-art-view">
    <div class="page-header">
      <div>
        <h2 class="page-title"><span class="title-icon">🧩</span> 图片转拼豆图纸</h2>
        <p class="page-desc">上传图片 → 降采样 → 色卡匹配 → 生成拼豆图纸 · 鼠标悬浮查看颜色</p>
      </div>
    </div>

    <div class="main-layout">
      <!-- 左侧控制面板 -->
      <div class="control-panel">
        <el-upload
          drag :auto-upload="false" :show-file-list="false"
          :on-change="(u) => handleFileUpload(u.raw)"
          accept="image/*" class="upload-area"
        >
          <div v-if="!sourceImage" class="upload-placeholder">
            <el-icon :size="48"><UploadFilled /></el-icon>
            <span>拖拽图片到此处，或点击选择</span>
            <span class="upload-hint">支持 JPG / PNG / WebP</span>
          </div>
          <div v-else class="upload-preview">
            <img :src="sourceImage" class="preview-img" alt="原图预览" />
            <span class="upload-change">点击更换图片</span>
          </div>
        </el-upload>

        <div class="control-section">
          <label class="control-label">拼板尺寸</label>
          <div class="preset-row">
            <el-button v-for="s in PRESET_SIZES" :key="s"
              :type="pixelSize === s ? 'primary' : 'default'" size="small"
              @click="setPresetSize(s)">{{ s }}×{{ s }}
            </el-button>
          </div>
          <el-slider v-model="pixelSize" :min="10" :max="100" :step="1" show-input input-size="small" class="size-slider" />
        </div>

        <div class="control-section">
          <el-checkbox v-model="showGrid" label="显示网格线" />
        </div>

        <!-- 两按钮水平对齐 -->
        <div class="btn-row">
          <el-button type="primary" size="large" :loading="processing" :disabled="!sourceImage" class="btn-flex" @click="generatePixelArt">
            {{ processing ? '处理中…' : '🎨 生成图纸' }}
          </el-button>
          <el-button v-if="pixelMatrix.length > 0" size="large" class="btn-flex" @click="downloadArt">
            ⬇️ 下载 PNG
          </el-button>
        </div>
      </div>

      <!-- 右侧：画布 + 统计 -->
      <div class="result-panel">
        <div v-if="pixelMatrix.length > 0" class="canvas-wrap">
          <div class="canvas-outer">
            <canvas ref="canvasRef" class="art-canvas"
              @mousemove="onCanvasMouseMove"
              @mouseleave="onCanvasMouseLeave"
            />
            <!-- 悬浮 Tooltip -->
            <div v-if="hoverInfo" class="hover-tooltip">
              <span class="hover-color" :style="{ background: hoverInfo.hex }" />
              <span class="hover-pos">第 {{ hoverInfo.row }} 行 · 第 {{ hoverInfo.col }} 列</span>
              <span class="hover-sep">|</span>
              <span class="hover-name">{{ hoverInfo.name }}</span>
              <span class="hover-hex">{{ hoverInfo.hex }}</span>
            </div>
          </div>
          <div class="canvas-info">
            {{ pixelSize }}×{{ pixelSize }} · 共 {{ pixelSize * pixelSize }} 颗粒 ·
            <span v-if="hoverInfo" class="hover-status">
              鼠标位置：[{{ hoverInfo.col }}, {{ hoverInfo.row }}]
            </span>
          </div>
        </div>

        <div v-else class="canvas-empty">
          <el-icon :size="48"><Picture /></el-icon>
          <span>上传图片后点击「生成图纸」</span>
        </div>

        <div v-if="colorStats.length > 0" class="stats-panel">
          <h3 class="stats-title">📊 色卡用量统计</h3>
          <div class="stats-list">
            <div v-for="stat in colorStats" :key="stat.name" class="stat-item">
              <span class="stat-color" :style="{ background: stat.hex }" />
              <span class="stat-name">{{ stat.name }}</span>
              <span class="stat-count">{{ stat.count }} 颗</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pixel-art-view { max-width: 1200px; margin: 0 auto; padding: 20px 16px 40px; }
.page-header { margin-bottom: 24px; }
.page-title { font-size: 1.4rem; font-weight: 400; color: var(--text-heading); margin: 0 0 4px; letter-spacing: 1px; }
.title-icon { margin-right: 8px; }
.page-desc { color: var(--text-muted); font-size: 0.85rem; margin: 0; }

.main-layout { display: flex; gap: 24px; flex-wrap: wrap; }
.control-panel { width: 280px; flex-shrink: 0; display: flex; flex-direction: column; gap: 16px; }
.upload-area { width: 100%; }
:deep(.el-upload-dragger) { background: var(--bg-card); border: 2px dashed var(--border-color); border-radius: 12px; padding: 20px; }
:deep(.el-upload-dragger:hover) { border-color: var(--accent-blue); }
.upload-placeholder { display: flex; flex-direction: column; align-items: center; gap: 8px; color: var(--text-secondary); font-size: 0.85rem; }
.upload-hint { color: var(--text-muted); font-size: 0.75rem; }
.upload-preview { position: relative; display: flex; flex-direction: column; align-items: center; gap: 8px; }
.preview-img { max-width: 100%; max-height: 160px; border-radius: 8px; object-fit: contain; }
.upload-change { color: var(--accent-blue); font-size: 0.8rem; }
.control-section { background: var(--bg-card); border-radius: 10px; padding: 14px 16px; border: 1px solid var(--border-color); }
.control-label { display: block; color: var(--text-secondary); font-size: 0.8rem; margin-bottom: 8px; font-weight: 500; }
.preset-row { display: flex; gap: 6px; margin-bottom: 10px; }
.size-slider { width: 100%; }

/* 按钮水平行 */
.btn-row { display: flex; gap: 10px; }
.btn-row .btn-flex { flex: 1; }

.result-panel { flex: 1; min-width: 300px; display: flex; flex-direction: column; gap: 16px; }

.canvas-outer { position: relative; display: inline-block; }
.art-canvas { border-radius: 8px; background: var(--bg-canvas); image-rendering: pixelated; max-width: 100%; height: auto; cursor: crosshair; }

/* Tooltip 跟随鼠标右上角 */
.hover-tooltip {
  position: absolute;
  bottom: -36px;
  right: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-hover);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 5px 12px;
  color: var(--text-primary);
  font-size: 0.78rem;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: 0 4px 16px rgba(0,0,0,0.5);
}
.hover-color { width: 14px; height: 14px; border-radius: 3px; border: 1px solid var(--text-placeholder); flex-shrink: 0; }
.hover-name { color: var(--accent-gold); }
.hover-hex { color: var(--text-muted); font-family: monospace; font-size: 0.72rem; }
.hover-sep { color: var(--text-placeholder); }

.canvas-wrap { display: flex; flex-direction: column; align-items: center; gap: 8px; padding-bottom: 6px; }
.canvas-info { color: var(--text-muted); font-size: 0.78rem; }
.hover-status { color: var(--accent-gold); }

.canvas-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 80px 20px; color: var(--text-dim); font-size: 0.9rem; background: var(--bg-card); border-radius: 12px; border: 1px solid var(--border-color); }

.stats-panel { background: var(--bg-card); border-radius: 10px; border: 1px solid var(--border-color); padding: 16px; max-height: 400px; overflow-y: auto; }
.stats-title { color: var(--text-heading); font-size: 0.95rem; margin: 0 0 12px; font-weight: 500; }
.stats-list { display: flex; flex-direction: column; gap: 4px; }
.stat-item { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 6px; }
.stat-item:hover { background: var(--bg-hover); }
.stat-color { width: 20px; height: 20px; border-radius: 4px; border: 1px solid var(--text-placeholder); flex-shrink: 0; }
.stat-name { flex: 1; color: var(--text-muted); font-size: 0.85rem; }
.stat-count { color: var(--text-secondary); font-size: 0.8rem; font-family: monospace; }
.stats-panel::-webkit-scrollbar { width: 4px; }
.stats-panel::-webkit-scrollbar-thumb { background: var(--text-placeholder); border-radius: 2px; }

@media (max-width: 768px) { .control-panel { width: 100%; } .main-layout { flex-direction: column; } }
</style>

<script setup>
/**
 * ObfuscateView.vue — 严格复刻小番茄混淆工具
 *
 * 核心：Gilbert Curve + 黄金分割步长置换
 *   混淆：newData[dst] = oldData[src]
 *   解混淆：newData[src] = oldData[dst]
 *
 * 布局：<el-row :span="12"> 左右对称 · max-height: 450px 限高
 */
import { ref, nextTick, onMounted, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'

// ===================================================================
//  原版 Gilbert 曲线生成（一字不动）
// ===================================================================
function z(t, n) {
  const e = []
  return t >= n ? p(0, 0, t, 0, 0, n, e) : p(0, 0, 0, n, t, 0, e), e
}

function p(t, n, e, o, c, a, r) {
  const m = Math.abs(e + o), l = Math.abs(c + a), u = Math.sign(e), d = Math.sign(o), L = Math.sign(c), s = Math.sign(a)
  if (l === 1) {
    for (let M = 0; M < m; M++) r.push([t, n]), t += u, n += d
    return
  }
  if (m === 1) {
    for (let M = 0; M < l; M++) r.push([t, n]), t += L, n += s
    return
  }
  let h = Math.floor(e / 2), g = Math.floor(o / 2), i = Math.floor(c / 2), f = Math.floor(a / 2)
  const S = Math.abs(h + g), _ = Math.abs(i + f)
  2 * m > 3 * l
    ? (S % 2 && m > 2 && (h += u, g += d), p(t, n, h, g, c, a, r), p(t + h, n + g, e - h, o - g, c, a, r))
    : (_ % 2 && l > 2 && (i += L, f += s), p(t, n, i, f, h, g, r), p(t + i, n + f, e, o, c - i, a - f, r), p(t + (e - u) + (i - L), n + (o - d) + (f - s), -i, -f, -(e - h), -(o - g), r))
}

// ===================================================================
//  状态
// ===================================================================
const mode = ref('obfuscate')
const scratchEnabled = ref(false)
const sourceImage = ref(null)
const isObfuscated = ref(false)
const processing = ref(false)

const origCanvasRef = ref(null)
const resultCanvasRef = ref(null)

let imgW = 0
let imgH = 0
let originalBlob = null  // 保存原始图片的 Blob（用于"还原"功能）

// 刮刮乐
let isScratching = false
const scratchRadius = 28
let scratchData = null

// ===================================================================
//  图片加载（原版缩放逻辑）
// ===================================================================
function handleFileUpload(file) {
  if (!file) return false
  if (!file.type || !file.type.startsWith('image/')) {
    ElMessage.warning('请选择图片文件')
    return false
  }
  originalBlob = file  // 保存原始文件
  const reader = new FileReader()
  reader.onload = (e) => loadImage(e.target.result)
  reader.readAsDataURL(file)
  return false
}

async function handlePaste() {
  try {
    const items = await navigator.clipboard.read()
    for (const item of items) {
      const t = item.types.find(t => t.startsWith('image/'))
      if (t) {
        const blob = await item.getType(t)
        originalBlob = blob
        loadImage(URL.createObjectURL(blob))
        ElMessage.success('已从剪贴板粘贴图片')
        return
      }
    }
    ElMessage.warning('剪贴板中没有图片')
  } catch { ElMessage.warning('无法读取剪贴板') }
}

function loadImage(url) {
  sourceImage.value = url
  isObfuscated.value = false
  nextTick(() => {
    const img = new Image()
    img.onload = () => {
      const origCanvas = origCanvasRef.value
      if (!origCanvas) return

      let w = img.width, h = img.height
      const MAX_W = 720
      if (w > MAX_W) { h = Math.round(h * (MAX_W / w)); w = MAX_W }

      imgW = w
      imgH = h

      // 原图预览
      origCanvas.width = w
      origCanvas.height = h
      origCanvas.style.width = w + 'px'
      origCanvas.style.height = h + 'px'
      const ctx = origCanvas.getContext('2d')
      ctx.drawImage(img, 0, 0, w, h)

      ElMessage.success(`图片已加载 (${w}×${h})`)
    }
    img.src = url
  })
}

// ===================================================================
//  核心：原版 A(type) — 严格复刻
//  混淆 enc：newData[dst] = oldData[src]  像素从 curve[s] → curve[(s+L)%total]
//  解混淆 dec：newData[src] = oldData[dst]  像素从 curve[(s+L)%total] → curve[s]
// ===================================================================
function processWithSource(sourceCanvas, type) {
  const canvas = resultCanvasRef.value
  if (!canvas) return

  const c = imgW
  const a = imgH
  canvas.width = c
  canvas.height = a
  canvas.style.width = c + 'px'
  canvas.style.height = a + 'px'

  const ctx = canvas.getContext('2d')
  // 从源 canvas 读取像素
  const srcCtx = sourceCanvas.getContext('2d')
  const m = srcCtx.getImageData(0, 0, c, a)
  const l = ctx.createImageData(c, a)

  // Gilbert 曲线
  const u = z(c, a)
  const d = c * a
  const L = Math.round((Math.sqrt(5) - 1) / 2 * d)

  for (let s = 0; s < d; s++) {
    const h = u[s]        // src 坐标 = curve[s]
    const g = u[(s + L) % d]  // dst 坐标 = curve[(s+L)%total]
    const i = 4 * (h[0] + h[1] * c)  // src 字节偏移
    const f = 4 * (g[0] + g[1] * c)  // dst 字节偏移

    if (type === 'enc') {
      // 混淆：把旧图中 src 像素复制到新图的 dst 位置
      l.data.set(m.data.slice(i, i + 4), f)
    } else {
      // 解混淆：把旧图中 dst 像素复制到新图的 src 位置
      l.data.set(m.data.slice(f, f + 4), i)
    }
  }

  ctx.putImageData(l, 0, 0)

  if (type === 'enc') {
    isObfuscated.value = true
    ElMessage.success('混淆完成！Gilbert 曲线 + 黄金分割置换')
  } else {
    isObfuscated.value = false
    ElMessage.success('已成功解混淆还原！')
  }
}

// ===================================================================
//  按钮入口
// ===================================================================
function handleObfuscate() {
  if (!sourceImage.value) { ElMessage.warning('请先选择图片'); return }
  processing.value = true

  // 刷新 curve 和 L（每次均重新生成）
  const img = new Image()
  img.onload = () => {
    // 把源图绘制到一个临时 canvas
    const temp = document.createElement('canvas')
    temp.width = imgW
    temp.height = imgH
    const tCtx = temp.getContext('2d')
    tCtx.drawImage(img, 0, 0, imgW, imgH)

    processWithSource(temp, 'enc')
    processing.value = false
  }
  img.onerror = () => { ElMessage.error('图片加载失败'); processing.value = false }
  img.src = sourceImage.value
}

function handleDeobfuscate() {
  if (!sourceImage.value && !isObfuscated.value) {
    ElMessage.warning('请先混淆一张图片'); return
  }

  const canvas = resultCanvasRef.value
  if (!canvas) return
  const c = imgW, a = imgH

  // 从当前结果 canvas 读取混淆图
  const ctx = canvas.getContext('2d')
  const m = ctx.getImageData(0, 0, c, a)

  if (scratchEnabled.value && isObfuscated.value) {
    // 刮刮乐模式
    const u = z(c, a)
    const d = c * a
    const L = Math.round((Math.sqrt(5) - 1) / 2 * d)

    scratchData = {
      imageData: m,
      curve: u, total: d, goldenL: L,
      w: c, h: a,
    }
    ElMessage.success('刮刮乐模式已启动，按住鼠标涂抹即可逐步还原')
    return
  }

  // 直接解混淆：用结果 canvas 作为源
  processing.value = true
  nextTick(() => {
    // 把当前结果（混淆图）当作源传入
    processWithSource(canvas, 'dec')
    processing.value = false
  })
}

// ===================================================================
//  刮刮乐涂抹
// ===================================================================
function onScratchStart(e) {
  if (!scratchEnabled.value || !isObfuscated.value || !scratchData) return
  isScratching = true
  scratchAt(e)
}
function onScratchMove(e) {
  if (!isScratching || !scratchData) return
  scratchAt(e)
}
function onScratchEnd() { isScratching = false }

function scratchAt(e) {
  const canvas = resultCanvasRef.value
  const sd = scratchData
  if (!canvas || !sd) return

  const rect = canvas.getBoundingClientRect()
  const mx = (e.clientX - rect.left) * (sd.w / rect.width)
  const my = (e.clientY - rect.top) * (sd.h / rect.height)

  const r = scratchRadius
  const sx = Math.max(0, Math.floor(mx - r))
  const ex = Math.min(sd.w - 1, Math.ceil(mx + r))
  const sy = Math.max(0, Math.floor(my - r))
  const ey = Math.min(sd.h - 1, Math.ceil(my + r))

  // 直接从原始 scratchData.imageData 逐像素还原
  // 对受影响的每个 dst 坐标，找到对应的 src 坐标并写回
  const srcP = sd.imageData.data
  const dstData = new ImageData(new Uint8ClampedArray(srcP), sd.w, sd.h)
  const dstP = dstData.data

  const u = sd.curve, d = sd.total, L = sd.goldenL, c = sd.w

  // 只处理受影响区域内的像素
  // 遍历所有 s，如果 dst 坐标在影响区域内，则执行还原
  for (let s = 0; s < d; s++) {
    const h = u[s]        // src 坐标
    const g = u[(s + L) % d]  // dst 坐标
    const gx = g[0], gy = g[1]

    if (gx >= sx && gx <= ex && gy >= sy && gy <= ey) {
      // dst 坐标在影响范围内 → 执行逆置换
      const i = 4 * (h[0] + h[1] * c)  // src 字节偏移
      const f = 4 * (gx + gy * c)      // dst 字节偏移
      // 从混淆图的 dst 位置读，写到 src 位置
      dstP.set(srcP.slice(f, f + 4), i)
    }
  }

  const ctx = canvas.getContext('2d')
  ctx.putImageData(dstData, 0, 0)
}

// ===================================================================
//  下载
// ===================================================================
function downloadResult() {
  const canvas = resultCanvasRef.value
  if (!canvas) { ElMessage.warning('请先生成结果'); return }
  const ctx = canvas.getContext('2d')
  const d = ctx.getImageData(0, 0, 1, 1).data
  if (d[3] === 0) { ElMessage.warning('画布为空'); return }

  canvas.toBlob((blob) => {
    if (!blob) { ElMessage.warning('导出失败'); return }
    const link = document.createElement('a')
    link.download = isObfuscated.value ? 'obfuscated-gilbert.jpeg' : 'deobfuscated-gilbert.jpeg'
    link.href = URL.createObjectURL(blob)
    link.click()
    setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  }, 'image/jpeg', 0.95)
}

// ===================================================================
//  剪贴板
// ===================================================================
function onGlobalPaste(e) {
  const items = e.clipboardData?.items
  if (!items) return
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const blob = item.getAsFile()
      if (blob) { handleFileUpload(blob); break }
    }
  }
}
onMounted(() => document.addEventListener('paste', onGlobalPaste))
onUnmounted(() => document.removeEventListener('paste', onGlobalPaste))
</script>

<template>
  <div class="obfuscate-view">
    <div class="page-header">
      <div>
        <h2 class="page-title"><span class="title-icon">🕵️</span> 图片混淆与还原</h2>
        <p class="page-desc">Gilbert 空间填充曲线 · 黄金分割置换 · 严格互逆 · 100% 无损可逆</p>
      </div>
    </div>

    <el-row :gutter="20">
      <!-- ===== 左侧栏 ===== -->
      <el-col :span="12">
        <div class="col-wrap">
          <!-- 控制面板 -->
          <div class="ctrl-card">
            <!-- 操作模式（水平对齐） -->
            <div style="display: flex; gap: 16px; align-items: center; justify-content: flex-start; margin-bottom: 20px;">
              <span style="font-size: 14px; color: #a9a9b3; flex-shrink: 0;">操作模式：</span>
              <el-radio-group v-model="mode" style="display: flex; gap: 20px; align-items: center;">
                <el-radio value="obfuscate">自动混淆</el-radio>
                <el-radio value="deobfuscate">自动解混淆</el-radio>
                <el-radio value="none">不处理</el-radio>
              </el-radio-group>
            </div>

            <!-- 刮刮乐 -->
            <div class="ctrl-section" style="margin-top: 4px;">
              <div class="switch-row">
                <label class="ctrl-label" style="margin-bottom:0;">刮刮乐效果</label>
                <el-switch v-model="scratchEnabled" />
              </div>
              <p class="ctrl-hint">开启后解混淆需按住鼠标涂抹才可逐步显现原图</p>
            </div>

            <el-upload drag :auto-upload="false" :show-file-list="false"
              :on-change="(u) => handleFileUpload(u.raw)"
              accept="image/*" class="upload-area" style="margin-top: 8px;">
              <div v-if="!sourceImage" class="upload-placeholder">
                <el-icon :size="36"><UploadFilled /></el-icon>
                <span>拖拽或点击选择图片</span>
                <span class="upload-hint">JPG / PNG / WebP</span>
              </div>
              <div v-else class="upload-preview">
                <el-icon :size="20"><UploadFilled /></el-icon>
                <span class="upload-change">点击更换图片</span>
              </div>
            </el-upload>

            <el-button class="paste-btn" @click="handlePaste" style="margin-top: 2px;">
              <el-icon><Document /></el-icon> 从剪贴板粘贴
            </el-button>

            <el-divider style="margin: 8px 0;" />

            <!-- 核心按钮严格并排 -->
            <div style="display: flex; gap: 12px; align-items: center; width: 100%; margin-top: 15px;">
              <el-button type="primary" style="flex: 1; height: 40px; font-weight: bold;"
                :loading="processing" :disabled="!sourceImage"
                @click="handleObfuscate">
                {{ processing ? '处理中…' : '执行混淆' }}
              </el-button>
              <el-button type="success" style="flex: 1; height: 40px; font-weight: bold;"
                :disabled="!sourceImage && !isObfuscated"
                @click="handleDeobfuscate">
                执行解混淆
              </el-button>
            </div>

            <el-divider style="margin: 8px 0;" />

            <el-button size="large" class="download-btn" @click="downloadResult">
              ⬇️ 一键保存 JPEG 0.95
            </el-button>
          </div>

          <!-- 原图预览 -->
          <div class="preview-card">
            <h3 class="section-title">📷 原图预览</h3>
            <div class="img-box">
              <canvas v-if="sourceImage" ref="origCanvasRef" class="fit-canvas" />
              <div v-else class="empty-state">
                <el-icon :size="28"><Picture /></el-icon>
                <span>请选择或粘贴图片</span>
              </div>
            </div>
          </div>
        </div>
      </el-col>

      <!-- ===== 右侧栏 ===== -->
      <el-col :span="12">
        <div class="col-wrap">
          <div class="preview-card" style="flex:1">
            <h3 class="section-title">
              🎨 结果画布
              <span v-if="isObfuscated" class="badge obfuscated">已混淆 · Gilbert</span>
              <span v-if="!isObfuscated && sourceImage" class="badge clear">清晰</span>
            </h3>
            <div class="img-box">
              <canvas ref="resultCanvasRef" class="fit-canvas result-canvas"
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
.obfuscate-view { max-width: 1200px; margin: 0 auto; padding: 20px 16px 40px; }
.page-header { margin-bottom: 20px; }
.page-title { font-size: 1.4rem; font-weight: 400; color: #e0e0e0; margin: 0 0 4px; letter-spacing: 1px; }
.title-icon { margin-right: 8px; }
.page-desc { color: #666; font-size: 0.85rem; margin: 0; }

.col-wrap { display: flex; flex-direction: column; gap: 16px; }

.ctrl-card {
  background: #16162a; border-radius: 12px; border: 1px solid #222244;
  padding: 20px 18px; display: flex; flex-direction: column;
}
.ctrl-section { background: #111125; border-radius: 8px; padding: 10px 14px; }
.ctrl-label { display: block; color: #999; font-size: 0.8rem; font-weight: 500; }
.switch-row { display: flex; justify-content: space-between; align-items: center; }
.ctrl-hint { color: #555; font-size: 0.7rem; margin: 6px 0 0; line-height: 1.4; }

.upload-area { width: 100%; }
:deep(.el-upload-dragger) { background: #111125; border: 2px dashed #222244; border-radius: 8px; padding: 14px; }
.upload-placeholder { display: flex; flex-direction: column; align-items: center; gap: 4px; color: #888; font-size: 0.8rem; }
.upload-hint { color: #555; font-size: 0.7rem; }
.upload-preview { display: flex; align-items: center; justify-content: center; gap: 6px; color: #409eff; font-size: 0.82rem; }
.paste-btn { width: 100%; }
:deep(.el-divider) { border-color: #1a1a30; margin: 2px 0; }
.download-btn { width: 100%; }

.preview-card { background: #16162a; border-radius: 12px; border: 1px solid #222244; padding: 16px; }
.section-title { color: #c0c0e0; font-size: 0.85rem; font-weight: 500; margin: 0 0 10px; display: flex; align-items: center; gap: 8px; }
.badge { font-size: 0.68rem; padding: 1px 7px; border-radius: 4px; font-weight: 400; }
.badge.obfuscated { background: #3a1a1a; color: #e74c3c; border: 1px solid #5a2a2a; }
.badge.clear { background: #1a2a1a; color: #67c23a; border: 1px solid #2a4a2a; }

.img-box {
  max-height: 450px; width: 100%;
  display: flex; justify-content: center; align-items: center;
  background: #0d0d1a; border-radius: 12px; overflow: hidden;
  min-height: 120px;
}
.fit-canvas { max-height: 100%; max-width: 100%; object-fit: contain; border-radius: 8px; background: #0a0a14; }
.result-canvas { cursor: crosshair; }

.empty-state { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 50px 20px; color: #555; font-size: 0.82rem; }

@media (max-width: 768px) {
  .obfuscate-view { padding: 12px 8px 30px; }
  .img-box { max-height: 280px; }
}
</style>

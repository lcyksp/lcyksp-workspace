<script setup>
import { ref, reactive, onMounted, onUnmounted, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import * as pdfjsLib from 'pdfjs-dist'
import { PDFDocument, degrees } from 'pdf-lib'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'
pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker()

const mode = ref('none')
const rawFile = ref(null); const fileName = ref(''); const totalPages = ref(0); const currentPage = ref(1)
const signColor = ref('#000000'); const signLineWidth = ref(3); const currentAssetBase64 = ref('')
const transformConfig = reactive({ scale: 100, rotation: 0, opacity: 1.0 })
const placedSigns = ref([]); const draggingId = ref(null); const dragOffset = reactive({x:0,y:0})
const showSignaturePad = ref(false); const processing = ref(false)
let pdfDocCache = null; let isDrawing = false; let lastX = 0, lastY = 0

async function handleFileChange(uploadFile) {
  const file = uploadFile.raw; if (!file || file.type !== 'application/pdf') { ElMessage.warning('请选择 PDF'); return }
  rawFile.value = file; fileName.value = file.name; placedSigns.value = []; currentPage.value = 1; pdfDocCache = null
  await renderCurrentPage(); ElMessage.success(`已载入「${file.name}」`)
}
async function renderCurrentPage() {
  if (!rawFile.value) return
  try {
    const buf = await rawFile.value.arrayBuffer()
    pdfDocCache = await pdfjsLib.getDocument({ data: buf, useSystemFonts: true }).promise
    totalPages.value = pdfDocCache.numPages
    const page = await pdfDocCache.getPage(currentPage.value); const vp = page.getViewport({ scale: 1.2 })
    const c = document.getElementById('pdf-render-canvas'); if (!c) return
    c.width = vp.width; c.height = vp.height; c.style.width = vp.width+'px'; c.style.height = vp.height+'px'
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise
  } catch { ElMessage.error('渲染失败') }
}
function prevPage() { if (currentPage.value>1) { currentPage.value--; renderCurrentPage() } }
function nextPage() { if (currentPage.value<totalPages.value) { currentPage.value++; renderCurrentPage() } }
function openSignaturePad() { showSignaturePad.value = true; nextTick(initPad) }
function closeSignaturePad() { showSignaturePad.value = false }
function initPad() {
  const c = document.getElementById('signature-canvas'); if (!c) return
  const rect = c.parentElement.getBoundingClientRect(); c.width = rect.width; c.height = rect.height
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height)
}
function getPos(e) {
  const c = document.getElementById('signature-canvas'); if (!c) return {x:0,y:0}
  const r = c.getBoundingClientRect(); const cx = e.touches ? e.touches[0].clientX : e.clientX; const cy = e.touches ? e.touches[0].clientY : e.clientY
  return { x: cx - r.left, y: cy - r.top }
}
function padStart(e) { e.preventDefault(); isDrawing = true; const p = getPos(e); lastX = p.x; lastY = p.y }
function padMove(e) {
  e.preventDefault(); if (!isDrawing) return; const c = document.getElementById('signature-canvas'); if (!c) return
  const ctx = c.getContext('2d'); const p = getPos(e)
  ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(p.x, p.y)
  ctx.strokeStyle = signColor.value; ctx.lineWidth = signLineWidth.value; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke()
  lastX = p.x; lastY = p.y
}
function padEnd() { isDrawing = false }
function clearPad() { const c = document.getElementById('signature-canvas'); if (!c) return; const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0,0,c.width,c.height) }
function confirmSignature() {
  const c = document.getElementById('signature-canvas'); if (!c) return
  const ctx = c.getContext('2d'); const d = ctx.getImageData(0,0,c.width,c.height); const p = d.data
  for (let i = 0; i < p.length; i += 4) { if (p[i] >= 250 && p[i+1] >= 250 && p[i+2] >= 250) p[i+3] = 0 }
  ctx.putImageData(d,0,0); currentAssetBase64.value = c.toDataURL('image/png'); closeSignaturePad(); ElMessage.success('签名已生成')
}
function handleStampUpload(uploadFile) {
  const file = uploadFile.raw; if (!file || !file.type.startsWith('image/')) return
  const r = new FileReader(); r.onload = e => {
    const img = new Image(); img.onload = () => {
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const ctx = c.getContext('2d')
      ctx.drawImage(img,0,0); const d = ctx.getImageData(0,0,c.width,c.height); const p = d.data
      for (let i = 0; i < p.length; i += 4) { if (p[i] >= 240 && p[i+1] >= 240 && p[i+2] >= 240) p[i+3] = 0 }
      ctx.putImageData(d,0,0); currentAssetBase64.value = c.toDataURL('image/png'); ElMessage.success('印章已导入')
    }; img.src = e.target.result
  }; r.readAsDataURL(file)
}
function handlePreviewClick(e) {
  if (!currentAssetBase64.value) { ElMessage.warning('请先创建签名或上传印章'); return }
  const cont = e.currentTarget; const r = cont.getBoundingClientRect()
  const cx = e.clientX||(e.touches&&e.touches[0].clientX); const cy = e.clientY||(e.touches&&e.touches[0].clientY)
  if (cx==null) return
  placedSigns.value.push({ id: Date.now()+Math.random(), pageNum: currentPage.value, xPercent: Math.max(0,Math.min(100,((cx-r.left)/r.width)*100)), yPercent: Math.max(0,Math.min(100,((cy-r.top)/r.height)*100)) })
}
function onSignMDown(e, sign) {
  draggingId.value = sign.id; const cont = e.currentTarget.parentElement; const r = cont.getBoundingClientRect()
  const cx = e.clientX||(e.touches&&e.touches[0].clientX); const cy = e.clientY||(e.touches&&e.touches[0].clientY)
  if (cx==null) return; dragOffset.x = cx - r.left - (sign.xPercent/100*r.width); dragOffset.y = cy - r.top - (sign.yPercent/100*r.height)
}
function onGMM(e) {
  if (draggingId.value === null) return; const s = placedSigns.value.find(x => x.id === draggingId.value); if (!s) return
  const cont = document.getElementById('pdf-preview-container'); if (!cont) return; const r = cont.getBoundingClientRect()
  const cx = e.clientX||(e.touches&&e.touches[0].clientX); const cy = e.clientY||(e.touches&&e.touches[0].clientY)
  if (cx==null) return; s.xPercent = Math.max(0,Math.min(100,((cx-r.left-dragOffset.x)/r.width)*100)); s.yPercent = Math.max(0,Math.min(100,((cy-r.top-dragOffset.y)/r.height)*100))
}
function onGMU() { draggingId.value = null }
onMounted(() => { document.addEventListener('mousemove',onGMM); document.addEventListener('mouseup',onGMU); document.addEventListener('touchmove',onGMM,{passive:false}); document.addEventListener('touchend',onGMU) })
onUnmounted(() => { document.removeEventListener('mousemove',onGMM); document.removeEventListener('mouseup',onGMU); document.removeEventListener('touchmove',onGMM); document.removeEventListener('touchend',onGMU) })
function removeSign(id) { placedSigns.value = placedSigns.value.filter(s => s.id !== id) }
async function handleExportSignedPDF() {
  if (!rawFile.value || !placedSigns.value.length) { ElMessage.warning('没有需要导出的签名'); return }
  processing.value = true
  try {
    const buf = await rawFile.value.arrayBuffer(); const pdfDoc = await PDFDocument.load(buf)
    const assetBytes = await fetch(currentAssetBase64.value).then(r=>r.arrayBuffer()); const img = await pdfDoc.embedPng(assetBytes)
    const pages = pdfDoc.getPages()
    for (const s of placedSigns.value) {
      const page = pages[s.pageNum-1]; if (!page) continue; const {width,height} = page.getSize()
      const rx = (s.xPercent/100)*width; const ry = height-((s.yPercent/100)*height)
      const fw = (transformConfig.scale/100)*(width*0.2); const fh = (fw/img.width)*img.height
      page.drawImage(img, { x: rx-fw/2, y: ry-fh/2, width: fw, height: fh, opacity: transformConfig.opacity, rotate: degrees(transformConfig.rotation) })
    }
    const bytes = await pdfDoc.save(); const blob = new Blob([bytes],{type:'application/pdf'})
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fileName.value.replace(/\.pdf$/i,'')+'_签名.pdf'; a.click()
    ElMessage.success('签名 PDF 导出成功！')
  } catch { ElMessage.error('导出失败') }
  finally { processing.value = false }
}
</script>
<template>
  <div class="pdf-sign-view">
    <div class="page-header"><div><h2 class="page-title"><span class="title-icon">✍️</span> PDF 签名工具</h2><p class="page-desc">手写签名 · 印章上传 · 点击放置 · 拖动微调</p></div></div>
    <el-row :gutter="20">
      <el-col :xs="24" :md="12"><div class="col-wrap">
        <el-upload drag :auto-upload="false" :show-file-list="false" :on-change="handleFileChange" accept="application/pdf" class="upload-area">
          <div class="upload-placeholder"><el-icon :size="36"><UploadFilled /></el-icon><span>拖拽 PDF 文件</span><span class="upload-hint">仅支持单个 PDF</span></div>
        </el-upload>
        <div v-if="!rawFile" class="empty-card"><el-icon :size="28"><Document /></el-icon><span>请上传 PDF</span></div>
        <div v-if="rawFile" class="config-card">
          <h4>签名与印章</h4>
          <div class="config-field"><label>手写签名</label><el-radio-group v-model="signColor" size="small"><el-radio value="#000000">⚫ 黑</el-radio><el-radio value="#0000ff">🔵 蓝</el-radio><el-radio value="#ff0000">🔴 红</el-radio></el-radio-group>
            <div style="display:flex;align-items:center;gap:10px"><span style="color:var(--text-secondary);font-size:0.78rem">粗细</span><el-slider v-model="signLineWidth" :min="1" :max="8" :step="1" style="flex:1" /></div>
            <el-button size="large" class="action-btn" @click="openSignaturePad">开始手写签名</el-button>
          </div>
          <div class="config-field"><label>上传印章（去白底）</label><el-upload :auto-upload="false" :show-file-list="false" :on-change="handleStampUpload" accept="image/*" drag class="stamp-upload"><div class="stamp-placeholder"><el-icon :size="24"><UploadFilled /></el-icon><span>选择印章图片</span></div></el-upload></div>
          <div v-if="currentAssetBase64" style="display:flex;align-items:center;gap:8px"><img :src="currentAssetBase64" style="height:48px;border-radius:4px" /><el-button size="small" text type="danger" @click="currentAssetBase64=''">清除</el-button></div>
        </div>
        <div v-if="rawFile" class="config-card">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px"><el-button size="small" :disabled="currentPage<=1" @click="prevPage">◀</el-button><span style="color:var(--text-primary);font-size:0.85rem">{{ currentPage }}/{{ totalPages }}</span><el-button size="small" :disabled="currentPage>=totalPages" @click="nextPage">▶</el-button></div>
          <div class="config-field"><label>缩放 {{ transformConfig.scale }}%</label><el-slider v-model="transformConfig.scale" :min="20" :max="200" :step="5" /></div>
          <div class="config-field"><label>旋转 {{ transformConfig.rotation }}°</label><el-slider v-model="transformConfig.rotation" :min="-180" :max="180" :step="15" /></div>
          <div class="config-field"><label>透明度 {{ transformConfig.opacity }}</label><el-slider v-model="transformConfig.opacity" :min="0.1" :max="1" :step="0.1" /></div>
        </div>
        <div v-if="placedSigns.length" class="config-card"><div v-for="s in placedSigns" :key="s.id" style="display:flex;justify-content:space-between;padding:4px 0;color:var(--text-primary);font-size:0.82rem;border-bottom:1px solid var(--bg-hover)"><span>第 {{ s.pageNum }} 页</span><el-button size="small" text type="danger" @click="removeSign(s.id)">删除</el-button></div></div>
        <el-button v-if="placedSigns.length" type="primary" size="large" :loading="processing" class="action-btn" @click="handleExportSignedPDF">{{ processing ? '导出中…' : '导出签名 PDF' }}</el-button>
      </div></el-col>
      <el-col :xs="24" :md="12"><div class="col-wrap">
        <div class="preview-card"><div class="section-title-row"><h3 class="section-title">PDF 预览</h3><span style="color:var(--text-muted);font-size:0.72rem">点击页面放置签名</span></div>
          <div class="preview-box" id="pdf-preview-container">
            <div class="pdf-canvas-wrap" @click="handlePreviewClick" @touchstart="handlePreviewClick">
              <canvas id="pdf-render-canvas" class="pdf-canvas" />
              <div v-for="s in placedSigns.filter(s=>s.pageNum===currentPage)" :key="s.id" class="placed-sign"
                :style="{left:s.xPercent+'%',top:s.yPercent+'%',width:(transformConfig.scale/100)*20+'%',opacity:transformConfig.opacity,transform:'translate(-50%,-50%) rotate('+transformConfig.rotation+'deg)'}"
                @mousedown.stop="e=>onSignMDown(e,s)" @touchstart.stop="e=>onSignMDown(e,s)">
                <img :src="currentAssetBase64" class="sign-img" /><span class="sign-delete" @click.stop="removeSign(s.id)">×</span>
              </div>
            </div>
          </div>
        </div>
      </div></el-col>
    </el-row>
    <el-dialog v-model="showSignaturePad" fullscreen :close-on-click-modal="false" :show-close="false" class="signature-dialog">
      <div class="sig-header"><span style="color:var(--text-heading);font-size:1rem">手写签名</span><div class="sig-tools"><el-button size="small" @click="clearPad">清空</el-button><el-button size="small" type="primary" @click="confirmSignature">确认</el-button><el-button size="small" @click="closeSignaturePad">取消</el-button></div></div>
      <div class="sig-canvas-wrap"><canvas id="signature-canvas" class="sig-canvas" @mousedown="padStart" @mousemove="padMove" @mouseup="padEnd" @mouseleave="padEnd" @touchstart="padStart" @touchmove="padMove" @touchend="padEnd" /></div>
    </el-dialog>
  </div>
</template>
<style scoped>
.pdf-sign-view { max-width: 1200px; margin: 0 auto; padding: 20px 16px 40px; }
.page-header { margin-bottom: 20px; }
.title-icon { margin-right: 8px; }
.page-title { font-size: 1.4rem; font-weight: 400; color: var(--text-heading); margin: 0 0 4px; letter-spacing: 1px; }
.page-desc { color: var(--text-muted); font-size: 0.85rem; margin: 0; }
.col-wrap { display: flex; flex-direction: column; gap: 14px; }
.upload-area { width: 100%; }
:deep(.el-upload-dragger) { background: var(--bg-card); border: 2px dashed var(--border-color); border-radius: 10px; padding: 20px; }
:deep(.el-upload-dragger:hover) { border-color: var(--accent-blue); }
.upload-placeholder { display: flex; flex-direction: column; align-items: center; gap: 6px; color: var(--text-secondary); font-size: 0.85rem; }
.upload-hint { color: var(--text-muted); font-size: 0.75rem; }
.empty-card { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 40px 20px; color: var(--text-dim); font-size: 0.85rem; background: var(--bg-card); border-radius: 10px; border: 1px solid var(--border-color); }
.config-card { background: var(--bg-card); border-radius: 10px; border: 1px solid var(--border-color); padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.config-card h4 { color: var(--text-heading); font-size: 0.88rem; font-weight: 500; margin: 0; }
.config-field { display: flex; flex-direction: column; gap: 6px; }
.config-field label { color: var(--text-secondary); font-size: 0.78rem; }
.action-btn { width: 100%; }
.stamp-upload { width: 100%; }
:deep(.stamp-upload .el-upload-dragger) { padding: 12px; }
.stamp-placeholder { display: flex; align-items: center; justify-content: center; gap: 6px; color: var(--text-secondary); font-size: 0.8rem; }
.preview-card { background: var(--bg-card); border-radius: 12px; border: 1px solid var(--border-color); padding: 16px; display: flex; flex-direction: column; flex: 1; }
.section-title-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.section-title { color: var(--text-heading); font-size: 0.85rem; font-weight: 500; margin: 0; }
.preview-box { max-height: 550px; width: 100%; overflow-y: auto; background: var(--bg-canvas); border-radius: 8px; min-height: 200px; position: relative; }
.pdf-canvas-wrap { position: relative; display: inline-block; min-width: 100%; }
.pdf-canvas { display: block; width: 100%; height: auto; cursor: crosshair; }
.placed-sign { position: absolute; cursor: grab; z-index: 10; }
.placed-sign:active { cursor: grabbing; }
.sign-img { width: 100%; display: block; pointer-events: none; }
.sign-delete { position: absolute; top: -8px; right: -8px; width: 18px; height: 18px; background: var(--accent-red); color: #fff; border-radius: 50%; display: none; align-items: center; justify-content: center; font-size: 12px; cursor: pointer; }
.placed-sign:hover .sign-delete { display: flex; }
:deep(.signature-dialog .el-dialog__body) { padding: 0; background: var(--bg-canvas); height: calc(100vh - 60px); display: flex; flex-direction: column; }
:deep(.signature-dialog .el-dialog) { background: var(--bg-canvas); }
.sig-header { display: flex; justify-content: space-between; align-items: center; padding: 14px 20px; background: var(--bg-card); border-bottom: 1px solid var(--bg-hover); }
.sig-tools { display: flex; gap: 8px; }
.sig-canvas-wrap { flex: 1; padding: 12px; display: flex; }
.sig-canvas { width: 100%; height: 100%; border-radius: 8px; touch-action: none; cursor: crosshair; background: #fff; }
@media (max-width: 768px) { .pdf-sign-view { padding: 12px 8px 30px; } }
</style>

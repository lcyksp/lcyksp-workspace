<script setup>
import { ref, reactive, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import * as pdfjsLib from 'pdfjs-dist'
import { PDFDocument, rgb, degrees, StandardFonts } from 'pdf-lib'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'
import { Document, Picture, UploadFilled } from '@element-plus/icons-vue'
pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker()

const mode = ref('none')
const rawFile = ref(null); const fileName = ref(''); const fileSize = ref(''); const totalPages = ref(0)
const processing = ref(false); const isPreviewActive = ref(false); const previewImages = ref([])
const wc = reactive({ text: '', fontSize: 32, rotation: 45, opacity: 0.3, color: '#ff4d4f' })

function hex2rgb(h) {
  const s = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h.replace(/^#?([a-f\d])([a-f\d])([a-f\d])$/i,(m,r,g,b)=>r+r+g+g+b+b))
  return s ? { r: parseInt(s[1],16)/255, g: parseInt(s[2],16)/255, b: parseInt(s[3],16)/255 } : { r:0,g:0,b:0 }
}
async function handleFileChange(uploadFile) {
  const file = uploadFile.raw; if (!file || file.type !== 'application/pdf') { ElMessage.warning('请选择 PDF'); return }
  rawFile.value = file; fileName.value = file.name; fileSize.value = (file.size/1024/1024).toFixed(2)+' MB'; clearPreview()
  try { const buf = await file.arrayBuffer(); const pdf = await pdfjsLib.getDocument({data:buf,useSystemFonts:true}).promise; totalPages.value = pdf.numPages; ElMessage.success(`共 ${pdf.numPages} 页`) }
  catch { ElMessage.error('PDF 解析失败') }
}
function clearPreview() { previewImages.value.forEach(u=>URL.revokeObjectURL(u)); previewImages.value = []; isPreviewActive.value = false }
async function handleGenerateWatermark(download = false) {
  if (!rawFile.value) { ElMessage.warning('请先上传 PDF'); return }
  if (!wc.text.trim()) { ElMessage.warning('水印文字不能为空'); return }
  processing.value = true; clearPreview()
  try {
    const buf = await rawFile.value.arrayBuffer(); const pdfDoc = await PDFDocument.load(buf)
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica); const pages = pdfDoc.getPages(); const c = hex2rgb(wc.color)
    for (const page of pages) {
      const {width,height} = page.getSize()
      page.drawText(wc.text, { x: width/2-(wc.text.length*wc.fontSize)/4, y: height/2, size: wc.fontSize, font, color: rgb(c.r,c.g,c.b), opacity: wc.opacity, rotate: degrees(wc.rotation) })
    }
    const bytes = await pdfDoc.save(); const blob = new Blob([bytes],{type:'application/pdf'}); const url = URL.createObjectURL(blob)
    if (download) { const a = document.createElement('a'); a.href = url; a.download = `watermarked_${fileName.value}`; a.click(); URL.revokeObjectURL(url); ElMessage.success('已下载！') }
    else {
      const pdf = await pdfjsLib.getDocument({data:bytes,useSystemFonts:true}).promise
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n); const vp = page.getViewport({scale:1.5})
        const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height
        await page.render({canvasContext:c.getContext('2d'),viewport:vp}).promise
        const b = await new Promise(r=>c.toBlob(b=>r(b),'image/jpeg',0.92))
        if (b) previewImages.value.push(URL.createObjectURL(b))
      }
      isPreviewActive.value = true; ElMessage.success('水印预览已生成！')
    }
  } catch { ElMessage.error('生成失败') }
  finally { processing.value = false }
}
onUnmounted(() => clearPreview())
</script>
<template>
  <div class="pdf-watermark-view">
    <div class="page-header"><div><h2 class="page-title"><span class="title-icon">💧</span> PDF 水印工具</h2><p class="page-desc">自定义文字水印 · 实时预览 · 纯前端合成</p></div></div>
    <el-row :gutter="20">
      <el-col :xs="24" :md="12"><div class="col-wrap">
        <el-upload drag :auto-upload="false" :show-file-list="false" :on-change="handleFileChange" accept="application/pdf" class="upload-area">
          <div class="upload-placeholder"><el-icon :size="36"><UploadFilled /></el-icon><span>拖拽 PDF 文件</span><span class="upload-hint">仅支持单个 PDF</span></div>
        </el-upload>
        <div v-if="!rawFile" class="empty-card"><el-icon :size="28"><Document /></el-icon><span>请上传 PDF</span></div>
        <div v-if="rawFile" class="info-card">
          <div class="info-row"><span class="info-label">文件名称</span><span class="info-value">{{ fileName }}</span></div>
          <div class="info-row"><span class="info-label">总页数</span><span class="info-value highlight">{{ totalPages }} 页</span></div>
        </div>
        <div v-if="rawFile" class="config-card">
          <h4>水印配置</h4>
          <div class="config-field"><label>文字内容</label><el-input v-model="wc.text" size="large" placeholder="输入水印文字" clearable /></div>
          <div style="display:flex;gap:12px"><div class="config-field" style="flex:1"><label>大小</label><el-input-number v-model="wc.fontSize" :min="12" :max="120" :step="4" size="large" controls-position="right" style="width:100%" /></div><div class="config-field" style="flex:1"><label>角度</label><el-input-number v-model="wc.rotation" :min="-90" :max="90" :step="15" size="large" controls-position="right" style="width:100%" /></div></div>
          <div style="display:flex;gap:12px"><div class="config-field" style="flex:1"><label>透明度</label><el-slider v-model="wc.opacity" :min="0.1" :max="1" :step="0.1" /></div><div class="config-field" style="flex:1"><label>颜色</label><el-color-picker v-model="wc.color" show-alpha size="large" style="width:100%" /></div></div>
          <div style="display:flex;gap:10px"><el-button type="primary" size="large" :loading="processing" :disabled="!rawFile" style="flex:1" @click="handleGenerateWatermark(false)">{{ processing ? '生成中…' : '生成水印预览' }}</el-button>
          <el-button size="large" :loading="processing" :disabled="!rawFile" style="flex:1" @click="handleGenerateWatermark(true)">生成并下载</el-button></div>
          <el-button v-if="previewImages.length" size="small" text type="warning" style="margin-top:4px" @click="clearPreview">清空预览</el-button>
        </div>
      </div></el-col>
      <el-col :xs="0" :md="12"><div class="col-wrap">
        <div class="preview-card"><div class="section-title-row"><h3 class="section-title">水印预览</h3><el-button v-if="previewImages.length" size="small" text type="warning" @click="clearPreview">清空</el-button></div>
          <div class="preview-box">
            <div v-if="previewImages.length" class="image-list"><div v-for="(url,i) in previewImages" :key="i" class="image-item"><img :src="url" class="preview-img" /><div class="image-footer">第 {{ i+1 }} 页</div></div></div>
            <div v-else class="preview-empty"><el-icon :size="36"><Picture /></el-icon><span>配置水印后点击生成预览</span></div>
          </div>
        </div>
      </div></el-col>
    </el-row>
    <el-dialog v-model="isPreviewActive" fullscreen :close-on-click-modal="false" :show-close="true" @close="clearPreview" class="mobile-preview-dialog" destroy-on-close>
      <template #header><span>水印效果 · {{ fileName }}</span></template>
      <div class="mobile-preview-body"><div v-for="(url,i) in previewImages" :key="i" class="mobile-image-item"><img :src="url" class="mobile-preview-img" /><div>第 {{ i+1 }} 页</div></div></div>
    </el-dialog>
  </div>
</template>
<style scoped>
.pdf-watermark-view { max-width: 1200px; margin:0 auto; padding:20px 16px 40px; }
.page-header { margin-bottom:20px; }
.title-icon { margin-right: 8px; }
.page-title { font-size:1.4rem; font-weight:400; color:var(--text-heading); margin:0 0 4px; letter-spacing:1px; }
.page-desc { color:var(--text-muted); font-size:0.85rem; margin:0; }
.col-wrap { display:flex; flex-direction:column; gap:14px; }
.upload-area { width:100%; }
:deep(.el-upload-dragger) { background:var(--bg-card); border:2px dashed var(--border-color); border-radius:10px; padding:20px; }
:deep(.el-upload-dragger:hover) { border-color:var(--accent-blue); }
.upload-placeholder { display:flex; flex-direction:column; align-items:center; gap:6px; color:var(--text-secondary); }
.upload-hint { color:var(--text-muted); font-size:0.75rem; }
.empty-card { display:flex; flex-direction:column; align-items:center; gap:8px; padding:40px; color:var(--text-dim); background:var(--bg-card); border-radius:10px; border:1px solid var(--border-color); }
.info-card { background:var(--bg-card); border-radius:10px; border:1px solid var(--border-color); padding:16px; display:flex; flex-direction:column; gap:8px; }
.info-row { display:flex; justify-content:space-between; align-items:center; padding:4px 0; border-bottom:1px solid var(--bg-hover); }
.info-label { color:var(--text-secondary); font-size:0.82rem; }
.info-value { color:var(--text-primary); font-size:0.82rem; text-align:right; }
.info-value.highlight { color:var(--accent-gold); font-weight:500; }
.config-card { background:var(--bg-card); border-radius:10px; border:1px solid var(--border-color); padding:16px; display:flex; flex-direction:column; gap:10px; }
.config-card h4 { color:var(--text-heading); font-size:0.88rem; font-weight:500; margin:0; }
.config-field { display:flex; flex-direction:column; gap:4px; }
.config-field label { color:var(--text-secondary); font-size:0.78rem; }
.preview-card { background:var(--bg-card); border-radius:12px; border:1px solid var(--border-color); padding:16px; display:flex; flex-direction:column; }
.section-title-row { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
.section-title { color:var(--text-heading); font-size:0.85rem; font-weight:500; margin:0; }
.preview-box { max-height:550px; width:100%; overflow-y:auto; background:var(--bg-canvas); border-radius:8px; min-height:200px; }
.image-list { display:flex; flex-direction:column; gap:12px; padding:12px; }
.image-item { background:var(--bg-card); border-radius:8px; overflow:hidden; border:1px solid var(--border-color); }
.preview-img { width:100%; display:block; }
.image-footer { padding:6px 12px; color:var(--text-secondary); font-size:0.78rem; border-top:1px solid var(--bg-hover); }
.preview-empty { display:flex; flex-direction:column; align-items:center; gap:10px; padding:80px 20px; color:var(--text-dim); }
:deep(.mobile-preview-dialog .el-dialog__body) { padding:0; background:var(--bg-canvas); height:calc(100vh - 110px); overflow-y:auto; }
:deep(.mobile-preview-dialog .el-dialog) { background:var(--bg-canvas); }
:deep(.mobile-preview-dialog .el-dialog__header) { background:var(--bg-card); border-bottom:1px solid var(--bg-hover); padding:14px 20px; margin:0; }
:deep(.mobile-preview-dialog .el-dialog__headerbtn) { top:14px; right:16px; }
.mobile-preview-body { padding:16px; display:flex; flex-direction:column; gap:12px; }
.mobile-image-item { background:var(--bg-card); border-radius:8px; overflow:hidden; border:1px solid var(--border-color); }
.mobile-preview-img { width:100%; display:block; }
.preview-box::-webkit-scrollbar, .mobile-preview-body::-webkit-scrollbar { width:4px; }
.preview-box::-webkit-scrollbar-thumb, .mobile-preview-body::-webkit-scrollbar-thumb { background:var(--text-placeholder); border-radius:2px; }
@media (max-width:768px) { .pdf-watermark-view { padding:12px 8px 30px; } }
</style>

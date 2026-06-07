<script setup>
import { ref, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import * as pdfjsLib from 'pdfjs-dist'
import { PDFDocument, degrees } from 'pdf-lib'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'
pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker()

const mode = ref('none')
const rawFile = ref(null); const fileName = ref(''); const fileSize = ref(''); const totalPages = ref(0)
const pageCards = ref([]); const processing = ref(false)

async function handleFileChange(uploadFile) {
  const file = uploadFile.raw; if (!file || file.type !== 'application/pdf') { ElMessage.warning('请选择 PDF'); return }
  rawFile.value = file; fileName.value = file.name; fileSize.value = (file.size/1024/1024).toFixed(2)+' MB'; clearPageCards()
  processing.value = true
  try {
    const buf = await file.arrayBuffer(); const pdf = await pdfjsLib.getDocument({ data: buf, useSystemFonts: true }).promise
    totalPages.value = pdf.numPages
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i); const vp = page.getViewport({ scale: 0.5 })
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise
      pageCards.value.push({ id: Date.now()+Math.random(), pageIndex: i-1, targetRotation: 0, imgUrl: c.toDataURL('image/jpeg',0.8) })
    }
    ElMessage.success(`已载入 ${pdf.numPages} 页`)
  } catch { ElMessage.error('PDF 解析失败') }
  finally { processing.value = false }
}
function rotatePageCard(i) { pageCards.value[i].targetRotation = (pageCards.value[i].targetRotation+90)%360 }
function deletePageCard(i) { pageCards.value.splice(i,1) }
function movePageCard(i,d) { const t=i+d; if(t<0||t>=pageCards.value.length) return; [pageCards.value[i],pageCards.value[t]]=[pageCards.value[t],pageCards.value[i]] }
function clearPageCards() { pageCards.value = []; totalPages.value = 0 }
async function handleExportEditedPDF() {
  if (!pageCards.value.length) { ElMessage.warning('编辑区无页面'); return }
  processing.value = true
  try {
    const buf = await rawFile.value.arrayBuffer(); const src = await PDFDocument.load(buf); const pdf = await PDFDocument.create()
    for (const card of pageCards.value) {
      const [cp] = await pdf.copyPages(src, [card.pageIndex])
      if (card.targetRotation !== 0) cp.setRotation(degrees(card.targetRotation))
      pdf.addPage(cp)
    }
    const bytes = await pdf.save(); const blob = new Blob([bytes], { type: 'application/pdf' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `edited_${fileName.value||'document.pdf'}`; a.click()
    ElMessage.success('导出成功！')
  } catch { ElMessage.error('导出失败') }
  finally { processing.value = false }
}
onUnmounted(() => clearPageCards())
</script>

<template>
  <div class="pdf-page-editor-view">
    <div class="page-header"><div><h2 class="page-title">PDF 页面编辑器</h2><p class="page-desc">旋转 · 删除 · 排序 · 重组导出</p></div></div>
    <el-row :gutter="20">
      <el-col :xs="24" :md="12"><div class="col-wrap">
        <el-upload drag :auto-upload="false" :show-file-list="false" :on-change="handleFileChange" accept="application/pdf" class="upload-area">
          <div class="upload-placeholder"><el-icon :size="36"><UploadFilled /></el-icon><span>拖拽 PDF 文件</span><span class="upload-hint">仅支持单个 PDF</span></div>
        </el-upload>
        <div v-if="!rawFile" class="empty-card"><el-icon :size="28"><Document /></el-icon><span>请上传 PDF</span></div>
        <div v-if="rawFile" class="info-card">
          <div class="info-row"><span class="info-label">文件名称</span><span class="info-value">{{ fileName }}</span></div>
          <div class="info-row"><span class="info-label">当前卡片</span><span class="info-value highlight">{{ pageCards.length }} / {{ totalPages }} 页</span></div>
          <el-button type="primary" size="large" :loading="processing" :disabled="!pageCards.length" class="action-btn" @click="handleExportEditedPDF">{{ processing ? '导出中…' : '导出重组 PDF' }}</el-button>
          <el-button v-if="pageCards.length" size="small" text type="warning" style="margin-top:4px" @click="clearPageCards">清空</el-button>
        </div>
        <div v-if="processing && !pageCards.length" class="progress-bar"><el-icon class="is-loading"><Loading /></el-icon><span>渲染缩略图…</span></div>
      </div></el-col>
      <el-col :xs="24" :md="12"><div class="col-wrap">
        <div class="editor-card"><div class="section-title-row"><h3 class="section-title">编辑舞台</h3></div>
          <div class="editor-box">
            <div v-if="pageCards.length" class="card-grid">
              <div v-for="(card,idx) in pageCards" :key="card.id" class="page-card">
                <img :src="card.imgUrl" :style="{transform:'rotate('+card.targetRotation+'deg)'}" class="card-thumb" />
                <div class="card-overlay"><el-button size="small" text class="overlay-btn" @click="rotatePageCard(idx)">🔄</el-button><el-button size="small" text class="overlay-btn" @click="deletePageCard(idx)">🗑️</el-button></div>
                <div class="card-footer"><span>#{{ idx+1 }}</span><span v-if="card.targetRotation" class="card-rotation-badge">{{ card.targetRotation }}°</span>
                  <div class="card-move"><el-button size="small" text :disabled="idx===0" @click="movePageCard(idx,-1)">⬆</el-button><el-button size="small" text :disabled="idx===pageCards.length-1" @click="movePageCard(idx,1)">⬇</el-button></div>
                </div>
              </div>
            </div>
            <div v-else class="editor-empty"><el-icon :size="36"><Picture /></el-icon><span>上传后页面显示在这里</span></div>
          </div>
        </div>
      </div></el-col>
    </el-row>
  </div>
</template>

<style scoped>
.pdf-page-editor-view { max-width: 1200px; margin: 0 auto; padding: 20px 16px 40px; }
.page-header { margin-bottom: 20px; }
.page-title { font-size: 1.4rem; font-weight: 400; color: var(--text-heading); margin: 0 0 4px; letter-spacing: 1px; }
.page-desc { color: var(--text-muted); font-size: 0.85rem; margin: 0; line-height: 1.5; }
.col-wrap { display: flex; flex-direction: column; gap: 14px; }
.upload-area { width: 100%; }
:deep(.el-upload-dragger) { background: var(--bg-card); border: 2px dashed var(--border-color); border-radius: 10px; padding: 20px; }
:deep(.el-upload-dragger:hover) { border-color: var(--accent-blue); }
.upload-placeholder { display: flex; flex-direction: column; align-items: center; gap: 6px; color: var(--text-secondary); font-size: 0.85rem; }
.upload-hint { color: var(--text-muted); font-size: 0.75rem; }
.empty-card { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 40px 20px; color: var(--text-dim); font-size: 0.85rem; background: var(--bg-card); border-radius: 10px; border: 1px solid var(--border-color); }
.info-card { background: var(--bg-card); border-radius: 10px; border: 1px solid var(--border-color); padding: 16px; display: flex; flex-direction: column; gap: 8px; }
.info-row { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; border-bottom: 1px solid var(--bg-hover); }
.info-label { color: var(--text-secondary); font-size: 0.82rem; }
.info-value { color: var(--text-primary); font-size: 0.82rem; text-align: right; }
.info-value.highlight { color: var(--accent-gold); font-weight: 500; }
.action-btn { width: 100%; }
.progress-bar { display: flex; align-items: center; gap: 8px; padding: 12px 14px; background: var(--bg-ctrl); border-radius: 8px; color: var(--accent-gold); font-size: 0.82rem; }
.editor-card { background: var(--bg-card); border-radius: 12px; border: 1px solid var(--border-color); padding: 16px; display: flex; flex-direction: column; }
.section-title-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.section-title { color: var(--text-heading); font-size: 0.85rem; font-weight: 500; margin: 0; }
.editor-box { max-height: 550px; width: 100%; overflow-y: auto; background: var(--bg-canvas); border-radius: 8px; min-height: 200px; }
.card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; padding: 12px; }
.page-card { background: var(--bg-card); border-radius: 8px; border: 1px solid var(--border-color); overflow: hidden; position: relative; }
.page-card:hover { border-color: var(--accent-blue); }
.card-thumb { width: 100%; display: block; transition: transform 0.3s; }
.card-overlay { position: absolute; top: 6px; right: 6px; display: flex; gap: 4px; opacity: 0; transition: opacity 0.2s; }
.page-card:hover .card-overlay { opacity: 1; }
.overlay-btn { background: rgba(0,0,0,0.7) !important; color: #fff !important; padding: 2px 6px !important; border-radius: 4px !important; }
.card-footer { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-top: 1px solid var(--bg-hover); color: var(--text-secondary); font-size: 0.75rem; }
.card-rotation-badge { color: var(--accent-gold); font-size: 0.7rem; background: var(--bg-ctrl); padding: 0 5px; border-radius: 3px; }
.card-move { display: flex; gap: 2px; margin-left: auto; }
.editor-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 80px 20px; color: var(--text-dim); }
.editor-box::-webkit-scrollbar { width: 4px; }
.editor-box::-webkit-scrollbar-thumb { background: var(--text-placeholder); border-radius: 2px; }
@media (max-width: 768px) { .pdf-page-editor-view { padding: 12px 8px 30px; } .card-grid { grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; } .card-overlay { opacity: 1; } }
</style>

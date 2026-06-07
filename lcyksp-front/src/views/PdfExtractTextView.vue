<script setup>
import { ref, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import * as pdfjsLib from 'pdfjs-dist'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'
import { PDFDocument } from 'pdf-lib'

pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker()

const mode = ref('none')
const rawFile = ref(null)
const fileName = ref('')
const fileSize = ref('')
const totalPages = ref(0)
const extractedPages = ref([])
const isResultActive = ref(false)
const extracting = ref(false)

async function handleFileChange(uploadFile) {
  const file = uploadFile.raw
  if (!file || file.type !== 'application/pdf') { ElMessage.warning('请选择 PDF 文件'); return }
  rawFile.value = file; fileName.value = file.name; fileSize.value = (file.size/1024/1024).toFixed(2)+' MB'
  extractedPages.value = []; isResultActive.value = false
  try {
    const buf = await file.arrayBuffer()
    const pdf = await pdfjsLib.getDocument({ data: buf, useSystemFonts: true }).promise
    totalPages.value = pdf.numPages; ElMessage.success(`共 ${pdf.numPages} 页`)
  } catch { ElMessage.error('PDF 解析失败') }
}

function handleCloseResult() { extractedPages.value = []; isResultActive.value = false }

async function handleExtractText() {
  if (!rawFile.value) { ElMessage.warning('请先上传 PDF'); return }
  extracting.value = true; extractedPages.value = []
  try {
    const buf = await rawFile.value.arrayBuffer()
    const pdf = await pdfjsLib.getDocument({ data: buf, useSystemFonts: true }).promise
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i)
      const tc = await page.getTextContent()
      const txt = tc.items.map(it => it.str).join(' ')
      extractedPages.value.push({ pageNum: i, text: txt.trim() || '（本页无文字内容）' })
    }
    isResultActive.value = true; ElMessage.success(`全部 ${pdf.numPages} 页提取成功！`)
  } catch { ElMessage.error('提取失败') }
  finally { extracting.value = false }
}

function copyPageText(text) {
  if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).then(()=>ElMessage.success('已复制')).catch(()=>ElMessage.error('复制失败')) 
  } else {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select()
    try { document.execCommand('copy'); ElMessage.success('已复制') } catch { ElMessage.error('复制失败') }
    document.body.removeChild(ta)
  }
}

function exportToTxtFile() {
  if (!extractedPages.value.length) return
  const txt = extractedPages.value.map(p => `--- 第 ${p.pageNum} 页 ---\n${p.text}\n`).join('\n')
  const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' })
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
  a.download = `${fileName.value.replace(/\.pdf$/i,'')}_extracted.txt`; a.click()
}

onUnmounted(() => { extractedPages.value = [] })
</script>

<template>
  <div class="pdf-extract-text-view">
    <div class="page-header"><div><h2 class="page-title"><span class="title-icon">📝</span> PDF 提取文本</h2><p class="page-desc">逐页提取纯文本 · 复制 · 导出 TXT</p></div></div>
    <el-row :gutter="20">
      <el-col :xs="24" :md="12"><div class="col-wrap">
        <el-upload drag :auto-upload="false" :show-file-list="false" :on-change="handleFileChange" accept="application/pdf" class="upload-area">
          <div class="upload-placeholder"><el-icon :size="36"><UploadFilled /></el-icon><span>拖拽 PDF 文件</span><span class="upload-hint">仅支持单个 PDF</span></div>
        </el-upload>
        <div v-if="!rawFile" class="empty-card"><el-icon :size="28"><Document /></el-icon><span>请上传 PDF 文件</span></div>
        <div v-if="rawFile" class="info-card">
          <div class="info-row"><span class="info-label">文件名称</span><span class="info-value">{{ fileName }}</span></div>
          <div class="info-row"><span class="info-label">文件大小</span><span class="info-value">{{ fileSize }}</span></div>
          <div class="info-row"><span class="info-label">总页数</span><span class="info-value highlight">{{ totalPages }} 页</span></div>
          <el-button type="primary" size="large" :loading="extracting" :disabled="!rawFile" class="action-btn" @click="handleExtractText">{{ extracting ? '提取中…' : '提取全部文本' }}</el-button>
          <el-button v-if="extractedPages.length > 0" size="small" text type="warning" style="margin-top:4px" @click="handleCloseResult">清空结果</el-button>
          <el-button v-if="extractedPages.length > 0" size="large" class="export-btn" style="margin-top:4px" @click="exportToTxtFile">导出 TXT</el-button>
        </div>
        <div v-if="extracting" class="progress-bar"><el-icon class="is-loading"><Loading /></el-icon><span>正在逐页提取…</span></div>
      </div></el-col>
      <el-col :xs="0" :md="12"><div class="col-wrap">
        <div class="result-card"><div class="section-title-row"><h3 class="section-title">提取结果</h3><el-button v-if="extractedPages.length > 0" size="small" text type="warning" @click="handleCloseResult">清空</el-button></div>
          <div class="result-box">
            <div v-if="extractedPages.length > 0" class="text-list">
              <div v-for="page in extractedPages" :key="page.pageNum" class="text-item">
                <div class="text-header"><span>第 {{ page.pageNum }} 页</span><el-button size="small" text @click="copyPageText(page.text)">复制</el-button></div>
                <div class="text-content">{{ page.text }}</div>
              </div>
            </div>
            <div v-else class="result-empty"><el-icon :size="36"><Document /></el-icon><span>点击「提取全部文本」</span></div>
          </div>
        </div>
      </div></el-col>
    </el-row>
    <el-dialog v-model="isResultActive" fullscreen :close-on-click-modal="false" :show-close="true" @close="handleCloseResult" class="mobile-result-dialog" destroy-on-close>
      <template #header><span>文本提取结果</span></template>
      <div class="mobile-result-body">
        <div v-for="page in extractedPages" :key="page.pageNum" class="text-item">
          <div class="text-header"><span>第 {{ page.pageNum }} 页</span><el-button size="small" text @click="copyPageText(page.text)">复制</el-button></div>
          <div class="text-content">{{ page.text }}</div>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.pdf-extract-text-view { max-width: 1200px; margin: 0 auto; padding: 20px 16px 40px; }
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
.info-card { background: var(--bg-card); border-radius: 10px; border: 1px solid var(--border-color); padding: 16px; display: flex; flex-direction: column; gap: 8px; }
.info-row { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; border-bottom: 1px solid var(--bg-hover); }
.info-label { color: var(--text-secondary); font-size: 0.82rem; }
.info-value { color: var(--text-primary); font-size: 0.82rem; text-align: right; word-break: break-all; }
.info-value.highlight { color: var(--accent-gold); font-weight: 500; }
.action-btn { width: 100%; }
.export-btn { width: 100%; }
.progress-bar { display: flex; align-items: center; gap: 8px; padding: 12px 14px; background: var(--bg-ctrl); border-radius: 8px; color: var(--accent-gold); font-size: 0.82rem; }
.result-card { background: var(--bg-card); border-radius: 12px; border: 1px solid var(--border-color); padding: 16px; display: flex; flex-direction: column; }
.section-title-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.section-title { color: var(--text-heading); font-size: 0.85rem; font-weight: 500; margin: 0; }
.result-box { max-height: 600px; width: 100%; overflow-y: auto; background: var(--bg-canvas); border-radius: 8px; min-height: 200px; }
.text-list { display: flex; flex-direction: column; gap: 12px; padding: 12px; }
.text-item { background: var(--bg-card); border-radius: 8px; border: 1px solid var(--border-color); overflow: hidden; }
.text-header { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--bg-hover); color: var(--accent-gold); font-size: 0.78rem; }
.text-content { padding: 12px; color: var(--text-primary); font-size: 0.82rem; line-height: 1.7; white-space: pre-wrap; word-break: break-word; }
.result-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 80px 20px; color: var(--text-dim); }
:deep(.mobile-result-dialog .el-dialog__body) { padding: 0; background: var(--bg-canvas); height: calc(100vh - 110px); overflow-y: auto; }
:deep(.mobile-result-dialog .el-dialog) { background: var(--bg-canvas); }
:deep(.mobile-result-dialog .el-dialog__header) { background: var(--bg-card); border-bottom: 1px solid var(--bg-hover); padding: 14px 20px; margin: 0; }
:deep(.mobile-result-dialog .el-dialog__headerbtn) { top: 14px; right: 16px; }
.mobile-result-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.result-box::-webkit-scrollbar, .mobile-result-body::-webkit-scrollbar { width: 4px; }
.result-box::-webkit-scrollbar-thumb, .mobile-result-body::-webkit-scrollbar-thumb { background: var(--text-placeholder); border-radius: 2px; }
@media (max-width: 768px) { .pdf-extract-text-view { padding: 12px 8px 30px; } }
</style>

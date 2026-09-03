<script setup>
import { ref, computed, onUnmounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import * as pdfjsLib from 'pdfjs-dist'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'
import { Document, Download, Loading, Picture, UploadFilled } from '@element-plus/icons-vue'

pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker()

const mode = ref('none')
const rawFile = ref(null)
const fileName = ref('')
const totalPages = ref(0)
const imageResults = ref([])
const converting = ref(false)
const previewUrl = ref('')
const previewIndex = ref(-1)
const isPreviewActive = ref(false)
const qualityMode = ref('hd')
const imageFormat = ref('png')

const scaleMap = { normal: 1, hd: 2, ultra: 3 }
const currentScale = computed(() => scaleMap[qualityMode.value] || 2)
const formatMap = { png: { mime: 'image/png', ext: 'png' }, jpg: { mime: 'image/jpeg', ext: 'jpg' } }
const currentFormat = computed(() => formatMap[imageFormat.value] || formatMap.png)

async function handleFileChange(uploadFile) {
  const file = uploadFile.raw
  if (!file) return
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) { ElMessage.warning('请选择 PDF 文件'); return }
  clearResults()
  rawFile.value = file; fileName.value = file.name; totalPages.value = 0
  try {
    const buf = await file.arrayBuffer()
    const pdf = await pdfjsLib.getDocument({ data: buf, useSystemFonts: true }).promise
    totalPages.value = pdf.numPages
    ElMessage.success(`PDF 已载入，共 ${pdf.numPages} 页`)
  } catch (err) { console.error(err); ElMessage.error('PDF 解析失败'); rawFile.value = null; fileName.value = '' }
}

function clearResults() {
  imageResults.value.forEach(i => URL.revokeObjectURL(i.url))
  imageResults.value = []; previewUrl.value = ''; previewIndex.value = -1; isPreviewActive.value = false
}

async function handleConvertPdfToImages() {
  if (!rawFile.value) { ElMessage.warning('请先上传 PDF 文件'); return }
  converting.value = true; clearResults()
  try {
    const buf = await rawFile.value.arrayBuffer()
    const pdf = await pdfjsLib.getDocument({ data: buf, useSystemFonts: true }).promise
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n)
      const vp = page.getViewport({ scale: currentScale.value })
      const c = document.createElement('canvas')
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height)
      const ctx = c.getContext('2d', { alpha: imageFormat.value === 'png' })
      if (imageFormat.value === 'jpg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height) }
      await page.render({ canvasContext: ctx, viewport: vp }).promise
      const blob = await new Promise(r => c.toBlob(b => r(b), currentFormat.value.mime, imageFormat.value === 'jpg' ? 0.95 : undefined))
      if (blob) imageResults.value.push({ page: n, url: URL.createObjectURL(blob) })
    }
    if (imageResults.value.length > 0) ElMessage.success(`成功转换 ${imageResults.value.length} 页`)
    else ElMessage.error('所有页面转换失败')
  } catch (err) { console.error(err); ElMessage.error('转换失败') }
  finally { converting.value = false }
}

function downloadSingleImage(url, page) {
  const a = document.createElement('a')
  a.href = url; a.download = `page_${page}_${(fileName.value||'download').replace(/\.pdf$/i,'')}.${currentFormat.value.ext}`
  a.click()
}

function openPreview(url, idx) { previewUrl.value = url; previewIndex.value = idx; isPreviewActive.value = true }
function handleClosePreview() { isPreviewActive.value = false }

onUnmounted(() => { imageResults.value.forEach(i => URL.revokeObjectURL(i.url)) })
</script>

<template>
  <div class="pdf-to-img-view">
    <div class="page-header">
      <div><h2 class="page-title"><span class="title-icon">📸</span> PDF 转图片</h2><p class="page-desc">支持 1x / 2x / 3x 清晰度，PNG / JPG 输出</p></div>
    </div>
    <el-row :gutter="20">
      <el-col :xs="24" :md="12">
        <div class="col-wrap">
          <el-upload drag :auto-upload="false" :show-file-list="false" :on-change="handleFileChange" accept="application/pdf,.pdf" class="upload-area">
            <div class="upload-placeholder"><el-icon :size="36"><UploadFilled /></el-icon><span>拖拽 PDF 到这里</span><span class="upload-hint">仅支持单个 PDF</span></div>
          </el-upload>
          <div v-if="!rawFile" class="empty-card"><el-icon :size="28"><Document /></el-icon><span>请上传 PDF 文件</span></div>
          <div v-if="rawFile" class="info-card">
            <div class="info-row"><span class="info-label">文件名称</span><span class="info-value">{{ fileName }}</span></div>
            <div class="info-row"><span class="info-label">总页数</span><span class="info-value highlight">{{ totalPages }} 页</span></div>
            <div class="option-block"><div class="option-title">清晰度</div>
              <el-radio-group v-model="qualityMode" class="option-group">
                <el-radio value="normal">普通 1x</el-radio><el-radio value="hd">高清 2x</el-radio><el-radio value="ultra">超清 3x</el-radio>
              </el-radio-group>
            </div>
            <div class="option-block"><div class="option-title">格式</div>
              <el-radio-group v-model="imageFormat" class="option-group">
                <el-radio value="png">PNG</el-radio><el-radio value="jpg">JPG</el-radio>
              </el-radio-group>
            </div>
            <el-button type="primary" size="large" :loading="converting" :disabled="!rawFile" class="action-btn" @click="handleConvertPdfToImages">{{ converting ? '转换中…' : '转换并生成图片' }}</el-button>
            <el-button v-if="imageResults.length > 0" size="small" text type="warning" style="margin-top:4px" @click="clearResults">清空结果</el-button>
          </div>
          <div v-if="converting" class="progress-bar"><el-icon class="is-loading"><Loading /></el-icon><span>正在逐页渲染…</span></div>
          <div v-if="imageResults.length > 0" class="result-info"><span>已生成 {{ imageResults.length }} 张 {{ currentFormat.ext.toUpperCase() }}</span></div>
        </div>
      </el-col>
      <el-col :xs="24" :md="12">
        <div class="col-wrap">
          <div class="preview-card">
            <div class="section-title-row"><h3 class="section-title">图片结果</h3>
              <el-button v-if="imageResults.length > 0" size="small" text type="warning" @click="clearResults">清空结果</el-button>
            </div>
            <div class="result-box">
              <div v-if="imageResults.length > 0" class="image-grid">
                <div v-for="item in imageResults" :key="item.page" class="image-item">
                  <img :src="item.url" class="result-img" @click="openPreview(item.url, imageResults.indexOf(item))" />
                  <div class="image-item-footer"><span>第 {{ item.page }} 页</span>
                    <el-button size="small" text @click="downloadSingleImage(item.url, item.page)"><el-icon><Download /></el-icon></el-button>
                  </div>
                </div>
              </div>
              <div v-else class="preview-empty"><el-icon :size="36"><Picture /></el-icon><span>选择清晰度和格式后，点击转换</span></div>
            </div>
          </div>
        </div>
      </el-col>
    </el-row>
    <el-dialog v-model="isPreviewActive" fullscreen :close-on-click-modal="false" :show-close="true" @close="handleClosePreview" class="mobile-preview-dialog" destroy-on-close>
      <template #header><span>第 {{ previewIndex >= 0 ? imageResults[previewIndex]?.page : '' }} 页</span></template>
      <div class="mobile-preview-body"><img v-if="previewUrl" :src="previewUrl" class="mobile-preview-img" /></div>
    </el-dialog>
  </div>
</template>

<style scoped>
.pdf-to-img-view { max-width: 1200px; margin: 0 auto; padding: 20px 16px 40px; }
.page-header { margin-bottom: 20px; }
.page-title { font-size: 1.4rem; font-weight: 400; color: var(--text-heading); margin: 0 0 4px; letter-spacing: 1px; }
.title-icon { margin-right: 8px; }
.page-desc { color: var(--text-muted); font-size: 0.85rem; margin: 0; line-height: 1.5; }
.col-wrap { display: flex; flex-direction: column; gap: 14px; }
.upload-area { width: 100%; }
:deep(.el-upload-dragger) { background: var(--bg-card); border: 2px dashed var(--border-color); border-radius: 10px; padding: 20px; }
:deep(.el-upload-dragger:hover) { border-color: var(--accent-blue); }
.upload-placeholder { display: flex; flex-direction: column; align-items: center; gap: 6px; color: var(--text-secondary); font-size: 0.85rem; }
.upload-hint { color: var(--text-muted); font-size: 0.75rem; }
.empty-card { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 40px 20px; color: var(--text-dim); font-size: 0.85rem; background: var(--bg-card); border-radius: 10px; border: 1px solid var(--border-color); }
.info-card { background: var(--bg-card); border-radius: 10px; border: 1px solid var(--border-color); padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.info-row { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; border-bottom: 1px solid var(--bg-hover); }
.info-row:last-of-type { border-bottom: none; }
.info-label { color: var(--text-secondary); font-size: 0.82rem; }
.info-value { color: var(--text-primary); font-size: 0.82rem; word-break: break-all; text-align: right; }
.info-value.highlight { color: var(--accent-gold); font-weight: 500; }
.option-block { background: var(--bg-ctrl); border: 1px solid var(--border-color); border-radius: 8px; padding: 12px 14px; }
.option-title { color: var(--text-heading); font-size: 0.82rem; font-weight: 600; margin-bottom: 10px; }
.option-group { display: flex; flex-wrap: wrap; gap: 10px 18px; }
.action-btn { width: 100%; }
.progress-bar { display: flex; align-items: center; gap: 8px; padding: 12px 14px; background: var(--bg-ctrl); border-radius: 8px; color: var(--accent-gold); font-size: 0.82rem; }
.result-info { padding: 4px 0; color: var(--text-secondary); font-size: 0.82rem; }
.preview-card { background: var(--bg-card); border-radius: 12px; border: 1px solid var(--border-color); padding: 16px; display: flex; flex-direction: column; }
.section-title-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; gap: 8px; }
.section-title { color: var(--text-heading); font-size: 0.85rem; font-weight: 500; margin: 0; }
.result-box { max-height: 600px; width: 100%; overflow-y: auto; background: var(--bg-canvas); border-radius: 8px; min-height: 200px; }
.image-grid { display: flex; flex-direction: column; gap: 12px; padding: 12px; }
.image-item { background: var(--bg-card); border-radius: 8px; overflow: hidden; border: 1px solid var(--border-color); }
.result-img { width: 100%; display: block; cursor: pointer; }
.image-item-footer { display: flex; justify-content: space-between; align-items: center; padding: 6px 12px; border-top: 1px solid var(--bg-hover); color: var(--text-secondary); font-size: 0.78rem; }
.preview-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 80px 20px; color: var(--text-dim); font-size: 0.85rem; text-align: center; }
:deep(.mobile-preview-dialog .el-dialog__body) { padding: 0; background: var(--bg-canvas); height: calc(100vh - 110px); display: flex; justify-content: center; align-items: center; }
:deep(.mobile-preview-dialog .el-dialog) { background: var(--bg-canvas); }
:deep(.mobile-preview-dialog .el-dialog__header) { background: var(--bg-card); border-bottom: 1px solid var(--bg-hover); padding: 14px 20px; margin: 0; }
:deep(.mobile-preview-dialog .el-dialog__headerbtn) { top: 14px; right: 16px; }
.mobile-preview-body { width: 100%; height: 100%; display: flex; justify-content: center; align-items: center; overflow: auto; }
.mobile-preview-img { max-width: 100%; max-height: 100%; object-fit: contain; }
.result-box::-webkit-scrollbar { width: 4px; }
.result-box::-webkit-scrollbar-thumb { background: var(--text-placeholder); border-radius: 2px; }
@media (max-width: 768px) { .pdf-to-img-view { padding: 12px 8px 30px; } .option-group { gap: 8px 12px; } }
</style>

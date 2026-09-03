<script setup>
import { ref, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { PDFDocument } from 'pdf-lib'
import { Document, Picture, UploadFilled, View } from '@element-plus/icons-vue'

const mode = ref('none')
const rawFile = ref(null)
const fileName = ref('')
const fileSize = ref('')
const totalPages = ref(0)
const previewUrl = ref('')
const isPreviewActive = ref(false)
const splitting = ref(false)
const splitRange = ref('')

async function handleFileChange(uploadFile) {
  const file = uploadFile.raw
  if (!file) return
  if (file.type !== 'application/pdf') { ElMessage.warning('只能上传 PDF 文件'); return }
  rawFile.value = file
  fileName.value = file.name
  fileSize.value = (file.size / 1024 / 1024).toFixed(2) + ' MB'
  try {
    const buf = await file.arrayBuffer()
    const pdf = await PDFDocument.load(buf)
    totalPages.value = pdf.getPageCount()
    splitRange.value = `1-${totalPages.value}`
    ElMessage.success(`解析成功，共 ${totalPages.value} 页`)
  } catch { ElMessage.error('PDF 解析失败') }
}

function handleOpenPreview() {
  if (!rawFile.value) return
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = URL.createObjectURL(rawFile.value)
  isPreviewActive.value = true
}

function handleClosePreview() {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = ''
  isPreviewActive.value = false
}

function parsePageRange(rangeStr, maxPage) {
  const pages = []; const parts = rangeStr.split(/[,，]/)
  for (let part of parts) {
    part = part.trim(); if (!part) continue
    if (part.includes('-')) {
      const [s, e] = part.split('-').map(Number)
      if (isNaN(s) || isNaN(e) || s < 1 || e > maxPage || s > e) throw new Error('无效范围: ' + part)
      for (let i = s; i <= e; i++) pages.push(i - 1)
    } else {
      const n = Number(part)
      if (isNaN(n) || n < 1 || n > maxPage) throw new Error('无效页码: ' + part)
      pages.push(n - 1)
    }
  }
  return pages
}

async function handleSplitPDF() {
  if (!rawFile.value) { ElMessage.warning('请先上传 PDF 文件'); return }
  if (!splitRange.value.trim()) { ElMessage.warning('请输入页码范围'); return }
  splitting.value = true
  try {
    const indices = parsePageRange(splitRange.value, totalPages.value)
    if (indices.length === 0) { ElMessage.warning('未提取到有效页码'); return }
    const buf = await rawFile.value.arrayBuffer()
    const src = await PDFDocument.load(buf)
    const pdf = await PDFDocument.create()
    const pages = await pdf.copyPages(src, indices)
    pages.forEach(p => pdf.addPage(p))
    const bytes = await pdf.save()
    const blob = new Blob([bytes], { type: 'application/pdf' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `split_${fileName.value}`
    link.click()
    ElMessage.success(`拆分成功！共 ${indices.length} 页`)
  } catch (err) { ElMessage.error(err.message || '拆分失败') }
  finally { splitting.value = false }
}

onUnmounted(() => { if (previewUrl.value) URL.revokeObjectURL(previewUrl.value) })
</script>

<template>
  <div class="pdf-split-view">
    <div class="page-header">
      <div><h2 class="page-title"><span class="title-icon">✂️</span> PDF 拆分</h2>
      <p class="page-desc">纯前端 PDF 页面提取 · 自定义页码范围 · 本地即时预览</p></div>
    </div>
    <el-row :gutter="20">
      <el-col :xs="24" :md="12">
        <div class="col-wrap">
          <el-upload drag :auto-upload="false" :show-file-list="false" :on-change="handleFileChange" accept="application/pdf" class="upload-area">
            <div class="upload-placeholder"><el-icon :size="36"><UploadFilled /></el-icon><span>拖拽 PDF 文件到此处</span><span class="upload-hint">仅支持单个 PDF 文件</span></div>
          </el-upload>
          <div v-if="!rawFile" class="empty-card"><el-icon :size="28"><Document /></el-icon><span>请上传一个 PDF 文件</span></div>
          <div v-if="rawFile" class="info-card">
            <div class="info-row"><span class="info-label">文件名称</span><span class="info-value">{{ fileName }}</span></div>
            <div class="info-row"><span class="info-label">文件大小</span><span class="info-value">{{ fileSize }}</span></div>
            <div class="info-row"><span class="info-label">总页数</span><span class="info-value highlight">{{ totalPages }} 页</span></div>
            <el-button size="small" text type="primary" class="preview-btn" @click="handleOpenPreview"><el-icon><View /></el-icon> 打开预览</el-button>
          </div>
          <div v-if="rawFile" class="split-config-card">
            <label class="config-label">页码范围</label>
            <p class="config-hint">支持 1-3, 5, 7-9 格式</p>
            <el-input v-model="splitRange" :placeholder="`1-${totalPages}`" size="large" clearable class="range-input" />
          </div>
          <el-button v-if="rawFile" type="primary" size="large" :loading="splitting" :disabled="!splitRange.trim()" class="split-btn" @click="handleSplitPDF">{{ splitting ? '拆分中…' : '执行拆分并下载' }}</el-button>
        </div>
      </el-col>
      <el-col :xs="0" :md="12">
        <div class="col-wrap">
          <div class="preview-card">
            <div class="section-title-row"><h3 class="section-title">PDF 预览</h3>
              <el-button v-if="isPreviewActive" size="small" text type="warning" @click="handleClosePreview">关闭预览</el-button>
            </div>
            <div class="preview-box">
              <iframe v-if="isPreviewActive && previewUrl" :src="previewUrl" class="preview-iframe" title="PDF 预览" />
              <div v-else class="preview-empty"><el-icon :size="36"><Picture /></el-icon><span>请上传 PDF 后预览</span></div>
            </div>
          </div>
        </div>
      </el-col>
    </el-row>
    <el-dialog v-model="isPreviewActive" fullscreen :close-on-click-modal="false" :show-close="true" @close="handleClosePreview" class="mobile-preview-dialog" destroy-on-close>
      <template #header><span style="color:var(--text-heading);font-size:0.95rem;">PDF 预览：{{ fileName }}</span></template>
      <iframe v-if="previewUrl" :src="previewUrl" class="mobile-preview-iframe" title="PDF 预览" />
    </el-dialog>
  </div>
</template>

<style scoped>
.pdf-split-view { max-width: 1200px; margin: 0 auto; padding: 20px 16px 40px; }
.page-header { margin-bottom: 20px; }
.page-title { font-size: 1.4rem; font-weight: 400; color: var(--text-heading); margin: 0 0 4px; letter-spacing: 1px; }
.title-icon { margin-right: 8px; }
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
.info-value { color: var(--text-primary); font-size: 0.82rem; text-align: right; }
.info-value.highlight { color: var(--accent-gold); font-weight: 500; }
.preview-btn { align-self: flex-start; }
.split-config-card { background: var(--bg-card); border-radius: 10px; border: 1px solid var(--border-color); padding: 16px; display: flex; flex-direction: column; gap: 8px; }
.config-label { color: var(--text-heading); font-size: 0.88rem; font-weight: 500; }
.config-hint { color: var(--text-muted); font-size: 0.75rem; margin: 0; }
.range-input { width: 100%; }
:deep(.range-input .el-input__wrapper) { background: var(--bg-input); box-shadow: 0 0 0 1px var(--border-color) inset; }
.split-btn { width: 100%; }
.preview-card { background: var(--bg-card); border-radius: 12px; border: 1px solid var(--border-color); padding: 16px; display: flex; flex-direction: column; }
.section-title-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.section-title { color: var(--text-heading); font-size: 0.85rem; font-weight: 500; margin: 0; }
.preview-box { max-height: 450px; width: 100%; overflow: hidden; background: var(--bg-canvas); border-radius: 8px; min-height: 200px; display: flex; justify-content: center; align-items: center; }
.preview-iframe { width: 100%; height: 450px; border: none; border-radius: 8px; }
.preview-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 80px 20px; color: var(--text-dim); font-size: 0.85rem; }
:deep(.mobile-preview-dialog .el-dialog__body) { padding: 0; background: var(--bg-canvas); height: calc(100vh - 110px); }
:deep(.mobile-preview-dialog .el-dialog) { background: var(--bg-canvas); }
:deep(.mobile-preview-dialog .el-dialog__header) { background: var(--bg-card); border-bottom: 1px solid var(--bg-hover); padding: 14px 20px; margin: 0; }
:deep(.mobile-preview-dialog .el-dialog__headerbtn) { top: 14px; right: 16px; }
.mobile-preview-iframe { width: 100%; height: 100%; border: none; display: block; }
@media (max-width: 768px) { .pdf-split-view { padding: 12px 8px 30px; } }
</style>

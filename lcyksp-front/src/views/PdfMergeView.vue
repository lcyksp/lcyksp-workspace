<script setup>
import { ref, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { PDFDocument } from 'pdf-lib'

const mode = ref('none')
const fileList = ref([])
const previewUrl = ref('')
const currentPreviewId = ref(null)
const isPreviewActive = ref(false)
const merging = ref(false)

function handleFileChange(uploadFile) {
 const raw = uploadFile.raw
 if (!raw) return
 if (raw.type !== 'application/pdf') {
 ElMessage.warning('只能上传 PDF 格式的文件')
 return
 }
 fileList.value.push({
 id: Date.now() + Math.random(),
 name: raw.name,
 size: (raw.size / 1024 / 1024).toFixed(2) + ' MB',
 rawFile: raw,
 })
}

function handlePreview(file) {
 if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
 currentPreviewId.value = file.id
 previewUrl.value = URL.createObjectURL(file.rawFile)
 isPreviewActive.value = true
}

function handleClosePreview() {
 if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
 previewUrl.value = ''
 currentPreviewId.value = null
 isPreviewActive.value = false
}

function moveItem(index, direction) {
 const target = index + direction
 if (target < 0 || target >= fileList.value.length) return
 const temp = fileList.value[index]
 fileList.value[index] = fileList.value[target]
 fileList.value[target] = temp
}

function deleteItem(index) {
 if (fileList.value[index]?.id === currentPreviewId.value) handleClosePreview()
 fileList.value.splice(index, 1)
}

async function handleMergePDFs() {
 if (fileList.value.length < 2) {
 ElMessage.warning('请至少上传两个 PDF 文件')
 return
 }
 merging.value = true
 try {
 const mergedPdf = await PDFDocument.create()
 for (const item of fileList.value) {
 const buf = await item.rawFile.arrayBuffer()
 const src = await PDFDocument.load(buf, { ignoreEncryption: true })
 const pages = await mergedPdf.copyPages(src, src.getPageIndices())
 pages.forEach(p => mergedPdf.addPage(p))
 }
 const bytes = await mergedPdf.save()
 const blob = new Blob([bytes], { type: 'application/pdf' })
 const link = document.createElement('a')
 link.href = URL.createObjectURL(blob)
 link.download = `lcyksp_merged_${Date.now()}.pdf`
 link.click()
 ElMessage.success(`合并成功！共 ${fileList.value.length} 个文件`)
 } catch (err) {
 console.error(err)
 ElMessage.error('合并失败，请检查 PDF 文件是否正常')
 } finally {
 merging.value = false
 }
}

onUnmounted(() => {
 if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
})
</script>

<template>
 <div class="pdf-merge-view">
 <div class="page-header">
 <div>
 <h2 class="page-title"><span class="title-icon">📄</span> PDF 合并</h2>
 <p class="page-desc">纯前端合并多个 PDF · 拖拽排序 · 本地即时预览 · 不上传任何文件</p>
 </div>
 </div>

 <el-row :gutter="20">
 <el-col :xs="24" :md="12">
 <div class="col-wrap">

 <el-upload drag multiple :auto-upload="false" :show-file-list="false"
 :on-change="handleFileChange"
 accept="application/pdf" class="upload-area">
 <div class="upload-placeholder">
 <el-icon :size="36"><UploadFilled />></el-icon>
 <span>拖拽 PDF 文件到此处，或点击选择</span>
 <span class="upload-hint">支持批量选择多个 PDF</span>
 </div>
 </el-upload>

 <div v-if="fileList.length === 0" class="empty-list">
 <el-icon :size="28"><Document /></el-icon>
 <span>请上传至少 2 个 PDF 文件后合并</span>
 </div>

 <div v-if="fileList.length > 0" class="file-list-card">
 <div class="list-header"><span class="list-count">共 {{ fileList.length }} 个文件</span></div>
 <div v-for="(file, index) in fileList" :key="file.id"
 class="file-row" :class="{ 'is-previewing': file.id === currentPreviewId }">
 <span class="file-idx">{{ index + 1 }}</span>
 <el-icon class="file-icon"><Document /></el-icon>
 <span class="file-name">{{ file.name }}</span>
 <span class="file-size">{{ file.size }}</span>
 <div class="file-btns">
 <el-button size="small" text @click="handlePreview(file)" title="预览"><el-icon><View /></el-icon></el-button>
 <el-button size="small" text :disabled="index===0" @click="moveItem(index, -1)" title="上移"><el-icon><ArrowUp /></el-icon></el-button>
 <el-button size="small" text :disabled="index===fileList.length-1" @click="moveItem(index, 1)" title="下移"><el-icon><ArrowDown /></el-icon></el-button>
 <el-button size="small" text type="danger" @click="deleteItem(index)" title="删除"><el-icon><Delete /></el-icon></el-button>
 </div>
 </div>
 </div>

 <div v-if="merging" class="progress-bar">
 <el-icon class="is-loading"><Loading /></el-icon><span>正在合并…</span>
 </div>

 <el-button v-if="fileList.length > 0" type="primary" size="large"
 :loading="merging" :disabled="fileList.length < 2" class="merge-btn"
 @click="handleMergePDFs">
 {{ merging ? '合并中…' : '合并所有 PDF 并下载' }}
 </el-button>
 </div>
 </el-col>

 <el-col :xs="0" :md="12">
 <div class="col-wrap">
 <div class="preview-card">
 <div class="section-title-row">
 <h3 class="section-title">文件预览</h3>
 <el-button v-if="isPreviewActive" size="small" text type="warning" @click="handleClosePreview">关闭预览</el-button>
 </div>
 <div class="preview-box">
 <iframe v-if="isPreviewActive && previewUrl" :src="previewUrl" class="preview-iframe" title="PDF 预览" />
 <div v-else class="preview-empty">
 <el-icon :size="36"><Picture /></el-icon>
 <span>请点击左侧文件进行预览</span>
 </div>
 </div>
 </div>
 </div>
 </el-col>
 </el-row>

 <el-dialog v-model="isPreviewActive" fullscreen :close-on-click-modal="false" :show-close="true"
 @close="handleClosePreview" class="mobile-preview-dialog" destroy-on-close>
 <template #header>
 <span style="color:#c0c0e0; font-size:0.95rem; letter-spacing:1px;">
 PDF 预览：{{ fileList.find(f => f.id === currentPreviewId)?.name || '' }}
 </span>
 </template>
 <iframe v-if="previewUrl" :src="previewUrl" class="mobile-preview-iframe" title="PDF 预览" />
 </el-dialog>
 </div>
</template>

<style scoped>
.pdf-merge-view { max-width: 1200px; margin: 0 auto; padding: 20px 16px 40px; }
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
.empty-list { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 40px 20px; color: var(--text-dim); font-size: 0.85rem; background: var(--bg-card); border-radius: 10px; border: 1px solid var(--border-color); }
.file-list-card { background: var(--bg-card); border-radius: 10px; border: 1px solid var(--border-color); overflow: hidden; }
.list-header { padding: 10px 14px; border-bottom: 1px solid var(--bg-hover); }
.list-count { color: var(--text-secondary); font-size: 0.82rem; }
.file-row { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--bg-hover); border-left: 3px solid transparent; transition: background 0.15s; }
.file-row:hover { background: var(--bg-hover); }
.file-row.is-previewing { border-left-color: var(--accent-blue); background: var(--bg-ctrl); }
.file-row:last-child { border-bottom: none; }
.file-idx { color: var(--text-muted); font-size: 0.75rem; min-width: 20px; text-align: center; font-family: monospace; }
.file-icon { color: var(--accent-red); flex-shrink: 0; }
.file-name { flex: 1; color: var(--text-primary); font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-size { color: var(--text-muted); font-size: 0.75rem; flex-shrink: 0; min-width: 60px; text-align: right; }
.file-btns { display: flex; gap: 0; flex-shrink: 0; }
.progress-bar { display: flex; align-items: center; gap: 8px; padding: 12px 14px; background: var(--bg-ctrl); border-radius: 8px; color: var(--accent-gold); font-size: 0.82rem; }
.merge-btn { width: 100%; }
.preview-card { background: var(--bg-card); border-radius: 12px; border: 1px solid var(--border-color); padding: 16px; display: flex; flex-direction: column; }
.section-title-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.section-title { color: var(--text-heading); font-size: 0.85rem; font-weight: 500; margin: 0; }
.preview-box { max-height: 450px; width: 100%; overflow: hidden; background: var(--bg-canvas); border-radius: 8px; display: flex; justify-content: center; align-items: center; min-height: 200px; }
.preview-iframe { width: 100%; height: 450px; border: none; border-radius: 8px; }
.preview-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 80px 20px; color: var(--text-dim); font-size: 0.85rem; }
:deep(.mobile-preview-dialog .el-dialog__body) { padding: 0; background: var(--bg-canvas); height: calc(100vh - 110px); }
:deep(.mobile-preview-dialog .el-dialog) { background: var(--bg-canvas); }
:deep(.mobile-preview-dialog .el-dialog__header) { background: var(--bg-card); border-bottom: 1px solid var(--bg-hover); padding: 14px 20px; margin: 0; }
:deep(.mobile-preview-dialog .el-dialog__headerbtn) { top: 14px; right: 16px; }
.mobile-preview-iframe { width: 100%; height: 100%; border: none; display: block; }
@media (max-width: 768px) { .pdf-merge-view { padding: 12px 8px 30px; } }
</style>

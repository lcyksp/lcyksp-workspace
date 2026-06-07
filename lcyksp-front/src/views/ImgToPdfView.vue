<script setup>
import { ref, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { PDFDocument } from 'pdf-lib'

const mode = ref('none')
const fileList = ref([])
const previewUrl = ref('')
const isPreviewActive = ref(false)
const generating = ref(false)

function handleFileChange(uploadFile) {
  const file = uploadFile.raw
  if (!file || !file.type.startsWith('image/')) { ElMessage.warning('请选择图片文件'); return }
  fileList.value.push({ id: Date.now() + Math.random(), name: file.name, rawFile: file, previewSrc: URL.createObjectURL(file) })
}

function moveItem(index, direction) {
  const t = index + direction
  if (t < 0 || t >= fileList.value.length) return
  ;[fileList.value[index], fileList.value[t]] = [fileList.value[t], fileList.value[index]]
}

function deleteItem(index) {
  URL.revokeObjectURL(fileList.value[index].previewSrc)
  fileList.value.splice(index, 1)
}

function handleClosePreview() {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = ''; isPreviewActive.value = false
}

async function handleGeneratePDF(download = false) {
  if (fileList.value.length === 0) { ElMessage.warning('请至少上传一张图片'); return }
  generating.value = true
  try {
    const pdf = await PDFDocument.create()
    for (const item of fileList.value) {
      const bytes = await item.rawFile.arrayBuffer()
      let img
      if (item.rawFile.type.includes('jpeg')) img = await pdf.embedJpg(bytes)
      else if (item.rawFile.type.includes('png')) img = await pdf.embedPng(bytes)
      else {
        const img2 = await createImageBitmap(item.rawFile)
        const c = new OffscreenCanvas(img2.width, img2.height)
        const ctx = c.getContext('2d')
        ctx.drawImage(img2, 0, 0)
        const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
        img = await pdf.embedJpg(await blob.arrayBuffer())
      }
      const { width, height } = img.scale(1)
      const page = pdf.addPage([width, height])
      page.drawImage(img, { x: 0, y: 0, width, height })
    }
    const bytes = await pdf.save()
    const blob = new Blob([bytes], { type: 'application/pdf' })
    if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
    previewUrl.value = URL.createObjectURL(blob)
    isPreviewActive.value = true
    if (download) {
      const a = document.createElement('a')
      a.href = previewUrl.value; a.download = `images_${Date.now()}.pdf`; a.click()
    }
    ElMessage.success('PDF 生成成功！')
  } catch (err) { console.error(err); ElMessage.error('转换失败') }
  finally { generating.value = false }
}

onUnmounted(() => {
  fileList.value.forEach(i => URL.revokeObjectURL(i.previewSrc))
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
})
</script>

<template>
  <div class="img-to-pdf-view">
    <div class="page-header">
      <div><h2 class="page-title"><span class="title-icon">🖼️</span> 图片转 PDF</h2><p class="page-desc">纯前端多张图片合成 PDF</p></div>
    </div>
    <el-row :gutter="20">
      <el-col :xs="24" :md="12">
        <div class="col-wrap">
          <el-upload drag multiple :auto-upload="false" :show-file-list="false" :on-change="handleFileChange" accept="image/*" class="upload-area">
            <div class="upload-placeholder"><el-icon :size="36"><UploadFilled /></el-icon><span>拖拽图片到此处</span><span class="upload-hint">JPG / PNG / WebP</span></div>
          </el-upload>
          <div v-if="fileList.length === 0" class="empty-card"><el-icon :size="28"><Picture /></el-icon><span>请上传图片</span></div>
          <div v-if="fileList.length > 0" class="file-list-card">
            <div class="list-header"><span>{{ fileList.length }} 张图片</span></div>
            <div v-for="(item, idx) in fileList" :key="item.id" class="file-row">
              <span>{{ idx + 1 }}</span>
              <img :src="item.previewSrc" class="file-thumb" />
              <span class="file-name">{{ item.name }}</span>
              <div class="file-btns">
                <el-button size="small" text :disabled="idx===0" @click="moveItem(idx, -1)">⬆</el-button>
                <el-button size="small" text :disabled="idx===fileList.length-1" @click="moveItem(idx, 1)">⬇</el-button>
                <el-button size="small" text type="danger" @click="deleteItem(idx)">🗑️</el-button>
              </div>
            </div>
          </div>
          <div v-if="generating" class="progress-bar"><el-icon class="is-loading"><Loading /></el-icon><span>生成中…</span></div>
          <div v-if="fileList.length > 0" class="btn-group">
            <el-button type="primary" :loading="generating" class="btn-flex" @click="handleGeneratePDF(false)">生成并预览</el-button>
            <el-button :loading="generating" class="btn-flex" @click="handleGeneratePDF(true)">生成并下载</el-button>
          </div>
        </div>
      </el-col>
      <el-col :xs="0" :md="12">
        <div class="col-wrap">
          <div class="preview-card">
            <div class="section-title-row"><h3 class="section-title">PDF 预览</h3><el-button v-if="isPreviewActive" size="small" text type="warning" @click="handleClosePreview">关闭</el-button></div>
            <div class="preview-box">
              <iframe v-if="isPreviewActive && previewUrl" :src="previewUrl" class="preview-iframe" />
              <div v-else class="preview-empty"><el-icon :size="36"><Picture /></el-icon><span>点击生成预览</span></div>
            </div>
          </div>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.img-to-pdf-view { max-width: 1200px; margin: 0 auto; padding: 20px 16px 40px; }
.page-header { margin-bottom: 20px; }
.title-icon { margin-right: 8px; }
.page-title { font-size: 1.4rem; color: var(--text-heading); }
.page-desc { color: var(--text-muted); font-size: 0.85rem; }
.col-wrap { display: flex; flex-direction: column; gap: 14px; }
.upload-area { width: 100%; }
:deep(.el-upload-dragger) { background: var(--bg-card); border: 2px dashed var(--border-color); border-radius: 10px; padding: 20px; }
:deep(.el-upload-dragger:hover) { border-color: var(--accent-blue); }
.upload-placeholder { display: flex; flex-direction: column; align-items: center; gap: 6px; color: var(--text-secondary); }
.upload-hint { color: var(--text-muted); font-size: 0.75rem; }
.empty-card { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 40px; color: var(--text-dim); background: var(--bg-card); border-radius: 10px; border: 1px solid var(--border-color); }
.file-list-card { background: var(--bg-card); border-radius: 10px; border: 1px solid var(--border-color); overflow: hidden; }
.list-header { padding: 10px 14px; border-bottom: 1px solid var(--bg-hover); color: var(--text-secondary); }
.file-row { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--bg-hover); }
.file-row:hover { background: var(--bg-hover); }
.file-thumb { width: 36px; height: 36px; object-fit: cover; border-radius: 4px; }
.file-name { flex: 1; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; font-size: 0.85rem; }
.file-btns { display: flex; gap: 2px; }
.progress-bar { display: flex; align-items: center; gap: 8px; padding: 12px; background: var(--bg-ctrl); border-radius: 8px; color: var(--accent-gold); }
.btn-group { display: flex; gap: 10px; }
.btn-group .btn-flex { flex: 1; }
.preview-card { background: var(--bg-card); border-radius: 12px; border: 1px solid var(--border-color); padding: 16px; }
.section-title-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.section-title { color: var(--text-heading); margin: 0; font-size: 0.85rem; }
.preview-box { max-height: 450px; width: 100%; overflow: hidden; background: var(--bg-canvas); border-radius: 8px; min-height: 200px; display: flex; justify-content: center; align-items: center; }
.preview-iframe { width: 100%; height: 450px; border: none; border-radius: 8px; }
.preview-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 80px; color: var(--text-dim); }
</style>

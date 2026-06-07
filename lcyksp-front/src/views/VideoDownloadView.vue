<script setup>
import { ref, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import axios from 'axios'

const mode = ref('none')
const videoUrl = ref(''); const videoInfo = ref(null); const selectedFormat = ref('')
const previewSrc = ref(''); const isPreviewActive = ref(false); const loading = ref(false); const downloading = ref(false)

async function handleAnalyzeLink() {
  if (!videoUrl.value.trim()) { ElMessage.warning('请输入链接'); return }
  loading.value = true; videoInfo.value = null; selectedFormat.value = ''; previewSrc.value = ''
  try {
    const res = await axios.post('/api/video/analyze', { url: videoUrl.value.trim() })
    if (res.data.success) {
      videoInfo.value = res.data.data
      if (videoInfo.value.formats?.length) selectedFormat.value = videoInfo.value.formats[0].formatId
      previewSrc.value = videoInfo.value.directPreviewUrl || ''
      isPreviewActive.value = true; ElMessage.success('解析成功！')
    } else ElMessage.error(res.data.message || '解析失败')
  } catch { ElMessage.error('网络或解析引擎异常') }
  finally { loading.value = false }
}
function handleClosePreview() { previewSrc.value = ''; videoInfo.value = null; selectedFormat.value = ''; isPreviewActive.value = false }
async function handleDownloadVideo() {
  if (!videoInfo.value || !selectedFormat.value) return; downloading.value = true
  try {
    const res = await axios({ method:'post', url:'/api/video/download', data:{url:videoUrl.value.trim(),formatId:selectedFormat.value}, responseType:'blob' })
    const blob = new Blob([res.data],{type:'video/mp4'}); const a = document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = `${videoInfo.value.title||'download'}_${selectedFormat.value}.mp4`; a.click()
    ElMessage.success('下载成功！')
  } catch { ElMessage.error('下载失败') }
  finally { downloading.value = false }
}
onUnmounted(() => { previewSrc.value = ''; videoInfo.value = null })
</script>
<template>
  <div class="video-download-view">
    <div class="page-header"><div><h2 class="page-title">短视频解析下载</h2><p class="page-desc">抖音 · Bilibili · YouTube</p></div></div>
    <el-row :gutter="20">
      <el-col :xs="24" :md="12"><div class="col-wrap">
        <div class="config-card">
          <div class="config-field"><label>视频链接</label><el-input v-model="videoUrl" size="large" placeholder="粘贴分享链接" clearable class="url-input" /></div>
          <el-button type="primary" size="large" :loading="loading" :disabled="!videoUrl.trim()" class="action-btn" @click="handleAnalyzeLink">{{ loading ? '解析中…' : '解析视频' }}</el-button>
        </div>
        <div v-if="videoInfo" class="config-card">
          <div class="info-row"><span class="info-label">标题</span><span class="info-value">{{ videoInfo.title }}</span></div>
          <div v-if="videoInfo.thumbnail" class="thumb-wrap"><img :src="videoInfo.thumbnail" class="thumb-img" /></div>
          <div class="config-field"><label>清晰度</label><el-select v-model="selectedFormat" size="large" class="format-select"><el-option v-for="f in videoInfo.formats" :key="f.formatId" :label="f.quality+' · '+f.ext+' · '+f.filesize" :value="f.formatId" /></el-select></div>
          <el-button type="primary" size="large" :loading="downloading" :disabled="!selectedFormat" class="action-btn" @click="handleDownloadVideo">{{ downloading ? '下载中…' : '下载无水印视频' }}</el-button>
          <el-button size="small" text type="warning" style="margin-top:4px" @click="handleClosePreview">清空</el-button>
        </div>
        <div v-if="loading" class="progress-bar"><el-icon class="is-loading"><Loading /></el-icon><span>正在解析…</span></div>
      </div></el-col>
      <el-col :xs="0" :md="12"><div class="col-wrap">
        <div class="preview-card"><div class="section-title-row"><h3 class="section-title">视频预览</h3><el-button v-if="isPreviewActive" size="small" text type="warning" @click="handleClosePreview">关闭</el-button></div>
          <div class="preview-box">
            <div v-if="previewSrc" class="video-wrap"><video :src="previewSrc" controls class="video-player" /></div>
            <div v-else class="preview-empty"><el-icon :size="36"><VideoCamera /></el-icon><span>解析后预览将显示在这里</span></div>
          </div>
        </div>
      </div></el-col>
    </el-row>
    <el-dialog v-model="isPreviewActive" fullscreen :close-on-click-modal="false" :show-close="true" @close="handleClosePreview" class="mobile-preview-dialog" destroy-on-close>
      <template #header><span>视频预览 · {{ videoInfo?.title||'' }}</span></template>
      <div class="mobile-video-body"><video v-if="previewSrc" :src="previewSrc" controls class="mobile-video-player" autoplay /></div>
    </el-dialog>
  </div>
</template>
<style scoped>
.video-download-view { max-width:1200px; margin:0 auto; padding:20px 16px 40px; }
.page-header { margin-bottom:20px; }
.page-title { font-size:1.4rem; font-weight:400; color:var(--text-heading); margin:0 0 4px; letter-spacing:1px; }
.page-desc { color:var(--text-muted); font-size:0.85rem; margin:0; }
.col-wrap { display:flex; flex-direction:column; gap:14px; }
.config-card { background:var(--bg-card); border-radius:10px; border:1px solid var(--border-color); padding:16px; display:flex; flex-direction:column; gap:12px; }
.config-field { display:flex; flex-direction:column; gap:6px; }
.config-field label { color:var(--text-secondary); font-size:0.78rem; }
.url-input { width:100%; }
:deep(.url-input .el-input__wrapper) { background:var(--bg-input); box-shadow:0 0 0 1px var(--border-color) inset; }
.action-btn { width:100%; }
.info-row { display:flex; flex-direction:column; gap:4px; padding:4px 0; border-bottom:1px solid var(--bg-hover); }
.info-label { color:var(--text-secondary); font-size:0.78rem; }
.info-value { color:var(--text-primary); font-size:0.82rem; word-break:break-all; }
.thumb-wrap { display:flex; justify-content:center; }
.thumb-img { max-width:100%; max-height:160px; border-radius:8px; object-fit:contain; }
.format-select { width:100%; }
.progress-bar { display:flex; align-items:center; gap:8px; padding:12px 14px; background:var(--bg-ctrl); border-radius:8px; color:var(--accent-gold); font-size:0.82rem; }
.preview-card { background:var(--bg-card); border-radius:12px; border:1px solid var(--border-color); padding:16px; display:flex; flex-direction:column; }
.section-title-row { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
.section-title { color:var(--text-heading); font-size:0.85rem; font-weight:500; margin:0; }
.preview-box { max-height:450px; width:100%; overflow:hidden; background:var(--bg-canvas); border-radius:8px; min-height:200px; display:flex; justify-content:center; align-items:center; }
.video-wrap { width:100%; height:100%; display:flex; }
.video-player { width:100%; max-height:450px; border-radius:8px; }
.preview-empty { display:flex; flex-direction:column; align-items:center; gap:10px; padding:80px 20px; color:var(--text-dim); }
:deep(.mobile-preview-dialog .el-dialog__body) { padding:0; background:var(--bg-canvas); height:calc(100vh - 110px); display:flex; justify-content:center; align-items:center; }
:deep(.mobile-preview-dialog .el-dialog) { background:var(--bg-canvas); }
:deep(.mobile-preview-dialog .el-dialog__header) { background:var(--bg-card); border-bottom:1px solid var(--bg-hover); padding:14px 20px; margin:0; }
:deep(.mobile-preview-dialog .el-dialog__headerbtn) { top:14px; right:16px; }
.mobile-video-body { width:100%; height:100%; display:flex; justify-content:center; align-items:center; }
.mobile-video-player { width:100%; max-height:100%; }
@media (max-width:768px) { .video-download-view { padding:12px 8px 30px; } }
</style>

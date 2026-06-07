<script setup>
import { computed, onUnmounted, ref } from 'vue'
import axios from 'axios'
import { ElMessage } from 'element-plus'
import { Loading, VideoCamera } from '@element-plus/icons-vue'

const videoUrl = ref('')
const videoInfo = ref(null)
const selectedFormat = ref('')
const previewSrc = ref('')
const previewType = ref('')
const isPreviewActive = ref(false)
const loading = ref(false)
const downloading = ref(false)

const hasPreview = computed(() => Boolean(previewSrc.value))
const selectedFormatMeta = computed(() => {
  return videoInfo.value?.formats?.find((item) => item.formatId === selectedFormat.value) || null
})
const isImagePreview = computed(() => previewType.value === 'image')
const imageFormats = computed(() => {
  return videoInfo.value?.formats?.filter((item) => item.mediaType === 'image') || []
})
const isAlbum = computed(() => imageFormats.value.length > 1)

async function handleAnalyzeLink() {
  if (!videoUrl.value.trim()) {
    ElMessage.warning('请先输入视频分享链接')
    return
  }

  loading.value = true
  videoInfo.value = null
  selectedFormat.value = ''
  previewSrc.value = ''
  previewType.value = ''
  isPreviewActive.value = false

  try {
    const res = await axios.post('/api/video/analyze', {
      url: videoUrl.value.trim(),
    })

    if (!res.data?.success) {
      ElMessage.error(res.data?.message || '解析失败')
      return
    }

    videoInfo.value = res.data.data
    selectedFormat.value = videoInfo.value.formats?.[0]?.formatId || ''
    previewSrc.value = videoInfo.value.formats?.[0]?.directUrl || videoInfo.value.directPreviewUrl || ''
    previewType.value = videoInfo.value.formats?.[0]?.mediaType || videoInfo.value.directPreviewType || 'video'
    ElMessage.success(res.data?.message || '解析成功')
  } catch (error) {
    const message = error.response?.data?.message || error.message || '解析失败'
    ElMessage.error(message)
  } finally {
    loading.value = false
  }
}

function clearResult() {
  videoInfo.value = null
  selectedFormat.value = ''
  previewSrc.value = ''
  previewType.value = ''
  isPreviewActive.value = false
}

function openPreview() {
  if (!previewSrc.value) return
  isPreviewActive.value = true
}

function closePreview() {
  isPreviewActive.value = false
}

function handleFormatChange(value) {
  const match = videoInfo.value?.formats?.find((item) => item.formatId === value)
  previewSrc.value = match?.directUrl || videoInfo.value?.directPreviewUrl || ''
  previewType.value = match?.mediaType || videoInfo.value?.directPreviewType || 'video'
}

async function handleDownloadVideo() {
  if (!videoInfo.value || !selectedFormat.value) {
    ElMessage.warning('请先解析并选择清晰度')
    return
  }

  downloading.value = true
  try {
    const response = await axios({
      method: 'post',
      url: '/api/video/download',
      data: {
        url: videoUrl.value.trim(),
        formatId: selectedFormat.value,
        title: videoInfo.value.title || 'download',
        browserDirectUrl: selectedFormatMeta.value?.directUrl || videoInfo.value.directPreviewUrl || '',
        browserAudioUrl: selectedFormatMeta.value?.audioUrl || '',
        source: videoInfo.value.source || 'yt-dlp',
      },
      responseType: 'blob',
      validateStatus: () => true,
    })

    const contentType = response.headers['content-type'] || ''
    if (response.status >= 400 || contentType.includes('application/json')) {
      let message = '下载失败'
      try {
        const text = await response.data.text()
        const parsed = JSON.parse(text)
        message = parsed.error || parsed.message || message
      } catch {
        // ignore
      }
      ElMessage.error(message)
      return
    }

    const blob = new Blob([response.data], { type: contentType || 'application/octet-stream' })
    const objectUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = objectUrl
    const ext = selectedFormatMeta.value?.ext || (contentType.includes('image/') ? 'jpg' : 'mp4')
    const suffix = selectedFormatMeta.value?.mediaType === 'image'
      ? selectedFormat.value.replace('browser-image-', 'image-')
      : selectedFormat.value
    link.download = `${videoInfo.value.title || 'download'}_${suffix}.${ext}`
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
    ElMessage.success('下载成功')
  } catch (error) {
    ElMessage.error(error.response?.data?.error || error.message || '下载失败')
  } finally {
    downloading.value = false
  }
}

async function handleDownloadAllImages() {
  if (!imageFormats.value.length || !videoInfo.value) {
    ElMessage.warning('当前没有可批量下载的图片')
    return
  }

  downloading.value = true
  try {
    for (const item of imageFormats.value) {
      const response = await axios({
        method: 'post',
        url: '/api/video/download',
        data: {
          url: videoUrl.value.trim(),
          formatId: item.formatId,
          title: `${videoInfo.value.title || 'download'}_${item.quality}`,
          browserDirectUrl: item.directUrl || '',
          source: videoInfo.value.source || 'yt-dlp',
        },
        responseType: 'blob',
        validateStatus: () => true,
      })

      const contentType = response.headers['content-type'] || ''
      if (response.status >= 400 || contentType.includes('application/json')) {
        let message = `${item.quality} 下载失败`
        try {
          const text = await response.data.text()
          const parsed = JSON.parse(text)
          message = parsed.error || parsed.message || message
        } catch {
          // ignore
        }
        ElMessage.error(message)
        continue
      }

      const blob = new Blob([response.data], { type: contentType || 'application/octet-stream' })
      const objectUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      const ext = item.ext || (contentType.includes('image/') ? 'jpg' : 'bin')
      link.href = objectUrl
      link.download = `${videoInfo.value.title || 'download'}_${item.quality}.${ext}`
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
      await new Promise((resolve) => setTimeout(resolve, 180))
    }

    ElMessage.success('图集下载任务已开始')
  } catch (error) {
    ElMessage.error(error.response?.data?.error || error.message || '批量下载失败')
  } finally {
    downloading.value = false
  }
}


onUnmounted(() => {
  clearResult()
})
</script>

<template>
  <div class="video-download-view">
    <div class="page-header">
      <div>
        <h2 class="page-title"><span class="title-icon">Video</span> 短视频解析下载</h2>
        <p class="page-desc">当前支持抖音和 Bilibili，YouTube 入口已暂时关闭。</p>
      </div>
    </div>

    <el-row :gutter="20">
      <el-col :xs="24" :md="12" class="panel-col">
        <div class="col-wrap col-stretch">
          <div class="config-card">
            <div class="config-field">
              <label class="config-label">视频分享链接</label>
              <el-input
                v-model="videoUrl"
                size="large"
                placeholder="粘贴抖音 / B站分享链接"
                clearable
                class="url-input"
              />
            </div>

            <el-button
              type="primary"
              size="large"
              :loading="loading"
              :disabled="!videoUrl.trim()"
              class="action-btn"
              @click="handleAnalyzeLink"
            >
              {{ loading ? '解析中...' : '解析视频' }}
            </el-button>
          </div>

          <div v-if="videoInfo" class="config-card">
            <div class="info-row">
              <span class="info-label">标题</span>
              <span class="info-value">{{ videoInfo.title }}</span>
            </div>

            <div class="info-row">
              <span class="info-label">平台</span>
              <span class="info-value">{{ videoInfo.platform || '未知' }}</span>
            </div>

            <div v-if="videoInfo.source" class="info-row">
              <span class="info-label">解析方式</span>
              <span class="info-value">{{ videoInfo.source === 'browser-automation' ? '浏览器自动化原型' : 'yt-dlp' }}</span>
            </div>

            <div v-if="videoInfo.thumbnail" class="thumb-wrap">
              <img :src="videoInfo.thumbnail" class="thumb-img" alt="缩略图" />
            </div>

            <div v-if="videoInfo.webpageUrl" class="info-row">
              <span class="info-label">来源地址</span>
              <span class="info-value">{{ videoInfo.webpageUrl }}</span>
            </div>

            <div class="config-field">
              <label class="config-label">清晰度 / 格式</label>
              <el-select v-model="selectedFormat" size="large" class="format-select" @change="handleFormatChange">
                <el-option
                  v-for="fmt in videoInfo.formats"
                  :key="fmt.formatId"
                  :label="`${fmt.quality} | ${fmt.ext} | ${fmt.filesize}${fmt.mediaType === 'image' ? ' | 图片' : fmt.hasAudio ? '' : ' | 需合并音频'}`"
                  :value="fmt.formatId"
                />
              </el-select>
            </div>

            <div class="action-group">
              <el-button
                type="primary"
                size="large"
                :loading="downloading"
                :disabled="!selectedFormat"
                class="action-btn"
                @click="handleDownloadVideo"
              >
                {{ downloading ? '下载中...' : selectedFormatMeta?.mediaType === 'image' ? '下载当前图片' : '下载视频' }}
              </el-button>

              <el-button
                v-if="isAlbum"
                size="large"
                plain
                class="secondary-btn"
                :loading="downloading"
                @click="handleDownloadAllImages"
              >
                下载全部图片
              </el-button>

              <el-button
                v-if="hasPreview"
                size="large"
                plain
                class="secondary-btn"
                @click="openPreview"
              >
                预览直链
              </el-button>
            </div>

            <el-button size="small" text type="warning" @click="clearResult">清空结果</el-button>

            <div v-if="imageFormats.length" class="album-grid">
              <button
                v-for="fmt in imageFormats"
                :key="fmt.formatId"
                type="button"
                class="album-thumb"
                :class="{ active: selectedFormat === fmt.formatId }"
                @click="selectedFormat = fmt.formatId; handleFormatChange(fmt.formatId)"
              >
                <img :src="fmt.directUrl" :alt="fmt.quality" />
                <span>{{ fmt.quality }}</span>
              </button>
            </div>
          </div>

          <div v-if="loading" class="progress-bar">
            <el-icon class="is-loading"><Loading /></el-icon>
            <span>正在解析分享链接...</span>
          </div>
        </div>
      </el-col>

      <el-col :xs="24" :md="12" class="panel-col">
        <div class="col-wrap col-stretch">
          <div class="preview-card">
            <div class="section-title-row">
              <h3 class="section-title">{{ isImagePreview ? '图片预览' : '视频预览' }}</h3>
              <el-button v-if="hasPreview" size="small" text type="warning" @click="closePreview">
                关闭弹窗
              </el-button>
            </div>

            <div class="preview-box">
              <div v-if="previewSrc" class="video-wrap">
                <img v-if="isImagePreview" :src="previewSrc" class="image-preview" alt="图片预览" />
                <video v-else :src="previewSrc" controls class="video-player" />
              </div>
              <div v-else class="preview-empty">
                <el-icon :size="36"><VideoCamera /></el-icon>
                <span>部分平台不提供直链预览，但不影响解析和下载。</span>
              </div>
            </div>
          </div>
        </div>
      </el-col>
    </el-row>

    <el-dialog
      v-model="isPreviewActive"
      fullscreen
      :close-on-click-modal="false"
      :show-close="true"
      @close="closePreview"
      class="mobile-preview-dialog"
      destroy-on-close
    >
      <template #header>
        <span class="preview-title">{{ isImagePreview ? '图片预览' : '视频预览' }} | {{ videoInfo?.title || '' }}</span>
      </template>
      <div class="mobile-video-body">
        <img v-if="previewSrc && isImagePreview" :src="previewSrc" class="mobile-image-preview" alt="图片预览" />
        <video v-else-if="previewSrc" :src="previewSrc" controls class="mobile-video-player" autoplay />
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.video-download-view { max-width: 1200px; margin: 0 auto; padding: 20px 16px 40px; }
.page-header { margin-bottom: 20px; }
.page-title { font-size: 1.4rem; font-weight: 500; color: var(--text-heading); margin: 0 0 4px; letter-spacing: 0.4px; }
.title-icon { margin-right: 8px; color: var(--accent-blue); }
.page-desc { color: var(--text-secondary); font-size: 0.92rem; margin: 0; line-height: 1.5; }
.panel-col { display: flex; }
.col-wrap { display: flex; flex-direction: column; gap: 14px; }
.col-stretch { width: 100%; }
.config-card, .preview-card { background: var(--bg-card); border-radius: 12px; border: 1px solid var(--border-color); padding: 16px; }
.config-card { display: flex; flex-direction: column; gap: 12px; }
.preview-card { display: flex; flex-direction: column; flex: 1; min-height: 100%; }
.config-field { display: flex; flex-direction: column; gap: 6px; }
.config-label, .info-label { color: var(--text-secondary); font-size: 0.8rem; }
.url-input { width: 100%; }
:deep(.url-input .el-input__wrapper), :deep(.format-select .el-select__wrapper) { background: var(--bg-input); box-shadow: 0 0 0 1px var(--border-color) inset; }
:deep(.url-input .el-input__inner) { color: var(--text-primary); }
.action-btn, .secondary-btn { width: 100%; }
.action-group { display: flex; flex-direction: column; gap: 10px; }
.album-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(88px, 1fr)); gap: 10px; }
.album-thumb { background: var(--bg-input); border: 1px solid var(--border-color); border-radius: 10px; padding: 8px; display: flex; flex-direction: column; gap: 6px; cursor: pointer; color: var(--text-primary); }
.album-thumb.active { border-color: var(--accent-blue); box-shadow: 0 0 0 1px var(--accent-blue) inset; }
.album-thumb img { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; border-radius: 8px; background: var(--bg-canvas); }
.album-thumb span { font-size: 0.78rem; line-height: 1.2; text-align: center; }
.info-row { display: flex; flex-direction: column; gap: 4px; padding: 4px 0; border-bottom: 1px solid var(--border-subtle); }
.info-row:last-child { border-bottom: none; }
.info-value { color: var(--text-primary); font-size: 0.84rem; word-break: break-all; }
.thumb-wrap { display: flex; justify-content: center; }
.thumb-img { max-width: 100%; max-height: 180px; border-radius: 8px; object-fit: contain; }
.format-select { width: 100%; }
.progress-bar { display: flex; align-items: center; gap: 8px; padding: 12px 14px; background: var(--bg-ctrl); border-radius: 8px; color: var(--accent-gold); font-size: 0.82rem; }
.section-title-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; gap: 8px; }
.section-title { color: var(--text-primary); font-size: 0.92rem; font-weight: 600; margin: 0; }
.preview-box { width: 100%; overflow: hidden; background: var(--bg-canvas); border-radius: 8px; min-height: 220px; flex: 1; display: flex; justify-content: center; align-items: center; }
.video-wrap { width: 100%; height: 100%; display: flex; }
.video-player { width: 100%; height: 100%; min-height: 220px; border-radius: 8px; }
.image-preview { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 8px; }
.preview-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 40px 20px; color: var(--text-muted); font-size: 0.85rem; text-align: center; }
.preview-title { color: var(--text-primary); font-size: 0.95rem; letter-spacing: 0.4px; }
:deep(.mobile-preview-dialog .el-dialog) { background: var(--bg-canvas); }
:deep(.mobile-preview-dialog .el-dialog__body) { padding: 0; background: var(--bg-canvas); height: calc(100vh - 110px); display: flex; justify-content: center; align-items: center; }
:deep(.mobile-preview-dialog .el-dialog__header) { background: var(--bg-card); border-bottom: 1px solid var(--border-subtle); padding: 14px 20px; margin: 0; }
:deep(.mobile-preview-dialog .el-dialog__headerbtn) { top: 14px; right: 16px; }
.mobile-video-body { width: 100%; height: 100%; display: flex; justify-content: center; align-items: center; }
.mobile-video-player { width: 100%; max-height: 100%; }
.mobile-image-preview { max-width: 100%; max-height: 100%; object-fit: contain; }
@media (max-width: 768px) {
  .video-download-view { padding: 12px 8px 30px; }
  .panel-col { display: block; }
  .preview-box { min-height: 180px; }
  .video-player { min-height: 180px; }
}
</style>

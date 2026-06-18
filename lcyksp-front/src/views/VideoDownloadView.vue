<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import axios from 'axios'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Download, Headset, Loading, Picture, VideoCamera, QuestionFilled } from '@element-plus/icons-vue'

const uiText = {
  pageTitle: '\u97f3\u89c6\u9891\u4e0b\u8f7d',
  pageDesc: '\u652f\u6301\u6296\u97f3\u89c6\u9891\u3001\u6296\u97f3\u56fe\u96c6\u548c Bilibili \u89c6\u9891\u89e3\u6790\u4e0b\u8f7d\uff0c\u89c6\u9891\u8d44\u6e90\u53ef\u5207\u6362\u4e0b\u8f7d\u5b8c\u6574\u89c6\u9891\u6216\u5355\u72ec\u97f3\u9891\u3002',
  shareUrl: '\u5206\u4eab\u94fe\u63a5',
  sharePlaceholder: '\u7c98\u8d34\u6296\u97f3\u6216 Bilibili \u5206\u4eab\u94fe\u63a5',
  analyzing: '\u89e3\u6790\u4e2d...',
  startAnalyze: '\u5f00\u59cb\u89e3\u6790',
  parseSuccess: '\u89e3\u6790\u6210\u529f',
  formatLabel: '\u4e0b\u8f7d\u683c\u5f0f',
  imageLineTitle: '\u56fe\u96c6\u4e0b\u8f7d\u7ebf\u8def',
  videoLineTitle: '\u89c6\u9891\u4e0b\u8f7d\u7ebf\u8def',
  videoLineHint: '\u5982\u679c\u5f53\u524d\u89c6\u9891\u63d0\u4f9b\u591a\u6761\u76f4\u94fe\uff0c\u53ef\u5728\u8fd9\u91cc\u5207\u6362\u3002',
  currentImage: '\u4e0b\u8f7d\u5f53\u524d\u56fe\u7247',
  allImages: '\u4e0b\u8f7d\u5168\u90e8\u56fe\u7247',
  previewLarge: '\u653e\u5927\u9884\u89c8',
  currentVideo: '\u4e0b\u8f7d\u89c6\u9891',
  currentAudio: '\u4e0b\u8f7d\u4ec5\u97f3\u9891',
  downloading: '\u4e0b\u8f7d\u4e2d...',
  audioHint: '\u5982\u679c\u4f60\u53ea\u60f3\u4fdd\u7559\u97f3\u8f68\uff0c\u53ef\u4ee5\u5728\u4e0a\u65b9\u683c\u5f0f\u5217\u8868\u4e2d\u5207\u6362\u5230\u201c\u4ec5\u97f3\u9891\u201d\u3002',
  clearResult: '\u6e05\u7a7a\u7ed3\u679c',
  previewTitleImage: '\u56fe\u7247\u9884\u89c8',
  previewTitleMedia: '\u8d44\u6e90\u9884\u89c8',
  previewHint: '\u8fd9\u91cc\u7684\u7f29\u653e\u4ec5\u5f71\u54cd\u9875\u9762\u5c55\u793a\uff0c\u4e0d\u4f1a\u6539\u53d8\u5b9e\u9645\u4e0b\u8f7d\u6216\u540e\u7aef\u6536\u5230\u7684\u539f\u59cb\u8d44\u6e90\u6570\u636e\u3002',
  closeDialog: '\u5173\u95ed\u5f39\u7a97',
  noPreview: '\u5f53\u524d\u6ca1\u6709\u53ef\u76f4\u63a5\u9884\u89c8\u7684\u8d44\u6e90\uff0c\u4f46\u8fd9\u4e0d\u4f1a\u5f71\u54cd\u89e3\u6790\u548c\u4e0b\u8f7d\u3002',
  audioOnlyMode: '\u5f53\u524d\u9009\u62e9\u7684\u662f\u4ec5\u97f3\u9891\u6a21\u5f0f',
  lineOption: '\u7ebf\u8def',
  recommended: '(\u63a8\u8350)',
  withWatermark: '(\u6709\u6c34\u5370)',
  imageAlbum: '\u56fe\u96c6',
  supportAudioOnly: '\u652f\u6301\u4ec5\u97f3\u9891',
}

const videoUrl = ref('')
const videoInfo = ref(null)
const selectedFormat = ref('')
const previewSrc = ref('')
const previewType = ref('')
const isPreviewActive = ref(false)
const loading = ref(false)
const downloading = ref(false)
const imageSourceSelections = ref({})
const selectedImageRouteIndex = ref('0')
const selectedVideoRouteUrl = ref('')

const isLoggedIn = ref(false)
const customCookie = ref('')
const saveToCloud = ref(false)

async function fetchCloudCookie() {
  try {
    const res = await axios.get('/api/video/cookie')
    if (res.data?.success && res.data.cookieJson) {
      customCookie.value = res.data.cookieJson
      saveToCloud.value = true
    }
  } catch (err) {
    console.error('获取云端Cookie失败', err)
  }
}

async function handleSaveToCloudChange(val) {
  if (!isLoggedIn.value) {
    ElMessage.warning('请先登录后再保存 Cookie 到云端')
    saveToCloud.value = false
    return
  }
  if (val) {
    if (!customCookie.value.trim()) {
      ElMessage.warning('Cookie 内容为空，无法保存')
      saveToCloud.value = false
      return
    }
    try {
      JSON.parse(customCookie.value.trim())
    } catch (e) {
      ElMessage.error('Cookie 格式错误，必须是有效的 JSON 数组')
      saveToCloud.value = false
      return
    }
    await saveCookieToCloud()
  } else {
    await deleteCookieFromCloud()
  }
}

async function saveCookieToCloud() {
  try {
    const res = await axios.post('/api/video/cookie', {
      cookieJson: customCookie.value.trim()
    })
    if (res.data?.success) {
      ElMessage.success('Cookie 已保存至云端并与您的账号绑定')
    } else {
      ElMessage.error(res.data?.message || '保存失败')
      saveToCloud.value = false
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.error || err.message || '保存失败')
    saveToCloud.value = false
  }
}

async function deleteCookieFromCloud() {
  try {
    const res = await axios.delete('/api/video/cookie')
    if (res.data?.success) {
      ElMessage.success('已清除云端绑定的 Cookie')
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.error || err.message || '清除失败')
    saveToCloud.value = true
  }
}

onMounted(async () => {
  isLoggedIn.value = !!localStorage.getItem('lcyksp_token')
  if (isLoggedIn.value) {
    await fetchCloudCookie()
  }
})

function isQuotaExceededMessage(message) {
  return /免费解析\/下载次数已用完|额度已用完/.test(String(message || ''))
}

async function showQuotaUpgradeDialog(message) {
  await ElMessageBox.alert(
    `
      <div style="line-height:1.8;color:#cfd6e6;">
        <div style="font-size:14px;margin-bottom:8px;">${message}</div>
        <div style="font-size:13px;opacity:.88;">捐赠成为高级用户后，可获得更高的解析/下载额度，也能解锁更多功能。</div>
      </div>
    `,
    '当前额度已用完',
    {
      confirmButtonText: '知道了',
      dangerouslyUseHTMLString: true,
      customClass: 'quota-upgrade-dialog',
    },
  )
  window.dispatchEvent(new CustomEvent('open-support-dialog', { detail: { reason: 'quota' } }))
}

function sanitizeDownloadName(name) {
  return String(name || 'download')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildImageSelectionsByRoute(formats = [], routeIndex = 0) {
  return formats
    .filter((item) => item.mediaType === 'image')
    .reduce((acc, item) => {
      const candidates = Array.isArray(item.sourceCandidates) ? item.sourceCandidates.filter(Boolean) : []
      acc[item.formatId] = candidates[routeIndex] || candidates[0] || item.directUrl || ''
      return acc
    }, {})
}

function resolveVideoFormatUrl(format) {
  if (!format || format.mediaType !== 'video') return format?.directUrl || ''
  const candidates = Array.isArray(format.sourceCandidates) ? format.sourceCandidates.filter(Boolean) : []
  return selectedVideoRouteUrl.value || candidates[0] || format.directUrl || ''
}

function getFormatPreviewSrc(format) {
  if (!format) return ''
  if (format.mediaType === 'image') {
    return imageSourceSelections.value[format.formatId] || format.directUrl || ''
  }
  if (format.mediaType === 'video') {
    return resolveVideoFormatUrl(format)
  }
  return format.directUrl || ''
}

const selectedFormatMeta = computed(() => {
  return videoInfo.value?.formats?.find((item) => item.formatId === selectedFormat.value) || null
})

const hasPreview = computed(() => Boolean(previewSrc.value))
const isImagePreview = computed(() => previewType.value === 'image')
const isAudioSelection = computed(() => selectedFormatMeta.value?.mediaType === 'audio')
const imageFormats = computed(() => videoInfo.value?.formats?.filter((item) => item.mediaType === 'image') || [])
const audioFormats = computed(() => videoInfo.value?.formats?.filter((item) => item.mediaType === 'audio') || [])
const videoFormats = computed(() => videoInfo.value?.formats?.filter((item) => item.mediaType === 'video') || [])
const isAlbum = computed(() => imageFormats.value.length > 1)
const unifiedImageSourceOptions = computed(() => {
  const format = imageFormats.value[0]
  const candidates = Array.isArray(format?.sourceCandidates) ? format.sourceCandidates.filter(Boolean) : []
  return candidates.map((url, index) => ({
    value: String(index),
    label: `${uiText.lineOption}${index + 1}${index === 0 ? uiText.recommended : ''}${index >= 3 ? uiText.withWatermark : ''}`,
  }))
})
const unifiedVideoSourceOptions = computed(() => {
  const format = videoFormats.value[0]
  const candidates = Array.isArray(format?.sourceCandidates) ? format.sourceCandidates.filter(Boolean) : []
  return candidates.map((url, index) => ({
    value: url,
    label: `${uiText.lineOption}${index + 1}${index === 0 ? uiText.recommended : ''}`,
  }))
})

const resultCountText = computed(() => {
  const parts = []
  if (videoFormats.value.length) parts.push(`${videoFormats.value.length} 个视频选项`)
  if (audioFormats.value.length) parts.push(`${audioFormats.value.length} 个音频选项`)
  if (imageFormats.value.length) parts.push(`${imageFormats.value.length} 张图片`)
  return parts.join(' / ')
})

function pickInitialFormat(formats = []) {
  return formats.find((item) => item.mediaType === 'video')
    || formats.find((item) => item.mediaType === 'image')
    || formats.find((item) => item.mediaType === 'audio')
    || null
}

function updatePreviewByFormat(format) {
  if (!format) {
    previewSrc.value = ''
    previewType.value = ''
    return
  }

  if (format.mediaType === 'audio') {
    const fallback = videoInfo.value?.formats?.find((item) => item.mediaType === 'video')
      || videoInfo.value?.formats?.find((item) => item.mediaType === 'image')
      || null

    previewSrc.value = fallback
      ? getFormatPreviewSrc(fallback)
      : videoInfo.value?.directPreviewUrl || ''
    previewType.value = fallback?.mediaType || 'audio'
    return
  }

  previewSrc.value = getFormatPreviewSrc(format) || videoInfo.value?.directPreviewUrl || ''
  previewType.value = format.mediaType || videoInfo.value?.directPreviewType || 'video'
}

function formatOptionLabel(fmt) {
  const typeLabel = fmt.mediaType === 'image' ? '图片' : fmt.mediaType === 'audio' ? '音频' : '视频'
  const extLabel = String(fmt.ext || '').toUpperCase()
  return `${typeLabel} | ${fmt.quality} | ${extLabel}`
}

function resetRouteSelections(formats = []) {
  selectedImageRouteIndex.value = '0'
  imageSourceSelections.value = buildImageSelectionsByRoute(formats, 0)
  const firstVideo = formats.find((item) => item.mediaType === 'video')
  const videoCandidates = Array.isArray(firstVideo?.sourceCandidates) ? firstVideo.sourceCandidates.filter(Boolean) : []
  selectedVideoRouteUrl.value = videoCandidates[0] || firstVideo?.directUrl || ''
}

async function handleAnalyzeLink() {
  if (!videoUrl.value.trim()) {
    ElMessage.warning('请先输入分享链接')
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
      customCookie: customCookie.value.trim() || undefined,
    })

    if (!res.data?.success) {
      ElMessage.error(res.data?.message || '解析失败')
      return
    }

    videoInfo.value = res.data.data
    resetRouteSelections(videoInfo.value.formats || [])
    const initialFormat = pickInitialFormat(videoInfo.value.formats || [])
    selectedFormat.value = initialFormat?.formatId || ''
    updatePreviewByFormat(initialFormat)
    ElMessage.success(res.data?.message || '解析成功')
  } catch (error) {
    const message = error.response?.data?.message || error.message || '解析失败'
    if (error.response?.status === 429 || isQuotaExceededMessage(message)) {
      await showQuotaUpgradeDialog(message)
      return
    }
    ElMessage.error(message)
  } finally {
    loading.value = false
  }
}

function handleFormatChange(value) {
  const format = videoInfo.value?.formats?.find((item) => item.formatId === value)
  updatePreviewByFormat(format)
}

function handleUnifiedImageRouteChange(value) {
  selectedImageRouteIndex.value = String(value)
  imageSourceSelections.value = buildImageSelectionsByRoute(videoInfo.value?.formats || [], Number(value))
  if (selectedFormatMeta.value?.mediaType === 'image') {
    updatePreviewByFormat(selectedFormatMeta.value)
  }
}

function handleUnifiedVideoRouteChange(value) {
  selectedVideoRouteUrl.value = value || ''
  if (selectedFormatMeta.value?.mediaType === 'video' || selectedFormatMeta.value?.mediaType === 'audio') {
    updatePreviewByFormat(selectedFormatMeta.value)
  }
}

function clearResult() {
  videoInfo.value = null
  selectedFormat.value = ''
  previewSrc.value = ''
  previewType.value = ''
  isPreviewActive.value = false
  imageSourceSelections.value = {}
  selectedImageRouteIndex.value = '0'
  selectedVideoRouteUrl.value = ''
}

function openPreview() {
  if (!previewSrc.value) return
  isPreviewActive.value = true
}

function closePreview() {
  isPreviewActive.value = false
}

async function downloadByPayload(payload, fallbackName) {
  const response = await axios({
    method: 'post',
    url: '/api/video/download',
    data: payload,
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
    throw new Error(message)
  }

  const blob = new Blob([response.data], { type: contentType || 'application/octet-stream' })
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = sanitizeDownloadName(fallbackName)
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
}

async function handleDownloadSelected() {
  if (!videoInfo.value || !selectedFormat.value || !selectedFormatMeta.value) {
    ElMessage.warning('请先完成解析并选择下载格式')
    return
  }

  downloading.value = true
  try {
    const meta = selectedFormatMeta.value
    const ext = meta.mediaType === 'image'
      ? 'jpg'
      : meta.ext || (meta.mediaType === 'audio' ? 'mp3' : 'mp4')
    const suffix = meta.mediaType === 'image'
      ? meta.quality
      : meta.mediaType === 'audio'
        ? '仅音频'
        : meta.quality
    const fallbackName = `${videoInfo.value.title || 'download'}_${suffix}.${ext}`
    const payload = {
      url: videoUrl.value.trim(),
      formatId: meta.formatId,
      title: videoInfo.value.title || 'download',
      browserDirectUrl: meta.mediaType === 'image'
        ? (imageSourceSelections.value[meta.formatId] || meta.directUrl || videoInfo.value.directPreviewUrl || '')
        : meta.mediaType === 'video'
          ? (resolveVideoFormatUrl(meta) || meta.directUrl || videoInfo.value.directPreviewUrl || '')
          : (meta.directUrl || videoInfo.value.directPreviewUrl || ''),
      browserAudioUrl: meta.audioUrl || '',
      source: videoInfo.value.source || 'yt-dlp',
      customCookie: customCookie.value.trim() || undefined,
    }
    await downloadByPayload(payload, fallbackName)

    if (meta.mediaType === 'audio') {
      ElMessage.success('音频下载成功')
    } else if (meta.mediaType === 'image') {
      ElMessage.success('图片下载成功')
    } else {
      ElMessage.success('视频下载成功')
    }
  } catch (error) {
    if (isQuotaExceededMessage(error.message)) {
      await showQuotaUpgradeDialog(error.message || '当前时段额度已用完')
      return
    }
    ElMessage.error(error.message || '下载失败')
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
      await downloadByPayload(
        {
          url: videoUrl.value.trim(),
          formatId: item.formatId,
          title: `${videoInfo.value.title || 'download'}_${item.quality}`,
          browserDirectUrl: imageSourceSelections.value[item.formatId] || item.directUrl || '',
          source: videoInfo.value.source || 'yt-dlp',
          customCookie: customCookie.value.trim() || undefined,
        },
        `${videoInfo.value.title || 'download'}_${item.quality}.jpg`,
      )
      await new Promise((resolve) => setTimeout(resolve, 180))
    }
    ElMessage.success('图集下载任务已开始')
  } catch (error) {
    if (isQuotaExceededMessage(error.message)) {
      await showQuotaUpgradeDialog(error.message || '当前时段额度已用完')
      return
    }
    ElMessage.error(error.message || '批量下载失败')
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
      <div class="page-copy">
        <h2 class="page-title"><span class="title-icon">Media</span> {{ uiText.pageTitle }}</h2>
        <p class="page-desc">{{ uiText.pageDesc }}</p>
      </div>
    </div>

    <div class="download-layout">
      <section class="left-stack">
        <div class="surface-card input-card">
          <label class="section-label">{{ uiText.shareUrl }}</label>
          <el-input
            v-model="videoUrl"
            size="large"
            :placeholder="uiText.sharePlaceholder"
            clearable
            class="url-input"
          />

          <div class="input-actions">
            <el-button
              type="primary"
              size="large"
              :loading="loading"
              :disabled="!videoUrl.trim()"
              class="primary-action"
              @click="handleAnalyzeLink"
            >
              {{ loading ? uiText.analyzing : uiText.startAnalyze }}
            </el-button>
          </div>

          <!-- 自定义 Cookie 配置 -->
          <div class="cookie-config-section">
            <el-collapse>
              <el-collapse-item name="cookie">
                <template #title>
                  <span class="cookie-collapse-title">
                    自定义 Cookie (免额度解析/下载)
                    <el-tooltip placement="top" raw-content>
                      <template #content>
                        <div style="line-height: 1.6; max-width: 320px;">
                          <strong>使用说明：</strong><br/>
                          1. 浏览器安装 <strong>Cookie-Editor</strong> 插件。<br/>
                          2. 登录 B站 (bilibili.com) 或 抖音 (douyin.com)。<br/>
                          3. 点击插件，点击右下角 <strong>Export -> JSON</strong> 导出为 JSON 格式。<br/>
                          4. 粘贴到下方文本框内。<br/>
                          5. <strong>额度说明：</strong>使用您自己的 Cookie 解析/下载<strong>不计入免费额度</strong>，使用本站 Cookie 将扣除解析额度。
                        </div>
                      </template>
                      <el-icon class="help-icon" style="margin-left: 4px; vertical-align: middle;"><QuestionFilled /></el-icon>
                    </el-tooltip>
                  </span>
                </template>
                <div class="cookie-panel-content">
                  <el-input
                    v-model="customCookie"
                    type="textarea"
                    :rows="4"
                    placeholder='粘贴 Cookie-Editor 导出的 JSON 格式 Cookie，形如：[{"domain": ".bilibili.com", "name": "SESSDATA", ...}]'
                    class="cookie-textarea"
                  />
                  <div class="cookie-actions">
                    <el-switch
                      v-model="saveToCloud"
                      active-text="储存 Cookie 到云端"
                      :disabled="!isLoggedIn"
                      @change="handleSaveToCloudChange"
                    />
                    <span v-if="!isLoggedIn" class="login-tip">请先登录以保存到云端</span>
                  </div>
                </div>
              </el-collapse-item>
            </el-collapse>
          </div>
        </div>

        <div v-if="videoInfo" class="surface-card result-card">
          <div class="result-header">
            <div class="result-copy">
              <div class="result-state">{{ uiText.parseSuccess }}</div>
              <h3 class="result-title">{{ videoInfo.title }}</h3>
              <p v-if="resultCountText" class="result-meta">{{ resultCountText }}</p>
            </div>

            <div class="result-badges">
              <span class="result-badge">{{ videoInfo.platform || 'unknown' }}</span>
              <span v-if="audioFormats.length" class="result-badge accent">{{ uiText.supportAudioOnly }}</span>
              <span v-if="isAlbum" class="result-badge warm">{{ uiText.imageAlbum }}</span>
            </div>
          </div>

          <div class="controls-grid">
            <div class="control-block">
              <label class="section-label">{{ uiText.formatLabel }}</label>
              <el-select v-model="selectedFormat" size="large" class="format-select" @change="handleFormatChange">
                <el-option
                  v-for="fmt in videoInfo.formats"
                  :key="fmt.formatId"
                  :label="formatOptionLabel(fmt)"
                  :value="fmt.formatId"
                />
              </el-select>
            </div>

            <div
              v-if="selectedFormatMeta?.mediaType === 'image' && imageFormats.length && unifiedImageSourceOptions.length"
              class="control-block source-debug-panel"
            >
              <div class="source-debug-head">
                <h4>{{ uiText.imageLineTitle }}</h4>
              </div>
              <el-select
                v-model="selectedImageRouteIndex"
                size="large"
                class="source-select"
                @change="handleUnifiedImageRouteChange"
              >
                <el-option
                  v-for="option in unifiedImageSourceOptions"
                  :key="option.value"
                  :label="option.label"
                  :value="option.value"
                />
              </el-select>
            </div>

            <div
              v-if="selectedFormatMeta?.mediaType === 'video' && videoFormats.length && unifiedVideoSourceOptions.length > 1"
              class="control-block source-debug-panel"
            >
              <div class="source-debug-head">
                <h4>{{ uiText.videoLineTitle }}</h4>
                <span>{{ uiText.videoLineHint }}</span>
              </div>
              <el-select
                v-model="selectedVideoRouteUrl"
                size="large"
                class="source-select"
                @change="handleUnifiedVideoRouteChange"
              >
                <el-option
                  v-for="option in unifiedVideoSourceOptions"
                  :key="option.value"
                  :label="option.label"
                  :value="option.value"
                />
              </el-select>
            </div>

            <div class="action-row">
              <el-button
                type="primary"
                size="large"
                :loading="downloading"
                :disabled="!selectedFormat"
                class="primary-action"
                @click="handleDownloadSelected"
              >
                <el-icon><Download /></el-icon>
                <span>
                  {{
                    downloading
                      ? uiText.downloading
                      : selectedFormatMeta?.mediaType === 'image'
                        ? uiText.currentImage
                        : selectedFormatMeta?.mediaType === 'audio'
                          ? uiText.currentAudio
                          : uiText.currentVideo
                  }}
                </span>
              </el-button>

              <el-button
                v-if="isAlbum"
                size="large"
                plain
                class="secondary-action"
                :loading="downloading"
                @click="handleDownloadAllImages"
              >
                <el-icon><Picture /></el-icon>
                <span>{{ uiText.allImages }}</span>
              </el-button>

              <el-button
                v-if="hasPreview"
                size="large"
                plain
                class="secondary-action"
                @click="openPreview"
              >
                <el-icon><VideoCamera /></el-icon>
                <span>{{ uiText.previewLarge }}</span>
              </el-button>
            </div>
          </div>

          <div v-if="audioFormats.length" class="hint-row">
            <el-icon><Headset /></el-icon>
            <span>{{ uiText.audioHint }}</span>
          </div>

          <div v-if="imageFormats.length" class="album-grid">
            <button
              v-for="fmt in imageFormats"
              :key="fmt.formatId"
              type="button"
              class="album-thumb"
              :class="{ active: selectedFormat === fmt.formatId }"
              @click="selectedFormat = fmt.formatId; handleFormatChange(fmt.formatId)"
            >
              <img :src="getFormatPreviewSrc(fmt)" :alt="fmt.quality" />
              <span>{{ fmt.quality }}</span>
            </button>
          </div>

          <div class="footer-tools">
            <el-button size="small" text type="warning" @click="clearResult">{{ uiText.clearResult }}</el-button>
          </div>
        </div>

        <div v-if="loading" class="progress-bar">
          <el-icon class="is-loading"><Loading /></el-icon>
          <span>{{ uiText.analyzing }}</span>
        </div>
      </section>

      <aside class="surface-card preview-card">
        <div class="preview-head">
          <div>
            <h3 class="preview-title">{{ isImagePreview ? uiText.previewTitleImage : uiText.previewTitleMedia }}</h3>
            <p class="preview-subtitle">{{ uiText.previewHint }}</p>
          </div>

          <el-button v-if="hasPreview" size="small" text type="warning" @click="closePreview">
            {{ uiText.closeDialog }}
          </el-button>
        </div>

        <div class="preview-box">
          <div v-if="previewSrc" class="preview-wrap">
            <img v-if="isImagePreview" :src="previewSrc" class="image-preview" :alt="uiText.previewTitleImage" />
            <div v-else-if="isAudioSelection" class="audio-preview">
              <el-icon :size="44"><Headset /></el-icon>
              <span>{{ uiText.audioOnlyMode }}</span>
            </div>
            <video v-else :src="previewSrc" controls class="video-player" playsinline />
          </div>

          <div v-else class="preview-empty">
            <el-icon :size="36"><VideoCamera /></el-icon>
            <span>{{ uiText.noPreview }}</span>
          </div>
        </div>
      </aside>
    </div>

    <el-dialog
      v-model="isPreviewActive"
      fullscreen
      :close-on-click-modal="false"
      :show-close="true"
      class="mobile-preview-dialog"
      destroy-on-close
      @close="closePreview"
    >
      <template #header>
        <span class="dialog-title">{{ isImagePreview ? uiText.previewTitleImage : uiText.previewTitleMedia }} | {{ videoInfo?.title || '' }}</span>
      </template>
      <div class="dialog-body">
        <img v-if="previewSrc && isImagePreview" :src="previewSrc" class="dialog-image" :alt="uiText.previewTitleImage" />
        <div v-else-if="isAudioSelection" class="audio-preview">
          <el-icon :size="44"><Headset /></el-icon>
          <span>{{ uiText.currentAudio }}</span>
        </div>
        <video v-else-if="previewSrc" :src="previewSrc" controls class="dialog-video" autoplay playsinline />
      </div>
    </el-dialog>
  </div>
</template>
<style scoped>
.video-download-view {
  max-width: 1240px;
  margin: 0 auto;
  padding: 20px 16px 36px;
}

.page-header {
  margin-bottom: 18px;
}

.page-copy {
  max-width: 780px;
}

.page-title {
  margin: 0 0 6px;
  font-size: 1.9rem;
  font-weight: 700;
  color: var(--text-heading);
  letter-spacing: 0.2px;
}

.title-icon {
  margin-right: 8px;
  color: var(--accent-blue);
}

.page-desc {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.96rem;
  line-height: 1.65;
}

.download-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.06fr) minmax(320px, 0.94fr);
  gap: 18px;
  align-items: start;
}

.left-stack {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.surface-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 18px;
  box-shadow: 0 16px 36px rgba(42, 89, 160, 0.08);
}

.input-card,
.result-card,
.preview-card {
  padding: 18px;
}

.preview-card {
  position: sticky;
  top: 18px;
}

.section-label {
  display: block;
  margin-bottom: 8px;
  color: var(--text-secondary);
  font-size: 0.82rem;
}

.url-input,
.format-select {
  width: 100%;
}

.input-actions {
  margin-top: 12px;
}

.primary-action,
.secondary-action {
  width: 100%;
}

.primary-action :deep(.el-icon),
.secondary-action :deep(.el-icon) {
  margin-right: 6px;
}

:deep(.url-input .el-input__wrapper),
:deep(.format-select .el-select__wrapper) {
  background: var(--bg-input);
  box-shadow: 0 0 0 1px var(--border-color) inset;
}

:deep(.url-input .el-input__inner) {
  color: var(--text-primary);
}

.result-header {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  align-items: flex-start;
  margin-bottom: 16px;
}

.result-state {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(67, 128, 236, 0.12);
  color: var(--accent-blue);
  font-size: 0.78rem;
  font-weight: 600;
  margin-bottom: 10px;
}

.result-title {
  margin: 0;
  color: var(--text-primary);
  font-size: 1.08rem;
  line-height: 1.55;
  word-break: break-word;
}

.result-meta {
  margin: 8px 0 0;
  color: var(--text-secondary);
  font-size: 0.84rem;
}

.result-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}

.result-badge {
  padding: 6px 10px;
  border-radius: 999px;
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 0.76rem;
  white-space: nowrap;
}

.result-badge.accent {
  color: var(--accent-blue);
  background: rgba(67, 128, 236, 0.12);
}

.result-badge.warm {
  color: #c48124;
  background: rgba(247, 176, 71, 0.16);
}

.controls-grid {
  display: grid;
  gap: 14px;
}

.action-row {
  display: flex;
  gap: 10px;
  align-items: stretch;
}

.action-row :deep(.el-button) {
  flex: 1;
  min-width: 0;
}

.action-row :deep(.el-button + .el-button) {
  margin-left: 0;
}

.hint-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  color: var(--text-secondary);
  font-size: 0.84rem;
  line-height: 1.55;
}

.album-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 10px;
  margin-top: 14px;
}

.album-thumb {
  border: 1px solid var(--border-color);
  border-radius: 12px;
  background: var(--bg-input);
  padding: 8px;
  cursor: pointer;
  color: var(--text-primary);
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.album-thumb.active {
  border-color: var(--accent-blue);
  box-shadow: 0 0 0 1px var(--accent-blue) inset;
}

.album-thumb img {
  width: 100%;
  aspect-ratio: 1 / 1;
  border-radius: 10px;
  object-fit: cover;
  background: var(--bg-canvas);
}

.album-thumb span {
  font-size: 0.78rem;
  text-align: center;
  line-height: 1.3;
}

.footer-tools {
  display: flex;
  justify-content: flex-end;
  margin-top: 10px;
}

.source-debug-panel {
  margin-top: 16px;
  padding: 14px;
  border-radius: 14px;
  border: 1px solid var(--border-color);
  background: rgba(255, 255, 255, 0.02);
}

.source-debug-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  margin-bottom: 8px;
}

.source-debug-head h4 {
  margin: 0;
  color: var(--text-primary);
  font-size: 0.9rem;
}

.source-debug-head span,
.source-debug-copy span {
  color: var(--text-secondary);
  font-size: 0.76rem;
}

.source-debug-list {
  display: grid;
  gap: 10px;
}

.source-debug-item {
  display: grid;
  grid-template-columns: minmax(0, 120px) minmax(0, 1fr);
  gap: 10px;
  align-items: center;
}

.source-debug-copy {
  display: grid;
  gap: 4px;
}

.source-select {
  width: 100%;
}

.progress-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 13px 14px;
  border-radius: 14px;
  background: var(--bg-ctrl);
  color: var(--accent-gold);
  font-size: 0.84rem;
}

.preview-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 12px;
}

.preview-title {
  margin: 0 0 6px;
  color: var(--text-primary);
  font-size: 1rem;
  font-weight: 600;
}

.preview-subtitle {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.82rem;
  line-height: 1.55;
}

.preview-box {
  border-radius: 16px;
  min-height: 320px;
  background: linear-gradient(180deg, rgba(229, 238, 252, 0.55), rgba(214, 228, 246, 0.28));
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

.preview-wrap {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.video-player,
.dialog-video {
  width: 100%;
  height: 100%;
  min-height: 320px;
  background: #000;
}

.image-preview,
.dialog-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.audio-preview,
.preview-empty {
  width: 100%;
  min-height: 320px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 12px;
  color: var(--text-secondary);
  padding: 28px;
  text-align: center;
}

.dialog-title {
  color: var(--text-primary);
  font-size: 0.95rem;
}

:global(.quota-upgrade-dialog .el-message-box) {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
}

:global(.quota-upgrade-dialog .el-message-box__title),
:global(.quota-upgrade-dialog .el-message-box__message) {
  color: var(--text-primary);
}

:deep(.mobile-preview-dialog .el-dialog) {
  background: var(--bg-canvas);
}

:deep(.mobile-preview-dialog .el-dialog__body) {
  padding: 0;
  background: var(--bg-canvas);
  height: calc(100vh - 110px);
}

:deep(.mobile-preview-dialog .el-dialog__header) {
  background: var(--bg-card);
  border-bottom: 1px solid var(--border-subtle);
  padding: 14px 20px;
  margin: 0;
}

.dialog-body {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

@media (max-width: 1180px) {
  .download-layout {
    grid-template-columns: 1fr;
  }

  .preview-card {
    position: static;
  }
}

@media (max-width: 900px) {
  .action-row {
    flex-direction: column;
  }

  .result-header {
    flex-direction: column;
  }

  .result-badges {
    justify-content: flex-start;
  }
}

@media (max-width: 768px) {
  .video-download-view {
    padding: 12px 8px 24px;
  }

  .page-title {
    font-size: 1.56rem;
  }

  .page-desc,
  .preview-subtitle {
    font-size: 0.88rem;
  }

  .input-card,
  .result-card,
  .preview-card {
    padding: 14px;
    border-radius: 16px;
  }

  .controls-grid {
    gap: 12px;
  }

  .source-debug-panel {
    margin-top: 0;
    padding: 12px;
  }

  .source-debug-head {
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }

  .preview-box,
  .audio-preview,
  .preview-empty,
  .video-player {
    min-height: 220px;
  }

  .album-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 520px) {
  .section-label {
    margin-bottom: 6px;
  }

  .source-debug-panel {
    padding: 10px;
    border-radius: 12px;
  }

  .album-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.cookie-config-section {
  margin-top: 18px;
  border-top: 1px dashed var(--border-color);
  padding-top: 14px;
}

.cookie-config-section :deep(.el-collapse) {
  border: none;
}

.cookie-config-section :deep(.el-collapse-item__header) {
  background: transparent;
  color: var(--text-heading);
  border: none;
  font-size: 0.88rem;
  height: 36px;
}

.cookie-config-section :deep(.el-collapse-item__wrap) {
  background: transparent;
  border: none;
}

.cookie-config-section :deep(.el-collapse-item__content) {
  padding: 8px 0 0;
  color: var(--text-secondary);
}

.cookie-collapse-title {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-weight: 600;
  color: var(--accent-blue);
  cursor: pointer;
}

.cookie-collapse-title:hover {
  opacity: 0.85;
}

.help-icon {
  color: var(--text-secondary);
  font-size: 0.95rem;
}

.cookie-panel-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.cookie-textarea :deep(.el-textarea__inner) {
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  border-radius: 8px;
  font-family: monospace;
  font-size: 0.82rem;
}

.cookie-textarea :deep(.el-textarea__inner:focus) {
  border-color: var(--accent-blue);
}

.cookie-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.cookie-actions :deep(.el-switch__label) {
  color: var(--text-secondary);
  font-size: 0.82rem;
}

.login-tip {
  font-size: 0.78rem;
  color: var(--accent-gold);
}
</style>


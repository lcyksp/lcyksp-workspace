<template>
  <div class="page-view">
    <h2 class="page-title"><span class="title-icon">🎬</span> 电视剧/电影观看</h2>
    <p class="page-desc">粘贴剧集网址，解析剧集列表并支持选集下载</p>

    <div class="page-content">
      <div class="input-section">
        <div class="input-row">
          <el-input
            v-model="inputUrl"
            placeholder="粘贴剧集地址"
            clearable
            size="large"
            @keyup.enter="analyze"
            :disabled="analyzing"
          >
            <template #prefix>
              <el-icon><Link /></el-icon>
            </template>
          </el-input>
          <el-button
            type="primary"
            size="large"
            :loading="analyzing"
            :disabled="!inputUrl.trim()"
            @click="analyze"
          >
            {{ analyzing ? '解析中...' : '解析剧集' }}
          </el-button>
        </div>
      </div>

      <transition name="fade">
        <div v-if="videoInfo" class="result-section">
          <div class="video-header">
            <img
              v-if="videoInfo.cover"
              :src="videoInfo.cover"
              class="video-cover"
              @error="onCoverError"
            />
            <div class="video-info">
              <h3 class="video-title">{{ videoInfo.title }}</h3>
              <div class="video-meta">
                <span class="video-count">共 {{ videoInfo.episodes.length }} 集</span>
                <span class="video-source">当前线路: {{ videoInfo.sourceName }}</span>
              </div>
              <div v-if="videoInfo.sources && videoInfo.sources.length > 1" class="source-select-row">
                <span class="source-label">切换线路:</span>
                <el-select
                  v-model="currentSourceIndex"
                  size="small"
                  @change="switchSource"
                >
                  <el-option
                    v-for="(s, i) in videoInfo.sources"
                    :key="i"
                    :label="s.name + ' (' + s.count + '集)'"
                    :value="i"
                  />
                </el-select>
              </div>
            </div>
          </div>

          <div class="episodes-grid">
            <div
              v-for="(ep, index) in videoInfo.episodes"
              :key="index"
              class="episode-card"
              :class="{ 'is-downloading': downloadingMap[index] }"
            >
              <span class="episode-index">{{ String(index + 1).padStart(2, '0') }}</span>
              <span class="episode-name">{{ ep.name }}</span>
              
              <!-- Download Button -->
              <el-button
                v-if="!downloadingMap[index]"
                type="primary"
                size="small"
                class="download-btn"
                @click="downloadEpisode(ep, index)"
              >
                <el-icon><Download /></el-icon>
                <span>下载</span>
              </el-button>

              <!-- Progress bar & state display when downloading -->
              <div v-else class="download-progress-block">
                <div class="progress-bar-container">
                  <div class="progress-bar-fill" :style="{ width: getPercentStr(progressMap[index]) }"></div>
                </div>
                <div class="progress-meta">
                  <span class="pct-num">{{ getPercentStr(progressMap[index]) }}</span>
                  <span class="speed-num">{{ getSpeedStr(progressMap[index]) }}</span>
                </div>
                <div class="progress-size">{{ getSizeStr(progressMap[index]) }}</div>
              </div>
            </div>
          </div>
        </div>
      </transition>

      <div v-if="error" class="error-tip">
        <el-alert :title="error" type="error" show-icon :closable="false" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { Link, Download } from '@element-plus/icons-vue'
import axios from 'axios'
import { tvDownloadManager } from '../utils/tvDownloadManager.js'

var inputUrl = ref('')
var analyzing = ref(false)
var videoInfo = ref(null)
var error = ref('')

const downloadingMap = computed(() => {
  const map = {}
  if (!videoInfo.value) return map
  const title = videoInfo.value.title || '电视剧'
  videoInfo.value.episodes.forEach((ep, index) => {
    const key = title + '_' + ep.name
    if (tvDownloadManager.activeTasks[key]) {
      map[index] = true
    }
  })
  return map
})

const progressMap = computed(() => {
  const map = {}
  if (!videoInfo.value) return map
  const title = videoInfo.value.title || '电视剧'
  videoInfo.value.episodes.forEach((ep, index) => {
    const key = title + '_' + ep.name
    const task = tvDownloadManager.activeTasks[key]
    if (task) {
      map[index] = task.progress
    }
  })
  return map
})

var currentSourceIndex = ref(0)
var allSources = ref([])

function getPercentStr(prog) {
  if (!prog) return '0%'
  var size = prog.size || ''
  var match = size.match(/^(\d+(\.\d+)?%)/)
  if (match) return match[1]
  return '0%'
}

function getSpeedStr(prog) {
  if (!prog) return '连接中...'
  return prog.speed || '0x'
}

function getSizeStr(prog) {
  if (!prog) return ''
  var size = prog.size || ''
  var match = size.match(/\(\s*([^)]+)\s*\)/)
  if (match) return match[1]
  return size
}

async function analyze() {
  var url = inputUrl.value.trim()
  if (!url) {
    ElMessage.warning('请输入剧集网址')
    return
  }

  analyzing.value = true
  error.value = ''
  videoInfo.value = null

  try {
    var res = await axios.post('/api/tv/analyze', { url: url })
    videoInfo.value = res.data
    allSources.value = res.data.sources || []
    currentSourceIndex.value = 0
    ElMessage.success('解析成功，共 ' + res.data.episodes.length + ' 集')
  } catch (err) {
    error.value = err.response?.data?.error || err.message || '解析失败'
  } finally {
    analyzing.value = false
  }
}

async function switchSource(index) {
  if (!videoInfo.value || !allSources.value[index]) return

  analyzing.value = true
  try {
    var res = await axios.post('/api/tv/analyze', {
      url: inputUrl.value.trim(),
      sourceIndex: index
    })
    videoInfo.value = res.data
    currentSourceIndex.value = index
    ElMessage.success('已切换到: ' + res.data.sourceName)
  } catch (err) {
    ElMessage.error('切换线路失败')
  } finally {
    analyzing.value = false
  }
}

function downloadEpisode(ep, index) {
  tvDownloadManager.startDownload(videoInfo.value, ep, index)
}

function onCoverError(e) {
  e.target.style.display = 'none'
}
</script>

<style scoped>
.page-view {
  max-width: 800px;
  margin: 0 auto;
  padding: 20px 16px 40px;
}

.page-title {
  font-size: 1.4rem;
  font-weight: 400;
  color: var(--text-heading);
  letter-spacing: 1px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.title-icon {
  font-size: 1.3em;
}

.page-desc {
  color: var(--text-secondary);
  font-size: 0.85rem;
  margin-top: 6px;
  margin-bottom: 0;
}

.page-content {
  background: var(--bg-card);
  border-radius: 12px;
  padding: 24px;
  margin-top: 16px;
  border: 1px solid var(--border-color);
  box-shadow: 0 18px 40px color-mix(in srgb, var(--accent-blue) 8%, transparent);
}

.input-section {
  margin-bottom: 20px;
}

.input-row {
  display: flex;
  gap: 12px;
  align-items: stretch;
}

.input-row :deep(.el-input) {
  flex: 1;
}

.input-row :deep(.el-input__wrapper) {
  background: var(--bg-ctrl);
  border: 1px solid var(--border-color);
  box-shadow: none;
  border-radius: 10px;
}

.input-row :deep(.el-input__inner) {
  color: var(--text-primary);
}

.input-row :deep(.el-input__inner::placeholder) {
  color: var(--text-muted);
}

.input-row :deep(.el-input__prefix .el-icon) {
  color: var(--text-secondary);
}

.result-section {
  margin-top: 24px;
}

.video-header {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 24px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--border-color);
}

.video-cover {
  width: 120px;
  height: 160px;
  object-fit: cover;
  border-radius: 10px;
  border: 1px solid var(--border-color);
  flex-shrink: 0;
}

.video-info {
  flex: 1;
}

.video-title {
  margin: 0 0 8px 0;
  font-size: 1.2rem;
  font-weight: 600;
  color: var(--text-heading);
  line-height: 1.4;
}

.video-meta {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

.video-count {
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.video-source {
  color: var(--accent-blue);
  font-size: 0.85rem;
}

.source-select-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.source-label {
  color: var(--text-secondary);
  font-size: 0.82rem;
  white-space: nowrap;
}

.source-select-row :deep(.el-select__wrapper) {
  background: var(--bg-ctrl);
  border: 1px solid var(--border-color);
  box-shadow: none;
  border-radius: 8px;
}

.episodes-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 12px;
}

.episode-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px;
  border-radius: 10px;
  border: 1px solid var(--border-color);
  background: var(--bg-ctrl);
  text-align: center;
  transition: all 0.2s ease;
}

.episode-card:hover {
  border-color: color-mix(in srgb, var(--accent-blue) 40%, var(--border-color));
  box-shadow: 0 4px 16px color-mix(in srgb, var(--accent-blue) 10%, transparent);
}

.episode-index {
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--accent-blue);
  opacity: 0.6;
}

.episode-name {
  font-size: 0.85rem;
  color: var(--text-primary);
  font-weight: 500;
}

.error-tip {
  margin-top: 16px;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

@media (max-width: 480px) {
  .input-row {
    flex-direction: column;
  }

  .video-cover {
    width: 80px;
    height: 110px;
  }

  .episodes-grid {
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: 8px;
  }

  .episode-card {
    padding: 10px;
  }

  .video-meta {
    flex-direction: column;
    gap: 4px;
  }
}

/* Beautiful Download Button */
.download-btn {
  width: 100%;
  border-radius: 8px;
  font-weight: 600;
  border: none !important;
  background: #3b82f6 !important;
  color: #ffffff !important;
  transition: all 0.2s ease;
}
.download-btn:hover {
  background: #2563eb !important;
  color: #ffffff !important;
}

.dark .download-btn {
  background: #4f46e5 !important;
  color: #ffffff !important;
}
.dark .download-btn:hover {
  background: #4338ca !important;
  color: #ffffff !important;
}

/* Game Loading Bar Style */
.episode-card.is-downloading {
  border-color: #3b82f6;
  box-shadow: 0 4px 16px rgba(59, 130, 246, 0.15);
}
.dark .episode-card.is-downloading {
  border-color: #4f46e5;
  box-shadow: 0 4px 16px rgba(79, 70, 229, 0.25);
}

.download-progress-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  margin-top: auto;
}

.progress-bar-container {
  width: 100%;
  height: 10px;
  background: rgba(0, 0, 0, 0.08);
  border-radius: 10px;
  overflow: hidden;
  position: relative;
  border: 1px solid rgba(0, 0, 0, 0.12);
  box-shadow: inset 0 1px 3px rgba(0,0,0,0.1);
}

.dark .progress-bar-container {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.15);
  box-shadow: inset 0 1px 3px rgba(0,0,0,0.3);
}

.progress-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, #3b82f6, #00f2fe);
  border-radius: 10px;
  transition: width 0.3s ease;
  position: relative;
}

.progress-bar-fill::after {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  background: linear-gradient(
    90deg,
    rgba(255, 255, 255, 0) 0%,
    rgba(255, 255, 255, 0.4) 50%,
    rgba(255, 255, 255, 0) 100%
  );
  animation: progress-glow 2s infinite linear;
  background-size: 200% 100%;
}

@keyframes progress-glow {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

.progress-meta {
  display: flex;
  justify-content: space-between;
  font-size: 0.8rem;
  font-weight: 700;
  color: #1e3a8a;
}

.dark .progress-meta {
  color: #00f2fe;
}

.progress-size {
  font-size: 0.72rem;
  color: var(--text-secondary);
  text-align: center;
  font-weight: 600;
}
</style>

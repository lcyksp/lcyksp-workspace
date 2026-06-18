<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { VideoPlay, VideoPause, Download, Refresh, InfoFilled } from '@element-plus/icons-vue'

const recordStatus = ref(0) // 0: Idle, 1: Requesting permission, 2: Recording, 3: Finished
const mediaRecorder = ref(null)
const recordedChunks = ref([])
const videoUrl = ref('')
const isSupported = ref(true)

// Stats & Timer
const timer = ref(0)
const timerInterval = ref(null)
const mimeType = ref('video/webm;codecs=vp9')

const formattedTime = computed(() => {
  const h = Math.floor(timer.value / 3600).toString().padStart(2, '0')
  const m = Math.floor((timer.value % 3600) / 60).toString().padStart(2, '0')
  const s = (timer.value % 60).toString().padStart(2, '0')
  return `${h}:${m}:${s}`
})

const statusText = computed(() => {
  switch (recordStatus.value) {
    case 0: return '准备就绪'
    case 1: return '等待授权分屏...'
    case 2: return '正在录屏中'
    case 3: return '录制已完成'
    default: return '未知状态'
  }
})

onMounted(() => {
  // Check browser support
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    isSupported.value = false
  }
})

onUnmounted(() => {
  stopTimer()
  if (recordStatus.value === 2) {
    stopRecord()
  }
})

function startTimer() {
  timer.value = 0
  timerInterval.value = setInterval(() => {
    timer.value++
  }, 1000)
}

function stopTimer() {
  if (timerInterval.value) {
    clearInterval(timerInterval.value)
    timerInterval.value = null
  }
}

async function startRecord() {
  if (!isSupported.value) {
    ElMessage.error('您的浏览器不支持屏幕录制，请使用 Chrome、Edge 或 Firefox 浏览器！')
    return
  }

  recordStatus.value = 1
  recordedChunks.value = []
  
  try {
    // Request screen capture
    // Include audio: true so user can check "Share system audio"
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true
    })

    // Determine supported MIME type
    let selectedMime = 'video/webm;codecs=vp9,opus'
    if (!MediaRecorder.isTypeSupported(selectedMime)) {
      selectedMime = 'video/webm;codecs=vp8,opus'
      if (!MediaRecorder.isTypeSupported(selectedMime)) {
        selectedMime = 'video/webm'
        if (!MediaRecorder.isTypeSupported(selectedMime)) {
          selectedMime = 'video/mp4' // Safari
        }
      }
    }
    mimeType.value = selectedMime

    const recorder = new MediaRecorder(stream, { mimeType: selectedMime })
    mediaRecorder.value = recorder

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        recordedChunks.value.push(e.data)
      }
    }

    recorder.onstop = () => {
      stopTimer()
      // Generate WebM blob
      const blob = new Blob(recordedChunks.value, { type: recorder.mimeType || 'video/webm' })
      if (videoUrl.value) {
        URL.revokeObjectURL(videoUrl.value)
      }
      videoUrl.value = URL.createObjectURL(blob)
      recordStatus.value = 3

      // Stop all tracks to release stream resources (e.g. system sharing bar)
      stream.getTracks().forEach(track => track.stop())
    }

    // Capture user ending screen share via browser bar
    stream.getVideoTracks()[0].onended = () => {
      if (recordStatus.value === 2) {
        stopRecord()
      }
    }

    recorder.start()
    recordStatus.value = 2
    startTimer()
    ElMessage.success('屏幕录制已开始')
  } catch (err) {
    console.error('Failed to start recording:', err)
    recordStatus.value = 0
    if (err.name === 'NotAllowedError') {
      ElMessage.warning('用户取消或拒绝了屏幕录制授权')
    } else {
      ElMessage.error('屏幕录制启动失败: ' + err.message)
    }
  }
}

function stopRecord() {
  if (mediaRecorder.value && mediaRecorder.value.state !== 'inactive') {
    mediaRecorder.value.stop()
    ElMessage.success('录屏已停止')
  }
}

function downloadVideo() {
  if (!videoUrl.value) return
  const a = document.createElement('a')
  a.href = videoUrl.value
  
  // Set filename with date
  const now = new Date()
  const dateStr = now.getFullYear() +
    ((now.getMonth() + 1).toString().padStart(2, '0')) +
    (now.getDate().toString().padStart(2, '0')) + '_' +
    (now.getHours().toString().padStart(2, '0')) +
    (now.getMinutes().toString().padStart(2, '0')) +
    (now.getSeconds().toString().padStart(2, '0'))
  
  const ext = mimeType.value.includes('mp4') ? 'mp4' : 'webm'
  a.download = `屏幕录制_${dateStr}.${ext}`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  ElMessage.success('视频文件已开始下载')
}

function resetRecord() {
  if (videoUrl.value) {
    URL.revokeObjectURL(videoUrl.value)
    videoUrl.value = ''
  }
  recordedChunks.value = []
  recordStatus.value = 0
  timer.value = 0
}
</script>

<template>
  <div class="screen-recording-view">
    <div class="page-header">
      <h2 class="page-title"><span class="title-icon">📹</span> 在线屏幕录制</h2>
      <p class="page-desc">直接在浏览器中录制屏幕内容，支持整个屏幕、指定应用窗口或浏览器标签页，无需安装任何插件，安全快捷。</p>
    </div>

    <el-alert
      v-if="!isSupported"
      title="浏览器不支持"
      type="danger"
      description="您的浏览器不支持屏幕录制（DisplayMedia API）。请使用现代电脑浏览器，如最新版 Google Chrome、Microsoft Edge 或 Mozilla Firefox。"
      show-icon
      :closable="false"
      class="support-alert"
    />

    <el-row :gutter="20" class="layout-row">
      <!-- 控制台卡片 -->
      <el-col :xs="24" :md="9">
        <div class="col-wrap">
          <div class="ctrl-card theme-surface">
            <h3 class="section-title">录制控制台</h3>
            
            <div class="status-panel" :class="'status-' + recordStatus">
              <div class="status-indicator">
                <span class="pulse-dot" v-if="recordStatus === 2"></span>
                <span class="status-badge" :class="'badge-' + recordStatus">{{ statusText }}</span>
              </div>
              <div class="timer-display">{{ formattedTime }}</div>
            </div>

            <div class="action-buttons">
              <!-- 开始录制 -->
              <el-button 
                v-if="recordStatus === 0 || recordStatus === 1" 
                type="primary" 
                :icon="VideoPlay"
                size="large"
                class="action-btn start-btn"
                :loading="recordStatus === 1"
                :disabled="!isSupported"
                @click="startRecord"
              >
                开始录制
              </el-button>

              <!-- 停止录制 -->
              <el-button 
                v-if="recordStatus === 2" 
                type="danger" 
                :icon="VideoPause"
                size="large"
                class="action-btn stop-btn animate-pulse"
                @click="stopRecord"
              >
                停止录制
              </el-button>

              <!-- 完成后的操作 -->
              <div v-if="recordStatus === 3" class="finished-actions">
                <el-button 
                  type="success" 
                  :icon="Download"
                  size="large"
                  class="action-btn download-btn"
                  @click="downloadVideo"
                >
                  下载视频
                </el-button>
                
                <el-button 
                  type="info" 
                  :icon="Refresh"
                  size="large"
                  class="action-btn reset-btn"
                  @click="resetRecord"
                >
                  重新录制
                </el-button>
              </div>
            </div>
            
            <div class="mime-info" v-if="recordStatus >= 2">
              <el-icon><InfoFilled /></el-icon>
              <span>输出格式: {{ mimeType }}</span>
            </div>
          </div>
        </div>
      </el-col>

      <!-- 视频预览卡片 -->
      <el-col :xs="24" :md="15">
        <div class="col-wrap">
          <div class="preview-card theme-surface">
            <h3 class="section-title">视频预览</h3>
            <div class="video-container">
              <video 
                v-if="videoUrl" 
                ref="videoRef" 
                :src="videoUrl" 
                controls 
                autoplay
                class="video-player"
              ></video>
              <div v-else class="empty-preview">
                <div class="empty-icon">🎥</div>
                <p class="empty-text">录制完成后的视频将在此处预览</p>
                <div class="guidelines" v-if="recordStatus === 2">
                  <div class="recording-animation">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                  <p class="recording-tip-text">正在录制中，视频预览将在停止后生成</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </el-col>
    </el-row>

    <!-- 介绍 & FAQ -->
    <el-card class="intro-card theme-surface">
      <template #header>
        <div class="card-header">
          <span>💡 工具介绍与使用指南</span>
        </div>
      </template>
      <div class="intro-content">
        <h4>如何使用：</h4>
        <ol>
          <li>点击左侧控制台中的 <strong>“开始录制”</strong> 按钮。</li>
          <li>在浏览器弹出的屏幕共享窗口中，选择您想要录制的内容：
            <ul>
              <li><strong>整个屏幕</strong>：录制整个显示器画面（支持选择是否包含系统声音）。</li>
              <li><strong>应用窗口</strong>：录制某个已打开的软件窗口（例如 PPT 或文件夹）。</li>
              <li><strong>浏览器标签页</strong>：录制当前浏览器的指定标签（支持共享标签页音频，非常适合录制网课或网页视频）。</li>
            </ul>
          </li>
          <li>选择完毕后，点击 <strong>“分享/共享”</strong> 即可开始录制。</li>
          <li>录制完成后，点击控制台的 <strong>“停止录制”</strong> 或浏览器底部的“停止共享”浮条。</li>
          <li>在右侧预览区确认满意后，点击 <strong>“下载视频”</strong> 将录像以 `.webm` (或 `.mp4`) 格式保存至本地。</li>
        </ol>

        <h4>常见问题与说明：</h4>
        <ul>
          <li><strong>安全性：</strong>本工具为纯前端应用，所有屏幕画面的采集、录制和编码均在您的<strong>本地浏览器</strong>内完成，没有任何视频数据会被上传到服务器，您可以完全放心录制隐私内容。</li>
          <li><strong>格式转换：</strong>录制默认生成为 WebM 容器格式。该格式在 Chrome、Edge 和现代播放器（如 VLC、PotPlayer 等）上拥有极佳的兼容性。若有转换为 MP4 格式的需求，可使用音视频工具一键转换。</li>
          <li><strong>声音录制：</strong>若要录制电脑播放的声音，请在选择屏幕分享时，勾选弹出框底部的 <strong>“共享系统音频”</strong> 选项。</li>
        </ul>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.screen-recording-view {
  max-width: 1200px;
  margin: 0 auto;
  padding: 20px 16px 40px;
}

.page-header {
  margin-bottom: 20px;
}

.page-title {
  margin: 0 0 4px;
  color: var(--text-heading);
  font-size: 1.4rem;
  font-weight: 500;
  letter-spacing: 0.5px;
}

.title-icon {
  margin-right: 8px;
}

.page-desc {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.85rem;
  line-height: 1.5;
}

.support-alert {
  margin-bottom: 20px;
}

.layout-row {
  margin-bottom: 20px;
}

.col-wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.ctrl-card,
.preview-card {
  border: 1px solid var(--border-color);
  border-radius: 16px;
  padding: 24px;
  display: flex;
  flex-direction: column;
  min-height: 380px;
}

.section-title {
  margin: 0 0 20px;
  font-size: 1.1rem;
  font-weight: 500;
  color: var(--text-heading);
  border-left: 4px solid var(--accent-blue);
  padding-left: 10px;
  line-height: 1.2;
}

/* 状态面板 */
.status-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--bg-ctrl);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 20px;
  transition: all 0.3s ease;
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.pulse-dot {
  width: 10px;
  height: 10px;
  background-color: var(--accent-red);
  border-radius: 50%;
  box-shadow: 0 0 0 0 rgba(231, 76, 60, 0.7);
  animation: pulse 1.2s infinite;
}

.status-badge {
  font-size: 0.85rem;
  font-weight: 500;
  padding: 4px 10px;
  border-radius: 20px;
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
}

.badge-0 { color: var(--text-secondary); }
.badge-1 { color: var(--accent-gold); }
.badge-2 { color: var(--accent-red); }
.badge-3 { color: var(--accent-green); }

.timer-display {
  font-size: 2.5rem;
  font-weight: 200;
  font-family: 'Courier New', Courier, monospace;
  color: var(--text-primary);
  letter-spacing: 2px;
}

/* 状态色块微妙发光 */
.status-2 {
  background: color-mix(in srgb, var(--accent-red) 6%, var(--bg-ctrl));
  border-color: color-mix(in srgb, var(--accent-red) 25%, var(--border-subtle));
}
.status-3 {
  background: color-mix(in srgb, var(--accent-green) 6%, var(--bg-ctrl));
  border-color: color-mix(in srgb, var(--accent-green) 25%, var(--border-subtle));
}

/* 按钮操作 */
.action-buttons {
  width: 100%;
}

.action-btn {
  width: 100%;
  height: 48px;
  font-size: 1rem;
  border-radius: 10px;
  margin-left: 0 !important;
}

.finished-actions {
  display: flex;
  gap: 12px;
}

.finished-actions .action-btn {
  flex: 1;
}

.finished-actions :deep(.el-button) + :deep(.el-button) {
  margin-left: 0 !important;
}

.mime-info {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-top: 14px;
}

/* 预览卡片 */
.video-container {
  flex: 1;
  background: var(--bg-canvas);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

.video-player {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}

.empty-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px;
  text-align: center;
  color: var(--text-muted);
}

.empty-icon {
  font-size: 3.5rem;
  margin-bottom: 12px;
  opacity: 0.35;
}

.empty-text {
  font-size: 0.9rem;
  margin: 0;
}

/* 录制中动画 */
.guidelines {
  margin-top: 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.recording-animation {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  margin-bottom: 10px;
}

.recording-animation span {
  display: inline-block;
  width: 4px;
  height: 100%;
  background-color: var(--accent-red);
  border-radius: 2px;
  animation: scale-up 1s ease-in-out infinite;
}

.recording-animation span:nth-child(2) {
  animation-delay: 0.2s;
}

.recording-animation span:nth-child(3) {
  animation-delay: 0.4s;
}

.recording-tip-text {
  font-size: 0.82rem;
  color: var(--accent-red);
  margin: 0;
  opacity: 0.95;
}

/* 介绍卡片 */
.intro-card {
  border-radius: 16px;
  border: 1px solid var(--border-color);
}

.intro-card :deep(.el-card__header) {
  border-bottom: 1px solid var(--border-color);
  font-weight: 500;
  font-size: 1rem;
  color: var(--text-heading);
}

.intro-content {
  color: var(--text-secondary);
  font-size: 0.88rem;
  line-height: 1.6;
}

.intro-content h4 {
  color: var(--text-heading);
  margin: 16px 0 8px;
  font-size: 0.95rem;
  font-weight: 500;
}

.intro-content h4:first-of-type {
  margin-top: 0;
}

.intro-content ul,
.intro-content ol {
  margin: 0;
  padding-left: 20px;
}

.intro-content li {
  margin-bottom: 6px;
}

.intro-content li strong {
  color: var(--text-primary);
}

/* Animations */
@keyframes pulse {
  0% {
    transform: scale(0.95);
    box-shadow: 0 0 0 0 rgba(231, 76, 60, 0.7);
  }
  70% {
    transform: scale(1);
    box-shadow: 0 0 0 8px rgba(231, 76, 60, 0);
  }
  100% {
    transform: scale(0.95);
    box-shadow: 0 0 0 0 rgba(231, 76, 60, 0);
  }
}

.animate-pulse {
  animation: pulse-border 1.5s infinite;
}

@keyframes pulse-border {
  0%, 100% {
    border-color: var(--accent-red);
    box-shadow: 0 0 0 0 rgba(231, 76, 60, 0.4);
  }
  50% {
    border-color: color-mix(in srgb, var(--accent-red) 50%, transparent);
    box-shadow: 0 0 8px 2px rgba(231, 76, 60, 0.2);
  }
}

@keyframes scale-up {
  0%, 100% {
    transform: scaleY(0.3);
  }
  50% {
    transform: scaleY(1);
  }
}

@media (max-width: 768px) {
  .screen-recording-view {
    padding: 12px 10px 24px;
  }
  
  .ctrl-card,
  .preview-card {
    padding: 16px;
    min-height: auto;
  }
  
  .status-panel {
    padding: 16px;
  }
  
  .timer-display {
    font-size: 2rem;
  }
  
  .video-container {
    min-height: 220px;
  }
  
  .intro-card {
    margin-top: 16px;
  }
}
</style>

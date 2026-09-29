<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { VideoPlay, VideoPause, Download, Refresh, InfoFilled, Monitor, VideoCamera, Odometer } from '@element-plus/icons-vue'

const recordStatus = ref(0) // 0: Idle, 1: Requesting permission, 2: Recording, 3: Finished
const mediaRecorder = ref(null)
const recordedChunks = ref([])
const videoUrl = ref('')
const isSupported = ref(true)

// 录制参数（仅在准备阶段可调，开始后锁定）。这些约束只喂给浏览器本地采集/编码，
// 无任何服务器开销。分辨率/帧率写进 getDisplayMedia 约束，码流写进 MediaRecorder。
const resolution = ref('source') // source | 1080 | 720 | 480
const frameRate = ref(30)
const videoBitrate = ref(4_000_000) // bps，0 表示交给浏览器默认
const finalSize = ref(0) // 录制完成后的真实字节数

// 分辨率约束表：source 不限制（用源画质），其余按 16:9 目标下采样（浏览器保持宽高比取近似）
const RESOLUTION_MAP = {
  '1440': { width: 2560, height: 1440 },
  '1080': { width: 1920, height: 1080 },
  '720': { width: 1280, height: 720 },
  '480': { width: 854, height: 480 }
}

// 捕获丢帧监控：窗口被完全遮挡时 Chromium 会把捕获钳到 ~1fps 且不做任何提示，
// 用户只会看到录出来的视频"卡在一帧"。这里实时监测交付帧率，低于阈值就明确警告。
const captureStalled = ref(false)
let frameProbeVideo = null // 隐身 <video>，消费捕获流以测量真实交付帧率
let frameTimestamps = []   // 最近交付帧的时间戳（performance.now）
let stallTimer = null
let rvfcId = null          // requestVideoFrameCallback 句柄
let stallAlerted = false   // 每次丢帧事件只弹一次 ElMessage，横幅持续显示直到恢复

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

function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return (bytes || 0) + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

// 大小显示：录制中按 码流×已录时长 估算，完成后用真实字节数。码流为 0（浏览器默认）时不估算。
const sizeDisplay = computed(() => {
  if (recordStatus.value === 3 && finalSize.value) {
    return `文件大小: ${formatBytes(finalSize.value)}`
  }
  if (recordStatus.value === 2 && videoBitrate.value) {
    const est = (videoBitrate.value / 8) * timer.value
    return `约 ${formatBytes(est)}（估算）`
  }
  return ''
})

// 每分钟大致大小（用于码流下拉说明）：bps / 8 * 60
function perMinuteSize(bps) {
  return formatBytes((bps / 8) * 60)
}

onMounted(() => {
  // Check browser support
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    isSupported.value = false
  }
})

onUnmounted(() => {
  stopTimer()
  stopFrameWatch()
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

// —— 丢帧监控 ——
// 只能用 requestVideoFrameCallback 数"真实交付帧"：Chrome 里 MediaStream 的
// currentTime 按墙钟推进（不出帧也走），getSettings().frameRate 又只回显请求值，
// 都测不出丢帧。rVFC 在页面隐藏时不触发，所以 document.hidden 期间跳过判定。
function startFrameWatch(stream) {
  if (!document.createElement('video').requestVideoFrameCallback) return // 老浏览器放弃监测

  frameProbeVideo = document.createElement('video')
  frameProbeVideo.muted = true
  frameProbeVideo.playsInline = true
  frameProbeVideo.setAttribute('style', 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none')
  frameProbeVideo.srcObject = stream
  document.body.appendChild(frameProbeVideo) // 不进 DOM 就没有 compositor 呈现，rVFC 不会触发
  frameProbeVideo.play().catch(() => {})

  frameTimestamps = []
  const startAt = performance.now()
  const countFrame = () => {
    frameTimestamps.push(performance.now())
    if (frameTimestamps.length > 200) frameTimestamps.splice(0, frameTimestamps.length - 200)
    rvfcId = frameProbeVideo.requestVideoFrameCallback(countFrame)
  }
  rvfcId = frameProbeVideo.requestVideoFrameCallback(countFrame)

  stallTimer = setInterval(() => {
    if (document.hidden) return
    const now = performance.now()
    frameTimestamps = frameTimestamps.filter(t => now - t < 4000)
    // 头 5 秒是热身期（4 秒滑动窗口还没满），不判丢帧
    const stalled = recordStatus.value === 2 && now - startAt > 5000 && frameTimestamps.length < 10 // ≈ <2.5fps
    if (stalled && !captureStalled.value) {
      captureStalled.value = true
      if (!stallAlerted) {
        stallAlerted = true
        ElMessage.warning('捕获帧率极低：被分享的窗口可能被完全遮挡，画面将被录成幻灯片', { duration: 6000 })
      }
    } else if (!stalled && captureStalled.value) {
      captureStalled.value = false
      stallAlerted = false
    }
  }, 1000)
}

function stopFrameWatch() {
  if (stallTimer) {
    clearInterval(stallTimer)
    stallTimer = null
  }
  if (frameProbeVideo) {
    if (rvfcId !== null && frameProbeVideo.cancelVideoFrameCallback) {
      try { frameProbeVideo.cancelVideoFrameCallback(rvfcId) } catch (_) { /* noop */ }
    }
    try { frameProbeVideo.srcObject = null; frameProbeVideo.remove() } catch (_) { /* noop */ }
    frameProbeVideo = null
  }
  rvfcId = null
  frameTimestamps = []
  captureStalled.value = false
  stallAlerted = false
}

async function startRecord() {
  if (!isSupported.value) {
    ElMessage.error('您的浏览器不支持屏幕录制，请使用 Chrome、Edge 或 Firefox 浏览器！')
    return
  }

  recordStatus.value = 1
  recordedChunks.value = []
  
  try {
    // 构建视频约束：帧率始终限制；分辨率非 source 时按目标下采样（用 ideal，浏览器取近似并保持宽高比）
    const videoConstraints = {
      frameRate: { ideal: frameRate.value }
    }
    const res = RESOLUTION_MAP[resolution.value]
    if (res) {
      videoConstraints.width = { ideal: res.width }
      videoConstraints.height = { ideal: res.height }
    }

    // Request screen capture
    // Include audio: true so user can check "Share system audio"
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints,
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

    // 码流为 0 时不传 videoBitsPerSecond，交给浏览器按分辨率自适应
    const recorderOptions = { mimeType: selectedMime }
    if (videoBitrate.value) {
      recorderOptions.videoBitsPerSecond = videoBitrate.value
    }
    const recorder = new MediaRecorder(stream, recorderOptions)
    mediaRecorder.value = recorder

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        recordedChunks.value.push(e.data)
      }
    }

    recorder.onstop = () => {
      stopTimer()
      stopFrameWatch()
      // Generate WebM blob
      const blob = new Blob(recordedChunks.value, { type: recorder.mimeType || 'video/webm' })
      finalSize.value = blob.size
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
    startFrameWatch(stream)
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
  finalSize.value = 0
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

            <!-- 录制参数（仅准备阶段可调） -->
            <div class="settings-panel" v-if="recordStatus === 0">
              <div class="setting-row">
                <label class="setting-label"><el-icon><Monitor /></el-icon>分辨率</label>
                <el-select v-model="resolution" size="default" class="setting-select">
                  <el-option label="原始画质" value="source" />
                  <el-option label="2560×1440" value="1440" />
                  <el-option label="1920×1080" value="1080" />
                  <el-option label="1280×720" value="720" />
                  <el-option label="854×480" value="480" />
                </el-select>
              </div>

              <div class="setting-row">
                <label class="setting-label"><el-icon><VideoCamera /></el-icon>帧率</label>
                <el-select v-model="frameRate" size="default" class="setting-select">
                  <el-option label="60 fps" :value="60" />
                  <el-option label="48 fps" :value="48" />
                  <el-option label="30 fps" :value="30" />
                  <el-option label="24 fps" :value="24" />
                  <el-option label="15 fps" :value="15" />
                </el-select>
              </div>

              <div class="setting-row">
                <label class="setting-label">
                  <el-icon><Odometer /></el-icon>码流
                  <el-tooltip placement="top" effect="dark" popper-class="bitrate-tip">
                    <template #content>
                      <div class="tip-body">
                        <div class="tip-head">码流越高越清晰，文件也越大。下方为每分钟大致体积：</div>
                        <div class="tip-line"><span>16 Mbps 蓝光级</span><b>≈ {{ perMinuteSize(16_000_000) }}/分</b></div>
                        <div class="tip-line"><span>12 Mbps 超清+</span><b>≈ {{ perMinuteSize(12_000_000) }}/分</b></div>
                        <div class="tip-line"><span>8 Mbps 超清</span><b>≈ {{ perMinuteSize(8_000_000) }}/分</b></div>
                        <div class="tip-line"><span>6 Mbps 高清+</span><b>≈ {{ perMinuteSize(6_000_000) }}/分</b></div>
                        <div class="tip-line"><span>4 Mbps 高清</span><b>≈ {{ perMinuteSize(4_000_000) }}/分</b></div>
                        <div class="tip-line"><span>2.5 Mbps 标准</span><b>≈ {{ perMinuteSize(2_500_000) }}/分</b></div>
                        <div class="tip-line"><span>1.5 Mbps 流畅</span><b>≈ {{ perMinuteSize(1_500_000) }}/分</b></div>
                        <div class="tip-line"><span>1 Mbps 省空间</span><b>≈ {{ perMinuteSize(1_000_000) }}/分</b></div>
                        <div class="tip-foot">自动：由浏览器按分辨率自适应，通常介于高清与超清之间。</div>
                      </div>
                    </template>
                    <el-icon class="tip-icon"><InfoFilled /></el-icon>
                  </el-tooltip>
                </label>
                <el-select v-model="videoBitrate" size="default" class="setting-select">
                  <el-option label="蓝光级 16 Mbps" :value="16_000_000" />
                  <el-option label="超清+ 12 Mbps" :value="12_000_000" />
                  <el-option label="超清 8 Mbps" :value="8_000_000" />
                  <el-option label="高清+ 6 Mbps" :value="6_000_000" />
                  <el-option label="高清 4 Mbps" :value="4_000_000" />
                  <el-option label="标准 2.5 Mbps" :value="2_500_000" />
                  <el-option label="流畅 1.5 Mbps" :value="1_500_000" />
                  <el-option label="省空间 1 Mbps" :value="1_000_000" />
                  <el-option label="自动（浏览器自适应）" :value="0" />
                </el-select>
              </div>
            </div>

            <div class="stall-warning" v-if="captureStalled && recordStatus === 2">
              <div class="stall-title">⚠️ 捕获帧率极低（约 1 帧/秒）</div>
              <div class="stall-text">
                被分享的窗口<strong>被完全遮挡</strong>（或画面长时间静止）时，浏览器只按约 1 帧/秒采样。
                若要录的是动态画面，请把该窗口露出来（摆到本页面旁边，别被盖住、别最小化），或改录<strong>整个屏幕</strong>。
              </div>
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
              <span v-if="sizeDisplay" class="size-sep">·</span>
              <span v-if="sizeDisplay">{{ sizeDisplay }}</span>
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
          <li><strong>录制应用窗口的重要提示：</strong>被分享的窗口若被浏览器（或其它窗口）<strong>完全遮挡</strong>，Chrome/Edge 会把捕获帧率限制到约 1 帧/秒，录出来像幻灯片或"卡住不动"。请把被录窗口摆在本页面旁边保持可见，或直接录制整个屏幕；窗口最小化也会导致无法捕获。</li>
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
  background: var(--bg-ctrl); /* 旧浏览器回退：无 color-mix */
  background: color-mix(in srgb, var(--accent-red) 6%, var(--bg-ctrl));
  border-color: var(--border-subtle); /* 旧浏览器回退：无 color-mix */
  border-color: color-mix(in srgb, var(--accent-red) 25%, var(--border-subtle));
}
.status-3 {
  background: var(--bg-ctrl); /* 旧浏览器回退：无 color-mix */
  background: color-mix(in srgb, var(--accent-green) 6%, var(--bg-ctrl));
  border-color: var(--border-subtle); /* 旧浏览器回退：无 color-mix */
  border-color: color-mix(in srgb, var(--accent-green) 25%, var(--border-subtle));
}

/* 丢帧警告横幅 */
.stall-warning {
  border: 1px solid var(--border-color); /* 旧浏览器回退：无 color-mix */
  border: 1px solid color-mix(in srgb, var(--accent-red) 45%, transparent);
  background: var(--bg-ctrl); /* 旧浏览器回退：无 color-mix */
  background: color-mix(in srgb, var(--accent-red) 10%, var(--bg-ctrl));
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 16px;
  animation: pulse-border 1.5s infinite;
}

.stall-title {
  color: var(--accent-red);
  font-size: 0.88rem;
  font-weight: 600;
  margin-bottom: 6px;
}

.stall-text {
  color: var(--text-secondary);
  font-size: 0.8rem;
  line-height: 1.55;
}

.stall-text strong {
  color: var(--accent-red);
}

/* 录制参数面板 */
.settings-panel {
  margin-bottom: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.setting-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.setting-label {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 82px;
  font-size: 0.85rem;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.setting-label .el-icon {
  color: var(--text-muted);
}

.setting-select {
  flex: 1;
}

.tip-icon {
  cursor: help;
  color: var(--text-muted);
  font-size: 0.9rem;
}

.tip-icon:hover {
  color: var(--accent-blue);
}

.tip-body {
  min-width: 220px;
  line-height: 1.7;
}

.tip-head {
  margin-bottom: 6px;
}

.tip-line {
  display: flex;
  justify-content: space-between;
  gap: 18px;
}

.tip-line b {
  font-weight: 600;
}

.tip-foot {
  margin-top: 6px;
  opacity: 0.8;
  font-size: 0.92em;
}

.size-sep {
  opacity: 0.5;
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
    border-color: var(--border-color); /* 旧浏览器回退：无 color-mix */
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

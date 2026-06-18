<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Monitor, VideoPlay, Aim, Refresh } from '@element-plus/icons-vue'

const selectedVersion = ref('win11')
const selectedSpeed = ref('normal')
const initialProgress = ref(0)
const simulating = ref(false)
const progress = ref(0)
const simContainer = ref(null)

let simInterval = null

// Options configuration
const versions = [
  { label: 'Windows 11 更新模拟', value: 'win11' },
  { label: 'Windows 10 更新模拟', value: 'win10' },
  { label: 'Windows 7 更新模拟', value: 'win7' },
  { label: 'Windows 蓝屏故障 (BSOD)', value: 'bsod' }
]

const speeds = [
  { label: '慢速 (5秒/%)', value: 'slow' },
  { label: '常规 (1.5秒/%)', value: 'normal' },
  { label: '快速 (0.3秒/%)', value: 'fast' },
  { label: '卡住 (不增长)', value: 'stuck' }
]

function startInterval() {
  stopInterval()
  if (selectedSpeed.value === 'stuck') return

  let delay = 1500
  if (selectedSpeed.value === 'slow') delay = 5000
  if (selectedSpeed.value === 'fast') delay = 300

  simInterval = setInterval(() => {
    if (progress.value < 100) {
      // Small random increments
      const randInc = Math.floor(Math.random() * 2) + 1
      progress.value = Math.min(100, progress.value + randInc)
    } else {
      // Loop back to 0 after hitting 100
      progress.value = 0
    }
  }, delay)
}

function stopInterval() {
  if (simInterval) {
    clearInterval(simInterval)
    simInterval = null
  }
}

function enterSimulation() {
  simulating.value = true
  progress.value = initialProgress.value
  startInterval()

  // Fullscreen trigger
  setTimeout(() => {
    const element = simContainer.value
    if (element) {
      if (element.requestFullscreen) {
        element.requestFullscreen()
      } else if (element.webkitRequestFullscreen) {
        element.webkitRequestFullscreen()
      } else if (element.msRequestFullscreen) {
        element.msRequestFullscreen()
      }
    }
  }, 50)
}

function exitSimulation() {
  if (document.fullscreenElement) {
    document.exitFullscreen()
  }
  simulating.value = false
  stopInterval()
}

// Global keypress listener during simulation (double check exit)
function handleGlobalKeydown(e) {
  if (simulating.value) {
    // Pressing Esc or any other key can exit
    exitSimulation()
  }
}

// Double click to exit handler
function handleDblClick() {
  if (simulating.value) {
    exitSimulation()
  }
}

// Watch fullscreen state changes
function handleFullscreenChange() {
  if (!document.fullscreenElement) {
    simulating.value = false
    stopInterval()
  }
}

onMounted(() => {
  document.addEventListener('fullscreenchange', handleFullscreenChange)
  window.addEventListener('keydown', handleGlobalKeydown)
})

onUnmounted(() => {
  document.removeEventListener('fullscreenchange', handleFullscreenChange)
  window.removeEventListener('keydown', handleGlobalKeydown)
  stopInterval()
})
</script>

<template>
  <div class="fake-update-view">
    <div class="page-header">
      <h2 class="page-title"><span class="title-icon">💻</span> 系统更新模拟器</h2>
      <p class="page-desc">模拟主流 Windows 版本的更新升级和崩溃蓝屏界面。支持自定义速度和初始进度，全屏模式可用于临时屏保或恶搞整蛊。</p>
    </div>

    <!-- 模拟设置配置卡片 -->
    <div class="config-card theme-surface" v-if="!simulating">
      <h3 class="section-title">模拟控制面板</h3>
      
      <div class="form-container">
        <!-- 1. 版本选择 -->
        <div class="form-item">
          <label class="form-label">模拟界面版本</label>
          <el-select v-model="selectedVersion" placeholder="请选择系统版本" class="w-100">
            <el-option
              v-for="ver in versions"
              :key="ver.value"
              :label="ver.label"
              :value="ver.value"
            />
          </el-select>
        </div>

        <!-- 2. 增长速度 -->
        <div class="form-item">
          <label class="form-label">进度增长速度</label>
          <el-select v-model="selectedSpeed" placeholder="请选择增长速度" class="w-100">
            <el-option
              v-for="sp in speeds"
              :key="sp.value"
              :label="sp.label"
              :value="sp.value"
            />
          </el-select>
        </div>

        <!-- 3. 起始进度 -->
        <div class="form-item" v-if="selectedVersion !== 'bsod'">
          <label class="form-label">起始百分比 ({{ initialProgress }}%)</label>
          <el-slider v-model="initialProgress" :min="0" :max="99" />
        </div>

        <!-- 4. 友情提示 -->
        <div class="tip-box">
          <p class="tip-title">⚠️ 退出说明</p>
          <p class="tip-desc">进入全屏后，界面会隐藏鼠标指针。您可以随时通过以下任一方式退出模拟返回此页面：</p>
          <ul class="tip-list">
            <li>按下键盘上的 <strong>Esc</strong> 键</li>
            <li><strong>双击屏幕</strong> 任意位置</li>
            <li>按下键盘上的 <strong>任意其它按键</strong></li>
          </ul>
        </div>

        <!-- 5. 启动按钮 -->
        <div class="action-wrap">
          <el-button 
            type="primary" 
            size="large" 
            :icon="VideoPlay"
            class="start-btn"
            @click="enterSimulation"
          >
            启动全屏模拟
          </el-button>
        </div>
      </div>
    </div>

    <!-- 全屏仿真覆盖容器 -->
    <div 
      v-if="simulating" 
      ref="simContainer" 
      class="simulation-fullscreen"
      :class="[selectedVersion]"
      @dblclick="handleDblClick"
    >
      <!-- ================= Windows 11 ================= -->
      <div v-if="selectedVersion === 'win11'" class="win-screen-content">
        <div class="win-loader">
          <div class="win-spinner">
            <div class="dot"></div>
            <div class="dot"></div>
            <div class="dot"></div>
            <div class="dot"></div>
            <div class="dot"></div>
            <div class="dot"></div>
          </div>
        </div>
        <div class="win-text">
          <p class="large-text">正在配置更新</p>
          <p class="progress-text">{{ progress }}% 已完成</p>
          <p class="small-text">请保持计算机开机。</p>
        </div>
        <div class="win-footer">
          <p>您的电脑可能会重新启动几次</p>
        </div>
      </div>

      <!-- ================= Windows 10 ================= -->
      <div v-if="selectedVersion === 'win10'" class="win-screen-content">
        <div class="win-loader">
          <div class="win-spinner">
            <div class="dot"></div>
            <div class="dot"></div>
            <div class="dot"></div>
            <div class="dot"></div>
            <div class="dot"></div>
            <div class="dot"></div>
          </div>
        </div>
        <div class="win-text">
          <p class="large-text">正在配置 Windows 更新</p>
          <p class="progress-text">{{ progress }}% 完成</p>
          <p class="small-text">请勿关闭计算机。</p>
        </div>
      </div>

      <!-- ================= Windows 7 ================= -->
      <div v-if="selectedVersion === 'win7'" class="win7-screen-content">
        <div class="win7-content-wrap">
          <div class="win7-loader">
            <div class="win-spinner win7-spinner">
              <div class="dot"></div>
              <div class="dot"></div>
              <div class="dot"></div>
              <div class="dot"></div>
              <div class="dot"></div>
              <div class="dot"></div>
            </div>
          </div>
          <div class="win7-text">
            <p class="win7-title">正在配置 Windows 更新</p>
            <p class="win7-percent">已完成 {{ progress }}%</p>
            <p class="win7-sub">请勿关闭计算机。</p>
          </div>
        </div>
        <div class="win7-footer">
          <div class="win7-logo-icon"></div>
          <span class="win7-brand-text">Windows 7 Professional</span>
        </div>
      </div>

      <!-- ================= Windows 10/11 BSOD ================= -->
      <div v-if="selectedVersion === 'bsod'" class="bsod-screen-content">
        <div class="bsod-align-wrap">
          <div class="bsod-sad-face">:(</div>
          <div class="bsod-main-title">你的电脑遇到问题，需要重新启动。</div>
          <div class="bsod-sub-title">我们只收集某些错误信息，然后为你重新启动。</div>
          <div class="bsod-progress">{{ progress }}% 完成</div>
          
          <div class="bsod-details">
            <!-- Mock SVG QR Code -->
            <div class="bsod-qr-code">
              <svg viewBox="0 0 100 100" class="qr-svg">
                <!-- Outer boundary -->
                <rect x="0" y="0" width="100" height="100" fill="#ffffff" />
                <!-- Position marks (Top Left) -->
                <rect x="10" y="10" width="30" height="30" fill="#0078d7" />
                <rect x="15" y="15" width="20" height="20" fill="#ffffff" />
                <rect x="20" y="20" width="10" height="10" fill="#0078d7" />
                <!-- Position marks (Top Right) -->
                <rect x="60" y="10" width="30" height="30" fill="#0078d7" />
                <rect x="65" y="15" width="20" height="20" fill="#ffffff" />
                <rect x="70" y="20" width="10" height="10" fill="#0078d7" />
                <!-- Position marks (Bottom Left) -->
                <rect x="10" y="60" width="30" height="30" fill="#0078d7" />
                <rect x="15" y="65" width="20" height="20" fill="#ffffff" />
                <rect x="20" y="70" width="10" height="10" fill="#0078d7" />
                <!-- Tiny random block modules to look like a real QR code -->
                <rect x="45" y="15" width="8" height="8" fill="#0078d7" />
                <rect x="45" y="30" width="8" height="8" fill="#0078d7" />
                <rect x="45" y="45" width="8" height="8" fill="#0078d7" />
                <rect x="15" y="45" width="8" height="8" fill="#0078d7" />
                <rect x="30" y="45" width="8" height="8" fill="#0078d7" />
                <rect x="60" y="45" width="8" height="8" fill="#0078d7" />
                <rect x="75" y="45" width="8" height="8" fill="#0078d7" />
                <rect x="60" y="60" width="8" height="8" fill="#0078d7" />
                <rect x="75" y="60" width="8" height="8" fill="#0078d7" />
                <rect x="60" y="75" width="8" height="8" fill="#0078d7" />
                <rect x="75" y="75" width="8" height="8" fill="#0078d7" />
              </svg>
            </div>
            
            <div class="bsod-meta-text">
              <p>有关此问题的详细信息 and 解决方法，请访问 https://www.windows.com/stopcode</p>
              <p class="stop-code-line">如果致电支持人员，请向他们提供以下信息:</p>
              <p>终止代码: <strong>CRITICAL_PROCESS_DIED</strong></p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fake-update-view {
  max-width: 800px;
  margin: 0 auto;
  padding: 20px 16px 40px;
}

.page-header {
  margin-bottom: 24px;
}

.page-title {
  margin: 0 0 4px;
  color: var(--text-heading);
  font-size: 1.4rem;
  font-weight: 500;
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

.config-card {
  border: 1px solid var(--border-color);
  border-radius: 16px;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.section-title {
  margin: 0 0 10px;
  font-size: 1.1rem;
  font-weight: 500;
  color: var(--text-heading);
  border-left: 4px solid var(--accent-blue);
  padding-left: 10px;
  line-height: 1.2;
}

.form-container {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.form-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.form-label {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--text-secondary);
}

.w-100 {
  width: 100%;
}

.tip-box {
  background: color-mix(in srgb, var(--accent-gold) 6%, var(--bg-ctrl));
  border: 1px solid color-mix(in srgb, var(--accent-gold) 20%, var(--border-subtle));
  border-radius: 12px;
  padding: 16px;
}

.tip-title {
  margin: 0 0 6px;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--accent-gold);
}

.tip-desc {
  margin: 0 0 10px;
  font-size: 0.78rem;
  color: var(--text-secondary);
  line-height: 1.4;
}

.tip-list {
  margin: 0;
  padding-left: 20px;
  font-size: 0.78rem;
  color: var(--text-secondary);
  line-height: 1.6;
}

.action-wrap {
  display: flex;
  justify-content: center;
  margin-top: 10px;
}

.start-btn {
  width: 100%;
  max-width: 320px;
  height: 48px;
  font-size: 1rem;
  border-radius: 10px;
}

/* ======================================================= */
/* Fullscreen Simulation Styles */
/* ======================================================= */
.simulation-fullscreen {
  position: fixed;
  inset: 0;
  z-index: 99999;
  width: 100vw;
  height: 100vh;
  user-select: none;
  cursor: none !important; /* Hide mouse cursor */
  font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, "Microsoft YaHei", sans-serif;
  overflow: hidden;
}

/* Windows 11 Screen Theme */
.simulation-fullscreen.win11 {
  background-color: #000000;
  color: #ffffff;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
}

/* Windows 10 Screen Theme */
.simulation-fullscreen.win10 {
  background-color: #0078d7;
  color: #ffffff;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
}

/* Common Win10/Win11 inner layout */
.win-screen-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}

.win-loader {
  margin-bottom: 35px;
}

.win-text {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.large-text {
  font-size: 2.1rem;
  font-weight: 300;
  margin: 0;
}

.progress-text {
  font-size: 2.1rem;
  font-weight: 300;
  margin: 0;
}

.small-text {
  font-size: 1.15rem;
  opacity: 0.85;
  margin: 0;
}

.win-footer {
  position: absolute;
  bottom: 8%;
  font-size: 1.05rem;
  opacity: 0.7;
}

/* Windows 7 Theme */
.simulation-fullscreen.win7 {
  background: linear-gradient(to bottom, #00172d 0%, #002547 50%, #003666 100%);
  color: #ffffff;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  padding: 60px 0;
}

.win7-content-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 20px;
}

.win7-loader {
  height: 60px;
}

.win7-text {
  text-align: center;
}

.win7-title {
  font-size: 1.45rem;
  margin: 0 0 10px;
}

.win7-percent {
  font-size: 1.45rem;
  margin: 0 0 10px;
}

.win7-sub {
  font-size: 1.1rem;
  opacity: 0.8;
  margin: 0;
}

.win7-footer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.win7-logo-icon {
  width: 36px;
  height: 36px;
  background: url("data:image/svg+xml,%3Csvg viewBox='0 0 100 100' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M10 50 C 15 25, 45 25, 50 50 C 55 75, 85 75, 90 50' fill='none' stroke='%23ffffff' stroke-width='8'/%3E%3C/svg%3E") no-repeat center;
  background-size: contain;
  opacity: 0.8;
}

.win7-brand-text {
  font-size: 1rem;
  opacity: 0.65;
  letter-spacing: 1px;
}

/* Windows 10/11 BSOD Screen Theme */
.simulation-fullscreen.bsod {
  background-color: #0078d7;
  color: #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
}

.bsod-align-wrap {
  max-width: 960px;
  width: 100%;
  display: flex;
  flex-direction: column;
  text-align: left;
}

.bsod-sad-face {
  font-size: 10rem;
  font-weight: 300;
  margin-bottom: 20px;
  line-height: 1;
}

.bsod-main-title {
  font-size: 2.1rem;
  font-weight: 300;
  line-height: 1.4;
  margin-bottom: 16px;
}

.bsod-sub-title {
  font-size: 1.35rem;
  font-weight: 300;
  line-height: 1.4;
  margin-bottom: 24px;
}

.bsod-progress {
  font-size: 1.35rem;
  font-weight: 300;
  margin-bottom: 40px;
}

.bsod-details {
  display: flex;
  gap: 30px;
  align-items: flex-start;
}

.bsod-qr-code {
  width: 110px;
  height: 110px;
  background-color: #ffffff;
  padding: 8px;
  border-radius: 2px;
  flex-shrink: 0;
}

.qr-svg {
  width: 100%;
  height: 100%;
}

.bsod-meta-text {
  font-size: 0.95rem;
  line-height: 1.6;
  opacity: 0.95;
}

.bsod-meta-text p {
  margin: 0 0 6px;
}

.stop-code-line {
  margin-top: 12px !important;
}

/* ======================================================= */
/* Spinner Dots Rotation Animation */
/* ======================================================= */
.win-spinner {
  position: relative;
  width: 54px;
  height: 54px;
}

.win-spinner .dot {
  position: absolute;
  width: 5px;
  height: 5px;
  background-color: #ffffff;
  border-radius: 50%;
  left: 24.5px;
  top: 0;
  transform-origin: 2.5px 27px;
  opacity: 0;
  animation: win-spinner-rotate 5.5s infinite ease-in-out;
}

/* Windows 7 loader spinner dots adjustments */
.win7-spinner .dot {
  width: 6px;
  height: 6px;
  background-color: #ffffff;
  box-shadow: 0 0 8px rgba(255, 255, 255, 0.8);
}

.win-spinner .dot:nth-child(1) { animation-delay: 0.15s; }
.win-spinner .dot:nth-child(2) { animation-delay: 0.30s; }
.win-spinner .dot:nth-child(3) { animation-delay: 0.45s; }
.win-spinner .dot:nth-child(4) { animation-delay: 0.60s; }
.win-spinner .dot:nth-child(5) { animation-delay: 0.75s; }
.win-spinner .dot:nth-child(6) { animation-delay: 0.90s; }

@keyframes win-spinner-rotate {
  0% {
    transform: rotate(0deg);
    opacity: 0;
  }
  5% {
    transform: rotate(0deg);
    opacity: 1;
  }
  25% {
    transform: rotate(180deg);
    opacity: 1;
  }
  35% {
    transform: rotate(360deg);
    opacity: 1;
  }
  55% {
    transform: rotate(540deg);
    opacity: 1;
  }
  65% {
    transform: rotate(720deg);
    opacity: 1;
  }
  85% {
    transform: rotate(900deg);
    opacity: 1;
  }
  95% {
    transform: rotate(1080deg);
    opacity: 1;
  }
  100% {
    transform: rotate(1080deg);
    opacity: 0;
  }
}

@media (max-width: 768px) {
  .fake-update-view {
    padding: 12px 10px 24px;
  }
  
  .config-card {
    padding: 16px;
  }
  
  /* Scale down text in fullscreen simulator for smaller screen sizes */
  .large-text,
  .progress-text {
    font-size: 1.5rem;
  }
  
  .small-text {
    font-size: 0.9rem;
  }
  
  .bsod-main-title {
    font-size: 1.5rem;
  }
  
  .bsod-sub-title,
  .bsod-progress {
    font-size: 1.1rem;
  }
  
  .bsod-details {
    flex-direction: column;
    gap: 16px;
  }
}
</style>

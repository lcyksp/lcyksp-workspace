<script setup>
/**
 * HomeView.vue V3.1 — 极简欢迎主页
 * 打字机 Slogan + 极客数字时钟 + 云端状态微挂件
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import axios from 'axios'

// ========== 打字机 Slogan ==========
const fullText = 'Lcyksp Workspace — 极简在线工具箱'
const displayText = ref('')
const cursorVisible = ref(true)

let typeInterval = null
let cursorInterval = null
let charIndex = 0

// ========== 数字时钟 ==========
const now = ref(new Date())

const timeStr = computed(() => {
  return now.value.toLocaleTimeString('zh-CN', { hour12: false })
})

const dateStr = computed(() => {
  return now.value.toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  })
})

const greeting = computed(() => {
  const h = now.value.getHours()
  if (h < 6) return '夜深了，注意休息 🌙'
  if (h < 9) return '早上好 ☀️'
  if (h < 12) return '上午好 🌤️'
  if (h < 14) return '中午好 🌞'
  if (h < 18) return '下午好 ⛅'
  if (h < 22) return '傍晚好 🌆'
  return '夜深了，注意休息 🌙'
})

let clockInterval = null

// ========== 云端状态微挂件 ==========
const serverStatus = ref({
  status: 'connecting',
  ping: null,
  serverInfo: '',
})

let statusInterval = null

async function fetchServerStatus() {
  try {
    const start = performance.now()
    const res = await axios.get('/api/health', { timeout: 5000 })
    const elapsed = Math.round(performance.now() - start)
    serverStatus.value = {
      status: 'online',
      ping: elapsed,
      serverInfo: res.data?.server || 'Node.js',
    }
  } catch {
    serverStatus.value = {
      status: 'offline',
      ping: null,
      serverInfo: '',
    }
  }
}

onMounted(() => {
  // 打字机
  typeInterval = setInterval(() => {
    if (charIndex < fullText.length) {
      displayText.value += fullText[charIndex]
      charIndex++
    } else {
      clearInterval(typeInterval)
    }
  }, 80)

  cursorInterval = setInterval(() => {
    cursorVisible.value = !cursorVisible.value
  }, 500)

  // 数字时钟 — 每秒
  clockInterval = setInterval(() => {
    now.value = new Date()
  }, 1000)

  // 云端状态 — 首次立即执行，之后每 5 秒
  fetchServerStatus()
  statusInterval = setInterval(fetchServerStatus, 5000)
})

onUnmounted(() => {
  clearInterval(typeInterval)
  clearInterval(cursorInterval)
  clearInterval(clockInterval)
  clearInterval(statusInterval)
})
</script>

<template>
  <div class="home-view">
    <div class="hero">
      <!-- 打字机 Slogan -->
      <h1 class="slogan">
        {{ displayText }}<span class="cursor" :class="{ hidden: !cursorVisible }">|</span>
      </h1>

      <!-- 极客数字时钟 -->
      <div class="clock-widget">
        <div class="clock-time">{{ timeStr }}</div>
        <div class="clock-date">{{ dateStr }}</div>
        <div class="clock-greeting">{{ greeting }}</div>
      </div>

      <!-- 云端状态微挂件 -->
      <div class="server-widget" :class="serverStatus.status">
        <span class="status-dot" />
        <span class="status-label">
          <template v-if="serverStatus.status === 'online'">
            后端在线 · Ping {{ serverStatus.ping }}ms
          </template>
          <template v-else-if="serverStatus.status === 'connecting'">
            正在连接…
          </template>
          <template v-else>
            后端离线
          </template>
        </span>
      </div>

      <!-- 引导 -->
      <p class="hint">点击左上角菜单开始使用</p>
    </div>
  </div>
</template>

<style scoped>
.home-view {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: calc(100vh - 80px);
  text-align: center;
}

.hero {
  max-width: 600px;
  padding: 0 20px;
}

/* ---------- Slogan ---------- */
.slogan {
  font-size: 1.8rem;
  font-weight: 300;
  color: #e0e0e0;
  margin: 0 0 32px;
  letter-spacing: 2px;
  line-height: 1.6;
}

.cursor {
  color: #409eff;
  font-weight: 100;
  transition: opacity 0.2s;
}
.cursor.hidden { opacity: 0; }

/* ---------- 数字时钟 ---------- */
.clock-widget {
  margin-bottom: 28px;
}

.clock-time {
  font-size: 3.2rem;
  font-weight: 200;
  font-family: 'Courier New', 'Consolas', monospace;
  color: #c0c0e0;
  letter-spacing: 6px;
  line-height: 1.2;
}

.clock-date {
  font-size: 0.9rem;
  color: #666;
  margin-top: 4px;
}

.clock-greeting {
  font-size: 0.85rem;
  color: #555;
  margin-top: 6px;
}

/* ---------- 云端状态 ---------- */
.server-widget {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  border-radius: 20px;
  font-size: 0.8rem;
  margin-bottom: 24px;
  transition: all 0.3s;
}

.server-widget.online {
  background: rgba(46, 204, 113, 0.08);
  color: #2ecc71;
  border: 1px solid rgba(46, 204, 113, 0.2);
}

.server-widget.offline {
  background: rgba(231, 76, 60, 0.08);
  color: #e74c3c;
  border: 1px solid rgba(231, 76, 60, 0.2);
}

.server-widget.connecting {
  background: rgba(100, 100, 100, 0.08);
  color: #888;
  border: 1px solid rgba(100, 100, 100, 0.2);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}

.server-widget.online .status-dot {
  background: #2ecc71;
  box-shadow: 0 0 6px rgba(46, 204, 113, 0.6);
  animation: pulse-green 2s infinite;
}

.server-widget.offline .status-dot {
  background: #e74c3c;
}

.server-widget.connecting .status-dot {
  background: #888;
  animation: pulse-gray 1s infinite;
}

@keyframes pulse-green {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

@keyframes pulse-gray {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.status-label { letter-spacing: 0.5px; }

/* ---------- 引导 ---------- */
.hint {
  color: #555;
  font-size: 0.85rem;
  margin: 0;
  opacity: 0.5;
  transition: opacity 0.8s;
}
.hint:hover { opacity: 1; }

/* ---------- 手机端 ---------- */
@media (max-width: 640px) {
  .slogan { font-size: 1.3rem; }
  .clock-time { font-size: 2.2rem; letter-spacing: 4px; }
}
</style>

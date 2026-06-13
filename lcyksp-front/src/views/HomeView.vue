<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'

const fullText = 'Workspace | 在线工具站'
const displayText = ref('')
const cursorVisible = ref(true)
const supportDialogVisible = ref(false)
const supportChannel = ref('wechat')

let typeInterval = null
let cursorInterval = null
let charIndex = 0
let clockInterval = null

const now = ref(new Date())
const timeStr = computed(() => now.value.toLocaleTimeString('zh-CN', { hour12: false }))

const dateStr = computed(() => {
  return now.value.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  })
})

const greeting = computed(() => {
  const hour = now.value.getHours()
  if (hour < 1) return '夜深了，也别忘了早点休息。'
  if (hour < 6) return '老大，我们这么熬真的没事嘛'
  if (hour < 9) return '早上好，来把今天要用的工具开起来。'
  if (hour < 12) return '上午好，祝你今天一路顺手。'
  if (hour < 14) return '中午好，忙里也记得吃饭。'
  if (hour < 18) return '下午好，继续推进今天的事情。'
  if (hour < 22) return '晚上好，希望这些工具能帮你省点时间。'
  return '夜深了，也别忘了早点休息。'
})

const supportOptions = [
  { key: 'wechat', label: '微信', image: '/support-wechat.png' },
  { key: 'alipay', label: '支付宝', image: '/support-alipay.jpg' },
]

const activeSupportOption = computed(() => {
  return supportOptions.find((item) => item.key === supportChannel.value) || supportOptions[0]
})

function openSupportDialog() {
  supportChannel.value = 'wechat'
  supportDialogVisible.value = true
}

onMounted(() => {
  typeInterval = setInterval(() => {
    if (charIndex < fullText.length) {
      displayText.value += fullText[charIndex]
      charIndex += 1
    } else {
      clearInterval(typeInterval)
    }
  }, 75)

  cursorInterval = setInterval(() => {
    cursorVisible.value = !cursorVisible.value
  }, 500)

  clockInterval = setInterval(() => {
    now.value = new Date()
  }, 1000)
})

onUnmounted(() => {
  clearInterval(typeInterval)
  clearInterval(cursorInterval)
  clearInterval(clockInterval)
})
</script>

<template>
  <div class="home-view">
    <div class="hero">
      <div class="hero-main">
      <h1 class="slogan">
        {{ displayText }}<span class="cursor" :class="{ hidden: !cursorVisible }">|</span>
      </h1>

      <div class="clock-widget">
        <div class="clock-time">{{ timeStr }}</div>
        <div class="clock-date">{{ dateStr }}</div>
        <div class="clock-greeting">{{ greeting }}</div>
      </div>
      <p class="hint">点开左侧菜单就能开始用工具。</p>
      </div>

      <div class="home-bottom">
        <button class="support-link" type="button" @click="openSupportDialog">
          觉得不错？赞助一下
        </button>
        <p class="disclaimer">
          本网站仅供个人学习、研究与效率辅助使用，请勿用于商业用途、批量爬取、侵权传播或任何违法违规场景。因用户自行使用本网站产生的任何风险、纠纷或损失，与本站无关。
        </p>
        <p class="icp-record">
          <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">粤ICP备2026075435号-1</a>
        </p>
      </div>
    </div>

    <el-dialog
      v-model="supportDialogVisible"
      title=""
      width="420px"
      :close-on-click-modal="false"
      class="support-modal"
    >
      <div class="support-dialog">
        <div class="support-copy">
          <p class="support-copy-single">赏口饭吃谢谢喵</p>
          <p class="support-copy-sub">
            如果是在休息时间赞助，修改用户权限会稍慢一些。
          </p>
        </div>

        <div class="support-tabs">
          <button
            v-for="item in supportOptions"
            :key="item.key"
            type="button"
            class="support-tab"
            :class="{ active: supportChannel === item.key }"
            @click="supportChannel = item.key"
          >
            {{ item.label }}
          </button>
        </div>

        <div class="support-qrcode-wrap">
          <img class="support-qrcode" :src="activeSupportOption.image" :alt="`${activeSupportOption.label}收款码`" />
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.home-view {
  display: flex;
  align-items: stretch;
  justify-content: center;
  width: 100%;
  min-height: calc(100vh - 64px);
  text-align: center;
}

.hero {
  width: min(760px, 100%);
  min-height: calc(100vh - 64px);
  padding: 0 20px 24px;
  display: flex;
  flex-direction: column;
}

.hero-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.slogan {
  margin: 0 0 32px;
  font-size: 1.85rem;
  font-weight: 300;
  line-height: 1.6;
  letter-spacing: 2px;
  color: var(--text-heading);
}

.cursor {
  color: #409eff;
  font-weight: 100;
  transition: opacity 0.2s;
}

.cursor.hidden {
  opacity: 0;
}

.clock-widget {
  margin-bottom: 28px;
}

.clock-time {
  font-size: 3.2rem;
  font-weight: 200;
  font-family: 'Courier New', 'Consolas', monospace;
  color: var(--text-primary);
  letter-spacing: 6px;
  line-height: 1.2;
}

.clock-date {
  margin-top: 4px;
  color: var(--text-muted);
  font-size: 0.9rem;
}

.clock-greeting {
  margin-top: 8px;
  color: var(--text-dim);
  font-size: 0.88rem;
}

.hint {
  margin: 0 0 14px;
  color: var(--text-dim);
  font-size: 0.88rem;
  opacity: 0.68;
}

.home-bottom {
  margin-top: auto;
  padding-top: 32px;
  display: grid;
  gap: 12px;
  justify-items: center;
}

.support-link {
  border: none;
  background: transparent;
  color: color-mix(in srgb, var(--text-secondary) 88%, transparent);
  font-size: 0.82rem;
  cursor: pointer;
  opacity: 0.72;
  letter-spacing: 0.2px;
  transition: color 0.18s ease, opacity 0.18s ease, transform 0.18s ease;
}

.support-link:hover {
  color: var(--accent-blue);
  opacity: 1;
  transform: translateY(-1px);
}

.disclaimer {
  max-width: 760px;
  margin: 0;
  color: var(--text-dim);
  font-size: 0.72rem;
  line-height: 1.8;
  opacity: 0.78;
}

.icp-record {
  margin: 8px 0 0;
  font-size: 0.72rem;
}

.icp-record a {
  color: var(--text-dim);
  text-decoration: none;
  opacity: 0.78;
  transition: color 0.18s ease, opacity 0.18s ease;
}

.icp-record a:hover {
  color: var(--accent-blue);
  opacity: 1;
}

.support-dialog {
  display: grid;
  gap: 18px;
  text-align: center;
  justify-items: center;
}

.support-copy {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.support-copy-single {
  margin: 0;
  color: var(--text-primary);
  font-size: 1.1rem;
  line-height: 1.5;
  font-weight: 600;
  text-align: center;
}

.support-tabs {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.support-tab {
  min-width: 88px;
  border: 1px solid color-mix(in srgb, var(--accent-blue) 28%, transparent);
  background: transparent;
  color: var(--text-secondary);
  border-radius: 999px;
  padding: 8px 14px;
  cursor: pointer;
  transition: all 0.18s ease;
}

.support-tab.active {
  background: color-mix(in srgb, var(--accent-blue) 22%, transparent);
  color: var(--text-primary);
  border-color: color-mix(in srgb, var(--accent-blue) 56%, transparent);
}

.support-qrcode-wrap {
  display: flex;
  justify-content: center;
}

.support-qrcode {
  width: 240px;
  max-width: 100%;
  object-fit: contain;
  border-radius: 0;
  background: transparent;
  padding: 0;
  box-shadow: none;
}

:deep(.support-modal .el-dialog__header) {
  margin-right: 0;
  padding-bottom: 0;
  padding-top: 10px;
  min-height: 18px;
}

:deep(.support-modal .el-dialog__title) {
  color: var(--text-primary);
  font-weight: 600;
}

@media (max-width: 640px) {
  .hero {
    padding: 0 14px 20px;
    min-height: calc(100vh - 64px);
  }

  .slogan {
    font-size: 1.28rem;
  }

  .clock-time {
    font-size: 2.2rem;
    letter-spacing: 4px;
  }

  .home-bottom {
    padding-top: 24px;
    gap: 10px;
  }

  .support-link {
    font-size: 0.78rem;
  }

  .disclaimer {
    font-size: 0.68rem;
  }

  .icp-record {
    font-size: 0.68rem;
  }

  .support-qrcode {
    width: 210px;
  }
}
</style>

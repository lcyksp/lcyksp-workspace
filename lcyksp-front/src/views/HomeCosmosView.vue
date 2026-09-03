<script setup>
// 首页星象化：HUD 是静态渲染的，three 那部分异步挂载，
// 所以慢网络下先看到时间和底部信息，星球随后补上
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, shallowRef } from 'vue'

const CosmosCanvas = defineAsyncComponent(() => import('../components/CosmosCanvas.vue'))

const supportOptions = [
  { key: 'wechat', label: '微信', image: '/support-wechat.png' },
  { key: 'alipay', label: '支付宝', image: '/support-alipay.jpg' },
]

const now = ref(new Date())
const wide = ref(false)
const ready = ref(false)
const supportDialogVisible = ref(false)
const supportChannel = ref('wechat')
const engine = shallowRef(null)
let clockTimer = null

const timeStr = computed(() =>
  now.value.toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }),
)

const activeSupportOption = computed(
  () => supportOptions.find((item) => item.key === supportChannel.value) || supportOptions[0],
)

onMounted(() => {
  clockTimer = setInterval(() => {
    now.value = new Date()
  }, 1000)
})

onUnmounted(() => clearInterval(clockTimer))

function onReady(api) {
  engine.value = api
  ready.value = true
}

// 现在点哪都只是在两个缩放状态之间切换，行星信息卡将来从 pick 的 key 接上
function onPick() {
  if (!engine.value) return
  wide.value = !wide.value
  engine.value.setZoom(wide.value ? 1 : 0)
}
function openSupportDialog() {
  supportChannel.value = 'wechat'
  supportDialogVisible.value = true
}
</script>

<template>
  <div class="cosmos-view">
    <div class="cosmos-stage">
      <CosmosCanvas @ready="onReady" @pick="onPick" />
    </div>

    <div class="cosmos-hud">
      <p class="cosmos-clock">{{ timeStr }}</p>

      <div class="cosmos-gap" />

      <!-- 不写字，只留一道从地球底下垂下来的呼吸细线当可点提示 -->
      <div class="cosmos-guide" :class="{ 'is-on': ready }" />

      <div class="cosmos-footer">
        <button class="support-link" type="button" @click="openSupportDialog">
          觉得不错？赞助一下
        </button>
        <p class="disclaimer">本站仅供个人学习与效率辅助，使用风险由用户自行承担</p>
        <div class="records-wrapper">
          <p class="icp-record">
            <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">粤ICP备2026075435号-1</a>
          </p>
          <p class="gongan-record">
            <img src="/gongan.png" class="gongan-icon" />
            <a href="https://beian.mps.gov.cn/#/query/webSearch?code=44130202001617" rel="noreferrer" target="_blank">粤公网安备44130202001617号</a>
          </p>
        </div>
      </div>
    </div>
    <el-dialog
      v-model="supportDialogVisible"
      title=""
      width="420px"
      :close-on-click-modal="false"
      class="support-modal cosmos-dialog"
    >
      <div class="support-dialog">
        <div class="support-copy">
          <p class="support-copy-single">赏口饭吃谢谢喵</p>
          <p class="support-copy-sub">
            5 元开通 30 天高级用户，10 元开通 90 天，20 元永久。<br>
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
/* canvas 绝对铺满，HUD 走 flex 列压在上面：时间钉顶、引导线贴在地球下方、
   免责与备案沉底。渐变背景保证 three 还没加载或不可用时文字也读得清 */
.cosmos-view {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  /* 56px 是 App.vue 里 .top-bar 的高度，这样整页刚好一屏、不出滚动条 */
  min-height: calc(100vh - 56px);
  min-height: calc(100dvh - 56px);
  overflow: hidden;
  background: radial-gradient(circle at 50% 42%, #0a1b2e 0%, #04080f 55%, #010307 100%);
  user-select: none;
}

.cosmos-stage {
  position: absolute;
  inset: 0;
}

.cosmos-hud {
  position: relative;
  z-index: 1;
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: none;
}

.cosmos-gap {
  flex: 1;
}

/* 顶部只留时间。不引任何字体文件，用等宽数字 + 大字距做近未来感 */
.cosmos-clock {
  margin: 0;
  padding-top: clamp(12px, 4.5vh, 44px);
  font-family: 'DIN Alternate', Bahnschrift, 'JetBrains Mono', ui-monospace, 'SF Mono', Consolas, monospace;
  font-size: clamp(2.3rem, 7.6vw, 4.4rem);
  font-weight: 200;
  line-height: 1;
  letter-spacing: 0.2em;
  text-indent: 0.2em;
  font-variant-numeric: tabular-nums;
  color: rgba(228, 249, 255, 0.95);
  text-shadow:
    0 0 22px rgba(96, 206, 232, 0.42),
    0 2px 12px rgba(0, 0, 0, 0.66);
}

/* 只有一道发丝线加一个呼吸光点，代替原来那行文字提示 */
.cosmos-guide {
  position: relative;
  width: 5px;
  height: 22px;
  margin: 0 0 clamp(12px, 2.4vh, 24px);
  opacity: 0;
  transition: opacity 0.9s ease;
}

.cosmos-guide.is-on {
  opacity: 1;
  animation: cosmos-breathe 3.6s ease-in-out infinite;
}

.cosmos-guide::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 0;
  width: 1px;
  height: 16px;
  transform: translateX(-50%);
  background: linear-gradient(180deg, transparent, rgba(126, 224, 240, 0.62));
}

.cosmos-guide::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: 0;
  width: 5px;
  height: 5px;
  transform: translateX(-50%);
  border-radius: 50%;
  background: rgba(126, 224, 240, 0.9);
  box-shadow: 0 0 10px rgba(126, 224, 240, 0.7);
}

@keyframes cosmos-breathe {
  0%,
  100% {
    opacity: 0.55;
  }

  50% {
    opacity: 1;
  }
}

.cosmos-footer {
  width: 100%;
  padding: 0 clamp(14px, 3vw, 28px) clamp(14px, 2.6vh, 26px);
  display: grid;
  gap: 10px;
  justify-items: center;
  pointer-events: auto;
}

/* 赞助与免责都是全透明底，不做毛玻璃：赞助只留一圈发丝边框表示可点 */
.support-link {
  margin: 0;
  padding: 9px 20px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 999px;
  background: transparent;
  box-shadow: none;
  font-size: 0.82rem;
  font-weight: 500;
  letter-spacing: 0.12em;
  color: rgba(240, 252, 255, 0.94);
  cursor: pointer;
  transition: color 0.2s ease, border-color 0.2s ease, transform 0.2s ease;
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.7);
  -webkit-font-smoothing: antialiased;
}

.support-link:hover {
  transform: translateY(-1px);
  border-color: rgba(126, 224, 240, 0.6);
  color: #fff;
}

/* 一行写完、永不换行——换行会把整个底部顶高。字号跟视口收缩，窄屏也放得下 */
.disclaimer {
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  white-space: nowrap;
  font-size: clamp(0.6rem, 2.4vw, 0.72rem);
  font-weight: 400;
  line-height: 1.6;
  letter-spacing: 0.03em;
  color: rgba(255, 255, 255, 0.82);
  text-align: center;
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.72);
  -webkit-font-smoothing: antialiased;
}

.records-wrapper {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
}

/* 备案信息不套气泡，直接压在星空上，所以颜色写死不跟主题变量 */
.icp-record,
.gongan-record {
  margin: 0;
  font-size: 0.7rem;
}

.gongan-record {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.icp-record a,
.gongan-record a {
  color: rgba(178, 214, 226, 0.72);
  text-decoration: none;
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.75);
  transition: color 0.18s ease;
}

.icp-record a:hover,
.gongan-record a:hover {
  color: rgba(126, 224, 240, 1);
}

.gongan-icon {
  width: 15px;
  height: 15px;
  vertical-align: middle;
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
  color: rgba(240, 250, 255, 0.96);
  font-size: 1.1rem;
  line-height: 1.5;
  font-weight: 600;
}

.support-copy-sub {
  margin: 8px 0 0;
  color: rgba(196, 222, 232, 0.82);
  font-size: 0.86rem;
  line-height: 1.7;
}

.support-tabs {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.support-tab {
  min-width: 88px;
  border: 1px solid rgba(126, 224, 240, 0.28);
  background: transparent;
  color: rgba(196, 222, 232, 0.82);
  border-radius: 999px;
  padding: 8px 14px;
  cursor: pointer;
  transition: all 0.18s ease;
}

.support-tab.active {
  background: rgba(126, 224, 240, 0.16);
  color: rgba(240, 250, 255, 0.96);
  border-color: rgba(126, 224, 240, 0.56);
}

.support-qrcode-wrap {
  display: flex;
  justify-content: center;
}

.support-qrcode {
  width: 240px;
  max-width: 100%;
  object-fit: contain;
}

:deep(.support-modal .el-dialog__header) {
  margin-right: 0;
  padding-bottom: 0;
  padding-top: 10px;
  min-height: 18px;
}

/* 弹窗浮在星空上，玻璃质感与首页气泡保持一致 */
:deep(.cosmos-dialog .el-dialog) {
  background: linear-gradient(145deg, rgba(20, 38, 56, 0.92) 0%, rgba(8, 16, 28, 0.94) 100%);
  border: 1px solid rgba(126, 224, 240, 0.26);
  box-shadow:
    0 18px 52px rgba(0, 0, 0, 0.46),
    inset 0 1px 0 rgba(255, 255, 255, 0.14);
}

@media (max-width: 640px) {
  .cosmos-footer {
    gap: 8px;
  }

  .support-link {
    font-size: 0.78rem;
    letter-spacing: 0.08em;
    padding: 8px 16px;
  }

  .cosmos-guide {
    height: 18px;
  }

  .cosmos-guide::before {
    height: 13px;
  }

  .support-qrcode {
    width: 210px;
  }
}
</style>

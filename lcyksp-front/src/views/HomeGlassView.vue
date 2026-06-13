<script setup>
import { computed, ref } from 'vue'

const supportDialogVisible = ref(false)
const supportChannel = ref('wechat')

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
</script>

<template>
  <div class="memory-hall">
    <div class="memory-hall__stage" aria-hidden="true" />

    <div class="memory-hall__footer">
      <button class="bubble-chip support-link" type="button" @click="openSupportDialog">
        觉得不错？赞助一下
      </button>
      <p class="bubble-card disclaimer">
        本网站仅供个人学习、研究与效率辅助使用，请勿用于商业用途、批量爬取、侵权传播或任何违法违规场景。因用户自行使用本网站产生的任何风险、纠纷或损失，与本站无关。
      </p>
    </div>

    <el-dialog
      v-model="supportDialogVisible"
      title=""
      width="420px"
      :close-on-click-modal="false"
      class="support-modal memory-dialog"
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
.memory-hall {
  position: relative;
  width: 100%;
  min-height: calc(100vh - 56px);
  display: flex;
  flex-direction: column;
  background: transparent;
}

.memory-hall__stage {
  flex: 1;
  min-height: 48vh;
}

.memory-hall__footer {
  margin-top: auto;
  padding: 0 24px 28px;
  display: grid;
  gap: 14px;
  justify-items: center;
}

.bubble-chip,
.bubble-card {
  position: relative;
  isolation: isolate;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.15);
  box-shadow: none;
}

.bubble-chip::before,
.bubble-card::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  background: radial-gradient(circle at 22% 15%, rgba(255, 255, 255, 0.25), transparent 60%);
}

.bubble-chip {
  border-radius: 999px;
  padding: 11px 22px;
  font-size: 0.84rem;
  font-weight: 500;
  letter-spacing: 0.12em;
  color: #fff;
  cursor: pointer;
  transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
  text-shadow:
    0 1px 2px rgba(0, 0, 0, 0.62),
    0 0 18px rgba(0, 0, 0, 0.28);
  -webkit-font-smoothing: antialiased;
}

.bubble-chip:hover {
  transform: translateY(-2px);
  border-color: rgba(255, 255, 255, 0.52);
  box-shadow:
    0 14px 44px rgba(0, 0, 0, 0.18),
    inset 0 1px 0 rgba(255, 255, 255, 0.72),
    inset 0 -1px 0 rgba(255, 255, 255, 0.12);
}

.bubble-card {
  width: min(760px, 100%);
  margin: 0;
  padding: 16px 22px;
  border-radius: 22px;
  font-size: 0.74rem;
  font-weight: 400;
  line-height: 1.85;
  letter-spacing: 0.04em;
  color: rgba(255, 255, 255, 0.94);
  text-align: center;
  text-shadow:
    0 1px 2px rgba(0, 0, 0, 0.68),
    0 0 16px rgba(0, 0, 0, 0.32);
  -webkit-font-smoothing: antialiased;
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

.support-copy-sub {
  margin: 8px 0 0;
  color: var(--text-secondary);
  font-size: 0.86rem;
  line-height: 1.7;
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

:deep(.memory-dialog .el-dialog) {
  background: linear-gradient(
    145deg,
    rgba(255, 255, 255, 0.12) 0%,
    rgba(255, 255, 255, 0.04) 100%
  );
  border: 1px solid rgba(255, 255, 255, 0.34);
  box-shadow:
    0 16px 48px rgba(0, 0, 0, 0.2),
    inset 0 1px 0 rgba(255, 255, 255, 0.5);
}

@media (max-width: 640px) {
  .memory-hall__footer {
    padding: 0 14px 20px;
    gap: 12px;
  }

  .bubble-chip {
    font-size: 0.78rem;
    letter-spacing: 0.08em;
    padding: 10px 18px;
  }

  .bubble-card {
    font-size: 0.68rem;
    padding: 14px 16px;
  }

  .support-qrcode {
    width: 210px;
  }
}
</style>

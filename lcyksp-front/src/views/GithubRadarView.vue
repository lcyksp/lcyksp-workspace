<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import axios from 'axios'
import { ElMessage, ElMessageBox } from 'element-plus'

const loading = ref(false)
const saving = ref(false)
const testingId = ref(null)
const categories = ref([])
const subscriptions = ref([])
const form = reactive({ email: '', categoryIds: [], keywordsText: '', frequencies: ['daily'] })
const frequencyLabels = { daily: '日报 · 每天 08:00', weekly: '周报 · 每周一 08:00', monthly: '月报 · 每月 1 日 08:00' }
const statusLabels = { pending: '等待接收确认', active: '推送中', paused: '已暂停', closed: '已关闭' }
const statusTypes = { pending: 'warning', active: 'success', paused: 'info', closed: 'danger' }
const hasSubscriptions = computed(() => subscriptions.value.length > 0)

function parseKeywords() {
  return [...new Set(form.keywordsText.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean))]
}

async function loadData() {
  loading.value = true
  try {
    const [categoryRes, subscriptionRes] = await Promise.all([
      axios.get('/api/github-subscriptions/categories'),
      axios.get('/api/github-subscriptions'),
    ])
    categories.value = categoryRes.data?.categories || []
    subscriptions.value = subscriptionRes.data?.subscriptions || []
  } finally {
    loading.value = false
  }
}

async function saveSubscription() {
  saving.value = true
  try {
    await axios.post('/api/github-subscriptions', {
      email: form.email,
      categoryIds: form.categoryIds,
      keywords: parseKeywords(),
      frequencies: form.frequencies,
    })
    ElMessage.success('订阅设置已保存，请发送测试邮件')
    Object.assign(form, { email: '', categoryIds: [], keywordsText: '', frequencies: ['daily'] })
    await loadData()
  } finally {
    saving.value = false
  }
}

async function sendTest(item) {
  testingId.value = item.id
  try {
    const response = await axios.post(`/api/github-subscriptions/${item.id}/test-email`)
    ElMessage.success(response.data?.message || '测试邮件已发送')
    await loadData()
  } finally {
    testingId.value = null
  }
}

async function activate(item) {
  await axios.post(`/api/github-subscriptions/${item.id}/activate`)
  ElMessage.success('订阅已开启')
  await loadData()
}

async function setStatus(item, status) {
  await axios.post(`/api/github-subscriptions/${item.id}/status`, { status })
  ElMessage.success(status === 'active' ? '订阅已恢复' : status === 'paused' ? '订阅已暂停' : '订阅已关闭')
  await loadData()
}

async function removeSubscription(item) {
  await ElMessageBox.confirm(`确定删除 ${item.email} 的订阅吗？`, '删除订阅', { type: 'warning' })
  await axios.delete(`/api/github-subscriptions/${item.id}`)
  ElMessage.success('订阅已删除')
  await loadData()
}

function categoryNames(ids) {
  const selected = new Set(ids || [])
  return categories.value.filter((item) => selected.has(item.id)).map((item) => item.name)
}

onMounted(loadData)
</script>

<template>
  <div class="radar-page" v-loading="loading">
    <section class="hero-card">
      <div>
        <span class="eyebrow">GITHUB TREND RADAR</span>
        <h1>GitHub日报</h1>
        <p>持续发现新项目和快速升温的技术，以简短新闻邮件推送给你。</p>
      </div>
      <div class="schedule-note">北京时间 08:00 推送</div>
    </section>

    <section class="panel">
      <div class="panel-title"><h2>创建订阅</h2><p>预设方向和自定义关键词可同时使用，关键词会在分析阶段扩展为中英文检索词。新方向首次建立数据通常需要 1—2 天；期间历史 Star 周期尚未完整，邮件可能项目较少，系统会用已审核的近期热门和 GitHub Trending 项目补充，并明确标注来源。</p></div>
      <el-form label-position="top" @submit.prevent="saveSubscription">
        <div class="form-grid">
          <el-form-item label="接收邮箱"><el-input v-model="form.email" type="email" placeholder="name@example.com" clearable /></el-form-item>
          <el-form-item label="推送频率">
            <el-checkbox-group v-model="form.frequencies">
              <el-checkbox v-for="(label, key) in frequencyLabels" :key="key" :value="key">{{ label }}</el-checkbox>
            </el-checkbox-group>
          </el-form-item>
        </div>
        <el-form-item label="预设方向">
          <el-select v-model="form.categoryIds" multiple filterable placeholder="选择关注方向" style="width: 100%">
            <el-option v-for="item in categories" :key="item.id" :label="item.name" :value="item.id">
              <span>{{ item.name }}</span><small class="option-description">{{ item.description }}</small>
            </el-option>
          </el-select>
          <div v-if="!categories.length" class="empty-hint">管理员尚未配置预设方向，可先使用自定义关键词。</div>
        </el-form-item>
        <el-form-item label="自定义关键词">
          <el-input v-model="form.keywordsText" type="textarea" :rows="3" placeholder="例如：AI Agent、RAG、MCP、本地推理。使用逗号或换行分隔。" />
        </el-form-item>
        <el-button type="primary" :loading="saving" @click="saveSubscription">保存订阅设置</el-button>
      </el-form>
    </section>

    <section class="panel">
      <div class="panel-title"><h2>我的订阅</h2><p>先发送测试邮件；收到后点击“我已收到，开启订阅”。</p></div>
      <el-empty v-if="!hasSubscriptions" description="暂无订阅" />
      <div v-else class="subscription-list">
        <article v-for="item in subscriptions" :key="item.id" class="subscription-card">
          <div class="subscription-heading">
            <div><strong>{{ item.email }}</strong><el-tag :type="statusTypes[item.status]" size="small">{{ statusLabels[item.status] }}</el-tag></div>
            <el-button link type="danger" @click="removeSubscription(item)">删除</el-button>
          </div>
          <div class="tag-row">
            <el-tag v-for="name in categoryNames(item.categoryIds)" :key="name" effect="plain">{{ name }}</el-tag>
            <el-tag v-for="keyword in item.keywords" :key="keyword" effect="plain" type="info">{{ keyword }}</el-tag>
          </div>
          <div class="frequency-row">{{ item.frequencies.map((value) => frequencyLabels[value]).join(' · ') }}</div>
          <div class="actions">
            <el-button :loading="testingId === item.id" @click="sendTest(item)">发送测试邮件</el-button>
            <el-button v-if="item.status === 'pending'" type="primary" :disabled="!item.lastTestSentAt" @click="activate(item)">我已收到，开启订阅</el-button>
            <el-button v-if="item.status === 'active'" type="warning" @click="setStatus(item, 'paused')">暂停订阅</el-button>
            <el-button v-if="['paused', 'closed'].includes(item.status)" type="success" @click="setStatus(item, 'active')">恢复订阅</el-button>
            <el-button v-if="item.status !== 'closed'" @click="setStatus(item, 'closed')">关闭订阅</el-button>
          </div>
          <p class="test-tip">测试邮件无需回复。未收到时请检查垃圾邮件目录，3 分钟后重试，或联系客服。</p>
        </article>
      </div>
    </section>
  </div>
</template>

<style scoped>
.radar-page { min-height: 100%; padding: 24px; background: var(--bg-deep); display: grid; gap: 18px; }
.hero-card, .panel { background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 8px; padding: 24px; box-shadow: 0 16px 48px rgba(0,0,0,.18); }
.hero-card { display: flex; justify-content: space-between; gap: 20px; align-items: center; background: var(--bg-card); }
.eyebrow { color: var(--accent-blue); font-size: 12px; letter-spacing: .18em; }
h1, h2 { color: var(--text-heading); margin: 7px 0; }
p { color: var(--text-secondary); margin: 0; line-height: 1.7; }
.schedule-note { color: #fff; background: rgba(64,158,255,.18); border: 1px solid rgba(64,158,255,.4); border-radius: 999px; padding: 9px 16px; white-space: nowrap; }
.panel-title { margin-bottom: 18px; }
.form-grid { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1.2fr); gap: 18px; }
.option-description { color: var(--text-muted); margin-left: 12px; }
.empty-hint, .test-tip, .frequency-row { color: var(--text-muted); font-size: 13px; margin-top: 8px; }
.subscription-list { display: grid; gap: 14px; }
.subscription-card { border: 1px solid var(--border-color); background: var(--bg-ctrl); border-radius: 8px; padding: 18px; }
.subscription-heading, .subscription-heading > div { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-width: 0; }
.subscription-heading strong { color: var(--text-heading); }
.tag-row, .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
:deep(.el-input__wrapper), :deep(.el-textarea__inner), :deep(.el-select__wrapper) { background: var(--bg-input); }
@media (max-width: 720px) {
  .radar-page { padding: 10px; gap: 12px; }
  .hero-card, .panel { padding: 16px; border-radius: 12px; }
  .hero-card { align-items: flex-start; flex-direction: column; }
  .schedule-note { white-space: normal; font-size: 13px; }
  .form-grid { grid-template-columns: 1fr; gap: 4px; }
  .panel-title { margin-bottom: 14px; }
  .panel-title p { font-size: 13px; }
  .subscription-heading { align-items: flex-start; }
  .subscription-heading > div { flex-wrap: wrap; justify-content: flex-start; }
  .subscription-heading strong { overflow-wrap: anywhere; }
  .actions { display: grid; grid-template-columns: 1fr 1fr; }
  .actions :deep(.el-button) { width: 100%; margin-left: 0; }
  .test-tip { font-size: 12px; }
  :deep(.el-checkbox-group) { display: grid; gap: 8px; }
}
@media (max-width: 420px) {
  .actions { grid-template-columns: 1fr; }
  h1 { font-size: 1.55rem; }
}
</style>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import axios from 'axios'
import { ElMessage } from 'element-plus'

const loading = ref(false)
const redeeming = ref(false)
const currentUser = ref(null)
const redeemCode = ref('')
const redeemRecords = ref([])
const membershipConfig = ref({
  afdianUrl: '',
  notice: '',
  plans: [],
  apiReady: false,
  apiStatusText: '',
})

const isLoggedIn = computed(() => Boolean(getToken()) && Boolean(currentUser.value))

function getToken() {
  return localStorage.getItem('lcyksp_token') || ''
}

function loadLocalUser() {
  try {
    const raw = localStorage.getItem('lcyksp_user')
    currentUser.value = raw ? JSON.parse(raw) : null
  } catch {
    currentUser.value = null
  }
}

function saveCurrentUser(user) {
  currentUser.value = user || null
  if (user) {
    localStorage.setItem('lcyksp_user', JSON.stringify(user))
    window.dispatchEvent(new CustomEvent('auth-success'))
  } else {
    localStorage.removeItem('lcyksp_user')
  }
}

async function loadMembershipConfig() {
  const res = await axios.get('/api/membership/config')
  membershipConfig.value = {
    afdianUrl: res.data?.afdianUrl || '',
    notice: res.data?.notice || '',
    plans: Array.isArray(res.data?.plans) ? res.data.plans : [],
    apiReady: Boolean(res.data?.apiReady),
    apiStatusText: res.data?.apiStatusText || '',
  }
}

async function loadMyMembership() {
  if (!getToken()) {
    redeemRecords.value = []
    return
  }

  const res = await axios.get('/api/membership/my')
  redeemRecords.value = Array.isArray(res.data?.records) ? res.data.records : []
  if (res.data?.user) {
    saveCurrentUser(res.data.user)
  }
}

async function loadMembershipPage() {
  loading.value = true
  try {
    await loadMembershipConfig()
    if (getToken()) {
      try {
        await loadMyMembership()
      } catch (error) {
        if (error.response?.status === 401) {
          ElMessage.warning('当前登录状态已失效，请重新登录后再开通会员')
          saveCurrentUser(null)
          return
        }
        throw error
      }
    } else {
      redeemRecords.value = []
    }
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '加载会员信息失败')
  } finally {
    loading.value = false
  }
}

async function ensureCurrentUser() {
  if (!getToken()) {
    saveCurrentUser(null)
    return null
  }

  if (currentUser.value) {
    return currentUser.value
  }

  try {
    const res = await axios.get('/api/auth/me')
    if (res.data?.user) {
      saveCurrentUser(res.data.user)
      return res.data.user
    }
  } catch (error) {
    if (error.response?.status === 401) {
      saveCurrentUser(null)
    }
  }

  return null
}

function openAfdianPage() {
  if (!membershipConfig.value.afdianUrl) {
    ElMessage.warning('爱发电主页暂未配置')
    return
  }
  window.open(membershipConfig.value.afdianUrl, '_blank', 'noopener')
}

async function redeemMembershipCard() {
  if (!getToken()) {
    ElMessage.warning('请先登录后再兑换备用卡密')
    window.dispatchEvent(new CustomEvent('open-auth-dialog'))
    return
  }

  const input = redeemCode.value.trim()
  if (!input) {
    ElMessage.warning('请输入备用卡密或外部兑换链接')
    return
  }

  const user = await ensureCurrentUser()
  if (!user) {
    ElMessage.warning('登录状态已失效，请重新登录后再兑换')
    window.dispatchEvent(new CustomEvent('open-auth-dialog'))
    return
  }

  redeeming.value = true
  try {
    const res = await axios.post('/api/membership/redeem', { code: input })
    if (res.data?.user) {
      saveCurrentUser(res.data.user)
    }
    redeemCode.value = ''
    ElMessage.success(res.data?.message || '兑换成功')
    await loadMembershipPage()
  } catch (error) {
    if (error.response?.status === 401) {
      ElMessage.warning('请先登录后再兑换备用卡密')
      window.dispatchEvent(new CustomEvent('open-auth-dialog'))
      return
    }
    ElMessage.error(error.response?.data?.error || '兑换失败')
  } finally {
    redeeming.value = false
  }
}

function formatTime(value) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function handleAuthSuccess() {
  loadLocalUser()
  loadMembershipPage()
}

onMounted(() => {
  loadLocalUser()
  loadMembershipPage()
  window.addEventListener('auth-success', handleAuthSuccess)
})

onUnmounted(() => {
  window.removeEventListener('auth-success', handleAuthSuccess)
})
</script>

<template>
  <div class="membership-view" v-loading="loading">
    <section class="hero-card">
      <div class="hero-copy">
        <h2>成为会员</h2>
        <p>{{ membershipConfig.notice || '登录本站账号后，前往爱发电下单，并在订单备注里填写本站用户名。支付成功后，系统会自动为对应账号开通高级用户。' }}</p>
        <p class="hero-sub">推荐流程：先登录本站账号，再前往爱发电支付。卡密兑换入口保留为备用方案。</p>
      </div>

      <div class="plan-grid">
        <article v-for="plan in membershipConfig.plans" :key="plan.key" class="plan-card">
          <strong>{{ plan.description }}</strong>
          <span>{{ plan.name }}</span>
        </article>
      </div>

      <div class="hero-actions">
        <el-button type="primary" size="large" @click="openAfdianPage">前往爱发电开通</el-button>
      </div>

      <div class="status-tip" :class="{ ready: membershipConfig.apiReady }">
        {{ membershipConfig.apiStatusText || '爱发电自动开通状态暂未返回。' }}
      </div>
    </section>

    <section class="redeem-card">
      <div class="section-head">
        <h3>备用卡密兑换</h3>
        <span>{{ isLoggedIn ? '已登录，可使用备用兑换入口' : '请先登录后再使用备用兑换入口' }}</span>
      </div>

      <p class="redeem-tip">主流程推荐在爱发电下单时备注本站用户名，支付成功后系统会自动开通。这里保留本站卡密或外部兑换链接的备用兑换入口。</p>

      <div class="redeem-row">
        <el-input
          v-model="redeemCode"
          size="large"
          placeholder="输入备用卡密或外部兑换链接"
          clearable
          @keyup.enter="redeemMembershipCard"
        />
        <el-button type="success" size="large" :loading="redeeming" @click="redeemMembershipCard">
          {{ redeeming ? '兑换中...' : '立即兑换' }}
        </el-button>
      </div>
    </section>

    <section class="records-card">
      <div class="section-head">
        <h3>我的开通记录</h3>
        <span>最近 20 条</span>
      </div>

      <div v-if="!redeemRecords.length" class="empty-records">还没有开通记录</div>
      <div v-else class="record-list">
        <article v-for="record in redeemRecords" :key="record.id" class="record-item">
          <div class="record-top">
            <strong>{{ record.planName }}</strong>
            <span>{{ record.code }}</span>
          </div>
          <div class="record-meta">
            <span>开通时间：{{ formatTime(record.usedAt) }}</span>
            <span>到期时间：{{ formatTime(record.grantedExpiresAt) }}</span>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>

<style scoped>
.membership-view {
  max-width: 1080px;
  margin: 0 auto;
  padding: 20px 16px 36px;
  display: grid;
  gap: 16px;
}

.hero-card,
.redeem-card,
.records-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 18px;
  padding: 20px;
}

.hero-copy h2,
.section-head h3 {
  margin: 0;
  color: var(--text-primary);
}

.hero-copy p,
.section-head span,
.redeem-tip {
  color: var(--text-secondary);
}

.hero-sub {
  font-size: 0.84rem;
}

.plan-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-top: 18px;
}

.plan-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--bg-input) 88%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent-blue) 18%, var(--border-color));
}

.plan-card strong {
  color: var(--text-primary);
  font-size: 1rem;
}

.plan-card span {
  color: var(--text-secondary);
  font-size: 0.86rem;
}

.hero-actions {
  margin-top: 18px;
}

.status-tip {
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, #e6a23c 28%, var(--border-color));
  background: color-mix(in srgb, #e6a23c 10%, var(--bg-input));
  color: var(--text-secondary);
  font-size: 0.84rem;
  line-height: 1.7;
}

.status-tip.ready {
  border-color: color-mix(in srgb, #67c23a 28%, var(--border-color));
  background: color-mix(in srgb, #67c23a 10%, var(--bg-input));
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.redeem-tip {
  margin: 0 0 12px;
  font-size: 0.86rem;
}

.redeem-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 150px;
  gap: 12px;
}

.empty-records {
  min-height: 120px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--border-color);
  border-radius: 14px;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--bg-input) 72%, transparent);
}

.record-list {
  display: grid;
  gap: 10px;
}

.record-item {
  padding: 14px;
  border-radius: 14px;
  border: 1px solid var(--border-color);
  background: color-mix(in srgb, var(--bg-input) 86%, transparent);
}

.record-top,
.record-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.record-top strong {
  color: var(--text-primary);
}

.record-top span,
.record-meta span {
  color: var(--text-secondary);
  font-size: 0.84rem;
}

@media (max-width: 768px) {
  .membership-view {
    padding: 14px 10px 28px;
  }

  .plan-grid,
  .redeem-row {
    grid-template-columns: 1fr;
  }
}
</style>

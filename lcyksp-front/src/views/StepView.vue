<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import axios from 'axios'
import { Plus, Delete, Refresh, VideoPlay, User, Link } from '@element-plus/icons-vue'

const loading = ref(false)
const submitting = ref(false)
const adding = ref(false)
const showAdd = ref(false)

const meta = reactive({
  stepMax: 98800,
  presets: [3000, 8000, 25000, 50000, 88800],
  dailySubmitLimit: 5,
  accountCount: 0,
  premium: false,
  today: '',
})

const accounts = ref([])
const records = ref([])
const selectedAccountId = ref(null)
const steps = ref(8000)
const result = ref(null)

const form = reactive({ account: '', password: '', label: '', savePassword: true })
const pwdBusyId = ref(null)

const selectedAccount = computed(() => accounts.value.find((a) => a.id === selectedAccountId.value) || null)

const todayUsed = computed(() => {
  if (!selectedAccountId.value) return 0
  return records.value.filter(
    (r) => r.account_id === selectedAccountId.value && r.target_date === meta.today && r.status === 'success',
  ).length
})

const quotaText = computed(() => {
  if (!selectedAccountId.value) return ''
  return `今日已成功同步 ${todayUsed.value} / ${meta.dailySubmitLimit} 次`
})

async function loadMeta() {
  const { data } = await axios.get('/api/steps/meta')
  Object.assign(meta, data)
}

async function loadAccounts() {
  const { data } = await axios.get('/api/steps/accounts')
  accounts.value = data.accounts || []
  if (!accounts.value.some((a) => a.id === selectedAccountId.value)) {
    selectedAccountId.value = accounts.value[0]?.id ?? null
  }
}

async function loadRecords() {
  const { data } = await axios.get('/api/steps/records', { params: { limit: 20 } })
  records.value = data.records || []
}

async function loadAll() {
  loading.value = true
  try {
    await Promise.all([loadMeta(), loadAccounts(), loadRecords()])
  } catch {
    /* 错误提示由 axios 拦截器统一处理 */
  } finally {
    loading.value = false
  }
}

async function handleAdd() {
  if (!form.account.trim() || !form.password) {
    ElMessage.warning('请填写 Zepp Life 账号和密码')
    return
  }
  adding.value = true
  try {
    await axios.post('/api/steps/accounts', {
      account: form.account.trim(),
      password: form.password,
      label: form.label.trim(),
      savePassword: form.savePassword,
    })
    ElMessage.success(form.savePassword ? '绑定成功，密码已保存' : '绑定成功（未保存密码）')
    form.account = ''
    form.password = ''
    form.label = ''
    showAdd.value = false
    await Promise.all([loadAccounts(), loadMeta()])
  } catch {
    /* 拦截器已提示 */
  } finally {
    adding.value = false
  }
}

async function handleDelete(account) {
  try {
    await ElMessageBox.confirm(`确定解绑「${account.label || account.account_masked}」吗？密码也会一并删除。`, '解绑账号', {
      type: 'warning',
      confirmButtonText: '解绑',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await axios.delete(`/api/steps/accounts/${account.id}`)
    ElMessage.success('已解绑')
    if (selectedAccountId.value === account.id) selectedAccountId.value = null
    await Promise.all([loadAccounts(), loadMeta()])
  } catch {
    /* 拦截器已提示 */
  }
}

/** 没保存密码时临时要一次密码——只用于本次同步，不落库。取消则返回 null。 */
async function askZeppPassword(account) {
  try {
    const { value } = await ElMessageBox.prompt(
      `「${account.label || account.account_masked}」没有保存密码。请输入 Zepp Life 密码，仅本次使用、不会保存。`,
      '需要 Zepp 密码',
      {
        inputType: 'password',
        confirmButtonText: '继续同步',
        cancelButtonText: '取消',
        inputValidator: (v) => (String(v || '').trim() ? true : '请输入密码'),
      },
    )
    return value
  } catch {
    return null
  }
}

/** 保存 / 清除这个账号的 Zepp 密码。 */
async function toggleSavePassword(account) {
  if (account.has_password) {
    try {
      await ElMessageBox.confirm('清除后每次同步都要重新输入密码。确定清除吗？', '清除已保存的密码', {
        type: 'warning',
        confirmButtonText: '清除',
        cancelButtonText: '取消',
      })
    } catch {
      return
    }
    pwdBusyId.value = account.id
    try {
      await axios.put(`/api/steps/accounts/${account.id}/password`, { password: '' })
      ElMessage.success('已清除保存的密码')
      await loadAccounts()
    } catch {
      /* 拦截器已提示 */
    } finally {
      pwdBusyId.value = null
    }
    return
  }

  let pwd = ''
  try {
    const { value } = await ElMessageBox.prompt('输入该 Zepp Life 账号的密码，验证通过后会加密保存。', '保存密码', {
      inputType: 'password',
      confirmButtonText: '验证并保存',
      cancelButtonText: '取消',
      inputValidator: (v) => (String(v || '').trim() ? true : '请输入密码'),
    })
    pwd = value
  } catch {
    return
  }

  pwdBusyId.value = account.id
  try {
    await axios.put(`/api/steps/accounts/${account.id}/password`, { password: pwd })
    ElMessage.success('密码已保存')
    await loadAccounts()
  } catch {
    /* 拦截器已提示 */
  } finally {
    pwdBusyId.value = null
  }
}

async function handleSubmit() {
  const account = selectedAccount.value
  if (!account) {
    ElMessage.warning('请先选择要同步的账号')
    return
  }
  const value = Math.round(Number(steps.value))
  if (!Number.isFinite(value) || value < 1 || value > meta.stepMax) {
    ElMessage.warning(`步数需在 1 ~ ${meta.stepMax} 之间`)
    return
  }

  // 绑定时没勾「保存账号密码」的账号：同步前临时要一次，用完即弃、不进数据库
  let tempPassword = ''
  if (!account.has_password) {
    tempPassword = await askZeppPassword(account)
    if (!tempPassword) return
  }

  submitting.value = true
  result.value = null
  try {
    const { data } = await axios.post('/api/steps/submit', {
      accountId: account.id,
      steps: value,
      ...(tempPassword ? { password: tempPassword } : {}),
    })
    result.value = { ok: true, steps: data.steps, date: data.date, via: data.via }
    ElMessage.success(`同步成功，当前步数 ${data.steps}`)
    await loadRecords()
  } catch (err) {
    const msg = err?.response?.data?.error || '同步失败'
    result.value = { ok: false, message: msg }
    ElMessage.error(msg)
    await Promise.all([loadRecords(), loadAccounts()])
  } finally {
    submitting.value = false
  }
}

function pickPreset(v) {
  steps.value = v
}

function randomSteps() {
  const min = 6000
  const max = 30000
  steps.value = Math.floor(Math.random() * (max - min + 1)) + min
}

function formatTime(v) {
  if (!v) return ''
  return String(v).replace('T', ' ').slice(0, 16)
}

onMounted(loadAll)
</script>

<template>
  <div class="step-view" v-loading="loading">
    <div class="page-head">
      <h1>微信步数</h1>
      <p>绑定 Zepp Life（原小米运动）账号，一键把步数同步到微信运动。</p>
    </div>

    <el-alert type="warning" :closable="false" show-icon class="notice">
      <template #title>使用前须知</template>
      <div class="notice-body">
        <p>1. 需要 Zepp Life 账号，且该账号绑定过小米手环等设备，否则接口会拒绝。</p>
        <p>2. 步数上限 {{ meta.stepMax }}，单账号每天最多成功同步 {{ meta.dailySubmitLimit }} 次。</p>
        <p>3. 绑定的 Zepp 账号只跟当前登录的站点账号关联。</p>
        <p>4. 修改运动数据存在被平台风控的风险，请自行判断后使用。</p>
      </div>
    </el-alert>

    <section class="card">
      <div class="card-head">
        <h2><el-icon><User /></el-icon> 我的账号</h2>
        <el-button size="small" :icon="Plus" @click="showAdd = !showAdd">
          {{ showAdd ? '收起' : '添加账号' }}
        </el-button>
      </div>

      <div v-if="showAdd" class="add-form">
        <el-input v-model="form.account" placeholder="Zepp Life 账号（手机号或邮箱）" clearable />
        <el-input v-model="form.password" type="password" placeholder="密码" show-password />
        <el-input v-model="form.label" placeholder="备注名（选填）" maxlength="20" clearable />
        <el-checkbox v-model="form.savePassword" class="save-check">
          保存账号密码（下次同步不用再输入）
        </el-checkbox>
        <el-button type="primary" :loading="adding" @click="handleAdd">验证并绑定</el-button>
        <p class="add-tip">
          绑定时会真实登录一次 Zepp，验证通过才会保存。{{
            form.savePassword ? '密码加密保存，之后可随时清除。' : '不勾选则密码不落库，每次同步时临时输入。'
          }}
        </p>
      </div>

      <div v-if="!accounts.length" class="empty">
        <el-icon :size="26"><Link /></el-icon>
        <p>还没有绑定账号</p>
      </div>

      <div v-else class="account-list">
        <div
          v-for="acc in accounts"
          :key="acc.id"
          class="account-card"
          :class="{ active: acc.id === selectedAccountId, invalid: acc.status === 'invalid' }"
          @click="selectedAccountId = acc.id"
        >
          <div class="account-main">
            <div class="account-name">
              {{ acc.label || acc.account_masked }}
              <el-tag v-if="acc.status === 'invalid'" size="small" type="danger" effect="dark">需重新绑定</el-tag>
            </div>
            <div class="account-sub">
              {{ acc.account_masked }}
              <span class="pwd-state" :class="acc.has_password ? 'saved' : 'unsaved'">
                {{ acc.has_password ? '· 已保存密码' : '· 未保存密码' }}
              </span>
            </div>
          </div>
          <div class="account-actions">
            <el-button text size="small" :loading="pwdBusyId === acc.id" @click.stop="toggleSavePassword(acc)">
              {{ acc.has_password ? '清除密码' : '保存密码' }}
            </el-button>
            <el-button text type="danger" :icon="Delete" @click.stop="handleDelete(acc)" />
          </div>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2><el-icon><VideoPlay /></el-icon> 设置步数</h2>
        <span v-if="quotaText" class="quota">{{ quotaText }}</span>
      </div>

      <div class="preset-row">
        <el-button v-for="p in meta.presets" :key="p" size="small" round @click="pickPreset(p)">
          {{ p >= 10000 ? p / 10000 + '万' : p }}
        </el-button>
        <el-button size="small" round :icon="Refresh" @click="randomSteps">随机</el-button>
      </div>

      <div class="step-input">
        <el-input-number
          v-model="steps"
          :min="1"
          :max="meta.stepMax"
          :step="100"
          controls-position="right"
          size="large"
        />
        <span class="unit">步</span>
      </div>

      <el-slider v-model="steps" :min="1" :max="meta.stepMax" :step="10" />

      <el-button
        type="primary"
        size="large"
        class="submit-btn"
        :loading="submitting"
        :disabled="!selectedAccountId"
        @click="handleSubmit"
      >
        {{ selectedAccountId ? `同步到 ${selectedAccount?.label || selectedAccount?.account_masked}` : '请先选择账号' }}
      </el-button>

      <div v-if="result" class="result" :class="result.ok ? 'ok' : 'fail'">
        <template v-if="result.ok">
          已同步 {{ result.steps }} 步（{{ result.date }}）<span v-if="result.via === 'pool'"> · 走代理出口</span>
        </template>
        <template v-else>{{ result.message }}</template>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>最近记录</h2>
        <el-button size="small" text :icon="Refresh" @click="loadRecords">刷新</el-button>
      </div>

      <div v-if="!records.length" class="empty"><p>还没有同步记录</p></div>

      <div v-else class="record-list">
        <div v-for="r in records" :key="r.id" class="record-row">
          <div class="record-left">
            <span class="record-steps">{{ r.steps }} 步</span>
            <span class="record-account">{{ r.label || r.account_masked || '已解绑账号' }}</span>
          </div>
          <div class="record-right">
            <el-tag size="small" :type="r.status === 'success' ? 'success' : 'danger'" effect="plain">
              {{ r.status === 'success' ? '成功' : '失败' }}
            </el-tag>
            <span class="record-time">{{ formatTime(r.created_at) }}</span>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.step-view {
  max-width: 820px;
  margin: 0 auto;
  padding: 20px 16px 60px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  -webkit-tap-highlight-color: transparent;
}

.page-head h1 {
  margin: 0 0 6px;
  font-size: 22px;
  font-weight: 600;
  color: var(--text-heading);
}

.page-head p {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.notice-body p {
  margin: 2px 0;
  font-size: 13px;
  line-height: 1.7;
}

.card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 18px;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.card-head h2 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.quota {
  font-size: 12px;
  color: var(--text-secondary);
}

.add-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  margin-bottom: 14px;
  border-radius: 10px;
  background: var(--bg-ctrl);
}

.add-tip {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 26px 0;
  color: var(--text-placeholder);
  font-size: 13px;
}

.empty p {
  margin: 0;
}

.account-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.account-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  cursor: pointer;
  transition: border-color 0.15s, background-color 0.15s;
}

/* 只在真有悬停能力的设备上给 hover 效果——手机上点完会「粘住」 */
@media (hover: hover) {
  .account-card:hover {
    border-color: var(--el-color-primary-light-5);
  }
}

.account-card.active {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}

.account-card.invalid {
  border-color: var(--el-color-danger-light-5);
}

.account-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.account-sub {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-secondary);
}

.account-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.pwd-state {
  font-size: 12px;
}

.pwd-state.saved {
  color: var(--accent-green);
}

.pwd-state.unsaved {
  color: var(--accent-gold);
}

.save-check {
  margin: -2px 0 4px;
}

.preset-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}

.step-input {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.unit {
  font-size: 14px;
  color: var(--text-secondary);
}

.submit-btn {
  width: 100%;
  margin-top: 14px;
}

.result {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 13px;
}

.result.ok {
  background: var(--el-color-success-light-9);
  color: var(--accent-green);
}

.result.fail {
  background: var(--el-color-danger-light-9);
  color: var(--accent-red);
}

.record-list {
  display: flex;
  flex-direction: column;
}

.record-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border-subtle);
}

.record-row:last-child {
  border-bottom: none;
}

.record-left {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.record-steps {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.record-account {
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.record-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.record-time {
  font-size: 12px;
  color: var(--text-secondary);
}

/* 手机 / 窄屏适配（沿用项目统一的 768px 断点） */
@media (max-width: 768px) {
  .step-view {
    padding: 14px 12px 48px;
    gap: 12px;
  }

  .page-head h1 {
    font-size: 19px;
  }

  .card {
    padding: 14px;
    border-radius: 10px;
  }

  /* 标题与右侧说明（如「今日已同步 x/y 次」）窄屏换行，不互相挤压 */
  .card-head {
    flex-wrap: wrap;
    gap: 6px 10px;
  }

  /* 账号卡片改上下两层：信息一行、操作一行，按钮不再挤压账号名 */
  .account-card {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }

  .account-actions {
    justify-content: flex-end;
    padding-top: 6px;
    border-top: 1px solid var(--border-subtle);
  }

  /* 记录行允许换行，避免时间被挤掉 */
  .record-row {
    flex-wrap: wrap;
  }

  .record-right {
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
  }

  /* 触摸目标放大，手指点得中 */
  .step-view :deep(.el-button) {
    min-height: 34px;
  }

  .add-form :deep(.el-button) {
    width: 100%;
  }

  /* 预设按钮平分整行，排布更整齐 */
  .preset-row :deep(.el-button) {
    flex: 1 1 auto;
    min-width: 62px;
    margin-left: 0;
  }

  .step-input :deep(.el-input-number) {
    flex: 1;
  }
}
</style>

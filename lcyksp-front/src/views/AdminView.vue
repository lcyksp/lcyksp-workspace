<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { InfoFilled, Plus, Refresh, Search } from '@element-plus/icons-vue'
import axios from 'axios'
import { formatSize } from '../utils/format.js'

const currentUser = (() => {
  try {
    const raw = localStorage.getItem('lcyksp_user')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
})()

const files = ref([])
const filesLoading = ref(false)

const users = ref([])
const usersLoading = ref(false)
const userKeyword = ref('')

const feedbackList = ref([])
const feedbackLoading = ref(false)
const feedbackDeletingId = ref(null)

const fileDialogVisible = ref(false)
const fileFormLoading = ref(false)
const fileForm = reactive({
  code: '',
  newCode: '',
  fileName: '',
  expireTime: '',
  isPermanent: false,
  maxDownloads: null,
})

const userDialogVisible = ref(false)
const userDialogMode = ref('add')
const userFormLoading = ref(false)
const userForm = reactive({
  id: null,
  username: '',
  password: '',
  role: 'user',
  premiumPreset: 'none',
  premiumExpiresAt: '',
  isBanned: false,
  bannedReason: '',
})

const membershipConfig = reactive({
  afdianUrl: '',
  notice: '登录本站账号后，前往爱发电下单，并在订单备注里填写本站用户名。支付成功后，系统会自动为对应账号开通高级用户。',
  afdianUserId: '',
  afdianToken: '',
  webhookToken: '',
  planIdMonthly: '',
  planIdQuarterly: '',
  planIdYearly: '',
  afdianReplyTemplate: '',
  plans: [],
})
const membershipConfigLoading = ref(false)
const membershipConfigSaving = ref(false)
const membershipCards = ref([])
const membershipCardsLoading = ref(false)
const membershipSimulating = ref(false)
const membershipCardsPage = ref(1)
const membershipCardsPageSize = 20
const membershipCardStatusFilter = ref('') // '' = all, 'unused', 'used', 'invalid'
const membershipCardFilterPlan = ref('monthly')
const cardDetail = ref(null)
const cardDetailVisible = ref(false)

function planCardStats(planKey) {
  const cards = membershipCards.value.filter(c => c.planKey === planKey)
  const stats = { total: cards.length, unused: 0, used: 0 }
  cards.forEach(c => { if (c.status === 'used') stats.used += 1; else stats.unused += 1 })
  return stats
}

function filteredPlanCards(planKey) {
  let cards = membershipCards.value.filter(c => c.planKey === planKey)
  if (planKey !== membershipCardFilterPlan.value) return []
  if (membershipCardStatusFilter.value === 'unused') return cards.filter(c => c.status !== 'used' && c.status !== 'invalid')
  if (membershipCardStatusFilter.value === 'used') return cards.filter(c => c.status === 'used')
  return cards
}

function openCardDetail(card) {
  cardDetail.value = card
  cardDetailVisible.value = true
}
const membershipCardForm = reactive({
  planKey: 'monthly',
  quantity: 1,
  note: '',
})
const membershipCardGenerating = ref(false)
const generatedCardCodes = ref([])
const membershipImportForm = reactive({
  planKey: 'monthly',
  note: '',
  codesText: '',
})
const membershipSimulateForm = reactive({
  username: '',
  planKey: 'monthly',
  outTradeNo: '',
  remark: '',
})
const membershipImporting = ref(false)
const membershipImportSummary = ref(null)
const githubRadarLoading = ref(false)
const githubRadarSaving = ref(false)
const githubCategoryLoading = ref(false)
const githubCategorySaving = ref(false)
const githubCategories = ref([])
const githubRadarConfig = reactive({
  primaryAiUrl: 'https://api.deepseek.com', primaryAiModel: 'deepseek-chat', primaryAiKey: '', primaryAiConfigured: false,
  githubToken: '', githubTokenConfigured: false,
  smtpPassword: '', smtpConfigured: false,
  smtpHost: 'smtp.163.com', smtpPort: 465,
  smtpUser: '', smtpFrom: '',
  aiFallbackUrl: '', aiFallbackModel: '', aiFallbackKey: '', aiFallbackConfigured: false,
  proxySubscription: '', proxyConfigured: false, proxyStatus: '未检测', proxyNode: '', proxyCheckedAt: '',
})
const githubCategoryForm = reactive({ name: '', description: '', keywords: '', languages: '' })
const githubAdminSubscriptions = ref([])
const githubAdminSubscriptionsLoading = ref(false)
const githubAdminSubscriptionForm = reactive({ id: null, userId: '', email: '', categoryIds: [], keywords: '', frequencies: ['daily'], status: 'active' })
const quickActionLoadingId = ref(null)

// 战争雷霆交易所：凭据配置 + 状态 + 手动快照
const wtStatus = reactive({ credentialsConfigured: false, loginMasked: '', lastSnapshotAt: '', lastError: '', itemCount: 0 })
const wtCred = reactive({ login: '', password: '' })
const wtLoading = ref(false)
const wtSaving = ref(false)
const wtRefreshing = ref(false)
const wtLogs = ref([])
const wtLogsLoading = ref(false)

async function loadWtStatus() {
  wtLoading.value = true
  try {
    const res = await axios.get('/api/wt-market/status')
    Object.assign(wtStatus, res.data || {})
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '加载战争雷霆状态失败')
  } finally { wtLoading.value = false }
}

// 操作日志（登录/快照/搜索的自动+手动记录，含出口 IP 与返回摘要，用于事后排障）
async function loadWtLogs() {
  wtLogsLoading.value = true
  try {
    const res = await axios.get('/api/wt-market/logs', { params: { limit: 50 } })
    wtLogs.value = res.data?.logs || []
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '加载操作日志失败')
  } finally { wtLogsLoading.value = false }
}

const WT_OP_LABEL = { login: '登录', snapshot: '快照', search: '搜索' }
const WT_TRIGGER_LABEL = { auto: '自动', manual: '手动', 'manual-cred': '验证凭据', user: '用户' }
function wtStatusTagType(status) {
  if (status === 'ok') return 'success'
  if (status === 'fail') return 'danger'
  if (status === 'skip') return 'info'
  return 'warning'
}

async function saveWtCredentials() {
  if (!wtCred.login.trim() || !wtCred.password) { ElMessage.warning('请填写 Gaijin 邮箱和密码'); return }
  wtSaving.value = true
  try {
    const res = await axios.post('/api/wt-market/credentials', { login: wtCred.login.trim(), password: wtCred.password })
    if (res.data?.verified) ElMessage.success('凭据已保存并验证通过')
    else ElMessage.warning(`凭据已保存，但登录验证未通过：${res.data?.error || '未知'}`)
    wtCred.password = ''
    await loadWtStatus()
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '保存凭据失败')
  } finally { wtSaving.value = false }
}

async function triggerWtSnapshot() {
  wtRefreshing.value = true
  try {
    const res = await axios.post('/api/wt-market/refresh')
    ElMessage.success(`快照完成：${res.data?.itemCount ?? 0} 个物品`)
    await Promise.all([loadWtStatus(), loadWtLogs()])
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '快照失败')
    void loadWtLogs()
  } finally { wtRefreshing.value = false }
}

async function loadGithubAdminSubscriptions() {
  githubAdminSubscriptionsLoading.value = true
  try { const res = await axios.get('/api/admin/github-radar/subscriptions'); githubAdminSubscriptions.value = res.data?.subscriptions || [] } catch (error) { ElMessage.error(error.response?.data?.error || '加载订阅失败') } finally { githubAdminSubscriptionsLoading.value = false }
}
function editGithubAdminSubscription(row) { Object.assign(githubAdminSubscriptionForm, { id: row.id, userId: row.userId, email: row.email, categoryIds: row.categoryIds || [], keywords: (row.keywords || []).join(', '), frequencies: row.frequencies || ['daily'], status: row.status }) }
function resetGithubAdminSubscription() { Object.assign(githubAdminSubscriptionForm, { id: null, userId: '', email: '', categoryIds: [], keywords: '', frequencies: ['daily'], status: 'active' }) }
async function saveGithubAdminSubscription() {
  const payload = { userId: Number(githubAdminSubscriptionForm.userId), email: githubAdminSubscriptionForm.email, categoryIds: githubAdminSubscriptionForm.categoryIds, keywords: githubAdminSubscriptionForm.keywords.split(/[,，\n]/).map(v => v.trim()).filter(Boolean), frequencies: githubAdminSubscriptionForm.frequencies, status: githubAdminSubscriptionForm.status }
  try { if (githubAdminSubscriptionForm.id) await axios.put(`/api/admin/github-radar/subscriptions/${githubAdminSubscriptionForm.id}`, payload); else await axios.post('/api/admin/github-radar/subscriptions', payload); ElMessage.success('订阅已保存'); resetGithubAdminSubscription(); await loadGithubAdminSubscriptions() } catch (error) { ElMessage.error(error.response?.data?.error || '保存订阅失败') }
}
async function deleteGithubAdminSubscription(row) { try { await ElMessageBox.confirm(`确定删除 ${row.email} 的订阅吗？`, '删除订阅', { type: 'warning' }); await axios.delete(`/api/admin/github-radar/subscriptions/${row.id}`); ElMessage.success('订阅已删除'); await loadGithubAdminSubscriptions() } catch (error) { if (error !== 'cancel') ElMessage.error(error.response?.data?.error || '删除失败') } }
async function scheduleGithubSimulation() { try { const { value } = await ElMessageBox.prompt('模拟日报发送到哪个邮箱？', '安排模拟日报', { inputValue: githubAdminSubscriptionForm.email || '', inputPattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, inputErrorMessage: '请输入有效邮箱' }); const res = await axios.post('/api/admin/github-radar/simulation', { email: value.trim(), delayMinutes: 30, type: 'daily' }); ElMessage.success(`模拟日报已安排：${new Date(res.data.runAt).toLocaleString()}`) } catch (error) { if (error !== 'cancel') ElMessage.error(error.response?.data?.error || '安排模拟日报失败') } }

const SITE_MONITOR_EVENT_META = {
  model_added: { label: '新增模型', type: 'success' },
  model_removed: { label: '下架模型', type: 'danger' },
  announcement_added: { label: '新公告', type: 'warning' },
  monitor_failed: { label: '监测失败', type: 'info' },
  monitor_recovered: { label: '监测恢复', type: 'info' },
}
const SITE_MONITOR_TRIGGER_LABEL = { schedule: '定时', manual: '手动', diagnose: '诊断', baseline: '基线' }
const SITE_MONITOR_EVENT_PAGE_SIZE = 10

const siteMonitorLoading = ref(false)
const siteMonitorTesting = ref(false)
const siteMonitorSmtpConfigured = ref(false)
const siteMonitorHeartbeatSeconds = ref(300)
const siteMonitors = ref([])
const siteMonitorForms = reactive({})
const siteMonitorBusy = reactive({})
const siteMonitorEventSource = ref('')
const siteMonitorEvents = ref([])
const siteMonitorEventsTotal = ref(0)
const siteMonitorEventsPage = ref(1)
const siteMonitorEventsLoading = ref(false)

// 后端存的是 SQLite 的 UTC 字符串（YYYY-MM-DD HH:MM:SS），不补 Z 会被当成本地时间，显示差 8 小时。
function siteMonitorTime(value) {
  if (!value) return '—'
  const text = String(value)
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(' ', 'T')}Z` : text
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? text : date.toLocaleString('zh-CN', { hour12: false })
}
function siteMonitorEventMeta(type) { return SITE_MONITOR_EVENT_META[type] || { label: type, type: 'info' } }
function siteMonitorTriggerLabel(type) { return SITE_MONITOR_TRIGGER_LABEL[type] || type }
function siteMonitorBusyWith(source) { return siteMonitorBusy[source] || '' }

async function withSiteMonitorBusy(source, action, task) {
  if (siteMonitorBusy[source]) return
  siteMonitorBusy[source] = action
  try { await task() } finally { siteMonitorBusy[source] = '' }
}

function siteMonitorActionError(error, fallback) {
  const data = error.response?.data
  const message = data?.error || fallback
  ElMessage.error(data?.credentialRejected ? `${message}（登录会话或临时 Token 已失效，请更新后重试）` : message)
}

async function loadSiteMonitors() {
  siteMonitorLoading.value = true
  try {
    const res = await axios.get('/api/admin/site-monitor')
    siteMonitorSmtpConfigured.value = Boolean(res.data?.smtpConfigured)
    siteMonitorHeartbeatSeconds.value = Number(res.data?.heartbeatSeconds || 300)
    siteMonitors.value = res.data?.monitors || []
    for (const monitor of siteMonitors.value) {
      // 凭据只在内存里停留到保存为止，任何时候都不写 localStorage，接口也只回掩码。
      if (!siteMonitorForms[monitor.source]) siteMonitorForms[monitor.source] = { authType: 'none', authSecret: '', recipientEmail: '' }
      const form = siteMonitorForms[monitor.source]
      form.authType = monitor.authType
      form.recipientEmail = monitor.recipientEmail
      form.authSecret = ''
      if (!siteMonitorBusy[monitor.source]) siteMonitorBusy[monitor.source] = ''
    }
    if (!siteMonitorEventSource.value && siteMonitors.value.length) {
      siteMonitorEventSource.value = siteMonitors.value[0].source
      await loadSiteMonitorEvents()
    }
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '加载网站监测失败')
  } finally {
    siteMonitorLoading.value = false
  }
}

async function loadSiteMonitorEvents() {
  if (!siteMonitorEventSource.value) return
  siteMonitorEventsLoading.value = true
  try {
    const res = await axios.get(`/api/admin/site-monitor/${siteMonitorEventSource.value}/events`, {
      params: { page: siteMonitorEventsPage.value, pageSize: SITE_MONITOR_EVENT_PAGE_SIZE },
    })
    siteMonitorEvents.value = res.data?.events || []
    siteMonitorEventsTotal.value = Number(res.data?.total || 0)
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '加载变更记录失败')
  } finally {
    siteMonitorEventsLoading.value = false
  }
}
function switchSiteMonitorEventSource() { siteMonitorEventsPage.value = 1; loadSiteMonitorEvents() }
function changeSiteMonitorEventsPage(page) { siteMonitorEventsPage.value = page; loadSiteMonitorEvents() }

async function saveSiteMonitorConfig(monitor) {
  const form = siteMonitorForms[monitor.source]
  const payload = { authType: form.authType, recipientEmail: form.recipientEmail }
  if (form.authType !== 'none' && form.authSecret.trim()) payload.authSecret = form.authSecret.trim()
  await withSiteMonitorBusy(monitor.source, 'save', async () => {
    try {
      await axios.post(`/api/admin/site-monitor/${monitor.source}/config`, payload)
      form.authSecret = ''
      ElMessage.success('配置已保存')
      await loadSiteMonitors()
    } catch (error) { ElMessage.error(error.response?.data?.error || '保存失败') }
  })
}

async function toggleSiteMonitor(monitor, enabled) {
  await withSiteMonitorBusy(monitor.source, 'toggle', async () => {
    try {
      await axios.post(`/api/admin/site-monitor/${monitor.source}/config`, { enabled })
      ElMessage.success(enabled ? '监测已开启' : '监测已关闭')
    } catch (error) { ElMessage.error(error.response?.data?.error || '切换失败') }
    // 无论成功失败都重新拉一次，开关状态以服务端为准。
    await loadSiteMonitors()
  })
}

async function diagnoseSiteMonitor(monitor) {
  await withSiteMonitorBusy(monitor.source, 'diagnose', async () => {
    try {
      const res = await axios.post(`/api/admin/site-monitor/${monitor.source}/diagnose`)
      ElMessage.success(`诊断通过，解析到 ${res.data.itemCount} 项`)
    } catch (error) { siteMonitorActionError(error, '诊断失败') }
    await loadSiteMonitors()
  })
}

async function checkSiteMonitor(monitor) {
  await withSiteMonitorBusy(monitor.source, 'check', async () => {
    try {
      const res = await axios.post(`/api/admin/site-monitor/${monitor.source}/check`)
      const added = res.data.added?.length || 0
      const removed = res.data.removed?.length || 0
      if (res.data.status === 'baseline') ElMessage.success('已建立首轮基线，本次不发送通知')
      else if (!added && !removed) ElMessage.success('检查完成，没有变化')
      else {
        const mail = res.data.delivery?.sent ? '，通知已发出' : res.data.queuedEmail ? '，通知已入队' : ''
        ElMessage.success(`新增 ${added} / 下架 ${removed}${mail}`)
      }
    } catch (error) { siteMonitorActionError(error, '检查失败') }
    await loadSiteMonitors()
    await loadSiteMonitorEvents()
  })
}

async function rebuildSiteMonitorBaseline(monitor) {
  try {
    await ElMessageBox.confirm(`重建「${monitor.displayName}」基线会清空当前快照并重新抓取一次，本次不发送通知。`, '重建基线', { type: 'warning' })
  } catch { return }
  await withSiteMonitorBusy(monitor.source, 'baseline', async () => {
    try {
      const res = await axios.post(`/api/admin/site-monitor/${monitor.source}/rebuild-baseline`)
      ElMessage.success(`基线已重建，共 ${res.data.itemCount} 项`)
    } catch (error) { siteMonitorActionError(error, '重建基线失败') }
    await loadSiteMonitors()
  })
}

async function sendSiteMonitorTestEmail() {
  siteMonitorTesting.value = true
  try {
    const recipient = siteMonitors.value[0]?.recipientEmail || ''
    const res = await axios.post('/api/admin/site-monitor/test-email', recipient ? { recipient } : {})
    ElMessage.success(`测试邮件已发送至 ${res.data.recipient}`)
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '测试邮件发送失败')
  } finally {
    siteMonitorTesting.value = false
  }
}

const premiumPresetOptions = [
  { label: '不开通', value: 'none' },
  { label: '7天', value: '7d' },
  { label: '30天', value: '30d' },
  { label: '永久', value: 'permanent' },
  { label: '自定义', value: 'custom' },
]

const userRoleLabel = computed(() => {
  return userForm.role === 'admin' ? '管理员' : userForm.role === 'pro' ? 'Pro 用户' : userForm.role === 'premium' ? '高级用户' : '普通用户'
})

const membershipCardStats = computed(() => {
  const stats = {
    total: membershipCards.value.length,
    unused: 0,
    used: 0,
    invalid: 0,
  }

  membershipCards.value.forEach((card) => {
    if (card.status === 'used') stats.used += 1
    else if (card.status === 'invalid') stats.invalid += 1
    else stats.unused += 1
  })

  return stats
})

const filteredMembershipCards = computed(() => {
  if (!membershipCardStatusFilter.value) return membershipCards.value
  return membershipCards.value.filter(card => card.status === membershipCardStatusFilter.value)
})

const pagedMembershipCards = computed(() => {
  const start = (membershipCardsPage.value - 1) * membershipCardsPageSize
  return filteredMembershipCards.value.slice(start, start + membershipCardsPageSize)
})

async function loadFiles() {
  filesLoading.value = true
  try {
    const res = await axios.get('/api/admin/files')
    files.value = Array.isArray(res.data?.files) ? res.data.files : []
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '加载文件列表失败')
  } finally {
    filesLoading.value = false
  }
}

async function deleteFile(code, fileName) {
  try {
    await ElMessageBox.confirm(`确定要删除文件“${fileName}”吗？此操作不可撤销。`, '删除文件', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
    await axios.delete(`/api/admin/files/${code}`)
    ElMessage.success('文件已删除')
    loadFiles()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      ElMessage.error(error.response?.data?.error || '删除文件失败')
    }
  }
}

function openEditFile(file) {
  fileForm.code = file.id
  fileForm.newCode = file.id
  fileForm.fileName = file.fileName
  fileForm.maxDownloads = file.maxDownloads

  if (!file.expireTime || String(file.expireTime).includes('2099')) {
    fileForm.expireTime = ''
    fileForm.isPermanent = true
  } else {
    fileForm.expireTime = file.expireTime
    fileForm.isPermanent = false
  }

  fileDialogVisible.value = true
}

async function submitFileForm() {
  const payload = {}

  if (fileForm.fileName.trim()) {
    payload.fileName = fileForm.fileName.trim()
  }

  if (fileForm.newCode.trim() && fileForm.newCode.trim() !== fileForm.code) {
    payload.newCode = fileForm.newCode.trim()
  }

  if (fileForm.isPermanent) {
    payload.expireTime = 'permanent'
  } else if (fileForm.expireTime) {
    const date = new Date(fileForm.expireTime)
    if (Number.isNaN(date.getTime())) {
      ElMessage.warning('请选择有效的过期时间')
      return
    }
    payload.expireTime = date.toISOString()
  }

  if (fileForm.maxDownloads !== null && fileForm.maxDownloads !== undefined) {
    payload.maxDownloads = fileForm.maxDownloads
  }

  if (!Object.keys(payload).length) {
    ElMessage.warning('请至少修改一个字段')
    return
  }

  fileFormLoading.value = true
  try {
    await axios.put(`/api/admin/files/${fileForm.code}`, payload)
    ElMessage.success('文件属性已更新')
    fileDialogVisible.value = false
    loadFiles()
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '更新文件失败')
  } finally {
    fileFormLoading.value = false
  }
}

async function loadUsers() {
  usersLoading.value = true
  try {
    const params = userKeyword.value.trim() ? { keyword: userKeyword.value.trim() } : undefined
    const res = await axios.get('/api/admin/users', { params })
    users.value = Array.isArray(res.data?.users) ? res.data.users : []
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '加载用户列表失败')
  } finally {
    usersLoading.value = false
  }
}

function resetUserForm() {
  userForm.id = null
  userForm.username = ''
  userForm.password = ''
  userForm.role = 'user'
  userForm.premiumPreset = 'none'
  userForm.premiumExpiresAt = ''
  userForm.isBanned = false
  userForm.bannedReason = ''
}

function openAddUser() {
  userDialogMode.value = 'add'
  resetUserForm()
  userDialogVisible.value = true
}

function inferPremiumPreset(expiresAt) {
  if (!expiresAt) return 'none'
  if (String(expiresAt).includes('2099')) return 'permanent'
  return 'custom'
}

function openEditUser(user) {
  userDialogMode.value = 'edit'
  userForm.id = user.id
  userForm.username = user.username
  userForm.password = ''
  userForm.role = user.role || 'user'
  userForm.isBanned = Boolean(user.is_banned || user.isBanned)
  userForm.bannedReason = user.banned_reason || user.bannedReason || ''
  userForm.premiumExpiresAt = ''

  const expiresAt = user.premium_expires_at || user.premiumExpiresAt || ''
  userForm.premiumPreset = inferPremiumPreset(expiresAt)
  if (expiresAt && userForm.premiumPreset === 'custom') {
    const date = new Date(expiresAt)
    if (!Number.isNaN(date.getTime())) {
      const pad = (value) => String(value).padStart(2, '0')
      userForm.premiumExpiresAt = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
    }
  }

  userDialogVisible.value = true
}

function buildPremiumExpiresAt() {
  if (userForm.role !== 'premium') return null
  if (userForm.premiumPreset === 'permanent') return '2099-12-31T23:59:59.000Z'
  if (userForm.premiumPreset === '7d' || userForm.premiumPreset === '30d') {
    const days = userForm.premiumPreset === '7d' ? 7 : 30
    const date = new Date()
    date.setDate(date.getDate() + days)
    return date.toISOString()
  }
  if (userForm.premiumPreset === 'custom') {
    const date = new Date(userForm.premiumExpiresAt)
    if (Number.isNaN(date.getTime())) return '__invalid__'
    return date.toISOString()
  }
  return null
}

async function submitUserForm() {
  if (!userForm.username || userForm.username.trim().length < 2) {
    ElMessage.warning('用户名至少 2 个字符')
    return
  }
  if (userDialogMode.value === 'add' && (!userForm.password || userForm.password.length < 6)) {
    ElMessage.warning('密码至少 6 个字符')
    return
  }
  if (userForm.role === 'premium' && userForm.premiumPreset === 'none') {
    ElMessage.warning('请为高级用户选择有效期')
    return
  }
  if (userForm.isBanned && !userForm.bannedReason.trim()) {
    ElMessage.warning('请填写封禁原因')
    return
  }

  const premiumExpiresAt = buildPremiumExpiresAt()
  if (premiumExpiresAt === '__invalid__') {
    ElMessage.warning('请输入有效的高级用户到期时间')
    return
  }

  userFormLoading.value = true
  try {
    const payload = {
      username: userForm.username.trim(),
      role: userForm.role,
      premiumExpiresAt,
      isBanned: userForm.isBanned,
      bannedReason: userForm.isBanned ? userForm.bannedReason.trim() : '',
    }
    if (userForm.password) payload.password = userForm.password

    if (userDialogMode.value === 'add') {
      await axios.post('/api/admin/users', {
        ...payload,
        password: userForm.password,
      })
      ElMessage.success('用户创建成功')
    } else {
      await axios.put(`/api/admin/users/${userForm.id}`, payload)
      ElMessage.success('用户信息已更新')
    }

    userDialogVisible.value = false
    loadUsers()
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '保存用户失败')
  } finally {
    userFormLoading.value = false
  }
}

async function deleteUser(user) {
  if (user.id === currentUser?.id) {
    ElMessage.warning('不能删除当前登录的管理员账号')
    return
  }

  try {
    await ElMessageBox.confirm(`确定要删除用户“${user.username}”吗？`, '删除用户', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
    await axios.delete(`/api/admin/users/${user.id}`)
    ElMessage.success('用户已删除')
    loadUsers()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      ElMessage.error(error.response?.data?.error || '删除用户失败')
    }
  }
}

// ---------- 抖音解析出口（巨量动态住宅池 · 多池 + 直连额度） ----------
const POOL_TTL_OPTIONS = [
  { label: '1 分钟', value: 60000 },
  { label: '3 分钟', value: 180000 },
  { label: '5 分钟', value: 300000 },
  { label: '10 分钟', value: 600000 },
  { label: '30 分钟', value: 1800000 },
]

const poolLoading = ref(false)
const poolRefreshing = ref(false)
const poolTesting = ref(false)
const poolProbing = ref(false)
const poolSubmitting = ref(false)
const thresholdSaving = ref(false)
const budgetResetting = ref(false)

const poolList = ref([])
const activePoolId = ref('')
const lowBalanceThreshold = ref(200)
const probeIntervalHours = ref(4)
const directBudget = reactive({ windowMs: 0, lastUsedAt: '', nextAvailableAt: '', available: true })
const poolExtractStats = reactive({ day: '', today: 0, total: 0, estimatedDaysLeft: null })
const gateState = reactive({ direct: 'unknown', lastProbeAt: '', lastChangeAt: '' })

const poolDialog = reactive({ visible: false, mode: 'add', id: '', name: '', extractUrl: '', key: '', ttlMs: 60000 })

const directGateMeta = computed(() => {
  switch (gateState.direct) {
    case 'ok': return { text: '已解封（受限使用：每 4 小时只允许一次直连，其余走池）', type: 'success' }
    case 'blocked': return { text: '被风控标记（解析全部走动态池出口）', type: 'error' }
    default: return { text: '尚未探测', type: 'info' }
  }
})

function formatBeijing(iso) {
  if (iso === null || iso === undefined || iso === '') return '—'
  const t = typeof iso === 'number' ? iso : Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  return new Date(t + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16)
}

function poolBalanceText(pool) {
  if (pool.balanceError) return pool.balanceError
  if (pool.balance === null || pool.balance === undefined) return '—'
  return `${pool.balance} 个 IP`
}

function poolBalanceMeta(pool) {
  if (!pool.enabled) return { type: 'info', text: '已停用' }
  if (pool.balanceError) return { type: 'warning', text: '查询失败' }
  if (pool.balance === null || pool.balance === undefined) return { type: 'info', text: '未配置 key' }
  if (pool.balance <= 0) return { type: 'danger', text: '已耗尽' }
  if (pool.balance <= lowBalanceThreshold.value) return { type: 'warning', text: '余量不足' }
  return { type: 'success', text: '正常' }
}

async function loadPoolConfig(refresh = false) {
  if (refresh) poolRefreshing.value = true
  else poolLoading.value = true
  try {
    const res = await axios.get('/api/video/pool-config', { params: refresh ? { refresh: 1 } : {} })
    if (res.data?.success) {
      poolList.value = res.data.pools || []
      activePoolId.value = res.data.activePoolId || ''
      lowBalanceThreshold.value = res.data.lowBalanceThreshold ?? 200
      probeIntervalHours.value = Math.round((res.data.probeIntervalMs || 4 * 3600 * 1000) / 3600000)
      Object.assign(directBudget, res.data.directBudget || {})
      Object.assign(poolExtractStats, res.data.extractStats || {})
      gateState.direct = res.data.gate?.direct || 'unknown'
      gateState.lastProbeAt = res.data.gate?.lastProbeAt || ''
      gateState.lastChangeAt = res.data.gate?.lastChangeAt || ''
    }
  } catch (error) {
    console.error('加载抖音解析出口配置失败', error)
  } finally {
    poolLoading.value = false
    poolRefreshing.value = false
  }
}

function openAddPool() {
  Object.assign(poolDialog, { visible: true, mode: 'add', id: '', name: '', extractUrl: '', key: '', ttlMs: 60000 })
}

function openEditPool(pool) {
  Object.assign(poolDialog, { visible: true, mode: 'edit', id: pool.id, name: pool.name, extractUrl: '', key: '', ttlMs: pool.ttlMs || 60000 })
}

async function submitPoolForm() {
  if (poolDialog.mode === 'add') {
    if (!poolDialog.extractUrl.trim()) {
      ElMessage.warning('提取链接不能为空')
      return
    }
    if (!poolDialog.key.trim()) {
      ElMessage.warning('业务 key 不能为空（没有它查不到剩余 IP 数量）')
      return
    }
  }
  poolSubmitting.value = true
  try {
    const payload = poolDialog.mode === 'add'
      ? { action: 'add', name: poolDialog.name.trim(), extractUrl: poolDialog.extractUrl.trim(), key: poolDialog.key.trim(), ttlMs: Number(poolDialog.ttlMs) || 60000 }
      : { action: 'update', id: poolDialog.id, name: poolDialog.name.trim(), ttlMs: Number(poolDialog.ttlMs) || 60000, ...(poolDialog.extractUrl.trim() ? { extractUrl: poolDialog.extractUrl.trim() } : {}), ...(poolDialog.key.trim() ? { key: poolDialog.key.trim() } : {}) }
    const res = await axios.post('/api/video/pools', payload)
    ElMessage.success(res.data?.message || '已保存')
    poolDialog.visible = false
    await loadPoolConfig(true)
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '保存池配置失败')
  } finally {
    poolSubmitting.value = false
  }
}

async function removePool(pool) {
  try {
    await ElMessageBox.confirm(`确定删除「${pool.name}」吗？删除后解析将不再使用这个订单。`, '删除池', { type: 'warning' })
  } catch {
    return
  }
  try {
    const res = await axios.post('/api/video/pools', { action: 'delete', id: pool.id })
    ElMessage.success(res.data?.message || '已删除')
    await loadPoolConfig(true)
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '删除失败')
  }
}

async function activatePool(pool) {
  try {
    const res = await axios.post('/api/video/pools', { action: 'activate', id: pool.id })
    ElMessage.success(res.data?.message || '已切换')
    await loadPoolConfig(true)
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '切换失败')
  }
}

async function testPoolExit(pool) {
  poolTesting.value = true
  try {
    const res = await axios.post('/api/video/pool-test', pool ? { poolId: pool.id } : {})
    if (res.data?.success) {
      ElMessage.success(`池出口测试成功（${res.data.elapsedMs}ms）：${res.data.exit}`)
    } else {
      ElMessage.error(res.data?.error || '池出口测试失败')
    }
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '池出口测试失败')
  } finally {
    poolTesting.value = false
  }
}

async function saveThreshold() {
  thresholdSaving.value = true
  try {
    const res = await axios.post('/api/video/pools', { action: 'set-threshold', threshold: Number(lowBalanceThreshold.value) })
    lowBalanceThreshold.value = res.data?.lowBalanceThreshold ?? lowBalanceThreshold.value
    ElMessage.success(res.data?.message || '预警阈值已保存')
    await loadPoolConfig(true)
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '保存阈值失败')
  } finally {
    thresholdSaving.value = false
  }
}

async function resetDirectBudget() {
  budgetResetting.value = true
  try {
    const res = await axios.post('/api/video/pools', { action: 'reset-budget' })
    Object.assign(directBudget, res.data?.directBudget || {})
    ElMessage.success(res.data?.message || '直连额度已重置')
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '重置失败')
  } finally {
    budgetResetting.value = false
  }
}

async function probeGateNow() {
  poolProbing.value = true
  try {
    const res = await axios.post('/api/video/gate-probe')
    if (res.data?.success) {
      gateState.direct = res.data.direct || 'unknown'
      gateState.lastProbeAt = res.data.lastProbeAt || ''
      gateState.lastChangeAt = res.data.lastChangeAt || ''
      if (res.data.directBudget) Object.assign(directBudget, res.data.directBudget)
      ElMessage.success(`探测完成：直连出口${directGateMeta.value.text.split('（')[0]}`)
      await loadPoolConfig(true)
    }
  } catch (error) {
    ElMessage.error('网关探测失败')
  } finally {
    poolProbing.value = false
  }
}

async function loadGithubRadarConfig() {
  githubRadarLoading.value = true
  try {
    const [configRes, categoryRes] = await Promise.all([
      axios.get('/api/admin/config/github-radar'),
      axios.get('/api/admin/github-radar/categories'),
    ])
    Object.assign(githubRadarConfig, {
      ...githubRadarConfig,
      ...configRes.data,
      primaryAiKey: '', githubToken: '', smtpPassword: '', aiFallbackKey: '',
    })
    githubCategories.value = categoryRes.data?.categories || []
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '加载 GitHub日报配置失败')
  } finally { githubRadarLoading.value = false }
}

async function saveGithubRadarConfig() {
  githubRadarSaving.value = true
  try {
    await axios.post('/api/admin/config/github-radar', { ...githubRadarConfig })
    ElMessage.success('GitHub日报配置已保存')
    await loadGithubRadarConfig()
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '保存 GitHub日报配置失败')
  } finally { githubRadarSaving.value = false }
}

async function testGithubProxy() {
  githubRadarSaving.value = true
  try {
    const res = await axios.post('/api/admin/config/github-radar/proxy-test')
    githubRadarConfig.proxyStatus = res.data?.status || '已连接'
    githubRadarConfig.proxyNode = res.data?.node || githubRadarConfig.proxyNode
    ElMessage.success(res.data?.message || 'GitHub 代理测试成功')
  } catch (error) {
    githubRadarConfig.proxyStatus = '失败'
    ElMessage.error(error.response?.data?.error || 'GitHub 代理测试失败')
  } finally { githubRadarSaving.value = false }
}

async function createGithubCategory() {
  githubCategorySaving.value = true
  try {
    await axios.post('/api/admin/github-radar/categories', { ...githubCategoryForm })
    Object.assign(githubCategoryForm, { name: '', description: '', keywords: '', languages: '' })
    ElMessage.success('预设方向已创建')
    await loadGithubRadarConfig()
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '创建预设方向失败')
  } finally { githubCategorySaving.value = false }
}

async function deleteGithubCategory(category) {
  try {
    await ElMessageBox.confirm(`确定删除“${category.name}”吗？`, '删除预设方向', { type: 'warning' })
    githubCategoryLoading.value = true
    await axios.delete(`/api/admin/github-radar/categories/${category.id}`)
    await loadGithubRadarConfig()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error.response?.data?.error || '删除预设方向失败')
  } finally { githubCategoryLoading.value = false }
}

async function loadMembershipConfig() {
  membershipConfigLoading.value = true
  try {
    const res = await axios.get('/api/admin/config/membership')
    membershipConfig.afdianUrl = res.data?.afdianUrl || ''
    membershipConfig.notice = res.data?.notice || membershipConfig.notice
    membershipConfig.afdianUserId = res.data?.afdianUserId || ''
    membershipConfig.afdianToken = res.data?.afdianToken || ''
    membershipConfig.webhookToken = res.data?.webhookToken || ''
    membershipConfig.planIdMonthly = res.data?.planIdMonthly || ''
    membershipConfig.planIdQuarterly = res.data?.planIdQuarterly || ''
    membershipConfig.planIdYearly = res.data?.planIdYearly || ''
    membershipConfig.afdianReplyTemplate = res.data?.afdianReplyTemplate || ''
    membershipConfig.plans = Array.isArray(res.data?.plans) ? res.data.plans : []
    if (membershipConfig.plans.length && !membershipConfig.plans.some((item) => item.key === membershipCardForm.planKey)) {
      membershipCardForm.planKey = membershipConfig.plans[0].key
    }
    if (membershipConfig.plans.length && !membershipConfig.plans.some((item) => item.key === membershipSimulateForm.planKey)) {
      membershipSimulateForm.planKey = membershipConfig.plans[0].key
    }
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '加载会员配置失败')
  } finally {
    membershipConfigLoading.value = false
  }
}

async function saveMembershipConfig() {
  membershipConfigSaving.value = true
  try {
    await axios.post('/api/admin/config/membership', {
      afdianUrl: membershipConfig.afdianUrl.trim(),
      notice: membershipConfig.notice.trim(),
      afdianUserId: membershipConfig.afdianUserId.trim(),
      afdianToken: membershipConfig.afdianToken.trim(),
      webhookToken: membershipConfig.webhookToken.trim(),
      planIdMonthly: membershipConfig.planIdMonthly.trim(),
      planIdQuarterly: membershipConfig.planIdQuarterly.trim(),
      planIdYearly: membershipConfig.planIdYearly.trim(),
      afdianReplyTemplate: membershipConfig.afdianReplyTemplate.trim(),
    })
    ElMessage.success('会员配置已保存')
    loadMembershipConfig()
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '保存会员配置失败')
  } finally {
    membershipConfigSaving.value = false
  }
}

async function loadMembershipCards() {
  membershipCardsLoading.value = true
  try {
    const res = await axios.get('/api/admin/membership/cards')
    membershipCards.value = Array.isArray(res.data?.cards) ? res.data.cards : []
    membershipCardsPage.value = 1
    membershipCardFilterPlan.value = 'monthly'
    if (!membershipConfig.plans.length && Array.isArray(res.data?.plans)) {
      membershipConfig.plans = res.data.plans
    }
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '加载卡密列表失败')
  } finally {
    membershipCardsLoading.value = false
  }
}

async function generateMembershipCards() {
  if (!membershipCardForm.planKey) {
    ElMessage.warning('请先选择会员套餐')
    return
  }

  membershipCardGenerating.value = true
  try {
    const res = await axios.post('/api/admin/membership/cards/generate', {
      planKey: membershipCardForm.planKey,
      quantity: membershipCardForm.quantity,
      note: membershipCardForm.note.trim(),
    })
    generatedCardCodes.value = Array.isArray(res.data?.cards) ? res.data.cards : []
    ElMessage.success(res.data?.message || '卡密已生成')
    membershipCardForm.note = ''
    membershipCardForm.quantity = 1
    loadMembershipCards()
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '生成卡密失败')
  } finally {
    membershipCardGenerating.value = false
  }
}

function copyAllGeneratedCodes() {
  if (!generatedCardCodes.value.length) return
  const text = generatedCardCodes.value.join('\n')
  navigator.clipboard.writeText(text)
    .then(() => {
      ElMessage.success('已成功复制全部兑换码')
    })
    .catch(() => {
      ElMessage.error('复制失败，请手动选择复制')
    })
}

function copyCardCode(code) {
  navigator.clipboard.writeText(code)
    .then(() => {
      ElMessage.success('已复制卡密: ' + code)
    })
    .catch(() => {
      ElMessage.error('复制失败')
    })
}

async function importMembershipCards() {
  if (!membershipImportForm.planKey) {
    ElMessage.warning('请先选择会员套餐')
    return
  }
  if (!membershipImportForm.codesText.trim()) {
    ElMessage.warning('请先粘贴兑换码或兑换链接')
    return
  }

  membershipImporting.value = true
  try {
    const res = await axios.post('/api/admin/membership/cards/import', {
      planKey: membershipImportForm.planKey,
      note: membershipImportForm.note.trim(),
      codesText: membershipImportForm.codesText,
    })
    membershipImportSummary.value = {
      importedCount: res.data?.importedCount || 0,
      duplicateCount: res.data?.duplicateCount || 0,
    }
    membershipImportForm.codesText = ''
    membershipImportForm.note = ''
    ElMessage.success(res.data?.message || '导入完成')
    loadMembershipCards()
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '导入失败')
  } finally {
    membershipImporting.value = false
  }
}

async function simulateMembershipOrder() {
  if (!membershipSimulateForm.username.trim()) {
    ElMessage.warning('请先输入要开通的本站用户名')
    return
  }
  if (!membershipSimulateForm.planKey) {
    ElMessage.warning('请先选择模拟开通档位')
    return
  }

  membershipSimulating.value = true
  try {
    const res = await axios.post('/api/membership/simulate', {
      username: membershipSimulateForm.username.trim(),
      planKey: membershipSimulateForm.planKey,
      outTradeNo: membershipSimulateForm.outTradeNo.trim(),
      remark: membershipSimulateForm.remark.trim() || `用户名: ${membershipSimulateForm.username.trim()}`,
    })
    ElMessage.success(res.data?.message || '模拟开通成功')
    membershipSimulateForm.outTradeNo = ''
    membershipSimulateForm.remark = ''
    await loadMembershipCards()
    await loadUsers()
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '模拟开通失败')
  } finally {
    membershipSimulating.value = false
  }
}

async function loadFeedback() {
  feedbackLoading.value = true
  try {
    const res = await axios.get('/api/admin/feedback')
    feedbackList.value = Array.isArray(res.data?.feedback) ? res.data.feedback : []
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '加载问题反馈失败')
  } finally {
    feedbackLoading.value = false
  }
}

async function deleteFeedback(id) {
  try {
    await ElMessageBox.confirm('确定要删除这条问题反馈吗？', '删除反馈', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
    feedbackDeletingId.value = id
    await axios.delete(`/api/admin/feedback/${id}`)
    ElMessage.success('问题反馈已删除')
    loadFeedback()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      ElMessage.error(error.response?.data?.error || '删除问题反馈失败')
    }
  } finally {
    feedbackDeletingId.value = null
  }
}

function formatTime(value) {
  if (!value) return '-'
  // SQLite 的 datetime('now') 写入的是 UTC 且不带时区后缀（'2026-09-11 07:40:13'），
  // new Date 会把它当成浏览器本地时间解析，导致显示早 8 小时。这里补上 Z 再解析；
  // 已带 T/Z 的 ISO 字符串（JS toISOString 写入的）保持原样。
  const raw = String(value)
  const iso = /^\d{4}-\d{2}-\d{2}([ T])\d{2}:\d{2}/.test(raw) && !raw.includes('T') && !raw.includes('Z')
    ? `${raw.replace(' ', 'T')}Z`
    : raw
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// SQLite 的 datetime('now') 存的是 UTC，且不带时区后缀。
// new Date('2026-09-11 07:40:13') 会被当成浏览器本地时间解析，所以这里显式补上 Z。
function formatUtcTime(value) {
  if (!value) return '-'
  const raw = String(value)
  const iso = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// ---------- 用户来源 IP ----------

function userIpValue(row) {
  return row?.last_ip || row?.last_download_ip || ''
}

function userIpSourceLabel(row) {
  if (row?.last_ip) return row.last_login_at ? '最近登录 / 注册来源' : '注册来源'
  if (row?.last_download_ip) return '最近一次下载来源'
  return '暂无记录'
}

function userIpHint(row) {
  if (userIpValue(row)) return `记录时间：${row.last_ip ? formatUtcTime(row.last_login_at) : '—'}`
  return '该账号在开始记录 IP 之后还没有登录过。'
}

function membershipSourceLabel(source) {
  if (source === 'manual') return '手动卡密'
  if (source === 'afdian_import') return '导入兑换码'
  if (source === 'afdian_webhook') return '爱发电自动开通'
  return source || '-'
}

function handleMembershipPageChange(page) {
  membershipCardsPage.value = page
}

function isExpired(value) {
  if (!value) return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date.getTime() < Date.now()
}

function roleTagType(role) {
  if (role === 'admin') return 'danger'
  if (role === 'pro') return 'info'
  if (role === 'premium') return 'warning'
  return 'success'
}

function roleLabel(role) {
  if (role === 'admin') return '管理员'
  if (role === 'pro') return 'Pro 用户'
  if (role === 'premium') return '高级用户'
  return '普通用户'
}

async function quickUpdateUser(user, overrides, successMessage) {
  try {
    quickActionLoadingId.value = user.id
    await axios.put(`/api/admin/users/${user.id}`, {
      username: user.username,
      role: overrides.role ?? user.role,
      premiumExpiresAt: overrides.premiumExpiresAt,
      isBanned: overrides.isBanned ?? Boolean(user.is_banned),
      bannedReason: overrides.bannedReason ?? (overrides.isBanned ? (user.banned_reason || '管理员手动封禁') : ''),
    })
    ElMessage.success(successMessage)
    loadUsers()
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '快捷操作失败')
  } finally {
    quickActionLoadingId.value = null
  }
}

function buildFutureIso(days) {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString()
}

async function quickSetPremium(user, preset) {
  if (user.role === 'admin') {
    ElMessage.warning('不能在这里修改其他管理员')
    return
  }

  if (user.role === 'pro' && preset !== 'normal') {
    ElMessage.warning('Pro 用户请通过编辑弹窗修改角色')
    return
  }

  if (user.id === currentUser?.id && preset === 'ban') {
    ElMessage.warning('不能封禁当前登录的管理员账号')
    return
  }

  if (preset === '7d') {
    await quickUpdateUser(user, {
      role: 'premium',
      premiumExpiresAt: buildFutureIso(7),
      isBanned: false,
      bannedReason: '',
    }, '已设置为 7 天高级用户')
    return
  }

  if (preset === '30d') {
    await quickUpdateUser(user, {
      role: 'premium',
      premiumExpiresAt: buildFutureIso(30),
      isBanned: false,
      bannedReason: '',
    }, '已设置为 30 天高级用户')
    return
  }

  if (preset === 'permanent') {
    await quickUpdateUser(user, {
      role: 'premium',
      premiumExpiresAt: '2099-12-31T23:59:59.000Z',
      isBanned: false,
      bannedReason: '',
    }, '已设置为永久高级用户')
    return
  }

  if (preset === 'normal') {
    await quickUpdateUser(user, {
      role: 'user',
      premiumExpiresAt: null,
      isBanned: false,
      bannedReason: '',
    }, '已恢复为普通用户')
    return
  }

  if (preset === 'pro') {
    await quickUpdateUser(user, {
      role: 'pro',
      premiumExpiresAt: null,
      isBanned: false,
      bannedReason: '',
    }, '已设为 Pro 用户')
    return
  }

  if (preset === 'unban') {
    await quickUpdateUser(user, {
      isBanned: false,
      bannedReason: '',
    }, '已解除封禁')
    return
  }

  if (preset === 'ban') {
    try {
      const { value } = await ElMessageBox.prompt('请输入封禁原因', '封禁用户', {
        confirmButtonText: '确认封禁',
        cancelButtonText: '取消',
        inputPlaceholder: '例如：大量滥用解析接口、恶意注册、违规传播内容',
        inputValidator: (inputValue) => {
          if (!String(inputValue || '').trim()) return '请填写封禁原因'
          return true
        },
      })

      await quickUpdateUser(user, {
        isBanned: true,
        bannedReason: String(value || '').trim(),
      }, '已封禁该用户')
    } catch (error) {
      if (error !== 'cancel' && error !== 'close') {
        ElMessage.error('封禁用户失败')
      }
    }
  }
}

async function handleQuickActionChange(user, value) {
  if (!value) return

  if (value === 'custom') {
    try {
      const { value: customValue } = await ElMessageBox.prompt('请输入高级用户天数', '自定义时长', {
        confirmButtonText: '确认',
        cancelButtonText: '取消',
        inputPlaceholder: '例如：15',
        inputValidator: (inputValue) => {
          const days = Number.parseInt(String(inputValue || '').trim(), 10)
          if (!Number.isInteger(days) || days <= 0) return '请输入大于 0 的整数天数'
          if (days > 3650) return '天数不要超过 3650'
          return true
        },
      })

      const days = Number.parseInt(String(customValue || '').trim(), 10)
      const date = new Date()
      date.setDate(date.getDate() + days)
      await quickUpdateUser(user, {
        role: 'premium',
        premiumExpiresAt: date.toISOString(),
        isBanned: false,
        bannedReason: '',
      }, `已设置为 ${days} 天高级用户`)
    } catch (error) {
      if (error !== 'cancel' && error !== 'close') {
        ElMessage.error('自定义高级用户时长失败')
      }
    }
    return
  }

  await quickSetPremium(user, value)
}

onMounted(() => {
  loadFiles()
  loadUsers()
  loadPoolConfig()
  loadGithubRadarConfig()
  loadGithubAdminSubscriptions()
  loadSiteMonitors()
  loadMembershipConfig()
  loadMembershipCards()
  loadFeedback()
  loadWtStatus()
  loadWtLogs()
})
</script>

<template>
  <div class="admin-view">
    <h2 class="page-title">管理后台</h2>

    <el-tabs type="border-card" class="admin-tabs">
      <el-tab-pane label="文件管理">
        <div class="tab-header">
          <span class="tab-count">共 {{ files.length }} 条文件记录</span>
          <el-button size="small" :loading="filesLoading" @click="loadFiles">
            <el-icon><Refresh /></el-icon>
            刷新
          </el-button>
        </div>

        <div class="desktop-table-wrap">
          <div class="table-shell">
            <el-table v-loading="filesLoading" :data="files" stripe size="small" empty-text="暂无上传文件">
              <el-table-column prop="id" label="提取码" width="110" />
              <el-table-column prop="fileName" label="文件名" min-width="200" show-overflow-tooltip />
              <el-table-column label="文件大小" width="110">
                <template #default="{ row }">{{ formatSize(row.fileSize) }}</template>
              </el-table-column>
              <el-table-column label="下载次数" width="110">
                <template #default="{ row }">
                  <span :class="row.maxDownloads === -1 ? 'badge-unlimited' : 'badge-count'">
                    {{ row.maxDownloads === -1 ? '无限' : `${row.currentDownloads}/${row.maxDownloads}` }}
                  </span>
                </template>
              </el-table-column>
              <el-table-column label="过期时间" width="180">
                <template #default="{ row }">
                  <span :class="{ 'text-expired': isExpired(row.expireTime) }">
                    {{ !row.expireTime || String(row.expireTime).includes('2099') ? '永久有效' : formatTime(row.expireTime) }}
                  </span>
                </template>
              </el-table-column>
              <el-table-column prop="ownerName" label="上传者" width="120" />
              <el-table-column label="创建时间" width="180">
                <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="170">
                <template #default="{ row }">
                  <div class="row-actions">
                    <el-button size="small" type="primary" @click="openEditFile(row)">编辑</el-button>
                    <el-button size="small" type="danger" @click="deleteFile(row.id, row.fileName)">删除</el-button>
                  </div>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </div>

        <div class="mobile-card-list">
          <article v-for="row in files" :key="row.id" class="mobile-admin-card">
            <div class="mobile-admin-head">
              <h4>{{ row.fileName }}</h4>
              <span class="mobile-admin-sub">{{ row.id }}</span>
            </div>
            <dl class="mobile-admin-meta">
              <div>
                <dt>大小</dt>
                <dd>{{ formatSize(row.fileSize) }}</dd>
              </div>
              <div>
                <dt>下载</dt>
                <dd>{{ row.maxDownloads === -1 ? '无限' : `${row.currentDownloads}/${row.maxDownloads}` }}</dd>
              </div>
              <div>
                <dt>过期</dt>
                <dd :class="{ 'text-expired': isExpired(row.expireTime) }">
                  {{ !row.expireTime || String(row.expireTime).includes('2099') ? '永久有效' : formatTime(row.expireTime) }}
                </dd>
              </div>
              <div>
                <dt>上传者</dt>
                <dd>{{ row.ownerName || '-' }}</dd>
              </div>
              <div>
                <dt>创建时间</dt>
                <dd>{{ formatTime(row.createdAt) }}</dd>
              </div>
            </dl>
            <div class="mobile-card-actions">
              <el-button size="small" type="primary" @click="openEditFile(row)">编辑</el-button>
              <el-button size="small" type="danger" @click="deleteFile(row.id, row.fileName)">删除</el-button>
            </div>
          </article>
        </div>
      </el-tab-pane>

      <el-tab-pane label="用户管理">
        <div class="tab-header">
          <span class="tab-count">共 {{ users.length }} 个用户</span>
          <div class="tab-actions user-search-wrap">
            <el-input v-model="userKeyword" placeholder="搜索用户名" clearable class="user-search" @keyup.enter="loadUsers">
              <template #prefix><el-icon><Search /></el-icon></template>
            </el-input>
            <el-button size="small" :loading="usersLoading" @click="loadUsers">
              <el-icon><Refresh /></el-icon>
              搜索
            </el-button>
            <el-button type="primary" size="small" @click="openAddUser">
              <el-icon><Plus /></el-icon>
              新增用户
            </el-button>
          </div>
        </div>

        <div class="desktop-table-wrap">
          <div class="table-shell">
            <el-table v-loading="usersLoading" :data="users" stripe size="small" empty-text="暂无用户数据">
              <el-table-column prop="id" label="ID" width="70" />
              <el-table-column label="用户名" min-width="180">
                <template #default="{ row }">
                  <div class="user-name-cell">
                    <span class="user-name-text">{{ row.username }}</span>
                    <el-popover placement="right" trigger="click" :width="280" popper-class="user-ip-popover">
                      <template #reference>
                        <el-icon class="user-info-icon" title="查看来源 IP"><InfoFilled /></el-icon>
                      </template>
                      <div class="user-ip-panel">
                        <div class="user-ip-source">{{ userIpSourceLabel(row) }}</div>
                        <div class="user-ip-value" :class="{ 'is-empty': !userIpValue(row) }">{{ userIpValue(row) || '暂无记录' }}</div>
                        <div class="user-ip-hint">{{ userIpHint(row) }}</div>
                      </div>
                    </el-popover>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="角色" width="110">
                <template #default="{ row }">
                  <el-tag :type="roleTagType(row.role)" :class="{ 'pro-tag': row.role === 'pro' }" effect="dark" size="small">{{ roleLabel(row.role) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="高级用户到期" width="180">
                <template #default="{ row }">
                  <span v-if="row.role === 'premium'">
                    {{ !row.premium_expires_at || String(row.premium_expires_at).includes('2099') ? '永久' : formatTime(row.premium_expires_at) }}
                  </span>
                  <span v-else>-</span>
                </template>
              </el-table-column>
              <el-table-column label="状态" width="110">
                <template #default="{ row }">
                  <el-tag :type="row.is_banned ? 'danger' : 'success'" effect="dark" size="small">
                    {{ row.is_banned ? '已封禁' : '正常' }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="封禁原因" min-width="180" show-overflow-tooltip>
                <template #default="{ row }">
                  {{ row.is_banned ? (row.banned_reason || '-') : '-' }}
                </template>
              </el-table-column>
              <el-table-column label="注册时间" width="180">
                <template #default="{ row }">{{ formatTime(row.created_at || row.createdAt) }}</template>
              </el-table-column>
              <el-table-column label="快捷操作" width="220">
                <template #default="{ row }">
                  <div v-if="row.role === 'admin'" class="quick-action-placeholder">
                    其他管理员不可在此修改
                  </div>
                  <div v-else class="quick-action-select-wrap">
                    <el-select
                      placeholder="选择操作"
                      size="small"
                      class="quick-action-select"
                      :loading="quickActionLoadingId === row.id"
                      @change="(value) => handleQuickActionChange(row, value)"
                    >
                      <el-option label="设为普通用户" value="normal" />
                      <el-option label="高级用户 7 天" value="7d" />
                      <el-option label="高级用户 30 天" value="30d" />
                      <el-option label="高级用户 永久" value="permanent" />
                      <el-option label="高级用户 自定义天数" value="custom" />
                      <el-option label="设为 Pro 用户" value="pro" />
                      <el-option v-if="row.is_banned" label="解除封禁" value="unban" />
                      <el-option v-else label="封禁用户" value="ban" />
                    </el-select>
                  </div>
                </template>
              </el-table-column>
              <!-- 站长要求：操作列不做固定，跟随表格横向滚动（固定列在小窗口下观感像「压住」其他列） -->
              <el-table-column label="操作" width="170">
                <template #default="{ row }">
                  <div class="row-actions">
                    <el-button size="small" type="primary" @click="openEditUser(row)">编辑</el-button>
                    <el-button size="small" type="danger" :disabled="row.id === currentUser?.id" @click="deleteUser(row)">删除</el-button>
                  </div>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </div>

        <div class="mobile-card-list">
          <article v-for="row in users" :key="row.id" class="mobile-admin-card">
            <div class="mobile-admin-head">
              <div class="mobile-admin-head-main">
                <h4>
                  {{ row.username }}
                  <el-popover placement="bottom" trigger="click" :width="280" popper-class="user-ip-popover">
                    <template #reference>
                      <el-icon class="user-info-icon" title="查看来源 IP"><InfoFilled /></el-icon>
                    </template>
                    <div class="user-ip-panel">
                      <div class="user-ip-source">{{ userIpSourceLabel(row) }}</div>
                      <div class="user-ip-value" :class="{ 'is-empty': !userIpValue(row) }">{{ userIpValue(row) || '暂无记录' }}</div>
                      <div class="user-ip-hint">{{ userIpHint(row) }}</div>
                    </div>
                  </el-popover>
                </h4>
                <span class="mobile-admin-sub">ID {{ row.id }}</span>
              </div>
              <el-tag :type="roleTagType(row.role)" :class="{ 'pro-tag': row.role === 'pro' }" effect="dark" size="small">{{ roleLabel(row.role) }}</el-tag>
            </div>
            <dl class="mobile-admin-meta">
              <div>
                <dt>状态</dt>
                <dd>{{ row.is_banned ? '已封禁' : '正常' }}</dd>
              </div>
              <div>
                <dt>高级用户到期</dt>
                <dd>
                  {{ row.role === 'premium' ? (!row.premium_expires_at || String(row.premium_expires_at).includes('2099') ? '永久' : formatTime(row.premium_expires_at)) : '-' }}
                </dd>
              </div>
              <div>
                <dt>注册时间</dt>
                <dd>{{ formatTime(row.created_at || row.createdAt) }}</dd>
              </div>
              <div class="mobile-meta-wide">
                <dt>封禁原因</dt>
                <dd>{{ row.is_banned ? (row.banned_reason || '-') : '-' }}</dd>
              </div>
            </dl>
            <div class="mobile-card-actions">
              <el-button size="small" type="primary" @click="openEditUser(row)">编辑</el-button>
              <el-button size="small" type="danger" :disabled="row.id === currentUser?.id" @click="deleteUser(row)">删除</el-button>
            </div>
            <div v-if="row.role === 'admin'" class="mobile-quick-placeholder">
              其他管理员不可在此修改
            </div>
            <div v-else class="mobile-quick-action">
              <el-select
                placeholder="选择快捷操作"
                size="small"
                class="quick-action-select"
                :loading="quickActionLoadingId === row.id"
                @change="(value) => handleQuickActionChange(row, value)"
              >
                <el-option label="设为普通用户" value="normal" />
                <el-option label="高级用户 7 天" value="7d" />
                <el-option label="高级用户 30 天" value="30d" />
                <el-option label="高级用户 永久" value="permanent" />
                <el-option label="高级用户 自定义天数" value="custom" />
                <el-option label="设为 Pro 用户" value="pro" />
                <el-option v-if="row.is_banned" label="解除封禁" value="unban" />
                <el-option v-else label="封禁用户" value="ban" />
              </el-select>
            </div>
          </article>
        </div>
      </el-tab-pane>

      <el-tab-pane label="抖音解析出口">
        <div class="tab-header">
          <span class="tab-count">动态住宅出口（巨量HTTP）·每 {{ probeIntervalHours }} 小时探测一次直连出口，配置加密保存、保存后立即生效</span>
          <div>
            <el-button size="small" :loading="poolRefreshing" @click="loadPoolConfig(true)">
              <el-icon><Refresh /></el-icon>
              刷新余量
            </el-button>
            <el-button size="small" :loading="poolProbing" @click="probeGateNow">
              <el-icon><Refresh /></el-icon>
              立即探测网关
            </el-button>
          </div>
        </div>

        <section class="single-panel single-panel--wide">
          <el-alert
            :title="`直连出口：${directGateMeta.text}`"
            :type="directGateMeta.type"
            :closable="false"
            show-icon
            style="margin-bottom: 16px"
          >
            <template #default>
              <div style="font-size: 0.8rem; margin-top: 4px">最后探测：{{ formatBeijing(gateState.lastProbeAt) }}　最后变化：{{ formatBeijing(gateState.lastChangeAt) }}</div>
              <div style="font-size: 0.8rem; margin-top: 4px">探测只打直连（裸请求，零池额度消耗）；出口状态翻转不再发邮件，系统直接自动切换。</div>
            </template>
          </el-alert>

          <div class="budget-grid">
            <div class="budget-item">
              <span class="budget-label">直连额度</span>
              <span class="budget-value" :class="directBudget.available ? 'is-ok' : 'is-warn'">
                {{ directBudget.available ? '可用' : '已用（窗口内走池）' }}
              </span>
            </div>
            <div class="budget-item">
              <span class="budget-label">上次使用</span>
              <span class="budget-value">{{ formatBeijing(directBudget.lastUsedAt) }}</span>
            </div>
            <div class="budget-item">
              <span class="budget-label">下次可用</span>
              <span class="budget-value">
                {{ directBudget.available ? '现在即可用' : formatBeijing(directBudget.nextAvailableAt) }}
                <el-button link type="primary" size="small" :loading="budgetResetting" @click="resetDirectBudget">重置</el-button>
              </span>
            </div>
          </div>

          <div class="pool-list-head">
            <span class="tab-count">池订单（按顺序使用；当前池余量耗尽或报「已到账期」会自动切到下一个）</span>
            <div class="pool-head-right">
              <span class="pool-burn">
                今日已提取 {{ poolExtractStats.today ?? 0 }} 个 IP
                <template v-if="poolExtractStats.total">（累计 {{ poolExtractStats.total }}）</template>
                <template v-if="poolExtractStats.estimatedDaysLeft">· 按此速度约可用 {{ poolExtractStats.estimatedDaysLeft }} 天</template>
              </span>
              <el-button type="primary" size="small" @click="openAddPool">
                <el-icon><Plus /></el-icon>
                添加池
              </el-button>
            </div>
          </div>

          <div v-loading="poolLoading || poolRefreshing" class="pool-list">
            <el-empty v-if="!poolList.length" description="还没有池订单，点上方「添加池」" :image-size="60" />
            <div
              v-for="pool in poolList"
              :key="pool.id"
              class="pool-card"
              :class="{ 'is-active': pool.id === activePoolId }"
            >
              <div class="pool-card-head">
                <div class="pool-card-title">
                  <span class="pool-card-name">{{ pool.name }}</span>
                  <el-tag v-if="pool.id === activePoolId" size="small" type="primary">当前</el-tag>
                  <el-tag size="small" :type="poolBalanceMeta(pool).type">{{ poolBalanceMeta(pool).text }}</el-tag>
                </div>
                <div
                  class="pool-card-balance"
                  :class="{ 'is-low': pool.balance !== null && pool.balance !== undefined && pool.balance <= lowBalanceThreshold }"
                >
                  {{ poolBalanceText(pool) }}
                </div>
              </div>
              <div class="pool-card-meta">
                <span>IP 时效 {{ Math.round((pool.ttlMs || 0) / 60000) }} 分钟</span>
                <span>订单 {{ pool.tradeNoTail || '—' }}</span>
                <span>{{ pool.hasKey ? '余量更新 ' + formatBeijing(pool.balanceAt) : '未配置 key（查不到余量）' }}</span>
              </div>
              <div class="pool-card-actions">
                <el-button size="small" :disabled="pool.id === activePoolId" @click="activatePool(pool)">设为当前</el-button>
                <el-button size="small" :loading="poolTesting" @click="testPoolExit(pool)">测试</el-button>
                <el-button size="small" @click="openEditPool(pool)">编辑</el-button>
                <el-button size="small" type="danger" plain @click="removePool(pool)">删除</el-button>
              </div>
            </div>
          </div>

          <el-form label-position="top" size="large">
            <el-form-item label="余量预警阈值（剩余 IP 低于该值时发邮件提醒，12 小时内不重复发）">
              <el-input-number v-model="lowBalanceThreshold" :min="0" :max="100000" :step="50" />
              <el-button type="primary" style="margin-left: 12px" :loading="thresholdSaving" @click="saveThreshold">保存阈值</el-button>
            </el-form-item>
          </el-form>

          <div class="pool-hint">
            <p>· 提取链接来自巨量后台「生成API提取链接」：白名单填服务器 IP，提取数量选 1，格式 TEXT，IP 去重建议 24 小时。</p>
            <p>· 业务 key 在巨量后台「业务管理 → 对应订单」里，用于查询剩余 IP 数量；不填也能解析，但看不到余量、也不会预警。</p>
            <p>· 多池按顺序使用：当前池余量耗尽或提取报「已到账期」时自动换下一个；全部不可用时回落直连（可能被风控拒）。</p>
            <p>· 直连额度：服务器 IP 每 4 小时只用一次，用掉后 4 小时内解析一律走池，避免频繁访问被重新标记；媒体下载不走代理。</p>
          </div>
        </section>

        <el-dialog
          v-model="poolDialog.visible"
          :title="poolDialog.mode === 'add' ? '添加池订单' : '编辑池'"
          width="min(580px, 92vw)"
        >
          <el-form label-position="top">
            <el-form-item label="名称">
              <el-input v-model="poolDialog.name" placeholder="例如：深圳住宅·主池（留空自动编号）" clearable />
            </el-form-item>
            <el-form-item :label="poolDialog.mode === 'add' ? '提取链接' : '提取链接（留空表示不修改）'">
              <el-input
                v-model="poolDialog.extractUrl"
                placeholder="http://v2.api.juliangip.com/dynamic/getips?num=1&trade_no=...&sign=..."
                clearable
              />
            </el-form-item>
            <el-form-item :label="poolDialog.mode === 'add' ? '业务 key' : '业务 key（留空表示不修改）'">
              <el-input v-model="poolDialog.key" placeholder="32 位业务密钥，用于查询剩余 IP 数量" clearable />
            </el-form-item>
            <el-form-item label="IP 时效档位（与所购套餐一致）">
              <el-select v-model="poolDialog.ttlMs" style="width: 240px">
                <el-option v-for="opt in POOL_TTL_OPTIONS" :key="opt.value" :label="opt.label" :value="opt.value" />
              </el-select>
            </el-form-item>
          </el-form>
          <template #footer>
            <el-button @click="poolDialog.visible = false">取消</el-button>
            <el-button type="primary" :loading="poolSubmitting" @click="submitPoolForm">保存</el-button>
          </template>
        </el-dialog>
      </el-tab-pane>

      <el-tab-pane label="GitHub日报">
        <div class="tab-header">
          <span class="tab-count">配置 GitHub 发现、Outlook 发信、AI 复核和预设学习方向</span>
          <el-button size="small" :loading="githubRadarLoading" @click="loadGithubRadarConfig"><el-icon><Refresh /></el-icon>刷新</el-button>
        </div>
        <div class="membership-admin-grid">
          <section class="single-panel">
            <el-form label-position="top" size="large">
              <el-form-item label="GitHub Token">
                <el-input v-model="githubRadarConfig.githubToken" type="password" show-password placeholder="留空表示保持现有配置" clearable />
                <div class="form-hint">状态：{{ githubRadarConfig.githubTokenConfigured ? '已配置' : '未配置' }}。建议使用权限最小的 GitHub Token。</div>
              </el-form-item>
              <el-form-item label="机场订阅链接">
                <el-input v-model="githubRadarConfig.proxySubscription" type="password" show-password placeholder="留空表示保持现有订阅" clearable />
                <div class="form-hint">状态：{{ githubRadarConfig.proxyConfigured ? githubRadarConfig.proxyStatus : '未配置' }}。保存后服务器会自动刷新订阅、检测节点并选择可访问 GitHub 的最低延迟节点。</div>
                <div v-if="githubRadarConfig.proxyNode" class="form-hint">当前节点：{{ githubRadarConfig.proxyNode }}<span v-if="githubRadarConfig.proxyCheckedAt"> · {{ githubRadarConfig.proxyCheckedAt }}</span></div>
              </el-form-item>
              <el-divider content-position="left">163 邮箱发信</el-divider>
              <el-form-item label="SMTP 主机"><el-input v-model="githubRadarConfig.smtpHost" /></el-form-item>
              <el-form-item label="SMTP 端口"><el-input-number v-model="githubRadarConfig.smtpPort" :min="1" :max="65535" /></el-form-item>
              <el-form-item label="发件邮箱"><el-input v-model="githubRadarConfig.smtpUser" /></el-form-item>
              <el-form-item label="客户端授权码">
                <el-input v-model="githubRadarConfig.smtpPassword" type="password" show-password placeholder="留空表示保持现有授权码" clearable />
                <div class="form-hint">状态：{{ githubRadarConfig.smtpConfigured ? '已配置' : '未配置' }}。请填写 163 邮箱生成的客户端授权码，不是邮箱登录密码。推荐 smtp.163.com:465（SSL/TLS）。</div>
              </el-form-item>
              <el-form-item label="显示发件人"><el-input v-model="githubRadarConfig.smtpFrom" /></el-form-item>
              <el-divider content-position="left">第一模型：README 初筛</el-divider>
              <el-form-item label="第一模型 API URL"><el-input v-model="githubRadarConfig.primaryAiUrl" placeholder="OpenAI 兼容接口" /></el-form-item>
              <el-form-item label="第一模型名称"><el-input v-model="githubRadarConfig.primaryAiModel" placeholder="例如 gpt-5.6-luna" /></el-form-item>
              <el-form-item label="第一模型 API Key"><el-input v-model="githubRadarConfig.primaryAiKey" type="password" show-password placeholder="留空表示保持现有配置" clearable /><div class="form-hint">状态：{{ githubRadarConfig.primaryAiConfigured ? '已配置' : '未配置' }}。用于 README 和项目信息的首轮筛选。</div></el-form-item>
              <el-divider content-position="left">第二模型：低置信度复核</el-divider>
              <el-form-item label="第二模型 API URL"><el-input v-model="githubRadarConfig.aiFallbackUrl" placeholder="可选，OpenAI 兼容接口" /></el-form-item>
              <el-form-item label="第二模型名称"><el-input v-model="githubRadarConfig.aiFallbackModel" placeholder="例如 grok-..." /></el-form-item>
              <el-form-item label="第二模型 API Key"><el-input v-model="githubRadarConfig.aiFallbackKey" type="password" show-password placeholder="留空表示保持现有配置" clearable /><div class="form-hint">状态：{{ githubRadarConfig.aiFallbackConfigured ? '已配置' : '未配置' }}。当前先保存配置，后续用于低置信度复核。</div></el-form-item>
              <el-button type="primary" :loading="githubRadarSaving" @click="saveGithubRadarConfig">保存 GitHub日报配置</el-button>
              <el-button :loading="githubRadarSaving" @click="testGithubProxy">测试 GitHub 代理</el-button>
              <el-button @click="scheduleGithubSimulation">安排 30 分钟后模拟日报</el-button>
            </el-form>
          </section>
          <section class="single-panel">
            <h3>预设学习方向</h3>
            <div class="form-hint">用户会在 GitHub日报页面选择这些方向。关键词支持中英文，语言用于 GitHub Search 过滤。</div>
            <el-form label-position="top">
              <el-form-item label="方向名称"><el-input v-model="githubCategoryForm.name" placeholder="例如：AI / 大模型" /></el-form-item>
              <el-form-item label="方向说明"><el-input v-model="githubCategoryForm.description" placeholder="一句话说明关注范围" /></el-form-item>
              <el-form-item label="关键词"><el-input v-model="githubCategoryForm.keywords" type="textarea" :rows="3" placeholder="AI, LLM, Agent, RAG" /></el-form-item>
              <el-form-item label="编程语言"><el-input v-model="githubCategoryForm.languages" placeholder="Python, TypeScript, Rust" /></el-form-item>
              <el-button type="primary" :loading="githubCategorySaving" @click="createGithubCategory">新增方向</el-button>
            </el-form>
            <div class="category-admin-list" v-loading="githubCategoryLoading">
              <div v-for="category in githubCategories" :key="category.id" class="category-admin-item">
                <div><strong>{{ category.name }}</strong><small>{{ category.description }}</small><small>{{ category.keywords.join(' · ') }}</small></div>
                <el-button link type="danger" @click="deleteGithubCategory(category)">删除</el-button>
              </div>
            </div>
          </section>
          <section class="single-panel github-admin-subscriptions-panel">
            <div class="panel-title"><h3>用户订阅管理</h3><p>管理员可以新增、修改或删除用户的接收邮箱、方向、关键词和推送频率。</p></div>
            <el-form label-position="top" size="small">
              <el-form-item label="用户 ID"><el-input v-model="githubAdminSubscriptionForm.userId" placeholder="对应用户管理中的 ID" /></el-form-item>
              <el-form-item label="接收邮箱"><el-input v-model="githubAdminSubscriptionForm.email" /></el-form-item>
              <el-form-item label="预设方向"><el-select v-model="githubAdminSubscriptionForm.categoryIds" multiple clearable style="width:100%"><el-option v-for="category in githubCategories" :key="category.id" :label="category.name" :value="category.id" /></el-select></el-form-item>
              <el-form-item label="关键词"><el-input v-model="githubAdminSubscriptionForm.keywords" placeholder="多个关键词用逗号分隔" /></el-form-item>
              <el-form-item label="推送频率"><el-checkbox-group v-model="githubAdminSubscriptionForm.frequencies"><el-checkbox label="daily">日报</el-checkbox><el-checkbox label="weekly">周报</el-checkbox><el-checkbox label="monthly">月报</el-checkbox></el-checkbox-group></el-form-item>
              <el-form-item label="状态"><el-select v-model="githubAdminSubscriptionForm.status"><el-option label="待确认" value="pending" /><el-option label="启用" value="active" /><el-option label="暂停" value="paused" /><el-option label="关闭" value="closed" /></el-select></el-form-item>
              <el-button type="primary" @click="saveGithubAdminSubscription">{{ githubAdminSubscriptionForm.id ? '保存修改' : '新增订阅' }}</el-button><el-button v-if="githubAdminSubscriptionForm.id" @click="resetGithubAdminSubscription">取消编辑</el-button>
            </el-form>
            <el-divider />
            <el-button size="small" :loading="githubAdminSubscriptionsLoading" @click="loadGithubAdminSubscriptions">刷新订阅</el-button>
            <el-table v-loading="githubAdminSubscriptionsLoading" :data="githubAdminSubscriptions" size="small" style="margin-top:10px" max-height="360">
              <el-table-column prop="id" label="ID" width="65" /><el-table-column prop="userId" label="用户" width="65" /><el-table-column prop="email" label="邮箱" min-width="190" /><el-table-column prop="status" label="状态" width="75" /><el-table-column label="频率" width="120"><template #default="{row}">{{ (row.frequencies || []).join(' / ') }}</template></el-table-column><el-table-column label="操作" width="125" fixed="right"><template #default="{row}"><el-button link type="primary" @click="editGithubAdminSubscription(row)">编辑</el-button><el-button link type="danger" @click="deleteGithubAdminSubscription(row)">删除</el-button></template></el-table-column>
            </el-table>
          </section>
        </div>
      </el-tab-pane>

      <el-tab-pane label="战争雷霆交易所">
        <div class="tab-header">
          <span class="tab-count">配置 Gaijin 账号凭据、查看采集状态、手动触发快照</span>
          <el-button size="small" :loading="wtLoading" @click="loadWtStatus"><el-icon><Refresh /></el-icon>刷新</el-button>
        </div>
        <div class="membership-admin-grid">
          <section class="single-panel">
            <el-form label-position="top" size="large">
              <el-form-item label="Gaijin 邮箱">
                <el-input v-model="wtCred.login" placeholder="用于登录换取交易所令牌的账号邮箱" clearable />
              </el-form-item>
              <el-form-item label="Gaijin 密码">
                <el-input v-model="wtCred.password" type="password" show-password placeholder="留空表示保持现有密码" clearable />
                <div class="form-hint">
                  状态：{{ wtStatus.credentialsConfigured ? `已配置 ${wtStatus.loginMasked}` : '未配置' }}。凭据经 AES 加密存于服务器，不入代码仓库。
                </div>
                <div class="form-hint">
                  出口策略：登录经住宅代理池路由（机房 IP 会被 Gaijin 强制人机验证拦死）；池不可用时报错可在下方状态看到。
                </div>
              </el-form-item>
              <el-button type="primary" :loading="wtSaving" @click="saveWtCredentials">保存并验证登录</el-button>
              <el-button :loading="wtRefreshing" :disabled="!wtStatus.credentialsConfigured" @click="triggerWtSnapshot">立即快照</el-button>
            </el-form>
          </section>
          <section class="single-panel">
            <h3>采集状态</h3>
            <el-descriptions :column="1" border size="small">
              <el-descriptions-item label="凭据">
                <el-tag size="small" :type="wtStatus.credentialsConfigured ? 'success' : 'info'">
                  {{ wtStatus.credentialsConfigured ? '已配置' : '未配置' }}
                </el-tag>
                <span v-if="wtStatus.loginMasked" style="margin-left:8px">{{ wtStatus.loginMasked }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="收录物品">{{ wtStatus.itemCount || 0 }} 件</el-descriptions-item>
              <el-descriptions-item label="最近快照">{{ formatTime(wtStatus.lastSnapshotAt) }}</el-descriptions-item>
              <el-descriptions-item label="最近错误">
                <span :class="wtStatus.lastError ? 'wt-admin-err' : ''">{{ wtStatus.lastError || '无' }}</span>
              </el-descriptions-item>
            </el-descriptions>
            <div class="form-hint" style="margin-top:10px">
              后台每天北京时间 07:20 自动快照一次；「立即快照」有 10 分钟冷却。用户在「战争雷霆交易所」页面查看价格与走势。
            </div>
          </section>
        </div>

        <section class="single-panel" style="margin-top:16px">
          <div class="tab-header">
            <h3 style="margin:0">操作日志</h3>
            <el-button size="small" :loading="wtLogsLoading" @click="loadWtLogs"><el-icon><Refresh /></el-icon>刷新</el-button>
          </div>
          <div class="form-hint" style="margin-bottom:10px">
            登录 / 快照 / 搜索的每次操作（自动或手动）及其返回摘要，保留 30 天。出了问题时可据此判断是账号被风控、IP 池、还是搜索/爬取环节。
          </div>
          <el-table v-loading="wtLogsLoading" :data="wtLogs" size="small" stripe empty-text="暂无日志">
            <el-table-column label="时间" width="170">
              <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="80">
              <template #default="{ row }">{{ WT_OP_LABEL[row.op] || row.op }}</template>
            </el-table-column>
            <el-table-column label="触发" width="90">
              <template #default="{ row }">{{ WT_TRIGGER_LABEL[row.trigger] || row.trigger || '-' }}</template>
            </el-table-column>
            <el-table-column label="结果" width="80">
              <template #default="{ row }">
                <el-tag size="small" :type="wtStatusTagType(row.status)">{{ row.status }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="出口 IP" width="120">
              <template #default="{ row }">{{ row.exit_ip || '-' }}</template>
            </el-table-column>
            <el-table-column label="耗时" width="80">
              <template #default="{ row }">{{ row.duration_ms != null ? row.duration_ms + 'ms' : '-' }}</template>
            </el-table-column>
            <el-table-column label="详情" min-width="240">
              <template #default="{ row }">
                <span :class="row.status === 'fail' ? 'wt-admin-err' : ''">{{ row.code ? `[${row.code}] ` : '' }}{{ row.detail || '-' }}</span>
              </template>
            </el-table-column>
          </el-table>
        </section>
      </el-tab-pane>

      <el-tab-pane label="网站监测">
        <div class="tab-header">
          <span class="tab-count monitor-header-tags">
            <el-tag size="small" effect="dark" :type="siteMonitorSmtpConfigured ? 'success' : 'danger'">SMTP {{ siteMonitorSmtpConfigured ? '已配置' : '未配置' }}</el-tag>
            <el-tag size="small" effect="plain">心跳 {{ Math.round(siteMonitorHeartbeatSeconds / 60) }} 分钟</el-tag>
          </span>
          <div class="tab-actions">
            <el-button size="small" :loading="siteMonitorTesting" @click="sendSiteMonitorTestEmail">测试邮件</el-button>
            <el-button size="small" :loading="siteMonitorLoading" @click="loadSiteMonitors"><el-icon><Refresh /></el-icon>刷新</el-button>
          </div>
        </div>

        <div class="monitor-grid" v-loading="siteMonitorLoading">
          <section v-for="monitor in siteMonitors" :key="monitor.source" class="single-panel monitor-card">
            <header class="monitor-card-head">
              <div class="monitor-title">
                <span class="monitor-dot" :class="`is-${monitor.lastStatus}`"></span>
                <strong>{{ monitor.displayName }}</strong>
                <el-tag size="small" effect="plain">{{ monitor.intervalLabel }}</el-tag>
                <el-tag v-if="!monitor.baselineReady" size="small" effect="plain" type="warning">无基线</el-tag>
              </div>
              <el-switch
                :model-value="monitor.enabled"
                :loading="siteMonitorBusyWith(monitor.source) === 'toggle'"
                @change="(value) => toggleSiteMonitor(monitor, value)"
              />
            </header>

            <div class="monitor-stats">
              <div class="monitor-stat"><b>{{ monitor.baselineCount }}</b><small>基线</small></div>
              <div class="monitor-stat"><b>{{ monitor.eventCount }}</b><small>变更</small></div>
              <div class="monitor-stat" :class="{ 'is-bad': (monitor.deliveries?.failed || 0) > 0 }"><b>{{ monitor.deliveries?.waiting || 0 }}</b><small>待发</small></div>
              <div class="monitor-stat" :class="{ 'is-bad': monitor.consecutiveFailures > 0 }"><b>{{ monitor.consecutiveFailures }}</b><small>连败</small></div>
            </div>

            <dl class="monitor-meta">
              <div><dt>最近成功</dt><dd>{{ siteMonitorTime(monitor.lastSuccessAt) }}</dd></div>
              <div><dt>下次检查</dt><dd>{{ monitor.enabled ? siteMonitorTime(monitor.nextRunAt) : '已关闭' }}</dd></div>
            </dl>
            <p v-if="monitor.lastError" class="monitor-error">{{ monitor.lastError }}</p>

            <el-form label-position="top" size="small" class="monitor-form">
              <el-form-item label="认证方式">
                <el-select v-model="siteMonitorForms[monitor.source].authType" style="width: 128px">
                  <el-option label="无需认证" value="none" />
                  <el-option :label="monitor.source === 'justwoker_models' ? 'API 令牌（推荐，长期有效）' : 'Bearer'" value="bearer" />
                  <el-option :label="monitor.source === 'justwoker_models' ? '登录会话 Cookie（易失效）' : 'Cookie'" value="cookie" />
                </el-select>
              </el-form-item>
              <el-form-item v-if="siteMonitorForms[monitor.source].authType !== 'none'" label="凭据">
                <el-input
                  v-model="siteMonitorForms[monitor.source].authSecret"
                  type="password"
                  show-password
                  clearable
                  :placeholder="monitor.authConfigured ? `已配置 ${monitor.authMask}（${monitor.authLength} 字符），留空保持不变` : (monitor.source === 'justwoker_models' ? (siteMonitorForms[monitor.source].authType === 'cookie' ? '粘贴登录会话 Cookie' : '粘贴 sk- 开头的 API 令牌') : '粘贴 Cookie 或 Token')"
                />
                <div v-if="monitor.source === 'justwoker_models'" class="monitor-auth-help">
                  <template v-if="siteMonitorForms[monitor.source].authType === 'bearer'"><strong>推荐</strong>。在 JustWoker 控制台「令牌」页新建一枚令牌（<code>sk-</code> 开头，有效期建议选<strong>永不过期</strong>），粘贴到上面的凭据框。服务端用 <code>GET /v1/models</code> 读取模型列表，不依赖登录会话、也不需要每轮刷新，令牌不是一次性凭据，可以长期无人值守。</template>
                  <template v-else-if="siteMonitorForms[monitor.source].authType === 'cookie'"><strong>不推荐，容易失效。</strong>该会话的刷新令牌会被上游轮换并吊销，一旦被浏览器抢先消费就只能人工重贴。若仍要用：在已登录 JustWoker 的浏览器开发者工具中打开 Application → Cookies → justwoker.icu，取 <code>new_api_refresh</code> 的值并连名字一起填成 <code>new_api_refresh=值</code>；<strong>不要</strong>从 <code>/api/user/auth/refresh</code> 请求头里抄（那个值往往已被本次请求消费掉，抄下来必然 401）。取值后立刻保存并诊断。</template>
                </div>
              </el-form-item>
              <el-form-item label="收件邮箱">
                <el-input v-model="siteMonitorForms[monitor.source].recipientEmail" />
              </el-form-item>
            </el-form>

            <div class="monitor-actions">
              <el-button type="primary" size="small" :loading="siteMonitorBusyWith(monitor.source) === 'save'" @click="saveSiteMonitorConfig(monitor)">保存</el-button>
              <el-button size="small" :loading="siteMonitorBusyWith(monitor.source) === 'diagnose'" @click="diagnoseSiteMonitor(monitor)">诊断</el-button>
              <el-button size="small" :loading="siteMonitorBusyWith(monitor.source) === 'check'" @click="checkSiteMonitor(monitor)">立即检查</el-button>
              <el-button size="small" :loading="siteMonitorBusyWith(monitor.source) === 'baseline'" @click="rebuildSiteMonitorBaseline(monitor)">重建基线</el-button>
            </div>

            <div v-if="monitor.recentRuns?.length" class="monitor-runs">
              <div v-for="run in monitor.recentRuns" :key="run.id" class="monitor-run">
                <span class="monitor-dot" :class="`is-${run.status}`"></span>
                <span class="monitor-run-time">{{ siteMonitorTime(run.startedAt) }}</span>
                <el-tag size="small" effect="plain">{{ siteMonitorTriggerLabel(run.triggerType) }}</el-tag>
                <span class="monitor-run-count">{{ run.itemCount }} 项 · +{{ run.addedCount }} / -{{ run.removedCount }}</span>
              </div>
            </div>
          </section>
        </div>

        <section class="single-panel monitor-events-panel">
          <div class="panel-title"><h3>变更记录</h3></div>
          <el-radio-group v-model="siteMonitorEventSource" size="small" @change="switchSiteMonitorEventSource">
            <el-radio-button v-for="monitor in siteMonitors" :key="monitor.source" :value="monitor.source">{{ monitor.displayName }}</el-radio-button>
          </el-radio-group>
          <el-table v-loading="siteMonitorEventsLoading" :data="siteMonitorEvents" size="small" style="margin-top: 10px" empty-text="暂无变更">
            <el-table-column label="时间" width="170"><template #default="{ row }">{{ siteMonitorTime(row.createdAt) }}</template></el-table-column>
            <el-table-column label="类型" width="100"><template #default="{ row }"><el-tag size="small" effect="dark" :type="siteMonitorEventMeta(row.eventType).type">{{ siteMonitorEventMeta(row.eventType).label }}</el-tag></template></el-table-column>
            <el-table-column label="内容" min-width="240">
              <template #default="{ row }">
                <a v-if="row.url" class="monitor-event-link" :href="row.url" target="_blank" rel="noopener noreferrer">{{ row.title }}</a>
                <span v-else>{{ row.title }}</span>
                <small v-if="row.publishedAt" class="monitor-event-date">{{ row.publishedAt }}</small>
              </template>
            </el-table-column>
          </el-table>
          <el-pagination
            v-if="siteMonitorEventsTotal > SITE_MONITOR_EVENT_PAGE_SIZE"
            size="small"
            background
            layout="prev, pager, next"
            style="margin-top: 10px"
            :total="siteMonitorEventsTotal"
            :page-size="SITE_MONITOR_EVENT_PAGE_SIZE"
            :current-page="siteMonitorEventsPage"
            @current-change="changeSiteMonitorEventsPage"
          />
        </section>
      </el-tab-pane>

      <el-tab-pane label="会员配置">
        <div class="tab-header">
          <span class="tab-count">爱发电自动开通配置、模拟开通测试与备用卡密管理</span>
          <div class="tab-actions">
            <el-button size="small" :loading="membershipConfigLoading" @click="loadMembershipConfig">
              <el-icon><Refresh /></el-icon>
              刷新配置
            </el-button>
            <el-button size="small" :loading="membershipCardsLoading" @click="loadMembershipCards">
              <el-icon><Refresh /></el-icon>
              刷新卡密
            </el-button>
          </div>
        </div>

        <div class="membership-admin-grid">
          <section class="single-panel">
            <el-form label-position="top" size="large">
              <el-form-item label="爱发电链接">
                <el-input v-model="membershipConfig.afdianUrl" placeholder="https://afdian.com/..." clearable />
              </el-form-item>
              <el-form-item label="会员说明">
                <el-input
                  v-model="membershipConfig.notice"
                  type="textarea"
                  :rows="4"
                  resize="vertical"
                  placeholder="例如：登录本站账号后，前往爱发电下单，并在订单备注里填写本站用户名。支付成功后，系统会自动开通高级用户。"
                />
              </el-form-item>
              <el-form-item label="爱发电 user_id">
                <el-input v-model="membershipConfig.afdianUserId" placeholder="例如：860297d8442111f0813352540025c377" clearable />
              </el-form-item>
              <el-form-item label="爱发电 token">
                <el-input v-model="membershipConfig.afdianToken" type="password" show-password placeholder="填写爱发电开发者 token" clearable />
              </el-form-item>
              <el-form-item label="Webhook 令牌">
                <el-input v-model="membershipConfig.webhookToken" placeholder="自定义一个回调校验令牌，例如：afdian-hook-2026" clearable />
              </el-form-item>
              <el-form-item label="自动发货私信回复模板">
                <el-input
                  v-model="membershipConfig.afdianReplyTemplate"
                  type="textarea"
                  :rows="4"
                  resize="vertical"
                  placeholder="赞助支付成功后，自动发给用户的私信模板。支持占位符：{code} (兑换码)、{plan_name} (方案名称)、{duration_days} (有效天数)、{order_id} (订单号)。
留空则使用默认模板：感谢您的赞助！您的 {plan_name} 兑换码为：\n{code}\n请前往本站兑换。"
                />
              </el-form-item>
              <el-form-item label="月卡 plan_id">
                <el-input v-model="membershipConfig.planIdMonthly" placeholder="没有也可以先留空，系统会按 5 元自动识别" clearable />
              </el-form-item>
              <el-form-item label="季卡 plan_id">
                <el-input v-model="membershipConfig.planIdQuarterly" placeholder="没有也可以先留空，系统会按 10 元自动识别" clearable />
              </el-form-item>
              <el-form-item label="年卡 plan_id">
                <el-input v-model="membershipConfig.planIdYearly" placeholder="没有也可以先留空，系统会按 20 元自动识别" clearable />
              </el-form-item>
              <el-form-item label="Webhook 地址">
                <el-input
                  :model-value="`https://lcyksp.xyz/api/membership/afdian/webhook?token=${membershipConfig.webhookToken || '你设置的令牌'}`"
                  readonly
                />
              </el-form-item>
              <div class="form-hint">
                推荐让用户在爱发电订单备注里填写本站用户名。支付成功后，系统会自动给对应本站账号开通会员。
              </div>
              <el-form-item class="llm-action-item">
                <div class="llm-actions">
                  <el-button type="primary" :loading="membershipConfigSaving" @click="saveMembershipConfig">
                    {{ membershipConfigSaving ? '保存中...' : '保存会员配置' }}
                  </el-button>
                </div>
              </el-form-item>
            </el-form>

            <div class="membership-plan-preview">
              <article v-for="plan in membershipConfig.plans" :key="plan.key" class="membership-plan-preview-card">
                <strong>{{ plan.description }}</strong>
                <span>{{ plan.name }}</span>
              </article>
            </div>
          </section>

          <section class="single-panel">
            <div class="generated-cards-title">模拟爱发电订单开通</div>
            <div class="form-hint">请用一个当前还不是高级用户的普通账号来测试。这里会模拟“爱发电已支付成功并回调到本站”的场景，用来验证自动开通链路本身，不是正式人工代开。</div>
            <div class="membership-card-toolbar">
              <el-input v-model="membershipSimulateForm.username" placeholder="输入本站用户名" clearable />
              <el-select v-model="membershipSimulateForm.planKey" class="membership-plan-select">
                <el-option v-for="plan in membershipConfig.plans" :key="plan.key" :label="plan.description" :value="plan.key" />
              </el-select>
            </div>
            <el-input
              v-model="membershipSimulateForm.outTradeNo"
              placeholder="可选：自定义模拟订单号；留空则自动生成"
              clearable
            />
            <el-input
              v-model="membershipSimulateForm.remark"
              type="textarea"
              :rows="3"
              resize="vertical"
              placeholder="可选：模拟爱发电订单备注。留空则自动用“用户名: xxx”"
            />
            <div class="membership-card-actions">
              <el-button type="warning" :loading="membershipSimulating" @click="simulateMembershipOrder">
                {{ membershipSimulating ? '模拟中...' : '模拟自动开通' }}
              </el-button>
            </div>

            <div class="generated-cards-title" style="margin-top: 18px;">备用手动卡密</div>
            <div class="membership-card-toolbar">
              <el-select v-model="membershipCardForm.planKey" class="membership-plan-select">
                <el-option v-for="plan in membershipConfig.plans" :key="plan.key" :label="plan.description" :value="plan.key" />
              </el-select>
              <el-input-number v-model="membershipCardForm.quantity" :min="1" :max="50" />
            </div>
            <el-input
              v-model="membershipCardForm.note"
              type="textarea"
              :rows="3"
              resize="vertical"
              placeholder="可选备注，例如：爱发电补发 / 测试 / 手动赠送"
            />
            <div class="membership-card-actions">
              <el-button type="primary" :loading="membershipCardGenerating" @click="generateMembershipCards">
                {{ membershipCardGenerating ? '生成中...' : '生成卡密' }}
              </el-button>
            </div>

            <div v-if="generatedCardCodes.length" class="generated-cards-box">
              <div class="generated-cards-title" style="display: flex; justify-content: space-between; align-items: center;">
                <span>最新生成</span>
                <el-button type="primary" size="small" link @click="copyAllGeneratedCodes">复制全部</el-button>
              </div>
              <div class="generated-cards-list">
                <code v-for="code in generatedCardCodes" :key="code" style="cursor: pointer;" @click="copyCardCode(code)" title="点击复制">{{ code }}</code>
              </div>
            </div>
          </section>
        </div>

        <section class="single-panel membership-card-list-panel">
  <div v-for="plan in membershipConfig.plans" :key="plan.key" class="plan-card-group">
    <div class="plan-card-group-header">
      <strong>{{ plan.description }}</strong>
    </div>
    <div class="membership-card-stats">
      <div class="membership-stat-chip" :class="{ active: membershipCardFilterPlan === plan.key && !membershipCardStatusFilter }"
        @click="membershipCardFilterPlan = plan.key; membershipCardStatusFilter = ''; membershipCardsPage = 1">
        全部 {{ planCardStats(plan.key).total }}
      </div>
      <div class="membership-stat-chip warning" :class="{ active: membershipCardFilterPlan === plan.key && membershipCardStatusFilter === 'unused' }"
        @click="membershipCardFilterPlan = plan.key; membershipCardStatusFilter = 'unused'; membershipCardsPage = 1">
        未使用 {{ planCardStats(plan.key).unused }}
      </div>
      <div class="membership-stat-chip success" :class="{ active: membershipCardFilterPlan === plan.key && membershipCardStatusFilter === 'used' }"
        @click="membershipCardFilterPlan = plan.key; membershipCardStatusFilter = 'used'; membershipCardsPage = 1">
        已使用 {{ planCardStats(plan.key).used }}
      </div>
    </div>
    <div v-loading="membershipCardsLoading" class="membership-card-list">
      <div v-if="filteredPlanCards(plan.key).length === 0" class="feedback-empty" style="padding: 12px 0;">暂无卡密</div>
      <div v-for="card in filteredPlanCards(plan.key)" :key="card.id" class="membership-card-simple">
        <span class="membership-card-code" style="cursor: pointer;" @click="copyCardCode(card.code)" title="点击复制">{{ card.code }}</span>
        <el-tag :type="card.status === 'used' ? 'success' : 'warning'" effect="dark" size="small">
          {{ card.status === 'used' ? '已使用' : '未使用' }}
        </el-tag>
        <el-button size="small" text @click="openCardDetail(card)">ℹ</el-button>
      </div>
    </div>
  </div>
</section>

<!-- Card detail dialog -->
<el-dialog v-model="cardDetailVisible" :title="cardDetail?.code || ''" width="420px" class="card-detail-dialog">
  <dl class="card-detail-list" v-if="cardDetail">
    <div><dt>套餐</dt><dd>{{ cardDetail.planName }}</dd></div>
    <div><dt>状态</dt><dd>{{ cardDetail.status === 'used' ? '已使用' : cardDetail.status === 'invalid' ? '已作废' : '未使用' }}</dd></div>
    <div><dt>来源</dt><dd>{{ membershipSourceLabel(cardDetail.source) }}</dd></div>
    <div><dt>使用人</dt><dd>{{ cardDetail.usedByName || '-' }}</dd></div>
    <div><dt>创建时间</dt><dd>{{ formatTime(cardDetail.createdAt) }}</dd></div>
    <div><dt>使用时间</dt><dd>{{ cardDetail.usedAt ? formatTime(cardDetail.usedAt) : '-' }}</dd></div>
    <div><dt>到期时间</dt><dd>{{ cardDetail.grantedExpiresAt ? formatTime(cardDetail.grantedExpiresAt) : '-' }}</dd></div>
    <div><dt>备注</dt><dd>{{ cardDetail.note || '-' }}</dd></div>
  </dl>
</el-dialog>
      </el-tab-pane>

      <el-tab-pane label="导入卡密">
        <div class="tab-header">
          <span class="tab-count">仅作为备用方案：把外部兑换码或兑换链接导入到本站会员系统</span>
          <el-button size="small" :loading="membershipCardsLoading" @click="loadMembershipCards">
            <el-icon><Refresh /></el-icon>
            刷新卡密状态
          </el-button>
        </div>

        <section class="single-panel">
          <div class="membership-card-toolbar">
            <el-select v-model="membershipImportForm.planKey" class="membership-plan-select">
              <el-option v-for="plan in membershipConfig.plans" :key="plan.key" :label="plan.description" :value="plan.key" />
            </el-select>
          </div>

          <el-input
            v-model="membershipImportForm.note"
            placeholder="可选备注，例如：爱发电 6 月批量导入"
            clearable
          />

          <el-input
            v-model="membershipImportForm.codesText"
            class="membership-import-textarea"
            type="textarea"
            :rows="10"
            resize="vertical"
            placeholder="每行一条兑换码或兑换链接，作为备用库存整批导入"
          />

          <div class="membership-card-actions">
            <el-button type="primary" :loading="membershipImporting" @click="importMembershipCards">
              {{ membershipImporting ? '导入中...' : '开始导入' }}
            </el-button>
          </div>

          <div v-if="membershipImportSummary" class="generated-cards-box">
            <div class="generated-cards-title">
              本次导入成功 {{ membershipImportSummary.importedCount }} 条，重复跳过 {{ membershipImportSummary.duplicateCount }} 条
            </div>
          </div>
        </section>
      </el-tab-pane>

      <el-tab-pane label="问题反馈">
        <div class="tab-header">
          <span class="tab-count">查看用户提交的问题反馈记录</span>
          <el-button size="small" :loading="feedbackLoading" @click="loadFeedback">
            <el-icon><Refresh /></el-icon>
            刷新
          </el-button>
        </div>

        <section class="single-panel">
          <div v-loading="feedbackLoading" class="feedback-list">
            <div v-if="!feedbackList.length" class="feedback-empty">暂无问题反馈</div>

            <article v-for="item in feedbackList" :key="item.id" class="feedback-card">
              <div class="feedback-card-head">
                <div>
                  <h4>{{ item.problemSummary }}</h4>
                  <span>{{ formatTime(item.createdAt) }}</span>
                </div>
                <el-button size="small" type="danger" :loading="feedbackDeletingId === item.id" @click="deleteFeedback(item.id)">删除</el-button>
              </div>

              <dl class="feedback-meta">
                <div>
                  <dt>页面</dt>
                  <dd>{{ item.pageName || '-' }}</dd>
                </div>
                <div>
                  <dt>功能</dt>
                  <dd>{{ item.featureName || '-' }}</dd>
                </div>
                <div>
                  <dt>反馈人</dt>
                  <dd>{{ item.reporterName || 'guest' }}</dd>
                </div>
              </dl>

              <div class="feedback-details">{{ item.details || '-' }}</div>
            </article>
          </div>
        </section>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="userDialogVisible" :title="userDialogMode === 'add' ? '新增用户' : '编辑用户'" width="520px" :close-on-click-modal="false">
      <el-form label-position="top">
        <el-form-item label="用户名">
          <el-input v-model="userForm.username" placeholder="2-32 个字符" clearable />
        </el-form-item>
        <el-form-item :label="userDialogMode === 'add' ? '密码' : '新密码（留空则不修改）'">
          <el-input v-model="userForm.password" type="password" show-password :placeholder="userDialogMode === 'add' ? '至少 6 个字符' : '留空则不修改密码'" clearable />
        </el-form-item>
        <el-form-item label="角色">
          <el-radio-group v-model="userForm.role">
            <el-radio value="user">普通用户</el-radio>
            <el-radio value="premium">高级用户</el-radio>
            <el-radio value="pro">Pro 用户</el-radio>
            <el-radio value="admin">管理员</el-radio>
          </el-radio-group>
        </el-form-item>

        <el-form-item v-if="userForm.role === 'premium'" label="高级用户有效期">
          <el-select v-model="userForm.premiumPreset" class="full-width">
            <el-option v-for="item in premiumPresetOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <div class="form-hint">当前设置为：{{ userRoleLabel }}</div>
        </el-form-item>

        <el-form-item v-if="userForm.role === 'premium' && userForm.premiumPreset === 'custom'" label="自定义到期时间">
          <el-input v-model="userForm.premiumExpiresAt" type="datetime-local" />
        </el-form-item>

        <el-form-item label="封禁状态">
          <el-switch v-model="userForm.isBanned" active-text="已封禁" inactive-text="正常" />
        </el-form-item>

        <el-form-item v-if="userForm.isBanned" label="封禁原因">
          <el-input v-model="userForm.bannedReason" type="textarea" :rows="3" placeholder="例如：大量滥用解析接口、恶意注册、违规传播内容" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="userDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="userFormLoading" @click="submitUserForm">{{ userFormLoading ? '保存中...' : '保存' }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="fileDialogVisible" title="编辑文件属性" width="440px" :close-on-click-modal="false">
      <el-form label-position="top">
        <el-form-item label="文件名">
          <el-input v-model="fileForm.fileName" placeholder="修改文件名" clearable />
        </el-form-item>
        <el-form-item label="提取码">
          <el-input v-model="fileForm.newCode" placeholder="修改提取码" clearable />
        </el-form-item>
        <el-form-item label="过期时间">
          <div class="file-edit-time-row">
            <el-date-picker
              v-model="fileForm.expireTime"
              type="datetime"
              placeholder="选择过期时间"
              value-format="YYYY-MM-DDTHH:mm:ss.000Z"
              :disabled="fileForm.isPermanent"
              style="flex: 1;"
            />
            <el-checkbox v-model="fileForm.isPermanent" @change="(value) => { if (value) { fileForm.expireTime = '' } }">永久有效</el-checkbox>
          </div>
          <div class="form-hint">取消勾选后可手动设置过期时间。</div>
        </el-form-item>
        <el-form-item label="下载次数限制（-1 表示无限）">
          <el-input-number v-model="fileForm.maxDownloads" :min="-1" :max="1000" :step="1" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="fileDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="fileFormLoading" @click="submitFileForm">{{ fileFormLoading ? '保存中...' : '保存' }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.admin-view {
  max-width: 1280px;
  margin: 0 auto;
  padding: 20px 16px 40px;
}

.page-title {
  margin: 0 0 20px;
  color: var(--text-primary);
  font-size: 1.5rem;
  font-weight: 600;
}

.admin-tabs {
  border: 1px solid var(--border-color);
  border-radius: 18px;
  overflow: hidden;
  background: var(--bg-card);
}

.tab-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.tab-count {
  color: var(--text-secondary);
  font-size: 0.92rem;
}

.tab-actions,
.row-actions,
.llm-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}

.row-actions :deep(.el-button) {
  flex-shrink: 0;
}

.user-search-wrap {
  align-items: center;
}

.user-search {
  width: 220px;
}

.user-name-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.user-info-icon {
  font-size: 15px;
  color: var(--el-color-primary);
  cursor: pointer;
  flex-shrink: 0;
  transition: transform 0.15s ease;
}

.user-info-icon:hover {
  transform: scale(1.15);
}

.mobile-admin-head .user-info-icon {
  font-size: 14px;
  vertical-align: -2px;
  margin-left: 4px;
}

.user-ip-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  line-height: 1.5;
}

.user-ip-source {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.user-ip-value {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 15px;
  font-weight: 600;
  color: var(--el-color-primary);
  word-break: break-all;
  user-select: all;
}

.user-ip-value.is-empty {
  font-size: 13px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}

.user-ip-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  border-top: 1px solid var(--el-border-color-lighter);
  padding-top: 6px;
}

.desktop-table-wrap {
  display: block;
}

.table-shell {
  width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
}

.mobile-card-list {
  display: none;
}

.mobile-admin-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--border-color);
  border-radius: 16px;
  background: color-mix(in srgb, var(--bg-card) 92%, transparent);
}

.mobile-admin-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.mobile-admin-head-main {
  min-width: 0;
}

.mobile-admin-head h4 {
  margin: 0 0 4px;
  color: var(--text-primary);
  font-size: 0.98rem;
  word-break: break-word;
}

.mobile-admin-sub {
  color: var(--text-secondary);
  font-size: 0.8rem;
}

.mobile-admin-meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin: 0;
}

.mobile-admin-meta div {
  padding: 10px 12px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg-input) 86%, transparent);
  border: 1px solid var(--border-color);
}

.mobile-admin-meta dt {
  margin: 0 0 6px;
  color: var(--text-dim);
  font-size: 0.76rem;
}

.mobile-admin-meta dd {
  margin: 0;
  color: var(--text-primary);
  font-size: 0.9rem;
  word-break: break-word;
}

.mobile-meta-wide {
  grid-column: 1 / -1;
}

.mobile-card-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.mobile-card-actions :deep(.el-button) {
  width: 100%;
}

/* Element Plus 默认给相邻按钮加 margin-left，窄屏单列堆叠时会把第二个按钮顶出边界 */
.mobile-card-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.mobile-quick-action,
.mobile-quick-placeholder {
  width: 100%;
}

.mobile-quick-placeholder {
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px dashed var(--border-color);
  color: var(--text-muted);
  font-size: 0.82rem;
  line-height: 1.6;
}

.quick-action-select-wrap {
  width: 100%;
}

.quick-action-select {
  width: 100%;
}

.quick-action-placeholder {
  color: var(--text-muted);
  font-size: 0.82rem;
  line-height: 1.5;
}

.pool-hint {
  margin-top: 14px;
  color: var(--text-secondary, #909399);
  font-size: 0.8rem;
  line-height: 1.7;
}

.pool-hint p {
  margin: 0 0 4px;
}

.pool-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.pool-head-right {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.pool-burn {
  font-size: 0.78rem;
  color: var(--text-secondary, #909399);
}

.budget-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 16px;
}

.budget-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
}

.budget-label {
  font-size: 0.75rem;
  color: var(--text-secondary, #909399);
}

.budget-value {
  font-size: 0.9rem;
  word-break: break-word;
}

.budget-value.is-warn {
  color: var(--el-color-warning);
}

.pool-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 16px;
  min-height: 60px;
}

.pool-card {
  padding: 12px 14px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
}

.pool-card.is-active {
  border-color: var(--el-color-primary);
}

.pool-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.pool-card-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.pool-card-name {
  font-weight: 500;
  word-break: break-word;
}

.pool-card-balance {
  max-width: 55%;
  font-size: 0.9rem;
  font-weight: 500;
  text-align: right;
  word-break: break-word;
}

.pool-card-balance.is-low {
  color: var(--el-color-warning);
}

.pool-card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin-top: 8px;
  font-size: 0.78rem;
  color: var(--text-secondary, #909399);
}

.pool-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.pool-card-actions .el-button + .el-button {
  margin-left: 0;
}

@media (max-width: 640px) {
  .budget-grid {
    grid-template-columns: 1fr;
  }

  .pool-card-balance {
    max-width: 100%;
    text-align: left;
  }

  .pool-list-head {
    flex-direction: column;
    align-items: flex-start;
  }
}

.single-panel--wide {
  max-width: 1120px;
}

.single-panel {
  max-width: 920px;
  background: color-mix(in srgb, var(--bg-card) 96%, transparent);
  border: 1px solid var(--border-color);
  border-radius: 18px;
  padding: 18px;
}

.feedback-list {
  min-height: 220px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.membership-admin-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 14px;
}

.github-admin-subscriptions-panel {
  max-width: none;
  min-width: 0;
}

.github-admin-subscriptions-panel :deep(.el-table) {
  width: 100%;
  min-width: 620px;
}

.github-admin-subscriptions-panel :deep(.el-table__body-wrapper),
.github-admin-subscriptions-panel :deep(.el-table__header-wrapper) {
  overflow-x: auto;
}

.membership-plan-preview {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-top: 14px;
}

.membership-plan-preview-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border-radius: 14px;
  border: 1px solid var(--border-color);
  background: color-mix(in srgb, var(--bg-input) 86%, transparent);
}

.membership-plan-preview-card strong {
  color: var(--text-primary);
}

.membership-plan-preview-card span {
  color: var(--text-secondary);
  font-size: 0.84rem;
}

.membership-card-toolbar {
  display: flex;
  gap: 10px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.membership-plan-select {
  min-width: 220px;
}

.membership-card-actions {
  display: flex;
  justify-content: flex-start;
  margin-top: 12px;
}

.membership-import-textarea {
  margin-top: 12px;
}

.generated-cards-box {
  margin-top: 14px;
  padding: 12px;
  border-radius: 14px;
  border: 1px dashed var(--border-color);
  background: color-mix(in srgb, var(--bg-input) 70%, transparent);
}

.generated-cards-title {
  margin-bottom: 10px;
  color: var(--text-secondary);
  font-size: 0.84rem;
}

.generated-cards-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.generated-cards-list code {
  padding: 6px 10px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--bg-deep) 65%, transparent);
  color: var(--text-primary);
}

.membership-card-list-panel {
  max-width: none;
}

.membership-card-stats {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.membership-stat-chip {
  padding: 8px 12px;
  border-radius: 999px;
  border: 1px solid var(--border-color);
  background: color-mix(in srgb, var(--bg-input) 88%, transparent);
  color: var(--text-secondary);
  font-size: 0.82rem;
  cursor: pointer;
  transition: all 0.15s;
}
.membership-stat-chip:hover {
  opacity: 0.8;
}
.membership-stat-chip.active {
  border-color: var(--accent-blue) !important;
  background: color-mix(in srgb, var(--accent-blue) 15%, var(--bg-input));
  color: var(--accent-blue);
  font-weight: 600;
}

/* Plan card group */
.plan-card-group {
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--bg-hover);
}
.plan-card-group:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
.plan-card-group-header { margin-bottom: 10px; }
.plan-card-group-header strong { color: var(--text-primary); font-size: 0.95rem; }

/* Simple card row */
.membership-card-simple {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px solid var(--bg-hover);
}
.membership-card-simple:last-child { border-bottom: none; }
.membership-card-code {
  flex: 1;
  color: var(--text-primary);
  font-family: monospace;
  font-size: 0.82rem;
}

/* Card detail dialog */
.card-detail-list { display: flex; flex-direction: column; gap: 8px; }
.card-detail-list div { display: flex; padding: 4px 0; border-bottom: 1px solid var(--bg-hover); }
.card-detail-list dt { width: 80px; flex-shrink: 0; color: var(--text-secondary); font-size: 0.82rem; }
.card-detail-list dd { flex: 1; color: var(--text-primary); font-size: 0.82rem; margin: 0; }

.membership-stat-chip.warning {
  border-color: color-mix(in srgb, #e6a23c 30%, var(--border-color));
}

.membership-stat-chip.success {
  border-color: color-mix(in srgb, #67c23a 30%, var(--border-color));
}

.membership-stat-chip.danger {
  border-color: color-mix(in srgb, #f56c6c 30%, var(--border-color));
}

.membership-record-card {
  border: 1px solid var(--border-color);
  border-radius: 16px;
  padding: 14px;
  background: color-mix(in srgb, var(--bg-card) 92%, transparent);
}

.membership-record-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.membership-record-title {
  min-width: 0;
}

.membership-record-head h4 {
  margin: 0 0 6px;
  color: var(--text-primary);
  font-size: 0.98rem;
}

.membership-record-head span {
  color: var(--text-secondary);
  font-size: 0.82rem;
  word-break: break-word;
}

.membership-record-code {
  display: inline-flex;
  align-items: center;
  padding: 6px 10px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--bg-input) 92%, transparent);
  border: 1px solid var(--border-color);
  font-family: Consolas, 'Courier New', monospace;
  letter-spacing: 0.02em;
}

.membership-pagination {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}

.membership-record-meta {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.feedback-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 220px;
  border: 1px dashed var(--border-color);
  border-radius: 16px;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--bg-input) 72%, transparent);
}

.feedback-card {
  border: 1px solid var(--border-color);
  border-radius: 16px;
  padding: 14px;
  background: color-mix(in srgb, var(--bg-card) 92%, transparent);
}

.feedback-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.feedback-card-head h4 {
  margin: 0 0 6px;
  color: var(--text-primary);
  font-size: 0.98rem;
}

.feedback-card-head span {
  color: var(--text-secondary);
  font-size: 0.8rem;
}

.feedback-meta {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin: 0 0 12px;
}

.feedback-meta div {
  padding: 10px 12px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg-input) 86%, transparent);
  border: 1px solid var(--border-color);
}

.feedback-meta dt {
  margin: 0 0 6px;
  color: var(--text-dim);
  font-size: 0.76rem;
}

.feedback-meta dd {
  margin: 0;
  color: var(--text-primary);
  font-size: 0.9rem;
  word-break: break-word;
}

.feedback-details {
  color: var(--text-primary);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.file-edit-time-row {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
}

.form-hint {
  margin-top: 6px;
  color: var(--text-secondary);
  font-size: 0.82rem;
}

.wt-admin-err {
  color: var(--el-color-warning);
  word-break: break-all;
}

.full-width,
.llm-autocomplete {
  width: 100%;
}

.badge-unlimited {
  color: #67c23a;
}

.badge-count {
  color: var(--text-primary);
}

.text-expired {
  color: #ff8f8f;
}

.llm-action-item {
  margin-bottom: 0;
}

.category-admin-list {
  display: grid;
  gap: 10px;
  margin-top: 18px;
}

.category-admin-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-ctrl);
}

.category-admin-item > div {
  display: grid;
  gap: 4px;
}

.category-admin-item strong { color: var(--text-heading); }
.category-admin-item small { color: var(--text-muted); line-height: 1.4; }

:deep(.el-tabs--border-card) {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
}

:deep(.el-tabs--border-card > .el-tabs__header) {
  background: color-mix(in srgb, var(--bg-deep) 94%, transparent);
  border-bottom: 1px solid #262b45;
}

:deep(.el-tabs--border-card > .el-tabs__content) {
  background: var(--bg-card);
}

:deep(.el-tabs__item) {
  color: var(--text-secondary);
}

:deep(.el-tabs__item.is-active) {
  color: var(--text-primary);
}

:deep(.el-form-item__label) {
  color: var(--text-primary);
}

:deep(.el-input__wrapper),
:deep(.el-textarea__inner),
:deep(.el-input-number .el-input__wrapper),
:deep(.el-select__wrapper) {
  background: var(--bg-input);
  box-shadow: 0 0 0 1px var(--border-color) inset;
}

:deep(.el-input__inner),
:deep(.el-textarea__inner) {
  color: var(--text-primary);
}

:deep(.el-input__inner::placeholder),
:deep(.el-textarea__inner::placeholder) {
  color: var(--text-dim);
}

:deep(.el-table) {
  --el-table-bg-color: transparent;
  /* 行底色用不透明卡片色：既与卡片融为一体，又保证 fixed="right" 固定列有实体背景——
     透明行底下横向滚动时，后面的单元格会从固定列里透出来（用户管理页曾出现文字重叠）。 */
  --el-table-tr-bg-color: var(--bg-card);
  --el-table-header-bg-color: var(--bg-input);
  --el-table-row-hover-bg-color: var(--bg-hover);
  --el-table-border-color: var(--border-color);
  --el-table-text-color: var(--text-primary);
  --el-table-header-text-color: var(--text-secondary);
}

:deep(.el-table .cell) {
  word-break: break-word;
}

:deep(.el-table--striped .el-table__body tr.el-table__row--striped td) {
  /* 斑马纹同样混到卡片色上（不要混 transparent，否则固定列又会透出下层内容） */
  background: color-mix(in srgb, var(--bg-input) 72%, var(--bg-card));
}

:deep(.el-dialog) {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 18px;
}

:deep(.el-dialog__title) {
  color: var(--text-primary);
}

:deep(.el-dialog__body),
:deep(.el-dialog__footer),
:deep(.el-radio),
:deep(.el-checkbox),
:deep(.el-switch__label) {
  color: var(--text-primary);
}

:deep(.el-autocomplete-suggestion) {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
}

:deep(.el-autocomplete-suggestion li) {
  color: var(--text-primary);
}

:deep(.el-autocomplete-suggestion li.highlighted) {
  background: color-mix(in srgb, var(--accent-blue) 18%, var(--bg-hover));
  color: var(--text-primary);
}

@media (max-width: 768px) {
  .admin-view {
    padding: 14px 10px 28px;
  }

  .membership-admin-grid,
  .membership-plan-preview {
    grid-template-columns: 1fr;
  }

  .desktop-table-wrap {
    display: none;
  }

  .mobile-card-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .tab-header,
  .user-search-wrap {
    align-items: stretch;
  }

  .tab-actions {
    width: 100%;
  }

  .tab-actions :deep(.el-button) {
    flex: 1;
  }

  :deep(.el-tabs__header) {
    overflow-x: auto;
  }

  :deep(.el-tabs__nav) {
    min-width: max-content;
  }

  .feedback-meta {
    grid-template-columns: 1fr;
  }

  .feedback-card-head {
    flex-direction: column;
    align-items: stretch;
  }

  .user-search {
    width: 100%;
  }

  .github-admin-subscriptions-panel {
    grid-column: 1 / -1;
  }

  .github-admin-subscriptions-panel :deep(.el-form-item) {
    margin-bottom: 14px;
  }
}

@media (max-width: 640px) {
  .page-title {
    font-size: 1.25rem;
  }

  .row-actions,
  .tab-actions,
  .llm-actions,
  .user-search-wrap {
    width: 100%;
  }

  .row-actions :deep(.el-button),
  .tab-actions :deep(.el-button),
  .llm-actions :deep(.el-button) {
    flex: 1;
  }

  .mobile-admin-head,
  .feedback-card-head,
  .membership-record-head {
    flex-direction: column;
    align-items: stretch;
  }

  .mobile-admin-meta,
  .mobile-card-actions {
    grid-template-columns: 1fr;
  }

  .single-panel {
    padding: 14px;
    border-radius: 14px;
  }

  .github-admin-subscriptions-panel :deep(.el-table) {
    min-width: 560px;
  }

  .github-admin-subscriptions-panel :deep(.el-button) {
    max-width: 100%;
  }
}

.pro-tag {
  background: linear-gradient(135deg, #1a1a2e 0%, #c9a84c 100%) !important;
  border-color: #c9a84c !important;
  color: #fff !important;
}

.monitor-header-tags {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.monitor-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 14px;
}

.monitor-card {
  max-width: none;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.monitor-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.monitor-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.monitor-title strong {
  font-size: 1rem;
}

.monitor-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  background: var(--text-muted);
}

.monitor-dot.is-success,
.monitor-dot.is-not_modified {
  background: #3ddc97;
}

.monitor-dot.is-failed {
  background: #ff6b6b;
}

.monitor-dot.is-running {
  background: #4d9dff;
}

.monitor-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.monitor-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 8px 4px;
  border-radius: 12px;
  border: 1px solid var(--border-color);
  background: color-mix(in srgb, var(--bg-input) 86%, transparent);
}

.monitor-stat b {
  font-size: 1.05rem;
}

.monitor-stat small {
  font-size: 0.72rem;
  color: var(--text-muted);
}

.monitor-stat.is-bad b {
  color: #ff6b6b;
}

.monitor-meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  margin: 0;
}

.monitor-meta div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.monitor-meta dt {
  font-size: 0.72rem;
  color: var(--text-muted);
}

.monitor-meta dd {
  margin: 0;
  font-size: 0.82rem;
}

.monitor-error {
  margin: 0;
  padding: 8px 10px;
  border-radius: 10px;
  font-size: 0.78rem;
  color: #ff9b9b;
  background: color-mix(in srgb, #ff6b6b 12%, transparent);
  word-break: break-all;
}

.monitor-form {
  margin: 0;
}

.monitor-form :deep(.el-form-item) {
  margin-bottom: 10px;
}

.monitor-auth-help {
  margin-top: 6px;
  color: var(--text-muted);
  font-size: 0.76rem;
  line-height: 1.55;
}

.monitor-auth-help code {
  color: #8dbbff;
  word-break: break-all;
}

.monitor-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.monitor-runs {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px solid var(--border-color);
}

.monitor-run {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.76rem;
  color: var(--text-muted);
}

.monitor-run-time {
  min-width: 138px;
}

.monitor-run-count {
  white-space: nowrap;
}

.monitor-events-panel {
  max-width: none;
}

.monitor-event-link {
  color: #4d9dff;
  text-decoration: none;
}

.monitor-event-link:hover {
  text-decoration: underline;
}

.monitor-event-date {
  margin-left: 8px;
  color: var(--text-muted);
}

@media (max-width: 900px) {
  .monitor-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .monitor-run-time {
    min-width: 0;
  }
}
</style>

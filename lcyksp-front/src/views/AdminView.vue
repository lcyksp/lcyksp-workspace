<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, Search } from '@element-plus/icons-vue'
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

const llmConfig = reactive({
  apiUrl: 'https://api.deepseek.com/chat/completions',
  apiKey: '',
  model: 'deepseek-chat',
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
const llmLoading = ref(false)
const llmSaving = ref(false)
const llmTesting = ref(false)
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
  smtpUser: 'lcykspxyz@163.com', smtpFrom: 'lcykspxyz@163.com',
  aiFallbackUrl: '', aiFallbackModel: '', aiFallbackKey: '', aiFallbackConfigured: false,
  proxySubscription: '', proxyConfigured: false, proxyStatus: '未检测', proxyNode: '', proxyCheckedAt: '',
})
const githubCategoryForm = reactive({ name: '', description: '', keywords: '', languages: '' })
const githubAdminSubscriptions = ref([])
const githubAdminSubscriptionsLoading = ref(false)
const githubAdminSubscriptionForm = reactive({ id: null, userId: '', email: '', categoryIds: [], keywords: '', frequencies: ['daily'], status: 'active' })
const quickActionLoadingId = ref(null)

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
async function scheduleGithubSimulation() { try { const res = await axios.post('/api/admin/github-radar/simulation', { email: '1296757861@qq.com', delayMinutes: 30, type: 'daily' }); ElMessage.success(`模拟日报已安排：${new Date(res.data.runAt).toLocaleString()}`) } catch (error) { ElMessage.error(error.response?.data?.error || '安排模拟日报失败') } }

const MAX_HISTORY = 5
const HISTORY_KEYS = {
  url: 'llmUrlHistory',
  key: 'llmKeyHistory',
  model: 'llmModelHistory',
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

function loadHistory(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveHistoryItem(storageKey, value) {
  if (!value || typeof value !== 'string') return
  const trimmed = value.trim()
  if (!trimmed) return

  let list = loadHistory(storageKey)
  list = list.filter((item) => item !== trimmed)
  list.unshift(trimmed)
  if (list.length > MAX_HISTORY) list = list.slice(0, MAX_HISTORY)
  localStorage.setItem(storageKey, JSON.stringify(list))
}

async function buildHistorySuggestions(type, storageKey, queryString, cb) {
  const localList = loadHistory(storageKey)
  let backendList = []

  try {
    const res = await axios.get('/api/admin/config/llm/history', { params: { type } })
    backendList = Array.isArray(res.data?.history) ? res.data.history.map((item) => item.value) : []
  } catch (error) {
    console.error('加载 LLM 历史记录失败:', error)
  }

  const merged = []
  const seen = new Set()
  backendList.concat(localList).forEach((item) => {
    if (item && !seen.has(item)) {
      seen.add(item)
      merged.push(item)
    }
  })

  const keyword = String(queryString || '').toLowerCase()
  const results = keyword ? merged.filter((item) => item.toLowerCase().includes(keyword)) : merged
  cb(results.map((item) => ({ value: item })))
}

function queryUrlHistory(queryString, cb) {
  buildHistorySuggestions('apiUrl', HISTORY_KEYS.url, queryString, cb)
}

function queryKeyHistory(queryString, cb) {
  buildHistorySuggestions('apiKey', HISTORY_KEYS.key, queryString, cb)
}

function queryModelHistory(queryString, cb) {
  buildHistorySuggestions('model', HISTORY_KEYS.model, queryString, cb)
}

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

async function loadLlmConfig() {
  llmLoading.value = true
  try {
    const res = await axios.get('/api/admin/config/llm')
    if (res.data?.configured) {
      llmConfig.apiUrl = res.data.apiUrl || 'https://api.deepseek.com/chat/completions'
      llmConfig.model = res.data.model || 'deepseek-chat'
      llmConfig.apiKey = res.data.apiKey || ''
    }
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '加载大模型配置失败')
  } finally {
    llmLoading.value = false
  }
}

async function testLlmConfig() {
  if (!llmConfig.apiKey.trim()) {
    ElMessage.warning('请先输入 API Key 再测试')
    return
  }

  llmTesting.value = true
  try {
    const res = await axios.post('/api/admin/config/llm/test', {
      apiKey: llmConfig.apiKey.trim(),
      apiUrl: llmConfig.apiUrl.trim() || 'https://api.deepseek.com/chat/completions',
      model: llmConfig.model.trim() || 'deepseek-chat',
    })
    if (res.data?.success) {
      ElMessage.success('连接测试成功')
    } else {
      ElMessage.error(res.data?.error || '连接测试失败')
    }
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '连接测试失败')
  } finally {
    llmTesting.value = false
  }
}

async function saveLlmConfig() {
  if (!llmConfig.apiKey.trim()) {
    ElMessage.warning('API Key 不能为空')
    return
  }

  llmSaving.value = true
  try {
    await axios.post('/api/admin/config/llm', {
      apiKey: llmConfig.apiKey.trim(),
      apiUrl: llmConfig.apiUrl.trim() || 'https://api.deepseek.com/chat/completions',
      model: llmConfig.model.trim() || 'deepseek-chat',
    })
    saveHistoryItem(HISTORY_KEYS.url, llmConfig.apiUrl)
    saveHistoryItem(HISTORY_KEYS.key, llmConfig.apiKey)
    saveHistoryItem(HISTORY_KEYS.model, llmConfig.model)
    ElMessage.success('大模型配置已加密保存')
    llmConfig.apiKey = ''
    loadLlmConfig()
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '保存大模型配置失败')
  } finally {
    llmSaving.value = false
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
  loadLlmConfig()
  loadGithubRadarConfig()
  loadGithubAdminSubscriptions()
  loadMembershipConfig()
  loadMembershipCards()
  loadFeedback()
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
              <el-table-column label="操作" width="170" fixed="right">
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
              <el-table-column prop="username" label="用户名" min-width="160" />
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
              <el-table-column prop="group_name" label="家庭组" width="130">
                <template #default="{ row }">{{ row.group_name || '-' }}</template>
              </el-table-column>
              <el-table-column label="注册时间" width="180">
                <template #default="{ row }">{{ formatTime(row.created_at || row.createdAt) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="170" fixed="right">
                <template #default="{ row }">
                  <div class="row-actions">
                    <el-button size="small" type="primary" @click="openEditUser(row)">编辑</el-button>
                    <el-button size="small" type="danger" :disabled="row.id === currentUser?.id" @click="deleteUser(row)">删除</el-button>
                  </div>
                </template>
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
            </el-table>
          </div>
        </div>

        <div class="mobile-card-list">
          <article v-for="row in users" :key="row.id" class="mobile-admin-card">
            <div class="mobile-admin-head">
              <div class="mobile-admin-head-main">
                <h4>{{ row.username }}</h4>
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
                <dt>家庭组</dt>
                <dd>{{ row.group_name || '-' }}</dd>
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

      <el-tab-pane label="大模型配置">
        <div class="tab-header">
          <span class="tab-count">配置会加密保存，仅在服务端运行时解密使用</span>
          <el-button size="small" :loading="llmLoading" @click="loadLlmConfig">
            <el-icon><Refresh /></el-icon>
            刷新
          </el-button>
        </div>

        <section class="single-panel">
          <el-form label-position="top" size="large" @keyup.enter="saveLlmConfig">
            <el-form-item label="API URL">
              <el-autocomplete
                v-model="llmConfig.apiUrl"
                :fetch-suggestions="queryUrlHistory"
                placeholder="https://api.deepseek.com/chat/completions"
                clearable
                :trigger-on-focus="true"
                class="llm-autocomplete"
              />
            </el-form-item>

            <el-form-item label="API Key">
              <el-autocomplete
                v-model="llmConfig.apiKey"
                :fetch-suggestions="queryKeyHistory"
                placeholder="输入新的 API Key"
                clearable
                :trigger-on-focus="true"
                class="llm-autocomplete"
              />
            </el-form-item>

            <el-form-item label="模型名称">
              <el-autocomplete
                v-model="llmConfig.model"
                :fetch-suggestions="queryModelHistory"
                placeholder="deepseek-chat"
                clearable
                :trigger-on-focus="true"
                class="llm-autocomplete"
              />
            </el-form-item>

            <el-form-item class="llm-action-item">
              <div class="llm-actions">
                <el-button type="primary" :loading="llmSaving" @click="saveLlmConfig">{{ llmSaving ? '保存中...' : '保存配置' }}</el-button>
                <el-button :loading="llmTesting" @click="testLlmConfig">{{ llmTesting ? '测试中...' : '测试连接' }}</el-button>
              </div>
            </el-form-item>
          </el-form>
        </section>
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
                  :model-value="`http://47.106.101.81/api/membership/afdian/webhook?token=${membershipConfig.webhookToken || '你设置的令牌'}`"
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
  --el-table-tr-bg-color: transparent;
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
  background: color-mix(in srgb, var(--bg-input) 72%, transparent);
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
</style>

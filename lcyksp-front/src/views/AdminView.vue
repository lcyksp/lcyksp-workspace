<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh } from '@element-plus/icons-vue'
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

const feedbackList = ref([])
const feedbackLoading = ref(false)
const feedbackDeletingId = ref(null)

const fileDialogVisible = ref(false)
const fileFormLoading = ref(false)
const fileForm = reactive({
  code: '',
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
})

const llmConfig = reactive({
  apiUrl: 'https://api.deepseek.com/chat/completions',
  apiKey: '',
  model: 'deepseek-chat',
})
const llmLoading = ref(false)
const llmSaving = ref(false)
const llmTesting = ref(false)

const MAX_HISTORY = 5
const HISTORY_KEYS = {
  url: 'llmUrlHistory',
  key: 'llmKeyHistory',
  model: 'llmModelHistory',
}

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
    console.error('加载文件列表失败:', error)
    ElMessage.error(error.response?.data?.error || '加载文件列表失败')
  } finally {
    filesLoading.value = false
  }
}

async function deleteFile(code, fileName) {
  try {
    await ElMessageBox.confirm(`确定要删除文件“${fileName}”（提取码 ${code}）吗？此操作不可撤销。`, '删除文件', {
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
  fileForm.fileName = file.fileName
  fileForm.maxDownloads = file.maxDownloads

  if (!file.expireTime || String(file.expireTime).includes('2099')) {
    fileForm.expireTime = 'permanent'
    fileForm.isPermanent = true
  } else {
    const date = new Date(file.expireTime)
    if (Number.isNaN(date.getTime())) {
      fileForm.expireTime = ''
      fileForm.isPermanent = false
    } else {
      const pad = (value) => String(value).padStart(2, '0')
      fileForm.expireTime = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
      fileForm.isPermanent = false
    }
  }

  fileDialogVisible.value = true
}

async function submitFileForm() {
  const payload = {}

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
    const res = await axios.get('/api/admin/users')
    users.value = Array.isArray(res.data?.users) ? res.data.users : []
  } catch (error) {
    console.error('加载用户列表失败:', error)
    ElMessage.error(error.response?.data?.error || '加载用户列表失败')
  } finally {
    usersLoading.value = false
  }
}

function openAddUser() {
  userDialogMode.value = 'add'
  userForm.id = null
  userForm.username = ''
  userForm.password = ''
  userForm.role = 'user'
  userDialogVisible.value = true
}

function openEditUser(user) {
  userDialogMode.value = 'edit'
  userForm.id = user.id
  userForm.username = user.username
  userForm.password = ''
  userForm.role = user.role || 'user'
  userDialogVisible.value = true
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

  userFormLoading.value = true
  try {
    if (userDialogMode.value === 'add') {
      await axios.post('/api/admin/users', {
        username: userForm.username.trim(),
        password: userForm.password,
        role: userForm.role,
      })
      ElMessage.success('用户创建成功')
    } else {
      const payload = {
        username: userForm.username.trim(),
        role: userForm.role,
      }
      if (userForm.password) payload.password = userForm.password
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
    console.error('加载大模型配置失败:', error)
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

async function loadFeedback() {
  feedbackLoading.value = true
  try {
    const res = await axios.get('/api/admin/feedback')
    feedbackList.value = Array.isArray(res.data?.feedback) ? res.data.feedback : []
  } catch (error) {
    console.error('加载问题反馈失败:', error)
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

function isExpired(value) {
  if (!value) return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date.getTime() < Date.now()
}

onMounted(() => {
  loadFiles()
  loadUsers()
  loadLlmConfig()
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
          <el-button size="small" @click="loadFiles" :loading="filesLoading">
            <el-icon><Refresh /></el-icon>
            刷新
          </el-button>
        </div>

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
                <el-button size="small" type="primary" plain @click="openEditFile(row)">编辑</el-button>
                <el-button size="small" type="danger" plain @click="deleteFile(row.id, row.fileName)">删除</el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="用户管理">
        <div class="tab-header">
          <span class="tab-count">共 {{ users.length }} 个注册用户</span>
          <div class="tab-actions">
            <el-button size="small" @click="loadUsers" :loading="usersLoading">
              <el-icon><Refresh /></el-icon>
              刷新
            </el-button>
            <el-button type="primary" size="small" @click="openAddUser">
              <el-icon><Plus /></el-icon>
              新增用户
            </el-button>
          </div>
        </div>

        <el-table v-loading="usersLoading" :data="users" stripe size="small" empty-text="暂无用户数据">
          <el-table-column prop="id" label="ID" width="70" />
          <el-table-column prop="username" label="用户名" min-width="160" />
          <el-table-column prop="role" label="角色" width="100">
            <template #default="{ row }">
              <el-tag :type="row.role === 'admin' ? 'danger' : 'info'" effect="dark" size="small">
                {{ row.role === 'admin' ? '管理员' : '用户' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="groupName" label="家庭组" width="130">
            <template #default="{ row }">{{ row.groupName || '-' }}</template>
          </el-table-column>
          <el-table-column label="注册时间" width="180">
            <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="170" fixed="right">
            <template #default="{ row }">
              <div class="row-actions">
                <el-button size="small" type="primary" plain @click="openEditUser(row)">编辑</el-button>
                <el-button size="small" type="danger" plain :disabled="row.id === currentUser?.id" @click="deleteUser(row)">删除</el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="大模型配置">
        <div class="tab-header">
          <span class="tab-count">配置加密保存，仅在服务端运行时解密使用</span>
          <el-button size="small" @click="loadLlmConfig" :loading="llmLoading">
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
                placeholder="输入新的 API Key，留空则不覆盖"
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
                <el-button type="primary" :loading="llmSaving" @click="saveLlmConfig">
                  {{ llmSaving ? '保存中...' : '保存配置' }}
                </el-button>
                <el-button :loading="llmTesting" @click="testLlmConfig">
                  {{ llmTesting ? '测试中...' : '测试连接' }}
                </el-button>
              </div>
            </el-form-item>
          </el-form>
        </section>
      </el-tab-pane>

      <el-tab-pane label="问题反馈">
        <div class="tab-header">
          <span class="tab-count">查看用户提交的问题、页面、功能与具体现象</span>
          <el-button size="small" @click="loadFeedback" :loading="feedbackLoading">
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
                <el-button size="small" type="danger" plain :loading="feedbackDeletingId === item.id" @click="deleteFeedback(item.id)">
                  删除
                </el-button>
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

    <el-dialog v-model="userDialogVisible" :title="userDialogMode === 'add' ? '新增用户' : '编辑用户'" width="420px" :close-on-click-modal="false">
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
            <el-radio value="admin">管理员</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="userDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="userFormLoading" @click="submitUserForm">
          {{ userFormLoading ? '保存中...' : '保存' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="fileDialogVisible" title="编辑文件属性" width="440px" :close-on-click-modal="false">
      <el-form label-position="top">
        <el-form-item label="文件名">
          <el-input :model-value="fileForm.fileName" disabled />
        </el-form-item>
        <el-form-item label="提取码">
          <el-input :model-value="fileForm.code" disabled />
        </el-form-item>
        <el-form-item label="过期时间">
          <div class="file-edit-time-row">
            <el-input v-model="fileForm.expireTime" type="datetime-local" :disabled="fileForm.isPermanent" placeholder="选择过期时间" />
            <el-checkbox v-model="fileForm.isPermanent" @change="(value) => { fileForm.expireTime = value ? 'permanent' : '' }">
              永久有效
            </el-checkbox>
          </div>
          <div class="form-hint">取消勾选后可手动设置过期时间。</div>
        </el-form-item>
        <el-form-item label="下载次数限制（-1 表示无限）">
          <el-input-number v-model="fileForm.maxDownloads" :min="-1" :max="1000" :step="1" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="fileDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="fileFormLoading" @click="submitFileForm">
          {{ fileFormLoading ? '保存中...' : '保存' }}
        </el-button>
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

.badge-unlimited {
  color: #67c23a;
}

.badge-count {
  color: var(--text-primary);
}

.text-expired {
  color: #ff8f8f;
}

.llm-autocomplete {
  width: 100%;
}

.llm-action-item {
  margin-bottom: 0;
}

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
:deep(.el-input-number .el-input__wrapper) {
  background: var(--bg-input);
  box-shadow: 0 0 0 1px var(--border-color) inset;
}

:deep(.el-input__wrapper:hover),
:deep(.el-textarea__inner:hover),
:deep(.el-input-number .el-input__wrapper:hover) {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent-blue) 38%, var(--border-color)) inset;
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
:deep(.el-dialog__footer) {
  color: var(--text-primary);
}

:deep(.el-radio) {
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

  .feedback-meta {
    grid-template-columns: 1fr;
  }

  .feedback-card-head {
    flex-direction: column;
    align-items: stretch;
  }
}

@media (max-width: 640px) {
  .page-title {
    font-size: 1.25rem;
  }

  .row-actions,
  .tab-actions,
  .llm-actions {
    width: 100%;
  }

  .row-actions :deep(.el-button),
  .tab-actions :deep(.el-button),
  .llm-actions :deep(.el-button) {
    flex: 1;
  }

  .single-panel {
    padding: 14px;
    border-radius: 14px;
  }
}
</style>

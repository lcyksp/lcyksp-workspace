<script setup>
/**
 * TransmitBox.vue — 临时文件闪传与分享管理组件
 * 支持拖拽上传、安全选项、自动销毁、分享历史管理、取件码自定义及物理销毁
 */
import { ref, reactive, onMounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { UploadFilled, Link, CopyDocument, Delete, Edit, Document, Lock, Calendar } from '@element-plus/icons-vue'
import axios from 'axios'
import { copyToClipboard } from '../utils/clipboard.js'
import { formatSize } from '../utils/format.js'

// ---------- 状态 ----------
const activeTab = ref('upload')
const files = ref([])
const uploading = ref(false)
const dialogVisible = ref(false)
const result = reactive({
  code: '',
  url: '',
})

// 高级安全选项
const security = reactive({
  password: '',
  maxDownloads: 1,
  expireTime: '24h',
})

const expireOptions = [
  { label: '1 小时', value: '1h' },
  { label: '12 小时', value: '12h' },
  { label: '24 小时', value: '24h' },
  { label: '7 天',   value: '7d' },
  { label: '🔒 永久有效（不自动销毁）', value: 'permanent' },
]

// 历史记录状态
const isLoggedIn = ref(false)
const historyList = ref([])
const loadingHistory = ref(false)

// 修改过期时间状态与方法
const editExpireVisible = ref(false)
const editExpireRow = ref(null)
const editExpireTimeValue = ref('24h')
const editCustomExpireTime = ref('')

function handleExpireOptionChange(val) {
  if (val === 'custom') {
    const defaultDate = new Date(Date.now() + 24 * 3600 * 1000)
    const pad = (value) => String(value).padStart(2, '0')
    editCustomExpireTime.value = `${defaultDate.getFullYear()}-${pad(defaultDate.getMonth() + 1)}-${pad(defaultDate.getDate())}T${pad(defaultDate.getHours())}:${pad(defaultDate.getMinutes())}`
  }
}

function openEditExpireTime(row) {
  editExpireRow.value = row
  editExpireTimeValue.value = '24h'
  editCustomExpireTime.value = ''
  editExpireVisible.value = true
}

async function submitEditExpireTime() {
  if (!editExpireRow.value) return
  
  let targetExpireTime = editExpireTimeValue.value
  if (targetExpireTime === 'custom') {
    if (!editCustomExpireTime.value) {
      ElMessage.warning('请选择自定义过期时间')
      return
    }
    const d = new Date(editCustomExpireTime.value)
    if (isNaN(d.getTime())) {
      ElMessage.warning('日期格式无效')
      return
    }
    targetExpireTime = d.toISOString()
  }

  try {
    const res = await axios.post('/api/transmit/update-expire', {
      code: editExpireRow.value.code,
      expireTime: targetExpireTime
    })
    ElMessage.success(res.data.message || '过期时间已修改')
    editExpireVisible.value = false
    fetchHistory()
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '修改失败')
  }
}

function checkLoginState() {
  const oldLogin = isLoggedIn.value
  isLoggedIn.value = !!localStorage.getItem('lcyksp_token')
  if (isLoggedIn.value && !oldLogin && activeTab.value === 'history') {
    fetchHistory()
  }
}

// ---------- 监听 Tab 切换 ----------
watch(activeTab, (newTab) => {
  checkLoginState()
  if (newTab === 'history' && isLoggedIn.value) {
    fetchHistory()
  }
})

onMounted(() => {
  checkLoginState()
  // 监听可能的登录成功事件，同步状态
  window.addEventListener('login-success', checkLoginState)
})

// ---------- 获取分享历史 ----------
async function fetchHistory() {
  loadingHistory.value = true
  try {
    const res = await axios.get('/api/transmit/history')
    historyList.value = res.data.history || []
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '获取历史分享失败')
  } finally {
    loadingHistory.value = false
  }
}

// ---------- 修改提取码 ----------
function handleEditCode(row) {
  ElMessageBox.prompt('请输入新的 4-16 位提取码（仅限大写字母和数字，排除 0/1/I/O）', '修改提取码', {
    confirmButtonText: '确定',
    cancelButtonText: '取消',
    inputValue: row.code,
    inputPattern: /^[a-zA-Z2-9]{4,16}$/,
    inputErrorMessage: '提取码应为 4-16 位字母或数字（不包含 0/1/I/O）'
  }).then(async ({ value }) => {
    try {
      const res = await axios.post('/api/transmit/update-code', {
        oldCode: row.code,
        newCode: value
      })
      ElMessage.success(res.data.message || '提取码修改成功')
      fetchHistory()
    } catch (err) {
      ElMessage.error(err.response?.data?.error || '修改失败')
    }
  }).catch(() => {})
}

// ---------- 删除分享记录 ----------
function handleDelete(row) {
  ElMessageBox.confirm('确定要删除这个分享吗？物理文件也将被立即从服务器永久删除！', '物理销毁确认', {
    confirmButtonText: '确定',
    cancelButtonText: '取消',
    type: 'warning'
  }).then(async () => {
    try {
      const res = await axios.delete('/api/transmit/delete/' + row.code)
      ElMessage.success(res.data.message || '分享已成功删除')
      fetchHistory()
    } catch (err) {
      ElMessage.error(err.response?.data?.error || '删除失败')
    }
  }).catch(() => {})
}

// ---------- 复制辅助 ----------
async function copyRowCode(code) {
  const ok = await copyToClipboard(code)
  if (ok) ElMessage.success('提取码已复制')
  else ElMessage.warning('复制失败')
}

async function copyRowLink(code) {
  const url = `${window.location.origin}/transmit/${code}`
  const ok = await copyToClipboard(url)
  if (ok) ElMessage.success('提取链接已复制')
  else ElMessage.warning('复制失败')
}

// ---------- 文件变更 ----------
function handleFileChange(uploadFile) {
  const newFiles = uploadFile.raw ? [...files.value, uploadFile.raw] : files.value
  const totalSize = newFiles.reduce((sum, f) => sum + (f.size || 0), 0)
  if (totalSize > 2 * 1024 * 1024 * 1024) {
    ElMessage({
      message: '文件总大小超过 2GB 限制，请减少文件数量',
      type: 'warning',
      duration: 3000,
    })
    return false
  }
  files.value.push(uploadFile.raw)
  return false
}

function handleRemove(uploadFile) {
  files.value = files.value.filter(f => f !== uploadFile.raw)
}

function handleExceed() {
  ElMessage({
    message: '最多上传 5 个文件',
    type: 'warning',
    duration: 3000,
  })
}

// ---------- 上传 ----------
async function handleUpload() {
  checkLoginState()
  if (!isLoggedIn.value) {
    ElMessage.warning('请先登录账号，只有登录用户才能上传文件！')
    return
  }

  if (files.value.length === 0) {
    ElMessage.warning('请先选择文件')
    return
  }

  const totalSize = files.value.reduce((sum, f) => sum + (f.size || 0), 0)
  if (totalSize > 2 * 1024 * 1024 * 1024) {
    ElMessage({
      message: '文件总大小超过 2GB 限制',
      type: 'warning',
      duration: 3000,
    })
    return
  }

  uploading.value = true
  try {
    const formData = new FormData()
    for (const f of files.value) {
      formData.append('files', f)
    }
    formData.append('maxDownloads', security.maxDownloads > 0 ? String(security.maxDownloads) : '')
    formData.append('expireTime', security.expireTime)
    if (security.password) {
      formData.append('password', security.password)
    }

    const res = await axios.post('/api/transmit/upload', formData)
    const data = res.data

    result.code = data.code
    result.url = `${window.location.origin}/transmit/${data.code}`
    dialogVisible.value = true

    ElMessage.success('闪传链接已生成！')
    files.value = []
    if (isLoggedIn.value) {
      fetchHistory()
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '上传并创建链接失败')
  } finally {
    uploading.value = false
  }
}

async function copyLink() {
  const ok = await copyToClipboard(result.url)
  if (ok) {
    ElMessage.success('链接已复制到剪贴板')
  } else {
    ElMessage.warning('复制失败，请手动复制')
  }
}

function formatTime(isoStr) {
  if (!isoStr) return '-'
  if (String(isoStr).includes('2099')) return '永久有效'
  try {
    const d = new Date(isoStr)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  } catch {
    return isoStr
  }
}

function getDownloadsStr(item) {
  if (item.maxDownloads === -1 || item.maxDownloads === 0) {
    return `${item.currentDownloads} / 无限制`
  }
  return `${item.currentDownloads} / ${item.maxDownloads}`
}
</script>

<template>
  <div class="transmit-box">
    <el-tabs v-model="activeTab" class="custom-tabs">
      <!-- Upload Tab -->
      <el-tab-pane label="📤 上传文件" name="upload">
        <div class="tab-pane-content">
          <!-- Not Logged In Tip -->
          <div v-if="!isLoggedIn" class="login-prompt">
            <el-icon :size="32" color="#e6a23c"><Lock /></el-icon>
            <p>请先在页面右上角登录，只有登录用户才能上传分享文件。</p>
          </div>

          <template v-else>
            <!-- 拖拽上传区域 -->
            <el-upload
              drag
              multiple
              :auto-upload="false"
              :show-file-list="true"
              :on-change="handleFileChange"
              :on-remove="handleRemove"
              :on-exceed="handleExceed"
              :limit="5"
              :file-list="files"
            >
              <el-icon class="upload-icon" :size="48"><UploadFilled /></el-icon>
              <div class="upload-text">
                拖拽文件到此处，或 <em>点击选择</em>
              </div>
              <template #tip>
                <div class="upload-tip">最多 5 个文件，总大小不超过 2GB</div>
              </template>
            </el-upload>

            <!-- 高级安全选项（折叠面板） -->
            <el-collapse class="security-panel" accordion>
              <el-collapse-item title="🔒 高级安全选项" name="security">
                <el-form label-position="top" size="small">
                  <el-form-item label="访问密码（留空则公开下载）">
                    <el-input
                      v-model="security.password"
                      type="password"
                      show-password
                      placeholder="留空则公开下载"
                      clearable
                    />
                  </el-form-item>
                  <el-form-item label="下载次数限制">
                    <el-input-number
                      v-model="security.maxDownloads"
                      :min="0"
                      :max="100"
                      :step="1"
                    />
                    <span class="form-hint">次（0 或空 = 不限次数, 1 = 阅后即焚）</span>
                  </el-form-item>
                  <el-form-item label="到期自动销毁">
                    <el-select v-model="security.expireTime" style="width: 100%">
                      <el-option
                        v-for="opt in expireOptions"
                        :key="opt.value"
                        :label="opt.label"
                        :value="opt.value"
                      />
                    </el-select>
                  </el-form-item>
                </el-form>
              </el-collapse-item>
            </el-collapse>

            <!-- 生成按钮 -->
            <el-button
              type="primary"
              size="large"
              :loading="uploading"
              :disabled="files.length === 0"
              class="submit-btn"
              @click="handleUpload"
            >
              <el-icon><Link /></el-icon>
              {{ uploading ? '生成中…' : '生成闪传链接' }}
            </el-button>
          </template>
        </div>
      </el-tab-pane>

      <!-- History Tab -->
      <el-tab-pane label="📜 我的分享历史" name="history">
        <div class="tab-pane-content">
          <div v-if="!isLoggedIn" class="login-prompt">
            <el-icon :size="32" color="#e6a23c"><Lock /></el-icon>
            <p>请先登录您的账号以管理您的分享记录。</p>
          </div>

          <div v-else v-loading="loadingHistory" class="history-container">
            <div v-if="historyList.length === 0" class="empty-history">
              <el-icon :size="40" color="#555"><Document /></el-icon>
              <p>暂无任何分享记录</p>
            </div>

            <div v-else class="history-list">
              <div v-for="item in historyList" :key="item.code" class="history-item" :class="{ 'is-expired': item.isExpired }">
                <div class="item-header">
                  <span class="item-code" @click="copyRowCode(item.code)">
                    提取码: <strong>{{ item.code }}</strong>
                    <el-icon class="copy-icon"><CopyDocument /></el-icon>
                  </span>
                  <el-tag :type="item.isExpired ? 'danger' : 'success'" size="small">
                    {{ item.isExpired ? '已失效' : '有效' }}
                  </el-tag>
                </div>

                <div class="item-body">
                  <div class="item-files">
                    <div v-for="(name, idx) in item.fileNames" :key="idx" class="filename-row">
                      📄 {{ name }}
                    </div>
                  </div>
                  <div class="item-meta">
                    <div>大小: {{ formatSize(item.totalSize) }}</div>
                    <div>下载次数: {{ getDownloadsStr(item) }}</div>
                    <div>过期时间: {{ formatTime(item.expireTime) }}</div>
                  </div>
                </div>

                <div class="item-actions">
                  <el-button
                    type="primary"
                    size="small"
                    text
                    :disabled="item.isExpired"
                    @click="copyRowLink(item.code)"
                  >
                    <el-icon><Link /></el-icon>复制链接
                  </el-button>
                  <el-button
                    type="warning"
                    size="small"
                    text
                    :disabled="item.isExpired"
                    @click="handleEditCode(item)"
                  >
                    <el-icon><Edit /></el-icon>修改提取码
                  </el-button>
                  <el-button
                    type="success"
                    size="small"
                    text
                    :disabled="item.isExpired"
                    @click="openEditExpireTime(item)"
                  >
                    <el-icon><Calendar /></el-icon>修改过期时间
                  </el-button>
                  <el-button
                    type="danger"
                    size="small"
                    text
                    @click="handleDelete(item)"
                  >
                    <el-icon><Delete /></el-icon>删除
                  </el-button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- 修改过期时间弹窗 -->
    <el-dialog
      v-model="editExpireVisible"
      title="修改过期时间"
      width="400px"
      :close-on-click-modal="false"
      center
    >
      <el-form label-position="top" style="padding: 10px 0 0;">
        <el-form-item label="选择新过期时间">
          <el-select v-model="editExpireTimeValue" style="width: 100%" @change="handleExpireOptionChange">
            <el-option label="1 小时" value="1h" />
            <el-option label="12 小时" value="12h" />
            <el-option label="24 小时" value="24h" />
            <el-option label="7 天" value="7d" />
            <el-option label="🔒 永久有效（不自动销毁）" value="permanent" />
            <el-option label="📅 自定义过期时间" value="custom" />
          </el-select>
        </el-form-item>
        
        <el-form-item v-if="editExpireTimeValue === 'custom'" label="自定义过期时间">
          <el-date-picker
            v-model="editCustomExpireTime"
            type="datetime"
            placeholder="选择过期时间"
            value-format="YYYY-MM-DDTHH:mm:ss.000Z"
            style="width: 100%;"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editExpireVisible = false">取消</el-button>
        <el-button type="primary" @click="submitEditExpireTime">确定</el-button>
      </template>
    </el-dialog>

    <!-- 结果弹窗 -->
    <el-dialog
      v-model="dialogVisible"
      title="🎉 闪传链接已生成"
      width="380px"
      :close-on-click-modal="false"
      center
    >
      <div class="result-card">
        <div class="result-label">提取码</div>
        <div class="result-code">{{ result.code }}</div>
        <el-divider />
        <div class="result-label">闪传链接</div>
        <div class="result-url">{{ result.url }}</div>
        <el-button
          type="success"
          class="copy-btn"
          @click="copyLink"
        >
          <el-icon><CopyDocument /></el-icon>
          一键复制链接
        </el-button>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.transmit-box {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.custom-tabs :deep(.el-tabs__item) {
  color: var(--text-secondary);
  font-size: 0.95rem;
}

.custom-tabs :deep(.el-tabs__item.is-active) {
  color: var(--accent-blue);
  font-weight: 500;
}

.custom-tabs :deep(.el-tabs__active-bar) {
  background-color: var(--accent-blue);
}

.tab-pane-content {
  padding-top: 12px;
}

.login-prompt {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 40px 16px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 0.9rem;
}

.upload-icon {
  margin-bottom: 8px;
}

.upload-text {
  color: var(--text-secondary);
  font-size: 0.95rem;
}

.upload-text em {
  color: var(--accent-blue);
  font-style: normal;
  font-weight: 500;
}

.upload-tip {
  color: var(--text-secondary);
  font-size: 0.8rem;
  margin-top: 4px;
}

.security-panel {
  --el-collapse-header-bg-color: transparent;
  --el-collapse-content-bg-color: transparent;
  margin-top: 8px;
  margin-bottom: 8px;
}

.form-hint {
  color: var(--text-secondary);
  font-size: 0.8rem;
  margin-left: 8px;
}

.submit-btn {
  width: 100%;
  font-size: 1rem;
  letter-spacing: 1px;
  margin-top: 8px;
}

/* 历史列表样式 */
.history-container {
  min-height: 200px;
}

.empty-history {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 48px 0;
  color: var(--text-dim);
  font-size: 0.85rem;
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: 500px;
  overflow-y: auto;
  padding-right: 4px;
}

.history-item {
  background: var(--bg-ctrl);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: border-color 0.2s, opacity 0.2s;
}

.history-item:hover {
  border-color: color-mix(in srgb, var(--accent-blue) 30%, var(--border-color));
}

.history-item.is-expired {
  opacity: 0.6;
}

.item-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.item-code {
  color: var(--text-secondary);
  font-size: 0.85rem;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.item-code strong {
  color: #f0c040;
  font-family: 'Courier New', monospace;
  font-size: 1.1rem;
  letter-spacing: 1px;
}

.copy-icon {
  font-size: 0.8rem;
  color: var(--text-dim);
}

.item-code:hover .copy-icon {
  color: var(--accent-blue);
}

.item-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: color-mix(in srgb, var(--bg-card) 60%, transparent);
  border-radius: 6px;
  padding: 8px 12px;
}

.item-files {
  font-size: 0.85rem;
  color: var(--text-primary);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.filename-row {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 0.75rem;
  color: var(--text-secondary);
  border-top: 1px solid var(--border-color);
  padding-top: 6px;
  margin-top: 4px;
}

.item-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  border-top: 1px dashed var(--border-color);
  padding-top: 8px;
}

.item-actions :deep(.el-button) {
  padding: 4px 8px;
  font-size: 0.78rem;
}

/* 结果弹窗 */
.result-card {
  text-align: center;
  padding: 8px 0;
}

.result-label {
  color: var(--text-secondary);
  font-size: 0.85rem;
  margin-bottom: 6px;
}

.result-code {
  font-size: 2.2rem;
  font-weight: 800;
  letter-spacing: 8px;
  color: #f0c040;
  font-family: 'Courier New', monospace;
}

.result-url {
  font-size: 0.85rem;
  color: var(--accent-blue);
  word-break: break-all;
  margin-bottom: 16px;
  background: var(--bg-ctrl);
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
}

.copy-btn {
  width: 100%;
  margin-top: 4px;
}

:deep(.el-upload-dragger) {
  background: var(--bg-ctrl) !important;
  border: 1px dashed var(--border-color) !important;
  border-radius: 12px !important;
}

:deep(.el-upload-dragger:hover) {
  border-color: var(--accent-blue) !important;
}

:deep(.el-collapse-item__header),
:deep(.el-collapse-item__wrap),
:deep(.el-collapse-item__content) {
  background: var(--bg-ctrl) !important;
  color: var(--text-primary) !important;
  border-color: var(--border-color) !important;
}

:deep(.el-form-item__label) {
  color: var(--text-primary) !important;
}

:deep(.el-dialog__header),
:deep(.el-dialog__body) {
  background: var(--bg-card);
}
</style>

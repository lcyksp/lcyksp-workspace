<script setup>
/**
 * ReceiveView.vue — 提取码接收页
 *
 * 直接访问 /transmit/:id 时：
 * 1. 从路由参数获取提取码
 * 2. POST /api/transmit/verify 验证有效性
 * 3. 若需要密码则显示密码输入框
 * 4. 验证通过后显示文件信息 + 下载按钮
 * 5. 任何错误显示优雅的"提取码已失效"UI
 */
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import axios from 'axios'
import { copyToClipboard } from '../utils/clipboard.js'
import { formatSize } from '../utils/format.js'
import { CircleCheckFilled, CopyDocument, Download, Loading, Lock, WarningFilled } from '@element-plus/icons-vue'

const route = useRoute()

// ---------- 状态 ----------
const loading = ref(true)
const verified = ref(false)
const needsPassword = ref(false)
const fileInfo = ref(null)
const error = ref('')
const password = ref('')
const verifyingPwd = ref(false)

// 提取码
const pickupCode = ref('')

// ---------- 验证取件码 ----------
async function verifyCode(pwd) {
  loading.value = true
  error.value = ''
  try {
    const res = await axios.post('/api/transmit/verify', {
      code: pickupCode.value,
      password: pwd || undefined,
    })
    const data = res.data
    verified.value = true
    needsPassword.value = false
    fileInfo.value = {
      fileName: Array.isArray(data.fileNames) ? data.fileNames.join(', ') : data.fileName,
      fileNames: Array.isArray(data.fileNames) ? data.fileNames : [data.fileName],
      fileCount: data.fileCount || 1,
      fileSize: formatSize(data.totalSize || data.fileSize),
    }
  } catch (err) {
    const status = err.response?.status
    const msg = err.response?.data?.error || ''

    if (status === 401 || status === 403) {
      if (msg.includes('密码')) {
        // 需要密码
        needsPassword.value = true
        verified.value = false
        ElMessage.warning('该文件需要密码才能下载')
      } else {
        error.value = msg || '提取码已失效'
        verified.value = false
      }
    } else {
      error.value = msg || '提取码已失效'
      verified.value = false
    }
  } finally {
    loading.value = false
  }
}

// ---------- 提交密码 ----------
async function submitPassword() {
  if (!password.value) {
    ElMessage.warning('请输入密码')
    return
  }
  verifyingPwd.value = true
  await verifyCode(password.value)
  verifyingPwd.value = false
}

// ---------- 下载文件（统一使用 fetch + blob，避免 SPA 页面跳转）----------
async function downloadFile() {
  const token = localStorage.getItem('lcyksp_token')
  const headers = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  // 后端 /download 现在也校验密码了（以前只有 /verify 校验，知道取件码就能绕过）。
  // HTTP 头只能放 latin1，中文密码必须先 encodeURIComponent，后端再 decode 回来。
  if (password.value) headers['X-Transmit-Password'] = encodeURIComponent(password.value)
  const names = fileInfo.value?.fileNames || [fileInfo.value?.fileName || 'download']

  for (let i = 0; i < names.length; i++) {
    try {
      const res = await fetch(`/api/transmit/download/${pickupCode.value}?fileIndex=${i}`, { headers })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: '下载失败' }))
        ElMessage.error(`${names[i]} 下载失败: ${errData.error}`)
        continue
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = names[i]
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      ElMessage.error(`${names[i]} 下载失败: ${err.message}`)
    }
  }
}

// ---------- 复制提取码 ----------
async function copyCode() {
  const ok = await copyToClipboard(pickupCode.value)
  if (ok) ElMessage.success('提取码已复制')
  else ElMessage.warning('复制失败')
}

onMounted(() => {
  pickupCode.value = route.params.id
  if (!pickupCode.value) {
    error.value = '未提供提取码'
    loading.value = false
    return
  }
  verifyCode()
})
</script>

<template>
  <div class="receive-view">
    <div class="receive-card">
      <!-- 加载中 -->
      <div v-if="loading" class="state-box">
        <el-icon class="is-loading" :size="40"><Loading /></el-icon>
        <p class="state-text">正在验证提取码…</p>
      </div>

      <!-- 需要密码 -->
      <div v-else-if="needsPassword" class="state-box">
        <el-icon :size="48" class="lock-icon"><Lock /></el-icon>
        <h3 class="state-title">该文件需要密码</h3>
        <p class="state-desc">请输入访问密码以继续</p>
        <el-input
          v-model="password"
          type="password"
          show-password
          placeholder="请输入密码"
          class="pwd-input"
          size="large"
          @keyup.enter="submitPassword"
        />
        <el-button
          type="primary"
          size="large"
          :loading="verifyingPwd"
          class="action-btn"
          @click="submitPassword"
        >
          {{ verifyingPwd ? '验证中…' : '验证密码' }}
        </el-button>
      </div>

      <!-- 已失效 / 错误 -->
      <div v-else-if="error" class="state-box error-state">
        <el-icon :size="48" color="#e74c3c"><WarningFilled /></el-icon>
        <h3 class="state-title">提取码已失效</h3>
        <p class="state-desc">{{ error }}</p>
        <el-button type="primary" size="large" class="action-btn" @click="$router.push('/transmit')">
          去生成新的闪传链接
        </el-button>
      </div>

      <!-- 验证成功 — 显示文件信息和下载 -->
      <div v-else-if="verified && fileInfo" class="success-box">
        <el-icon :size="48" color="#67c23a"><CircleCheckFilled /></el-icon>
        <h3 class="state-title">文件提取成功</h3>

        <div class="file-info">
          <div class="info-row">
            <span class="info-label">📄 文件名</span>
            <span class="info-value">{{ fileInfo.fileName }}</span>
          </div>
          <div class="info-row">
            <span class="info-label">📦 文件大小</span>
            <span class="info-value">{{ fileInfo.fileSize }}</span>
          </div>
          <div class="info-row">
            <span class="info-label">🔑 提取码</span>
            <span class="info-value code-value">
              {{ pickupCode }}
              <el-button text size="small" @click="copyCode" style="margin-left: 8px">
                <el-icon><CopyDocument /></el-icon>
              </el-button>
            </span>
          </div>
        </div>

        <el-button
          type="success"
          size="large"
          class="action-btn download-btn"
          @click="downloadFile"
        >
          <el-icon><Download /></el-icon>
          立即下载文件
        </el-button>

        <p class="download-hint">点击下载后浏览器将开始传输文件</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.receive-view {
  max-width: 520px;
  margin: 0 auto;
  padding: 40px 16px;
}

.receive-card {
  background: #16162a;
  border-radius: 12px;
  padding: 36px 28px;
  border: 1px solid #222244;
  min-height: 280px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.state-box {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.state-title {
  font-size: 1.3rem;
  font-weight: 500;
  color: #e0e0e0;
  margin: 8px 0 0;
}

.state-text {
  color: #888;
  font-size: 0.95rem;
  margin: 0;
}

.state-desc {
  color: #888;
  font-size: 0.9rem;
  margin: 0 0 8px;
}

.lock-icon {
  color: #f0c040;
}

.pwd-input {
  max-width: 280px;
}

.action-btn {
  width: 100%;
  max-width: 320px;
  margin-top: 12px;
  font-size: 1rem;
}

.download-btn {
  margin-top: 20px;
}

.download-hint {
  color: #666;
  font-size: 0.8rem;
  margin: 8px 0 0;
}

/* 成功状态 */
.success-box {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
}

.file-info {
  width: 100%;
  margin: 16px 0 4px;
  background: #0d0d1a;
  border-radius: 8px;
  padding: 16px;
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid #1a1a30;
}

.info-row:last-child {
  border-bottom: none;
}

.info-label {
  color: #888;
  font-size: 0.85rem;
}

.info-value {
  color: #c0c0e0;
  font-size: 0.9rem;
  font-weight: 500;
}

.code-value {
  font-family: 'Courier New', monospace;
  color: #f0c040;
  letter-spacing: 2px;
  display: flex;
  align-items: center;
}

/* 错误状态 */
.error-state .state-title {
  color: #e74c3c;
}

@media (max-width: 480px) {
  .receive-view { padding: 20px 12px; }
  .receive-card { padding: 24px 16px; }
}
</style>

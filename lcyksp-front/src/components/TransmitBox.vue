<script setup>
/**
 * TransmitBox.vue — 完全体临时文件闪传组件
 * 拖拽上传 + 高级安全选项 + 一键复制取件码
 */
import { ref, reactive } from 'vue'
import { ElMessage } from 'element-plus'
import axios from 'axios'
import { copyToClipboard } from '../utils/clipboard.js'

// ---------- 状态 ----------
const file = ref(null)
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

// ---------- 文件变更 ----------
function handleFileChange(uploadFile) {
  file.value = uploadFile.raw
}

function handleRemove() {
  file.value = null
}

// ---------- 上传 ----------
async function handleUpload() {
  if (!file.value) {
    ElMessage.warning('请先选择一个文件')
    return
  }

  uploading.value = true
  try {
    const formData = new FormData()
    formData.append('file', file.value)
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
    // 清空文件
    file.value = null
  } catch (err) {
    // 拦截器已处理错误提示
    console.error('上传失败:', err)
  } finally {
    uploading.value = false
  }
}

// ---------- 一键复制（带兼容降级）----------
async function copyLink() {
  const ok = await copyToClipboard(result.url)
  if (ok) {
    ElMessage.success('链接已复制到剪贴板')
  } else {
    ElMessage.warning('复制失败，请手动复制')
  }
}
</script>

<template>
  <div class="transmit-box">
    <!-- 拖拽上传区域 -->
    <el-upload
      drag
      :auto-upload="false"
      :show-file-list="true"
      :on-change="handleFileChange"
      :on-remove="handleRemove"
      :limit="1"
      :file-list="[]"
    >
      <el-icon class="upload-icon" :size="48"><UploadFilled /></el-icon>
      <div class="upload-text">
        拖拽文件到此处，或 <em>点击选择</em>
      </div>
      <template #tip>
        <div class="upload-tip">单个文件最大支持 2GB</div>
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
      :disabled="!file"
      class="submit-btn"
      @click="handleUpload"
    >
      <el-icon><Link /></el-icon>
      {{ uploading ? '生成中…' : '生成闪传链接' }}
    </el-button>

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
}

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

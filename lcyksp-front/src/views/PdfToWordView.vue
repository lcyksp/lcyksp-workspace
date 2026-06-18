<script setup>
import { ref, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { UploadFilled, Document, Loading, Download, Refresh } from '@element-plus/icons-vue'
import axios from 'axios'

const file = ref(null)
const converting = ref(false)
const progressText = ref('')
const rangeMode = ref('all') // 'all' or 'range'
const startPage = ref(1)
const endPage = ref(1)

// Progress message cycling to make it look alive
let progressInterval = null
const progressMessages = [
  '正在读取并解析 PDF 结构...',
  '正在分析文字与字体排版样式...',
  '正在智能匹配表格与栏目布局...',
  '正在重建段落与页面流...',
  '正在构建 Word 文档 (OpenXML)...',
  '转换时间取决于 PDF 的页数，请稍候...'
]

function startProgressCycling() {
  let idx = 0
  progressText.value = progressMessages[0]
  progressInterval = setInterval(() => {
    idx = (idx + 1) % progressMessages.length
    progressText.value = progressMessages[idx]
  }, 3000)
}

function stopProgressCycling() {
  if (progressInterval) {
    clearInterval(progressInterval)
    progressInterval = null
  }
}

function handleFileChange(uploadFile) {
  const raw = uploadFile.raw
  if (!raw) return
  if (raw.type !== 'application/pdf') {
    ElMessage.warning('只能上传 PDF 格式的文件')
    return
  }
  file.value = {
    name: raw.name,
    size: (raw.size / 1024 / 1024).toFixed(2) + ' MB',
    rawFile: raw,
  }
}

function handleReset() {
  file.value = null
  rangeMode.value = 'all'
  startPage.value = 1
  endPage.value = 1
  converting.value = false
  stopProgressCycling()
}

async function handleConvert() {
  if (!file.value) {
    ElMessage.warning('请先选择一个 PDF 文件')
    return
  }

  converting.value = true
  startProgressCycling()

  const formData = new FormData()
  formData.append('pdf', file.value.rawFile)
  
  if (rangeMode.value === 'range') {
    formData.append('start', startPage.value)
    formData.append('end', endPage.value)
  }

  try {
    const response = await axios({
      method: 'post',
      url: '/api/convert/pdf-to-docx',
      data: formData,
      headers: {
        'Content-Type': 'multipart/form-data'
      },
      responseType: 'blob',
      timeout: 180000 // 3 minutes timeout for large documents
    })

    const blob = new Blob([response.data], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    })

    const originalName = file.value.name.replace(/\.[^.]+$/, '') || 'document'
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `${originalName}.docx`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(link.href)

    ElMessage.success('PDF 转换 Word 成功！已开始下载')
  } catch (err) {
    console.error(err)
    let errMsg = '转换失败，请检查 PDF 文件是否受损或过大'
    if (err.response && err.response.data) {
      try {
        const text = await err.response.data.text()
        const parsed = JSON.parse(text)
        errMsg = parsed.error || errMsg
      } catch (e) {
        // ignore
      }
    } else if (err.message) {
      errMsg = err.message
    }
    ElMessage.error(errMsg)
  } finally {
    converting.value = false
    stopProgressCycling()
  }
}

onUnmounted(() => {
  stopProgressCycling()
})
</script>

<template>
  <div class="pdf-to-word-view">
    <div class="page-header">
      <div>
        <h2 class="page-title"><span class="title-icon">📝</span> PDF 转 Word</h2>
        <p class="page-desc">高保真 PDF 转换 DOCX · 自动识别表格和多栏布局 · 保持文字段落可编辑</p>
      </div>
    </div>

    <el-row :gutter="20" justify="center">
      <el-col :xs="24" :sm="20" :md="16" :lg="12">
        <div class="card-wrap">
          <!-- Upload Area -->
          <el-upload
            v-if="!file"
            drag
            :auto-upload="false"
            :show-file-list="false"
            :on-change="handleFileChange"
            accept="application/pdf"
            class="upload-area"
          >
            <div class="upload-placeholder">
              <el-icon :size="48" class="upload-icon"><UploadFilled /></el-icon>
              <span>拖拽 PDF 文件到此处，或点击选择</span>
              <span class="upload-hint">支持可编辑或扫描版 PDF 格式</span>
            </div>
          </el-upload>

          <!-- File Info & Settings Card -->
          <div v-else class="file-details">
            <div class="file-info-header">
              <el-icon class="file-icon"><Document /></el-icon>
              <div class="file-meta">
                <div class="file-name" :title="file.name">{{ file.name }}</div>
                <div class="file-size">{{ file.size }}</div>
              </div>
              <el-button
                circle
                type="danger"
                size="small"
                :icon="Refresh"
                @click="handleReset"
                :disabled="converting"
                title="重新选择"
              ></el-button>
            </div>

            <el-divider></el-divider>

            <!-- Settings -->
            <div class="settings-section">
              <h4 class="settings-title">转换范围设置</h4>
              <el-radio-group v-model="rangeMode" :disabled="converting" class="range-radio-group">
                <el-radio label="all">全部页面</el-radio>
                <el-radio label="range">指定页码范围</el-radio>
              </el-radio-group>

              <div v-if="rangeMode === 'range'" class="range-inputs">
                <el-input-number
                  v-model="startPage"
                  :min="1"
                  size="small"
                  controls-position="right"
                  :disabled="converting"
                  placeholder="起始页"
                ></el-input-number>
                <span class="range-separator">至</span>
                <el-input-number
                  v-model="endPage"
                  :min="startPage"
                  size="small"
                  controls-position="right"
                  :disabled="converting"
                  placeholder="结束页"
                ></el-input-number>
              </div>
            </div>

            <!-- Converting Progress -->
            <div v-if="converting" class="progress-wrap">
              <el-icon class="is-loading progress-spinner" :size="32"><Loading /></el-icon>
              <div class="progress-message">{{ progressText }}</div>
            </div>

            <!-- Actions -->
            <div class="action-buttons">
              <el-button
                v-if="!converting"
                type="primary"
                size="large"
                class="action-btn"
                @click="handleConvert"
              >
                <el-icon><Download /></el-icon>
                <span>立即转换并下载 Word</span>
              </el-button>
              
              <el-button
                v-else
                type="info"
                size="large"
                class="action-btn"
                disabled
              >
                <el-icon class="is-loading"><Loading /></el-icon>
                <span>正在高精度转换中...</span>
              </el-button>
            </div>
          </div>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.pdf-to-word-view {
  padding: 10px;
  color: #ffffff;
}

.page-header {
  margin-bottom: 30px;
}

.page-title {
  font-size: 24px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 8px 0;
  background: linear-gradient(135deg, #a5b4fc, #818cf8);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.title-icon {
  -webkit-text-fill-color: initial;
}

.page-desc {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.6);
  margin: 0;
}

.card-wrap {
  background: rgba(22, 22, 42, 0.6);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
  padding: 30px;
  box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
}

.upload-area {
  width: 100%;
}

.upload-area :deep(.el-upload-dragger) {
  background: rgba(255, 255, 255, 0.02) !important;
  border: 2px dashed rgba(255, 255, 255, 0.15) !important;
  border-radius: 12px;
  transition: all 0.3s;
  padding: 40px 20px;
}

.upload-area :deep(.el-upload-dragger:hover) {
  border-color: #818cf8 !important;
  background: rgba(129, 140, 248, 0.05) !important;
}

.upload-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: rgba(255, 255, 255, 0.8);
  font-size: 16px;
}

.upload-icon {
  color: rgba(255, 255, 255, 0.4);
  transition: color 0.3s;
}

.upload-area :deep(.el-upload-dragger:hover) .upload-icon {
  color: #818cf8;
}

.upload-hint {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.4);
}

.file-details {
  display: flex;
  flex-direction: column;
}

.file-info-header {
  display: flex;
  align-items: center;
  gap: 15px;
  padding: 5px 0;
}

.file-icon {
  font-size: 36px;
  color: #818cf8;
}

.file-meta {
  flex: 1;
  min-width: 0;
}

.file-name {
  font-size: 16px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #ffffff;
}

.file-size {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
  margin-top: 4px;
}

.el-divider {
  border-top-color: rgba(255, 255, 255, 0.08);
  margin: 20px 0;
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 25px;
}

.settings-title {
  font-size: 14px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.8);
  margin: 0;
}

.range-radio-group {
  margin: 5px 0;
}

.range-radio-group :deep(.el-radio) {
  color: rgba(255, 255, 255, 0.7) !important;
}

.range-radio-group :deep(.el-radio.is-checked) {
  color: #818cf8 !important;
}

.range-radio-group :deep(.el-radio__input.is-checked .el-radio__inner) {
  border-color: #818cf8 !important;
  background: #818cf8 !important;
}

.range-inputs {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 5px;
}

.range-separator {
  color: rgba(255, 255, 255, 0.5);
  font-size: 13px;
}

.range-inputs :deep(.el-input-number--small) {
  width: 110px;
}

.range-inputs :deep(.el-input__wrapper) {
  background: rgba(255, 255, 255, 0.03) !important;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.1) inset !important;
}

.range-inputs :deep(.el-input__inner) {
  color: #ffffff !important;
}

.progress-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 20px 10px 10px 10px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.04);
  margin-bottom: 20px;
}

.progress-spinner {
  color: #818cf8;
}

.progress-message {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.7);
  text-align: center;
  min-height: 20px;
  animation: fadeIn 0.3s ease;
}

.action-buttons {
  display: flex;
  margin-top: 10px;
}

.action-btn {
  width: 100%;
  height: 50px;
  border-radius: 10px;
  font-size: 16px;
  font-weight: 500;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.el-button--primary {
  background: linear-gradient(135deg, #6366f1, #4f46e5) !important;
  border: none !important;
}

.el-button--primary:hover {
  background: linear-gradient(135deg, #818cf8, #6366f1) !important;
  box-shadow: 0 0 15px rgba(99, 102, 241, 0.4);
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: translateY(0); }
}

@media (max-width: 480px) {
  .card-wrap {
    padding: 18px 14px;
    border-radius: 12px;
  }
  .pdf-to-word-view {
    padding: 12px 8px 30px;
  }
}
</style>

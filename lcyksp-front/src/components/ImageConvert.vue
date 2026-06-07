<script setup>
/**
 * ImageConvert.vue — 高频图像格式转换站组件
 * 单选切换四种转换类型 → 选择文件 → 一键纯净转换 → 全自动下载
 */
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import axios from 'axios'

const file = ref(null)
const converting = ref(false)

// 四种转换类型
const convertTypes = [
  { label: 'PNG ↔ JPG',  value: 'png2jpg',  accept: '.png',          ext: 'jpg' },
  { label: 'WEBP → JPG', value: 'webp2jpg', accept: '.webp',         ext: 'jpg' },
  { label: 'HEIC → JPG', value: 'heic2jpg', accept: '.heic,.heif',   ext: 'jpg' },
  { label: '图片 → PDF', value: 'img2pdf',  accept: 'image/*',       ext: 'pdf' },
]

const selectedType = ref('png2jpg')

// 当前选中类型的配置
const currentType = computed(() =>
  convertTypes.find((t) => t.value === selectedType.value),
)

// 当前 accept 字符串
const acceptStr = computed(() => currentType.value?.accept || 'image/*')

// ---------- 文件变更 ----------
function handleFileChange(uploadFile) {
  file.value = uploadFile.raw
}

function handleRemove() {
  file.value = null
}

// ---------- 转换并下载 ----------
async function convertAndDownload() {
  if (!file.value) {
    ElMessage.warning('请先选择一张图片')
    return
  }

  converting.value = true
  try {
    const formData = new FormData()
    formData.append('image', file.value)
    formData.append('type', selectedType.value)

    const res = await axios.post('/api/convert/image', formData, {
      responseType: 'blob',
    })

    // 全自动触发下载
    const blob = new Blob([res.data])
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url

    const disposition = res.headers['content-disposition']
    let filename = file.value.name.replace(/\.[^.]+$/, '') || 'converted'
    if (disposition) {
      const match = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/)
      if (match) filename = match[1].replace(/['"]/g, '')
    }
    const ext = currentType.value?.ext || 'jpg'
    link.download = `${filename}.${ext}`

    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)

    ElMessage.success(`转换完成！已自动下载：${link.download}`)
  } catch (err) {
    console.error('转换失败:', err)
  } finally {
    converting.value = false
  }
}

// 转换类型切换时清除已选文件（避免不匹配）
function onTypeChange() {
  file.value = null
}
</script>

<template>
  <div class="convert-box">
    <!-- 转换类型单选 -->
    <el-radio-group
      v-model="selectedType"
      class="type-group"
      @change="onTypeChange"
    >
      <el-radio-button
        v-for="t in convertTypes"
        :key="t.value"
        :value="t.value"
        :label="t.label"
      />
    </el-radio-group>

    <!-- 文件选择 -->
    <el-upload
      drag
      :auto-upload="false"
      :show-file-list="true"
      :on-change="handleFileChange"
      :on-remove="handleRemove"
      :limit="1"
      :accept="acceptStr"
      :key="selectedType"
      :file-list="[]"
    >
      <el-icon class="upload-icon" :size="48"><UploadFilled /></el-icon>
      <div class="upload-text">
        拖拽文件到此处，或 <em>点击选择</em>
      </div>
      <template #tip>
        <div class="upload-tip">
          当前格式：{{ currentType?.label }}
          （{{ currentType?.value === 'img2pdf' ? '支持所有图片格式' : acceptStr }}）
        </div>
      </template>
    </el-upload>

    <!-- 转换按钮 -->
    <el-button
      type="primary"
      size="large"
      :loading="converting"
      :disabled="!file"
      class="convert-btn"
      @click="convertAndDownload"
    >
      <el-icon><MagicStick /></el-icon>
      {{ converting ? '转换中…' : '一键纯净转换' }}
    </el-button>
  </div>
</template>

<style scoped>
.convert-box {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.type-group {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  justify-content: center;
}

/* 暗黑模式下 radio-button 样式覆盖 */
:deep(.el-radio-button__inner) {
  border-color: var(--border-color);
  color: var(--text-secondary);
  background: var(--bg-ctrl);
}

:deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) {
  background: var(--accent-blue);
  color: #fff;
  border-color: var(--accent-blue);
  box-shadow: none;
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

.convert-btn {
  width: 100%;
  font-size: 1rem;
  letter-spacing: 1px;
}

:deep(.el-upload-dragger) {
  background: var(--bg-ctrl) !important;
  border: 1px dashed var(--border-color) !important;
  border-radius: 12px !important;
}

:deep(.el-upload-dragger:hover) {
  border-color: var(--accent-blue) !important;
}
</style>

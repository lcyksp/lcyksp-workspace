<script setup>
/**
 * ImageCompress.vue — 精准目标大小图片压缩组件
 * 极简交互：拖拽图片 + 三个科技感档位按钮 → 全自动触发下载
 */
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import axios from 'axios'
import { Close, PictureFilled, Refresh } from '@element-plus/icons-vue'

// ---------- 客户端预缩放：大于 5MB 的大图先用 Canvas 等比缩到 2048px ----------
const CLIENT_MAX_PX = 2048
const CLIENT_PRESCALE_THRESHOLD = 5 * 1024 * 1024 // 5MB

/**
 * 用 Canvas 在浏览器端等比缩放图片，返回新的 File 对象
 */
function scaleDownImage(file, maxDimension) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)

    img.onload = () => {
      URL.revokeObjectURL(url)

      let { width, height } = img
      // 只有任意边超过阈值才缩放
      if (width <= maxDimension && height <= maxDimension) {
        // 不需要缩放，直接回传原文件
        return resolve(file)
      }

      // 等比例计算新尺寸
      if (width > height) {
        if (width > maxDimension) {
          height = Math.round(height * (maxDimension / width))
          width = maxDimension
        }
      } else {
        if (height > maxDimension) {
          width = Math.round(width * (maxDimension / height))
          height = maxDimension
        }
      }

      // 绘制到 Canvas
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, width, height)

      // 转为 Blob，尽量保持原格式
      const mimeType = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
      const quality = file.type === 'image/png' ? undefined : 0.92
      canvas.toBlob((blob) => {
        if (!blob) return reject(new Error('Canvas 缩放失败'))
        // 构造新 File，沿用原名但标记 scaled
        const newFile = new File([blob], file.name, { type: blob.type })
        resolve(newFile)
      }, mimeType, quality)
    }

    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片加载失败'))
    }

    img.src = url
  })
}

const file = ref(null)
const previewUrl = ref(null)
const loadingKey = ref('') // 当前正在加载的档位标识
const fileKey = ref(0)      // 强制 upload 组件重新渲染

const hasFile = computed(() => !!file.value)
const hasPreview = computed(() => !!previewUrl.value)

// 三个档位定义
const tiers = [
  { key: '500kb', label: '压制到 500KB 以内', icon: '⚡', color: '#e67e22' },
  { key: '1mb',   label: '压制到 1MB 以内',   icon: '⚡', color: '#f1c40f' },
  { key: '2mb',   label: '压制到 2MB 以内',   icon: '⚡', color: '#2ecc71' },
]

// ---------- 文件变更（>5MB 自动客户端预缩放）----------
async function handleFileChange(uploadFile) {
  let rawFile = uploadFile.raw

  // 大于 5MB 的大图：先在客户端用 Canvas 等比缩放，降低服务器压力
  if (rawFile && rawFile.size > CLIENT_PRESCALE_THRESHOLD) {
    ElMessage.info('正在客户端预缩放大图…')
    try {
      const scaled = await scaleDownImage(rawFile, CLIENT_MAX_PX)
      if (scaled !== rawFile) {
        const saved = rawFile.size / 1024 / 1024
        const after = scaled.size / 1024 / 1024
        ElMessage.success(`客户端预缩放完成：${saved.toFixed(1)}MB → ${after.toFixed(1)}MB`)
        rawFile = scaled
      } else {
        ElMessage.info('图片分辨率未超标，无需预缩放')
      }
    } catch {
      ElMessage.warning('客户端预缩放失败，使用原图上传')
    }
  }

  file.value = rawFile
  fileKey.value++
  // 生成本地缩略图预览
  if (file.value) {
    if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
    previewUrl.value = URL.createObjectURL(file.value)
  }
}

function handleRemove() {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = null
  file.value = null
}

// ---------- 压缩并下载 ----------
async function compressAndDownload(targetSize) {
  if (!file.value) {
    ElMessage.warning('请先选择一张图片')
    return
  }

  loadingKey.value = targetSize
  try {
    const formData = new FormData()
    formData.append('image', file.value)
    formData.append('targetSize', targetSize)

    const res = await axios.post('/api/compress/target-size', formData, {
      responseType: 'blob',
    })

    // 全自动触发下载
    const blob = new Blob([res.data])
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    // 从 Content-Disposition 取文件名，或自动生成
    const disposition = res.headers['content-disposition']
    let filename = `compressed-${file.value.name || 'image'}`
    if (disposition) {
      const match = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/)
      if (match) filename = match[1].replace(/['"]/g, '')
    }
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)

    ElMessage.success(`压缩完成！已自动下载：${filename}`)
  } catch (err) {
    // 拦截器已处理错误提示
    console.error('压缩失败:', err)
  } finally {
    loadingKey.value = ''
  }
}
</script>

<template>
  <div class="compress-box">
    <!-- 拖拽选择区 -->
    <el-upload
      drag
      :auto-upload="false"
      :show-file-list="false"
      :on-change="handleFileChange"
      :on-remove="handleRemove"
      :limit="1"
      accept="image/*"
      :file-list="[]"
      class="compress-upload"
      :key="'upload-' + fileKey"
    >
      <!-- 已选择图片 → 显示缩略图预览 -->
      <template v-if="hasPreview">
        <div class="preview-container">
          <img :src="previewUrl" class="preview-img" alt="preview" />
          <div class="preview-overlay">
            <el-icon :size="28"><Refresh /></el-icon>
            <span>点击更换图片</span>
          </div>
        </div>
      </template>
      <!-- 未选择 → 默认图标 -->
      <template v-else>
        <el-icon class="upload-icon" :size="48"><PictureFilled /></el-icon>
        <div class="upload-text">
          拖拽图片到此处，或 <em>点击选择</em>
        </div>
      </template>
      <template #tip>
        <div class="upload-tip">支持 JPEG / PNG / WebP / TIFF</div>
      </template>
    </el-upload>

    <!-- 已选择文件时显示清除按钮 -->
    <el-button
      v-if="hasFile"
      text
      size="small"
      class="clear-btn"
      @click="handleRemove"
    >
      <el-icon><Close /></el-icon> 清除选择
    </el-button>

    <!-- 三个科技感档位按钮 -->
    <div class="tier-buttons">
      <el-button
        v-for="tier in tiers"
        :key="tier.key"
        :style="{ '--tier-color': tier.color }"
        class="tier-btn"
        size="large"
        :disabled="!hasFile"
        :loading="loadingKey === tier.key"
        @click="compressAndDownload(tier.key)"
      >
        <span class="tier-icon">{{ tier.icon }}</span>
        <span class="tier-label">{{ tier.label }}</span>
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.compress-box {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.compress-upload {
  width: 100%;
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

/* 缩略图预览 */
.preview-container {
  position: relative;
  width: 100%;
  height: 180px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 8px;
}

.preview-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  transition: transform 0.3s ease;
}

.preview-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: rgba(13, 18, 35, 0.56);
  opacity: 0;
  transition: opacity 0.25s;
  color: #eef3ff;
  font-size: 0.85rem;
  cursor: pointer;
}

.preview-container:hover .preview-img {
  transform: scale(1.03);
}

.preview-container:hover .preview-overlay {
  opacity: 1;
}

.tier-buttons {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.tier-btn {
  width: 100% !important;
  margin-left: 0 !important;
  margin-right: 0 !important;
  padding-left: 8px !important;
  padding-right: 8px !important;
  height: 56px;
  font-size: 1rem;
  border: 2px solid var(--tier-color);
  color: var(--tier-color);
  background: color-mix(in srgb, var(--bg-card) 92%, transparent);
  border-radius: 10px;
  transition: all 0.25s;
  letter-spacing: 1px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.tier-btn :deep(.el-button__inner) {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

.tier-btn:not(:disabled):hover {
  background: var(--tier-color);
  color: #08111f;
  transform: scale(1.02);
  box-shadow: 0 0 20px color-mix(in srgb, var(--tier-color) 50%, transparent);
}

.tier-btn:disabled {
  opacity: 0.4;
  border-color: var(--border-color);
  color: var(--text-muted);
}

.tier-icon {
  margin-right: 6px;
  font-size: 1.2rem;
}

.tier-label {
  font-weight: 600;
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

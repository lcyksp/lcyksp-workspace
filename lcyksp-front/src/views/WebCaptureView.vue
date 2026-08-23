<script setup>
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { 
  Link, 
  Picture, 
  Document, 
  Download, 
  Clock,
  Monitor,
  Iphone,
  Coordinate
} from '@element-plus/icons-vue'
import axios from 'axios'

const webpageUrl = ref('')
const format = ref('image') // 'image' or 'pdf'
const viewportWidth = ref(1280) // 1920 (Desktop), 1280 (Standard), 375 (Mobile)
const renderDelay = ref(2) // seconds
const capturing = ref(false)

async function handleCapture() {
  const url = webpageUrl.value.trim()
  if (!url) {
    ElMessage.warning('请输入要捕获的网页链接')
    return
  }

  capturing.value = true
  try {
    const response = await axios({
      method: 'post',
      url: '/api/convert/web-capture',
      data: {
        url: url,
        format: format.value,
        width: viewportWidth.value,
        delay: renderDelay.value * 1000
      },
      responseType: 'blob',
      timeout: 90000 // 90 seconds timeout for heavy pages
    })

    const blobType = format.value === 'pdf' ? 'application/pdf' : 'image/png'
    const ext = format.value === 'pdf' ? 'pdf' : 'png'
    
    const blob = new Blob([response.data], { type: blobType })
    
    // Parse domain name for filename
    let domain = url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0] || 'webpage'
    const safeDomain = domain.replace(/[^a-z0-9-]/gi, '_')
    
    const downloadUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = downloadUrl
    link.download = `${safeDomain}_capture.${ext}`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(downloadUrl)

    ElMessage.success('网页截取成功！已开始下载文件')
  } catch (err) {
    console.error(err)
    let errMsg = '捕获失败，请确认网址是否正确且支持公网访问'
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
    capturing.value = false
  }
}
</script>

<template>
  <div class="web-capture-view">
    <div class="page-header">
      <h2 class="page-title"><span class="title-icon">📸</span> 网页截图与转 PDF</h2>
      <p class="page-desc">输入任意公开网页链接，一键捕获并下载为高清晰度长图（PNG）或标准的 A4 PDF 文件。完美还原页面样式。</p>
    </div>

    <div class="card-wrap">
      <!-- 链接输入 -->
      <div class="form-item">
        <label class="form-label">网页链接 (URL)</label>
        <el-input 
          v-model="webpageUrl" 
          placeholder="例如: https://github.com 或 baidu.com" 
          size="large"
          class="url-input"
          :prefix-icon="Link"
          clearable
          @keyup.enter="handleCapture"
          :disabled="capturing"
        />
      </div>

      <!-- 导出格式选择 -->
      <div class="form-item mt-20">
        <label class="form-label">导出格式</label>
        <div class="format-options">
          <div 
            class="format-card" 
            :class="{ active: format === 'image' }" 
            @click="format = 'image'"
          >
            <el-icon class="format-icon"><Picture /></el-icon>
            <div class="format-meta">
              <span class="format-title">高清晰度长图 (PNG)</span>
              <span class="format-desc">截取网页完整内容，生成整张长图</span>
            </div>
          </div>

          <div 
            class="format-card" 
            :class="{ active: format === 'pdf' }" 
            @click="format = 'pdf'"
          >
            <el-icon class="format-icon"><Document /></el-icon>
            <div class="format-meta">
              <span class="format-title">标准 PDF 文档 (A4)</span>
              <span class="format-desc">将网页按 A4 纸张排版生成 PDF 电子书</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 高级设置 -->
      <div class="settings-section mt-24">
        <h4 class="settings-title">
          <el-icon class="title-icon-el"><Coordinate /></el-icon>
          高级捕获设置
        </h4>

        <div class="settings-grid">
          <!-- 网页模拟宽度 -->
          <div class="settings-row">
            <span class="settings-label">模拟视口：</span>
            <el-radio-group v-model="viewportWidth" size="default" :disabled="capturing" class="theme-radios">
              <el-radio-button :value="1920">
                <el-icon class="radio-icon"><Monitor /></el-icon>电脑端 (1920px)
              </el-radio-button>
              <el-radio-button :value="1280">
                <el-icon class="radio-icon"><Monitor /></el-icon>平板端 (1280px)
              </el-radio-button>
              <el-radio-button :value="375">
                <el-icon class="radio-icon"><Iphone /></el-icon>手机端 (375px)
              </el-radio-button>
            </el-radio-group>
          </div>

          <!-- 渲染延迟 -->
          <div class="settings-row mt-16">
            <span class="settings-label">渲染等待：</span>
            <div class="slider-wrap">
              <el-slider 
                v-model="renderDelay" 
                :min="0" 
                :max="5" 
                :step="1"
                :disabled="capturing"
                show-stops
                class="delay-slider"
              />
              <span class="slider-hint">
                <el-icon><Clock /></el-icon>
                网页载入后额外等待 {{ renderDelay }} 秒（用以渲染延迟动效或懒加载图片）
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Action Button -->
      <div class="action-wrap mt-32">
        <el-button 
          type="primary" 
          size="large" 
          class="capture-btn"
          :loading="capturing"
          @click="handleCapture"
        >
          <el-icon v-if="!capturing"><Download /></el-icon>
          <span>{{ capturing ? '正在载入并捕获网页，请稍候...' : '开始截取并下载' }}</span>
        </el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.web-capture-view {
  max-width: 680px;
  margin: 0 auto;
  padding: 20px 16px 40px;
  color: #ffffff;
}

.page-header {
  margin-bottom: 24px;
}

.page-title {
  font-size: 1.8rem;
  font-weight: 600;
  margin: 0 0 6px 0;
  display: flex;
  align-items: center;
  gap: 10px;
  background: linear-gradient(135deg, #a5b4fc, #818cf8);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.title-icon {
  -webkit-text-fill-color: initial;
}

.page-desc {
  font-size: 0.9rem;
  color: rgba(255, 255, 255, 0.6);
  margin: 0;
  line-height: 1.5;
}

.card-wrap {
  background: rgba(22, 22, 42, 0.6);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
  padding: 28px;
  box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
}

.form-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.form-label {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.85);
  font-weight: 500;
}

.url-input :deep(.el-input__wrapper) {
  background: rgba(255, 255, 255, 0.03) !important;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.1) inset !important;
  border-radius: 10px;
  padding: 8px 12px;
}

.url-input :deep(.el-input__inner) {
  color: #ffffff !important;
  font-size: 15px;
}

/* Format Option Cards */
.format-options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-top: 4px;
}

.format-card {
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 16px;
  background: rgba(255, 255, 255, 0.01);
  cursor: pointer;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  transition: all 0.25s ease;
}

.format-card:hover {
  border-color: rgba(129, 140, 248, 0.4);
  background: rgba(129, 140, 248, 0.03);
  transform: translateY(-2px);
}

.format-card.active {
  border-color: #818cf8;
  background: rgba(129, 140, 248, 0.08);
  box-shadow: 0 0 16px rgba(129, 140, 248, 0.15);
}

.format-icon {
  font-size: 24px;
  color: rgba(255, 255, 255, 0.4);
  margin-top: 2px;
  transition: color 0.2s;
}

.format-card.active .format-icon {
  color: #818cf8;
}

.format-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.format-title {
  font-size: 14px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.9);
}

.format-desc {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
  line-height: 1.4;
}

/* Settings Section */
.settings-section {
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding-top: 20px;
}

.settings-title {
  font-size: 14px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.85);
  margin: 0 0 16px 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.title-icon-el {
  color: #818cf8;
}

.settings-grid {
  display: flex;
  flex-direction: column;
  gap: 16px;
  background: rgba(255, 255, 255, 0.01);
  padding: 18px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.04);
}

.settings-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.settings-label {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.65);
  min-width: 80px;
}

/* Radio Override */
.theme-radios :deep(.el-radio-button__inner) {
  background: rgba(255, 255, 255, 0.02) !important;
  border-color: rgba(255, 255, 255, 0.1) !important;
  color: rgba(255, 255, 255, 0.7) !important;
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.theme-radios :deep(.el-radio-button__inner:hover) {
  color: #818cf8 !important;
}

.theme-radios :deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) {
  background: #818cf8 !important;
  border-color: #818cf8 !important;
  color: #ffffff !important;
  box-shadow: -1px 0 0 0 #818cf8 !important;
}

.radio-icon {
  font-size: 14px;
}

/* Delay Slider & Hint */
.slider-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 260px;
}

.delay-slider {
  width: 100%;
}

.slider-hint {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.35);
  display: flex;
  align-items: center;
  gap: 4px;
}

/* Action Wrap */
.action-wrap {
  display: flex;
}

.capture-btn {
  width: 100%;
  height: 48px;
  border-radius: 10px;
  font-size: 15px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: linear-gradient(135deg, #6366f1, #4f46e5) !important;
  border: none !important;
  transition: all 0.3s ease;
  box-shadow: 0 4px 14px rgba(99, 102, 241, 0.3);
}

.capture-btn:hover:not(:disabled) {
  background: linear-gradient(135deg, #818cf8, #6366f1) !important;
  box-shadow: 0 6px 20px rgba(99, 102, 241, 0.5);
  transform: translateY(-1px);
}

.capture-btn:disabled {
  opacity: 0.65;
}

.mt-20 { margin-top: 20px; }
.mt-24 { margin-top: 24px; }
.mt-16 { margin-top: 16px; }
.mt-32 { margin-top: 32px; }

@media (max-width: 768px) {
  .web-capture-view {
    padding: 12px 10px 30px;
  }
  .card-wrap {
    padding: 18px;
    border-radius: 12px;
  }
  .format-options {
    grid-template-columns: 1fr;
    gap: 12px;
  }
  .settings-grid {
    padding: 12px;
  }
}
</style>

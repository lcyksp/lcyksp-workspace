<script setup>
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { 
  FolderOpened, 
  UploadFilled, 
  Delete, 
  Download, 
  Loading, 
  Document, 
  Folder, 
  Search,
  RefreshLeft
} from '@element-plus/icons-vue'
import JSZip from 'jszip'

// Active tab
const activeTab = ref('compress')

// ================== COMPRESS STATE ==================
const compressFileList = ref([])
const zipFileName = ref('archive')
const compressionLevel = ref(6)
const compressing = ref(false)
const compressProgress = ref(0)

// ================== EXTRACT STATE ==================
const extractFile = ref(null)
const extractFileList = ref([])
const extracting = ref(false)
const searchQuery = ref('')

// ================== COMPRESS METHODS ==================
function handleCompressFileChange(uploadFile) {
  const raw = uploadFile.raw
  if (!raw) return
  
  if (compressFileList.value.some(item => item.name === raw.name && item.size === raw.size)) {
    ElMessage.warning('同名且大小一致的文件已在列表中')
    return
  }
  
  compressFileList.value.push({
    id: Date.now() + Math.random(),
    name: raw.name,
    size: raw.size,
    rawFile: raw,
  })
}

function removeCompressFile(index) {
  compressFileList.value.splice(index, 1)
}

function clearCompressList() {
  compressFileList.value = []
  compressProgress.value = 0
}

async function handleGenerateZip() {
  if (compressFileList.value.length === 0) {
    ElMessage.warning('请至少添加一个文件进行压缩')
    return
  }
  
  compressing.value = true
  compressProgress.value = 0
  
  try {
    const zip = new JSZip()
    
    compressFileList.value.forEach(file => {
      zip.file(file.name, file.rawFile)
    })
    
    const content = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: {
        level: compressionLevel.value
      }
    }, (metadata) => {
      compressProgress.value = Math.round(metadata.percent)
    })
    
    const url = URL.createObjectURL(content)
    const link = document.createElement('a')
    link.href = url
    
    let finalName = zipFileName.value.trim() || 'archive'
    if (!finalName.toLowerCase().endsWith('.zip')) {
      finalName += '.zip'
    }
    
    link.download = finalName
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    
    ElMessage.success('ZIP 压缩文件生成成功，已开始下载！')
  } catch (err) {
    console.error(err)
    ElMessage.error('压缩生成失败：' + err.message)
  } finally {
    compressing.value = false
  }
}

// ================== EXTRACT METHODS ==================
async function handleExtractFileChange(uploadFile) {
  const raw = uploadFile.raw
  if (!raw) return
  
  extractFileList.value = []
  extracting.value = true
  
  try {
    const arrayBuffer = await raw.arrayBuffer()
    const zip = await JSZip.loadAsync(arrayBuffer)
    
    const parsedList = []
    zip.forEach((relativePath, file) => {
      let size = 0
      if (file._data && typeof file._data.uncompressedSize !== 'undefined') {
        size = file._data.uncompressedSize
      }
      
      parsedList.push({
        name: file.name,
        dir: file.dir,
        size: size,
        relativePath: relativePath,
        zipObject: file
      })
    })
    
    extractFile.value = {
      name: raw.name,
      size: formatBytes(raw.size)
    }
    extractFileList.value = parsedList
    ElMessage.success('ZIP 文件解析成功！')
  } catch (err) {
    console.error(err)
    ElMessage.error('解析 ZIP 文件失败：' + err.message)
    extractFile.value = null
    extractFileList.value = []
  } finally {
    extracting.value = false
  }
}

async function extractSingleFile(fileItem) {
  if (fileItem.dir) return
  
  try {
    const blob = await fileItem.zipObject.async('blob')
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    
    const simpleName = fileItem.name.split('/').pop() || 'extracted_file'
    link.download = simpleName
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    
    ElMessage.success(`成功解压并下载: ${simpleName}`)
  } catch (err) {
    ElMessage.error('解压单个文件失败: ' + err.message)
  }
}

async function extractAllFiles() {
  const filesOnly = extractFileList.value.filter(item => !item.dir)
  if (filesOnly.length === 0) {
    ElMessage.warning('该压缩包内没有可解压的文件')
    return
  }
  
  ElMessage.info(`开始解压并导出共 ${filesOnly.length} 个文件，请允许浏览器弹出下载多个文件`)
  
  for (const item of filesOnly) {
    await extractSingleFile(item)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

function handleResetExtract() {
  extractFile.value = null
  extractFileList.value = []
  searchQuery.value = ''
}

// ================== HELPERS ==================
function formatBytes(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

const filteredExtractList = computed(() => {
  if (!searchQuery.value.trim()) return extractFileList.value
  const query = searchQuery.value.toLowerCase()
  return extractFileList.value.filter(item => item.name.toLowerCase().includes(query))
})
</script>

<template>
  <div class="zip-tool-view">
    <div class="page-header">
      <h2 class="page-title"><span class="title-icon">📦</span> 在线压缩解压</h2>
      <p class="page-desc">纯前端运行的 ZIP 压缩与解压小工具。完全在本地浏览器沙盒执行，不上传服务器，保护隐私且不占流量。</p>
    </div>

    <el-tabs v-model="activeTab" type="card" class="theme-tabs">
      <!-- ================== TAB 1: 在线压缩 ================== -->
      <el-tab-pane label="在线加密/无损压缩" name="compress">
        <el-row :gutter="20">
          <!-- 左侧上传控制台 -->
          <el-col :xs="24" :md="12">
            <div class="card-wrap">
              <el-upload
                drag
                multiple
                :auto-upload="false"
                :show-file-list="false"
                :on-change="handleCompressFileChange"
                class="upload-area"
              >
                <div class="upload-placeholder">
                  <el-icon :size="48" class="upload-icon"><UploadFilled /></el-icon>
                  <span>拖拽多个文件到此处，或点击添加</span>
                  <span class="upload-hint">支持任何格式的多个文件打包</span>
                </div>
              </el-upload>

              <div class="settings-section mt-20" v-if="compressFileList.length > 0">
                <h4 class="settings-title">压缩设置</h4>
                
                <div class="settings-row">
                  <span class="settings-label">压缩包名称：</span>
                  <el-input v-model="zipFileName" placeholder="请输入名称" class="name-input">
                    <template #append>.zip</template>
                  </el-input>
                </div>

                <div class="settings-row mt-10">
                  <span class="settings-label">压缩级别 ({{ compressionLevel }})：</span>
                  <el-slider 
                    v-model="compressionLevel" 
                    :min="1" 
                    :max="9" 
                    :step="1"
                    show-stops
                  />
                </div>
              </div>

              <!-- Generating Progress -->
              <div v-if="compressing" class="progress-wrap">
                <el-progress 
                  type="line" 
                  :percentage="compressProgress" 
                  status="success" 
                  class="progress-bar-el"
                />
                <div class="progress-message">正在本地打包并进行 DEFLATE 压缩... {{ compressProgress }}%</div>
              </div>

              <div class="action-buttons mt-20" v-if="compressFileList.length > 0">
                <el-button 
                  type="primary" 
                  size="large" 
                  class="action-btn"
                  :loading="compressing"
                  @click="handleGenerateZip"
                >
                  <el-icon><Download /></el-icon>
                  <span>开始压缩并下载 ZIP</span>
                </el-button>
              </div>
            </div>
          </el-col>

          <!-- 右侧待压缩文件列表 -->
          <el-col :xs="24" :md="12">
            <div class="list-card">
              <div class="list-header">
                <span>待压缩文件列表 ({{ compressFileList.length }})</span>
                <el-button 
                  v-if="compressFileList.length > 0"
                  size="small" 
                  type="danger" 
                  plain 
                  :icon="Delete"
                  @click="clearCompressList"
                >
                  清空列表
                </el-button>
              </div>

              <div class="list-body">
                <div v-if="compressFileList.length === 0" class="empty-list">
                  <el-icon :size="36"><Document /></el-icon>
                  <span>待压缩列表为空，请在左侧添加文件</span>
                </div>
                <div v-else class="file-rows">
                  <div 
                    v-for="(item, idx) in compressFileList" 
                    :key="item.id" 
                    class="file-row-item"
                  >
                    <el-icon class="file-icon"><Document /></el-icon>
                    <span class="file-name" :title="item.name">{{ item.name }}</span>
                    <span class="file-size">{{ formatBytes(item.size) }}</span>
                    <el-button 
                      type="danger" 
                      size="small" 
                      :icon="Delete" 
                      circle 
                      @click="removeCompressFile(idx)"
                    />
                  </div>
                </div>
              </div>
            </div>
          </el-col>
        </el-row>
      </el-tab-pane>

      <!-- ================== TAB 2: 在线解压 ================== -->
      <el-tab-pane label="在线快捷解压" name="extract">
        <el-row :gutter="20">
          <!-- 左侧解压操作台 -->
          <el-col :xs="24" :md="8">
            <div class="card-wrap">
              <el-upload
                v-if="!extractFile"
                drag
                :auto-upload="false"
                :show-file-list="false"
                :on-change="handleExtractFileChange"
                accept=".zip"
                class="upload-area"
              >
                <div class="upload-placeholder">
                  <el-icon :size="48" class="upload-icon"><FolderOpened /></el-icon>
                  <span>选择或拖入要解压的 ZIP 文件</span>
                  <span class="upload-hint">仅在前端解析，不消耗任何流量</span>
                </div>
              </el-upload>

              <div v-else class="file-meta-card">
                <div class="meta-header">
                  <el-icon class="zip-icon"><FolderOpened /></el-icon>
                  <div class="meta-info">
                    <div class="meta-name" :title="extractFile.name">{{ extractFile.name }}</div>
                    <div class="meta-size">{{ extractFile.size }}</div>
                  </div>
                  <el-button 
                    circle 
                    type="danger" 
                    size="small" 
                    :icon="RefreshLeft" 
                    @click="handleResetExtract"
                    title="重新选择"
                  />
                </div>

                <el-divider></el-divider>

                <div class="action-buttons">
                  <el-button 
                    type="primary" 
                    size="large" 
                    class="action-btn"
                    @click="extractAllFiles"
                  >
                    <el-icon><Download /></el-icon>
                    <span>解压并下载全部文件</span>
                  </el-button>
                </div>
              </div>
            </div>
          </el-col>

          <!-- 右侧 ZIP 内容名册 -->
          <el-col :xs="24" :md="16">
            <div class="list-card">
              <div class="list-header flex-header">
                <span>ZIP 内部文件预览 ({{ extractFileList.length }})</span>
                <el-input
                  v-if="extractFileList.length > 0"
                  v-model="searchQuery"
                  placeholder="搜索包内文件..."
                  :suffix-icon="Search"
                  size="small"
                  class="search-input"
                  clearable
                />
              </div>

              <div class="list-body">
                <div v-if="extractFileList.length === 0" class="empty-list">
                  <el-icon :size="36"><FolderOpened /></el-icon>
                  <span>包内列表为空，请在左侧加载 ZIP 文件</span>
                </div>
                <div v-else class="file-rows">
                  <div 
                    v-for="(item, idx) in filteredExtractList" 
                    :key="idx" 
                    class="file-row-item"
                    :class="{ 'is-dir': item.dir }"
                  >
                    <el-icon class="file-icon"><Folder v-if="item.dir" /><Document v-else /></el-icon>
                    <span class="file-name" :title="item.name">{{ item.name }}</span>
                    <span class="file-size" v-if="!item.dir">{{ formatBytes(item.size) }}</span>
                    <span class="file-size dir-tag" v-else>目录</span>
                    <el-button 
                      v-if="!item.dir"
                      type="primary" 
                      size="small" 
                      :icon="Download" 
                      circle 
                      @click="extractSingleFile(item)"
                      title="解压此文件"
                    />
                  </div>
                </div>
              </div>
            </div>
          </el-col>
        </el-row>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.zip-tool-view {
  max-width: 1200px;
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
  padding: 24px;
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
  padding: 36px 20px;
}

.upload-area :deep(.el-upload-dragger:hover) {
  border-color: #818cf8 !important;
  background: rgba(129, 140, 248, 0.05) !important;
}

.upload-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  color: rgba(255, 255, 255, 0.8);
  font-size: 15px;
}

.upload-icon {
  color: rgba(255, 255, 255, 0.35);
}

.upload-area :deep(.el-upload-dragger:hover) .upload-icon {
  color: #818cf8;
}

.upload-hint {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.4);
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.settings-title {
  font-size: 14px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.85);
  margin: 0 0 4px 0;
}

.settings-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.settings-label {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.6);
  min-width: 90px;
}

.name-input {
  flex: 1;
}

.name-input :deep(.el-input__wrapper) {
  background: rgba(255, 255, 255, 0.03) !important;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.1) inset !important;
}

.name-input :deep(.el-input-group__append) {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.6);
}

.name-input :deep(.el-input__inner) {
  color: #ffffff !important;
}

.settings-row :deep(.el-slider) {
  flex: 1;
}

/* Progress Wrap */
.progress-wrap {
  margin-top: 20px;
  padding: 16px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.04);
}

.progress-bar-el {
  width: 100%;
}

.progress-message {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
  margin-top: 8px;
  text-align: center;
}

/* List Card */
.list-card {
  background: rgba(22, 22, 42, 0.6);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
  box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 380px;
}

.list-header {
  padding: 16px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.85);
  font-weight: 500;
  font-size: 14px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.flex-header {
  gap: 12px;
  flex-wrap: wrap;
}

.search-input {
  width: 200px;
}

.search-input :deep(.el-input__wrapper) {
  background: rgba(255, 255, 255, 0.03) !important;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.1) inset !important;
}

.search-input :deep(.el-input__inner) {
  color: #ffffff;
}

.list-body {
  flex: 1;
  padding: 10px 0;
  overflow-y: auto;
  max-height: 480px;
}

.empty-list {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 80px 20px;
  color: rgba(255, 255, 255, 0.3);
  font-size: 13px;
}

.file-rows {
  display: flex;
  flex-direction: column;
}

.file-row-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
  transition: background 0.2s;
}

.file-row-item:hover {
  background: rgba(255, 255, 255, 0.02);
}

.file-row-item:last-child {
  border-bottom: none;
}

.file-row-item.is-dir {
  opacity: 0.75;
}

.file-icon {
  font-size: 18px;
  color: #818cf8;
}

.is-dir .file-icon {
  color: #fbbf24;
}

.file-name {
  flex: 1;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.85);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-size {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.4);
  font-family: monospace;
}

.dir-tag {
  color: #fbbf24;
  font-family: inherit;
}

/* File Meta Card */
.file-meta-card {
  display: flex;
  flex-direction: column;
}

.meta-header {
  display: flex;
  align-items: center;
  gap: 12px;
}

.zip-icon {
  font-size: 32px;
  color: #fbbf24;
}

.meta-info {
  flex: 1;
  min-width: 0;
}

.meta-name {
  font-size: 14px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #ffffff;
}

.meta-size {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
  margin-top: 4px;
}

.el-divider {
  border-top-color: rgba(255, 255, 255, 0.08);
  margin: 16px 0;
}

.action-buttons {
  display: flex;
}

.action-btn {
  width: 100%;
  height: 44px;
  border-radius: 8px;
  font-size: 14px;
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

.mt-20 {
  margin-top: 20px;
}

.mt-10 {
  margin-top: 10px;
}

/* Responsive Media Queries */
@media (max-width: 768px) {
  .zip-tool-view {
    padding: 12px 8px 30px;
  }
  
  .card-wrap {
    padding: 16px;
    border-radius: 12px;
  }
  
  .list-card {
    margin-top: 16px;
    min-height: 280px;
    border-radius: 12px;
  }
  
  .upload-area :deep(.el-upload-dragger) {
    padding: 24px 10px;
  }
  
  .upload-placeholder {
    font-size: 14px;
  }
  
  .file-row-item {
    padding: 8px 12px;
    gap: 8px;
  }
  
  .search-input {
    width: 100%;
  }
}
</style>

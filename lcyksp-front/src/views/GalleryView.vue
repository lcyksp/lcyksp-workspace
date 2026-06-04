<script setup>
/**
 * GalleryView.vue V5.0 — 家庭照片共享流 + 成员管理
 * 响应式照片墙 + 上传 + 悬停下载 + 全屏预览 + 家庭组成员管理
 * 动态垃圾桶控制：仅 admin 或上传者可见删除按钮
 */
import { ref, computed, onMounted, nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import axios from 'axios'

const photos = ref([])
const loading = ref(false)
const uploadDialogVisible = ref(false)
const uploadFile = ref(null)
const uploading = ref(false)
const previewSrcList = ref([])
const previewVisible = ref(false)

// ---------- 家庭组 ----------
const membersPanelOpen = ref(false)
const members = ref([])
const groupName = ref('')
const addMemberUsername = ref('')
const addingMember = ref(false)

// ---------- 当前用户 ----------
const currentUser = computed(() => {
  try {
    const raw = localStorage.getItem('lcyksp_user')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
})

const isAdmin = computed(() => currentUser.value?.role === 'admin')

// ---------- 判断可删除 ----------
function canDelete(photo) {
  if (!currentUser.value) return false
  if (isAdmin.value) return true
  return currentUser.value.id === photo.uploaderId
}

// ---------- 加载照片 ----------
async function loadPhotos() {
  loading.value = true
  try {
    const res = await axios.get('/api/gallery/photos')
    photos.value = res.data.photos
  } catch (err) {
    console.error('加载相册失败:', err)
  } finally {
    loading.value = false
  }
}

// ---------- 加载家庭成员 ----------
async function loadMembers() {
  try {
    const res = await axios.get('/api/gallery/family/members')
    members.value = res.data.members || []
    groupName.value = res.data.groupName || ''
  } catch (err) {
    console.error('加载成员列表失败:', err)
  }
}

// ---------- 添加成员 ----------
async function handleAddMember() {
  const username = addMemberUsername.value.trim()
  if (!username) {
    ElMessage.warning('请输入要添加的用户名')
    return
  }
  if (username === currentUser.value?.username) {
    ElMessage.warning('不能将自己添加为成员')
    return
  }

  addingMember.value = true
  try {
    await axios.post('/api/gallery/family/members', { username })
    ElMessage.success(`用户「${username}」已加入家庭组`)
    addMemberUsername.value = ''
    loadMembers()
    loadPhotos()
  } catch (err) {
    // 拦截器已处理
  } finally {
    addingMember.value = false
  }
}

// ---------- 移除成员 ----------
async function handleRemoveMember(member) {
  if (member.id === currentUser.value?.id) {
    ElMessage.warning('不能将自己移出家庭组')
    return
  }
  try {
    await ElMessageBox.confirm(
      `确定将「${member.username}」移出家庭组吗？`,
      '移除成员',
      { confirmButtonText: '移除', cancelButtonText: '取消', type: 'warning', confirmButtonClass: 'el-button--danger' },
    )
    await axios.delete(`/api/gallery/family/members/${member.id}`)
    ElMessage.success(`已移除「${member.username}」`)
    loadMembers()
    loadPhotos()
  } catch (err) {
    if (err !== 'cancel') ElMessage.error('移除失败')
  }
}

// ---------- 全屏预览 ----------
function openPreview(photo) {
  previewSrcList.value = photos.value.map((p) => p.url)
  previewVisible.value = true
}

// ---------- 下载 ----------
function downloadPhoto(photo) {
  const link = document.createElement('a')
  link.href = photo.url
  link.download = photo.name
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

// ---------- 删除 ----------
async function deletePhoto(photo) {
  try {
    await ElMessageBox.confirm(`确定要删除「${photo.name}」吗？此操作不可撤销。`, '确认删除', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
      confirmButtonClass: 'el-button--danger',
    })
    await axios.delete(`/api/gallery/file/${photo.id}`)
    ElMessage.success('删除成功')
    loadPhotos()
  } catch (err) {
    if (err !== 'cancel') {
      console.error('删除失败:', err)
    }
  }
}

// ---------- 上传 ----------
function handleUploadChange(file) {
  uploadFile.value = file.raw
}

async function submitUpload() {
  if (!uploadFile.value) {
    ElMessage.warning('请选择一张照片')
    return
  }
  uploading.value = true
  try {
    const formData = new FormData()
    formData.append('photo', uploadFile.value)
    await axios.post('/api/gallery/upload', formData)
    ElMessage.success('上传成功！')
    uploadDialogVisible.value = false
    uploadFile.value = null
    loadPhotos()
  } catch (err) {
    console.error('上传失败:', err)
  } finally {
    uploading.value = false
  }
}

onMounted(() => {
  loadPhotos()
  loadMembers()
})
</script>

<template>
  <div class="gallery-view">
    <!-- 页头 -->
    <div class="gallery-header">
      <div>
        <h2 class="page-title"><span class="title-icon">🏠</span> 家庭共享相册</h2>
        <p class="page-desc">
          {{ currentUser ? `${currentUser.username} 的家庭组` : '登录后查看家庭相册' }}
          <span v-if="members.length > 1" class="member-count">· {{ members.length }} 位成员</span>
        </p>
      </div>
      <div class="header-actions">
        <el-button @click="membersPanelOpen = !membersPanelOpen">
          <el-icon><User /></el-icon>
          {{ membersPanelOpen ? '收起成员' : '成员管理' }}
        </el-button>
        <el-button type="primary" @click="uploadDialogVisible = true">
          <el-icon><Upload /></el-icon>
          上传新照片
        </el-button>
      </div>
    </div>

    <!-- 成员管理面板（可折叠） -->
    <div v-if="membersPanelOpen" class="members-panel">
      <div class="members-header">
        <h3 class="members-title">👥 家庭成员</h3>
        <span v-if="groupName" class="group-name">组: {{ groupName }}</span>
      </div>

      <div class="members-list">
        <div
          v-for="member in members"
          :key="member.id"
          class="member-item"
        >
          <div class="member-avatar">
            {{ member.username.charAt(0).toUpperCase() }}
          </div>
          <div class="member-info">
            <span class="member-name">{{ member.username }}</span>
            <span class="member-role-tag">
              <el-tag v-if="member.role === 'admin'" type="danger" size="small" effect="dark">管理员</el-tag>
              <el-tag v-else type="info" size="small" effect="dark">成员</el-tag>
            </span>
            <span v-if="member.id === currentUser?.id" class="member-self">（我）</span>
          </div>
          <el-button
            v-if="member.id !== currentUser?.id"
            size="small"
            type="danger"
            plain
            @click="handleRemoveMember(member)"
          >
            移除
          </el-button>
        </div>
      </div>

      <div class="add-member-row">
        <el-input
          v-model="addMemberUsername"
          placeholder="输入要添加的用户名"
          size="large"
          clearable
          @keyup.enter="handleAddMember"
        />
        <el-button
          type="primary"
          size="large"
          :loading="addingMember"
          :disabled="!addMemberUsername.trim()"
          @click="handleAddMember"
        >
          {{ addingMember ? '添加中…' : '添加成员' }}
        </el-button>
      </div>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="loading-state">
      <el-icon class="is-loading" :size="32"><Loading /></el-icon>
      <span>加载相册中…</span>
    </div>

    <!-- 照片墙 -->
    <div v-else-if="photos.length > 0" class="photo-grid">
      <div
        v-for="photo in photos"
        :key="photo.id || photo.name"
        class="photo-item"
      >
        <div class="photo-card" @click="openPreview(photo)">
          <img
            :src="photo.url"
            :alt="photo.name"
            class="photo-img"
            loading="lazy"
          />
          <!-- 悬浮操作栏 -->
          <div class="photo-overlay">
            <el-button
              circle
              size="small"
              class="action-btn download-btn"
              @click.stop="downloadPhoto(photo)"
            >
              <el-icon :size="16"><Download /></el-icon>
            </el-button>
            <!-- 动态删除按钮：仅 admin 或上传者可见 -->
            <el-button
              v-if="canDelete(photo)"
              circle
              size="small"
              class="action-btn delete-btn"
              @click.stop="deletePhoto(photo)"
            >
              <el-icon :size="16"><Delete /></el-icon>
            </el-button>
          </div>
        </div>
        <div class="photo-meta">
          <span class="photo-name">{{ photo.name }}</span>
          <span v-if="photo.uploaderName" class="photo-uploader">by {{ photo.uploaderName }}</span>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <el-empty v-else description="相册还是空的，快来上传第一张照片吧！" />

    <!-- 全屏预览（使用 ElImageViewer） -->
    <el-image-viewer
      v-if="previewVisible"
      :url-list="previewSrcList"
      :initial-index="0"
      hide-on-click-modal
      @close="previewVisible = false"
    />

    <!-- 上传弹窗 -->
    <el-dialog
      v-model="uploadDialogVisible"
      title="📸 上传新照片"
      width="380px"
      :close-on-click-modal="false"
    >
      <el-upload
        drag
        :auto-upload="false"
        :show-file-list="true"
        :on-change="handleUploadChange"
        :limit="1"
        accept="image/*"
        :file-list="[]"
      >
        <el-icon :size="40"><Plus /></el-icon>
        <div class="upload-text">拖拽照片到此处，或点击选择</div>
        <template #tip>
          <div class="upload-tip">单张最大 50MB · 支持 JPG/PNG/GIF/WebP</div>
        </template>
      </el-upload>
      <template #footer>
        <el-button @click="uploadDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="uploading"
          :disabled="!uploadFile"
          @click="submitUpload"
        >
          {{ uploading ? '上传中…' : '确认上传' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.gallery-view {
  max-width: 1100px;
  margin: 0 auto;
  padding: 20px 16px 40px;
}

.gallery-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 24px;
}

.page-title {
  font-size: 1.4rem;
  font-weight: 400;
  color: #e0e0e0;
  margin: 0 0 4px;
  letter-spacing: 1px;
}
.title-icon { margin-right: 8px; }
.page-desc {
  color: #666;
  font-size: 0.85rem;
  margin: 0;
}

/* 加载 */
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 60px 0;
  color: #888;
}

/* 照片墙 — 响应式网格 */
.photo-grid {
  display: flex;
  flex-wrap: wrap;
  margin: -8px;
}

.photo-item {
  padding: 8px;
  box-sizing: border-box;
  width: 50%;
}
@media (min-width: 640px) { .photo-item { width: 33.333%; } }
@media (min-width: 900px) { .photo-item { width: 25%; } }

.photo-card {
  position: relative;
  border-radius: 10px;
  overflow: hidden;
  background: #16162a;
  border: 1px solid #222244;
  cursor: pointer;
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.2s, box-shadow 0.2s;
}
.photo-card:hover {
  transform: scale(1.02);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}

.photo-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.photo-overlay {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.2s;
}
.photo-card:hover .photo-overlay {
  opacity: 1;
}

.action-btn {
  background: rgba(0, 0, 0, 0.6);
  color: #ccc;
  border: none;
}
.action-btn:hover {
  color: #fff;
}
.download-btn:hover {
  background: rgba(64, 158, 255, 0.8);
}
.delete-btn:hover {
  background: rgba(231, 76, 60, 0.8);
}

.photo-meta {
  font-size: 0.72rem;
  margin-top: 4px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.photo-name {
  color: #666;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.photo-uploader {
  color: #555;
  flex-shrink: 0;
  margin-left: 6px;
}

/* 上传弹窗 */
.upload-text {
  color: #aaa;
  font-size: 0.9rem;
  margin-top: 8px;
}
.upload-tip {
  color: #666;
  font-size: 0.78rem;
  margin-top: 4px;
}

/* 成员管理面板 */
.members-panel {
  background: #16162a;
  border-radius: 12px;
  border: 1px solid #222244;
  padding: 20px;
  margin-bottom: 24px;
}

.members-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.members-title {
  font-size: 1rem;
  font-weight: 500;
  color: #c0c0e0;
  margin: 0;
}

.group-name {
  color: #666;
  font-size: 0.8rem;
}

.members-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
}

.member-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: #0d0d1a;
  border-radius: 8px;
}

.member-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: #1e1e40;
  color: #409eff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 0.9rem;
  flex-shrink: 0;
}

.member-info {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.member-name {
  color: #c0c0e0;
  font-size: 0.9rem;
  font-weight: 500;
}

.member-self {
  color: #666;
  font-size: 0.8rem;
}

.add-member-row {
  display: flex;
  gap: 10px;
}

.add-member-row .el-input {
  flex: 1;
}

.header-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.member-count {
  color: #888;
  font-size: 0.8rem;
}

/* 移动端缩减边距 */
@media (max-width: 480px) {
  .gallery-view { padding: 12px 10px 30px; }
  .photo-item { padding: 6px; }
  .photo-grid { margin: -6px; }
}
</style>

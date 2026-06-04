<script setup>
/**
 * AdminView.vue — 管理员后台看板
 *
 * 两个标签页：
 *   1. 文件管理 — 查看所有上传文件 + 删除
 *   2. 用户管理 — 查看/新增/修改/删除用户
 *
 * 需要当前用户 role === 'admin'，路由层 meta.requiresAdmin 做前置守卫
 */
import { ref, onMounted, reactive } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import axios from 'axios'
import { formatSize } from '../utils/format.js'

// ---------- 当前用户 ----------
const currentUser = (() => {
  try {
    const raw = localStorage.getItem('lcyksp_user')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
})()

// ===================================================================
//  文件管理
// ===================================================================
const files = ref([])
const filesLoading = ref(false)

async function loadFiles() {
  filesLoading.value = true
  try {
    const res = await axios.get('/api/admin/files')
    files.value = res.data.files
  } catch (err) {
    console.error('加载文件列表失败:', err)
  } finally {
    filesLoading.value = false
  }
}

async function deleteFile(code, fileName) {
  try {
    await ElMessageBox.confirm(
      `确定要删除文件「${fileName}」(提取码: ${code}) 吗？\n此操作将同时删除服务器磁盘上的物理文件，不可撤销。`,
      '删除文件',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning', confirmButtonClass: 'el-button--danger' },
    )
    await axios.delete(`/api/admin/files/${code}`)
    ElMessage.success('文件已删除')
    loadFiles()
  } catch (err) {
    if (err !== 'cancel') ElMessage.error('删除失败')
  }
}

// ---------- 文件编辑 ----------
const fileDialogVisible = ref(false)
const fileForm = reactive({
  code: '',
  fileName: '',
  expireTime: '',
  isPermanent: false,
  maxDownloads: null,
})
const fileFormLoading = ref(false)

function openEditFile(file) {
  fileForm.code = file.id
  fileForm.fileName = file.fileName
  // 将过期时间转为 YYYY-MM-DDTHH:mm 格式用于 datetime-local input
  if (file.expireTime && file.expireTime.includes('2099')) {
    fileForm.expireTime = 'permanent'
    fileForm.isPermanent = true
  } else if (file.expireTime) {
    const d = new Date(file.expireTime)
    if (!isNaN(d.getTime())) {
      const pad = (n) => String(n).padStart(2, '0')
      fileForm.expireTime = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
    } else {
      fileForm.expireTime = ''
    }
    fileForm.isPermanent = false
  } else {
    fileForm.expireTime = ''
    fileForm.isPermanent = false
  }
  fileForm.maxDownloads = file.maxDownloads === -1 ? -1 : file.maxDownloads
  fileDialogVisible.value = true
}

async function submitFileForm() {
  const payload = {}

  if (fileForm.isPermanent) {
    payload.expireTime = 'permanent'
  } else if (fileForm.expireTime) {
    // 将本地 datetime-local 转为 ISO
    const d = new Date(fileForm.expireTime)
    if (!isNaN(d.getTime())) {
      payload.expireTime = d.toISOString()
    } else {
      ElMessage.warning('请选择有效的过期时间')
      return
    }
  }

  if (fileForm.maxDownloads !== null && fileForm.maxDownloads !== undefined) {
    payload.maxDownloads = fileForm.maxDownloads
  }

  if (Object.keys(payload).length === 0) {
    ElMessage.warning('请至少修改一个属性')
    return
  }

  fileFormLoading.value = true
  try {
    await axios.put(`/api/admin/files/${fileForm.code}`, payload)
    ElMessage.success('文件属性已更新')
    fileDialogVisible.value = false
    loadFiles()
  } catch (err) {
    // 拦截器已处理提示
  } finally {
    fileFormLoading.value = false
  }
}

// ===================================================================
//  用户管理
// ===================================================================
const users = ref([])
const usersLoading = ref(false)

// 新增/修改用户弹窗
const userDialogVisible = ref(false)
const userDialogMode = ref('add') // 'add' | 'edit'
const userForm = reactive({
  id: null,
  username: '',
  password: '',
  role: 'user',
})
const userFormLoading = ref(false)

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
  userForm.password = '' // 留空则不修改密码
  userForm.role = user.role
  userDialogVisible.value = true
}

async function submitUserForm() {
  if (!userForm.username || userForm.username.length < 2) {
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
        username: userForm.username,
        password: userForm.password,
        role: userForm.role,
      })
      ElMessage.success('用户创建成功')
    } else {
      const payload = { username: userForm.username }
      if (userForm.password) payload.password = userForm.password
      payload.role = userForm.role
      await axios.put(`/api/admin/users/${userForm.id}`, payload)
      ElMessage.success('用户信息已更新')
    }
    userDialogVisible.value = false
    loadUsers()
  } catch (err) {
    // 拦截器已处理提示
  } finally {
    userFormLoading.value = false
  }
}

async function deleteUser(user) {
  if (user.id === currentUser?.id) {
    ElMessage.warning('不能删除自己的账号')
    return
  }
  try {
    await ElMessageBox.confirm(
      `确定要删除用户「${user.username}」(ID: ${user.id}) 吗？\n该用户关联的文件传输记录将变为「游客」状态。`,
      '删除用户',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning', confirmButtonClass: 'el-button--danger' },
    )
    await axios.delete(`/api/admin/users/${user.id}`)
    ElMessage.success('用户已删除')
    loadUsers()
  } catch (err) {
    if (err !== 'cancel') ElMessage.error('删除失败')
  }
}

async function loadUsers() {
  usersLoading.value = true
  try {
    const res = await axios.get('/api/admin/users')
    users.value = res.data.users
  } catch (err) {
    console.error('加载用户列表失败:', err)
  } finally {
    usersLoading.value = false
  }
}

// ---------- 工具函数 ----------
function formatTime(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function isExpired(iso) {
  if (!iso) return false
  return new Date(iso) < new Date()
}

// ---------- 挂载 ----------
onMounted(() => {
  loadFiles()
  loadUsers()
})
</script>

<template>
  <div class="admin-view">
    <h2 class="page-title"><span class="title-icon">🛡️</span> 管理员后台</h2>

    <el-tabs type="border-card" class="admin-tabs">
      <!-- ============================================================ -->
      <!--  标签一：文件管理 -->
      <!-- ============================================================ -->
      <el-tab-pane label="📁 文件管理">
        <div class="tab-header">
          <span class="tab-count">共 {{ files.length }} 条文件记录</span>
          <el-button size="small" @click="loadFiles" :loading="filesLoading">
            <el-icon><Refresh /></el-icon> 刷新
          </el-button>
        </div>

        <el-table
          v-loading="filesLoading"
          :data="files"
          style="width: 100%"
          stripe
          empty-text="暂无上传文件"
          size="small"
        >
          <el-table-column prop="id" label="提取码" width="100" />
          <el-table-column prop="fileName" label="文件名" min-width="160" show-overflow-tooltip />
          <el-table-column label="文件大小" width="100">
            <template #default="{ row }">{{ formatSize(row.fileSize) }}</template>
          </el-table-column>
          <el-table-column label="下载" width="90">
            <template #default="{ row }">
              <span :class="row.maxDownloads === -1 ? 'badge-unlimited' : 'badge-count'">
                {{ row.maxDownloads === -1 ? '∞' : `${row.currentDownloads}/${row.maxDownloads}` }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="过期时间" width="150">
            <template #default="{ row }">
              <span :class="isExpired(row.expireTime) ? 'text-expired' : ''">
                {{ formatTime(row.expireTime) }}
                <span v-if="!row.expireTime || row.expireTime.includes('2099')" class="badge-permanent">永久</span>
              </span>
            </template>
          </el-table-column>
          <el-table-column prop="ownerName" label="上传者" width="120" />
          <el-table-column label="创建时间" width="150">
            <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="150" fixed="right">
            <template #default="{ row }">
              <el-button
                size="small"
                type="primary"
                plain
                @click="openEditFile(row)"
              >
                编辑
              </el-button>
              <el-button
                type="danger"
                size="small"
                @click="deleteFile(row.id, row.fileName)"
              >
                删除
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- ============================================================ -->
      <!--  标签二：用户管理 -->
      <!-- ============================================================ -->
      <el-tab-pane label="👥 用户管理">
        <div class="tab-header">
          <span class="tab-count">共 {{ users.length }} 个注册用户</span>
          <div class="tab-actions">
            <el-button size="small" @click="loadUsers" :loading="usersLoading">
              <el-icon><Refresh /></el-icon> 刷新
            </el-button>
            <el-button type="primary" size="small" @click="openAddUser">
              <el-icon><Plus /></el-icon> 新增用户
            </el-button>
          </div>
        </div>

        <el-table
          v-loading="usersLoading"
          :data="users"
          style="width: 100%"
          stripe
          empty-text="暂无用户数据"
          size="small"
        >
          <el-table-column prop="id" label="ID" width="60" />
          <el-table-column prop="username" label="用户名" min-width="140" />
          <el-table-column prop="role" label="角色" width="80">
            <template #default="{ row }">
              <el-tag :type="row.role === 'admin' ? 'danger' : 'info'" size="small" effect="dark">
                {{ row.role === 'admin' ? '管理员' : '用户' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="groupName" label="家庭组" width="120">
            <template #default="{ row }">{{ row.groupName || '-' }}</template>
          </el-table-column>
          <el-table-column label="注册时间" width="150">
            <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="160" fixed="right">
            <template #default="{ row }">
              <el-button size="small" type="primary" plain @click="openEditUser(row)">
                编辑
              </el-button>
              <el-button
                size="small"
                type="danger"
                plain
                :disabled="row.id === currentUser?.id"
                @click="deleteUser(row)"
              >
                删除
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <!-- ============================================================ -->
    <!--  新增 / 修改用户弹窗 -->
    <!-- ============================================================ -->
    <el-dialog
      v-model="userDialogVisible"
      :title="userDialogMode === 'add' ? '👤 新增用户' : '✏️ 编辑用户'"
      width="400px"
      :close-on-click-modal="false"
    >
      <el-form label-position="top" size="large">
        <el-form-item label="用户名">
          <el-input
            v-model="userForm.username"
            placeholder="2-32 个字符"
            clearable
          />
        </el-form-item>

        <el-form-item :label="userDialogMode === 'add' ? '密码' : '新密码（留空则不修改）'">
          <el-input
            v-model="userForm.password"
            type="password"
            show-password
            :placeholder="userDialogMode === 'add' ? '至少 6 个字符' : '留空则不修改密码'"
            clearable
          />
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
        <el-button
          type="primary"
          :loading="userFormLoading"
          @click="submitUserForm"
        >
          {{ userFormLoading ? '保存中…' : '保存' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- ============================================================ -->
    <!--  文件编辑弹窗 -->
    <!-- ============================================================ -->
    <el-dialog
      v-model="fileDialogVisible"
      title="✏️ 编辑文件属性"
      width="420px"
      :close-on-click-modal="false"
    >
      <el-form label-position="top" size="large">
        <el-form-item label="文件">
          <el-input :model-value="fileForm.fileName" disabled />
        </el-form-item>

        <el-form-item label="提取码">
          <el-input :model-value="fileForm.code" disabled />
        </el-form-item>

        <el-form-item label="过期时间">
          <div class="file-edit-time-row">
            <el-input
              v-model="fileForm.expireTime"
              type="datetime-local"
              placeholder="选择过期时间"
              :disabled="fileForm.expireTime === 'permanent'"
            />
            <el-checkbox
              v-model="fileForm.isPermanent"
              @change="(val) => { fileForm.expireTime = val ? 'permanent' : '' }"
            >
              永久有效
            </el-checkbox>
          </div>
          <div class="form-hint" style="margin-top: 4px">
            取消勾选「永久有效」后可手动设定过期时间
          </div>
        </el-form-item>

        <el-form-item label="下载次数限制（-1 = 无限次）">
          <el-input-number
            v-model="fileForm.maxDownloads"
            :min="-1"
            :max="1000"
            :step="1"
          />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="fileDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="fileFormLoading"
          @click="submitFileForm"
        >
          {{ fileFormLoading ? '保存中…' : '保存' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.admin-view {
  max-width: 1200px;
  margin: 0 auto;
  padding: 20px 16px 40px;
}

.page-title {
  font-size: 1.4rem;
  font-weight: 400;
  color: #e0e0e0;
  margin: 0 0 20px;
  letter-spacing: 1px;
}
.title-icon {
  margin-right: 8px;
}

.admin-tabs {
  --el-tabs-header-bg-color: #16162a;
  --el-tabs-content-bg-color: #16162a;
  border: 1px solid #222244;
  border-radius: 12px;
  overflow: hidden;
}

.tab-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  flex-wrap: wrap;
  gap: 8px;
}

.tab-count {
  color: #888;
  font-size: 0.85rem;
}

.tab-actions {
  display: flex;
  gap: 8px;
}

/* 表格样式覆盖 */
:deep(.el-table) {
  --el-table-bg-color: transparent;
  --el-table-tr-bg-color: transparent;
  --el-table-header-bg-color: #0d0d1a;
  --el-table-row-hover-bg-color: #1a1a30;
  --el-table-border-color: #1a1a30;
  --el-table-text-color: #c0c0e0;
  --el-table-header-text-color: #888;
}

:deep(.el-table--striped .el-table__body tr.el-table__row--striped td) {
  background: #111125;
}

/* 徽标 */
.badge-unlimited,
.badge-count {
  display: inline-block;
  padding: 0 8px;
  border-radius: 4px;
  font-size: 0.8rem;
}
.badge-unlimited {
  color: #67c23a;
}
.badge-count {
  color: #c0c0e0;
}
.badge-permanent {
  font-size: 0.7rem;
  color: #67c23a;
  margin-left: 4px;
}
.text-expired {
  color: #666;
}

.file-edit-time-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.form-hint {
  color: #888;
  font-size: 0.8rem;
}

@media (max-width: 640px) {
  .admin-view { padding: 12px 8px 30px; }
  .tab-header { flex-direction: column; align-items: flex-start; }
}
</style>

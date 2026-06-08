<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import axios from 'axios'
import { ElMessage } from 'element-plus'
import {
  Expand,
  Fold,
  ArrowDown,
  Operation,
  UserFilled,
  Key,
  Setting,
  HomeFilled,
  Edit,
  Upload,
  KnifeFork,
  Moon,
  Sunny,
  RefreshRight,
  ChatDotRound,
} from '@element-plus/icons-vue'
import AuthDialog from './components/AuthDialog.vue'
import { getCurrentTheme, resetThemeAuto, setThemeMode } from './main.js'

const router = useRouter()
const route = useRoute()

const THEME_MODE_KEY = 'lcyksp_theme_mode'

const authDialogVisible = ref(false)
const feedbackDialogVisible = ref(false)
const currentUser = ref(null)
const sidebarCollapsed = ref(false)
const currentTheme = ref(getCurrentTheme())
const currentThemeMode = ref(localStorage.getItem(THEME_MODE_KEY) || 'auto')
const feedbackSubmitting = ref(false)

const feedbackForm = reactive({
  pageName: '',
  featureName: '',
  problemSummary: '',
  details: '',
})

const isLoggedIn = computed(() => !!currentUser.value)
const isAdmin = computed(() => currentUser.value?.role === 'admin')
const displayName = computed(() => currentUser.value?.username || '')
const activePath = computed(() => route.path)
const routeLabel = computed(() => String(route.name || ''))
const isThemeAuto = computed(() => currentThemeMode.value === 'auto')

const menuItems = reactive([
  {
    name: '首页',
    icon: HomeFilled,
    path: '/',
    children: [],
    isOpen: false,
  },
  {
    name: '图片工具',
    icon: Edit,
    children: [
      { name: '图片压缩', path: '/compress' },
      { name: '格式转换', path: '/convert' },
      { name: '像素画转换', path: '/pixel-art' },
      { name: '图片解混淆', path: '/obfuscate' },
    ],
    isOpen: false,
  },
  {
    name: '文件工具',
    icon: Upload,
    children: [
      { name: '文件闪传', path: '/transmit' },
      { name: 'PDF合并', path: '/pdf-merge' },
      { name: 'PDF拆分', path: '/pdf-split' },
      { name: '图片转PDF', path: '/img-to-pdf' },
      { name: 'PDF转图片', path: '/pdf-to-img' },
      { name: 'PDF提取文本', path: '/pdf-extract-text' },
      { name: 'PDF页面编辑', path: '/pdf-page-editor' },
      { name: 'PDF水印', path: '/pdf-watermark' },
      { name: 'PDF签名', path: '/pdf-sign' },
    ],
    isOpen: false,
  },
  {
    name: '生活工具',
    icon: KnifeFork,
    children: [
      { name: '赛博菜谱', path: '/recipe' },
      { name: '共享相册', path: '/gallery' },
      { name: '音视频下载', path: '/video-download' },
    ],
    isOpen: false,
  },
])

function loadUserFromStorage() {
  const raw = localStorage.getItem('lcyksp_user')
  if (!raw) {
    currentUser.value = null
    return
  }

  try {
    currentUser.value = JSON.parse(raw)
  } catch {
    currentUser.value = null
  }
}

function handleLoginSuccess(user) {
  currentUser.value = user
}

function handleLogout() {
  localStorage.removeItem('lcyksp_token')
  localStorage.removeItem('lcyksp_user')
  currentUser.value = null
  ElMessage.info('已退出登录')
}

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
}

function toggleMenu(item) {
  if (item.children?.length) {
    item.isOpen = !item.isOpen
    return
  }

  if (item.path) {
    navigateTo(item.path)
  }
}

function navigateTo(path) {
  if (!path) return
  router.push(path)
  if (window.innerWidth < 768) {
    sidebarCollapsed.value = true
  }
}

function isActive(item) {
  if (item.path) return activePath.value === item.path
  if (item.children?.length) return item.children.some((child) => child.path === activePath.value)
  return false
}

function syncOpenGroups() {
  menuItems.forEach((group) => {
    if (group.children?.length) {
      group.isOpen = group.children.some((child) => child.path === activePath.value)
    }
  })
}

function applyThemeMode(mode) {
  if (mode === 'auto') {
    resetThemeAuto()
  } else {
    setThemeMode(mode)
  }
  currentThemeMode.value = mode
  currentTheme.value = getCurrentTheme()
}

function cycleThemeMode() {
  if (currentThemeMode.value === 'auto') {
    applyThemeMode(currentTheme.value === 'dark' ? 'light' : 'dark')
    return
  }

  const nextMode = currentTheme.value === 'dark' ? 'light' : 'dark'
  applyThemeMode(nextMode)
}

function enableAutoTheme() {
  applyThemeMode('auto')
  ElMessage.success('已恢复自动切换模式')
}

function openFeedbackDialog() {
  feedbackForm.pageName = routeLabel.value || route.path || '当前页面'
  feedbackForm.featureName = ''
  feedbackForm.problemSummary = ''
  feedbackForm.details = ''
  feedbackDialogVisible.value = true
}

async function submitFeedback() {
  if (!feedbackForm.pageName.trim() || !feedbackForm.featureName.trim() || !feedbackForm.problemSummary.trim() || !feedbackForm.details.trim()) {
    ElMessage.warning('请把页面、功能、问题和具体情况都填写完整')
    return
  }

  feedbackSubmitting.value = true
  try {
    const res = await axios.post('/api/feedback', {
      pageName: feedbackForm.pageName.trim(),
      featureName: feedbackForm.featureName.trim(),
      problemSummary: feedbackForm.problemSummary.trim(),
      details: feedbackForm.details.trim(),
    })

    if (!res.data?.success) {
      ElMessage.error(res.data?.message || '反馈提交失败')
      return
    }

    ElMessage.success('问题反馈已提交')
    feedbackDialogVisible.value = false
  } catch (error) {
    ElMessage.error(error.response?.data?.error || error.response?.data?.message || error.message || '反馈提交失败')
  } finally {
    feedbackSubmitting.value = false
  }
}

const themeButtonTitle = computed(() => {
  if (isThemeAuto.value) {
    return currentTheme.value === 'dark' ? '当前自动夜间，点击切到日间' : '当前自动日间，点击切到夜间'
  }
  return currentTheme.value === 'dark' ? '切换到日间模式' : '切换到夜间模式'
})

watch(
  () => route.path,
  () => {
    syncOpenGroups()
  },
  { immediate: true },
)

onMounted(() => {
  loadUserFromStorage()
  syncOpenGroups()
  currentTheme.value = getCurrentTheme()
  currentThemeMode.value = localStorage.getItem(THEME_MODE_KEY) || 'auto'
})
</script>

<template>
  <div class="shell" :class="{ 'sidebar-open': !sidebarCollapsed }">
    <aside class="sidebar" :class="{ collapsed: sidebarCollapsed }">
      <div class="sidebar-header">
        <span class="sidebar-logo" @click="navigateTo('/')">lcyksp</span>
        <el-button text class="collapse-btn" @click="toggleSidebar">
          <el-icon :size="18">
            <Fold v-if="!sidebarCollapsed" />
            <Expand v-else />
          </el-icon>
        </el-button>
      </div>

      <nav class="sidebar-nav">
        <div v-for="group in menuItems" :key="group.name" class="menu-group">
          <div class="menu-item group-header" :class="{ active: isActive(group) }" @click="toggleMenu(group)">
            <span class="menu-icon">
              <el-icon :size="18">
                <component :is="group.icon" />
              </el-icon>
            </span>
            <span class="menu-label">{{ group.name }}</span>
            <span v-if="group.children?.length" class="menu-arrow" :class="{ rotated: group.isOpen }">
              <el-icon :size="14"><ArrowDown /></el-icon>
            </span>
          </div>

          <transition name="slide">
            <div v-if="group.isOpen" class="submenu">
              <div
                v-for="child in group.children"
                :key="child.name"
                class="menu-item submenu-item"
                :class="{ active: activePath === child.path, disabled: child.disabled }"
                @click="!child.disabled && navigateTo(child.path)"
              >
                <span class="menu-label">{{ child.name }}</span>
                <span v-if="child.disabled" class="menu-badge">即将上线</span>
              </div>
            </div>
          </transition>
        </div>

        <div v-if="isAdmin" class="menu-group">
          <div class="menu-item group-header" :class="{ active: activePath === '/admin' }" @click="navigateTo('/admin')">
            <span class="menu-icon">
              <el-icon :size="18"><Setting /></el-icon>
            </span>
            <span class="menu-label">管理后台</span>
          </div>
        </div>
      </nav>

      <div class="sidebar-footer">
        <span>v4.0 | lcyksp.xyz</span>
      </div>
    </aside>

    <div v-if="!sidebarCollapsed" class="sidebar-overlay" @click="sidebarCollapsed = true" />

    <div class="main-area">
      <header class="top-bar">
        <div class="top-bar-left">
          <el-button text class="menu-btn" @click="toggleSidebar">
            <el-icon :size="22"><Operation /></el-icon>
          </el-button>
          <span class="breadcrumb">{{ routeLabel === 'home' ? '' : routeLabel }}</span>
        </div>

        <div class="top-bar-right">
          <div class="feedback-control">
            <el-button size="small" text class="feedback-btn" title="提交问题反馈" @click="openFeedbackDialog">
              <el-icon :size="18"><ChatDotRound /></el-icon>
              <span class="feedback-label">反馈</span>
            </el-button>
          </div>

          <div class="theme-control">
            <el-button size="small" text class="theme-btn" :title="themeButtonTitle" @click="cycleThemeMode">
              <el-icon :size="18">
                <Moon v-if="currentTheme === 'dark'" />
                <Sunny v-else />
              </el-icon>
              <span class="theme-label">{{ currentTheme === 'dark' ? '夜间' : '日间' }}</span>
            </el-button>

            <el-button
              v-if="!isThemeAuto"
              size="small"
              text
              class="theme-auto-btn"
              title="恢复自动模式（北京时间 18:00-6:00 夜间）"
              @click="enableAutoTheme"
            >
              <el-icon :size="16"><RefreshRight /></el-icon>
              <span class="theme-label">自动</span>
            </el-button>
            <span v-else class="theme-auto-pill">自动</span>
          </div>

          <template v-if="isLoggedIn">
            <span class="user-greeting">
              <el-icon><UserFilled /></el-icon>
              {{ displayName }}
            </span>
            <el-button size="small" text @click="handleLogout">退出</el-button>
          </template>
          <template v-else>
            <el-button size="small" text class="login-btn" @click="authDialogVisible = true">
              <el-icon><Key /></el-icon>
              <span class="login-label">登录</span>
            </el-button>
          </template>
        </div>
      </header>

      <main class="main-content">
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
    </div>

    <AuthDialog v-model:visible="authDialogVisible" @login-success="handleLoginSuccess" />

    <el-dialog v-model="feedbackDialogVisible" title="问题反馈" width="520px" :close-on-click-modal="false">
      <div class="feedback-form">
        <div class="feedback-field">
          <label>哪个页面出了问题</label>
          <el-input v-model="feedbackForm.pageName" placeholder="例如：音视频下载 / PDF转图片 / 图片解混淆" clearable />
        </div>
        <div class="feedback-field">
          <label>哪个功能出了问题</label>
          <el-input v-model="feedbackForm.featureName" placeholder="例如：解析、下载、预览、导出" clearable />
        </div>
        <div class="feedback-field">
          <label>问题是什么</label>
          <el-input v-model="feedbackForm.problemSummary" placeholder="例如：点击后一直加载、结果为空、提示转换失败" clearable />
        </div>
        <div class="feedback-field">
          <label>具体是什么样的情况</label>
          <el-input
            v-model="feedbackForm.details"
            type="textarea"
            :rows="6"
            resize="vertical"
            placeholder="请尽量描述你做了什么、输入了什么、页面提示了什么、结果和你预期哪里不一样。"
          />
        </div>
      </div>
      <template #footer>
        <div class="feedback-footer">
          <el-button @click="feedbackDialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="feedbackSubmitting" @click="submitFeedback">提交反馈</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.shell {
  min-height: 100vh;
  display: flex;
  background:
    radial-gradient(circle at top right, rgba(64, 158, 255, 0.1), transparent 28%),
    linear-gradient(180deg, var(--bg-deep) 0%, color-mix(in srgb, var(--bg-deep) 92%, var(--accent-blue) 8%) 100%);
  transition: background 0.3s ease;
}

.sidebar {
  width: 228px;
  min-height: 100vh;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--bg-sidebar) 92%, var(--accent-blue) 8%), var(--bg-sidebar));
  border-right: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  transition: width 0.3s ease, transform 0.3s ease;
  z-index: 100;
  overflow: hidden;
  backdrop-filter: blur(10px);
}

.sidebar.collapsed {
  width: 0;
  border-right: none;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 16px 12px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
  min-width: 196px;
}

.sidebar-logo {
  font-size: 1.16rem;
  font-weight: 700;
  color: var(--text-heading);
  letter-spacing: 2px;
  cursor: pointer;
  transition: color 0.2s ease;
}

.sidebar-logo:hover {
  color: var(--accent-blue);
}

.collapse-btn,
.menu-btn,
.login-btn,
.feedback-btn,
.theme-btn,
.theme-auto-btn {
  color: var(--text-secondary);
}

.collapse-btn:hover,
.menu-btn:hover,
.login-btn:hover,
.feedback-btn:hover,
.theme-btn:hover,
.theme-auto-btn:hover {
  color: var(--accent-blue);
}

.sidebar-nav {
  flex: 1;
  overflow-y: auto;
  padding: 10px 0;
  min-width: 196px;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  margin: 2px 8px;
  border-radius: 10px;
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 0.9rem;
  transition: all 0.2s ease;
  user-select: none;
  min-height: 40px;
}

.menu-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.menu-item.active {
  background: var(--bg-active);
  color: var(--accent-blue);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-blue) 30%, transparent);
}

.menu-item.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.menu-icon {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.menu-label {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.menu-arrow {
  display: flex;
  align-items: center;
  transition: transform 0.3s ease;
  color: var(--text-muted);
}

.menu-arrow.rotated {
  transform: rotate(-180deg);
}

.menu-badge {
  font-size: 0.65rem;
  color: var(--text-secondary);
  background: var(--bg-hover);
  padding: 1px 6px;
  border-radius: 999px;
  white-space: nowrap;
}

.group-header {
  font-weight: 600;
}

.submenu {
  overflow: hidden;
}

.submenu-item {
  padding-left: 44px;
  font-size: 0.85rem;
}

.slide-enter-active,
.slide-leave-active {
  transition: all 0.25s ease;
}

.slide-enter-from,
.slide-leave-to {
  opacity: 0;
  max-height: 0;
  padding-top: 0;
  padding-bottom: 0;
}

.slide-enter-to,
.slide-leave-from {
  opacity: 1;
  max-height: 300px;
}

.sidebar-overlay {
  display: none;
}

.sidebar-footer {
  padding: 12px 16px;
  color: var(--text-muted);
  font-size: 0.75rem;
  text-align: center;
  border-top: 1px solid var(--border-subtle);
  flex-shrink: 0;
  min-width: 196px;
}

.main-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 56px;
  padding: 0 20px;
  background: color-mix(in srgb, var(--bg-deep) 86%, transparent);
  backdrop-filter: blur(10px);
  flex-shrink: 0;
  border-bottom: 1px solid var(--border-subtle);
}

.top-bar-left,
.top-bar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.breadcrumb {
  color: var(--text-muted);
  font-size: 0.85rem;
  text-transform: capitalize;
}

.feedback-control,
.theme-control {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 4px;
  margin-right: 4px;
  border-right: 1px solid var(--border-subtle);
}

.theme-label,
.feedback-label {
  margin-left: 4px;
}

.theme-auto-pill {
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 0.72rem;
  color: var(--accent-blue);
  background: color-mix(in srgb, var(--accent-blue) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent-blue) 28%, transparent);
}

.user-greeting {
  color: var(--text-secondary);
  font-size: 0.85rem;
  display: flex;
  align-items: center;
  gap: 4px;
}

.login-label {
  margin-left: 4px;
}

.main-content {
  flex: 1;
}

.feedback-form {
  display: grid;
  gap: 14px;
}

.feedback-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.feedback-field label {
  color: var(--text-secondary);
  font-size: 0.86rem;
}

.feedback-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

@media (max-width: 768px) {
  .sidebar {
    position: fixed;
    left: 0;
    top: 0;
    z-index: 1000;
    transform: translateX(0);
  }

  .sidebar.collapsed {
    transform: translateX(-100%);
  }

  .sidebar-overlay {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.48);
    z-index: 999;
  }

  .top-bar {
    padding: 0 10px;
  }

  .feedback-control,
  .theme-control {
    gap: 2px;
    padding-right: 2px;
    margin-right: 2px;
  }

  .theme-label,
  .feedback-label,
  .login-label {
    display: none;
  }

  .user-greeting {
    max-width: 92px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>

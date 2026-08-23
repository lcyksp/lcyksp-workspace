<script setup>
import { computed, onMounted, onUnmounted, provide, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import axios from 'axios'
import { ElMessage, ElMessageBox } from 'element-plus'
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
  Star,
  Moon,
  Sunny,
  RefreshRight,
  ChatDotRound,
} from '@element-plus/icons-vue'
import AuthDialog from './components/AuthDialog.vue'
import VideoBackground from './components/VideoBackground.vue'
import { getCurrentTheme, resetThemeAuto, setThemeMode } from './main.js'

const GLASS_HOME_KEY = 'lcyksp_glass_home'
const DESKTOP_BREAKPOINT = 768

const router = useRouter()
const route = useRoute()

const THEME_MODE_KEY = 'lcyksp_theme_mode'

const authDialogVisible = ref(false)
const feedbackDialogVisible = ref(false)
const accessDialogVisible = ref(false)
const currentUser = ref(null)
const sidebarCollapsed = ref(false)
const currentTheme = ref(getCurrentTheme())
const currentThemeMode = ref(localStorage.getItem(THEME_MODE_KEY) || 'auto')
const feedbackSubmitting = ref(false)
const accessDialogTarget = ref('')
const membershipLoading = ref(false)
const membershipConfig = reactive({
  afdianUrl: '',
  notice: '赞助后可获得卡密，回到本站兑换即可自动开通高级用户。休息时间处理用户权限会稍慢一些。',
  plans: [],
  apiReady: false,
  apiStatusText: '',
})

const feedbackForm = reactive({
  pageName: '',
  featureName: '',
  problemSummary: '',
  details: '',
})

const isLoggedIn = computed(() => !!currentUser.value)
const isAdmin = computed(() => currentUser.value?.role === 'admin')
const isPremiumOrAdmin = computed(() => {
  if (!currentUser.value) return false
  return ['admin', 'premium', 'pro'].includes(currentUser.value.role)
})
const isDesktop = ref(typeof window !== 'undefined' ? window.innerWidth >= DESKTOP_BREAKPOINT : true)
const canUseGlassHome = computed(() => {
  if (!currentUser.value) return false
  return ['admin', 'pro'].includes(currentUser.value.role) && isDesktop.value
})
const glassHomeMode = ref(localStorage.getItem(GLASS_HOME_KEY) === 'true' && canUseGlassHome.value)
const showGlassHomeToggle = computed(() => canUseGlassHome.value)
const isGlassShellActive = computed(() => glassHomeMode.value && canUseGlassHome.value)

provide('glassHomeMode', isGlassShellActive)
const displayName = computed(() => currentUser.value?.username || '')
const memberStatusText = computed(() => {
  if (!currentUser.value) return ''
  if (currentUser.value.isBanned) return '已封禁'
  if (currentUser.value.role === 'admin') return '管理员'
  if (currentUser.value.role === 'pro') return 'Pro 用户'
  if (currentUser.value.role === 'premium') {
    const expiresAt = currentUser.value.premiumExpiresAt
    if (!expiresAt || String(expiresAt).includes('2099')) return '高级用户 | 永久'
    const date = new Date(expiresAt)
    if (!Number.isNaN(date.getTime())) {
      return `高级用户 | 至 ${date.toLocaleDateString('zh-CN')}`
    }
    return '高级用户'
  }
  return '普通用户'
})
const memberStatusType = computed(() => {
  if (!currentUser.value) return ''
  if (currentUser.value.isBanned) return 'danger'
  if (currentUser.value.role === 'admin') return 'danger'
  if (currentUser.value.role === 'pro') return 'info'
  if (currentUser.value.role === 'premium') return 'warning'
  return 'success'
})
const activePath = computed(() => route.path)
const routeLabel = computed(() => String(route.name || ''))
const isThemeAuto = computed(() => currentThemeMode.value === 'auto')
const accessDialogTitle = computed(() => {
  if (accessDialogTarget.value === '/gallery') return '共享相册当前仅对高级用户开放'
  if (accessDialogTarget.value === '/recipe') return '赛博菜谱当前仅对高级用户开放'
  if (accessDialogTarget.value === 'quota') return '当前时段额度已用完'
  return '高级用户兑换'
})
const accessDialogSubText = computed(() => {
  if (accessDialogTarget.value === '/gallery') {
    return '普通用户被高级用户加入家庭组后，也可以进入共享相册。'
  }
  if (accessDialogTarget.value === '/recipe') {
    return '开通高级用户后，即可解锁赛博菜谱与更高使用额度。'
  }
  if (accessDialogTarget.value === 'quota') {
    return '开通高级用户后，可获得更高的解析/下载额度，也能解锁更多功能。'
  }
  return membershipConfig.notice
})

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
      { name: '图片无损放大', path: '/image-upscale' },
      { name: '长图拼接', path: '/stitch' },
      { name: '水印生成器', path: '/watermark' },
      { name: '像素画转换', path: '/pixel-art' },
      { name: '图片解混淆', path: '/obfuscate' },
      { name: '证件照制作', path: '/id-photo' },
      { name: '在线PS', path: '/photopea' },
      { name: '网页截图/转PDF', path: '/web-capture' },
    ],
    isOpen: false,
  },
  {
    name: '文件工具',
    icon: Upload,
    children: [
      { name: '文件闪传', path: '/transmit' },
      {
        name: 'PDF 助手',
        isFolder: true,
        isOpen: false,
        children: [
          { name: 'PDF合并', path: '/pdf-merge' },
          { name: 'PDF拆分', path: '/pdf-split' },
          { name: '图片转PDF', path: '/img-to-pdf' },
          { name: 'PDF转图片', path: '/pdf-to-img' },
          { name: 'PDF提取文本', path: '/pdf-extract-text' },
          { name: 'PDF页面编辑', path: '/pdf-page-editor' },
          { name: 'PDF水印', path: '/pdf-watermark' },
          { name: 'PDF签名', path: '/pdf-sign' },
          { name: 'PDF转Word', path: '/pdf-to-word' },
        ],
      },
      { name: '在线压缩解压', path: '/zip-tool' },
    ],
    isOpen: false,
  },
  {
    name: '生活工具',
    icon: KnifeFork,
    children: [
      { name: '赛博菜谱', path: '/recipe' },
      { name: '共享相册', path: '/gallery' },
      {
        name: '影音娱乐',
        isFolder: true,
        isOpen: false,
        children: [
          { name: '音视频下载', path: '/video-download' },
          { name: '电视剧/电影观看', path: '/tv-download' },
          { name: '屏幕录制', path: '/screen-recording' },
          { name: '横屏歌词', path: '/lyrics' },
          { name: '热点趋势', path: '/trends', adminOnly: true },
        ],
      },
      {
        name: '日常与查询',
        isFolder: true,
        isOpen: false,
        children: [
          { name: '气象数据查询', path: '/weather' },
          { name: 'IP归属地查询', path: '/ip-lookup' },
          { name: '随机小助手', path: '/roll-call' },
          { name: '系统更新模拟', path: '/win-update' },
          { name: 'Apex 战绩查询', path: '/apex' },
        ],
      },
    ],
    isOpen: false,
  },
  {
    name: '成为会员',
    icon: Star,
    path: '/membership',
    children: [],
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

async function refreshCurrentUser() {
  const token = localStorage.getItem('lcyksp_token')
  if (!token) return

  try {
    const res = await axios.get('/api/auth/me')
    if (res.data?.user) {
      currentUser.value = res.data.user
      localStorage.setItem('lcyksp_user', JSON.stringify(res.data.user))
    }
  } catch (error) {
    if (error.response?.status === 401) {
      localStorage.removeItem('lcyksp_token')
      localStorage.removeItem('lcyksp_user')
      currentUser.value = null
    }
  }
}

async function loadMembershipConfig() {
  membershipLoading.value = true
  try {
    const res = await axios.get('/api/membership/config')
    membershipConfig.afdianUrl = res.data?.afdianUrl || ''
    membershipConfig.notice = res.data?.notice || membershipConfig.notice
    membershipConfig.plans = Array.isArray(res.data?.plans) ? res.data.plans : []
    membershipConfig.apiReady = Boolean(res.data?.apiReady)
    membershipConfig.apiStatusText = res.data?.apiStatusText || ''
  } catch (error) {
    console.error('加载会员配置失败:', error)
  } finally {
    membershipLoading.value = false
  }
}

function handleLoginSuccess(user) {
  currentUser.value = user
  window.dispatchEvent(new CustomEvent('auth-success'))
}

function syncUserFromStorage() {
  loadUserFromStorage()
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

function canAccessPremiumFeature(path) {
  if (!currentUser.value) {
    return {
      allowed: false,
      message: '请先登录。捐赠成为高级用户后，可获得更高额度并解锁更多功能。',
    }
  }

  if (path === '/recipe') {
    if (['admin', 'premium', 'pro'].includes(currentUser.value.role)) {
      return { allowed: true, message: '' }
    }
    return {
      allowed: false,
      message: '当前用户仅对高级用户开放。捐赠成为高级用户后即可使用赛博菜谱。',
    }
  }

  if (path === '/gallery') {
    if (
      ['admin', 'premium', 'pro'].includes(currentUser.value.role)
      || currentUser.value.groupId
    ) {
      return { allowed: true, message: '' }
    }
    return {
      allowed: false,
      message: '当前用户仅对高级用户开放。普通用户需先被高级用户加入家庭组后才能进入共享相册。',
    }
  }

  return { allowed: true, message: '' }
}

function openAccessDialog(path) {
  accessDialogTarget.value = path
  accessDialogVisible.value = true
}

function openSupportDialogFor(reason = '') {
  accessDialogTarget.value = reason || 'support'
  accessDialogVisible.value = true
}

function showTrendsSuspendedPopup() {
  ElMessageBox({
    title: '系统公告',
    message: `
      <div class="gorgeous-suspended-notice">
        <div class="neon-glow-icon">🔮</div>
        <h3>热点趋势服务已暂停</h3>
        <p class="suspended-description">
          由于功能模块正在进行架构调整与优化升级，热点趋势抓取与数据统计服务自即日起暂停对外服务。
        </p>
        <div class="tech-lines">
          <span class="line-dot"></span>
          <span class="line-status">SERVICE SUSPENDED</span>
          <span class="line-dot"></span>
        </div>
        <p class="suspended-footer">感谢您的理解与配合，敬请期待稍后推出的全新升级版本。</p>
      </div>
    `,
    dangerouslyUseHTMLString: true,
    customClass: 'premium-suspended-dialog',
    confirmButtonText: '我知道了',
    center: true,
    showCancelButton: false
  }).catch(() => {})
}

function handleMenuNavigate(path) {
  if (path === '/trends') {
    showTrendsSuspendedPopup()
    return
  }

  if (path === '/recipe' || path === '/gallery') {
    const access = canAccessPremiumFeature(path)
    if (!access.allowed) {
      ElMessage.warning(access.message)
      openAccessDialog(path)
      return
    }
  }

  navigateTo(path)
}

function isActive(item) {
  if (item.path) return activePath.value === item.path
  if (item.children?.length) {
    return item.children.some((child) => {
      if (child.isFolder) {
        return child.children?.some((sub) => sub.path === activePath.value)
      }
      return child.path === activePath.value
    })
  }
  return false
}

function isSubFolderActive(folder) {
  return folder.children?.some((sub) => sub.path === activePath.value) || false
}

function syncOpenGroups() {
  menuItems.forEach((group) => {
    if (group.children?.length) {
      let groupActive = false
      group.children.forEach((child) => {
        if (child.isFolder) {
          const folderActive = child.children?.some((sub) => sub.path === activePath.value)
          if (folderActive) {
            child.isOpen = true
            groupActive = true
          }
        } else if (child.path === activePath.value) {
          groupActive = true
        }
      })
      group.isOpen = groupActive
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

watch(canUseGlassHome, () => {
  syncGlassHomeAvailability()
})

function handleGlobalSupportDialog(event) {
  openSupportDialogFor(event?.detail?.reason || 'support')
}

function handleGlobalAuthDialog() {
  authDialogVisible.value = true
}

function syncDesktopState() {
  isDesktop.value = window.innerWidth >= DESKTOP_BREAKPOINT
  syncGlassHomeAvailability()
}

function syncGlassBodyClass(active) {
  document.body.classList.toggle('glass-home-body', active)
}

function toggleGlassHomeMode() {
  if (!canUseGlassHome.value) return

  glassHomeMode.value = !glassHomeMode.value
  localStorage.setItem(GLASS_HOME_KEY, String(glassHomeMode.value))

  if (glassHomeMode.value && route.path !== '/') {
    router.push('/')
  }

  ElMessage.success(glassHomeMode.value ? '已切换至记忆大厅' : '已恢复经典主页')
}

function syncGlassHomeAvailability() {
  if (!canUseGlassHome.value && glassHomeMode.value) {
    glassHomeMode.value = false
    localStorage.setItem(GLASS_HOME_KEY, 'false')
  }
}

watch(isGlassShellActive, (active) => {
  syncGlassBodyClass(active)
}, { immediate: true })

onMounted(async () => {
  loadUserFromStorage()
  syncGlassHomeAvailability()
  await refreshCurrentUser()
  syncGlassHomeAvailability()
  loadMembershipConfig()
  syncOpenGroups()
  currentTheme.value = getCurrentTheme()
  currentThemeMode.value = localStorage.getItem(THEME_MODE_KEY) || 'auto'
  window.addEventListener('auth-success', syncUserFromStorage)
  window.addEventListener('open-support-dialog', handleGlobalSupportDialog)
  window.addEventListener('open-auth-dialog', handleGlobalAuthDialog)
  window.addEventListener('resize', syncDesktopState)
})

onUnmounted(() => {
  window.removeEventListener('auth-success', syncUserFromStorage)
  window.removeEventListener('open-support-dialog', handleGlobalSupportDialog)
  window.removeEventListener('open-auth-dialog', handleGlobalAuthDialog)
  window.removeEventListener('resize', syncDesktopState)
  syncGlassBodyClass(false)
})
</script>

<template>
  <VideoBackground :active="isGlassShellActive" />

  <div
    class="shell"
    :class="{
      'sidebar-open': !sidebarCollapsed,
      'glass-shell': isGlassShellActive,
    }"
  >
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
              <template v-for="child in group.children.filter(c => !c.adminOnly || currentUser?.username === 'lcyksp')" :key="child.name">
                <template v-if="child.isFolder">
                  <div
                    class="menu-item submenu-item folder-header"
                    :class="{ active: isSubFolderActive(child) }"
                    @click="child.isOpen = !child.isOpen"
                  >
                    <span class="menu-label">{{ child.name }}</span>
                    <span class="menu-arrow" :class="{ rotated: child.isOpen }">
                      <el-icon :size="12"><ArrowDown /></el-icon>
                    </span>
                  </div>
                  <transition name="slide">
                    <div v-if="child.isOpen" class="sub-submenu">
                      <div
                        v-for="subChild in child.children"
                        :key="subChild.name"
                        class="menu-item sub-submenu-item"
                        :class="{ active: activePath === subChild.path, disabled: subChild.disabled }"
                        @click="!subChild.disabled && handleMenuNavigate(subChild.path)"
                      >
                        <span class="menu-label">{{ subChild.name }}</span>
                        <span v-if="subChild.disabled" class="menu-badge">即将上线</span>
                      </div>
                    </div>
                  </transition>
                </template>
                <!-- Standard Submenu Item Mode -->
                <div
                  v-else
                  class="menu-item submenu-item"
                  :class="{ active: activePath === child.path, disabled: child.disabled }"
                  @click="!child.disabled && handleMenuNavigate(child.path)"
                >
                  <span class="menu-label">{{ child.name }}</span>
                  <span v-if="child.disabled" class="menu-badge">即将上线</span>
                </div>
              </template>
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
          <button
            v-if="showGlassHomeToggle"
            type="button"
            class="glass-home-toggle"
            :class="{ active: glassHomeMode }"
            :title="glassHomeMode ? '切换回经典主页' : '切换至记忆大厅'"
            @click="toggleGlassHomeMode"
          >
            <span class="glass-home-toggle__ring" />
            <el-icon :size="16"><RefreshRight /></el-icon>
          </button>

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
            <el-tag size="small" effect="dark" :type="memberStatusType" :class="['member-status-tag', { 'pro-tag': currentUser?.role === 'pro' }]">
              {{ memberStatusText }}
            </el-tag>
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

    <el-dialog v-model="accessDialogVisible" title="" width="420px" :close-on-click-modal="false" class="support-modal">
      <div class="support-dialog">
        <div class="support-copy">
          <p class="support-copy-single">
            {{ accessDialogTitle }}
          </p>
          <p class="support-copy-sub">
            {{ accessDialogSubText }}
          </p>
        </div>

        <div class="membership-plan-list" v-loading="membershipLoading">
          <div v-for="plan in membershipConfig.plans" :key="plan.key" class="membership-plan-card">
            <strong>{{ plan.description }}</strong>
            <span>{{ plan.name }}</span>
          </div>
        </div>

        <div class="membership-actions">
          <el-button type="primary" @click="navigateTo('/membership'); accessDialogVisible = false">前往会员页面</el-button>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.shell {
  position: relative;
  z-index: 1;
  min-height: 100vh;
  display: flex;
  background:
    radial-gradient(circle at top right, rgba(64, 158, 255, 0.1), transparent 28%),
    linear-gradient(180deg, var(--bg-deep) 0%, color-mix(in srgb, var(--bg-deep) 92%, var(--accent-blue) 8%) 100%);
  transition: background 0.3s ease;
}

.shell.glass-shell {
  background: transparent;
  --bg-deep: transparent;
  --bg-card: rgba(255, 255, 255, 0.04);
  --bg-sidebar: transparent;
  --bg-ctrl: rgba(255, 255, 255, 0.03);
  --bg-hover: rgba(255, 255, 255, 0.06);
  --bg-active: rgba(255, 255, 255, 0.10);
  --bg-input: rgba(255, 255, 255, 0.04);
  --bg-canvas: transparent;
  --border-color: rgba(255, 255, 255, 0.12);
  --border-subtle: rgba(255, 255, 255, 0.06);
  --text-heading: rgba(255, 255, 255, 0.96);
  --text-primary: rgba(255, 255, 255, 0.9);
  --text-secondary: rgba(255, 255, 255, 0.78);
  --text-muted: rgba(255, 255, 255, 0.62);
  --text-dim: rgba(255, 255, 255, 0.52);
}

/* 全透明侧边栏 — 与水珠气泡样式统一 */
.shell.glass-shell .sidebar {
  background: transparent;
  border-right: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: none;
  backdrop-filter: none;
}

.shell.glass-shell .sidebar-header {
  background: transparent;
  margin: 0 12px;
  padding: 16px 12px 12px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 22px;
}

.shell.glass-shell .sidebar-footer {
  background: transparent;
  margin: 0 12px;
  padding: 12px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 18px;
}

.shell.glass-shell .sidebar-logo {
  color: rgba(255, 255, 255, 0.96);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
  font-weight: 700;
  font-size: 1.2rem;
  position: relative;
  z-index: 1;
}

/* 水珠菜单项 — 与底部气泡完全一致 */
.shell.glass-shell .menu-item {
  position: relative;
  isolation: isolate;
  color: rgba(255, 255, 255, 0.88);
  border-radius: 16px;
  margin: 3px 10px;
  padding: 10px 14px;
  background: transparent;
  transition: all 0.25s ease;
  z-index: 0;
}

.shell.glass-shell .menu-item::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  border: 1px solid rgba(255, 255, 255, 0.15);
  background: radial-gradient(circle at 22% 15%, rgba(255, 255, 255, 0.25), transparent 60%);
  z-index: -1;
}

.shell.glass-shell .menu-item:hover {
  color: #fff;
}

.shell.glass-shell .menu-item:hover::before {
  border-color: rgba(255, 255, 255, 0.28);
  background: radial-gradient(circle at 22% 15%, rgba(255, 255, 255, 0.32), transparent 60%);
}

.shell.glass-shell .menu-item.active {
  color: #fff;
}

.shell.glass-shell .menu-item.active::before {
  border-color: rgba(255, 255, 255, 0.30);
  background: radial-gradient(circle at 22% 15%, rgba(255, 255, 255, 0.35), transparent 55%);
}

.shell.glass-shell .menu-arrow {
  color: rgba(255, 255, 255, 0.35);
  position: relative;
  z-index: 1;
}

.shell.glass-shell .menu-label,
.shell.glass-shell .menu-icon {
  position: relative;
  z-index: 1;
}

/* 全透明顶栏 — 与底部气泡样式统一 */
.shell.glass-shell .top-bar {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.15);
  margin: 8px 12px 0;
  padding: 0 16px;
  height: 48px;
  border-radius: 999px;
  box-shadow: none;
  backdrop-filter: none;
}

.shell.glass-shell .main-content {
  background: transparent;
}

.shell.glass-shell .breadcrumb,
.shell.glass-shell .feedback-btn,
.shell.glass-shell .theme-btn,
.shell.glass-shell .theme-auto-btn,
.shell.glass-shell .login-btn,
.shell.glass-shell .user-greeting,
.shell.glass-shell .collapse-btn,
.shell.glass-shell .menu-btn {
  color: rgba(255, 255, 255, 0.92);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.10);
  position: relative;
  z-index: 1;
}

.shell.glass-shell .feedback-control,
.shell.glass-shell .theme-control {
  border-right-color: rgba(255, 255, 255, 0.06);
}

.shell.glass-shell .theme-auto-pill {
  color: rgba(255, 255, 255, 0.92);
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.10);
  border-radius: 999px;
  position: relative;
  z-index: 1;
}

.glass-home-toggle {
  position: relative;
  width: 34px;
  height: 34px;
  border: 1px solid rgba(255, 255, 255, 0.38);
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: rgba(255, 255, 255, 0.96);
  background: linear-gradient(
    145deg,
    rgba(255, 255, 255, 0.14) 0%,
    rgba(255, 255, 255, 0.04) 100%
  );
  box-shadow:
    0 4px 16px rgba(0, 0, 0, 0.16),
    inset 0 1px 0 rgba(255, 255, 255, 0.55);
  transition: transform 0.2s ease, background 0.2s ease, color 0.2s ease;
}

.glass-home-toggle:hover {
  transform: translateY(-1px);
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
}

.glass-home-toggle.active {
  color: #fff;
  background: rgba(64, 158, 255, 0.28);
}

.glass-home-toggle__ring {
  position: absolute;
  inset: -2px;
  border-radius: 50%;
  border: 1px dashed rgba(255, 255, 255, 0.42);
  animation: glass-toggle-spin 6s linear infinite;
  pointer-events: none;
}

.glass-home-toggle.active .glass-home-toggle__ring {
  border-color: rgba(126, 196, 255, 0.72);
}

@keyframes glass-toggle-spin {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
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

.folder-header {
  display: flex !important;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
}

.folder-header .menu-arrow {
  margin-left: auto;
  transition: transform 0.25s ease;
  display: flex;
  align-items: center;
}

.folder-header .menu-arrow.rotated {
  transform: rotate(180deg);
}

.sub-submenu {
  padding-left: 12px;
  background: color-mix(in srgb, var(--bg-sidebar) 90%, transparent);
  border-left: 2px solid var(--border-subtle);
  margin-left: 44px;
  margin-bottom: 4px;
  border-radius: 0 0 6px 6px;
  overflow: hidden;
  transition: all 0.3s ease;
}

.sub-submenu-item {
  height: 36px !important;
  padding-left: 16px !important;
  font-size: 0.8rem !important;
  color: var(--text-secondary) !important;
  border-radius: 4px !important;
  margin: 2px 4px 2px 0 !important;
}

.sub-submenu-item:hover {
  color: var(--text-primary) !important;
  background: var(--bg-hover) !important;
}

.sub-submenu-item.active {
  color: var(--accent-blue) !important;
  background: var(--bg-active) !important;
  font-weight: 500;
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
  max-height: 800px;
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

.member-status-tag {
  margin-right: 2px;
}

.pro-tag {
  background: linear-gradient(135deg, #1a1a2e 0%, #c9a84c 100%) !important;
  border-color: #c9a84c !important;
  color: #fff !important;
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

.support-dialog {
  display: grid;
  gap: 18px;
  text-align: center;
  justify-items: center;
}

.support-copy {
  width: 100%;
  display: grid;
  gap: 8px;
  justify-items: center;
}

.support-copy-single {
  margin: 0;
  color: var(--text-primary);
  font-size: 1.08rem;
  line-height: 1.5;
  font-weight: 600;
  text-align: center;
}

.support-copy-sub {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.86rem;
  line-height: 1.7;
  text-align: center;
}

.support-manual-tip {
  padding: 12px 14px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--bg-input) 84%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent-blue) 14%, var(--border-color));
}

.support-tabs {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.support-tab {
  min-width: 88px;
  border: 1px solid color-mix(in srgb, var(--accent-blue) 28%, transparent);
  background: transparent;
  color: var(--text-secondary);
  border-radius: 999px;
  padding: 8px 14px;
  cursor: pointer;
  transition: all 0.18s ease;
}

.support-tab.active {
  background: color-mix(in srgb, var(--accent-blue) 22%, transparent);
  color: var(--text-primary);
  border-color: color-mix(in srgb, var(--accent-blue) 56%, transparent);
}

.support-qrcode-wrap {
  display: flex;
  justify-content: center;
}

.support-qrcode {
  width: 240px;
  max-width: 100%;
  object-fit: contain;
  border-radius: 0;
  background: transparent;
  padding: 0;
  box-shadow: none;
}

.membership-plan-list {
  width: 100%;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.membership-plan-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--accent-blue) 20%, var(--border-color));
  background: color-mix(in srgb, var(--bg-input) 90%, transparent);
  text-align: center;
}

.membership-plan-card strong {
  color: var(--text-primary);
  font-size: 0.96rem;
}

.membership-plan-card span {
  color: var(--text-secondary);
  font-size: 0.82rem;
}

.membership-actions {
  display: flex;
  justify-content: center;
}

.membership-redeem {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.membership-redeem-label {
  color: var(--text-secondary);
  font-size: 0.84rem;
  text-align: left;
}

:deep(.support-modal .el-dialog__header) {
  margin-right: 0;
  padding-bottom: 0;
  padding-top: 10px;
  min-height: 18px;
}

:deep(.support-modal .el-dialog__title) {
  color: var(--text-primary);
  font-weight: 600;
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

  .member-status-tag {
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .membership-plan-list {
    grid-template-columns: 1fr;
  }

}

/* Premium Suspended Dialog */
:global(.premium-suspended-dialog) {
  background: rgba(19, 19, 35, 0.85) !important;
  backdrop-filter: blur(20px) !important;
  border: 1px solid rgba(139, 92, 246, 0.3) !important; /* purple glow border */
  box-shadow: 0 0 30px rgba(139, 92, 246, 0.25) !important;
  border-radius: 16px !important;
  max-width: 420px !important;
  width: 90% !important;
}

:global(.premium-suspended-dialog .el-message-box__container) {
  display: block !important;
  text-align: center !important;
}

:global(.premium-suspended-dialog .el-message-box__message) {
  padding-left: 0 !important;
  padding-right: 0 !important;
  margin: 0 auto !important;
  text-align: center !important;
}

:global(html[data-theme="light"] .premium-suspended-dialog) {
  background: rgba(255, 255, 255, 0.9) !important;
  backdrop-filter: blur(20px) !important;
  border: 1px solid rgba(99, 102, 241, 0.3) !important;
  box-shadow: 0 10px 40px rgba(99, 102, 241, 0.15) !important;
}

:global(.premium-suspended-dialog .el-message-box__title) {
  color: #a78bfa !important;
  font-size: 16px !important;
  font-weight: 700 !important;
}

:global(html[data-theme="light"] .premium-suspended-dialog .el-message-box__title) {
  color: #4f46e5 !important;
}

:global(.premium-suspended-dialog .el-message-box__close) {
  color: rgba(255, 255, 255, 0.5) !important;
}
:global(html[data-theme="light"] .premium-suspended-dialog .el-message-box__close) {
  color: #4a5568 !important;
}

:global(.premium-suspended-dialog .el-button--primary) {
  background: linear-gradient(135deg, #8b5cf6, #6d28d9) !important;
  border: none !important;
  box-shadow: 0 4px 12px rgba(139, 92, 246, 0.3) !important;
  font-weight: 600 !important;
  border-radius: 8px !important;
  padding: 10px 24px !important;
}

:global(.premium-suspended-dialog .el-button--primary:hover) {
  background: linear-gradient(135deg, #a78bfa, #7c3aed) !important;
  box-shadow: 0 6px 16px rgba(139, 92, 246, 0.5) !important;
}

:global(.gorgeous-suspended-notice) {
  text-align: center;
  padding: 10px 5px;
}

:global(.neon-glow-icon) {
  font-size: 48px;
  margin-bottom: 16px;
  animation: pulse-glow-btn 2s infinite ease-in-out;
  display: inline-block;
  filter: drop-shadow(0 0 12px rgba(139, 92, 246, 0.6));
}

@keyframes pulse-glow-btn {
  0% { transform: scale(1); filter: drop-shadow(0 0 12px rgba(139, 92, 246, 0.6)); }
  50% { transform: scale(1.1); filter: drop-shadow(0 0 24px rgba(139, 92, 246, 0.9)); }
  100% { transform: scale(1); filter: drop-shadow(0 0 12px rgba(139, 92, 246, 0.6)); }
}

:global(.gorgeous-suspended-notice h3) {
  font-size: 20px;
  font-weight: 600;
  margin: 0 0 12px 0 !important;
  background: linear-gradient(135deg, #ff007f, #7928ca);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

:global(html[data-theme="light"] .gorgeous-suspended-notice h3) {
  background: linear-gradient(135deg, #4f46e5, #ec4899);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

:global(.suspended-description) {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.7);
  line-height: 1.6;
  margin: 0 0 20px 0;
}

:global(html[data-theme="light"] .suspended-description) {
  color: #4a5568;
}

:global(.tech-lines) {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-bottom: 20px;
}

:global(.line-dot) {
  width: 4px;
  height: 4px;
  background-color: #8b5cf6;
  border-radius: 50%;
  box-shadow: 0 0 6px #8b5cf6;
}

:global(.line-status) {
  font-size: 10px;
  color: #8b5cf6;
  letter-spacing: 2px;
  font-weight: 700;
}

:global(.suspended-footer) {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
  margin: 0;
}

:global(html[data-theme="light"] .suspended-footer) {
  color: #718096;
}

</style>

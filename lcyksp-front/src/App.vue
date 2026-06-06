<script setup>
/**
 * App.vue V4.0 — 动态多级侧边栏 · 深色美学
 *
 * 菜单数据结构：menuItems 数组，支持无限级 children
 * 点击 V 形图标展开/收起二级菜单
 */
import { ref, computed, onMounted, reactive } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import AuthDialog from './components/AuthDialog.vue'

const router = useRouter()
const route = useRoute()

// ---------- 用户状态 ----------
const authDialogVisible = ref(false)
const currentUser = ref(null)

const isLoggedIn = computed(() => !!currentUser.value)
const isAdmin = computed(() => currentUser.value?.role === 'admin')
const displayName = computed(() => currentUser.value?.username || '')

function loadUserFromStorage() {
  const raw = localStorage.getItem('lcyksp_user')
  if (raw) {
    try { currentUser.value = JSON.parse(raw) }
    catch { currentUser.value = null }
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

onMounted(() => {
  loadUserFromStorage()
})

// ---------- 动态菜单数据 ----------
const menuItems = reactive([
  {
    name: '首页',
    icon: 'HomeFilled',
    path: '/',
    children: [],
    isOpen: false,
  },
  {
    name: '图片工具',
    icon: 'Edit',
    children: [
      { name: '图片压缩', path: '/compress' },
      { name: '格式转换', path: '/convert' },
      { name: '拼豆图纸', path: '/pixel-art' },
      { name: '混淆图', path: '/obfuscate' },
    ],
    isOpen: false,
  },
  {
    name: '文件工具',
    icon: 'Upload',
    children: [
      { name: '文件闪传', path: '/transmit' },
      { name: 'PDF合并', path: null, disabled: true },
    ],
    isOpen: false,
  },
  {
    name: '生活工具',
    icon: 'KnifeFork',
    children: [
      { name: '赛博菜谱', path: '/recipe' },
      { name: '共享相册', path: '/gallery' },
    ],
    isOpen: false,
  },
])

// 管理员菜单（单独处理，始终可见但折叠）
const adminMenuItem = reactive({
  name: '管理后台',
  icon: 'Setting',
  path: '/admin',
  children: [],
  isOpen: false,
})

// ---------- 侧边栏状态 ----------
const sidebarCollapsed = ref(false)

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
}

// ---------- 菜单展开/收起 ----------
function toggleMenu(item) {
  if (item.children && item.children.length > 0) {
    item.isOpen = !item.isOpen
  } else if (item.path) {
    navigateTo(item.path)
  }
}

function navigateTo(path) {
  if (!path) return
  router.push(path)
  // 移动端自动收起侧边栏
  if (window.innerWidth < 768) {
    sidebarCollapsed.value = true
  }
}

// ---------- 当前高亮 ----------
const activePath = computed(() => route.path)

function isActive(item) {
  if (item.path) return activePath.value === item.path
  if (item.children) return item.children.some(c => c.path === activePath.value)
  return false
}
</script>

<template>
  <div class="shell" :class="{ 'sidebar-open': !sidebarCollapsed }">
    <!-- ===== 侧边栏 ===== -->
    <aside class="sidebar" :class="{ collapsed: sidebarCollapsed }">
      <div class="sidebar-header">
        <span class="sidebar-logo" @click="navigateTo('/')">⚡ lcyksp</span>
        <el-button text class="collapse-btn" @click="toggleSidebar">
          <el-icon :size="18">
            <Fold v-if="!sidebarCollapsed" />
            <Expand v-else />
          </el-icon>
        </el-button>
      </div>

      <nav class="sidebar-nav">
        <!-- 动态分组菜单（首页作为第一个分组，已在 menuItems 中） -->
        <div
          v-for="group in menuItems"
          :key="group.name"
          class="menu-group"
        >
          <div
            class="menu-item group-header"
            :class="{ active: isActive(group) }"
            @click="toggleMenu(group)"
          >
            <span class="menu-icon">
              <el-icon :size="18">
                <component :is="group.icon" />
              </el-icon>
            </span>
            <span class="menu-label">{{ group.name }}</span>
            <span
              v-if="group.children && group.children.length > 0"
              class="menu-arrow"
              :class="{ rotated: group.isOpen }"
            >
              <el-icon :size="14"><ArrowDown /></el-icon>
            </span>
          </div>

          <!-- 二级子菜单 -->
          <transition name="slide">
            <div v-if="group.isOpen" class="submenu">
              <div
                v-for="child in group.children"
                :key="child.name"
                class="menu-item submenu-item"
                :class="{
                  active: activePath === child.path,
                  disabled: child.disabled,
                }"
                @click="!child.disabled && navigateTo(child.path)"
              >
                <span class="menu-label">{{ child.name }}</span>
                <span v-if="child.disabled" class="menu-badge">即将上线</span>
              </div>
            </div>
          </transition>
        </div>

        <!-- 管理后台（仅管理员可见） -->
        <div v-if="isAdmin" class="menu-group">
          <div
            class="menu-item group-header"
            :class="{ active: activePath === '/admin' }"
            @click="navigateTo('/admin')"
          >
            <span class="menu-icon">
              <el-icon :size="18"><Setting /></el-icon>
            </span>
            <span class="menu-label">管理后台</span>
          </div>
        </div>
      </nav>

      <div class="sidebar-footer">
        <span>v4.0 · lcyksp.xyz</span>
      </div>
    </aside>

    <!-- ===== 遮罩（移动端） ===== -->
    <div
      v-if="!sidebarCollapsed"
      class="sidebar-overlay"
      @click="sidebarCollapsed = true"
    />

    <!-- ===== 右侧主区域 ===== -->
    <div class="main-area">
      <!-- 顶栏 -->
      <header class="top-bar">
        <div class="top-bar-left">
          <el-button text class="menu-btn" @click="toggleSidebar">
            <el-icon :size="22"><Operation /></el-icon>
          </el-button>
          <span class="breadcrumb">{{ route.name === 'home' ? '' : route.name }}</span>
        </div>

        <div class="top-bar-right">
          <template v-if="isLoggedIn">
            <span class="user-greeting">
              <el-icon><UserFilled /></el-icon>
              {{ displayName }}
            </span>
            <el-button size="small" text @click="handleLogout">退出</el-button>
          </template>
          <template v-else>
            <el-button
              size="small"
              text
              class="login-btn"
              @click="authDialogVisible = true"
            >
              <el-icon><Key /></el-icon>
              <span class="login-label">登录</span>
            </el-button>
          </template>
        </div>
      </header>

      <!-- 主体 -->
      <main class="main-content">
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
    </div>

    <!-- ===== 登录/注册弹窗 ===== -->
    <AuthDialog
      v-model:visible="authDialogVisible"
      @login-success="handleLoginSuccess"
    />
  </div>
</template>

<style scoped>
/* ---------- 全局 ---------- */
.shell {
  min-height: 100vh;
  display: flex;
  background: #0d0d1a;
  transition: all 0.3s ease;
}

/* ---------- 侧边栏 ---------- */
.sidebar {
  width: 220px;
  min-height: 100vh;
  background: #0a0a14;
  border-right: 1px solid #1a1a30;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  transition: width 0.3s ease, transform 0.3s ease;
  z-index: 100;
  overflow: hidden;
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
  border-bottom: 1px solid #1a1a30;
  flex-shrink: 0;
  min-width: 188px;
}

.sidebar-logo {
  font-size: 1.2rem;
  font-weight: 600;
  color: #c0c0e0;
  letter-spacing: 2px;
  cursor: pointer;
  transition: color 0.2s;
}
.sidebar-logo:hover {
  color: #409eff;
}

.collapse-btn {
  color: #666;
}
.collapse-btn:hover {
  color: #c0c0e0;
}

/* ---------- 导航 ---------- */
.sidebar-nav {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
  min-width: 188px;
}

/* 菜单项通用 */
.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  margin: 2px 8px;
  border-radius: 8px;
  cursor: pointer;
  color: #888;
  font-size: 0.9rem;
  transition: all 0.2s ease;
  user-select: none;
  min-height: 40px;
}

.menu-item:hover {
  background: #1a1a30;
  color: #c0c0e0;
}

.menu-item.active {
  background: #1e1e40;
  color: #409eff;
}

.menu-item.disabled {
  opacity: 0.4;
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
  color: #666;
}

.menu-arrow.rotated {
  transform: rotate(-180deg);
}

.menu-badge {
  font-size: 0.65rem;
  color: #888;
  background: #1a1a30;
  padding: 1px 6px;
  border-radius: 4px;
  white-space: nowrap;
}

/* 分组头 */
.group-header {
  font-weight: 500;
}

/* 二级子菜单 */
.submenu {
  overflow: hidden;
}

.submenu-item {
  padding-left: 44px;
  font-size: 0.85rem;
}

/* 展开/收起动画 */
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

/* ---------- 遮罩 ---------- */
.sidebar-overlay {
  display: none;
}

/* ---------- 页脚 ---------- */
.sidebar-footer {
  padding: 12px 16px;
  color: #444;
  font-size: 0.75rem;
  text-align: center;
  border-top: 1px solid #1a1a30;
  flex-shrink: 0;
  min-width: 188px;
}

/* ---------- 右侧主区域 ---------- */
.main-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

/* ---------- 顶栏 ---------- */
.top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 56px;
  padding: 0 20px;
  background: transparent;
  flex-shrink: 0;
  border-bottom: 1px solid #1a1a30;
}

.top-bar-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.menu-btn {
  color: #888;
  font-size: 1.2rem;
  padding: 6px;
  display: flex;
}
.menu-btn:hover {
  color: #c0c0e0;
}

.breadcrumb {
  color: #666;
  font-size: 0.85rem;
  text-transform: capitalize;
}

.top-bar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.user-greeting {
  color: #888;
  font-size: 0.85rem;
  display: flex;
  align-items: center;
  gap: 4px;
}

.login-btn {
  color: #888;
}
.login-btn:hover {
  color: #409eff;
}
.login-label {
  margin-left: 4px;
}

/* ---------- 主体 ---------- */
.main-content {
  flex: 1;
}

/* ---------- 路由过渡 ---------- */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* ---------- 响应式 ---------- */
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
    background: rgba(0, 0, 0, 0.5);
    z-index: 999;
  }


}
</style>

<script setup>
/**
 * App.vue V3.0 — 极简主义 · 动态侧边抽屉 · 多页面路由
 *
 * 布局骨架：
 *   顶栏：左 [☰ 菜单按钮]         右 [用户登录/退出]
 *   主体：<router-view> 淡入淡出过渡
 *   抽屉：el-drawer(ltr) + el-menu(router) 四功能导航
 */
import { ref, computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import AuthDialog from './components/AuthDialog.vue'

const router = useRouter()
const route = useRoute()

// ---------- 抽屉 ----------
const isDrawerOpen = ref(false)

function navigateTo(path) {
  router.push(path)
  isDrawerOpen.value = false
}

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

// ---------- 当前路由名 → 菜单高亮 ----------
const activeMenu = computed(() => route.path)
</script>

<template>
  <div class="shell">
    <!-- ===== 顶栏 ===== -->
    <header class="top-bar">
      <div class="top-bar-left">
        <el-button
          text
          class="menu-btn"
          @click="isDrawerOpen = true"
        >
          <el-icon :size="22"><Operation /></el-icon>
        </el-button>
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

    <!-- ===== 主体：路由视图 + 淡入淡出 ===== -->
    <main class="main-content">
      <router-view v-slot="{ Component }">
        <transition name="fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </main>

    <!-- ===== 左侧抽屉导航 ===== -->
    <el-drawer
      v-model="isDrawerOpen"
      direction="ltr"
      size="240px"
      :with-header="false"
      class="nav-drawer"
    >
      <div class="drawer-header">
        <span class="drawer-logo">⚡ lcyksp</span>
        <el-button text @click="isDrawerOpen = false">
          <el-icon :size="18"><Close /></el-icon>
        </el-button>
      </div>

      <el-menu
        :default-active="activeMenu"
        class="drawer-menu"
        @select="navigateTo"
      >
        <el-menu-item index="/">
          <el-icon><HomeFilled /></el-icon>
          <span>首页</span>
        </el-menu-item>
        <el-menu-item index="/transmit">
          <el-icon><Upload /></el-icon>
          <span>文件闪传</span>
        </el-menu-item>
        <el-menu-item index="/compress">
          <el-icon><Edit /></el-icon>
          <span>图片压缩</span>
        </el-menu-item>
        <el-menu-item index="/convert">
          <el-icon><Refresh /></el-icon>
          <span>格式转换</span>
        </el-menu-item>
        <el-menu-item index="/recipe">
          <el-icon><MagicStick /></el-icon>
          <span>🍳 赛博菜谱</span>
        </el-menu-item>
        <el-menu-item index="/gallery">
          <el-icon><Picture /></el-icon>
          <span>家庭共享相册</span>
        </el-menu-item>
        <el-menu-item v-if="isAdmin" index="/admin">
          <span>🛡️ 管理后台</span>
        </el-menu-item>
      </el-menu>

      <div class="drawer-footer">
        <span>v3.0 · lcyksp.xyz</span>
      </div>
    </el-drawer>

    <!-- ===== 登录/注册弹窗 ===== -->
    <AuthDialog
      v-model:visible="authDialogVisible"
      @login-success="handleLoginSuccess"
    />
  </div>
</template>

<style scoped>
/* ---------- 全局外壳 ---------- */
.shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: #0d0d1a;
}

/* ---------- 顶栏 ---------- */
.top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 56px;
  padding: 0 16px;
  background: transparent;
  flex-shrink: 0;
  border-bottom: 1px solid #1a1a30;
}

.top-bar-left {
  display: flex;
  align-items: center;
}

.menu-btn {
  color: #888;
  font-size: 1.2rem;
  padding: 6px;
}
.menu-btn:hover {
  color: #c0c0e0;
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

/* ---------- 路由过渡动画 ---------- */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* ---------- 抽屉 ---------- */
:deep(.nav-drawer) {
  background: #0a0a14 !important;
}
:deep(.el-drawer__body) {
  padding: 0;
  display: flex;
  flex-direction: column;
}

.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 16px 12px;
  border-bottom: 1px solid #1a1a30;
}

.drawer-logo {
  font-size: 1.2rem;
  font-weight: 600;
  color: #c0c0e0;
  letter-spacing: 2px;
}

.drawer-menu {
  flex: 1;
  border-right: none;
  background: transparent;
}

:deep(.el-menu-item) {
  color: #888;
  height: 48px;
  line-height: 48px;
  margin: 2px 8px;
  border-radius: 8px;
}
:deep(.el-menu-item:hover) {
  background: #1a1a30;
  color: #c0c0e0;
}
:deep(.el-menu-item.is-active) {
  background: #1e1e40;
  color: #409eff;
}

.drawer-footer {
  padding: 12px 16px;
  color: #444;
  font-size: 0.75rem;
  text-align: center;
  border-top: 1px solid #1a1a30;
}
</style>

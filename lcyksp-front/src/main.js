import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import { ElMessage } from 'element-plus'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import axios from 'axios'
import router from './router/index.js'
import App from './App.vue'
import './style.css'

const THEME_KEY = 'lcyksp_theme'
const THEME_LOCK_KEY = 'lcyksp_theme_locked'
const THEME_MODE_KEY = 'lcyksp_theme_mode'

axios.defaults.baseURL = 'http://47.106.101.81:3000'
axios.defaults.timeout = 120000

axios.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('lcyksp_token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => Promise.reject(error),
)

axios.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response) {
      const status = error.response.status
      const data = error.response.data
      const msg = data?.error || data?.message || `请求失败 (${status})`

      if (status === 401 || status === 403) {
        const token = localStorage.getItem('lcyksp_token')
        const isBanMessage = /封禁/.test(String(msg || ''))
        if (token && !isBanMessage && status === 401) {
          localStorage.removeItem('lcyksp_token')
          localStorage.removeItem('lcyksp_user')
          ElMessage.error('登录已失效，请重新登录')
        } else {
          ElMessage.error(msg)
        }
      } else {
        ElMessage.error(msg)
      }
    } else if (error.request) {
      ElMessage.error('网络连接失败，请检查后端是否已启动')
    }
    return Promise.reject(error)
  },
)

function getThemeFromTime() {
  const hour = new Date().getHours()
  return hour >= 18 || hour < 6 ? 'dark' : 'light'
}

function applyTheme(theme) {
  const html = document.documentElement
  if (theme === 'light') {
    html.setAttribute('data-theme', 'light')
    html.classList.remove('dark')
  } else {
    html.removeAttribute('data-theme')
    html.classList.add('dark')
  }
  localStorage.setItem(THEME_KEY, theme)
}

function initializeTheme() {
  const html = document.documentElement
  html.classList.remove('dark')

  const savedTheme = localStorage.getItem(THEME_KEY)
  if (savedTheme === 'light' || savedTheme === 'dark') {
    applyTheme(savedTheme)
    return
  }
  applyTheme(getThemeFromTime())
}

initializeTheme()

setInterval(() => {
  const current = localStorage.getItem(THEME_KEY)
  if (!localStorage.getItem(THEME_LOCK_KEY)) {
    const autoTheme = getThemeFromTime()
    if (autoTheme !== current) {
      applyTheme(autoTheme)
    }
  }
}, 3600000)

export function toggleTheme() {
  const html = document.documentElement
  const isDark = !html.hasAttribute('data-theme')
  const newTheme = isDark ? 'light' : 'dark'
  applyTheme(newTheme)
  localStorage.setItem(THEME_LOCK_KEY, 'true')
  localStorage.setItem(THEME_MODE_KEY, newTheme)
  return newTheme
}

export function setThemeMode(mode) {
  const theme = mode === 'light' || mode === 'dark' ? mode : getThemeFromTime()
  applyTheme(theme)

  if (mode === 'light' || mode === 'dark') {
    localStorage.setItem(THEME_LOCK_KEY, 'true')
    localStorage.setItem(THEME_MODE_KEY, mode)
  } else {
    localStorage.removeItem(THEME_LOCK_KEY)
    localStorage.setItem(THEME_MODE_KEY, 'auto')
  }

  return theme
}

export function resetThemeAuto() {
  localStorage.removeItem(THEME_LOCK_KEY)
  localStorage.setItem(THEME_MODE_KEY, 'auto')
  return setThemeMode('auto')
}

export function getCurrentTheme() {
  return document.documentElement.hasAttribute('data-theme') ? 'light' : 'dark'
}

const app = createApp(App)

for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.use(ElementPlus)
app.use(router)
app.mount('#app')

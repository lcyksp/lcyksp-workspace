import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import { ElMessage } from 'element-plus'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import axios from 'axios'
import router from './router/index.js'
import App from './App.vue'

// ---------- Axios 全局配置 ----------
// 生产环境：强制指向云端后端 3000 端口
axios.defaults.baseURL = 'http://47.106.101.81:3000'
axios.defaults.timeout = 120000 // 大文件上传限 120s

// 请求拦截器：自动注入 Authorization 头
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

// 响应拦截器：统一错误提示 + 401/403 Token 失效处理
axios.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response) {
      const status = error.response.status
      const data = error.response.data
      const msg = data?.error || data?.message || `请求失败 (${status})`

      // Token 失效 → 清除本地 Token
      if (status === 401 || status === 403) {
        const token = localStorage.getItem('lcyksp_token')
        if (token) {
          localStorage.removeItem('lcyksp_token')
          ElMessage.error('登录已过期，请重新登录')
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

// ---------- 挂载 ----------
const app = createApp(App)

// 注册所有 Element Plus 图标（全局可用）
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.use(ElementPlus)
app.use(router)

// 启用 Element Plus 暗黑模式
document.documentElement.classList.add('dark')

app.mount('#app')

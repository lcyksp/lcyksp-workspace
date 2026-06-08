<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import axios from 'axios'

const emit = defineEmits(['login-success'])
const dialogVisible = defineModel('visible', { type: Boolean, default: false })

const TURNSTILE_SCRIPT_ID = 'cf-turnstile-script'
const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

const mode = ref('login')
const loading = ref(false)
const turnstileToken = ref('')
const turnstileWidgetId = ref(null)
const turnstileReady = ref(false)
const turnstileContainer = ref(null)
const turnstileEnabled = computed(() => Boolean(import.meta.env.VITE_TURNSTILE_SITE_KEY))

const form = reactive({
  username: '',
  password: '',
  confirmPassword: '',
})

function resetForm() {
  form.username = ''
  form.password = ''
  form.confirmPassword = ''
  turnstileToken.value = ''
  resetTurnstileWidget()
}

function switchMode(nextMode) {
  mode.value = nextMode
  resetForm()
}

function ensureTurnstileScript() {
  if (!turnstileEnabled.value) return Promise.resolve()
  if (window.turnstile) {
    turnstileReady.value = true
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    const existing = document.getElementById(TURNSTILE_SCRIPT_ID)
    if (existing) {
      existing.addEventListener('load', () => {
        turnstileReady.value = true
        resolve()
      }, { once: true })
      existing.addEventListener('error', reject, { once: true })
      return
    }

    const script = document.createElement('script')
    script.id = TURNSTILE_SCRIPT_ID
    script.src = TURNSTILE_SRC
    script.async = true
    script.defer = true
    script.onload = () => {
      turnstileReady.value = true
      resolve()
    }
    script.onerror = reject
    document.head.appendChild(script)
  })
}

function resetTurnstileWidget() {
  if (window.turnstile && turnstileWidgetId.value !== null) {
    try {
      window.turnstile.reset(turnstileWidgetId.value)
    } catch {
      // ignore
    }
  }
  turnstileToken.value = ''
}

async function renderTurnstile() {
  if (!turnstileEnabled.value || mode.value !== 'register' || !dialogVisible.value) return
  await ensureTurnstileScript()
  await nextTick()
  if (!turnstileContainer.value || !window.turnstile) return

  if (turnstileWidgetId.value !== null) {
    try {
      window.turnstile.reset(turnstileWidgetId.value)
      return
    } catch {
      turnstileWidgetId.value = null
      turnstileContainer.value.innerHTML = ''
    }
  }

  turnstileWidgetId.value = window.turnstile.render(turnstileContainer.value, {
    sitekey: import.meta.env.VITE_TURNSTILE_SITE_KEY,
    theme: document.documentElement.hasAttribute('data-theme') ? 'light' : 'dark',
    callback: (token) => {
      turnstileToken.value = token
    },
    'expired-callback': () => {
      turnstileToken.value = ''
    },
    'error-callback': () => {
      turnstileToken.value = ''
      ElMessage.error('人机验证加载失败，请稍后重试')
    },
  })
}

async function handleSubmit() {
  if (!form.username || !form.password) {
    ElMessage.warning('请填写用户名和密码')
    return
  }
  if (form.username.length < 2 || form.username.length > 32) {
    ElMessage.warning('用户名长度需为 2-32 个字符')
    return
  }
  if (form.password.length < 6) {
    ElMessage.warning('密码至少需要 6 位')
    return
  }
  if (mode.value === 'register' && form.password !== form.confirmPassword) {
    ElMessage.warning('两次输入的密码不一致')
    return
  }
  if (mode.value === 'register' && turnstileEnabled.value && !turnstileToken.value) {
    ElMessage.warning('请先完成人机验证')
    return
  }

  loading.value = true
  try {
    const endpoint = mode.value === 'login' ? '/api/auth/login' : '/api/auth/register'
    const payload = {
      username: form.username.trim(),
      password: form.password,
    }

    if (mode.value === 'register') {
      payload.turnstileToken = turnstileToken.value
    }

    const res = await axios.post(endpoint, payload)
    const { token, user } = res.data
    localStorage.setItem('lcyksp_token', token)
    localStorage.setItem('lcyksp_user', JSON.stringify(user))

    ElMessage.success(mode.value === 'login' ? '登录成功' : '注册成功')
    dialogVisible.value = false
    emit('login-success', user)
    resetForm()
  } finally {
    loading.value = false
  }
}

watch([dialogVisible, mode], async ([visible, currentMode]) => {
  if (visible && currentMode === 'register') {
    await renderTurnstile()
  }
})

onBeforeUnmount(() => {
  resetTurnstileWidget()
})
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    :title="mode === 'login' ? '登录账号' : '注册账号'"
    width="min(400px, calc(100vw - 24px))"
    :close-on-click-modal="false"
    top="14vh"
    class="auth-dialog"
    @closed="resetForm"
  >
    <el-form label-position="top" size="large" @keyup.enter="handleSubmit">
      <el-form-item label="用户名">
        <el-input v-model="form.username" placeholder="输入用户名" clearable />
      </el-form-item>

      <el-form-item label="密码">
        <el-input v-model="form.password" type="password" show-password placeholder="输入密码" />
      </el-form-item>

      <el-form-item v-if="mode === 'register'" label="确认密码">
        <el-input v-model="form.confirmPassword" type="password" show-password placeholder="再次输入密码" />
      </el-form-item>

      <div v-if="mode === 'register'" class="register-notice">
        暂不支持找回密码，请务必记住你的密码。
      </div>

      <el-form-item v-if="mode === 'register' && turnstileEnabled" label="人机验证">
        <div ref="turnstileContainer" class="turnstile-box" />
        <div class="turnstile-hint">请完成人机验证后再提交注册。</div>
      </el-form-item>
    </el-form>

    <template #footer>
      <div class="dialog-footer">
        <el-button type="primary" size="large" :loading="loading" class="submit-btn" @click="handleSubmit">
          {{ loading ? '提交中...' : mode === 'login' ? '登录' : '注册' }}
        </el-button>

        <div class="switch-hint">
          <template v-if="mode === 'login'">
            还没有账号？
            <el-link type="primary" :underline="false" @click="switchMode('register')">立即注册</el-link>
          </template>
          <template v-else>
            已有账号？
            <el-link type="primary" :underline="false" @click="switchMode('login')">去登录</el-link>
          </template>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.dialog-footer {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.submit-btn {
  width: 100%;
}

.switch-hint {
  text-align: center;
  color: var(--text-secondary, #909399);
  font-size: 0.92rem;
}

.turnstile-box {
  min-height: 66px;
}

.register-notice {
  margin: -2px 0 14px;
  padding: 10px 12px;
  border-radius: 12px;
  color: var(--text-secondary, #909399);
  font-size: 0.82rem;
  line-height: 1.6;
  background: color-mix(in srgb, var(--bg-hover, #1f2438) 82%, transparent);
  border: 1px solid color-mix(in srgb, var(--border-color, #2f3654) 88%, transparent);
}

.turnstile-hint {
  margin-top: 8px;
  color: var(--text-secondary, #909399);
  font-size: 0.8rem;
  line-height: 1.5;
}

:deep(.auth-dialog .el-dialog) {
  max-width: calc(100vw - 24px);
}

@media (max-width: 640px) {
  :deep(.auth-dialog .el-dialog) {
    margin-top: 8vh !important;
  }
}
</style>

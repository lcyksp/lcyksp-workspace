<script setup>
/**
 * AuthDialog.vue — 登录/注册弹窗组件
 * 支持登录与注册表单切换，登录成功后将 Token 存入 localStorage
 */
import { ref, reactive } from 'vue'
import { ElMessage } from 'element-plus'
import axios from 'axios'

const emit = defineEmits(['login-success'])

const dialogVisible = defineModel('visible', { type: Boolean, default: false })

// 当前模式: 'login' | 'register'
const mode = ref('login')

// 表单数据
const form = reactive({
  username: '',
  password: '',
  confirmPassword: '',
})

const loading = ref(false)

// ---------- 切换模式 ----------
function switchMode(newMode) {
  mode.value = newMode
  form.username = ''
  form.password = ''
  form.confirmPassword = ''
}

// ---------- 提交 ----------
async function handleSubmit() {
  // 基本校验
  if (!form.username || !form.password) {
    ElMessage.warning('请填写用户名和密码')
    return
  }
  if (form.username.length < 2 || form.username.length > 32) {
    ElMessage.warning('用户名长度为 2-32 个字符')
    return
  }
  if (form.password.length < 6) {
    ElMessage.warning('密码至少 6 个字符')
    return
  }
  if (mode.value === 'register' && form.password !== form.confirmPassword) {
    ElMessage.warning('两次密码输入不一致')
    return
  }

  loading.value = true
  try {
    const url = mode.value === 'login' ? '/api/auth/login' : '/api/auth/register'
    const res = await axios.post(url, {
      username: form.username,
      password: form.password,
    })

    const { token, user } = res.data

    // 保存 Token
    localStorage.setItem('lcyksp_token', token)
    localStorage.setItem('lcyksp_user', JSON.stringify(user))

    ElMessage.success(mode.value === 'login' ? '登录成功！' : '注册成功！')
    dialogVisible.value = false
    emit('login-success', user)
  } catch (err) {
    // 拦截器已处理错误提示
    console.error('Auth failed:', err)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    :title="mode === 'login' ? '🔑 登录大本营' : '📝 注册账号'"
    width="360px"
    :close-on-click-modal="false"
    top="20vh"
  >
    <el-form
      label-position="top"
      size="large"
      @keyup.enter="handleSubmit"
    >
      <el-form-item label="用户名">
        <el-input
          v-model="form.username"
          placeholder="输入用户名"
          :prefix-icon="'User'"
          clearable
        />
      </el-form-item>

      <el-form-item label="密码">
        <el-input
          v-model="form.password"
          type="password"
          show-password
          placeholder="输入密码"
          :prefix-icon="'Lock'"
        />
      </el-form-item>

      <!-- 注册时显示确认密码 -->
      <el-form-item v-if="mode === 'register'" label="确认密码">
        <el-input
          v-model="form.confirmPassword"
          type="password"
          show-password
          placeholder="再次输入密码"
          :prefix-icon="'Lock'"
        />
      </el-form-item>
    </el-form>

    <template #footer>
      <div class="dialog-footer">
        <el-button
          type="primary"
          size="large"
          :loading="loading"
          style="width: 100%"
          @click="handleSubmit"
        >
          {{ loading ? '处理中…' : (mode === 'login' ? '登录' : '注册') }}
        </el-button>

        <div class="switch-hint">
          <template v-if="mode === 'login'">
            还没有账号？
            <el-link type="primary" :underline="false" @click="switchMode('register')">
              立即注册
            </el-link>
          </template>
          <template v-else>
            已有账号？
            <el-link type="primary" :underline="false" @click="switchMode('login')">
              去登录
            </el-link>
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

.switch-hint {
  text-align: center;
  color: #888;
  font-size: 0.9rem;
}
</style>

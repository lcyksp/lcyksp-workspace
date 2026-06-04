<script setup>
/**
 * RecipeView.vue — 赛博菜谱（AI Kitchen & Recipe Bank）
 *
 * 功能：搜索栏 + 瀑布流卡片 + AI 流式续写做法 + 自创菜式
 */
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import axios from 'axios'

// ---------- 搜索 ----------
const searchQuery = ref('')
const recipes = ref([])
const searching = ref(false)
let searchTimer = null

async function doSearch() {
  const q = searchQuery.value.trim()
  if (!q) {
    recipes.value = []
    return
  }
  searching.value = true
  try {
    const res = await axios.get('/api/recipe/search', { params: { q } })
    recipes.value = res.data.recipes
  } catch (err) {
    console.error('搜索菜谱失败:', err)
  } finally {
    searching.value = false
  }
}

function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(doSearch, 300)
}

// ---------- SSE 流式续写 ----------
const streamingId = ref(null)      // 当前正在流式加载的 recipe id
const streamContents = ref({})     // { [recipeId]: '已接收的文本' }
const streamErrors = ref({})       // { [recipeId]: '错误信息' }

async function startStream(recipe) {
  // 如果已有内容，重置
  streamContents.value[recipe.id] = ''
  streamErrors.value[recipe.id] = ''
  streamingId.value = recipe.id

  try {
    const res = await fetch(`/api/recipe/${recipe.id}/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })

    if (!res.ok) {
      const errData = await res.json().catch(() => ({ error: '请求失败' }))
      streamErrors.value[recipe.id] = errData.error || `请求失败 (${res.status})`
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue
        const data = trimmed.slice(6)
        if (data === '[DONE]') continue

        try {
          const parsed = JSON.parse(data)
          if (parsed.meta) {
            // 元信息，忽略
          } else if (parsed.content) {
            streamContents.value[recipe.id] = (streamContents.value[recipe.id] || '') + parsed.content
          } else if (parsed.error) {
            streamErrors.value[recipe.id] = parsed.error
          }
        } catch { /* skip */ }
      }
    }

    // 消费剩余 buffer
    if (buffer.trim().startsWith('data: ')) {
      const data = buffer.trim().slice(6)
      if (data !== '[DONE]') {
        try {
          const parsed = JSON.parse(data)
          if (parsed.content) {
            streamContents.value[recipe.id] = (streamContents.value[recipe.id] || '') + parsed.content
          }
        } catch { /* skip */ }
      }
    }
  } catch (err) {
    streamErrors.value[recipe.id] = '网络连接失败: ' + err.message
  } finally {
    if (streamingId.value === recipe.id) {
      streamingId.value = null
    }
  }
}

// ---------- 添加自创菜式 ----------
const addDialogVisible = ref(false)
const addForm = ref({ name: '', ingredients: '', tags: '' })
const adding = ref(false)

function openAddDialog() {
  addForm.value = { name: '', ingredients: '', tags: '' }
  addDialogVisible.value = true
}

async function submitAdd() {
  const name = addForm.value.name.trim()
  if (!name) {
    ElMessage.warning('请输入菜名')
    return
  }

  adding.value = true
  try {
    const tags = addForm.value.tags.split(/[,，\s]+/).filter(Boolean)
    await axios.post('/api/recipe', {
      name,
      ingredients: addForm.value.ingredients.trim(),
      tags,
    })
    ElMessage.success(`「${name}」已加入私房菜资产库！`)
    addDialogVisible.value = false
    // 如果当前有搜索词，重新搜索
    if (searchQuery.value.trim()) {
      doSearch()
    }
  } catch (err) {
    // 拦截器已提示
  } finally {
    adding.value = false
  }
}

// ---------- 工具 ----------
const hasStreamContent = (id) => streamContents.value[id] && streamContents.value[id].length > 0
const isStreaming = (id) => streamingId.value === id
const getStreamError = (id) => streamErrors.value[id] || ''
</script>

<template>
  <div class="recipe-view">
    <!-- 页头 -->
    <div class="recipe-header">
      <div>
        <h2 class="page-title"><span class="title-icon">🍳</span> 赛博菜谱</h2>
        <p class="page-desc">检索本地私房菜资产库 · AI 流式续写做法</p>
      </div>
      <el-button type="primary" @click="openAddDialog">
        <el-icon><Plus /></el-icon> 添加自创菜式
      </el-button>
    </div>

    <!-- 搜索栏 -->
    <div class="search-bar">
      <el-input
        v-model="searchQuery"
        placeholder="输入关键词搜索菜谱，如「番茄」「牛肉」…"
        size="large"
        clearable
        :prefix-icon="'Search'"
        @input="onSearchInput"
        @keyup.enter="doSearch"
      />
      <el-button
        size="large"
        type="primary"
        :loading="searching"
        @click="doSearch"
      >
        搜索
      </el-button>
    </div>

    <!-- 加载中 -->
    <div v-if="searching" class="loading-state">
      <el-icon class="is-loading" :size="32"><Loading /></el-icon>
      <span>检索中…</span>
    </div>

    <!-- 空状态 -->
    <el-empty v-else-if="searchQuery.trim() && recipes.length === 0" description="没有找到匹配的菜谱，试试其他关键词或添加自创菜式！" />
    <el-empty v-else-if="!searchQuery.trim()" description="输入关键词，搜索你的私房菜资产库" />

    <!-- 瀑布流卡片 -->
    <div v-if="recipes.length > 0" class="recipe-grid">
      <div
        v-for="recipe in recipes"
        :key="recipe.id"
        class="recipe-card"
      >
        <!-- 卡片头部 -->
        <div class="card-header">
          <h3 class="card-title">{{ recipe.name }}</h3>
          <div v-if="recipe.tags.length > 0" class="card-tags">
            <el-tag
              v-for="tag in recipe.tags"
              :key="tag"
              size="small"
              effect="dark"
              type="info"
            >
              {{ tag }}
            </el-tag>
          </div>
        </div>

        <!-- 原料 -->
        <div v-if="recipe.ingredients" class="card-section">
          <span class="section-label">🥘 原料：</span>
          <span class="section-text">{{ recipe.ingredients }}</span>
        </div>

        <!-- AI 续写做法区域 -->
        <div class="card-ai-section">
          <el-button
            v-if="!isStreaming(recipe.id) && !hasStreamContent(recipe.id)"
            class="ai-btn"
            size="small"
            @click="startStream(recipe)"
          >
            <el-icon :size="14"><MagicStick /></el-icon>
            我不会做 — AI 教我
          </el-button>

          <!-- 加载中动画 -->
          <div v-if="isStreaming(recipe.id)" class="stream-loading">
            <el-icon class="is-loading" :size="16"><Loading /></el-icon>
            <span>AI 正在编写做法…</span>
          </div>

          <!-- 打字机效果 -->
          <div
            v-if="hasStreamContent(recipe.id)"
            class="stream-content"
          >
            <div class="section-label">📝 AI 做法：</div>
            <div class="typewriter-text">{{ streamContents[recipe.id] }}</div>
          </div>

          <!-- 错误提示 -->
          <div v-if="getStreamError(recipe.id)" class="stream-error">
            <el-icon :size="14"><WarningFilled /></el-icon>
            {{ getStreamError(recipe.id) }}
          </div>

          <!-- 重新生成 -->
          <el-button
            v-if="hasStreamContent(recipe.id) && !isStreaming(recipe.id)"
            text
            size="small"
            class="retry-btn"
            @click="startStream(recipe)"
          >
            <el-icon><Refresh /></el-icon> 重新生成
          </el-button>
        </div>
      </div>
    </div>

    <!-- ====== 添加菜式弹窗 ====== -->
    <el-dialog
      v-model="addDialogVisible"
      title="🍳 添加自创菜式"
      width="420px"
      :close-on-click-modal="false"
    >
      <el-form label-position="top" size="large">
        <el-form-item label="菜名">
          <el-input
            v-model="addForm.name"
            placeholder="如：番茄鸡蛋肉沫"
            clearable
          />
        </el-form-item>
        <el-form-item label="主要原料">
          <el-input
            v-model="addForm.ingredients"
            placeholder="如：番茄 2 个、鸡蛋 3 个、肉沫 100g"
            clearable
          />
        </el-form-item>
        <el-form-item label="标签（逗号分隔）">
          <el-input
            v-model="addForm.tags"
            placeholder="如：快手菜,下饭菜,番茄"
            clearable
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="adding" @click="submitAdd">
          {{ adding ? '添加中…' : '一铲子写入' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.recipe-view {
  max-width: 960px;
  margin: 0 auto;
  padding: 20px 16px 40px;
}

.recipe-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 20px;
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

/* 搜索栏 */
.search-bar {
  display: flex;
  gap: 10px;
  margin-bottom: 24px;
}
.search-bar .el-input {
  flex: 1;
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

/* 瀑布流网格 */
.recipe-grid {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 卡片 */
.recipe-card {
  background: #16162a;
  border-radius: 12px;
  border: 1px solid #222244;
  padding: 20px;
  transition: border-color 0.2s;
}
.recipe-card:hover {
  border-color: #333366;
}

.card-header {
  margin-bottom: 12px;
}

.card-title {
  font-size: 1.2rem;
  font-weight: 600;
  color: #c0c0e0;
  margin: 0 0 8px;
  letter-spacing: 1px;
}

.card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.card-section {
  margin-bottom: 8px;
  color: #999;
  font-size: 0.9rem;
  line-height: 1.5;
}

.section-label {
  color: #888;
  font-weight: 500;
}

.section-text {
  color: #aaa;
}

/* AI 区域 */
.card-ai-section {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #1a1a30;
}

.ai-btn {
  color: #f0c040;
  border-color: #f0c040;
  background: transparent;
}
.ai-btn:hover {
  background: #f0c040;
  color: #1a1a2e;
}

.stream-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #f0c040;
  font-size: 0.85rem;
}

.stream-content {
  background: #0d0d1a;
  border-radius: 8px;
  padding: 12px 16px;
}

.typewriter-text {
  color: #c0c0e0;
  font-size: 0.9rem;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  margin-top: 6px;
}

.stream-error {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #e74c3c;
  font-size: 0.85rem;
  padding: 8px 12px;
  background: #1a0a0a;
  border-radius: 6px;
}

.retry-btn {
  margin-top: 8px;
  color: #888;
}

@media (max-width: 480px) {
  .recipe-view { padding: 12px 10px 30px; }
  .search-bar { flex-direction: column; }
}
</style>

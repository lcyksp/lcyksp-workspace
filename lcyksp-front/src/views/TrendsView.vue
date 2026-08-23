<script setup>
import { ref, onMounted, nextTick } from 'vue'
import { ElMessage } from 'element-plus'

const activePlatform = ref('bilibili')
const hotList = ref([])
const loading = ref(false)
const searchKeyword = ref('')
const searchResult = ref(null)
const searchLoading = ref(false)
const historyData = ref([])
const historyLoading = ref(false)
const historyKeyword = ref('')
const canvasRef = ref(null)

// Custom followed keywords/BGMs state
const followedItems = ref([])
const followedData = ref({})
const newFollowKeyword = ref('')

function authFetch(url, options = {}) {
  const token = localStorage.getItem('lcyksp_token') || ''
  console.log('[Trends] authFetch:', url, 'token:', token ? token.slice(0, 10) + '...' : 'EMPTY')
  return fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(options.headers || {}),
    },
  })
}

const PLATFORMS = [
  { key: 'bilibili', name: 'B站', icon: '📺', color: '#00a1d6' },
  { key: 'douyin', name: '抖音', icon: '🎵', color: '#fe2c55' },
  { key: 'xiaohongshu', name: '小红书', icon: '📕', color: '#ff2442' },
]

async function fetchHot() {
  loading.value = true
  hotList.value = []
  try {
    const res = await authFetch(`/api/trends/hot?platform=${activePlatform.value}`)
    const data = await res.json()
    hotList.value = data.data?.[activePlatform.value] || []
    if (hotList.value.length === 0) {
      ElMessage.info('暂无热搜数据，可能需要配置 cookies')
    }
  } catch {
    ElMessage.error('获取热搜失败')
  } finally {
    loading.value = false
  }
}

async function searchTrend() {
  if (!searchKeyword.value.trim()) return
  searchLoading.value = true
  searchResult.value = null
  try {
    const res = await authFetch(`/api/trends/search?q=${encodeURIComponent(searchKeyword.value)}&platform=${activePlatform.value}`)
    const data = await res.json()
    searchResult.value = data.results?.[0] || null

    const hotItem = hotList.value.find(h => h.keyword === searchKeyword.value)
    if (hotItem) {
      searchResult.value = {
        ...searchResult.value,
        keyword: hotItem.keyword,
        count: hotItem.score || searchResult.value?.count || 0,
        rank: hotItem.rank,
      }
    }

    await fetchHistory(searchKeyword.value)
  } catch {
    ElMessage.error('搜索失败')
  } finally {
    searchLoading.value = false
  }
}

async function fetchHistory(keyword) {
  historyLoading.value = true
  historyKeyword.value = keyword
  historyData.value = []
  try {
    const res = await authFetch(`/api/trends/history?q=${encodeURIComponent(keyword)}&platform=${activePlatform.value}&days=7`)
    const data = await res.json()
    historyData.value = data.history || []
    if (historyData.value.length > 0) {
      nextTick(() => {
        drawChart()
      })
    }
  } catch {
    // silent
  } finally {
    historyLoading.value = false
  }
}

function drawChart() {
  const canvas = canvasRef.value
  if (!canvas || historyData.value.length === 0) return
  const ctx = canvas.getContext('2d')
  const W = canvas.width = canvas.offsetWidth * 2
  const H = canvas.height = canvas.offsetHeight * 2
  ctx.scale(2, 2)
  const w = W / 2
  const h = H / 2

  ctx.clearRect(0, 0, w, h)

  const data = historyData.value.map(d => d.score || d.rank || 0)
  if (data.length === 0) return

  let maxVal = Math.max(...data)
  let minVal = Math.min(...data)
  if (data.length === 1) {
    minVal = 0
    maxVal = data[0] ? data[0] * 1.5 : 10
  }
  const range = maxVal - minVal || 1
  const padding = { top: 20, right: 20, bottom: 30, left: 50 }
  const chartW = w - padding.left - padding.right
  const chartH = h - padding.top - padding.bottom

  const isDark = document.documentElement.classList.contains('dark')
  const gridColor = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.08)'
  const textColor = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.7)'
  const dateColor = isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.6)'
  const themeColor = isDark ? '#38bdf8' : '#0284c7'
  const themeColorGlow = isDark ? 'rgba(56,189,248,0.3)' : 'rgba(2,132,199,0.2)'
  const themeGradientStart = isDark ? 'rgba(56,189,248,0.3)' : 'rgba(2,132,199,0.25)'

  ctx.strokeStyle = gridColor
  ctx.lineWidth = 0.5
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (chartH / 4) * i
    ctx.beginPath()
    ctx.moveTo(padding.left, y)
    ctx.lineTo(w - padding.right, y)
    ctx.stroke()

    ctx.fillStyle = textColor
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'right'
    const val = maxVal - (range / 4) * i
    ctx.fillText(Math.round(val).toLocaleString(), padding.left - 5, y + 4)
  }

  if (data.length === 1) {
    const x = padding.left + chartW / 2
    const y = padding.top + chartH - ((data[0] - minVal) / range) * chartH
    ctx.beginPath()
    ctx.arc(x, y, 6, 0, Math.PI * 2)
    ctx.fillStyle = themeColor
    ctx.fill()
    ctx.beginPath()
    ctx.arc(x, y, 10, 0, Math.PI * 2)
    ctx.strokeStyle = themeColorGlow
    ctx.lineWidth = 2
    ctx.stroke()

    ctx.fillStyle = themeColor
    ctx.font = 'bold 12px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(data[0].toLocaleString(), x, y - 16)

    if (historyData.value.length > 0) {
      ctx.fillStyle = dateColor
      ctx.font = '10px sans-serif'
      ctx.textAlign = 'center'
      const first = historyData.value[0]?.created_at?.slice(5, 16) || ''
      ctx.fillText(first, x, h - 8)
    }
    return
  }

  const gradient = ctx.createLinearGradient(0, padding.top, 0, h - padding.bottom)
  gradient.addColorStop(0, themeGradientStart)
  gradient.addColorStop(1, 'rgba(56,189,248,0)')

  ctx.beginPath()
  data.forEach((val, i) => {
    const x = padding.left + (chartW / (data.length - 1)) * i
    const y = padding.top + chartH - ((val - minVal) / range) * chartH
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  ctx.strokeStyle = themeColor
  ctx.lineWidth = 2
  ctx.stroke()

  const lastX = padding.left + chartW
  const lastY = padding.top + chartH - ((data[data.length - 1] - minVal) / range) * chartH
  ctx.lineTo(lastX, padding.top + chartH)
  ctx.lineTo(padding.left, padding.top + chartH)
  ctx.closePath()
  ctx.fillStyle = gradient
  ctx.fill()

  data.forEach((val, i) => {
    const x = padding.left + (chartW / (data.length - 1)) * i
    const y = padding.top + chartH - ((val - minVal) / range) * chartH
    ctx.beginPath()
    ctx.arc(x, y, 3, 0, Math.PI * 2)
    ctx.fillStyle = themeColor
    ctx.fill()
  })

  if (historyData.value.length > 0) {
    ctx.fillStyle = dateColor
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'center'
    const first = historyData.value[0]?.created_at?.slice(5, 16) || ''
    const last = historyData.value[historyData.value.length - 1]?.created_at?.slice(5, 16) || ''
    ctx.fillText(first, padding.left, h - 8)
    ctx.fillText(last, w - padding.right, h - 8)
  }
}

// Draw method for followed items list
function drawTrendChart(canvas, history) {
  if (!canvas || !history || history.length === 0) return
  const ctx = canvas.getContext('2d')
  const W = canvas.width = canvas.offsetWidth * 2
  const H = canvas.height = canvas.offsetHeight * 2
  ctx.scale(2, 2)
  const w = W / 2
  const h = H / 2

  ctx.clearRect(0, 0, w, h)

  const data = history.map(d => d.score || d.rank || 0)
  if (data.length === 0) return

  let maxVal = Math.max(...data)
  let minVal = Math.min(...data)
  if (data.length === 1) {
    minVal = 0
    maxVal = data[0] ? data[0] * 1.5 : 10
  }
  const range = maxVal - minVal || 1
  const padding = { top: 15, right: 15, bottom: 25, left: 45 }
  const chartW = w - padding.left - padding.right
  const chartH = h - padding.top - padding.bottom

  const isDark = document.documentElement.classList.contains('dark')
  const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.1)'
  const textColor = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.7)'
  const dateColor = isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.6)'
  const themeColor = isDark ? '#38bdf8' : '#0284c7'
  const themeGradientStart = isDark ? 'rgba(56,189,248,0.25)' : 'rgba(2,132,199,0.2)'

  ctx.strokeStyle = gridColor
  ctx.lineWidth = 0.5
  for (let i = 0; i <= 3; i++) {
    const y = padding.top + (chartH / 3) * i
    ctx.beginPath()
    ctx.moveTo(padding.left, y)
    ctx.lineTo(w - padding.right, y)
    ctx.stroke()

    ctx.fillStyle = textColor
    ctx.font = '9px sans-serif'
    ctx.textAlign = 'right'
    const val = maxVal - (range / 3) * i
    ctx.fillText(Math.round(val).toLocaleString(), padding.left - 4, y + 3)
  }

  if (data.length === 1) {
    const x = padding.left + chartW / 2
    const y = padding.top + chartH - ((data[0] - minVal) / range) * chartH
    ctx.beginPath()
    ctx.arc(x, y, 4, 0, Math.PI * 2)
    ctx.fillStyle = themeColor
    ctx.fill()

    ctx.fillStyle = themeColor
    ctx.font = 'bold 9px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(data[0].toLocaleString(), x, y - 10)

    ctx.fillStyle = dateColor
    ctx.font = '8px sans-serif'
    ctx.textAlign = 'center'
    const first = history[0]?.created_at?.slice(5, 10) || ''
    ctx.fillText(first, x, h - 6)
    return
  }

  const gradient = ctx.createLinearGradient(0, padding.top, 0, h - padding.bottom)
  gradient.addColorStop(0, themeGradientStart)
  gradient.addColorStop(1, 'rgba(56,189,248,0)')

  ctx.beginPath()
  data.forEach((val, i) => {
    const x = padding.left + (chartW / (data.length - 1)) * i
    const y = padding.top + chartH - ((val - minVal) / range) * chartH
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  ctx.strokeStyle = themeColor
  ctx.lineWidth = 1.5
  ctx.stroke()

  ctx.lineTo(padding.left + chartW, padding.top + chartH)
  ctx.lineTo(padding.left, padding.top + chartH)
  ctx.closePath()
  ctx.fillStyle = gradient
  ctx.fill()

  data.forEach((val, i) => {
    const x = padding.left + (chartW / (data.length - 1)) * i
    const y = padding.top + chartH - ((val - minVal) / range) * chartH
    ctx.beginPath()
    ctx.arc(x, y, 2.5, 0, Math.PI * 2)
    ctx.fillStyle = themeColor
    ctx.fill()
  })

  // Date labels
  ctx.fillStyle = dateColor
  ctx.font = '8px sans-serif'
  ctx.textAlign = 'center'
  const first = history[0]?.created_at?.slice(5, 10) || ''
  const last = history[history.length - 1]?.created_at?.slice(5, 10) || ''
  ctx.fillText(first, padding.left, h - 6)
  ctx.fillText(last, w - padding.right, h - 6)
}

function loadFollowed() {
  const raw = localStorage.getItem('trends_followed')
  if (raw) {
    try {
      followedItems.value = JSON.parse(raw)
    } catch {
      followedItems.value = []
    }
  } else {
    followedItems.value = [
      { keyword: '高考', platform: 'bilibili' },
      { keyword: 'B站', platform: 'bilibili' }
    ]
    saveFollowed()
  }
}

function saveFollowed() {
  localStorage.setItem('trends_followed', JSON.stringify(followedItems.value))
}

async function fetchFollowedData(item) {
  const key = `${item.platform}_${item.keyword}`
  followedData.value[key] = { loading: true, count: 0, history: [] }

  try {
    // 1. Search to update snapshot
    const searchRes = await authFetch(`/api/trends/search?q=${encodeURIComponent(item.keyword)}&platform=${item.platform}`)
    const searchData = await searchRes.json()
    const count = searchData.results?.[0]?.count || 0

    // 2. Fetch history
    const histRes = await authFetch(`/api/trends/history?q=${encodeURIComponent(item.keyword)}&platform=${item.platform}&days=7`)
    const histData = await histRes.json()
    const history = histData.history || []

    followedData.value[key] = {
      loading: false,
      count,
      history
    }

    // Trigger canvas draw after DOM updates
    nextTick(() => {
      const canvas = document.getElementById(`canvas-${item.platform}-${item.keyword}`)
      if (canvas) {
        drawTrendChart(canvas, history)
      }
    })
  } catch (err) {
    console.error('Fetch followed data error:', err)
    followedData.value[key] = { loading: false, count: 0, history: [] }
  }
}

function fetchAllFollowed() {
  const activeItems = followedItems.value.filter(item => item.platform === activePlatform.value)
  activeItems.forEach(item => {
    fetchFollowedData(item)
  })
}

function addFollowItem() {
  const kw = newFollowKeyword.value.trim()
  if (!kw) return

  const exists = followedItems.value.some(item => item.keyword.trim().toLowerCase() === kw.toLowerCase() && item.platform === activePlatform.value)
  if (exists) {
    ElMessage.warning('已经关注了该关键词')
    return
  }

  const newItem = { keyword: kw, platform: activePlatform.value }
  followedItems.value.push(newItem)
  saveFollowed()
  newFollowKeyword.value = ''

  fetchFollowedData(newItem)
  ElMessage.success('成功添加关注')
}

function removeFollowItem(item) {
  followedItems.value = followedItems.value.filter(i => !(i.keyword === item.keyword && i.platform === item.platform))
  saveFollowed()
  ElMessage.info('已取消关注')
}

function moveFollowItem(index, direction) {
  const platformItems = followedItems.value.filter(i => i.platform === activePlatform.value)
  if (direction === 'up' && index > 0) {
    const temp = platformItems[index]
    platformItems[index] = platformItems[index - 1]
    platformItems[index - 1] = temp
  } else if (direction === 'down' && index < platformItems.length - 1) {
    const temp = platformItems[index]
    platformItems[index] = platformItems[index + 1]
    platformItems[index + 1] = temp
  }

  const otherPlatformItems = followedItems.value.filter(i => i.platform !== activePlatform.value)
  followedItems.value = [...otherPlatformItems, ...platformItems]
  saveFollowed()

  nextTick(() => {
    platformItems.forEach(item => {
      const key = `${item.platform}_${item.keyword}`
      const state = followedData.value[key]
      if (state && state.history) {
        const canvas = document.getElementById(`canvas-${item.platform}-${item.keyword}`)
        if (canvas) {
          drawTrendChart(canvas, state.history)
        }
      }
    })
  })
}

function rankChange(idx) {
  if (idx === 0) return { text: 'new', cls: 'new' }
  return { text: '', cls: '' }
}

function switchPlatform(p) {
  activePlatform.value = p
  fetchHot()
  fetchAllFollowed()
}

onMounted(() => {
  fetchHot()
  loadFollowed()
  fetchAllFollowed()
})
</script>

<template>
  <div class="trends-page">
    <h2 class="page-title"><span class="title-icon">📊</span> 热点趋势分析</h2>
    <p class="page-desc">B站、抖音、小红书热搜榜单 + 关键词热度追踪</p>

    <div class="page-content">
      <!-- 平台切换 -->
      <div class="platform-tabs">
        <button
          v-for="p in PLATFORMS"
          :key="p.key"
          :class="['platform-tab', { active: activePlatform === p.key }]"
          :style="activePlatform === p.key ? { borderColor: p.color, color: p.color } : {}"
          @click="switchPlatform(p.key)"
        >
          {{ p.icon }} {{ p.name }}
        </button>
        <button class="refresh-btn" @click="fetchHot" :disabled="loading">
          {{ loading ? '⏳' : '🔄' }}
        </button>
      </div>

      <!-- 热搜榜单 -->
      <div class="section-header">
        <h3>🔥 热搜榜单</h3>
        <span class="section-hint">每小时自动更新</span>
      </div>

      <div v-if="loading" class="loading-box">正在抓取热搜...</div>

      <div v-else-if="hotList.length === 0" class="empty-box">
        暂无数据{{ activePlatform === 'xiaohongshu' ? '（小红书需要 Playwright 环境）' : '' }}
      </div>

      <div v-else class="hot-list">
        <div v-for="(item, idx) in hotList" :key="idx" class="hot-item" @click="searchKeyword = item.keyword; searchTrend()">
          <span class="hot-rank" :class="{ top3: idx < 3 }">{{ idx + 1 }}</span>
          <span class="hot-keyword">{{ item.keyword }}</span>
          <span class="hot-score">{{ item.score ? (item.score > 10000 ? (item.score / 10000).toFixed(1) + 'w' : item.score) : '-' }}</span>
        </div>
      </div>

      <!-- 关键词搜索 -->
      <div class="section-header" style="margin-top: 24px;">
        <h3>🔍 关键词单次查询</h3>
      </div>

      <div class="search-row">
        <input
          v-model="searchKeyword"
          class="trend-input"
          placeholder="输入关键词进行单次热度查询..."
          @keyup.enter="searchTrend"
        >
        <button class="trend-btn" @click="searchTrend" :disabled="searchLoading">
          {{ searchLoading ? '查询中...' : '查询' }}
        </button>
      </div>

      <div v-if="searchResult" class="search-result-card">
        <div class="result-keyword">{{ searchResult.keyword }}</div>
        <div class="result-count">{{ (searchResult.count || 0).toLocaleString() }} 条相关结果</div>
      </div>

      <!-- 历史趋势图 -->
      <div v-if="historyKeyword && historyData.length > 0" class="chart-section">
        <div class="section-header">
          <h3>📈 {{ historyKeyword }} — 7天趋势</h3>
        </div>
        <div class="chart-wrapper">
          <canvas ref="canvasRef" class="trend-canvas"></canvas>
        </div>
      </div>

      <div v-if="historyKeyword && historyData.length === 0 && !historyLoading" class="empty-box" style="margin-top: 12px;">
        暂无历史趋势数据。定时任务每小时抓取一次热搜快照，数据会随时间积累。
      </div>

      <!-- 关注的关键词/BGM -->
      <div class="section-header" style="margin-top: 32px;">
        <h3>📌 我关注的关键词/BGM</h3>
        <span class="section-hint">数据保存在本地浏览器中</span>
      </div>

      <div class="search-row add-followed-row">
        <input
          v-model="newFollowKeyword"
          class="trend-input"
          placeholder="输入想要长期追踪的关键词或BGM..."
          @keyup.enter="addFollowItem"
        >
        <button class="trend-btn add-btn" @click="addFollowItem">
          ➕ 关注
        </button>
      </div>

      <div class="followed-list">
        <div 
          v-for="(item, idx) in followedItems.filter(i => i.platform === activePlatform)" 
          :key="item.platform + '_' + item.keyword" 
          class="followed-card"
        >
          <div class="followed-header">
            <div class="followed-meta">
              <span class="followed-keyword">{{ item.keyword }}</span>
              <span 
                v-if="followedData[`${item.platform}_${item.keyword}`] && !followedData[`${item.platform}_${item.keyword}`].loading" 
                class="followed-count"
              >
                {{ (followedData[`${item.platform}_${item.keyword}`].count || 0).toLocaleString() }} 条相关视频/结果
              </span>
            </div>
            <div class="followed-actions">
              <!-- Up Button -->
              <button 
                class="action-btn sort-btn" 
                title="上移" 
                @click="moveFollowItem(idx, 'up')"
                :disabled="idx === 0"
              >
                ▲
              </button>
              <!-- Down Button -->
              <button 
                class="action-btn sort-btn" 
                title="下移" 
                @click="moveFollowItem(idx, 'down')"
                :disabled="idx === followedItems.filter(i => i.platform === activePlatform).length - 1"
              >
                ▼
              </button>
              <!-- Refresh Button -->
              <button 
                class="action-btn" 
                title="刷新数据" 
                @click="fetchFollowedData(item)"
                :disabled="followedData[`${item.platform}_${item.keyword}`]?.loading"
              >
                🔄
              </button>
              <!-- Unfollow Button -->
              <button class="action-btn delete-btn" title="取消关注" @click="removeFollowItem(item)">
                🗑️
              </button>
            </div>
          </div>
          <div class="followed-chart-container">
            <div 
              v-if="followedData[`${item.platform}_${item.keyword}`]?.loading" 
              class="chart-loading-overlay"
            >
              ⏳ 正在加载历史趋势...
            </div>
            <div 
              v-else-if="!followedData[`${item.platform}_${item.keyword}`]?.history || followedData[`${item.platform}_${item.keyword}`]?.history.length === 0" 
              class="chart-empty-overlay"
            >
              暂无历史快照，系统定时任务会在每小时自动记录，请耐心等待数据积累。
            </div>
            <canvas 
              :id="`canvas-${item.platform}-${item.keyword}`" 
              class="followed-canvas"
            ></canvas>
          </div>
        </div>
        <div v-if="followedItems.filter(i => i.platform === activePlatform).length === 0" class="empty-box">
          当前平台暂无关注的关键词。在下方输入并点击“关注”即可开始长期追踪。
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.trends-page { max-width: 640px; margin: 0 auto; padding: 20px 16px 40px; }
.page-title { font-size: 1.4rem; font-weight: 400; color: var(--text-heading); margin: 0 0 6px; letter-spacing: 1px; }
.title-icon { margin-right: 8px; }
.page-desc { color: var(--text-secondary); font-size: 0.85rem; margin: 0 0 24px; }
.page-content { background: var(--bg-card); border-radius: 12px; padding: 20px; border: 1px solid var(--border-color); }

.platform-tabs { display: flex; gap: 8px; margin-bottom: 16px; align-items: center; }
.platform-tab { flex: 1; padding: 10px; border: 2px solid var(--border-color); border-radius: 8px; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 0.9rem; font-weight: 500; transition: all 0.2s; }
.platform-tab.active { background: var(--bg-active); font-weight: 600; }
.platform-tab:hover { border-color: var(--accent-blue); }
.refresh-btn { width: 40px; height: 40px; border: 1px solid var(--border-color); border-radius: 8px; background: transparent; cursor: pointer; font-size: 1.1rem; flex-shrink: 0; }

.section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.section-header h3 { font-size: 1rem; font-weight: 600; color: var(--text-heading); margin: 0; }
.section-hint { font-size: 0.75rem; color: var(--text-muted); }

.loading-box, .empty-box { padding: 30px; text-align: center; color: var(--text-muted); font-size: 0.85rem; border: 1px dashed var(--border-subtle); border-radius: 8px; margin-top: 10px; }

.hot-list { max-height: 320px; overflow-y: auto; border: 1px solid var(--border-subtle); border-radius: 8px; padding: 0 12px; background: rgba(0,0,0,0.1); }
.hot-item { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--border-subtle); cursor: pointer; transition: background 0.15s; }
.hot-item:hover { background: var(--bg-hover); }
.hot-item:last-child { border-bottom: none; }
.hot-rank { min-width: 24px; text-align: center; font-size: 0.85rem; font-weight: 600; color: var(--text-muted); }
.hot-rank.top3 { color: #f59e0b; }
.hot-keyword { flex: 1; font-size: 0.9rem; color: var(--text-primary); }
.hot-score { font-size: 0.75rem; color: var(--text-secondary); min-width: 50px; text-align: right; }

.search-row { display: flex; gap: 8px; margin-bottom: 12px; }
.add-followed-row { margin-bottom: 16px; }
.trend-input { flex: 1; padding: 10px 12px; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-input); color: var(--text-primary); font-size: 0.9rem; outline: none; }
.trend-input:focus { border-color: var(--accent-blue); }
.trend-btn { padding: 10px 20px; border: none; border-radius: 8px; background: var(--accent-blue); color: #fff; cursor: pointer; font-size: 0.9rem; white-space: nowrap; transition: background 0.2s; }
.trend-btn:hover { background: #2563eb; }
.trend-btn:disabled { opacity: 0.5; }
.add-btn { background: #10b981; }
.add-btn:hover { background: #059669; }

.search-result-card { padding: 14px; background: var(--bg-ctrl); border-radius: 10px; border: 1px solid var(--border-subtle); margin-bottom: 12px; }
.result-keyword { font-size: 1rem; font-weight: 600; color: var(--text-heading); margin-bottom: 4px; }
.result-count { font-size: 0.85rem; color: var(--text-secondary); }

.chart-section { margin-top: 16px; }
.chart-wrapper { background: var(--bg-ctrl); border-radius: 10px; padding: 12px; border: 1px solid var(--border-subtle); }
.trend-canvas { width: 100%; height: 200px; display: block; }

/* Followed Cards list */
.followed-list { display: flex; flex-direction: column; gap: 16px; margin-top: 12px; }
.followed-card { background: var(--bg-ctrl); border: 1px solid var(--border-subtle); border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.followed-header { display: flex; justify-content: space-between; align-items: flex-start; }
.followed-meta { display: flex; flex-direction: column; gap: 2px; }
.followed-keyword { font-size: 0.95rem; font-weight: 600; color: var(--text-heading); }
.followed-count { font-size: 0.78rem; color: var(--text-secondary); }
.followed-actions { display: flex; gap: 6px; }
.action-btn { background: rgba(255, 255, 255, 0.05); border: 1px solid var(--border-subtle); width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; border-radius: 6px; cursor: pointer; font-size: 0.85rem; transition: background 0.15s; }
.action-btn:hover { background: rgba(255, 255, 255, 0.12); }
.action-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.delete-btn:hover { background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.2); }
.sort-btn { font-size: 0.65rem !important; }

.followed-chart-container { position: relative; width: 100%; height: 130px; background: rgba(0,0,0,0.15); border-radius: 8px; overflow: hidden; border: 1px solid rgba(255,255,255,0.03); }
.followed-canvas { width: 100%; height: 100%; display: block; }

.chart-loading-overlay, .chart-empty-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; background: rgba(22,22,42,0.85); color: var(--text-secondary); font-size: 0.78rem; text-align: center; padding: 0 20px; box-sizing: border-box; }
.chart-empty-overlay { background: rgba(22,22,42,0.65); color: var(--text-muted); }

@media (max-width: 480px) {
  .trends-page { padding: 12px 10px 30px; }
  .page-content { padding: 14px; }
  .platform-tab { padding: 8px 6px; font-size: 0.82rem; }
}
</style>

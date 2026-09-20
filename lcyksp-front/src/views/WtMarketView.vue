<script setup>
/**
 * WtMarketView.vue — 战争雷霆（Gaijin 交易所）物品价格监控
 * 数据源: /api/wt-market/*（后端每天一次全目录快照，前端本地即时过滤）
 * 功能: 关键词即时搜索(逐字符) + 类型 + 价格区间 · 3天涨跌榜 · 点开看买/卖价历史走势图
 * 性能: 进页面一次性拉全量精简目录到内存，之后过滤全在前端，零后端往返
 * 图表配色跟随日间/暗黑主题（监听 html[data-theme] 变化自动重绘）
 * 权限: 高级用户可见；配置 Gaijin 凭据 / 手动刷新仅管理员
 */
import { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import axios from 'axios'
import * as echarts from 'echarts'

// Gaijin 价格是放大整数（raw 均为 ×1e6），÷10^8 = GJN（两位小数）
// 2026-09-19 真机核对：MiG-25PD raw 3989000000 → 39.89 GJN，站长确认 ≈30+ 币，除数定为 1e8
const PRICE_DIVISOR = 1e8
const RENDER_CAP = 300 // 一次最多铺这么多卡片（图标 loading=lazy，屏外不加载，安全）；防 2700 个 DOM 一次性卡顿

const currentUser = ref(null)
const isAdmin = computed(() => currentUser.value?.role === 'admin')

const status = reactive({ credentialsConfigured: false, loginMasked: '', lastSnapshotAt: '', lastError: '', itemCount: 0 })

// 全量目录（一次拉取，之后本地过滤）
const allItems = ref([])
const loading = ref(false)

// 过滤条件
const query = ref('')
const typeFilter = ref('')
const nationFilter = ref('') // 国家筛选（''＝全部；'__other__'＝无国家的箱子/钥匙/贴花等）
const sortOrder = ref('') // 价格排序：''＝默认(卖价降序/收藏置顶) | 'asc' 升 | 'desc' 降（按 priceSide 选的买/卖价）
const priceSide = ref('sell') // 价格区间 + 排序都作用于 卖价/买价
const priceMin = ref(null)
const priceMax = ref(null)

// 国家代码 → 中文名（Gaijin tags 里的 country:xxx）
const NATION_LABEL = {
  usa: '美国', germany: '德国', ussr: '苏联', britain: '英国', japan: '日本',
  china: '中国', italy: '意大利', france: '法国', sweden: '瑞典',
  israel: '以色列', south_africa: '南非', finland: '芬兰',
}
const OTHER_NATION = '__other__'

// 收藏（每用户，存服务器）：id 集合，收藏置顶 + 「我的收藏」筛选
const favoriteIds = ref(new Set())
const favOnly = ref(false) // 搜索框旁「我的收藏」开关
const isFavorite = (item) => favoriteIds.value.has(item.id)

// 涨跌榜
const movers = reactive({ windowDays: 3, topSellGainers: [], topBuyDropers: [] })

// 走势弹窗
const trendVisible = ref(false)
const trendItem = ref(null)
const trendChange = ref(null)
const trendLoading = ref(false)
const chartRef = ref(null)
let chart = null

// ---------- 主题配色（照 AlgsView 约定） ----------

function isLightTheme() {
  return document.documentElement.hasAttribute('data-theme')
}

function palette() {
  const light = isLightTheme()
  return {
    text: light ? '#2c3e50' : '#e2e4f0',
    textSub: light ? '#5a6a7a' : '#9aa2c5',
    split: light ? '#e6ebf2' : 'rgba(255,255,255,0.07)',
    tipBg: light ? '#ffffff' : '#1c1c36',
    tipBorder: light ? '#d0d8e0' : '#2e2e56',
    sell: '#f0c040',
    buy: '#409eff',
  }
}

// ---------- 展示辅助 ----------

function toGjn(raw) {
  if (!raw) return 0
  return raw / PRICE_DIVISOR
}

function fmtGjn(raw) {
  const v = toGjn(raw)
  if (!v) return '—'
  return v >= 100 ? v.toFixed(0) : v.toFixed(2)
}

function fmtTime(iso) {
  if (!iso) return '从未'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false })
}

// tags 里的 type:xxx → 取 xxx；一件物品可能多 type，取第一个 type: 值
function itemType(item) {
  const t = (item.tags || []).find((x) => String(x).startsWith('type:'))
  return t ? String(t).slice(5) : ''
}

// tags 里的 country:xxx → 取 xxx；无国家（箱子/钥匙/贴花/头像等）归 OTHER_NATION
function itemNation(item) {
  const t = (item.tags || []).find((x) => String(x).startsWith('country:'))
  return t ? String(t).slice(8) : OTHER_NATION
}

// ---------- 本地过滤（computed 驱动，逐字符即时） ----------

const typeOptions = computed(() => {
  const set = new Set()
  for (const it of allItems.value) {
    const t = itemType(it)
    if (t) set.add(t)
  }
  return [...set].sort()
})

// 国家下拉：目录里真实出现的国家（有中文名的排前、按中文名序），再附「其他」
const nationOptions = computed(() => {
  const present = new Set()
  let hasOther = false
  for (const it of allItems.value) {
    const n = itemNation(it)
    if (n === OTHER_NATION) hasOther = true
    else present.add(n)
  }
  const known = [...present]
    .map((code) => ({ code, label: NATION_LABEL[code] || code }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh'))
  if (hasOther) known.push({ code: OTHER_NATION, label: '其他（箱子/钥匙等）' })
  return known
})

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  const type = typeFilter.value
  const nation = nationFilter.value
  const min = priceMin.value != null && priceMin.value !== '' ? Number(priceMin.value) * PRICE_DIVISOR : null
  const max = priceMax.value != null && priceMax.value !== '' ? Number(priceMax.value) * PRICE_DIVISOR : null
  const priceOf = (it) => (priceSide.value === 'buy' ? it.buyPrice : it.sellPrice) || 0
  const favs = favoriteIds.value
  const hits = allItems.value.filter((it) => {
    if (favOnly.value && !favs.has(it.id)) return false
    if (q) {
      const hay = `${it.displayName} ${it.marketName}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    if (type && itemType(it) !== type) return false
    if (nation && itemNation(it) !== nation) return false
    if (min != null || max != null) {
      const p = priceOf(it)
      if (min != null && p < min) return false
      if (max != null && p > max) return false
    }
    return true
  })
  // 价格排序：选了升/降就按 priceSide 的买/卖价排；否则保持后端给的默认（卖价降序）
  if (sortOrder.value === 'asc') hits.sort((a, b) => priceOf(a) - priceOf(b))
  else if (sortOrder.value === 'desc') hits.sort((a, b) => priceOf(b) - priceOf(a))
  // 收藏置顶：最后再稳定排一次（收藏在前，各自内部保持上面已定的顺序）。仅「我的收藏」模式无需分层。
  if (!favOnly.value && favs.size) {
    hits.sort((a, b) => (favs.has(b.id) ? 1 : 0) - (favs.has(a.id) ? 1 : 0))
  }
  return hits
})

const favoriteCount = computed(() => {
  // 当前全量目录里实际存在的收藏数（物品可能已下架，收藏 id 仍在）
  let n = 0
  for (const it of allItems.value) if (favoriteIds.value.has(it.id)) n += 1
  return n
})

const visibleItems = computed(() => filtered.value.slice(0, RENDER_CAP))

function resetFilters() {
  query.value = ''
  typeFilter.value = ''
  nationFilter.value = ''
  sortOrder.value = ''
  priceMin.value = null
  priceMax.value = null
  favOnly.value = false
}

// ---------- 数据加载 ----------

async function loadStatus() {
  try {
    const res = await axios.get('/api/wt-market/status')
    Object.assign(status, res.data || {})
  } catch {
    /* 静默：状态失败不阻塞搜索 */
  }
}

async function loadCatalog() {
  loading.value = true
  try {
    const res = await axios.get('/api/wt-market/items', { params: { all: 1 } })
    allItems.value = res.data?.items || []
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '加载物品失败')
  } finally {
    loading.value = false
  }
}

async function loadMovers() {
  try {
    const res = await axios.get('/api/wt-market/movers')
    Object.assign(movers, { windowDays: 3, topSellGainers: [], topBuyDropers: [] }, res.data || {})
  } catch {
    /* 静默：榜单失败不阻塞主体 */
  }
}

async function loadFavorites() {
  try {
    const res = await axios.get('/api/wt-market/favorites')
    favoriteIds.value = new Set(res.data?.itemIds || [])
  } catch {
    /* 静默：收藏失败不阻塞搜索，只是不置顶 */
  }
}

// 点星标：乐观更新（先改本地再打后端），失败回滚。@click.stop 防触发卡片走势弹窗。
async function toggleFavorite(item) {
  const id = item.id
  const was = favoriteIds.value.has(id)
  const next = new Set(favoriteIds.value)
  if (was) next.delete(id)
  else next.add(id)
  favoriteIds.value = next
  try {
    if (was) await axios.delete(`/api/wt-market/favorites/${id}`)
    else await axios.post(`/api/wt-market/favorites/${id}`)
  } catch (err) {
    // 回滚
    const rollback = new Set(favoriteIds.value)
    if (was) rollback.add(id)
    else rollback.delete(id)
    favoriteIds.value = rollback
    ElMessage.error(err.response?.data?.error || '收藏操作失败')
  }
}

async function openTrend(item) {
  trendItem.value = item
  trendChange.value = null
  trendVisible.value = true
  trendLoading.value = true
  try {
    const res = await axios.get(`/api/wt-market/trend/${item.id}`)
    trendItem.value = res.data?.item || item
    trendChange.value = res.data?.change || null
    await nextTick()
    renderChart(res.data?.series || [])
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '加载走势失败')
  } finally {
    trendLoading.value = false
  }
}

// ---------- 图表 ----------

function disposeChart() {
  if (chart) { chart.dispose(); chart = null }
}

function renderChart(series) {
  disposeChart()
  const el = chartRef.value
  if (!el) return
  if (!series.length) return
  el.style.height = '340px'
  chart = echarts.init(el)
  const pal = palette()
  const dates = series.map((s) => s.snapshot_date)
  const sell = series.map((s) => toGjn(s.sell_price))
  const buy = series.map((s) => toGjn(s.buy_price))
  chart.setOption({
    backgroundColor: 'transparent',
    grid: { left: 60, right: 24, top: 40, bottom: 40 },
    legend: { data: ['卖价', '买价'], top: 6, textStyle: { color: pal.textSub } },
    tooltip: {
      trigger: 'axis',
      backgroundColor: pal.tipBg,
      borderColor: pal.tipBorder,
      textStyle: { color: pal.text, fontSize: 12 },
      valueFormatter: (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(2)),
    },
    xAxis: { type: 'category', data: dates, axisLabel: { color: pal.textSub, fontSize: 11 }, axisLine: { lineStyle: { color: pal.split } } },
    yAxis: { type: 'value', name: 'GJN', nameTextStyle: { color: pal.textSub }, axisLabel: { color: pal.textSub, fontSize: 11 }, splitLine: { lineStyle: { color: pal.split } } },
    series: [
      { name: '卖价', type: 'line', smooth: true, showSymbol: series.length <= 30, data: sell, itemStyle: { color: pal.sell }, lineStyle: { width: 2 } },
      { name: '买价', type: 'line', smooth: true, showSymbol: series.length <= 30, data: buy, itemStyle: { color: pal.buy }, lineStyle: { width: 2 } },
    ],
  })
}

function handleResize() {
  if (chart) chart.resize()
}

let themeObserver = null
let lastLight = false
function watchTheme() {
  lastLight = isLightTheme()
  themeObserver = new MutationObserver(() => {
    const light = isLightTheme()
    if (light === lastLight) return
    lastLight = light
    if (trendVisible.value && trendItem.value) {
      // 重新拉一次序列重绘（简单可靠，走势数据量小）
      axios.get(`/api/wt-market/trend/${trendItem.value.id}`).then((res) => {
        nextTick(() => renderChart(res.data?.series || []))
      }).catch(() => {})
    }
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
}

// ---------- 生命周期 ----------

onMounted(() => {
  try { currentUser.value = JSON.parse(localStorage.getItem('lcyksp_user') || 'null') } catch { currentUser.value = null }
  watchTheme()
  loadStatus()
  loadCatalog()
  loadMovers()
  loadFavorites()
  window.addEventListener('resize', handleResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
  if (themeObserver) themeObserver.disconnect()
  disposeChart()
})
</script>

<template>
  <div class="wt-market">
    <header class="wt-head">
      <div class="wt-title">
        <h2>战争雷霆交易所</h2>
        <span class="wt-sub">Gaijin 物品价格 · 每日快照走势</span>
      </div>
      <div class="wt-meta">
        <span v-if="status.itemCount">收录 {{ status.itemCount }} 件 · 更新 {{ fmtTime(status.lastSnapshotAt) }}</span>
      </div>
    </header>

    <!-- 搜索栏：关键词即时 + 类型 + 价格区间 -->
    <div class="wt-search">
      <div class="wt-search-top">
        <el-input v-model="query" placeholder="搜索载具 / 涂装 / 物品名…（逐字即时）" clearable size="large" class="wt-search-kw">
          <template #prefix><span class="wt-search-icon">🔍</span></template>
        </el-input>
        <el-button
          :type="favOnly ? 'warning' : 'default'"
          size="large"
          class="wt-fav-toggle"
          @click="favOnly = !favOnly"
        >
          <span class="wt-fav-star">{{ favOnly ? '⭐' : '☆' }}</span>
          <span class="wt-fav-label">我的收藏</span><span v-if="favoriteCount" class="wt-fav-badge">{{ favoriteCount }}</span>
        </el-button>
      </div>
      <div class="wt-filters">
        <el-select v-model="typeFilter" placeholder="全部类型" clearable size="large" class="wt-type">
          <el-option v-for="t in typeOptions" :key="t" :label="t" :value="t" />
        </el-select>
        <el-select v-model="nationFilter" placeholder="全部国家" clearable size="large" class="wt-nation">
          <el-option v-for="n in nationOptions" :key="n.code" :label="n.label" :value="n.code" />
        </el-select>
        <el-select v-model="sortOrder" size="large" class="wt-sort">
          <el-option label="默认排序" value="" />
          <el-option label="价格 ↑ 低到高" value="asc" />
          <el-option label="价格 ↓ 高到低" value="desc" />
        </el-select>
        <div class="wt-price">
          <el-select v-model="priceSide" size="large" class="wt-price-side">
            <el-option label="卖价" value="sell" />
            <el-option label="买价" value="buy" />
          </el-select>
          <el-input v-model="priceMin" type="number" placeholder="最低" size="large" class="wt-price-in" />
          <span class="wt-price-sep">–</span>
          <el-input v-model="priceMax" type="number" placeholder="最高" size="large" class="wt-price-in" />
          <span class="wt-price-unit">GJN</span>
        </div>
      </div>
    </div>

    <!-- 涨跌榜（过去 N 天） -->
    <section v-if="movers.topSellGainers.length || movers.topBuyDropers.length" class="wt-movers">
      <div class="wt-mover-col">
        <div class="wt-mover-head up">📈 {{ movers.windowDays }} 天卖价涨得最多</div>
        <button v-for="m in movers.topSellGainers" :key="'g' + m.id" class="wt-mover-row" @click="openTrend(m)">
          <div class="wt-mover-icon"><img v-if="m.iconUrl" :src="m.iconUrl" :alt="m.displayName" loading="lazy" @error="(e) => (e.target.style.visibility = 'hidden')" /></div>
          <span class="wt-mover-name">{{ m.displayName }}</span>
          <span class="wt-mover-price">{{ fmtGjn(m.sellPrice) }}</span>
          <span class="wt-mover-pct up">+{{ m.changePct }}%</span>
        </button>
      </div>
      <div class="wt-mover-col">
        <div class="wt-mover-head down">📉 {{ movers.windowDays }} 天买价跌得最快</div>
        <button v-for="m in movers.topBuyDropers" :key="'d' + m.id" class="wt-mover-row" @click="openTrend(m)">
          <div class="wt-mover-icon"><img v-if="m.iconUrl" :src="m.iconUrl" :alt="m.displayName" loading="lazy" @error="(e) => (e.target.style.visibility = 'hidden')" /></div>
          <span class="wt-mover-name">{{ m.displayName }}</span>
          <span class="wt-mover-price">{{ fmtGjn(m.buyPrice) }}</span>
          <span class="wt-mover-pct down">{{ m.changePct }}%</span>
        </button>
      </div>
    </section>

    <!-- 命中计数 -->
    <div v-if="!loading && allItems.length" class="wt-count">
      共 {{ filtered.length }} 件<span v-if="filtered.length > RENDER_CAP">（显示前 {{ RENDER_CAP }}）</span>
      <el-button v-if="query || typeFilter || nationFilter || sortOrder || priceMin || priceMax || favOnly" link type="primary" @click="resetFilters">清空筛选</el-button>
    </div>

    <!-- 空态 -->
    <div v-if="!loading && !allItems.length" class="wt-empty">
      <p v-if="!status.credentialsConfigured">数据采集尚未开启{{ isAdmin ? '，请到管理后台「战争雷霆交易所」配置 Gaijin 账号后点「立即快照」' : '' }}</p>
      <p v-else>暂无数据，稍候再来</p>
    </div>
    <div v-else-if="!loading && favOnly && !filtered.length" class="wt-empty">
      <p>还没有收藏。点物品卡片右上角的 ☆ 收藏，之后会自动置顶</p>
    </div>
    <div v-else-if="!loading && !filtered.length" class="wt-empty">
      <p>没有匹配的物品，换个关键词试试</p>
    </div>

    <!-- 物品网格 -->
    <div v-loading="loading" class="wt-grid">
      <button v-for="item in visibleItems" :key="item.id" class="wt-card" @click="openTrend(item)">
        <span
          class="wt-card-fav"
          :class="{ on: isFavorite(item) }"
          role="button"
          :title="isFavorite(item) ? '取消收藏' : '收藏，置顶显示'"
          :aria-label="isFavorite(item) ? '取消收藏' : '收藏'"
          @click.stop="toggleFavorite(item)"
        >{{ isFavorite(item) ? '⭐' : '☆' }}</span>
        <div class="wt-card-icon" :style="item.color ? { boxShadow: `0 0 0 2px #${item.color}55` } : {}">
          <img v-if="item.iconUrl" :src="item.iconUrl" :alt="item.displayName" loading="lazy" @error="(e) => (e.target.style.visibility = 'hidden')" />
        </div>
        <div class="wt-card-body">
          <div class="wt-card-name">{{ item.displayName }}</div>
          <div class="wt-card-prices">
            <span class="p-sell">卖 {{ fmtGjn(item.sellPrice) }}</span>
            <span class="p-buy">买 {{ fmtGjn(item.buyPrice) }}</span>
          </div>
        </div>
      </button>
    </div>

    <!-- 走势弹窗 -->
    <el-dialog v-model="trendVisible" :title="trendItem?.displayName || '价格走势'" width="min(720px, 94vw)" @closed="disposeChart">
      <div v-if="trendChange" class="wt-trend-tags">
        <span class="tag sell">卖价 {{ fmtGjn(trendChange.latest?.sell_price) }} GJN</span>
        <span class="tag buy">买价 {{ fmtGjn(trendChange.latest?.buy_price) }} GJN</span>
        <span v-if="trendChange.dayChange !== null" :class="['tag', trendChange.dayChange >= 0 ? 'up' : 'down']">
          日 {{ trendChange.dayChange >= 0 ? '+' : '' }}{{ trendChange.dayChange }}%
        </span>
        <span v-if="trendChange.weekChange !== null" :class="['tag', trendChange.weekChange >= 0 ? 'up' : 'down']">
          周 {{ trendChange.weekChange >= 0 ? '+' : '' }}{{ trendChange.weekChange }}%
        </span>
        <span v-if="trendChange.sellCountChange !== null" class="tag muted" title="昨→今 在售挂单数变化（近似换手，含成交与撤单/改挂，非真实成交量）">
          在售约 {{ trendChange.sellCountChange >= 0 ? '+' : '' }}{{ trendChange.sellCountChange }}
        </span>
        <span v-if="trendChange.buyCountChange !== null" class="tag muted" title="昨→今 求购挂单数变化（近似换手，含成交与撤单/改挂，非真实成交量）">
          求购约 {{ trendChange.buyCountChange >= 0 ? '+' : '' }}{{ trendChange.buyCountChange }}
        </span>
      </div>
      <div v-loading="trendLoading" ref="chartRef" class="wt-chart"></div>
      <p v-if="!trendLoading && trendChange && !trendChange.latest" class="wt-chart-empty">该物品还没有历史快照</p>
    </el-dialog>
  </div>
</template>

<style scoped>
/* 上下 padding 对齐其他页面（AlgsView 等同为 20px 顶 / 40px 底），保证上下滚动范围一致 */
.wt-market { max-width: 1100px; margin: 0 auto; padding: 20px 16px 40px; }
.wt-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.wt-title h2 { margin: 0; font-size: 20px; }
.wt-sub { color: var(--el-text-color-secondary); font-size: 13px; }
.wt-meta { color: var(--el-text-color-secondary); font-size: 12px; }

.wt-search { margin-bottom: 14px; display: flex; flex-direction: column; gap: 10px; }
.wt-search-top { display: flex; gap: 10px; align-items: stretch; }
.wt-search-kw { flex: 1; min-width: 0; }
.wt-search-icon { font-size: 15px; opacity: .7; }
.wt-fav-toggle { flex: 0 0 auto; white-space: nowrap; }
.wt-fav-star { margin-right: 4px; }
.wt-fav-badge { margin-left: 6px; font-size: 12px; opacity: .85; font-variant-numeric: tabular-nums; }
.wt-filters { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.wt-type { width: 160px; }
.wt-nation { width: 150px; }
.wt-sort { width: 150px; }
.wt-price { display: flex; align-items: center; gap: 6px; }
.wt-price-side { width: 92px; }
.wt-price-in { width: 100px; }
.wt-price-sep { color: var(--el-text-color-secondary); }
.wt-price-unit { color: var(--el-text-color-secondary); font-size: 13px; }

.wt-movers { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
.wt-mover-col { background: var(--bg-card, var(--el-bg-color-overlay)); border: 1px solid var(--el-border-color-lighter); border-radius: 12px; padding: 10px 12px; }
.wt-mover-head { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.wt-mover-head.up { color: #67c23a; }
.wt-mover-head.down { color: #f56c6c; }
.wt-mover-row { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: none; border: none; padding: 6px 4px; cursor: pointer; border-radius: 8px; transition: background .12s; }
.wt-mover-row:hover { background: rgba(128,128,128,.08); }
.wt-mover-icon { width: 34px; height: 34px; flex: 0 0 34px; border-radius: 6px; overflow: hidden; display: flex; align-items: center; justify-content: center; background: rgba(128,128,128,.08); }
.wt-mover-icon img { max-width: 100%; max-height: 100%; object-fit: contain; }
.wt-mover-name { flex: 1; min-width: 0; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wt-mover-price { font-size: 12px; color: var(--el-text-color-secondary); font-variant-numeric: tabular-nums; }
.wt-mover-pct { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; min-width: 52px; text-align: right; }
.wt-mover-pct.up { color: #67c23a; }
.wt-mover-pct.down { color: #f56c6c; }

.wt-count { font-size: 12px; color: var(--el-text-color-secondary); margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }

.wt-empty { text-align: center; color: var(--el-text-color-secondary); padding: 48px 0; }

.wt-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; min-height: 60px; }
.wt-card { position: relative; display: flex; gap: 10px; align-items: center; text-align: left; background: var(--bg-card, var(--el-bg-color-overlay)); border: 1px solid var(--el-border-color-lighter); border-radius: 12px; padding: 10px; cursor: pointer; transition: transform .12s, border-color .12s; }
.wt-card:hover { transform: translateY(-2px); border-color: var(--el-color-primary); }
.wt-card-fav { position: absolute; top: 4px; right: 6px; font-size: 16px; line-height: 1; padding: 2px 4px; border-radius: 6px; color: var(--el-text-color-secondary); opacity: .55; cursor: pointer; transition: opacity .12s, transform .12s; z-index: 1; }
.wt-card-fav:hover { opacity: 1; transform: scale(1.15); background: rgba(128,128,128,.12); }
.wt-card-fav.on { color: #f0c040; opacity: 1; }
.wt-card-icon { width: 56px; height: 56px; flex: 0 0 56px; border-radius: 8px; overflow: hidden; display: flex; align-items: center; justify-content: center; background: rgba(128,128,128,.08); }
.wt-card-icon img { max-width: 100%; max-height: 100%; object-fit: contain; }
.wt-card-body { min-width: 0; flex: 1; padding-right: 16px; }
.wt-card-name { font-size: 13px; font-weight: 600; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.wt-card-prices { margin-top: 6px; display: flex; gap: 10px; font-size: 13px; font-variant-numeric: tabular-nums; }
.p-sell { color: #d4a017; font-weight: 600; }
.p-buy { color: #409eff; font-weight: 600; }

.wt-trend-tags { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.wt-trend-tags .tag { font-size: 12px; padding: 3px 10px; border-radius: 20px; font-variant-numeric: tabular-nums; }
.wt-trend-tags .tag.sell { background: rgba(240,192,64,.16); color: #d4a017; }
.wt-trend-tags .tag.buy { background: rgba(64,158,255,.16); color: #409eff; }
.wt-trend-tags .tag.up { background: rgba(103,194,58,.16); color: #67c23a; }
.wt-trend-tags .tag.down { background: rgba(245,108,108,.16); color: #f56c6c; }
.wt-trend-tags .tag.muted { background: rgba(128,128,128,.14); color: var(--el-text-color-secondary); cursor: help; }
.wt-chart { width: 100%; height: 340px; }
.wt-chart-empty { text-align: center; color: var(--el-text-color-secondary); padding: 20px 0; }

@media (max-width: 640px) {
  .wt-grid { grid-template-columns: 1fr 1fr; }
  .wt-movers { grid-template-columns: 1fr; }
  .wt-type, .wt-nation, .wt-sort, .wt-price-in { width: auto; flex: 1; }
  .wt-nation, .wt-sort { min-width: 45%; }
  /* 窄屏：「我的收藏」收成图标态，不挤搜索框（文字藏起来，只留 ⭐ + 计数） */
  .wt-fav-toggle { padding-left: 12px; padding-right: 12px; }
  .wt-fav-toggle .wt-fav-label { display: none; }
  .wt-fav-star { margin-right: 0; }
  .wt-fav-badge { margin-left: 4px; }
  /* 卡片 ☆ 放大触控区，手指好点 */
  .wt-card-fav { top: 2px; right: 2px; font-size: 18px; padding: 6px 8px; opacity: .7; }
}
</style>

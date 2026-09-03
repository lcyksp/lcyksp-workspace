<script setup>
/**
 * AlgsView.vue — ALGS 赛事数据可视化
 * 数据源: /api/algs/overview (后端抓取 apexlegendsstatus.com/algs 快照)
 * 功能: 积分榜 / 赛后图表(热力图·排名走势·地图局均) / 跳点分析 / 队伍详情
 * 图表配色跟随日间/暗黑主题（监听 html[data-theme] 变化自动重绘）
 */
import { ref, reactive, onMounted, onBeforeUnmount, nextTick, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import axios from 'axios'
import * as echarts from 'echarts'
import { Aim, DataLine, TrendCharts, Trophy } from '@element-plus/icons-vue'

// 动态赛事目录（后端从数据站解析）；以下为请求失败时的兜底列表
const FALLBACK_SEASONS = ['Y6-Split2', 'Y6-Split1', 'Y5-Split2', 'Y5-Split1', 'Y4-Split2', 'Y4-Split1', 'Y3-Split2', 'Y3-Split1']
const FALLBACK_LEAGUES = ['Pro-League', 'ALGS-Playoffs', 'ALGS-Championships', 'ALGS-Open', 'LCQ', 'BLGS', 'PLQ', 'EWC', 'ENC-Qualifiers']
const FALLBACK_REGIONS = ['NA', 'EMEA', 'APAC_N', 'APAC_S', 'SA', 'Global']
const seasons = ref([...FALLBACK_SEASONS])
const leagues = ref([...FALLBACK_LEAGUES])
const regions = ref([...FALLBACK_REGIONS])

const form = reactive({ season: 'Y6-Split2', league: 'Pro-League', region: 'NA' })
const loading = ref(false)
const refreshing = ref(false)
const data = ref(null)
const fetchedAt = ref('')

// 图表容器
const barRef = ref(null)
const heatmapRef = ref(null)
const lineRef = ref(null)
const mapRef = ref(null)
const legendRef = ref(null)
const mapAvgRef = ref(null)
const playersBarRef = ref(null)
const compBarRef = ref(null)
const chartInstances = []

// 队伍详情
const selectedTeam = ref('')
const activeTab = ref('standings')

// 跳点分析（POI 期望得分）
const poiData = ref(null)
const poiLoading = ref(false)
const poiError = ref('')
const poiSortKey = ref('avgPoints')
const poiBarRef = ref(null)
const poiMapName = ref('')

const poiMaps = computed(() => poiData.value?.maps || [])
const currentMap = computed(() => poiMaps.value.find((m) => m.name === poiMapName.value) || poiMaps.value[0] || null)

// ===================== 主题感知调色板 =====================

function isLightTheme() {
  return document.documentElement.hasAttribute('data-theme')
}

function palette() {
  const light = isLightTheme()
  return {
    text: light ? '#2c3e50' : '#e2e4f0',
    textSub: light ? '#5a6a7a' : '#9aa2c5',
    textMut: light ? '#8a9aa8' : '#6a7194',
    split: light ? '#e6ebf2' : 'rgba(255,255,255,0.07)',
    tipBg: light ? '#ffffff' : '#1c1c36',
    tipBorder: light ? '#d0d8e0' : '#2e2e56',
    cellBorder: light ? '#ffffff' : '#16162a',
    totalCell: light ? '#eef3fb' : 'rgba(64,158,255,0.14)',
    gold: light ? '#d4a017' : '#f0c040',
    silver: light ? '#7d8ba0' : '#aeb6c8',
    bronze: light ? '#c07a3d' : '#d29a6b',
    blue: '#409eff',
  }
}

// 逐小局得分色阶（按主题给出 4 档颜色 + 对比安全的文字色）
function heatPieces() {
  return isLightTheme()
    ? [
        { gte: 12, label: '≥12 分', color: '#f5c344', text: '#5c4300' },
        { gte: 8, lt: 12, label: '8-12', color: '#64a8f2', text: '#ffffff' },
        { gte: 4, lt: 8, label: '4-8', color: '#c3d9f7', text: '#33517e' },
        { lt: 4, label: '<4', color: '#e8edf5', text: '#93a1b3' },
      ]
    : [
        { gte: 12, label: '≥12 分', color: '#f0c040', text: '#201a00' },
        { gte: 8, lt: 12, label: '8-12', color: '#3f87e8', text: '#ffffff' },
        { gte: 4, lt: 8, label: '4-8', color: '#2b4a8c', text: '#cfe0ff' },
        { lt: 4, label: '<4', color: '#1d2440', text: '#68719c' },
      ]
}

function heatLabelColor(pieces, v) {
  for (const p of pieces) {
    if (p.gte != null && v >= p.gte && (p.lt == null || v < p.lt)) return p.text
    if (p.gte == null && v < p.lt) return p.text
  }
  return pieces[pieces.length - 1].text
}

// 地图局均色阶（柔和语义色，深色文字在两种主题下都可读）
const MAP_PIECES = [
  { gte: 10, label: '≥10 分', color: '#9fd8a2', text: '#2f5233' },
  { gte: 7, lt: 10, label: '7-10 分', color: '#f2e39a', text: '#6a5a1e' },
  { gte: 4, lt: 7, label: '4-7 分', color: '#f6cf9a', text: '#7a5020' },
  { lt: 4, label: '<4 分', color: '#f2b3aa', text: '#7c3229' },
]

function mapLabelColor(v) {
  for (const p of MAP_PIECES) {
    if (p.gte != null && v >= p.gte && (p.lt == null || v < p.lt)) return p.text
    if (p.gte == null && v < p.lt) return p.text
  }
  return MAP_PIECES[MAP_PIECES.length - 1].text
}

function tooltipStyle(pal) {
  return {
    backgroundColor: pal.tipBg,
    borderColor: pal.tipBorder,
    textStyle: { color: pal.text, fontSize: 12 },
    extraCssText: 'box-shadow: 0 6px 20px rgba(0,0,0,0.18); border-radius: 10px;',
  }
}

function axisLabel(pal, extra = {}) {
  return { color: pal.textSub, fontSize: 11, ...extra }
}

function splitLine(pal) {
  return { lineStyle: { color: pal.split } }
}

// 带名次的 y 轴标签（前三名奖牌色）
function rankAxisFormatter(rows, pal) {
  const rich = { nm: { color: pal.text, fontSize: 11, fontWeight: 600 } }
  rows.forEach((r, i) => {
    const color = r.rank === 1 ? pal.gold : r.rank === 2 ? pal.silver : r.rank === 3 ? pal.bronze : pal.textMut
    rich[`k${i}`] = { color, fontSize: 10, fontWeight: 700, align: 'right', width: 30 }
  })
  return {
    formatter: (team, i) => `{k${i}|#${rows[i]?.rank ?? i + 1}} {nm|${team}}`,
    rich,
  }
}

function teamLogo(slug) {
  if (!slug) return ''
  return `https://apexlegendsstatus.com/algs/assets/teams/${slug}.png`
}

// 非前三名队伍的图表配色（与 renderLine 保持一致）
const OTHER_COLORS = ['#4a9ff5', '#8bd46a', '#f5a623', '#e05f8f', '#9b6ef3', '#2fc2c2', '#7f8ff0', '#eb6f6f', '#67c23a', '#5a7db0', '#d4a5a5', '#88c0d0']

// ===================== 中文化 =====================
// 术语约定：一个赛段 = 三轮循环赛（每轮 AB/AC/BC 各一场）+ 一场区决，共 10 场。
// POI 样本按局计（“局均”），积分矩阵每格为一场比赛（“场均”）。
const MAP_CN = { 'Storm Point': '风暴点', 'E-District': '电力区', "World's Edge": '世界尽头' }
const GROUP_CN = { AvB: 'AB', AvC: 'AC', BvC: 'BC' }
// 跳点社区通用中文名（缺失时回退英文名，界面同时展示英文便于对照）
const POI_CN = {
  // Storm Point 风暴点
  'Cascade Falls': '叠瀑', 'Zeus Station': '宙斯站', 'The Mill': '磨坊', 'Lift': '升降梯',
  'Echo HQ': '回声总部', 'Jurassic': '侏罗纪', 'Ceto Station': '刻托站', 'Checkpoint': '检查站',
  'Coastal Camp': '海岸营地', 'The Wall': '高墙', 'Lightning Rod': '避雷针', 'Cenote Cave': '天坑洞穴',
  'Barometer': '气压站', 'Launch Pad': '发射台', 'North Pad': '北发射台', 'Command Center': '指挥中心',
  'The Pylon': '电塔', 'Downed Beast': '巨兽遗骸', 'Devastated Coast': '毁灭海岸', 'Storm Catcher': '捕风塔',
  'East Trail': '东部小径', 'Trident': '三叉戟',
  // E-District 电力区
  'Boardwalk': '木板路', 'Electro Dam': '电力大坝', 'Old Town': '老城区', 'Resort': '度假村',
  'Canal Plaza': '运河广场', 'Vibe Isle': '氛围岛', 'Galleria': '美术馆', 'Shipyard Arcade': '船坞拱廊',
  'Viaduct': '高架桥', 'The Lotus': '莲花楼', 'Stadium': '体育场', 'Settlement': '聚居区',
  'Energy Bank': '能量银行', 'Heights': '天使高地', 'Draft Point': '草稿点', 'Blossom Drive': '樱花大道',
  'Street Market': '街头市场', 'Humbert Labs': '亨伯特实验室', 'Neon Square': '霓虹广场', 'City Hall': '市政厅',
  // World's Edge 世界尽头
  'The Dome': '穹顶', 'Stacks': '集装箱区', 'Mirage A Trois': '幻象旅馆', 'Big Maude': '大莫德',
  'The Geyser': '间歇泉', 'Staging': '集结区', 'Launch Site': '发射场', 'Countdown': '倒计时',
  'The Epicenter': '震中', 'Thermal Station': '热能站', 'Sorting Factory': '分拣工厂', 'Harvester': '收割者',
  'Lava Fissure': '熔岩裂缝', 'East Village': '东村', 'Monument': '纪念碑', 'The Tree': '大树',
  'War Camp': '战营', 'Skyhook East': '东天空钩', 'Overlook': '瞭望台', 'Skyhook West': '西天空钩',
}

function mapCn(name) {
  return MAP_CN[name] || name
}

// 赛程标签：每轮包含 AB/AC/BC 各一场（共 9 场循环赛），第 10 场为决赛。
// 轮次 = 该组别（AB/AC/BC）第几次出现，不依赖日期连续性，后续比赛加入后自动顺延。
function gameLabel(idx, day, group, groups) {
  if ((!group || !group.trim()) && /final/i.test(String(day || ''))) return '决赛'
  const g = GROUP_CN[group] || group || ''
  const prior = (groups || []).slice(0, idx || 0).filter((x) => x === group).length
  const round = prior + 1
  return g ? `第${round}轮·${g}` : String(day || '')
}

// 统一生成 x 轴标签
function buildXLabels(games, groups) {
  return (games || []).map((g, i) => gameLabel(i, g, groups[i], groups))
}

function poiCn(name) {
  return POI_CN[name] || name
}

// ===================== 派生数据 =====================

// matrix 行排序：以积分榜名次为准（保证 #1 在热力图最上），缺失名次时按总分兜底。
// 数据源 matrix 的 rank 字段解析不可靠，名次取自 standings。
const sortedMatrixRows = computed(() => {
  const rankMap = {}
  ;(data.value?.standings || []).forEach((s) => {
    rankMap[s.team] = s.rank
  })
  const rows = [...(data.value?.matrix?.rows || [])]
  rows.sort((a, b) => {
    const ra = rankMap[a.team] ?? 9999
    const rb = rankMap[b.team] ?? 9999
    if (ra !== rb) return ra - rb
    const t = (b.total || 0) - (a.total || 0)
    if (t) return t
    return String(a.team).localeCompare(String(b.team))
  })
  return rows.map((r, i) => ({ ...r, rank: rankMap[r.team] ?? i + 1 }))
})

// 队名 → 局均得分 / 已赛小局数（按该队非空场次计，排除轮空）
const teamAvgMap = computed(() => {
  const map = {}
  sortedMatrixRows.value.forEach((r) => {
    const played = r.games.filter((g) => g != null).length
    map[r.team] = { avg: played ? (r.total / played).toFixed(1) : '-', played }
  })
  return map
})

// 队名 → 队徽 slug（standings 接口不含 slug，从 matrix 补）
const slugMap = computed(() => {
  const map = {}
  ;(data.value?.matrix?.rows || []).forEach((r) => {
    if (r.slug) map[r.team] = r.slug
  })
  return map
})

// 顶部概览指标（榜首以积分榜为准）
const overviewStats = computed(() => {
  const d = data.value
  if (!d) return null
  const standings = d.standings || []
  const rows = sortedMatrixRows.value
  const games = d.matrix?.games || []
  if (!rows.length || !games.length) return null
  const leaderStand = standings[0]
  const leaderRow = rows[0]
  const groups = d.matrix?.groups || []
  const xLabelsCache = buildXLabels(games, groups)
  let best = null
  rows.forEach((r) => {
    r.games.forEach((v, gi) => {
      if (v != null && (!best || v > best.score)) best = { score: v, team: r.team, label: xLabelsCache[gi] }
    })
  })
  const leaderName = leaderStand?.team || leaderRow.team
  const leaderTotal = leaderStand?.score ?? leaderRow.total
  const played = teamAvgMap.value[leaderName]?.played
  return {
    leader: {
      team: leaderName,
      total: leaderTotal,
      avg: played ? (leaderTotal / played).toFixed(1) : '-',
    },
    lead: standings.length > 1 ? (standings[0].score || 0) - (standings[1].score || 0) : null,
    gameCount: games.length,
    teamCount: rows.length,
    best,
  }
})

function rankClass(rank) {
  return rank === 1 ? 'r1' : rank === 2 ? 'r2' : rank === 3 ? 'r3' : ''
}

// 数据时间显示为本地时区（后端 SQLite 存 UTC 无时区标记，需补 Z 解析）
function formatTime(s) {
  if (!s) return ''
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}Z` : s)
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleString('zh-CN', { hour12: false })
}

async function loadCatalog() {
  try {
    const res = await axios.get('/api/algs/catalog')
    if (res.data?.seasons?.length) {
      seasons.value = res.data.seasons
      leagues.value = res.data.leagues
      regions.value = res.data.regions
      if (!res.data.seasons.includes(form.season)) {
        form.season = res.data.seasons[0]
        form.league = 'Pro-League'
        form.region = 'NA'
      }
    }
  } catch (error) {
    console.warn('赛事目录加载失败，使用兜底列表:', error.message)
  }
}

async function loadOverview() {
  loading.value = true
  try {
    const res = await axios.get('/api/algs/overview', { params: { ...form } })
    data.value = res.data
    fetchedAt.value = res.data.fetchedAt || ''
    if (res.data.matrix?.rows?.length) {
      selectedTeam.value = sortedMatrixRows.value[0].team
    }
    poiData.value = null
    dropsData.value = null
    dropsMapName.value = ''
    if (dropsRetryTimer) { clearTimeout(dropsRetryTimer); dropsRetryTimer = null }
    await nextTick()
    renderAllCharts()
    loadPoiStats()
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '加载 ALGS 数据失败')
  } finally {
    loading.value = false
  }
}

async function refresh() {
  refreshing.value = true
  try {
    const res = await axios.post('/api/algs/refresh', null, { params: { ...form } })
    data.value = res.data
    fetchedAt.value = res.data.fetchedAt || ''
    ElMessage.success('数据已刷新（比赛后一般 5-10 分钟内更新）')
    await nextTick()
    renderAllCharts()
    poiData.value = null
    dropsData.value = null
    loadPoiStats()
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '刷新失败')
  } finally {
    refreshing.value = false
  }
}

async function loadPoiStats() {
  poiLoading.value = true
  poiError.value = ''
  try {
    const res = await axios.get('/api/algs/poi-stats', { params: { ...form } })
    poiData.value = res.data
    // 保留当前选中的地图，否则回落到第一张
    const names = (res.data?.maps || []).map((m) => m.name)
    if (!names.includes(poiMapName.value)) poiMapName.value = names[0] || ''
    await nextTick()
    renderPoiBar()
  } catch (error) {
    poiError.value = error.response?.data?.error || '跳点数据加载失败'
  } finally {
    poiLoading.value = false
  }
}

watch(poiMapName, () => nextTick(() => renderPoiBar()))

function renderPoiBar() {
  const el = poiBarRef.value
  const pois = currentMap.value?.pois || []
  if (!el || !pois.length) return
  const chart = makeChart(el)
  if (!chart) return
  const pal = palette()
  const top = pois.slice(0, 15)
  chart.setOption({
    backgroundColor: 'transparent',
    grid: { left: 116, right: 46, top: 16, bottom: 30 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      ...tooltipStyle(pal),
      formatter: (params) => {
        const p = params[0]
        // y 轴数据经过 reverse，dataIndex 与原数组不对应，用显示名反查
        const poi = top.find((x) => poiCn(x.name) === p.name)
        if (!poi) return p.name
        return `${poiCn(poi.name)}（${poi.name}）<br/>局均得分: <b>${poi.avgPoints ?? '-'}</b> 分 · 样本 ${poi.picks} 小局`
      },
    },
    xAxis: { type: 'value', axisLabel: axisLabel(pal), splitLine: splitLine(pal) },
    yAxis: { type: 'category', data: top.map((p) => poiCn(p.name)).reverse(), axisLabel: axisLabel(pal, { color: pal.text }) },
    series: [{
      type: 'bar',
      data: top.map((p) => p.avgPoints).reverse(),
      barWidth: 14,
      itemStyle: {
        borderRadius: [0, 7, 7, 0],
        color: (params) => (params.data >= 8 ? '#f0c040' : params.data >= 5 ? '#409eff' : '#5a7db0'),
      },
      label: { show: true, position: 'right', color: pal.textSub, fontSize: 10, formatter: '{c} 分' },
    }],
  })
}

const sortedPois = computed(() => {
  const pois = currentMap.value?.pois || []
  const key = poiSortKey.value
  const sorted = [...pois]
  sorted.sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1))
  return sorted
})

// ===================== 各队跳点习惯（单局页聚合） =====================
const dropsData = ref(null)
const dropsLoading = ref(false)
const dropsError = ref('')
const dropsMapName = ref('')
let dropsRetryTimer = null

const dropsMaps = computed(() => Object.keys(dropsData.value?.maps || {}))
const currentDropsMap = computed(() => dropsData.value?.maps?.[dropsMapName.value] || null)

// 按积分榜名次排序的队伍跳点列表
const sortedDropTeams = computed(() => {
  const m = currentDropsMap.value
  if (!m) return []
  const rankMap = {}
  ;(data.value?.standings || []).forEach((s) => { rankMap[s.team] = s.rank })
  return Object.entries(m)
    .map(([team, pois]) => ({
      team,
      rank: rankMap[team] ?? 999,
      drops: Object.entries(pois)
        .map(([poi, count]) => ({ poi, cn: poiCn(poi), count }))
        .sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => a.rank - b.rank)
})

// 已赛单局按比赛日分组（含由跳点反推的地图）
const dropsGames = computed(() => {
  const games = dropsData.value?.games || []
  const byKey = new Map()
  for (const g of games) {
    const key = `${g.day}|${g.group}`
    if (!byKey.has(key)) byKey.set(key, { day: g.day, group: g.group, games: [] })
    byKey.get(key).games.push({ no: g.gameNo, map: g.map })
  }
  return [...byKey.values()]
    .map((x) => ({
      ...x,
      label: gameLabel(x.day - 1, `Day${x.day}`, x.group),
      games: x.games.sort((a, b) => (a.no || 0) - (b.no || 0)),
    }))
    .sort((a, b) => a.day - b.day)
})

async function loadTeamDrops() {
  if (dropsLoading.value) return
  dropsLoading.value = true
  dropsError.value = ''
  try {
    const res = await axios.get('/api/algs/team-drops', { params: { ...form } })
    dropsData.value = res.data
    const names = Object.keys(res.data?.maps || {})
    if (!names.includes(dropsMapName.value)) dropsMapName.value = names[0] || ''
    // 单局复盘选择器自动选中第一局
    if (!selectedGameKey.value) {
      const first = (res.data?.games || [])[0]
      if (first) selectedGameKey.value = `${first.day}|${first.group}|${first.hash}`
    }
  } catch (error) {
    dropsError.value = error.response?.data?.error || '各队跳点数据加载失败'
    // 数据源在后台聚合中（202）时 20 秒后自动重试
    if (error.response?.status === 202 && !dropsRetryTimer) {
      dropsRetryTimer = setTimeout(() => {
        dropsRetryTimer = null
        loadTeamDrops()
      }, 20000)
    }
  } finally {
    dropsLoading.value = false
  }
}

// ===================== 地图多维指标 =====================
const mapMetric = ref('avgPoints')
const mapMetricOptions = [
  { key: 'avgPoints', label: '局均得分' },
  { key: 'kills', label: '总击杀' },
  { key: 'wins', label: '胜场' },
  { key: 'top5', label: '前五次数' },
]

// 把 map-insights 表（{team, maps:[{name,value,pct}], total}）转成与局均得分一致的行结构
function normalizeMapRows(rows) {
  return (rows || []).map((r) => ({
    team: r.team,
    total: r.total,
    maps: (r.maps || []).map((m) => ({ name: m.name, avg: m.value, pct: m.pct })),
  }))
}

const mapMetricData = computed(() => {
  const d = data.value
  if (!d) return []
  switch (mapMetric.value) {
    case 'kills': return normalizeMapRows(d.mapKills)
    case 'wins': return normalizeMapRows(d.mapWins)
    case 'top5': return normalizeMapRows(d.mapTop5)
    default: return d.avgPointsPerMap || []
  }
})

// 各指标的色阶
function mapMetricPieces() {
  switch (mapMetric.value) {
    case 'kills':
      return [
        { gte: 15, label: '≥15 击杀', color: '#9fd8a2', text: '#2f5233' },
        { gte: 8, lt: 15, label: '8-15', color: '#f2e39a', text: '#6a5a1e' },
        { gte: 3, lt: 8, label: '3-8', color: '#f6cf9a', text: '#7a5020' },
        { lt: 3, label: '<3', color: '#f2b3aa', text: '#7c3229' },
      ]
    case 'wins':
      return [
        { gte: 2, label: '≥2 胜', color: '#9fd8a2', text: '#2f5233' },
        { gte: 1, lt: 2, label: '1 胜', color: '#f2e39a', text: '#6a5a1e' },
        { lt: 1, label: '0', color: '#f2b3aa', text: '#7c3229' },
      ]
    case 'top5':
      return [
        { gte: 5, label: '≥5 次', color: '#9fd8a2', text: '#2f5233' },
        { gte: 3, lt: 5, label: '3-4 次', color: '#f2e39a', text: '#6a5a1e' },
        { gte: 1, lt: 3, label: '1-2 次', color: '#f6cf9a', text: '#7a5020' },
        { lt: 1, label: '0', color: '#f2b3aa', text: '#7c3229' },
      ]
    default:
      return MAP_PIECES
  }
}

const mapMetricUnit = computed(() => ({ avgPoints: ' 分', kills: ' 杀', wins: ' 胜', top5: ' 次' }[mapMetric.value] || ''))

watch(mapMetric, () => nextTick(() => renderMapAvg()))

// ===================== 选手数据榜 =====================
const playersStats = computed(() => data.value?.playersStats || [])

const playerRankOptions = [
  { key: 'kills', label: '击杀' },
  { key: 'damage', label: '伤害' },
  { key: 'kad', label: 'KA/D' },
]
const playerRankKey = ref('kills')
const topPlayers = computed(() => {
  return [...playersStats.value]
    .filter((p) => p[playerRankKey.value] != null)
    .sort((a, b) => (b[playerRankKey.value] ?? -1) - (a[playerRankKey.value] ?? -1))
    .slice(0, 12)
})

// ===================== 版本生态 =====================
const evoLevel = ref(2)
const evoRows = computed(() => {
  const rows = evoLevel.value === 3 ? data.value?.evoUpgrades3 : data.value?.evoUpgrades2
  return [...(rows || [])].sort((a, b) => (b.picks || 0) - (a.picks || 0))
})

watch(playerRankKey, () => nextTick(() => renderPlayersBar()))

// =====================================================================
// 【单局复盘】现状备忘（2026-08-30）—— 下次接手先读完这一段
// =====================================================================
// 【功能目标】选一场比赛，展示：各队结算（名次/击杀/团灭时间/跳点）、团战时刻、圈节奏、落点分组。
//
// 【数据源（全部已验证可用，无需鉴权）】
// 1. 单局页 /algs/{season}/{league}/{region}/Day{N}/{AvB|AvC|BvC}/{hash}：
//    - score-matrix 表 = 该局记分板，列 [排名, 队伍, 得分, 场上名次P, 击杀K]
//    - teams-drops 表 = 该局各队跳点，但是匿名的（只有 POI+名次）→ 用"名次"与记分板 join 出队伍
//      （utils/algs.js 的 joinDropsToTeams，20/20 全部匹配成功）
//    - 内嵌 JS：let dropsData = {mp_rr_district:{team-N:{teamName,poi(id),teamColor}}}（地图代号可反推地图名）
//              const teamData = [{team,x,y}]（归一化落点坐标）
//              <select id="timelinePlayers"> 花名册（value="选手$选手$选手"，label=队伍名）
// 2. 逐秒时间线 /algs/local/getTimeline?gameId={hash}：
//    - kills: {秒:{选手:{kills:累计击杀}}}  ← 注意是累计值，用时必须差分（已踩坑）
//    - damage: {秒:{选手:{dealt/taken}}}   ← 只覆盖开局约 80 秒，与首次死亡时间(410s+)完全不重叠
//      → 结论：击杀者归因基本不可用，界面按此设计（大多数显示 —）
//    - player_state: {选手:[{timestamp(秒),state}]} ← 存活/死亡转移点 = 精确淘汰时刻（覆盖整场 ✓）
//    - rings: [{ringNumber,timestamp,state}] ← 只有圈关闭时间；圈心/半径（真正的圈型图）源站全线无数据
//    - 坑：数据里有脏时间戳（如 119157593），不过滤会导致滑窗循环 OOM 把后端跑崩（已修：>5000 丢弃）
//
// 【已完成的实现（代码都在，没删）】
// - 后端 utils/algs.js：parseGamePage（记分板+跳点+花名册+落点坐标+队伍色+mapKey）、
//   fetchAlgsTimeline、joinDropsToTeams、parsePoiStatsByMap/parseGameSchedule/parseGameLinks/
//   parsePlayersStats/parseMapInsightTable/parseEvoUpgrades/parseCompLegends/parseWeaponsStats
// - 后端 routes/algs.js：GET /api/algs/game-detail（聚合存活曲线/击杀事件/团战区/圈节奏/选手伤害/落点，缓存 24h）、
//   GET /api/algs/team-drops（抓全赛区所有单局页聚合各队跳点习惯，缓存 6h，games[] 内含 hash 供本页选择器用）
// - 前端本组件：单局复盘页签（选择器→本局战报卡片/团战时刻/圈节奏/落点分组），卡片式直观呈现（用户要求，图表版已废弃）
//
// 【当前卡点：仅打包版本(prod build)下本页签内容不渲染（整块空白），dev 模式正常】
// 现象：点击"单局复盘"后页签高亮正常，但 .gd-panel 整个不在 DOM 里（连无条件渲染的"选择比赛"工具栏都没有），
//       .el-tab-pane 只有 pane-standings 一个。而组件 setupState 里数据其实已加载完（gameDetail/dropsData 都有值），
//       DOM 与状态脱节 → 疑似 prod 下渲染效应器被某次渲染错误杀死（prod 不打印错误日志，所以看不到）。
// 已排查排除：浏览器缓存（加 bust 参数+重启 preview 一样）、API（页面内 fetch 200 且数据完整 7367 字节）、
//             HMR 残留（全新无痕标签页一样）、Vue 状态（setupState 正常）、模板注释未闭合。
// 曾非确定性成功过一次（prod 下 rows=20 / fights=6 / poiGroups=20 完整渲染），怀疑与 vite preview(sirv 在启动时
// 快照 dist 文件列表) 有关：preview 启动后重新 build，sirv 仍提供旧 index.html → 浏览器加载旧 bundle。
// 【下次排查建议（按性价比排序）】
// 1. prod 页面按 F12 看 Console 红色报错——大概率一眼定位（prod 的渲染错误用户侧可见，我们这边难抓）
// 2. 或临时在 main.js 挂 app.config.errorHandler 把错误显示到页面上
// 3. 或继续二分 gd-body 内容：已做过一轮——空占位✓ → 仅战报列表✓(20行) → +团战✓ → +圈节奏✓ → +落点分布✗，
//    但随后"完整版"又成功渲染过一次，非确定，建议每加一块都强刷+重启 preview 再验证
// 【上线注意】部署后用无痕窗口+强刷验证；本地验证务必重启 vite preview（sirv 快照问题）
// =====================================================================
const GD_MAINTENANCE = true // ← 调试完成后改为 false 即可恢复整页功能
const gdMaintenance = GD_MAINTENANCE // 模板用

const gameDetail = ref(null)
const gdLoading = ref(false)
const gdError = ref('')
const selectedGameKey = ref('') // `${day}|${group}|${hash}`

// 局选择器数据：来自各队跳点习惯接口（含 hash 与由落点反推的地图）
const gameSelectorGroups = computed(() => {
  const games = dropsData.value?.games || []
  const byKey = new Map()
  for (const g of games) {
    const key = `${g.day}|${g.group}`
    if (!byKey.has(key)) byKey.set(key, { day: g.day, group: g.group, label: gameLabel(g.day - 1, `Day${g.day}`, g.group), games: [] })
    byKey.get(key).games.push(g)
  }
  return [...byKey.values()]
    .map((x) => ({ ...x, games: x.games.sort((a, b) => (a.gameNo || 0) - (b.gameNo || 0)) }))
    .sort((a, b) => a.day - b.day)
})

const selectedGame = computed(() => {
  for (const grp of gameSelectorGroups.value) {
    const found = grp.games.find((g) => `${g.day}|${g.group}|${g.hash}` === selectedGameKey.value)
    if (found) return { ...found, groupLabel: grp.label }
  }
  return null
})

function fmtSec(t) {
  const m = Math.floor(t / 60)
  const sec = Math.round(t % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

async function loadGameDetail() {
  const g = selectedGame.value
  if (!g) return
  gdLoading.value = true
  gdError.value = ''
  gameDetail.value = null
  try {
    const res = await axios.get('/api/algs/game-detail', {
      params: { ...form, day: g.day, group: g.group, hash: g.hash },
    })
    gameDetail.value = res.data
  } catch (error) {
    gdError.value = error.response?.data?.error || '单局数据加载失败'
  } finally {
    gdLoading.value = false
  }
}

watch(selectedGameKey, (v) => { if (v) loadGameDetail() })

// 落点按 POI 分组（对跳一眼可见）
const gdPoiGroups = computed(() => {
  const groups = new Map()
  for (const d of gameDetail.value?.dropPoints || []) {
    const key = d.poi || '未知'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(d.team)
  }
  return [...groups.entries()]
    .map(([poi, teams]) => ({ poi, teams }))
    .sort((a, b) => b.teams.length - a.teams.length)
})

// ===================== 图表渲染 =====================

function disposeCharts() {
  while (chartInstances.length) {
    const c = chartInstances.pop()
    if (c) c.dispose()
  }
}

function makeChart(el, height) {
  if (!el) return null
  // 高度需在 init 前落位，否则画布按旧尺寸渲染（行会被挤扁）
  if (height) el.style.height = `${height}px`
  const chart = echarts.init(el)
  chartInstances.push(chart)
  return chart
}

function renderAllCharts() {
  disposeCharts()
  if (!data.value) return
  renderBar()
  renderHeatmap()
  renderLine()
  renderMap()
  renderLegend()
  renderMapAvg()
  renderPoiBar()
  renderPlayersBar()
  renderCompBar()
}


// 选手数据榜：击杀/伤害/KA-D Top 12 横向条形图
function renderPlayersBar() {
  const el = playersBarRef.value
  const top = topPlayers.value
  if (!el || !top.length) return
  const pal = palette()
  const chart = makeChart(el, Math.max(280, top.length * 30 + 60))
  if (!chart) return
  const opt = playerRankOptions.find((o) => o.key === playerRankKey.value)
  chart.setOption({
    backgroundColor: 'transparent',
    grid: { left: 170, right: 60, top: 16, bottom: 30 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      ...tooltipStyle(pal),
      formatter: (params) => {
        const p = params[0]
        // y 轴数据经过 reverse，按显示名反查选手
        const row = top.find((x) => `${x.player} · ${x.team}` === p.name)
        if (!row) return p.name
        return `${p.marker}<b>${row.player}</b>（${row.team}）<br/>${opt?.label || ''}: <b>${row[playerRankKey.value]}</b>`
      },
    },
    xAxis: { type: 'value', axisLabel: axisLabel(pal), splitLine: splitLine(pal) },
    yAxis: { type: 'category', data: top.map((p) => `${p.player} · ${p.team}`).reverse(), axisLabel: axisLabel(pal, { color: pal.text, fontSize: 10 }) },
    series: [{
      type: 'bar',
      data: top.map((p) => p[playerRankKey.value]).reverse(),
      barWidth: 14,
      itemStyle: { color: '#409eff', borderRadius: [0, 7, 7, 0] },
      label: { show: true, position: 'right', color: pal.textSub, fontSize: 10 },
    }],
  })
}

// 版本生态：英雄组合选用率 Top 10
function renderCompBar() {
  const el = compBarRef.value
  const comps = [...(data.value?.compLegends || [])]
    .sort((a, b) => (b.pickRate || 0) - (a.pickRate || 0))
    .slice(0, 10)
  if (!el || !comps.length) return
  const pal = palette()
  const chart = makeChart(el, Math.max(280, comps.length * 30 + 60))
  if (!chart) return
  chart.setOption({
    backgroundColor: 'transparent',
    grid: { left: 190, right: 60, top: 16, bottom: 30 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      ...tooltipStyle(pal),
      formatter: (params) => {
        const p = params[0]
        const row = comps.find((c) => c.composition.split(', ').join('+') === p.name)
        if (!row) return p.name
        return `<b>${row.composition}</b><br/>选用率: <b>${row.pickRate}%</b> · 场次样本<br/>平均名次: ${row.avgPlacement ?? '-'} · 胜率: ${row.winRate ?? '-'}% · 前五率: ${row.top5Rate ?? '-'}%`
      },
    },
    xAxis: { type: 'value', axisLabel: { ...axisLabel(pal), formatter: '{value}%' }, splitLine: splitLine(pal) },
    yAxis: { type: 'category', data: comps.map((c) => c.composition.split(', ').join('+')).reverse(), axisLabel: axisLabel(pal, { color: pal.text, fontSize: 10 }) },
    series: [{
      type: 'bar',
      data: comps.map((c) => c.pickRate).reverse(),
      barWidth: 14,
      itemStyle: { color: '#9b6ef3', borderRadius: [0, 7, 7, 0] },
      label: { show: true, position: 'right', color: pal.textSub, fontSize: 10, formatter: '{c}%' },
    }],
  })
}

// 总积分 Top 15 横向条形图（y 轴带队徽）
function renderBar() {
  const el = barRef.value
  if (!el || !data.value?.standings?.length) return
  const pal = palette()
  const top = data.value.standings.slice(0, 15)
  const chart = makeChart(el)
  if (!chart) return
  const idx = new Map(top.map((t, i) => [t.team, i]))
  const rich = { nm: { color: pal.text, fontSize: 11, fontWeight: 600, padding: [0, 0, 0, 6] } }
  top.forEach((t, i) => {
    const slug = t.slug || slugMap.value[t.team]
    rich[`i${i}`] = slug ? { backgroundColor: { image: teamLogo(slug) }, width: 18, height: 18 } : { width: 4 }
  })
  chart.setOption({
    backgroundColor: 'transparent',
    grid: { left: 150, right: 44, top: 16, bottom: 30 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      ...tooltipStyle(pal),
      formatter: (params) => {
        const p = params[0]
        const t = top.find((x) => x.team === p.name)
        if (!t) return p.name
        return `${p.marker}${t.team}<br/>积分: <b>${t.score}</b>${t.kills != null ? ` · 击杀: ${t.kills}` : ''}`
      },
    },
    xAxis: { type: 'value', axisLabel: axisLabel(pal), splitLine: splitLine(pal) },
    yAxis: {
      type: 'category',
      data: top.map((t) => t.team).reverse(),
      axisLabel: {
        ...axisLabel(pal),
        // 注意：y 轴 label formatter 的 index 是从上往下的视觉序号（与数组索引不同向），
        // 因此一律用队名查 rich 键，避免 logo 上下错位
        formatter: (name) => {
          const i = idx.get(name)
          return i != null ? `{i${i}|}{nm|${name}}` : `{nm|${name}}`
        },
        rich,
      },
    },
    series: [{
      type: 'bar',
      data: top.map((t) => t.score).reverse(),
      barWidth: 14,
      itemStyle: {
        borderRadius: [0, 7, 7, 0],
        color: (p) => {
          const rank = (idx.get(p.name) ?? top.length - 1 - p.dataIndex) + 1
          return rank === 1 ? '#f0c040' : rank === 2 ? '#aeb6c8' : rank === 3 ? '#c98a4b' : '#409eff'
        },
      },
      label: { show: true, position: 'right', color: pal.textSub, fontSize: 10 },
    }],
  })
}

// 逐场得分热力图：按最终排名排序，行标带名次，末列总分（第1-9场循环赛 + 决赛）
function renderHeatmap() {
  const el = heatmapRef.value
  const rows = sortedMatrixRows.value
  const games = data.value?.matrix?.games || []
  const groups = data.value?.matrix?.groups || []
  if (!el || !rows.length || !games.length) return
  const pal = palette()
  const pieces = heatPieces()
  const chart = makeChart(el, Math.max(380, rows.length * 28 + 130))

  const xLabels = buildXLabels(games, groups)
  const totalCol = games.length
  const colBest = games.map((_, gi) => {
    let max = -1
    rows.forEach((r) => {
      const v = r.games[gi]
      if (v != null && v > max) max = v
    })
    return max
  })

  const values = []
  rows.forEach((r, ri) => {
    r.games.forEach((g, gi) => {
      if (g == null) return
      const item = { value: [gi, ri, g], label: { color: heatLabelColor(pieces, g) } }
      values.push(item)
    })
    values.push({
      value: [totalCol, ri, r.total],
      label: { color: pal.text, fontWeight: 700 },
      itemStyle: { color: pal.totalCell, borderColor: pal.cellBorder, borderWidth: 3 },
    })
  })

  chart.setOption({
    backgroundColor: 'transparent',
    grid: { left: 158, right: 16, top: 12, bottom: 66 },
    tooltip: {
      ...tooltipStyle(pal),
      formatter: (p) => {
        const row = rows[p.value[1]]
        if (p.value[0] === totalCol) {
          return `<b>${row.team}</b><br/>总积分: <b>${p.value[2]}</b>（${rows.length} 队第 ${row.rank} 名）`
        }
        const bestMark = p.value[2] === colBest[p.value[0]] ? '<br/>🏆 该局最高分' : ''
        return `<b>${row.team}</b><br/>${xLabels[p.value[0]]} 得分: <b>${p.value[2]}</b>${bestMark}`
      },
    },
    xAxis: { type: 'category', data: [...xLabels, '总分'], axisLabel: axisLabel(pal, { fontWeight: 600, interval: 0, rotate: xLabels.length > 6 ? 30 : 0 }), splitArea: { show: false }, axisTick: { show: false } },
    yAxis: {
      type: 'category',
      data: rows.map((r) => r.team),
      inverse: true,
      axisLabel: { ...axisLabel(pal), ...rankAxisFormatter(rows, pal) },
      axisTick: { show: false },
      axisLine: { show: false },
    },
    visualMap: {
      type: 'piecewise',
      show: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      pieces: pieces.map((p) => ({ gte: p.gte, lt: p.lt, label: p.label, color: p.color })),
      textStyle: { color: pal.textMut, fontSize: 10 },
      itemWidth: 14,
      itemHeight: 10,
    },
    series: [{
      type: 'heatmap',
      data: values,
      label: { show: true, fontWeight: 600, fontSize: 11 },
      itemStyle: { borderColor: pal.cellBorder, borderWidth: 3, borderRadius: 4 },
      emphasis: { itemStyle: { shadowBlur: 6, shadowColor: 'rgba(0,0,0,0.3)' } },
    }],
  })
}

// 排名走势（bump chart）：默认展示最终前 8 名，图例可叠加其他队伍
function renderLine() {
  const el = lineRef.value
  const rows = sortedMatrixRows.value
  const games = data.value?.matrix?.games || []
  const groups = data.value?.matrix?.groups || []
  if (!el || !rows.length || games.length < 1) return
  const pal = palette()
  const chart = makeChart(el, 480)
  if (!chart) return

  const teams = rows.map((r) => {
    let acc = 0
    const cum = r.games.map((g) => {
      acc += g || 0
      return acc
    })
    return { team: r.team, cum }
  })
  const rankAt = games.map((_, gi) => {
    const sorted = [...teams].sort((a, b) => (b.cum[gi] ?? -1e9) - (a.cum[gi] ?? -1e9))
    const map = {}
    sorted.forEach((t, i) => { map[t.team] = i + 1 })
    return map
  })
  const xLabels = buildXLabels(games, groups)

  const finalRank = rankAt[games.length - 1]
  const rankedTeams = [...teams].sort((a, b) => finalRank[a.team] - finalRank[b.team])
  const MEDALS = [pal.gold, pal.silver, pal.bronze]
  const colorOf = (team, idx) => {
    const fr = finalRank[team]
    return fr <= 3 ? MEDALS[fr - 1] : OTHER_COLORS[idx % OTHER_COLORS.length]
  }
  const defaultShow = new Set(rankedTeams.slice(0, 8).map((t) => t.team))
  const legendSelected = {}
  teams.forEach((t) => { legendSelected[t.team] = defaultShow.has(t.team) })

  const series = teams.map((t, i) => {
    const hero = defaultShow.has(t.team)
    const color = colorOf(t.team, i)
    return {
      name: t.team,
      type: 'line',
      data: games.map((_, gi) => rankAt[gi][t.team]),
      symbol: 'circle',
      symbolSize: hero ? 5 : 3,
      lineStyle: { width: hero ? 2.4 : 1, opacity: hero ? 0.95 : 0.4, color },
      itemStyle: { color },
      emphasis: { lineStyle: { width: 3.5, opacity: 1 }, focus: 'series' },
      endLabel: { show: true, formatter: t.team, fontSize: 10, color: pal.text, fontWeight: hero ? 600 : 400 },
      labelLayout: { moveOverlap: 'shiftY' },
      z: hero ? 5 : 2,
    }
  })

  chart.setOption({
    backgroundColor: 'transparent',
    grid: { left: 40, right: 118, top: 20, bottom: 74 },
    tooltip: {
      trigger: 'axis',
      ...tooltipStyle(pal),
      formatter: (params) => {
        const gi = params[0]?.dataIndex ?? 0
        const sorted = [...teams].sort((a, b) => rankAt[gi][a.team] - rankAt[gi][b.team])
        let html = `<b>${xLabels[gi]}</b><br/>`
        sorted.slice(0, 8).forEach((t) => {
          html += `${rankAt[gi][t.team] <= 3 ? '🏅' : '·'} 第 ${rankAt[gi][t.team]} 名 — ${t.team}（${t.cum[gi]} 分）<br/>`
        })
        return html
      },
    },
    legend: {
      type: 'scroll',
      bottom: 0,
      left: 'center',
      data: teams.map((t) => t.team),
      selected: legendSelected,
      textStyle: { color: pal.textSub, fontSize: 10 },
      pageIconColor: pal.textSub,
      pageIconInactiveColor: pal.split,
      pageTextStyle: { color: pal.textMut },
    },
    xAxis: { type: 'category', data: xLabels, axisLabel: axisLabel(pal, { fontWeight: 600, interval: 0, rotate: xLabels.length > 6 ? 30 : 0 }), axisTick: { show: false }, axisLine: { lineStyle: { color: pal.split } } },
    yAxis: {
      type: 'value',
      inverse: true,
      min: 1,
      max: rows.length,
      axisLabel: {
        color: pal.textMut,
        fontSize: 10,
        formatter: (v) => ([1, 5, 10, 15, 20, 25, 30].includes(v) || v === rows.length ? v : ''),
      },
      splitLine: { lineStyle: { color: pal.split, type: 'dashed' } },
    },
    series,
  })
}

// 各队地图数据热力图（局均得分/总击杀/胜场/前五次数），按总量降序，柔和语义色阶
function renderMapAvg() {
  const el = mapAvgRef.value
  const allRows = mapMetricData.value
  if (!el || !allRows.length) return
  const pal = palette()
  const pieces = mapMetricPieces()
  const rows = [...allRows].sort((a, b) => (b.total || 0) - (a.total || 0))
  const chart = makeChart(el, Math.max(300, rows.length * 28 + 110))
  if (!chart) return
  const mapNames = rows[0].maps.map((m) => m.name)
  const colBest = mapNames.map((_, mi) => {
    let max = -1
    rows.forEach((r) => {
      const v = r.maps[mi]?.avg
      if (v != null && v > max) max = v
    })
    return max
  })
  const labelColor = (v) => {
    for (const p of pieces) {
      if (p.gte != null && v >= p.gte && (p.lt == null || v < p.lt)) return p.text
      if (p.gte == null && v < p.lt) return p.text
    }
    return pieces[pieces.length - 1].text
  }
  const values = []
  rows.forEach((r, ri) => {
    r.maps.forEach((m, mi) => {
      if (m.avg == null) return
      const item = { value: [mi, ri, m.avg], label: { color: labelColor(m.avg) } }
      values.push(item)
    })
  })
  const unit = mapMetricUnit.value

  chart.setOption({
    backgroundColor: 'transparent',
    grid: { left: 158, right: 16, top: 12, bottom: 60 },
    tooltip: {
      ...tooltipStyle(pal),
      formatter: (p) => {
        const row = rows[p.value[1]]
        const map = mapNames[p.value[0]] || ''
        const m = row.maps.find((x) => x.name === map)
        const pctNote = m?.pct != null && mapMetric.value !== 'avgPoints' ? `（占全队 ${m.pct}%）` : m?.pct != null ? `（占该图样本 ${m.pct}%）` : ''
        return `<b>${row.team}</b><br/>${map} ${mapMetricOptions.find((o) => o.key === mapMetric.value)?.label || ''}: <b>${p.value[2]}</b>${unit}${pctNote}`
      },
    },
    xAxis: { type: 'category', data: mapNames, axisLabel: axisLabel(pal, { fontWeight: 600 }), splitArea: { show: false }, axisTick: { show: false } },
    yAxis: {
      type: 'category',
      data: rows.map((r, i) => r.team),
      inverse: true,
      axisLabel: { ...axisLabel(pal), ...rankAxisFormatter(rows.map((r, i) => ({ ...r, rank: i + 1 })), pal) },
      axisTick: { show: false },
      axisLine: { show: false },
    },
    visualMap: {
      type: 'piecewise',
      show: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      pieces: pieces.map((p) => ({ gte: p.gte, lt: p.lt, label: p.label, color: p.color })),
      textStyle: { color: pal.textMut, fontSize: 10 },
      itemWidth: 14,
      itemHeight: 10,
    },
    series: [{
      type: 'heatmap',
      data: values,
      label: { show: true, fontWeight: 600, fontSize: 11 },
      itemStyle: { borderColor: pal.cellBorder, borderWidth: 3, borderRadius: 4 },
      emphasis: { itemStyle: { shadowBlur: 6, shadowColor: 'rgba(0,0,0,0.3)' } },
    }],
  })
}

// 队伍详情：选中队伍的地图局均柱状图
function renderMap() {
  const el = mapRef.value
  if (!el || !data.value) return
  const pal = palette()
  const team = selectedTeam.value
  // 优先用局均得分数据，缺失时回退到总分
  const info = (data.value.avgPointsPerMap || []).find((m) => m.team === team)
  const maps = info?.maps || (data.value.mapInsights || []).find((m) => m.team === team)?.maps || []
  if (!maps.length) return
  const chart = makeChart(el)
  if (!chart) return
  chart.setOption({
    backgroundColor: 'transparent',
    grid: { left: 60, right: 30, top: 40, bottom: 40 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      ...tooltipStyle(pal),
      formatter: (params) => {
        const p = params[0]
        const m = maps[p.dataIndex]
        return `${p.name}<br/>局均得分: <b>${p.value}</b>${m.pct != null ? ` (${m.pct}%)` : ''}`
      },
    },
    xAxis: { type: 'category', data: maps.map((m) => m.name), axisLabel: axisLabel(pal, { color: pal.text }) },
    yAxis: { type: 'value', name: '局均得分', nameTextStyle: { color: pal.textMut }, axisLabel: axisLabel(pal), splitLine: splitLine(pal) },
    series: [{
      name: '局均得分',
      type: 'bar',
      barWidth: 64,
      data: maps.map((m) => (info ? m.avg : m.score)),
      itemStyle: { color: '#409eff', borderRadius: [8, 8, 0, 0] },
      label: { show: true, position: 'top', color: pal.text, fontSize: 12, fontWeight: 600, formatter: '{c} 分' },
    }],
  })
}

// 队伍详情：选手英雄使用排行
function renderLegend() {
  const el = legendRef.value
  const legends = data.value?.legends || []
  if (!el || !legends.length) return
  const pal = palette()
  const chart = makeChart(el)
  if (!chart) return
  const agg = {}
  legends.forEach((p) => {
    Object.entries(p.pickRates || {}).forEach(([legend, count]) => {
      agg[legend] = (agg[legend] || 0) + count
    })
  })
  const sorted = Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 12)
  chart.setOption({
    backgroundColor: 'transparent',
    grid: { left: 90, right: 50, top: 16, bottom: 30 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, ...tooltipStyle(pal) },
    xAxis: { type: 'value', axisLabel: axisLabel(pal), splitLine: splitLine(pal) },
    yAxis: { type: 'category', data: sorted.map((s) => s[0]).reverse(), axisLabel: axisLabel(pal, { color: pal.text }) },
    series: [{
      type: 'bar',
      data: sorted.map((s) => s[1]).reverse(),
      barWidth: 14,
      itemStyle: { color: '#f0c040', borderRadius: [0, 7, 7, 0] },
      label: { show: true, position: 'right', color: pal.textSub, fontSize: 10 },
    }],
  })
}

// ===================== 队伍详情 =====================

const selectedTeamInfo = computed(() => {
  if (!data.value) return null
  const team = selectedTeam.value
  const standings = data.value.standings.find((s) => s.team === team)
  const mapInfo = data.value.mapInsights.find((m) => m.team === team)
  const matrix = data.value.matrix.rows.find((r) => r.team === team)
  return { standings, mapInfo, matrix }
})

function resizeCharts() {
  chartInstances.forEach((c) => c && c.resize())
}

function handleResize() {
  resizeCharts()
}

// tab 切换：lazy 容器首次激活后重绘图表（避免隐藏容器 0 尺寸导致图表挤成一坨）
function handleTabChange(name) {
  if (name === 'poi') {
    if (!poiData.value && !poiLoading.value) loadPoiStats()
    if (!dropsData.value && !dropsLoading.value) loadTeamDrops()
  }
  // gamereview 维护中（GD_MAINTENANCE=true），不预取数据
  nextTick(() => renderAllCharts())
}

// 主题切换（日间/暗黑）时重绘所有图表
let themeObserver = null
let lastThemeIsLight = false

function watchTheme() {
  lastThemeIsLight = isLightTheme()
  themeObserver = new MutationObserver(() => {
    const light = isLightTheme()
    if (light === lastThemeIsLight) return
    lastThemeIsLight = light
    nextTick(() => renderAllCharts())
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
}

onMounted(async () => {
  watchTheme()
  await loadCatalog()
  loadOverview()
  loadPoiStats() // 后台预热跳点数据
  window.addEventListener('resize', handleResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
  if (themeObserver) themeObserver.disconnect()
  disposeCharts()
})
</script>

<template>
  <div class="algs-view">
    <h2 class="page-title">ALGS 赛事数据</h2>
    <p class="page-desc">Apex Legends Global Series 职业联赛数据可视化（数据来源 apexlegendsstatus.com，每局结束后更新）</p>

    <div class="algs-toolbar">
      <div class="toolbar-field">
        <label>赛季</label>
        <el-select v-model="form.season" class="algs-select" @change="loadOverview">
          <el-option v-for="s in seasons" :key="s" :label="s" :value="s" />
        </el-select>
      </div>
      <div class="toolbar-field">
        <label>联赛</label>
        <el-select v-model="form.league" class="algs-select" @change="loadOverview">
          <el-option v-for="l in leagues" :key="l" :label="l" :value="l" />
        </el-select>
      </div>
      <div class="toolbar-field">
        <label>赛区</label>
        <el-select v-model="form.region" class="algs-select" @change="loadOverview">
          <el-option v-for="r in regions" :key="r" :label="r" :value="r" />
        </el-select>
      </div>
      <el-button type="primary" :loading="refreshing" @click="refresh">刷新数据</el-button>
      <span v-if="fetchedAt" class="algs-updated">数据时间: {{ formatTime(fetchedAt) }}</span>
    </div>

    <!-- 概览指标条 -->
    <section v-if="overviewStats" class="kpi-row">
      <div class="kpi-card">
        <div class="kpi-icon gold"><el-icon><Trophy /></el-icon></div>
        <div class="kpi-body">
          <span class="kpi-label">当前榜首</span>
          <span class="kpi-value kpi-strong">{{ overviewStats.leader.team }}</span>
          <span class="kpi-sub">
            {{ overviewStats.leader.total }} 分
            <template v-if="overviewStats.lead != null && overviewStats.lead > 0"> · 领先第 2 名 {{ overviewStats.lead }} 分</template>
          </span>
        </div>
      </div>
      <div class="kpi-card">
        <div class="kpi-icon blue"><el-icon><Aim /></el-icon></div>
        <div class="kpi-body">
          <span class="kpi-label">单场最高</span>
          <span class="kpi-value">{{ overviewStats.best.score }} 分</span>
          <span class="kpi-sub">{{ overviewStats.best.team }} · {{ overviewStats.best.label }}</span>
        </div>
      </div>
      <div class="kpi-card">
        <div class="kpi-icon green"><el-icon><TrendCharts /></el-icon></div>
        <div class="kpi-body">
          <span class="kpi-label">赛程进度</span>
          <span class="kpi-value">{{ overviewStats.gameCount }} 场比赛</span>
          <span class="kpi-sub">共 {{ overviewStats.teamCount }} 支队伍</span>
        </div>
      </div>
      <div class="kpi-card">
        <div class="kpi-icon purple"><el-icon><DataLine /></el-icon></div>
        <div class="kpi-body">
          <span class="kpi-label">榜首场均</span>
          <span class="kpi-value">{{ overviewStats.leader.avg }} 分</span>
          <span class="kpi-sub">每场平均得分</span>
        </div>
      </div>
    </section>

    <el-tabs v-model="activeTab" type="border-card" class="algs-tabs" v-loading="loading" @tab-change="handleTabChange">
      <!-- 积分榜 -->
      <el-tab-pane label="积分榜" name="standings">
        <div v-if="data" class="standings-grid">
          <section class="algs-panel">
            <header class="panel-head">
              <h3>总积分排行</h3>
              <p>按总积分排序，含击杀与场均数据</p>
            </header>
            <el-table :data="data.standings" size="small" stripe height="520" empty-text="暂无数据">
              <el-table-column label="#" width="64">
                <template #default="{ $index }">
                  <span class="rank-chip" :class="rankClass($index + 1)">{{ $index + 1 }}</span>
                </template>
              </el-table-column>
              <el-table-column label="队伍" min-width="200">
                <template #default="{ row }">
                  <span class="team-cell">
                    <img v-if="teamLogo(slugMap[row.team])" :src="teamLogo(slugMap[row.team])" class="team-logo" alt="" @error="(e) => (e.target.style.display = 'none')" />
                    {{ row.team }}
                  </span>
                </template>
              </el-table-column>
              <el-table-column prop="score" label="积分" width="90" sortable>
                <template #default="{ row }"><b class="score-num">{{ row.score }}</b></template>
              </el-table-column>
              <el-table-column prop="kills" label="击杀" width="80">
                <template #default="{ row }">{{ row.kills ?? '-' }}</template>
              </el-table-column>
              <el-table-column label="场均" width="76">
                <template #default="{ row }">{{ teamAvgMap[row.team]?.avg ?? '-' }}</template>
              </el-table-column>
            </el-table>
          </section>
          <section class="algs-panel">
            <header class="panel-head">
              <h3>积分对比（Top 15）</h3>
              <p>金 / 银 / 铜色为前三名</p>
            </header>
            <div ref="barRef" class="chart-box"></div>
          </section>
        </div>
      </el-tab-pane>

      <!-- 赛后图表 -->
      <el-tab-pane label="赛后图表" name="charts" lazy>
        <div v-if="data" class="charts-stack">
          <section class="algs-panel">
            <header class="panel-head">
              <h3>逐场得分热力图</h3>
              <p>队伍按最终排名排列 · 每格为一场比赛的得分（AB / AC / BC 各一场为一轮，三轮循环赛 + 决赛）· 最右列为总积分</p>
            </header>
            <div ref="heatmapRef" class="chart-box chart-heat"></div>
          </section>
          <section class="algs-panel">
            <header class="panel-head">
              <h3>排名走势</h3>
              <p>默认展示最终前 8 名的累计排名变化（金 / 银 / 铜 = 前三名），点击下方图例可叠加其他队伍</p>
            </header>
            <div ref="lineRef" class="chart-box chart-bump"></div>
          </section>
          <section class="algs-panel">
            <header class="panel-head">
              <h3>各队地图数据</h3>
              <p>按总量降序 · 绿色 = 强势地图，红色 = 短板地图</p>
            </header>
            <div class="algs-toolbar poi-toolbar">
              <span class="algs-updated">指标：</span>
              <el-radio-group v-model="mapMetric" size="small">
                <el-radio-button v-for="o in mapMetricOptions" :key="o.key" :value="o.key">{{ o.label }}</el-radio-button>
              </el-radio-group>
            </div>
            <div ref="mapAvgRef" class="chart-box chart-maps"></div>
          </section>
        </div>
      </el-tab-pane>

      <!-- 跳点分析：POI 期望得分 -->
      <el-tab-pane label="跳点分析" name="poi" lazy>
        <!-- 各队跳点习惯（单局页聚合） -->
        <section v-loading="dropsLoading" class="algs-panel drops-panel">
          <header class="panel-head">
            <h3>各队跳点习惯（{{ form.region }} 赛区，已解析 {{ dropsData?.gamesFetched ?? '…' }}/{{ dropsData?.gamesTotal ?? '…' }} 局）</h3>
            <p>来自每局的官方落点记录（按比赛名次与记分板匹配到队伍），按地图分别统计落点次数</p>
          </header>
          <div v-if="dropsError" class="poi-error">
            {{ dropsError }}
            <el-button size="small" style="margin-left: 10px;" @click="loadTeamDrops">重试</el-button>
          </div>
          <template v-else-if="dropsData">
            <div class="algs-toolbar poi-toolbar">
              <span class="algs-updated">地图：</span>
              <el-radio-group v-model="dropsMapName" size="small">
                <el-radio-button v-for="m in dropsMaps" :key="m" :value="m">{{ mapCn(m) }}</el-radio-button>
              </el-radio-group>
            </div>
            <div class="drops-grid">
              <el-table :data="sortedDropTeams" size="small" stripe height="420" empty-text="暂无数据">
                <el-table-column label="#" width="56">
                  <template #default="{ row }">
                    <span class="rank-chip" :class="rankClass(row.rank)">{{ row.rank <= 999 ? row.rank : '-' }}</span>
                  </template>
                </el-table-column>
                <el-table-column label="队伍" min-width="140">
                  <template #default="{ row }">
                    <span class="team-cell">
                      <img v-if="teamLogo(slugMap[row.team])" :src="teamLogo(slugMap[row.team])" class="team-logo" alt="" @error="(e) => (e.target.style.display = 'none')" />
                      {{ row.team }}
                    </span>
                  </template>
                </el-table-column>
                <el-table-column label="落点分布（次数）" min-width="220">
                  <template #default="{ row }">
                    <span class="poi-regions">
                      <span v-for="d in row.drops" :key="d.poi" class="poi-region-chip" :title="`${d.poi} × ${d.count}`">
                        {{ d.cn }} ×{{ d.count }}
                      </span>
                    </span>
                  </template>
                </el-table-column>
              </el-table>
              <section>
                <h3 class="drops-sub">已赛单局与地图</h3>
                <div class="schedule-list">
                  <div v-for="(g, i) in dropsGames" :key="i" class="schedule-item">
                    <span class="schedule-label">{{ g.label }}</span>
                    <span class="poi-regions">
                      <span v-for="game in g.games" :key="game.no" class="poi-region-chip" :title="`第${game.no}局`">
                        G{{ game.no }} {{ mapCn(game.map) }}
                      </span>
                    </span>
                  </div>
                </div>
              </section>
            </div>
          </template>
          <p v-else class="algs-empty">正在抓取各局落点记录（首次约需 1-2 分钟）…</p>
        </section>
        <div v-loading="poiLoading" class="poi-panel poi-panel-gap">
          <div v-if="poiError" class="poi-error">{{ poiError }}</div>
          <template v-else-if="poiData && currentMap">
            <header class="panel-head">
              <h3>每个跳点的局均得分期望（{{ currentMap.nameCn }} {{ currentMap.name }}）</h3>
              <p>
                综合 {{ poiData.regions.join(' / ') }} 赛区 × {{ currentMap.poiCount }} 个跳点，共 {{ currentMap.totalSamples }} 小局样本。
                跳点局均得分越高，说明在该点位开局的平均收益越好（名次分 + 击杀分）。
              </p>
            </header>
            <div class="algs-toolbar poi-toolbar">
              <span class="algs-updated">地图：</span>
              <el-radio-group v-model="poiMapName" size="small">
                <el-radio-button v-for="m in poiMaps" :key="m.name" :value="m.name">{{ m.nameCn }}</el-radio-button>
              </el-radio-group>
            </div>
            <div class="algs-toolbar poi-toolbar">
              <span class="algs-updated">排序：</span>
              <el-radio-group v-model="poiSortKey" size="small">
                <el-radio-button value="avgPoints">局均得分</el-radio-button>
                <el-radio-button value="avgKills">局均击杀</el-radio-button>
                <el-radio-button value="avgPlacement">平均名次</el-radio-button>
                <el-radio-button value="wins">胜场</el-radio-button>
                <el-radio-button value="picks">样本数</el-radio-button>
              </el-radio-group>
            </div>
            <div class="poi-grid">
              <section class="algs-panel">
                <h3>局均得分排行（Top 15）</h3>
                <div ref="poiBarRef" class="chart-box chart-poi"></div>
              </section>
              <section class="algs-panel">
                <h3>跳点明细（可点击表头排序）</h3>
                <el-table :data="sortedPois" size="small" stripe height="480" empty-text="暂无数据">
                  <el-table-column label="跳点 (POI)" min-width="150">
                    <template #default="{ row }">
                      <span class="poi-name">{{ poiCn(row.name) }}</span>
                      <span v-if="poiCn(row.name) !== row.name" class="poi-en">{{ row.name }}</span>
                    </template>
                  </el-table-column>
                  <el-table-column prop="avgPoints" label="局均得分" width="90" sortable />
                  <el-table-column prop="avgKills" label="局均击杀" width="90" sortable />
                  <el-table-column prop="avgPlacement" label="平均名次" width="90" sortable />
                  <el-table-column prop="wins" label="胜场" width="70" sortable />
                  <el-table-column prop="picks" label="样本小局" width="86" sortable />
                  <el-table-column label="各赛区表现" min-width="200">
                    <template #default="{ row }">
                      <span class="poi-regions">
                        <template v-for="(v, region) in row.regions" :key="region">
                          <span class="poi-region-chip" :title="`${region}: 局均 ${v.avgPoints ?? '-'} 分 / ${v.picks} 小局`">
                            {{ region.slice(0, 5) }} {{ v.avgPoints ?? '-' }}
                          </span>
                        </template>
                      </span>
                    </template>
                  </el-table-column>
                </el-table>
              </section>
            </div>
          </template>
          <p v-else class="algs-empty">正在获取跳点数据…</p>
        </div>
      </el-tab-pane>

      <!-- 单局复盘 -->
      <el-tab-pane label="单局复盘" name="gamereview" lazy>
        <div class="gd-panel">
          <template v-if="gdMaintenance">
            <div class="algs-empty gd-maintenance-tip">
              🚧 单局复盘功能调试中，暂时不可用
              <small>数据与实现已完成，正在排查一个仅在打包版本下出现的渲染问题，恢复时间另行通知</small>
            </div>
          </template>
          <template v-else>
          <div class="algs-toolbar poi-toolbar">
            <div class="toolbar-field">
              <label>选择比赛</label>
              <el-select v-model="selectedGameKey" class="algs-select algs-select-wide" placeholder="先加载跳点数据后可选择" :disabled="!gameSelectorGroups.length">
                <el-option-group v-for="grp in gameSelectorGroups" :key="grp.label" :label="grp.label">
                  <el-option v-for="g in grp.games" :key="g.hash" :value="`${g.day}|${g.group}|${g.hash}`" :label="`第${g.gameNo ?? '?'}局 · ${mapCn(g.map)}`" />
                </el-option-group>
              </el-select>
            </div>
            <span v-if="gameDetail" class="algs-updated">
              {{ gameDetail.map ? mapCn(gameDetail.map) : '' }} · 记录 {{ fmtSec(gameDetail.survival?.timestamps?.slice(-1)[0] || 0) }}
            </span>
          </div>
          <div v-if="gdError" class="poi-error">{{ gdError }}</div>
          <div v-else-if="!gameSelectorGroups.length" class="algs-empty">正在获取比赛列表（首次约需 1-2 分钟）…</div>
          <div v-else class="gd-body">
            <section class="algs-panel">
              <header class="panel-head">
                <h3>本局战报（{{ gameDetail ? mapCn(gameDetail.map) : '' }}）</h3>
              </header>
              <div class="gd-result-list">
                <div v-for="t in (gameDetail?.teamTimeline || [])" :key="t.team" class="gd-result-row">
                  <span class="rank-chip" :class="rankClass(t.placement)">{{ t.placement }}</span>
                  <b>{{ t.team }}</b>
                  <span>{{ t.kills }} 击杀</span>
                  <span>{{ t.wipeAt ? fmtSec(t.wipeAt) : '存活' }}</span>
                </div>
              </div>
            </section>
            <div class="gd-info-grid">
              <section class="algs-panel" v-if="(gameDetail?.teamfights || []).length">
                <header class="panel-head"><h3>团战时刻</h3><p>短时间内多人淘汰的冲突点</p></header>
                <span class="poi-regions">
                  <span v-for="(f, i) in gameDetail.teamfights" :key="i" class="poi-region-chip gd-fight-chip">
                    ⚔️ {{ fmtSec(f.start) }}-{{ fmtSec(f.end) }} · {{ f.kills }} 人淘汰
                  </span>
                </span>
              </section>
              <section class="algs-panel" v-if="gdPoiGroups.length">
                <header class="panel-head"><h3>落点分布</h3><p>同一跳点的队伍（对跳 = 热门落点）</p></header>
                <div class="gd-poi-groups">
                  <div v-for="g in gdPoiGroups" :key="g.poi" class="gd-poi-group">
                    <b>{{ poiCn(g.poi) }}</b>
                    <span class="poi-en">{{ g.teams.join('、') }}</span>
                  </div>
                </div>
              </section>
              <section class="algs-panel" v-if="ringCloseTimes.length">
                <header class="panel-head"><h3>圈节奏</h3><p>每圈缩圈时间</p></header>
                <span class="poi-regions">
                  <span v-for="r in ringCloseTimes" :key="r.no" class="poi-region-chip">圈{{ r.no }} {{ fmtSec(r.t) }}</span>
                </span>
              </section>
            </div>
          </div>

          </template>
        </div>
      </el-tab-pane>

      <!-- 选手与生态 -->
      <el-tab-pane label="选手与生态" name="players" lazy>
        <div v-if="data" class="charts-stack">
          <section class="algs-panel">
            <header class="panel-head">
              <h3>选手数据榜</h3>
              <p>该赛区全部选手的个人数据合计（来源数据站 Players Statistics）· 点击表头排序</p>
            </header>
            <div class="algs-toolbar poi-toolbar">
              <span class="algs-updated">榜首维度：</span>
              <el-radio-group v-model="playerRankKey" size="small">
                <el-radio-button v-for="o in playerRankOptions" :key="o.key" :value="o.key">{{ o.label }}</el-radio-button>
              </el-radio-group>
            </div>
            <div ref="playersBarRef" class="chart-box chart-players"></div>
            <el-table :data="playersStats" size="small" stripe height="460" empty-text="暂无数据">
              <el-table-column label="选手" min-width="130">
                <template #default="{ row }"><b class="poi-name">{{ row.player }}</b></template>
              </el-table-column>
              <el-table-column label="战队" min-width="130">
                <template #default="{ row }">
                  <span class="team-cell">
                    <img v-if="teamLogo(row.teamSlug || slugMap[row.team])" :src="teamLogo(row.teamSlug || slugMap[row.team])" class="team-logo" alt="" @error="(e) => (e.target.style.display = 'none')" />
                    {{ row.team }}
                  </span>
                </template>
              </el-table-column>
              <el-table-column prop="games" label="场次" width="64" sortable />
              <el-table-column prop="kills" label="击杀" width="70" sortable />
              <el-table-column prop="assists" label="助攻" width="70" sortable />
              <el-table-column prop="knocks" label="击倒" width="70" sortable />
              <el-table-column prop="damage" label="伤害" width="86" sortable />
              <el-table-column prop="kd" label="K/D" width="70" sortable />
              <el-table-column prop="kad" label="KA/D" width="76" sortable />
              <el-table-column prop="bestPlacement" label="最佳名次" width="84" />
              <el-table-column prop="surviveTime" label="存活时间" width="110" />
            </el-table>
          </section>
          <section class="algs-panel">
            <header class="panel-head">
              <h3>版本生态</h3>
              <p>职业赛场的英雄组合与进化强化选择（来源数据站组合/升级统计）</p>
            </header>
            <div ref="compBarRef" class="chart-box chart-players"></div>
            <div class="algs-toolbar poi-toolbar">
              <span class="algs-updated">进化强化：</span>
              <el-radio-group v-model="evoLevel" size="small">
                <el-radio-button :value="2">蓝色（Level 2）</el-radio-button>
                <el-radio-button :value="3">紫色（Level 3）</el-radio-button>
              </el-radio-group>
            </div>
            <el-table :data="evoRows" size="small" stripe height="380" empty-text="暂无数据">
              <el-table-column prop="legend" label="英雄" width="130" />
              <el-table-column prop="perk" label="强化" min-width="180" />
              <el-table-column prop="pickRate" label="选用率" width="90" sortable>
                <template #default="{ row }">{{ row.pickRate != null ? row.pickRate + '%' : '-' }}</template>
              </el-table-column>
              <el-table-column prop="picks" label="次数" width="80" sortable />
            </el-table>
            <p v-if="!(data.weaponsStats || []).length" class="algs-empty" style="margin-top: 10px;">
              武器使用统计源站暂未提供该赛季数据，上线后自动补充。
            </p>
          </section>
        </div>
        <p v-else class="algs-empty">正在加载赛事数据…</p>
      </el-tab-pane>

      <!-- 队伍详情 -->
      <el-tab-pane label="队伍详情" name="team" lazy>
        <div v-if="data" class="team-detail">
          <div class="algs-toolbar">
            <div class="toolbar-field">
              <label>选择队伍</label>
              <el-select v-model="selectedTeam" class="algs-select algs-select-wide" filterable @change="renderMap">
                <el-option v-for="r in sortedMatrixRows" :key="r.team" :label="`${r.rank}. ${r.team}（${r.total}分）`" :value="r.team" />
              </el-select>
            </div>
          </div>
          <div v-if="selectedTeamInfo" class="charts-stack">
            <section class="algs-panel">
              <header class="panel-head">
                <h3>地图得分分布（{{ selectedTeam }}）</h3>
                <p>该队在各地图的局均得分</p>
              </header>
              <div ref="mapRef" class="chart-box"></div>
            </section>
            <section class="algs-panel">
              <header class="panel-head">
                <h3>战绩速览</h3>
              </header>
              <div class="stat-row">
                <div class="stat-card"><b>{{ selectedTeamInfo.standings?.score ?? '-' }}</b><span>总积分</span></div>
                <div class="stat-card"><b>{{ selectedTeamInfo.standings?.kills ?? '-' }}</b><span>总击杀</span></div>
                <div class="stat-card"><b>{{ selectedTeamInfo.matrix?.rank ?? '-' }}</b><span>排名</span></div>
                <div class="stat-card"><b>{{ selectedTeamInfo.matrix?.total ?? '-' }}</b><span>矩阵总分</span></div>
              </div>
            </section>
          </div>
          <section class="algs-panel">
            <header class="panel-head">
              <h3>选手英雄使用排行（全赛区）</h3>
              <p>统计各英雄被选用次数 Top 12</p>
            </header>
            <div ref="legendRef" class="chart-box"></div>
          </section>
        </div>
      </el-tab-pane>

    </el-tabs>
  </div>
</template>

<style scoped>
.algs-view {
  max-width: 1280px;
  margin: 0 auto;
  padding: 20px 16px 40px;
}

.page-title {
  margin: 0 0 6px;
  color: var(--text-primary);
  font-size: 1.5rem;
  font-weight: 600;
}

.page-desc {
  margin: 0 0 16px;
  color: var(--text-secondary);
  font-size: 0.9rem;
}

.algs-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.toolbar-field {
  display: flex;
  align-items: center;
  gap: 6px;
}

.toolbar-field > label {
  color: var(--text-secondary);
  font-size: 0.85rem;
  white-space: nowrap;
}

.algs-select {
  width: 150px;
}

.algs-select-wide {
  min-width: 260px;
}

.algs-updated {
  color: var(--text-muted);
  font-size: 0.82rem;
}

/* ===== 概览指标条 ===== */
/* grid 轨道必须用 minmax(0,1fr)：裸 1fr = minmax(auto,1fr)，内容最小宽度会把行撑出视口（手机横向溢出的根源） */
.kpi-row {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 14px;
}

.kpi-card {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 14px 16px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 14px;
}

.kpi-icon {
  flex-shrink: 0;
  width: 42px;
  height: 42px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
}

.kpi-icon.gold {
  background: color-mix(in srgb, var(--accent-gold) 16%, transparent);
  color: var(--accent-gold);
}

.kpi-icon.blue {
  background: color-mix(in srgb, var(--accent-blue) 16%, transparent);
  color: var(--accent-blue);
}

.kpi-icon.green {
  background: color-mix(in srgb, var(--accent-green) 16%, transparent);
  color: var(--accent-green);
}

.kpi-icon.purple {
  background: color-mix(in srgb, #9b6ef3 16%, transparent);
  color: #9b6ef3;
}

.kpi-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.kpi-label {
  color: var(--text-muted);
  font-size: 0.76rem;
}

.kpi-value {
  color: var(--text-primary);
  font-size: 1.15rem;
  font-weight: 700;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kpi-strong {
  color: var(--accent-gold);
}

.kpi-sub {
  color: var(--text-secondary);
  font-size: 0.76rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ===== 面板 ===== */
.algs-tabs {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 18px;
}

.algs-panel {
  min-width: 0;
  background: color-mix(in srgb, var(--bg-card) 96%, transparent);
  border: 1px solid var(--border-color);
  border-radius: 16px;
  padding: 16px;
}

.algs-panel h3 {
  margin: 0 0 4px;
  color: var(--text-primary);
  font-size: 1rem;
}

.panel-head {
  margin-bottom: 12px;
}

.panel-head p {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.78rem;
}

.standings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.charts-stack {
  display: grid;
  gap: 14px;
}

.chart-box {
  width: 100%;
  height: 380px;
}

/* 热力图限宽居中，避免少数列被拉伸成横条 */
.chart-heat {
  max-width: 840px;
  margin: 0 auto;
}

.chart-bump {
  height: 480px;
}

.chart-maps {
  max-width: 640px;
  margin: 0 auto;
}

.chart-poi {
  max-width: 640px;
}

/* ===== 积分榜表格 ===== */
.rank-chip {
  display: inline-flex;
  width: 24px;
  height: 24px;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  font-weight: 700;
  font-size: 0.78rem;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--bg-input) 88%, transparent);
}

.rank-chip.r1 {
  background: color-mix(in srgb, var(--accent-gold) 20%, transparent);
  color: var(--accent-gold);
}

.rank-chip.r2 {
  background: color-mix(in srgb, #aeb6c8 22%, transparent);
  color: var(--text-secondary);
}

.rank-chip.r3 {
  background: color-mix(in srgb, #c98a4b 22%, transparent);
  color: #c98a4b;
}

.team-cell {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.team-logo {
  width: 22px;
  height: 22px;
  border-radius: 4px;
  object-fit: contain;
}

.score-num {
  color: var(--text-primary);
  font-size: 0.92rem;
}

/* ===== 统计卡片 ===== */
.stat-row {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.stat-card {
  min-width: 0;
  padding: 14px;
  border-radius: 12px;
  border: 1px solid var(--border-color);
  background: color-mix(in srgb, var(--bg-input) 86%, transparent);
  text-align: center;
}

.stat-card b {
  display: block;
  color: var(--text-primary);
  font-size: 1.4rem;
}

.stat-card span {
  color: var(--text-secondary);
  font-size: 0.8rem;
}

.algs-empty {
  color: var(--text-muted);
  font-size: 0.9rem;
}

/* ===== 跳点分析 ===== */
.poi-panel {
  min-height: 300px;
}

.poi-error {
  color: #ff8f8f;
  padding: 20px;
}

.poi-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.6fr);
  gap: 14px;
}

.poi-toolbar {
  margin-bottom: 10px;
}

.drops-panel {
  margin-bottom: 14px;
  min-width: 0;
}

.poi-panel-gap {
  margin-top: 2px;
}

.drops-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}

.drops-sub {
  margin: 0 0 10px;
  color: var(--text-primary);
  font-size: 0.95rem;
}

.schedule-list {
  display: grid;
  gap: 8px;
  max-height: 420px;
  overflow-y: auto;
  padding-right: 4px;
}

.schedule-item {
  display: grid;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: color-mix(in srgb, var(--bg-input) 70%, transparent);
}

.schedule-label {
  color: var(--text-primary);
  font-size: 0.85rem;
  font-weight: 600;
}

.chart-players {
  height: 340px;
  max-width: 760px;
  margin: 0 auto 14px;
}

.gd-panel {
  min-width: 0;
}

.gd-maintenance-tip {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 60px 20px;
  font-size: 1.05rem;
  color: var(--text-secondary);
}

.gd-maintenance-tip small {
  font-size: 0.8rem;
  color: var(--text-muted);
}

.gd-result-list {
  display: grid;
  gap: 8px;
}

.gd-result-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: color-mix(in srgb, var(--bg-input) 70%, transparent);
  min-width: 0;
}

.gd-result-row.gd-winner {
  border-color: color-mix(in srgb, var(--accent-gold) 55%, transparent);
  background: color-mix(in srgb, var(--accent-gold) 8%, transparent);
}

.gd-team {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gd-team b {
  color: var(--text-primary);
}

.gd-kills {
  flex-shrink: 0;
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.gd-status {
  flex-shrink: 0;
  width: 108px;
  text-align: right;
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.gd-status.gd-alive {
  color: var(--accent-gold);
  font-weight: 600;
}

.gd-info-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 14px;
  margin-top: 14px;
}

.gd-info-grid .algs-panel {
  min-width: 0;
}

.gd-poi-groups {
  display: grid;
  gap: 6px;
}

.gd-poi-group {
  padding: 6px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg-input) 70%, transparent);
  font-size: 0.88rem;
  min-width: 0;
}

.gd-poi-group b {
  color: var(--text-primary);
}

.gd-fight-chip {
  color: var(--text-primary);
}

.poi-name {
  color: var(--text-primary);
  font-weight: 600;
}

.poi-en {
  margin-left: 5px;
  color: var(--text-muted);
  font-size: 0.72rem;
}

.poi-regions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.poi-region-chip {
  display: inline-block;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 0.72rem;
  color: var(--text-primary);
  background: color-mix(in srgb, var(--bg-input) 88%, transparent);
  border: 1px solid var(--border-color);
  cursor: default;
}

@media (max-width: 900px) {
  .standings-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .poi-grid,
  .drops-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .kpi-row,
  .stat-row {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 480px) {
  .kpi-row {
    grid-template-columns: minmax(0, 1fr);
  }
  .stat-row {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>

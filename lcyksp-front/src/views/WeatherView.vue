<script setup>
import { ref, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  Search,
  Loading,
  Location,
  Sunny,
  Cloudy
} from '@element-plus/icons-vue'

// State
const searchMode = ref('city') // 'city' or 'coord'
const cityQuery = ref('')
const cityOptions = ref([])
const selectedCity = ref(null)
const weatherData = ref(null)
const loading = ref(false)
const searchLoading = ref(false)

// Coordinate input state
const coordFormat = ref('decimal') // 'decimal' or 'dms'
const latValue = ref('')
const latDir = ref('N')
const lonValue = ref('')
const lonDir = ref('E')

// DMS (Degrees, Minutes, Seconds) states
const latDeg = ref('')
const latMin = ref('')
const latSec = ref('')
const lonDeg = ref('')
const lonMin = ref('')
const lonSec = ref('')

// Watchers to synchronize and clean state
watch(searchMode, (newMode) => {
  selectedCity.value = null
  if (newMode === 'city') {
    latValue.value = ''
    lonValue.value = ''
    latDeg.value = ''
    latMin.value = ''
    latSec.value = ''
    lonDeg.value = ''
    lonMin.value = ''
    lonSec.value = ''
  } else {
    cityQuery.value = ''
  }
})

watch(cityQuery, (newVal) => {
  if (selectedCity.value && selectedCity.value.label !== newVal) {
    selectedCity.value = null
  }
})

let searchTimer = null

function scoreFeatureCode(r) {
  const code = r?.feature_code || ''
  if (code === 'PPLC') return 100
  if (code === 'PPLA') return 90
  if (code === 'PPLA2') return 80
  if (code === 'PPLA3') return 70
  if (code === 'PPLA4') return 60
  if (code.startsWith('PPL')) return 50
  return 10
}

function buildCityLabel(r) {
  const parts = []
  if (r.name) parts.push(r.name)
  if (r.admin2 && r.admin2 !== r.name) parts.push(r.admin2)
  if (r.admin1 && r.admin1 !== r.name) parts.push(r.admin1)
  if (r.country) parts.push(r.country)
  return parts.join(', ')
}

async function fetchGeocodingResults(rawQuery) {
  const trimmed = String(rawQuery || '').trim()
  if (!trimmed) return []

  const queries = [trimmed]
  if (/[\u4e00-\u9fa5]/.test(trimmed) && !/[市县区州省]$/.test(trimmed)) {
    queries.push(trimmed + '市')
    queries.push(trimmed + '县')
    queries.push(trimmed + '区')
  }

  const fetchPromises = queries.map(q =>
    fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&language=zh&count=15&format=json`)
      .then(res => res.json())
      .catch(() => ({ results: [] }))
  )

  const resultsList = await Promise.all(fetchPromises)
  const mergedMap = new Map()

  for (const res of resultsList) {
    if (res?.results && Array.isArray(res.results)) {
      for (const item of res.results) {
        const key = item.id || `${item.latitude},${item.longitude}`
        if (!mergedMap.has(key)) {
          mergedMap.set(key, item)
        }
      }
    }
  }

  const sortedList = Array.from(mergedMap.values()).sort((a, b) => scoreFeatureCode(b) - scoreFeatureCode(a))

  return sortedList.map(r => ({
    label: buildCityLabel(r),
    value: r,
    lat: r.latitude,
    lon: r.longitude
  }))
}

function querySearchAsync(query, cb) {
  const trimmed = String(query || '').trim()
  if (!trimmed) {
    cityOptions.value = []
    cb([])
    return
  }

  clearTimeout(searchTimer)
  searchTimer = setTimeout(async () => {
    searchLoading.value = true
    try {
      const options = await fetchGeocodingResults(trimmed)
      cityOptions.value = options
      cb(options)
    } catch (err) {
      console.error('Geocoding error:', err)
      cityOptions.value = []
      cb([])
    } finally {
      searchLoading.value = false
    }
  }, 300)
}

function handleCitySelect(item) {
  selectedCity.value = item
  fetchWeatherData(item.lat, item.lon)
}

async function handleCityQuerySubmit() {
  if (selectedCity.value) {
    fetchWeatherData(selectedCity.value.lat, selectedCity.value.lon)
    return
  }

  if (!cityQuery.value || cityQuery.value.trim().length === 0) {
    ElMessage.warning('请输入要查询的城市名称')
    return
  }

  loading.value = true
  try {
    const options = await fetchGeocodingResults(cityQuery.value.trim())

    if (options && options.length > 0) {
      const match = options[0]
      selectedCity.value = match
      fetchWeatherData(match.lat, match.lon)
    } else {
      ElMessage.error('未找到匹配的城市，请检查拼写')
    }
  } catch (err) {
    console.error('Submit query error:', err)
    ElMessage.error('查询城市失败，请稍后重试')
  } finally {
    loading.value = false
  }
}

// Coordinate query
function handleCoordQuery() {
  let lat = 0
  let lon = 0
  let label = ''

  if (coordFormat.value === 'decimal') {
    lat = parseFloat(latValue.value)
    lon = parseFloat(lonValue.value)

    if (isNaN(lat) || isNaN(lon)) {
      ElMessage.warning('请输入有效的经纬度数值')
      return
    }
    if (lat < 0 || lat > 90) {
      ElMessage.warning('纬度范围：0 ~ 90')
      return
    }
    if (lon < 0 || lon > 180) {
      ElMessage.warning('经度范围：0 ~ 180')
      return
    }
    label = `经纬度定位: ${lat}°${latDir.value}, ${lon}°${lonDir.value}`
  } else {
    // DMS Mode
    const lDeg = parseFloat(latDeg.value || 0)
    const lMin = parseFloat(latMin.value || 0)
    const lSec = parseFloat(latSec.value || 0)

    const rDeg = parseFloat(lonDeg.value || 0)
    const rMin = parseFloat(lonMin.value || 0)
    const rSec = parseFloat(lonSec.value || 0)

    if (isNaN(lDeg) || isNaN(lMin) || isNaN(lSec) || isNaN(rDeg) || isNaN(rMin) || isNaN(rSec)) {
      ElMessage.warning('请输入有效的度分秒数值')
      return
    }

    if (lDeg < 0 || lDeg > 90 || lMin < 0 || lMin >= 60 || lSec < 0 || lSec >= 60) {
      ElMessage.warning('纬度度分秒输入不合法（度: 0-90, 分: 0-59, 秒: 0-59）')
      return
    }

    if (rDeg < 0 || rDeg > 180 || rMin < 0 || rMin >= 60 || rSec < 0 || rSec >= 60) {
      ElMessage.warning('经度度分秒输入不合法（度: 0-180, 分: 0-59, 秒: 0-59）')
      return
    }

    lat = lDeg + lMin / 60 + lSec / 3600
    lon = rDeg + rMin / 60 + rSec / 3600

    if (lat > 90) {
      ElMessage.warning('纬度不能超过 90°')
      return
    }
    if (lon > 180) {
      ElMessage.warning('经度不能超过 180°')
      return
    }

    label = `经纬度定位: ${lDeg}°${lMin}′${lSec}″${latDir.value}, ${rDeg}°${rMin}′${rSec}″${lonDir.value}`
  }

  const finalLat = latDir.value === 'S' ? -lat : lat
  const finalLon = lonDir.value === 'W' ? -lon : lon

  selectedCity.value = {
    label: label,
    lat: finalLat,
    lon: finalLon
  }
  fetchWeatherData(finalLat, finalLon)
}

// Fetch 7-day historical weather
async function fetchWeatherData(lat, lon) {
  loading.value = true
  weatherData.value = null

  try {
    const today = new Date()
    // Use yesterday as end date to ensure data availability
    const endDate = new Date(today)
    endDate.setDate(endDate.getDate() - 1)
    const startDate = new Date(endDate)
    startDate.setDate(startDate.getDate() - 6)

    const fmt = d => d.toISOString().split('T')[0]

    const params = new URLSearchParams({
      latitude: lat,
      longitude: lon,
      start_date: fmt(startDate),
      end_date: fmt(endDate),
      daily: [
        'temperature_2m_max',
        'temperature_2m_min',
        'temperature_2m_mean',
        'precipitation_sum',
        'relative_humidity_2m_mean',
        'pressure_msl_mean',
        'wind_speed_10m_max',
        'wind_direction_10m_dominant'
      ].join(','),
      timezone: 'auto'
    })

    const url = `https://archive-api.open-meteo.com/v1/archive?${params.toString()}`
    const resp = await fetch(url)
    const data = await resp.json()

    if (data.daily) {
      weatherData.value = data
      ElMessage.success('气象数据获取成功！')
    } else {
      ElMessage.error('未能获取到气象数据，请稍后重试')
    }
  } catch (err) {
    console.error('Weather fetch error:', err)
    ElMessage.error('获取气象数据失败：' + err.message)
  } finally {
    loading.value = false
  }
}

// Computed: daily rows for table
const dailyRows = computed(() => {
  if (!weatherData.value || !weatherData.value.daily) return []
  const d = weatherData.value.daily
  return d.time.map((t, i) => ({
    date: t,
    weekday: getWeekday(t),
    tempMax: d.temperature_2m_max[i],
    tempMin: d.temperature_2m_min[i],
    tempMean: d.temperature_2m_mean[i],
    precipitation: d.precipitation_sum[i],
    humidity: d.relative_humidity_2m_mean[i],
    pressure: d.pressure_msl_mean[i],
    windSpeed: d.wind_speed_10m_max[i],
    windDir: d.wind_direction_10m_dominant?.[i]
  }))
})

// Computed: summary stats
const summary = computed(() => {
  if (dailyRows.value.length === 0) return null
  const rows = dailyRows.value
  const totalPrecip = rows.reduce((sum, r) => sum + (r.precipitation || 0), 0)
  const avgPrecip = totalPrecip / rows.length
  const avgTemp = rows.reduce((s, r) => s + (r.tempMean || 0), 0) / rows.length
  const maxTemp = Math.max(...rows.map(r => r.tempMax))
  const minTemp = Math.min(...rows.map(r => r.tempMin))
  const avgHumidity = rows.reduce((s, r) => s + (r.humidity || 0), 0) / rows.length
  const avgPressure = rows.reduce((s, r) => s + (r.pressure || 0), 0) / rows.length
  const maxWind = Math.max(...rows.map(r => r.windSpeed || 0))

  return {
    totalPrecip: totalPrecip.toFixed(1),
    avgPrecip: avgPrecip.toFixed(2),
    avgTemp: avgTemp.toFixed(1),
    maxTemp: maxTemp.toFixed(1),
    minTemp: minTemp.toFixed(1),
    avgHumidity: avgHumidity.toFixed(0),
    avgPressure: avgPressure.toFixed(1),
    maxWind: maxWind.toFixed(1),
    dateRange: `${rows[0].date} 至 ${rows[rows.length - 1].date}`
  }
})

function getWeekday(dateStr) {
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return days[new Date(dateStr).getDay()]
}

function windDirText(deg) {
  if (deg == null) return '-'
  const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北']
  const idx = Math.round(deg / 45) % 8
  return dirs[idx] + '风'
}

function precipLevel(mm) {
  if (mm === 0) return { text: '无降水', color: '#9ca3af' }
  if (mm < 1) return { text: '微量', color: '#60a5fa' }
  if (mm < 10) return { text: '小雨', color: '#38bdf8' }
  if (mm < 25) return { text: '中雨', color: '#818cf8' }
  if (mm < 50) return { text: '大雨', color: '#f59e0b' }
  return { text: '暴雨', color: '#ef4444' }
}
</script>

<template>
  <div class="weather-container">
    <div class="header-section">
      <h1 class="title">全球气象数据查询</h1>
      <p class="subtitle">输入全球任意城市名称或经纬度坐标，自动获取近 7 日的历史气象观测数据，包含降水、气温、湿度、气压、风力等指标</p>
    </div>

    <!-- Search Bar -->
    <div class="search-section">
      <el-card class="glass-card search-card">
        <!-- Mode Toggle -->
        <div class="mode-toggle-row">
          <el-radio-group v-model="searchMode" size="default">
            <el-radio-button value="city">
              <el-icon><Location /></el-icon>
              <span>城市名搜索</span>
            </el-radio-button>
            <el-radio-button value="coord">
              <span>🌐 经纬度输入</span>
            </el-radio-button>
          </el-radio-group>
        </div>

        <!-- City name search mode -->
        <div v-if="searchMode === 'city'" class="search-row">
          <el-icon class="search-prefix-icon" :size="20"><Location /></el-icon>
          <el-autocomplete
            v-model="cityQuery"
            :fetch-suggestions="querySearchAsync"
            placeholder="请输入城市名称，如：德州、深圳、Tokyo、New York…"
            :trigger-on-focus="false"
            :debounce="0"
            value-key="label"
            class="city-search-input"
            size="large"
            @select="handleCitySelect"
            @keyup.enter="handleCityQuerySubmit"
            :loading="searchLoading"
            clearable
          >
            <template #default="{ item }">
              <div class="suggestion-item">
                <el-icon :size="14"><Location /></el-icon>
                <span>{{ item.label }}</span>
              </div>
            </template>
          </el-autocomplete>
          <el-button
            type="primary"
            size="large"
            class="search-btn"
            :loading="loading"
            @click="handleCityQuerySubmit"
          >
            <el-icon><Search /></el-icon>
            查询
          </el-button>
        </div>

        <!-- Coordinate input mode -->
        <div v-else class="coord-input-section">
          <!-- Format Toggle -->
          <div class="format-toggle-row">
            <el-radio-group v-model="coordFormat" size="small">
              <el-radio-button value="decimal">十进制 (Decimal)</el-radio-button>
              <el-radio-button value="dms">度分秒 (DMS)</el-radio-button>
            </el-radio-group>
          </div>

          <div class="coord-row">
            <!-- Latitude Group -->
            <div class="coord-group">
              <span class="coord-label">纬度</span>
              
              <!-- Decimal Mode -->
              <div v-if="coordFormat === 'decimal'" class="coord-input-wrap">
                <el-input
                  v-model="latValue"
                  placeholder="如 39.9042"
                  size="large"
                  class="coord-input"
                  type="number"
                  step="0.0001"
                  min="0"
                  max="90"
                />
                <el-select v-model="latDir" size="large" class="coord-dir-select">
                  <el-option label="N（北纬）" value="N" />
                  <el-option label="S（南纬）" value="S" />
                </el-select>
              </div>

              <!-- DMS Mode -->
              <div v-else class="dms-input-wrap">
                <el-input v-model="latDeg" placeholder="度" size="large" class="dms-input" type="number" min="0" max="90" />
                <span class="dms-symbol">°</span>
                <el-input v-model="latMin" placeholder="分" size="large" class="dms-input" type="number" min="0" max="59" />
                <span class="dms-symbol">′</span>
                <el-input v-model="latSec" placeholder="秒" size="large" class="dms-input" type="number" min="0" max="59" step="0.1" />
                <span class="dms-symbol">″</span>
                <el-select v-model="latDir" size="large" class="coord-dir-select">
                  <el-option label="N（北纬）" value="N" />
                  <el-option label="S（南纬）" value="S" />
                </el-select>
              </div>
            </div>

            <!-- Longitude Group -->
            <div class="coord-group">
              <span class="coord-label">经度</span>
              
              <!-- Decimal Mode -->
              <div v-if="coordFormat === 'decimal'" class="coord-input-wrap">
                <el-input
                  v-model="lonValue"
                  placeholder="如 116.4074"
                  size="large"
                  class="coord-input"
                  type="number"
                  step="0.0001"
                  min="0"
                  max="180"
                />
                <el-select v-model="lonDir" size="large" class="coord-dir-select">
                  <el-option label="E（东经）" value="E" />
                  <el-option label="W（西经）" value="W" />
                </el-select>
              </div>

              <!-- DMS Mode -->
              <div v-else class="dms-input-wrap">
                <el-input v-model="lonDeg" placeholder="度" size="large" class="dms-input" type="number" min="0" max="180" />
                <span class="dms-symbol">°</span>
                <el-input v-model="lonMin" placeholder="分" size="large" class="dms-input" type="number" min="0" max="59" />
                <span class="dms-symbol">′</span>
                <el-input v-model="lonSec" placeholder="秒" size="large" class="dms-input" type="number" min="0" max="59" step="0.1" />
                <span class="dms-symbol">″</span>
                <el-select v-model="lonDir" size="large" class="coord-dir-select">
                  <el-option label="E（东经）" value="E" />
                  <el-option label="W（西经）" value="W" />
                </el-select>
              </div>
            </div>

            <el-button
              type="primary"
              size="large"
              class="search-btn coord-search-btn"
              :loading="loading"
              @click="handleCoordQuery"
            >
              <el-icon><Search /></el-icon>
              查询
            </el-button>
          </div>
        </div>

        <div v-if="selectedCity" class="selected-info">
          <el-tag type="info" effect="dark" round>
            📍 {{ selectedCity.label }} — 纬度 {{ selectedCity.lat.toFixed(4) }}°, 经度 {{ selectedCity.lon.toFixed(4) }}°
          </el-tag>
        </div>
      </el-card>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="loading-section">
      <el-icon class="is-loading" :size="40"><Loading /></el-icon>
      <span>正在从 Open-Meteo 获取气象数据…</span>
    </div>

    <!-- Results -->
    <div v-if="weatherData && summary && !loading" class="results-section">

      <!-- Summary Cards -->
      <div class="summary-header">
        <h2 class="section-title">📊 7 日气象统计概览</h2>
        <span class="date-range">{{ summary.dateRange }}</span>
      </div>

      <div class="summary-grid">
        <div class="stat-card precipitation-card">
          <div class="stat-icon">🌧️</div>
          <div class="stat-body">
            <div class="stat-value">{{ summary.totalPrecip }}<span class="stat-unit"> mm</span></div>
            <div class="stat-label">7 日降水总量</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">💧</div>
          <div class="stat-body">
            <div class="stat-value">{{ summary.avgPrecip }}<span class="stat-unit"> mm</span></div>
            <div class="stat-label">日均降水量</div>
          </div>
        </div>
        <div class="stat-card temp-card">
          <div class="stat-icon">🌡️</div>
          <div class="stat-body">
            <div class="stat-value">{{ summary.avgTemp }}<span class="stat-unit"> °C</span></div>
            <div class="stat-label">日均气温（{{ summary.minTemp }}~{{ summary.maxTemp }}°C）</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">💦</div>
          <div class="stat-body">
            <div class="stat-value">{{ summary.avgHumidity }}<span class="stat-unit"> %</span></div>
            <div class="stat-label">平均相对湿度</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">🔵</div>
          <div class="stat-body">
            <div class="stat-value">{{ summary.avgPressure }}<span class="stat-unit"> hPa</span></div>
            <div class="stat-label">平均海平面气压</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">🌬️</div>
          <div class="stat-body">
            <div class="stat-value">{{ summary.maxWind }}<span class="stat-unit"> km/h</span></div>
            <div class="stat-label">最大风速</div>
          </div>
        </div>
      </div>

      <!-- Daily Detail Table -->
      <h2 class="section-title table-title">📅 逐日气象明细</h2>
      <el-card class="glass-card table-card">
        <div class="table-wrapper">
          <table class="weather-table">
            <thead>
              <tr>
                <th>日期</th>
                <th>星期</th>
                <th>最高气温</th>
                <th>最低气温</th>
                <th>日均气温</th>
                <th>降水量</th>
                <th>降水等级</th>
                <th>湿度</th>
                <th>气压</th>
                <th>最大风速</th>
                <th>主导风向</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in dailyRows" :key="row.date">
                <td class="date-cell">{{ row.date }}</td>
                <td>{{ row.weekday }}</td>
                <td class="temp-high">{{ row.tempMax?.toFixed(1) }}°C</td>
                <td class="temp-low">{{ row.tempMin?.toFixed(1) }}°C</td>
                <td>{{ row.tempMean?.toFixed(1) }}°C</td>
                <td>{{ row.precipitation?.toFixed(1) }} mm</td>
                <td>
                  <span class="precip-badge" :style="{ background: precipLevel(row.precipitation).color }">
                    {{ precipLevel(row.precipitation).text }}
                  </span>
                </td>
                <td>{{ row.humidity }}%</td>
                <td>{{ row.pressure?.toFixed(1) }} hPa</td>
                <td>{{ row.windSpeed?.toFixed(1) }} km/h</td>
                <td>{{ windDirText(row.windDir) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </el-card>

      <!-- Precipitation Bar Chart (CSS only) -->
      <h2 class="section-title chart-title">📈 7 日降水量分布</h2>
      <el-card class="glass-card chart-card">
        <div class="bar-chart">
          <div
            v-for="row in dailyRows"
            :key="'bar-' + row.date"
            class="bar-column"
          >
            <div class="bar-value">{{ row.precipitation?.toFixed(1) }}</div>
            <div class="bar-track">
              <div
                class="bar-fill"
                :style="{
                  height: (row.precipitation > 0
                    ? Math.max(8, (row.precipitation / Math.max(...dailyRows.map(r => r.precipitation || 1))) * 100)
                    : 0) + '%',
                  background: precipLevel(row.precipitation).color
                }"
              ></div>
            </div>
            <div class="bar-label">{{ row.date.slice(5) }}</div>
            <div class="bar-weekday">{{ row.weekday }}</div>
          </div>
        </div>
      </el-card>

      <!-- Data source -->
      <div class="data-source">
        数据来源：<a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a>（ECMWF ERA5 再分析数据）· 纯前端获取，不经过服务器
      </div>
    </div>
  </div>
</template>

<style scoped>
.weather-container {
  padding: 24px;
  min-height: calc(100vh - 120px);
  color: var(--text-primary);
}

.header-section {
  margin-bottom: 24px;
}

.title {
  font-size: 28px;
  font-weight: 700;
  margin: 0 0 8px 0;
  background: linear-gradient(135deg, #38bdf8 0%, #818cf8 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.subtitle {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

.glass-card {
  background: var(--bg-card) !important;
  backdrop-filter: blur(12px);
  border: 1px solid var(--border-color) !important;
  border-radius: 16px !important;
}

.glass-card :deep(.el-card__body) {
  padding: 20px;
  background: transparent !important;
}

/* Search Section */
.search-section {
  margin-bottom: 28px;
}

.search-card :deep(.el-card__body) {
  padding: 16px 20px;
}

.search-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.search-prefix-icon {
  color: var(--accent-blue);
  flex-shrink: 0;
}

.city-search-input {
  flex: 1;
}

.city-search-input :deep(.el-input__wrapper) {
  background: var(--bg-input) !important;
  box-shadow: 0 0 0 1px var(--border-color) inset !important;
  border-radius: 10px;
}

.city-search-input :deep(.el-input__inner) {
  color: var(--text-primary) !important;
}

.city-search-input :deep(.el-input__inner::placeholder) {
  color: var(--text-placeholder) !important;
}

.search-btn {
  border-radius: 10px;
  height: 40px;
  padding: 0 20px;
  font-weight: 600;
  background: linear-gradient(135deg, #38bdf8 0%, #818cf8 100%) !important;
  border: none !important;
}

.suggestion-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
  color: var(--text-primary);
}

.selected-info {
  margin-top: 12px;
}

.selected-info :deep(.el-tag) {
  font-size: 12px;
}

/* Mode Toggle Row */
.mode-toggle-row {
  margin-bottom: 20px;
  display: flex;
  justify-content: flex-start;
}

.mode-toggle-row :deep(.el-radio-button__inner) {
  background: var(--bg-ctrl) !important;
  color: var(--text-secondary) !important;
  border: 1px solid var(--border-color) !important;
  border-radius: 8px !important;
  margin-right: 8px;
  padding: 8px 16px;
  transition: all 0.3s ease;
  font-weight: 500;
}

.mode-toggle-row :deep(.el-radio-button:first-child .el-radio-button__inner) {
  border-radius: 8px !important;
}

.mode-toggle-row :deep(.el-radio-button:last-child .el-radio-button__inner) {
  border-radius: 8px !important;
}

.mode-toggle-row :deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) {
  background: linear-gradient(135deg, #38bdf8 0%, #818cf8 100%) !important;
  color: #ffffff !important;
  border-color: transparent !important;
  box-shadow: 0 0 12px rgba(56, 189, 248, 0.35) !important;
}

/* Coordinate Input Mode */
.coord-input-section {
  padding: 4px 0;
}

.coord-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
}

.coord-group {
  display: flex;
  align-items: center;
  gap: 10px;
}

.coord-label {
  font-size: 14px;
  color: var(--text-primary);
  font-weight: 600;
  white-space: nowrap;
}

.coord-input-wrap {
  display: flex;
  align-items: center;
  background: var(--bg-input) !important;
  border: 1px solid var(--border-color) !important;
  border-radius: 10px;
  height: 42px;
  padding-left: 8px;
  transition: border-color 0.3s, box-shadow 0.3s;
}

.coord-input-wrap:focus-within {
  border-color: var(--accent-blue) !important;
  box-shadow: 0 0 8px rgba(56, 189, 248, 0.25);
}

.coord-input {
  width: 120px;
}

.coord-input :deep(.el-input__wrapper) {
  background: transparent !important;
  box-shadow: none !important;
  padding: 0 !important;
}

.coord-input :deep(.el-input__inner) {
  color: var(--text-primary) !important;
  font-size: 14px;
  border: none !important;
}

.coord-input :deep(.el-input__inner::placeholder) {
  color: var(--text-placeholder) !important;
}

/* Hide input number spinners */
.coord-input :deep(input::-webkit-outer-spin-button),
.coord-input :deep(input::-webkit-inner-spin-button) {
  -webkit-appearance: none;
  margin: 0;
}
.coord-input :deep(input[type="number"]) {
  -moz-appearance: textfield;
}

.coord-dir-select {
  width: 110px;
}

.coord-dir-select :deep(.el-select__wrapper) {
  background: transparent !important;
  box-shadow: none !important;
  border-left: 1px solid var(--border-color) !important;
  border-radius: 0 10px 10px 0 !important;
  color: var(--text-primary) !important;
  height: 42px;
}

.coord-dir-select :deep(.el-select__placeholder) {
  color: var(--text-primary) !important;
}

.coord-dir-select :deep(.el-select__caret) {
  color: var(--text-secondary) !important;
}

.coord-search-btn {
  height: 42px;
}

/* Format Toggle Row */
.format-toggle-row {
  margin-bottom: 14px;
}

.format-toggle-row :deep(.el-radio-button__inner) {
  background: var(--bg-ctrl) !important;
  color: var(--text-muted) !important;
  border: 1px solid var(--border-subtle) !important;
  border-radius: 6px !important;
  margin-right: 6px;
  padding: 6px 12px;
  font-size: 12px;
}

.format-toggle-row :deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) {
  background: var(--bg-hover) !important;
  color: var(--text-primary) !important;
  border-color: var(--border-color) !important;
  box-shadow: none !important;
}

/* DMS Inputs */
.dms-input-wrap {
  display: flex;
  align-items: center;
  background: var(--bg-input) !important;
  border: 1px solid var(--border-color) !important;
  border-radius: 10px;
  height: 42px;
  padding-left: 6px;
  transition: border-color 0.3s, box-shadow 0.3s;
}

.dms-input-wrap:focus-within {
  border-color: var(--accent-blue) !important;
  box-shadow: 0 0 8px rgba(56, 189, 248, 0.25);
}

.dms-input {
  width: 52px;
}

.dms-input :deep(.el-input__wrapper) {
  background: transparent !important;
  box-shadow: none !important;
  padding: 0 !important;
}

.dms-input :deep(.el-input__inner) {
  color: var(--text-primary) !important;
  text-align: center;
  font-size: 14px;
  border: none !important;
  padding: 0 !important;
}

.dms-input :deep(.el-input__inner::placeholder) {
  color: var(--text-placeholder) !important;
}

/* Hide input number spinners */
.dms-input :deep(input::-webkit-outer-spin-button),
.dms-input :deep(input::-webkit-inner-spin-button) {
  -webkit-appearance: none;
  margin: 0;
}
.dms-input :deep(input[type="number"]) {
  -moz-appearance: textfield;
}

.dms-symbol {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0 2px;
  user-select: none;
}

/* Loading */
.loading-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 60px 0;
  color: var(--text-muted);
  font-size: 14px;
}

/* Summary */
.summary-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 16px;
  flex-wrap: wrap;
  gap: 8px;
}

.section-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-heading);
  margin: 0;
}

.date-range {
  font-size: 13px;
  color: var(--text-muted);
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
  margin-bottom: 32px;
}

@media (max-width: 900px) {
  .summary-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 560px) {
  .summary-grid {
    grid-template-columns: 1fr;
  }
}

.stat-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 14px;
  padding: 18px;
  display: flex;
  align-items: center;
  gap: 14px;
  transition: border-color 0.25s, transform 0.2s;
}

.stat-card:hover {
  border-color: var(--accent-blue);
  transform: translateY(-2px);
}

.stat-icon {
  font-size: 28px;
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-ctrl);
  border-radius: 12px;
}

.stat-body {
  flex: 1;
  min-width: 0;
}

.stat-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--text-heading);
  line-height: 1.2;
}

.stat-unit {
  font-size: 13px;
  font-weight: 400;
  color: var(--text-muted);
}

.stat-label {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 4px;
}

/* Table */
.table-title {
  margin-bottom: 14px;
}

.table-card {
  margin-bottom: 32px;
}

.table-wrapper {
  overflow-x: auto;
}

.weather-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  white-space: nowrap;
}

.weather-table th {
  text-align: left;
  padding: 10px 12px;
  font-weight: 600;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-ctrl);
}

.weather-table td {
  padding: 10px 12px;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-subtle);
}

.weather-table tr:hover td {
  background: var(--bg-hover);
}

.date-cell {
  font-weight: 500;
  color: #a5b4fc;
}

.temp-high {
  color: #f59e0b;
}

.temp-low {
  color: #38bdf8;
}

.precip-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 500;
  color: #ffffff;
}

/* Bar Chart */
.chart-title {
  margin-bottom: 14px;
}

.chart-card {
  margin-bottom: 24px;
}

.bar-chart {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  height: 220px;
  padding: 16px 8px 0 8px;
}

.bar-column {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
}

.bar-value {
  font-size: 11px;
  color: var(--text-secondary);
  margin-bottom: 6px;
  font-weight: 500;
}

.bar-track {
  flex: 1;
  width: 100%;
  max-width: 48px;
  display: flex;
  align-items: flex-end;
  border-radius: 6px 6px 0 0;
  overflow: hidden;
  background: var(--bg-ctrl);
}

.bar-fill {
  width: 100%;
  border-radius: 6px 6px 0 0;
  transition: height 0.6s ease-out;
  min-height: 0;
}

.bar-label {
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 8px;
}

.bar-weekday {
  font-size: 10px;
  color: var(--text-muted);
  margin-top: 2px;
}

/* Data source */
.data-source {
  text-align: center;
  font-size: 11px;
  color: var(--text-muted);
  padding: 12px 0 4px 0;
}

.data-source a {
  color: #818cf8;
  text-decoration: none;
}

.data-source a:hover {
  text-decoration: underline;
}
</style>

<script setup>
import { ref, onMounted } from 'vue'
import axios from 'axios'
import { ElMessage } from 'element-plus'
import { Search, Refresh, Location, Monitor, InfoFilled, Cpu } from '@element-plus/icons-vue'

const ipInput = ref('')
const loading = ref(false)
const ipInfo = ref(null)
const userAgentInfo = ref({
  ua: '',
  browser: '',
  os: '',
  screen: ''
})

onMounted(() => {
  // Parse User Agent
  const ua = navigator.userAgent
  userAgentInfo.value.ua = ua
  userAgentInfo.value.screen = `${window.screen.width} x ${window.screen.height}`
  userAgentInfo.value.browser = getBrowserName(ua)
  userAgentInfo.value.os = getOSName(ua)

  // Fetch client IP on load
  fetchIpInfo('')
})

function getBrowserName(ua) {
  if (ua.includes('Firefox')) return 'Mozilla Firefox'
  if (ua.includes('SamsungBrowser')) return 'Samsung Internet'
  if (ua.includes('Opera') || ua.includes('OPR')) return 'Opera'
  if (ua.includes('Trident')) return 'Internet Explorer'
  if (ua.includes('Edge') || ua.includes('Edg')) return 'Microsoft Edge'
  if (ua.includes('Chrome')) return 'Google Chrome'
  if (ua.includes('Safari')) return 'Apple Safari'
  return '未知浏览器'
}

function getOSName(ua) {
  if (ua.includes('Windows')) return 'Windows'
  if (ua.includes('Android')) return 'Android'
  if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS'
  if (ua.includes('Macintosh')) return 'macOS'
  if (ua.includes('Linux')) return 'Linux'
  return '未知操作系统'
}

async function fetchIpInfo(queryIp = '') {
  loading.value = true
  try {
    const url = queryIp 
      ? `/api/ip-lookup?ip=${queryIp.trim()}`
      : '/api/ip-lookup'
    
    const res = await axios.get(url)
    if (res.data) {
      ipInfo.value = res.data
      if (!queryIp) {
        // Set the input field to the user's actual IP
        ipInput.value = res.data.ipAddress || res.data.ip_address || ''
      }
    }
  } catch (err) {
    console.error(err)
    ElMessage.error('获取 IP 归属地失败，请稍后重试！')
  } finally {
    loading.value = false
  }
}

function handleSearch() {
  if (!ipInput.value.trim()) {
    ElMessage.warning('请输入要查询的 IP 地址')
    return
  }
  // Simple check for valid IP structure (IPv4 or IPv6)
  const ipPattern = /^([0-9a-fA-F:.]{7,45})$/
  if (!ipPattern.test(ipInput.value.trim())) {
    ElMessage.error('请输入格式正确的 IPv4 或 IPv6 地址')
    return
  }
  fetchIpInfo(ipInput.value)
}

function resetToLocal() {
  ipInput.value = ''
  fetchIpInfo('')
}

const mapUrl = (lat, lon) => {
  return `https://www.openstreetmap.org/#map=12/${lat}/${lon}`
}

function getFlagEmoji(countryCode) {
  if (!countryCode) return ''
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map(char => 127397 + char.charCodeAt(0))
  try {
    return String.fromCodePoint(...codePoints)
  } catch {
    return ''
  }
}
</script>

<template>
  <div class="ip-lookup-view">
    <div class="page-header">
      <h2 class="page-title"><span class="title-icon">🌐</span> IP 归属地查询</h2>
      <p class="page-desc">快速定位任何公网 IP 地址的物理位置、网络运营商、时区、经纬度及网络风控信息。</p>
    </div>

    <!-- 搜索栏 -->
    <div class="search-card theme-surface">
      <div class="input-wrapper">
        <el-input
          v-model="ipInput"
          placeholder="请输入 IPv4 或 IPv6 地址，例如：8.8.8.8"
          size="large"
          class="ip-input"
          clearable
          @keyup.enter="handleSearch"
        >
          <template #prefix>
            <el-icon><Location /></el-icon>
          </template>
        </el-input>
        <div class="btn-group">
          <el-button 
            type="primary" 
            :icon="Search" 
            size="large" 
            :loading="loading" 
            @click="handleSearch"
          >
            查询定位
          </el-button>
          <el-button 
            type="info" 
            :icon="Refresh" 
            size="large" 
            @click="resetToLocal"
          >
            本机 IP
          </el-button>
        </div>
      </div>
    </div>

    <el-row :gutter="20" class="layout-row" v-loading="loading">
      <!-- 结果卡片 -->
      <el-col :xs="24" :md="14">
        <div class="col-wrap">
          <div class="result-card theme-surface">
            <h3 class="section-title">定位分析结果</h3>
            
            <div v-if="ipInfo" class="info-grid">
              <div class="info-item">
                <span class="info-label">IP 地址</span>
                <span class="info-value highlight-value">{{ ipInfo.ipAddress || ipInfo.ip_address }}</span>
              </div>
              <div class="info-item">
                <span class="info-label">IP 类型</span>
                <span class="info-value">IPv{{ ipInfo.ipVersion || ipInfo.ip_version }}</span>
              </div>
              <div class="info-item">
                <span class="info-label">国家/地区</span>
                <span class="info-value">
                  <span class="flag-icon" v-if="ipInfo.countryCode">
                    {{ getFlagEmoji(ipInfo.countryCode) }} 
                  </span>
                  {{ ipInfo.countryName || ipInfo.country || '-' }}
                </span>
              </div>
              <div class="info-item">
                <span class="info-label">省份/州</span>
                <span class="info-value">{{ ipInfo.regionName || ipInfo.region || '-' }}</span>
              </div>
              <div class="info-item">
                <span class="info-label">城市</span>
                <span class="info-value">{{ ipInfo.cityName || ipInfo.city || '-' }}</span>
              </div>
              <div class="info-item">
                <span class="info-label">邮政编码</span>
                <span class="info-value">{{ ipInfo.zipCode || ipInfo.postal_code || '-' }}</span>
              </div>
              <div class="info-item">
                <span class="info-label">ISP 运营商 / ASN 组织</span>
                <span class="info-value">{{ ipInfo.asnOrg || ipInfo.asn_org || '-' }} (ASN: {{ ipInfo.asn || '-' }})</span>
              </div>
              <div class="info-item">
                <span class="info-label">地理经纬度</span>
                <span class="info-value geo-link-wrapper">
                  <span>{{ ipInfo.latitude }}, {{ ipInfo.longitude }}</span>
                  <el-link 
                    v-if="ipInfo.latitude && ipInfo.longitude"
                    type="primary" 
                    :href="mapUrl(ipInfo.latitude, ipInfo.longitude)" 
                    target="_blank" 
                    :underline="false"
                    class="geo-link"
                  >
                    查看地图
                  </el-link>
                </span>
              </div>
              <div class="info-item">
                <span class="info-label">时区</span>
                <span class="info-value">{{ ipInfo.timezones?.[0] || ipInfo.timezones || '-' }}</span>
              </div>
              <div class="info-item">
                <span class="info-label">风控评级 (代理/VPN)</span>
                <span class="info-value">
                  <el-tag :type="ipInfo.isProxy || ipInfo.is_proxy ? 'danger' : 'success'">
                    {{ ipInfo.isProxy || ipInfo.is_proxy ? '高风险代理/VPN' : '住宅/普通专线' }}
                  </el-tag>
                </span>
              </div>
            </div>
            <div v-else class="empty-state">
              <el-icon :size="48"><InfoFilled /></el-icon>
              <p>暂无数据，请输入 IP 查询</p>
            </div>
          </div>
        </div>
      </el-col>

      <!-- 客户端 UA 卡片 -->
      <el-col :xs="24" :md="10">
        <div class="col-wrap">
          <div class="ua-card theme-surface">
            <h3 class="section-title">我的浏览器属性</h3>
            <div class="ua-content">
              <div class="ua-item">
                <el-icon><Monitor /></el-icon>
                <div class="ua-detail">
                  <span class="ua-label">操作系统</span>
                  <span class="ua-value">{{ userAgentInfo.os }}</span>
                </div>
              </div>

              <div class="ua-item">
                <el-icon><Cpu /></el-icon>
                <div class="ua-detail">
                  <span class="ua-label">内核/浏览器</span>
                  <span class="ua-value">{{ userAgentInfo.browser }}</span>
                </div>
              </div>

              <div class="ua-item">
                <el-icon><Location /></el-icon>
                <div class="ua-detail">
                  <span class="ua-label">屏幕分辨率</span>
                  <span class="ua-value">{{ userAgentInfo.screen }}</span>
                </div>
              </div>

              <div class="ua-item raw-ua-item">
                <span class="ua-label">完整 User Agent</span>
                <div class="ua-raw-box">{{ userAgentInfo.ua }}</div>
              </div>
            </div>
          </div>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.ip-lookup-view {
  max-width: 1200px;
  margin: 0 auto;
  padding: 20px 16px 40px;
}

.page-header {
  margin-bottom: 20px;
}

.page-title {
  margin: 0 0 4px;
  color: var(--text-heading);
  font-size: 1.4rem;
  font-weight: 500;
  letter-spacing: 0.5px;
}

.title-icon {
  margin-right: 8px;
}

.page-desc {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.85rem;
  line-height: 1.5;
}

.search-card {
  border: 1px solid var(--border-color);
  border-radius: 16px;
  padding: 24px;
  margin-bottom: 20px;
}

.input-wrapper {
  display: flex;
  gap: 16px;
  align-items: center;
  flex-wrap: wrap;
}

.ip-input {
  flex: 1;
  min-width: 280px;
}

.btn-group {
  display: flex;
  gap: 10px;
}

.btn-group :deep(.el-button) {
  margin-left: 0 !important;
}

.layout-row {
  margin-bottom: 20px;
}

.col-wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.result-card,
.ua-card {
  border: 1px solid var(--border-color);
  border-radius: 16px;
  padding: 24px;
  min-height: 380px;
}

.section-title {
  margin: 0 0 20px;
  font-size: 1.1rem;
  font-weight: 500;
  color: var(--text-heading);
  border-left: 4px solid var(--accent-blue);
  padding-left: 10px;
  line-height: 1.2;
}

.info-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 14px;
}

@media (min-width: 576px) {
  .info-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  
  .info-item:nth-child(7),
  .info-item:nth-child(8) {
    grid-column: span 2;
  }
}

.info-item {
  display: flex;
  flex-direction: column;
  background: var(--bg-ctrl);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 12px 16px;
}

.info-label {
  font-size: 0.75rem;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.info-value {
  font-size: 0.95rem;
  font-weight: 500;
  color: var(--text-primary);
}

.highlight-value {
  color: var(--accent-blue);
  font-weight: 600;
  font-size: 1.05rem;
}

.geo-link-wrapper {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.geo-link {
  font-size: 0.8rem;
}

.flag-icon {
  margin-right: 4px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 260px;
  color: var(--text-muted);
}

.empty-state p {
  margin-top: 10px;
  font-size: 0.9rem;
}

/* UA 卡片 */
.ua-content {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.ua-item {
  display: flex;
  align-items: center;
  gap: 16px;
  background: var(--bg-ctrl);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 16px;
}

.ua-item .el-icon {
  font-size: 1.8rem;
  color: var(--accent-blue);
}

.ua-detail {
  display: flex;
  flex-direction: column;
}

.ua-raw-box {
  background: var(--bg-deep);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 12px;
  font-size: 0.78rem;
  font-family: 'Courier New', Courier, monospace;
  word-break: break-all;
  color: var(--text-secondary);
  margin-top: 6px;
  line-height: 1.4;
}

.raw-ua-item {
  flex-direction: column;
  align-items: stretch;
  background: var(--bg-ctrl);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 16px;
}

@media (max-width: 768px) {
  .ip-lookup-view {
    padding: 12px 10px 24px;
  }
  
  .search-card,
  .result-card,
  .ua-card {
    padding: 16px;
    min-height: auto;
  }
  
  .ua-item {
    padding: 12px;
    gap: 12px;
  }
  
  .raw-ua-item {
    padding: 12px;
  }
}

@media (max-width: 576px) {
  .input-wrapper {
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
  }
  
  .ip-input {
    width: 100%;
    min-width: 0;
  }
  
  .btn-group {
    width: 100%;
  }
  
  .btn-group .el-button {
    flex: 1;
  }
}
</style>

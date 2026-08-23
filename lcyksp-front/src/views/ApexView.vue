<script setup>
import { ref, onMounted } from 'vue'
import axios from 'axios'
import { ElMessage } from 'element-plus'
import { Search, User, Trophy, Calendar, InfoFilled, Histogram, Management, Monitor } from '@element-plus/icons-vue'

const platform = ref('origin')
const username = ref('')
const loading = ref(false)
const profileData = ref(null)
const sessionsData = ref(null)

// Platforms options
const platforms = [
  { value: 'origin', label: 'PC (EA/Steam)' },
  { value: 'psn', label: 'PlayStation' },
  { value: 'xbl', label: 'Xbox' }
]

// Load cached searches if any
const searchHistory = ref([])
onMounted(() => {
  const cached = localStorage.getItem('apex_search_history')
  if (cached) {
    try {
      searchHistory.value = JSON.parse(cached)
    } catch (e) {
      searchHistory.value = []
    }
  }
})

function saveToHistory(plat, name) {
  if (!name.trim()) return
  const item = { platform: plat, username: name.trim(), time: Date.now() }
  // Remove duplicate
  searchHistory.value = searchHistory.value.filter(
    h => !(h.platform === plat && h.username.toLowerCase() === name.trim().toLowerCase())
  )
  searchHistory.value.unshift(item)
  // Limit to 5
  if (searchHistory.value.length > 5) {
    searchHistory.value.pop()
  }
  localStorage.setItem('apex_search_history', JSON.stringify(searchHistory.value))
}

function selectHistory(item) {
  platform.value = item.platform
  username.value = item.username
  handleSearch()
}

function clearHistory() {
  searchHistory.value = []
  localStorage.removeItem('apex_search_history')
}

async function handleSearch() {
  if (!username.value.trim()) {
    ElMessage.warning('请输入玩家用户名')
    return
  }

  loading.value = true
  profileData.value = null
  sessionsData.value = null

  const targetUser = username.value.trim()
  const targetPlat = platform.value

  try {
    // 1. Fetch Profile
    const profileRes = await axios.get('/api/apex/profile', {
      params: { platform: targetPlat, username: targetUser }
    })
    
    if (profileRes.data) {
      profileData.value = profileRes.data
      saveToHistory(targetPlat, targetUser)
    }

    // 2. Fetch Sessions (history) - optional fail-safe
    try {
      const sessionsRes = await axios.get('/api/apex/sessions', {
        params: { platform: targetPlat, username: targetUser }
      })
      if (sessionsRes.data) {
        sessionsData.value = sessionsRes.data
      }
    } catch (sessionErr) {
      console.warn('Failed to load session history:', sessionErr.response?.data?.error || sessionErr.message)
    }

  } catch (err) {
    console.error(err)
    const errMsg = err.response?.data?.error || '查询失败，第三方 API 暂不可用，请稍后重试！'
    ElMessage.error(errMsg)
  } finally {
    loading.value = false
  }
}

// Helpers to format data from ALS
function formatTime(timestamp) {
  if (!timestamp) return ''
  // ALS timestamp might be in seconds
  const ms = timestamp * 1000 > 1000000000000 ? timestamp : timestamp * 1000
  const date = new Date(ms)
  return date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function getLegendList(data) {
  if (!data || !data.legends || !data.legends.all) return []
  return Object.entries(data.legends.all).map(([name, detail]) => {
    return {
      name,
      icon: detail.ImgAssets?.icon || 'https://trackercdn.com/cdn/apex.tracker.gg/legends/apex-default.png',
      stats: detail.data || []
    }
  }).filter(l => l.stats.length > 0)
}

function getAvatarUrl(avatar) {
  if (avatar && typeof avatar === 'string' && avatar.startsWith('http')) {
    return avatar
  }
  return 'https://trackercdn.com/cdn/apex.tracker.gg/avatars/apex-default.png'
}
</script>

<template>
  <div class="apex-tracker-view">
    <div class="page-header">
      <h2 class="page-title"><span class="title-icon">🎯</span> Apex Legends 战绩查询</h2>
      <p class="page-desc">输入 EA/Steam 用户名或主机 ID，查询玩家的段位、等级、历史比赛对局等详细数据。</p>
    </div>

    <!-- 搜索面板 -->
    <div class="search-card theme-surface">
      <div class="input-wrapper">
        <el-select v-model="platform" size="large" class="platform-select" placeholder="选择平台">
          <el-option
            v-for="plat in platforms"
            :key="plat.value"
            :label="plat.label"
            :value="plat.value"
          />
        </el-select>
        
        <el-input
          v-model="username"
          placeholder="请输入完整的游戏内用户名"
          size="large"
          class="username-input"
          clearable
          @keyup.enter="handleSearch"
        >
          <template #prefix>
            <el-icon><User /></el-icon>
          </template>
        </el-input>

        <el-button
          type="danger"
          :icon="Search"
          size="large"
          :loading="loading"
          class="search-btn"
          @click="handleSearch"
        >
          搜 索
        </el-button>
      </div>

      <!-- 历史记录 -->
      <div v-if="searchHistory.length > 0" class="history-list">
        <span class="history-label">历史查询：</span>
        <el-tag
          v-for="(hist, idx) in searchHistory"
          :key="idx"
          class="history-tag"
          closable
          type="info"
          @click="selectHistory(hist)"
          @close.stop="searchHistory.splice(idx, 1); localStorage.setItem('apex_search_history', JSON.stringify(searchHistory))"
        >
          {{ hist.platform === 'origin' ? 'PC' : hist.platform.toUpperCase() }}: {{ hist.username }}
        </el-tag>
        <el-button link type="danger" size="small" class="clear-history-btn" @click="clearHistory">清空</el-button>
      </div>
    </div>

    <!-- 加载状态 -->
    <div v-if="loading" class="loading-wrapper">
      <div class="apex-loader">
        <div class="apex-logo-shape"></div>
        <p>正在同步 Apex 战绩数据中...</p>
      </div>
    </div>

    <!-- 查询结果 -->
    <div v-else-if="profileData" class="results-container">
      
      <!-- 玩家名片 Card -->
      <div class="profile-header theme-surface">
        <div class="profile-avatar-wrapper">
          <img 
            :src="getAvatarUrl(profileData.global.avatar)" 
            class="profile-avatar"
            alt="avatar"
          />
        </div>
        <div class="profile-meta">
          <div class="platform-badge" :class="profileData.global.platform.toLowerCase()">
            {{ profileData.global.platform === 'PC' ? 'Origin / Steam' : profileData.global.platform }}
          </div>
          <h1 class="player-name">{{ profileData.global.name }}</h1>
          <div class="player-level">
            <span class="level-label">等级</span>
            <span class="level-val">
              {{ profileData.global.level }} 
              <span v-if="profileData.global.levelPrestige > 0" class="prestige-val">(转世 {{ profileData.global.levelPrestige }})</span>
            </span>
            <span v-if="profileData.realtime.isOnline" class="online-status online">在线</span>
            <span v-else class="online-status offline">离线</span>
          </div>
        </div>
        
        <!-- 段位展示 -->
        <div class="rank-card" v-if="profileData.global.rank">
          <div class="rank-icon-wrapper">
            <img 
              :src="profileData.global.rank.rankImg || 'https://api.mozambiquehe.re/assets/ranks/unranked.png'" 
              class="rank-icon"
              alt="Rank Icon"
            />
          </div>
          <div class="rank-info">
            <div class="rank-name">
              {{ profileData.global.rank.rankName }}
              <span v-if="profileData.global.rank.rankDiv > 0"> {{ profileData.global.rank.rankDiv }}</span>
            </div>
            <div class="rank-points">{{ profileData.global.rank.rankScore }} RP</div>
          </div>
        </div>
      </div>

      <div class="detail-layout">
        
        <!-- 左侧：基础汇总和传奇统计 -->
        <div class="left-col">
          <!-- 核心属性 -->
          <div class="stats-card theme-surface">
            <h3 class="card-title"><el-icon><Trophy /></el-icon> 当前英雄数据 (Current Banner)</h3>
            <div class="realtime-status-banner">
              当前使用传奇：<strong>{{ profileData.realtime.selectedLegend || '未知' }}</strong>
            </div>
            
            <div class="stats-grid">
              <!-- Render selected legend trackers -->
              <div 
                v-for="(tracker, idx) in (profileData.legends?.selected?.data || [])" 
                :key="idx"
                class="stat-box"
              >
                <span class="stat-label">{{ tracker.name }}</span>
                <span class="stat-val">{{ tracker.value }}</span>
              </div>
              <div v-if="!(profileData.legends?.selected?.data?.length)" class="no-data-text">
                当前传奇未装备任何追踪器，或数据尚未同步。
              </div>
            </div>
          </div>

          <!-- 常玩传奇列表 -->
          <div class="legends-card theme-surface">
            <h3 class="card-title"><el-icon><Management /></el-icon> 常用传奇汇总 (All Legend Stats)</h3>
            <div class="legends-list">
              <div 
                v-for="(legend, idx) in getLegendList(profileData)" 
                :key="idx"
                class="legend-item"
              >
                <img 
                  :src="legend.icon" 
                  class="legend-avatar"
                  alt="legend icon"
                />
                <div class="legend-info">
                  <div class="legend-name">{{ legend.name }}</div>
                  <div class="legend-stats">
                    <span 
                      v-for="(val, kIdx) in legend.stats" 
                      :key="kIdx"
                      class="legend-stat-pill"
                    >
                      {{ val.name }}: <strong>{{ val.value }}</strong>
                    </span>
                  </div>
                </div>
              </div>
              <div v-if="getLegendList(profileData).length === 0" class="no-data-text">
                没有检测到任何特定英雄的追踪器数据。
              </div>
            </div>
          </div>
        </div>

        <!-- 右侧：近期对局历史（会话） -->
        <div class="right-col">
          <div class="history-card theme-surface">
            <h3 class="card-title">
              <el-icon><Calendar /></el-icon> 近期对局历史 (Match History)
              <el-tooltip content="数据是由系统对玩家 Banner 进行轮询差值记录产生的，首次查询的用户可能没有历史数据。" placement="top">
                <el-icon class="title-help"><InfoFilled /></el-icon>
              </el-tooltip>
            </h3>

            <!-- 会话列表 -->
            <div v-if="sessionsData && Array.isArray(sessionsData) && sessionsData.length > 0" class="sessions-timeline">
              <div 
                v-for="(match, mIdx) in sessionsData" 
                :key="mIdx"
                class="match-history-row"
              >
                <div class="match-history-header">
                  <span class="match-time">{{ formatTime(match.timestamp) }}</span>
                  <span class="match-legend-badge">
                    使用: <strong>{{ match.legend || '未知' }}</strong>
                  </span>
                </div>

                <div class="match-history-stats">
                  <div v-if="match.kills !== undefined" class="history-stat-pill">
                    击杀: <strong :class="{ 'positive': match.kills > 0 }">+{{ match.kills }}</strong>
                  </div>
                  <div v-if="match.damage !== undefined" class="history-stat-pill">
                    伤害: <strong>+{{ match.damage }}</strong>
                  </div>
                  <div v-if="match.rankScore !== undefined" class="history-stat-pill">
                    排位分: 
                    <strong 
                      :class="{ 
                        'positive': match.rankScore > 0, 
                        'negative': match.rankScore < 0 
                      }"
                    >
                      {{ match.rankScore > 0 ? '+' : '' }}{{ match.rankScore }} RP
                    </strong>
                  </div>
                </div>
              </div>
            </div>
            
            <!-- 无历史数据 -->
            <div v-else class="empty-sessions">
              <el-icon class="empty-icon"><Histogram /></el-icon>
              <p>暂无近期对局历史</p>
              <span class="empty-subtext">该玩家可能是首次在本站的战绩系统中被检索。系统现已将该玩家加入追踪序列，请在游玩几局游戏后刷新本页查看。</span>
            </div>
          </div>
        </div>

      </div>
    </div>

    <!-- 初始引导状态 -->
    <div v-else class="initial-state">
      <div class="guide-box theme-surface">
        <h3>🔍 如何查询战绩？</h3>
        <ol>
          <li>在上方下拉菜单中，选择你游戏的平台（PC端 Steam/EA 选择 <strong>PC (EA/Steam)</strong>）。</li>
          <li>输入你在该平台的游戏内**用户名**（Origin 账号名称、Steam 昵称、或主机平台 ID）。</li>
          <li>点击搜索按钮即可拉取最新数据。</li>
        </ol>
        <p class="guide-note">
          ⚠️ <strong>特别提醒</strong>：请确保在 Apex 游戏设置中将你的“游戏遥测/配置”设为公开，并推荐在 Banner 上装备你想展示的数据追踪器（如击杀、伤害等），否则系统可能无法正确显示。
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.apex-tracker-view {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px 20px 40px;
  color: var(--text-primary);
}

.page-header {
  margin-bottom: 24px;
}

.page-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 8px;
  font-size: 1.8rem;
  font-weight: 700;
  color: var(--text-heading);
}

.page-desc {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.95rem;
}

/* 搜索面板 */
.search-card {
  border-radius: 16px;
  padding: 24px;
  margin-bottom: 24px;
}

.input-wrapper {
  display: flex;
  gap: 16px;
}

.platform-select {
  width: 180px;
  flex-shrink: 0;
}

.username-input {
  flex: 1;
}

.search-btn {
  width: 120px;
  font-weight: 600;
  letter-spacing: 2px;
}

/* 历史记录 */
.history-list {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
  font-size: 0.85rem;
}

.history-label {
  color: var(--text-secondary);
}

.history-tag {
  cursor: pointer;
  background: var(--bg-deep);
  border-color: var(--border-subtle);
  color: var(--text-primary);
  transition: all 0.2s ease;
}

.history-tag:hover {
  border-color: var(--accent-red, #f56c6c);
  color: var(--accent-red, #f56c6c);
}

.clear-history-btn {
  margin-left: 4px;
}

/* 初始引导 */
.initial-state {
  display: flex;
  justify-content: center;
  margin-top: 20px;
}

.guide-box {
  width: 100%;
  max-width: 600px;
  border-radius: 16px;
  padding: 24px;
  border: 1px dashed var(--border-subtle);
}

.guide-box h3 {
  margin-top: 0;
  margin-bottom: 16px;
  color: var(--text-heading);
}

.guide-box ol {
  padding-left: 20px;
  margin: 0 0 16px;
  line-height: 1.8;
}

.guide-note {
  margin: 0;
  font-size: 0.85rem;
  color: var(--text-secondary);
  background: rgba(245, 108, 108, 0.1);
  border: 1px solid rgba(245, 108, 108, 0.2);
  padding: 12px;
  border-radius: 8px;
  line-height: 1.5;
}

/* 加载动画 */
.loading-wrapper {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 300px;
}

.apex-loader {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
}

.apex-logo-shape {
  width: 50px;
  height: 50px;
  background: #f56c6c;
  clip-path: polygon(50% 0%, 0% 100%, 100% 100%);
  animation: rotateLogo 2s infinite ease-in-out;
}

@keyframes rotateLogo {
  0% { transform: scale(1) rotate(0deg); opacity: 0.6; }
  50% { transform: scale(1.2) rotate(180deg); opacity: 1; }
  100% { transform: scale(1) rotate(360deg); opacity: 0.6; }
}

/* 玩家名片 Card */
.profile-header {
  display: flex;
  align-items: center;
  border-radius: 16px;
  padding: 24px;
  margin-bottom: 24px;
  gap: 24px;
  background: linear-gradient(135deg, var(--bg-ctrl), #221c35);
  border: 1px solid var(--border-subtle);
  position: relative;
  overflow: hidden;
}

.profile-header::before {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  width: 250px;
  height: 100%;
  background: radial-gradient(circle, rgba(245, 108, 108, 0.15) 0%, rgba(0, 0, 0, 0) 70%);
  pointer-events: none;
}

.profile-avatar-wrapper {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  overflow: hidden;
  border: 3px solid #f56c6c;
  flex-shrink: 0;
  background: var(--bg-deep);
}

.profile-avatar {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.profile-meta {
  flex: 1;
}

.platform-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.platform-badge.pc {
  background: rgba(245, 108, 108, 0.2);
  color: #f56c6c;
}

.player-name {
  margin: 0 0 8px;
  font-size: 1.8rem;
  font-weight: 800;
  letter-spacing: 0.5px;
}

.player-level {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.level-label {
  font-size: 0.8rem;
  color: var(--text-secondary);
  text-transform: uppercase;
}

.level-val {
  font-size: 1.1rem;
  font-weight: 700;
  color: #e6a23c;
}

.prestige-val {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--text-secondary);
  margin-left: 4px;
}

.online-status {
  font-size: 0.75rem;
  padding: 2px 8px;
  border-radius: 12px;
  font-weight: 600;
}

.online-status.online {
  background: rgba(103, 194, 58, 0.2);
  color: #67c23a;
}

.online-status.offline {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-muted);
}

.rank-card {
  display: flex;
  align-items: center;
  gap: 16px;
  background: rgba(16, 16, 32, 0.6);
  padding: 12px 20px;
  border-radius: 12px;
  border: 1px solid rgba(245, 108, 108, 0.3);
  box-shadow: 0 4px 12px rgba(245, 108, 108, 0.15);
  flex-shrink: 0;
  transition: transform 0.3s ease;
}

.rank-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 16px rgba(245, 108, 108, 0.25);
}

.rank-icon-wrapper {
  width: 50px;
  height: 50px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.rank-icon {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.rank-info {
  display: flex;
  flex-direction: column;
}

.rank-name {
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--text-primary);
}

.rank-points {
  font-size: 0.85rem;
  color: var(--text-secondary);
  margin-top: 2px;
}

/* 布局分布 */
.detail-layout {
  display: grid;
  grid-template-columns: 1fr;
  gap: 24px;
}

@media (min-width: 992px) {
  .detail-layout {
    grid-template-columns: 5fr 7fr;
  }
}

.left-col, .right-col {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.stats-card, .legends-card, .history-card {
  border-radius: 16px;
  padding: 24px;
  border: 1px solid var(--border-subtle);
}

.card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 20px;
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--text-heading);
}

.title-help {
  color: var(--text-muted);
  cursor: pointer;
  font-size: 0.95rem;
}

.realtime-status-banner {
  background: rgba(245, 108, 108, 0.08);
  border-left: 3px solid #f56c6c;
  padding: 8px 12px;
  font-size: 0.88rem;
  border-radius: 0 8px 8px 0;
  margin-bottom: 16px;
}

/* 核心属性 Grid */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}

.stat-box {
  background: var(--bg-ctrl);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
}

.stat-label {
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

.stat-val {
  font-size: 1.4rem;
  font-weight: 800;
  color: var(--text-heading);
}

/* 常用传奇 */
.legends-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 16px;
  background: var(--bg-ctrl);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 14px;
  transition: all 0.3s ease;
}

.legend-item:hover {
  transform: translateX(4px);
  border-color: rgba(245, 108, 108, 0.3);
  background: rgba(245, 108, 108, 0.03);
}

.legend-avatar {
  width: 50px;
  height: 50px;
  border-radius: 8px;
  background: var(--bg-deep);
  object-fit: cover;
  border: 1px solid var(--border-subtle);
}

.legend-info {
  flex: 1;
}

.legend-name {
  font-weight: 700;
  font-size: 0.95rem;
  margin-bottom: 6px;
}

.legend-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
}

.legend-stat-pill {
  font-size: 0.78rem;
  color: var(--text-secondary);
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  padding: 4px 8px;
  border-radius: 6px;
  transition: all 0.2s ease;
}

.legend-stat-pill:hover {
  border-color: #f56c6c;
  color: var(--text-heading);
}

.no-data-text {
  text-align: center;
  color: var(--text-muted);
  font-size: 0.85rem;
  padding: 20px 0;
}

/* 对局历史 */
.sessions-timeline {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.match-history-row {
  background: var(--bg-ctrl);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.match-history-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--border-subtle);
  padding-bottom: 8px;
}

.match-time {
  font-size: 0.82rem;
  color: var(--text-secondary);
  font-weight: 500;
}

.match-legend-badge {
  font-size: 0.82rem;
}

.match-history-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}

.history-stat-pill {
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.history-stat-pill strong {
  color: var(--text-heading);
  font-weight: 700;
}

.history-stat-pill strong.positive {
  color: #67c23a;
}

.history-stat-pill strong.negative {
  color: #f56c6c;
}

/* 空状态 */
.empty-sessions {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  text-align: center;
  color: var(--text-muted);
}

.empty-icon {
  font-size: 3rem;
  margin-bottom: 16px;
  color: var(--text-muted);
}

.empty-sessions p {
  margin: 0 0 8px;
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--text-primary);
}

.empty-subtext {
  font-size: 0.8rem;
  color: var(--text-secondary);
  line-height: 1.5;
  max-width: 360px;
}

/* Mobile responsive fixes */
@media (max-width: 768px) {
  .apex-tracker-view {
    padding: 12px 10px 24px;
  }
  
  .input-wrapper {
    flex-direction: column;
    gap: 12px;
  }
  
  .platform-select {
    width: 100%;
  }
  
  .search-btn {
    width: 100%;
  }
  
  .profile-header {
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 20px;
  }
  
  .rank-card {
    width: 100%;
    justify-content: center;
  }
  
  .player-level {
    justify-content: center;
  }
}

@media (max-width: 576px) {
  .stats-grid {
    grid-template-columns: 1fr;
    gap: 12px;
  }
  
  .history-list {
    justify-content: center;
  }
}
</style>

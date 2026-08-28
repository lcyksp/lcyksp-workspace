<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { ElMessage } from 'element-plus'

const PLAYLIST_KEY = 'lcyksp_lyrics_playlist'

const searchQuery = ref('')
const searchResults = ref([])
const searchLoading = ref(false)
const currentSong = ref(null)
const lyricsLines = ref([])
const translatedLines = ref({})
const currentTime = ref(0)
const duration = ref(0)
const isFullscreen = ref(false)
const fontSize = ref(48)
const lyricsContainerRef = ref(null)
const searchTimer = ref(null)
const currentLineIndex = ref(-1)
const showSettings = ref(false)
const isRunning = ref(false)
const mediaInfo = ref(null)
const syncFlash = ref(false)
const loopMode = ref('list')
const playlist = ref([])
const showPlaylist = ref(false)
const isImmersive = ref(false)
const tpControlsVisible = ref(true)
let tpControlsTimer = null
let tickTimer = null
let mediaCheckTimer = null
let syncFlashTimer = null
const lyricsCache = {}

function loadPlaylist() {
  try {
    const raw = localStorage.getItem(PLAYLIST_KEY)
    if (raw) playlist.value = JSON.parse(raw)
  } catch { playlist.value = [] }
}

function savePlaylist() {
  localStorage.setItem(PLAYLIST_KEY, JSON.stringify(playlist.value))
}

function addToPlaylist(song) {
  if (playlist.value.find(s => s.id === song.id)) {
    ElMessage.info('已在播放列表中')
    return
  }
  playlist.value.push({ id: song.id, name: song.name, artists: song.artists, duration: song.duration || 0 })
  savePlaylist()
  ElMessage.success(`已添加：${song.name}`)
}

function removeFromPlaylist(idx) {
  playlist.value.splice(idx, 1)
  savePlaylist()
}

function moveInPlaylist(idx, dir) {
  const newIdx = idx + dir
  if (newIdx < 0 || newIdx >= playlist.value.length) return
  const temp = playlist.value[idx]
  playlist.value[idx] = playlist.value[newIdx]
  playlist.value[newIdx] = temp
  savePlaylist()
}

function clearPlaylist() {
  playlist.value = []
  savePlaylist()
}

function playFromPlaylist(idx, autoStart = false) {
  const song = playlist.value[idx]
  if (!song) return
  selectSong(song, autoStart)
}

function playNext() {
  if (playlist.value.length === 0) return
  if (loopMode.value === 'single') {
    currentTime.value = 0
    currentLineIndex.value = -1
    startTimer()
    return
  }
  const curIdx = playlist.value.findIndex(s => s.id === currentSong.value?.id)
  let nextIdx = curIdx + 1
  if (nextIdx >= playlist.value.length) {
    if (loopMode.value === 'list') nextIdx = 0
    else { stopTimer(); return }
  }
  playFromPlaylist(nextIdx, true)
}

function playPrev() {
  if (playlist.value.length === 0) return
  const curIdx = playlist.value.findIndex(s => s.id === currentSong.value?.id)
  let prevIdx = curIdx - 1
  if (prevIdx < 0) prevIdx = playlist.value.length - 1
  playFromPlaylist(prevIdx, true)
}

async function prefetchLyrics(songId) {
  if (lyricsCache[songId]) return lyricsCache[songId]
  try {
    const res = await fetch(`/api/lyrics/lyric?id=${songId}`)
    const data = await res.json()
    const parsed = parseLrc(data.lrc || '')
    const trans = {}
    if (data.tlyric) {
      for (const t of parseLrc(data.tlyric)) trans[t.time] = t.text
    }
    lyricsCache[songId] = { lines: parsed, translated: trans }
    return lyricsCache[songId]
  } catch { return null }
}

function prefetchNextLyrics() {
  if (playlist.value.length === 0) return
  const curIdx = playlist.value.findIndex(s => s.id === currentSong.value?.id)
  let nextIdx = loopMode.value === 'single' ? curIdx : (curIdx + 1) % playlist.value.length
  const next = playlist.value[nextIdx]
  if (next && next.id !== currentSong.value?.id) {
    prefetchLyrics(next.id)
  }
}

function detectMediaSession() {
  if (!('mediaSession' in navigator)) return null
  const meta = navigator.mediaSession.metadata
  if (!meta || !meta.title) return null
  return { title: meta.title || '', artist: meta.artist || '', album: meta.album || '' }
}

async function autoDetectSong() {
  const info = detectMediaSession()
  if (!info || (!info.title && !info.artist)) return
  mediaInfo.value = info
  if (currentSong.value) return
  const query = info.artist ? `${info.title} ${info.artist}` : info.title
  if (searchQuery.value === query) return
  searchQuery.value = query
  searchLoading.value = true
  try {
    const res = await fetch(`/api/lyrics/search?s=${encodeURIComponent(query)}&limit=3`)
    const data = await res.json()
    const songs = data.songs || []
    if (songs.length > 0) {
      const best = songs[0]
      if (!info.artist || best.name.includes(info.title) || info.title.includes(best.name)) {
        await selectSong(best)
        ElMessage.success(`已自动匹配：${best.name} - ${best.artists}`)
      }
    }
  } catch {} finally { searchLoading.value = false }
}

function startMediaDetection() {
  if (!('mediaSession' in navigator)) return
  mediaCheckTimer = setInterval(autoDetectSong, 3000)
  autoDetectSong()
}

function stopMediaDetection() {
  if (mediaCheckTimer) { clearInterval(mediaCheckTimer); mediaCheckTimer = null }
}

function handleSearch(query) {
  if (!query || query.length < 1) { searchResults.value = []; return }
  clearTimeout(searchTimer.value)
  searchTimer.value = setTimeout(async () => {
    searchLoading.value = true
    try {
      const res = await fetch(`/api/lyrics/search?s=${encodeURIComponent(query)}&limit=8`)
      const data = await res.json()
      searchResults.value = data.songs || []
    } catch { searchResults.value = [] } finally { searchLoading.value = false }
  }, 350)
}

async function selectSong(song, autoStart = false) {
  currentSong.value = song
  searchResults.value = []
  searchQuery.value = `${song.name} - ${song.artists}`
  currentLineIndex.value = -1
  currentTime.value = 0
  duration.value = (song.duration || 240000) / 1000
  stopTimer()

  const cached = lyricsCache[song.id]
  if (cached) {
    lyricsLines.value = cached.lines
    translatedLines.value = cached.translated
  } else {
    lyricsLines.value = []
    translatedLines.value = {}
    try {
      const res = await fetch(`/api/lyrics/lyric?id=${song.id}`)
      const data = await res.json()
      lyricsLines.value = parseLrc(data.lrc || '')
      const trans = {}
      if (data.tlyric) { for (const t of parseLrc(data.tlyric)) trans[t.time] = t.text }
      translatedLines.value = trans
      lyricsCache[song.id] = { lines: lyricsLines.value, translated: trans }
      if (lyricsLines.value.length === 0) ElMessage.info('该歌曲暂无歌词')
    } catch { ElMessage.error('获取歌词失败') }
  }

  nextTick(() => {
    prefetchNextLyrics()
    if (autoStart) startTimer()
  })
}

function parseLrc(lrcText) {
  const lines = lrcText.split('\n')
  const result = []
  const regex = /\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/
  for (const line of lines) {
    const match = line.match(regex)
    if (!match) continue
    const time = parseInt(match[1], 10) * 60 + parseInt(match[2], 10) + parseInt(match[3].padEnd(3, '0'), 10) / 1000
    const text = match[4].trim()
    if (text) result.push({ time, text })
  }
  result.sort((a, b) => a.time - b.time)
  return result
}

function onTimeUpdateLocal() {
  if (!isRunning.value) return
  currentTime.value += 0.1
  if (currentTime.value >= duration.value) {
    stopTimer()
    playNext()
    return
  }
  updateCurrentLine()
}

function updateCurrentLine() {
  let idx = -1
  for (let i = lyricsLines.value.length - 1; i >= 0; i--) {
    if (currentTime.value >= lyricsLines.value[i].time - 0.1) { idx = i; break }
  }
  if (idx !== currentLineIndex.value) { currentLineIndex.value = idx; scrollToLine(idx) }
}

function scrollToLine(idx) {
  if (idx < 0 || !lyricsContainerRef.value) return
  nextTick(() => {
    const el = lyricsContainerRef.value?.querySelector(`[data-line="${idx}"]`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
}

function toggleTimer() { isRunning.value ? stopTimer() : startTimer() }
function startTimer() { if (isRunning.value) return; isRunning.value = true; tickTimer = setInterval(onTimeUpdateLocal, 100) }
function stopTimer() { isRunning.value = false; if (tickTimer) { clearInterval(tickTimer); tickTimer = null } }

function toggleImmersive() {
  isImmersive.value = !isImmersive.value
  if (isImmersive.value) {
    tpControlsVisible.value = false
  } else {
    tpControlsVisible.value = true
    clearTimeout(tpControlsTimer)
  }
}

function onTpClick() {
  if (isImmersive.value) {
    tpControlsVisible.value = !tpControlsVisible.value
    if (tpControlsVisible.value) {
      clearTimeout(tpControlsTimer)
      tpControlsTimer = setTimeout(() => { tpControlsVisible.value = false }, 4000)
    }
  } else {
    toggleTimer()
  }
}

function jumpToLine(idx) {
  if (idx < 0 || idx >= lyricsLines.value.length) return
  currentTime.value = lyricsLines.value[idx].time
  currentLineIndex.value = idx
  updateCurrentLine()
  if (!isRunning.value) startTimer()
  showSyncFlash()
}

function showSyncFlash() { syncFlash.value = true; clearTimeout(syncFlashTimer); syncFlashTimer = setTimeout(() => { syncFlash.value = false }, 600) }

function resetTimer() { stopTimer(); currentTime.value = 0; currentLineIndex.value = -1; if (lyricsContainerRef.value) lyricsContainerRef.value.scrollTop = 0 }
function addTime(sec) { currentTime.value = Math.max(0, Math.min(duration.value, currentTime.value + sec)); updateCurrentLine() }

async function toggleFullscreen() {
  if (!document.fullscreenElement) {
    try {
      await document.documentElement.requestFullscreen()
      try { await screen.orientation.lock('landscape') } catch {}
      isFullscreen.value = true
    } catch { ElMessage.warning('无法进入全屏') }
  } else {
    await document.exitFullscreen()
    try { screen.orientation.unlock() } catch {}
    isFullscreen.value = false
  }
}

function onFullscreenChange() { isFullscreen.value = !!document.fullscreenElement }
function formatTime(s) { if (!s || !isFinite(s)) return '0:00'; return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` }

onUnmounted(() => { stopTimer(); stopMediaDetection(); document.removeEventListener('fullscreenchange', onFullscreenChange) })
onMounted(() => { document.addEventListener('fullscreenchange', onFullscreenChange); startMediaDetection(); loadPlaylist() })
</script>

<template>
  <div class="lyrics-page" :class="{ fullscreen: isFullscreen }">

    <!-- 搜索界面 -->
    <div v-if="!isFullscreen && !currentSong" class="search-view">
      <h2 class="page-title"><span class="title-icon">🎵</span> 横屏歌词</h2>
      <p class="page-desc">搜索歌曲获取歌词，横屏全屏后变成提词器。打开手机音乐 App 播放，点击歌词行同步。</p>
      <div class="page-content">
        <div v-if="mediaInfo" class="media-detected">
          <span class="media-icon">🎶</span>
          <span>检测到正在播放：<strong>{{ mediaInfo.title }}</strong> {{ mediaInfo.artist ? `- ${mediaInfo.artist}` : '' }}</span>
        </div>
        <div v-else class="media-hint">
          <span class="media-icon">💡</span>
          <span>Android Chrome/Edge 播放音乐时可自动识别歌名并加载歌词</span>
        </div>
        <div class="search-box">
          <el-autocomplete
            v-model="searchQuery"
            :fetch-suggestions="(q, cb) => { handleSearch(q); cb(searchResults.map(s => ({ ...s, value: `${s.name} - ${s.artists}` }))) }"
            placeholder="搜索歌曲名或歌手..."
            :trigger-on-focus="false"
            :debounce="0"
            value-key="value"
            class="lyrics-search-input"
            size="large"
            @select="(item) => { selectSong(item) }"
            :loading="searchLoading"
            clearable
          >
            <template #default="{ item }">
              <div class="search-result-item">
                <div class="song-name">{{ item.name }}</div>
                <div class="song-artist">{{ item.artists }} · {{ item.album }}</div>
              </div>
            </template>
          </el-autocomplete>
        </div>
        <div class="tip-card">
          <div class="tip-icon">💡</div>
          <div class="tip-text">
            <strong>使用方法：</strong>搜索歌曲 → 打开手机音乐 App 播放同一首歌 → 点击歌词行设定起始位置 → 歌词自动滚动。
            适合洗澡、健身时当提词器使用。
          </div>
        </div>
      </div>
    </div>

    <!-- 歌词界面 -->
    <div v-if="!isFullscreen && currentSong" class="inline-view">
      <div class="top-row">
        <el-autocomplete
          v-model="searchQuery"
          :fetch-suggestions="(q, cb) => { handleSearch(q); cb(searchResults.map(s => ({ ...s, value: `${s.name} - ${s.artists}` }))) }"
          placeholder="搜索歌曲..."
          :trigger-on-focus="false"
          :debounce="0"
          value-key="value"
          class="lyrics-search-input inline"
          size="default"
          @select="(item) => { selectSong(item) }"
          :loading="searchLoading"
          clearable
        >
          <template #default="{ item }">
            <div class="search-result-item">
              <div class="song-name">{{ item.name }}</div>
              <div class="song-artist">{{ item.artists }}</div>
            </div>
          </template>
        </el-autocomplete>
      </div>

      <div class="song-info-bar">
        <span class="song-title">{{ currentSong.name }}</span>
        <span class="song-artist-text">{{ currentSong.artists }}</span>
      </div>

      <div ref="lyricsContainerRef" class="lyrics-scroll">
        <div v-if="lyricsLines.length === 0" class="no-lyrics">暂无歌词</div>
        <div
          v-for="(line, idx) in lyricsLines"
          :key="idx"
          :data-line="idx"
          class="lyric-line"
          :class="{ active: idx === currentLineIndex, past: idx < currentLineIndex }"
          :style="{ fontSize: fontSize + 'px' }"
          @click="jumpToLine(idx)"
        >
          <span class="lyric-text">{{ line.text }}</span>
          <span v-if="translatedLines[line.time]" class="lyric-translation">{{ translatedLines[line.time] }}</span>
        </div>
      </div>

      <!-- 控制栏第一行：播放核心 -->
      <div class="ctrl-row primary-row">
        <button class="ctrl-btn sm" @click="playPrev">⏮</button>
        <button class="ctrl-btn sm" @click="addTime(-5)">-5s</button>
        <button class="play-btn" @click="toggleTimer">
          <span v-if="isRunning">⏸</span>
          <span v-else>▶️</span>
        </button>
        <button class="ctrl-btn sm" @click="addTime(5)">+5s</button>
        <button class="ctrl-btn sm" @click="playNext">⏭</button>
        <span class="time-display">{{ formatTime(currentTime) }} / {{ formatTime(duration) }}</span>
      </div>

      <!-- 控制栏第二行：微调 + 功能 -->
      <div class="ctrl-row secondary-row">
        <div class="time-btns-group">
          <button class="ctrl-btn sm" @click="addTime(-1)">-1s</button>
          <button class="ctrl-btn sm" @click="addTime(-0.5)">-½s</button>
          <button class="ctrl-btn sm" @click="addTime(0.5)">+½s</button>
          <button class="ctrl-btn sm" @click="addTime(1)">+1s</button>
        </div>
        <div class="func-btns-group">
          <button class="ctrl-btn sm" @click="addToPlaylist(currentSong)">📋+</button>
          <button class="ctrl-btn sm" :class="{ active: loopMode === 'single' }" @click="loopMode = loopMode === 'single' ? 'list' : 'single'">
            {{ loopMode === 'single' ? '🔂' : '🔁' }}
          </button>
          <button class="ctrl-btn sm" @click="showPlaylist = !showPlaylist">📑{{ playlist.length }}</button>
          <button class="ctrl-btn sm" @click="resetTimer">⟳</button>
          <button class="ctrl-btn sm" @click="showSettings = !showSettings">⚙️</button>
          <button class="ctrl-btn primary sm" @click="toggleFullscreen">⛶</button>
        </div>
      </div>

      <!-- 播放列表面板 -->
      <div v-if="showPlaylist" class="panel-card">
        <div class="panel-header">
          <span>播放列表 ({{ playlist.length }})</span>
          <button v-if="playlist.length" class="ctrl-btn sm" @click="clearPlaylist">清空</button>
        </div>
        <div v-if="playlist.length === 0" class="panel-empty">搜索歌曲后点击 📋+ 添加</div>
        <div v-for="(song, idx) in playlist" :key="song.id" class="pl-item" :class="{ playing: song.id === currentSong?.id }" @click="playFromPlaylist(idx, true)">
          <button class="pl-move" @click.stop="moveInPlaylist(idx, -1)" :disabled="idx === 0">▲</button>
          <button class="pl-move" @click.stop="moveInPlaylist(idx, 1)" :disabled="idx === playlist.length - 1">▼</button>
          <span class="pl-idx">{{ idx + 1 }}</span>
          <span class="pl-info">
            <span class="pl-name">{{ song.name }}</span>
            <span class="pl-artist">{{ song.artists }}</span>
          </span>
          <button class="pl-remove" @click.stop="removeFromPlaylist(idx)">✕</button>
        </div>
      </div>

      <!-- 设置面板 -->
      <div v-if="showSettings" class="panel-card">
        <div class="setting-row">
          <label>字号</label>
          <input type="range" v-model.number="fontSize" min="20" max="120" step="2" class="setting-slider">
          <span class="setting-val">{{ fontSize }}px</span>
        </div>
      </div>
    </div>

    <!-- 全屏提词器 -->
    <div v-if="isFullscreen && currentSong" class="teleprompter" :class="{ immersive: isImmersive }" @click="onTpClick">
      <div class="tp-sync-hint" :class="{ visible: !isRunning }">
        👆 点击歌词行同步位置
      </div>
      <div v-if="syncFlash" class="tp-sync-flash">✓ 已同步</div>

      <!-- 沉浸模式浮动按钮 -->
      <button v-if="isImmersive" class="tp-immersive-btn" @click.stop="toggleImmersive">◁</button>

      <!-- 半沉浸：顶部栏 -->
      <div v-if="!isImmersive" class="tp-header" @click.stop>
        <span class="tp-song">{{ currentSong.name }} — {{ currentSong.artists }}</span>
        <div class="tp-header-btns">
          <button class="tp-exit" @click.stop="toggleImmersive">⛶ 沉浸</button>
          <button class="tp-exit" @click.stop="toggleFullscreen">✕ 退出</button>
        </div>
      </div>

      <div ref="lyricsContainerRef" class="tp-lyrics">
        <div v-if="lyricsLines.length === 0" class="tp-no-lyrics">暂无歌词</div>
        <div
          v-for="(line, idx) in lyricsLines"
          :key="idx"
          :data-line="idx"
          class="tp-line"
          :class="{ active: idx === currentLineIndex, past: idx < currentLineIndex }"
          :style="{ fontSize: fontSize * 1.5 + 'px' }"
          @click.stop="jumpToLine(idx)"
        >
          <span>{{ line.text }}</span>
          <div v-if="translatedLines[line.time]" class="tp-translation" :style="{ fontSize: fontSize * 0.7 + 'px' }">{{ translatedLines[line.time] }}</div>
        </div>
      </div>

      <!-- 半沉浸：底部控制栏 -->
      <div v-if="!isImmersive" class="tp-footer" @click.stop>
        <button class="tp-play" @click="playPrev">⏮</button>
        <button class="tp-play main" @click="toggleTimer">
          <span v-if="isRunning">⏸</span>
          <span v-else>▶️</span>
        </button>
        <button class="tp-play" @click="playNext">⏭</button>
        <div class="tp-progress" @click.stop>
          <div class="tp-progress-fill" :style="{ width: duration ? (currentTime / duration * 100) + '%' : '0%' }"></div>
        </div>
        <span class="tp-time">{{ formatTime(currentTime) }} / {{ formatTime(duration) }}</span>
        <div class="tp-time-btns">
          <button class="tp-ctrl" @click.stop="addTime(-5)">-5s</button>
          <button class="tp-ctrl" @click.stop="addTime(-1)">-1s</button>
          <button class="tp-ctrl" @click.stop="addTime(-0.5)">-½s</button>
          <button class="tp-ctrl" @click.stop="addTime(0.5)">+½s</button>
          <button class="tp-ctrl" @click.stop="addTime(1)">+1s</button>
          <button class="tp-ctrl" @click.stop="addTime(5)">+5s</button>
        </div>
        <button class="tp-ctrl" :class="{ active: loopMode === 'single' }" @click.stop="loopMode = loopMode === 'single' ? 'list' : 'single'">{{ loopMode === 'single' ? '🔂' : '🔁' }}</button>
        <div class="tp-font-btns">
          <button @click.stop="fontSize = Math.max(20, fontSize - 6)">A-</button>
          <button @click.stop="fontSize = Math.min(120, fontSize + 6)">A+</button>
        </div>
        <button class="tp-ctrl" @click.stop="toggleFullscreen">✕</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lyrics-page { min-height: 100vh; color: var(--text-primary); }

.search-view { max-width: 640px; margin: 0 auto; padding: 20px 16px 40px; }
.page-title { font-size: 1.4rem; font-weight: 400; color: var(--text-heading); margin: 0 0 6px; letter-spacing: 1px; }
.title-icon { margin-right: 8px; }
.page-desc { color: var(--text-secondary); font-size: 0.85rem; margin: 0 0 24px; }
.page-content { background: var(--bg-card); border-radius: 12px; padding: 24px; border: 1px solid var(--border-color); }
.search-box { margin-bottom: 16px; }
.lyrics-search-input { width: 100%; }
.lyrics-search-input :deep(.el-input__wrapper) { background: var(--bg-input) !important; box-shadow: 0 0 0 1px var(--border-color) inset !important; border-radius: 10px; }
.lyrics-search-input :deep(.el-input__inner) { color: var(--text-primary) !important; }
.lyrics-search-input :deep(.el-input__inner::placeholder) { color: var(--text-placeholder) !important; }
.search-result-item { padding: 4px 0; }
.song-name { font-size: 14px; color: var(--text-primary); font-weight: 500; }
.song-artist { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
.tip-card { display: flex; gap: 12px; padding: 14px; background: var(--bg-ctrl); border-radius: 10px; border: 1px solid var(--border-subtle); }
.tip-icon { font-size: 1.3rem; flex-shrink: 0; }
.tip-text { font-size: 0.82rem; color: var(--text-secondary); line-height: 1.6; }
.tip-text strong { color: var(--text-primary); }
.media-detected, .media-hint { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 8px; margin-bottom: 10px; font-size: 0.82rem; }
.media-detected { background: color-mix(in srgb, var(--accent-green) 12%, transparent); color: var(--accent-green); border: 1px solid color-mix(in srgb, var(--accent-green) 25%, transparent); }
.media-detected strong { color: var(--text-primary); }
.media-hint { background: var(--bg-ctrl); color: var(--text-secondary); border: 1px solid var(--border-subtle); }
.media-icon { font-size: 1rem; flex-shrink: 0; }

.inline-view { padding: 12px; display: flex; flex-direction: column; height: calc(100vh - 56px); }
.top-row { flex-shrink: 0; margin-bottom: 8px; }
.lyrics-search-input.inline { width: 100%; }
.lyrics-search-input :deep(.el-input__wrapper) { background: var(--bg-input) !important; box-shadow: 0 0 0 1px var(--border-color) inset !important; border-radius: 10px; }
.lyrics-search-input :deep(.el-input__inner) { color: var(--text-primary) !important; }
.lyrics-search-input :deep(.el-input__inner::placeholder) { color: var(--text-placeholder) !important; }
.search-result-item { padding: 4px 0; }
.song-name { font-size: 14px; color: var(--text-primary); font-weight: 500; }
.song-artist { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }

.song-info-bar { text-align: center; margin-bottom: 6px; flex-shrink: 0; }
.song-title { font-size: 1rem; font-weight: 600; color: var(--text-heading); }
.song-artist-text { font-size: 0.8rem; color: var(--text-secondary); margin-left: 6px; }

.lyrics-scroll { flex: 1; overflow-y: auto; padding: 20px 12px; scroll-behavior: smooth; min-height: 0; }
.no-lyrics { text-align: center; color: var(--text-muted); padding: 40px 0; font-size: 0.9rem; }
.lyric-line { text-align: center; padding: 8px 0; color: var(--text-muted); transition: all 0.35s ease; line-height: 1.5; cursor: pointer; border-radius: 6px; }
.lyric-line:hover { background: var(--bg-hover); }
.lyric-line.active { color: var(--accent-blue); font-weight: 600; transform: scale(1.05); background: var(--bg-active); }
.lyric-line.past { color: var(--text-dim); }
.lyric-translation { display: block; font-size: 0.6em; color: var(--text-muted); margin-top: 2px; font-weight: 400; }

.ctrl-row { display: flex; align-items: center; padding: 5px 0; flex-shrink: 0; }
.primary-row { justify-content: center; gap: 8px; }
.secondary-row { justify-content: space-between; gap: 6px; flex-wrap: wrap; }
.time-btns-group { display: flex; gap: 4px; }
.func-btns-group { display: flex; gap: 4px; }
.play-btn { width: 42px; height: 42px; border-radius: 50%; border: none; background: var(--accent-blue); color: #fff; font-size: 1rem; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.time-display { font-size: 0.72rem; color: var(--text-secondary); white-space: nowrap; margin-left: 4px; }

.ctrl-btn { padding: 6px 10px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-ctrl); color: var(--text-primary); cursor: pointer; font-size: 0.78rem; white-space: nowrap; transition: all 0.2s; }
.ctrl-btn:hover { border-color: var(--accent-blue); }
.ctrl-btn.sm { padding: 5px 8px; font-size: 0.72rem; }
.ctrl-btn.active { background: var(--accent-blue); color: #fff; border-color: var(--accent-blue); }
.ctrl-btn.primary { background: var(--accent-blue); color: #fff; border-color: var(--accent-blue); }
.ctrl-btn:disabled { opacity: 0.3; cursor: not-allowed; }

.panel-card { background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 10px; margin-top: 6px; max-height: 220px; overflow-y: auto; flex-shrink: 0; }
.panel-header { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--border-subtle); font-size: 0.82rem; color: var(--text-secondary); }
.panel-empty { padding: 16px; text-align: center; color: var(--text-muted); font-size: 0.8rem; }
.pl-item { display: flex; align-items: center; gap: 6px; padding: 7px 10px; cursor: pointer; transition: background 0.15s; border-bottom: 1px solid var(--border-subtle); }
.pl-item:last-child { border-bottom: none; }
.pl-item:hover { background: var(--bg-hover); }
.pl-item.playing { background: var(--bg-active); }
.pl-move { border: none; background: none; color: var(--text-muted); cursor: pointer; font-size: 10px; padding: 2px; line-height: 1; }
.pl-move:hover:not(:disabled) { color: var(--accent-blue); }
.pl-move:disabled { opacity: 0.2; }
.pl-idx { font-size: 0.7rem; color: var(--text-muted); min-width: 16px; text-align: center; }
.pl-info { flex: 1; min-width: 0; }
.pl-name { font-size: 0.82rem; color: var(--text-primary); display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-artist { font-size: 0.7rem; color: var(--text-secondary); }
.pl-remove { border: none; background: none; color: var(--text-muted); cursor: pointer; font-size: 0.75rem; padding: 3px; }
.pl-remove:hover { color: var(--accent-red); }

.setting-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; }
.setting-row label { font-size: 0.82rem; color: var(--text-secondary); min-width: 32px; }
.setting-slider { flex: 1; accent-color: var(--accent-blue); }
.setting-val { font-size: 0.75rem; color: var(--text-primary); min-width: 40px; text-align: right; }

.teleprompter { position: fixed; inset: 0; background: #0a0a14; color: #e0e0e0; display: flex; flex-direction: column; z-index: 9999; cursor: pointer; user-select: none; }
.tp-sync-hint { position: absolute; top: 50px; left: 50%; transform: translateX(-50%); padding: 8px 20px; background: rgba(56,189,248,0.15); border: 1px solid rgba(56,189,248,0.3); border-radius: 20px; color: #38bdf8; font-size: 14px; z-index: 10; opacity: 0; transition: opacity 0.3s; pointer-events: none; }
.tp-sync-hint.visible { opacity: 1; }
.tp-sync-flash { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); padding: 14px 28px; background: rgba(56,189,248,0.25); border: 1px solid #38bdf8; border-radius: 12px; color: #fff; font-size: 18px; font-weight: 600; z-index: 99999; animation: flashIn 0.6s ease-out forwards; pointer-events: none; }
@keyframes flashIn { 0% { opacity: 1; transform: translate(-50%, -50%) scale(0.8); } 50% { opacity: 1; transform: translate(-50%, -50%) scale(1.05); } 100% { opacity: 0; transform: translate(-50%, -50%) scale(1); } }
.tp-header { display: flex; justify-content: space-between; align-items: center; padding: 10px 24px; background: rgba(0,0,0,0.5); flex-shrink: 0; cursor: default; }
.tp-song { font-size: 13px; color: rgba(255,255,255,0.5); }
.tp-exit { padding: 5px 12px; border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; background: rgba(255,255,255,0.08); color: #fff; cursor: pointer; font-size: 12px; }
.tp-exit:hover { background: rgba(255,255,255,0.15); }
.tp-lyrics { flex: 1; overflow-y: auto; padding: 15vh 40px; scroll-behavior: smooth; display: flex; flex-direction: column; align-items: center; }
.tp-no-lyrics { color: rgba(255,255,255,0.3); font-size: 24px; padding: 40vh 0; }
.tp-line { text-align: center; padding: 14px 20px; color: rgba(255,255,255,0.25); transition: all 0.4s ease; line-height: 1.4; max-width: 90vw; cursor: pointer; border-radius: 8px; }
.tp-line:hover { background: rgba(255,255,255,0.05); }
.tp-line.active { color: #38bdf8; font-weight: 700; transform: scale(1.08); text-shadow: 0 0 20px rgba(56,189,248,0.3); background: rgba(56,189,248,0.08); }
.tp-line.past { color: rgba(255,255,255,0.12); }
.tp-translation { color: rgba(255,255,255,0.2); margin-top: 6px; font-weight: 400; }
.tp-footer { display: flex; align-items: center; gap: 12px; padding: 12px 24px; background: rgba(0,0,0,0.6); flex-shrink: 0; cursor: default; }
.tp-play { width: 44px; height: 44px; border-radius: 50%; border: none; background: rgba(255,255,255,0.1); color: #fff; font-size: 1.1rem; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.tp-play.main { background: #38bdf8; width: 50px; height: 50px; font-size: 1.3rem; }
.tp-play:hover { background: rgba(255,255,255,0.18); }
.tp-ctrl.active { background: #38bdf8; color: #fff; border-color: #38bdf8; }
.tp-progress { flex: 1; height: 5px; background: rgba(255,255,255,0.12); border-radius: 3px; overflow: hidden; }
.tp-progress-fill { height: 100%; background: #38bdf8; border-radius: 3px; transition: width 0.1s linear; }
.tp-time { font-size: 12px; color: rgba(255,255,255,0.4); min-width: 85px; text-align: right; }
.tp-ctrl { padding: 5px 8px; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; background: rgba(255,255,255,0.06); color: #fff; cursor: pointer; font-size: 11px; min-width: 36px; text-align: center; }
.tp-time-btns { display: flex; gap: 3px; }
.tp-font-btns { display: flex; gap: 4px; }
.tp-font-btns button { padding: 5px 10px; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; background: rgba(255,255,255,0.06); color: #fff; cursor: pointer; font-size: 12px; }
.tp-header-btns { display: flex; gap: 8px; }

.teleprompter.immersive { background: #000; }
.teleprompter.immersive .tp-header,
.teleprompter.immersive .tp-footer { display: none; }
.teleprompter.immersive .tp-lyrics { padding: 40vh 40px 40vh; height: auto; min-height: 100vh; }
.teleprompter.immersive .tp-sync-hint { display: none; }

.tp-immersive-btn {
  position: fixed;
  bottom: 16px;
  right: 16px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid rgba(255,255,255,0.2);
  background: rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.6);
  font-size: 16px;
  cursor: pointer;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.3s, background 0.2s;
  opacity: 0;
}
.teleprompter.immersive:hover .tp-immersive-btn { opacity: 1; }
.teleprompter.immersive .tp-immersive-btn:hover { background: rgba(255,255,255,0.2); color: #fff; }

@media (max-width: 480px) {
  .search-view { padding: 12px 10px 30px; }
  .page-content { padding: 16px; }
  .top-controls { flex-wrap: wrap; }
  .lyrics-search-input.inline { min-width: 0; }
}
</style>

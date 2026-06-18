<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { 
  User, 
  UserFilled, 
  Opportunity, 
  Help, 
  Cpu, 
  UploadFilled, 
  Download, 
  Delete, 
  Refresh, 
  Collection, 
  VideoPlay,
  Share,
  Microphone
} from '@element-plus/icons-vue'

// Basic Lists
const namesList = ref([])
const activeTab = ref('roll-call')

// List Management States
const newName = ref('')
const newWeight = ref(0.5)

// Drawer / Roll Call States
const drawCount = ref(1)
const isRolling = ref(false)
const rollingName = ref('准备就绪')
const lastDrawResults = ref([])
const drawHistory = ref([])
const enableTTS = ref(true)
const enableSound = ref(true)

// Grouping States
const groupMode = ref('count') // 'count' (number of groups) or 'size' (members per group)
const groupTargetValue = ref(3)
const groupingResults = ref([])

// Excel loading
const xlsxLoading = ref(false)
const tutorialVisible = ref(false)

// Random Number Generator States
const numMin = ref('')
const numMax = ref('')
const numQty = ref(1)
const allowRepeat = ref(false)
const isRollingNum = ref(false)
const rollingNumResult = ref('准备就绪')
const lastNumResults = ref([])
const numHistory = ref([])

// Sample Names Data
const sampleNamesList = [
  { name: '曹操', weight: 0.8 },
  { name: '刘备', weight: 1.0 },
  { name: '孙权', weight: 0.7 },
  { name: '诸葛亮', weight: 1.0 },
  { name: '司马懿', weight: 0.8 },
  { name: '关羽', weight: 0.9 },
  { name: '张飞', weight: 0.6 },
  { name: '赵云', weight: 0.9 },
  { name: '周瑜', weight: 0.5 },
  { name: '鲁肃', weight: 0 },
  { name: '陆逊', weight: 0.6 },
  { name: '曹丕', weight: 0.5 },
  { name: '郭嘉', weight: 0.8 },
  { name: '荀彧', weight: 0.7 },
  { name: '姜维', weight: 0.8 }
]

// Web Audio API Sound generator
let audioCtx = null

function playTickSound() {
  if (!enableSound.value) return
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume()
    }
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.connect(gain)
    gain.connect(audioCtx.destination)
    
    osc.frequency.setValueAtTime(880, audioCtx.currentTime)
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.04)
    
    osc.start()
    osc.stop(audioCtx.currentTime + 0.04)
  } catch (e) {
    console.warn('Audio Context blocked')
  }
}

function playSuccessSound() {
  if (!enableSound.value) return
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume()
    }
    const osc1 = audioCtx.createOscillator()
    const osc2 = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    
    osc1.connect(gain)
    osc2.connect(gain)
    gain.connect(audioCtx.destination)
    
    osc1.frequency.setValueAtTime(523.25, audioCtx.currentTime) // C5
    osc1.frequency.setValueAtTime(659.25, audioCtx.currentTime + 0.1) // E5
    osc1.frequency.setValueAtTime(783.99, audioCtx.currentTime + 0.2) // G5
    
    osc2.frequency.setValueAtTime(261.63, audioCtx.currentTime) // C4
    osc2.frequency.setValueAtTime(329.63, audioCtx.currentTime + 0.1) // E4
    osc2.frequency.setValueAtTime(392.00, audioCtx.currentTime + 0.2) // G4
    
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4)
    
    osc1.start()
    osc2.start()
    osc1.stop(audioCtx.currentTime + 0.4)
    osc2.stop(audioCtx.currentTime + 0.4)
  } catch (e) {
    console.warn('Audio Context blocked')
  }
}

// Speech Synthesis TTS
function speakNames(names) {
  if (!enableTTS.value) return
  try {
    const text = `被抽中的是：${names.join('，')}`
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'zh-CN'
    window.speechSynthesis.speak(utterance)
  } catch (e) {
    console.warn('Speech synthesis failed')
  }
}

// Load SheetJS from CDN
const loadSheetJS = () => {
  return new Promise((resolve, reject) => {
    if (window.XLSX) return resolve(window.XLSX)
    const script = document.createElement('script')
    script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'
    script.onload = () => resolve(window.XLSX)
    script.onerror = reject
    document.head.appendChild(script)
  })
}

// Local Storage operations
function saveToStorage() {
  localStorage.setItem('lcyksp_roll_call_names', JSON.stringify(namesList.value))
}

function loadFromStorage() {
  const stored = localStorage.getItem('lcyksp_roll_call_names')
  if (stored) {
    try {
      namesList.value = JSON.parse(stored)
    } catch {
      namesList.value = []
    }
  } else {
    namesList.value = []
  }
}

// List manipulations
function addName() {
  const trimName = newName.value.trim()
  if (!trimName) {
    ElMessage.warning('请输入姓名！')
    return
  }
  if (namesList.value.some(item => item.name === trimName)) {
    ElMessage.warning('姓名已存在于名单中！')
    return
  }
  
  namesList.value.push({
    name: trimName,
    weight: newWeight.value
  })
  
  newName.value = ''
  newWeight.value = 0.5
  saveToStorage()
  ElMessage.success(`添加“${trimName}”成功`)
}

function deleteName(index) {
  const item = namesList.value[index]
  namesList.value.splice(index, 1)
  saveToStorage()
  ElMessage.info(`已移除“${item.name}”`)
}

function clearList() {
  ElMessageBox.confirm('确定要清空当前名单吗？此操作不可逆。', '温馨提示', {
    confirmButtonText: '确定清空',
    cancelButtonText: '取消',
    type: 'warning'
  }).then(() => {
    namesList.value = []
    saveToStorage()
    ElMessage.success('名单已清空')
  }).catch(() => {})
}

// loadSample removed

// Download Template
function downloadTemplate() {
  const csvContent = "data:text/csv;charset=utf-8,\uFEFF" // UTF-8 BOM
    + "姓名,权重\n"
    + "张三,0.5\n"
    + "李四,1\n"
    + "王五,0\n"
    + "赵六,0.8\n"
    + "孙七,0.3\n"
  
  const encodedUri = encodeURI(csvContent)
  const link = document.createElement("a")
  link.setAttribute("href", encodedUri)
  link.setAttribute("download", "名单导入模板.csv")
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  ElMessage.success('模板下载成功！可直接用Excel编辑并保存')
}

// Parse Excel / CSV File
async function handleExcelImport(file) {
  xlsxLoading.value = true
  try {
    const XLSX = await loadSheetJS()
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result)
        const workbook = XLSX.read(data, { type: 'array' })
        const firstSheetName = workbook.SheetNames[0]
        const worksheet = workbook.Sheets[firstSheetName]
        const jsonData = XLSX.utils.sheet_to_json(worksheet)
        
        const importedList = jsonData.map(row => {
          const name = String(row['姓名'] || row['name'] || '').trim()
          let weight = parseFloat(row['权重'] || row['weight'])
          if (isNaN(weight)) weight = 0.5
          // Clamp weight between 0 and 1
          weight = Math.max(0, Math.min(1, weight))
          return { name, weight }
        }).filter(item => item.name)
        
        if (importedList.length === 0) {
          ElMessage.warning('未能从文件中解析到有效的名单记录。请确保包含首列名为“姓名”的列。')
          return
        }
        
        namesList.value = importedList
        saveToStorage()
        ElMessage.success(`导入成功！解析到 ${importedList.length} 个记录。`)
      } catch (err) {
        console.error(err)
        ElMessage.error('读取表格文件数据失败！')
      } finally {
        xlsxLoading.value = false
      }
    }
    reader.readAsArrayBuffer(file.raw || file)
  } catch (err) {
    console.error(err)
    xlsxLoading.value = false
    ElMessage.error('无法加载 Excel 解析引擎，请检查网络！')
  }
}

// Filter Active Names (Weight > 0)
const activeNames = computed(() => {
  return namesList.value.filter(item => item.weight > 0)
})

// Weighted Random Selection (A-Res Algorithm)
// Select K items from candidates list
function drawWeightedRandom(candidates, count) {
  const K = count
  if (candidates.length <= K) {
    return [...candidates].map(c => c.name)
  }

  // 1. Separate must-draw (weight = 1) and regular (0 < weight < 1)
  const mustDraw = candidates.filter(c => c.weight === 1)
  const regular = candidates.filter(c => c.weight > 0 && c.weight < 1)

  if (mustDraw.length >= K) {
    // Shuffle mustDraw and pick first K
    const shuffledMust = [...mustDraw].sort(() => Math.random() - 0.5)
    return shuffledMust.slice(0, K).map(c => c.name)
  }

  // If mustDraw.length < K
  const winners = mustDraw.map(c => c.name)
  const needed = K - mustDraw.length

  // Apply A-Res Algorithm to regular list to fill remaining spots
  // A-Res calculates score = rand() ^ (1 / weight)
  // Higher weight gets a higher average score
  const scoredList = regular.map(c => {
    const score = Math.pow(Math.random(), 1 / c.weight)
    return { name: c.name, score }
  })

  // Sort descending
  scoredList.sort((a, b) => b.score - a.score)

  // Append top 'needed' winners
  for (let i = 0; i < needed; i++) {
    winners.push(scoredList[i].name)
  }

  return winners
}

// Roll Call execution
function startRollCall() {
  if (activeNames.value.length === 0) {
    ElMessage.warning('名单中没有可抽取的候选人（权重全部为0或名单为空）！')
    return
  }
  if (drawCount.value > activeNames.value.length) {
    ElMessage.warning(`抽取数量 (${drawCount.value}) 不能超过活跃候选人数 (${activeNames.value.length})！`)
    return
  }

  isRolling.value = true
  lastDrawResults.value = []

  let timerCounter = 0
  const totalSteps = 25
  const activeList = activeNames.value

  const rollInterval = setInterval(() => {
    // Just display random active names on the screen rapidly
    const randomIndex = Math.floor(Math.random() * activeList.length)
    rollingName.value = activeList[randomIndex].name
    playTickSound()
    timerCounter++

    if (timerCounter >= totalSteps) {
      clearInterval(rollInterval)
      
      // Perform actual weighted math selection
      const winners = drawWeightedRandom(activeList, drawCount.value)
      
      lastDrawResults.value = winners
      rollingName.value = winners.join(' 、 ')
      isRolling.value = false
      
      // Chime and TTS
      playSuccessSound()
      speakNames(winners)
      
      // Log history
      drawHistory.value.unshift({
        time: new Date().toLocaleTimeString(),
        names: winners
      })
    }
  }, 90)
}

function clearHistory() {
  drawHistory.value = []
}

// Grouping logic
const groupNames = [
  '破风者队', '追光之翼', '极速风暴', '干饭人队', '深海蛟龙', 
  '星际漫步', '雷神之怒', '终极野狼', '咸鱼翻身', '智多星队', 
  '黄金巨龙', '极寒冰川', '火焰战歌', '巅峰荣耀', '筑梦启航'
]

const groupColors = [
  'linear-gradient(135deg, #FF6B6B 0%, #FF8E53 100%)', // Red/Orange
  'linear-gradient(135deg, #4E65FF 0%, #92EFFD 100%)', // Blue/Aqua
  'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)', // Green
  'linear-gradient(135deg, #7F00FF 0%, #E100FF 100%)', // Purple
  'linear-gradient(135deg, #F9D423 0%, #FF4E50 100%)', // Gold/Red
  'linear-gradient(135deg, #3a7bd5 0%, #3a6073 100%)', // Slate Blue
  'linear-gradient(135deg, #8A2387 0%, #E94057 100%)', // Berry
  'linear-gradient(135deg, #00B4DB 0%, #0083B0 100%)', // Sky Blue
  'linear-gradient(135deg, #f12711 0%, #f5aff3 100%)'
]

function shuffleArray(arr) {
  const newArr = [...arr]
  for (let i = newArr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArr[i], newArr[j]] = [newArr[j], newArr[i]]
  }
  return newArr
}

function runGrouping() {
  const list = activeNames.value
  if (list.length === 0) {
    ElMessage.warning('参与分组的名单为空，请先添加候选人！')
    return
  }

  // Shuffle list to randomize
  const shuffled = shuffleArray(list)
  const N = shuffled.length
  let numGroups = 0
  
  if (groupMode.value === 'count') {
    // target = number of groups
    numGroups = parseInt(groupTargetValue.value)
    if (isNaN(numGroups) || numGroups <= 0) {
      ElMessage.warning('请输入合理的分组组数！')
      return
    }
    numGroups = Math.min(N, numGroups)
  } else {
    // target = size per group
    const groupSize = parseInt(groupTargetValue.value)
    if (isNaN(groupSize) || groupSize <= 0) {
      ElMessage.warning('请输入合理的小组人数！')
      return
    }
    numGroups = Math.ceil(N / groupSize)
  }

  // Initialize groups
  const groups = []
  for (let i = 0; i < numGroups; i++) {
    groups.push({
      id: i + 1,
      name: groupNames[i % groupNames.length] + ` (${i + 1}组)`,
      color: groupColors[i % groupColors.length],
      members: []
    })
  }

  // Distribute members one by one in round robin to keep groups balanced
  shuffled.forEach((item, index) => {
    const targetGroupIndex = index % numGroups
    groups[targetGroupIndex].members.push(item.name)
  })

  // Set results
  groupingResults.value = groups
  ElMessage.success('随机分组运算成功')
}

// Copy Grouping to Clipboard
function copyGroupingToClipboard() {
  if (groupingResults.value.length === 0) return
  
  let txt = `📋 随机分组方案结果：\n\n`
  groupingResults.value.forEach(g => {
    txt += `【${g.name}】(${g.members.length}人):\n${g.members.join('、')}\n\n`
  })
  
  navigator.clipboard.writeText(txt).then(() => {
    ElMessage.success('已将分组结果复制到剪贴板！')
  }).catch(() => {
    ElMessage.error('复制失败，请手动选取文本复制。')
  })
}

function generateRandomNumbers() {
  const minVal = numMin.value === '' ? -999999 : parseInt(numMin.value)
  const maxVal = numMax.value === '' ? 999999 : parseInt(numMax.value)
  
  if (isNaN(minVal) || isNaN(maxVal)) {
    ElMessage.warning('请输入有效的整数区间！')
    return
  }
  
  if (maxVal < minVal) {
    ElMessage.warning('最大值不能小于最小值！')
    return
  }
  
  const count = numQty.value
  if (count <= 0) {
    ElMessage.warning('生成数量必须大于 0！')
    return
  }
  
  if (!allowRepeat.value && (maxVal - minVal + 1) < count) {
    ElMessage.warning('在指定区间内无法生成足够数量的不重复随机数！')
    return
  }
  
  isRollingNum.value = true
  lastNumResults.value = []
  
  let counter = 0
  const steps = 20
  
  const interval = setInterval(() => {
    if (count === 1) {
      rollingNumResult.value = String(getRandomInt(minVal, maxVal))
    } else {
      const temp = []
      for (let i = 0; i < Math.min(5, count); i++) {
        temp.push(getRandomInt(minVal, maxVal))
      }
      if (count > 5) temp.push('...')
      rollingNumResult.value = temp.join(' 、 ')
    }
    playTickSound()
    counter++
    
    if (counter >= steps) {
      clearInterval(interval)
      
      const results = []
      if (allowRepeat.value) {
        for (let i = 0; i < count; i++) {
          results.push(getRandomInt(minVal, maxVal))
        }
      } else {
        const set = new Set()
        if (maxVal - minVal < 1000) {
          const pool = []
          for (let i = minVal; i <= maxVal; i++) {
            pool.push(i)
          }
          const shuffled = shuffleArray(pool)
          for (let i = 0; i < count; i++) {
            results.push(shuffled[i])
          }
        } else {
          while (set.size < count) {
            set.add(getRandomInt(minVal, maxVal))
          }
          results.push(...Array.from(set))
        }
      }
      
      lastNumResults.value = results
      rollingNumResult.value = results.join(' 、 ')
      isRollingNum.value = false
      
      playSuccessSound()
      
      if (enableTTS.value) {
        const text = `生成的随机数是：${results.join('，')}`
        const utterance = new SpeechSynthesisUtterance(text)
        utterance.lang = 'zh-CN'
        window.speechSynthesis.speak(utterance)
      }
      
      numHistory.value.unshift({
        time: new Date().toLocaleTimeString(),
        numbers: results
      })
    }
  }, 90)
}

function getRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function clearNumHistory() {
  numHistory.value = []
}

// Coin Flip States
const isFlippingCoin = ref(false)
const coinResult = ref('front')
const coinResultShow = ref('')
const coinHistory = ref([])

function flipCoin() {
  if (isFlippingCoin.value) return
  isFlippingCoin.value = true
  coinResultShow.value = ''
  
  const isFront = Math.random() < 0.5
  
  if (enableSound.value) {
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)()
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume()
      }
      const osc = audioCtx.createOscillator()
      const gain = audioCtx.createGain()
      osc.connect(gain)
      gain.connect(audioCtx.destination)
      osc.frequency.setValueAtTime(987.77, audioCtx.currentTime)
      osc.frequency.exponentialRampToValueAtTime(1975.53, audioCtx.currentTime + 0.1)
      osc.frequency.exponentialRampToValueAtTime(1318.51, audioCtx.currentTime + 0.6)
      gain.gain.setValueAtTime(0.1, audioCtx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.7)
      osc.start()
      osc.stop(audioCtx.currentTime + 0.7)
    } catch (e) {
      console.warn('Audio Context blocked')
    }
  }

  setTimeout(() => {
    coinResult.value = isFront ? 'front' : 'back'
    coinResultShow.value = isFront ? 'front' : 'back'
    isFlippingCoin.value = false
    
    playSuccessSound()
    
    if (enableTTS.value) {
      try {
        const text = `抛硬币结果是：${isFront ? '正面' : '反面'}`
        const utterance = new SpeechSynthesisUtterance(text)
        utterance.lang = 'zh-CN'
        window.speechSynthesis.speak(utterance)
      } catch (e) {
        console.warn('Speech synthesis failed')
      }
    }
    
    const now = new Date()
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
    coinHistory.value.unshift({
      time: timeStr,
      result: isFront ? 'front' : 'back'
    })
  }, 1200)
}

function clearCoinHistory() {
  coinHistory.value = []
}

// Load List on mount
onMounted(() => {
  loadFromStorage()
})

watch(namesList, () => {
  saveToStorage()
}, { deep: true })
</script>

<template>
  <div class="roll-call-view">
    <div class="page-header">
      <h2 class="page-title"><span class="title-icon">🎯</span> 随机小助手</h2>
      <p class="page-desc">支持加权随机概率的点名与分组，以及自定义范围的随机整数生成。配备炫酷跑马灯滚动、语音播报及 Excel 导入功能。</p>
    </div>

    <el-tabs v-model="activeTab" type="card" class="theme-tabs">
      
      <!-- ================== TAB 1: 随机点名 ================== -->
      <el-tab-pane label="随机点名抽签" name="roll-call">
        <el-row :gutter="20" class="layout-row">
          
          <!-- 抽取操控台 -->
          <el-col :xs="24" :md="15" class="picker-main">
            <div class="lucky-board theme-surface">
              <div class="board-header">
                <span class="board-tag">LUCKY ROLLING</span>
                <div class="sound-toggles">
                  <el-button 
                    :type="enableTTS ? 'primary' : 'default'" 
                    size="small" 
                    circle 
                    :icon="Microphone" 
                    title="语音合成播报"
                    @click="enableTTS = !enableTTS"
                  />
                  <el-button 
                    :type="enableSound ? 'success' : 'default'" 
                    size="small" 
                    circle 
                    :icon="Cpu" 
                    title="模拟音效"
                    @click="enableSound = !enableSound"
                  />
                </div>
              </div>

              <!-- 滚动大字区 -->
              <div class="name-display-box" :class="{ rolling: isRolling }">
                <span class="rolling-name-text">{{ rollingName }}</span>
              </div>

              <div class="drawing-config-row">
                <div class="config-cell">
                  <span class="label">单次抽取人数：</span>
                  <el-input-number 
                    v-model="drawCount" 
                    :min="1" 
                    :max="Math.max(1, activeNames.length)" 
                    size="default" 
                    class="number-input"
                  />
                </div>
                <div class="stats-text">
                  ( 活跃候选人: <strong class="color-blue">{{ activeNames.length }}</strong> 人 )
                </div>
              </div>

              <!-- 操作按钮 -->
              <div class="button-cell">
                <el-button 
                  type="primary" 
                  size="large" 
                  class="action-draw-btn"
                  :loading="isRolling"
                  :icon="VideoPlay"
                  @click="startRollCall"
                >
                  {{ isRolling ? '正在拼命挑选...' : '开始随机点名' }}
                </el-button>
              </div>
            </div>
          </el-col>

          <!-- 历史记录面板 -->
          <el-col :xs="24" :md="9" class="picker-side">
            <div class="history-card theme-surface">
              <div class="card-head-row">
                <h3 class="side-title">抽取历史记录</h3>
                <el-button 
                  v-if="drawHistory.length > 0"
                  type="text" 
                  :icon="Delete" 
                  class="clear-history-btn"
                  @click="clearHistory"
                >
                  清空
                </el-button>
              </div>
              
              <div class="history-list-container">
                <div v-if="drawHistory.length === 0" class="empty-history">
                  <span class="empty-icon">📊</span>
                  <p>暂无抽签历史记录</p>
                </div>
                <div v-else class="history-items">
                  <div 
                    v-for="(log, idx) in drawHistory" 
                    :key="idx" 
                    class="history-item"
                  >
                    <span class="time-label">{{ log.time }}</span>
                    <div class="names-tags">
                      <el-tag 
                        v-for="name in log.names" 
                        :key="name" 
                        size="small" 
                        type="success"
                        class="history-name-tag"
                      >
                        {{ name }}
                      </el-tag>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </el-col>
        </el-row>
      </el-tab-pane>

      <!-- ================== TAB 2: 随机分组 ================== -->
      <el-tab-pane label="智能一键分组" name="grouping">
        <div class="group-control-card theme-surface">
          <h3 class="section-title">分组配置控制台</h3>
          
          <div class="grouping-options-wrap">
            <div class="option-item">
              <span class="ctrl-label">分组策略：</span>
              <el-radio-group v-model="groupMode" size="default">
                <el-radio-button value="count">按总组数</el-radio-button>
                <el-radio-button value="size">按每组人数</el-radio-button>
              </el-radio-group>
            </div>
            
            <div class="option-item">
              <span class="ctrl-label">
                {{ groupMode === 'count' ? '划分的组数：' : '每组目标人数：' }}
              </span>
              <el-input-number 
                v-model="groupTargetValue" 
                :min="1" 
                :max="Math.max(1, activeNames.length)"
                size="default"
              />
            </div>
            
            <div class="action-buttons-wrap">
              <el-button 
                type="primary" 
                size="default" 
                :icon="Cpu"
                @click="runGrouping"
              >
                立即开始随机分组
              </el-button>
              <el-button 
                v-if="groupingResults.length > 0"
                type="success" 
                size="default" 
                :icon="Share"
                @click="copyGroupingToClipboard"
              >
                复制分组方案
              </el-button>
            </div>
          </div>
        </div>

        <!-- 分组结果展示网格 -->
        <div class="grouping-results-section" v-if="groupingResults.length > 0">
          <el-row :gutter="16">
            <el-col 
              v-for="group in groupingResults" 
              :key="group.id" 
              :xs="24" :sm="12" :md="8" :lg="6"
              class="group-card-col"
            >
              <div class="group-result-card theme-surface">
                <div class="group-card-header" :style="{ background: group.color }">
                  <h4>{{ group.name }}</h4>
                  <span class="badge">{{ group.members.length }}人</span>
                </div>
                <div class="group-card-body">
                  <div class="group-members-list">
                    <span 
                      v-for="mem in group.members" 
                      :key="mem" 
                      class="member-badge-pill"
                    >
                      👤 {{ mem }}
                    </span>
                  </div>
                </div>
              </div>
            </el-col>
          </el-row>
        </div>
        
        <div v-else class="empty-grouping theme-surface">
          <span class="empty-state-icon">👥</span>
          <p>请在上方配置分组策略，然后点击按钮生成分组结果</p>
        </div>
      </el-tab-pane>

      <!-- ================== TAB 3: 名单管理 ================== -->
      <el-tab-pane label="名单库管理" name="list-management">
        <el-row :gutter="20" class="layout-row">
          
          <!-- 左侧名单录入 & 导入 -->
          <el-col :xs="24" :md="10">
            <div class="col-wrap">
              <!-- 手动录入 -->
              <div class="ctrl-card theme-surface mb-20">
                <h3 class="section-title">手动新增录入</h3>
                <div class="add-form">
                  <div class="form-row">
                    <span class="sub-label">姓名：</span>
                    <el-input 
                      v-model="newName" 
                      placeholder="请输入名字" 
                      clearable
                      @keyup.enter="addName"
                    />
                  </div>
                  <div class="form-row mt-10">
                    <span class="sub-label">抽取权重 ({{ newWeight }})：</span>
                    <el-slider 
                      v-model="newWeight" 
                      :min="0" 
                      :max="1" 
                      :step="0.1" 
                      show-stops
                    />
                  </div>
                  <p class="weight-help-tip">💡 权重说明: <strong>0</strong> 绝对抽不到; <strong>1</strong> 属于必中组优先选中; 其他数值为常规抽取概率。</p>
                  <el-button 
                    type="primary" 
                    class="w-100 mt-10" 
                    :icon="Collection"
                    @click="addName"
                  >
                    录入到当前名单
                  </el-button>
                </div>
              </div>

              <!-- Excel 批量导入 -->
              <div class="ctrl-card theme-surface" v-loading="xlsxLoading">
                <h3 class="section-title">Excel 批量导入</h3>
                <div class="import-wrap">
                  <el-upload
                    class="upload-excel-area"
                    drag
                    action="#"
                    :auto-upload="false"
                    :show-file-list="false"
                    :on-change="handleExcelImport"
                  >
                    <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
                    <div class="el-upload__text">
                      将名单 Excel 拖到此处，或 <em>点击上传</em>
                    </div>
                  </el-upload>
                  
                  <div class="import-help-actions">
                    <el-button 
                      size="small" 
                      type="info" 
                      :icon="Download"
                      @click="downloadTemplate"
                    >
                      下载 Excel 导入模板
                    </el-button>
                    <el-button 
                      size="small" 
                      type="default" 
                      :icon="Help"
                      @click="tutorialVisible = true"
                    >
                      使用教程
                    </el-button>
                  </div>
                </div>
              </div>
            </div>
          </el-col>

          <!-- 右侧当前名单列表 -->
          <el-col :xs="24" :md="14">
            <div class="names-list-table-card theme-surface">
              <div class="table-head">
                <h3 class="section-title">当前名单名册 ({{ namesList.length }}人)</h3>
                <el-button 
                  v-if="namesList.length > 0"
                  type="danger" 
                  size="small" 
                  :icon="Delete"
                  @click="clearList"
                >
                  清空名单
                </el-button>
              </div>

              <div class="table-container">
                <el-table :data="namesList" max-height="460" border class="dark-table w-100">
                  <el-table-column type="index" label="序号" width="60" align="center" />
                  <el-table-column prop="name" label="姓名" align="center" />
                  <el-table-column label="抽取权重" width="180" align="center">
                    <template #default="scope">
                      <el-slider 
                        v-model="scope.row.weight" 
                        :min="0" 
                        :max="1" 
                        :step="0.1" 
                        size="small"
                        @change="saveToStorage"
                      />
                    </template>
                  </el-table-column>
                  <el-table-column label="权重状态" width="100" align="center">
                    <template #default="scope">
                      <el-tag v-if="scope.row.weight === 0" type="danger" size="small">排除</el-tag>
                      <el-tag v-else-if="scope.row.weight === 1" type="warning" size="small">必中</el-tag>
                      <el-tag v-else type="primary" size="small">{{ scope.row.weight }}</el-tag>
                    </template>
                  </el-table-column>
                  <el-table-column label="操作" width="90" align="center">
                    <template #default="scope">
                      <el-button 
                        type="danger" 
                        size="small" 
                        :icon="Delete" 
                        circle 
                        @click="deleteName(scope.$index)"
                      />
                    </template>
                  </el-table-column>
                </el-table>
              </div>
            </div>
          </el-col>
        </el-row>
      </el-tab-pane>

      <!-- ================== TAB 3: 随机数生成 ================== -->
      <el-tab-pane label="随机数生成" name="random-number">
        <el-row :gutter="20" class="layout-row">
          
          <!-- 生成控制台 -->
          <el-col :xs="24" :md="15">
            <div class="lucky-board theme-surface">
              <div class="board-header">
                <span class="board-tag">RANDOM NUMBER GENERATOR</span>
              </div>

              <!-- 滚动大字区 -->
              <div class="name-display-box" :class="{ rolling: isRollingNum }">
                <span class="rolling-name-text">{{ rollingNumResult }}</span>
              </div>

              <div class="num-config-grid">
                <div class="num-config-row">
                  <div class="config-cell">
                    <span class="label">最小值 (Min)：</span>
                    <el-input 
                      v-model="numMin" 
                      placeholder="负无穷" 
                      type="number" 
                      class="num-range-input"
                    />
                  </div>
                  <div class="config-cell">
                    <span class="label">最大值 (Max)：</span>
                    <el-input 
                      v-model="numMax" 
                      placeholder="正无穷" 
                      type="number" 
                      class="num-range-input"
                    />
                  </div>
                </div>

                <div class="num-config-row mt-10">
                  <div class="config-cell">
                    <span class="label">生成数量：</span>
                    <el-input-number 
                      v-model="numQty" 
                      :min="1" 
                      :max="1000" 
                      size="default" 
                    />
                  </div>
                  <div class="config-cell">
                    <span class="label">允许重复：</span>
                    <el-switch v-model="allowRepeat" />
                  </div>
                </div>
              </div>

              <!-- 操作按钮 -->
              <div class="button-cell">
                <el-button 
                  type="primary" 
                  size="large" 
                  class="action-draw-btn"
                  :loading="isRollingNum"
                  :icon="VideoPlay"
                  @click="generateRandomNumbers"
                >
                  {{ isRollingNum ? '正在努力计算...' : '开始生成随机数' }}
                </el-button>
              </div>
            </div>
          </el-col>

          <!-- 历史记录面板 -->
          <el-col :xs="24" :md="9">
            <div class="history-card theme-surface">
              <div class="card-head-row">
                <h3 class="side-title">生成历史记录</h3>
                <el-button 
                  v-if="numHistory.length > 0"
                  type="text" 
                  :icon="Delete" 
                  class="clear-history-btn"
                  @click="clearNumHistory"
                >
                  清空
                </el-button>
              </div>
              
              <div class="history-list-container">
                <div v-if="numHistory.length === 0" class="empty-history">
                  <span class="empty-icon">🔢</span>
                  <p>暂无生成历史记录</p>
                </div>
                <div v-else class="history-items">
                  <div 
                    v-for="(log, idx) in numHistory" 
                    :key="idx" 
                    class="history-item"
                  >
                    <span class="time-label">{{ log.time }}</span>
                    <div class="names-tags">
                      <el-tag 
                        v-for="num in log.numbers" 
                        :key="num" 
                        size="small" 
                        type="info"
                        class="history-name-tag"
                      >
                        {{ num }}
                      </el-tag>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </el-col>
        </el-row>
      </el-tab-pane>

      <!-- ================== TAB 5: 自助抛硬币 ================== -->
      <el-tab-pane label="自助抛硬币" name="coin-flip">
        <el-row :gutter="20" class="layout-row">
          <el-col :xs="24" :md="15">
            <div class="lucky-board theme-surface">
              <div class="board-header">
                <span class="board-tag">COIN FLIP</span>
                <div class="sound-toggles">
                  <el-button 
                    :type="enableTTS ? 'primary' : 'default'" 
                    size="small" 
                    circle 
                    :icon="Microphone" 
                    title="语音合成播报"
                    @click="enableTTS = !enableTTS"
                  />
                  <el-button 
                    :type="enableSound ? 'success' : 'default'" 
                    size="small" 
                    circle 
                    :icon="Cpu" 
                    title="模拟音效"
                    @click="enableSound = !enableSound"
                  />
                </div>
              </div>

              <!-- 3D/滚动硬币展示区 -->
              <div class="coin-display-area">
                <div class="coin-wrapper" :class="{ 'is-flipping': isFlippingCoin }">
                  <div class="coin" :class="coinResult">
                    <div class="coin-front">🪙<div class="coin-label">正</div></div>
                    <div class="coin-back">🪙<div class="coin-label">反</div></div>
                  </div>
                </div>
                <div class="coin-result-text" v-if="coinResultShow">
                  结果：<span class="highlight-result">{{ coinResultShow === 'front' ? '正面 (Heads)' : '反面 (Tails)' }}</span>
                </div>
              </div>

              <!-- 操作按钮 -->
              <div class="button-cell">
                <el-button 
                  type="primary" 
                  size="large" 
                  class="action-draw-btn"
                  :loading="isFlippingCoin"
                  :icon="Refresh"
                  @click="flipCoin"
                >
                  {{ isFlippingCoin ? '正在抛掷...' : '开始抛硬币' }}
                </el-button>
              </div>
            </div>
          </el-col>

          <!-- 历史记录面板 -->
          <el-col :xs="24" :md="9">
            <div class="history-card theme-surface">
              <div class="card-head-row">
                <h3 class="side-title">抛硬币历史记录</h3>
                <el-button 
                  v-if="coinHistory.length > 0"
                  type="text" 
                  :icon="Delete" 
                  class="clear-history-btn"
                  @click="clearCoinHistory"
                >
                  清空
                </el-button>
              </div>
              
              <div class="history-list-container">
                <div v-if="coinHistory.length === 0" class="empty-history">
                  <span class="empty-icon">🪙</span>
                  <p>暂无抛掷历史记录</p>
                </div>
                <div v-else class="history-items">
                  <div 
                    v-for="(log, idx) in coinHistory" 
                    :key="idx" 
                    class="history-item"
                  >
                    <span class="time-label">{{ log.time }}</span>
                    <div class="names-tags">
                      <el-tag 
                        size="small" 
                        :type="log.result === 'front' ? 'success' : 'warning'"
                        class="history-name-tag"
                      >
                        {{ log.result === 'front' ? '正面 (Heads)' : '反面 (Tails)' }}
                      </el-tag>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </el-col>
        </el-row>
      </el-tab-pane>

    </el-tabs>

    <!-- 使用教程弹窗 -->
    <el-dialog
      v-model="tutorialVisible"
      title="📖 随机小助手使用教程"
      width="600px"
      destroy-on-close
      class="tutorial-dialog"
    >
      <div class="tutorial-content">
        <h4 class="tut-h4">1. 名单库管理</h4>
        <ul class="tut-ul">
          <li><strong>手动录入</strong>：在“名单库管理”标签页中输入名字并设定权重，点击“录入到当前名单”即可。</li>
          <li><strong>抽取权重说明</strong>：
            <ul class="tut-sub-ul">
              <li><strong>0</strong>：彻底排除，点名和随机分组时都<strong>不会</strong>被选到。</li>
              <li><strong>1</strong>：必中属性，在点名时只要抽签名额充足，必中者会被<strong>优先</strong>抽中。</li>
              <li><strong>0.1 - 0.9</strong>：普通概率，数值越大被抽到的相对概率越高。</li>
            </ul>
          </li>
          <li><strong>Excel 批量导入</strong>：下载 Excel 导入模板，填入“姓名”与“权重”两列，拖拽或上传该文件即可一键导入名册。</li>
        </ul>

        <h4 class="tut-h4">2. 随机点名抽签</h4>
        <ul class="tut-ul">
          <li>设定单次抽取的名额数量（最大不超过活跃名单总人数）。</li>
          <li>可自由开启/关闭<strong>语音读名 (TTS)</strong> 和<strong>跑马灯抽签音效</strong>。</li>
          <li>点击“开始随机点名”即可开启大字闪烁滚动动画，定格揭晓。</li>
          <li>右侧会记录历次抽签历史，支持一键清除。</li>
        </ul>

        <h4 class="tut-h4">3. 智能分组功能</h4>
        <ul class="tut-ul">
          <li>选择分组模式：<strong>“按总组数”</strong>（例如指定分成 4 个组）或<strong>“按每组人数”</strong>（例如指定 3 人一组）。</li>
          <li>分组算法会自动进行均衡分发，各小组人数差最多为 1 人。</li>
          <li>分组生成后，会自动分配随机炫酷的小组名称（如雷霆队、咸鱼翻身队等）与精美卡片。</li>
          <li>点击“复制分组方案”可以一键打包复制文本，方便转发到微信或群聊中。</li>
        </ul>

        <h4 class="tut-h4">4. 随机数生成</h4>
        <ul class="tut-ul">
          <li>输入生成区间的最小值和最大值，默认留空代表生成很大区间的数字（默认范围极值为 -999999 到 999999）。</li>
          <li>支持设定单次生成的数量（支持 1 到 1000 个数字）。</li>
          <li>可自由勾选“允许重复”开关。如果不允许重复且生成数量超过区间大小，系统会自动警告拦截。</li>
        </ul>
      </div>
      <template #footer>
        <div class="dialog-footer">
          <el-button type="primary" @click="tutorialVisible = false">我知道了</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.roll-call-view {
  max-width: 1200px;
  margin: 0 auto;
  padding: 20px 16px 40px;
}

.num-config-grid {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 10px 0;
}

.num-config-row {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
}

.num-range-input {
  width: 140px;
}

.tutorial-content {
  color: var(--text-secondary);
  line-height: 1.6;
}

.tut-h4 {
  color: var(--text-heading);
  margin: 16px 0 8px;
  font-size: 1rem;
  font-weight: 600;
  border-left: 3px solid var(--accent-blue);
  padding-left: 8px;
}

.tut-ul {
  padding-left: 20px;
  margin: 0 0 12px;
}

.tut-sub-ul {
  padding-left: 20px;
  margin: 4px 0;
  list-style-type: circle;
}

.tutorial-content li {
  margin-bottom: 6px;
  font-size: 0.88rem;
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

.theme-tabs {
  margin-top: 15px;
}

.layout-row {
  margin-bottom: 20px;
}

.w-100 { width: 100%; }
.mt-10 { margin-top: 10px; }
.mb-20 { margin-bottom: 20px; }
.color-blue { color: var(--accent-blue); }

/* ======================================================= */
/* Tab 1: Lucky Draw Panel */
/* ======================================================= */
.lucky-board {
  border: 1px solid var(--border-color);
  border-radius: 16px;
  padding: 24px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 20px;
  min-height: 420px;
  justify-content: space-between;
}

.board-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.board-tag {
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--accent-blue);
  letter-spacing: 1.5px;
  background: color-mix(in srgb, var(--accent-blue) 12%, transparent);
  padding: 4px 10px;
  border-radius: 99px;
  border: 1px solid color-mix(in srgb, var(--accent-blue) 30%, transparent);
}

.sound-toggles {
  display: flex;
  gap: 8px;
}

.name-display-box {
  flex: 1;
  background: var(--bg-canvas);
  border: 2px dashed var(--border-subtle);
  border-radius: 12px;
  min-height: 180px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  margin: 10px 0;
  transition: all 0.25s ease;
  overflow: hidden;
  box-shadow: inset 0 4px 15px rgba(0, 0, 0, 0.1);
}

.name-display-box.rolling {
  border-color: var(--accent-blue);
  box-shadow: 0 0 15px rgba(65, 134, 245, 0.15), inset 0 2px 10px rgba(65, 134, 245, 0.1);
}

.rolling-name-text {
  font-size: 2.8rem;
  font-weight: 600;
  color: var(--text-primary);
  text-align: center;
  text-shadow: 0 2px 10px rgba(0,0,0,0.1);
  word-break: break-all;
  line-height: 1.3;
}

.drawing-config-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}

.config-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.config-cell .label {
  font-size: 0.88rem;
  color: var(--text-secondary);
}

.stats-text {
  font-size: 0.82rem;
  color: var(--text-muted);
}

.button-cell {
  display: flex;
  justify-content: center;
}

.action-draw-btn {
  width: 100%;
  height: 52px;
  font-size: 1.1rem;
  border-radius: 12px;
  letter-spacing: 1px;
}

/* History Card */
.history-card {
  border: 1px solid var(--border-color);
  border-radius: 16px;
  padding: 24px;
  height: 100%;
  min-height: 420px;
  display: flex;
  flex-direction: column;
}

.card-head-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 15px;
  border-bottom: 1px solid var(--border-color);
  padding-bottom: 10px;
}

.side-title {
  font-size: 1rem;
  font-weight: 500;
  color: var(--text-heading);
  margin: 0;
}

.clear-history-btn {
  font-size: 0.85rem;
  color: var(--text-muted);
}

.clear-history-btn:hover {
  color: var(--accent-red);
}

.history-list-container {
  flex: 1;
  overflow-y: auto;
  padding-right: 4px;
  max-height: 330px;
}

.empty-history {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  height: 100%;
  padding-top: 60px;
}

.empty-history .empty-icon {
  font-size: 2.5rem;
  margin-bottom: 10px;
  opacity: 0.4;
}

.empty-history p {
  margin: 0;
  font-size: 0.85rem;
}

.history-items {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.history-item {
  background: var(--bg-ctrl);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.time-label {
  font-size: 0.7rem;
  color: var(--text-muted);
  font-family: monospace;
}

.names-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.history-name-tag {
  border-radius: 4px;
}

/* ======================================================= */
/* Tab 2: Grouping Panel */
/* ======================================================= */
.group-control-card {
  border: 1px solid var(--border-color);
  border-radius: 16px;
  padding: 24px;
  margin-bottom: 20px;
}

.section-title {
  margin: 0 0 15px;
  font-size: 1.1rem;
  font-weight: 500;
  color: var(--text-heading);
  border-left: 4px solid var(--accent-blue);
  padding-left: 10px;
  line-height: 1.2;
}

.grouping-options-wrap {
  display: flex;
  align-items: center;
  gap: 24px;
  flex-wrap: wrap;
}

.option-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ctrl-label {
  font-size: 0.88rem;
  color: var(--text-secondary);
  font-weight: 500;
}

.action-buttons-wrap {
  display: flex;
  gap: 10px;
  margin-left: auto;
}

.grouping-results-section {
  margin-top: 15px;
}

.group-card-col {
  margin-bottom: 16px;
}

.group-result-card {
  border: 1px solid var(--border-color);
  border-radius: 12px;
  overflow: hidden;
  height: 100%;
  box-shadow: 0 4px 15px rgba(0,0,0,0.08);
}

.group-card-header {
  padding: 12px 16px;
  color: #ffffff;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.group-card-header h4 {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
  letter-spacing: 0.5px;
}

.group-card-header .badge {
  background: rgba(255, 255, 255, 0.25);
  font-size: 0.72rem;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: bold;
}

.group-card-body {
  padding: 14px;
  min-height: 120px;
  background: var(--bg-card);
}

.group-members-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.member-badge-pill {
  font-size: 0.8rem;
  background: var(--bg-ctrl);
  border: 1px solid var(--border-subtle);
  color: var(--text-primary);
  padding: 4px 10px;
  border-radius: 20px;
  display: inline-flex;
  align-items: center;
}

.empty-grouping {
  border: 1px solid var(--border-color);
  border-radius: 16px;
  padding: 60px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  text-align: center;
}

.empty-state-icon {
  font-size: 3.5rem;
  margin-bottom: 12px;
  opacity: 0.35;
}

/* ======================================================= */
/* Tab 3: List Management */
/* ======================================================= */
.col-wrap {
  display: flex;
  flex-direction: column;
}

.ctrl-card {
  border: 1px solid var(--border-color);
  border-radius: 16px;
  padding: 20px;
}

.add-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.form-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sub-label {
  font-size: 0.82rem;
  color: var(--text-secondary);
  width: 90px;
  flex-shrink: 0;
}

.weight-help-tip {
  margin: 4px 0 0;
  font-size: 0.74rem;
  color: var(--text-muted);
  line-height: 1.35;
}

.import-wrap {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.upload-excel-area {
  width: 100%;
}

:deep(.el-upload-dragger) {
  background: var(--bg-ctrl);
  border: 1px dashed var(--border-color);
  border-radius: 12px;
  padding: 20px 10px;
}

.import-help-actions {
  display: flex;
  gap: 8px;
  justify-content: space-between;
  flex-wrap: wrap;
}

.import-help-actions .el-button {
  flex: 1;
  min-width: 140px;
}

/* Names list table side */
.names-list-table-card {
  border: 1px solid var(--border-color);
  border-radius: 16px;
  padding: 20px;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.table-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 15px;
}

.table-head .section-title {
  margin-bottom: 0;
}

.table-container {
  flex: 1;
}

/* Scoped dark-table adjustments */
:deep(.el-table) {
  --el-table-border-color: var(--border-color);
  --el-table-header-bg-color: var(--bg-ctrl);
  --el-table-tr-bg-color: var(--bg-card);
  background-color: transparent;
}

/* Mobile responsive media queries */
@media (max-width: 768px) {
  .roll-call-view {
    padding: 12px 10px 24px;
  }
  
  .lucky-board {
    min-height: 340px;
    padding: 16px;
  }
  
  .rolling-name-text {
    font-size: 2rem;
  }
  
  .history-card {
    margin-top: 16px;
    min-height: 280px;
    padding: 16px;
  }
  
  .grouping-options-wrap {
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
  }
  
  .action-buttons-wrap {
    margin-left: 0;
    width: 100%;
  }
  
  .action-buttons-wrap .el-button {
    flex: 1;
  }
  
  .group-control-card {
    padding: 16px;
  }
  
  .names-list-table-card {
    margin-top: 16px;
    padding: 16px;
  }
}

.coin-display-area {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  gap: 24px;
}

.coin-wrapper {
  perspective: 1000px;
  width: 120px;
  height: 120px;
}

.coin {
  width: 100%;
  height: 100%;
  position: relative;
  transform-style: preserve-3d;
  transition: transform 0.1s linear;
}

.coin-front, .coin-back {
  position: absolute;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  backface-visibility: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  font-size: 3.2rem;
  background: linear-gradient(135deg, #f7d070, #c48124);
  border: 4px solid #f2b03d;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.4);
  color: #fff;
}

.coin-back {
  transform: rotateY(180deg);
  background: linear-gradient(135deg, #c48124, #f7d070);
}

.coin-label {
  font-size: 0.95rem;
  font-weight: bold;
  color: #3e2704;
  margin-top: -8px;
  text-shadow: 0 1px 1px rgba(255, 255, 255, 0.6);
}

.coin-wrapper.is-flipping .coin {
  animation: flipAnimation 1.2s cubic-bezier(0.25, 1, 0.5, 1) forwards;
}

@keyframes flipAnimation {
  0% {
    transform: rotateY(0) translateY(0) scale(1);
  }
  50% {
    transform: rotateY(900deg) translateY(-120px) scale(1.15);
  }
  100% {
    transform: rotateY(1800deg) translateY(0) scale(1);
  }
}

.coin.front {
  transform: rotateY(0deg);
}

.coin.back {
  transform: rotateY(180deg);
}

.coin-result-text {
  font-size: 1.1rem;
  color: var(--text-primary);
  font-weight: 500;
}

.highlight-result {
  color: var(--accent-gold);
  font-weight: 700;
  font-size: 1.2rem;
}
</style>

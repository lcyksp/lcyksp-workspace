<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import axios from 'axios'
import {
  DAY_LABELS,
  buildGrid,
  findCurrent,
  findNext,
  fmtClock,
  humanDuration,
  parityOf,
  weekdayIndex,
} from '../utils/schedule.js'

const loaded = ref(false)
const error = ref('')
const schedule = ref(null)
const now = ref(new Date())

const current = computed(() => {
  if (!schedule.value) return null
  return findCurrent(schedule.value.courses, schedule.value.periods, schedule.value.semesterStart, now.value)
})

const next = computed(() => {
  if (!schedule.value) return null
  return findNext(schedule.value.courses, schedule.value.periods, schedule.value.semesterStart, now.value)
})

const nowPercent = computed(() => (current.value ? Math.min(100, current.value.progress * 100) : 0))

const todayIndex = computed(() => weekdayIndex(now.value))

const todayLabel = computed(() => {
  const d = now.value
  return `${DAY_LABELS[todayIndex.value - 1]} · ${d.getMonth() + 1} 月 ${d.getDate()} 日`
})

const gridInfo = computed(() => {
  if (!schedule.value) return { week: 0, grid: {} }
  return buildGrid(schedule.value.courses, schedule.value.periods, schedule.value.semesterStart, now.value)
})

// 本周是单周还是双周 —— 页头显示，也方便核对隔周课
const parityLabel = computed(() => parityOf(gridInfo.value.week))

const nextDayLabel = computed(() => {
  if (!next.value) return ''
  const d = now.value
  const probe = new Date(d.getFullYear(), d.getMonth(), d.getDate() + next.value.dayOffset)
  return DAY_LABELS[weekdayIndex(probe) - 1]
})

function cellAt(day, n) {
  return gridInfo.value.grid[day]?.[n] || { type: 'empty' }
}

function isCurrentCourse(course) {
  return Boolean(current.value) && current.value.course === course
}

// 每秒重算一次。页面隐藏时停表，避免后台空转。
let timer = null

function tick() {
  now.value = new Date()
}

function startTimer() {
  stopTimer()
  timer = setInterval(tick, 1000)
}

function stopTimer() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

function onVisibilityChange() {
  if (document.hidden) {
    stopTimer()
  } else {
    tick()
    startTimer()
  }
}

async function loadSchedule() {
  try {
    const res = await axios.get('/api/schedule')
    schedule.value = res.data
    error.value = ''
  } catch (e) {
    error.value = e?.response?.data?.error || '课程表加载失败，请稍后重试'
  } finally {
    loaded.value = true
  }
}

onMounted(async () => {
  await loadSchedule()
  tick()
  startTimer()
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
  stopTimer()
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<template>
  <div class="schedule-page">
    <header class="page-head">
      <div>
        <h1>课程表</h1>
        <p class="subtle">
          <template v-if="loaded">
            {{ todayLabel }} · 第 {{ gridInfo.week }} 教学周<template v-if="parityLabel">（{{ parityLabel }}）</template>
          </template>
          <template v-else>加载中…</template>
        </p>
      </div>
      <span class="tag">仅管理员可见</span>
    </header>

    <p v-if="error" class="error">{{ error }}</p>

    <template v-if="loaded && schedule">
      <section class="now-card" :class="{ idle: !current }">
        <div class="now-fill" :style="{ width: nowPercent + '%' }"></div>
        <div class="now-body">
          <template v-if="current">
            <div class="now-top">
              <span class="now-name">{{ current.course.name }}</span>
              <span class="now-state">进行中</span>
            </div>
            <div class="now-meta">
              {{ fmtClock(current.start) }} – {{ fmtClock(current.end) }}
              <template v-if="current.course.location"> · {{ current.course.location }}</template>
              <template v-if="current.course.teacher"> · {{ current.course.teacher }}</template>
            </div>
            <div class="now-foot">
              <span>已过 {{ humanDuration(current.elapsed) }} / 共 {{ humanDuration(current.total) }}</span>
              <span>{{ Math.round(nowPercent) }}%</span>
            </div>
          </template>
          <template v-else>
            <div class="now-top">
              <span class="now-name">当前没有课</span>
              <span class="now-state">{{ next ? '课间' : '空闲' }}</span>
            </div>
            <div v-if="next" class="now-meta">
              下一节 {{ next.course.name }} · {{ fmtClock(next.start) }} 开始<template v-if="next.dayOffset > 0">（{{ nextDayLabel }}）</template> · 还有 {{ humanDuration(next.startsIn) }}
            </div>
            <div v-else class="now-meta">接下来几天都没有排课</div>
          </template>
        </div>
      </section>

      <section class="grid-wrap">
        <table class="sched">
          <thead>
            <tr>
              <th class="c-period"></th>
              <th
                v-for="(label, i) in DAY_LABELS"
                :key="label"
                class="c-day"
                :class="{ today: i + 1 === todayIndex }"
              >
                {{ label }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in schedule.periods" :key="p.n" class="p-row">
              <th class="c-period">
                <span class="pn">{{ p.n }}</span>
                <span class="pt">{{ p.start }}–{{ p.end }}</span>
              </th>
              <template v-for="d in 7" :key="d">
                <td v-if="cellAt(d, p.n).type === 'empty'" class="c-empty"></td>
                <td
                  v-else-if="cellAt(d, p.n).type === 'start'"
                  :rowspan="cellAt(d, p.n).span"
                  class="c-course"
                  :class="{
                    current: isCurrentCourse(cellAt(d, p.n).course),
                    muted: !cellAt(d, p.n).active,
                  }"
                >
                  <span
                    v-if="isCurrentCourse(cellAt(d, p.n).course)"
                    class="cell-fill"
                    :style="{ width: nowPercent + '%' }"
                  ></span>
                  <span class="cell-body">
                    <span class="cell-name">{{ cellAt(d, p.n).course.name }}</span>
                    <span v-if="cellAt(d, p.n).course.location" class="cell-loc">
                      {{ cellAt(d, p.n).course.location }}
                    </span>
                  </span>
                </td>
              </template>
            </tr>
          </tbody>
        </table>
      </section>
    </template>
  </div>
</template>

<style scoped>
.schedule-page {
  padding: 24px 28px 56px;
  max-width: 1180px;
}

.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

.page-head h1 {
  margin: 0 0 6px;
  font-size: 20px;
  font-weight: 500;
  color: var(--text-heading);
}

.subtle {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.tag {
  flex: none;
  font-size: 12px;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  border-radius: 999px;
  padding: 3px 10px;
}

.error {
  margin: 0 0 16px;
  font-size: 13px;
  color: var(--accent-red);
}

/* ---------- 当前课卡片：进度用背景从左往右填 ---------- */
.now-card {
  position: relative;
  overflow: hidden;
  margin-bottom: 22px;
  padding: 16px 18px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  background: var(--bg-card);
}

.now-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 0;
  background: rgba(64, 158, 255, 0.18);
  transition: width 1s linear;
  pointer-events: none;
}

.now-body {
  position: relative;
}

.now-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
}

.now-name {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-heading);
}

.now-state {
  flex: none;
  font-size: 12px;
  color: var(--accent-blue);
}

.now-card.idle .now-state {
  color: var(--text-muted);
}

.now-meta {
  font-size: 12.5px;
  color: var(--text-secondary);
  margin-bottom: 10px;
}

.now-foot {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-muted);
}

.now-card.idle .now-foot {
  display: none;
}

/* ---------- 周网格 ---------- */
.grid-wrap {
  overflow-x: auto;
}

.sched {
  width: 100%;
  min-width: 744px;
  border-collapse: collapse;
  table-layout: fixed;
}

.sched tbody tr {
  height: 48px;
}

.sched th,
.sched td {
  border: 1px solid var(--border-subtle);
}

.c-period {
  width: 82px;
  padding: 4px 2px;
  vertical-align: middle;
  text-align: center;
  background: var(--bg-ctrl);
}

.pn {
  display: block;
  font-size: 12.5px;
  color: var(--text-primary);
}

.pt {
  display: block;
  margin-top: 2px;
  font-size: 9.5px;
  line-height: 1.3;
  color: var(--text-dim);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.c-day {
  padding: 8px 4px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  background: var(--bg-ctrl);
}

.c-day.today {
  color: var(--accent-blue);
}

.c-empty {
  background: transparent;
}

.c-course {
  position: relative;
  overflow: hidden;
  padding: 8px;
  vertical-align: top;
  background: var(--bg-ctrl);
}

.c-course.muted {
  opacity: 0.42;
}

.c-course.current {
  box-shadow: inset 0 0 0 1px var(--accent-blue);
}

.cell-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 0;
  background: rgba(64, 158, 255, 0.22);
  transition: width 1s linear;
  pointer-events: none;
}

.cell-body {
  position: relative;
}

.cell-name {
  display: block;
  font-size: 12.5px;
  line-height: 1.4;
  color: var(--text-primary);
  word-break: break-all;
}

.cell-loc {
  display: block;
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-muted);
  word-break: break-all;
}

@media (max-width: 760px) {
  .schedule-page {
    padding: 16px 12px 40px;
  }
}
</style>

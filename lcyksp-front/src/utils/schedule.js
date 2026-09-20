// 课程表时间计算 —— 全部纯函数，不碰 DOM、不碰网络，方便单独验证。
//
// 约定：所有比较都换算成「当天 0 点起的分钟数」，绕开时区与 Date 解析的坑。

export const DAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

/** 'HH:MM' → 当天分钟数 */
export function toMinutes(hhmm) {
  const parts = String(hhmm).split(':')
  return Number(parts[0]) * 60 + Number(parts[1])
}

/** Date → 当天 0 点起的分钟数（带秒的小数） */
export function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60
}

/** Date → 1=周一 … 7=周日 */
export function weekdayIndex(date) {
  const d = date.getDay()
  return d === 0 ? 7 : d
}

/** 'YYYY-MM-DD' → 本地时间的 Date（不用 new Date(string)，避免被当成 UTC） */
export function parseLocalDate(ymd) {
  const parts = String(ymd).split('-').map(Number)
  return new Date(parts[0], parts[1] - 1, parts[2])
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/** 第几教学周；早于开学返回 0 */
export function weekOf(date, semesterStart) {
  const days = Math.round((startOfDay(date) - startOfDay(parseLocalDate(semesterStart))) / 86400000)
  if (days < 0) return 0
  return Math.floor(days / 7) + 1
}

/**
 * 课程是否落在这一周。
 *   - 没写 weeks  → 不受周次范围限制
 *   - parity 'odd' / 'even' → 只在单周 / 双周上
 *   - 两者都不写  → 每周都上
 */
export function inWeek(course, week) {
  if (Array.isArray(course.weeks) && (week < course.weeks[0] || week > course.weeks[1])) return false
  if (course.parity === 'odd' && week % 2 === 0) return false
  if (course.parity === 'even' && week % 2 === 1) return false
  return true
}

/** 教学周的单双周标签。week 为 0（还没开学）时返回空串 */
export function parityOf(week) {
  if (!week) return ''
  return week % 2 === 1 ? '单周' : '双周'
}

function periodMapOf(periods) {
  const map = new Map()
  for (const p of periods) map.set(p.n, p)
  return map
}

/** 某一天实际要上的课（按星期 + 周次过滤） */
export function coursesOn(courses, date, semesterStart) {
  const day = weekdayIndex(date)
  const week = weekOf(date, semesterStart)
  return courses.filter((c) => c.day === day && inWeek(c, week))
}

/** 当前正在上的课 + 已过时间 + 进度（0~1）。没课返回 null */
export function findCurrent(courses, periods, semesterStart, date) {
  const now = minutesOfDay(date)
  const map = periodMapOf(periods)
  for (const course of coursesOn(courses, date, semesterStart)) {
    const s = map.get(course.from)
    const e = map.get(course.to)
    if (!s || !e) continue
    const start = toMinutes(s.start)
    const end = toMinutes(e.end)
    if (now >= start && now < end) {
      const total = end - start
      const elapsed = now - start
      return { course, start, end, total, elapsed, progress: total > 0 ? elapsed / total : 0 }
    }
  }
  return null
}

/** 下一节课（含几天后的），带倒计时分钟数 */
export function findNext(courses, periods, semesterStart, date) {
  const now = minutesOfDay(date)
  const map = periodMapOf(periods)
  let best = null
  for (let offset = 0; offset < 7; offset++) {
    const probe = new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset)
    for (const course of coursesOn(courses, probe, semesterStart)) {
      const s = map.get(course.from)
      const e = map.get(course.to)
      if (!s || !e) continue
      const start = toMinutes(s.start)
      if (offset === 0 && start <= now) continue
      const startsIn = offset * 1440 + start - now
      if (!best || startsIn < best.startsIn) {
        best = { course, start, end: toMinutes(e.end), dayOffset: offset, startsIn }
      }
    }
  }
  return best
}

/**
 * 排周网格。返回 { week, grid }，grid[day][period] 取值为：
 *   { type: 'empty' }
 *   { type: 'start', course, span, active }  active=false 表示本周不上这门课
 *   { type: 'covered' }                      被上面格子的 rowspan 盖住，不用渲染
 */
export function buildGrid(courses, periods, semesterStart, date) {
  const week = weekOf(date, semesterStart)
  const grid = {}
  for (let day = 1; day <= 7; day++) {
    const col = {}
    for (const p of periods) col[p.n] = { type: 'empty' }
    grid[day] = col
  }

  for (const course of courses) {
    if (!grid[course.day]) continue
    let blocked = false
    for (let n = course.from; n <= course.to; n++) {
      const cell = grid[course.day][n]
      if (!cell || cell.type !== 'empty') {
        blocked = true
        break
      }
    }
    if (blocked) continue

    const active = inWeek(course, week)
    for (let n = course.from; n <= course.to; n++) {
      grid[course.day][n] =
        n === course.from
          ? { type: 'start', course, span: course.to - course.from + 1, active }
          : { type: 'covered' }
    }
  }

  return { week, grid }
}

/** 分钟数 → 'HH:MM' */
export function fmtClock(minutes) {
  const total = Math.max(0, Math.round(minutes))
  const h = Math.floor(total / 60) % 24
  const m = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** 分钟数 → '1 小时 34 分' */
export function humanDuration(minutes) {
  const total = Math.max(0, Math.round(minutes))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h && m) return `${h} 小时 ${m} 分`
  if (h) return `${h} 小时`
  return `${m} 分钟`
}

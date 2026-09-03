// =====================================================================
//  ALGS 赛事数据抓取与解析
//  数据源: https://apexlegendsstatus.com/algs/{season}/{league}/{region}/Overview
//  存储: 快照式（每次抓取存一条完整 JSON，保留历史）
// =====================================================================
import { getDb } from '../config/db.js'

const ALGS_BASE = 'https://apexlegendsstatus.com/algs'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const FETCH_TIMEOUT_MS = 45000

function cleanText(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseScoreMatrix(html) {
  const result = { games: [], groups: [], rows: [] }
  const m = html.match(/<table class="score-matrix_table">([\s\S]*?)<\/table>/)
  if (!m) return result

  const table = m[1]
  // 表头（取第一个 tr 行）：# / Team / Total Score / 场次列
  const headerMatch = table.match(/<thead[^>]*>([\s\S]*?)<\/thead>/)
  if (headerMatch) {
    const firstRow = headerMatch[1].match(/<tr[^>]*>([\s\S]*?)<\/tr>/)
    if (firstRow) {
      const ths = [...firstRow[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((x) => cleanText(x[1]))
      const games = ths.slice(3).filter((g) => g && !/total/i.test(g) && !/^#$/i.test(g) && !/team/i.test(g))
      result.games = games
    }
  }

  // 从比赛链接解析 Day→分组（AvB/AvC/BvC）映射
  const groupMap = {}
  for (const gm of html.matchAll(/\/Day(\d+)\/([A-Za-z]+)\//g)) {
    groupMap['Day ' + gm[1]] = gm[2]
  }
  result.groups = result.games.map((g) => groupMap[g] || '')

  const tbody = table.match(/<tbody>([\s\S]*?)<\/tbody>/)
  if (!tbody) return result
  for (const row of tbody[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1])
    if (cells.length < 3) continue
    const rank = parseInt(cleanText(cells[0]), 10) || 0
    const slugMatch = cells[1].match(/\/teams\/([^/.]+)\.png/)
    const slug = slugMatch ? slugMatch[1] : ''
    const team = cleanText(cells[1])
    const total = parseInt(cleanText(cells[2]), 10) || 0
    const gamesScores = cells.slice(3).map((c) => {
      const v = parseInt(cleanText(c), 10)
      return Number.isNaN(v) ? null : v
    })
    result.rows.push({ rank, team, slug, total, games: gamesScores })
  }
  return result
}

function parseStandings(html) {
  // 主积分榜（含 kills）：score-table_row 结构
  const standings = []
  const blocks = html.split('<div class="score-table_row')
  for (const b of blocks.slice(1)) {
    const rankM = b.match(/rank-number">(\d+)</)
    const nameM = b.match(/team-name">([\s\S]*?)<\/div>/)
    const scoreM = b.match(/team-score">(\d+)</)
    const killsM = b.match(/team-kills">([\s\S]*?)<\/div>/)
    if (!rankM || !nameM || !scoreM) continue
    // 去掉名称里混入的 span（如回放次数 "0 ↺"）
    const nameRaw = nameM[1].replace(/<span[\s\S]*?<\/span>/g, '')
    standings.push({
      rank: parseInt(rankM[1], 10),
      team: cleanText(nameRaw),
      score: parseInt(scoreM[1], 10),
      kills: killsM ? parseInt(cleanText(killsM[1]), 10) || null : null,
    })
  }
  return standings
}

function parseMapInsights(html) {
  // map-insights-performance_points：Team | 地图列 | Total，单元格形如 "58 (38.2%)"
  const points = []
  const m = html.match(/<table[^>]*id="map-insights-performance_points"([\s\S]*?)<\/table>/)
  if (!m) return points
  const rows = [...m[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((x) => x[1])
  if (rows.length < 2) return points
  const headerCells = [...rows[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((x) => cleanText(x[1]))
  const mapNames = headerCells.slice(1, -1) // 去掉 Team 与 Total
  for (const row of rows.slice(1)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => cleanText(x[1]))
    if (cells.length < 2) continue
    const team = cells[0]
    const maps = []
    for (let i = 0; i < mapNames.length && i < cells.length - 2; i++) {
      const cell = cells[i + 1]
      const valueM = cell.match(/([\d.]+)/)
      const pctM = cell.match(/\(([\d.]+)%\)/)
      maps.push({ name: mapNames[i], score: valueM ? parseFloat(valueM[1]) : null, pct: pctM ? parseFloat(pctM[1]) : null })
    }
    const totalCell = cells[cells.length - 1]
    points.push({ team, maps, total: parseInt(totalCell, 10) || null })
  }
  return points
}

function parseAvgPointsPerMap(html) {
  // map-insights-performance_avg_points_per_map：Team | 地图列 | Total，单元格形如 "6.2 (35.6%)"
  const avg = []
  const m = html.match(/<table[^>]*id="map-insights-performance_avg_points_per_map"([\s\S]*?)<\/table>/)
  if (!m) return avg
  const rows = [...m[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((x) => x[1])
  if (rows.length < 2) return avg
  const headerCells = [...rows[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((x) => cleanText(x[1]))
  const mapNames = headerCells.slice(1, -1)
  for (const row of rows.slice(1)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => cleanText(x[1]))
    if (cells.length < 2) continue
    const team = cells[0]
    const maps = []
    for (let i = 0; i < mapNames.length && i < cells.length - 2; i++) {
      const cell = cells[i + 1]
      const valueM = cell.match(/([\d.]+)/)
      const pctM = cell.match(/\(([\d.]+)%\)/)
      maps.push({ name: mapNames[i], avg: valueM ? parseFloat(valueM[1]) : null, pct: pctM ? parseFloat(pctM[1]) : null })
    }
    const totalCell = cells[cells.length - 1]
    avg.push({ team, maps, total: parseFloat(totalCell) || null })
  }
  return avg
}

function parseLegends(html) {
  const idx = html.indexOf('var legends_players = ')
  if (idx < 0) return []
  const eqIdx = html.indexOf('=', idx)
  const semiIdx = html.indexOf(';', eqIdx)
  if (eqIdx < 0 || semiIdx <= eqIdx) return []
  try {
    const data = JSON.parse(html.slice(eqIdx + 1, semiIdx))
    const players = []
    for (const [id, info] of Object.entries(data)) {
      players.push({
        playerId: id,
        name: info.name || '',
        pickRates: info.pickRates || {},
        performance: info.performance || {},
      })
    }
    return players
  } catch {
    return []
  }
}

function parseNum(v) {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : null
}

/**
 * 解析单张 POI 表的行（跳伞落点维度统计，数据源已算好每 POI 局均得分/击杀/名次/胜场/样本）
 * 返回: [{ name, avgPick, wins, avgPoints, avgKills, avgPlacement, picks }]
 */
function parsePoiRows(tableHtml) {
  const pois = []
  const rows = [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((x) => x[1])
  for (const row of rows.slice(1)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => cleanText(x[1]))
    if (cells.length < 7 || cells[0] === 'POI' || !cells[0]) continue
    pois.push({
      name: cells[0],
      avgPick: cells[1] && cells[1] !== 'NC yet' ? cells[1] : null,
      wins: parseInt(cells[2], 10) || 0,
      avgPoints: parseNum(cells[3]),
      avgKills: parseNum(cells[4]),
      avgPlacement: parseNum(cells[5]),
      picks: parseInt(cells[6], 10) || 0,
    })
  }
  return pois
}

// POIs Stats 内容区（data-table-toggle="pois-stats"> 之后的第一张表，即 Storm Point）
function parsePoiStats(html) {
  const m = html.match(/data-table-toggle="pois-stats">([\s\S]*?)<table[^>]*>([\s\S]*?)<\/table>/)
  return m ? parsePoiRows(m[2]) : []
}

/**
 * 解析全部地图的 POI 表（每赛区 Overview 含 Storm Point / E-District / World's Edge 三张，
 * 以 <table data-column-manager="map-stats-{地图名}"> 区分）
 * 返回: { [地图名]: [{ name, avgPick, wins, avgPoints, avgKills, avgPlacement, picks }] }
 */
function parsePoiStatsByMap(html) {
  const byMap = {}
  const tables = [...html.matchAll(/<table[^>]*\bdata-column-manager="map-stats-([^"]+)"[^>]*>([\s\S]*?)<\/table>/g)]
  for (const t of tables) {
    const pois = parsePoiRows(t[2])
    if (pois.length) byMap[t[1]] = pois
  }
  return byMap
}

/**
 * 每局赛程与地图：从回放标题解析（"A vs. B - Game #3 - World's Edge"）。
 * 每个比赛日（Day N × 组别）含 6 局，回放按组内第 k 次出现对应第 k 个该组别的比赛日。
 * 返回: [{ day, group, games: [{ no, map }] }]
 */
function parseGameSchedule(html, groups) {
  const titles = [...html.matchAll(/replay-banner_title">\s*([^<]+?)\s*-\s*Game\s*#(\d+)\s*-\s*([^<]+?)\s*</g)]
  const norm = (g) => (g || '').replace(/\s+/g, '').replace('vs.', 'v').replace('vs', 'v')
  // 按组别收集集合（保持文档顺序 = 时间顺序）
  const setsByGroup = new Map()
  let lastGroup = null
  for (const t of titles) {
    const g = norm(t[1])
    if (g !== lastGroup) {
      if (!setsByGroup.has(g)) setsByGroup.set(g, [])
      setsByGroup.get(g).push(new Map())
      lastGroup = g
    }
    setsByGroup.get(g).at(-1).set(parseInt(t[2], 10), t[3])
  }
  // 组别在赛程里的第 k 次出现 ↔ 该组第 k 个集合
  const seen = new Map()
  const schedule = []
  ;(groups || []).forEach((rawGroup, idx) => {
    const g = norm(rawGroup)
    const k = seen.get(g) || 0
    seen.set(g, k + 1)
    const sets = setsByGroup.get(g) || []
    const set = sets[k]
    const games = set ? [...set.entries()].sort((a, b) => a[0] - b[0]).map(([no, map]) => ({ no, map })) : []
    schedule.push({ day: idx + 1, group: g, games })
  })
  return schedule
}

/**
 * 每个比赛日各局的游戏页 hash（用于抓取单局页面的跳点/详细数据）
 * 返回: [{ day, group, hashes: [..] }]
 */
function parseGameLinks(html, groups) {
  const norm = (g) => (g || '').replace(/\s+/g, '').replace('vs.', 'v').replace('vs', 'v')
  const byKey = new Map()
  for (const m of html.matchAll(/\/algs\/[\w-]+\/[\w-]+\/[\w_]+\/(Day\d+)\/([A-Za-z]+)\/([0-9a-f]{32})/g)) {
    const key = `${m[1]}|${norm(m[2])}`
    if (!byKey.has(key)) byKey.set(key, [])
    if (!byKey.get(key).includes(m[3])) byKey.get(key).push(m[3])
  }
  const seen = new Map()
  const schedule = []
  ;(groups || []).forEach((rawGroup, idx) => {
    const g = norm(rawGroup)
    const day = `Day${idx + 1}`
    const hashes = byKey.get(`${day}|${g}`) || []
    schedule.push({ day: idx + 1, group: g, hashes })
  })
  return schedule
}

/**
 * 选手统计数据（data-column-manager="players-stats"）
 */
function parsePlayersStats(html) {
  const m = html.match(/<table[^>]*data-column-manager="players-stats"[^>]*>([\s\S]*?)<\/table>/)
  if (!m) return []
  const players = []
  const rows = [...m[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((x) => x[1])
  for (const row of rows.slice(1)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1])
    if (cells.length < 10 || !cells[0]) continue
    // 选手名在链接里（单元格还带有国旗等徽标 span，cleanText 会混入）
    const linkM = cells[0].match(/<a[^>]*>([\s\S]*?)<\/a>/)
    const player = cleanText(linkM ? linkM[1] : cells[0])
    const team = cleanText(cells[1])
    const slugM = (cells[0] + cells[1]).match(/\/teams\/([\w-]+)\.png/)
    const num = (s) => parseNum(String(s || '').replace(/,/g, ''))
    players.push({
      player,
      team,
      teamSlug: slugM ? slugM[1] : '',
      bestPlacement: cleanText(cells[2]),
      games: parseInt(cleanText(cells[3]), 10) || 0,
      kills: parseInt(cleanText(cells[4]), 10) || 0,
      assists: parseInt(cleanText(cells[5]), 10) || 0,
      knocks: parseInt(cleanText(cells[6]), 10) || 0,
      timesKnocked: parseInt(cleanText(cells[7]), 10) || 0,
      damage: num(cleanText(cells[8])),
      damageTaken: num(cleanText(cells[9])),
      damageDiff: cells[10] != null ? num(cleanText(cells[10])) : null,
      dmgPerKill: cells[11] != null ? num(cleanText(cells[11])) : null,
      ringDamage: cells[12] != null ? num(cleanText(cells[12])) : null,
      rezzes: cells[13] != null ? parseInt(cleanText(cells[13]), 10) || 0 : 0,
      respawns: cells[14] != null ? parseInt(cleanText(cells[14]), 10) || 0 : 0,
      kd: cells[15] != null ? num(cleanText(cells[15])) : null,
      kad: cells[16] != null ? num(cleanText(cells[16])) : null,
      deaths: cells[17] != null ? num(cleanText(cells[17])) : null,
      surviveTime: cleanText(cells[18]),
      avgTimeToFirstKill: cleanText(cells[19]),
    })
  }
  return players
}

/**
 * 地图洞察通用表（Team | 各地图列 | Total，单元格形如 "17 (32.1%)" 或 "2 (33.3%, Total 27.8%)"）
 * 部分表只有 data-column-manager 没有 id，两者都试
 */
function parseMapInsightTable(html, id) {
  const m =
    html.match(new RegExp(`<table[^>]*id="${id}"([\\s\\S]*?)</table>`)) ||
    html.match(new RegExp(`<table[^>]*data-column-manager="${id}"([\\s\\S]*?)</table>`))
  if (!m) return []
  const rows = [...m[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((x) => x[1])
  if (rows.length < 2) return []
  const headerCells = [...rows[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((x) => cleanText(x[1]))
  const mapNames = headerCells.slice(1, -1)
  const out = []
  for (const row of rows.slice(1)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => cleanText(x[1]))
    if (cells.length < 2) continue
    const maps = []
    for (let i = 0; i < mapNames.length && i < cells.length - 2; i++) {
      const cell = cells[i + 1]
      const valueM = cell.match(/([\d.]+)/)
      const pctM = cell.match(/\(([\d.]+)%/)
      maps.push({ name: mapNames[i], value: valueM ? parseFloat(valueM[1]) : null, pct: pctM ? parseFloat(pctM[1]) : null })
    }
    const totalCell = cells[cells.length - 1]
    const totalM = String(totalCell).match(/([\d.]+)/)
    out.push({ team: cells[0], maps, total: totalM ? parseFloat(totalM[1]) : null })
  }
  return out
}

/**
 * 版本生态：Evo 升级选择 + 英雄组合选用率 + 武器统计
 */
function parseLegendCell(cell) {
  // 图标 src: /assets/legends/xx/Catalyst-transparent.png → Catalyst
  const icons = [...cell.matchAll(/\/assets\/legends\/[\w-]+\/([\w%.-]+?)-transparent\.png/g)].map((x) => x[1])
  const text = cleanText(cell)
  return { legends: icons.length ? icons : (text ? [text] : []), label: text || icons.join(', ') }
}

function parseEvoUpgrades(html, level) {
  const m = html.match(new RegExp(`<table[^>]*data-column-manager="evo-level-${level}-upgrades"[^>]*>([\\s\\S]*?)</table>`))
  if (!m) return []
  const out = []
  const rows = [...m[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((x) => x[1])
  for (const row of rows.slice(1)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1])
    if (cells.length < 4) continue
    const legend = parseLegendCell(cells[0])
    out.push({
      legend: legend.label,
      perk: cleanText(cells[1]),
      pickRate: parseNum(cleanText(cells[2])),
      picks: parseInt(cleanText(cells[3]), 10) || 0,
    })
  }
  return out
}

function parseCompLegends(html) {
  const m = html.match(/<table[^>]*data-column-manager="comp-legends-data"[^>]*>([\s\S]*?)<\/table>/)
  if (!m) return []
  const out = []
  const rows = [...m[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((x) => x[1])
  for (const row of rows.slice(1)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1])
    if (cells.length < 4) continue
    const comp = parseLegendCell(cells[0])
    out.push({
      composition: comp.label,
      pickRate: parseNum(cleanText(cells[1])),
      avgPlacement: parseNum(cleanText(cells[2])),
      winRate: parseNum(cleanText(cells[3])),
      top5Rate: parseNum(cleanText(cells[4])),
    })
  }
  return out
}

function parseWeaponsStats(html) {
  const m = html.match(/<table[^>]*id="weaponsStatsTable"[^>]*>([\s\S]*?)<\/table>/)
  if (!m) return []
  const out = []
  const rows = [...m[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((x) => x[1])
  for (const row of rows.slice(1)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => cleanText(x[1]))
    if (cells.length < 5 || !cells[0]) continue
    out.push({
      weapon: cells[0],
      kills: parseInt(cells[1], 10) || 0,
      damage: cells[2] != null ? parseNum(cells[2].replace(/,/g, '')) : null,
      knockdowns: parseInt(cells[3], 10) || 0,
      fwr: cells[4] != null ? parseNum(cells[4]) : null,
    })
  }
  return out
}

/**
 * 解析 Overview 页面 HTML 为结构化数据
 */
export function parseAlgsOverview(html) {
  const standings = parseStandings(html)
  const matrix = parseScoreMatrix(html)
  return {
    standings,
    matrix,
    mapInsights: parseMapInsights(html),
    avgPointsPerMap: parseAvgPointsPerMap(html),
    legends: parseLegends(html),
    poiStats: parsePoiStats(html),
    poiStatsByMap: parsePoiStatsByMap(html),
    // 每局赛程与地图（回放标题口径：每比赛日 6 局）
    gameSchedule: parseGameSchedule(html, matrix.groups),
    gameLinks: parseGameLinks(html, matrix.groups),
    // 选手数据榜
    playersStats: parsePlayersStats(html),
    // 地图多维洞察
    mapKills: parseMapInsightTable(html, 'map-insights-performance_kills'),
    mapWins: parseMapInsightTable(html, 'map-insights-performance_wins'),
    mapTop5: parseMapInsightTable(html, 'map-insights-performance_top5_rate'),
    // 版本生态
    evoUpgrades2: parseEvoUpgrades(html, 2),
    evoUpgrades3: parseEvoUpgrades(html, 3),
    compLegends: parseCompLegends(html),
    weaponsStats: parseWeaponsStats(html),
  }
}

/**
 * 抓取并解析某个赛事页
 */
export async function fetchAlgsOverview(season, league, region) {
  const url = `${ALGS_BASE}/${encodeURIComponent(season)}/${encodeURIComponent(league)}/${encodeURIComponent(region)}/Overview`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`ALGS 页面抓取失败 (${response.status})`)
    const html = await response.text()
    return parseAlgsOverview(html)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 解析单局页面：局号 + 记分板 + 各队跳点 + 花名册/落点坐标/队伍色（供单局复盘）
 * 返回: { gameNo, scoreboard, drops, roster, teamData, teamColors }
 */
export function parseGamePage(html) {
  const scoreboard = []
  const drops = []
  const roster = {}
  let teamData = []
  const teamColors = {}
  let mapKey = ''
  let gameNo = null
  // 记分板：单局页的 score-matrix 表，列为 [#, Team, Total Score, Game #N, P, K]
  const sm = html.match(/<table class="score-matrix_table">([\s\S]*?)<\/table>/)
  if (sm) {
    const thM = sm[1].match(/Game\s*#(\d+)/)
    if (thM) gameNo = parseInt(thM[1], 10)
    const body = sm[1].match(/<tbody>([\s\S]*?)<\/tbody>/)
    if (body) {
      for (const row of body[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
        const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => cleanText(x[1]))
        if (cells.length < 5) continue
        scoreboard.push({
          team: cells[1],
          score: parseInt(cells[2], 10) || 0,
          placement: parseInt(cells[3], 10) || 0,
          kills: parseInt(cells[4], 10) || 0,
        })
      }
    }
  }
  // 跳点表：teams-drops toggle 后的第一张表（POI | ... | 名次 | ... | Picks）
  const dm = html.match(/data-table-toggle="teams-drops"([\s\S]*?)<table[^>]*>([\s\S]*?)<\/table>/)
  if (dm) {
    for (const row of dm[2].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => cleanText(x[1]))
      if (cells.length < 6 || !cells[0]) continue
      const placement = parseNum(cells[5])
      drops.push({
        poi: cells[0],
        placement,
        kills: parseNum(cells[4]),
        score: parseNum(cells[3]),
      })
    }
  }
  // 花名册：timelinePlayers 下拉（value="选手$选手$选手"，label=队伍名）
  const rosterM = html.match(/<select id="timelinePlayers"[^>]*>([\s\S]*?)<\/select>/)
  if (rosterM) {
    for (const m of rosterM[1].matchAll(/<option value="([^"]*\$[^"]*)"[^>]*>([^<]+)<\/option>/g)) {
      roster[cleanText(m[2])] = m[1].split('$').map((p) => cleanText(p))
    }
  }
  // 内嵌脚本：dropsData（地图key→队伍落点/颜色）与 teamData（归一化落点坐标）
  const scriptM = html.match(/let\s+dropsData\s*=\s*(\{[\s\S]*?\});[\s\S]*?let\s+gameId/)
  if (scriptM) {
    try {
      const dd = JSON.parse(scriptM[1])
      mapKey = Object.keys(dd)[0] || ''
      for (const entries of Object.values(dd)) {
        for (const t of Object.values(entries || {})) {
          if (t?.teamName && t?.teamColor) teamColors[t.teamName] = t.teamColor
        }
      }
    } catch { /* 忽略内嵌 JSON 解析失败 */ }
  }
  const tdM = html.match(/const\s+teamData\s*=\s*(\[\{"team"[\s\S]*?\}\]);/)
  if (tdM) {
    try { teamData = JSON.parse(tdM[1]) } catch { /* ignore */ }
  }
  return { gameNo, scoreboard, drops, roster, teamData, teamColors, mapKey }
}

/**
 * 单局跳点 → 队伍映射：跳点表匿名，但每行的比赛名次唯一，按名次与记分板 join。
 * 名次为小数（多队同 POI 平均）时无法唯一匹配，返回 null。
 */
export function joinDropsToTeams(game) {
  const byPlacement = new Map(game.scoreboard.map((s) => [s.placement, s]))
  const result = []
  for (const d of game.drops) {
    if (d.placement == null || !Number.isInteger(d.placement)) continue
    const team = byPlacement.get(d.placement)
    if (team) result.push({ team: team.team, poi: d.poi, placement: d.placement, kills: team.kills, score: team.score })
  }
  return result
}

/**
 * 抓取单局页面
 */
export async function fetchAlgsGamePage(season, league, region, day, group, hash) {
  const url = `${ALGS_BASE}/${encodeURIComponent(season)}/${encodeURIComponent(league)}/${encodeURIComponent(region)}/${day}/${group}/${hash}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`单局页面抓取失败 (${response.status})`)
    return parseGamePage(await response.text())
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 抓取单局的逐秒时间线（击杀/伤害/存活状态/圈关闭时间）
 */
export async function fetchAlgsTimeline(gameId) {
  const url = `${ALGS_BASE}/local/getTimeline?gameId=${encodeURIComponent(gameId)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`时间线抓取失败 (${response.status})`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 保存快照（同一赛季/赛区每次抓取插入新记录）
 */
export async function saveAlgsSnapshot(season, league, region, payload) {
  const db = getDb()
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO algs_snapshots (season, league, region, payload) VALUES (?, ?, ?, ?)',
      [season, league, region, JSON.stringify(payload)],
      function onRun(err) {
        if (err) return reject(err)
        resolve(this.lastID)
      },
    )
  })
}

/**
 * 读取最新快照
 */
export async function getAlgsSnapshot(season, league, region) {
  const db = getDb()
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT id, season, league, region, fetched_at, payload FROM algs_snapshots WHERE season = ? AND league = ? AND region = ? ORDER BY id DESC LIMIT 1',
      [season, league, region],
      function onGet(err, row) {
        if (err) return reject(err)
        if (!row) return resolve(null)
        try {
          resolve({ id: row.id, season: row.season, league: row.league, region: row.region, fetchedAt: row.fetched_at, payload: JSON.parse(row.payload) })
        } catch {
          resolve(null)
        }
      },
    )
  })
}

/**
 * 已缓存赛区/赛季列表
 */
export async function listAlgsEvents() {
  const db = getDb()
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT season, league, region, MAX(fetched_at) AS last_fetched_at, COUNT(*) AS snapshots FROM algs_snapshots GROUP BY season, league, region ORDER BY season DESC, league, region',
      function onAll(err, rows) {
        if (err) return reject(err)
        resolve(rows)
      },
    )
  })
}

// =====================================================================
//  动态赛事目录：从数据站首页解析当前可用赛季/联赛/赛区（缓存 12 小时）
// =====================================================================
let catalogCache = { at: 0, data: null }
const CATALOG_TTL_MS = 12 * 60 * 60 * 1000

export async function fetchAlgsCatalog() {
  const now = Date.now()
  if (catalogCache.data && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.data

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(`${ALGS_BASE}/`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`赛事目录抓取失败 (${response.status})`)
    const html = await response.text()
    const combos = [...new Set(
      [...html.matchAll(/\/algs\/([A-Za-z0-9-]+)\/([A-Za-z-]+)\/([A-Za-z_]+)\/Overview/g)].map((m) => `${m[1]}|${m[2]}|${m[3]}`),
    )]
    if (!combos.length) throw new Error('赛事目录解析为空')
    const seasons = [...new Set(combos.map((x) => x.split('|')[0]))].sort().reverse() // 最新在前
    const leagues = [...new Set(combos.map((x) => x.split('|')[1]))]
    const regions = [...new Set(combos.map((x) => x.split('|')[2]))]
    const data = { seasons, leagues, regions, combos }
    catalogCache = { at: now, data }
    return data
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 跨赛区聚合 POI 统计：按 POI 名对各赛区场均值做样本加权平均
 * @param {Array<{region: string, pois: Array}>} perRegion
 */
export function aggregatePoiStats(perRegion) {
  const acc = new Map()
  for (const { region, pois } of perRegion) {
    for (const p of pois || []) {
      if (!acc.has(p.name)) {
        acc.set(p.name, { points: 0, kills: 0, placement: 0, picks: 0, wins: 0, regions: {} })
      }
      const a = acc.get(p.name)
      const n = p.picks || 0
      a.picks += n
      a.wins += p.wins || 0
      if (p.avgPoints != null) a.points += p.avgPoints * n
      if (p.avgKills != null) a.kills += p.avgKills * n
      if (p.avgPlacement != null) a.placement += p.avgPlacement * n
      a.regions[region] = { avgPoints: p.avgPoints, avgKills: p.avgKills, avgPlacement: p.avgPlacement, wins: p.wins || 0, picks: n }
    }
  }
  const result = []
  for (const [name, a] of acc.entries()) {
    result.push({
      name,
      picks: a.picks,
      wins: a.wins,
      avgPoints: a.picks ? Math.round((a.points / a.picks) * 100) / 100 : null,
      avgKills: a.picks ? Math.round((a.kills / a.picks) * 100) / 100 : null,
      avgPlacement: a.picks ? Math.round((a.placement / a.picks) * 100) / 100 : null,
      regions: a.regions,
    })
  }
  result.sort((x, y) => (y.avgPoints || 0) - (x.avgPoints || 0))
  return result
}

export default { parseAlgsOverview, fetchAlgsOverview, fetchAlgsCatalog, saveAlgsSnapshot, getAlgsSnapshot, listAlgsEvents, aggregatePoiStats }

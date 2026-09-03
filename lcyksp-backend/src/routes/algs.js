// =====================================================================
//  ALGS 赛事数据 API
// =====================================================================
import { Router } from 'express'
import { fetchAlgsOverview, fetchAlgsCatalog, saveAlgsSnapshot, getAlgsSnapshot, listAlgsEvents, aggregatePoiStats, fetchAlgsGamePage, joinDropsToTeams, fetchAlgsTimeline } from '../utils/algs.js'
import { getClientIp } from '../utils/turnstile.js'
import { getDb } from '../config/db.js'

const router = Router()

const DEFAULT_EVENT = { season: 'Y6-Split2', league: 'Pro-League', region: 'NA' }
// 手动刷新限流：同一事件 10 分钟内最多刷一次
const refreshThrottle = new Map()
const REFRESH_WINDOW_MS = 10 * 60 * 1000
// 定期清理刷新限流记录，防止内存增长
setInterval(() => {
  const now = Date.now()
  for (const [key, t] of refreshThrottle) {
    if (now - t > REFRESH_WINDOW_MS) refreshThrottle.delete(key)
  }
}, 30 * 60 * 1000).unref()

function parseEvent(req) {
  return {
    season: String(req.query.season || DEFAULT_EVENT.season).trim() || DEFAULT_EVENT.season,
    league: String(req.query.league || DEFAULT_EVENT.league).trim() || DEFAULT_EVENT.league,
    region: String(req.query.region || DEFAULT_EVENT.region).trim() || DEFAULT_EVENT.region,
  }
}

// GET /api/algs/events — 已缓存事件列表
router.get('/events', async (req, res, next) => {
  try {
    const events = await listAlgsEvents()
    res.json({ events })
  } catch (err) {
    next(err)
  }
})

// GET /api/algs/catalog — 动态赛季/联赛/赛区目录（从数据站解析，12 小时缓存）
router.get('/catalog', async (req, res, next) => {
  try {
    const catalog = await fetchAlgsCatalog()
    res.json(catalog)
  } catch (err) {
    res.status(502).json({ error: '获取赛事目录失败: ' + (err.message || '') })
  }
})

// =====================================================================
//  跳点分析：跨赛区聚合的 POI 期望得分（每个跳点每把平均得分）
// =====================================================================
const poiCache = new Map()
const POI_CACHE_TTL_MS = 30 * 60 * 1000
setInterval(() => {
  const now = Date.now()
  for (const [key, v] of poiCache) {
    if (now - v.at > POI_CACHE_TTL_MS) poiCache.delete(key)
  }
}, 10 * 60 * 1000).unref()

// GET /api/algs/poi-stats?season=&league=&regions=NA,EMEA,APAC_N,APAC_S
// 实时抓取各赛区 Overview，按地图 × POI 名加权聚合（缓存 30 分钟）
// 地图中文名（社区通用译名）
const POI_MAP_CN = { 'Storm Point': '风暴点', 'E-District': '电力区', "World's Edge": '世界尽头' }

router.get('/poi-stats', async (req, res, next) => {
  try {
    const ev = parseEvent(req)
    const regions = String(req.query.regions || 'NA,EMEA,APAC_N,APAC_S')
      .split(',').map((r) => r.trim()).filter(Boolean)
    const cacheKey = `${ev.season}|${ev.league}|${regions.join(',')}`
    const cached = poiCache.get(cacheKey)
    if (cached && Date.now() - cached.at < POI_CACHE_TTL_MS) {
      return res.json(cached.data)
    }

    const perRegion = []
    for (const region of regions) {
      const payload = await fetchAlgsOverview(ev.season, ev.league, region)
      perRegion.push({ region, poisByMap: payload.poiStatsByMap || {} })
    }

    // 每赛区 Overview 含三张地图的 POI 表，按固定顺序输出
    const order = ['Storm Point', 'E-District', "World's Edge"]
    const mapNames = [...new Set(perRegion.flatMap((r) => Object.keys(r.poisByMap)))]
      .sort((a, b) => {
        const ia = order.indexOf(a); const ib = order.indexOf(b)
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
      })

    const maps = mapNames.map((name) => {
      const pois = aggregatePoiStats(perRegion.map((r) => ({ region: r.region, pois: r.poisByMap[name] || [] })))
      return {
        name,
        nameCn: POI_MAP_CN[name] || name,
        poiCount: pois.length,
        totalSamples: pois.reduce((s, p) => s + (p.picks || 0), 0),
        pois,
      }
    })

    const stormPoint = maps.find((m) => m.name === 'Storm Point')
    const data = {
      season: ev.season,
      league: ev.league,
      regions,
      maps,
      // 兼容旧字段：默认地图（Storm Point）的聚合结果
      mapName: 'Storm Point',
      poiCount: stormPoint?.poiCount || 0,
      totalSamples: stormPoint?.totalSamples || 0,
      pois: stormPoint?.pois || [],
    }
    poiCache.set(cacheKey, { at: Date.now(), data })
    res.json(data)
  } catch (err) {
    next(err)
  }
})

// 快照视为过期的阈值：超过后 /overview 自动重抓（数据源每小局后更新，避免长期展示旧数据）
const SNAPSHOT_STALE_MS = 30 * 60 * 1000

// SQLite CURRENT_TIMESTAMP 存的是 UTC 且无时区标记，补 Z 再解析；ISO 格式原样解析
function snapshotTimeMs(s) {
  if (!s) return 0
  return new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s}Z` : s).getTime()
}

// =====================================================================
//  各队跳点习惯：抓取该赛区所有已赛单局页，按比赛名次 join 出"哪队跳哪"
//  单局页较重（每赛区约 30-60 页），缓存 6 小时
// =====================================================================
const dropsCache = new Map()
const DROPS_CACHE_TTL_MS = 6 * 60 * 60 * 1000
const dropsInflight = new Map()

router.get('/team-drops', async (req, res, next) => {
  try {
    const ev = parseEvent(req)
    const cacheKey = `${ev.season}|${ev.league}|${ev.region}`
    const cached = dropsCache.get(cacheKey)
    if (cached && Date.now() - cached.at < DROPS_CACHE_TTL_MS) {
      return res.json(cached.data)
    }
    if (dropsInflight.has(cacheKey)) {
      return res.status(202).json({ error: '正在抓取各队跳点数据（首次约需 1-2 分钟），请稍后重试' })
    }

    const overview = await fetchAlgsOverview(ev.season, ev.league, ev.region)
    const { gameLinks, poiStatsByMap } = overview
    // 地图判定不使用回放标题（站点 VOD 标注有误），而是由跳点表 POI 名归属反推：
    // 每个 POI 唯一属于某张地图，取跳点命中数最多的地图
    const poiOwner = new Map()
    for (const [mapName, pois] of Object.entries(poiStatsByMap || {})) {
      for (const p of pois) poiOwner.set(p.name, mapName)
    }
    const deriveMap = (drops) => {
      const votes = {}
      for (const d of drops) {
        const owner = poiOwner.get(d.poi)
        if (owner) votes[owner] = (votes[owner] || 0) + 1
      }
      let best = ''
      let bestN = 0
      for (const [mapName, n] of Object.entries(votes)) {
        if (n > bestN) {
          best = mapName
          bestN = n
        }
      }
      return best
    }

    const jobs = []
    for (const link of gameLinks) {
      for (const hash of link.hashes) {
        jobs.push({ day: link.day, group: link.group, hash })
      }
    }

    dropsInflight.set(cacheKey, true)
    const task = (async () => {
      const perMapTeamPois = {} // map -> team -> { poi: count }
      const gameList = [] // 已抓到的单局：轮次/组别/局号/地图
      let okGames = 0
      const CONCURRENCY = 6
      let cursor = 0
      async function worker() {
        while (cursor < jobs.length) {
          const job = jobs[cursor++]
          try {
            const page = await fetchAlgsGamePage(ev.season, ev.league, ev.region, `Day${job.day}`, job.group, job.hash)
            const joined = joinDropsToTeams(page)
            if (!joined.length) continue
            okGames++
            const map = deriveMap(page.drops) || '未知地图'
            perMapTeamPois[map] = perMapTeamPois[map] || {}
            for (const j of joined) {
              perMapTeamPois[map][j.team] = perMapTeamPois[map][j.team] || {}
              perMapTeamPois[map][j.team][j.poi] = (perMapTeamPois[map][j.team][j.poi] || 0) + 1
            }
            gameList.push({ day: job.day, group: job.group, gameNo: page.gameNo, map, hash: job.hash })
          } catch (err) {
            console.warn(`[team-drops] 单局抓取失败 Day${job.day}/${job.group}/${job.hash.slice(0, 8)}:`, err.message)
          }
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, worker))
      gameList.sort((a, b) => a.day - b.day || a.group.localeCompare(b.group) || (a.gameNo || 0) - (b.gameNo || 0))
      return { perMapTeamPois, gameList, okGames, totalGames: jobs.length }
    })()

    dropsInflight.set(cacheKey, task)
    try {
      const { perMapTeamPois, gameList, okGames, totalGames } = await task
      if (!okGames) throw new Error('未能抓取到任何单局数据')
      const data = {
        season: ev.season,
        league: ev.league,
        region: ev.region,
        maps: perMapTeamPois,
        games: gameList,
        gamesFetched: okGames,
        gamesTotal: totalGames,
        fetchedAt: new Date().toISOString(),
      }
      dropsCache.set(cacheKey, { at: Date.now(), data })
      res.json(data)
    } finally {
      dropsInflight.delete(cacheKey)
    }
  } catch (err) {
    next(err)
  }
})

// =====================================================================
//  单局复盘：单局页 + getTimeline 聚合（存活曲线/击杀归因/团战/圈节奏/落点）
//  单局数据赛后不变，缓存 24 小时
// =====================================================================
const gameDetailCache = new Map()
const GAME_DETAIL_TTL_MS = 24 * 60 * 60 * 1000

// Apex 地图内部代号 → 展示名
const APEX_MAP_NAMES = {
  mp_rr_district: 'E-District',
  mp_rr_stormpoint: 'Storm Point',
  mp_rr_desertlands: "World's Edge",
  mp_rr_cities_name_me: "World's Edge",
  mp_rr_canyonlands: 'Kings Canyon',
  mp_rr_olympus: 'Olympus',
}

router.get('/game-detail', async (req, res, next) => {
  try {
    const ev = parseEvent(req)
    const day = String(req.query.day || '1').replace(/[^\d]/g, '') || '1'
    const group = String(req.query.group || '').trim()
    const hash = String(req.query.hash || '').trim()
    if (!/^[0-9a-f]{32}$/.test(hash)) {
      return res.status(400).json({ error: '缺少有效的单局 hash' })
    }
    const cacheKey = `${ev.season}|${ev.league}|${ev.region}|Day${day}|${group}|${hash}`
    const cached = gameDetailCache.get(cacheKey)
    if (cached && Date.now() - cached.at < GAME_DETAIL_TTL_MS) {
      return res.json(cached.data)
    }

    const [page, timeline] = await Promise.all([
      fetchAlgsGamePage(ev.season, ev.league, ev.region, `Day${day}`, group, hash),
      fetchAlgsTimeline(hash).catch(() => null),
    ])
    if (!page.scoreboard.length) throw new Error('单局数据解析失败')

    // 选手 → 队伍（花名册）；花名册缺失时用队徽映射兜底
    const playerTeam = new Map()
    for (const [team, players] of Object.entries(page.roster || {})) {
      for (const p of players || []) playerTeam.set(p, team)
    }

    const map = APEX_MAP_NAMES[page.mapKey] || ''

    // ---- 存活曲线：player_state 按队伍聚合 ----
    let survival = { timestamps: [], teams: {} }
    if (timeline?.player_state) {
      // 源站数据存在脏时间戳（如 1.19 亿），超过一局时长上限的直接丢弃，防止滑窗循环 OOM
      const saneT = (t) => (Number.isFinite(t) && t >= 0 && t <= 5000 ? t : null)
      const tsSet = new Set([0])
      const teamDeaths = {} // team -> [{t}] 每次存活→死亡的转移
      for (const [player, states] of Object.entries(timeline.player_state)) {
        const team = playerTeam.get(player)
        if (!team) continue
        let prevAlive = true
        for (const st of states || []) {
          const t = saneT(st.timestamp)
          if (t == null) continue
          tsSet.add(t)
          if (prevAlive && st.state !== 'alive') {
            ;(teamDeaths[team] = teamDeaths[team] || []).push(t)
            prevAlive = false
          } else if (st.state === 'alive') {
            prevAlive = true
          }
        }
      }
      const timestamps = [...tsSet].sort((a, b) => a - b)
      const teamNames = Object.keys(teamDeaths)
      const teamCounters = Object.fromEntries(teamNames.map((t) => [t, 0]))
      const playerCount = Object.fromEntries(teamNames.map((t) => [t, (page.roster?.[t] || []).length || 3]))
      const teams = {}
      for (const t of teamNames) teams[t] = []
      for (const t of timestamps) {
        for (const tn of teamNames) {
          teamCounters[tn] += (teamDeaths[tn] || []).filter((d) => d === t).length
          teams[tn].push(Math.max(0, playerCount[tn] - teamCounters[tn]))
        }
      }
      survival = { timestamps, teams, totalPlayers: playerCount }
    }

    // ---- 击杀事件 + 归因 ----
    // kills 字典是"该选手截至该秒的累计击杀"，需差分；受害者取 player_state 的存活→死亡转移点，
    // 击杀者取同一秒对受害者输出伤害最高的选手
    const killEvents = []
    let deathEvents = [] // [{t, victim}]
    if (timeline?.player_state) {
      for (const [player, states] of Object.entries(timeline.player_state)) {
        if (player.includes('$')) continue // 跳过未渲染的模板占位
        let prevAlive = true
        for (const st of states || []) {
          const t = Number.isFinite(st.timestamp) && st.timestamp >= 0 && st.timestamp <= 5000 ? st.timestamp : null
          if (t == null) continue
          if (prevAlive && st.state !== 'alive') {
            deathEvents.push({ t, victim: player })
            prevAlive = false
          } else if (st.state === 'alive') {
            prevAlive = true
          }
        }
      }
      deathEvents.sort((a, b) => a.t - b.t)
    }
    if (timeline?.damage) {
      for (const death of deathEvents) {
        // 死亡时刻与伤害记录有数秒偏移，在死亡前 5 秒窗口内找对该英雄输出最高的攻击者
        let killer = ''
        let best = -1
        for (let sec = death.t - 10; sec <= death.t; sec++) {
          const secDmg = timeline.damage[String(sec)]
          if (!secDmg || !secDmg[death.victim]?.taken) continue
          for (const [attacker, info] of Object.entries(secDmg)) {
            if (attacker === death.victim || !info?.dealt) continue
            if (info.dealt > best) {
              best = info.dealt
              killer = attacker
            }
          }
        }
        killEvents.push({
          t: death.t,
          killer,
          killerTeam: playerTeam.get(killer) || '',
          victim: death.victim,
          victimTeam: playerTeam.get(death.victim) || '',
        })
      }
      killEvents.sort((a, b) => a.t - b.t)
    }

    // ---- 团战检测：死亡密度（player_state 覆盖整场），10 秒滑窗 + 峰值合并 ----
    // 注意：源站 damage 只记录开局约 80 秒的交火，全场团战检测改用死亡事件密度
    let teamfights = []
    {
      const WINDOW = 10
      const perSecDeaths = {}
      for (const death of deathEvents) perSecDeaths[death.t] = (perSecDeaths[death.t] || 0) + 1
      const secs = Object.keys(perSecDeaths).map(Number)
      if (secs.length) {
        const maxSec = Math.max(...secs)
        const windows = []
        for (let s = 0; s <= maxSec; s += 5) {
          let kills = 0
          for (let t = s; t < s + WINDOW; t++) kills += perSecDeaths[t] || 0
          windows.push({ s, kills })
        }
        const hot = windows.filter((w) => w.kills >= 3)
        const merged = []
        for (const w of hot) {
          const last = merged[merged.length - 1]
          if (last && w.s - last.end <= 15) {
            last.end = Math.max(last.end, w.s + WINDOW)
            last.kills += w.kills
          } else {
            merged.push({ start: w.s, end: w.s + WINDOW, kills: w.kills })
          }
        }
        teamfights = merged.sort((a, b) => b.kills - a.kills).slice(0, 6).sort((a, b) => a.start - b.start)
      }
    }

    // ---- 前期交火伤害曲线（源站 damage 只覆盖开局约 80 秒）----
    let damageTimeline = []
    if (timeline?.damage) {
      const perSec = {}
      for (const [sec, entries] of Object.entries(timeline.damage)) {
        let total = 0
        for (const info of Object.values(entries || {})) total += (info?.dealt || 0) + (info?.taken || 0)
        perSec[parseInt(sec, 10)] = total / 2
      }
      damageTimeline = Object.entries(perSec)
        .map(([t, dmg]) => ({ t: parseInt(t, 10), dmg }))
        .sort((a, b) => a.t - b.t)
    }

    // ---- 选手伤害合计 ----
    const playerDamage = []
    if (timeline?.damage) {
      const agg = {}
      for (const entries of Object.values(timeline.damage)) {
        for (const [name, info] of Object.entries(entries || {})) {
          if (name.includes('$')) continue
          agg[name] = agg[name] || { player: name, team: playerTeam.get(name) || '', dealt: 0, taken: 0 }
          agg[name].dealt += info?.dealt || 0
          agg[name].taken += info?.taken || 0
        }
      }
      playerDamage.push(...Object.values(agg).sort((a, b) => b.dealt - a.dealt))
    }

    // ---- 各队结算：名次/击杀/团灭时间/跳点 ----
    const byPlacement = new Map(page.drops.map((d) => [d.placement, d.poi]))
    const teamTimeline = page.scoreboard.map((s) => {
      const deaths = deathEvents.filter((d) => d.victimTeam === s.team).map((d) => d.t)
      return {
        team: s.team,
        placement: s.placement,
        kills: s.kills,
        score: s.score,
        wipeAt: deaths.length ? Math.max(...deaths) : null,
        poi: byPlacement.get(s.placement) || '',
      }
    }).sort((a, b) => a.placement - b.placement)
    const dropPoints = page.scoreboard.map((s) => ({
      team: s.team,
      placement: s.placement,
      poi: byPlacement.get(s.placement) || '',
      x: page.teamData.find((t) => t.team === s.team)?.x ?? null,
      y: page.teamData.find((t) => t.team === s.team)?.y ?? null,
    }))

    const data = {
      season: ev.season,
      league: ev.league,
      region: ev.region,
      day: parseInt(day, 10),
      group,
      hash,
      gameNo: page.gameNo,
      map,
      scoreboard: page.scoreboard,
      roster: page.roster,
      teamColors: page.teamColors,
      survival,
      killEvents,
      teamfights,
      damageTimeline,
      teamTimeline,
      playerDamage,
      dropPoints,
      rings: timeline?.rings || [],
      fetchedAt: new Date().toISOString(),
    }
    gameDetailCache.set(cacheKey, { at: Date.now(), data })
    res.json(data)
  } catch (err) {
    next(err)
  }
})

// GET /api/algs/overview — 赛事总览（无快照时抓取；快照超过 30 分钟自动重抓，失败则回退旧快照）
router.get('/overview', async (req, res, next) => {
  try {
    const ev = parseEvent(req)
    let snapshot = await getAlgsSnapshot(ev.season, ev.league, ev.region)
    const stale = snapshot && (Date.now() - snapshotTimeMs(snapshot.fetchedAt) > SNAPSHOT_STALE_MS)
    if (!snapshot || stale) {
      try {
        const payload = await fetchAlgsOverview(ev.season, ev.league, ev.region)
        const id = await saveAlgsSnapshot(ev.season, ev.league, ev.region, payload)
        snapshot = { id, ...ev, fetchedAt: new Date().toISOString(), payload }
      } catch (err) {
        // 重抓失败：有旧快照就继续用旧的，否则抛错
        if (!snapshot) throw err
      }
    }
    res.json({ ...ev, fetchedAt: snapshot.fetchedAt, ...snapshot.payload })
  } catch (err) {
    next(err)
  }
})

// POST /api/algs/refresh — 手动强制刷新（限流：同事件 10 分钟一次）
router.post('/refresh', async (req, res, next) => {
  try {
    const ev = parseEvent(req)
    const key = `${ev.season}|${ev.league}|${ev.region}`
    const now = Date.now()
    const last = refreshThrottle.get(key) || 0
    if (now - last < REFRESH_WINDOW_MS) {
      const waitMin = Math.ceil((REFRESH_WINDOW_MS - (now - last)) / 60000)
      return res.status(429).json({ error: `刷新过于频繁，请 ${waitMin} 分钟后再试（数据每场比赛后更新，一般无需手动刷新）` })
    }
    refreshThrottle.set(key, now)

    const payload = await fetchAlgsOverview(ev.season, ev.league, ev.region)
    const id = await saveAlgsSnapshot(ev.season, ev.league, ev.region, payload)
    res.json({ message: '数据已刷新', id, ...ev, fetchedAt: new Date().toISOString(), ...payload })
  } catch (err) {
    next(err)
  }
})

// GET /api/algs/snapshots — 历史快照摘要（用于"本轮积分变化"）
router.get('/snapshots', async (req, res, next) => {
  try {
    const ev = parseEvent(req)
    const db = getDb()
    const rows = await new Promise((resolve, reject) => {
      db.all(
        'SELECT id, fetched_at, payload FROM algs_snapshots WHERE season = ? AND league = ? AND region = ? ORDER BY id DESC LIMIT 20',
        [ev.season, ev.league, ev.region],
        function onAll(err, result) {
          if (err) return reject(err)
          resolve(result || [])
        },
      )
    })
    const snapshots = rows.map((r) => {
      let standings = []
      try {
        standings = JSON.parse(r.payload).standings || []
      } catch { /* ignore */ }
      return { id: r.id, fetchedAt: r.fetched_at, standings }
    })
    res.json({ snapshots })
  } catch (err) {
    next(err)
  }
})

export default router

// =====================================================================
//  考研政治 · 考点智能判分
//
//  两类教材：
//    · 内置教材 —— 独立 SQLite 文件 kaodian.db（tools/kaodian 离线流水线生成），只读
//    · 用户导入 —— PDF/Word/Excel/MD/TXT 上传后结构化，落主库（kaodian_sources 等三张表）
//  两者通过 sourceId 区分（0 / undefined = 内置）。
//
//  权限：与「微信步数修改」一致，整条链路 requirePremiumOrAdmin。
// =====================================================================
import { Router } from 'express'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import sqlite3 from 'sqlite3'
import multer from 'multer'
import { getDb } from '../config/db.js'
import { authMiddleware, requireAuth } from '../middleware/auth.js'
import { requirePremiumOrAdmin } from '../middleware/access.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { judge, normalizeTruth, normalize } from '../utils/kaodianScoring.js'
import { structureText, splitKeypoints, buildJudgements } from '../utils/kaodianImport.js'
import { adjudicate, loadConfig as loadKaodianLlmConfig, saveConfig as saveKaodianLlmConfig, quotaState, usageSummary, slotOf } from '../utils/kaodianLlm.js'
import { validVariant, MAX_LLM_ANSWER_CHARS } from '../utils/kaodianPrompt.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const KB_PATH = process.env.LCYKSP_KAODIAN_DB
  ? path.resolve(process.env.LCYKSP_KAODIAN_DB)
  : path.resolve(__dirname, '../../data/kaodian.db')

const BUILTIN_TITLE = '27徐涛核心背诵笔记'
// 内置库仅限站长本人调用：其他高级用户看不到这本、也抽不到它的题。
// 可用环境变量覆盖拥有者用户名，默认 lcyksp。
const BUILTIN_OWNER = String(process.env.LCYKSP_KAODIAN_OWNER || 'lcyksp').toLowerCase()
function canUseBuiltin(req) {
  return String(req?.user?.username || '').toLowerCase() === BUILTIN_OWNER
}

// 导入限制
const MAX_SOURCES = 30
const MAX_TEXT_CHARS = 3_000_000
const MAX_POINTS = 800
const MAX_POINT_BODY = 4000

const router = Router()
router.use(authMiddleware)

// ---------- 内置知识库连接 ----------
let kb = null
function getKb() {
  if (kb) return kb
  if (!fs.existsSync(KB_PATH)) return null
  kb = new sqlite3.Database(KB_PATH, sqlite3.OPEN_READWRITE, (err) => {
    if (err) console.error('[考点库] 打开失败:', err.message)
  })
  kb.run('PRAGMA busy_timeout=5000;')
  kb.run('PRAGMA journal_mode=WAL;')
  return kb
}

function wrap(connGetter) {
  const all = (sql, params = []) => new Promise((resolve, reject) => {
    const conn = connGetter()
    if (!conn) return reject(new Error('数据库未就绪'))
    conn.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])))
  })
  const get = (sql, params = []) => new Promise((resolve, reject) => {
    const conn = connGetter()
    if (!conn) return reject(new Error('数据库未就绪'))
    conn.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))
  })
  const run = (sql, params = []) => new Promise((resolve, reject) => {
    const conn = connGetter()
    if (!conn) return reject(new Error('数据库未就绪'))
    conn.run(sql, params, function onRun(err) {
      if (err) return reject(err)
      resolve({ lastID: this.lastID, changes: this.changes })
    })
  })
  return { all, get, run }
}

const K = wrap(getKb)
const D = wrap(getDb)

const safeJson = (s, d = []) => { try { const v = JSON.parse(s || ''); return Array.isArray(v) ? v : d } catch { return d } }

/** sourceId 归一：0 / '0' / '' / undefined / 'builtin' -> 0（内置） */
function normSource(v) {
  if (v === undefined || v === null || v === '' || v === 'builtin' || v === '0' || v === 0) return 0
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : 0
}

/** 校验并取回用户自己的教材（越权一律当成不存在） */
async function ownSource(userId, sourceId) {
  if (!sourceId) return null
  const s = await D.get('SELECT * FROM kaodian_sources WHERE id = ? AND user_id = ?', [sourceId, userId])
  return s || null
}

/** 统一的考点读取：内置库 or 用户库 */
async function loadPoint(req, sourceId, pointId) {
  const userId = req.user.userId
  if (!sourceId) {
    if (!canUseBuiltin(req)) return null   // 内置库仅限站长
    if (!getKb()) return null
    const p = await K.get('SELECT * FROM points WHERE id = ?', [pointId])
    if (!p) return null
    const kps = await K.all('SELECT id, ord, role, weight, text, norm, variants FROM keypoints WHERE point_id = ? ORDER BY ord', [pointId])
    return { point: p, keypoints: kps, kind: 'builtin' }
  }
  const src = await ownSource(userId, sourceId)
  if (!src) return null
  const p = await D.get('SELECT * FROM kaodian_user_points WHERE id = ? AND source_id = ?', [pointId, sourceId])
  if (!p) return null
  const kps = await D.all('SELECT id, ord, role, weight, text, norm, variants FROM kaodian_user_keypoints WHERE point_id = ? ORDER BY ord', [pointId])
  return { point: p, keypoints: kps, kind: 'user' }
}

function questionOf(point) {
  const t = String(point.title || '').trim()
  if (!t) return '请复述这个考点'
  if (/[？?]$/.test(t)) return t
  if (/^(请|简述|试述|论述|说明|谈谈)/.test(t)) return t
  return `请复述考点：${t}`
}

function liteQuestion(p, type, keypointCount, source = 0) {
  return {
    id: p.id,
    type,
    source,
    part: p.part || '',
    chapter: p.chapter || '',
    section: p.section || '',
    no: p.no || '',
    badge: p.badge || '',
    title: p.title,
    statement: type === 'judge' ? (p.statement || '') : undefined,
    question: type === 'recite' ? questionOf(p) : `判断正误：${p.statement}`,
    keypointCount: keypointCount || 0,
  }
}

// ---------- 元信息 ----------
router.get('/meta', requireAuth, async (req, res, next) => {
  try {
    const sources = await D.all(
      `SELECT id, title, file_name, file_type, file_size, status, error, point_count, kp_count, stats, category, created_at
       FROM kaodian_sources WHERE user_id = ? ORDER BY created_at DESC, id DESC`,
      [req.user.userId],
    ).catch(() => [])
    // 内置库仅站长可见；其他用户的列表里根本不出现这本
    const showBuiltin = canUseBuiltin(req)
    const list = showBuiltin ? [{ id: 0, title: BUILTIN_TITLE, builtin: true, pointCount: 0, chapters: [] }] : []
    if (showBuiltin && getKb()) {
      const total = await K.get('SELECT COUNT(*) AS n FROM points').catch(() => null)
      list[0].pointCount = total?.n || 0
      list[0].chapters = await K.all(
        `SELECT chapter, COUNT(*) AS n FROM points WHERE chapter IS NOT NULL AND chapter != ''
         GROUP BY chapter ORDER BY MIN(id)`,
      ).catch(() => [])
    } else if (showBuiltin) {
      list[0].missing = true
    }
    for (const s of sources) {
      list.push({
        id: s.id, title: s.title, builtin: false,
        fileName: s.file_name, fileType: s.file_type, fileSize: s.file_size,
        status: s.status, error: s.error, category: s.category || '',
        pointCount: s.point_count, keypointCount: s.kp_count,
        stats: safeJson(s.stats, {}), createdAt: s.created_at,
        chapters: await D.all(
          `SELECT chapter, COUNT(*) AS n FROM kaodian_user_points
           WHERE source_id = ? AND chapter != '' GROUP BY chapter ORDER BY MIN(ord)`,
          [s.id],
        ).catch(() => []),
      })
    }
    // 分类聚合：出题时可以"选一个分类"= 该分类下所有教材一起抽题
    const catMap = new Map()
    for (const s of sources) {
      const name = (s.category || '').trim() || '未分类'
      const cur = catMap.get(name) || { name, count: 0, pointCount: 0, sources: [], empty: (s.category || '').trim() === '' }
      cur.count += 1
      cur.pointCount += s.point_count || 0
      cur.sources.push(s.id)
      catMap.set(name, cur)
    }
    const categories = [...catMap.values()].sort((a, b) => b.pointCount - a.pointCount)
    res.json({
      ready: showBuiltin && Boolean(getKb()),
      total: showBuiltin ? (list[0].pointCount || 0) : 0,
      sources: list,
      categories,
      limits: { maxSources: MAX_SOURCES, maxTextChars: MAX_TEXT_CHARS, maxPoints: MAX_POINTS },
      premium: ['admin', 'premium', 'pro'].includes(req.user.role),
    })
  } catch (err) { next(err) }
})

// ---------- 出题（绝不返回答案）----------
// 范围三选一：source（内置 0 / 单本 id）、category（分类下所有教材一起抽）
router.get('/quiz', requireAuth, requirePremiumOrAdmin, async (req, res, next) => {
  try {
    const count = Math.min(Math.max(Number(req.query.count) || 5, 1), 30)
    const type = req.query.type === 'judge' ? 'judge' : 'recite'
    const sourceId = normSource(req.query.source)
    const category = String(req.query.category || '').trim().slice(0, 30)
    const chapter = String(req.query.chapter || '')
    const section = String(req.query.section || '')

    let questions = []
    let respCategory = ''

    if (category && !sourceId) {
      // ── 分类模式：该分类下所有教材一起抽，题目自带 source（判分要按题取教材）──
      const srcs = await D.all(
        `SELECT id FROM kaodian_sources
         WHERE user_id = ? AND COALESCE(NULLIF(TRIM(category), ''), '未分类') = ?`,
        [req.user.userId, category],
      )
      if (!srcs.length) return res.status(404).json({ error: '该分类下还没有教材' })
      const ids = srcs.map((s) => s.id)
      const ph = ids.map(() => '?').join(',')
      const where = [`p.source_id IN (${ph})`]
      const params = [...ids]
      if (chapter) { where.push('p.chapter = ?'); params.push(chapter) }
      if (section) { where.push('p.section = ?'); params.push(section) }
      const wsql = where.join(' AND ')
      if (type === 'recite') {
        const rows = await D.all(
          `SELECT p.id, p.source_id, p.chapter, p.section, p.no, p.badge, p.title,
                  (SELECT COUNT(*) FROM kaodian_user_keypoints k WHERE k.point_id = p.id) AS kp_count
           FROM kaodian_user_points p
           WHERE ${wsql} AND LENGTH(p.body) >= 10 AND LENGTH(p.body) < 4000
             AND (SELECT COUNT(*) FROM kaodian_user_keypoints k WHERE k.point_id = p.id) > 0
           ORDER BY RANDOM() LIMIT ?`, [...params, count])
        questions = rows.filter((r) => r.kp_count > 0).map((r) => liteQuestion(r, type, r.kp_count, r.source_id))
      } else {
        const rows = await D.all(
          `SELECT p.id, p.source_id, p.chapter, p.section, p.no, p.badge, p.title,
                  json_extract(j.value, '$.s') AS statement
           FROM kaodian_user_points p, json_each(p.judgements) j
           WHERE ${wsql} ORDER BY RANDOM() LIMIT ?`, [...params, count])
        questions = rows.filter((r) => r.statement).map((r) => liteQuestion(r, type, 0, r.source_id))
      }
      respCategory = category
    } else if (!sourceId) {
      if (!canUseBuiltin(req)) return res.status(404).json({ error: '教材不存在' })
      if (!getKb()) return res.status(503).json({ error: '内置考点库尚未部署' })
      // 表格页串行出来的考点语无伦次，一律不出题；正文过短的也没有背诵价值
      const where = ["(p.layout IS NULL OR p.layout = '')", 'LENGTH(p.body) >= 20', 'LENGTH(p.body) < 1500']
      const params = []
      if (chapter) { where.push('p.chapter = ?'); params.push(chapter) }
      if (section) { where.push('p.section = ?'); params.push(section) }
      const wsql = 'WHERE ' + where.join(' AND ')
      if (type === 'recite') {
        const rows = await K.all(
          `SELECT p.id, p.part, p.chapter, p.section, p.no, p.badge, p.title,
                  (SELECT COUNT(*) FROM keypoints k WHERE k.point_id = p.id) AS kp_count
           FROM points p ${wsql} ORDER BY RANDOM() LIMIT ?`, [...params, count])
        questions = rows.filter((r) => r.kp_count > 0).map((r) => liteQuestion(r, type, r.kp_count))
      } else {
        const rows = await K.all(
          `SELECT p.id, p.part, p.chapter, p.section, p.no, p.badge, p.title,
                  json_extract(j.value, '$.s') AS statement
           FROM points p, json_each(p.judgements) j ${wsql} AND 1=1
           ORDER BY RANDOM() LIMIT ?`, [...params, count])
        questions = rows.filter((r) => r.statement).map((r) => liteQuestion(r, type, 0))
      }
    } else {
      const src = await ownSource(req.user.userId, sourceId)
      if (!src) return res.status(404).json({ error: '教材不存在或不属于你' })
      if (type === 'recite') {
        const where = ['source_id = ?', 'LENGTH(body) >= 10', 'LENGTH(body) < 4000',
          '(SELECT COUNT(*) FROM kaodian_user_keypoints k WHERE k.point_id = kaodian_user_points.id) > 0']
        const params = [sourceId]
        if (chapter) { where.push('chapter = ?'); params.push(chapter) }
        if (section) { where.push('section = ?'); params.push(section) }
        const rows = await D.all(
          `SELECT id, chapter, section, no, badge, title, body,
                  (SELECT COUNT(*) FROM kaodian_user_keypoints k WHERE k.point_id = kaodian_user_points.id) AS kp_count
           FROM kaodian_user_points WHERE ${where.join(' AND ')}
           ORDER BY RANDOM() LIMIT ?`, [...params, count])
        questions = rows.map((r) => liteQuestion(r, type, r.kp_count, sourceId))
      } else {
        // 判断正误：从考点自带的辨析句里抽
        const where = ['p.source_id = ?', "json_array_length(p.judgements) > 0"]
        const params = [sourceId]
        if (chapter) { where.push('p.chapter = ?'); params.push(chapter) }
        if (section) { where.push('p.section = ?'); params.push(section) }
        const rows = await D.all(
          `SELECT p.id, p.source_id, p.chapter, p.section, p.no, p.badge, p.title,
                  json_extract(j.value, '$.s') AS statement
           FROM kaodian_user_points p, json_each(p.judgements) j
           WHERE ${where.join(' AND ')}
           ORDER BY RANDOM() LIMIT ?`, [...params, count])
        questions = rows.filter((r) => r.statement).map((r) => liteQuestion(r, type, 0, r.source_id))
      }
    }
    res.json({ source: sourceId, category: respCategory, questions })
  } catch (err) { next(err) }
})

// ---------- 考点详情（含标准答案，用于「查看答案」）----------
router.get('/points/:id', requireAuth, requirePremiumOrAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'ID 无效' })
    const sourceId = normSource(req.query.source)
    const found = await loadPoint(req, sourceId, id)
    if (!found) return res.status(404).json({ error: '考点不存在' })
    const { point: p, keypoints: kps } = found
    res.json({
      id: p.id, source: sourceId,
      part: p.part || '', chapter: p.chapter || '', section: p.section || '',
      no: p.no || '', badge: p.badge || '', title: p.title, question: questionOf(p),
      body: p.body || '', thinking: p.thinking || '',
      keypoints: kps.map((k) => ({ id: k.id, ord: k.ord, role: k.role, weight: k.weight, text: k.text })),
      judgements: safeJson(p.judgements),
      pageFrom: p.page_from || null, pageTo: p.page_to || null,
    })
  } catch (err) { next(err) }
})

// ---------- 判分 ----------
router.post('/score', requireAuth, requirePremiumOrAdmin, async (req, res, next) => {
  try {
    const id = Number(req.body?.pointId)
    const answer = String(req.body?.answer ?? '').trim()
    const useLlm = req.body?.useLlm !== false
    const sourceId = normSource(req.body?.source)
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '考点 ID 无效' })
    if (!answer) return res.status(400).json({ error: '请先作答' })
    if (answer.length > 5000) return res.status(400).json({ error: '回答过长' })

    const found = await loadPoint(req, sourceId, id)
    if (!found) return res.status(404).json({ error: '考点不存在' })
    const { point: p, keypoints: kpRows } = found

    const keypoints = kpRows.map((k) => ({
      id: k.id, text: k.text, norm: k.norm, weight: k.weight, role: k.role,
      variants: safeJson(k.variants),
    }))

    let llm = null
    if (useLlm) {
      const cfg = await loadKaodianLlmConfig()
      // 注入式第三级：算法层只在"疑似/大面积未命中"时才会真的调它
      llm = (req3) => adjudicate({ ...req3, userId: req.user.userId, sourceId, cfg })
      if (answer.length > MAX_LLM_ANSWER_CHARS) {
        // 超长作答不送模型（省 token，也降低被当通用代理用的空间）；算法层照常判分
        console.warn('[考点判分] 作答超过语义复核上限，跳过第三级 len=', answer.length)
      }
    }

    let result = await judge({ question: questionOf(p), keypoints, userAnswer: answer, adjudicate: llm, maxScore: 10 })
    if (result.llmError && !['injection', 'user_daily_limit', 'daily_limit'].includes(result.llmError)) {
      console.warn('[考点判分] 语义复核不可用:', result.llmError)
    }

    // 自学习：把模型认可的同义表述沉淀进 variants。
    // ⚠️ 只写用户**自己导入**的教材 —— 内置知识库是全体共享的，让用户作答去改它等于投毒。
    // 并且必须校验该表述确实出现在用户作答里（validVariant），防止模型被诱导写入垃圾。
    if (sourceId && result.learned?.length) {
      for (const l of result.learned) {
        const kp = keypoints[l.index]
        if (!kp) continue
        if (!validVariant(l.variant, answer, normalize)) continue
        const v = String(l.variant).trim().slice(0, 40)
        if (kp.variants.includes(v)) continue
        kp.variants.push(v)
        await D.run('UPDATE kaodian_user_keypoints SET variants = ? WHERE id = ?',
          [JSON.stringify(kp.variants.slice(-20)), kp.id]).catch(() => {})
      }
    }

    await D.run(
      `INSERT INTO kaodian_attempts (user_id, point_id, answer, score, detail, llm_used, source_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.user.userId, id, answer.slice(0, 2000), result.score,
        JSON.stringify(result.results), result.llmUsed ? 1 : 0, sourceId],
    ).catch(() => {})

    res.json({
      score: result.score, maxScore: result.maxScore, ratio: result.ratio,
      results: result.results, missing: result.missing,
      comment: result.comment, followUp: result.followUp, llmUsed: result.llmUsed,
      standard: {
        title: p.title, body: p.body || '', thinking: p.thinking || '',
        judgements: safeJson(p.judgements),
        pageFrom: p.page_from || null, pageTo: p.page_to || null,
      },
    })
  } catch (err) { next(err) }
})

// ---------- 辨析题判分（对/错）----------
router.post('/judge-answer', requireAuth, requirePremiumOrAdmin, async (req, res, next) => {
  try {
    const id = Number(req.body?.pointId)
    const statement = String(req.body?.statement ?? '').trim()
    const answer = String(req.body?.answer ?? '').trim()
    const sourceId = normSource(req.body?.source)
    if (!answer) return res.status(400).json({ error: '请先作答' })
    const found = await loadPoint(req, sourceId, id)
    if (!found) return res.status(404).json({ error: '考点不存在' })
    const list = safeJson(found.point.judgements)
    const item = list.find((x) => String(x.s).trim() === statement)
    if (!item) return res.status(404).json({ error: '未找到该辨析题' })
    const got = normalizeTruth(answer)
    const correct = got === (item.truth ? '对' : '错')
    res.json({ correct, expected: item.truth ? '对' : '错', got: got || '（无法识别）', score: correct ? 10 : 0 })
  } catch (err) { next(err) }
})

// =====================================================================
//  我的教材：上传 / 查看 / 删除
//
//  前端在浏览器里把文件抽成纯文本（PDF 走 pdfjs、Word/Excel 走 JSZip），
//  再把文本 POST 过来 —— 服务端不需要任何 PDF/OOXML 解析依赖，2C2G 小机零负担。
// =====================================================================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024, fieldSize: 8 * 1024 * 1024, fields: 10 },
})

router.get('/sources', requireAuth, requirePremiumOrAdmin, async (req, res, next) => {
  try {
    const rows = await D.all(
      `SELECT id, title, file_name, file_type, file_size, status, error, category, point_count, kp_count, stats, created_at
       FROM kaodian_sources WHERE user_id = ? ORDER BY created_at DESC, id DESC`,
      [req.user.userId],
    )
    res.json({
      sources: rows.map((s) => ({
        id: s.id, title: s.title, fileName: s.file_name, fileType: s.file_type,
        fileSize: s.file_size, status: s.status, error: s.error, category: s.category || '',
        pointCount: s.point_count, keypointCount: s.kp_count,
        stats: safeJson(s.stats, {}), createdAt: s.created_at,
      })),
    })
  } catch (err) { next(err) }
})

// 修改教材信息（标题 / 分类）—— 分类改名后立即影响按分类出题
router.put('/sources/:id', requireAuth, requirePremiumOrAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'ID 无效' })
    const src = await ownSource(req.user.userId, id)
    if (!src) return res.status(404).json({ error: '教材不存在或不属于你' })
    const title = req.body?.title !== undefined
      ? String(req.body.title).trim().slice(0, 60) || src.title
      : src.title
    const category = req.body?.category !== undefined
      ? String(req.body.category).trim().slice(0, 30)
      : (src.category || '')
    await D.run('UPDATE kaodian_sources SET title = ?, category = ? WHERE id = ? AND user_id = ?', [title, category, id, req.user.userId])
    res.json({ ok: true, source: { id, title, category } })
  } catch (err) { next(err) }
})

router.post('/sources', requireAuth, requirePremiumOrAdmin, upload.none(), async (req, res, next) => {
  try {
    const userId = req.user.userId
    const raw = req.body?.text
    const text = typeof raw === 'string' ? raw : ''
    const title = String(req.body?.title || '').trim().slice(0, 60)
    const fileName = String(req.body?.fileName || '').trim().slice(0, 160)
    const fileType = String(req.body?.fileType || '').trim().slice(0, 12).toLowerCase()
    const fileSize = Number(req.body?.fileSize) || 0
    // 分类（分组）：同一用户的同名分类视为一类，出题时可按分类跨教材抽题
    const category = String(req.body?.category || '').trim().slice(0, 30)

    if (!text.trim()) return res.status(400).json({ error: '没有解析到文字内容' })
    if (text.length > MAX_TEXT_CHARS) {
      return res.status(413).json({ error: `文本过长（${text.length} 字），上限 ${MAX_TEXT_CHARS} 字` })
    }
    const cnt = await D.get('SELECT COUNT(*) AS n FROM kaodian_sources WHERE user_id = ?', [userId])
    if ((cnt?.n || 0) >= MAX_SOURCES) {
      return res.status(429).json({ error: `最多只能保留 ${MAX_SOURCES} 本教材，先删掉一些再导入` })
    }

    const { points, stats } = structureText(text)
    const usable = points
      .map((p) => ({ ...p, kps: splitKeypoints(p.body) }))
      .filter((p) => p.title && p.kps.length > 0)
      .slice(0, MAX_POINTS)

    if (!usable.length) {
      return res.status(422).json({
        error: '没能从这份文件里识别出可用于背诵的考点（需要「题干 + 正文答案」）。'
          + '建议用「问：… / 答：…」或「### 考点标题 + 正文」的写法，Excel 请把题干放第一列、答案放第二列。',
        stats,
      })
    }

    const kpTotal = usable.reduce((a, p) => a + p.kps.length, 0)
    const src = await D.run(
      `INSERT INTO kaodian_sources (user_id, title, file_name, file_type, file_size, status, category, point_count, kp_count, stats)
       VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)`,
      [userId, title || fileName.replace(/\.[^.]+$/, '') || '未命名教材', fileName, fileType, fileSize,
        category, usable.length, kpTotal, JSON.stringify(stats)],
    )
    const sourceId = src.lastID

    for (const p of usable) {
      // 判断正误题：书上显式写的优先，没有就用规则从得分点生成错误说法
      const judgements = buildJudgements(p, p.kps.map((k) => k.text), { max: 4 })
      const ins = await D.run(
        `INSERT INTO kaodian_user_points (source_id, user_id, ord, chapter, section, no, badge, title, body, judgements)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sourceId, userId, p.ord, p.chapter || '', p.section || '', p.no || '', p.badge || '',
          String(p.title).slice(0, 120), String(p.body).slice(0, MAX_POINT_BODY), JSON.stringify(judgements)],
      )
      for (const k of p.kps) {
        await D.run(
          `INSERT INTO kaodian_user_keypoints (point_id, ord, role, weight, text, norm, variants)
           VALUES (?, ?, ?, ?, ?, ?, '[]')`,
          [ins.lastID, k.ord, k.role, k.weight, k.text, k.norm],
        )
      }
    }

    res.json({
      ok: true,
      source: {
        id: sourceId, title: title || fileName, fileName, fileType, fileSize, category,
        status: 'ready', pointCount: usable.length, keypointCount: kpTotal,
        stats, createdAt: new Date().toISOString(),
      },
      stats,
    })
  } catch (err) { next(err) }
})

/** 预览：看看这本教材到底抽出了哪些考点（含答案） */
router.get('/sources/:id/preview', requireAuth, requirePremiumOrAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'ID 无效' })
    const src = await ownSource(req.user.userId, id)
    if (!src) return res.status(404).json({ error: '教材不存在或不属于你' })
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 300)
    const offset = Math.max(Number(req.query.offset) || 0, 0)
    const rows = await D.all(
      `SELECT id, ord, chapter, section, no, title, body, judgements,
              (SELECT COUNT(*) FROM kaodian_user_keypoints k WHERE k.point_id = kaodian_user_points.id) AS kp_count
       FROM kaodian_user_points WHERE source_id = ? ORDER BY ord LIMIT ? OFFSET ?`,
      [id, limit, offset],
    )
    res.json({
      source: {
        id: src.id, title: src.title, fileName: src.file_name, fileType: src.file_type,
        fileSize: src.file_size, category: src.category || '',
        pointCount: src.point_count, keypointCount: src.kp_count,
        stats: safeJson(src.stats, {}), createdAt: src.created_at,
      },
      total: src.point_count,
      points: rows.map((r) => ({
        id: r.id, ord: r.ord, chapter: r.chapter, section: r.section,
        no: r.no, title: r.title, body: r.body, keypointCount: r.kp_count,
        judgements: safeJson(r.judgements),
      })),
    })
  } catch (err) { next(err) }
})

router.delete('/sources/:id', requireAuth, requirePremiumOrAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'ID 无效' })
    const src = await ownSource(req.user.userId, id)
    if (!src) return res.status(404).json({ error: '教材不存在或不属于你' })
    // 手动级联（外键 ON DELETE CASCADE 已开，这里双保险）
    await D.run('DELETE FROM kaodian_user_keypoints WHERE point_id IN (SELECT id FROM kaodian_user_points WHERE source_id = ?)', [id])
    await D.run('DELETE FROM kaodian_user_points WHERE source_id = ?', [id])
    await D.run('DELETE FROM kaodian_sources WHERE id = ? AND user_id = ?', [id, req.user.userId])
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// ---------- 答题记录 / 错题本 ----------
router.get('/records', requireAuth, requirePremiumOrAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100)
    const onlyWrong = req.query.wrong === '1'
    const rows = await D.all(
      `SELECT id, point_id, source_id, score, created_at
       FROM kaodian_attempts
       WHERE user_id = ? ${onlyWrong ? 'AND score < 6' : ''}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      [req.user.userId, limit],
    ).catch(() => [])
    const out = []
    for (const r of rows) {
      const sid = r.source_id || 0
      let p = null
      if (sid) {
        p = await D.get('SELECT title, chapter FROM kaodian_user_points WHERE id = ? AND source_id = ?', [r.point_id, sid]).catch(() => null)
      } else {
        p = await K.get('SELECT title, chapter FROM points WHERE id = ?', [r.point_id]).catch(() => null)
      }
      out.push({ ...r, source: sid, title: p?.title || `#${r.point_id}`, chapter: p?.chapter || '' })
    }
    res.json({ records: out })
  } catch (err) { next(err) }
})

// ---------- 语义复核用量 / 成本（仅管理员，含缓存命中率）----------
router.get('/llm-usage', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const cfg = await loadKaodianLlmConfig()
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 60)
    const rows = await usageSummary(days)
    const clockSlot = slotOf()
    res.json({
      slot: clockSlot,                                          // 按北京时间现在落在哪一档
      effectiveSlot: cfg.mode === 'off' ? 'off'
        : (cfg.mode === 'offpeak' || cfg.mode === 'peak') ? cfg.mode : clockSlot,
      mode: cfg.mode,
      models: { offpeak: cfg.offpeak_model, peak: cfg.peak_model },
      configured: {
        offpeak: Boolean(cfg.offpeak_url && cfg.offpeak_model && cfg.offpeak_key),
        peak: Boolean(cfg.peak_url && cfg.peak_model && cfg.peak_key),
      },
      limits: { dailyLimit: cfg.daily_limit, userDailyLimit: cfg.user_daily_limit, maxTokens: cfg.max_tokens },
      // 缓存命中率是这套设计最该盯的指标：命中率越高，输入成本越低
      usage: rows.map((r) => ({
        ...r,
        cacheHitRate: r.prompt ? Number(((r.cached || 0) / r.prompt).toFixed(3)) : 0,
      })),
    })
  } catch (err) { next(err) }
})

// ---------- 语义复核大模型配置：读取（仅管理员，绝不下发 key 明文）----------
router.get('/llm-config', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const cfg = await loadKaodianLlmConfig()
    res.json({
      mode: cfg.mode,
      offpeakUrl: cfg.offpeak_url || '',
      offpeakModel: cfg.offpeak_model || '',
      offpeakKeyConfigured: Boolean(cfg.offpeak_key),
      peakUrl: cfg.peak_url || '',
      peakModel: cfg.peak_model || '',
      peakKeyConfigured: Boolean(cfg.peak_key),
      proxyUrl: cfg.proxy_url || '',
      dailyLimit: cfg.daily_limit,
      userDailyLimit: cfg.user_daily_limit,
      maxTokens: cfg.max_tokens,
      timeoutMs: cfg.timeout_ms,
    })
  } catch (err) { next(err) }
})

// ---------- 语义复核大模型配置：保存（仅管理员；key 留空=保持原值，加密入库）----------
router.post('/llm-config', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const b = req.body || {}
    // 前端字段名(驼峰) -> 存储字段名(下划线)
    const payload = {
      mode: b.mode,
      offpeak_url: b.offpeakUrl, offpeak_model: b.offpeakModel, offpeak_key: b.offpeakKey,
      peak_url: b.peakUrl, peak_model: b.peakModel, peak_key: b.peakKey,
      proxy_url: b.proxyUrl,
      daily_limit: b.dailyLimit, user_daily_limit: b.userDailyLimit,
      max_tokens: b.maxTokens, timeout_ms: b.timeoutMs,
    }
    // 只把前端真的传了的字段交给保存层，避免 undefined 覆盖
    for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k]
    await saveKaodianLlmConfig(payload)
    res.json({ ok: true })
  } catch (err) { next(err) }
})

export default router

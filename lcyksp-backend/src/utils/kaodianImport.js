// =====================================================================
//  用户自建教材：纯文本 -> 结构化考点
//
//  设计前提：**不依赖任何外部服务**。用户上传的教材五花八门，这里用一套
//  确定的、可解释的规则把文本切成「考点 + 得分点」，不调用大模型也能跑通。
//  （后续若要提质，可在此后追加一次大模型复核，但规则层必须是兜底。）
//
//  识别的中间格式（由前端提取器产出，见 lcyksp-front/src/utils/kaodianImport.js）：
//    # / ## / ### 标题      -> 章 / 节 / 考点标题
//    Q: ...  A: ...         -> 问答式考点（问 = 题干，答 = 标准答案）
//    |a|b|                  -> 表格行：第一列题干，第二列答案
//    其余                    -> 正文段落
// =====================================================================
import { normalize } from './kaodianScoring.js'

const RE_HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/
const RE_TABLE_ROW = /^\s*\|(.+)\|\s*$/
const RE_Q = /^\s*(?:问|Q|问题)\s*[:：.、]\s*(.*)$/i
const RE_A = /^\s*(?:答|A|答案)\s*[:：.、]\s*(.*)$/i
const RE_NUM_HEADING = /^\s*(?:第[一二三四五六七八九十百\d]+[章节讲部分]|[（(]?\d+(?:\.\d+)*[)）.、])\s*(\S.*)$/
const RE_BULLET = /^\s*[-*+•·]\s+(.*)$/
// 教材里显式写的辨析/易错句：`辨析：xxx（错）`，没标真值就当"错"（辨析题默认给错误说法）
const RE_JUDGE_LINE = /^\s*(?:辨析|判断|错例|易错|易混|误认为|错误说法|正误)\s*[:：]\s*(.+)$/
const SENT_SPLIT = /(?<=[。！？；])/

/** 得分点拆解：把一段正文切成原子表述。与 tools/kaodian/build_db.py 的 split_keypoints 等价。 */
export function splitKeypoints(body) {
  const out = []
  const seen = new Set()
  const push = (t) => {
    const s = String(t || '').trim().replace(/^[（(]\s*\d+\s*[)）]\s*/, '')
      .replace(/^第[一二三四五六七八九十]+[，,]\s*/, '')
      .replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, '')
      .replace(/^[。；，、\s]+|[。；\s]+$/g, '')
    if (s.length < 6 || seen.has(s)) return
    seen.add(s)
    out.push(s)
  }
  for (const line of String(body || '').split('\n')) {
    const t = line.trim()
    if (!t) continue
    for (const raw of t.split(SENT_SPLIT)) {
      const s = raw.trim()
      if (!s) continue
      if (s.length <= 120) { push(s); continue }
      // 超长句再按逗号粗切，避免整段变成一个巨长得分点
      for (const part of s.split(/[，,]/)) if (part.trim().length >= 8) push(part)
    }
  }
  return out.map((text, i) => ({ ord: i + 1, text, norm: normalize(text), role: 'must', weight: 1.0 }))
}

function firstSentence(text, max = 40) {
  const s = String(text || '').trim().replace(/\s+/g, ' ')
  const m = s.split(SENT_SPLIT)
  let head = (m[0] || s).replace(/[。；，,\s]+$/, '')
  if (head.length > max) head = head.slice(0, max)
  return head || s.slice(0, max)
}

/** 把中间格式文本切成块。 */
function tokenize(rawText) {
  const blocks = []
  const lines = String(rawText || '').replace(/\r\n?/g, '\n').split('\n')
  let para = []
  let tableRows = []
  const flushPara = () => {
    const t = para.join('\n').trim()
    para = []
    if (t) blocks.push({ type: 'para', text: t })
  }
  const flushTable = () => {
    if (tableRows.length) { blocks.push({ type: 'table', rows: tableRows }); tableRows = [] }
  }
  for (const line of lines) {
    const h = RE_HEADING.exec(line)
    if (h) { flushPara(); flushTable(); blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() }); continue }
    const tr = RE_TABLE_ROW.exec(line)
    if (tr) {
      flushPara()
      const cells = tr[1].split('|').map((c) => c.trim())
      if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) tableRows.push(cells)   // 跳过 markdown 分隔行
      continue
    }
    flushTable()
    const q = RE_Q.exec(line)
    if (q) { flushPara(); blocks.push({ type: 'q', text: q[1].trim() }); continue }
    const a = RE_A.exec(line)
    if (a) { flushPara(); blocks.push({ type: 'a', text: a[1].trim() }); continue }
    const j = RE_JUDGE_LINE.exec(line)
    if (j) { flushPara(); blocks.push({ type: 'judge', text: j[1].trim() }); continue }
    if (!line.trim()) { flushPara(); continue }
    const b = RE_BULLET.exec(line)
    para.push(b ? b[1].trim() : line.trim())
  }
  flushPara()
  flushTable()
  return blocks
}

/**
 * 文本 -> 考点数组。
 * @returns {{points:Array, stats:object}}
 */
export function structureText(rawText) {
  const blocks = tokenize(rawText)
  const points = []
  let chapter = ''
  let section = ''
  let cur = null
  let tableRowsTotal = 0
  let qaCount = 0

  // 文档是"有显式结构"还是"纯段落"：决定了段落是"归属当前考点"还是"自己就是一个考点"
  const hasExplicit = blocks.some((b) => {
    if (b.type === 'heading' && b.level >= 3) return true
    if (b.type === 'q') return true
    if (b.type === 'table' && b.rows.some((r) => r.length >= 2)) return true
    if (b.type === 'judge') return true
    if (b.type === 'para' && b.text.length <= 40 && !/[。！？]/.test(b.text) && RE_NUM_HEADING.test(b.text)) return true
    return false
  })

  const push = () => {
    if (cur && cur.title && String(cur.body || '').trim()) points.push(cur)
    cur = null
  }
  const start = (title, no) => {
    push()
    cur = {
      chapter, section, no: no || String(points.length + 1), badge: '',
      title: String(title).trim().slice(0, 80), body: '', judgements: [],
    }
  }
  const paraInto = (text) => {
    if (!cur || !hasExplicit) start(hasExplicit ? firstSentence(text) : firstSentence(text))
    if (cur) cur.body = (cur.body ? cur.body + '\n' : '') + text
  }

  for (const b of blocks) {
    if (b.type === 'heading') {
      if (b.level <= 1) { push(); chapter = b.text; section = '' }
      else if (b.level === 2) { push(); section = b.text }
      else start(b.text)
      continue
    }
    if (b.type === 'q') {
      start(b.text)
      qaCount += 1
      continue
    }
    if (b.type === 'a') {
      if (cur) cur.body = (cur.body ? cur.body + '\n' : '') + b.text
      continue
    }
    if (b.type === 'judge') {
      if (cur) {
        const p = parseTruth(b.text)
        if (p.text) cur.judgements.push({ s: p.text, truth: p.truth, src: 'book' })
      }
      continue
    }
    if (b.type === 'table') {
      tableRowsTotal += b.rows.length
      if (b.rows.some((r) => r.length >= 2)) {
        // 丢掉表头行（"考点|答案"、"问题|要点" 之类）
        const HEADER_RE = /^(考点|知识点|问题|题目|题干|问|答案|答案要点|要点|内容|简述|解释|概念)$/
        const rows = b.rows.filter((row, idx) => {
          if (idx === 0 && row.length >= 2 && row.slice(0, 2).every((c) => HEADER_RE.test(String(c).trim()))) return false
          return !row.every((c) => HEADER_RE.test(String(c).trim()))
        })
        for (const row of rows) {
          if (row.length < 2) continue
          const t = row[0]
          const bodyText = row.slice(1).filter(Boolean).join('；')
          if (!t || !bodyText) continue
          start(t)
          if (cur) cur.body = bodyText
        }
      } else {
        for (const row of b.rows) if (row[0]) paraInto(row[0])
      }
      continue
    }
    const text = b.text
    const num = RE_NUM_HEADING.exec(text)
    if (hasExplicit && num && text.length <= 40 && !/[。！？]/.test(text)) {
      start(num[1])
      continue
    }
    paraInto(text)
  }
  push()

  // 兜底：如果一个考点都没有，按空行切段落
  if (!points.length) {
    for (const seg of String(rawText || '').split(/\n{2,}/)) {
      const t = seg.trim()
      if (t.length < 10) continue
      points.push({
        chapter: '', section: '', no: String(points.length + 1), badge: '',
        title: firstSentence(t), body: t, judgements: [],
      })
    }
  }

  const out = points.map((p, i) => ({
    ...p,
    no: String(i + 1),
    ord: i + 1,
    body: p.body.replace(/\n{2,}/g, '\n').trim(),
  }))
  return {
    points: out,
    stats: {
      blocks: blocks.length,
      tableRows: tableRowsTotal,
      qaPairs: qaCount,
      total: out.length,
      withBody: out.filter((p) => p.body.length >= 20).length,
    },
  }
}

// =====================================================================
//  辨析（判断正误）题
//
//  内置教材的辨析句是从书上扫出来的（389 条）。用户自建教材没有，
//  所以这里走两条路：
//    ① 教材里显式写了 `辨析：xxx` / `错例：xxx` -> 直接用（最可信）
//    ② 没有就**规则生成**：对得分点做一次高置信的反向变换，
//       得到"看起来很像教材原话、但其实说反了"的错误陈述。
//
//  规则只做**明显对立**的变换（否定翻转 / 范围缩小 / 反义词对调 / 关系倒置），
//  不做随意的关键词替换 —— 生成的错句必须一眼能判出是错的，否则宁可不生成。
// =====================================================================

/** 行尾的真值标记：`（错）` `(√)` `×` … 不带标记默认按"错"（辨析题默认给错误说法）。 */
function parseTruth(s) {
  const t = String(s || '').trim()
  const bad = /[（(【\[]?\s*(?:×|✗|X|错|错误|不对|false|F)\s*[）)】\]]?$/
  const good = /[（(【\[]?\s*(?:√|✓|对|正确|true|T)\s*[）)】\]]?$/
  if (bad.test(t)) return { text: t.replace(bad, '').trim(), truth: false }
  if (good.test(t)) return { text: t.replace(good, '').trim(), truth: true }
  return { text: t, truth: false }
}

/**
 * 变换词表。顺序即优先级：先命中先用。
 * 约定：from 必须在句中**首次**出现，且替换后不能与原句雷同、
 * 也不能把 to 本身已经出现过的句子再换一次（否则会造出"生产力适合生产力"这种垃圾）。
 */
const FLIP_WORDS = [
  // ── 否定翻转：最干脆，语义必然相反
  ['属于', '不属于'], ['取决于', '不取决于'], ['来源于', '不来源于'], ['根源于', '不根源于'],
  ['能够', '不能'], ['可以', '不可以'], ['必须', '不必'], ['具有', '不具有'],
  ['包含', '不包含'], ['包括', '不包括'], ['标志着', '不标志着'], ['意味着', '不意味着'],
  ['构成了', '不构成'], ['构成', '不构成'],
  // ── 范围 / 程度
  ['一切', '某些'], ['全部', '部分'], ['任何', '某些'], ['始终', '只在某一阶段'],
  ['唯一', '非唯一'], ['根本上', '表面上'], ['根本', '非根本'],
  ['主要方面', '次要方面'], ['次要方面', '主要方面'], ['主要', '次要'],
  // ── 反义对
  ['唯物主义', '唯心主义'], ['唯心主义', '唯物主义'],
  ['辩证法', '形而上学'], ['形而上学', '辩证法'],
  ['可知论', '不可知论'], ['不可知论', '可知论'],
  ['有限', '无限'], ['无限', '有限'],
  ['绝对', '相对'], ['相对', '绝对'],
  ['必然', '偶然'], ['偶然', '必然'],
  ['普遍', '特殊'], ['特殊', '普遍'],
  ['共性', '个性'], ['个性', '共性'],
  ['感性', '理性'], ['理性', '感性'],
  ['直接', '间接'], ['间接', '直接'],
  ['主动', '被动'], ['被动', '主动'],
  ['肯定', '否定'], ['否定', '肯定'],
  ['内容', '形式'], ['形式', '内容'],
  ['第一性', '第二性'], ['第二性', '第一性'],
]

/**
 * 把一个正确表述翻成"明显错误"的表述。翻不动就返回空串（宁缺勿滥）。
 * @param {string} text
 * @returns {string}
 */
export function flipStatement(text) {
  const s = String(text || '').trim().replace(/\s+/g, '')
  if (s.length < 6 || s.length > 64) return ''

  // ① 关系倒置：A 决定 B -> B 决定 A（哲学/政经里最常见的一类错误说法）
  //    两个约束缺一不可，否则会造出"矛事物的性质决定盾的主要方面"这种垃圾：
  //      · A 必须从句子开头或标点之后开始（不能从词中间切断）；
  //      · A、B 在句中各只出现一次（否则交换后前后句自相矛盾）。
  const RE_DECIDE = /([\u4e00-\u9fa5]{2,6}?)(?:能够|可以|必须|应该|应当|会|要|将|能|可)?决定(?:着|了)?([\u4e00-\u9fa5]{2,6})/g
  let mm
  while ((mm = RE_DECIDE.exec(s))) {
    const prev = mm.index > 0 ? s[mm.index - 1] : ''
    if (prev && !/[,，。；;：:、（）()【】\[\]\s]/.test(prev)) continue
    const a = mm[1]
    const b = mm[2]
    if (/的$/.test(a) || /的$/.test(b)) continue
    if (s.split(a).length !== 2 || s.split(b).length !== 2) continue
    const out = s.slice(0, mm.index) + b + '决定' + a + s.slice(mm.index + mm[0].length)
    if (out !== s && Math.abs(out.length - s.length) <= 6) return out
  }

  // ② 词表替换：命中即停
  for (const [from, to] of FLIP_WORDS) {
    const i = s.indexOf(from)
    if (i < 0) continue
    if (i > 0 && s[i - 1] === '不') continue      // 别造出"不不属于"
    if (s.includes(to)) continue                  // to 已在句里，换了会自相矛盾
    const out = s.slice(0, i) + to + s.slice(i + from.length)
    if (out !== s && Math.abs(out.length - s.length) <= 6) return out
  }

  // ③ 兜底：短判断句直接否定（"真理是主观与客观相符合" -> "…不是…"）
  //    只在这一句里恰好有一个"是"、且本来不含否定词、且句子够短时才用。
  const isPos = s.indexOf('是')
  if (s.length <= 24 && isPos > 0 && s.split('是').length === 2 && !/[不非没]/.test(s)) {
    return s.slice(0, isPos) + '不是' + s.slice(isPos + 1)
  }
  return ''
}

function dedupeKeepOrder(arr) {
  const seen = new Set()
  const out = []
  for (const x of arr) {
    const k = String(x || '').trim()
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out
}

/**
 * 为一个考点生成辨析题（判断正误）。
 * @param {{judgements?:Array}} point 结构化的考点（含书上显式辨析句）
 * @param {string[]} kpTexts 该考点的得分点文本
 * @param {{max?:number}} [opts]
 * @returns {Array<{s:string,truth:boolean,src:string}>}
 */
export function buildJudgements(point, kpTexts, opts = {}) {
  const max = Math.max(1, Number(opts.max) || 4)
  const out = []
  const seen = new Set()
  const push = (s, truth, src) => {
    const t = String(s || '').trim().replace(/\s+/g, '')
    if (!t || t.length < 6 || t.length > 90 || seen.has(t)) return false
    seen.add(t)
    out.push({ s: t, truth: !!truth, src: src || 'rule' })
    return true
  }

  // ① 书上显式写的（最可信，优先占位）
  for (const j of point?.judgements || []) {
    if (out.length >= max) break
    push(j.s, j.truth, j.src || 'book')
  }

  const cands = dedupeKeepOrder(kpTexts || []).filter((s) => s.length >= 6 && s.length <= 64)

  // ② 保真项：得分点原文就是教材原话（正确表述）
  if (out.length < max) {
    const good = cands.find((s) => !/^[不非没]/.test(s))
    if (good) push(good, true, 'rule')
  }

  // ③ 错误项：反向变换，最多 2 条
  let bad = 0
  for (const c of cands) {
    if (out.length >= max || bad >= 2) break
    const f = flipStatement(c)
    if (f && push(f, false, 'rule')) bad++
  }
  return out.slice(0, max)
}

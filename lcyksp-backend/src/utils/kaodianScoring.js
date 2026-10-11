// =====================================================================
//  考点判分引擎（L3）—— 三级融合
//
//  第一级：归一化（规则，零成本）—— 抹平同义/虚词/语序/标点差异
//  第二级：要点覆盖（算法，可解释）—— 逐得分点出结论，天然支持部分分
//  第三级：语义裁决（大模型，兜底 + 讲评）—— 只在"疑似/全灭"时调用
//
//  设计目标：从架构上根除"你写了它说你没写"的字符串精确匹配 bug。
//  与 tools/kaodian/normalize.py 的 normalize() 必须保持等价。
// =====================================================================

const TRAD = {
  '與': '与', '為': '为', '產': '产', '階': '阶', '級': '级', '資': '资', '義': '义',
  '關': '关', '係': '系', '發': '发', '現': '现', '國': '国', '會': '会', '學': '学',
  '說': '说', '對': '对', '錯': '错', '這': '这', '個': '个', '們': '们', '時': '时',
  '間': '间', '無': '无', '動': '动', '變': '变', '從': '从', '來': '来', '過': '过',
  '還': '还', '進': '进', '運': '运', '質': '质', '體': '体', '認': '认', '識': '识',
  '聯': '联', '繫': '系', '統': '统', '獨': '独', '創': '创', '條': '条', '須': '须',
  '應': '应', '當': '当', '於': '于', '後': '后', '將': '将', '並': '并', '讓': '让',
  '給': '给', '種': '种', '類': '类', '別': '别', '總': '总', '結': '结', '構': '构',
  '點': '点', '題': '题', '問': '问', '論': '论', '證': '证', '據': '据', '準': '准',
  '則': '则', '規': '规', '機': '机', '續': '续', '斷': '断', '觀': '观', '釋': '释',
}

// 子串级同义替换（顺序敏感）
const SUB_SYNONYM = [
  ['以及', '和'],
  ['与', '和'],
  ['及', '和'],
  ['之间', ''],
  ['最重要', '最主要'],
  ['必须要', '必须'],
  ['一定要', '必须'],
  ['包含', '包括'],
  ['社会生产力', '生产力'],
  ['之', ''],
  ['的', ''],
]

// eslint-disable-next-line no-useless-escape
const PUNCT_RE = /[\s，。；：、,.;:!！?？"'“”‘’（）()《》【】\[\]{}<>《》\-—–_~`|/\\+*=&%$#@^…·•✓✗√×]/g

export function toSimplified(s) {
  let out = ''
  for (const ch of String(s || '')) out += (TRAD[ch] || ch)
  return out
}

/** 第一级：归一化。JS 版必须与 tools/kaodian/normalize.py 等价。 */
export function normalize(input) {
  if (!input) return ''
  let s = String(input).normalize('NFKC')
  s = toSimplified(s)
  for (const [a, b] of SUB_SYNONYM) s = s.split(a).join(b)
  s = s.replace(PUNCT_RE, '')
  return s.toLowerCase()
}

/** 辨析题：把用户回答归一到 '对' / '错' / ''。 */
export function normalizeTruth(input) {
  const t = normalize(input)
  if (!t) return ''
  if (t.includes('错') || t.includes('不正确') || t.includes('不对')) return '错'
  if (t.includes('对') || t.includes('正确')) return '对'
  return ''
}

/** 按中文标点切句（保留原句，供展示）。 */
export function splitSentences(text) {
  return String(text || '')
    .split(/[。！？；\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 判分用的更细粒度切分：连逗号也切开，避免长句把短得分点的相似度稀释掉。 */
export function splitForMatch(text) {
  return String(text || '')
    .split(/[。！？；，,、\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
}

/** 最长公共子序列比例（≈ difflib.SequenceMatcher.ratio 的轻量替代）。 */
export function lcsRatio(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  const n = a.length, m = b.length
  if (n * m > 400000) return diceBigram(a, b)   // 超长直接降级，避免 O(n*m) 卡死
  let prev = new Uint16Array(m + 1)
  let cur = new Uint16Array(m + 1)
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    const tmp = prev; prev = cur; cur = tmp
    cur.fill(0)
  }
  return (2 * prev[m]) / (n + m)
}

/** 字符二元组 Dice 系数。 */
export function diceBigram(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  const gram = (s) => {
    const m = new Map()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) || 0) + 1)
    }
    return m
  }
  const ga = gram(a), gb = gram(b)
  let inter = 0
  for (const [g, c] of ga) {
    const d = gb.get(g)
    if (d) inter += Math.min(c, d)
  }
  const total = (a.length - 1) + (b.length - 1)
  return total > 0 ? (2 * inter) / total : 0
}

export const HIT = 0.85
export const SUSPECT = 0.6

// 否定标记：用于防止"加了否定词导致相似度虚高"的误判
// （如标准答案「实践是检验真理的唯一标准」被判为命中「实践不是检验真理的唯一标准」）
const NEG_RE = /不|没有|否认|反对|并非|绝非|错误/g

function negCount(s) {
  const m = String(s || '').match(NEG_RE)
  return m ? m.length : 0
}

/**
 * 第二级：要点覆盖。
 * @param {string} userAnswer
 * @param {Array<{text:string,norm?:string,weight?:number,variants?:string[]}>} keypoints
 * @returns {{ratio:number, results:Array, needsLlm:boolean, allMiss:boolean}}
 */
export function scoreRecite(userAnswer, keypoints) {
  const ua = normalize(userAnswer)
  const sents = splitForMatch(userAnswer).map(normalize).filter((s) => s.length >= 2)
  const results = []
  let totalW = 0
  let gotW = 0

  for (const kp of keypoints) {
    const w = Number(kp.weight) > 0 ? Number(kp.weight) : 1
    totalW += w
    const kn = kp.norm || normalize(kp.text)
    let verdict = 'miss'
    let best = 0
    let evidence = ''

    if (kn && ua.includes(kn)) {
      verdict = 'hit'; best = 1; evidence = kp.text
    } else {
      const variants = Array.isArray(kp.variants) ? kp.variants : []
      for (const v of variants) {
        const vn = normalize(v)
        if (vn && ua.includes(vn)) { verdict = 'hit'; best = 1; evidence = String(v); break }
      }
      if (verdict !== 'hit') {
        for (const s of sents) {
          const sim = Math.max(lcsRatio(kn, s), diceBigram(kn, s))
          if (sim > best) { best = sim; evidence = s }
        }
        if (best >= HIT) verdict = 'hit'
        else if (best >= SUSPECT) verdict = 'suspect'
        else verdict = 'miss'
        // 否定词不一致 -> 即使字面很像也不能算命中，降级交给第三级
        if (verdict === 'hit' && negCount(kn) !== negCount(evidence)) verdict = 'suspect'
      }
    }
    if (verdict === 'hit') gotW += w
    results.push({
      keypoint: kp.text,
      verdict,
      sim: Number(best.toFixed(3)),
      evidence: verdict === 'hit' ? '' : evidence,
    })
  }

  const ratio = totalW > 0 ? gotW / totalW : 0
  return {
    ratio,
    results,
    needsLlm: results.some((r) => r.verdict === 'suspect'),
    allMiss: results.length > 0 && results.every((r) => r.verdict !== 'hit'),
  }
}

/** 把第二级结果转成 0~10 的分数（保留一位小数）。 */
export function toScore(ratio, maxScore = 10) {
  return Math.round(ratio * maxScore * 10) / 10
}

// ---------------------------------------------------------------------
//  第三级：语义裁决
// ---------------------------------------------------------------------

/** 第三级不可用时给用户看的话（不暴露上游细节，也不带 key）。 */
const LLM_REASON_TEXT = {
  unconfigured: '未配置语义复核模型',
  injection: '作答含无关指令，已跳过语义复核',
  daily_limit: '今日语义复核额度已用完',
  user_daily_limit: '你今天的语义复核次数已用完',
  timeout: '语义复核超时',
  network: '语义复核网络异常',
  bad_output: '语义复核未返回可用结果',
}

/**
 * 完整判分：第二级打底，必要时调用第三级语义裁决。
 *
 * @param {object} opts
 * @param {string} opts.question
 * @param {Array}  opts.keypoints
 * @param {string} opts.userAnswer
 * @param {(req:{question:string,suspects:Array,answer:string})=>Promise<{ok:boolean,reason?:string,results?:Array,overall?:string,missing?:string[]}>} [opts.adjudicate]
 *        注入式第三级（见 utils/kaodianLlm.js 的 adjudicate）。不传 = 只跑算法，零成本。
 * @param {number} [opts.maxScore]
 */
export async function judge({ question, keypoints, userAnswer, adjudicate: adjudicator, maxScore = 10 }) {
  const level2 = scoreRecite(userAnswer, keypoints)
  let llmUsed = false
  let llmError = ''
  let comment = ''
  let missing = []
  const learned = []

  const needLlm = Boolean(adjudicator) && (level2.needsLlm || level2.ratio < 0.34)
  if (needLlm) {
    // 只把「疑似/未命中」的点送模型：明确命中的不送 —— 既省 token（输入按量计费），
    // 也避免模型把算法已经算对的点误杀。
    const suspects = []
    level2.results.forEach((r, i) => {
      if (r.verdict === 'hit') return
      suspects.push({
        index: i,
        text: keypoints[i]?.text || r.keypoint,
        candidates: r.evidence ? [r.evidence] : [],
      })
    })
    if (!suspects.length) {
      // 理论上不会走到（needsLlm 说明有疑似），留个保险
    } else {
      try {
        const out = await adjudicator({ question, suspects, answer: userAnswer })
        if (out?.ok) {
          const allowed = new Set(suspects.map((s) => s.index))
          for (const item of out.results || []) {
            const idx = Number(item.index)
            if (!allowed.has(idx)) continue          // 只接受我们送过去的那些点
            const r = level2.results[idx]
            if (!r) continue
            if (item.verdict === 'hit' || item.verdict === 'synonym_hit') {
              r.verdict = 'hit'
              if (item.verdict === 'synonym_hit' && item.evidence) {
                learned.push({ index: idx, variant: item.evidence })
              }
            } else {
              r.verdict = 'miss'
            }
            r.comment = item.comment || ''
          }
          comment = out.overall || ''
          missing = Array.isArray(out.missing) ? out.missing.filter(Boolean) : []
          llmUsed = true
          let totalW = 0
          let gotW = 0
          keypoints.forEach((kp, i) => {
            const w = Number(kp.weight) > 0 ? Number(kp.weight) : 1
            totalW += w
            if (level2.results[i].verdict === 'hit') gotW += w
          })
          level2.ratio = totalW > 0 ? gotW / totalW : 0
        } else {
          llmError = out?.reason || 'unavailable'
        }
      } catch (e) {
        llmError = 'exception'
        console.error('[考点判分] 语义裁决异常:', e?.message || e)
      }
    }
  }

  if (!comment) {
    const hitN = level2.results.filter((r) => r.verdict === 'hit').length
    const total = level2.results.length
    if (hitN === total && total > 0) comment = '全部得分点均已答到，很棒！'
    else comment = `共 ${total} 个得分点，已答到 ${hitN} 个。`
    if (llmError) comment += `（${LLM_REASON_TEXT[llmError] || '语义复核暂不可用'}，已按算法结果判定）`
  }
  if (!missing.length) missing = level2.results.filter((r) => r.verdict !== 'hit').map((r) => r.keypoint)

  return {
    score: toScore(level2.ratio, maxScore),
    maxScore,
    ratio: level2.ratio,
    results: level2.results,
    missing,
    comment,
    followUp: '',
    llmUsed,
    llmError,
    needsLlm: Boolean(needLlm),
    learned,
  }
}

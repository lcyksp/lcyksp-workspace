// 本地端到端冒烟：造一个 admin 用户 -> 签 token -> 打 /api/kaodian 全链路
// 用法: node scripts/local-kaodian-e2e.mjs  (需先启动本地后端 PORT=3999)
import sqlite3 from 'sqlite3'
import jwt from 'jsonwebtoken'
import path from 'node:path'

const PORT = process.env.PORT || 3999
const BASE = `http://127.0.0.1:${PORT}`
const DB = path.resolve(process.env.LCYKSP_DB_DIR || './data/db', 'database.db')
const SECRET = process.env.JWT_SECRET || 'lcyksp-jwt-secret-dev-2026'

const db = await new Promise((res, rej) => {
  const d = new sqlite3.Database(DB, (e) => (e ? rej(e) : res(d)))
})
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this) }))
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))))

await run(`INSERT INTO users (username, password, role, quota_plan) VALUES ('lcyksp','x','admin','admin')
           ON CONFLICT(username) DO UPDATE SET role='admin', quota_plan='admin'`)
const u = await get(`SELECT id FROM users WHERE username='lcyksp'`)
const token = jwt.sign({ userId: u.id, username: 'lcyksp' }, SECRET, { expiresIn: '1d' })
await new Promise((r) => db.close(r))

const H = { Authorization: `Bearer ${token}` }
const call = async (p, opt = {}) => {
  const r = await fetch(BASE + p, { ...opt, headers: { ...H, 'Content-Type': 'application/json' } })
  return { status: r.status, body: await r.json().catch(() => null) }
}

const meta = await call('/api/kaodian/meta')
console.log('meta:', meta.status, 'total=', meta.body?.total, 'chapters=', meta.body?.chapters?.length)

const quiz = await call('/api/kaodian/quiz?count=3&type=recite')
console.log('quiz:', quiz.status, JSON.stringify(quiz.body?.questions?.map((q) => q.question)))
if (!quiz.body?.questions?.length) process.exit(1)

const q = quiz.body.questions[0]
const detail = await call(`/api/kaodian/points/${q.id}`)
console.log('detail:', detail.status, 'title=', detail.body?.title, 'kps=', detail.body?.keypoints?.length)
console.log('  标准答案片段:', (detail.body?.body || '').slice(0, 60))

// 用标准答案原文作答 -> 期望接近满分
const r1 = await call('/api/kaodian/score', { method: 'POST', body: JSON.stringify({ pointId: q.id, answer: detail.body.body }) })
console.log('score(标准答案原文):', r1.status, r1.body?.score, 'llmUsed=', r1.body?.llmUsed)

// 只答第一个得分点 -> 期望部分分
const first = detail.body.keypoints[0]?.text || ''
const r2 = await call('/api/kaodian/score', { method: 'POST', body: JSON.stringify({ pointId: q.id, answer: first }) })
console.log('score(只答第一点):', r2.status, r2.body?.score, 'missing=', r2.body?.missing?.length)

// 用「与/和」变体作答 -> 期望命中（回归截图 bug）
const variant = first.replace(/和/g, '与').replace(/的/g, '')
const r3 = await call('/api/kaodian/score', { method: 'POST', body: JSON.stringify({ pointId: q.id, answer: variant }) })
console.log('score(改成与/去的是):', r3.status, r3.body?.results?.[0]?.verdict)

const judge = await call('/api/kaodian/quiz?count=2&type=judge')
console.log('judge quiz:', judge.status, JSON.stringify(judge.body?.questions?.map((x) => x.statement)))
if (judge.body?.questions?.length) {
  const jq = judge.body.questions[0]
  const jr = await call('/api/kaodian/judge-answer', { method: 'POST', body: JSON.stringify({ pointId: jq.id, statement: jq.statement, answer: '我认为这句话是对的' }) })
  console.log('judge-answer:', jr.status, JSON.stringify(jr.body))
}

const rec = await call('/api/kaodian/records?limit=5')
console.log('records:', rec.status, rec.body?.records?.length)

// ================= 我的教材（导入/分类/辨析/删除）=================
console.log('\n--- 我的教材 ---')
const sample = [
  '问：近代中国最主要的矛盾是什么？',
  '答：帝国主义和中华民族的矛盾。它是近代中国各种矛盾中最主要的矛盾。',
  '',
  '问：实践是检验真理的唯一标准吗？',
  '答：是的。实践是检验真理的唯一标准，这是由真理的本性和实践的特点决定的。',
  '',
  '问：物质和意识的关系是什么？',
  '答：物质决定意识，意识对物质具有反作用。',
].join('\n')

const sample2 = [
  '问：矛盾普遍性和特殊性的关系是什么？',
  '答：矛盾的普遍性与特殊性相互联结，普遍性寓于特殊性之中。',
  '',
  '问：认识的两次飞跃分别是什么？',
  '答：第一次飞跃是从感性认识到理性认识，第二次飞跃是从理性认识到实践。',
].join('\n')

async function uploadSample(title, category, text) {
  const fd = new FormData()
  fd.append('title', title)
  fd.append('category', category)
  fd.append('fileName', title + '.txt')
  fd.append('fileType', 'txt')
  fd.append('fileSize', String(Buffer.byteLength(text, 'utf8')))
  fd.append('text', text)
  const r = await fetch(BASE + '/api/kaodian/sources', { method: 'POST', headers: H, body: fd })
  return { status: r.status, body: await r.json().catch(() => null) }
}

const up = await uploadSample('e2e 政治册', '政治', sample)
console.log('upload(政治):', up.status, 'points=', up.body?.source?.pointCount, 'cat=', up.body?.source?.category, up.body?.error || '')
if (up.status !== 200) process.exit(1)
const sid = up.body.source.id

const up2 = await uploadSample('e2e 政治补充', '政治', sample2)
console.log('upload(政治2):', up2.status, 'points=', up2.body?.source?.pointCount, up2.body?.error || '')
const sid2 = up2.status === 200 ? up2.body.source.id : 0

// meta 聚合出分类
const meta3 = await call('/api/kaodian/meta')
console.log('categories:', JSON.stringify(meta3.body?.categories))
const cat = meta3.body?.categories?.find((c) => c.name === '政治')
if (!cat || cat.count < 2) { console.log('!! 分类聚合失败'); process.exit(1) }

// 按分类跨教材出题：题目应自带 source
const cq = await call(`/api/kaodian/quiz?category=${encodeURIComponent('政治')}&count=6&type=recite`)
const cqSrcs = [...new Set((cq.body?.questions || []).map((q) => q.source))]
console.log('quiz(按分类):', cq.status, '题数=', cq.body?.questions?.length, '涉及教材=', cqSrcs.join(','), '(期望跨多本)')
if (cq.body?.questions?.some((q) => !q.source)) { console.log('!! 分类题目缺 source'); process.exit(1) }

// 按分类出判断题
const cj = await call(`/api/kaodian/quiz?category=${encodeURIComponent('政治')}&count=6&type=judge`)
console.log('judge(按分类):', cj.status, '题数=', cj.body?.questions?.length,
  JSON.stringify((cj.body?.questions || []).map((q) => q.statement?.slice(0, 24))))

// 单本判断题 + judge-answer
const sj = await call(`/api/kaodian/quiz?source=${sid}&count=4&type=judge`)
console.log('judge(单本):', sj.status, '题数=', sj.body?.questions?.length,
  JSON.stringify((sj.body?.questions || []).map((q) => `${q.statement?.slice(0, 18)}(${q.source})`)))
if (sj.body?.questions?.length) {
  const jq = sj.body.questions[0]
  // 先从 preview 拿这条的真值，分别验证判对/判错
  const pvAll = await call(`/api/kaodian/sources/${sid}/preview?limit=50`)
  const pt = (pvAll.body?.points || []).find((p) => (p.judgements || []).some((x) => x.s === jq.statement))
  const truth = pt?.judgements?.find((x) => x.s === jq.statement)?.truth
  const ans = truth ? '对，这句话是正确的' : '错，这个说法不对'
  const jr = await call('/api/kaodian/judge-answer', { method: 'POST', body: JSON.stringify({ pointId: jq.id, source: jq.source, statement: jq.statement, answer: ans }) })
  console.log('judge-answer:', jr.status, 'correct=', jr.body?.correct, '(期望 true, truth=' + truth + ')')
  if (!jr.body?.correct) { console.log('!! 判分与真值不符'); process.exit(1) }
}

// 单本背诵题照常
const q2 = await call(`/api/kaodian/quiz?source=${sid}&count=5`)
console.log('quiz(我的教材):', q2.status, '题数=', q2.body?.questions?.length)
const uq = q2.body?.questions?.[0]
const du = await call(`/api/kaodian/points/${uq.id}?source=${sid}`)
const kp0 = du.body.keypoints[0].text
const variant2 = kp0.replace(/和/g, '与').replace(/的/g, '')
const s2 = await call('/api/kaodian/score', { method: 'POST', body: JSON.stringify({ pointId: uq.id, source: sid, answer: variant2 }) })
console.log('score(变体):', s2.status, s2.body?.results?.[0]?.verdict, 'score=', s2.body?.score)

// 改分类：政治 -> 数学，meta 应跟着变
const put = await call(`/api/kaodian/sources/${sid}`, { method: 'PUT', body: JSON.stringify({ category: '数学' }) })
console.log('改分类:', put.status, JSON.stringify(put.body?.source))
const meta4 = await call('/api/kaodian/meta')
console.log('改后 categories:', JSON.stringify(meta4.body?.categories?.map((c) => `${c.name}:${c.count}`)))
// 改回去
await call(`/api/kaodian/sources/${sid}`, { method: 'PUT', body: JSON.stringify({ category: '政治' }) })

// 越权：不存在的教材应 404
const bad = await call(`/api/kaodian/quiz?source=999999&count=2`)
console.log('越权/不存在教材:', bad.status, '(期望 404)')

for (const id of [sid, sid2].filter(Boolean)) {
  const del = await call(`/api/kaodian/sources/${id}`, { method: 'DELETE' })
  console.log('delete', id, ':', del.status)
}
const after = await call('/api/kaodian/sources')
console.log('delete 后 sources=', after.body?.sources?.length)
const del2 = await call(`/api/kaodian/sources/${sid}`, { method: 'DELETE' })
console.log('重复删除:', del2.status, '(期望 404)')

console.log('\nE2E DONE')

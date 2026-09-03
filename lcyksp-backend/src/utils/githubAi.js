import { decrypt } from './crypto.js'
import { normalizeEndpoint } from './llmEndpoint.js'
import { getDb } from '../config/db.js'
import { ProxyAgent } from 'undici'

const aiProxy = String(process.env.GITHUB_PROXY_URL || '').trim()
const dispatcher = aiProxy ? new ProxyAgent(aiProxy) : undefined
const rpmWindows = new Map()
async function acquireModelSlot(model) {
  if (!/gpt-5\.6-luna/i.test(String(model || ''))) return
  while (true) {
    const now = Date.now()
    const recent = (rpmWindows.get(model) || []).filter((time) => now - time < 60000)
    if (recent.length < 10) { recent.push(now); rpmWindows.set(model, recent); return }
    const waitMs = Math.max(250, 60000 - (now - recent[0]) + 25)
    console.log(`[GitHub Radar] RPM limit waiting model=${model} waitMs=${waitMs}`)
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }
}
function dbAll(sql, params = []) { return new Promise((resolve, reject) => getDb().all(sql, params, (e, rows) => e ? reject(e) : resolve(rows || []))) }
function dbRun(sql, params = []) { return new Promise((resolve, reject) => getDb().run(sql, params, function onRun(e) { e ? reject(e) : resolve({ lastID: this.lastID }) })) }
async function loadConfig() {
  const rows = await dbAll("SELECT key,value FROM system_config WHERE key IN ('llm_url','llm_model','llm_key','github_ai_fallback_url','github_ai_fallback_model','github_ai_fallback_key')")
  const c = Object.fromEntries(rows.map((r) => [r.key, r.value])); if (!c.llm_key) return null
  return { url: (c.llm_url || '').replace(/\/$/, ''), model: c.llm_model || '', key: decrypt(c.llm_key), fallback: c.github_ai_fallback_key ? { url: (c.github_ai_fallback_url || '').replace(/\/$/, ''), model: c.github_ai_fallback_model || '', key: decrypt(c.github_ai_fallback_key) } : null }
}
function parse(value) { const text = String(value || '').trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim(); try { return JSON.parse(text) } catch { return null } }
async function callModel(url, key, model, prompt) {
  await acquireModelSlot(model)
  const endpoint = normalizeEndpoint(url)
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify({ model, temperature: 0.1, messages: [{ role: 'user', content: prompt }] }), ...(dispatcher ? { dispatcher } : {}), signal: AbortSignal.timeout(45000) })
  const data = response.ok ? await response.json() : null
  const content = data?.choices?.[0]?.message?.content || ''
  return { response, content, parsed: parse(content) }
}
export async function reviewGithubRepository(repository, { codeContext = false } = {}) {
  const config = await loadConfig(); if (!config?.url || !config.key || !config.model) return null
  const basePrompt = ['你是 GitHub 技术趋势简报编辑。只输出 JSON，不要 Markdown。', '{"worthPush":true,"category":"不超过12字","summary":"必须使用简体中文，2-4句话，约120-260字，说明项目解决的问题、技术路线或主要特点","confidence":0.0}', '请根据以下仓库信息判断是否值得推送。摘要必须是自然的中文技术新闻简报；不要保留英文原句，不要使用夸张宣传语。', '仓库：' + repository.full_name, '描述：' + (repository.description || '无'), '语言：' + (repository.language || '未知'), 'Topics：' + JSON.stringify(repository.topics || []), 'Star：' + repository.stars, 'README：' + (repository.readme || '无')].join('\n')
  const prompt = codeContext ? basePrompt + '\n源码片段：\n' + String(repository.codeContext || '').slice(0, 9000) : basePrompt
  let provider = 'primary'; let model = config.model; let result = await callModel(config.url, config.key, model, prompt)
  const confidence = Number(result.parsed?.confidence || 0)
  if ((!result.response.ok || !result.parsed || confidence < 0.55) && config.fallback?.url && config.fallback.key && config.fallback.model) { provider = 'fallback'; model = config.fallback.model; result = await callModel(config.fallback.url, config.fallback.key, model, basePrompt + '\n主模型结果置信度不足，请结合以下源码片段复核：\n' + String(repository.codeContext || '').slice(0, 9000)) }
  if (!result.response.ok) throw new Error('AI HTTP ' + result.response.status)
  if (!result.parsed) throw new Error('AI 返回格式无法解析')
  const finalConfidence = Math.max(0, Math.min(1, Number(result.parsed.confidence) || 0))
  const summary = String(result.parsed.summary || '').replace(/[*_#`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 320)
  const review = await dbRun('INSERT INTO github_ai_reviews (repository_id, provider, model, category, summary, confidence, worth_push, raw_output) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [repository.id, provider, model, String(result.parsed.category || '').slice(0, 40), summary, finalConfidence, result.parsed.worthPush ? 1 : 0, result.content.slice(0, 10000)])
  await dbRun('UPDATE github_repositories SET last_ai_review_id = ?, updated_at = ? WHERE id = ?', [review.lastID, new Date().toISOString(), repository.id])
  console.log(`[GitHub Radar] AI review success repo=${repository.full_name} provider=${provider} confidence=${finalConfidence}`)
  return { id: review.lastID, worthPush: Boolean(result.parsed.worthPush), confidence: finalConfidence }
}

export async function reviewGithubSubscriptionRelevance(repository, focus) {
  const config = await loadConfig(); if (!config?.url || !config.key || !config.model) return null
  const relevanceThreshold = 0.85
  const prompt = [
    '你是 GitHub 技术趋势的严格选题编辑。只输出 JSON，不要 Markdown。',
    '{"relevant":true,"confidence":0.0,"reason":"不超过80字的中文判断依据"}',
    '判断仓库是否直接、明确地符合订阅方向。只有仓库的核心用途或核心技术属于该方向时 relevant 才能为 true。',
    '仅在 README、描述或摘要里顺带提到关键词，或只是通用工具、泛化资源清单、泛化教程合集、纯算法论文时，必须判为 false。',
    '高度垂直且可直接用于该方向的应用、插件、提示词工程、模板库或技术资产可以判为 true，不能仅因为仓库名含 awesome 就否决。',
    'AI 方向包括大模型应用、Agent、RAG、MCP、提示词工程、AI生成创作、图像/视频生成、多模态应用、AI编程工具、Coding Agent/Harness、Claude Code/Codex 工具和 Skill 技能生态；排除无直接关系的普通开发工具。',
    'Trending 排名只能提高审核优先级，不能替代订阅关键词和方向判断；不符合订阅方向时必须判为 false。',
    '机械材料方向尤其要求直接涉及机械设计制造、增材制造、材料与机械自动化、材料科学、材料成型、SolidWorks、机器人、CAD/CAE 或工业制造。',
    '订阅方向：' + JSON.stringify(focus.names || []),
    '方向说明：' + JSON.stringify(focus.descriptions || []),
    '订阅关键词：' + JSON.stringify(focus.keywords || []),
    '仓库：' + repository.full_name,
    '描述：' + (repository.description || '无'),
    '语言：' + (repository.language || '未知'),
    'Topics：' + JSON.stringify(repository.topics || []),
    '已有中文摘要：' + (repository.summary || '无'),
  ].join('\n')
  let provider = 'primary'; let model = config.model; let result = await callModel(config.url, config.key, model, prompt)
  const confidence = Number(result.parsed?.confidence || 0)
  if ((!result.response.ok || !result.parsed || confidence < relevanceThreshold) && config.fallback?.url && config.fallback.key && config.fallback.model) {
    provider = 'fallback'; model = config.fallback.model
    result = await callModel(config.fallback.url, config.fallback.key, model, prompt + '\n主模型判断不够确定，请更严格地复核。')
  }
  if (!result.response.ok) throw new Error('AI relevance HTTP ' + result.response.status)
  if (!result.parsed || typeof result.parsed.relevant !== 'boolean') throw new Error('AI 相关性返回格式无法解析')
  const finalConfidence = Math.max(0, Math.min(1, Number(result.parsed.confidence) || 0))
  const relevant = result.parsed.relevant === true && finalConfidence >= relevanceThreshold
  return { relevant, confidence: finalConfidence, reason: String(result.parsed.reason || '').replace(/[*_#`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160), provider, model }
}

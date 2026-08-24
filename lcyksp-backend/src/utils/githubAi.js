import { decrypt } from './crypto.js'
import { getDb } from '../config/db.js'
import { ProxyAgent } from 'undici'

const aiProxy = String(process.env.GITHUB_PROXY_URL || '').trim()
const dispatcher = aiProxy ? new ProxyAgent(aiProxy) : undefined
function dbAll(sql, params = []) { return new Promise((resolve, reject) => getDb().all(sql, params, (e, rows) => e ? reject(e) : resolve(rows || []))) }
function dbRun(sql, params = []) { return new Promise((resolve, reject) => getDb().run(sql, params, function onRun(e) { e ? reject(e) : resolve({ lastID: this.lastID }) })) }
async function loadConfig() {
  const rows = await dbAll("SELECT key,value FROM system_config WHERE key IN ('llm_url','llm_model','llm_key','github_ai_fallback_url','github_ai_fallback_model','github_ai_fallback_key')")
  const c = Object.fromEntries(rows.map((r) => [r.key, r.value])); if (!c.llm_key) return null
  return { url: (c.llm_url || '').replace(/\/$/, ''), model: c.llm_model || '', key: decrypt(c.llm_key), fallback: c.github_ai_fallback_key ? { url: (c.github_ai_fallback_url || '').replace(/\/$/, ''), model: c.github_ai_fallback_model || '', key: decrypt(c.github_ai_fallback_key) } : null }
}
function parse(value) { const text = String(value || '').trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim(); try { return JSON.parse(text) } catch { return null } }
async function callModel(url, key, model, prompt) {
  const endpoint = url.endsWith('/chat/completions') ? url : url + '/chat/completions'
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify({ model, temperature: 0.1, messages: [{ role: 'user', content: prompt }] }), ...(dispatcher ? { dispatcher } : {}), signal: AbortSignal.timeout(45000) })
  const data = response.ok ? await response.json() : null
  const content = data?.choices?.[0]?.message?.content || ''
  return { response, content, parsed: parse(content) }
}
export async function reviewGithubRepository(repository, { codeContext = false } = {}) {
  const config = await loadConfig(); if (!config?.url || !config.key || !config.model) return null
  const basePrompt = ['你是 GitHub 技术趋势简报编辑。只输出 JSON，不要 Markdown。', '{"worthPush":true,"category":"不超过12字","summary":"不超过45字","confidence":0.0}', '请根据以下仓库信息判断是否值得推送。', '仓库：' + repository.full_name, '描述：' + (repository.description || '无'), '语言：' + (repository.language || '未知'), 'Topics：' + JSON.stringify(repository.topics || []), 'Star：' + repository.stars, 'README：' + (repository.readme || '无')].join('\n')
  const prompt = codeContext ? basePrompt + '\n源码片段：\n' + String(repository.codeContext || '').slice(0, 9000) : basePrompt
  let provider = 'primary'; let model = config.model; let result = await callModel(config.url, config.key, model, prompt)
  const confidence = Number(result.parsed?.confidence || 0)
  if ((!result.response.ok || !result.parsed || confidence < 0.55) && config.fallback?.url && config.fallback.key && config.fallback.model) { provider = 'fallback'; model = config.fallback.model; result = await callModel(config.fallback.url, config.fallback.key, model, basePrompt + '\n主模型结果置信度不足，请结合以下源码片段复核：\n' + String(repository.codeContext || '').slice(0, 9000)) }
  if (!result.response.ok) throw new Error('AI HTTP ' + result.response.status)
  if (!result.parsed) throw new Error('AI 返回格式无法解析')
  const finalConfidence = Math.max(0, Math.min(1, Number(result.parsed.confidence) || 0))
  const review = await dbRun('INSERT INTO github_ai_reviews (repository_id, provider, model, category, summary, confidence, worth_push, raw_output) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [repository.id, provider, model, String(result.parsed.category || '').slice(0, 40), String(result.parsed.summary || '').replace(/[*_#`]/g, '').slice(0, 180), finalConfidence, result.parsed.worthPush ? 1 : 0, result.content.slice(0, 10000)])
  await dbRun('UPDATE github_repositories SET last_ai_review_id = ?, updated_at = ? WHERE id = ?', [review.lastID, new Date().toISOString(), repository.id])
  console.log(`[GitHub Radar] AI review success repo=${repository.full_name} provider=${provider} confidence=${finalConfidence}`)
  return { id: review.lastID, worthPush: Boolean(result.parsed.worthPush), confidence: finalConfidence }
}

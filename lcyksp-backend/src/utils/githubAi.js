import { decrypt } from './crypto.js'
import { getDb } from '../config/db.js'

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => getDb().run(sql, params, function onRun(err) {
    if (err) return reject(err)
    resolve({ lastID: this.lastID, changes: this.changes })
  }))
}

async function loadConfig() {
  const rows = await new Promise((resolve, reject) => getDb().all("SELECT key, value FROM system_config WHERE key IN ('llm_url', 'llm_model', 'llm_key', 'github_ai_fallback_url', 'github_ai_fallback_model', 'github_ai_fallback_key')", (err, data) => err ? reject(err) : resolve(data || [])))
  const config = Object.fromEntries(rows.map((row) => [row.key, row.value]))
  if (!config.llm_key) return null
  return {
    url: (config.llm_url || 'https://api.deepseek.com').replace(/\/$/, ''),
    model: config.llm_model || 'deepseek-chat',
    key: decrypt(config.llm_key),
    fallback: config.github_ai_fallback_key ? {
      url: (config.github_ai_fallback_url || '').replace(/\/$/, ''),
      model: config.github_ai_fallback_model || '',
      key: decrypt(config.github_ai_fallback_key),
    } : null,
  }
}

function parseJsonResponse(value) {
  const text = String(value || '').trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim()
  try { return JSON.parse(text) } catch { return null }
}

export async function reviewGithubRepository(repository) {
  const config = await loadConfig()
  if (!config) return null
  const targetUrl = config.url.endsWith('/chat/completions') ? config.url : config.url + '/chat/completions'
  const prompt = [
    '你是 GitHub 技术趋势简报编辑。根据仓库信息判断它是否值得推送。',
    '只输出 JSON，不要 Markdown：{"worthPush":true,"category":"不超过12字","summary":"不超过45字","confidence":0.0}',
    '仓库：' + repository.full_name,
    '描述：' + (repository.description || '无'),
    '语言：' + (repository.language || '未知'),
    'Topics：' + repository.topics,
    'Star：' + repository.stars,
  ].join('\n')
  let provider = 'openai-compatible'
  let model = config.model
  let response = await fetch(targetUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.key }, body: JSON.stringify({ model, temperature: 0.1, messages: [{ role: 'user', content: prompt }] }) })
  if ((!response.ok || response.status >= 400) && config.fallback?.key && config.fallback.url && config.fallback.model) {
    provider = 'fallback'
    model = config.fallback.model
    const fallbackUrl = config.fallback.url.endsWith('/chat/completions') ? config.fallback.url : config.fallback.url + '/chat/completions'
    response = await fetch(fallbackUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.fallback.key }, body: JSON.stringify({ model, temperature: 0.1, messages: [{ role: 'user', content: prompt }] }) })
  }
  if (!response.ok) throw new Error('AI HTTP ' + response.status)
  const data = await response.json()
  const content = data?.choices?.[0]?.message?.content || ''
  const parsed = parseJsonResponse(content)
  if (!parsed) throw new Error('AI 返回格式无法解析')
  const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0))
  const result = await dbRun('INSERT INTO github_ai_reviews (repository_id, provider, model, category, summary, confidence, worth_push, raw_output) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [repository.id, provider, model, String(parsed.category || '').slice(0, 40), String(parsed.summary || '').slice(0, 180), confidence, parsed.worthPush ? 1 : 0, content.slice(0, 10000)])
  await dbRun('UPDATE github_repositories SET last_ai_review_id = ?, updated_at = ? WHERE id = ?', [result.lastID, new Date().toISOString(), repository.id])
  return { id: result.lastID, worthPush: Boolean(parsed.worthPush), category: parsed.category || '', summary: parsed.summary || '', confidence }
}

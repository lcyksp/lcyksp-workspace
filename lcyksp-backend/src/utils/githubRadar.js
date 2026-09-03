import { getDb } from '../config/db.js'
import { decrypt } from './crypto.js'
import { ProxyAgent } from 'undici'

const GITHUB_API = process.env.GITHUB_API_URL || 'https://api.github.com'
const USER_AGENT = 'lcyksp-github-trend-radar'
const GITHUB_TIMEOUT_MS = Number(process.env.GITHUB_REQUEST_TIMEOUT_MS || 20000)
const GITHUB_PROXY_URL = String(process.env.GITHUB_PROXY_URL || '').trim()
const githubDispatcher = GITHUB_PROXY_URL ? new ProxyAgent(GITHUB_PROXY_URL) : undefined
const trendingCache = new Map()
const searchCache = new Map()
let githubApiCooldownUntil = 0
export const MIN_GITHUB_STARS = 100
const AMBIGUOUS_SEARCH_TERMS = new Set(['机械', '材料', '机器人', 'skill', 'code'])

function dbGet(sql, params = []) { return new Promise((resolve, reject) => getDb().get(sql, params, (e, row) => e ? reject(e) : resolve(row))) }
function dbAll(sql, params = []) { return new Promise((resolve, reject) => getDb().all(sql, params, (e, rows) => e ? reject(e) : resolve(rows || []))) }
function dbRun(sql, params = []) { return new Promise((resolve, reject) => getDb().run(sql, params, function onRun(e) { e ? reject(e) : resolve({ lastID: this.lastID, changes: this.changes }) })) }
function parseJson(value, fallback) { try { return JSON.parse(value) } catch { return fallback } }

export async function fetchTrendingGithubRepositories({ since = 'daily', limit = 25 } = {}) {
  const cacheKey = since + ':' + limit
  const cached = trendingCache.get(cacheKey)
  if (cached && Date.now() - cached.at < 15 * 60 * 1000) return cached.items
  const response = await fetch('https://github.com/trending?since=' + encodeURIComponent(since), {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    ...(githubDispatcher ? { dispatcher: githubDispatcher } : {}),
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error('GitHub Trending ' + response.status)
  const html = await response.text()
  const items = []
  const articlePattern = /<article class="Box-row">([\s\S]*?)<\/article>/g
  let match
  while ((match = articlePattern.exec(html)) && items.length < limit) {
    const block = match[1]
    const repoMatch = block.match(/<h2[^>]*>[\s\S]*?href="\/([^"/?]+\/[^"/?]+)"/i)
    if (!repoMatch || repoMatch[1].toLowerCase().startsWith('sponsors/')) continue
    const fullName = repoMatch[1]
    const description = (block.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim()
    const language = (block.match(/itemprop="programmingLanguage">\s*([^<]+)/)?.[1] || '').trim()
    const starsText = (block.match(/href="\/[^"/]+\/[^"/]+\/stargazers"[^>]*>[\s\S]*?<\/a>/)?.[0] || '').replace(/<[^>]+>/g, ' ').replace(/,/g, ' ').trim()
    const starNumbers = [...starsText.matchAll(/\d+/g)].map((m) => Number(m[0])).filter(Number.isFinite)
    const stars = starNumbers.at(-1) || 0
    if (stars < MIN_GITHUB_STARS) continue
    items.push({ fullName, url: 'https://github.com/' + fullName, description, language, topics: [], stars, forks: 0, trending: true, trendingRank: items.length + 1, trendingSince: since })
  }
  trendingCache.set(cacheKey, { at: Date.now(), items })
  return items
}

async function githubFetch(path, params = {}) {
  if (Date.now() < githubApiCooldownUntil) throw new Error('GitHub API temporarily cooled down after rate limit')
  const tokenRow = await dbGet("SELECT value FROM system_config WHERE key = 'github_token'")
  const token = process.env.GITHUB_TOKEN || (tokenRow?.value ? decrypt(tokenRow.value) : '')
  const url = new URL(path, GITHUB_API)
  Object.entries(params).forEach(([key, value]) => value !== undefined && url.searchParams.set(key, value))
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': USER_AGENT,
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
        ...(githubDispatcher ? { dispatcher: githubDispatcher } : {}),
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error('GitHub API ' + response.status + ': ' + await response.text())
      return response.json()
    } catch (error) {
      lastError = error
      if (String(error?.message || '').includes('GitHub API 401') || String(error?.message || '').includes('GitHub API 403')) {
        if (String(error?.message || '').includes('GitHub API 403')) githubApiCooldownUntil = Date.now() + 15 * 60 * 1000
        throw error
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
    }
  }
  throw lastError
}

export async function discoverGithubRepositories({ query = '', categoryKeywords = [], language = '', limit = 30 } = {}) {
  const directQuery = String(query || '').trim()
  const categoryTerms = [...new Set(categoryKeywords.map((item) => String(item || '').trim()).filter(Boolean).filter((item) => item !== directQuery && !AMBIGUOUS_SEARCH_TERMS.has(item.toLowerCase())))]
  const slots = Math.max(0, 4 - (directQuery ? 1 : 0))
  const cycle = Math.floor(Date.now() / (4 * 60 * 60 * 1000))
  const start = categoryTerms.length ? (cycle * Math.max(1, slots)) % categoryTerms.length : 0
  const rotatedTerms = Array.from({ length: Math.min(slots, categoryTerms.length) }, (_, index) => categoryTerms[(start + index) % categoryTerms.length])
  const selectedTerms = [...(directQuery ? [directQuery] : []), ...rotatedTerms]
  const groups = selectedTerms.length ? selectedTerms.map((term) => [term]) : [[]]
  const cacheKey = JSON.stringify({ selectedTerms, language, limit })
  const cached = searchCache.get(cacheKey)
  if (cached && Date.now() - cached.at < 30 * 60 * 1000) return cached.items
  const results = []
  for (const group of groups) {
    const termQuery = group.length > 1 ? '(' + group.map((item) => '\"' + item + '\"').join(' OR ') + ')' : group.map((item) => '\"' + item + '\"').join(' ')
    const q = [termQuery, 'in:name,description,readme', language ? 'language:' + language : '', 'stars:>=100'].filter(Boolean).join(' ')
    if (!q) continue
    const data = await githubFetch('/search/repositories', { q, sort: 'stars', order: 'desc', per_page: Math.min(limit, 100) })
    results.push(...(data.items || []))
  }
  const items = results.map((item) => ({
    fullName: item.full_name,
    url: item.html_url,
    description: item.description || '',
    language: item.language || '',
    topics: item.topics || [],
    stars: item.stargazers_count || 0,
    forks: item.forks_count || 0,
  }))
  searchCache.set(cacheKey, { at: Date.now(), items })
  return items
}

export async function discoverEmergingGithubRepositories({ keywords = [], limit = 30 } = {}) {
  const cacheKey = 'emerging:' + JSON.stringify({ keywords: keywords.slice(0, 8), limit })
  const cached = searchCache.get(cacheKey)
  if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) return cached.items
  const terms = [...new Set(keywords.map((item) => String(item || '').trim()).filter(Boolean))]
  const since = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10)
  const results = []
  for (const group of (terms.length ? terms.slice(0, 4) : ['']).map((term) => [term])) {
    const termQuery = group.filter(Boolean).map((item) => item.replace(/[\"']/g, '')).join(' ')
    const q = [termQuery, 'in:name,description,readme', 'created:>=' + since, 'stars:>=100'].filter(Boolean).join(' ')
    const data = await githubFetch('/search/repositories', { q, sort: 'updated', order: 'desc', per_page: Math.min(limit, 100) })
    results.push(...(data.items || []))
  }
  const items = [...new Map(results.map((item) => [item.full_name, item])).values()].map((item) => ({ fullName: item.full_name, url: item.html_url, description: item.description || '', language: item.language || '', topics: item.topics || [], stars: item.stargazers_count || 0, forks: item.forks_count || 0 }))
  searchCache.set(cacheKey, { at: Date.now(), items })
  return items
}

export async function fetchGithubRepositoryContext(fullName, { includeCode = false } = {}) {
  const repo = await githubFetch('/repos/' + fullName)
  let readme = ''
  try {
    const data = await githubFetch('/repos/' + fullName + '/readme')
    readme = Buffer.from(data.content || '', 'base64').toString('utf8').slice(0, 18000)
  } catch {}
  let rootEntries = []
  let codeContext = ''
  if (!includeCode) return { ...repo, readme, rootEntries, codeContext }
  try {
    const data = await githubFetch('/repos/' + fullName + '/contents')
    const entries = (Array.isArray(data) ? data : []).slice(0, 80)
    rootEntries = entries.map((item) => item.name)
    const candidates = entries.filter((item) => item.type === 'file' && /\.(js|ts|jsx|tsx|py|go|rs|java|kt|swift|cpp|c|h|cs|php|rb|vue|md)$/i.test(item.name)).slice(0, 3)
    const snippets = []
    for (const item of candidates) {
      try {
        const file = await githubFetch('/repos/' + fullName + '/contents/' + encodeURIComponent(item.name))
        const text = Buffer.from(file.content || '', 'base64').toString('utf8').slice(0, 3500)
        if (text) snippets.push('--- ' + item.name + ' ---\n' + text)
      } catch {}
      if (snippets.join('\n').length >= 10000) break
    }
    codeContext = snippets.join('\n').slice(0, 10000)
  } catch {}
  return { ...repo, readme, rootEntries, codeContext }
}

async function upsertRepository(item, capturedAt) {
  const existing = await dbGet('SELECT id FROM github_repositories WHERE full_name = ?', [item.fullName])
  if (existing) {
    await dbRun('UPDATE github_repositories SET url = ?, description = ?, language = ?, topics = ?, stars = ?, forks = ?, last_seen_at = ?, updated_at = ? WHERE id = ?', [item.url, item.description, item.language, JSON.stringify(item.topics), item.stars, item.forks, capturedAt, capturedAt, existing.id])
    if (item.trending) await dbRun('UPDATE github_repositories SET trending_rank = ?, trending_since = ?, trending_seen_at = ? WHERE id = ?', [item.trendingRank || null, item.trendingSince || '', capturedAt, existing.id])
    return { id: existing.id, isNew: false }
  }
  const result = await dbRun('INSERT INTO github_repositories (full_name, url, description, language, topics, stars, forks, trending_rank, trending_since, trending_seen_at, first_seen_at, last_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [item.fullName, item.url, item.description, item.language, JSON.stringify(item.topics), item.stars, item.forks, item.trending ? item.trendingRank || null : null, item.trending ? item.trendingSince || '' : '', item.trending ? capturedAt : null, capturedAt, capturedAt, capturedAt])
  return { id: result.lastID, isNew: true }
}

export async function saveGithubSnapshot(item, capturedAt = new Date().toISOString()) {
  if (Number(item.stars || 0) < MIN_GITHUB_STARS) return { id: null, isNew: false, skipped: true }
  const repository = await upsertRepository(item, capturedAt)
  await dbRun('INSERT OR IGNORE INTO github_star_snapshots (repository_id, stars, captured_at) VALUES (?, ?, ?)', [repository.id, item.stars, capturedAt])
  return repository
}

export async function calculateGithubGrowth(repositoryId, now = new Date()) {
  const rows = await dbAll('SELECT stars, captured_at FROM github_star_snapshots WHERE repository_id = ? ORDER BY captured_at DESC LIMIT 100', [repositoryId])
  const current = rows[0]
  if (!current) return { daily: null, weekly: null, monthly: null, observed: null, latestCapturedAt: null }
  const findBefore = (days) => rows.find((row) => now.getTime() - new Date(row.captured_at).getTime() >= days * 86400000)
  const delta = (row) => row ? Math.max(0, current.stars - row.stars) : null
  const currentAge = now.getTime() - new Date(current.captured_at).getTime()
  const freshDelta = (days, maxAgeDays) => currentAge <= maxAgeDays * 86400000 ? delta(findBefore(days)) : null
  const observed = rows.length > 1 ? Math.max(0, Math.max(...rows.map((row) => row.stars)) - Math.min(...rows.map((row) => row.stars))) : null
  return { daily: freshDelta(1, 1.5), weekly: freshDelta(7, 8), monthly: freshDelta(30, 31), observed, currentStars: current.stars, latestCapturedAt: current.captured_at }
}

export async function getRepositoryCandidatesForSubscription(subscription) {
  const categoryIds = parseJson(subscription.category_ids, []).map(Number).filter(Number.isInteger)
  const keywords = parseJson(subscription.keywords, [])
  const placeholders = categoryIds.map(() => '?').join(',')
  const categories = categoryIds.length ? await dbAll('SELECT name, description, keywords, languages FROM github_categories WHERE id IN (' + placeholders + ')', categoryIds) : []
  const categoryKeywords = categories.flatMap((row) => parseJson(row.keywords, []))
  const languages = categories.flatMap((row) => parseJson(row.languages, []))
  const results = []
  for (const language of [...new Set(['', ...languages])].slice(0, 3)) {
    results.push(...await discoverGithubRepositories({ query: keywords[0] || '', categoryKeywords: [...keywords.slice(1), ...categoryKeywords], language, limit: 20 }))
  }
  return [...new Map(results.map((item) => [item.fullName, item])).values()]
}

export async function getGithubSubscriptionFocus(subscription) {
  const categoryIds = parseJson(subscription.category_ids, []).map(Number).filter(Number.isInteger)
  const placeholders = categoryIds.map(() => '?').join(',')
  const categories = categoryIds.length ? await dbAll('SELECT name, description, keywords FROM github_categories WHERE id IN (' + placeholders + ')', categoryIds) : []
  return {
    names: categories.map((row) => row.name),
    descriptions: categories.map((row) => row.description).filter(Boolean),
    keywords: [...new Set([...parseJson(subscription.keywords, []), ...categories.flatMap((row) => parseJson(row.keywords, []))])],
  }
}

import { getDb } from '../config/db.js'
import { decrypt } from './crypto.js'

const GITHUB_API = process.env.GITHUB_API_URL || 'https://api.github.com'
const USER_AGENT = 'lcyksp-github-trend-radar'

function dbGet(sql, params = []) { return new Promise((resolve, reject) => getDb().get(sql, params, (e, row) => e ? reject(e) : resolve(row))) }
function dbAll(sql, params = []) { return new Promise((resolve, reject) => getDb().all(sql, params, (e, rows) => e ? reject(e) : resolve(rows || []))) }
function dbRun(sql, params = []) { return new Promise((resolve, reject) => getDb().run(sql, params, function onRun(e) { e ? reject(e) : resolve({ lastID: this.lastID, changes: this.changes }) })) }
function parseJson(value, fallback) { try { return JSON.parse(value) } catch { return fallback } }

async function githubFetch(path, params = {}) {
  const tokenRow = await dbGet("SELECT value FROM system_config WHERE key = 'github_token'")
  const token = process.env.GITHUB_TOKEN || (tokenRow?.value ? decrypt(tokenRow.value) : '')
  const url = new URL(path, GITHUB_API)
  Object.entries(params).forEach(([key, value]) => value !== undefined && url.searchParams.set(key, value))
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
  })
  if (!response.ok) throw new Error('GitHub API ' + response.status + ': ' + await response.text())
  return response.json()
}

export async function discoverGithubRepositories({ query = '', categoryKeywords = [], language = '', limit = 30 } = {}) {
  const terms = [...new Set([query, ...categoryKeywords].map((item) => String(item || '').trim()).filter(Boolean))]
  const termQuery = terms.length > 1 ? '(' + terms.map((item) => '\"' + item + '\"').join(' OR ') + ')' : terms.map((item) => '\"' + item + '\"').join(' ')
  const q = [termQuery, 'in:name,description,readme', language ? 'language:' + language : '', 'stars:>=20'].filter(Boolean).join(' ')
  if (!q) return []
  const data = await githubFetch('/search/repositories', { q, sort: 'stars', order: 'desc', per_page: Math.min(limit, 100) })
  return (data.items || []).map((item) => ({
    fullName: item.full_name,
    url: item.html_url,
    description: item.description || '',
    language: item.language || '',
    topics: item.topics || [],
    stars: item.stargazers_count || 0,
    forks: item.forks_count || 0,
  }))
}

export async function discoverEmergingGithubRepositories({ keywords = [], limit = 30 } = {}) {
  const terms = [...new Set(keywords.map((item) => String(item || '').trim()).filter(Boolean))]
  const termQuery = terms.length ? '(' + terms.map((item) => '\"' + item + '\"').join(' OR ') + ')' : ''
  const since = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10)
  const q = [termQuery, 'in:name,description,readme', 'created:>=' + since, 'stars:>=10'].filter(Boolean).join(' ')
  if (!q) return []
  const data = await githubFetch('/search/repositories', { q, sort: 'updated', order: 'desc', per_page: Math.min(limit, 100) })
  return (data.items || []).map((item) => ({ fullName: item.full_name, url: item.html_url, description: item.description || '', language: item.language || '', topics: item.topics || [], stars: item.stargazers_count || 0, forks: item.forks_count || 0 }))
}

export async function fetchGithubRepositoryContext(fullName) {
  const repo = await githubFetch('/repos/' + fullName)
  let readme = ''
  try {
    const data = await githubFetch('/repos/' + fullName + '/readme')
    readme = Buffer.from(data.content || '', 'base64').toString('utf8').slice(0, 18000)
  } catch {}
  let rootEntries = []
  try {
    const data = await githubFetch('/repos/' + fullName + '/contents')
    rootEntries = (Array.isArray(data) ? data : []).slice(0, 80).map((item) => item.name)
  } catch {}
  return { ...repo, readme, rootEntries }
}

async function upsertRepository(item, capturedAt) {
  const existing = await dbGet('SELECT id FROM github_repositories WHERE full_name = ?', [item.fullName])
  if (existing) {
    await dbRun('UPDATE github_repositories SET url = ?, description = ?, language = ?, topics = ?, stars = ?, forks = ?, last_seen_at = ?, updated_at = ? WHERE id = ?', [item.url, item.description, item.language, JSON.stringify(item.topics), item.stars, item.forks, capturedAt, capturedAt, existing.id])
    return { id: existing.id, isNew: false }
  }
  const result = await dbRun('INSERT INTO github_repositories (full_name, url, description, language, topics, stars, forks, first_seen_at, last_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [item.fullName, item.url, item.description, item.language, JSON.stringify(item.topics), item.stars, item.forks, capturedAt, capturedAt, capturedAt])
  return { id: result.lastID, isNew: true }
}

export async function saveGithubSnapshot(item, capturedAt = new Date().toISOString()) {
  const repository = await upsertRepository(item, capturedAt)
  await dbRun('INSERT OR IGNORE INTO github_star_snapshots (repository_id, stars, captured_at) VALUES (?, ?, ?)', [repository.id, item.stars, capturedAt])
  return repository
}

export async function calculateGithubGrowth(repositoryId, now = new Date()) {
  const rows = await dbAll('SELECT stars, captured_at FROM github_star_snapshots WHERE repository_id = ? ORDER BY captured_at DESC LIMIT 100', [repositoryId])
  const current = rows[0]
  if (!current) return { daily: null, weekly: null, monthly: null }
  const findBefore = (days) => rows.find((row) => now.getTime() - new Date(row.captured_at).getTime() >= days * 86400000)
  const delta = (row) => row ? Math.max(0, current.stars - row.stars) : null
  return { daily: delta(findBefore(1)), weekly: delta(findBefore(7)), monthly: delta(findBefore(30)), currentStars: current.stars }
}

export async function getRepositoryCandidatesForSubscription(subscription) {
  const categoryIds = parseJson(subscription.category_ids, []).map(Number).filter(Number.isInteger)
  const keywords = parseJson(subscription.keywords, [])
  const placeholders = categoryIds.map(() => '?').join(',')
  const categories = categoryIds.length ? await dbAll('SELECT keywords, languages FROM github_categories WHERE id IN (' + placeholders + ')', categoryIds) : []
  const categoryKeywords = categories.flatMap((row) => parseJson(row.keywords, []))
  const languages = categories.flatMap((row) => parseJson(row.languages, []))
  const results = []
  for (const language of [...new Set(['', ...languages])].slice(0, 5)) {
    results.push(...await discoverGithubRepositories({ query: keywords[0] || '', categoryKeywords: [...keywords.slice(1), ...categoryKeywords], language, limit: 20 }))
  }
  return [...new Map(results.map((item) => [item.fullName, item])).values()]
}

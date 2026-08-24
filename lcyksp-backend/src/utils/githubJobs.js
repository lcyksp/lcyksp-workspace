import { getDb } from '../config/db.js'
import { discoverEmergingGithubRepositories, fetchGithubRepositoryContext, getRepositoryCandidatesForSubscription, saveGithubSnapshot } from './githubRadar.js'
import { reviewGithubRepository } from './githubAi.js'

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => getDb().all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))))
}
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => getDb().run(sql, params, function onRun(err) {
    if (err) return reject(err)
    resolve({ lastID: this.lastID, changes: this.changes })
  }))
}

async function linkRepository(subscriptionId, repositoryId, now) {
  await dbRun(
    'INSERT INTO github_subscription_repositories (subscription_id, repository_id, first_matched_at, last_matched_at) VALUES (?, ?, ?, ?) ON CONFLICT(subscription_id, repository_id) DO UPDATE SET last_matched_at = excluded.last_matched_at',
    [subscriptionId, repositoryId, now, now],
  )
}

export async function discoverActiveGithubSubscriptions() {
  const subscriptions = await dbAll(
    "SELECT * FROM github_subscriptions WHERE status = 'active'",
  )
  let discovered = 0
  for (const subscription of subscriptions) {
    try {
      const candidates = await getRepositoryCandidatesForSubscription(subscription)
      for (const item of candidates) {
        const repository = await saveGithubSnapshot(item)
        await linkRepository(subscription.id, repository.id, new Date().toISOString())
        discovered += 1
      }
      console.log('[GitHub Radar] subscription', subscription.id, 'candidates:', candidates.length)
    } catch (error) {
      console.error('[GitHub Radar] subscription', subscription.id, 'failed:', error.message)
    }
  }
  const globalKeywords = ['AI', 'agent', 'developer tools', 'automation', 'robotics', 'materials science', 'mechanical engineering']
  try {
    const emerging = await discoverEmergingGithubRepositories({ keywords: globalKeywords, limit: 50 })
    for (const item of emerging) await saveGithubSnapshot(item)
    discovered += emerging.length
  } catch (error) {
    console.error('[GitHub Radar] emerging discovery failed:', error.message)
  }
  const reviewQueue = await dbAll(
    `SELECT r.* FROM github_repositories r
     INNER JOIN (SELECT DISTINCT repository_id FROM github_subscription_repositories) matched ON matched.repository_id = r.id
     LEFT JOIN github_ai_reviews a ON a.id = r.last_ai_review_id
     WHERE a.id IS NULL AND (r.updated_at IS NULL OR datetime(replace(r.updated_at, 'T', ' ')) < datetime('now', '-6 hours'))
     ORDER BY r.last_seen_at DESC LIMIT 5`,
  )
  for (const repository of reviewQueue) {
    try {
      console.log('[GitHub Radar] AI review start:', repository.full_name)
      const basicContext = await fetchGithubRepositoryContext(repository.full_name, { includeCode: false })
      const first = await reviewGithubRepository({ ...repository, ...basicContext }, { codeContext: false })
      if (!first || first.confidence < 0.55 || !basicContext.readme) {
        const codeContext = await fetchGithubRepositoryContext(repository.full_name, { includeCode: true })
        await reviewGithubRepository({ ...repository, ...codeContext }, { codeContext: true })
      }
    } catch (error) {
      console.error('[GitHub Radar] AI review failed:', repository.full_name, error.message)
    }
  }
  return { subscriptions: subscriptions.length, discovered }
}

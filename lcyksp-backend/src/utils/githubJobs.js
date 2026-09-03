import { getDb } from '../config/db.js'
import { discoverEmergingGithubRepositories, fetchGithubRepositoryContext, fetchTrendingGithubRepositories, getGithubSubscriptionFocus, getRepositoryCandidatesForSubscription, saveGithubSnapshot, MIN_GITHUB_STARS } from './githubRadar.js'
import { reviewGithubRepository, reviewGithubSubscriptionRelevance } from './githubAi.js'

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
        if (!repository.id) continue
        await linkRepository(subscription.id, repository.id, new Date().toISOString())
        discovered += 1
      }
      console.log('[GitHub Radar] subscription', subscription.id, 'candidates:', candidates.length)
    } catch (error) {
      console.error('[GitHub Radar] subscription', subscription.id, 'failed:', error.message)
    }
  }
  try {
    const trendingSets = await Promise.all(['daily', 'weekly'].map((since) => fetchTrendingGithubRepositories({ since, limit: 15 })))
    const trending = [...new Map(trendingSets.flat().map((item) => [item.fullName, item])).values()]
    for (const item of trending) {
      const repository = await saveGithubSnapshot(item)
      if (!repository.id) continue
      for (const subscription of subscriptions) await linkRepository(subscription.id, repository.id, new Date().toISOString())
    }
    discovered += trending.length
    console.log('[GitHub Radar] trending candidates:', trending.length)
  } catch (error) {
    console.error('[GitHub Radar] trending discovery failed:', error.message)
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
     LEFT JOIN github_ai_review_attempts attempt ON attempt.repository_id = r.id
     WHERE a.id IS NULL AND r.stars >= ${MIN_GITHUB_STARS} AND (attempt.next_attempt_at IS NULL OR datetime(replace(attempt.next_attempt_at, 'T', ' ')) <= datetime('now'))
     ORDER BY CASE WHEN datetime(replace(r.trending_seen_at, 'T', ' ')) >= datetime('now', '-2 days') THEN 0 ELSE 1 END,
              r.trending_rank ASC, r.last_seen_at DESC LIMIT 5`,
  )
  for (const repository of reviewQueue) {
    const attemptAt = new Date().toISOString()
    await dbRun(`INSERT INTO github_ai_review_attempts (repository_id, status, attempts, next_attempt_at, updated_at)
      VALUES (?, 'running', 1, ?, ?) ON CONFLICT(repository_id) DO UPDATE SET status='running', attempts=attempts+1, next_attempt_at=excluded.next_attempt_at, updated_at=excluded.updated_at`,
    [repository.id, new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(), attemptAt])
    try {
      console.log('[GitHub Radar] AI review start:', repository.full_name)
      const basicContext = await fetchGithubRepositoryContext(repository.full_name, { includeCode: false })
      const first = await reviewGithubRepository({ ...basicContext, ...repository, id: repository.id }, { codeContext: false })
      if (!first || first.confidence < 0.55 || !basicContext.readme) {
        const codeContext = await fetchGithubRepositoryContext(repository.full_name, { includeCode: true })
        await reviewGithubRepository({ ...codeContext, ...repository, id: repository.id }, { codeContext: true })
      }
      await dbRun("UPDATE github_ai_review_attempts SET status='success', last_error='', updated_at=? WHERE repository_id=?", [new Date().toISOString(), repository.id])
    } catch (error) {
      await dbRun("UPDATE github_ai_review_attempts SET status='failed', last_error=?, updated_at=? WHERE repository_id=?", [String(error.message || 'failed').slice(0, 500), new Date().toISOString(), repository.id])
      console.error('[GitHub Radar] AI review failed:', repository.full_name, error.message)
    }
  }
  const subscriptionMap = new Map(subscriptions.map((subscription) => [subscription.id, subscription]))
  const relevanceQueue = await dbAll(
    `WITH ranked AS (
       SELECT sr.subscription_id AS target_subscription_id, r.*, a.summary,
              ROW_NUMBER() OVER (
                PARTITION BY sr.subscription_id
                 ORDER BY CASE WHEN datetime(replace(r.trending_seen_at, 'T', ' ')) >= datetime('now', '-2 days') THEN 0 ELSE 1 END,
                          r.trending_rank ASC,
                          COALESCE((SELECT MAX(gs.stars) - MIN(gs.stars) FROM github_star_snapshots gs WHERE gs.repository_id = r.id AND datetime(replace(gs.captured_at, 'T', ' ')) >= datetime('now', '-2 days')), 0) DESC,
                         COALESCE((SELECT MAX(gs.stars) - MIN(gs.stars) FROM github_star_snapshots gs WHERE gs.repository_id = r.id), 0) DESC,
                         r.last_seen_at DESC, r.stars DESC
              ) AS relevance_rank
       FROM github_subscription_repositories sr
       JOIN github_repositories r ON r.id = sr.repository_id
       JOIN github_ai_reviews a ON a.id = r.last_ai_review_id
       WHERE sr.relevance_status = 'pending' AND a.worth_push = 1 AND r.stars >= ${MIN_GITHUB_STARS}
     )
     SELECT * FROM ranked WHERE relevance_rank <= 10 ORDER BY relevance_rank, target_subscription_id LIMIT 20`,
  )
  for (const repository of relevanceQueue) {
    const subscription = subscriptionMap.get(repository.target_subscription_id)
    if (!subscription) continue
    try {
      const focus = await getGithubSubscriptionFocus(subscription)
      const result = await reviewGithubSubscriptionRelevance(repository, focus)
      if (!result) continue
      await dbRun(
        `UPDATE github_subscription_repositories
         SET relevance_status = ?, relevance_score = ?, relevance_reason = ?, relevance_reviewed_at = ?
         WHERE subscription_id = ? AND repository_id = ?`,
        [result.relevant ? 'approved' : 'rejected', result.confidence, result.reason, new Date().toISOString(), subscription.id, repository.id],
      )
      console.log(`[GitHub Radar] relevance repo=${repository.full_name} subscription=${subscription.id} relevant=${result.relevant} confidence=${result.confidence}`)
    } catch (error) {
      console.error('[GitHub Radar] relevance review failed:', repository.full_name, error.message)
    }
  }
  return { subscriptions: subscriptions.length, discovered }
}

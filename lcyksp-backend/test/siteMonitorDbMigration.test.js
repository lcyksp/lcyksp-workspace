import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tempDir = await mkdtemp(path.join(tmpdir(), 'lcyksp-site-db-migration-'))
process.env.LCYKSP_DB_DIR = tempDir

const { closeDb, getDb, initDb } = await import('../src/config/db.js')

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => getDb().get(sql, params, (error, row) => (
    error ? reject(error) : resolve(row)
  )))
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => getDb().run(sql, params, function onRun(error) {
    if (error) reject(error)
    else resolve({ changes: this.changes })
  }))
}

test('JustWoker defaults to the token-authenticated /v1/models endpoint and migrates only built-in URLs', async () => {
  await initDb()
  const initial = await dbGet("SELECT target_url FROM site_monitors WHERE source = 'justwoker_models'")
  assert.equal(initial.target_url, 'https://api.justwoker.icu/v1/models')

  // The previous built-in was the login-gated pricing endpoint; an existing row must be moved over,
  // with its stale validators and failure state cleared so the new endpoint starts clean.
  await dbRun(
    `UPDATE site_monitors SET target_url = ?, enabled = 1, auth_type = 'bearer', auth_secret = ?,
       etag = 'legacy-etag', last_modified = 'legacy-date', last_status = 'failed',
       consecutive_failures = 2, last_error = 'legacy failure', next_run_at = datetime('now', '+1 hour')
     WHERE source = 'justwoker_models'`,
    ['https://api.justwoker.icu/api/pricing', 'encrypted-placeholder'],
  )
  await closeDb()
  await initDb()

  const migrated = await dbGet("SELECT * FROM site_monitors WHERE source = 'justwoker_models'")
  assert.equal(migrated.target_url, 'https://api.justwoker.icu/v1/models')
  assert.equal(migrated.enabled, 1)
  assert.equal(migrated.auth_type, 'bearer')
  assert.equal(migrated.auth_secret, 'encrypted-placeholder')
  assert.equal(migrated.etag, null)
  assert.equal(migrated.last_modified, null)
  assert.equal(migrated.last_status, 'idle')
  assert.equal(migrated.consecutive_failures, 0)
  assert.equal(migrated.last_error, '')
  assert.equal(migrated.next_run_at, null)

  // The oldest built-in URL is still migrated in one step, never through an intermediate value.
  await dbRun("UPDATE site_monitors SET target_url = 'https://api.justwoker.icu/pricing' WHERE source = 'justwoker_models'")
  await closeDb()
  await initDb()
  const oldest = await dbGet("SELECT target_url FROM site_monitors WHERE source = 'justwoker_models'")
  assert.equal(oldest.target_url, 'https://api.justwoker.icu/v1/models')

  await dbRun(
    "UPDATE site_monitors SET target_url = 'https://api.justwoker.icu/custom-pricing' WHERE source = 'justwoker_models'",
  )
  await closeDb()
  await initDb()
  const customized = await dbGet("SELECT target_url FROM site_monitors WHERE source = 'justwoker_models'")
  assert.equal(customized.target_url, 'https://api.justwoker.icu/custom-pricing')
})

test.after(async () => {
  await closeDb()
  await rm(tempDir, { recursive: true, force: true })
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  createEventKey,
  decodeHtmlEntities,
  diffItems,
  parseHzuAnnouncements,
  parseJustWokerModels,
} from '../src/utils/siteMonitorParsers.js'

const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

test('model parser recognizes nested data.models and removes duplicates', async () => {
  const models = parseJustWokerModels(await fixture('justwoker-models.json'))
  assert.deepEqual(models.map(({ itemKey }) => itemKey), ['deepseek-v3', 'gpt-4.1-mini'])
  assert.equal(models[1].title, 'GPT-4.1 Mini')
})

test('model parser supports top-level, named, and data arrays', () => {
  assert.equal(parseJustWokerModels(['A', 'B']).length, 2)
  assert.equal(parseJustWokerModels({ items: [{ model: 'A' }] }).length, 1)
  assert.equal(parseJustWokerModels({ data: [{ slug: 'A', name: 'Alpha' }] })[0].title, 'Alpha')
})

test('model parser supports the live JustWoker /api/pricing response shape', () => {
  const models = parseJustWokerModels({
    success: true,
    data: [
      { model_name: 'gpt-5.6-luna', vendor_id: 1, model_ratio: 0.25 },
      { model_name: 'gpt-5.6-sol', vendor_id: 1, model_ratio: 0.65 },
      { model_name: 'gpt-5.6-terra', vendor_id: 2, model_ratio: 0.3 },
    ],
  })
  assert.deepEqual(models.map(({ itemKey }) => itemKey), ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra'])
  assert.equal(models[1].title, 'gpt-5.6-sol')
})

test('model parser supports the OpenAI-compatible /v1/models shape used by an API token', () => {
  // The long-lived-token route reads GET /v1/models instead of the login-gated /api/pricing.
  // No parser change is needed for it: `data` is an array and each entry carries `id`.
  const models = parseJustWokerModels({
    object: 'list',
    data: [
      { id: 'gpt-5.6-luna', object: 'model', created: 1757000000, owned_by: 'justwoker' },
      { id: 'gpt-5.6-sol', object: 'model', created: 1757000001, owned_by: 'justwoker' },
    ],
  })
  assert.deepEqual(models.map(({ itemKey }) => itemKey), ['gpt-5.6-luna', 'gpt-5.6-sol'])
  assert.equal(models[0].title, 'gpt-5.6-luna')
  // An empty list must fail loudly rather than look like "every model was removed".
  assert.throws(() => parseJustWokerModels({ object: 'list', data: [] }))
})

test('model parser normalizes cosmetic case and whitespace for stable keys', () => {
  const models = parseJustWokerModels({ models: [' GPT-4.1  Mini ', 'gpt-4.1 mini'] })
  assert.equal(models.length, 1)
  assert.equal(models[0].itemKey, 'gpt-4.1 mini')
})

test('model parser rejects HTML, invalid JSON, unknown shapes, empty arrays, and invalid entries', () => {
  for (const payload of [
    '<html>login</html>', '{bad json', { message: 'unauthorized' }, { success: false, models: ['fake'] }, { models: [] },
    { models: [{ price: 1 }] }, { models: ['valid', null] },
  ]) {
    assert.throws(() => parseJustWokerModels(payload), TypeError)
  }
})

test('HZU parser extracts article identity, Chinese title, date, and canonical URL', async () => {
  const items = parseHzuAnnouncements(await fixture('hzu-announcements.html'))
  assert.equal(items.length, 2)
  const first = items.find(({ itemKey }) => itemKey === 'article:277428')
  assert.deepEqual(first, {
    itemKey: 'article:277428',
    title: '2026年硕士研究生招生 复试通知',
    url: 'https://www.hzu.edu.cn/2026/0509/c11241a277428/page.htm',
    publishedAt: '2026-05-09',
    metadata: { articleId: '277428' },
  })
})

test('HZU parser decodes entities, strips tags, deduplicates, and ignores navigation/off-site links', async () => {
  const items = parseHzuAnnouncements(await fixture('hzu-announcements.html'))
  const second = items.find(({ itemKey }) => itemKey === 'article:276001')
  assert.equal(second.title, '研究生招生 & 调剂公告')
  assert.equal(second.publishedAt, '2026-04-18')
  assert.ok(items.every(({ itemKey }) => itemKey !== 'article:999'))
})

test('HZU parser supports numeric entities and a title attribute fallback', () => {
  assert.equal(decodeHtmlEntities('&#30740;&#31350;&#29983; &#x62DB;&#x751F;'), '研究生 招生')
  const html = '<a title="招生&#x516C;告" href=/2025/1231/c11241a123/page.htm><img src=x></a>'
  assert.equal(parseHzuAnnouncements(html)[0].title, '招生公告')
})

test('HZU parser rejects empty or structurally unrelated pages', () => {
  assert.throws(() => parseHzuAnnouncements(''), TypeError)
  assert.throws(() => parseHzuAnnouncements('<html><a href="/yjszs/list.htm">导航</a></html>'), TypeError)
})

test('set diff reports model additions and removals', () => {
  const oldItems = [{ itemKey: 'a' }, { itemKey: 'b' }]
  const newItems = [{ itemKey: 'b' }, { itemKey: 'c' }]
  const result = diffItems(oldItems, newItems)
  assert.deepEqual(result.added.map((x) => x.itemKey), ['c'])
  assert.deepEqual(result.removed.map((x) => x.itemKey), ['a'])
  assert.deepEqual(result.unchanged.map((x) => x.itemKey), ['b'])
})

test('set diff ignores ordering and duplicate entries', () => {
  const result = diffItems(
    [{ itemKey: 'notice-1' }, { itemKey: 'notice-2' }],
    [{ itemKey: 'notice-2' }, { itemKey: 'notice-1' }, { itemKey: 'notice-1' }],
  )
  assert.equal(result.added.length, 0)
  assert.equal(result.removed.length, 0)
  assert.equal(result.unchanged.length, 2)
})

test('set diff identifies a new announcement despite old-item reordering', () => {
  const result = diffItems(
    [{ itemKey: 'old-1' }, { itemKey: 'old-2' }],
    [{ itemKey: 'old-2' }, { itemKey: 'new-1' }, { itemKey: 'old-1' }],
  )
  assert.deepEqual(result.added.map((x) => x.itemKey), ['new-1'])
  assert.equal(result.removed.length, 0)
})

test('set diff rejects an empty current snapshot and malformed items', () => {
  assert.throws(() => diffItems([{ itemKey: 'known' }], []), TypeError)
  assert.throws(() => diffItems([], [{}]), TypeError)
})

test('event fingerprint is deterministic, source-aware, and a SHA-256 hex value', () => {
  const key = createEventKey('hzu_postgraduate', 'announcement_added', 'article:277428')
  assert.equal(key, createEventKey('hzu_postgraduate', 'announcement_added', 'article:277428'))
  assert.notEqual(key, createEventKey('justwoker_models', 'announcement_added', 'article:277428'))
  assert.match(key, /^[a-f0-9]{64}$/)
  assert.throws(() => createEventKey('', 'announcement_added', 'article:277428'), TypeError)
})


test('parser enforces input size and field length limits', () => {
  assert.throws(() => parseJustWokerModels({ models: ['x'.repeat(1001)] }), /too long/)
  assert.throws(() => parseJustWokerModels({ models: [{ id: 'x'.repeat(513) }] }), /too long/)
  assert.throws(() => parseHzuAnnouncements('x'.repeat(5 * 1024 * 1024 + 1)), /too large/)
})

test('event fingerprint encoding is unambiguous when fields contain separators', () => {
  assert.notEqual(createEventKey('a', 'b', 'c\0d'), createEventKey('a\0b', 'c', 'd'))
})

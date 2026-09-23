import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  createEventKey,
  decodeHtmlEntities,
  diffItems,
  extractAnnouncementAttachment,
  extractAnnouncementBody,
  extractHzuPageLinks,
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
  // An explicitly empty list is the upstream speaking correctly ("no models available right now"):
  // it parses to [] and the service's removal machinery decides what it means (ISSUE-008). A missing
  // array still fails loudly.
  assert.deepEqual(parseJustWokerModels({ object: 'list', data: [] }), [])
  assert.throws(() => parseJustWokerModels({ object: 'list' }))
})

test('article body extraction takes the CMS container and degrades to nothing otherwise', () => {
  const page = '<html><head><style>.x{}</style></head><body><div class="nav">导航</div>'
    + "<div class='wp_articlecontent'><p>第一段内容&nbsp;带实体，长度足够触发正文抽取。</p><p>第二段内容。</p><script>bad()</script></div>"
    + '<div class="foot">版权</div></body></html>'
  const body = extractAnnouncementBody(page)
  assert.equal(body.includes('第一段内容 带实体，长度足够触发正文抽取。'), true)
  assert.equal(body.includes('第二段内容。'), true)
  assert.equal(body.includes('导航'), false)
  assert.equal(body.includes('版权'), false)
  assert.equal(body.includes('bad()'), false)

  // A template change must yield "no body" rather than navigation junk.
  assert.equal(extractAnnouncementBody('<html><body><div class="nav">只有导航</div></body></html>'), '')
  assert.equal(extractAnnouncementBody('<html><body><div class="wp_articlecontent">短</div></body></html>'), '')
  assert.equal(extractAnnouncementBody(''), '')
  assert.equal(extractAnnouncementBody(null), '')
  // Length is capped so a huge page cannot bloat the event payload or the mail.
  const long = `<div class="wp_articlecontent"><p>${'甲'.repeat(3000)}</p></div>`
  assert.equal(extractAnnouncementBody(long).length, 2000)
  assert.equal(extractAnnouncementBody(long, { maxLength: 50 }).length, 50)
})

test('model parser carries the vendor and endpoint families from /v1/models', () => {
  const models = parseJustWokerModels({
    object: 'list',
    data: [{ id: 'gpt-5.6-terra', object: 'model', owned_by: 'claude', supported_endpoint_types: ['anthropic', 'openai'] }],
  })
  assert.equal(models[0].metadata.vendor, 'claude')
  assert.deepEqual(models[0].metadata.endpoints, ['anthropic', 'openai'])
  // Shapes without those fields stay unchanged rather than gaining empty ones.
  const bare = parseJustWokerModels({ data: [{ model_name: 'plain-model' }] })
  assert.deepEqual(bare[0].metadata, { id: 'plain-model', name: 'plain-model' })
})

test('attachment-only announcements yield the file instead of nothing', () => {
  const page = '<html><body><div class="entry"><div class=\'wp_articlecontent\'>'
    + '<p><div pdfsrc="/_upload/article/files/aa/bb/cc.pdf" sudyfile-attr="{\'title\':\'惠州学院2026年硕士学位研究生招生目录.pdf\'}" class="wp_pdf_player"></div></p>'
    + '</div></div></body></html>'
  // No prose at all: the container holds only an embedded player.
  assert.equal(extractAnnouncementBody(page), '')

  const attachment = extractAnnouncementAttachment(page, 'https://www.hzu.edu.cn/2025/0926/c11241a270450/page.htm')
  assert.equal(attachment.url, 'https://www.hzu.edu.cn/_upload/article/files/aa/bb/cc.pdf')
  assert.equal(attachment.title, '惠州学院2026年硕士学位研究生招生目录.pdf')

  // Nothing to point at → null, so the mail simply shows title + link.
  assert.equal(extractAnnouncementAttachment('<div class="wp_articlecontent"><p>纯文字正文，没有附件。</p></div>', 'https://www.hzu.edu.cn/x/page.htm'), null)
  assert.equal(extractAnnouncementAttachment('', 'https://www.hzu.edu.cn/x/page.htm'), null)
})

test('model parser normalizes cosmetic case and whitespace for stable keys', () => {
  const models = parseJustWokerModels({ models: [' GPT-4.1  Mini ', 'gpt-4.1 mini'] })
  assert.equal(models.length, 1)
  assert.equal(models[0].itemKey, 'gpt-4.1 mini')
})

test('model parser rejects HTML, invalid JSON, unknown shapes, and invalid entries', () => {
  for (const payload of [
    '<html>login</html>', '{bad json', { message: 'unauthorized' }, { success: false, models: ['fake'] },
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

test('page-link extractor collects deeper 万户 list pages, deduped and ordered', () => {
  const html = [
    '<div class="wp_paging">',
    '<a href="/yjszs/list2.htm">下一页</a>',
    '<a href="/yjszs/list3.htm">3</a>',
    '<a href="/yjszs/list2.htm">2</a>',      // duplicate page number
    '<a href="/yjszs/list.htm">首页</a>',     // page 1 itself is excluded
    '<a href="/yjszs/list3.htm?x=1#top">尾页</a>', // query/hash stripped, still page 3
    '</div>',
  ].join('')
  assert.deepEqual(extractHzuPageLinks(html), [
    'https://www.hzu.edu.cn/yjszs/list2.htm',
    'https://www.hzu.edu.cn/yjszs/list3.htm',
  ])
})

test('page-link extractor ignores off-origin, off-directory and non-list links', () => {
  const html = [
    '<a href="https://evil.example.com/yjszs/list2.htm">2</a>',      // off-origin
    '<a href="/other/list2.htm">2</a>',                             // off-directory
    '<a href="/yjszs/2026/0901/c11241a101/page.htm">article</a>',   // article, not a list page
    '<a href="/yjszs/list.htm">1</a>',                              // page 1
  ].join('')
  assert.deepEqual(extractHzuPageLinks(html), [])
})

test('page-link extractor returns [] for empty input or an unrecognized base URL', () => {
  assert.deepEqual(extractHzuPageLinks(''), [])
  assert.deepEqual(extractHzuPageLinks('<a href="/yjszs/list2.htm">2</a>', 'not a url'), [])
  assert.deepEqual(extractHzuPageLinks('<a href="/yjszs/list2.htm">2</a>', 'https://www.hzu.edu.cn/yjszs/index.htm'), [])
})

test('page-link extractor caps the number of deeper pages it will follow', () => {
  const html = Array.from({ length: 30 }, (_, i) => `<a href="/yjszs/list${i + 2}.htm">${i + 2}</a>`).join('')
  const links = extractHzuPageLinks(html)
  assert.equal(links.length, 11) // MAX_LIST_PAGES(12) - 1
  assert.equal(links[0], 'https://www.hzu.edu.cn/yjszs/list2.htm')
  assert.equal(links[10], 'https://www.hzu.edu.cn/yjszs/list12.htm')
})

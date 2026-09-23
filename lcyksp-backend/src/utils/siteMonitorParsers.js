import { createHash } from 'node:crypto'

const MODEL_CONTAINER_KEYS = ['models', 'items', 'list', 'results']
const MODEL_ID_KEYS = ['id', 'modelId', 'model_id', 'slug', 'model', 'model_name', 'name']
const MODEL_TITLE_KEYS = ['displayName', 'display_name', 'modelName', 'model_name', 'name', 'model', 'id']
const MAX_MODEL_ENTRIES = 10000
const MAX_MODEL_KEY_LENGTH = 512
const MAX_TITLE_LENGTH = 1000
const MAX_ANNOUNCEMENT_HTML_LENGTH = 5 * 1024 * 1024
const MAX_ANNOUNCEMENTS = 5000

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
}

function canonicalKey(value) {
  const key = normalizeText(value).toLocaleLowerCase('en-US')
  if (key.length > MAX_MODEL_KEY_LENGTH) throw new TypeError('Model stable id is too long')
  return key
}

function findString(object, keys) {
  for (const key of keys) {
    if (typeof object[key] === 'string' && normalizeText(object[key])) {
      return normalizeText(object[key])
    }
  }
  return ''
}

function findModelArray(payload) {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object') return null

  for (const key of MODEL_CONTAINER_KEYS) {
    if (Array.isArray(payload[key])) return payload[key]
  }

  if (Array.isArray(payload.data)) return payload.data
  if (payload.data && typeof payload.data === 'object') {
    for (const key of MODEL_CONTAINER_KEYS) {
      if (Array.isArray(payload.data[key])) return payload.data[key]
    }
  }

  return null
}

function validateModelTitle(value) {
  const title = normalizeText(value)
  if (!title) throw new TypeError('Model title is empty')
  if (title.length > MAX_TITLE_LENGTH) throw new TypeError('Model title is too long')
  return title
}

function modelMetadata(entry, id, title) {
  const metadata = { id, name: title }
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    // `/v1/models` also reports the vendor and the endpoint families. A model name on its own does not
    // tell the reader what the model is, so these are carried into the notification.
    const vendor = normalizeText(entry.owned_by)
    if (vendor && vendor.length <= 64) metadata.vendor = vendor
    if (Array.isArray(entry.supported_endpoint_types)) {
      const endpoints = entry.supported_endpoint_types
        .map((value) => normalizeText(value))
        .filter(Boolean)
        .slice(0, 8)
      if (endpoints.length) metadata.endpoints = endpoints
    }
  }
  return metadata
}

function normalizeModelEntry(entry, index) {
  if (typeof entry === 'string') {
    const title = validateModelTitle(entry)
    return { itemKey: canonicalKey(title), title, metadata: modelMetadata(null, title, title) }
  }

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError(`Model entry at index ${index} has an unsupported type`)
  }

  const id = findString(entry, MODEL_ID_KEYS)
  const rawTitle = findString(entry, MODEL_TITLE_KEYS) || id
  if (!id || !rawTitle) {
    throw new TypeError(`Model entry at index ${index} has no stable string id or name`)
  }

  const title = validateModelTitle(rawTitle)
  return {
    itemKey: canonicalKey(id),
    title,
    metadata: modelMetadata(entry, id, title),
  }
}

/**
 * Parse known model-list JSON shapes without recursively treating unrelated values as models.
 * A missing array, an unparsable body or an all-invalid list throws — the API itself changed and a
 * human should look. An explicitly empty list is different: the upstream is speaking correctly and
 * reporting that no models are currently available (channels down, models pulled), so it returns []
 * and the caller's removal machinery decides what it means (ISSUE-008).
 */
export function parseJustWokerModels(input) {
  let payload = input
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (!trimmed || /^\s*</.test(trimmed)) {
      throw new TypeError('Model response is empty or HTML, not JSON')
    }
    try {
      payload = JSON.parse(trimmed)
    } catch {
      throw new TypeError('Model response is not valid JSON')
    }
  }

  if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.success === false) {
    throw new TypeError('Model response reports an unsuccessful request')
  }

  const entries = findModelArray(payload)
  if (!entries) throw new TypeError('Model response has no recognized model array')
  if (entries.length === 0) return []
  if (entries.length > MAX_MODEL_ENTRIES) throw new TypeError('Model response contains too many entries')

  const models = new Map()
  entries.forEach((entry, index) => {
    const model = normalizeModelEntry(entry, index)
    if (!models.has(model.itemKey)) models.set(model.itemKey, model)
  })

  if (models.size === 0) throw new TypeError('Model response contains no valid models')
  return [...models.values()].sort((a, b) => a.itemKey.localeCompare(b.itemKey))
}

const HTML_ENTITIES = Object.freeze({
  amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
  ensp: ' ', emsp: ' ', middot: '·', ndash: '–', mdash: '—',
})

export function decodeHtmlEntities(value) {
  return String(value ?? '').replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const hexadecimal = entity[1]?.toLowerCase() === 'x'
      const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10)
      if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        return match
      }
      return String.fromCodePoint(codePoint)
    }
    return HTML_ENTITIES[entity.toLowerCase()] ?? match
  })
}

function extractAttribute(attributes, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = attributes.match(new RegExp(`\\b${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\u0060]+))`, 'i'))
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : ''
}

function htmlToText(html) {
  return normalizeText(decodeHtmlEntities(
    String(html ?? '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ))
}

const MAX_ANNOUNCEMENT_BODY = 2000
// Only guards against an empty or near-empty capture; a legitimately short announcement must survive.
const MIN_ANNOUNCEMENT_BODY = 10

/**
 * Tag-stripping for article bodies. Deliberately does NOT run the NFKC normalisation that
 * `htmlToText` applies, because NFKC rewrites full-width punctuation (`，` becomes `,`), which would
 * visibly mangle Chinese prose in the notification.
 */
function htmlToPlainText(html) {
  return decodeHtmlEntities(
    String(html ?? '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim()
}

/**
 * Slice the article container by tracking <div> depth. A plain non-greedy regex stops at the first
 * nested `</div>`, which truncates (or empties) bodies that embed markup — the CMS wraps embedded PDF
 * players in their own div, for example.
 */
function sliceContainerBody(source) {
  const open = source.match(/<div\b[^>]*(?:wp_articlecontent|v_news_content|article-content)[^>]*>/i)
  if (!open) return ''
  const start = open.index + open[0].length
  const tagPattern = /<div\b[^>]*>|<\/div\s*>/gi
  tagPattern.lastIndex = start
  let depth = 1
  let match
  while ((match = tagPattern.exec(source)) !== null) {
    if (match[0].startsWith('</')) {
      depth -= 1
      if (depth === 0) return source.slice(start, match.index)
    } else {
      depth += 1
    }
  }
  // Unbalanced markup: prefer the remainder of the page over dropping the body entirely.
  return source.slice(start)
}

/**
 * Pull the announcement body out of an article page. The school site is built on a CMS whose article
 * container is `wp_articlecontent` (some templates use `v_news_content`). A container change must
 * degrade to "title + link only" rather than mailing navigation junk, so an empty or near-empty
 * capture is treated as absent.
 */
export function extractAnnouncementBody(html, { maxLength = MAX_ANNOUNCEMENT_BODY } = {}) {
  const source = String(html ?? '')
  if (!source.trim()) return ''
  const text = htmlToPlainText(sliceContainerBody(source))
  if (text.length < MIN_ANNOUNCEMENT_BODY) return ''
  return text.slice(0, maxLength)
}

/**
 * Some announcements carry no prose at all: the whole announcement is an attached file (the CMS renders
 * it as a player div holding `pdfsrc` plus a display title). Reporting the attachment is far more
 * useful than reporting nothing, so it is extracted when there is no body text.
 */
export function extractAnnouncementAttachment(html, articleUrl) {
  const source = String(html ?? '')
  if (!source.trim()) return null

  const player = source.match(/<div\b[^>]*pdfsrc\s*=\s*"([^"]+)"/i) || source.match(/<div\b[^>]*pdfsrc\s*=\s*'([^']+)'/i)
  const fileLink = source.match(/href\s*=\s*"([^"]+\.(?:pdf|docx?|xlsx?|zip))"/i)
  const rawPath = decodeHtmlEntities((player ? player[1] : (fileLink ? fileLink[1] : '')) || '').trim()
  if (!rawPath) return null

  let url
  try {
    url = new URL(rawPath, articleUrl || 'https://www.hzu.edu.cn/').href
  } catch {
    return null
  }

  const attributeMatch = source.match(/sudyfile-attr\s*=\s*"([^"]*)"/i) || source.match(/sudyfile-attr\s*=\s*'([^']*)'/i)
  const titleMatch = attributeMatch ? decodeHtmlEntities(attributeMatch[1]).match(/'title'\s*:\s*'([^']*)'/) : null
  const fallbackName = decodeURIComponent(url.split('/').pop() || '').trim()
  const title = normalizeText(titleMatch ? titleMatch[1] : fallbackName)

  return { url: url.slice(0, 1000), title: (title || '公告附件').slice(0, 200) }
}

function dateFromPath(year, monthDay) {
  const month = Number(monthDay.slice(0, 2))
  const day = Number(monthDay.slice(2, 4))
  const candidate = new Date(Date.UTC(Number(year), month - 1, day))
  if (candidate.getUTCFullYear() !== Number(year) || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return null
  return `${year}-${monthDay.slice(0, 2)}-${monthDay.slice(2, 4)}`
}

function extractNearbyDate(fragment, fallback) {
  const match = decodeHtmlEntities(fragment).match(/(?:^|[^\d])((?:19|20)\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})(?:日)?(?:[^\d]|$)/)
  if (!match) return fallback
  const monthDay = `${match[2].padStart(2, '0')}${match[3].padStart(2, '0')}`
  return dateFromPath(match[1], monthDay) ?? fallback
}

// A 万户 CMS list is paginated (list.htm, list2.htm, list3.htm …). Following the page links printed on
// page 1 lets a single run capture the full record set, so an old article that the site re-sorts back
// onto page 1 is recognised as already-known instead of being mis-reported as a new announcement. The
// cap bounds how many upstream requests one run can trigger even if the pagination markup is malformed.
const MAX_LIST_PAGES = 12

/**
 * Collect the deeper list-page URLs (page 2..N) linked from a 万户 list page. Page 1 is `list.htm`;
 * deeper pages are `listN.htm` in the same directory. Returns absolute URLs, deduped and ordered by
 * page number, excluding page 1. Anything off-origin, off-directory or unparseable is ignored, and the
 * result never exceeds MAX_LIST_PAGES - 1 entries.
 */
export function extractHzuPageLinks(input, baseUrl = 'https://www.hzu.edu.cn/yjszs/list.htm') {
  if (typeof input !== 'string' || !input.trim()) return []
  let base
  try {
    base = new URL(baseUrl)
  } catch {
    return []
  }
  const dirMatch = base.pathname.match(/^(.*\/)list\.htm$/i)
  if (!dirMatch) return []
  const pagePattern = new RegExp(`^${dirMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}list(\\d+)\\.htm$`, 'i')

  const pages = new Map()
  const anchorPattern = /<a\b([^>]*)>[\s\S]*?<\/a\s*>/gi
  let anchor
  while ((anchor = anchorPattern.exec(input)) !== null) {
    const href = decodeHtmlEntities(extractAttribute(anchor[1], 'href')).trim()
    if (!href) continue
    let url
    try {
      url = new URL(href, base)
    } catch {
      continue
    }
    if (url.origin !== base.origin) continue
    const match = url.pathname.match(pagePattern)
    if (!match) continue
    const pageNumber = Number(match[1])
    // Page 1 is `list.htm` (no number) and is already in hand; only deeper pages need a second request.
    if (!Number.isInteger(pageNumber) || pageNumber < 2) continue
    url.search = ''
    url.hash = ''
    if (!pages.has(pageNumber)) pages.set(pageNumber, url.href)
  }

  return [...pages.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, MAX_LIST_PAGES - 1)
    .map(([, href]) => href)
}

/** Parse HZU article anchors only; navigation and off-site links are ignored. */
export function parseHzuAnnouncements(input, baseUrl = 'https://www.hzu.edu.cn/yjszs/list.htm') {
  if (typeof input !== 'string' || !input.trim()) throw new TypeError('Announcement response is empty')
  if (input.length > MAX_ANNOUNCEMENT_HTML_LENGTH) throw new TypeError('Announcement response is too large')

  let base
  try {
    base = new URL(baseUrl)
  } catch {
    throw new TypeError('Announcement base URL is invalid')
  }

  const announcements = new Map()
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi
  let anchor
  while ((anchor = anchorPattern.exec(input)) !== null) {
    const href = decodeHtmlEntities(extractAttribute(anchor[1], 'href')).trim()
    if (!href) continue

    let url
    try {
      url = new URL(href, base)
    } catch {
      continue
    }
    if (url.origin !== base.origin) continue

    const pathMatch = url.pathname.match(/^\/(\d{4})\/(\d{4})\/c\d+a(\d+)\/page\.htm\/?$/i)
    if (!pathMatch) continue

    const articleId = pathMatch[3]
    const itemKey = `article:${articleId}`
    const titleAttribute = extractAttribute(anchor[1], 'title')
    const title = htmlToText(anchor[2]) || htmlToText(titleAttribute)
    if (!title || title.length > MAX_TITLE_LENGTH) continue

    url.search = ''
    url.hash = ''
    const fallbackDate = dateFromPath(pathMatch[1], pathMatch[2])
    const nearbyEnd = Math.min(input.length, anchorPattern.lastIndex + 500)
    const nearby = input.slice(anchor.index, nearbyEnd).split(/<\/(?:li|tr)\s*>/i, 1)[0]
    const publishedAt = extractNearbyDate(nearby, fallbackDate)

    if (!announcements.has(itemKey)) {
      if (announcements.size >= MAX_ANNOUNCEMENTS) throw new TypeError('Announcement response contains too many articles')
      announcements.set(itemKey, {
        itemKey,
        title,
        url: url.href,
        publishedAt,
        metadata: { articleId },
      })
    }
  }

  if (announcements.size === 0) {
    throw new TypeError('Announcement response contains no recognized article links')
  }
  return [...announcements.values()].sort((a, b) => a.itemKey.localeCompare(b.itemKey))
}

function indexItems(items, label) {
  if (!Array.isArray(items)) throw new TypeError(`${label} items must be an array`)
  const indexed = new Map()
  for (const item of items) {
    if (!item || typeof item !== 'object') throw new TypeError(`${label} contains an invalid item`)
    const itemKey = normalizeText(item.itemKey)
    if (!itemKey) throw new TypeError(`${label} contains an item without itemKey`)
    if (!indexed.has(itemKey)) indexed.set(itemKey, item)
  }
  return indexed
}

/** Compare item sets by stable key. Ordering and duplicate entries do not create changes. */
export function diffItems(previous, current) {
  const before = indexItems(previous, 'Previous')
  const after = indexItems(current, 'Current')
  if (after.size === 0) throw new TypeError('Current item snapshot is empty')

  const byKey = (a, b) => normalizeText(a.itemKey).localeCompare(normalizeText(b.itemKey))
  return {
    added: [...after].filter(([key]) => !before.has(key)).map(([, item]) => item).sort(byKey),
    removed: [...before].filter(([key]) => !after.has(key)).map(([, item]) => item).sort(byKey),
    unchanged: [...after].filter(([key]) => before.has(key)).map(([, item]) => item).sort(byKey),
  }
}

/** Produce a globally safe, deterministic event idempotency key. */
export function createEventKey(source, eventType, itemKey) {
  const parts = [source, eventType, itemKey].map(normalizeText)
  if (parts.some((part) => !part)) throw new TypeError('Event key fields must not be empty')
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex')
}



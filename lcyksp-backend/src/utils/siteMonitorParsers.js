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

function normalizeModelEntry(entry, index) {
  if (typeof entry === 'string') {
    const title = validateModelTitle(entry)
    return { itemKey: canonicalKey(title), title, metadata: { id: title, name: title } }
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
    metadata: { id, name: title },
  }
}

/**
 * Parse known model-list JSON shapes without recursively treating unrelated values as models.
 * Empty, malformed and unrecognized responses throw so callers cannot mistake them for removals.
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
  if (entries.length === 0) throw new TypeError('Model response contains an empty model array')
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



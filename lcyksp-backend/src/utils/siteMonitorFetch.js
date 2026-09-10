import dns from 'node:dns'
import { Agent, fetch } from 'undici'
import { isBlockedAddress, isBlockedHostname } from './ssrf.js'

const SOURCE_POLICIES = Object.freeze({
  justwoker_models: Object.freeze({
    hostname: 'api.justwoker.icu',
    defaultUrl: 'https://api.justwoker.icu/api/pricing',
    maxBytes: 2 * 1024 * 1024,
    acceptedTypes: ['application/json'],
  }),
  hzu_postgraduate: Object.freeze({
    hostname: 'www.hzu.edu.cn',
    defaultUrl: 'https://www.hzu.edu.cn/yjszs/list.htm',
    maxBytes: 5 * 1024 * 1024,
    acceptedTypes: ['text/html', 'application/xhtml+xml'],
  }),
})

const REQUEST_TIMEOUT_MS = 20_000
const MAX_REDIRECTS = 3
const USER_AGENT = 'lcyksp-site-monitor/1.0 (+https://lcyksp.xyz)'
const JUSTWOKER_REFRESH_URL = 'https://api.justwoker.icu/api/user/auth/refresh'
const REFRESH_MAX_BYTES = 1024 * 1024
export function createPublicOnlyLookup(lookup = dns.lookup) {
  return function publicOnlyLookup(hostname, options, callback) {
    lookup(hostname, { ...options, all: true, verbatim: true }, (error, records) => {
      if (error) return callback(error)
      if (!records?.length || records.some((record) => isBlockedAddress(record.address))) {
        const blocked = new Error('Monitor hostname resolved to a blocked address')
        blocked.code = 'EHOSTUNREACH'
        return callback(blocked)
      }
      if (options?.all) return callback(null, records)
      return callback(null, records[0].address, records[0].family)
    })
  }
}

export const publicOnlyLookup = createPublicOnlyLookup()

// Validate DNS at the socket lookup itself. This closes the check/use gap in which an allowlisted
// hostname could resolve publicly during validation and privately when undici opened the socket.
const dispatcher = new Agent({
  connect: { timeout: 10_000, lookup: publicOnlyLookup },
  headersTimeout: REQUEST_TIMEOUT_MS,
  bodyTimeout: REQUEST_TIMEOUT_MS,
})

export class SiteMonitorFetchError extends Error {
  constructor(message, { code = 'FETCH_FAILED', status = null, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'SiteMonitorFetchError'
    this.code = code
    this.status = status
  }
}

export function validateMonitorUrl(source, rawUrl) {
  const policy = SOURCE_POLICIES[source]
  if (!policy) throw new SiteMonitorFetchError('Unsupported monitor source', { code: 'INVALID_SOURCE' })

  let url
  try {
    url = new URL(String(rawUrl || policy.defaultUrl))
  } catch (cause) {
    throw new SiteMonitorFetchError('Monitor URL is invalid', { code: 'INVALID_URL', cause })
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== policy.hostname || url.username || url.password || url.port) {
    throw new SiteMonitorFetchError('Monitor URL is outside the HTTPS allowlist', { code: 'URL_NOT_ALLOWED' })
  }
  url.hash = ''
  return url
}

function contentTypeMatches(source, contentType) {
  const policy = SOURCE_POLICIES[source]
  const mediaType = String(contentType || '').split(';', 1)[0].trim().toLowerCase()
  if (source === 'justwoker_models' && mediaType.endsWith('+json')) return true
  return policy.acceptedTypes.includes(mediaType)
}

function buildHeaders(monitor, { accessToken = '' } = {}) {
  const headers = {
    accept: monitor.source === 'justwoker_models'
      ? 'application/json'
      : 'text/html,application/xhtml+xml;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'user-agent': USER_AGENT,
  }
  if (monitor.etag) headers['if-none-match'] = String(monitor.etag)
  if (monitor.last_modified) headers['if-modified-since'] = String(monitor.last_modified)

  const secret = String(monitor.authSecret || '').trim()
  if (accessToken) {
    headers.authorization = 'Bearer ' + accessToken
  } else if (monitor.auth_type === 'bearer') {
    if (!secret) throw new SiteMonitorFetchError('Bearer credential is not configured', { code: 'AUTH_MISSING' })
    if (/[\r\n]/.test(secret)) throw new SiteMonitorFetchError('Bearer credential is invalid', { code: 'AUTH_INVALID' })
    headers.authorization = 'Bearer ' + secret
  } else if (monitor.auth_type === 'cookie' && monitor.source !== 'justwoker_models') {
    if (!secret) throw new SiteMonitorFetchError('Cookie credential is not configured', { code: 'AUTH_MISSING' })
    if (/[\r\n]/.test(secret)) throw new SiteMonitorFetchError('Cookie credential is invalid', { code: 'AUTH_INVALID' })
    headers.cookie = secret
  } else if (monitor.auth_type !== 'none') {
    throw new SiteMonitorFetchError('Unsupported authentication type', { code: 'AUTH_INVALID' })
  }
  return headers
}

function validateCredential(secret, label) {
  const value = String(secret || '').trim()
  if (!value) throw new SiteMonitorFetchError(`${label} credential is not configured`, { code: 'AUTH_MISSING' })
  if (/\r|\n/.test(value)) throw new SiteMonitorFetchError(`${label} credential is invalid`, { code: 'AUTH_INVALID' })
  return value
}

function getSetCookieHeaders(headers) {
  if (typeof headers?.getSetCookie === 'function') return headers.getSetCookie()
  const value = headers?.get?.('set-cookie')
  return value ? [value] : []
}

/** Merge only cookie name/value pairs; Set-Cookie attributes must never be sent back as Cookie. */
export function mergeSessionCookies(currentCookie, setCookieHeaders) {
  const cookies = new Map()
  for (const part of String(currentCookie || '').split(';')) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    const name = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (name && !/[\s;,]/.test(name)) cookies.set(name, value)
  }
  for (const header of setCookieHeaders || []) {
    const pair = String(header || '').split(';', 1)[0]
    const separator = pair.indexOf('=')
    if (separator <= 0) continue
    const name = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    if (!name || /[\s;,]/.test(name)) continue
    if (!value || /(?:^|;)\s*max-age\s*=\s*0(?:;|$)/i.test(String(header))) cookies.delete(name)
    else cookies.set(name, value)
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
}

async function readLimitedBody(body, maxBytes) {
  const chunks = []
  let total = 0
  for await (const chunk of body) {
    total += chunk.byteLength
    if (total > maxBytes) {
      body.destroy?.()
      throw new SiteMonitorFetchError('Monitor response exceeds the size limit', { code: 'BODY_TOO_LARGE' })
    }
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

function safeResponseHeader(response, name, maxLength = 2048) {
  const value = response.headers.get(name)
  return value && value.length <= maxLength ? value : null
}

export async function fetchMonitorResponse(monitor, { fetchImpl = fetch, signal, hostnameValidator = isBlockedHostname, onCredentialRefresh } = {}) {
  const policy = SOURCE_POLICIES[monitor?.source]
  if (!policy) throw new SiteMonitorFetchError('Unsupported monitor source', { code: 'INVALID_SOURCE' })

  let url = validateMonitorUrl(monitor.source, monitor.target_url)
  let accessToken = ''
  let rotatedCookie = ''
  const timeoutController = new AbortController()
  const timeout = setTimeout(() => timeoutController.abort(new Error('Monitor request timed out')), REQUEST_TIMEOUT_MS)
  timeout.unref?.()
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal

  try {
    if (monitor.source === 'justwoker_models' && monitor.auth_type === 'cookie') {
      const sessionCookie = validateCredential(monitor.authSecret, 'Cookie')
      const refreshUrl = validateMonitorUrl(monitor.source, JUSTWOKER_REFRESH_URL)
      if (await hostnameValidator(refreshUrl.hostname)) throw new SiteMonitorFetchError('Monitor hostname resolves to a blocked address', { code: 'HOST_BLOCKED' })
      let refreshResponse
      try {
        refreshResponse = await fetchImpl(refreshUrl, {
          method: 'POST',
          headers: { accept: 'application/json', 'accept-encoding': 'gzip, deflate, br', cookie: sessionCookie, 'user-agent': USER_AGENT },
          redirect: 'manual', dispatcher, signal: combinedSignal,
        })
      } catch (cause) {
        const code = combinedSignal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR'
        throw new SiteMonitorFetchError(code === 'TIMEOUT' ? 'Monitor request timed out' : 'Monitor session refresh failed', { code, cause })
      }
      if (refreshResponse.status === 401 || refreshResponse.status === 403) {
        refreshResponse.body?.destroy?.()
        throw new SiteMonitorFetchError('Monitor authentication was rejected', { code: 'AUTH_REJECTED', status: refreshResponse.status })
      }
      if ([301, 302, 303, 307, 308].includes(refreshResponse.status)) {
        refreshResponse.body?.destroy?.()
        throw new SiteMonitorFetchError('Monitor session refresh returned an unexpected redirect', { code: 'INVALID_REDIRECT', status: refreshResponse.status })
      }
      if (!refreshResponse.ok) {
        refreshResponse.body?.destroy?.()
        throw new SiteMonitorFetchError(`Monitor session refresh returned HTTP ${refreshResponse.status}`, { code: 'HTTP_ERROR', status: refreshResponse.status })
      }
      const refreshType = refreshResponse.headers.get('content-type') || ''
      if (!/^(application\/json|[^/]+\/[^/]+\+json)$/.test(refreshType.toLowerCase().split(';', 1)[0].trim())) {
        refreshResponse.body?.destroy?.()
        throw new SiteMonitorFetchError('Monitor session refresh returned an unexpected content type', { code: 'CONTENT_TYPE_INVALID', status: refreshResponse.status })
      }
      const refreshBody = await readLimitedBody(refreshResponse.body, REFRESH_MAX_BYTES)
      let refreshPayload
      try { refreshPayload = JSON.parse(refreshBody) } catch (cause) {
        throw new SiteMonitorFetchError('Monitor session refresh returned invalid JSON', { code: 'AUTH_INVALID', status: refreshResponse.status, cause })
      }
      accessToken = String(refreshPayload?.data?.access_token || '').trim()
      const tokenType = String(refreshPayload?.data?.token_type || '')
      if (refreshPayload?.success !== true || tokenType.toLowerCase() !== 'bearer' || !accessToken || accessToken.length > 8192 || /\r|\n/.test(accessToken)) {
        throw new SiteMonitorFetchError('Monitor session refresh did not return a valid Bearer token', { code: 'AUTH_REJECTED', status: refreshResponse.status })
      }
      const mergedCookie = mergeSessionCookies(sessionCookie, getSetCookieHeaders(refreshResponse.headers))
      if (mergedCookie && mergedCookie !== sessionCookie) rotatedCookie = mergedCookie
    }

    const headers = buildHeaders(monitor, { accessToken })
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      if (await hostnameValidator(url.hostname)) {
        throw new SiteMonitorFetchError('Monitor hostname resolves to a blocked address', { code: 'HOST_BLOCKED' })
      }
      let response
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers,
          redirect: 'manual',
          dispatcher,
          signal: combinedSignal,
        })
      } catch (cause) {
        const code = combinedSignal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR'
        throw new SiteMonitorFetchError(code === 'TIMEOUT' ? 'Monitor request timed out' : 'Monitor request failed', { code, cause })
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        response.body?.destroy?.()
        const location = response.headers.get('location')
        if (!location) throw new SiteMonitorFetchError('Redirect response has no Location header', { code: 'INVALID_REDIRECT', status: response.status })
        if (redirectCount >= MAX_REDIRECTS) throw new SiteMonitorFetchError('Monitor request exceeded redirect limit', { code: 'TOO_MANY_REDIRECTS', status: response.status })
        url = validateMonitorUrl(monitor.source, new URL(location, url).href)
        continue
      }

      if (response.status === 304) {
        response.body?.destroy?.()
        if (rotatedCookie && typeof onCredentialRefresh === 'function') await onCredentialRefresh(rotatedCookie)
        return { status: 304, notModified: true, body: '', contentType: '', etag: monitor.etag || null, lastModified: monitor.last_modified || null, finalUrl: url.href }
      }
      if (response.status === 401 || response.status === 403) {
        response.body?.destroy?.()
        throw new SiteMonitorFetchError('Monitor authentication was rejected', { code: 'AUTH_REJECTED', status: response.status })
      }
      if (!response.ok) {
        response.body?.destroy?.()
        throw new SiteMonitorFetchError(`Monitor returned HTTP ${response.status}`, { code: 'HTTP_ERROR', status: response.status })
      }

      const contentLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(contentLength) && contentLength > policy.maxBytes) {
        response.body?.destroy?.()
        throw new SiteMonitorFetchError('Monitor response exceeds the size limit', { code: 'BODY_TOO_LARGE', status: response.status })
      }
      const contentType = response.headers.get('content-type') || ''
      if (!contentTypeMatches(monitor.source, contentType)) {
        response.body?.destroy?.()
        throw new SiteMonitorFetchError('Monitor returned an unexpected content type', { code: 'CONTENT_TYPE_INVALID', status: response.status })
      }
      const body = await readLimitedBody(response.body, policy.maxBytes)
      if (!body.trim()) throw new SiteMonitorFetchError('Monitor returned an empty response', { code: 'EMPTY_BODY', status: response.status })

      if (rotatedCookie && typeof onCredentialRefresh === 'function') await onCredentialRefresh(rotatedCookie)

      return {
        status: response.status,
        notModified: false,
        body,
        contentType,
        etag: safeResponseHeader(response, 'etag'),
        lastModified: safeResponseHeader(response, 'last-modified'),
        finalUrl: url.href,
      }
    }
    throw new SiteMonitorFetchError('Monitor request exceeded redirect limit', { code: 'TOO_MANY_REDIRECTS' })
  } finally {
    clearTimeout(timeout)
  }
}

export const siteMonitorFetchPolicy = Object.freeze({
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  maxRedirects: MAX_REDIRECTS,
  sources: SOURCE_POLICIES,
  justWokerRefreshUrl: JUSTWOKER_REFRESH_URL,
})

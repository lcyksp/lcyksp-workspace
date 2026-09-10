import test from 'node:test'
import assert from 'node:assert/strict'
import { createPublicOnlyLookup, fetchMonitorResponse, mergeSessionCookies, validateMonitorUrl } from '../src/utils/siteMonitorFetch.js'

function response(body, init = {}) { return new Response(body, init) }
const publicHost = async () => false

const hzu = { source: 'hzu_postgraduate', target_url: 'https://www.hzu.edu.cn/yjszs/list.htm', auth_type: 'none' }
const justwoker = { source: 'justwoker_models', target_url: 'https://api.justwoker.icu/api/pricing', auth_type: 'bearer', authSecret: 'secret-token' }
function lookupResult(lookup, hostname, options = {}) {
  return new Promise((resolve, reject) => lookup(hostname, options, (error, address, family) => (
    error ? reject(error) : resolve({ address, family })
  )))
}

test('socket lookup rejects any private resolution and preserves public DNS results', async () => {
  const privateLookup = createPublicOnlyLookup((_hostname, _options, callback) => callback(null, [
    { address: '203.0.113.10', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]))
  await assert.rejects(lookupResult(privateLookup, 'www.hzu.edu.cn'), { code: 'EHOSTUNREACH' })

  const publicLookup = createPublicOnlyLookup((_hostname, options, callback) => {
    assert.equal(options.all, true)
    assert.equal(options.verbatim, true)
    callback(null, [{ address: '203.0.113.10', family: 4 }])
  })
  assert.deepEqual(await lookupResult(publicLookup, 'www.hzu.edu.cn'), { address: '203.0.113.10', family: 4 })
})

test('URL allowlist requires exact HTTPS host without credentials or custom ports', () => {
  assert.equal(validateMonitorUrl('hzu_postgraduate', hzu.target_url).href, hzu.target_url)
  for (const url of ['http://www.hzu.edu.cn/yjszs/list.htm', 'https://evil.example/yjszs/list.htm', 'https://www.hzu.edu.cn.evil.example/x', 'https://u:p@www.hzu.edu.cn/x', 'https://www.hzu.edu.cn:444/x']) {
    assert.throws(() => validateMonitorUrl('hzu_postgraduate', url), /allowlist/)
  }
})

test('fetcher sends conditional and bearer headers without exposing them in results', async () => {
  let captured
  const result = await fetchMonitorResponse({ ...justwoker, etag: '"v1"', last_modified: 'Wed, 09 Sep 2026 00:00:00 GMT' }, {
    hostnameValidator: publicHost,
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options }
      return response('{"models":["A"]}', { status: 200, headers: { 'content-type': 'application/json', etag: '"v2"' } })
    },
  })
  assert.equal(captured.options.headers.authorization, 'Bearer secret-token')
  assert.equal(captured.url, 'https://api.justwoker.icu/api/pricing')
  assert.equal(captured.options.headers['if-none-match'], '"v1"')
  assert.equal(result.etag, '"v2"')
  assert.equal(JSON.stringify(result).includes('secret-token'), false)
})

test('fetcher follows only allowlisted redirects and caps redirect depth', async () => {
  let calls = 0
  const ok = await fetchMonitorResponse(hzu, {
    hostnameValidator: publicHost,
    fetchImpl: async () => (++calls === 1
      ? response('', { status: 302, headers: { location: '/yjszs/list2.htm' } })
      : response('<a href="/2026/0909/c11241a1/page.htm">公告</a>', { status: 200, headers: { 'content-type': 'text/html' } })),
  })
  assert.equal(ok.finalUrl, 'https://www.hzu.edu.cn/yjszs/list2.htm')

  await assert.rejects(fetchMonitorResponse(hzu, {
    hostnameValidator: publicHost,
    fetchImpl: async () => response('', { status: 302, headers: { location: 'https://evil.example/x' } }),
  }), { code: 'URL_NOT_ALLOWED' })
})

test('fetcher rejects private DNS, authentication failures, HTML login pages, empty and oversized responses', async () => {
  await assert.rejects(fetchMonitorResponse(hzu, { hostnameValidator: async () => true, fetchImpl: async () => { throw new Error('must not run') } }), { code: 'HOST_BLOCKED' })
  await assert.rejects(fetchMonitorResponse(justwoker, { hostnameValidator: publicHost, fetchImpl: async () => response('', { status: 401 }) }), { code: 'AUTH_REJECTED' })
  await assert.rejects(fetchMonitorResponse(justwoker, { hostnameValidator: publicHost, fetchImpl: async () => response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }) }), { code: 'CONTENT_TYPE_INVALID' })
  await assert.rejects(fetchMonitorResponse(hzu, { hostnameValidator: publicHost, fetchImpl: async () => response('', { status: 200, headers: { 'content-type': 'text/html' } }) }), { code: 'EMPTY_BODY' })
  await assert.rejects(fetchMonitorResponse(justwoker, { hostnameValidator: publicHost, fetchImpl: async () => response('x', { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(3 * 1024 * 1024) } }) }), { code: 'BODY_TOO_LARGE' })
})

test('fetcher accepts a 304 response without a body', async () => {
  const result = await fetchMonitorResponse({ ...hzu, etag: '"v1"' }, { hostnameValidator: publicHost, fetchImpl: async () => response(null, { status: 304 }) })
  assert.equal(result.notModified, true)
  assert.equal(result.etag, '"v1"')
})


test('JustWoker session cookie refreshes a short-lived token before pricing fetch', async () => {
  const calls = []
  let rotated = ''
  const result = await fetchMonitorResponse({ ...justwoker, auth_type: 'cookie', authSecret: 'sid=old; device=stable' }, {
    hostnameValidator: publicHost,
    onCredentialRefresh: async (cookie) => { rotated = cookie },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), method: options.method, headers: options.headers })
      if (calls.length === 1) {
        return response(JSON.stringify({ success: true, data: { access_token: 'fresh-access', token_type: 'Bearer' } }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'set-cookie': 'sid=new; Path=/; HttpOnly; Secure' },
        })
      }
      return response('{"data":[{"model_name":"model-a"}]}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'https://api.justwoker.icu/api/user/auth/refresh')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers.cookie, 'sid=old; device=stable')
  assert.equal(calls[0].headers.authorization, undefined)
  assert.equal(calls[1].url, 'https://api.justwoker.icu/api/pricing')
  assert.equal(calls[1].method, 'GET')
  assert.equal(calls[1].headers.authorization, 'Bearer fresh-access')
  assert.equal(calls[1].headers.cookie, undefined)
  assert.equal(rotated, 'sid=new; device=stable')
  assert.equal(JSON.stringify(result).includes('fresh-access'), false)
  assert.equal(JSON.stringify(result).includes('sid='), false)
})

test('JustWoker session refresh rejects bad authentication and malformed token responses', async () => {
  const monitor = { ...justwoker, auth_type: 'cookie', authSecret: 'sid=session' }
  await assert.rejects(fetchMonitorResponse(monitor, { hostnameValidator: publicHost, fetchImpl: async () => response('', { status: 401 }) }), { code: 'AUTH_REJECTED' })
  await assert.rejects(fetchMonitorResponse(monitor, { hostnameValidator: publicHost, fetchImpl: async () => response('<html>bad</html>', { status: 200, headers: { 'content-type': 'text/html' } }) }), { code: 'CONTENT_TYPE_INVALID' })
  await assert.rejects(fetchMonitorResponse(monitor, { hostnameValidator: publicHost, fetchImpl: async () => response('{', { status: 200, headers: { 'content-type': 'application/json' } }) }), { code: 'AUTH_INVALID' })
  for (const data of [
    { success: true, data: { token_type: 'Bearer' } },
    { success: true, data: { token_type: 'Basic', access_token: 'wrong-type' } },
    { success: false, data: { token_type: 'Bearer', access_token: 'rejected' } },
  ]) {
    await assert.rejects(fetchMonitorResponse(monitor, {
      hostnameValidator: publicHost,
      fetchImpl: async () => response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } }),
    }), { code: 'AUTH_REJECTED' })
  }
})

test('Cookie merging keeps request cookies and applies safe Set-Cookie rotation', () => {
  assert.equal(mergeSessionCookies('sid=old; device=x', ['sid=new; Path=/; HttpOnly', 'extra=y; Secure']), 'sid=new; device=x; extra=y')
  assert.equal(mergeSessionCookies('sid=old; device=x', ['sid=; Max-Age=0; Path=/']), 'device=x')
})

test('non-JustWoker cookie authentication remains a direct Cookie request', async () => {
  let captured
  await fetchMonitorResponse({ ...hzu, auth_type: 'cookie', authSecret: 'session=hzu' }, {
    hostnameValidator: publicHost,
    fetchImpl: async (url, options) => { captured = { url: String(url), options }; return response('<a href="/2026/0909/c11241a1/page.htm">公告</a>', { status: 200, headers: { 'content-type': 'text/html' } }) },
  })
  assert.equal(captured.options.method, 'GET')
  assert.equal(captured.options.headers.cookie, 'session=hzu')
  assert.equal(captured.options.headers.authorization, undefined)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  detectPlatform,
  isAllowedPlatformUrl,
  hostMatchesDomain,
  urlHostname,
  matchesAnyDomain,
  X_DOMAINS,
} from '../src/utils/platformDomains.js'

// 这一组用例的重点是「子串匹配」旧缺陷的回归防护：
// 白名单从 includes 改成主机名后缀匹配后，短域名 x.com 不能再把 fox.com 放进来。
test('detectPlatform 识别四个平台', () => {
  assert.equal(detectPlatform('https://v.douyin.com/abc123/'), 'douyin')
  assert.equal(detectPlatform('https://www.douyin.com/video/7300000000000000000'), 'douyin')
  assert.equal(detectPlatform('https://iesdouyin.com/share/note/7300000000000000000'), 'douyin')
  assert.equal(detectPlatform('https://www.bilibili.com/video/BV1xx411c7mD'), 'bilibili')
  assert.equal(detectPlatform('https://b23.tv/abc123'), 'bilibili')
  assert.equal(detectPlatform('https://youtu.be/dQw4w9WgXcQ'), 'youtube')
  assert.equal(detectPlatform('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'youtube')
  assert.equal(detectPlatform('https://x.com/BrooklynNets/status/1349794411333394432'), 'twitter')
  assert.equal(detectPlatform('https://twitter.com/starwars/status/665052190608723968'), 'twitter')
  assert.equal(detectPlatform('https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/abc.mp4'), 'twitter')
  assert.equal(detectPlatform('https://t.co/abc123'), 'twitter')
  assert.equal(detectPlatform('https://example.com/watch?v=1'), 'generic')
})

test('子串误判回归：fox.com / vortex.com / notx.com 都不算 X', () => {
  for (const url of [
    'https://fox.com/video/1',
    'https://www.fox.com/video/1',
    'https://vortex.com/status/1',
    'https://notx.com/status/1',
    'https://x.com.evil.example/status/1',
    'https://example.com/x.com/status/1',
  ]) {
    assert.equal(detectPlatform(url), 'generic', `${url} 不应被识别为 X`)
    assert.equal(isAllowedPlatformUrl(url), false, `${url} 不应通过白名单`)
  }
})

test('白名单放行抖音 / B站 / X 及其子域与短链', () => {
  for (const url of [
    'https://www.douyin.com/video/7300000000000000000',
    'https://v.douyin.com/abc123/',
    'https://iesdouyin.com/share/note/7300000000000000000',
    'https://www.bilibili.com/video/BV1xx411c7mD',
    'https://b23.tv/abc123',
    'https://x.com/user/status/1',
    'https://api.x.com/2/tweets/1',
    'https://twitter.com/user/status/1',
    'https://video.twimg.com/ext_tw_video/1/pu/vid/1.mp4',
    'https://t.co/abc',
  ]) {
    assert.equal(isAllowedPlatformUrl(url), true, `${url} 应通过白名单`)
  }
})

test('白名单拒绝无关域名与伪后缀', () => {
  for (const url of [
    'https://example.com/video/1',
    'https://evildouyin.com/video/1',
    'https://douyin.com.evil.example/video/1',
    'https://mybilibili.com/video/1',
    'https://b23.tv.evil.example/abc',
    'http://127.0.0.1/video/1',
    'http://169.254.169.254/latest/meta-data/',
  ]) {
    assert.equal(isAllowedPlatformUrl(url), false, `${url} 不应通过白名单`)
  }
})

test('hostMatchesDomain 精确与后缀语义', () => {
  assert.equal(hostMatchesDomain('x.com', 'x.com'), true)
  assert.equal(hostMatchesDomain('www.x.com', 'x.com'), true)
  assert.equal(hostMatchesDomain('X.COM', 'x.com'), true)
  assert.equal(hostMatchesDomain('x.com.', 'x.com'), true)
  assert.equal(hostMatchesDomain('fox.com', 'x.com'), false)
  assert.equal(hostMatchesDomain('x.com.evil.example', 'x.com'), false)
  assert.equal(hostMatchesDomain('', 'x.com'), false)
  assert.equal(hostMatchesDomain('x.com', ''), false)
})

test('urlHostname 大小写与非法输入', () => {
  assert.equal(urlHostname('https://WwW.X.com/abc'), 'www.x.com')
  assert.equal(urlHostname('  https://x.com/abc  '), 'x.com')
  assert.equal(urlHostname('x.com/abc'), '')
  assert.equal(urlHostname(''), '')
  assert.equal(urlHostname(null), '')
})

test('URL 解析失败时按边界关键词兜底，不做裸子串匹配', () => {
  assert.equal(matchesAnyDomain('v.douyin.com/abc123', ['douyin.com']), true)
  assert.equal(matchesAnyDomain('iesdouyin.com/share/note/1', ['iesdouyin.com']), true)
  assert.equal(matchesAnyDomain('evildouyin.com/abc', ['douyin.com']), false)
  assert.equal(matchesAnyDomain('fox.com/video/1', X_DOMAINS), false)
  assert.equal(matchesAnyDomain('x.com/status/1', X_DOMAINS), true)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeAnalyzeFormats } from '../src/utils/videoFormats.js'

// 取自 2026-10-02 服务器实测的 X 真实 formats（同清晰度成对出现 http 渐进式与 hls 分离流；
// 注意 X 只给估算体积 filesize_approx，没有 filesize）。
const X_FORMATS = [
  { format_id: 'hls-audio-32000-Audio', resolution: 'audio only', ext: 'mp4', vcodec: 'none', acodec: null },
  { format_id: 'hls-audio-128000-Audio', resolution: 'audio only', ext: 'mp4', vcodec: 'none', acodec: null },
  { format_id: 'http-632', resolution: '320x400', ext: 'mp4', vcodec: null, acodec: null, filesize_approx: 2370000 },
  { format_id: 'hls-138', resolution: '320x400', ext: 'mp4', vcodec: 'avc1.4D401', acodec: 'none' },
  { format_id: 'http-950', resolution: '480x600', ext: 'mp4', vcodec: null, acodec: null, filesize_approx: 3560000 },
  { format_id: 'hls-253', resolution: '480x600', ext: 'mp4', vcodec: 'avc1.4D401', acodec: 'none' },
  { format_id: 'http-2176', resolution: '720x900', ext: 'mp4', vcodec: null, acodec: null, filesize_approx: 8170000 },
  { format_id: 'hls-473', resolution: '720x900', ext: 'mp4', vcodec: 'avc1.64002', acodec: 'none' },
]

test('X 格式：不去重时同一清晰度会出现两条（保留旧行为的对照）', () => {
  const formats = normalizeAnalyzeFormats(X_FORMATS)
  assert.equal(formats.length, 6)
  assert.equal(formats.filter((f) => f.quality === '320x400').length, 2)
})

test('X 格式：去重后每个清晰度只留一条，且优先留体积已知的 http 渐进式', () => {
  const formats = normalizeAnalyzeFormats(X_FORMATS, { dedupeSameQuality: true })
  assert.equal(formats.length, 3)
  assert.deepEqual(formats.map((f) => f.quality), ['320x400', '480x600', '720x900'])
  assert.deepEqual(formats.map((f) => f.formatId), ['http-632', 'http-950', 'http-2176'])
  assert.equal(formats[0].filesize, '2.3 MB')
})

test('去重时优先保留含音轨的那条（含音轨权重高于体积已知）', () => {
  const formats = normalizeAnalyzeFormats(
    [
      { format_id: 'v-only', resolution: '720p', ext: 'mp4', vcodec: 'avc1', acodec: 'none', filesize: 999 },
      { format_id: 'muxed', resolution: '720p', ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a' },
    ],
    { dedupeSameQuality: true },
  )
  assert.equal(formats.length, 1)
  assert.equal(formats[0].formatId, 'muxed')
  assert.equal(formats[0].hasAudio, true)
})

test('音频格式：acodec 为 null 不产出「仅音频」选项，有 acodec 才产出', () => {
  const formats = normalizeAnalyzeFormats(X_FORMATS, { dedupeSameQuality: true })
  assert.equal(formats.filter((f) => f.mediaType === 'audio').length, 0)

  const bilibiliLike = normalizeAnalyzeFormats([
    { format_id: '30280', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', filesize: 1048576 },
    { format_id: '30216', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2' },
  ])
  const audios = bilibiliLike.filter((f) => f.mediaType === 'audio')
  assert.equal(audios.length, 2)
  assert.equal(audios[0].formatId, 'audio-30280')
  assert.equal(audios[0].sourceFormatId, '30280')
  assert.equal(audios[0].hasAudio, true)
})

test('体积优先取 filesize，缺失时回退 filesize_approx（X 只给估算值）', () => {
  const formats = normalizeAnalyzeFormats([
    { format_id: 'exact', resolution: '720p', ext: 'mp4', vcodec: 'avc1', filesize: 1048576, filesize_approx: 9999999 },
    { format_id: 'approx', resolution: '480p', ext: 'mp4', vcodec: 'avc1', filesize_approx: 2097152 },
    { format_id: 'none', resolution: '360p', ext: 'mp4', vcodec: 'avc1' },
  ])
  assert.equal(formats[0].filesize, '1.0 MB')
  assert.equal(formats[1].filesize, '2.0 MB')
  assert.equal(formats[2].filesize, '大小未知')
})

test('清晰度命名回退链与非法输入', () => {
  const formats = normalizeAnalyzeFormats([
    { format_id: 'a', format_note: '1080p60', resolution: '1920x1080', ext: 'mp4', vcodec: 'avc1' },
    { format_id: 'b', resolution: '1280x720', ext: 'mp4', vcodec: 'avc1' },
    { format_id: 'c', height: 480, ext: 'mp4', vcodec: 'avc1' },
    { format_id: 'd', ext: 'mp4', vcodec: 'avc1' },
  ])
  assert.deepEqual(formats.map((f) => f.quality), ['1080p60', '1280x720', '480p', '未知清晰度'])
  assert.equal(formats[3].filesize, '大小未知')
  assert.equal(formats[0].ext, 'mp4')
})

test('空输入与 vcodec/图片条目不炸', () => {
  assert.deepEqual(normalizeAnalyzeFormats(), [])
  assert.deepEqual(normalizeAnalyzeFormats(null, { dedupeSameQuality: true }), [])
  const withImage = normalizeAnalyzeFormats([
    { format_id: 'img', ext: 'jpg', vcodec: 'none', acodec: 'none' },
    { format_id: 'v', ext: 'mp4', vcodec: 'avc1' },
  ])
  assert.equal(withImage.length, 1)
  assert.equal(withImage[0].formatId, 'v')
})

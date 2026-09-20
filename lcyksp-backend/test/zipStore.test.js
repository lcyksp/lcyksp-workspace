import test from 'node:test'
import assert from 'node:assert/strict'
import { buildZipStore, crc32 } from '../src/utils/zipStore.js'

// 自己手写的 zip 格式必须能被真实解压工具打开，所以这里既验结构也逐条回读校验。
function parseZip(buffer) {
  const eocdSignature = 0x06054b50
  let eocdOffset = -1
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === eocdSignature) {
      eocdOffset = i
      break
    }
  }
  assert.notEqual(eocdOffset, -1, '找不到 EOCD 记录')

  const entryCount = buffer.readUInt16LE(eocdOffset + 10)
  const centralSize = buffer.readUInt32LE(eocdOffset + 12)
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16)

  const entries = []
  let cursor = centralOffset
  for (let i = 0; i < entryCount; i += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, '中央目录头签名错误')
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const crc = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const size = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf-8')

    // 回读本地头
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, '本地文件头签名错误')
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const dataStart = localOffset + 30 + localNameLength
    const data = buffer.subarray(dataStart, dataStart + size)

    entries.push({ name, flags, method, crc, compressedSize, size, data })
    cursor += 46 + nameLength
  }

  assert.equal(cursor, eocdOffset, '中央目录长度与实际不符')
  assert.equal(centralOffset + centralSize, eocdOffset, 'centralSize 与实际不符')
  return entries
}

test('crc32 命中已知向量', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
  assert.equal(crc32(Buffer.from('')), 0)
  assert.equal(crc32(Buffer.from('hello')), 0x3610a686)
})

test('打包出的 zip 结构完整、内容可逐条回读', () => {
  const entries = [
    { name: '第01张.jpg', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) },
    { name: '第02张.jpg', data: Buffer.from('hello zip') },
  ]
  const zip = buildZipStore(entries)
  const parsed = parseZip(zip)

  assert.equal(parsed.length, 2)
  assert.deepEqual(parsed.map((item) => item.name), ['第01张.jpg', '第02张.jpg'])
  for (let i = 0; i < entries.length; i += 1) {
    assert.equal(parsed[i].method, 0, '应为 STORE 模式')
    assert.equal(parsed[i].flags & 0x0800, 0x0800, '应置位 UTF-8 文件名标志')
    assert.equal(parsed[i].size, entries[i].data.length)
    assert.equal(parsed[i].compressedSize, entries[i].data.length)
    assert.equal(parsed[i].crc, crc32(entries[i].data), 'CRC 与实际内容不符')
    assert.deepEqual(Buffer.from(parsed[i].data), entries[i].data)
  }
})

test('空图集与空内容都不炸', () => {
  const empty = buildZipStore([])
  assert.deepEqual(parseZip(empty), [])

  const blank = parseZip(buildZipStore([{ name: 'empty.jpg', data: Buffer.alloc(0) }]))
  assert.equal(blank.length, 1)
  assert.equal(blank[0].size, 0)
  assert.equal(blank[0].crc, 0)
})

test('中文标题名不乱码（UTF-8 编码 + EFS 标志）', () => {
  const zip = buildZipStore([{ name: '告白气球_图集3张/第01张.jpg', data: Buffer.from('x') }])
  const parsed = parseZip(zip)
  assert.equal(parsed[0].name, '告白气球_图集3张/第01张.jpg')
})

test('字符串内容与 Buffer 等价，且条目顺序保持', () => {
  const zip = buildZipStore([
    { name: 'b.jpg', data: 'b' },
    { name: 'a.jpg', data: Buffer.from('a') },
  ])
  const parsed = parseZip(zip)
  assert.deepEqual(parsed.map((item) => item.name), ['b.jpg', 'a.jpg'])
  assert.deepEqual(parsed.map((item) => Buffer.from(item.data).toString()), ['b', 'a'])
})

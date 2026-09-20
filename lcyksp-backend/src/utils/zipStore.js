/**
 * 零依赖 ZIP 打包器（STORE / 不压缩模式）。
 *
 * 为什么不用现成库：图集里的图片本身已经是压缩过的 JPEG，deflate 几乎没有收益，
 * 却要多背一个依赖 + 一份 CPU。ZIP 的 STORE 模式只需要 CRC32 + 三段头部结构，
 * 自己写反而更小、更可控。
 *
 * 文件名统一按 UTF-8 编码并置位 general purpose flag 的 bit 11（EFS），
 * Windows / macOS / Linux 的解压工具都能正确还原中文名。
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c
  }
  return table
})()

export function crc32(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '')
  let crc = -1
  for (let i = 0; i < data.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff]
  }
  return (crc ^ -1) >>> 0
}

function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const year = Math.max(0, date.getFullYear() - 1980)
  const dateField = (year << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, date: dateField }
}

/**
 * @param {Array<{name: string, data: Buffer|string}>} entries
 * @returns {Buffer} 完整的 zip 文件内容
 */
export function buildZipStore(entries) {
  const list = Array.isArray(entries) ? entries : []
  const localParts = []
  const centralParts = []
  const { time, date } = dosDateTime()
  let offset = 0
  let count = 0

  for (const entry of list) {
    const nameBuffer = Buffer.from(String(entry?.name || 'file').replace(/\\/g, '/'), 'utf-8')
    const data = Buffer.isBuffer(entry?.data)
      ? entry.data
      : Buffer.from(entry?.data === undefined || entry?.data === null ? '' : entry.data)
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header signature
    local.writeUInt16LE(20, 4) // version needed to extract (2.0)
    local.writeUInt16LE(0x0800, 6) // flag: UTF-8 文件名
    local.writeUInt16LE(0, 8) // store
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18) // compressed size
    local.writeUInt32LE(data.length, 22) // uncompressed size
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28) // extra field length

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0) // central directory header signature
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10) // store
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk number start
    central.writeUInt16LE(0, 36) // internal attributes
    central.writeUInt32LE(0, 38) // external attributes
    central.writeUInt32LE(offset, 42) // relative offset of local header

    localParts.push(local, nameBuffer, data)
    centralParts.push(central, nameBuffer)
    offset += local.length + nameBuffer.length + data.length
    count += 1
  }

  const centralBuffer = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // end of central directory signature
  end.writeUInt16LE(0, 4) // disk number
  end.writeUInt16LE(0, 6) // disk with central directory
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...localParts, centralBuffer, end])
}

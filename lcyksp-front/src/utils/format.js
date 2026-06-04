/**
 * format.js — 通用格式化工具函数
 */

/**
 * 将字节数转为人类可读的文件大小字符串
 * @param {number} bytes - 字节数
 * @returns {string} 如 "1.5 MB"
 */
export function formatSize(bytes) {
  if (bytes === null || bytes === undefined) return '-'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let size = bytes
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024
    i++
  }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export default { formatSize }

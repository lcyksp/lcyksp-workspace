import { getDb } from '../config/db.js'

/**
 * 记录文件下载日志
 * @param {Object} params
 * @param {number|null} params.userId
 * @param {string|null} params.username
 * @param {string} params.ipAddress
 * @param {string} params.downloadType 'video' | 'tv' | 'transmit' 等
 * @param {string} params.resourceTitle 资源名称
 * @param {string} params.resourceUrl 原始资源链接/M3U8链接
 * @param {number} params.fileSize 文件大小 (字节)
 */
export async function logDownload({ userId, username, ipAddress, downloadType, resourceTitle, resourceUrl, fileSize }) {
  try {
    const db = getDb()
    await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO download_logs (user_id, username, ip_address, download_type, resource_title, resource_url, file_size) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          userId || null,
          username || 'guest',
          ipAddress,
          downloadType,
          resourceTitle || '',
          resourceUrl || '',
          fileSize || 0
        ],
        (err) => (err ? reject(err) : resolve())
      )
    })
    console.log(`[Logger] 成功记录下载日志: IP=${ipAddress}, User=${username || 'guest'}, Type=${downloadType}, Title=${resourceTitle}`);
  } catch (err) {
    console.error('[Logger] 记录下载日志失败:', err.message)
  }
}

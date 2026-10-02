// =====================================================================
//  yt-dlp 格式列表规范化（纯函数，可单测）
//
//  2026-10-02 从 routes/video.js 抽出：一是为了让「同清晰度去重」有单测覆盖，
//  二是这段逻辑与具体平台无关，放在 routes 里会越堆越大。
// =====================================================================

/**
 * 把 yt-dlp --dump-single-json 的 formats 数组整理成前端用的格式列表。
 *
 * @param {Array} rawFormats yt-dlp 的 formats
 * @param {{ dedupeSameQuality?: boolean }} [options]
 *   dedupeSameQuality：同一清晰度只保留一条（X 会成对给出 http 渐进式与 hls 分离流两条，
 *   不去重的话界面会出现两个一模一样的清晰度选项）。优先保留「含音轨」和「体积已知」的那条。
 */
export function normalizeAnalyzeFormats(rawFormats, options = {}) {
  const { dedupeSameQuality = false } = options
  const list = Array.isArray(rawFormats) ? rawFormats : []
  // yt-dlp 对部分平台（实测 X）只给估算值 filesize_approx，只读 filesize 会一律显示「大小未知」
  const rawSize = (item) => item.filesize || item.filesize_approx || 0

  let videoFormats = list
    .filter((item) => item.vcodec !== 'none')
    .map((item) => ({
      formatId: item.format_id,
      quality: item.format_note || item.resolution || (item.height ? `${item.height}p` : '未知清晰度'),
      ext: item.ext || 'mp4',
      filesize: rawSize(item) ? `${(rawSize(item) / 1024 / 1024).toFixed(1)} MB` : '大小未知',
      hasAudio: Boolean(item.acodec && item.acodec !== 'none'),
      mediaType: 'video',
      directUrl: '',
      audioUrl: '',
    }))

  if (dedupeSameQuality) {
    const score = (item) => (item.hasAudio ? 2 : 0) + (item.filesize === '大小未知' ? 0 : 1)
    const picked = new Map()
    for (const item of videoFormats) {
      const current = picked.get(item.quality)
      if (!current || score(item) > score(current)) picked.set(item.quality, item)
    }
    videoFormats = [...picked.values()]
  }

  const audioFormats = list
    .filter((item) => item.vcodec === 'none' && item.acodec && item.acodec !== 'none')
    .map((item) => ({
      formatId: `audio-${item.format_id}`,
      quality: item.format_note || item.format || item.ext || '仅音频',
      ext: item.ext || 'm4a',
      filesize: rawSize(item) ? `${(rawSize(item) / 1024 / 1024).toFixed(1)} MB` : '大小未知',
      hasAudio: true,
      mediaType: 'audio',
      directUrl: '',
      audioUrl: '',
      sourceFormatId: item.format_id,
    }))

  return [...videoFormats, ...audioFormats]
}

export default { normalizeAnalyzeFormats }

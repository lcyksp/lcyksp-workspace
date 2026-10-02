// =====================================================================
//  平台域名判定（纯函数，可单测）
//
//  2026-10-02 从 routes/video.js 抽出，同时修掉一个安全缺陷：
//  旧实现用 String.includes(domain) 做子串匹配，于是往白名单里加 'x.com'
//  会连带放行 'fox.com' / 'vortex.com' 这类无关域名（'x.com' 是它们的子串）。
//  现在一律按主机名精确 / 后缀匹配；只有 URL 解析失败时才退回带边界的
//  关键词匹配，既能兼容裸域名输入，也不会再出现子串误放行。
// =====================================================================

export const DOUYIN_DOMAINS = ['douyin.com', 'iesdouyin.com']
export const BILIBILI_DOMAINS = ['bilibili.com', 'b23.tv']
export const YOUTUBE_DOMAINS = ['youtube.com', 'youtu.be']
// X（Twitter）：帖子在 x.com / twitter.com，图片与视频直链在 twimg.com，短链是 t.co
export const X_DOMAINS = ['x.com', 'twitter.com', 'twimg.com', 't.co']

// 平台白名单：仅允许抖音 / B站 / X，拒绝 generic 任意 URL（防 SSRF）。
// 注意 iesdouyin.com 必须显式列出——它不是 douyin.com 的子域，只在旧子串匹配下侥幸通过。
export const ALLOWED_PLATFORM_DOMAINS = [...DOUYIN_DOMAINS, ...BILIBILI_DOMAINS, ...X_DOMAINS]

/** 取 URL 的主机名；解析失败（裸域名、分享文案、短链文本）返回空串。 */
export function urlHostname(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    return new URL(raw).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return ''
  }
}

/** 主机名与域名精确或后缀匹配（host === domain 或 host 以 .domain 结尾）。 */
export function hostMatchesDomain(host, domain) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '')
  const d = String(domain || '').toLowerCase()
  if (!h || !d) return false
  return h === d || h.endsWith(`.${d}`)
}

/**
 * 判断一段文本 / URL 是否命中给定域名集合。
 * URL 解析成功→按主机名后缀匹配；解析失败→用带左右边界的关键词匹配兜底
 * （边界保证 'douyin.com' 能匹配 'v.douyin.com/x'，但 'x.com' 不会匹配 'fox.com'）。
 */
export function matchesAnyDomain(value, domains) {
  const list = domains || []
  const host = urlHostname(value)
  if (host) return list.some((domain) => hostMatchesDomain(host, domain))

  const lower = String(value || '').toLowerCase()
  return list.some((domain) => {
    const escaped = String(domain).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[/.@:])${escaped}([/:?#]|$)`).test(lower)
  })
}

/** 平台判定：twitter / bilibili / douyin / youtube / generic。 */
export function detectPlatform(url) {
  if (matchesAnyDomain(url, X_DOMAINS)) return 'twitter'
  if (matchesAnyDomain(url, BILIBILI_DOMAINS)) return 'bilibili'
  if (matchesAnyDomain(url, DOUYIN_DOMAINS)) return 'douyin'
  if (matchesAnyDomain(url, YOUTUBE_DOMAINS)) return 'youtube'
  return 'generic'
}

/** 白名单校验：只放行抖音 / B站 / X 域名。 */
export function isAllowedPlatformUrl(url) {
  return matchesAnyDomain(url, ALLOWED_PLATFORM_DOMAINS)
}

export default {
  detectPlatform,
  isAllowedPlatformUrl,
  matchesAnyDomain,
  hostMatchesDomain,
  urlHostname,
  ALLOWED_PLATFORM_DOMAINS,
}

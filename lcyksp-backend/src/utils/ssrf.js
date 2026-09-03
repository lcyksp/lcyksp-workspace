import { promises as dnsPromises } from 'dns'
import net from 'net'

// =====================================================================
//  SSRF 防护工具：判断主机名 / URL 是否指向内网、回环、链路本地、
//  云元数据等不可信地址。用于所有“服务端主动访问用户提供的 URL”的端点。
// =====================================================================

const IPV4_BLOCK_RANGES = [
  { start: '0.0.0.0', end: '0.255.255.255' },       // 本网
  { start: '10.0.0.0', end: '10.255.255.255' },     // 私网
  { start: '100.64.0.0', end: '100.127.255.255' },  // CGNAT
  { start: '127.0.0.0', end: '127.255.255.255' },   // 回环
  { start: '169.254.0.0', end: '169.254.255.255' }, // 链路本地 / 云元数据 (169.254.169.254)
  { start: '172.16.0.0', end: '172.31.255.255' },   // 私网
  { start: '192.0.0.0', end: '192.0.0.255' },       // IETF 保留
  { start: '192.168.0.0', end: '192.168.255.255' }, // 私网
  { start: '198.18.0.0', end: '198.19.255.255' },   // 基准测试网段
  { start: '224.0.0.0', end: '239.255.255.255' },   // 组播
  { start: '240.0.0.0', end: '255.255.255.255' },   // 保留
]

function ipv4ToInt(ip) {
  const parts = String(ip).split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n < 0 || n > 255) return null
    value = value * 256 + n
  }
  return value
}

function isBlockedIpv4(ip) {
  const int = ipv4ToInt(ip)
  if (int === null) return false
  return IPV4_BLOCK_RANGES.some((range) => {
    const start = ipv4ToInt(range.start)
    const end = ipv4ToInt(range.end)
    return int >= start && int <= end
  })
}

function isBlockedIpv6(ip) {
  const lower = String(ip || '').toLowerCase()
  if (lower === '::' || lower === '::1') return true // 未指定 / 回环
  if (/^fe[89ab]/.test(lower)) return true // 链路本地 fe80::/10
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // ULA fc00::/7
  if (lower.startsWith('::ffff:')) return isBlockedIpv4(lower.slice(7)) // IPv4 映射
  return false
}

/**
 * 判断主机名是否指向不可信地址（内网 / 回环 / 链路本地 / 保留网段）。
 * - 支持 IP 字面量与域名（DNS 解析，任一解析结果命中即拦截，防 DNS rebinding）
 * - 解析失败一律视为不可信
 */
export async function isBlockedHostname(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '')
  if (!host) return true

  if (net.isIP(host)) {
    return net.isIPv4(host) ? isBlockedIpv4(host) : isBlockedIpv6(host)
  }

  try {
    const records = await dnsPromises.lookup(host, { all: true, verbatim: true })
    if (!records || records.length === 0) return true
    return records.some((record) =>
      net.isIPv4(record.address) ? isBlockedIpv4(record.address) : isBlockedIpv6(record.address),
    )
  } catch {
    return true
  }
}

/**
 * 校验 URL 可被服务端安全访问：
 * - 仅允许 http / https
 * - 禁止 URL 内嵌账号密码
 * - 解析后的主机名 / IP 不得指向内网等不可信地址
 * 返回规范化后的 URL 字符串，非法时抛出错误。
 */
export async function assertPublicUrl(rawUrl) {
  let parsed
  try {
    parsed = new URL(String(rawUrl || ''))
  } catch {
    throw new Error('无效的链接')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http/https 链接')
  }
  if (parsed.username || parsed.password) {
    throw new Error('链接中不允许包含账号密码')
  }
  if (await isBlockedHostname(parsed.hostname)) {
    throw new Error('不允许访问内网或本机地址')
  }
  return parsed.href
}

export default { assertPublicUrl, isBlockedHostname }

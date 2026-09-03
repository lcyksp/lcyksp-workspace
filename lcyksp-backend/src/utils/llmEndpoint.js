// =====================================================================
//  LLM 端点工具：统一构造 OpenAI 兼容的 /chat/completions 请求地址
//  供 recipe.js / admin.js / githubAi.js 等共用，避免各处重复且不一致。
// =====================================================================

const DEFAULT_ENDPOINT = 'https://api.deepseek.com/chat/completions'

/**
 * 规范化 LLM API 地址：
 * - 空值 / 非字符串 / 空白 → 回退到默认地址
 * - 已包含 /chat/completions → 原样返回
 * - 否则去掉尾部斜杠后追加 /chat/completions
 */
export function normalizeEndpoint(url) {
  if (!url || typeof url !== 'string') return DEFAULT_ENDPOINT
  const trimmed = url.trim()
  if (!trimmed) return DEFAULT_ENDPOINT
  if (trimmed.indexOf('/chat/completions') !== -1) return trimmed
  return trimmed.replace(/\/+$/, '') + '/chat/completions'
}

export default { normalizeEndpoint }

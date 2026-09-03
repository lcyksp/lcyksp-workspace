export function getClientIp(req) {
  // 原来直接取 X-Forwarded-For 的第一段，而这一段完全由客户端提供 ——
  // 随手加个头就能换一个「新 IP」，所有按 IP 的配额和限流都形同虚设。
  // app.js 已设 trust proxy=1（Nginx 是唯一前置代理，它把真实 remote_addr
  // 追加在 XFF 末尾），Express 算出来的 req.ip 才是不可伪造的那个。
  return req.ip || req.socket?.remoteAddress || 'unknown'
}

export function isTurnstileEnabled() {
  return Boolean(process.env.TURNSTILE_SECRET_KEY)
}

export async function verifyTurnstileToken(token, ip) {
  if (!isTurnstileEnabled()) return { success: true, skipped: true }
  if (!token) return { success: false, message: '请先完成人机验证' }

  try {
    const params = new URLSearchParams()
    params.set('secret', process.env.TURNSTILE_SECRET_KEY)
    params.set('response', token)
    if (ip) params.set('remoteip', ip)

    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
    const result = await response.json()
    if (result?.success) return { success: true }
    return { success: false, message: '人机验证未通过，请重试' }
  } catch {
    return { success: false, message: '人机验证服务连接失败，请稍后再试' }
  }
}

export function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim()
  }
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

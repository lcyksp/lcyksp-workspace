// 抖音直连出口探测：跟踪本机公网 IP 是否被抖音解封。
// 背景：机房 IP 被标记后解析走动态池（按量付费）；直连解封后按「直连额度」自动切回直连、池消耗停止。
// 直连探测是裸 fetch（零池额度消耗）；池出口的健康度由真实解析的自动重试现场检验，不单独探测。
// 状态翻转只打日志、不发邮件（2026-09-13 站长拍板）：出口切换本来就是自动的，不需要人介入，避免打扰。
import { poolEnabled } from './douyinPool.js'
import { resetDirectBudget } from './douyinDirectBudget.js'

let directState = 'unknown' // 'unknown' | 'ok' | 'blocked'
let lastProbeAt = ''
let lastChangeAt = ''

export function markDirectSuspect() {
  if (directState !== 'blocked') {
    directState = 'blocked'
    lastChangeAt = new Date().toISOString()
    console.error('[DouyinGate] 请求级信号：直连出口被拒，本次解析改用池出口（待定时探测确认）')
  }
}

export function getDouyinGateState() {
  return { direct: directState, lastProbeAt, lastChangeAt }
}

function beijingTime() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' (北京时间)'
}

export async function recordGateProbe(isOk) {
  const prev = directState
  directState = isOk ? 'ok' : 'blocked'
  lastProbeAt = new Date().toISOString()
  if (prev === directState) return
  lastChangeAt = lastProbeAt

  const poolReady = await poolEnabled().catch(() => false)
  // 刚刚解封：把「直连额度」恢复成可用，让解封后的第一次解析马上能用上免费出口
  if (prev === 'blocked' && directState === 'ok') {
    await resetDirectBudget().catch(() => {})
  }
  const tail = directState === 'ok'
    ? '解析将按「直连额度」自动切回直连（每 4 小时一次），其余时间继续走池'
    : poolReady
      ? '解析已切换为动态池出口（按量计费）'
      : '当前未配置动态池，解析暂时不可用'
  console.error(`[DouyinGate] 直连出口状态变化: ${prev} → ${directState}（${beijingTime()}）——${tail}`)
}

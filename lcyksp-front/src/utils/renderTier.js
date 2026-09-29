// 首页 3D 星象挂载前的一次性渲染能力探测：有没有可用 WebGL、是不是软件渲染（无独显）。
// 模块级缓存——探测本身要建一个临时 WebGL 上下文，整站只付一次这个代价。
let cached = null

export function getRenderTier() {
  if (cached) return cached
  // 开发调试开关：localStorage.setItem('__forceWeak', '1') 后整站按"无 WebGL2 的软渲染弱端"处理，
  // 便于在强机器上验证 CSS 星空 / 经典超分 / PDF 低清档等弱端链路；正常用户不会走到。
  try {
    if (window.localStorage.getItem('__forceWeak') === '1') {
      cached = { webglOk: false, hasWebGL2: false, isSoftware: true, renderer: '' }
      return cached
    }
  } catch { /* 隐私模式下 localStorage 可能被禁，按正常探测走 */ }

  let webglOk = false
  let hasWebGL2 = false
  let isSoftware = false
  let renderer = ''
  try {
    const canvas = document.createElement('canvas')
    // three r163 起只要 WebGL2，WebGL1-only 的老机器对 three 而言等同没有：
    // 星象分流看 hasWebGL2；webglOk 保留"至少有 WebGL1"的语义，供泛化弱端判定用
    let gl = canvas.getContext('webgl2')
    if (gl) {
      webglOk = true
      hasWebGL2 = true
    } else {
      gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
      if (gl) webglOk = true
    }
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      if (ext) renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '')
      // SwiftShader=Chrome 软件回退、llvmpipe=Mesa 软渲、Microsoft Basic Render=Win 无驱动回退
      isSoftware = /swiftshader|llvmpipe|software|basic render|microsoft basic/i.test(renderer)
      // 主动释放：浏览器同时存活的 WebGL 上下文有上限，探测用的这个别占着
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  } catch {
    webglOk = false
    hasWebGL2 = false
  }
  cached = { webglOk, hasWebGL2, isSoftware, renderer }
  return cached
}

export function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

// 弱端综合判定：软件渲染/无 WebGL（无独显）、或逻辑核心≤2、或内存≤4G。
// PDF 整册渲染的清晰度/画布上限、AI 图片超分的默认模式都据此取舍。
//
// 已知盲区（刻意不修，由运行时自适应兜底，别试图往正则里补）：
// - Firefox 默认把 UNMASKED_RENDERER_WEBGL 掩码成 "Mozilla"，SwiftShader/llvmpipe 在
//   Firefox 上探不出来——星象跑不动时由 cosmosEngine 的 FPS 降档 / @failed 回落兜住；
// - deviceMemory 只有 Chromium 实现，Safari/Firefox 不存在（按 8 回落）。
export function isWeakDevice() {
  const tier = getRenderTier()
  const cores = navigator.hardwareConcurrency || 8
  const mem = navigator.deviceMemory || 8
  return !tier.webglOk || tier.isSoftware || cores <= 2 || mem <= 4
}

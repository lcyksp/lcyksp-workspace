// 程序化生成地球贴图：把 public/geo/land-110m.json 的矢量海岸线画进离屏 canvas，
// 不使用任何卫星影像，所以既没有版权问题，也不用为几 MB 的图片付带宽。
// 等距圆柱投影，与 three.js SphereGeometry 的 UV 一一对应：
// u = (lon + 180) / 360，图像首行（v = 1）是北极。

const GEO_URL = '/geo/land-110m.json'

export const EARTH_PALETTE = {
  oceanPolar: '#040e1c',
  oceanEquator: '#0a1d35',
  land: '#10322f',
  coast: 'rgba(88, 224, 207, 0.62)',
  coastHalo: 'rgba(88, 224, 207, 0.16)',
}

// 增量编码解码：首点是绝对值，其后存差分，量化系数由 q 给出
export async function loadLandRings(url = GEO_URL) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`海岸线数据加载失败 ${res.status}`)
  const { q, rings } = await res.json()
  return rings.map((flat) => {
    const pts = new Float32Array(flat.length)
    let x = 0
    let y = 0
    for (let i = 0; i < flat.length; i += 2) {
      if (i === 0) {
        x = flat[0]
        y = flat[1]
      } else {
        x += flat[i]
        y += flat[i + 1]
      }
      pts[i] = x / q
      pts[i + 1] = y / q
    }
    return pts
  })
}

function tracePath(ctx, rings, width, height) {
  ctx.beginPath()
  for (const pts of rings) {
    for (let i = 0; i < pts.length; i += 2) {
      const x = ((pts[i] + 180) / 360) * width
      const y = ((90 - pts[i + 1]) / 180) * height
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
  }
}

// 数据里唯一一处相邻点经度跳变是南极洲沿 -90° 纬线的闭合边，
// 在等距圆柱投影下就画在图像最底边，不会产生横贯条纹，所以不需要处理换日线
export function drawEarthTexture(rings, options = {}) {
  const { width = 2048, palette = EARTH_PALETTE } = options
  const height = width >> 1
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { alpha: false })

  const ocean = ctx.createLinearGradient(0, 0, 0, height)
  ocean.addColorStop(0, palette.oceanPolar)
  ocean.addColorStop(0.5, palette.oceanEquator)
  ocean.addColorStop(1, palette.oceanPolar)
  ctx.fillStyle = ocean
  ctx.fillRect(0, 0, width, height)

  const scale = width / 2048
  tracePath(ctx, rings, width, height)
  // evenodd：构建脚本把外环和内环拍平进了同一个列表，奇偶规则能正确挖出大湖
  ctx.fillStyle = palette.land
  ctx.fill('evenodd')

  ctx.lineJoin = 'round'
  ctx.strokeStyle = palette.coastHalo
  ctx.lineWidth = Math.max(1, 6 * scale)
  ctx.stroke()
  ctx.strokeStyle = palette.coast
  ctx.lineWidth = Math.max(1, 1.6 * scale)
  ctx.stroke()

  return canvas
}

// 1×1 纯黑：真实贴图还没下完时先占住采样位，避免绑定空纹理
export function drawBlankTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, 1, 1)
  return canvas
}

// 径向渐变小图，恒星、太阳光晕、行星光点、定位脉冲点共用一张
export function drawGlowTexture(size = 64) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const r = size / 2
  const g = ctx.createRadialGradient(r, r, 0, r, r, r)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.28, 'rgba(255,255,255,0.55)')
  g.addColorStop(0.62, 'rgba(255,255,255,0.12)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return canvas
}

// 日冕。峰值压在 limb 这个半径上，也就是日面边缘：精灵是加法混合又不写深度，
// 日面球体会把它内侧那一半挡掉，于是「中间掏空」是免费的，日面细节不会被糊平。
// limb = 太阳半径 / 精灵半宽，调用方按 scale 对上就行
export function drawCoronaTexture(size = 256, limb = 0.25) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const r = size / 2
  const g = ctx.createRadialGradient(r, r, 0, r, r, r)
  g.addColorStop(0, 'rgba(255,255,255,0.2)')
  g.addColorStop(limb * 0.75, 'rgba(255,255,255,0.4)')
  g.addColorStop(limb, 'rgba(255,255,255,1)')
  g.addColorStop(limb + 0.07, 'rgba(255,255,255,0.3)')
  g.addColorStop(limb + 0.2, 'rgba(255,255,255,0.085)')
  g.addColorStop(0.64, 'rgba(255,255,255,0.022)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return canvas
}

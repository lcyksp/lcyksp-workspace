// 天体历算：全部纯函数，100% 客户端计算，不依赖任何后端接口。
// 精度目标：太阳 ~0.01°，行星 ~1′（1800–2050），月球 ~0.3°。够做可视化，不够做导航。
const DEG = Math.PI / 180
const J2000 = 2451545.0

export function julianDay(date) {
  return date.getTime() / 86400000 + 2440587.5
}

export function daysSinceJ2000(date) {
  return julianDay(date) - J2000
}

function norm360(x) {
  return ((x % 360) + 360) % 360
}

function norm180(x) {
  const v = norm360(x)
  return v > 180 ? v - 360 : v
}

export function obliquity(n) {
  return 23.4392911 - 3.563e-7 * n
}

// Astronomical Almanac 低精度太阳位置
export function sunEcliptic(n) {
  const meanLon = 280.46646 + 0.9856474 * n
  const meanAnomaly = norm360(357.52911 + 0.9856003 * n)
  const g = meanAnomaly * DEG
  const lambda = norm360(meanLon + 1.914602 * Math.sin(g) + 0.019993 * Math.sin(2 * g))
  const r = 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g)
  return { lambda, r, meanAnomaly }
}

export function sunEquatorial(n) {
  const { lambda } = sunEcliptic(n)
  const eps = obliquity(n) * DEG
  const l = lambda * DEG
  return {
    ra: norm360(Math.atan2(Math.cos(eps) * Math.sin(l), Math.cos(l)) / DEG),
    dec: Math.asin(Math.sin(eps) * Math.sin(l)) / DEG,
  }
}

// 格林尼治平恒星时。忽略赤经章动，差值在角秒量级
export function gmstDegrees(n) {
  return norm360((18.697374558 + 24.06570982441908 * n) * 15)
}

// 太阳直下点：昼夜与晨昏线的唯一输入
export function subsolarPoint(date) {
  const n = daysSinceJ2000(date)
  const { ra, dec } = sunEquatorial(n)
  return { lat: dec, lon: norm180(ra - gmstDegrees(n)) }
}

// Standish/JPL 近似开普勒根数，适用 1800–2050。每行前 6 个是 J2000 历元值
// a(AU) e I(°) L(°) ϖ(°) Ω(°)，后 6 个是各自的每儒略世纪变化率。
const PLANET_ELEMENTS = {
  mercury: [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593,
    0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
  venus: [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255,
    0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418],
  earth: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0,
    0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0],
  mars: [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891,
    0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  jupiter: [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909,
    -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
  saturn: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448,
    -0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
  uranus: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.9542763, 74.01692503,
    -0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589],
  neptune: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574,
    0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664],
}

export const PLANET_KEYS = Object.keys(PLANET_ELEMENTS)
export const AU_KM = 149597870.7

// 牛顿迭代解开普勒方程 E - e·sinE = M
function eccentricAnomaly(meanAnomaly, e) {
  let E = meanAnomaly
  for (let i = 0; i < 12; i++) {
    const dE = (E - e * Math.sin(E) - meanAnomaly) / (1 - e * Math.cos(E))
    E -= dE
    if (Math.abs(dE) < 1e-12) break
  }
  return E
}

// 日心 J2000 黄道直角坐标（AU）：x 指向春分点，z 指向黄道北极
export function planetHeliocentric(key, n) {
  const el = PLANET_ELEMENTS[key]
  if (!el) return null
  const T = n / 36525
  const a = el[0] + el[6] * T
  const e = el[1] + el[7] * T
  const inc = (el[2] + el[8] * T) * DEG
  const meanLon = el[3] + el[9] * T
  const periLon = el[4] + el[10] * T
  const node = (el[5] + el[11] * T) * DEG
  const argPeri = periLon * DEG - node

  const E = eccentricAnomaly(norm180(meanLon - periLon) * DEG, e)
  const xv = a * (Math.cos(E) - e)
  const yv = a * Math.sqrt(1 - e * e) * Math.sin(E)

  const cw = Math.cos(argPeri)
  const sw = Math.sin(argPeri)
  const cn = Math.cos(node)
  const sn = Math.sin(node)
  const ci = Math.cos(inc)
  const si = Math.sin(inc)
  return {
    x: (cw * cn - sw * sn * ci) * xv + (-sw * cn - cw * sn * ci) * yv,
    y: (cw * sn + sw * cn * ci) * xv + (-sw * sn + cw * cn * ci) * yv,
    z: sw * si * xv + cw * si * yv,
  }
}

export function planetStates(n) {
  const out = {}
  for (const key of PLANET_KEYS) out[key] = planetHeliocentric(key, n)
  return out
}

// Meeus《天文算法》47 章 ELP2000 截断：经度/距离取表 47.A 前 14 项，纬度取表 47.B 前 8 项。
// 每行是 (D, M, M', F) 的系数，后面跟 Σl(1e-6 度) 与 Σr(0.001 km)。
const MOON_LR = [
  [0, 0, 1, 0, 6288774, -20905355],
  [2, 0, -1, 0, 1274027, -3699111],
  [2, 0, 0, 0, 658314, -2955968],
  [0, 0, 2, 0, 213618, -569925],
  [0, 1, 0, 0, -185116, 48888],
  [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158],
  [2, -1, -1, 0, 57066, -152138],
  [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586],
  [0, 1, -1, 0, -40923, -129620],
  [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755],
  [2, 0, 0, -2, 15327, 10321],
]
const MOON_B = [
  [0, 0, 0, 1, 5128122],
  [0, 0, 1, 1, 280602],
  [0, 0, 1, -1, 277693],
  [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413],
  [2, 0, -1, -1, 46271],
  [2, 0, 0, 1, 32573],
  [0, 0, 2, 1, 17198],
]

// 地心 J2000 黄道球坐标：黄经/黄纬（度）与地心距（km）
export function moonGeocentric(n) {
  const T = n / 36525
  const meanLon = 218.3164477 + 481267.88123421 * T - 0.0015786 * T * T
  const D = (297.8501921 + 445267.1114034 * T - 0.0018819 * T * T) * DEG
  const M = (357.5291092 + 35999.0502909 * T - 0.0001536 * T * T) * DEG
  const Mp = (134.9633964 + 477198.8675055 * T + 0.0087414 * T * T) * DEG
  const F = (93.272095 + 483202.0175233 * T - 0.0036539 * T * T) * DEG
  // 含 M 的项要按地球轨道偏心率的长期变化缩放，见 Meeus 47.6
  const ecc = 1 - 0.002516 * T - 0.0000074 * T * T

  let sumL = 0
  let sumR = 0
  let sumB = 0
  for (const [d, m, mp, f, cl, cr] of MOON_LR) {
    const k = m === 0 ? 1 : Math.abs(m) === 1 ? ecc : ecc * ecc
    const arg = d * D + m * M + mp * Mp + f * F
    sumL += cl * k * Math.sin(arg)
    sumR += cr * k * Math.cos(arg)
  }
  for (const [d, m, mp, f, cb] of MOON_B) {
    const k = m === 0 ? 1 : Math.abs(m) === 1 ? ecc : ecc * ecc
    sumB += cb * k * Math.sin(d * D + m * M + mp * Mp + f * F)
  }

  return {
    lambda: norm360(meanLon + sumL / 1e6),
    beta: sumB / 1e6,
    distanceKm: 385000.56 + sumR / 1000,
  }
}

// 黄道球坐标 → 直角坐标，与 planetHeliocentric 同一坐标系与单位约定
export function eclipticToRect(lambda, beta, r) {
  const l = lambda * DEG
  const b = beta * DEG
  const cb = Math.cos(b)
  return { x: r * cb * Math.cos(l), y: r * cb * Math.sin(l), z: r * Math.sin(b) }
}

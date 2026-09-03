// 单场景单相机的宇宙引擎：地球特写与太阳系全景是同一个 three.js 场景的两个
// 缩放状态，靠 setZoom(0→1) 连续插值过渡，全程不销毁不重建任何对象。
//
// 坐标系约定：
//   local  地固系，lonLatToVec3 给出，+Y 是北极
//   eq     当日平赤道系，X 指春分点
//   ecl    当日黄道系
//   three  世界坐标，黄道面躺在 XZ 上，+Y 是黄道北极
// 地球朝向 = mEclToThree · Rx(-ε) · mLocalToEq，是物理正确的真实朝向。
// 太阳方向以「地固系」传给着色器，所以晨昏线不受任何世界朝向变化影响。
// 月球潮汐锁定后同一面永远朝地球，月相的太阳方向单独取地球的真实日心方向——
// 轨道半径被 ORBIT_POW 压缩过，拿月球在场景里的位置去算会差出十几度；月相还要再补
// 一次相机视差，因为月地距离被压到了真实值的三十分之一，详见 place() 里的那段注释。
//
// 已离线校验过的两条不变量：地轴与黄道北极夹角恒等于 obliquity(n)、地轴黄经恒为
// 90°；直下点经 earthMatrix 转到世界后与「地球指向太阳」的夹角在 J2000 处为
// 0.002°，2026 年为 0.37°——差值正好是 J2000 以来的总岁差，因为行星位置用的是
// J2000 黄道而地球朝向用的是当日黄道。这点错配只影响世界坐标里的相对朝向，
// 不进晨昏线，0.37° 肉眼不可见，所以不为它引入岁差矩阵。
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, CanvasTexture, ClampToEdgeWrapping, Group,
  LineBasicMaterial, LineLoop, MathUtils, Matrix4, Mesh,
  MeshLambertMaterial, PerspectiveCamera, PointLight, Points, PointsMaterial,
  Quaternion, Raycaster, RepeatWrapping, Scene, ShaderMaterial, SphereGeometry,
  Sprite, SpriteMaterial, TextureLoader, Vector2, Vector3, WebGLRenderer,
} from 'three'
import {
  PLANET_KEYS, daysSinceJ2000, eclipticToRect, gmstDegrees, moonGeocentric,
  obliquity, planetHeliocentric, subsolarPoint,
} from './astro.js'
import { drawBlankTexture, drawCoronaTexture, drawEarthTexture, drawGlowTexture } from './geoTexture.js'
import {
  EARTH_FRAGMENT, EARTH_VERTEX, MOON_FRAGMENT, MOON_VERTEX, SUN_FRAGMENT, SUN_VERTEX,
  createEarthUniforms, createMoonUniforms, createSunUniforms,
} from './cosmosShaders.js'
// NASA 公有领域影像（Blue Marble / Earth at Night / LRO 月面），已转成 WebP 并降到
// 够用的分辨率。这里 import 的是 URL，交给 Vite 打上 hash 落进 /assets/，
// 命中线上 1 年 immutable 缓存；图片不进 gzip_types，服务器 CPU 开销为 0
import EARTH_DAY_2048 from '../assets/cosmos/earth-day-2048.webp'
import EARTH_DAY_1024 from '../assets/cosmos/earth-day-1024.webp'
import EARTH_NIGHT_1024 from '../assets/cosmos/earth-night-1024.webp'
import MOON_512 from '../assets/cosmos/moon-512.webp'
import MOON_NEAR_512 from '../assets/cosmos/moon-near-512.webp'

const DEG = Math.PI / 180
const FOV = 45
const TAN_HALF_FOV = Math.tan((FOV * DEG) / 2)
// 轨道半径压缩：保留真实黄经与倾角，只把半径开 0.35 次方，
// 这样水星不会挤成一个点，海王星也不会跑到天边，偏心率还是照实显示
const ORBIT_K = 7.6
const ORBIT_POW = 0.35
// 海王星压缩后的轨道半径，全景视角按它取景
const SOLAR_RADIUS = ORBIT_K * Math.pow(30.07, ORBIT_POW)
const SOLAR_ELEVATION = 62 * DEG
// 特写状态地球占画面短边的 1/3.2。留这么大的余量不是为了 HUD，而是为了月球：同一个
// 画框里，月地距离和地球的视觉大小是同一个换算关系的两端，地球占得越满月球就越贴脸
const EARTH_MARGIN = 3.2
// 月球摆在画面可视半径的 0.8 处，也就是 2.56 个地球半径（真实约 60）。这是短边方向的
// 极限值，长边方向还有余量，所以任何视口比例下这个距离都能恒定，不会忽远忽近
const MOON_DIST = EARTH_MARGIN * 0.8
const IDLE_SPIN = 1.5 * DEG
// 月球绕地球换边时的最大角速度：屏幕上那圈半径最大约 230 px，0.18 rad/s 折算成
// 40 px/s 上下，换一次边滑十几秒，看着就是慢慢绕过去，而不是「啪」地闪一下
const MOON_SLEW = 0.18
const ZOOM_MS = 1700
const EPHEMERIS_MS = 200
// 日冕贴图里日面边缘所在的半径比例，精灵缩放按它反推
const CORONA_LIMB = 0.25

const PLANET_RADIUS = {
  mercury: 0.14, venus: 0.3, earth: 0.46, mars: 0.2,
  jupiter: 0.95, saturn: 0.82, uranus: 0.55, neptune: 0.53,
}
const PLANET_COLOR = {
  mercury: 0x9a9188, venus: 0xd8c39a, earth: 0x3f7fbf, mars: 0xc4694a,
  jupiter: 0xd2a679, saturn: 0xe0cd9a, uranus: 0x9fd6e0, neptune: 0x6f8fd6,
}
const SIDEREAL_DAYS = {
  mercury: 87.9691, venus: 224.7008, earth: 365.2564, mars: 686.98,
  jupiter: 4332.589, saturn: 10759.22, uranus: 30685.4, neptune: 60189,
}

const smoothstep = (a, b, x) => {
  const t = MathUtils.clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

// 地固系单位向量，+Y 北极，与 SphereGeometry 的 UV 严格对应
function lonLatToVec3(lon, lat, out = new Vector3()) {
  const la = lat * DEG
  const lo = lon * DEG
  const c = Math.cos(la)
  return out.set(c * Math.cos(lo), Math.sin(la), -c * Math.sin(lo))
}

// 黄道直角坐标 → three 世界坐标，顺手把轨道半径开 ORBIT_POW 次方压缩
function displayPos(v, out = new Vector3()) {
  const r = Math.hypot(v.x, v.y, v.z)
  const k = r > 0 ? (ORBIT_K * Math.pow(r, ORBIT_POW)) / r : 0
  return out.set(v.x * k, v.z * k, -v.y * k)
}

// 让 2·halfWidth × 2·halfHeight 的目标刚好进画面。竖屏手机水平 FOV 更小，
// 于是自动退得更远，移动端不需要另写一套参数
function fitDistance(halfWidth, halfHeight, aspect, margin = 1.2) {
  return Math.max(
    (halfHeight * margin) / TAN_HALF_FOV,
    (halfWidth * margin) / (TAN_HALF_FOV * aspect),
  )
}

// 黄道系 (x,y,z) → three (x,z,-y)，行列式 +1
const mEclToThree = new Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1)
const mLocalToEq = new Matrix4()
const mEqToEcl = new Matrix4()

// 地固系 → 世界的真实朝向：先按格林尼治恒星时把地固系转到当日平赤道系，
// 再绕 X 轴倾 -ε 到黄道系，最后换轴。这是地球在此刻的物理朝向，不是摆好看的
function earthMatrix(n, out = new Matrix4()) {
  const g = gmstDegrees(n) * DEG
  const cg = Math.cos(g)
  const sg = Math.sin(g)
  mLocalToEq.set(cg, 0, sg, 0, sg, 0, -cg, 0, 0, 1, 0, 0, 0, 0, 0, 1)
  mEqToEcl.makeRotationX(-obliquity(n) * DEG)
  return out.multiplyMatrices(mEclToThree, mEqToEcl).multiply(mLocalToEq)
}

// 球面均匀撒点：z 必须均匀分布，否则两极会堆积。亮度用顶点色抖动，
// 比逐星改 size 便宜（PointsMaterial 只有一个 size）
function buildStarfield(count, texture) {
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const z = Math.random() * 2 - 1
    const a = Math.random() * Math.PI * 2
    const r = Math.sqrt(1 - z * z) * 400
    positions[i * 3] = r * Math.cos(a)
    positions[i * 3 + 1] = z * 400
    positions[i * 3 + 2] = r * Math.sin(a)
    const b = 0.25 + Math.pow(Math.random(), 2.2) * 0.75
    colors[i * 3] = b * 0.82
    colors[i * 3 + 1] = b * 0.9
    colors[i * 3 + 2] = b
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('color', new BufferAttribute(colors, 3))
  const points = new Points(
    geometry,
    new PointsMaterial({
      map: texture,
      size: 2.6,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    }),
  )
  points.frustumCulled = false
  return points
}

const SOLAR_HALF_H = SOLAR_RADIUS * Math.sin(SOLAR_ELEVATION)
const ECL_NORTH = new Vector3(0, 1, 0)
const FADE_MS = 700
// 场景里地球半径就是 1，所以月地真实距离换算成场景单位只需除以地球半径
const EARTH_RADIUS_KM = 6371

export function createCosmos(options = {}) {
  const { canvas, rings = [], location = null } = options
  const low = options.quality === 'low'

  const renderer = new WebGLRenderer({
    canvas, alpha: false, antialias: !low, powerPreference: 'high-performance',
  })
  renderer.setClearColor(0x02050c, 1)

  const scene = new Scene()
  const camera = new PerspectiveCamera(FOV, 1, 0.05, 1600)

  const glowMap = new CanvasTexture(drawGlowTexture(64))
  const coronaMap = new CanvasTexture(drawCoronaTexture(256, CORONA_LIMB))
  const blankMap = new CanvasTexture(drawBlankTexture())
  // 矢量地球只是真实贴图下完前的占位，所以一律画 1024：2048 的 canvas 要多花
  // 上百毫秒描海岸线再传 8 MB 到显存，而它只会显示几百毫秒，不值得。
  // 贴图刻意不设 colorSpace：着色器里已经手动 pow(2.2) 解码，
  // 再让 three 走 sRGB 内部格式就会解码两次
  const earthMap = new CanvasTexture(drawEarthTexture(rings, { width: 1024 }))
  // 各向异性过滤取硬件上限：地球是个球，靠边的地方 UV 拉伸极大，
  // 这一项不占带宽也不占显存，只在采样时多取几个点，是最便宜的清晰度
  const maxAniso = renderer.capabilities.getMaxAnisotropy()
  const aniso = Math.min(maxAniso, low ? 4 : 16)
  earthMap.anisotropy = aniso

  scene.add(buildStarfield(low ? 600 : 1500, glowMap))

  // distance 0 + decay 0：不做距离衰减。真实的 1/r² 会让海王星彻底黑掉，
  // 而这一个光源就够让所有 Lambert 天体拿到正确的太阳相位
  scene.add(new PointLight(0xffffff, 3.2, 0, 0))

  const sunUniforms = createSunUniforms()
  const sun = new Mesh(
    new SphereGeometry(1, low ? 24 : 32, low ? 16 : 24),
    new ShaderMaterial({
      uniforms: sunUniforms, vertexShader: SUN_VERTEX, fragmentShader: SUN_FRAGMENT,
    }),
  )
  // 内层日冕紧贴日面边缘，外层是一大圈几乎看不见的暖调漫光，把太阳系视角的
  // 中心稳住。两层都是加法混合且不写深度，被日面球体挡住的部分自然消失
  const corona = new Sprite(new SpriteMaterial({
    map: coronaMap, color: 0xffd9a0, transparent: true, depthWrite: false, blending: AdditiveBlending,
  }))
  const halo = new Sprite(new SpriteMaterial({
    map: glowMap, color: 0xff9d4a, opacity: 0.16, transparent: true, depthWrite: false, blending: AdditiveBlending,
  }))
  scene.add(sun, corona, halo)

  // earthGroup 只负责位置，永远不缩放，这样月球和定位点可以当孩子挂上来；
  // 缩放和自转都落在 earthMesh 上
  const earthUniforms = createEarthUniforms(earthMap, blankMap)
  const earthMesh = new Mesh(
    new SphereGeometry(1, low ? 40 : 64, low ? 28 : 44),
    new ShaderMaterial({
      uniforms: earthUniforms, vertexShader: EARTH_VERTEX, fragmentShader: EARTH_FRAGMENT,
    }),
  )
  const earthGroup = new Group()
  const markerGroup = new Group()
  earthMesh.add(markerGroup)
  earthGroup.add(earthMesh)
  scene.add(earthGroup)

  const ballGeometry = new SphereGeometry(1, 20, 14)
  const moonUniforms = createMoonUniforms(blankMap)
  const moon = new Mesh(ballGeometry, new ShaderMaterial({
    uniforms: moonUniforms, vertexShader: MOON_VERTEX, fragmentShader: MOON_FRAGMENT,
  }))
  earthGroup.add(moon)

  const bodies = new Map()
  const pickables = [earthMesh, moon, sun, corona]
  const pickMap = new Map([[earthMesh, 'earth'], [moon, 'moon'], [sun, 'sun'], [corona, 'sun']])

  for (const key of PLANET_KEYS) {
    const color = PLANET_COLOR[key]
    const glow = new Sprite(new SpriteMaterial({
      map: glowMap, color, transparent: true, depthWrite: false, blending: AdditiveBlending,
    }))
    scene.add(glow)
    // 地球用的是自定义着色器那颗球，其余行星共用一份 Lambert 球
    let holder = earthGroup
    let scalable = earthMesh
    if (key !== 'earth') {
      holder = new Mesh(ballGeometry, new MeshLambertMaterial({ color }))
      scalable = holder
      scene.add(holder)
      pickables.push(holder)
      pickMap.set(holder, key)
    }
    pickables.push(glow)
    pickMap.set(glow, key)
    bodies.set(key, { holder, scalable, glow, radius: PLANET_RADIUS[key], pos: new Vector3() })
  }

  const now0 = new Date()
  const n0 = daysSinceJ2000(now0)

  // 轨道线只在初始化时按真实历元采一圈，偏心率与倾角自然就画出来了。
  // 根数的长期漂移在几十年尺度上肉眼不可见，所以不重建
  const orbitMaterials = []
  const orbitGroup = new Group()
  scene.add(orbitGroup)
  for (const key of PLANET_KEYS) {
    const period = SIDEREAL_DAYS[key]
    const pts = new Float32Array(128 * 3)
    const v = new Vector3()
    for (let i = 0; i < 128; i++) {
      displayPos(planetHeliocentric(key, n0 + (period * i) / 128), v)
      pts[i * 3] = v.x
      pts[i * 3 + 1] = v.y
      pts[i * 3 + 2] = v.z
    }
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(pts, 3))
    const material = new LineBasicMaterial({
      color: PLANET_COLOR[key], transparent: true, opacity: 0, depthWrite: false,
    })
    orbitMaterials.push(material)
    orbitGroup.add(new LineLoop(geometry, material))
  }

  const markers = []
  const bodyStates = {}
  const raycaster = new Raycaster()
  const ndc = new Vector2()
  const tmp = new Vector3()
  const worldNormal = new Vector3()
  const viewDir = new Vector3()
  const camTarget = new Vector3()
  const camRight = new Vector3()
  const camUp = new Vector3()
  const moonDir = new Vector3()
  const moonOffset = new Vector3()
  const moonX = new Vector3()
  const moonY = new Vector3()
  const moonZ = new Vector3()
  const moonBasis = new Matrix4()
  const moonBase = new Quaternion()
  const moonSunTrue = new Vector3(1, 0, 0)
  const moonWorld = new Vector3()
  const moonViewCam = new Vector3()
  const moonViewTrue = new Vector3()
  const moonPhase = new Quaternion()
  const orientation = new Matrix4()

  let epoch = null
  let zoomT = 0
  let zoomFrom = 0
  let zoomTo = 0
  let zoomStart = 0
  let zoomDur = 0
  let azimuth = 0
  // 月球在画面上绕地球的方位角，第一帧直接对准真值，之后按 MOON_SLEW 限速跟随
  let moonAngle = null
  let baseElevation = 18 * DEG
  let idle = true
  let paused = false
  let raf = 0
  let lastFrame = 0
  let lastEphemeris = 0
  let ephemerisDirty = true
  let aspect = 1
  let moonTrueUnits = 60
  // 低档不是不要分辨率，而是不要为高 DPR 屏付全价：手机上 DPR 常常是 3，
  // 按 1 渲染等于让浏览器把画面放大三倍，糊的是整个画面而不只是贴图
  let pixelRatio = Math.min(window.devicePixelRatio || 1, low ? 1.5 : 1.75)
  let frameMin = low ? 33 : 0

  // 真实贴图后台下载，到位再淡入替换矢量地球：首屏不等它，它失败了也只是留在矢量版
  const loadedMaps = []
  let disposed = false
  let earthFadeStart = 0
  let moonFadeStart = 0

  const loader = new TextureLoader()
  const loadMap = (url) => new Promise((resolve) => {
    loader.load(url, resolve, undefined, () => resolve(null))
  })
  function prepare(texture) {
    texture.wrapS = RepeatWrapping
    texture.anisotropy = aniso
    loadedMaps.push(texture)
    return texture
  }

  Promise.all([loadMap(low ? EARTH_DAY_1024 : EARTH_DAY_2048), loadMap(EARTH_NIGHT_1024)])
    .then(([day, night]) => {
      // 两张凑齐才淡入，否则会先闪一下没有城市灯火的夜面
      if (disposed || !day || !night) return
      earthUniforms.uMapDay.value = prepare(day)
      earthUniforms.uMapNight.value = prepare(night)
      earthFadeStart = performance.now()
    })
  // 月球潮汐锁定，加上 place() 里那次视差修正，正对我们的永远是同一面：
  // 背面只在最边缘那不到半个像素里露头。所以桌面端只下正面半张 512×512，
  // 字节数跟原来那张 512×256 全景图相当，可见面的纹素密度翻一倍。
  // 小屏月球直径才五十几像素，全景图已经过采样，没必要多下这一张
  loadMap(low ? MOON_512 : MOON_NEAR_512).then((texture) => {
    if (disposed || !texture) return
    // 正面图覆盖 u ∈ [0.25, 0.75]，缩放 2、偏移 0.25 把这一段拉满 [0,1]
    if (!low) moonUniforms.uMapUv.value.set(2, 0.25)
    moonUniforms.uMap.value = prepare(texture)
    // 正面图重映射后，最边缘那半个像素会采到 [0,1] 之外，钳边而不是环绕
    if (!low) texture.wrapS = ClampToEdgeWrapping
    moonFadeStart = performance.now()
  })

  function refreshEphemeris(date) {
    const n = daysSinceJ2000(date)
    for (const key of PLANET_KEYS) {
      const p = planetHeliocentric(key, n)
      const body = bodies.get(key)
      displayPos(p, body.pos)
      body.holder.position.copy(body.pos)
      body.glow.position.copy(body.pos)
      bodyStates[key] = {
        lon: (Math.atan2(p.y, p.x) / DEG + 360) % 360,
        au: Math.hypot(p.x, p.y, p.z),
      }
    }

    const m = moonGeocentric(n)
    const rect = eclipticToRect(m.lambda, m.beta, 1)
    // 只换轴不压缩：这是单位方向，月地距离另外按缩放插值给
    moonDir.set(rect.x, rect.z, -rect.y)
    moonTrueUnits = m.distanceKm / EARTH_RADIUS_KM
    bodyStates.moon = { lambda: m.lambda, beta: m.beta, km: m.distanceKm }

    // 月相的太阳方向取「地球的真实日心方向」，不能拿月球在场景里的位置去算：轨道半径
    // 被压缩过，月地距离相对地日距离被放大了上百倍，直接算今天就会差 12.9°（约一天月龄）
    moonSunTrue.copy(bodies.get('earth').pos).normalize().negate()
    // 潮汐锁定：贴图 u=0.5（0° 经线，正对地球那一面）落在局部 +X，所以让 +X 指向地心。
    // 月球自转轴离黄道北极只差 1.5°，直接拿世界 +Y 当极轴，天平动忽略不计
    moonX.copy(moonDir).negate()
    moonZ.crossVectors(moonX, ECL_NORTH).normalize()
    moonY.crossVectors(moonZ, moonX)
    moonBase.setFromRotationMatrix(moonBasis.makeBasis(moonX, moonY, moonZ))

    const sub = subsolarPoint(date)
    lonLatToVec3(sub.lon, sub.lat, earthUniforms.uSunDir.value)
    bodyStates.sun = { lon: sub.lon, lat: sub.lat }

    earthMesh.quaternion.setFromRotationMatrix(earthMatrix(n, orientation))
  }

  // t=0 地球特写，t=1 太阳系全景。两端的尺寸差着几个数量级，所以行星在
  // 特写状态缩成 0.015 的小球、靠光晕当恒星看，放大时才长回该有的比例
  function place(t, ms, dt) {
    const sunScale = MathUtils.lerp(0.06, 2, t)
    sun.scale.setScalar(sunScale)
    // CORONA_LIMB 是「日面半径 / 精灵半宽」，所以精灵边长 = 半径 / limb × 2
    corona.scale.setScalar((sunScale / CORONA_LIMB) * 2)
    halo.scale.setScalar(sunScale * 16)

    for (const key of PLANET_KEYS) {
      const body = bodies.get(key)
      const isEarth = key === 'earth'
      body.scalable.scale.setScalar(MathUtils.lerp(isEarth ? 1 : 0.015, body.radius, t))
      // 地球在特写状态就是主角本人，再叠一层光晕会在球心糊出个亮点
      body.glow.scale.setScalar(MathUtils.lerp(isEarth ? 0 : 0.09, body.radius * 2.6, t))
      body.glow.material.opacity = MathUtils.lerp(1, 0.55, t)
    }

    moon.scale.setScalar(MathUtils.lerp(0.27, 0.12, t))

    const orbitAlpha = 0.3 * smoothstep(0.18, 0.85, t)
    orbitGroup.visible = orbitAlpha > 0
    for (const material of orbitMaterials) material.opacity = orbitAlpha

    const dNear = fitDistance(1, 1, aspect, EARTH_MARGIN)
    const dFar = fitDistance(SOLAR_RADIUS, SOLAR_HALF_H, aspect, 1.1)
    // 距离走指数插值，感官上的缩放速度才是匀的
    const distance = dNear * Math.pow(dFar / dNear, t)
    const elevation = MathUtils.lerp(baseElevation, SOLAR_ELEVATION, t)
    const ce = Math.cos(elevation)
    camTarget.copy(bodies.get('earth').pos).multiplyScalar(1 - smoothstep(0.35, 1, t))
    camera.position.set(
      camTarget.x + distance * ce * Math.sin(azimuth),
      camTarget.y + distance * Math.sin(elevation),
      camTarget.z + distance * ce * Math.cos(azimuth),
    )
    camera.lookAt(camTarget)
    viewDir.copy(camera.position).sub(earthGroup.position).normalize()

    // 月地距离被压到 2.56 个地球半径，月球又按真实黄经方向摆，于是镜头转到某些方位角时它会
    // 整颗钻到地球背面去——月相白做了。特写状态改成只取黄经方向在屏幕平面内的方位角，
    // 月球始终贴着地球侧面走，画面上的方位角仍然是真的；拉远到太阳系再切回真三维
    camRight.set(Math.cos(azimuth), 0, -Math.sin(azimuth))
    camUp.crossVectors(viewDir, camRight)
    const cx = moonDir.dot(camRight)
    const cy = moonDir.dot(camUp)
    // 视线正好撞上黄经方向时这个方位角没有定义，保持上一帧的即可
    if (cx * cx + cy * cy > 0.0025) {
      const aim = Math.atan2(cy, cx)
      // 换边前后方位角本身转得极快，月球会「啪」地从地球一侧闪到另一侧，所以限一个角速度
      if (moonAngle === null) moonAngle = aim
      else {
        const turn = ((aim - moonAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI
        moonAngle += MathUtils.clamp(turn, -MOON_SLEW * dt, MOON_SLEW * dt)
      }
    }
    // 恒定摆在 MOON_DIST 上。那是短边方向的极限值，长边方向还有余量，所以不必再按
    // 方位角分别量一次可用半径，月球也就不会随着绕地球一圈忽远忽近
    const cos = Math.cos(moonAngle ?? 0)
    const sin = Math.sin(moonAngle ?? 0)
    moonOffset.copy(camRight).multiplyScalar(cos).addScaledVector(camUp, sin)
    moon.position.copy(moonOffset.lerp(moonDir, t)).multiplyScalar(MathUtils.lerp(MOON_DIST, 0.9, t))

    // 场景把月地距离压到 2.56 个地球半径（真实约 60），相机的视差因此被放大二十多倍：
    // 不修正的话镜头自转一圈月相就从 4% 走到 90%，四分钟过完一整个朔望月。
    // 做法是把月球放回真实距离上重算一次视线，求出「真实视线 → 当前视线」的最小旋转，
    // 再把月球朝向和太阳方向一起转过去——相位角、明暗界线倾角、正对我们的那一面
    // 都回到今晚肉眼看到的样子，而月球在画面里的位置一点没动
    moonWorld.copy(earthGroup.position).add(moon.position)
    moonViewCam.subVectors(camera.position, moonWorld).normalize()
    moonWorld.copy(moonDir).multiplyScalar(moonTrueUnits).add(earthGroup.position)
    moonViewTrue.subVectors(camera.position, moonWorld).normalize()
    moonPhase.setFromUnitVectors(moonViewTrue, moonViewCam)
    moon.quaternion.multiplyQuaternions(moonPhase, moonBase)
    moonUniforms.uSunDir.value.copy(moonSunTrue).applyQuaternion(moonPhase)

    if (!markers.length) return
    // earthGroup 不带旋转，所以 earthMesh 的局部四元数就是世界朝向
    const pulse = 1 + 0.35 * Math.sin((ms / 2400) * Math.PI * 2)
    for (const mk of markers) {
      worldNormal.copy(mk.normal).applyQuaternion(earthMesh.quaternion)
      mk.sprite.visible = worldNormal.dot(viewDir) > 0.02
      mk.sprite.scale.setScalar(mk.base * pulse)
    }
  }

  function frame(ms) {
    raf = requestAnimationFrame(frame)
    if (frameMin && ms - lastFrame < frameMin) return
    const dt = lastFrame ? Math.min((ms - lastFrame) / 1000, 0.25) : 0.016
    lastFrame = ms

    if (zoomDur > 0) {
      const p = MathUtils.clamp((ms - zoomStart) / zoomDur, 0, 1)
      zoomT = zoomFrom + (zoomTo - zoomFrom) * ease(p)
      if (p >= 1) zoomDur = 0
    }
    // 转的是相机而不是地球：地球的朝向必须一直是物理真值，晨昏线才站得住
    if (idle) azimuth += IDLE_SPIN * dt

    if (ephemerisDirty || (!epoch && ms - lastEphemeris >= EPHEMERIS_MS)) {
      lastEphemeris = ms
      ephemerisDirty = false
      refreshEphemeris(epoch || new Date())
    }
    if (earthFadeStart) {
      earthUniforms.uReal.value = Math.min((ms - earthFadeStart) / FADE_MS, 1)
    }
    if (moonFadeStart) {
      moonUniforms.uReal.value = Math.min((ms - moonFadeStart) / FADE_MS, 1)
    }
    sunUniforms.uTime.value = ms / 1000
    place(zoomT, ms, dt)
    renderer.render(scene, camera)
  }

  function start() {
    if (!raf) {
      lastFrame = 0
      raf = requestAnimationFrame(frame)
    }
  }

  function stop() {
    if (raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
  }

  function resize() {
    const width = canvas.clientWidth || canvas.width || 1
    const height = canvas.clientHeight || canvas.height || 1
    aspect = width / height
    camera.aspect = aspect
    camera.updateProjectionMatrix()
    renderer.setPixelRatio(pixelRatio)
    renderer.setSize(width, height, false)
  }

  function setMarkers(list = []) {
    for (const mk of markers) {
      markerGroup.remove(mk.sprite)
      mk.sprite.material.dispose()
    }
    markers.length = 0
    for (const item of list) {
      const sprite = new Sprite(new SpriteMaterial({
        map: glowMap,
        color: item.color ?? 0x7ff2d8,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }))
      const normal = lonLatToVec3(item.lon, item.lat)
      // 略微抬离表面，避免和地球球面 z-fighting
      sprite.position.copy(normal).multiplyScalar(1.01)
      const base = item.size ?? 0.08
      sprite.scale.setScalar(base)
      markerGroup.add(sprite)
      markers.push({ sprite, normal, base })
    }
  }

  // 缩放动画由引擎自己补间，调用方只给目标值，过渡曲线就不会被组件写歪
  function setZoom(value, duration = ZOOM_MS) {
    const target = MathUtils.clamp(value, 0, 1)
    if (duration <= 0) {
      zoomT = target
      zoomDur = 0
      return
    }
    zoomFrom = zoomT
    zoomTo = target
    zoomStart = performance.now()
    zoomDur = duration
  }

  function pick(clientX, clientY) {
    const rect = canvas.getBoundingClientRect()
    ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1),
    )
    raycaster.setFromCamera(ndc, camera)
    for (const hit of raycaster.intersectObjects(pickables, false)) {
      const key = pickMap.get(hit.object)
      if (key) return key
    }
    return null
  }

  // 只动 pixelRatio 和帧间隔，不重建任何 GPU 资源，切档位时不会卡一下
  function setQuality(value) {
    const isLow = value === 'low'
    frameMin = isLow ? 33 : 0
    pixelRatio = Math.min(window.devicePixelRatio || 1, isLow ? 1.5 : 1.75)
    resize()
  }

  function setPaused(value) {
    paused = value
    if (value) stop()
    else start()
  }

  // null 表示跟随真实时间；给定时刻就冻在那一刻，留给时间轴
  function setEpoch(date) {
    epoch = date || null
    ephemerisDirty = true
  }

  // 外部一接管视角，自动巡航就让位，留给拖拽旋转
  function setOrientation(next = {}) {
    if (typeof next.azimuth === 'number') azimuth = next.azimuth
    if (typeof next.elevation === 'number') {
      baseElevation = MathUtils.clamp(next.elevation, -1.4, 1.4)
    }
    idle = next.idle ?? false
  }

  const onVisibility = () => {
    if (document.hidden) stop()
    else if (!paused) start()
  }
  document.addEventListener('visibilitychange', onVisibility)

  function dispose() {
    disposed = true
    stop()
    document.removeEventListener('visibilitychange', onVisibility)
    scene.traverse((obj) => {
      obj.geometry?.dispose()
      obj.material?.dispose()
    })
    for (const texture of loadedMaps) texture.dispose()
    earthMap.dispose()
    blankMap.dispose()
    glowMap.dispose()
    coronaMap.dispose()
    renderer.dispose()
  }

  refreshEphemeris(now0)
  if (location) {
    // 开场先把访客所在经纬度转到镜头正前方，第一眼看到的就是自己头顶的昼夜
    lonLatToVec3(location.lon, location.lat, tmp).applyQuaternion(earthMesh.quaternion)
    azimuth = Math.atan2(tmp.x, tmp.z)
    baseElevation = Math.asin(MathUtils.clamp(tmp.y, -1, 1)) * 0.6
    setMarkers([{ lon: location.lon, lat: location.lat }])
  }
  resize()
  place(0, 0, 0)
  renderer.render(scene, camera)
  start()

  return {
    setZoom,
    setOrientation,
    setEpoch,
    setMarkers,
    setQuality,
    setPaused,
    pick,
    resize,
    dispose,
    getZoom: () => zoomT,
    getBodyStates: () => bodyStates,
  }
}

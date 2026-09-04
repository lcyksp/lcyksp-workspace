// 单场景单相机的宇宙引擎：月球特写、地球特写与太阳系全景是同一个 three.js 场景的三个
// 状态，靠 setZoom(-1→1) 连续插值过渡，全程不销毁不重建任何对象。
// t<0 往月球飞，t>0 往太阳系退，t=0 是地球特写。**这个轴只由点击驱动**；
// 滚轮和捏合走另一条互不干涉的 dollyBy 轴，只改「离当前天体多远」，换不了天体。
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
// 一次相机视差，因为月地距离被压到了真实值的十四分之一，详见 place() 里的那段注释。
//
// 已离线校验过的两条不变量：地轴与黄道北极夹角恒等于 obliquity(n)、地轴黄经恒为
// 90°；直下点经 earthMatrix 转到世界后与「地球指向太阳」的夹角在 J2000 处为
// 0.002°，2026 年为 0.37°——差值正好是 J2000 以来的总岁差，因为行星位置用的是
// J2000 黄道而地球朝向用的是当日黄道。这点错配只影响世界坐标里的相对朝向，
// 不进晨昏线，0.37° 肉眼不可见，所以不为它引入岁差矩阵。
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, CanvasTexture, ClampToEdgeWrapping, Group,
  LineBasicMaterial, LineLoop, LinearFilter, MathUtils, Matrix4, Mesh,
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
// 月球特写要看背面，正面半张就不够了。这两张只在真的往月球飞时才下载，
// 首屏一个字节都不多花：import 进来的只是一串带 hash 的 URL
import MOON_1024 from '../assets/cosmos/moon-1024.webp'
import MOON_2048 from '../assets/cosmos/moon-2048.webp'

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
// 特写状态地球占画面短边的 1/3.2。这个余量本来是给月球留的取景空间，现在月球按真实
// 方向摆、允许走出画外，留着只是因为地球贴满画框反而看不出它在自转
const EARTH_MARGIN = 3.2
// 月球特写让月面占画面短边的 1/1.5，桌面上直径约 563 px。不贴满是因为要留出边上那圈
// 星空，否则整个画面只剩一片灰，看不出是站在月球旁边
const MOON_MARGIN = 1.5
// 滚轮和捏合只改「站在当前天体旁边多远」，不换天体：拉到最近就是天体正好占满画面短边
// （余量收到 1，所以倍率下限就是 1/margin），往外的上限地球给 1.8（地月系统整个进画面）、
// 月球给 3。缩放到不了太阳系，换天体一律靠点击
const DOLLY_OUT_EARTH = 1.8
const DOLLY_OUT_MOON = 3
// 距离向目标逼近的衰减，按 dt 取幂：时间常数约 0.16 s，低帧率档手感一致
const DOLLY_DAMP = 0.002
const IDLE_SPIN = 1.5 * DEG
// 甩动后的惯性：残余速度每秒衰减到 8%，普通一甩滑一秒半左右收敛。注意横向收敛到的是
// IDLE_SPIN 而不是 0——松手后画面一刻都不停，甩动的尾巴直接接进自动巡航
const DRAG_DAMP = 0.08
const DRAG_MAX_VEL = 6
const DRAG_STOP_VEL = 0.03
// 俯角上下各差 2° 到极点就停住：视线正对极点时 lookAt 拿默认的 +Y 当上方向会退化，
// 画面会绕视轴突然翻一下。留这 2° 已经能看到极点几乎正上方的样子
const ELEV_LIMIT = 88 * DEG
const ZOOM_MS = 1700
const EPHEMERIS_MS = 200
// 日冕贴图里日面边缘所在的半径比例，精灵缩放按它反推
const CORONA_LIMB = 0.25

// 天体真实半径，km。场景里所有大小关系都从这里派生，不再手工调数字
const BODY_KM = {
  sun: 696000, mercury: 2439.7, venus: 6051.8, earth: 6371, mars: 3389.5,
  jupiter: 69911, saturn: 58232, uranus: 25362, neptune: 24622, moon: 1737.4,
}
// 全景那端日面固定 2 个单位，其余天体就是 km/696000×2 —— 大小关系全按真值。木星于是
// 只有 7 px、地球 0.6 px，这个悬殊本身就是要看的东西。轨道半径没法一起照实（被
// ORBIT_POW 压过），能做到的是天体互相之间的比例是真的
const SUN_PANO_R = 2
const PLANET_RADIUS = Object.fromEntries(
  PLANET_KEYS.map((key) => [key, (SUN_PANO_R * BODY_KM[key]) / BODY_KM.sun]),
)
// 真按比例的话四颗岩石行星在全景里都不到一个像素，会彻底消失。所以本体一律真值、
// 不设下限，只给外面那圈染色光晕兜一个像素宽度：认出「那是哪颗行星」靠的是颜色和
// 它停在哪条轨道上，不靠体积
const GLOW_MIN_PX = 5
// 点击的屏幕容差（CSS 像素）：全景里的行星只有几个像素宽，光靠射线几乎点不中
const PICK_SLOP = 24
const PLANET_COLOR = {
  mercury: 0x9a9188, venus: 0xd8c39a, earth: 0x3f7fbf, mars: 0xc4694a,
  jupiter: 0xd2a679, saturn: 0xe0cd9a, uranus: 0x9fd6e0, neptune: 0x6f8fd6,
}
// 特写状态下行星只能是星点：从地球看过去它们的角直径是 10~60 角秒，而这个画框
// 一个像素就有 3 角分左右，连金星都占不到半个像素。所以不给世界尺寸，改成按视星等
// 定一个固定的屏幕直径与亮度。px 只管这个点摊多大，峰值亮度由 alpha 乘颜色本身的
// 亮度决定——背景恒星实测峰值 53~62，金星（−4 等）给到接近 200，海王星（+8 等）
// 压到 30 上下，肉眼在天上看到的次序就复现了
const PLANET_STAR = {
  mercury: { px: 3.4, alpha: 0.68 },
  venus: { px: 4.6, alpha: 1 },
  earth: { px: 0, alpha: 0 },
  mars: { px: 3.4, alpha: 0.54 },
  jupiter: { px: 4, alpha: 0.86 },
  saturn: { px: 3.4, alpha: 0.41 },
  uranus: { px: 2.8, alpha: 0.23 },
  neptune: { px: 2.6, alpha: 0.15 },
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
const Q_IDENTITY = new Quaternion()
const FADE_MS = 700
// 场景里地球半径就是 1，所以月地真实距离换算成场景单位只需除以地球半径
const EARTH_RADIUS_KM = BODY_KM.earth
// 月球半径和月地距离都比照真值。地球特写这端月球就摆在真实的 60.3 个地球半径上：角直径
// 0.52°，桌面画框里不到 10 px，多数方位角下干脆在画面外——真实的天空本来就是这样，抬头
// 也不是随时看得见月亮。近远地点的大小起伏、被地球挡住、从地球前面过、偶尔和太阳凑成一次
// 日食，全是透视和深度缓冲自己给的。只有全景那端才压回行星那条 ORBIT_POW 律（60.3^0.35
// ≈ 4.2）：那边地球半径本身被抬了近百倍，照真值摆会甩到二十几个像素外，像另一颗行星
const MOON_RADIUS = BODY_KM.moon / BODY_KM.earth
// 特写状态里行星摆在这个半径的天球上，方向取真实地心方向。压缩过的日心位置之差
// 不是真方向（金星的轨道半径被 ORBIT_POW 从 0.723 抬到 0.893 AU 当量，方位角能差出
// 几十度），而这个半径远到视差可以忽略：相机离地球 7.7，摊到 320 上只有 2.4%
const PLANET_SKY_R = 320
// 太阳在特写这端也摆到这个天球上，半径按真实角半径 0.266° 反算：320×tan(0.266°)。
// 不这么做的话，压缩后的地日距离只有 7.62 个地球半径，而相机绕地球的半径是 7.725
// —— 相机每转一圈都会从太阳旁边 0.1 处擦过去，日面那一瞬能涨到 601 px 半径，
// 而它本该只有 4.7 px。赤道附近的访客默认俯角正好是 0°，最容易撞上
const SUN_DISC_R = PLANET_SKY_R * Math.tan(0.266 * DEG)

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
  // 行星星点只有 3~5 px，用 glowMap 会采到很高的 mip 级，而那一级已经把中心的亮核
  // 平均掉了：实测金星峰值只剩 46/255，比背景恒星（53~62）还暗。星点单独给一张不生
  // mipmap 的小图，采样永远落在 0 级，峰值就是渐变本身的亮核。多出来的显存 4 KB，
  // 也不多一次 draw call —— 精灵本来就有
  const starMap = new CanvasTexture(drawGlowTexture(32))
  starMap.generateMipmaps = false
  starMap.minFilter = LinearFilter
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
  // 月球不能跟行星共用那颗 20×14 的球：特写时它有 563 px 直径，20 段的边缘会塌出
  // 三四个像素的多边形棱角。多出来的顶点是两千个，一次 draw call 的事
  const moon = new Mesh(new SphereGeometry(1, low ? 40 : 64, low ? 28 : 44), new ShaderMaterial({
    uniforms: moonUniforms, vertexShader: MOON_VERTEX, fragmentShader: MOON_FRAGMENT,
  }))
  earthGroup.add(moon)

  const bodies = new Map()
  // 日冕精灵不进 pickables：全景里它有 16 个单位宽，而地球轨道半径只有 7.6，射线会在
  // 地球之前先打中这层看不见的光，把「点地球回地月系」整条路吃掉。日面本体照旧点得到
  const pickables = [earthMesh, moon, sun]
  const pickMap = new Map([[earthMesh, 'earth'], [moon, 'moon'], [sun, 'sun']])

  for (const key of PLANET_KEYS) {
    const color = PLANET_COLOR[key]
    const glow = new Sprite(new SpriteMaterial({
      map: starMap, color, transparent: true, depthWrite: false, blending: AdditiveBlending,
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
    bodies.set(key, {
      holder,
      scalable,
      glow,
      radius: PLANET_RADIUS[key],
      star: PLANET_STAR[key],
      pos: new Vector3(),
      // 地球是相机的落脚点，没有「从地球看地球」的方向
      geoDir: key === 'earth' ? null : new Vector3(),
    })
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
  const camDir = new Vector3()
  const camOut = new Vector3()
  const camEnd = new Vector3()
  const camTurn = new Quaternion()
  const camSwing = new Quaternion()
  const skyPos = new Vector3()
  // 天球（太阳和行星星点）的球心。地球特写时是地心，飞到月球时跟着挪到月心
  const skyCenter = new Vector3()
  // 太阳的地心方向。轨道半径压缩只动半径不动方向，所以「地球指向原点」就是真方向
  const sunGeoDir = new Vector3(0, 0, -1)
  const moonDir = new Vector3()
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
  const moonFace = new Quaternion()
  const orientation = new Matrix4()

  // 绕地球的镜位：方位角 + 俯角。太阳系全景也用它
  const earthCam = { az: 0, el: 18 * DEG }
  // 绕月球的镜位，跟上面那对完全独立。曾经的写法是把绕地球那对角度经一个固定四元数映射到
  // 月球周围，但共轭会把转轴一起带走：绕世界 +Y 的拖拽变成绕「那个四元数转过的轴」，而落地
  // 时这一转接近 161°，转过的轴几乎正对 −Y —— 于是左右上下全反、还多一份斜的。分开存两档
  // 才是同一套参数化，手感因此一致，俯角上下限也终于是绕月球那个极点的上下限
  const moonCam = { az: 0, el: 0 }

  let epoch = null
  let zoomT = 0
  let zoomFrom = 0
  let zoomTo = 0
  let zoomStart = 0
  let zoomDur = 0
  // 正在飞向月球：这段时间里绕月镜位每帧重瞄落点，落地那一帧交还给拖拽
  let moonAim = false
  // 已经落在月球上。为真时拖拽/巡航/惯性作用在 moonCam，为假时作用在 earthCam
  let moonFree = false
  // 特写这端的相机距离倍率，1 是各档的默认取景。它和 zoomT 是两个互不干涉的轴：
  // zoomT 换天体（只由点击驱动），dolly 只改远近
  let dolly = 1
  let dollyTo = 1
  let idle = true
  let dragging = false
  let dragVel = 0
  let elevVel = 0
  let paused = false
  let raf = 0
  let lastFrame = 0
  let lastEphemeris = 0
  let ephemerisDirty = true
  // 人有没有动过镜头（拖、缩放、点天体）。动过之后就不再自动重新取景：镜头正停在他
  // 拖到的地方，这时候把视角拽回开场取景，比月球飘出画面难受得多
  let touched = false
  let aspect = 1
  // CSS 像素高度，星点尺寸要按它反推恒定视角
  let viewHeight = 1
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
  let moonHiStarted = false
  let moonHiOn = false

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
    if (disposed || !texture || moonHiOn) return
    // 正面图覆盖 u ∈ [0.25, 0.75]，缩放 2、偏移 0.25 把这一段拉满 [0,1]
    if (!low) moonUniforms.uMapUv.value.set(2, 0.25)
    moonUniforms.uMap.value = prepare(texture)
    // 正面图重映射后，最边缘那半个像素会采到 [0,1] 之外，钳边而不是环绕
    if (!low) texture.wrapS = ClampToEdgeWrapping
    moonFadeStart = performance.now()
  })

  // 要飞到月球旁边了才换整张等距圆柱投影：这时背面会转到镜头里，而 563 px 的月面
  // 也吃得下 2048 的纹素。飞行 1700 ms，一般在落地前就下完了；万一没下完，
  // 桌面端会先在背面看到一圈拉长的钳边像素，等它到位自己就好
  function loadMoonHi() {
    if (moonHiStarted || disposed) return
    moonHiStarted = true
    loadMap(low ? MOON_1024 : MOON_2048).then((texture) => {
      if (disposed || !texture) return
      moonHiOn = true
      moonUniforms.uMapUv.value.set(1, 0)
      moonUniforms.uMap.value = prepare(texture)
      if (!moonFadeStart) moonFadeStart = performance.now()
    })
  }

  // 以 dir 为局部 +X、极轴尽量指黄道北的正交基。月球贴图 u=0.5（0° 经线，正对地球那
  // 一面）落在局部 +X，所以这个基既用来摆潮汐锁定的朝向，也用来求 place() 里那次视差修正
  function faceBasis(dir) {
    moonZ.crossVectors(dir, ECL_NORTH).normalize()
    moonY.crossVectors(moonZ, dir)
    return moonBasis.makeBasis(dir, moonY, moonZ)
  }

  function refreshEphemeris(date) {
    const n = daysSinceJ2000(date)
    const pEarth = planetHeliocentric('earth', n)
    for (const key of PLANET_KEYS) {
      const p = planetHeliocentric(key, n)
      const body = bodies.get(key)
      displayPos(p, body.pos)
      // 地球的 holder 就是 earthGroup，位置只在这里定；其余行星每帧在 place() 里
      // 于「天球上的真实地心方向」和这个压缩日心位置之间插值，所以不在这里落位
      if (body.geoDir) body.geoDir.set(p.x - pEarth.x, p.z - pEarth.z, -(p.y - pEarth.y)).normalize()
      else {
        body.holder.position.copy(body.pos)
        body.glow.position.copy(body.pos)
      }
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
    sunGeoDir.copy(moonSunTrue)
    // 潮汐锁定：让局部 +X 指向地心。月球自转轴离黄道北极只差 1.5°，直接拿世界 +Y
    // 当极轴，天平动忽略不计
    moonBase.setFromRotationMatrix(faceBasis(moonX.copy(moonDir).negate()))

    const sub = subsolarPoint(date)
    lonLatToVec3(sub.lon, sub.lat, earthUniforms.uSunDir.value)
    bodyStates.sun = { lon: sub.lon, lat: sub.lat }

    earthMesh.quaternion.setFromRotationMatrix(earthMatrix(n, orientation))
  }

  // 落地月球时相机该停在月心的哪个方向上。地球正好在月心的反方向，所以「相机偏离月球
  // 方向」的角同时就是地球在画面里的偏心角：取月面边缘和画框上下边的中点，地球既不会被
  // 月面挡住也不会掉出画外。竖边而不是窄边——偏心量落在过月心与黄道北极的那个平面内，
  // 而相机的上方向就是世界 +Y，于是这段偏心在画面里必然是竖直的，横向多宽都不相干。
  // 这个角刻意不带 dolly：否则在月球旁边滚滚轮会连着把相机绕到别的方位角去
  function landingDir(out) {
    const tanEdge = TAN_HALF_FOV * Math.min(aspect, 1)
    const off = (Math.asin(tanEdge / MOON_MARGIN) + Math.atan(TAN_HALF_FOV)) / 2
    out.copy(ECL_NORTH).addScaledVector(moonDir, -ECL_NORTH.dot(moonDir)).normalize()
    return out.multiplyScalar(Math.sin(off)).addScaledVector(moonDir, Math.cos(off))
  }

  // t=-1 月球特写，t=0 地球特写，t=1 太阳系全景。三端的尺寸差着几个数量级，行星在特写
  // 这端退成一个星点、连位置都换成天球上的真实方向，到全景才长回该有的比例
  function place(t, ms) {
    // 两个方向互斥：往外退时 tMoon 恒为 0，往月球飞时 tOut 恒为 0
    const tOut = Math.max(t, 0)
    const tMoon = Math.max(-t, 0)
    // 位置权重比缩放起步稍晚，于是「飞近」和「变大」是同一个动作
    const wPos = smoothstep(0.12, 0.62, tOut)

    // 月球本来就摆在真实距离上，飞过去只剩一件事：绕着地球把相机荡到月球旁边
    const approach = smoothstep(0, 1, tMoon)

    // 地球从特写的 1 倍半径缩到全景的真实比例。月球的半径和轨道都乘同一个系数，于是
    // 「月球是地球的 0.273 倍」在两端和过渡途中都成立
    const earthShrink = MathUtils.lerp(1, PLANET_RADIUS.earth, tOut)
    moon.scale.setScalar(MOON_RADIUS * earthShrink)
    // 特写和飞行途中是真实距离，只有往全景退时才切到压缩律，理由见 MOON_RADIUS 处
    const moonUnits = MathUtils.lerp(moonTrueUnits, Math.pow(moonTrueUnits, ORBIT_POW), wPos)
    moon.position.copy(moonDir).multiplyScalar(moonUnits * earthShrink)
    // 天球球心：飞到月球就得跟着挪过去，否则从月球看太阳会偏出十度，晨昏线对不上。
    // 早早就交给月球，免得镜头已经贴到月面、瞄的点还落在半路上
    skyCenter.copy(earthGroup.position).addScaledVector(moon.position, smoothstep(0, 0.3, tMoon))

    const sunScale = MathUtils.lerp(SUN_DISC_R, SUN_PANO_R, tOut)
    sun.scale.setScalar(sunScale)
    // CORONA_LIMB 是「日面半径 / 精灵半宽」，所以精灵边长 = 半径 / limb × 2
    corona.scale.setScalar((sunScale / CORONA_LIMB) * 2)
    halo.scale.setScalar(sunScale * 16)
    // 特写这端太阳摆在天球上真实的地心方向，全景那端回到原点。天球那边视差可以忽略，
    // 角直径于是固定在真实的 0.53°：地球 264 px 时它 9 px，还会被地球挡成一次日食
    skyPos.copy(skyCenter).addScaledVector(sunGeoDir, PLANET_SKY_R)
    sun.position.copy(skyPos).multiplyScalar(1 - wPos)
    corona.position.copy(sun.position)
    halo.position.copy(sun.position)

    const orbitAlpha = 0.3 * smoothstep(0.18, 0.85, tOut)
    orbitGroup.visible = orbitAlpha > 0
    for (const material of orbitMaterials) material.opacity = orbitAlpha

    const dNear = fitDistance(1, 1, aspect, EARTH_MARGIN)
    const dFar = fitDistance(SOLAR_RADIUS, SOLAR_HALF_H, aspect, 1.1)
    // 滚轮/捏合只作用在特写这端，全景那端的距离写死：所以怎么缩放都到不了太阳系
    const dEarth = dNear * MathUtils.lerp(dolly, 1, tOut)
    // 距离走指数插值，感官上的缩放速度才是匀的
    const distance = dEarth * Math.pow(dFar / dNear, tOut)
    const elevation = MathUtils.lerp(earthCam.el, SOLAR_ELEVATION, tOut)
    const ce = Math.cos(elevation)
    camDir.set(ce * Math.sin(earthCam.az), Math.sin(elevation), ce * Math.cos(earthCam.az))
    camTarget.copy(skyCenter).multiplyScalar(1 - smoothstep(0.35, 1, tOut))
    camera.position.copy(camTarget).addScaledVector(camDir, distance)
    if (tMoon > 0) {
      const dMoon = fitDistance(MOON_RADIUS, MOON_RADIUS, aspect, MOON_MARGIN) * dolly
      // 飞行途中每帧把绕月镜位重瞄到落点上：落地方位于是死死钉在 landingDir，地球必然隔着
      // 月球在画框里，中途拖两下也只是改飞行路径（拖的是 earthCam，只影响这段路怎么绕）。
      // 落地那一帧把镜位交给 moonCam，此后拖拽直接改绕月的方位角和俯角
      if (moonAim) {
        landingDir(camEnd)
        moonCam.az = Math.atan2(camEnd.x, camEnd.z)
        moonCam.el = Math.asin(MathUtils.clamp(camEnd.y, -1, 1))
        if (tMoon >= 1) {
          moonAim = false
          moonFree = true
        }
      }
      const cm = Math.cos(moonCam.el)
      camOut.set(cm * Math.sin(moonCam.az), Math.sin(moonCam.el), cm * Math.cos(moonCam.az))
      camEnd.copy(moonDir).multiplyScalar(moonUnits).addScaledVector(camOut, dMoon)
      const rEnd = camEnd.length()
      // 全程绕着地心走：方向从 camDir 转到落地方向、离地心的距离在 dEarth 和 rEnd 之间
      // 几何插值。两者都单调，所以相机到地心的距离恒在 [dEarth, rEnd] = [2.4, 61.2] 之内，
      // 绝不可能穿进地球里；落点离月心 0.99 个地球半径，也在月面（0.27）之外
      camTurn.setFromUnitVectors(camDir, camEnd.divideScalar(rEnd))
      camSwing.slerpQuaternions(Q_IDENTITY, camTurn, approach)
      camOut.copy(camDir).applyQuaternion(camSwing)
      camera.position.copy(earthGroup.position)
        .addScaledVector(camOut, Math.pow(dEarth, 1 - approach) * Math.pow(rEnd, approach))
    }
    camera.lookAt(camTarget)
    viewDir.copy(camera.position).sub(earthGroup.position).normalize()

    // 行星：特写这端摆在天球上的真实地心方向、缩成一个按视星等定大小的星点；拉远时
    // 才移到压缩后的日心位置并长成实体球。被地球挡住时自然消失——地球写深度，
    // 光晕只测深度不写
    // 一个屏幕像素在单位距离处对应多少世界尺寸，乘上天体到相机的距离就得到恒定视角
    const pxWorld = (2 * TAN_HALF_FOV) / Math.max(viewHeight, 1)
    for (const key of PLANET_KEYS) {
      const body = bodies.get(key)
      if (body.geoDir) {
        skyPos.copy(body.geoDir).multiplyScalar(PLANET_SKY_R).add(skyCenter)
        body.holder.position.lerpVectors(skyPos, body.pos, wPos)
        body.glow.position.copy(body.holder.position)
      }
      const camDist = body.glow.position.distanceTo(camera.position)
      // 地球在特写这端是主角本人（1 倍半径），且 star.px 为 0 —— 给它叠光晕
      // 只会在球心糊出一个亮点
      body.scalable.scale.setScalar(MathUtils.lerp(body.geoDir ? 0 : 1, body.radius, tOut))
      // 全景那端光晕取「真实体积的 1.3 倍」和「GLOW_MIN_PX 像素」里大的那个：木星土星
      // 用得上自己的体积，剩下六颗全靠这个下限才不至于消失
      const panoGlow = Math.max(body.radius * 2.6, GLOW_MIN_PX * pxWorld * camDist)
      body.glow.scale.setScalar(MathUtils.lerp(body.star.px * pxWorld * camDist, panoGlow, tOut))
      body.glow.material.opacity = MathUtils.lerp(body.star.alpha, 0.55, tOut)
    }

    // 全景那端月球的轨道被 ORBIT_POW 压到 4.2 个地球半径（真实约 60），相机却还在 7.7 个
    // 半径处，视差于是被放大十几倍：不修正的话镜头转一圈月相就走完一个朔望月，正对我们的
    // 那半张贴图也会转到背面去。做法是把月球放回真实距离上重算一次视线，求出「真实视线 →
    // 当前视线」的旋转，再把月球朝向和太阳方向一起转过去——相位、明暗界线倾角、正对我们的
    // 那一面都回到今晚肉眼看到的样子，位置一点没动。这个旋转取两个「极轴朝黄道北」正交基
    // 之差而不是最小旋转：月球到了地球正前方时两条视线正好反向，最小旋转的转轴那一帧没定义。
    // 地球特写和整段飞行途中 moonUnits 本身就是真值，两条视线重合，这里自然退成单位四元数
    moonWorld.copy(earthGroup.position).add(moon.position)
    moonViewCam.subVectors(camera.position, moonWorld).normalize()
    moonWorld.copy(moonDir).multiplyScalar(moonTrueUnits).add(earthGroup.position)
    moonViewTrue.subVectors(camera.position, moonWorld).normalize()
    moonPhase.setFromRotationMatrix(faceBasis(moonViewTrue)).invert()
    moonFace.setFromRotationMatrix(faceBasis(moonViewCam))
    moonPhase.premultiply(moonFace)
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
    if (dolly !== dollyTo) {
      dolly += (dollyTo - dolly) * (1 - Math.pow(DOLLY_DAMP, dt))
      if (Math.abs(dollyTo - dolly) < 1e-4) dolly = dollyTo
    }
    // 转的是相机而不是地球：地球的朝向必须一直是物理真值，晨昏线才站得住
    if (idle) {
      steer().az += IDLE_SPIN * dt
    } else if (!dragging) {
      // 横向残余速度收敛到巡航速度、纵向收敛到 0。中间没有「停住再等一会」那段死时间：
      // 松手那一帧画面还在动，只是从甩动的速度平滑过渡到 1.5°/s。衰减按 dt 取幂而不是
      // 每帧乘固定系数，低画质档掉到 30fps 时手感才和满帧一致
      const decay = Math.pow(DRAG_DAMP, dt)
      const cam = steer()
      dragVel = IDLE_SPIN + (dragVel - IDLE_SPIN) * decay
      cam.az += dragVel * dt
      if (elevVel) {
        elevVel *= decay
        if (Math.abs(elevVel) < DRAG_STOP_VEL) elevVel = 0
        // 顶到上下限就把纵向余速吃掉，不然会一直贴着极点顶好几秒
        const next = MathUtils.clamp(cam.el + elevVel * dt, -ELEV_LIMIT, ELEV_LIMIT)
        if (next === cam.el) elevVel = 0
        cam.el = next
      }
      // 俯角不回弹：视角留在人拖到的高度，只有横向交还给巡航。两边速度都到位了就
      // 切回 idle——切换点的速度正好相等，看不出接缝
      if (!elevVel && Math.abs(dragVel - IDLE_SPIN) < DRAG_STOP_VEL) idle = true
    }

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
    place(zoomT, ms)
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
    const prev = aspect
    aspect = width / height
    viewHeight = height
    camera.aspect = aspect
    camera.updateProjectionMatrix()
    renderer.setPixelRatio(pixelRatio)
    renderer.setSize(width, height, false)
    // 开场取景角是按 aspect 算出来的，横竖屏一转它就得跟着重算，否则月球会歪到画框外
    if (!touched && zoomT === 0 && zoomDur === 0 && Math.abs(aspect - prev) > 0.01) frameOpening()
  }

  // 开场取景：相机架在「月球反方向」外扩一圈的锥面上。相机看的是地心，所以画框里的远景
  // 正是月球那一侧——锥面半角取画框窄边的 62%（地球圆盘占窄边 31%），月球于是既落在框内，
  // 又离地球边缘远得挡不住。锥面上再取离访客天顶最近的那点：月球在访客地平线以下时（约
  // 一半的时候）访客那一面照旧正对镜头，在头顶时就只能先看到地球另一面，巡航一分钟内会
  // 转回来。这个取舍是有意的——真实距离下的月球只有 9 px，开场不指给人看就没人知道能点
  function frameOpening() {
    const openTan = TAN_HALF_FOV * Math.min(aspect, 1)
    const openOff = Math.atan(openTan) * 0.62
    // 相机蹲在地心外 EARTH_MARGIN/openTan 处，这段偏心又把 60 倍远的月球往外推一两度
    const openPsi = openOff
      + Math.asin(((EARTH_MARGIN / openTan) / moonTrueUnits) * Math.sin(openOff))
    camDir.copy(moonDir).negate()
    if (location) lonLatToVec3(location.lon, location.lat, tmp).applyQuaternion(earthMesh.quaternion)
    else tmp.copy(ECL_NORTH)
    tmp.addScaledVector(camDir, -tmp.dot(camDir))
    if (tmp.lengthSq() < 1e-6) tmp.copy(ECL_NORTH).addScaledVector(camDir, -ECL_NORTH.dot(camDir))
    camDir.multiplyScalar(Math.cos(openPsi)).addScaledVector(tmp.normalize(), Math.sin(openPsi))
    earthCam.az = Math.atan2(camDir.x, camDir.z)
    earthCam.el = MathUtils.clamp(Math.asin(MathUtils.clamp(camDir.y, -1, 1)), -ELEV_LIMIT, ELEV_LIMIT)
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
  // 换天体只由点击驱动：-1 月球、0 地球、+1 太阳系全景。滚轮碰不到这个轴
  function setZoom(value, duration = ZOOM_MS) {
    const target = MathUtils.clamp(value, -1, 1)
    touched = true
    // 只要开始往月球那边走就去下高清月面图，飞行时间刚好拿来当下载窗口
    if (target < 0) loadMoonHi()
    // 只有从别处往月球飞才重新瞄落点：已经站在月球旁边时再点它，不该把人拖到的那一面拽回去
    moonAim = target < 0 && !moonFree
    // 一旦开始离开月球，镜位就交还给绕地球那一对；moonCam 停在人拖到的地方，
    // 退出去这一路的起点因此还是他刚才看的那一面
    if (target >= 0) moonFree = false
    // 换了天体就把远近恢复成这一档的默认取景；点的还是当前这个天体就保留人调好的远近
    if (target !== (zoomDur > 0 ? zoomTo : zoomT)) dollyTo = 1
    // 拖拽只在地球特写和月球特写里开放，切去全景时把手上的惯性收掉并接回自动巡航
    dragging = false
    dragVel = 0
    elevVel = 0
    idle = true
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

  // 滚轮和双指捏合走这里：factor 是「相机距离乘多少」，小于 1 是拉近。倍率叠在目标值上，
  // 连着拨几下不会互相打断。全景档直接忽略——那一档不做缩放，也不许缩放换天体
  function dollyBy(factor) {
    const scene = zoomDur > 0 ? zoomTo : zoomT
    if (scene > 0.02 || !(factor > 0)) return
    touched = true
    const moonSide = scene < -0.5
    dollyTo = MathUtils.clamp(
      dollyTo * factor,
      1 / (moonSide ? MOON_MARGIN : EARTH_MARGIN),
      moonSide ? DOLLY_OUT_MOON : DOLLY_OUT_EARTH,
    )
  }

  function pick(clientX, clientY) {
    const rect = canvas.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    ndc.set((x / rect.width) * 2 - 1, -((y / rect.height) * 2 - 1))
    raycaster.setFromCamera(ndc, camera)
    for (const hit of raycaster.intersectObjects(pickables, false)) {
      const key = pickMap.get(hit.object)
      if (key) return key
    }
    // 全景里地球本体只有一两个像素、光晕也才 5 像素，射线基本打不中，于是射线落空时
    // 改在屏幕上找最近的天体：眼睛看见的那个光点就是点得到的那个。月球在地球特写里也得
    // 进这个兜底——真实距离下它只有 10 px，比 PICK_SLOP 还小，射线打中纯靠运气；
    // 但全景里它和地球重在一起，那时必须排除，否则「点地球回特写」这条路会被抢掉
    let best = null
    let bestPx = PICK_SLOP
    const pano = (zoomDur > 0 ? zoomTo : zoomT) > 0.5
    for (const object of pickables) {
      const key = pickMap.get(object)
      if (!key || (key === 'moon' && pano)) continue
      object.getWorldPosition(tmp).project(camera)
      if (tmp.z > 1) continue
      const px = Math.hypot(
        ((tmp.x + 1) / 2) * rect.width - x,
        ((1 - tmp.y) / 2) * rect.height - y,
      )
      if (px < bestPx) {
        bestPx = px
        best = key
      }
    }
    return best
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

  // 手动拖拽：按下先夺走控制权（顺手把上一次甩动的余速掐掉），移动累加方位角和俯角，
  // 松手把两个方向的角速度交给帧循环去衰减
  function beginDrag() {
    dragging = true
    dragVel = 0
    elevVel = 0
    idle = false
    touched = true
  }

  // 拖拽、巡航、惯性到底作用在哪一对角度上。落在月球上之后是绕月球那一对；飞行途中算绕地球，
  // 那会儿落点每帧重瞄，拖拽只是改这段路怎么绕过去
  function steer() {
    return moonFree ? moonCam : earthCam
  }

  function dragBy(radAzimuth, radElevation = 0) {
    if (!dragging) return
    const cam = steer()
    cam.az += radAzimuth
    cam.el = MathUtils.clamp(cam.el + radElevation, -ELEV_LIMIT, ELEV_LIMIT)
  }

  function endDrag(velAzimuth = 0, velElevation = 0) {
    if (!dragging) return
    dragging = false
    dragVel = MathUtils.clamp(velAzimuth, -DRAG_MAX_VEL, DRAG_MAX_VEL)
    elevVel = MathUtils.clamp(velElevation, -DRAG_MAX_VEL, DRAG_MAX_VEL)
    if (Math.abs(elevVel) < DRAG_STOP_VEL) elevVel = 0
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
    starMap.dispose()
    coronaMap.dispose()
    renderer.dispose()
  }

  refreshEphemeris(now0)
  resize()
  frameOpening()
  if (location) setMarkers([{ lon: location.lon, lat: location.lat }])
  place(0, 0)
  renderer.render(scene, camera)
  start()

  return {
    setZoom,
    dollyBy,
    beginDrag,
    dragBy,
    endDrag,
    setEpoch,
    setMarkers,
    setQuality,
    setPaused,
    pick,
    resize,
    dispose,
    // 报的是补间终点而不是当前插值：点击路由和拖拽开关问的都是「镜头要去哪」。
    // 过渡途中再点一下才能干净地反向，而不是从半路又叠一次同向补间
    getZoom: () => (zoomDur > 0 ? zoomTo : zoomT),
    getBodyStates: () => bodyStates,
  }
}

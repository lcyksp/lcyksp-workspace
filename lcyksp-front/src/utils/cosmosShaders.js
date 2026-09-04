// 地球、月球、太阳的自定义着色器。全场景只有这三个 ShaderMaterial，其余天体走 three
// 内置材质，低端 GPU 上的片元开销尽量压到最低。
//
// 颜色管线：三张贴图都不声明 colorSpace，采样拿到的就是原始 sRGB 字节，片元里手动
// pow(2.2) 解码 → 线性空间做光照 → 末尾 pow(1/2.2) 编回 sRGB。Color 类型的 uniform
// 在 ColorManagement 开启时本身就是线性值，可以直接参与累加。
//
// 地球：uSunDir 传「地固系」太阳方向（即直下点方向），片元用局部法线做点积，于是晨昏线
// 钉在正确的经纬度上，与地球在世界里怎么摆、相机怎么转都无关。
// 月球：uSunDir 传「世界系」太阳方向，取的是地球的真实日心方向，而不是月球在场景里的
// 位置——轨道半径被压缩过，直接拿月球算会让月相差出十几度。
import { Color, Vector2, Vector3 } from 'three'

export const EARTH_VERTEX = /* glsl */ `
varying vec2 vUv;
varying vec3 vLocalNormal;
varying vec3 vViewNormal;
varying vec3 vViewPos;

void main() {
  vUv = uv;
  vLocalNormal = normal;
  vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
  vViewPos = viewPos.xyz;
  vViewNormal = normalMatrix * normal;
  gl_Position = projectionMatrix * viewPos;
}
`

export const EARTH_FRAGMENT = /* glsl */ `
uniform sampler2D uMapVector;
uniform sampler2D uMapDay;
uniform sampler2D uMapNight;
uniform vec3 uSunDir;
uniform vec3 uNightTint;
uniform vec3 uWarmTint;
uniform vec3 uDawnColor;
uniform vec3 uAtmoColor;
uniform vec3 uGridColor;
uniform vec2 uGridDiv;
uniform float uReal;
uniform float uNightLevel;
uniform float uCityGain;
uniform float uSoft;
uniform float uSkyLevel;
uniform float uDawnWidth;
uniform float uDawnRim;
uniform float uGridWidth;
uniform float uGridAlpha;

varying vec2 vUv;
varying vec3 vLocalNormal;
varying vec3 vViewNormal;
varying vec3 vViewPos;

const float PI = 3.141592653589793;
const float SRGB = 2.2;
// 昼夜之间那条「软」边不是几何造成的：太阳视半径只有 0.27°，几何本影几乎是刀切。
// 真正让它变宽的是大气散射——阳光能照到地平线下 18° 处（天文晨昏蒙影），
// sin(18°) = 0.309，所以过渡带宽度就该按这个值取
const float TWILIGHT = 0.309;

void main() {
  vec3 vecAlbedo = pow(texture2D(uMapVector, vUv).rgb, vec3(SRGB));
  vec3 dayAlbedo = pow(texture2D(uMapDay, vUv).rgb, vec3(SRGB));
  vec3 albedo = mix(vecAlbedo, dayAlbedo, uReal);
  vec3 city = pow(texture2D(uMapNight, vUv).rgb, vec3(SRGB)) * uReal;

  float sun = dot(normalize(vLocalNormal), uSunDir);

  // 直射日光走 wrap 过的朗伯项。pow(max(sun, 0.0), p) 这种写法在 sun = 0 处导数是
  // 无穷大，晨昏线会硬生生断一下；把零点挪到 -uSoft 之后整条过渡都是线性的
  float direct = max((sun + uSoft) / (1.0 + uSoft), 0.0);
  // 天光：地平线下 18° 以内的地面是被整片天空照亮的，晨昏线之所以「柔」靠的是这一项
  float sky = smoothstep(-TWILIGHT, 0.35, sun);
  // 夜面底光的渐变必须在晨昏线上就到满。拖到地平线下 18° 才到满的话，直射光早已归零
  // 而底光还没起来，晨昏线内侧会留下一条比深夜面还暗的沟——那条沟本身就是一道硬边
  float glow = 1.0 - smoothstep(0.0, TWILIGHT, sun);
  // 城市灯火要等真正天黑才看得见，航海晨昏时的天光足够把它盖掉
  float night = 1.0 - smoothstep(-TWILIGHT, 0.02, sun);
  // 越贴近晨昏线，阳光穿过的大气路径越长，蓝光散射得越干净。所以这里改的是「阳光的
  // 颜色」，而不是往地表上再叠一条橙色带——加法会糊出一条像画上去的条带，
  // 乘法才是日照本身变红这件事
  vec3 sunTint = mix(uWarmTint, vec3(1.0), smoothstep(-0.02, 0.34, sun));

  vec3 color = albedo * sunTint * direct * 1.15;
  color += albedo * uAtmoColor * sky * uSkyLevel;
  // 夜面：大气辉光加一点地表底光让轮廓不至于消失，城市灯火单独按 night 门控
  color += (uNightTint + albedo * uNightLevel) * glow + city * uCityGain * night;

  // 掠着地平线的那段阳光被大气滤成落日的橙红。这是一道只出现在球体边缘的细弧，
  // 所以只喂给下面的边缘项，不再往地表上加
  float sunset = exp(-pow((sun + 0.05) / uDawnWidth, 2.0));

  // 经纬网只画在矢量占位球上：真实影像一淡入就整条撤掉，否则看着像张示意图。
  // 子午线按 cos(纬度) 淡出，否则极点附近会糊成一团
  vec2 cell = fract(vUv * uGridDiv - 0.5) - 0.5;
  float latFade = cos((vUv.y - 0.5) * PI);
  float meridian = (1.0 - smoothstep(uGridWidth * 0.5, uGridWidth, abs(cell.x))) * latFade;
  float parallel = 1.0 - smoothstep(uGridWidth * 0.5, uGridWidth, abs(cell.y));
  color += uGridColor * max(meridian, parallel) * uGridAlpha * (1.0 - uReal);

  // 边缘大气：真实大气只有 100 km 厚，占地球半径的 1.6%，所以那道弧必须很细——
  // 指数取 6 才够细，取 3 会糊成一圈涂上去的光环。颜色是 mix 而不是相加：
  // 掠过晨昏线的那一段要变成落日的橙红，蓝加红会得到不该出现的洋红
  float rim = pow(1.0 - abs(dot(normalize(vViewNormal), normalize(-vViewPos))), 6.0);
  vec3 rimColor = mix(uAtmoColor * (0.05 + 0.95 * sky), uDawnColor * uDawnRim, sunset);
  color += rimColor * rim;

  gl_FragColor = vec4(pow(max(color, 0.0), vec3(1.0 / SRGB)), 1.0);
}
`

export const MOON_VERTEX = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldNormal;

void main() {
  vUv = uv;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

export const MOON_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uSunDir;
uniform vec3 uFlat;
uniform vec2 uMapUv;
uniform float uReal;
uniform float uEarthshine;

varying vec2 vUv;
varying vec3 vWorldNormal;

const float SRGB = 2.2;
// 羽化带半宽，约占月面直径 5%：月球没大气，界线本该锐，宽了就成糊
const float TERM = 0.05;

void main() {
  // uMapUv 把等距圆柱贴图的一段拉满 [0,1]：桌面那张只存了正对地球的半张，
  // 同样的字节数换到两倍纹素密度，背面反正永远不入画（见 cosmosEngine 里的说明）
  vec2 uv = vec2((vUv.x - uMapUv.y) * uMapUv.x, vUv.y);
  vec3 albedo = mix(uFlat, pow(texture2D(uMap, uv).rgb, vec3(SRGB)), uReal);
  float sun = dot(normalize(vWorldNormal), uSunDir);
  // 0.55 次方模拟月壤的反向散射（接近 Lommel-Seeliger 而非朗伯），满月才像平盘而非球。
  // 它在 sun=0 处导数无穷大，晨昏线会硬切一刀；用二次曲线把这个拐角磨圆：-TERM 处值与
  // 斜率同时归零，+TERM 处与原直线相切，差值恰是 (sun-TERM)^2/4TERM，带外一像素未动
  float t = clamp(sun / TERM, -1.0, 1.0);
  float lit = pow(max(sun, TERM * 0.25 * (t + 1.0) * (t + 1.0)), 0.55);
  gl_FragColor = vec4(pow(albedo * (lit * 1.15 + uEarthshine), vec3(1.0 / SRGB)), 1.0);
}
`

export const SUN_VERTEX = /* glsl */ `
varying vec3 vLocal;
varying vec3 vViewNormal;
varying vec3 vViewPos;

void main() {
  // 未经缩放的局部坐标：太阳的 scale 在两个视角之间要变三十多倍，
  // 拿它当噪声输入，米粒组织的疏密才不会跟着缩放一起变
  vLocal = position;
  vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
  vViewPos = viewPos.xyz;
  vViewNormal = normalMatrix * normal;
  gl_Position = projectionMatrix * viewPos;
}
`

export const SUN_FRAGMENT = /* glsl */ `
uniform vec3 uCore;
uniform vec3 uEdge;
uniform float uTime;

varying vec3 vLocal;
varying vec3 vViewNormal;
varying vec3 vViewPos;

const float SRGB = 2.2;

float hash(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
}

// 三线性插值的值噪声，一层 8 次 hash。用局部坐标而不是 UV：等距圆柱 UV 会让
// 噪声在两极挤成一团，还会在 u=0 那条经线上留下一道缝
float noise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  vec2 o = vec2(0.0, 1.0);
  return mix(
    mix(mix(hash(i + o.xxx), hash(i + o.yxx), f.x), mix(hash(i + o.xyx), hash(i + o.yyx), f.x), f.y),
    mix(mix(hash(i + o.xxy), hash(i + o.yxy), f.x), mix(hash(i + o.xyy), hash(i + o.yyy), f.x), f.y),
    f.z);
}

void main() {
  // 临边昏暗：越靠日面边缘，视线越是斜着扎进光球层，看到的是更高更冷的一层，
  // 所以太阳照片的边缘明显发暗发红。这一项是它看着像个球而不是一张圆纸片的全部原因
  float mu = max(dot(normalize(vViewNormal), normalize(-vViewPos)), 0.0);
  float limb = 0.34 + 0.66 * pow(mu, 0.55);
  // 米粒组织：两层反向慢漂的噪声，速度差一点点就有对流翻滚的错觉
  float g = noise(vLocal * 7.0 + vec3(0.0, uTime * 0.05, 0.0)) * 0.62
          + noise(vLocal * 19.0 - vec3(0.0, uTime * 0.09, 0.0)) * 0.38;
  vec3 color = mix(uEdge, uCore, limb) * (0.88 + 0.26 * g);
  gl_FragColor = vec4(pow(max(color, 0.0), vec3(1.0 / SRGB)), 1.0);
}
`

// blank 是一张 1×1 纯黑贴图，占住真实贴图还没下完时的采样位
export function createEarthUniforms(vectorMap, blank) {

  return {
    uMapVector: { value: vectorMap },
    uMapDay: { value: vectorMap },
    uMapNight: { value: blank },
    uSunDir: { value: new Vector3(1, 0, 0) },
    // 夜面底光。得明显低于「被斜射阳光照到的深海」，否则晨昏线在洋面上就消失了：
    // 大洋的反照率只有百分之几，晨昏线附近的日照又只剩一成
    uNightTint: { value: new Color(0x02060d) },
    uNightLevel: { value: 0.09 },
    uCityGain: { value: 2.6 },
    // 明暗界线的软化量。0.14 对应地平线下约 8°，再大就会显得像糊了一层雾
    uSoft: { value: 0.14 },
    uSkyLevel: { value: 0.09 },
    // 落日色只用在边缘那道弧上，亮度按「暖色调 × 系数」给
    uWarmTint: { value: new Color(0xffb27a) },
    uDawnColor: { value: new Color(0x8a3c12) },
    uDawnWidth: { value: 0.12 },
    uDawnRim: { value: 1.7 },
    uAtmoColor: { value: new Color(0x2f7fd0) },
    uGridColor: { value: new Color(0x2a6f7a) },
    uGridDiv: { value: new Vector2(36, 18) },
    uGridWidth: { value: 0.022 },
    uGridAlpha: { value: 0.35 },
    uReal: { value: 0 },
  }
}

export function createMoonUniforms(blank) {
  return {
    uMap: { value: blank },
    uSunDir: { value: new Vector3(1, 0, 0) },
    uFlat: { value: new Color(0xc9c6bd) },
    // (缩放, 偏移)：整张等距圆柱图就是 (1, 0)
    uMapUv: { value: new Vector2(1, 0) },
    uEarthshine: { value: 0.014 },
    uReal: { value: 0 },
  }
}

export function createSunUniforms() {
  return {
    uCore: { value: new Color(0xfff4d6) },
    uEdge: { value: new Color(0xf07a1e) },
    uTime: { value: 0 },
  }
}

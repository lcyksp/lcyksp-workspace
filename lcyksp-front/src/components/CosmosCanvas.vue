<script setup>
// 全站唯一 import three 的地方。父组件用 defineAsyncComponent 挂它，
// three 就单独落到一个 chunk 里，首页 HUD 不必等它下载完
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { createCosmos } from '../utils/cosmosEngine.js'
import { loadLandRings } from '../utils/geoTexture.js'
import { resolveViewerLocation } from '../utils/timezoneGeo.js'

const emit = defineEmits(['ready', 'failed', 'pick'])

const canvasRef = ref(null)
let engine = null
let observer = null
let gone = false

// 小屏一律降档；桌面只看逻辑核心数，双核机器多半也没有独显
function detectQuality() {
  if (window.innerWidth < 820) return 'low'
  return (navigator.hardwareConcurrency || 8) <= 2 ? 'low' : 'high'
}

onMounted(async () => {
  try {
    const rings = await loadLandRings()
    if (gone || !canvasRef.value) return
    engine = createCosmos({
      canvas: canvasRef.value,
      rings,
      location: resolveViewerLocation(),
      quality: detectQuality(),
    })
    observer = new ResizeObserver(() => engine?.resize())
    observer.observe(canvasRef.value)
    emit('ready', engine)
  } catch (error) {
    // 拿不到 WebGL 或海岸线数据就静默退场，HUD 与页面背景照常显示
    console.warn('[cosmos] 初始化失败', error)
    emit('failed', error)
  }
})

onBeforeUnmount(() => {
  gone = true
  observer?.disconnect()
  observer = null
  engine?.dispose()
  engine = null
})

// 横拖满一个画面宽、竖拖满一个画面高都 ≈ 180°，手机和桌面拖同样的比例就转过同样的
// 角度；俯角总行程只有上下各 88°，所以一屏高刚好从南极上方摇到北极上方
const DRAG_TURN = Math.PI
// 位移超过这个值就算拖拽，不再当成点击去 pick
const CLICK_SLOP = 6
// 松手前最后一次移动早于这个间隔，就当人是停住之后才放手的，不给惯性
const FLICK_STALE_MS = 90
// 滚轮一格把相机距离乘/除 1.15：地球从默认取景拉到贴满画框大约十格
const WHEEL_ZOOM = 1.15

let pointerId = null
let dragActive = false
let radPerPxX = 0
let radPerPxY = 0
let lastX = 0
let lastY = 0
let lastTime = 0
let moved = 0
let flickX = 0
let flickY = 0
// 双指捏合要同时跟踪两根手指，单个 pointerId 不够用
const points = new Map()
let pinchDist = 0

function fingerDist() {
  const [a, b] = points.values()
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function onPointerDown(event) {
  if (!engine) return
  const rect = canvasRef.value.getBoundingClientRect()
  if (!rect.width || !rect.height) return
  points.set(event.pointerId, { x: event.clientX, y: event.clientY })
  if (points.size === 2) {
    // 第二根手指落下就从拖拽切成捏合：先把手上的惯性收掉，再记下初始指距。
    // 顺手把 moved 抬到点击阈值以上，捏完抬手时浏览器补的那次 click 就不会去 pick
    if (dragActive) engine.endDrag(0, 0)
    dragActive = false
    pointerId = null
    pinchDist = fingerDist()
    moved += CLICK_SLOP + 1
    return
  }
  if (pointerId !== null || event.button !== 0) return
  pointerId = event.pointerId
  radPerPxX = DRAG_TURN / rect.width
  radPerPxY = DRAG_TURN / rect.height
  lastX = event.clientX
  lastY = event.clientY
  lastTime = event.timeStamp
  moved = 0
  flickX = 0
  flickY = 0
  canvasRef.value.setPointerCapture(pointerId)
  // 镜头奔着地球或月球特写去就开放旋转（飞行途中拖只是改飞行路径）；太阳系全景里不转。
  // 不转也照旧累加 moved，好让全景里的划动不会在抬手时被误判成一次点击
  dragActive = engine.getZoom() <= 0.02
  if (dragActive) engine.beginDrag()
}

function onPointerMove(event) {
  const point = points.get(event.pointerId)
  if (point) {
    point.x = event.clientX
    point.y = event.clientY
  }
  if (points.size >= 2) {
    const dist = fingerDist()
    // 指距张开一倍就把相机距离缩一半，这正是「捏着的那块画面跟着手指走」的映射
    if (pinchDist && dist) engine.dollyBy(pinchDist / dist)
    pinchDist = dist
    return
  }
  if (pointerId !== event.pointerId) return
  const dx = event.clientX - lastX
  const dy = event.clientY - lastY
  const dt = (event.timeStamp - lastTime) / 1000
  lastX = event.clientX
  lastY = event.clientY
  lastTime = event.timeStamp
  moved += Math.hypot(dx, dy)
  if (!dragActive) return
  // 相机是绕着地球转的：往右拖要让方位角减小，往下拖要让相机升高，
  // 这样画面上的地表才跟着手指走
  const radAzimuth = -dx * radPerPxX
  const radElevation = dy * radPerPxY
  engine.dragBy(radAzimuth, radElevation)
  // 单帧除以极小的 dt 会把一两像素的抖动放大成很大的速度，夹一个下限再平滑一次
  const perSecond = 1 / Math.max(dt, 0.008)
  const instX = radAzimuth * perSecond
  const instY = radElevation * perSecond
  flickX = flickX ? flickX * 0.5 + instX * 0.5 : instX
  flickY = flickY ? flickY * 0.5 + instY * 0.5 : instY
}

function onPointerUp(event) {
  points.delete(event.pointerId)
  if (points.size < 2) pinchDist = 0
  if (pointerId !== event.pointerId) return
  pointerId = null
  if (!dragActive) return
  dragActive = false
  const stale = event.type !== 'pointerup' || event.timeStamp - lastTime > FLICK_STALE_MS
  engine?.endDrag(stale ? 0 : flickX, stale ? 0 : flickY)
}

// 滚轮只改「离当前天体多远」，不换天体：换天体一律靠点击。首页是 overflow:hidden
// 的一屏，本来也没有滚动可以劫持
function onWheel(event) {
  if (!engine) return
  // deltaMode 1 是「行」，Firefox 一格给 3 行，先换算成像素再归一
  const px = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaY
  // 往下滚是推远、往上滚是拉近，跟地图一致
  engine.dollyBy(WHEEL_ZOOM ** Math.max(-1, Math.min(1, px / 100)))
}

function onClick(event) {
  // moved 到下一次按下才清零，所以拖完松手带出来的这次 click 会被这里拦掉
  if (!engine || moved > CLICK_SLOP) return
  emit('pick', engine.pick(event.clientX, event.clientY))
}
</script>

<template>
  <canvas
    ref="canvasRef"
    class="cosmos-canvas"
    @click="onClick"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @wheel.prevent="onWheel"
  />
</template>

<style scoped>
.cosmos-canvas {
  display: block;
  width: 100%;
  height: 100%;
  /* 上下拖也要，所以两个方向的手势都得从浏览器手里收过来。首页本身是
     overflow:hidden 的一屏，没有滚动可劫持，代价只是这一页没有下拉刷新 */
  touch-action: none;
  cursor: grab;
}

.cosmos-canvas:active {
  cursor: grabbing;
}
</style>

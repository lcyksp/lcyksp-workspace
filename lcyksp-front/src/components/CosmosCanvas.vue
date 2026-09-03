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

// 横拖满一个画面宽 ≈ 180°，这样手机和桌面拖同样的比例转过同样的角度
const DRAG_TURN = Math.PI
// 位移超过这个值就算拖拽，不再当成点击去 pick
const CLICK_SLOP = 6
// 松手前最后一次移动早于这个间隔，就当人是停住之后才放手的，不给惯性
const FLICK_STALE_MS = 90

let pointerId = null
let dragActive = false
let radPerPx = 0
let lastX = 0
let lastTime = 0
let moved = 0
let flickVel = 0

function onPointerDown(event) {
  if (!engine || pointerId !== null || event.button !== 0) return
  const rect = canvasRef.value.getBoundingClientRect()
  if (!rect.width) return
  pointerId = event.pointerId
  radPerPx = DRAG_TURN / rect.width
  lastX = event.clientX
  lastTime = event.timeStamp
  moved = 0
  flickVel = 0
  canvasRef.value.setPointerCapture(pointerId)
  // 拖拽只在地球特写里开放。太阳系全景和缩放过渡期间照旧只跟踪位移，
  // 好让全景里的划动不会被误判成一次点击
  dragActive = engine.getZoom() <= 0.02
  if (dragActive) engine.beginDrag()
}

function onPointerMove(event) {
  if (pointerId !== event.pointerId) return
  const dx = event.clientX - lastX
  const dt = (event.timeStamp - lastTime) / 1000
  lastX = event.clientX
  lastTime = event.timeStamp
  moved += Math.abs(dx)
  if (!dragActive) return
  // 相机是绕着地球转的，往右拖要让方位角减小，画面上的地表才跟着手指往右走
  const rad = -dx * radPerPx
  engine.dragBy(rad)
  // 单帧除以极小的 dt 会把一两像素的抖动放大成很大的速度，夹一个下限再平滑一次
  const inst = rad / Math.max(dt, 0.008)
  flickVel = flickVel ? flickVel * 0.5 + inst * 0.5 : inst
}

function onPointerUp(event) {
  if (pointerId !== event.pointerId) return
  pointerId = null
  if (!dragActive) return
  dragActive = false
  const stale = event.type !== 'pointerup' || event.timeStamp - lastTime > FLICK_STALE_MS
  engine?.endDrag(stale ? 0 : flickVel)
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
  />
</template>

<style scoped>
.cosmos-canvas {
  display: block;
  width: 100%;
  height: 100%;
  /* 只吃横向手势，纵向留给浏览器；不写 none 是为了不劫持移动端的下拉刷新 */
  touch-action: pan-y;
  cursor: grab;
}

.cosmos-canvas:active {
  cursor: grabbing;
}
</style>

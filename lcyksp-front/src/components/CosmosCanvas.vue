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

function onClick(event) {
  if (engine) emit('pick', engine.pick(event.clientX, event.clientY))
}
</script>

<template>
  <canvas ref="canvasRef" class="cosmos-canvas" @click="onClick" />
</template>

<style scoped>
.cosmos-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
</style>

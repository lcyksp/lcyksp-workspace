<script setup>
import { ref, watch, onUnmounted } from 'vue'

const props = defineProps({
  active: { type: Boolean, default: false },
})

const videoRef = ref(null)
const phase = ref('intro')

const INTRO_SRC = '/videos/CH0335_home_Idle_01_R.webm'
const LOOP_SRC = '/videos/CH0335_home_Idle_01.webm'

function currentSrc() {
  return phase.value === 'intro' ? INTRO_SRC : LOOP_SRC
}

async function loadAndPlay() {
  const video = videoRef.value
  if (!video || !props.active) return

  const src = currentSrc()
  const shouldLoop = phase.value === 'loop'

  if (!video.src.endsWith(src)) {
    video.loop = shouldLoop
    video.src = src
    video.load()
  } else {
    video.loop = shouldLoop
  }

  try {
    await video.play()
  } catch {
    // autoplay may be blocked until user interaction
  }
}

function handleEnded() {
  if (phase.value !== 'intro') return
  phase.value = 'loop'
  loadAndPlay()
}

function resetAndPlay() {
  phase.value = 'intro'
  loadAndPlay()
}

watch(
  () => props.active,
  (active) => {
    if (active) {
      resetAndPlay()
      return
    }
    const video = videoRef.value
    if (video) {
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
    phase.value = 'intro'
  },
  { immediate: true },
)

onUnmounted(() => {
  videoRef.value?.pause()
})
</script>

<template>
  <div v-show="active" class="video-background" aria-hidden="true">
    <video
      ref="videoRef"
      class="video-background__media"
      muted
      playsinline
      preload="auto"
      @ended="handleEnded"
    />
  </div>
</template>

<style scoped>
.video-background {
  position: fixed;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
  background: #050508;
}

.video-background__media {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
}
</style>

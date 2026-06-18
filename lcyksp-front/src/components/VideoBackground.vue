<script setup>
import { ref, watch, onUnmounted, nextTick } from 'vue'

const props = defineProps({
  active: { type: Boolean, default: false },
})

const introRef = ref(null)
const loopRef = ref(null)
const activeVideo = ref('intro') // 'intro' or 'loop'

const INTRO_SRC = '/videos/CH0335_home_Idle_01_R.webm'
const LOOP_SRC = '/videos/CH0335_home_Idle_01.webm'

async function playIntro() {
  const intro = introRef.value
  const loop = loopRef.value
  if (!intro || !props.active) return

  // Reset active video phase
  activeVideo.value = 'intro'
  
  // Set loop video src and load to preload the content in background
  if (loop) {
    loop.src = LOOP_SRC
    loop.loop = true
    loop.load()
  }

  intro.src = INTRO_SRC
  intro.loop = false
  intro.load()

  try {
    await intro.play()
  } catch {
    // autoplay might be blocked
  }
}

function handleIntroEnded() {
  if (activeVideo.value !== 'intro') return
  
  const intro = introRef.value
  const loop = loopRef.value
  if (loop) {
    loop.play().then(() => {
      activeVideo.value = 'loop'
      // Pause intro after loop successfully plays to guarantee absolute seamless switch
      if (intro) {
        intro.pause()
      }
    }).catch(() => {
      activeVideo.value = 'loop'
      loop.play().catch(() => {})
    })
  } else {
    activeVideo.value = 'loop'
  }
}

watch(
  () => props.active,
  (active) => {
    if (active) {
      nextTick(() => {
        playIntro()
      })
      return
    }
    const intro = introRef.value
    if (intro) {
      intro.pause()
      intro.removeAttribute('src')
      intro.load()
    }
    const loop = loopRef.value
    if (loop) {
      loop.pause()
      loop.removeAttribute('src')
      loop.load()
    }
    activeVideo.value = 'intro'
  },
  { immediate: true },
)

onUnmounted(() => {
  introRef.value?.pause()
  loopRef.value?.pause()
})
</script>

<template>
  <div v-show="active" class="video-background" aria-hidden="true">
    <!-- Intro Phase Video -->
    <video
      ref="introRef"
      class="video-background__media"
      :class="{ 'is-active': activeVideo === 'intro' }"
      muted
      playsinline
      preload="auto"
      @ended="handleIntroEnded"
    />
    <!-- Loop Phase Video -->
    <video
      ref="loopRef"
      class="video-background__media"
      :class="{ 'is-active': activeVideo === 'loop' }"
      muted
      playsinline
      preload="auto"
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
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
  opacity: 0;
  transition: opacity 0.15s ease-in-out;
  z-index: 1;
}

.video-background__media.is-active {
  opacity: 1;
  z-index: 2;
}
</style>

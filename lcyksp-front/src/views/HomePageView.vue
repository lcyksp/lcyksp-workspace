<script setup>
import { computed, inject } from 'vue'
import HomeView from './HomeView.vue'
import HomeGlassView from './HomeGlassView.vue'

const glassHomeMode = inject('glassHomeMode')
const showGlassHome = computed(() => Boolean(glassHomeMode?.value ?? glassHomeMode))
</script>

<template>
  <HomeGlassView v-if="showGlassHome" />
  <HomeView v-else />
</template>

<script setup>
import HomeCosmosView from './HomeCosmosView.vue'
// 首页只留星象版一个。另外两个版本的文件都还在仓库里，没删：
//   记忆大厅（玻璃首页，已下架）：放开下面 HomeGlassView 的 import 与模板里那一行，
//     并把 App.vue 的 canUseGlassHome 改回按角色判断
//   经典首页：放开 HomeView 的 import 与模板里那一行，删掉 <HomeCosmosView />
// import HomeGlassView from './HomeGlassView.vue'
// import HomeView from './HomeView.vue'
</script>

<template>
  <HomeCosmosView />
  <!-- <HomeGlassView v-if="showGlassHome" /> -->
  <!-- <HomeView /> -->
</template>

<script setup>
import ImageConvert from '../components/ImageConvert.vue'
</script>

<template>
  <div class="page-view">
    <h2 class="page-title"><span class="title-icon">🔄</span> 格式转换</h2>
    <p class="page-desc">高频图像格式在线互转，支持 PDF 打包</p>
    <div class="page-content">
      <ImageConvert />
    </div>
  </div>
</template>

<style scoped>
.page-view {
  max-width: 640px;
  margin: 0 auto;
  padding: 20px 16px 40px;
}
.page-title {
  font-size: 1.4rem;
  font-weight: 400;
  color: var(--text-heading);
  margin: 0 0 6px;
  letter-spacing: 1px;
}
.title-icon { margin-right: 8px; }
.page-desc {
  color: var(--text-muted);
  font-size: 0.85rem;
  margin: 0 0 24px;
}
.page-content {
  background: var(--bg-card);
  border-radius: 12px;
  padding: 24px;
  border: 1px solid var(--border-color);
}

@media (max-width: 480px) {
  .page-view { padding: 12px 10px 30px; }
  .page-content { padding: 16px; }
}
</style>

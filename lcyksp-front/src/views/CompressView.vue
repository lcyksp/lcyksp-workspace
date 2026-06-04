<script setup>
import ImageCompress from '../components/ImageCompress.vue'
</script>

<template>
  <div class="page-view">
    <h2 class="page-title"><span class="title-icon">📦</span> 图片压缩</h2>
    <p class="page-desc">精准压制图片到指定大小，一键下载</p>
    <div class="page-content">
      <ImageCompress />
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
  color: #e0e0e0;
  margin: 0 0 6px;
  letter-spacing: 1px;
}
.title-icon { margin-right: 8px; }
.page-desc {
  color: #666;
  font-size: 0.85rem;
  margin: 0 0 24px;
}
.page-content {
  background: #16162a;
  border-radius: 12px;
  padding: 24px;
  border: 1px solid #222244;
}

@media (max-width: 480px) {
  .page-view { padding: 12px 10px 30px; }
  .page-content { padding: 16px; }
}
</style>

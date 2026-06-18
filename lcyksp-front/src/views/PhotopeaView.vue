<script setup>
// Photopea View - Embeds Photopea editor in a beautiful full-screen container
</script>

<template>
  <div class="photopea-view">
    <div class="page-header">
      <h2 class="page-title"><span class="title-icon">🎨</span> 在线 P 图 (Photopea)</h2>
      <p class="page-desc">免安装的专业在线图像编辑器，功能完全比肩 Photoshop，支持导入 PSD、XD、Sketch、RAW 等格式，完全在本地浏览器运行。</p>
    </div>

    <div class="iframe-container">
      <iframe 
        src="https://www.photopea.com" 
        class="photopea-iframe" 
        title="Photopea Editor"
        allow="clipboard-read; clipboard-write; fullscreen"
      ></iframe>
    </div>
  </div>
</template>

<style scoped>
.photopea-view {
  width: 100%;
  height: calc(100vh - 64px); /* Full height minus header */
  display: flex;
  flex-direction: column;
  padding: 16px 20px 20px;
  box-sizing: border-box;
}

.page-header {
  margin-bottom: 12px;
  flex-shrink: 0;
}

.page-title {
  margin: 0 0 2px;
  color: var(--text-heading);
  font-size: 1.25rem;
  font-weight: 500;
}

.title-icon {
  margin-right: 6px;
}

.page-desc {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.82rem;
}

.iframe-container {
  flex: 1;
  width: 100%;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  overflow: hidden;
  background: #1a1a1a; /* Photopea default theme match */
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
}

.photopea-iframe {
  width: 100%;
  height: 100%;
  border: none;
  display: block;
}

@media (max-width: 768px) {
  .photopea-view {
    padding: 8px 10px 10px;
    height: calc(100vh - 56px);
  }
  
  .page-header {
    margin-bottom: 8px;
  }
  
  .page-title {
    font-size: 1.1rem;
  }
  
  .page-desc {
    display: none;
  }
}
</style>

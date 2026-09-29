<script setup>
// 弱端/软件渲染/reduced-motion 时代替 three 星象的轻量星空：纯 CSS、零 three、零 rAF。
// 底色用父级 .cosmos-view 的深空渐变，这里只叠星点。多数星点静止，一层做极缓 twinkle；
// prefers-reduced-motion 下连 twinkle 也停，纯静态——软件渲染的机器上开销近乎为零。
</script>

<template>
  <div class="css-cosmos" aria-hidden="true">
    <div class="stars stars-far"></div>
    <div class="stars stars-near"></div>
  </div>
</template>

<style scoped>
.css-cosmos {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.stars {
  position: absolute;
  inset: 0;
  background-repeat: no-repeat;
}

/* 远景：密而暗的小星点，静止 */
.stars-far {
  background-image:
    radial-gradient(1px 1px at 5% 12%, rgba(255, 255, 255, 0.65), transparent),
    radial-gradient(1px 1px at 12% 42%, rgba(255, 255, 255, 0.5), transparent),
    radial-gradient(1px 1px at 18% 78%, rgba(200, 226, 255, 0.6), transparent),
    radial-gradient(1px 1px at 23% 25%, rgba(255, 255, 255, 0.55), transparent),
    radial-gradient(1px 1px at 27% 60%, rgba(255, 255, 255, 0.45), transparent),
    radial-gradient(1px 1px at 33% 88%, rgba(255, 255, 255, 0.6), transparent),
    radial-gradient(1px 1px at 38% 15%, rgba(210, 232, 255, 0.55), transparent),
    radial-gradient(1px 1px at 42% 50%, rgba(255, 255, 255, 0.5), transparent),
    radial-gradient(1px 1px at 47% 72%, rgba(255, 255, 255, 0.6), transparent),
    radial-gradient(1px 1px at 52% 30%, rgba(255, 255, 255, 0.5), transparent),
    radial-gradient(1px 1px at 56% 8%, rgba(255, 255, 255, 0.55), transparent),
    radial-gradient(1px 1px at 61% 55%, rgba(210, 232, 255, 0.5), transparent),
    radial-gradient(1px 1px at 66% 82%, rgba(255, 255, 255, 0.6), transparent),
    radial-gradient(1px 1px at 70% 20%, rgba(255, 255, 255, 0.5), transparent),
    radial-gradient(1px 1px at 74% 45%, rgba(255, 255, 255, 0.55), transparent),
    radial-gradient(1px 1px at 78% 68%, rgba(255, 255, 255, 0.45), transparent),
    radial-gradient(1px 1px at 83% 35%, rgba(210, 232, 255, 0.6), transparent),
    radial-gradient(1px 1px at 87% 90%, rgba(255, 255, 255, 0.5), transparent),
    radial-gradient(1px 1px at 91% 18%, rgba(255, 255, 255, 0.55), transparent),
    radial-gradient(1px 1px at 95% 58%, rgba(255, 255, 255, 0.5), transparent),
    radial-gradient(1px 1px at 9% 65%, rgba(255, 255, 255, 0.5), transparent),
    radial-gradient(1px 1px at 30% 40%, rgba(255, 255, 255, 0.45), transparent),
    radial-gradient(1px 1px at 60% 38%, rgba(255, 255, 255, 0.5), transparent),
    radial-gradient(1px 1px at 85% 62%, rgba(255, 255, 255, 0.55), transparent);
}

/* 近景：疏而亮的大星点，极缓 twinkle */
.stars-near {
  background-image:
    radial-gradient(2px 2px at 8% 30%, rgba(255, 255, 255, 0.95), transparent),
    radial-gradient(2px 2px at 20% 55%, rgba(224, 240, 255, 0.9), transparent),
    radial-gradient(2px 2px at 35% 20%, rgba(255, 255, 255, 0.92), transparent),
    radial-gradient(2px 2px at 44% 78%, rgba(255, 255, 255, 0.88), transparent),
    radial-gradient(2px 2px at 55% 48%, rgba(210, 232, 255, 0.95), transparent),
    radial-gradient(2px 2px at 63% 15%, rgba(255, 255, 255, 0.9), transparent),
    radial-gradient(2px 2px at 68% 65%, rgba(255, 255, 255, 0.85), transparent),
    radial-gradient(2px 2px at 77% 85%, rgba(255, 255, 255, 0.92), transparent),
    radial-gradient(2px 2px at 82% 25%, rgba(224, 240, 255, 0.9), transparent),
    radial-gradient(2px 2px at 90% 50%, rgba(255, 255, 255, 0.88), transparent),
    radial-gradient(2px 2px at 14% 85%, rgba(255, 255, 255, 0.9), transparent),
    radial-gradient(2px 2px at 50% 90%, rgba(255, 255, 255, 0.85), transparent),
    radial-gradient(2px 2px at 73% 40%, rgba(255, 255, 255, 0.92), transparent);
  animation: css-twinkle 5.5s ease-in-out infinite;
}

@keyframes css-twinkle {
  0%, 100% { opacity: 0.75; }
  50% { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .stars-near { animation: none; opacity: 0.9; }
}
</style>

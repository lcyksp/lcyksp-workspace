# ✅ 六阶段分层执行计划 — 全部完成

## 1. 创建赛博菜谱数据库与后端路由
- [x] config/db.js — 新增 recipes 表 + 索引
- [x] 新建 lcyksp-backend/src/routes/recipe.js — 搜索/添加/SSE 流式端点
- [x] app.js — 挂载 recipeRouter 到 /api/recipe

## 2. 创建赛博菜谱前端页面与组件
- [x] 新建 lcyksp-front/src/views/RecipeView.vue — 搜索 + 瀑布流 + SSE 打字机
- [x] router/index.js — 添加 /recipe 路由
- [x] App.vue — 侧边栏添加「🍳 赛博菜谱」导航项 + 修复管理后台图标Bug

## 3. SQLite 索引与 SELECT * 全面审计替换
- [x] config/db.js — 添加 expire_time / family_group_id / recipes 索引
- [x] auth.js — SELECT * → 显式字段
- [x] admin.js — 3处 SELECT * → 显式字段
- [x] transmit.js — 2处 SELECT * → 显式字段
- [x] cron.js — SELECT * → 显式字段
- [x] gallery.js — SELECT * → 显式字段
- [x] grep 确认全仓库 0 处残留 SELECT *

## 4. 内存泄漏清洗与大 Buffer 流式化
- [x] compress.js — 每次迭代后释放 non-best buffer；发送后 setImmediate 置 null
- [x] convert.js — img2pdf chunks.length=0、pdfBuffer/imageBuffer 发送后 setImmediate 置 null
- [x] cron.js — setTimeout 加 .unref() 防止阻止进程退出

## 5. App.vue 图标修复
- [x] App.vue — 移除 `<el-icon><Setting /></el-icon>`，仅保留 `<span>🛡️ 管理后台</span>`

## 6. 端到端验证
- [x] node --check 全部后端文件 → 全部通过
- [x] vite build 前端 → 成功
- [x] .env 已含 DEEPSEEK_API_KEY

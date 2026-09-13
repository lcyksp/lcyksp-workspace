# lcyksp.xyz

> 个人在线工具站 —— 中文界面，前端 Vue 3 SPA + 后端 Express 单体，前后端同进程托管。

一个把日常零碎需求收在一处的工具箱：处理图片和 PDF、解析下载视频、看赛事数据、记课程表、查天气和 IP 归属地。首页是一块 three.js 实时 3D 星象。

站点：`https://lcyksp.xyz`

---

## 项目定位

全站跑在一台 **2 核 2 G** 的轻量云服务器上，所以有一条贯穿始终的设计原则：

> **能省服务器资源、能提高加载速度的方案一律优先；能纯前端做的，绝不占后端。**

这条原则的直接产物是：AI 图片放大（浏览器里跑 ESRGAN）、天气、ZIP 压缩解压、PDF 全套工具、像素画、证件照、图片混淆还原，全部零后端算力。后端只留绕不开的活——需要密钥的、需要外部二进制的、需要落库的。

---

## 功能一览

| 分类 | 功能 |
| --- | --- |
| 图片 | 压缩 · 格式转换 · 长图拼接 · 在线水印 · AI 放大 · 像素画/拼豆图纸 · 证件照 · 图片混淆还原 |
| PDF | 合并 · 拆分 · 压缩 · 转图片 · 转 Word · 签章 · 水印 · 页面编辑 · 提取文本 · 图片转 PDF |
| 文件 | 闪传（阅后即焚）· ZIP 工具 |
| 音视频 | 抖音/B站解析下载 · 剧集下载 · 在线屏幕录制 · 横屏歌词 |
| 数据资讯 | Apex 战绩 · ALGS 赛事 · GitHub 日报（会员）· 天气 · IP 归属地 |
| 生活学习 | 赛博菜谱（AI 流式生成）· 家庭相册 · 课程表 · 点名 · 会员卡密 |
| 首页 | three.js 实时星象（月球特写 / 地球特写 / 太阳系全景 三档视角） |
| 管理后台 | 文件 · 用户 · 大模型配置 · 视频解析出口 · GitHub 日报 · 网站监测 · 会员配置 · 卡密 · 问题反馈 |

规模：前端 **41 条路由 / 44 个视图文件**，后端 **19 个路由文件 / 36 张 SQLite 表**，管理后台 9 个 Tab。

---

## 技术栈

### 前端

| 领域 | 选型 |
| --- | --- |
| 框架 | Vue 3.5（全部 `<script setup>`）+ Vite 5.4，纯 JavaScript |
| 路由 | vue-router 4.6，除首页外全部懒加载 |
| UI | Element Plus 2.14 + icons-vue（全局注册） |
| 状态 | 无 Pinia / Vuex —— 组件内 `ref/reactive` + `provide/inject` |
| 3D | three.js 0.185.1 |
| 图像 AI | @tensorflow/tfjs 4.11 + upscaler + ESRGAN（纯前端超分） |
| PDF | pdf-lib 1.17（写入）+ pdfjs-dist 5.4（读取/渲染，走 Web Worker） |
| 其他 | axios、jszip、echarts |

### 后端

| 领域 | 选型 |
| --- | --- |
| 框架 | Express 4.21，ESM，Node 20 / 22 |
| 数据库 | SQLite3 5.1.7（WAL 模式），无 ORM，原生驱动的 Promise 包装 |
| 图片处理 | sharp 0.33 |
| 安全 | helmet、express-rate-limit、jsonwebtoken + bcrypt |
| 上传 / 代理 | multer、undici（ProxyAgent 出口代理） |
| 截图 / 文档 | playwright-core（网页截图）、pdfkit（服务端图片转 PDF） |
| 外部二进制 | yt-dlp + ffmpeg（视频解析下载）、pdf2docx（PDF 转 Word） |
| 配置 | 敏感配置存数据库、AES-256-CBC 加密；环境变量只做开关与注入 |

---

## 系统架构

### 请求链路

```
浏览器 ──https──> Nginx (OpenResty) ──反代 /api──> Express :3000
                      │                              │
                      └── 托管前端静态产物            ├── routes/*        业务路由
                                                     ├── middleware/*   鉴权 / 会员 / 限流
                                                     └── SQLite (WAL) + 本地文件
```

前端构建产物由后端同进程托管，一个 Node 进程同时提供 API 与静态资源。

### 分层与约定

- **前端**：无独立 API 层，各页面直接 `import axios` 调 `/api/...`；无全局 store。
- **后端**：无 controllers / services / models 分层，业务逻辑直接写在 `routes/*`；数据库用 `CREATE TABLE IF NOT EXISTS` 幂等建表，无迁移框架。
- **鉴权**：JWT（有效期 7 天）+ 角色中间件（`requireAuth` / `requireAdmin` / `requirePremiumOrAdmin` / `requireGalleryAccess`）。
- **限流**：内存 store（单实例，无 Redis）—— 全局 300/min/IP；登录 10 次/15min（只计失败）；图片、解析等重接口 20/min。
- **配置**：无 `.env` 依赖，敏感值（大模型 Key、用户 Cookie、代理链接）统一存 `system_config` 表并 AES 加密。

### 目录结构

```
lcyksp-workspace/
├── lcyksp-front/                 前端 Vue 3 + Vite
│   ├── src/views/                视图（41 条路由）
│   ├── src/components/           复用组件
│   ├── src/utils/                星象历算 / 缩放引擎 / PDF 压缩 / 各类纯函数
│   ├── src/workers/              PDF 压缩 Web Worker（全站唯一）
│   └── vite.config.js            分包 / 预压缩 / GLSL 剥注释
├── lcyksp-backend/               后端 Express + SQLite
│   ├── src/app.js                入口 + 中间件链
│   ├── src/routes/               19 个业务路由文件
│   ├── src/middleware/           鉴权 / 会员 / 限流
│   └── src/utils/                加解密 / LLM 端点 / 配额 / 出口代理等
├── deploy.ps1 / deploy.sh        发布脚本
└── start-dev.bat                 Windows 一键起双端
```

---

## 本地开发

```bash
# 后端：监听 :3000
cd lcyksp-backend && npm install && npm run dev

# 前端：监听 :5173，/api 自动代理到 :3000
cd lcyksp-front && npm install && npm run dev

# 或根目录一键（concurrently 同时起双端）
npm run dev
```

- 前端产物验证别只跑 dev server：`cd lcyksp-front && npx vite build && npx vite preview`
- 后端测试：`cd lcyksp-backend && npm test`
- 本地调试视频解析需自备 `yt-dlp` / `ffmpeg`；PDF 转 Word 需 `pdf2docx`

---

## 说明

个人自用与学习性质的项目。涉及第三方平台解析的功能，仅作技术实践。

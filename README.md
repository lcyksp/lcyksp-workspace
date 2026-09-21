# lcyksp.xyz

个人在线工具站，中文界面。前端 Vue 3 SPA，后端 Express 单体，两端同进程跑。

站点：https://lcyksp.xyz

把平时零散的需求收在一处：处理图片和 PDF、解析下载视频、看看赛事数据、记课程表、查天气和 IP 归属地。首页放了一块 three.js 的实时 3D 星象。

## 关于这个项目

整站跑在一台 2 核 2G 的轻量云服务器上，所以做取舍时有个一以贯之的偏好：能省服务器资源、能提速的方案优先，能纯前端做的就不占后端。

这么一来，AI 图片放大（浏览器里跑 ESRGAN）、天气、ZIP 压缩解压、整套 PDF 工具、像素画、证件照、图片混淆还原这些，全都不吃后端算力。后端只留绕不开的活——要密钥的、要调外部二进制的、要落库的。

## 功能

| 分类 | 功能 |
| --- | --- |
| 图片 | 压缩 · 格式转换 · 长图拼接 · 在线水印 · AI 放大 · 像素画/拼豆图纸 · 证件照 · 图片混淆还原 |
| PDF | 合并 · 拆分 · 压缩 · 转图片 · 转 Word · 签章 · 水印 · 页面编辑 · 提取文本 · 图片转 PDF |
| 文件 | 闪传（阅后即焚）· ZIP 工具 |
| 音视频 | 抖音/B站解析下载 · 剧集下载 · 在线屏幕录制 · 横屏歌词 |
| 数据资讯 | Apex 战绩 · ALGS 赛事 · 战争雷霆交易所行情（会员）· GitHub 日报（会员）· 天气 · IP 归属地 |
| 生活学习 | 赛博菜谱（AI 流式生成）· 家庭相册 · 课程表 · 点名 · 微信步数 · 会员卡密 |
| 首页 | three.js 实时星象，月球特写 / 地球特写 / 太阳系全景三档视角 |
| 管理后台 | 文件 · 用户 · 大模型配置 · 视频解析出口 · GitHub 日报 · 网站监测 · 会员配置 · 卡密 · 问题反馈 |

## 技术栈

前端是 Vue 3.5 + Vite 5.4，纯 JavaScript，组件全用 `<script setup>`。路由走 vue-router 4.6，除首页外都懒加载。UI 用 Element Plus 2.14。没上 Pinia/Vuex，组件内 `ref/reactive` 配 `provide/inject` 就够了。3D 是 three.js，图片超分靠 tfjs + upscaler 跑 ESRGAN，PDF 读取用 pdfjs-dist（走 Web Worker），写入用 pdf-lib，另外还有 axios、jszip、echarts。

后端 Express 4.21，ESM，跑在 Node 20/22 上。数据库是 SQLite（WAL 模式），没用 ORM，自己包了层 Promise。图片处理用 sharp，鉴权 jsonwebtoken + bcrypt，安全相关有 helmet 和 express-rate-limit，上传用 multer，出口代理走 undici 的 ProxyAgent。网页截图用 playwright-core，服务端图片转 PDF 用 pdfkit。视频解析下载依赖 yt-dlp + ffmpeg，PDF 转 Word 依赖 pdf2docx。敏感配置（大模型 Key、用户 Cookie、代理链接）统一存数据库并 AES-256-CBC 加密，环境变量只做开关和注入。

## 架构

请求链路：

```
浏览器 ──https──> Nginx (OpenResty) ──反代 /api──> Express :3000
                      │                              │
                      └── 托管前端静态产物            ├── routes/*        业务路由
                                                     ├── middleware/*   鉴权 / 会员 / 限流
                                                     └── SQLite (WAL) + 本地文件
```

前端构建产物由后端同进程托管，一个 Node 进程同时提供 API 和静态资源。

几个约定：

- 前端没有独立的 API 层，页面直接 `import axios` 调 `/api/...`，也没有全局 store。
- 后端没分 controllers / services / models，业务逻辑直接写在 `routes/*`。建表用 `CREATE TABLE IF NOT EXISTS` 幂等处理，没上迁移框架。
- 鉴权用 JWT（7 天有效期）加角色中间件（`requireAuth` / `requireAdmin` / `requirePremiumOrAdmin` / `requireGalleryAccess`）。
- 限流用内存 store（单实例，无 Redis）：全局 300/min/IP，登录 10 次/15min（只计失败），图片、解析等重接口 20/min。

目录结构：

```
lcyksp-workspace/
├── lcyksp-front/                 前端 Vue 3 + Vite
│   ├── src/views/                视图
│   ├── src/components/           复用组件
│   ├── src/utils/                星象历算 / 缩放引擎 / PDF 压缩 / 各类纯函数
│   ├── src/workers/              PDF 压缩 Web Worker
│   └── vite.config.js            分包 / 预压缩 / GLSL 剥注释
├── lcyksp-backend/               后端 Express + SQLite
│   ├── src/app.js                入口 + 中间件链
│   ├── src/routes/               业务路由
│   ├── src/middleware/           鉴权 / 会员 / 限流
│   └── src/utils/                加解密 / LLM 端点 / 配额 / 出口代理等
├── deploy.ps1 / deploy.sh        发布脚本
└── start-dev.bat                 Windows 一键起双端
```

## 本地开发

```bash
# 后端：监听 :3000
cd lcyksp-backend && npm install && npm run dev

# 前端：监听 :5173，/api 自动代理到 :3000
cd lcyksp-front && npm install && npm run dev

# 或根目录一键（concurrently 同时起双端）
npm run dev
```

前端产物别只跑 dev server 验证，用 `npx vite build && npx vite preview`。后端测试 `npm test`。本地调视频解析要自备 yt-dlp / ffmpeg，PDF 转 Word 要 pdf2docx。

## 版本号

用 `主.次.修订` 三段式（比如 `4.2.0`），前后端 `package.json` 同版本：

- 主位：架构调整、技术栈更换、重大重构。
- 次位：加功能或下架功能。
- 修订位：修 bug、微调已有功能。

改主位或次位时，后面的段位都归零。比如次位 +1 时修订归零（`4.1.6` → `4.2.0`），主位 +1 时次位和修订都归零（`4.9.3` → `5.0.0`）。

## 说明

个人自用和学习性质的项目。涉及第三方平台解析的功能只作技术实践。

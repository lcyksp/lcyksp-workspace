# lcyksp-backend

lcyksp.xyz 全栈工具箱后端服务 — 极简 Node.js + Express + SQLite3 后端。

## 技术栈

- **运行时**: Node.js (ESM, `type: "module"`)
- **框架**: Express
- **数据库**: SQLite3 (via `sqlite3`, WAL 模式)
- **文件上传**: multer (最大 500MB)
- **图像处理**: sharp (压缩 & 格式转换)
- **PDF 生成**: pdfkit

## 目录结构

```
lcyksp-backend/
├── src/
│   ├── config/db.js      # SQLite3 连接与表初始化
│   ├── routes/
│   │   ├── transmit.js   # 文件闪传 (上传/校验/下载+阅后即焚)
│   │   ├── compress.js   # 图片精准大小压缩
│   │   └── convert.js    # 高频图像格式转换
│   ├── utils/cron.js     # 定时清理过期文件
│   └── app.js            # Express 入口
├── data/
│   ├── db/database.db    # SQLite3 数据库文件
│   └── uploads/          # 闪传临时文件目录
├── package.json
└── README.md
```

## 快速开始

```bash
npm install
npm start          # 生产启动
npm run dev        # 开发模式 (--watch 自动重启)
```

服务默认监听 `http://localhost:3000`。

## API 接口

### 健康检查

```
GET /api/health
```

### 模块 A — 文件闪传 (`/api/transmit`)

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/transmit/upload` | 上传文件，返回取件码 |
| POST | `/api/transmit/verify` | 下载前密码校验 |
| GET  | `/api/transmit/download/:id` | 流式下载 + 阅后即焚 |

### 模块 B — 图片压缩 (`/api/compress`)

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/compress/target-size` | 上传图片 + targetSize，返回压缩后图片 |

### 模块 C — 格式转换 (`/api/convert`)

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/convert/image` | 上传图片 + type，返回转换后文件 |

支持的转换类型: `png2jpg`, `webp2jpg`, `heic2jpg`, `img2pdf`

## 环境变量

- `PORT` — 监听端口 (默认 `3000`)

## 授权

个人项目 © lcyksp.xyz

# 🚀 lcyksp.xyz — 生产环境部署指南

> Ubuntu 24.04 · 1Panel 面板 · Nginx · Node.js 20 · SQLite3  
> 适用部署方案：PM2 守护 或 Docker 容器化

---

## 📦 目录

1. [前置准备](#1-前置准备)
2. [前端静态文件编译与上传](#2-前端静态文件编译与上传)
3. [后端投产（双方案任选）](#3-后端投产双方案任选)
   - [方案 A：PM2 进程守护](#方案-apm2-进程守护)
   - [方案 B：Docker 容器化](#方案-bdocker-容器化)
4. [1Panel Nginx 反向代理配置](#4-1panel-nginx-反向代理配置)
5. [安全组与防火墙放行终极 Checklist](#5-安全组与防火墙放行终极-checklist)
6. [初次部署快速检查清单](#6-初次部署快速检查清单)

---

## 1. 前置准备

### 1.0 大陆服务器访问 GitHub

GitHub 日报采集器需要访问 `api.github.com`、仓库 README 和内容接口。大陆服务器建议在服务器出口配置稳定的代理，或在服务器网络层配置合规的 VPN。推荐优先使用代理，因为它只影响 GitHub 采集流量。

在 PM2 或 1Panel 的后端环境变量中配置：

```bash
# HTTP/HTTPS 代理，例如 http://127.0.0.1:7890
# 若使用 SOCKS5，请先由服务器上的代理软件转换为 HTTP/HTTPS 本地端口，或直接使用 VPN 网络层
GITHUB_PROXY_URL=http://127.0.0.1:7890
GITHUB_REQUEST_TIMEOUT_MS=20000
```

不要把代理账号、密码、VPN 配置文件或私钥提交到 GitHub。若代理不需要认证，只绑定服务器本机地址（如 `127.0.0.1`），不要暴露代理端口到公网。VPN 方案应由服务器或 1Panel 网络层管理，应用无需保存 VPN 凭据。

### 1.1 服务器环境

| 项目 | 规格 |
|------|------|
| 云服务商 | 阿里云（深圳） |
| 实例类型 | 轻量应用服务器（2核 2G） |
| 操作系统 | Ubuntu 24.04 LTS |
| 面板 | 1Panel 最新版 |
| 域名 | `lcyksp.xyz`（已完成 DNS 解析 → 服务器公网 IP） |

### 1.2 在 1Panel 安装必要运行时

通过 1Panel 的 **应用商店** 安装：

1. **OpenResty / Nginx** — 用于静态文件托管和反向代理
2. **Node.js 20.x**（如用 PM2 方案，1Panel 的应用商店有 Node.js 运行环境；或用 nvm 手动安装）
3. 如用 Docker 方案：1Panel 内置容器管理，无需额外安装

### 1.3 获取代码

方式一：通过 Git 拉取

```bash
# 在服务器上操作
cd /opt
git clone https://github.com/your-org/lcyksp-workspace.git
cd lcyksp-workspace
```

方式二：本地打包上传

```bash
# 在本地开发机操作
tar -czf lcyksp-workspace.tar.gz lcyksp-backend lcyksp-front start-dev.bat package.json
# 通过 scp 或 1Panel 文件管理器上传到服务器 /opt/
```

---

## 2. 前端静态文件编译与上传

### 2.1 本地编译

```bash
# 在本地开发机（Windows/Mac/Linux）的 lcyksp-front 目录下
cd lcyksp-front
npm install
npm run build
```

编译产物在 `lcyksp-front/dist/` 目录下。

### 2.2 打包并上传到 1Panel

```bash
# 将 dist 打包
cd lcyksp-front
tar -czf dist.tar.gz dist/
```

**上传方式**（任选其一）：

- **1Panel 文件管理器**：登录 1Panel → 文件 → 上传 `dist.tar.gz` 到 `/opt/` → 解压
- **SCP 命令**：`scp dist.tar.gz root@你的服务器IP:/opt/`

### 2.3 在 1Panel 创建静态网站

1. 登录 1Panel → **网站** → **创建网站** → **静态网站**
2. **域名**：填入 `lcyksp.xyz`
3. **端口**：默认 80 / 443（需先申请 SSL 证书）
4. **主目录**：选择 `/opt/dist/`（解压后的 dist 文件夹路径）
5. **默认文档**：保持 `index.html`
6. 点击 **确认** 创建

> ⚠️ **注意**：不要在 1Panel 创建网站时勾选"自动反向代理"或"自动配置 HTTPS 代理"——后端 API 反代我们通过自定义 Nginx 配置单独处理。

---

## 3. 后端投产（双方案任选）

### 方案 A：PM2 进程守护

#### 步骤 1：安装 PM2

```bash
# 通过 SSH 登录服务器（1Panel 的终端功能）
npm install -g pm2
```

#### 步骤 2：安装后端依赖

```bash
cd /opt/lcyksp-workspace/lcyksp-backend
npm install --omit=dev
```

#### 步骤 3：启动后端

```bash
# 方案 1：直接使用 PM2 配置文件（推荐）
pm2 start ecosystem.config.cjs

# 方案 2：通过 npm script
npm run deploy:pm2
```

#### 步骤 4：设置 PM2 开机自启

```bash
pm2 startup systemd
pm2 save
```

#### 常用维护命令

```bash
pm2 status                    # 查看状态
pm2 logs lcyksp-backend       # 查看实时日志
pm2 restart lcyksp-backend    # 重启
pm2 stop lcyksp-backend       # 停止
pm2 delete lcyksp-backend     # 删除进程
```

---

### 方案 B：Docker 容器化

#### 步骤 1：准备数据目录（重要——持久化）

```bash
mkdir -p /opt/lcyksp-data/db /opt/lcyksp-data/uploads
```

#### 步骤 2：构建镜像

```bash
cd /opt/lcyksp-workspace/lcyksp-backend
docker build -t lcyksp-backend .
```

#### 步骤 3：运行容器

```bash
docker run -d \
  --name lcyksp-backend \
  --restart unless-stopped \
  -p 3000:3000 \
  -v /opt/lcyksp-data/db:/app/data/db \
  -v /opt/lcyksp-data/uploads:/app/data/uploads \
  lcyksp-backend
```

**参数说明：**

| 参数 | 说明 |
|------|------|
| `-d` | 后台运行 |
| `--restart unless-stopped` | 容器崩溃或服务器重启时自动拉起 |
| `-p 3000:3000` | 宿主机 3000 → 容器 3000 |
| `-v /opt/lcyksp-data/db:/app/data/db` | **数据库持久化**（SQLite 文件所在目录） |
| `-v /opt/lcyksp-data/uploads:/app/data/uploads` | **闪传文件持久化** |

#### 步骤 4：在 1Panel 容器管理中的配置方式

1Panel → **容器** → **创建容器**：

| 配置项 | 值 |
|--------|-----|
| 镜像 | `lcyksp-backend:latest`（从构建的本地镜像选择） |
| 容器名称 | `lcyksp-backend` |
| 端口映射 | `3000 → 3000`（宿主机 → 容器） |
| 重启策略 | `总是重启（unless-stopped）` |
| **存储挂载1** | `主机路径: /opt/lcyksp-data/db` → `容器路径: /app/data/db` |
| **存储挂载2** | `主机路径: /opt/lcyksp-data/uploads` → `容器路径: /app/data/uploads` |

#### 容器数据卷映射图

```
宿主机                         容器内
/opt/lcyksp-data/db/  ───►  /app/data/db/        ← SQLite 数据库
/opt/lcyksp-data/uploads/ ──► /app/data/uploads/   ← 闪传临时文件
```

#### 常用维护命令

```bash
docker ps                      # 查看运行中容器
docker logs -f lcyksp-backend  # 查看日志
docker restart lcyksp-backend  # 重启
docker stop lcyksp-backend     # 停止
docker start lcyksp-backend    # 启动
```

---

## 4. 1Panel Nginx 反向代理配置

### 4.1 核心原理

生产环境下，前端是纯静态文件（编译后的 `dist`），不再有 Vite 开发代理。  
所有 `/api/` 开头的请求必须由 **Nginx 反向代理** 转发到后端 `http://127.0.0.1:3000`。

```
浏览器 → https://lcyksp.xyz/api/... → Nginx → http://127.0.0.1:3000/api/...
                                    ↓
                           返回二进制流（压缩/转换/下载）
```

### 4.2 在 1Panel 网站自定义配置中粘贴

1. 登录 1Panel → **网站** → 点击 `lcyksp.xyz` 网站右侧的 **「配置」**
2. 切换到 **「配置文件」** 标签（或「反向代理」标签，取决于 1Panel 版本）
3. 在 `server { ... }` 块内的合适位置（一般在 `location /` 之后或之前），**完整粘贴以下代码块**：

```nginx
    # ============================================================
    # 后端 API 反向代理 — 将所有 /api/ 请求转发到 Node.js 后端
    # ============================================================
    location /api/ {
        # 后端地址（PM2 或 Docker 都监听 127.0.0.1:3000）
        proxy_pass http://127.0.0.1:3000;

        # ---------- HTTP 头透传 ----------
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # ---------- 大文件闪传支持（最大 1GB） ----------
        client_max_body_size 1024m;
        client_body_buffer_size 256k;

        # ---------- 流式文件下载/上传超时 ----------
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_connect_timeout 30s;

        # ---------- 二进制流式传输（关键！阻止 Nginx 缓冲死响应体） ----------
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_buffer_size 4k;

        # ---------- WebSocket 支持（为后续扩展） ----------
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
```

### 4.3 配置参数详解

| 参数 | 值 | 为什么这么设 |
|------|-----|-------------|
| `client_max_body_size` | `1024m` | 支持最大 1GB 的文件闪传上传 |
| `proxy_read_timeout` | `300s` | 图片压缩/转换处理可能耗时较长，防止 504 |
| `proxy_buffering` | `off` | **关键！** `/api/compress` 和 `/api/convert` 返回二进制流，Nginx 缓冲会破坏流式响应 |
| `proxy_request_buffering` | `off` | 上传大文件时不让 Nginx 先全部缓冲再转发，降低延迟 |
| `proxy_http_version` | `1.1` | WebSocket 需要 HTTP/1.1 的长连接 |
| `Upgrade / Connection` | — | 为以后可能的 WebSocket 功能预留 |

### 4.4 配置完成后验证

```bash
# 在服务器本地测试
curl http://127.0.0.1:3000/api/health         # 直接访问后端
curl http://127.0.0.1:80/api/health            # 通过 Nginx 代理
```

两个都应该返回 `{"status":"ok"}`。

---

## 5. 安全组与防火墙放行终极 Checklist

### 5.1 ⚠️ 核心原则

**必须在两个地方同时放行**，缺一不可：
1. **阿里云控制台** → 实例 → 安全组 → 入方向规则
2. **1Panel 面板** → 安全 → 防火墙

### 5.2 端口放行对照表

| 端口 | 协议 | 用途 | 阿里云安全组 | 1Panel 防火墙 | 备注 |
|------|------|------|-------------|---------------|------|
| **80** | TCP | HTTP 访问 | ✅ 必开 | ✅ 必开 | Let's Encrypt 自动申请证书也需要 |
| **443** | TCP | HTTPS 访问 | ✅ 必开 | ✅ 必开 | 如果用了 Cloudflare 可以不强制 |
| **5244** | TCP | Alist 网盘访问 | ✅ 必开 | ✅ 必开 | 如果 Alist 也部署在这台服务器上 |
| **22** | TCP | SSH 登录 | ✅ 必开 | ✅ 必开 | 建议限制来源 IP |
| 3000 | TCP | 后端服务 | ❌ **不开** | ❌ **不开** | 仅 Nginx 本地回环 `127.0.0.1` 访问，不暴露公网 |
| 5173 | TCP | Vite 开发 | ❌ 不开 | ❌ 不开 | 仅在本地开发时使用 |
| 面板端口 | TCP | 1Panel 管理 | ⚠️ 按需 | ✅ 必开 | 1Panel 安装时自动配置的端口 |

### 5.3 最佳实践建议

```bash
# 阿里云安全组 → 入方向：
# 优先级: 允许
# 协议类型: TCP
# 端口范围: 80, 443, 5244
# 授权对象: 0.0.0.0/0
# 描述: HTTP/HTTPS/Alist

# 1Panel → 安全 → 防火墙：
# 同样放开 80, 443, 5244 端口
```

> **🔥 安全提示**：后端端口 `3000` **绝对不能**暴露在公网。Nginx 通过 `proxy_pass http://127.0.0.1:3000` 本地转发即可，攻击者无法直接访问后端。

---

## 6. 初次部署快速检查清单

部署完成后，逐项确认：

- [ ] **前端页面可访问**：浏览器打开 `https://lcyksp.xyz`（或 `http://lcyksp.xyz`）能看到暗黑首页
- [ ] **健康检查正常**：访问 `https://lcyksp.xyz/api/health` 返回 `{"status":"ok"}`
- [ ] **后端日志无报错**：PM2 `pm2 logs` 或 Docker `docker logs lcyksp-backend` 无异常
- [ ] **文件闪传可用**：上传一个小文件，返回取件码
- [ ] **图片压缩可用**：上传图片，点击档位按钮，自动下载压缩后图片
- [ ] **格式转换可用**：上传图片，选择转换类型，下载转换后文件
- [ ] **大文件上传测试**：上传 500MB+ 文件，确认不会 504 超时
- [ ] **Alist 网盘独立访问**：`http://lcyksp.xyz:5244`（或子域名）能打开
- [ ] **SSL 证书生效**：1Panel 自动申请 Let's Encrypt 证书，HTTPS 正常
- [ ] **PM2 开机自启**（如需）：`pm2 startup` 已完成
- [ ] **Docker 重启策略**（如需）：`docker update --restart unless-stopped lcyksp-backend`

---

## 📎 附录：文件索引

| 文件 | 路径 | 说明 |
|------|------|------|
| PM2 配置 | `lcyksp-backend/ecosystem.config.cjs` | 生产守护进程配置 |
| Dockerfile | `lcyksp-backend/Dockerfile` | 容器镜像构建文件 |
| Docker 忽略 | `lcyksp-backend/.dockerignore` | 构建上下文排除规则 |
| 部署脚本 | `start-dev.bat` | 本地开发一键启动（不用于生产） |
| 本指南 | `DEPLOY.md` | 部署操作手册 |

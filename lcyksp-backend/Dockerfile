# lcyksp-backend/Dockerfile
# 多阶段构建，node:20-alpine 基础镜像
# 构建: docker build -t lcyksp-backend .
# 运行: docker run -d -p 3000:3000 \
#       -v /path/to/data/db:/app/data/db \
#       -v /path/to/data/uploads:/app/data/uploads \
#       lcyksp-backend

# ========== 阶段一: 安装依赖 ==========
FROM node:20-alpine AS deps

RUN apk add --no-cache tzdata curl

# 设置时区（防止 cron 定时任务时差错乱）
ENV TZ=Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

WORKDIR /app

# 先复制 package.json 和 lockfile，利用 Docker 层缓存
COPY package.json package-lock.json ./

# sharp 依赖的底层库 alpine 自带，直接 npm ci
RUN npm ci --omit=dev && npm cache clean --force

# ========== 阶段二: 运行 ==========
FROM node:20-alpine AS runner

RUN apk add --no-cache tzdata
ENV TZ=Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

WORKDIR /app

# 从 deps 阶段复制 node_modules 和时区数据
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /usr/share/zoneinfo /usr/share/zoneinfo

# 复制源码
COPY package.json ./
COPY src/ ./src/

# 创建数据目录（将由卷挂载覆盖）
RUN mkdir -p data/db data/uploads

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

CMD ["node", "src/app.js"]

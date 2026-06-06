#!/bin/bash

# ============================================================
#  lcyksp 全量部署脚本 — 支持 Git Bash (Windows) / Linux / Mac
#  用法:
#      ./deploy.sh                     # 交互式输入密码
#      SERVER_PASSWORD='密码' ./deploy.sh   # 非交互（CI/CD）
#
#  前置依赖: sshpass（密码登录用）
#    Windows (Git Bash + Chocolatey): choco install sshpass
#    macOS:  brew install sshpass
#    Ubuntu: apt install sshpass
# ============================================================

set -e

# ---------- 服务器配置 ----------
SERVER_IP="47.106.101.81"
SERVER_USER="admin"
REMOTE_BASE="/home/admin/lcyksp-base"
REMOTE_BACKEND="$REMOTE_BASE/lcyksp-backend"

# ---------- 颜色输出 ----------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}[INFO]${NC}  $1"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $1"; }

# ---------- 密码处理 ----------
if [ -z "$SERVER_PASSWORD" ]; then
  echo ""
  echo -e "${YELLOW}🔑 请输入服务器密码 (${SERVER_USER}@${SERVER_IP})${NC}"
  read -s -p "  密码: " SERVER_PASSWORD
  echo ""
  if [ -z "$SERVER_PASSWORD" ]; then
    fail "密码不能为空，已退出"
    exit 1
  fi
fi

# ---------- SSH/SCP 辅助函数（自动填充密码）----------
SSH_BASE="sshpass -p '$SERVER_PASSWORD' ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
SCP_BASE="sshpass -p '$SERVER_PASSWORD' scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"

ssh_remote() {
  eval "$SSH_BASE ${SERVER_USER}@${SERVER_IP} \"$1\""
}

scp_upload() {
  eval "$SCP_BASE $1 ${SERVER_USER}@${SERVER_IP}:$2"
}

# ---------- 检查 sshpass ----------
if ! command -v sshpass &> /dev/null; then
  fail "未找到 sshpass，请先安装："
  echo "  Git Bash + Chocolatey:  choco install sshpass"
  echo "  macOS:                  brew install sshpass"
  echo "  Ubuntu/Debian:          sudo apt install sshpass"
  echo ""
  echo "或者改用 SSH 密钥认证后，设置 SERVER_PASSWORD='' 运行"
  exit 1
fi

echo ""
echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN}  🚀  lcyksp 一键部署 (${SERVER_USER}@${SERVER_IP})${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""

# ===================================================================
#  步骤 1：编译前端
# ===================================================================
info "[1/5] 编译前端 Vue3 项目..."

if [ ! -d "./lcyksp-front" ]; then
  fail "找不到 ./lcyksp-front 目录，请在项目根目录运行"
  exit 1
fi

cd ./lcyksp-front
npm run build
cd ..
ok "前端编译完成 (lcyksp-front/dist)"

# ===================================================================
#  步骤 2：打包（排除敏感数据和依赖）
# ===================================================================
info "[2/5] 打包前后端发布包..."

# Windows Git Bash 下 tar 可能需要正斜杠路径，这里用相对路径
tar --exclude='./lcyksp-backend/node_modules' \
    --exclude='./lcyksp-backend/data' \
    --exclude='./lcyksp-front/node_modules' \
    --exclude='./.git' \
    -czf deploy_pkg.tar.gz \
    ./lcyksp-front/dist \
    ./lcyksp-backend

ok "打包完成: deploy_pkg.tar.gz ($(du -h deploy_pkg.tar.gz | cut -f1))"

# ===================================================================
#  步骤 3：上传到服务器
# ===================================================================
info "[3/5] 上传到服务器 ${SERVER_IP}..."
scp_upload "deploy_pkg.tar.gz" "$REMOTE_BASE/"
ok "上传完成"

# ===================================================================
#  步骤 4：服务器端解压替换
# ===================================================================
info "[4/5] 在服务器上解压并替换文件..."
ssh_remote "cd $REMOTE_BASE && \
  tar -xzf deploy_pkg.tar.gz && \
  rm -rf ${REMOTE_BACKEND}/dist && \
  mv ./lcyksp-front/dist ${REMOTE_BACKEND}/dist && \
  rm -rf ./lcyksp-front deploy_pkg.tar.gz && \
  echo '✅ 解压替换完成'"
ok "文件替换完成"

# ===================================================================
#  步骤 5：安装依赖 + 重启后端
# ===================================================================
info "[5/5] 安装依赖并重启后端服务..."
ssh_remote "cd $REMOTE_BACKEND && \
  npm install --production && \
  (pm2 restart lcyksp-backend || pm2 start src/app.js --name 'lcyksp-backend') && \
  echo '✅ 后端已重启'"
ok "后端服务已重启"

# ===================================================================
#  清理本地临时文件
# ===================================================================
rm deploy_pkg.tar.gz

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  🎉  部署成功！${NC}"
echo -e "${GREEN}  前端: https://lcyksp.xyz${NC}"
echo -e "${GREEN}  API:  https://lcyksp.xyz/api/health${NC}"
echo -e "${GREEN}============================================${NC}"

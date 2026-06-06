# ============================================================
#  lcyksp 全量部署脚本 — PowerShell + PuTTY (plink/pscp)
#  用法:
#     .\deploy.ps1                           # 交互式输入密码
#     $env:SERVER_PASSWORD='密码'; .\deploy.ps1   # 非交互
#
#  前置条件: 安装 PuTTY (plink + pscp)
#     https://www.putty.org/
#     安装后请确保 plink.exe / pscp.exe 在 PATH 中
#     或修改下方 PUTTY_DIR 变量指向 PuTTY 安装目录
# ============================================================

$ErrorActionPreference = "Stop"

# ---------- 服务器配置 ----------
$SERVER_IP = "47.106.101.81"
$SERVER_USER = "admin"
$REMOTE_BASE = "/home/admin/lcyksp-base"
$REMOTE_BACKEND = "$REMOTE_BASE/lcyksp-backend"

# ---------- PuTTY 路径（根据你的安装位置修改）----------
$PUTTY_DIR = "C:\Program Files\PuTTY"
$PLINK = if (Get-Command plink.exe -ErrorAction SilentlyContinue) { "plink.exe" } else { "$PUTTY_DIR\plink.exe" }
$PSCP  = if (Get-Command pscp.exe  -ErrorAction SilentlyContinue) { "pscp.exe" }  else { "$PUTTY_DIR\pscp.exe" }

# ---------- 颜色输出 ----------
function Write-Info  { Write-Host "[INFO]  $args" -ForegroundColor Cyan }
function Write-Ok    { Write-Host "[OK]    $args" -ForegroundColor Green }
function Write-Warn  { Write-Host "[WARN]  $args" -ForegroundColor Yellow }
function Write-Fail  { Write-Host "[FAIL]  $args" -ForegroundColor Red }

# ---------- 密码处理 ----------
$PASSWORD = $env:SERVER_PASSWORD
if (-not $PASSWORD) {
  Write-Host ""
  Write-Warn "请输入服务器密码 ($SERVER_USER@$SERVER_IP)"
  $secure = Read-Host -Prompt "  密码" -AsSecureString
  $BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $PASSWORD = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
  [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR)
  if (-not $PASSWORD) {
    Write-Fail "密码不能为空，已退出"
    exit 1
  }
}

# ---------- 检查 plink / pscp ----------
if (-not (Test-Path $PLINK) -and -not (Get-Command plink -ErrorAction SilentlyContinue)) {
  Write-Fail "未找到 plink.exe，请先安装 PuTTY："
  Write-Host "  1. 下载 https://the.earth.li/~sgtatham/putty/latest/w64/putty.exe"
  Write-Host "  2. 安装后确保 plink.exe / pscp.exe 在 PATH 中"
  Write-Host "  3. 或修改本脚本顶部的 PUTTY_DIR 变量"
  exit 1
}
if (-not (Test-Path $PSCP) -and -not (Get-Command pscp -ErrorAction SilentlyContinue)) {
  Write-Fail "未找到 pscp.exe，请确保 PuTTY 完整安装"
  exit 1
}

$PLINK_EXE = if (Get-Command plink -ErrorAction SilentlyContinue) { "plink" } else { $PLINK }
$PSCP_EXE  = if (Get-Command pscp  -ErrorAction SilentlyContinue) { "pscp" }  else { $PSCP }

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  🚀  lcyksp 一键部署 ($SERVER_USER@$SERVER_IP)" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ===================================================================
#  步骤 1：编译前端
# ===================================================================
Write-Info "[1/5] 编译前端 Vue3 项目..."

if (-not (Test-Path ".\lcyksp-front")) {
  Write-Fail "找不到 .\lcyksp-front 目录，请在项目根目录运行"
  exit 1
}

Push-Location ".\lcyksp-front"
npm run build
Pop-Location
Write-Ok "前端编译完成 (lcyksp-front/dist)"

# ===================================================================
#  步骤 2：打包
# ===================================================================
Write-Info "[2/5] 打包前后端发布包..."

# 在 PowerShell 中调用 Git Bash 的 tar
if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
  Write-Fail "未找到 tar 命令"
  exit 1
}

# 删除旧包
Remove-Item -Force "deploy_pkg.tar.gz" -ErrorAction SilentlyContinue

tar --exclude='./lcyksp-backend/node_modules' `
    --exclude='./lcyksp-backend/data' `
    --exclude='./lcyksp-front/node_modules' `
    --exclude='./.git' `
    -czf deploy_pkg.tar.gz `
    ./lcyksp-front/dist `
    ./lcyksp-backend

$size = (Get-Item "deploy_pkg.tar.gz").Length / 1MB
Write-Ok "打包完成: deploy_pkg.tar.gz ($([math]::Round($size, 1)) MB)"

# ===================================================================
#  步骤 3：上传到服务器 (pscp)
# ===================================================================
Write-Info "[3/5] 上传到服务器 $SERVER_IP ..."
& $PSCP_EXE -pw $PASSWORD -batch -P 22 "deploy_pkg.tar.gz" "${SERVER_USER}@${SERVER_IP}:$REMOTE_BASE/"
if ($LASTEXITCODE -ne 0) { throw "SCP 上传失败" }
Write-Ok "上传完成"

# ===================================================================
#  步骤 4：服务器端解压替换 (plink)
# ===================================================================
Write-Info "[4/5] 在服务器上解压并替换文件..."

$COMMAND = @"
cd $REMOTE_BASE && \
tar -xzf deploy_pkg.tar.gz && \
rm -rf ${REMOTE_BACKEND}/dist && \
mv ./lcyksp-front/dist ${REMOTE_BACKEND}/dist && \
rm -rf ./lcyksp-front deploy_pkg.tar.gz
"@

& $PLINK_EXE -pw $PASSWORD -batch -ssh "${SERVER_USER}@${SERVER_IP}" $COMMAND
if ($LASTEXITCODE -ne 0) { throw "服务器端解压替换失败" }
Write-Ok "文件替换完成"

# ===================================================================
#  步骤 5：安装依赖 + 重启后端
# ===================================================================
Write-Info "[5/5] 安装依赖并重启后端服务..."

$COMMAND2 = @"
cd $REMOTE_BACKEND && \
npm install --production && \
(pm2 restart lcyksp-backend || pm2 start src/app.js --name 'lcyksp-backend')
"@

& $PLINK_EXE -pw $PASSWORD -batch -ssh "${SERVER_USER}@${SERVER_IP}" $COMMAND2
if ($LASTEXITCODE -ne 0) { throw "后端重启失败" }
Write-Ok "后端服务已重启"

# ===================================================================
#  清理
# ===================================================================
Remove-Item -Force "deploy_pkg.tar.gz" -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  🎉  部署成功！" -ForegroundColor Green
Write-Host "  前端: https://lcyksp.xyz" -ForegroundColor Green
Write-Host "  API:  https://lcyksp.xyz/api/health" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green

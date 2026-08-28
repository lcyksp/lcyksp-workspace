# ============================================================
#  lcyksp Full Deployment Script - PowerShell + PuTTY (plink/pscp)
#  Usage:
#     .\deploy.ps1
#     $env:SERVER_PASSWORD='pwd'; .\deploy.ps1
# ============================================================

$ErrorActionPreference = "Stop"

# ---------- Server Config ----------
$SERVER_IP = "47.106.101.81"
$SERVER_USER = "admin"
$REMOTE_BASE = "/home/admin/lcyksp-base"
$REMOTE_BACKEND = "$REMOTE_BASE/lcyksp-backend"

# ---------- PuTTY Path ----------
$PUTTY_DIR = "C:\Program Files\PuTTY"
$PLINK = if (Test-Path ".\plink.exe") { ".\plink.exe" } elseif (Get-Command plink.exe -ErrorAction SilentlyContinue) { "plink.exe" } else { "$PUTTY_DIR\plink.exe" }
$PSCP  = if (Test-Path ".\pscp.exe") { ".\pscp.exe" } elseif (Get-Command pscp.exe -ErrorAction SilentlyContinue) { "pscp.exe" } else { "$PUTTY_DIR\pscp.exe" }

# ---------- Colored Output ----------
function Write-Info  { Write-Host "[INFO]  $args" -ForegroundColor Cyan }
function Write-Ok    { Write-Host "[OK]    $args" -ForegroundColor Green }
function Write-Warn  { Write-Host "[WARN]  $args" -ForegroundColor Yellow }
function Write-Fail  { Write-Host "[FAIL]  $args" -ForegroundColor Red }

# ---------- Password Handling ----------
$PASSWORD = $env:SERVER_PASSWORD
if (-not $PASSWORD) {
  Write-Host ""
  Write-Warn ('Please enter server password (' + $SERVER_USER + '@' + $SERVER_IP + ')')
  $secure = Read-Host -Prompt "  Password" -AsSecureString
  $BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $PASSWORD = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
  [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR)
  if (-not $PASSWORD) {
    Write-Fail "Password cannot be empty, exiting"
    exit 1
  }
}

# ---------- Check plink / pscp ----------
if (-not (Test-Path $PLINK) -and -not (Get-Command plink -ErrorAction SilentlyContinue)) {
  Write-Fail "plink.exe not found, please install PuTTY first:"
  Write-Host "  1. Download https://the.earth.li/~sgtatham/putty/latest/w64/putty.exe"
  Write-Host "  2. Ensure plink.exe / pscp.exe is in PATH after installation"
  Write-Host "  3. Or modify PUTTY_DIR at the top of this script"
  exit 1
}
if (-not (Test-Path $PSCP) -and -not (Get-Command pscp -ErrorAction SilentlyContinue)) {
  Write-Fail "pscp.exe not found, please ensure PuTTY is fully installed"
  exit 1
}

$PLINK_EXE = if (Get-Command plink -ErrorAction SilentlyContinue) { "plink" } else { $PLINK }
$PSCP_EXE  = if (Get-Command pscp  -ErrorAction SilentlyContinue) { "pscp" }  else { $PSCP }

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ('  🚀  lcyksp One-click Deploy (' + $SERVER_USER + '@' + $SERVER_IP + ')') -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ===================================================================
#  Step 1: Build Frontend
# ===================================================================
Write-Info "[1/5] Building frontend Vue3 project..."

if (-not (Test-Path ".\lcyksp-front")) {
  Write-Fail "Cannot find .\lcyksp-front directory, please run in project root"
  exit 1
}

Push-Location ".\lcyksp-front"
npm run build
Pop-Location
Write-Ok "Frontend compilation completed (lcyksp-front/dist)"

# ===================================================================
#  Step 2: Package Release
# ===================================================================
Write-Info "[2/5] Packaging frontend & backend release pkg..."

if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
  Write-Fail "tar command not found"
  exit 1
}

# Remove old package
Remove-Item -Force "deploy_pkg.tar.gz" -ErrorAction SilentlyContinue

tar --exclude='./lcyksp-backend/node_modules' `
    --exclude='./lcyksp-backend/data' `
    --exclude='./lcyksp-front/node_modules' `
    --exclude='./.git' `
    -czf deploy_pkg.tar.gz `
    ./lcyksp-front/dist `
    ./lcyksp-backend

$size = (Get-Item "deploy_pkg.tar.gz").Length / 1MB
Write-Ok "Packaging completed: deploy_pkg.tar.gz ($([math]::Round($size, 1)) MB)"

# ===================================================================
#  Step 3: Upload to Server (pscp)
# ===================================================================
Write-Info "[3/5] Uploading to server $SERVER_IP ..."
& $PSCP_EXE -pw $PASSWORD -batch -hostkey "ssh-ed25519 255 SHA256:FSJ3Y4gBEJ6bhB+niRPUzF0lenxlHl49IM1xSmTlYOY" -P 22 "deploy_pkg.tar.gz" ($SERVER_USER + '@' + $SERVER_IP + ':' + $REMOTE_BASE + '/')
if ($LASTEXITCODE -ne 0) { throw "SCP upload failed" }
Write-Ok "Upload completed"

# ===================================================================
#  Step 4: Extract and Replace on Server (plink)
# ===================================================================
Write-Info "[4/5] Extracting and replacing files on server..."

$COMMAND = 'cd ' + $REMOTE_BASE + ' && tar -xzf deploy_pkg.tar.gz && rm -rf ' + $REMOTE_BACKEND + '/dist && mv ./lcyksp-front/dist ' + $REMOTE_BACKEND + '/dist && rm -rf ./lcyksp-front deploy_pkg.tar.gz'

& $PLINK_EXE -pw $PASSWORD -batch -hostkey "ssh-ed25519 255 SHA256:FSJ3Y4gBEJ6bhB+niRPUzF0lenxlHl49IM1xSmTlYOY" -ssh ($SERVER_USER + '@' + $SERVER_IP) $COMMAND
if ($LASTEXITCODE -ne 0) { throw "Server-side extraction and replacement failed" }
Write-Ok "File replacement completed"

# ===================================================================
#  Step 5: Install Dependencies and Restart Backend
# ===================================================================
Write-Info "[5/5] Installing production dependencies and restarting backend..."

$COMMAND2 = 'cd ' + $REMOTE_BACKEND + ' && npm install --production && (pm2 restart lcyksp-backend || pm2 start src/app.js --name "lcyksp-backend")'

& $PLINK_EXE -pw $PASSWORD -batch -hostkey "ssh-ed25519 255 SHA256:FSJ3Y4gBEJ6bhB+niRPUzF0lenxlHl49IM1xSmTlYOY" -ssh ($SERVER_USER + '@' + $SERVER_IP) $COMMAND2
if ($LASTEXITCODE -ne 0) { throw "Backend restart failed" }
Write-Ok "Backend service restarted successfully"

# ===================================================================
#  Clean up
# ===================================================================
Remove-Item -Force "deploy_pkg.tar.gz" -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  🎉  Deploy successful!" -ForegroundColor Green
Write-Host "  Frontend: https://lcyksp.xyz" -ForegroundColor Green
Write-Host "  API:      https://lcyksp.xyz/api/health" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green

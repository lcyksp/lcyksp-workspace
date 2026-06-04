@echo off
chcp 65001 > nul
title lcyksp dev
cd /d "%~dp0"

:: ============================================================
::   lcyksp.xyz - One-click dual-start script (Windows)
:: ============================================================

echo.
echo ============================================================
echo       lcyksp.xyz  all-in-one dev environment
echo       Backend  - http://localhost:3000
echo       Frontend - http://localhost:5173
echo ============================================================
echo.

:: ---------- 1. Backend ----------
echo =========================== [ Backend ] ===========================
if not exist "lcyksp-backend\node_modules" (
    echo [Backend] Installing dependencies ...
    cd lcyksp-backend
    call npm install
    cd ..
    if errorlevel 1 (
        echo [Backend] npm install failed
        pause
        exit /b 1
    )
    echo [Backend] Dependencies installed.
) else (
    echo [Backend] Dependencies OK.
)
echo.
echo [Backend] Starting Express (port 3000) ...
start "lcyksp-backend" /min cmd /c "cd /d %~dp0lcyksp-backend && npm start && pause"
echo [Backend] Launched.
echo.

timeout /t 2 /nobreak > nul

:: ---------- 2. Frontend ----------
echo =========================== [ Frontend ] ===========================
if not exist "lcyksp-front\node_modules" (
    echo [Frontend] Installing dependencies ...
    cd lcyksp-front
    call npm install
    cd ..
    if errorlevel 1 (
        echo [Frontend] npm install failed
        pause
        exit /b 1
    )
    echo [Frontend] Dependencies installed.
) else (
    echo [Frontend] Dependencies OK.
)
echo.
echo [Frontend] Starting Vite (port 5173) ...
start "lcyksp-front" /min cmd /c "cd /d %~dp0lcyksp-front && npm run dev && pause"
echo [Frontend] Launched.
echo.

:: ---------- 3. Done ----------
echo ============================================================
echo   All services started!
echo   Backend  - http://localhost:3000
echo   Frontend - http://localhost:5173
echo   Close the corresponding window to stop.
echo ============================================================
echo.

pause
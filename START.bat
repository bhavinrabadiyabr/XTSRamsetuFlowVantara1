@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "BACKEND_DIR=%~dp0backend"
set "FRONTEND_DIR=%~dp0artifacts\sonOfWind-dashboard"

if not exist "%BACKEND_DIR%\app.py" (
  echo Backend not found: "%BACKEND_DIR%\app.py"
  pause
  exit /b 1
)
if not exist "%FRONTEND_DIR%\package.json" (
  echo Frontend not found: "%FRONTEND_DIR%\package.json"
  pause
  exit /b 1
)

echo Starting SonOfWind backend and frontend...

if not exist "%FRONTEND_DIR%\node_modules\vite\package.json" (
  echo Installing frontend dependencies with pnpm...
  pushd "%~dp0"
  call pnpm install
  if errorlevel 1 (
    echo pnpm install failed.
    popd
    pause
    exit /b 1
  )
  popd
)

netstat -ano | findstr /C:":5000 " | findstr "LISTENING" >nul
if errorlevel 1 (
  start "SonOfWind Backend" /D "%BACKEND_DIR%" cmd /k "echo Backend: python app.py & python app.py"
) else (
  echo Backend already running on port 5000.
)

netstat -ano | findstr /C:":5174 " | findstr "LISTENING" >nul
if errorlevel 1 (
  start "SonOfWind Frontend" /D "%FRONTEND_DIR%" cmd /k "echo Frontend: pnpm run dev & pnpm run dev"
) else (
  echo Frontend already running on port 5174.
)

echo.
echo Dashboard: http://localhost:5174/
start "" "http://localhost:5174/"
echo.
pause


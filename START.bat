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

start "SonOfWind Backend" /D "%BACKEND_DIR%" powershell -NoExit -Command "Write-Host 'Backend: python app.py' -ForegroundColor Cyan; python .\app.py"
start "SonOfWind Frontend" /D "%FRONTEND_DIR%" powershell -NoExit -Command "Write-Host 'Frontend: npm run dev' -ForegroundColor Green; npm run dev"

exit /b 0

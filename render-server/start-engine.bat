@echo off
chcp 65001 >nul
title YOHU - May dung video
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Chua cai Node.js. Hay cai ban LTS tai https://nodejs.org roi chay lai file nay.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Dang cai dat lan dau, vui long cho vai phut...
  call npm install --omit=dev
  if errorlevel 1 (
    echo Cai dat that bai. Kiem tra ket noi mang roi chay lai.
    pause
    exit /b 1
  )
)
call npm start
pause

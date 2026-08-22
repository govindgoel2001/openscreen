@echo off
title OpenScreen
cd /d "%~dp0"
if not exist "node_modules\.bin\vite.cmd" (
  echo Installing dependencies for the first time...
  call npm install
)
echo Starting OpenScreen... (keep this window open while using the app)
call npm run dev

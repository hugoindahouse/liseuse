@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installation des dependances...
  set NODE_OPTIONS=--use-system-ca
  call npm install
  set NODE_OPTIONS=
)
call npm start
pause

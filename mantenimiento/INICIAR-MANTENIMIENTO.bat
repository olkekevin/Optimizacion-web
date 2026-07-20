@echo off
title Mantenimiento HappyBuy
cd /d "%~dp0"
start "" http://localhost:3010
node server.js
pause

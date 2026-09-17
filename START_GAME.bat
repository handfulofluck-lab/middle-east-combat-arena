@echo off
REM MCA - Middle East Combat Arena launcher
cd /d "%~dp0client"
start "" "http://127.0.0.1:8123/index.html"
python -m http.server 8123 --bind 127.0.0.1
pause

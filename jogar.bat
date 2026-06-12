@echo off
cd /d "%~dp0"
echo Iniciando RIO MOST WANTED - Linha Amarela...
start "" http://localhost:8123/index.html
python -m http.server 8123

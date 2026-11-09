@echo off
REM Chạy server AI trên Windows: nhấp đúp file này.
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Khong tim thay python. Hay cai Python 3.10 - 3.12 tu python.org
  pause
  exit /b 1
)

if not exist ".venv" (
  echo Dang tao moi truong ao...
  python -m venv .venv
  call .venv\Scripts\activate.bat
  python -m pip install -q --upgrade pip
  python -m pip install -q -r requirements.txt
) else (
  call .venv\Scripts\activate.bat
)

python app.py %*
pause

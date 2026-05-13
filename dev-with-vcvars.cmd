@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 (
  echo vcvars64 failed with errorlevel %errorlevel%
  exit /b 1
)
set PATH=%USERPROFILE%\.cargo\bin;%PATH%
cd /d "C:\Users\geefa\Documents\veesker-project\cl"
bun run tauri dev

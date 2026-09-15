@echo off
setlocal EnableExtensions
cd /d "%~dp0"
call "%~dp0runtime-env.bat"

echo.
echo ========================================
echo   Starting Codex Usage Analytics
echo ========================================
echo.

if not exist "node_modules\.modules.yaml" (
  echo [INFO] Project dependencies are not installed yet.
  call "%~dp0setup.bat"
  if errorlevel 1 exit /b 1
)

where pnpm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] pnpm was not found. Run setup.bat first.
  pause
  exit /b 1
)

where cargo.exe >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
    set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
  ) else (
    echo [ERROR] Rust was not found. Run setup.bat first.
    pause
    exit /b 1
  )
)

where link.exe >nul 2>nul
if errorlevel 1 call :load_msvc
where link.exe >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Microsoft C++ Build Tools were not found.
  echo Install the "Desktop development with C++" workload, then try again.
  pause
  exit /b 1
)

echo [INFO] The app will scan your configured Codex sources.
echo [INFO] Keep this window open while developing.
echo.

set "RUST_BACKTRACE=1"
call pnpm tauri dev
set "APP_EXIT_CODE=%ERRORLEVEL%"

if not "%APP_EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] The desktop app stopped with exit code %APP_EXIT_CODE%.
  echo If this mentions link.exe, MSVC, or WebView2, run setup.bat and follow its prerequisite links.
  pause
)

exit /b %APP_EXIT_CODE%

:load_msvc
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" exit /b 0
set "VS_PATH="
for /f "usebackq tokens=*" %%I in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VS_PATH=%%I"
if defined VS_PATH if exist "%VS_PATH%\Common7\Tools\VsDevCmd.bat" call "%VS_PATH%\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64 >nul
exit /b 0

@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
call "%~dp0runtime-env.bat"

echo.
echo ========================================
echo   Codex Usage Analytics - Setup
echo ========================================
echo.

where node.exe >nul 2>nul
if errorlevel 1 (
  echo [INFO] Node.js was not found. Downloading the official Node 22 LTS portable ZIP...
  call :install_node
  if errorlevel 1 goto :node_failed
  call "%~dp0runtime-env.bat"
)

for /f "tokens=*" %%M in ('node -p "Number(process.versions.node.split('.')[0])"') do set "NODE_MAJOR=%%M"
if %NODE_MAJOR% LSS 20 (
  echo [ERROR] Node.js 20 or newer is required, but version %NODE_MAJOR% was found.
  echo Remove the old project runtime folder and run setup.bat again.
  goto :failed
)
for /f "tokens=*" %%V in ('node --version') do echo [OK] Node.js %%V

where pnpm.cmd >nul 2>nul
if errorlevel 1 (
  echo [INFO] pnpm was not found. Installing it inside this project...
  if not exist "%~dp0work\runtime\pnpm" mkdir "%~dp0work\runtime\pnpm"
  call npm.cmd install --global pnpm@11 --prefix "%~dp0work\runtime\pnpm"
  if errorlevel 1 goto :pnpm_failed
  call "%~dp0runtime-env.bat"
)

for /f "tokens=*" %%V in ('pnpm --version') do echo [OK] pnpm %%V

where cargo.exe >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
    set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
  ) else (
    echo [INFO] Rust was not found. Downloading official rustup...
    if exist "%TEMP%\rustup-init.exe" del /f /q "%TEMP%\rustup-init.exe"
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile('https://win.rustup.rs/x86_64', '%TEMP%\rustup-init.exe')"
    if errorlevel 1 goto :rust_failed
    "%TEMP%\rustup-init.exe" -y --profile minimal
    if errorlevel 1 goto :rust_failed
    set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
  )
)

for /f "tokens=*" %%V in ('cargo --version') do echo [OK] %%V

echo.
echo [INFO] Installing project dependencies...
set "CI=true"
call pnpm install --frozen-lockfile
if errorlevel 1 goto :deps_failed

echo.
echo [INFO] Checking the frontend production build...
call pnpm build
if errorlevel 1 goto :build_failed

echo.
echo ========================================
echo   Setup completed successfully.
echo ========================================
echo.
echo Run build.bat once, then open CodexUsageAnalytics.exe from outputs.
echo start.bat is for development and keeps a command window open.
echo.
echo If Tauri reports a linker or WebView error, install:
echo - Microsoft C++ Build Tools (Desktop development with C++)
echo   https://visualstudio.microsoft.com/visual-cpp-build-tools/
echo - Microsoft Edge WebView2 Runtime
echo   https://developer.microsoft.com/microsoft-edge/webview2/
echo.
pause
exit /b 0

:pnpm_failed
echo [ERROR] Could not install pnpm.
goto :failed

:node_failed
echo [ERROR] Could not download or verify the official Node.js portable ZIP.
echo Check the network connection and run setup.bat again.
goto :failed

:rust_failed
echo [ERROR] Could not install Rust automatically.
echo Install it manually from https://rustup.rs/ and run setup.bat again.
goto :failed

:deps_failed
echo [ERROR] pnpm install failed. Check the network output above.
goto :failed

:build_failed
echo [ERROR] The frontend build failed. Check the compiler output above.
goto :failed

:failed
echo.
echo Setup did not complete.
pause
exit /b 1

:install_node
set "NODE_VERSION=22.23.2"
set "NODE_ARCHIVE=node-v%NODE_VERSION%-win-x64.zip"
set "NODE_URL=https://nodejs.org/dist/v%NODE_VERSION%/%NODE_ARCHIVE%"
set "NODE_ZIP=%~dp0work\runtime\%NODE_ARCHIVE%"
set "NODE_SHA256=1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97"

if not exist "%~dp0work\runtime" mkdir "%~dp0work\runtime"
if exist "%NODE_ZIP%" del /f /q "%NODE_ZIP%"

where curl.exe >nul 2>nul
if not errorlevel 1 curl.exe --ssl-no-revoke --fail --location --retry 3 "%NODE_URL%" --output "%NODE_ZIP%"

if not exist "%NODE_ZIP%" (
  echo [WARN] curl download failed. Trying Windows BITS...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Start-BitsTransfer -Source '%NODE_URL%' -Destination '%NODE_ZIP%'"
)

if not exist "%NODE_ZIP%" (
  echo [WARN] BITS download failed. Trying PowerShell WebClient...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile('%NODE_URL%', '%NODE_ZIP%')"
)

if not exist "%NODE_ZIP%" exit /b 1

set "DOWNLOADED_SHA="
for /f "tokens=*" %%H in ('powershell.exe -NoProfile -Command "(Get-FileHash -Algorithm SHA256 -LiteralPath '%NODE_ZIP%').Hash.ToLowerInvariant()"') do set "DOWNLOADED_SHA=%%H"
if /i not "!DOWNLOADED_SHA!"=="%NODE_SHA256%" (
  echo [ERROR] Node archive SHA-256 verification failed.
  del /f /q "%NODE_ZIP%"
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath '%NODE_ZIP%' -DestinationPath '%~dp0work\runtime' -Force"
if errorlevel 1 exit /b 1
del /f /q "%NODE_ZIP%"
exit /b 0

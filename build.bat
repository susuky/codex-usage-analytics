@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
call "%~dp0runtime-env.bat"

echo.
echo ========================================
echo   Building Codex Usage Analytics
echo ========================================
echo.

if not exist "node_modules\.modules.yaml" (
  echo [INFO] Project dependencies are missing. Running setup first...
  call "%~dp0setup.bat"
  if errorlevel 1 exit /b 1
)

where pnpm.cmd >nul 2>nul
if errorlevel 1 goto :missing_tools

where cargo.exe >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
    set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
  ) else (
    goto :missing_tools
  )
)

where link.exe >nul 2>nul
if errorlevel 1 call :load_msvc
where link.exe >nul 2>nul
if errorlevel 1 goto :missing_msvc

echo [INFO] Building the release executable and NSIS installer...
if not exist "%CARGO_TARGET_DIR%" mkdir "%CARGO_TARGET_DIR%"
echo [INFO] Cargo output: %CARGO_TARGET_DIR%
set "STAGE_DIR=%TEMP%\CodexUsageAnalytics-build-!RANDOM!!RANDOM!"
set "SOURCE_DIR=%~dp0"
set "SOURCE_DIR=!SOURCE_DIR:~0,-1!"
set "CODEX_USAGE_ENV_DIR=!SOURCE_DIR!"
echo [INFO] Staging source outside the protected Documents folder...
mkdir "%STAGE_DIR%"
robocopy "!SOURCE_DIR!" "%STAGE_DIR%" /E /NFL /NDL /NJH /NJS /NP /XD node_modules .pnpm-store work outputs .git target test-results playwright-report /XF ".env" ".env.local" >nul
set "ROBOCOPY_EXIT=!ERRORLEVEL!"
if !ROBOCOPY_EXIT! GEQ 8 (
  echo [ERROR] robocopy exit code: !ROBOCOPY_EXIT!
  goto :stage_failed
)

pushd "%STAGE_DIR%"
echo [INFO] Restoring staged Node dependencies from the local pnpm cache...
call pnpm install --offline --frozen-lockfile
if errorlevel 1 (
  popd
  goto :stage_failed
)

call pnpm tauri build --bundles nsis
set "TAURI_BUILD_EXIT=!ERRORLEVEL!"
popd
if not "!TAURI_BUILD_EXIT!"=="0" goto :build_failed

for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -Command "(Get-Content -Raw -LiteralPath '%~dp0package.json' | ConvertFrom-Json).version"`) do set "APP_VERSION=%%V"
if not defined APP_VERSION set "APP_VERSION=unknown"
if defined CODEX_USAGE_OUTPUT_DIR (
  set "OUTPUT_DIR=!CODEX_USAGE_OUTPUT_DIR!"
) else (
  set "OUTPUT_DIR=%~dp0outputs\v!APP_VERSION!"
  if exist "!OUTPUT_DIR!\CodexUsageAnalytics.exe" set "OUTPUT_DIR=%~dp0outputs\v!APP_VERSION!-build-!RANDOM!!RANDOM!"
)
set "PORTABLE_DIR=%TEMP%\CodexUsageAnalytics-portable-v!APP_VERSION!-!RANDOM!!RANDOM!"
set "RAW_EXE=%CARGO_TARGET_DIR%\release\codex-usage-analytics.exe"

if not exist "!RAW_EXE!" (
  echo [ERROR] Tauri finished, but the release executable was not found:
  echo !RAW_EXE!
  goto :failed
)

set "PACKAGE_POWERSHELL=powershell.exe"
where pwsh.exe >nul 2>nul && set "PACKAGE_POWERSHELL=pwsh.exe"
"!PACKAGE_POWERSHELL!" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\package-windows.ps1" -OutputDir "!OUTPUT_DIR!" -PortableDir "!PORTABLE_DIR!" -RawExe "!RAW_EXE!" -NsisDir "%CARGO_TARGET_DIR%\release\bundle\nsis" -AppVersion "!APP_VERSION!" -ProjectDir "!SOURCE_DIR!"
if errorlevel 1 goto :portable_failed
set "INSTALLER_FOUND=1"

echo.
echo ========================================
echo   Build completed successfully.
echo ========================================
echo.
echo Output files:
if defined INSTALLER_FOUND echo   !OUTPUT_DIR!\CodexUsageAnalytics-Setup.exe
echo   !OUTPUT_DIR!\CodexUsageAnalytics.exe
echo   !OUTPUT_DIR!\CodexUsageAnalytics-Portable.zip
echo.
echo These files are unsigned. Windows SmartScreen may show a warning.
echo.
pause
exit /b 0

:load_msvc
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" exit /b 0
set "VS_PATH="
for /f "usebackq tokens=*" %%I in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VS_PATH=%%I"
if defined VS_PATH if exist "!VS_PATH!\Common7\Tools\VsDevCmd.bat" call "!VS_PATH!\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64 >nul
exit /b 0

:missing_tools
echo [ERROR] pnpm or Rust was not found. Run setup.bat first.
goto :failed

:missing_msvc
echo [ERROR] Microsoft C++ Build Tools were not found.
echo Install "Desktop development with C++" from:
echo https://visualstudio.microsoft.com/visual-cpp-build-tools/
goto :failed

:build_failed
echo [ERROR] Tauri release build failed. Review the output above.
goto :failed

:stage_failed
echo [ERROR] Could not create the temporary build workspace:
echo %STAGE_DIR%
goto :failed

:portable_failed
echo [ERROR] The EXE was built, but creating the portable ZIP failed.
goto :failed

:failed
echo.
echo Build did not complete.
pause
exit /b 1

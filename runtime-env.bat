@echo off
rem Shared project-local runtime discovery. Intentionally does not use setlocal.
set "CODEX_USAGE_RUNTIME=%~dp0work\runtime"
set "CODEX_USAGE_NODE="
set "pnpm_config_store_dir=%~dp0work\pnpm-store"
if exist "%~dp0.pnpm-store" set "pnpm_config_store_dir=%~dp0.pnpm-store"
set "CARGO_TARGET_DIR=%TEMP%\CodexUsageAnalytics-cargo-target"
set "CARGO_BUILD_JOBS=1"

for /d %%D in ("%CODEX_USAGE_RUNTIME%\node-v*-win-x64") do set "CODEX_USAGE_NODE=%%~fD"
if not defined CODEX_USAGE_NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "CODEX_USAGE_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin"
if defined CODEX_USAGE_NODE set "PATH=%CODEX_USAGE_NODE%;%PATH%"

if exist "%CODEX_USAGE_RUNTIME%\pnpm\pnpm.cmd" set "PATH=%CODEX_USAGE_RUNTIME%\pnpm;%PATH%"
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd" set "PATH=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback;%PATH%"

if exist "%~dp0work\rustup\toolchains\stable-x86_64-pc-windows-msvc\bin\cargo.exe" (
  set "RUSTUP_HOME=%~dp0work\rustup"
  set "CARGO_HOME=%~dp0work\cargo"
  set "PATH=%~dp0work\cargo\bin;%~dp0work\rustup\toolchains\stable-x86_64-pc-windows-msvc\bin;%PATH%"
)

param(
  [Parameter(Mandatory = $true)][string]$OutputDir,
  [Parameter(Mandatory = $true)][string]$PortableDir,
  [Parameter(Mandatory = $true)][string]$RawExe,
  [Parameter(Mandatory = $true)][string]$NsisDir,
  [Parameter(Mandatory = $true)][string]$AppVersion,
  [Parameter(Mandatory = $true)][string]$ProjectDir
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $RawExe -PathType Leaf)) {
  throw "Release executable was not found: $RawExe"
}

$installer = Get-ChildItem -LiteralPath $NsisDir -Filter '*.exe' |
  Where-Object Name -Like "*_${AppVersion}_*-setup.exe" |
  Select-Object -First 1
if (-not $installer) {
  throw "NSIS installer for version $AppVersion was not found in $NsisDir"
}

[System.IO.Directory]::CreateDirectory($OutputDir) | Out-Null
[System.IO.Directory]::CreateDirectory($PortableDir) | Out-Null
if (-not (Test-Path -LiteralPath $OutputDir -PathType Container)) {
  throw "Could not create output directory: $OutputDir"
}
if (-not (Test-Path -LiteralPath $PortableDir -PathType Container)) {
  throw "Could not create portable staging directory: $PortableDir"
}

Copy-Item -LiteralPath $RawExe -Destination (Join-Path $OutputDir 'CodexUsageAnalytics.exe')
Copy-Item -LiteralPath $installer.FullName -Destination (Join-Path $OutputDir 'CodexUsageAnalytics-Setup.exe')
Copy-Item -LiteralPath $RawExe -Destination (Join-Path $PortableDir 'CodexUsageAnalytics.exe')
Copy-Item -LiteralPath (Join-Path $ProjectDir 'PORTABLE_README.txt') -Destination (Join-Path $PortableDir 'README.txt')

$zip = Join-Path $OutputDir 'CodexUsageAnalytics-Portable.zip'
Compress-Archive -Path (Join-Path $PortableDir '*') -DestinationPath $zip -CompressionLevel Optimal

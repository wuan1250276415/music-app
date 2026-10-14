$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Visual Studio Build Tools not found.' }
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw 'Visual Studio C++ tools not found.' }
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
$build = Join-Path $project 'build'
New-Item -ItemType Directory -Force $build | Out-Null
$source = Join-Path $project 'main.cpp'
$output = Join-Path $build 'asio-probe.exe'
$command = '"' + $vcvars + '" >nul && cl /nologo /EHsc /O2 /MT /std:c++17 /utf-8 "' + $source + '" /Fe:"' + $output + '" /link /SUBSYSTEM:CONSOLE ole32.lib advapi32.lib user32.lib'
Push-Location $build
try {
  & cmd.exe /c $command
  if ($LASTEXITCODE -ne 0) { throw "ASIO probe build failed with exit code $LASTEXITCODE" }
  Write-Host "Built $output"
} finally { Pop-Location }

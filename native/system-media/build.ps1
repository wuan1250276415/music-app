$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw 'Visual Studio C++ tools not found.' }
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
$build = Join-Path $project 'build'
New-Item -ItemType Directory -Force $build | Out-Null
$source = Join-Path $project 'main.cpp'
$output = Join-Path $build 'system-media.exe'
$resource = Join-Path $project 'version.rc'
$compiledResource = Join-Path $build 'version.res'
$command = '"' + $vcvars + '" >nul && rc /nologo /fo"' + $compiledResource + '" "' + $resource + '" && cl /nologo /EHsc /O2 /MT /std:c++17 /utf-8 "' + $source + '" "' + $compiledResource + '" /Fe:"' + $output + '" /link /SUBSYSTEM:CONSOLE RuntimeObject.lib user32.lib shell32.lib shlwapi.lib shcore.lib crypt32.lib ole32.lib'
Push-Location $build
try {
  & cmd.exe /c $command
  if ($LASTEXITCODE -ne 0) { throw "System media build failed with exit code $LASTEXITCODE" }
  Write-Host "Built $output (not executed)"
} finally { Pop-Location }

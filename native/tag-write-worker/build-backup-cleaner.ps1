$ErrorActionPreference = 'Stop'
$cleanupProject = Split-Path -Parent $MyInvocation.MyCommand.Path
$cleanupVswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
$cleanupVs = & $cleanupVswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $cleanupVs) { throw 'Visual Studio C++ tools not found.' }
$cleanupVcvars = Join-Path $cleanupVs 'VC\Auxiliary\Build\vcvars64.bat'
$cleanupBuild = Join-Path $cleanupProject 'build'
New-Item -ItemType Directory -Force $cleanupBuild | Out-Null
$cleanupSource = Join-Path $cleanupProject 'backup-cleaner.cpp'
$cleanupOutput = Join-Path $cleanupBuild 'tag-backup-cleaner.exe'
$cleanupCommand = '"' + $cleanupVcvars + '" >nul && cl /nologo /EHsc /O2 /MT /std:c++17 /utf-8 "' + $cleanupSource + '" /Fe:"' + $cleanupOutput + '" /link bcrypt.lib advapi32.lib /SUBSYSTEM:CONSOLE'
Push-Location $cleanupBuild
try {
 & cmd.exe /c $cleanupCommand
 if ($LASTEXITCODE -ne 0) { throw "Backup cleanup component build failed with exit code $LASTEXITCODE" }
 Write-Host "Built $cleanupOutput (not executed by build; runtime requires durable cleanup decisions)"
} finally { Pop-Location }

$ErrorActionPreference = 'Stop'
$credentialProject = Split-Path -Parent $MyInvocation.MyCommand.Path
$credentialVswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $credentialVswhere)) { throw 'Visual Studio Build Tools not found.' }
$credentialVs = & $credentialVswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $credentialVs) { throw 'Visual Studio C++ tools not found.' }
$credentialVcvars = Join-Path $credentialVs 'VC\Auxiliary\Build\vcvars64.bat'
$credentialBuild = Join-Path $credentialProject 'build'
New-Item -ItemType Directory -Force $credentialBuild | Out-Null
$credentialSource = Join-Path $credentialProject 'main.cpp'
$credentialOutput = Join-Path $credentialBuild 'credential-vault.exe'
$credentialCommand = '"' + $credentialVcvars + '" >nul && cl /nologo /EHsc /O2 /MT /std:c++17 /utf-8 "' + $credentialSource + '" /Fe:"' + $credentialOutput + '" /link /SUBSYSTEM:CONSOLE advapi32.lib'
Push-Location $credentialBuild
try {
  & cmd.exe /c $credentialCommand
  if ($LASTEXITCODE -ne 0) { throw "Credential vault build failed with exit code $LASTEXITCODE" }
  Write-Host "Built $credentialOutput"
} finally { Pop-Location }

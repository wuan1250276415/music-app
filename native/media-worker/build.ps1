$ErrorActionPreference = 'Stop'
$mediaProject = Split-Path -Parent $MyInvocation.MyCommand.Path
$mediaVswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
$mediaVs = & $mediaVswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $mediaVs) { throw 'Visual Studio C++ tools not found.' }
$mediaVcvars = Join-Path $mediaVs 'VC\Auxiliary\Build\vcvars64.bat'
$mediaBuild = Join-Path $mediaProject 'build'
$mediaWebp = Join-Path (Split-Path -Parent $mediaProject) 'webp'
& (Join-Path $mediaWebp 'build.ps1')
$mediaWebpLock = Get-Content (Join-Path $mediaWebp 'lock.json') -Raw | ConvertFrom-Json
$mediaWebpInclude = Join-Path $mediaWebp ('build\' + $mediaWebpLock.sourceDirectory + '\src')
$mediaWebpDecoder = Join-Path $mediaWebp 'build\obj\release-static\x64\lib\libwebpdecoder.lib'
$mediaWebpDemux = Join-Path $mediaWebp 'build\obj\release-static\x64\lib\libwebpdemux.lib'
New-Item -ItemType Directory -Force $mediaBuild | Out-Null
$mediaSource = Join-Path $mediaProject 'main.cpp'
$mediaArtwork = Join-Path $mediaProject 'artwork.cpp'
$mediaOutput = Join-Path $mediaBuild 'media-worker.exe'
$mediaCommand = '"' + $mediaVcvars + '" >nul && cl /nologo /EHsc /O2 /MT /std:c++17 /utf-8 /I"' + $mediaWebpInclude + '" "' + $mediaSource + '" "' + $mediaArtwork + '" /Fe:"' + $mediaOutput + '" /link /SUBSYSTEM:CONSOLE "' + $mediaWebpDecoder + '" "' + $mediaWebpDemux + '" windowscodecs.lib ole32.lib oleaut32.lib'
Push-Location $mediaBuild
try {
  & cmd.exe /c $mediaCommand
  if ($LASTEXITCODE -ne 0) { throw "Media supervisor build failed with exit code $LASTEXITCODE" }
  Write-Host "Built $mediaOutput"
} finally { Pop-Location }

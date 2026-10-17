$ErrorActionPreference='Stop'
$sequenceProject=Split-Path -Parent $MyInvocation.MyCommand.Path
$sequenceInstall=(Resolve-Path (Join-Path $sequenceProject '../ffmpeg/build/install')).Path
$sequenceVs=& 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe' -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if(-not $sequenceVs){throw 'Visual Studio Build Tools not found'}
$sequenceVcvars=Join-Path $sequenceVs 'VC\Auxiliary\Build\vcvars64.bat'
$sequenceBuild=Join-Path $sequenceProject 'build'
New-Item -ItemType Directory -Force $sequenceBuild | Out-Null
$sequenceSource=Join-Path $sequenceProject 'pcm-sequence-gold.cpp'
$sequenceOutput=Join-Path $sequenceBuild 'pcm-sequence-gold.exe'
$sequenceCommand='"'+$sequenceVcvars+'" >nul && cl /nologo /EHsc /O2 /MT /std:c++17 /utf-8 /I"'+$sequenceInstall+'\include" "'+$sequenceSource+'" /Fe:"'+$sequenceOutput+'" /link bcrypt.lib delayimp.lib /LIBPATH:"'+$sequenceInstall+'\bin" avformat.lib avcodec.lib avutil.lib swresample.lib /DELAYLOAD:avformat-62.dll /DELAYLOAD:avcodec-62.dll /DELAYLOAD:avutil-60.dll /DELAYLOAD:swresample-6.dll'
Push-Location $sequenceBuild
try{& cmd.exe /c $sequenceCommand;if($LASTEXITCODE -ne 0){throw 'PCM sequence gold build failed'};Write-Host "Built $sequenceOutput (producer software core only; no audio device opened)"}finally{Pop-Location}

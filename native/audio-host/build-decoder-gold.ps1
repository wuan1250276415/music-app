$ErrorActionPreference='Stop'
$decoderProject=Split-Path -Parent $MyInvocation.MyCommand.Path
$decoderInstall=(Resolve-Path (Join-Path $decoderProject '../ffmpeg/build/install')).Path
$decoderVs=& 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe' -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if(-not $decoderVs){throw 'Visual Studio Build Tools not found'}
$decoderVcvars=Join-Path $decoderVs 'VC\Auxiliary\Build\vcvars64.bat'
$decoderBuild=Join-Path $decoderProject 'build'
New-Item -ItemType Directory -Force $decoderBuild | Out-Null
$decoderSource=Join-Path $decoderProject 'decoder-gold.cpp'
$decoderOutput=Join-Path $decoderBuild 'decoder-gold.exe'
$decoderCommand='"'+$decoderVcvars+'" >nul && cl /nologo /EHsc /O2 /MT /std:c++17 /utf-8 /I"'+$decoderInstall+'\include" "'+$decoderSource+'" /Fe:"'+$decoderOutput+'" /link bcrypt.lib delayimp.lib /LIBPATH:"'+$decoderInstall+'\bin" avformat.lib avcodec.lib avutil.lib swresample.lib /DELAYLOAD:avformat-62.dll /DELAYLOAD:avcodec-62.dll /DELAYLOAD:avutil-60.dll /DELAYLOAD:swresample-6.dll'
Push-Location $decoderBuild
try{& cmd.exe /c $decoderCommand;if($LASTEXITCODE -ne 0){throw 'Decoder gold build failed'};Write-Host "Built $decoderOutput (software decode only; not executed by build)"}finally{Pop-Location}

$ErrorActionPreference='Stop'
$fingerprintHost=Split-Path -Parent $MyInvocation.MyCommand.Path
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $fingerprintHost '../chromaprint/build.ps1')
if($LASTEXITCODE -ne 0){throw 'Chromaprint library is unavailable'}
$fingerprintInstall=(Resolve-Path (Join-Path $fingerprintHost '../chromaprint/build/install')).Path
$fingerprintFfmpeg=(Resolve-Path (Join-Path $fingerprintHost '../ffmpeg/build/install')).Path
$fingerprintVs=& 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe' -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if(-not $fingerprintVs){throw 'Visual Studio C++ tools are required'}
$fingerprintVars=Join-Path $fingerprintVs 'VC/Auxiliary/Build/vcvars64.bat'
$fingerprintBuild=Join-Path $fingerprintHost 'build'
New-Item -ItemType Directory -Force -Path $fingerprintBuild | Out-Null
$fingerprintSource=Join-Path $fingerprintHost 'fingerprint.cpp'
$fingerprintOutput=Join-Path $fingerprintBuild 'fingerprint-worker.exe'
$fingerprintCommand='"'+$fingerprintVars+'" >nul && cl /nologo /EHsc /O2 /MT /std:c++17 /utf-8 /DCHROMAPRINT_NODLL /I"'+$fingerprintInstall+'\include" /I"'+$fingerprintFfmpeg+'\include" "'+$fingerprintSource+'" /Fe:"'+$fingerprintOutput+'" /link /SUBSYSTEM:CONSOLE bcrypt.lib delayimp.lib "'+$fingerprintInstall+'\lib\chromaprint.lib" /LIBPATH:"'+$fingerprintFfmpeg+'\bin" avformat.lib avcodec.lib avutil.lib swresample.lib /DELAYLOAD:avformat-62.dll /DELAYLOAD:avcodec-62.dll /DELAYLOAD:avutil-60.dll /DELAYLOAD:swresample-6.dll'
Push-Location $fingerprintBuild
try{& cmd.exe /c $fingerprintCommand;if($LASTEXITCODE -ne 0){throw 'Fingerprint helper build failed'}}finally{Pop-Location}

$ErrorActionPreference='Stop'
$fingerprintProject=Split-Path -Parent $MyInvocation.MyCommand.Path
& python (Join-Path $fingerprintProject 'prepare.py')
if($LASTEXITCODE -ne 0){throw 'Chromaprint source preparation failed'}
$fingerprintVs=& 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe' -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if(-not $fingerprintVs){throw 'Visual Studio C++ tools are required'}
$fingerprintCmake=Join-Path $fingerprintVs 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'
if(-not (Test-Path -LiteralPath $fingerprintCmake)){$fingerprintCmake=(Get-Command cmake -ErrorAction Stop).Source}
$fingerprintVars=Join-Path $fingerprintVs 'VC/Auxiliary/Build/vcvars64.bat'
$fingerprintBuild=Join-Path $fingerprintProject 'build/cmake'
$fingerprintSource=Join-Path $fingerprintProject 'build/chromaprint-1.6.1'
$fingerprintInstall=Join-Path $fingerprintProject 'build/install'
New-Item -ItemType Directory -Force -Path $fingerprintBuild | Out-Null
$fingerprintCommand='"'+$fingerprintVars+'" >nul && "'+$fingerprintCmake+'" -G "NMake Makefiles" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DBUILD_TOOLS=OFF -DBUILD_TESTS=OFF -DFFT_LIB=kissfft -DUSE_INTERNAL_AVRESAMPLE=ON "-DCMAKE_C_FLAGS_RELEASE=/MT /O2 /DNDEBUG" "-DCMAKE_CXX_FLAGS_RELEASE=/MT /O2 /DNDEBUG" "-DCMAKE_INSTALL_PREFIX='+$fingerprintInstall+'" "'+$fingerprintSource+'" && "'+$fingerprintCmake+'" --build . --target install'
Push-Location $fingerprintBuild
try{& cmd.exe /c $fingerprintCommand;if($LASTEXITCODE -ne 0){throw 'Chromaprint static library build failed'}}finally{Pop-Location}

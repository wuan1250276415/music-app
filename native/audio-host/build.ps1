$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$ffmpeg = Join-Path $project '../ffmpeg'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ffmpeg 'build.ps1')
if ($LASTEXITCODE -ne 0) { throw 'FFmpeg libraries are unavailable' }
$ffmpegInstall = (Resolve-Path (Join-Path $ffmpeg 'build/install')).Path
$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Visual Studio Build Tools not found.' }
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw 'Visual Studio C++ tools not found.' }
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
$build = Join-Path $project 'build'
New-Item -ItemType Directory -Force $build | Out-Null
function Get-AudioBuildInputs {
 $audioInputs=[ordered]@{}
 Get-ChildItem -LiteralPath $project -File -Recurse | Where-Object { $_.FullName -notlike ($build+'\*') -and $_.Extension -in @('.cpp','.hpp','.h','.ps1') } | Sort-Object FullName | ForEach-Object { $audioRelative='native/audio-host/'+$_.FullName.Substring($project.Length+1).Replace('\','/');$audioInputs[$audioRelative]=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
 return $audioInputs
}
$audioBuildBefore=Get-AudioBuildInputs
$source = Join-Path $project 'main.cpp'
$output = Join-Path $build 'audio-host.exe'
$capabilitiesSource = Join-Path $project 'device-capabilities.cpp'
$notificationsSource = Join-Path $project 'device-notifications.cpp'
$clockSource = Join-Path $project 'device-clock.cpp'
$asioSource = Join-Path $project 'asio-backend.cpp'
$command = '"' + $vcvars + '" >nul && cl /nologo /EHsc /O2 /MT /std:c++17 /utf-8 /I"' + $ffmpegInstall + '\include" "' + $source + '" "' + $capabilitiesSource + '" "' + $notificationsSource + '" "' + $clockSource + '" "' + $asioSource + '" /Fe:"' + $output + '" /link /SUBSYSTEM:CONSOLE advapi32.lib ole32.lib user32.lib avrt.lib delayimp.lib /LIBPATH:"' + $ffmpegInstall + '\bin" avformat.lib avcodec.lib avutil.lib swresample.lib /DELAYLOAD:avformat-62.dll /DELAYLOAD:avcodec-62.dll /DELAYLOAD:avutil-60.dll /DELAYLOAD:swresample-6.dll'
$goldSource = Join-Path $project 'cue-gold.cpp'
$goldOutput = Join-Path $build 'cue-gold.exe'
$goldCommand = '"' + $vcvars + '" >nul && cl /nologo /EHsc /O2 /MT /std:c++17 /utf-8 "' + $goldSource + '" /Fe:"' + $goldOutput + '" /link /SUBSYSTEM:CONSOLE'
$ringSource = Join-Path $project 'pcm-ring-gold.cpp'
$ringOutput = Join-Path $build 'pcm-ring-gold.exe'
$ringCommand = '"' + $vcvars + '" >nul && cl /nologo /EHsc /O2 /MT /std:c++17 /utf-8 "' + $ringSource + '" /Fe:"' + $ringOutput + '" /link /SUBSYSTEM:CONSOLE'
$dsdSource = Join-Path $project 'dsd-gold.cpp'
$dsdOutput = Join-Path $build 'dsd-gold.exe'
$dsdCommand = '"' + $vcvars + '" >nul && cl /nologo /EHsc /O2 /MT /std:c++17 /utf-8 "' + $dsdSource + '" /Fe:"' + $dsdOutput + '" /link /SUBSYSTEM:CONSOLE'
$waveformSource = Join-Path $project 'waveform.cpp'
$waveformOutput = Join-Path $build 'waveform-worker.exe'
$waveformCommand = '"' + $vcvars + '" >nul && cl /nologo /EHsc /O2 /MT /std:c++17 /utf-8 /I"' + $ffmpegInstall + '\include" "' + $waveformSource + '" /Fe:"' + $waveformOutput + '" /link /SUBSYSTEM:CONSOLE bcrypt.lib delayimp.lib /LIBPATH:"' + $ffmpegInstall + '\bin" avformat.lib avcodec.lib avutil.lib swresample.lib /DELAYLOAD:avformat-62.dll /DELAYLOAD:avcodec-62.dll /DELAYLOAD:avutil-60.dll /DELAYLOAD:swresample-6.dll'
$fingerprintScript = Join-Path $project 'build-fingerprint.ps1'
& powershell -NoProfile -ExecutionPolicy Bypass -File $fingerprintScript
if ($LASTEXITCODE -ne 0) { throw 'Fingerprint helper build failed' }
$analysisSource = Join-Path $project 'dsd-analysis-worker.cpp'
$analysisOutput = Join-Path $build 'dsd-analysis-worker.exe'
$analysisCommand = $waveformCommand.Replace($waveformSource,$analysisSource).Replace($waveformOutput,$analysisOutput)
Push-Location $build
try {
  & cmd.exe /c $command
  if ($LASTEXITCODE -ne 0) { throw "C++ build failed with exit code $LASTEXITCODE" }
  Write-Host "Built $output"
  foreach ($dll in @('avutil-60.dll','swresample-6.dll','avcodec-62.dll','avformat-62.dll')) {
    Copy-Item -LiteralPath (Join-Path $ffmpegInstall ('bin/'+$dll)) -Destination (Join-Path $build $dll) -Force
  }
  & cmd.exe /c $goldCommand
  if ($LASTEXITCODE -ne 0) { throw "CUE gold build failed with exit code $LASTEXITCODE" }
  Write-Host "Built $goldOutput"
  & cmd.exe /c $ringCommand
  if ($LASTEXITCODE -ne 0) { throw "PCM ring gold build failed with exit code $LASTEXITCODE" }
  Write-Host "Built $ringOutput"
  & cmd.exe /c $dsdCommand
  if ($LASTEXITCODE -ne 0) { throw "DSD software gold build failed with exit code $LASTEXITCODE" }
  Write-Host "Built $dsdOutput (not executed)"
  & cmd.exe /c $waveformCommand
  if ($LASTEXITCODE -ne 0) { throw "Waveform worker build failed with exit code $LASTEXITCODE" }
  Write-Host "Built $waveformOutput"
  & cmd.exe /c $analysisCommand
  if ($LASTEXITCODE -ne 0) { throw "DSD analysis worker build failed with exit code $LASTEXITCODE" }
  Write-Host "Built $analysisOutput (not executed)"
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $project 'build-decoder-gold.ps1')
  if($LASTEXITCODE -ne 0){throw 'Decoder gold tool build failed'}
  $audioBuildAfter=Get-AudioBuildInputs
  if(($audioBuildBefore|ConvertTo-Json -Compress) -ne ($audioBuildAfter|ConvertTo-Json -Compress)){throw 'Audio sources changed during build'}
  $audioDllHashes=[ordered]@{}
  foreach($audioDll in @('avutil-60.dll','swresample-6.dll','avcodec-62.dll','avformat-62.dll')){$audioDllHashes[$audioDll]=(Get-FileHash -LiteralPath (Join-Path $build $audioDll) -Algorithm SHA256).Hash.ToLowerInvariant()}
  $audioAppVersion=(Get-Content -LiteralPath (Join-Path $project '../../release/manifest.json') -Raw|ConvertFrom-Json).appVersion
  @{version=1;appVersion=$audioAppVersion;inputs=$audioBuildBefore;hostSha256=(Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant();ffmpegHashes=$audioDllHashes}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $build 'audio-host-build.json') -Encoding UTF8
} finally { Pop-Location }

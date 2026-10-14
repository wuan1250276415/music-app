param([string]$SevenZip=$env:AURAL_SEVEN_ZIP)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$build = Join-Path $project 'build'
New-Item -ItemType Directory -Force -Path $build | Out-Null
& python (Join-Path $project 'verify-build.py') --check
if ($LASTEXITCODE -eq 0) { exit 0 }
if (-not $SevenZip) {
    $cachedSevenZip = Join-Path $build 'tools/7zip/7z.exe'
    if (Test-Path -LiteralPath $cachedSevenZip) { $SevenZip = $cachedSevenZip }
    else { $command = Get-Command 7z -ErrorAction SilentlyContinue; if ($command) { $SevenZip=$command.Source } }
}
$arguments = @((Join-Path $project 'prepare.py'))
if ($SevenZip) { $arguments += @('--sevenzip',$SevenZip) }
& python @arguments
if ($LASTEXITCODE -ne 0) { throw 'FFmpeg source/tool preparation failed' }
$vswhere = 'C:/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe'
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw 'Visual Studio C++/Windows SDK tools are required' }
$vcvars = Join-Path $vs 'VC/Auxiliary/Build/vcvars64.bat'
$toolset = Get-ChildItem -LiteralPath (Join-Path $vs 'VC/Tools/MSVC') -Directory | Sort-Object Name -Descending | Select-Object -First 1
$msvcLink = Join-Path $toolset.FullName 'bin/Hostx64/x64/link.exe'
$gitBash = 'C:/Program Files/Git/bin/bash.exe'
if (-not (Test-Path -LiteralPath $gitBash)) { throw 'Git for Windows Bash is required' }
$make = Join-Path $build 'tools/make-4.4.1'
if (-not (Test-Path -LiteralPath (Join-Path $make 'WinRel/gnumake.exe'))) {
    $makeCommand = '"' + $vcvars + '" >nul && build_w32.bat --without-guile'
    Push-Location $make
    try { & cmd.exe /c $makeCommand; if ($LASTEXITCODE -ne 0) { throw 'GNU Make bootstrap failed' } }
    finally { Pop-Location }
    if (-not (Test-Path -LiteralPath (Join-Path $make 'WinRel/gnumake.exe'))) { throw 'GNU Make bootstrap did not produce an executable' }
}
$batch = Join-Path $build 'compile.cmd'
# Separate lines preserve PATH changes made by vcvars; never pre-expand PATH in a chained command.
$lines = @('@echo off',('call "'+$vcvars+'" >nul'),'if errorlevel 1 exit /b 1',
    ('set "AURAL_MSVC_LINK='+$msvcLink.Replace('\','/')+'"'),
    ('set "PATH='+$build+'\tools\llvm\bin;'+$make+'\WinRel;%PATH%;C:\Program Files\Git\usr\bin"'),
    ('"'+$gitBash+'" "'+$project.Replace('\','/')+'/build-source.sh"'),'exit /b %errorlevel%')
[System.IO.File]::WriteAllText($batch,($lines -join "`r`n")+"`r`n",(New-Object System.Text.UTF8Encoding($false)))
& cmd.exe /c ('"'+$batch+'"')
if ($LASTEXITCODE -ne 0) { throw 'Controlled FFmpeg build failed' }
& python (Join-Path $project 'verify-build.py')
if ($LASTEXITCODE -ne 0) { throw 'FFmpeg build manifest verification failed' }

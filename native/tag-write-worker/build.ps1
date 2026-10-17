$ErrorActionPreference = 'Stop'
$tagProject = Split-Path -Parent $MyInvocation.MyCommand.Path
$tagVswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
$tagVs = & $tagVswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $tagVs) { throw 'Visual Studio C++ tools not found.' }
$tagVcvars = Join-Path $tagVs 'VC\Auxiliary\Build\vcvars64.bat'
$tagBuild = Join-Path $tagProject 'build'
New-Item -ItemType Directory -Force $tagBuild | Out-Null
$tagSource = Join-Path (Split-Path -Parent $tagProject) 'media-worker\main.cpp'
$tagOutput = Join-Path $tagBuild 'tag-write-worker.exe'
$tagCommand = '"' + $tagVcvars + '" >nul && cl /nologo /EHsc /O2 /MT /std:c++17 /utf-8 /DAURAL_TAG_WRITE_SUPERVISOR "' + $tagSource + '" /Fe:"' + $tagOutput + '" /link /SUBSYSTEM:CONSOLE'
Push-Location $tagBuild
try {
 & cmd.exe /c $tagCommand
 if ($LASTEXITCODE -ne 0) { throw "Tag write supervisor build failed with exit code $LASTEXITCODE" }
 Write-Host "Built $tagOutput (not executed)"
 $tagInspectorSource = Join-Path $tagProject 'inspector.cpp'
 $tagInspectorOutput = Join-Path $tagBuild 'tag-file-inspector.exe'
 $tagInspectorCommand = '"' + $tagVcvars + '" >nul && cl /nologo /EHsc /O2 /MT /std:c++17 /utf-8 "' + $tagInspectorSource + '" /Fe:"' + $tagInspectorOutput + '" /link bcrypt.lib /SUBSYSTEM:CONSOLE'
 & cmd.exe /c $tagInspectorCommand
 if ($LASTEXITCODE -ne 0) { throw "Tag file inspector build failed with exit code $LASTEXITCODE" }
 Write-Host "Built $tagInspectorOutput (not executed)"
 $tagCommitterSource = Join-Path $tagProject 'committer.cpp'
 $tagCommitterOutput = Join-Path $tagBuild 'tag-file-committer.exe'
 $tagCommitterCommand = '"' + $tagVcvars + '" >nul && cl /nologo /EHsc /O2 /MT /std:c++17 /utf-8 "' + $tagCommitterSource + '" /Fe:"' + $tagCommitterOutput + '" /link bcrypt.lib advapi32.lib /SUBSYSTEM:CONSOLE'
 & cmd.exe /c $tagCommitterCommand
 if ($LASTEXITCODE -ne 0) { throw "Tag file committer build failed with exit code $LASTEXITCODE" }
 Write-Host "Built $tagCommitterOutput (not executed; certification catalog closed)"
 $tagRestorerSource = Join-Path $tagProject 'restorer.cpp'
 $tagRestorerOutput = Join-Path $tagBuild 'tag-file-restorer.exe'
 $tagRestorerCommand = '"' + $tagVcvars + '" >nul && cl /nologo /EHsc /O2 /MT /std:c++17 /utf-8 "' + $tagRestorerSource + '" /Fe:"' + $tagRestorerOutput + '" /link bcrypt.lib advapi32.lib /SUBSYSTEM:CONSOLE'
 & cmd.exe /c $tagRestorerCommand
 if ($LASTEXITCODE -ne 0) { throw "Tag file restorer build failed with exit code $LASTEXITCODE" }
 Write-Host "Built $tagRestorerOutput (not executed; independent restoration certification catalog closed)"
 $directoryMoverSource = Join-Path $tagProject 'catalog-directory-mover.cpp'
 $directoryMoverOutput = Join-Path $tagBuild 'catalog-directory-mover.exe'
 $directoryMoverCommand = '"' + $tagVcvars + '" >nul && cl /nologo /EHsc /O2 /MT /std:c++17 /utf-8 "' + $directoryMoverSource + '" /Fe:"' + $directoryMoverOutput + '" /link bcrypt.lib advapi32.lib /SUBSYSTEM:CONSOLE'
 & cmd.exe /c $directoryMoverCommand
 if ($LASTEXITCODE -ne 0) { throw "Catalog directory mover build failed with exit code $LASTEXITCODE" }
 Write-Host "Built $directoryMoverOutput (not executed; private restore primitive, no apply entry)"
 & (Join-Path $tagProject 'build-backup-cleaner.ps1')
} finally { Pop-Location }

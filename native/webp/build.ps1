$ErrorActionPreference = 'Stop'
function Get-WebpSha256([string]$WebpFile) {
    $webpStream = [System.IO.File]::OpenRead($WebpFile)
    $webpHasher = [System.Security.Cryptography.SHA256]::Create()
    try { return [System.BitConverter]::ToString($webpHasher.ComputeHash($webpStream)).Replace('-','').ToLowerInvariant() }
    finally { $webpStream.Dispose(); $webpHasher.Dispose() }
}
$webpProject = Split-Path -Parent $MyInvocation.MyCommand.Path
$webpLock = Get-Content (Join-Path $webpProject 'lock.json') -Raw | ConvertFrom-Json
$webpArchive = Join-Path $webpProject ('vendor\' + $webpLock.archive)
if ((Get-WebpSha256 $webpArchive) -ne $webpLock.sha256) { throw 'WebP source archive differs from lock.' }
$webpBuild = Join-Path $webpProject 'build'
$webpSource = Join-Path $webpBuild $webpLock.sourceDirectory
New-Item -ItemType Directory -Force $webpBuild | Out-Null
$webpPython = @'
import sys,tarfile,hashlib
from pathlib import Path
archive,root,target=map(Path,sys.argv[1:4])
with tarfile.open(archive,'r:gz') as source:
    for member in source.getmembers():
        if not member.isfile(): continue
        parts=Path(member.name).parts
        if not parts or parts[0]!=target.name or '..' in parts: raise ValueError('Unexpected WebP archive path')
        destination=root/member.name
        payload=source.extractfile(member).read()
        if not destination.exists() or destination.read_bytes()!=payload:
            destination.parent.mkdir(parents=True,exist_ok=True)
            destination.write_bytes(payload)
for name in ['COPYING','PATENTS']:
    if (target/name).read_bytes()!=(archive.parent/name).read_bytes(): raise ValueError('WebP license differs')
'@
$webpPython | python - $webpArchive $webpBuild $webpSource
if ($LASTEXITCODE -ne 0) { throw 'WebP source preparation failed.' }
$webpVswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
$webpVs = & $webpVswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $webpVs) { throw 'Visual Studio C++ tools not found.' }
$webpVcvars = Join-Path $webpVs 'VC\Auxiliary\Build\vcvars64.bat'
$webpCommand = '"' + $webpVcvars + '" >nul && nmake /nologo /f Makefile.vc CFG=release-static ARCH=x64 RTLIBCFG=static OBJDIR=..\obj ..\obj\release-static\x64\lib\libwebpdecoder.lib ..\obj\release-static\x64\lib\libwebpdemux.lib'
Push-Location $webpSource
try { & cmd.exe /c $webpCommand; if ($LASTEXITCODE -ne 0) { throw "WebP decoder build failed: $LASTEXITCODE" } }
finally { Pop-Location }
$webpRecords = @()
foreach ($webpName in @('libwebpdecoder.lib','libwebpdemux.lib')) {
    $webpLibrary = Join-Path $webpBuild ('obj\release-static\x64\lib\' + $webpName)
    $webpRecords += @{file=$webpName;sha256=(Get-WebpSha256 $webpLibrary);bytes=(Get-Item -LiteralPath $webpLibrary).Length}
}
$webpManifest = @{version=$webpLock.version;sourceSha256=$webpLock.sha256;configuration='MSVC x64; release-static; RTLIBCFG=static; decoder+demux only';recipeSha256=(Get-WebpSha256 $MyInvocation.MyCommand.Path);libraries=$webpRecords;certification='unverified'}
$webpJson = $webpManifest | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText((Join-Path $webpProject 'build-manifest.json'),$webpJson+"`n",(New-Object System.Text.UTF8Encoding($false)))
Write-Host 'Built pinned WebP decoder and demux libraries (no decoding tests executed).'

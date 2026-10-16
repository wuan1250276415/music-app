param([Parameter(Mandatory=$true)][string]$File)
$ErrorActionPreference='Stop'
$taskFile=[IO.Path]::GetFullPath($File)
if($taskFile -notmatch '^D:\\CodexTestData\\aural-tag-cert-mvp-[A-Za-z0-9]+\\runs\\run-[A-Za-z0-9]+\\[0-9]+\\music\\original\.flac$'){throw 'Not an owned native tag fixture'}
$taskHandle=[IO.File]::Open($taskFile,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
try{[Console]::WriteLine('owned-file-locked');[void][Console]::ReadLine()}finally{$taskHandle.Dispose()}

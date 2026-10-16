param([Parameter(Mandatory=$true)][string]$Scratch)
$ErrorActionPreference='Stop'
# Node may inherit PowerShell 7 module paths while this helper runs in Windows PowerShell.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
$taskScratch=[IO.Path]::GetFullPath($Scratch)
if($taskScratch -notmatch '^D:\\CodexTestData\\aural-tag-cert-mvp-[A-Za-z0-9]+$'){throw 'Candidate build requires an owned isolated MVP root'}
if(-not (Test-Path -LiteralPath $taskScratch -PathType Container) -or ((Get-Item -LiteralPath $taskScratch).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Candidate root is missing or redirected'}
$taskProject=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$taskBuild=Join-Path $taskScratch 'candidate-build'
if(Test-Path -LiteralPath $taskBuild){throw 'Candidate output already exists; do not reuse stale certification binaries'}
$taskNative=Join-Path $taskBuild 'native\tag-write-worker'
$taskJson=Join-Path $taskBuild 'native\audio-host\vendor'
New-Item -ItemType Directory -Path $taskNative,$taskJson | Out-Null
$taskFiles=@('committer.cpp','restorer.cpp','catalog-directory-mover.cpp','tag-file-transaction.hpp','tag-file-io.hpp','tag-origin-policy.hpp')
$taskHashes=@{}
foreach($taskFile in $taskFiles){
 $taskSource=Join-Path $taskProject ('native\tag-write-worker\'+$taskFile)
 Copy-Item -LiteralPath $taskSource -Destination (Join-Path $taskNative $taskFile)
 $taskHashes['native/tag-write-worker/'+$taskFile]=(Get-FileHash -LiteralPath $taskSource -Algorithm SHA256).Hash.ToLowerInvariant()
}
$taskJsonSource=Join-Path $taskProject 'native\audio-host\vendor\json.hpp'
Copy-Item -LiteralPath $taskJsonSource -Destination (Join-Path $taskJson 'json.hpp')
$taskHashes['native/audio-host/vendor/json.hpp']=(Get-FileHash -LiteralPath $taskJsonSource -Algorithm SHA256).Hash.ToLowerInvariant()
function CandidateId([string]$taskPurpose){
 $taskHasher=[Security.Cryptography.SHA256]::Create()
 try{return [BitConverter]::ToString($taskHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($taskPurpose+'|'+$taskScratch))).Replace('-','').ToLowerInvariant()}finally{$taskHasher.Dispose()}
}
$taskCommit=CandidateId 'commit-v1'
$taskVictim=CandidateId 'restore-victim-v2'
$taskBackup=CandidateId 'restore-backup-v2'
$taskEncoding=[Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText((Join-Path $taskNative 'tag-certification.hpp'),@"
#pragma once
#include <string>
namespace tag_certification { inline bool permits(const std::string& id){return id=="$taskCommit";} }
"@,$taskEncoding)
[IO.File]::WriteAllText((Join-Path $taskNative 'tag-restore-certification.hpp'),@"
#pragma once
#include <string>
namespace tag_restore_certification { inline bool permits(const std::string& id,const std::string& mode,unsigned version){return version==2&&((mode=="victim"&&id=="$taskVictim")||(mode=="backup"&&id=="$taskBackup"));} }
"@,$taskEncoding)
$taskRootCpp=$taskScratch.Replace('\','\\')
foreach($taskKind in @('commit','restore')){
 $taskCpp=if($taskKind -eq 'commit'){'committer.cpp'}else{'restorer.cpp'}
 $taskWrapper=@"
// Test-only composition. The production transaction source above is copied byte-for-byte.
#define wmain candidate_original_entry
#include "$taskCpp"
#undef wmain
static void owned_candidate(const json& r){
 const auto root=normal(std::wstring(L"$taskRootCpp"));
 for(const char* key:{"sourceRoot","backupRoot"})if(!r.contains(key)||!r.at(key).is_string()||!inside(root,normal(wide(r.at(key).get<std::string>()))))throw std::runtime_error("candidate request outside compiled owned root");
 if(!r.contains("files")||!r.at("files").is_array())throw std::runtime_error("candidate file scope missing");
 for(const auto& file:r.at("files"))if(!file.contains("path")||!file.at("path").is_string()||!inside(root,normal(wide(file.at("path").get<std::string>()))))throw std::runtime_error("candidate artifact outside compiled owned root");
 $taskKind(r);
}
int wmain(int argc,wchar_t** argv){return runTagNativeTransaction(argc,argv,owned_candidate);}
"@
 [IO.File]::WriteAllText((Join-Path $taskNative ($taskKind+'-candidate.cpp')),$taskWrapper,$taskEncoding)
}
$taskProbe=@"
#include "tag-file-transaction.hpp"
static void probe(const json& r){
 const auto root=normal(std::wstring(L"$taskRootCpp"));
 const auto source=normal(wide(r.at("files").at(0).at("path").get<std::string>())),target=normal(wide(r.at("files").at(1).at("path").get<std::string>()));
 if(!inside(root,source)||!inside(root,target))throw std::runtime_error("directory probe outside compiled owned root");
 DirectoryPins pins;pins.pin(parentOf(source));const auto parent=pins.pin(parentOf(target),true,true);
 Handle handle;handle.value=CreateFileW(extended(source).c_str(),FILE_READ_ATTRIBUTES|DELETE,0,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
 if(handle.value==INVALID_HANDLE_VALUE||finalPath(handle.value)!=source)throw std::runtime_error("directory probe source not confirmed");
 const auto before=identity(handle.value,true);renamePinnedHandleAbsent(handle.value,parent,target);const auto after=identity(handle.value,true);
 if(before.at("volume")!=after.at("volume")||before.at("fileId")!=after.at("fileId"))throw std::runtime_error("directory probe identity changed");
 send({{"kind","done"},{"proof",{{"sameIdentity",true}}}});
}
int wmain(int argc,wchar_t** argv){return runTagNativeTransaction(argc,argv,probe);}
"@
[IO.File]::WriteAllText((Join-Path $taskNative 'directory-candidate.cpp'),$taskProbe,$taskEncoding)
$taskVswhere='C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
$taskVs=& $taskVswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if(-not $taskVs){throw 'Visual Studio x64 compiler not found'}
$taskVcvars=Join-Path $taskVs 'VC\Auxiliary\Build\vcvars64.bat'
Push-Location $taskNative
try{
 foreach($taskKind in @('commit','restore','directory')){
  $taskName=if($taskKind -eq 'commit'){'tag-file-committer.exe'}elseif($taskKind -eq 'restore'){'tag-file-restorer.exe'}else{'directory-rename-probe.exe'}
  $taskCommand='"'+$taskVcvars+'" >nul && cl /nologo /EHsc /O2 /MT /std:c++17 /utf-8 "'+(Join-Path $taskNative ($taskKind+'-candidate.cpp'))+'" /Fe:"'+(Join-Path $taskNative $taskName)+'" /link bcrypt.lib advapi32.lib /SUBSYSTEM:CONSOLE'
  & cmd.exe /c $taskCommand
  if($LASTEXITCODE -ne 0){throw "Candidate $taskKind compilation failed"}
 }
}finally{Pop-Location}
foreach($taskPair in $taskHashes.GetEnumerator()){
 if((Get-FileHash -LiteralPath (Join-Path $taskProject $taskPair.Key) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskPair.Value){throw 'Production source changed during candidate build'}
}
$taskManifest=[ordered]@{version=1;scope='owned-root compiled test candidate; production catalogs and binaries unchanged';root=$taskScratch;commitId=$taskCommit;victimId=$taskVictim;backupId=$taskBackup;sourceHashes=$taskHashes;commitExe=(Join-Path $taskNative 'tag-file-committer.exe');restoreExe=(Join-Path $taskNative 'tag-file-restorer.exe');probeExe=(Join-Path $taskNative 'directory-rename-probe.exe');compilerFlags='/EHsc /O2 /MT /std:c++17 /utf-8';binaries=@{}}
foreach($taskName in @('tag-file-committer.exe','tag-file-restorer.exe','directory-rename-probe.exe')){$taskManifest.binaries[$taskName]=(Get-FileHash -LiteralPath (Join-Path $taskNative $taskName) -Algorithm SHA256).Hash.ToLowerInvariant()}
[IO.File]::WriteAllText((Join-Path $taskScratch 'candidate-build.json'),($taskManifest | ConvertTo-Json -Depth 6),$taskEncoding)
Write-Output 'Built isolated candidate; production certification remains closed'

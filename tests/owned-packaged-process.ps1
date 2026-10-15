param(
 [Parameter(Mandatory=$true)][ValidateSet('inspect','check','stop')][string]$Mode,
 [Parameter(Mandatory=$true)][int]$MainProcessId,
 [Parameter(Mandatory=$true)][string]$ExpectedExe,
 [string]$WitnessFile
)
$ErrorActionPreference='Stop'
$taskExe=[IO.Path]::GetFullPath($ExpectedExe)
if($taskExe -notmatch '^D:\\CodexBuildData\\aural-v[0-9]+\.[0-9]+\.[0-9]+\\win-unpacked\\Aural\.exe$'){throw 'Not an owned packaged build executable'}
$taskRoot=[IO.Path]::GetDirectoryName($taskExe)+'\'
$taskConsole=[IO.Path]::Combine([Environment]::GetFolderPath('System'),'conhost.exe')
function OwnedExecutable([string]$taskPath){
 return $taskPath -and ($taskPath.StartsWith($taskRoot,[StringComparison]::OrdinalIgnoreCase) -or $taskPath -ieq $taskConsole)
}
function Snapshot {
 $taskAll=@(Get-CimInstance Win32_Process)
 $taskMain=@($taskAll | Where-Object {$_.ProcessId -eq $MainProcessId -and $_.ExecutablePath -ieq $taskExe -and -not $_.CommandLine.Contains('--type=')})
 if($taskMain.Count -ne 1){throw 'Owned actual packaged main process is not present'}
 $taskMembers=[Collections.Generic.List[object]]::new();$taskMembers.Add($taskMain[0])
 for($taskIndex=0;$taskIndex -lt $taskMembers.Count;$taskIndex++){
  if($taskMembers.Count -gt 64){throw 'Owned tree exceeds fixture process budget'}
  $taskParent=$taskMembers[$taskIndex]
  foreach($taskChild in $taskAll | Where-Object {$_.ParentProcessId -eq $taskParent.ProcessId -and $_.CreationDate -ge $taskParent.CreationDate}){$taskMembers.Add($taskChild)}
 }
 $taskRows=@($taskMembers | ForEach-Object {
  $taskObserved=$_
  if(-not $taskObserved.ExecutablePath){
   $taskObserved=Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ProcessId)"
   if($taskObserved -and $taskObserved.CreationDate -ne $_.CreationDate){throw 'Unidentified descendant PID was reused during observation'}
  }
  if($taskObserved){
   if(-not (OwnedExecutable $taskObserved.ExecutablePath)){throw "Child process outside owned packaged build or its system console host: $($taskObserved.ProcessId) $($taskObserved.Name) $($taskObserved.ExecutablePath)"}
   [PSCustomObject]@{id=[int]$taskObserved.ProcessId;parent=[int]$taskObserved.ParentProcessId;exe=$taskObserved.ExecutablePath;created=$taskObserved.CreationDate.ToUniversalTime().ToString('o')}
  }
 })
 return [PSCustomObject]@{main=$MainProcessId;exe=$taskExe;members=$taskRows}
}
if($Mode -eq 'inspect'){Snapshot | ConvertTo-Json -Depth 5 -Compress;exit 0}
$taskWitness=[IO.Path]::GetFullPath($WitnessFile)
if($taskWitness -notmatch '^D:\\CodexTestData\\aural-packaged-mvp-[A-Za-z0-9]+\\process-witness\.json$'){throw 'Not an owned packaged witness'}
$taskSaved=Get-Content -LiteralPath $taskWitness -Raw | ConvertFrom-Json
if($taskSaved.main -ne $MainProcessId -or $taskSaved.exe -ine $taskExe -or $taskSaved.members.Count -lt 1 -or $taskSaved.members.Count -gt 64 -or $taskSaved.members[0].id -ne $MainProcessId){throw 'Owned packaged witness mismatch'}
foreach($taskMember in $taskSaved.members){if(-not (OwnedExecutable $taskMember.exe)){throw 'Witness has a foreign executable'}}
function Remaining {
 $taskAll=@(Get-CimInstance Win32_Process)
 return @($taskSaved.members | Where-Object {$taskMember=$_;$taskAll | Where-Object {$_.ProcessId -eq $taskMember.id -and $_.ExecutablePath -ieq $taskMember.exe -and $_.CreationDate.ToUniversalTime().ToString('o') -eq $taskMember.created}})
}
$taskRemaining=@(Remaining)
if($Mode -eq 'stop'){
 for($taskIndex=$taskRemaining.Count-1;$taskIndex -ge 0;$taskIndex--){
  $taskMember=$taskRemaining[$taskIndex];$taskCurrent=Get-CimInstance Win32_Process -Filter "ProcessId=$($taskMember.id)"
  if($taskCurrent -and $taskCurrent.ExecutablePath -ieq $taskMember.exe -and $taskCurrent.CreationDate.ToUniversalTime().ToString('o') -eq $taskMember.created){Stop-Process -Id $taskMember.id -Force -ErrorAction SilentlyContinue}
 }
 $taskDeadline=[DateTime]::UtcNow.AddSeconds(10)
 do{$taskRemaining=@(Remaining);if(-not $taskRemaining.Count){break};Start-Sleep -Milliseconds 100}while([DateTime]::UtcNow -lt $taskDeadline)
}
[PSCustomObject]@{main=$MainProcessId;remaining=@($taskRemaining | ForEach-Object {$_.id});forced=($Mode -eq 'stop')} | ConvertTo-Json -Compress

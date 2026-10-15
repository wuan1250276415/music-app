param([Parameter(Mandatory=$true)][string]$Entry,[Parameter(Mandatory=$true)][string]$ExpectedExe)
$ErrorActionPreference='Stop'
$taskEntry=[IO.Path]::GetFullPath($Entry)
$taskPrefix='D:\CodexTestData\aural-workflow-ui-'
if(-not ($taskEntry.StartsWith($taskPrefix,[StringComparison]::OrdinalIgnoreCase) -or $taskEntry.StartsWith('D:\CodexTestData\aural-recognition-ui-',[StringComparison]::OrdinalIgnoreCase)) -or [IO.Path]::GetFileName($taskEntry) -ne 'main-fixture.cjs' -or -not (Test-Path -LiteralPath $taskEntry -PathType Leaf)){throw 'Not an owned metadata fixture entry'}
$taskExe=[IO.Path]::GetFullPath($ExpectedExe)
$taskRoots=@(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object {$_.ExecutablePath -ieq $taskExe -and $_.CommandLine.Contains($taskEntry) -and -not $_.CommandLine.Contains('--type=')})
if($taskRoots.Count -ne 1){throw 'Expected exactly one owned actual Electron main process'}
$taskMembers=[Collections.Generic.List[object]]::new()
$taskMembers.Add($taskRoots[0])
for($taskIndex=0;$taskIndex -lt $taskMembers.Count;$taskIndex++){
 if($taskMembers.Count -gt 64){throw 'Owned process tree exceeds fixture budget'}
 $taskParent=$taskMembers[$taskIndex]
 foreach($taskChild in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($taskParent.ProcessId)")){
  if($taskChild.CreationDate -ge $taskParent.CreationDate){$taskMembers.Add($taskChild)}
 }
}
for($taskIndex=$taskMembers.Count-1;$taskIndex -ge 0;$taskIndex--){
 $taskTarget=$taskMembers[$taskIndex]
 $taskCurrent=Get-CimInstance Win32_Process -Filter "ProcessId=$($taskTarget.ProcessId)"
 if($taskCurrent -and $taskCurrent.CreationDate -eq $taskTarget.CreationDate -and $taskCurrent.ExecutablePath -eq $taskTarget.ExecutablePath){Stop-Process -Id $taskTarget.ProcessId -Force -ErrorAction SilentlyContinue}
}
$taskDeadline=[DateTime]::UtcNow.AddSeconds(10)
do{
 $taskRemaining=@($taskMembers | Where-Object {$taskCurrent=Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ProcessId)"; $taskCurrent -and $taskCurrent.CreationDate -eq $_.CreationDate})
 if(-not $taskRemaining.Count){break}
 Start-Sleep -Milliseconds 100
}while([DateTime]::UtcNow -lt $taskDeadline)
if($taskRemaining.Count){throw 'Owned actual process tree did not exit'}
[PSCustomObject]@{terminated=$true;actualMainPid=$taskRoots[0].ProcessId;ownedProcesses=@($taskMembers | ForEach-Object {$_.ProcessId})} | ConvertTo-Json -Compress

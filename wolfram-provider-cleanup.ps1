$ErrorActionPreference='Stop'
$request=[Console]::In.ReadToEnd() | ConvertFrom-Json
$expectedProgram=[IO.Path]::GetFullPath($request.program)
$lock=Get-Content -LiteralPath (Join-Path $request.stateRoot 'review-desk-math-owner.lock') -Raw | ConvertFrom-Json
if($lock.pid -ne $request.ownerPid){throw 'Caller does not hold the mathematics owner lock'}
$all=@(Get-CimInstance Win32_Process)
$candidates=@($all | Where-Object { $_.Name -match '^(wolfram|WolframKernel|MathKernel|math|wolframscript)\.exe$' })
$result=@()
foreach($candidate in $candidates){
  $record=[ordered]@{pid=$candidate.ProcessId;parentPid=$candidate.ParentProcessId;createdAt=$candidate.CreationDate.ToString('o');action='preserved';reason='Unknown or active process'}
  $isProvider=$candidate.ExecutablePath -eq $expectedProgram -and $candidate.CommandLine -like '*StartMCPServer*' -and $candidate.CommandLine -like '*-noinit*' -and $candidate.CommandLine -like '*-noprompt*'
  $parent=$all | Where-Object ProcessId -eq $candidate.ParentProcessId
  if(-not $isProvider -or $parent.Name -ne 'codex.exe' -or ((Get-Date)-$candidate.CreationDate).TotalSeconds -lt 60){$result+=$record;continue}
  $consoleHost=Join-Path $env:SystemRoot 'System32\conhost.exe'
  $activeChildren=@($all | Where-Object { $_.ParentProcessId -eq $candidate.ProcessId -and ($_.Name -ne 'conhost.exe' -or $_.ExecutablePath -ne $consoleHost) })
  if($activeChildren.Count -gt 0){$record.reason='Provider has non-console children; it may own an active evaluation';$result+=$record;continue}
  $provider=Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue
  if($null -eq $provider){$record.action='already_exited';$result+=$record;continue}
  $beforeCpu=$provider.TotalProcessorTime.TotalSeconds
  Start-Sleep -Milliseconds 750
  $provider.Refresh()
  if($provider.HasExited){$record.action='already_exited';$result+=$record;continue}
  $delta=$provider.TotalProcessorTime.TotalSeconds-$beforeCpu
  $current=Get-CimInstance Win32_Process -Filter "ProcessId = $($candidate.ProcessId)"
  $children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($candidate.ProcessId)" | Where-Object { $_.Name -ne 'conhost.exe' -or $_.ExecutablePath -ne $consoleHost })
  $record.cpuSecondsDuring750ms=$delta
  if($delta -gt 0.04 -or $children.Count -gt 0 -or $current.CreationDate -ne $candidate.CreationDate -or $current.CommandLine -ne $candidate.CommandLine){$record.reason='Activity, child or identity changed; no cleanup';$result+=$record;continue}
  $provider.Kill()
  $provider.WaitForExit(5000) | Out-Null
  $record.action='cleaned_authorized_idle_provider';$record.reason='Exact known MCP provider, Codex parent, stable identity, no child kernels, idle sample, and exclusive mathematics ownership; user requires previous-process cleanup before a run'
  $result+=$record
}
@{at=(Get-Date).ToString('o');records=$result;authority='Current user: 每次运行前清掉之前的Wolfram进程你忘了吗';scope='Only identified idle MCP providers. No active or unknown calculation is stopped.'} | ConvertTo-Json -Depth 5 -Compress

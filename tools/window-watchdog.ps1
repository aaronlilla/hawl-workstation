# Kills any agent-launched app that shows a window on the real desktop. Runs forever, checks every second.
# Matches processes whose command line mentions the Workstation worktrees, repo or agent profile dirs.
# Windows on the private desktops made by hidden-launch.ps1 are not visible to this check, so they are left alone.
# Also: more than $MaxApps agent apps at once, or older than $MaxMinutes, get their tree killed.
param(
  [string]$Log = 'C:\dev\hawl-workstation\_proof\hidden\watchdog.log',
  [int]$MaxApps = 2,
  [int]$MaxMinutes = 20,
  [int]$Seconds = 0
)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class WD {
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EP p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static HashSet<uint> VisiblePids() {
    var r = new HashSet<uint>();
    EnumWindows((h, l) => { if (IsWindowVisible(h)) { uint p; GetWindowThreadProcessId(h, out p); r.Add(p); } return true; }, IntPtr.Zero);
    return r;
  }
}
'@
$pattern = 'hawl-ws-wt|hawl-workstation|hawl-hidden|\\_hidden-ud'
New-Item -ItemType Directory -Force (Split-Path $Log) | Out-Null
function Say($m) { Add-Content $Log ("{0} {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }
Say "watchdog start pid=$PID maxApps=$MaxApps maxMinutes=$MaxMinutes"
$until = if ($Seconds -gt 0) { (Get-Date).AddSeconds($Seconds) } else { [DateTime]::MaxValue }
while ((Get-Date) -lt $until) {
  $vis = [WD]::VisiblePids()
  $agent = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in 'electron.exe','Orca.exe','Hawl Workstation.exe','chrome.exe','msedge.exe' -and $_.CommandLine -match $pattern -and $_.CommandLine -notmatch '--type='
  })
  $killed = @{}
  foreach ($p in $agent) {
    $tree = @($p.ProcessId) + @(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $p.ProcessId } | ForEach-Object { $_.ProcessId })
    $shown = $tree | Where-Object { $vis.Contains([uint32]$_) }
    $ageMin = ((Get-Date) - $p.CreationDate).TotalMinutes
    if ($shown) { $killed[$p.ProcessId] = 1; Say "KILL visible window pid=$($p.ProcessId) $($p.Name)"; taskkill /F /T /PID $p.ProcessId | Out-Null }
    elseif ($ageMin -gt $MaxMinutes) { $killed[$p.ProcessId] = 1; Say "KILL too old ($([int]$ageMin) min) pid=$($p.ProcessId)"; taskkill /F /T /PID $p.ProcessId | Out-Null }
  }
  # An app is one root process; its daemon and helpers are children and do not count.
  $ids = @($agent | ForEach-Object { $_.ProcessId })
  $alive = @($agent | Where-Object { $ids -notcontains $_.ParentProcessId -and -not $killed.ContainsKey($_.ProcessId) } | Sort-Object CreationDate)
  if ($alive.Count -gt $MaxApps) {
    foreach ($p in $alive[$MaxApps..($alive.Count - 1)]) { Say "KILL over limit ($($alive.Count) apps) pid=$($p.ProcessId)"; taskkill /F /T /PID $p.ProcessId | Out-Null }
  }
  Start-Sleep -Seconds 1
}
Say 'watchdog end'

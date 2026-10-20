# Stand-in for an agent script that starts the app directly (bypasses the Bash guard because the command is inside a file).
$exe = 'C:\Users\Administrator\AppData\Local\Programs\orca\Orca.exe'
Start-Process $exe -ArgumentList '--user-data-dir=C:\dev\hawl-ws-wt\_wd-test'
$t = 0
do {
  Start-Sleep -Milliseconds 500; $t += 0.5
  $n = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Orca.exe' -and $_.CommandLine -match '_wd-test' }).Count
} while ($n -gt 0 -and $t -lt 20)
"visible-launch processes left after ${t}s: $n"

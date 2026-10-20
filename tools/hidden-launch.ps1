# Run a GUI program on a private, invisible Windows desktop so no window ever appears on the user's screen.
# Usage: powershell -File hidden-launch.ps1 -Timeout 600 -Exe <path> -ArgLine '<args as one string>'
# Guards: at most 2 agent GUIs at a time (lock files, exit 75 when full), hard timeout, process tree killed on exit.
param(
  [int]$Timeout = 600,
  [string]$Tag = 'agent',
  [Parameter(Mandatory = $true)] [string]$Exe,
  [string]$ArgLine = ''
)
$ErrorActionPreference = 'Stop'

$lockDir = Join-Path $env:LOCALAPPDATA 'hawl-hidden-launch'
New-Item -ItemType Directory -Force $lockDir | Out-Null
$slots = 2
$mine = $null
for ($i = 0; $i -lt $slots -and -not $mine; $i++) {
  $f = Join-Path $lockDir "$Tag-$i.lock"
  if (Test-Path $f) {
    $old = [int](Get-Content $f -ErrorAction SilentlyContinue)
    if ($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) { continue }
  }
  Set-Content $f $PID
  $mine = $f
}
if (-not $mine) { Write-Error "no free GUI slot (max $slots running)"; exit 75 }

Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class HD {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr sa);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcessW(string app, System.Text.StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  public static int Pid;
  public static IntPtr Proc;
  public static string Start(string cmdline, string deskName) {
    IntPtr d = CreateDesktopW(deskName, IntPtr.Zero, IntPtr.Zero, 0, 0x10000000, IntPtr.Zero);
    if (d == IntPtr.Zero) return "CreateDesktop failed " + Marshal.GetLastWin32Error();
    var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO)); si.lpDesktop = "winsta0\\" + deskName;
    PROCESS_INFORMATION pi;
    var sb = new System.Text.StringBuilder(cmdline, 4096);
    if (!CreateProcessW(null, sb, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi)) return "CreateProcess failed " + Marshal.GetLastWin32Error();
    Pid = pi.dwProcessId; Proc = pi.hProcess; return "ok";
  }
  public static bool Wait(int ms) { return WaitForSingleObject(Proc, (uint)ms) == 0; }
}
'@
$deskName = "hawl-$Tag-$PID"
$line = '"' + $Exe + '" ' + $ArgLine
try {
  $res = [HD]::Start($line, $deskName)
  if ($res -ne 'ok') { throw $res }
  Write-Output "hidden desktop=$deskName pid=$([HD]::Pid)"
  if (-not [HD]::Wait($Timeout * 1000)) { Write-Output "timeout after ${Timeout}s, killing tree" }
} finally {
  if ([HD]::Pid) { try { & taskkill /F /T /PID ([HD]::Pid) 2>&1 | Out-Null } catch {} }
  Remove-Item $mine -ErrorAction SilentlyContinue
}

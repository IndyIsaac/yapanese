# Records the README demo: a real dictation, captured from the screen.
#
# Plays a speech sample through the speakers so the microphone genuinely hears
# it, rather than faking the transcript — what you see is the real pipeline.
#
# Run: powershell -ExecutionPolicy Bypass -File tools\record-demo.ps1 <sample.wav>
param([string]$Sample)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int t, bool repaint);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool c);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
}
"@

$root   = Split-Path $PSScriptRoot -Parent
$outDir = Join-Path $root "assets"
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$work   = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea

# The overlay sits bottom-centre. The capture is framed tightly around the
# target window and the overlay, and the target window is sized to fill it,
# so no surrounding desktop content ends up in a published recording.
$hudHeight = 96
$hudMargin = 56
$hudTop = $work.Height - $hudHeight - $hudMargin

$capW = 1120
$capX = [int](($screen.Width - $capW) / 2)
$capY = [int]($hudTop - 420)
$capH = [int](($work.Height - 8) - $capY)

function Focus-Window($h) {
  $fg = [Win]::GetForegroundWindow()
  $t1 = [Win]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
  $t2 = [Win]::GetCurrentThreadId()
  [Win]::AttachThreadInput($t1, $t2, $true)  | Out-Null
  [Win]::BringWindowToTop($h)                | Out-Null
  [Win]::SetForegroundWindow($h)             | Out-Null
  [Win]::AttachThreadInput($t1, $t2, $false) | Out-Null
}

Get-Process notepad -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
Start-Process notepad
Start-Sleep -Seconds 2
$np = Get-Process notepad | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
# The target window fills the entire capture frame, including the area the
# overlay sits over — the overlay is always-on-top so it still renders above.
# This guarantees no surrounding desktop content is recorded.
# Oversized so the window's rounded corners and drop shadow fall outside the
# recorded frame rather than letting the desktop show through at the edges.
# The left bleed is kept small: the text area starts near that edge, and a
# large offset would crop the first word.
$bleedL = 10
$bleedR = 70
$bleedT = 10
$bleedB = 70
[Win]::MoveWindow($np.MainWindowHandle, ($capX - $bleedL), ($capY - $bleedT),
                  ($capW + $bleedL + $bleedR), ($capH + $bleedT + $bleedB), $true) | Out-Null
Focus-Window $np.MainWindowHandle
Start-Sleep -Seconds 1

$raw = Join-Path $env:TEMP "yapanese-demo.mp4"
Remove-Item $raw -ErrorAction SilentlyContinue

Write-Output "recording region ${capW}x${capH} at ${capX},${capY}"
$rec = Start-Process ffmpeg -PassThru -WindowStyle Hidden -ArgumentList @(
  "-hide_banner","-loglevel","error","-y",
  "-f","gdigrab","-framerate","16",
  "-offset_x","$capX","-offset_y","$capY","-video_size","${capW}x${capH}",
  "-i","desktop","-t","20","-pix_fmt","yuv420p",$raw
)

Start-Sleep -Seconds 2
Focus-Window $np.MainWindowHandle
Start-Sleep -Milliseconds 600

# Hold the shortcut and play the sample out loud so the mic really hears it.
node "$root\tools\demo-gesture.js" $Sample

Start-Sleep -Seconds 6
if (-not $rec.HasExited) { Start-Sleep -Seconds 2 }
$rec | Wait-Process -Timeout 25 -ErrorAction SilentlyContinue
if (-not $rec.HasExited) { Stop-Process -Id $rec.Id -Force }

Write-Output "encoding gif..."
$palette = Join-Path $env:TEMP "yapanese-palette.png"
ffmpeg -hide_banner -loglevel error -y -i $raw -vf "fps=12,scale=900:-1:flags=lanczos,palettegen=stats_mode=diff" $palette
ffmpeg -hide_banner -loglevel error -y -i $raw -i $palette -lavfi "fps=12,scale=900:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" (Join-Path $outDir "demo.gif")

$size = [math]::Round((Get-Item (Join-Path $outDir "demo.gif")).Length / 1MB, 2)
Write-Output "wrote assets/demo.gif ($size MB)"

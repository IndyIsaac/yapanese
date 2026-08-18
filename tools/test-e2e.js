// Full end-to-end check: focus Notepad, hold the dictation combo, play speech
// through the speakers so the microphone hears it, release, and read back what
// Murmur pasted into Notepad.
//
// Usage: node tools/test-e2e.js <wav>
const { execFileSync, spawn } = require('node:child_process');
const { uIOhook, UiohookKey } = require('uiohook-napi');

const wav = process.argv[2];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (script) =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, encoding: 'utf8',
  });

const FOCUS_NOTEPAD = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FE {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool c);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
}
"@
$np = Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $np) { "NO_NOTEPAD"; exit }
$fg = [FE]::GetForegroundWindow()
$t1 = [FE]::GetWindowThreadProcessId($fg,[IntPtr]::Zero); $t2 = [FE]::GetCurrentThreadId()
[FE]::AttachThreadInput($t1,$t2,$true) | Out-Null
[FE]::BringWindowToTop($np.MainWindowHandle) | Out-Null
[FE]::SetForegroundWindow($np.MainWindowHandle) | Out-Null
[FE]::AttachThreadInput($t1,$t2,$false) | Out-Null
if ([FE]::GetForegroundWindow() -eq $np.MainWindowHandle) { "FOCUSED" } else { "NOT_FOCUSED" }
`;

(async () => {
  uIOhook.start();
  await wait(300);

  console.log('focus:', ps(FOCUS_NOTEPAD).trim());
  await wait(400);

  // Clear Notepad so anything present afterwards came from this run.
  uIOhook.keyTap(UiohookKey.A, [UiohookKey.Ctrl]);
  await wait(120);
  uIOhook.keyTap(UiohookKey.Delete);
  await wait(200);

  console.log('holding Ctrl+Win and playing audio...');
  uIOhook.keyToggle(UiohookKey.Ctrl, 'down');
  await wait(30);
  uIOhook.keyToggle(UiohookKey.Meta, 'down');

  const player = spawn('powershell.exe', [
    '-NoProfile', '-Command',
    `(New-Object System.Media.SoundPlayer '${wav}').PlaySync()`,
  ], { windowsHide: true });

  await new Promise((r) => { player.on('exit', r); setTimeout(r, 16000); });
  await wait(400);

  uIOhook.keyToggle(UiohookKey.Meta, 'up');
  await wait(30);
  uIOhook.keyToggle(UiohookKey.Ctrl, 'up');
  console.log('released — waiting for transcription + paste');

  await wait(9000);

  // Read back whatever landed in Notepad.
  ps("Set-Clipboard -Value '__cleared__'");
  console.log('focus:', ps(FOCUS_NOTEPAD).trim());
  await wait(300);
  uIOhook.keyTap(UiohookKey.A, [UiohookKey.Ctrl]);
  await wait(150);
  uIOhook.keyTap(UiohookKey.C, [UiohookKey.Ctrl]);
  await wait(500);

  const landed = ps('Get-Clipboard -Raw').trim();
  uIOhook.stop();

  console.log(`\nNOTEPAD CONTAINS: ${JSON.stringify(landed.slice(0, 160))}`);
  const ok = landed.length > 0 && landed !== '__cleared__';
  console.log(ok ? 'PASS — Murmur pasted into the focused app' : 'FAIL — nothing was pasted');
  process.exit(ok ? 0 : 1);
})();

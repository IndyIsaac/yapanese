// Verifies the capture -> delivery path lands text in the focused app.
// Run Yapanese with YAPANESE_FAKE_TRANSCRIPT set, then run this.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { uIOhook, UiohookKey } = require('uiohook-napi');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (script) =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, encoding: 'utf8',
  });

const FOCUS = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FD {
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
$fg = [FD]::GetForegroundWindow()
$t1 = [FD]::GetWindowThreadProcessId($fg,[IntPtr]::Zero); $t2 = [FD]::GetCurrentThreadId()
[FD]::AttachThreadInput($t1,$t2,$true) | Out-Null
[FD]::BringWindowToTop($np.MainWindowHandle) | Out-Null
[FD]::SetForegroundWindow($np.MainWindowHandle) | Out-Null
[FD]::AttachThreadInput($t1,$t2,$false) | Out-Null
if ([FD]::GetForegroundWindow() -eq $np.MainWindowHandle) { "FOCUSED" } else { "NOT_FOCUSED" }
`;

(async () => {
  const sentinel = fs.readFileSync(path.join(os.tmpdir(), 'sentinel.txt'), 'utf8').trim();
  console.log('expecting:', sentinel);

  uIOhook.start();
  await wait(300);
  console.log('focus:', ps(FOCUS).trim());
  await wait(400);

  uIOhook.keyTap(UiohookKey.A, [UiohookKey.Ctrl]);
  await wait(120);
  uIOhook.keyTap(UiohookKey.Delete);
  await wait(250);

  // Hold the combo for 1.5s: long enough to register as a hold.
  console.log('holding Ctrl+Win for 1.5s...');
  uIOhook.keyToggle(UiohookKey.Ctrl, 'down');
  await wait(30);
  uIOhook.keyToggle(UiohookKey.Meta, 'down');
  await wait(1500);
  uIOhook.keyToggle(UiohookKey.Meta, 'up');
  await wait(30);
  uIOhook.keyToggle(UiohookKey.Ctrl, 'up');

  console.log('released — waiting for delivery');
  await wait(5000);

  ps("Set-Clipboard -Value '__cleared__'");
  console.log('focus:', ps(FOCUS).trim());
  await wait(300);
  uIOhook.keyTap(UiohookKey.A, [UiohookKey.Ctrl]);
  await wait(150);
  uIOhook.keyTap(UiohookKey.C, [UiohookKey.Ctrl]);
  await wait(500);

  const landed = ps('Get-Clipboard -Raw').trim();
  uIOhook.stop();

  console.log(`\nNOTEPAD CONTAINS: ${JSON.stringify(landed.slice(0, 120))}`);
  const ok = landed.includes(sentinel);
  console.log(ok ? 'PASS — auto-paste landed in the focused app' : 'FAIL — text did not arrive');
  process.exit(ok ? 0 : 1);
})();

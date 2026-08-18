// Round-trip test for native paste synthesis.
//
// Focuses Notepad itself, puts a sentinel on the clipboard, sends Ctrl+V,
// then selects-all and copies back. If the clipboard returns the sentinel the
// paste genuinely reached the target application.
//
// Usage: node tools/test-paste.js
const { execFileSync } = require('node:child_process');
const { uIOhook, UiohookKey } = require('uiohook-napi');

const PS = 'powershell.exe';
const ps = (script) =>
  execFileSync(PS, ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, encoding: 'utf8',
  });

const setClip = (t) => ps(`Set-Clipboard -Value @'\n${t}\n'@`);
const getClip = () => ps('Get-Clipboard -Raw').trim();

const FOCUS_NOTEPAD = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FF {
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
$fg = [FF]::GetForegroundWindow()
$t1 = [FF]::GetWindowThreadProcessId($fg,[IntPtr]::Zero); $t2 = [FF]::GetCurrentThreadId()
[FF]::AttachThreadInput($t1,$t2,$true) | Out-Null
[FF]::BringWindowToTop($np.MainWindowHandle) | Out-Null
[FF]::SetForegroundWindow($np.MainWindowHandle) | Out-Null
[FF]::AttachThreadInput($t1,$t2,$false) | Out-Null
if ([FF]::GetForegroundWindow() -eq $np.MainWindowHandle) { "FOCUSED" } else { "NOT_FOCUSED" }
`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const SENTINEL = `YAPANESE-PASTE-${Date.now()}`;

  uIOhook.start();
  setClip(SENTINEL);

  const focus = ps(FOCUS_NOTEPAD).trim();
  console.log('focus result:', focus);
  if (focus.includes('NO_NOTEPAD')) { uIOhook.stop(); process.exit(2); }
  await wait(300);

  // Clear whatever is in the buffer, then paste.
  uIOhook.keyTap(UiohookKey.A, [UiohookKey.Ctrl]);
  await wait(120);
  uIOhook.keyTap(UiohookKey.Delete);
  await wait(120);
  uIOhook.keyTap(UiohookKey.V, [UiohookKey.Ctrl]);
  await wait(500);

  // Read back what actually landed.
  setClip('__cleared__');
  await wait(150);
  uIOhook.keyTap(UiohookKey.A, [UiohookKey.Ctrl]);
  await wait(150);
  uIOhook.keyTap(UiohookKey.C, [UiohookKey.Ctrl]);
  await wait(400);

  const readBack = getClip();
  uIOhook.stop();

  const ok = readBack.includes(SENTINEL);
  console.log(`sentinel : ${SENTINEL}`);
  console.log(`read back: ${JSON.stringify(readBack.slice(0, 60))}`);
  console.log(ok ? 'PASS — native paste reached the focused app' : 'FAIL — paste did not land');
  process.exit(ok ? 0 : 1);
})();

// Holds the dictation shortcut while a speech sample plays through the
// speakers, so the microphone genuinely hears it. Used by record-demo.ps1.
const { spawn } = require('node:child_process');
const { uIOhook, UiohookKey } = require('uiohook-napi');

const sample = process.argv[2];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  uIOhook.start();
  await wait(300);

  // Clear the target window first.
  uIOhook.keyTap(UiohookKey.A, [UiohookKey.Ctrl]);
  await wait(120);
  uIOhook.keyTap(UiohookKey.Delete);
  await wait(700);

  uIOhook.keyToggle(UiohookKey.Ctrl, 'down');
  await wait(40);
  uIOhook.keyToggle(UiohookKey.Meta, 'down');
  await wait(500);

  const player = spawn('powershell.exe', [
    '-NoProfile', '-Command',
    `(New-Object System.Media.SoundPlayer '${sample}').PlaySync()`,
  ], { windowsHide: true });
  await new Promise((r) => { player.on('exit', r); setTimeout(r, 15000); });

  await wait(500);
  uIOhook.keyToggle(UiohookKey.Meta, 'up');
  await wait(40);
  uIOhook.keyToggle(UiohookKey.Ctrl, 'up');

  await wait(4000);
  uIOhook.stop();
  process.exit(0);
})();

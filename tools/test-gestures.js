// Drives the Ctrl+Win gestures by synthesising key transitions, so the
// hold / double-tap / tap-to-stop logic can be exercised without a human.
//
// Usage: node tools/test-gestures.js hold|double
const { uIOhook, UiohookKey } = require('uiohook-napi');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const CTRL = UiohookKey.Ctrl;
const WIN = UiohookKey.Meta;

async function comboDown() {
  uIOhook.keyToggle(CTRL, 'down');
  await wait(20);
  uIOhook.keyToggle(WIN, 'down');
}

async function comboUp() {
  uIOhook.keyToggle(WIN, 'up');
  await wait(20);
  uIOhook.keyToggle(CTRL, 'up');
}

async function tap() {
  await comboDown();
  await wait(80);          // well under the 350ms hold threshold
  await comboUp();
}

(async () => {
  const mode = process.argv[2] || 'hold';
  uIOhook.start();
  await wait(400);

  if (mode === 'hold') {
    console.log('HOLD: pressing for 2.5s');
    await comboDown();
    await wait(2500);
    await comboUp();
    console.log('released');
  } else {
    console.log('DOUBLE TAP: two quick taps to lock');
    await tap();
    await wait(150);       // inside the 450ms double-tap window
    await tap();
    console.log('locked; recording for 3s');
    await wait(3000);
    console.log('single tap to stop');
    await tap();
  }

  await wait(600);
  uIOhook.stop();
  process.exit(0);
})();

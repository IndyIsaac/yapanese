'use strict';

/**
 * The keyboard hook, isolated in its own process.
 *
 * Two reasons it does not live in the main process any more:
 *
 * 1. Nothing else runs here. The gesture timings (350ms hold, 450ms double
 *    tap) are measured against this loop, so window work, IPC and GC in the
 *    main process can no longer skew them.
 *
 * 2. This process also *sends* the paste keystroke. That matters: Ctrl is
 *    part of the default combo, so the synthesised Ctrl+V used to feed
 *    straight back into the hotkey state machine and corrupt it. Owning both
 *    ends means the synthetic keys can be ignored at the source.
 */

const { uIOhook, UiohookKey } = require('uiohook-napi');
const gestures = require('./gestures');
const { comboName } = require('./combos');

// utilityProcess gives us parentPort; a plain child_process.fork gives us
// process.send. Supporting both keeps the process testable outside Electron.
const viaParentPort = !!process.parentPort;
const send = (msg) => {
  try {
    if (viaParentPort) process.parentPort.postMessage(msg);
    else process.send?.(msg);
  } catch {}
};
const onMessage = (fn) => {
  if (viaParentPort) process.parentPort.on('message', (e) => fn(e.data));
  else process.on('message', fn);
};

/**
 * Keys we synthesised ourselves arrive back through our own hook. uiohook
 * does not surface the injected-event flag, so the workable defence is a
 * short window around the send during which input is ignored.
 */
let suppressUntil = 0;
const suppressed = () => Date.now() < suppressUntil;

const g = gestures.create({
  onStart: () => send({ type: 'start' }),
  onFinish: () => send({ type: 'finish' }),
  onLockChanged: (locked) => send({ type: 'lock', locked }),
  log: (...parts) => send({ type: 'log', line: parts.join(' ') }),
});

function paste() {
  suppressUntil = Date.now() + 400;
  try {
    uIOhook.keyTap(UiohookKey.V, [UiohookKey.Ctrl]);
    send({ type: 'paste:done', ok: true });
  } catch (err) {
    send({ type: 'paste:done', ok: false, error: err.message });
  } finally {
    // Hold the window open past the tap so the trailing key-ups are ignored
    // too, then let the machine see real input again. Kept short: this is a
    // dead zone in which the user cannot start the next dictation, and the
    // synthetic key-ups land within a few milliseconds of the tap.
    suppressUntil = Date.now() + 150;
  }
}

onMessage((msg) => {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'combo':
      send({ type: 'combo:set', name: g.setCombo(msg.combo) });
      break;
    case 'reset':
      g.reset();
      break;
    case 'paste':
      paste();
      break;
    case 'stop':
      try { uIOhook.stop(); } catch {}
      process.exit(0);
      break;
    default:
      break;
  }
});

uIOhook.on('keydown', (e) => { if (!suppressed()) g.key(e.keycode, true); });
uIOhook.on('keyup', (e) => { if (!suppressed()) g.key(e.keycode, false); });

// The parent sends the real combo immediately after 'ready'; argv is not
// relied on, because utilityProcess and child_process disagree about it.
try {
  uIOhook.start();
  send({ type: 'ready', name: comboName(undefined) });
} catch (err) {
  send({ type: 'ready', error: err.message });
}

'use strict';

const { uIOhook, UiohookKey } = require('uiohook-napi');

/**
 * Global hotkey handling built on a low-level keyboard hook.
 *
 * Electron's globalShortcut cannot do either gesture this app needs: it only
 * reports key-down (so holding is undetectable) and it refuses modifier-only
 * combinations like Ctrl+Win. A hook sees every key transition, which is what
 * makes hold-to-talk and double-tap-to-lock possible.
 *
 * Gestures:
 *   hold        — record while the combo is held, finish on release
 *   double tap  — lock recording on; it runs until a single tap stops it
 *   single tap  — starts, then finishes once the double-tap window lapses
 */

// A press shorter than this counts as a tap rather than a hold.
const HOLD_THRESHOLD_MS = 350;
// A second tap inside this window locks recording on.
const DOUBLE_TAP_WINDOW_MS = 450;

const COMBOS = {
  'ctrl+win':   { name: 'Ctrl + Win',   keys: [[UiohookKey.Ctrl, UiohookKey.CtrlRight], [UiohookKey.Meta, UiohookKey.MetaRight]] },
  'ctrl+shift': { name: 'Ctrl + Shift', keys: [[UiohookKey.Ctrl, UiohookKey.CtrlRight], [UiohookKey.Shift, UiohookKey.ShiftRight]] },
  'alt+win':    { name: 'Alt + Win',    keys: [[UiohookKey.Alt, UiohookKey.AltRight], [UiohookKey.Meta, UiohookKey.MetaRight]] },
  'win':        { name: 'Win',          keys: [[UiohookKey.Meta, UiohookKey.MetaRight]] },
};

function create({ onStart, onFinish, onCancel, onLockChanged, log = () => {} }) {
  let combo = COMBOS['ctrl+win'];
  let running = false;

  const down = new Set();
  let comboActive = false;
  let pressedAt = 0;
  let lastTapAt = 0;
  let locked = false;
  let tapTimer = null;
  let recording = false;

  const groupSatisfied = (group) => group.some((code) => down.has(code));
  const comboHeld = () => combo.keys.every(groupSatisfied);

  function clearTapTimer() {
    if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; }
  }

  function beginRecording() {
    if (recording) return;
    recording = true;
    onStart();
  }

  function endRecording(reason) {
    clearTapTimer();
    if (!recording) return;
    recording = false;
    if (locked) { locked = false; onLockChanged?.(false); }
    log('hotkey: finishing —', reason);
    onFinish();
  }

  function onComboDown() {
    pressedAt = Date.now();

    // While locked, the next press is the stop gesture.
    if (locked) {
      endRecording('tap while locked');
      return;
    }
    clearTapTimer();
    beginRecording();
  }

  function onComboUp() {
    const heldMs = Date.now() - pressedAt;
    if (!recording) return;

    if (heldMs >= HOLD_THRESHOLD_MS) {
      endRecording(`held ${heldMs}ms`);
      return;
    }

    // A short tap. A second one inside the window locks recording on;
    // otherwise this was a lone tap and the recording ends when it lapses.
    const now = Date.now();
    if (now - lastTapAt < DOUBLE_TAP_WINDOW_MS) {
      lastTapAt = 0;
      locked = true;
      onLockChanged?.(true);
      log('hotkey: locked on (double tap)');
      return;
    }

    lastTapAt = now;
    clearTapTimer();
    tapTimer = setTimeout(() => {
      tapTimer = null;
      if (!locked) endRecording('single tap lapsed');
    }, DOUBLE_TAP_WINDOW_MS);
  }

  // The keydown and keyup channels are registered separately, so the
  // direction is known from which handler fired. Reading it back off
  // `event.type` is not viable: uiohook-napi does not export the
  // EventKeyPressed / EventKeyReleased names this once assumed, so that
  // comparison silently evaluated against undefined and dropped every event.
  function handle(event, isDown) {
    // Only combo members are tracked; every other key is ignored entirely.
    const relevant = combo.keys.some((group) => group.includes(event.keycode));
    if (!relevant) return;

    if (isDown) {
      if (down.has(event.keycode)) return;  // auto-repeat
      down.add(event.keycode);
    } else {
      down.delete(event.keycode);
    }

    const held = comboHeld();
    if (held && !comboActive) {
      comboActive = true;
      onComboDown();
    } else if (!held && comboActive) {
      comboActive = false;
      onComboUp();
    }
  }

  return {
    start(comboId) {
      combo = COMBOS[comboId] || COMBOS['ctrl+win'];
      if (running) return { ok: true, name: combo.name };
      try {
        uIOhook.on('keydown', (e) => handle(e, true));
        uIOhook.on('keyup', (e) => handle(e, false));
        uIOhook.start();
        running = true;
        log('hotkey: hook started for', combo.name);
        return { ok: true, name: combo.name };
      } catch (err) {
        log('hotkey: FAILED to start hook —', err.message);
        return { ok: false, error: err.message };
      }
    },

    setCombo(comboId) {
      combo = COMBOS[comboId] || COMBOS['ctrl+win'];
      down.clear();
      comboActive = false;
      locked = false;
      log('hotkey: combo set to', combo.name);
      return combo.name;
    },

    /** Called when the pipeline finishes, so state cannot get stuck. */
    reset() {
      clearTapTimer();
      recording = false;
      locked = false;
      down.clear();
      comboActive = false;
    },

    isLocked: () => locked,

    stop() {
      if (!running) return;
      try { uIOhook.stop(); } catch {}
      running = false;
    },
  };
}

module.exports = { create, COMBOS };

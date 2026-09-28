'use strict';

const { UiohookKey } = require('uiohook-napi');
const { DEFAULT_COMBO, comboName } = require('./combos');

/**
 * The hold / double-tap / tap-to-stop state machine, with no I/O of its own.
 *
 * This used to live inline in hotkeys.js alongside the hook itself. Splitting
 * it out means the timing rules can be tested directly, by feeding key
 * transitions and a fake clock, instead of only by pressing real keys.
 */

// A press shorter than this counts as a tap rather than a hold.
const HOLD_THRESHOLD_MS = 350;
/**
 * How long after releasing a tap a second one still counts as a double tap.
 *
 * Measured from the release of the first tap to the *press* of the second,
 * which is the gap a person actually controls. It used to run to the release
 * of the second tap, so the whole of that second press had to fit inside the
 * window too — on a two-key combo that meant pressing and releasing two keys
 * twice inside 450ms. Missing it did not fail visibly: the recording simply
 * ended and transcribed, which reads as the overlay vanishing for no reason.
 */
const DOUBLE_TAP_WINDOW_MS = 500;
/**
 * A release that is undone inside this long never happened.
 *
 * Something on some machines (keyboard software such as Razer Synapse is the
 * likely suspect) injects key-up/key-down pairs a few milliseconds apart. The
 * debug log showed start, lock and finish all inside 13ms of a single press:
 * the recording was killed before audio arrived, and the half-started capture
 * it left behind went on writing into every later recording. No finger lifts
 * and re-presses a key this fast, so each release is held back this long and
 * dropped if the combo comes straight back.
 */
const BOUNCE_MS = 40;

// Both the left and right physical key satisfy a group.
const COMBO_KEYS = {
  'ctrl+win': [[UiohookKey.Ctrl, UiohookKey.CtrlRight], [UiohookKey.Meta, UiohookKey.MetaRight]],
  'ctrl+shift': [[UiohookKey.Ctrl, UiohookKey.CtrlRight], [UiohookKey.Shift, UiohookKey.ShiftRight]],
  'alt+win': [[UiohookKey.Alt, UiohookKey.AltRight], [UiohookKey.Meta, UiohookKey.MetaRight]],
  'win': [[UiohookKey.Meta, UiohookKey.MetaRight]],
};

function create({
  onStart,
  onFinish,
  onLockChanged,
  log = () => {},
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let comboId = DEFAULT_COMBO;
  let keys = COMBO_KEYS[comboId];

  const down = new Set();
  let comboActive = false;
  let pressedAt = 0;
  let lastTapAt = 0;
  let locked = false;
  let tapTimer = null;
  let releaseTimer = null;
  let recording = false;

  const groupSatisfied = (group) => group.some((code) => down.has(code));
  const comboHeld = () => keys.every(groupSatisfied);

  function clearTapTimer() {
    if (tapTimer) { clearTimer(tapTimer); tapTimer = null; }
  }

  function clearReleaseTimer() {
    if (releaseTimer) { clearTimer(releaseTimer); releaseTimer = null; }
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
    pressedAt = now();

    // While locked, the next press is the stop gesture.
    if (locked) {
      endRecording('tap while locked');
      return;
    }

    // The second press of a double tap. Locking here rather than on release
    // means the confirmation lands the instant the user presses, and the
    // window only has to cover the gap between taps.
    const isSecondTap = recording && lastTapAt && (pressedAt - lastTapAt) < DOUBLE_TAP_WINDOW_MS;
    clearTapTimer();
    if (isSecondTap) {
      lastTapAt = 0;
      locked = true;
      onLockChanged?.(true);
      log('hotkey: locked on (double tap)');
      return;
    }

    beginRecording();
  }

  /** Runs BOUNCE_MS late, so times are taken from the actual release. */
  function onComboUp(releasedAt) {
    if (!recording) return;
    // Releasing the second tap of a double tap must not stop anything; the
    // lock is already on and only a fresh press ends it.
    if (locked) return;

    const heldMs = releasedAt - pressedAt;
    if (heldMs >= HOLD_THRESHOLD_MS) {
      endRecording(`held ${heldMs}ms`);
      return;
    }

    // A short tap. If a second one arrives inside the window it locks on;
    // otherwise this was a lone tap and the recording ends when it lapses.
    lastTapAt = releasedAt;
    clearTapTimer();
    tapTimer = setTimer(() => {
      tapTimer = null;
      if (!locked) endRecording('single tap lapsed');
    }, Math.max(0, DOUBLE_TAP_WINDOW_MS - (now() - releasedAt)));
  }

  return {
    /** Feed one key transition. Every non-combo key is ignored outright. */
    key(keycode, isDown) {
      const relevant = keys.some((group) => group.includes(keycode));
      if (!relevant) return;

      if (isDown) {
        if (down.has(keycode)) return;  // auto-repeat
        down.add(keycode);
      } else {
        down.delete(keycode);
      }

      const held = comboHeld();
      if (held && !comboActive) {
        comboActive = true;
        // Back inside the bounce window: the release is discarded, and so is
        // this press, which is the same one continuing.
        if (releaseTimer) { clearReleaseTimer(); return; }
        onComboDown();
      } else if (!held && comboActive) {
        comboActive = false;
        const releasedAt = now();
        releaseTimer = setTimer(() => {
          releaseTimer = null;
          onComboUp(releasedAt);
        }, BOUNCE_MS);
      }
    },

    setCombo(id) {
      comboId = COMBO_KEYS[id] ? id : DEFAULT_COMBO;
      keys = COMBO_KEYS[comboId];
      clearReleaseTimer();
      down.clear();
      comboActive = false;
      locked = false;
      return comboName(comboId);
    },

    /** Called when the pipeline finishes, so state cannot get stuck. */
    reset() {
      clearTapTimer();
      clearReleaseTimer();
      recording = false;
      locked = false;
      down.clear();
      comboActive = false;
    },

    isLocked: () => locked,
    isRecording: () => recording,
  };
}

module.exports = { create, COMBO_KEYS, HOLD_THRESHOLD_MS, DOUBLE_TAP_WINDOW_MS, BOUNCE_MS };

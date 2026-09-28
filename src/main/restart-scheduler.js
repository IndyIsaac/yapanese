'use strict';

/**
 * Restarts into a downloaded update once the app has been left alone.
 *
 * Kept free of Electron so the timing can be tested with a fake clock, the
 * same way the gesture rules are.
 *
 * The rule is continuous idleness, not a single idle moment: a restart takes
 * a few seconds, and landing one just as somebody finishes a dictation and
 * reaches for the key again would swallow the next one. The caller reports
 * every change between busy and idle as it happens, and each one starts the
 * count over. An earlier version sampled a busy flag every five seconds
 * instead, and a short dictation that began and ended between two samples
 * went unnoticed.
 */

// Long enough that a pause between dictations does not count, short enough
// that the update is in place well before the machine is next needed.
const IDLE_MS = 30_000;

function create({
  restart,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let timer = null;
  let armed = false;
  let busy = false;

  function cancel() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  function countFromNow() {
    cancel();
    if (!armed || busy) return;
    timer = setTimer(() => {
      timer = null;
      armed = false;
      restart();
    }, IDLE_MS);
  }

  return {
    /** Start waiting for an idle stretch. Calling it again changes nothing. */
    arm() {
      if (armed) return;
      armed = true;
      countFromNow();
    },

    disarm() {
      armed = false;
      cancel();
    },

    /** Tracked whether or not armed, so arming knows where things stand. */
    setBusy(next) {
      // Only a real change counts: repeated reports of the same state would
      // otherwise keep pushing the restart back for no reason.
      if (!!next === busy) return;
      busy = !!next;
      countFromNow();
    },
  };
}

module.exports = { create, IDLE_MS };

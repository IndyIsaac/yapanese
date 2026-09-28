'use strict';

/**
 * Restarts into a downloaded update once the app has been left alone.
 *
 * Kept free of Electron so the timing can be tested with a fake clock, the
 * same way the gesture rules are.
 *
 * The rule is continuous idleness, not a single idle moment: a restart takes
 * a few seconds, and landing one just as somebody finishes a dictation and
 * reaches for the key again would swallow the next one. Any busy check along
 * the way starts the count over.
 */

// Long enough that a pause between dictations does not count, short enough
// that the update is in place well before the machine is next needed.
const IDLE_MS = 30_000;
const POLL_MS = 5_000;

function create({
  isBusy,
  restart,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let timer = null;
  let idleSince = null;
  let fired = false;

  function poll() {
    timer = null;
    if (isBusy()) {
      idleSince = null;
    } else if (idleSince === null) {
      idleSince = now();
    } else if (now() - idleSince >= IDLE_MS) {
      fired = true;
      restart();
      return;
    }
    timer = setTimer(poll, POLL_MS);
  }

  return {
    /** Start waiting for an idle stretch. Calling it again changes nothing. */
    arm() {
      if (timer || fired) return;
      idleSince = isBusy() ? null : now();
      timer = setTimer(poll, POLL_MS);
    },

    disarm() {
      if (timer) clearTimer(timer);
      timer = null;
      idleSince = null;
    },
  };
}

module.exports = { create, IDLE_MS, POLL_MS };

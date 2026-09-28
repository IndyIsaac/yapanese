'use strict';

const fs = require('node:fs');

/**
 * Tells the next launch that it is the app coming back from an automatic
 * update, so it stays in the tray instead of opening its window.
 *
 * electron-updater relaunches the app with no arguments, so there is no way
 * to pass `--hidden` through the installer. A timestamp file does the job,
 * and the timestamp is what keeps it honest: if the install fails and the app
 * never restarts, a marker left lying around must not hide the window the next
 * time the user opens Yapanese themselves, possibly days later.
 */

// The installer runs in seconds. Anything older did not come from it.
const MAX_AGE_MS = 2 * 60 * 1000;

function create({ file, now = Date.now }) {
  function clear() {
    try { fs.rmSync(file, { force: true }); } catch {}
  }

  return {
    mark() {
      try { fs.writeFileSync(file, String(now())); } catch {}
    },

    clear,

    /** Whether this launch is the quiet relaunch. Only ever true once. */
    consume() {
      let written;
      try { written = Number(fs.readFileSync(file, 'utf8')); } catch { return false; }
      clear();
      const age = now() - written;
      return Number.isFinite(written) && age >= 0 && age < MAX_AGE_MS;
    },
  };
}

module.exports = { create, MAX_AGE_MS };

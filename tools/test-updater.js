// Runs the real updater.js against stand-ins for electron and electron-updater,
// so the unattended paths — background download, restart when idle, a failed
// install — are checked without a release or an installed build.
//
// Usage: node tools/test-updater.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

// Swapped per scenario; require() of either name returns whatever is current.
let fakeElectron = null;
let fakeUpdaterModule = null;
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return fakeElectron;
  if (request === 'electron-updater') return fakeUpdaterModule;
  return realLoad.call(this, request, ...rest);
};

const UPDATER = require.resolve('../src/main/updater');
const scheduler = require('../src/main/restart-scheduler');

async function scenario({ autoDownload = false, installThrows = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yap-updater-'));
  const calls = { check: 0, download: 0, install: [] };

  const autoUpdater = new EventEmitter();
  autoUpdater.checkForUpdates = async () => { calls.check++; };
  autoUpdater.downloadUpdate = async () => { calls.download++; };
  autoUpdater.quitAndInstall = (...args) => {
    calls.install.push(args);
    if (installThrows) throw new Error('installer blocked');
  };

  fakeElectron = { app: { isPackaged: true, isQuitting: false, getPath: () => dir } };
  fakeUpdaterModule = { autoUpdater };

  // Fake clock for the restart countdown only.
  let clock = 0;
  const timers = new Map();
  let nextTimer = 1;

  delete require.cache[UPDATER];
  const updater = require(UPDATER);
  const settings = { autoDownload };
  const statuses = [];
  updater.start({
    onStatus: (s) => statuses.push(s.state),
    autoDownload: () => settings.autoDownload,
    setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimer: (id) => timers.delete(id),
  });

  // The app's first check is what attaches to electron-updater, and every
  // event after it depends on that, so each scenario starts the same way.
  await updater.check();
  calls.check = 0;

  return {
    updater, autoUpdater, calls, settings, statuses, dir,
    app: fakeElectron.app,
    marker: () => fs.existsSync(path.join(dir, 'relaunch-quietly')),
    advance(ms) {
      const target = clock + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (!next || t.at < next[1].at)) next = [id, t];
        }
        if (!next) break;
        timers.delete(next[0]);
        clock = next[1].at;
        next[1].fn();
      }
      clock = target;
    },
    // quitAndInstall runs on setImmediate.
    flush: () => new Promise((r) => setImmediate(r)),
    available() { autoUpdater.emit('update-available', { version: '9.9.9' }); },
    downloaded() { autoUpdater.emit('update-downloaded', { version: '9.9.9' }); },
    done() { updater.stop(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const IDLE = scheduler.IDLE_MS;

(async () => {
  // 1. Downloaded and left idle: restarts silently into it, quietly.
  {
    const s = await scenario();
    s.available(); s.downloaded();
    s.advance(IDLE - 1); await s.flush();
    check('downloaded -> no restart before the idle period', s.calls.install.length, 0);
    s.advance(1); await s.flush();
    check('downloaded -> silent install and relaunch after idle', s.calls.install, [[true, true]]);
    check('automatic restart -> marks the relaunch as quiet', s.marker(), true);
    check('automatic restart -> app is quitting', s.app.isQuitting, true);
    s.done();
  }

  // 2. Busy with a dictation, a model install or a re-transcription.
  {
    const s = await scenario();
    s.available(); s.downloaded();
    s.updater.setBusy(true);
    s.advance(IDLE * 3); await s.flush();
    check('busy -> no restart', s.calls.install.length, 0);
    s.updater.setBusy(false);
    s.advance(IDLE); await s.flush();
    check('busy then idle -> restarts after a full idle period', s.calls.install.length, 1);
    s.done();
  }

  // 3. "Check now" with an update already downloaded does not knock it out of
  //    "ready", which used to leave the pending restart unable to fire.
  {
    const s = await scenario();
    s.available(); s.downloaded();
    await s.updater.check({ silent: false });
    check('check while ready -> does not ask GitHub again', s.calls.check, 0);
    check('check while ready -> still ready', s.updater.current().state, 'ready');
    s.advance(IDLE); await s.flush();
    check('check while ready -> restart still happens', s.calls.install.length, 1);
    s.done();
  }

  // 4. Background downloads on: an update found is fetched without a click,
  //    and only once.
  {
    const s = await scenario({ autoDownload: true });
    s.available();
    await s.flush();
    check('auto download on -> downloads when found', s.calls.download, 1);
    await s.updater.download();
    check('auto download on -> button press does not start a second one', s.calls.download, 1);
    s.done();
  }

  // 5. Off: nothing downloads until asked. Turning it on with one waiting
  //    fetches it straight away.
  {
    const s = await scenario({ autoDownload: false });
    s.available();
    await s.flush();
    check('auto download off -> waits to be asked', s.calls.download, 0);
    s.settings.autoDownload = true;
    s.updater.settingsChanged();
    await s.flush();
    check('switched on with one waiting -> downloads now', s.calls.download, 1);
    s.done();
  }

  // 6. The installer fails to start: the app carries on as it was and tries
  //    again after the next idle stretch.
  {
    const s = await scenario({ installThrows: true });
    s.available(); s.downloaded();
    s.advance(IDLE); await s.flush();
    check('install failed -> it was attempted', s.calls.install.length, 1);
    check('install failed -> app no longer marked as quitting', s.app.isQuitting, false);
    check('install failed -> no quiet-relaunch marker left behind', s.marker(), false);
    check('install failed -> update still ready', s.updater.current().state, 'ready');
    s.advance(IDLE); await s.flush();
    check('install failed -> tried again after another idle period', s.calls.install.length, 2);
    s.done();
  }

  // 7. "Restart now" is the user's own choice: it shows the window after.
  {
    const s = await scenario();
    s.available(); s.downloaded();
    s.updater.install();
    await s.flush();
    check('restart now -> installs', s.calls.install.length, 1);
    check('restart now -> relaunch is not quiet', s.marker(), false);
    s.done();
  }

  console.log(failures === 0 ? '\nall updater tests passed' : `\n${failures} FAILING`);
  process.exit(failures === 0 ? 0 : 1);
})();

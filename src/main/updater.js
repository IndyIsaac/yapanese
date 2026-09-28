'use strict';

const path = require('node:path');
const { app } = require('electron');
const restartScheduler = require('./restart-scheduler');
const quietRelaunch = require('./quiet-relaunch');

/**
 * Updates.
 *
 * Most people using this will never visit the repository, will not find out
 * that a bug they hit was fixed a week ago, and should not have to. So the app
 * asks GitHub whether there is a newer release, tells the user in one
 * sentence, and does the rest on one click.
 *
 * Nothing is downloaded without being asked for, unless the user has turned
 * on background downloads in Settings. An app that quietly pulls a hundred
 * megabytes over somebody's tethered connection has made a decision that was
 * not its to make — and this one is otherwise scrupulous about not touching
 * the network. Off by default for that reason.
 *
 * Once an update is downloaded it installs itself: the app restarts into it
 * after half a minute of not being used, so a dictation is never cut off.
 *
 * Every state change is reported through `onStatus`, and the shape is always
 * the same: `{ state, version?, percent?, error? }`.
 *
 *   idle          nothing known yet
 *   checking      asking GitHub
 *   none          this is the newest release
 *   available     a newer release exists, waiting for the user to say yes
 *   downloading   fetching it, `percent` is 0-100
 *   ready         downloaded and verified, needs a restart to apply
 *   error         the check or the download failed, `error` says how
 */

// Long enough that a machine left running for a week still notices, short
// enough to be pointless to think about. The check is a single small request.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Not at the instant of launch: the first seconds belong to the window
// appearing and the keyboard hook starting.
const FIRST_CHECK_DELAY_MS = 12_000;

let updater = null;
let status = { state: 'idle' };
let report = () => {};
let logLine = () => {};
let timer = null;
let autoDownload = () => false;
let restarter = null;
let relaunch = null;

// An installer that will not start is not retried forever in the background;
// "Restart now" still works after this many.
const MAX_AUTO_ATTEMPTS = 3;
let autoAttempts = 0;

function set(next) {
  status = next;
  report(status);
}

/**
 * electron-updater only makes sense against an installed build. Run from
 * source there is no installer to replace, and asking it to try produces a
 * confusing error about a missing app-update.yml rather than a no-op.
 */
function supported() {
  return app.isPackaged;
}

function attach() {
  if (updater) return updater;
  const { autoUpdater } = require('electron-updater');
  updater = autoUpdater;

  // Both off: electron-updater's own versions of these would download
  // regardless of the setting and install on quit mid-whatever. Downloading
  // is decided by maybeAutoDownload() and installing by the restart
  // scheduler, which waits for the app to be idle.
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.logger = null;

  updater.on('error', (err) => {
    // A failed check is not worth interrupting anyone over — no network, a
    // rate limit, GitHub having a bad afternoon. It is recorded and the next
    // check tries again.
    logLine('update: error —', err?.message || String(err));
    set({ state: 'error', error: err?.message || 'Could not reach the update server.' });
  });

  updater.on('checking-for-update', () => set({ state: 'checking' }));

  updater.on('update-available', (info) => {
    logLine('update: available —', info.version);
    set({ state: 'available', version: info.version, notes: releaseNotes(info) });
    maybeAutoDownload();
  });

  updater.on('update-not-available', () => set({ state: 'none' }));

  updater.on('download-progress', (p) => {
    set({ state: 'downloading', version: status.version, percent: Math.round(p.percent) });
  });

  updater.on('update-downloaded', (info) => {
    logLine('update: downloaded —', info.version);
    set({ state: 'ready', version: info.version, notes: releaseNotes(info) });
    logLine('update: will restart after', restartScheduler.IDLE_MS / 1000, 's idle');
    autoAttempts = 0;
    restarter?.arm();
  });

  return updater;
}

/**
 * GitHub release bodies are markdown and can be pages long. The prompt wants
 * a sentence, so this takes the first real line and leaves the rest to the
 * "what changed" link.
 */
function releaseNotes(info) {
  const raw = typeof info?.releaseNotes === 'string' ? info.releaseNotes : '';
  if (!raw) return '';
  const firstLine = raw
    .replace(/<[^>]+>/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s*#>-]+/, '').trim())
    .find((l) => l.length > 0) || '';
  return firstLine.length > 160 ? `${firstLine.slice(0, 158)}…` : firstLine;
}

/**
 * The one place the background-download setting is applied. Read at the
 * moment it matters, so switching it takes effect without a restart.
 */
function maybeAutoDownload() {
  if (status.state !== 'available' || !autoDownload()) return;
  logLine('update: downloading in the background');
  download();
}

async function check({ silent = true } = {}) {
  if (!supported()) {
    set({ state: 'none', unsupported: true });
    return status;
  }
  // Asking again with one already fetched moves the status off "ready", and
  // the waiting restart would then refuse to run.
  if (status.state === 'ready' || status.state === 'downloading') return status;
  try {
    await attach().checkForUpdates();
  } catch (err) {
    logLine('update: check failed —', err?.message || String(err));
    if (!silent) set({ state: 'error', error: err?.message || 'Could not check for updates.' });
  }
  return status;
}

async function download() {
  if (!supported()) return { ok: false, error: 'Updates only apply to an installed copy.' };
  // A background download may already be under way when the button is
  // pressed, or be done.
  if (status.state === 'downloading' || status.state === 'ready') return { ok: true };
  try {
    set({ state: 'downloading', version: status.version, percent: 0 });
    await attach().downloadUpdate();
    return { ok: true };
  } catch (err) {
    const message = err?.message || 'The update could not be downloaded.';
    logLine('update: download failed —', message);
    set({ state: 'error', error: message });
    return { ok: false, error: message };
  }
}

/**
 * Restart into the new version.
 *
 * `isSilent: true` skips the installer's wizard: either the user pressed
 * "Restart now", or they left the app idle with an update waiting, which the
 * update bar says will install it. The second argument reopens the app
 * afterwards. `quiet` is the automatic case, whose relaunch stays in the tray
 * rather than opening a window over whatever the user is doing.
 */
function install({ quiet = false } = {}) {
  if (!supported() || status.state !== 'ready') return { ok: false };
  logLine('update: installing', status.version, quiet ? '(automatic)' : '');
  restarter?.disarm();
  if (quiet) relaunch?.mark();
  app.isQuitting = true;
  setImmediate(() => {
    try {
      attach().quitAndInstall(true, true);
    } catch (err) {
      // Still running, so nothing about quitting may linger: the window's
      // close button would quit the app instead of hiding it to the tray.
      logLine('update: install failed —', err?.message || String(err));
      app.isQuitting = false;
      relaunch?.clear();
      if (quiet && autoAttempts < MAX_AUTO_ATTEMPTS) restarter?.arm();
    }
  });
  return { ok: true };
}

/**
 * `autoDownload` reads the setting. `setTimer`/`clearTimer` exist for tests.
 * Busy and idle are reported separately, through setBusy(), as they change.
 */
function start({ onStatus, log, autoDownload: shouldAutoDownload, setTimer, clearTimer }) {
  report = onStatus || (() => {});
  logLine = log || (() => {});
  if (shouldAutoDownload) autoDownload = shouldAutoDownload;

  if (!supported()) {
    logLine('update: skipped — not a packaged build');
    return;
  }

  relaunch = quietRelaunch.create({ file: quietRelaunchFile() });
  restarter = restartScheduler.create({
    restart: () => {
      autoAttempts++;
      logLine('update: idle, restarting into', status.version);
      install({ quiet: true });
    },
    ...(setTimer && { setTimer }),
    ...(clearTimer && { clearTimer }),
  });
  setTimeout(() => check(), FIRST_CHECK_DELAY_MS);
  timer = setInterval(() => {
    // Nothing to look for once one is already downloaded and waiting.
    if (status.state === 'ready' || status.state === 'downloading') return;
    check();
  }, CHECK_INTERVAL_MS);
}

function quietRelaunchFile() {
  return path.join(app.getPath('userData'), 'relaunch-quietly');
}

/**
 * Whether this launch is the app coming back from an automatic update. Read
 * once, at startup; works before start() has run.
 */
function consumeQuietRelaunch() {
  return quietRelaunch.create({ file: quietRelaunchFile() }).consume();
}

/** Called by main whenever a dictation, a model install or a
 *  re-transcription starts or finishes. */
function setBusy(busy) {
  restarter?.setBusy(busy);
}

function stop() {
  clearInterval(timer);
  timer = null;
  restarter?.disarm();
}

module.exports = {
  start, stop, check, download, install, setBusy, consumeQuietRelaunch,
  settingsChanged: maybeAutoDownload,
  current: () => status,
};

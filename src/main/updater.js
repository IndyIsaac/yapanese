'use strict';

const { app } = require('electron');

/**
 * Updates.
 *
 * Most people using this will never visit the repository, will not find out
 * that a bug they hit was fixed a week ago, and should not have to. So the app
 * asks GitHub whether there is a newer release, tells the user in one
 * sentence, and does the rest on one click.
 *
 * Nothing is downloaded without being asked for. An app that quietly pulls a
 * hundred megabytes over somebody's tethered connection has made a decision
 * that was not its to make — and this one is otherwise scrupulous about not
 * touching the network.
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

  // Both off deliberately: the user decides when to download, and an install
  // that happens silently on quit would change the app under somebody who
  // never agreed to it.
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
  });

  updater.on('update-not-available', () => set({ state: 'none' }));

  updater.on('download-progress', (p) => {
    set({ state: 'downloading', version: status.version, percent: Math.round(p.percent) });
  });

  updater.on('update-downloaded', (info) => {
    logLine('update: downloaded —', info.version);
    set({ state: 'ready', version: info.version, notes: releaseNotes(info) });
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

async function check({ silent = true } = {}) {
  if (!supported()) {
    set({ state: 'none', unsupported: true });
    return status;
  }
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
 * `isSilent: true` skips the installer's wizard — the user already agreed to
 * this and does not need to click Next. The second argument reopens the app
 * afterwards, so the restart lands them back where they were.
 */
function install() {
  if (!supported() || status.state !== 'ready') return { ok: false };
  logLine('update: installing', status.version);
  app.isQuitting = true;
  setImmediate(() => attach().quitAndInstall(true, true));
  return { ok: true };
}

function start({ onStatus, log }) {
  report = onStatus || (() => {});
  logLine = log || (() => {});

  if (!supported()) {
    logLine('update: skipped — not a packaged build');
    return;
  }

  setTimeout(() => check(), FIRST_CHECK_DELAY_MS);
  timer = setInterval(() => {
    // Nothing to look for once one is already downloaded and waiting.
    if (status.state === 'ready' || status.state === 'downloading') return;
    check();
  }, CHECK_INTERVAL_MS);
}

function stop() {
  clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, check, download, install, current: () => status };

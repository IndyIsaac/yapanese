'use strict';

const {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, shell, nativeImage, screen,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { store } = require('./store');
const { transcribe } = require('./transcriber');
const { pasteIntoFocusedApp, copyToClipboard } = require('./delivery');
const { locate } = require('./tools');
const { makeTrayIcon } = require('./icon');
const { log, redact, reset: resetLog, FILE: LOG_FILE } = require('./log');
const hotkeysModule = require('./hotkeys');
const recorderModule = require('./recorder');

let mainWindow = null;
let hud = null;
let tray = null;

/** The recording currently being written to disk. Created once app is ready. */
let recording = null;
let recordingsDir = null;

/** idle | recording | transcribing */
let state = 'idle';
let recordingStartedAt = 0;

// ---------------------------------------------------------------- windows

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 940,
    height: 660,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: '#0f0f13',
    title: 'Yapanese',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0f0f13', symbolColor: '#9a9aa8', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Closing the window parks the app in the tray rather than quitting it.
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // Only ever hand the OS a web URL. shell.openExternal will happily launch
  // `file:` paths and registered Windows protocol handlers, so an unvalidated
  // url here turns any injected link into command execution.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    let scheme = '';
    try { scheme = new URL(url).protocol; } catch { scheme = ''; }
    if (scheme === 'http:' || scheme === 'https:') shell.openExternal(url);
    else log('blocked external open for scheme', JSON.stringify(scheme));
    return { action: 'deny' };
  });
}

/**
 * The overlay that appears while dictating. It hosts the audio capture, so it
 * is created at startup and kept alive hidden — a cold window would add
 * hundreds of milliseconds to the start of every recording.
 *
 * `focusable: false` is what keeps the principle intact: the app must never
 * take focus from the window that is about to receive the text.
 */
function createHud() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  // Wide enough that a result or error message fits without being clipped by
  // the window bounds; the pill itself stays centred and only as wide as its
  // content needs.
  const w = 460;
  const h = 96;

  hud = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round((width - w) / 2),
    y: height - h - 56,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  hud.setAlwaysOnTop(true, 'screen-saver');
  hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hud.loadFile(path.join(__dirname, '..', 'renderer', 'hud.html'));

  hud.webContents.on('did-finish-load', () => log('hud: loaded'));
  hud.webContents.on('did-fail-load', (_e, code, desc) => log('hud: FAILED TO LOAD', code, desc));
  // Electron 37 moved these fields onto the event object and deprecated the
  // positional arguments, which still arrive in 43. Prefer the object so this
  // keeps working when they are finally dropped.
  hud.webContents.on('console-message', (details, level, message, line, source) => {
    const lvl = details?.level ?? level;
    const msg = details?.message ?? message;
    const ln = details?.lineNumber ?? line;
    const src = details?.sourceId ?? source;
    log(`hud console[${lvl}]:`, msg, `(${String(src).split(/[\\/]/).pop()}:${ln})`);
  });
  hud.webContents.on('render-process-gone', (_e, details) => log('hud: RENDERER GONE', details));
}

function showMainWindow(view) {
  if (!mainWindow) createMainWindow();
  if (view) mainWindow.webContents.send('navigate', view);
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------- state

function setState(next, detail = {}) {
  state = next;
  hud?.webContents.send('state', { state: next, ...detail });
  mainWindow?.webContents.send('state', { state: next, ...detail });
  updateTray();

  if (next === 'recording') {
    hud?.showInactive();
  } else if (next === 'idle') {
    // Leave the result on screen briefly so the user sees it landed.
    setTimeout(() => { if (state === 'idle') hud?.hide(); }, detail.linger ?? 1400);
  }
}

async function startRecording() {
  log('startRecording: state =', state, 'hud =', hud ? 'present' : 'MISSING');
  if (state !== 'idle') return;
  const settings = store.settings();
  recordingStartedAt = Date.now();

  // Opened before the renderer is told to capture, so the first chunk to
  // arrive already has somewhere to land.
  try {
    const { path: file } = recording.start();
    log('recording ->', file);
  } catch (err) {
    log('recording: could not open a file —', err.message);
    setState('idle', { error: `Could not start recording: ${err.message}`, linger: 4000 });
    return;
  }

  setState('recording');
  hud?.webContents.send('capture:start', {
    deviceLabel: settings.micDevice,
    skipSilence: !!process.env.YAPANESE_FAKE_TRANSCRIPT,
  });
  log('startRecording: sent capture:start, device =', settings.micDevice || '(default)');
}

function stopRecording() {
  log('stopRecording: state =', state);
  if (state !== 'recording') return;
  setState('transcribing');
  hud?.webContents.send('capture:stop');
}

function toggleRecording() {
  log('HOTKEY FIRED: state =', state);
  if (state === 'recording') stopRecording();
  else if (state === 'idle') startRecording();
  else log('toggleRecording: ignored, busy in state', state);
}

// ---------------------------------------------------------------- hotkeys

let hotkeys = null;
let hookOk = false;

async function setupHotkeys() {
  hotkeys = hotkeysModule.create({
    onStart: () => startRecording(),
    onFinish: () => stopRecording(),
    onLockChanged: (locked) => {
      hud?.webContents.send('lock', locked);
      log('hotkey: lock =', locked);
    },
    log,
  });

  const res = await hotkeys.start(store.settings().combo);
  hookOk = res.ok;
  return res;
}

// ---------------------------------------------------------------- tray

function updateTray() {
  if (!tray) return;
  tray.setImage(makeTrayIcon(state));
  tray.setToolTip(
    state === 'recording' ? 'Yapanese — recording'
      : state === 'transcribing' ? 'Yapanese — transcribing'
      : 'Yapanese'
  );
}

function buildTray() {
  tray = new Tray(makeTrayIcon('idle'));
  const menu = Menu.buildFromTemplate([
    { label: 'Start / stop dictation', click: toggleRecording },
    { type: 'separator' },
    { label: 'History', click: () => showMainWindow('history') },
    { label: 'Settings', click: () => showMainWindow('settings') },
    { type: 'separator' },
    { label: 'Quit Yapanese', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => showMainWindow('history'));
  updateTray();
}

// ---------------------------------------------------------------- pipeline

/**
 * Audio arrives roughly once a second and goes straight to disk, so neither
 * process holds more than a second of it however long the recording runs.
 */
ipcMain.on('capture:chunk', (_e, bytes) => {
  if (!recording?.isOpen()) return;
  try {
    recording.append(Buffer.from(bytes));
  } catch (err) {
    log('recording: append failed —', err.message);
  }
});

ipcMain.on('capture:result', async (_e, { sampleRate, sampleCount, peak, rms }) => {
  const durationMs = Date.now() - recordingStartedAt;
  const settings = store.settings();

  const file = recording?.finish();
  if (!file) {
    log('capture:result — no recording was open');
    hotkeys?.reset();
    setState('idle', { error: 'The recording was lost before it could be saved.', linger: 4000 });
    return;
  }
  log('capture:result —', `${(file.bytes / 1048576).toFixed(1)} MB on disk,`,
      `${file.durationSeconds.toFixed(1)}s @`, sampleRate, 'Hz | peak =',
      (peak ?? 0).toFixed(4), '| rms =', (rms ?? 0).toFixed(5));

  const result = await transcribe({
    wavPath: file.path,
    durationSeconds: file.durationSeconds,
    settings,
  });
  if (result.command) log('command:', result.command);
  log('transcribe ->', result.ok ? `ok in ${result.elapsedMs}ms: ${redact(result.text)}`
                                 : `error: ${result.error}`);

  if (!result.ok) {
    // Silence is a normal outcome and there is nothing in the audio worth
    // keeping. Anything else means the words are still only in this file, so
    // it goes into history as unfinished — visible, and transcribable later,
    // rather than a file the user has no way of knowing about.
    if (result.noSpeech) {
      recorderModule.discard(file.path);
    } else {
      addUnfinished({ startedAt: recordingStartedAt, durationMs, audioPath: file.path });
      log('recording kept as an unfinished history entry:', file.path);
      mainWindow?.webContents.send('history:changed');
    }

    hotkeys?.reset();
    setState('idle', { error: result.error, linger: 4000 });
    mainWindow?.webContents.send('toast', { kind: 'error', message: result.error });
    return;
  }

  // Written before delivery is attempted: a failed paste must never lose text.
  const entry = store.addEntry({
    id: crypto.randomUUID(),
    startedAt: new Date(recordingStartedAt).toISOString(),
    durationMs,
    text: result.text,
    delivered: 'saved',
  });

  // The transcript is safely in history now, so the audio has done its job.
  recorderModule.discard(file.path);

  const delivery = settings.autoPaste
    ? await pasteIntoFocusedApp(result.text, () => hotkeys.paste())
    : copyToClipboard(result.text);

  store.updateEntry(entry.id, { delivered: delivery.mode });

  hotkeys?.reset();
  // Outlasts the HUD's own 1800ms dismissal so the "Pasted · N words"
  // confirmation is readable and gets to fade out rather than being cut off
  // when the window is hidden underneath it.
  setState('idle', {
    text: result.text,
    delivered: delivery.mode,
    elapsedMs: result.elapsedMs,
    linger: 2100,
  });
  mainWindow?.webContents.send('history:changed');
  if (!delivery.ok && delivery.error) {
    mainWindow?.webContents.send('toast', { kind: 'warn', message: delivery.error });
  }
});

ipcMain.on('capture:error', (_e, { message }) => {
  log('capture:error —', message);
  // A failed or silent capture has nothing worth recovering, so the file is
  // thrown away rather than offered back on the next launch.
  recording?.abort();
  hotkeys?.reset();
  setState('idle', { error: message, linger: 4000 });
  mainWindow?.webContents.send('toast', { kind: 'error', message });
});

ipcMain.on('capture:level', (_e, level) => {
  hud?.webContents.send('level', level);
});

// ---------------------------------------------------------------- recovery

function describeLength(seconds) {
  if (seconds < 90) return `${Math.round(seconds)} seconds`;
  const mins = Math.round(seconds / 60);
  return `${mins} minute${mins === 1 ? '' : 's'}`;
}

/**
 * Record audio that has no transcript yet as an ordinary history entry.
 *
 * Everything that was captured should be findable in one place. A recording
 * that failed or was interrupted is still something the user said, so it goes
 * in the list marked unfinished, holding the audio until it is transcribed.
 */
function addUnfinished({ startedAt, durationMs, audioPath }) {
  return store.addEntry({
    id: crypto.randomUUID(),
    startedAt: new Date(startedAt).toISOString(),
    durationMs,
    text: '',
    state: 'unfinished',
    audioPath,
    delivered: 'saved',
  });
}

/** Bring anything a crash or a forced quit left behind into history. */
function importOrphans() {
  const orphans = recorderModule.listOrphans({
    dir: recordingsDir,
    except: recording?.currentPath() ?? null,
  });
  if (orphans.length === 0) return [];

  const known = new Set(store.history().map((e) => e.audioPath).filter(Boolean));
  const added = [];
  for (const o of orphans) {
    if (known.has(o.path)) continue;
    added.push(addUnfinished({
      startedAt: o.startedAt,
      durationMs: Math.round(o.durationSeconds * 1000),
      audioPath: o.path,
    }));
  }
  if (added.length) log('recovery: imported', added.length, 'unfinished recording(s) into history');
  return added;
}

/**
 * Tell the window about it rather than putting a dialog in front of everything.
 * The renderer scrolls to the entry and marks it, so the notice leads somewhere
 * instead of just being dismissed.
 */
function announceRecovered(added) {
  if (!added.length) return;
  const seconds = added.reduce((n, e) => n + (e.durationMs || 0), 0) / 1000;
  const message = added.length === 1
    ? `Recovered ${describeLength(seconds)} of audio from earlier — it is in your history below.`
    : `Recovered ${added.length} unfinished recordings — they are in your history below.`;

  const send = () => {
    mainWindow?.webContents.send('history:changed');
    mainWindow?.webContents.send('recovered', { ids: added.map((e) => e.id), message });
  };
  if (mainWindow && !mainWindow.webContents.isLoading()) send();
  else mainWindow?.webContents.once('did-finish-load', send);
}

// ---------------------------------------------------------------- ipc api

ipcMain.handle('settings:get', () => store.settings());

ipcMain.handle('settings:set', (_e, patch) => {
  const next = store.updateSettings(patch);
  if ('combo' in patch) {
    const name = hotkeys?.setCombo(patch.combo);
    mainWindow?.webContents.send('toast', { kind: 'good', message: `Shortcut set to ${name}.` });
  }
  if ('launchAtLogin' in patch) {
    app.setLoginItemSettings({ openAtLogin: !!patch.launchAtLogin, args: ['--hidden'] });
  }
  return next;
});

ipcMain.handle('history:get', () => store.history());
// Any audio held by a deleted entry goes with it. Leaving the file behind
// would bring the entry straight back as a recovery on the next launch.
ipcMain.handle('history:delete', (_e, id) => {
  const entry = store.history().find((x) => x.id === id);
  if (entry?.audioPath) recorderModule.discard(entry.audioPath);
  store.deleteEntry(id);
  return store.history();
});

ipcMain.handle('history:clear', () => {
  for (const e of store.history()) if (e.audioPath) recorderModule.discard(e.audioPath);
  store.clearHistory();
  return [];
});
ipcMain.handle('history:copy', (_e, text) => copyToClipboard(text));

/** Turn an unfinished entry into a real transcript, on demand. */
ipcMain.handle('history:transcribe', async (_e, id) => {
  const entry = store.history().find((x) => x.id === id);
  if (!entry?.audioPath) return { ok: false, error: 'That recording is no longer available.' };
  if (!fs.existsSync(entry.audioPath)) {
    store.updateEntry(id, { state: 'lost', audioPath: null });
    return { ok: false, error: 'The audio for that recording is missing.', history: store.history() };
  }

  const result = await transcribe({
    wavPath: entry.audioPath,
    durationSeconds: (entry.durationMs || 0) / 1000,
    settings: store.settings(),
  });
  log('history:transcribe ->', result.ok ? `ok: ${redact(result.text)}` : `error: ${result.error}`);

  if (!result.ok) {
    // Left as unfinished on purpose: the audio is still the only copy.
    return { ok: false, error: result.error };
  }

  store.updateEntry(id, { text: result.text, state: 'done', audioPath: null });
  recorderModule.discard(entry.audioPath);
  return { ok: true, history: store.history() };
});

ipcMain.handle('record:toggle', () => { toggleRecording(); return state; });
ipcMain.handle('state:get', () => state);

ipcMain.handle('diagnostics', async () => {
  const settings = store.settings();
  const yap = await locate('yap', settings.yapPath);
  const ffmpeg = await locate('ffmpeg', settings.ffmpegPath);
  return {
    yap,
    ffmpeg,
    dataDir: store.dataDir(),
    hotkeyRegistered: hookOk,
    version: app.getVersion(),
    electron: process.versions.electron,
  };
});

ipcMain.handle('open:dataDir', () => shell.openPath(store.dataDir()));

// ---------------------------------------------------------------- lifecycle

// Windows identifies an app by this string rather than by its executable.
// Without it the taskbar button and any notifications are attributed to
// Electron's own identity instead of Yapanese. Must match build.appId.
app.setAppUserModelId('dev.yapanese.app');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(async () => {
    resetLog();
    log('app ready — log at', LOG_FILE);

    recordingsDir = path.join(app.getPath('userData'), 'recordings');
    recording = recorderModule.create({ dir: recordingsDir });

    // Instrumentation: record every permission the renderers ask for, so a
    // silent denial shows up in the log rather than as "nothing happened".
    const { session } = require('electron');
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      const granted = permission === 'media' || permission === 'audioCapture';
      log('permission requested:', permission, '->', granted ? 'granted' : 'denied');
      callback(granted);
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission) =>
      permission === 'media' || permission === 'audioCapture');

    createMainWindow();
    createHud();
    buildTray();

    require('./whisper').ensureVadModel().then((r) => {
      log('vad model:', r.ok ? (r.cached ? 'cached' : 'downloaded') : `unavailable (${r.error})`);
    });

    // Launched by Windows at login, or by the user from the Start menu.
    // Shown before the hook is awaited: starting the hook process is quick,
    // but the window must not be held hostage to it if it ever is not.
    if (!process.argv.includes('--hidden')) showMainWindow('history');

    const res = await setupHotkeys();
    if (!res.ok) {
      // The window may already have finished loading by now, in which case
      // waiting for did-finish-load would swallow the warning entirely.
      const warn = () => mainWindow?.webContents.send('toast', {
        kind: 'error',
        message: `The keyboard hook could not start (${res.error}). Hotkeys are unavailable — use the Record button.`,
      });
      if (mainWindow && !mainWindow.webContents.isLoading()) warn();
      else mainWindow?.webContents.once('did-finish-load', warn);
    }

    // Last, so a leftover recording never delays the app becoming usable.
    try { announceRecovered(importOrphans()); }
    catch (err) { log('recovery: failed —', err.message); }
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    hotkeys?.stop();
    // Quitting mid-recording keeps the audio and closes the file properly, so
    // it comes back as a clean recovery rather than a repaired one.
    if (recording?.isOpen()) {
      const left = recording.finish();
      log('quit while recording —', `${left.durationSeconds.toFixed(0)}s kept at`, left.path);
    }
  });
  app.on('window-all-closed', (e) => e.preventDefault()); // tray app: stay alive
}

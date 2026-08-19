'use strict';

const {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, shell, nativeImage, screen,
} = require('electron');
const path = require('node:path');
const crypto = require('node:crypto');

const { store } = require('./store');
const { transcribe } = require('./transcriber');
const { pasteIntoFocusedApp, copyToClipboard } = require('./delivery');
const { locate } = require('./tools');
const { makeTrayIcon } = require('./icon');
const { log, redact, reset: resetLog, FILE: LOG_FILE } = require('./log');
const hotkeysModule = require('./hotkeys');

let mainWindow = null;
let hud = null;
let tray = null;

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
  hud.webContents.on('console-message', (_e, level, message, line, source) => {
    log(`hud console[${level}]:`, message, `(${String(source).split(/[\\/]/).pop()}:${line})`);
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

function setupHotkeys() {
  hotkeys = hotkeysModule.create({
    onStart: () => startRecording(),
    onFinish: () => stopRecording(),
    onLockChanged: (locked) => {
      hud?.webContents.send('lock', locked);
      log('hotkey: lock =', locked);
    },
    log,
  });

  const res = hotkeys.start(store.settings().combo);
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

ipcMain.on('capture:result', async (_e, { samples, sampleRate, peak, rms }) => {
  const durationMs = Date.now() - recordingStartedAt;
  const settings = store.settings();
  log('capture:result —', samples?.byteLength ?? samples?.length ?? 0, 'bytes @', sampleRate,
      'Hz | peak =', (peak ?? 0).toFixed(4), '| rms =', (rms ?? 0).toFixed(5));

  const buffer = Buffer.from(samples);
  const int16 = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);

  const result = await transcribe({ samples: int16, sampleRate, settings });
  if (result.command) log('command:', result.command);
  log('transcribe ->', result.ok ? `ok in ${result.elapsedMs}ms: ${redact(result.text)}`
                                 : `error: ${result.error}`);

  if (!result.ok) {
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

  const delivery = settings.autoPaste
    ? await pasteIntoFocusedApp(result.text)
    : copyToClipboard(result.text);

  store.updateEntry(entry.id, { delivered: delivery.mode });

  hotkeys?.reset();
  setState('idle', { text: result.text, delivered: delivery.mode, elapsedMs: result.elapsedMs });
  mainWindow?.webContents.send('history:changed');
  if (!delivery.ok && delivery.error) {
    mainWindow?.webContents.send('toast', { kind: 'warn', message: delivery.error });
  }
});

ipcMain.on('capture:error', (_e, { message }) => {
  log('capture:error —', message);
  hotkeys?.reset();
  setState('idle', { error: message, linger: 4000 });
  mainWindow?.webContents.send('toast', { kind: 'error', message });
});

ipcMain.on('capture:level', (_e, level) => {
  hud?.webContents.send('level', level);
});

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
ipcMain.handle('history:delete', (_e, id) => { store.deleteEntry(id); return store.history(); });
ipcMain.handle('history:clear', () => { store.clearHistory(); return []; });
ipcMain.handle('history:copy', (_e, text) => copyToClipboard(text));

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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(() => {
    resetLog();
    log('app ready — log at', LOG_FILE);

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

    const res = setupHotkeys();
    if (!res.ok) {
      mainWindow?.webContents.once('did-finish-load', () => {
        mainWindow.webContents.send('toast', {
          kind: 'error',
          message: `The keyboard hook could not start (${res.error}). Hotkeys are unavailable — use the Record button.`,
        });
      });
    }

    // Launched by Windows at login, or by the user from the Start menu.
    if (!process.argv.includes('--hidden')) showMainWindow('history');
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    hotkeys?.stop();
  });
  app.on('window-all-closed', (e) => e.preventDefault()); // tray app: stay alive
}

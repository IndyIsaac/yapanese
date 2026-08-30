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
const setup = require('./setup');
const updater = require('./updater');
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

/**
 * The pill is one fixed size, in every state, forever.
 *
 * It used to be measured by the renderer, with the window resized to wrap
 * whatever was drawn. That is what made it grow. On a fractionally scaled
 * display — 150% here — Electron reports a window's bounds as the *enclosing*
 * DIP rectangle, so a size read back is a pixel larger than the size that was
 * set, and setting that value again rounds up once more. `setPosition` goes
 * through the same read-modify-write, so it inflates the window on every call:
 * measured, a two-second drag at 125 Hz took the window from 170x44 to
 * 469x343. The pill is centred in that window, so it slid away from the cursor
 * as the window ballooned around it, and the resize that ran when the drag
 * ended re-centred against the inflated width and flung the pill into a corner
 * — which is what read as the indicator vanishing.
 *
 * A constant size removes the read-modify-write entirely: nothing ever asks
 * the window how big it is, so nothing can round it up.
 */
// Two forms, two constants. Resting is a badge — a light and a microphone —
// and it blooms into the full pill to record.
//
// The width changing again is deliberate, and it is safe for a reason worth
// stating: the sizes below are *named constants the renderer selects between*,
// never a measurement it reports. The old bug was a feedback loop — the
// renderer measured itself, the window was set to that, and reading it back on
// a fractionally scaled display returned a value one pixel larger, which was
// then set again. Choosing between two fixed numbers cannot accumulate.
const HUD_WIDTH = { rest: 68, active: 164 };
const HUD_HEIGHT = 42;

/** How much wider the active form is on each side. The bloom is centred, so
 *  the badge's midpoint stays exactly where the user put it. */
const HUD_GROW = (HUD_WIDTH.active - HUD_WIDTH.rest) / 2;

/** rest | active — which form is on screen. */
let hudForm = 'rest';

/**
 * Where the resting badge's top-left is.
 *
 * This is the one stored position, and the active form is derived from it
 * rather than remembered separately. Growing and shrinking is therefore
 * exactly reversible: the pill always comes back to the same pixel, however
 * many times it has been through the cycle.
 */
let hudRest = null;

/** Every reposition goes through here. Passing the size explicitly on each
 *  move is the fix — `setPosition` is the call that inflates. */
function hudBoundsAt(x, y, form = hudForm) {
  return { x, y, width: HUD_WIDTH[form], height: HUD_HEIGHT };
}

/** The window's left edge for a form, given where the resting badge sits. */
function hudXFor(form, restX) {
  return form === 'active' ? restX - HUD_GROW : restX;
}

/** The inverse: the resting badge's left edge, given a window in some form. */
function hudRestXFrom(form, x) {
  return form === 'active' ? x + HUD_GROW : x;
}

/**
 * Has the window actually grown, or is this just the rounding?
 *
 * `getBounds` reports the enclosing DIP rectangle, so at 150% it comes back a
 * couple of pixels larger than the size that was set — 164x42 reads as 166x44
 * — every time, and setting it again does not change that. Comparing for
 * equality would therefore find the window "inflated" forever. The rounding is
 * bounded by the scale factor; real inflation ran to +300px, so anything past
 * a few pixels is unambiguous.
 */
const HUD_SIZE_SLACK = 6;

function hudIsInflated(b, form = hudForm) {
  return b.width > HUD_WIDTH[form] + HUD_SIZE_SLACK ||
         b.height > HUD_HEIGHT + HUD_SIZE_SLACK;
}

/**
 * Whether whisper.cpp and the models are actually present.
 *
 * Until they are, dictation is refused rather than attempted. Recording first
 * and failing afterwards is the worst version of this: the user has already
 * spoken, the words are stuck in a file, and the error arrives at the moment
 * they expected text. Better to say so before they start talking.
 */
let ready = false;

async function refreshReadiness() {
  const info = await setup.inspect();
  ready = info.ready;
  mainWindow?.webContents.send('readiness', { ready, setup: info });
  // The pill says what the app can do. An indicator that reads "Ready" on a
  // machine that cannot transcribe a word is worse than no indicator.
  hud?.webContents.send('readiness', { ready });
  updateTray();
  return info;
}

// ---------------------------------------------------------------- windows

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 940,
    height: 660,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: '#0b0b0c',
    title: 'Yapanese',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0b0c', symbolColor: '#9a9aa2', height: 40 },
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
/**
 * Keep a saved position on a screen that still exists.
 *
 * The position is remembered across sessions, and between sessions a laptop
 * gets undocked, a monitor gets unplugged, or the resolution changes. A
 * remembered point can easily end up outside every display, which looks
 * exactly like the indicator having vanished.
 */
function clampToDisplay(x, y, w, h) {
  const target = screen.getDisplayNearestPoint({ x, y }) || screen.getPrimaryDisplay();
  const area = target.workArea;
  return {
    x: Math.round(Math.min(Math.max(x, area.x), area.x + area.width - w)),
    y: Math.round(Math.min(Math.max(y, area.y), area.y + area.height - h)),
  };
}

/** Where the pill sits when the user has never moved it: bottom centre of the
 *  primary display, clear of the taskbar. */
function defaultHudPosition(w, h) {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(area.x + (area.width - w) / 2),
    y: Math.round(area.y + area.height - h - 18),
  };
}

/**
 * Put the window where the given form belongs.
 *
 * Always computed from `hudRest`, never from the window's current bounds —
 * deriving one position from another is how the pill used to walk across the
 * screen a pixel at a time.
 */
function hudPlace(form) {
  if (!hud || hud.isDestroyed() || !hudRest) return;

  if (hudDrag) {
    // Mid-drag — a recording started while the pill was being held. Let the
    // drag keep steering; it will pick up the new width on its next tick. The
    // grab offset shifts with the bloom so the pill does not jump out of the
    // hand as it grows.
    hudDrag.dx += form === 'active' ? HUD_GROW : -HUD_GROW;
    hudDrag.form = form;
    hudForm = form;
    return;
  }

  hudForm = form;
  const at = clampToDisplay(hudXFor(form, hudRest.x), hudRest.y, HUD_WIDTH[form], HUD_HEIGHT);
  hud.setBounds(hudBoundsAt(at.x, at.y, form));
}

function createHud() {
  const w = HUD_WIDTH.rest;
  const h = HUD_HEIGHT;

  // A position saved by an older build was written while the window was
  // inflated, so it can be most of a screen away from where the pill actually
  // looked to be. The clamp keeps it on a display; being a little off is
  // recoverable by dragging, being off-screen is not.
  const saved = store.settings().hudPosition;
  const at = saved
    ? clampToDisplay(saved.x, saved.y, w, h)
    : defaultHudPosition(w, h);
  hudRest = { x: at.x, y: at.y };

  hud = new BrowserWindow({
    width: w,
    height: h,
    x: at.x,
    y: at.y,
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
  // A transparent always-on-screen window would otherwise swallow every click
  // inside its bounds, including the empty margin the drop shadow needs. The
  // renderer turns this back off while the pointer is actually over the pill,
  // which is the only part there is anything to click.
  hud.setIgnoreMouseEvents(true, { forward: true });
  hud.loadFile(path.join(__dirname, '..', 'renderer', 'hud.html'));

  // A display being added, removed or rescaled can leave the pill outside
  // every screen — indistinguishable, from the user's side, from the bug
  // where it silently stopped appearing.
  const reseat = () => {
    if (!hud || hud.isDestroyed() || !hudRest) return;
    const b = hud.getBounds();
    const at2 = clampToDisplay(b.x, b.y, HUD_WIDTH[hudForm], HUD_HEIGHT);
    // The size is restated as well as the position: this is also the repair
    // path for a window an older build had already inflated.
    if (at2.x !== b.x || at2.y !== b.y || hudIsInflated(b)) {
      hud.setBounds(hudBoundsAt(at2.x, at2.y));
      hudRest = { x: hudRestXFrom(hudForm, at2.x), y: at2.y };
      store.updateSettings({ hudPosition: hudRest });
      log('hud: reseated onto a visible display');
    }
  };
  screen.on('display-metrics-changed', reseat);
  screen.on('display-removed', reseat);
  screen.on('display-added', reseat);

  hud.webContents.on('did-finish-load', () => {
    log('hud: loaded');
    // A fresh renderer always starts in the resting form, so the window is put
    // back into it here rather than waiting to be told. Without this, a
    // renderer that reloaded after a crash while the pill was open would come
    // back as a badge sitting in a window still sized for the full pill — and
    // it would never say so, because from its side nothing had changed.
    hudPlace('rest');
  });
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
  if (view) {
    // At launch this runs a few milliseconds after the window is created, long
    // before the renderer exists to hear it. Sending anyway would silently
    // drop the one navigation that matters — the first run opening on setup.
    if (mainWindow.webContents.isLoading()) {
      mainWindow.webContents.once('did-finish-load', () =>
        mainWindow?.webContents.send('navigate', view));
    } else {
      mainWindow.webContents.send('navigate', view);
    }
  }
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------- state

/**
 * Show or hide the pill according to what the user asked for.
 *
 * With the indicator turned on it simply stays up — the renderer swaps
 * between a compact idle form and the recording one. With it off, it is only
 * on screen while there is something to report. Either way the window's
 * visibility is decided in exactly one place: two code paths racing to show
 * and hide it is what used to leave it in the wrong state.
 */
function applyHudVisibility() {
  if (!hud || hud.isDestroyed()) return;
  const wanted = store.settings().showIndicator !== false || state !== 'idle';
  // Showing is the moment to make sure the window is still the size it is
  // supposed to be. Nothing in this build resizes it, but a profile carried
  // over from one that did would otherwise keep an inflated window — and an
  // inflated window is a pill sitting well away from where it appears to be,
  // swallowing clicks across a wide invisible rectangle.
  if (wanted) {
    const b = hud.getBounds();
    if (hudIsInflated(b)) {
      log('hud: corrected an inflated window from', `${b.width}x${b.height}`);
      hudPlace(hudForm);
    }
  }
  if (wanted && !hud.isVisible()) hud.showInactive();
  else if (!wanted && hud.isVisible()) hud.hide();
}

function setState(next, detail = {}) {
  state = next;
  hud?.webContents.send('state', { state: next, ...detail });
  mainWindow?.webContents.send('state', { state: next, ...detail });
  updateTray();

  if (next === 'recording') {
    // Via applyHudVisibility rather than showInactive directly, so the size
    // check runs on the one path that must never show a broken pill.
    applyHudVisibility();
  } else if (next === 'idle') {
    // Handing the linger to the renderer rather than hiding the window on a
    // timer here: the renderer owns how long a result stays readable, and it
    // can cancel its own timer when a new recording starts. A timer on this
    // side could not, which is how a stale one used to blank the pill in the
    // middle of the next recording.
    hud?.webContents.send('hud:linger', { ms: detail.linger ?? 1400 });
  }
}

async function startRecording() {
  log('startRecording: state =', state, 'hud =', hud ? 'present' : 'MISSING');
  if (state !== 'idle') return;

  // The single gate. Every way of starting a recording — hotkey, tray, the
  // Record button — arrives here, so refusing once covers all of them.
  if (!ready) {
    log('startRecording: refused — setup is not complete');
    hotkeys?.reset();
    // Short enough to read on the pill. The setup window opens right behind
    // it, which is where the explanation belongs.
    setState('idle', { error: 'Finish setup first', linger: 3600 });
    applyHudVisibility();
    showMainWindow('setup');
    return;
  }
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

/** What the menu was last built for. The menu only depends on `ready`, and
 *  replacing it while the user has it open closes it under their cursor —
 *  which updateTray would otherwise do on every recording start and stop. */
let trayMenuReady = null;

function updateTray() {
  if (!tray) return;
  tray.setImage(makeTrayIcon(state));
  tray.setToolTip(
    !ready ? 'Yapanese — setup not finished'
      : state === 'recording' ? 'Yapanese — recording'
      : state === 'transcribing' ? 'Yapanese — transcribing'
      : 'Yapanese'
  );
  if (trayMenuReady !== ready) {
    trayMenuReady = ready;
    tray.setContextMenu(buildTrayMenu());
  }
}

function buildTrayMenu() {
  const update = updateStatus.state === 'ready'
    ? [{ label: `Restart to update to ${updateStatus.version}`, click: () => updater.install() },
       { type: 'separator' }]
    : updateStatus.state === 'available'
      ? [{ label: `Update to ${updateStatus.version}…`, click: () => showMainWindow('history') },
         { type: 'separator' }]
      : [];

  return Menu.buildFromTemplate([
    ...update,
    // Greyed out rather than hidden, so the reason it cannot be used is
    // visible next to it instead of the option simply being absent.
    {
      label: ready ? 'Start / stop dictation' : 'Start / stop dictation (setup not finished)',
      enabled: ready,
      click: toggleRecording,
    },
    ...(ready ? [] : [{ label: 'Finish setup…', click: () => showMainWindow('setup') }]),
    { type: 'separator' },
    { label: 'History', click: () => showMainWindow('history') },
    { label: 'Settings', click: () => showMainWindow('settings') },
    { type: 'separator' },
    { label: 'Quit Yapanese', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
}

function buildTray() {
  tray = new Tray(makeTrayIcon('idle'));
  tray.on('click', () => showMainWindow(ready ? 'history' : 'setup'));
  updateTray();   // builds the menu for the current readiness
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

    // The transcript is recoverable and the cause is fixable, so put the fix
    // in front of the user instead of leaving an error they have to research.
    // The audio is already saved as an unfinished entry above, waiting.
    if (result.setupRequired) showMainWindow('setup');
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
  if ('showIndicator' in patch) applyHudVisibility();
  // Clearing the saved position has to move the window too, otherwise
  // "Reset position" only forgets where the pill is rather than putting it
  // back somewhere the user can find it.
  if ('hudPosition' in patch && !patch.hudPosition && hud && !hud.isDestroyed()) {
    hudRest = defaultHudPosition(HUD_WIDTH.rest, HUD_HEIGHT);
    hudPlace(hudForm);
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
    // Same reasoning as a live recording that cannot be transcribed — if the
    // reason is a missing component, show the screen that installs it.
    if (result.setupRequired) showMainWindow('setup');
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
  const [whisperCli, yap, ffmpeg] = await Promise.all([
    locate('whisper-cli', settings.whisperPath),
    locate('yap', settings.yapPath),
    locate('ffmpeg', settings.ffmpegPath),
  ]);
  return {
    // The one that actually matters. yap is only ever a fallback, so listing
    // it first used to make a working install look broken.
    whisperCli,
    yap,
    ffmpeg,
    dataDir: store.dataDir(),
    hotkeyRegistered: hookOk,
    version: app.getVersion(),
    electron: process.versions.electron,
  };
});

ipcMain.handle('open:dataDir', () => shell.openPath(store.dataDir()));

// -------------------------------------------------------------------- hud

/**
 * Drag the pill.
 *
 * The window follows the real cursor, sampled here, rather than being nudged
 * by mousemove events from the renderer. The window moves out from under the
 * pointer as it goes, so once a drag outran the IPC round trip the cursor was
 * outside the window and no more mousemove arrived.
 *
 * The renderer only says when the drag starts and stops. Measured over a
 * synthetic 2.4-second drag, the offset between cursor and window origin held
 * at exactly its starting value for all 300 samples — the arithmetic here was
 * never the problem. What moved the pill was the window growing around it, so
 * the one thing that matters below is that every move restates the size.
 */
let hudDrag = null;

// ~120 Hz. The cost is one cheap syscall per tick, and anything slower is
// visible as the pill lagging behind the cursor.
const HUD_DRAG_INTERVAL_MS = 8;

/** Hold the pill inside the screen the pointer is on. Clamping against the
 *  display nearest the *window* instead let the reference flip to another
 *  monitor mid-drag and yank the pill across to it. */
function clampToCursorDisplay(cursor, x, y, w, h) {
  const area = (screen.getDisplayNearestPoint(cursor) || screen.getPrimaryDisplay()).workArea;
  return {
    x: Math.round(Math.min(Math.max(x, area.x), area.x + area.width - w)),
    y: Math.round(Math.min(Math.max(y, area.y), area.y + area.height - h)),
  };
}

function stopHudDrag() {
  if (!hudDrag) return;
  clearInterval(hudDrag.timer);
  hudDrag = null;
}

// Nobody drags the pill for a solid minute. This is a dead-man's switch: the
// drag is ended by the renderer, and if the renderer dies mid-drag the window
// would otherwise follow the cursor around the screen forever.
const HUD_DRAG_MAX_MS = 60_000;

function tickHudDrag() {
  if (!hudDrag || !hud || hud.isDestroyed()) return stopHudDrag();
  if (Date.now() - hudDrag.startedAt > HUD_DRAG_MAX_MS) {
    log('hud: drag abandoned after', HUD_DRAG_MAX_MS, 'ms');
    const b = hud.getBounds();
    stopHudDrag();
    store.updateSettings({ hudPosition: { x: b.x, y: b.y } });
    return;
  }

  const cursor = screen.getCursorScreenPoint();
  const at = clampToCursorDisplay(
    cursor,
    cursor.x - hudDrag.dx,
    cursor.y - hudDrag.dy,
    HUD_WIDTH[hudDrag.form],
    HUD_HEIGHT
  );

  if (at.x === hudDrag.last.x && at.y === hudDrag.last.y) return;
  hudDrag.last = at;
  // setBounds with the size stated, never setPosition. setPosition reads the
  // current bounds back and re-applies them, and on a 150% display that read
  // returns a rectangle one pixel larger than the one that was set — so it
  // grew the window a pixel per call, 125 times a second, while dragging.
  hud.setBounds(hudBoundsAt(at.x, at.y, hudDrag.form));

  // Every so often, check the window actually went where it was put. The
  // previous version of this bug was invisible for months because nothing
  // ever compared the two; a drifting pill is a subjective complaint until
  // there is a number in the log saying how far off it was, and by then the
  // user has given up describing it.
  hudDrag.ticks = (hudDrag.ticks || 0) + 1;
  if (!hudDrag.warned && hudDrag.ticks % 32 === 0) {
    const got = hud.getBounds();
    if (Math.abs(got.x - at.x) > 2 || Math.abs(got.y - at.y) > 2 ||
        hudIsInflated(got, hudDrag.form)) {
      hudDrag.warned = true;
      log('hud: DRAG DIVERGENCE — asked',
          `${at.x},${at.y} ${HUD_WIDTH[hudDrag.form]}x${HUD_HEIGHT}`,
          'got', `${got.x},${got.y} ${got.width}x${got.height}`);
    }
  }
}

ipcMain.on('hud:drag-start', () => {
  if (!hud || hud.isDestroyed()) return;
  if (process.env.YAPANESE_HUD_TRACE) log('hud: drag-start');
  stopHudDrag();
  const cursor = screen.getCursorScreenPoint();
  const b = hud.getBounds();
  hudDrag = {
    dx: cursor.x - b.x,
    dy: cursor.y - b.y,
    form: hudForm,
    last: { x: b.x, y: b.y },
    startedAt: Date.now(),
    timer: setInterval(tickHudDrag, HUD_DRAG_INTERVAL_MS),
  };
});

ipcMain.on('hud:drag-end', () => {
  if (!hudDrag) return;
  const form = hudDrag.form;
  stopHudDrag();
  if (!hud || hud.isDestroyed()) return;
  const b = hud.getBounds();
  // Stored as the resting badge's position whatever form was being dragged,
  // so there is only ever one remembered place and the two forms cannot
  // disagree about where the pill lives.
  hudRest = { x: hudRestXFrom(form, b.x), y: b.y };
  store.updateSettings({ hudPosition: hudRest });
  // The size is logged as well as the position. It should never change within
  // a form, and the one time it did, it did so silently for months.
  log('hud: moved to', `${hudRest.x},${hudRest.y}`,
      `(${form} form, window ${b.width}x${b.height})`);
});

/**
 * The renderer selecting one of the two forms.
 *
 * It sends a name, never a measurement. That distinction is the whole reason
 * the width is allowed to change again: the main process maps the name onto a
 * constant, so there is no value here that can be read back, rounded up, and
 * fed in again.
 *
 * Ordering is the renderer's job — it grows the window before widening the
 * pill, and narrows the pill before shrinking the window, so the pill is never
 * drawn wider than the window holding it.
 */
ipcMain.on('hud:form', (_e, form) => {
  if (form !== 'rest' && form !== 'active') return;
  if (form === hudForm) return;
  hudPlace(form);
});

// Click-through everywhere except the pill itself, so an always-on-screen
// indicator does not eat clicks meant for whatever is behind it.
ipcMain.on('hud:interactive', (_e, on) => {
  if (!hud || hud.isDestroyed()) return;
  if (process.env.YAPANESE_HUD_TRACE) log('hud: interactive =', on);
  // Never while dragging. Making the window transparent to the mouse
  // mid-drag hands the pointer to whatever is underneath and abandons the
  // pill wherever it happened to be.
  if (hudDrag && !on) return;
  hud.setIgnoreMouseEvents(!on, { forward: true });
});

/** The renderer has finished showing a result and gone back to idle. */
ipcMain.on('hud:settled', () => applyHudVisibility());

// ----------------------------------------------------------------- updates

/** Tracked so the tray can offer the update and the window can show it even
 *  if it was closed when the news arrived. */
let updateStatus = { state: 'idle' };

function onUpdateStatus(next) {
  const wasOffering = updateStatus.state === 'available' || updateStatus.state === 'ready';
  updateStatus = next;
  mainWindow?.webContents.send('update:status', next);
  const offering = next.state === 'available' || next.state === 'ready';
  // The tray menu only changes shape when there is or is not something to
  // offer, so it is left alone through every download progress event.
  if (offering !== wasOffering) {
    trayMenuReady = null;
    updateTray();
  }
}

ipcMain.handle('update:get', () => updateStatus);
ipcMain.handle('update:check', () => updater.check({ silent: false }));
ipcMain.handle('update:download', () => updater.download());
ipcMain.handle('update:install', () => updater.install());

/** Clicking the pill opens the transcript it is telling you about. */
ipcMain.on('hud:open', () => showMainWindow('history'));

// ------------------------------------------------------------------ setup

/** The install in flight, so the Cancel button has something to pull. */
let installing = null;

// Goes through refreshReadiness so that prerequisites installed by hand,
// while the app was already running, lift the gate on the next look.
ipcMain.handle('setup:inspect', () => refreshReadiness());

ipcMain.handle('setup:install', async (_e, choice) => {
  if (installing) return { ok: false, error: 'An install is already running.' };

  const controller = new AbortController();
  installing = controller;
  try {
    const res = await setup.install(choice, {
      signal: controller.signal,
      onLog: (line) => log(line),
      onProgress: (p) => mainWindow?.webContents.send('setup:progress', p),
    });
    // The renderer re-reads the truth from disk rather than trusting the
    // result it was just handed: a partial install has to show as partial.
    // This is also what lifts the recording gate, so a finished setup works
    // immediately instead of needing a restart.
    return { ...res, state: await refreshReadiness() };
  } finally {
    installing = null;
  }
});

ipcMain.handle('setup:cancel', () => {
  installing?.abort();
  return { ok: true };
});

// ---------------------------------------------------------------- lifecycle

// Windows identifies an app by this string rather than by its executable, and
// it is what makes notifications and taskbar grouping say Yapanese.
//
// Claimed only when we are actually the installed app: the id is meant to
// resolve to a Start Menu shortcut, which exists only after installation, and
// a dev instance should not claim the identity of the installed one.
//
// This does not affect the taskbar icon either way. Running from source the
// process is electron.exe and Windows takes the taskbar button icon from the
// executable, whatever the window icon is set to — verified by giving a bare
// window the icon both as a path and as a NativeImage with an explicit
// setIcon, which still showed the Electron logo. Packaging is the only fix,
// and there the executable carries the icon itself. Must match build.appId.
if (app.isPackaged) app.setAppUserModelId('dev.yapanese.app');

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

    // The pill is meant to be there before the first shortcut is pressed —
    // its job is to tell you the app is alive and listening, which it cannot
    // do if it only appears once you have already started talking.
    hud.webContents.once('did-finish-load', () => {
      applyHudVisibility();
      // Readiness is settled below, possibly before this window exists to
      // hear about it, so it is repeated once there is somebody listening.
      hud.webContents.send('readiness', { ready });
    });

    // Nothing here can transcribe without whisper.cpp and a model, and the
    // installer deliberately does not carry either. Finding that out on the
    // first attempt to dictate — after the user has already spoken — is the
    // worst possible moment, so it is settled at launch instead.
    const state0 = await refreshReadiness();
    log('setup:', state0.ready ? 'ready' : 'incomplete',
        '| engine =', state0.engine.kind || 'missing',
        '| models =', state0.models.filter((m) => m.installed).map((m) => m.id).join(',') || 'none');

    // Launched by Windows at login, or by the user from the Start menu.
    // Shown before the hook is awaited: starting the hook process is quick,
    // but the window must not be held hostage to it if it ever is not.
    //
    // A machine that cannot transcribe yet opens on setup whatever it was
    // asked for — including at login, because starting hidden and silently
    // broken is how a user ends up thinking the app does not work.
    if (!state0.ready) showMainWindow('setup');
    else if (!process.argv.includes('--hidden')) showMainWindow('history');

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

    updater.start({ onStatus: onUpdateStatus, log });
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    stopHudDrag();
    updater.stop();
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

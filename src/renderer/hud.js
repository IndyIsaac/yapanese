'use strict';

const api = window.yapanese;

const pill = document.getElementById('pill');
const meter = document.getElementById('meter');
const timeEl = document.getElementById('time');
const msgEl = document.getElementById('msg');

// 17 bars at 2px with 2px between them is 66px, which is what the meter slot
// comes to inside a 144px pill once the lamp and the clock have taken theirs.
// The pill never resizes, so this is a fixed budget rather than a preference.
const BAR_COUNT = 17;
const BAR_MIN_PX = 2;
const BAR_MAX_PX = 14;
const SAMPLE_RATE = 16000;

const bars = Array.from({ length: BAR_COUNT }, (_, i) => {
  const b = document.createElement('i');
  b.style.height = `${BAR_MIN_PX}px`;
  // Position along the meter, so the transcribing animation can stagger
  // across the bars from CSS rather than being driven from here.
  b.style.setProperty('--i', String(i));
  meter.appendChild(b);
  return b;
});

// Audio is handed to the main process about once a second and appended to a
// file there, rather than being held here until the user stops. Keeping a
// whole recording in the renderer cost roughly 275 MB an hour and meant a
// crash lost everything said so far.
const FLUSH_SAMPLES = SAMPLE_RATE;

let audioContext = null;
let mediaStream = null;
let workletNode = null;
let pending = [];
let pendingSamples = 0;
let totalSamples = 0;
let sumSquares = 0;
let startedAt = 0;
let ticker = null;
let levels = new Array(BAR_COUNT).fill(0);
let loudestPeak = 0;

// Whisper invents plausible sentences from silence, so a recording with no
// speech in it would paste fabricated text into whatever has focus.
//
// The measure is RMS across the whole recording rather than peak: a single
// click or a desk knock reaches full scale while the recording is otherwise
// empty.
//
// Deliberately low. A noisy room easily exceeds 0.02, so this only catches a
// genuinely dead input — a muted or disconnected microphone. Rejecting noise
// that whisper cannot turn into speech is the transcriber's job, since it
// labels non-speech explicitly and an amplitude threshold cannot.
const SILENCE_RMS_THRESHOLD = 0.002;

/**
 * The one pending timer.
 *
 * Every transition goes through here, and setting a new one cancels the old.
 * Bare setTimeout(hide, …) calls scattered across the states is what made the
 * pill vanish at random: a result from one dictation would schedule a hide,
 * the user would start talking again inside that window, and the stale timer
 * would fire and blank a recording that was very much still running.
 */
let pendingTimer = null;

function later(fn, ms) {
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(fn, ms);
}

function cancelPending() {
  clearTimeout(pendingTimer);
  pendingTimer = null;
}

/**
 * There is no resize. The pill is 144x26 in every state and the window around
 * it is a fixed 164x42; states differ only in what occupies the middle slot.
 * The window used to be resized to fit whatever was drawn, which is what
 * inflated it a pixel per move on a fractionally scaled display.
 *
 * A message and the meter share that slot, so showing one hides the other and
 * the width cannot change. Anything longer than about twenty characters is
 * ellipsised — the full text always reaches the main window as well.
 */
const MSG_MAX = 22;

/**
 * Resting badge, or the full pill.
 *
 * The main process is told a name, not a size — it maps 'rest' and 'active'
 * onto two constants of its own. Nothing measured crosses this boundary, which
 * is what keeps the width free to change without the window creeping.
 *
 * Order matters in both directions, because the window clips the pill:
 * growing, the window has to be wide before the pill is; shrinking, the pill
 * has to be narrow before the window is.
 */
const FORM_MS = 180;

let form = 'rest';
let formTimer = null;

function setForm(next) {
  if (next === form) return;
  form = next;
  clearTimeout(formTimer);

  if (next === 'active') {
    api.hudForm('active');
    // A frame's grace for the window to actually be wider. Widening the pill
    // in the same tick draws it clipped for a frame or two.
    formTimer = setTimeout(() => {
      if (form === 'active') pill.classList.add('wide');
    }, 20);
  } else {
    pill.classList.remove('wide');
    formTimer = setTimeout(() => {
      if (form === 'rest') api.hudForm('rest');
    }, FORM_MS + 60);
  }
}

function setState(state, message) {
  pill.dataset.state = state;
  msgEl.hidden = !message;
  if (message) {
    msgEl.textContent = message.length > MSG_MAX ? `${message.slice(0, MSG_MAX - 1)}…` : message;
    msgEl.title = message;
  }
  // Idle is the badge. Everything else — recording, transcribing, and the
  // moment a result is being reported — needs the room.
  setForm(state === 'idle' ? 'rest' : 'active');
}

function show() {
  cancelPending();
  // The `in` class is what takes the pill from opacity 0 to visible, so it must
  // land unconditionally. requestAnimationFrame gives the entrance transition
  // a frame to start from, but frames are throttled while the window is hidden
  // — and the window is hidden exactly when the indicator is turned off, which
  // is the case where the pill is about to be shown for a result. A class that
  // never arrives is an invisible pill, which looks identical to the app having
  // died. The timeout is the guarantee; adding it twice costs nothing.
  requestAnimationFrame(() => pill.classList.add('in'));
  setTimeout(() => pill.classList.add('in'), 150);
}

/** Whether the app can actually transcribe. Only the lamp's colour depends on
 *  it now; the words that used to sit beside it are gone. */
let ready = true;

/**
 * Back to the resting state, which carries no words at all.
 *
 * It used to read "Ready" — a label the user reads once and then has to keep
 * looking at all day, and then a still waveform, which borrowed the one shape
 * that should mean "listening to you right now". What is left is a green light
 * and a microphone, in a badge small enough to forget about. An amber light
 * means setup is unfinished; the setup window does the explaining.
 *
 * Whether the window then goes away is not decided here. The main process
 * hides it only if the user turned the indicator off, so for everyone else
 * this is a change of state rather than a disappearance.
 */
function settle() {
  cancelPending();
  clearTimeout(lockHintTimer);
  setState('idle');
  api.hudSettled();
}

function renderLevel(peak) {
  levels.push(Math.min(1, peak * 2.6));
  if (levels.length > BAR_COUNT) levels.shift();
  for (let i = 0; i < BAR_COUNT; i++) {
    const v = levels[i] ?? 0;
    bars[i].style.height = `${BAR_MIN_PX + v * (BAR_MAX_PX - BAR_MIN_PX)}px`;
    bars[i].style.opacity = String(0.35 + v * 0.65);
  }
}

/**
 * Convert everything buffered so far to 16-bit PCM and hand it over.
 *
 * The running energy total is accumulated here rather than at the end,
 * because by then the samples are gone — they are on disk, not in memory.
 */
function flush() {
  if (pendingSamples === 0) return;

  const pcm = new Int16Array(pendingSamples);
  let offset = 0;
  for (const chunk of pending) {
    for (let i = 0; i < chunk.length; i++) {
      const v = Math.max(-1, Math.min(1, chunk[i]));
      sumSquares += v * v;
      pcm[offset++] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
  }

  totalSamples += pendingSamples;
  pending = [];
  pendingSamples = 0;
  api.sendChunk(new Uint8Array(pcm.buffer));
}

function resetMeter() {
  levels = new Array(BAR_COUNT).fill(0);
  bars.forEach((b) => { b.style.height = `${BAR_MIN_PX}px`; b.style.opacity = '0.35'; });
}

// Memory is no longer what limits a long recording — the audio goes to disk
// as it arrives. What still costs is turning it into text at the end, and
// finding that out after an hour of talking is too late to be useful.
const LONG_RECORDING_MS = 30 * 60 * 1000;
let longNoteShown = false;

/**
 * A note shown over the meter for a moment, then taken away again.
 *
 * The meter and any message share one slot so the pill cannot change width, so
 * anything said while recording is necessarily said *instead of* the levels.
 * That is fine for a couple of seconds and wrong as a permanent state — the
 * moving bars are the evidence that the app is still listening.
 *
 * Its own timer, separate from the settle timer, so a hint expiring can never
 * cut a recording's display short.
 */
let lockHintTimer = null;

function hint(text, ms) {
  clearTimeout(lockHintTimer);
  msgEl.hidden = false;
  msgEl.textContent = text;
  msgEl.title = text;
  lockHintTimer = setTimeout(() => {
    // Only clear it if the pill is still doing the thing the hint was about.
    if (pill.dataset.state === 'recording') msgEl.hidden = true;
  }, ms);
}

function tick() {
  const ms = Date.now() - startedAt;
  const s = Math.floor(ms / 1000);
  const mm = Math.floor(s / 60);
  // Past an hour, minutes alone stop reading as a duration.
  timeEl.textContent = mm < 60
    ? `${mm}:${String(s % 60).padStart(2, '0')}`
    : `${Math.floor(mm / 60)}:${String(mm % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  if (!longNoteShown && ms >= LONG_RECORDING_MS && pill.dataset.locked === 'true') {
    longNoteShown = true;
    hint('Long recording', 5000);
  }
}

/**
 * Match a saved microphone label against the devices currently present.
 *
 * Electron's labels carry a hardware id suffix — "Microphone (Foo) (1234:5678)"
 * — which ffmpeg's device names and older saved settings do not have. An exact
 * comparison therefore misses, and the capture silently falls back to the
 * system default, which is rarely the device the user chose.
 */
async function resolveDeviceId(label) {
  if (!label) return undefined;
  const inputs = (await navigator.mediaDevices.enumerateDevices())
    .filter((d) => d.kind === 'audioinput');

  const exact = inputs.find((d) => d.label === label);
  if (exact) return exact.deviceId;

  const partial = inputs.find((d) => d.label.startsWith(label) || label.startsWith(d.label));
  if (partial) return partial.deviceId;

  return undefined;
}

let currentDeviceLabel = '';
let skipSilenceGuard = false;

async function start({ deviceLabel, skipSilence }) {
  skipSilenceGuard = !!skipSilence;
  try {
    pending = [];
    pendingSamples = 0;
    totalSamples = 0;
    sumSquares = 0;
    loudestPeak = 0;
    longNoteShown = false;
    currentDeviceLabel = deviceLabel || '';
    pill.dataset.locked = 'false';
    clearTimeout(lockHintTimer);
    msgEl.hidden = true;
    resetMeter();
    startedAt = Date.now();
    timeEl.textContent = '0:00';
    setState('recording');
    show();
    ticker = setInterval(tick, 250);

    const deviceId = await resolveDeviceId(deviceLabel);
    // Falling back to the default is silent otherwise, and the case that
    // matters is a Bluetooth headset that has dropped: you carry on talking
    // quietly into earbuds while the laptop's own microphone is what is
    // actually recording. Worth two seconds of the meter's slot to say so.
    if (deviceLabel && !deviceId) hint('Default mic', 2000);

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: true,
        // Automatic gain drives room noise up to full scale, which both
        // degrades transcription and makes it impossible to tell silence
        // from speech. Whisper prefers natural levels anyway.
        autoGainControl: false,
      },
    });

    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    await audioContext.audioWorklet.addModule('./collector-worklet.js');

    const source = audioContext.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioContext, 'collector');
    workletNode.port.onmessage = ({ data }) => {
      pending.push(data.samples);
      pendingSamples += data.samples.length;
      if (data.peak > loudestPeak) loudestPeak = data.peak;
      renderLevel(data.peak);
      if (pendingSamples >= FLUSH_SAMPLES) flush();
    };

    // The worklet has no output; connecting to the destination anyway keeps
    // the graph pulling frames. Gain is zeroed so nothing is played back.
    const mute = audioContext.createGain();
    mute.gain.value = 0;
    source.connect(workletNode);
    workletNode.connect(mute);
    mute.connect(audioContext.destination);
  } catch (err) {
    teardown();
    // Short enough to read at this width. The sentence explaining what to do
    // about it goes to the main window, which has room for it.
    setState('error', 'No microphone');
    show();
    api.sendError(
      err && err.name === 'NotAllowedError'
        ? 'Microphone access was denied. Allow it in Windows Settings › Privacy › Microphone.'
        : `Could not start recording: ${err?.message || err}`
    );
    later(settle, 3600);
  }
}

function teardown() {
  clearInterval(ticker);
  ticker = null;
  try { workletNode?.disconnect(); } catch {}
  try { mediaStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { audioContext?.close(); } catch {}
  workletNode = null;
  mediaStream = null;
  audioContext = null;
}

function stop() {
  cancelPending();
  clearTimeout(lockHintTimer);
  const rate = audioContext?.sampleRate || SAMPLE_RATE;

  // Hand over whatever has not been flushed yet before the graph goes away,
  // otherwise the last second of the recording is lost.
  flush();
  const count = totalSamples;

  teardown();
  // Drop the locked styling before the transcribing look goes on, otherwise
  // the red "still recording" ring sits on top of it and nothing appears to
  // have changed when the user taps to stop.
  pill.dataset.locked = 'false';
  // No caption. The bars turn amber and run as a travelling wave, which says
  // "working" without taking the slot the meter occupies — and the word would
  // have had to displace the animation to fit.
  setState('transcribing');
  resetMeter();

  if (count === 0) {
    setState('error', 'Nothing recorded');
    api.sendError('No audio was captured. Check that the right microphone is selected.');
    later(settle, 3600);
    return;
  }

  const rms = Math.sqrt(sumSquares / count);

  if (rms < SILENCE_RMS_THRESHOLD && !skipSilenceGuard) {
    setState('error', 'No speech heard');
    api.sendError(
      `That recording was too quiet to transcribe. Yapanese is listening to "${currentDeviceLabel || 'the system default'}" — check the microphone in Settings if that is wrong.`
    );
    later(settle, 4000);
    return;
  }

  // The audio itself is already on disk; this only reports what was captured.
  api.sendResult({
    sampleRate: rate,
    sampleCount: count,
    peak: loudestPeak,
    rms,
  });
}

// ------------------------------------------------------------- interaction

/**
 * The window ignores the mouse by default so an indicator that is always on
 * screen does not eat clicks meant for what is behind it. Electron forwards
 * move events while it does, which is how the pill knows the pointer has
 * arrived and can ask for the mouse back.
 */
let interactive = false;

function setInteractive(on) {
  if (on === interactive) return;
  interactive = on;
  api.hudInteractive(on);
}

document.addEventListener('mousemove', (e) => {
  if (dragging) return;
  const r = pill.getBoundingClientRect();
  setInteractive(
    e.clientX >= r.left && e.clientX <= r.right &&
    e.clientY >= r.top && e.clientY <= r.bottom
  );
});
// The forwarded stream stops at the window edge, so a pointer that leaves
// quickly can miss the final move event and leave the window grabbing clicks.
document.addEventListener('mouseleave', () => { if (!dragging) setInteractive(false); });

// ------------------------------------------------------------------- drag

let dragging = false;
let movedWhileDown = false;
let pressedAt = null;

/** Below this, a press is a click with a shaky hand rather than a drag.
 *  Without it, one stray pixel of movement swallowed the click. */
const DRAG_SLOP = 4;

/**
 * Pointer events with capture, not mouse events.
 *
 * The window slides out from under the pointer while it is being dragged, and
 * plain mouse events stop arriving the moment the cursor is outside it — so a
 * quick drag lost the pointer, the pill stopped following, and the mouseup
 * that should have ended the drag never came. Capturing the pointer routes
 * every move and the release back here no matter where the cursor goes.
 *
 * The movement itself is the main process's job; all this decides is when the
 * drag starts and stops, and whether the press was really a click.
 */
function endDrag(pointerId) {
  if (!dragging) return;
  dragging = false;
  pill.classList.remove('dragging');
  try {
    if (pointerId != null && pill.hasPointerCapture(pointerId)) {
      pill.releasePointerCapture(pointerId);
    }
  } catch {}
  api.hudDragEnd();
  // A press that did not move the pill is a click, not a drag: it opens the
  // transcript the pill is reporting on.
  if (!movedWhileDown) api.hudOpen();
}

pill.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  // A press arriving while one is already in flight — a second button, a
  // stylus alongside the mouse — would otherwise start a second drag against
  // the first one's grab offset and tear the pill between them.
  if (dragging) return;
  dragging = true;
  movedWhileDown = false;
  pressedAt = { x: e.screenX, y: e.screenY };
  pill.classList.add('dragging');
  // Told before the capture is taken, not after. setPointerCapture throws if
  // the pointer is no longer active, and doing it the other way round meant
  // the throw happened with `dragging` already true and the main process never
  // told to start — leaving a drag that could not be moved, could not be
  // ended, and swallowed every later press.
  api.hudDragStart();
  try { pill.setPointerCapture(e.pointerId); } catch {}
  e.preventDefault();
});

pill.addEventListener('pointermove', (e) => {
  if (!dragging || movedWhileDown) return;
  if (Math.abs(e.screenX - pressedAt.x) > DRAG_SLOP ||
      Math.abs(e.screenY - pressedAt.y) > DRAG_SLOP) {
    movedWhileDown = true;
  }
});

pill.addEventListener('pointerup', (e) => endDrag(e.pointerId));
// Capture can be taken away — the window losing focus, the pointer being
// cancelled by the system. Without this the drag would keep running with
// nothing left to stop it.
pill.addEventListener('pointercancel', (e) => endDrag(e.pointerId));
pill.addEventListener('lostpointercapture', () => endDrag(null));

api.on('capture:start', start);
api.on('capture:stop', stop);

// Locked recording looks different from hold-to-talk: the user needs to know
// it will keep running until they tap again. The steady ring on the lamp is
// the lasting signal; the words are only needed at the moment it locks, so
// they borrow the meter's slot briefly and then give it back.
api.on('lock', (locked) => {
  pill.dataset.locked = String(locked);
  if (locked) hint('Tap to stop', 1800);
  else { clearTimeout(lockHintTimer); msgEl.hidden = true; }
});

/** How long a finished result stays up before the pill goes back to idle.
 *  A pasted transcript is already where it was wanted, so the confirmation
 *  can be brief. A copied one is a job the user still has to finish, and it
 *  should not expire while they are still looking away from the screen. */
const LINGER_PASTED = 2200;
const LINGER_COPIED = 7000;

let lastLinger = LINGER_PASTED;

api.on('state', ({ state, error, delivered, text }) => {
  if (state !== 'idle') return;

  if (error) {
    // setState ellipsises anything too long for the pill. The full text
    // reaches the main window as a toast either way.
    setState('error', error);
    show();
    later(settle, 4200);
    return;
  }

  const trimmed = (text || '').trim();
  const words = trimmed ? trimmed.split(/\s+/).filter(Boolean).length : 0;
  const pasted = delivered === 'pasted';
  const verb = pasted ? 'Pasted' : 'Copied';

  // "Copied · 34 words" is the answer to the question actually being asked —
  // did it hear me — and it fits. The transcript itself does not, at this
  // width; clicking the pill opens it.
  setState('done', words ? `${verb} · ${words} word${words === 1 ? '' : 's'}` : verb);
  show();
  lastLinger = pasted ? LINGER_PASTED : LINGER_COPIED;
  later(settle, lastLinger);
});

// The main process has its own view of how long a result should linger; it
// wins when it sends one, so the two cannot disagree about when the pill
// goes back to idle.
api.on('hud:linger', ({ ms }) => {
  if (pill.dataset.state === 'recording' || pill.dataset.state === 'transcribing') return;
  later(settle, Math.max(ms, lastLinger));
});

// Unfinished setup turns the lamp amber and stops the pill fading back, which
// is all the pill needs to say — the setup window carries the detail.
api.on('readiness', (info) => {
  ready = !!info.ready;
  pill.dataset.ready = String(ready);
});

// Resting state from the moment the window loads, rather than the app being
// invisible until the first time the shortcut is pressed.
pill.dataset.ready = String(ready);
setState('idle');
show();

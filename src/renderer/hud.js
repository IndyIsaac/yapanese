'use strict';

const api = window.yapanese;

const pill = document.getElementById('pill');
const meter = document.getElementById('meter');
const timeEl = document.getElementById('time');
const msgEl = document.getElementById('msg');

const BAR_COUNT = 22;
const SAMPLE_RATE = 16000;

const bars = Array.from({ length: BAR_COUNT }, () => {
  const b = document.createElement('i');
  b.style.height = '3px';
  meter.appendChild(b);
  return b;
});

let audioContext = null;
let mediaStream = null;
let workletNode = null;
let chunks = [];
let totalSamples = 0;
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

function setState(state, message) {
  pill.dataset.state = state;
  msgEl.hidden = !message;
  if (message) msgEl.textContent = message;
  timeEl.hidden = state === 'error' || state === 'done';
}

function show() { requestAnimationFrame(() => pill.classList.add('in')); }
function hide() { pill.classList.remove('in'); }

function renderLevel(peak) {
  levels.push(Math.min(1, peak * 2.6));
  if (levels.length > BAR_COUNT) levels.shift();
  for (let i = 0; i < BAR_COUNT; i++) {
    const v = levels[i] ?? 0;
    bars[i].style.height = `${3 + v * 19}px`;
    bars[i].style.opacity = String(0.35 + v * 0.65);
  }
}

function resetMeter() {
  levels = new Array(BAR_COUNT).fill(0);
  bars.forEach((b) => { b.style.height = '3px'; b.style.opacity = '0.35'; });
}

function tick() {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  timeEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
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
    chunks = [];
    totalSamples = 0;
    loudestPeak = 0;
    currentDeviceLabel = deviceLabel || '';
    pill.dataset.locked = 'false';
    msgEl.hidden = true;
    resetMeter();
    startedAt = Date.now();
    timeEl.textContent = '0:00';
    setState('recording');
    show();
    ticker = setInterval(tick, 250);

    const deviceId = await resolveDeviceId(deviceLabel);
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
      chunks.push(data.samples);
      totalSamples += data.samples.length;
      if (data.peak > loudestPeak) loudestPeak = data.peak;
      renderLevel(data.peak);
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
    setState('error', 'Microphone unavailable');
    show();
    api.sendError(
      err && err.name === 'NotAllowedError'
        ? 'Microphone access was denied. Allow it in Windows Settings › Privacy › Microphone.'
        : `Could not start recording: ${err?.message || err}`
    );
    setTimeout(hide, 3200);
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
  const rate = audioContext?.sampleRate || SAMPLE_RATE;
  const collected = chunks;
  const count = totalSamples;

  teardown();
  setState('transcribing');
  resetMeter();

  if (count === 0) {
    setState('error', 'Nothing recorded');
    api.sendError('No audio was captured. Check that the right microphone is selected.');
    setTimeout(hide, 3200);
    return;
  }

  // Float32 [-1,1] to signed 16-bit PCM, accumulating energy as we go.
  const pcm = new Int16Array(count);
  let offset = 0;
  let sumSquares = 0;
  for (const chunk of collected) {
    for (let i = 0; i < chunk.length; i++) {
      const v = Math.max(-1, Math.min(1, chunk[i]));
      sumSquares += v * v;
      pcm[offset++] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
  }
  const rms = Math.sqrt(sumSquares / count);

  if (rms < SILENCE_RMS_THRESHOLD && !skipSilenceGuard) {
    setState('error', 'No speech heard');
    api.sendError(
      `That recording was too quiet to transcribe. Yapanese is listening to "${currentDeviceLabel || 'the system default'}" — check the microphone in Settings if that is wrong.`
    );
    setTimeout(hide, 3600);
    return;
  }

  api.sendResult({
    samples: new Uint8Array(pcm.buffer),
    sampleRate: rate,
    peak: loudestPeak,
    rms,
  });
}

api.on('capture:start', start);
api.on('capture:stop', stop);

// Locked recording looks different from hold-to-talk: the user needs to know
// it will keep running until they tap again.
api.on('lock', (locked) => {
  pill.dataset.locked = String(locked);
  msgEl.hidden = !locked;
  if (locked) msgEl.textContent = 'Locked — tap to stop';
});

api.on('state', ({ state, error, delivered, text }) => {
  if (state !== 'idle') return;

  if (error) {
    // The window is a fixed width, so a long message is trimmed here rather
    // than being silently cut off by the window edge. The full text still
    // reaches the main window as a toast.
    setState('error', error.length > 62 ? `${error.slice(0, 60)}…` : error);
    setTimeout(hide, 3200);
    return;
  }

  const words = text ? text.trim().split(/\s+/).filter(Boolean).length : 0;
  const verb = delivered === 'pasted' ? 'Pasted' : 'Copied';
  setState('done', words ? `${verb} · ${words} word${words === 1 ? '' : 's'}` : verb);
  setTimeout(hide, 1800);
});

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { run, locate } = require('./tools');
const { encodeWav } = require('./wav');

/**
 * Speed presets.
 *
 * The dominant cost is whisper's encoder, which always processes a fixed
 * 30-second window regardless of how short the clip is. Capping the encoded
 * window is what makes short dictation fast; beam and best-of control
 * decoding, which is comparatively cheap.
 *
 * Measured on a 2s clip with the turbo-q5_0 model, 16 threads:
 *   accurate  5.7s   balanced  2.0s   fast  0.2s (tiny.en)
 */
const PRESETS = {
  accurate: { trimContext: false, beam: 2, bestOf: 2 },
  balanced: { trimContext: true,  beam: 1, bestOf: 1 },
  fast:     { trimContext: true,  beam: 1, bestOf: 1 },
};

// Whisper encodes 30 seconds as 1500 frames, so 50 frames per second.
const FRAMES_PER_SECOND = 50;
const FULL_CONTEXT = 1500;

// Below roughly this much context the decoder starts looping and repeats the
// last phrase, measured on clips of 2-3 seconds. Speed past this point is
// already good, so there is nothing to gain by going tighter.
const MIN_CONTEXT = 512;

/**
 * Size the encoder window to the clip.
 *
 * A fixed small context makes short clips fast but truncates longer ones,
 * where the model loses its place and starts repeating phrases. Scaling with
 * duration keeps the speed win for dictation-length audio without corrupting
 * anything longer. The margin covers whisper's own padding.
 */
function audioContextFor(durationSeconds) {
  const needed = Math.ceil(durationSeconds * FRAMES_PER_SECOND) + 128;
  if (needed >= FULL_CONTEXT) return 0;      // 0 = let whisper use everything
  return Math.max(MIN_CONTEXT, needed);
}

const DEFAULT_MODEL = 'ggml-large-v3-turbo-q5_0.bin';
const FAST_MODEL = 'ggml-tiny.en.bin';

// Voice activity detection. Whisper invents plausible sentences from room
// noise — a far-field microphone picking up a whole room produced "*Punch*"
// and "It's a very good day." from silence. VAD discards non-speech before
// the model ever sees it, which no amplitude threshold can do reliably. It
// also removes the repeated-phrase artifact on longer clips.
const VAD_MODEL = 'ggml-silero-v5.1.2.bin';
const VAD_MODEL_URL = `https://huggingface.co/ggml-org/whisper-vad/resolve/main/${VAD_MODEL}`;

function modelsDir() {
  return path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'yap', 'models'
  );
}

/**
 * Fetch the VAD model if it is not already cached. It is under a megabyte, so
 * this is a one-off download comparable to the speech model itself and keeps
 * the offline guarantee intact afterwards.
 */
function ensureVadModel() {
  const dest = path.join(modelsDir(), VAD_MODEL);
  if (fs.existsSync(dest)) return Promise.resolve({ ok: true, cached: true });

  return new Promise((resolve) => {
    const https = require('node:https');
    fs.mkdirSync(modelsDir(), { recursive: true });
    const partial = `${dest}.partial`;

    const cleanup = (reason) => {
      fs.rm(partial, { force: true }, () => {});
      resolve({ ok: false, error: reason });
    };

    const get = (url, redirects = 0) => {
      https.get(url, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
          res.resume();
          return get(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return cleanup(`HTTP ${res.statusCode}`);
        }
        const file = fs.createWriteStream(partial);
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            try {
              fs.renameSync(partial, dest);
              resolve({ ok: true, cached: false });
            } catch (err) { cleanup(err.message); }
          });
        });
        file.on('error', (err) => cleanup(err.message));
      }).on('error', (err) => cleanup(err.message));
    };

    get(VAD_MODEL_URL);
  });
}

function threadCount() {
  // Whisper stops scaling well past ~16 threads, and leaving headroom keeps
  // the machine responsive while transcribing.
  return Math.max(4, Math.min(os.cpus().length - 4, 16));
}

function resolveModel(settings) {
  if (settings.model && (settings.model.includes('/') || settings.model.includes('\\'))) {
    return settings.model;
  }
  const name = settings.model
    || (settings.speed === 'fast' ? FAST_MODEL : DEFAULT_MODEL);
  return path.join(modelsDir(), name.endsWith('.bin') ? name : `${name}.bin`);
}

/**
 * Transcribe PCM samples by invoking whisper-cli directly.
 *
 * Yapanese already produces 16 kHz mono audio, which is exactly what whisper
 * wants, so there is no decode step and nothing for ffmpeg to do.
 */
async function transcribe({ samples, sampleRate, settings, onProgress }) {
  const exe = await locate('whisper-cli', settings.whisperPath);
  if (!exe) return { ok: false, error: 'whisper-cli was not found.', missing: true };

  const model = resolveModel(settings);
  if (!fs.existsSync(model)) {
    return { ok: false, error: `Model not found at ${model}`, missing: true };
  }

  const preset = PRESETS[settings.speed] || PRESETS.balanced;
  const base = path.join(os.tmpdir(), `yapanese-${crypto.randomUUID()}`);
  const wav = `${base}.wav`;
  fs.writeFileSync(wav, encodeWav(samples, sampleRate));

  const args = [
    '-m', model,
    '-f', wav,
    '-t', String(settings.threads || threadCount()),
    '-bo', String(preset.bestOf),
    '-bs', String(preset.beam),
    '-nt',                       // no timestamps: we want plain text
    '-np',                       // no progress banner on stdout
    // Auto-detection runs an extra encode pass over the whole window and,
    // on non-speech audio, happily picks a random language and returns
    // gibberish. A fixed language is both faster and far more predictable.
    '-l', settings.language && settings.language !== 'auto' ? settings.language : 'en',
  ];
  if (preset.trimContext) {
    const ac = audioContextFor(samples.length / sampleRate);
    if (ac > 0) args.push('-ac', String(ac));
  }

  const vadModel = path.join(modelsDir(), VAD_MODEL);
  const useVad = settings.vad !== false && fs.existsSync(vadModel);
  if (useVad) {
    args.push('--vad', '-vm', vadModel);
    // Slightly padded so word onsets are not clipped, and a short silence
    // gap so natural pauses mid-sentence do not split the utterance.
    args.push('-vt', String(settings.vadThreshold ?? 0.5));
    args.push('-vspd', '200');
    args.push('-vsd', '150');
    args.push('-vp', '60');
  }

  try {
    const started = Date.now();
    const res = await run(exe, args, { env: { ...process.env, PATH: `${path.dirname(exe)};${process.env.PATH || ''}` } });
    const elapsedMs = Date.now() - started;
    onProgress?.({ args, elapsedMs });

    if (!res.ok) {
      const detail = (res.stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ');
      return { ok: false, error: detail || `whisper-cli exited with code ${res.code}` };
    }

    const text = res.stdout.replace(/\r/g, '').trim();
    return { ok: true, text, elapsedMs, args };
  } finally {
    fs.rm(wav, { force: true }, () => {});
  }
}

module.exports = {
  transcribe, threadCount, resolveModel, audioContextFor, ensureVadModel,
  PRESETS, DEFAULT_MODEL, FAST_MODEL, VAD_MODEL,
};

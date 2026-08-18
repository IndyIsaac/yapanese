'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { run, locate } = require('./tools');
const { encodeWav } = require('./wav');
const whisper = require('./whisper');

/**
 * Whisper marks non-speech audio with a bracketed annotation rather than
 * leaving the output empty — `*Loud noise*`, `[BLANK_AUDIO]`, `(wind blowing)`.
 * Delivering one of those would paste invented text into the user's document,
 * so a transcript consisting only of annotations counts as no speech.
 */
function isNonSpeech(text) {
  const stripped = text
    .replace(/\*[^*]*\*/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[\s.,!?-]/g, '');
  return stripped.length === 0;
}

async function findYap(override) {
  return locate('yap', override);
}

/**
 * Fallback path: hand the audio to the yap CLI.
 *
 * Slower than calling whisper directly — yap re-encodes through ffmpeg and
 * uses whisper's default beam search over the full 30-second context — but it
 * keeps Murmur working on a machine that has yap but not whisper-cli.
 */
async function viaYap({ samples, sampleRate, settings }) {
  const yap = await findYap(settings.yapPath);
  if (!yap) {
    return {
      ok: false,
      error:
        'Neither whisper-cli nor yap could be found. Put one of them on your PATH, or in %LOCALAPPDATA%\\yap\\bin.',
    };
  }

  const file = path.join(os.tmpdir(), `murmur-${crypto.randomUUID()}.wav`);
  fs.writeFileSync(file, encodeWav(samples, sampleRate));

  try {
    const args = ['transcribe', file];
    if (settings.model) args.push('--model', settings.model);

    // yap shells out to whisper-cli and ffmpeg and finds them on PATH. They
    // are normally installed beside yap itself, which is not necessarily on
    // the PATH this process inherited, so its own directory goes first.
    const env = { ...process.env, PATH: `${path.dirname(yap)};${process.env.PATH || ''}` };
    if (settings.ffmpegPath) env.YAP_FFMPEG = settings.ffmpegPath;

    const started = Date.now();
    const res = await run(yap, args, { env });
    if (!res.ok) {
      const detail = (res.stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
      return { ok: false, error: detail || `yap exited with code ${res.code}` };
    }
    return { ok: true, text: res.stdout.replace(/\r/g, '').trim(), elapsedMs: Date.now() - started };
  } finally {
    fs.rm(file, { force: true }, () => {});
  }
}

/**
 * Transcribe captured audio.
 *
 * whisper-cli is called directly when available: Murmur already produces the
 * 16 kHz mono audio whisper wants, so going through yap would add two process
 * spawns and a redundant ffmpeg conversion for no benefit.
 */
async function transcribe({ samples, sampleRate, settings }) {
  // Test affordance: lets the capture -> delivery path be exercised without
  // needing real speech into the microphone.
  if (process.env.MURMUR_FAKE_TRANSCRIPT) {
    return { ok: true, text: process.env.MURMUR_FAKE_TRANSCRIPT, elapsedMs: 0 };
  }

  let result = await whisper.transcribe({ samples, sampleRate, settings });
  if (!result.ok && result.missing) {
    result = await viaYap({ samples, sampleRate, settings });
  }

  if (!result.ok) return result;
  if (result.args) result.command = `whisper-cli ${result.args.slice(2).join(' ')}`;

  const text = (result.text || '').trim();
  // With voice activity detection on, empty output is the expected result for
  // a recording that contained no speech, not a failure.
  if (!text) return { ok: false, error: 'No speech detected in that recording.', noSpeech: true };
  if (isNonSpeech(text)) {
    return { ok: false, error: 'No speech was found in that recording — only background noise.' };
  }
  return { ok: true, text, elapsedMs: result.elapsedMs, command: result.command };
}

module.exports = { transcribe, encodeWav, findYap, isNonSpeech };

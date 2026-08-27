'use strict';

const path = require('node:path');
const { run, locate } = require('./tools');
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
 * keeps Yapanese working on a machine that has yap but not whisper-cli.
 */
async function viaYap({ wavPath, settings }) {
  const yap = await findYap(settings.yapPath);
  if (!yap) return { ok: false, absent: true, error: 'yap was not found.' };

  const args = ['transcribe', wavPath];
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
}

/**
 * Transcribe captured audio.
 *
 * whisper-cli is called directly when available: Yapanese already produces the
 * 16 kHz mono audio whisper wants, so going through yap would add two process
 * spawns and a redundant ffmpeg conversion for no benefit.
 */
async function transcribe({ wavPath, durationSeconds, settings }) {
  // Test affordance: lets the capture -> delivery path be exercised without
  // needing real speech into the microphone.
  if (process.env.YAPANESE_FAKE_TRANSCRIPT) {
    return { ok: true, text: process.env.YAPANESE_FAKE_TRANSCRIPT, elapsedMs: 0 };
  }

  let result = await whisper.transcribe({ wavPath, durationSeconds, settings });

  // yap is a fallback for a machine that has it but not whisper-cli. It is no
  // use when the binary is there and a model is not, and reaching for it then
  // is what used to report a missing model as a missing program.
  if (!result.ok && result.missing === 'engine') {
    const fallback = await viaYap({ wavPath, settings });
    if (!fallback.absent) result = fallback;
  }

  if (!result.ok) {
    // Something the user can act on, rather than a failure they have to
    // diagnose: setup knows how to fetch either of these.
    if (result.missing) {
      return {
        ok: false,
        setupRequired: true,
        missing: result.missing,
        error: result.missing === 'engine'
          ? 'whisper.cpp is not installed yet — Yapanese needs it to transcribe.'
          : result.error,
      };
    }
    return result;
  }
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

module.exports = { transcribe, findYap, isNonSpeech };

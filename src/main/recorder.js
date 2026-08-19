'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * The recording as it exists on disk while you are still talking.
 *
 * Audio used to be held in renderer memory until you stopped, which cost
 * about 275 MB an hour and meant a crash — or a power cut — lost everything
 * said so far. Samples are now appended to a WAV as they arrive, so memory
 * stays flat however long the recording runs and the file survives the app.
 *
 * The header is written up front with zeroed sizes and patched on finish.
 * A file left behind by a crash therefore claims to be empty, which is what
 * `repair` fixes: the true length is simply the size of the file.
 */

const HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;

function writeHeader(fd, sampleRate, dataBytes) {
  const h = Buffer.alloc(HEADER_BYTES);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);                      // PCM chunk size
  h.writeUInt16LE(1, 20);                       // format = PCM
  h.writeUInt16LE(1, 22);                       // channels = mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28);
  h.writeUInt16LE(BYTES_PER_SAMPLE, 32);        // block align
  h.writeUInt16LE(16, 34);                      // bits per sample
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  fs.writeSync(fd, h, 0, HEADER_BYTES, 0);
}

/** Recording files are named so the start time survives without a sidecar. */
function nameFor(startedAt) {
  return `rec-${startedAt}-${crypto.randomUUID().slice(0, 8)}.wav`;
}

function parseName(file) {
  const m = /^rec-(\d+)-[0-9a-f]{8}\.wav$/.exec(file);
  return m ? Number(m[1]) : null;
}

function create({ dir, sampleRate = 16000, now = Date.now }) {
  let fd = null;
  let file = null;
  let dataBytes = 0;

  return {
    /** Opens a new recording and writes its placeholder header. */
    start() {
      if (fd !== null) throw new Error('a recording is already open');
      fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, nameFor(now()));
      fd = fs.openSync(file, 'w');
      dataBytes = 0;
      writeHeader(fd, sampleRate, 0);
      return { path: file };
    },

    /** Appends 16-bit PCM. Cheap enough to do synchronously: one write a second. */
    append(buf) {
      if (fd === null) return 0;
      fs.writeSync(fd, buf, 0, buf.length, HEADER_BYTES + dataBytes);
      dataBytes += buf.length;
      return dataBytes;
    },

    /** Patches the header with the real sizes and closes the file. */
    finish() {
      if (fd === null) return null;
      writeHeader(fd, sampleRate, dataBytes);
      fs.closeSync(fd);
      const out = {
        path: file,
        bytes: dataBytes,
        samples: dataBytes / BYTES_PER_SAMPLE,
        durationSeconds: dataBytes / BYTES_PER_SAMPLE / sampleRate,
      };
      fd = null; file = null; dataBytes = 0;
      return out;
    },

    /** Throws the recording away — used when there was no speech in it. */
    abort() {
      if (fd === null) return;
      try { fs.closeSync(fd); } catch {}
      try { fs.rmSync(file, { force: true }); } catch {}
      fd = null; file = null; dataBytes = 0;
    },

    isOpen: () => fd !== null,
    currentPath: () => file,
    bytesWritten: () => dataBytes,
  };
}

/**
 * Repair a file whose header never got patched, which is every recording
 * interrupted by a crash. Returns how much audio it actually holds.
 */
function repair(file, sampleRate = 16000) {
  const size = fs.statSync(file).size;
  const dataBytes = Math.max(0, size - HEADER_BYTES);
  const fd = fs.openSync(file, 'r+');
  try { writeHeader(fd, sampleRate, dataBytes); } finally { fs.closeSync(fd); }
  return {
    path: file,
    bytes: dataBytes,
    samples: dataBytes / BYTES_PER_SAMPLE,
    durationSeconds: dataBytes / BYTES_PER_SAMPLE / sampleRate,
  };
}

/**
 * Recordings left behind by a previous run, newest first.
 *
 * `except` is the file currently being written, which is not orphaned.
 * Anything too short to hold speech is deleted rather than offered — a
 * half-second of audio is a stray keypress, not lost work.
 */
function listOrphans({ dir, except = null, minSeconds = 1, sampleRate = 16000 }) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }

  const found = [];
  for (const name of names) {
    const startedAt = parseName(name);
    if (startedAt === null) continue;
    const full = path.join(dir, name);
    if (except && path.resolve(full) === path.resolve(except)) continue;

    let info;
    try { info = repair(full, sampleRate); } catch { continue; }
    if (info.durationSeconds < minSeconds) {
      try { fs.rmSync(full, { force: true }); } catch {}
      continue;
    }
    found.push({ ...info, name, startedAt });
  }
  return found.sort((a, b) => b.startedAt - a.startedAt);
}

function discard(file) {
  try { fs.rmSync(file, { force: true }); } catch {}
}

module.exports = { create, repair, listOrphans, discard, HEADER_BYTES };

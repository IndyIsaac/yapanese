// Covers the on-disk recorder, including the case that matters most: a file
// left behind by a crash, whose header never got its sizes patched.
//
// Usage: node tools/test-recorder.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const recorder = require('../src/main/recorder');

const RATE = 16000;
let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function readHeader(file) {
  const b = fs.readFileSync(file);
  return {
    riff: b.toString('ascii', 0, 4),
    riffSize: b.readUInt32LE(4),
    wave: b.toString('ascii', 8, 12),
    channels: b.readUInt16LE(22),
    sampleRate: b.readUInt32LE(24),
    bits: b.readUInt16LE(34),
    dataSize: b.readUInt32LE(40),
    fileSize: b.length,
  };
}

const seconds = (n) => Buffer.alloc(RATE * 2 * n);   // n seconds of silence, 16-bit mono

// 1. A normal recording produces a well-formed WAV.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  const r = recorder.create({ dir, sampleRate: RATE, now: () => 1700000000000 });
  r.start();
  r.append(seconds(1));
  r.append(seconds(2));
  const out = r.finish();
  const h = readHeader(out.path);

  check('duration reflects everything appended', out.durationSeconds, 3);
  check('RIFF/WAVE magic', [h.riff, h.wave], ['RIFF', 'WAVE']);
  check('mono 16-bit at the right rate', [h.channels, h.bits, h.sampleRate], [1, 16, RATE]);
  check('data size matches the audio written', h.dataSize, RATE * 2 * 3);
  check('riff size is data + 36', h.riffSize, RATE * 2 * 3 + 36);
  check('file is header + data, nothing else', h.fileSize, 44 + RATE * 2 * 3);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2. The crash case: the process dies mid-recording, so finish() never runs.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  const r = recorder.create({ dir, sampleRate: RATE, now: () => 1700000000000 });
  const { path: file } = r.start();
  r.append(seconds(43));
  // Deliberately no finish() — this is what a killed process leaves behind.

  check('crashed file claims to be empty', readHeader(file).dataSize, 0);
  check('but the bytes are actually on disk', fs.statSync(file).size, 44 + RATE * 2 * 43);

  const orphans = recorder.listOrphans({ dir, sampleRate: RATE });
  check('the recording is found', orphans.length, 1);
  check('its real duration is recovered', orphans[0].durationSeconds, 43);
  check('its start time is recovered', orphans[0].startedAt, 1700000000000);
  check('and the header is repaired in place', readHeader(file).dataSize, RATE * 2 * 43);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 3. A recording still being written is not offered as an orphan.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  const live = recorder.create({ dir, sampleRate: RATE, now: () => 1700000000001 });
  const { path: livePath } = live.start();
  live.append(seconds(5));

  const dead = recorder.create({ dir, sampleRate: RATE, now: () => 1700000000000 });
  dead.append(seconds(9));            // no start(): ignored, proves append is safe when closed
  dead.start();
  dead.append(seconds(9));

  const orphans = recorder.listOrphans({ dir, except: livePath, sampleRate: RATE });
  check('only the other recording is offered', orphans.length, 1);
  check('and it is the right one', orphans[0].durationSeconds, 9);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 4. Scraps too short to be speech are cleaned up rather than offered.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  const r = recorder.create({ dir, sampleRate: RATE, now: () => 1700000000000 });
  const { path: file } = r.start();
  r.append(Buffer.alloc(RATE * 2 * 0.2));

  check('a 200ms scrap is not offered', recorder.listOrphans({ dir, sampleRate: RATE }).length, 0);
  check('and is deleted', fs.existsSync(file), false);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 5. abort() removes the file entirely.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  const r = recorder.create({ dir, sampleRate: RATE, now: () => 1700000000000 });
  const { path: file } = r.start();
  r.append(seconds(2));
  r.abort();
  check('abort deletes the recording', fs.existsSync(file), false);
  check('and leaves nothing to recover', recorder.listOrphans({ dir, sampleRate: RATE }).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 6. Memory does not grow with the length of the recording.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  const r = recorder.create({ dir, sampleRate: RATE, now: () => 1700000000000 });
  r.start();
  const chunk = seconds(1);
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 1800; i++) r.append(chunk);     // 30 minutes
  const after = process.memoryUsage().heapUsed;
  const out = r.finish();
  const grewMB = (after - before) / 1048576;

  check('30 minutes lands on disk', out.durationSeconds, 1800);
  check(`heap grew under 5 MB across 30 min (was ${grewMB.toFixed(1)} MB)`, grewMB < 5, true);
  console.log(`        30 min on disk = ${(out.bytes / 1048576).toFixed(0)} MB, heap grew ${grewMB.toFixed(1)} MB`);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nall recorder tests passed' : `\n${failures} FAILING`);
process.exit(failures === 0 ? 0 : 1);

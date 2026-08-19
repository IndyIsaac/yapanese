// Exercises the real transcription path (tool discovery -> WAV encode -> yap)
// without launching Electron. Run: node tools/test-pipeline.js <wav>
const fs = require('node:fs');
const path = require('node:path');
const { transcribe, findYap } = require('../src/main/transcriber');
const { locate, listMicrophones } = require('../src/main/tools');

(async () => {
  const wavPath = process.argv[2];
  if (!wavPath || !fs.existsSync(wavPath)) {
    console.error('usage: node tools/test-pipeline.js <16khz-mono.wav>');
    process.exit(2);
  }

  console.log('--- tool discovery ---');
  const yap = await findYap('');
  const ffmpeg = await locate('ffmpeg', '');
  console.log('yap    :', yap || 'NOT FOUND');
  console.log('ffmpeg :', ffmpeg || 'NOT FOUND');

  const mics = await listMicrophones('');
  console.log('mics   :', mics.devices.join(' | ') || '(none)');

  if (!yap) process.exit(1);

  // The WAV goes to the transcriber as a path — the audio is never loaded
  // into memory here, which is the same route the app itself takes now.
  const dataBytes = Math.max(0, fs.statSync(wavPath).size - 44);
  const durationSeconds = dataBytes / 2 / 16000;
  console.log(`\n--- transcribing ${path.basename(wavPath)} (${durationSeconds.toFixed(1)}s) ---`);

  const started = Date.now();
  const res = await transcribe({
    wavPath,
    durationSeconds,
    settings: { yapPath: '', model: '' },
  });

  console.log(`elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (res.ok) {
    console.log('RESULT :', res.text);
    process.exit(0);
  }
  console.error('FAILED :', res.error);
  process.exit(1);
})();

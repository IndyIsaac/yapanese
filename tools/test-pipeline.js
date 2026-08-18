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

  // Strip the 44-byte canonical WAV header and read the PCM payload.
  const buf = fs.readFileSync(wavPath);
  const pcm = new Int16Array(buf.buffer, buf.byteOffset + 44, (buf.length - 44) / 2);
  console.log(`\n--- transcribing ${path.basename(wavPath)} (${pcm.length} samples) ---`);

  const started = Date.now();
  const res = await transcribe({
    samples: pcm,
    sampleRate: 16000,
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

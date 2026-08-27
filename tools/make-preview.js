// Generates a browser-previewable copy of the renderer with a stubbed
// window.yapanese API and curated sample content, so the UI can be
// screenshotted without exposing a real user's transcripts. Not shipped.
const fs = require('node:fs');
const path = require('node:path');

const rendererDir = path.join(__dirname, '..', 'src', 'renderer');
const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');

const STUB = `
<script>
const MIN = 60000, HR = 3600000;
const SAMPLE = [
  { id: 'a', startedAt: new Date(Date.now() - 3 * MIN).toISOString(), durationMs: 9000, delivered: 'pasted',
    text: 'Refactor the transcription backend so the whisper call sits behind a protocol, then write tests for the JSON parsing before wiring anything else up.' },
  { id: 'b', startedAt: new Date(Date.now() - 22 * MIN).toISOString(), durationMs: 74000, delivered: 'pasted',
    text: 'Thinking out loud about the history model. If every recording is written to disk before it is delivered anywhere, then a failed paste is only an inconvenience rather than a lost thought. That means delivery can be best effort and the log stays the source of truth, which is a much easier thing to reason about.' },
  { id: 'c', startedAt: new Date(Date.now() - 51 * MIN).toISOString(), durationMs: 6000, delivered: 'copied',
    text: 'note to self — check whether the encoder window still scales correctly past thirty seconds' },
  { id: 'd', startedAt: new Date(Date.now() - 2 * HR).toISOString(), durationMs: 18000, delivered: 'pasted',
    text: 'Draft a reply saying the migration is on track, the staging environment is already cut over, and production follows on Thursday once the backfill finishes.' },
  { id: 'e', startedAt: new Date(Date.now() - 26 * HR).toISOString(), durationMs: 11000, delivered: 'pasted',
    text: 'Add a retry with exponential backoff around the upload step, but cap it at three attempts so a genuine outage fails fast instead of hanging.' },
];
let S = { micDevice: 'Microphone (HyperX Cloud III)', combo: 'ctrl+win', speed: 'balanced',
          vad: true, autoPaste: true, launchAtLogin: true, language: 'en',
          model: '', yapPath: '', ffmpegPath: '' };
window.yapanese = {
  getSettings: async () => S,
  setSettings: async (p) => (S = { ...S, ...p }),
  getHistory: async () => SAMPLE,
  deleteEntry: async (id) => SAMPLE.filter(e => e.id !== id),
  clearHistory: async () => [],
  copyText: async () => ({ ok: true }),
  toggleRecording: async () => 'recording',
  getState: async () => 'idle',
  diagnostics: async () => ({
    yap: 'C:\\\\Users\\\\you\\\\AppData\\\\Local\\\\yap\\\\bin\\\\yap.exe',
    ffmpeg: 'C:\\\\Program Files\\\\ffmpeg\\\\bin\\\\ffmpeg.exe',
    dataDir: 'C:\\\\Users\\\\you\\\\AppData\\\\Roaming\\\\Yapanese',
    whisperCli: 'C:\\\\Users\\\\you\\\\AppData\\\\Local\\\\yap\\\\bin\\\\whisper-cli.exe',
    hotkeyRegistered: true, version: '0.4.0', electron: '43.4.1',
  }),
  openDataDir: () => {},

  // Setup: shown as already complete, which is what a preview of the app in
  // normal use should look like. Flip \`ready\` and the \`installed\` flags to
  // preview the first-run screen instead.
  inspectSetup: async () => ({
    ready: true,
    engine: { installed: true, kind: 'cuda', path: 'C:\\\\Users\\\\you\\\\AppData\\\\Local\\\\yap\\\\bin\\\\whisper-cli.exe', release: 'b4938' },
    gpu: { nvidia: true },
    recommended: 'cuda',
    engines: [
      { id: 'cpu', label: 'CPU', bytes: 8361840,
        note: 'Runs the transcription on your processor. Works on any machine, small download.' },
      { id: 'cuda', label: 'NVIDIA GPU', bytes: 671045732,
        note: 'Runs it on your graphics card instead — roughly three times faster. Large, because it includes NVIDIA\\u2019s CUDA libraries.' },
    ],
    models: [
      { id: 'speech', label: 'Speech model', bytes: 574041195, required: true, installed: true,
        note: 'The trained model whisper.cpp reads — this is the part that knows what words sound like. large-v3-turbo, quantised.' },
      { id: 'vad', label: 'Voice detection model', bytes: 885098, required: true, installed: true,
        note: 'Silero. Discards room noise so it never becomes invented text.' },
      { id: 'fast', label: 'Fast model', bytes: 77704715, required: false, installed: false,
        note: 'tiny.en. Only used by the Fast quality setting — skip it unless you want that.' },
    ],
    binDir: 'C:\\\\Users\\\\you\\\\AppData\\\\Local\\\\yap\\\\bin',
    modelsDir: 'C:\\\\Users\\\\you\\\\AppData\\\\Local\\\\yap\\\\models',
  }),
  runSetup: async () => ({ ok: true }),
  cancelSetup: async () => ({ ok: true }),

  getUpdate: async () => ({ state: 'none' }),
  checkUpdate: async () => ({ state: 'none' }),
  downloadUpdate: async () => ({ ok: true }),
  installUpdate: async () => ({ ok: true }),

  on: () => () => {},
};
navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [] });
navigator.mediaDevices.enumerateDevices = async () => ([
  { kind: 'audioinput', deviceId: '1', label: 'Microphone (HyperX Cloud III)' },
  { kind: 'audioinput', deviceId: '2', label: 'Microphone (EMEET SmartCam S600)' },
]);
</script>
`;

const out = html
  .replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?>/, '')
  .replace('<script src="./app.js"></script>', `${STUB}\n<script src="./app.js"></script>`);

fs.writeFileSync(path.join(rendererDir, 'preview.html'), out, 'utf8');
console.log('wrote src/renderer/preview.html');

// Generates a browser-previewable copy of the renderer with a stubbed
// window.murmur, so the UI can be inspected and screenshotted without
// launching Electron. Not shipped.
const fs = require('node:fs');
const path = require('node:path');

const rendererDir = path.join(__dirname, '..', 'src', 'renderer');
const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');

const STUB = `
<script>
const SAMPLE = [
  { id: 'a', startedAt: new Date(Date.now() - 4 * 60000).toISOString(), durationMs: 31000, delivered: 'pasted',
    text: 'Refactor the transcription backend so the whisper subprocess call sits behind a protocol, then write tests for the JSON parsing before wiring anything else up.' },
  { id: 'b', startedAt: new Date(Date.now() - 11 * 60000).toISOString(), durationMs: 7000, delivered: 'copied',
    text: 'note to self, check whether uiohook actually reports key up reliably on Windows' },
  { id: 'c', startedAt: new Date(Date.now() - 44 * 60000).toISOString(), durationMs: 72000, delivered: 'pasted',
    text: 'Thinking out loud about the history model. If every recording writes to disk before it is delivered anywhere, then a failed paste is only an inconvenience rather than a lost transcript. That means delivery can be best effort and the log stays the source of truth.' },
  { id: 'd', startedAt: new Date(Date.now() - 26 * 3600000).toISOString(), durationMs: 14000, delivered: 'pasted',
    text: 'And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country.' },
];
let S = { micDevice: 'Microphone (HyperX Cloud III)', combo: 'ctrl+win', speed: 'balanced',
          autoPaste: true, launchAtLogin: true, language: 'en', model: '', yapPath: '', ffmpegPath: '' };
window.murmur = {
  getSettings: async () => S,
  setSettings: async (p) => (S = { ...S, ...p }),
  getHistory: async () => SAMPLE,
  deleteEntry: async (id) => SAMPLE.filter(e => e.id !== id),
  clearHistory: async () => [],
  copyText: async () => ({ ok: true }),
  toggleRecording: async () => 'recording',
  getState: async () => 'idle',
  diagnostics: async () => ({
    yap: 'C:\\\\Users\\\\User\\\\AppData\\\\Local\\\\yap\\\\bin\\\\yap.exe',
    ffmpeg: 'C:\\\\Users\\\\User\\\\AppData\\\\Local\\\\Microsoft\\\\WinGet\\\\Packages\\\\Gyan.FFmpeg\\\\bin\\\\ffmpeg.exe',
    dataDir: 'C:\\\\Users\\\\User\\\\AppData\\\\Roaming\\\\murmur',
    hotkeyRegistered: true, version: '0.1.0', electron: '33.2.0',
  }),
  openDataDir: () => {},
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

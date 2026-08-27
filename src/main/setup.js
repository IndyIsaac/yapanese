'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { YAP_BIN } = require('./tools');
const { download, HUGGINGFACE, GITHUB } = require('./download');
const { extract } = require('./unzip');
const whisper = require('./whisper');

/**
 * First-run setup.
 *
 * Yapanese is a front end for whisper.cpp, and whisper.cpp is a binary and a
 * pair of model files that the installer has no business carrying: together
 * they are an order of magnitude larger than the app, and which build is the
 * right one depends on the machine. So they are fetched here instead, once,
 * with the user watching.
 *
 * Everything is pinned. A release tag, a byte count and a SHA-256 for each
 * artifact means this either installs exactly what was reviewed or installs
 * nothing — see download.js for why that matters for files whisper-cli is
 * about to parse.
 */

// Pinned deliberately. Following "latest" would mean a build nobody checked
// arriving on a user's machine, and the digests below would be unverifiable.
// Bumping this is a code change: new tag, new sizes, new digests.
const WHISPER_RELEASE = 'b4938';

const releaseUrl = (file) =>
  `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_RELEASE}/${file}`;

/**
 * The two builds worth offering.
 *
 * cuBLAS is 80x the download because it ships CUDA's own libraries, and it is
 * worth it — the same clip that takes 2.0s on this CPU takes 0.8s on the GPU.
 * The 12.4 build covers every NVIDIA card new enough to be faster than the
 * processor next to it; anything older is better served by the CPU build than
 * by an install that fails at runtime.
 */
const ENGINES = {
  cpu: {
    id: 'cpu',
    label: 'CPU',
    note: 'Runs the transcription on your processor. Works on any machine, small download.',
    file: 'whisper-bin-x64.zip',
    bytes: 8361840,
    sha256: 'c2a4b60edb11f7e11a9191ffb50929535527d4d91c9903dbe3e554583bbbc63d',
  },
  cuda: {
    id: 'cuda',
    label: 'NVIDIA GPU',
    note: 'Runs it on your graphics card instead — roughly three times faster. Large, because it includes NVIDIA’s CUDA libraries.',
    file: 'whisper-cublas-12.4.0-bin-x64.zip',
    bytes: 671045732,
    sha256: 'c1b17166e1e31a91cc8e9c1f910d3785e3ce757bb2958bf9dce13fdb4880005f',
  },
};

const MODELS = {
  speech: {
    id: 'speech',
    label: 'Speech model',
    note: 'The trained model whisper.cpp reads — this is the part that knows what words sound like. large-v3-turbo, quantised.',
    file: whisper.DEFAULT_MODEL,
    bytes: 574041195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    required: true,
  },
  vad: {
    id: 'vad',
    label: 'Voice detection model',
    note: 'Silero. Discards room noise so it never becomes invented text.',
    file: whisper.VAD_MODEL,
    bytes: 885098,
    sha256: '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf',
    required: true,
    repo: 'ggml-org/whisper-vad',
  },
  fast: {
    id: 'fast',
    label: 'Fast model',
    note: 'tiny.en. Only used by the Fast quality setting — skip it unless you want that.',
    file: whisper.FAST_MODEL,
    bytes: 77704715,
    sha256: '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f',
    required: false,
  },
};

const modelUrl = (model) =>
  `https://huggingface.co/${model.repo || 'ggerganov/whisper.cpp'}/resolve/main/${model.file}`;

/** Written beside the binaries so a later install knows what the last one put
 *  there. Switching CPU <-> CUDA has to remove the old DLLs: whisper-cli
 *  loads whatever backend it finds next to it, and a mix of two builds is a
 *  crash rather than a fallback. */
const MANIFEST = path.join(YAP_BIN, 'installed-by-yapanese.json');

function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); }
  catch { return null; }
}

function modelPath(model) {
  return path.join(whisper.modelsDir(), model.file);
}

function isInstalled(entry, file) {
  try { return fs.statSync(file).size === entry.bytes; }
  catch { return false; }
}

/**
 * Is there an NVIDIA card in this machine?
 *
 * Electron knows, because it already enumerated the display adapters to
 * decide how to composite. Outside Electron — the test scripts in tools/ —
 * fall back to the driver's own runtime library, which is only present when
 * an NVIDIA driver is.
 */
async function detectGpu() {
  try {
    const { app } = require('electron');
    const info = await app.getGPUInfo('basic');
    const devices = info?.gpuDevice || [];
    const nvidia = devices.find((d) => d.vendorId === 0x10de);
    if (nvidia) return { nvidia: true, deviceId: nvidia.deviceId };
    if (devices.length) return { nvidia: false };
  } catch { /* not running under Electron, or GPU info unavailable */ }

  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvcuda.dll');
  return { nvidia: fs.existsSync(system32) };
}

/**
 * What is present, what is missing, and which build the machine wants.
 *
 * `ready` is the question the rest of the app actually asks: can a recording
 * be transcribed right now?
 */
async function inspect() {
  const manifest = readManifest();
  const exe = path.join(YAP_BIN, 'whisper-cli.exe');
  const own = fs.existsSync(exe);
  // A whisper-cli that arrived some other way — dropped into the bin folder
  // by hand, or already on PATH — counts. Setup exists to remove work, not to
  // insist on owning the files. Without a manifest it is somebody else's
  // install either way, and this must not offer to remove files it did not
  // put there.
  const elsewhere = own ? null : await require('./tools').locate('whisper-cli');
  const engineInstalled = own || !!elsewhere;

  const gpu = await detectGpu();
  const recommended = gpu.nvidia ? 'cuda' : 'cpu';

  const models = Object.values(MODELS).map((m) => ({
    id: m.id,
    label: m.label,
    note: m.note,
    bytes: m.bytes,
    required: m.required,
    installed: isInstalled(m, modelPath(m)),
  }));

  return {
    ready: engineInstalled && models.every((m) => !m.required || m.installed),
    engine: {
      installed: engineInstalled,
      kind: engineInstalled ? (manifest?.engine || 'external') : null,
      path: elsewhere || (own ? exe : null),
      release: manifest?.release || null,
    },
    gpu,
    recommended,
    engines: Object.values(ENGINES).map((e) => ({
      id: e.id, label: e.label, note: e.note, bytes: e.bytes,
    })),
    models,
    binDir: YAP_BIN,
    modelsDir: whisper.modelsDir(),
  };
}

/** Take out what a previous install of the other build left behind. Only
 *  files this app wrote, named one by one — the bin directory is a place a
 *  user may also have put yap.exe or ffmpeg.exe by hand. */
function removePreviousEngine(onLog) {
  const manifest = readManifest();
  if (!manifest?.files?.length) return;
  for (const name of manifest.files) {
    try { fs.rmSync(path.join(YAP_BIN, path.basename(name)), { force: true }); }
    catch (err) { onLog?.(`could not remove ${name}: ${err.message}`); }
  }
  fs.rmSync(MANIFEST, { force: true });
}

async function installEngine(engine, { onProgress, signal, onLog }) {
  const zip = path.join(os.tmpdir(), `yapanese-${engine.file}`);

  const got = await download({
    url: releaseUrl(engine.file),
    dest: zip,
    bytes: engine.bytes,
    sha256: engine.sha256,
    allow: GITHUB,
    signal,
    onProgress: ({ received, total }) =>
      onProgress({ phase: 'download', received, total }),
  });
  if (!got.ok) return got;

  onProgress({ phase: 'install', received: 0, total: engine.bytes });
  removePreviousEngine(onLog);

  try {
    const files = await extract({
      zipPath: zip,
      destDir: YAP_BIN,
      // The release carries a couple of dozen executables — servers, benchmarks,
      // a chess demo. Yapanese calls exactly one of them.
      pick: (name) => {
        const base = path.basename(name);
        return base === 'whisper-cli.exe' || base.toLowerCase().endsWith('.dll') ? base : null;
      },
      onFile: (name) => onLog?.(`unpacked ${name}`),
    });

    fs.writeFileSync(MANIFEST, JSON.stringify({
      engine: engine.id,
      release: WHISPER_RELEASE,
      files,
      installedAt: new Date().toISOString(),
    }, null, 2));

    return { ok: true, files: files.length };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    // Well over half a gigabyte of temp file, and it has done its job.
    fs.rm(zip, { force: true }, () => {});
  }
}

function installModel(model, { onProgress, signal }) {
  return download({
    url: modelUrl(model),
    dest: modelPath(model),
    bytes: model.bytes,
    sha256: model.sha256,
    allow: HUGGINGFACE,
    signal,
    onProgress: ({ received, total }) => onProgress({ phase: 'download', received, total }),
  });
}

/**
 * Run the install.
 *
 * `onProgress` is called with the component being worked on and how far along
 * it is. Steps run in order and stop at the first failure, so a machine that
 * loses its connection halfway ends up with fewer components rather than
 * broken ones — every artifact is verified before it is put in place, and
 * `inspect()` will report exactly what is still missing.
 */
async function install({ engine = null, extras = [] } = {}, { onProgress, signal, onLog } = {}) {
  const steps = [];

  if (engine && ENGINES[engine]) {
    steps.push({
      id: 'engine',
      label: `whisper.cpp (${ENGINES[engine].label})`,
      run: (hooks) => installEngine(ENGINES[engine], hooks),
    });
  }
  for (const model of Object.values(MODELS)) {
    if (!model.required && !extras.includes(model.id)) continue;
    if (isInstalled(model, modelPath(model))) continue;
    steps.push({
      id: model.id,
      label: model.label,
      run: (hooks) => installModel(model, hooks),
    });
  }

  const report = (step, index, extra) => onProgress?.({
    id: step.id,
    label: step.label,
    step: index + 1,
    steps: steps.length,
    ...extra,
  });

  for (const [index, step] of steps.entries()) {
    report(step, index, { phase: 'start', received: 0, total: 0 });
    onLog?.(`setup: ${step.label}`);

    const res = await step.run({
      signal,
      onLog,
      onProgress: (p) => report(step, index, p),
    });

    if (!res.ok) {
      onLog?.(`setup: ${step.label} failed — ${res.error}`);
      report(step, index, { phase: 'failed', error: res.error });
      return { ok: false, error: res.error, failed: step.id, cancelled: res.error === 'cancelled' };
    }
    report(step, index, { phase: 'done' });
  }

  onLog?.('setup: complete');
  return { ok: true, installed: steps.map((s) => s.id) };
}

module.exports = {
  inspect, install, detectGpu, ENGINES, MODELS, WHISPER_RELEASE, MANIFEST,
};

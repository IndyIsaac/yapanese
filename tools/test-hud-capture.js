// Loads the real hud.js in a VM and stops a capture while start() is still
// waiting — on the device list, the microphone, or the worklet module — then
// records normally. An abandoned start used to leave a live audio graph
// feeding every later recording, doubling its samples.
//
// Usage: node tools/test-hud-capture.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const HUD = fs.readFileSync(process.argv[2] || path.join(__dirname, '../src/renderer/hud.js'), 'utf8');

// A DOM stand-in: every property is another stub, every call returns one.
function stub() {
  const store = {};
  const fn = function () { return stub(); };
  return new Proxy(fn, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => '';
      if (k in store) return store[k];
      if (k === 'then') return undefined;
      return (store[k] = stub());
    },
    set(t, k, v) { store[k] = v; return true; },
    apply() { return stub(); },
  });
}

// One HUD instance with a microphone whose every wait is held open until the
// test lets it go, so a stop can be dropped into any of them.
function load() {
  const handlers = {};
  const chunks = [];
  const errors = [];
  const gates = { devices: [], mic: [], module: [] };
  const hold = (queue) => new Promise((resolve, reject) => queue.push({ resolve, reject }));
  const liveGraphs = new Set();
  let openStreams = 0;

  const api = new Proxy({
    on: (ch, fn) => { handlers[ch] = fn; },
    sendChunk: (b) => chunks.push(b.byteLength / 2),
    sendError: (m) => errors.push(m),
  }, { get: (t, k) => (k in t ? t[k] : () => {}) });

  class FakeTrack { stop() { if (!this.stopped) { this.stopped = true; openStreams--; } } }
  const mediaDevices = {
    enumerateDevices: () => hold(gates.devices),
    getUserMedia: () => hold(gates.mic).then(() => {
      openStreams++;
      const track = new FakeTrack();
      return { getTracks: () => [track] };
    }),
  };
  class FakeContext {
    constructor() { this.sampleRate = 16000; this.audioWorklet = { addModule: () => hold(gates.module) }; this.destination = {}; }
    createMediaStreamSource() { return { connect() {} }; }
    createGain() { return { gain: {}, connect() {} }; }
    close() { for (const g of liveGraphs) if (g.ctx === this) liveGraphs.delete(g); }
  }
  class FakeNode {
    constructor(ctx) { this.ctx = ctx; this.port = {}; liveGraphs.add(this); }
    connect() {}
    disconnect() {}
  }

  const ctx = {
    window: { yapanese: api, addEventListener() {} }, document: stub(), navigator: { mediaDevices },
    AudioContext: FakeContext, AudioWorkletNode: FakeNode,
    setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: () => 0,
    console, Math, Date, Float32Array, Int16Array, Uint8Array, Array, Symbol, String, Number, Promise,
  };
  vm.createContext(ctx);
  vm.runInContext(HUD, ctx);

  return {
    handlers, chunks, errors, gates, liveGraphs,
    openStreams: () => openStreams,
    // Every live graph delivers one 128-sample render quantum per tick.
    tick(n) {
      for (let i = 0; i < n; i++) {
        for (const g of liveGraphs) g.port.onmessage?.({ data: { samples: new Float32Array(128).fill(0.1), peak: 0.1 } });
      }
    },
  };
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const open = (gate) => gate.shift().resolve([]);
const LABEL = 'Microphone (Test)';

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

/** Start and let every wait through, as a normal recording does. */
async function startFully(h) {
  h.handlers['capture:start']({ deviceLabel: LABEL });
  await settle(); open(h.gates.devices);
  await settle(); open(h.gates.mic);
  await settle(); open(h.gates.module);
  await settle();
}

const NO_AUDIO = 'No audio was captured. Check that the right microphone is selected.';

const STAGES = ['devices', 'mic', 'module'];

(async () => {
  // 1-3. Stopped during each wait, then a normal one-second recording.
  for (const stage of STAGES) {
    const h = load();
    h.handlers['capture:start']({ deviceLabel: LABEL });
    for (const g of STAGES) {
      await settle();
      if (g === stage) h.handlers['capture:stop']();
      open(h.gates[g]);
      if (g === stage) break;
    }
    // Let the abandoned start run on through any waits it still has.
    for (const g of STAGES) { await settle(); if (h.gates[g].length) open(h.gates[g]); }
    await settle();
    check(`stopped during ${stage} -> reported as nothing recorded`, h.errors, [NO_AUDIO]);

    h.chunks.length = 0;
    await startFully(h);
    h.tick(125);                       // 125 x 128 = 16000 samples
    h.handlers['capture:stop']();
    await settle();
    check(`stopped during ${stage} -> next recording is not doubled`,
      h.chunks.reduce((a, b) => a + b, 0), 16000);
    check(`stopped during ${stage} -> nothing left running`,
      { graphs: h.liveGraphs.size, streams: h.openStreams() }, { graphs: 0, streams: 0 });
  }

  // 4. The microphone is refused while the key is already released. The real
  //    reason is what gets reported, not a hint to check the device.
  {
    const h = load();
    h.handlers['capture:start']({ deviceLabel: LABEL });
    await settle(); open(h.gates.devices);
    await settle();
    h.handlers['capture:stop']();
    const denied = new Error('Permission denied');
    denied.name = 'NotAllowedError';
    h.gates.mic.shift().reject(denied);
    await settle();
    check('denied while stopping -> permission error reported once',
      h.errors, ['Microphone access was denied. Allow it in Windows Settings › Privacy › Microphone.']);
  }

  console.log(failures === 0 ? '\nall hud capture tests passed' : `\n${failures} FAILING`);
  process.exit(failures === 0 ? 0 : 1);
})();

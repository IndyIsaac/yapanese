// Loads the real hud.js in a VM, stops a capture while getUserMedia is still
// pending, then records normally. The abandoned start used to leave a live
// audio graph feeding every later recording, doubling its samples.
// Usage: node tools/test-hud-capture.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');

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

const handlers = {};
const chunks = [];
const errors = [];
const api = new Proxy({
  on: (ch, fn) => { handlers[ch] = fn; },
  sendChunk: (b) => chunks.push(b.byteLength / 2),
  sendResult: (r) => results.push(r),
  sendError: (m) => errors.push(m),
}, { get: (t, k) => (k in t ? t[k] : () => {}) });
const results = [];

// Controllable mic: each getUserMedia call waits until released by the test.
const gumWaiters = [];
const liveGraphs = new Set();
let openStreams = 0;
class FakeTrack { stop() { if (!this.stopped) { this.stopped = true; openStreams--; } } }
const mediaDevices = {
  enumerateDevices: async () => [],
  getUserMedia: () => new Promise((res) => gumWaiters.push(() => {
    openStreams++;
    const track = new FakeTrack();
    res({ getTracks: () => [track] });
  })),
};
class FakeContext {
  constructor() { this.sampleRate = 16000; this.audioWorklet = { addModule: async () => {} }; this.destination = {}; }
  createMediaStreamSource() { return { connect() {} }; }
  createGain() { return { gain: {}, connect() {} }; }
  close() { this.closed = true; for (const g of liveGraphs) if (g.ctx === this) liveGraphs.delete(g); }
}
class FakeNode {
  constructor(ctx) { this.ctx = ctx; this.port = {}; liveGraphs.add(this); }
  connect() {}
  disconnect() {}
}
// Every live graph delivers one render quantum per "tick".
function tick(n) {
  for (let i = 0; i < n; i++) {
    for (const g of liveGraphs) g.port.onmessage?.({ data: { samples: new Float32Array(128).fill(0.1), peak: 0.1 } });
  }
}

const ctx = {
  window: { yapanese: api }, document: stub(), navigator: { mediaDevices },
  AudioContext: FakeContext, AudioWorkletNode: FakeNode,
  setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: () => 0,
  console, Math, Date, Float32Array, Int16Array, Uint8Array, Array, Symbol, String, Number, Promise,
};
ctx.window.addEventListener = () => {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[2] || path.join(__dirname, '../src/renderer/hud.js'), 'utf8'), ctx);

const flushMicro = () => new Promise((r) => setImmediate(r));

(async () => {
  // Phantom tap: start, stop before the mic answers, then the mic answers.
  handlers['capture:start']({ deviceLabel: '' });
  await flushMicro();
  handlers['capture:stop']();
  gumWaiters.shift()();
  await flushMicro(); await flushMicro();

  // A real recording of 125 quanta = 16000 samples.
  chunks.length = 0;
  handlers['capture:start']({ deviceLabel: '' });
  await flushMicro();
  gumWaiters.shift()();
  await flushMicro(); await flushMicro();
  tick(125);
  handlers['capture:stop']();
  await flushMicro();

  const written = chunks.reduce((a, b) => a + b, 0);
  console.log(`samples written: ${written} (expected 16000)`);
  console.log(`graphs still live after stop: ${liveGraphs.size} (expected 0)`);
  console.log(`mic streams still open: ${openStreams} (expected 0)`);
  console.log(`errors: ${JSON.stringify(errors)}`);
  const ok = written === 16000 && liveGraphs.size === 0 && openStreams === 0;
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})();

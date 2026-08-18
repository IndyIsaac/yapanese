// Audio capture worklet.
//
// Kept as a real file rather than a blob: URL — AudioWorklet modules are
// governed by the page's `script-src`, not `worker-src`, so a blob would
// require loosening CSP with `blob:`. A same-origin file satisfies 'self'.
class Collector extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channel = input[0];

    let peak = 0;
    for (let i = 0; i < channel.length; i++) {
      const v = channel[i] < 0 ? -channel[i] : channel[i];
      if (v > peak) peak = v;
    }

    this.port.postMessage({ samples: new Float32Array(channel), peak });
    return true;
  }
}

registerProcessor('collector', Collector);

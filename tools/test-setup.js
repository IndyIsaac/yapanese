'use strict';

/**
 * Exercise first-run setup without Electron and without the UI.
 *
 *   node tools/test-setup.js                 what is installed, and what setup would do
 *   node tools/test-setup.js --install       actually run it (cpu engine unless --cuda)
 *   node tools/test-setup.js --install --cuda --extras fast
 *
 * The install path here is the same code the Setup screen drives, so a
 * failure that only shows up against the real endpoints — a moved release, a
 * changed digest — is findable without speaking into a microphone.
 */

const setup = require('../src/main/setup');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const at = argv.indexOf(flag);
  return at === -1 ? null : argv[at + 1];
};

function bar(received, total, width = 28) {
  const filled = total ? Math.round((received / total) * width) : 0;
  return `[${'#'.repeat(filled)}${'.'.repeat(width - filled)}]`;
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

(async () => {
  const state = await setup.inspect();

  console.log(`ready:       ${state.ready}`);
  console.log(`gpu:         ${state.gpu.nvidia ? 'NVIDIA present' : 'no NVIDIA adapter'} -> recommends ${state.recommended}`);
  console.log(`engine:      ${state.engine.installed ? `${state.engine.kind} at ${state.engine.path}` : 'not installed'}`);
  console.log(`bin dir:     ${state.binDir}`);
  console.log(`models dir:  ${state.modelsDir}`);
  console.log('models:');
  for (const m of state.models) {
    console.log(`  ${m.installed ? 'x' : ' '} ${m.id.padEnd(7)} ${mb(m.bytes).padStart(9)}  ${m.required ? 'required' : 'optional'}`);
  }

  if (!has('--install')) {
    console.log('\n(run with --install to fetch what is missing)');
    return;
  }

  const engine = state.engine.installed ? null : (has('--cuda') ? 'cuda' : 'cpu');
  const extras = valueOf('--extras') ? valueOf('--extras').split(',') : [];
  console.log(`\ninstalling: engine=${engine || 'already present'} extras=${extras.join(',') || 'none'}\n`);

  // A 640 MB download fires this a few thousand times. Redrawing on every
  // one of them is what turns a test log into three megabytes of bar.
  let lastDraw = 0;
  const draw = (line, force) => {
    if (!force && Date.now() - lastDraw < 250) return;
    lastDraw = Date.now();
    process.stdout.write(`\r${line.padEnd(72)}`);
  };

  const res = await setup.install({ engine, extras }, {
    onLog: (m) => process.stdout.write(`\r${''.padEnd(72)}\r${m}\n`),
    onProgress: (p) => {
      if (p.phase === 'download' && p.total) {
        draw(`${p.label} ${bar(p.received, p.total)} ${mb(p.received)} / ${mb(p.total)}`,
             p.received === p.total);
      } else if (p.phase === 'install') {
        draw(`${p.label} unpacking…`, true);
      } else if (p.phase === 'done') {
        draw(`${p.label} done`, true);
        process.stdout.write('\n');
      }
    },
  });

  console.log(`\n\n${res.ok ? 'ok' : `FAILED at ${res.failed}: ${res.error}`}`);
  const after = await setup.inspect();
  console.log(`ready: ${after.ready}`);
  process.exit(res.ok ? 0 : 1);
})().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});

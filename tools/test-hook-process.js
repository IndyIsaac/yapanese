// Forks the hook process directly (no Electron) and exercises its message
// protocol: ready -> combo -> reset -> stop.
//
// Deliberately does NOT exercise 'paste', because that synthesises a real
// Ctrl+V into whatever window has focus. Verify that one by hand.
//
// Usage: node tools/test-hook-process.js
const path = require('node:path');
const { fork } = require('node:child_process');

const child = fork(path.join(__dirname, '..', 'src', 'main', 'hook-process.js'), [], { stdio: 'inherit' });
const seen = [];
let failures = 0;

function check(name, ok) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

const timeout = setTimeout(() => {
  check('protocol completed within 8s', false);
  try { child.kill(); } catch {}
  process.exit(1);
}, 8000);

child.on('message', (msg) => {
  seen.push(msg.type);
  if (msg.type === 'ready') {
    check('hook process starts and reports ready', !msg.error);
    if (msg.error) { console.log('        error:', msg.error); }
    child.send({ type: 'combo', combo: 'alt+win' });
  }
  if (msg.type === 'combo:set') {
    check('combo change acknowledged with its display name', msg.name === 'Alt + Win');
    child.send({ type: 'reset' });
    setTimeout(() => child.send({ type: 'stop' }), 150);
  }
});

child.on('exit', (code) => {
  clearTimeout(timeout);
  check('exits cleanly on stop', code === 0);
  check('saw ready before combo:set', seen.indexOf('ready') === 0 && seen.includes('combo:set'));
  console.log(failures === 0 ? '\nhook process protocol ok' : `\n${failures} FAILING`);
  process.exit(failures === 0 ? 0 : 1);
});

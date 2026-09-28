// Drives the restart-when-idle scheduler with a fake clock, so the rule that
// an update never interrupts a dictation is verified without real waiting.
//
// Usage: node tools/test-update-restart.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scheduler = require('../src/main/restart-scheduler');
const quietRelaunch = require('../src/main/quiet-relaunch');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function harness() {
  let clock = 1000;
  const restarts = [];
  const timers = new Map();
  let nextTimer = 1;

  const s = scheduler.create({
    restart: () => restarts.push(clock),
    setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimer: (id) => timers.delete(id),
  });

  return {
    s, restarts,
    advance(ms) {
      const target = clock + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (!next || t.at < next[1].at)) next = [id, t];
        }
        if (!next) break;
        timers.delete(next[0]);
        clock = next[1].at;
        next[1].fn();
      }
      clock = target;
    },
    pending: () => timers.size,
  };
}

const IDLE = scheduler.IDLE_MS;

// 1. Idle the whole time: restarts once the idle period has passed, not before.
{
  const h = harness();
  h.s.arm();
  h.advance(IDLE - 1);
  check('idle -> no restart before the idle period', h.restarts.length, 0);
  h.advance(1);
  check('idle -> restarts at the end of the idle period', h.restarts.length, 1);
}

// 2. Busy when armed: never restarts while busy, then waits a full period.
{
  const h = harness();
  h.s.setBusy(true);
  h.s.arm();
  h.advance(IDLE * 10);
  check('busy -> no restart', h.restarts.length, 0);
  h.s.setBusy(false);
  h.advance(IDLE - 1);
  check('busy then idle -> idle period starts when busy ends', h.restarts.length, 0);
  h.advance(1);
  check('busy then idle -> restarts after a full idle period', h.restarts.length, 1);
}

// 3. A short dictation during the countdown starts it over. Sampling every
//    five seconds missed one that began and ended between two samples.
{
  const h = harness();
  h.s.arm();
  h.advance(IDLE - 5000);
  h.s.setBusy(true);
  h.advance(2000);
  h.s.setBusy(false);
  h.advance(IDLE - 1);
  check('2s dictation mid-countdown -> countdown restarts', h.restarts.length, 0);
  h.advance(1);
  check('2s dictation mid-countdown -> restarts a full period after it', h.restarts.length, 1);
}

// 4. Fires once, and leaves nothing running.
{
  const h = harness();
  h.s.arm();
  h.advance(IDLE * 5);
  check('fires exactly once', h.restarts.length, 1);
  check('no timer left running after firing', h.pending(), 0);
}

// 5. Arming twice does not double up; disarming cancels, busy or not.
{
  const h = harness();
  h.s.arm(); h.s.arm();
  h.advance(IDLE * 5);
  check('armed twice -> one restart', h.restarts.length, 1);

  const d = harness();
  d.s.arm();
  d.advance(IDLE / 2);
  d.s.disarm();
  d.s.setBusy(true); d.s.setBusy(false);
  d.advance(IDLE * 5);
  check('disarmed -> no restart, even after busy changes', d.restarts.length, 0);
  check('disarmed -> no timer left running', d.pending(), 0);
}

// 6. After a restart that did not happen (the install failed), it can be
//    armed again.
{
  const h = harness();
  h.s.arm();
  h.advance(IDLE);
  h.s.arm();
  h.advance(IDLE);
  check('re-armed after firing -> fires again', h.restarts.length, 2);
}

// 7. Repeated "still idle" reports do not keep pushing the restart back.
{
  const h = harness();
  h.s.arm();
  for (let i = 0; i < 6; i++) { h.advance(IDLE / 6); h.s.setBusy(false); }
  check('repeated idle reports -> still restarts on time', h.restarts.length, 1);
}

// 8. Busy changes before arming are remembered.
{
  const h = harness();
  h.s.setBusy(true);
  h.advance(IDLE * 2);
  h.s.arm();
  h.advance(IDLE * 2);
  check('busy before arming -> no restart', h.restarts.length, 0);
}

// Quiet relaunch: an automatic restart must come back in the tray, not pop
// the window up over whatever the user is doing.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yap-relaunch-'));
  let clock = 50_000;
  const q = quietRelaunch.create({ file: path.join(dir, 'relaunch-quietly'), now: () => clock });

  check('no marker -> ordinary launch', q.consume(), false);

  q.mark();
  clock += 8_000;                      // the installer runs, the app comes back
  check('marked just now -> relaunch quietly', q.consume(), true);
  check('marker is used once', q.consume(), false);

  q.mark();
  clock += quietRelaunch.MAX_AGE_MS + 1;
  check('stale marker -> ordinary launch', q.consume(), false);
  check('stale marker is cleaned up', fs.existsSync(path.join(dir, 'relaunch-quietly')), false);

  q.mark();
  q.clear();                           // the install failed; nothing relaunches
  check('cleared marker -> ordinary launch', q.consume(), false);

  fs.writeFileSync(path.join(dir, 'relaunch-quietly'), 'not a number');
  check('unreadable marker -> ordinary launch', q.consume(), false);

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nall update restart tests passed' : `\n${failures} FAILING`);
process.exit(failures === 0 ? 0 : 1);

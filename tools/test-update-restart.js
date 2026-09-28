// Drives the restart-when-idle scheduler with a fake clock, so the rule that
// an update never interrupts a dictation is verified without real waiting.
//
// Usage: node tools/test-update-restart.js
const scheduler = require('../src/main/restart-scheduler');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function harness() {
  let clock = 1000;
  let busy = false;
  const restarts = [];
  const timers = new Map();
  let nextTimer = 1;

  const s = scheduler.create({
    isBusy: () => busy,
    restart: () => restarts.push(clock),
    now: () => clock,
    setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimer: (id) => timers.delete(id),
  });

  return {
    s, restarts,
    setBusy(b) { busy = b; },
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
  h.advance(scheduler.POLL_MS);
  check('idle -> restarts after the idle period', h.restarts.length, 1);
}

// 2. Busy (recording or transcribing): never restarts while busy.
{
  const h = harness();
  h.setBusy(true);
  h.s.arm();
  h.advance(IDLE * 10);
  check('busy -> no restart', h.restarts.length, 0);
  h.setBusy(false);
  h.advance(IDLE - scheduler.POLL_MS);
  check('busy then idle -> idle period starts when busy ends', h.restarts.length, 0);
  h.advance(scheduler.POLL_MS * 2);
  check('busy then idle -> restarts after a full idle period', h.restarts.length, 1);
}

// 3. A dictation during the countdown starts it over.
{
  const h = harness();
  h.s.arm();
  h.advance(IDLE - scheduler.POLL_MS);
  h.setBusy(true);
  h.advance(scheduler.POLL_MS);
  h.setBusy(false);
  h.advance(IDLE - scheduler.POLL_MS);
  check('dictation mid-countdown -> countdown restarts', h.restarts.length, 0);
  h.advance(scheduler.POLL_MS * 2);
  check('dictation mid-countdown -> restarts after a fresh idle period', h.restarts.length, 1);
}

// 4. Fires once, and stops polling afterwards.
{
  const h = harness();
  h.s.arm();
  h.advance(IDLE * 5);
  check('fires exactly once', h.restarts.length, 1);
  check('no timer left running after firing', h.pending(), 0);
}

// 5. Arming twice does not double up; disarming cancels.
{
  const h = harness();
  h.s.arm(); h.s.arm();
  h.advance(IDLE * 5);
  check('armed twice -> one restart', h.restarts.length, 1);

  const d = harness();
  d.s.arm();
  d.advance(IDLE / 2);
  d.s.disarm();
  d.advance(IDLE * 5);
  check('disarmed -> no restart', d.restarts.length, 0);
  check('disarmed -> no timer left running', d.pending(), 0);
}

console.log(failures === 0 ? '\nall update restart tests passed' : `\n${failures} FAILING`);
process.exit(failures === 0 ? 0 : 1);

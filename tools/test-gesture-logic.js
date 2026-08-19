// Drives the gesture state machine with a fake clock, so hold / double-tap /
// lock behaviour is verified without pressing keys or waiting in real time.
//
// Usage: node tools/test-gesture-logic.js
const { UiohookKey } = require('uiohook-napi');
const gestures = require('../src/main/gestures');

const CTRL = UiohookKey.Ctrl;
const WIN = UiohookKey.Meta;
const A = UiohookKey.A;

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function harness() {
  let clock = 1000;
  const events = [];
  const timers = new Map();
  let nextTimer = 1;

  const g = gestures.create({
    onStart: () => events.push('start'),
    onFinish: () => events.push('finish'),
    onLockChanged: (l) => events.push(l ? 'lock' : 'unlock'),
    now: () => clock,
    setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimer: (id) => timers.delete(id),
  });

  return {
    g, events,
    advance(ms) {
      clock += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= clock) { timers.delete(id); t.fn(); }
      }
    },
    comboDown() { g.key(CTRL, true); g.key(WIN, true); },
    comboUp() { g.key(WIN, false); g.key(CTRL, false); },
  };
}

// 1. Hold past the threshold records, then finishes on release.
{
  const h = harness();
  h.comboDown();
  h.advance(2000);
  h.comboUp();
  check('hold -> start then finish', h.events, ['start', 'finish']);
}

// 2. A lone short tap starts, then ends when the double-tap window lapses.
{
  const h = harness();
  h.comboDown(); h.advance(80); h.comboUp();
  check('single tap -> start only, still recording', h.events, ['start']);
  h.advance(500);
  check('single tap -> finishes when window lapses', h.events, ['start', 'finish']);
}

// 3. Two quick taps lock recording on.
{
  const h = harness();
  h.comboDown(); h.advance(80); h.comboUp();
  h.advance(150);
  h.comboDown(); h.advance(80); h.comboUp();
  check('double tap -> locks on', h.events, ['start', 'lock']);
  h.advance(5000);
  check('locked -> keeps recording through the window', h.events, ['start', 'lock']);
  check('locked flag set', h.g.isLocked(), true);

  // 4. A tap while locked stops it.
  h.comboDown();
  check('tap while locked -> unlock + finish', h.events, ['start', 'lock', 'unlock', 'finish']);
}

// 4b. A slower double tap still locks. Under the old rule the window ran to
// the release of the second tap, so this gap plus the second press exceeded
// it and the recording silently ended instead — the "it just disappears" bug.
{
  const h = harness();
  h.comboDown(); h.advance(120); h.comboUp();
  h.advance(400);
  h.comboDown();
  check('slow double tap -> still locks', h.events, ['start', 'lock']);
  check('locks on the second press, before release', h.g.isLocked(), true);
  h.advance(120); h.comboUp();
  h.advance(3000);
  check('stays recording after the second release', h.events, ['start', 'lock']);
}

// 4c. Past the window it is two separate gestures, not a lock.
{
  const h = harness();
  h.comboDown(); h.advance(100); h.comboUp();
  h.advance(700);
  check('lone tap finishes once the window lapses', h.events, ['start', 'finish']);
  h.comboDown();
  check('a later tap starts a fresh recording', h.events, ['start', 'finish', 'start']);
  check('and does not lock', h.g.isLocked(), false);
}

// 5. Non-combo keys are ignored entirely (the privacy claim).
{
  const h = harness();
  for (let i = 0; i < 50; i++) { h.g.key(A, true); h.g.key(A, false); }
  check('typing other keys produces nothing', h.events, []);
}

// 6. Auto-repeat of a held modifier does not re-trigger.
{
  const h = harness();
  h.g.key(CTRL, true); h.g.key(CTRL, true); h.g.key(CTRL, true);
  h.g.key(WIN, true); h.g.key(WIN, true);
  check('auto-repeat -> single start', h.events, ['start']);
}

// 7. Partial combo alone never starts.
{
  const h = harness();
  h.g.key(CTRL, true); h.advance(1000); h.g.key(CTRL, false);
  check('ctrl alone -> nothing', h.events, []);
}

// 8. reset() clears a stuck state.
{
  const h = harness();
  h.comboDown();
  h.g.reset();
  check('reset clears recording', h.g.isRecording(), false);
  check('reset clears lock', h.g.isLocked(), false);
}

console.log(failures === 0 ? '\nall gesture tests passed' : `\n${failures} FAILING`);
process.exit(failures === 0 ? 0 : 1);

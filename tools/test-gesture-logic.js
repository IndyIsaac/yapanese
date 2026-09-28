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
    // Fires due timers in order, at their own time, including any a timer
    // sets while firing — which is how real timers behave.
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
  // A release only counts once it has outlasted the bounce window.
  h.advance(gestures.BOUNCE_MS);
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

// 9. A burst of key events faster than fingers can move is noise, not taps.
//    Replays the debug log: start, lock, finish all inside 13ms of one press,
//    which started a recording and killed it before any audio arrived.
{
  const h = harness();
  h.comboDown();
  h.advance(3); h.comboUp();
  h.advance(3); h.comboDown();
  h.advance(4); h.comboUp();
  h.advance(3); h.comboDown();
  check('bounce burst -> one start, no lock or finish', h.events, ['start']);
  h.advance(2000); h.comboUp(); h.advance(100);
  check('bounce burst then hold -> finishes on release', h.events, ['start', 'finish']);
}

// 10. A bounce during the locking press does not count as the stop tap.
//     Also from the log: locked on, then "tap while locked" 9ms later.
{
  const h = harness();
  h.comboDown(); h.advance(80); h.comboUp();
  h.advance(150); h.comboDown();
  h.advance(4); h.g.key(WIN, false); h.advance(3); h.g.key(WIN, true);
  h.advance(80); h.comboUp();
  h.advance(2000);
  check('bounce while locking -> still locked', h.events, ['start', 'lock']);
}

// 11. A fast human double tap still locks.
{
  const h = harness();
  h.comboDown(); h.advance(60); h.comboUp();
  h.advance(70); h.comboDown(); h.advance(60); h.comboUp();
  h.advance(3000);
  check('fast double tap -> lock', h.events, ['start', 'lock']);
}

// 12. Changing the combo just after a hold is released still finishes it.
{
  const h = harness();
  h.comboDown(); h.advance(2000); h.comboUp();
  h.advance(10); h.g.setCombo('ctrl+shift');
  h.advance(1000);
  check('combo change inside bounce window -> still finishes', h.events, ['start', 'finish']);
}

console.log(failures === 0 ? '\nall gesture tests passed' : `\n${failures} FAILING`);
process.exit(failures === 0 ? 0 : 1);

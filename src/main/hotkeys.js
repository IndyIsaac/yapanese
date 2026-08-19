'use strict';

const path = require('node:path');
const { utilityProcess } = require('electron');
const { DEFAULT_COMBO, comboName } = require('./combos');

/**
 * Parent-side handle for the keyboard hook, which runs in its own process
 * (see hook-process.js). The public shape is unchanged apart from `start`
 * now being async and `paste` being new — the hook process owns keystroke
 * synthesis as well as listening, so the paste has to be asked for rather
 * than done inline.
 */

const HOOK_SCRIPT = path.join(__dirname, 'hook-process.js');
const READY_TIMEOUT_MS = 5000;
// A hook that dies repeatedly is broken, not unlucky; stop rather than spin.
const MAX_RESPAWNS = 3;

function create({ onStart, onFinish, onLockChanged, log = () => {} }) {
  let child = null;
  let running = false;
  let stopping = false;
  let respawns = 0;
  let combo = DEFAULT_COMBO;
  let locked = false;
  let pasteWaiters = [];

  function handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'start': onStart(); break;
      case 'finish': onFinish(); break;
      case 'lock':
        locked = !!msg.locked;
        onLockChanged?.(locked);
        break;
      case 'paste:done': {
        const waiters = pasteWaiters;
        pasteWaiters = [];
        for (const w of waiters) w({ ok: !!msg.ok, error: msg.error });
        break;
      }
      case 'log': log(msg.line); break;
      default: break;
    }
  }

  function spawn() {
    child = utilityProcess.fork(HOOK_SCRIPT, [], { serviceName: 'yapanese-hook' });
    child.on('message', handle);
    child.on('exit', (code) => {
      child = null;
      if (stopping) return;
      // Anything still waiting on a paste will never hear back otherwise.
      const waiters = pasteWaiters;
      pasteWaiters = [];
      for (const w of waiters) w({ ok: false, error: 'the keyboard hook stopped' });

      if (!running) return;
      if (respawns >= MAX_RESPAWNS) {
        running = false;
        log('hotkey: hook process died too many times, giving up');
        return;
      }
      respawns++;
      log('hotkey: hook process exited', String(code), '— restarting', `(${respawns}/${MAX_RESPAWNS})`);
      spawn();
      post({ type: 'combo', combo });
    });
    return child;
  }

  function post(msg) {
    try { child?.postMessage(msg); } catch {}
  }

  return {
    /** Resolves once the hook is actually listening, or reports why not. */
    start(comboId) {
      combo = comboId || DEFAULT_COMBO;
      if (running) return Promise.resolve({ ok: true, name: comboName(combo) });

      return new Promise((resolve) => {
        let settled = false;
        const done = (res) => { if (!settled) { settled = true; resolve(res); } };

        const proc = spawn();
        const onReady = (msg) => {
          if (!msg || msg.type !== 'ready') return;
          proc.off?.('message', onReady);
          if (msg.error) {
            running = false;
            log('hotkey: FAILED to start hook —', msg.error);
            done({ ok: false, error: msg.error });
            return;
          }
          running = true;
          post({ type: 'combo', combo });
          log('hotkey: hook started for', comboName(combo), 'in its own process');
          done({ ok: true, name: comboName(combo) });
        };
        proc.on('message', onReady);

        setTimeout(() => done({ ok: false, error: 'the keyboard hook did not start in time' }), READY_TIMEOUT_MS);
      });
    },

    setCombo(comboId) {
      combo = comboId || DEFAULT_COMBO;
      locked = false;
      post({ type: 'combo', combo });
      log('hotkey: combo set to', comboName(combo));
      return comboName(combo);
    },

    /**
     * Send Ctrl+V from the hook process, which ignores its own synthetic
     * keys so the gesture machine is not disturbed by the paste.
     */
    paste() {
      if (!child || !running) return Promise.resolve({ ok: false, error: 'the keyboard hook is not running' });
      return new Promise((resolve) => {
        pasteWaiters.push(resolve);
        post({ type: 'paste' });
        setTimeout(() => {
          const i = pasteWaiters.indexOf(resolve);
          if (i !== -1) { pasteWaiters.splice(i, 1); resolve({ ok: false, error: 'the paste keystroke timed out' }); }
        }, 2000);
      });
    },

    reset() {
      locked = false;
      post({ type: 'reset' });
    },

    isLocked: () => locked,

    stop() {
      stopping = true;
      running = false;
      post({ type: 'stop' });
      try { child?.kill(); } catch {}
      child = null;
    },
  };
}

module.exports = { create };

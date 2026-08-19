'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Deliberately not in userData: this must work even if app paths misbehave,
// and it needs to be trivially findable while debugging.
const FILE = path.join(os.tmpdir(), 'yapanese-debug.log');

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

const DEBUG = process.env.YAPANESE_DEBUG === '1';

// Opt-in only. A GUI app inherits whatever console launched it, and writing
// there spams the user's terminal — which matters more than usual here,
// because people dictate *into* terminals with this.
const ECHO_TO_CONSOLE = DEBUG;

/**
 * Transcript text is the most sensitive thing this app handles, and this log
 * is a plain file in %TEMP% that "Clear history" does not touch. Record only
 * the shape of a transcript, never its content, unless debugging is
 * explicitly turned on for the session.
 */
function redact(text) {
  const s = String(text ?? '');
  return DEBUG ? JSON.stringify(s) : `<${[...s].length} chars>`;
}

function log(...parts) {
  const line = `${stamp()} ${parts
    .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ')}\n`;
  try { fs.appendFileSync(FILE, line); } catch {}
  if (ECHO_TO_CONSOLE) process.stdout.write(line);
}

function reset() {
  try { fs.writeFileSync(FILE, `--- yapanese session ${new Date().toISOString()} ---\n`); } catch {}
}

module.exports = { log, redact, reset, FILE };

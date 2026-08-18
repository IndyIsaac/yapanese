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

function log(...parts) {
  const line = `${stamp()} ${parts
    .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ')}\n`;
  try { fs.appendFileSync(FILE, line); } catch {}
  process.stdout.write(line);
}

function reset() {
  try { fs.writeFileSync(FILE, `--- yapanese session ${new Date().toISOString()} ---\n`); } catch {}
}

module.exports = { log, reset, FILE };

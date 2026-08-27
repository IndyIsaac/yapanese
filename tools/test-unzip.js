'use strict';

/**
 * Unpack a whisper.cpp release zip with the reader in src/main/unzip.js and
 * check the result against what the archive said it contained.
 *
 *   node tools/test-unzip.js <path-to-zip> [outDir]
 *
 * The point is the large-entry path: the CUDA release carries a 512 MB DLL,
 * which is where a reader that buffers instead of streaming stops working.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { extract } = require('../src/main/unzip');

const zip = process.argv[2];
const out = process.argv[3] || path.join(os.tmpdir(), 'yapanese-unzip-test');

if (!zip || !fs.existsSync(zip)) {
  console.error('usage: node tools/test-unzip.js <path-to-zip> [outDir]');
  process.exit(2);
}

(async () => {
  fs.rmSync(out, { recursive: true, force: true });
  const started = Date.now();

  const written = await extract({
    zipPath: zip,
    destDir: out,
    pick: (name) => {
      const base = path.basename(name);
      return base === 'whisper-cli.exe' || base.endsWith('.dll') ? base : null;
    },
    onFile: (name) => process.stdout.write(`  ${name}\n`),
  });

  const bytes = written.reduce((n, f) => n + fs.statSync(path.join(out, f)).size, 0);
  console.log(`\n${written.length} files, ${(bytes / 1048576).toFixed(1)} MB in ${Date.now() - started}ms`);
  console.log(`-> ${out}`);

  if (!written.includes('whisper-cli.exe')) {
    console.error('FAIL: whisper-cli.exe was not extracted');
    process.exit(1);
  }
  console.log('ok');
})().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});

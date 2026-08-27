'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');

/**
 * Verified HTTPS downloads.
 *
 * Everything Yapanese fetches is code or a file that whisper-cli parses on
 * the user's machine, so an unverified download is somebody else's code path
 * running here. Every fetch is pinned to an expected size and SHA-256, is
 * refused if it leaves the hosts its publisher actually uses, and lands at
 * its final path only after both checks pass.
 */

/** Hugging Face serves model blobs from its own CDN, so the redirect chain
 *  has to be allowed to leave huggingface.co — but only for hosts that still
 *  belong to them. */
const HUGGINGFACE = ['huggingface.co', '.huggingface.co', '.hf.co'];

/** GitHub redirects release assets to its object storage, which lives on a
 *  different domain to the API that hands out the link. */
const GITHUB = ['github.com', '.github.com', '.githubusercontent.com'];

function hostAllowed(hostname, allow) {
  const h = String(hostname).toLowerCase();
  return allow.some((entry) => (entry.startsWith('.') ? h.endsWith(entry) : h === entry));
}

/**
 * Fetch `url` to `dest`, verifying size and digest before it is put in place.
 *
 * The bytes go to a sibling `.partial` and are renamed only once both checks
 * pass, so an interrupted or corrupted download can never be mistaken for a
 * complete one on the next launch.
 *
 * `onProgress({ received, total })` is called as the body arrives. The
 * returned promise resolves to `{ ok, cached, error }` and never rejects —
 * callers decide what a failed component means, and none of them should have
 * to wrap this in a try.
 */
/** Hash a file that is already on disk, so a leftover from an interrupted
 *  install is either provably the right bytes or is thrown away. Matching on
 *  size alone would let anything of the correct length through, and the temp
 *  directory this reuses is not a place worth trusting. */
function digestOf(file) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', () => resolve(null));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function download({ url, dest, bytes, sha256, allow, onProgress, signal }) {
  if (fs.existsSync(dest) && fs.statSync(dest).size === bytes) {
    if (await digestOf(dest) === sha256) return { ok: true, cached: true };
    fs.rmSync(dest, { force: true });
  }

  return new Promise((resolve) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const partial = `${dest}.partial`;
    let settled = false;
    let request = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const fail = (error) => {
      fs.rm(partial, { force: true }, () => {});
      finish({ ok: false, error });
    };
    const onAbort = () => {
      request?.destroy();
      fail('cancelled');
    };
    if (signal?.aborted) return fail('cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });

    const get = (link, redirects = 0) => {
      let target;
      try { target = new URL(link); } catch { return fail('malformed download URL'); }
      if (target.protocol !== 'https:') return fail(`refusing non-HTTPS download (${target.protocol})`);
      if (!hostAllowed(target.hostname, allow)) return fail(`refusing redirect to ${target.hostname}`);

      request = https.get(target, { headers: { 'user-agent': 'yapanese' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
          res.resume();
          // Relative Location headers are legal, so resolve against the
          // current URL before the host is checked again.
          return get(new URL(res.headers.location, target).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return fail(`HTTP ${res.statusCode}`);
        }

        const hash = crypto.createHash('sha256');
        let received = 0;
        res.on('data', (chunk) => {
          hash.update(chunk);
          received += chunk.length;
          onProgress?.({ received, total: bytes });
        });

        const file = fs.createWriteStream(partial);
        res.pipe(file);
        res.on('error', (err) => fail(err.message));
        file.on('error', (err) => fail(err.message));
        file.on('finish', () => file.close(() => {
          if (settled) return;
          if (received !== bytes) {
            return fail(`unexpected size (${received} bytes, expected ${bytes})`);
          }
          if (hash.digest('hex') !== sha256) {
            return fail('the download failed its integrity check and was discarded');
          }
          try {
            fs.rmSync(dest, { force: true });
            fs.renameSync(partial, dest);
            finish({ ok: true, cached: false });
          } catch (err) { fail(err.message); }
        }));
      });
      request.on('error', (err) => fail(err.message));
    };

    get(url);
  });
}

module.exports = { download, HUGGINGFACE, GITHUB };

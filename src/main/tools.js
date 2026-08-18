'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/** Where the yap Windows build installs itself. */
const YAP_BIN = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'yap',
  'bin'
);

function run(exe, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, maxBuffer: 1 << 24, ...opts }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
        stdout: stdout || '',
        stderr: stderr || '',
        error: err || null,
      });
    });
  });
}

/** Resolve a tool: explicit override, then the yap bin dir, then PATH. */
async function locate(command, override) {
  if (override && fs.existsSync(override)) return override;

  const local = path.join(YAP_BIN, `${command}.exe`);
  if (fs.existsSync(local)) return local;

  const res = await run('where.exe', [command]);
  if (!res.ok) return null;
  const first = res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return first && fs.existsSync(first) ? first : null;
}

/**
 * List DirectShow audio inputs.
 *
 * ffmpeg prints device info on stderr and exits non-zero for the `dummy`
 * probe, so a failed exit code here is expected rather than an error.
 */
async function listMicrophones(ffmpegPath) {
  const ffmpeg = await locate('ffmpeg', ffmpegPath);
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg-missing', devices: [] };

  const res = await run(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
  const devices = [];
  for (const line of res.stderr.split(/\r?\n/)) {
    const m = line.match(/"([^"]+)"\s+\(audio\)/);
    if (m) devices.push(m[1]);
  }
  return { ok: true, devices };
}

module.exports = { run, locate, listMicrophones, YAP_BIN };

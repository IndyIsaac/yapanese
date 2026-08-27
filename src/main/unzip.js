'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/**
 * Just enough ZIP to unpack a whisper.cpp release.
 *
 * Node has no archive support and this is the only archive Yapanese will ever
 * open, so a reader beats a dependency: the whole surface is one local file,
 * written by one publisher, in one shape. Entries are read through the
 * central directory rather than by scanning for local headers, because a
 * local header is allowed to carry zeroed sizes and defer them to a trailing
 * data descriptor — the central directory is the only place the sizes are
 * always present.
 *
 * Each entry is inflated as a stream, so unpacking a 512 MB DLL costs a
 * buffer, not 512 MB of memory.
 */

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const STORED = 0;
const DEFLATED = 8;

// The comment at the end of an EOCD record is a 16-bit length, so the record
// can start at most that far from the end of the file.
const MAX_EOCD_SCAN = 22 + 0xffff;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf, seed = 0) {
  let c = ~seed;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function readExact(fd, length, position) {
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = fs.readSync(fd, buf, read, length - read, position + read);
    if (n === 0) throw new Error('unexpected end of archive');
    read += n;
  }
  return buf;
}

/** A u64 field that a real archive will never fill, but JSON-safe arithmetic
 *  would silently mangle if it did. */
function readU64(buf, offset) {
  const value = buf.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('archive is too large to read');
  return Number(value);
}

function findEndOfCentralDirectory(fd, fileSize) {
  const scan = Math.min(fileSize, MAX_EOCD_SCAN);
  const buf = readExact(fd, scan, fileSize - scan);
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) !== EOCD_SIG) continue;

    let entries = buf.readUInt16LE(i + 10);
    let offset = buf.readUInt32LE(i + 16);

    // Zip64 marks the 32-bit fields as saturated and puts the real values in
    // its own record, reachable through a locator sitting just before this one.
    if (entries === 0xffff || offset === 0xffffffff) {
      const locatorAt = i - 20;
      if (locatorAt < 0 || buf.readUInt32LE(locatorAt) !== EOCD64_LOCATOR_SIG) {
        throw new Error('archive claims zip64 but has no locator');
      }
      const record = readExact(fd, 56, readU64(buf, locatorAt + 8));
      if (record.readUInt32LE(0) !== EOCD64_SIG) throw new Error('malformed zip64 record');
      entries = readU64(record, 32);
      offset = readU64(record, 48);
    }
    return { entries, offset };
  }
  throw new Error('not a zip archive');
}

/** Pull the real sizes out of a zip64 extra field, in the fixed order the
 *  spec gives them, skipping any the 32-bit fields already carried. */
function applyZip64Extra(extra, entry) {
  for (let at = 0; at + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(at);
    const size = extra.readUInt16LE(at + 2);
    const body = extra.subarray(at + 4, at + 4 + size);
    if (id === 0x0001) {
      let at64 = 0;
      const next = () => { const v = readU64(body, at64); at64 += 8; return v; };
      if (entry.uncompressedSize === 0xffffffff && at64 + 8 <= body.length) entry.uncompressedSize = next();
      if (entry.compressedSize === 0xffffffff && at64 + 8 <= body.length) entry.compressedSize = next();
      if (entry.localOffset === 0xffffffff && at64 + 8 <= body.length) entry.localOffset = next();
      return;
    }
    at += 4 + size;
  }
}

function readCentralDirectory(fd, { entries, offset }) {
  const list = [];
  let at = offset;
  for (let i = 0; i < entries; i++) {
    const head = readExact(fd, 46, at);
    if (head.readUInt32LE(0) !== CENTRAL_SIG) throw new Error('malformed central directory');

    const nameLength = head.readUInt16LE(28);
    const extraLength = head.readUInt16LE(30);
    const commentLength = head.readUInt16LE(32);
    const name = readExact(fd, nameLength, at + 46).toString('utf8');

    const entry = {
      name,
      method: head.readUInt16LE(10),
      crc: head.readUInt32LE(16),
      compressedSize: head.readUInt32LE(20),
      uncompressedSize: head.readUInt32LE(24),
      localOffset: head.readUInt32LE(42),
    };
    if (extraLength) {
      applyZip64Extra(readExact(fd, extraLength, at + 46 + nameLength), entry);
    }

    list.push(entry);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return list;
}

/** The local header repeats the name and carries its own extra field, whose
 *  length routinely differs from the central one. The payload starts after
 *  whatever this copy says, not after what the directory said. */
function dataOffset(fd, entry) {
  const head = readExact(fd, 30, entry.localOffset);
  if (head.readUInt32LE(0) !== LOCAL_SIG) throw new Error(`malformed entry: ${entry.name}`);
  return entry.localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
}

function inflateEntry(zipPath, fd, entry, dest) {
  return new Promise((resolve, reject) => {
    const start = dataOffset(fd, entry);
    if (entry.method !== STORED && entry.method !== DEFLATED) {
      return reject(new Error(`${entry.name} uses an unsupported compression method`));
    }

    const partial = `${dest}.partial`;
    const source = fs.createReadStream(zipPath, {
      start,
      end: start + entry.compressedSize - 1,
      autoClose: true,
    });
    const sink = fs.createWriteStream(partial);

    let crc = 0;
    let written = 0;
    const body = entry.method === DEFLATED ? zlib.createInflateRaw() : source;
    if (entry.method === DEFLATED) source.pipe(body);

    body.on('data', (chunk) => { crc = crc32(chunk, crc); written += chunk.length; });
    body.pipe(sink);

    const abort = (err) => {
      source.destroy();
      sink.destroy();
      fs.rm(partial, { force: true }, () => reject(err));
    };
    source.on('error', abort);
    body.on('error', abort);
    sink.on('error', abort);

    sink.on('finish', () => {
      if (written !== entry.uncompressedSize) {
        return abort(new Error(`${entry.name} unpacked to the wrong size`));
      }
      // The archive's own per-file checksum. The whole download is already
      // pinned to a SHA-256, so this catches a bad disk rather than a bad
      // publisher — but it is free and the failure it finds is silent.
      if (crc !== entry.crc) {
        return abort(new Error(`${entry.name} failed its checksum`));
      }
      try {
        fs.rmSync(dest, { force: true });
        fs.renameSync(partial, dest);
        resolve();
      } catch (err) { abort(err); }
    });
  });
}

/**
 * Unpack selected entries into `destDir`, flat.
 *
 * `pick(name)` returns the basename to write, or null to skip the entry —
 * which is what keeps a 640 MB release from landing two dozen executables
 * nobody asked for. Returns the list of files written.
 */
async function extract({ zipPath, destDir, pick, onFile }) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const entries = readCentralDirectory(fd, findEndOfCentralDirectory(fd, fs.fstatSync(fd).size));
    fs.mkdirSync(destDir, { recursive: true });

    const written = [];
    for (const entry of entries) {
      if (entry.name.endsWith('/')) continue;
      const wanted = pick(entry.name);
      if (!wanted) continue;

      // Whatever pick returns is reduced to a bare filename: an archive does
      // not get to choose where on this machine its contents land.
      const target = path.join(destDir, path.basename(wanted));
      await inflateEntry(zipPath, fd, entry, target);
      written.push(path.basename(target));
      onFile?.(path.basename(target));
    }
    return written;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { extract, crc32 };

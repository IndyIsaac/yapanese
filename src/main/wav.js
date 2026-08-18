'use strict';

/** Minimal 16-bit PCM WAV container around raw mono samples. */
function encodeWav(int16, sampleRate) {
  // Buffer.from(typedArray) copies *values*, truncating every 16-bit sample
  // to 8 bits. The underlying bytes have to be viewed directly instead.
  const pcm = Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);

  const header = Buffer.alloc(44);
  const dataBytes = pcm.byteLength;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);             // PCM chunk size
  header.writeUInt16LE(1, 20);              // format = PCM
  header.writeUInt16LE(1, 22);              // channels = mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);              // block align
  header.writeUInt16LE(16, 34);             // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);

  return Buffer.concat([header, pcm]);
}

module.exports = { encodeWav };

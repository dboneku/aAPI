const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { tryAll } = require('./compression');
const { extToTag, tagToExt } = require('./fileTypes');
const { chunkBuffer } = require('./chunker');
const { renderAztecPNG } = require('./aztec');
const { crc16 } = require('./crc16');

async function encode(buffer, filename) {
  const ext = path.extname(filename || '').replace(/^\./, '').toLowerCase();
  const origTag = extToTag[ext] || 0xFF;
  const best = tryAll(buffer);
  const compId = best.id;
  const { chunks, warn } = chunkBuffer(best.data, origTag, origTag, compId);
  const symbols = [];
  for (let i = 0; i < chunks.length; i++) {
    const png = await renderAztecPNG(chunks[i]);
    symbols.push({ index: i, png });
  }
  return { symbols, meta: { total: chunks.length, compId, warn, compressionRatio: ((1 - best.data.length / buffer.length) * 100).toFixed(1) + '%' } };
}

// Decode expects array of Buffers (raw chunk payloads including 7-byte header)
// Returns { data: Buffer, ext: string, compId: number, total: number }
function decode(chunks) {
  if (!chunks || chunks.length === 0) throw new Error('No chunks provided');

  // Sort by index (byte 4) and validate headers
  const ordered = chunks.slice().sort((a, b) => a.readUInt8(4) - b.readUInt8(4));

  const origTag = ordered[0].readUInt8(0);
  const compId = ordered[0].readUInt8(2);
  const total = ordered[0].readUInt8(3);

  // Verify consistency and validate CRC16
  for (let i = 0; i < ordered.length; i++) {
    const chunk = ordered[i];
    if (chunk.length < 7) throw new Error(`Chunk ${i} too short (${chunk.length} bytes)`);

    // Verify header consistency
    if (chunk.readUInt8(2) !== compId) throw new Error(`Chunk ${i} codec mismatch: expected ${compId}, got ${chunk.readUInt8(2)}`);
    if (chunk.readUInt8(3) !== total) throw new Error(`Chunk ${i} total count mismatch: expected ${total}, got ${chunk.readUInt8(3)}`);
    if (chunk.readUInt8(4) !== i) throw new Error(`Chunk index mismatch: expected ${i}, got ${chunk.readUInt8(4)}`);

    // Validate CRC16
    const payload = chunk.slice(7);
    const storedCrc = chunk.readUInt16BE(5);
    const computedCrc = crc16(payload);
    if (storedCrc !== computedCrc) {
      throw new Error(`Chunk ${i} CRC16 mismatch: stored ${storedCrc.toString(16)}, computed ${computedCrc.toString(16)}`);
    }
  }

  // Concatenate all payloads
  const payloads = ordered.map(c => c.slice(7));
  const compressed = Buffer.concat(payloads);

  // Decompress based on compId
  let data;
  if (compId === 0x00) {
    // RAW — no decompression
    data = compressed;
  } else if (compId === 0x01) {
    // ZLIB
    data = zlib.inflateSync(compressed);
  } else if (compId === 0x02) {
    // BROTLI
    data = zlib.brotliDecompressSync(compressed);
  } else {
    throw new Error(`Unknown codec ID: 0x${compId.toString(16)}`);
  }

  const ext = tagToExt(origTag);
  return { data, ext, compId, total };
}

module.exports = { encode, decode };

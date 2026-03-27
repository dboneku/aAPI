const fs = require('fs');
const path = require('path');
const { tryAll } = require('./compression');
const { extToTag } = require('./fileTypes');
const { chunkBuffer } = require('./chunker');
const { renderAztecPNG } = require('./aztec');

async function encode(buffer, filename) {
  const ext = path.extname(filename || '').replace(/^\./, '').toLowerCase();
  const origTag = extToTag[ext] || 0xFF;
  const best = tryAll(buffer);
  const compId = best.id;
  const chunks = chunkBuffer(best.data, origTag, origTag, compId);
  const symbols = [];
  for (let i = 0; i < chunks.length; i++) {
    const png = await renderAztecPNG(chunks[i]);
    symbols.push({ index: i, png });
  }
  return { symbols, meta: { total: chunks.length, compId } };
}

// Simple decode that expects array of Buffers (raw chunk payloads including header)
function decode(chunks) {
  // verify headers, order by index
  const ordered = chunks.slice().sort((a,b)=>a.readUInt8(4)-b.readUInt8(4));
  const payloads = ordered.map(c => c.slice(7));
  return Buffer.concat(payloads);
}

module.exports = { encode, decode };

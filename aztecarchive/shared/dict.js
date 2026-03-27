const zlib = require('zlib');

/**
 * Tokenize text for dictionary encoding.
 *
 * Strategy: split on whitespace boundaries, capturing whitespace runs as tokens
 * so that exact round-trip reconstruction is possible via ''.join().
 * Punctuation stays attached to adjacent words (e.g. "beginning," is one token),
 * matching the spec's intent. Whitespace sequences (" ", "\n", "\r\n", etc.) each
 * become their own token and are included in the vocabulary.
 *
 * Example: "Hello, world!\n" → ["Hello,", " ", "world!", "\n"]
 */
function tokenize(text) {
  return text.split(/(\s+)/).filter(t => t.length > 0);
}

/**
 * encodeDict(buffer) → Buffer
 *
 * Layout (matches spec):
 *   [2-byte LE uint16  : vocabulary entry count N]
 *   [N entries         : each a null-terminated UTF-8 string]
 *   [remaining bytes   : zlib-deflated Uint16LE token indices]
 *
 * The 2-byte count + null-terminated format means the decoder can read exactly
 * N null-terminated strings to rebuild the vocab, then treat the rest as the
 * zlib stream — no length prefix needed beyond the null terminator per entry.
 */
function encodeDict(buffer) {
  const text = buffer.toString('utf8');
  const tokens = tokenize(text);

  // Build sorted vocab for determinism
  const vocabSet = new Set(tokens);
  const vocab = Array.from(vocabSet).sort();
  if (vocab.length > 65535) throw new Error(`Too many unique tokens: ${vocab.length} (max 65535)`);

  const wordIndex = new Map();
  vocab.forEach((w, i) => wordIndex.set(w, i));

  // Pack token sequence as Uint16LE indices
  const indexBuf = Buffer.allocUnsafe(tokens.length * 2);
  for (let i = 0; i < tokens.length; i++) {
    indexBuf.writeUInt16LE(wordIndex.get(tokens[i]), i * 2);
  }

  // Deflate the index buffer at max compression
  const compressed = zlib.deflateSync(indexBuf, { level: 9 });

  // Serialize dictionary: [2-byte uint16 count][null-terminated string × N]
  const countBuf = Buffer.allocUnsafe(2);
  countBuf.writeUInt16LE(vocab.length, 0);

  const entryBufs = vocab.map(w => {
    const wBuf = Buffer.from(w, 'utf8');
    return Buffer.concat([wBuf, Buffer.alloc(1)]); // null terminator
  });

  return Buffer.concat([countBuf, ...entryBufs, compressed]);
}

/**
 * decodeDict(buffer) → Buffer (UTF-8 text)
 *
 * Inverse of encodeDict. Reads the 2-byte count, then that many null-terminated
 * strings, then inflates the remaining bytes as the Uint16LE index stream.
 */
function decodeDict(buffer) {
  let offset = 0;

  // Read vocabulary count
  const count = buffer.readUInt16LE(offset);
  offset += 2;

  // Read null-terminated vocabulary entries
  const vocab = [];
  for (let i = 0; i < count; i++) {
    let end = offset;
    while (end < buffer.length && buffer[end] !== 0) end++;
    vocab.push(buffer.slice(offset, end).toString('utf8'));
    offset = end + 1; // advance past null terminator
  }

  // Remaining bytes are the deflated Uint16LE index stream
  const compressedIndices = buffer.slice(offset);
  const indexBuf = zlib.inflateSync(compressedIndices);

  // Reconstruct original text from token indices
  const tokenCount = indexBuf.length / 2;
  const parts = [];
  for (let i = 0; i < tokenCount; i++) {
    const idx = indexBuf.readUInt16LE(i * 2);
    parts.push(vocab[idx]);
  }

  // Join with empty string — whitespace tokens are in the vocab so reconstruction is exact.
  return Buffer.from(parts.join(''), 'utf8');
}

module.exports = { encodeDict, decodeDict };


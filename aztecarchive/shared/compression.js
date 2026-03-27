const zlib = require('zlib');
const { encodeDict } = require('./dict');
const { minifySVG } = require('./svgMinifier');

// Extensions that are already compressed — skip compression, use RAW codec.
const PRE_COMPRESSED_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'pdf', 'zip', 'docx', 'xlsx', 'pptx', 'gz', 'bz2', 'xz', 'mp4', 'mp3', 'mov']);

// SVG files use the VECTOR codec (minify + deflate).
const SVG_EXTS = new Set(['svg']);

// Plain-text extensions that benefit from dictionary encoding.
const TEXT_EXTS = new Set(['txt', 'md', 'csv', 'json', 'xml', 'html', 'htm', 'yaml', 'yml', 'log']);

function compressZlib(buf) {
  return zlib.deflateSync(buf, { level: 9 });
}

// Heuristic: a buffer with no control characters (except common whitespace) is likely text.
function isLikelyText(buf) {
  const sample = buf.slice(0, 512);
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b < 0x09 || (b > 0x0D && b < 0x20)) return false;
  }
  return true;
}

/**
 * Choose the best codec for the given buffer and file extension.
 *
 * Codec IDs:
 *   0x00 RAW       – no compression (pre-compressed formats)
 *   0x01 ZLIB      – deflate (binary / arbitrary data)
 *   0x02 DICT_ZLIB – dictionary + deflate (plain text)
 *
 * @param {Buffer} buffer
 * @param {string} [ext]  lowercase extension without leading dot
 * @returns {{ id: number, data: Buffer }}
 */
function tryAll(buffer, ext) {
  const lext = (ext || '').toLowerCase();

  // Pre-compressed formats: no further compression is useful.
  if (PRE_COMPRESSED_EXTS.has(lext)) {
    return { id: 0x00, data: Buffer.from(buffer) };
  }

  // SVG → VECTOR codec: minify then deflate.
  if (SVG_EXTS.has(lext)) {
    const minified = minifySVG(buffer.toString('utf8'));
    const compressed = zlib.deflateSync(Buffer.from(minified, 'utf8'), { level: 9 });
    return { id: 0x03, data: compressed };
  }

  const isText = TEXT_EXTS.has(lext) || isLikelyText(buffer);

  if (isText) {
    // Text files always use DICT_ZLIB for semantic correctness — the codec ID
    // in the header must match what the decoder will invoke. DICT_ZLIB also
    // provides better compression than plain ZLIB for real-world repetitive text.
    try {
      return { id: 0x02, data: encodeDict(buffer) };
    } catch (e) {
      // Fallback to ZLIB if dict encoding fails for some reason.
    }
  }

  // Binary / fallback: race ZLIB vs RAW, pick smaller.
  const zipped = (() => { try { return compressZlib(buffer); } catch (e) { return null; } })();
  if (zipped && zipped.length < buffer.length) {
    return { id: 0x01, data: zipped };
  }
  return { id: 0x00, data: Buffer.from(buffer) };
}

module.exports = { tryAll, isLikelyText };

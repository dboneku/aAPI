const zlib = require('zlib');
const brotli = require('zlib');

function compressZlib(buf) {
  return zlib.deflateSync(buf, { level: 9 });
}

function compressBrotli(buf) {
  return brotli.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
}

// Very small text detector
function isLikelyText(buf) {
  const sample = buf.slice(0, 512).toString('utf8');
  return /[\x00-\x08\x0E-\x1F]/.test(sample) === false;
}

function tryAll(buffer, mimeType) {
  const results = [];
  // raw (no compression)
  results.push({ id: 0x00, data: Buffer.from(buffer) });
  // zlib
  try { results.push({ id: 0x01, data: compressZlib(buffer) }); } catch(e){}
  // brotli
  try { results.push({ id: 0x02, data: compressBrotli(buffer) }); } catch(e){}

  // choose smallest
  results.sort((a,b) => a.data.length - b.data.length);
  return results[0];
}

module.exports = { tryAll };

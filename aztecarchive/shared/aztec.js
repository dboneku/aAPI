let BWIPJS;
try {
  BWIPJS = require('bwip-js');
} catch (e) {
  // fallback to encoder/node_modules if invoked from encoder server
  try {
    BWIPJS = require(require('path').join(__dirname, '..', 'encoder', 'node_modules', 'bwip-js'));
  } catch (err) {
    throw e;
  }
}

async function renderAztecPNG(dataBuffer, options = {}) {
  // Encode the binary payload as base64 so the barcode contains pure ASCII text.
  // This ensures ZXing's getText() in the browser returns the content verbatim
  // (binarytext mode is unreliable in ZXing JS -- getRawBytes() returns null).
  // Aztec text-mode capacity at 25% EC (3067 chars) comfortably fits the
  // base64 expansion of our max chunk size (1914 bytes → 2552 base64 chars).
  const text = dataBuffer.toString('base64');
  const png = await BWIPJS.toBuffer({
    bcid: 'azteccode',
    text,
    scale: options.scale || 4,
    includetext: false,
    padding: 0
  });
  return png;
}

module.exports = { renderAztecPNG };

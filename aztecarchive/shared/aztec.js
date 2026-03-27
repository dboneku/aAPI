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
  // dataBuffer is binary payload for one symbol
  // bwip-js expects a string or Buffer for the 'text' parameter; use binary-to-ISO8859-1
  const text = dataBuffer.toString('latin1');
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

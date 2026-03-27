'use strict';

/**
 * encoder/optimizer.js
 *
 * Automatic encoding strategy selection pipeline.
 * Analyzes the input file and selects the best codec + optional pre-processing
 * (text extraction, vector tracing, etc.) to minimize the number of Aztec symbols.
 *
 * Returns for both /preview and /encode:
 *   {
 *     buffer:      Buffer,   the (possibly transformed) buffer to encode
 *     filename:    string,   possibly updated filename (e.g. doc.docx → doc.txt)
 *     encoded:     { id: number, data: Buffer },  pre-compressed result
 *     strategies:  Array<{ name, compressedSize, symbols, selected }>,
 *     label:       string,   human-readable description
 *     isDiagramHint: boolean  true when PNG/JPEG looks like a diagram
 *   }
 */

const path = require('path');
const zlib = require('zlib');
const { minifySVG } = require('../shared/svgMinifier');
const { encodeDict } = require('../shared/dict');

// Max payload per Aztec symbol after the 7-byte header (matches chunker.js)
const MAX_PAYLOAD = 1907;

function symbolCount(compressedSize) {
  return Math.max(1, Math.ceil(compressedSize / MAX_PAYLOAD));
}

// Safe require — returns null if module is not installed
function tryRequire(name) {
  try { return require(name); } catch (e) { return null; }
}

// ── Codec helpers ─────────────────────────────────────────────────────────────

function encodeRaw(buffer) {
  return { id: 0x00, data: Buffer.from(buffer) };
}

function encodeZlib(buffer) {
  return { id: 0x01, data: zlib.deflateSync(buffer, { level: 9 }) };
}

function encodeDictZlib(buffer) {
  return { id: 0x02, data: encodeDict(buffer) };
}

function encodeVector(buffer) {
  const svgStr = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : buffer;
  const minified = minifySVG(svgStr);
  const compressed = zlib.deflateSync(Buffer.from(minified, 'utf8'), { level: 9 });
  return { id: 0x03, data: compressed };
}

/**
 * forceEncode — apply a specific codec regardless of auto-detection.
 * Always operates on the raw input buffer without any transformation.
 */
function forceEncode(buffer, compId) {
  switch (compId) {
    case 0x00: return encodeRaw(buffer);
    case 0x01: return encodeZlib(buffer);
    case 0x02: return encodeDictZlib(buffer);
    case 0x03: return encodeVector(buffer);
    default: return encodeZlib(buffer);
  }
}

// ── Image analysis ────────────────────────────────────────────────────────────

/**
 * Analyze image palette via sharp.
 * Returns { lowColor: bool, uniqueColors: number|null }
 * lowColor = true when the image has few unique colors and flat regions (diagram-like).
 */
async function analyzePalette(buffer) {
  const sharp = tryRequire('sharp');
  if (!sharp) return { lowColor: false, uniqueColors: null };
  try {
    const { data, info } = await sharp(buffer)
      .resize(150, 150, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = new Map();
    const ch = info.channels || 3;
    for (let i = 0; i < data.length; i += ch) {
      // Quantize to 32-step buckets to reduce noise
      const r = Math.round(data[i] / 32) * 32;
      const g = Math.round(data[i + 1] / 32) * 32;
      const b = Math.round(data[i + 2] / 32) * 32;
      const key = (r << 16) | (g << 8) | b;
      pixels.set(key, (pixels.get(key) || 0) + 1);
      if (pixels.size > 128) break; // early exit for complex photos
    }

    const totalPixels = info.width * info.height;
    const sortedCounts = [...pixels.values()].sort((a, b) => b - a);
    const topCoverage = sortedCounts.slice(0, 8).reduce((s, v) => s + v, 0) / totalPixels;

    return {
      uniqueColors: pixels.size,
      lowColor: pixels.size <= 32 && topCoverage >= 0.65
    };
  } catch (e) {
    return { lowColor: false, uniqueColors: null };
  }
}

/**
 * Run OCR via tesseract.js (v5 API).
 * Returns extracted text string, or null on failure/no text.
 */
async function runOCR(buffer) {
  const tesseract = tryRequire('tesseract.js');
  if (!tesseract) return null;
  try {
    const worker = await tesseract.createWorker('eng');
    const { data: { text } } = await worker.recognize(buffer);
    await worker.terminate();
    const cleaned = text.trim();
    return cleaned.length > 20 ? cleaned : null; // ignore near-empty extractions
  } catch (e) {
    return null;
  }
}

/**
 * Attempt raster-to-vector trace via potrace.
 * Returns SVG string, or null on failure.
 */
async function attemptTrace(buffer) {
  const potrace = tryRequire('potrace');
  if (!potrace) return null;
  return new Promise((resolve) => {
    try {
      potrace.trace(buffer, { threshold: 128 }, (err, svg) => {
        resolve(err || !svg ? null : svg);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

/**
 * Extract plain text from a DOCX buffer via mammoth.
 * Returns text string, or null on failure.
 */
async function extractDocxText(buffer) {
  const mammoth = tryRequire('mammoth');
  if (!mammoth) return null;
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value.trim() || null;
  } catch (e) {
    return null;
  }
}

/**
 * Extract plain text from a PDF buffer via pdf-parse.
 * Returns text string, or null on failure.
 */
async function extractPdfText(buffer) {
  const pdfParse = tryRequire('pdf-parse');
  if (!pdfParse) return null;
  try {
    const result = await pdfParse(buffer);
    return result.text.trim() || null;
  } catch (e) {
    return null;
  }
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

/**
 * analyze(buffer, filename, mimeType) → strategy result
 *
 * Runs the automatic optimization pipeline and returns the best encoding
 * strategy along with all tried strategies for UI display.
 */
async function analyze(buffer, filename, mimeType) {
  const ext = path.extname(filename || '').replace(/^\./, '').toLowerCase();
  const mime = (mimeType || '').toLowerCase();

  let strategies = [];
  let best = null;
  let resultBuffer = buffer;
  let resultFilename = filename;
  let label = '';
  let isDiagramHint = false;

  // ── SVG ─────────────────────────────────────────────────────────────────────
  if (ext === 'svg' || mime === 'image/svg+xml') {
    const enc = encodeVector(buffer);
    strategies.push({ name: 'VECTOR', compressedSize: enc.data.length, symbols: symbolCount(enc.data.length), selected: true });
    best = enc;
    label = 'SVG vector file — using VECTOR codec (minify + deflate)';
    return { buffer, filename, encoded: best, strategies, label, isDiagramHint };
  }

  // ── DOCX ─────────────────────────────────────────────────────────────────────
  if (ext === 'docx' || mime.includes('wordprocessingml')) {
    const zlibEnc = (() => { try { return encodeZlib(buffer); } catch (e) { return encodeRaw(buffer); } })();
    strategies.push({ name: 'ZLIB (original binary)', compressedSize: zlibEnc.data.length, symbols: symbolCount(zlibEnc.data.length), selected: false });

    const text = await extractDocxText(buffer);
    if (text) {
      const textBuf = Buffer.from(text, 'utf8');
      const dictEnc = encodeDictZlib(textBuf);
      strategies.push({ name: 'DICT_ZLIB (extracted text)', compressedSize: dictEnc.data.length, symbols: symbolCount(dictEnc.data.length), selected: false });

      if (dictEnc.data.length < zlibEnc.data.length) {
        strategies[1].selected = true;
        best = dictEnc;
        resultBuffer = textBuf;
        resultFilename = filename.replace(/\.docx$/i, '.txt');
        label = `DOCX: extracted text is ${((1 - dictEnc.data.length / zlibEnc.data.length) * 100).toFixed(0)}% smaller than binary — using DICT_ZLIB`;
      } else {
        strategies[0].selected = true;
        best = zlibEnc;
        label = 'DOCX: original binary is smaller — using ZLIB';
      }
    } else {
      strategies[0].selected = true;
      best = zlibEnc;
      label = 'DOCX: could not extract text — using ZLIB on original';
    }
    return { buffer: resultBuffer, filename: resultFilename, encoded: best, strategies, label, isDiagramHint };
  }

  // ── PDF ──────────────────────────────────────────────────────────────────────
  if (ext === 'pdf' || mime === 'application/pdf') {
    const rawEnc = encodeRaw(buffer); // PDFs are pre-compressed
    strategies.push({ name: 'RAW (original binary)', compressedSize: rawEnc.data.length, symbols: symbolCount(rawEnc.data.length), selected: false });

    const text = await extractPdfText(buffer);
    if (text) {
      const textBuf = Buffer.from(text, 'utf8');
      const dictEnc = encodeDictZlib(textBuf);
      strategies.push({ name: 'DICT_ZLIB (extracted text)', compressedSize: dictEnc.data.length, symbols: symbolCount(dictEnc.data.length), selected: false });

      // Only switch to text if it's significantly smaller (50%+ reduction)
      if (dictEnc.data.length < rawEnc.data.length * 0.5) {
        strategies[1].selected = true;
        best = dictEnc;
        resultBuffer = textBuf;
        resultFilename = filename.replace(/\.pdf$/i, '.txt');
        label = `PDF: extracted text is ${((1 - dictEnc.data.length / rawEnc.data.length) * 100).toFixed(0)}% smaller — using DICT_ZLIB`;
      } else {
        strategies[0].selected = true;
        best = rawEnc;
        label = 'PDF: using RAW (already compressed)';
      }
    } else {
      strategies[0].selected = true;
      best = rawEnc;
      label = 'PDF: using RAW (already compressed)';
    }
    return { buffer: resultBuffer, filename: resultFilename, encoded: best, strategies, label, isDiagramHint };
  }

  // ── PNG / JPEG ────────────────────────────────────────────────────────────────
  if (['png', 'jpg', 'jpeg'].includes(ext) || mime.startsWith('image/')) {
    // Run all three analysis paths concurrently per spec
    const [palette, ocrText, tracedSvg] = await Promise.all([
      analyzePalette(buffer).catch(() => ({ lowColor: false, uniqueColors: null })),
      runOCR(buffer).catch(() => null),
      attemptTrace(buffer).catch(() => null)
    ]);

    const rawEnc = encodeRaw(buffer);
    strategies.push({ name: 'RAW (original image)', compressedSize: rawEnc.data.length, symbols: symbolCount(rawEnc.data.length), selected: false });
    best = rawEnc; // default

    // Vector trace — only consider if palette says it looks like a diagram
    let traceEnc = null;
    if (palette.lowColor && tracedSvg) {
      try {
        traceEnc = encodeVector(Buffer.from(tracedSvg, 'utf8'));
        strategies.push({ name: 'VECTOR (potrace trace)', compressedSize: traceEnc.data.length, symbols: symbolCount(traceEnc.data.length), selected: false });
        if (traceEnc.data.length < rawEnc.data.length) {
          strategies[strategies.length - 1].selected = true;
          strategies[0].selected = false;
          best = traceEnc;
          resultBuffer = Buffer.from(tracedSvg, 'utf8');
          resultFilename = filename.replace(/\.(png|jpe?g)$/i, '.svg');
          label = 'Image: vector trace is smaller — using VECTOR codec';
        }
      } catch (e) { /* trace encoding failed */ }
    }

    // OCR text — only consider if significantly smaller than best so far
    if (ocrText) {
      const textBuf = Buffer.from(ocrText, 'utf8');
      const ocrEnc = encodeDictZlib(textBuf);
      strategies.push({ name: 'DICT_ZLIB (OCR text)', compressedSize: ocrEnc.data.length, symbols: symbolCount(ocrEnc.data.length), selected: false });
      if (ocrEnc.data.length < best.data.length * 0.5) {
        // Mark previous selection as unselected
        strategies.forEach(s => s.selected = false);
        strategies[strategies.length - 1].selected = true;
        best = ocrEnc;
        resultBuffer = textBuf;
        resultFilename = filename.replace(/\.(png|jpe?g)$/i, '.txt');
        label = `Image: OCR text is ${((1 - ocrEnc.data.length / rawEnc.data.length) * 100).toFixed(0)}% smaller — using DICT_ZLIB`;
      }
    }

    // Mark RAW as selected if nothing better was found
    if (!strategies.some(s => s.selected)) {
      strategies[0].selected = true;
      label = 'Image: using RAW (original image)';
    }

    // Diagram hint: low color count but trace unavailable (user may have SVG source)
    isDiagramHint = palette.lowColor && !tracedSvg;

    return { buffer: resultBuffer, filename: resultFilename, encoded: best, strategies, label, isDiagramHint };
  }

  // ── Plain text / structured ───────────────────────────────────────────────────
  const TEXT_EXTS = new Set(['txt', 'md', 'csv', 'json', 'xml', 'html', 'htm', 'yaml', 'yml', 'log']);
  if (TEXT_EXTS.has(ext)) {
    const enc = encodeDictZlib(buffer);
    strategies.push({ name: 'DICT_ZLIB', compressedSize: enc.data.length, symbols: symbolCount(enc.data.length), selected: true });
    best = enc;
    label = `Plain text file (.${ext || 'txt'}) — using DICT_ZLIB (dictionary + deflate)`;
    return { buffer, filename, encoded: best, strategies, label, isDiagramHint };
  }

  // ── Binary fallback ───────────────────────────────────────────────────────────
  const zlibEnc = (() => { try { return encodeZlib(buffer); } catch (e) { return encodeRaw(buffer); } })();
  const rawEnc = encodeRaw(buffer);
  strategies.push({ name: 'RAW', compressedSize: rawEnc.data.length, symbols: symbolCount(rawEnc.data.length), selected: false });
  strategies.push({ name: 'ZLIB', compressedSize: zlibEnc.data.length, symbols: symbolCount(zlibEnc.data.length), selected: false });

  if (zlibEnc.data.length < rawEnc.data.length) {
    strategies[1].selected = true;
    best = zlibEnc;
    label = `Binary file (.${ext || 'bin'}) — using ZLIB`;
  } else {
    strategies[0].selected = true;
    best = rawEnc;
    label = `Binary file (.${ext || 'bin'}) — using RAW (already compressed)`;
  }
  return { buffer, filename, encoded: best, strategies, label, isDiagramHint };
}

module.exports = { analyze, forceEncode };

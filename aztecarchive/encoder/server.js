const express = require('express');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { encode, decode } = require('../shared');

const upload = multer({ storage: multer.memoryStorage() });
const app = express();
app.use(express.static('public'));
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/scan', (req, res) => res.sendFile(path.join(__dirname, 'public', 'scanner.html')));

app.post('/preview', upload.single('file'), async (req, res) => {
  console.log('Preview request received');
  if (!req.file) {
    console.log('No file in request');
    return res.status(400).json({ error: 'No file uploaded' });
  }
  console.log('File detected:', req.file.originalname, 'Size:', req.file.size);
  try {
    const buf = req.file.buffer;
    const result = await encode(buf, req.file.originalname);
    // return base64 encoded symbols
    const symbols = result.symbols.map(s => ({
      index: s.index,
      data: s.png.toString('base64')
    }));
    res.json({ symbolCount: result.meta.total, meta: result.meta, symbols });
  } catch (e) {
    console.error('Error in preview:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/encode', upload.single('file'), async (req, res) => {
  console.log('Encode request received');
  if (!req.file) {
    console.log('No file in request');
    return res.status(400).json({ error: 'No file uploaded' });
  }
  console.log('File detected:', req.file.originalname, 'Size:', req.file.size);
  try {
    const buf = req.file.buffer;
    const result = await encode(buf, req.file.originalname);
    const doc = new PDFDocument({ autoFirstPage: false });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="aztec_output.pdf"');
    doc.pipe(res);

    const cols = Math.ceil(Math.sqrt(result.meta.total));
    const rows = Math.ceil(result.meta.total / cols);
    const pageWidth = 595.28; // A4
    const pageHeight = 841.89;
    const margin = 40;
    const cellW = (pageWidth - margin*2) / cols;
    const cellH = (pageHeight - margin*2) / rows;

    doc.addPage({size:[pageWidth,pageHeight]});

    // Title block
    doc.fontSize(16).font('Helvetica-Bold').text('AztecArchive Barcode Grid', margin, margin);
    const date = new Date().toISOString().split('T')[0];
    const codecNames = { 0x00: 'RAW', 0x01: 'ZLIB', 0x02: 'BROTLI' };
    const codec = codecNames[result.meta.compId] || 'UNKNOWN';
    doc.fontSize(10).font('Helvetica').text('File: ' + req.file.originalname, margin, margin + 20);
    doc.text('Date: ' + date, margin, margin + 35);
    doc.text('Symbols: ' + result.meta.total + ' (' + cols + 'x' + rows + ') | Codec: ' + codec, margin, margin + 50);
    doc.moveDown(3);

    // Barcode grid (with slight adjustments for title)
    const topMargin = 140;
    const gridCellW = (pageWidth - margin*2) / cols;
    const gridCellH = (pageHeight - topMargin - margin*2) / rows;

    for (let i=0;i<result.symbols.length;i++){
      const col = i % cols;
      const row = Math.floor(i/cols);
      const x = margin + col*gridCellW;
      const y = topMargin + row*gridCellH;
      const size = Math.min(gridCellW, gridCellH) - 10;
      doc.image(result.symbols[i].png, x, y, { width: size, height: size });
      doc.fontSize(8).text('#' + (i+1), x + 2, y + 2);
    }

    // Footer with decode instructions
    doc.fontSize(9).font('Helvetica-Oblique');
    const footerY = pageHeight - 25;
    doc.text('Scan all symbols at http://localhost:3000/scan to reconstruct the original file', margin, footerY, { width: pageWidth - margin*2, align: 'center' });

    doc.end();
  } catch(e) {
    console.error('Error in encode:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/decode', (req, res) => {
  console.log('Decode request received');
  if (!req.body.chunks || !Array.isArray(req.body.chunks)) {
    return res.status(400).json({ error: 'Expected chunks array' });
  }
  try {
    const chunks = req.body.chunks.map(b64 => Buffer.from(b64, 'base64'));
    const result = decode(chunks);
    const mimeMap = {
      'txt': 'text/plain',
      'md': 'text/markdown',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'pdf': 'application/pdf',
      'zip': 'application/zip',
      'bin': 'application/octet-stream'
    };
    res.json({
      data: result.data.toString('base64'),
      ext: result.ext,
      mimeType: mimeMap[result.ext] || 'application/octet-stream',
      compId: result.compId,
      total: result.total
    });
  } catch (e) {
    console.error('Error in decode:', e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Encoder running on http://localhost:' + PORT));

const express = require('express');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { encode } = require('../shared');

const upload = multer({ storage: multer.memoryStorage() });
const app = express();
app.use(express.static('public'));

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
    // create PDF with PNGs in grid
    const doc = new PDFDocument({ autoFirstPage: false });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="aztec_output.pdf"');
    
    // Save to local disk as well for convenience
    const outPath = path.join(process.cwd(), 'aztec_output.pdf');
    const localStream = fs.createWriteStream(outPath);
    doc.pipe(localStream);
    
    localStream.on('finish', () => console.log('Successfully saved PDF to disk:', outPath));
    
    doc.pipe(res);
    const cols = Math.ceil(Math.sqrt(result.meta.total));
    const rows = Math.ceil(result.meta.total / cols);
    const pageWidth = 595.28; // A4
    const pageHeight = 841.89;
    const margin = 40;
    const cellW = (pageWidth - margin*2) / cols;
    const cellH = (pageHeight - margin*2) / rows;
    doc.addPage({size:[pageWidth,pageHeight]});
    for (let i=0;i<result.symbols.length;i++){
      const col = i % cols;
      const row = Math.floor(i/cols);
      const x = margin + col*cellW;
      const y = margin + row*cellH;
      doc.image(result.symbols[i].png, x, y, { width: Math.min(cellW, cellH)-10, height: Math.min(cellW, cellH)-10 });
      doc.text(`#${i+1}`, x+4, y+4);
    }
    doc.end();
  } catch(e) {
    console.error('Error in encode:', e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Encoder running on http://localhost:' + PORT));

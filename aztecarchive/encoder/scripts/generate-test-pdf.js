const PDFDocument = require('pdfkit');
const fs = require('fs');

function generate() {
  const doc = new PDFDocument();
  doc.pipe(fs.createWriteStream('test-page.pdf'));
  doc.fontSize(20).text('AztecArchive Test PDF', {align:'center'});
  doc.moveDown();
  doc.fontSize(12).text('This is a minimal one-page PDF for encoding tests.');
  doc.end();
}

generate();

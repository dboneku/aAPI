const { crc16 } = require('./crc16');
const MAX_PAYLOAD = 1907; // per design (1907 bytes payload per symbol)

function chunkBuffer(buf, origTag, encodedTag, compId) {
  const chunks = [];
  const total = Math.ceil(buf.length / MAX_PAYLOAD);
  if (total > 36) throw new Error('Exceeds max 36 symbols');
  for (let i = 0; i < total; i++) {
    const start = i * MAX_PAYLOAD;
    const slice = buf.slice(start, start + MAX_PAYLOAD);
    const header = Buffer.alloc(7);
    header.writeUInt8(origTag & 0xFF, 0);
    header.writeUInt8(encodedTag & 0xFF, 1);
    header.writeUInt8(compId & 0xFF, 2);
    header.writeUInt8(total & 0xFF, 3);
    header.writeUInt8(i & 0xFF, 4);
    const crc = crc16(slice);
    header.writeUInt16BE(crc & 0xFFFF, 5);
    chunks.push(Buffer.concat([header, slice]));
  }
  return chunks;
}

module.exports = { chunkBuffer };

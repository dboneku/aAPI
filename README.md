# AztecArchive

**Analog APIs** — encode any file into a printable grid of Aztec barcodes and reconstruct it by scanning that grid. No links, no cloud, no network dependency. The printed page _is_ the backup.

---

## How It Works

1. **Encode**: upload a file to the web UI → compressed binary payload → grid of Aztec barcodes → print-ready PDF.
2. **Scan**: visit `/scan` in any browser with a camera (or upload a barcode image) → scan each symbol → server reconstructs and returns the original file.

---

## Repository Structure

```
aztecarchive/
  encoder/      # Node.js + Express web app (encoder UI + decode endpoint)
  shared/       # Codec logic shared between encoder and any future app
README.md
initial-requirements.md
```

> `app/` (React Native mobile scanner) is planned but not yet implemented. The `/scan` web page in the encoder serves as the decode UI in the meantime.

---

## Codecs

Selection is automatic based on file extension and content:

| ID   | Name        | Used for                                           |
|------|-------------|-----------------------------------------------------|
| 0x00 | RAW         | Already-compressed formats (JPEG, PNG, PDF, ZIP…)  |
| 0x01 | ZLIB        | Binary / arbitrary data                             |
| 0x02 | DICT\_ZLIB  | Plain text (TXT, MD, CSV, JSON, XML…)               |

`DICT_ZLIB` tokenizes the text into a vocabulary, stores the dictionary inline, encodes the token sequence as Uint16LE indices, then deflates them. The dictionary travels with the payload — no external reference is needed to decode.

---

## Symbol Header Format

Every Aztec symbol carries a **7-byte header** prepended to its payload chunk:

| Byte(s) | Field               | Notes                        |
|---------|---------------------|------------------------------|
| 0       | Original file type tag | Extension→byte map (see `shared/fileTypes.js`) |
| 1       | Encoded file type tag  | Same as byte 0 in current impl |
| 2       | Codec ID            | 0x00 / 0x01 / 0x02          |
| 3       | Total symbol count  | Max 255                      |
| 4       | This symbol index   | 0-based                      |
| 5–6     | CRC16 of chunk payload | CRC16-CCITT (0x1021)      |

---

## API Endpoints

```
GET  /               → Encoder web UI
GET  /scan           → Scanner web UI

POST /preview        multipart file → JSON { symbolCount, meta, symbols[] }
POST /encode         multipart file → PDF binary (Aztec grid)
POST /decode         JSON { chunks: string[] }  (base64 chunk payloads)
                   → JSON { data, ext, mimeType, compId, total }
```

---

## Running the Encoder

```bash
cd aztecarchive/encoder
npm install
npm start          # http://localhost:3000
# or
npm run dev        # same but NODE_ENV=development
```

Node 20+ required.

---

## Reference Test Case

KJV Gospel of John encoded with `DICT_ZLIB` produces ~12 symbols (4×3 grid). This is the primary validation case for the codec pipeline.

---

## Shared Codec Modules

| File             | Purpose                                          |
|------------------|--------------------------------------------------|
| `dict.js`        | Dictionary encode/decode (`encodeDict`, `decodeDict`) |
| `compression.js` | Codec selection (`tryAll(buffer, ext)`)          |
| `chunker.js`     | Split compressed blob into header+payload chunks |
| `aztec.js`       | Render one chunk as an Aztec PNG via bwip-js     |
| `crc16.js`       | CRC16-CCITT checksum                             |
| `fileTypes.js`   | Extension ↔ tag byte mapping                     |
| `index.js`       | `encode(buffer, filename)` / `decode(chunks[])`  |

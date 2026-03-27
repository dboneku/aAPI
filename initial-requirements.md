# AztecArchive Technical Specification

## Project Overview

AztecArchive is a two-part system that encodes any file into a printable grid of Aztec barcodes and reconstructs the original file by scanning that grid with a mobile app. The encoded content is embedded directly in the barcodes -- no links, no network dependency. The printed grid is the backup medium.

---

## Repository Structure

```
aztecarchive/
  encoder/          # Node.js + Express web app (encoder UI)
  app/              # React Native mobile app (scanner + decoder)
  shared/           # Shared codec logic (used by both)
  README.md
```

---

## Shared Codec (`shared/`)

This module is the single source of truth for all encoding and decoding logic. Both the encoder and the app import from here. The encoder uses it via Node.js directly. The app bundles it via Metro.

### Codec Types

Detect and select codec at encode time based on file type and content:

| Codec ID | Value | Use Case |
|---|---|---|
| `RAW` | `0x00` | Already-compressed formats (JPEG, PNG, PDF, ZIP, DOCX) |
| `ZLIB` | `0x01` | Uncompressed binary, arbitrary files |
| `DICT_ZLIB` | `0x02` | Plain text files (TXT, CSV, MD, JSON, XML) |

Selection logic:
- If MIME type is in the pre-compressed list: use `RAW`
- If file is valid UTF-8 and word-repetition ratio exceeds threshold: use `DICT_ZLIB`
- Otherwise: use `ZLIB`

Pre-compressed MIME types (use `RAW`): `image/jpeg`, `image/png`, `image/webp`, `application/pdf`, `application/zip`, `application/vnd.openxmlformats-officedocument.*`

### Dictionary Encoding (`DICT_ZLIB`)

1. Tokenize text preserving punctuation as separate tokens
2. Build vocab list of unique tokens, sorted for determinism
3. Encode each token as a 2-byte unsigned short (supports up to 65,535 unique tokens)
4. Pack token indices as binary with `struct` equivalent (`Uint16Array`)
5. Apply zlib deflate at level 9
6. Prepend serialized dictionary as a length-prefixed block before the compressed payload

The dictionary travels with the payload -- the app does not need a bundled dictionary for arbitrary files. For known texts (e.g. KJV John), a bundled dictionary can be used instead and flagged in the header.

### Symbol Header Format

Every Aztec symbol carries a 6-byte header prepended to its payload chunk:

```
Byte 0:   File type tag (see below)
Byte 1:   Codec ID (0x00, 0x01, 0x02)
Byte 2:   Total symbol count (max 255)
Byte 3:   This symbol index (0-based)
Bytes 4-5: CRC16 checksum of this chunk's payload
```

File type tag is a single byte mapping to a known extension. Unknown types use `0xFF` and the original filename is embedded in symbol 0's payload prefix (null-terminated, max 64 bytes).

### Chunking

1. Encode full file to compressed binary blob
2. Aztec max payload at 25% error correction: **1,908 bytes** (1,914 minus 6-byte header)
3. Split blob into sequential chunks of 1,908 bytes
4. Prepend header to each chunk
5. Generate one Aztec symbol per chunk

Grid layout: compute `cols = ceil(sqrt(n))`, `rows = ceil(n / cols)` for the most square grid possible.

### Warn Threshold

Emit a warning (do not block) when symbol count exceeds 36 (6x6 equivalent). Include estimated scan time and print dimensions in the warning.

---

## Encoder (`encoder/`)

### Stack

- **Runtime:** Node.js 20+
- **Framework:** Express 4
- **Aztec generation:** `@zxing/library` (JS port) or `python-barcode` via child process if JS Aztec quality is insufficient
- **PDF output:** `pdfkit`
- **UI:** Single-page vanilla HTML/CSS/JS served by Express (no framework needed)

### Web UI Features

- Drag-and-drop or file picker for any file type
- Live preview: symbol count, grid dimensions, estimated print size, codec selected, compression ratio
- Warn banner if symbol count exceeds 36
- File converter: convert input file to a different format before encoding (see File Converter section)
- Generate button outputs a print-ready PDF
- PDF layout: Aztec grid with symbol index labels, title block (filename, date, symbol count, codec), and a human-readable footer with decode instructions

### API Endpoints

```
POST /encode
  Body: multipart/form-data (file)
  Returns: PDF binary

POST /convert
  Body: multipart/form-data (file, targetFormat)
  Returns: converted file binary

GET /preview
  Body: multipart/form-data (file)
  Returns: JSON { symbolCount, grid, codec, compressionRatio, warnings[] }
```

### File Converter (Encoder Side)

Supported conversions:

| From | To Options |
|---|---|
| DOCX | PDF, TXT, MD |
| PDF | TXT |
| CSV | JSON, TXT |
| MD | PDF, TXT, HTML |
| TXT | MD, PDF |
| Images (PNG/JPEG) | Encode as-is (no conversion, just embed) |

Implementation: use `mammoth` (DOCX to HTML/MD/TXT), `pdf-parse` (PDF to TXT), `marked` (MD to HTML), `puppeteer` (HTML to PDF).

---

## Mobile App (`app/`)

### Stack

- **Framework:** React Native (bare workflow, not Expo managed)
- **Camera + scanning:** `react-native-vision-camera` v4 + `vision-camera-plugin-barcode-scanner` (ML Kit backed)
- **Navigation:** React Navigation v6
- **File system:** `react-native-fs`
- **Share/export:** `react-native-share`

### Screens

#### Scan Screen (default)

- Full-screen camera view
- Real-time multi-barcode detection in a single frame (ML Kit detects all Aztec symbols simultaneously)
- Overlay grid showing detected symbols with color coding:
  - Gray: not yet detected
  - Yellow: detected, pending validation
  - Green: decoded and verified (CRC16 pass)
  - Red: CRC16 fail (prompt rescan of that symbol)
- Progress indicator: `X of N symbols captured`
- Once all symbols captured and verified: auto-proceed to reconstruction

#### Reconstruction Screen

- Reassemble chunks in index order
- Decompress according to codec ID in header
- Write output file to device with correct extension
- Display: filename, file size, codec used, compression ratio, timestamp
- Actions: Open, Share, Save to Files (iOS) / Downloads (Android)

#### File Converter (App Side)

Accessible from the Reconstruction Screen after a successful decode. Allows the user to convert the decoded file to another format before saving or sharing.

Supported conversions on-device:
- TXT to MD (trivial, no library needed)
- JSON to CSV (`papaparse` or equivalent)
- Any decoded file: Share as-is and let the OS handle conversion via share sheet

For conversions requiring heavy processing (DOCX, PDF generation): POST to encoder API if available on local network, or display a message directing user to the encoder web UI.

#### History Screen

- List of previously decoded files stored in app sandbox
- Tap to re-open, re-share, or delete

### Multi-Symbol Scan Architecture

ML Kit's barcode scanning API returns all detected barcodes in a single frame as an array. The app processes each detected symbol in the frame:

1. Decode Aztec binary payload
2. Parse 6-byte header
3. Validate CRC16
4. Store chunk keyed by symbol index
5. Update overlay state

The camera stays live until all `totalSymbols` indices are collected and verified. The user does not need to scan symbols in order or one at a time.

Edge cases:
- If a symbol fails CRC16 repeatedly, highlight it red and show "Move camera slightly and hold steady"
- If `totalSymbols` values conflict across symbols (corrupted header), flag as scan error and abort
- Handle partial frame captures gracefully -- only commit a symbol once CRC16 passes

---

## File Converter (Shared Behavior)

Both encoder and app offer conversion. The converter is not a codec -- it operates on the file before encoding or after decoding, independently of the Aztec pipeline.

Conversion is always optional and non-destructive. The original file is never modified; conversion produces a new file.

---

## Error Handling

| Condition | Behavior |
|---|---|
| File too large to encode cleanly | Warn with symbol count and estimated print size, allow continue |
| CRC16 fail on decode | Flag symbol, keep camera live, prompt rescan |
| Codec mismatch in header | Abort decode, show error with header dump for debugging |
| Unknown file type tag | Use embedded filename from symbol 0 payload |
| Encoder API unreachable (app converter) | Graceful fallback message, no crash |

---

## Build and Run

### Encoder

```bash
cd encoder
npm install
npm run dev       # development
npm run start     # production
```

Runs on `http://localhost:3000` by default.

### App

```bash
cd app
npm install
npx pod-install   # iOS only
npx react-native run-ios
npx react-native run-android
```

---

## Known Constraints and Notes

- Aztec 25% error correction is the minimum recommended for physical print artifacts. Do not reduce EC to increase payload per symbol.
- For KJV Gospel of John specifically: 12 symbols, 4x3 grid, ~21KB compressed with `DICT_ZLIB`. This is the reference test case for validating the codec.
- The printed grid should include a human-readable decode instruction block so the artifact is self-describing without the app documentation.
- Symbol index labels on the printed PDF are for human reference only -- the app does not depend on print order.
- This system is intentionally offline-first. No analytics, no telemetry, no network calls during encode or decode.
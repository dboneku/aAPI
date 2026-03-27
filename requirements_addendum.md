# AztecArchive: VECTOR Codec Addendum

Addendum to `aztecarchive-spec.md`. Adds a fourth codec type for vector/drawing content.

---

## New Codec Entry

Add to the codec type table in `shared/`:

| Codec ID | Value | Use Case |
|---|---|---|
| `VECTOR` | `0x03` | SVG files and canvas draw instruction payloads |

---

## Codec Selection Logic Update

Add to the detection logic in the codec selector:

- If MIME type is `image/svg+xml` or file extension is `.svg`: use `VECTOR`
- `VECTOR` takes priority over `ZLIB` and `DICT_ZLIB` for SVG inputs -- do not fall through to text codecs even though SVG is valid UTF-8

---

## VECTOR Codec: Encode

1. Parse input as SVG string
2. Strip non-rendering content: XML declaration, comments, metadata elements (`<title>`, `<desc>`, `<metadata>`), editor-specific namespaces (`inkscape:*`, `sodipodi:*`), empty `<g>` wrappers
3. Normalize attribute order for determinism (sort attributes alphabetically per element)
4. Strip whitespace between tags
5. Round all float coordinates to 2 decimal places
6. Output is a minified SVG string
7. Apply zlib deflate level 9 to the minified SVG bytes
8. This is the payload -- no dictionary needed

SVG is already a draw instruction language. There is no need to invent a custom instruction set. Minified SVG + zlib achieves excellent compression ratios for geometric content.

---

## VECTOR Codec: Decode

1. Decompress zlib payload to UTF-8 string
2. Output is a valid SVG string
3. Write file with `.svg` extension
4. App renders using React Native SVG (`react-native-svg`) on decode preview screen
5. Encoder UI renders using browser-native SVG in the preview panel

---

## File Converter Updates

### Encoder Side

Add conversion path:

| From | To | Method |
|---|---|---|
| SVG | PNG/JPEG | `sharp` library -- rasterize at user-specified DPI (default 300) |
| PNG/JPEG | SVG | Out of scope -- do not attempt auto-trace; show message directing user to a dedicated tool (e.g. Inkscape, Vector Magic) |

Add UI recommendation: when user uploads a PNG or JPEG that appears to be a diagram or schematic (low unique color count, large flat regions), surface a suggestion: "This looks like a diagram. If you have an SVG version, it will encode significantly smaller."

### App Side

After decoding a `VECTOR` payload:
- Render SVG preview inline using `react-native-svg`
- Export options: Save as `.svg`, or rasterize to PNG via `react-native-svg` snapshot method before sharing

---

## Compression Benchmark Reference

For validation, test the VECTOR codec against these reference cases:

| Test File | Raw SVG Size | Expected Compressed | Expected Symbols (25% EC) |
|---|---|---|---|
| Simple flowchart (10 nodes) | ~8KB | ~1.5KB | 1 |
| Floor plan (50 rooms) | ~40KB | ~6KB | 3-4 |
| Circuit schematic (100 components) | ~80KB | ~12KB | 6-7 |

If compressed output exceeds these estimates significantly, check that SVG stripping and minification are running before zlib.

---

## Automatic Optimization Pipeline

The encoder runs this pipeline automatically on every file upload. No user intervention required. Results are displayed in the preview panel with a size comparison and the selected codec. The user can override the selection if needed.

### Pipeline

```
Input file received
  ├── Is it SVG?
  │     └── VECTOR codec. Done.
  │
  ├── Is it DOCX or PDF?
  │     ├── Extract plain text (mammoth for DOCX, pdf-parse for PDF)
  │     ├── Compare: compressed text size vs compressed original binary
  │     └── Pick smaller. If text wins, use DICT_ZLIB on extracted text.
  │
  ├── Is it PNG or JPEG?
  │     ├── Run color palette analysis (sharp)
  │     │     ├── Fewer than 16 unique colors + large flat regions detected?
  │     │     │     ├── Attempt potrace raster-to-vector trace
  │     │     │     ├── Compare: compressed SVG size vs compressed raster
  │     │     │     └── Pick smaller. If SVG wins, use VECTOR codec.
  │     │     └── High color complexity (photographic)?
  │     │           ├── Run OCR (tesseract.js)
  │     │           ├── Compare: compressed OCR text vs compressed image
  │     │           ├── If text is 50%+ smaller: use DICT_ZLIB on OCR output
  │     │           └── Otherwise: RAW codec on original image.
  │     └── Done.
  │
  └── Is it plain text, MD, CSV, JSON, XML?
        └── DICT_ZLIB. Done.
```

### Parallelization

Run all applicable analysis paths concurrently using `Promise.all`. Do not wait for one path to complete before starting another. For a PNG input, color analysis, potrace attempt, and OCR should all kick off simultaneously. Pick the winner from whichever results come back. Total wall time is the slowest single path, not the sum of all paths.

```javascript
const [paletteResult, ocrResult, traceResult] = await Promise.all([
  analyzePalette(file),
  runOCR(file),
  attemptTrace(file)
]);
```

Cancel or ignore results from slower paths once a clear winner is determined (e.g. if OCR returns text that compresses to under 10KB, the raster result is irrelevant regardless of when it finishes).

### Timing Expectations

| Step | Expected Duration |
|---|---|
| Color palette analysis | <50ms |
| Edge/geometry detection | <100ms |
| DOCX/PDF text extraction | 100-300ms |
| potrace vector trace | 100-400ms |
| tesseract.js OCR (full page) | 1-3 seconds |
| Total worst case (OCR path) | ~3-4 seconds |

Show a loading state with a progress label ("Analyzing file...") during the pipeline. For files that hit the OCR path, show "Extracting text via OCR..." so the user understands the delay.

### UI Output

After analysis, display in the preview panel:

```
File: manual.jpg (1.2MB)
Detected as: text document (via OCR)
Codec selected: DICT_ZLIB on extracted text
Compressed size: 5.8KB
Symbols required: 3 (2x2 grid)
Reduction: 99.5%
[Override codec ▾]
```

If the optimizer tried multiple paths, show the comparison:

```
Analyzed 3 encoding strategies:
  RAW (original image):   820KB → 47 symbols
  VECTOR (potrace):       not viable — SVG larger than raster
  DICT_ZLIB (OCR text):   5.8KB → 3 symbols  ← selected
```

### Override Behavior

The user can override the selected codec via a dropdown. Overriding to a less optimal codec shows a warning with the symbol count difference but does not block encoding. Use cases for override: OCR extracted text with errors, intentional image preservation, debugging.

### Dependencies

Add to encoder `package.json`:

```json
"sharp": "^0.33",
"tesseract.js": "^5",
"node-potrace": "^2"
```

`tesseract.js` runs fully in Node -- no system binary required. `node-potrace` wraps potrace as a native addon. `sharp` is already recommended for the rasterization path.

---

## Notes

- Do not implement custom binary draw instruction formats. Minified SVG is compact enough and keeps the codec stateless -- no instruction set versioning to manage.
- `react-native-svg` is likely already a dependency if the app uses any vector UI elements. Confirm before adding it.
- The SVG stripping step is important -- Inkscape and Illustrator exports carry significant dead weight in namespace declarations and editor metadata that can double the file size.
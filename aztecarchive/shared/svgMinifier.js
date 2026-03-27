/**
 * SVG minification for the VECTOR codec.
 *
 * Strips non-rendering content (editor metadata, comments, namespaces) and
 * compacts the SVG string before zlib compression. No external dependencies.
 *
 * Steps performed:
 *  1. Strip XML declaration
 *  2. Strip DOCTYPE
 *  3. Strip HTML/XML comments
 *  4. Strip metadata elements: <title>, <desc>, <metadata> (and their children)
 *  5. Strip Inkscape/Sodipodi/dc/cc/rdf namespace declarations and attributes
 *  6. Strip empty <g> wrappers (repeated to catch nested)
 *  7. Round float coordinates to 2 decimal places
 *  8. Collapse whitespace between tags
 *  9. Compact path d="" attribute whitespace
 */
function minifySVG(input) {
  let svg = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);

  // 1. XML declaration
  svg = svg.replace(/<\?xml[^?]*\?>/gi, '');

  // 2. DOCTYPE
  svg = svg.replace(/<!DOCTYPE[^>]*>/gi, '');

  // 3. Comments
  svg = svg.replace(/<!--[\s\S]*?-->/g, '');

  // 4. Metadata elements — strip opening tag, all children, and closing tag
  svg = svg.replace(/<(title|desc|metadata)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  // Also self-closing forms
  svg = svg.replace(/<(title|desc|metadata)\b[^/]*\/>/gi, '');

  // 5a. Inkscape/Sodipodi/dc/cc/rdf xmlns declarations
  svg = svg.replace(/\s+xmlns:(inkscape|sodipodi|dc|cc|rdf)="[^"]*"/gi, '');
  // 5b. Inkscape/Sodipodi/dc/cc/rdf attributes (name:attr="value")
  svg = svg.replace(/\s+(inkscape|sodipodi|dc|cc|rdf):[a-zA-Z:_-]+=(?:"[^"]*"|'[^']*')/g, '');

  // 6. Strip empty <g> wrappers — three passes for nested empties
  for (let i = 0; i < 3; i++) {
    svg = svg.replace(/<g(?:\s+(?:id|class)="[^"]*")?\s*>\s*<\/g>/gi, '');
  }

  // 7. Round float coordinates to 2 decimal places
  //    Matches numbers with 3+ decimal digits anywhere in the SVG string
  svg = svg.replace(/\b(\d+)\.(\d{3,})\b/g, (_, intPart, decPart) => {
    return `${intPart}.${parseFloat('0.' + decPart).toFixed(2).slice(2)}`;
  });

  // 8. Collapse whitespace between tags
  svg = svg.replace(/>\s+</g, '><');

  // 9. Compact path d="" attribute internal whitespace
  svg = svg.replace(/\bd="([^"]*)"/g, (_, d) => `d="${d.replace(/\s+/g, ' ').trim()}"`);

  return svg.trim();
}

module.exports = { minifySVG };

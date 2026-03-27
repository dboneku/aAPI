module.exports = {
  // mapping extension (lowercase) -> tag byte
  extToTag: {
    pdf:  0x01,
    txt:  0x02,
    md:   0x03,
    svg:  0x04,
    jpg:  0x10,
    jpeg: 0x10,
    png:  0x11,
    zip:  0x20,
  },
  tagToExt: function(tag) {
    const map = {
      0x01: 'pdf',
      0x02: 'txt',
      0x03: 'md',
      0x04: 'svg',
      0x10: 'jpg',
      0x11: 'png',
      0x20: 'zip',
      0xFF: 'bin'
    };
    return map[tag] || 'bin';
  }
};

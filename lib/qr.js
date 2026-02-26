// Minimal QR Code Generator for TinkeDin popup
// Generates QR codes as canvas elements. Supports alphanumeric content up to ~4000 chars.
// Based on the QR code specification (ISO/IEC 18004).

var QRCode = (function() {
  'use strict';

  // GF(256) arithmetic for Reed-Solomon
  var EXP = new Uint8Array(256);
  var LOG = new Uint8Array(256);
  (function() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x = (x << 1) ^ (x & 128 ? 0x11d : 0);
    }
    EXP[255] = EXP[0];
  })();

  function gfMul(a, b) {
    return a === 0 || b === 0 ? 0 : EXP[(LOG[a] + LOG[b]) % 255];
  }

  function polyMul(a, b) {
    var result = new Uint8Array(a.length + b.length - 1);
    for (var i = 0; i < a.length; i++)
      for (var j = 0; j < b.length; j++)
        result[i + j] ^= gfMul(a[i], b[j]);
    return result;
  }

  function rsGenPoly(n) {
    var p = new Uint8Array([1]);
    for (var i = 0; i < n; i++)
      p = polyMul(p, new Uint8Array([1, EXP[i]]));
    return p;
  }

  function rsEncode(data, ecLen) {
    var gen = rsGenPoly(ecLen);
    var msg = new Uint8Array(data.length + ecLen);
    msg.set(data);
    for (var i = 0; i < data.length; i++) {
      var coef = msg[i];
      if (coef !== 0)
        for (var j = 0; j < gen.length; j++)
          msg[i + j] ^= gfMul(gen[j], coef);
    }
    return msg.slice(data.length);
  }

  // QR code parameters by version (1-10) for error correction level L
  var VERSIONS = [
    null,
    { total: 26, ec: 7, dcap: 19 },
    { total: 44, ec: 10, dcap: 34 },
    { total: 70, ec: 15, dcap: 55 },
    { total: 100, ec: 20, dcap: 80 },
    { total: 134, ec: 26, dcap: 108 },
    { total: 172, ec: 18, dcap: 68 }, // 6: 2 blocks
    { total: 196, ec: 20, dcap: 78 },
    { total: 242, ec: 24, dcap: 97 },
    { total: 292, ec: 30, dcap: 116 },
    { total: 346, ec: 18, dcap: 134 }, // 10: 2 blocks
  ];

  // EC codewords per block and block structure for versions 1-10, EC level L
  var BLOCK_INFO = [
    null,
    [{ count: 1, dc: 19, ec: 7 }],
    [{ count: 1, dc: 34, ec: 10 }],
    [{ count: 1, dc: 55, ec: 15 }],
    [{ count: 1, dc: 80, ec: 20 }],
    [{ count: 1, dc: 108, ec: 26 }],
    [{ count: 2, dc: 68, ec: 18 }],
    [{ count: 2, dc: 78, ec: 20 }],
    [{ count: 2, dc: 97, ec: 24 }],
    [{ count: 2, dc: 116, ec: 30 }],
    [{ count: 2, dc: 134, ec: 18 }],
  ];

  function chooseVersion(dataLen) {
    for (var v = 1; v <= 10; v++) {
      if (dataLen <= VERSIONS[v].dcap) return v;
    }
    throw new Error('Data too long for QR');
  }

  function encodeData(text, version) {
    var dcap = VERSIONS[version].dcap;
    // Byte mode encoding
    var bits = [];
    function push(val, len) {
      for (var i = len - 1; i >= 0; i--)
        bits.push((val >> i) & 1);
    }
    // Mode indicator: byte = 0100
    push(4, 4);
    // Character count (8 bits for versions 1-9, 16 bits for 10+)
    var ccBits = version <= 9 ? 8 : 16;
    push(text.length, ccBits);
    // Data
    for (var i = 0; i < text.length; i++)
      push(text.charCodeAt(i), 8);
    // Terminator
    var termLen = Math.min(4, dcap * 8 - bits.length);
    for (var i = 0; i < termLen; i++) bits.push(0);
    // Pad to byte boundary
    while (bits.length % 8 !== 0) bits.push(0);
    // Pad codewords
    var pads = [0xEC, 0x11], pi = 0;
    while (bits.length < dcap * 8) {
      push(pads[pi], 8);
      pi ^= 1;
    }
    // Convert to bytes
    var bytes = new Uint8Array(dcap);
    for (var i = 0; i < dcap; i++) {
      var b = 0;
      for (var j = 0; j < 8; j++)
        b = (b << 1) | bits[i * 8 + j];
      bytes[i] = b;
    }
    return bytes;
  }

  function buildCodewords(dataBytes, version) {
    var blocks = BLOCK_INFO[version];
    var dcBlocks = [], ecBlocks = [];

    var offset = 0;
    for (var g = 0; g < blocks.length; g++) {
      for (var b = 0; b < blocks[g].count; b++) {
        var dc = dataBytes.slice(offset, offset + blocks[g].dc);
        offset += blocks[g].dc;
        var ec = rsEncode(dc, blocks[g].ec);
        dcBlocks.push(dc);
        ecBlocks.push(ec);
      }
    }

    // Interleave data codewords
    var result = [];
    var maxDc = Math.max.apply(null, dcBlocks.map(function(b) { return b.length; }));
    for (var i = 0; i < maxDc; i++)
      for (var b = 0; b < dcBlocks.length; b++)
        if (i < dcBlocks[b].length) result.push(dcBlocks[b][i]);

    // Interleave EC codewords
    var maxEc = Math.max.apply(null, ecBlocks.map(function(b) { return b.length; }));
    for (var i = 0; i < maxEc; i++)
      for (var b = 0; b < ecBlocks.length; b++)
        if (i < ecBlocks[b].length) result.push(ecBlocks[b][i]);

    return result;
  }

  function createMatrix(version) {
    var size = version * 4 + 17;
    var matrix = [];
    var reserved = [];
    for (var i = 0; i < size; i++) {
      matrix[i] = new Uint8Array(size);
      reserved[i] = new Uint8Array(size);
    }
    return { matrix: matrix, reserved: reserved, size: size };
  }

  function setModule(m, row, col, val) {
    m.matrix[row][col] = val ? 1 : 0;
    m.reserved[row][col] = 1;
  }

  function placeFinderPattern(m, row, col) {
    for (var r = -1; r <= 7; r++) {
      for (var c = -1; c <= 7; c++) {
        var rr = row + r, cc = col + c;
        if (rr < 0 || rr >= m.size || cc < 0 || cc >= m.size) continue;
        var inOuter = r === 0 || r === 6 || c === 0 || c === 6;
        var inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        var inSep = r === -1 || r === 7 || c === -1 || c === 7;
        setModule(m, rr, cc, !inSep && (inOuter || inInner) ? 1 : 0);
      }
    }
  }

  var ALIGNMENT_POSITIONS = [
    null, [], [], [], [], [],
    [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]
  ];

  function placeAlignmentPatterns(m, version) {
    var pos = ALIGNMENT_POSITIONS[version];
    if (!pos || pos.length === 0) return;
    for (var i = 0; i < pos.length; i++) {
      for (var j = 0; j < pos.length; j++) {
        var r = pos[i], c = pos[j];
        if (m.reserved[r][c]) continue;
        for (var dr = -2; dr <= 2; dr++) {
          for (var dc = -2; dc <= 2; dc++) {
            var val = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
            setModule(m, r + dr, c + dc, val ? 1 : 0);
          }
        }
      }
    }
  }

  function placeTimingPatterns(m) {
    for (var i = 8; i < m.size - 8; i++) {
      if (!m.reserved[6][i]) setModule(m, 6, i, i % 2 === 0 ? 1 : 0);
      if (!m.reserved[i][6]) setModule(m, i, 6, i % 2 === 0 ? 1 : 0);
    }
  }

  function reserveFormatInfo(m) {
    for (var i = 0; i < 8; i++) {
      if (!m.reserved[8][i]) { m.reserved[8][i] = 1; }
      if (!m.reserved[i][8]) { m.reserved[i][8] = 1; }
      if (!m.reserved[8][m.size - 1 - i]) { m.reserved[8][m.size - 1 - i] = 1; }
      if (!m.reserved[m.size - 1 - i][8]) { m.reserved[m.size - 1 - i][8] = 1; }
    }
    m.reserved[8][8] = 1;
    // Dark module
    setModule(m, m.size - 8, 8, 1);
  }

  function placeData(m, codewords) {
    var bitIndex = 0;
    var totalBits = codewords.length * 8;
    var col = m.size - 1;
    var goingUp = true;

    while (col >= 0) {
      if (col === 6) col--; // skip timing column
      for (var i = 0; i < m.size; i++) {
        var row = goingUp ? m.size - 1 - i : i;
        for (var j = 0; j < 2; j++) {
          var c = col - j;
          if (c < 0) continue;
          if (m.reserved[row][c]) continue;
          if (bitIndex < totalBits) {
            var byteIdx = bitIndex >> 3;
            var bitIdx = 7 - (bitIndex & 7);
            m.matrix[row][c] = (codewords[byteIdx] >> bitIdx) & 1;
          }
          bitIndex++;
        }
      }
      col -= 2;
      goingUp = !goingUp;
    }
  }

  // Mask patterns
  var MASK_FNS = [
    function(r, c) { return (r + c) % 2 === 0; },
    function(r, c) { return r % 2 === 0; },
    function(r, c) { return c % 3 === 0; },
    function(r, c) { return (r + c) % 3 === 0; },
    function(r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
    function(r, c) { return (r * c) % 2 + (r * c) % 3 === 0; },
    function(r, c) { return ((r * c) % 2 + (r * c) % 3) % 2 === 0; },
    function(r, c) { return ((r + c) % 2 + (r * c) % 3) % 2 === 0; },
  ];

  function applyMask(m, maskIdx) {
    var fn = MASK_FNS[maskIdx];
    for (var r = 0; r < m.size; r++)
      for (var c = 0; c < m.size; c++)
        if (!m.reserved[r][c])
          m.matrix[r][c] ^= fn(r, c) ? 1 : 0;
  }

  // Format info: EC level L = 01, mask pattern
  var FORMAT_BITS = [
    0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976
  ];

  function placeFormatInfo(m, maskIdx) {
    var bits = FORMAT_BITS[maskIdx];
    for (var i = 0; i < 15; i++) {
      var bit = (bits >> (14 - i)) & 1;
      // Around top-left finder
      if (i < 6) m.matrix[8][i] = bit;
      else if (i === 6) m.matrix[8][7] = bit;
      else if (i === 7) m.matrix[8][8] = bit;
      else if (i === 8) m.matrix[7][8] = bit;
      else m.matrix[14 - i][8] = bit;
      // Other copy
      if (i < 8) m.matrix[m.size - 1 - i][8] = bit;
      else m.matrix[8][m.size - 15 + i] = bit;
    }
  }

  function penaltyScore(m) {
    var score = 0;
    var size = m.size;
    // Rule 1: consecutive same-color modules in row/col
    for (var r = 0; r < size; r++) {
      var count = 1;
      for (var c = 1; c < size; c++) {
        if (m.matrix[r][c] === m.matrix[r][c - 1]) count++;
        else { if (count >= 5) score += count - 2; count = 1; }
      }
      if (count >= 5) score += count - 2;
    }
    for (var c = 0; c < size; c++) {
      var count = 1;
      for (var r = 1; r < size; r++) {
        if (m.matrix[r][c] === m.matrix[r - 1][c]) count++;
        else { if (count >= 5) score += count - 2; count = 1; }
      }
      if (count >= 5) score += count - 2;
    }
    // Rule 3: finder-like patterns
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size - 6; c++) {
        var p = 0;
        for (var i = 0; i < 7; i++) p = (p << 1) | m.matrix[r][c + i];
        if (p === 0x5D || p === 0x5D) score += 40;
      }
    }
    return score;
  }

  function generate(text) {
    var version = chooseVersion(text.length);
    var dataBytes = encodeData(text, version);
    var codewords = buildCodewords(dataBytes, version);
    var m = createMatrix(version);

    placeFinderPattern(m, 0, 0);
    placeFinderPattern(m, 0, m.size - 7);
    placeFinderPattern(m, m.size - 7, 0);
    placeAlignmentPatterns(m, version);
    placeTimingPatterns(m);
    reserveFormatInfo(m);
    placeData(m, codewords);

    // Try all masks, pick best
    var bestMask = 0, bestScore = Infinity;
    for (var mi = 0; mi < 8; mi++) {
      var copy = createMatrix(version);
      for (var r = 0; r < m.size; r++) {
        copy.matrix[r].set(m.matrix[r]);
        copy.reserved[r].set(m.reserved[r]);
      }
      applyMask(copy, mi);
      placeFormatInfo(copy, mi);
      var s = penaltyScore(copy);
      if (s < bestScore) { bestScore = s; bestMask = mi; }
    }

    applyMask(m, bestMask);
    placeFormatInfo(m, bestMask);

    return m;
  }

  function toCanvas(text, opts) {
    opts = opts || {};
    var scale = opts.scale || 6;
    var margin = opts.margin !== undefined ? opts.margin : 4;
    var m = generate(text);
    var totalSize = (m.size + margin * 2) * scale;

    var canvas = document.createElement('canvas');
    canvas.width = totalSize;
    canvas.height = totalSize;
    var ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = opts.background || '#ffffff';
    ctx.fillRect(0, 0, totalSize, totalSize);

    // Modules
    ctx.fillStyle = opts.color || '#000000';
    for (var r = 0; r < m.size; r++)
      for (var c = 0; c < m.size; c++)
        if (m.matrix[r][c])
          ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);

    return canvas;
  }

  return { generate: generate, toCanvas: toCanvas };
})();

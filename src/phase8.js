const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  getUserRootPath,
  resolveSafePath,
  getUniqueUploadPath,
  assertQuotaAvailable,
} = require('./storage');
const { saveFileVersionSnapshot } = require('./phase5');

// ============================================================================
// 1. PURE JS ISO/IEC 18004 QR CODE SVG GENERATOR (VERSIONS 1–10, ECC LEVEL L)
// ============================================================================
const QR_VERSION_SPECS = [
  null,
  // [totalCodewords, ecCodewordsPerBlock, numBlocksGroup1, dataCwGroup1, numBlocksGroup2, dataCwGroup2, alignCenters]
  [26, 7, 1, 19, 0, 0, []], // v1 (21x21)
  [44, 10, 1, 34, 0, 0, [6, 18]], // v2 (25x25)
  [70, 15, 1, 55, 0, 0, [6, 22]], // v3 (29x29)
  [100, 20, 1, 80, 0, 0, [6, 26]], // v4 (33x33)
  [134, 26, 1, 108, 0, 0, [6, 30]], // v5 (37x37)
  [172, 18, 2, 68, 0, 0, [6, 34]], // v6 (41x41)
  [196, 20, 4, 39, 0, 0, [6, 22, 38]], // v7 (45x45)
  [242, 24, 2, 97, 0, 0, [6, 24, 42]], // v8 (49x49)
  [292, 30, 3, 58, 2, 29, [6, 26, 46]], // v9 (53x53)
  [346, 18, 4, 68, 0, 0, [6, 28, 50]], // v10 (57x57)
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function rsComputeRemainder(dataBytes, degree) {
  const gen = rsGeneratorPoly(degree);
  const rem = new Uint8Array(degree);
  for (let i = 0; i < dataBytes.length; i++) {
    const factor = dataBytes[i] ^ rem[0];
    rem.copyWithin(0, 1);
    rem[degree - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < degree; j++) {
        rem[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return rem;
}

function encodeQrMatrix(text) {
  const utf8 = Buffer.from(String(text || ''), 'utf8');
  let version = 1;
  while (version <= 10) {
    const spec = QR_VERSION_SPECS[version];
    const totalDataCw = spec[2] * spec[3] + spec[4] * spec[5];
    const lenBits = version <= 9 ? 8 : 16;
    const neededBits = 4 + lenBits + utf8.length * 8;
    if (neededBits <= totalDataCw * 8) break;
    version++;
  }
  if (version > 10) version = 10;

  const spec = QR_VERSION_SPECS[version];
  const ecCwPerBlock = spec[1];
  const g1Blocks = spec[2];
  const g1DataCw = spec[3];
  const g2Blocks = spec[4];
  const g2DataCw = spec[5];
  const totalDataCw = g1Blocks * g1DataCw + g2Blocks * g2DataCw;

  const maxPayload = totalDataCw - (version <= 9 ? 2 : 3);
  const payload = utf8.length > maxPayload ? utf8.subarray(0, maxPayload) : utf8;

  // Build bit stream: Mode 0100 (Byte), length, bytes, terminator, pad bytes
  const bits = [];
  const pushBits = (val, count) => {
    for (let i = count - 1; i >= 0; i--) {
      bits.push((val >>> i) & 1);
    }
  };

  pushBits(0b0100, 4);
  pushBits(payload.length, version <= 9 ? 8 : 16);
  for (let i = 0; i < payload.length; i++) {
    pushBits(payload[i], 8);
  }

  const maxBits = totalDataCw * 8;
  const termLen = Math.min(4, maxBits - bits.length);
  pushBits(0, termLen);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataCodewords = new Uint8Array(totalDataCw);
  for (let i = 0; i < bits.length / 8; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) {
      b = (b << 1) | bits[i * 8 + j];
    }
    dataCodewords[i] = b;
  }
  let padIdx = bits.length / 8;
  let padToggle = true;
  while (padIdx < totalDataCw) {
    dataCodewords[padIdx++] = padToggle ? 0xec : 0x11;
    padToggle = !padToggle;
  }

  // Split into blocks & compute Reed-Solomon EC codewords
  const blocksData = [];
  const blocksEc = [];
  let offset = 0;
  for (let i = 0; i < g1Blocks; i++) {
    const blk = dataCodewords.subarray(offset, offset + g1DataCw);
    offset += g1DataCw;
    blocksData.push(blk);
    blocksEc.push(rsComputeRemainder(blk, ecCwPerBlock));
  }
  for (let i = 0; i < g2Blocks; i++) {
    const blk = dataCodewords.subarray(offset, offset + g2DataCw);
    offset += g2DataCw;
    blocksData.push(blk);
    blocksEc.push(rsComputeRemainder(blk, ecCwPerBlock));
  }

  const interleaved = [];
  const maxBlockDataLen = Math.max(g1DataCw, g2DataCw);
  for (let i = 0; i < maxBlockDataLen; i++) {
    for (const blk of blocksData) {
      if (i < blk.length) interleaved.push(blk[i]);
    }
  }
  for (let i = 0; i < ecCwPerBlock; i++) {
    for (const ec of blocksEc) {
      interleaved.push(ec[i]);
    }
  }

  const size = 17 + version * 4;
  const modules = Array.from({ length: size }, () => new Uint8Array(size));
  const isFunc = Array.from({ length: size }, () => new Uint8Array(size));

  const setFunctionModule = (r, c, dark) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    modules[r][c] = dark ? 1 : 0;
    isFunc[r][c] = 1;
  };

  // Finder patterns + separators
  const drawFinder = (topR, leftC) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = topR + dr;
        const c = leftC + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const isBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const isCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunctionModule(r, c, inOuter && (isBorder || isCenter));
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setFunctionModule(6, i, i % 2 === 0);
    setFunctionModule(i, 6, i % 2 === 0);
  }

  // Alignment patterns
  const alignCoords = spec[6];
  for (const ar of alignCoords) {
    for (const ac of alignCoords) {
      if (
        (ar === 6 && ac === 6) ||
        (ar === 6 && ac === size - 7) ||
        (ar === size - 7 && ac === 6)
      ) {
        continue;
      }
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFunctionModule(ar + dr, ac + dc, dist !== 1);
        }
      }
    }
  }

  // Dark module & reserve format info areas
  setFunctionModule(4 * version + 9, 8, true);
  for (let i = 0; i <= 8; i++) {
    if (!isFunc[8][i]) setFunctionModule(8, i, false);
    if (!isFunc[i][8]) setFunctionModule(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    if (!isFunc[8][size - 1 - i]) setFunctionModule(8, size - 1 - i, false);
    if (!isFunc[size - 1 - i][8]) setFunctionModule(size - 1 - i, 8, false);
  }

  // Version info for v >= 7
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) {
      rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    }
    const verBits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((verBits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunctionModule(a, b, bit);
      setFunctionModule(b, a, bit);
    }
  }

  // Place data bits in zigzag
  let bitIdx = 0;
  const totalBits = interleaved.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? size - 1 - vert : vert;
        if (!isFunc[r][c] && bitIdx < totalBits) {
          const byteVal = interleaved[bitIdx >>> 3];
          const bit = ((byteVal >>> (7 - (bitIdx & 7))) & 1) !== 0;
          modules[r][c] = bit ? 1 : 0;
          bitIdx++;
        }
      }
    }
  }

  // Apply Mask 0: (r + c) % 2 === 0
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!isFunc[r][c] && (r + c) % 2 === 0) {
        modules[r][c] ^= 1;
      }
    }
  }

  // Format bits for ECC Level L (01) + Mask 0 (000) => data = 0b01000
  let fmtData = (0b01 << 3) | 0;
  let fmtRem = fmtData;
  for (let i = 0; i < 10; i++) {
    fmtRem = (fmtRem << 1) ^ ((fmtRem >>> 9) * 0x537);
  }
  const fmtBits = ((fmtData << 10) | fmtRem) ^ 0x5412;

  const getFmtBit = (i) => ((fmtBits >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) setFunctionModule(8, i, getFmtBit(i));
  setFunctionModule(8, 7, getFmtBit(6));
  setFunctionModule(8, 8, getFmtBit(7));
  setFunctionModule(7, 8, getFmtBit(8));
  for (let i = 9; i < 15; i++) setFunctionModule(14 - i, 8, getFmtBit(i));

  for (let i = 0; i < 8; i++) setFunctionModule(size - 1 - i, 8, getFmtBit(i));
  for (let i = 8; i < 15; i++) setFunctionModule(8, size - 15 + i, getFmtBit(i));

  return modules;
}

function generateQrSvg(text, options = {}) {
  const matrix = encodeQrMatrix(text);
  const size = matrix.length;
  const margin = Number(options.margin ?? 3);
  const total = size + margin * 2;
  const darkColor = options.darkColor || '#0F172A';
  const lightColor = options.lightColor || '#FFFFFF';

  let pathD = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c]) {
        pathD += `M${c + margin},${r + margin}h1v1h-1z`;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" style="width:100%;height:100%;max-width:260px;max-height:260px;border-radius:12px;display:block;margin:0 auto;">
    <rect width="${total}" height="${total}" fill="${lightColor}" rx="2" />
    <path d="${pathD}" fill="${darkColor}" />
  </svg>`;
}

// ============================================================================
// 2. FULL-TEXT CONTENT SEARCH / GREP (ค้นหาคำข้างในเนื้อหาไฟล์)
// ============================================================================
const TEXT_SEARCHABLE_EXTS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.csv',
  '.tsv',
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
  '.html',
  '.htm',
  '.css',
  '.py',
  '.sh',
  '.zsh',
  '.yml',
  '.yaml',
  '.xml',
  '.ini',
  '.conf',
  '.env',
  '.log',
  '.sql',
  '.c',
  '.cpp',
  '.h',
  '.java',
  '.go',
  '.rs',
  '.php',
  '.rb',
]);

function searchFileContents(user, { query = '', caseSensitive = false, maxResults = 60 } = {}) {
  const rawQuery = String(query || '').trim();
  if (!rawQuery) {
    const err = new Error('กรุณาพิมพ์คำหรือข้อความที่ต้องการค้นหาในเนื้อหาไฟล์');
    err.statusCode = 400;
    throw err;
  }

  const rootDir = getUserRootPath(user);
  const needle = caseSensitive ? rawQuery : rawQuery.toLowerCase();
  const results = [];
  let totalMatches = 0;
  let scannedFiles = 0;

  function walk(currentDir, relPrefix = '') {
    if (results.length >= maxResults) return;
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(currentDir, entry.name);
      const relPath = `${relPrefix}/${entry.name}`;

      if (entry.isDirectory()) {
        walk(fullPath, relPath);
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (!TEXT_SEARCHABLE_EXTS.has(ext)) continue;
      const cat = 'text';

      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.size <= 0 || stat.size > 5 * 1024 * 1024) continue;

      scannedFiles++;
      let content;
      try {
        content = fs.readFileSync(fullPath, 'utf8');
      } catch {
        continue;
      }

      const lines = content.split(/\r?\n/);
      const fileMatches = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const hay = caseSensitive ? line : line.toLowerCase();
        if (hay.includes(needle)) {
          const snippet = line.trim().slice(0, 220);
          fileMatches.push({
            lineNumber: i + 1,
            preview: snippet,
            lineText: snippet,
          });
          totalMatches++;
          if (fileMatches.length >= 5) break;
        }
      }

      if (fileMatches.length > 0) {
        const parentRel = path.posix.dirname(relPath);
        results.push({
          name: entry.name,
          path: relPath,
          parentPath: parentRel === '.' ? '/' : parentRel,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          category: cat,
          extension: ext,
          matchCount: fileMatches.length,
          matches: fileMatches,
        });
      }
    }
  }

  walk(rootDir, '');

  return {
    query: rawQuery,
    scannedFiles,
    totalFilesMatched: results.length,
    totalMatches,
    results,
  };
}

// ============================================================================
// 3. BUILT-IN IMAGE STUDIO & METADATA INSPECTOR (macOS /usr/bin/sips)
// ============================================================================
function inspectImageMetadata(user, clientPath) {
  const rootDir = getUserRootPath(user);
  const { fullPath, relativePath } = resolveSafePath(clientPath, rootDir);
  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    const err = new Error('ไม่พบไฟล์รูปภาพที่ระบุ');
    err.statusCode = 404;
    throw err;
  }

  const stat = fs.statSync(fullPath);
  const meta = {
    name: path.basename(fullPath),
    path: relativePath,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    width: null,
    height: null,
    format: path.extname(fullPath).replace('.', '').toUpperCase() || 'IMAGE',
    colorSpace: 'RGB',
    dpi: 72,
  };

  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/sips')) {
    try {
      const out = execFileSync(
        '/usr/bin/sips',
        [
          '-g',
          'pixelWidth',
          '-g',
          'pixelHeight',
          '-g',
          'format',
          '-g',
          'space',
          '-g',
          'dpiWidth',
          fullPath,
        ],
        { encoding: 'utf8', timeout: 3000 }
      );
      const parseVal = (key) => {
        const m = out.match(new RegExp(`${key}:\\s*(.+)`));
        return m ? m[1].trim() : null;
      };
      const w = Number(parseVal('pixelWidth'));
      const h = Number(parseVal('pixelHeight'));
      if (w > 0) meta.width = w;
      if (h > 0) meta.height = h;
      const fmt = parseVal('format');
      if (fmt) meta.format = fmt.toUpperCase();
      const sp = parseVal('space');
      if (sp) meta.colorSpace = sp;
      const dpi = Number(parseVal('dpiWidth'));
      if (dpi > 0) meta.dpi = Math.round(dpi);
    } catch {
      // Ignore sips read error
    }
  }

  return meta;
}

function transformImageOnNas(
  user,
  {
    path: clientPath = '',
    rotateDegrees = 0,
    flip = 'none',
    maxDimension = 0,
    targetFormat = 'keep',
    saveAsCopy = true,
  } = {}
) {
  const rootDir = getUserRootPath(user);
  const { fullPath: srcFull, relativePath: srcRel } = resolveSafePath(clientPath, rootDir);
  if (!fs.existsSync(srcFull) || fs.statSync(srcFull).isDirectory()) {
    const err = new Error('ไม่พบไฟล์รูปภาพที่ต้องการปรับแต่ง');
    err.statusCode = 404;
    throw err;
  }

  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sips')) {
    const err = new Error('ระบบปฏิบัติการนี้ไม่มีเครื่องมือ /usr/bin/sips สำหรับแปลงรูปภาพ');
    err.statusCode = 400;
    throw err;
  }

  const srcStat = fs.statSync(srcFull);
  assertQuotaAvailable(user, srcStat.size);

  const origExt = path.extname(srcFull);
  const baseStem = path.basename(srcFull, origExt);
  const parentDir = path.dirname(srcFull);

  const fmtMap = {
    jpeg: { sipsFmt: 'jpeg', ext: '.jpg' },
    jpg: { sipsFmt: 'jpeg', ext: '.jpg' },
    png: { sipsFmt: 'png', ext: '.png' },
    tiff: { sipsFmt: 'tiff', ext: '.tiff' },
    bmp: { sipsFmt: 'bmp', ext: '.bmp' },
    gif: { sipsFmt: 'gif', ext: '.gif' },
  };

  const normalizedFmt = String(targetFormat || 'keep').toLowerCase();
  const fmtSpec = fmtMap[normalizedFmt] || null;
  const outExt = fmtSpec ? fmtSpec.ext : origExt;

  let destFull = srcFull;
  let finalName = path.basename(srcFull);

  if (saveAsCopy || outExt.toLowerCase() !== origExt.toLowerCase()) {
    const candidateName = `${baseStem}_edited${outExt}`;
    const unique = getUniqueUploadPath(parentDir, candidateName);
    destFull = unique.fullPath;
    finalName = unique.finalName;
    fs.copyFileSync(srcFull, destFull);
  } else {
    saveFileVersionSnapshot(user, srcRel);
  }

  const args = [];
  const deg = Number(rotateDegrees || 0);
  if (deg === 90 || deg === 180 || deg === 270) {
    args.push('-r', String(deg));
  }
  if (flip === 'horizontal' || flip === 'vertical') {
    args.push('-f', flip);
  }
  const maxDim = Number(maxDimension || 0);
  if (maxDim >= 64 && maxDim <= 8192) {
    args.push('-Z', String(maxDim));
  }
  if (fmtSpec) {
    args.push('-s', 'format', fmtSpec.sipsFmt);
  }

  if (args.length > 0) {
    args.push(destFull);
    execFileSync('/usr/bin/sips', args, { stdio: 'ignore', timeout: 15000 });
  }

  const outRel = path.posix.join(path.posix.dirname(srcRel), finalName);
  const updatedMeta = inspectImageMetadata(user, outRel);

  return {
    outputName: finalName,
    outputPath: outRel,
    metadata: updatedMeta,
  };
}

module.exports = {
  generateQrSvg,
  searchFileContents,
  inspectImageMetadata,
  transformImageOnNas,
};

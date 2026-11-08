const fs = require('node:fs');
const path = require('node:path');

// Precompute CRC32 lookup table
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32Update(crc, buf) {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dateToDos(date) {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  const dosTime = (hours << 11) | (minutes << 5) | seconds;
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

/**
 * Recursively collects files and empty directories to include in the ZIP
 */
function collectEntriesForZip(sourceFullPath, zipBasePrefix = '') {
  const results = [];
  const stat = fs.statSync(sourceFullPath);
  const baseName = path.basename(sourceFullPath);
  const relEntryPath = zipBasePrefix ? `${zipBasePrefix}/${baseName}` : baseName;

  if (stat.isFile()) {
    results.push({
      fullPath: sourceFullPath,
      zipPath: relEntryPath,
      isDirectory: false,
      size: stat.size,
      mtime: stat.mtime,
    });
    return results;
  }

  if (stat.isDirectory()) {
    const children = fs
      .readdirSync(sourceFullPath)
      .filter((name) => name !== '.DS_Store' && name !== '.gitkeep');

    if (children.length === 0) {
      results.push({
        fullPath: sourceFullPath,
        zipPath: `${relEntryPath}/`,
        isDirectory: true,
        size: 0,
        mtime: stat.mtime,
      });
      return results;
    }

    for (const child of children) {
      const childFull = path.join(sourceFullPath, child);
      try {
        results.push(...collectEntriesForZip(childFull, relEntryPath));
      } catch {
        // Ignore unreadable files
      }
    }
  }

  return results;
}

/**
 * Computes CRC32 of a file using a stream so large files don't load into memory
 */
function computeFileCrc32(fullPath) {
  return new Promise((resolve, reject) => {
    let crc = 0;
    let size = 0;
    const rs = fs.createReadStream(fullPath);
    rs.on('data', (chunk) => {
      crc = crc32Update(crc, chunk);
      size += chunk.length;
    });
    rs.on('end', () => resolve({ crc, size }));
    rs.on('error', reject);
  });
}

function writeChunk(stream, buffer) {
  return new Promise((resolve, reject) => {
    const ok = stream.write(buffer, (err) => {
      if (err) reject(err);
    });
    if (ok) {
      resolve();
    } else {
      stream.once('drain', resolve);
    }
  });
}

function pipeFileToStream(fullPath, destStream) {
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(fullPath);
    rs.on('data', (chunk) => {
      if (!destStream.write(chunk)) {
        rs.pause();
        destStream.once('drain', () => rs.resume());
      }
    });
    rs.on('end', resolve);
    rs.on('error', reject);
  });
}

/**
 * Streams multiple source paths into a standard ZIP archive on-the-fly
 */
async function streamZipArchive(sourceFullPaths, outStream) {
  const allEntries = [];
  for (const src of sourceFullPaths) {
    if (fs.existsSync(src)) {
      allEntries.push(...collectEntriesForZip(src, ''));
    }
  }

  const centralDirectory = [];
  let offset = 0;

  for (const entry of allEntries) {
    const nameBuf = Buffer.from(entry.zipPath.replace(/\\/g, '/'), 'utf8');
    const { dosTime, dosDate } = dateToDos(entry.mtime || new Date());

    let crc = 0;
    let fileSize = 0;
    if (!entry.isDirectory) {
      const info = await computeFileCrc32(entry.fullPath);
      crc = info.crc;
      fileSize = info.size;
    }

    // Local File Header (30 bytes + filename)
    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // Signature
    localHeader.writeUInt16LE(20, 4); // Version needed (2.0)
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag (bit 11)
    localHeader.writeUInt16LE(0, 8); // Store method (0 = no compression, fastest streaming)
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc >>> 0, 14);
    localHeader.writeUInt32LE(fileSize >>> 0, 18);
    localHeader.writeUInt32LE(fileSize >>> 0, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // Extra field length
    nameBuf.copy(localHeader, 30);

    const localHeaderOffset = offset;
    await writeChunk(outStream, localHeader);
    offset += localHeader.length;

    if (!entry.isDirectory && fileSize > 0) {
      await pipeFileToStream(entry.fullPath, outStream);
      offset += fileSize;
    }

    // Central Directory Header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Signature
    centralHeader.writeUInt16LE(20, 4); // Version made by
    centralHeader.writeUInt16LE(20, 6); // Version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
    centralHeader.writeUInt16LE(0, 10); // Store method
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc >>> 0, 16);
    centralHeader.writeUInt32LE(fileSize >>> 0, 20);
    centralHeader.writeUInt32LE(fileSize >>> 0, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // Extra field length
    centralHeader.writeUInt16LE(0, 32); // Comment length
    centralHeader.writeUInt16LE(0, 34); // Disk number
    centralHeader.writeUInt16LE(0, 36); // Internal attributes
    centralHeader.writeUInt32LE(entry.isDirectory ? 0x10 : 0, 38); // External attributes
    centralHeader.writeUInt32LE(localHeaderOffset >>> 0, 42);
    nameBuf.copy(centralHeader, 46);

    centralDirectory.push(centralHeader);
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const cd of centralDirectory) {
    await writeChunk(outStream, cd);
    centralDirSize += cd.length;
  }

  // End of Central Directory Record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // Signature
  eocd.writeUInt16LE(0, 4); // Disk number
  eocd.writeUInt16LE(0, 6); // Disk with central dir
  eocd.writeUInt16LE(centralDirectory.length, 8);
  eocd.writeUInt16LE(centralDirectory.length, 10);
  eocd.writeUInt32LE(centralDirSize >>> 0, 12);
  eocd.writeUInt32LE(centralDirOffset >>> 0, 16);
  eocd.writeUInt16LE(0, 20); // Comment length

  await writeChunk(outStream, eocd);
  outStream.end();
}

module.exports = {
  streamZipArchive,
};


const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pipeline } = require('node:stream');
const { hashPassword, verifyPassword } = require('./auth');
const {
  getUserById,
  createFileRequestRecord,
  getFileRequestById,
  listFileRequests,
  incrementFileRequestUploadCount,
  deleteFileRequestById,
  upsertFileTag,
} = require('./db');
const {
  getFilesRoot,
  getUserRootPath,
  resolveSafePath,
  assertQuotaAvailable,
  assertExtensionAllowed,
  getFileMetadata,
  getUniqueUploadPath,
} = require('./storage');
const { streamZipArchive } = require('./zip');

// ================= 1. ONLINE ARCHIVE EXTRACTOR & COMPRESSOR =================
/**
 * Pure Node.js ZIP extractor (supports Store method=0 and Deflate method=8)
 * with strict Zip-Slip path traversal protection.
 */
function extractZipBufferToDir(zipFilePath, destDirFull) {
  const stat = fs.statSync(zipFilePath);
  const fileSize = stat.size;
  if (fileSize < 22) {
    throw new Error('ไฟล์ .zip มีขนาดเล็กเกินไปหรือไม่สมบูรณ์');
  }

  const fd = fs.openSync(zipFilePath, 'r');
  try {
    // Read only the tail of the file (up to 65557 bytes) to locate End of Central Directory (EOCD)
    const tailSize = Math.min(fileSize, 65557);
    const tailOffset = fileSize - tailSize;
    const tailBuf = Buffer.allocUnsafe(tailSize);
    fs.readSync(fd, tailBuf, 0, tailSize, tailOffset);

    let eocdInTail = -1;
    for (let i = tailSize - 22; i >= 0; i--) {
      if (tailBuf.readUInt32LE(i) === 0x06054b50) {
        eocdInTail = i;
        break;
      }
    }

    if (eocdInTail === -1) {
      throw new Error('ไฟล์ .zip ไม่ถูกต้อง หรือไม่พบโครงสร้าง Central Directory');
    }

    const totalEntries = tailBuf.readUInt16LE(eocdInTail + 10);
    const cdSize = tailBuf.readUInt32LE(eocdInTail + 12);
    const cdOffset = tailBuf.readUInt32LE(eocdInTail + 16);

    if (cdOffset + cdSize > fileSize) {
      throw new Error('โครงสร้าง Central Directory ของไฟล์ .zip เสียหาย');
    }

    const cdBuf = Buffer.allocUnsafe(cdSize);
    fs.readSync(fd, cdBuf, 0, cdSize, cdOffset);

    let ptr = 0;
    let extractedFiles = 0;
    const destWithSep = destDirFull.endsWith(path.sep) ? destDirFull : destDirFull + path.sep;
    const localHeaderBuf = Buffer.allocUnsafe(30);

    for (let i = 0; i < totalEntries; i++) {
      if (ptr + 46 > cdBuf.length || cdBuf.readUInt32LE(ptr) !== 0x02014b50) break;

      const compressionMethod = cdBuf.readUInt16LE(ptr + 10);
      const compressedSize = cdBuf.readUInt32LE(ptr + 20);
      const nameLen = cdBuf.readUInt16LE(ptr + 28);
      const extraLen = cdBuf.readUInt16LE(ptr + 30);
      const commentLen = cdBuf.readUInt16LE(ptr + 32);
      const localHeaderOffset = cdBuf.readUInt32LE(ptr + 42);

      const rawEntryName = cdBuf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
      ptr += 46 + nameLen + extraLen + commentLen;

      // Skip macOS metadata clutter
      if (rawEntryName.startsWith('__MACOSX/') || rawEntryName.endsWith('.DS_Store')) {
        continue;
      }

      const normalizedEntry = rawEntryName.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!normalizedEntry) continue;

      // Zip-Slip check
      const targetFull = path.resolve(destDirFull, normalizedEntry);
      if (targetFull !== destDirFull && !targetFull.startsWith(destWithSep)) {
        throw new Error('ตรวจพบความพยายามแตกไฟล์ออกนอกโฟลเดอร์ (Zip-Slip Blocked)');
      }

      if (rawEntryName.endsWith('/')) {
        fs.mkdirSync(targetFull, { recursive: true });
        continue;
      }

      if (localHeaderOffset + 30 > fileSize) continue;
      fs.readSync(fd, localHeaderBuf, 0, 30, localHeaderOffset);
      if (localHeaderBuf.readUInt32LE(0) !== 0x04034b50) continue;

      const localNameLen = localHeaderBuf.readUInt16LE(26);
      const localExtraLen = localHeaderBuf.readUInt16LE(28);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      if (dataStart + compressedSize > fileSize) continue;

      const compressedSlice = Buffer.allocUnsafe(compressedSize);
      fs.readSync(fd, compressedSlice, 0, compressedSize, dataStart);

      let fileData;
      if (compressionMethod === 0) {
        fileData = compressedSlice;
      } else if (compressionMethod === 8) {
        fileData = zlib.inflateRawSync(compressedSlice);
      } else {
        throw new Error(`ไม่รองรับวิธีบีบอัดชนิดพิเศษ (Method ${compressionMethod})`);
      }

      fs.mkdirSync(path.dirname(targetFull), { recursive: true });
      assertExtensionAllowed(path.basename(targetFull));
      fs.writeFileSync(targetFull, fileData);
      extractedFiles++;
    }

    return extractedFiles;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Ignore close error
    }
  }
}

function extractArchiveOnNas(user, archiveClientPath) {
  const rootDir = getUserRootPath(user);
  const { fullPath: archiveFull, relativePath } = resolveSafePath(archiveClientPath, rootDir);

  if (!fs.existsSync(archiveFull) || fs.statSync(archiveFull).isDirectory()) {
    const err = new Error('ไม่พบไฟล์บีบอัดที่ต้องการแตกไฟล์');
    err.statusCode = 404;
    throw err;
  }

  const stat = fs.statSync(archiveFull);
  // Estimate 2x archive size for quota check
  assertQuotaAvailable(user, stat.size);

  const lower = path.basename(archiveFull).toLowerCase();
  let folderBase = path.basename(archiveFull);
  if (lower.endsWith('.tar.gz')) {
    folderBase = folderBase.slice(0, -7);
  } else {
    folderBase = path.basename(folderBase, path.extname(folderBase));
  }

  const parentDir = path.dirname(archiveFull);
  const { fullPath: destDirFull, finalName: destFolderName } = getUniqueUploadPath(
    parentDir,
    folderBase || 'Extracted'
  );
  fs.mkdirSync(destDirFull, { recursive: true });

  let extractedCount = 0;
  try {
    if (lower.endsWith('.zip')) {
      extractedCount = extractZipBufferToDir(archiveFull, destDirFull);
    } else if (lower.endsWith('.tar') || lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
      execFileSync('/usr/bin/tar', ['-xf', archiveFull, '-C', destDirFull], {
        stdio: 'ignore',
        timeout: 30000,
      });
      extractedCount = 1;
    } else {
      const err = new Error('รองรับการแตกไฟล์เฉพาะ .zip, .tar, .tar.gz และ .tgz เท่านั้น');
      err.statusCode = 400;
      throw err;
    }
  } catch (err) {
    try {
      fs.rmSync(destDirFull, { recursive: true, force: true });
    } catch {
      // Ignore cleanup
    }
    throw err;
  }

  const parentRel = path.posix.dirname(relativePath);
  const extractedRelPath =
    parentRel === '/' ? `/${destFolderName}` : `${parentRel}/${destFolderName}`;

  return {
    folderName: destFolderName,
    extractedPath: extractedRelPath,
    extractedCount,
  };
}

async function compressItemsOnNas(user, sourceClientPaths = [], targetDirClientPath = '/', archiveName = '') {
  if (!Array.isArray(sourceClientPaths) || sourceClientPaths.length === 0) {
    const err = new Error('กรุณาเลือกไฟล์หรือโฟลเดอร์ที่ต้องการบีบอัดเป็น .ZIP');
    err.statusCode = 400;
    throw err;
  }

  const rootDir = getUserRootPath(user);
  const { fullPath: targetDirFull, relativePath: targetRel } = resolveSafePath(
    targetDirClientPath,
    rootDir
  );

  const fullSources = [];
  let totalEstimatedBytes = 0;
  for (const sp of sourceClientPaths) {
    const { fullPath } = resolveSafePath(sp, rootDir);
    if (fs.existsSync(fullPath)) {
      fullSources.push(fullPath);
      const st = fs.statSync(fullPath);
      if (!st.isDirectory()) totalEstimatedBytes += st.size;
    }
  }

  if (fullSources.length === 0) {
    const err = new Error('ไม่พบไฟล์ต้นทางที่ต้องการบีบอัด');
    err.statusCode = 404;
    throw err;
  }

  assertQuotaAvailable(user, totalEstimatedBytes);

  let cleanZipName = String(archiveName || '').trim();
  if (!cleanZipName) {
    cleanZipName =
      fullSources.length === 1
        ? `${path.basename(fullSources[0])}.zip`
        : `Archive-${new Date().toISOString().slice(0, 10)}.zip`;
  }
  if (!cleanZipName.toLowerCase().endsWith('.zip')) {
    cleanZipName += '.zip';
  }

  const { fullPath: destZipFull, finalName } = getUniqueUploadPath(targetDirFull, cleanZipName);
  const writeStream = fs.createWriteStream(destZipFull);

  await new Promise((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
    streamZipArchive(fullSources, writeStream).catch(reject);
  });

  const stat = fs.statSync(destZipFull);
  return {
    name: finalName,
    size: stat.size,
    path: `${targetRel === '/' ? '' : targetRel}/${finalName}`,
  };
}

// ================= 2. FILE DROP / UPLOAD REQUEST LINKS (/d/:token) =================
function createFileDropRequest(user, { clientPath = '/', title = '', password = '', expiresInHours = 0 }) {
  const rootDir = getUserRootPath(user);
  const { fullPath } = resolveSafePath(clientPath, rootDir);

  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) {
    const err = new Error('กรุณาเลือกโฟลเดอร์สำหรับรับฝากไฟล์');
    err.statusCode = 400;
    throw err;
  }

  const filesRoot = getFilesRoot();
  const storageRelPath =
    fullPath === filesRoot
      ? '/'
      : '/' + path.relative(filesRoot, fullPath).split(path.sep).join('/');

  const id = crypto.randomBytes(9).toString('base64url');
  const expiresAt =
    Number(expiresInHours) > 0
      ? new Date(Date.now() + Number(expiresInHours) * 3600 * 1000).toISOString()
      : null;

  const folderName = fullPath === rootDir ? `Root (${user.username})` : path.basename(fullPath);

  return createFileRequestRecord({
    id,
    owner_id: user.id,
    owner_username: user.username,
    storage_rel_path: storageRelPath,
    folder_name: folderName,
    title: String(title || '').trim() || `ส่งไฟล์ให้คุณ ${user.username} (${folderName})`,
    password_hash: password ? hashPassword(password) : null,
    expires_at: expiresAt,
    created_at: new Date().toISOString(),
  });
}

function validateFileDropState(reqRecord) {
  if (!reqRecord) {
    return { valid: false, status: 404, reason: 'ไม่พบลิงก์รับฝากไฟล์นี้ หรือลิงก์ถูกปิดไปแล้ว' };
  }
  if (reqRecord.expires_at && Date.now() > new Date(reqRecord.expires_at).getTime()) {
    return { valid: false, status: 410, reason: 'ลิงก์รับฝากไฟล์นี้หมดอายุแล้ว (Expired)' };
  }
  const { fullPath } = resolveSafePath(reqRecord.storage_rel_path, getFilesRoot());
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) {
    return { valid: false, status: 404, reason: 'โฟลเดอร์ปลายทางบน NAS ถูกลบหรือย้ายไปแล้ว' };
  }
  return { valid: true, fullPath };
}

function handlePublicDropUpload(req, res, reqRecord, rawFilename, uploaderName = 'Guest', sendJson) {
  const cleanName = path.basename(String(rawFilename || '').trim());
  if (!cleanName) {
    sendJson(res, 400, { error: 'กรุณาระบุชื่อไฟล์ที่อัปโหลด' });
    return;
  }

  assertExtensionAllowed(cleanName);

  const ownerUser = getUserById(reqRecord.owner_id) || {
    id: reqRecord.owner_id,
    username: reqRecord.owner_username,
    role: 'user',
  };
  const contentLength = Number(req.headers['content-length'] || 0);
  assertQuotaAvailable(ownerUser, contentLength);

  const { fullPath: targetDirFull } = resolveSafePath(reqRecord.storage_rel_path, getFilesRoot());
  const safeSender = String(uploaderName || '').trim().replace(/[^a-zA-Z0-9ก-๙._ -]/g, '');
  const prefixedName = safeSender ? `[${safeSender}] ${cleanName}` : cleanName;

  const { fullPath: destFullPath, finalName } = getUniqueUploadPath(targetDirFull, prefixedName);
  const writeStream = fs.createWriteStream(destFullPath);

  pipeline(req, writeStream, (err) => {
    if (err) {
      try {
        if (fs.existsSync(destFullPath)) fs.unlinkSync(destFullPath);
      } catch {
        // Ignore
      }
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'อัปโหลดไฟล์ล้มเหลว: ' + err.message });
      }
      return;
    }

    incrementFileRequestUploadCount(reqRecord.id);
    const stat = fs.statSync(destFullPath);
    sendJson(res, 201, {
      message: 'ส่งไฟล์เข้าสู่ NAS เรียบร้อยแล้ว ขอบคุณครับ!',
      file: {
        name: finalName,
        size: stat.size,
      },
    });
  });
}

// ================= 3. AES-256-GCM FILE ENCRYPTION VAULT =================
const VAULT_MAGIC = Buffer.from('NASVAULT1'); // 9 bytes

function encryptFileVault(user, clientPath, password) {
  const pwd = String(password || '');
  if (pwd.length < 4) {
    const err = new Error('รหัสผ่านสำหรับเข้ารหัสไฟล์ต้องมีอย่างน้อย 4 ตัวอักษร');
    err.statusCode = 400;
    throw err;
  }

  const rootDir = getUserRootPath(user);
  const { fullPath, relativePath } = resolveSafePath(clientPath, rootDir);
  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    const err = new Error('ไม่พบไฟล์ที่ต้องการเข้ารหัส');
    err.statusCode = 404;
    throw err;
  }

  if (fullPath.toLowerCase().endsWith('.vault')) {
    const err = new Error('ไฟล์นี้ถูกเข้ารหัสเป็น .vault อยู่แล้ว');
    err.statusCode = 400;
    throw err;
  }

  const plaintext = fs.readFileSync(fullPath);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(pwd, salt, 32);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag(); // 16 bytes

  const vaultPayload = Buffer.concat([VAULT_MAGIC, salt, iv, authTag, encrypted]);
  const { fullPath: vaultFullPath, finalName } = getUniqueUploadPath(
    path.dirname(fullPath),
    `${path.basename(fullPath)}.vault`
  );

  fs.writeFileSync(vaultFullPath, vaultPayload);
  fs.unlinkSync(fullPath);

  const parentRel = path.posix.dirname(relativePath);
  return {
    name: finalName,
    path: parentRel === '/' ? `/${finalName}` : `${parentRel}/${finalName}`,
    size: vaultPayload.length,
  };
}

function decryptFileVault(user, clientPath, password) {
  const pwd = String(password || '');
  if (!pwd) {
    const err = new Error('กรุณากรอกรหัสผ่านเพื่อถอดรหัสไฟล์');
    err.statusCode = 400;
    throw err;
  }

  const rootDir = getUserRootPath(user);
  const { fullPath, relativePath } = resolveSafePath(clientPath, rootDir);
  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    const err = new Error('ไม่พบไฟล์ .vault ที่ต้องการถอดรหัส');
    err.statusCode = 404;
    throw err;
  }

  const buf = fs.readFileSync(fullPath);
  const headerLen = VAULT_MAGIC.length + 16 + 12 + 16; // 53 bytes
  if (buf.length < headerLen || !buf.subarray(0, VAULT_MAGIC.length).equals(VAULT_MAGIC)) {
    const err = new Error('ไฟล์นี้ไม่ใช่ไฟล์ .vault ที่เข้ารหัสด้วยระบบ NAS นี้');
    err.statusCode = 400;
    throw err;
  }

  const salt = buf.subarray(9, 25);
  const iv = buf.subarray(25, 37);
  const authTag = buf.subarray(37, 53);
  const ciphertext = buf.subarray(53);

  let decrypted;
  try {
    const key = crypto.scryptSync(pwd, salt, 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    const err = new Error('รหัสผ่านสำหรับถอดรหัสไฟล์ไม่ถูกต้อง! (AES-256-GCM Auth Failed)');
    err.statusCode = 401;
    throw err;
  }

  const origBase = path.basename(fullPath).replace(/\.vault$/i, '') || 'decrypted-file';
  const { fullPath: outFullPath, finalName } = getUniqueUploadPath(
    path.dirname(fullPath),
    origBase
  );

  fs.writeFileSync(outFullPath, decrypted);
  fs.unlinkSync(fullPath);

  const parentRel = path.posix.dirname(relativePath);
  return {
    name: finalName,
    path: parentRel === '/' ? `/${finalName}` : `${parentRel}/${finalName}`,
    size: decrypted.length,
  };
}

// ================= 4. COLOR TAGS & FILE NOTES =================
function setFileTagAndNote(user, clientPath, color = 'none', note = '') {
  const rootDir = getUserRootPath(user);
  const { relativePath } = resolveSafePath(clientPath, rootDir);
  if (relativePath === '/') {
    const err = new Error('ไม่สามารถติดป้ายกำกับที่โฟลเดอร์หลักได้');
    err.statusCode = 400;
    throw err;
  }
  return upsertFileTag(user.id, relativePath, color, note);
}

// ================= 5. DEEP STORAGE ANALYZER =================
const CATEGORY_LABELS = {
  video: '🎬 วิดีโอ (Videos)',
  image: '🖼️ รูปภาพ (Images)',
  archive: '📦 ไฟล์บีบอัด (Archives & Backups)',
  document: '📕 เอกสาร (Documents & PDF)',
  audio: '🎵 เพลงและเสียง (Audio)',
  text: '📝 โค้ดและข้อความ (Text & Code)',
  other: '📄 ไฟล์อื่นๆ / ไฟล์เข้ารหัส (.vault)',
};

function analyzeStorageUsage(user) {
  const rootDir = getUserRootPath(user);
  const catStats = {};
  for (const key of Object.keys(CATEGORY_LABELS)) {
    catStats[key] = { category: key, label: CATEGORY_LABELS[key], bytes: 0, count: 0 };
  }

  const folderSizes = new Map(); // top-level or immediate subfolder -> bytes
  const allFiles = [];
  let totalBytes = 0;
  let totalFiles = 0;
  let totalFolders = 0;

  const stack = [{ full: rootDir, rel: '' }];
  while (stack.length > 0) {
    const curr = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(curr.full, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(curr.full, entry.name);
      const relPath = `${curr.rel}/${entry.name}`;

      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (entry.isDirectory()) {
        totalFolders++;
        stack.push({ full: fullPath, rel: relPath });
        continue;
      }

      totalFiles++;
      totalBytes += stat.size;
      const meta = getFileMetadata(entry.name, false);
      const catKey = catStats[meta.category] ? meta.category : 'other';
      catStats[catKey].bytes += stat.size;
      catStats[catKey].count += 1;

      const folderKey = curr.rel || '/ (หน้าหลัก)';
      folderSizes.set(folderKey, (folderSizes.get(folderKey) || 0) + stat.size);

      allFiles.push({
        name: entry.name,
        path: relPath,
        parentPath: curr.rel || '/',
        size: stat.size,
        category: meta.category,
        extension: meta.extension,
        modifiedAt: stat.mtime.toISOString(),
      });
    }
  }

  const byCategory = Object.values(catStats)
    .map((c) => ({
      ...c,
      percent: totalBytes > 0 ? Math.round((c.bytes / totalBytes) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const topFolders = Array.from(folderSizes.entries())
    .map(([folderPath, bytes]) => ({
      folderPath,
      bytes,
      percent: totalBytes > 0 ? Math.round((bytes / totalBytes) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 10);

  allFiles.sort((a, b) => b.size - a.size);
  const largestFiles = allFiles.slice(0, 20);

  return {
    totalBytes,
    totalFiles,
    totalFolders,
    byCategory,
    topFolders,
    largestFiles,
  };
}

module.exports = {
  extractArchiveOnNas,
  compressItemsOnNas,
  createFileDropRequest,
  validateFileDropState,
  handlePublicDropUpload,
  getFileRequestById,
  listFileRequests,
  deleteFileRequestById,
  verifyPassword,
  encryptFileVault,
  decryptFileVault,
  setFileTagAndNote,
  analyzeStorageUsage,
};


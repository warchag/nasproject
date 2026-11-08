const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const {
  insertAuditLog,
  listAuditLogs,
  clearAuditLogs,
  toggleFavorite,
  listFavoriteRecords,
  removeFavoriteRecord,
  insertFileVersion,
  listFileVersions,
  getFileVersionById,
  deleteFileVersionRecord,
} = require('./db');
const {
  getStorageRoot,
  getFilesRoot,
  getUserRootPath,
  resolveSafePath,
  assertQuotaAvailable,
  assertExtensionAllowed,
  getFileMetadata,
  getUniqueUploadPath,
} = require('./storage');

function getVersionsDir() {
  const dir = path.join(getStorageRoot(), '.cache', 'versions');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const MAX_VERSIONS_PER_FILE = 10;

// ================= 1. ACTIVITY AUDIT LOGS & BRUTE-FORCE PROTECTION =================
const failedLoginsMap = new Map(); // ip -> { count, firstFailedAt, lockedUntil }
const MAX_FAILED_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    return String(xff).split(',')[0].trim();
  }
  const raw = req.socket?.remoteAddress || '127.0.0.1';
  return raw === '::1' ? '127.0.0.1' : raw.replace(/^::ffff:/, '');
}

function logAuditEvent(req, username, action, targetPath = '', details = '') {
  try {
    insertAuditLog({
      username: username || 'anonymous',
      action,
      target_path: targetPath,
      details,
      ip_address: req ? getClientIp(req) : 'system',
    });
  } catch {
    // Non-fatal
  }
}

function checkIpLockout(ip) {
  const rec = failedLoginsMap.get(ip);
  if (!rec) return { locked: false, remainingSeconds: 0, attempts: 0 };

  const now = Date.now();
  if (rec.lockedUntil && now < rec.lockedUntil) {
    return {
      locked: true,
      remainingSeconds: Math.ceil((rec.lockedUntil - now) / 1000),
      attempts: rec.count,
    };
  }

  if (rec.lockedUntil && now >= rec.lockedUntil) {
    failedLoginsMap.delete(ip);
    return { locked: false, remainingSeconds: 0, attempts: 0 };
  }

  if (now - rec.firstFailedAt > WINDOW_MS) {
    failedLoginsMap.delete(ip);
    return { locked: false, remainingSeconds: 0, attempts: 0 };
  }

  return { locked: false, remainingSeconds: 0, attempts: rec.count };
}

function recordFailedLogin(ip) {
  const now = Date.now();
  let rec = failedLoginsMap.get(ip);
  if (!rec || now - rec.firstFailedAt > WINDOW_MS) {
    rec = { count: 1, firstFailedAt: now, lockedUntil: 0 };
  } else {
    rec.count += 1;
  }

  if (rec.count >= MAX_FAILED_ATTEMPTS) {
    rec.lockedUntil = now + LOCKOUT_MS;
  }
  failedLoginsMap.set(ip, rec);
  return {
    attempts: rec.count,
    maxAttempts: MAX_FAILED_ATTEMPTS,
    locked: rec.lockedUntil > now,
    remainingSeconds: rec.lockedUntil > now ? Math.ceil((rec.lockedUntil - now) / 1000) : 0,
  };
}

function clearFailedLogin(ip) {
  failedLoginsMap.delete(ip);
}

function listLockedIps() {
  const now = Date.now();
  const list = [];
  for (const [ip, rec] of failedLoginsMap.entries()) {
    if (rec.lockedUntil && rec.lockedUntil > now) {
      list.push({
        ip,
        attempts: rec.count,
        lockedUntil: new Date(rec.lockedUntil).toISOString(),
        remainingSeconds: Math.ceil((rec.lockedUntil - now) / 1000),
      });
    } else if (now - rec.firstFailedAt <= WINDOW_MS && rec.count > 0) {
      list.push({
        ip,
        attempts: rec.count,
        lockedUntil: null,
        remainingSeconds: 0,
      });
    }
  }
  return list;
}

function unlockIp(ip) {
  failedLoginsMap.delete(String(ip || '').trim());
  return { unlocked: true, ip };
}

// ================= 2. FAVORITES (STARRED FILES) & QUICK FILE CREATOR =================
function toggleStarredItem(user, clientPath) {
  const rootDir = getUserRootPath(user);
  const { relativePath } = resolveSafePath(clientPath, rootDir);
  if (relativePath === '/') {
    const err = new Error('ไม่สามารถติดดาวโฟลเดอร์หลักได้');
    err.statusCode = 400;
    throw err;
  }
  return toggleFavorite(user.id, relativePath);
}

function listStarredItems(user) {
  const rootDir = getUserRootPath(user);
  const records = listFavoriteRecords(user.id);
  const items = [];

  for (const rec of records) {
    try {
      const { fullPath, relativePath } = resolveSafePath(rec.rel_path, rootDir);
      if (!fs.existsSync(fullPath)) {
        removeFavoriteRecord(user.id, rec.rel_path);
        continue;
      }
      const stat = fs.statSync(fullPath);
      const isDirectory = stat.isDirectory();
      const name = path.basename(fullPath);
      const meta = getFileMetadata(name, isDirectory);

      items.push({
        name,
        path: relativePath,
        parentPath: path.posix.dirname(relativePath),
        isDirectory,
        size: isDirectory ? 0 : stat.size,
        modifiedAt: stat.mtime.toISOString(),
        starredAt: rec.created_at,
        category: meta.category,
        mimeType: meta.mimeType,
        extension: meta.extension,
        hasThumbnail: meta.category === 'image' || meta.category === 'video',
        isStarred: true,
      });
    } catch {
      // Ignore invalid paths
    }
  }
  return items;
}

function createBlankTextFile(user, parentClientPath = '/', filename = '', initialContent = '') {
  const cleanName = path.basename(String(filename || '').trim());
  if (!cleanName || cleanName === '.' || cleanName === '..') {
    const err = new Error('กรุณาระบุชื่อไฟล์ที่ต้องการสร้าง');
    err.statusCode = 400;
    throw err;
  }

  // Default to .md if no extension provided
  const finalFilename = path.extname(cleanName) ? cleanName : `${cleanName}.txt`;
  assertExtensionAllowed(finalFilename);

  const rootDir = getUserRootPath(user);
  const { fullPath: parentFull, relativePath: parentRel } = resolveSafePath(
    parentClientPath,
    rootDir
  );
  if (!fs.existsSync(parentFull) || !fs.statSync(parentFull).isDirectory()) {
    const err = new Error('ไม่พบโฟลเดอร์ปลายทาง');
    err.statusCode = 404;
    throw err;
  }

  const targetFull = path.join(parentFull, finalFilename);
  if (fs.existsSync(targetFull)) {
    const err = new Error(`มีไฟล์ชื่อ "${finalFilename}" อยู่ในโฟลเดอร์นี้แล้ว`);
    err.statusCode = 409;
    throw err;
  }

  const buf = Buffer.from(String(initialContent || ''), 'utf8');
  assertQuotaAvailable(user, buf.length);

  fs.writeFileSync(targetFull, buf);
  const relPath = parentRel === '/' ? `/${finalFilename}` : `${parentRel}/${finalFilename}`;
  return {
    name: finalFilename,
    path: relPath,
    size: buf.length,
  };
}

// ================= 3. PHOTO GALLERY & MEDIA CENTER =================
function listMediaGalleryItems(user, filterType = 'all') {
  const rootDir = getUserRootPath(user);
  const items = [];
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

      if (entry.isDirectory()) {
        stack.push({ full: fullPath, rel: relPath });
        continue;
      }

      const meta = getFileMetadata(entry.name, false);
      if (meta.category !== 'image' && meta.category !== 'video') continue;
      if (filterType === 'image' && meta.category !== 'image') continue;
      if (filterType === 'video' && meta.category !== 'video') continue;

      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      items.push({
        name: entry.name,
        path: relPath,
        parentPath: curr.rel || '/',
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        category: meta.category,
        mimeType: meta.mimeType,
        extension: meta.extension,
        hasThumbnail: true,
      });
    }
  }

  items.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
  return items;
}

// ================= 4. REMOTE URL DOWNLOADER (CLOUD FETCH) =================
function fetchStreamWithRedirects(targetUrl, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      reject(Object.assign(new Error('รูปแบบ URL ไม่ถูกต้อง'), { statusCode: 400 }));
      return;
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      reject(
        Object.assign(new Error('รองรับเฉพาะลิงก์ http:// และ https:// เท่านั้น'), {
          statusCode: 400,
        })
      );
      return;
    }

    const client = parsedUrl.protocol === 'https:' ? https : http;
    const req = client.get(
      parsedUrl,
      {
        headers: {
          'User-Agent': 'Personal-NAS-CloudFetch/5.0',
          Accept: '*/*',
        },
        timeout: 20000,
      },
      (res) => {
        if (
          [301, 302, 303, 307, 308].includes(res.statusCode) &&
          res.headers.location &&
          maxRedirects > 0
        ) {
          res.resume();
          const nextUrl = new URL(res.headers.location, parsedUrl).toString();
          resolve(fetchStreamWithRedirects(nextUrl, maxRedirects - 1));
          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(
            Object.assign(
              new Error(`เซิร์ฟเวอร์ปลายทางตอบกลับด้วยสถานะ HTTP ${res.statusCode}`),
              { statusCode: 400 }
            )
          );
          return;
        }

        resolve({ res, finalUrl: parsedUrl });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('หมดเวลาเชื่อมต่อกับ URL ปลายทาง (Timeout)'));
    });
    req.on('error', (err) => {
      reject(
        Object.assign(new Error(`ไม่สามารถเชื่อมต่อ URL ปลายทาง: ${err.message}`), {
          statusCode: 400,
        })
      );
    });
  });
}

async function downloadRemoteUrlToNas({ url, targetPath = '/', customFilename = '', user }) {
  const rootDir = getUserRootPath(user);
  const { fullPath: targetDirFull, relativePath: targetRel } = resolveSafePath(targetPath, rootDir);
  if (!fs.existsSync(targetDirFull) || !fs.statSync(targetDirFull).isDirectory()) {
    const err = new Error('ไม่พบโฟลเดอร์ปลายทาง');
    err.statusCode = 404;
    throw err;
  }

  const { res, finalUrl } = await fetchStreamWithRedirects(url);

  // Determine filename
  let derivedName = String(customFilename || '').trim();
  if (!derivedName) {
    const disposition = res.headers['content-disposition'] || '';
    const match = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)["']?/i);
    if (match && match[1]) {
      try {
        derivedName = decodeURIComponent(match[1]);
      } catch {
        derivedName = match[1];
      }
    }
  }
  if (!derivedName) {
    const urlBase = path.basename(finalUrl.pathname);
    derivedName = urlBase && urlBase !== '/' ? decodeURIComponent(urlBase) : '';
  }
  if (!derivedName) {
    derivedName = `fetched-file-${Date.now()}.bin`;
  }

  derivedName = path.basename(derivedName).replace(/[/\\?%*:|"<>]/g, '_');
  assertExtensionAllowed(derivedName);

  const contentLength = Number(res.headers['content-length'] || 0);
  if (contentLength > 0) {
    assertQuotaAvailable(user, contentLength);
  }

  const { fullPath: destFullPath, finalName } = getUniqueUploadPath(targetDirFull, derivedName);

  await new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(destFullPath);
    let downloadedBytes = 0;

    res.on('data', (chunk) => {
      downloadedBytes += chunk.length;
    });

    res.pipe(writeStream);

    writeStream.on('finish', () => {
      try {
        assertQuotaAvailable(user, 0);
        resolve(downloadedBytes);
      } catch (qErr) {
        try {
          if (fs.existsSync(destFullPath)) fs.unlinkSync(destFullPath);
        } catch {
          // Ignore
        }
        reject(qErr);
      }
    });

    const onError = (err) => {
      try {
        writeStream.destroy();
        if (fs.existsSync(destFullPath)) fs.unlinkSync(destFullPath);
      } catch {
        // Ignore
      }
      reject(err);
    };

    res.on('error', onError);
    writeStream.on('error', onError);
  });

  const stat = fs.statSync(destFullPath);
  return {
    name: finalName,
    size: stat.size,
    path: `${targetRel === '/' ? '' : targetRel}/${finalName}`,
  };
}

// ================= 5. FILE VERSIONING & ROLLBACK =================
function getScopeRootKey(user) {
  const rootDir = getUserRootPath(user);
  return rootDir === getFilesRoot() ? 'ROOT' : `USER:${user.username}`;
}

function saveFileVersionSnapshot(user, clientPath) {
  const rootDir = getUserRootPath(user);
  const { fullPath, relativePath } = resolveSafePath(clientPath, rootDir);
  if (!fs.existsSync(fullPath)) return null;

  const stat = fs.statSync(fullPath);
  if (stat.isDirectory() || stat.size === 0) return null;

  const id = crypto.randomUUID();
  const safeBase = path.basename(fullPath).replace(/[^a-zA-Z0-9._-]/g, '_');
  const versionFilename = `${id}_${safeBase}`;
  const versionDest = path.join(getVersionsDir(), versionFilename);

  fs.copyFileSync(fullPath, versionDest);

  const scopeRoot = getScopeRootKey(user);
  const record = {
    id,
    scope_root: scopeRoot,
    rel_path: relativePath,
    version_filename: versionFilename,
    size: stat.size,
    saved_by: user?.username || 'admin',
    created_at: new Date().toISOString(),
  };

  insertFileVersion(record);

  // Prune older versions beyond MAX_VERSIONS_PER_FILE
  const allVersions = listFileVersions(scopeRoot, relativePath);
  if (allVersions.length > MAX_VERSIONS_PER_FILE) {
    const toDelete = allVersions.slice(MAX_VERSIONS_PER_FILE);
    for (const oldVer of toDelete) {
      const oldFile = path.join(getVersionsDir(), oldVer.version_filename);
      if (fs.existsSync(oldFile)) {
        try {
          fs.unlinkSync(oldFile);
        } catch {
          // Ignore
        }
      }
      deleteFileVersionRecord(oldVer.id);
    }
  }

  return record;
}

function getFileVersionsList(user, clientPath) {
  const rootDir = getUserRootPath(user);
  const { relativePath } = resolveSafePath(clientPath, rootDir);
  const scopeRoot = getScopeRootKey(user);
  return listFileVersions(scopeRoot, relativePath);
}

function restoreFileVersion(user, versionId) {
  const ver = getFileVersionById(versionId);
  if (!ver) {
    const err = new Error('ไม่พบข้อมูลเวอร์ชันที่ต้องการกู้คืน');
    err.statusCode = 404;
    throw err;
  }

  const scopeRoot = getScopeRootKey(user);
  if (user.role !== 'admin' && ver.scope_root !== scopeRoot) {
    const err = new Error('คุณไม่มีสิทธิ์กู้คืนเวอร์ชันไฟล์ของผู้ใช้อื่น');
    err.statusCode = 403;
    throw err;
  }

  const versionFilePath = path.join(getVersionsDir(), ver.version_filename);
  if (!fs.existsSync(versionFilePath)) {
    deleteFileVersionRecord(versionId);
    const err = new Error('ไม่พบไฟล์สำรองของเวอร์ชันนี้บนดิสก์');
    err.statusCode = 404;
    throw err;
  }

  const rootDir = getUserRootPath(user);
  const { fullPath, relativePath } = resolveSafePath(ver.rel_path, rootDir);

  // Save current file state as a snapshot before rolling back so nothing is lost
  if (fs.existsSync(fullPath)) {
    saveFileVersionSnapshot(user, relativePath);
  } else {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  }

  fs.copyFileSync(versionFilePath, fullPath);
  const stat = fs.statSync(fullPath);

  return {
    restoredPath: relativePath,
    size: stat.size,
    restoredFromCreatedAt: ver.created_at,
  };
}

function deleteFileVersionById(user, versionId) {
  const ver = getFileVersionById(versionId);
  if (!ver) {
    const err = new Error('ไม่พบเวอร์ชันที่ระบุ');
    err.statusCode = 404;
    throw err;
  }
  const scopeRoot = getScopeRootKey(user);
  if (user.role !== 'admin' && ver.scope_root !== scopeRoot) {
    const err = new Error('คุณไม่มีสิทธิ์ลบเวอร์ชันไฟล์ของผู้อื่น');
    err.statusCode = 403;
    throw err;
  }
  const versionFilePath = path.join(getVersionsDir(), ver.version_filename);
  if (fs.existsSync(versionFilePath)) {
    try {
      fs.unlinkSync(versionFilePath);
    } catch {
      // Ignore
    }
  }
  deleteFileVersionRecord(versionId);
  return { deletedId: versionId };
}

module.exports = {
  getVersionsDir,
  getClientIp,
  logAuditEvent,
  checkIpLockout,
  recordFailedLogin,
  clearFailedLogin,
  listLockedIps,
  unlockIp,
  listAuditLogs,
  clearAuditLogs,
  toggleStarredItem,
  listStarredItems,
  createBlankTextFile,
  listMediaGalleryItems,
  downloadRemoteUrlToNas,
  saveFileVersionSnapshot,
  getFileVersionsList,
  restoreFileVersion,
  deleteFileVersionById,
};

Object.defineProperty(module.exports, 'VERSIONS_DIR', {
  get: getVersionsDir,
  enumerable: true,
  configurable: true,
});


const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream');
const {
  hashPassword,
  verifyPassword,
  createToken,
  extractUserFromRequest,
} = require('./auth');
const {
  getUploadExtensionPolicy,
  setUploadExtensionPolicy,
  getUserByUsername,
  getUserById,
  listAllUsers,
  createUser,
  updateUserByAdmin,
  deleteUserById,
  updateUserPassword,
  listTrashItems,
  getUploadSessionById,
  updateUploadSessionProgress,
  createShareLinkRecord,
  getShareLinkById,
  listShareLinks,
  incrementShareDownloadCount,
  deleteShareLinkById,
} = require('./db');
const { getSystemStats, getLanAddresses, getDirectorySizeSync } = require('./system');
const {
  getStorageRoot,
  getFilesRoot,
  getTrashRoot,
  getStorageConfig,
  testStoragePath,
  setStorageRootPath,
  resetStorageRootPath,
  getUserRootPath,
  getUserQuotaStatus,
  assertQuotaAvailable,
  assertExtensionAllowed,
  resolveSafePath,
  getFileMetadata,
  listDirectory,
  listAllFolders,
  createDirectory,
  renameItem,
  moveItems,
  copyItems,
  moveToTrash,
  restoreFromTrash,
  deleteTrashPermanently,
  emptyTrash,
  getUniqueUploadPath,
  initChunkedUpload,
  finalizeChunkedUpload,
  cancelChunkedUpload,
} = require('./storage');
const { getOrGenerateThumbnail } = require('./thumbnails');
const { streamZipArchive } = require('./zip');
const { WEBDAV_PREFIX, handleWebdavRequest } = require('./webdav');
const {
  rebuildFileIndex,
  globalSearchFiles,
  findDuplicateFiles,
} = require('./indexer');
const {
  getSchedulerConfig,
  saveSchedulerConfig,
  createBackupSnapshot,
  listBackupSnapshots,
  deleteBackupSnapshot,
  getBackupFilePath,
  runAutoTrashCleanup,
} = require('./scheduler');
const {
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
} = require('./phase5');
const {
  extractArchiveOnNas,
  compressItemsOnNas,
  createFileDropRequest,
  validateFileDropState,
  handlePublicDropUpload,
  getFileRequestById,
  listFileRequests,
  deleteFileRequestById,
  encryptFileVault,
  decryptFileVault,
  setFileTagAndNote,
  analyzeStorageUsage,
} = require('./phase6');
const {
  listAudioTracks,
  createClipboardSnippet,
  listClipboardItems,
  deleteClipboardItemById,
  batchRenameItems,
  computeFileChecksums,
  listRecipientUsers,
  sendItemsToUserInbox,
} = require('./phase7');
const {
  generateQrSvg,
  searchFileContents,
  inspectImageMetadata,
  transformImageOnNas,
  createKanbanCard,
  listKanbanCards,
  updateKanbanCard,
  deleteKanbanCard,
} = require('./phase8');
const {
  getRecentFiles,
  getTopSystemProcesses,
} = require('./phase9');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...extraHeaders,
  });
  res.end(body);
}

// In-memory rate limiter for public password verifications (shares & file drops)
const publicVerifyAttemptsMap = new Map();
const PUBLIC_VERIFY_MAX_ATTEMPTS = 5;
const PUBLIC_VERIFY_LOCK_MS = 15 * 60 * 1000; // 15 mins lock
const PUBLIC_VERIFY_WINDOW_MS = 15 * 60 * 1000;

function checkPublicVerifyLock(key) {
  const now = Date.now();
  const rec = publicVerifyAttemptsMap.get(key);
  if (!rec) return { locked: false, remainingSeconds: 0 };
  if (rec.lockedUntil && rec.lockedUntil > now) {
    return {
      locked: true,
      remainingSeconds: Math.ceil((rec.lockedUntil - now) / 1000),
    };
  }
  if (rec.lockedUntil && now >= rec.lockedUntil) {
    publicVerifyAttemptsMap.delete(key);
    return { locked: false, remainingSeconds: 0 };
  }
  if (now - rec.firstAttemptAt > PUBLIC_VERIFY_WINDOW_MS) {
    publicVerifyAttemptsMap.delete(key);
    return { locked: false, remainingSeconds: 0 };
  }
  return { locked: false, remainingSeconds: 0 };
}

function recordFailedPublicVerify(key) {
  const now = Date.now();
  let rec = publicVerifyAttemptsMap.get(key);
  if (!rec || now - rec.firstAttemptAt > PUBLIC_VERIFY_WINDOW_MS) {
    rec = { count: 1, firstAttemptAt: now, lockedUntil: 0 };
  } else {
    rec.count += 1;
  }
  if (rec.count >= PUBLIC_VERIFY_MAX_ATTEMPTS) {
    rec.lockedUntil = now + PUBLIC_VERIFY_LOCK_MS;
  }
  publicVerifyAttemptsMap.set(key, rec);
  return {
    locked: rec.lockedUntil > now,
    remainingSeconds: rec.lockedUntil > now ? Math.ceil((rec.lockedUntil - now) / 1000) : 0,
    attempts: rec.count,
    maxAttempts: PUBLIC_VERIFY_MAX_ATTEMPTS,
  };
}

function clearPublicVerifyAttempts(key) {
  publicVerifyAttemptsMap.delete(key);
}

// DNS Rebinding Defense: Host Header Validator
function isAllowedHost(hostHeader) {
  if (!hostHeader) return true;
  let host = hostHeader.trim().toLowerCase();
  if (host.startsWith('[')) {
    const endBracket = host.indexOf(']');
    if (endBracket !== -1) {
      host = host.slice(1, endBracket);
    }
  } else {
    host = host.split(':')[0].trim();
  }

  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.local')
  ) {
    return true;
  }

  // Private IPv4 ranges
  if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(host)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\.\d+\.\d+$/.test(host)) return true;
  if (/^169\.254\.\d+\.\d+$/.test(host)) return true;

  // IPv6 ULA or Link-Local
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return true;
  }

  // User-configured allowed hosts
  if (process.env.ALLOWED_HOSTS) {
    const custom = process.env.ALLOWED_HOSTS.split(',').map((h) => h.trim().toLowerCase());
    if (custom.includes(host)) return true;
  }

  try {
    const lans = getLanAddresses();
    for (const lan of lans) {
      if (lan.address && lan.address.toLowerCase() === host) return true;
    }
  } catch {
    // Ignore network enumeration error
  }

  return false;
}

// CSRF Defense: Origin / Referer check against Host header for state-mutating requests
function validateOriginOrReferer(req) {
  const mutatingMethods = ['POST', 'PUT', 'DELETE', 'PATCH'];
  if (!mutatingMethods.includes(req.method)) return true;

  const hostHeader = (req.headers.host || '').toLowerCase();
  const origin = req.headers.origin;
  const referer = req.headers.referer;

  if (origin) {
    try {
      const parsedOrigin = new URL(origin);
      if (parsedOrigin.host.toLowerCase() !== hostHeader) {
        return false;
      }
    } catch {
      return false;
    }
  } else if (referer) {
    try {
      const parsedReferer = new URL(referer);
      if (parsedReferer.host.toLowerCase() !== hostHeader) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}

function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Payload ใหญ่เกินกำหนด'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('รูปแบบ JSON ไม่ถูกต้อง'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function serveStaticFile(req, res, pathname) {
  // Support public share URLs (/s/:token) and public drop URLs (/d/:token) by serving index.html
  const effectivePath =
    pathname.startsWith('/s/') || pathname.startsWith('/d/') ? '/' : pathname;
  const relPath = effectivePath === '/' ? 'index.html' : effectivePath.replace(/^\/+/, '');
  const safeStatic = path.resolve(PUBLIC_DIR, relPath);
  if (!safeStatic.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  if (!fs.existsSync(safeStatic) || fs.statSync(safeStatic).isDirectory()) {
    sendJson(res, 404, { error: 'Not Found' });
    return;
  }

  const ext = path.extname(safeStatic).toLowerCase();
  const staticMimes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };

  res.writeHead(200, {
    'Content-Type': staticMimes[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "frame-ancestors 'self';",
  });
  fs.createReadStream(safeStatic).pipe(res);
}

function streamSingleFileWithRange(req, res, fullPath, inline = false) {
  const stat = fs.statSync(fullPath);
  const filename = path.basename(fullPath);
  const { mimeType, extension } = getFileMetadata(filename, false);
  const encodedFilename = encodeURIComponent(filename);

  // Security: never render uploaded .html or executable scripts inline in browser context
  const unsafeInlineExts = ['.html', '.htm', '.xhtml', '.js', '.mjs', '.sh', '.exe', '.bat'];
  const safeInline = inline && !unsafeInlineExts.includes(extension);

  const disposition = safeInline
    ? `inline; filename*=UTF-8''${encodedFilename}`
    : `attachment; filename*=UTF-8''${encodedFilename}`;

  const securityHeaders = {
    'X-Content-Type-Options': 'nosniff',
    ...(safeInline && extension === '.svg'
      ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" }
      : {}),
  };

  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;

    if (isNaN(start) || isNaN(end) || start > end || end >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }

    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': mimeType,
      'Content-Disposition': disposition,
      ...securityHeaders,
    });
    fs.createReadStream(fullPath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Content-Type': mimeType,
    'Content-Disposition': disposition,
    ...securityHeaders,
  });
  fs.createReadStream(fullPath).pipe(res);
}

function handleFileDownloadOrStream(req, res, urlObj, user) {
  const clientPath = urlObj.searchParams.get('path') || '';
  const inline = urlObj.searchParams.get('inline') === '1';
  const rootDir = getUserRootPath(user);
  const { fullPath } = resolveSafePath(clientPath, rootDir);

  if (!fs.existsSync(fullPath)) {
    sendJson(res, 404, { error: 'ไม่พบไฟล์ที่ระบุ' });
    return;
  }

  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    sendJson(res, 400, { error: 'ไม่สามารถดาวน์โหลดโฟลเดอร์โดยตรงได้ กรุณาใช้ระบบดาวน์โหลดแบบ ZIP' });
    return;
  }

  streamSingleFileWithRange(req, res, fullPath, inline);
}

function handleStreamUpload(req, res, urlObj, user) {
  const dirClientPath = urlObj.searchParams.get('path') || '/';
  const rawFilename = urlObj.searchParams.get('filename') || '';

  if (!rawFilename) {
    req.resume();
    sendJson(res, 400, { error: 'กรุณาระบุชื่อไฟล์ (filename)' });
    return;
  }

  assertExtensionAllowed(rawFilename);

  const contentLength = Number(req.headers['content-length'] || 0);
  assertQuotaAvailable(user, contentLength);

  const rootDir = getUserRootPath(user);
  const { fullPath: targetDirFull } = resolveSafePath(dirClientPath, rootDir);
  if (!fs.existsSync(targetDirFull) || !fs.statSync(targetDirFull).isDirectory()) {
    req.resume();
    sendJson(res, 404, { error: 'ไม่พบโฟลเดอร์ปลายทาง' });
    return;
  }

  const { fullPath: destFullPath, finalName } = getUniqueUploadPath(
    targetDirFull,
    rawFilename
  );

  const writeStream = fs.createWriteStream(destFullPath);

  pipeline(req, writeStream, (err) => {
    if (err) {
      try {
        if (fs.existsSync(destFullPath)) fs.unlinkSync(destFullPath);
      } catch {
        // Ignore cleanup errors
      }
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'อัปโหลดไฟล์ล้มเหลว: ' + err.message });
      }
      return;
    }

    try {
      const stat = fs.statSync(destFullPath);
      sendJson(res, 201, {
        message: 'อัปโหลดไฟล์สำเร็จ',
        file: {
          name: finalName,
          size: stat.size,
        },
      });
    } catch (finalizeErr) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'บันทึกไฟล์ไม่สำเร็จ: ' + finalizeErr.message });
      }
    }
  });
}

function handleChunkUploadPatch(req, res, urlObj, user = null) {
  try {
    const uploadId = urlObj.searchParams.get('uploadId') || '';
    const offset = Number(urlObj.searchParams.get('offset') || 0);

    const session = getUploadSessionById(uploadId);
    if (!session || !fs.existsSync(session.temp_path)) {
      req.resume();
      sendJson(res, 404, { error: 'ไม่พบ Session การอัปโหลดหรือไฟล์ชั่วคราวถูกลบไปแล้ว' });
      return;
    }

    const currentFileSize = fs.statSync(session.temp_path).size;
    if (offset !== currentFileSize) {
      req.resume();
      sendJson(res, 409, {
        error: 'ตำแหน่ง Offset ไม่ตรงกับข้อมูลบนเซิร์ฟเวอร์',
        expectedOffset: currentFileSize,
      });
      return;
    }

    const writeStream = fs.createWriteStream(session.temp_path, {
      flags: 'r+',
      start: offset,
    });

    pipeline(req, writeStream, (err) => {
      if (err) {
        // Rollback: truncate part file back to starting offset so subsequent retry starts cleanly
        try {
          if (fs.existsSync(session.temp_path)) {
            fs.truncateSync(session.temp_path, offset);
          }
        } catch {
          // Ignore rollback error
        }
        if (!res.headersSent) {
          sendJson(res, 500, { error: 'เขียนข้อมูล Chunk ล้มเหลว: ' + err.message });
        }
        return;
      }

      try {
        const updatedSize = fs.statSync(session.temp_path).size;
        updateUploadSessionProgress(uploadId, updatedSize);

        if (updatedSize >= session.total_size) {
          const completedFile = finalizeChunkedUpload(uploadId);
          if (user) {
            try {
              logAuditEvent(
                req,
                user.username,
                'UPLOAD',
                completedFile.path,
                `อัปโหลดไฟล์ "${completedFile.name}" (${completedFile.size} bytes)`
              );
            } catch {
              // Ignore audit log errors so upload still completes
            }
          }
          sendJson(res, 200, {
            completed: true,
            uploadedBytes: updatedSize,
            totalSize: session.total_size,
            file: completedFile,
          });
          return;
        }

        sendJson(res, 200, {
          completed: false,
          uploadedBytes: updatedSize,
          totalSize: session.total_size,
        });
      } catch (postWriteErr) {
        if (!res.headersSent) {
          sendJson(res, 500, {
            error: 'เกิดข้อผิดพลาดขณะรวมไฟล์อัปโหลด: ' + (postWriteErr.message || String(postWriteErr)),
          });
        }
      }
    });
  } catch (err) {
    req.resume();
    if (!res.headersSent) {
      sendJson(res, err.statusCode || 500, {
        error: err.message || 'เกิดข้อผิดพลาดระหว่างรับข้อมูล Chunk',
      });
    }
  }
}

async function handleThumbnailRequest(req, res, urlObj, user) {
  const clientPath = urlObj.searchParams.get('path') || '';
  const rootDir = getUserRootPath(user);
  const { fullPath } = resolveSafePath(clientPath, rootDir);

  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    sendJson(res, 404, { error: 'ไม่พบไฟล์สำหรับสร้าง Thumbnail' });
    return;
  }

  const filesRoot = getFilesRoot();
  const storageRelPath = '/' + path.relative(filesRoot, fullPath).split(path.sep).join('/');
  const meta = getFileMetadata(path.basename(fullPath), false);
  const thumb = await getOrGenerateThumbnail(
    fullPath,
    storageRelPath,
    meta.category,
    meta.extension
  );

  if (!thumb) {
    sendJson(res, 400, { error: 'ไฟล์ชนิดนี้ไม่รองรับการสร้าง Thumbnail' });
    return;
  }

  if (thumb.svgContent) {
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
    res.end(thumb.svgContent);
    return;
  }

  const stat = fs.statSync(thumb.filePath);
  res.writeHead(200, {
    'Content-Type': thumb.mimeType,
    'Content-Length': stat.size,
    'Cache-Control': 'public, max-age=86400',
  });
  fs.createReadStream(thumb.filePath).pipe(res);
}

async function handleZipDownload(req, res, urlObj, user) {
  const rawPathsParam = urlObj.searchParams.get('paths') || '';
  let clientPaths = [];

  try {
    clientPaths = JSON.parse(rawPathsParam);
  } catch {
    if (rawPathsParam) clientPaths = [rawPathsParam];
  }

  if (!Array.isArray(clientPaths) || clientPaths.length === 0) {
    sendJson(res, 400, { error: 'กรุณาระบุรายการไฟล์ที่ต้องการบีบอัดเป็น ZIP' });
    return;
  }

  const rootDir = getUserRootPath(user);
  const fullPaths = [];
  for (const cp of clientPaths) {
    const { fullPath } = resolveSafePath(cp, rootDir);
    if (fs.existsSync(fullPath)) {
      fullPaths.push(fullPath);
    }
  }

  if (fullPaths.length === 0) {
    sendJson(res, 404, { error: 'ไม่พบไฟล์ที่เลือก' });
    return;
  }

  const zipName =
    fullPaths.length === 1
      ? `${path.basename(fullPaths[0])}.zip`
      : `NAS-Archive-${new Date().toISOString().slice(0, 10)}.zip`;
  const encodedZipName = encodeURIComponent(zipName);

  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodedZipName}`,
    'Cache-Control': 'no-store',
  });

  await streamZipArchive(fullPaths, res);
}

// ================= PUBLIC SHARE LINK VALIDATION & STREAMING (PHASE 3) =================
function validateShareLinkState(link) {
  if (!link) {
    return { valid: false, status: 404, reason: 'ไม่พบลิงก์แชร์นี้ หรือลิงก์ถูกยกเลิกไปแล้ว' };
  }
  if (link.expires_at && Date.now() > new Date(link.expires_at).getTime()) {
    return { valid: false, status: 410, reason: 'ลิงก์แชร์นี้หมดอายุแล้ว (Expired)' };
  }
  if (link.max_downloads > 0 && link.download_count >= link.max_downloads) {
    return {
      valid: false,
      status: 410,
      reason: `ลิงก์นี้ถูกดาวน์โหลดครบจำนวนสูงสุดที่กำหนดแล้ว (${link.max_downloads} ครั้ง)`,
    };
  }

  const { fullPath } = resolveSafePath(link.storage_rel_path, getFilesRoot());
  if (!fs.existsSync(fullPath)) {
    return { valid: false, status: 404, reason: 'ไฟล์ต้นฉบับถูกลบหรือย้ายออกจาก NAS ไปแล้ว' };
  }

  return { valid: true, fullPath };
}

const server = http.createServer(async (req, res) => {
  try {
    // DNS Rebinding Defense: reject unrecognized external hosts
    if (!isAllowedHost(req.headers.host)) {
      sendJson(res, 400, { error: 'คำขอถูกปฏิเสธ: Host header ไม่ถูกต้อง (DNS Rebinding Defense)' });
      return;
    }

    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;
    const method = req.method;

    // Phase 4: WebDAV Server (/webdav and /webdav/*)
    if (pathname === WEBDAV_PREFIX || pathname.startsWith(`${WEBDAV_PREFIX}/`)) {
      await handleWebdavRequest(req, res, urlObj);
      return;
    }

    // Serve static frontend files (including /s/:token public share page)
    if (!pathname.startsWith('/api/')) {
      serveStaticFile(req, res, pathname);
      return;
    }

    // CSRF Defense: check origin/referer on state-mutating API calls
    if (!validateOriginOrReferer(req)) {
      sendJson(res, 403, { error: 'คำขอข้ามโดเมนถูกปฏิเสธ (CSRF Protection)' });
      return;
    }

    // ================= PUBLIC SHARE APIs (NO LOGIN REQUIRED) =================
    if (pathname.startsWith('/api/public/share/')) {
      const rest = pathname.slice('/api/public/share/'.length);
      const parts = rest.split('/');
      const token = decodeURIComponent(parts[0] || '');
      const action = parts[1] || '';

      const link = getShareLinkById(token);
      const check = validateShareLinkState(link);
      if (!check.valid) {
        sendJson(res, check.status, { error: check.reason });
        return;
      }

      const stat = fs.statSync(check.fullPath);
      const isDir = stat.isDirectory();
      const size = isDir ? getDirectorySizeSync(check.fullPath).totalSize : stat.size;
      const meta = getFileMetadata(link.item_name, isDir);

      // GET /api/public/share/:token -> Public Info
      if (!action && method === 'GET') {
        sendJson(res, 200, {
          share: {
            id: link.id,
            itemName: link.item_name,
            isDirectory: isDir,
            size,
            category: meta.category,
            extension: meta.extension,
            ownerUsername: link.owner_username,
            hasPassword: Boolean(link.password_hash),
            expiresAt: link.expires_at,
            maxDownloads: link.max_downloads,
            downloadCount: link.download_count,
            createdAt: link.created_at,
          },
        });
        return;
      }

      // POST /api/public/share/:token/verify -> Check Password
      if (action === 'verify' && method === 'POST') {
        const clientIp = getClientIp(req);
        const lockKey = `${clientIp}:share:${token}`;
        const lock = checkPublicVerifyLock(lockKey);
        if (lock.locked) {
          sendJson(res, 429, {
            error: `คุณใส่รหัสผ่านผิดเกินกำหนด (${PUBLIC_VERIFY_MAX_ATTEMPTS} ครั้ง) กรุณารออีก ${lock.remainingSeconds} วินาที`,
            locked: true,
            remainingSeconds: lock.remainingSeconds,
          });
          return;
        }

        const body = await readJsonBody(req);
        const password = String(body.password || '');
        if (link.password_hash && !verifyPassword(password, link.password_hash)) {
          const fail = recordFailedPublicVerify(lockKey);
          sendJson(res, 401, {
            error: `รหัสผ่านสำหรับเปิดลิงก์ไม่ถูกต้อง (พยายามผิด ${fail.attempts}/${fail.maxAttempts} ครั้ง)`,
            locked: fail.locked,
            remainingSeconds: fail.remainingSeconds,
          });
          return;
        }
        clearPublicVerifyAttempts(lockKey);
        sendJson(res, 200, { verified: true });
        return;
      }

      // GET /api/public/share/:token/download -> Stream File or Folder ZIP
      if (action === 'download' && method === 'GET') {
        const password = urlObj.searchParams.get('password') || '';
        const inline = urlObj.searchParams.get('inline') === '1';

        if (link.password_hash) {
          const clientIp = getClientIp(req);
          const lockKey = `${clientIp}:share:${token}`;
          const lock = checkPublicVerifyLock(lockKey);
          if (lock.locked) {
            sendJson(res, 429, {
              error: `คุณใส่รหัสผ่านผิดเกินกำหนด (${PUBLIC_VERIFY_MAX_ATTEMPTS} ครั้ง) กรุณารออีก ${lock.remainingSeconds} วินาที`,
              locked: true,
              remainingSeconds: lock.remainingSeconds,
            });
            return;
          }
          if (!verifyPassword(password, link.password_hash)) {
            const fail = recordFailedPublicVerify(lockKey);
            sendJson(res, 401, {
              error: `กรุณาระบุรหัสผ่านที่ถูกต้องเพื่อดาวน์โหลดไฟล์ (พยายามผิด ${fail.attempts}/${fail.maxAttempts} ครั้ง)`,
              locked: fail.locked,
              remainingSeconds: fail.remainingSeconds,
            });
            return;
          }
          clearPublicVerifyAttempts(lockKey);
        }

        // Only increment download count on initial download (not mid-stream HTTP range requests)
        const rangeHeader = req.headers.range || '';
        const isSubsequentRange =
          rangeHeader && !rangeHeader.startsWith('bytes=0-');
        if (!isSubsequentRange) {
          incrementShareDownloadCount(link.id);
        }

        if (isDir) {
          const zipName = `${link.item_name}.zip`;
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`,
            'Cache-Control': 'no-store',
          });
          await streamZipArchive([check.fullPath], res);
          return;
        }

        streamSingleFileWithRange(req, res, check.fullPath, inline);
        return;
      }
    }

    // ================= PUBLIC FILE DROP REQUEST APIs (NO LOGIN REQUIRED - PHASE 6) =================
    if (pathname.startsWith('/api/public/drop/')) {
      const rest = pathname.slice('/api/public/drop/'.length);
      const parts = rest.split('/');
      const token = decodeURIComponent(parts[0] || '');
      const action = parts[1] || '';

      const reqRec = getFileRequestById(token);
      const check = validateFileDropState(reqRec);
      if (!check.valid) {
        sendJson(res, check.status, { error: check.reason });
        return;
      }

      if (!action && method === 'GET') {
        sendJson(res, 200, {
          dropRequest: {
            id: reqRec.id,
            title: reqRec.title,
            folderName: reqRec.folder_name,
            ownerUsername: reqRec.owner_username,
            hasPassword: Boolean(reqRec.password_hash),
            expiresAt: reqRec.expires_at,
            uploadCount: reqRec.upload_count,
          },
        });
        return;
      }

      if (action === 'verify' && method === 'POST') {
        const clientIp = getClientIp(req);
        const lockKey = `${clientIp}:drop:${token}`;
        const lock = checkPublicVerifyLock(lockKey);
        if (lock.locked) {
          sendJson(res, 429, {
            error: `คุณใส่รหัสผ่านผิดเกินกำหนด (${PUBLIC_VERIFY_MAX_ATTEMPTS} ครั้ง) กรุณารออีก ${lock.remainingSeconds} วินาที`,
            locked: true,
            remainingSeconds: lock.remainingSeconds,
          });
          return;
        }

        const body = await readJsonBody(req);
        const password = String(body.password || '');
        if (reqRec.password_hash && !verifyPassword(password, reqRec.password_hash)) {
          const fail = recordFailedPublicVerify(lockKey);
          sendJson(res, 401, {
            error: `รหัสผ่านสำหรับส่งไฟล์ไม่ถูกต้อง (พยายามผิด ${fail.attempts}/${fail.maxAttempts} ครั้ง)`,
            locked: fail.locked,
            remainingSeconds: fail.remainingSeconds,
          });
          return;
        }
        clearPublicVerifyAttempts(lockKey);
        sendJson(res, 200, { verified: true });
        return;
      }

      if (action === 'upload' && method === 'POST') {
        const password = urlObj.searchParams.get('password') || '';
        const filename = urlObj.searchParams.get('filename') || '';
        const sender = urlObj.searchParams.get('sender') || 'Guest';

        if (reqRec.password_hash) {
          const clientIp = getClientIp(req);
          const lockKey = `${clientIp}:drop:${token}`;
          const lock = checkPublicVerifyLock(lockKey);
          if (lock.locked) {
            sendJson(res, 429, {
              error: `คุณใส่รหัสผ่านผิดเกินกำหนด (${PUBLIC_VERIFY_MAX_ATTEMPTS} ครั้ง) กรุณารออีก ${lock.remainingSeconds} วินาที`,
              locked: true,
              remainingSeconds: lock.remainingSeconds,
            });
            return;
          }
          if (!verifyPassword(password, reqRec.password_hash)) {
            const fail = recordFailedPublicVerify(lockKey);
            sendJson(res, 401, {
              error: `รหัสผ่านสำหรับส่งไฟล์ไม่ถูกต้อง (พยายามผิด ${fail.attempts}/${fail.maxAttempts} ครั้ง)`,
              locked: fail.locked,
              remainingSeconds: fail.remainingSeconds,
            });
            return;
          }
          clearPublicVerifyAttempts(lockKey);
        }

        logAuditEvent(
          req,
          `Drop:${sender}`,
          'PUBLIC_FILE_DROP',
          reqRec.storage_rel_path,
          `บุคคลภายนอกส่งไฟล์ "${filename}" เข้าโฟลเดอร์ ${reqRec.folder_name}`
        );
        handlePublicDropUpload(req, res, reqRec, filename, sender, sendJson);
        return;
      }
    }

    // ================= AUTH APIs =================
    if (pathname === '/api/auth/login' && method === 'POST') {
      const clientIp = getClientIp(req);
      const lockState = checkIpLockout(clientIp);
      if (lockState.locked) {
        const mins = Math.ceil(lockState.remainingSeconds / 60);
        sendJson(res, 429, {
          error: `IP ของคุณถูกล็อกชั่วคราวเนื่องจากใส่รหัสผ่านผิดเกินกำหนด กรุณารออีกประมาณ ${mins} นาที (${lockState.remainingSeconds} วินาที)`,
          locked: true,
          remainingSeconds: lockState.remainingSeconds,
        });
        return;
      }

      const body = await readJsonBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');

      const user = getUserByUsername(username);
      if (!user || !verifyPassword(password, user.password_hash)) {
        const failInfo = recordFailedLogin(clientIp);
        logAuditEvent(
          req,
          username || 'unknown',
          'LOGIN_FAILED',
          '/api/auth/login',
          `รหัสผ่านไม่ถูกต้อง (ครั้งที่ ${failInfo.attempts}/${failInfo.maxAttempts})`
        );
        sendJson(res, 401, {
          error: failInfo.locked
            ? 'ใส่รหัสผ่านผิดครบ 5 ครั้ง ระบบได้ล็อก IP นี้ชั่วคราวเป็นเวลา 15 นาที'
            : `ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง (พยายามผิด ${failInfo.attempts}/${failInfo.maxAttempts} ครั้ง)`,
        });
        return;
      }

      clearFailedLogin(clientIp);
      logAuditEvent(req, user.username, 'LOGIN_SUCCESS', '/', 'เข้าสู่ระบบสำเร็จ');

      // Ensure user's home folder exists upon login
      getUserRootPath(user);

      const token = createToken(user);
      const quotaStatus = getUserQuotaStatus(user);
      sendJson(
        res,
        200,
        {
          token,
          user: {
            id: user.id,
            username: user.username,
            role: user.role,
            quotaBytes: user.quota_bytes || 0,
            quotaStatus,
          },
        },
        {
          'Set-Cookie': `nas_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`,
        }
      );
      return;
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      sendJson(
        res,
        200,
        { message: 'ออกจากระบบสำเร็จ' },
        {
          'Set-Cookie': 'nas_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
        }
      );
      return;
    }

    // Require authentication for all other /api/* endpoints
    const tokenPayload = extractUserFromRequest(req);
    if (!tokenPayload) {
      sendJson(res, 401, { error: 'กรุณาเข้าสู่ระบบก่อนใช้งาน' });
      return;
    }

    const authUser = getUserById(tokenPayload.sub);
    if (!authUser) {
      sendJson(res, 401, { error: 'ไม่พบบัญชีผู้ใช้ในระบบ' });
      return;
    }

    if (pathname === '/api/auth/me' && method === 'GET') {
      const quotaStatus = getUserQuotaStatus(authUser);
      sendJson(res, 200, {
        user: {
          ...authUser,
          quotaStatus,
        },
      });
      return;
    }

    if (pathname === '/api/auth/password' && method === 'PUT') {
      const body = await readJsonBody(req);
      const currentPassword = String(body.currentPassword || '');
      const newPassword = String(body.newPassword || '');

      if (newPassword.length < 4) {
        sendJson(res, 400, { error: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 4 ตัวอักษร' });
        return;
      }

      const fullUser = getUserByUsername(authUser.username);
      if (!fullUser || !verifyPassword(currentPassword, fullUser.password_hash)) {
        sendJson(res, 400, { error: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
        return;
      }

      updateUserPassword(fullUser.id, hashPassword(newPassword));
      sendJson(res, 200, { message: 'เปลี่ยนรหัสผ่านเรียบร้อยแล้ว' });
      return;
    }

    // System Monitor Stats (with User Quota Status and Storage Config)
    if (pathname === '/api/system/stats' && method === 'GET') {
      const stats = getSystemStats(getStorageRoot(), getFilesRoot(), getTrashRoot());
      stats.userQuota = getUserQuotaStatus(authUser);
      stats.storageConfig = getStorageConfig();
      sendJson(res, 200, stats);
      return;
    }

    // Upload Extension Policy Settings (Admin can modify, anyone can view)
    if (pathname === '/api/settings/upload-policy' && method === 'GET') {
      sendJson(res, 200, { policy: getUploadExtensionPolicy() });
      return;
    }

    if (pathname === '/api/settings/upload-policy' && method === 'PUT') {
      if (authUser.role !== 'admin') {
        sendJson(res, 403, { error: 'เฉพาะผู้ดูแลระบบ (Admin) เท่านั้นที่ตั้งค่านโยบายไฟล์ได้' });
        return;
      }
      const body = await readJsonBody(req);
      const updated = setUploadExtensionPolicy({
        mode: body.mode,
        extensions: body.extensions,
      });
      sendJson(res, 200, {
        message: 'บันทึกนโยบายนามสกุลไฟล์เรียบร้อยแล้ว',
        policy: updated,
      });
      return;
    }

    // ================= STORAGE DIRECTORY & POOL SETTINGS (ADMIN ONLY) =================
    if (pathname === '/api/admin/storage-path' && method === 'GET') {
      if (authUser.role !== 'admin') {
        sendJson(res, 403, { error: 'เฉพาะผู้ดูแลระบบ (Admin) เท่านั้น' });
        return;
      }
      sendJson(res, 200, getStorageConfig());
      return;
    }

    if (pathname === '/api/admin/storage-path/test' && method === 'POST') {
      if (authUser.role !== 'admin') {
        sendJson(res, 403, { error: 'เฉพาะผู้ดูแลระบบ (Admin) เท่านั้น' });
        return;
      }
      const body = await readJsonBody(req);
      const testResult = testStoragePath(body.path);
      sendJson(res, testResult.valid ? 200 : 400, testResult);
      return;
    }

    if (pathname === '/api/admin/storage-path' && method === 'POST') {
      if (authUser.role !== 'admin') {
        sendJson(res, 403, { error: 'เฉพาะผู้ดูแลระบบ (Admin) เท่านั้น' });
        return;
      }
      const body = await readJsonBody(req);
      try {
        const result = setStorageRootPath(body.path, { migrate: Boolean(body.migrate) });
        logAuditEvent(
          authUser.username,
          'STORAGE_PATH_CHANGED',
          `Changed storage root to ${result.currentPath} (migrated: ${result.migrated})`,
          getClientIp(req)
        );
        try {
          rebuildFileIndex(authUser);
        } catch {
          // Non-critical
        }
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, err.statusCode || 500, { error: err.message });
      }
      return;
    }

    if (pathname === '/api/admin/storage-path/reset' && method === 'POST') {
      if (authUser.role !== 'admin') {
        sendJson(res, 403, { error: 'เฉพาะผู้ดูแลระบบ (Admin) เท่านั้น' });
        return;
      }
      try {
        const result = resetStorageRootPath();
        logAuditEvent(
          authUser.username,
          'STORAGE_PATH_RESET',
          `Reset storage root to default (${result.defaultPath})`,
          getClientIp(req)
        );
        try {
          rebuildFileIndex(authUser);
        } catch {
          // Non-critical
        }
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, err.statusCode || 500, { error: err.message });
      }
      return;
    }

    // ================= ADMIN USER MANAGEMENT APIs (PHASE 3) =================
    if (pathname === '/api/users' && method === 'GET') {
      if (authUser.role !== 'admin') {
        sendJson(res, 403, { error: 'เฉพาะผู้ดูแลระบบ (Admin) เท่านั้นที่จัดการผู้ใช้ได้' });
        return;
      }
      const users = listAllUsers().map((u) => {
        const qStatus = getUserQuotaStatus(u);
        return {
          ...u,
          used_bytes: qStatus.usedBytes,
          usage_percent: qStatus.usagePercent,
          file_count: qStatus.fileCount,
          home_folder: u.role === 'admin' ? '/ (Root ทั้งหมด)' : `/Users/${u.username}`,
        };
      });
      sendJson(res, 200, { users });
      return;
    }

    if (pathname === '/api/users' && method === 'POST') {
      if (authUser.role !== 'admin') {
        sendJson(res, 403, { error: 'เฉพาะผู้ดูแลระบบ (Admin) เท่านั้นที่สร้างผู้ใช้ได้' });
        return;
      }
      const body = await readJsonBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const role = body.role === 'admin' ? 'admin' : 'user';
      const quotaGB = Math.max(0, Number(body.quotaGB || 0));
      const quotaBytes = Math.round(quotaGB * 1024 * 1024 * 1024);

      if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
        sendJson(res, 400, {
          error: 'ชื่อผู้ใช้ต้องเป็นภาษาอังกฤษหรือตัวเลข 3-32 ตัวอักษร',
        });
        return;
      }
      if (password.length < 4) {
        sendJson(res, 400, { error: 'รหัสผ่านต้องมีอย่างน้อย 4 ตัวอักษร' });
        return;
      }
      if (getUserByUsername(username)) {
        sendJson(res, 409, { error: 'มีชื่อผู้ใช้นี้อยู่ในระบบแล้ว' });
        return;
      }

      const newUser = createUser({
        username,
        passwordHash: hashPassword(password),
        role,
        quotaBytes,
      });

      // Initialize isolated home folder for new user
      const homeRoot = getUserRootPath(newUser);
      if (role !== 'admin') {
        const welcomeFile = path.join(homeRoot, `Welcome-${username}.md`);
        if (!fs.existsSync(welcomeFile)) {
          fs.writeFileSync(
            welcomeFile,
            `# สวัสดีคุณ ${username}! 👋\n\nนี่คือพื้นที่จัดเก็บข้อมูลส่วนตัวของคุณบน NAS Server\n- โควตาพื้นที่ของคุณ: ${quotaGB > 0 ? quotaGB + ' GB' : 'ไม่จำกัด (Unlimited)'}\n`,
            'utf8'
          );
        }
      }

      sendJson(res, 201, { message: `สร้างบัญชีผู้ใช้ "${username}" สำเร็จ`, user: newUser });
      return;
    }

    if (pathname.startsWith('/api/users/') && method === 'PUT') {
      if (authUser.role !== 'admin') {
        sendJson(res, 403, { error: 'เฉพาะผู้ดูแลระบบ (Admin) เท่านั้นที่แก้ไขผู้ใช้ได้' });
        return;
      }
      const targetUserId = Number(pathname.slice('/api/users/'.length));
      const targetUser = getUserById(targetUserId);
      if (!targetUser) {
        sendJson(res, 404, { error: 'ไม่พบบัญชีผู้ใช้ที่ต้องการแก้ไข' });
        return;
      }

      const body = await readJsonBody(req);
      const role = body.role === 'admin' ? 'admin' : 'user';
      const quotaGB = Math.max(0, Number(body.quotaGB || 0));
      const quotaBytes = Math.round(quotaGB * 1024 * 1024 * 1024);
      const newPassword = String(body.password || '').trim();

      if (targetUser.id === authUser.id && role !== 'admin') {
        sendJson(res, 400, { error: 'ไม่สามารถลดสิทธิ์ Admin ของบัญชีตัวเองได้' });
        return;
      }

      const passwordHash = newPassword.length >= 4 ? hashPassword(newPassword) : null;
      const updated = updateUserByAdmin(targetUserId, { role, quotaBytes, passwordHash });
      sendJson(res, 200, { message: 'อัปเดตข้อมูลผู้ใช้เรียบร้อยแล้ว', user: updated });
      return;
    }

    if (pathname.startsWith('/api/users/') && method === 'DELETE') {
      if (authUser.role !== 'admin') {
        sendJson(res, 403, { error: 'เฉพาะผู้ดูแลระบบ (Admin) เท่านั้นที่ลบผู้ใช้ได้' });
        return;
      }
      const targetUserId = Number(pathname.slice('/api/users/'.length));
      if (targetUserId === authUser.id) {
        sendJson(res, 400, { error: 'ไม่สามารถลบบัญชีของตัวเองขณะใช้งานอยู่ได้' });
        return;
      }
      deleteUserById(targetUserId);
      sendJson(res, 200, { message: 'ลบบัญชีผู้ใช้เรียบร้อยแล้ว' });
      return;
    }

    // ================= SHARE LINKS MANAGEMENT APIs (PHASE 3) =================
    if (pathname === '/api/shares' && method === 'GET') {
      const ownerFilter = authUser.role === 'admin' ? null : authUser.id;
      const links = listShareLinks(ownerFilter);
      sendJson(res, 200, { shares: links });
      return;
    }

    if (pathname === '/api/shares' && method === 'POST') {
      const body = await readJsonBody(req);
      const clientPath = String(body.path || '');
      const password = String(body.password || '').trim();
      const expiresInHours = Number(body.expiresInHours || 0);
      const maxDownloads = Math.max(0, Number(body.maxDownloads || 0));

      const rootDir = getUserRootPath(authUser);
      const { fullPath } = resolveSafePath(clientPath, rootDir);
      if (!fs.existsSync(fullPath)) {
        sendJson(res, 404, { error: 'ไม่พบไฟล์หรือโฟลเดอร์ที่ต้องการแชร์' });
        return;
      }

      const stat = fs.statSync(fullPath);
      const filesRoot = getFilesRoot();
      const storageRelPath =
        fullPath === filesRoot
          ? '/'
          : '/' + path.relative(filesRoot, fullPath).split(path.sep).join('/');

      const shareId = crypto.randomBytes(9).toString('base64url');
      const expiresAt =
        expiresInHours > 0
          ? new Date(Date.now() + expiresInHours * 3600 * 1000).toISOString()
          : null;

      const created = createShareLinkRecord({
        id: shareId,
        owner_id: authUser.id,
        owner_username: authUser.username,
        storage_rel_path: storageRelPath,
        item_name: path.basename(fullPath),
        is_directory: stat.isDirectory(),
        password_hash: password ? hashPassword(password) : null,
        expires_at: expiresAt,
        max_downloads: maxDownloads,
        created_at: new Date().toISOString(),
      });

      logAuditEvent(
        req,
        authUser.username,
        'SHARE_CREATE',
        storageRelPath,
        `สร้างลิงก์แชร์สาธารณะ (/s/${shareId})`
      );

      sendJson(res, 201, {
        message: 'สร้างลิงก์แชร์สาธารณะสำเร็จ',
        share: created,
      });
      return;
    }

    if (pathname.startsWith('/api/shares/') && method === 'DELETE') {
      const shareId = decodeURIComponent(pathname.slice('/api/shares/'.length));
      const existing = getShareLinkById(shareId);
      if (!existing) {
        sendJson(res, 404, { error: 'ไม่พบลิงก์แชร์นี้' });
        return;
      }
      if (authUser.role !== 'admin' && existing.owner_id !== authUser.id) {
        sendJson(res, 403, { error: 'คุณไม่มีสิทธิ์ยกเลิกลิงก์แชร์ของผู้อื่น' });
        return;
      }
      deleteShareLinkById(shareId);
      sendJson(res, 200, { message: 'ยกเลิกลิงก์แชร์เรียบร้อยแล้ว' });
      return;
    }

    // ================= FILE EXPLORER APIs =================
    if (pathname === '/api/files' && method === 'GET') {
      const targetPath = urlObj.searchParams.get('path') || '/';
      const result = listDirectory(targetPath, authUser);
      sendJson(res, 200, result);
      return;
    }

    if (pathname === '/api/files/folders' && method === 'GET') {
      const folders = listAllFolders(authUser);
      sendJson(res, 200, { folders });
      return;
    }

    if (pathname === '/api/files/mkdir' && method === 'POST') {
      const body = await readJsonBody(req);
      const result = createDirectory(body.path || '/', body.name, authUser);
      sendJson(res, 201, { message: 'สร้างโฟลเดอร์สำเร็จ', ...result });
      return;
    }

    if (pathname === '/api/files/rename' && method === 'POST') {
      const body = await readJsonBody(req);
      const result = renameItem(body.path, body.newName, authUser);
      sendJson(res, 200, { message: 'เปลี่ยนชื่อสำเร็จ', ...result });
      return;
    }

    if (pathname === '/api/files/move' && method === 'POST') {
      const body = await readJsonBody(req);
      const paths = Array.isArray(body.paths) ? body.paths : [body.path];
      const result = moveItems(paths, body.targetDir, authUser);
      sendJson(res, 200, { message: 'ย้ายรายการสำเร็จ', ...result });
      return;
    }

    if (pathname === '/api/files/copy' && method === 'POST') {
      const body = await readJsonBody(req);
      const paths = Array.isArray(body.paths) ? body.paths : [body.path];
      const result = copyItems(paths, body.targetDir, authUser);
      sendJson(res, 200, { message: 'คัดลอกรายการสำเร็จ', ...result });
      return;
    }

    if (pathname === '/api/files/trash' && method === 'POST') {
      const body = await readJsonBody(req);
      const paths = Array.isArray(body.paths) ? body.paths : [body.path];
      const results = [];
      for (const p of paths) {
        if (p) {
          const trashed = moveToTrash(p, authUser);
          results.push(trashed);
          logAuditEvent(
            req,
            authUser.username,
            'DELETE_TO_TRASH',
            p,
            `ย้าย "${trashed.original_name}" ไปที่ถังขยะ`
          );
        }
      }
      sendJson(res, 200, { message: 'ย้ายไปที่ถังขยะแล้ว', items: results });
      return;
    }

    // Phase 2: Thumbnail Generator
    if (pathname === '/api/files/thumbnail' && method === 'GET') {
      await handleThumbnailRequest(req, res, urlObj, authUser);
      return;
    }

    // Phase 2: Multi-file / Folder Streaming ZIP Download
    if (pathname === '/api/files/zip' && method === 'GET') {
      await handleZipDownload(req, res, urlObj, authUser);
      return;
    }

    // Phase 2 & 3: Chunked & Resumable Upload Endpoints (with Quota Check)
    if (pathname === '/api/upload/init' && method === 'POST') {
      const body = await readJsonBody(req);
      const sessionInfo = initChunkedUpload({
        targetPath: body.path || '/',
        filename: body.filename,
        totalSize: body.totalSize,
        lastModified: body.lastModified,
        user: authUser,
      });
      if (sessionInfo.completed && sessionInfo.file) {
        logAuditEvent(
          req,
          authUser.username,
          'UPLOAD',
          sessionInfo.file.path,
          `อัปโหลดไฟล์ "${sessionInfo.file.name}" (0 B)`
        );
      }
      sendJson(res, 200, sessionInfo);
      return;
    }

    if (pathname === '/api/upload/chunk' && (method === 'PATCH' || method === 'POST')) {
      handleChunkUploadPatch(req, res, urlObj, authUser);
      return;
    }

    if (pathname === '/api/upload/cancel' && method === 'DELETE') {
      const uploadId = urlObj.searchParams.get('uploadId') || '';
      const result = cancelChunkedUpload(uploadId);
      sendJson(res, 200, result);
      return;
    }

    if (pathname === '/api/files/upload' && method === 'POST') {
      handleStreamUpload(req, res, urlObj, authUser);
      return;
    }

    if (pathname === '/api/files/download' && method === 'GET') {
      const inline = urlObj.searchParams.get('inline') === '1';
      if (!inline && !req.headers.range) {
        logAuditEvent(
          req,
          authUser.username,
          'DOWNLOAD',
          urlObj.searchParams.get('path') || '',
          'ดาวน์โหลดไฟล์'
        );
      }
      handleFileDownloadOrStream(req, res, urlObj, authUser);
      return;
    }

    if (pathname === '/api/files/content' && method === 'GET') {
      const clientPath = urlObj.searchParams.get('path') || '';
      const rootDir = getUserRootPath(authUser);
      const { fullPath, relativePath } = resolveSafePath(clientPath, rootDir);
      if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
        sendJson(res, 404, { error: 'ไม่พบไฟล์ข้อความ' });
        return;
      }
      const stat = fs.statSync(fullPath);
      if (stat.size > 2 * 1024 * 1024) {
        sendJson(res, 400, { error: 'ไฟล์มีขนาดใหญ่เกิน 2MB กรุณาดาวน์โหลดเพื่อเปิดดู' });
        return;
      }
      const content = fs.readFileSync(fullPath, 'utf8');
      sendJson(res, 200, { path: relativePath, content });
      return;
    }

    if (pathname === '/api/files/content' && method === 'PUT') {
      const body = await readJsonBody(req);
      const rootDir = getUserRootPath(authUser);
      const { fullPath, relativePath } = resolveSafePath(body.path || '', rootDir);
      if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
        sendJson(res, 404, { error: 'ไม่พบไฟล์ที่ต้องการบันทึก' });
        return;
      }
      const newBuf = Buffer.from(String(body.content ?? ''), 'utf8');
      assertQuotaAvailable(authUser, newBuf.length);

      // Phase 5: Automatically save previous version snapshot before overwriting!
      saveFileVersionSnapshot(authUser, relativePath);

      fs.writeFileSync(fullPath, newBuf);
      logAuditEvent(
        req,
        authUser.username,
        'FILE_EDIT',
        relativePath,
        `แก้ไขไฟล์ข้อความ (${newBuf.length} bytes) พร้อมเก็บ Snapshot เวอร์ชันเดิม`
      );
      sendJson(res, 200, { message: 'บันทึกไฟล์เรียบร้อยแล้ว (สำรองเวอร์ชันเดิมอัตโนมัติ)', path: relativePath });
      return;
    }

    // Recycle Bin: List Trash
    if (pathname === '/api/trash' && method === 'GET') {
      const usernameFilter = authUser.role === 'admin' ? null : authUser.username;
      const items = listTrashItems(usernameFilter);
      sendJson(res, 200, { items });
      return;
    }

    if (pathname === '/api/trash/restore' && method === 'POST') {
      const body = await readJsonBody(req);
      const result = restoreFromTrash(body.id, authUser);
      sendJson(res, 200, { message: 'กู้คืนไฟล์สำเร็จ', ...result });
      return;
    }

    if (pathname === '/api/trash/empty' && method === 'DELETE') {
      const result = emptyTrash(authUser);
      sendJson(res, 200, { message: 'ล้างถังขยะเรียบร้อยแล้ว', ...result });
      return;
    }

    if (pathname.startsWith('/api/trash/') && method === 'DELETE') {
      const trashId = decodeURIComponent(pathname.slice('/api/trash/'.length));
      const result = deleteTrashPermanently(trashId, authUser);
      sendJson(res, 200, { message: 'ลบไฟล์ถาวรเรียบร้อยแล้ว', ...result });
      return;
    }

    // ================= PHASE 4: GLOBAL INDEXING, SEARCH & DUPLICATES =================
    if (pathname === '/api/index/rebuild' && method === 'POST') {
      const stats = rebuildFileIndex(authUser);
      sendJson(res, 200, { message: 'สแกนและอัปเดตดัชนีไฟล์สำเร็จ', ...stats });
      return;
    }

    if (pathname === '/api/index/search' && method === 'GET') {
      const q = urlObj.searchParams.get('q') || '';
      const category = urlObj.searchParams.get('category') || 'all';
      const items = globalSearchFiles({ query: q, category, user: authUser });
      sendJson(res, 200, { items });
      return;
    }

    if (pathname === '/api/index/duplicates' && method === 'GET') {
      const result = findDuplicateFiles(authUser);
      sendJson(res, 200, result);
      return;
    }

    // ================= PHASE 4: AUTO-BACKUP & SCHEDULED TASKS =================
    if (pathname === '/api/backups' && method === 'GET') {
      sendJson(res, 200, {
        config: getSchedulerConfig(),
        backups: listBackupSnapshots(),
      });
      return;
    }

    if (pathname === '/api/backups/create' && method === 'POST') {
      if (authUser.role !== 'admin') {
        sendJson(res, 403, { error: 'เฉพาะ Admin เท่านั้นที่สร้าง Snapshot ทั้งระบบได้' });
        return;
      }
      const body = await readJsonBody(req);
      const snapshot = await createBackupSnapshot(body.label || 'manual', body.path || '/');
      sendJson(res, 201, { message: 'สร้างไฟล์สำรองข้อมูล (Backup Snapshot) สำเร็จ', snapshot });
      return;
    }

    if (pathname === '/api/backups/config' && method === 'PUT') {
      if (authUser.role !== 'admin') {
        sendJson(res, 403, { error: 'เฉพาะ Admin เท่านั้นที่ตั้งค่าระบบอัตโนมัติได้' });
        return;
      }
      const body = await readJsonBody(req);
      const current = getSchedulerConfig();
      const updated = saveSchedulerConfig({
        ...current,
        autoBackupEnabled: Boolean(body.autoBackupEnabled),
        backupIntervalHours: Math.max(1, Number(body.backupIntervalHours || 24)),
        maxBackupsKeep: Math.max(1, Number(body.maxBackupsKeep || 5)),
        trashRetentionDays: Math.max(1, Number(body.trashRetentionDays || 30)),
      });
      sendJson(res, 200, { message: 'บันทึกการตั้งค่างานอัตโนมัติสำเร็จ', config: updated });
      return;
    }

    if (pathname === '/api/backups/cleanup-trash' && method === 'POST') {
      if (authUser.role !== 'admin') {
        sendJson(res, 403, { error: 'เฉพาะ Admin เท่านั้นที่สั่งล้างถังขยะตามอายุได้' });
        return;
      }
      const result = runAutoTrashCleanup();
      sendJson(res, 200, {
        message: `ตรวจสอบและลบไฟล์เก่าเกิน ${result.retentionDays} วันแล้ว (${result.purgedCount} รายการ)`,
        ...result,
      });
      return;
    }

    if (pathname.startsWith('/api/backups/download/') && method === 'GET') {
      if (authUser.role !== 'admin') {
        sendJson(res, 403, { error: 'เฉพาะ Admin เท่านั้นที่ดาวน์โหลด Backup ได้' });
        return;
      }
      const filename = decodeURIComponent(pathname.slice('/api/backups/download/'.length));
      const fullBackupPath = getBackupFilePath(filename);
      streamSingleFileWithRange(req, res, fullBackupPath, false);
      return;
    }

    if (pathname.startsWith('/api/backups/') && method === 'DELETE') {
      if (authUser.role !== 'admin') {
        sendJson(res, 403, { error: 'เฉพาะ Admin เท่านั้นที่ลบไฟล์ Backup ได้' });
        return;
      }
      const filename = decodeURIComponent(pathname.slice('/api/backups/'.length));
      const result = deleteBackupSnapshot(filename);
      sendJson(res, 200, { message: 'ลบไฟล์ Backup สำเร็จ', ...result });
      return;
    }

    // ================= PHASE 5: SMART & ENTERPRISE NAS FEATURES =================
    // 1. Audit Logs & Brute-force IP Lockout Management
    if (pathname === '/api/audit-logs' && method === 'GET') {
      if (authUser.role !== 'admin') {
        sendJson(res, 403, { error: 'เฉพาะ Admin เท่านั้นที่ดูประวัติระบบ (Audit Logs) ได้' });
        return;
      }
      const limit = Number(urlObj.searchParams.get('limit') || 200);
      sendJson(res, 200, {
        logs: listAuditLogs(limit),
        lockedIps: listLockedIps(),
      });
      return;
    }

    if (pathname === '/api/audit-logs' && method === 'DELETE') {
      if (authUser.role !== 'admin') {
        sendJson(res, 403, { error: 'เฉพาะ Admin เท่านั้นที่ล้างประวัติระบบได้' });
        return;
      }
      clearAuditLogs();
      logAuditEvent(req, authUser.username, 'AUDIT_CLEAR', '/', 'ล้างประวัติ Audit Logs ทั้งหมด');
      sendJson(res, 200, { message: 'ล้างประวัติ Audit Logs เรียบร้อยแล้ว' });
      return;
    }

    if (pathname === '/api/security/unlock-ip' && method === 'POST') {
      if (authUser.role !== 'admin') {
        sendJson(res, 403, { error: 'เฉพาะ Admin เท่านั้นที่ปลดล็อก IP ได้' });
        return;
      }
      const body = await readJsonBody(req);
      const result = unlockIp(body.ip);
      logAuditEvent(
        req,
        authUser.username,
        'SECURITY_UNLOCK_IP',
        body.ip || '',
        `ปลดล็อก IP ${body.ip}`
      );
      sendJson(res, 200, { message: `ปลดล็อก IP ${body.ip} เรียบร้อยแล้ว`, ...result });
      return;
    }

    // 2. Favorites (Starred Files) & Quick File Creator
    if (pathname === '/api/favorites' && method === 'GET') {
      const items = listStarredItems(authUser);
      sendJson(res, 200, { items });
      return;
    }

    if (pathname === '/api/favorites/toggle' && method === 'POST') {
      const body = await readJsonBody(req);
      const result = toggleStarredItem(authUser, body.path || '');
      sendJson(res, 200, {
        message: result.starred ? 'เพิ่มในรายการโปรดแล้ว ⭐' : 'นำออกจากรายการโปรดแล้ว',
        ...result,
      });
      return;
    }

    if (pathname === '/api/files/create-file' && method === 'POST') {
      const body = await readJsonBody(req);
      const created = createBlankTextFile(
        authUser,
        body.path || '/',
        body.filename || '',
        body.content || ''
      );
      logAuditEvent(
        req,
        authUser.username,
        'FILE_CREATE',
        created.path,
        `สร้างไฟล์ข้อความใหม่ "${created.name}"`
      );
      sendJson(res, 201, {
        message: `สร้างไฟล์ "${created.name}" สำเร็จ`,
        file: created,
      });
      return;
    }

    // 3. Photo Gallery & Media Center
    if (pathname === '/api/gallery' && method === 'GET') {
      const filterType = urlObj.searchParams.get('type') || 'all';
      const items = listMediaGalleryItems(authUser, filterType);
      sendJson(res, 200, { items });
      return;
    }

    // 4. Remote URL Downloader (Cloud Fetch)
    if (pathname === '/api/files/fetch-url' && method === 'POST') {
      const body = await readJsonBody(req);
      const downloaded = await downloadRemoteUrlToNas({
        url: body.url || '',
        targetPath: body.path || '/',
        customFilename: body.filename || '',
        user: authUser,
      });
      logAuditEvent(
        req,
        authUser.username,
        'REMOTE_URL_FETCH',
        downloaded.path,
        `ดึงไฟล์จาก URL สำเร็จ "${downloaded.name}" (${downloaded.size} bytes)`
      );
      sendJson(res, 201, {
        message: `ดึงไฟล์ "${downloaded.name}" ลง NAS สำเร็จ`,
        file: downloaded,
      });
      return;
    }

    // 5. File Versioning & Rollback
    if (pathname === '/api/files/versions' && method === 'GET') {
      const clientPath = urlObj.searchParams.get('path') || '';
      const versions = getFileVersionsList(authUser, clientPath);
      sendJson(res, 200, { path: clientPath, versions });
      return;
    }

    if (pathname === '/api/files/versions/snapshot' && method === 'POST') {
      const body = await readJsonBody(req);
      const snap = saveFileVersionSnapshot(authUser, body.path || '');
      if (!snap) {
        sendJson(res, 400, { error: 'ไม่สามารถสร้าง Snapshot เวอร์ชันของไฟล์นี้ได้' });
        return;
      }
      logAuditEvent(
        req,
        authUser.username,
        'VERSION_SNAPSHOT',
        body.path || '',
        `สร้างจุดสำรองเวอร์ชันไฟล์手动 (${snap.size} bytes)`
      );
      sendJson(res, 201, { message: 'บันทึกเวอร์ชันไฟล์ปัจจุบันไว้เรียบร้อยแล้ว', version: snap });
      return;
    }

    if (pathname === '/api/files/versions/restore' && method === 'POST') {
      const body = await readJsonBody(req);
      const restored = restoreFileVersion(authUser, body.versionId || '');
      logAuditEvent(
        req,
        authUser.username,
        'VERSION_RESTORE',
        restored.restoredPath,
        `ย้อนคืนไฟล์กลับไปเป็นเวอร์ชันเมื่อ ${restored.restoredFromCreatedAt}`
      );
      sendJson(res, 200, {
        message: 'ย้อนคืนเวอร์ชันไฟล์ (Rollback) สำเร็จ!',
        ...restored,
      });
      return;
    }

    if (pathname.startsWith('/api/files/versions/') && method === 'DELETE') {
      const versionId = decodeURIComponent(pathname.slice('/api/files/versions/'.length));
      const result = deleteFileVersionById(authUser, versionId);
      sendJson(res, 200, { message: 'ลบเวอร์ชันสำรองเรียบร้อยแล้ว', ...result });
      return;
    }

    // ================= PHASE 6: ULTIMATE NAS POWER FEATURES =================
    // 1. Online Archive Extractor & Compressor
    if (pathname === '/api/files/extract' && method === 'POST') {
      const body = await readJsonBody(req);
      const resData = extractArchiveOnNas(authUser, body.path || '');
      logAuditEvent(
        req,
        authUser.username,
        'ARCHIVE_EXTRACT',
        resData.extractedPath,
        `แตกไฟล์บีบอัดเป็นโฟลเดอร์ "${resData.folderName}"`
      );
      sendJson(res, 200, {
        message: `แตกไฟล์เข้าสู่โฟลเดอร์ "${resData.folderName}" สำเร็จ!`,
        ...resData,
      });
      return;
    }

    if (pathname === '/api/files/compress' && method === 'POST') {
      const body = await readJsonBody(req);
      const paths = Array.isArray(body.paths) ? body.paths : [body.path];
      const compressed = await compressItemsOnNas(
        authUser,
        paths,
        body.targetDir || '/',
        body.archiveName || ''
      );
      logAuditEvent(
        req,
        authUser.username,
        'ARCHIVE_COMPRESS',
        compressed.path,
        `บีบอัดไฟล์เป็น "${compressed.name}" (${compressed.size} bytes)`
      );
      sendJson(res, 201, {
        message: `บีบอัดเป็นไฟล์ "${compressed.name}" บน NAS สำเร็จ!`,
        file: compressed,
      });
      return;
    }

    // 2. File Drop / Upload Request Links Management
    if (pathname === '/api/file-requests' && method === 'GET') {
      const ownerFilter = authUser.role === 'admin' ? null : authUser.id;
      sendJson(res, 200, { requests: listFileRequests(ownerFilter) });
      return;
    }

    if (pathname === '/api/file-requests' && method === 'POST') {
      const body = await readJsonBody(req);
      const created = createFileDropRequest(authUser, {
        clientPath: body.path || '/',
        title: body.title || '',
        password: body.password || '',
        expiresInHours: body.expiresInHours || 0,
      });
      logAuditEvent(
        req,
        authUser.username,
        'FILE_DROP_CREATE',
        created.storage_rel_path,
        `สร้างลิงก์รับฝากไฟล์ (/d/${created.id})`
      );
      sendJson(res, 201, {
        message: 'สร้างลิงก์รับฝากไฟล์ (File Drop Request) สำเร็จ!',
        dropRequest: created,
      });
      return;
    }

    if (pathname.startsWith('/api/file-requests/') && method === 'DELETE') {
      const reqId = decodeURIComponent(pathname.slice('/api/file-requests/'.length));
      const existing = getFileRequestById(reqId);
      if (!existing) {
        sendJson(res, 404, { error: 'ไม่พบลิงก์รับฝากไฟล์นี้' });
        return;
      }
      if (authUser.role !== 'admin' && existing.owner_id !== authUser.id) {
        sendJson(res, 403, { error: 'คุณไม่มีสิทธิ์ลบลิงก์รับฝากไฟล์ของผู้อื่น' });
        return;
      }
      deleteFileRequestById(reqId);
      sendJson(res, 200, { message: 'ปิดลิงก์รับฝากไฟล์เรียบร้อยแล้ว' });
      return;
    }

    // 3. AES-256-GCM File Encryption Vault
    if (pathname === '/api/files/encrypt' && method === 'POST') {
      const body = await readJsonBody(req);
      const encrypted = encryptFileVault(authUser, body.path || '', body.password || '');
      logAuditEvent(
        req,
        authUser.username,
        'VAULT_ENCRYPT',
        encrypted.path,
        `เข้ารหัสไฟล์ AES-256-GCM เป็น "${encrypted.name}"`
      );
      sendJson(res, 200, {
        message: `เข้ารหัสไฟล์เป็น "${encrypted.name}" (AES-256-GCM) สำเร็จ!`,
        file: encrypted,
      });
      return;
    }

    if (pathname === '/api/files/decrypt' && method === 'POST') {
      const body = await readJsonBody(req);
      const decrypted = decryptFileVault(authUser, body.path || '', body.password || '');
      logAuditEvent(
        req,
        authUser.username,
        'VAULT_DECRYPT',
        decrypted.path,
        `ถอดรหัสไฟล์กลับมาเป็น "${decrypted.name}"`
      );
      sendJson(res, 200, {
        message: `ถอดรหัสไฟล์ "${decrypted.name}" สำเร็จ!`,
        file: decrypted,
      });
      return;
    }

    // 4. Color Tags & File Notes
    if (pathname === '/api/tags/set' && method === 'POST') {
      const body = await readJsonBody(req);
      const updated = setFileTagAndNote(
        authUser,
        body.path || '',
        body.color || 'none',
        body.note || ''
      );
      sendJson(res, 200, {
        message: 'บันทึกป้ายกำกับสีและโน้ตเรียบร้อยแล้ว',
        tag: updated,
      });
      return;
    }

    // 5. Deep Storage Analyzer
    if (pathname === '/api/storage/analyze' && method === 'GET') {
      const report = analyzeStorageUsage(authUser);
      sendJson(res, 200, report);
      return;
    }

    // ================= PHASE 7: ECOSYSTEM, MEDIA & COLLABORATION SUITE =================
    // 1. Music Jukebox & Audio Center
    if (pathname === '/api/music' && method === 'GET') {
      const tracks = listAudioTracks(authUser);
      sendJson(res, 200, { tracks });
      return;
    }

    // 2. Cross-Device Clipboard & Snippet Hub
    if (pathname === '/api/clipboard' && method === 'GET') {
      const items = listClipboardItems(authUser);
      sendJson(res, 200, { items });
      return;
    }

    if (pathname === '/api/clipboard' && method === 'POST') {
      const body = await readJsonBody(req);
      const item = createClipboardSnippet(authUser, {
        title: body.title || '',
        content: body.content || '',
        isShared: body.isShared !== false,
      });
      sendJson(res, 201, {
        message: 'เพิ่มข้อความลงกระดานคลิปบอร์ดข้ามเครื่องแล้ว 📋',
        item,
      });
      return;
    }

    if (pathname.startsWith('/api/clipboard/') && method === 'DELETE') {
      const clipId = Number(pathname.slice('/api/clipboard/'.length));
      deleteClipboardItemById(clipId, authUser);
      sendJson(res, 200, { message: 'ลบข้อความออกจากกระดานคลิปบอร์ดแล้ว' });
      return;
    }

    // 3. Smart Batch Rename
    if (pathname === '/api/files/batch-rename' && method === 'POST') {
      const body = await readJsonBody(req);
      const result = batchRenameItems(authUser, body);
      logAuditEvent(
        req,
        authUser.username,
        'BATCH_RENAME',
        statePathOrRoot(body.paths),
        `เปลี่ยนชื่อไฟล์ชุดละ ${result.renamedCount} รายการ`
      );
      sendJson(res, 200, {
        message: `เปลี่ยนชื่อสำเร็จ ${result.renamedCount} รายการ!`,
        ...result,
      });
      return;
    }

    // 4. File Checksum & Integrity Verifier (MD5 / SHA-1 / SHA-256)
    if (pathname === '/api/files/checksum' && method === 'GET') {
      const clientPath = urlObj.searchParams.get('path') || '';
      const hashes = await computeFileChecksums(authUser, clientPath);
      sendJson(res, 200, hashes);
      return;
    }

    // 5. Send to NAS User Inbox
    if (pathname === '/api/inbox/recipients' && method === 'GET') {
      const recipients = listRecipientUsers(authUser);
      sendJson(res, 200, { recipients });
      return;
    }

    if (pathname === '/api/inbox/send' && method === 'POST') {
      const body = await readJsonBody(req);
      const resData = sendItemsToUserInbox(authUser, {
        recipientUsername: body.recipientUsername || '',
        paths: Array.isArray(body.paths) ? body.paths : [body.path],
        message: body.message || '',
      });
      logAuditEvent(
        req,
        authUser.username,
        'INBOX_TRANSFER',
        `/Users/${resData.recipient}/Inbox`,
        `ส่งไฟล์ ${resData.sentCount} รายการให้คุณ ${resData.recipient}`
      );
      sendJson(res, 200, {
        message: `ส่งไฟล์ ${resData.sentCount} รายการเข้าโฟลเดอร์ /Inbox ของคุณ "${resData.recipient}" เรียบร้อยแล้ว! 📨`,
        ...resData,
      });
      return;
    }

    // ================= PHASE 8: SMART WORKSPACE, MEDIA STUDIO & POWER UTILITIES =================
    // 1. Built-in SVG QR Code Generator
    if (pathname === '/api/qr' && method === 'GET') {
      const text = urlObj.searchParams.get('text') || `${req.headers.origin || `http://localhost:${PORT}`}`;
      const svg = generateQrSvg(text);
      sendJson(res, 200, { text, svg });
      return;
    }

    // 2. Full-Text Content Search / Grep
    if (pathname === '/api/index/grep' && method === 'GET') {
      const query = urlObj.searchParams.get('q') || '';
      const caseSensitive = urlObj.searchParams.get('caseSensitive') === '1';
      const grepReport = searchFileContents(authUser, { query, caseSensitive });
      sendJson(res, 200, grepReport);
      return;
    }

    // 3. Built-in Image Studio & Metadata Inspector
    if (pathname === '/api/files/image-info' && method === 'GET') {
      const clientPath = urlObj.searchParams.get('path') || '';
      const info = inspectImageMetadata(authUser, clientPath);
      sendJson(res, 200, info);
      return;
    }

    if (pathname === '/api/files/image-studio' && method === 'POST') {
      const body = await readJsonBody(req);
      const resImg = transformImageOnNas(authUser, body);
      logAuditEvent(
        req,
        authUser.username,
        'IMAGE_STUDIO',
        resImg.outputPath,
        `ปรับแต่ง/แปลงไฟล์ภาพ "${resImg.outputName}"`
      );
      sendJson(res, 200, {
        message: `บันทึกไฟล์ภาพ "${resImg.outputName}" สำเร็จ! 🖼️`,
        ...resImg,
      });
      return;
    }

    // 4. Kanban Task & Project Board
    if (pathname === '/api/kanban' && method === 'GET') {
      const tasks = listKanbanCards();
      sendJson(res, 200, { tasks });
      return;
    }

    if (pathname === '/api/kanban' && method === 'POST') {
      const body = await readJsonBody(req);
      const task = createKanbanCard(authUser, {
        title: body.title || '',
        description: body.description || '',
        status: body.status || 'todo',
        priority: body.priority || 'normal',
        linkedPath: body.linkedPath || '',
      });
      sendJson(res, 201, {
        message: `เพิ่มการ์ดงาน "${task.title}" ลงกระดาน Kanban แล้ว 📌`,
        task,
      });
      return;
    }

    if (pathname.startsWith('/api/kanban/') && method === 'PUT') {
      const taskId = Number(pathname.slice('/api/kanban/'.length));
      const body = await readJsonBody(req);
      const updated = updateKanbanCard(taskId, {
        title: body.title,
        description: body.description,
        status: body.status,
        priority: body.priority,
        linked_path: body.linkedPath,
      });
      sendJson(res, 200, {
        message: 'อัปเดตสถานะงานเรียบร้อยแล้ว',
        task: updated,
      });
      return;
    }

    if (pathname.startsWith('/api/kanban/') && method === 'DELETE') {
      const taskId = Number(pathname.slice('/api/kanban/'.length));
      deleteKanbanCard(taskId);
      sendJson(res, 200, { message: 'ลบการ์ดงานออกจากกระดานแล้ว' });
      return;
    }

    // ================= PHASE 9: PRO UX, RECENT FILES, LIVE PROCESSES & LOCK SCREEN =================
    if (pathname === '/api/files/recent' && method === 'GET') {
      const limit = Number(urlObj.searchParams.get('limit') || 8);
      const items = getRecentFiles(authUser, limit);
      sendJson(res, 200, { items });
      return;
    }

    if (pathname === '/api/system/processes' && method === 'GET') {
      const limit = Number(urlObj.searchParams.get('limit') || 10);
      const report = getTopSystemProcesses(limit);
      sendJson(res, 200, report);
      return;
    }

    sendJson(res, 404, { error: 'ไม่พบ API Endpoint ที่เรียกใช้งาน' });
  } catch (err) {
    const statusCode = err.statusCode || 500;
    sendJson(res, statusCode, { error: err.message || 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์' });
  }
});

// Prevent Node.js HTTP server timeouts from aborting large file uploads / streams over LAN
server.requestTimeout = 0;
server.headersTimeout = 120000;
server.keepAliveTimeout = 65000;
server.timeout = 300000; // 5-minute socket inactivity timeout to avoid zombie/hung connections

server.on('connection', (socket) => {
  socket.setKeepAlive(true, 10000); // 10s TCP keep-alive probe to prevent Wi-Fi/router disconnects
});

function statePathOrRoot(paths) {
  if (Array.isArray(paths) && paths.length > 0) return String(paths[0]);
  return '/';
}

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    const lans = getLanAddresses();
    console.log('\n======================================================');
    console.log('🚀 Personal NAS Server (Phase 1–8 ครบสมบูรณ์) พร้อมใช้งานแล้ว!');
    console.log('======================================================');
    console.log(`🏠 เข้าผ่านเครื่องนี้ (Local):   http://localhost:${PORT}`);
    for (const lan of lans) {
      console.log(`🌐 เข้าผ่านวง LAN (${lan.interface}): http://${lan.address}:${PORT}`);
    }
    console.log(`💿 ต่อเป็น Drive (WebDAV):     http://localhost:${PORT}/webdav/`);
    console.log(`🔑 บัญชีเริ่มต้น:             admin / admin123`);
    console.log(`📂 โฟลเดอร์เก็บไฟล์จริง:       ${getFilesRoot()}`);
    console.log('======================================================\n');
  });
}

module.exports = { server };

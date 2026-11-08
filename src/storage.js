const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  getSystemSetting,
  setSystemSetting,
  getUploadExtensionPolicy,
  getUserById,
  insertTrashItem,
  listTrashItems,
  getTrashItemById,
  deleteTrashItemRecord,
  clearAllTrashRecords,
  getUploadSessionByFingerprint,
  getUploadSessionById,
  createUploadSession,
  updateUploadSessionProgress,
  deleteUploadSession,
  getFavoritePathsSet,
  listFileVersions,
  getFileTagsMap,
} = require('./db');
const { getDirectorySizeSync } = require('./system');

const DEFAULT_STORAGE_ROOT = path.resolve(__dirname, '..', 'storage');
let currentStorageRoot = resolveConfiguredStorageRoot();

function resolveConfiguredStorageRoot() {
  if (process.env.STORAGE_PATH && process.env.STORAGE_PATH.trim()) {
    const envPath = path.resolve(process.env.STORAGE_PATH.trim());
    try {
      fs.mkdirSync(envPath, { recursive: true });
      return envPath;
    } catch (err) {
      console.warn(`[Storage] Warning: Failed to use STORAGE_PATH from env (${envPath}):`, err.message);
    }
  }

  try {
    const dbPath = getSystemSetting('storage_root_path');
    if (dbPath && dbPath.trim()) {
      const customPath = path.resolve(dbPath.trim());
      try {
        fs.mkdirSync(customPath, { recursive: true });
        return customPath;
      } catch (err) {
        console.warn(`[Storage] Warning: Custom storage path (${customPath}) is not accessible:`, err.message);
      }
    }
  } catch (err) {
    // Database might not be initialized yet
  }

  return DEFAULT_STORAGE_ROOT;
}

function getStorageRoot() {
  return currentStorageRoot;
}

function getFilesRoot() {
  return path.join(currentStorageRoot, 'files');
}

function getUsersHomeRoot() {
  return path.join(currentStorageRoot, 'files', 'Users');
}

function getTrashRoot() {
  return path.join(currentStorageRoot, 'trash');
}

function getUploadsTmpDir() {
  return path.join(currentStorageRoot, '.cache', 'uploads');
}

function getDefaultStorageRoot() {
  return DEFAULT_STORAGE_ROOT;
}

function isCustomStorageRoot() {
  return currentStorageRoot !== DEFAULT_STORAGE_ROOT;
}

function getStorageConfig() {
  let diskInfo = null;
  try {
    const statfs = fs.statfsSync(currentStorageRoot);
    const totalBytes = statfs.blocks * statfs.bsize;
    const freeBytes = statfs.bavail * statfs.bsize;
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const usagePercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0;
    diskInfo = { totalBytes, freeBytes, usedBytes, usagePercent };
  } catch {
    // Fallback if statfsSync fails
  }

  return {
    currentPath: currentStorageRoot,
    defaultPath: DEFAULT_STORAGE_ROOT,
    isCustom: currentStorageRoot !== DEFAULT_STORAGE_ROOT,
    envOverride: Boolean(process.env.STORAGE_PATH && process.env.STORAGE_PATH.trim()),
    diskInfo,
  };
}

function testStoragePath(candidatePath) {
  if (!candidatePath || typeof candidatePath !== 'string' || !candidatePath.trim()) {
    return { valid: false, error: 'กรุณาระบุเส้นทางโฟลเดอร์ (Path)' };
  }
  const rawPath = candidatePath.trim();
  if (!path.isAbsolute(rawPath)) {
    return { valid: false, error: 'ต้องระบุเส้นทางแบบเต็ม (Absolute Path) เช่น /Volumes/ExternalDrive/NAS_Storage หรือ /Users/.../Storage' };
  }
  const resolved = path.resolve(rawPath);

  // Check if directory exists or can be created
  try {
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true });
    }
  } catch (err) {
    return { valid: false, error: `ไม่สามารถสร้างหรือเข้าถึงโฟลเดอร์ได้: ${err.message}` };
  }

  // Check write permission by creating a test file
  const testFile = path.join(resolved, `.nas_perm_test_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.writeFileSync(testFile, 'nas-test-ok', 'utf8');
    fs.unlinkSync(testFile);
  } catch (err) {
    return { valid: false, error: `ไม่สามารถเขียนไฟล์ลงในโฟลเดอร์นี้ได้ (อาจติด Permission หรือ Write-Protected): ${err.message}` };
  }

  // Check disk space via statfsSync
  let diskInfo = null;
  try {
    const statfs = fs.statfsSync(resolved);
    const totalBytes = statfs.blocks * statfs.bsize;
    const freeBytes = statfs.bavail * statfs.bsize;
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const usagePercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0;
    diskInfo = { totalBytes, freeBytes, usedBytes, usagePercent };
  } catch {
    // statfsSync might fail on some special mounts
  }

  return {
    valid: true,
    resolvedPath: resolved,
    isDefault: resolved === DEFAULT_STORAGE_ROOT,
    diskInfo,
  };
}

function copyFolderRecursiveSync(source, target) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(target, { recursive: true });
  const entries = fs.readdirSync(source, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(source, entry.name);
    const destPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyFolderRecursiveSync(srcPath, destPath);
    } else if (entry.isFile()) {
      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}

function setStorageRootPath(newPath, { migrate = false } = {}) {
  const testRes = testStoragePath(newPath);
  if (!testRes.valid) {
    const err = new Error(testRes.error);
    err.statusCode = 400;
    throw err;
  }

  const targetPath = testRes.resolvedPath;
  const oldStorageRoot = currentStorageRoot;

  // Initialize directory structure in target location
  initStorageDirectories(targetPath);

  // If user requested migration, copy files from old to new
  if (migrate && oldStorageRoot !== targetPath) {
    const oldFiles = path.join(oldStorageRoot, 'files');
    const newFiles = path.join(targetPath, 'files');
    if (fs.existsSync(oldFiles)) {
      copyFolderRecursiveSync(oldFiles, newFiles);
    }
  }

  // Persist to database
  setSystemSetting('storage_root_path', targetPath);
  currentStorageRoot = targetPath;

  return {
    success: true,
    currentPath: currentStorageRoot,
    defaultPath: DEFAULT_STORAGE_ROOT,
    isCustom: currentStorageRoot !== DEFAULT_STORAGE_ROOT,
    diskInfo: testRes.diskInfo,
    migrated: Boolean(migrate),
  };
}

function resetStorageRootPath() {
  setSystemSetting('storage_root_path', null);
  currentStorageRoot = DEFAULT_STORAGE_ROOT;
  initStorageDirectories(DEFAULT_STORAGE_ROOT);
  return {
    success: true,
    currentPath: currentStorageRoot,
    defaultPath: DEFAULT_STORAGE_ROOT,
    isCustom: false,
  };
}

function initStorageDirectories(targetRoot = currentStorageRoot) {
  const filesRoot = path.join(targetRoot, 'files');
  const usersHomeRoot = path.join(filesRoot, 'Users');
  const trashRoot = path.join(targetRoot, 'trash');
  const uploadsTmpDir = path.join(targetRoot, '.cache', 'uploads');
  const versionsDir = path.join(targetRoot, '.cache', 'versions');
  const backupsDir = path.join(targetRoot, 'backups');

  fs.mkdirSync(filesRoot, { recursive: true });
  fs.mkdirSync(usersHomeRoot, { recursive: true });
  fs.mkdirSync(trashRoot, { recursive: true });
  fs.mkdirSync(uploadsTmpDir, { recursive: true });
  fs.mkdirSync(versionsDir, { recursive: true });
  fs.mkdirSync(backupsDir, { recursive: true });

  const existing = fs.readdirSync(filesRoot).filter((n) => !n.startsWith('.') && n !== 'Users');
  if (existing.length === 0) {
    fs.mkdirSync(path.join(filesRoot, 'Documents'), { recursive: true });
    fs.mkdirSync(path.join(filesRoot, 'Photos'), { recursive: true });
    fs.mkdirSync(path.join(filesRoot, 'Videos'), { recursive: true });
    fs.mkdirSync(path.join(filesRoot, 'Shared'), { recursive: true });
    fs.writeFileSync(
      path.join(filesRoot, 'Welcome-to-NAS.md'),
      `# ยินดีต้อนรับสู่ Personal NAS Server ของคุณ! 🎉\n\nไฟล์นี้ถูกสร้างขึ้นอัตโนมัติในโฟลเดอร์ \`${targetRoot}/files/\`\n\n## ความสามารถครบทั้ง Phase 1, 2 และ 3:\n- **Multi-user & Home Isolation:** แอดมินสร้างบัญชีผู้ใช้แยกโฟลเดอร์ส่วนตัว (\`files/Users/{username}\`) และกำหนด **Storage Quota** รายคนได้\n- **Public Share Links:** สร้างลิงก์แชร์ไฟล์/โฟลเดอร์สาธารณะ ตั้งรหัสผ่าน วันหมดอายุ และจำกัดจำนวนครั้งดาวน์โหลดได้\n- **Chunked & Resumable Upload:** รองรับไฟล์ขนาดใหญ่ กดพัก/ทำต่อได้\n- **Thumbnail Generator & Streaming ZIP:** แสดงภาพตัวอย่างอัตโนมัติ และบีบอัดไฟล์ \`.zip\` แบบ Stream on-the-fly\n`,
      'utf8'
    );
  }
}

initStorageDirectories();

/**
 * Returns the sandboxed root directory for a given user.
 * - Admin accesses the entire FILES_ROOT
 * - Regular users are isolated to FILES_ROOT/Users/<username>
 */
function getUserRootPath(user) {
  const filesRoot = getFilesRoot();
  if (!user || user.role === 'admin') {
    return filesRoot;
  }
  const safeUsername = String(user.username || 'guest').replace(/[^a-zA-Z0-9._-]/g, '_');
  const userHome = path.join(getUsersHomeRoot(), safeUsername);
  if (!fs.existsSync(userHome)) {
    fs.mkdirSync(userHome, { recursive: true });
  }
  return userHome;
}

function getUserQuotaStatus(user) {
  const userId = user?.id || user?.sub;
  const dbUser = userId ? getUserById(userId) : null;
  const quotaBytes = dbUser ? Number(dbUser.quota_bytes || 0) : 0;
  const rootDir = getUserRootPath(dbUser || user);
  const stats = getDirectorySizeSync(rootDir);
  const usedBytes = stats.totalSize;
  const usagePercent =
    quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 1000) / 10) : 0;

  return {
    usedBytes,
    quotaBytes,
    usagePercent,
    fileCount: stats.fileCount,
    folderCount: stats.folderCount,
  };
}

function assertQuotaAvailable(user, additionalBytes = 0) {
  const userId = user?.id || user?.sub;
  const dbUser = userId ? getUserById(userId) : null;
  const quotaBytes = dbUser ? Number(dbUser.quota_bytes || 0) : 0;

  // Fast path: if user has unlimited quota (0), skip full directory tree scan!
  if (quotaBytes <= 0) {
    return { usedBytes: 0, quotaBytes: 0, usagePercent: 0 };
  }

  const status = getUserQuotaStatus(dbUser || user);
  if (status.usedBytes + additionalBytes > status.quotaBytes) {
    const quotaGB = (status.quotaBytes / (1024 * 1024 * 1024)).toFixed(2);
    const err = new Error(
      `พื้นที่จัดเก็บข้อมูลของคุณเต็มเกินโควตาที่กำหนด (โควตาสูงสุด ${quotaGB} GB)`
    );
    err.statusCode = 413;
    throw err;
  }
  return status;
}

function assertExtensionAllowed(filename) {
  const policy = getUploadExtensionPolicy();
  if (!policy || policy.mode === 'allow_all') return true;

  const ext = path.extname(String(filename || '')).toLowerCase();
  const list = Array.isArray(policy.extensions) ? policy.extensions : [];

  if (policy.mode === 'blocklist' && ext && list.includes(ext)) {
    const err = new Error(
      `ไม่อนุญาตให้อัปโหลดไฟล์นามสกุล "${ext}" ตามนโยบายความปลอดภัยของเซิร์ฟเวอร์ (Blocklist)`
    );
    err.statusCode = 403;
    throw err;
  }

  if (policy.mode === 'allowlist' && (!ext || !list.includes(ext))) {
    const err = new Error(
      `เซิร์ฟเวอร์อนุญาตเฉพาะไฟล์นามสกุล: ${list.join(', ')} เท่านั้น (Allowlist)`
    );
    err.statusCode = 403;
    throw err;
  }

  return true;
}

/**
 * Safely resolves a relative client path inside rootDir, preventing Path Traversal (../)
 */
function resolveSafePath(relativePath = '', rootDir = null) {
  const targetRoot = rootDir || getFilesRoot();
  const normalizedRel = String(relativePath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  const resolved = path.resolve(targetRoot, normalizedRel);
  const rootWithSep = targetRoot.endsWith(path.sep) ? targetRoot : targetRoot + path.sep;

  if (resolved !== targetRoot && !resolved.startsWith(rootWithSep)) {
    const err = new Error('ไม่อนุญาตให้เข้าถึงไฟล์นอกพื้นที่จัดเก็บของคุณ (Path Traversal Blocked)');
    err.statusCode = 403;
    throw err;
  }

  // Security: Canonical Symlink Traversal Protection
  try {
    if (fs.existsSync(resolved)) {
      const realTarget = fs.realpathSync(resolved);
      const realRoot = fs.existsSync(targetRoot) ? fs.realpathSync(targetRoot) : targetRoot;
      const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
      if (realTarget !== realRoot && !realTarget.startsWith(realRootWithSep)) {
        const err = new Error('ไม่อนุญาตให้เข้าถึง Symbolic Link ที่ชี้ออกนอกพื้นที่จัดเก็บ (Symlink Traversal Blocked)');
        err.statusCode = 403;
        throw err;
      }
    } else {
      let cur = path.dirname(resolved);
      while (cur && cur !== targetRoot && !fs.existsSync(cur)) {
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
      if (fs.existsSync(cur)) {
        const realAncestor = fs.realpathSync(cur);
        const realRoot = fs.existsSync(targetRoot) ? fs.realpathSync(targetRoot) : targetRoot;
        const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
        if (realAncestor !== realRoot && !realAncestor.startsWith(realRootWithSep)) {
          const err = new Error('ไม่อนุญาตให้สร้างไฟล์ผ่าน Symbolic Link ที่ชี้ออกนอกพื้นที่จัดเก็บ (Symlink Traversal Blocked)');
          err.statusCode = 403;
          throw err;
        }
      }
    }
  } catch (err) {
    if (err.statusCode === 403) throw err;
  }

  const normalizedClientPath =
    resolved === targetRoot
      ? '/'
      : '/' + path.relative(targetRoot, resolved).split(path.sep).join('/');

  return {
    fullPath: resolved,
    relativePath: normalizedClientPath,
  };
}

const MIME_MAP = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
};

function getFileMetadata(filename, isDirectory) {
  if (isDirectory) {
    return { category: 'folder', mimeType: 'inode/directory', extension: '' };
  }
  const ext = path.extname(filename).toLowerCase();
  const mimeType = MIME_MAP[ext] || 'application/octet-stream';

  let category = 'other';
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico'].includes(ext)) {
    category = 'image';
  } else if (['.mp4', '.webm', '.ogg', '.mov', '.mkv'].includes(ext)) {
    category = 'video';
  } else if (['.mp3', '.wav', '.flac', '.m4a'].includes(ext)) {
    category = 'audio';
  } else if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'].includes(ext)) {
    category = 'document';
  } else if (
    ['.txt', '.md', '.json', '.js', '.ts', '.py', '.html', '.css', '.csv', '.xml', '.yml', '.yaml', '.sh', '.log'].includes(
      ext
    )
  ) {
    category = 'text';
  } else if (['.zip', '.tar', '.gz', '.7z', '.rar'].includes(ext)) {
    category = 'archive';
  }

  return { category, mimeType, extension: ext };
}

function listDirectory(clientPath = '/', user = null) {
  const rootDir = getUserRootPath(user);
  const { fullPath, relativePath } = resolveSafePath(clientPath, rootDir);

  if (!fs.existsSync(fullPath)) {
    const err = new Error('ไม่พบโฟลเดอร์ที่ระบุ');
    err.statusCode = 404;
    throw err;
  }

  const stat = fs.statSync(fullPath);
  if (!stat.isDirectory()) {
    const err = new Error('Path ที่ระบุไม่ใช่โฟลเดอร์');
    err.statusCode = 400;
    throw err;
  }

  const favSet = user?.id ? getFavoritePathsSet(user.id) : new Set();
  const tagsMap = user?.id ? getFileTagsMap(user.id) : new Map();
  const scopeRoot = rootDir === getFilesRoot() ? 'ROOT' : `USER:${user?.username || 'guest'}`;

  const entries = fs.readdirSync(fullPath, { withFileTypes: true });
  const items = [];

  for (const entry of entries) {
    if (entry.name === '.DS_Store' || entry.name === '.gitkeep') continue;

    const itemFullPath = path.join(fullPath, entry.name);
    let itemStat;
    try {
      itemStat = fs.statSync(itemFullPath);
    } catch {
      continue;
    }

    const isDirectory = entry.isDirectory();
    const itemRelPath =
      relativePath === '/' ? `/${entry.name}` : `${relativePath}/${entry.name}`;
    const meta = getFileMetadata(entry.name, isDirectory);

    let childCount = null;
    if (isDirectory) {
      try {
        childCount = fs
          .readdirSync(itemFullPath)
          .filter((n) => n !== '.DS_Store' && n !== '.gitkeep').length;
      } catch {
        childCount = 0;
      }
    }

    const versionCount = isDirectory
      ? 0
      : listFileVersions(scopeRoot, itemRelPath).length;
    const tagInfo = tagsMap.get(itemRelPath) || { color: 'none', note: '' };
    const lowerName = entry.name.toLowerCase();
    const isExtractable =
      !isDirectory &&
      (lowerName.endsWith('.zip') ||
        lowerName.endsWith('.tar') ||
        lowerName.endsWith('.tar.gz') ||
        lowerName.endsWith('.tgz'));

    items.push({
      name: entry.name,
      path: itemRelPath,
      isDirectory,
      size: isDirectory ? 0 : itemStat.size,
      childCount,
      modifiedAt: itemStat.mtime.toISOString(),
      createdAt: itemStat.birthtime.toISOString(),
      category: meta.category,
      mimeType: meta.mimeType,
      extension: meta.extension,
      hasThumbnail: meta.category === 'image' || meta.category === 'video',
      isStarred: favSet.has(itemRelPath),
      versionCount,
      tagColor: tagInfo.color,
      tagNote: tagInfo.note,
      isVault: !isDirectory && lowerName.endsWith('.vault'),
      isExtractable,
    });
  }

  items.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name, 'th');
  });

  return {
    currentPath: relativePath,
    items,
  };
}

function listAllFolders(user = null) {
  const rootDir = getUserRootPath(user);
  const folders = ['/'];
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
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const nextRel = `${curr.rel}/${entry.name}`;
        folders.push(nextRel);
        stack.push({ full: path.join(curr.full, entry.name), rel: nextRel });
      }
    }
  }

  return folders.sort((a, b) => a.localeCompare(b, 'th'));
}

function createDirectory(parentClientPath, folderName, user = null) {
  const rootDir = getUserRootPath(user);
  const cleanName = String(folderName || '').trim();
  if (!cleanName || cleanName.includes('/') || cleanName.includes('\\') || cleanName === '.' || cleanName === '..') {
    const err = new Error('ชื่อโฟลเดอร์ไม่ถูกต้อง');
    err.statusCode = 400;
    throw err;
  }

  const { fullPath: parentFull } = resolveSafePath(parentClientPath, rootDir);
  const targetFull = path.join(parentFull, cleanName);
  resolveSafePath(path.relative(rootDir, targetFull), rootDir);

  if (fs.existsSync(targetFull)) {
    const err = new Error('มีไฟล์หรือโฟลเดอร์ชื่อนี้อยู่แล้ว');
    err.statusCode = 409;
    throw err;
  }

  fs.mkdirSync(targetFull, { recursive: false });
  return { name: cleanName };
}

function renameItem(itemClientPath, newName, user = null) {
  const rootDir = getUserRootPath(user);
  const cleanName = String(newName || '').trim();
  if (!cleanName || cleanName.includes('/') || cleanName.includes('\\') || cleanName === '.' || cleanName === '..') {
    const err = new Error('ชื่อใหม่ไม่ถูกต้อง');
    err.statusCode = 400;
    throw err;
  }

  const { fullPath: sourceFull, relativePath } = resolveSafePath(itemClientPath, rootDir);
  if (relativePath === '/') {
    const err = new Error('ไม่สามารถเปลี่ยนชื่อโฟลเดอร์หลักได้');
    err.statusCode = 400;
    throw err;
  }

  if (!fs.existsSync(sourceFull)) {
    const err = new Error('ไม่พบไฟล์หรือโฟลเดอร์ที่ต้องการเปลี่ยนชื่อ');
    err.statusCode = 404;
    throw err;
  }

  const targetFull = path.join(path.dirname(sourceFull), cleanName);
  if (fs.existsSync(targetFull)) {
    const err = new Error('มีไฟล์หรือโฟลเดอร์ชื่อนี้อยู่แล้ว');
    err.statusCode = 409;
    throw err;
  }

  fs.renameSync(sourceFull, targetFull);
  return {
    oldPath: relativePath,
    newName: cleanName,
  };
}

function moveItems(sourceClientPaths, targetDirClientPath, user = null) {
  const rootDir = getUserRootPath(user);
  const { fullPath: targetDirFull, relativePath: targetRel } = resolveSafePath(
    targetDirClientPath,
    rootDir
  );

  if (!fs.existsSync(targetDirFull) || !fs.statSync(targetDirFull).isDirectory()) {
    const err = new Error('ไม่พบโฟลเดอร์ปลายทาง');
    err.statusCode = 404;
    throw err;
  }

  const moved = [];
  for (const srcPath of sourceClientPaths) {
    const { fullPath: srcFull, relativePath: srcRel } = resolveSafePath(srcPath, rootDir);
    if (srcRel === '/' || !fs.existsSync(srcFull)) continue;

    if (targetFullIsInside(targetDirFull, srcFull)) {
      const err = new Error(`ไม่สามารถย้ายโฟลเดอร์ "${path.basename(srcFull)}" เข้าไปในตัวเองได้`);
      err.statusCode = 400;
      throw err;
    }

    if (path.dirname(srcFull) === targetDirFull) {
      continue;
    }

    const { fullPath: destFull, finalName } = getUniqueUploadPath(
      targetDirFull,
      path.basename(srcFull)
    );
    fs.renameSync(srcFull, destFull);
    moved.push({ from: srcRel, to: `${targetRel === '/' ? '' : targetRel}/${finalName}` });
  }

  return { movedCount: moved.length, moved };
}

function copyItems(sourceClientPaths, targetDirClientPath, user = null) {
  const rootDir = getUserRootPath(user);
  const { fullPath: targetDirFull, relativePath: targetRel } = resolveSafePath(
    targetDirClientPath,
    rootDir
  );

  if (!fs.existsSync(targetDirFull) || !fs.statSync(targetDirFull).isDirectory()) {
    const err = new Error('ไม่พบโฟลเดอร์ปลายทาง');
    err.statusCode = 404;
    throw err;
  }

  const copied = [];
  for (const srcPath of sourceClientPaths) {
    const { fullPath: srcFull, relativePath: srcRel } = resolveSafePath(srcPath, rootDir);
    if (srcRel === '/' || !fs.existsSync(srcFull)) continue;

    if (targetFullIsInside(targetDirFull, srcFull)) {
      const err = new Error(`ไม่สามารถคัดลอกโฟลเดอร์ "${path.basename(srcFull)}" เข้าไปในตัวเองได้`);
      err.statusCode = 400;
      throw err;
    }

    const stat = fs.statSync(srcFull);
    const neededBytes = stat.isDirectory()
      ? getDirectorySizeSync(srcFull).totalSize
      : stat.size;
    assertQuotaAvailable(user, neededBytes);

    const { fullPath: destFull, finalName } = getUniqueUploadPath(
      targetDirFull,
      path.basename(srcFull)
    );
    fs.cpSync(srcFull, destFull, { recursive: true });
    copied.push({ from: srcRel, to: `${targetRel === '/' ? '' : targetRel}/${finalName}` });
  }

  return { copiedCount: copied.length, copied };
}

function targetFullIsInside(targetDirFull, srcFull) {
  if (targetDirFull === srcFull) return true;
  const srcWithSep = srcFull.endsWith(path.sep) ? srcFull : srcFull + path.sep;
  return targetDirFull.startsWith(srcWithSep);
}

function moveToTrash(itemClientPath, user = null) {
  const rootDir = getUserRootPath(user);
  const username = user?.username || 'admin';
  const { fullPath: sourceFull, relativePath } = resolveSafePath(itemClientPath, rootDir);
  if (relativePath === '/') {
    const err = new Error('ไม่สามารถลบโฟลเดอร์หลักได้');
    err.statusCode = 400;
    throw err;
  }

  if (!fs.existsSync(sourceFull)) {
    const err = new Error('ไม่พบไฟล์หรือโฟลเดอร์ที่ต้องการลบ');
    err.statusCode = 404;
    throw err;
  }

  const stat = fs.statSync(sourceFull);
  const isDirectory = stat.isDirectory();
  const size = isDirectory ? getDirectorySizeSync(sourceFull).totalSize : stat.size;
  const originalName = path.basename(sourceFull);
  const id = crypto.randomUUID();
  const trashFilename = `${id}_${originalName}`;
  const trashDest = path.join(getTrashRoot(), trashFilename);

  fs.renameSync(sourceFull, trashDest);

  const itemRecord = {
    id,
    original_path: relativePath,
    original_name: originalName,
    trash_filename: trashFilename,
    is_directory: isDirectory,
    size,
    deleted_by: username,
    deleted_at: new Date().toISOString(),
  };

  insertTrashItem(itemRecord);
  return itemRecord;
}

function restoreFromTrash(trashId, user = null) {
  const item = getTrashItemById(trashId);
  if (!item) {
    const err = new Error('ไม่พบรายการนี้ในถังขยะ');
    err.statusCode = 404;
    throw err;
  }

  if (user && user.role !== 'admin' && item.deleted_by !== user.username) {
    const err = new Error('คุณไม่มีสิทธิ์กู้คืนรายการของผู้ใช้อื่น');
    err.statusCode = 403;
    throw err;
  }

  const trashSource = path.join(getTrashRoot(), item.trash_filename);
  if (!fs.existsSync(trashSource)) {
    deleteTrashItemRecord(trashId);
    const err = new Error('ไม่พบไฟล์จริงในถังขยะ ลบข้อมูลรายการออกแล้ว');
    err.statusCode = 404;
    throw err;
  }

  // Restore into the owner's root directory
  const ownerRoot =
    item.deleted_by === 'admin'
      ? getFilesRoot()
      : getUserRootPath({ username: item.deleted_by, role: 'user' });

  const { fullPath: originalFull } = resolveSafePath(item.original_path, ownerRoot);
  const parentDir = path.dirname(originalFull);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  let finalTarget = originalFull;
  if (fs.existsSync(finalTarget)) {
    const ext = path.extname(item.original_name);
    const base = path.basename(item.original_name, ext);
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    finalTarget = path.join(parentDir, `${base} (restored-${timestamp})${ext}`);
  }

  fs.renameSync(trashSource, finalTarget);
  deleteTrashItemRecord(trashId);

  return {
    restoredPath: '/' + path.relative(ownerRoot, finalTarget).split(path.sep).join('/'),
  };
}

function deleteTrashPermanently(trashId, user = null) {
  const item = getTrashItemById(trashId);
  if (!item) {
    const err = new Error('ไม่พบรายการนี้ในถังขยะ');
    err.statusCode = 404;
    throw err;
  }

  if (user && user.role !== 'admin' && item.deleted_by !== user.username) {
    const err = new Error('คุณไม่มีสิทธิ์ลบรายการของผู้ใช้อื่น');
    err.statusCode = 403;
    throw err;
  }

  const trashSource = path.join(getTrashRoot(), item.trash_filename);
  if (fs.existsSync(trashSource)) {
    fs.rmSync(trashSource, { recursive: true, force: true });
  }

  deleteTrashItemRecord(trashId);
  return { deletedId: trashId };
}

function emptyTrash(user = null) {
  const usernameFilter = user && user.role !== 'admin' ? user.username : null;
  const items = listTrashItems(usernameFilter);
  for (const item of items) {
    const trashSource = path.join(getTrashRoot(), item.trash_filename);
    if (fs.existsSync(trashSource)) {
      fs.rmSync(trashSource, { recursive: true, force: true });
    }
  }
  clearAllTrashRecords(usernameFilter);
  return { deletedCount: items.length };
}

function getUniqueUploadPath(targetDirFull, filename) {
  const cleanName = path.basename(String(filename || 'uploaded-file').trim());
  let candidate = path.join(targetDirFull, cleanName);
  if (!fs.existsSync(candidate)) {
    return { fullPath: candidate, finalName: cleanName };
  }
  const ext = path.extname(cleanName);
  const base = path.basename(cleanName, ext);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    const nextName = `${base} (${counter})${ext}`;
    candidate = path.join(targetDirFull, nextName);
    counter++;
  }
  return { fullPath: candidate, finalName: path.basename(candidate) };
}

// ================= CHUNKED & RESUMABLE UPLOAD (PHASE 2 & 3 QUOTA) =================
function computeAdaptiveChunkSize(totalSize) {
  if (totalSize <= 5 * 1024 * 1024) return 1024 * 1024; // 1 MB for <= 5MB
  if (totalSize <= 50 * 1024 * 1024) return 2 * 1024 * 1024; // 2 MB for <= 50MB
  if (totalSize <= 500 * 1024 * 1024) return 4 * 1024 * 1024; // 4 MB for <= 500MB
  return 8 * 1024 * 1024; // 8 MB for > 500MB (stable Wi-Fi & LAN high-throughput transfer)
}

function initChunkedUpload({ targetPath = '/', filename, totalSize, lastModified = 0, user = null }) {
  const uploadsTmpDir = getUploadsTmpDir();
  const filesRoot = getFilesRoot();
  fs.mkdirSync(uploadsTmpDir, { recursive: true });

  const cleanName = path.basename(String(filename || '').trim());
  if (!cleanName) {
    const err = new Error('กรุณาระบุชื่อไฟล์');
    err.statusCode = 400;
    throw err;
  }

  assertExtensionAllowed(cleanName);

  const sizeNum = Math.max(0, Number(totalSize || 0));
  assertQuotaAvailable(user, sizeNum);
  const adaptiveChunkSize = computeAdaptiveChunkSize(sizeNum);

  const rootDir = getUserRootPath(user);
  const { fullPath: targetDirFull } = resolveSafePath(targetPath, rootDir);
  if (!fs.existsSync(targetDirFull) || !fs.statSync(targetDirFull).isDirectory()) {
    const err = new Error('ไม่พบโฟลเดอร์ปลายทาง');
    err.statusCode = 404;
    throw err;
  }

  // Store path relative to filesRoot so finalize works for any user
  const storageRelDir =
    targetDirFull === filesRoot
      ? '/'
      : '/' + path.relative(filesRoot, targetDirFull).split(path.sep).join('/');

  const fingerprint = crypto
    .createHash('sha256')
    .update(`${storageRelDir}:${cleanName}:${sizeNum}:${lastModified}`)
    .digest('hex');

  const existing = getUploadSessionByFingerprint(fingerprint);
  if (
    existing &&
    existing.temp_path &&
    path.dirname(existing.temp_path) === uploadsTmpDir &&
    fs.existsSync(existing.temp_path)
  ) {
    const actualSize = fs.statSync(existing.temp_path).size;
    if (actualSize === existing.total_size && existing.total_size > 0) {
      const completed = finalizeChunkedUpload(existing.id);
      return {
        uploadId: existing.id,
        uploadedBytes: actualSize,
        totalSize: existing.total_size,
        chunkSize: existing.chunk_size || adaptiveChunkSize,
        resumed: true,
        completed: true,
        file: completed,
      };
    }
    if (actualSize < existing.total_size) {
      updateUploadSessionProgress(existing.id, actualSize);
      return {
        uploadId: existing.id,
        uploadedBytes: actualSize,
        totalSize: existing.total_size,
        chunkSize: existing.chunk_size || adaptiveChunkSize,
        resumed: actualSize > 0,
        completed: false,
      };
    }
  }

  if (existing) {
    try {
      if (existing.temp_path && fs.existsSync(existing.temp_path)) {
        fs.unlinkSync(existing.temp_path);
      }
    } catch {
      // Ignore cleanup errors
    }
    deleteUploadSession(existing.id);
  }

  const uploadId = crypto.randomUUID();
  const tempPath = path.join(uploadsTmpDir, `${uploadId}.part`);
  fs.writeFileSync(tempPath, Buffer.alloc(0));

  const now = new Date().toISOString();
  createUploadSession({
    id: uploadId,
    fingerprint,
    target_dir: storageRelDir,
    filename: cleanName,
    total_size: sizeNum,
    uploaded_bytes: 0,
    chunk_size: adaptiveChunkSize,
    temp_path: tempPath,
    created_at: now,
    updated_at: now,
  });

  if (sizeNum === 0) {
    const completed = finalizeChunkedUpload(uploadId);
    return {
      uploadId,
      uploadedBytes: 0,
      totalSize: 0,
      chunkSize: adaptiveChunkSize,
      resumed: false,
      completed: true,
      file: completed,
    };
  }

  return {
    uploadId,
    uploadedBytes: 0,
    totalSize: sizeNum,
    chunkSize: adaptiveChunkSize,
    resumed: false,
    completed: false,
  };
}

function syncSleep(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {}
  }
}

function safeMoveTempFileSync(srcPath, destPath) {
  let lastErr = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      fs.renameSync(srcPath, destPath);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < 5) syncSleep(50 * (attempt + 1));
    }
  }
  // Fallback if antivirus / OS indexer holds a temporary rename lock or cross-volume move
  try {
    fs.copyFileSync(srcPath, destPath);
    try {
      fs.unlinkSync(srcPath);
    } catch {
      // Ignore unlink error if locked
    }
  } catch {
    throw lastErr || new Error('ไม่สามารถย้ายไฟล์ที่อัปโหลดเสร็จไปยังโฟลเดอร์ปลายทางได้');
  }
}

function finalizeChunkedUpload(uploadId) {
  const session = getUploadSessionById(uploadId);
  if (!session) {
    const err = new Error('ไม่พบ Session การอัปโหลด');
    err.statusCode = 404;
    throw err;
  }

  const { fullPath: targetDirFull } = resolveSafePath(session.target_dir, getFilesRoot());
  fs.mkdirSync(targetDirFull, { recursive: true });

  const { fullPath: destFullPath, finalName } = getUniqueUploadPath(
    targetDirFull,
    session.filename
  );

  safeMoveTempFileSync(session.temp_path, destFullPath);
  deleteUploadSession(uploadId);

  const stat = fs.statSync(destFullPath);
  return {
    name: finalName,
    size: stat.size,
    path: `${session.target_dir === '/' ? '' : session.target_dir}/${finalName}`,
  };
}

function cancelChunkedUpload(uploadId) {
  const session = getUploadSessionById(uploadId);
  if (!session) return { cancelled: false };

  if (fs.existsSync(session.temp_path)) {
    try {
      fs.unlinkSync(session.temp_path);
    } catch {
      // Ignore
    }
  }
  deleteUploadSession(uploadId);
  return { cancelled: true };
}

module.exports = {
  getStorageRoot,
  getFilesRoot,
  getUsersHomeRoot,
  getTrashRoot,
  getUploadsTmpDir,
  getDefaultStorageRoot,
  isCustomStorageRoot,
  getStorageConfig,
  testStoragePath,
  setStorageRootPath,
  resetStorageRootPath,
  initStorageDirectories,
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
};

Object.defineProperty(module.exports, 'STORAGE_ROOT', {
  get: getStorageRoot,
  enumerable: true,
  configurable: true,
});
Object.defineProperty(module.exports, 'FILES_ROOT', {
  get: getFilesRoot,
  enumerable: true,
  configurable: true,
});
Object.defineProperty(module.exports, 'USERS_HOME_ROOT', {
  get: getUsersHomeRoot,
  enumerable: true,
  configurable: true,
});
Object.defineProperty(module.exports, 'TRASH_ROOT', {
  get: getTrashRoot,
  enumerable: true,
  configurable: true,
});
Object.defineProperty(module.exports, 'UPLOADS_TMP_DIR', {
  get: getUploadsTmpDir,
  enumerable: true,
  configurable: true,
});

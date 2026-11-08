const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  listAllUsers,
  getUserByUsername,
  insertClipboardItem,
  listClipboardItems,
  deleteClipboardItemById,
} = require('./db');
const {
  getUserRootPath,
  resolveSafePath,
  assertQuotaAvailable,
  getFileMetadata,
  getUniqueUploadPath,
} = require('./storage');
const { getDirectorySizeSync } = require('./system');

// ================= 1. MUSIC JUKEBOX & AUDIO CENTER =================
function listAudioTracks(user) {
  const rootDir = getUserRootPath(user);
  const tracks = [];
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
      if (meta.category !== 'audio') continue;

      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      const ext = path.extname(entry.name);
      const title = path.basename(entry.name, ext);

      tracks.push({
        name: entry.name,
        title,
        path: relPath,
        parentPath: curr.rel || '/',
        size: stat.size,
        extension: meta.extension,
        mimeType: meta.mimeType,
        modifiedAt: stat.mtime.toISOString(),
      });
    }
  }

  tracks.sort((a, b) => a.name.localeCompare(b.name, 'th'));
  return tracks;
}

// ================= 2. CROSS-DEVICE CLIPBOARD & SNIPPET HUB =================
function createClipboardSnippet(user, { title = '', content = '', isShared = true }) {
  const cleanContent = String(content || '').trim();
  if (!cleanContent) {
    const err = new Error('กรุณากรอกข้อความหรือลิงก์ที่ต้องการส่งเข้ากระดานคลิปบอร์ด');
    err.statusCode = 400;
    throw err;
  }

  return insertClipboardItem({
    author_id: user.id,
    author_username: user.username,
    title: String(title || '').trim() || cleanContent.slice(0, 42),
    content: cleanContent,
    is_shared: Boolean(isShared),
  });
}

// ================= 3. SMART BATCH RENAME =================
function computeBatchRenamedFilename(originalName, index, options = {}) {
  const isDir = Boolean(options.isDirectory);
  const ext = isDir ? '' : path.extname(originalName);
  const base = isDir ? originalName : path.basename(originalName, ext);
  const mode = options.mode || 'pattern';

  if (mode === 'pattern') {
    const pattern = String(options.pattern || 'File-{n}').trim() || 'File-{n}';
    const startNum = Math.max(1, Number(options.startNumber || 1));
    const paddedNum = String(startNum + index).padStart(3, '0');
    const replaced = pattern.includes('{n}')
      ? pattern.replace(/\{n\}/g, paddedNum)
      : `${pattern}-${paddedNum}`;
    return `${replaced}${ext}`;
  }

  if (mode === 'prefix_suffix') {
    const prefix = String(options.prefix || '');
    const suffix = String(options.suffix || '');
    return `${prefix}${base}${suffix}${ext}`;
  }

  if (mode === 'replace') {
    const findText = String(options.findText || '');
    const replaceText = String(options.replaceText || '');
    if (!findText) return originalName;
    const nextBase = base.split(findText).join(replaceText);
    return `${nextBase || base}${ext}`;
  }

  return originalName;
}

function batchRenameItems(user, { paths = [], mode = 'pattern', pattern = '', startNumber = 1, prefix = '', suffix = '', findText = '', replaceText = '' }) {
  if (!Array.isArray(paths) || paths.length === 0) {
    const err = new Error('กรุณาเลือกรายการไฟล์ที่ต้องการเปลี่ยนชื่อชุด');
    err.statusCode = 400;
    throw err;
  }

  const rootDir = getUserRootPath(user);
  const renamed = [];

  for (let i = 0; i < paths.length; i++) {
    const itemClientPath = paths[i];
    const { fullPath: srcFull, relativePath: srcRel } = resolveSafePath(itemClientPath, rootDir);
    if (srcRel === '/' || !fs.existsSync(srcFull)) continue;

    const stat = fs.statSync(srcFull);
    const originalName = path.basename(srcFull);
    const candidateName = computeBatchRenamedFilename(originalName, i, {
      isDirectory: stat.isDirectory(),
      mode,
      pattern,
      startNumber,
      prefix,
      suffix,
      findText,
      replaceText,
    })
      .replace(/[/\\]/g, '_')
      .trim();

    if (!candidateName || candidateName === originalName) continue;

    const parentDir = path.dirname(srcFull);
    const { fullPath: destFull, finalName } = getUniqueUploadPath(parentDir, candidateName);
    fs.renameSync(srcFull, destFull);

    renamed.push({
      oldName: originalName,
      newName: finalName,
    });
  }

  return {
    renamedCount: renamed.length,
    renamed,
  };
}

// ================= 4. FILE CHECKSUM & INTEGRITY VERIFIER (MD5 / SHA-1 / SHA-256) =================
function computeFileChecksums(user, clientPath) {
  return new Promise((resolve, reject) => {
    let resolved;
    try {
      const rootDir = getUserRootPath(user);
      resolved = resolveSafePath(clientPath, rootDir);
    } catch (err) {
      reject(err);
      return;
    }

    const { fullPath, relativePath } = resolved;
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      reject(Object.assign(new Error('ไม่พบไฟล์สำหรับคำนวณค่า Hash Checksum'), { statusCode: 404 }));
      return;
    }

    const stat = fs.statSync(fullPath);
    const md5 = crypto.createHash('md5');
    const sha1 = crypto.createHash('sha1');
    const sha256 = crypto.createHash('sha256');

    const stream = fs.createReadStream(fullPath);
    stream.on('data', (chunk) => {
      md5.update(chunk);
      sha1.update(chunk);
      sha256.update(chunk);
    });
    stream.on('end', () => {
      resolve({
        name: path.basename(fullPath),
        path: relativePath,
        size: stat.size,
        md5: md5.digest('hex'),
        sha1: sha1.digest('hex'),
        sha256: sha256.digest('hex'),
      });
    });
    stream.on('error', reject);
  });
}

// ================= 5. SEND TO NAS USER INBOX =================
function listRecipientUsers(currentUser) {
  const all = listAllUsers().map((u) => ({
    id: u.id,
    username: u.username,
    role: u.role,
    isSelf: u.username === currentUser?.username,
  }));
  all.sort((a, b) => Number(a.isSelf) - Number(b.isSelf));
  return all;
}

function sendItemsToUserInbox(senderUser, { recipientUsername = '', paths = [], message = '' }) {
  const cleanRecipient = String(recipientUsername || '').trim();
  const targetUser = getUserByUsername(cleanRecipient);
  if (!targetUser) {
    const err = new Error(`ไม่พบบัญชีผู้ใช้ "${cleanRecipient}" ในระบบ`);
    err.statusCode = 404;
    throw err;
  }

  if (!Array.isArray(paths) || paths.length === 0) {
    const err = new Error('กรุณาเลือกไฟล์หรือโฟลเดอร์ที่ต้องการส่ง');
    err.statusCode = 400;
    throw err;
  }

  const senderRoot = getUserRootPath(senderUser);
  const recipientRoot = getUserRootPath(targetUser);
  const inboxDir = path.join(recipientRoot, 'Inbox');
  fs.mkdirSync(inboxDir, { recursive: true });

  const sentItems = [];
  for (const sp of paths) {
    const { fullPath: srcFull, relativePath: srcRel } = resolveSafePath(sp, senderRoot);
    if (srcRel === '/' || !fs.existsSync(srcFull)) continue;

    const stat = fs.statSync(srcFull);
    const neededBytes = stat.isDirectory()
      ? getDirectorySizeSync(srcFull).totalSize
      : stat.size;
    assertQuotaAvailable(targetUser, neededBytes);

    const prefixedName = `[จาก ${senderUser.username}] ${path.basename(srcFull)}`;
    const { fullPath: destFull, finalName } = getUniqueUploadPath(inboxDir, prefixedName);
    fs.cpSync(srcFull, destFull, { recursive: true });
    sentItems.push(finalName);
  }

  const cleanMsg = String(message || '').trim();
  if (cleanMsg && sentItems.length > 0) {
    const noteTitle = `[ข้อความจาก ${senderUser.username}].md`;
    const { fullPath: noteFull } = getUniqueUploadPath(inboxDir, noteTitle);
    const noteContent = `# 📨 ข้อความแนบจากคุณ ${senderUser.username}\n- **เวลาที่ส่ง:** ${new Date().toLocaleString('th-TH')}\n- **ไฟล์ที่ส่งมาด้วย:** ${sentItems.join(', ')}\n\n---\n\n${cleanMsg}\n`;
    fs.writeFileSync(noteFull, noteContent, 'utf8');
  }

  return {
    recipient: targetUser.username,
    sentCount: sentItems.length,
    sentItems,
  };
}

module.exports = {
  listAudioTracks,
  createClipboardSnippet,
  listClipboardItems,
  deleteClipboardItemById,
  batchRenameItems,
  computeFileChecksums,
  listRecipientUsers,
  sendItemsToUserInbox,
};

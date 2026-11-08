const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db } = require('./db');
const { getUserRootPath, getFileMetadata } = require('./storage');

// Ensure file_index table exists in SQLite
db.exec(`
  CREATE TABLE IF NOT EXISTS file_index (
    scope_root TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    parent_path TEXT NOT NULL,
    name TEXT NOT NULL,
    name_lower TEXT NOT NULL,
    is_directory INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    modified_at TEXT NOT NULL,
    category TEXT NOT NULL,
    extension TEXT NOT NULL,
    PRIMARY KEY (scope_root, rel_path)
  );
  CREATE INDEX IF NOT EXISTS idx_file_index_name ON file_index(scope_root, name_lower);
  CREATE INDEX IF NOT EXISTS idx_file_index_cat ON file_index(scope_root, category);
`);

/**
 * Scans the user's root storage and updates the SQLite file_index table
 */
function rebuildFileIndex(user = null) {
  const startTime = Date.now();
  const rootDir = getUserRootPath(user);

  const entriesToInsert = [];
  let totalFiles = 0;
  let totalFolders = 0;
  let totalSize = 0;

  const stack = [{ full: rootDir, rel: '/' }];
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
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      const isDir = entry.isDirectory();
      const relPath = curr.rel === '/' ? `/${entry.name}` : `${curr.rel}/${entry.name}`;
      const meta = getFileMetadata(entry.name, isDir);

      if (isDir) {
        totalFolders++;
        stack.push({ full: fullPath, rel: relPath });
      } else {
        totalFiles++;
        totalSize += stat.size;
      }

      entriesToInsert.push({
        scope_root: rootDir,
        rel_path: relPath,
        parent_path: curr.rel,
        name: entry.name,
        name_lower: entry.name.toLowerCase(),
        is_directory: isDir ? 1 : 0,
        size: isDir ? 0 : stat.size,
        modified_at: stat.mtime.toISOString(),
        category: meta.category,
        extension: meta.extension,
      });
    }
  }

  db.exec('BEGIN TRANSACTION');
  try {
    db.prepare('DELETE FROM file_index WHERE scope_root = ?').run(rootDir);
    const insertStmt = db.prepare(`
      INSERT INTO file_index (
        scope_root, rel_path, parent_path, name, name_lower,
        is_directory, size, modified_at, category, extension
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of entriesToInsert) {
      insertStmt.run(
        item.scope_root,
        item.rel_path,
        item.parent_path,
        item.name,
        item.name_lower,
        item.is_directory,
        item.size,
        item.modified_at,
        item.category,
        item.extension
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    totalFiles,
    totalFolders,
    totalSize,
    durationMs: Date.now() - startTime,
    indexedAt: new Date().toISOString(),
  };
}

/**
 * Global search across all subfolders using the SQLite index
 */
function globalSearchFiles({ query = '', category = 'all', user = null }) {
  const rootDir = getUserRootPath(user);

  // Automatically index if empty for this scope
  const countRow = db
    .prepare('SELECT COUNT(*) AS count FROM file_index WHERE scope_root = ?')
    .get(rootDir);
  if (!countRow || countRow.count === 0) {
    rebuildFileIndex(user);
  }

  const q = String(query || '').trim().toLowerCase();
  const cat = String(category || 'all').trim().toLowerCase();

  let sql = 'SELECT * FROM file_index WHERE scope_root = ?';
  const params = [rootDir];

  if (q) {
    sql += ' AND name_lower LIKE ?';
    params.push(`%${q}%`);
  }
  if (cat && cat !== 'all') {
    sql += ' AND category = ?';
    params.push(cat);
  }

  sql += ' ORDER BY is_directory DESC, modified_at DESC LIMIT 300';
  const rows = db.prepare(sql).all(...params);

  return rows.map((r) => ({
    name: r.name,
    path: r.rel_path,
    parentPath: r.parent_path,
    isDirectory: Boolean(r.is_directory),
    size: r.size,
    modifiedAt: r.modified_at,
    category: r.category,
    extension: r.extension,
    hasThumbnail: r.category === 'image' || r.category === 'video',
  }));
}

/**
 * Computes a fast content fingerprint (full SHA-256 for <= 4MB, sampled head+mid+tail for larger files)
 */
function computeFastFileHash(fullPath, size) {
  const hash = crypto.createHash('sha256');
  const SAMPLE_BYTES = 128 * 1024; // 128 KB sample window

  if (size <= SAMPLE_BYTES * 3) {
    const buf = fs.readFileSync(fullPath);
    hash.update(buf);
    return hash.digest('hex');
  }

  const fd = fs.openSync(fullPath, 'r');
  try {
    const buf = Buffer.alloc(SAMPLE_BYTES);
    // Head
    fs.readSync(fd, buf, 0, SAMPLE_BYTES, 0);
    hash.update(buf);
    // Middle
    const midOffset = Math.floor(size / 2) - Math.floor(SAMPLE_BYTES / 2);
    fs.readSync(fd, buf, 0, SAMPLE_BYTES, midOffset);
    hash.update(buf);
    // Tail
    fs.readSync(fd, buf, 0, SAMPLE_BYTES, size - SAMPLE_BYTES);
    hash.update(buf);
    hash.update(`:${size}`);
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Finds duplicate files across all folders in the user's storage
 */
function findDuplicateFiles(user = null) {
  const rootDir = getUserRootPath(user);
  rebuildFileIndex(user);

  // Step 1: Find sizes that appear more than once
  const sizeGroups = db
    .prepare(
      `SELECT size, COUNT(*) AS cnt
       FROM file_index
       WHERE scope_root = ? AND is_directory = 0 AND size > 0
       GROUP BY size
       HAVING cnt > 1
       ORDER BY size DESC`
    )
    .all(rootDir);

  const duplicateGroups = [];
  let totalWastedBytes = 0;
  let totalDuplicateFiles = 0;

  const getBySizeStmt = db.prepare(
    'SELECT * FROM file_index WHERE scope_root = ? AND is_directory = 0 AND size = ?'
  );

  for (const sg of sizeGroups) {
    const candidates = getBySizeStmt.all(rootDir, sg.size);
    const byHash = new Map();

    for (const item of candidates) {
      const fullPath = path.join(rootDir, item.rel_path.replace(/^\/+/, ''));
      if (!fs.existsSync(fullPath)) continue;
      try {
        const fileHash = computeFastFileHash(fullPath, item.size);
        if (!byHash.has(fileHash)) {
          byHash.set(fileHash, []);
        }
        byHash.get(fileHash).push({
          name: item.name,
          path: item.rel_path,
          parentPath: item.parent_path,
          size: item.size,
          modifiedAt: item.modified_at,
          category: item.category,
        });
      } catch {
        // Ignore unreadable files
      }
    }

    for (const [hash, files] of byHash.entries()) {
      if (files.length > 1) {
        const wasted = (files.length - 1) * sg.size;
        totalWastedBytes += wasted;
        totalDuplicateFiles += files.length - 1;
        duplicateGroups.push({
          hash: hash.slice(0, 16),
          size: sg.size,
          wastedBytes: wasted,
          count: files.length,
          files,
        });
      }
    }
  }

  return {
    duplicateGroups,
    totalWastedBytes,
    totalDuplicateFiles,
  };
}

module.exports = {
  rebuildFileIndex,
  globalSearchFiles,
  findDuplicateFiles,
};


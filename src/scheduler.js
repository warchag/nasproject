const fs = require('node:fs');
const path = require('node:path');
const { db, listTrashItems, deleteTrashItemRecord } = require('./db');
const {
  getStorageRoot,
  getFilesRoot,
  getTrashRoot,
  resolveSafePath,
} = require('./storage');
const { streamZipArchive } = require('./zip');
const { rebuildFileIndex } = require('./indexer');

function getBackupsDir() {
  const dir = path.join(getStorageRoot(), 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const DEFAULT_SCHEDULER_CONFIG = {
  autoBackupEnabled: true,
  backupIntervalHours: 24,
  maxBackupsKeep: 5,
  trashRetentionDays: 30,
  lastBackupAt: null,
  lastTrashCleanupAt: null,
};

function getSchedulerConfig() {
  const row = db
    .prepare('SELECT value FROM system_settings WHERE key = ?')
    .get('scheduler_config');
  if (!row) {
    saveSchedulerConfig(DEFAULT_SCHEDULER_CONFIG);
    return { ...DEFAULT_SCHEDULER_CONFIG };
  }
  try {
    return { ...DEFAULT_SCHEDULER_CONFIG, ...JSON.parse(row.value) };
  } catch {
    return { ...DEFAULT_SCHEDULER_CONFIG };
  }
}

function saveSchedulerConfig(cfg) {
  const merged = { ...DEFAULT_SCHEDULER_CONFIG, ...cfg };
  db.prepare(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES ('scheduler_config', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(JSON.stringify(merged), new Date().toISOString());
  return merged;
}

/**
 * Creates a .zip backup snapshot of the specified path (default: entire FILES_ROOT)
 */
async function createBackupSnapshot(label = 'manual', targetRelPath = '/') {
  const { fullPath } = resolveSafePath(targetRelPath, getFilesRoot());
  if (!fs.existsSync(fullPath)) {
    const err = new Error('ไม่พบโฟลเดอร์ที่ต้องการสำรองข้อมูล');
    err.statusCode = 404;
    throw err;
  }

  const cleanLabel = String(label || 'snapshot')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 24) || 'snapshot';
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const filename = `NAS-Backup-${ts}-${cleanLabel}.zip`;
  const backupsDir = getBackupsDir();
  const destZipPath = path.join(backupsDir, filename);

  const outStream = fs.createWriteStream(destZipPath);
  await new Promise((resolve, reject) => {
    outStream.on('finish', resolve);
    outStream.on('error', reject);
    streamZipArchive([fullPath], outStream).catch(reject);
  });

  const cfg = getSchedulerConfig();
  cfg.lastBackupAt = new Date().toISOString();
  saveSchedulerConfig(cfg);

  rotateOldBackups(cfg.maxBackupsKeep);

  const stat = fs.statSync(destZipPath);
  return {
    filename,
    size: stat.size,
    createdAt: stat.mtime.toISOString(),
  };
}

function listBackupSnapshots() {
  const backupsDir = getBackupsDir();
  if (!fs.existsSync(backupsDir)) return [];
  const entries = fs.readdirSync(backupsDir, { withFileTypes: true });
  const backups = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.zip')) continue;
    const fullPath = path.join(backupsDir, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      backups.push({
        filename: entry.name,
        size: stat.size,
        createdAt: stat.mtime.toISOString(),
      });
    } catch {
      // Ignore
    }
  }

  return backups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function rotateOldBackups(maxKeep = 5) {
  const limit = Math.max(1, Number(maxKeep || 5));
  const backups = listBackupSnapshots();
  if (backups.length <= limit) return 0;

  const backupsDir = getBackupsDir();
  let removed = 0;
  for (let i = limit; i < backups.length; i++) {
    const target = path.join(backupsDir, backups[i].filename);
    try {
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
        removed++;
      }
    } catch {
      // Ignore
    }
  }
  return removed;
}

function deleteBackupSnapshot(filename) {
  const cleanName = path.basename(String(filename || ''));
  const target = path.join(getBackupsDir(), cleanName);
  if (!fs.existsSync(target)) {
    const err = new Error('ไม่พบไฟล์ Backup ที่ระบุ');
    err.statusCode = 404;
    throw err;
  }
  fs.unlinkSync(target);
  return { deleted: cleanName };
}

function getBackupFilePath(filename) {
  const cleanName = path.basename(String(filename || ''));
  const target = path.join(getBackupsDir(), cleanName);
  if (!fs.existsSync(target)) {
    const err = new Error('ไม่พบไฟล์ Backup ที่ระบุ');
    err.statusCode = 404;
    throw err;
  }
  return target;
}

/**
 * Automatically purges items in the Recycle Bin older than trashRetentionDays
 */
function runAutoTrashCleanup(overrideRetentionDays = null) {
  const cfg = getSchedulerConfig();
  const retentionDays =
    overrideRetentionDays !== null
      ? Number(overrideRetentionDays)
      : Number(cfg.trashRetentionDays || 30);

  if (retentionDays <= 0) {
    return { purgedCount: 0 };
  }

  const cutoffMs = Date.now() - retentionDays * 24 * 3600 * 1000;
  const items = listTrashItems(null);
  let purgedCount = 0;

  for (const item of items) {
    const deletedMs = new Date(item.deleted_at).getTime();
    if (deletedMs < cutoffMs) {
      const trashFile = path.join(getTrashRoot(), item.trash_filename);
      try {
        if (fs.existsSync(trashFile)) {
          fs.rmSync(trashFile, { recursive: true, force: true });
        }
        deleteTrashItemRecord(item.id);
        purgedCount++;
      } catch {
        // Ignore
      }
    }
  }

  cfg.lastTrashCleanupAt = new Date().toISOString();
  saveSchedulerConfig(cfg);
  return { purgedCount, retentionDays };
}

// Background Scheduled Tasks Runner (checks every 10 minutes)
setInterval(async () => {
  try {
    const cfg = getSchedulerConfig();

    // 1. Auto-Trash Cleanup
    runAutoTrashCleanup(cfg.trashRetentionDays);

    // 2. Refresh Global File Index
    rebuildFileIndex({ role: 'admin', username: 'admin' });

    // 3. Scheduled Auto-Backup
    if (cfg.autoBackupEnabled && cfg.backupIntervalHours > 0) {
      const lastMs = cfg.lastBackupAt ? new Date(cfg.lastBackupAt).getTime() : 0;
      const intervalMs = cfg.backupIntervalHours * 3600 * 1000;
      if (Date.now() - lastMs >= intervalMs) {
        await createBackupSnapshot('auto', '/');
      }
    }
  } catch {
    // Ignore background scheduler errors
  }
}, 10 * 60 * 1000).unref();

module.exports = {
  getBackupsDir,
  getSchedulerConfig,
  saveSchedulerConfig,
  createBackupSnapshot,
  listBackupSnapshots,
  deleteBackupSnapshot,
  getBackupFilePath,
  runAutoTrashCleanup,
};

Object.defineProperty(module.exports, 'BACKUPS_DIR', {
  get: getBackupsDir,
  enumerable: true,
  configurable: true,
});


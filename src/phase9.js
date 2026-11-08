const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { getUserRootPath } = require('./storage');
const { getUserByUsername } = require('./db');
const { verifyPassword } = require('./auth');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico', '.tiff']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac']);
const TEXT_EXTS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
  '.py',
  '.html',
  '.css',
  '.csv',
  '.tsv',
  '.xml',
  '.yaml',
  '.yml',
  '.ini',
  '.conf',
  '.sh',
  '.sql',
  '.log',
]);
const ARCHIVE_EXTS = new Set(['.zip', '.tar', '.gz', '.tgz', '.rar', '.7z']);

function detectSimpleCategory(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (ext === '.pdf' || ext === '.doc' || ext === '.docx' || ext === '.xls' || ext === '.xlsx' || ext === '.ppt' || ext === '.pptx') {
    return 'document';
  }
  if (ARCHIVE_EXTS.has(ext)) return 'archive';
  if (TEXT_EXTS.has(ext)) return 'text';
  return 'other';
}

// ============================================================================
// 1. RECENTLY MODIFIED FILES ACROSS USER STORAGE
// ============================================================================
function getRecentFiles(user, limit = 10) {
  const rootDir = getUserRootPath(user);
  const allFiles = [];

  function walk(currentDir, relPrefix = '', depth = 0) {
    if (depth > 8 || allFiles.length > 1500) return;
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (depth === 0 && user.role !== 'admin' && entry.name === 'Users') continue;

      const fullPath = path.join(currentDir, entry.name);
      const relPath = `${relPrefix}/${entry.name}`;

      if (entry.isDirectory()) {
        walk(fullPath, relPath, depth + 1);
        continue;
      }

      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      const category = detectSimpleCategory(entry.name);
      const parentRel = path.posix.dirname(relPath);

      allFiles.push({
        name: entry.name,
        path: relPath,
        parentPath: parentRel === '.' ? '/' : parentRel,
        isDirectory: false,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        mtimeMs: stat.mtimeMs,
        extension: ext,
        category,
        isVault: ext === '.vault',
      });
    }
  }

  walk(rootDir, '', 0);

  allFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return allFiles.slice(0, Math.max(1, Math.min(24, Number(limit || 10)))).map(({ mtimeMs, ...rest }) => rest);
}

// ============================================================================
// 2. LIVE TOP PROCESSES & NAS SERVER TELEMETRY
// ============================================================================
function getTopSystemProcesses(limit = 10) {
  const maxRows = Math.max(3, Math.min(25, Number(limit || 10)));
  const processes = [];

  try {
    const psArgs =
      process.platform === 'darwin'
        ? ['-Ao', 'pid,pcpu,pmem,rss,comm', '-r']
        : ['-Ao', 'pid,pcpu,pmem,rss,comm', '--sort=-pcpu'];

    const out = execFileSync('/bin/ps', psArgs, {
      encoding: 'utf8',
      timeout: 2500,
    });

    const lines = out.trim().split(/\r?\n/).slice(1);
    for (const line of lines) {
      if (processes.length >= maxRows) break;
      const match = line.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const cpuPercent = Number(match[2]);
      const memPercent = Number(match[3]);
      const rssKb = Number(match[4]);
      const rawComm = match[5].trim();
      const name = path.basename(rawComm) || rawComm;

      processes.push({
        pid,
        name,
        commandPath: rawComm,
        cpuPercent: Number(cpuPercent.toFixed(1)),
        memPercent: Number(memPercent.toFixed(1)),
        memoryBytes: rssKb * 1024,
        isNasServer: pid === process.pid,
      });
    }
  } catch {
    // Fallback if ps is restricted
  }

  const mem = process.memoryUsage();
  if (processes.length === 0) {
    processes.push({
      pid: process.pid,
      name: 'node (Personal NAS Server)',
      commandPath: process.execPath,
      cpuPercent: 0.5,
      memPercent: 1.2,
      memoryBytes: mem.rss,
      isNasServer: true,
    });
  }

  return {
    nasProcess: {
      pid: process.pid,
      nodeVersion: process.version,
      uptimeSeconds: Math.floor(process.uptime()),
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
    },
    processes,
  };
}

module.exports = {
  getRecentFiles,
  getTopSystemProcesses,
};

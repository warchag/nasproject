const os = require('node:os');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

let cachedMemInfo = null;
let lastMemCheckAt = 0;

/**
 * On macOS (Darwin), os.freemem() only returns strictly unallocated 'Pages free'
 * and ignores several GB of reclaimable File Cache / Inactive / Purgeable memory,
 * causing Node.js to falsely report 98-99% RAM usage.
 * This function parses /usr/bin/vm_stat on macOS to report true Available & Used RAM.
 */
function getAccurateMemoryStats() {
  const now = Date.now();
  if (cachedMemInfo && now - lastMemCheckAt < 2500) {
    return cachedMemInfo;
  }

  const totalMem = os.totalmem();

  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('/usr/bin/vm_stat', { encoding: 'utf8', timeout: 1500 });
      const pageSizeMatch = out.match(/page size of (\d+) bytes/i);
      const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 16384;

      const getPages = (label) => {
        const m = out.match(new RegExp(`${label}:\\s+(\\d+)`, 'i'));
        return m ? Number(m[1]) : 0;
      };

      const freePages = getPages('Pages free');
      const inactivePages = getPages('Pages inactive');
      const speculativePages = getPages('Pages speculative');
      const wiredPages = getPages('Pages wired down');
      const purgeablePages = getPages('Pages purgeable');
      const fileBackedPages = getPages('File-backed pages');
      const anonymousPages = getPages('Anonymous pages');
      const compressorPages = getPages('Pages occupied by compressor');

      // Actual memory locked by Apps (Anonymous non-purgeable) + Kernel Wired memory
      const appBytes = Math.max(0, anonymousPages - purgeablePages) * pageSize;
      const wiredBytes = wiredPages * pageSize;
      const compressedBytes = compressorPages * pageSize;
      const cachedBytes = (fileBackedPages + purgeablePages) * pageSize;

      // Available memory = Free + Reclaimable (Inactive / Speculative / Cached)
      const usedBytes = Math.min(totalMem, appBytes + wiredBytes);
      const availableBytes = Math.max(
        (freePages + inactivePages + speculativePages) * pageSize,
        totalMem - usedBytes
      );
      const finalUsedBytes = Math.max(0, totalMem - availableBytes);
      const usagePercent = Math.round((finalUsedBytes / totalMem) * 1000) / 10;

      cachedMemInfo = {
        totalBytes: totalMem,
        usedBytes: finalUsedBytes,
        freeBytes: availableBytes,
        rawFreeBytes: freePages * pageSize,
        appBytes,
        wiredBytes,
        compressedBytes,
        cachedBytes,
        usagePercent,
      };
      lastMemCheckAt = now;
      return cachedMemInfo;
    } catch {
      // Fallback to standard os.freemem() if vm_stat fails
    }
  }

  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  cachedMemInfo = {
    totalBytes: totalMem,
    usedBytes: usedMem,
    freeBytes: freeMem,
    rawFreeBytes: freeMem,
    appBytes: usedMem,
    wiredBytes: 0,
    compressedBytes: 0,
    cachedBytes: 0,
    usagePercent: Math.round((usedMem / totalMem) * 1000) / 10,
  };
  lastMemCheckAt = now;
  return cachedMemInfo;
}

function snapshotCpuTimes() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const type of Object.keys(cpu.times)) {
      total += cpu.times[type];
    }
    idle += cpu.times.idle;
  }
  return { idle, total };
}

let prevCpuSnapshot = snapshotCpuTimes();
let currentCpuPercent = 0;

// Sample CPU usage every 2 seconds in the background
setInterval(() => {
  const next = snapshotCpuTimes();
  const idleDiff = next.idle - prevCpuSnapshot.idle;
  const totalDiff = next.total - prevCpuSnapshot.total;
  if (totalDiff > 0) {
    currentCpuPercent = Math.max(
      0,
      Math.min(100, Math.round((1 - idleDiff / totalDiff) * 1000) / 10)
    );
  }
  prevCpuSnapshot = next;
}, 2000).unref();

const dirSizeCache = new Map();

function getDirectorySizeSync(dirPath, cacheTtlMs = 3500) {
  const now = Date.now();
  const cached = dirSizeCache.get(dirPath);
  if (cached && now - cached.timestamp < cacheTtlMs) {
    return cached.data;
  }

  let totalSize = 0;
  let fileCount = 0;
  let folderCount = 0;

  if (!fs.existsSync(dirPath)) {
    return { totalSize: 0, fileCount: 0, folderCount: 0 };
  }

  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === '.gitkeep' || entry.name === '.DS_Store') continue;
      const fullPath = `${current}/${entry.name}`;
      try {
        if (entry.isDirectory()) {
          folderCount++;
          stack.push(fullPath);
        } else if (entry.isFile()) {
          fileCount++;
          const st = fs.statSync(fullPath);
          totalSize += st.size;
        }
      } catch {
        // Ignore broken symlinks or inaccessible files
      }
    }
  }

  const data = { totalSize, fileCount, folderCount };
  dirSizeCache.set(dirPath, { timestamp: now, data });
  return data;
}

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const [name, nets] of Object.entries(interfaces)) {
    if (!nets) continue;
    for (const net of nets) {
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push({ interface: name, address: net.address });
      }
    }
  }
  return addresses;
}

function getSystemStats(storageRootPath, filesRootPath, trashRootPath) {
  const cpus = os.cpus();
  const memoryInfo = getAccurateMemoryStats();

  let diskTotal = 0;
  let diskFree = 0;
  let diskUsed = 0;
  let diskPercent = 0;

  try {
    const statfs = fs.statfsSync(storageRootPath);
    diskTotal = statfs.blocks * statfs.bsize;
    diskFree = statfs.bavail * statfs.bsize;
    diskUsed = diskTotal - diskFree;
    diskPercent = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 1000) / 10 : 0;
  } catch {
    // Fallback if statfsSync fails
  }

  const nasFilesStats = getDirectorySizeSync(filesRootPath);
  const nasTrashStats = getDirectorySizeSync(trashRootPath);

  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    uptimeSeconds: Math.floor(os.uptime()),
    cpu: {
      model: cpus[0] ? cpus[0].model.trim() : 'Unknown CPU',
      cores: cpus.length,
      usagePercent: currentCpuPercent,
      loadAvg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    },
    memory: memoryInfo,
    disk: {
      totalBytes: diskTotal,
      usedBytes: diskUsed,
      freeBytes: diskFree,
      usagePercent: diskPercent,
      nasFilesBytes: nasFilesStats.totalSize,
      nasFilesCount: nasFilesStats.fileCount,
      nasFoldersCount: nasFilesStats.folderCount,
      nasTrashBytes: nasTrashStats.totalSize,
    },
    network: {
      lanAddresses: getLanAddresses(),
    },
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  getSystemStats,
  getLanAddresses,
  getDirectorySizeSync,
};


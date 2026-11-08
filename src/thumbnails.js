const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const CACHE_DIR = path.resolve(__dirname, '..', 'storage', '.cache', 'thumbnails');
fs.mkdirSync(CACHE_DIR, { recursive: true });

function execFileAsync(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });
  });
}

function getCacheKey(relativePath, stat) {
  return crypto
    .createHash('sha256')
    .update(`${relativePath}:${stat.size}:${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 32);
}

function buildFallbackVideoSvg(filename) {
  const ext = path.extname(filename).replace('.', '').toUpperCase() || 'VIDEO';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="260" height="160" viewBox="0 0 260 160">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#1e293b"/>
        <stop offset="100%" stop-color="#0f172a"/>
      </linearGradient>
    </defs>
    <rect width="260" height="160" rx="10" fill="url(#bg)"/>
    <circle cx="130" cy="72" r="28" fill="rgba(59,130,246,0.25)" stroke="#3b82f6" stroke-width="2"/>
    <polygon points="123,58 123,86 146,72" fill="#60a5fa"/>
    <rect x="98" y="114" width="64" height="22" rx="6" fill="#334155"/>
    <text x="130" y="129" text-anchor="middle" fill="#f8fafc" font-family="sans-serif" font-size="11" font-weight="bold">${ext}</text>
  </svg>`;
}

/**
 * Generates or retrieves a cached thumbnail for an image or video file
 */
async function getOrGenerateThumbnail(fullPath, relativePath, category, extension) {
  const stat = fs.statSync(fullPath);

  if (extension === '.svg') {
    return {
      filePath: fullPath,
      mimeType: 'image/svg+xml',
    };
  }

  const hash = getCacheKey(relativePath, stat);

  if (category === 'image') {
    const cachedJpg = path.join(CACHE_DIR, `${hash}.jpg`);
    if (fs.existsSync(cachedJpg)) {
      return { filePath: cachedJpg, mimeType: 'image/jpeg' };
    }

    // Attempt fast thumbnail resizing via macOS built-in sips
    if (process.platform === 'darwin' && fs.existsSync('/usr/bin/sips')) {
      try {
        await execFileAsync('/usr/bin/sips', [
          '-s',
          'format',
          'jpeg',
          '-s',
          'formatOptions',
          '75',
          '-Z',
          '260',
          fullPath,
          '--out',
          cachedJpg,
        ]);
        if (fs.existsSync(cachedJpg)) {
          return { filePath: cachedJpg, mimeType: 'image/jpeg' };
        }
      } catch {
        // Fallback to original image below
      }
    }

    const mimeMap = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.ico': 'image/x-icon',
    };
    return {
      filePath: fullPath,
      mimeType: mimeMap[extension] || 'image/jpeg',
    };
  }

  if (category === 'video') {
    const cachedPng = path.join(CACHE_DIR, `${hash}.png`);
    if (fs.existsSync(cachedPng)) {
      return { filePath: cachedPng, mimeType: 'image/png' };
    }

    if (process.platform === 'darwin' && fs.existsSync('/usr/bin/qlmanage')) {
      try {
        await execFileAsync('/usr/bin/qlmanage', [
          '-t',
          '-s',
          '260',
          '-o',
          CACHE_DIR,
          fullPath,
        ]);
        const qlOut = path.join(CACHE_DIR, `${path.basename(fullPath)}.png`);
        if (fs.existsSync(qlOut)) {
          fs.renameSync(qlOut, cachedPng);
          return { filePath: cachedPng, mimeType: 'image/png' };
        }
      } catch {
        // Fallback to SVG poster below
      }
    }

    return {
      svgContent: buildFallbackVideoSvg(path.basename(fullPath)),
      mimeType: 'image/svg+xml',
    };
  }

  return null;
}

module.exports = {
  CACHE_DIR,
  getOrGenerateThumbnail,
};


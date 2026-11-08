const state = {
  user: null,
  activeTab: 'files', // 'files' | 'shares' | 'trash' | 'users' | 'system'
  currentPath: '/',
  files: [],
  trashItems: [],
  shareLinks: [],
  usersList: [],
  viewMode: 'grid', // 'grid' | 'list'
  sortBy: 'name-asc',
  searchQuery: '',
  selectedPaths: new Set(),
  editingFilePath: null,
  sharingItemPath: null,
  editingUserId: null,
  promptCallback: null,
  folderPickerCallback: null,
  statsTimer: null,
  uploadController: {
    active: false,
    paused: false,
    cancelled: false,
    currentUploadId: null,
    currentXhr: null,
    resumeResolver: null,
  },
  theme: localStorage.getItem('nas_theme') === 'light' ? 'light' : 'dark',
};

// ================= THEME SWITCHER (DARK / LIGHT MODE) =================
function applyTheme(theme) {
  const nextTheme = theme === 'light' ? 'light' : 'dark';
  state.theme = nextTheme;
  document.documentElement.setAttribute('data-theme', nextTheme);
  localStorage.setItem('nas_theme', nextTheme);

  const isLight = nextTheme === 'light';
  const iconEl = document.getElementById('theme-toggle-icon');
  const labelEl = document.getElementById('theme-toggle-label');
  if (iconEl) iconEl.textContent = isLight ? '🌙' : '☀️';
  if (labelEl) labelEl.textContent = isLight ? 'โหมดมืด' : 'โหมดสว่าง';

  const sideBtn = document.getElementById('sidebar-theme-btn');
  if (sideBtn) sideBtn.textContent = isLight ? '🌙' : '☀️';

  const loginBtn = document.getElementById('login-theme-toggle-btn');
  if (loginBtn) loginBtn.textContent = isLight ? '🌙' : '☀️';

  if (state.lastSystemStats) {
    renderTelemetryAreaChartAndAlerts(state.lastSystemStats);
  }
}

function toggleTheme() {
  const next = state.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  showToast(next === 'light' ? '☀️ เปลี่ยนเป็นโหมดสว่าง (Light Mode) แล้ว' : '🌙 เปลี่ยนเป็นโหมดมืด (Dark Mode) แล้ว');
}

// ================= UTILITIES =================
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function formatDate(isoStr) {
  if (!isoStr) return '-';
  const d = new Date(isoStr);
  return d.toLocaleString('th-TH', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d} วัน`);
  if (h > 0) parts.push(`${h} ชม.`);
  parts.push(`${m} นาที`);
  return parts.join(' ');
}

function getCategoryIcon(category, isDirectory) {
  if (isDirectory) return '📁';
  switch (category) {
    case 'image':
      return '🖼️';
    case 'video':
      return '🎬';
    case 'audio':
      return '🎵';
    case 'document':
      return '📕';
    case 'text':
      return '📝';
    case 'archive':
      return '📦';
    default:
      return '📄';
  }
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 3500);
}

async function apiRequest(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const res = await fetch(url, {
    ...options,
    headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP Error ${res.status}`);
  }
  return data;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ================= PUBLIC SHARE PORTAL (/s/:token) =================
async function initPublicShareScreen(shareToken) {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-screen').classList.add('hidden');
  document.getElementById('public-share-screen').classList.remove('hidden');

  const errEl = document.getElementById('pub-share-error');
  const pwdForm = document.getElementById('pub-share-password-form');
  const contentBox = document.getElementById('pub-share-content');

  try {
    const data = await apiRequest(`/api/public/share/${encodeURIComponent(shareToken)}`);
    const share = data.share;

    document.getElementById('pub-share-icon').textContent = getCategoryIcon(
      share.category,
      share.isDirectory
    );
    document.getElementById('pub-share-name').textContent = share.itemName;
    document.getElementById('pub-share-meta').textContent = share.isDirectory
      ? 'โฟลเดอร์ที่แชร์จาก Personal NAS (ดาวน์โหลดเป็น .ZIP)'
      : 'ไฟล์ที่แชร์จาก Personal NAS';

    const renderUnlockedShare = (passwordValue = '') => {
      pwdForm.classList.add('hidden');
      contentBox.classList.remove('hidden');

      document.getElementById('pub-share-owner').textContent = share.ownerUsername;
      document.getElementById('pub-share-size').textContent = formatBytes(share.size);
      document.getElementById('pub-share-expires').textContent = share.expiresAt
        ? formatDate(share.expiresAt)
        : 'ไม่หมดอายุ';
      document.getElementById('pub-share-downloads').textContent =
        share.maxDownloads > 0
          ? `${share.downloadCount} / ${share.maxDownloads} ครั้ง`
          : `${share.downloadCount} ครั้ง (ไม่จำกัด)`;

      const pwdParam = passwordValue ? `&password=${encodeURIComponent(passwordValue)}` : '';
      const dlUrl = `/api/public/share/${encodeURIComponent(shareToken)}/download?dl=1${pwdParam}`;
      const inlineUrl = `/api/public/share/${encodeURIComponent(shareToken)}/download?inline=1${pwdParam}`;

      const dlBtn = document.getElementById('pub-share-download-btn');
      dlBtn.href = dlUrl;
      dlBtn.textContent = share.isDirectory
        ? '📦 ดาวน์โหลดทั้งโฟลเดอร์เป็น .ZIP'
        : '⬇️ ดาวน์โหลดไฟล์นี้';

      const previewBox = document.getElementById('pub-share-preview');
      previewBox.innerHTML = '';
      if (!share.isDirectory && ['image', 'video', 'audio'].includes(share.category)) {
        previewBox.classList.remove('hidden');
        if (share.category === 'image') {
          previewBox.innerHTML = `<img src="${inlineUrl}" alt="${escapeHtml(share.itemName)}" />`;
        } else if (share.category === 'video') {
          previewBox.innerHTML = `<video src="${inlineUrl}" controls></video>`;
        } else if (share.category === 'audio') {
          previewBox.innerHTML = `<audio src="${inlineUrl}" controls></audio>`;
        }
      }
    };

    if (share.hasPassword) {
      pwdForm.classList.remove('hidden');
      pwdForm.onsubmit = async (e) => {
        e.preventDefault();
        errEl.classList.add('hidden');
        const pwd = document.getElementById('pub-share-password-input').value;
        try {
          await apiRequest(`/api/public/share/${encodeURIComponent(shareToken)}/verify`, {
            method: 'POST',
            body: { password: pwd },
          });
          renderUnlockedShare(pwd);
        } catch (err) {
          errEl.textContent = err.message;
          errEl.classList.remove('hidden');
        }
      };
    } else {
      renderUnlockedShare('');
    }
  } catch (err) {
    document.getElementById('pub-share-name').textContent = 'ไม่สามารถเข้าถึงลิงก์แชร์นี้ได้';
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

// ================= PUBLIC FILE DROP PORTAL (/d/:token - PHASE 6) =================
async function initPublicDropScreen(dropToken) {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-screen').classList.add('hidden');
  document.getElementById('public-share-screen').classList.add('hidden');
  document.getElementById('public-drop-screen').classList.remove('hidden');

  const errEl = document.getElementById('pub-drop-error');
  const pwdForm = document.getElementById('pub-drop-password-form');
  const contentBox = document.getElementById('pub-drop-content');

  try {
    const data = await apiRequest(`/api/public/drop/${encodeURIComponent(dropToken)}`);
    const reqInfo = data.dropRequest;

    document.getElementById('pub-drop-title').textContent = reqInfo.title;
    document.getElementById('pub-drop-meta').textContent = `รับฝากไฟล์โดย ${reqInfo.ownerUsername}`;

    const renderUnlockedDrop = (passwordValue = '') => {
      pwdForm.classList.add('hidden');
      contentBox.classList.remove('hidden');

      document.getElementById('pub-drop-owner').textContent = reqInfo.ownerUsername;
      document.getElementById('pub-drop-folder').textContent = reqInfo.folderName;
      document.getElementById('pub-drop-expires').textContent = reqInfo.expiresAt
        ? formatDate(reqInfo.expiresAt)
        : 'ไม่หมดอายุ';

      const uploadForm = document.getElementById('pub-drop-upload-form');
      uploadForm.onsubmit = async (e) => {
        e.preventDefault();
        errEl.classList.add('hidden');
        const sender = document.getElementById('pub-drop-sender').value.trim();
        const fileList = document.getElementById('pub-drop-files').files;
        if (!fileList || fileList.length === 0) return;

        const btn = document.getElementById('pub-drop-submit-btn');
        const statusEl = document.getElementById('pub-drop-status');
        btn.disabled = true;
        statusEl.classList.remove('hidden');

        try {
          for (let i = 0; i < fileList.length; i++) {
            const f = fileList[i];
            statusEl.textContent = `⏳ กำลังอัปโหลดไฟล์ที่ ${i + 1}/${fileList.length}: ${f.name}...`;
            const pwdParam = passwordValue ? `&password=${encodeURIComponent(passwordValue)}` : '';
            const url = `/api/public/drop/${encodeURIComponent(dropToken)}/upload?filename=${encodeURIComponent(f.name)}&sender=${encodeURIComponent(sender)}${pwdParam}`;
            const res = await fetch(url, {
              method: 'POST',
              body: f,
            });
            const rJson = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(rJson.error || `Upload failed (${res.status})`);
          }
          statusEl.textContent = `✅ ส่งไฟล์ทั้งหมด (${fileList.length} ไฟล์) เข้าสู่ NAS สำเร็จแล้ว!`;
          showToast('ส่งไฟล์เข้าสู่ NAS เรียบร้อยแล้ว ขอบคุณครับ!', 'success');
          document.getElementById('pub-drop-files').value = '';
        } catch (err) {
          errEl.textContent = err.message;
          errEl.classList.remove('hidden');
        } finally {
          btn.disabled = false;
        }
      };
    };

    if (reqInfo.hasPassword) {
      pwdForm.classList.remove('hidden');
      pwdForm.onsubmit = async (e) => {
        e.preventDefault();
        errEl.classList.add('hidden');
        const pwd = document.getElementById('pub-drop-password-input').value;
        try {
          await apiRequest(`/api/public/drop/${encodeURIComponent(dropToken)}/verify`, {
            method: 'POST',
            body: { password: pwd },
          });
          renderUnlockedDrop(pwd);
        } catch (err) {
          errEl.textContent = err.message;
          errEl.classList.remove('hidden');
        }
      };
    } else {
      renderUnlockedDrop('');
    }
  } catch (err) {
    document.getElementById('pub-drop-title').textContent = 'ไม่สามารถเปิดลิงก์รับฝากไฟล์นี้ได้';
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

// ================= AUTH & INITIALIZATION =================
async function checkSession() {
  if (window.location.pathname.startsWith('/s/')) {
    const shareToken = decodeURIComponent(window.location.pathname.slice(3));
    if (shareToken) {
      initPublicShareScreen(shareToken);
      return;
    }
  }
  if (window.location.pathname.startsWith('/d/')) {
    const dropToken = decodeURIComponent(window.location.pathname.slice(3));
    if (dropToken) {
      initPublicDropScreen(dropToken);
      return;
    }
  }

  try {
    const data = await apiRequest('/api/auth/me');
    state.user = data.user;
    enterAppScreen();
  } catch {
    showLoginScreen();
  }
}

function showLoginScreen() {
  if (state.statsTimer) {
    clearInterval(state.statsTimer);
    state.statsTimer = null;
  }
  document.getElementById('app-screen').classList.add('hidden');
  document.getElementById('public-share-screen').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
}

function enterAppScreen() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('public-share-screen').classList.add('hidden');
  document.getElementById('app-screen').classList.remove('hidden');

  document.getElementById('current-username').textContent = state.user.username;
  const isAdmin = state.user.role === 'admin';
  const roleLabel = isAdmin ? 'Administrator (Root)' : 'User (พื้นที่ส่วนตัว)';
  document.getElementById('current-user-role').textContent = isAdmin ? 'Admin' : 'User';
  const initial = (state.user.username || 'U').charAt(0).toUpperCase();
  const topAvatar = document.getElementById('topbar-user-avatar');
  const dropAvatar = document.getElementById('dropdown-user-avatar');
  const dropName = document.getElementById('dropdown-username');
  const dropRole = document.getElementById('dropdown-user-role');
  if (topAvatar) topAvatar.textContent = initial;
  if (dropAvatar) dropAvatar.textContent = initial;
  if (dropName) dropName.textContent = state.user.username;
  if (dropRole) dropRole.textContent = roleLabel;

  // Show/hide Admin Users Management & Audit Logs tabs
  document.getElementById('nav-users').classList.toggle('hidden', !isAdmin);
  document.getElementById('nav-audit')?.classList.toggle('hidden', !isAdmin);

  loadDirectory(state.currentPath);
  loadTrashCount();
  loadSharesCount();
  fetchSystemStats();

  if (state.statsTimer) clearInterval(state.statsTimer);
  state.statsTimer = setInterval(fetchSystemStats, 3000);
}

// ================= SYSTEM STATS & QUOTA =================
async function fetchSystemStats(force = false) {
  if (!force && state.uploadController && state.uploadController.active) {
    return;
  }
  try {
    const stats = await apiRequest('/api/system/stats');

    document.getElementById('sidebar-hostname').textContent = stats.hostname;

    const uq = stats.userQuota;
    if (uq && uq.quotaBytes > 0) {
      document.getElementById('side-storage-label').textContent = '💾 โควตาพื้นที่ของคุณ';
      document.getElementById('side-disk-percent').textContent = `${uq.usagePercent}%`;
      document.getElementById('side-disk-bar').style.width = `${uq.usagePercent}%`;
      document.getElementById('side-disk-text').textContent = `ใช้ไป ${formatBytes(uq.usedBytes)} จากโควตา ${formatBytes(uq.quotaBytes)}`;
    } else {
      document.getElementById('side-storage-label').textContent = '💾 พื้นที่จัดเก็บข้อมูล (Disk)';
      document.getElementById('side-disk-percent').textContent = `${stats.disk.usagePercent}%`;
      document.getElementById('side-disk-bar').style.width = `${stats.disk.usagePercent}%`;
      document.getElementById('side-disk-text').textContent = `ว่าง ${formatBytes(stats.disk.freeBytes)} จาก ${formatBytes(stats.disk.totalBytes)}`;
    }

    document.getElementById('side-cpu-percent').textContent = `${stats.cpu.usagePercent}%`;
    document.getElementById('side-ram-percent').textContent = `${stats.memory.usagePercent}%`;

    // System Monitor Tab
    document.getElementById('sys-disk-percent').textContent = `${stats.disk.usagePercent}%`;
    document.getElementById('sys-disk-bar').style.width = `${stats.disk.usagePercent}%`;
    document.getElementById('sys-disk-total').textContent = formatBytes(stats.disk.totalBytes);
    document.getElementById('sys-disk-used').textContent = formatBytes(stats.disk.usedBytes);
    document.getElementById('sys-disk-free').textContent = formatBytes(stats.disk.freeBytes);
    document.getElementById('sys-nas-files-size').textContent = `${formatBytes(stats.disk.nasFilesBytes)} (${stats.disk.nasFilesCount} ไฟล์ / ${stats.disk.nasFoldersCount} โฟลเดอร์)`;
    document.getElementById('sys-nas-trash-size').textContent = formatBytes(stats.disk.nasTrashBytes);
    const locLabel = document.getElementById('sys-storage-location-label');
    if (locLabel && stats.storageConfig) {
      const isCust = stats.storageConfig.isCustom;
      locLabel.textContent = `${stats.storageConfig.currentPath} (${isCust ? 'ไดรฟ์ภายนอก' : 'โฟลเดอร์เริ่มต้น'})`;
    }

    document.getElementById('sys-cpu-model').textContent = stats.cpu.model;
    document.getElementById('sys-cpu-percent').textContent = `${stats.cpu.usagePercent}%`;
    document.getElementById('sys-cpu-bar').style.width = `${stats.cpu.usagePercent}%`;
    document.getElementById('sys-cpu-cores').textContent = `${stats.cpu.cores} Cores`;
    document.getElementById('sys-cpu-load').textContent = stats.cpu.loadAvg.join(' / ');
    document.getElementById('sys-os-platform').textContent = stats.platform;
    document.getElementById('sys-uptime').textContent = formatUptime(stats.uptimeSeconds);

    document.getElementById('sys-ram-percent').textContent = `${stats.memory.usagePercent}%`;
    document.getElementById('sys-ram-bar').style.width = `${stats.memory.usagePercent}%`;
    document.getElementById('sys-ram-total').textContent = formatBytes(stats.memory.totalBytes);
    document.getElementById('sys-ram-used').textContent = formatBytes(stats.memory.usedBytes);
    document.getElementById('sys-ram-free').textContent = formatBytes(stats.memory.freeBytes);
    const cachedEl = document.getElementById('sys-ram-cached');
    if (cachedEl) {
      cachedEl.textContent = formatBytes(stats.memory.cachedBytes || 0);
    }

    renderTelemetryAreaChartAndAlerts(stats);

    const lanList = document.getElementById('sys-lan-list');
    const port = window.location.port ? `:${window.location.port}` : '';
    const lans = stats.network.lanAddresses || [];
    lanList.innerHTML = '';

    if (lans.length === 0) {
      lanList.innerHTML = `<div class="lan-item"><span>Localhost</span><code>http://localhost${port}</code></div>`;
    } else {
      lans.forEach((lan) => {
        const url = `http://${lan.address}${port}`;
        const row = document.createElement('div');
        row.className = 'lan-item';
        row.innerHTML = `
          <div>
            <strong>${lan.interface}</strong>
            <div style="font-size:12px;color:var(--text-secondary)">เครือข่ายภายในบ้าน (LAN/Wi-Fi)</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <code>${url}</code>
            <button type="button" class="btn btn-secondary btn-sm btn-lan-qr">📱 QR</button>
          </div>
        `;
        row.querySelector('.btn-lan-qr')?.addEventListener('click', () => {
          openQrCodeModal(url, `📱 สแกนเพื่อเข้าใช้งาน NAS ผ่านวง LAN (${lan.interface})`);
        });
        lanList.appendChild(row);
      });
    }
  } catch {
    // Ignore transient polling errors
  }
}

function buildSmoothSvgPath(points) {
  if (!points || points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const midX = ((p0.x + p1.x) / 2).toFixed(1);
    d += ` C ${midX} ${p0.y.toFixed(1)}, ${midX} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }
  return d;
}

function renderTelemetryAreaChartAndAlerts(stats) {
  state.lastSystemStats = stats;
  if (!Array.isArray(state.telemetryHistory)) {
    state.telemetryHistory = [];
  }

  const cpuPct = Math.max(0, Math.min(100, Number(stats.cpu?.usagePercent || 0)));
  const ramPct = Math.max(0, Math.min(100, Number(stats.memory?.usagePercent || 0)));
  const diskPct = Math.max(0, Math.min(100, Number(stats.disk?.usagePercent || 0)));

  // Seed initial points so the area chart looks full immediately on first load
  if (state.telemetryHistory.length === 0) {
    for (let i = 0; i < 19; i++) {
      state.telemetryHistory.push({ cpu: cpuPct, ram: ramPct });
    }
  }
  state.telemetryHistory.push({ cpu: cpuPct, ram: ramPct });
  if (state.telemetryHistory.length > 24) {
    state.telemetryHistory.shift();
  }

  const svg = document.getElementById('telemetry-area-svg');
  if (svg) {
    const isLight = state.theme === 'light';
    const gridStroke = isLight ? '#E2E8F0' : '#2C2C2E';
    const textFill = isLight ? '#64748B' : '#98989D';
    const cpuStroke = isLight ? '#0088A9' : '#00E5FF';
    const ramStroke = isLight ? '#16A34A' : '#32D74B';
    const baseStopColor = isLight ? '#F8FAFC' : '#121212';

    const width = 720;
    const height = 210;
    const padTop = 14;
    const padBottom = 18;
    const usableH = height - padTop - padBottom;
    const list = state.telemetryHistory;
    const count = list.length;

    const toCoords = (key) =>
      list.map((pt, idx) => {
        const x = count <= 1 ? 0 : (idx / (count - 1)) * width;
        const val = Math.max(0, Math.min(100, Number(pt[key] || 0)));
        const y = padTop + usableH - (val / 100) * usableH;
        return { x, y };
      });

    const cpuPts = toCoords('cpu');
    const ramPts = toCoords('ram');
    const cpuLine = buildSmoothSvgPath(cpuPts);
    const ramLine = buildSmoothSvgPath(ramPts);
    const baseY = (padTop + usableH).toFixed(1);
    const cpuArea = `${cpuLine} L ${width} ${baseY} L 0 ${baseY} Z`;
    const ramArea = `${ramLine} L ${width} ${baseY} L 0 ${baseY} Z`;

    const gridLines = [0.25, 0.5, 0.75].map((r) => {
      const y = (padTop + usableH * (1 - r)).toFixed(1);
      const label = `${Math.round(r * 100)}%`;
      return `
        <line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="${gridStroke}" stroke-width="1" stroke-dasharray="4 4" />
        <text x="8" y="${Number(y) - 4}" fill="${textFill}" font-size="10" font-family="JetBrains Mono, monospace">${label}</text>
      `;
    });

    svg.innerHTML = `
      <defs>
        <linearGradient id="wattCyanGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${cpuStroke}" stop-opacity="0.42" />
          <stop offset="65%" stop-color="#30D158" stop-opacity="0.14" />
          <stop offset="100%" stop-color="${baseStopColor}" stop-opacity="0.0" />
        </linearGradient>
        <linearGradient id="wattLimeGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${ramStroke}" stop-opacity="0.28" />
          <stop offset="100%" stop-color="${baseStopColor}" stop-opacity="0.0" />
        </linearGradient>
      </defs>
      ${gridLines.join('')}
      <path d="${ramArea}" fill="url(#wattLimeGrad)" />
      <path d="${ramLine}" fill="none" stroke="${ramStroke}" stroke-width="2" />
      <path d="${cpuArea}" fill="url(#wattCyanGrad)" />
      <path d="${cpuLine}" fill="none" stroke="${cpuStroke}" stroke-width="2.6" />
    `;
  }

  const alertsEl = document.getElementById('telemetry-alerts-list');
  if (alertsEl) {
    const alerts = [];
    if (cpuPct >= 80) {
      alerts.push(
        `<div class="watt-alert-box">⚡ <strong>แจ้งเตือนโหลด CPU สูง (Peak Load):</strong> ขณะนี้ CPU ทำงานอยู่ที่ <code>${cpuPct}%</code></div>`
      );
    }
    if (ramPct >= 85) {
      alerts.push(
        `<div class="watt-alert-box">🔌 <strong>แจ้งเตือนหน่วยความจำตึงตัว (RAM High):</strong> ใช้งานจริงอยู่ที่ <code>${ramPct}%</code> (เหลือว่าง ${formatBytes(stats.memory?.freeBytes || 0)})</div>`
      );
    }
    if (diskPct >= 85) {
      alerts.push(
        `<div class="watt-alert-box">📟 <strong>แจ้งเตือนพื้นที่จัดเก็บใกล้เต็ม (Disk Alert):</strong> ใช้พื้นที่ไปแล้ว <code>${diskPct}%</code></div>`
      );
    }

    if (alerts.length === 0) {
      alertsEl.innerHTML = `
        <div class="watt-live-box">
          ⚡ <strong>สถานะระบบปกติ (Optimal Telemetry):</strong> ไม่พบการพุ่งสูงผิดปกติของโหลด CPU (${cpuPct}%), RAM (${ramPct}%) หรือพื้นที่ดิสก์ (${diskPct}%)
        </div>
      `;
    } else {
      alertsEl.innerHTML = alerts.join('');
    }
  }
}

// ================= NAVIGATION TABS =================
function switchTab(tabName) {
  state.activeTab = tabName;

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.mob-nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mobTab === tabName);
  });
  toggleMobileSidebar(false);
  closeFileContextMenu();

  document.getElementById('view-files').classList.toggle('hidden', tabName !== 'files');
  document.getElementById('view-favorites')?.classList.toggle('hidden', tabName !== 'favorites');
  document.getElementById('view-gallery')?.classList.toggle('hidden', tabName !== 'gallery');
  document.getElementById('view-clipboard')?.classList.toggle('hidden', tabName !== 'clipboard');
  document.getElementById('view-indexer').classList.toggle('hidden', tabName !== 'indexer');
  document.getElementById('view-analyzer')?.classList.toggle('hidden', tabName !== 'analyzer');
  document.getElementById('view-shares').classList.toggle('hidden', tabName !== 'shares');
  document.getElementById('view-trash').classList.toggle('hidden', tabName !== 'trash');
  document.getElementById('view-users').classList.toggle('hidden', tabName !== 'users');
  document.getElementById('view-advanced').classList.toggle('hidden', tabName !== 'advanced');
  document.getElementById('view-audit')?.classList.toggle('hidden', tabName !== 'audit');
  document.getElementById('view-system').classList.toggle('hidden', tabName !== 'system');

  const isFiles = tabName === 'files';
  document.getElementById('topbar-left-files').classList.toggle('hidden', !isFiles);
  document.getElementById('topbar-left-title').classList.toggle('hidden', isFiles);
  document.getElementById('file-search-wrapper').classList.toggle('hidden', !isFiles);
  document.getElementById('file-toolbar-actions').classList.toggle('hidden', !isFiles);

  if (!isFiles) {
    clearSelection();
  }

  if (tabName === 'favorites') {
    document.getElementById('view-header-title').textContent =
      '⭐ รายการโปรดของคุณ (Starred Files & Folders)';
    loadFavoritesView();
  } else if (tabName === 'gallery') {
    document.getElementById('view-header-title').textContent =
      '📸 แกลเลอรีรูปภาพและวิดีโอ (Photo Gallery & Media Center)';
    loadMediaGalleryView(state.galleryFilter || 'all');
  } else if (tabName === 'clipboard') {
    document.getElementById('view-header-title').textContent =
      '📋 คลิปบอร์ดและข้อความข้ามเครื่อง (Cross-Device Clipboard & Snippet Hub)';
    loadClipboardView();
  } else if (tabName === 'indexer') {
    document.getElementById('view-header-title').textContent =
      '🔍 ค้นหาไฟล์ทั่วระบบ & ตรวจจับไฟล์ซ้ำ (Fast Indexer)';
    runGlobalSearch();
  } else if (tabName === 'analyzer') {
    document.getElementById('view-header-title').textContent =
      '📈 วิเคราะห์การใช้พื้นที่เชิงลึก (Deep Storage Analyzer)';
    loadStorageAnalyzerView();
  } else if (tabName === 'shares') {
    document.getElementById('view-header-title').textContent =
      '🔗 ลิงก์แชร์ดาวน์โหลด & 📥 ลิงก์รับฝากไฟล์ (Public Shares & File Drop)';
    loadSharesList();
    loadFileRequestsList();
  } else if (tabName === 'trash') {
    document.getElementById('view-header-title').textContent = '🗑️ ถังขยะ (Recycle Bin)';
    loadTrashItems();
  } else if (tabName === 'users') {
    document.getElementById('view-header-title').textContent = '👥 จัดการผู้ใช้ & โควตา (User Management)';
    loadUsersList();
    loadUploadPolicy();
  } else if (tabName === 'advanced') {
    document.getElementById('view-header-title').textContent =
      '🛡️ สำรองข้อมูลอัตโนมัติ & WebDAV Network Drive';
    loadBackupsAndWebdav();
  } else if (tabName === 'audit') {
    document.getElementById('view-header-title').textContent =
      '📜 ประวัติการใช้งานระบบ & ความปลอดภัย (Audit Logs & Brute-force Security)';
    loadAuditLogsView();
  } else if (tabName === 'system') {
    document.getElementById('view-header-title').textContent = '📊 สถานะเซิร์ฟเวอร์ (System Monitor)';
    fetchSystemStats();
    fetchTopProcessesTelemetry();
  } else {
    loadDirectory(state.currentPath);
  }
}

// ================= MULTI-SELECTION & BATCH ACTIONS =================
function updateSelectionBar() {
  const bar = document.getElementById('selection-bar');
  const countText = document.getElementById('selection-count-text');
  const count = state.selectedPaths.size;

  if (count === 0 || state.activeTab !== 'files') {
    bar.classList.add('hidden');
  } else {
    countText.textContent = `เลือก ${count} รายการ`;
    bar.classList.remove('hidden');
  }
}

function clearSelection() {
  state.selectedPaths.clear();
  updateSelectionBar();
  document.querySelectorAll('.file-card').forEach((card) => {
    card.classList.remove('selected');
  });
  document.querySelectorAll('.file-select-check').forEach((chk) => {
    chk.checked = false;
  });
}

function downloadAsZip(pathsArray) {
  if (!pathsArray || pathsArray.length === 0) return;
  const encoded = encodeURIComponent(JSON.stringify(pathsArray));
  window.location.href = `/api/files/zip?paths=${encoded}`;
}

async function openFolderPickerModal(mode, sourcePaths) {
  try {
    const data = await apiRequest('/api/files/folders');
    const select = document.getElementById('folder-picker-select');
    select.innerHTML = '';

    (data.folders || ['/']).forEach((folder) => {
      const opt = document.createElement('option');
      opt.value = folder;
      opt.textContent = folder === '/' ? '/ (หน้าหลักของคุณ)' : folder;
      if (folder === state.currentPath) opt.selected = true;
      select.appendChild(opt);
    });

    const isMove = mode === 'move';
    document.getElementById('folder-picker-title').textContent = isMove
      ? `📂 ย้าย ${sourcePaths.length} รายการไปที่...`
      : `📋 คัดลอก ${sourcePaths.length} รายการไปที่...`;
    document.getElementById('confirm-folder-picker-btn').textContent = isMove
      ? 'ย้ายรายการ'
      : 'คัดลอกรายการ';

    state.folderPickerCallback = async (targetDir) => {
      const endpoint = isMove ? '/api/files/move' : '/api/files/copy';
      await apiRequest(endpoint, {
        method: 'POST',
        body: { paths: sourcePaths, targetDir },
      });
      showToast(
        isMove ? `ย้ายรายการไปยัง ${targetDir} สำเร็จ` : `คัดลอกรายการไปยัง ${targetDir} สำเร็จ`,
        'success'
      );
      clearSelection();
      loadDirectory(state.currentPath);
      fetchSystemStats();
    };

    document.getElementById('folder-picker-modal').classList.remove('hidden');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function closeFolderPickerModal() {
  document.getElementById('folder-picker-modal').classList.add('hidden');
  state.folderPickerCallback = null;
}

// ================= FILE EXPLORER =================
async function loadDirectory(targetPath = '/') {
  try {
    const data = await apiRequest(`/api/files?path=${encodeURIComponent(targetPath)}`);
    state.currentPath = data.currentPath;
    state.files = data.items;
    state.selectedPaths.clear();
    updateSelectionBar();
    document.getElementById('drag-target-folder').textContent = `โฟลเดอร์ปัจจุบัน: ${state.currentPath}`;
    renderBreadcrumbs();
    renderFiles();
    loadRecentFilesStrip();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderBreadcrumbs() {
  const nav = document.getElementById('breadcrumbs');
  nav.innerHTML = '';

  const parts = state.currentPath.split('/').filter(Boolean);

  const rootBtn = document.createElement('button');
  rootBtn.className = `crumb-btn ${parts.length === 0 ? 'active' : ''}`;
  rootBtn.textContent = state.user?.role === 'admin' ? '🏠 หน้าหลัก (Root)' : `🏠 พื้นที่ของ ${state.user?.username}`;
  rootBtn.onclick = () => loadDirectory('/');
  nav.appendChild(rootBtn);

  let accPath = '';
  parts.forEach((part, index) => {
    accPath += `/${part}`;
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = '/';
    nav.appendChild(sep);

    const btn = document.createElement('button');
    const isLast = index === parts.length - 1;
    btn.className = `crumb-btn ${isLast ? 'active' : ''}`;
    btn.textContent = part;
    const clickPath = accPath;
    btn.onclick = () => loadDirectory(clickPath);
    nav.appendChild(btn);
  });
}

function getSortedAndFilteredFiles() {
  const q = state.searchQuery.trim().toLowerCase();
  const tagFilter = state.tagFilter || 'all';
  const filtered = state.files.filter((item) => {
    const matchName = !q ? true : item.name.toLowerCase().includes(q) || (item.tagNote || '').toLowerCase().includes(q);
    const matchTag = tagFilter === 'all' ? true : item.tagColor === tagFilter;
    return matchName && matchTag;
  });

  filtered.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }

    switch (state.sortBy) {
      case 'name-desc':
        return b.name.localeCompare(a.name, 'th');
      case 'size-desc':
        return (b.size || 0) - (a.size || 0);
      case 'size-asc':
        return (a.size || 0) - (b.size || 0);
      case 'date-desc':
        return new Date(b.modifiedAt) - new Date(a.modifiedAt);
      case 'date-asc':
        return new Date(a.modifiedAt) - new Date(b.modifiedAt);
      case 'name-asc':
      default:
        return a.name.localeCompare(b.name, 'th');
    }
  });

  return filtered;
}

function renderFiles() {
  const container = document.getElementById('files-container');
  const emptyEl = document.getElementById('files-empty');

  container.className = state.viewMode === 'grid' ? 'files-grid' : 'files-list';
  container.innerHTML = '';

  const filtered = getSortedAndFilteredFiles();

  if (filtered.length === 0) {
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');

  filtered.forEach((item) => {
    const isSelected = state.selectedPaths.has(item.path);
    const card = document.createElement('div');
    card.className = `file-card has-checkbox ${isSelected ? 'selected' : ''}`;

    const icon = item.isVault ? '🔐' : getCategoryIcon(item.category, item.isDirectory);
    const metaText = item.isDirectory
      ? `${item.childCount ?? 0} รายการ • ${formatDate(item.modifiedAt)}`
      : `${formatBytes(item.size)} • ${formatDate(item.modifiedAt)}`;

    const thumbHtml = item.hasThumbnail
      ? `<div class="file-thumb-box">
           <img src="/api/files/thumbnail?path=${encodeURIComponent(item.path)}" alt="${escapeHtml(item.name)}" loading="lazy" />
         </div>`
      : '';

    const versionBadge =
      !item.isDirectory && item.versionCount > 0
        ? `<span class="version-pill" title="มีเวอร์ชันย้อนหลัง ${item.versionCount} เวอร์ชัน">v${item.versionCount}</span>`
        : '';

    const tagDotHtml =
      item.tagColor && item.tagColor !== 'none'
        ? `<span class="tag-dot ${escapeHtml(item.tagColor)}" title="ป้ายสี: ${escapeHtml(item.tagColor)}"></span>`
        : '';

    const vaultBadgeHtml = item.isVault
      ? `<span class="vault-pill" title="เข้ารหัสด้วย AES-256-GCM">AES-256</span>`
      : '';

    const noteHtml = item.tagNote
      ? `<div class="note-pill">📝 ${escapeHtml(item.tagNote)}</div>`
      : '';

    card.innerHTML = `
      <input type="checkbox" class="file-select-check" ${isSelected ? 'checked' : ''} title="เลือกรายการนี้" />
      ${thumbHtml}
      <div class="file-card-top">
        <div class="file-icon">${icon}</div>
        <div class="file-info">
          <div class="file-name" title="${escapeHtml(item.name)}">${tagDotHtml}${escapeHtml(item.name)}${versionBadge}${vaultBadgeHtml}</div>
          <div class="file-meta">${metaText}</div>
          ${noteHtml}
        </div>
      </div>
      <div class="file-actions">
        <button class="action-btn action-btn-icon btn-star ${item.isStarred ? 'starred' : ''}" title="${item.isStarred ? 'นำออกจากรายการโปรด' : 'เพิ่มในรายการโปรด'}">
          ${item.isStarred ? '⭐' : '☆'}
        </button>
        ${
          item.isDirectory
            ? `<button class="action-btn action-btn-flex btn-zip" title="ดาวน์โหลดทั้งโฟลเดอร์เป็น .ZIP">📦 ZIP</button>`
            : `<button class="action-btn action-btn-flex btn-download" title="ดาวน์โหลดไฟล์ลงเครื่อง">⬇️ โหลด</button>`
        }
        <button class="action-btn action-btn-flex btn-share" title="สร้างลิงก์แชร์สาธารณะ & QR Code">🔗 แชร์</button>
        <button class="action-btn action-btn-flex btn-more-actions" title="คำสั่งจัดการทั้งหมด (เปลี่ยนชื่อ, ย้าย, คัดลอก, แต่งรูป, ป้ายสี, ลบ ฯลฯ)">⋯ จัดการ</button>
      </div>
    `;

    // Selection Checkbox
    const checkbox = card.querySelector('.file-select-check');
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
      if (checkbox.checked) {
        state.selectedPaths.add(item.path);
        card.classList.add('selected');
      } else {
        state.selectedPaths.delete(item.path);
        card.classList.remove('selected');
      }
      updateSelectionBar();
    });

    // Main card click: open directory, unlock vault, or preview file
    card.addEventListener('click', (e) => {
      if (e.target.closest('.action-btn') || e.target.closest('.file-select-check')) return;
      if (item.isDirectory) {
        loadDirectory(item.path);
      } else if (item.isVault) {
        openVaultModal(item);
      } else {
        const mediaPlaylist = filtered.filter((f) => !f.isDirectory && (f.category === 'image' || f.category === 'video'));
        openFilePreview(item, mediaPlaylist);
      }
    });

    card.querySelector('.btn-star').addEventListener('click', async (e) => {
      e.stopPropagation();
      await toggleStarItem(item.path);
    });

    card.querySelector('.btn-inspector')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openFileInspector(item);
    });

    // Phase 9: Right-Click Context Menu on File/Folder Card
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openFileContextMenu(e, item, filtered);
    });

    // Phase 9: Internal Drag-and-Drop to Move Items into a Folder Card
    card.setAttribute('draggable', 'true');
    card.addEventListener('dragstart', (e) => {
      state.draggingInternalCard = true;
      const pathsToDrag =
        state.selectedPaths.has(item.path) && state.selectedPaths.size > 1
          ? Array.from(state.selectedPaths)
          : [item.path];
      state.draggedFilePaths = pathsToDrag;
      e.dataTransfer?.setData('text/plain', JSON.stringify(pathsToDrag));
    });
    card.addEventListener('dragend', () => {
      state.draggingInternalCard = false;
      state.draggedFilePaths = null;
      document
        .querySelectorAll('.file-card.drop-folder-hover')
        .forEach((el) => el.classList.remove('drop-folder-hover'));
    });

    if (item.isDirectory) {
      card.addEventListener('dragover', (e) => {
        if (!state.draggingInternalCard) return;
        const dragged = state.draggedFilePaths || [];
        if (dragged.includes(item.path)) return;
        e.preventDefault();
        e.stopPropagation();
        card.classList.add('drop-folder-hover');
      });
      card.addEventListener('dragleave', () => {
        card.classList.remove('drop-folder-hover');
      });
      card.addEventListener('drop', async (e) => {
        card.classList.remove('drop-folder-hover');
        if (!state.draggingInternalCard) return;
        e.preventDefault();
        e.stopPropagation();
        const dragged = state.draggedFilePaths || [];
        state.draggingInternalCard = false;
        state.draggedFilePaths = null;
        if (dragged.length === 0 || dragged.includes(item.path)) return;
        try {
          await apiRequest('/api/files/move', {
            method: 'POST',
            body: { paths: dragged, targetDir: item.path },
          });
          showToast(`📂 ย้าย ${dragged.length} รายการเข้าสู่โฟลเดอร์ "${item.name}" แล้ว!`, 'success');
          clearSelection();
          loadDirectory(state.currentPath);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    }

    card.querySelector('.btn-more-actions')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const btnRect = e.currentTarget.getBoundingClientRect();
      openFileContextMenu(
        { clientX: btnRect.left, clientY: btnRect.bottom + 6 },
        item,
        filtered
      );
    });

    card.querySelector('.btn-tag')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openTagModal(item);
    });

    const extractBtn = card.querySelector('.btn-extract');
    if (extractBtn) {
      extractBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await extractArchiveItem(item);
      });
    }

    const imgStudioBtn = card.querySelector('.btn-img-studio');
    if (imgStudioBtn) {
      imgStudioBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openImageStudioModal(item);
      });
    }

    const jukeboxBtn = card.querySelector('.btn-jukebox');
    if (jukeboxBtn) {
      jukeboxBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const audioPlaylist = filtered.filter((f) => !f.isDirectory && f.category === 'audio');
        playAudioTrackInMiniPlayer(item, audioPlaylist);
      });
    }

    const checksumBtn = card.querySelector('.btn-checksum');
    if (checksumBtn) {
      checksumBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openChecksumModal(item);
      });
    }

    const vaultBtn = card.querySelector('.btn-vault');
    if (vaultBtn) {
      vaultBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openVaultModal(item);
      });
    }

    const verBtn = card.querySelector('.btn-versions');
    if (verBtn) {
      verBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openVersionsModal(item);
      });
    }

    card.querySelector('.btn-share').addEventListener('click', (e) => {
      e.stopPropagation();
      openShareModal(item);
    });

    const dlBtn = card.querySelector('.btn-download');
    if (dlBtn) {
      dlBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.location.href = `/api/files/download?path=${encodeURIComponent(item.path)}`;
      });
    }

    const zipBtn = card.querySelector('.btn-zip');
    if (zipBtn) {
      zipBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        downloadAsZip([item.path]);
      });
    }

    card.querySelector('.btn-move')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openFolderPickerModal('move', [item.path]);
    });

    card.querySelector('.btn-copy')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openFolderPickerModal('copy', [item.path]);
    });

    card.querySelector('.btn-rename')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openPromptModal('✏️ เปลี่ยนชื่อ', 'ชื่อใหม่:', item.name, async (newName) => {
        await apiRequest('/api/files/rename', {
          method: 'POST',
          body: { path: item.path, newName },
        });
        showToast('เปลี่ยนชื่อเรียบร้อยแล้ว', 'success');
        loadDirectory(state.currentPath);
      });
    });

    const delBtn = card.querySelector('.btn-delete');
    if (delBtn) {
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const confirmed = await openConfirmModal({
          title: item.isDirectory ? '🗑️ ยืนยันการลบโฟลเดอร์' : '🗑️ ยืนยันการลบไฟล์',
          icon: item.isDirectory ? '📁' : '🗑️',
          heading: `ต้องการลบ "${item.name}" ออกใช่หรือไม่?`,
          description:
            'รายการนี้จะถูกย้ายไปเก็บพักไว้ในถังขยะ (Recycle Bin) คุณยังสามารถกู้คืนกลับมาที่เดิมได้ภายหลัง',
          targetText: `${item.isDirectory ? 'โฟลเดอร์' : 'ไฟล์'}: ${item.path}${
            !item.isDirectory ? ` (${formatBytes(item.size)})` : ''
          }`,
          confirmText: '🗑️ ย้ายไปถังขยะ',
        });
        if (!confirmed) return;

        try {
          await apiRequest('/api/files/trash', {
            method: 'POST',
            body: { path: item.path },
          });
          showToast(`ย้าย "${item.name}" ไปที่ถังขยะแล้ว`, 'success');
          loadDirectory(state.currentPath);
          loadTrashCount();
          fetchSystemStats();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    }

    container.appendChild(card);
  });
}

// ================= PUBLIC SHARE LINKS MANAGEMENT (PHASE 3) =================
function openShareModal(item) {
  state.sharingItemPath = item.path;
  document.getElementById('share-modal-title').textContent = `🔗 แชร์ "${item.name}"`;
  document.getElementById('share-form').reset();
  document.getElementById('share-result-box').classList.add('hidden');
  document.getElementById('create-share-submit-btn').classList.remove('hidden');
  document.getElementById('share-modal').classList.remove('hidden');
}

function closeShareModal() {
  document.getElementById('share-modal').classList.add('hidden');
  state.sharingItemPath = null;
}

async function loadSharesCount() {
  try {
    const data = await apiRequest('/api/shares');
    state.shareLinks = data.shares || [];
    const badge = document.getElementById('shares-count-badge');
    if (state.shareLinks.length > 0) {
      badge.textContent = state.shareLinks.length;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch {
    // Ignore
  }
}

async function loadSharesList() {
  try {
    const data = await apiRequest('/api/shares');
    state.shareLinks = data.shares || [];
    loadSharesCount();

    const container = document.getElementById('shares-container');
    const emptyEl = document.getElementById('shares-empty');
    container.innerHTML = '';

    if (state.shareLinks.length === 0) {
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');

    state.shareLinks.forEach((link) => {
      const card = document.createElement('div');
      card.className = 'file-card';
      const shareUrl = `${window.location.origin}/s/${link.id}`;
      const isExpired = link.expires_at && Date.now() > new Date(link.expires_at).getTime();
      const isLimitReached = link.max_downloads > 0 && link.download_count >= link.max_downloads;

      const badges = [];
      if (link.has_password) badges.push(`<span class="pill pill-warn">🔒 มีรหัสผ่าน</span>`);
      else badges.push(`<span class="pill pill-success">🌐 สาธารณะ</span>`);

      if (isExpired) badges.push(`<span class="pill" style="background:rgba(239,68,68,0.2);color:#fca5a5;">หมดอายุแล้ว</span>`);
      else if (isLimitReached) badges.push(`<span class="pill" style="background:rgba(239,68,68,0.2);color:#fca5a5;">ครบจำนวนดาวน์โหลด</span>`);

      const dlText =
        link.max_downloads > 0
          ? `${link.download_count} / ${link.max_downloads} ครั้ง`
          : `${link.download_count} ครั้ง (ไม่จำกัด)`;

      const expText = link.expires_at ? formatDate(link.expires_at) : 'ไม่หมดอายุ';

      card.innerHTML = `
        <div class="file-card-top">
          <div class="file-icon">${link.is_directory ? '📁' : '🔗'}</div>
          <div class="file-info">
            <div class="file-name">
              ${escapeHtml(link.item_name)}
              ${badges.join('')}
            </div>
            <div class="file-meta">
              ลิงก์: <code>${escapeHtml(shareUrl)}</code> • ดาวน์โหลด: <strong>${dlText}</strong> • หมดอายุ: ${expText} • โดย: ${escapeHtml(link.owner_username)}
            </div>
          </div>
        </div>
        <div class="file-actions">
          <button class="btn btn-secondary btn-sm btn-copy-link">📋 คัดลอกลิงก์</button>
          <button class="btn btn-secondary btn-sm btn-qr-link">📱 QR Code</button>
          <a class="btn btn-secondary btn-sm" href="${shareUrl}" target="_blank">🌐 เปิดดู</a>
          <button class="btn btn-danger btn-sm btn-revoke-link">✕ ยกเลิกลิงก์</button>
        </div>
      `;

      card.querySelector('.btn-copy-link').addEventListener('click', () => {
        navigator.clipboard?.writeText(shareUrl);
        showToast('คัดลอกลิงก์แชร์เรียบร้อยแล้ว', 'success');
      });

      card.querySelector('.btn-qr-link')?.addEventListener('click', () => {
        openQrCodeModal(shareUrl, `📱 สแกนเพื่อดาวน์โหลด "${link.item_name}"`);
      });

      card.querySelector('.btn-revoke-link').addEventListener('click', async () => {
        try {
          await apiRequest(`/api/shares/${encodeURIComponent(link.id)}`, {
            method: 'DELETE',
          });
          showToast('ยกเลิกลิงก์แชร์เรียบร้อยแล้ว', 'success');
          loadSharesList();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      container.appendChild(card);
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ================= ADMIN USERS & QUOTA MANAGEMENT (PHASE 3) =================
async function loadUsersList() {
  try {
    const data = await apiRequest('/api/users');
    state.usersList = data.users || [];

    const container = document.getElementById('users-container');
    container.innerHTML = '';

    state.usersList.forEach((u) => {
      const card = document.createElement('div');
      card.className = 'file-card';
      const isSelf = u.id === state.user.id;
      const quotaText =
        u.quota_bytes > 0
          ? `${formatBytes(u.used_bytes)} / ${formatBytes(u.quota_bytes)} (${u.usage_percent}%)`
          : `${formatBytes(u.used_bytes)} / ไม่จำกัด (Unlimited)`;

      const roleBadge =
        u.role === 'admin'
          ? `<span class="pill pill-warn">👑 Admin</span>`
          : `<span class="pill">👤 User</span>`;

      card.innerHTML = `
        <div class="file-card-top">
          <div class="file-icon">${u.role === 'admin' ? '👑' : '👤'}</div>
          <div class="file-info">
            <div class="file-name">
              ${escapeHtml(u.username)} ${roleBadge}
              ${isSelf ? '<span class="pill pill-success">คุณ (กำลังใช้งาน)</span>' : ''}
            </div>
            <div class="file-meta">
              โฟลเดอร์ส่วนตัว: <code>${escapeHtml(u.home_folder)}</code> • พื้นที่ใช้งาน: <strong>${quotaText}</strong> (${u.file_count} ไฟล์)
            </div>
            ${
              u.quota_bytes > 0
                ? `<div class="progress-bar" style="margin-top:8px;max-width:340px;">
                     <div class="progress-fill" style="width:${u.usage_percent}%"></div>
                   </div>`
                : ''
            }
          </div>
        </div>
        <div class="file-actions">
          <button class="btn btn-secondary btn-sm btn-edit-user">✏️ แก้ไขโควตา / สิทธิ์</button>
          ${
            !isSelf
              ? `<button class="btn btn-danger btn-sm btn-delete-user">🗑️ ลบผู้ใช้</button>`
              : ''
          }
        </div>
      `;

      card.querySelector('.btn-edit-user').addEventListener('click', () => {
        openUserModal(u);
      });

      const delBtn = card.querySelector('.btn-delete-user');
      if (delBtn) {
        delBtn.addEventListener('click', async () => {
          const confirmed = await openConfirmModal({
            title: '⚠️ ยืนยันการลบบัญชีผู้ใช้',
            icon: '👤',
            heading: `ต้องการลบบัญชีผู้ใช้ "${u.username}" ใช่หรือไม่?`,
            description: 'บัญชีผู้ใช้นี้จะถูกระงับสิทธิ์การเข้าสู่ระบบทันที',
            targetText: `Username: ${u.username} (${u.role})`,
            confirmText: '🗑️ ลบบัญชีผู้ใช้',
          });
          if (!confirmed) return;

          try {
            await apiRequest(`/api/users/${u.id}`, { method: 'DELETE' });
            showToast(`ลบบัญชีผู้ใช้ "${u.username}" เรียบร้อยแล้ว`, 'success');
            loadUsersList();
          } catch (err) {
            showToast(err.message, 'error');
          }
        });
      }

      container.appendChild(card);
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function openUserModal(existingUser = null) {
  state.editingUserId = existingUser ? existingUser.id : null;
  const titleEl = document.getElementById('user-modal-title');
  const usernameInput = document.getElementById('user-form-username');
  const pwdInput = document.getElementById('user-form-password');
  const pwdLabel = document.getElementById('user-form-password-label');
  const roleSelect = document.getElementById('user-form-role');
  const quotaInput = document.getElementById('user-form-quota');

  if (existingUser) {
    titleEl.textContent = `✏️ แก้ไขผู้ใช้ "${existingUser.username}"`;
    usernameInput.value = existingUser.username;
    usernameInput.disabled = true;
    pwdInput.value = '';
    pwdInput.required = false;
    pwdLabel.textContent = 'ตั้งรหัสผ่านใหม่ (เว้นว่างไว้หากไม่ต้องการเปลี่ยน):';
    roleSelect.value = existingUser.role;
    quotaInput.value = existingUser.quota_bytes
      ? Math.round((existingUser.quota_bytes / (1024 * 1024 * 1024)) * 100) / 100
      : 0;
  } else {
    titleEl.textContent = '➕ เพิ่มบัญชีผู้ใช้ใหม่';
    usernameInput.value = '';
    usernameInput.disabled = false;
    pwdInput.value = '';
    pwdInput.required = true;
    pwdLabel.textContent = 'รหัสผ่าน (อย่างน้อย 4 ตัวอักษร):';
    roleSelect.value = 'user';
    quotaInput.value = 10;
  }

  document.getElementById('user-modal').classList.remove('hidden');
}

function closeUserModal() {
  document.getElementById('user-modal').classList.add('hidden');
  state.editingUserId = null;
}

// ================= PHASE 4: GLOBAL INDEXER, SEARCH & DUPLICATE DETECTOR =================
async function runGlobalSearch() {
  const q = document.getElementById('global-search-input')?.value || '';
  const cat = document.getElementById('global-category-select')?.value || 'all';
  const container = document.getElementById('global-search-results');
  if (!container) return;

  try {
    const data = await apiRequest(
      `/api/index/search?q=${encodeURIComponent(q)}&category=${encodeURIComponent(cat)}`
    );
    const items = data.items || [];
    container.innerHTML = '';

    if (items.length === 0) {
      container.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-secondary);">ไม่พบไฟล์หรือโฟลเดอร์ที่ตรงกับเงื่อนไข</div>`;
      return;
    }

    items.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'file-card';
      const icon = getCategoryIcon(item.category, item.isDirectory);
      card.innerHTML = `
        <div class="file-card-top">
          <div class="file-icon">${icon}</div>
          <div class="file-info">
            <div class="file-name">${escapeHtml(item.name)}</div>
            <div class="file-meta">
              อยู่ในโฟลเดอร์: <code>${escapeHtml(item.parentPath)}</code> • ขนาด: ${
        item.isDirectory ? 'โฟลเดอร์' : formatBytes(item.size)
      } • แก้ไขเมื่อ: ${formatDate(item.modifiedAt)}
            </div>
          </div>
        </div>
        <div class="file-actions">
          <button class="btn btn-secondary btn-sm btn-open-loc">📂 เปิดโฟลเดอร์ที่เก็บ</button>
          ${
            !item.isDirectory
              ? `<button class="btn btn-primary btn-sm btn-preview-item">👁️ เปิดดู</button>`
              : ''
          }
        </div>
      `;

      card.querySelector('.btn-open-loc').addEventListener('click', () => {
        state.currentPath = item.isDirectory ? item.path : item.parentPath || '/';
        switchTab('files');
      });

      const prevBtn = card.querySelector('.btn-preview-item');
      if (prevBtn) {
        prevBtn.addEventListener('click', () => openFilePreview(item));
      }

      container.appendChild(card);
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function scanDuplicateFiles() {
  const panel = document.getElementById('duplicates-panel');
  const summaryEl = document.getElementById('duplicates-summary-text');
  const listEl = document.getElementById('duplicates-list');

  panel.classList.remove('hidden');
  summaryEl.textContent = '⏳ กำลังสแกนและเปรียบเทียบ Hash (SHA-256) ของไฟล์ทั่วระบบ...';
  listEl.innerHTML = '';

  try {
    const data = await apiRequest('/api/index/duplicates');
    const groups = data.duplicateGroups || [];

    if (groups.length === 0) {
      summaryEl.textContent = '✨ ยอดเยี่ยม! ไม่พบไฟล์ซ้ำซ้อนในระบบของคุณเลย';
      return;
    }

    summaryEl.innerHTML = `พบไฟล์ซ้ำทั้งหมด <strong>${groups.length} กลุ่ม (${
      data.totalDuplicateFiles
    } ไฟล์ซ้ำ)</strong> • สามารถลบเพื่อคืนพื้นที่ว่างได้ถึง <strong style="color:var(--warn)">${formatBytes(
      data.totalWastedBytes
    )}</strong>`;

    groups.forEach((grp, idx) => {
      const box = document.createElement('div');
      box.className = 'upload-item-row';
      box.style.marginBottom = '10px';

      const rowsHtml = grp.files
        .map(
          (f, fIdx) => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-top:1px solid rgba(255,255,255,0.06);">
            <div>
              <strong>${fIdx === 0 ? '🟢 ต้นฉบับ:' : '🟠 สำเนาซ้ำ:'}</strong>
              <code>${escapeHtml(f.path)}</code>
              <span style="font-size:12px;color:var(--text-secondary);margin-left:8px;">(${formatDate(
                f.modifiedAt
              )})</span>
            </div>
            <button class="btn btn-danger btn-sm btn-del-dup" data-path="${escapeHtml(
              f.path
            )}">🗑️ ลบลงถังขยะ</button>
          </div>
        `
        )
        .join('');

      box.innerHTML = `
        <div style="margin-bottom:6px;display:flex;justify-content:space-between;">
          <strong>กลุ่มที่ ${idx + 1} — ขนาดไฟล์ละ ${formatBytes(grp.size)} (${grp.count} ไฟล์เหมือนกัน 100%)</strong>
          <span class="pill pill-warn">สิ้นเปลืองพื้นที่ ${formatBytes(grp.wastedBytes)}</span>
        </div>
        ${rowsHtml}
      `;

      box.querySelectorAll('.btn-del-dup').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const targetPath = btn.getAttribute('data-path');
          const confirmed = await openConfirmModal({
            title: '🗑️ ยืนยันการลบไฟล์ซ้ำซ้อน',
            icon: '🕵️',
            heading: 'ต้องการลบไฟล์สำเนานี้ลงถังขยะใช่หรือไม่?',
            description: 'ไฟล์จะถูกย้ายไปยังถังขยะ (Recycle Bin) เพื่อคืนพื้นที่ว่าง',
            targetText: targetPath,
            confirmText: '🗑️ ย้ายไฟล์ซ้ำไปถังขยะ',
          });
          if (!confirmed) return;

          try {
            await apiRequest('/api/files/trash', {
              method: 'POST',
              body: { path: targetPath },
            });
            showToast(`ย้ายไฟล์ซ้ำ "${targetPath}" ไปถังขยะแล้ว`, 'success');
            loadTrashCount();
            scanDuplicateFiles();
          } catch (err) {
            showToast(err.message, 'error');
          }
        });
      });

      listEl.appendChild(box);
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ================= PHASE 4: WEBDAV & AUTO-BACKUP SCHEDULED TASKS =================
async function loadBackupsAndWebdav() {
  const webdavInput = document.getElementById('webdav-url-input');
  if (webdavInput) {
    webdavInput.value = `${window.location.origin}/webdav/`;
  }

  const isAdmin = state.user?.role === 'admin';
  document.getElementById('scheduler-settings-card')?.classList.toggle('hidden', !isAdmin);
  document.getElementById('storage-path-settings-card')?.classList.toggle('hidden', !isAdmin);
  document.getElementById('backups-banner')?.classList.toggle('hidden', !isAdmin);
  document.getElementById('backups-list')?.classList.toggle('hidden', !isAdmin);

  if (!isAdmin) return;
  loadStoragePathConfig();

  try {
    const data = await apiRequest('/api/backups');
    const cfg = data.config || {};
    const backups = data.backups || [];

    document.getElementById('sched-auto-backup').checked = Boolean(cfg.autoBackupEnabled);
    document.getElementById('sched-interval-hours').value = cfg.backupIntervalHours || 24;
    document.getElementById('sched-max-keep').value = cfg.maxBackupsKeep || 5;
    document.getElementById('sched-trash-days').value = cfg.trashRetentionDays || 30;

    const statusEl = document.getElementById('last-backup-status-text');
    statusEl.textContent = cfg.lastBackupAt
      ? `สำรองข้อมูลล่าสุดเมื่อ: ${formatDate(cfg.lastBackupAt)} • เก็บสูงสุด ${cfg.maxBackupsKeep} ชุดล่าสุด`
      : 'ยังไม่มีประวัติการสำรองข้อมูล กดปุ่มด้านขวาเพื่อสร้าง Backup Snapshot ชุดแรกได้ทันที';

    const listEl = document.getElementById('backups-list');
    listEl.innerHTML = '';

    if (backups.length === 0) {
      listEl.innerHTML = `<div style="padding:30px;text-align:center;color:var(--text-secondary);">ยังไม่มีไฟล์ Backup Snapshot ใน <code>storage/backups/</code></div>`;
      return;
    }

    backups.forEach((b) => {
      const card = document.createElement('div');
      card.className = 'file-card';
      const dlUrl = `/api/backups/download/${encodeURIComponent(b.filename)}`;

      card.innerHTML = `
        <div class="file-card-top">
          <div class="file-icon">📦</div>
          <div class="file-info">
            <div class="file-name">${escapeHtml(b.filename)}</div>
            <div class="file-meta">ขนาด: ${formatBytes(b.size)} • สร้างเมื่อ: ${formatDate(
        b.createdAt
      )}</div>
          </div>
        </div>
        <div class="file-actions">
          <a class="btn btn-primary btn-sm" href="${dlUrl}">⬇️ ดาวน์โหลด .ZIP</a>
          <button class="btn btn-danger btn-sm btn-del-backup">🗑️ ลบชุดสำรองนี้</button>
        </div>
      `;

      card.querySelector('.btn-del-backup').addEventListener('click', async () => {
        const confirmed = await openConfirmModal({
          title: '🗑️ ยืนยันการลบชุดสำรองข้อมูล (Backup)',
          icon: '📦',
          heading: `ต้องการลบไฟล์ Backup "${b.filename}" ใช่หรือไม่?`,
          description: 'ไฟล์ชุดสำรองข้อมูลนี้จะถูกลบออกจากโฟลเดอร์ storage/backups/ ถาวร',
          targetText: `${b.filename} (${formatBytes(b.size)})`,
          confirmText: '🗑️ ลบชุดสำรองนี้',
        });
        if (!confirmed) return;

        try {
          await apiRequest(`/api/backups/${encodeURIComponent(b.filename)}`, {
            method: 'DELETE',
          });
          showToast(`ลบไฟล์ Backup "${b.filename}" เรียบร้อยแล้ว`, 'success');
          loadBackupsAndWebdav();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      listEl.appendChild(card);
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadStoragePathConfig() {
  const card = document.getElementById('storage-path-settings-card');
  if (!card) return;
  try {
    const config = await apiRequest('/api/admin/storage-path');
    const pathDisplay = document.getElementById('storage-current-path-display');
    const badge = document.getElementById('storage-path-status-badge');
    const freeBadge = document.getElementById('storage-disk-free-badge');
    const envWarning = document.getElementById('storage-env-warning');
    const input = document.getElementById('storage-new-path-input');

    if (pathDisplay) pathDisplay.textContent = config.currentPath;
    if (input && !input.value) input.placeholder = config.currentPath;
    if (envWarning) envWarning.classList.toggle('hidden', !config.envOverride);

    if (badge) {
      if (config.isCustom) {
        badge.textContent = '🚀 ไดรฟ์กำหนดเอง (Custom Pool)';
        badge.style.background = 'rgba(0, 229, 255, 0.15)';
        badge.style.color = 'var(--primary)';
        badge.style.border = '1px solid rgba(0, 229, 255, 0.3)';
      } else {
        badge.textContent = '🟢 โฟลเดอร์เริ่มต้น (Default)';
        badge.style.background = 'rgba(16, 185, 129, 0.15)';
        badge.style.color = '#10b981';
        badge.style.border = '1px solid rgba(16, 185, 129, 0.3)';
      }
    }

    if (freeBadge && config.diskInfo) {
      freeBadge.textContent = `ความจุว่าง: ${formatBytes(config.diskInfo.freeBytes)} (จาก ${formatBytes(config.diskInfo.totalBytes)})`;
    }
  } catch {
    // Non-fatal
  }
}

async function loadUploadPolicy() {
  try {
    const data = await apiRequest('/api/settings/upload-policy');
    const policy = data.policy || { mode: 'allow_all', extensions: [] };
    const modeSelect = document.getElementById('policy-mode-select');
    const extInput = document.getElementById('policy-extensions-input');
    const extGroup = document.getElementById('policy-extensions-group');

    modeSelect.value = policy.mode || 'allow_all';
    extInput.value = (policy.extensions || []).join(', ');
    extGroup.classList.toggle('hidden', modeSelect.value === 'allow_all');
  } catch {
    // Ignore
  }
}

function formatEta(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return 'เหลืออีก < 1 วินาที';
  if (seconds < 60) return `เหลืออีก ~${Math.ceil(seconds)} วินาที`;
  const m = Math.floor(seconds / 60);
  const s = Math.ceil(seconds % 60);
  return `เหลืออีก ~${m} นาที ${s} วินาที`;
}

// ================= CHUNKED & RESUMABLE UPLOAD (PHASE 2 & 3) =================
async function uploadFilesList(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;

  if (state.uploadController.active) {
    showToast('กำลังมีคิวอัปโหลดทำงานอยู่ กรุณารอสักครู่', 'error');
    return;
  }

  const banner = document.getElementById('upload-banner');
  const statusText = document.getElementById('upload-status-text');
  const resumedBadge = document.getElementById('upload-resumed-badge');
  const speedEtaEl = document.getElementById('upload-speed-eta');
  const bytesText = document.getElementById('upload-bytes-text');
  const percentText = document.getElementById('upload-percent-text');
  const progressBar = document.getElementById('upload-progress-bar');
  const pauseBtn = document.getElementById('upload-pause-btn');
  const cancelBtn = document.getElementById('upload-cancel-btn');
  const closeBtn = document.getElementById('upload-close-btn');
  const itemsListEl = document.getElementById('upload-items-list');

  state.uploadController.active = true;
  state.uploadController.paused = false;
  state.uploadController.cancelled = false;

  let wakeLock = null;
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      // Ignore wakeLock error if unsupported or disallowed
    }
  }

  pauseBtn.textContent = '⏸️ พัก';
  pauseBtn.classList.remove('hidden');
  cancelBtn.classList.remove('hidden');
  closeBtn.classList.add('hidden');
  resumedBadge.classList.add('hidden');
  banner.classList.remove('hidden');

  const grandTotalBytes = files.reduce((acc, f) => acc + (f.size || 0), 0);
  let completedFilesBytes = 0;
  let completedCount = 0;
  const startTimeMs = Date.now();

  // Immediately initialize 0% UI state before any network call
  statusText.textContent = `⬆️ กำลังเตรียมอัปโหลดไฟล์ที่ 1 จาก ${files.length} (0%)`;
  bytesText.textContent = `0 B / ${formatBytes(grandTotalBytes)}`;
  percentText.textContent = '0%';
  progressBar.style.width = '0%';
  speedEtaEl.textContent = '⚡ กำลังเริ่มส่งข้อมูล...';

  const uploadBtnInit = document.getElementById('upload-btn');
  if (uploadBtnInit) {
    uploadBtnInit.textContent = '⬆️ กำลังอัปโหลด 0%';
  }

  // Render initial per-file rows in the Upload Task Manager
  itemsListEl.innerHTML = '';
  const rowRefs = files.map((file, idx) => {
    const row = document.createElement('div');
    row.className = 'upload-item-row';
    row.innerHTML = `
      <div class="upload-item-top">
        <div class="upload-item-name">${idx + 1}. ${escapeHtml(file.name)}</div>
        <div class="upload-item-meta">
          <span class="item-chunk-status">⏳ รอคิว...</span>
          <span class="item-bytes-status">0 B / ${formatBytes(file.size)}</span>
          <span class="upload-item-pct">0%</span>
        </div>
      </div>
      <div class="progress-bar">
        <div class="progress-fill item-progress-fill" style="width: 0%"></div>
      </div>
    `;
    itemsListEl.appendChild(row);
    return {
      row,
      chunkStatusEl: row.querySelector('.item-chunk-status'),
      bytesStatusEl: row.querySelector('.item-bytes-status'),
      pctEl: row.querySelector('.upload-item-pct'),
      fillEl: row.querySelector('.item-progress-fill'),
    };
  });

  banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Yield briefly with setTimeout (NOT requestAnimationFrame, which freezes when tab is unfocused)
  await new Promise((r) => setTimeout(r, 15));

  const updateOverallProgress = (currentFileUploadedBytes, currentFileIndex) => {
    const totalUploadedNow = completedFilesBytes + currentFileUploadedBytes;
    const overallPct =
      grandTotalBytes > 0
        ? Math.min(100, Math.round((totalUploadedNow / grandTotalBytes) * 1000) / 10)
        : 100;

    bytesText.textContent = `${formatBytes(totalUploadedNow)} / ${formatBytes(grandTotalBytes)}`;
    percentText.textContent = `${overallPct}%`;
    progressBar.style.width = `${overallPct}%`;
    statusText.textContent = `⬆️ กำลังอัปโหลดไฟล์ที่ ${currentFileIndex + 1} จาก ${files.length} (${overallPct}%)`;

    const uploadBtn = document.getElementById('upload-btn');
    if (uploadBtn) {
      uploadBtn.textContent = `⬆️ กำลังอัปโหลด ${overallPct}%`;
    }

    const elapsedSec = Math.max(0.15, (Date.now() - startTimeMs) / 1000);
    const bytesPerSec = totalUploadedNow / elapsedSec;
    const remainingBytes = Math.max(0, grandTotalBytes - totalUploadedNow);
    const etaSec = bytesPerSec > 0 ? remainingBytes / bytesPerSec : 0;

    speedEtaEl.textContent = state.uploadController.paused
      ? '⏸️ พักการอัปโหลดชั่วคราว'
      : `⚡ ${formatBytes(bytesPerSec)}/s • ⏳ ${formatEta(etaSec)}`;
  };

  for (let i = 0; i < files.length; i++) {
    if (state.uploadController.cancelled) break;

    const file = files[i];
    const ref = rowRefs[i];
    resumedBadge.classList.add('hidden');
    ref.chunkStatusEl.textContent = 'กำลังเตรียมส่งข้อมูล...';

    try {
      await uploadSingleFileChunked(file, state.currentPath, {
        onInit: ({ resumed, uploadedBytes, totalSize, totalChunks, currentChunk }) => {
          if (resumed) {
            resumedBadge.classList.remove('hidden');
            showToast(`พบไฟล์ที่อัปโหลดค้างไว้ กำลังอัปโหลดต่อจาก ${formatBytes(uploadedBytes)}`, 'info');
          }
          const pct = totalSize > 0 ? Math.min(100, Math.round((uploadedBytes / totalSize) * 1000) / 10) : 100;
          ref.chunkStatusEl.textContent = resumed
            ? `♻️ ต่อจาก Chunk ${currentChunk}/${totalChunks}`
            : `⬆️ Chunk ${currentChunk}/${totalChunks}`;
          ref.bytesStatusEl.textContent = `${formatBytes(uploadedBytes)} / ${formatBytes(totalSize)}`;
          ref.pctEl.textContent = `${pct}%`;
          ref.fillEl.style.width = `${pct}%`;
          updateOverallProgress(uploadedBytes, i);
        },
        onProgress: ({ uploadedBytes, totalSize, currentChunk, totalChunks }) => {
          const pct = totalSize > 0 ? Math.min(100, Math.round((uploadedBytes / totalSize) * 1000) / 10) : 100;
          ref.chunkStatusEl.textContent = `⬆️ Chunk ${currentChunk}/${totalChunks}`;
          ref.bytesStatusEl.textContent = `${formatBytes(uploadedBytes)} / ${formatBytes(totalSize)}`;
          ref.pctEl.textContent = `${pct}%`;
          ref.fillEl.style.width = `${pct}%`;
          updateOverallProgress(uploadedBytes, i);
        },
      });

      completedFilesBytes += file.size;
      completedCount++;
      ref.chunkStatusEl.innerHTML = '<span style="color:var(--success);font-weight:700;">✅ สำเร็จ</span>';
      ref.bytesStatusEl.textContent = `${formatBytes(file.size)} / ${formatBytes(file.size)}`;
      ref.pctEl.textContent = '100%';
      ref.fillEl.style.width = '100%';
      updateOverallProgress(0, i);
    } catch (err) {
      if (state.uploadController.cancelled) {
        ref.chunkStatusEl.innerHTML = '<span style="color:var(--warn);">✕ ยกเลิกแล้ว</span>';
        showToast('ยกเลิกการอัปโหลดแล้ว');
        break;
      }
      ref.chunkStatusEl.innerHTML = `<span style="color:var(--danger);">❌ ล้มเหลว (${escapeHtml(err.message)})</span>`;
      showToast(`อัปโหลด ${file.name} ล้มเหลว: ${err.message}`, 'error');
    }
  }

  state.uploadController.active = false;
  state.uploadController.currentUploadId = null;
  state.uploadController.currentXhr = null;

  const uploadBtn = document.getElementById('upload-btn');
  if (uploadBtn) {
    uploadBtn.textContent = '⬆️ อัปโหลดไฟล์';
  }

  pauseBtn.classList.add('hidden');
  cancelBtn.classList.add('hidden');
  closeBtn.classList.remove('hidden');

  if (wakeLock) {
    try {
      await wakeLock.release();
    } catch {
      // Ignore
    }
    wakeLock = null;
  }

  if (state.uploadController.cancelled) {
    statusText.textContent = '⚠️ ยกเลิกการอัปโหลดไฟล์แล้ว';
    speedEtaEl.textContent = 'หยุดการทำงาน';
  } else if (completedCount === files.length) {
    statusText.textContent = `✅ อัปโหลดเสร็จสมบูรณ์ (${completedCount}/${files.length} ไฟล์)`;
    speedEtaEl.textContent = 'เสร็จสิ้น 100%';
    percentText.textContent = '100%';
    progressBar.style.width = '100%';
  } else {
    statusText.textContent = `⚠️ อัปโหลดเสร็จสิ้นบางส่วน (${completedCount}/${files.length} ไฟล์สำเร็จ)`;
    speedEtaEl.textContent = 'มีบางไฟล์ไม่สามารถอัปโหลดได้';
  }

  if (completedCount > 0) {
    showToast(`อัปโหลดเสร็จสิ้น ${completedCount} ไฟล์ (100%)`, 'success');
  }
  loadDirectory(state.currentPath);
  fetchSystemStats(true);
}

async function uploadSingleFileChunked(file, targetDir, callbacks) {
  let initData;
  try {
    initData = await apiRequest('/api/upload/init', {
      method: 'POST',
      body: {
        path: targetDir,
        filename: file.name,
        totalSize: file.size,
        lastModified: file.lastModified || 0,
      },
    });
  } catch (err) {
    // Fallback if server was not restarted since Phase 1
    if (err.message && err.message.includes('ไม่พบ API Endpoint')) {
      return uploadLegacyStreamWithProgress(file, targetDir, callbacks);
    }
    throw err;
  }

  const chunkSize = initData.chunkSize || 4 * 1024 * 1024;
  const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));

  if (initData.completed) {
    callbacks.onProgress({
      uploadedBytes: file.size,
      totalSize: file.size,
      currentChunk: totalChunks,
      totalChunks,
    });
    return initData.file;
  }

  let uploadId = initData.uploadId;
  let offset = initData.uploadedBytes || 0;
  let retryCount = 0;

  state.uploadController.currentUploadId = uploadId;
  callbacks.onInit({
    resumed: Boolean(initData.resumed),
    uploadedBytes: offset,
    totalSize: file.size,
    currentChunk: Math.min(totalChunks, Math.floor(offset / chunkSize) + 1),
    totalChunks,
  });

  while (offset < file.size) {
    if (state.uploadController.cancelled) {
      await apiRequest(`/api/upload/cancel?uploadId=${encodeURIComponent(uploadId)}`, {
        method: 'DELETE',
      }).catch(() => {});
      throw new Error('Cancelled');
    }

    if (state.uploadController.paused) {
      await new Promise((resolve) => {
        state.uploadController.resumeResolver = resolve;
      });
      if (state.uploadController.cancelled) continue;
    }

    // Yield via setTimeout so uploads continue at full speed even when browser tab is in background
    await new Promise((r) => setTimeout(r, 0));

    const currentChunk = Math.min(totalChunks, Math.floor(offset / chunkSize) + 1);
    const chunkEnd = Math.min(offset + chunkSize, file.size);
    const blobChunk = file.slice(offset, chunkEnd);

    try {
      const chunkRes = await sendSingleChunk(uploadId, offset, blobChunk, (chunkLoaded) => {
        callbacks.onProgress({
          uploadedBytes: Math.min(file.size, offset + chunkLoaded),
          totalSize: file.size,
          currentChunk,
          totalChunks,
        });
      });

      if (typeof chunkRes.uploadedBytes !== 'number' || chunkRes.uploadedBytes <= offset) {
        throw new Error('ตำแหน่งการส่งข้อมูล Chunk ไม่คืบหน้า (Stalled Chunk)');
      }

      retryCount = 0;
      offset = chunkRes.uploadedBytes;
      callbacks.onProgress({
        uploadedBytes: offset,
        totalSize: file.size,
        currentChunk,
        totalChunks,
      });

      if (chunkRes.completed) {
        return chunkRes.file;
      }
    } catch (err) {
      if (err.message === 'PAUSED') {
        continue;
      }
      if (err.message === 'Cancelled' || state.uploadController.cancelled) {
        throw err;
      }

      // Auto-retry up to 5 times on transient LAN hiccups or timeouts with exponential backoff
      if (retryCount < 5) {
        retryCount++;
        const backoffMs = Math.min(6000, 800 * Math.pow(1.5, retryCount));
        await new Promise((r) => setTimeout(r, backoffMs));
        try {
          const reInit = await apiRequest('/api/upload/init', {
            method: 'POST',
            body: {
              path: targetDir,
              filename: file.name,
              totalSize: file.size,
              lastModified: file.lastModified || 0,
            },
          });
          if (reInit.completed) {
            return reInit.file;
          }
          if (reInit.uploadId) {
            uploadId = reInit.uploadId;
            state.uploadController.currentUploadId = uploadId;
          }
          if (reInit.chunkSize) {
            chunkSize = reInit.chunkSize;
          }
          if (typeof reInit.uploadedBytes === 'number') {
            offset = reInit.uploadedBytes;
          }
          continue;
        } catch {
          // If re-init also failed, fall through after retries
        }
      }
      throw err;
    }
  }
}

function uploadLegacyStreamWithProgress(file, targetDir, callbacks) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    state.uploadController.currentXhr = xhr;
    const url = `/api/files/upload?path=${encodeURIComponent(targetDir)}&filename=${encodeURIComponent(file.name)}`;
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    callbacks.onInit({
      resumed: false,
      uploadedBytes: 0,
      totalSize: file.size,
      currentChunk: 1,
      totalChunks: 1,
    });

    let lastProgressTs = 0;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const now = Date.now();
        if (now - lastProgressTs >= 60 || e.loaded === e.total) {
          lastProgressTs = now;
          callbacks.onProgress({
            uploadedBytes: e.loaded,
            totalSize: e.total,
            currentChunk: 1,
            totalChunks: 1,
          });
        }
      }
    };

    xhr.onload = () => {
      state.uploadController.currentXhr = null;
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText || '{}'));
      } else {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };

    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(file);
  });
}

function sendSingleChunk(uploadId, offset, blobChunk, onChunkProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    state.uploadController.currentXhr = xhr;

    const url = `/api/upload/chunk?uploadId=${encodeURIComponent(uploadId)}&offset=${offset}`;
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    // Generous dynamic timeout: minimum 3 minutes, or enough time at 40 KB/s over Wi-Fi
    xhr.timeout = Math.max(180000, Math.ceil((blobChunk.size / (40 * 1024)) * 1000));

    let lastProgressTs = 0;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const now = Date.now();
        if (now - lastProgressTs >= 60 || e.loaded === e.total) {
          lastProgressTs = now;
          onChunkProgress(e.loaded);
        }
      }
    };

    xhr.onload = () => {
      state.uploadController.currentXhr = null;
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText || '{}'));
        } catch {
          reject(new Error('Invalid server response'));
        }
      } else if (xhr.status === 409) {
        try {
          const data = JSON.parse(xhr.responseText || '{}');
          if (typeof data.expectedOffset === 'number' && data.expectedOffset > offset) {
            resolve({ uploadedBytes: data.expectedOffset, completed: false });
            return;
          }
          reject(new Error(data.error || 'Offset conflict (409)'));
        } catch (e) {
          reject(new Error(e.message || 'Offset conflict (409)'));
        }
      } else {
        try {
          const err = JSON.parse(xhr.responseText);
          reject(new Error(err.error || `Error ${xhr.status}`));
        } catch {
          reject(new Error(`Chunk upload failed (${xhr.status})`));
        }
      }
    };

    xhr.onabort = () => {
      state.uploadController.currentXhr = null;
      if (state.uploadController.paused && !state.uploadController.cancelled) {
        reject(new Error('PAUSED'));
      } else {
        reject(new Error('Cancelled'));
      }
    };

    xhr.ontimeout = () => {
      state.uploadController.currentXhr = null;
      reject(new Error('Chunk upload timed out over LAN'));
    };

    xhr.onerror = () => {
      state.uploadController.currentXhr = null;
      reject(new Error('Network error while uploading chunk'));
    };

    xhr.send(blobChunk);
  });
}

// ================= FILE PREVIEW, TEXT EDITOR & LIGHTBOX SLIDESHOW =================
async function openFilePreview(item, playlistItems = null) {
  const modal = document.getElementById('preview-modal');
  const titleEl = document.getElementById('preview-title');
  const bodyEl = document.getElementById('preview-body');
  const saveBtn = document.getElementById('save-text-btn');
  const prevBtn = document.getElementById('preview-prev-btn');
  const nextBtn = document.getElementById('preview-next-btn');
  const dlLink = document.getElementById('preview-download-link');

  if (Array.isArray(playlistItems) && playlistItems.length > 0) {
    state.lightboxList = playlistItems;
    state.lightboxIndex = playlistItems.findIndex((p) => p.path === item.path);
  } else {
    state.lightboxList = [];
    state.lightboxIndex = -1;
  }

  const hasSlideshow = state.lightboxList.length > 1 && state.lightboxIndex >= 0;
  prevBtn?.classList.toggle('hidden', !hasSlideshow);
  nextBtn?.classList.toggle('hidden', !hasSlideshow);

  const renderBtn = document.getElementById('preview-mode-render-btn');
  const editBtn = document.getElementById('preview-mode-edit-btn');
  renderBtn?.classList.add('hidden');
  editBtn?.classList.add('hidden');

  const indexLabel = hasSlideshow
    ? ` (${state.lightboxIndex + 1}/${state.lightboxList.length})`
    : '';
  titleEl.textContent = `${item.name}${indexLabel}`;
  bodyEl.innerHTML = '';
  saveBtn.classList.add('hidden');
  state.editingFilePath = null;

  const streamUrl = `/api/files/download?path=${encodeURIComponent(item.path)}&inline=1`;
  const downloadUrl = `/api/files/download?path=${encodeURIComponent(item.path)}`;
  dlLink.href = downloadUrl;

  if (item.category === 'image') {
    bodyEl.innerHTML = `<img src="${streamUrl}" alt="${escapeHtml(item.name)}" />`;
  } else if (item.category === 'video') {
    bodyEl.innerHTML = `<video src="${streamUrl}" controls autoplay></video>`;
  } else if (item.category === 'audio') {
    bodyEl.innerHTML = `<audio src="${streamUrl}" controls autoplay></audio>`;
  } else if (item.extension === '.pdf') {
    bodyEl.innerHTML = `<iframe src="${streamUrl}" style="width:100%;height:70vh;border:none;border-radius:8px;"></iframe>`;
  } else if (item.category === 'text') {
    try {
      const data = await apiRequest(`/api/files/content?path=${encodeURIComponent(item.path)}`);
      const ext = (item.extension || '').toLowerCase();
      const isMarkdown = ext === '.md' || ext === '.markdown';
      const isCsvOrTsv = ext === '.csv' || ext === '.tsv';

      const textarea = document.createElement('textarea');
      textarea.id = 'text-editor-textarea';
      textarea.className = 'text-editor-area';
      textarea.value = data.content;

      state.editingFilePath = item.path;
      saveBtn.classList.remove('hidden');

      if (isMarkdown || isCsvOrTsv) {
        const renderedBox = document.createElement('div');
        renderedBox.id = 'preview-rendered-container';
        if (isMarkdown) {
          renderedBox.className = 'markdown-render-box';
          renderedBox.innerHTML = renderMarkdownToHtml(data.content);
        } else {
          renderedBox.className = 'csv-viewer-box';
          renderCsvTableView(renderedBox, data.content, ext === '.tsv' ? '\t' : ',');
        }

        textarea.classList.add('hidden');
        bodyEl.appendChild(renderedBox);
        bodyEl.appendChild(textarea);

        renderBtn?.classList.remove('hidden');
        editBtn?.classList.remove('hidden');

        if (renderBtn && editBtn) {
          renderBtn.onclick = () => {
            if (isMarkdown) {
              renderedBox.innerHTML = renderMarkdownToHtml(textarea.value);
            } else {
              renderCsvTableView(renderedBox, textarea.value, ext === '.tsv' ? '\t' : ',');
            }
            renderedBox.classList.remove('hidden');
            textarea.classList.add('hidden');
          };
          editBtn.onclick = () => {
            renderedBox.classList.add('hidden');
            textarea.classList.remove('hidden');
            textarea.focus();
          };
        }
      } else {
        bodyEl.appendChild(textarea);
      }
    } catch (err) {
      bodyEl.innerHTML = `<div style="padding:30px;text-align:center;color:var(--text-secondary)">${escapeHtml(err.message)}</div>`;
    }
  } else {
    bodyEl.innerHTML = `
      <div style="padding:40px;text-align:center;">
        <div style="font-size:52px;margin-bottom:12px;">${getCategoryIcon(item.category, false)}</div>
        <h4>${escapeHtml(item.name)}</h4>
        <p style="color:var(--text-secondary);margin:8px 0 20px;">ขนาดไฟล์: ${formatBytes(item.size)}</p>
        <a class="btn btn-primary" href="${downloadUrl}">⬇️ ดาวน์โหลดไฟล์นี้ลงเครื่อง</a>
      </div>
    `;
  }

  modal.classList.remove('hidden');
}

function stepLightbox(delta) {
  if (!Array.isArray(state.lightboxList) || state.lightboxList.length <= 1) return;
  const len = state.lightboxList.length;
  const nextIdx = (state.lightboxIndex + delta + len) % len;
  openFilePreview(state.lightboxList[nextIdx], state.lightboxList);
}

// ================= PHASE 5: FAVORITES, GALLERY, VERSIONS & AUDIT LOGS =================
async function toggleStarItem(itemPath) {
  try {
    const res = await apiRequest('/api/favorites/toggle', {
      method: 'POST',
      body: { path: itemPath },
    });
    showToast(res.message, 'success');
    if (state.activeTab === 'files') loadDirectory(state.currentPath);
    if (state.activeTab === 'favorites') loadFavoritesView();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadFavoritesView() {
  const container = document.getElementById('favorites-container');
  const emptyEl = document.getElementById('favorites-empty');
  if (!container) return;

  try {
    const data = await apiRequest('/api/favorites');
    const items = data.items || [];
    container.innerHTML = '';

    if (items.length === 0) {
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');

    items.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'file-card';
      const icon = getCategoryIcon(item.category, item.isDirectory);
      card.innerHTML = `
        <div class="file-card-top">
          <div class="file-icon">${icon}</div>
          <div class="file-info">
            <div class="file-name">${escapeHtml(item.name)} ⭐</div>
            <div class="file-meta">
              ตำแหน่ง: <code>${escapeHtml(item.path)}</code> • ${item.isDirectory ? 'โฟลเดอร์' : formatBytes(item.size)} • แก้ไข: ${formatDate(item.modifiedAt)}
            </div>
          </div>
        </div>
        <div class="file-actions">
          <button class="btn btn-secondary btn-sm btn-open-fav">📂 ไปยังโฟลเดอร์</button>
          ${!item.isDirectory ? `<button class="btn btn-primary btn-sm btn-preview-fav">👁️ เปิดดู</button>` : ''}
          <button class="btn btn-danger btn-sm btn-unstar-fav">✕ นำดาวออก</button>
        </div>
      `;

      card.querySelector('.btn-open-fav').addEventListener('click', () => {
        state.currentPath = item.isDirectory ? item.path : item.parentPath || '/';
        switchTab('files');
      });

      const prevBtn = card.querySelector('.btn-preview-fav');
      if (prevBtn) {
        prevBtn.addEventListener('click', () => openFilePreview(item));
      }

      card.querySelector('.btn-unstar-fav').addEventListener('click', () => {
        toggleStarItem(item.path);
      });

      container.appendChild(card);
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadMediaGalleryView(filterType = 'all') {
  state.galleryFilter = filterType;
  document.querySelectorAll('.gallery-filter-btn').forEach((btn) => {
    const active = btn.dataset.type === filterType;
    btn.className = `btn ${active ? 'btn-primary' : 'btn-secondary'} gallery-filter-btn`;
  });

  const container = document.getElementById('gallery-container');
  const emptyEl = document.getElementById('gallery-empty');
  if (!container) return;

  try {
    const data = await apiRequest(`/api/gallery?type=${encodeURIComponent(filterType)}`);
    const items = data.items || [];
    container.innerHTML = '';

    if (items.length === 0) {
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');

    items.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'file-card';
      const icon = item.category === 'video' ? '🎬' : '🖼️';
      card.innerHTML = `
        <div class="file-thumb-box" style="height:155px;">
          <img src="/api/files/thumbnail?path=${encodeURIComponent(item.path)}" alt="${escapeHtml(item.name)}" loading="lazy" />
        </div>
        <div class="file-card-top" style="padding-right:0;">
          <div class="file-icon" style="font-size:24px;">${icon}</div>
          <div class="file-info">
            <div class="file-name">${escapeHtml(item.name)}</div>
            <div class="file-meta">${formatBytes(item.size)} • <code>${escapeHtml(item.parentPath)}</code></div>
          </div>
        </div>
      `;

      card.addEventListener('click', () => {
        openFilePreview(item, items);
      });

      container.appendChild(card);
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function openVersionsModal(item) {
  state.versioningItemPath = item.path;
  document.getElementById('versions-modal-title').textContent = `🕓 ประวัติเวอร์ชันของ "${item.name}"`;
  document.getElementById('versions-modal').classList.remove('hidden');
  await refreshVersionsList(item.path);
}

async function refreshVersionsList(filePath) {
  const listEl = document.getElementById('versions-list-container');
  if (!listEl) return;
  listEl.innerHTML = '<div style="padding:16px;color:var(--text-secondary);">กำลังโหลดประวัติเวอร์ชัน...</div>';

  try {
    const data = await apiRequest(`/api/files/versions?path=${encodeURIComponent(filePath)}`);
    const versions = data.versions || [];
    listEl.innerHTML = '';

    if (versions.length === 0) {
      listEl.innerHTML = `
        <div style="padding:24px;text-align:center;color:var(--text-secondary);">
          ยังไม่มีเวอร์ชันสำรองสำหรับไฟล์นี้ กดปุ่ม <strong>"➕ เก็บ Snapshot เวอร์ชันปัจจุบันไว้"</strong> ด้านบน หรือแก้ไขเนื้อหาไฟล์เพื่อสร้างเวอร์ชันอัตโนมัติ
        </div>
      `;
      return;
    }

    versions.forEach((ver, idx) => {
      const card = document.createElement('div');
      card.className = 'file-card';
      card.innerHTML = `
        <div class="file-card-top">
          <div class="file-icon">🕓</div>
          <div class="file-info">
            <div class="file-name">เวอร์ชันย้อนหลัง #${versions.length - idx} (${formatDate(ver.created_at)})</div>
            <div class="file-meta">ขนาด: ${formatBytes(ver.size)} • บันทึกโดย: <strong>${escapeHtml(ver.saved_by)}</strong></div>
          </div>
        </div>
        <div class="file-actions">
          <button class="btn btn-primary btn-sm btn-restore-ver">⏪ ย้อนคืนเวอร์ชันนี้ (Rollback)</button>
          <button class="btn btn-danger btn-sm btn-del-ver">🗑️ ลบ</button>
        </div>
      `;

      card.querySelector('.btn-restore-ver').addEventListener('click', async () => {
        try {
          const res = await apiRequest('/api/files/versions/restore', {
            method: 'POST',
            body: { versionId: ver.id },
          });
          showToast(res.message, 'success');
          await refreshVersionsList(filePath);
          loadDirectory(state.currentPath);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      card.querySelector('.btn-del-ver').addEventListener('click', async () => {
        try {
          await apiRequest(`/api/files/versions/${encodeURIComponent(ver.id)}`, {
            method: 'DELETE',
          });
          showToast('ลบเวอร์ชันสำรองเรียบร้อยแล้ว', 'success');
          await refreshVersionsList(filePath);
          loadDirectory(state.currentPath);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      listEl.appendChild(card);
    });
  } catch (err) {
    listEl.innerHTML = `<div style="padding:16px;color:var(--danger);">${escapeHtml(err.message)}</div>`;
  }
}

async function loadAuditLogsView() {
  const logsEl = document.getElementById('audit-logs-list');
  const lockedListEl = document.getElementById('locked-ips-list');
  const lockedSummaryEl = document.getElementById('locked-ips-summary');
  if (!logsEl) return;

  try {
    const data = await apiRequest('/api/audit-logs?limit=250');
    const logs = data.logs || [];
    const lockedIps = data.lockedIps || [];

    lockedListEl.innerHTML = '';
    if (lockedIps.length === 0) {
      lockedSummaryEl.textContent = '✅ ขณะนี้ไม่มีหมายเลข IP ที่ถูกล็อกหรือพยายามล็อกอินผิดปกติ';
    } else {
      lockedSummaryEl.textContent = `⚠️ พบ ${lockedIps.length} IP ที่มีการล็อกอินผิดพลาดหรือถูกล็อกอยู่`;
      lockedIps.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'file-card';
        row.innerHTML = `
          <div class="file-card-top">
            <div class="file-icon">${item.lockedUntil ? '🔒' : '⚠️'}</div>
            <div class="file-info">
              <div class="file-name">IP: <code>${escapeHtml(item.ip)}</code> — พยายามผิด ${item.attempts} ครั้ง</div>
              <div class="file-meta">${
                item.lockedUntil
                  ? `สถานะ: ถูกล็อกชั่วคราว (เหลืออีก ${item.remainingSeconds} วินาที)`
                  : 'สถานะ: เฝ้าระวัง (ยังไม่ครบ 5 ครั้ง)'
              }</div>
            </div>
          </div>
          <div class="file-actions">
            <button class="btn btn-primary btn-sm btn-unlock-ip">🔓 ปลดล็อก IP ทันที</button>
          </div>
        `;
        row.querySelector('.btn-unlock-ip').addEventListener('click', async () => {
          try {
            await apiRequest('/api/security/unlock-ip', {
              method: 'POST',
              body: { ip: item.ip },
            });
            showToast(`ปลดล็อก IP ${item.ip} สำเร็จ`, 'success');
            loadAuditLogsView();
          } catch (err) {
            showToast(err.message, 'error');
          }
        });
        lockedListEl.appendChild(row);
      });
    }

    logsEl.innerHTML = '';
    if (logs.length === 0) {
      logsEl.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-secondary);">ยังไม่มีประวัติเหตุการณ์ในระบบ</div>';
      return;
    }

    logs.forEach((log) => {
      const card = document.createElement('div');
      card.className = 'file-card';
      const isWarn = log.action.includes('FAILED') || log.action.includes('DELETE');
      const isOk = log.action.includes('SUCCESS') || log.action.includes('UPLOAD') || log.action.includes('RESTORE');
      const badgeClass = isWarn ? 'warn' : isOk ? 'ok' : '';

      card.innerHTML = `
        <div class="file-card-top">
          <div class="file-icon">📜</div>
          <div class="file-info">
            <div class="file-name">
              <span class="audit-badge ${badgeClass}">${escapeHtml(log.action)}</span>
              <strong>${escapeHtml(log.username)}</strong> — ${escapeHtml(log.details || '-')}
            </div>
            <div class="file-meta">
              เป้าหมาย: <code>${escapeHtml(log.target_path || '/')}</code> • IP: <code>${escapeHtml(log.ip_address || '-')}</code> • เวลา: ${formatDate(log.created_at)}
            </div>
          </div>
        </div>
      `;
      logsEl.appendChild(card);
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ================= PHASE 6: ARCHIVE EXTRACT/COMPRESS, TAGS, VAULT, FILE DROP & ANALYZER =================
async function extractArchiveItem(item) {
  try {
    showToast(`⏳ กำลังแตกไฟล์ "${item.name}"...`, 'info');
    const res = await apiRequest('/api/files/extract', {
      method: 'POST',
      body: { path: item.path },
    });
    showToast(res.message, 'success');
    loadDirectory(state.currentPath);
    fetchSystemStats();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function compressSelectedOnNas(pathsArray) {
  if (!pathsArray || pathsArray.length === 0) return;
  try {
    showToast(`⏳ กำลังบีบอัด ${pathsArray.length} รายการเป็นไฟล์ .ZIP บน NAS...`, 'info');
    const res = await apiRequest('/api/files/compress', {
      method: 'POST',
      body: {
        paths: pathsArray,
        targetDir: state.currentPath,
      },
    });
    showToast(res.message, 'success');
    clearSelection();
    loadDirectory(state.currentPath);
    fetchSystemStats();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function openTagModal(item) {
  state.taggingItemPath = item.path;
  document.getElementById('tag-modal-title').textContent = `🏷️ ป้ายสี & โน้ตของ "${item.name}"`;
  document.getElementById('tag-color-select').value = item.tagColor || 'none';
  document.getElementById('tag-note-input').value = item.tagNote || '';
  document.getElementById('tag-modal').classList.remove('hidden');
}

function openVaultModal(item) {
  state.vaultItem = item;
  const isVault = Boolean(item.isVault);
  document.getElementById('vault-modal-title').textContent = isVault
    ? `🔓 ถอดรหัสไฟล์ "${item.name}" (AES-256-GCM)`
    : `🔐 เข้ารหัสล็อกไฟล์ "${item.name}" (AES-256-GCM)`;
  document.getElementById('vault-modal-desc').innerHTML = isVault
    ? `กรอกรหัสผ่านที่ใช้เข้ารหัสไฟล์ <strong>${escapeHtml(item.name)}</strong> เพื่อถอดรหัสกลับมาเป็นไฟล์ต้นฉบับ`
    : `ระบบจะเข้ารหัสไฟล์ด้วยอัลกอริทึม <strong>AES-256-GCM</strong> กลายเป็นไฟล์ <code>${escapeHtml(item.name)}.vault</code> ซึ่งไม่สามารถเปิดอ่านได้หากไม่มีรหัสผ่านนี้`;
  document.getElementById('submit-vault-btn').textContent = isVault
    ? '🔓 ถอดรหัสไฟล์ทันที'
    : '🔐 เข้ารหัสล็อกไฟล์';
  document.getElementById('vault-form').reset();
  document.getElementById('vault-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('vault-password-input')?.focus(), 50);
}

async function openFileDropModal() {
  try {
    const data = await apiRequest('/api/files/folders');
    const select = document.getElementById('file-drop-folder-select');
    select.innerHTML = '';
    (data.folders || ['/']).forEach((folder) => {
      const opt = document.createElement('option');
      opt.value = folder;
      opt.textContent = folder === '/' ? '/ (หน้าหลักของคุณ)' : folder;
      if (folder === state.currentPath) opt.selected = true;
      select.appendChild(opt);
    });
    document.getElementById('file-drop-form').reset();
    document.getElementById('file-drop-result-box').classList.add('hidden');
    document.getElementById('submit-file-drop-btn').classList.remove('hidden');
    document.getElementById('file-drop-modal').classList.remove('hidden');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadFileRequestsList() {
  const container = document.getElementById('file-requests-container');
  if (!container) return;

  try {
    const data = await apiRequest('/api/file-requests');
    const requests = data.requests || [];
    container.innerHTML = '';

    if (requests.length === 0) {
      container.innerHTML =
        '<div style="padding:20px;text-align:center;color:var(--text-secondary);">ยังไม่มีลิงก์รับฝากไฟล์ กดปุ่ม "➕ สร้างลิงก์รับฝากไฟล์ใหม่" ด้านบนเพื่อสร้างลิงก์รับไฟล์จากบุคคลภายนอก</div>';
      return;
    }

    requests.forEach((r) => {
      const dropUrl = `${window.location.origin}/d/${r.id}`;
      const card = document.createElement('div');
      card.className = 'file-card';
      card.innerHTML = `
        <div class="file-card-top">
          <div class="file-icon">📥</div>
          <div class="file-info">
            <div class="file-name">${escapeHtml(r.title)} ${r.has_password ? '🔒' : '🌐'}</div>
            <div class="file-meta">
              รับเข้าโฟลเดอร์: <code>${escapeHtml(r.storage_rel_path)}</code> • ส่งเข้ามาแล้ว: <strong>${r.upload_count} ไฟล์</strong> • หมดอายุ: ${r.expires_at ? formatDate(r.expires_at) : 'ไม่หมดอายุ'}
            </div>
          </div>
        </div>
        <div class="file-actions">
          <button class="btn btn-primary btn-sm btn-copy-drop">📋 คัดลอกลิงก์รับไฟล์</button>
          <button class="btn btn-secondary btn-sm btn-qr-drop">📱 QR Code</button>
          <a class="btn btn-secondary btn-sm" href="${dropUrl}" target="_blank">↗️ เปิดหน้าเว็บรับไฟล์</a>
          <button class="btn btn-danger btn-sm btn-del-drop">✕ ปิดลิงก์</button>
        </div>
      `;

      card.querySelector('.btn-copy-drop').addEventListener('click', () => {
        navigator.clipboard?.writeText(dropUrl);
        showToast('คัดลอกลิงก์รับฝากไฟล์แล้ว!', 'success');
      });

      card.querySelector('.btn-qr-drop')?.addEventListener('click', () => {
        openQrCodeModal(dropUrl, `📱 สแกนเพื่อส่งไฟล์เข้าหัวข้อ "${r.title}"`);
      });

      card.querySelector('.btn-del-drop').addEventListener('click', async () => {
        try {
          await apiRequest(`/api/file-requests/${encodeURIComponent(r.id)}`, {
            method: 'DELETE',
          });
          showToast('ปิดลิงก์รับฝากไฟล์เรียบร้อยแล้ว', 'success');
          loadFileRequestsList();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      container.appendChild(card);
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadStorageAnalyzerView() {
  const catListEl = document.getElementById('analyzer-categories-list');
  const foldersListEl = document.getElementById('analyzer-folders-list');
  const largestEl = document.getElementById('analyzer-largest-files');
  const summaryEl = document.getElementById('analyzer-summary-text');
  if (!catListEl) return;

  try {
    const data = await apiRequest('/api/storage/analyze');
    summaryEl.textContent = `รวมทั้งหมด ${data.totalFiles} ไฟล์ ใน ${data.totalFolders} โฟลเดอร์ • ใช้พื้นที่รวม ${formatBytes(data.totalBytes)}`;

    catListEl.innerHTML = '';
    (data.byCategory || []).forEach((c) => {
      const row = document.createElement('div');
      row.style.marginBottom = '10px';
      row.innerHTML = `
        <div class="sys-stat-row" style="margin-bottom:4px;">
          <span>${escapeHtml(c.label)} (${c.count} ไฟล์)</span>
          <strong>${formatBytes(c.bytes)} (${c.percent}%)</strong>
        </div>
        <div class="progress-bar">
          <div class="progress-fill progress-accent" style="width: ${c.percent}%"></div>
        </div>
      `;
      catListEl.appendChild(row);
    });

    foldersListEl.innerHTML = '';
    if ((data.topFolders || []).length === 0) {
      foldersListEl.innerHTML = '<div style="padding:14px;color:var(--text-secondary);">ยังไม่มีข้อมูลโฟลเดอร์</div>';
    } else {
      data.topFolders.forEach((f, idx) => {
        const card = document.createElement('div');
        card.className = 'file-card';
        card.innerHTML = `
          <div class="file-card-top">
            <div class="file-icon">📁</div>
            <div class="file-info">
              <div class="file-name">#${idx + 1} <code>${escapeHtml(f.folderPath)}</code></div>
              <div class="file-meta">ขนาดรวม: <strong>${formatBytes(f.bytes)}</strong> (${f.percent}% ของทั้งหมด)</div>
            </div>
          </div>
          <div class="file-actions">
            <button class="btn btn-secondary btn-sm btn-go-folder">📂 เปิดโฟลเดอร์</button>
          </div>
        `;
        card.querySelector('.btn-go-folder').addEventListener('click', () => {
          state.currentPath = f.folderPath.startsWith('/ (') ? '/' : f.folderPath;
          switchTab('files');
        });
        foldersListEl.appendChild(card);
      });
    }

    largestEl.innerHTML = '';
    if ((data.largestFiles || []).length === 0) {
      largestEl.innerHTML = '<div style="padding:16px;color:var(--text-secondary);">ยังไม่มีไฟล์ในระบบ</div>';
    } else {
      data.largestFiles.forEach((file, idx) => {
        const card = document.createElement('div');
        card.className = 'file-card';
        card.innerHTML = `
          <div class="file-card-top">
            <div class="file-icon">${getCategoryIcon(file.category, false)}</div>
            <div class="file-info">
              <div class="file-name">#${idx + 1} ${escapeHtml(file.name)}</div>
              <div class="file-meta">ขนาด: <strong style="color:#38bdf8;">${formatBytes(file.size)}</strong> • โฟลเดอร์: <code>${escapeHtml(file.parentPath)}</code> • แก้ไข: ${formatDate(file.modifiedAt)}</div>
            </div>
          </div>
          <div class="file-actions">
            <button class="btn btn-secondary btn-sm btn-open-loc">📂 ไปยังโฟลเดอร์</button>
            <button class="btn btn-primary btn-sm btn-prev-large">👁️ เปิดดู</button>
          </div>
        `;
        card.querySelector('.btn-open-loc').addEventListener('click', () => {
          state.currentPath = file.parentPath || '/';
          switchTab('files');
        });
        card.querySelector('.btn-prev-large').addEventListener('click', () => {
          openFilePreview(file);
        });
        largestEl.appendChild(card);
      });
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ================= PHASE 7: MUSIC JUKEBOX, CLIPBOARD HUB, BATCH RENAME, CHECKSUM & INBOX =================
async function loadMusicJukeboxView() {
  const container = document.getElementById('music-tracks-list');
  const emptyEl = document.getElementById('music-empty');
  if (!container) return;

  try {
    const data = await apiRequest('/api/music');
    const tracks = data.tracks || data.items || [];
    state.musicTracks = tracks;
    container.innerHTML = '';

    if (tracks.length === 0) {
      emptyEl?.classList.remove('hidden');
      return;
    }
    emptyEl?.classList.add('hidden');

    tracks.forEach((track, idx) => {
      const isCurrent = state.currentAudioTrack && state.currentAudioTrack.path === track.path;
      const card = document.createElement('div');
      card.className = `file-card ${isCurrent ? 'selected' : ''}`;
      card.innerHTML = `
        <div class="file-card-top">
          <div class="file-icon">${isCurrent ? '🔊' : '🎵'}</div>
          <div class="file-info">
            <div class="file-name">#${idx + 1} ${escapeHtml(track.name)}</div>
            <div class="file-meta">โฟลเดอร์: <code>${escapeHtml(track.parentPath)}</code> • ขนาด: ${formatBytes(track.size)} • แก้ไข: ${formatDate(track.modifiedAt)}</div>
          </div>
        </div>
        <div class="file-actions">
          <button class="btn btn-primary btn-sm btn-play-track">▶️ เล่นเพลงนี้</button>
          <button class="btn btn-secondary btn-sm btn-go-track-dir">📂 ไปยังโฟลเดอร์</button>
        </div>
      `;

      card.querySelector('.btn-play-track').addEventListener('click', (e) => {
        e.stopPropagation();
        playAudioTrackInMiniPlayer(track, tracks);
      });

      card.querySelector('.btn-go-track-dir').addEventListener('click', (e) => {
        e.stopPropagation();
        state.currentPath = track.parentPath || '/';
        switchTab('files');
      });

      card.addEventListener('click', () => {
        playAudioTrackInMiniPlayer(track, tracks);
      });

      container.appendChild(card);
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function playAudioTrackInMiniPlayer(track, playlist = []) {
  if (!track) return;
  const list = Array.isArray(playlist) && playlist.length > 0 ? playlist : [track];
  state.audioPlaylist = list;
  state.audioIndex = Math.max(
    0,
    list.findIndex((t) => t.path === track.path)
  );
  state.currentAudioTrack = track;

  const playerBar = document.getElementById('mini-audio-player');
  const titleEl = document.getElementById('mini-audio-title');
  const metaEl = document.getElementById('mini-audio-sub');
  const audioEl = document.getElementById('mini-audio-element');
  if (!playerBar || !audioEl) return;

  if (titleEl) titleEl.textContent = `🎵 ${track.name}`;
  if (metaEl) metaEl.textContent = `${track.parentPath || '/'} • ลำดับที่ ${state.audioIndex + 1}/${list.length}`;
  audioEl.src = `/api/files/download?path=${encodeURIComponent(track.path)}&inline=1`;
  playerBar.classList.remove('hidden');
  audioEl.play().catch(() => {});

  if (state.activeTab === 'music') {
    loadMusicJukeboxView();
  }
}

function stepAudioTrack(delta) {
  const list = state.audioPlaylist || [];
  if (list.length === 0) return;
  const nextIdx = (state.audioIndex + delta + list.length) % list.length;
  playAudioTrackInMiniPlayer(list[nextIdx], list);
}

async function loadClipboardView() {
  const container = document.getElementById('clipboard-items-list');
  if (!container) return;

  try {
    const data = await apiRequest('/api/clipboard');
    const items = data.items || [];
    container.innerHTML = '';

    if (items.length === 0) {
      container.innerHTML =
        '<div style="padding:28px;text-align:center;color:var(--text-secondary);">ยังไม่มีข้อความหรือลิงก์ในกระดานคลิปบอร์ด โพสต์ข้อความด้านบนเพื่อส่งข้ามเครื่องได้ทันที</div>';
      return;
    }

    items.forEach((item) => {
      const author = item.author_username || item.created_by || 'admin';
      const card = document.createElement('div');
      card.className = 'file-card';
      card.innerHTML = `
        <div class="file-card-top">
          <div class="file-icon">📋</div>
          <div class="file-info">
            <div class="file-name">${escapeHtml(item.title)} <span style="font-size:12px;color:var(--text-secondary);font-weight:400;">โดย ${escapeHtml(author)} • ${formatDate(item.created_at)}</span></div>
            <pre style="margin-top:8px;padding:10px 12px;background:var(--bg-code);border:1px solid var(--border-color);border-radius:8px;white-space:pre-wrap;word-break:break-word;font-size:12.5px;color:var(--text-primary);max-height:180px;overflow-y:auto;">${escapeHtml(item.content)}</pre>
          </div>
        </div>
        <div class="file-actions">
          <button class="btn btn-primary btn-sm btn-copy-clip">📋 คัดลอกข้อความ</button>
          <button class="btn btn-secondary btn-sm btn-save-clip-txt">💾 บันทึกเป็นไฟล์ .txt ลง NAS</button>
          <button class="btn btn-danger btn-sm btn-del-clip">🗑️ ลบ</button>
        </div>
      `;

      card.querySelector('.btn-copy-clip').addEventListener('click', () => {
        navigator.clipboard?.writeText(item.content);
        showToast('คัดลอกข้อความลงคลิปบอร์ดแล้ว!', 'success');
      });

      card.querySelector('.btn-save-clip-txt').addEventListener('click', async () => {
        const safeName = `${String(item.title || 'snippet').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'snippet'}.txt`;
        try {
          const res = await apiRequest('/api/files/create-file', {
            method: 'POST',
            body: {
              path: state.currentPath || '/',
              filename: safeName,
              content: item.content,
            },
          });
          showToast(res.message, 'success');
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      card.querySelector('.btn-del-clip').addEventListener('click', async () => {
        try {
          await apiRequest(`/api/clipboard/${encodeURIComponent(item.id)}`, {
            method: 'DELETE',
          });
          showToast('ลบข้อความออกจากคลิปบอร์ดแล้ว', 'success');
          loadClipboardView();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      container.appendChild(card);
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function openBatchRenameModal(pathsArray) {
  if (!pathsArray || pathsArray.length === 0) return;
  state.batchRenamePaths = pathsArray;
  document.getElementById('batch-rename-form')?.reset();
  document.getElementById('batch-rename-mode').value = 'pattern';
  document.getElementById('batch-mode-pattern-box')?.classList.remove('hidden');
  document.getElementById('batch-mode-prefix-box')?.classList.add('hidden');
  document.getElementById('batch-mode-replace-box')?.classList.add('hidden');
  updateBatchRenamePreview();
  document.getElementById('batch-rename-modal')?.classList.remove('hidden');
}

function updateBatchRenamePreview() {
  const paths = state.batchRenamePaths || [];
  const previewEl = document.getElementById('batch-rename-preview');
  if (!previewEl) return;

  const mode = document.getElementById('batch-rename-mode')?.value || 'pattern';
  const pattern = document.getElementById('batch-pattern-input')?.value || 'File-{n}';
  const startNum = Number(document.getElementById('batch-start-num')?.value || 1);
  const prefix = document.getElementById('batch-prefix-input')?.value || '';
  const suffix = document.getElementById('batch-suffix-input')?.value || '';
  const findText = document.getElementById('batch-find-input')?.value || '';
  const replaceText = document.getElementById('batch-replace-input')?.value || '';

  const lines = paths.map((p, idx) => {
    const oldName = p.split('/').filter(Boolean).pop() || p;
    const dotIdx = oldName.lastIndexOf('.');
    const hasExt = dotIdx > 0;
    const ext = hasExt ? oldName.slice(dotIdx) : '';
    const stem = hasExt ? oldName.slice(0, dotIdx) : oldName;

    let newStem = stem;
    if (mode === 'pattern') {
      const numStr = String(startNum + idx).padStart(3, '0');
      newStem = pattern.includes('{n}') ? pattern.replace(/\{n\}/gi, numStr) : `${pattern}-${numStr}`;
    } else if (mode === 'prefix_suffix') {
      newStem = `${prefix}${stem}${suffix}`;
    } else if (mode === 'replace') {
      newStem = findText ? stem.split(findText).join(replaceText) : stem;
    }
    const newName = `${newStem}${ext}`;
    return `<div style="padding:4px 8px;"><code>${escapeHtml(oldName)}</code> ➡️ <strong style="color:#38bdf8;">${escapeHtml(newName)}</strong></div>`;
  });

  previewEl.innerHTML = lines.join('');
}

async function openChecksumModal(item) {
  if (!item || item.isDirectory) return;
  document.getElementById('checksum-modal-title').textContent = `#️⃣ ตรวจสอบ Checksum ของ "${item.name}"`;
  document.getElementById('checksum-loading')?.classList.remove('hidden');
  document.getElementById('checksum-content')?.classList.add('hidden');
  document.getElementById('checksum-verify-input').value = '';
  document.getElementById('checksum-verify-result').textContent = '';
  document.getElementById('checksum-modal')?.classList.remove('hidden');

  try {
    const data = await apiRequest(`/api/files/checksum?path=${encodeURIComponent(item.path)}`);
    const hashes = data.hashes || { md5: data.md5, sha1: data.sha1, sha256: data.sha256 };
    document.getElementById('hash-md5-val').value = hashes.md5 || '';
    document.getElementById('hash-sha1-val').value = hashes.sha1 || '';
    document.getElementById('hash-sha256-val').value = hashes.sha256 || '';
    state.currentChecksums = hashes;
    document.getElementById('checksum-loading')?.classList.add('hidden');
    document.getElementById('checksum-content')?.classList.remove('hidden');
    verifyChecksumMatch();
  } catch (err) {
    document.getElementById('checksum-loading').textContent = `❌ เกิดข้อผิดพลาด: ${err.message}`;
  }
}

function verifyChecksumMatch() {
  const input = (document.getElementById('checksum-verify-input')?.value || '').trim().toLowerCase();
  const resultEl = document.getElementById('checksum-verify-result');
  if (!resultEl) return;
  if (!input || !state.currentChecksums) {
    resultEl.textContent = '';
    return;
  }

  const { md5 = '', sha1 = '', sha256 = '' } = state.currentChecksums;
  if (input === md5.toLowerCase()) {
    resultEl.innerHTML = '<span style="color:#22c55e;">✅ ตรงกับค่า MD5 ของไฟล์นี้ (ไฟล์สมบูรณ์ 100%)</span>';
  } else if (input === sha1.toLowerCase()) {
    resultEl.innerHTML = '<span style="color:#22c55e;">✅ ตรงกับค่า SHA-1 ของไฟล์นี้ (ไฟล์สมบูรณ์ 100%)</span>';
  } else if (input === sha256.toLowerCase()) {
    resultEl.innerHTML = '<span style="color:#22c55e;">✅ ตรงกับค่า SHA-256 ของไฟล์นี้ (ไฟล์สมบูรณ์ 100%)</span>';
  } else {
    resultEl.innerHTML = '<span style="color:#ef4444;">❌ ค่าแฮชไม่ตรงกับทั้ง MD5, SHA-1 และ SHA-256</span>';
  }
}

async function openSendInboxModal(pathsArray) {
  if (!pathsArray || pathsArray.length === 0) return;
  state.sendInboxPaths = pathsArray;

  try {
    const data = await apiRequest('/api/inbox/recipients');
    const select = document.getElementById('inbox-recipient-select');
    select.innerHTML = '';

    const recipients = data.recipients || data.users || [];
    recipients.forEach((u) => {
      const opt = document.createElement('option');
      opt.value = u.username;
      opt.textContent = `${u.username} (${u.role === 'admin' ? 'Admin' : 'User'}${u.username === state.user?.username ? ' - ตัวคุณเอง' : ''})`;
      select.appendChild(opt);
    });

    document.getElementById('send-inbox-title').textContent = `📨 ส่ง ${pathsArray.length} รายการเข้า Inbox สมาชิก`;
    document.getElementById('inbox-message-input').value = '';
    document.getElementById('send-inbox-modal')?.classList.remove('hidden');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ================= RECYCLE BIN (TRASH) =================
async function loadTrashCount() {
  try {
    const data = await apiRequest('/api/trash');
    state.trashItems = data.items || [];
    const badge = document.getElementById('trash-count-badge');
    if (state.trashItems.length > 0) {
      badge.textContent = state.trashItems.length;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch {
    // Ignore
  }
}

async function loadTrashItems() {
  try {
    const data = await apiRequest('/api/trash');
    state.trashItems = data.items || [];
    loadTrashCount();

    const container = document.getElementById('trash-container');
    const emptyEl = document.getElementById('trash-empty');
    container.innerHTML = '';

    if (state.trashItems.length === 0) {
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');

    state.trashItems.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'file-card';
      const icon = item.is_directory ? '📁' : '📄';

      card.innerHTML = `
        <div class="file-card-top">
          <div class="file-icon">${icon}</div>
          <div class="file-info">
            <div class="file-name">${escapeHtml(item.original_name)}</div>
            <div class="file-meta">
              ตำแหน่งเดิม: <code>${escapeHtml(item.original_path)}</code> • ขนาด: ${formatBytes(item.size)} • ลบโดย: ${escapeHtml(item.deleted_by)} • เมื่อ: ${formatDate(item.deleted_at)}
            </div>
          </div>
        </div>
        <div class="file-actions">
          <button class="btn btn-secondary btn-restore">♻️ กู้คืน</button>
          <button class="btn btn-danger btn-perm-delete">✕ ลบถาวร</button>
        </div>
      `;

      card.querySelector('.btn-restore').addEventListener('click', async () => {
        try {
          const res = await apiRequest('/api/trash/restore', {
            method: 'POST',
            body: { id: item.id },
          });
          showToast(`กู้คืนไปยัง ${res.restoredPath} สำเร็จ`, 'success');
          loadTrashItems();
          fetchSystemStats();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      card.querySelector('.btn-perm-delete').addEventListener('click', async () => {
        const confirmed = await openConfirmModal({
          title: '🔥 ยืนยันการลบถาวร (Permanent Delete)',
          icon: '⚠️',
          heading: `ต้องการลบ "${item.original_name}" ออกถาวรใช่หรือไม่?`,
          description:
            'คำเตือน: เมื่อลบออกจากถังขยะแล้ว จะไม่สามารถกู้คืนไฟล์หรือโฟลเดอร์นี้กลับมาได้อีก!',
          targetText: `ตำแหน่งเดิม: ${item.original_path} (${formatBytes(item.size)})`,
          confirmText: '🔥 ลบถาวรทันที',
        });
        if (!confirmed) return;

        try {
          await apiRequest(`/api/trash/${encodeURIComponent(item.id)}`, {
            method: 'DELETE',
          });
          showToast(`ลบ "${item.original_name}" ถาวรแล้ว`, 'success');
          loadTrashItems();
          fetchSystemStats();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });

      container.appendChild(card);
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ================= PHASE 8: SMART WORKSPACE, MEDIA STUDIO & POWER UTILITIES =================

// 1. Built-in SVG QR Code Modal
async function openQrCodeModal(targetUrl, subtitle = 'เปิดกล้องมือถือหรือแท็บเล็ตในวง Wi-Fi เดียวกันเพื่อสแกนเข้าใช้งานทันที') {
  if (!targetUrl) return;
  const modal = document.getElementById('qr-modal');
  const svgBox = document.getElementById('qr-svg-container');
  const urlInput = document.getElementById('qr-url-input');
  const subEl = document.getElementById('qr-modal-subtitle');
  if (!modal || !svgBox) return;

  if (urlInput) urlInput.value = targetUrl;
  if (subEl) subEl.textContent = subtitle;
  state.currentQrUrl = targetUrl;
  svgBox.innerHTML = '<div style="padding:36px;color:#121212;font-size:13px;">กำลังสร้าง QR Code...</div>';
  modal.classList.remove('hidden');

  try {
    const data = await apiRequest(`/api/qr?text=${encodeURIComponent(targetUrl)}`);
    svgBox.innerHTML = data.svg || '';
  } catch (err) {
    svgBox.innerHTML = `<div style="padding:20px;color:#ef4444;">${escapeHtml(err.message)}</div>`;
  }
}

// 2. Full-Text Content Search (Grep inside files)
async function runFullTextGrepSearch() {
  const input = document.getElementById('grep-search-input');
  const caseCheck = document.getElementById('grep-case-check');
  const listEl = document.getElementById('grep-search-results');
  const summaryEl = document.getElementById('grep-search-summary');
  if (!input || !listEl) return;

  const q = input.value.trim();
  if (!q) {
    showToast('กรุณาพิมพ์คำที่ต้องการค้นหาในเนื้อหาไฟล์', 'error');
    input.focus();
    return;
  }

  const caseSensitive = caseCheck?.checked ? '1' : '0';
  if (summaryEl) {
    summaryEl.textContent = `⏳ กำลังสแกนเนื้อหาภายในไฟล์ข้อความและโค้ดทั้งหมดสำหรับคำว่า "${q}"...`;
  }
  listEl.innerHTML = '';

  try {
    const data = await apiRequest(
      `/api/index/grep?q=${encodeURIComponent(q)}&caseSensitive=${caseSensitive}`
    );
    const results = data.results || [];
    if (summaryEl) {
      summaryEl.textContent = `สแกนเสร็จสิ้น ${data.scannedFiles || 0} ไฟล์ • พบคำว่า "${q}" ทั้งหมด ${data.totalMatches || 0} จุด ใน ${results.length} ไฟล์`;
    }

    if (results.length === 0) {
      listEl.innerHTML = `<div style="padding:18px;text-align:center;color:var(--text-secondary);">ไม่พบคำว่า "${escapeHtml(q)}" ในเนื้อหาไฟล์ข้อความใดๆ</div>`;
      return;
    }

    const highlightEscaped = (lineText, queryStr, isCaseSens) => {
      const safeLine = escapeHtml(lineText);
      const safeQ = escapeHtml(queryStr).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!safeQ) return safeLine;
      try {
        const reg = new RegExp(`(${safeQ})`, isCaseSens ? 'g' : 'gi');
        return safeLine.replace(reg, '<mark class="grep-highlight">$1</mark>');
      } catch {
        return safeLine;
      }
    };

    results.forEach((fileMatch) => {
      const card = document.createElement('div');
      card.className = 'file-card';
      const matchCount = fileMatch.matchCount || (fileMatch.matches || []).length;
      const snippetsHtml = (fileMatch.matches || [])
        .map(
          (m) => `
          <div class="grep-snippet-line">
            <span class="grep-line-num">บรรทัด ${m.lineNumber}:</span>
            <span>${highlightEscaped(m.lineText || m.preview || '', q, caseCheck?.checked)}</span>
          </div>
        `
        )
        .join('');

      card.innerHTML = `
        <div class="file-card-top" style="align-items:flex-start;">
          <div class="file-icon">📝</div>
          <div class="file-info" style="width:100%;">
            <div class="file-name">${escapeHtml(fileMatch.name)} <span class="pill pill-success">${matchCount} จุดที่พบ</span></div>
            <div class="file-meta">โฟลเดอร์: <code>${escapeHtml(fileMatch.parentPath)}</code> • ขนาด: ${formatBytes(fileMatch.size)}</div>
            <div style="margin-top:8px;display:flex;flex-direction:column;gap:4px;">
              ${snippetsHtml}
            </div>
          </div>
        </div>
        <div class="file-actions">
          <button class="btn btn-primary btn-sm btn-grep-open">👁️ เปิดดู / แก้ไขไฟล์</button>
          <button class="btn btn-secondary btn-sm btn-grep-folder">📂 ไปยังโฟลเดอร์</button>
        </div>
      `;

      card.querySelector('.btn-grep-open').addEventListener('click', () => {
        openFilePreview({
          name: fileMatch.name,
          path: fileMatch.path,
          extension: fileMatch.extension,
          size: fileMatch.size,
          category: 'text',
        });
      });

      card.querySelector('.btn-grep-folder').addEventListener('click', () => {
        state.currentPath = fileMatch.parentPath || '/';
        switchTab('files');
      });

      listEl.appendChild(card);
    });
  } catch (err) {
    if (summaryEl) summaryEl.textContent = `เกิดข้อผิดพลาด: ${err.message}`;
    showToast(err.message, 'error');
  }
}

// 3. Built-in Image Studio & Metadata Inspector
async function openImageStudioModal(item) {
  if (!item) return;
  state.imageStudioItem = item;
  const modal = document.getElementById('image-studio-modal');
  const titleEl = document.getElementById('image-studio-title');
  const previewImg = document.getElementById('image-studio-preview');
  const metaBox = document.getElementById('image-studio-meta');
  if (!modal) return;

  titleEl.textContent = `🎨 สตูดิโอแต่งรูปภาพ: ${item.name}`;
  previewImg.src = `/api/files/download?path=${encodeURIComponent(item.path)}&inline=1&t=${Date.now()}`;
  metaBox.innerHTML = 'กำลังอ่านข้อมูลจำเพาะของภาพ (EXIF / SIPS Metadata)...';
  document.getElementById('image-studio-form')?.reset();
  modal.classList.remove('hidden');

  try {
    const info = await apiRequest(`/api/files/image-info?path=${encodeURIComponent(item.path)}`);
    metaBox.innerHTML = `
      <div>📐 <strong>ความละเอียด (Dimensions):</strong> <code>${info.width || '?'} × ${info.height || '?'} px</code></div>
      <div>🎨 <strong>ฟอร์แมต & สี:</strong> <code>${escapeHtml(info.format || item.extension)}</code> (${escapeHtml(info.colorSpace || 'RGB')})</div>
      <div>🖨️ <strong>ความหนาแน่นพิกเซล (DPI):</strong> <code>${info.dpi || 72} DPI</code></div>
      <div>💾 <strong>ขนาดไฟล์ปัจจุบัน:</strong> <code>${formatBytes(info.size || item.size)}</code></div>
    `;
  } catch (err) {
    metaBox.innerHTML = `<span style="color:var(--text-secondary)">ขนาดไฟล์: ${formatBytes(item.size)} (${escapeHtml(err.message)})</span>`;
  }
}

// 4. Kanban Task & Project Board
async function loadKanbanBoardView() {
  const todoEl = document.getElementById('kanban-col-todo');
  const progEl = document.getElementById('kanban-col-doing');
  const doneEl = document.getElementById('kanban-col-done');
  if (!todoEl || !progEl || !doneEl) return;

  try {
    const data = await apiRequest('/api/kanban');
    const tasks = data.tasks || [];
    state.kanbanTasks = tasks;

    const buckets = {
      todo: [],
      in_progress: [],
      done: [],
    };
    tasks.forEach((t) => {
      if (t.status === 'doing' || t.status === 'in_progress') buckets.in_progress.push(t);
      else if (t.status === 'done') buckets.done.push(t);
      else buckets.todo.push(t);
    });

    document.getElementById('kanban-count-todo').textContent = buckets.todo.length;
    document.getElementById('kanban-count-doing').textContent = buckets.in_progress.length;
    document.getElementById('kanban-count-done').textContent = buckets.done.length;

    const renderColumn = (container, list) => {
      container.innerHTML = '';
      if (list.length === 0) {
        container.innerHTML =
          '<div style="padding:18px;text-align:center;color:var(--text-secondary);font-size:12.5px;">ยังไม่มีการ์ดงานในคอลัมน์นี้</div>';
        return;
      }

      list.forEach((task) => {
        const card = document.createElement('div');
        card.className = 'kanban-card';
        const prioLabel =
          task.priority === 'high'
            ? '<span class="pill" style="background:rgba(255,69,58,0.2);color:#FF453A;">🔥 สำคัญมาก</span>'
            : task.priority === 'low'
              ? '<span class="pill">🟢 ทั่วไป</span>'
              : '<span class="pill pill-warn">⚡ ปกติ</span>';

        const linkedHtml = task.linked_path
          ? `<div style="margin-top:6px;"><button type="button" class="btn btn-secondary btn-sm btn-kanban-path" style="font-size:11.5px;padding:3px 8px;">📂 เปิด: <code>${escapeHtml(task.linked_path)}</code></button></div>`
          : '';

        const moveButtons = [];
        if (task.status !== 'todo') {
          moveButtons.push(
            `<button type="button" class="btn btn-secondary btn-sm" data-move="todo">⬅️ To Do</button>`
          );
        }
        if (task.status !== 'doing' && task.status !== 'in_progress') {
          moveButtons.push(
            `<button type="button" class="btn btn-primary btn-sm" data-move="doing">⚡ กำลังทำ</button>`
          );
        }
        if (task.status !== 'done') {
          moveButtons.push(
            `<button type="button" class="btn btn-secondary btn-sm" data-move="done">✅ เสร็จแล้ว</button>`
          );
        }

        card.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
            <div class="kanban-card-title">${escapeHtml(task.title)}</div>
            ${prioLabel}
          </div>
          ${task.description ? `<div class="kanban-card-desc">${escapeHtml(task.description)}</div>` : ''}
          ${linkedHtml}
          <div class="kanban-card-meta">
            <span>👤 ${escapeHtml(task.author_username || 'admin')}</span>
            <span>🕒 ${formatDate(task.updated_at || task.created_at)}</span>
          </div>
          <div class="kanban-card-actions">
            ${moveButtons.join('')}
            <button type="button" class="btn btn-danger btn-sm btn-del-kanban" style="margin-left:auto;">🗑️</button>
          </div>
        `;

        card.querySelectorAll('[data-move]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            try {
              await apiRequest(`/api/kanban/${encodeURIComponent(task.id)}`, {
                method: 'PUT',
                body: { status: btn.dataset.move },
              });
              loadKanbanBoardView();
            } catch (err) {
              showToast(err.message, 'error');
            }
          });
        });

        card.querySelector('.btn-kanban-path')?.addEventListener('click', () => {
          const target = task.linked_path.trim();
          state.currentPath = target.startsWith('/') ? target : `/${target}`;
          switchTab('files');
        });

        card.querySelector('.btn-del-kanban')?.addEventListener('click', async () => {
          const confirmed = await openConfirmModal({
            title: '🗑️ ยืนยันการลบการ์ดงาน Kanban',
            icon: '📌',
            heading: `ต้องการลบการ์ดงาน "${task.title}" ใช่หรือไม่?`,
            description: 'การลบการ์ดงานจะลบเฉพาะรายการบนกระดาน ไม่กระทบไฟล์ใน NAS',
            targetText: task.title,
            confirmText: '🗑️ ลบการ์ดงาน',
          });
          if (!confirmed) return;
          try {
            await apiRequest(`/api/kanban/${encodeURIComponent(task.id)}`, { method: 'DELETE' });
            showToast('ลบการ์ดงานเรียบร้อยแล้ว', 'success');
            loadKanbanBoardView();
          } catch (err) {
            showToast(err.message, 'error');
          }
        });

        container.appendChild(card);
      });
    };

    renderColumn(todoEl, buckets.todo);
    renderColumn(progEl, buckets.in_progress);
    renderColumn(doneEl, buckets.done);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// 5. Rich Markdown & Interactive CSV Table Renderers
function renderMarkdownToHtml(mdText) {
  const raw = String(mdText || '');
  let html = escapeHtml(raw);

  // Code blocks ```...```
  html = html.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_, _lang, code) => {
    return `<pre><code>${code.trim()}</code></pre>`;
  });

  // Inline code `...`
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Headings
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

  // Blockquote
  html = html.replace(/^&gt;\s+(.+)$/gm, '<blockquote>$1</blockquote>');

  // Bold & Italic
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

  // Unordered lists
  html = html.replace(/^\s*[-*]\s+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);

  // Links [text](url)
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:var(--accent-primary);text-decoration:underline;">$1</a>'
  );

  // Paragraphs / Line breaks
  return html
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      if (
        trimmed.startsWith('<h') ||
        trimmed.startsWith('<pre') ||
        trimmed.startsWith('<ul') ||
        trimmed.startsWith('<blockquote')
      ) {
        return trimmed;
      }
      return `<p>${trimmed.replace(/\n/g, '<br/>')}</p>`;
    })
    .join('\n');
}

function parseDelimitedLine(line, delimiter = ',') {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function renderCsvTableView(container, rawText, delimiter = ',') {
  const lines = String(rawText || '')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);

  if (lines.length === 0) {
    container.innerHTML = '<div style="padding:20px;color:var(--text-secondary);">ไฟล์ CSV ว่างเปล่า</div>';
    return;
  }

  const rows = lines.map((line) => parseDelimitedLine(line, delimiter));
  const headers = rows[0] || [];
  const dataRows = rows.slice(1);

  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px;flex-wrap:wrap;">
      <span style="font-size:12.5px;color:var(--text-secondary);">📊 ตารางข้อมูลทั้งหมด <strong>${dataRows.length} แถว</strong> • <strong>${headers.length} คอลัมน์</strong></span>
      <input type="text" id="csv-filter-input" placeholder="🔍 พิมพ์เพื่อกรองแถวในตาราง..." style="max-width:260px;padding:6px 10px;font-size:12.5px;" />
    </div>
    <div style="max-height:58vh;overflow:auto;">
      <table class="csv-table">
        <thead>
          <tr>
            <th>#</th>
            ${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}
          </tr>
        </thead>
        <tbody id="csv-table-tbody"></tbody>
      </table>
    </div>
  `;

  const tbody = container.querySelector('#csv-table-tbody');
  const filterInput = container.querySelector('#csv-filter-input');

  const drawBody = (q = '') => {
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? dataRows.filter((r) => r.some((cell) => String(cell).toLowerCase().includes(needle)))
      : dataRows;

    tbody.innerHTML = filtered
      .slice(0, 500)
      .map(
        (r, idx) => `
        <tr>
          <td style="color:var(--text-secondary);font-family:var(--font-mono);">${idx + 1}</td>
          ${headers.map((_, cIdx) => `<td>${escapeHtml(r[cIdx] ?? '')}</td>`).join('')}
        </tr>
      `
      )
      .join('');
  };

  drawBody('');
  filterInput?.addEventListener('input', (e) => drawBody(e.target.value));
}

// ================= PHASE 9: PRO UX, CONTEXT MENU, INSPECTOR, RECENT STRIP, LIVE PROCESSES & LOCK SCREEN =================

// 1. Mobile Sidebar Drawer Toggle
function toggleMobileSidebar(forceOpen = null) {
  const sidebar = document.getElementById('main-sidebar') || document.querySelector('.sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (!sidebar) return;

  const isOpen =
    forceOpen !== null ? Boolean(forceOpen) : !sidebar.classList.contains('mobile-open');
  sidebar.classList.toggle('mobile-open', isOpen);
  backdrop?.classList.toggle('hidden', !isOpen);
}

// 2. Recent Files Strip
async function loadRecentFilesStrip() {
  const panel = document.getElementById('recent-files-panel');
  const strip = document.getElementById('recent-files-strip');
  if (!panel || !strip) return;

  try {
    const data = await apiRequest('/api/files/recent?limit=8');
    const items = data.items || [];
    if (items.length === 0) {
      panel.classList.add('hidden');
      return;
    }

    panel.classList.remove('hidden');
    strip.innerHTML = '';

    items.forEach((f) => {
      const chip = document.createElement('div');
      chip.className = 'recent-file-chip';
      const icon = getCategoryIcon(f.category, false);
      chip.innerHTML = `
        <span class="recent-chip-icon">${icon}</span>
        <div class="recent-chip-info">
          <div class="recent-chip-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
          <div class="recent-chip-meta">${escapeHtml(f.parentPath || '/')} • ${formatBytes(f.size)}</div>
        </div>
      `;
      chip.addEventListener('click', () => {
        if (f.isVault) {
          openVaultModal(f);
        } else {
          openFilePreview(f);
        }
      });
      chip.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openFileContextMenu(e, f, items);
      });
      strip.appendChild(chip);
    });
  } catch {
    // Ignore errors loading recent strip
  }
}

// 3. File Inspector Side Drawer
async function openFileInspector(item) {
  const drawer = document.getElementById('file-inspector-drawer');
  const body = document.getElementById('inspector-body');
  if (!drawer || !body || !item) return;

  state.inspectedItem = item;
  drawer.classList.remove('hidden');

  const isImg = !item.isDirectory && item.category === 'image';
  const thumbUrl = `/api/files/thumbnail?path=${encodeURIComponent(item.path)}`;
  const previewBoxHtml = isImg
    ? `<img src="${thumbUrl}" alt="${escapeHtml(item.name)}" />`
    : `<span>${getCategoryIcon(item.category, item.isDirectory)}</span>`;

  body.innerHTML = `
    <div class="inspector-preview-box">${previewBoxHtml}</div>
    <div style="font-size:15px;font-weight:700;word-break:break-word;margin-bottom:4px;">
      ${escapeHtml(item.name)}
    </div>
    <div style="font-size:12px;color:var(--text-secondary);margin-bottom:14px;">
      Path: <code>${escapeHtml(item.path)}</code>
    </div>

    <div class="sys-stats-list" style="margin-bottom:14px;">
      <div class="sys-stat-row">
        <span>ประเภท (Category):</span>
        <strong>${item.isDirectory ? 'โฟลเดอร์ (Folder)' : escapeHtml(item.category || 'file')}</strong>
      </div>
      <div class="sys-stat-row">
        <span>ขนาด (Size):</span>
        <strong>${item.isDirectory ? '-' : formatBytes(item.size)}</strong>
      </div>
      <div class="sys-stat-row">
        <span>แก้ไขล่าสุด:</span>
        <strong>${formatDate(item.modifiedAt)}</strong>
      </div>
      <div class="sys-stat-row">
        <span>ป้ายกำกับสี:</span>
        <strong>${escapeHtml(item.tagColor || 'ไม่มี')}</strong>
      </div>
    </div>

    ${
      item.tagNote
        ? `<div class="note-pill" style="margin-bottom:14px;">📝 ${escapeHtml(item.tagNote)}</div>`
        : ''
    }

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
      <button type="button" class="btn btn-primary btn-sm" id="insp-open-btn">
        ${item.isDirectory ? '📂 เปิดโฟลเดอร์' : '👁️ เปิดดูไฟล์'}
      </button>
      <button type="button" class="btn btn-secondary btn-sm" id="insp-share-btn">
        🔗 แชร์ / QR
      </button>
      <button type="button" class="btn btn-secondary btn-sm" id="insp-tag-btn">
        🏷️ ป้ายสี & โน้ต
      </button>
      ${
        !item.isDirectory
          ? `<button type="button" class="btn btn-secondary btn-sm" id="insp-hash-btn">#️⃣ Checksum</button>`
          : `<button type="button" class="btn btn-secondary btn-sm" id="insp-zip-btn">📦 โหลด ZIP</button>`
      }
    </div>
    ${
      !item.isDirectory && item.category === 'image'
        ? `<button type="button" class="btn btn-secondary btn-block btn-sm" id="insp-studio-btn" style="margin-bottom:8px;">🎨 เปิดในสตูดิโอแต่งรูป (Image Studio)</button>`
        : ''
    }
  `;

  body.querySelector('#insp-open-btn')?.addEventListener('click', () => {
    if (item.isDirectory) loadDirectory(item.path);
    else if (item.isVault) openVaultModal(item);
    else openFilePreview(item);
  });
  body.querySelector('#insp-share-btn')?.addEventListener('click', () => openShareModal(item));
  body.querySelector('#insp-tag-btn')?.addEventListener('click', () => openTagModal(item));
  body.querySelector('#insp-hash-btn')?.addEventListener('click', () => openChecksumModal(item));
  body.querySelector('#insp-zip-btn')?.addEventListener('click', () => downloadAsZip([item.path]));
  body.querySelector('#insp-studio-btn')?.addEventListener('click', () => openImageStudioModal(item));
}

// 4. Right-Click Context Menu
function closeFileContextMenu() {
  document.getElementById('file-context-menu')?.classList.add('hidden');
}

function openFileContextMenu(e, item, currentFilteredList = []) {
  const menu = document.getElementById('file-context-menu');
  if (!menu || !item) return;

  const actions = [
    {
      label: item.isDirectory ? '📂 เปิดโฟลเดอร์นี้' : '👁️ เปิดดู / แก้ไขไฟล์',
      run: () => {
        if (item.isDirectory) loadDirectory(item.path);
        else if (item.isVault) openVaultModal(item);
        else {
          const mediaList = currentFilteredList.filter(
            (f) => !f.isDirectory && (f.category === 'image' || f.category === 'video')
          );
          openFilePreview(item, mediaList);
        }
      },
    },
    {
      label: 'ℹ️ ดูข้อมูลเชิงลึก (File Inspector)',
      run: () => openFileInspector(item),
    },
    {
      label: item.isStarred ? '⭐ นำออกจากรายการโปรด' : '☆ เพิ่มในรายการโปรด',
      run: () => toggleStarItem(item.path),
    },
    {
      label: '🏷️ ติดป้ายกำกับสี & เขียนโน้ต',
      run: () => openTagModal(item),
    },
  ];

  if (!item.isDirectory && item.category === 'image') {
    actions.push({
      label: '🎨 แต่งรูป / แปลงนามสกุล (Image Studio)',
      run: () => openImageStudioModal(item),
    });
  }
  if (item.isExtractable) {
    actions.push({
      label: '📂 แตกไฟล์บีบอัดลงในโฟลเดอร์นี้',
      run: () => extractArchiveItem(item),
    });
  }

  actions.push(
    { divider: true },
    {
      label: '🔗 สร้างลิงก์แชร์สาธารณะ & QR Code',
      run: () => openShareModal(item),
    },
    {
      label: item.isDirectory ? '📦 ดาวน์โหลดทั้งโฟลเดอร์เป็น .ZIP' : '⬇️ ดาวน์โหลดไฟล์ลงเครื่อง',
      run: () => {
        if (item.isDirectory) downloadAsZip([item.path]);
        else window.location.href = `/api/files/download?path=${encodeURIComponent(item.path)}`;
      },
    }
  );

  if (!item.isDirectory) {
    actions.push(
      {
        label: item.isVault ? '🔓 ถอดรหัสไฟล์ .vault (Decrypt)' : '🔐 เข้ารหัสล็อกไฟล์ AES-256 (.vault)',
        run: () => openVaultModal(item),
      },
      {
        label: '🕓 ประวัติเวอร์ชันย้อนหลัง (Rollback)',
        run: () => openVersionsModal(item),
      },
      {
        label: '#️⃣ ตรวจสอบค่าแฮช (MD5 / SHA-256)',
        run: () => openChecksumModal(item),
      }
    );
  }

  actions.push(
    { divider: true },
    {
      label: '✏️ เปลี่ยนชื่อ (Rename)',
      run: () => {
        openPromptModal('✏️ เปลี่ยนชื่อ', 'ชื่อใหม่:', item.name, async (newName) => {
          await apiRequest('/api/files/rename', {
            method: 'POST',
            body: { path: item.path, newName },
          });
          showToast('เปลี่ยนชื่อเรียบร้อยแล้ว', 'success');
          loadDirectory(state.currentPath);
        });
      },
    },
    {
      label: '📂 ย้ายไปโฟลเดอร์อื่น...',
      run: () => openFolderPickerModal('move', [item.path]),
    },
    {
      label: '📋 คัดลอกไปโฟลเดอร์อื่น...',
      run: () => openFolderPickerModal('copy', [item.path]),
    },
    {
      label: '🗑️ ย้ายไปถังขยะ (Delete)',
      danger: true,
      run: async () => {
        const confirmed = await openConfirmModal({
          title: '🗑️ ยืนยันการลบลงถังขยะ',
          icon: item.isDirectory ? '📁' : '🗑️',
          heading: `คุณต้องการลบ "${item.name}" ใช่หรือไม่?`,
          description:
            'รายการนี้จะถูกย้ายไปเก็บพักไว้ในถังขยะ (Recycle Bin) คุณสามารถกู้คืนกลับมาได้ตลอดเวลา',
          targetText: `Path: ${item.path}`,
          confirmText: '🗑️ ย้ายไปถังขยะ',
        });
        if (!confirmed) return;
        await apiRequest('/api/files/trash', {
          method: 'POST',
          body: { path: item.path },
        });
        showToast(`ย้าย "${item.name}" ไปที่ถังขยะแล้ว`, 'success');
        loadDirectory(state.currentPath);
        loadTrashCount();
        fetchSystemStats();
      },
    }
  );

  menu.innerHTML = `<div class="ctx-menu-header">${escapeHtml(item.name)}</div>`;
  actions.forEach((act) => {
    if (act.divider) {
      const div = document.createElement('div');
      div.className = 'ctx-menu-divider';
      menu.appendChild(div);
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ctx-menu-item ${act.danger ? 'danger' : ''}`;
    btn.textContent = act.label;
    btn.addEventListener('click', () => {
      closeFileContextMenu();
      act.run();
    });
    menu.appendChild(btn);
  });

  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 12;
  const maxY = window.innerHeight - rect.height - 12;
  menu.style.left = `${Math.max(10, Math.min(e.clientX, maxX))}px`;
  menu.style.top = `${Math.max(10, Math.min(e.clientY, maxY))}px`;
}

// 5. Live Top CPU & Memory Processes Telemetry
async function fetchTopProcessesTelemetry() {
  const tbody = document.getElementById('sys-processes-tbody');
  if (!tbody) return;

  try {
    const data = await apiRequest('/api/system/processes?limit=10');
    const nas = data.nasProcess || {};
    const list = data.processes || [];

    const setEl = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    setEl('nas-engine-pid', `${nas.pid || '-'}`);
    setEl('nas-engine-node', `${nas.nodeVersion || '-'}`);
    setEl('nas-engine-rss', formatBytes(nas.rssBytes || 0));
    setEl('nas-engine-heap', `${formatBytes(nas.heapUsedBytes || 0)} / ${formatBytes(nas.heapTotalBytes || 0)}`);
    setEl('nas-engine-uptime', formatUptime(nas.uptimeSeconds || 0));

    if (list.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="5" style="text-align:center;color:var(--text-secondary);">ไม่พบข้อมูลโปรเซส</td></tr>';
      return;
    }

    tbody.innerHTML = list
      .map(
        (p) => `
        <tr style="${p.isNasServer ? 'background:rgba(0,229,255,0.08);' : ''}">
          <td><code>${p.pid}</code></td>
          <td>
            <strong>${escapeHtml(p.name)}</strong>
            ${p.isNasServer ? '<span class="pill pill-success" style="margin-left:6px;">NAS Server</span>' : ''}
          </td>
          <td style="color:${p.cpuPercent >= 50 ? 'var(--danger)' : 'var(--primary)'};font-weight:700;">${p.cpuPercent}%</td>
          <td>${p.memPercent}%</td>
          <td>${formatBytes(p.memoryBytes || 0)}</td>
        </tr>
      `
      )
      .join('');
  } catch {
    // Ignore transient errors
  }
}

// ================= BEAUTIFUL CONFIRMATION MODAL HELPER =================
function openConfirmModal({
  title = '🗑️ ยืนยันการลบรายการ',
  icon = '🗑️',
  heading = 'คุณต้องการลบรายการนี้ใช่หรือไม่?',
  description = 'กรุณาตรวจสอบรายการก่อนดำเนินการ',
  targetText = '',
  confirmText = '🗑️ ยืนยันการลบ',
} = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal');
    if (!modal) {
      resolve(true);
      return;
    }

    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-icon').textContent = icon;
    document.getElementById('confirm-modal-heading').textContent = heading;
    document.getElementById('confirm-modal-desc').textContent = description;

    const targetBox = document.getElementById('confirm-modal-target-box');
    if (targetText) {
      targetBox.textContent = targetText;
      targetBox.classList.remove('hidden');
    } else {
      targetBox.textContent = '';
      targetBox.classList.add('hidden');
    }

    const acceptBtn = document.getElementById('accept-confirm-modal-btn');
    acceptBtn.textContent = confirmText;

    state.confirmResolver = resolve;
    modal.classList.remove('hidden');
    setTimeout(() => acceptBtn.focus(), 40);
  });
}

function closeConfirmModal(accepted = false) {
  const modal = document.getElementById('confirm-modal');
  modal?.classList.add('hidden');
  if (state.confirmResolver) {
    const resolver = state.confirmResolver;
    state.confirmResolver = null;
    resolver(Boolean(accepted));
  }
}

// ================= PROMPT MODAL HELPER =================
function openPromptModal(title, label, defaultValue, onSubmit) {
  document.getElementById('prompt-title').textContent = title;
  document.getElementById('prompt-label').textContent = label;
  const input = document.getElementById('prompt-input');
  input.value = defaultValue || '';
  state.promptCallback = onSubmit;
  document.getElementById('prompt-modal').classList.remove('hidden');
  setTimeout(() => input.focus(), 50);
}

function closePromptModal() {
  document.getElementById('prompt-modal').classList.add('hidden');
  state.promptCallback = null;
}

// ================= EVENT LISTENERS =================
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(state.theme);

  document.querySelectorAll('.js-theme-toggle').forEach((btn) => {
    btn.addEventListener('click', toggleTheme);
  });

  checkSession();

  // Login Form
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('login-error');
    errEl.classList.add('hidden');
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;

    try {
      const data = await apiRequest('/api/auth/login', {
        method: 'POST',
        body: { username, password },
      });
      state.user = data.user;
      state.currentPath = '/';
      showToast(`ยินดีต้อนรับ ${data.user.username}!`, 'success');
      enterAppScreen();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  // Login Password Visibility Toggle
  document.getElementById('toggle-login-pwd-btn')?.addEventListener('click', () => {
    const pwdInput = document.getElementById('login-password');
    const toggleBtn = document.getElementById('toggle-login-pwd-btn');
    if (!pwdInput || !toggleBtn) return;
    const isHidden = pwdInput.type === 'password';
    pwdInput.type = isHidden ? 'text' : 'password';
    toggleBtn.textContent = isHidden ? '🙈' : '👁️';
  });

  // Logout
  document.getElementById('logout-btn').addEventListener('click', async () => {
    document.getElementById('user-dropdown-menu')?.classList.add('hidden');
    document.getElementById('topbar-user-menu-wrap')?.classList.remove('open');
    await apiRequest('/api/auth/logout', { method: 'POST' });
    state.user = null;
    showLoginScreen();
  });

  // Top-Right User Profile Dropdown Toggle
  const userMenuWrap = document.getElementById('topbar-user-menu-wrap');
  const userDropdown = document.getElementById('user-dropdown-menu');
  document.getElementById('user-menu-trigger')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = userDropdown?.classList.toggle('hidden');
    userMenuWrap?.classList.toggle('open', !isHidden);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#topbar-user-menu-wrap')) {
      userDropdown?.classList.add('hidden');
      userMenuWrap?.classList.remove('open');
    }
  });

  // Sidebar Tabs
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Search
  document.getElementById('search-input').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderFiles();
  });

  // Sort Select
  document.getElementById('sort-select').addEventListener('change', (e) => {
    state.sortBy = e.target.value;
    renderFiles();
  });

  // Select All Button
  document.getElementById('select-all-btn').addEventListener('click', () => {
    const visible = getSortedAndFilteredFiles();
    if (visible.length === 0) return;

    const allSelected = visible.every((item) => state.selectedPaths.has(item.path));
    if (allSelected) {
      clearSelection();
    } else {
      visible.forEach((item) => state.selectedPaths.add(item.path));
      updateSelectionBar();
      renderFiles();
    }
  });

  // Batch Selection Actions
  document.getElementById('clear-selection-btn').addEventListener('click', clearSelection);

  document.getElementById('batch-zip-btn').addEventListener('click', () => {
    downloadAsZip(Array.from(state.selectedPaths));
  });

  document.getElementById('batch-move-btn').addEventListener('click', () => {
    openFolderPickerModal('move', Array.from(state.selectedPaths));
  });

  document.getElementById('batch-copy-btn').addEventListener('click', () => {
    openFolderPickerModal('copy', Array.from(state.selectedPaths));
  });

  document.getElementById('batch-trash-btn').addEventListener('click', async () => {
    const paths = Array.from(state.selectedPaths);
    if (paths.length === 0) return;

    const previewNames = paths
      .slice(0, 5)
      .map((p) => p.split('/').filter(Boolean).pop() || p)
      .join(', ');
    const moreText = paths.length > 5 ? ` และอีก ${paths.length - 5} รายการ` : '';

    const confirmed = await openConfirmModal({
      title: '🗑️ ยืนยันการลบหลายรายการพร้อมกัน',
      icon: '🗑️',
      heading: `ต้องการย้ายทั้ง ${paths.length} รายการไปที่ถังขยะใช่หรือไม่?`,
      description:
        'รายการที่เลือกทั้งหมดจะถูกย้ายไปเก็บพักไว้ในถังขยะ (Recycle Bin) และสามารถกู้คืนภายหลังได้',
      targetText: `รายการที่เลือก: ${previewNames}${moreText}`,
      confirmText: `🗑️ ลบทั้ง ${paths.length} รายการลงถังขยะ`,
    });
    if (!confirmed) return;

    try {
      await apiRequest('/api/files/trash', {
        method: 'POST',
        body: { paths },
      });
      showToast(`ย้าย ${paths.length} รายการไปที่ถังขยะแล้ว`, 'success');
      clearSelection();
      loadDirectory(state.currentPath);
      loadTrashCount();
      fetchSystemStats();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Folder Picker Modal
  document.getElementById('folder-picker-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const targetDir = document.getElementById('folder-picker-select').value;
    if (!state.folderPickerCallback) return;
    try {
      await state.folderPickerCallback(targetDir);
      closeFolderPickerModal();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
  document.getElementById('close-folder-picker-btn').addEventListener('click', closeFolderPickerModal);
  document.getElementById('cancel-folder-picker-btn').addEventListener('click', closeFolderPickerModal);

  // Create Public Share Link Modal (Phase 3)
  document.getElementById('share-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.sharingItemPath) return;

    const password = document.getElementById('share-password').value.trim();
    const expiresInHours = Number(document.getElementById('share-expires').value || 0);
    const maxDownloads = Number(document.getElementById('share-max-downloads').value || 0);

    try {
      const data = await apiRequest('/api/shares', {
        method: 'POST',
        body: {
          path: state.sharingItemPath,
          password,
          expiresInHours,
          maxDownloads,
        },
      });
      const shareUrl = `${window.location.origin}/s/${data.share.id}`;
      document.getElementById('share-result-url').value = shareUrl;
      document.getElementById('share-result-box').classList.remove('hidden');
      document.getElementById('create-share-submit-btn').classList.add('hidden');
      loadSharesCount();
      showToast('สร้างลิงก์แชร์สาธารณะสำเร็จ!', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('copy-share-url-btn').addEventListener('click', () => {
    const urlInput = document.getElementById('share-result-url');
    urlInput.select();
    navigator.clipboard?.writeText(urlInput.value);
    showToast('คัดลอกลิงก์เรียบร้อยแล้ว', 'success');
  });

  document.getElementById('close-share-modal-btn').addEventListener('click', closeShareModal);
  document.getElementById('cancel-share-modal-btn').addEventListener('click', closeShareModal);

  // Admin Create/Edit User Modal (Phase 3)
  document.getElementById('create-user-btn').addEventListener('click', () => {
    openUserModal(null);
  });

  document.getElementById('user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('user-form-username').value.trim();
    const password = document.getElementById('user-form-password').value;
    const role = document.getElementById('user-form-role').value;
    const quotaGB = Number(document.getElementById('user-form-quota').value || 0);

    try {
      if (state.editingUserId) {
        await apiRequest(`/api/users/${state.editingUserId}`, {
          method: 'PUT',
          body: { role, quotaGB, password },
        });
        showToast('อัปเดตข้อมูลผู้ใช้เรียบร้อยแล้ว', 'success');
      } else {
        await apiRequest('/api/users', {
          method: 'POST',
          body: { username, password, role, quotaGB },
        });
        showToast(`สร้างบัญชีผู้ใช้ "${username}" สำเร็จ`, 'success');
      }
      closeUserModal();
      loadUsersList();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('close-user-modal-btn').addEventListener('click', closeUserModal);
  document.getElementById('cancel-user-modal-btn').addEventListener('click', closeUserModal);

  // Chunked Upload Pause / Resume / Cancel Controls
  const pauseBtn = document.getElementById('upload-pause-btn');
  pauseBtn.addEventListener('click', () => {
    if (!state.uploadController.active) return;
    if (!state.uploadController.paused) {
      state.uploadController.paused = true;
      pauseBtn.textContent = '▶️ ทำต่อ';
      if (state.uploadController.currentXhr) {
        state.uploadController.currentXhr.abort();
      }
      showToast('พักการอัปโหลดชั่วคราว (กด "ทำต่อ" เพื่ออัปโหลดต่อจากจุดเดิม)');
    } else {
      state.uploadController.paused = false;
      pauseBtn.textContent = '⏸️ พัก';
      if (state.uploadController.resumeResolver) {
        const resolver = state.uploadController.resumeResolver;
        state.uploadController.resumeResolver = null;
        resolver();
      }
    }
  });

  document.getElementById('upload-cancel-btn').addEventListener('click', () => {
    if (!state.uploadController.active) return;
    state.uploadController.cancelled = true;
    state.uploadController.paused = false;
    if (state.uploadController.currentXhr) {
      state.uploadController.currentXhr.abort();
    }
    if (state.uploadController.resumeResolver) {
      const resolver = state.uploadController.resumeResolver;
      state.uploadController.resumeResolver = null;
      resolver();
    }
  });

  document.getElementById('upload-close-btn').addEventListener('click', () => {
    if (state.uploadController.active) return;
    document.getElementById('upload-banner').classList.add('hidden');
  });

  // Upload Extension Policy Form (Admin)
  const policyModeSelect = document.getElementById('policy-mode-select');
  if (policyModeSelect) {
    policyModeSelect.addEventListener('change', () => {
      document
        .getElementById('policy-extensions-group')
        .classList.toggle('hidden', policyModeSelect.value === 'allow_all');
    });
  }

  const extPolicyForm = document.getElementById('extension-policy-form');
  if (extPolicyForm) {
    extPolicyForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const mode = document.getElementById('policy-mode-select').value;
      const extensions = document.getElementById('policy-extensions-input').value;
      try {
        await apiRequest('/api/settings/upload-policy', {
          method: 'PUT',
          body: { mode, extensions },
        });
        showToast('บันทึกนโยบายนามสกุลไฟล์เรียบร้อยแล้ว', 'success');
        loadUploadPolicy();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // View Mode Toggle
  document.getElementById('view-grid-btn').addEventListener('click', () => {
    state.viewMode = 'grid';
    document.getElementById('view-grid-btn').classList.add('active');
    document.getElementById('view-list-btn').classList.remove('active');
    renderFiles();
  });

  document.getElementById('view-list-btn').addEventListener('click', () => {
    state.viewMode = 'list';
    document.getElementById('view-list-btn').classList.add('active');
    document.getElementById('view-grid-btn').classList.remove('active');
    renderFiles();
  });

  // Refresh Button
  document.getElementById('refresh-btn').addEventListener('click', () => {
    if (state.activeTab === 'files') loadDirectory(state.currentPath);
    if (state.activeTab === 'favorites') loadFavoritesView();
    if (state.activeTab === 'gallery') loadMediaGalleryView(state.galleryFilter || 'all');
    if (state.activeTab === 'music') loadMusicJukeboxView();
    if (state.activeTab === 'clipboard') loadClipboardView();
    if (state.activeTab === 'indexer') runGlobalSearch();
    if (state.activeTab === 'analyzer') loadStorageAnalyzerView();
    if (state.activeTab === 'shares') {
      loadSharesList();
      loadFileRequestsList();
    }
    if (state.activeTab === 'trash') loadTrashItems();
    if (state.activeTab === 'users') loadUsersList();
    if (state.activeTab === 'advanced') loadBackupsAndWebdav();
    if (state.activeTab === 'audit') loadAuditLogsView();
    fetchSystemStats();
    showToast('อัปเดตข้อมูลล่าสุดแล้ว');
  });

  // Phase 4: Global Indexer & Duplicate Detector Events
  document.getElementById('global-search-btn')?.addEventListener('click', runGlobalSearch);
  document.getElementById('global-search-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runGlobalSearch();
  });
  document.getElementById('global-category-select')?.addEventListener('change', runGlobalSearch);

  document.getElementById('rebuild-index-btn')?.addEventListener('click', async () => {
    try {
      const res = await apiRequest('/api/index/rebuild', { method: 'POST' });
      showToast(
        `อัปเดตดัชนีสำเร็จ: ${res.totalFiles} ไฟล์, ${res.totalFolders} โฟลเดอร์ (${res.durationMs} ms)`,
        'success'
      );
      runGlobalSearch();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('scan-duplicates-btn')?.addEventListener('click', scanDuplicateFiles);

  // Phase 4: WebDAV & Auto-Backup Events
  document.getElementById('copy-webdav-url-btn')?.addEventListener('click', () => {
    const input = document.getElementById('webdav-url-input');
    input.select();
    navigator.clipboard?.writeText(input.value);
    showToast('คัดลอก WebDAV URL เรียบร้อยแล้ว', 'success');
  });

  document.getElementById('scheduler-config-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiRequest('/api/backups/config', {
        method: 'PUT',
        body: {
          autoBackupEnabled: document.getElementById('sched-auto-backup').checked,
          backupIntervalHours: Number(document.getElementById('sched-interval-hours').value || 24),
          maxBackupsKeep: Number(document.getElementById('sched-max-keep').value || 5),
          trashRetentionDays: Number(document.getElementById('sched-trash-days').value || 30),
        },
      });
      showToast('บันทึกตารางงานอัตโนมัติสำเร็จ', 'success');
      loadBackupsAndWebdav();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('run-trash-cleanup-btn')?.addEventListener('click', async () => {
    try {
      const res = await apiRequest('/api/backups/cleanup-trash', { method: 'POST' });
      showToast(res.message, 'success');
      loadTrashCount();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('create-backup-now-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('create-backup-now-btn');
    btn.disabled = true;
    btn.textContent = '⏳ กำลังบีบอัดไฟล์สร้าง Snapshot...';
    try {
      const res = await apiRequest('/api/backups/create', {
        method: 'POST',
        body: { label: 'manual', path: '/' },
      });
      showToast(`สร้าง Backup "${res.snapshot.filename}" สำเร็จ!`, 'success');
      loadBackupsAndWebdav();
      fetchSystemStats();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '➕ สร้าง Backup Snapshot ทันที';
    }
  });

  // Storage Location Path Test Button
  document.getElementById('test-storage-path-btn')?.addEventListener('click', async () => {
    const input = document.getElementById('storage-new-path-input');
    const resultBox = document.getElementById('storage-path-test-result');
    const targetPath = (input?.value || '').trim();

    if (!targetPath) {
      showToast('กรุณาระบุเส้นทางโฟลเดอร์ก่อนกดทดสอบ', 'warn');
      input?.focus();
      return;
    }

    resultBox.classList.remove('hidden');
    resultBox.style.background = 'rgba(0, 229, 255, 0.1)';
    resultBox.style.border = '1px solid rgba(0, 229, 255, 0.25)';
    resultBox.style.color = 'var(--text-primary)';
    resultBox.innerHTML = '⏳ กำลังตรวจสอบสิทธิ์การเขียนและพื้นที่ว่างในโฟลเดอร์...';

    try {
      const res = await apiRequest('/api/admin/storage-path/test', {
        method: 'POST',
        body: { path: targetPath },
      });

      const d = res.diskInfo;
      const diskHtml = d
        ? `<div style="margin-top:6px;font-size:12px;color:var(--text-secondary);">ความจุทั้งหมด: <strong>${formatBytes(d.totalBytes)}</strong> • พื้นที่ว่าง: <strong style="color:#10b981;">${formatBytes(d.freeBytes)}</strong> (${100 - d.usagePercent}% ว่าง)</div>`
        : '';

      resultBox.style.background = 'rgba(16, 185, 129, 0.12)';
      resultBox.style.border = '1px solid rgba(16, 185, 129, 0.3)';
      resultBox.innerHTML = `
        <div style="font-weight:600;color:#10b981;">✅ ตรวจสอบเส้นทางสำเร็จ: โฟลเดอร์พร้อมใช้งานและมีสิทธิ์เขียนไฟล์ได้ปกติ</div>
        <div style="font-size:12px;margin-top:4px;">📍 Path ปลายทาง: <code>${escapeHtml(res.resolvedPath)}</code></div>
        ${diskHtml}
      `;
    } catch (err) {
      resultBox.style.background = 'rgba(239, 68, 68, 0.12)';
      resultBox.style.border = '1px solid rgba(239, 68, 68, 0.3)';
      resultBox.innerHTML = `
        <div style="font-weight:600;color:#ef4444;">❌ ไม่สามารถใช้โฟลเดอร์นี้ได้</div>
        <div style="font-size:12px;margin-top:4px;">${escapeHtml(err.message)}</div>
      `;
    }
  });

  // Storage Location Path Form Submit
  document.getElementById('storage-path-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('storage-new-path-input');
    const migrate = Boolean(document.getElementById('storage-migrate-checkbox')?.checked);
    const targetPath = (input?.value || '').trim();

    if (!targetPath) {
      showToast('กรุณาระบุเส้นทางโฟลเดอร์', 'warn');
      return;
    }

    const confirmed = await openConfirmModal({
      title: '🗄️ ยืนยันการเปลี่ยนตำแหน่งจัดเก็บข้อมูล (Storage Root)',
      icon: '💽',
      heading: 'ต้องการสลับไปใช้โฟลเดอร์ใหม่นี้ใช่หรือไม่?',
      description: migrate
        ? `ระบบจะคัดลอกไฟล์ทั้งหมดจาก Storage ปัจจุบันไปยัง "${targetPath}" และสลับไปใช้เป็นพื้นที่หลักทันที`
        : `ระบบจะสลับไปใช้ "${targetPath}" เป็นพื้นที่จัดเก็บข้อมูลใหม่ทันที`,
      targetText: targetPath,
      confirmText: '💾 ยืนยันการเปลี่ยนโฟลเดอร์',
    });
    if (!confirmed) return;

    const saveBtn = document.getElementById('save-storage-path-btn');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = '⏳ กำลังสลับตำแหน่งโฟลเดอร์...';
    }

    try {
      await apiRequest('/api/admin/storage-path', {
        method: 'POST',
        body: { path: targetPath, migrate },
      });
      showToast('เปลี่ยนตำแหน่งจัดเก็บข้อมูลสำเร็จแล้ว 🎉', 'success');
      input.value = '';
      document.getElementById('storage-path-test-result')?.classList.add('hidden');
      loadStoragePathConfig();
      loadDirectory('/');
      fetchSystemStats();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 บันทึกและสลับใช้ไดรฟ์นี้';
      }
    }
  });

  // Reset Storage Location Button
  document.getElementById('reset-storage-path-btn')?.addEventListener('click', async () => {
    const confirmed = await openConfirmModal({
      title: '🔄 รีเซ็ตตำแหน่งจัดเก็บข้อมูลกลับเป็นค่าเริ่มต้น',
      icon: '📂',
      heading: 'ต้องการรีเซ็ตกลับเป็นโฟลเดอร์เริ่มต้นของโปรเจกต์หรือไม่?',
      description: 'ระบบจะกลับไปใช้โฟลเดอร์ storage/ ในโปรเจกต์ (ไฟล์ในไดรฟ์เดิมจะไม่ถูกลบ)',
      confirmText: '🔄 รีเซ็ตกลับเป็นค่าเริ่มต้น',
    });
    if (!confirmed) return;

    try {
      await apiRequest('/api/admin/storage-path/reset', { method: 'POST' });
      showToast('รีเซ็ตตำแหน่งโฟลเดอร์กลับเป็นค่าเริ่มต้นแล้ว', 'success');
      const input = document.getElementById('storage-new-path-input');
      if (input) input.value = '';
      document.getElementById('storage-path-test-result')?.classList.add('hidden');
      loadStoragePathConfig();
      loadDirectory('/');
      fetchSystemStats();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Upload Button & Input
  const fileInput = document.getElementById('file-upload-input');
  document.getElementById('upload-btn').addEventListener('click', () => {
    fileInput.value = '';
    fileInput.click();
  });
  fileInput.addEventListener('change', (e) => {
    uploadFilesList(e.target.files);
  });

  // Drag & Drop Upload
  const dropZone = document.getElementById('drop-zone');
  const dragOverlay = document.getElementById('drag-overlay');
  let dragCounter = 0;

  dropZone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (state.activeTab !== 'files' || state.draggingInternalCard) return;
    dragCounter++;
    dragOverlay.classList.remove('hidden');
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  dropZone.addEventListener('dragleave', () => {
    if (state.draggingInternalCard) return;
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      dragOverlay.classList.add('hidden');
    }
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dragOverlay.classList.add('hidden');
    if (state.activeTab !== 'files' || state.draggingInternalCard) return;
    if (e.dataTransfer && e.dataTransfer.files.length > 0) {
      uploadFilesList(e.dataTransfer.files);
    }
  });

  // Create Folder
  document.getElementById('new-folder-btn').addEventListener('click', () => {
    openPromptModal('➕ สร้างโฟลเดอร์ใหม่', 'ชื่อโฟลเดอร์:', '', async (folderName) => {
      await apiRequest('/api/files/mkdir', {
        method: 'POST',
        body: { path: state.currentPath, name: folderName },
      });
      showToast(`สร้างโฟลเดอร์ "${folderName}" สำเร็จ`, 'success');
      loadDirectory(state.currentPath);
      fetchSystemStats();
    });
  });

  // Prompt Modal Submit
  document.getElementById('prompt-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const val = document.getElementById('prompt-input').value.trim();
    if (!val || !state.promptCallback) return;
    try {
      await state.promptCallback(val);
      closePromptModal();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('close-prompt-btn').addEventListener('click', closePromptModal);
  document.getElementById('cancel-prompt-btn').addEventListener('click', closePromptModal);

  // Preview Modal Close, Lightbox Prev/Next & Save Text
  document.getElementById('close-preview-btn').addEventListener('click', () => {
    document.getElementById('preview-body').innerHTML = '';
    document.getElementById('preview-modal').classList.add('hidden');
  });

  document.getElementById('preview-prev-btn')?.addEventListener('click', () => {
    stepLightbox(-1);
  });

  document.getElementById('preview-next-btn')?.addEventListener('click', () => {
    stepLightbox(1);
  });

  document.addEventListener('keydown', (e) => {
    const previewOpen = !document.getElementById('preview-modal')?.classList.contains('hidden');
    if (!previewOpen || state.editingFilePath) return;
    if (e.key === 'ArrowLeft') stepLightbox(-1);
    if (e.key === 'ArrowRight') stepLightbox(1);
  });

  // Phase 5: Quick File Creator Modal
  const createFileModal = document.getElementById('create-file-modal');
  document.getElementById('create-file-btn')?.addEventListener('click', () => {
    document.getElementById('create-file-form')?.reset();
    createFileModal?.classList.remove('hidden');
    setTimeout(() => document.getElementById('create-file-name')?.focus(), 50);
  });
  document.getElementById('close-create-file-btn')?.addEventListener('click', () => {
    createFileModal?.classList.add('hidden');
  });
  document.getElementById('cancel-create-file-btn')?.addEventListener('click', () => {
    createFileModal?.classList.add('hidden');
  });
  document.getElementById('create-file-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const filename = document.getElementById('create-file-name').value.trim();
    const content = document.getElementById('create-file-content').value;
    try {
      const res = await apiRequest('/api/files/create-file', {
        method: 'POST',
        body: { path: state.currentPath, filename, content },
      });
      showToast(res.message, 'success');
      createFileModal?.classList.add('hidden');
      loadDirectory(state.currentPath);
      fetchSystemStats();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Phase 5: Remote URL Downloader Modal (Cloud Fetch)
  const fetchUrlModal = document.getElementById('fetch-url-modal');
  document.getElementById('fetch-url-btn')?.addEventListener('click', () => {
    document.getElementById('fetch-url-form')?.reset();
    fetchUrlModal?.classList.remove('hidden');
    setTimeout(() => document.getElementById('fetch-url-input')?.focus(), 50);
  });
  document.getElementById('close-fetch-url-btn')?.addEventListener('click', () => {
    fetchUrlModal?.classList.add('hidden');
  });
  document.getElementById('cancel-fetch-url-btn')?.addEventListener('click', () => {
    fetchUrlModal?.classList.add('hidden');
  });
  document.getElementById('fetch-url-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = document.getElementById('fetch-url-input').value.trim();
    const filename = document.getElementById('fetch-url-filename').value.trim();
    const btn = document.getElementById('submit-fetch-url-btn');
    btn.disabled = true;
    btn.textContent = '⏳ เซิร์ฟเวอร์กำลังดึงไฟล์จาก URL...';
    try {
      const res = await apiRequest('/api/files/fetch-url', {
        method: 'POST',
        body: { url, path: state.currentPath, filename },
      });
      showToast(res.message, 'success');
      fetchUrlModal?.classList.add('hidden');
      loadDirectory(state.currentPath);
      fetchSystemStats();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '⬇️ ดึงไฟล์เข้า NAS ทันที';
    }
  });

  // Phase 5: File Versioning & Rollback Modal
  document.getElementById('close-versions-modal-btn')?.addEventListener('click', () => {
    document.getElementById('versions-modal')?.classList.add('hidden');
  });
  document.getElementById('create-version-snapshot-btn')?.addEventListener('click', async () => {
    if (!state.versioningItemPath) return;
    try {
      const res = await apiRequest('/api/files/versions/snapshot', {
        method: 'POST',
        body: { path: state.versioningItemPath },
      });
      showToast(res.message, 'success');
      await refreshVersionsList(state.versioningItemPath);
      loadDirectory(state.currentPath);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Phase 5: Media Gallery Filter Buttons
  document.querySelectorAll('.gallery-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      loadMediaGalleryView(btn.dataset.type || 'all');
    });
  });

  // Phase 5: Audit Logs Clear Button
  document.getElementById('clear-audit-logs-btn')?.addEventListener('click', async () => {
    try {
      const res = await apiRequest('/api/audit-logs', { method: 'DELETE' });
      showToast(res.message, 'success');
      loadAuditLogsView();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Phase 6: Tag Filter Select, Compress on NAS, Tag Modal, Vault Modal, File Drop Modal & Storage Analyzer
  document.getElementById('tag-filter-select')?.addEventListener('change', (e) => {
    state.tagFilter = e.target.value;
    renderFiles();
  });

  document.getElementById('batch-compress-nas-btn')?.addEventListener('click', () => {
    compressSelectedOnNas(Array.from(state.selectedPaths));
  });

  const tagModal = document.getElementById('tag-modal');
  document.getElementById('close-tag-modal-btn')?.addEventListener('click', () => {
    tagModal?.classList.add('hidden');
  });
  document.getElementById('cancel-tag-modal-btn')?.addEventListener('click', () => {
    tagModal?.classList.add('hidden');
  });
  document.getElementById('tag-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.taggingItemPath) return;
    const color = document.getElementById('tag-color-select').value;
    const note = document.getElementById('tag-note-input').value.trim();
    try {
      const res = await apiRequest('/api/tags/set', {
        method: 'POST',
        body: { path: state.taggingItemPath, color, note },
      });
      showToast(res.message, 'success');
      tagModal?.classList.add('hidden');
      loadDirectory(state.currentPath);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  const vaultModal = document.getElementById('vault-modal');
  document.getElementById('close-vault-modal-btn')?.addEventListener('click', () => {
    vaultModal?.classList.add('hidden');
  });
  document.getElementById('cancel-vault-modal-btn')?.addEventListener('click', () => {
    vaultModal?.classList.add('hidden');
  });
  document.getElementById('vault-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.vaultItem) return;
    const password = document.getElementById('vault-password-input').value;
    const endpoint = state.vaultItem.isVault ? '/api/files/decrypt' : '/api/files/encrypt';
    try {
      const res = await apiRequest(endpoint, {
        method: 'POST',
        body: { path: state.vaultItem.path, password },
      });
      showToast(res.message, 'success');
      vaultModal?.classList.add('hidden');
      loadDirectory(state.currentPath);
      fetchSystemStats();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  const fileDropModal = document.getElementById('file-drop-modal');
  document.getElementById('open-create-drop-btn')?.addEventListener('click', openFileDropModal);
  document.getElementById('close-file-drop-btn')?.addEventListener('click', () => {
    fileDropModal?.classList.add('hidden');
  });
  document.getElementById('cancel-file-drop-btn')?.addEventListener('click', () => {
    fileDropModal?.classList.add('hidden');
  });
  document.getElementById('file-drop-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const folderPath = document.getElementById('file-drop-folder-select').value;
    const title = document.getElementById('file-drop-title-input').value.trim();
    const password = document.getElementById('file-drop-password-input').value.trim();
    const expiresInHours = Number(document.getElementById('file-drop-expires-select').value || 0);
    try {
      const res = await apiRequest('/api/file-requests', {
        method: 'POST',
        body: { path: folderPath, title, password, expiresInHours },
      });
      const dropUrl = `${window.location.origin}/d/${res.dropRequest.id}`;
      document.getElementById('file-drop-result-url').value = dropUrl;
      document.getElementById('file-drop-result-box').classList.remove('hidden');
      document.getElementById('submit-file-drop-btn').classList.add('hidden');
      showToast(res.message, 'success');
      loadFileRequestsList();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('copy-file-drop-url-btn')?.addEventListener('click', () => {
    const input = document.getElementById('file-drop-result-url');
    input.select();
    navigator.clipboard?.writeText(input.value);
    showToast('คัดลอกลิงก์รับฝากไฟล์แล้ว!', 'success');
  });

  document.getElementById('refresh-analyzer-btn')?.addEventListener('click', () => {
    loadStorageAnalyzerView();
    showToast('อัปเดตผลการวิเคราะห์พื้นที่แล้ว');
  });

  // Phase 7: Music Jukebox & Persistent Mini Player Events
  document.getElementById('play-all-music-btn')?.addEventListener('click', () => {
    const tracks = state.musicTracks || [];
    if (tracks.length === 0) {
      showToast('ยังไม่มีไฟล์เพลงในระบบ');
      return;
    }
    playAudioTrackInMiniPlayer(tracks[0], tracks);
  });

  document.getElementById('shuffle-all-music-btn')?.addEventListener('click', () => {
    const tracks = [...(state.musicTracks || [])];
    if (tracks.length === 0) {
      showToast('ยังไม่มีไฟล์เพลงในระบบ');
      return;
    }
    for (let i = tracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
    }
    showToast('🔀 สุ่มลำดับเพลงทั้งหมดแล้ว!', 'success');
    playAudioTrackInMiniPlayer(tracks[0], tracks);
  });

  document.getElementById('mini-prev-btn')?.addEventListener('click', () => {
    stepAudioTrack(-1);
  });

  document.getElementById('mini-next-btn')?.addEventListener('click', () => {
    stepAudioTrack(1);
  });

  document.getElementById('mini-repeat-btn')?.addEventListener('click', () => {
    state.audioRepeatOne = !state.audioRepeatOne;
    const btn = document.getElementById('mini-repeat-btn');
    if (btn) {
      btn.textContent = state.audioRepeatOne ? '🔂 ซ้ำเพลงเดิม' : '🔁 เล่นต่อเนื่อง';
    }
  });

  document.getElementById('mini-close-btn')?.addEventListener('click', () => {
    const audioEl = document.getElementById('mini-audio-element');
    if (audioEl) {
      audioEl.pause();
      audioEl.src = '';
    }
    document.getElementById('mini-audio-player')?.classList.add('hidden');
  });

  document.getElementById('mini-audio-element')?.addEventListener('ended', () => {
    const audioEl = document.getElementById('mini-audio-element');
    if (state.audioRepeatOne && audioEl) {
      audioEl.currentTime = 0;
      audioEl.play().catch(() => {});
    } else {
      stepAudioTrack(1);
    }
  });

  // Phase 7: Cross-Device Clipboard & Snippet Hub
  document.getElementById('clipboard-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('clipboard-title-input').value.trim();
    const content = document.getElementById('clipboard-content-input').value;
    const isShared = document.getElementById('clipboard-shared-check')?.checked !== false;
    try {
      const res = await apiRequest('/api/clipboard', {
        method: 'POST',
        body: { title, content, isShared },
      });
      showToast(res.message, 'success');
      document.getElementById('clipboard-form').reset();
      loadClipboardView();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Phase 7: Smart Batch Rename Modal
  const batchRenameModal = document.getElementById('batch-rename-modal');
  document.getElementById('batch-rename-btn')?.addEventListener('click', () => {
    openBatchRenameModal(Array.from(state.selectedPaths));
  });
  document.getElementById('close-batch-rename-btn')?.addEventListener('click', () => {
    batchRenameModal?.classList.add('hidden');
  });
  document.getElementById('cancel-batch-rename-btn')?.addEventListener('click', () => {
    batchRenameModal?.classList.add('hidden');
  });
  document.getElementById('batch-rename-mode')?.addEventListener('change', (e) => {
    const mode = e.target.value;
    document.getElementById('batch-mode-pattern-box')?.classList.toggle('hidden', mode !== 'pattern');
    document.getElementById('batch-mode-prefix-box')?.classList.toggle('hidden', mode !== 'prefix_suffix');
    document.getElementById('batch-mode-replace-box')?.classList.toggle('hidden', mode !== 'replace');
    updateBatchRenamePreview();
  });
  [
    'batch-pattern-input',
    'batch-start-num',
    'batch-prefix-input',
    'batch-suffix-input',
    'batch-find-input',
    'batch-replace-input',
  ].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', updateBatchRenamePreview);
  });

  document.getElementById('batch-rename-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const paths = state.batchRenamePaths || [];
    if (paths.length === 0) return;

    const mode = document.getElementById('batch-rename-mode').value;
    const pattern = document.getElementById('batch-pattern-input').value;
    const startNumber = Number(document.getElementById('batch-start-num').value || 1);
    const prefix = document.getElementById('batch-prefix-input').value;
    const suffix = document.getElementById('batch-suffix-input').value;
    const findText = document.getElementById('batch-find-input').value;
    const replaceText = document.getElementById('batch-replace-input').value;

    try {
      const res = await apiRequest('/api/files/batch-rename', {
        method: 'POST',
        body: {
          paths,
          mode,
          pattern,
          startNumber,
          prefix,
          suffix,
          findText,
          replaceText,
        },
      });
      showToast(res.message, 'success');
      batchRenameModal?.classList.add('hidden');
      clearSelection();
      loadDirectory(state.currentPath);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Phase 7: File Checksum & Integrity Verifier Modal
  document.getElementById('close-checksum-btn')?.addEventListener('click', () => {
    document.getElementById('checksum-modal')?.classList.add('hidden');
  });
  document.getElementById('checksum-verify-input')?.addEventListener('input', verifyChecksumMatch);
  document.querySelectorAll('.btn-copy-hash').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.target;
      const val = document.getElementById(targetId)?.value;
      if (val) {
        navigator.clipboard?.writeText(val);
        showToast('คัดลอกค่าแฮชเรียบร้อยแล้ว!', 'success');
      }
    });
  });

  // Phase 7: Send to NAS User Inbox Modal
  const sendInboxModal = document.getElementById('send-inbox-modal');
  document.getElementById('batch-send-inbox-btn')?.addEventListener('click', () => {
    openSendInboxModal(Array.from(state.selectedPaths));
  });
  document.getElementById('close-send-inbox-btn')?.addEventListener('click', () => {
    sendInboxModal?.classList.add('hidden');
  });
  document.getElementById('cancel-send-inbox-btn')?.addEventListener('click', () => {
    sendInboxModal?.classList.add('hidden');
  });
  document.getElementById('send-inbox-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const paths = state.sendInboxPaths || [];
    const recipientUsername = document.getElementById('inbox-recipient-select').value;
    const message = document.getElementById('inbox-message-input').value.trim();
    try {
      const res = await apiRequest('/api/inbox/send', {
        method: 'POST',
        body: { paths, recipientUsername, message },
      });
      showToast(res.message, 'success');
      sendInboxModal?.classList.add('hidden');
      clearSelection();
      loadDirectory(state.currentPath);
      fetchSystemStats();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('save-text-btn').addEventListener('click', async () => {
    const textarea = document.getElementById('text-editor-textarea');
    if (!textarea || !state.editingFilePath) return;
    try {
      await apiRequest('/api/files/content', {
        method: 'PUT',
        body: { path: state.editingFilePath, content: textarea.value },
      });
      showToast('บันทึกไฟล์เรียบร้อยแล้ว', 'success');
      loadDirectory(state.currentPath);
      fetchSystemStats();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Empty Trash Button
  document.getElementById('empty-trash-btn').addEventListener('click', async () => {
    if (state.trashItems.length === 0) {
      showToast('ถังขยะว่างเปล่าอยู่แล้ว');
      return;
    }

    const confirmed = await openConfirmModal({
      title: '🔥 ยืนยันการล้างถังขยะทั้งหมด (Empty Trash)',
      icon: '🔥',
      heading: `ต้องการลบไฟล์ในถังขยะทั้งหมด ${state.trashItems.length} รายการออกถาวรใช่หรือไม่?`,
      description:
        'คำเตือนสำคัญ: การล้างถังขยะจะลบข้อมูลออกจากฮาร์ดดิสก์ทันที และไม่สามารถกู้คืนกลับมาได้อีก!',
      targetText: `จำนวนทั้งหมด: ${state.trashItems.length} รายการในถังขยะ`,
      confirmText: '🔥 ล้างถังขยะถาวรทันที',
    });
    if (!confirmed) return;

    try {
      const res = await apiRequest('/api/trash/empty', { method: 'DELETE' });
      showToast(`ล้างถังขยะแล้ว (${res.deletedCount} รายการ)`, 'success');
      loadTrashItems();
      fetchSystemStats();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Confirmation Modal Event Listeners
  document.getElementById('accept-confirm-modal-btn')?.addEventListener('click', () => {
    closeConfirmModal(true);
  });
  document.getElementById('cancel-confirm-modal-btn')?.addEventListener('click', () => {
    closeConfirmModal(false);
  });
  document.getElementById('close-confirm-modal-btn')?.addEventListener('click', () => {
    closeConfirmModal(false);
  });
  document.getElementById('confirm-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'confirm-modal') {
      closeConfirmModal(false);
    }
  });
  document.addEventListener('keydown', (e) => {
    const confirmOpen = !document.getElementById('confirm-modal')?.classList.contains('hidden');
    if (confirmOpen && e.key === 'Escape') {
      closeConfirmModal(false);
    }
  });

  // Change Password Modal
  const pwdModal = document.getElementById('password-modal');
  document.getElementById('change-password-btn').addEventListener('click', () => {
    document.getElementById('user-dropdown-menu')?.classList.add('hidden');
    document.getElementById('topbar-user-menu-wrap')?.classList.remove('open');
    document.getElementById('password-form').reset();
    pwdModal.classList.remove('hidden');
  });
  document.getElementById('close-password-btn').addEventListener('click', () => {
    pwdModal.classList.add('hidden');
  });
  document.getElementById('cancel-password-btn').addEventListener('click', () => {
    pwdModal.classList.add('hidden');
  });
  document.getElementById('password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const currentPassword = document.getElementById('current-password').value;
    const newPassword = document.getElementById('new-password').value;
    try {
      await apiRequest('/api/auth/password', {
        method: 'PUT',
        body: { currentPassword, newPassword },
      });
      showToast('เปลี่ยนรหัสผ่านสำเร็จ', 'success');
      pwdModal.classList.add('hidden');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // ================= PHASE 8 EVENT LISTENERS =================
  // 1. QR Code Modal
  document.getElementById('close-qr-modal-btn')?.addEventListener('click', () => {
    document.getElementById('qr-modal')?.classList.add('hidden');
  });
  document.getElementById('copy-qr-url-btn')?.addEventListener('click', () => {
    if (state.currentQrUrl) {
      navigator.clipboard?.writeText(state.currentQrUrl);
      showToast('คัดลอกลิงก์จาก QR Code แล้ว!', 'success');
    }
  });
  document.getElementById('qr-share-url-btn')?.addEventListener('click', () => {
    const url = document.getElementById('share-generated-url')?.value;
    if (url) openQrCodeModal(url, '📱 สแกนเพื่อดาวน์โหลดไฟล์จากลิงก์แชร์นี้');
  });
  document.getElementById('qr-file-drop-url-btn')?.addEventListener('click', () => {
    const url = document.getElementById('file-drop-generated-url')?.value;
    if (url) openQrCodeModal(url, '📱 สแกนเพื่อส่งไฟล์เข้าลิงก์รับฝากไฟล์นี้');
  });

  // 2. Full-Text Grep Search
  document.getElementById('grep-search-btn')?.addEventListener('click', runFullTextGrepSearch);
  document.getElementById('grep-search-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runFullTextGrepSearch();
    }
  });

  // 3. Image Studio Modal
  const imgStudioModal = document.getElementById('image-studio-modal');
  document.getElementById('close-image-studio-btn')?.addEventListener('click', () => {
    imgStudioModal?.classList.add('hidden');
  });
  document.getElementById('cancel-image-studio-btn')?.addEventListener('click', () => {
    imgStudioModal?.classList.add('hidden');
  });
  document.getElementById('image-studio-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const item = state.imageStudioItem;
    if (!item) return;

    const rotateDegrees = Number(document.getElementById('img-rotate-select').value || 0);
    const flip = document.getElementById('img-flip-select').value || 'none';
    const maxDimension = Number(document.getElementById('img-resize-select').value || 0);
    const targetFormat = document.getElementById('img-format-select').value || 'keep';
    const saveAsCopy = document.getElementById('img-save-copy-check').checked;

    try {
      showToast('⏳ กำลังประมวลผลรูปภาพบน NAS...', 'info');
      const res = await apiRequest('/api/files/image-studio', {
        method: 'POST',
        body: {
          path: item.path,
          rotateDegrees,
          flip,
          maxDimension,
          targetFormat,
          saveAsCopy,
        },
      });
      showToast(res.message, 'success');
      imgStudioModal?.classList.add('hidden');
      loadDirectory(state.currentPath);
      fetchSystemStats();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // 4. Kanban Board Form
  document.getElementById('kanban-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('kanban-title-input').value.trim();
    const priority = document.getElementById('kanban-priority-select').value;
    const linkedPath = document.getElementById('kanban-path-input').value.trim();
    const description = document.getElementById('kanban-desc-input').value.trim();

    try {
      const res = await apiRequest('/api/kanban', {
        method: 'POST',
        body: { title, priority, status: 'todo', linkedPath, description },
      });
      showToast(res.message, 'success');
      document.getElementById('kanban-form').reset();
      loadKanbanBoardView();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.getElementById('qr-modal')?.classList.add('hidden');
      closeFileContextMenu();
    }
  });

  // ================= PHASE 9 EVENT LISTENERS =================
  // Mobile Sidebar & Bottom Nav
  document.getElementById('mobile-menu-btn')?.addEventListener('click', () => {
    toggleMobileSidebar();
  });
  document.getElementById('sidebar-backdrop')?.addEventListener('click', () => {
    toggleMobileSidebar(false);
  });
  document.querySelectorAll('.mob-nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchTab(btn.dataset.mobTab);
    });
  });

  // Recent Files Strip Collapse/Expand
  document.getElementById('toggle-recent-strip-btn')?.addEventListener('click', () => {
    const strip = document.getElementById('recent-files-strip');
    const btn = document.getElementById('toggle-recent-strip-btn');
    if (!strip || !btn) return;
    const isHidden = strip.classList.toggle('hidden');
    btn.textContent = isHidden ? 'แสดง ▼' : 'ซ่อน ▲';
  });

  // File Inspector Drawer Close
  document.getElementById('close-inspector-btn')?.addEventListener('click', () => {
    document.getElementById('file-inspector-drawer')?.classList.add('hidden');
  });

  // Dismiss Right-Click Context Menu on outside click or scroll
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#file-context-menu')) {
      closeFileContextMenu();
    }
  });
  window.addEventListener('scroll', closeFileContextMenu, true);

  // Live Processes Refresh Button
  document.getElementById('refresh-processes-btn')?.addEventListener('click', () => {
    fetchTopProcessesTelemetry();
    showToast('อัปเดตรายการโปรเซสล่าสุดแล้ว', 'info');
  });
});

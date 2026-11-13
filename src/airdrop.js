const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream');
const { getUserRootPath, getFileMetadata, getUniqueUploadPath, assertQuotaAvailable } = require('./storage');
const { getLanAddresses } = require('./system');

const AIRDROP_TMP_DIR = path.join(__dirname, '..', 'data', 'airdrop_tmp');
const TRANSFER_TTL_MS = 15 * 60 * 1000; // 15 minutes temporary relay retention
const MAX_AIRDROP_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB per transfer

const peers = new Map(); // peerId -> { peerId, name, deviceType, osLabel, ip, res, connectedAt }
const transfers = new Map(); // transferId -> { id, kind, fromPeerId, fromName, toPeerId, filename, size, mimeType, tempPath, createdAt, expiresAt }

function ensureAirdropTmpDir() {
  if (!fs.existsSync(AIRDROP_TMP_DIR)) {
    fs.mkdirSync(AIRDROP_TMP_DIR, { recursive: true });
  }
}

// Clean up leftover temp files from previous runs
ensureAirdropTmpDir();
try {
  for (const entry of fs.readdirSync(AIRDROP_TMP_DIR)) {
    fs.unlinkSync(path.join(AIRDROP_TMP_DIR, entry));
  }
} catch {
  // Ignore startup cleanup error
}

// Periodic cleanup of expired relay files
setInterval(() => {
  const now = Date.now();
  for (const [id, item] of transfers.entries()) {
    if (now >= item.expiresAt) {
      if (item.tempPath && fs.existsSync(item.tempPath)) {
        try {
          fs.unlinkSync(item.tempPath);
        } catch {
          // Ignore
        }
      }
      transfers.delete(id);
    }
  }
}, 2 * 60 * 1000).unref();

function isValidPeerId(peerId) {
  return typeof peerId === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(peerId);
}

function sanitizeDisplayName(name, fallback = 'NAS Device') {
  const clean = String(name || '')
    .replace(/[\r\n\t\0<>]/g, ' ')
    .trim()
    .slice(0, 40);
  return clean || fallback;
}

function sanitizeFilename(rawName) {
  const base = path.basename(String(rawName || 'file')).replace(/[\r\n\0]/g, '_').trim();
  return base || `airdrop_${Date.now()}`;
}

function detectDeviceFromUA(ua = '') {
  const s = String(ua);
  if (/iPhone/i.test(s)) return { deviceType: 'mobile', osLabel: 'iPhone' };
  if (/iPad/i.test(s)) return { deviceType: 'tablet', osLabel: 'iPad' };
  if (/Android/i.test(s)) {
    return { deviceType: /Mobile/i.test(s) ? 'mobile' : 'tablet', osLabel: 'Android' };
  }
  if (/Macintosh|Mac OS X/i.test(s)) return { deviceType: 'desktop', osLabel: 'macOS' };
  if (/Windows/i.test(s)) return { deviceType: 'desktop', osLabel: 'Windows' };
  if (/Linux/i.test(s)) return { deviceType: 'desktop', osLabel: 'Linux' };
  return { deviceType: 'desktop', osLabel: 'Browser' };
}

function generateDefaultName(osLabel, peerId) {
  const codeNames = ['Nova', 'Orion', 'Pulse', 'Vega', 'Atlas', 'Comet', 'Lyra', 'Zephyr', 'Helios', 'Kestrel'];
  const hash = peerId.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return `${osLabel} • ${codeNames[hash % codeNames.length]}`;
}

function sendSseEvent(res, eventName, dataObj) {
  if (!res || res.writableEnded || res.destroyed) return false;
  try {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(dataObj)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function getPublicPeersList() {
  const list = [];
  for (const p of peers.values()) {
    list.push({
      peerId: p.peerId,
      name: p.name,
      deviceType: p.deviceType,
      osLabel: p.osLabel,
      ip: p.ip,
      connectedAt: p.connectedAt,
    });
  }
  return list;
}

function broadcastPeersList() {
  const list = getPublicPeersList();
  for (const [id, p] of peers.entries()) {
    const ok = sendSseEvent(p.res, 'peers', { peers: list });
    if (!ok) {
      peers.delete(id);
    }
  }
}

function handleAirdropEvents(req, res, urlObj, clientIp) {
  const peerId = urlObj.searchParams.get('peerId') || '';
  if (!isValidPeerId(peerId)) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'peerId ไม่ถูกต้อง' }));
    return;
  }

  const detected = detectDeviceFromUA(req.headers['user-agent'] || '');
  const reqName = urlObj.searchParams.get('name');
  const displayName = sanitizeDisplayName(reqName, generateDefaultName(detected.osLabel, peerId));

  // Close previous SSE stream if same peerId reconnects
  const prev = peers.get(peerId);
  if (prev && prev.res && !prev.res.writableEnded) {
    try {
      prev.res.end();
    } catch {
      // Ignore
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const peer = {
    peerId,
    name: displayName,
    deviceType: detected.deviceType,
    osLabel: detected.osLabel,
    ip: clientIp || 'LAN',
    res,
    connectedAt: Date.now(),
  };

  peers.set(peerId, peer);

  // Send initial welcome + current peers + LAN endpoints
  let lanUrls = [];
  try {
    const port = urlObj.port || (req.headers.host && req.headers.host.split(':')[1]) || '8080';
    lanUrls = getLanAddresses().map((l) => `http://${l.address}:${port}/airdrop`);
  } catch {
    lanUrls = [];
  }

  sendSseEvent(res, 'welcome', {
    self: {
      peerId: peer.peerId,
      name: peer.name,
      deviceType: peer.deviceType,
      osLabel: peer.osLabel,
      ip: peer.ip,
    },
    lanUrls,
  });

  broadcastPeersList();

  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(heartbeat);
      return;
    }
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const current = peers.get(peerId);
    if (current && current.res === res) {
      peers.delete(peerId);
      broadcastPeersList();
    }
  });
}

function handleRenamePeer(body) {
  const peerId = body?.peerId || '';
  if (!isValidPeerId(peerId)) {
    throw Object.assign(new Error('peerId ไม่ถูกต้อง'), { statusCode: 400 });
  }
  const peer = peers.get(peerId);
  if (!peer) {
    throw Object.assign(new Error('ไม่พบอุปกรณ์นี้ในเรดาร์'), { statusCode: 404 });
  }
  peer.name = sanitizeDisplayName(body.name, peer.name);
  broadcastPeersList();
  return { peerId: peer.peerId, name: peer.name };
}

function handleSendAirdropText(body) {
  const fromPeerId = body?.fromPeerId || '';
  const toPeerId = body?.toPeerId || '*';
  const text = String(body?.text || '').trim();

  if (!isValidPeerId(fromPeerId)) {
    throw Object.assign(new Error('fromPeerId ไม่ถูกต้อง'), { statusCode: 400 });
  }
  if (!text) {
    throw Object.assign(new Error('กรุณากรอกข้อความหรือลิงก์ที่ต้องการส่ง'), { statusCode: 400 });
  }
  if (text.length > 50000) {
    throw Object.assign(new Error('ข้อความยาวเกินกำหนด (สูงสุด 50,000 ตัวอักษร)'), { statusCode: 400 });
  }
  if (toPeerId !== '*' && !isValidPeerId(toPeerId)) {
    throw Object.assign(new Error('toPeerId ไม่ถูกต้อง'), { statusCode: 400 });
  }

  const sender = peers.get(fromPeerId);
  const fromName = sender ? sender.name : sanitizeDisplayName(body?.fromName, 'อุปกรณ์ในวง LAN');

  const payload = {
    transferId: crypto.randomUUID(),
    kind: 'text',
    fromPeerId,
    fromName,
    toPeerId,
    text,
    createdAt: Date.now(),
  };

  let deliveredCount = 0;
  if (toPeerId === '*') {
    for (const [id, p] of peers.entries()) {
      if (id !== fromPeerId && sendSseEvent(p.res, 'incoming-text', payload)) {
        deliveredCount += 1;
      }
    }
  } else {
    const target = peers.get(toPeerId);
    if (!target) {
      throw Object.assign(new Error('อุปกรณ์ปลายทางออฟไลน์หรือออกจากเรดาร์ไปแล้ว'), { statusCode: 404 });
    }
    if (sendSseEvent(target.res, 'incoming-text', payload)) {
      deliveredCount = 1;
    }
  }

  return { deliveredCount, transferId: payload.transferId };
}

function handleAirdropFileUpload(req, res, urlObj, sendJson) {
  const fromPeerId = urlObj.searchParams.get('fromPeerId') || '';
  const toPeerId = urlObj.searchParams.get('toPeerId') || '*';
  const rawFilename = urlObj.searchParams.get('filename') || '';

  if (!isValidPeerId(fromPeerId)) {
    req.resume();
    sendJson(res, 400, { error: 'fromPeerId ไม่ถูกต้อง' });
    return;
  }
  if (toPeerId !== '*' && !isValidPeerId(toPeerId)) {
    req.resume();
    sendJson(res, 400, { error: 'toPeerId ไม่ถูกต้อง' });
    return;
  }
  if (toPeerId !== '*' && !peers.has(toPeerId)) {
    req.resume();
    sendJson(res, 404, { error: 'อุปกรณ์ปลายทางออฟไลน์หรือออกจากเรดาร์ไปแล้ว' });
    return;
  }

  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > MAX_AIRDROP_FILE_BYTES) {
    req.resume();
    sendJson(res, 413, { error: 'ไฟล์มีขนาดใหญ่เกิน 2 GB สำหรับการส่งผ่าน LAN AirDrop' });
    return;
  }

  ensureAirdropTmpDir();
  const transferId = crypto.randomUUID();
  const filename = sanitizeFilename(rawFilename);
  const tempPath = path.join(AIRDROP_TMP_DIR, `${transferId}.bin`);
  const writeStream = fs.createWriteStream(tempPath);

  let receivedBytes = 0;
  req.on('data', (chunk) => {
    receivedBytes += chunk.length;
    if (receivedBytes > MAX_AIRDROP_FILE_BYTES) {
      req.destroy(new Error('ไฟล์มีขนาดใหญ่เกินกำหนด'));
    }
  });

  pipeline(req, writeStream, (err) => {
    if (err) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // Ignore
      }
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'ส่งไฟล์ไม่สำเร็จ: ' + err.message });
      }
      return;
    }

    try {
      const stat = fs.statSync(tempPath);
      const meta = getFileMetadata(filename, false);
      const sender = peers.get(fromPeerId);
      const fromName = sender ? sender.name : 'อุปกรณ์ในวง LAN';
      const now = Date.now();

      const record = {
        id: transferId,
        kind: 'file',
        fromPeerId,
        fromName,
        toPeerId,
        filename,
        size: stat.size,
        mimeType: meta.mimeType,
        category: meta.category,
        tempPath,
        createdAt: now,
        expiresAt: now + TRANSFER_TTL_MS,
      };

      transfers.set(transferId, record);

      const eventPayload = {
        transferId: record.id,
        kind: 'file',
        fromPeerId: record.fromPeerId,
        fromName: record.fromName,
        toPeerId: record.toPeerId,
        filename: record.filename,
        size: record.size,
        mimeType: record.mimeType,
        category: record.category,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
      };

      let deliveredCount = 0;
      if (toPeerId === '*') {
        for (const [id, p] of peers.entries()) {
          if (id !== fromPeerId && sendSseEvent(p.res, 'incoming-file', eventPayload)) {
            deliveredCount += 1;
          }
        }
      } else {
        const target = peers.get(toPeerId);
        if (target && sendSseEvent(target.res, 'incoming-file', eventPayload)) {
          deliveredCount = 1;
        }
      }

      sendJson(res, 201, {
        message: 'ส่งไฟล์ไปยังอุปกรณ์ปลายทางแล้ว!',
        transferId,
        deliveredCount,
        filename,
        size: stat.size,
      });
    } catch (postErr) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'เกิดข้อผิดพลาดหลังรับไฟล์: ' + postErr.message });
      }
    }
  });
}

function handleAirdropFileDownload(req, res, transferId, peerId, sendJson) {
  const record = transfers.get(transferId);
  if (!record || !fs.existsSync(record.tempPath)) {
    sendJson(res, 404, { error: 'ไฟล์นี้หมดอายุหรือถูกลบออกจากคิวแล้ว' });
    return;
  }
  if (record.toPeerId !== '*' && record.toPeerId !== peerId) {
    sendJson(res, 403, { error: 'ไม่มีสิทธิ์ดาวน์โหลดไฟล์ของเครื่องอื่น' });
    return;
  }

  const stat = fs.statSync(record.tempPath);
  const encodedName = encodeURIComponent(record.filename);
  res.writeHead(200, {
    'Content-Type': record.mimeType || 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodedName}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(record.tempPath).pipe(res);
}

function handleSaveAirdropToNas(user, transferId, peerId) {
  const record = transfers.get(transferId);
  if (!record || !fs.existsSync(record.tempPath)) {
    throw Object.assign(new Error('ไฟล์นี้หมดอายุหรือถูกลบออกจากคิวแล้ว'), { statusCode: 404 });
  }
  if (record.toPeerId !== '*' && record.toPeerId !== peerId) {
    throw Object.assign(new Error('ไม่มีสิทธิ์บันทึกไฟล์ของเครื่องอื่น'), { statusCode: 403 });
  }

  assertQuotaAvailable(user, record.size);

  const rootDir = getUserRootPath(user);
  const airDropDir = path.join(rootDir, 'AirDrop');
  if (!fs.existsSync(airDropDir)) {
    fs.mkdirSync(airDropDir, { recursive: true });
  }

  const { fullPath, finalName } = getUniqueUploadPath(airDropDir, record.filename);
  fs.copyFileSync(record.tempPath, fullPath);

  return {
    savedPath: `/AirDrop/${finalName}`,
    filename: finalName,
    size: record.size,
  };
}

function handleDeclineAirdrop(transferId, peerId) {
  const record = transfers.get(transferId);
  if (!record) return { removed: false };
  if (record.toPeerId !== '*' && record.toPeerId !== peerId) {
    throw Object.assign(new Error('ไม่มีสิทธิ์ปฏิเสธไฟล์ของเครื่องอื่น'), { statusCode: 403 });
  }
  if (record.toPeerId !== '*') {
    if (record.tempPath && fs.existsSync(record.tempPath)) {
      try {
        fs.unlinkSync(record.tempPath);
      } catch {
        // Ignore
      }
    }
    transfers.delete(transferId);
  }
  return { removed: true };
}

module.exports = {
  handleAirdropEvents,
  handleRenamePeer,
  handleSendAirdropText,
  handleAirdropFileUpload,
  handleAirdropFileDownload,
  handleSaveAirdropToNas,
  handleDeclineAirdrop,
};

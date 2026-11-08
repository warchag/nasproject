const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream');
const { getUserByUsername } = require('./db');
const { verifyPassword } = require('./auth');
const {
  getUserRootPath,
  assertQuotaAvailable,
  assertExtensionAllowed,
  resolveSafePath,
  getFileMetadata,
  moveToTrash,
} = require('./storage');

const WEBDAV_PREFIX = '/webdav';

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function authenticateBasicAuth(req) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Basic ')) {
    return null;
  }
  const decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8');
  const colonIdx = decoded.indexOf(':');
  if (colonIdx === -1) return null;

  const username = decoded.slice(0, colonIdx);
  const password = decoded.slice(colonIdx + 1);

  const user = getUserByUsername(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return null;
  }
  return user;
}

function requireBasicAuth(res) {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Personal NAS WebDAV Server", charset="UTF-8"',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end('Authentication Required');
}

function decodeWebdavClientPath(pathname) {
  let sub = pathname.slice(WEBDAV_PREFIX.length) || '/';
  if (!sub.startsWith('/')) sub = '/' + sub;
  try {
    return decodeURIComponent(sub);
  } catch {
    return sub;
  }
}

function buildPropResponseXml(hrefPath, stat, filename, isDir) {
  const { mimeType } = getFileMetadata(filename, isDir);
  const lastMod = (stat.mtime || new Date()).toUTCString();
  const creationDate = (stat.birthtime || new Date()).toISOString();
  const encodedHref = hrefPath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');

  return `
  <D:response>
    <D:href>${encodedHref}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${escapeXml(filename || 'Root')}</D:displayname>
        <D:creationdate>${creationDate}</D:creationdate>
        <D:getlastmodified>${lastMod}</D:getlastmodified>
        ${
          isDir
            ? '<D:resourcetype><D:collection/></D:resourcetype>'
            : `<D:resourcetype/>
               <D:getcontentlength>${stat.size}</D:getcontentlength>
               <D:getcontenttype>${escapeXml(mimeType)}</D:getcontenttype>`
        }
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
}

async function handleWebdavRequest(req, res, urlObj) {
  const method = req.method;

  // Allow OPTIONS preflight/discovery
  if (method === 'OPTIONS') {
    res.writeHead(200, {
      DAV: '1, 2',
      'MS-Author-Via': 'DAV',
      Allow: 'OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY, LOCK, UNLOCK',
      'Content-Length': '0',
    });
    res.end();
    return;
  }

  const user = authenticateBasicAuth(req);
  if (!user) {
    requireBasicAuth(res);
    return;
  }

  const rootDir = getUserRootPath(user);
  const clientPath = decodeWebdavClientPath(urlObj.pathname);
  const { fullPath, relativePath } = resolveSafePath(clientPath, rootDir);

  // PROPFIND (Directory / File Metadata Listing)
  if (method === 'PROPFIND') {
    if (!fs.existsSync(fullPath)) {
      res.writeHead(404);
      res.end();
      return;
    }

    const depth = req.headers['depth'] || '1';
    const stat = fs.statSync(fullPath);
    const isDir = stat.isDirectory();
    const baseHref =
      relativePath === '/'
        ? `${WEBDAV_PREFIX}/`
        : `${WEBDAV_PREFIX}${relativePath}${isDir ? '/' : ''}`;

    const responses = [
      buildPropResponseXml(
        baseHref,
        stat,
        relativePath === '/' ? 'NAS' : path.basename(fullPath),
        isDir
      ),
    ];

    if (isDir && depth !== '0') {
      const entries = fs.readdirSync(fullPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '.DS_Store' || entry.name === '.gitkeep') continue;
        const childFull = path.join(fullPath, entry.name);
        try {
          const childStat = fs.statSync(childFull);
          const childIsDir = entry.isDirectory();
          const childHref = `${baseHref.replace(/\/$/, '')}/${entry.name}${
            childIsDir ? '/' : ''
          }`;
          responses.push(
            buildPropResponseXml(childHref, childStat, entry.name, childIsDir)
          );
        } catch {
          // Ignore inaccessible files
        }
      }
    }

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">${responses.join('')}
</D:multistatus>`;

    const xmlBuf = Buffer.from(xml, 'utf8');
    res.writeHead(207, {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Length': xmlBuf.length,
    });
    res.end(xmlBuf);
    return;
  }

  // GET / HEAD (Read file)
  if (method === 'GET' || method === 'HEAD') {
    if (!fs.existsSync(fullPath)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(method === 'HEAD' ? '' : 'Personal NAS WebDAV Directory');
      return;
    }

    const { mimeType } = getFileMetadata(path.basename(fullPath), false);
    res.writeHead(200, {
      'Content-Type': mimeType,
      'Content-Length': stat.size,
      'Last-Modified': stat.mtime.toUTCString(),
      'Accept-Ranges': 'bytes',
    });
    if (method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(fullPath).pipe(res);
    return;
  }

  // PUT (Upload / Overwrite file via WebDAV)
  if (method === 'PUT') {
    const filename = path.basename(fullPath);
    // Ignore macOS resource fork metadata files or allow them cleanly
    if (!filename.startsWith('._')) {
      assertExtensionAllowed(filename);
    }
    const contentLen = Number(req.headers['content-length'] || 0);
    assertQuotaAvailable(user, contentLen);

    const parentDir = path.dirname(fullPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    const existed = fs.existsSync(fullPath);
    const writeStream = fs.createWriteStream(fullPath);
    pipeline(req, writeStream, (err) => {
      if (err) {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end();
        }
        return;
      }
      res.writeHead(existed ? 204 : 201);
      res.end();
    });
    return;
  }

  // MKCOL (Create Folder)
  if (method === 'MKCOL') {
    if (fs.existsSync(fullPath)) {
      res.writeHead(405);
      res.end();
      return;
    }
    fs.mkdirSync(fullPath, { recursive: false });
    res.writeHead(201);
    res.end();
    return;
  }

  // DELETE (Move to NAS Trash or delete AppleDouble metadata)
  if (method === 'DELETE') {
    if (!fs.existsSync(fullPath)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const base = path.basename(fullPath);
    if (base.startsWith('._') || base === '.DS_Store') {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } else {
      moveToTrash(relativePath, user);
    }
    res.writeHead(204);
    res.end();
    return;
  }

  // MOVE / COPY
  if (method === 'MOVE' || method === 'COPY') {
    if (!fs.existsSync(fullPath)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const destHeader = req.headers['destination'] || '';
    if (!destHeader) {
      res.writeHead(400);
      res.end();
      return;
    }
    const destUrl = new URL(destHeader, `http://${req.headers.host || 'localhost'}`);
    const destClientPath = decodeWebdavClientPath(destUrl.pathname);
    const { fullPath: destFull } = resolveSafePath(destClientPath, rootDir);
    const destExisted = fs.existsSync(destFull);

    if (method === 'MOVE') {
      fs.renameSync(fullPath, destFull);
    } else {
      const stat = fs.statSync(fullPath);
      assertQuotaAvailable(user, stat.isDirectory() ? 0 : stat.size);
      fs.cpSync(fullPath, destFull, { recursive: true });
    }

    res.writeHead(destExisted ? 204 : 201);
    res.end();
    return;
  }

  // LOCK / UNLOCK (Required for macOS Finder & Windows Explorer Read-Write Mounting)
  if (method === 'LOCK') {
    const token = `opaquelocktoken:${crypto.randomUUID()}`;
    const lockXml = `<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:">
  <D:lockdiscovery>
    <D:activelock>
      <D:locktype><D:write/></D:locktype>
      <D:lockscope><D:exclusive/></D:lockscope>
      <D:depth>infinity</D:depth>
      <D:owner><D:href>${escapeXml(user.username)}</D:href></D:owner>
      <D:timeout>Second-3600</D:timeout>
      <D:locktoken><D:href>${token}</D:href></D:locktoken>
    </D:activelock>
  </D:lockdiscovery>
</D:prop>`;
    res.writeHead(200, {
      'Content-Type': 'application/xml; charset=utf-8',
      'Lock-Token': `<${token}>`,
    });
    res.end(lockXml);
    return;
  }

  if (method === 'UNLOCK') {
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(405);
  res.end();
}

module.exports = {
  WEBDAV_PREFIX,
  handleWebdavRequest,
};


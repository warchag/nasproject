const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { hashPassword } = require('./auth');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'nas.db');
const db = new DatabaseSync(DB_PATH);

// Initialize schema
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    quota_bytes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS trash_items (
    id TEXT PRIMARY KEY,
    original_path TEXT NOT NULL,
    original_name TEXT NOT NULL,
    trash_filename TEXT NOT NULL,
    is_directory INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    deleted_by TEXT NOT NULL,
    deleted_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS upload_sessions (
    id TEXT PRIMARY KEY,
    fingerprint TEXT UNIQUE NOT NULL,
    target_dir TEXT NOT NULL,
    filename TEXT NOT NULL,
    total_size INTEGER NOT NULL,
    uploaded_bytes INTEGER NOT NULL DEFAULT 0,
    chunk_size INTEGER NOT NULL,
    temp_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS share_links (
    id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL,
    owner_username TEXT NOT NULL,
    storage_rel_path TEXT NOT NULL,
    item_name TEXT NOT NULL,
    is_directory INTEGER NOT NULL DEFAULT 0,
    password_hash TEXT,
    expires_at TEXT,
    max_downloads INTEGER NOT NULL DEFAULT 0,
    download_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    action TEXT NOT NULL,
    target_path TEXT,
    details TEXT,
    ip_address TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS favorites (
    user_id INTEGER NOT NULL,
    rel_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, rel_path)
  );

  CREATE TABLE IF NOT EXISTS file_versions (
    id TEXT PRIMARY KEY,
    scope_root TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    version_filename TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    saved_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS file_requests (
    id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL,
    owner_username TEXT NOT NULL,
    storage_rel_path TEXT NOT NULL,
    folder_name TEXT NOT NULL,
    title TEXT NOT NULL,
    password_hash TEXT,
    expires_at TEXT,
    upload_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS file_tags (
    user_id INTEGER NOT NULL,
    rel_path TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT 'none',
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, rel_path)
  );

  CREATE TABLE IF NOT EXISTS clipboard_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id INTEGER NOT NULL,
    author_username TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    is_shared INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kanban_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id INTEGER NOT NULL,
    author_username TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'normal',
    linked_path TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

// Safe migration: add quota_bytes column to users if upgrading from Phase 1/2
const userColumns = db.prepare('PRAGMA table_info(users)').all();
if (!userColumns.some((col) => col.name === 'quota_bytes')) {
  db.exec('ALTER TABLE users ADD COLUMN quota_bytes INTEGER NOT NULL DEFAULT 0');
}

// Clean up any stale upload_sessions whose temp_path no longer exists (e.g. after moving project to another machine)
try {
  const allSessions = db.prepare('SELECT id, temp_path FROM upload_sessions').all();
  const delStmt = db.prepare('DELETE FROM upload_sessions WHERE id = ?');
  for (const s of allSessions) {
    if (!s.temp_path || !fs.existsSync(s.temp_path)) {
      delStmt.run(s.id);
    }
  }
} catch {
  // Ignore startup session cleanup errors
}

// Seed default admin account if no users exist
const countRow = db.prepare('SELECT COUNT(*) AS count FROM users').get();
if (countRow.count === 0) {
  const defaultHash = hashPassword('admin123');
  db.prepare(
    'INSERT INTO users (username, password_hash, role, quota_bytes, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run('admin', defaultHash, 'admin', 0, new Date().toISOString());
}

// Seed default upload extension policy (NAS standard: allow_all by default)
const defaultPolicyRow = db
  .prepare('SELECT value FROM system_settings WHERE key = ?')
  .get('upload_extension_policy');
if (!defaultPolicyRow) {
  db.prepare(
    'INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)'
  ).run(
    'upload_extension_policy',
    JSON.stringify({
      mode: 'allow_all', // 'allow_all' | 'blocklist' | 'allowlist'
      extensions: ['.exe', '.bat', '.cmd', '.scr', '.vbs'],
    }),
    new Date().toISOString()
  );
}

function getSystemSetting(key, defaultValue = null) {
  const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

function setSystemSetting(key, value) {
  if (value === null || value === undefined) {
    db.prepare('DELETE FROM system_settings WHERE key = ?').run(key);
    return null;
  }
  const strVal = String(value);
  db.prepare(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, strVal, new Date().toISOString());
  return strVal;
}

function getUploadExtensionPolicy() {
  const row = db
    .prepare('SELECT value FROM system_settings WHERE key = ?')
    .get('upload_extension_policy');
  if (!row) {
    return { mode: 'allow_all', extensions: [] };
  }
  try {
    return JSON.parse(row.value);
  } catch {
    return { mode: 'allow_all', extensions: [] };
  }
}

function setUploadExtensionPolicy({ mode = 'allow_all', extensions = [] }) {
  const validMode = ['allow_all', 'blocklist', 'allowlist'].includes(mode)
    ? mode
    : 'allow_all';
  const cleanExts = Array.from(
    new Set(
      (Array.isArray(extensions) ? extensions : String(extensions).split(','))
        .map((e) => String(e).trim().toLowerCase())
        .filter(Boolean)
        .map((e) => (e.startsWith('.') ? e : `.${e}`))
    )
  );
  const policy = { mode: validMode, extensions: cleanExts };
  db.prepare(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES ('upload_extension_policy', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(JSON.stringify(policy), new Date().toISOString());
  return policy;
}

// ================= USERS CRUD (PHASE 3) =================
function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function getUserById(id) {
  return db
    .prepare('SELECT id, username, role, quota_bytes, created_at FROM users WHERE id = ?')
    .get(id);
}

function listAllUsers() {
  return db
    .prepare('SELECT id, username, role, quota_bytes, created_at FROM users ORDER BY id ASC')
    .all();
}

function createUser({ username, passwordHash, role = 'user', quotaBytes = 0 }) {
  const now = new Date().toISOString();
  const res = db
    .prepare(
      'INSERT INTO users (username, password_hash, role, quota_bytes, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(username, passwordHash, role, Number(quotaBytes || 0), now);
  return getUserById(res.lastInsertRowid);
}

function updateUserByAdmin(id, { role, quotaBytes, passwordHash }) {
  if (passwordHash) {
    db.prepare(
      'UPDATE users SET role = ?, quota_bytes = ?, password_hash = ? WHERE id = ?'
    ).run(role, Number(quotaBytes || 0), passwordHash, id);
  } else {
    db.prepare('UPDATE users SET role = ?, quota_bytes = ? WHERE id = ?').run(
      role,
      Number(quotaBytes || 0),
      id
    );
  }
  return getUserById(id);
}

function deleteUserById(id) {
  db.prepare('DELETE FROM share_links WHERE owner_id = ?').run(id);
  return db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

function updateUserPassword(userId, newPasswordHash) {
  return db
    .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(newPasswordHash, userId);
}

// ================= TRASH ITEMS =================
function insertTrashItem(item) {
  db.prepare(
    `INSERT INTO trash_items (id, original_path, original_name, trash_filename, is_directory, size, deleted_by, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    item.id,
    item.original_path,
    item.original_name,
    item.trash_filename,
    item.is_directory ? 1 : 0,
    item.size || 0,
    item.deleted_by || 'admin',
    item.deleted_at || new Date().toISOString()
  );
}

function listTrashItems(usernameFilter = null) {
  const rows = usernameFilter
    ? db
        .prepare('SELECT * FROM trash_items WHERE deleted_by = ? ORDER BY deleted_at DESC')
        .all(usernameFilter)
    : db.prepare('SELECT * FROM trash_items ORDER BY deleted_at DESC').all();

  return rows.map((row) => ({
    ...row,
    is_directory: Boolean(row.is_directory),
  }));
}

function getTrashItemById(id) {
  const row = db.prepare('SELECT * FROM trash_items WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    is_directory: Boolean(row.is_directory),
  };
}

function deleteTrashItemRecord(id) {
  return db.prepare('DELETE FROM trash_items WHERE id = ?').run(id);
}

function clearAllTrashRecords(usernameFilter = null) {
  if (usernameFilter) {
    return db.prepare('DELETE FROM trash_items WHERE deleted_by = ?').run(usernameFilter);
  }
  return db.prepare('DELETE FROM trash_items').run();
}

// ================= UPLOAD SESSIONS (PHASE 2) =================
function getUploadSessionByFingerprint(fingerprint) {
  return db
    .prepare('SELECT * FROM upload_sessions WHERE fingerprint = ?')
    .get(fingerprint);
}

function getUploadSessionById(id) {
  return db.prepare('SELECT * FROM upload_sessions WHERE id = ?').get(id);
}

function createUploadSession(session) {
  db.prepare(
    `INSERT INTO upload_sessions (id, fingerprint, target_dir, filename, total_size, uploaded_bytes, chunk_size, temp_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.id,
    session.fingerprint,
    session.target_dir,
    session.filename,
    session.total_size,
    session.uploaded_bytes || 0,
    session.chunk_size,
    session.temp_path,
    session.created_at,
    session.updated_at
  );
}

function updateUploadSessionProgress(id, uploadedBytes) {
  return db
    .prepare('UPDATE upload_sessions SET uploaded_bytes = ?, updated_at = ? WHERE id = ?')
    .run(uploadedBytes, new Date().toISOString(), id);
}

function deleteUploadSession(id) {
  return db.prepare('DELETE FROM upload_sessions WHERE id = ?').run(id);
}

// ================= SHARE LINKS (PHASE 3) =================
function createShareLinkRecord(link) {
  db.prepare(
    `INSERT INTO share_links (
      id, owner_id, owner_username, storage_rel_path, item_name,
      is_directory, password_hash, expires_at, max_downloads, download_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    link.id,
    link.owner_id,
    link.owner_username,
    link.storage_rel_path,
    link.item_name,
    link.is_directory ? 1 : 0,
    link.password_hash || null,
    link.expires_at || null,
    Number(link.max_downloads || 0),
    link.created_at || new Date().toISOString()
  );
  return getShareLinkById(link.id);
}

function getShareLinkById(id) {
  const row = db.prepare('SELECT * FROM share_links WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    is_directory: Boolean(row.is_directory),
    has_password: Boolean(row.password_hash),
  };
}

function listShareLinks(ownerIdFilter = null) {
  const rows = ownerIdFilter
    ? db
        .prepare('SELECT * FROM share_links WHERE owner_id = ? ORDER BY created_at DESC')
        .all(ownerIdFilter)
    : db.prepare('SELECT * FROM share_links ORDER BY created_at DESC').all();

  return rows.map((row) => ({
    id: row.id,
    owner_id: row.owner_id,
    owner_username: row.owner_username,
    storage_rel_path: row.storage_rel_path,
    item_name: row.item_name,
    is_directory: Boolean(row.is_directory),
    has_password: Boolean(row.password_hash),
    expires_at: row.expires_at,
    max_downloads: row.max_downloads,
    download_count: row.download_count,
    created_at: row.created_at,
  }));
}

function incrementShareDownloadCount(id) {
  return db
    .prepare('UPDATE share_links SET download_count = download_count + 1 WHERE id = ?')
    .run(id);
}

function deleteShareLinkById(id) {
  return db.prepare('DELETE FROM share_links WHERE id = ?').run(id);
}

// ================= PHASE 5: AUDIT LOGS =================
function insertAuditLog({ username, action, target_path = '', details = '', ip_address = '' }) {
  db.prepare(
    `INSERT INTO audit_logs (username, action, target_path, details, ip_address, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    String(username || 'anonymous'),
    String(action || 'EVENT'),
    String(target_path || ''),
    String(details || ''),
    String(ip_address || ''),
    new Date().toISOString()
  );
}

function listAuditLogs(limit = 200) {
  return db
    .prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?')
    .all(Math.max(1, Math.min(1000, Number(limit || 200))));
}

function clearAuditLogs() {
  return db.prepare('DELETE FROM audit_logs').run();
}

// ================= PHASE 5: FAVORITES (STARRED FILES) =================
function toggleFavorite(userId, relPath) {
  const uid = Number(userId || 0);
  const existing = db
    .prepare('SELECT 1 FROM favorites WHERE user_id = ? AND rel_path = ?')
    .get(uid, relPath);
  if (existing) {
    db.prepare('DELETE FROM favorites WHERE user_id = ? AND rel_path = ?').run(uid, relPath);
    return { starred: false, path: relPath };
  }
  db.prepare(
    'INSERT INTO favorites (user_id, rel_path, created_at) VALUES (?, ?, ?)'
  ).run(uid, relPath, new Date().toISOString());
  return { starred: true, path: relPath };
}

function listFavoriteRecords(userId) {
  return db
    .prepare('SELECT rel_path, created_at FROM favorites WHERE user_id = ? ORDER BY created_at DESC')
    .all(Number(userId || 0));
}

function getFavoritePathsSet(userId) {
  const rows = listFavoriteRecords(userId);
  return new Set(rows.map((r) => r.rel_path));
}

function removeFavoriteRecord(userId, relPath) {
  return db
    .prepare('DELETE FROM favorites WHERE user_id = ? AND rel_path = ?')
    .run(Number(userId || 0), relPath);
}

// ================= PHASE 5: FILE VERSIONS =================
function insertFileVersion(ver) {
  db.prepare(
    `INSERT INTO file_versions (id, scope_root, rel_path, version_filename, size, saved_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ver.id,
    ver.scope_root,
    ver.rel_path,
    ver.version_filename,
    Number(ver.size || 0),
    ver.saved_by || 'admin',
    ver.created_at || new Date().toISOString()
  );
}

function listFileVersions(scopeRoot, relPath) {
  return db
    .prepare(
      'SELECT * FROM file_versions WHERE scope_root = ? AND rel_path = ? ORDER BY created_at DESC'
    )
    .all(scopeRoot, relPath);
}

function getFileVersionById(id) {
  return db.prepare('SELECT * FROM file_versions WHERE id = ?').get(id);
}

function deleteFileVersionRecord(id) {
  return db.prepare('DELETE FROM file_versions WHERE id = ?').run(id);
}

// ================= PHASE 6: FILE DROP REQUEST LINKS =================
function createFileRequestRecord(reqRec) {
  db.prepare(
    `INSERT INTO file_requests (
      id, owner_id, owner_username, storage_rel_path, folder_name,
      title, password_hash, expires_at, upload_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    reqRec.id,
    reqRec.owner_id,
    reqRec.owner_username,
    reqRec.storage_rel_path,
    reqRec.folder_name,
    reqRec.title || `ส่งไฟล์เข้าโฟลเดอร์ ${reqRec.folder_name}`,
    reqRec.password_hash || null,
    reqRec.expires_at || null,
    reqRec.created_at || new Date().toISOString()
  );
  return getFileRequestById(reqRec.id);
}

function getFileRequestById(id) {
  const row = db.prepare('SELECT * FROM file_requests WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    has_password: Boolean(row.password_hash),
  };
}

function listFileRequests(ownerIdFilter = null) {
  const rows = ownerIdFilter
    ? db
        .prepare('SELECT * FROM file_requests WHERE owner_id = ? ORDER BY created_at DESC')
        .all(ownerIdFilter)
    : db.prepare('SELECT * FROM file_requests ORDER BY created_at DESC').all();

  return rows.map((r) => ({
    id: r.id,
    owner_id: r.owner_id,
    owner_username: r.owner_username,
    storage_rel_path: r.storage_rel_path,
    folder_name: r.folder_name,
    title: r.title,
    has_password: Boolean(r.password_hash),
    expires_at: r.expires_at,
    upload_count: r.upload_count,
    created_at: r.created_at,
  }));
}

function incrementFileRequestUploadCount(id) {
  return db
    .prepare('UPDATE file_requests SET upload_count = upload_count + 1 WHERE id = ?')
    .run(id);
}

function deleteFileRequestById(id) {
  return db.prepare('DELETE FROM file_requests WHERE id = ?').run(id);
}

// ================= PHASE 6: COLOR TAGS & FILE NOTES =================
function upsertFileTag(userId, relPath, color = 'none', note = '') {
  const uid = Number(userId || 0);
  const cleanColor = String(color || 'none').trim().toLowerCase();
  const cleanNote = String(note || '').trim();

  if (cleanColor === 'none' && !cleanNote) {
    db.prepare('DELETE FROM file_tags WHERE user_id = ? AND rel_path = ?').run(uid, relPath);
    return { rel_path: relPath, color: 'none', note: '' };
  }

  db.prepare(
    `INSERT INTO file_tags (user_id, rel_path, color, note, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, rel_path) DO UPDATE SET
       color = excluded.color,
       note = excluded.note,
       updated_at = excluded.updated_at`
  ).run(uid, relPath, cleanColor, cleanNote, new Date().toISOString());

  return { rel_path: relPath, color: cleanColor, note: cleanNote };
}

function getFileTagsMap(userId) {
  const rows = db
    .prepare('SELECT rel_path, color, note FROM file_tags WHERE user_id = ?')
    .all(Number(userId || 0));
  const map = new Map();
  for (const r of rows) {
    map.set(r.rel_path, { color: r.color, note: r.note });
  }
  return map;
}

// ================= PHASE 7: CROSS-DEVICE CLIPBOARD & SNIPPET HUB =================
function insertClipboardItem({ author_id, author_username, title = '', content = '', is_shared = true }) {
  const now = new Date().toISOString();
  const res = db
    .prepare(
      `INSERT INTO clipboard_items (author_id, author_username, title, content, is_shared, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      Number.isFinite(Number(author_id)) ? Number(author_id) : 0,
      String(author_username || 'admin'),
      String(title || '').trim() || 'ข้อความด่วน (Snippet)',
      String(content || ''),
      is_shared ? 1 : 0,
      now
    );
  return db.prepare('SELECT * FROM clipboard_items WHERE id = ?').get(res.lastInsertRowid);
}

function listClipboardItems(user) {
  const uid = Number(user?.id || 0);
  const isAdmin = user?.role === 'admin';
  const rows = isAdmin
    ? db.prepare('SELECT * FROM clipboard_items ORDER BY id DESC LIMIT 100').all()
    : db
        .prepare(
          'SELECT * FROM clipboard_items WHERE is_shared = 1 OR author_id = ? ORDER BY id DESC LIMIT 100'
        )
        .all(uid);

  return rows.map((r) => ({
    ...r,
    is_shared: Boolean(r.is_shared),
  }));
}

function deleteClipboardItemById(id, user) {
  const row = db.prepare('SELECT * FROM clipboard_items WHERE id = ?').get(Number(id || 0));
  if (!row) return false;
  if (user?.role !== 'admin' && row.author_id !== user?.id) {
    const err = new Error('คุณไม่มีสิทธิ์ลบข้อความของผู้อื่น');
    err.statusCode = 403;
    throw err;
  }
  db.prepare('DELETE FROM clipboard_items WHERE id = ?').run(Number(id || 0));
  return true;
}

// ================= PHASE 8: KANBAN TASK & PROJECT BOARD =================
function insertKanbanTask({
  author_id,
  author_username,
  title = '',
  description = '',
  status = 'todo',
  priority = 'normal',
  linked_path = '',
}) {
  const now = new Date().toISOString();
  const validStatus = ['todo', 'doing', 'done'].includes(status) ? status : 'todo';
  const validPriority = ['low', 'normal', 'high'].includes(priority) ? priority : 'normal';
  const res = db
    .prepare(
      `INSERT INTO kanban_tasks (
        author_id, author_username, title, description, status, priority, linked_path, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      Number.isFinite(Number(author_id)) ? Number(author_id) : 0,
      String(author_username || 'admin'),
      String(title || '').trim(),
      String(description || '').trim(),
      validStatus,
      validPriority,
      String(linked_path || '').trim(),
      now,
      now
    );
  return db.prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(res.lastInsertRowid);
}

function listKanbanTasks() {
  return db.prepare('SELECT * FROM kanban_tasks ORDER BY id DESC LIMIT 200').all();
}

function updateKanbanTask(id, patch = {}) {
  const existing = db.prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(Number(id || 0));
  if (!existing) return null;

  const normalizedPatchStatus = patch.status === 'in_progress' ? 'doing' : patch.status;
  const nextStatus = ['todo', 'doing', 'done'].includes(normalizedPatchStatus)
    ? normalizedPatchStatus
    : existing.status;
  const nextPriority = ['low', 'normal', 'high'].includes(patch.priority)
    ? patch.priority
    : existing.priority;
  const nextTitle =
    typeof patch.title === 'string' && patch.title.trim() ? patch.title.trim() : existing.title;
  const nextDesc =
    typeof patch.description === 'string' ? patch.description.trim() : existing.description;
  const nextPath =
    typeof patch.linked_path === 'string' ? patch.linked_path.trim() : existing.linked_path;

  db.prepare(
    `UPDATE kanban_tasks
     SET title = ?, description = ?, status = ?, priority = ?, linked_path = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    nextTitle,
    nextDesc,
    nextStatus,
    nextPriority,
    nextPath,
    new Date().toISOString(),
    existing.id
  );
  return db.prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(existing.id);
}

function deleteKanbanTaskById(id) {
  db.prepare('DELETE FROM kanban_tasks WHERE id = ?').run(Number(id || 0));
  return true;
}

module.exports = {
  db,
  getSystemSetting,
  setSystemSetting,
  getUploadExtensionPolicy,
  setUploadExtensionPolicy,
  getUserByUsername,
  getUserById,
  listAllUsers,
  createUser,
  updateUserByAdmin,
  deleteUserById,
  updateUserPassword,
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
  createShareLinkRecord,
  getShareLinkById,
  listShareLinks,
  incrementShareDownloadCount,
  deleteShareLinkById,
  insertAuditLog,
  listAuditLogs,
  clearAuditLogs,
  toggleFavorite,
  listFavoriteRecords,
  getFavoritePathsSet,
  removeFavoriteRecord,
  insertFileVersion,
  listFileVersions,
  getFileVersionById,
  deleteFileVersionRecord,
  createFileRequestRecord,
  getFileRequestById,
  listFileRequests,
  incrementFileRequestUploadCount,
  deleteFileRequestById,
  upsertFileTag,
  getFileTagsMap,
  insertClipboardItem,
  listClipboardItems,
  deleteClipboardItemById,
  insertKanbanTask,
  listKanbanTasks,
  updateKanbanTask,
  deleteKanbanTaskById,
};

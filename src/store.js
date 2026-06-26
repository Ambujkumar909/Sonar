// =============================================================
//  Lumen — persistence layer (SQLite via better-sqlite3)
//  Stores sessions, chats, contacts, groups, messages, events.
//  Synchronous + fast. WAL mode for concurrent reads.
// =============================================================
const fs = require('fs')
const Database = require('better-sqlite3')
const { DATA_DIR, DB_FILE } = require('./config')

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

const db = new Database(DB_FILE)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  status        TEXT DEFAULT 'idle',
  phone         TEXT,
  platform      TEXT,
  pushname      TEXT,
  watch_all     INTEGER DEFAULT 1,
  created_at    INTEGER,
  last_open     INTEGER,
  last_close    INTEGER,
  reconnects    INTEGER DEFAULT 0,
  note          TEXT,
  owner_user_id INTEGER
);

CREATE TABLE IF NOT EXISTS chats (
  session_id    TEXT,
  jid           TEXT,
  name          TEXT,
  is_group      INTEGER DEFAULT 0,
  last_ts       INTEGER DEFAULT 0,
  last_text     TEXT,
  last_sender   TEXT,
  unread        INTEGER DEFAULT 0,
  msg_count     INTEGER DEFAULT 0,
  pinned        INTEGER DEFAULT 0,
  archived      INTEGER DEFAULT 0,
  watch_key     TEXT,
  PRIMARY KEY (session_id, jid)
);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_id        TEXT,
  session_id    TEXT,
  chat_jid      TEXT,
  chat_name     TEXT,
  is_group      INTEGER DEFAULT 0,
  sender_jid    TEXT,
  sender_name   TEXT,
  from_me       INTEGER DEFAULT 0,
  type          TEXT,
  text          TEXT,
  has_media     INTEGER DEFAULT 0,
  quoted_text   TEXT,
  ts            INTEGER,
  created_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_msg_chat ON messages(session_id, chat_jid, ts);
CREATE INDEX IF NOT EXISTS idx_msg_ts   ON messages(ts);
CREATE INDEX IF NOT EXISTS idx_msg_text ON messages(text);
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_unique ON messages(session_id, chat_jid, msg_id);

CREATE TABLE IF NOT EXISTS contacts (
  session_id    TEXT,
  jid           TEXT,
  name          TEXT,
  notify        TEXT,
  is_business   INTEGER DEFAULT 0,
  PRIMARY KEY (session_id, jid)
);

CREATE TABLE IF NOT EXISTS groups (
  session_id    TEXT,
  jid           TEXT,
  subject       TEXT,
  description   TEXT,
  owner         TEXT,
  participants  INTEGER DEFAULT 0,
  created_at    INTEGER,
  PRIMARY KEY (session_id, jid)
);

CREATE TABLE IF NOT EXISTS watchlist (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT,
  kind          TEXT,        -- 'group' | 'number'
  value         TEXT,        -- group subject / phone number
  label         TEXT,
  created_at    INTEGER
);

CREATE TABLE IF NOT EXISTS keywords (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  word          TEXT,
  created_at    INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT,
  level         TEXT,        -- info | warn | error | success
  code          TEXT,
  message       TEXT,
  ts            INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

-- ===== security: users, auth sessions, audit trail =====
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  pass_hash     TEXT NOT NULL,
  salt          TEXT NOT NULL,
  role          TEXT DEFAULT 'admin',   -- admin | viewer
  created_at    INTEGER,
  last_login    INTEGER
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token         TEXT PRIMARY KEY,
  user_id       INTEGER,
  username      TEXT,
  ip            TEXT,
  ua            TEXT,
  login_at      INTEGER,
  last_seen     INTEGER,
  logout_at     INTEGER
);

CREATE TABLE IF NOT EXISTS audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER,
  username      TEXT,
  action        TEXT,
  target        TEXT,
  detail        TEXT,
  ip            TEXT,
  ts            INTEGER
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
`)

// ---- migrations (MUST run before prepared statements below) ----------------
db.exec(`CREATE TABLE IF NOT EXISTS watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, kind TEXT,
  value TEXT, label TEXT, created_at INTEGER)`)
db.exec(`CREATE TABLE IF NOT EXISTS session_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER, session_id TEXT, granted_by TEXT, created_at INTEGER,
  UNIQUE(user_id, session_id))`)
// remembers @lid <-> phone associations so BOTH directions of a 1:1 chat match
db.exec(`CREATE TABLE IF NOT EXISTS lidmap (
  session_id TEXT, lid TEXT, phone TEXT, PRIMARY KEY(session_id, lid))`)

function ensureColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`)
}
ensureColumn('sessions', 'owner_user_id', 'INTEGER')
ensureColumn('chats', 'watch_key', 'TEXT')

// One-time data migration: drop empty history-imported chats (no messages);
// backfill a watch_key for real captured chats so they stay visible.
;(function migrateChats() {
  const nulls = db.prepare(`SELECT session_id, jid, name, is_group FROM chats WHERE watch_key IS NULL`).all()
  const hasMsg = db.prepare(`SELECT 1 FROM messages WHERE session_id=? AND chat_jid=? LIMIT 1`)
  const del = db.prepare(`DELETE FROM chats WHERE session_id=? AND jid=?`)
  const upd = db.prepare(`UPDATE chats SET watch_key=? WHERE session_id=? AND jid=?`)
  for (const c of nulls) {
    if (!hasMsg.get(c.session_id, c.jid)) { del.run(c.session_id, c.jid); continue }
    const key = c.is_group ? 'g:' + (c.name || '') : 'n:' + String(c.jid).split('@')[0].replace(/\D/g, '')
    upd.run(key, c.session_id, c.jid)
  }
})()

const ADMINISH = new Set(['super_admin', 'admin'])

// ---- prepared statements -------------------------------------------------
const S = {
  upsertSession: db.prepare(`
    INSERT INTO sessions (id,name,status,watch_all,created_at,owner_user_id)
    VALUES (@id,@name,@status,@watch_all,@created_at,@owner_user_id)
    ON CONFLICT(id) DO UPDATE SET name=@name`),
  setSessionStatus: db.prepare(`UPDATE sessions SET status=? WHERE id=?`),
  setSessionMeta: db.prepare(`
    UPDATE sessions SET phone=@phone, platform=@platform, pushname=@pushname WHERE id=@id`),
  touchOpen: db.prepare(`UPDATE sessions SET last_open=?, status='open' WHERE id=?`),
  touchClose: db.prepare(`UPDATE sessions SET last_close=?, reconnects=reconnects+1 WHERE id=?`),
  setWatchAll: db.prepare(`UPDATE sessions SET watch_all=? WHERE id=?`),
  delSession: db.prepare(`DELETE FROM sessions WHERE id=?`),
  getSession: db.prepare(`SELECT * FROM sessions WHERE id=?`),
  allSessions: db.prepare(`SELECT * FROM sessions ORDER BY created_at ASC`),

  upsertChat: db.prepare(`
    INSERT INTO chats (session_id,jid,name,is_group,last_ts,last_text,last_sender,msg_count,watch_key)
    VALUES (@session_id,@jid,@name,@is_group,@last_ts,@last_text,@last_sender,1,@watch_key)
    ON CONFLICT(session_id,jid) DO UPDATE SET
      name=COALESCE(@name,name),
      is_group=@is_group,
      last_ts=MAX(last_ts,@last_ts),
      last_text=@last_text,
      last_sender=@last_sender,
      watch_key=COALESCE(@watch_key,watch_key),
      msg_count=msg_count+1`),
  renameChat: db.prepare(`UPDATE chats SET name=? WHERE session_id=? AND jid=?`),

  insertMsg: db.prepare(`
    INSERT OR IGNORE INTO messages
      (msg_id,session_id,chat_jid,chat_name,is_group,sender_jid,sender_name,from_me,type,text,has_media,quoted_text,ts,created_at)
    VALUES (@msg_id,@session_id,@chat_jid,@chat_name,@is_group,@sender_jid,@sender_name,@from_me,@type,@text,@has_media,@quoted_text,@ts,@created_at)`),

  upsertContact: db.prepare(`
    INSERT INTO contacts (session_id,jid,name,notify,is_business)
    VALUES (@session_id,@jid,@name,@notify,@is_business)
    ON CONFLICT(session_id,jid) DO UPDATE SET
      name=COALESCE(@name,name), notify=COALESCE(@notify,notify)`),

  upsertGroup: db.prepare(`
    INSERT INTO groups (session_id,jid,subject,description,owner,participants,created_at)
    VALUES (@session_id,@jid,@subject,@description,@owner,@participants,@created_at)
    ON CONFLICT(session_id,jid) DO UPDATE SET
      subject=@subject, description=@description, participants=@participants`),

  addWatch: db.prepare(`INSERT INTO watchlist (session_id,kind,value,label,created_at) VALUES (?,?,?,?,?)`),
  delWatch: db.prepare(`DELETE FROM watchlist WHERE id=?`),
  listWatch: db.prepare(`SELECT * FROM watchlist WHERE session_id=? OR session_id='*' ORDER BY created_at DESC`),
  allWatch: db.prepare(`SELECT * FROM watchlist ORDER BY created_at DESC`),

  addKeyword: db.prepare(`INSERT INTO keywords (word,created_at) VALUES (?,?)`),
  delKeyword: db.prepare(`DELETE FROM keywords WHERE id=?`),
  listKeywords: db.prepare(`SELECT * FROM keywords ORDER BY word ASC`),

  logEvent: db.prepare(`INSERT INTO events (session_id,level,code,message,ts) VALUES (?,?,?,?,?)`),
  recentEvents: db.prepare(`SELECT * FROM events ORDER BY id DESC LIMIT ?`),
}

module.exports = {
  db,

  // sessions
  upsertSession: (r) => S.upsertSession.run({ owner_user_id: null, ...r }),
  setSessionOwner: (id, uid) => db.prepare(`UPDATE sessions SET owner_user_id=? WHERE id=?`).run(uid, id),
  // RLS: super_admin/admin see all; manager/viewer only granted sessions
  canAccessSession: (user, id) => {
    if (!user) return false
    if (ADMINISH.has(user.role)) return true
    const g = db.prepare(`SELECT 1 FROM session_grants WHERE user_id=? AND session_id=?`).get(user.id, id)
    return !!g
  },
  ownedSessionIds: (user) => {
    if (!user) return []
    if (ADMINISH.has(user.role)) return db.prepare(`SELECT id FROM sessions`).all().map((r) => r.id)
    return db.prepare(`SELECT session_id FROM session_grants WHERE user_id=?`).all(user.id).map((r) => r.session_id)
  },

  // ---- grants ----
  addGrant: (uid, sid, by) => db.prepare(`INSERT OR IGNORE INTO session_grants (user_id,session_id,granted_by,created_at) VALUES (?,?,?,?)`).run(uid, sid, by, Date.now()),
  delGrant: (id) => db.prepare(`DELETE FROM session_grants WHERE id=?`).run(id),
  listGrants: () => db.prepare(`
    SELECT g.id, g.user_id, g.session_id, g.granted_by, g.created_at,
           u.username, u.role, s.name AS session_name
    FROM session_grants g
    LEFT JOIN users u ON u.id=g.user_id
    LEFT JOIN sessions s ON s.id=g.session_id
    ORDER BY g.created_at DESC`).all(),
  grantsForUser: (uid) => db.prepare(`SELECT session_id FROM session_grants WHERE user_id=?`).all(uid).map((r) => r.session_id),
  setSessionStatus: (id, s) => S.setSessionStatus.run(s, id),
  setSessionMeta: (r) => S.setSessionMeta.run(r),
  touchOpen: (id) => S.touchOpen.run(Date.now(), id),
  touchClose: (id) => S.touchClose.run(Date.now(), id),
  setWatchAll: (id, v) => S.setWatchAll.run(v ? 1 : 0, id),
  deleteSession: (id) => {
    S.delSession.run(id)
    db.prepare(`DELETE FROM chats WHERE session_id=?`).run(id)
    db.prepare(`DELETE FROM messages WHERE session_id=?`).run(id)
    db.prepare(`DELETE FROM contacts WHERE session_id=?`).run(id)
    db.prepare(`DELETE FROM groups WHERE session_id=?`).run(id)
    db.prepare(`DELETE FROM session_grants WHERE session_id=?`).run(id)
  },
  getSession: (id) => S.getSession.get(id),
  allSessions: () => S.allSessions.all(),

  // chats / messages
  upsertChat: (r) => S.upsertChat.run({ watch_key: null, ...r }),
  renameChat: (name, sid, jid) => S.renameChat.run(name, sid, jid),
  insertMsg: (r) => S.insertMsg.run(r),
  upsertContact: (r) => S.upsertContact.run(r),
  upsertGroup: (r) => S.upsertGroup.run(r),

  // watchlist / keywords
  addWatch: (sid, kind, value, label) => S.addWatch.run(sid, kind, value, label, Date.now()),
  delWatch: (id) => S.delWatch.run(id),
  listWatch: (sid) => (sid ? S.listWatch.all(sid) : S.allWatch.all()),
  getWatch: (id) => db.prepare(`SELECT * FROM watchlist WHERE id=?`).get(id),
  listWatchScoped: (sessionIds) => {
    if (!sessionIds || sessionIds.length === 0) return []
    const ph = sessionIds.map(() => '?').join(',')
    return db.prepare(`SELECT * FROM watchlist WHERE session_id IN (${ph}) ORDER BY created_at DESC`).all(...sessionIds)
  },
  addKeyword: (w) => S.addKeyword.run(w, Date.now()),
  delKeyword: (id) => S.delKeyword.run(id),
  listKeywords: () => S.listKeywords.all(),

  // events
  logEvent: (sid, level, code, message) => S.logEvent.run(sid, level, code || '', message, Date.now()),
  recentEvents: (n = 200) => S.recentEvents.all(n),

  // ---- query helpers used by the API -----------------------------------
  // Recent = only chats whose watch_key is still in the active watchlist.
  recentChats: (sid, limit = 100, keys = null) => {
    if (keys === null) return db.prepare(`SELECT * FROM chats WHERE session_id=? ORDER BY last_ts DESC LIMIT ?`).all(sid, limit)
    if (keys.length === 0) return []
    const ph = keys.map(() => '?').join(',')
    return db.prepare(`SELECT * FROM chats WHERE session_id=? AND watch_key IN (${ph}) ORDER BY last_ts DESC LIMIT ?`).all(sid, ...keys, limit)
  },
  setLid: (sid, lid, phone) => { try { db.prepare(`INSERT INTO lidmap (session_id,lid,phone) VALUES (?,?,?) ON CONFLICT(session_id,lid) DO UPDATE SET phone=excluded.phone`).run(sid, lid, phone) } catch {} },
  getLid: (sid, lid) => { const r = db.prepare(`SELECT phone FROM lidmap WHERE session_id=? AND lid=?`).get(sid, lid); return r ? r.phone : null },

  getChatName: (sid, jid) => {
    const r = db.prepare(`SELECT name FROM chats WHERE session_id=? AND jid=?`).get(sid, jid)
    return r ? r.name : null
  },

  // Logs = the full permanent archive (everything ever captured, even after
  // it was removed from the watchlist). Only real captured chats (have a key).
  allChats: (sid, limit = 2000) =>
    db.prepare(`SELECT * FROM chats WHERE session_id=? AND watch_key IS NOT NULL ORDER BY last_ts DESC LIMIT ?`).all(sid, limit),
  // Retention: purge DB rows older than N days. The .txt archive is untouched,
  // so nothing is truly lost. Returns the number of messages removed.
  cleanupOld: (days = 30) => {
    const cutoff = Date.now() - days * 24 * 3600 * 1000
    const r = db.prepare(`DELETE FROM messages WHERE ts < ?`).run(cutoff)
    // drop chats that no longer have any messages
    db.prepare(`DELETE FROM chats WHERE last_ts < ? AND jid NOT IN
      (SELECT DISTINCT chat_jid FROM messages WHERE session_id = chats.session_id)`).run(cutoff)
    db.prepare(`DELETE FROM events WHERE ts < ?`).run(cutoff)
    return r.changes
  },

  // Delete a chat's entire log (messages + chat row). Returns the chat name.
  deleteChatLog: (sid, jid) => {
    const row = db.prepare(`SELECT name FROM chats WHERE session_id=? AND jid=?`).get(sid, jid) ||
      db.prepare(`SELECT chat_name AS name FROM messages WHERE session_id=? AND chat_jid=? LIMIT 1`).get(sid, jid)
    db.prepare(`DELETE FROM messages WHERE session_id=? AND chat_jid=?`).run(sid, jid)
    db.prepare(`DELETE FROM chats WHERE session_id=? AND jid=?`).run(sid, jid)
    return row ? row.name : null
  },
  chatMessages: (sid, jid, limit = 200) =>
    db.prepare(`SELECT * FROM messages WHERE session_id=? AND chat_jid=? ORDER BY ts DESC LIMIT ?`)
      .all(sid, jid, limit).reverse(),
  searchMessages: (q, limit = 200) =>
    db.prepare(`SELECT * FROM messages WHERE text LIKE ? ORDER BY ts DESC LIMIT ?`)
      .all('%' + q + '%', limit),
  listGroups: (sid) =>
    db.prepare(`SELECT * FROM groups WHERE session_id=? ORDER BY subject ASC`).all(sid),
  listContacts: (sid, limit = 1000) =>
    db.prepare(`SELECT * FROM contacts WHERE session_id=? ORDER BY name ASC LIMIT ?`).all(sid, limit),

  // stats — pass ids=undefined for ALL (admins), or an array to scope (RLS).
  stats: (ids) => {
    const since = Date.now() - 24 * 3600 * 1000
    if (ids && ids.length === 0) return { sessions: 0, sessionsOpen: 0, messages: 0, messages24h: 0, chats: 0, groups: 0, contacts: 0 }
    const ph = ids ? `(${ids.map(() => '?').join(',')})` : null
    const W = ph ? ` WHERE session_id IN ${ph}` : ''
    const Wand = ph ? ` AND session_id IN ${ph}` : ''
    const args = ids || []
    const one = (sql, extra = []) => db.prepare(sql).get(...extra).n
    return {
      sessions: ids ? ids.length : one(`SELECT COUNT(*) n FROM sessions`),
      sessionsOpen: db.prepare(`SELECT COUNT(*) n FROM sessions WHERE status='open'${ph ? ` AND id IN ${ph}` : ''}`).get(...args).n,
      messages: one(`SELECT COUNT(*) n FROM messages${W}`, args),
      messages24h: one(`SELECT COUNT(*) n FROM messages WHERE ts>=?${Wand}`, [since, ...args]),
      chats: one(`SELECT COUNT(*) n FROM chats${W}`, args),
      groups: one(`SELECT COUNT(*) n FROM groups${W}`, args),
      contacts: one(`SELECT COUNT(*) n FROM contacts${W}`, args),
    }
  },

  hourly: (ids) => {
    if (ids && ids.length === 0) return []
    const ph = ids ? ` AND session_id IN (${ids.map(() => '?').join(',')})` : ''
    return db.prepare(`SELECT (ts/3600000) bucket, COUNT(*) n FROM messages
      WHERE ts >= ?${ph} GROUP BY bucket ORDER BY bucket ASC`).all(Date.now() - 24 * 3600 * 1000, ...(ids || []))
  },

  topChats: (limit = 8, ids) => {
    if (ids && ids.length === 0) return []
    const ph = ids ? ` AND session_id IN (${ids.map(() => '?').join(',')})` : ''
    return db.prepare(`SELECT chat_name, COUNT(*) n FROM messages
      WHERE chat_name IS NOT NULL${ph} GROUP BY chat_jid ORDER BY n DESC LIMIT ?`).all(...(ids || []), limit)
  },

  // ---- security: users ----
  createUser: (username, pass_hash, salt, role = 'admin') =>
    db.prepare(`INSERT INTO users (username,pass_hash,salt,role,created_at) VALUES (?,?,?,?,?)`)
      .run(username, pass_hash, salt, role, Date.now()),
  getUserByName: (u) => db.prepare(`SELECT * FROM users WHERE username=?`).get(u),
  getUserById: (id) => db.prepare(`SELECT * FROM users WHERE id=?`).get(id),
  // super_admin is intentionally hidden from user management
  listUsers: () => db.prepare(`SELECT id,username,role,created_at,last_login FROM users WHERE role!='super_admin' ORDER BY id ASC`).all(),
  deleteUser: (id) => { db.prepare(`DELETE FROM session_grants WHERE user_id=?`).run(id); db.prepare(`DELETE FROM users WHERE id=?`).run(id) },
  countUsers: () => db.prepare(`SELECT COUNT(*) n FROM users`).get().n,
  setLastLogin: (id) => db.prepare(`UPDATE users SET last_login=? WHERE id=?`).run(Date.now(), id),
  setPassword: (id, pass_hash, salt) => db.prepare(`UPDATE users SET pass_hash=?, salt=? WHERE id=?`).run(pass_hash, salt, id),

  // ---- security: auth sessions ----
  createAuthSession: (r) => db.prepare(`
    INSERT INTO auth_sessions (token,user_id,username,ip,ua,login_at,last_seen)
    VALUES (@token,@user_id,@username,@ip,@ua,@login_at,@last_seen)`).run(r),
  getAuthSession: (t) => db.prepare(`SELECT * FROM auth_sessions WHERE token=? AND logout_at IS NULL`).get(t),
  touchAuthSession: (t) => db.prepare(`UPDATE auth_sessions SET last_seen=? WHERE token=?`).run(Date.now(), t),
  closeAuthSession: (t) => db.prepare(`UPDATE auth_sessions SET logout_at=? WHERE token=?`).run(Date.now(), t),
  listAuthSessions: (limit = 200) =>
    db.prepare(`SELECT * FROM auth_sessions ORDER BY login_at DESC LIMIT ?`).all(limit),
  activeAuthSessions: () =>
    db.prepare(`SELECT * FROM auth_sessions WHERE logout_at IS NULL ORDER BY login_at DESC`).all(),

  // ---- security: audit ----
  logAudit: (r) => db.prepare(`
    INSERT INTO audit (user_id,username,action,target,detail,ip,ts)
    VALUES (@user_id,@username,@action,@target,@detail,@ip,@ts)`).run(r),
  listAudit: (limit = 500) => db.prepare(`SELECT * FROM audit ORDER BY id DESC LIMIT ?`).all(limit),
  auditStats: () => {
    const one = (sql, ...a) => db.prepare(sql).get(...a)
    const since = Date.now() - 24 * 3600 * 1000
    return {
      logins24h: one(`SELECT COUNT(*) n FROM auth_sessions WHERE login_at>=?`, since).n,
      active: one(`SELECT COUNT(*) n FROM auth_sessions WHERE logout_at IS NULL`).n,
      actions24h: one(`SELECT COUNT(*) n FROM audit WHERE ts>=?`, since).n,
      users: one(`SELECT COUNT(*) n FROM users`).n,
    }
  },
}

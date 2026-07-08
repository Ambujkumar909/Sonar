// =============================================================
//  Sonar — persistence layer (PostgreSQL)
//  Everything lives in Postgres now (sessions, chats, messages,
//  users, audit, grants, watchlist, keywords, WhatsApp auth, kv).
//  Only the .txt archives remain on the filesystem.
//  All methods are async.
// =============================================================
const { Pool, types } = require('pg')
const cfg = require('./config')

// return BIGINT (int8) as a JS number — our ms-timestamps & ids fit in 2^53
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)))

const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 12 })
pool.on('error', (e) => console.error('[pg pool]', e.message))

const q = (text, params) => pool.query(text, params)
const one = async (text, params) => (await pool.query(text, params)).rows[0] || null
const all = async (text, params) => (await pool.query(text, params)).rows
const ADMINISH = new Set(['super_admin', 'admin'])

// ---- schema ---------------------------------------------------------------
async function init() {
  await q(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT DEFAULT 'idle',
    phone TEXT, platform TEXT, pushname TEXT, watch_all INT DEFAULT 0,
    created_at BIGINT, last_open BIGINT, last_close BIGINT, reconnects INT DEFAULT 0,
    note TEXT, owner_user_id INT
  );
  CREATE TABLE IF NOT EXISTS chats (
    session_id TEXT, jid TEXT, name TEXT, is_group INT DEFAULT 0,
    last_ts BIGINT DEFAULT 0, last_text TEXT, last_sender TEXT, unread INT DEFAULT 0,
    msg_count INT DEFAULT 0, pinned INT DEFAULT 0, archived INT DEFAULT 0, watch_key TEXT,
    PRIMARY KEY (session_id, jid)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY, msg_id TEXT, session_id TEXT, chat_jid TEXT, chat_name TEXT,
    is_group INT DEFAULT 0, sender_jid TEXT, sender_name TEXT, from_me INT DEFAULT 0,
    type TEXT, text TEXT, has_media INT DEFAULT 0, quoted_text TEXT, ts BIGINT, created_at BIGINT
  );
  CREATE INDEX IF NOT EXISTS idx_msg_chat ON messages(session_id, chat_jid, ts);
  CREATE INDEX IF NOT EXISTS idx_msg_ts ON messages(ts);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_unique ON messages(session_id, chat_jid, msg_id);
  CREATE TABLE IF NOT EXISTS contacts (
    session_id TEXT, jid TEXT, name TEXT, notify TEXT, is_business INT DEFAULT 0,
    PRIMARY KEY (session_id, jid)
  );
  CREATE TABLE IF NOT EXISTS groups (
    session_id TEXT, jid TEXT, subject TEXT, description TEXT, owner TEXT,
    participants INT DEFAULT 0, created_at BIGINT, PRIMARY KEY (session_id, jid)
  );
  CREATE TABLE IF NOT EXISTS pending_groups (
    session_id TEXT, jid TEXT, subject TEXT, participants INT DEFAULT 0,
    ts BIGINT, PRIMARY KEY (session_id, jid)
  );
  CREATE TABLE IF NOT EXISTS watchlist (
    id SERIAL PRIMARY KEY, session_id TEXT, kind TEXT, value TEXT, label TEXT, created_at BIGINT
  );
  CREATE TABLE IF NOT EXISTS keywords (
    id SERIAL PRIMARY KEY, word TEXT, created_at BIGINT
  );
  CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY, session_id TEXT, level TEXT, code TEXT, message TEXT, ts BIGINT
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL,
    salt TEXT NOT NULL, role TEXT DEFAULT 'admin', created_at BIGINT, last_login BIGINT
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token TEXT PRIMARY KEY, user_id INT, username TEXT, ip TEXT, ua TEXT,
    login_at BIGINT, last_seen BIGINT, logout_at BIGINT
  );
  CREATE TABLE IF NOT EXISTS audit (
    id BIGSERIAL PRIMARY KEY, user_id INT, username TEXT, action TEXT, target TEXT,
    detail TEXT, ip TEXT, ts BIGINT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
  CREATE TABLE IF NOT EXISTS session_grants (
    id SERIAL PRIMARY KEY, user_id INT, session_id TEXT, granted_by TEXT, created_at BIGINT,
    UNIQUE(user_id, session_id)
  );
  CREATE TABLE IF NOT EXISTS lidmap (
    session_id TEXT, lid TEXT, phone TEXT, PRIMARY KEY(session_id, lid)
  );
  CREATE TABLE IF NOT EXISTS wa_auth (
    session_id TEXT, id TEXT, value TEXT, PRIMARY KEY(session_id, id)
  );
  CREATE TABLE IF NOT EXISTS kv ( k TEXT PRIMARY KEY, v TEXT );
  CREATE TABLE IF NOT EXISTS reports (
    id BIGSERIAL PRIMARY KEY, created_at BIGINT, created_by TEXT,
    window_days INT DEFAULT 0, msg_count INT DEFAULT 0, chat_count INT DEFAULT 0, html TEXT
  );
  `)
}

module.exports = {
  pool, init,

  // ---- sessions ----
  upsertSession: (r) => q(
    `INSERT INTO sessions (id,name,status,watch_all,created_at,owner_user_id)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET name=$2`,
    [r.id, r.name, r.status, r.watch_all, r.created_at, r.owner_user_id ?? null]),
  setSessionStatus: (id, s) => q(`UPDATE sessions SET status=$1 WHERE id=$2`, [s, id]),
  setSessionMeta: (r) => q(`UPDATE sessions SET phone=$1, platform=$2, pushname=$3 WHERE id=$4`, [r.phone, r.platform, r.pushname, r.id]),
  touchOpen: (id) => q(`UPDATE sessions SET last_open=$1, status='open' WHERE id=$2`, [Date.now(), id]),
  touchClose: (id) => q(`UPDATE sessions SET last_close=$1, reconnects=reconnects+1 WHERE id=$2`, [Date.now(), id]),
  setWatchAll: (id, v) => q(`UPDATE sessions SET watch_all=$1 WHERE id=$2`, [v ? 1 : 0, id]),
  setSessionOwner: (id, uid) => q(`UPDATE sessions SET owner_user_id=$1 WHERE id=$2`, [uid, id]),
  getSession: (id) => one(`SELECT * FROM sessions WHERE id=$1`, [id]),
  allSessions: () => all(`SELECT * FROM sessions ORDER BY created_at ASC`),
  deleteSession: async (id) => {
    for (const t of ['chats', 'messages', 'contacts', 'groups', 'pending_groups', 'session_grants', 'wa_auth']) {
      await q(`DELETE FROM ${t} WHERE session_id=$1`, [id])
    }
    await q(`DELETE FROM sessions WHERE id=$1`, [id])
  },

  // ---- RLS ----
  canAccessSession: async (user, id) => {
    if (!user) return false
    if (ADMINISH.has(user.role)) return true
    const g = await one(`SELECT 1 FROM session_grants WHERE user_id=$1 AND session_id=$2`, [user.id, id])
    return !!g
  },
  ownedSessionIds: async (user) => {
    if (!user) return []
    if (ADMINISH.has(user.role)) return (await all(`SELECT id FROM sessions`)).map((r) => r.id)
    return (await all(`SELECT session_id FROM session_grants WHERE user_id=$1`, [user.id])).map((r) => r.session_id)
  },

  // ---- grants ----
  addGrant: (uid, sid, by) => q(`INSERT INTO session_grants (user_id,session_id,granted_by,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id,session_id) DO NOTHING`, [uid, sid, by, Date.now()]),
  delGrant: (id) => q(`DELETE FROM session_grants WHERE id=$1`, [id]),
  listGrants: () => all(`SELECT g.id, g.user_id, g.session_id, g.granted_by, g.created_at,
      u.username, u.role, s.name AS session_name
      FROM session_grants g LEFT JOIN users u ON u.id=g.user_id LEFT JOIN sessions s ON s.id=g.session_id
      ORDER BY g.created_at DESC`),
  grantsForUser: async (uid) => (await all(`SELECT session_id FROM session_grants WHERE user_id=$1`, [uid])).map((r) => r.session_id),

  // ---- chats / messages ----
  upsertChat: (r) => q(
    `INSERT INTO chats (session_id,jid,name,is_group,last_ts,last_text,last_sender,msg_count,watch_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8)
     ON CONFLICT (session_id,jid) DO UPDATE SET
       name=COALESCE($3,chats.name), is_group=$4, last_ts=GREATEST(chats.last_ts,$5),
       last_text=$6, last_sender=$7, watch_key=COALESCE($8,chats.watch_key),
       msg_count=chats.msg_count+1`,
    [r.session_id, r.jid, r.name, r.is_group, r.last_ts, r.last_text, r.last_sender, r.watch_key ?? null]),
  insertMsg: (r) => q(
    `INSERT INTO messages (msg_id,session_id,chat_jid,chat_name,is_group,sender_jid,sender_name,from_me,type,text,has_media,quoted_text,ts,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (session_id,chat_jid,msg_id) DO NOTHING`,
    [r.msg_id, r.session_id, r.chat_jid, r.chat_name, r.is_group, r.sender_jid, r.sender_name, r.from_me, r.type, r.text, r.has_media, r.quoted_text, r.ts, r.created_at]),
  getChatName: async (sid, jid) => { const r = await one(`SELECT name FROM chats WHERE session_id=$1 AND jid=$2`, [sid, jid]); return r ? r.name : null },
  recentChats: (sid, limit = 100, keys = null) => {
    if (keys === null) return all(`SELECT * FROM chats WHERE session_id=$1 ORDER BY last_ts DESC LIMIT $2`, [sid, limit])
    if (keys.length === 0) return []
    return all(`SELECT * FROM chats WHERE session_id=$1 AND watch_key = ANY($2) ORDER BY last_ts DESC LIMIT $3`, [sid, keys, limit])
  },
  allChats: (sid, limit = 2000) => all(`SELECT * FROM chats WHERE session_id=$1 AND watch_key IS NOT NULL ORDER BY last_ts DESC LIMIT $2`, [sid, limit]),
  chatMessages: async (sid, jid, limit = 200) => (await all(`SELECT * FROM messages WHERE session_id=$1 AND chat_jid=$2 ORDER BY ts DESC LIMIT $3`, [sid, jid, limit])).reverse(),
  searchMessages: (qq, limit = 200, ids) => {
    if (ids && ids.length === 0) return []
    if (ids) return all(`SELECT * FROM messages WHERE text ILIKE $1 AND session_id = ANY($2) ORDER BY ts DESC LIMIT $3`, ['%' + qq + '%', ids, limit])
    return all(`SELECT * FROM messages WHERE text ILIKE $1 ORDER BY ts DESC LIMIT $2`, ['%' + qq + '%', limit])
  },
  deleteChatLog: async (sid, jid) => {
    const row = (await one(`SELECT name FROM chats WHERE session_id=$1 AND jid=$2`, [sid, jid])) ||
      (await one(`SELECT chat_name AS name FROM messages WHERE session_id=$1 AND chat_jid=$2 LIMIT 1`, [sid, jid]))
    await q(`DELETE FROM messages WHERE session_id=$1 AND chat_jid=$2`, [sid, jid])
    await q(`DELETE FROM chats WHERE session_id=$1 AND jid=$2`, [sid, jid])
    return row ? row.name : null
  },

  // ---- lid map ----
  setLid: (sid, lid, phone) => q(`INSERT INTO lidmap (session_id,lid,phone) VALUES ($1,$2,$3) ON CONFLICT (session_id,lid) DO UPDATE SET phone=$3`, [sid, lid, phone]).catch(() => {}),
  getLid: async (sid, lid) => { const r = await one(`SELECT phone FROM lidmap WHERE session_id=$1 AND lid=$2`, [sid, lid]); return r ? r.phone : null },

  // ---- contacts / groups ----
  upsertContact: (r) => q(`INSERT INTO contacts (session_id,jid,name,notify,is_business) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (session_id,jid) DO UPDATE SET name=COALESCE($3,contacts.name), notify=COALESCE($4,contacts.notify)`,
    [r.session_id, r.jid, r.name, r.notify, r.is_business]),
  listContacts: (sid, limit = 1000) => all(`SELECT * FROM contacts WHERE session_id=$1 ORDER BY name ASC LIMIT $2`, [sid, limit]),
  upsertGroup: (r) => q(`INSERT INTO groups (session_id,jid,subject,description,owner,participants,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (session_id,jid) DO UPDATE SET subject=$3, description=$4, participants=$6`,
    [r.session_id, r.jid, r.subject, r.description, r.owner, r.participants, r.created_at]),
  listGroups: (sid) => all(`SELECT * FROM groups WHERE session_id=$1 ORDER BY subject ASC`, [sid]),
  groupExists: async (sid, jid) => (await all(`SELECT 1 FROM groups WHERE session_id=$1 AND jid=$2 LIMIT 1`, [sid, jid])).length > 0,

  // ---- pending groups (new joins awaiting an admin decision) ----
  addPendingGroup: (r) => q(`INSERT INTO pending_groups (session_id,jid,subject,participants,ts) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (session_id,jid) DO UPDATE SET subject=$3, participants=$4, ts=$5`,
    [r.session_id, r.jid, r.subject, r.participants || 0, r.ts || Date.now()]),
  listPendingGroups: () => all(`SELECT p.*, s.name AS session_name FROM pending_groups p
      LEFT JOIN sessions s ON s.id=p.session_id ORDER BY p.ts DESC`),
  delPendingGroup: (sid, jid) => q(`DELETE FROM pending_groups WHERE session_id=$1 AND jid=$2`, [sid, jid]),

  // ---- watchlist / keywords ----
  addWatch: (sid, kind, value, label) => q(`INSERT INTO watchlist (session_id,kind,value,label,created_at) VALUES ($1,$2,$3,$4,$5)`, [sid, kind, value, label, Date.now()]),
  delWatch: (id) => q(`DELETE FROM watchlist WHERE id=$1`, [id]),
  // `members` = current participant count for group watches, null for number watches.
  // Match on subject case/whitespace-insensitively — watch values are often typed by hand.
  listWatch: (sid) => sid
    ? all(`SELECT w.*, g.participants AS members FROM watchlist w
           LEFT JOIN groups g ON g.session_id=w.session_id AND LOWER(TRIM(g.subject))=LOWER(TRIM(w.value)) AND w.kind='group'
           WHERE w.session_id=$1 OR w.session_id='*' ORDER BY w.created_at DESC`, [sid])
    : all(`SELECT w.*, g.participants AS members FROM watchlist w
           LEFT JOIN groups g ON g.session_id=w.session_id AND LOWER(TRIM(g.subject))=LOWER(TRIM(w.value)) AND w.kind='group'
           ORDER BY w.created_at DESC`),
  getWatch: (id) => one(`SELECT * FROM watchlist WHERE id=$1`, [id]),
  listWatchScoped: (ids) => (!ids || ids.length === 0) ? [] : all(`SELECT w.*, g.participants AS members FROM watchlist w
      LEFT JOIN groups g ON g.session_id=w.session_id AND LOWER(TRIM(g.subject))=LOWER(TRIM(w.value)) AND w.kind='group'
      WHERE w.session_id = ANY($1) ORDER BY w.created_at DESC`, [ids]),
  addKeyword: (w) => q(`INSERT INTO keywords (word,created_at) VALUES ($1,$2)`, [w, Date.now()]),
  delKeyword: (id) => q(`DELETE FROM keywords WHERE id=$1`, [id]),
  listKeywords: () => all(`SELECT * FROM keywords ORDER BY word ASC`),

  // ---- events ----
  logEvent: (sid, level, code, message) => q(`INSERT INTO events (session_id,level,code,message,ts) VALUES ($1,$2,$3,$4,$5)`, [sid, level, code || '', message, Date.now()]).catch(() => {}),
  recentEvents: (n = 200) => all(`SELECT * FROM events ORDER BY id DESC LIMIT $1`, [n]),

  // ---- analytics ----
  stats: async (ids) => {
    if (ids && ids.length === 0) return { sessions: 0, sessionsOpen: 0, messages: 0, messages24h: 0, chats: 0, groups: 0, contacts: 0 }
    const since = Date.now() - 24 * 3600 * 1000
    const n = async (sql, p) => Number((await one(sql, p)).n)
    const filt = ids ? ` WHERE session_id = ANY($1)` : ''
    const a = ids ? [ids] : []
    // run all counts in parallel (was sequential — the throughput bottleneck)
    const [sessions, sessionsOpen, messages, messages24h, chats, groups, contacts] = await Promise.all([
      ids ? Promise.resolve(ids.length) : n(`SELECT COUNT(*) n FROM sessions`),
      n(`SELECT COUNT(*) n FROM sessions WHERE status='open'${ids ? ` AND id = ANY($1)` : ''}`, a),
      n(`SELECT COUNT(*) n FROM messages${filt}`, a),
      n(`SELECT COUNT(*) n FROM messages WHERE ts>=$${ids ? 2 : 1}${ids ? ` AND session_id = ANY($1)` : ''}`, ids ? [ids, since] : [since]),
      n(`SELECT COUNT(*) n FROM chats${filt}`, a),
      n(`SELECT COUNT(*) n FROM groups${filt}`, a),
      n(`SELECT COUNT(*) n FROM contacts${filt}`, a),
    ])
    return { sessions, sessionsOpen, messages, messages24h, chats, groups, contacts }
  },
  hourly: (ids) => {
    if (ids && ids.length === 0) return []
    const since = Date.now() - 24 * 3600 * 1000
    return ids
      ? all(`SELECT (ts/3600000) bucket, COUNT(*) n FROM messages WHERE ts>=$1 AND session_id = ANY($2) GROUP BY bucket ORDER BY bucket ASC`, [since, ids])
      : all(`SELECT (ts/3600000) bucket, COUNT(*) n FROM messages WHERE ts>=$1 GROUP BY bucket ORDER BY bucket ASC`, [since])
  },
  topChats: (limit = 8, ids) => {
    if (ids && ids.length === 0) return []
    return ids
      ? all(`SELECT session_id, chat_jid, chat_name, COUNT(*) n FROM messages WHERE chat_name IS NOT NULL AND session_id = ANY($1) GROUP BY session_id, chat_jid, chat_name ORDER BY n DESC LIMIT $2`, [ids, limit])
      : all(`SELECT session_id, chat_jid, chat_name, COUNT(*) n FROM messages WHERE chat_name IS NOT NULL GROUP BY session_id, chat_jid, chat_name ORDER BY n DESC LIMIT $1`, [limit])
  },
  cleanupOld: async (days = 30) => {
    const cutoff = Date.now() - days * 24 * 3600 * 1000
    const r = await q(`DELETE FROM messages WHERE ts < $1`, [cutoff])
    await q(`DELETE FROM chats WHERE last_ts < $1 AND jid NOT IN (SELECT DISTINCT chat_jid FROM messages WHERE messages.session_id = chats.session_id)`, [cutoff])
    await q(`DELETE FROM events WHERE ts < $1`, [cutoff])
    return r.rowCount || 0
  },

  // ---- users ----
  createUser: (username, pass_hash, salt, role = 'admin') => q(`INSERT INTO users (username,pass_hash,salt,role,created_at) VALUES ($1,$2,$3,$4,$5)`, [username, pass_hash, salt, role, Date.now()]),
  getUserByName: (u) => one(`SELECT * FROM users WHERE username=$1`, [u]),
  getUserById: (id) => one(`SELECT * FROM users WHERE id=$1`, [id]),
  listUsers: () => all(`SELECT id,username,role,created_at,last_login FROM users WHERE role!='super_admin' ORDER BY id ASC`),
  deleteUser: async (id) => { await q(`DELETE FROM session_grants WHERE user_id=$1`, [id]); await q(`DELETE FROM users WHERE id=$1`, [id]) },
  countUsers: async () => Number((await one(`SELECT COUNT(*) n FROM users`)).n),
  setLastLogin: (id) => q(`UPDATE users SET last_login=$1 WHERE id=$2`, [Date.now(), id]),
  setPassword: (id, pass_hash, salt) => q(`UPDATE users SET pass_hash=$1, salt=$2 WHERE id=$3`, [pass_hash, salt, id]),

  // ---- auth sessions ----
  createAuthSession: (r) => q(`INSERT INTO auth_sessions (token,user_id,username,ip,ua,login_at,last_seen) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [r.token, r.user_id, r.username, r.ip, r.ua, r.login_at, r.last_seen]),
  getAuthSession: (t) => one(`SELECT * FROM auth_sessions WHERE token=$1 AND logout_at IS NULL`, [t]),
  touchAuthSession: (t) => q(`UPDATE auth_sessions SET last_seen=$1 WHERE token=$2`, [Date.now(), t]).catch(() => {}),
  closeAuthSession: (t) => q(`UPDATE auth_sessions SET logout_at=$1 WHERE token=$2`, [Date.now(), t]),
  listAuthSessions: (limit = 200) => all(`SELECT * FROM auth_sessions ORDER BY login_at DESC LIMIT $1`, [limit]),
  activeAuthSessions: () => all(`SELECT * FROM auth_sessions WHERE logout_at IS NULL ORDER BY login_at DESC`),

  // ---- audit ----
  logAudit: (r) => q(`INSERT INTO audit (user_id,username,action,target,detail,ip,ts) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [r.user_id, r.username, r.action, r.target, r.detail, r.ip, r.ts]).catch(() => {}),
  listAudit: (limit = 500) => all(`SELECT * FROM audit ORDER BY id DESC LIMIT $1`, [limit]),
  auditStats: async () => {
    const since = Date.now() - 24 * 3600 * 1000
    const n = async (sql, p) => Number((await one(sql, p)).n)
    return {
      logins24h: await n(`SELECT COUNT(*) n FROM auth_sessions WHERE login_at>=$1`, [since]),
      active: await n(`SELECT COUNT(*) n FROM auth_sessions WHERE logout_at IS NULL`),
      actions24h: await n(`SELECT COUNT(*) n FROM audit WHERE ts>=$1`, [since]),
      users: await n(`SELECT COUNT(*) n FROM users`),
    }
  },

  // ---- saved AI reports (stored snapshots — generate once, reuse) ----
  saveReport: async (r) => (await one(`INSERT INTO reports (created_at,created_by,window_days,msg_count,chat_count,html)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [Date.now(), r.created_by || '', r.window_days || 0, r.msg_count || 0, r.chat_count || 0, r.html])).id,
  listReports: (limit = 100) => all(`SELECT id, created_at, created_by, window_days, msg_count, chat_count FROM reports ORDER BY id DESC LIMIT $1`, [limit]),
  getReport: (id) => one(`SELECT * FROM reports WHERE id=$1`, [id]),
  deleteReport: (id) => q(`DELETE FROM reports WHERE id=$1`, [id]),

  // ---- key/value (license cache etc.) ----
  kvGet: async (k) => { const r = await one(`SELECT v FROM kv WHERE k=$1`, [k]); return r ? r.v : null },
  kvSet: (k, v) => q(`INSERT INTO kv (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=$2`, [k, v]),
  kvDel: (k) => q(`DELETE FROM kv WHERE k=$1`, [k]),

  // ---- WhatsApp auth (Baileys) ----
  waGet: async (sid, id) => { const r = await one(`SELECT value FROM wa_auth WHERE session_id=$1 AND id=$2`, [sid, id]); return r ? r.value : null },
  waSet: (sid, id, value) => q(`INSERT INTO wa_auth (session_id,id,value) VALUES ($1,$2,$3) ON CONFLICT (session_id,id) DO UPDATE SET value=$3`, [sid, id, value]),
  waDel: (sid, id) => q(`DELETE FROM wa_auth WHERE session_id=$1 AND id=$2`, [sid, id]),
  waClear: (sid) => q(`DELETE FROM wa_auth WHERE session_id=$1`, [sid]),
  waHasCreds: async (sid) => !!(await one(`SELECT 1 FROM wa_auth WHERE session_id=$1 AND id='creds'`, [sid])),
}

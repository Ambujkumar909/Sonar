// =============================================================
//  Sonar — HTTP + WebSocket server (REST API + live dashboard)
//  Secured: every /api route requires a valid session; every
//  meaningful action is written to the audit trail.
// =============================================================
// Register the .jsc loader so bytecode-compiled modules (license/sessionManager)
// resolve in production. Harmless in dev (sources are plain .js).
try { require('bytenode') } catch {}

const path = require('path')
const fs = require('fs')
const express = require('express')
const http = require('http')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const { Server } = require('socket.io')

const cfg = require('./config')
const store = require('./store')
const auth = require('./auth')
const textlog = require('./textlog')
const license = require('./license')
const SessionManager = require('./sessionManager')

const app = express()
const server = http.createServer(app)
// Socket.IO with no cors block = same-origin only (the dashboard is served here).
const io = new Server(server)

app.disable('x-powered-by')
app.set('trust proxy', true) // honor X-Forwarded-For for real client IPs behind a proxy
// Security headers + strict CSP. script-src 'self' (no inline JS — we use event
// delegation, never inline onclick) gives real XSS defense-in-depth.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}))
app.use(express.json({ limit: '1mb' }))
app.use(express.static(path.join(cfg.ROOT, 'public')))

// Brute-force protection on login.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Too many login attempts — try again in a few minutes' },
})
// throttle device-session creation (each session opens a real socket)
const createLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Creating sessions too fast — slow down' },
})
// clamp any ?limit= to a sane maximum
const lim = (v, def = 300) => { const n = Number(v); return Math.min(Number.isFinite(n) && n > 0 ? n : def, cfg.MAX_QUERY_LIMIT) }

// Broadcast everything the manager emits straight to connected dashboards.
const manager = new SessionManager((event, payload) => io.emit(event, payload))

// ---- helpers ---------------------------------------------------------------
const ok = (res, data) => res.json({ ok: true, ...data })
const bad = (res, msg, code = 400) => res.status(code).json({ ok: false, error: msg })

// ============================================================================
//  PUBLIC auth routes
// ============================================================================
app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {}
  const user = username && store.getUserByName(String(username).trim())
  if (!user || !auth.verifyPassword(String(password || ''), user.salt, user.pass_hash)) {
    store.logAudit({ user_id: null, username: username || '?', action: 'login.fail', target: '', detail: '', ip: auth.ipOf(req), ts: Date.now() })
    return bad(res, 'Invalid username or password', 401)
  }
  const token = auth.newToken()
  store.createAuthSession({ token, user_id: user.id, username: user.username, ip: auth.ipOf(req), ua: req.headers['user-agent'] || '', login_at: Date.now(), last_seen: Date.now() })
  store.setLastLogin(user.id)
  store.logAudit({ user_id: user.id, username: user.username, action: 'login', target: '', detail: '', ip: auth.ipOf(req), ts: Date.now() })
  auth.setAuthCookie(res, token)
  ok(res, { user: { id: user.id, username: user.username, role: user.role } })
})

app.post('/api/logout', (req, res) => {
  const u = auth.currentUser(req)
  if (u) { store.closeAuthSession(u.token); auth.audit(req, 'logout') }
  auth.clearAuthCookie(res)
  ok(res, {})
})

app.get('/api/me', (req, res) => {
  const u = auth.currentUser(req)
  if (!u) return bad(res, 'not authenticated', 401)
  const full = store.getUserById(u.id)
  ok(res, { user: { id: u.id, username: u.username, role: full?.role || 'admin', login_at: u.login_at } })
})

// ============================================================================
//  EVERYTHING BELOW REQUIRES AUTH
// ============================================================================
app.use('/api', auth.requireAuth)
app.use('/logs', auth.requireAuth, express.static(cfg.LOG_DIR)) // secured .txt downloads

// ---- sessions --------------------------------------------------------------
// RLS: admins see all; managers/viewers see only granted sessions.
function scoped(req) {
  return manager.list().filter((s) => store.canAccessSession(req.user, s.id))
}
// undefined for admins (all data), or the granted-id array for restricted roles.
function idsFor(req) {
  return auth.isAdminish(req.user.role) ? undefined : store.ownedSessionIds(req.user)
}
app.get('/api/state', (req, res) => ok(res, { sessions: scoped(req), stats: store.stats(idsFor(req)) }))

// Linking / removing a device is an admin action.
app.post('/api/sessions', auth.requireUserAdmin, createLimiter, async (req, res) => {
  try {
    const total = store.allSessions().length
    if (total >= cfg.MAX_SESSIONS) return bad(res, `Session limit reached (${cfg.MAX_SESSIONS}). Delete unused sessions first.`)
    const name = String(req.body?.name || '').trim().slice(0, 60) || ('Device ' + (total + 1))
    const id = await manager.createSession(req.body.id, name, req.user.id)
    auth.audit(req, 'session.create', id, name)
    ok(res, { id })
  } catch (e) { bad(res, e.message) }
})

// Per-session control routes: write-permission + row-level access
// (admins pass row-access automatically; managers need a grant; viewers blocked).
const sessGuard = [auth.requireWrite, auth.requireSessionAccess]
app.delete('/api/sessions/:id', auth.requireUserAdmin, async (req, res) => {
  if (!store.getSession(req.params.id)) return bad(res, 'no such session', 404)
  auth.audit(req, 'session.delete', req.params.id)
  await manager.deleteSession(req.params.id); ok(res, {})
})
// QR is fetched per-session on demand (kept OUT of /api/state to avoid bulk payload bloat).
app.get('/api/sessions/:id/qr', auth.requireSessionAccess, (req, res) => ok(res, { qr: manager.getQr(req.params.id) }))
app.post('/api/sessions/:id/restart', sessGuard, (req, res) => { auth.audit(req, 'session.restart', req.params.id); manager.forceRestart(req.params.id); ok(res, {}) })
app.post('/api/sessions/:id/stop', sessGuard, (req, res) => { auth.audit(req, 'session.stop', req.params.id); manager.stopSession(req.params.id); ok(res, {}) })
app.post('/api/sessions/:id/resume', sessGuard, (req, res) => { auth.audit(req, 'session.resume', req.params.id); manager.resumeSession(req.params.id); ok(res, {}) })
app.post('/api/sessions/:id/logout', sessGuard, async (req, res) => {
  auth.audit(req, 'session.newqr', req.params.id)
  await manager.logout(req.params.id); manager.forceRestart(req.params.id); ok(res, {})
})
// "Watch all" is powerful (logs every group) — super_admin only.
app.post('/api/sessions/:id/watchall', auth.requireSuperAdmin, auth.requireSessionAccess, (req, res) => {
  auth.audit(req, 'session.watchall', req.params.id, String(!!req.body.value))
  store.setWatchAll(req.params.id, !!req.body.value); ok(res, {})
})

// ---- chats / messages ------------------------------------------------------
// Recent = only currently-watchlisted chats (removed from watchlist → gone here).
// Forgiving number match handles country-code / LID differences.
app.get('/api/sessions/:id/chats', auth.requireSessionAccess, (req, res) => {
  const sid = req.params.id
  const sess = store.getSession(sid)
  let chats = store.allChats(sid, lim(req.query.limit, 600))
  if (!(sess && sess.watch_all)) {
    const w = store.listWatch(sid)
    const groups = w.filter((x) => x.kind === 'group').map((x) => x.value)
    const nums = w.filter((x) => x.kind === 'number').map((x) => String(x.value).replace(/\D/g, ''))
    chats = chats.filter((c) => {
      if (c.is_group) return groups.includes(c.name)
      const jd = String(c.jid).split('@')[0].replace(/\D/g, '')
      const wk = (c.watch_key || '').startsWith('n:') ? c.watch_key.slice(2) : jd
      return nums.some((n) => n && (n === jd || n === wk ||
        (n.length >= 8 && (jd.endsWith(n) || wk.endsWith(n))) ||
        (jd.length >= 8 && jd.endsWith(wk) && wk.endsWith(n))))
    })
  }
  ok(res, { chats })
})
// Logs = permanent archive (kept even after watchlist removal)
app.get('/api/sessions/:id/logs', auth.requireSessionAccess, (req, res) =>
  ok(res, { chats: store.allChats(req.params.id, lim(req.query.limit, 2000)) }))
// Delete a chat's entire log — super_admin / admin only
app.delete('/api/sessions/:id/chatlog', auth.requireUserAdmin, auth.requireSessionAccess, (req, res) => {
  const jid = req.query.jid
  if (!jid) return bad(res, 'jid required')
  const name = store.deleteChatLog(req.params.id, jid)
  if (name) { try { fs.rmSync(path.join(cfg.LOG_DIR, textlog.safeFileName(name)), { force: true }) } catch {} }
  auth.audit(req, 'log.delete', jid, name || '')
  ok(res, {})
})
app.get('/api/sessions/:id/messages', auth.requireSessionAccess, (req, res) => {
  if (!req.query.jid) return bad(res, 'jid required')
  ok(res, { messages: store.chatMessages(req.params.id, req.query.jid, lim(req.query.limit, 300)) })
})
app.get('/api/sessions/:id/groups', auth.requireSessionAccess, (req, res) => ok(res, { groups: store.listGroups(req.params.id) }))
app.get('/api/sessions/:id/contacts', auth.requireSessionAccess, (req, res) => ok(res, { contacts: store.listContacts(req.params.id, lim(req.query.limit, 2000)) }))
app.get('/api/search', (req, res) => {
  if ((req.query.q || '').length >= 2) auth.audit(req, 'search', req.query.q)
  ok(res, { messages: store.searchMessages(req.query.q || '', lim(req.query.limit, 300)) })
})

// ---- watchlist & keywords --------------------------------------------------
app.get('/api/watch', (req, res) => {
  const sid = req.query.sid
  if (sid) {
    if (!store.canAccessSession(req.user, sid)) return bad(res, 'no access to this session', 403)
    return ok(res, { watch: store.listWatch(sid) })
  }
  // no sid: admins see all; managers/viewers only their granted sessions' entries
  if (auth.isAdminish(req.user.role)) return ok(res, { watch: store.listWatch() })
  ok(res, { watch: store.listWatchScoped(store.ownedSessionIds(req.user)) })
})
app.post('/api/watch', auth.requireWrite, (req, res) => {
  let { sid, kind, value, label } = req.body || {}
  if (!sid || !kind || !value) return bad(res, 'sid, kind, value required')
  if (!['group', 'number'].includes(kind)) return bad(res, "kind must be 'group' or 'number'")
  if (!store.canAccessSession(req.user, sid)) return bad(res, 'no access to this session', 403)
  value = String(value).trim()
  if (kind === 'number') value = value.replace(/[^0-9]/g, '') // canonical digits — matches capture logic
  if (!value) return bad(res, 'value required')
  store.addWatch(sid, kind, value, String(label || value).trim()); auth.audit(req, 'watch.add', `${kind}:${value}`); ok(res, {})
})
app.delete('/api/watch/:id', auth.requireWrite, (req, res) => {
  const w = store.getWatch(Number(req.params.id))
  if (!w) return bad(res, 'not found', 404)
  if (!store.canAccessSession(req.user, w.session_id)) return bad(res, 'no access to this session', 403) // object-level authz (was the IDOR)
  store.delWatch(Number(req.params.id)); auth.audit(req, 'watch.del', req.params.id); ok(res, {})
})

app.get('/api/keywords', (req, res) => ok(res, { keywords: store.listKeywords() }))
app.post('/api/keywords', auth.requireWrite, (req, res) => {
  if (!req.body.word) return bad(res, 'word required')
  store.addKeyword(String(req.body.word).trim()); auth.audit(req, 'keyword.add', req.body.word); ok(res, {})
})
app.delete('/api/keywords/:id', auth.requireWrite, (req, res) => { store.delKeyword(Number(req.params.id)); auth.audit(req, 'keyword.del', req.params.id); ok(res, {}) })

// ---- analytics & events ----------------------------------------------------
app.get('/api/stats', (req, res) => ok(res, { stats: store.stats(idsFor(req)) }))
app.get('/api/analytics', (req, res) => {
  const ids = idsFor(req)
  ok(res, { hourly: store.hourly(ids), topChats: store.topChats(10, ids), stats: store.stats(ids) })
})
app.get('/api/events', (req, res) => ok(res, { events: store.recentEvents(lim(req.query.limit, 300)) }))

// ---- license ---------------------------------------------------------------
app.get('/api/license/status', (req, res) => ok(res, { license: license.publicStatus() }))
app.post('/api/license/activate', auth.requireSuperAdmin, async (req, res) => {
  const r = await license.activate(req.body?.key || '')
  auth.audit(req, 'license.activate', '', r.ok ? r.status : r.error)
  r.ok ? ok(res, { status: r.status }) : bad(res, r.error)
})
app.post('/api/license/refresh', auth.requireSuperAdmin, async (req, res) => {
  await license.heartbeat(); ok(res, { license: license.publicStatus() })
})

// ---- audit / security (SUPER ADMIN ONLY) -----------------------------------
// NOTE: session tokens are stripped — never expose the auth cookie value.
const stripTokens = (rows) => rows.map(({ token, ...rest }) => rest)
app.get('/api/audit', auth.requireSuperAdmin, (req, res) => ok(res, {
  audit: store.listAudit(lim(req.query.limit, 500)),
  sessions: stripTokens(store.listAuthSessions(200)),
  active: stripTokens(store.activeAuthSessions()),
  stats: store.auditStats(),
}))

// ---- users (admin / super_admin) -------------------------------------------
app.get('/api/users', auth.requireUserAdmin, (req, res) => ok(res, { users: store.listUsers() })) // super_admin hidden in store
app.post('/api/users', auth.requireUserAdmin, (req, res) => {
  const { username, password, role } = req.body || {}
  if (!username || !password) return bad(res, 'username & password required')
  if (String(password).length < 6) return bad(res, 'password too short (min 6)')
  if (!auth.ROLES.includes(role)) return bad(res, 'invalid role') // blocks super_admin creation
  if (store.getUserByName(username)) return bad(res, 'username already exists')
  const { hash, salt } = auth.hashPassword(String(password))
  store.createUser(String(username).trim(), hash, salt, role)
  auth.audit(req, 'user.create', username, role); ok(res, {})
})
app.delete('/api/users/:id', auth.requireUserAdmin, (req, res) => {
  const target = store.getUserById(Number(req.params.id))
  if (!target) return bad(res, 'no such user')
  if (auth.isSuper(target.role)) return bad(res, 'super admin cannot be removed', 403)
  if (Number(req.params.id) === req.user.id) return bad(res, "can't delete yourself")
  store.deleteUser(Number(req.params.id)); auth.audit(req, 'user.delete', req.params.id); ok(res, {})
})
// admin resets another user's password (cannot target the super_admin)
app.post('/api/users/:id/password', auth.requireUserAdmin, (req, res) => {
  const target = store.getUserById(Number(req.params.id))
  if (!target) return bad(res, 'no such user')
  if (auth.isSuper(target.role)) return bad(res, 'cannot reset the super admin', 403)
  const { next } = req.body || {}
  if (!next || String(next).length < 6) return bad(res, 'password too short (min 6)')
  const { hash, salt } = auth.hashPassword(String(next))
  store.setPassword(target.id, hash, salt); auth.audit(req, 'user.password.reset', target.username); ok(res, {})
})

// ---- session grants (admin / super_admin) ----------------------------------
app.get('/api/grants', auth.requireUserAdmin, (req, res) => ok(res, {
  grants: store.listGrants(),
  users: store.listUsers().filter((u) => u.role === 'manager' || u.role === 'viewer'),
  sessions: manager.list().map((s) => ({ id: s.id, name: s.name })),
}))
app.post('/api/grants', auth.requireUserAdmin, (req, res) => {
  const { user_id, session_id } = req.body || {}
  const target = store.getUserById(Number(user_id))
  if (!target) return bad(res, 'no such user')
  if (auth.isAdminish(target.role)) return bad(res, 'admins already see everything')
  if (!store.getSession(session_id)) return bad(res, 'no such session')
  store.addGrant(Number(user_id), session_id, req.user.username)
  auth.audit(req, 'grant.add', `${target.username}→${session_id}`); ok(res, {})
})
app.delete('/api/grants/:id', auth.requireUserAdmin, (req, res) => {
  store.delGrant(Number(req.params.id)); auth.audit(req, 'grant.del', req.params.id); ok(res, {})
})
app.post('/api/password', (req, res) => {
  const { current, next } = req.body || {}
  const u = store.getUserById(req.user.id)
  if (!u || !auth.verifyPassword(String(current || ''), u.salt, u.pass_hash)) return bad(res, 'current password wrong', 403)
  if (!next || String(next).length < 6) return bad(res, 'new password too short (min 6)')
  const { hash, salt } = auth.hashPassword(String(next))
  store.setPassword(u.id, hash, salt); auth.audit(req, 'password.change'); ok(res, {})
})

// ---- export ----------------------------------------------------------------
app.get('/api/export/:id', auth.requireSessionAccess, (req, res) => {
  const sid = req.params.id, jid = req.query.jid, fmt = req.query.fmt || 'txt'
  auth.audit(req, 'export', jid || 'ALL', fmt)
  const msgs = jid ? store.chatMessages(sid, jid, 100000) : store.searchMessages('', 100000)
  if (fmt === 'json') {
    res.setHeader('Content-Disposition', 'attachment; filename="sonar-export.json"')
    return res.json(msgs)
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="sonar-export.txt"')
  const lines = msgs.map((m) => {
    const t = new Date(m.ts).toLocaleString(cfg.LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
    return `${t}  ${m.sender_name}: ${m.text}`
  })
  res.send(lines.join('\n'))
})

app.get('/api/logs', (req, res) => {
  try {
    const files = fs.readdirSync(cfg.LOG_DIR).filter((f) => f.endsWith('.txt'))
      .map((f) => ({ name: f, size: fs.statSync(path.join(cfg.LOG_DIR, f)).size }))
    ok(res, { files })
  } catch { ok(res, { files: [] }) }
})

// ---- global error handler: never leak stack traces / filesystem paths ------
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  const code = err.status || err.statusCode || 400
  res.status(code).json({ ok: false, error: code === 413 ? 'payload too large' : 'bad request' })
})

// ---- socket.io (authenticated) --------------------------------------------
io.use((socket, next) => {
  const raw = socket.handshake.headers.cookie || ''
  let token = null
  for (const part of raw.split(';')) { const [k, ...v] = part.trim().split('='); if (k === auth.TOKEN_COOKIE) token = decodeURIComponent(v.join('=')) }
  if (token && store.getAuthSession(token)) return next()
  next(new Error('unauthorized'))
})
io.on('connection', (socket) => {
  socket.emit('state', { sessions: manager.list(), stats: store.stats() })
})

// ---- boot ------------------------------------------------------------------
auth.ensureBootstrapAdmin()
license.init(manager) // sets the license hold before any session starts
server.listen(cfg.PORT, () => {
  console.log(`\n  ⬡  Sonar running →  http://localhost:${cfg.PORT}`)
  console.log(`      licensing: ${license.enabled() ? cfg.LICENSE.serverUrl + ' (status: ' + license.status + ')' : 'disabled (dev mode)'}\n`)
  manager.restoreAll()
  // Retention sweep: purge DB rows older than RETAIN_DAYS (the .txt archive
  // keeps everything). Run on boot, then once a day.
  const sweep = () => {
    try {
      const n = store.cleanupOld(cfg.RETAIN_DAYS)
      if (n) console.log(`  retention: purged ${n} message(s) older than ${cfg.RETAIN_DAYS} days (kept in .txt)`)
    } catch (e) { console.error('retention sweep failed:', e?.message || e) }
  }
  sweep()
  setInterval(sweep, 24 * 3600 * 1000)
})

process.on('uncaughtException', (e) => console.error('[uncaught]', e?.message || e))
process.on('unhandledRejection', (e) => console.error('[unhandled]', e?.message || e))

module.exports = { app, server, manager }

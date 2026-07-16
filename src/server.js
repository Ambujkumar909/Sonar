// =============================================================
//  Sonar — HTTP + WebSocket server (REST API + live dashboard)
//  Postgres-backed. Every /api route requires a valid session;
//  every meaningful action is written to the audit trail.
// =============================================================
try { require('bytenode') } catch {} // .jsc loader for bytecode-compiled modules (prod)

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
const report = require('./report')
const chatExport = require('./chatExport')
const scheduler = require('./scheduler')
const mailer = require('./mailer')
const SessionManager = require('./sessionManager')

const app = express()
const server = http.createServer(app)
const io = new Server(server) // same-origin only

app.disable('x-powered-by')
app.set('trust proxy', 1) // trust ONE proxy hop (nginx/compose) — correct client IP without rate-limit bypass
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      objectSrc: ["'none'"], baseUri: ["'self'"], frameAncestors: ["'self'"], formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}))
app.use(express.json({ limit: '1mb' }))
app.use(express.static(path.join(cfg.ROOT, 'public')))

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Too many login attempts — try again in a few minutes' } })
const createLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Creating sessions too fast — slow down' } })
const lim = (v, def = 300) => { const n = Number(v); return Math.min(Number.isFinite(n) && n > 0 ? n : def, cfg.MAX_QUERY_LIMIT) }

const manager = new SessionManager((event, payload) => io.emit(event, payload))

const ok = (res, data) => res.json({ ok: true, ...data })
const bad = (res, msg, code = 400) => res.status(code).json({ ok: false, error: msg })
// Report documents are self-contained (inline CSS + inline Chart.js). We scope a
// permissive CSP to THESE responses only so the inline chart scripts run in the
// iframe; the app's own global CSP (script-src 'self') stays strict.
const sendReportHtml = (res, html) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:")
  res.type('html').send(html)
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next) // async route guard

// ============================================================================
//  PUBLIC auth routes
// ============================================================================
app.post('/api/login', loginLimiter, wrap(async (req, res) => {
  const { username, password } = req.body || {}
  const pw = String(password || '')
  if (pw.length > auth.MAX_PASSWORD_LEN) return bad(res, 'Invalid username or password', 401) // reject oversized before any hashing
  const user = username && await store.getUserByName(String(username).trim())
  if (!user || !(await auth.verifyPassword(pw, user.salt, user.pass_hash))) {
    store.logAudit({ user_id: null, username: username || '?', action: 'login.fail', target: '', detail: '', ip: auth.ipOf(req), ts: Date.now() })
    return bad(res, 'Invalid username or password', 401)
  }
  const token = auth.newToken()
  await store.createAuthSession({ token, user_id: user.id, username: user.username, ip: auth.ipOf(req), ua: req.headers['user-agent'] || '', login_at: Date.now(), last_seen: Date.now() })
  store.setLastLogin(user.id)
  store.logAudit({ user_id: user.id, username: user.username, action: 'login', target: '', detail: '', ip: auth.ipOf(req), ts: Date.now() })
  auth.setAuthCookie(res, token, req.secure) // Secure flag when behind HTTPS
  ok(res, { user: { id: user.id, username: user.username, role: user.role } })
}))

app.post('/api/logout', wrap(async (req, res) => {
  const u = await auth.currentUser(req)
  if (u) { store.closeAuthSession(u.token); req.user = u; auth.audit(req, 'logout') }
  auth.clearAuthCookie(res)
  ok(res, {})
}))

app.get('/api/me', wrap(async (req, res) => {
  const u = await auth.currentUser(req)
  if (!u) return bad(res, 'not authenticated', 401)
  const full = await store.getUserById(u.id)
  ok(res, { user: { id: u.id, username: u.username, role: full?.role || 'admin', login_at: u.login_at } })
}))

// ============================================================================
//  EVERYTHING BELOW REQUIRES AUTH
// ============================================================================
app.use('/api', auth.requireAuth)
app.use('/logs', auth.requireAuth, express.static(cfg.LOG_DIR))

// RLS helpers
async function scoped(req) {
  const list = await manager.list(); const out = []
  for (const s of list) if (await store.canAccessSession(req.user, s.id)) out.push(s)
  return out
}
const idsFor = async (req) => auth.isAdminish(req.user.role) ? undefined : await store.ownedSessionIds(req.user)

app.get('/api/state', wrap(async (req, res) => ok(res, { sessions: await scoped(req), stats: await store.stats(await idsFor(req)) })))

// ---- sessions --------------------------------------------------------------
app.post('/api/sessions', auth.requireUserAdmin, createLimiter, wrap(async (req, res) => {
  const total = (await store.allSessions()).length
  if (total >= cfg.MAX_SESSIONS) return bad(res, `Session limit reached (${cfg.MAX_SESSIONS}). Delete unused sessions first.`)
  const name = String(req.body?.name || '').trim().slice(0, 60) || ('Device ' + (total + 1))
  const id = await manager.createSession(req.body.id, name, req.user.id)
  auth.audit(req, 'session.create', id, name)
  ok(res, { id })
}))

const sessGuard = [auth.requireWrite, auth.requireSessionAccess]
app.delete('/api/sessions/:id', auth.requireUserAdmin, wrap(async (req, res) => {
  if (!(await store.getSession(req.params.id))) return bad(res, 'no such session', 404)
  auth.audit(req, 'session.delete', req.params.id)
  await manager.deleteSession(req.params.id); ok(res, {})
}))
app.get('/api/sessions/:id/qr', auth.requireSessionAccess, (req, res) => ok(res, { qr: manager.getQr(req.params.id) }))
app.post('/api/sessions/:id/restart', sessGuard, (req, res) => { auth.audit(req, 'session.restart', req.params.id); manager.forceRestart(req.params.id); ok(res, {}) })
app.post('/api/sessions/:id/stop', sessGuard, (req, res) => { auth.audit(req, 'session.stop', req.params.id); manager.stopSession(req.params.id); ok(res, {}) })
app.post('/api/sessions/:id/resume', sessGuard, (req, res) => { auth.audit(req, 'session.resume', req.params.id); manager.resumeSession(req.params.id); ok(res, {}) })
app.post('/api/sessions/:id/logout', sessGuard, wrap(async (req, res) => {
  auth.audit(req, 'session.newqr', req.params.id)
  await manager.logout(req.params.id); manager.forceRestart(req.params.id); ok(res, {})
}))
app.post('/api/sessions/:id/watchall', auth.requireSuperAdmin, auth.requireSessionAccess, wrap(async (req, res) => {
  auth.audit(req, 'session.watchall', req.params.id, String(!!req.body.value))
  await store.setWatchAll(req.params.id, !!req.body.value); ok(res, {})
}))

// ---- chats / messages ------------------------------------------------------
app.get('/api/sessions/:id/chats', auth.requireSessionAccess, wrap(async (req, res) => {
  const sid = req.params.id
  const sess = await store.getSession(sid)
  let chats = await store.allChats(sid, lim(req.query.limit, 600))
  if (!(sess && sess.watch_all)) {
    const w = await store.listWatch(sid)
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
}))
app.get('/api/sessions/:id/logs', auth.requireSessionAccess, wrap(async (req, res) =>
  ok(res, { chats: await store.allChats(req.params.id, lim(req.query.limit, 2000)) })))
app.delete('/api/sessions/:id/chatlog', auth.requireUserAdmin, auth.requireSessionAccess, wrap(async (req, res) => {
  const jid = req.query.jid
  if (!jid) return bad(res, 'jid required')
  const name = await store.deleteChatLog(req.params.id, jid)
  if (name) { try { fs.rmSync(path.join(cfg.LOG_DIR, textlog.safeFileName(name)), { force: true }) } catch {} }
  auth.audit(req, 'log.delete', jid, name || '')
  ok(res, {})
}))
app.get('/api/sessions/:id/messages', auth.requireSessionAccess, wrap(async (req, res) => {
  if (!req.query.jid) return bad(res, 'jid required')
  ok(res, { messages: await store.chatMessages(req.params.id, req.query.jid, lim(req.query.limit, 300)) })
}))
app.get('/api/sessions/:id/groups', auth.requireSessionAccess, wrap(async (req, res) => ok(res, { groups: await store.listGroups(req.params.id) })))
// Live group list (queries WhatsApp for all participating groups — read-only).
app.get('/api/sessions/:id/groups/live', auth.requireSessionAccess, wrap(async (req, res) => {
  try { ok(res, { groups: await manager.listLiveGroups(req.params.id) }) }
  catch (e) {
    if (e.code === 'NOT_CONNECTED') return bad(res, 'Session not connected — link & scan the QR first', 409)
    return bad(res, 'Could not fetch groups — try again in a moment', 502)
  }
}))
app.get('/api/sessions/:id/contacts', auth.requireSessionAccess, wrap(async (req, res) => ok(res, { contacts: await store.listContacts(req.params.id, lim(req.query.limit, 2000)) })))
app.get('/api/search', wrap(async (req, res) => {
  if ((req.query.q || '').length >= 2) auth.audit(req, 'search', req.query.q)
  // RLS: managers/viewers only search within sessions granted to them
  ok(res, { messages: await store.searchMessages(req.query.q || '', lim(req.query.limit, 300), await idsFor(req)) })
}))

// ---- watchlist & keywords --------------------------------------------------
app.get('/api/watch', wrap(async (req, res) => {
  const sid = req.query.sid
  if (sid) {
    if (!(await store.canAccessSession(req.user, sid))) return bad(res, 'no access to this session', 403)
    return ok(res, { watch: await store.listWatch(sid) })
  }
  if (auth.isAdminish(req.user.role)) return ok(res, { watch: await store.listWatch() })
  ok(res, { watch: await store.listWatchScoped(await store.ownedSessionIds(req.user)) })
}))
app.post('/api/watch', auth.requireWrite, wrap(async (req, res) => {
  let { sid, kind, value, label } = req.body || {}
  if (!sid || !kind || !value) return bad(res, 'sid, kind, value required')
  if (!['group', 'number'].includes(kind)) return bad(res, "kind must be 'group' or 'number'")
  if (!(await store.getSession(sid))) return bad(res, 'no such session', 404) // no orphan watch rows
  if (!(await store.canAccessSession(req.user, sid))) return bad(res, 'no access to this session', 403)
  value = String(value).trim()
  if (kind === 'number') {
    if (/[a-z]/i.test(value)) return bad(res, 'phone number must be digits only (e.g. 919812345678)')
    value = value.replace(/[^0-9]/g, '')
    if (value.length < 7) return bad(res, 'phone number too short')
  } else { value = value.slice(0, 100) }
  if (!value) return bad(res, 'value required')
  await store.addWatch(sid, kind, value, String(label || value).trim().slice(0, 100)); auth.audit(req, 'watch.add', `${kind}:${value}`); ok(res, {})
}))
app.delete('/api/watch/:id', auth.requireWrite, wrap(async (req, res) => {
  const w = await store.getWatch(Number(req.params.id))
  if (!w) return bad(res, 'not found', 404)
  if (!(await store.canAccessSession(req.user, w.session_id))) return bad(res, 'no access to this session', 403)
  await store.delWatch(Number(req.params.id)); auth.audit(req, 'watch.del', req.params.id); ok(res, {})
}))

// ---- pending new-group alerts (admin only) --------------------------------
app.get('/api/pending-groups', auth.requireUserAdmin, wrap(async (req, res) => ok(res, { groups: await store.listPendingGroups() })))
app.delete('/api/pending-groups', auth.requireUserAdmin, wrap(async (req, res) => {
  const { sid, jid } = req.query
  if (!sid || !jid) return bad(res, 'sid and jid required')
  await store.delPendingGroup(sid, jid); auth.audit(req, 'group.pending.dismiss', `${sid}:${jid}`); ok(res, {})
}))

app.get('/api/keywords', wrap(async (req, res) => ok(res, { keywords: await store.listKeywords() })))
app.post('/api/keywords', auth.requireWrite, wrap(async (req, res) => {
  const word = (typeof req.body?.word === 'string' ? req.body.word : '').trim().slice(0, 100)
  if (!word) return bad(res, 'word required (text)')
  const existing = await store.listKeywords()
  if (existing.some((k) => k.word.toLowerCase() === word.toLowerCase())) return ok(res, {}) // idempotent — no duplicates
  await store.addKeyword(word); auth.audit(req, 'keyword.add', word); ok(res, {})
}))
app.delete('/api/keywords/:id', auth.requireWrite, wrap(async (req, res) => { await store.delKeyword(Number(req.params.id)); auth.audit(req, 'keyword.del', req.params.id); ok(res, {}) }))

// ---- report ----------------------------------------------------------------
// Renders the WhatsApp activity report (scoped to the caller's sessions).
// ?download=1 forces a file download; otherwise it's served inline for viewing.
const reportDays = (v) => { if (v == null || v === 'all') return null; const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 1 && n <= 90 ? n : null }
app.get('/api/report', wrap(async (req, res) => {
  const ids = await idsFor(req)
  const ai = !!req.query.ai && auth.isAdminish(req.user.role) // AI pass is admin-only (it costs per run)
  const { html } = await report.generateReport({ ids, days: reportDays(req.query.days), ai })
  if (ai) auth.audit(req, 'report.ai')
  if (req.query.download) {
    const fn = `whatsapp-report-${new Date().toISOString().slice(0, 10)}.html`
    res.setHeader('Content-Disposition', `attachment; filename="${fn}"`)
    auth.audit(req, 'report.download')
  }
  sendReportHtml(res, html)
}))

// ---- raw chat data export (for offline analysis in Claude Code — no API) ----
app.get('/api/report/chats', wrap(async (req, res) => {
  const ids = await idsFor(req)
  const { text } = await chatExport.buildTranscript({ ids, days: reportDays(req.query.days) })
  const body = text || 'No messages in the selected window.'
  if (req.query.download) {
    res.setHeader('Content-Disposition', `attachment; filename="whatsapp-chats-${new Date().toISOString().slice(0, 10)}.txt"`)
    auth.audit(req, 'chats.download')
  }
  res.type('text/plain; charset=utf-8').send(body)
}))

// ---- saved AI reports (generate once, store, reuse — no repeat API spend) ----
// Generate an AI report and STORE it. Admin-only (it spends API tokens).
app.post('/api/reports', auth.requireUserAdmin, wrap(async (req, res) => {
  const ids = await idsFor(req)
  const days = reportDays(req.query.days)
  const { html, stats } = await report.generateReport({ ids, days, ai: true })
  const id = await store.saveReport({ created_by: req.user.username, window_days: days || 0, msg_count: stats.messages, chat_count: stats.chats, html })
  auth.audit(req, 'report.ai.generate', String(id))
  ok(res, { id })
}))
app.get('/api/reports', auth.requireUserAdmin, wrap(async (req, res) => ok(res, { reports: await store.listReports() })))
app.get('/api/reports/:id', auth.requireUserAdmin, wrap(async (req, res) => {
  const r = await store.getReport(Number(req.params.id))
  if (!r) return res.status(404).type('html').send('<p>Report not found.</p>')
  if (req.query.download) {
    res.setHeader('Content-Disposition', `attachment; filename="whatsapp-report-${new Date(Number(r.created_at)).toISOString().slice(0, 10)}.html"`)
    auth.audit(req, 'report.download', String(r.id))
  }
  sendReportHtml(res, r.html)
}))
app.delete('/api/reports/:id', auth.requireUserAdmin, wrap(async (req, res) => { await store.deleteReport(Number(req.params.id)); auth.audit(req, 'report.delete', req.params.id); ok(res, {}) }))

// ---- report email recipients + scheduler (admin-only) ----------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
app.get('/api/report-emails', auth.requireUserAdmin, wrap(async (req, res) =>
  ok(res, { emails: await store.listReportEmails(), schedule: scheduler.status() })))
app.post('/api/report-emails', auth.requireUserAdmin, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase()
  const label = String(req.body.label || '').trim().slice(0, 120)
  if (!EMAIL_RE.test(email)) return bad(res, 'Enter a valid email address')
  const id = await store.addReportEmail(email, label, req.user.username)
  auth.audit(req, 'report_email.add', email)
  ok(res, { id })
}))
app.post('/api/report-emails/:id/toggle', auth.requireUserAdmin, wrap(async (req, res) => {
  await store.setReportEmailEnabled(Number(req.params.id), !!req.body.enabled)
  auth.audit(req, 'report_email.toggle', `${req.params.id}=${req.body.enabled ? 'on' : 'off'}`)
  ok(res, {})
}))
app.delete('/api/report-emails/:id', auth.requireUserAdmin, wrap(async (req, res) => {
  await store.deleteReportEmail(Number(req.params.id)); auth.audit(req, 'report_email.delete', req.params.id); ok(res, {})
}))
// Run the daily report now (generate + save + email) — for testing the pipeline.
app.post('/api/report-emails/run-now', auth.requireUserAdmin, wrap(async (req, res) => {
  auth.audit(req, 'report.run_now')
  const r = await scheduler.runDaily({ by: req.user.username + ' (manual)' })
  ok(res, r)
}))
// Send a fully-populated SAMPLE report — to test email delivery + formatting.
// Optional body.to sends to one address; otherwise to all enabled recipients.
app.post('/api/report-emails/send-test', auth.requireUserAdmin, wrap(async (req, res) => {
  if (!mailer.isConfigured()) return bad(res, 'SMTP is not configured — set EMAIL_HOST/EMAIL_USER/EMAIL_PASS in .env', 400)
  const one = String(req.body.to || '').trim().toLowerCase()
  let to
  if (one) { if (!EMAIL_RE.test(one)) return bad(res, 'Enter a valid test email'); to = [one] }
  else { to = (await store.listEnabledReportEmails()).map((r) => r.email); if (!to.length) return bad(res, 'No enabled recipients — add one, or type a test address') }
  const sample = require('./sampleReport').build()
  auth.audit(req, 'report.send_test', to.join(','))
  try {
    await mailer.sendReport({
      to, subject: "D'Decor — Customer Chat Review (SAMPLE / test email)",
      bodyHtml: `<div style="font-family:'Segoe UI',Arial,sans-serif"><p>This is a <b>sample test email</b> from Sonar to confirm delivery and formatting. The full sample report (with charts) is attached — open it in a browser.</p></div>`,
      attachmentHtml: sample.html, filename: 'sample-customer-chat-review.html',
    })
    ok(res, { emailed: to.length, to })
  } catch (e) { bad(res, 'Send failed: ' + e.message, 502) }
}))
// Verify SMTP connectivity without sending.
app.get('/api/report-emails/smtp-check', auth.requireUserAdmin, wrap(async (req, res) => {
  if (!mailer.isConfigured()) return ok(res, { configured: false })
  try { await mailer.verify(); ok(res, { configured: true, ok: true }) }
  catch (e) { ok(res, { configured: true, ok: false, error: e.message }) }
}))

// ---- report SCHEDULE (DB-configurable; admin/super) ------------------------
app.get('/api/schedule', auth.requireUserAdmin, wrap(async (req, res) =>
  ok(res, { config: scheduler.getConfig(), status: scheduler.status() })))
app.post('/api/schedule', auth.requireUserAdmin, wrap(async (req, res) => {
  const b = req.body || {}
  const patch = {}
  if (typeof b.enabled === 'boolean') patch.enabled = b.enabled
  if (Array.isArray(b.times)) patch.times = b.times
  if (b.intervalDays != null) patch.intervalDays = Number(b.intervalDays)
  if (b.windowDays != null) patch.windowDays = Number(b.windowDays)
  if (typeof b.tz === 'string' && b.tz.trim()) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: b.tz.trim() }); patch.tz = b.tz.trim() }
    catch { return bad(res, 'Invalid timezone') }
  }
  if (Array.isArray(patch.times) && patch.times.length === 0) return bad(res, 'Add at least one run time (HH:MM)')
  const cfg2 = await scheduler.save(patch, req.user.username)
  auth.audit(req, 'schedule.update', '', JSON.stringify(scheduler.getConfig()))
  ok(res, { config: scheduler.getConfig(), status: scheduler.status() })
}))

// ---- analytics & events ----------------------------------------------------
app.get('/api/stats', wrap(async (req, res) => ok(res, { stats: await store.stats(await idsFor(req)) })))
app.get('/api/analytics', wrap(async (req, res) => {
  const ids = await idsFor(req)
  const [hourly, topChats, stats] = await Promise.all([store.hourly(ids), store.topChats(10, ids), store.stats(ids)])
  ok(res, { hourly, topChats, stats })
}))
app.get('/api/events', wrap(async (req, res) => ok(res, { events: await store.recentEvents(lim(req.query.limit, 300)) })))

// ---- license ---------------------------------------------------------------
app.get('/api/license/status', (req, res) => {
  const l = license.publicStatus()
  // managers/viewers see only the banner essentials — not host/fingerprint
  if (!auth.isAdminish(req.user.role)) { delete l.machine; delete l.fingerprint }
  ok(res, { license: l })
})
app.post('/api/license/activate', auth.requireUserAdmin, wrap(async (req, res) => {
  const r = await license.activate(req.body?.key || '')
  auth.audit(req, 'license.activate', '', r.ok ? r.status : r.error)
  r.ok ? ok(res, { status: r.status }) : bad(res, r.error)
}))
app.post('/api/license/refresh', auth.requireUserAdmin, wrap(async (req, res) => { await license.heartbeat(); ok(res, { license: license.publicStatus() }) }))

// ---- audit (SUPER ADMIN ONLY) ----------------------------------------------
const stripTokens = (rows) => rows.map(({ token, ...rest }) => rest)
app.get('/api/audit', auth.requireSuperAdmin, wrap(async (req, res) => ok(res, {
  audit: await store.listAudit(lim(req.query.limit, 500)),
  sessions: stripTokens(await store.listAuthSessions(200)),
  active: stripTokens(await store.activeAuthSessions()),
  stats: await store.auditStats(),
})))

// ---- users (admin / super_admin) -------------------------------------------
app.get('/api/users', auth.requireUserAdmin, wrap(async (req, res) => ok(res, { users: await store.listUsers() })))
app.post('/api/users', auth.requireUserAdmin, wrap(async (req, res) => {
  const { username, password, role } = req.body || {}
  if (!username || !password) return bad(res, 'username & password required')
  const uname = String(username).trim().slice(0, 64)
  if (!uname) return bad(res, 'username required')
  if (String(password).length < 6 || String(password).length > auth.MAX_PASSWORD_LEN) return bad(res, `password must be 6–${auth.MAX_PASSWORD_LEN} characters`)
  if (!auth.ROLES.includes(role)) return bad(res, 'invalid role')
  if (await store.getUserByName(uname)) return bad(res, 'username already exists')
  const { hash, salt } = await auth.hashPassword(String(password))
  await store.createUser(uname, hash, salt, role)
  auth.audit(req, 'user.create', uname, role); ok(res, {})
}))
app.delete('/api/users/:id', auth.requireUserAdmin, wrap(async (req, res) => {
  const target = await store.getUserById(Number(req.params.id))
  if (!target) return bad(res, 'no such user')
  if (auth.isSuper(target.role)) return bad(res, 'super admin cannot be removed', 403)
  if (Number(req.params.id) === req.user.id) return bad(res, "can't delete yourself")
  await store.deleteUser(Number(req.params.id)); auth.audit(req, 'user.delete', req.params.id); ok(res, {})
}))
app.post('/api/users/:id/password', auth.requireUserAdmin, wrap(async (req, res) => {
  const target = await store.getUserById(Number(req.params.id))
  if (!target) return bad(res, 'no such user')
  if (auth.isSuper(target.role)) return bad(res, 'cannot reset the super admin', 403)
  const { next } = req.body || {}
  if (!next || String(next).length < 6 || String(next).length > auth.MAX_PASSWORD_LEN) return bad(res, `password must be 6–${auth.MAX_PASSWORD_LEN} characters`)
  const { hash, salt } = await auth.hashPassword(String(next))
  await store.setPassword(target.id, hash, salt); auth.audit(req, 'user.password.reset', target.username); ok(res, {})
}))

// ---- session grants --------------------------------------------------------
app.get('/api/grants', auth.requireUserAdmin, wrap(async (req, res) => ok(res, {
  grants: await store.listGrants(),
  users: (await store.listUsers()).filter((u) => u.role === 'manager' || u.role === 'viewer'),
  sessions: (await manager.list()).map((s) => ({ id: s.id, name: s.name })),
})))
app.post('/api/grants', auth.requireUserAdmin, wrap(async (req, res) => {
  const { user_id, session_id } = req.body || {}
  const target = await store.getUserById(Number(user_id))
  if (!target) return bad(res, 'no such user')
  if (auth.isAdminish(target.role)) return bad(res, 'admins already see everything')
  if (!(await store.getSession(session_id))) return bad(res, 'no such session')
  await store.addGrant(Number(user_id), session_id, req.user.username)
  auth.audit(req, 'grant.add', `${target.username}→${session_id}`); ok(res, {})
}))
app.delete('/api/grants/:id', auth.requireUserAdmin, wrap(async (req, res) => { await store.delGrant(Number(req.params.id)); auth.audit(req, 'grant.del', req.params.id); ok(res, {}) }))
app.post('/api/password', wrap(async (req, res) => {
  const { current, next } = req.body || {}
  const u = await store.getUserById(req.user.id)
  if (!u || !(await auth.verifyPassword(String(current || ''), u.salt, u.pass_hash))) return bad(res, 'current password wrong', 403)
  if (!next || String(next).length < 6 || String(next).length > auth.MAX_PASSWORD_LEN) return bad(res, `new password must be 6–${auth.MAX_PASSWORD_LEN} characters`)
  const { hash, salt } = await auth.hashPassword(String(next))
  await store.setPassword(u.id, hash, salt); auth.audit(req, 'password.change'); ok(res, {})
}))

// ---- export ----------------------------------------------------------------
app.get('/api/export/:id', auth.requireSessionAccess, wrap(async (req, res) => {
  const sid = req.params.id, jid = req.query.jid, fmt = req.query.fmt || 'txt'
  if (!jid) return bad(res, 'jid required') // no global export — stay scoped to this chat
  auth.audit(req, 'export', jid, fmt)
  const msgs = await store.chatMessages(sid, jid, 100000)
  if (fmt === 'json') { res.setHeader('Content-Disposition', 'attachment; filename="sonar-export.json"'); return res.json(msgs) }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="sonar-export.txt"')
  const lines = msgs.map((m) => {
    const t = new Date(m.ts).toLocaleString(cfg.LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
    return `${t}  ${m.sender_name}: ${m.text}`
  })
  res.send(lines.join('\n'))
}))

app.get('/api/logs', (req, res) => {
  try {
    const files = fs.readdirSync(cfg.LOG_DIR).filter((f) => f.endsWith('.txt')).map((f) => ({ name: f, size: fs.statSync(path.join(cfg.LOG_DIR, f)).size }))
    ok(res, { files })
  } catch { ok(res, { files: [] }) }
})

// unmatched API routes → clean JSON 404 (not Express's default HTML)
app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'not found' }))

// ---- global error handler: never leak stack traces / paths -----------------
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  const code = err.status || err.statusCode || 400
  res.status(code).json({ ok: false, error: code === 413 ? 'payload too large' : 'request error' })
})

// ---- socket.io (authenticated) --------------------------------------------
io.use(async (socket, next) => {
  try {
    const raw = socket.handshake.headers.cookie || ''
    let token = null
    for (const part of raw.split(';')) { const [k, ...v] = part.trim().split('='); if (k === auth.TOKEN_COOKIE) token = decodeURIComponent(v.join('=')) }
    if (token && await store.getAuthSession(token)) return next()
    next(new Error('unauthorized'))
  } catch (e) { next(new Error('unauthorized')) }
})
io.on('connection', async (socket) => {
  try { socket.emit('state', { sessions: await manager.list(), stats: await store.stats() }) } catch {}
})

// ---- boot ------------------------------------------------------------------
;(async () => {
  // wait for Postgres to be reachable, then create the schema
  for (let i = 1; ; i++) {
    try { await store.init(); break }
    catch (e) {
      if (i >= 30) { console.error('Cannot reach Postgres:', e.message); process.exit(1) }
      if (i === 1) console.log('  waiting for Postgres…')
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  await auth.ensureBootstrapAdmin()
  await license.init(manager) // dormant unless licensing configured
  server.listen(cfg.PORT, () => {
    console.log(`\n  ⬡  Sonar running →  http://localhost:${cfg.PORT}`)
    console.log(`      database: Postgres · licensing: ${license.enabled() ? 'on (' + license.status + ')' : 'disabled (dev)'}\n`)
    manager.restoreAll().catch((e) => console.error('restore error:', e?.message || e))
    const sweep = async () => {
      try { const n = await store.cleanupOld(cfg.RETAIN_DAYS); if (n) console.log(`  retention: purged ${n} message(s) > ${cfg.RETAIN_DAYS}d (kept in .txt)`) }
      catch (e) { console.error('retention sweep failed:', e?.message || e) }
    }
    sweep(); setInterval(sweep, 24 * 3600 * 1000)
    scheduler.start().catch((e) => console.error('scheduler start failed:', e?.message || e)) // DB-configurable report schedule
  })
})().catch((e) => { console.error('BOOT FAILED:', e); process.exit(1) })

process.on('uncaughtException', (e) => console.error('[uncaught]', e?.message || e))
process.on('unhandledRejection', (e) => console.error('[unhandled]', e?.message || e))

module.exports = { app, server, manager }

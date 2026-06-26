// =============================================================
//  Sonar License Server
//  - Issues Ed25519-signed, machine-bound, time-limited licenses
//  - Activation + heartbeat (instant revoke, clock-tamper via serverTime)
//  - Admin API + UI: create / list / extend / revoke / migrate
//  Run from the project root:  npm run license-server
// =============================================================
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const express = require('express')
const Database = require('better-sqlite3')

const ROOT = __dirname
const PORT = Number(process.env.LICENSE_PORT) || 5005
const DB_FILE = process.env.LICENSE_DB_FILE || path.join(ROOT, 'data', 'licenses.db')
const PRIVATE_KEY = crypto.createPrivateKey(fs.readFileSync(path.join(ROOT, 'keys', 'private.pem')))

// Admin key — protects all /api/admin routes. Set LICENSE_ADMIN_KEY in prod.
const ADMIN_KEY = process.env.LICENSE_ADMIN_KEY || 'sonar-admin-change-me'

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true })
const db = new Database(DB_FILE)
db.pragma('journal_mode = WAL')
db.exec(`
CREATE TABLE IF NOT EXISTS licenses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key           TEXT UNIQUE NOT NULL,
  customer      TEXT,
  plan          TEXT,
  note          TEXT,
  created_at    INTEGER,
  expires_at    INTEGER,
  fingerprint   TEXT,            -- bound machine (null until activated)
  fp_info       TEXT,            -- hostname/platform for admin display
  activated_at  INTEGER,
  last_seen     INTEGER,
  revoked       INTEGER DEFAULT 0
);`)

// ---- helpers ---------------------------------------------------------------
const now = () => Date.now()
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function signToken(payloadObj) {
  const payload = b64url(JSON.stringify(payloadObj))
  const sig = crypto.sign(null, Buffer.from(payload), PRIVATE_KEY)
  return payload + '.' + b64url(sig)
}
function genKey() {
  const part = () => crypto.randomBytes(3).toString('hex').toUpperCase()
  return `SONAR-${part()}-${part()}-${part()}-${part()}`
}
function statusOf(lic) {
  if (lic.revoked) return 'revoked'
  if (lic.expires_at && lic.expires_at < now()) return 'expired'
  return lic.activated_at ? 'active' : 'inactive'
}
function tokenFor(lic, fingerprint) {
  return signToken({
    licenseId: lic.id, key: lic.key, customer: lic.customer || '', plan: lic.plan || '',
    issuedAt: now(), expiresAt: lic.expires_at, fingerprint,
    revoked: !!lic.revoked, serverTime: now(),
  })
}

const app = express()
app.use(express.json())
app.use(express.static(path.join(ROOT, 'public')))

const ok = (res, d) => res.json({ ok: true, ...d })
const bad = (res, m, c = 400) => res.status(c).json({ ok: false, error: m })

// ===================== CLIENT API (public) =====================
// Activate: bind this machine to the license, return a signed token.
app.post('/api/activate', (req, res) => {
  const { key, fingerprint, info } = req.body || {}
  if (!key || !fingerprint) return bad(res, 'key and fingerprint required')
  const lic = db.prepare(`SELECT * FROM licenses WHERE key=?`).get(String(key).trim().toUpperCase())
  if (!lic) return bad(res, 'invalid license key', 404)
  if (lic.revoked) return bad(res, 'license revoked', 403)
  if (lic.fingerprint && lic.fingerprint !== fingerprint)
    return bad(res, 'license already bound to another machine — ask support to migrate it', 409)
  // bind on first activation
  if (!lic.fingerprint) {
    db.prepare(`UPDATE licenses SET fingerprint=?, fp_info=?, activated_at=COALESCE(activated_at,?), last_seen=? WHERE id=?`)
      .run(fingerprint, JSON.stringify(info || {}), now(), now(), lic.id)
  } else {
    db.prepare(`UPDATE licenses SET last_seen=? WHERE id=?`).run(now(), lic.id)
  }
  const fresh = db.prepare(`SELECT * FROM licenses WHERE id=?`).get(lic.id)
  ok(res, { token: tokenFor(fresh, fingerprint), status: statusOf(fresh), serverTime: now(), expiresAt: fresh.expires_at })
})

// Heartbeat: refresh token, report status, allow instant revoke.
app.post('/api/heartbeat', (req, res) => {
  const { key, fingerprint } = req.body || {}
  if (!key || !fingerprint) return bad(res, 'key and fingerprint required')
  const lic = db.prepare(`SELECT * FROM licenses WHERE key=?`).get(String(key).trim().toUpperCase())
  if (!lic) return bad(res, 'invalid license key', 404)
  if (lic.fingerprint && lic.fingerprint !== fingerprint) return bad(res, 'machine mismatch', 409)
  db.prepare(`UPDATE licenses SET last_seen=? WHERE id=?`).run(now(), lic.id)
  ok(res, { token: tokenFor(lic, fingerprint), status: statusOf(lic), serverTime: now(), expiresAt: lic.expires_at })
})

// ===================== ADMIN API =====================
function admin(req, res, next) {
  if ((req.headers['x-admin-key'] || req.query.adminKey) !== ADMIN_KEY) return bad(res, 'admin key required', 401)
  next()
}
app.get('/api/admin/licenses', admin, (req, res) => {
  const rows = db.prepare(`SELECT * FROM licenses ORDER BY id DESC`).all()
    .map((l) => ({ ...l, status: statusOf(l), fp_info: safeParse(l.fp_info) }))
  ok(res, { licenses: rows, serverTime: now() })
})
app.post('/api/admin/licenses', admin, (req, res) => {
  const { customer, plan, days, minutes, seconds, note } = req.body || {}
  const ms = (Number(days) || 0) * 86400000 + (Number(minutes) || 0) * 60000 + (Number(seconds) || 0) * 1000
  const span = ms > 0 ? ms : 30 * 86400000 // default 30 days
  const key = genKey()
  db.prepare(`INSERT INTO licenses (key,customer,plan,note,created_at,expires_at) VALUES (?,?,?,?,?,?)`)
    .run(key, customer || '', plan || (Number(days) ? `${days}-day` : 'custom'), note || '', now(), now() + span)
  ok(res, { key })
})
app.post('/api/admin/licenses/:id/extend', admin, (req, res) => {
  const d = Number(req.body?.days) || 30
  const lic = db.prepare(`SELECT * FROM licenses WHERE id=?`).get(req.params.id)
  if (!lic) return bad(res, 'not found', 404)
  const base = Math.max(now(), lic.expires_at || now())
  db.prepare(`UPDATE licenses SET expires_at=?, revoked=0 WHERE id=?`).run(base + d * 86400000, lic.id)
  ok(res, {})
})
app.post('/api/admin/licenses/:id/revoke', admin, (req, res) => {
  db.prepare(`UPDATE licenses SET revoked=? WHERE id=?`).run(req.body?.revoked === false ? 0 : 1, req.params.id)
  ok(res, {})
})
// Migrate: release the machine binding so it can re-activate on a new server.
app.post('/api/admin/licenses/:id/migrate', admin, (req, res) => {
  db.prepare(`UPDATE licenses SET fingerprint=NULL, fp_info=NULL, activated_at=NULL WHERE id=?`).run(req.params.id)
  ok(res, {})
})
app.delete('/api/admin/licenses/:id', admin, (req, res) => {
  db.prepare(`DELETE FROM licenses WHERE id=?`).run(req.params.id); ok(res, {})
})

function safeParse(s) { try { return JSON.parse(s) } catch { return null } }

app.listen(PORT, () => {
  console.log(`\n  🔑  Sonar License Server →  http://localhost:${PORT}`)
  console.log(`      admin key: ${ADMIN_KEY === 'sonar-admin-change-me' ? ADMIN_KEY + '  (set LICENSE_ADMIN_KEY!)' : '(from env)'}\n`)
})

// =============================================================
//  Sonar — authentication & audit
//  - scrypt password hashing (no external deps)
//  - opaque random session tokens stored in SQLite
//  - express middleware: requireAuth, requireAdmin
//  - audit() records every meaningful action with user + IP
// =============================================================
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const store = require('./store')
const cfg = require('./config')

// ---- password hashing ------------------------------------------------------
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return { hash, salt }
}
function verifyPassword(password, salt, expected) {
  const { hash } = hashPassword(password, salt)
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(expected, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
function newToken() { return crypto.randomBytes(32).toString('hex') }

// ---- role model ------------------------------------------------------------
//  super_admin : seeded only · sole audit access · sees all · hidden from UI
//  admin       : all sessions · user & grant management · no audit
//  manager     : only granted sessions · read-write on them
//  viewer      : only granted sessions · read-only
const ROLES = ['admin', 'manager', 'viewer'] // assignable via UI (NOT super_admin)
const ADMINISH = new Set(['super_admin', 'admin'])
const isSuper = (r) => r === 'super_admin'
const isAdminish = (r) => ADMINISH.has(r)
const canWrite = (r) => r !== 'viewer'

// ---- first-run bootstrap: seed the ONE super_admin ------------------------
// Fixed, well-known super_admin seed (can be overridden via env).
const SEED_USER = process.env.SONAR_SUPERADMIN_USER || 'admin@sonar'
const SEED_PASS = process.env.SONAR_SUPERADMIN_PASS || 'Admin@123$'
function ensureBootstrapAdmin() {
  if (store.countUsers() > 0) return
  const { hash, salt } = hashPassword(SEED_PASS)
  store.createUser(SEED_USER, hash, salt, 'super_admin')
  console.log('\n  ╭──────────────────────────────────────────────╮')
  console.log('  │  Sonar SUPER ADMIN seeded                    │')
  console.log(`  │  user: ${SEED_USER.padEnd(38)}│`)
  console.log('  │  pass: (as configured)                       │')
  console.log('  ╰──────────────────────────────────────────────╯\n')
}

// ---- cookie helpers (no cookie-parser dep) --------------------------------
function getCookie(req, name) {
  const raw = req.headers.cookie || ''
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return null
}
const TOKEN_COOKIE = 'sonar_token'
function setAuthCookie(res, token) {
  res.setHeader('Set-Cookie',
    `${TOKEN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 30}`)
}
function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${TOKEN_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`)
}

// ---- request identity ------------------------------------------------------
function ipOf(req) {
  // req.ip respects X-Forwarded-For when 'trust proxy' is on (behind nginx etc.)
  let ip = req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '?'
  if (ip.startsWith('::ffff:')) ip = ip.slice(7) // unwrap IPv4-mapped IPv6
  if (ip === '::1') ip = '127.0.0.1'             // IPv6 localhost → readable
  return ip
}
function currentUser(req) {
  const token = getCookie(req, TOKEN_COOKIE)
  if (!token) return null
  const sess = store.getAuthSession(token)
  if (!sess) return null
  store.touchAuthSession(token)
  return { id: sess.user_id, username: sess.username, token, login_at: sess.login_at }
}

// ---- middleware ------------------------------------------------------------
function requireAuth(req, res, next) {
  const u = currentUser(req)
  if (!u) return res.status(401).json({ ok: false, error: 'auth required' })
  const full = store.getUserById(u.id)
  if (!full) return res.status(401).json({ ok: false, error: 'auth required' })
  req.user = { ...u, role: full.role }      // attach role for RBAC/RLS
  next()
}
// user & grant management — admin or super_admin
function requireUserAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: 'auth required' })
  if (!isAdminish(req.user.role)) return res.status(403).json({ ok: false, error: 'admin only' })
  next()
}
// audit trail — super_admin ONLY
function requireSuperAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: 'auth required' })
  if (!isSuper(req.user.role)) return res.status(403).json({ ok: false, error: 'super admin only' })
  next()
}
// RBAC: block any state-changing action for read-only (viewer) accounts.
function requireWrite(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: 'auth required' })
  if (!canWrite(req.user.role)) return res.status(403).json({ ok: false, error: 'read-only account' })
  next()
}
// RLS: a non-admin may only touch sessions they own; unknown id → 404.
function requireSessionAccess(req, res, next) {
  const id = req.params.id
  if (!store.getSession(id)) return res.status(404).json({ ok: false, error: 'no such session' })
  if (!store.canAccessSession(req.user, id)) return res.status(403).json({ ok: false, error: 'no access to this session' })
  next()
}

// ---- audit -----------------------------------------------------------------
function audit(req, action, target = '', detail = '') {
  const u = req.user || currentUser(req) || {}
  store.logAudit({
    user_id: u.id || null, username: u.username || 'anonymous',
    action, target, detail, ip: ipOf(req), ts: Date.now(),
  })
}

module.exports = {
  hashPassword, verifyPassword, newToken, ensureBootstrapAdmin,
  getCookie, setAuthCookie, clearAuthCookie, ipOf, currentUser,
  requireAuth, requireUserAdmin, requireSuperAdmin, requireWrite, requireSessionAccess,
  audit, TOKEN_COOKIE, ROLES, isSuper, isAdminish, canWrite,
}

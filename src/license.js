// =============================================================
//  Sonar — license client (hardened)
//  - Ed25519 token verification (expiry/fingerprint can't be forged)
//  - Machine-fingerprint binding (verified inside the signed token)
//  - Server-authoritative time + monotonic anti-rollback
//  - Mandatory heartbeat with a grace window (offline is NOT infinite)
//  - Tamper-evident local state (AES-256-GCM, key bound to the machine)
//  - Anti-replay (rejects tokens older than the last seen server time)
//  Enforcement is server-side: when not active, all sessions are held.
// =============================================================
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const cfg = require('./config')

// Embedded license-server PUBLIC key (private key never leaves your server).
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAjHBXja7My87P/Q6IuYPmrDi23XXs6GQz/72LzM4RlMk=
-----END PUBLIC KEY-----`
const PUBLIC_KEY = crypto.createPublicKey(PUBLIC_KEY_PEM)

// App secret folded into the local-state encryption key. (For maximum
// resistance, ship this module compiled to V8 bytecode — see LICENSE.md.)
const APP_SECRET = 'S0nar::v1::4f2a9c7e-licence-binding-secret'

const STATE_FILE = path.join(cfg.DATA_DIR, 'license.bin')
const SKEW = 5 * 60 * 1000 // 5 min clock skew tolerance

const fromB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

// ---- machine fingerprint ---------------------------------------------------
function machineFingerprint() {
  const nics = os.networkInterfaces()
  let mac = ''
  for (const name of Object.keys(nics)) {
    for (const ni of nics[name] || []) {
      if (!ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') { mac = ni.mac; break }
    }
    if (mac) break
  }
  const cpu = (os.cpus()[0] || {}).model || ''
  const raw = [os.hostname(), os.platform(), os.arch(), cpu, os.cpus().length, mac].join('|')
  return crypto.createHash('sha256').update(raw).digest('hex')
}
function machineInfo() {
  return { host: os.hostname(), platform: os.platform(), arch: os.arch(), cpus: os.cpus().length }
}

// ---- tamper-evident local state (AES-256-GCM, key bound to this machine) ---
function stateKey(fp) {
  return crypto.scryptSync(fp + '::' + APP_SECRET, 'sonar-license-salt', 32)
}
function saveState(state, fp) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', stateKey(fp), iv)
  const enc = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  fs.writeFileSync(STATE_FILE, Buffer.concat([iv, tag, enc]))
}
function loadState(fp) {
  try {
    const buf = fs.readFileSync(STATE_FILE)
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28)
    const decipher = crypto.createDecipheriv('aes-256-gcm', stateKey(fp), iv)
    decipher.setAuthTag(tag)
    const dec = Buffer.concat([decipher.update(enc), decipher.final()])
    return JSON.parse(dec.toString('utf8'))
  } catch { return null } // missing OR tampered OR wrong machine → no state
}

// ---- token verification ----------------------------------------------------
function verifyToken(token, fp) {
  if (!token || !token.includes('.')) return null
  const [payloadB64, sigB64] = token.split('.')
  const okSig = crypto.verify(null, Buffer.from(payloadB64), PUBLIC_KEY, fromB64url(sigB64))
  if (!okSig) return null // signature forged/edited
  let p
  try { p = JSON.parse(fromB64url(payloadB64).toString('utf8')) } catch { return null }
  if (p.fingerprint !== fp) return null // bound to a different machine
  return p
}

// ============================================================================
class License {
  constructor() {
    this.fp = machineFingerprint()
    this.manager = null
    this.status = 'unknown'
    this.detail = ''
    this.info = null // { plan, customer, expiresAt, revalidateBy }
    this.lastServerTime = 0
  }

  enabled() { return !!cfg.LICENSE.serverUrl }

  // server-authoritative "now": never let a rewound local clock help
  effNow() { return Math.max(Date.now(), this.lastServerTime) }

  init(manager) {
    this.manager = manager
    if (!this.enabled()) { this.status = 'disabled'; return } // licensing off (dev)
    const st = loadState(this.fp)
    if (st) { this.applyState(st) }
    else { this.status = 'unlicensed'; this.detail = 'No license activated on this machine' }
    this.evaluate()
    // network heartbeat (revalidate + revoke + server time)
    this.heartbeat().catch(() => {})
    clearInterval(this._hb)
    this._hb = setInterval(() => this.heartbeat().catch(() => {}), cfg.LICENSE.heartbeatMin * 60 * 1000)
    // local re-evaluation — catches expiry/grace BETWEEN heartbeats (no network)
    clearInterval(this._eval)
    this._eval = setInterval(() => this.evaluate(), cfg.LICENSE.evalSec * 1000)
  }

  applyState(st) {
    this.key = st.key
    this.token = st.token
    this.lastServerTime = Math.max(this.lastServerTime, st.lastServerTime || 0)
    this._revalidateBy = st.revalidateBy || 0 // restore grace deadline across restarts
    this.info = { plan: st.plan, customer: st.customer, expiresAt: st.expiresAt, revalidateBy: st.revalidateBy }
  }

  // Decide active/inactive from the current (verified) token + clocks.
  evaluate() {
    if (!this.enabled()) { this.status = 'disabled'; return this.apply() }
    if (!this.token) { this.status = this.status === 'tampered' ? 'tampered' : 'unlicensed'; return this.apply() }
    const p = verifyToken(this.token, this.fp)
    if (!p) { this.status = 'invalid'; this.detail = 'License is invalid for this machine'; return this.apply() }
    this.info = { plan: p.plan, customer: p.customer, expiresAt: p.expiresAt, revalidateBy: this._revalidateBy || p.expiresAt }
    const now = this.effNow()
    if (p.revoked) { this.status = 'revoked'; this.detail = 'License has been revoked' }
    else if (p.expiresAt && now > p.expiresAt) { this.status = 'expired'; this.detail = 'License plan has expired' }
    else if (this._revalidateBy && now > this._revalidateBy) { this.status = 'grace_over'; this.detail = 'Could not reach the license server within the allowed offline window' }
    else { this.status = 'active'; this.detail = '' }
    this.apply()
  }

  // push the hold state into the session manager
  apply() {
    const active = this.status === 'active' || this.status === 'disabled'
    if (this.manager) this.manager.setLicenseHeld(!active, this.status)
  }

  async activate(key) {
    if (!this.enabled()) return { ok: false, error: 'licensing is disabled (no server configured)' }
    try {
      const r = await this._post('/api/activate', { key: String(key).trim(), fingerprint: this.fp, info: machineInfo() })
      if (!r.ok) return r
      this._ingest(r, String(key).trim())
      this.evaluate()
      return { ok: true, status: this.status }
    } catch (e) { return { ok: false, error: 'cannot reach license server: ' + (e.message || e) } }
  }

  async heartbeat() {
    if (!this.enabled() || !this.key) { this.evaluate(); return }
    try {
      const r = await this._post('/api/heartbeat', { key: this.key, fingerprint: this.fp })
      if (r.ok) this._ingest(r, this.key)
      // if server says invalid/mismatch, surface it
      else if (r.status) { this.detail = r.error || '' }
    } catch { /* offline — rely on grace/expiry */ }
    this.evaluate()
  }

  // accept a fresh server response: verify, anti-replay, persist
  _ingest(r, key) {
    const p = verifyToken(r.token, this.fp)
    if (!p) { this.status = 'invalid'; return }
    const serverTime = Number(r.serverTime) || p.serverTime || 0
    if (serverTime + SKEW < this.lastServerTime) return // anti-replay: stale token
    this.lastServerTime = Math.max(this.lastServerTime, serverTime)
    this.key = key
    this.token = r.token
    this._revalidateBy = serverTime + cfg.LICENSE.graceHours * 3600 * 1000
    saveState({
      key, token: r.token, lastServerTime: this.lastServerTime,
      plan: p.plan, customer: p.customer, expiresAt: p.expiresAt, revalidateBy: this._revalidateBy,
    }, this.fp)
  }

  async _post(pathname, body) {
    const url = cfg.LICENSE.serverUrl.replace(/\/$/, '') + pathname
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 12000)
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: ctrl.signal,
      })
      return await res.json()
    } finally { clearTimeout(t) }
  }

  publicStatus() {
    return {
      enabled: this.enabled(),
      status: this.status,
      detail: this.detail,
      fingerprint: this.fp,
      machine: machineInfo(),
      plan: this.info?.plan || null,
      customer: this.info?.customer || null,
      expiresAt: this.info?.expiresAt || null,
      revalidateBy: this._revalidateBy || null,
      serverTime: this.lastServerTime || null,
      graceHours: cfg.LICENSE.graceHours,
    }
  }
}

module.exports = new License()

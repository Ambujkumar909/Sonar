// =============================================================
//  Sonar — license client (hardened)
//  Two modes:
//   • offline : pre-signed Ed25519 keys with a baked-in expiry.
//               No server. Verified locally; expiry + clock-rollback
//               enforced. (LICENSE_OFFLINE=1)
//   • server  : online activation + heartbeat + machine binding.
//               (LICENSE_SERVER_URL=…)
//   • off     : neither set → licensing disabled (dev).
//  State lives in Postgres (kv), AES-256-GCM encrypted & machine-bound.
//  Enforcement is server-side: when not active, all sessions are held.
// =============================================================
const os = require('os')
const crypto = require('crypto')
const cfg = require('./config')
const store = require('./store')

// Embedded license PUBLIC key (private key signs keys offline, never ships).
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAjHBXja7My87P/Q6IuYPmrDi23XXs6GQz/72LzM4RlMk=
-----END PUBLIC KEY-----`
const PUBLIC_KEY = crypto.createPublicKey(PUBLIC_KEY_PEM)
const APP_SECRET = 'S0nar::v1::4f2a9c7e-licence-binding-secret'
const KV_KEY = 'license:state'
const SKEW = 5 * 60 * 1000

const fromB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

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
  return crypto.createHash('sha256').update([os.hostname(), os.platform(), os.arch(), cpu, os.cpus().length, mac].join('|')).digest('hex')
}
function machineInfo() { return { host: os.hostname(), platform: os.platform(), arch: os.arch(), cpus: os.cpus().length } }

// ---- tamper-evident, machine-bound state (stored in Postgres kv) ----------
function stateKey(fp) { return crypto.scryptSync(fp + '::' + APP_SECRET, 'sonar-license-salt', 32) }
async function saveState(state, fp) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', stateKey(fp), iv)
  const enc = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()])
  await store.kvSet(KV_KEY, Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64'))
}
async function loadState(fp) {
  try {
    const raw = await store.kvGet(KV_KEY); if (!raw) return null
    const buf = Buffer.from(raw, 'base64')
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28)
    const d = crypto.createDecipheriv('aes-256-gcm', stateKey(fp), iv); d.setAuthTag(tag)
    return JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString('utf8'))
  } catch { return null }
}

// signature-verified token payloads
function verifyToken(token, fp) { // server tokens carry a fingerprint
  const p = verifySig(token); if (!p) return null
  if (p.fingerprint !== fp) return null
  return p
}
function verifySig(token) { // offline keys: signature only
  if (!token || !token.includes('.')) return null
  const [p, s] = token.split('.')
  if (!crypto.verify(null, Buffer.from(p), PUBLIC_KEY, fromB64url(s))) return null
  try { return JSON.parse(fromB64url(p).toString('utf8')) } catch { return null }
}

class License {
  constructor() {
    this.fp = machineFingerprint()
    this.mode = cfg.LICENSE.serverUrl ? 'server' : (cfg.LICENSE.offline ? 'offline' : 'off')
    this.status = 'unknown'; this.detail = ''; this.info = null
    this.lastServerTime = 0; this._revalidateBy = 0
  }
  enabled() { return this.mode !== 'off' }
  effNow() { return Math.max(Date.now(), this.lastServerTime) }

  async init(manager) {
    this.manager = manager
    if (!this.enabled()) { this.status = 'disabled'; return }
    const st = await loadState(this.fp)
    if (st) this.applyState(st)
    else { this.status = 'unlicensed'; this.detail = 'No license activated' }
    await this.evaluate()
    if (this.mode === 'server') {
      this.heartbeat().catch(() => {})
      clearInterval(this._hb)
      this._hb = setInterval(() => this.heartbeat().catch(() => {}), cfg.LICENSE.heartbeatMin * 60 * 1000)
    }
    clearInterval(this._eval)
    this._eval = setInterval(() => this.evaluate().catch(() => {}), cfg.LICENSE.evalSec * 1000)
  }

  applyState(st) {
    this.key = st.key; this.token = st.token
    this.lastServerTime = Math.max(this.lastServerTime, st.lastServerTime || 0)
    this._revalidateBy = st.revalidateBy || 0
    this.info = { plan: st.plan, customer: st.customer, expiresAt: st.expiresAt }
  }

  async evaluate() {
    if (!this.enabled()) { this.status = 'disabled'; return this.apply() }
    if (!this.token) { this.status = 'unlicensed'; return this.apply() }
    const p = this.mode === 'offline' ? verifySig(this.token) : verifyToken(this.token, this.fp)
    if (!p) { this.status = 'invalid'; this.detail = 'License is invalid for this machine'; return this.apply() }
    this.info = { plan: p.plan, customer: p.customer, expiresAt: p.expiresAt }
    // monotonic anti-rollback: remember the highest time we've ever seen
    if (this.effNow() > this.lastServerTime) { this.lastServerTime = this.effNow(); await this.persist(p) }
    const now = this.effNow()
    if (p.revoked) { this.status = 'revoked'; this.detail = 'License has been revoked' }
    else if (p.expiresAt && now > p.expiresAt) { this.status = 'expired'; this.detail = 'License has expired' }
    else if (this.mode === 'server' && this._revalidateBy && now > this._revalidateBy) { this.status = 'grace_over'; this.detail = 'License server unreachable past the offline window' }
    else { this.status = 'active'; this.detail = '' }
    this.apply()
  }

  apply() {
    const active = this.status === 'active' || this.status === 'disabled'
    if (this.manager) this.manager.setLicenseHeld(!active, this.status)
  }

  async persist(p) {
    await saveState({ key: this.key, token: this.token, lastServerTime: this.lastServerTime, plan: p?.plan, customer: p?.customer, expiresAt: p?.expiresAt, revalidateBy: this._revalidateBy }, this.fp)
  }

  async activate(key) {
    key = String(key || '').trim()
    if (!this.enabled()) return { ok: false, error: 'licensing is disabled' }
    if (this.mode === 'offline') {
      const p = verifySig(key)
      if (!p) return { ok: false, error: 'invalid license key' }
      this.token = key; this.key = null
      this.lastServerTime = Math.max(this.lastServerTime, Date.now())
      await this.persist(p); await this.evaluate()
      return { ok: true, status: this.status }
    }
    try {
      const r = await this._post('/api/activate', { key, fingerprint: this.fp, info: machineInfo() })
      if (!r.ok) return r
      await this._ingest(r, key); await this.evaluate()
      return { ok: true, status: this.status }
    } catch (e) { return { ok: false, error: 'cannot reach license server: ' + (e.message || e) } }
  }

  async heartbeat() {
    if (this.mode !== 'server' || !this.key) { await this.evaluate(); return }
    try {
      const r = await this._post('/api/heartbeat', { key: this.key, fingerprint: this.fp })
      if (r.ok) await this._ingest(r, this.key)
      else if (r.status) this.detail = r.error || ''
    } catch {}
    await this.evaluate()
  }

  async _ingest(r, key) {
    const p = verifyToken(r.token, this.fp); if (!p) { this.status = 'invalid'; return }
    const serverTime = Number(r.serverTime) || p.serverTime || 0
    if (serverTime + SKEW < this.lastServerTime) return // anti-replay
    this.lastServerTime = Math.max(this.lastServerTime, serverTime)
    this.key = key; this.token = r.token
    this._revalidateBy = serverTime + cfg.LICENSE.graceHours * 3600 * 1000
    await this.persist(p)
  }

  async _post(pathname, body) {
    const url = cfg.LICENSE.serverUrl.replace(/\/$/, '') + pathname
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000)
    try { return await (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal })).json() }
    finally { clearTimeout(t) }
  }

  publicStatus() {
    return {
      enabled: this.enabled(), mode: this.mode, status: this.status, detail: this.detail,
      fingerprint: this.fp, machine: machineInfo(),
      plan: this.info?.plan || null, customer: this.info?.customer || null,
      expiresAt: this.info?.expiresAt || null, graceHours: cfg.LICENSE.graceHours,
    }
  }
}

module.exports = new License()

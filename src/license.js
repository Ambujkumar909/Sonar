// =============================================================
//  Sonar — license client (OFFLINE keys only, no server)
//  Pre-signed Ed25519 keys carry a baked-in expiry. Verified
//  locally with the embedded public key; expiry + clock-rollback
//  enforced. State lives in Postgres (kv), AES-256-GCM, machine-bound.
//  Enable with LICENSE_OFFLINE=1; otherwise licensing is disabled.
//  Enforcement: when not active, all sessions are held.
// =============================================================
const os = require('os')
const crypto = require('crypto')
const cfg = require('./config')
const store = require('./store')

// Embedded PUBLIC key. The matching PRIVATE key signs offline keys
// (keys/private.pem) and never ships with the app.
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAjHBXja7My87P/Q6IuYPmrDi23XXs6GQz/72LzM4RlMk=
-----END PUBLIC KEY-----`
const PUBLIC_KEY = crypto.createPublicKey(PUBLIC_KEY_PEM)
const APP_SECRET = 'S0nar::v1::4f2a9c7e-licence-binding-secret'
const KV_KEY = 'license:state'

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

// signature-only verification (offline keys have no machine fingerprint inside)
function verifySig(token) {
  if (!token || !token.includes('.')) return null
  const [p, s] = token.split('.')
  if (!crypto.verify(null, Buffer.from(p), PUBLIC_KEY, fromB64url(s))) return null
  try { return JSON.parse(fromB64url(p).toString('utf8')) } catch { return null }
}

class License {
  constructor() {
    this.fp = machineFingerprint()
    this.enabledFlag = !!cfg.LICENSE.offline
    this.mode = this.enabledFlag ? 'offline' : 'off'
    this.status = 'unknown'; this.detail = ''; this.info = null
    this.lastSeen = 0
  }
  enabled() { return this.enabledFlag }
  effNow() { return Math.max(Date.now(), this.lastSeen) } // monotonic anti-rollback

  async init(manager) {
    this.manager = manager
    if (!this.enabled()) { this.status = 'disabled'; return }
    // Always load the persisted monotonic clock first (anti-rollback survives restarts).
    const st = await loadState(this.fp)
    if (st) this.lastSeen = Math.max(this.lastSeen, st.lastSeen || 0)
    // The key in .env is AUTHORITATIVE; otherwise fall back to a UI-activated key.
    if (cfg.LICENSE.key) this.token = cfg.LICENSE.key
    else if (st) this.token = st.token
    if (!this.token) { this.status = 'unlicensed'; this.detail = 'No LICENSE_KEY set' }
    await this.evaluate()
    clearInterval(this._eval)
    this._eval = setInterval(() => this.evaluate().catch(() => {}), cfg.LICENSE.evalSec * 1000)
  }

  async evaluate() {
    if (!this.enabled()) { this.status = 'disabled'; return this.apply() }
    if (!this.token) { this.status = 'unlicensed'; return this.apply() }
    const p = verifySig(this.token)
    if (!p) { this.status = 'invalid'; this.detail = 'License key is invalid'; return this.apply() }
    this.info = { plan: p.plan, expiresAt: p.expiresAt }
    if (this.effNow() > this.lastSeen) { this.lastSeen = this.effNow(); await this.persist(p) } // advance monotonic clock
    const now = this.effNow()
    if (p.expiresAt && now > p.expiresAt) { this.status = 'expired'; this.detail = 'License key has expired' }
    else { this.status = 'active'; this.detail = '' }
    this.apply()
  }

  apply() {
    const active = this.status === 'active' || this.status === 'disabled'
    if (this.manager) this.manager.setLicenseHeld(!active, this.status)
  }

  async persist(p) {
    await saveState({ token: this.token, lastSeen: this.lastSeen, plan: p?.plan, expiresAt: p?.expiresAt }, this.fp)
  }

  async activate(key) {
    key = String(key || '').trim()
    if (!this.enabled()) return { ok: false, error: 'licensing is disabled' }
    const p = verifySig(key)
    if (!p) return { ok: false, error: 'invalid license key' }
    this.token = key
    this.lastSeen = Math.max(this.lastSeen, Date.now())
    await this.persist(p)
    await this.evaluate()
    return { ok: true, status: this.status }
  }

  // kept for API compatibility (no server to call — just re-evaluate locally)
  async heartbeat() { await this.evaluate() }

  publicStatus() {
    return {
      enabled: this.enabled(), mode: this.mode, status: this.status, detail: this.detail,
      fingerprint: this.fp, machine: machineInfo(),
      plan: this.info?.plan || null, expiresAt: this.info?.expiresAt || null,
    }
  }
}

module.exports = new License()

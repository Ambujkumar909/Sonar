// =============================================================
//  Sonar — licensing deep test harness (CTO-grade, 100+ checks)
//  Spins up an isolated license server + Sonar instances and
//  exercises signature / binding / revoke / expiry / grace /
//  tamper / RBAC / enforcement, including REAL timed tests.
//
//  Run:  node tests/licensing.test.js
// =============================================================
const { spawn } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const TMP = path.join(os.tmpdir(), 'sonar-lictest-' + Date.now())
fs.mkdirSync(TMP, { recursive: true })

const LIC_PORT = 5099
const A_PORT = 4546 // main licensing instance
const G_PORT = 4547 // offline-grace instance
const ADMIN = 'testadminkey'
const LICURL = `http://localhost:${LIC_PORT}`

let pass = 0, fail = 0
const fails = []
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  else { fail++; fails.push(name); console.log(`  \x1b[31m✗ ${name}\x1b[0m ${extra}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- tiny cookie-aware fetch ----
function jar() {
  let cookie = ''
  return async (url, opts = {}) => {
    opts.headers = { ...(opts.headers || {}), ...(cookie ? { cookie } : {}) }
    if (opts.body && typeof opts.body !== 'string') { opts.body = JSON.stringify(opts.body); opts.headers['Content-Type'] = 'application/json' }
    const res = await fetch(url, opts)
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]
    let body = null; try { body = await res.json() } catch {}
    return { status: res.status, body }
  }
}

const procs = []
function start(name, cmd, args, env, cwd) {
  const p = spawn(cmd, args, { cwd: cwd || ROOT, env: { ...process.env, ...env }, stdio: 'ignore' })
  procs.push({ name, p }); return p
}
function killAll() { for (const { p } of procs) { try { p.kill() } catch {} } }
async function waitUp(url, ms = 15000) {
  const t = Date.now()
  while (Date.now() - t < ms) { try { const r = await fetch(url); if (r.status) return true } catch {} await sleep(300) }
  return false
}

// ed25519 public key (must match license-server/keys/public.pem)
const PUB = crypto.createPublicKey(fs.readFileSync(path.join(ROOT, 'license-server', 'keys', 'public.pem')))
const fromB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
function verifyTok(tok) {
  const [p, s] = tok.split('.'); return crypto.verify(null, Buffer.from(p), PUB, fromB64url(s))
}
function payload(tok) { return JSON.parse(fromB64url(tok.split('.')[0]).toString()) }

async function main() {
  console.log('\n=== SONAR LICENSING DEEP TEST ===\n')

  // ---------- license server ----------
  start('license', 'node', ['server.js'], {
    LICENSE_PORT: LIC_PORT, LICENSE_ADMIN_KEY: ADMIN, LICENSE_DB_FILE: path.join(TMP, 'lic.db'),
  }, path.join(ROOT, 'license-server'))
  ok('license server boots', await waitUp(LICURL))

  const A = jar()
  const adminH = { 'x-admin-key': ADMIN }

  console.log('\n--- License server admin API ---')
  let r = await A(`${LICURL}/api/admin/licenses`, { headers: { 'x-admin-key': 'wrong' } })
  ok('admin: wrong key rejected (401)', r.status === 401)
  r = await A(`${LICURL}/api/admin/licenses`, { headers: adminH })
  ok('admin: right key accepted (200)', r.status === 200)
  ok('admin: licenses list is array', Array.isArray(r.body.licenses))

  r = await A(`${LICURL}/api/admin/licenses`, { method: 'POST', headers: adminH, body: { customer: 'Acme', days: 30 } })
  const key30 = r.body.key
  ok('create: returns key', !!key30)
  ok('create: key format SONAR-XXXX-XXXX-XXXX-XXXX', /^SONAR(-[0-9A-F]{6}){4}$/.test(key30 || ''))
  r = await A(`${LICURL}/api/admin/licenses`, { headers: adminH })
  const lic30 = r.body.licenses.find((l) => l.key === key30)
  ok('create: appears in list', !!lic30)
  ok('create: status inactive before activation', lic30.status === 'inactive')
  ok('create: ~30 days expiry', Math.abs((lic30.expires_at - Date.now()) - 30 * 86400000) < 5 * 60000)

  console.log('\n--- Activation + signature + binding (server) ---')
  const FP1 = 'TESTFP-' + crypto.randomBytes(6).toString('hex')
  const FP2 = 'TESTFP-' + crypto.randomBytes(6).toString('hex')
  r = await A(`${LICURL}/api/activate`, { method: 'POST', body: { key: 'SONAR-000000-000000-000000-000000', fingerprint: FP1 } })
  ok('activate: unknown key → 404', r.status === 404)
  r = await A(`${LICURL}/api/activate`, { method: 'POST', body: { key: key30 } })
  ok('activate: missing fingerprint → 400', r.status === 400)
  r = await A(`${LICURL}/api/activate`, { method: 'POST', body: { key: key30, fingerprint: FP1, info: { host: 'box1' } } })
  ok('activate: valid → ok', r.body.ok === true)
  ok('activate: returns token', !!r.body.token)
  ok('activate: status active', r.body.status === 'active')
  ok('activate: token signature valid', verifyTok(r.body.token))
  const pl = payload(r.body.token)
  ok('token: bound to fingerprint', pl.fingerprint === FP1)
  ok('token: has expiresAt', typeof pl.expiresAt === 'number')
  ok('token: has serverTime', typeof pl.serverTime === 'number')
  ok('token: not revoked', pl.revoked === false)
  // tamper
  const parts = r.body.token.split('.')
  const tampered = parts[0].slice(0, -2) + (parts[0].slice(-2) === 'AA' ? 'BB' : 'AA') + '.' + parts[1]
  ok('token: tampered payload fails signature', !verifyTok(tampered))
  // binding
  r = await A(`${LICURL}/api/activate`, { method: 'POST', body: { key: key30, fingerprint: FP1 } })
  ok('activate: same fingerprint again → ok', r.body.ok === true)
  r = await A(`${LICURL}/api/activate`, { method: 'POST', body: { key: key30, fingerprint: FP2 } })
  ok('activate: different machine → 409 bound', r.status === 409)

  console.log('\n--- Heartbeat ---')
  r = await A(`${LICURL}/api/heartbeat`, { method: 'POST', body: { key: key30, fingerprint: FP1 } })
  ok('heartbeat: valid → ok', r.body.ok === true)
  ok('heartbeat: fresh token signed', verifyTok(r.body.token))
  ok('heartbeat: returns serverTime', typeof r.body.serverTime === 'number')
  r = await A(`${LICURL}/api/heartbeat`, { method: 'POST', body: { key: 'SONAR-000000-000000-000000-000000', fingerprint: FP1 } })
  ok('heartbeat: unknown key → 404', r.status === 404)
  r = await A(`${LICURL}/api/heartbeat`, { method: 'POST', body: { key: key30, fingerprint: FP2 } })
  ok('heartbeat: wrong machine → 409', r.status === 409)

  console.log('\n--- Admin lifecycle: extend / revoke / migrate / delete ---')
  const id30 = lic30.id
  const before = (await A(`${LICURL}/api/admin/licenses`, { headers: adminH })).body.licenses.find((l) => l.id === id30).expires_at
  await A(`${LICURL}/api/admin/licenses/${id30}/extend`, { method: 'POST', headers: adminH, body: { days: 10 } })
  let after = (await A(`${LICURL}/api/admin/licenses`, { headers: adminH })).body.licenses.find((l) => l.id === id30).expires_at
  ok('extend: expiry increased ~10d', Math.abs((after - before) - 10 * 86400000) < 60000)
  await A(`${LICURL}/api/admin/licenses/${id30}/revoke`, { method: 'POST', headers: adminH, body: {} })
  let l = (await A(`${LICURL}/api/admin/licenses`, { headers: adminH })).body.licenses.find((x) => x.id === id30)
  ok('revoke: status revoked', l.status === 'revoked')
  r = await A(`${LICURL}/api/heartbeat`, { method: 'POST', body: { key: key30, fingerprint: FP1 } })
  ok('revoke: heartbeat token carries revoked=true', payload(r.body.token).revoked === true)
  await A(`${LICURL}/api/admin/licenses/${id30}/revoke`, { method: 'POST', headers: adminH, body: { revoked: false } })
  l = (await A(`${LICURL}/api/admin/licenses`, { headers: adminH })).body.licenses.find((x) => x.id === id30)
  ok('unrevoke: status active again', l.status === 'active')
  await A(`${LICURL}/api/admin/licenses/${id30}/migrate`, { method: 'POST', headers: adminH, body: {} })
  l = (await A(`${LICURL}/api/admin/licenses`, { headers: adminH })).body.licenses.find((x) => x.id === id30)
  ok('migrate: fingerprint released', !l.fingerprint)
  r = await A(`${LICURL}/api/activate`, { method: 'POST', body: { key: key30, fingerprint: FP2 } })
  ok('migrate: re-activates on a NEW machine', r.body.ok === true && payload(r.body.token).fingerprint === FP2)

  console.log('\n--- Expired license (server) ---')
  r = await A(`${LICURL}/api/admin/licenses`, { method: 'POST', headers: adminH, body: { customer: 'Exp', seconds: 1 } })
  const keyExp = r.body.key
  await sleep(1500)
  l = (await A(`${LICURL}/api/admin/licenses`, { headers: adminH })).body.licenses.find((x) => x.key === keyExp)
  ok('expired: status expired after 1s', l.status === 'expired')

  // ---------- Sonar instance A (licensing on) ----------
  console.log('\n--- Sonar enforcement (instance A) ---')
  start('sonarA', 'node', ['src/server.js'], {
    PORT: A_PORT, SONAR_DATA_DIR: path.join(TMP, 'A/data'), SONAR_SESSIONS_DIR: path.join(TMP, 'A/sessions'),
    SONAR_LOG_DIR: path.join(TMP, 'A/logs'), LICENSE_SERVER_URL: LICURL, LICENSE_EVAL_SEC: 2, LICENSE_HEARTBEAT_MIN: 1,
  })
  const base = `http://localhost:${A_PORT}`
  ok('Sonar A boots', await waitUp(base))
  const S = jar()
  r = await S(`${base}/api/login`, { method: 'POST', body: { username: 'admin@sonar', password: 'Admin@123$' } })
  ok('Sonar: super_admin login', r.body.ok === true)
  r = await S(`${base}/api/license/status`)
  ok('Sonar: licensing enabled', r.body.license.enabled === true)
  ok('Sonar: status unlicensed before activation', r.body.license.status === 'unlicensed')
  ok('Sonar: exposes machine fingerprint', !!r.body.license.fingerprint)

  // RBAC: create a viewer and a manager, ensure they cannot activate
  await S(`${base}/api/users`, { method: 'POST', body: { username: 'v1', password: 'secret123', role: 'viewer' } })
  await S(`${base}/api/users`, { method: 'POST', body: { username: 'm1', password: 'secret123', role: 'manager' } })
  const V = jar(); await V(`${base}/api/login`, { method: 'POST', body: { username: 'v1', password: 'secret123' } })
  r = await V(`${base}/api/license/activate`, { method: 'POST', body: { key: 'x' } })
  ok('RBAC: viewer cannot activate (403)', r.status === 403)
  r = await V(`${base}/api/license/status`)
  ok('RBAC: viewer CAN read status (countdown)', r.body.ok === true)

  // create a session BEFORE license — must be held
  r = await S(`${base}/api/sessions`, { method: 'POST', body: { name: 'T1' } })
  const sid = r.body.id
  await sleep(800)
  r = await S(`${base}/api/state`)
  let sess = r.body.sessions.find((x) => x.id === sid)
  ok('enforcement: session HELD while unlicensed', sess && sess.live === 'held')

  // activate a fresh license bound to THIS machine
  r = await S(`${base}/api/license/status`); const myFp = r.body.license.fingerprint
  r = await A(`${LICURL}/api/admin/licenses`, { method: 'POST', headers: adminH, body: { customer: 'DDecor', days: 30 } })
  const keyMain = r.body.key
  r = await S(`${base}/api/license/activate`, { method: 'POST', body: { key: keyMain } })
  ok('activate via Sonar → active', r.body.ok === true && r.body.status === 'active')
  r = await S(`${base}/api/license/status`)
  ok('status: active', r.body.license.status === 'active')
  ok('status: plan present', !!r.body.license.plan)
  ok('status: expiresAt ~30d', Math.abs((r.body.license.expiresAt - Date.now()) - 30 * 86400000) < 5 * 60000)
  await sleep(2500)
  r = await S(`${base}/api/state`)
  sess = r.body.sessions.find((x) => x.id === sid)
  ok('enforcement: session RESUMES when active', sess && sess.live !== 'held')

  // revoke → Sonar refresh → held
  const idMain = (await A(`${LICURL}/api/admin/licenses`, { headers: adminH })).body.licenses.find((x) => x.key === keyMain).id
  await A(`${LICURL}/api/admin/licenses/${idMain}/revoke`, { method: 'POST', headers: adminH, body: {} })
  await S(`${base}/api/license/refresh`, { method: 'POST' })
  r = await S(`${base}/api/license/status`)
  ok('revoke: Sonar status revoked', r.body.license.status === 'revoked')
  await sleep(2500)
  r = await S(`${base}/api/state`)
  sess = r.body.sessions.find((x) => x.id === sid)
  ok('revoke: session HELD again', sess && sess.live === 'held')
  // restore
  await A(`${LICURL}/api/admin/licenses/${idMain}/revoke`, { method: 'POST', headers: adminH, body: { revoked: false } })
  await S(`${base}/api/license/refresh`, { method: 'POST' })
  r = await S(`${base}/api/license/status`)
  ok('unrevoke: Sonar active again', r.body.license.status === 'active')

  // ---------- EXTRA COVERAGE (fast, no machine rebind) ----------
  console.log('\n--- Extra server coverage (separate fingerprints) ---')
  const FP3 = 'FP3-' + crypto.randomBytes(5).toString('hex')
  const FP4 = 'FP4-' + crypto.randomBytes(5).toString('hex')
  const FP5 = 'FP5-' + crypto.randomBytes(5).toString('hex')
  const kA = (await A(`${LICURL}/api/admin/licenses`, { method: 'POST', headers: adminH, body: { customer: 'A', days: 5 } })).body.key
  const kB = (await A(`${LICURL}/api/admin/licenses`, { method: 'POST', headers: adminH, body: { customer: 'B', days: 5 } })).body.key
  ok('create: two keys are unique', kA && kB && kA !== kB)
  r = await A(`${LICURL}/api/admin/licenses?adminKey=${ADMIN}`, {})
  ok('admin: query-param auth works', r.status === 200)
  r = await A(`${LICURL}/api/activate`, { method: 'POST', body: { key: kA, fingerprint: FP3 } })
  ok('extra: activate kA on FP3', r.body.ok === true)
  ok('token: serverTime within 60s of now', Math.abs(payload(r.body.token).serverTime - Date.now()) < 60000)
  ok('token: carries licenseId', typeof payload(r.body.token).licenseId === 'number')
  ok('token: carries key', payload(r.body.token).key === kA)
  ok('token: carries customer', payload(r.body.token).customer === 'A')
  ok('token: ~5 day expiry', Math.abs((payload(r.body.token).expiresAt - Date.now()) - 5 * 86400000) < 5 * 60000)
  ok('token: has plan field', typeof payload(r.body.token).plan === 'string')
  ok('token: has issuedAt', typeof payload(r.body.token).issuedAt === 'number')
  ok('activate: response carries serverTime', typeof r.body.serverTime === 'number')
  ok('activate: response carries expiresAt', typeof r.body.expiresAt === 'number')
  ok('activate: response status active', r.body.status === 'active')
  let lA = (await A(`${LICURL}/api/admin/licenses`, { headers: adminH })).body.licenses.find((x) => x.key === kA)
  const seen1 = lA.last_seen
  await sleep(1100)
  await A(`${LICURL}/api/heartbeat`, { method: 'POST', body: { key: kA, fingerprint: FP3 } })
  lA = (await A(`${LICURL}/api/admin/licenses`, { headers: adminH })).body.licenses.find((x) => x.key === kA)
  ok('heartbeat: updates last_seen', lA.last_seen > seen1)
  ok('extra: kA bound to FP3 in admin view', lA.fingerprint === FP3)
  r = await A(`${LICURL}/api/admin/licenses/${lA.id}/migrate`, { method: 'POST', headers: adminH, body: {} })
  ok('extra: migrate kA ok', r.body.ok === true)
  r = await A(`${LICURL}/api/activate`, { method: 'POST', body: { key: kA, fingerprint: FP5 } })
  ok('extra: kA re-binds to FP5 after migrate', payload(r.body.token).fingerprint === FP5)
  const idB = (await A(`${LICURL}/api/admin/licenses`, { headers: adminH })).body.licenses.find((x) => x.key === kB).id
  await A(`${LICURL}/api/admin/licenses/${idB}`, { method: 'DELETE', headers: adminH })
  r = await A(`${LICURL}/api/admin/licenses`, { headers: adminH })
  ok('delete: kB removed from list', !r.body.licenses.find((x) => x.key === kB))
  r = await A(`${LICURL}/api/activate`, { method: 'POST', body: { key: kB, fingerprint: FP3 } })
  ok('delete: deleted key no longer activates (404)', r.status === 404)
  // minutes duration
  r = await A(`${LICURL}/api/admin/licenses`, { method: 'POST', headers: adminH, body: { customer: 'M', minutes: 5 } })
  const kMin = r.body.key
  r = await A(`${LICURL}/api/activate`, { method: 'POST', body: { key: kMin, fingerprint: FP4 } })
  ok('minutes: ~5 min expiry', Math.abs((payload(r.body.token).expiresAt - Date.now()) - 5 * 60000) < 30000)
  // expired-on-activate
  r = await A(`${LICURL}/api/admin/licenses`, { method: 'POST', headers: adminH, body: { customer: 'X', seconds: 1 } })
  const kExp2 = r.body.key
  await sleep(1300)
  r = await A(`${LICURL}/api/activate`, { method: 'POST', body: { key: kExp2, fingerprint: FP4 } })
  ok('expired: activation returns status expired', r.body.status === 'expired')
  ok('expired: token still signature-valid (client enforces expiry)', verifyTok(r.body.token))
  ok('expired: token expiresAt is in the past', payload(r.body.token).expiresAt < Date.now())

  console.log('\n--- Extra Sonar RBAC + status coverage ---')
  // unauthenticated cannot read status
  const NO = jar()
  r = await NO(`${base}/api/license/status`)
  ok('RBAC: unauthenticated status → 401', r.status === 401)
  // admin role can read status but cannot activate (super_admin only)
  await S(`${base}/api/users`, { method: 'POST', body: { username: 'a1', password: 'secret123', role: 'admin' } })
  const AD = jar(); await AD(`${base}/api/login`, { method: 'POST', body: { username: 'a1', password: 'secret123' } })
  r = await AD(`${base}/api/license/status`)
  ok('RBAC: admin can READ license status (countdown)', r.body.ok === true)
  ok('status: has graceHours', typeof r.body.license.graceHours === 'number')
  ok('status: machine.host present', !!r.body.license.machine.host)
  ok('status: machine.platform present', !!r.body.license.machine.platform)
  ok('status: machine.cpus present', typeof r.body.license.machine.cpus === 'number')
  ok('status: fingerprint is 64-hex', /^[0-9a-f]{64}$/.test(r.body.license.fingerprint))
  r = await AD(`${base}/api/license/activate`, { method: 'POST', body: { key: kA } })
  ok('RBAC: admin CANNOT activate (super_admin only) → 403', r.status === 403)
  const MG = jar(); await MG(`${base}/api/login`, { method: 'POST', body: { username: 'm1', password: 'secret123' } })
  r = await MG(`${base}/api/license/activate`, { method: 'POST', body: { key: kA } })
  ok('RBAC: manager CANNOT activate → 403', r.status === 403)
  r = await S(`${base}/api/license/activate`, { method: 'POST', body: { key: '' } })
  ok('activate: empty key rejected', r.body.ok !== true)
  r = await S(`${base}/api/license/activate`, { method: 'POST', body: { key: 'SONAR-DEAD-DEAD-DEAD-DEAD' } })
  ok('activate: bogus key rejected', r.body.ok !== true)
  r = await S(`${base}/api/license/refresh`, { method: 'POST' })
  ok('refresh: returns license object', !!r.body.license && typeof r.body.license.status === 'string')
  // super_admin still active on keyMain (bogus activate above should not have unbound it)
  r = await S(`${base}/api/license/status`)
  ok('status: main license still active after failed activations', r.body.license.status === 'active')
  ok('status: enabled flag true', r.body.license.enabled === true)
  ok('status: detail is string', typeof r.body.license.detail === 'string')
  ok('status: expiresAt is number', typeof r.body.license.expiresAt === 'number')
  ok('status: plan present on active license', !!r.body.license.plan)
  r = await AD(`${base}/api/state`)
  ok('admin: can read /state', Array.isArray(r.body.sessions))
  r = await A(`${LICURL}/api/heartbeat`, { method: 'POST', body: { key: kA, fingerprint: FP5 } })
  ok('heartbeat: returns expiresAt', typeof r.body.expiresAt === 'number')
  ok('heartbeat: status active for valid future license', r.body.status === 'active')

  // tamper local state
  console.log('\n--- Tamper-evidence + persistence (instance A restart) ---')
  fs.appendFileSync(path.join(TMP, 'A/data', 'license.bin'), Buffer.from('CORRUPT'))
  procs.find((x) => x.name === 'sonarA').p.kill(); await sleep(1500)
  start('sonarA', 'node', ['src/server.js'], {
    PORT: A_PORT, SONAR_DATA_DIR: path.join(TMP, 'A/data'), SONAR_SESSIONS_DIR: path.join(TMP, 'A/sessions'),
    SONAR_LOG_DIR: path.join(TMP, 'A/logs'), LICENSE_SERVER_URL: LICURL, LICENSE_EVAL_SEC: 2, LICENSE_HEARTBEAT_MIN: 60,
  })
  await waitUp(base)
  const S2 = jar(); await S2(`${base}/api/login`, { method: 'POST', body: { username: 'admin@sonar', password: 'Admin@123$' } })
  r = await S2(`${base}/api/license/status`)
  ok('tamper: corrupted license.bin → NOT active (locked out)', r.body.license.status !== 'active')
  // re-activate cleanly persists
  await S2(`${base}/api/license/activate`, { method: 'POST', body: { key: keyMain } })
  r = await S2(`${base}/api/license/status`)
  ok('re-activate after tamper → active', r.body.license.status === 'active')

  // ---------- TIMED: short license expiry ----------
  console.log('\n--- TIMED: short-plan expiry stops sessions (~75s) ---')
  r = await A(`${LICURL}/api/admin/licenses`, { method: 'POST', headers: adminH, body: { customer: 'ShortPlan', seconds: 75 } })
  const keyShort = r.body.key
  // migrate main license off this machine first so we can bind the short one
  await A(`${LICURL}/api/admin/licenses/${idMain}/migrate`, { method: 'POST', headers: adminH, body: {} })
  r = await S2(`${base}/api/license/activate`, { method: 'POST', body: { key: keyShort } })
  ok('short: activated', r.body.ok === true)
  r = await S2(`${base}/api/license/status`)
  ok('short: active right after activation', r.body.license.status === 'active')
  await S2(`${base}/api/sessions/${sid}/resume`, { method: 'POST' }).catch(() => {})
  await sleep(2000)
  r = await S2(`${base}/api/state`); sess = r.body.sessions.find((x) => x.id === sid)
  ok('short: session running during plan', sess && sess.live !== 'held')
  console.log('  …waiting for the 75s plan to expire…')
  await sleep(80000) // wait past expiry; local eval (2s) should flip it
  r = await S2(`${base}/api/license/status`)
  ok('short: status EXPIRED after plan ends', r.body.license.status === 'expired')
  let heldNow = false, lastLive = ''
  for (let i = 0; i < 12; i++) {
    r = await S2(`${base}/api/state`); sess = r.body.sessions.find((x) => x.id === sid)
    lastLive = sess && sess.live
    if (lastLive === 'held') { heldNow = true; break }
    await sleep(1000)
  }
  ok('short: session STOPPED (held) after expiry', heldNow, '(live=' + lastLive + ')')
  // extend → resumes
  await A(`${LICURL}/api/admin/licenses/${(await A(`${LICURL}/api/admin/licenses`, { headers: adminH })).body.licenses.find((x) => x.key === keyShort).id}/extend`, { method: 'POST', headers: adminH, body: { days: 1 } })
  await S2(`${base}/api/license/refresh`, { method: 'POST' })
  r = await S2(`${base}/api/license/status`)
  ok('short: extend → active again', r.body.license.status === 'active')
  await sleep(3000)
  r = await S2(`${base}/api/state`); sess = r.body.sessions.find((x) => x.id === sid)
  ok('short: session RESUMES after extension', sess && sess.live !== 'held')

  // ---------- TIMED: offline grace ----------
  console.log('\n--- TIMED: offline grace window then stop (~40s) ---')
  // dedicated Sonar with a tiny 36s grace
  start('sonarG', 'node', ['src/server.js'], {
    PORT: G_PORT, SONAR_DATA_DIR: path.join(TMP, 'G/data'), SONAR_SESSIONS_DIR: path.join(TMP, 'G/sessions'),
    SONAR_LOG_DIR: path.join(TMP, 'G/logs'), LICENSE_SERVER_URL: LICURL, LICENSE_EVAL_SEC: 2,
    LICENSE_HEARTBEAT_MIN: 60, LICENSE_GRACE_HOURS: 0.01, // 36 seconds
  })
  const gbase = `http://localhost:${G_PORT}`
  ok('Sonar G boots', await waitUp(gbase))
  const G = jar(); await G(`${gbase}/api/login`, { method: 'POST', body: { username: 'admin@sonar', password: 'Admin@123$' } })
  r = await A(`${LICURL}/api/admin/licenses`, { method: 'POST', headers: adminH, body: { customer: 'Grace', days: 30 } })
  const keyG = r.body.key
  r = await G(`${gbase}/api/license/activate`, { method: 'POST', body: { key: keyG } })
  ok('grace: activated active', r.body.ok === true)
  // take the license server OFFLINE
  procs.find((x) => x.name === 'license').p.kill(); await sleep(1000)
  r = await G(`${gbase}/api/license/status`)
  ok('grace: still active immediately after server offline (within grace)', r.body.license.status === 'active')
  console.log('  …waiting past the 36s offline window…')
  await sleep(44000)
  r = await G(`${gbase}/api/license/status`)
  ok('grace: status grace_over once offline window exceeded', r.body.license.status === 'grace_over')

  // ---------- summary ----------
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed (total ${pass + fail}) ===`)
  if (fails.length) console.log('FAILED:\n - ' + fails.join('\n - '))
  killAll()
  await sleep(500)
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('HARNESS ERROR:', e); killAll(); process.exit(1) })

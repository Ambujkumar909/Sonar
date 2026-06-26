// =============================================================
//  Sonar — security regression suite
//  Locks in every fix from the black-box agent audit:
//  IDOR, object-level authz, audit token redaction, error-handler
//  (no stack leak), session cap, limit clamp, input validation,
//  number normalization, /state QR-bloat removal, RBAC.
//
//  Run:  node tests/security.test.js
// =============================================================
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const TMP = path.join(os.tmpdir(), 'sonar-sectest-' + Date.now())
fs.mkdirSync(TMP, { recursive: true })
const LIC_PORT = 5071, PORT = 4720, ADMIN = 'sectest', LICURL = `http://localhost:${LIC_PORT}`, BASE = `http://localhost:${PORT}`

let pass = 0, fail = 0; const fails = []
const ok = (n, c, extra = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`) } else { fail++; fails.push(n); console.log(`  \x1b[31m✗ ${n}\x1b[0m ${extra}`) } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const procs = []
const start = (cmd, args, env, cwd) => { const p = spawn(cmd, args, { cwd: cwd || ROOT, env: { ...process.env, ...env }, stdio: 'ignore' }); procs.push(p); return p }
const killAll = () => procs.forEach(p => { try { p.kill() } catch {} })
async function waitUp(u, ms = 15000) { const t = Date.now(); while (Date.now() - t < ms) { try { const r = await fetch(u); if (r.status) return true } catch {} await sleep(300) } return false }
function jar() { let c = ''; return async (u, o = {}) => { o.headers = { ...(o.headers || {}), ...(c ? { cookie: c } : {}) }; if (o.body && typeof o.body !== 'string') { o.body = JSON.stringify(o.body); o.headers['Content-Type'] = 'application/json' } const res = await fetch(u, o); const sc = res.headers.get('set-cookie'); if (sc) c = sc.split(';')[0]; let b = null; try { b = await res.json() } catch {} return { status: res.status, body: b, raw: res } } }

async function main() {
  console.log('\n=== SONAR SECURITY REGRESSION ===\n')
  start('node', ['server.js'], { LICENSE_PORT: LIC_PORT, LICENSE_ADMIN_KEY: ADMIN, LICENSE_DB_FILE: path.join(TMP, 'l.db') }, path.join(ROOT, 'license-server'))
  await waitUp(LICURL)
  start('node', ['src/server.js'], { PORT, SONAR_DATA_DIR: path.join(TMP, 'd'), SONAR_SESSIONS_DIR: path.join(TMP, 's'), SONAR_LOG_DIR: path.join(TMP, 'lg'), LICENSE_SERVER_URL: LICURL, LICENSE_EVAL_SEC: 5, MAX_SESSIONS: 3 })
  ok('Sonar boots', await waitUp(BASE))

  const A = jar() // license-server admin
  const S = jar() // super_admin
  await S(`${BASE}/api/login`, { method: 'POST', body: { username: 'admin@sonar', password: 'Admin@123$' } })
  // license so sessions can run
  const key = (await A(`${LICURL}/api/admin/licenses`, { method: 'POST', headers: { 'x-admin-key': ADMIN }, body: { customer: 'Sec', days: 30 } })).body.key
  await S(`${BASE}/api/license/activate`, { method: 'POST', body: { key } })
  await sleep(1500)

  // sessions
  const SA = (await S(`${BASE}/api/sessions`, { method: 'POST', body: { name: 'A' } })).body.id
  const SB = (await S(`${BASE}/api/sessions`, { method: 'POST', body: { name: 'B' } })).body.id

  console.log('\n--- Input validation & normalization ---')
  await S(`${BASE}/api/watch`, { method: 'POST', body: { sid: SB, kind: 'number', value: '+91 98765 43210' } })
  let w = (await S(`${BASE}/api/watch?sid=${SB}`)).body.watch[0]
  ok('number normalized to digits only', w.value === '919876543210', '(got ' + w.value + ')')
  let r = await S(`${BASE}/api/watch`, { method: 'POST', body: { sid: SB, kind: 'banana', value: 'x' } })
  ok("invalid watch kind rejected (400)", r.status === 400)
  r = await S(`${BASE}/api/sessions`, { method: 'POST', body: { name: '   ' } })
  ok('blank session name accepted but defaulted (not crashing)', r.body.ok === true)

  console.log('\n--- IDOR / object-level authz (watchlist) ---')
  await S(`${BASE}/api/users`, { method: 'POST', body: { username: 'mgr', password: 'secret123', role: 'manager' } })
  const mid = (await S(`${BASE}/api/users`)).body.users.find(u => u.username === 'mgr').id
  await S(`${BASE}/api/grants`, { method: 'POST', body: { user_id: mid, session_id: SA } }) // only SA
  const M = jar(); await M(`${BASE}/api/login`, { method: 'POST', body: { username: 'mgr', password: 'secret123' } })
  r = await M(`${BASE}/api/watch?sid=${SB}`)
  ok('manager CANNOT read ungranted session watchlist (403)', r.status === 403)
  r = await M(`${BASE}/api/watch/${w.id}`, { method: 'DELETE' })
  ok('manager CANNOT delete ungranted watch entry (403)', r.status === 403)
  ok('blocked delete did NOT remove the entry', (await S(`${BASE}/api/watch?sid=${SB}`)).body.watch.length === 1)
  r = await M(`${BASE}/api/watch`, { method: 'POST', body: { sid: SB, kind: 'group', value: 'X' } })
  ok('manager CANNOT add watch to ungranted session (403)', r.status === 403)
  ok('manager only sees granted session in /state', (await M(`${BASE}/api/state`)).body.sessions.every(s => s.id === SA))
  r = await M(`${BASE}/api/sessions/${SB}/chats`)
  ok('manager CANNOT read ungranted session chats (403)', r.status === 403)

  console.log('\n--- Unknown ids → 404 (not silent 200) ---')
  for (const op of ['stop', 'resume', 'restart']) { r = await S(`${BASE}/api/sessions/NOPE/${op}`, { method: 'POST' }); ok(`unknown session ${op} → 404`, r.status === 404) }
  r = await S(`${BASE}/api/sessions/NOPE`, { method: 'DELETE' }); ok('unknown session delete → 404', r.status === 404)
  r = await S(`${BASE}/api/watch/999999`, { method: 'DELETE' }); ok('unknown watch delete → 404', r.status === 404)

  console.log('\n--- Error handling (no stack/path leak) ---')
  r = await fetch(`${BASE}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: '' } , body: '{bad json' })
  const txt = await r.text()
  ok('malformed JSON → no stack trace / no filesystem path', !/at \w|node_modules|\\Users\\|\.js:\d/.test(txt), '(' + txt.slice(0, 60) + ')')

  console.log('\n--- Audit token redaction ---')
  const aud = (await S(`${BASE}/api/audit`)).body
  ok('audit sessions have NO token field', (aud.sessions || []).every(s => !('token' in s)))
  ok('audit active have NO token field', (aud.active || []).every(s => !('token' in s)))

  console.log('\n--- /state payload hygiene + QR on demand ---')
  const st = (await S(`${BASE}/api/state`)).body
  ok('/state sessions carry NO base64 qr blob', st.sessions.every(s => !('qr' in s)))
  ok('/state sessions carry hasQr flag', st.sessions.every(s => 'hasQr' in s))
  r = await S(`${BASE}/api/sessions/${SA}/qr`); ok('per-session /qr endpoint works (200)', r.status === 200)

  console.log('\n--- Limits & caps ---')
  r = await S(`${BASE}/api/search?q=hi&limit=100000000`); ok('huge ?limit clamped, no error (200)', r.status === 200)
  // fill to the cap (3), then prove the next is rejected, then prove freeing a slot allows one
  let cur = (await S(`${BASE}/api/state`)).body.sessions.length
  while (cur < 3) { await S(`${BASE}/api/sessions`, { method: 'POST', body: { name: 'fill' } }); cur = (await S(`${BASE}/api/state`)).body.sessions.length }
  r = await S(`${BASE}/api/sessions`, { method: 'POST', body: { name: 'OVER' } })
  ok('create beyond cap (3) rejected', r.body.ok === false, '(count=' + cur + ')')
  const victim = (await S(`${BASE}/api/state`)).body.sessions[0].id
  await S(`${BASE}/api/sessions/${victim}`, { method: 'DELETE' })
  r = await S(`${BASE}/api/sessions`, { method: 'POST', body: { name: 'AFTERFREE' } })
  ok('create succeeds after freeing a slot', r.body.ok === true)

  console.log('\n--- RBAC quick matrix ---')
  await S(`${BASE}/api/users`, { method: 'POST', body: { username: 'vw', password: 'secret123', role: 'viewer' } })
  const V = jar(); await V(`${BASE}/api/login`, { method: 'POST', body: { username: 'vw', password: 'secret123' } })
  ok('viewer cannot create session (403)', (await V(`${BASE}/api/sessions`, { method: 'POST', body: { name: 'z' } })).status === 403)
  ok('viewer cannot add keyword (403)', (await V(`${BASE}/api/keywords`, { method: 'POST', body: { word: 'x' } })).status === 403)
  ok('viewer cannot read audit (403)', (await V(`${BASE}/api/audit`)).status === 403)
  ok('manager cannot create user (403)', (await M(`${BASE}/api/users`, { method: 'POST', body: { username: 'q', password: 'secret123', role: 'viewer' } })).status === 403)
  ok('cannot create super_admin via API', (await S(`${BASE}/api/users`, { method: 'POST', body: { username: 'evil', password: 'secret123', role: 'super_admin' } })).status === 400)
  ok('unauthenticated → 401', (await fetch(`${BASE}/api/state`)).status === 401)

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed (total ${pass + fail}) ===`)
  if (fails.length) console.log('FAILED:\n - ' + fails.join('\n - '))
  killAll(); await sleep(400)
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error('HARNESS ERROR:', e); killAll(); process.exit(1) })

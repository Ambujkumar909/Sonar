// =============================================================
//  Sonar — offline license key generator  (ISSUER ONLY, private)
//  Lives in keys/ (gitignored) with the private signing key.
//  NEVER ship this or keys/private.pem — deployments only verify
//  with the embedded public key and cannot mint keys.
//
//  Usage:
//    node keys/make-keys.js [count] [yearsPerStep] [mode]
//    node keys/make-keys.js 15 1            # 15 keys, STAGGERED:
//                                           #   Key1 valid 1yr, Key2 2yr … Key15 15yr
//                                           #   → swap one key per year, 15 yrs covered
//    node keys/make-keys.js 15 1 same       # 15 keys that ALL expire in 1 year
//  Output: license-keys.txt (gitignored — keep private)
// =============================================================
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const PRIV_PATH = process.env.PRIVATE_KEY_FILE || path.join(__dirname, 'private.pem')
if (!fs.existsSync(PRIV_PATH)) { console.error('private key not found at', PRIV_PATH); process.exit(1) }
const PRIV = crypto.createPrivateKey(fs.readFileSync(PRIV_PATH))

const count = Number(process.argv[2]) || 15
const yearsPerStep = Number(process.argv[3]) || 1   // years each key adds
const mode = process.argv[4] || 'staggered'          // 'staggered' | 'same'
const YEAR = 365 * 86400000

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const sign = (o) => { const p = b64url(JSON.stringify(o)); return p + '.' + b64url(crypto.sign(null, Buffer.from(p), PRIV)) }

const now = Date.now()
const keys = []
for (let i = 1; i <= count; i++) {
  // staggered: key i valid for i*yearsPerStep years from NOW, so moving to the
  // next key at each renewal keeps you covered. 'same': all expire together.
  const expiresAt = now + (mode === 'same' ? 1 : i) * yearsPerStep * YEAR
  keys.push({ expiresAt, token: sign({ id: 'OFF-' + now.toString(36) + '-' + String(i).padStart(2, '0'), plan: yearsPerStep + 'yr-step', type: 'offline', issuedAt: now, expiresAt }) })
}

const header =
  `Sonar offline license keys\n` +
  `Generated : ${new Date(now).toISOString()}\n` +
  `Mode      : ${mode}${mode === 'staggered' ? `  (Key N valid N x ${yearsPerStep}yr — apply Key 1 now, move to the next each renewal)` : '  (all expire together)'}\n` +
  `Count     : ${count}\n\n` +
  `Apply: put ONE key in .env as LICENSE_KEY, then restart. When it expires, use the next.\n` +
  `Keep this file PRIVATE.\n${'='.repeat(72)}\n\n`
const body = keys.map((k, i) => `# Key ${i + 1}  (valid until ${new Date(k.expiresAt).toISOString().slice(0, 10)})\n${k.token}`).join('\n\n')

fs.writeFileSync(path.join(__dirname, '..', 'license-keys.txt'), header + body + '\n')
console.log(`OK ${count} key(s), mode=${mode}. First expires ${new Date(keys[0].expiresAt).toISOString().slice(0, 10)}, last ${new Date(keys[count - 1].expiresAt).toISOString().slice(0, 10)} -> license-keys.txt`)

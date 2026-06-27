// =============================================================
//  Sonar — offline license key generator
//  Signs self-contained Ed25519 license keys with a baked-in expiry.
//  No server needed: Sonar verifies them locally (LICENSE_OFFLINE=1).
//
//  Usage:
//    node scripts/make-keys.js [count] [days]
//    node scripts/make-keys.js 15 365      # 15 keys, 1 year each (default)
//
//  Requires the PRIVATE key (keep it secret, never commit/ship):
//    license-server/keys/private.pem   (or set PRIVATE_KEY_FILE=…)
//  Output: license-keys.txt  (hold these; paste one into Sonar to activate)
// =============================================================
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const PRIV_PATH = process.env.PRIVATE_KEY_FILE || path.join(__dirname, '..', 'license-server', 'keys', 'private.pem')
if (!fs.existsSync(PRIV_PATH)) { console.error('private key not found at', PRIV_PATH); process.exit(1) }
const PRIV = crypto.createPrivateKey(fs.readFileSync(PRIV_PATH))

const count = Number(process.argv[2]) || 15
const days = Number(process.argv[3]) || 365

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
function sign(payload) {
  const p = b64url(JSON.stringify(payload))
  return p + '.' + b64url(crypto.sign(null, Buffer.from(p), PRIV))
}

const now = Date.now()
const expiresAt = now + days * 86400000
const keys = []
for (let i = 1; i <= count; i++) {
  keys.push(sign({
    id: 'OFF-' + now.toString(36) + '-' + String(i).padStart(2, '0'),
    plan: days + '-day', type: 'offline', issuedAt: now, expiresAt,
  }))
}

const header =
  `Sonar offline license keys\n` +
  `Generated : ${new Date(now).toISOString()}\n` +
  `Validity  : ${days} days  (each key expires ${new Date(expiresAt).toISOString()})\n` +
  `Count     : ${count}\n\n` +
  `To use: on the Sonar server set  LICENSE_OFFLINE=1  then paste a key on the License page.\n` +
  `Keep this file private. One key = one activation period; paste a fresh one to renew.\n` +
  `${'='.repeat(70)}\n\n`

const body = keys.map((k, i) => `# Key ${i + 1}\n${k}`).join('\n\n')
fs.writeFileSync(path.join(__dirname, '..', 'license-keys.txt'), header + body + '\n')
console.log(`✓ Generated ${count} key(s), ${days}-day validity → license-keys.txt`)

# Sonar Licensing (offline, key-based)

Sonar uses **offline, pre-signed license keys** — there is **no license server**.
Each key is an Ed25519-signed token with a baked-in expiry (e.g. 1 year). Sonar
verifies it locally with an embedded public key and enforces the expiry. Put a key
in `.env` and it validates on boot.

## How it works

- The **private signing key** (`keys/private.pem`) is yours and never ships. The
  matching **public key** is embedded in `src/license.js`.
- You generate a batch of keys once, hold them, and apply one at a time.
- A key is a self-contained signed token: `base64url(payload).base64url(signature)`
  where the payload includes `expiresAt`. The signature covers the whole payload, so
  the expiry **cannot be edited** without invalidating the key.

## Generate keys

```bash
node scripts/make-keys.js 15 365     # 15 keys, 1 year each → license-keys.txt
```
`license-keys.txt` is gitignored — keep it private. Each key is independent.

## Apply a key

In `.env`:
```
LICENSE_KEY=eyJ...the key from license-keys.txt...
```
Start (or restart) Sonar. It validates on boot:
- valid & not expired → **active**, sessions run
- expired / forged / garbage → sessions are **held** (stopped) until a valid key is set
- empty `LICENSE_KEY` → **disabled** (runs unrestricted)

When a key expires, replace `LICENSE_KEY` with the next one and restart.

## Security properties (verified)

- **Unforgeable** — bumping `expiresAt` and keeping the old signature is rejected
  (signature binds the full payload). Garbage/random keys rejected.
- **Expiry enforced continuously** — a local re-check (every `LICENSE_EVAL_SEC`)
  flips `active → expired` the moment the date passes and **auto-holds all sessions**.
- **Clock-rollback resistant** — the highest time ever seen is persisted (Postgres,
  AES-256-GCM, machine-bound); setting the system clock back does not extend a license.
- **Server-side enforcement** — the hold lives in the Node backend, not the browser.

## Maximum anti-tamper (optional)

Since Sonar runs on the customer's machine, a determined attacker with the source
could patch out the check. To make that impractical, compile the enforcement modules
to V8 bytecode:
```bash
npm run build:secure          # → src/license.jsc + src/sessionManager.jsc
# then deploy the .jsc and delete the matching .js
```
`src/server.js` already loads the `.jsc` automatically.

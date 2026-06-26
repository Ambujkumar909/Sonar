# Sonar Licensing

A hardened, machine-bound, time-limited licensing system. The **license server**
(you host it) issues Ed25519-signed licenses; each **Sonar deployment** validates
against it and stops all WhatsApp sessions when the plan expires or is revoked.

## Components

- `license-server/` — standalone app you host (own `package.json`, own DB, the **private** signing key)
- `src/license.js` — the client embedded in Sonar (holds the **public** key)

The keypair lives in `license-server/keys/`. **Never share `private.pem`.** The public
key is embedded in `src/license.js`. If you regenerate keys, update both.

## 1. Run the license server (on your host/VPS)

```bash
cd license-server
npm install
LICENSE_ADMIN_KEY="a-long-random-secret" LICENSE_PORT=5005 npm start
```
Open `http://<host>:5005`, enter the admin key, and create license keys
(customer + plan length in days). You can **extend**, **revoke**, and **migrate**
(release the machine binding) any license from there.

> Put it behind HTTPS in production (e.g. a reverse proxy). The signing still works
> over plain HTTP, but HTTPS protects the admin key in transit.

## 2. Point Sonar at it

Start Sonar with the licensing env vars:
```bash
LICENSE_SERVER_URL="https://licenses.yourdomain.com" npm start
```
Optional:
- `LICENSE_HEARTBEAT_MIN` — re-validation cadence (default 30 min)
- `LICENSE_GRACE_HOURS` — max offline window before sessions stop (default 72)

If `LICENSE_SERVER_URL` is **not** set, licensing is **disabled** (dev mode) and
everything runs unrestricted.

## 3. Activate

Log in to Sonar as **super_admin** → **License** page → paste the key → Activate.
The license binds to this machine. **Admins and super_admins** see a live countdown
(days/hours/min/sec remaining); only **super_admin** can activate/change the key.

## What happens on expiry / revoke

All WhatsApp sessions stop immediately; the dashboard stays browsable with a banner.
When the plan is renewed (extend on the server) the next heartbeat auto-resumes sessions.

## Migrating to a new server

In the license server admin UI, click **Migrate** on the license (releases the machine
binding), then **Activate** the same key on the new Sonar machine.

## Security model (and its one honest limit)

Enforced: Ed25519-signed tokens (expiry/fingerprint unforgeable), machine binding,
server-authoritative time + clock-rollback/anti-replay protection, mandatory heartbeat
with a finite offline grace, tamper-evident AES-GCM local state, and **server-side**
enforcement (not the browser).

The one limit: Sonar runs on the customer's machine, so a determined attacker with the
source could patch out the check. To raise that bar to "practically uncrackable", the
enforcement-critical modules (`src/license.js` and `src/sessionManager.js`, which decide
and apply the session-hold) can be compiled to **V8 bytecode** so they can't be read or
edited in plain text.

### Secure (bytecode) production build

```bash
npm run build:secure        # compiles src/license.js + src/sessionManager.js → .jsc
```
Then for the production deploy, ship the `.jsc` files and **delete the matching `.js`
sources** (keep them in your own private source control). `require()` prefers `.js` in
dev and transparently falls back to `.jsc` when the `.js` is absent — `src/server.js`
already registers the `bytenode` loader at startup, so no code changes are needed.

```bash
# on the deploy box, after build:
rm src/license.js src/sessionManager.js     # keep src/license.jsc + src/sessionManager.jsc
npm start
```

Notes:
- `.jsc` is tied to the Node **major** version it was built with — build on the same
  Node version you deploy with (this project is verified on Node 22).
- This was tested: with the `.js` removed, Sonar boots and enforces licensing entirely
  from bytecode.
- The embedded `APP_SECRET` (local-state encryption) and the whole license/enforcement
  flow become bytecode, defeating casual and most determined source-patching. Combined
  with signed tokens + machine binding + heartbeat + server-side enforcement, this is the
  strongest practical protection for software that runs on the customer's own server.

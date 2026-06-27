<div align="center">

# ⬡ Sonar

### Read-only WhatsApp intelligence platform

**Watch every conversation. Send nothing. Miss nothing.**

Multi-session monitoring on [Baileys](https://github.com/WhiskeySockets/Baileys) with a beautiful dashboard, self-healing connections, role-based access, a full audit trail, and cryptographic machine-bound licensing.

![Node](https://img.shields.io/badge/Node-22-3c873a)
![Stack](https://img.shields.io/badge/stack-Express%20%2B%20Socket.IO%20%2B%20PostgreSQL-be8429)
![Docker](https://img.shields.io/badge/docker-compose-2496ed)
![Mode](https://img.shields.io/badge/mode-READ--ONLY-1c8f52)
![Tests](https://img.shields.io/badge/tests-136%20passing-1c8f52)
![License](https://img.shields.io/badge/license-ISC-blue)

<img src="docs/screenshots/dashboard-light.png" width="49%" alt="Dashboard (light)"/>
<img src="docs/screenshots/dashboard-dark.png" width="49%" alt="Dashboard (dark)"/>

</div>

---

## What is Sonar?

Sonar is a **passive, observe-only** WhatsApp platform. Like *passive sonar* — which detects everything without emitting a signal — it watches, logs, and visualises your WhatsApp conversations **without ever sending a message, read receipt, or presence update.**

It's built for teams that must **never miss a lead**: link one or more WhatsApp devices by QR, tell it which **groups and numbers** to watch, and every message flows into a live dashboard, a searchable database, and permanent per-chat `.txt` archives — captured in **both directions** (incoming *and* your own outgoing messages).

> ⚠️ **Use responsibly.** Only monitor accounts you own or are authorised to monitor, and respect WhatsApp's Terms of Service and the privacy laws of your jurisdiction. This is an unofficial tool built on a reverse-engineered library; use it at your own risk.

---

## ✨ Highlights

| | |
|---|---|
| 🔭 **Read-only by design** | Never sends messages, receipts, or presence — purely passive |
| 🔌 **Multi-session** | Link unlimited WhatsApp devices, each with its own QR |
| 🎯 **Targeted capture** | Watch specific **groups** and **phone numbers** — nothing else is stored |
| ♻️ **Self-healing** | Reconnects through *every* disconnect code; recovery always **< 3 minutes** |
| 💬 **Elite chat reader** | Recent chats sidebar, group/direct filter, date separators, per-sender colours |
| 🗂️ **Permanent archive** | Per-chat `.txt` logs (kept forever) + 30-day Postgres hot store |
| 🔐 **4-tier RBAC + RLS** | super_admin / admin / manager / viewer, with per-session access grants |
| 🛡️ **Full audit trail** | Who logged in, from where, how long, and every action |
| 🔑 **Licensing** | Ed25519-signed, machine-bound, time-limited; optional bytecode hardening |
| 🎨 **Beautiful UI** | Warm cream + dark themes, diagonal gradient, large type, zero blue |

---

## 📸 Screenshots

<div align="center">

**Sign in — light & dark**
<img src="docs/screenshots/login-light.png" width="49%"/> <img src="docs/screenshots/login-dark.png" width="49%"/>

**Recent Chats reader · Sessions & QR**
<img src="docs/screenshots/recent-chats.png" width="49%"/> <img src="docs/screenshots/sessions-qr.png" width="49%"/>

**Users & RBAC · Audit Trail**
<img src="docs/screenshots/users-rbac.png" width="49%"/> <img src="docs/screenshots/audit-trail.png" width="49%"/>

</div>

---

## 🚀 Quick start

### Option A — Docker (everything in one command)
```bash
git clone <repo-url> sonar && cd sonar
docker compose up --build
```
This builds the app and runs **Postgres + Sonar** together. That's it.

### Option B — local (Node 22 + a Postgres you provide)
```bash
npm install
DATABASE_URL="postgres://user:pass@host:5432/sonar" npm start
```

Open **http://localhost:4545** and sign in:

| Username | Password |
|---|---|
| `admin@sonar` | `Admin@123$` |

> The super-admin is seeded on first run. Change the password from the profile menu (bottom-right). Override the seed with `SONAR_SUPERADMIN_USER` / `SONAR_SUPERADMIN_PASS`.

### First capture in 3 steps
1. **Sessions → Create & show QR** → scan with *WhatsApp ▸ Linked Devices ▸ Link a device*
2. **Watchlist** → add a **group name** (exact) and/or a **phone number** (digits only, e.g. `919812345678`)
3. Watch messages arrive in **Recent Chats** and the live feed — and in `logs/<group>.txt` / `logs/<number>.txt`

> By default Sonar listens to **nothing** until you add a group/number. (`super_admin` can flip a session to "Watch all groups".)

---

## 🧭 Architecture

```mermaid
flowchart LR
  WA[WhatsApp] -- read-only --> B[Baileys sockets]
  B --> SM[Session Manager<br/>watchdog · supervisor · license gate]
  SM --> DB[(PostgreSQL<br/>sessions · messages · WhatsApp auth · users · audit)]
  SM --> TXT[/.txt archive<br/>permanent/]
  SM <--> IO[Socket.IO]
  API[Express REST API<br/>RBAC · RLS · audit] --> DB
  IO --> UI[Dashboard SPA]
  API --> UI
  LIC[License client] -. heartbeat .-> LS[(License Server<br/>Ed25519)]
  LIC --> SM
```

```
src/
  config.js          configuration (env-overridable)
  store.js           PostgreSQL persistence + RLS-scoped queries + retention
  waauth.js          Baileys auth state stored in Postgres (no key files)
  textlog.js         per-chat .txt logging (original format preserved)
  reconnect.js       disconnect-code policy + capped backoff
  sessionManager.js  multi-session Baileys engine · watchdog · supervisor · license hold
  auth.js            scrypt auth, RBAC/RLS guards, audit
  license.js         hardened license client (Ed25519, machine-bound)
  server.js          Express + Socket.IO, secured REST API
public/              the dashboard SPA (vanilla, no framework)
license-server/      standalone license server (own deps, signing keys)
tests/               licensing.test.js (106) · security.test.js (30)
scripts/             build-secure.js (bytecode build)
```

---

## ♻️ Resilience — never miss a lead

Every WhatsApp disconnect maps to a deliberate policy. **There is no permanent dead state** except a manual Stop.

| Code | Meaning | Action | Re-scan? |
|---|---|---|---|
| 401 | phone unlinked device | wipe creds → auto-show fresh QR | yes (only case) |
| 403 / 405 / 408 / 428 / 440 | network / stream faults | reconnect (capped backoff) | no |
| 411 / 500 | bad session / mismatch | wipe creds → auto re-pair | yes |
| 503 | WA unavailable | reconnect with backoff | no |
| 515 | restart required (post-pair) | restart immediately | no |
| **anything else** | unknown | **reconnect forever** | no |

Three independent safety nets stack: a per-disconnect **classifier**, a **watchdog** (10s) that force-restarts dead sockets, and a **supervisor** (25s) that revives drifted sessions — plus process-level crash guards. Credentials persist to disk, so **after one scan you never scan again**.

---

## 🔐 Roles & access

| Role | Sessions | User & grants | Audit trail | Notes |
|---|---|---|---|---|
| **super_admin** | all | ✅ | ✅ (only role) | seeded once · hidden · uncreatable |
| **admin** | all | ✅ | ❌ | links devices, manages users |
| **manager** | granted only | ❌ | ❌ | read-write on granted sessions |
| **viewer** | granted only | ❌ | ❌ | read-only |

Row-level security is enforced **server-side**: managers/viewers only ever see sessions explicitly granted to them. Anyone can change their own password.

---

## ⚙️ Configuration

All optional — sensible defaults out of the box.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4545` | dashboard port |
| `LOCALE` | `en-IN` | timestamp locale |
| `RETAIN_DAYS` | `30` | days of messages kept in the DB (`.txt` keeps everything forever) |
| `MAX_SESSIONS` | `50` | cap on concurrent device sessions |
| `LICENSE_SERVER_URL` | *(empty)* | set to **enable** licensing; empty = disabled (dev) |
| `LICENSE_HEARTBEAT_MIN` | `30` | license re-validation cadence |
| `LICENSE_GRACE_HOURS` | `72` | max offline window before sessions stop |
| `SONAR_DATA_DIR` / `SONAR_SESSIONS_DIR` / `SONAR_LOG_DIR` | — | relocate storage (used for isolated tests) |

---

## 🔑 Licensing (optional)

Sonar ships with a complete, self-hostable licensing system — **off by default**.

- Run the standalone **license server** (`license-server/`), issue **machine-bound, time-limited** keys, and revoke / extend / migrate from its admin UI.
- Licenses are **Ed25519-signed** (expiry can't be forged), validated by heartbeat (instant revoke + clock-tamper detection), with a finite **offline grace** window.
- On expiry/revoke, all sessions stop; renew and they auto-resume.
- For maximum anti-tamper, `npm run build:secure` compiles the enforcement modules to **V8 bytecode**.

Full guide: **[LICENSE.md](LICENSE.md)**. To run without any license, simply don't set `LICENSE_SERVER_URL`.

---

## 🛡️ Security

Validated by a **3-agent black-box audit** + **136 automated assertions**:

- **scrypt** password hashing · **HttpOnly + SameSite=Strict** cookies · **Helmet** + strict CSP (`script-src 'self'`, no inline JS)
- **Login rate-limiting** · same-origin CORS · authenticated WebSocket
- **Object-level authorization** on every id-bearing route (no IDOR) · server-side RBAC + RLS
- Parameterized SQL (injection-proof) · path-traversal blocked · payload caps · clamped query limits
- No stack-trace/path leakage · audit responses redact session tokens
- Full audit trail attributing every action to a user + IP

```bash
node tests/licensing.test.js   # 106 assertions — signing, binding, expiry, grace, RBAC
node tests/security.test.js    #  30 assertions — IDOR, authz, caps, validation, RBAC
```

---

## 🧰 Tech stack

**Backend:** Node 22 · Express 5 · Socket.IO · PostgreSQL (pg) · @whiskeysockets/baileys · helmet · express-rate-limit
**Frontend:** vanilla JS SPA · Socket.IO client · Fraunces + Plus Jakarta Sans
**Crypto:** Ed25519 (licensing) · scrypt (auth) · AES-256-GCM (license cache)

---

## 📜 Notes & legal

- The original single-file logger (`automate.js`) is preserved and runnable via `npm run legacy`.
- `.txt` logs use the original format: `DD/MM/YYYY, hh:mm AM  Sender: message`.
- Sonar is **not affiliated with or endorsed by WhatsApp/Meta**. It uses the unofficial Baileys library. You are responsible for complying with WhatsApp's Terms of Service and all applicable privacy/consent laws.

## License

[ISC](package.json) © 2026 — built with care.

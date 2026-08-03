// =============================================================
//  Sonar — central configuration
//  Read-only WhatsApp intelligence platform (Baileys core)
// =============================================================
require('dotenv').config() // load .env if present (local runs; no-op if absent)
const path = require('path')

const ROOT = path.join(__dirname, '..')

module.exports = {
  ROOT,
  PORT: Number(process.env.PORT) || 4545,

  // Storage — Postgres for ALL data (sessions, messages, users, WhatsApp auth…).
  // Only the .txt archives remain on the filesystem.
  DATABASE_URL: process.env.DATABASE_URL || 'postgres://sonar:sonar@localhost:5433/sonar',
  DATA_DIR: process.env.SONAR_DATA_DIR || path.join(ROOT, 'data'),
  LOG_DIR: process.env.SONAR_LOG_DIR || path.join(ROOT, 'logs'), // .txt logs stay on disk

  // Locale / formatting (kept identical to the original logger)
  LOCALE: process.env.LOCALE || 'en-IN',
  TIME_AND_MESSAGE_ONLY: false,

  // Retention: keep this many days of messages in the DB (the .txt files keep
  // EVERYTHING forever as the permanent archive). Older DB rows are auto-purged.
  RETAIN_DAYS: Number(process.env.RETAIN_DAYS) || 30,

  // Abuse limits
  MAX_SESSIONS: Number(process.env.MAX_SESSIONS) || 50, // cap concurrent device sessions
  MAX_QUERY_LIMIT: 1000,      // hard ceiling for any ?limit= param

  // Behaviour
  READ_ONLY: true,            // hard guarantee — never send anything
  SYNC_FULL_HISTORY: true,    // pull recent history on connect for the chat list
  MARK_ONLINE: false,         // stay invisible — do not broadcast presence

  // Reconnection engine — tuned so recovery is ALWAYS well under 3 minutes.
  // No single backoff wait ever exceeds maxDelayMs, so once WhatsApp is
  // reachable again we re-attach within seconds. Never miss a lead.
  RECONNECT: {
    baseDelayMs: 1000,
    factor: 1.5,
    maxDelayMs: 12000,        // hard ceiling per wait — recovery stays fast
    jitter: 0.25,             // ±25% to avoid thundering-herd against WA edge
    softFailLimit: 1000,      // effectively never stop retrying transient faults
    cooldownMs: 15000,        // even the "long" pause is only 15s
    watchdogMs: 10000,        // aggressive health check every 10s
    connectingTimeoutMs: 45000, // stuck "connecting" > 45s -> force a fresh restart
    staleOpenMs: 90000,       // "open" but silent > 90s -> proactive ping/restart
  },

  // Licensing — enforced only when LICENSE_SERVER_URL is set (empty = dev/off).
  // Offline, key-based licensing (no server). Put a key in LICENSE_KEY to enforce;
  // leave empty to run unrestricted (disabled).
  LICENSE: {
    key: (process.env.LICENSE_KEY || '').trim(),
    offline: process.env.LICENSE_OFFLINE === '1' || !!(process.env.LICENSE_KEY || '').trim(),
    evalSec: Number(process.env.LICENSE_EVAL_SEC) || 30, // local re-check cadence (expiry/rollback)
  },

  // Defaults for a brand-new session.
  // STRICT: new sessions listen to NOTHING until groups/numbers are added to the
  // watchlist. "Watch all" can only be enabled by a super_admin.
  DEFAULT_WATCH_ALL_GROUPS: false,

  // SMTP — used to email the daily report. Accepts EMAIL_* (preferred) or SMTP_*
  // names. Configured = host + user + pass all set.
  SMTP: {
    host: process.env.EMAIL_HOST || process.env.SMTP_HOST || '',
    port: Number(process.env.EMAIL_PORT || process.env.SMTP_PORT) || 587,
    secure: (process.env.EMAIL_SECURE || process.env.SMTP_SECURE) === '1' || Number(process.env.EMAIL_PORT || process.env.SMTP_PORT) === 465,
    user: process.env.EMAIL_USER || process.env.SMTP_USER || '',
    pass: process.env.EMAIL_PASS || process.env.SMTP_PASS || '',
    from: process.env.EMAIL_FROM || process.env.MAIL_FROM || process.env.EMAIL_USER || process.env.SMTP_USER || '',
  },

  // Daily report scheduler — generates + saves + emails the last-24h report.
  // Supports MULTIPLE times per day via REPORT_TIMES="14:00,19:00" (24h clock).
  // Falls back to the single REPORT_HOUR/REPORT_MINUTE if REPORT_TIMES is unset.
  // Each firing covers the last 24h RELATIVE to its run time.
  REPORT: {
    enabled: process.env.REPORT_SCHEDULE !== '0', // on by default; set REPORT_SCHEDULE=0 to disable
    times: parseReportTimes(),
    tz: process.env.REPORT_TZ || 'Asia/Kolkata', // times are computed in THIS timezone, not the server's
  },
}

function parseReportTimes() {
  const out = []
  const raw = (process.env.REPORT_TIMES || '').trim()
  if (raw) {
    for (const part of raw.split(',')) {
      const m = part.trim().match(/^(\d{1,2}):(\d{2})$/)
      if (m) { const h = +m[1], mi = +m[2]; if (h >= 0 && h <= 23 && mi >= 0 && mi <= 59) out.push({ h, m: mi }) }
    }
  }
  if (!out.length) {
    const h = Number.isFinite(Number(process.env.REPORT_HOUR)) ? Number(process.env.REPORT_HOUR) : 19
    const mi = Number(process.env.REPORT_MINUTE) || 0
    out.push({ h, m: mi })
  }
  // de-dupe + sort by time of day
  const seen = new Set()
  return out.filter((t) => { const k = t.h * 60 + t.m; if (seen.has(k)) return false; seen.add(k); return true })
    .sort((a, b) => (a.h * 60 + a.m) - (b.h * 60 + b.m))
}

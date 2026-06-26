// =============================================================
//  Sonar — central configuration
//  Read-only WhatsApp intelligence platform (Baileys core)
// =============================================================
const path = require('path')

const ROOT = path.join(__dirname, '..')

module.exports = {
  ROOT,
  PORT: Number(process.env.PORT) || 4545,

  // Storage (env-overridable so tests can run fully isolated)
  DATA_DIR: process.env.SONAR_DATA_DIR || path.join(ROOT, 'data'),
  DB_FILE: path.join(process.env.SONAR_DATA_DIR || path.join(ROOT, 'data'), 'sonar.db'),
  SESSIONS_DIR: process.env.SONAR_SESSIONS_DIR || path.join(ROOT, 'sessions'),
  LOG_DIR: process.env.SONAR_LOG_DIR || path.join(ROOT, 'logs'), // preserves original .txt logging location

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
  LICENSE: {
    serverUrl: process.env.LICENSE_SERVER_URL || '',
    heartbeatMin: Number(process.env.LICENSE_HEARTBEAT_MIN) || 30,  // network re-validate cadence
    graceHours: Number(process.env.LICENSE_GRACE_HOURS) || 72,      // max offline window before sessions stop
    evalSec: Number(process.env.LICENSE_EVAL_SEC) || 30,            // local re-check cadence (catches expiry between heartbeats)
  },

  // Defaults for a brand-new session.
  // STRICT: new sessions listen to NOTHING until groups/numbers are added to the
  // watchlist. "Watch all" can only be enabled by a super_admin.
  DEFAULT_WATCH_ALL_GROUPS: false,
}

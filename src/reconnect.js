// =============================================================
//  Sonar — reconnection decision engine
//  Maps every WhatsApp/Baileys disconnect code to a deliberate
//  policy. Goal: transient faults recover in seconds; terminal
//  faults surface clearly instead of looping forever.
//
//  DisconnectReason (Baileys):
//    connectionClosed   428
//    connectionLost     408
//    timedOut           408
//    connectionReplaced 440
//    loggedOut          401
//    badSession         500
//    restartRequired    515
//    multideviceMismatch411
//    forbidden          403
//    unavailableService 503
//  Plus raw WA stream codes seen in the wild: 405 (blocked / retry later),
//  409 (conflict), 500, 503, etc.
// =============================================================

// Action vocabulary (NOTE: there is intentionally NO 'stop'.
// Once a session exists it reconnects forever — 0% breaking):
//   'reconnect'  -> dial again, keep credentials
//   'reauth'     -> WhatsApp itself killed the creds; wipe, auto-present a
//                   fresh QR, and keep the engine running. This is the ONLY
//                   case that needs a human (a single re-scan) — and even
//                   then the system stays alive and waiting.
const POLICY = {
  401: { action: 'reauth',    reason: 'Phone unlinked this device — auto-showing a fresh QR' },
  403: { action: 'reconnect', reason: 'Forbidden (403) — restriction may be temporary, retrying', minDelay: 12000 },
  405: { action: 'reconnect', reason: 'WA blocked the stream (405) — backing off then retrying', minDelay: 8000 },
  408: { action: 'reconnect', reason: 'Connection lost / timed out — reconnecting fast' },
  409: { action: 'reconnect', reason: 'Stream conflict — reconnecting' },
  411: { action: 'reauth',    reason: 'Multi-device mismatch — auto re-pair (fresh QR)' },
  428: { action: 'reconnect', reason: 'Connection closed — reconnecting fast' },
  440: { action: 'reconnect', reason: 'Connection replaced elsewhere — reclaiming with backoff', minDelay: 10000 },
  500: { action: 'reauth',    reason: 'Bad session file — wiping creds and auto re-pairing' },
  503: { action: 'reconnect', reason: 'WA service unavailable — retrying with backoff', minDelay: 6000 },
  515: { action: 'reconnect', reason: 'Restart required (normal after pairing) — restarting now', minDelay: 1000 },
}

function classify(statusCode) {
  const p = POLICY[statusCode]
  if (p) return { code: statusCode, ...p }
  // Unknown code -> treat as a transient network fault and keep trying forever.
  return { code: statusCode ?? 'unknown', action: 'reconnect', reason: `Unknown close (${statusCode}) — reconnecting` }
}

// Exponential backoff with jitter, hard-capped so recovery stays fast.
function backoff(attempt, cfg, minDelay = 0) {
  const raw = cfg.baseDelayMs * Math.pow(cfg.factor, Math.max(0, attempt - 1))
  const capped = Math.min(raw, cfg.maxDelayMs)
  const floored = Math.max(capped, minDelay)
  const jitter = floored * cfg.jitter * (Math.random() * 2 - 1)
  return Math.max(500, Math.round(floored + jitter))
}

module.exports = { classify, backoff, POLICY }

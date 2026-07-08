// =============================================================
//  Sonar — daily report scheduler.
//  Every day at REPORT_HOUR:REPORT_MINUTE (interpreted in REPORT_TZ, NOT the
//  server's timezone) it: generates the AI report for the last 24h, saves it
//  (same store as the manual Generate button), and emails it to every ENABLED
//  recipient. Timezone is handled via Intl so the server clock's TZ is irrelevant.
// =============================================================
const cfg = require('./config')
const store = require('./store')
const report = require('./report')
const mailer = require('./mailer')

// --- timezone-correct "next 7pm" computation (no dependency on server TZ) ---
function partsInTz(tz, epoch) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(epoch)).reduce((a, x) => (a[x.type] = x.value, a), {})
  return { y: +p.year, mo: +p.month, d: +p.day, h: (+p.hour) % 24, mi: +p.minute, s: +p.second }
}
// Epoch (ms) for a wall-clock Y-M-D H:M in tz. Iterates to stay correct across DST.
function epochForWallclock(tz, y, mo, d, h, mi) {
  let guess = Date.UTC(y, mo - 1, d, h, mi, 0)
  for (let i = 0; i < 2; i++) {
    const p = partsInTz(tz, guess)
    const asUTC = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s)
    guess += (Date.UTC(y, mo - 1, d, h, mi, 0) - asUTC)
  }
  return guess
}
function nextRunAt(now = Date.now()) {
  const { tz, hour, minute } = cfg.REPORT
  const today = partsInTz(tz, now)
  let target = epochForWallclock(tz, today.y, today.mo, today.d, hour, minute)
  if (target <= now + 1000) { // already past today -> schedule for tomorrow
    const t = partsInTz(tz, now + 24 * 3600 * 1000)
    target = epochForWallclock(tz, t.y, t.mo, t.d, hour, minute)
  }
  return target
}
const fmtInTz = (epoch) => new Date(epoch).toLocaleString('en-IN', { timeZone: cfg.REPORT.tz, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })

// --- the job: generate (last 24h) -> save -> email enabled recipients ---
async function runDaily({ by = 'scheduler' } = {}) {
  const { html, stats, summary } = await report.generateReport({ ids: undefined, days: 1, ai: true })
  const id = await store.saveReport({ created_by: by, window_days: 1, msg_count: stats.messages, chat_count: stats.chats, html })

  const recipients = (await store.listEnabledReportEmails()).map((r) => r.email)
  let emailed = 0, emailError = null
  if (recipients.length && mailer.isConfigured()) {
    try {
      await mailer.sendReport({
        to: recipients,
        subject: `D'Decor — Customer Chat Review (${summary.windowShort})`,
        bodyHtml: emailBody(summary, stats),
        attachmentHtml: html,
        filename: `customer-chat-review-${new Date().toISOString().slice(0, 10)}.html`,
      })
      emailed = recipients.length
    } catch (e) { emailError = e.message }
  }
  return { id, stats, recipients: recipients.length, emailed, emailError, smtp: mailer.isConfigured() }
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
function emailBody(summary, stats) {
  const kpis = (summary.kpis || []).map((k) => `<td style="padding:8px 14px;border:1px solid #e4e7eb"><div style="font-size:20px;font-weight:700;color:#0f2c4d">${esc(k.value)}</div><div style="font-size:11px;color:#667085;text-transform:uppercase">${esc(k.label)}</div></td>`).join('')
  return `<div style="font-family:'Segoe UI',Arial,sans-serif;color:#1d2733;max-width:640px">
    <h2 style="color:#0f2c4d;margin:0 0 4px">D'Decor — Customer Chat Review</h2>
    <div style="color:#667085;font-size:13px;margin-bottom:14px">${esc(summary.windowShort)} · ${stats.messages} messages</div>
    ${summary.verdict ? `<p style="font-size:14px;line-height:1.5">${esc(summary.verdict)}</p>` : '<p style="font-size:14px;color:#667085">No AI narrative (low activity in window). See the attached report for details.</p>'}
    ${kpis ? `<table style="border-collapse:collapse;margin:12px 0"><tr>${kpis}</tr></table>` : ''}
    <p style="font-size:13px;color:#667085">The full report (with charts) is attached as an HTML file — open it in a browser.</p>
    <p style="font-size:11px;color:#98a2b3">Automated daily report from Sonar · Confidential — internal use only.</p>
  </div>`
}

// --- scheduling loop ---
let timer = null
function scheduleNext() {
  if (!cfg.REPORT.enabled) return
  const at = nextRunAt()
  const delay = Math.max(1000, at - Date.now())
  timer = setTimeout(async () => {
    try {
      const r = await runDaily()
      console.log(`  scheduler: daily report #${r.id} — ${r.stats.messages} msgs, emailed ${r.emailed}/${r.recipients}${r.emailError ? ' (email error: ' + r.emailError + ')' : ''}`)
    } catch (e) { console.error('  scheduler: daily report failed:', e?.message || e) }
    scheduleNext()
  }, delay)
  if (timer.unref) timer.unref()
  console.log(`  scheduler: next daily report ${fmtInTz(at)} (${cfg.REPORT.tz})`)
}
function start() {
  if (!cfg.REPORT.enabled) { console.log('  scheduler: disabled (REPORT_SCHEDULE=0)'); return }
  scheduleNext()
}
function stop() { if (timer) clearTimeout(timer); timer = null }
function status() {
  return {
    enabled: cfg.REPORT.enabled,
    hour: cfg.REPORT.hour, minute: cfg.REPORT.minute, tz: cfg.REPORT.tz,
    nextRun: cfg.REPORT.enabled ? nextRunAt() : null,
    nextRunLabel: cfg.REPORT.enabled ? fmtInTz(nextRunAt()) : null,
    smtpConfigured: mailer.isConfigured(),
    from: mailer.from(),
  }
}

module.exports = { start, stop, runDaily, status, nextRunAt }

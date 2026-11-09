// =============================================================
//  Sonar — report scheduler (DB-configurable).
//  Config lives in the DB (kv:'report_schedule') and is editable from the
//  Scheduler page — no .env edits needed. Falls back to .env (cfg.REPORT) the
//  first time. Each run generates the report for the configured window, saves
//  it, and emails every ENABLED recipient.
//
//  Config shape:
//    { enabled, times:["14:00","19:00"], intervalDays, windowDays, tz, anchorDay }
//    intervalDays: 1=daily, 3=every 3 days, 7=weekly, 30=monthly, 365=yearly, N=custom
//    windowDays:   how far back each report covers (1=last 24h, 7=last week, …)
//  Timezone is handled via Intl, so the server clock's TZ is irrelevant.
// =============================================================
const cfg = require('./config')
const store = require('./store')
const report = require('./report')
const mailer = require('./mailer')

const KV_KEY = 'report_schedule'
let _cfg = null   // in-memory normalized config
let timer = null

// --- timezone helpers (no dependency on server TZ) ---
function partsInTz(tz, epoch) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(epoch)).reduce((a, x) => (a[x.type] = x.value, a), {})
  return { y: +p.year, mo: +p.month, d: +p.day, h: (+p.hour) % 24, mi: +p.minute, s: +p.second }
}
function epochForWallclock(tz, y, mo, d, h, mi) {
  let guess = Date.UTC(y, mo - 1, d, h, mi, 0)
  for (let i = 0; i < 2; i++) {
    const p = partsInTz(tz, guess)
    const asUTC = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s)
    guess += (Date.UTC(y, mo - 1, d, h, mi, 0) - asUTC)
  }
  return guess
}
const dayIndex = (tz, epoch) => { const p = partsInTz(tz, epoch); return Math.round(Date.UTC(p.y, p.mo - 1, p.d) / 86400000) }
const fmtInTz = (epoch) => new Date(epoch).toLocaleString('en-IN', { timeZone: (_cfg && _cfg.tz) || cfg.REPORT.tz, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })

// --- config load / normalize / save ---
function normalizeTimes(times) {
  const out = []
  for (const t of times || []) {
    let h, m
    if (typeof t === 'string') { const mm = t.trim().match(/^(\d{1,2}):(\d{2})$/); if (mm) { h = +mm[1]; m = +mm[2] } }
    else if (t && typeof t === 'object') { h = +t.h; m = +t.m }
    if (Number.isInteger(h) && Number.isInteger(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59) out.push({ h, m })
  }
  const seen = new Set()
  const uniq = out.filter((t) => { const k = t.h * 60 + t.m; if (seen.has(k)) return false; seen.add(k); return true })
  return uniq.sort((a, b) => (a.h * 60 + a.m) - (b.h * 60 + b.m))
}
function defaults() {
  return {
    enabled: cfg.REPORT.enabled,
    times: cfg.REPORT.times.map((t) => ({ h: t.h, m: t.m })),
    intervalDays: 1,
    windowDays: 1,
    tz: cfg.REPORT.tz,
    anchorDay: dayIndex(cfg.REPORT.tz, Date.now()),
  }
}
function normalize(raw) {
  const d = defaults()
  if (!raw || typeof raw !== 'object') return d
  const times = normalizeTimes(raw.times)
  const intervalDays = Math.min(3650, Math.max(1, Math.floor(Number(raw.intervalDays) || 1)))
  const windowDays = Math.min(3650, Math.max(1, Math.floor(Number(raw.windowDays) || 1)))
  return {
    enabled: raw.enabled !== false,
    times: times.length ? times : d.times,
    intervalDays,
    windowDays,
    tz: (typeof raw.tz === 'string' && raw.tz.trim()) ? raw.tz.trim() : d.tz,
    anchorDay: Number.isInteger(raw.anchorDay) ? raw.anchorDay : d.anchorDay,
  }
}
async function load() {
  let raw = null
  try { const v = await store.kvGet(KV_KEY); if (v) raw = JSON.parse(v) } catch { raw = null }
  _cfg = normalize(raw)
  return _cfg
}
async function save(patch, by = '') {
  const cur = _cfg || (await load())
  const merged = normalize({ ...cur, ...patch })
  // moving to a new cadence re-anchors "every N days" to today unless caller set one
  if (patch && patch.intervalDays && patch.intervalDays !== cur.intervalDays && !Number.isInteger(patch.anchorDay)) {
    merged.anchorDay = dayIndex(merged.tz, Date.now())
  }
  await store.kvSet(KV_KEY, JSON.stringify(merged))
  _cfg = merged
  scheduleNext()
  return _cfg
}

// --- next run computation (cadence + times) ---
function nextRunAt(now = Date.now()) {
  const c = _cfg
  if (!c || !c.enabled || !c.times.length) return null
  const times = c.times
  const maxScan = c.intervalDays * 2 + 8
  for (let add = 0; add <= maxScan; add++) {
    const dayEpoch = now + add * 86400000
    const p = partsInTz(c.tz, dayEpoch)
    const idx = Math.round(Date.UTC(p.y, p.mo - 1, p.d) / 86400000)
    if (((idx - c.anchorDay) % c.intervalDays + c.intervalDays) % c.intervalDays !== 0) continue // not an active day
    for (const { h, m } of times) {
      const t = epochForWallclock(c.tz, p.y, p.mo, p.d, h, m)
      if (t > now + 1000) return t
    }
  }
  return null
}

// --- the job: generate (windowDays) -> save -> email enabled recipients ---
async function runDaily({ by = 'scheduler' } = {}) {
  if (!_cfg) await load()
  const days = _cfg.windowDays || 1
  const { html, stats, summary } = await report.generateReport({ ids: undefined, days, ai: true })
  const id = await store.saveReport({ created_by: by, window_days: days, msg_count: stats.messages, chat_count: stats.chats, html })

  const recipients = (await store.listEnabledReportEmails()).map((r) => r.email)
  let emailed = 0, emailError = null
  if (recipients.length && mailer.isConfigured()) {
    try {
      await mailer.sendReport({
        to: recipients,
        subject: `Customer Chat Review (${summary.windowShort})`,
        bodyHtml: emailBody(summary, stats),
        attachmentHtml: html,
        filename: `customer-chat-review-${new Date().toISOString().slice(0, 10)}.html`,
      })
      emailed = recipients.length
    } catch (e) { emailError = e.message }
  }
  return { id, stats, days, recipients: recipients.length, emailed, emailError, smtp: mailer.isConfigured() }
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
// Email body — Outlook desktop renders this with Word's engine, so it is
// tables + inline styles + bgcolor only (no flex, no classes, no CSS vars).
const { TONE } = require('./reportTemplate')
const KPI_INK = { red: TONE.red.solid, amber: TONE.amber.solid, green: TONE.green.solid, purple: TONE.purple.solid }
const FONT = "'Segoe UI',-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif"
function emailBody(summary, stats, note = '') {
  const kpis = summary.kpis || []
  const cells = kpis.map((k) => `<td width="50%" valign="top" style="padding:16px 16px 20px;border-top:3px solid ${KPI_INK[k.cls] || TONE.teal.solid};background:#f5f7f8">
      <div style="font-family:${FONT};font-size:26px;line-height:30px;font-weight:300;color:#14202a">${esc(k.value)}</div>
      <div style="font-family:${FONT};font-size:13px;line-height:18px;color:#66727d;padding-top:4px">${esc(k.label)}</div></td>`)
  const rows = []
  for (let i = 0; i < cells.length; i += 2) {
    const r = cells.slice(i, i + 2)
    while (r.length < 2) r.push('<td width="50%"></td>')
    rows.push(`<tr>${r.join('<td width="8" style="font-size:0;line-height:0">&nbsp;</td>')}</tr><tr><td colspan="3" height="8" style="font-size:0;line-height:0">&nbsp;</td></tr>`)
  }
  const p = (txt, extra = '') => `<p style="margin:0;font-family:${FONT};font-size:15px;line-height:23px;color:#3d4a55;${extra}">${txt}</p>`
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#e8ecee">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#e8ecee" style="background:#e8ecee"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;background:#fcfdfd">
  <tr><td bgcolor="#0c2330" style="background:#0c2330;padding:28px 32px 24px">
    <div style="font-family:${FONT};font-size:13px;line-height:18px;font-weight:600;color:#a9bcc6"><span style="color:#5fb7c0">Sonar</span> WhatsApp intelligence</div>
    <div style="font-family:${FONT};font-size:26px;line-height:32px;font-weight:600;color:#f7fafb;padding-top:16px">Customer Chat Review</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px"><tr>
      <td style="font-family:${FONT};font-size:14px;line-height:20px;color:#a9bcc6;padding-right:24px">${esc(summary.windowShort)}</td>
      <td style="font-family:${FONT};font-size:14px;line-height:20px;color:#a9bcc6">${esc(String(stats.messages))} messages</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:28px 32px 8px">
    ${note ? p(note, 'padding-bottom:16px;color:#0b5c63') : ''}
    ${summary.verdict ? p(esc(summary.verdict)) : p('No AI narrative (low activity in window). See the attached report for details.', 'color:#66727d')}
  </td></tr>
  ${rows.length ? `<tr><td style="padding:16px 32px 8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join('')}</table></td></tr>` : ''}
  <tr><td style="padding:12px 32px 28px">
    ${p('The full report (with charts) is attached as an HTML file — open it in a browser.', 'font-size:14px;line-height:21px;color:#66727d')}
    <div style="border-top:1px solid #e3e7ea;margin-top:20px;padding-top:16px;font-family:${FONT};font-size:12px;line-height:18px;color:#8d97a0">Automated report from Sonar. Confidential — internal use only.</div>
  </td></tr>
</table>
</td></tr></table>
</body></html>`
}

// --- scheduling loop ---
function scheduleNext() {
  if (timer) { clearTimeout(timer); timer = null }
  if (!_cfg || !_cfg.enabled) { console.log('  scheduler: disabled'); return }
  const at = nextRunAt()
  if (!at) { console.log('  scheduler: no upcoming run (check times/cadence)'); return }
  const delay = Math.max(1000, at - Date.now())
  timer = setTimeout(async () => {
    try {
      const r = await runDaily()
      console.log(`  scheduler: report #${r.id} — ${r.stats.messages} msgs (window ${r.days}d), emailed ${r.emailed}/${r.recipients}${r.emailError ? ' (email error: ' + r.emailError + ')' : ''}`)
    } catch (e) { console.error('  scheduler: report failed:', e?.message || e) }
    scheduleNext()
  }, delay)
  if (timer.unref) timer.unref()
  console.log(`  scheduler: next report ${fmtInTz(at)} (${_cfg.tz}) · every ${_cfg.intervalDays}d · window ${_cfg.windowDays}d`)
}

async function start() { await load(); scheduleNext() }
function stop() { if (timer) clearTimeout(timer); timer = null }

const timesLabel = () => (_cfg ? _cfg.times : []).map((t) => `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}`)
function status() {
  const c = _cfg || defaults()
  const at = c.enabled ? nextRunAt() : null
  return {
    enabled: c.enabled,
    times: timesLabel(),
    timesLabel: timesLabel().join(', '),
    intervalDays: c.intervalDays,
    windowDays: c.windowDays,
    tz: c.tz,
    nextRun: at,
    nextRunLabel: at ? fmtInTz(at) : null,
    smtpConfigured: mailer.isConfigured(),
    from: mailer.from(),
  }
}
function getConfig() { const c = _cfg || defaults(); return { enabled: c.enabled, times: timesLabel(), intervalDays: c.intervalDays, windowDays: c.windowDays, tz: c.tz } }

module.exports = { start, stop, reload: load, save, runDaily, status, getConfig, nextRunAt, emailBody }

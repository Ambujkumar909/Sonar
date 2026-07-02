// =============================================================
//  Sonar — WhatsApp activity report (shared builder)
//  Used by the /api/report endpoint and the CLI generator.
//  Reads the platform's own Postgres data and returns HTML.
//  Team vs Dealer is derived from message direction (from_me).
// =============================================================
const store = require('./store')
const aiReport = require('./aiReport')

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0)
const clip = (s, n = 90) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s }
const IN = (opts) => (ms) => (ms ? new Date(Number(ms)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', ...opts }) : '—')
const fmtDateTime = IN({ day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const fmtDate = IN({ day: '2-digit', month: 'short', year: 'numeric' })

const CSS = `
:root{--ink:#1f2933;--mut:#52606d;--line:#e4e7eb;--head:#0b3d59;--accent:#0a6;}
*{box-sizing:border-box}
body{font-family:'Segoe UI',Calibri,Arial,sans-serif;color:var(--ink);line-height:1.55;max-width:1000px;margin:0 auto;padding:32px 44px;background:#fff;font-size:15px}
h1{font-size:26px;color:var(--head);border-bottom:3px solid var(--head);padding-bottom:10px;margin:0 0 14px}
h2{font-size:19px;color:var(--head);margin-top:30px;border-bottom:1px solid var(--line);padding-bottom:6px}
strong{color:#0b2e3f}em{color:#3a4a52}
table{border-collapse:collapse;width:100%;margin:14px 0;font-size:13px}
th,td{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}
th{background:var(--head);color:#fff;font-weight:600}
tr:nth-child(even) td{background:#f7f9fb}
hr{border:none;border-top:1px solid var(--line);margin:24px 0}
ul{padding-left:22px}
.meta{color:var(--mut);font-size:14px;margin:2px 0}
.note{margin:16px 0;padding:12px 16px;background:#eef6fb;border:1px solid #bcd9ea;border-radius:6px;font-size:13.5px;color:#234b5e}
.crit{margin:16px 0;padding:12px 16px;background:#fdecec;border:1px solid #f3b9b9;border-radius:6px;font-size:13.5px;color:#7a1c1c}
.num{text-align:right;font-variant-numeric:tabular-nums}
`

function shell(inner, title) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>${inner}</body></html>`
}

// ids: undefined/null = all sessions; [] = no access; [..] = scoped
async function generateReport({ ids, days = null, ai = false, generatedAt = Date.now() } = {}) {
  const scoped = Array.isArray(ids)
  const genOn = fmtDateTime(generatedAt)
  const title = "D'Decor — WhatsApp Activity Report"

  if (scoped && ids.length === 0) {
    return { html: shell(`<h1>${title}</h1><p class="meta"><strong>Generated:</strong> ${esc(genOn)}</p><div class="crit"><strong>No sessions granted.</strong> You don't have access to any monitored sessions yet.</div>`, title), stats: { messages: 0, chats: 0, sessions: 0 } }
  }

  const q = (sql, params) => store.pool.query(sql, params)
  // message filter: session scope (if any) + optional time window
  const conds = [], p = []
  if (scoped) { p.push(ids); conds.push(`session_id = ANY($${p.length})`) }
  if (days) { p.push(generatedAt - days * 86400000); conds.push(`ts >= $${p.length}`) }
  const filt = conds.length ? ' WHERE ' + conds.join(' AND ') : ''

  const t = (await q(`SELECT COUNT(*)::int n, COALESCE(SUM(from_me),0)::int team,
      COUNT(DISTINCT (session_id, chat_jid))::int chats, MIN(ts) mn, MAX(ts) mx
    FROM messages${filt}`, p)).rows[0] || {}
  const range = { mn: t.mn, mx: t.mx }
  const totalMsgs = t.n || 0, totalTeam = t.team || 0, totalDealer = totalMsgs - totalTeam, chatCount = t.chats || 0

  const windowLabel = days ? `Last ${days} day${days > 1 ? 's' : ''}` : 'All captured data'
  let h = `<h1>${title}</h1>
<p class="meta"><strong>Window:</strong> ${esc(windowLabel)} &nbsp;|&nbsp; <strong>Data range:</strong> ${fmtDate(range.mn)} → ${fmtDate(range.mx)} &nbsp;|&nbsp; <strong>Generated:</strong> ${esc(genOn)}</p>
<p class="meta"><strong>Coverage:</strong> ${chatCount} chats monitored</p>
<p class="meta"><strong>Volume:</strong> ${totalMsgs.toLocaleString('en-IN')} messages — <strong>${totalTeam.toLocaleString('en-IN')} team (${pct(totalTeam, totalMsgs)}%) / ${totalDealer.toLocaleString('en-IN')} dealer (${pct(totalDealer, totalMsgs)}%)</strong></p>`

  if (totalMsgs === 0) {
    h += `<div class="crit"><strong>No messages captured yet.</strong> There is no stored chat data to report on. This is expected until a WhatsApp session is linked and it captures watchlisted chats.</div>`
    return { html: shell(h, title), stats: { messages: 0, chats: 0 } }
  }

  h += `<div class="note"><strong>About this report.</strong> Generated from Sonar's captured WhatsApp chats. <em>Team vs Dealer</em> is derived from message direction (outgoing = team; incoming = dealer).</div>`

  // AI narrative sections (executive summary, escalations, service quality, action list)
  if (ai) {
    try {
      const a = await aiReport.analyze({ ids, days, generatedAt })
      h += '<hr>' + a.html
    } catch (e) {
      h += `<div class="crit"><strong>AI analysis unavailable.</strong> ${esc(e.message)}</div>`
    }
  } else {
    h += `<div class="note">Click <strong>Generate AI report</strong> for the full analysis — executive summary, critical escalations, service-quality assessment, and consolidated action list.</div>`
  }

  h += `<hr>
<h2>Methodology &amp; Caveats</h2>
<ul>
<li>Generated from Sonar's captured WhatsApp chats — only watchlisted chats are captured.</li>
<li><strong>Team vs Dealer</strong> uses message direction (outgoing = team, incoming = dealer).</li>
<li>PO numbers, quantities, and quotes in the AI analysis are as stated in-chat — cross-check ERP for transaction-grade accuracy.</li>
</ul>`

  return { html: shell(h, title), stats: { messages: totalMsgs, chats: chatCount } }
}

module.exports = { generateReport }

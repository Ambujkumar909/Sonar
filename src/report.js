// =============================================================
//  Sonar — WhatsApp activity report (shared builder)
//  Used by the /api/report endpoint and the CLI generator.
//  Reads the platform's own Postgres data and returns HTML.
//  Team vs Dealer is derived from message direction (from_me).
// =============================================================
const store = require('./store')

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0)
const clip = (s, n = 90) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s }
const IN = (opts) => (ms) => (ms ? new Date(Number(ms)).toLocaleString('en-IN', opts) : '—')
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
async function generateReport({ ids, generatedAt = Date.now() } = {}) {
  const scoped = Array.isArray(ids)
  const genOn = fmtDateTime(generatedAt)
  const title = "D'Decor — WhatsApp Activity Report"

  if (scoped && ids.length === 0) {
    return { html: shell(`<h1>${title}</h1><p class="meta"><strong>Generated:</strong> ${esc(genOn)}</p><div class="crit"><strong>No sessions granted.</strong> You don't have access to any monitored sessions yet.</div>`, title), stats: { messages: 0, chats: 0, sessions: 0 } }
  }

  const q = (sql, params) => store.pool.query(sql, params)
  const filt = scoped ? ' WHERE session_id = ANY($1)' : ''
  const p = scoped ? [ids] : []

  const sessions = (await q('SELECT id, name FROM sessions' + (scoped ? ' WHERE id = ANY($1)' : ''), p)).rows
  const nameById = Object.fromEntries(sessions.map((s) => [s.id, s.name]))

  const chats = (await q(`SELECT session_id, chat_jid, chat_name, is_group,
      COUNT(*)::int n, COALESCE(SUM(from_me),0)::int team, MAX(ts) last_ts
    FROM messages${filt} GROUP BY session_id, chat_jid, chat_name, is_group ORDER BY n DESC`, p)).rows

  const lastMsgs = (await q(`SELECT DISTINCT ON (session_id, chat_jid) session_id, chat_jid, chat_name, from_me, ts, text, has_media
    FROM messages${filt} ORDER BY session_id, chat_jid, ts DESC`, p)).rows

  const range = (await q(`SELECT MIN(ts) mn, MAX(ts) mx FROM messages${filt}`, p)).rows[0] || {}

  const totalMsgs = chats.reduce((a, c) => a + c.n, 0)
  const totalTeam = chats.reduce((a, c) => a + c.team, 0)
  const totalDealer = totalMsgs - totalTeam

  let h = `<h1>${title}</h1>
<p class="meta"><strong>Data window:</strong> ${fmtDate(range.mn)} → ${fmtDate(range.mx)} &nbsp;|&nbsp; <strong>Generated:</strong> ${esc(genOn)}</p>
<p class="meta"><strong>Coverage:</strong> ${chats.length} chats across ${sessions.length} session(s)</p>
<p class="meta"><strong>Volume:</strong> ${totalMsgs.toLocaleString('en-IN')} messages — <strong>${totalTeam.toLocaleString('en-IN')} team (${pct(totalTeam, totalMsgs)}%) / ${totalDealer.toLocaleString('en-IN')} dealer (${pct(totalDealer, totalMsgs)}%)</strong></p>`

  if (totalMsgs === 0) {
    h += `<div class="crit"><strong>No messages captured yet.</strong> There is no stored chat data to report on. This is expected until a WhatsApp session is linked and it captures watchlisted chats.</div>`
    return { html: shell(h, title), stats: { messages: 0, chats: 0, sessions: sessions.length } }
  }

  // per-session rollup
  const bySession = {}
  for (const c of chats) {
    ;(bySession[c.session_id] ||= { chats: 0, n: 0, team: 0, top: [] })
    const b = bySession[c.session_id]; b.chats++; b.n += c.n; b.team += c.team; b.top.push(c)
  }
  const sessionRows = Object.entries(bySession).map(([sid, v]) => ({
    name: nameById[sid] || sid, chats: v.chats, n: v.n, team: v.team, dealer: v.n - v.team,
    busiest: v.top.sort((a, b) => b.n - a.n).slice(0, 4).map((c) => c.chat_name || '—').join(', '),
  })).sort((a, b) => b.n - a.n)

  const awaiting = lastMsgs.filter((m) => !m.from_me).sort((a, b) => Number(b.ts) - Number(a.ts))

  h += `<div class="note"><strong>About this report.</strong> Auto-generated from Sonar's captured WhatsApp data. <em>Team vs Dealer</em> is derived from message direction (the monitored account's outgoing = team; incoming = dealer). Tables are exact; qualitative issue analysis (escalations, quotes) is not auto-generated here.</div><hr>

<h2>1. Session Activity Snapshot</h2>
<table><tr><th>Session</th><th class="num">Chats</th><th class="num">Msgs</th><th>Team / Dealer</th><th>Busiest chats</th></tr>
${sessionRows.map((s) => `<tr><td><strong>${esc(s.name)}</strong></td><td class="num">${s.chats}</td><td class="num">${s.n}</td><td>${s.team} / ${s.dealer}</td><td>${esc(s.busiest)}</td></tr>`).join('')}
</table><hr>

<h2>2. Busiest Chats</h2>
<table><tr><th>#</th><th>Chat</th><th>Session</th><th>Type</th><th class="num">Msgs</th><th>Team / Dealer</th><th>Last activity</th></tr>
${chats.slice(0, 25).map((c, i) => `<tr><td class="num">${i + 1}</td><td><strong>${esc(c.chat_name || '—')}</strong></td><td>${esc(nameById[c.session_id] || c.session_id)}</td><td>${c.is_group ? 'Group' : 'Direct'}</td><td class="num">${c.n}</td><td>${c.team} / ${c.n - c.team}</td><td>${fmtDateTime(c.last_ts)}</td></tr>`).join('')}
</table><hr>

<h2>3. Awaiting Reply — last message was from the dealer</h2>
<table><tr><th>Chat</th><th>Session</th><th>Last dealer message</th><th>When</th></tr>
${awaiting.slice(0, 30).map((m) => `<tr><td><strong>${esc(m.chat_name || '—')}</strong></td><td>${esc(nameById[m.session_id] || m.session_id)}</td><td>${m.has_media && !m.text ? '<em>[media]</em>' : esc(clip(m.text))}</td><td>${fmtDateTime(m.ts)}</td></tr>`).join('')}
</table>${awaiting.length > 30 ? `<p class="meta">…and ${awaiting.length - 30} more.</p>` : ''}<hr>

<h2>4. Methodology &amp; Caveats</h2>
<ul>
<li>Generated from Sonar's <code>messages</code> table — only watchlisted chats are captured, so coverage reflects what Sonar was configured to monitor.</li>
<li><strong>Team vs Dealer</strong> uses message direction (<code>from_me</code>): outgoing = team, incoming = dealer.</li>
<li>"Awaiting reply" is heuristic (last message from the dealer).</li>
<li>Grouped by <strong>session</strong>. Escalation/quote analysis is omitted (needs an AI reading pass).</li>
</ul>`

  return { html: shell(h, title), stats: { messages: totalMsgs, chats: chats.length, sessions: sessions.length } }
}

module.exports = { generateReport }

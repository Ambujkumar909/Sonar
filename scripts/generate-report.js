#!/usr/bin/env node
// =============================================================
//  Sonar — WhatsApp activity report generator
//  Reads the platform's own Postgres data and writes a self-contained
//  HTML report (same visual style as the consolidated zone report).
//
//  Run INSIDE the sonar container (it has `pg` + DATABASE_URL):
//    docker cp scripts/generate-report.js sonar:/app/gen.js
//    docker exec sonar node /app/gen.js /app/logs/whatsapp-report.html
//    # output lands on the host at ./logs/whatsapp-report.html (bind mount)
//
//  Team vs Dealer is derived from from_me: the monitored account's own
//  outgoing messages = "team", incoming = "dealer".
// =============================================================
const { Pool } = require('pg')
const fs = require('fs')

const OUT = process.argv[2] || `whatsapp-report-${new Date().toISOString().slice(0, 10)}.html`
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://sonar:sonar@localhost:5432/sonar', max: 4 })

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const fmtDateTime = (ms) => ms ? new Date(Number(ms)).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
const fmtDate = (ms) => ms ? new Date(Number(ms)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'
const pct = (a, b) => b ? Math.round((a / b) * 100) : 0
const clip = (s, n = 90) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s }

const CSS = `
:root{--ink:#1f2933;--mut:#52606d;--line:#e4e7eb;--head:#0b3d59;--accent:#0a6;}
*{box-sizing:border-box}
body{font-family:'Segoe UI',Calibri,Arial,sans-serif;color:var(--ink);line-height:1.55;max-width:1000px;margin:0 auto;padding:40px 52px;background:#fff;font-size:15px}
h1{font-size:27px;color:var(--head);border-bottom:3px solid var(--head);padding-bottom:10px;margin:0 0 14px}
h2{font-size:20px;color:var(--head);margin-top:34px;border-bottom:1px solid var(--line);padding-bottom:6px}
h3{font-size:16px;color:#10485f;margin-top:22px;margin-bottom:4px}
strong{color:#0b2e3f}em{color:#3a4a52}
code{background:#f1f5f9;padding:1px 5px;border-radius:4px;font-size:90%;color:#b4005a}
table{border-collapse:collapse;width:100%;margin:14px 0;font-size:13px}
th,td{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}
th{background:var(--head);color:#fff;font-weight:600}
tr:nth-child(even) td{background:#f7f9fb}
hr{border:none;border-top:1px solid var(--line);margin:26px 0}
ul,ol{padding-left:22px}
.meta{color:var(--mut);font-size:14px;margin:2px 0}
.note{margin:16px 0;padding:12px 16px;background:#eef6fb;border:1px solid #bcd9ea;border-radius:6px;font-size:13.5px;color:#234b5e}
.crit{margin:16px 0;padding:12px 16px;background:#fdecec;border:1px solid #f3b9b9;border-radius:6px;font-size:13.5px;color:#7a1c1c}
.print-note{margin-top:40px;padding:12px 16px;background:#fff8e6;border:1px solid #f0d98c;border-radius:6px;font-size:13px;color:#7a5b00}
.tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:10px;font-weight:600;white-space:nowrap}
.t-red{background:#fdecec;color:#b3261e}.t-org{background:#fff1e0;color:#b35c00}.t-yel{background:#fff8e0;color:#8a6d00}.t-grn{background:#e6f6ee;color:#0a6b3b}
.num{text-align:right;font-variant-numeric:tabular-nums}
@media print{body{padding:0;max-width:none;font-size:11.5pt}.print-note{display:none}h2{page-break-after:avoid}tr,table,h3{page-break-inside:avoid}}
`

async function main() {
  const sessions = (await pool.query('SELECT id, name FROM sessions')).rows
  const nameById = Object.fromEntries(sessions.map((s) => [s.id, s.name]))

  const chats = (await pool.query(`
    SELECT session_id, chat_jid, chat_name, is_group,
           COUNT(*)::int AS n, COALESCE(SUM(from_me),0)::int AS team, MAX(ts) AS last_ts
    FROM messages
    GROUP BY session_id, chat_jid, chat_name, is_group
    ORDER BY n DESC`)).rows

  const lastMsgs = (await pool.query(`
    SELECT DISTINCT ON (session_id, chat_jid) session_id, chat_jid, chat_name, from_me, ts, text, has_media
    FROM messages
    ORDER BY session_id, chat_jid, ts DESC`)).rows

  const totalMsgs = chats.reduce((a, c) => a + c.n, 0)
  const totalTeam = chats.reduce((a, c) => a + c.team, 0)
  const totalDealer = totalMsgs - totalTeam
  const range = (await pool.query('SELECT MIN(ts) mn, MAX(ts) mx FROM messages')).rows[0]

  // per-session rollup
  const bySession = {}
  for (const c of chats) {
    const k = c.session_id
    ;(bySession[k] ||= { chats: [], n: 0, team: 0 })
    bySession[k].chats.push(c)
    bySession[k].n += c.n
    bySession[k].team += c.team
  }
  const sessionRows = Object.entries(bySession)
    .map(([sid, v]) => ({ sid, name: nameById[sid] || sid, chats: v.chats.length, n: v.n, team: v.team, dealer: v.n - v.team,
      busiest: v.chats.slice().sort((a, b) => b.n - a.n).slice(0, 4).map((c) => c.chat_name || '—').join(', ') }))
    .sort((a, b) => b.n - a.n)

  const awaiting = lastMsgs.filter((m) => !m.from_me).sort((a, b) => Number(b.ts) - Number(a.ts))

  // ---- build HTML ----
  const genOn = new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  let h = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>D'Decor — WhatsApp Activity Report (${fmtDate(range.mn)}–${fmtDate(range.mx)})</title><style>${CSS}</style></head><body>
<h1>D'Decor — WhatsApp Activity Report</h1>
<p class="meta"><strong>Data window:</strong> ${fmtDate(range.mn)} → ${fmtDate(range.mx)} &nbsp;|&nbsp; <strong>Generated:</strong> ${esc(genOn)}</p>
<p class="meta"><strong>Coverage:</strong> ${chats.length} chats across ${sessionRows.length} session(s)</p>
<p class="meta"><strong>Volume:</strong> ${totalMsgs.toLocaleString('en-IN')} messages — <strong>${totalTeam.toLocaleString('en-IN')} from D'Decor team (${pct(totalTeam, totalMsgs)}%) / ${totalDealer.toLocaleString('en-IN')} from dealers (${pct(totalDealer, totalMsgs)}%)</strong></p>`

  if (totalMsgs === 0) {
    h += `<div class="crit"><strong>No messages captured yet.</strong> The database has no stored messages, so there is nothing to report. This is expected until a WhatsApp session is linked and it captures watchlisted chats.</div></body></html>`
    fs.writeFileSync(OUT, h)
    console.log(`No messages in DB. Wrote placeholder report to ${OUT}`)
    await pool.end(); return
  }

  h += `<div class="note"><strong>About this report.</strong> Auto-generated from Sonar's captured WhatsApp data. <em>Team vs Dealer</em> is derived from message direction (the monitored account's outgoing = team; incoming = dealer). The quantitative tables below are exact; qualitative issue analysis (escalations, quotes, action list) is <strong>not</strong> auto-generated here — that requires an AI reading pass over the message content.</div><hr>

<h2>1. Session Activity Snapshot</h2>
<table><tr><th>Session</th><th class="num">Chats</th><th class="num">Msgs</th><th>Team / Dealer</th><th>Busiest chats</th></tr>
${sessionRows.map((s) => `<tr><td><strong>${esc(s.name)}</strong></td><td class="num">${s.chats}</td><td class="num">${s.n}</td><td>${s.team} / ${s.dealer}</td><td>${esc(s.busiest)}</td></tr>`).join('\n')}
</table><hr>

<h2>2. Busiest Chats</h2>
<table><tr><th>#</th><th>Chat</th><th>Session</th><th>Type</th><th class="num">Msgs</th><th>Team / Dealer</th><th>Last activity</th></tr>
${chats.slice(0, 25).map((c, i) => `<tr><td class="num">${i + 1}</td><td><strong>${esc(c.chat_name || '—')}</strong></td><td>${esc(nameById[c.session_id] || c.session_id)}</td><td>${c.is_group ? 'Group' : 'Direct'}</td><td class="num">${c.n}</td><td>${c.team} / ${c.n - c.team}</td><td>${fmtDateTime(c.last_ts)}</td></tr>`).join('\n')}
</table><hr>

<h2>3. Awaiting Reply — last message was from the dealer</h2>
<p>Chats whose most recent message came from the dealer side (a rough "needs a response / no closure" signal):</p>
<table><tr><th>Chat</th><th>Session</th><th>Last dealer message</th><th>When</th></tr>
${awaiting.slice(0, 30).map((m) => `<tr><td><strong>${esc(m.chat_name || '—')}</strong></td><td>${esc(nameById[m.session_id] || m.session_id)}</td><td>${m.has_media && !m.text ? '<em>[media]</em>' : esc(clip(m.text))}</td><td>${fmtDateTime(m.ts)}</td></tr>`).join('\n')}
</table>
${awaiting.length > 30 ? `<p class="meta">…and ${awaiting.length - 30} more.</p>` : ''}
<hr>

<h2>4. Methodology &amp; Caveats</h2>
<ul>
<li>Generated directly from Sonar's <code>messages</code> table — only chats on the watchlist are captured, so coverage reflects what Sonar was configured to monitor.</li>
<li><strong>Team vs Dealer</strong> uses message direction (<code>from_me</code>): outgoing from the linked account = team, incoming = dealer. This is more reliable than name-guessing.</li>
<li>"Awaiting reply" is heuristic (last message from the dealer); it does not judge whether a reply was truly needed.</li>
<li>Grouped by <strong>session</strong> (Sonar has no "zone" concept). Escalation/quote analysis is intentionally omitted — run an AI pass over the messages for that.</li>
</ul>
<div class="print-note">Tip: Ctrl+P → Save as PDF. Re-run the generator to refresh.</div>
</body></html>`

  fs.writeFileSync(OUT, h)
  console.log(`Report written to ${OUT}  (${totalMsgs} msgs, ${chats.length} chats, ${sessionRows.length} sessions)`)
  await pool.end()
}

main().catch((e) => { console.error('Report generation failed:', e.message); process.exit(1) })

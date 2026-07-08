// =============================================================
//  Sonar — D'Decor "Customer Chat Review" report template.
//  Renders the exact management-report format (header, verdict,
//  banner, KPIs, two Chart.js bar charts, escalations table,
//  all-groups table, recommendations, footer).
//
//  Charts use Chart.js (identical to the reference report). The
//  library is INLINED into the document (no CDN) so the report is
//  self-contained — it renders in the dashboard iframe AND works
//  offline when the HTML file is downloaded. The report responses
//  carry a scoped CSP that permits these inline scripts (see
//  server.js); the app's own strict CSP is unchanged.
// =============================================================
const fs = require('fs')
const path = require('path')

// Vendored Chart.js 4.4.1 (same version the reference uses). Loaded once.
const CHARTJS = fs.readFileSync(path.join(__dirname, 'vendor', 'chart.umd.min.js'), 'utf8')

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
// Safe to embed inside a <script> block: neutralise </script> and comment breakouts.
const jsonSafe = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')

// Limited inline markdown -> HTML (escaped first). Supports **bold**, *italic*,
// and blank-line paragraph breaks — keeps the verdict/issue emphasis of the
// reference without allowing raw HTML from the model.
function md(s) {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>')
}
const paras = (t) => String(t || '').split(/\n{2,}/).map((x) => x.trim()).filter(Boolean).map((x) => `<p>${md(x)}</p>`).join('')

const PAL = { ACC: '#c8102e', AMBER: '#e0a800', GREEN: '#1f9d55', BLUE: '#2f6fb0', NAVY: '#1b4571', GREY: '#9aa6b2', GOLD: '#b8860b' }
const pillColor = (cls) => ({ 'p-red': PAL.ACC, 'p-amber': PAL.AMBER, 'p-green': PAL.GREEN, 'p-grey': PAL.GREY }[cls] || PAL.NAVY)
const CONCERN_COLORS = [PAL.ACC, PAL.ACC, PAL.AMBER, PAL.AMBER, PAL.AMBER, PAL.BLUE, PAL.BLUE, PAL.GREY, PAL.GREY]

const CSS = `
:root{--navy:#0f2c4d;--navy2:#1b4571;--accent:#c8102e;--gold:#b8860b;--bg:#eef1f5;--card:#fff;--ink:#1d2733;--muted:#667085;--green:#1f9d55;--amber:#e0a800;--blue:#2f6fb0;}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--ink);line-height:1.45}
header{background:linear-gradient(120deg,#0f2c4d,#1b4571);color:#fff;padding:26px 34px;box-shadow:0 2px 10px rgba(0,0,0,.18)}
header h1{font-size:22px;font-weight:700;letter-spacing:.3px}
header .sub{opacity:.85;font-size:13.5px;margin-top:5px}
header .tag{display:inline-block;margin-top:10px;background:rgba(255,255,255,.14);padding:4px 12px;border-radius:20px;font-size:12px}
.wrap{max-width:1320px;margin:0 auto;padding:24px 30px 60px}
.verdict{background:#fff;border-left:6px solid var(--accent);border-radius:8px;padding:18px 22px;margin-bottom:14px;box-shadow:0 1px 6px rgba(0,0,0,.07)}
.verdict h2{font-size:15px;color:var(--accent);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
.verdict p{font-size:14.5px;color:#33414f;margin-top:6px}
.banner{display:flex;gap:14px;margin-bottom:24px}
.banner .b{flex:1;border-radius:8px;padding:12px 16px;font-size:13px;color:#fff}
.banner .good{background:linear-gradient(120deg,#1f9d55,#2bbf6c)}
.banner .bad{background:linear-gradient(120deg,#c8102e,#e23b54)}
.banner .warn{background:linear-gradient(120deg,#b8860b,#d9a521)}
.banner b{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.6px;opacity:.9;margin-bottom:2px}
.kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:14px;margin-bottom:26px}
.kpi{background:var(--card);border-radius:10px;padding:16px 14px;box-shadow:0 1px 6px rgba(0,0,0,.07);border-top:3px solid var(--navy2)}
.kpi .v{font-size:25px;font-weight:700;color:var(--navy)}
.kpi .l{font-size:11px;color:var(--muted);margin-top:3px;text-transform:uppercase;letter-spacing:.4px}
.kpi.red{border-top-color:var(--accent)}.kpi.amber{border-top-color:var(--amber)}.kpi.green{border-top-color:var(--green)}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:18px}
.card{background:var(--card);border-radius:10px;padding:18px 20px;box-shadow:0 1px 6px rgba(0,0,0,.07)}
.card h3{font-size:14px;color:var(--navy);margin-bottom:4px}
.card .note{font-size:11.5px;color:var(--muted);margin-bottom:12px}
.c8{grid-column:span 8}.c6{grid-column:span 6}.c5{grid-column:span 5}.c7{grid-column:span 7}.c4{grid-column:span 4}.c12{grid-column:span 12}
.chartbox{position:relative;height:340px}.chartbox.sm{height:280px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eef0f3;vertical-align:top}
th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.4px}
td.t-Crit{color:var(--accent);font-weight:700}td.t-High{color:var(--accent);font-weight:600}td.t-Med{color:var(--amber);font-weight:600}td.t-Good{color:var(--green);font-weight:600}
.pill{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;color:#fff}
.p-red{background:var(--accent)}.p-amber{background:var(--amber)}.p-green{background:var(--green)}.p-grey{background:#9aa6b2}
.recos{display:grid;grid-template-columns:1fr 1fr;gap:10px 26px;font-size:13.5px}
.recos li{margin:6px 0 6px 18px}.recos h4{color:var(--accent);margin:6px 0 4px;font-size:13px;text-transform:uppercase;letter-spacing:.5px}
.ainote{background:#eef6fb;border:1px solid #bcd9ea;border-radius:8px;padding:12px 16px;font-size:12.5px;color:#234b5e;margin-bottom:18px}
.nodata{color:#98a2b3;font-size:13px;padding:24px 0}
footer{text-align:center;color:var(--muted);font-size:11.5px;margin-top:30px}
@media(max-width:1050px){.kpis{grid-template-columns:repeat(3,1fr)}.banner{flex-direction:column}.c8,.c6,.c5,.c7,.c4{grid-column:span 12}.recos{grid-template-columns:1fr}}
`

function renderReport(d) {
  const groups = d.groups || []
  const hasAI = !!d.ai

  // ---- chart datasets ----
  const topGroups = groups.slice(0, 14)
  const byAcct = topGroups.length ? {
    labels: topGroups.map((g) => g.group),
    values: topGroups.map((g) => g.msgs),
    colors: topGroups.map((g) => pillColor(g.statusCls)),
    axisTitle: 'Messages' + (d.windowShort ? ' (' + d.windowShort + ')' : ''),
  } : null
  const concern = (hasAI && d.concernMix?.length) ? {
    labels: d.concernMix.map((c) => c.label),
    values: d.concernMix.map((c) => c.count),
    colors: d.concernMix.map((_, i) => CONCERN_COLORS[i] || PAL.GREY),
  } : null

  // ---- header ----
  let h = `<header>
  <h1>${esc(d.title)}</h1>
  <div class="sub">${esc(d.subtitle)}</div>
  <span class="tag">${esc(d.tagLine)}</span>
</header>
<div class="wrap">`

  // ---- verdict ----
  if (hasAI && d.verdictHtml) {
    h += `<div class="verdict"><h2>${esc(d.verdictTitle || 'Portfolio Verdict')}</h2>${paras(d.verdictHtml)}</div>`
  } else {
    h += `<div class="ainote"><b>This is the free metrics view.</b> Click <b>✨ Generate AI report</b> for the full narrative — portfolio verdict, escalations, concern analysis, per-group read and recommendations.</div>`
  }

  // ---- banner (AI) ----
  if (hasAI && d.banner?.length) {
    h += `<div class="banner">${d.banner.slice(0, 3).map((b) =>
      `<div class="b ${b.tone === 'good' ? 'good' : b.tone === 'warn' ? 'warn' : 'bad'}"><b>${esc(b.label)}</b>${md(b.text)}</div>`).join('')}</div>`
  }

  // ---- KPIs ----
  if (d.kpis?.length) {
    h += `<div class="kpis">${d.kpis.map((k) =>
      `<div class="kpi ${k.cls || ''}"><div class="v">${esc(k.value)}</div><div class="l">${esc(k.label)}</div></div>`).join('')}</div>`
  }

  h += `<div class="grid">`

  // ---- chart: activity by account ----
  h += `<div class="card c7">
    <h3>Activity by Account (messages${d.windowShort ? ', ' + esc(d.windowShort) : ''})</h3>
    <div class="note">${esc(d.byAccountNote || 'Message volume per monitored group this window.')}</div>
    ${byAcct ? '<div class="chartbox"><canvas id="byacct"></canvas></div>' : '<div class="nodata">No data.</div>'}
  </div>`

  // ---- chart: concern mix (AI) ----
  if (concern) {
    h += `<div class="card c5">
      <h3>Concern Mix (accounts affected)</h3>
      <div class="note">${esc(d.concernMixNote || 'Issue categories by number of accounts affected.')}</div>
      <div class="chartbox sm"><canvas id="concern"></canvas></div>
    </div>`
  }

  // ---- escalations table (AI) ----
  if (hasAI && d.escalations?.length) {
    h += `<div class="card c12">
      <h3>Key Escalations / Open Items — Needs Attention</h3>
      <table>
        <thead><tr><th>Account</th><th>Severity</th><th>Issue (verbatim)</th></tr></thead>
        <tbody>${d.escalations.map((e) => {
      const cls = ['Crit', 'High', 'Med', 'Good'].includes(e.severity_class) ? e.severity_class : 'Med'
      return `<tr><td>${esc(e.account)}</td><td class="t-${cls}">${esc(e.severity_label)}</td><td>${md(e.issue)}</td></tr>`
    }).join('')}</tbody>
      </table>
    </div>`
  }

  // ---- all groups table ----
  if (groups.length) {
    h += `<div class="card c12">
      <h3>All Groups — Status &amp; Key Concern${d.windowShort ? ' (' + esc(d.windowShort) + ')' : ''}</h3>
      <table>
        <thead><tr><th>Group</th><th>Msgs</th><th>Status</th><th>Key concern / activity this window</th></tr></thead>
        <tbody>${groups.map((g) => {
      const cls = ['p-red', 'p-amber', 'p-green', 'p-grey'].includes(g.statusCls) ? g.statusCls : 'p-grey'
      return `<tr><td>${esc(g.group)}</td><td>${esc(String(g.msgs))}</td><td><span class="pill ${cls}">${esc(g.statusLabel || 'Active')}</span></td><td>${g.concern ? md(g.concern) : '—'}</td></tr>`
    }).join('')}</tbody>
      </table>
    </div>`
  }

  // ---- recommendations (AI) ----
  if (hasAI && (d.actionsImmediate?.length || d.actionsStructural?.length)) {
    h += `<div class="card c12">
      <h3>Recommended Actions</h3>
      <div class="recos">
        <div><h4>Immediate (this week)</h4><ul>${(d.actionsImmediate || []).map((a) => `<li>${md(a)}</li>`).join('')}</ul></div>
        <div><h4>Structural (30–90 days)</h4><ul>${(d.actionsStructural || []).map((a) => `<li>${md(a)}</li>`).join('')}</ul></div>
      </div>
    </div>`
  }

  h += `</div>
  <footer>${esc(d.footerNote)}</footer>
</div>`

  // ---- charts (Chart.js, inlined) ----
  // Build each Chart config as a real object and JSON-serialise it (escaped for
  // safe <script> embedding). No hand-written braces to miscount.
  const hbar = (chart, axisTitle, extraX = {}) => ({
    type: 'bar',
    data: { labels: chart.labels, datasets: [{ data: chart.values, backgroundColor: chart.colors, borderRadius: 4 }] },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true, title: { display: true, text: axisTitle }, ...extraX } },
    },
  })
  let scripts = ''
  if (byAcct || concern) {
    const init = [`Chart.defaults.font.family="'Segoe UI',Roboto,Arial,sans-serif";Chart.defaults.color="#5a6573";`]
    if (byAcct) init.push(`new Chart(document.getElementById('byacct'),${jsonSafe(hbar(byAcct, byAcct.axisTitle))});`)
    if (concern) init.push(`new Chart(document.getElementById('concern'),${jsonSafe(hbar(concern, 'Accounts affected', { ticks: { stepSize: 1 } }))});`)
    scripts = `<script>${CHARTJS}</script>\n<script>${init.join('\n')}</script>`
  }

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(d.title)}</title><style>${CSS}</style></head><body>${h}${scripts}</body></html>`
}

module.exports = { renderReport }

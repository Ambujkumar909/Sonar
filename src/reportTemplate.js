// =============================================================
//  Sonar — D'Decor "Customer Chat Review" report template (v2).
//  Dual structure: categorized ESCALATIONS (4 buckets) + categorized
//  OPPORTUNITIES (5 buckets), three Chart.js charts, all-groups table, and
//  3-column recommendations. Matches customer-chat-review-2026-08-02.html.
//
//  Charts use Chart.js inlined into the document (no CDN) so the report is
//  self-contained (renders in the dashboard iframe AND offline). Report
//  responses carry a scoped CSP that permits these inline scripts (server.js).
// =============================================================
const fs = require('fs')
const path = require('path')

const CHARTJS = fs.readFileSync(path.join(__dirname, 'vendor', 'chart.umd.min.js'), 'utf8')

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const jsonSafe = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
function md(s) {
  return esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*]+)\*/g, '<i>$1</i>')
}

const PAL = { ACC: '#c8102e', AMBER: '#e0a800', GREEN: '#1f9d55', BLUE: '#2f6fb0', NAVY: '#1b4571', GREY: '#9aa6b2', PUR: '#6b4fa0' }
const pillColor = (cls) => ({ 'p-red': PAL.ACC, 'p-amber': PAL.AMBER, 'p-green': PAL.GREEN, 'p-blue': PAL.BLUE, 'p-purple': PAL.PUR, 'p-grey': PAL.GREY }[cls] || PAL.NAVY)

// Fixed category definitions (title + styling) — the template owns these so the
// output is exact regardless of AI ordering. AI only tags each row's category.
const ESC_CATS = [
  { key: 'stock', title: '① Stock Missing / Not Available', cls: 'c-stock' },
  { key: 'dispatch', title: '② Dispatch Issue', cls: 'c-disp' },
  { key: 'quality', title: '③ Quality Issue', cls: 'c-qual' },
  { key: 'other', title: '④ All Other Issues (Portal / QR / Mapping · Ledger · Rate)', cls: 'c-other' },
]
const ESC_MIX = { other: { label: 'All other (Portal/QR/Map)', color: PAL.PUR }, stock: { label: 'Stock missing / not avail.', color: PAL.AMBER }, dispatch: { label: 'Dispatch issue', color: PAL.BLUE }, quality: { label: 'Quality issue', color: PAL.ACC } }
const OPP_CATS = [
  { key: 'bulk', title: '① Bulk / Project High-Value Demand' },
  { key: 'deal', title: '② Deal-at-Close (discount / scheme pending)' },
  { key: 'newcollection', title: '③ New-Collection / Assortment Expansion' },
  { key: 'onboarding', title: '④ New-Account / Onboarding (channel growth)' },
  { key: 'convert', title: '⑤ Convert & Save (available-but-unconfirmed + substitution)' },
]
const OPP_MIX = { bulk: 'Bulk / Project high-value', convert: 'Convert & save', newcollection: 'New-collection / assortment', onboarding: 'New-account / onboarding', deal: 'Deal-at-close (discount)' }
const sevPill = (s) => (String(s).toLowerCase().startsWith('h') ? 'p-red' : 'p-amber')

const CSS = `
:root{--navy:#0f2c4d;--navy2:#1b4571;--accent:#c8102e;--gold:#b8860b;--bg:#eef1f5;--card:#fff;--ink:#1d2733;--muted:#667085;--green:#1f9d55;--amber:#e0a800;--blue:#2f6fb0;--purple:#6b4fa0;}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--ink);line-height:1.45}
header{background:linear-gradient(120deg,#0f2c4d,#1b4571);color:#fff;padding:26px 34px;box-shadow:0 2px 10px rgba(0,0,0,.18)}
header h1{font-size:22px;font-weight:700;letter-spacing:.3px}
header .sub{opacity:.85;font-size:13.5px;margin-top:5px}
header .tag{display:inline-block;margin-top:10px;background:rgba(255,255,255,.14);padding:4px 12px;border-radius:20px;font-size:12px}
.wrap{max-width:1320px;margin:0 auto;padding:24px 30px 60px}
.banner{display:flex;gap:14px;margin:6px 0 24px}
.banner .b{flex:1;border-radius:8px;padding:12px 16px;font-size:13px;color:#fff}
.banner .good{background:linear-gradient(120deg,#1f9d55,#2bbf6c)}
.banner .bad{background:linear-gradient(120deg,#c8102e,#e23b54)}
.banner .warn{background:linear-gradient(120deg,#b8860b,#d9a521)}
.banner b{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.6px;opacity:.9;margin-bottom:2px}
.kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:14px;margin-bottom:26px}
.kpi{background:var(--card);border-radius:10px;padding:16px 14px;box-shadow:0 1px 6px rgba(0,0,0,.07);border-top:3px solid var(--navy2)}
.kpi .v{font-size:25px;font-weight:700;color:var(--navy)}
.kpi .l{font-size:11px;color:var(--muted);margin-top:3px;text-transform:uppercase;letter-spacing:.4px}
.kpi.red{border-top-color:var(--accent)}.kpi.amber{border-top-color:var(--amber)}.kpi.green{border-top-color:var(--green)}.kpi.purple{border-top-color:var(--purple)}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:18px}
.card{background:var(--card);border-radius:10px;padding:18px 20px;box-shadow:0 1px 6px rgba(0,0,0,.07)}
.card.opp{border-top:3px solid var(--green)}
.card h3{font-size:14px;color:var(--navy);margin-bottom:4px}
.card.opp h3{color:#177245}
.card .note{font-size:11.5px;color:var(--muted);margin-bottom:12px}
.c8{grid-column:span 8}.c6{grid-column:span 6}.c5{grid-column:span 5}.c7{grid-column:span 7}.c4{grid-column:span 4}.c12{grid-column:span 12}
.chartbox{position:relative;height:320px}.chartbox.sm{height:280px}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{text-align:left;padding:7px 9px;border-bottom:1px solid #eef0f3;vertical-align:top}
th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.4px}
.catrow td{background:#f4f6f9;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:.5px;font-size:11px}
.catrow.c-stock td{border-left:4px solid var(--amber)}
.catrow.c-disp td{border-left:4px solid var(--blue)}
.catrow.c-qual td{border-left:4px solid var(--accent)}
.catrow.c-other td{border-left:4px solid var(--purple)}
.catrow.c-opp td{border-left:4px solid var(--green);background:#eef7f0;color:#177245}
td.acc{font-weight:600;color:#33414f;white-space:nowrap}
.pill{display:inline-block;padding:2px 8px;border-radius:12px;font-size:10.5px;font-weight:600;color:#fff}
.p-red{background:var(--accent)}.p-amber{background:var(--amber)}.p-blue{background:var(--blue)}.p-purple{background:var(--purple)}.p-green{background:var(--green)}.p-grey{background:#9aa6b2}
.recos{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px 24px;font-size:13px}
.recos li{margin:6px 0 6px 18px}.recos h4{margin:6px 0 4px;font-size:13px;text-transform:uppercase;letter-spacing:.5px}
.recos .fix h4{color:var(--accent)}.recos .struct h4{color:var(--blue)}.recos .win h4{color:#177245}
.ainote{background:#eef6fb;border:1px solid #bcd9ea;border-radius:8px;padding:12px 16px;font-size:12.5px;color:#234b5e;margin:6px 0 18px}
.nodata{color:#98a2b3;font-size:13px;padding:24px 0}
footer{text-align:center;color:var(--muted);font-size:11.5px;margin-top:30px}
@media(max-width:1050px){.kpis{grid-template-columns:repeat(3,1fr)}.banner{flex-direction:column}.c8,.c6,.c5,.c7,.c4{grid-column:span 12}.recos{grid-template-columns:1fr}}
`

function hbarConfig(labels, data, colors, axisTitle, stepSize) {
  return {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 4 }] },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true, title: { display: true, text: axisTitle }, ...(stepSize ? { ticks: { stepSize } } : {}) } },
    },
  }
}

function renderReport(d) {
  const groups = d.groups || []
  const hasAI = !!d.ai

  // ---- chart datasets ----
  const topGroups = groups.slice(0, 15)
  const byAcct = topGroups.length ? hbarConfig(
    topGroups.map((g) => g.group), topGroups.map((g) => g.msgs), topGroups.map((g) => pillColor(g.statusCls)),
    'Messages' + (d.windowShort ? ' (' + d.windowShort + ')' : ''),
  ) : null
  let escChart = null
  if (hasAI && (d.escalationCounts || []).length) {
    const rows = d.escalationCounts.map((x) => ({ ...x, meta: ESC_MIX[x.category] })).filter((x) => x.meta).sort((a, b) => b.count - a.count)
    escChart = hbarConfig(rows.map((r) => r.meta.label), rows.map((r) => r.count), rows.map((r) => r.meta.color), 'Accounts affected', 2)
  }
  let oppChart = null
  if (hasAI && (d.opportunityCounts || []).length) {
    const rows = d.opportunityCounts.map((x) => ({ label: OPP_MIX[x.category], count: x.count })).filter((x) => x.label).sort((a, b) => b.count - a.count)
    oppChart = hbarConfig(rows.map((r) => r.label), rows.map((r) => r.count), rows.map(() => PAL.GREEN), 'Accounts with opportunity', 1)
  }

  // ---- header ----
  let h = `<header>
  <h1>${esc(d.title)}</h1>
  <div class="sub">${esc(d.subtitle)}</div>
  <span class="tag">${esc(d.tagLine)}</span>
</header>
<div class="wrap">`

  // ---- banner ----
  if (hasAI && d.banner?.length) {
    h += `<div class="banner">${d.banner.slice(0, 3).map((b) =>
      `<div class="b ${b.tone === 'good' ? 'good' : b.tone === 'warn' ? 'warn' : 'bad'}"><b>${esc(b.label)}</b>${md(b.text)}</div>`).join('')}</div>`
  } else {
    h += `<div class="ainote"><b>This is the free metrics view.</b> Click <b>✨ Generate AI report</b> for the full analysis — escalations by category, opportunities to win, and recommendations.</div>`
  }

  // ---- KPIs ----
  if (d.kpis?.length) {
    h += `<div class="kpis">${d.kpis.map((k) =>
      `<div class="kpi ${k.cls || ''}"><div class="v">${esc(k.value)}</div><div class="l">${esc(k.label)}</div></div>`).join('')}</div>`
  }

  h += `<div class="grid">`

  // ---- Activity by Account chart ----
  h += `<div class="card c8">
    <h3>Activity by Account (messages${d.windowShort ? ', ' + esc(d.windowShort) : ''})</h3>
    <div class="note">${esc(d.byAccountNote || 'Message volume per monitored group this window.')}</div>
    ${byAcct ? '<div class="chartbox"><canvas id="byacct"></canvas></div>' : '<div class="nodata">No data.</div>'}
  </div>`

  // ---- Escalations-by-category chart ----
  if (escChart) {
    h += `<div class="card c4">
      <h3>Escalations by Category (accounts affected)</h3>
      <div class="note">The four escalation buckets.</div>
      <div class="chartbox sm"><canvas id="concern"></canvas></div>
    </div>`
  }

  // ---- Key Escalations table (4 categories) ----
  if (hasAI && (d.escalations || []).length) {
    let body = ''
    for (const cat of ESC_CATS) {
      const rows = d.escalations.filter((e) => e.category === cat.key)
      if (!rows.length) continue
      body += `<tr class="catrow ${cat.cls}"><td colspan="3">${esc(cat.title)}</td></tr>`
      body += rows.map((e) => `<tr><td><span class="pill ${sevPill(e.severity)}">${esc(e.severity)}</span></td><td class="acc">${esc(e.account)}</td><td>${md(e.issue)}</td></tr>`).join('')
    }
    h += `<div class="card c12">
      <h3>Key Escalations / Open Items — by Category</h3>
      <div class="note">Four parts: Stock missing · Dispatch · Quality · All other. Quotes verbatim (Hindi context translated).</div>
      <table><thead><tr><th style="width:90px">Severity</th><th style="width:210px">Account</th><th>Issue (verbatim)</th></tr></thead><tbody>${body}</tbody></table>
    </div>`
  }

  // ---- Opportunities table (5 categories) ----
  if (hasAI && (d.opportunities || []).length) {
    let body = ''
    for (const cat of OPP_CATS) {
      const rows = d.opportunities.filter((o) => o.category === cat.key)
      if (!rows.length) continue
      body += `<tr class="catrow c-opp"><td colspan="3">${esc(cat.title)}</td></tr>`
      body += rows.map((o) => `<tr><td><span class="pill p-green">${esc(o.value)}</span></td><td class="acc">${esc(o.account)}</td><td>${md(o.signal)}</td></tr>`).join('')
    }
    h += `<div class="card opp c8">
      <h3>⭐ Opportunities to Win — by Category</h3>
      <div class="note">Winnable demand surfacing in chat. Inferential — an enquiry is not a booked order; convert &amp; confirm against ERP. Quotes verbatim.</div>
      <table><thead><tr><th style="width:120px">Value</th><th style="width:200px">Account</th><th>Signal (verbatim)</th></tr></thead><tbody>${body}</tbody></table>
    </div>`
    if (oppChart) {
      h += `<div class="card opp c4">
        <h3>Opportunities by Category (accounts)</h3>
        <div class="note">Where winnable demand is concentrated this window.</div>
        <div class="chartbox sm"><canvas id="opp"></canvas></div>
      </div>`
    }
  }

  // ---- All Groups table ----
  if (groups.length) {
    h += `<div class="card c12">
      <h3>All Groups — Status &amp; Key Concern${d.windowShort ? ' (' + esc(d.windowShort) + ')' : ''}</h3>
      <table><thead><tr><th>Group</th><th>Msgs</th><th>Status</th><th>Key concern / opportunity this window</th></tr></thead>
      <tbody>${groups.map((g) => {
      const cls = ['p-red', 'p-amber', 'p-green', 'p-blue', 'p-purple', 'p-grey'].includes(g.statusCls) ? g.statusCls : 'p-grey'
      return `<tr><td>${esc(g.group)}</td><td>${esc(String(g.msgs))}</td><td><span class="pill ${cls}">${esc(g.statusLabel || 'Active')}</span></td><td>${g.concern ? md(g.concern) : '—'}</td></tr>`
    }).join('')}</tbody></table>
    </div>`
  }

  // ---- Recommended Actions (3 columns) ----
  if (hasAI && ((d.actionsFix || []).length || (d.actionsWin || []).length || (d.actionsStructural || []).length)) {
    const col = (cls, title, items) => `<div class="${cls}"><h4>${esc(title)}</h4><ul>${(items || []).map((a) => `<li>${md(a)}</li>`).join('')}</ul></div>`
    h += `<div class="card c12">
      <h3>Recommended Actions</h3>
      <div class="recos">
        ${col('fix', 'Fix / protect (immediate)', d.actionsFix)}
        ${col('win', 'Win now', d.actionsWin)}
        ${col('struct', 'Structural (30–90 days)', d.actionsStructural)}
      </div>
    </div>`
  }

  h += `</div>
  <footer>${esc(d.footerNote)}</footer>
</div>`

  // ---- charts (Chart.js inlined) ----
  let scripts = ''
  const inits = []
  if (byAcct) inits.push(`new Chart(document.getElementById('byacct'),${jsonSafe(byAcct)});`)
  if (escChart) inits.push(`new Chart(document.getElementById('concern'),${jsonSafe(escChart)});`)
  if (oppChart) inits.push(`new Chart(document.getElementById('opp'),${jsonSafe(oppChart)});`)
  if (inits.length) {
    scripts = `<script>${CHARTJS}</script>\n<script>Chart.defaults.font.family="'Segoe UI',Roboto,Arial,sans-serif";Chart.defaults.color="#5a6573";\n${inits.join('\n')}</script>`
  }

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(d.title)}</title><style>${CSS}</style></head><body>${h}${scripts}</body></html>`
}

module.exports = { renderReport }

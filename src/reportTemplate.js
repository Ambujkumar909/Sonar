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
.tw{width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}
footer{text-align:center;color:var(--muted);font-size:11.5px;margin-top:30px}
/* ---- channel tabs (COCO / FOFO / MBO) — one report per pane, same format ----
   Pure CSS switching (hidden radios + :checked) so tabs work even where
   JavaScript is blocked (Outlook attachment preview, iOS Quick Look). JS is
   only an enhancement: it lazy-builds the charts of a pane on first open. */
.tabradio{position:absolute;width:1px;height:1px;opacity:0;margin:0;pointer-events:none}
.tabs{position:sticky;top:0;z-index:50;display:flex;background:#0a1f38;box-shadow:0 2px 10px rgba(0,0,0,.3)}
.tabbtn{flex:1;display:block;text-align:center;color:rgba(255,255,255,.6);font-size:13.5px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;padding:14px 10px;cursor:pointer;border-bottom:3px solid transparent;transition:color .15s,background-color .15s,border-color .15s;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent}
.tabbtn:hover{color:#fff}
.tabpane{display:none}
@keyframes panein{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){.tabpane{animation:none!important}}
@media(max-width:1050px){.kpis{grid-template-columns:repeat(3,1fr)}.banner{flex-direction:column}.c8,.c6,.c5,.c7,.c4{grid-column:span 12}.recos{grid-template-columns:1fr}}

/* ---- phones ---- the report is read inside a ~360px iframe, so anything
   built on fixed column widths has to be re-laid-out, not just shrunk. */
@media(max-width:760px){
  .tabbtn{font-size:12px;padding:11px 6px;letter-spacing:.8px}
  header{padding:16px 14px}
  header h1{font-size:17px;line-height:1.3}
  header .sub{font-size:12px}
  header .tag{font-size:11px;padding:3px 10px;margin-top:8px}
  .wrap{padding:14px 12px 36px}
  .grid{gap:12px}
  .banner{gap:8px;margin:4px 0 16px}
  .banner .b{font-size:12.5px;padding:10px 12px}
  .kpis{grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:16px}
  .kpi{padding:12px 10px}
  .kpi .v{font-size:21px}
  .kpi .l{font-size:10px}
  .card{padding:14px 12px;border-radius:8px}
  .card h3{font-size:13.5px}
  .card .note{font-size:11px}
  .chartbox.sm{height:250px}
  .ainote{padding:10px 12px;font-size:12px}
  /* Tables stack into per-row cards: name + pill on one line, the verbatim
     text full-width underneath. A 3–4 column table is unreadable at 360px. */
  .rt thead{display:none}
  .rt,.rt tbody{display:block;width:100%}
  .rt tr{display:flex;flex-wrap:wrap;align-items:center;gap:3px 8px;padding:9px 2px;border-bottom:1px solid #eef0f3}
  .rt td{display:block;border:0;padding:0;overflow-wrap:anywhere}
  .rt tr.catrow{display:block;padding:0}
  .rt tr.catrow td{display:block;width:100%;padding:7px 9px}
  .rt td.acc,.rt td.nm{order:1;flex:1 1 50%;min-width:0;white-space:normal;font-size:12.5px;font-weight:700;color:var(--navy)}
  .rt td.msgs{order:2;flex:0 0 auto;font-size:11px;color:var(--muted)}
  .rt td.msgs:before{content:"· "}
  .rt td.pc{order:3;flex:0 0 auto;margin-left:auto}
  .rt td.tx{order:4;flex:1 0 100%;font-size:12.5px;color:#404c5a}
  .recos{font-size:12.5px;gap:4px 0}
  .recos li{margin-left:16px}
  footer{font-size:11px;margin-top:22px}
}
`

// Keep y-axis labels short so one long account name can't eat the plot area.
const clipLabel = (s, n = 30) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }

function hbarConfig(labels, data, colors, axisTitle, stepSize) {
  return {
    type: 'bar',
    data: { labels: labels.map((l) => clipLabel(l)), datasets: [{ data, backgroundColor: colors, borderRadius: 4 }] },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false } },
      scales: {
        // precision:0 — these are counts; never show fractional ticks (e.g. "0.5 messages")
        x: { beginAtZero: true, title: { display: true, text: axisTitle }, ticks: { precision: 0, ...(stepSize ? { stepSize } : {}) } },
        // autoSkip:false — every bar keeps its label (an unlabelled bar is meaningless)
        y: { ticks: { autoSkip: false, font: { size: 11 } } },
      },
    },
  }
}

// Builds one report body (header + all sections). sfx suffixes canvas ids so
// several bodies can coexist in one document (the tabbed report). Returns the
// HTML plus the chart configs to initialize.
function buildBody(d, sfx = '') {
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

  // ---- Activity by Account chart ---- (full width when the paired chart is absent)
  h += `<div class="card ${escChart ? 'c8' : 'c12'}">
    <h3>Activity by Account (messages${d.windowShort ? ', ' + esc(d.windowShort) : ''})</h3>
    <div class="note">${esc(d.byAccountNote || 'Message volume per monitored group this window.')}</div>
    ${byAcct ? `<div class="chartbox" style="height:${Math.max(320, topGroups.length * 26 + 60)}px"><canvas id="byacct${sfx}"></canvas></div>` : '<div class="nodata">No data.</div>'}
  </div>`

  // ---- Escalations-by-category chart ----
  if (escChart) {
    h += `<div class="card c4">
      <h3>Escalations by Category (accounts affected)</h3>
      <div class="note">The four escalation buckets.</div>
      <div class="chartbox sm"><canvas id="concern${sfx}"></canvas></div>
    </div>`
  }

  // ---- Key Escalations table (4 categories) ----
  if (hasAI && (d.escalations || []).length) {
    // Any row with an unrecognised category falls into "other" — never dropped.
    const escKeys = new Set(ESC_CATS.map((c) => c.key))
    const escRows = d.escalations.map((e) => (escKeys.has(e.category) ? e : { ...e, category: 'other' }))
    let body = ''
    for (const cat of ESC_CATS) {
      const rows = escRows.filter((e) => e.category === cat.key)
      if (!rows.length) continue
      body += `<tr class="catrow ${cat.cls}"><td colspan="3">${esc(cat.title)}</td></tr>`
      body += rows.map((e) => `<tr><td class="pc"><span class="pill ${sevPill(e.severity)}">${esc(e.severity)}</span></td><td class="acc">${esc(e.account)}</td><td class="tx">${md(e.issue)}</td></tr>`).join('')
    }
    h += `<div class="card c12">
      <h3>Key Escalations / Open Items — by Category</h3>
      <div class="note">Four parts: Stock missing · Dispatch · Quality · All other. Quotes verbatim (Hindi context translated).</div>
      <div class="tw"><table class="rt"><thead><tr><th style="width:90px">Severity</th><th style="width:210px">Account</th><th>Issue (verbatim)</th></tr></thead><tbody>${body}</tbody></table></div>
    </div>`
  }

  // ---- Opportunities table (5 categories) ----
  if (hasAI && (d.opportunities || []).length) {
    // Unrecognised category -> "convert" bucket, so no opportunity is ever dropped.
    const oppKeys = new Set(OPP_CATS.map((c) => c.key))
    const oppRows = d.opportunities.map((o) => (oppKeys.has(o.category) ? o : { ...o, category: 'convert' }))
    let body = ''
    for (const cat of OPP_CATS) {
      const rows = oppRows.filter((o) => o.category === cat.key)
      if (!rows.length) continue
      body += `<tr class="catrow c-opp"><td colspan="3">${esc(cat.title)}</td></tr>`
      body += rows.map((o) => `<tr><td class="pc"><span class="pill p-green">${esc(o.value)}</span></td><td class="acc">${esc(o.account)}</td><td class="tx">${md(o.signal)}</td></tr>`).join('')
    }
    h += `<div class="card opp ${oppChart ? 'c8' : 'c12'}">
      <h3>⭐ Opportunities to Win — by Category</h3>
      <div class="note">Winnable demand surfacing in chat. Inferential — an enquiry is not a booked order; convert &amp; confirm against ERP. Quotes verbatim.</div>
      <div class="tw"><table class="rt"><thead><tr><th style="width:120px">Value</th><th style="width:200px">Account</th><th>Signal (verbatim)</th></tr></thead><tbody>${body}</tbody></table></div>
    </div>`
    if (oppChart) {
      h += `<div class="card opp c4">
        <h3>Opportunities by Category (accounts)</h3>
        <div class="note">Where winnable demand is concentrated this window.</div>
        <div class="chartbox sm"><canvas id="opp${sfx}"></canvas></div>
      </div>`
    }
  }

  // ---- All Groups table ----
  if (groups.length) {
    h += `<div class="card c12">
      <h3>All Groups — Status &amp; Key Concern${d.windowShort ? ' (' + esc(d.windowShort) + ')' : ''}</h3>
      <div class="tw"><table class="rt"><thead><tr><th>Group</th><th>Msgs</th><th>Status</th><th>Key concern / opportunity this window</th></tr></thead>
      <tbody>${groups.map((g) => {
      const cls = ['p-red', 'p-amber', 'p-green', 'p-blue', 'p-purple', 'p-grey'].includes(g.statusCls) ? g.statusCls : 'p-grey'
      return `<tr><td class="nm">${esc(g.group)}</td><td class="msgs">${esc(String(g.msgs))}</td><td class="pc"><span class="pill ${cls}">${esc(g.statusLabel || 'Active')}</span></td><td class="tx">${g.concern ? md(g.concern) : '—'}</td></tr>`
    }).join('')}</tbody></table></div>
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

  const charts = []
  if (byAcct) charts.push({ id: 'byacct' + sfx, cfg: byAcct })
  if (escChart) charts.push({ id: 'concern' + sfx, cfg: escChart })
  if (oppChart) charts.push({ id: 'opp' + sfx, cfg: oppChart })
  return { html: h, charts }
}

// mk(): builds one chart. On a phone-width canvas the 30-char y labels would
// eat most of the plot, so trim labels and tick fonts at run time (the config
// is width-agnostic).
const MK_FN = `Chart.defaults.font.family="'Segoe UI',Roboto,Arial,sans-serif";Chart.defaults.color="#5a6573";
var M=(window.innerWidth||document.documentElement.clientWidth)<620;
function mk(id,c){var el=document.getElementById(id);if(!el)return;
if(M){var n=16;c.data.labels=c.data.labels.map(function(l){l=String(l);return l.length>n?l.slice(0,n-1)+'\\u2026':l});
c.options.scales.y.ticks.font={size:9};c.options.scales.x.ticks.font={size:9};c.options.scales.x.title.font={size:10};}
new Chart(el,c);}`

const docShell = (title, body, scripts, extraCss = '') =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(title)}</title><style>${CSS}${extraCss}</style></head><body>${body}${scripts}</body></html>`

// Single-view report (used by the sample report).
function renderReport(d) {
  const { html, charts } = buildBody(d, '')
  let scripts = ''
  if (charts.length) {
    const boot = `(function(){\n${MK_FN}\n${charts.map((c) => `mk(${jsonSafe(c.id)},${jsonSafe(c.cfg)});`).join('\n')}\n})();`
    scripts = `<script>${CHARTJS}</script>\n<script>${boot}</script>`
  }
  return docShell(d.title, html, scripts)
}

// Tabbed report — one tab per channel (COCO / FOFO / MBO), each pane holding a
// full report in the same format. Switching is PURE CSS (hidden radios +
// :checked ~ pane) so it works with JavaScript blocked (Outlook preview).
// JS only lazy-builds a pane's charts on first open (Chart.js can't size a
// canvas inside display:none — and needs JS anyway).
// tabs: [{ key, label, data }] — first tab starts active. key must be a plain
// slug (it is used inside CSS selectors).
function renderTabbedReport({ title, tabs }) {
  const bodies = tabs.map((t, i) => ({ key: t.key, label: t.label, active: i === 0, ...buildBody(t.data, '-' + t.key) }))
  const radios = bodies.map((b) =>
    `<input type="radio" name="ctab" id="tab-${esc(b.key)}" class="tabradio" data-tab="${esc(b.key)}"${b.active ? ' checked' : ''}>`).join('')
  const bar = `<nav class="tabs">${bodies.map((b) =>
    `<label class="tabbtn" for="tab-${esc(b.key)}">${esc(b.label)}</label>`).join('')}</nav>`
  const panes = bodies.map((b) => `<div class="tabpane" id="pane-${esc(b.key)}">${b.html}</div>`).join('\n')
  // Radios sit before the nav and the panes, so :checked drives both the
  // active-tab styling and pane visibility via the sibling (~) combinator.
  const tabCss = bodies.map((b) => `
#tab-${b.key}:checked~#pane-${b.key}{display:block;animation:panein .22s ease}
#tab-${b.key}:checked~.tabs .tabbtn[for="tab-${b.key}"]{color:#fff;border-bottom-color:var(--accent);background:rgba(255,255,255,.07)}
#tab-${b.key}:focus-visible~.tabs .tabbtn[for="tab-${b.key}"]{outline:2px solid var(--gold);outline-offset:-2px}`).join('')

  const chartsByTab = {}
  for (const b of bodies) chartsByTab[b.key] = b.charts
  const anyCharts = bodies.some((b) => b.charts.length)
  const boot = `(function(){
${anyCharts ? MK_FN : 'function mk(){}'}
var CH=${jsonSafe(chartsByTab)},made={};
function initCharts(k){if(made[k])return;made[k]=1;var a=CH[k]||[];for(var i=0;i<a.length;i++)mk(a[i].id,a[i].cfg);}
var rs=document.querySelectorAll('.tabradio');
for(var i=0;i<rs.length;i++)rs[i].addEventListener('change',function(){if(this.checked){initCharts(this.getAttribute('data-tab'));window.scrollTo(0,0);}});
initCharts(${jsonSafe(bodies[0] ? bodies[0].key : '')});
})();`
  const scripts = (anyCharts ? `<script>${CHARTJS}</script>\n` : '') + `<script>${boot}</script>`
  return docShell(title, radios + bar + panes, scripts, tabCss)
}

module.exports = { renderReport, renderTabbedReport }

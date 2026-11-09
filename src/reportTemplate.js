// =============================================================
//  Sonar — "Customer Chat Review" report template (v3).
//  One combined report: banner, KPIs, three bar charts, categorized
//  ESCALATIONS (4 buckets) + OPPORTUNITIES (5 buckets), all-groups table
//  and 3-column recommendations.
//
//  Built to render the same everywhere the report is opened: browsers,
//  phones, the dashboard iframe and Outlook's attachment preview. So:
//  no JavaScript (charts are plain HTML bars), no CSS variables or grid
//  (old Outlook/IE engines ignore them) and system fonts only (the report
//  CSP allows no font downloads). Colours live in the T token object below.
// =============================================================

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
function md(s) {
  return esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*]+)\*/g, '<i>$1</i>')
}

// ---- tokens (written into the CSS as literals so legacy engines get them) ----
const T = {
  mast: '#0c2330', mastInk: '#f7fafb', mastSoft: '#a9bcc6', mastLine: '#2e4a58',
  page: '#e8ecee', sheet: '#fcfdfd', line: '#e3e7ea', lineSoft: '#edf0f2', well: '#f5f7f8',
  ink: '#14202a', ink2: '#3d4a55', muted: '#66727d', faint: '#8d97a0',
  accent: '#0f7a84',
  sans: `"Segoe UI Variable Text","Segoe UI",-apple-system,BlinkMacSystemFont,"Helvetica Neue",Helvetica,Arial,sans-serif`,
  display: `"Segoe UI Variable Display","Segoe UI",-apple-system,BlinkMacSystemFont,"Helvetica Neue",Helvetica,Arial,sans-serif`,
}
// Semantic tones: solid (bars, rails), tint (pill/panel ground), text (on tint), mast (on the dark masthead).
const TONE = {
  red: { solid: '#b42318', tint: '#fdecea', text: '#8a1c13', mast: '#f06a5e' },
  amber: { solid: '#b7791f', tint: '#fdf3e1', text: '#7a4f0f', mast: '#f2b441' },
  green: { solid: '#1e7f4f', tint: '#e6f4ec', text: '#145c38', mast: '#3cc286' },
  blue: { solid: '#2563a6', tint: '#e8f0fa', text: '#1b4a7c', mast: '#7fb2e8' },
  purple: { solid: '#6a4c9c', tint: '#f0ebf8', text: '#4e3878', mast: '#a68be0' },
  grey: { solid: '#8a939c', tint: '#eef0f2', text: '#4f5861', mast: '#9aa8b2' },
  teal: { solid: T.accent, tint: '#e3f2f3', text: '#0b5c63', mast: '#5fb7c0' },
}
const PILL_TONE = { 'p-red': 'red', 'p-amber': 'amber', 'p-green': 'green', 'p-blue': 'blue', 'p-purple': 'purple', 'p-grey': 'grey' }
const pillColor = (cls) => (TONE[PILL_TONE[cls]] || TONE.teal).solid

// Fixed category definitions (title + styling) — the template owns these so the
// output is exact regardless of AI ordering. AI only tags each row's category.
const ESC_CATS = [
  { key: 'stock', title: '① Stock Missing / Not Available', tone: 'amber' },
  { key: 'dispatch', title: '② Dispatch Issue', tone: 'blue' },
  { key: 'quality', title: '③ Quality Issue', tone: 'red' },
  { key: 'other', title: '④ All Other Issues (Portal / QR / Mapping · Ledger · Rate)', tone: 'purple' },
]
const ESC_MIX = { other: { label: 'All other (Portal/QR/Map)', tone: 'purple' }, stock: { label: 'Stock missing / not avail.', tone: 'amber' }, dispatch: { label: 'Dispatch issue', tone: 'blue' }, quality: { label: 'Quality issue', tone: 'red' } }
const OPP_CATS = [
  { key: 'bulk', title: '① Bulk / Project High-Value Demand' },
  { key: 'deal', title: '② Deal-at-Close (discount / scheme pending)' },
  { key: 'newcollection', title: '③ New-Collection / Assortment Expansion' },
  { key: 'onboarding', title: '④ New-Account / Onboarding (channel growth)' },
  { key: 'convert', title: '⑤ Convert & Save (available-but-unconfirmed + substitution)' },
]
const OPP_MIX = { bulk: 'Bulk / Project high-value', convert: 'Convert & save', newcollection: 'New-collection / assortment', onboarding: 'New-account / onboarding', deal: 'Deal-at-close (discount)' }
const sevTone = (s) => (String(s).toLowerCase().startsWith('h') ? 'red' : 'amber')
const KPI_TONE = { red: 'red', amber: 'amber', green: 'green', purple: 'purple' }
const BANNER_TONE = { good: 'green', warn: 'amber', bad: 'red' }

const pill = (tone, text) => `<span class="pill t-${tone}">${esc(text)}</span>`

const toneCss = Object.entries(TONE).map(([k, c]) =>
  `.t-${k}{background:${c.tint};color:${c.text}}.g-${k}{background:${c.tint}}.r-${k}{border-left-color:${c.solid}}.k-${k}{border-top-color:${c.mast}}.h-${k}{color:${c.solid}}`).join('\n')

const CSS = `/* Hallmark · redesign: full · scope: document · theme: custom · idea: "signal from noise — hundreds of chats read down to a few signals, set like a printed dossier" · vibe: "calm, exact, executive, harbour navy" · paper: cool grey desk, white sheet · accent: harbour teal ${T.accent} · faces: system sans (report CSP allows no font downloads) · posture: light/grotesk/chromatic-teal · copy: verbatim (titles, notes and data are the report's own) */
/* critique: the old report was a dashboard skin (navy gradient, shadowed tiles, uppercase tracked labels, JS charts that vanish in Outlook preview); this one is a document: one sheet, hairline rules, figures set large, bars that need no script */
/* note 48 · colours are written as literals from the T token object in reportTemplate.js: Outlook's attachment preview runs the legacy IE engine, which drops CSS custom properties, so a :root token block would leave the report colourless there */
html,body{overflow-x:clip}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:${T.sans};background:${T.page};color:${T.ink};font-size:15px;line-height:1.5;-webkit-text-size-adjust:100%;text-size-adjust:100%;font-variant-numeric:tabular-nums lining-nums}
b{font-weight:600;color:${T.ink}}
.sheet{max-width:1200px;margin:28px auto 40px;background:${T.sheet};box-shadow:0 1px 2px rgba(12,35,48,.06),0 12px 40px rgba(12,35,48,.08)}

/* masthead */
.mast{background:${T.mast};color:${T.mastInk};padding:36px 44px 0}
.brand{font-size:13px;font-weight:600;color:${T.mastSoft};margin-bottom:24px}
.brand span{color:${TONE.teal.mast}}
.mast h1{font-family:${T.display};font-size:34px;line-height:1.15;font-weight:600;letter-spacing:-.3px;overflow-wrap:break-word;min-width:0;max-width:880px;text-wrap:balance}
.sub{color:${T.mastSoft};font-size:14px;margin-top:12px}
.sub span{display:inline-block;margin-right:20px}
.tags{margin-top:16px}
.tag{display:inline-block;border:1px solid ${T.mastLine};border-radius:999px;padding:4px 12px;margin:0 8px 8px 0;font-size:13px;color:${T.mastInk}}
.kpis{display:-ms-flexbox;display:flex;-ms-flex-wrap:wrap;flex-wrap:wrap;margin:28px -44px 0;border-top:1px solid ${T.mastLine}}
.kpi{-ms-flex:1 1 0%;flex:1 1 0%;min-width:0;padding:20px 24px 24px;border-right:1px solid ${T.mastLine};border-top:3px solid ${TONE.teal.mast};margin-top:-1px}
.kpi:last-child{border-right:0}
.kpi .v{font-family:${T.display};font-size:36px;line-height:1.05;font-weight:300;letter-spacing:-.5px;color:${T.mastInk};overflow-wrap:break-word}
.kpi .l{font-size:13px;line-height:1.35;color:${T.mastSoft};margin-top:8px}

/* body */
.body{padding:32px 44px 40px}
.banner{display:-ms-flexbox;display:flex;-ms-flex-wrap:wrap;flex-wrap:wrap;margin:0 -8px 8px}
.bcell{width:33.333%;padding:0 8px 16px}
.b{height:100%;border-left-width:4px;border-left-style:solid;padding:16px;font-size:14.5px;line-height:1.5;color:${T.ink2}}
.b .bl{display:block;font-weight:600;font-size:14.5px;margin-bottom:4px}
.ainote{background:${TONE.teal.tint};border-left:4px solid ${T.accent};padding:16px;font-size:14.5px;color:${TONE.teal.text};margin-bottom:24px}
.ainote b{color:${TONE.teal.text}}
.row{display:-ms-flexbox;display:flex;-ms-flex-wrap:wrap;flex-wrap:wrap;margin:0 -16px}
.col{padding:0 16px}
.w12{width:100%}.w8{width:66.666%}.w4{width:33.333%}
.sec{border-top:1px solid ${T.line};padding:28px 0 32px}
.sec h2{font-family:${T.display};font-size:19px;line-height:1.3;font-weight:600;color:${T.ink};overflow-wrap:break-word;min-width:0;text-wrap:balance}
.note{font-size:13.5px;color:${T.muted};margin:4px 0 16px;max-width:760px}
.nodata{color:${T.faint};font-size:14px;padding:20px 0}

/* bar charts — plain HTML, scale = widest bar */
.bars{width:100%;border-collapse:collapse}
.bars td{padding:8px 0;vertical-align:middle;border:0}
.bars .bl{width:38%;padding-right:16px;font-size:13px;line-height:1.3;color:${T.ink2};overflow-wrap:anywhere}
.bars .bt{background:transparent}
.track{background:${T.lineSoft};height:12px;border-radius:6px}
.bar{height:12px;border-radius:6px;min-width:3px}
.bars .bv{width:48px;padding-left:12px;text-align:right;font-size:13px;font-weight:500;color:${T.ink}}
.axis{font-size:12.5px;color:${T.muted};margin-top:12px;padding-left:38%}

/* tables */
.tw{width:100%}
table.rt{width:100%;border-collapse:collapse;font-size:14px}
.rt th{text-align:left;font-weight:600;font-size:12.5px;color:${T.muted};padding:0 12px 12px 0;border-bottom:1px solid ${T.line}}
.rt td{text-align:left;padding:12px 12px 12px 0;border-bottom:1px solid ${T.lineSoft};vertical-align:top;line-height:1.5}
.rt td.tx{color:${T.ink2}}
.rt td.acc,.rt td.nm{font-weight:500;color:${T.ink}}
.rt td.msgs{color:${T.ink};white-space:nowrap}
.rt tr.catrow td{background:${T.well};border-left-width:3px;border-left-style:solid;padding:8px 12px;font-weight:500;font-size:13.5px;color:${T.ink};border-bottom:0}
.rt tr.catrow + tr td{border-top:0}
.pill{display:inline-block;padding:2px 12px;border-radius:999px;font-size:12.5px;line-height:1.5;font-weight:500;white-space:nowrap}

/* recommendations */
.recos{display:-ms-flexbox;display:flex;-ms-flex-wrap:wrap;flex-wrap:wrap;margin:8px -12px 0}
.rcol{width:33.333%;padding:0 12px}
.rbox{border-top:3px solid;padding-top:16px;height:100%}
.rbox h3{font-size:15px;font-weight:600;margin-bottom:8px}
.rbox ol{padding-left:20px;font-size:14px;color:${T.ink2}}
.rbox li{margin:0 0 12px;padding-left:2px;line-height:1.5}

.foot{border-top:1px solid ${T.line};padding-top:20px;font-size:12.5px;line-height:1.6;color:${T.muted};max-width:900px}
${toneCss}
.k-none{border-top-color:${TONE.teal.mast}}

/* laptop / tablet */
@media (max-width:1050px){
  .mast{padding:28px 28px 0}.kpis{margin:24px -28px 0}.body{padding:28px 28px 32px}
  .kpi{-ms-flex:none;flex:none;width:33.333%;border-bottom:1px solid ${T.mastLine}}
  .kpi:nth-child(3n){border-right:0}
  .w8,.w4{width:100%}
  .bcell{width:100%}
  .rcol{width:100%;margin-bottom:20px}
}
/* phones — the report is also read inside a ~360px iframe and Outlook mobile */
@media (max-width:640px){
  .sheet{margin:0;box-shadow:none}
  .mast{padding:24px 16px 0}.kpis{margin:20px -16px 0}.body{padding:20px 16px 28px}
  .brand{margin-bottom:16px}
  .mast h1{font-size:25px}
  .sub{font-size:13px}.tag{font-size:12.5px;padding:4px 12px}
  .kpi{width:50%;padding:16px 16px 20px}
  .kpi:nth-child(3n){border-right:1px solid ${T.mastLine}}
  .kpi:nth-child(2n){border-right:0}
  .kpi .v{font-size:30px}
  .sec{padding:24px 0}
  .sec h2{font-size:17.5px}
  .bars .bl{width:44%;font-size:12.5px}.axis{padding-left:44%}
  /* tables stack into per-row cards: name + pill on one line, text underneath */
  .rt thead{display:none}
  .rt,.rt tbody{display:block;width:100%}
  .rt tr{display:-ms-flexbox;display:flex;-ms-flex-wrap:wrap;flex-wrap:wrap;-ms-flex-align:center;align-items:center;padding:12px 0;border-bottom:1px solid ${T.lineSoft}}
  .rt td{display:block;border:0;padding:0;overflow-wrap:anywhere}
  .rt td.acc{-ms-flex-order:1;order:1;-ms-flex:1 1 0%;flex:1 1 0%;min-width:0;font-size:14.5px;margin-right:12px}
  .rt td.nm{-ms-flex-order:1;order:1;width:100%;font-size:14.5px;margin-bottom:8px}
  .rt td.msgs{-ms-flex-order:2;order:2;font-size:13px;font-weight:400;color:${T.muted};margin-right:12px}
  .rt td.msgs:after{content:" messages"}
  .rt td.pc{-ms-flex-order:3;order:3}
  .rt td.tx{-ms-flex-order:4;order:4;width:100%;margin-top:8px;font-size:14px}
  .rt tr.catrow{display:block;padding:0;border-bottom:0;margin-top:8px}
  .rt tr.catrow td{display:block;width:100%;padding:8px 12px}
}
@media print{
  body{background:${T.sheet}}
  .sheet{margin:0;box-shadow:none;max-width:none}
  .mast,.kpi,.b,.pill,.bar,.track,.catrow td,.ainote{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .rt tr,.bcell,.rcol,.kpi{page-break-inside:avoid;break-inside:avoid}
}`

// One horizontal bar chart as a table: label · bar · exact value. axis = the old chart's axis title.
function barChart(rows, axis) {
  const max = Math.max(1, ...rows.map((r) => Number(r.value) || 0))
  const body = rows.map((r) => {
    const pct = Math.max(1, Math.round(((Number(r.value) || 0) / max) * 1000) / 10)
    return `<tr><td class="bl">${esc(r.label)}</td><td class="bt"><div class="track"><div class="bar" style="width:${pct}%;background:${r.color}"></div></div></td><td class="bv">${esc(String(r.value))}</td></tr>`
  }).join('')
  return `<table class="bars">${body}</table><div class="axis">${esc(axis)}</div>`
}

// "a · b · c" / "a | b | c" → separate items (same text, no glued separators)
const items = (s, sep) => String(s ?? '').split(sep).map((x) => x.trim()).filter(Boolean)

function buildBody(d) {
  const groups = d.groups || []
  const hasAI = !!d.ai

  // ---- chart datasets ----
  const topGroups = groups.slice(0, 15)
  const byAcct = topGroups.length
    ? barChart(topGroups.map((g) => ({ label: g.group, value: g.msgs, color: pillColor(g.statusCls) })), 'Messages' + (d.windowShort ? ' (' + d.windowShort + ')' : ''))
    : null
  let escChart = null
  if (hasAI && (d.escalationCounts || []).length) {
    const rows = d.escalationCounts.map((x) => ({ ...x, meta: ESC_MIX[x.category] })).filter((x) => x.meta).sort((a, b) => b.count - a.count)
    if (rows.length) escChart = barChart(rows.map((r) => ({ label: r.meta.label, value: r.count, color: TONE[r.meta.tone].solid })), 'Accounts affected')
  }
  let oppChart = null
  if (hasAI && (d.opportunityCounts || []).length) {
    const rows = d.opportunityCounts.map((x) => ({ label: OPP_MIX[x.category], count: x.count })).filter((x) => x.label).sort((a, b) => b.count - a.count)
    if (rows.length) oppChart = barChart(rows.map((r) => ({ label: r.label, value: r.count, color: TONE.green.solid })), 'Accounts with opportunity')
  }

  // ---- masthead: title, subtitle, tag line, KPIs ----
  let h = `<div class="sheet"><header class="mast">
  <div class="brand"><span>Sonar</span> WhatsApp intelligence</div>
  <h1>${esc(d.title)}</h1>
  <div class="sub">${items(d.subtitle, ' · ').map((x) => `<span>${esc(x)}</span>`).join('')}</div>
  <div class="tags">${items(d.tagLine, '|').map((x) => `<span class="tag">${esc(x)}</span>`).join('')}</div>`
  if (d.kpis?.length) {
    h += `<div class="kpis">${d.kpis.map((k) =>
      `<div class="kpi k-${KPI_TONE[k.cls] || 'none'}"><div class="v">${esc(k.value)}</div><div class="l">${esc(k.label)}</div></div>`).join('')}</div>`
  }
  h += `</header>
<main class="body">`

  // ---- banner ----
  if (hasAI && d.banner?.length) {
    h += `<div class="banner">${d.banner.slice(0, 3).map((b) => {
      const tone = BANNER_TONE[b.tone] || 'red'
      return `<div class="bcell"><div class="b g-${tone} r-${tone}"><span class="bl h-${tone}">${esc(b.label)}</span>${md(b.text)}</div></div>`
    }).join('')}</div>`
  } else {
    h += `<div class="ainote"><b>This is the free metrics view.</b> Click <b>✨ Generate AI report</b> for the full analysis — escalations by category, opportunities to win, and recommendations.</div>`
  }

  // ---- Activity by Account + Escalations by Category ----
  h += `<div class="row">
  <section class="col ${escChart ? 'w8' : 'w12'}"><div class="sec">
    <h2>Activity by Account (messages${d.windowShort ? ', ' + esc(d.windowShort) : ''})</h2>
    <p class="note">${esc(d.byAccountNote || 'Message volume per monitored group this window.')}</p>
    ${byAcct || '<div class="nodata">No data.</div>'}
  </div></section>`
  if (escChart) {
    h += `<section class="col w4"><div class="sec">
    <h2>Escalations by Category (accounts affected)</h2>
    <p class="note">The four escalation buckets.</p>
    ${escChart}
  </div></section>`
  }
  h += `</div>`

  // ---- Key Escalations table (4 categories) ----
  if (hasAI && (d.escalations || []).length) {
    // Any row with an unrecognised category falls into "other" — never dropped.
    const escKeys = new Set(ESC_CATS.map((c) => c.key))
    const escRows = d.escalations.map((e) => (escKeys.has(e.category) ? e : { ...e, category: 'other' }))
    let body = ''
    for (const cat of ESC_CATS) {
      const rows = escRows.filter((e) => e.category === cat.key)
      if (!rows.length) continue
      body += `<tr class="catrow"><td colspan="3" class="r-${cat.tone}">${esc(cat.title)}</td></tr>`
      body += rows.map((e) => `<tr><td class="pc">${pill(sevTone(e.severity), e.severity)}</td><td class="acc">${esc(e.account)}</td><td class="tx">${md(e.issue)}</td></tr>`).join('')
    }
    h += `<section class="sec">
    <h2>Key Escalations / Open Items — by Category</h2>
    <p class="note">Four parts: Stock missing · Dispatch · Quality · All other. Quotes verbatim (Hindi context translated).</p>
    <div class="tw"><table class="rt"><thead><tr><th style="width:96px">Severity</th><th style="width:220px">Account</th><th>Issue (verbatim)</th></tr></thead><tbody>${body}</tbody></table></div>
  </section>`
  }

  // ---- Opportunities table (5 categories) + chart ----
  if (hasAI && (d.opportunities || []).length) {
    // Unrecognised category -> "convert" bucket, so no opportunity is ever dropped.
    const oppKeys = new Set(OPP_CATS.map((c) => c.key))
    const oppRows = d.opportunities.map((o) => (oppKeys.has(o.category) ? o : { ...o, category: 'convert' }))
    let body = ''
    for (const cat of OPP_CATS) {
      const rows = oppRows.filter((o) => o.category === cat.key)
      if (!rows.length) continue
      body += `<tr class="catrow"><td colspan="3" class="r-green">${esc(cat.title)}</td></tr>`
      body += rows.map((o) => `<tr><td class="pc">${pill('green', o.value)}</td><td class="acc">${esc(o.account)}</td><td class="tx">${md(o.signal)}</td></tr>`).join('')
    }
    h += `<div class="row">
  <section class="col ${oppChart ? 'w8' : 'w12'}"><div class="sec">
    <h2>Opportunities to Win — by Category</h2>
    <p class="note">Winnable demand surfacing in chat. Inferential — an enquiry is not a booked order; convert &amp; confirm against ERP. Quotes verbatim.</p>
    <div class="tw"><table class="rt"><thead><tr><th style="width:96px">Value</th><th style="width:200px">Account</th><th>Signal (verbatim)</th></tr></thead><tbody>${body}</tbody></table></div>
  </div></section>`
    if (oppChart) {
      h += `<section class="col w4"><div class="sec">
    <h2>Opportunities by Category (accounts)</h2>
    <p class="note">Where winnable demand is concentrated this window.</p>
    ${oppChart}
  </div></section>`
    }
    h += `</div>`
  }

  // ---- All Groups table ----
  if (groups.length) {
    h += `<section class="sec">
    <h2>All Groups — Status &amp; Key Concern${d.windowShort ? ' (' + esc(d.windowShort) + ')' : ''}</h2>
    <div class="tw"><table class="rt"><thead><tr><th>Group</th><th style="width:70px">Msgs</th><th style="width:190px">Status</th><th>Key concern / opportunity this window</th></tr></thead>
    <tbody>${groups.map((g) => {
      const tone = PILL_TONE[g.statusCls] || 'grey'
      return `<tr><td class="nm">${esc(g.group)}</td><td class="msgs">${esc(String(g.msgs))}</td><td class="pc">${pill(tone, g.statusLabel || 'Active')}</td><td class="tx">${g.concern ? md(g.concern) : '—'}</td></tr>`
    }).join('')}</tbody></table></div>
  </section>`
  }

  // ---- Recommended Actions (3 columns) ----
  if (hasAI && ((d.actionsFix || []).length || (d.actionsWin || []).length || (d.actionsStructural || []).length)) {
    const col = (tone, title, list) => `<div class="rcol"><div class="rbox" style="border-top-color:${TONE[tone].solid}"><h3 class="h-${tone}">${esc(title)}</h3><ol>${(list || []).map((a) => `<li>${md(a)}</li>`).join('')}</ol></div></div>`
    h += `<section class="sec">
    <h2>Recommended Actions</h2>
    <div class="recos">
      ${col('red', 'Fix / protect (immediate)', d.actionsFix)}
      ${col('green', 'Win now', d.actionsWin)}
      ${col('blue', 'Structural (30–90 days)', d.actionsStructural)}
    </div>
  </section>`
  }

  h += `<footer class="foot">${esc(d.footerNote)}</footer>
</main></div>`
  return h
}

function renderReport(d) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="X-UA-Compatible" content="IE=edge"><title>${esc(d.title)}</title><meta name="description" content="${esc(d.subtitle)}"><style>${CSS}</style></head><body>${buildBody(d)}</body></html>`
}

module.exports = { renderReport, TONE }

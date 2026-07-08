// =============================================================
//  Sonar — a fully-populated SAMPLE report, used only to test email
//  delivery and formatting (from the "Send sample report" button).
//  Uses fixed demo data — never touches the database.
// =============================================================
const { renderReport } = require('./reportTemplate')

const groups = [
  { group: 'HI-Shreenathji, Rajkot', msgs: 19, statusCls: 'p-red', statusLabel: 'Dispatch chase', concern: 'PO-520597 dispatch-details chased repeatedly; roll-rate order (30+5 m); Timeless-10 discontinued' },
  { group: 'Nirmals', msgs: 18, statusCls: 'p-amber', statusLabel: 'Stock enquiry', concern: 'Partial availability (Heritage Foils 59.6/150 m; Treillis 6+3); Llama Boucle no-stock 2-3 wk' },
  { group: 'Laxmi Decor, Jabalpur (101272)', msgs: 17, statusCls: 'p-red', statusLabel: 'Account block', concern: '₹5.6L overdue block persists; "no stock July end"; PO-521923 punched' },
  { group: 'New Grah Shobha, Indore (100685)', msgs: 11, statusCls: 'p-amber', statusLabel: 'QR + refill + rugs', concern: '"QR not working, new collection"; PO-515399 refill pending; rugs catalogue link shared' },
  { group: 'SKD DDecor', msgs: 9, statusCls: 'p-amber', statusLabel: 'Cancel + pending', concern: 'PO-522100 cancelled (qty revision); PO-517624 / Silka sr-15 status pending' },
  { group: 'Home Story, Ratlam (102544)', msgs: 8, statusCls: 'p-green', statusLabel: 'Resolved', concern: '"Wrong fabric" scare → confirmed correct on catalogue match' },
  { group: 'Spl Bombay Canvas (103816)', msgs: 8, statusCls: 'p-green', statusLabel: 'Resolved', concern: 'Return-pickup / SM-courier no-show complaint → resolved same day' },
  { group: "D'decor Caliber Group", msgs: 7, statusCls: 'p-red', statusLabel: 'Short / discontinued', concern: 'Sophisticated Jacquards / Cotton Fizz short; taupe aid no-stock → 15-Aug' },
  { group: 'Decor India Noida', msgs: 7, statusCls: 'p-amber', statusLabel: 'Account toggle', concern: 'Active/inactive account status; "aaj dispatch kra do pls"; Tarapur availability' },
  { group: 'Spl KF Home, Siliguri', msgs: 6, statusCls: 'p-amber', statusLabel: 'No stock', concern: 'PO-522055 Classic Textures I — not available, ETA last week July' },
  { group: 'N.P. Parekh Inc (Mumbai)', msgs: 3, statusCls: 'p-green', statusLabel: 'Healthy', concern: 'PO-521856 → will dispatch today from Tarapur' },
  { group: 'Fabric Ville, Anand (HI)', msgs: 3, statusCls: 'p-amber', statusLabel: 'Dispatch urgency', concern: '"Order 522362 anyhow today dispatch please" → "will dispatch today"' },
  { group: 'Kejals (HI)', msgs: 1, statusCls: 'p-red', statusLabel: 'Service quality', concern: '"Please dispatch details — not proper reply"' },
]

function build() {
  const data = {
    title: "D'Decor — Customer Chat Review (SAMPLE)",
    subtitle: 'Sample report for email/format testing · not from live data',
    tagLine: 'Window: 06-Jul-2026 → 07-Jul-2026  |  13 groups  |  ~117 messages  |  12+ POs/orders',
    windowShort: 'SAMPLE',
    groups,
    kpis: [
      { value: '13', label: 'Groups (active)' },
      { value: '~117', label: 'Messages (2d)' },
      { value: '12+', label: 'POs / Orders ref.', cls: 'green' },
      { value: '7', label: 'Accounts hit by Stock', cls: 'red' },
      { value: '6', label: 'Dispatch-chasing', cls: 'red' },
      { value: '₹5.6L', label: 'Laxmi Block (open)', cls: 'amber' },
    ],
    verdictTitle: 'Portfolio Verdict — SAMPLE',
    verdictHtml: 'This is a **sample** report to verify email delivery and formatting. The familiar pair — **STOCK** and **DISPATCH** — lead, with the Laxmi Decor credit block open for a second window. Dispatch-detail *chasing* was the sharpest tone this window ("Dispatch details please… From where?").',
    banner: [
      { tone: 'bad', label: 'Open / escalating', text: 'Laxmi Decor ₹5.6L account block still halting orders; Shreenathji & Kejals chasing dispatch details.' },
      { tone: 'warn', label: 'Stock / discontinuation', text: '~7 accounts short/no-stock/discontinued; ETAs to 15-Aug.' },
      { tone: 'good', label: 'Resolved in-window', text: 'Home Story "wrong fabric" → confirmed correct; Bombay Canvas return-pickup resolved.' },
    ],
    escalations: [
      { account: 'Laxmi Decor, Jabalpur (101272)', severity_class: 'Crit', severity_label: 'Critical (2nd window)', issue: 'Account still blocked on ₹5,60,453.59 overdue — "please clear dues and update"' },
      { account: 'HI-Shreenathji, Rajkot', severity_class: 'High', severity_label: 'High', issue: 'PO-520597 dispatch-details chased across 2 days — "Dispatch details please… From where?"' },
      { account: 'Home Story, Ratlam (102544)', severity_class: 'Med', severity_label: 'Medium (resolved)', issue: '"Wrong fabric received" → after catalogue-match: "Fabric correct hai"' },
    ],
    concernMix: [
      { label: 'Stock-out / discontinued / short', count: 7 },
      { label: 'Dispatch delay / status chasing', count: 6 },
      { label: 'Account block / credit', count: 2 },
      { label: 'Cancellation', count: 1 },
      { label: 'Returns / pickup', count: 1 },
      { label: 'Quality / wrong fabric', count: 1 },
    ],
    actionsImmediate: [
      '**Close the Laxmi Decor credit block** — 2nd consecutive window blocked on ₹5.6L.',
      '**Give Shreenathji firm dispatch details** on PO-520597 — repeated chasing is a service-quality red flag.',
    ],
    actionsStructural: [
      '**Proactive dispatch milestones** (OR→AWB) to end the recurring "dispatch details please" chasing.',
      '**Proactive credit management** — advance due alerts & auto-release on payment.',
    ],
    ai: true,
    footerNote: 'SAMPLE report generated by Sonar for testing — not from live chat data. Confidential — internal use only.',
  }
  const summary = { title: data.title, windowShort: data.windowShort, verdict: data.verdictHtml.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1'), kpis: data.kpis }
  return { html: renderReport(data), summary, stats: { messages: 117, chats: groups.length } }
}

module.exports = { build }

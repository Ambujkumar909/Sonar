// =============================================================
//  Sonar — fully-populated SAMPLE report (v2 categorized format).
//  Used only to test email delivery + formatting. Fixed demo data,
//  never touches the database. Mirrors customer-chat-review-2026-08-02.html.
// =============================================================
const { renderReport } = require('./reportTemplate')

const groups = [
  { group: "D'decor Caliber Group", msgs: 55, statusCls: 'p-red', statusLabel: 'Portal + stock', concern: '"Unable to punch, portal not working"; 100–110 m stock checks; unconfirmed "available" order (2 days old)' },
  { group: 'Decor India, Noida', msgs: 46, statusCls: 'p-green', statusLabel: 'Project order', concern: '128 m Natural Jacquard project (confirm/dispatch); ship-to-Panipat blocked → re-route; app not showing' },
  { group: "D'DECOR + KVT", msgs: 41, statusCls: 'p-amber', statusLabel: 'Stock ETA + deal', concern: 'ETA 15-Sept vs website Aug; "customer waiting"; discount-to-close pending' },
  { group: 'Deep Curtains', msgs: 35, statusCls: 'p-red', statusLabel: 'Cancellation', concern: 'Soph Jacquard & Cocoon no-stock → cancelled main+sheet; Maharaja 62 m+61 m to close' },
  { group: 'Nirmals', msgs: 33, statusCls: 'p-amber', statusLabel: 'Discontinued + dispatch', concern: 'Supervio discontinued; Neutral AID not dispatched; many stock enquiries serviced' },
  { group: 'Golden Drape Vaishali (102128)', msgs: 26, statusCls: 'p-amber', statusLabel: 'No-stock + mapping', concern: '100 m urgent "no stock exp 10-Aug"; "book map nahi, QR se price nahi"' },
  { group: 'SKD', msgs: 22, statusCls: 'p-amber', statusLabel: 'Portal + same-lot', concern: '"Server error / portal not working"; self-pickup Noida; need same-lot as invoice' },
  { group: 'Ashoka Foam', msgs: 21, statusCls: 'p-amber', statusLabel: 'Punch failure', concern: '"Order punch nahi ho raha"; rates ask; Treillis II punched & dispatched' },
  { group: 'Drapes & Spreads', msgs: 19, statusCls: 'p-green', statusLabel: 'Substitution save', concern: '"App not working"; Silky Satin no-stock → Luscious Satin 2 (saved); POs punched' },
  { group: 'Sham Emp', msgs: 19, statusCls: 'p-red', statusLabel: 'Dispatch delay', concern: 'Delicate Sheers 164 m by-air; "STILL WAITING"; mill confirmation pending' },
  { group: 'Ddecor + Odds and Ends', msgs: 18, statusCls: 'p-red', statusLabel: 'Urgent + ageing', concern: 'PO-531560 urgent Tarapur; Order 523483 (10-Jul) ageing' },
  { group: 'Laxmi Decor (101272)', msgs: 17, statusCls: 'p-amber', statusLabel: 'Discontinued', concern: 'Stock enquiries serviced; "Discontinued Sku"; PO-532008 punched' },
  { group: 'Mansaram', msgs: 16, statusCls: 'p-green', statusLabel: 'Serviced', concern: 'Stock checks → PO-531714; Blue Sky IV only 3+1 m' },
  { group: 'Colors', msgs: 15, statusCls: 'p-amber', statusLabel: 'Discontinued', concern: 'Wigan discontinued ("from dealers?"); Lush Chenille/Naturama punched' },
  { group: 'Haryana HL (backhand)', msgs: 15, statusCls: 'p-green', statusLabel: 'Onboarding', concern: '"Please map this catalogue" → mapped → PO-531921; stock checks' },
  { group: 'Kapaas', msgs: 12, statusCls: 'p-amber', statusLabel: 'Stock + urgent', concern: 'Signature Velvet 3007 not in stock; Platina urgent by-air; POs punched' },
  { group: 'N.P. Parekh Inc (Mumbai)', msgs: 12, statusCls: 'p-amber', statusLabel: 'Portal error', concern: 'Classic Sheers-47 query; "ERROR IN PORTAL" → CC punched PO-531779' },
  { group: 'MO Designs', msgs: 11, statusCls: 'p-green', statusLabel: 'Pipeline 300 m', concern: 'Linen Legacy 300 m (2-3 wks); Challis enquiries answered' },
  { group: 'Kejals', msgs: 11, statusCls: 'p-amber', statusLabel: 'System', concern: '"Online system not updated"; price/roll-rate; PO-531856' },
  { group: 'Ganpati Exc', msgs: 10, statusCls: 'p-green', statusLabel: 'Project + return', concern: 'Bible of Texture 82+54 m (project, 5% discount pending); goods-return debit note → CN' },
  { group: 'ELEMENTTO', msgs: 11, statusCls: 'p-green', statusLabel: 'New range + ledger', concern: 'Blackout Curtains III hanger AV (new range); ledger reconciliation ask' },
  { group: 'DDecor HomeStore / Orchid', msgs: 6, statusCls: 'p-green', statusLabel: 'New books', concern: 'Price-list + HSN for 6 new collections; Linen Essence order confirmed' },
  { group: 'Others (Instyle, Gallery One, Shreenathji, Ambey, Bombay Canvas, KF-Home, Gagan…)', msgs: 8, statusCls: 'p-grey', statusLabel: 'Low / mixed', concern: 'New user-id & first POs, mapping, price/RRP, single orders, dispatch pushes' },
]

const escalations = [
  { category: 'stock', severity: 'High', account: "D'DECOR + KVT", issue: 'New stock ETA slipped to **15-Sept** (website showed August); "customer is waiting" — dispatched available, balance ASAP' },
  { category: 'stock', severity: 'High', account: 'Deep Curtains', issue: 'Sophisticated Jacquard 44 (no stock, 4-5 wks) & Cocoon 24 (3-4 wks) → customer **cancelled main + sheet + Metallic Muse**' },
  { category: 'stock', severity: 'Med', account: 'Colors', issue: 'Wigan Sr.22 (~25 m) — "Material discontinued"; "any possibility to get from dealers?"' },
  { category: 'stock', severity: 'Med', account: 'Nirmals', issue: 'Supervio-15 "Material discontinued, please change"; Neutral AID-15 pending' },
  { category: 'stock', severity: 'Med', account: 'Caliber / Laxmi / Golden Drape / Softzone', issue: '"No stock by 24-Aug"; Verona sr.13 discontinued; Laxmi "Discontinued Sku"; Softzone Velvetlike discontinued' },
  { category: 'dispatch', severity: 'High', account: 'Ddecor + Odds and Ends', issue: 'PO-531560 "very urgent, dispatch today from Tarapur… need it tomorrow"; Order 523483 (10-Jul) ageing' },
  { category: 'dispatch', severity: 'High', account: 'Sham Emp', issue: 'PO-519433 Delicate Sheers — "dispatch today by air"; "**SIR STILL WAITING**"; mill confirmation pending' },
  { category: 'dispatch', severity: 'Med', account: 'Decor India (Noida)', issue: '"Dispatch today, ship to Panipat" → "third party not possible" → order cancelled & re-routed via Noida' },
  { category: 'dispatch', severity: 'Med', account: 'Nirmals / Malik / Gallery One / Kapaas', issue: 'Neutral AID "still not dispatched"; "531811 dispatch urgently"; "PLS DISPATCH TODAY"; Platina urgent air' },
  { category: 'quality', severity: 'High', account: 'Ganpati Exc', issue: '"**Goods Returned** — Debit note no.3 against inv 1702389076 dated 25-Jul" → CN to be processed on receipt' },
  { category: 'quality', severity: 'Med', account: 'Dwindo / SKD', issue: 'Demanding **same-lot** fabric (Comfort-4 Sr 405; PO-531940 "same lot as invoice") — pre-empting shade variation' },
  { category: 'other', severity: 'High', account: 'Portal / QR / punch outage (~12 accts)', issue: 'Ashoka "order punch nahi ho raha"; Caliber "unable to punch, portal not working"; NPP "error in portal"; SKD "server error"; KF-Home "QR not working"' },
  { category: 'other', severity: 'Med', account: 'Mapping requests', issue: 'Golden Drape "ye book map nahi, QR se price nahi"; Bedding "kindly map, not showing"; Haryana "please map this catalogue"' },
  { category: 'other', severity: 'Med', account: 'Elementto', issue: '"Please **reconcile the ledger** and let me know if any bill or payment is missing"' },
]

const opportunities = [
  { category: 'bulk', value: 'High', account: 'Decor India (Noida)', signal: '**Project order** OR1788060 — Natural Jacquard **128 m** (have 67.4+44+11); "please CONF for dispatch"' },
  { category: 'bulk', value: 'High', account: 'MO Designs', signal: 'Linen Legacy sr-18 — **stock inquiry 300 m** (ETA 2-3 wks) — large pipeline to reserve & schedule' },
  { category: 'bulk', value: 'High', account: 'Sham Emp', signal: 'Delicate Sheers — **164 m** rolls (57+55.5+44.7+44.2); by-air — allocate & close' },
  { category: 'bulk', value: 'Med', account: 'Ganpati Exc', signal: 'Bible of Texture-14 — **82 m + 54 m** allocation done (project, discount pending)' },
  { category: 'bulk', value: 'Med', account: 'Deep Curtains / Caliber', signal: 'Maharaja-10 62 m + 61 m; Caliber/Jhills 110 m & 100 m stock checks in play' },
  { category: 'deal', value: 'High', account: "D'DECOR + KVT", signal: '"Give us the **discount you provided earlier**… so that we can punch the order" — roll-rate agreed, one nod to close' },
  { category: 'deal', value: 'Med', account: 'Ganpati Exc', signal: '"Allow **project discount 5%** & punch this order" — approve to convert 136 m' },
  { category: 'deal', value: 'Low', account: 'Ambey Furnishing', signal: '"3.15×16 length, roll price — apply roll rate" — pricing nudge to close' },
  { category: 'newcollection', value: 'High', account: 'Orchid Furnishing', signal: 'Price-list + HSN for **6 new books**: Luxeloom, Texture Trove, Plushpalette, Sleekstitch, Polycraft, Threadscape' },
  { category: 'newcollection', value: 'Med', account: 'Elementto', signal: 'Blackout Curtains III — hanger AV checks (35.5 m ×2) — new-range adoption' },
  { category: 'newcollection', value: 'Low', account: 'Ashoka Foam / Deep Curtains', signal: 'Ashoka "share rates/RRP" (new range); Deep "Sarova 2 as catalogue?" (new pattern)' },
  { category: 'onboarding', value: 'Med', account: 'Gallery One, Hyderabad', signal: 'Portal **user-id set up** (galleryonehyderabad@…) — new account going live' },
  { category: 'onboarding', value: 'Med', account: 'Instyle CLT / Haryana HL', signal: 'Instyle first PO Softweave-5, 39.2 m; Haryana "map this catalogue" → PO-531921' },
  { category: 'onboarding', value: 'Low', account: 'New "…Tuesday" groups', signal: 'Wave of newly-added accounts (Ashish Foam, Colors, Kapaas, Odds & Ends, Dwindo…) — activate the footprint' },
  { category: 'convert', value: 'High', account: "D'decor Caliber Group", signal: 'Tina: "**Pls confirm the order — stock is available**, and this enquiry was done 2 days before also" — sitting unconverted' },
  { category: 'convert', value: 'Med', account: 'Drapes & Spreads', signal: 'Silky Satin no-stock → "**Give Luscious Satin 2, same quantity**" → available — **sale saved** by substitution' },
  { category: 'convert', value: 'Low', account: 'Softzone / Colors', signal: 'Softzone Velvetlike discontinued → 2.8+2.2 accepted; Colors Wigan → offer alternative to save' },
]

function build() {
  const data = {
    title: "D'Decor — Customer Chat Review (SAMPLE)",
    subtitle: 'Sample report for email/format testing · not from live data',
    tagLine: 'Window: 31-Jul-2026 → 02-Aug-2026  |  38 groups  |  ~554 messages  |  45+ POs/orders',
    windowShort: 'SAMPLE',
    kpis: [
      { value: '38', label: 'Groups (active)' },
      { value: '~554', label: 'Messages (1d)' },
      { value: '45+', label: 'POs / Orders ref.', cls: 'green' },
      { value: '12', label: 'Portal/QR/mapping outage', cls: 'red' },
      { value: '12', label: 'Stock-out / discontinued', cls: 'amber' },
      { value: '17', label: 'Opportunities to win', cls: 'green' },
    ],
    banner: [
      { tone: 'bad', label: 'Portal / QR / mapping outage', text: '~12 accounts could not punch orders / see prices — "order punch nahi ho raha", "app not working", "QR se price nahi aa rahi".' },
      { tone: 'warn', label: 'Stock missing / discontinued', text: '~12 accounts hit no-stock / discontinued / far ETAs (15-Sept, 24-Aug); some cancelled — lost Diwali-run demand.' },
      { tone: 'good', label: 'Opportunities to win', text: '~17 accounts showing winnable demand — bulk/project orders (128 m, 300 m), deals awaiting a discount nod, 6 new-book price-list requests.' },
    ],
    groups,
    escalations,
    escalationCounts: [{ category: 'other', count: 13 }, { category: 'stock', count: 12 }, { category: 'dispatch', count: 8 }, { category: 'quality', count: 3 }],
    opportunities,
    opportunityCounts: [{ category: 'bulk', count: 6 }, { category: 'convert', count: 5 }, { category: 'newcollection', count: 4 }, { category: 'onboarding', count: 4 }, { category: 'deal', count: 3 }],
    actionsFix: [
      '**Restore portal / QR / mapping** — ~12 accounts couldn\'t punch or price. Biggest lost-order risk into Diwali.',
      '**Align website vs portal ETAs** (KVT saw Aug on web, 15-Sept on portal).',
      '**Clear Sham Emp & Odds-and-Ends dispatch delays** ("STILL WAITING" / 10-Jul ageing).',
    ],
    actionsWin: [
      '**Approve KVT & Ganpati discounts today** — converts ~136 m + KVT balance sitting on one nod.',
      '**Chase Caliber\'s unconfirmed "available" order** (flagged 2 days old) to a PO before they source elsewhere.',
      '**Reserve stock for the 128 m project (Decor India) & 300 m Linen Legacy (MO Designs)** pipeline.',
      '**Fast-track Orchid\'s 6-book price-list + samples** — new assortment adoption pre-Diwali.',
    ],
    actionsStructural: [
      '**Live discontinued-SKU list + alternatives** (Verona, Wigan, Supervio, Velvetlike).',
      '**Default substitution playbook** — Luscious-Satin-for-Silky-Satin type saves, offered proactively.',
      '**Proactive dispatch milestones** + same-lot/batch guarantee at dispatch.',
    ],
    ai: true,
    footerNote: 'SAMPLE report generated by Sonar for testing — not from live chat data. Escalations in 4 categories; Opportunities in 5. Opportunity signals are inferential — validate against ERP. Confidential — internal use only.',
  }
  const summary = { title: data.title, windowShort: data.windowShort, verdict: data.banner.map((b) => b.text).join(' ').replace(/\*\*([^*]+)\*\*/g, '$1'), kpis: data.kpis }
  return { html: renderReport(data), summary, stats: { messages: 554, chats: groups.length } }
}

module.exports = { build }

// =============================================================
//  Sonar — "Customer Chat Review" report builder (v3, channel-tabbed).
//  Builds the SAME report three times — COCO / FOFO / MBO — by splitting
//  groups on their name (watchlist groups carry the channel in the name,
//  e.g. "FOFO-DCA MARKETING, CHANDIGARH 10002716"; no COCO/FOFO = MBO).
//  Each segment gets its own Postgres counts + Claude analysis, and all
//  three land in ONE html with tabs on top (reportTemplate.renderTabbedReport).
//  Used by /api/report (metrics) and /api/reports (AI).
// =============================================================
const store = require('./store')
const aiReport = require('./aiReport')
const { renderTabbedReport } = require('./reportTemplate')
const { segmentCond } = require('./chatExport')

const SEGMENTS = [
  { key: 'coco', label: 'COCO' },
  { key: 'fofo', label: 'FOFO' },
  { key: 'mbo', label: 'MBO' },
]

const IN = (opts) => (ms) => (ms ? new Date(Number(ms)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', ...opts }) : '—')
const fmtDateTime = IN({ day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const fmtDayRaw = IN({ day: '2-digit', month: 'short', year: 'numeric' })
const fmtDay = (ms) => fmtDayRaw(ms).replace(/ /g, '-')
const norm = (s) => String(s || '').trim().toLowerCase()

// One segment = one full report body (same shape renderReport always took).
async function buildSegment({ seg, ids, days, ai, generatedAt, title, daysLabel, msgWindow, genOn, footerBase }) {
  const scoped = Array.isArray(ids)
  const q = (sql, params) => store.pool.query(sql, params)
  const conds = [`(${segmentCond(seg.key)})`], p = []
  if (scoped) { p.push(ids); conds.push(`session_id = ANY($${p.length})`) }
  if (days) { p.push(generatedAt - days * 86400000); conds.push(`ts >= $${p.length}`) }
  const filt = ' WHERE ' + conds.join(' AND ')

  const t = (await q(`SELECT COUNT(*)::int n, COUNT(DISTINCT (session_id, chat_jid))::int chats, MIN(ts) mn, MAX(ts) mx FROM messages${filt}`, p)).rows[0] || {}
  const totalMsgs = t.n || 0
  const windowShort = totalMsgs ? `${fmtDay(t.mn)} → ${fmtDay(t.mx)}` : daysLabel

  if (totalMsgs === 0) {
    return {
      data: { title, subtitle: `Source: Sonar WhatsApp capture · generated ${genOn}`, tagLine: `${seg.label}  |  Window: ${daysLabel} · no messages captured`,
        kpis: [{ value: '0', label: 'Groups' }, { value: '0', label: 'Messages' }, { value: '0', label: 'POs / Orders ref.', cls: 'green' }], groups: [], ai: false, footerNote: footerBase(daysLabel) },
      stats: { messages: 0, chats: 0 }, mn: null, mx: null, verdict: '',
    }
  }

  const ga = (await q(`SELECT COALESCE(NULLIF(chat_name, ''), chat_jid) name, COUNT(*)::int msgs, MAX(is_group)::int is_group FROM messages${filt} GROUP BY 1 ORDER BY msgs DESC`, p)).rows
  const groupActivity = ga.map((r) => ({ name: r.name, msgs: r.msgs, is_group: !!r.is_group }))
  const groupCount = groupActivity.filter((g) => g.is_group).length || groupActivity.length

  let poCount = 0
  try {
    const poFilt = filt + " AND text ~ '\\d{6}'"
    poCount = (await q(`SELECT COUNT(DISTINCT tok)::int n FROM (SELECT (regexp_matches(text, '(\\d{6})', 'g'))[1] tok FROM messages${poFilt}) s`, p)).rows[0]?.n || 0
  } catch { poCount = 0 }

  const baseKpis = [
    { value: String(groupCount), label: 'Groups (active)' },
    { value: '~' + totalMsgs.toLocaleString('en-IN'), label: `Messages (${msgWindow})` },
    { value: (poCount || 0) + '+', label: 'POs / Orders ref.', cls: 'green' },
  ]

  let aidata = null
  if (ai) {
    const r = await aiReport.analyze({ ids, days, generatedAt, segment: seg.key, groupActivity: groupActivity.map((g) => ({ name: g.name, msgs: g.msgs })) })
    aidata = r.data
  }
  const aiOk = !!aidata

  const aiByName = new Map((aidata?.groups || []).map((g) => [norm(g.group), g]))
  const groups = groupActivity.map((g) => {
    const a = aiByName.get(norm(g.name))
    return { group: g.name, msgs: g.msgs, statusCls: a?.status_class, statusLabel: a?.status_label, concern: a?.concern }
  })

  const data = {
    title,
    subtitle: `${seg.label} channel · Source: WhatsApp capture · ${groupCount} group${groupCount !== 1 ? 's' : ''} · generated ${genOn}`,
    tagLine: `${seg.label}  |  Window: ${windowShort}  |  ${groupCount} groups  |  ~${totalMsgs.toLocaleString('en-IN')} messages  |  ${poCount}+ POs/orders`,
    windowShort,
    kpis: baseKpis,
    groups,
    ai: aiOk,
    footerNote: footerBase(windowShort),
  }

  if (aiOk) {
    data.banner = aidata.banner
    data.kpis = [...baseKpis, ...(aidata.kpis || []).map((k) => ({ value: k.value, label: k.label, cls: k.tone }))]
    data.escalations = aidata.escalations
    data.escalationCounts = aidata.escalation_counts
    data.opportunities = aidata.opportunities
    data.opportunityCounts = aidata.opportunity_counts
    data.actionsFix = aidata.actions_fix
    data.actionsWin = aidata.actions_win
    data.actionsStructural = aidata.actions_structural
  }

  const verdict = aiOk ? (aidata.banner || []).map((b) => b.text).join(' ').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1') : ''
  return { data, stats: { messages: totalMsgs, chats: t.chats || 0 }, mn: t.mn, mx: t.mx, verdict, groupCount }
}

async function generateReport({ ids, days = null, ai = false, generatedAt = Date.now() } = {}) {
  const scoped = Array.isArray(ids)
  const genOn = fmtDateTime(generatedAt)
  const daysLabel = days ? `${days}-Day Snapshot` : 'Full History'
  const msgWindow = days ? `${days}d` : 'all'
  const title = `D'Decor — Customer Chat Review (${daysLabel})`
  const footerBase = (win) => `Generated from Sonar-captured WhatsApp chats (${win}). Escalations grouped in 4 categories; Opportunities in 5 (Bulk/Project · Deal-at-close · New-collection · Onboarding · Convert & save). Opportunity signals are inferential — an enquiry is not a booked order; validate & value against SAP/ERP. Quotes verbatim (Hindi translated). Counts are accounts-affected. Confidential — internal management use only.`

  if (scoped && ids.length === 0) {
    const tabs = SEGMENTS.map((s) => ({ key: s.key, label: s.label,
      data: { title, subtitle: 'Sonar WhatsApp capture', tagLine: `${s.label}  |  No sessions granted`, kpis: [], groups: [], ai: false, footerNote: footerBase('—') } }))
    return { html: renderTabbedReport({ title, tabs }), stats: { messages: 0, chats: 0 } }
  }

  const segs = await Promise.all(SEGMENTS.map((seg) =>
    buildSegment({ seg, ids, days, ai, generatedAt, title, daysLabel, msgWindow, genOn, footerBase })))

  const totalMsgs = segs.reduce((a, s) => a + s.stats.messages, 0)
  const totalChats = segs.reduce((a, s) => a + s.stats.chats, 0)
  const totalGroups = segs.reduce((a, s) => a + (s.groupCount || 0), 0)
  const mns = segs.map((s) => s.mn).filter((v) => v != null).map(Number)
  const mxs = segs.map((s) => s.mx).filter((v) => v != null).map(Number)
  const windowShort = totalMsgs ? `${fmtDay(Math.min(...mns))} → ${fmtDay(Math.max(...mxs))}` : daysLabel

  const html = renderTabbedReport({ title, tabs: SEGMENTS.map((s, i) => ({ key: s.key, label: s.label, data: segs[i].data })) })

  const summary = {
    title, windowShort,
    verdict: segs.map((s, i) => (s.verdict ? `${SEGMENTS[i].label}: ${s.verdict}` : '')).filter(Boolean).join(' '),
    kpis: [
      { value: String(totalGroups), label: 'Groups (active)' },
      { value: '~' + totalMsgs.toLocaleString('en-IN'), label: `Messages (${msgWindow})` },
      ...SEGMENTS.map((s, i) => ({ value: '~' + segs[i].stats.messages.toLocaleString('en-IN'), label: `${s.label} msgs` })),
    ],
  }
  return { html, stats: { messages: totalMsgs, chats: totalChats }, summary }
}

module.exports = { generateReport }

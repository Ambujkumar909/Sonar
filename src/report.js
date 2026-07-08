// =============================================================
//  Sonar — WhatsApp "Customer Chat Review" report (shared builder)
//  Used by /api/report (free metrics view) and /api/reports (saved
//  AI report). Pulls authoritative counts from Postgres, asks Claude
//  for the qualitative sections, and renders the D'Decor management
//  report format via src/reportTemplate.js.
// =============================================================
const store = require('./store')
const aiReport = require('./aiReport')
const { renderReport } = require('./reportTemplate')

const IN = (opts) => (ms) => (ms ? new Date(Number(ms)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', ...opts }) : '—')
const fmtDateTime = IN({ day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const fmtDayRaw = IN({ day: '2-digit', month: 'short', year: 'numeric' })
const fmtDay = (ms) => fmtDayRaw(ms).replace(/ /g, '-') // 06-Jul-2026
const norm = (s) => String(s || '').trim().toLowerCase()

// ids: undefined/null = all sessions; [] = no access; [..] = scoped
async function generateReport({ ids, days = null, ai = false, generatedAt = Date.now() } = {}) {
  const scoped = Array.isArray(ids)
  const genOn = fmtDateTime(generatedAt)
  const daysLabel = days ? `${days}-Day Snapshot` : 'Full History'
  const msgWindow = days ? `${days}d` : 'all'
  const title = `D'Decor — Customer Chat Review (${daysLabel})`

  const footerBase = (win) => `Generated from Sonar-captured WhatsApp chats (${win}). Quotes verbatim from chat (Hindi context translated). Concern counts are accounts-affected, not message counts. Cross-reference SAP/ERP for exact order/stock/credit status. Confidential — internal management use only.`

  if (scoped && ids.length === 0) {
    return {
      html: renderReport({
        title, subtitle: 'Sonar WhatsApp capture', tagLine: 'No sessions granted',
        kpis: [], groups: [], ai: false, footerNote: footerBase('—'),
      }),
      stats: { messages: 0, chats: 0 },
    }
  }

  const q = (sql, params) => store.pool.query(sql, params)
  const conds = [], p = []
  if (scoped) { p.push(ids); conds.push(`session_id = ANY($${p.length})`) }
  if (days) { p.push(generatedAt - days * 86400000); conds.push(`ts >= $${p.length}`) }
  const filt = conds.length ? ' WHERE ' + conds.join(' AND ') : ''

  const t = (await q(`SELECT COUNT(*)::int n, COUNT(DISTINCT (session_id, chat_jid))::int chats, MIN(ts) mn, MAX(ts) mx FROM messages${filt}`, p)).rows[0] || {}
  const totalMsgs = t.n || 0
  const windowShort = totalMsgs ? `${fmtDay(t.mn)} → ${fmtDay(t.mx)}` : daysLabel

  if (totalMsgs === 0) {
    return {
      html: renderReport({
        title, subtitle: `Source: Sonar WhatsApp capture · generated ${genOn}`,
        tagLine: `Window: ${daysLabel} · no messages captured yet`,
        kpis: [{ value: '0', label: 'Groups' }, { value: '0', label: 'Messages' }, { value: '0', label: 'POs / Orders ref.', cls: 'green' }],
        groups: [], ai: false, footerNote: footerBase(daysLabel),
      }),
      stats: { messages: 0, chats: 0 },
    }
  }

  // Authoritative per-chat message counts (chart + all-groups table).
  const ga = (await q(
    `SELECT COALESCE(NULLIF(chat_name, ''), chat_jid) name, COUNT(*)::int msgs, MAX(is_group)::int is_group
     FROM messages${filt} GROUP BY 1 ORDER BY msgs DESC`, p)).rows
  const groupActivity = ga.map((r) => ({ name: r.name, msgs: r.msgs, is_group: !!r.is_group }))
  const groupCount = groupActivity.filter((g) => g.is_group).length || groupActivity.length

  // PO / order numbers referenced (distinct 6-digit tokens) — a proxy count.
  let poCount = 0
  try {
    const poFilt = filt ? filt + " AND text ~ '\\d{6}'" : " WHERE text ~ '\\d{6}'"
    poCount = (await q(`SELECT COUNT(DISTINCT tok)::int n FROM (SELECT (regexp_matches(text, '(\\d{6})', 'g'))[1] tok FROM messages${poFilt}) s`, p)).rows[0]?.n || 0
  } catch { poCount = 0 }

  // Base KPIs (authoritative, from data).
  const kpis = [
    { value: String(groupCount), label: 'Groups (active)' },
    { value: '~' + totalMsgs.toLocaleString('en-IN'), label: `Messages (${msgWindow})` },
    { value: (poCount || 0) + '+', label: 'POs / Orders ref.', cls: 'green' },
  ]

  // ---- AI qualitative pass ----
  let aidata = null
  if (ai) {
    const r = await aiReport.analyze({ ids, days, generatedAt, groupActivity: groupActivity.map((g) => ({ name: g.name, msgs: g.msgs })) })
    aidata = r.data // may be null if window empty (shouldn't be here)
  }
  const aiOk = !!aidata

  // Merge AI per-group status/concern onto authoritative counts.
  const aiByName = new Map((aidata?.groups || []).map((g) => [norm(g.group), g]))
  const groups = groupActivity.map((g) => {
    const a = aiByName.get(norm(g.name))
    return { group: g.name, msgs: g.msgs, statusCls: a?.status_class, statusLabel: a?.status_label, concern: a?.concern }
  })

  const data = {
    title,
    subtitle: `Source: Sonar WhatsApp capture · ${groupCount} group${groupCount !== 1 ? 's' : ''} · generated ${genOn}`,
    tagLine: `Window: ${windowShort}  |  ${groupCount} groups  |  ~${totalMsgs.toLocaleString('en-IN')} messages  |  ${poCount}+ POs/orders`,
    windowShort,
    kpis,
    groups,
    ai: aiOk,
    footerNote: footerBase(windowShort),
  }

  if (aiOk) {
    data.verdictTitle = aidata.verdict_title
    data.verdictHtml = aidata.verdict
    data.banner = aidata.banner
    data.escalations = aidata.escalations
    data.concernMix = (aidata.concern_mix || []).map((c) => ({ label: c.label, count: c.count }))
    data.actionsImmediate = aidata.actions_immediate
    data.actionsStructural = aidata.actions_structural
    data.kpis = [...kpis, ...(aidata.kpis || []).map((k) => ({ value: k.value, label: k.label, cls: k.tone }))]
  }

  const summary = {
    title, windowShort,
    verdict: aiOk ? String(aidata.verdict || '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1') : '',
    kpis: data.kpis,
  }
  return { html: renderReport(data), stats: { messages: totalMsgs, chats: t.chats || 0 }, summary }
}

module.exports = { generateReport }

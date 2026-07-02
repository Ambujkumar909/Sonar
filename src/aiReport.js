// =============================================================
//  Sonar — AI narrative analysis for the WhatsApp report
//  Reads the windowed message transcripts and produces the qualitative
//  sections (executive summary, escalations, service-quality, actions)
//  that can't come from SQL. Uses Claude (Anthropic SDK), structured output.
//
//  Requires ANTHROPIC_API_KEY in the environment and outbound HTTPS to
//  api.anthropic.com. Admin-gated at the route level (it costs per run).
// =============================================================
const Anthropic = require('@anthropic-ai/sdk')
const store = require('./store')

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const isConfigured = () => !!process.env.ANTHROPIC_API_KEY

// keep the transcript within a sane budget (~300k chars ≈ ~90k tokens)
const MAX_TRANSCRIPT_CHARS = 300_000

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    executive_summary: { type: 'string', description: '2-4 short paragraphs (plain text) on the dominant themes and overall health.' },
    recurring_issues: { type: 'array', items: { type: 'string' }, description: 'Cross-cutting issues, each a short phrase with a concrete example.' },
    escalations: {
      type: 'array',
      description: 'The most pressing situations to act on first, most severe first.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          account: { type: 'string', description: 'Chat / dealer name.' },
          severity: { type: 'string', enum: ['critical', 'high', 'open'] },
          situation: { type: 'string', description: 'What happened, with a short in-chat quote if telling.' },
          status: { type: 'string', description: 'Where it stands / whether it is closed.' },
        },
        required: ['account', 'severity', 'situation', 'status'],
      },
    },
    unanswered: {
      type: 'array',
      description: 'Dealer messages left with no reply, a non-answer, or no closure in the window.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chat: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['chat', 'detail'],
      },
    },
    quality_notes: { type: 'string', description: 'Overall service-quality assessment (plain text): what was handled well, where the team was weak.' },
    action_list: { type: 'array', items: { type: 'string' }, description: 'Prioritized, concrete actions to take, most important first.' },
  },
  required: ['executive_summary', 'recurring_issues', 'escalations', 'unanswered', 'quality_notes', 'action_list'],
}

const SYSTEM = `You are an operations analyst for D'Decor, a furnishings brand. You read captured WhatsApp chats between the D'Decor team and its dealers/backend support, and produce a crisp management report.

Rules:
- Base EVERYTHING strictly on the provided messages. Never invent accounts, PO numbers, quantities, or quotes. If the data is thin, say so briefly rather than padding.
- "team" = the D'Decor side (outgoing / from_me), "dealer" = incoming.
- Quote short, telling phrases verbatim where they sharpen a point.
- Be concise and specific. Prefer concrete detail (names, PO numbers, mtr, dates as they appear) over generalities.
- Rank escalations by real business impact: wrong material, repeat defects, short-cut quantities, account/credit blocks, and unanswered urgent requests are high-impact.
- Return your analysis via the required structured schema only.`

function renderSections(d) {
  const sev = (s) => ({ critical: '🔴 Critical', high: '🟠 High', open: '🟠 Open' }[s] || esc(s))
  const paras = (t) => String(t || '').split(/\n{2,}/).map((x) => `<p>${esc(x.trim())}</p>`).join('')
  let h = `<h2>Executive Summary <span style="font-size:12px;color:#0a6;font-weight:600">· AI analysis</span></h2>${paras(d.executive_summary)}`
  if (d.recurring_issues?.length) {
    h += `<p><strong>Recurring issues this window:</strong></p><ol>${d.recurring_issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>`
  }
  if (d.escalations?.length) {
    h += `<h2>🔴 Critical Escalations (act first)</h2>
<table><tr><th>#</th><th>Account</th><th>Situation</th><th>Status</th></tr>
${d.escalations.map((e, i) => `<tr><td class="num">${i + 1}</td><td><strong>${esc(e.account)}</strong><br><span style="white-space:nowrap;font-weight:700">${sev(e.severity)}</span></td><td>${esc(e.situation)}</td><td>${esc(e.status)}</td></tr>`).join('')}
</table>`
  }
  h += `<h2>⭐ Service Quality Assessment</h2>`
  if (d.unanswered?.length) {
    h += `<p><strong>Unanswered / poorly-handled watchlist:</strong></p>
<table><tr><th>Chat</th><th>What happened</th></tr>
${d.unanswered.map((u) => `<tr><td><strong>${esc(u.chat)}</strong></td><td>${esc(u.detail)}</td></tr>`).join('')}
</table>`
  }
  if (d.quality_notes) h += paras(d.quality_notes)
  if (d.action_list?.length) {
    h += `<h2>Consolidated Action List</h2><ol>${d.action_list.map((a) => `<li>${esc(a)}</li>`).join('')}</ol>`
  }
  return h
}

// ids: undefined = all; [] = none; [..] scoped. days: null = all.
async function analyze({ ids, days = null, generatedAt = Date.now() } = {}) {
  if (!isConfigured()) throw new Error('ANTHROPIC_API_KEY is not set on the server')

  const scoped = Array.isArray(ids)
  if (scoped && ids.length === 0) return { html: '<div class="note">No sessions granted — nothing to analyze.</div>' }
  const conds = ["text IS NOT NULL AND text <> ''"], p = []
  if (scoped) { p.push(ids); conds.push(`session_id = ANY($${p.length})`) }
  if (days) { p.push(generatedAt - days * 86400000); conds.push(`ts >= $${p.length}`) }
  const where = ' WHERE ' + conds.join(' AND ')
  const rows = (await store.pool.query(
    `SELECT chat_name, sender_name, from_me, ts, text FROM messages${where} ORDER BY chat_name, ts ASC LIMIT 20000`, p)).rows
  if (!rows.length) return { html: '<div class="note">No messages in the selected window to analyze.</div>' }

  // group by chat, chronological
  let transcript = '', truncated = false, lastChat = null
  for (const m of rows) {
    if (m.chat_name !== lastChat) { transcript += `\n\n### ${m.chat_name || 'Unknown chat'}\n`; lastChat = m.chat_name }
    const who = m.from_me ? 'TEAM' : `dealer(${m.sender_name || '?'})`
    const line = `[${new Date(Number(m.ts)).toISOString().slice(0, 16).replace('T', ' ')}] ${who}: ${String(m.text).replace(/\s+/g, ' ').trim()}\n`
    if (transcript.length + line.length > MAX_TRANSCRIPT_CHARS) { truncated = true; break }
    transcript += line
  }

  const client = new Anthropic() // reads ANTHROPIC_API_KEY
  const stream = client.messages.stream({
    model: 'claude-opus-4-8',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `Analyze these captured WhatsApp chats and produce the report sections.${truncated ? ' (Transcript was truncated to the most recent messages within the size limit.)' : ''}\n\nTRANSCRIPT:\n${transcript}`,
    }],
  })
  const msg = await stream.finalMessage()
  const textBlock = msg.content.find((b) => b.type === 'text')
  if (!textBlock) throw new Error('AI returned no analysis')
  let data
  try { data = JSON.parse(textBlock.text) } catch { throw new Error('AI response was not valid JSON') }

  const note = `<div class="note"><strong>AI analysis.</strong> The sections below were generated by Claude reading the captured chats${truncated ? ' (most recent messages within the size limit)' : ''}. Verify PO numbers, quantities, and quotes against source before acting.</div>`
  return { html: note + renderSections(data), usage: msg.usage }
}

module.exports = { analyze, isConfigured }

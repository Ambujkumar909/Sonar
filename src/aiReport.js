// =============================================================
//  Sonar — AI narrative analysis for the D'Decor "Customer Chat
//  Review" report. Reads the windowed transcripts + a per-group
//  message-count table (from SQL) and returns the QUALITATIVE
//  sections that match the reference report format exactly:
//  verdict, 3-item banner, highlight KPIs, escalations, per-group
//  status/concern, concern-mix, and split recommendations.
//
//  Returns structured data only; src/reportTemplate.js renders it.
//  Requires ANTHROPIC_API_KEY + outbound HTTPS to api.anthropic.com.
// =============================================================
const Anthropic = require('@anthropic-ai/sdk')
const { buildTranscript } = require('./chatExport')

const isConfigured = () => !!process.env.ANTHROPIC_API_KEY

// keep the transcript within a sane budget (~300k chars ≈ ~90k tokens)
const MAX_TRANSCRIPT_CHARS = 300_000

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict_title: { type: 'string', description: 'e.g. "Portfolio Verdict — 06–07 Jul". Short.' },
    verdict: { type: 'string', description: 'ONE dense paragraph (plain text; use **bold** and *italic* for emphasis, verbatim short quotes in "quotes"). The single most important read of the window — dominant themes, named accounts, and the levers to pull.' },
    banner: {
      type: 'array',
      description: 'EXACTLY three at-a-glance boxes, in this order: one bad (open/escalating), one warn (stock/risk), one good (resolved/positive).',
      minItems: 3, maxItems: 3,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          tone: { type: 'string', enum: ['bad', 'warn', 'good'] },
          label: { type: 'string', description: 'Short uppercase-style label, e.g. "Open / escalating".' },
          text: { type: 'string', description: 'One tight sentence with concrete named examples.' },
        },
        required: ['tone', 'label', 'text'],
      },
    },
    kpis: {
      type: 'array',
      description: 'Exactly three HEADLINE KPIs derived from the chats (beyond total groups/messages, which are added separately). e.g. accounts hit by stock, dispatch-chasing accounts, biggest open credit block.',
      minItems: 3, maxItems: 3,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          value: { type: 'string', description: 'Short value, e.g. "7", "6", "₹5.6L".' },
          label: { type: 'string', description: 'Short label, e.g. "Accounts hit by Stock".' },
          tone: { type: 'string', enum: ['', 'red', 'amber', 'green'] },
        },
        required: ['value', 'label', 'tone'],
      },
    },
    escalations: {
      type: 'array',
      description: 'The pressing open/at-risk items, most severe first. Only real ones from the chats.',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          account: { type: 'string', description: 'Account / group name exactly as it appears.' },
          severity_class: { type: 'string', enum: ['Crit', 'High', 'Med', 'Good'] },
          severity_label: { type: 'string', description: 'e.g. "Critical (2nd window)", "High", "Medium (resolved)".' },
          issue: { type: 'string', description: 'What happened, with a short verbatim quote in "quotes" where telling. Use **bold**/*italic* sparingly.' },
        },
        required: ['account', 'severity_class', 'severity_label', 'issue'],
      },
    },
    groups: {
      type: 'array',
      description: 'One row per group that appears in the GROUP ACTIVITY table provided. Use the EXACT group name given. Do not invent groups or message counts (counts are added from data).',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          group: { type: 'string', description: 'Exact group name from the provided activity table.' },
          status_class: { type: 'string', enum: ['p-red', 'p-amber', 'p-green', 'p-grey'] },
          status_label: { type: 'string', description: 'Short status, e.g. "Dispatch chase", "Stock enquiry", "Resolved", "Healthy".' },
          concern: { type: 'string', description: 'One line: the key concern / activity this window, with a short quote if telling.' },
        },
        required: ['group', 'status_class', 'status_label', 'concern'],
      },
    },
    concern_mix: {
      type: 'array',
      description: 'Issue categories ranked by number of ACCOUNTS affected (not message counts), most first.',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          label: { type: 'string', description: 'e.g. "Stock-out / discontinued / short".' },
          count: { type: 'integer', description: 'Accounts affected.' },
        },
        required: ['label', 'count'],
      },
    },
    actions_immediate: { type: 'array', items: { type: 'string' }, description: 'Concrete actions for THIS week, most important first. Use **bold** for the lead phrase.' },
    actions_structural: { type: 'array', items: { type: 'string' }, description: 'Structural fixes (30–90 days). Use **bold** for the lead phrase.' },
  },
  required: ['verdict_title', 'verdict', 'banner', 'kpis', 'escalations', 'groups', 'concern_mix', 'actions_immediate', 'actions_structural'],
}

const SYSTEM = `You are an operations analyst for D'Decor, an Indian furnishings brand. You read captured WhatsApp chats between the D'Decor team and its dealers/customers and produce a crisp management "Customer Chat Review" for leadership.

Rules:
- Base EVERYTHING strictly on the provided messages. NEVER invent accounts, PO/order numbers, quantities, amounts, or quotes. If data is thin, say so plainly rather than padding.
- "team" = the D'Decor side (ME / outgoing / from_me); "dealer/customer" = incoming.
- Quote short, telling phrases VERBATIM (in "quotes") where they sharpen a point. Translate Hindi context to English but keep the quoted flavour.
- Be concise, specific, and business-first. Prefer concrete detail (names, PO numbers, mtr/qty, dates, ₹ amounts as they appear) over generalities.
- Rank by real business impact: wrong material, repeat defects, short/short-supplied quantities, discontinuations, account/credit blocks, and unanswered urgent dispatch requests are high-impact.
- For the per-group rows: use the EXACT group names from the GROUP ACTIVITY table you are given, one row each. Choose a status colour that reflects the window (p-red = open/escalating, p-amber = risk/enquiry/pending, p-green = healthy/resolved, p-grey = quiet/no issue).
- concern_mix counts ACCOUNTS affected per category, not messages.
- Return your analysis via the required structured schema ONLY.`

// stats.groupActivity: [{ name, msgs }] sorted desc (from SQL, authoritative counts)
async function analyze({ ids, days = null, generatedAt = Date.now(), groupActivity = [] } = {}) {
  if (!isConfigured()) throw new Error('ANTHROPIC_API_KEY is not set on the server')

  const { text: transcript, messages, truncated } = await buildTranscript({ ids, days, cap: MAX_TRANSCRIPT_CHARS, generatedAt })
  if (!messages) return { data: null, empty: true }

  const activityTable = groupActivity.length
    ? 'GROUP ACTIVITY (message counts — authoritative, use these exact names):\n' +
      groupActivity.map((g) => `- ${g.name}: ${g.msgs} messages`).join('\n')
    : ''

  const client = new Anthropic() // reads ANTHROPIC_API_KEY
  const stream = client.messages.stream({
    model: 'claude-opus-4-8',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `Analyze these captured WhatsApp chats and produce the Customer Chat Review sections.${truncated ? ' (Transcript was truncated to the most recent messages within the size limit.)' : ''}\n\n${activityTable}\n\nTRANSCRIPT:\n${transcript}`,
    }],
  })
  const msg = await stream.finalMessage()
  const textBlock = msg.content.find((b) => b.type === 'text')
  if (!textBlock) throw new Error('AI returned no analysis')
  let data
  try { data = JSON.parse(textBlock.text) } catch { throw new Error('AI response was not valid JSON') }

  return { data, usage: msg.usage, truncated }
}

module.exports = { analyze, isConfigured }

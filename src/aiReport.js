// =============================================================
//  Sonar — AI analysis for the "Customer Chat Review" (v2).
//  Produces the categorized management report: ESCALATIONS in 4 buckets +
//  OPPORTUNITIES in 5 buckets, banner, headline KPIs, per-group read, and
//  3-column recommendations. Returns structured data; reportTemplate renders it.
//  Requires ANTHROPIC_API_KEY + outbound HTTPS to api.anthropic.com.
// =============================================================
const Anthropic = require('@anthropic-ai/sdk')
const { buildTranscript } = require('./chatExport')

const isConfigured = () => !!process.env.ANTHROPIC_API_KEY
const MAX_TRANSCRIPT_CHARS = 300_000

const ESC_CATS = ['stock', 'dispatch', 'quality', 'other']
const OPP_CATS = ['bulk', 'deal', 'newcollection', 'onboarding', 'convert']

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    banner: {
      type: 'array',
      description: 'EXACTLY three at-a-glance boxes (return 3): one bad (the worst systemic problem this window, e.g. portal/QR outage or dispatch), one warn (stock/discontinuation risk), one good (opportunities to win). Each with a concrete named example.',
      items: {
        type: 'object', additionalProperties: false,
        properties: { tone: { type: 'string', enum: ['bad', 'warn', 'good'] }, label: { type: 'string' }, text: { type: 'string', description: 'One tight sentence with named accounts / short "quotes".' } },
        required: ['tone', 'label', 'text'],
      },
    },
    kpis: {
      type: 'array',
      description: 'EXACTLY three headline KPI counts (return 3), beyond total groups/messages/POs which are added separately. Typically: the dominant problem bucket (tone red), stock-out/discontinued accounts (amber), and opportunities-to-win accounts (green).',
      items: {
        type: 'object', additionalProperties: false,
        properties: { value: { type: 'string', description: 'Short, e.g. "12", "17".' }, label: { type: 'string' }, tone: { type: 'string', enum: ['', 'red', 'amber', 'green', 'purple'] } },
        required: ['value', 'label', 'tone'],
      },
    },
    escalations: {
      type: 'array',
      description: 'Open/at-risk items. Tag each with its category. Quote short telling phrases verbatim.',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          category: { type: 'string', enum: ESC_CATS, description: 'stock=missing/discontinued/no-stock; dispatch=delay/urgent/not-dispatched; quality=defect/wrong/return/same-lot; other=portal/QR/mapping/ledger/rate.' },
          severity: { type: 'string', enum: ['High', 'Med'] },
          account: { type: 'string', description: 'Account/group name exactly as it appears.' },
          issue: { type: 'string', description: 'What happened, with a short verbatim "quote". Use **bold** sparingly for the key fact.' },
        },
        required: ['category', 'severity', 'account', 'issue'],
      },
    },
    escalation_counts: {
      type: 'array',
      description: 'ACCOUNTS AFFECTED per escalation category (one entry per category present). Not row counts.',
      items: { type: 'object', additionalProperties: false, properties: { category: { type: 'string', enum: ESC_CATS }, count: { type: 'integer' } }, required: ['category', 'count'] },
    },
    opportunities: {
      type: 'array',
      description: 'Winnable demand surfacing in chat (sales lever). Inferential — an enquiry is not a booked order. Tag each with its category.',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          category: { type: 'string', enum: OPP_CATS, description: 'bulk=large/project quantities; deal=discount/scheme pending to close; newcollection=new book/assortment/price-list; onboarding=new account/user-id/first PO; convert=available-but-unconfirmed or substitution save.' },
          value: { type: 'string', enum: ['High', 'Med', 'Low'] },
          account: { type: 'string' },
          signal: { type: 'string', description: 'The winnable signal with a short verbatim "quote" and quantities/₹ where present. Use **bold** for the key number/ask.' },
        },
        required: ['category', 'value', 'account', 'signal'],
      },
    },
    opportunity_counts: {
      type: 'array',
      description: 'ACCOUNTS with an opportunity per category (one entry per category present).',
      items: { type: 'object', additionalProperties: false, properties: { category: { type: 'string', enum: OPP_CATS }, count: { type: 'integer' } }, required: ['category', 'count'] },
    },
    groups: {
      type: 'array',
      description: 'One row per group in the GROUP ACTIVITY table provided. Use the EXACT group name. Do not invent groups or counts (counts come from data).',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          group: { type: 'string' },
          status_class: { type: 'string', enum: ['p-red', 'p-amber', 'p-green', 'p-blue', 'p-purple', 'p-grey'], description: 'red=open/blocked, amber=risk/pending, green=opportunity/win/serviced, blue/purple=other, grey=quiet/low.' },
          status_label: { type: 'string', description: 'Short, e.g. "Portal + stock", "Project order", "Discontinued".' },
          concern: { type: 'string', description: 'One line: key concern OR opportunity this window, with a short quote if telling.' },
        },
        required: ['group', 'status_class', 'status_label', 'concern'],
      },
    },
    actions_fix: { type: 'array', items: { type: 'string' }, description: 'Fix/protect immediately (problems). **bold** the lead phrase.' },
    actions_win: { type: 'array', items: { type: 'string' }, description: 'Win now — convert the opportunities to revenue. **bold** the lead phrase.' },
    actions_structural: { type: 'array', items: { type: 'string' }, description: 'Structural fixes (30–90 days). **bold** the lead phrase.' },
  },
  required: ['banner', 'kpis', 'escalations', 'escalation_counts', 'opportunities', 'opportunity_counts', 'groups', 'actions_fix', 'actions_win', 'actions_structural'],
}

const SYSTEM = `You are an operations + sales analyst for the company. You read captured WhatsApp chats between the company's team and its dealers/customers and produce a categorized management "Customer Chat Review" for leadership.

Rules:
- Base EVERYTHING strictly on the provided messages. NEVER invent accounts, PO/order numbers, quantities, amounts, or quotes. If data is thin, return fewer rows rather than padding.
- "team" = company side (ME / outgoing); "dealer/customer" = incoming.
- Quote short, telling phrases VERBATIM (in "quotes"). Translate Hindi to English but keep the quoted flavour.
- TWO parallel structures:
  1) ESCALATIONS — problems, split into 4 categories: stock / dispatch / quality / other (portal-QR-mapping, ledger, rate).
  2) OPPORTUNITIES — winnable demand (the sales lever), split into 5 categories: bulk/project · deal-at-close · new-collection · onboarding · convert-&-save. Opportunities are INFERENTIAL (an enquiry ≠ a booked order) — flag them as signals to convert, never as confirmed sales.
- Counts (escalation_counts, opportunity_counts) are ACCOUNTS AFFECTED per category, not message or row counts.
- For per-group rows: use the EXACT names from the GROUP ACTIVITY table, one row each; pick a status colour reflecting the window.
- Recommendations in 3 buckets: fix/protect now, win now (convert opportunities), structural (30–90 days).
- Return your analysis via the required structured schema ONLY.`

// groupActivity: [{name, msgs}] from SQL (authoritative counts)
async function analyze({ ids, days = null, generatedAt = Date.now(), groupActivity = [] } = {}) {
  if (!isConfigured()) throw new Error('ANTHROPIC_API_KEY is not set on the server')
  const { text: transcript, messages, truncated } = await buildTranscript({ ids, days, cap: MAX_TRANSCRIPT_CHARS, generatedAt })
  if (!messages) return { data: null, empty: true }

  const activityTable = groupActivity.length
    ? 'GROUP ACTIVITY (message counts — authoritative, use these exact names):\n' + groupActivity.map((g) => `- ${g.name}: ${g.msgs} messages`).join('\n')
    : ''

  const client = new Anthropic()
  const stream = client.messages.stream({
    model: 'claude-opus-4-8',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `Analyze these captured WhatsApp chats and produce the categorized Customer Chat Review.${truncated ? ' (Transcript truncated to the most recent messages within the size limit.)' : ''}\n\n${activityTable}\n\nTRANSCRIPT:\n${transcript}`,
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

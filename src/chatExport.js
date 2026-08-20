// =============================================================
//  Sonar — build a plain-text chat transcript for a window/scope.
//  Shared by the "Download chat data" endpoint (offline analysis)
//  and the in-app AI pass. IST timestamps, team/dealer labeled,
//  NO session/mobile name.
// =============================================================
const store = require('./store')

// ---- channel segments (COCO / FOFO / MBO) ----
// Watchlist groups carry the channel in their NAME (e.g. "FOFO-DCA MARKETING,
// CHANDIGARH 10002716"). coco wins if a name somehow contains both; MBO is
// everything else — so the three segments always partition all messages.
const NAME_COL = "COALESCE(NULLIF(chat_name, ''), chat_jid)"
function segmentCond(segment) {
  if (segment === 'coco') return `${NAME_COL} ILIKE '%coco%'`
  if (segment === 'fofo') return `${NAME_COL} ILIKE '%fofo%' AND ${NAME_COL} NOT ILIKE '%coco%'`
  if (segment === 'mbo') return `${NAME_COL} NOT ILIKE '%coco%' AND ${NAME_COL} NOT ILIKE '%fofo%'`
  return null
}

const IST = (ms) => new Date(Number(ms)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
const who = (m) => (m.from_me ? "ME (D'Decor team)" : (m.sender_name || 'dealer'))
const fmt = (m) => `[${IST(m.ts)}] ${who(m)}: ${m.has_media && !m.text ? '[media]' : String(m.text || '').replace(/\r?\n/g, ' ')}`

// ids: undefined = all; [] = none; [..] scoped. days: null = all. cap: max chars (0 = no cap).
// segment: null = all; 'coco'|'fofo'|'mbo' = only that channel's groups.
async function buildTranscript({ ids, days = null, cap = 0, generatedAt = Date.now(), segment = null } = {}) {
  const scoped = Array.isArray(ids)
  if (scoped && ids.length === 0) return { text: '', chats: 0, messages: 0, truncated: false }
  const conds = [], p = []
  const sc = segmentCond(segment)
  if (sc) conds.push(`(${sc})`)
  if (scoped) { p.push(ids); conds.push(`session_id = ANY($${p.length})`) }
  if (days) { p.push(generatedAt - days * 86400000); conds.push(`ts >= $${p.length}`) }
  const where = conds.length ? ' WHERE ' + conds.join(' AND ') : ''
  const rows = (await store.pool.query(
    `SELECT chat_jid, chat_name, is_group, sender_name, from_me, ts, text, has_media
     FROM messages${where} ORDER BY chat_name, ts ASC`, p)).rows
  if (!rows.length) return { text: '', chats: 0, messages: 0, truncated: false }

  const byChat = new Map()
  for (const m of rows) { const k = m.chat_name || m.chat_jid; if (!byChat.has(k)) byChat.set(k, []); byChat.get(k).push(m) }

  let text = '', truncated = false
  for (const [chat, msgs] of byChat) {
    const block = `\n\n### ${chat}  (${msgs[0].is_group ? 'Group' : 'Direct'}) — ${msgs.length} messages\n` + msgs.map(fmt).join('\n') + '\n'
    if (cap && text.length + block.length > cap) { truncated = true; break }
    text += block
  }
  return { text: text.trim(), chats: byChat.size, messages: rows.length, truncated }
}

module.exports = { buildTranscript, segmentCond }

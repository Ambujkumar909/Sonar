#!/usr/bin/env node
// =============================================================
//  Sonar — export captured chats to a folder for OFFLINE analysis
//  (no Claude API). Produces one .txt per chat + a combined file,
//  IST timestamps, team/dealer labeled, NO session/mobile name.
//
//  Run inside the sonar container (has pg + DATABASE_URL):
//    docker exec sonar node scripts/export-chats.js [days] [outBase]
//  Default: last 7 days → /app/logs/exports/<date>_last7d/
//  which lands on the host at ./logs/exports/... (bind mount).
// =============================================================
const fs = require('fs')
const path = require('path')
const store = require('../src/store')
const cfg = require('../src/config')

const DAYS = Number(process.argv[2]) || 7
const OUT_BASE = process.argv[3] || path.join(cfg.LOG_DIR, 'exports')

const IST = (ms) => new Date(Number(ms)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
const safe = (s) => String(s || 'chat').replace(/[^a-z0-9]/gi, '_').slice(0, 80)
const who = (m) => (m.from_me ? "ME (team)" : (m.sender_name || 'dealer'))
const fmt = (m) => `[${IST(m.ts)}] ${who(m)}: ${m.has_media && !m.text ? '[media]' : String(m.text || '').replace(/\r?\n/g, ' ')}`

;(async () => {
  const since = Date.now() - DAYS * 86400000
  const rows = (await store.pool.query(
    `SELECT chat_jid, chat_name, is_group, sender_name, from_me, ts, text, has_media
     FROM messages WHERE ts >= $1 ORDER BY chat_name, ts ASC`, [since])).rows

  const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).slice(0, 10)
  const dir = path.join(OUT_BASE, `${stamp}_last${DAYS}d`)
  fs.mkdirSync(dir, { recursive: true })

  const byChat = new Map()
  for (const m of rows) { const k = m.chat_name || m.chat_jid; if (!byChat.has(k)) byChat.set(k, []); byChat.get(k).push(m) }

  let combined = `WhatsApp chat export\nWindow: last ${DAYS} days (since ${IST(since)})\nChats: ${byChat.size} · Messages: ${rows.length}\n"ME (team)" lines are our side; all others are dealers. No internal account name is included.\n`
  for (const [chat, msgs] of byChat) {
    const header = `### ${chat}  (${msgs[0].is_group ? 'Group' : 'Direct'}) — ${msgs.length} messages\n`
    const body = msgs.map(fmt).join('\n') + '\n'
    fs.writeFileSync(path.join(dir, safe(chat) + '.txt'), header + body)
    combined += `\n\n${header}${body}`
  }
  fs.writeFileSync(path.join(dir, '_ALL_CHATS.txt'), combined)
  fs.writeFileSync(path.join(dir, 'README.txt'),
`WhatsApp chat export — last ${DAYS} days (IST timestamps).
- One .txt per chat, plus _ALL_CHATS.txt (everything in one file).
- "ME (team)" lines are our side; all others are dealers.
- No internal WhatsApp account / device name is included.

Build the report on your laptop with Claude Code (no API cost) — in this folder, ask:

  Read every .txt chat transcript in this folder and produce a single self-contained
  HTML report like the consolidated report, with these sections:
    1. Executive Summary
    2. Critical Escalations (act first)
    3. Service Quality Assessment (unanswered / poorly-handled + notes)
    4. Consolidated Action List (prioritized)
  Team = "ME (team)" lines; everyone else is a dealer. Base everything
  strictly on the messages, quote telling phrases verbatim, and never invent PO
  numbers, quantities, or accounts. Save it as report.html.
`)
  console.log(`Exported ${rows.length} messages / ${byChat.size} chats → ${dir}`)
  await store.pool.end()
  process.exit(0)
})().catch((e) => { console.error('Export failed:', e.message); process.exit(1) })

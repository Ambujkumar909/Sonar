#!/usr/bin/env node
// =============================================================
//  Sonar — WhatsApp activity report (CLI)
//  Writes the report to a file. The portal's Reports page uses the
//  same builder (src/report.js) via GET /api/report.
//
//  Run inside the sonar container (has pg + DATABASE_URL + DB access):
//    docker cp scripts/generate-report.js sonar:/app/scripts/gen.js
//    docker exec sonar node /app/scripts/gen.js /app/logs/whatsapp-report.html
//    # output lands on the host at ./logs/whatsapp-report.html (bind mount)
// =============================================================
const fs = require('fs')
const { generateReport } = require('../src/report')
const store = require('../src/store')

;(async () => {
  const out = process.argv[2] || `whatsapp-report-${new Date().toISOString().slice(0, 10)}.html`
  const { html, stats } = await generateReport({})
  fs.writeFileSync(out, html)
  console.log(`Report written to ${out}  (${stats.messages} msgs, ${stats.chats} chats, ${stats.sessions} sessions)`)
  await store.pool.end()
  process.exit(0)
})().catch((e) => { console.error('Report generation failed:', e.message); process.exit(1) })

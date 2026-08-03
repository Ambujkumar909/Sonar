// =============================================================
//  Sonar — run the daily report ONCE, now (generate + save + email).
//  For manual runs / optional host cron:
//    docker compose exec -T app node scripts/daily-report.js
//  The app's built-in scheduler already runs this daily at REPORT_HOUR.
// =============================================================
const store = require('../src/store')
const scheduler = require('../src/scheduler')

;(async () => {
  await store.init()
  const r = await scheduler.runDaily({ by: 'cli' })
  console.log(`daily report #${r.id}: ${r.stats.messages} msgs, ${r.stats.chats} chats · recipients ${r.recipients}, emailed ${r.emailed}${r.emailError ? ' · email error: ' + r.emailError : ''}${r.smtp ? '' : ' · SMTP not configured'}`)
  process.exit(0)
})().catch((e) => { console.error('daily-report failed:', e?.message || e); process.exit(1) })

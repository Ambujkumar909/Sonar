// =============================================================
//  Sonar — text-file logger
//  Preserves the ORIGINAL automate.js format byte-for-byte:
//    logs/<GroupName>.txt   ->   "DD/MM/YYYY, hh:mm AM  Sender: text\n"
// =============================================================
const fs = require('fs')
const path = require('path')
const { LOG_DIR, LOCALE, TIME_AND_MESSAGE_ONLY } = require('./config')

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })

function safeFileName(name) {
  return name.replace(/[^a-z0-9]/gi, '_') + '.txt'
}

function formatTime(tsSeconds) {
  const d = new Date(Number(tsSeconds) * 1000)
  return d.toLocaleString(LOCALE, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })
}

// Append one line for a group message — identical shape to the old script.
function appendGroupLine({ groupName, sender, text, tsSeconds }) {
  const time = formatTime(tsSeconds)
  const line = TIME_AND_MESSAGE_ONLY
    ? `${time}  ${text}\n`
    : `${time}  ${sender}: ${text}\n`
  const file = path.join(LOG_DIR, safeFileName(groupName))
  fs.appendFile(file, line, () => {})
  return line
}

module.exports = { safeFileName, formatTime, appendGroupLine }

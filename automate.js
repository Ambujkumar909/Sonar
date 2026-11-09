// =============================================================
//  WhatsApp Group Logger (Baileys) - groups "demo" and "demo2"
//  - QR shown manually (new Baileys requirement)
//  - Quiet (Baileys background logs silenced)
//  - Logs incoming messages AND your own messages (labelled ME)
//  - Clean local-time timestamps
//  - Each group writes to its own .txt file in /logs
//  - Auto-reconnects
// =============================================================

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys')

const qrcode = require('qrcode-terminal')
const pino = require('pino')
const fs = require('fs')
const path = require('path')

// ===================== CONFIG =====================

// Groups to log. Add more names here, or leave [] to log ALL groups.
const TARGET_GROUPS = ['demo', 'Demo2','Demo3']

const LOG_DIR = path.join(__dirname, 'logs')
const LOCALE = 'en-IN'               // change to 'en-US', 'en-GB', etc.
const TIME_AND_MESSAGE_ONLY = false  // true = no sender names, just time + message

// ==================================================

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR)

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

function extractText(message) {
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    '[non-text message]'
  )
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth')

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }), // mute Baileys' internal chatter
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

    // Print the QR manually (new Baileys no longer does this automatically)
    if (qr) {
      qrcode.generate(qr, { small: true })
      console.log('Scan the QR above: WhatsApp > Linked Devices > Link a Device')
    }

    if (connection === 'close') {
      const loggedOut =
        lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut
      console.log('Connection closed.', loggedOut ? 'Logged out.' : 'Reconnecting...')
      if (!loggedOut) start()
    } else if (connection === 'open') {
      console.log(
        'Connected. Listening for groups:',
        TARGET_GROUPS.length ? TARGET_GROUPS.join(', ') : 'ALL'
      )
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (!msg.message) continue

      const jid = msg.key.remoteJid
      if (!jid || !jid.endsWith('@g.us')) continue // groups only

      let groupName = ''
      try {
        const meta = await sock.groupMetadata(jid)
        groupName = meta.subject
      } catch (e) {
        continue
      }

      // Only the listed groups (empty list = all groups)
      if (TARGET_GROUPS.length && !TARGET_GROUPS.includes(groupName)) continue

      const text = extractText(msg.message)
      const time = formatTime(msg.messageTimestamp)

      const sender = msg.key.fromMe
        ? 'ME'
        : msg.pushName || msg.key.participant || 'unknown'

      const line = TIME_AND_MESSAGE_ONLY
        ? `${time}  ${text}\n`
        : `${time}  ${sender}: ${text}\n`

      const file = path.join(LOG_DIR, safeFileName(groupName))
      fs.appendFileSync(file, line)

      console.log(`(${groupName}) ${sender}: ${text}`)
    }
  })
}

start().catch((err) => console.error('Fatal error:', err))
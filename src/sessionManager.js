// =============================================================
//  Sonar — multi-session Baileys manager (READ-ONLY)
//  - One Baileys socket per session, each with its own auth dir.
//  - Never sends a message, receipt, or presence. Pure observer.
//  - Self-healing: classified reconnects + watchdog, sub-3-min recovery.
// =============================================================
const QR = require('qrcode')
const pino = require('pino')

const baileys = require('@whiskeysockets/baileys')
const makeWASocket = baileys.default
const { Browsers } = baileys

const cfg = require('./config')
const store = require('./store')
const textlog = require('./textlog')
const { usePostgresAuthState } = require('./waauth')
const { classify, backoff } = require('./reconnect')

const SILENT = pino({ level: 'silent' })

function nowSec() { return Math.floor(Date.now() / 1000) }

function extractType(message) {
  const k = Object.keys(message || {})[0] || 'unknown'
  return k.replace(/Message$/, '')
}

function extractText(message) {
  if (!message) return ''
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.buttonsResponseMessage?.selectedDisplayText ||
    message.listResponseMessage?.title ||
    message.templateButtonReplyMessage?.selectedDisplayText ||
    (message.reactionMessage ? `[reaction ${message.reactionMessage.text}]` : '') ||
    (message.audioMessage ? '[voice/audio]' : '') ||
    (message.stickerMessage ? '[sticker]' : '') ||
    (message.locationMessage ? '[location]' : '') ||
    (message.contactMessage ? '[contact card]' : '') ||
    '[non-text message]'
  )
}

function hasMedia(message) {
  return !!(message?.imageMessage || message?.videoMessage ||
    message?.audioMessage || message?.documentMessage || message?.stickerMessage)
}

class SessionManager {
  /** @param {(event:string, payload:any)=>void} emit */
  constructor(emit) {
    this.emit = emit || (() => {})
    this.sessions = new Map() // id -> session state
    this.licenseHeld = false  // when true: NO session may run (license inactive)
    this.licenseStatus = 'unknown'
    this.startSupervisor()
  }

  // License enforcement: held = stop every session; released = resume them.
  async setLicenseHeld(held, status) {
    this.licenseStatus = status
    this.emit('license', { status })
    if (held === this.licenseHeld) { this.pushSessions(); return }
    this.licenseHeld = held
    if (held) {
      this.log('*', 'warn', 'license', `License ${status} — all sessions stopped`)
      for (const s of this.sessions.values()) {
        s.terminated = true // prevent the socket-close handler from flipping status off 'held'
        clearTimeout(s.reconnectTimer); clearInterval(s.watchdog); s.reconnectTimer = null
        try { s.sock?.end?.(new Error('license-hold')) } catch {}
        s.status = 'held'; store.setSessionStatus(s.id, 'held')
      }
    } else {
      this.log('*', 'success', 'license', 'License active — resuming sessions')
      for (const row of await store.allSessions()) {
        if (row.status === 'stopped') continue
        this.start(row.id).catch(() => {})
      }
    }
    this.pushSessions()
  }

  // Global backstop: independently of every per-session timer, sweep all
  // sessions and revive any that has drifted out of an active state.
  // Guarantees recovery even if an unexpected exception killed the chain.
  startSupervisor() {
    clearInterval(this._supervisor)
    this._supervisor = setInterval(() => {
      if (this.licenseHeld) return // nothing runs while license is inactive
      for (const s of this.sessions.values()) {
        if (s.terminated) continue
        const idle = Date.now() - (s.lastActivity || 0)
        const active = s.status === 'open' || s.status === 'qr'
        const pending = !!s.reconnectTimer
        if (!active && !pending && idle > 60000) {
          this.log(s.id, 'warn', 'supervisor', `Idle in "${s.status}" for ${Math.round(idle / 1000)}s — reviving`)
          this.scheduleStart(s.id, 800)
        }
      }
    }, 25000)
  }

  scheduleStart(id, delay) {
    if (this.licenseHeld) return // license inactive — do not (re)start anything
    const s = this.sessions.get(id)
    if (!s || s.terminated) return
    clearTimeout(s.reconnectTimer)
    s.reconnectTimer = setTimeout(() => {
      const cur = this.sessions.get(id)
      if (cur) cur.reconnectTimer = null
      this.start(id).catch((e) => {
        this.log(id, 'error', 'start-fail', `Start threw: ${e?.message || e} — retrying`)
        this.scheduleStart(id, Math.min(cfg.RECONNECT.maxDelayMs, 5000))
      })
    }, delay)
  }

  // ---- lifecycle --------------------------------------------------------
  async list() {
    const rows = await store.allSessions()
    return rows.map((s) => {
      const live = this.sessions.get(s.id)
      return {
        ...s,
        live: live ? live.status : 'offline',
        hasQr: !!live?.qrDataUrl, // QR itself fetched per-session via getQr (keeps /state small)
        attempt: live?.attempt || 0,
        lastActivity: live?.lastActivity || null,
      }
    })
  }

  // broadcast the session list to dashboards (fire-and-forget)
  pushSessions() { this.list().then((l) => this.emit('sessions', l)).catch(() => {}) }

  // QR for a single session (fetched on demand, never broadcast in bulk)
  getQr(id) { return this.sessions.get(id)?.qrDataUrl || null }

  async createSession(id, name, ownerUserId = null) {
    id = (id || ('s' + Date.now())).replace(/[^a-z0-9_-]/gi, '')
    name = name || id
    await store.upsertSession({ id, name, status: 'starting', watch_all: cfg.DEFAULT_WATCH_ALL_GROUPS ? 1 : 0, created_at: Date.now(), owner_user_id: ownerUserId })
    this.log(id, 'info', 'create', `Session "${name}" created`)
    await this.start(id)
    return id
  }

  async deleteSession(id) {
    const s = this.sessions.get(id)
    if (s) {
      s.terminated = true
      clearTimeout(s.reconnectTimer)
      clearInterval(s.watchdog)
      try { s.sock?.end?.(new Error('deleted')) } catch {}
      this.sessions.delete(id)
    }
    await store.deleteSession(id) // also clears wa_auth, chats, messages, grants
    this.log(id, 'warn', 'delete', 'Session deleted')
    this.pushSessions()
  }

  // User-initiated stop. The ONLY way auto-reconnect is disabled.
  // Credentials are PRESERVED on disk — resume reconnects with no re-scan.
  stopSession(id) {
    let s = this.sessions.get(id)
    if (!s) {
      s = { id, groupCache: new Map() }
      this.sessions.set(id, s)
    }
    s.terminated = true
    s.userStopped = true
    clearTimeout(s.reconnectTimer)
    clearInterval(s.watchdog)
    s.reconnectTimer = null
    try { s.sock?.end?.(new Error('user-stop')) } catch {}
    this.log(id, 'warn', 'stop', 'Stopped by user — auto-reconnect disabled (creds kept)')
    this.setStatus(id, 'stopped')
  }

  // Resume a stopped session — uses the creds already on disk.
  resumeSession(id) {
    const s = this.sessions.get(id)
    if (s) { s.terminated = false; s.userStopped = false; s.attempt = 0 }
    this.log(id, 'info', 'resume', 'Resumed by user')
    this.start(id).catch(() => this.scheduleStart(id, 3000))
  }

  async logout(id) {
    // wipe creds so next start shows a fresh QR (does NOT send a logout to WA)
    await store.waClear(id)
    this.log(id, 'warn', 'reauth', 'Credentials cleared — restart to re-pair')
    store.setSessionStatus(id, 'idle')
  }

  // ---- the connection itself -------------------------------------------
  async start(id) {
    let s = this.sessions.get(id)
    if (!s) {
      s = { id, status: 'starting', attempt: 0, lastActivity: Date.now(), groupCache: new Map() }
      this.sessions.set(id, s)
    }
    s.terminated = false
    clearTimeout(s.reconnectTimer)
    s.reconnectTimer = null
    s.lastActivity = Date.now()

    if (this.licenseHeld) { this.setStatus(id, 'held'); return } // gated by license

    try {
      const { state, saveCreds } = await usePostgresAuthState(id) // creds/keys in Postgres
      s.saveCreds = saveCreds

      const sock = makeWASocket({
        auth: state,
        logger: SILENT,
        browser: Browsers ? Browsers.appropriate('Desktop') : ['Sonar', 'Chrome', '121.0'],
        markOnlineOnConnect: cfg.MARK_ONLINE,     // stay invisible
        syncFullHistory: cfg.SYNC_FULL_HISTORY,
        getMessage: async () => undefined,        // read-only: nothing to resend
      })
      s.sock = sock
      this.setStatus(id, 'connecting')

      sock.ev.on('creds.update', saveCreds)
      sock.ev.on('connection.update', (u) => this.onConnection(id, u))
      sock.ev.on('messages.upsert', (u) => this.onMessages(id, u))
      sock.ev.on('messaging-history.set', (u) => this.onHistory(id, u))
      sock.ev.on('contacts.upsert', (cs) => this.onContacts(id, cs))
      sock.ev.on('contacts.update', (cs) => this.onContacts(id, cs))
      sock.ev.on('groups.upsert', (gs) => this.onGroups(id, gs))
      sock.ev.on('groups.update', (gs) => this.onGroups(id, gs))
      sock.ev.on('chats.upsert', (cs) => this.onChats(id, cs))

      this.armWatchdog(id)
    } catch (e) {
      // Never let a startup exception kill the session — reschedule.
      this.log(id, 'error', 'start-exc', `Startup error: ${e?.message || e} — retrying`)
      this.setStatus(id, 'reconnecting')
      this.scheduleStart(id, 4000)
    }
  }

  async onConnection(id, update) {
    const s = this.sessions.get(id)
    if (!s) return
    // ignore late/async events for a stopped or license-held session
    // (e.g. a trailing QR from a socket we just ended would flip status off 'held')
    if (s.terminated || this.licenseHeld) return
    const { connection, lastDisconnect, qr } = update
    s.lastActivity = Date.now()

    if (qr) {
      s.qrDataUrl = await QR.toDataURL(qr, { margin: 1, width: 320 })
      this.setStatus(id, 'qr')
      this.log(id, 'info', 'qr', 'New QR ready — scan via WhatsApp ▸ Linked Devices')
      this.emit('qr', { id, qr: s.qrDataUrl })
    }

    if (connection === 'open') {
      s.attempt = 0
      s.qrDataUrl = null
      const me = s.sock?.user
      store.touchOpen(id)
      store.setSessionMeta({
        id,
        phone: me?.id?.split(':')[0] || null,
        platform: me?.platform || null,
        pushname: me?.name || me?.notify || null,
      })
      this.setStatus(id, 'open')
      this.log(id, 'success', 'open', `Connected${me?.name ? ' as ' + me.name : ''}`)
    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
        ?? lastDisconnect?.error?.output?.payload?.statusCode
      store.touchClose(id)
      await this.handleClose(id, code)
    } else if (connection === 'connecting') {
      this.setStatus(id, 'connecting')
    }
  }

  async handleClose(id, code) {
    const s = this.sessions.get(id)
    if (!s || s.terminated) return
    const decision = classify(code)
    this.log(id, decision.action === 'reconnect' ? 'warn' : 'error', String(decision.code), decision.reason)

    if (decision.action === 'reauth') {
      await this.logout(id)
      this.setStatus(id, 'reauth')
      s.attempt = 0
      this.scheduleStart(id, 1500) // immediately come back up and surface a fresh QR
      return
    }

    // reconnect — forever, with capped backoff (recovery always < 3 min)
    s.attempt = (s.attempt || 0) + 1
    const overSoft = s.attempt > cfg.RECONNECT.softFailLimit
    const delay = overSoft
      ? cfg.RECONNECT.cooldownMs
      : backoff(s.attempt, cfg.RECONNECT, decision.minDelay || 0)
    this.setStatus(id, 'reconnecting')
    this.log(id, 'info', 'retry', `Reconnect attempt #${s.attempt} in ${(delay / 1000).toFixed(1)}s`)
    this.scheduleStart(id, delay)
  }

  // ---- watchdog: guarantees we never get silently stuck ----------------
  armWatchdog(id) {
    const s = this.sessions.get(id)
    if (!s) return
    clearInterval(s.watchdog)
    s.watchdog = setInterval(() => {
      const cur = this.sessions.get(id)
      if (!cur || cur.terminated) return
      const idle = Date.now() - (cur.lastActivity || 0)
      const ws = cur.sock?.ws
      const wsState = ws?.readyState // 0 connecting 1 open 2 closing 3 closed

      // stuck "connecting" too long -> force a clean restart
      if ((cur.status === 'connecting' || cur.status === 'reconnecting') &&
          idle > cfg.RECONNECT.connectingTimeoutMs) {
        this.log(id, 'warn', 'watchdog', 'Stuck connecting — forcing restart')
        this.forceRestart(id)
        return
      }
      // socket says open but underlying ws is dead -> restart
      if (cur.status === 'open' && wsState !== undefined && wsState !== 1) {
        this.log(id, 'warn', 'watchdog', `Dead socket (ws=${wsState}) — restarting`)
        this.forceRestart(id)
        return
      }
    }, cfg.RECONNECT.watchdogMs)
  }

  forceRestart(id) {
    const s = this.sessions.get(id)
    if (!s) return
    try { s.sock?.end?.(new Error('watchdog-restart')) } catch {}
    s.attempt = Math.max(1, s.attempt)
    this.scheduleStart(id, 800)
  }

  // ---- data handlers ----------------------------------------------------
  async resolveGroupName(id, jid) {
    const s = this.sessions.get(id)
    if (s?.groupCache.has(jid)) return s.groupCache.get(jid)
    try {
      const meta = await s.sock.groupMetadata(jid)
      s.groupCache.set(jid, meta.subject)
      store.upsertGroup({
        session_id: id, jid, subject: meta.subject,
        description: meta.desc || '', owner: meta.owner || '',
        participants: meta.participants?.length || 0,
        created_at: (meta.creation || 0) * 1000,
      })
      return meta.subject
    } catch {
      return jid.split('@')[0]
    }
  }

  async onMessages(id, { messages, type }) {
    if (type !== 'notify') return
    const s = this.sessions.get(id)
    if (!s) return
    s.lastActivity = Date.now()
    const sess = await store.getSession(id)
    const watchAll = sess ? !!sess.watch_all : true
    const watch = await store.listWatch(id)
    const groupWatch = watch.filter((w) => w.kind === 'group').map((w) => w.value)
    const numberWatch = watch.filter((w) => w.kind === 'number').map((w) => w.value.replace(/\D/g, ''))
    const keywords = (await store.listKeywords()).map((k) => k.word.toLowerCase())

    for (const msg of messages) {
      if (!msg.message) continue
      const jid = msg.key.remoteJid
      if (!jid) continue
      const isGroup = jid.endsWith('@g.us')
      const isStatus = jid === 'status@broadcast'
      if (isStatus) continue

      let chatName, watchKey, storeJid, fileBase
      if (isGroup) {
        chatName = await this.resolveGroupName(id, jid)
        // STRICT listen-only: unless Watch-all is on, the group MUST be listed.
        if (!watchAll && !groupWatch.includes(chatName)) continue
        watchKey = 'g:' + chatName
        storeJid = jid
        fileBase = chatName
      } else {
        // Direct chat — captures BOTH directions (their messages AND yours).
        // WhatsApp may deliver the chat as a privacy id (@lid) instead of the
        // phone, and outgoing messages often carry only the @lid, so we gather
        // every candidate AND learn @lid<->phone so both directions match.
        const cand = []
        const addNum = (v) => {
          if (!v) return
          const d = String(v).split('@')[0].split(':')[0].replace(/\D/g, '')
          if (d.length >= 6 && !cand.includes(d)) cand.push(d)
        }
        addNum(jid)
        addNum(msg.key.remoteJidAlt)
        addNum(msg.key.senderPn)
        addNum(msg.key.participantPn)
        addNum(msg.key.participant)
        // learn @lid -> phone whenever a message carries both forms
        const lidKey = String(jid).endsWith('@lid') ? String(jid).split('@')[0] : null
        const phoneCand = cand.find((c) => c.length >= 8)
        if (lidKey && phoneCand) await store.setLid(id, lidKey, phoneCand)
        if (lidKey) { const mapped = await store.getLid(id, lidKey); if (mapped) addNum(mapped) }
        const phone = cand.find((c) => c.length >= 8) || cand[0] || String(jid).split('@')[0]
        let matchedW = null
        if (!watchAll) {
          matchedW = numberWatch.find((w) => w && cand.some((c) =>
            c === w || (w.length >= 8 && c.endsWith(w)) || (c.length >= 8 && w.endsWith(c))))
          // Privacy: a message from a non-watchlisted number is silently ignored —
          // never logged to Health (we don't reveal who messaged whom).
          if (!matchedW) continue
        }
        // Label by the watchlist number so incoming + outgoing share ONE chat/file.
        const label = matchedW || phone
        storeJid = label + '@s.whatsapp.net'
        chatName = label
        watchKey = 'n:' + label
        fileBase = label // file is "<number>.txt" (groups keep their subject name)
      }

      const text = extractText(msg.message)
      const type2 = extractType(msg.message)
      const tsSec = Number(msg.messageTimestamp) || nowSec()
      const sender = msg.key.fromMe ? 'ME' : (msg.pushName || msg.key.participant?.split('@')[0] || chatName || 'unknown')
      const quoted = extractText(msg.message?.extendedTextMessage?.contextInfo?.quotedMessage)

      // persist to DB
      const row = {
        msg_id: msg.key.id, session_id: id, chat_jid: storeJid, chat_name: chatName,
        is_group: isGroup ? 1 : 0, sender_jid: msg.key.participant || jid,
        sender_name: sender, from_me: msg.key.fromMe ? 1 : 0, type: type2,
        text, has_media: hasMedia(msg.message) ? 1 : 0,
        quoted_text: quoted === '[non-text message]' ? '' : quoted,
        ts: tsSec * 1000, created_at: Date.now(),
      }
      try { await store.insertMsg(row) } catch {}
      await store.upsertChat({
        session_id: id, jid: storeJid, name: chatName, is_group: isGroup ? 1 : 0,
        last_ts: tsSec * 1000, last_text: text, last_sender: sender, watch_key: watchKey,
      })

      // .txt is the PERMANENT full archive (groups AND direct chats). fileBase
      // is stable per conversation (group name, or direct_<phone>) so a contact
      // always lands in ONE file regardless of message direction.
      textlog.appendGroupLine({ groupName: fileBase, sender, text, tsSeconds: tsSec })

      // keyword alert — live toast only; message content is NOT written to the
      // Health/audit log (privacy: Health stays operational-events only).
      const hit = keywords.find((k) => k && text.toLowerCase().includes(k))
      if (hit) this.emit('alert', { id, keyword: hit, chatName, sender, text, ts: row.ts })

      // live push to dashboard
      this.emit('message', { sessionId: id, ...row })
    }
  }

  onHistory(id, { chats = [], contacts = [], messages = [] }) {
    const s = this.sessions.get(id)
    if (s) s.lastActivity = Date.now()
    // STRICT listen-only: do NOT import the phone's whole chat list.
    // Only contacts are kept (used to resolve names of watchlisted chats).
    for (const ct of contacts) {
      store.upsertContact({
        session_id: id, jid: ct.id, name: ct.name || ct.notify || '',
        notify: ct.notify || '', is_business: ct.isBusiness ? 1 : 0,
      })
    }
  }

  onContacts(id, contacts) {
    for (const ct of contacts || []) {
      if (!ct.id) continue
      store.upsertContact({
        session_id: id, jid: ct.id, name: ct.name || ct.verifiedName || '',
        notify: ct.notify || '', is_business: ct.isBusiness ? 1 : 0,
      })
    }
  }

  async onGroups(id, groups) {
    const s = this.sessions.get(id)
    for (const g of groups || []) {
      if (!g.id) continue
      if (g.subject && s) s.groupCache.set(g.id, g.subject)
      store.upsertGroup({
        session_id: id, jid: g.id, subject: g.subject || '',
        description: g.desc || '', owner: g.owner || '',
        participants: g.participants?.length || g.size || 0,
        created_at: (g.creation || 0) * 1000,
      })
    }
    this.emit('groups', { id })
  }

  onChats(id) {
    // STRICT listen-only: ignore the phone's chat list. Chats are created only
    // when a watchlisted message is actually captured (see onMessages).
    const s = this.sessions.get(id)
    if (s) s.lastActivity = Date.now()
  }

  // ---- helpers ----------------------------------------------------------
  setStatus(id, status) {
    const s = this.sessions.get(id)
    if (s) s.status = status
    store.setSessionStatus(id, status)
    this.emit('status', { id, status })
    this.pushSessions()
  }

  log(id, level, code, message) {
    store.logEvent(id, level, code, message)
    this.emit('event', { sessionId: id, level, code, message, ts: Date.now() })
  }

  // restore all known sessions on server boot
  async restoreAll() {
    for (const row of await store.allSessions()) {
      // Respect a user-stopped session across restarts — keep it stopped.
      if (row.status === 'stopped') {
        this.sessions.set(row.id, {
          id: row.id, status: 'stopped', terminated: true, userStopped: true,
          attempt: 0, groupCache: new Map(), lastActivity: Date.now(),
        })
        this.log(row.id, 'info', 'boot', 'Session is user-stopped — leaving offline')
        continue
      }
      if (await store.waHasCreds(row.id)) {
        this.log(row.id, 'info', 'boot', 'Restoring session on startup (creds in Postgres)')
        this.start(row.id).catch(() => this.scheduleStart(row.id, 3000))
      } else {
        store.setSessionStatus(row.id, 'idle')
      }
    }
  }
}

module.exports = SessionManager
